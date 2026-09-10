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
    /// How much room the card may take: `short` | `medium` | `tall` | `grow`.
    /// None means the type's own default. A cap, not a floor — a card with
    /// less to say still takes only what it needs; `grow` lifts the cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<String>,
    /// A name the player gave the card; None means the type's own title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Refresh cadence in seconds the player chose; None means the type's
    /// default, 0 means paused (refresh by hand only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<u64>,
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

/// Every workspace by name, and which one the main window shows. A
/// workspace is a whole page of cards; each can also be a window of its own.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Store {
    #[serde(default)]
    pub workspaces: std::collections::BTreeMap<String, Layout>,
    #[serde(default = "main")]
    pub active: String,
    /// The strip's order as the player arranged it. Names not listed here
    /// (new ones) follow, alphabetically; names listed but gone are skipped.
    #[serde(default)]
    pub order: Vec<String>,
}
fn main() -> String {
    "main".into()
}
impl Default for Store {
    fn default() -> Self {
        Store { workspaces: Default::default(), active: main(), order: Vec::new() }
    }
}

/// The first Terminal saved one layout at the top level (`{cards, version}`);
/// it becomes the `main` workspace. Never a silent reset of a page someone
/// arranged.
fn load_store() -> Store {
    let Some(raw) = crate::mcp::config_store::config_path(LAYOUT_FILE).and_then(|p| std::fs::read_to_string(p).ok()) else {
        return Store::default();
    };
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        if v.get("cards").is_some() && v.get("workspaces").is_none() {
            if let Ok(l) = serde_json::from_value::<Layout>(v) {
                let mut st = Store::default();
                st.workspaces.insert(main(), l);
                return st;
            }
        }
    }
    crate::mcp::config_store::load_config(LAYOUT_FILE)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Windows {
    #[serde(default)]
    open: bool,
    /// Workspaces that had their own window at quit.
    #[serde(default)]
    workspaces: Vec<String>,
    /// Cards that had their own window at quit, as `workspace/card`.
    #[serde(default)]
    cards: Vec<String>,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(load_store()));
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

/// A card id or a workspace name is written into a window label and a URL:
/// letters, digits, dashes and underscores only, bounded.
pub fn sane_card_id(id: &str) -> Option<String> {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect();
    if s.is_empty() || s != id {
        None
    } else {
        Some(s)
    }
}

// Under `cargo test` the store and the windows list are in-memory only:
// the tests exercise the real STORE, and a save from a test once wrote
// order-test-* and rename-test-* workspaces into the player's terminal.json
// (and three remembered windows for one of them) — seen live 2026-09-07.
fn save_store(st: &Store) {
    if cfg!(test) {
        return;
    }
    crate::mcp::config_store::save_config(LAYOUT_FILE, st);
}

// ── Layout ──────────────────────────────────────────────────────────────────

/// One workspace's layout (the active one when unnamed). A name that has no
/// layout yet answers an empty one — the page then lays out its default.
#[tauri::command]
pub fn terminal_layout_get(workspace: Option<String>) -> Layout {
    let st = lock(&STORE);
    let name = workspace.unwrap_or_else(|| st.active.clone());
    st.workspaces.get(&name).cloned().unwrap_or_default()
}

/// Replace one workspace's layout. The page is the authority on shape; this
/// only refuses what cannot be a card at all (an id that would not survive a
/// URL) and names that would not survive a window label.
///
/// Two windows can show one workspace (the main Terminal and a workspace
/// window, or the native window and the web copy). Each carries its own
/// copy and bumps `version` on save, so a save whose version is not newer
/// than the stored one is a stale copy writing over someone else's
/// arrangement: it is refused with [`STALE_LAYOUT`], and the page reloads.
/// Every accepted save is announced to the board family as
/// `terminal-layout` so the other windows catch up at once.
#[tauri::command]
pub fn terminal_layout_set(app: tauri::AppHandle, workspace: Option<String>, layout: Layout) -> Result<Layout, String> {
    let (name, saved) = layout_set_impl(workspace, layout)?;
    let _ = crate::mcp::events::emit(
        &app,
        crate::mcp::events::AppEvent::Board {
            name: "terminal-layout",
            payload: json!({ "workspace": name, "version": saved.version }),
        },
    );
    Ok(saved)
}

/// The error a stale save gets; the page matches on this text.
pub const STALE_LAYOUT: &str = "stale layout";

pub fn layout_set_impl(workspace: Option<String>, layout: Layout) -> Result<(String, Layout), String> {
    for c in &layout.cards {
        if sane_card_id(&c.id).is_none() {
            return Err(format!("card id {:?} is not a plain id", c.id));
        }
        if c.kind.is_empty() {
            return Err(format!("card {} has no type", c.id));
        }
    }
    let mut st = lock(&STORE);
    let name = match workspace {
        Some(n) => sane_card_id(&n).ok_or_else(|| format!("workspace {n:?} is not a plain name"))?,
        None => st.active.clone(),
    };
    if let Some(have) = st.workspaces.get(&name) {
        if !have.cards.is_empty() && layout.version <= have.version {
            return Err(format!(
                "{STALE_LAYOUT}: {name} is at version {} and this save is version {}",
                have.version, layout.version
            ));
        }
    }
    st.workspaces.insert(name.clone(), layout);
    save_store(&st);
    Ok((name.clone(), st.workspaces[&name].clone()))
}

/// A workspace change (activate, delete, rename, order) told to every board
/// window as `terminal-workspaces`, so a window still showing a workspace
/// that is gone switches away instead of saving it back into existence.
fn announce(app: &tauri::AppHandle, list: Value) -> Result<Value, String> {
    let _ = crate::mcp::events::emit(
        app,
        crate::mcp::events::AppEvent::Board { name: "terminal-workspaces", payload: list.clone() },
    );
    Ok(list)
}

/// Every workspace by name, and the active one.
#[tauri::command]
pub fn terminal_workspaces() -> Value {
    let st = lock(&STORE);
    let names = ordered_names(&st);
    json!({ "active": st.active, "names": names })
}

/// The workspaces in the player's order, then any the order does not name.
fn ordered_names(st: &Store) -> Vec<String> {
    let mut names: Vec<String> = st.order.iter().filter(|n| st.workspaces.contains_key(*n)).cloned().collect();
    for n in st.workspaces.keys() {
        if !names.contains(n) {
            names.push(n.clone());
        }
    }
    if names.is_empty() {
        names.push(st.active.clone());
    }
    names
}

/// Arrange the strip. Unknown names are ignored, missing ones keep their
/// place after the ones given, so a partial list is still a valid order.
#[tauri::command]
pub fn terminal_workspace_order(app: tauri::AppHandle, names: Vec<String>) -> Result<Value, String> {
    announce(&app, workspace_order_impl(names)?)
}
pub fn workspace_order_impl(names: Vec<String>) -> Result<Value, String> {
    let mut st = lock(&STORE);
    let mut order: Vec<String> = Vec::new();
    for n in names {
        if st.workspaces.contains_key(&n) && !order.contains(&n) {
            order.push(n);
        }
    }
    st.order = order;
    save_store(&st);
    drop(st);
    Ok(terminal_workspaces())
}

/// Make a workspace the one the main window shows.
#[tauri::command]
pub fn terminal_workspace_activate(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    announce(&app, workspace_activate_impl(name)?)
}
pub fn workspace_activate_impl(name: String) -> Result<Value, String> {
    let name = sane_card_id(&name).ok_or_else(|| format!("workspace {name:?} is not a plain name"))?;
    let mut st = lock(&STORE);
    st.active = name;
    save_store(&st);
    drop(st);
    Ok(terminal_workspaces())
}

/// Forget a workspace. The last one cannot go; `main` is recreated empty.
#[tauri::command]
pub fn terminal_workspace_delete(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    announce(&app, workspace_delete_impl(name)?)
}
pub fn workspace_delete_impl(name: String) -> Result<Value, String> {
    let mut st = lock(&STORE);
    if st.workspaces.len() <= 1 {
        return Err("the last workspace stays".into());
    }
    st.workspaces.remove(&name);
    st.order.retain(|n| n != &name);
    if st.active == name {
        st.active = ordered_names(&st).into_iter().next().unwrap_or_else(main);
    }
    save_store(&st);
    drop(st);
    forget_windows_of(&name, None);
    Ok(terminal_workspaces())
}

/// Give a workspace a new name. Its layout, its place as the active one and
/// its remembered windows all follow; the old name is gone. Refused when the
/// new name is taken, so nothing is overwritten by a typo.
#[tauri::command]
pub fn terminal_workspace_rename(app: tauri::AppHandle, from: String, to: String) -> Result<Value, String> {
    announce(&app, workspace_rename_impl(from, to)?)
}
pub fn workspace_rename_impl(from: String, to: String) -> Result<Value, String> {
    let to = sane_card_id(&to).ok_or_else(|| format!("workspace {to:?} is not a plain name"))?;
    if to == from {
        return Ok(terminal_workspaces());
    }
    let mut st = lock(&STORE);
    if st.workspaces.contains_key(&to) {
        return Err(format!("a workspace named {to} already exists"));
    }
    let layout = st.workspaces.remove(&from).ok_or_else(|| format!("no workspace named {from}"))?;
    st.workspaces.insert(to.clone(), layout);
    for n in st.order.iter_mut() {
        if *n == from {
            *n = to.clone();
        }
    }
    if st.active == from {
        st.active = to.clone();
    }
    save_store(&st);
    drop(st);
    forget_windows_of(&from, Some(&to));
    Ok(terminal_workspaces())
}

/// Drop (or, with `rename_to`, re-key) the remembered windows of a workspace,
/// so a deleted workspace does not reopen at boot and a renamed one reopens
/// under its new name.
fn forget_windows_of(name: &str, rename_to: Option<&str>) {
    let mut ws = lock(&WINDOWS);
    let prefix = format!("{name}/");
    match rename_to {
        Some(to) => {
            for n in ws.workspaces.iter_mut() {
                if n == name {
                    *n = to.to_string();
                }
            }
            for c in ws.cards.iter_mut() {
                if let Some(rest) = c.strip_prefix(&prefix) {
                    *c = format!("{to}/{rest}");
                }
            }
        }
        None => {
            ws.workspaces.retain(|n| n != name);
            ws.cards.retain(|c| !c.starts_with(&prefix));
        }
    }
    save_windows(&ws);
}

/// Close the native windows of a workspace (its own window and every popped
/// card) — after a delete, or before a rename re-labels them.
#[tauri::command]
pub fn terminal_workspace_windows_close(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    let name = sane_card_id(&name).ok_or_else(|| format!("workspace {name:?} is not a plain name"))?;
    let ws_label = format!("{CARD_LABEL_PREFIX}ws-{name}");
    let card_prefix = format!("{CARD_LABEL_PREFIX}card-{name}-");
    let mut closed = 0;
    for (label, w) in app.webview_windows() {
        if label == ws_label || label.starts_with(&card_prefix) {
            let _ = w.close();
            closed += 1;
        }
    }
    Ok(json!({ "closed": closed }))
}

// ── Windows ─────────────────────────────────────────────────────────────────

fn save_windows(w: &Windows) {
    if cfg!(test) {
        return;
    }
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

fn spine(app: &tauri::AppHandle) {
    // The board's data spine (roster sweeps, background refresh) serves the
    // terminal's cards too — and so does the Game Stats engine, whose sweep
    // loop only ever started from the Game Stats window's own door. With a
    // Terminal open and that window closed the liveness, universe and raid
    // cards sat on dashes for good (0.1.354). `watched()` already counts a
    // Terminal window; this is the start it was waiting for.
    crate::mcp::roster_cache::trigger_sweep(app.clone(), 60_000.0);
    crate::mcp::roster_cache::ensure_background_refresh(app.clone());
    crate::mcp::game_stats::ensure_running(app);
}

/// Open (or raise) the Terminal on the active workspace. Remembers that it is
/// open so it comes back on the next launch; a user close forgets it, an app
/// quit does not.
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
    spine(&app);
    focus(&w);
    Ok(())
}

