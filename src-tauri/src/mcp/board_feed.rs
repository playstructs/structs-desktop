//! Board (Team Ops window) event feed — the single sink for agent/automation
//! information the player should see. Nothing here touches the MAIN game
//! window: entries render only in the board window's EVENT FEED card. Any
//! backend source (auto-loops, policy engine, threat scans, vplayer bridge)
//! pipes entries in via `push()`. A ring buffer back-fills the card whenever
//! the window (re)opens. IMPORTANT entries auto-open the board window
//! (debounced) — but ONLY if the player opted in via the `board_auto_open`
//! policy; otherwise the window stays closed no matter what, because the
//! player, not the agent, decides when their screen changes.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::hasher::types::now_millis;

/// How loudly an entry should be surfaced. `Info` = routine automation chatter
/// (a mine started, a defender assigned). `Notice` = worth a glance (economy
/// milestone, policy state change). `Important` = the player should know NOW
/// (combat involving us, power critical) — auto-opens the board window when
/// the player has opted in via the `board_auto_open` policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Notice,
    Important,
}

impl Severity {
    fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Notice => "notice",
            Severity::Important => "important",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedEntry {
    /// Wall-clock ms — the frontend renders a local HH:MM:SS.
    pub ts_ms: f64,
    pub severity: &'static str,
    /// Short source tag, e.g. "auto_defend", "threats", "policy".
    pub source: String,
    pub message: String,
}

const FEED_CAP: usize = 300;
/// Don't auto-open (and steal focus) more than once per this window; entries
/// still land in the feed and are back-filled when the window opens.
const AUTO_OPEN_DEBOUNCE_MS: f64 = 600_000.0; // 10 min

static FEED: LazyLock<Mutex<VecDeque<FeedEntry>>> =
    LazyLock::new(|| Mutex::new(VecDeque::with_capacity(FEED_CAP)));
static LAST_AUTO_OPEN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

/// Pipe an entry into the board feed. Safe to call from any thread/context
/// (sync, no awaits). Emits live to the board window when it's open;
/// `Important` entries also auto-open the window (debounced, and only if the
/// player enabled the `board_auto_open` policy).
pub fn push(app: &tauri::AppHandle, severity: Severity, source: &str, message: impl Into<String>) {
    let entry = FeedEntry {
        ts_ms: now_millis(),
        severity: severity.as_str(),
        source: source.to_string(),
        message: message.into(),
    };
    if let Ok(mut feed) = FEED.lock() {
        if feed.len() >= FEED_CAP {
            feed.pop_front();
        }
        feed.push_back(entry.clone());
    }

    if severity == Severity::Important {
        ensure_board_open(app);
    }
    // emit_to (not emit): Tauri v2 `emit` broadcasts to every window; target the
    // board explicitly so this never reaches the main game window.
    if app.get_webview_window("board").is_some() {
        let _ = app.emit_to("board", "board-feed", &entry);
    }
}

/// Set true when the app is shutting down (from `RunEvent::ExitRequested`) so
/// the board window's close handler can distinguish an intentional user-dismiss
/// (clear the reopen flag) from the window being torn down as part of app exit
/// (leave the flag set, so a board that was open at quit reopens next launch).
static APP_QUITTING: AtomicBool = AtomicBool::new(false);

/// Record that the app is exiting. Call from the Tauri `RunEvent::ExitRequested`
/// handler, before windows are destroyed.
pub fn mark_app_quitting() {
    APP_QUITTING.store(true, Ordering::SeqCst);
}

fn persist_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join("board_window.json"))
}

/// Whether the Team Ops window was open (and not user-dismissed) at last exit.
/// Set to `true` by `build_board_window`, which is reached by ANY MCP open
/// path — `structs_board open:true`, a prompt directive, or a consent-gated
/// important-event auto-open — so an agent-opened board persists across
/// restarts too. The invariant that matters still holds: a fresh player who
/// has never had the board open stays at the `false` default, so startup
/// reopen never fires as a surprise; and the player closing the window clears
/// the flag.
///
/// Platform note: the shutdown guard relies on `RunEvent::ExitRequested`
/// (which sets `APP_QUITTING`) firing before the window's `CloseRequested`.
/// That ordering holds on macOS (the shipping target); on Windows/Linux
/// `CloseRequested` can fire first, so quit-with-board-open would clear the
/// flag and NOT reopen — latent, benign (fails toward "closed"), revisit if
/// those platforms ship.
pub fn persisted_open() -> bool {
    persist_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("open").and_then(|o| o.as_bool()))
        .unwrap_or(false)
}

fn set_persisted_open(open: bool) {
    if let Some(p) = persist_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, serde_json::json!({ "open": open }).to_string());
    }
}

