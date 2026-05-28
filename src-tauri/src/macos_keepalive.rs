//! macOS App-Nap suppression via `NSProcessInfo.beginActivity(options:reason:)`.
//!
//! The webview-level fix is already in place (`background_throttling: Disabled`
//! on the WebviewWindowBuilder), but that only governs WKWebView's *internal*
//! timer throttling. macOS App Nap is process-level — it can still suspend the
//! whole app when the window loses focus, freezing the JS NATS listener and
//! pausing Rust threads.
//!
//! This module wraps Apple's documented answer: hold an `NSProcessActivity`
//! token for the lifetime of the app to tell the OS "I have ongoing work,
//! please don't nap me."
//!
//! The token is dropped on quit; the OS releases the assertion automatically
//! at process exit too, so this is safe-by-default.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// RAII guard for an `NSProcessInfo` activity. Drop ends the activity.
    pub struct ActivityToken {
        activity: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    // `NSProcessInfo`'s activity tokens are documented as thread-safe to
    // begin/end from any thread. We carry the retained pointer around in
    // Tauri's app state, which is `Send + Sync`, so opt in explicitly.
    //
    // SAFETY: per Apple's NSProcessInfo docs, the begin/endActivity APIs are
    // safe to call from any thread. The activity token itself is an opaque
    // `id` whose only consumer is `endActivity:` on `Drop`.
    unsafe impl Send for ActivityToken {}
    unsafe impl Sync for ActivityToken {}

    /// Begin a process-wide activity that prevents App Nap and idle system
    /// sleep. Holds for the lifetime of the returned token.
    pub fn begin_keepalive(reason: &str) -> ActivityToken {
        let process_info = NSProcessInfo::processInfo();
        let ns_reason = NSString::from_str(reason);

        // UserInitiated → declare this is foreground-quality work
        // IdleSystemSleepDisabled → prevent the system from sleeping
        // LatencyCritical → defeat timer coalescing
        let options = NSActivityOptions::UserInitiated
            | NSActivityOptions::IdleSystemSleepDisabled
            | NSActivityOptions::LatencyCritical;

        let activity = process_info.beginActivityWithOptions_reason(options, &ns_reason);
        ActivityToken { activity }
    }

    impl Drop for ActivityToken {
        fn drop(&mut self) {
            // SAFETY: `self.activity` was produced by `beginActivityWithOptions:reason:`
            // on the same `NSProcessInfo` instance and is the only consumer.
            unsafe {
                NSProcessInfo::processInfo().endActivity(&self.activity);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// No-op token for non-macOS targets.
    pub struct ActivityToken;
    pub fn begin_keepalive(_reason: &str) -> ActivityToken {
        ActivityToken
    }
}

#[allow(unused_imports)]
pub use imp::{begin_keepalive, ActivityToken};