/// A workspace as a window of its own — the framework is not one window.
#[tauri::command]
pub fn open_terminal_workspace(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let name = sane_card_id(&name).ok_or_else(|| format!("workspace {name:?} is not a plain name"))?;
    let label = format!("{CARD_LABEL_PREFIX}ws-{name}");
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
        return Ok(());
    }
    let w = build(&app, &label, &format!("board.html?view=terminal&ws={name}"), &format!("Structs — {name}"), (1180.0, 860.0))?;
    let forget = name.clone();
    w.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) && !APP_QUITTING.load(Ordering::SeqCst) {
            let mut ws = lock(&WINDOWS);
            ws.workspaces.retain(|n| n != &forget);
            save_windows(&ws);
        }
    });
    {
        let mut ws = lock(&WINDOWS);
        if !ws.workspaces.contains(&name) {
            ws.workspaces.push(name.clone());
        }
        save_windows(&ws);
    }
    spine(&app);
    focus(&w);
    Ok(())
}

/// Pop one card out into its own window. The window shows the same card,
/// full-size, from the same workspace; it is remembered and reopened at boot.
#[tauri::command]
pub fn open_terminal_card(app: tauri::AppHandle, workspace: Option<String>, card_id: String, title: Option<String>) -> Result<(), String> {
    let id = sane_card_id(&card_id).ok_or_else(|| format!("card id {card_id:?} is not a plain id"))?;
    let ws_name = match workspace {
        Some(n) => sane_card_id(&n).ok_or_else(|| format!("workspace {n:?} is not a plain name"))?,
        None => lock(&STORE).active.clone(),
    };
    let label = format!("{CARD_LABEL_PREFIX}card-{ws_name}-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
        return Ok(());
    }
    // The page names the card the way it names it on screen ("Energy
    // market", "Player 1-61"); the type name is the fallback for a boot-time
    // reopen, which has no page yet.
    let title = title
        .map(|t| t.chars().filter(|c| !c.is_control()).take(60).collect::<String>())
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            lock(&STORE)
                .workspaces
                .get(&ws_name)
                .and_then(|l| l.cards.iter().find(|c| c.id == id))
                .map(|c| c.kind.clone())
        })
        .map(|t| format!("Structs — {t}"))
        .unwrap_or_else(|| "Structs — Terminal card".into());
    let w = build(&app, &label, &format!("board.html?view=terminal&ws={ws_name}&card={id}"), &title, (640.0, 620.0))?;
    let key = format!("{ws_name}/{id}");
    let forget = key.clone();
    w.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) && !APP_QUITTING.load(Ordering::SeqCst) {
            let mut ws = lock(&WINDOWS);
            ws.cards.retain(|c| c != &forget);
            save_windows(&ws);
        }
    });
    {
        let mut ws = lock(&WINDOWS);
        if !ws.cards.contains(&key) {
            ws.cards.push(key);
        }
        save_windows(&ws);
    }
    spine(&app);
    focus(&w);
    Ok(())
}

/// Create ONE card and open it in its own window.
///
/// The Terminal's own palette adds a card to the page it is standing on. The
/// GAME window's palette has no page to stand on — there may be no Terminal
/// open at all — so what it asks for is the card and a window to put it in.
///
/// The card is appended to a real workspace rather than conjured for the
/// window alone, so it behaves like every other popped-out card: it is in the
/// layout, an open Terminal sees it appear, and it comes back at the next
/// launch. A palette pick is a card you made, not a dialog that evaporates.
///
/// `params` is the card type's own business and is stored verbatim, exactly as
/// `terminal_layout_set` stores it — Rust does not know the card types.
#[tauri::command]
pub fn open_terminal_card_new(
    app: tauri::AppHandle,
    kind: String,
    params: Option<Value>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let kind = kind.trim().to_string();
    if kind.is_empty() {
        return Err("no card type given".into());
    }
    // The type becomes part of the card id, so it has to survive `sane_card_id`
    // before it is used to build one.
    if sane_card_id(&kind).is_none() {
        return Err(format!("card type {kind:?} is not a plain name"));
    }
    let params = params.unwrap_or_else(|| json!({}));
    /* FOCUS-OR-OPEN.
     *
     * Every pick minted a fresh card and built a fresh window, so clicking
     * `2-15361` in three messages over one conversation left you owning three
     * planet windows. A chip is a door to a THING, and a thing already on
     * screen wants focusing, not duplicating. So: the same kind about the same
     * id, already in this workspace, is the card we open — and
     * `open_terminal_card` already raises the window when one exists. */
    if let Some(existing) = same_card(workspace.as_deref(), &kind, &params) {
        let (ws_name, id) = existing;
        open_terminal_card(app, Some(ws_name.clone()), id.clone(), None)?;
        return Ok(json!({ "workspace": ws_name, "card_id": id, "type": kind, "focused": true }));
    }
    let (ws_name, id, version) = append_card(workspace, &kind, params)?;
    // An open Terminal is showing this workspace; tell it, or it saves the card
    // back out of existence on its next write.
    let _ = crate::mcp::events::emit(
        &app,
        crate::mcp::events::AppEvent::Board {
            name: "terminal-layout",
            payload: json!({ "workspace": ws_name, "version": version }),
        },
    );
    open_terminal_card(app, Some(ws_name.clone()), id.clone(), None)?;
    Ok(json!({ "workspace": ws_name, "card_id": id, "type": kind }))
}

/// A card of this kind about this id, if the workspace already holds one.
///
/// "About this id" is `params.id` — the one parameter every object card and
/// every Comms card keys on. A card with NO id (a room list, the feed) is a
/// singleton by kind alone. Pure, so it is testable without a window.
fn same_card(workspace: Option<&str>, kind: &str, params: &Value) -> Option<(String, String)> {
    let st = lock(&STORE);
    let name = match workspace {
        Some(n) => sane_card_id(n)?,
        None => st.active.clone(),
    };
    let layout = st.workspaces.get(&name)?;
    let want = params.get("id").and_then(|v| v.as_str());
    layout
        .cards
        .iter()
        .find(|c| c.kind == kind && c.params.get("id").and_then(|v| v.as_str()) == want)
        .map(|c| (name.clone(), c.id.clone()))
}

/// Append one card to a workspace, minting a free id for it.
///
/// Split out from the command so the part with the rules in it — id minting,
/// workspace resolution, the version bump — is testable without an AppHandle
/// or a window. Returns `(workspace, card id, new version)`.
///
/// The STORE lock is released before the caller builds a window:
/// `open_terminal_card` reads the STORE itself to title the window, and
/// holding it across that call would deadlock on a slow build.
fn append_card(workspace: Option<String>, kind: &str, params: Value) -> Result<(String, String, u64), String> {
    let mut st = lock(&STORE);
    let name = match workspace {
        Some(n) => sane_card_id(&n).ok_or_else(|| format!("workspace {n:?} is not a plain name"))?,
        None => st.active.clone(),
    };
    let layout = st.workspaces.entry(name.clone()).or_insert_with(|| Layout { cards: vec![], version: 0 });
    // `<kind>-N`, the same shape the page mints, and free in this workspace.
    let mut n = 1;
    let id = loop {
        let candidate = format!("{kind}-{n}");
        if !layout.cards.iter().any(|c| c.id == candidate) {
            break candidate;
        }
        n += 1;
    };
    layout.cards.push(Card {
        id: id.clone(),
        kind: kind.to_string(),
        params,
        w: 1,
        h: None,
        title: None,
        cadence: None,
    });
    layout.version += 1;
    let version = layout.version;
    save_store(&st);
    Ok((name, id, version))
}

/// Which terminal windows are open right now.
#[tauri::command]
pub fn terminal_windows(app: tauri::AppHandle) -> Value {
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    let workspaces: Vec<String> = labels.iter().filter_map(|l| l.strip_prefix(&format!("{CARD_LABEL_PREFIX}ws-")).map(String::from)).collect();
    let cards: Vec<String> = labels.iter().filter_map(|l| l.strip_prefix(&format!("{CARD_LABEL_PREFIX}card-")).map(String::from)).collect();
    json!({ "open": app.get_webview_window(LABEL).is_some(), "workspaces": workspaces, "cards": cards })
}

/// At boot: bring back the Terminal, every workspace window and every
/// popped-out card that was open at the last quit. Only ever windows the
/// player chose to have open.
pub fn reopen_if_persisted(app: &tauri::AppHandle) {
    let ws = lock(&WINDOWS).clone();
    if ws.open {
        match open_terminal_window(app.clone()) {
            Ok(()) => eprintln!("[Terminal] reopened (was open at last exit)"),
            Err(e) => eprintln!("[Terminal] couldn't reopen: {e}"),
        }
    }
    for name in ws.workspaces {
        if let Err(e) = open_terminal_workspace(app.clone(), name.clone()) {
            eprintln!("[Terminal] couldn't reopen workspace {name}: {e}");
        }
    }
    for key in ws.cards {
        let (w, id) = key.split_once('/').unwrap_or(("main", key.as_str()));
        if let Err(e) = open_terminal_card(app.clone(), Some(w.to_string()), id.to_string(), None) {
            eprintln!("[Terminal] couldn't reopen card {key}: {e}");
        }
    }
}

// ── The energy market ───────────────────────────────────────────────────────

/// Blocks in a day, from the measured block time the hasher already uses.
pub const BLOCKS_PER_DAY: f64 = 86_400_000.0 / crate::hasher::difficulty::ESTIMATED_BLOCK_TIME_MS;

/// One offer's price, restated so it can be compared with any other.
///
/// Returns `(ualpha per mW per block, alpha per kW per day)`, or `None` when
/// the denom has no price we can read — never a guess. An unpriced offer sorts
/// last and says so; quoting an unknown token at par would put a fictional
/// bargain at the top of the board.
///
/// The two 1e6 factors — milliwatts per kilowatt, and ualpha per alpha —
/// cancel, which is why the day rate is a single multiply by the block count.
pub fn comparable_price(
    rate_amount: f64,
    denom: &str,
    fx: &std::collections::HashMap<String, f64>,
) -> Option<(f64, f64)> {
    let ualpha = if denom == "ualpha" { Some(rate_amount) } else { fx.get(denom).map(|r| rate_amount * r) }?;
    Some((ualpha, ualpha * BLOCKS_PER_DAY))
}

