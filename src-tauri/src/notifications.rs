use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

static PERMISSION_GRANTED: AtomicBool = AtomicBool::new(false);

/// Whether macOS actually authorised us. A reading the Notifications section
/// shows, because "I turned it on and nothing arrives" is otherwise unanswerable
/// from inside the app.
pub fn permission_granted() -> bool {
    PERMISSION_GRANTED.load(Ordering::Relaxed)
}

// ── Channels ────────────────────────────────────────────────────────────────

/// Every notification this app can raise: `(key, label, group)`.
///
/// For grass-borne events the key IS the event category the webapp tap reads
/// off the wire, so the tap can pass it straight through without a second
/// mapping table to keep in step. Rust-side alerts (combat assessment, comms,
/// watchdog, updater) get their own keys in the same namespace.
///
/// Order here is the order the section renders in, groups included.
pub const CHANNELS: &[(&str, &str, &str)] = &[
    // Combat — the ones worth interrupting a player for.
    ("raid_status", "Raid status", "Combat"),
    ("struct_attack", "Structs under fire", "Combat"),
    ("fleet_arrive", "Fleet arrivals", "Combat"),
    ("fleet_depart", "Fleet departures", "Combat"),
    ("combat_alert", "Threat assessment", "Combat"),
    ("team_threat", "Team threats", "Combat"),
    // Ledger — Alpha moving in or out of the wallet.
    ("sent", "Alpha sent", "Ledger"),
    ("received", "Alpha received", "Ledger"),
    // Industry — the chattiest group; one line per struct per cycle.
    ("struct_block_build_start", "Build started", "Industry"),
    ("struct_block_ore_mine_start", "Mining started", "Industry"),
    ("struct_block_ore_refine_start", "Refining started", "Industry"),
    ("struct_status", "Struct status changes", "Industry"),
    // Power.
    ("load", "Power overload", "Power"),
    ("capacity", "Capacity changes", "Power"),
    // Comms — Matrix chat.
    ("comms_dm", "Direct messages", "Comms"),
    ("comms_mention", "Mentions", "Comms"),
    // The app talking about itself.
    ("watchdog", "Watchdog escalations", "System"),
    ("update", "App updates", "System"),
];

fn known(key: &str) -> bool {
    CHANNELS.iter().any(|(k, _, _)| *k == key)
}

// ── Config ──────────────────────────────────────────────────────────────────

const FILE: &str = "notifications.json";

fn yes() -> bool {
    true
}

/// `channels` records only the channels that have been TOUCHED. An absent key
/// means "on", which is what every channel was before this setting existed —
/// so a build that adds a channel never silently mutes it, and neither does an
/// older config file.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NotifyConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub channels: BTreeMap<String, bool>,
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            channels: BTreeMap::new(),
        }
    }
}

static CONFIG: LazyLock<RwLock<NotifyConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILE)));

pub fn get() -> NotifyConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

/// Is this channel allowed to interrupt the player right now?
///
/// Fails OPEN on an unknown key and on a poisoned lock: a notification the
/// player never asked to silence is noise, but one they DID ask for and never
/// receive is a bug they cannot see.
pub fn is_on(channel: &str) -> bool {
    match CONFIG.read() {
        Ok(c) => c.enabled && *c.channels.get(channel).unwrap_or(&true),
        Err(_) => true,
    }
}

fn save(cfg: &NotifyConfig) {
    crate::mcp::config_store::save_config(FILE, cfg);
}

pub fn set_enabled(on: bool) {
    let mut c = match CONFIG.write() {
        Ok(c) => c,
        Err(_) => return,
    };
    c.enabled = on;
    save(&c);
}

/// Rejects an unknown key rather than storing it. A typo that persists would
/// read back as a setting the player made and never take effect.
pub fn set_channel(key: &str, on: bool) -> Result<(), String> {
    if !known(key) {
        return Err(format!("unknown notification channel '{key}'"));
    }
    let mut c = match CONFIG.write() {
        Ok(c) => c,
        Err(_) => return Err("notification config unavailable".into()),
    };
    c.channels.insert(key.to_string(), on);
    save(&c);
    Ok(())
}

/// Set every channel in one group at once. Returns how many were written.
pub fn set_group(group: &str, on: bool) -> usize {
    let keys: Vec<&str> = CHANNELS
        .iter()
        .filter(|(_, _, g)| *g == group)
        .map(|(k, _, _)| *k)
        .collect();
    if keys.is_empty() {
        return 0;
    }
    let mut c = match CONFIG.write() {
        Ok(c) => c,
        Err(_) => return 0,
    };
    for k in &keys {
        c.channels.insert((*k).to_string(), on);
    }
    save(&c);
    keys.len()
}

/// The shape the Notifications section renders from.
pub fn config_json() -> serde_json::Value {
    let c = get();
    let channels: Vec<serde_json::Value> = CHANNELS
        .iter()
        .map(|(k, label, group)| {
            json!({
                "key": k,
                "label": label,
                "group": group,
                "enabled": *c.channels.get(*k).unwrap_or(&true),
            })
        })
        .collect();
    json!({
        "enabled": c.enabled,
        "permission": permission_granted(),
        "channels": channels,
    })
}

// ── Delivery ────────────────────────────────────────────────────────────────

/// `channel` is optional so the command stays callable from anything that has
/// no channel to declare; without one only the master switch applies.
#[tauri::command]
pub async fn send_notification(
    title: String,
    body: String,
    channel: Option<String>,
) -> Result<(), String> {
    match channel.as_deref() {
        Some(ch) if !is_on(ch) => return Ok(()),
        None if !get().enabled => return Ok(()),
        _ => {}
    }
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

/// `notify`, gated on one channel. Every Rust-side alert goes through this so
/// the section's switches are the whole truth about what can interrupt.
pub fn notify_on(channel: &str, title: &str, body: &str) {
    if !is_on(channel) {
        return;
    }
    notify(title, body);
}

pub fn request_permission() {
    platform_request_permission();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_channel_key_is_unique() {
        let mut seen = std::collections::HashSet::new();
        for (k, _, _) in CHANNELS {
            assert!(seen.insert(*k), "duplicate notification channel key '{k}'");
        }
    }

    #[test]
    fn unknown_channel_is_rejected_not_stored() {
        assert!(set_channel("no_such_channel", false).is_err());
    }

    /// An untouched channel is ON. This is what stops a new CHANNELS entry (or
    /// an older config file on disk) from arriving silently muted.
    #[test]
    fn absent_channel_defaults_on() {
        let c = NotifyConfig::default();
        assert!(*c.channels.get("raid_status").unwrap_or(&true));
    }
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
