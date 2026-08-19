//! Whole-game stats aggregator behind the Game Stats pop-out window.
//!
//! Team Ops answers "how is OUR fleet doing"; this module answers "what does
//! the whole universe look like" — leaderboards for players and guilds plus
//! game-wide totals — sourced entirely from the Guild API, which is public
//! chain state every player's client already receives.
//!
//! Three refresh tiers, cheapest first, so the window is useful within a
//! second of opening and the expensive sweeps never sit on a hot path:
//!
//!  - **block** — `note_event` is called from `push_game_event` for every
//!    grass frame. Pure counter math; on each `block` tick it seals a
//!    per-block sample into the series ring and pushes a tiny delta to the
//!    window. No I/O ever happens here.
//!  - **fast (60s)** — guild directory + per-guild power/planet stats. Tens
//!    of requests; produces the guild leaderboard and power totals.
//!  - **heavy (180s)** — game-wide table walks (grid metrics, rosters,
//!    planets, fleets, structs, work queue). Produces the player leaderboards
//!    and the census. The struct list is the cost center (tens of pages), so
//!    it is paced and capped, and a hit cap is surfaced as `truncated` rather
//!    than silently under-counting.
//!
//! The sweep task only runs while the window exists — players who never open
//! Game Stats pay nothing.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use tauri::Manager;

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::event_buffer::GameEvent;
use crate::mcp::web_board::emit_board;

pub const WINDOW_LABEL: &str = "gamestats";

/// Series ring capacity. One point per block at ~5.28s is roughly an hour of
/// trend — enough for the sparklines to say something without holding the
/// window's whole history in memory forever.
const SERIES_CAP: usize = 720;
const FAST_INTERVAL_MS: f64 = 60_000.0;
const HEAVY_INTERVAL_MS: f64 = 180_000.0;
/// Cap for the aggregator's own table walks. Deliberately separate from
/// `guild_api::MAX_PAGES` (which protects interactive intel queries); at 100
/// rows/page this covers 12,000 structs before flagging `truncated`.
const MAX_LIST_PAGES: u32 = 120;
/// Pause between list pages so a heavy sweep reads as a slow drip to the
/// Guild API rather than a burst.
const INTER_PAGE_DELAY_MS: u64 = 75;
/// Leaderboard depth. The window shows a podium, not a census.
const TOP_N: usize = 25;
/// While unauthenticated, only re-probe once a minute — the fast sweep's
/// first request doubles as the probe, so failing fast must not hammer.
const AUTH_RETRY_MS: f64 = 60_000.0;

// ── Cache ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct BlockCounters {
    events: u64,
    combat: u64,
    tx: u64,
}

#[derive(Default)]
struct Cache {
    auth_ok: Option<bool>, // None = never probed
    block_height: u64,
    fast_updated_ms: f64,
    heavy_updated_ms: f64,
    sweeping: bool,
    truncated: bool,
    totals: Value,          // object; see `snapshot`
    guilds: Vec<Value>,     // ranked guild rows
    players_top: Value,     // {alpha:[rows], ore:[rows], structs_load:[rows]}
    structs_by_type: Vec<Value>,
    structs_by_ambit: Vec<Value>,
    series: VecDeque<Value>, // {height, events, combat, tx, raids, structs, fuel}
    counters: BlockCounters,
}

static CACHE: RwLock<Option<Cache>> = RwLock::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);

fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
    let mut guard = CACHE.write().unwrap();
    f(guard.get_or_insert_with(Cache::default))
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

/// Guild API numerics arrive as strings (`"alpha": "1234"`); `as_f64()` alone
/// reads them as zero. One tolerant reader everywhere.
fn num(v: Option<&Value>) -> f64 {
    v.and_then(|x| {
        x.as_f64()
            .or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))
    })
    .unwrap_or(0.0)
}