/// Build the Team Ops window and wire up reopen persistence. EVERY open path
/// (prompt directive, important-event auto-open, `structs_board open:true`, and
/// startup reopen) funnels through here so behaviour is consistent:
///  - records `open = true` so the window reopens on the next launch, and
///  - installs a `CloseRequested` handler that clears the flag when the PLAYER
///    dismisses the board window themselves — but NOT when the window is torn
///    down as part of app shutdown (guarded by `APP_QUITTING`), so "open at
///    quit" is preserved and reopens next time.
/// Callers still guard on `get_webview_window("board").is_none()` and apply any
/// consent gate (e.g. the `board_auto_open` policy) before calling.
pub fn build_board_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    let window = WebviewWindowBuilder::new(app, "board", WebviewUrl::App("board.html".into()))
        .title("Structs — Team Ops")
        // Wide enough for the fleet rows (avatar + identity + labeled stats) to
        // breathe and for the responsive grid to show a second column.
        .inner_size(774.0, 760.0)
        .build()?;
    // Command Center data spine: kick a roster sweep for the FLEET page (debounced
    // — a reopen within a minute reuses the snapshot) and make sure the 5-minute
    // background refresher is running for as long as the window keeps existing.
    crate::mcp::roster_cache::trigger_sweep(app.clone(), 60_000.0);
    crate::mcp::roster_cache::ensure_background_refresh(app.clone());
    window.on_window_event(|event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
            && !APP_QUITTING.load(Ordering::SeqCst)
        {
            set_persisted_open(false);
        }
    });
    set_persisted_open(true);
    Ok(window)
}

/// Open the Team Ops window if it isn't open — ONLY when the player opted in
/// via the `board_auto_open` policy (`structs_policy set board_auto_open true`).
/// Without that consent the window stays closed no matter how important the
/// event; the entry still lands in the feed for whenever they open it. Opening
/// is debounced so a burst of important events doesn't repeatedly grab the
/// player's attention, and focus is only taken when the window is created.
fn ensure_board_open(app: &tauri::AppHandle) {
    if app.get_webview_window("board").is_some() {
        return;
    }
    let opted_in = crate::mcp::policy::POLICY_ENGINE
        .read()
        .map(|e| e.is_enabled("board_auto_open"))
        .unwrap_or(false);
    if !opted_in {
        return;
    }
    {
        let mut last = LAST_AUTO_OPEN.lock().unwrap();
        let now = now_millis();
        if now - *last < AUTO_OPEN_DEBOUNCE_MS {
            return;
        }
        *last = now;
    }
    match build_board_window(app) {
        Ok(w) => {
            let _ = w.set_focus();
            eprintln!("[Board Feed] opened Team Ops window (important event)");
        }
        Err(e) => eprintln!("[Board Feed] couldn't open Team Ops window: {}", e),
    }
}

/// Spawn the Team Ops window unconditionally (no `board_auto_open` consent
/// gate) — used for PROMPT directives, which the player sanctioned themselves
/// (an ask-mode policy they configured, or an explicit agent elicitation) and
/// which need a surface to be answered on. Returns whether a window exists.
pub fn spawn_window(app: &tauri::AppHandle) -> bool {
    if app.get_webview_window("board").is_some() {
        return true;
    }
    match build_board_window(app) {
        Ok(w) => {
            let _ = w.set_focus();
            eprintln!("[Board Feed] opened Team Ops window (prompt directive)");
            true
        }
        Err(e) => {
            eprintln!("[Board Feed] couldn't open Team Ops window: {}", e);
            false
        }
    }
}

/// On app startup, reopen the Team Ops window iff it was open (and not
/// user-dismissed) at last exit. Because the persisted flag is only ever set
/// after an intentional MCP open, this never surprises a player who has not
/// opened the board — matching the "never open automatically unless the player
/// opened it via MCP first" rule. Does not steal focus from the game window.
pub fn reopen_if_persisted(app: &tauri::AppHandle) {
    if !persisted_open() || app.get_webview_window("board").is_some() {
        return;
    }
    match build_board_window(app) {
        Ok(_) => eprintln!("[Board Feed] reopened Team Ops window (was open at last exit)"),
        Err(e) => eprintln!("[Board Feed] couldn't reopen Team Ops window: {}", e),
    }
}

/// Recent entries, oldest→newest — the board window back-fills from this on load.
pub fn recent(limit: usize) -> Vec<FeedEntry> {
    FEED.lock()
        .map(|f| f.iter().rev().take(limit).rev().cloned().collect())
        .unwrap_or_default()
}

/// Tauri command the board window invokes on load to back-fill the feed card.
#[tauri::command]
pub fn mcp_board_feed() -> Vec<FeedEntry> {
    recent(150)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_tags() {
        assert_eq!(Severity::Info.as_str(), "info");
        assert_eq!(Severity::Notice.as_str(), "notice");
        assert_eq!(Severity::Important.as_str(), "important");
    }

    #[test]
    fn ring_buffer_caps_and_orders() {
        // Direct buffer manipulation (push() needs an AppHandle; the ring logic
        // is what matters here).
        let mut feed = FEED.lock().unwrap();
        feed.clear();
        for i in 0..(FEED_CAP + 10) {
            if feed.len() >= FEED_CAP {
                feed.pop_front();
            }
            feed.push_back(FeedEntry {
                ts_ms: i as f64,
                severity: "info",
                source: "test".into(),
                message: format!("m{}", i),
            });
        }
        assert_eq!(feed.len(), FEED_CAP);
        assert_eq!(feed.front().unwrap().message, "m10");
        drop(feed);
        let r = recent(5);
        assert_eq!(r.len(), 5);
        assert_eq!(r.last().unwrap().message, format!("m{}", FEED_CAP + 9));
    }
}