/// What one base unit of each denom is worth in `ualpha`.
///
/// `ualpha` is 1 by definition. A guild token is worth its bank's collateral
/// ratio — the same figure the Guild banks card prints as "alpha per token" —
/// which is what makes offers priced in different guilds' tokens comparable at
/// all. A guild whose bank cannot be read is simply absent: an offer in its
/// token then has no price, and says so, rather than being quoted at par.
async fn denom_fx() -> std::collections::HashMap<String, f64> {
    let mut out = std::collections::HashMap::new();
    out.insert("ualpha".to_string(), 1.0);
    if let Ok(v) = terminal_guild_banks().await {
        for b in v.get("banks").and_then(|b| b.as_array()).cloned().unwrap_or_default() {
            let denom = b.get("denom").and_then(|d| d.as_str()).unwrap_or("");
            let ratio = b.get("ratio").and_then(|r| r.as_f64());
            if let (false, Some(r)) = (denom.is_empty(), ratio) {
                if r > 0.0 {
                    out.insert(denom.to_string(), r);
                }
            }
        }
    }
    out
}


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
    /* ── One price, so the board can be read down ─────────────────────────
     *
     * Offers are quoted in whatever the seller likes: `ualpha`, or any guild's
     * own token. "1 ack" beside "3 ohm" is not a comparison, and until now the
     * board gave up on it — alpha-priced offers led and everything else kept
     * its chain order behind them, which is not an ordering at all.
     *
     * A guild token has a price: its bank's collateral ratio, ualpha per token,
     * which `terminal_guild_banks` already reads. That is the FX rate, so every
     * offer can be restated in one unit and the cheapest capacity in the galaxy
     * is the top row whoever is selling it.
     *
     * The unit is ALPHA PER KILOWATT PER DAY. The chain charges
     * `duration × capacity × rate` (agreement_cache.go, msg_server_agreement_
     * open.go) with capacity in MILLIWATTS — so the raw rate is per mW per
     * block, and a rate of 1 ualpha/mW/block is 1e6 mW/kW × blocks-per-day ÷
     * 1e6 ualpha/alpha = one day of a kilowatt for `blocks_per_day` alpha. The
     * two factors of 1e6 cancel, which is why this reads as a single multiply.
     */
    let fx = denom_fx().await;
    for p in providers.iter_mut() {
        let (amount, denom) = {
            let pr = p.get("provider");
            (
                pr.and_then(|x| x.get("rate_amount")).and_then(|a| a.as_f64()).unwrap_or(0.0),
                pr.and_then(|x| x.get("rate_denom")).and_then(|d| d.as_str()).unwrap_or("").to_string(),
            )
        };
        let q = comparable_price(amount, &denom, &fx);
        if let Some(pr) = p.get_mut("provider").and_then(|x| x.as_object_mut()) {
            pr.insert("rate_ualpha_per_mw_block".into(), json!(q.map(|x| x.0)));
            pr.insert("alpha_per_kw_day".into(), json!(q.map(|x| x.1)));
            pr.insert("fx_source".into(), json!(if denom == "ualpha" { "alpha" } else if q.is_some() { "guild bank" } else { "unpriced" }));
        }
    }
    let priced = |v: &Value| v.get("provider").and_then(|p| p.get("alpha_per_kw_day")).and_then(|x| x.as_f64());
    providers.sort_by(|a, b| match (priced(a), priced(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    // The board's own summary: what it costs to buy, and how much there is.
    let mut prices: Vec<f64> = providers.iter().filter_map(priced).collect();
    prices.sort_by(f64::total_cmp);
    let open_capacity: f64 = providers
        .iter()
        .filter(|p| p.get("provider").and_then(|x| x.get("open")).and_then(|o| o.as_bool()).unwrap_or(false))
        .filter_map(|p| p.get("provider").and_then(|x| x.get("capacity_max")).and_then(|c| c.as_f64()))
        .sum();
    let out = json!({
        "at_ms": now,
        "height": crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0),
        "providers": providers,
        "best_alpha_per_kw_day": prices.first(),
        "median_alpha_per_kw_day": if prices.is_empty() { None } else { Some(prices[prices.len() / 2]) },
        "priced": prices.len(),
        "unpriced": providers.len() - prices.len(),
        "open_capacity_mw": open_capacity,
    });
    // The chart's market history is this reading, sampled at most every five minutes.
    crate::mcp::charts::note_market(&out);
    *lock(&CACHE) = (now, out.clone());
    Ok(out)
}

// ── Ore radar ───────────────────────────────────────────────────────────────

/// Where the ore is: every planet in the snapshot with ore left, richest
/// first, with its owner named and its shield read. Raiders and miners both
/// read this; no network — the perception cache holds all of it.
#[tauri::command]
pub fn terminal_ore_radar(limit: Option<usize>) -> Value {
    let limit = limit.unwrap_or(40).clamp(1, 200);
    let rows = crate::mcp::perception::with_snapshot(|s| {
        let mut out: Vec<(u64, String, String, u64)> = s
            .planets
            .iter()
            .filter_map(|(pid, row)| {
                let ore = s.grid_attr(pid, "ore").filter(|o| *o > 0)?;
                let owner = row.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let shield = s.planet_attr(pid, "planetaryShield").unwrap_or(0);
                Some((ore, pid.clone(), owner, shield))
            })
            .collect();
        out.sort_by(|a, b| b.0.cmp(&a.0));
        let total_with_ore = out.len();
        out.truncate(limit);
        (out, total_with_ore, s.height)
    });
    let Some((rows, total_with_ore, height)) = rows else {
        return json!({ "planets": [], "planets_with_ore": 0, "height": 0 });
    };
    let planets: Vec<Value> = rows
        .into_iter()
        .map(|(ore, pid, owner, shield)| {
            let ident = crate::mcp::game_stats::identity(&owner);
            let get = |k: &str| ident.as_ref().and_then(|i| i.get(k)).cloned().unwrap_or(Value::Null);
            json!({
                "planet_id": pid, "ore": ore, "shield": shield, "owner": owner,
                "owner_name": get("username"), "owner_pfp": get("pfp_attrs"), "owner_tag": get("tag"), "owner_guild": get("guild_name"),
            })
        })
        .collect();
    json!({ "height": height, "planets_with_ore": total_with_ore, "planets": planets })
}

// ── Agreements: the book ────────────────────────────────────────────────────

/// Every agreement touching one player — bought (they are the consumer) and
/// sold (they own the provider) — with what is left on each. Read from the
/// chain's agreement store in pages, cached a minute; the provider side comes
/// through the market read above so the two agree on rates.
#[tauri::command]
pub async fn terminal_agreements(player: String) -> Result<Value, String> {
    static CACHE: LazyLock<Mutex<(f64, Value)>> = LazyLock::new(|| Mutex::new((0.0, Value::Null)));
    const TTL_MS: f64 = 60_000.0;
    let now = crate::hasher::types::now_millis();
    let all = {
        let c = lock(&CACHE);
        if !c.1.is_null() && now - c.0 < TTL_MS { Some(c.1.clone()) } else { None }
    };
    let all = match all {
        Some(v) => v,
        None => {
            let client = crate::mcp::cosmos_client::CosmosClient::new();
            let mut rows: Vec<Value> = Vec::new();
            let mut key: Option<String> = None;
            let mut pages = 0;
            loop {
                let page = client.list_entities("agreement", key.as_deref(), Some(200)).await?;
                if let Some(a) = page.get("Agreement").and_then(|v| v.as_array()) {
                    rows.extend(a.iter().cloned());
                }
                key = page.get("pagination").and_then(|p| p.get("next_key")).and_then(|k| k.as_str()).filter(|k| !k.is_empty()).map(String::from);
                pages += 1;
                if key.is_none() || pages >= 20 {
                    break;
                }
            }
            let v = Value::Array(rows);
            *lock(&CACHE) = (now, v.clone());
            v
        }
    };
    let height = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    let market = terminal_market().await.unwrap_or(Value::Null);
    let providers = market.get("providers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let provider_owner = |pid: &str| -> Option<Value> {
        providers.iter().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(pid)).cloned()
    };
    let num = |v: Option<&Value>| v.and_then(|x| x.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| x.as_f64())).unwrap_or(0.0);
    let mut bought = Vec::new();
    let mut sold = Vec::new();
    for a in all.as_array().map(|v| v.as_slice()).unwrap_or(&[]) {
        let owner = a.get("owner").and_then(|v| v.as_str()).unwrap_or("");
        let provider_id = a.get("providerId").and_then(|v| v.as_str()).unwrap_or("");
        let prov = provider_owner(provider_id);
        let prov_owner = prov.as_ref().and_then(|p| p.get("owner")).and_then(|o| o.get("id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mine = owner == player;
        let sold_by_me = !prov_owner.is_empty() && prov_owner == player;
        if !mine && !sold_by_me {
            continue;
        }
        let end = num(a.get("endBlock")) as u64;
        let start = num(a.get("startBlock")) as u64;
        let capacity = num(a.get("capacity"));
        let rate = prov.as_ref().and_then(|p| p.get("provider")).and_then(|p| p.get("rate_amount")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let denom = prov.as_ref().and_then(|p| p.get("provider")).and_then(|p| p.get("denom_label")).cloned().unwrap_or(Value::Null);
        let row = json!({
            "id": a.get("id").cloned().unwrap_or(Value::Null),
            "provider_id": provider_id, "allocation_id": a.get("allocationId").cloned().unwrap_or(Value::Null),
            "owner": owner, "counterparty": if mine { prov_owner.clone() } else { owner.to_string() },
            "capacity": capacity, "rate_amount": rate, "denom_label": denom,
            "start_block": start, "end_block": end,
            "blocks_remaining": end.saturating_sub(height),
            "active": start <= height && end >= height,
            "per_block": rate * capacity,
        });
        if mine { bought.push(row); } else { sold.push(row); }
    }
    let sum = |v: &Vec<Value>, k: &str| v.iter().filter(|r| r["active"] == true).map(|r| r[k].as_f64().unwrap_or(0.0)).sum::<f64>();
    let first_expiry = bought.iter().chain(sold.iter()).filter(|r| r["active"] == true).map(|r| r["end_block"].as_u64().unwrap_or(0)).filter(|e| *e > 0).min();
    Ok(json!({
        "player": player, "height": height,
        "bought": bought, "sold": sold,
        "supply_w": sum(&bought, "capacity"), "obligation_w": sum(&sold, "capacity"),
        "spend_per_block": sum(&bought, "per_block"), "income_per_block": sum(&sold, "per_block"),
        "first_expiry_block": first_expiry,
    }))
}

// ── Guild banks: the token ratio, now and over time ─────────────────────────
//
// The guild API serves every bank's CURRENT collateral / supply / ratio, and
// thirty days of token movements — but not a ratio series (the collateral
// side's alpha movements are not in that endpoint). So the ratio history is
// SAMPLED here: each read of the banks that lands an hour or more after the
// last sample appends one point per guild to a ring persisted beside the
// layout. Honest from the first hour, deep after a week; nothing invented.

const BANK_FILE: &str = "terminal-banks.json";
const BANK_RING: usize = 24 * 30;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct BankRing {
    /// guild id → samples `{ts_ms, height, ratio, collateral, supply}` (oldest first)
    #[serde(default)]
    samples: std::collections::BTreeMap<String, Vec<Value>>,
}
static BANKS: LazyLock<Mutex<BankRing>> = LazyLock::new(|| Mutex::new(crate::mcp::config_store::load_config(BANK_FILE)));

pub(crate) fn parse_num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse::<f64>().ok())))
}

