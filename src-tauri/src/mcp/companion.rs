//! The desktop companion.
//!
//! A 200×220 window with no chrome that floats over everything, follows you
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

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct CompanionConfig {
    /// Whether the pet was on screen at last exit, so it comes back.
    #[serde(default)]
    pub shown: bool,
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
        // Sized for the character plus the tallest note it can show, and no
        // more. The window is transparent and bottom-aligned, so the room
        // above the portrait is invisible while it is empty — but it is still
        // the player's screen, and a window reserving space it rarely uses is
        // the thing this was rebuilt to stop doing.
        .inner_size(200.0, 220.0)
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

/// What is worth interrupting somebody for.
///
/// **Nothing, most of the time.** This window sits on top of whatever the
/// player is actually doing, so the bar for putting words on it is not "is
/// this true" or "is this interesting" — it is *would they want to stop and
/// act on it*. A rate they can read in the menu bar, a crew they turned on
/// themselves, and their own player id all fail that test.
///
/// So the pet is SILENT unless something needs them. A quiet colony is a
/// character on the desktop and no text at all.
pub fn caption(state: &Value) -> Option<Note> {
    let s = |k: &str| state.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let n = |k: &str| state.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);

    // Something is broken and will stay broken until a person looks.
    let trouble = s("trouble");
    if !trouble.is_empty() {
        return Some(Note { text: trouble.to_string(), tone: "bad", door: "board" });
    }
    // Somebody did work for us and has not been paid. Actionable, and the one
    // thing nothing else in the app will nag about.
    let owed = n("owed_base");
    if owed > 0.0 {
        return Some(Note {
            text: format!("{} owed", fmt_alpha(owed)),
            tone: "",
            door: "crewpay",
        });
    }
    None
}

/// The game's own ladder, in the one place Rust needs it here.
fn fmt_alpha(ualpha: f64) -> String {
    crate::mcp::tools::format::format_alpha(ualpha)
}

/// A line on the pet, and what clicking it opens.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub text: String,
    /// `"bad"` paints it as a warning; empty is ordinary.
    pub tone: &'static str,
    pub door: &'static str,
}

/// The continuous readout — the menu bar's job, not the pet's.
///
/// A number that changes every few minutes belongs somewhere the eye can
/// ignore it. Putting it on the pet meant a slab of grey saying `— α / h`,
/// which is a large amount of somebody's screen spent on "no news".
fn rate_line(state: &Value) -> String {
    match state.get("alpha_per_hour").and_then(|v| v.as_f64()) {
        // Confirmed, so it may be a number.
        Some(v) => format!("+{} α / h", fmt_alpha(v)),
        // Not confirmed. An em dash, never a zero: a zero is a claim.
        None => "— α / h".into(),
    }
}

/// Gather what the pet draws. One read, pushed; the window never polls.
pub fn state(_app: &tauri::AppHandle) -> Value {
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
    // Left unset until there is a confirmed figure. `rate_line` draws an em
    // dash for it, and that is the intended reading.
    let alpha_ph: Option<f64> = None;

    let crews = crate::mcp::crew::all();
    let work = crate::mcp::crew_work::get();
    let owed: f64 = crate::mcp::crew_pay::credits()
        .iter()
        .filter(|c| c.settled_at.is_none())
        .map(|c| c.amount_base)
        .sum();

    let mut v = json!({
        "pfp": pfp,
        "crew_working": work.enabled && crews.iter().any(|c| c.role.grinds()),
        "crew_helped": crate::mcp::crew_work::helped_total(),
        "owed_base": owed,
        "alpha_per_hour": alpha_ph,
        "trouble": "",
        "at_ms": now_millis(),
    });
    // The pet reads exactly one thing: whether there is anything to say.
    match caption(&v) {
        Some(note) => {
            v["note"] = json!(note.text);
            v["tone"] = json!(note.tone);
            v["door"] = json!(note.door);
        }
        None => {
            v["note"] = Value::Null;
        }
    }
    v
}

