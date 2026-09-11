//! The desktop companion.
//!
//! A 225×280 window with no chrome that floats over everything, follows you
//! across Spaces, and says what your colony and your crew are doing. It is the
//! part of this app you leave running when the app itself is closed.
//!
//! Borrowed wholesale from droidsh, which built this first and measured the
//! one thing that decides whether it survives on somebody's desktop:
//! **what it costs to do nothing.** Their pet idled at 13.22% of a core on a
//! display-link animation schedule and 2.37% on a 1 Hz one — an 82% drop for
//! a 1-pixel bob nobody can tell apart. So the rule for `frontend/pet.js` is:
//! a one-second interval, never `requestAnimationFrame`, and any celebration
//! animation ends itself after three seconds. An always-on window that eats
//! battery is an always-on window that gets closed.
//!
//! Two further things that fall out of the platform rather than taste:
//!
//!   * the window is TRANSPARENT and undecorated, which Tauri allows here only
//!     because `macOSPrivateApi` is already on in `tauri.conf.json`;
//!   * its state arrives as ONE pushed event (`AppEvent::Companion`) rather
//!     than by polling. A window that polls is a window that is awake, and the
//!     whole point of this one is that it is not.
//!
//! What it may NOT do is decide anything. Every door on it opens a window that
//! is already allowed to act — the companion is a face, and `require_window`
//! deliberately does not list it.

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::hasher::types::now_millis;

/// The window's label. Named here because `events.rs` addresses it.
pub const LABEL: &str = "pet";

const FILENAME: &str = "companion.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompanionConfig {
    /// Whether the pet was on screen at last exit, so it comes back.
    #[serde(default)]
    pub shown: bool,
    /// Which face the caption shows first: the colony, or the crew.
    #[serde(default = "default_face")]
    pub face: String,
}

fn default_face() -> String {
    "goal".into()
}

impl Default for CompanionConfig {
    fn default() -> Self {
        Self { shown: false, face: default_face() }
    }
}

fn load() -> CompanionConfig {
    crate::mcp::config_store::load_config(FILENAME)
}

fn save(c: &CompanionConfig) {
    crate::mcp::config_store::save_config(FILENAME, c);
}

/// Build the window, or raise the one already open.
///
/// `orderFrontRegardless` semantics: showing the pet must never pull the whole
/// app in front of what the player is doing. That is the entire difference
/// between a companion and an interruption.
pub fn show(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("Structs")
        .inner_size(225.0, 300.0)
        .resizable(false)
        // No chrome and no ground: the visible shape is whatever the page
        // paints, which is how a bubble and a portrait can float without a
        // rectangle around them.
        .decorations(false)
        .transparent(true)
        .shadow(false)
        // Above ordinary windows, on every Space, and out of the app switcher
        // — the three properties that make it a companion rather than a
        // window you have to go and find.
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        // Its job is to keep talking while it is behind something. The main
        // window already disables this for the same reason.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w;
    let mut cfg = load();
    cfg.shown = true;
    save(&cfg);
    Ok(())
}

/// Take it off the screen. Deliberately a close rather than a hide: the state
/// it draws is pushed, so a hidden window is a subscriber that costs something
/// and shows nobody anything.
pub fn hide(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    let mut cfg = load();
    cfg.shown = false;
    save(&cfg);
}

