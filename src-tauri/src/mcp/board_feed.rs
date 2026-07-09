//! Board (Team Ops window) event feed — the single sink for agent/automation
//! information the player should see. Nothing here touches the MAIN game
//! window: entries render only in the board window's EVENT FEED card. Any
//! backend source (auto-loops, policy engine, threat scans, vplayer bridge)
//! pipes entries in via `push()`. A ring buffer back-fills the card whenever
//! the window (re)opens, and IMPORTANT entries auto-open the board window —
//! debounced — because the player sees nothing while it's closed.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::hasher::types::now_millis;

/// How loudly an entry should be surfaced. `Info` = routine automation chatter
/// (a mine started, a defender assigned). `Notice` = worth a glance (economy
/// milestone, policy state change). `Important` = the player should know NOW
/// (combat involving us, power critical, home-guard blocks) — auto-opens the
/// board window.
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
/// `Important` entries also auto-open the window (debounced).
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
    if let Some(w) = app.get_webview_window("board") {
        let _ = w.emit("board-feed", &entry);
    }
}

/// Open the Team Ops window if it isn't open, debounced so a burst of
/// important events doesn't repeatedly grab the player's attention. Focus is
/// only taken when the window is actually created.
fn ensure_board_open(app: &tauri::AppHandle) {
    if app.get_webview_window("board").is_some() {
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
    match WebviewWindowBuilder::new(app, "board", WebviewUrl::App("board.html".into()))
        .title("Structs — Team Ops")
        .inner_size(580.0, 760.0)
        .build()
    {
        Ok(w) => {
            let _ = w.set_focus();
            eprintln!("[Board Feed] opened Team Ops window (important event)");
        }
        Err(e) => eprintln!("[Board Feed] couldn't open Team Ops window: {}", e),
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
