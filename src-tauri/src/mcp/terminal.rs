//! The Structs Terminal — one customizable page of cards, reachable from the
//! game's Debug tab, that pops out into windows which come back on relaunch.
//!
//! The page itself is `board.html?view=terminal`: the Team Ops window's own
//! renderer in a chrome-less mode, so every Team Ops page, the Game Stats
//! charts and the card components (player / guild / provider) are already
//! in scope for a card. This module owns what the page cannot: the layout on
//! disk, the windows, and the energy market read the cards draw from.
//!
//! Persistence is two small files under the app's config dir:
//!   terminal.json          the layout — cards, their params and order
//!   terminal-windows.json  which windows were open at quit, reopened at boot

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const LAYOUT_FILE: &str = "terminal.json";
const WINDOWS_FILE: &str = "terminal-windows.json";
/// The main terminal window's label; a popped-out card is `terminal-<id>`.
pub const LABEL: &str = "terminal";
pub const CARD_LABEL_PREFIX: &str = "terminal-";

/// Is this window label one of ours? Used wherever board traffic fans out.
pub fn is_terminal_label(label: &str) -> bool {
    label == LABEL || label.starts_with(CARD_LABEL_PREFIX)
}

/// One card on the page. `params` is the card type's own business (an
/// object id, a page name); `w` is its grid span in columns, 1–3.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Card {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default = "one")]
    pub w: u8,
}
fn one() -> u8 {
    1
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Layout {
    #[serde(default)]
    pub cards: Vec<Card>,
    /// Bumped by the page on every save so a stale pop-out can tell.
    #[serde(default)]
    pub version: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Windows {
    #[serde(default)]
    open: bool,
    /// Card ids that had their own window at quit.
    #[serde(default)]
    cards: Vec<String>,
}

static LAYOUT: LazyLock<Mutex<Layout>> =
    LazyLock::new(|| Mutex::new(crate::mcp::config_store::load_config(LAYOUT_FILE)));
static WINDOWS: LazyLock<Mutex<Windows>> =
    LazyLock::new(|| Mutex::new(crate::mcp::config_store::load_config(WINDOWS_FILE)));
/// Set from app exit so a close during teardown keeps the reopen flags.
static APP_QUITTING: AtomicBool = AtomicBool::new(false);

pub fn note_app_quitting() {
    APP_QUITTING.store(true, Ordering::SeqCst);
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// A card id is written into a window label and a URL: letters, digits,
/// dashes and underscores only, bounded.
pub fn sane_card_id(id: &str) -> Option<String> {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect();
    if s.is_empty() || s != id {
        None
    } else {
        Some(s)
    }
}

// ── Layout ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn terminal_layout_get() -> Layout {
    lock(&LAYOUT).clone()
}

/// Replace the layout. The page is the authority on shape; this only refuses
/// what cannot be a card at all (an id that would not survive a URL).
#[tauri::command]
pub fn terminal_layout_set(layout: Layout) -> Result<Layout, String> {
    for c in &layout.cards {
        if sane_card_id(&c.id).is_none() {
            return Err(format!("card id {:?} is not a plain id", c.id));
        }
        if c.kind.is_empty() {
            return Err(format!("card {} has no type", c.id));
        }
    }
    let mut cur = lock(&LAYOUT);
    *cur = layout;
    crate::mcp::config_store::save_config(LAYOUT_FILE, &*cur);
    Ok(cur.clone())
}

// ── Windows ─────────────────────────────────────────────────────────────────

fn save_windows(w: &Windows) {
    crate::mcp::config_store::save_config(WINDOWS_FILE, w);
}

fn build(app: &tauri::AppHandle, label: &str, url: &str, title: &str, size: (f64, f64)) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .build()
        .map_err(|e| e.to_string())
}

fn focus(w: &tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// Open (or raise) the Terminal. Remembers that it is open so it comes back
/// on the next launch; a user close forgets it, an app quit does not.
#[tauri::command]
pub fn open_terminal_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        focus(&w);
        return Ok(());
    }
    let w = build(&app, LABEL, "board.html?view=terminal", "Structs — Terminal", (1180.0, 860.0))?;
    w.on_window_event(|event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) && !APP_QUITTING.load(Ordering::SeqCst) {
            let mut ws = lock(&WINDOWS);
            ws.open = false;
            save_windows(&ws);
        }
    });
    {
        let mut ws = lock(&WINDOWS);
        ws.open = true;
        save_windows(&ws);
    }
    // The board's data spine (roster sweeps, background refresh) serves the
    // terminal's cards too.
    crate::mcp::roster_cache::trigger_sweep(app.clone(), 60_000.0);
    crate::mcp::roster_cache::ensure_background_refresh(app.clone());
    focus(&w);
    Ok(())
}

/// Pop one card out into its own window. The window shows the same card,
/// full-size, from the same layout; it is remembered and reopened at boot.
#[tauri::command]
pub fn open_terminal_card(app: tauri::AppHandle, card_id: String) -> Result<(), String> {
    let id = sane_card_id(&card_id).ok_or_else(|| format!("card id {card_id:?} is not a plain id"))?;
    let label = format!("{CARD_LABEL_PREFIX}{id}");
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
        return Ok(());
    }
    let title = lock(&LAYOUT)
        .cards
        .iter()
        .find(|c| c.id == id)
        .map(|c| format!("Structs — {}", c.kind))
        .unwrap_or_else(|| "Structs — Terminal card".into());
    let w = build(&app, &label, &format!("board.html?view=terminal&card={id}"), &title, (640.0, 620.0))?;
    let forget = id.clone();
    w.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) && !APP_QUITTING.load(Ordering::SeqCst) {
            let mut ws = lock(&WINDOWS);
            ws.cards.retain(|c| c != &forget);
            save_windows(&ws);
        }
    });
    {
        let mut ws = lock(&WINDOWS);
        if !ws.cards.contains(&id) {
            ws.cards.push(id.clone());
        }
        save_windows(&ws);
    }
    focus(&w);
    Ok(())
}

