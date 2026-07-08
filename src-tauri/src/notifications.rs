use std::sync::atomic::{AtomicBool, Ordering};

static PERMISSION_GRANTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn send_notification(title: String, body: String) -> Result<(), String> {
    if !PERMISSION_GRANTED.load(Ordering::Relaxed) {
        return Err("Notification permission not granted".into());
    }
    platform_send(&title, &body).map_err(|e| e.to_string())
}

/// Fire a native notification from Rust (no webview involved). Best-effort:
/// logs and returns if permission isn't granted or delivery fails. Used by the
/// startup updater so a broken frontend can't suppress the "update ready" nudge.
pub fn notify(title: &str, body: &str) {
    if !PERMISSION_GRANTED.load(Ordering::Relaxed) {
        eprintln!("[Structs] notify skipped (no permission): {title} — {body}");
        return;
    }
    if let Err(e) = platform_send(title, body) {
        eprintln!("[Structs] notify failed: {e}");
    }
}

pub fn request_permission() {
    platform_request_permission();
}

// ── macOS: UNUserNotificationCenter ──

#[cfg(target_os = "macos")]
fn is_bundled() -> bool {
    use objc2_foundation::NSBundle;
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some()
}

#[cfg(target_os = "macos")]
fn platform_request_permission() {
    if !is_bundled() {
        eprintln!("[Structs] Not running as .app bundle — notifications disabled in dev mode");
        return;
    }

    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};

    let center = UNUserNotificationCenter::currentNotificationCenter();

    // Install delegate for foreground notification delivery
    install_delegate();

    let options = UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound
        | UNAuthorizationOptions::Badge;

    let handler = block2::RcBlock::new(|granted: Bool, error: *mut NSError| {
        let granted = granted.as_bool();
        if !error.is_null() {
            let err = unsafe { &*error };
            eprintln!(
                "[Structs] Notification permission error: {}",
                err.localizedDescription()
            );
        }
        eprintln!("[Structs] Notification permission granted: {}", granted);
        PERMISSION_GRANTED.store(granted, Ordering::Relaxed);
    });

    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
}

/// Install a delegate on UNUserNotificationCenter using raw ObjC FFI.
/// This tells macOS to show banner + sound even when the app is in the foreground.
#[cfg(target_os = "macos")]
fn install_delegate() {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::sel;

    unsafe {
        // Create delegate class using raw FFI to avoid lifetime/type issues
        let superclass = objc2::ffi::objc_getClass(c"NSObject".as_ptr());
        let cls = objc2::ffi::objc_allocateClassPair(superclass as _, c"StructsNotificationDelegate".as_ptr(), 0);
        if cls.is_null() {
            // Class already exists (hot reload), get existing
            let cls = objc2::ffi::objc_getClass(c"StructsNotificationDelegate".as_ptr());
            if cls.is_null() {
                eprintln!("[Structs] Failed to create notification delegate class");
                return;
            }
            set_delegate(cls as _);
            return;
        }

        // willPresentNotification:withCompletionHandler:
        unsafe extern "C" fn will_present(
            _this: *mut std::ffi::c_void,
            _cmd: *mut std::ffi::c_void,
            _center: *mut std::ffi::c_void,
            _notification: *mut std::ffi::c_void,
            handler: *const block2::Block<dyn Fn(usize)>,
        ) {
            // Banner (1<<4=16) + Sound (1<<1=2) + List (1<<3=8)
            (*handler).call((16 | 2 | 8,));
        }

        let sel = sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:);
        let imp: objc2::runtime::Imp = std::mem::transmute(will_present as *const ());
        objc2::ffi::class_addMethod(
            cls as *mut AnyClass,
            sel,
            imp,
            c"v@:@@@?".as_ptr(),
        );

        objc2::ffi::objc_registerClassPair(cls);
        set_delegate(cls as _);
    }

    unsafe fn set_delegate(cls: *const std::ffi::c_void) {
        let delegate: *mut AnyObject = objc2::msg_send![cls as *const AnyClass, new];
        let center_cls = AnyClass::get(c"UNUserNotificationCenter").unwrap();
        let center: *mut AnyObject = objc2::msg_send![center_cls, currentNotificationCenter];
        let _: () = objc2::msg_send![center, setDelegate: delegate];
        eprintln!("[Structs] Notification delegate installed (foreground delivery enabled)");
    }
}

#[cfg(target_os = "macos")]
fn platform_send(title: &str, body: &str) -> Result<(), Box<dyn std::error::Error>> {
    use objc2_foundation::{NSError, NSString, NSUUID};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound,
        UNUserNotificationCenter,
    };

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));

    let identifier = NSUUID::UUID().UUIDString().to_string();
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&identifier),
        &content,
        None,
    );

    let center = UNUserNotificationCenter::currentNotificationCenter();

    let handler = block2::RcBlock::new(|error: *mut NSError| {
        if !error.is_null() {
            let err = unsafe { &*error };
            eprintln!(
                "[Structs] Failed to deliver notification: {}",
                err.localizedDescription()
            );
        } else {
            eprintln!("[Structs] Notification delivered successfully");
        }
    });

    center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));

    Ok(())
}

// ── Windows / Linux: notify-rust ──

#[cfg(not(target_os = "macos"))]
fn platform_request_permission() {
    PERMISSION_GRANTED.store(true, Ordering::Relaxed);
}

#[cfg(not(target_os = "macos"))]
fn platform_send(title: &str, body: &str) -> Result<(), Box<dyn std::error::Error>> {
    notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .show()?;
    Ok(())
}