/// Every guild bank as the API answers, plus this app's sampled ratio ring
/// per guild. Cached a minute; sampled at most hourly.
#[tauri::command]
pub async fn terminal_guild_banks() -> Result<Value, String> {
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
    let raw = client.guild.guild_bank().await?;
    let rows: Vec<Value> = raw.as_array().cloned().unwrap_or_default();
    let height = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    let banks: Vec<Value> = rows
        .iter()
        .map(|r| {
            let gid = r.get("guild_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ident = crate::mcp::game_stats::snapshot();
            let row = ident.get("guilds").and_then(|g| g.as_array()).and_then(|g| g.iter().find(|x| x.get("guild_id").and_then(|v| v.as_str()) == Some(gid.as_str())).cloned());
            json!({
                "guild_id": gid,
                "name": row.as_ref().and_then(|g| g.get("name")).cloned().unwrap_or(Value::Null),
                "tag": row.as_ref().and_then(|g| g.get("tag")).cloned().unwrap_or(Value::Null),
                "logo": row.as_ref().and_then(|g| g.get("logo")).cloned().unwrap_or(Value::Null),
                "denom": r.get("denom").cloned().unwrap_or(Value::Null),
                "collateral": parse_num(r.get("collateral")),
                "supply": parse_num(r.get("supply")),
                "ratio": parse_num(r.get("ratio")),
            })
        })
        .collect();
    // Sample, at most hourly per guild.
    {
        let mut ring = lock(&BANKS);
        let mut changed = false;
        for b in &banks {
            let gid = b["guild_id"].as_str().unwrap_or("");
            if gid.is_empty() || b["ratio"].is_null() {
                continue;
            }
            let v = ring.samples.entry(gid.to_string()).or_default();
            let due = v.last().and_then(|l| l.get("ts_ms")).and_then(|t| t.as_f64()).map(|t| now - t >= 3_600_000.0).unwrap_or(true);
            if due {
                v.push(json!({ "ts_ms": now, "height": height, "ratio": b["ratio"], "collateral": b["collateral"], "supply": b["supply"] }));
                if v.len() > BANK_RING {
                    let drop = v.len() - BANK_RING;
                    v.drain(0..drop);
                }
                changed = true;
            }
        }
        if changed {
            crate::mcp::config_store::save_config(BANK_FILE, &*ring);
        }
    }
    let history = lock(&BANKS).samples.clone();
    let out = json!({ "at_ms": now, "height": height, "banks": banks, "history": history });
    *lock(&CACHE) = (now, out.clone());
    Ok(out)
}

/// Thirty days of one guild's token movements, hourly, with the supply
/// walked BACK from the current figure so each bucket carries the supply
/// as it stood — exact, because the buckets are the ledger's own sums.
#[tauri::command]
pub async fn terminal_guild_bank_history(guild_id: String) -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let raw = client.guild.guild_bank_history(&guild_id, true).await?;
    let mut rows: Vec<Value> = raw.as_array().cloned().unwrap_or_default();
    rows.sort_by(|a, b| a.get("bucket").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("bucket").and_then(|v| v.as_str()).unwrap_or("")));
    let denom = format!("uguild.{guild_id}");
    // Net supply change per bucket: minted and burned of the token itself.
    let mut buckets: std::collections::BTreeMap<String, (f64, f64, f64)> = Default::default(); // bucket → (minted, burned, infused)
    for r in &rows {
        let b = r.get("bucket").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let action = r.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let d = r.get("denom").and_then(|v| v.as_str()).unwrap_or("");
        let vol = parse_num(r.get("volume")).unwrap_or(0.0);
        let e = buckets.entry(b).or_insert((0.0, 0.0, 0.0));
        match action {
            "minted" if d == denom => e.0 += vol,
            "burned" if d == denom => e.1 += vol,
            "infused" | "defusion_completed" => e.2 += vol,
            _ => {}
        }
    }
    let current_supply = {
        let banks = terminal_guild_banks().await.unwrap_or(Value::Null);
        banks.get("banks").and_then(|b| b.as_array()).and_then(|b| b.iter().find(|x| x.get("guild_id").and_then(|v| v.as_str()) == Some(guild_id.as_str())))
            .and_then(|b| b.get("supply")).and_then(|v| v.as_f64())
    };
    // Walk back: supply at the END of bucket i = current − Σ(net changes after i).
    let keys: Vec<String> = buckets.keys().cloned().collect();
    let mut after = 0.0;
    let mut supply_at: Vec<Option<f64>> = vec![None; keys.len()];
    for i in (0..keys.len()).rev() {
        supply_at[i] = current_supply.map(|s| s - after);
        let (m, b, _) = buckets[&keys[i]];
        after += m + b; // volumes are signed by the ledger's direction
    }
    let series: Vec<Value> = keys.iter().enumerate().map(|(i, k)| {
        let (m, b, inf) = buckets[k];
        json!({ "bucket": k, "minted": m, "burned": b, "infused": inf, "supply": supply_at[i] })
    }).collect();
    Ok(json!({ "guild_id": guild_id, "denom": denom, "current_supply": current_supply, "series": series }))
}

// ── Tearsheets ──────────────────────────────────────────────────────────────

/// Everything the app knows about one player on one page: who they are
/// (identity table), where they stand (the perception snapshot: planet,
/// fleet, charge, last action), how they rank (the Game Stats boards), and
/// what the guild API records about them (ore, planets completed, raids
/// launched, ledger volume). The guild API sections are passed through as
/// they arrive — the card prints them as they are rather than guessing
/// their fields.
#[tauri::command]
pub async fn terminal_tearsheet(id: String) -> Result<Value, String> {
    let (kind, _) = crate::matrix::refs::parse_id(&id).ok_or_else(|| format!("{id:?} is not an object id"))?;
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let height = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    match kind {
        1 => {
            let ident = crate::mcp::game_stats::identity(&id).unwrap_or(Value::Null);
            let standing = crate::mcp::perception::with_snapshot(|s| {
                let p = s.players.get(&id).cloned().unwrap_or(Value::Null);
                let la = s.grid_attr(&id, "lastAction").unwrap_or(0);
                json!({
                    "planet_id": p.get("planetId").cloned().unwrap_or(Value::Null),
                    "fleet_id": p.get("fleetId").cloned().unwrap_or(Value::Null),
                    "guild_id": p.get("guildId").cloned().unwrap_or(Value::Null),
                    "last_action": la, "ago_blocks": height.saturating_sub(la), "charge": height.saturating_sub(la),
                    "known": !p.is_null(),
                })
            }).unwrap_or(Value::Null);
            // Ranks off the boards the Game Stats window already keeps.
            let stats = crate::mcp::game_stats::snapshot();
            let rank_in = |board: &str| -> Value {
                stats.get("leaderboards").and_then(|l| l.get(board)).and_then(|b| b.as_array())
                    .and_then(|rows| rows.iter().find(|r| r.get("player_id").and_then(|v| v.as_str()) == Some(id.as_str())))
                    .map(|r| json!({ "rank": r.get("rank").cloned().unwrap_or(Value::Null), "value": r.get("value").cloned().unwrap_or(Value::Null) }))
                    .unwrap_or(Value::Null)
            };
            let (ore, planets, raids, ledger) = tokio::join!(
                client.guild.player_ore_stats(&id),
                client.guild.player_planets_completed(&id),
                client.guild.player_raids_launched(&id),
                client.guild.ledger_count_by_player(&id),
            );
            let section = |r: Result<Value, String>| match r { Ok(v) => v, Err(e) => json!({ "unavailable": e }) };
            Ok(json!({
                "kind": "player", "id": id, "height": height,
                "identity": ident, "standing": standing,
                "ranks": { "alpha": rank_in("alpha"), "ore": rank_in("ore"), "structs_load": rank_in("structs_load") },
                "ore": section(ore), "planets": section(planets), "raids": section(raids), "ledger": section(ledger),
            }))
        }
        0 => {
            crate::mcp::game_stats::ensure_guilds(&client).await;
            let stats = crate::mcp::game_stats::snapshot();
            let row = stats.get("guilds").and_then(|g| g.as_array())
                .and_then(|rows| rows.iter().find(|g| g.get("guild_id").and_then(|v| v.as_str()) == Some(id.as_str())).cloned())
                .unwrap_or(Value::Null);
            let (guild, power, planets) = tokio::join!(
                client.guild.guild_by_id(&id),
                client.guild.guild_power_stats(&id),
                client.guild.guild_planet_complete_count(&id),
            );
            let section = |r: Result<Value, String>| match r { Ok(v) => v, Err(e) => json!({ "unavailable": e }) };
            let members = crate::mcp::perception::with_snapshot(|s| {
                s.players.values().filter(|p| p.get("guildId").and_then(|v| v.as_str()) == Some(id.as_str())).count()
            }).unwrap_or(0);
            Ok(json!({
                "kind": "guild", "id": id, "height": height,
                "board": row, "members_in_snapshot": members,
                "guild": section(guild), "power": section(power), "planets": section(planets),
            }))
        }
        _ => Err(format!("{id} is not a player or a guild")),
    }
}

// ── Guild bank: mint and redeem ─────────────────────────────────────────────
//
// The two tickets the terminal repo signs in the browser, here through the
// app's own ledger (`tx_retry`, index 0 = the primary). Amounts arrive as
// base units — ualpha in, uguild.<id> out — and are echoed back so the card
// can say exactly what was asked.

fn creator_address() -> Result<String, String> {
    crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.wallet_address.clone())
        .ok_or_else(|| "not signed in to the game".to_string())
}

/// Mint guild tokens against alpha: `amount_alpha` ualpha goes into the
/// guild's collateral pool, `amount_token` uguild come out.
#[tauri::command]
pub async fn terminal_guild_bank_mint(app: tauri::AppHandle, amount_alpha: u64, amount_token: u64) -> Result<Value, String> {
    if amount_alpha == 0 || amount_token == 0 {
        return Err("both the alpha in and the tokens out are required".into());
    }
    let creator = creator_address()?;
    let payload = json!({ "creator": creator, "amountAlpha": amount_alpha.to_string(), "amountToken": amount_token.to_string() });
    let res = crate::mcp::tx_retry::sign_with_retry(&app, 0, "/structs.structs.MsgGuildBankMint", payload, "terminal guild bank mint").await?;
    Ok(json!({ "ok": true, "amount_alpha": amount_alpha, "amount_token": amount_token,
               "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)") }))
}

/// Redeem guild tokens for their share of the collateral.
#[tauri::command]
pub async fn terminal_guild_bank_redeem(app: tauri::AppHandle, denom: String, amount: u64) -> Result<Value, String> {
    if amount == 0 {
        return Err("an amount of tokens is required".into());
    }
    if !denom.starts_with("uguild.") {
        return Err(format!("{denom} is not a guild token"));
    }
    let creator = creator_address()?;
    let payload = json!({ "creator": creator, "amountToken": { "denom": denom, "amount": amount.to_string() } });
    let res = crate::mcp::tx_retry::sign_with_retry(&app, 0, "/structs.structs.MsgGuildBankRedeem", payload, "terminal guild bank redeem").await?;
    Ok(json!({ "ok": true, "denom": denom, "amount": amount,
               "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)") }))
}

/* ── The stat store (`/api/stat/...`) ───────────────────────────────────────
 *
 * The guild indexes a time series per object — ten metrics, sampled whenever
 * the value MOVES — and until now nothing in this app read it: the charts we
 * drew came from an hour-long in-memory ring of galaxy counters. This is the
 * one read behind every chart of a real object.
 *
 * Three things about the data decide the shape of this command:
 *
 * 1. Samples are change-triggered. A quiet stretch means "nothing moved", not
 *    "nothing was recorded", so the value is carried forward (LOCF) rather
 *    than drawn as a gap or a zero. Before the FIRST sample there is genuinely
 *    no reading, and that stays null so the line starts where knowledge does.
 * 2. The windows are capped server-side, and differently per shape: 7 days of
 *    raw samples, 30 days once a bucket is named. The bucket is chosen from
 *    the window here so a caller cannot discover the cap as a 400.
 * 3. The samples are irregular in time. The chart helper plots a values ARRAY
 *    at even spacing, so the series is resampled into even slots here; drawing
 *    raw samples evenly would have squashed a busy hour and stretched a quiet
 *    day into the same width.
 */

/// metric → (what it measures, which object types carry it)
/// Family two omits `object_type` in the store, so those metrics accept
/// exactly one kind of id; the API answers a 400 for any other, and the card
/// uses this to say so before spending the round trip.
pub const STAT_METRICS: &[(&str, &str, &[&str])] = &[
    ("ore", "ore", &["planet", "player", "struct", "fleet"]),
    ("fuel", "alpha", &["reactor", "infusion", "player", "guild"]),
    ("capacity", "power", &["reactor", "substation", "player", "guild"]),
    ("load", "power", &["substation", "player", "guild", "struct"]),
    ("power", "power", &["allocation", "provider", "agreement", "substation"]),
    ("structs_load", "power", &["player"]),
    ("connection_count", "count", &["substation"]),
    ("connection_capacity", "power", &["substation"]),
    ("struct_health", "count", &["struct"]),
    ("struct_status", "raw", &["struct"]),
];