pub fn is_open(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Reopen the pet if it was on screen at last exit.
pub fn reopen_if_persisted(app: &tauri::AppHandle) {
    if load().shown {
        let _ = show(app);
    }
}

// ── What it says ────────────────────────────────────────────────────────────

/// The caption, chosen by priority.
///
/// Ordered by what would make somebody look: a crew that has stopped working
/// beats a crew that is working, which beats the hourly figure. The one rule
/// that overrides all of it is honesty — a number this app has not confirmed
/// is never shown as a number. droidsh writes `— α / h` until the figures are
/// in, and being trusted about the small readings is the only reason the big
/// ones are believed.
pub fn caption(state: &Value) -> (String, String) {
    let s = |k: &str| state.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let n = |k: &str| state.get(k).and_then(|v| v.as_f64());
    let b = |k: &str| state.get(k).and_then(|v| v.as_bool()).unwrap_or(false);

    if !s("trouble").is_empty() {
        return ("Work needs attention".into(), s("trouble").to_string());
    }
    if b("crew_working") {
        let helping = n("crew_taking").unwrap_or(0.0) as u64;
        let done = n("crew_helped").unwrap_or(0.0) as u64;
        return (
            "Helping".into(),
            if done > 0 {
                format!("{helping} running · {done} finished")
            } else {
                format!("{helping} running")
            },
        );
    }
    if let Some(owed) = n("owed_base").filter(|v| *v > 0.0) {
        return ("Owed".into(), format!("{} to pay", fmt_alpha(owed)));
    }
    match n("alpha_per_hour") {
        // Confirmed, so it may be a number.
        Some(v) => (format!("+{} α / h", fmt_alpha(v)), s("reserve_line").to_string()),
        // Not confirmed. An em dash, never a zero: a zero is a claim.
        None => ("— α / h".into(), s("reserve_line").to_string()),
    }
}

/// The game's own ladder, in the one place Rust needs it here.
fn fmt_alpha(ualpha: f64) -> String {
    crate::mcp::tools::format::format_alpha(ualpha)
}

/// Gather what the pet draws. One read, pushed; the window never polls.
pub fn state(app: &tauri::AppHandle) -> Value {
    let cfg = load();
    let player_id = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.player_id.clone())
        .unwrap_or_default();
    // The portrait a player wrote about themselves on chain, from the roster
    // cache that already holds it. `None` draws the placeholder rather than
    // nothing, so the pet has a face before any sweep has run.
    let pfp = crate::mcp::roster_cache::all_rows()
        .into_iter()
        .find(|r| r.player_id == player_id)
        .and_then(|r| r.pfp_attrs);
    // Left unset until there is a confirmed figure to put here. See `caption`:
    // an absent rate draws an em dash, and that is the intended reading.
    let alpha_ph: Option<f64> = None;
    let crews = crate::mcp::crew::all();
    let work = crate::mcp::crew_work::get();
    let taking = crate::mcp::crew_work::taking_now();
    let helped = crate::mcp::crew_work::helped_total();
    let owed: f64 = crate::mcp::crew_pay::credits()
        .iter()
        .filter(|c| c.settled_at.is_none())
        .map(|c| c.amount_base)
        .sum();

    let mut v = json!({
        "player_id": player_id,
        "pfp": pfp,
        "face": cfg.face,
        "crews": crews.len(),
        "crew_working": work.enabled && crews.iter().any(|c| c.role.grinds()),
        "crew_taking": taking,
        "crew_helped": helped,
        "owed_base": owed,
        "alpha_per_hour": alpha_ph,
        "reserve_line": "",
        "trouble": "",
        "at_ms": now_millis(),
        "open": is_open(app),
    });
    let (line1, line2) = caption(&v);
    v["line1"] = json!(line1);
    v["line2"] = json!(line2);
    v
}

/// Push the current state to the pet, if it is on screen.
pub fn push(app: &tauri::AppHandle) {
    // The menu bar is updated whether or not the pet is on screen: it is the
    // readout for people who never open the window.
    refresh_tray(app);
    if !is_open(app) {
        return;
    }
    let _ = crate::mcp::events::emit(app, crate::mcp::events::AppEvent::Companion(state(app)));
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn companion_toggle(app: tauri::AppHandle) -> Result<Value, String> {
    if is_open(&app) {
        hide(&app);
        return Ok(json!({ "open": false }));
    }
    show(&app)?;
    Ok(json!({ "open": true }))
}

#[tauri::command]
pub fn companion_state(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(state(&app))
}

/// Which face the caption leads with. A preference, saved, nothing else.
#[tauri::command]
pub fn companion_face(app: tauri::AppHandle, face: String) -> Result<Value, String> {
    let mut cfg = load();
    cfg.face = if face == "work" { "work".into() } else { "goal".into() };
    save(&cfg);
    push(&app);
    Ok(json!({ "face": cfg.face }))
}

/// The pet's doors open windows; it never acts itself.
#[tauri::command]
pub fn companion_open(app: tauri::AppHandle, what: String) -> Result<Value, String> {
    match what.as_str() {
        "board" => {
            crate::mcp::board_feed::open_board_window(app.clone())?;
        }
        "crew" => {
            crate::mcp::terminal::open_terminal_card_new(app.clone(), "crew".into(), Some(json!({})), None)?;
        }
        _ => return Err(format!("{what} is not something the companion opens")),
    }
    Ok(json!({ "ok": true }))
}


// ── The menu bar ────────────────────────────────────────────────────────────
//
// A line of text in the menu bar is the cheapest possible always-on readout:
// no window, no pixels of the player's screen, and it survives having every
// Structs window closed. droidsh's reads `+95 α / h · ↗` while its crew is
// working and `· !` when something needs a person, and that single character
// is the whole notification layer — which is the one place their design is
// thin, and the reason a failure can go unnoticed there.
//
// What is here is the readout. It says what is true and opens the windows that
// can act; like the pet, it decides nothing.

use std::sync::{Mutex, OnceLock};
use tauri::tray::TrayIcon;

static TRAY: OnceLock<Mutex<Option<TrayIcon>>> = OnceLock::new();

fn tray_slot() -> &'static Mutex<Option<TrayIcon>> {
    TRAY.get_or_init(|| Mutex::new(None))
}

/// The menu-bar line for a state. Pure, so the wording is testable.
///
/// Follows the same honesty rule as the caption: the rate is whatever
/// `caption` decided, including the em dash when nothing is confirmed. A
/// trailing mark says whether anybody needs to do something.
pub fn tray_title(state: &Value) -> String {
    let (line1, _) = caption(state);
    let trouble = state.get("trouble").and_then(|v| v.as_str()).unwrap_or("");
    let working = state.get("crew_working").and_then(|v| v.as_bool()).unwrap_or(false);
    let mark = if !trouble.is_empty() {
        " · !"
    } else if working {
        " · ↗"
    } else {
        ""
    };
    format!(" {line1}{mark}")
}

