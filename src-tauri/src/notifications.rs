use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, OnceLock, RwLock};

/// The app, for the one thing a notification does after it is delivered:
/// open the Map Viewer when it is clicked. Set once from `main.rs` setup;
/// the macOS delegate is a bare C callback with no context of its own.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
pub fn bind_app(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// Where a click on an alert goes: a planet (`2-…`) or a fleet (`9-…`) the
/// Map Viewer can open on. Carried in the notification's `userInfo` on
/// macOS; the other platforms' toasts have no click path, so there it is
/// simply not sent. Anything that is not a map target is dropped here rather
/// than at click time, so a bad id never becomes a dead click.
pub fn map_target(target: Option<&str>) -> Option<String> {
    let t = target?.trim();
    let (planet, fleet) = if t.starts_with("2-") { (Some(t), None) } else { (None, Some(t)) };
    crate::mcp::raid_view::parse_target(planet, fleet).ok().map(|_| t.to_string())
}

/// The map target for an alert about the PRIMARY player: the fleet while
/// it is away (the fight is wherever the fleet is), the home planet
/// otherwise. `None` when the player has neither yet.
pub fn primary_target(planet_id: Option<&str>, fleet_id: Option<&str>, fleet_status: Option<&str>) -> Option<String> {
    let away = fleet_status.map(|s| s.eq_ignore_ascii_case("away")).unwrap_or(false);
    if away {
        if let Some(f) = map_target(fleet_id) {
            return Some(f);
        }
    }
    map_target(planet_id).or_else(|| map_target(fleet_id))
}

/// A clicked alert: open (or focus) the Map Viewer on its target. Runs the
/// window work on the main thread — the delegate callback and the
/// WebviewWindowBuilder both insist on it on macOS.
pub fn open_target(target: &str) {
    let Some(app) = APP.get().cloned() else {
        eprintln!("[Structs] notification click before the app was bound: {target}");
        return;
    };
    let Some(t) = map_target(Some(target)) else { return };
    let (planet, fleet) = if t.starts_with("2-") { (Some(t.clone()), None) } else { (None, Some(t.clone())) };
    let Ok(target) = crate::mcp::raid_view::parse_target(planet.as_deref(), fleet.as_deref()) else { return };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = crate::mcp::raid_view::open_window(&app2, &target) {
            eprintln!("[Structs] notification click could not open the map: {e}");
        }
    });
}

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
/// `target` — a planet or fleet id — makes the alert clickable: the Map
/// Viewer opens on it (macOS). Optional, so callers with nothing to open
/// keep sending as before.
#[tauri::command]
pub async fn send_notification(
    title: String,
    body: String,
    channel: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    match channel.as_deref() {
        Some(ch) if !is_on(ch) => return Ok(()),
        None if !get().enabled => return Ok(()),
        _ => {}
    }
    if !PERMISSION_GRANTED.load(Ordering::Relaxed) {
        return Err("Notification permission not granted".into());
    }
    platform_send(&title, &body, map_target(target.as_deref()).as_deref()).map_err(|e| e.to_string())
}

/// Fire a native notification from Rust (no webview involved). Best-effort:
/// logs and returns if permission isn't granted or delivery fails. Used by the
/// startup updater so a broken frontend can't suppress the "update ready" nudge.
pub fn notify(title: &str, body: &str) {
    notify_target(title, body, None);
}

/// `notify` with a place to open when the alert is clicked.
pub fn notify_target(title: &str, body: &str, target: Option<&str>) {
    if !PERMISSION_GRANTED.load(Ordering::Relaxed) {
        eprintln!("[Structs] notify skipped (no permission): {title} — {body}");
        return;
    }
    if let Err(e) = platform_send(title, body, map_target(target).as_deref()) {
        eprintln!("[Structs] notify failed: {e}");
    }
}

/// `notify`, gated on one channel. Every Rust-side alert goes through this so
/// the section's switches are the whole truth about what can interrupt.
pub fn notify_on(channel: &str, title: &str, body: &str) {
    notify_on_target(channel, title, body, None);
}

