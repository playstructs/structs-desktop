//! One emit path for every event Rust sends to a window.
//!
//! Before this, 15 event names left 14 files through three different calls
//! (`emit`, `emit_to`, `emit_filter`) and the two event bugs on record were
//! both found by a person, not the app: the board window's listeners were
//! silently dead until a capability entry existed, and plain `listen()`
//! received other windows' `emit_to` (the doubled grass stream). Now:
//!
//! * every event is a variant of [`AppEvent`], with its name and its
//!   AUDIENCE (main window, the board family, one named window, or all)
//!   decided here, once;
//! * [`emit`] is the only function that talks to Tauri, applies the audience
//!   through the same per-window filter the board already used (so the
//!   cross-delivery rule lives in one place), and counts what it sent;
//! * every window announces what it listens for (`events_listening`, called
//!   by `frontend/events.js` after its listeners are registered), so
//!   `structs_system status` → `events` shows, per name, how many times it
//!   was emitted and which windows are listening. A name emitted with no
//!   listener anywhere is listed under `unheard` — the class of bug that used
//!   to be invisible.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use crate::hasher::types::now_millis;

/// Who an event is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Audience {
    /// The game window only.
    Main,
    /// The board family (board, stream, gamestats) plus web viewers.
    Board,
    /// Exactly one named window.
    Window(String),
    /// Every window.
    All,
}