/// Which terminal windows are open right now (the page shows a pop-out as
/// "already out" rather than offering it twice).
#[tauri::command]
pub fn terminal_windows(app: tauri::AppHandle) -> Value {
    let cards: Vec<String> = app
        .webview_windows()
        .keys()
        .filter_map(|l| l.strip_prefix(CARD_LABEL_PREFIX).map(|s| s.to_string()))
        .collect();
    json!({ "open": app.get_webview_window(LABEL).is_some(), "cards": cards })
}

/// At boot: bring back the Terminal and every popped-out card that was open
/// at the last quit. Only ever windows the player chose to have open.
pub fn reopen_if_persisted(app: &tauri::AppHandle) {
    let ws = lock(&WINDOWS).clone();
    if ws.open {
        match open_terminal_window(app.clone()) {
            Ok(()) => eprintln!("[Terminal] reopened (was open at last exit)"),
            Err(e) => eprintln!("[Terminal] couldn't reopen: {e}"),
        }
    }
    for id in ws.cards {
        if let Err(e) = open_terminal_card(app.clone(), id.clone()) {
            eprintln!("[Terminal] couldn't reopen card {id}: {e}");
        }
    }
}

// ── The energy market ───────────────────────────────────────────────────────

/// Every provider on the chain as the provider card draws it, cached for a
/// minute. Read from the LCD's provider store in pages, through the same
/// `provider_card` Comms uses for a provider it names, so the market board
/// and a card in chat are the same card.
#[tauri::command]
pub async fn terminal_market() -> Result<Value, String> {
    static CACHE: LazyLock<Mutex<(f64, Value)>> = LazyLock::new(|| Mutex::new((0.0, Value::Null)));
    const TTL_MS: f64 = 60_000.0;
    let now = crate::hasher::types::now_millis();
    {
        let c = lock(&CACHE);
        if !c.1.is_null() && now - c.0 < TTL_MS {
            return Ok(c.1.clone());
        }
    }
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let mut providers: Vec<Value> = Vec::new();
    let mut key: Option<String> = None;
    let mut pages = 0;
    loop {
        let page = client.list_entities("provider", key.as_deref(), Some(200)).await?;
        let rows = page
            .get("Provider")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for p in rows {
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            providers.push(crate::matrix::refs::provider_card(&id, &json!({ "Provider": p })));
        }
        key = page
            .get("pagination")
            .and_then(|p| p.get("next_key"))
            .and_then(|k| k.as_str())
            .filter(|k| !k.is_empty())
            .map(|k| k.to_string());
        pages += 1;
        if key.is_none() || pages >= 20 {
            break;
        }
    }
    // Cheapest first, as a quote board reads: only alpha-priced offers are
    // comparable without a bank ratio, so those lead and the rest keep their
    // chain order behind them.
    providers.sort_by(|a, b| {
        let rate = |v: &Value| {
            let p = v.get("provider");
            let alpha = p.and_then(|p| p.get("rate_denom")).and_then(|d| d.as_str()) == Some("ualpha");
            let amt = p.and_then(|p| p.get("rate_amount")).and_then(|a| a.as_f64()).unwrap_or(f64::MAX);
            (if alpha { 0 } else { 1 }, amt)
        };
        rate(a).partial_cmp(&rate(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let out = json!({
        "at_ms": now,
        "height": crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0),
        "providers": providers,
    });
    *lock(&CACHE) = (now, out.clone());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_ids_are_plain_or_refused() {
        assert_eq!(sane_card_id("market-1"), Some("market-1".into()));
        assert_eq!(sane_card_id("people_2"), Some("people_2".into()));
        assert_eq!(sane_card_id("../etc"), None, "a path is not an id");
        assert_eq!(sane_card_id("a b"), None);
        assert_eq!(sane_card_id(""), None);
        assert_eq!(sane_card_id(&"x".repeat(41)), None, "bounded");
    }

    #[test]
    fn labels_are_ours_by_prefix() {
        assert!(is_terminal_label("terminal"));
        assert!(is_terminal_label("terminal-market-1"));
        assert!(!is_terminal_label("board"));
        assert!(!is_terminal_label("terminalx"));
    }

    #[test]
    fn a_layout_round_trips_with_defaults_filled() {
        let raw = r#"{"cards":[{"id":"a","type":"people"},{"id":"b","type":"page","params":{"page":"work"},"w":3}]}"#;
        let l: Layout = serde_json::from_str(raw).unwrap();
        assert_eq!(l.cards[0].w, 1, "span defaults to one column");
        assert_eq!(l.cards[1].w, 3);
        assert_eq!(l.cards[1].params["page"], "work");
        assert_eq!(l.version, 0);
        let back: Layout = serde_json::from_str(&serde_json::to_string(&l).unwrap()).unwrap();
        assert_eq!(back, l);
    }
}