/// `notify_on` for an alert about a place: clicking it opens the Map Viewer
/// there (the raided planet, the fleet under fire).
pub fn notify_on_target(channel: &str, title: &str, body: &str, target: Option<&str>) {
    if !is_on(channel) {
        return;
    }
    notify_target(title, body, target);
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

    #[test]
    fn only_map_targets_survive() {
        assert_eq!(map_target(Some("2-33978")).as_deref(), Some("2-33978"));
        assert_eq!(map_target(Some(" 9-271 ")).as_deref(), Some("9-271"));
        assert_eq!(map_target(Some("5-2428")), None);      // a struct is not a place
        assert_eq!(map_target(Some("1-194")), None);
        assert_eq!(map_target(Some("")), None);
        assert_eq!(map_target(None), None);
    }

    #[test]
    fn primary_alert_opens_the_fleet_only_while_it_is_away() {
        assert_eq!(primary_target(Some("2-223"), Some("9-194"), Some("onStation")).as_deref(), Some("2-223"));
        assert_eq!(primary_target(Some("2-223"), Some("9-194"), Some("away")).as_deref(), Some("9-194"));
        assert_eq!(primary_target(Some("2-223"), Some("9-194"), None).as_deref(), Some("2-223"));
        assert_eq!(primary_target(None, Some("9-194"), None).as_deref(), Some("9-194"));
        assert_eq!(primary_target(None, None, None), None);
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

        // userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:
        // — the player clicked (or acted on) a delivered alert. The alert's
        // `userInfo.target` says where the Map Viewer should open; an alert
        // without one (an update nudge, a watchdog line) opens nothing.
        // Dismissing is an action too, and must not open anything.
        unsafe extern "C" fn did_receive(
            _this: *mut std::ffi::c_void,
            _cmd: *mut std::ffi::c_void,
            _center: *mut std::ffi::c_void,
            response: *mut std::ffi::c_void,
            handler: *const block2::Block<dyn Fn()>,
        ) {
            if let Some(target) = clicked_target(response) {
                open_target(&target);
            }
            (*handler).call(());
        }

        let sel2 = sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:);
        let imp2: objc2::runtime::Imp = std::mem::transmute(did_receive as *const ());
        objc2::ffi::class_addMethod(
            cls as *mut AnyClass,
            sel2,
            imp2,
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

/// The map target a clicked notification carries, if the click was the
/// default action (the banner itself) and the alert had one.
#[cfg(target_os = "macos")]
unsafe fn clicked_target(response: *mut std::ffi::c_void) -> Option<String> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSString};
    use objc2_user_notifications::UNNotificationResponse;
    if response.is_null() {
        return None;
    }
    let response: &UNNotificationResponse = &*(response as *const UNNotificationResponse);
    // Only the banner click. `UNNotificationDismissActionIdentifier` is what a
    // swipe-away sends, and a future custom action would name itself.
    let action = response.actionIdentifier().to_string();
    if action != "com.apple.UNNotificationDefaultActionIdentifier" {
        return None;
    }
    let content = response.notification().request().content();
    let info: objc2::rc::Retained<NSDictionary> = content.userInfo();
    let key = NSString::from_str(USER_INFO_TARGET);
    let value: objc2::rc::Retained<AnyObject> = info.objectForKey(&*key)?;
    let s: &NSString = value.downcast_ref::<NSString>()?;
    Some(s.to_string())
}

/// `userInfo` key the map target rides under.
const USER_INFO_TARGET: &str = "target";

#[cfg(target_os = "macos")]
fn platform_send(title: &str, body: &str, target: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSError, NSString, NSUUID};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound,
        UNUserNotificationCenter,
    };

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    if let Some(t) = target {
        let key = NSString::from_str(USER_INFO_TARGET);
        let val = NSString::from_str(t);
        let val_obj: &AnyObject = &val;
        let info: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_slices(&[&*key], &[val_obj]);
        // The dictionary holds only property-list values (one string), which
        // is what userInfo requires. `setUserInfo` is typed over untyped
        // keys; an NSString-keyed dictionary IS one, so the cast is sound.
        let info: objc2::rc::Retained<NSDictionary> = unsafe { objc2::rc::Retained::cast_unchecked(info) };
        unsafe { content.setUserInfo(&info) };
    }

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
fn platform_send(title: &str, body: &str, _target: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    // notify-rust has no click path we can hear on these platforms; the
    // target is carried for macOS only.
    notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .show()?;
    Ok(())
}