/// The object type an id names, by its prefix — the same table the guild API
/// keys `object_key` on (ObjectTypes::PREFIXES). Longest prefix first: 10 and
/// 11 must be matched before 1.
pub(crate) fn object_type_of(id: &str) -> Option<&'static str> {
    const PREFIXES: &[(&str, &str)] = &[
        ("10-", "provider"), ("11-", "agreement"), ("0-", "guild"), ("1-", "player"),
        ("2-", "planet"), ("3-", "reactor"), ("4-", "substation"), ("5-", "struct"),
        ("6-", "allocation"), ("7-", "infusion"), ("8-", "address"), ("9-", "fleet"),
    ];
    PREFIXES.iter().find(|(p, _)| id.starts_with(p)).map(|(_, t)| *t)
}

/// The bucket a window needs: none while the raw window allows it, then the
/// coarsest that keeps the whole window inside the server's cap.
pub(crate) fn stat_bucket_for(window_s: u64) -> (Option<&'static str>, u64) {
    use crate::mcp::guild_api::GuildApiClient;
    if window_s <= GuildApiClient::STAT_MAX_RAW_SECONDS {
        (None, window_s)
    } else if window_s <= GuildApiClient::STAT_MAX_BUCKET_SECONDS {
        (Some("1h"), window_s)
    } else {
        (Some("1d"), GuildApiClient::STAT_MAX_BUCKET_SECONDS)
    }
}

/// Carry each sample forward into evenly spaced slots. `None` until the first
/// sample: a reading nobody took is not a zero.
pub(crate) fn locf(samples: &[(f64, f64)], start_ms: f64, step_ms: f64, points: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; points];
    let mut i = 0usize;
    let mut held: Option<f64> = None;
    for (slot, cell) in out.iter_mut().enumerate() {
        let edge = start_ms + (slot as f64 + 1.0) * step_ms;
        while i < samples.len() && samples[i].0 < edge {
            held = Some(samples[i].1);
            i += 1;
        }
        *cell = held;
    }
    out
}

/// One object's series for one metric, resampled for a chart.
#[tauri::command]
pub async fn terminal_series(
    metric: String,
    object: String,
    window_s: u64,
    points: Option<u32>,
) -> Result<Value, String> {
    let object = object.trim().to_string();
    let Some((_, unit, types)) = STAT_METRICS.iter().find(|(m, _, _)| *m == metric) else {
        return Err(format!("unknown metric {metric}"));
    };
    let Some(otype) = object_type_of(&object) else {
        return Err(format!("{object} is not an object id"));
    };
    if !types.contains(&otype) {
        return Err(format!("{metric} is not recorded for a {otype}"));
    }
    let (bucket, window_s) = stat_bucket_for(window_s.max(60));
    let end_s = (crate::hasher::types::now_millis() / 1000.0) as u64;
    let start_s = end_s.saturating_sub(window_s);

    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let rows = client
        .guild
        .stat_range(&metric, &object, start_s, end_s, bucket, 1000)
        .await?;

    // `time` is a Postgres timestamptz with a two-digit offset; `value` is a
    // string like every other numeric the guild API sends.
    let mut samples: Vec<(f64, f64)> = rows
        .iter()
        .filter_map(|r| {
            let t = r.get("time").and_then(|v| v.as_str()).and_then(crate::mcp::raid_view::parse_guild_time)?;
            let v = parse_num(r.get("value"))?;
            Some((t, v))
        })
        .collect();
    samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let points = points.unwrap_or(120).clamp(8, 600) as usize;
    let start_ms = start_s as f64 * 1000.0;
    let step_ms = (window_s as f64 * 1000.0) / points as f64;
    let values = locf(&samples, start_ms, step_ms, points);

    Ok(json!({
        "metric": metric,
        "unit": unit,
        "object": object,
        "object_type": otype,
        "bucket": bucket,
        "start_ms": start_ms,
        "end_ms": start_ms + window_s as f64 * 1000.0,
        "step_ms": step_ms,
        "samples": samples.len(),
        "first_ms": samples.first().map(|s| s.0),
        "last": samples.last().map(|s| s.1),
        "values": values,
    }))
}

/// What a series card may offer: the metrics, and the ids each one accepts.
#[tauri::command]
pub fn terminal_series_metrics() -> Value {
    Value::Array(
        STAT_METRICS
            .iter()
            .map(|(m, unit, types)| json!({ "metric": m, "unit": unit, "object_types": types }))
            .collect(),
    )
}

/// The struct types the chain knows, for a build picker: what it is called,
/// where it can stand, and the charge it costs to start one.
///
/// A pure read of the synced catalog. Its own command because the placement
/// card needs it and nothing else in this window offers it.
#[tauri::command]
pub fn terminal_struct_types() -> Value {
    let gs = crate::game_state::GAME_STATE.read().unwrap_or_else(|e| e.into_inner());
    let mut rows: Vec<Value> = gs
        .struct_types
        .values()
        .map(|t| {
            json!({
                "id": t.id,
                "name": t.name,
                "category": t.category,
                "build_charge": t.build_charge,
                "max_health": t.max_health,
            })
        })
        .collect();
    rows.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Value::Array(rows)
}

/* ── Where a struct can actually go ─────────────────────────────────────────
 *
 * `build` takes an ambit and a SLOT, and a slot number is not something a
 * person knows: the planet has a fixed count per ambit and some of them are
 * occupied. Offered as a bare number field it is a guess that the chain
 * refuses, which is why the placement verbs were the last two with no UI.
 *
 * The spectator snapshot already carries both halves — `slots` is the count
 * per ambit off the Planet body, and every planetary struct reports the ambit
 * and slot it sits in — so the free ones are a subtraction, not a new read.
 */
#[tauri::command]
pub async fn terminal_build_slots(planet: String) -> Result<Value, String> {
    let t = crate::mcp::raid_view::parse_target(Some(planet.as_str()), None)?;
    let state = crate::mcp::spectator::pull_state(&t).await;
    let snap = state.get("snapshot").cloned().unwrap_or(Value::Null);
    if snap.is_null() {
        return Err(format!("{planet}: nothing to read"));
    }
    let structs = snap.get("structs").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();
    for ambit in ["space", "air", "land", "water"] {
        let count = snap
            .get("slots")
            .and_then(|s| s.get(ambit))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        // A DESTROYED struct frees its slot; a struct still building does not.
        let taken: Vec<u64> = structs
            .iter()
            .filter(|s| s.get("category").and_then(|c| c.as_str()) == Some("planet"))
            .filter(|s| s.get("ambit").and_then(|a| a.as_str()) == Some(ambit))
            .filter(|s| !s.get("destroyed").and_then(|d| d.as_bool()).unwrap_or(false))
            .filter_map(|s| s.get("slot").and_then(|v| v.as_u64()))
            .collect();
        let free: Vec<u64> = (0..count).filter(|i| !taken.contains(i)).collect();
        out.insert(ambit.to_string(), json!({ "slots": count, "free": free }));
    }
    Ok(json!({
        "planet_id": snap.get("planet_id").cloned().unwrap_or(Value::Null),
        "owner": snap.get("owner").cloned().unwrap_or(Value::Null),
        "ambits": out,
    }))
}

/* ── Where a struct that already EXISTS can go ──────────────────────────────
 *
 * `deploy` is not "build somewhere", it is `struct_move`: pick a different
 * ambit and slot for a hull that is already on the board. It is the verb
 * behind the reach-asymmetry doctrine — you win by standing where the enemy
 * neither reaches nor occupies — and it is the one an expert reaches for after
 * reading `scout`, so guessing at a slot number is exactly the wrong ending.
 *
 * Three things make a destination legal, and all three are already local:
 *
 *   1. The TYPE may occupy that ambit. `possibleAmbit` is a bitmask
 *      (water 2, land 4, air 8, space 16) and a Command Ship's is all four
 *      while an extractor's is one. An ambit the hull cannot enter is not
 *      offered at all rather than offered and refused by the chain.
 *   2. The slot is free. Planetary and fleet slots are SEPARATE spaces — the
 *      same struct id space, but "land slot 0" means two different places —
 *      so the occupancy scan is filtered by `location_id`, which is the fleet
 *      for a fleet struct and the planet for a planetary one.
 *   3. The slot count. A planet publishes its own per-ambit count; a fleet has
 *      four, which is what the map's two columns by two rows per ambit are.
 *
 * The struct's OWN slot is not counted as taken: it vacates as it moves, so
 * "same slot, different ambit" is a legal move and used to be an unexplainable
 * refusal. `here` marks where it stands now.
 *
 * Reads nothing over the network. The perception snapshot is the source of
 * truth for every struct's location, ambit and slot, so this is a subtraction.
 */
const FLEET_SLOTS_PER_AMBIT: u64 = 4;

/// The per-ambit answer: legal for this hull, how many slots, which are free,
/// and which one it stands in. Split out from the command so the arithmetic is
/// testable without a snapshot or a catalogue behind it.
fn deploy_ambits(
    kind: &str,
    mask: u64,
    planet: Option<&Value>,
    taken: &[(String, u64)],
    here_ambit: &str,
) -> Value {
    let mut out = serde_json::Map::new();
    for (bit, ambit) in [(2u64, "water"), (4, "land"), (8, "air"), (16, "space")] {
        let count = if kind == "fleet" {
            FLEET_SLOTS_PER_AMBIT
        } else {
            planet
                .and_then(|p| {
                    p.get(format!("{ambit}Slots").as_str())
                        .or_else(|| p.get(format!("{ambit}_slots").as_str()))
                        .cloned()
                })
                .map(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0))
                .unwrap_or(0)
        };
        let free: Vec<u64> = (0..count)
            .filter(|i| !taken.iter().any(|(a, s)| a == ambit && s == i))
            .collect();
        out.insert(
            ambit.to_string(),
            json!({
                // A mask we could not read is not "no ambit is legal" — with no
                // catalogue every ambit stays on offer and the chain decides.
                "allowed": mask == 0 || mask & bit != 0,
                "slots": count,
                "free": free,
                "here": here_ambit == ambit,
            }),
        );
    }
    Value::Object(out)
}

#[tauri::command]
pub fn terminal_deploy_slots(window: tauri::WebviewWindow, id: String) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_board(&window)?;
    let sid = id.trim().to_string();
    if !sid.starts_with("5-") {
        return Err(format!("'{sid}' is not a struct id (expected 5-<number>)"));
    }
    let found = crate::mcp::perception::with_snapshot(|snap| {
        let row = snap.struct_row(&sid)?;
        let (loc, here_ambit, here_slot, type_id, owner) = (
            row.location_id.clone(),
            row.operating_ambit.clone(),
            row.slot,
            row.type_id.clone(),
            row.owner.clone(),
        );
        // Everything else standing in the same slot-space.
        let mut taken: Vec<(String, u64)> = vec![];
        for (other_id, r) in snap.structs.iter() {
            if other_id == &sid || r.location_id != loc {
                continue;
            }
            if snap
                .struct_entity(other_id)
                .and_then(|e| e.get("structAttributes")?.get("isDestroyed")?.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            taken.push((r.operating_ambit.clone(), r.slot));
        }
        let planet = snap.planet_row(&loc).cloned();
        Some((loc, here_ambit, here_slot, type_id, owner, taken, planet))
    })
    .flatten();
    let Some((loc, here_ambit, here_slot, type_id, owner, taken, planet)) = found else {
        return Err(format!("{sid}: not in the snapshot"));
    };

    let kind = if loc.starts_with("9-") { "fleet" } else { "planet" };
    let (mask, move_charge, type_name) = {
        let gs = crate::game_state::GAME_STATE.read().unwrap_or_else(|e| e.into_inner());
        match gs.struct_types.get(&type_id) {
            Some(t) => (t.possible_ambit.unwrap_or(0), t.move_charge, t.name.clone()),
            None => (0, None, String::new()),
        }
    };

    let out = deploy_ambits(kind, mask, planet.as_ref(), &taken, &here_ambit);

    Ok(json!({
        "struct_id": sid,
        "type_id": type_id,
        "type_name": type_name,
        "owner": owner,
        "location_id": loc,
        "location_kind": kind,
        "ambit": here_ambit,
        "slot": here_slot,
        "move_charge": move_charge,
        "ambits": out,
    }))
}

