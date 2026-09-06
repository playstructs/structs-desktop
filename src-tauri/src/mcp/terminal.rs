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

/// Every workspace by name, and which one the main window shows. A
/// workspace is a whole page of cards; each can also be a window of its own.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Store {
    #[serde(default)]
    pub workspaces: std::collections::BTreeMap<String, Layout>,
    #[serde(default = "main")]
    pub active: String,
}
fn main() -> String {
    "main".into()
}
impl Default for Store {
    fn default() -> Self {
        Store { workspaces: Default::default(), active: main() }
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

fn save_store(st: &Store) {
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
#[tauri::command]
pub fn terminal_layout_set(workspace: Option<String>, layout: Layout) -> Result<Layout, String> {
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
    st.workspaces.insert(name.clone(), layout);
    save_store(&st);
    Ok(st.workspaces[&name].clone())
}

/// Every workspace by name, and the active one.
#[tauri::command]
pub fn terminal_workspaces() -> Value {
    let st = lock(&STORE);
    let mut names: Vec<String> = st.workspaces.keys().cloned().collect();
    if names.is_empty() {
        names.push(st.active.clone());
    }
    json!({ "active": st.active, "names": names })
}

/// Make a workspace the one the main window shows.
#[tauri::command]
pub fn terminal_workspace_activate(name: String) -> Result<Value, String> {
    let name = sane_card_id(&name).ok_or_else(|| format!("workspace {name:?} is not a plain name"))?;
    let mut st = lock(&STORE);
    st.active = name;
    save_store(&st);
    drop(st);
    Ok(terminal_workspaces())
}

/// Forget a workspace. The last one cannot go; `main` is recreated empty.
#[tauri::command]
pub fn terminal_workspace_delete(name: String) -> Result<Value, String> {
    let mut st = lock(&STORE);
    if st.workspaces.len() <= 1 {
        return Err("the last workspace stays".into());
    }
    st.workspaces.remove(&name);
    if st.active == name {
        st.active = st.workspaces.keys().next().cloned().unwrap_or_else(main);
    }
    save_store(&st);
    drop(st);
    Ok(terminal_workspaces())
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

fn parse_num(v: Option<&Value>) -> Option<f64> {
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