fn text(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn is_auth_error(e: &str) -> bool {
    e.contains("requires login")
}

// ── Tier 0: grass hook ──────────────────────────────────────────────────────

/// Called from `push_game_event` for EVERY grass frame. Counter math only —
/// this sits on the same hot path as the telemetry write and must never block
/// or touch the network.
pub fn note_event(app: &tauri::AppHandle, event: &GameEvent) {
    if event.category == "block" {
        let height = event
            .detail
            .get("height")
            .map(|h| num(Some(h)) as u64)
            .unwrap_or(0);
        let point = with_cache(|c| {
            if height > 0 {
                c.block_height = height;
            }
            let point = json!({
                "height": c.block_height,
                "events": c.counters.events,
                "combat": c.counters.combat,
                "tx": c.counters.tx,
                "raids": num(c.totals.get("raids_active")) as u64,
                "structs": num(c.totals.get("structs_total")) as u64,
                "fuel": num(c.totals.get("total_fuel")),
            });
            c.counters = BlockCounters::default();
            if c.series.len() >= SERIES_CAP {
                c.series.pop_front();
            }
            c.series.push_back(point.clone());
            point
        });
        // Tiny per-block delta, and only when someone is looking. The full
        // snapshot travels over the pull command and the sweep pushes.
        if app.get_webview_window(WINDOW_LABEL).is_some() {
            emit_board(
                app,
                "game-stats-update",
                &json!({ "tier": "block", "height": height, "point": point }),
            );
        }
        return;
    }
    with_cache(|c| {
        c.counters.events += 1;
        match event.category.as_str() {
            "struct_attack" | "raid_status" => c.counters.combat += 1,
            "tx_settled" | "sent" | "received" => c.counters.tx += 1,
            _ => {}
        }
    });
}

// ── Snapshot (pull command payload) ─────────────────────────────────────────

fn snapshot() -> Value {
    with_cache(|c| {
        json!({
            "auth_ok": c.auth_ok,
            "block_height": c.block_height,
            "fast_updated_ms": c.fast_updated_ms,
            "heavy_updated_ms": c.heavy_updated_ms,
            "sweeping": c.sweeping,
            "truncated": c.truncated,
            "totals": c.totals,
            "guilds": c.guilds,
            "players_top": c.players_top,
            "structs_by_type": c.structs_by_type,
            "structs_by_ambit": c.structs_by_ambit,
            "series": c.series.iter().cloned().collect::<Vec<_>>(),
        })
    })
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/// Walk a `/list/all`-style endpoint with the aggregator's own pacing and
/// cap. Returns (rows, truncated).
async fn walk_pages<F, Fut>(fetch: F) -> Result<(Vec<Value>, bool), String>
where
    F: Fn(u32) -> Fut,
    Fut: std::future::Future<Output = Result<crate::mcp::guild_api::GuildPage<Value>, String>>,
{
    let mut all = Vec::new();
    for page in 1..=MAX_LIST_PAGES {
        let p = fetch(page).await?;
        let done = !p.has_more;
        all.extend(p.items);
        if done {
            return Ok((all, false));
        }
        tokio::time::sleep(std::time::Duration::from_millis(INTER_PAGE_DELAY_MS)).await;
    }
    Ok((all, true))
}

/// Fast tier: guild leaderboard + power totals. The directory is pre-ranked
/// `members DESC, alpha DESC` server-side, so ordering is preserved as-is.
async fn fast_sweep(client: &CosmosClient) -> Result<(), String> {
    let directory = client.guild.guild_directory().await?;
    let dir_rows: Vec<Value> = directory.as_array().cloned().unwrap_or_default();

    let mut guilds = Vec::with_capacity(dir_rows.len());
    let mut total_fuel = 0.0;
    let mut total_load = 0.0;
    let mut total_capacity = 0.0;
    let mut total_alpha = 0.0;
    let mut player_count = 0.0;
    for row in &dir_rows {
        let gid = text(row.get("guild_id"));
        if gid.is_empty() {
            continue;
        }
        // Two small reads per guild; the directory is tens of rows, so this
        // stays well under a hundred requests a minute.
        let power = client.guild.guild_power_stats(&gid).await.unwrap_or(Value::Null);
        let planets = client
            .guild
            .guild_planet_complete_count(&gid)
            .await
            .unwrap_or(Value::Null);
        let fuel = num(power.get("total_fuel"));
        let load = num(power.get("total_load"));
        let capacity = num(power.get("total_capacity"));
        total_fuel += fuel;
        total_load += load;
        total_capacity += capacity;
        total_alpha += num(row.get("alpha"));
        player_count += num(row.get("members"));
        guilds.push(json!({
            "guild_id": gid,
            "name": text(row.get("name")),
            "logo": row.get("logo").cloned().unwrap_or(Value::Null),
            "members": num(row.get("members")) as u64,
            "alpha": num(row.get("alpha")),
            "total_fuel": fuel,
            "total_load": load,
            "total_capacity": capacity,
            "planets_complete": num(planets.get("count")) as u64,
        }));
    }
    let guild_count = num(client
        .guild
        .guild_count()
        .await
        .unwrap_or(Value::Null)
        .get("count")) as u64;

    with_cache(|c| {
        c.guilds = guilds;
        let t = c.totals.as_object_mut().map(|m| {
            m.insert("guilds".into(), json!(guild_count));
            m.insert("players".into(), json!(player_count as u64));
            m.insert("total_fuel".into(), json!(total_fuel));
            m.insert("total_load".into(), json!(total_load));
            m.insert("total_capacity".into(), json!(total_capacity));
            m.insert("total_alpha".into(), json!(total_alpha));
        });
        if t.is_none() {
            c.totals = json!({
                "guilds": guild_count,
                "players": player_count as u64,
                "total_fuel": total_fuel,
                "total_load": total_load,
                "total_capacity": total_capacity,
                "total_alpha": total_alpha,
            });
        }
        c.fast_updated_ms = crate::hasher::types::now_millis();
    });
    Ok(())
}

/// Identity row for leaderboard display, keyed by player id.
struct Identity {
    username: String,
    pfp: Value,
    pfp_attrs: Value,
    guild_name: String,
    tag: String,
}

fn leaderboard(
    values: &HashMap<String, f64>,
    identities: &HashMap<String, Identity>,
) -> Vec<Value> {
    let mut rows: Vec<(&String, &f64)> = values.iter().filter(|(_, v)| **v > 0.0).collect();
    rows.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
    rows.truncate(TOP_N);
    rows.iter()
        .enumerate()
        .map(|(i, (id, v))| {
            let ident = identities.get(*id);
            json!({
                "rank": i + 1,
                "player_id": id,
                "username": ident.map(|x| x.username.clone()).unwrap_or_default(),
                "pfp": ident.map(|x| x.pfp.clone()).unwrap_or(Value::Null),
                "pfp_attrs": ident.map(|x| x.pfp_attrs.clone()).unwrap_or(Value::Null),
                "guild_name": ident.map(|x| x.guild_name.clone()).unwrap_or_default(),
                "tag": ident.map(|x| x.tag.clone()).unwrap_or_default(),
                "value": v,
            })
        })
        .collect()
}

/// Heavy tier: everything that needs a table walk.
async fn heavy_sweep(client: &CosmosClient) -> Result<(), String> {
    let mut truncated = false;

    // Identities (username/pfp/tag/alpha) come from the guild rosters — the
    // only bulk source that joins player ids to names. Guild ids are read
    // from the cache the fast sweep just filled; on a cold start where the
    // fast sweep failed we fall back to the directory ourselves.
    let guild_ids: Vec<String> = {
        let cached: Vec<String> =
            with_cache(|c| c.guilds.iter().map(|g| text(g.get("guild_id"))).collect());
        if cached.iter().any(|g| !g.is_empty()) {
            cached
        } else {
            client
                .guild
                .guild_directory()
                .await?
                .as_array()
                .map(|rows| rows.iter().map(|r| text(r.get("guild_id"))).collect())
                .unwrap_or_default()
        }
    };
    let mut identities: HashMap<String, Identity> = HashMap::new();
    let mut alpha_by_player: HashMap<String, f64> = HashMap::new();
    for gid in guild_ids.iter().filter(|g| !g.is_empty()) {
        let roster = client.guild.guild_roster(gid).await.unwrap_or(Value::Null);
        for row in roster.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let pid = text(row.get("id"));
            if pid.is_empty() {
                continue;
            }
            alpha_by_player.insert(pid.clone(), num(row.get("alpha")));
            identities.insert(
                pid,
                Identity {
                    username: text(row.get("username")),
                    pfp: row.get("pfp").cloned().unwrap_or(Value::Null),
                    pfp_attrs: row
                        .get("pfp_client_render_attributes")
                        .cloned()
                        .unwrap_or(Value::Null),
                    guild_name: text(row.get("guild_name")),
                    tag: text(row.get("tag")),
                },
            );
        }
    }

    // Game-wide per-player metrics from the grid: one attribute type across
    // every object in the game, filtered to players.
    let mut ore_by_player: HashMap<String, f64> = HashMap::new();
    let mut sload_by_player: HashMap<String, f64> = HashMap::new();
    let mut total_ore = 0.0;
    {
        let (rows, cut) = walk_pages(|p| client.guild.grid_by_attribute_type("ore", p)).await?;
        truncated |= cut;
        for row in rows {
            let val = num(row.get("val"));
            total_ore += val;
            if text(row.get("object_type")) == "player" {
                ore_by_player.insert(text(row.get("object_id")), val);
            }
        }
    }
    {
        let (rows, cut) =
            walk_pages(|p| client.guild.grid_by_attribute_type("structsLoad", p)).await?;
        truncated |= cut;
        for row in rows {
            if text(row.get("object_type")) == "player" {
                sload_by_player.insert(text(row.get("object_id")), num(row.get("val")));
            }
        }
    }

    // Planets: status breakdown.
    let (planet_rows, cut) = walk_pages(|p| client.guild.planet_list_all(p)).await?;
    truncated |= cut;
    let planets_total = planet_rows.len() as u64;
    let planets_complete = planet_rows
        .iter()
        .filter(|r| text(r.get("status")) == "complete")
        .count() as u64;

    // Fleets: how much of the galaxy is on the move.
    let (fleet_rows, cut) = walk_pages(|p| client.guild.fleet_list_all(p)).await?;
    truncated |= cut;
    let fleets_total = fleet_rows.len() as u64;
    let fleets_away = fleet_rows
        .iter()
        .filter(|r| text(r.get("status")) == "away")
        .count() as u64;

    // Structs: the census, and the cost center.
    let (struct_rows, cut) = walk_pages(|p| client.guild.struct_list_all(p)).await?;
    truncated |= cut;
    let type_catalog = client.guild.struct_type_catalog().await.unwrap_or(Value::Null);
    let mut type_names: HashMap<String, String> = HashMap::new();
    for row in type_catalog.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let id = text(row.get("id"));
        let name = {
            let t = text(row.get("type"));
            if t.is_empty() { text(row.get("name")) } else { t }
        };
        if !id.is_empty() && !name.is_empty() {
            type_names.insert(id, name);
        }
    }
    let mut by_type: HashMap<String, (u64, u64)> = HashMap::new(); // (alive, destroyed)
    let mut by_ambit: HashMap<String, u64> = HashMap::new();
    let mut structs_destroyed: u64 = 0;
    for row in &struct_rows {
        let destroyed = row
            .get("is_destroyed")
            .map(|v| v.as_bool().unwrap_or_else(|| num(Some(v)) != 0.0))
            .unwrap_or(false);
        let raw_type = text(row.get("type"));
        let name = type_names.get(&raw_type).cloned().unwrap_or(raw_type);
        let slot = by_type.entry(name).or_insert((0, 0));
        if destroyed {
            slot.1 += 1;
            structs_destroyed += 1;
        } else {
            slot.0 += 1;
            *by_ambit.entry(text(row.get("operating_ambit"))).or_insert(0) += 1;
        }
    }
    let structs_total = struct_rows.len() as u64 - structs_destroyed;
    let mut structs_by_type: Vec<Value> = by_type
        .into_iter()
        .map(|(name, (alive, destroyed))| {
            json!({ "type": name, "count": alive, "destroyed": destroyed })
        })
        .collect();
    structs_by_type.sort_by(|a, b| (num(b.get("count")) as u64).cmp(&(num(a.get("count")) as u64)));
    let mut structs_by_ambit: Vec<Value> = by_ambit
        .into_iter()
        .map(|(ambit, count)| json!({ "ambit": ambit, "count": count }))
        .collect();
    structs_by_ambit.sort_by(|a, b| (num(b.get("count")) as u64).cmp(&(num(a.get("count")) as u64)));

    // Work queue depth: page count is enough, no need to hold rows.
    let (work_rows, cut) = walk_pages(|p| client.guild.work_all(p)).await?;
    truncated |= cut;
    let work_queue = work_rows.len() as u64;

    // Live raids: same source and reduction as War · Live Raids, so the two
    // numbers can never disagree.
    let raid_rows = crate::mcp::guild_api::fetch_all_pages(
        |page| client.guild.planet_activity_by_category("raid_status", page),
        3,
    )
    .await
    .unwrap_or_default();
    let raids_active = crate::mcp::raid_view::reduce_raids(
        &raid_rows,
        crate::hasher::types::now_millis(),
        crate::mcp::raid_view::STALE_AFTER_MS,
    )
    .iter()
    .filter(|r| r.live)
    .count() as u64;

    // Leaderboards. Alpha comes from rosters (the grid has no alpha type);
    // ore and structs-load come from the grid walks above.
    let players_top = json!({
        "alpha": leaderboard(&alpha_by_player, &identities),
        "ore": leaderboard(&ore_by_player, &identities),
        "structs_load": leaderboard(&sload_by_player, &identities),
    });

    with_cache(|c| {
        c.players_top = players_top;
        c.structs_by_type = structs_by_type;
        c.structs_by_ambit = structs_by_ambit;
        c.truncated = truncated;
        if !c.totals.is_object() {
            c.totals = json!({});
        }
        if let Some(m) = c.totals.as_object_mut() {
            m.insert("planets_total".into(), json!(planets_total));
            m.insert("planets_complete".into(), json!(planets_complete));
            m.insert("fleets_total".into(), json!(fleets_total));
            m.insert("fleets_away".into(), json!(fleets_away));
            m.insert("structs_total".into(), json!(structs_total));
            m.insert("structs_destroyed".into(), json!(structs_destroyed));
            m.insert("work_queue".into(), json!(work_queue));
            m.insert("raids_active".into(), json!(raids_active));
            m.insert("total_ore".into(), json!(total_ore));
        }
        c.heavy_updated_ms = crate::hasher::types::now_millis();
    });
    Ok(())
}