/// Where a player's fleet actually stands, and whether that is home.
///
/// Read from the snapshot, so it costs nothing. The FLEET's `locationId` is
/// the honest answer to "where is it": the player row's `planetId` follows the
/// fleet on arrival, so it agrees with the destination the moment we get there
/// and cannot tell you that you are away.
#[tauri::command]
pub fn terminal_fleet_where(window: tauri::WebviewWindow, player: String) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_board(&window)?;
    let primary = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone());
    let who = if player.trim() == "primary" {
        primary.clone().unwrap_or_default()
    } else {
        player.trim().to_string()
    };
    let is_primary = primary.as_deref() == Some(who.as_str());
    let home = if is_primary {
        crate::game_state::GAME_STATE.read().ok().and_then(|g| g.planet_id.clone()).unwrap_or_default()
    } else {
        String::new()
    };
    let found = crate::mcp::perception::with_snapshot(|snap| {
        let row = snap.player_row(&who)?;
        let fleet_id = row.get("fleetId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let at = snap
            .fleet_row(&fleet_id)
            .and_then(|f| f.get("locationId").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let planet = row.get("planetId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        Some((fleet_id, at, planet))
    })
    .flatten();
    let Some((fleet_id, at, planet)) = found else {
        return Err(format!("{who}: not in the snapshot"));
    };
    let home = if home.is_empty() { planet.clone() } else { home };
    Ok(json!({
        "player": who,
        "is_primary": is_primary,
        "fleet_id": fleet_id,
        "at": at,
        "home": home,
        // Only meaningful for the primary, whose home we actually know.
        "away": is_primary && !at.is_empty() && !home.is_empty() && at != home,
    }))
}

/* ── Moving a fleet, for anyone on the roster ───────────────────────────────
 *
 * `move_fleet` was primary-only: `action_move_fleet` reads `fleet_id` out of
 * GAME_STATE, which is the primary's fleet and nobody else's. On a roster this
 * size that is the same mistake the struct verbs made before they learned to
 * sign as the owner — the fleet you want to stage is usually a worker's.
 *
 * The vplayer path already builds `MsgFleetMove` from an explicit `fleet_id`,
 * so this resolves the fleet from the snapshot and signs as that player. The
 * primary is not a special case for signing — `players::execute` takes
 * "primary" — but it IS one for the home guard: leaving home arms our own raid
 * clock and exposes the Command Ship, and `primary_home_guard` exists to stop
 * exactly that. The guard reads the PRIMARY's ore and headroom out of
 * GAME_STATE, so it is meaningless for a worker and mandatory for us. Calling
 * the policy's own function rather than restating it keeps the Terminal from
 * becoming the hole in it. Moving BACK home is always allowed.
 */
#[tauri::command]
pub async fn terminal_fleet_move(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: tauri::State<'_, std::sync::Arc<crate::hasher::types::TaskRegistry>>,
    player: String,
    destination: String,
) -> Result<String, String> {
    crate::mcp::tools::board_pages::require_board(&window)?;
    let player = player.trim().to_string();
    let destination = destination.trim().to_string();
    if player.is_empty() {
        return Err("fleet move: player required".into());
    }
    if !destination.starts_with("2-") {
        return Err(format!("'{destination}' is not a planet id (expected 2-<number>)"));
    }

    let primary = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone());
    let is_primary = player == "primary" || primary.as_deref() == Some(player.as_str());
    let who = if is_primary { primary.clone().unwrap_or_default() } else { player.clone() };

    let fleet_id = crate::mcp::perception::with_snapshot(|snap| {
        Some(snap.player_row(&who)?.get("fleetId")?.as_str()?.to_string())
    })
    .flatten()
    .unwrap_or_default();
    if fleet_id.is_empty() {
        return Err(format!("{who}: no fleet in the snapshot — an unexplored player has none"));
    }

    // Home is GAME_STATE's planet, the same field `action_move_fleet` guards
    // against — NOT the snapshot's `planetId`, which follows the fleet on
    // arrival and would call every destination "home" the moment we got there.
    let home = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.planet_id.clone()).unwrap_or_default();
    if is_primary && destination != home {
        if let Some(reason) = crate::mcp::policy::home_guard_block_reason() {
            crate::mcp::board_feed::push(
                &app,
                crate::mcp::board_feed::Severity::Notice,
                "home_guard",
                format!("blocked fleet move to {destination} — {reason}"),
            );
            return Err(format!("BLOCKED — {reason}"));
        }
    }

    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let out = crate::mcp::tools::players::execute(
        &app,
        &client,
        &registry,
        crate::mcp::tools::players::PlayerParams {
            command: "act".into(),
            player: Some(if is_primary { "primary".into() } else { player }),
            action: Some("fleet_move".into()),
            args: json!({ "fleet_id": fleet_id, "destination_id": destination }),
            name: None,
            index: None,
            role: None,
            guild_id: None,
        },
    )
    .await;
    let text = out
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    if text.starts_with("Error:") || text.starts_with("Blocked:") || text.starts_with("No virtual player") {
        return Err(text);
    }
    Ok(text)
}

/* ── The one verb a fresh virtual player needs ──────────────────────────────
 *
 * A newly created virtual player is an empty guild membership: no planet, no
 * fleet, no command ship. `explore` is what gives it all three, and until it
 * runs every other verb refuses. The Armada card could CREATE one and had no
 * way to finish it.
 *
 * Deliberately its own command rather than a widening of either neighbour:
 * `mcp_struct_act`'s allowlist is struct actions and explore is not one, and
 * `mcp_players` is closed to list/create/state on purpose — "widening this one
 * would hand a window every verb for every player on the roster as a side
 * effect". This hands it exactly one.
 */
#[tauri::command]
pub async fn terminal_player_explore(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: tauri::State<'_, std::sync::Arc<crate::hasher::types::TaskRegistry>>,
    player: String,
) -> Result<String, String> {
    crate::mcp::tools::board_pages::require_board(&window)?;
    if player.trim().is_empty() {
        return Err("explore: player required".into());
    }
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let out = crate::mcp::tools::players::execute(
        &app,
        &client,
        &registry,
        crate::mcp::tools::players::PlayerParams {
            command: "act".into(),
            player: Some(player),
            action: Some("explore".into()),
            args: json!({}),
            name: None,
            index: None,
            role: None,
            guild_id: None,
        },
    )
    .await;
    let text = out
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    if text.starts_with("Error:") || text.starts_with("Blocked:") || text.starts_with("No virtual player") {
        return Err(text);
    }
    Ok(text)
}

/* ── A guild's people ───────────────────────────────────────────────────────
 *
 * The guild card answers "how big is it" — member count, power, planets. That
 * is a statistic, not a community. The questions a guild actually turns on are
 * about PEOPLE: who is in it, who is still playing, who has gone quiet, who
 * can be reached.
 *
 * The roster is the guild's own (`/api/guild/{id}/roster`), and liveness comes
 * from the perception snapshot's `lastAction` — the block each player last
 * acted on — so a quiet member is a fact rather than an impression. Comms
 * presence is the window's to add; it knows who is signed in.
 */
#[tauri::command]
pub async fn terminal_guild_members(guild_id: String) -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let roster = client.guild.guild_roster(&guild_id).await?;
    let rows = roster
        .as_array()
        .cloned()
        .or_else(|| roster.get("players").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();
    let height = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    let members: Vec<Value> = rows
        .iter()
        .filter_map(|r| {
            let id = r.get("id").and_then(|v| v.as_str())?.to_string();
            // `lastAction` is a BLOCK, and absent means we have never seen this
            // player act — which is not the same as "acted at block zero".
            let last = crate::mcp::perception::with_snapshot(|s| s.grid_attr(&id, "lastAction"))
                .flatten()
                .filter(|b| *b > 0);
            Some(json!({
                "player_id": id,
                "name": r.get("username").cloned().unwrap_or(Value::Null),
                "tag": r.get("tag").cloned().unwrap_or(Value::Null),
                "pfp": r.get("pfp_client_render_attributes").cloned().unwrap_or(Value::Null),
                "last_action_block": last,
                "quiet_blocks": last.map(|b| height.saturating_sub(b)),
            }))
        })
        .collect();
    // Quietest last: the people still playing lead, which is the order you
    // read a roster in.
    let mut members = members;
    members.sort_by_key(|m| m.get("quiet_blocks").and_then(|v| v.as_u64()).unwrap_or(u64::MAX));
    let seen = members.iter().filter(|m| m["quiet_blocks"].is_u64()).count();
    Ok(json!({
        "guild_id": guild_id,
        "height": height,
        "members": members,
        "count": rows.len(),
        // How much of the roster we have ever seen act — a roster we cannot
        // date is a roster whose "quiet" column means nothing.
        "dated": seen,
    }))
}

/* ── SCOUT: the ambit they neither reach nor occupy ─────────────────────────
 *
 * The one computed answer that decides fights, and nothing in this app showed
 * it to a person. From the doctrine, measured rather than reasoned:
 *
 *   * every fleet weapon does 2 damage — hulls differ by REACH, control,
 *     counter values and charge, not by firepower;
 *   * a counter fires when the defender's weapon reaches the ATTACKER's ambit
 *     (cross-ambit) or when the defender is STANDING in it (same-ambit);
 *   * so an ambit they neither reach nor occupy is a free shot, and against
 *     beezhan on 2026-08-18 that was the whole battle: 12-1, their Command
 *     Ship decapitated, our Command Ship untouched at 6/6.
 *
 * A human cannot union nine hulls' weapon reach in their head while a raid's
 * four-minute window runs. This is that union, per side.
 */
fn ambit_names(mask: u64) -> Vec<String> {
    crate::mcp::combat::AMBIT_BITS
        .iter()
        .filter(|b| mask & **b != 0)
        .map(|b| crate::mcp::tools::format::decode_ambits(*b))
        .collect()
}