/// Every event Rust sends. Names are the wire strings the windows listen
/// for and are pinned by a test; add a variant, never a bare string.
#[derive(Debug, Clone)]
pub enum AppEvent {
    HashProgress(Value),
    HashComplete(Value),
    /// Primary-player transaction request to the webview signer.
    TxRequest(Value),
    VplayerRequest(Value),
    TxqRequest(Value),
    ForceResync { hard: bool },
    TaskOverrides { max_concurrent: u64 },
    HashEnabled { enabled: bool },
    SyncTick,
    UpdateProgress(f64),
    UpdateReady,
    /// An agent UI directive; `main` decides which window draws it.
    UiDirective { main: bool, directive: Value },
    /// The board family's own events (`board-update`, `grass-event`, …).
    Board { name: &'static str, payload: Value },
    /// A raid window's events, namespaced by its label so two open raid
    /// windows cannot cross-deliver.
    Raid { label: String, name: &'static str, payload: Value },
    TransferIntent(Value),
    /// Comms keeps its `matrix::` namespace; it goes through the same path.
    Matrix { name: String, payload: Value },
}

impl AppEvent {
    pub fn name(&self) -> String {
        match self {
            Self::HashProgress(_) => "hash_progress".into(),
            Self::HashComplete(_) => "hash_complete".into(),
            Self::TxRequest(_) => "mcp_transaction_request".into(),
            Self::VplayerRequest(_) => "structs:vplayer-request".into(),
            Self::TxqRequest(_) => "structs:txq-request".into(),
            Self::ForceResync { .. } => "structs:force-resync".into(),
            Self::TaskOverrides { .. } => "structs:task-overrides".into(),
            Self::HashEnabled { .. } => "structs:hash-enabled".into(),
            Self::SyncTick => "structs://sync-tick".into(),
            Self::UpdateProgress(_) => "structs://update-progress".into(),
            Self::UpdateReady => "structs://update-ready".into(),
            Self::UiDirective { .. } => "mcp_ui_directive".into(),
            Self::Board { name, .. } => (*name).into(),
            Self::Raid { label, name, .. } => format!("{name}::{label}"),
            Self::TransferIntent(_) => "transfer-intent".into(),
            Self::Matrix { name, .. } => name.clone(),
        }
    }

    pub fn audience(&self) -> Audience {
        match self {
            Self::HashProgress(_)
            | Self::HashComplete(_)
            | Self::TxRequest(_)
            | Self::VplayerRequest(_)
            | Self::TxqRequest(_)
            | Self::ForceResync { .. }
            | Self::TaskOverrides { .. }
            | Self::HashEnabled { .. }
            | Self::SyncTick
            | Self::UpdateProgress(_)
            | Self::UpdateReady => Audience::Main,
            Self::UiDirective { main: true, .. } => Audience::Main,
            Self::UiDirective { main: false, .. } | Self::Board { .. } => Audience::Board,
            Self::Raid { label, .. } => Audience::Window(label.clone()),
            Self::TransferIntent(_) => Audience::Window("transfer".into()),
            Self::Matrix { .. } => Audience::All,
        }
    }

    pub fn payload(&self) -> Value {
        match self {
            Self::HashProgress(v) | Self::HashComplete(v) | Self::TxRequest(v) | Self::VplayerRequest(v)
            | Self::TxqRequest(v) | Self::TransferIntent(v) => v.clone(),
            Self::ForceResync { hard } => json!({ "hard": hard }),
            Self::TaskOverrides { max_concurrent } => json!({ "maxConcurrent": max_concurrent }),
            Self::HashEnabled { enabled } => json!({ "enabled": enabled }),
            Self::SyncTick | Self::UpdateReady => Value::Null,
            Self::UpdateProgress(p) => json!(p),
            Self::UiDirective { directive, .. } => directive.clone(),
            Self::Board { payload, .. } | Self::Raid { payload, .. } | Self::Matrix { payload, .. } => payload.clone(),
        }
    }
}

/// name → (times emitted, last emitted ms)
static EMITTED: LazyLock<Mutex<HashMap<String, (u64, f64)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// window label → names it announced listeners for
static LISTENING: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Count an emission under `name`. `web_board::emit_board` calls this for
/// the board family so its twenty callers need not change.
pub fn record(name: &str) {
    if let Ok(mut m) = EMITTED.lock() {
        let e = m.entry(name.to_string()).or_insert((0, 0.0));
        e.0 += 1;
        e.1 = now_millis();
    }
}

/// The only function that hands an event to Tauri.
pub fn emit(app: &AppHandle, event: AppEvent) -> Result<(), String> {
    let name = event.name();
    let payload = event.payload();
    let res = match event.audience() {
        Audience::Board => {
            // emit_board records the name itself.
            crate::mcp::web_board::emit_board(app, &name, payload);
            return Ok(());
        }
        Audience::Main => app.emit_to("main", &name, payload),
        Audience::Window(label) => {
            if app.get_webview_window(&label).is_none() {
                return Ok(()); // a closed window hears nothing; not an error
            }
            app.emit_to(label.as_str(), &name, payload)
        }
        Audience::All => app.emit(&name, payload),
    };
    record(&name);
    res.map_err(|e| format!("emit {name}: {e}"))
}

/// Comms events: `matrix::<name>` to every window, through the same path.
pub fn emit_matrix<S: serde::Serialize>(app: &AppHandle, name: &str, payload: S) -> Result<(), String> {
    let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
    emit(app, AppEvent::Matrix { name: name.to_string(), payload })
}

/// A window says what it listens for (from `frontend/events.js`, after its
/// listeners are registered; re-sent when it registers more).
#[tauri::command]
pub fn events_listening(window: tauri::Window, names: Vec<String>) {
    note_listening(window.label(), names);
}

pub fn note_listening(label: &str, names: Vec<String>) {
    if let Ok(mut m) = LISTENING.lock() {
        let entry = m.entry(label.to_string()).or_default();
        for n in names {
            if !entry.contains(&n) {
                entry.push(n);
            }
        }
    }
}

/// For `structs_system status`: every name emitted or listened for, who
/// listens, and the names that were emitted with no listener anywhere.
pub fn table() -> Value {
    let now = now_millis();
    let emitted = EMITTED.lock().map(|m| m.clone()).unwrap_or_default();
    let listening = LISTENING.lock().map(|m| m.clone()).unwrap_or_default();
    let mut names: Vec<String> = emitted.keys().cloned().collect();
    for ns in listening.values() {
        for n in ns {
            if !names.contains(n) {
                names.push(n.clone());
            }
        }
    }
    names.sort();
    let mut rows = Vec::new();
    let mut unheard = Vec::new();
    for n in names {
        let (count, last) = emitted.get(&n).copied().unwrap_or((0, 0.0));
        let mut listeners: Vec<&String> = listening.iter().filter(|(_, ns)| ns.contains(&n)).map(|(l, _)| l).collect();
        listeners.sort();
        if count > 0 && listeners.is_empty() {
            unheard.push(n.clone());
        }
        rows.push(json!({
            "name": n,
            "emitted": count,
            "last_age_s": if last > 0.0 { json!(((now - last) / 1000.0).round()) } else { Value::Null },
            "listeners": listeners,
        }));
    }
    json!({ "events": rows, "unheard": unheard, "windows": listening.keys().collect::<Vec<_>>() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire names every window listens for. Changing one is a
    /// frontend change; this test is where that shows up.
    #[test]
    fn event_names_are_the_wire_strings_the_windows_listen_for() {
        let pins: Vec<(AppEvent, &str)> = vec![
            (AppEvent::HashProgress(Value::Null), "hash_progress"),
            (AppEvent::HashComplete(Value::Null), "hash_complete"),
            (AppEvent::TxRequest(Value::Null), "mcp_transaction_request"),
            (AppEvent::VplayerRequest(Value::Null), "structs:vplayer-request"),
            (AppEvent::TxqRequest(Value::Null), "structs:txq-request"),
            (AppEvent::ForceResync { hard: true }, "structs:force-resync"),
            (AppEvent::TaskOverrides { max_concurrent: 3 }, "structs:task-overrides"),
            (AppEvent::HashEnabled { enabled: false }, "structs:hash-enabled"),
            (AppEvent::SyncTick, "structs://sync-tick"),
            (AppEvent::UpdateProgress(1.0), "structs://update-progress"),
            (AppEvent::UpdateReady, "structs://update-ready"),
            (AppEvent::UiDirective { main: true, directive: Value::Null }, "mcp_ui_directive"),
            (AppEvent::Board { name: "board-update", payload: Value::Null }, "board-update"),
            (AppEvent::Raid { label: "raid-2-1".into(), name: "raid:attack", payload: Value::Null }, "raid:attack::raid-2-1"),
            (AppEvent::TransferIntent(Value::Null), "transfer-intent"),
            (AppEvent::Matrix { name: "matrix::rooms".into(), payload: Value::Null }, "matrix::rooms"),
        ];
        for (ev, name) in &pins {
            assert_eq!(ev.name(), *name);
        }
        let mut names: Vec<String> = pins.iter().map(|(e, _)| e.name()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), pins.len(), "every variant has its own name");
    }

    #[test]
    fn audiences_keep_directives_and_raids_off_the_wrong_windows() {
        assert_eq!(AppEvent::UiDirective { main: true, directive: Value::Null }.audience(), Audience::Main);
        assert_eq!(AppEvent::UiDirective { main: false, directive: Value::Null }.audience(), Audience::Board);
        assert_eq!(AppEvent::Raid { label: "raid-2-9".into(), name: "raid:state", payload: Value::Null }.audience(), Audience::Window("raid-2-9".into()));
        assert_eq!(AppEvent::TransferIntent(Value::Null).audience(), Audience::Window("transfer".into()));
        assert_eq!(AppEvent::TxRequest(Value::Null).audience(), Audience::Main);
        assert_eq!(AppEvent::Matrix { name: "matrix::seen".into(), payload: Value::Null }.audience(), Audience::All);
        assert_eq!(AppEvent::TaskOverrides { max_concurrent: 4 }.payload(), json!({ "maxConcurrent": 4 }));
    }

    #[test]
    fn the_table_names_what_nobody_hears() {
        record("test:only-emitted");
        record("test:only-emitted");
        record("test:heard");
        note_listening("test-window", vec!["test:heard".into(), "test:only-listened".into()]);
        let t = table();
        let rows = t["events"].as_array().unwrap();
        let row = |n: &str| rows.iter().find(|r| r["name"] == n).cloned().unwrap();
        assert_eq!(row("test:only-emitted")["emitted"], 2);
        assert!(row("test:only-emitted")["listeners"].as_array().unwrap().is_empty());
        assert_eq!(row("test:heard")["listeners"][0], "test-window");
        assert_eq!(row("test:only-listened")["emitted"], 0);
        let unheard: Vec<&str> = t["unheard"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(unheard.contains(&"test:only-emitted"));
        assert!(!unheard.contains(&"test:heard"));
        assert!(!unheard.contains(&"test:only-listened"), "never emitted is not unheard");
    }
}