// ── Sweep task ──────────────────────────────────────────────────────────────

/// Start the background sweep loop (idempotent). Runs sweeps only while the
/// gamestats window exists; otherwise idles cheaply.
pub fn ensure_running(app: &tauri::AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if app.get_webview_window(WINDOW_LABEL).is_none() {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
            let now = crate::hasher::types::now_millis();
            let (auth_ok, fast_at, heavy_at) =
                with_cache(|c| (c.auth_ok, c.fast_updated_ms, c.heavy_updated_ms));
            // Unauthenticated: the fast sweep's first request is the probe;
            // back off between probes rather than hammering a 401.
            if auth_ok == Some(false) && now - fast_at < AUTH_RETRY_MS {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
            let fast_due = now - fast_at >= FAST_INTERVAL_MS || auth_ok != Some(true);
            let heavy_due = now - heavy_at >= HEAVY_INTERVAL_MS;
            if !fast_due && !heavy_due {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
            with_cache(|c| c.sweeping = true);
            emit_board(&app, "game-stats-update", &json!({ "tier": "sweeping" }));

            let client = CosmosClient::new();
            let mut auth_failed = false;
            if fast_due {
                match fast_sweep(&client).await {
                    Ok(()) => {
                        with_cache(|c| c.auth_ok = Some(true));
                        emit_board(
                            &app,
                            "game-stats-update",
                            &json!({ "tier": "fast", "snapshot": snapshot() }),
                        );
                    }
                    Err(e) => {
                        auth_failed = is_auth_error(&e);
                        with_cache(|c| {
                            if auth_failed {
                                c.auth_ok = Some(false);
                            }
                            // Stamp the attempt so the retry backoff works.
                            c.fast_updated_ms = crate::hasher::types::now_millis();
                        });
                        eprintln!("[Game Stats] fast sweep failed: {}", e);
                    }
                }
            }
            if heavy_due && !auth_failed && with_cache(|c| c.auth_ok) == Some(true) {
                match heavy_sweep(&client).await {
                    Ok(()) => {
                        emit_board(
                            &app,
                            "game-stats-update",
                            &json!({ "tier": "heavy", "snapshot": snapshot() }),
                        );
                    }
                    Err(e) => {
                        with_cache(|c| c.heavy_updated_ms = crate::hasher::types::now_millis());
                        eprintln!("[Game Stats] heavy sweep failed: {}", e);
                    }
                }
            }
            with_cache(|c| c.sweeping = false);
            emit_board(&app, "game-stats-update", &json!({ "tier": "idle", "auth_ok": with_cache(|c| c.auth_ok) }));
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Open (or focus) the Game Stats window. Same shape as `open_stream_window`:
/// chrome-less board.html solo view, no initialization_script EVER (the
/// raid_view module docs carry the full same-origin rationale).
#[tauri::command]
pub fn open_game_stats_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::App("board.html?view=gamestats".into()),
    )
    .title("Structs — Game Stats")
    // Wide: two leaderboard cards side by side plus a stat-tile strip.
    .inner_size(1180.0, 860.0)
    .build()
    .map_err(|e| e.to_string())?;
    ensure_running(&app);
    Ok(())
}

/// Pull-on-load: the full cache. Push alone loses the first paint (the window
/// subscribes after the events fired), so the page always starts here.
#[tauri::command]
pub fn mcp_game_stats_snapshot() -> Result<Value, String> {
    Ok(snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn num_reads_strings_and_numbers() {
        assert_eq!(num(Some(&json!("42"))), 42.0);
        assert_eq!(num(Some(&json!(" 7 "))), 7.0);
        assert_eq!(num(Some(&json!(3.5))), 3.5);
        assert_eq!(num(Some(&json!(null))), 0.0);
        assert_eq!(num(None), 0.0);
    }

    #[test]
    fn leaderboard_ranks_and_truncates() {
        let mut values = HashMap::new();
        for i in 0..40 {
            values.insert(format!("1-{}", i), i as f64);
        }
        values.insert("1-zero".into(), 0.0); // zero-value players are omitted
        let identities = HashMap::new();
        let rows = leaderboard(&values, &identities);
        assert_eq!(rows.len(), TOP_N);
        assert_eq!(rows[0]["rank"], json!(1));
        assert_eq!(rows[0]["player_id"], json!("1-39"));
        assert_eq!(num(rows[0].get("value")), 39.0);
        assert!(num(rows[TOP_N - 1].get("value")) > 0.0);
    }

    #[test]
    fn block_series_ring_caps() {
        // Directly exercise the ring logic note_event uses.
        let mut c = Cache::default();
        for h in 0..(SERIES_CAP + 10) {
            if c.series.len() >= SERIES_CAP {
                c.series.pop_front();
            }
            c.series.push_back(json!({ "height": h }));
        }
        assert_eq!(c.series.len(), SERIES_CAP);
        assert_eq!(num(c.series.front().unwrap().get("height")) as usize, 10);
    }
}