/// Put the tray in the menu bar. Called once, at startup.
pub fn install_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let open_board = MenuItem::with_id(app, "tray_board", "Team Ops", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let open_crew = MenuItem::with_id(app, "tray_crew", "Crew", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let toggle_pet = MenuItem::with_id(app, "tray_pet", "Show the companion", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Structs")).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open_board, &open_crew, &toggle_pet, &sep, &quit])
        .map_err(|e| e.to_string())?;

    let tray = TrayIconBuilder::with_id("structs")
        .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
        // The icon alone would be a decoration. The title is the readout.
        .icon_as_template(true)
        .title(" Structs")
        .menu(&menu)
        // A left click is for the menu here as well: there is no popover of
        // our own, and a click that appears to do nothing is worse than a
        // menu that repeats what the windows offer.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_board" => {
                let _ = crate::mcp::board_feed::open_board_window(app.clone());
            }
            "tray_crew" => {
                let _ = crate::mcp::terminal::open_terminal_card_new(
                    app.clone(), "crew".into(), Some(json!({})), None,
                );
            }
            "tray_pet" => {
                if is_open(app) {
                    hide(app);
                } else {
                    let _ = show(app);
                }
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    if let Ok(mut slot) = tray_slot().lock() {
        *slot = Some(tray);
    }
    Ok(())
}

/// Update the menu-bar line. Cheap enough to call on every tick; skipped when
/// the text has not changed, because a tray update is a main-thread hop.
pub fn refresh_tray(app: &tauri::AppHandle) {
    static LAST: OnceLock<Mutex<String>> = OnceLock::new();
    let title = tray_title(&state(app));
    let last = LAST.get_or_init(|| Mutex::new(String::new()));
    if let Ok(mut l) = last.lock() {
        if *l == title {
            return;
        }
        *l = title.clone();
    }
    if let Ok(slot) = tray_slot().lock() {
        if let Some(t) = slot.as_ref() {
            let _ = t.set_title(Some(title));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trouble_outranks_everything() {
        let (a, b) = caption(&json!({ "trouble": "signing is wedged", "crew_working": true,
                                      "alpha_per_hour": 95.0 }));
        assert_eq!(a, "Work needs attention");
        assert_eq!(b, "signing is wedged");
    }

    #[test]
    fn a_working_crew_says_what_it_is_doing() {
        let (a, b) = caption(&json!({ "crew_working": true, "crew_taking": 3, "crew_helped": 12 }));
        assert_eq!(a, "Helping");
        assert_eq!(b, "3 running · 12 finished");
        // Nothing finished yet is not "0 finished" — a fresh session should
        // not open by reporting a zero.
        let (_, b2) = caption(&json!({ "crew_working": true, "crew_taking": 1, "crew_helped": 0 }));
        assert_eq!(b2, "1 running");
    }

    /// The rule the whole face rests on: a figure this app has not confirmed
    /// is shown as an em dash. A zero would be a claim, and one wrong claim
    /// costs the reader their trust in every other reading on the window.
    #[test]
    fn an_unconfirmed_rate_is_a_dash_and_never_a_zero() {
        let (a, _) = caption(&json!({}));
        assert_eq!(a, "— α / h");
        assert!(!a.contains('0'));
    }

    #[test]
    fn a_confirmed_rate_is_a_number() {
        let (a, _) = caption(&json!({ "alpha_per_hour": 95_000_000.0 }));
        assert!(a.starts_with("+") && a.ends_with(" α / h"), "{a}");
    }

    #[test]
    fn what_is_owed_is_worth_saying_when_nothing_is_running() {
        let (a, _) = caption(&json!({ "owed_base": 900.0 }));
        assert_eq!(a, "Owed");
    }

    /// The menu-bar line is the whole notification layer, so what it says
    /// when something is wrong has to be distinguishable at a glance from
    /// what it says when nothing is.
    #[test]
    fn the_menu_bar_marks_trouble_and_work_differently() {
        let idle = tray_title(&json!({}));
        let working = tray_title(&json!({ "crew_working": true, "crew_taking": 2 }));
        let bad = tray_title(&json!({ "trouble": "signing is wedged" }));
        assert!(!idle.contains('!') && !idle.contains('↗'), "{idle}");
        assert!(working.ends_with(" · ↗"), "{working}");
        assert!(bad.ends_with(" · !"), "{bad}");
        assert_ne!(working, bad);
    }

    /// ...and it inherits the caption's honesty: no confirmed figure, no
    /// number in the menu bar either.
    #[test]
    fn the_menu_bar_does_not_invent_a_rate() {
        assert!(tray_title(&json!({})).contains("—"));
    }

    #[test]
    fn the_companion_is_off_until_it_is_opened() {
        assert!(!CompanionConfig::default().shown);
    }
}