/// One side's fighting shape, as an attacker needs to read it.
fn scout_side(structs: &[Value], types: &Value, side: &str) -> Value {
    let live: Vec<&Value> = structs
        .iter()
        .filter(|s| s.get("side").and_then(|x| x.as_str()) == Some(side))
        .filter(|s| !s.get("destroyed").and_then(|x| x.as_bool()).unwrap_or(false))
        .collect();
    let mut threats: Vec<crate::mcp::combat::DefenderThreat> = Vec::new();
    let mut occupied = 0u64;
    let mut hulls: Vec<Value> = Vec::new();
    let mut command: Value = Value::Null;
    for s in &live {
        let ambit = s.get("ambit").and_then(|x| x.as_str()).unwrap_or("");
        let bit = crate::mcp::tools::format::ambit_bit(ambit);
        occupied |= bit;
        let tid = s.get("type_id").map(|x| match x {
            Value::String(v) => v.clone(),
            other => other.to_string(),
        }).unwrap_or_default();
        let t = types.get(&tid);
        let num = |k: &str| t.and_then(|x| x.get(k)).and_then(|x| x.as_u64()).unwrap_or(0);
        let mask = num("primary_weapon_ambits") | num("secondary_weapon_ambits");
        let counter = num("counter_attack");
        let counter_same = num("counter_attack_same_ambit");
        threats.push(crate::mcp::combat::DefenderThreat { mask, ambit_bit: bit, counter, counter_same });
        let hull = json!({
            "id": s.get("id").cloned().unwrap_or(Value::Null),
            "type": s.get("type_name").cloned().unwrap_or(Value::Null),
            "ambit": ambit,
            "health": s.get("health").cloned().unwrap_or(Value::Null),
            "max_health": s.get("max_health").cloned().unwrap_or(Value::Null),
            "online": s.get("online").and_then(|x| x.as_bool()).unwrap_or(true),
            "is_command": s.get("is_command").and_then(|x| x.as_bool()).unwrap_or(false),
            "reaches": ambit_names(mask),
            "counter": counter, "counter_same": counter_same,
        });
        if hull["is_command"] == true { command = hull.clone(); }
        hulls.push(hull);
    }
    let reach = threats.iter().fold(0u64, |acc, t| acc | if t.counter > 0 { t.mask } else { 0 });
    let free = crate::mcp::combat::counter_free_ambits(&threats);
    let exposure: Value = crate::mcp::combat::AMBIT_BITS
        .iter()
        .map(|b| {
            (
                crate::mcp::tools::format::decode_ambits(*b),
                json!(crate::mcp::combat::counter_exposure(&threats, *b)),
            )
        })
        .collect::<serde_json::Map<String, Value>>()
        .into();
    json!({
        "side": side,
        "hulls": hulls,
        "count": live.len(),
        "reaches": ambit_names(reach),
        "occupies": ambit_names(occupied),
        // The answer. `counter_free_ambits` already subtracts both — the
        // ambits they reach AND the ambits they stand in.
        "free": ambit_names(free),
        "exposure": exposure,
        "command": command,
    })
}

/// Scout a planet or fleet: both sides' hulls, and the ambits each of them
/// neither reaches nor occupies.
#[tauri::command]
pub async fn terminal_scout(target: String) -> Result<Value, String> {
    let t = crate::mcp::raid_view::parse_target(
        if target.starts_with('2') { Some(target.as_str()) } else { None },
        if target.starts_with('9') { Some(target.as_str()) } else { None },
    )?;
    let state = crate::mcp::spectator::pull_state(&t).await;
    let snap = state.get("snapshot").cloned().unwrap_or(Value::Null);
    if snap.is_null() {
        return Err(state.get("reason").and_then(|r| r.as_str()).unwrap_or("nothing to scout there").to_string());
    }
    let structs = snap.get("structs").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let types = snap.get("struct_types").cloned().unwrap_or(json!({}));
    Ok(json!({
        "target": target,
        "planet_id": snap.get("planet_id").cloned().unwrap_or(Value::Null),
        "owner": snap.get("owner").cloned().unwrap_or(Value::Null),
        "owner_name": snap.get("owner_name").cloned().unwrap_or(Value::Null),
        "shield": snap.get("planetary_shield").cloned().unwrap_or(Value::Null),
        "stored_ore": snap.get("stored_ore").cloned().unwrap_or(Value::Null),
        "defender": scout_side(&structs, &types, "defender"),
        "attacker": scout_side(&structs, &types, "attacker"),
    }))
}

#[cfg(test)]
mod same_card_tests {
    use super::*;
    use serde_json::json;

    /// Through serde, the way a card really arrives — so the test needs no
    /// opinion about which of Card's fields are optional.
    fn seed(cards: Vec<(&str, &str, Value)>) {
        let mut st = lock(&STORE);
        st.active = "main".into();
        st.workspaces.insert("main".into(), Layout {
            version: 0,
            cards: cards.into_iter().map(|(id, kind, params)| {
                serde_json::from_value(json!({ "id": id, "type": kind, "params": params })).expect("a card")
            }).collect(),
        });
    }

    /// Clicking `2-15361` in three messages left you owning three planet
    /// windows. The same kind about the same id is the card already there.
    #[test]
    fn the_same_object_focuses_the_card_that_already_shows_it() {
        seed(vec![("planet-1", "planet", json!({ "id": "2-15361" }))]);
        assert_eq!(same_card(None, "planet", &json!({ "id": "2-15361" })), Some(("main".into(), "planet-1".into())));
    }

    #[test]
    fn a_different_id_is_a_different_card() {
        seed(vec![("planet-1", "planet", json!({ "id": "2-15361" }))]);
        assert_eq!(same_card(None, "planet", &json!({ "id": "2-99" })), None);
        assert_eq!(same_card(None, "room", &json!({ "id": "2-15361" })), None);
    }

    /// A card with no id — the room list, the feed — is one per workspace by
    /// kind alone.
    #[test]
    fn a_card_without_an_id_is_a_singleton_by_kind() {
        seed(vec![("comms-1", "comms", json!({}))]);
        assert_eq!(same_card(None, "comms", &json!({})), Some(("main".into(), "comms-1".into())));
    }
}
#[cfg(test)]
mod tests {

    /* ── deploy: only ambits the hull may enter, only slots that are free ──
     *
     * Every case here is a refusal the chain would otherwise hand back with no
     * explanation, so each is pinned against what the hull and the location
     * actually allow rather than against a remembered number. */

    #[test]
    fn a_hull_is_offered_only_the_ambits_its_type_may_occupy() {
        // Extractor: land only (4). Command Ship: all four (30).
        let planet = json!({ "spaceSlots": "4", "airSlots": "4", "landSlots": "4", "waterSlots": "4" });
        let land_only = deploy_ambits("planet", 4, Some(&planet), &[], "land");
        assert_eq!(land_only["land"]["allowed"], json!(true));
        for a in ["water", "air", "space"] {
            assert_eq!(land_only[a]["allowed"], json!(false), "{a} is not open to a land hull");
        }
        let anywhere = deploy_ambits("planet", 30, Some(&planet), &[], "land");
        for a in ["water", "land", "air", "space"] {
            assert_eq!(anywhere[a]["allowed"], json!(true), "a Command Ship may stand in {a}");
        }
    }

    #[test]
    fn an_unsynced_catalogue_offers_every_ambit_rather_than_none() {
        // Mask 0 means "we could not read it", not "nothing is legal" — the
        // chain decides, and a card that offers nothing is worse than one that
        // offers a move the chain may refuse.
        let planet = json!({ "landSlots": 4 });
        let out = deploy_ambits("planet", 0, Some(&planet), &[], "land");
        assert_eq!(out["land"]["allowed"], json!(true));
        assert_eq!(out["space"]["allowed"], json!(true));
    }

    #[test]
    fn an_occupied_slot_is_not_free_and_the_movers_own_slot_still_is() {
        // The caller excludes the moving struct from `taken`: it vacates as it
        // moves, so "same slot, different ambit" is legal.
        let planet = json!({ "landSlots": 4, "waterSlots": 4, "airSlots": 0, "spaceSlots": 0 });
        let taken = vec![("land".to_string(), 0u64), ("land".to_string(), 2), ("water".to_string(), 1)];
        let out = deploy_ambits("planet", 30, Some(&planet), &taken, "land");
        assert_eq!(out["land"]["free"], json!([1, 3]));
        assert_eq!(out["water"]["free"], json!([0, 2, 3]));
        assert_eq!(out["land"]["here"], json!(true));
        assert_eq!(out["water"]["here"], json!(false));
    }

    #[test]
    fn an_ambit_with_no_slots_offers_nothing_even_when_the_hull_may_enter_it() {
        let planet = json!({ "landSlots": 4, "waterSlots": 0 });
        let out = deploy_ambits("planet", 30, Some(&planet), &[], "land");
        assert_eq!(out["water"]["slots"], json!(0));
        assert_eq!(out["water"]["free"], json!([]));
    }

    #[test]
    fn a_fleet_has_four_slots_an_ambit_whatever_the_planet_says() {
        // Planetary and fleet slots are separate spaces; a fleet struct's
        // capacity is the map's two columns by two rows, not the planet's.
        let planet = json!({ "landSlots": 1, "waterSlots": 1, "airSlots": 1, "spaceSlots": 1 });
        let out = deploy_ambits("fleet", 30, Some(&planet), &[], "space");
        for a in ["water", "land", "air", "space"] {
            assert_eq!(out[a]["slots"], json!(4), "{a}");
        }
    }

    #[test]
    fn planet_slot_counts_read_as_strings_or_numbers_and_in_either_spelling() {
        // Guild API and LCD numerics arrive as strings as often as numbers, and
        // the snapshot normalises snake to camel — accept what actually shows up.
        let strings = deploy_ambits("planet", 30, Some(&json!({ "landSlots": "3" })), &[], "land");
        assert_eq!(strings["land"]["slots"], json!(3));
        let snake = deploy_ambits("planet", 30, Some(&json!({ "land_slots": 3 })), &[], "land");
        assert_eq!(snake["land"]["slots"], json!(3));
        let missing = deploy_ambits("planet", 30, None, &[], "land");
        assert_eq!(missing["land"]["slots"], json!(0));
    }
    use super::*;

    /* ── The quote board's one price ─────────────────────────────────────
     *
     * Sellers quote in whatever they like — `ualpha`, or any guild's own
     * token — so "1 ack" beside "3 ohm" is not a comparison. This is the
     * restatement that makes the board readable down the page, and getting it
     * wrong misprices real money, so the arithmetic is pinned here rather than
     * trusted to a comment.
     */
    #[test]
    fn every_offer_restates_into_one_unit_or_admits_it_cannot() {
        let mut fx = std::collections::HashMap::new();
        fx.insert("ualpha".to_string(), 1.0);
        fx.insert("uguild.0-2".to_string(), 2.5);   // 2.5 ualpha per ohm

        let (alpha_rate, alpha_day) = comparable_price(1.0, "ualpha", &fx).unwrap();
        assert_eq!(alpha_rate, 1.0, "alpha is the unit, so it passes through");
        // 86,400,000 ms / 5,280 ms = 16,363.6 blocks a day. The chain charges
        // duration × capacity × rate with capacity in mW, so a rate of 1 buys a
        // kilowatt-day for that many alpha.
        assert!((alpha_day - 16_363.63).abs() < 0.1, "got {alpha_day}");

        let (token_rate, token_day) = comparable_price(3.0, "uguild.0-2", &fx).unwrap();
        assert_eq!(token_rate, 7.5, "3 ohm at 2.5 ualpha each is 7.5 ualpha");
        assert!((token_day - alpha_day * 7.5).abs() < 0.1, "and 7.5x the alpha offer");

        assert!(
            comparable_price(1.0, "uguild.9-9", &fx).is_none(),
            "a token whose bank we cannot read has NO price — quoting it at par would \
             put a fiction at the top of the board"
        );
    }

    /* The stat store's samples are change-triggered, so the resampler is the
     * one place a quiet object can be turned into a lie: a zero where nothing
     * was recorded reads as a crash, and a value before the first sample
     * claims a reading nobody took. */
    #[test]
    fn a_series_carries_forward_and_starts_where_knowledge_does() {
        // Slots of 10ms from t=0; samples at 25 (value 5) and 55 (value 9).
        let out = locf(&[(25.0, 5.0), (55.0, 9.0)], 0.0, 10.0, 8);
        assert_eq!(
            out,
            vec![None, None, Some(5.0), Some(5.0), Some(5.0), Some(9.0), Some(9.0), Some(9.0)],
            "before the first sample is null; after it the value holds until it moves"
        );
        assert_eq!(locf(&[], 0.0, 10.0, 3), vec![None, None, None], "no samples is not zero");
    }