/// Push the current state to the pet, if it is on screen.
pub fn push(app: &tauri::AppHandle) {
    // The menu bar is updated whether or not the pet is on screen: it is the
    // readout for people who never open the window.
    refresh_tray(app);
    refresh_tray_labels(app);
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

/// Put it away. The pet's own close control, and the Escape key.
///
/// A window that floats over everything MUST have a way out that does not
/// require finding another window first. `companion_toggle` needs somewhere to
/// be typed; this needs only the thing you are already looking at.
#[tauri::command]
pub fn companion_dismiss(app: tauri::AppHandle) -> Result<Value, String> {
    hide(&app);
    Ok(json!({ "open": false }))
}

/// Let the player move it.
///
/// `data-tauri-drag-region` cannot do this job here. Tauri's injected handler
/// tests `e.target.getAttribute('data-tauri-drag-region')` — the EXACT target,
/// with no walk up the tree — and the portrait's drag surface is a `<div>` full
/// of `<img>` layers, so the target is always one of the images and the
/// attribute is never found. The region was dead by construction: the window
/// was pinned to wherever it first opened.
///
/// Asking the window to drag itself works whatever the children are.
#[tauri::command]
pub fn companion_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn companion_state(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(state(&app))
}

/// The pet's doors open windows; it never acts itself.
#[tauri::command]
pub fn companion_open(app: tauri::AppHandle, what: String) -> Result<Value, String> {
    match what.as_str() {
        "board" => {
            crate::mcp::board_feed::open_board_window(app.clone())?;
        }
        "crew" | "crewpay" => {
            crate::mcp::terminal::open_terminal_card_new(app.clone(), what.clone(), Some(json!({})), None)?;
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
    let line1 = rate_line(state);
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
    let toggle_pet = MenuItem::with_id(app, "tray_pet", TRAY_SHOW, true, None::<&str>)
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
                // A menu item that still says "Show" after showing it is a
                // menu item nobody trusts to hide anything.
                refresh_tray_labels(app);
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    if let Ok(mut slot) = tray_slot().lock() {
        *slot = Some(tray);
    }
    if let Ok(mut slot) = pet_item_slot().lock() {
        *slot = Some(toggle_pet);
    }
    refresh_tray_labels(app);
    Ok(())
}

const TRAY_SHOW: &str = "Show the companion";
const TRAY_HIDE: &str = "Hide the companion";

static PET_ITEM: OnceLock<Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>> = OnceLock::new();

fn pet_item_slot() -> &'static Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>> {
    PET_ITEM.get_or_init(|| Mutex::new(None))
}

/// Make the menu say what the click will do.
pub fn refresh_tray_labels(app: &tauri::AppHandle) {
    let text = if is_open(app) { TRAY_HIDE } else { TRAY_SHOW };
    if let Ok(slot) = pet_item_slot().lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_text(text);
        }
    }
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

    /// The rule the whole window rests on. Everything the first version
    /// showed — a rate, a Goal/Work toggle, the player's own id — was true
    /// and none of it was worth interrupting anyone for.
    #[test]
    fn a_quiet_colony_says_nothing() {
        assert_eq!(caption(&json!({})), None);
        // A crew doing exactly what it was told to do is not news.
        assert_eq!(caption(&json!({ "crew_working": true, "crew_helped": 12 })), None);
        // Nor is a rate: that is the menu bar's job.
        assert_eq!(caption(&json!({ "alpha_per_hour": 95_000_000.0 })), None);
    }

    #[test]
    fn something_broken_gets_words() {
        let n = caption(&json!({ "trouble": "signing is wedged" })).unwrap();
        assert_eq!(n.text, "signing is wedged");
        assert_eq!(n.tone, "bad");
        assert_eq!(n.door, "board");
    }

    /// The one thing nothing else in the app nags about.
    #[test]
    fn an_unpaid_helper_gets_words() {
        let n = caption(&json!({ "owed_base": 900.0 })).unwrap();
        assert!(n.text.ends_with(" owed"), "{}", n.text);
        assert_eq!(n.tone, "");
        assert_eq!(n.door, "crewpay");
    }

    #[test]
    fn a_problem_outranks_a_debt() {
        let n = caption(&json!({ "trouble": "signing is wedged", "owed_base": 900.0 })).unwrap();
        assert_eq!(n.tone, "bad");
    }

    /// The menu bar keeps the continuous readout, and keeps the honesty rule
    /// with it: a figure this app has not confirmed is an em dash, never a
    /// zero. A zero is a claim.
    #[test]
    fn the_menu_bar_does_not_invent_a_rate() {
        assert!(tray_title(&json!({})).contains("\u{2014}"));
        assert!(!tray_title(&json!({})).contains('0'));
    }

    #[test]
    fn a_confirmed_rate_is_a_number_in_the_menu_bar() {
        let t = tray_title(&json!({ "alpha_per_hour": 95_000_000.0 }));
        assert!(t.contains('+') && t.contains("\u{3b1} / h"), "{t}");
    }

    /// The menu-bar line is the whole notification layer, so trouble and work
    /// have to be distinguishable at a glance.
    #[test]
    fn the_menu_bar_marks_trouble_and_work_differently() {
        let idle = tray_title(&json!({}));
        let working = tray_title(&json!({ "crew_working": true }));
        let bad = tray_title(&json!({ "trouble": "signing is wedged" }));
        assert!(!idle.contains('!') && !idle.contains('\u{2197}'), "{idle}");
        assert!(working.ends_with(" \u{b7} \u{2197}"), "{working}");
        assert!(bad.ends_with(" \u{b7} !"), "{bad}");
        assert_ne!(working, bad);
    }

    #[test]
    fn the_companion_is_off_until_it_is_opened() {
        assert!(!CompanionConfig::default().shown);
    }
}