    #[test]
    fn a_window_picks_the_bucket_that_keeps_it_inside_the_servers_cap() {
        assert_eq!(stat_bucket_for(3600), (None, 3600), "an hour is raw");
        assert_eq!(stat_bucket_for(604_800), (None, 604_800), "seven days is the raw cap");
        assert_eq!(stat_bucket_for(604_801), (Some("1h"), 604_801), "past it, bucket");
        assert_eq!(
            stat_bucket_for(90 * 86_400),
            (Some("1d"), 2_592_000),
            "and a window past the bucketed cap is clamped, not sent to be refused"
        );
    }

    #[test]
    fn an_id_names_its_object_type_longest_prefix_first() {
        assert_eq!(object_type_of("2-29604"), Some("planet"));
        assert_eq!(object_type_of("1-194"), Some("player"));
        assert_eq!(object_type_of("10-3"), Some("provider"), "10 is not 1");
        assert_eq!(object_type_of("11-3"), Some("agreement"), "11 is not 1");
        assert_eq!(object_type_of("nope"), None);
    }

    /// Every metric the card can offer must name the object types it accepts,
    /// or the card offers a choice the API answers with a 400.
    #[test]
    fn every_metric_declares_what_it_is_recorded_for() {
        assert_eq!(STAT_METRICS.len(), 10);
        for (m, unit, types) in STAT_METRICS {
            assert!(!types.is_empty(), "{m} accepts no object type");
            assert!(!unit.is_empty(), "{m} has no unit");
            for t in *types {
                assert!(
                    crate::mcp::terminal::object_type_of(&format!(
                        "{}-1",
                        match *t {
                            "guild" => "0", "player" => "1", "planet" => "2", "reactor" => "3",
                            "substation" => "4", "struct" => "5", "allocation" => "6",
                            "infusion" => "7", "address" => "8", "fleet" => "9",
                            "provider" => "10", "agreement" => "11", other => panic!("unknown type {other}"),
                        }
                    )) == Some(*t),
                    "{m} names an object type no id can produce: {t}"
                );
            }
        }
    }

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
    fn the_chain_codec_knows_the_guild_bank_messages() {
        assert!(crate::mcp::chain_codec::descriptor("/structs.structs.MsgGuildBankMint").is_ok());
        assert!(crate::mcp::chain_codec::descriptor("/structs.structs.MsgGuildBankRedeem").is_ok());
        let bytes = crate::mcp::chain_codec::encode(
            "/structs.structs.MsgGuildBankMint",
            &json!({ "amountAlpha": "1000000", "amountToken": "1000000" }),
            "structs1abc",
        );
        assert!(bytes.is_ok(), "{bytes:?}");
        let redeem = crate::mcp::chain_codec::encode(
            "/structs.structs.MsgGuildBankRedeem",
            &json!({ "amountToken": { "denom": "uguild.0-1", "amount": "5" } }),
            "structs1abc",
        );
        assert!(redeem.is_ok(), "{redeem:?}");
    }

    #[test]
    fn labels_are_ours_by_prefix() {
        assert!(is_terminal_label("terminal"));
        assert!(is_terminal_label("terminal-market-1"));
        assert!(!is_terminal_label("board"));
        assert!(!is_terminal_label("terminalx"));
    }

    #[test]
    fn the_first_terminals_single_layout_becomes_the_main_workspace() {
        let raw = r#"{"cards":[{"id":"a","type":"people"}],"version":7}"#;
        let v: Value = serde_json::from_str(raw).unwrap();
        assert!(v.get("cards").is_some() && v.get("workspaces").is_none(), "the old shape");
        let l: Layout = serde_json::from_value(v).unwrap();
        let mut st = Store::default();
        st.workspaces.insert(main(), l);
        assert_eq!(st.active, "main");
        assert_eq!(st.workspaces["main"].version, 7);
        let back: Store = serde_json::from_str(&serde_json::to_string(&st).unwrap()).unwrap();
        assert_eq!(back, st);
    }

    #[test]
    fn the_strip_order_is_the_players_and_survives_rename_and_delete() {
        let (a, b, c) = ("order-test-a".to_string(), "order-test-b".to_string(), "order-test-c".to_string());
        {
            let mut st = lock(&STORE);
            for n in [&a, &b, &c] {
                st.workspaces.insert(n.clone(), Layout::default());
            }
            st.order.clear();
        }
        let names = |v: Value| v["names"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let alpha = names(terminal_workspaces());
        let pa = alpha.iter().position(|n| n == &a).unwrap();
        assert!(pa < alpha.iter().position(|n| n == &c).unwrap(), "no order yet: alphabetical");
        let r = names(workspace_order_impl(vec![c.clone(), "nope".into(), a.clone()]).unwrap());
        let (pc, pa, pb) = (r.iter().position(|n| n == &c).unwrap(), r.iter().position(|n| n == &a).unwrap(), r.iter().position(|n| n == &b).unwrap());
        assert!(pc < pa && pa < pb, "given order first, the unlisted one after, the unknown dropped: {r:?}");
        let d = "order-test-d".to_string();
        let r = names(workspace_rename_impl(c.clone(), d.clone()).unwrap());
        assert_eq!(r.iter().position(|n| n == &d).unwrap(), pc, "a renamed workspace keeps its place");
        workspace_delete_impl(d.clone()).unwrap();
        {
            let mut st = lock(&STORE);
            assert!(!st.order.contains(&d));
            for n in [&a, &b, &c, &d] {
                st.workspaces.remove(n);
            }
            st.order.retain(|n| !n.starts_with("order-test-"));
        }
    }

    #[test]
    fn a_rename_moves_the_layout_the_active_mark_and_the_remembered_windows() {
        let from = "rename-test-a".to_string();
        let to = "rename-test-b".to_string();
        {
            let mut st = lock(&STORE);
            st.workspaces.remove(&from);
            st.workspaces.remove(&to);
            st.workspaces.insert(from.clone(), Layout { version: 2, cards: vec![Card { id: "x".into(), kind: "people".into(), params: json!({}), w: 1, h: None, title: None, cadence: None }] });
            st.active = from.clone();
        }
        {
            let mut w = lock(&WINDOWS);
            w.workspaces.push(from.clone());
            w.cards.push(format!("{from}/x"));
        }
        let r = workspace_rename_impl(from.clone(), to.clone()).unwrap();
        assert_eq!(r["active"], to.as_str());
        {
            let st = lock(&STORE);
            assert!(st.workspaces.get(&from).is_none());
            assert_eq!(st.workspaces[&to].cards[0].id, "x");
        }
        {
            let w = lock(&WINDOWS);
            assert!(w.workspaces.contains(&to) && !w.workspaces.contains(&from));
            assert!(w.cards.contains(&format!("{to}/x")) && !w.cards.contains(&format!("{from}/x")));
        }
        assert!(workspace_rename_impl(to.clone(), "no spaces here".into()).is_err(), "a name with spaces is refused");
        {
            let mut st = lock(&STORE);
            st.workspaces.insert("rename-test-c".into(), Layout::default());
        }
        assert!(workspace_rename_impl(to.clone(), "rename-test-c".into()).is_err(), "an existing name is not overwritten");
        {
            let mut st = lock(&STORE);
            st.workspaces.remove(&to);
            st.workspaces.remove("rename-test-c");
            let mut w = lock(&WINDOWS);
            w.workspaces.retain(|n| n != &to);
            w.cards.retain(|c| !c.starts_with(&format!("{to}/")));
        }
    }

    #[test]
    fn a_stale_save_is_refused_and_a_newer_one_wins() {
        let ws = "conflict-test".to_string();
        let mk = |v: u64, id: &str| Layout { version: v, cards: vec![Card { id: id.into(), kind: "people".into(), params: json!({}), w: 1, h: None, title: None, cadence: None }] };
        {
            let mut st = lock(&STORE);
            st.workspaces.remove(&ws);
        }
        layout_set_impl(Some(ws.clone()), mk(3, "a")).expect("first save lands");
        let err = layout_set_impl(Some(ws.clone()), mk(3, "b")).expect_err("same version is stale");
        assert!(err.starts_with(STALE_LAYOUT), "{err}");
        let err = layout_set_impl(Some(ws.clone()), mk(2, "b")).expect_err("older is stale");
        assert!(err.starts_with(STALE_LAYOUT), "{err}");
        let (_, saved) = layout_set_impl(Some(ws.clone()), mk(4, "b")).expect("newer wins");
        assert_eq!(saved.cards[0].id, "b");
        // An empty stored layout never blocks a save (nothing to lose).
        layout_set_impl(Some(ws.clone()), Layout { version: 0, cards: vec![] }).ok();
        let mut st = lock(&STORE);
        st.workspaces.remove(&ws);
    }

    /* ── A palette pick from the game window ──────────────────────────────
     *
     * The game window has no Terminal page to add a card to, so it asks for
     * the card and a window at once. What has rules in it — which workspace,
     * which id, the version bump — is `append_card`, and that is what is
     * tested; the window build is Tauri's. */
    #[test]
    fn a_palette_pick_appends_a_card_with_a_free_id() {
        let ws = "palette-test".to_string();
        {
            let mut st = lock(&STORE);
            st.workspaces.remove(&ws);
        }
        let (w1, id1, v1) = append_card(Some(ws.clone()), "record", json!({ "id": "1-194" })).unwrap();
        assert_eq!(w1, ws);
        assert_eq!(id1, "record-1", "the id is <type>-N, the shape the page mints");
        assert_eq!(v1, 1, "the version moves, so an open Terminal knows to re-read");

        // A second pick of the same card does not collide with the first.
        let (_, id2, v2) = append_card(Some(ws.clone()), "record", json!({ "id": "1-61" })).unwrap();
        assert_eq!(id2, "record-2");
        assert_eq!(v2, 2);

        {
            let st = lock(&STORE);
            let cards = &st.workspaces[&ws].cards;
            assert_eq!(cards.len(), 2);
            // Params are the card type's own business and are stored verbatim
            // — Rust does not know what a `record` is.
            assert_eq!(cards[0].params["id"], json!("1-194"));
            assert_eq!(cards[1].params["id"], json!("1-61"));
            assert_eq!(cards[0].w, 1);
        }

        // A workspace that does not exist yet is created rather than refused:
        // the palette is reachable before the Terminal has ever been opened.
        let (w3, id3, v3) = append_card(Some("palette-test-fresh".into()), "tally", json!({})).unwrap();
        assert_eq!((w3.as_str(), id3.as_str(), v3), ("palette-test-fresh", "tally-1", 1));

        assert!(append_card(Some("../etc".into()), "record", json!({})).is_err(), "a workspace name is a plain name");

        let mut st = lock(&STORE);
        st.workspaces.remove(&ws);
        st.workspaces.remove("palette-test-fresh");
    }

    #[test]
    fn a_layout_round_trips_with_defaults_filled() {
        let raw = r#"{"cards":[{"id":"a","type":"people"},{"id":"b","type":"page","params":{"page":"work"},"w":3}]}"#;
        let l: Layout = serde_json::from_str(raw).unwrap();
        assert_eq!(l.cards[0].w, 1, "span defaults to one column");
        assert_eq!(l.cards[1].w, 3);
        assert_eq!(l.cards[1].params["page"], "work");
        assert_eq!(l.version, 0);
        // Height is the type's business until the player says otherwise, and
        // an absent choice must not be written back as one.
        assert_eq!(l.cards[0].h, None);
        assert!(!serde_json::to_string(&l).unwrap().contains("\"h\""));
        let back: Layout = serde_json::from_str(&serde_json::to_string(&l).unwrap()).unwrap();
        assert_eq!(back, l);

        let sized: Layout = serde_json::from_str(r#"{"cards":[{"id":"a","type":"people","h":"grow"}]}"#).unwrap();
        assert_eq!(sized.cards[0].h.as_deref(), Some("grow"), "and a choice survives the round trip");
        let back2: Layout = serde_json::from_str(&serde_json::to_string(&sized).unwrap()).unwrap();
        assert_eq!(back2, sized);
    }
}
