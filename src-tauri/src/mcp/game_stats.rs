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
/// Cadences are sized against the SHARED Guild API, not our own appetite —
/// the first cut of this module walked ~640 pages every 5 minutes and the
/// infra team noticed. Measured at live table sizes (2026-08-25):
///   fast  (60s):  directory + guild count               ≈ 2 req/min
///   heavy (10m):  grid metrics + rosters + raids + bank ≈ 280 req → 28/min
///   slow  (30m):  planets, fleets, work, structs-24h,
///                 player-addr map, per-guild planets    ≈ 330 req → 11/min
/// ≈ 41 req/min average per open window (was ~130), bursts capped by
/// INTER_PAGE_DELAY_MS, and zero while the window is closed or minimized.
const HEAVY_INTERVAL_MS: f64 = 600_000.0;
/// Big table walks whose answers drift slowly (planet status, fleet totals,
/// the day-window destruction count, the address→player map).
const SLOW_INTERVAL_MS: f64 = 1_800_000.0;
/// Cap for the aggregator's own table walks. Deliberately separate from
/// `guild_api::MAX_PAGES` (which protects interactive intel queries). Sized
/// from live table counts (2026-08-19: ~12k planets, ~12k structs, ~19k grid
/// ore rows ≈ 190 pages) with headroom — the first cap of 120 pages actually
/// tripped, and a dashboard that silently reports 12,000 of 12,400 planets is
/// worse than a slower sweep. `truncated` still flags the day the galaxy
/// outgrows this.
const MAX_LIST_PAGES: u32 = 250;
/// Pause between list pages so a sweep reads as a slow drip to the Guild API
/// rather than a burst. 150ms caps a walk at ~5 req/s even with zero server
/// latency (50ms measured ~13 req/s bursts on the shared API).
const INTER_PAGE_DELAY_MS: u64 = 150;
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
    slow_updated_ms: f64,
    sweeping: bool,
    truncated: bool,
    totals: Value,          // object; see `snapshot`
    guilds: Vec<Value>,     // ranked guild rows
    players_top: Value,     // {alpha:[rows], ore:[rows], structs_load:[rows]}
    guild_energy: Vec<Value>, // per-guild grid rollup: draw/load/capacity in mW
    // Slow-tier caches reused by the faster tiers between slow sweeps.
    pid_by_addr: HashMap<String, String>, // primary_address → player id (alpha join)
    planet_counts: HashMap<String, u64>,  // guild id → planets complete
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

/// Guild-API "alpha" fields (`guild/directory` alpha, backed by
/// `view.reactor.fuel`) are FLOORED DISPLAY GRAMS, not chain units: the
/// webapp prints them raw with a thousands separator. Everything downstream
/// of this module formats alpha on the ualpha ladder (`H.fmtAlpha`,
/// 1 g = 1e6 ualpha), the same ladder Team Ops uses for `alpha_ualpha` — so
/// convert at ingestion, or a 59,000 g balance renders as "59mg".
fn display_alpha_to_ualpha(grams: f64) -> f64 {
    grams * 1e6
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
                "draw": num(c.totals.get("structs_draw")),
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
            "slow_updated_ms": c.slow_updated_ms,
            "sweeping": c.sweeping,
            "truncated": c.truncated,
            "totals": c.totals,
            "guilds": c.guilds,
            "players_top": c.players_top,
            "guild_energy": c.guild_energy,
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
    let mut total_alpha = 0.0;
    let mut player_count = 0.0;
    for row in &dir_rows {
        let gid = text(row.get("guild_id"));
        if gid.is_empty() {
            continue;
        }
        // No per-guild requests here — this tier runs every minute, so it is
        // two requests total (directory + count). Planet counts come from the
        // slow tier's cache; power figures come from the heavy tier's grid
        // rollup (deliberately NOT `/guild/{id}/power/stats`, whose columns
        // inherit view.player's unit-mixing floor bug).
        let planets_complete = with_cache(|c| c.planet_counts.get(&gid).copied()).unwrap_or(0);
        let alpha_ualpha = display_alpha_to_ualpha(num(row.get("alpha")));
        total_alpha += alpha_ualpha;
        player_count += num(row.get("members"));
        guilds.push(json!({
            "guild_id": gid,
            "name": text(row.get("name")),
            "logo": row.get("logo").cloned().unwrap_or(Value::Null),
            "members": num(row.get("members")) as u64,
            "alpha": alpha_ualpha,
            "planets_complete": planets_complete,
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
            m.insert("total_alpha".into(), json!(total_alpha));
        });
        if t.is_none() {
            c.totals = json!({
                "guilds": guild_count,
                "players": player_count as u64,
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

/// Slow tier: the big table walks whose answers drift slowly, plus the
/// caches the faster tiers reuse (address→player map, per-guild planet
/// counts). 30-minute cadence — the single largest lever on API load.
async fn slow_sweep(client: &CosmosClient) -> Result<(), String> {
    let mut truncated = false;

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

    // Structs. The indexer's `struct` table keeps every corpse (verified
    // live: 138,849 rows, 96,253 destroyed) — orders of magnitude past any
    // sane page walk, and a truncated walk silently reported 11,951 of
    // 42,608 live structs. Two honest sources instead:
    //  - deployed count: the LCD's pagination.total (the chain prunes
    //    destroyed structs, so this IS the live count; one request);
    //  - recent losses: the list orders `updated_at DESC`, so walk only
    //    until rows age past 24h and count destructions inside the window
    //    by `destroyed_block`.
    let structs_total = client.count_entities("struct").await.unwrap_or(0);
    let day_ago_ms = crate::hasher::types::now_millis() - 24.0 * 3600.0 * 1000.0;
    // 24h of block time at 5.28s/block, against the grass-fed height.
    let day_ago_block = with_cache(|c| c.block_height).saturating_sub(16_363) as f64;
    let mut destroyed_24h: u64 = 0;
    'day_walk: for page in 1..=80u32 {
        let p = client.guild.struct_list_all(page).await?;
        let done = !p.has_more;
        for row in &p.items {
            let fresh = crate::mcp::raid_view::parse_guild_time(&text(row.get("updated_at")))
                .map(|ms| ms >= day_ago_ms)
                .unwrap_or(false);
            if !fresh {
                break 'day_walk;
            }
            let destroyed = row
                .get("is_destroyed")
                .map(|v| v.as_bool().unwrap_or_else(|| num(Some(v)) != 0.0))
                .unwrap_or(false);
            if destroyed && num(row.get("destroyed_block")) >= day_ago_block {
                destroyed_24h += 1;
            }
        }
        if done {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(INTER_PAGE_DELAY_MS)).await;
    }

    // Who is actually playing: lastAction is a per-player block-height
    // anchor, so "acted within the last 24h of blocks" is one grid walk.
    let mut active_24h: u64 = 0;
    {
        let (rows, cut) =
            walk_pages(|p| client.guild.grid_by_attribute_type("lastAction", p)).await?;
        truncated |= cut;
        for row in rows {
            if text(row.get("object_type")) == "player" && num(row.get("val")) >= day_ago_block {
                active_24h += 1;
            }
        }
    }

    // Work queue depth: page count is enough, no need to hold rows.
    let (work_rows, cut) = walk_pages(|p| client.guild.work_all(p)).await?;
    truncated |= cut;
    let work_queue = work_rows.len() as u64;

    // Address→player map for the heavy tier's bank-alpha join.
    let mut pid_by_addr: HashMap<String, String> = HashMap::new();
    {
        let (players, cut) = walk_pages(|p| client.guild.player_list_all(p)).await?;
        truncated |= cut;
        for row in players {
            let addr = text(row.get("primary_address"));
            let pid = text(row.get("id"));
            if !addr.is_empty() && !pid.is_empty() {
                pid_by_addr.insert(addr, pid);
            }
        }
    }

    // Per-guild planets-complete counts for the fast tier's guild rows.
    let guild_ids: Vec<String> =
        with_cache(|c| c.guilds.iter().map(|g| text(g.get("guild_id"))).collect());
    let mut planet_counts: HashMap<String, u64> = HashMap::new();
    for gid in guild_ids.iter().filter(|g| !g.is_empty()) {
        let v = client
            .guild
            .guild_planet_complete_count(gid)
            .await
            .unwrap_or(Value::Null);
        planet_counts.insert(gid.clone(), num(v.get("count")) as u64);
    }

    with_cache(|c| {
        c.pid_by_addr = pid_by_addr;
        c.planet_counts = planet_counts;
        c.truncated |= truncated;
        if !c.totals.is_object() {
            c.totals = json!({});
        }
        if let Some(m) = c.totals.as_object_mut() {
            m.insert("planets_total".into(), json!(planets_total));
            m.insert("planets_complete".into(), json!(planets_complete));
            m.insert("fleets_total".into(), json!(fleets_total));
            m.insert("fleets_away".into(), json!(fleets_away));
            m.insert("structs_total".into(), json!(structs_total));
            m.insert("destroyed_24h".into(), json!(destroyed_24h));
            m.insert("active_24h".into(), json!(active_24h));
            m.insert("work_queue".into(), json!(work_queue));
        }
        c.slow_updated_ms = crate::hasher::types::now_millis();
    });
    Ok(())
}

/// Heavy tier: grid metrics, identities, leaderboards, live raids.
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
    // NOTE: the roster's `alpha` column is unusable — its SQL sums
    // view.player_inventory over EVERY denom with no `denom='alpha'` filter,
    // so a player holding 2M uguild tokens tops an "alpha" ranking at 40× the
    // real whale (verified live: 1-404, alpha 0, guild.0-5 2,050,000). The
    // alpha leaderboard is built from the bank module instead (below); the
    // guild Alpha figure is fine (different query, reactor fuel).
    let mut identities: HashMap<String, Identity> = HashMap::new();
    // player id → (guild id, guild name); feeds the per-guild energy rollup.
    let mut guild_of: HashMap<String, (String, String)> = HashMap::new();
    for gid in guild_ids.iter().filter(|g| !g.is_empty()) {
        let roster = client.guild.guild_roster(gid).await.unwrap_or(Value::Null);
        for row in roster.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let pid = text(row.get("id"));
            if pid.is_empty() {
                continue;
            }
            guild_of.insert(pid.clone(), (gid.clone(), text(row.get("guild_name"))));
            identities.insert(
                pid,
                Identity {
                    // A leaderboard is read by eye and compared row to row, so
                    // a name that can reorder the text around it is worth as
                    // little here as it is in chat.
                    username: crate::matrix::identity::sanitize(&text(row.get("username"))),
                    pfp: row.get("pfp").cloned().unwrap_or(Value::Null),
                    pfp_attrs: row
                        .get("pfp_client_render_attributes")
                        .cloned()
                        .unwrap_or(Value::Null),
                    guild_name: crate::matrix::identity::sanitize(&text(row.get("guild_name"))),
                    tag: crate::matrix::identity::sanitize(&text(row.get("tag"))),
                },
            );
        }
    }

    // Honest alpha, straight from the bank: `denom_owners(ualpha)` returns
    // every holder in base units (912 addresses ≈ one LCD page), joined to
    // players via `primary_address` from the player list. Addresses that
    // aren't a player's primary (guild banks, device keys) simply don't
    // chart, which is the right answer for a PLAYER leaderboard.
    // The address→player map is the slow tier's 31-page walk, cached — new
    // signups chart with up to 30 minutes' delay, which a leaderboard can
    // afford; the balances themselves are fresh every heavy sweep.
    let mut alpha_by_player: HashMap<String, f64> = HashMap::new();
    {
        let pid_by_addr = with_cache(|c| c.pid_by_addr.clone());
        let (owners, hit_cap) = client
            .denom_owners("ualpha", 10)
            .await
            .unwrap_or((Vec::new(), false));
        truncated |= hit_cap;
        for (addr, ualpha) in owners {
            if let Some(pid) = pid_by_addr.get(&addr) {
                *alpha_by_player.entry(pid.clone()).or_insert(0.0) += ualpha;
            }
        }
    }

    // Game-wide per-player metrics from the grid: one attribute type across
    // every object in the game, filtered to players.
    let mut ore_by_player: HashMap<String, f64> = HashMap::new();
    let mut sload_by_player: HashMap<String, f64> = HashMap::new();
    // Grid `ore` holds two distinct populations (verified live: ~16k planet
    // rows = ore still in the ground, ~2.3k player rows = stored/stealable
    // ore). Summing them together would print a number that is neither.
    let mut stored_ore = 0.0;
    let mut ground_ore = 0.0;
    {
        let (rows, cut) = walk_pages(|p| client.guild.grid_by_attribute_type("ore", p)).await?;
        truncated |= cut;
        for row in rows {
            let val = num(row.get("val"));
            match text(row.get("object_type")).as_str() {
                "player" => {
                    stored_ore += val;
                    ore_by_player.insert(text(row.get("object_id")), val);
                }
                "planet" => ground_ore += val,
                _ => {}
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
    // Energy picture, straight from the grid in raw milliwatts. Deliberately
    // NOT the `/guild/{id}/power/stats` endpoint: that sums view.player's
    // total_load/total_capacity, whose floor() has an operator-precedence bug
    // upstream (`floor(a + b / 1000)`) that adds milliwatts to watts. The
    // grid rows are the source those columns are derived from.
    let mut load_by_player: HashMap<String, f64> = HashMap::new();
    let mut cap_by_player: HashMap<String, f64> = HashMap::new();
    for (attr, map) in [("load", &mut load_by_player), ("capacity", &mut cap_by_player)] {
        let (rows, cut) = walk_pages(|p| client.guild.grid_by_attribute_type(attr, p)).await?;
        truncated |= cut;
        for row in rows {
            if text(row.get("object_type")) == "player" {
                map.insert(text(row.get("object_id")), num(row.get("val")));
            }
        }
    }
    let structs_draw: f64 = sload_by_player.values().sum();
    let alloc_load: f64 = load_by_player.values().sum();
    let player_capacity: f64 = cap_by_player.values().sum();
    // Per-guild rollup over roster membership (every player belongs to a
    // guild, so the rosters cover the galaxy).
    let mut by_guild: HashMap<String, (String, f64, f64, f64)> = HashMap::new(); // gid → (name, draw, load, cap)
    for (pid, (gid, gname)) in &guild_of {
        let e = by_guild
            .entry(gid.clone())
            .or_insert_with(|| (gname.clone(), 0.0, 0.0, 0.0));
        e.1 += sload_by_player.get(pid).copied().unwrap_or(0.0);
        e.2 += load_by_player.get(pid).copied().unwrap_or(0.0);
        e.3 += cap_by_player.get(pid).copied().unwrap_or(0.0);
    }
    let mut guild_energy: Vec<Value> = by_guild
        .into_iter()
        .map(|(gid, (name, draw, load, cap))| {
            json!({ "guild_id": gid, "name": name, "structs_draw": draw,
                    "alloc_load": load, "capacity": cap })
        })
        .collect();
    // Ranked by structs draw: capacity concentrates in a handful of hub
    // players (verified live: only 75 grid capacity rows exist), so most
    // guilds legitimately show zero capacity — draw is the metric every
    // guild actually competes on.
    guild_energy.sort_by(|a, b| {
        num(b.get("structs_draw"))
            .partial_cmp(&num(a.get("structs_draw")))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

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

    // Leaderboards: alpha from the bank, ore and structs-load from the grid.
    let players_top = json!({
        "alpha": leaderboard(&alpha_by_player, &identities),
        "ore": leaderboard(&ore_by_player, &identities),
        "structs_load": leaderboard(&sload_by_player, &identities),
    });

    with_cache(|c| {
        c.players_top = players_top;
        c.truncated = truncated;
        // Guild rows deliberately carry no power figures — the renderer joins
        // `guild_energy` by guild_id, so the fast tier rebuilding the rows
        // every minute can't wash out the (heavy-tier) honest numbers.
        c.guild_energy = guild_energy;
        if !c.totals.is_object() {
            c.totals = json!({});
        }
        if let Some(m) = c.totals.as_object_mut() {
            m.insert("raids_active".into(), json!(raids_active));
            m.insert("stored_ore".into(), json!(stored_ore));
            m.insert("ground_ore".into(), json!(ground_ore));
            m.insert("structs_draw".into(), json!(structs_draw));
            m.insert("alloc_load".into(), json!(alloc_load));
            m.insert("player_capacity".into(), json!(player_capacity));
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
            // No window, or a MINIMIZED window, costs the shared API nothing:
            // people park windows for hours, and a minimized dashboard reading
            // 40 req/min is exactly the "hammering" the infra team flagged.
            // Block-tick counters (note_event) keep running either way, so the
            // series has no gap when the window comes back.
            let visible = app
                .get_webview_window(WINDOW_LABEL)
                .map(|w| !w.is_minimized().unwrap_or(false))
                .unwrap_or(false);
            if !visible {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
            let now = crate::hasher::types::now_millis();
            let (auth_ok, fast_at, heavy_at, slow_at) = with_cache(|c| {
                (c.auth_ok, c.fast_updated_ms, c.heavy_updated_ms, c.slow_updated_ms)
            });
            // Unauthenticated: the fast sweep's first request is the probe;
            // back off between probes rather than hammering a 401.
            if auth_ok == Some(false) && now - fast_at < AUTH_RETRY_MS {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
            let fast_due = now - fast_at >= FAST_INTERVAL_MS || auth_ok != Some(true);
            let slow_due = now - slow_at >= SLOW_INTERVAL_MS;
            let heavy_due = now - heavy_at >= HEAVY_INTERVAL_MS;
            if !fast_due && !heavy_due && !slow_due {
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
            // Slow runs BEFORE heavy on a cold start: it builds the
            // address→player map the heavy tier's alpha join needs, and the
            // planet counts the fast tier displays.
            if slow_due && !auth_failed && with_cache(|c| c.auth_ok) == Some(true) {
                match slow_sweep(&client).await {
                    Ok(()) => {
                        emit_board(
                            &app,
                            "game-stats-update",
                            &json!({ "tier": "heavy", "snapshot": snapshot() }),
                        );
                    }
                    Err(e) => {
                        with_cache(|c| c.slow_updated_ms = crate::hasher::types::now_millis());
                        eprintln!("[Game Stats] slow sweep failed: {}", e);
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
    fn display_alpha_grams_convert_to_ualpha() {
        // A 59,000 g balance (the Guild API's floored display form) must land
        // on the Kg rung of the shared alpha ladder, not the mg rung: 5.9e10
        // ualpha renders as "59Kg" exactly like Team Ops' alpha_ualpha.
        let row = json!({ "alpha": "59000" });
        assert_eq!(display_alpha_to_ualpha(num(row.get("alpha"))), 5.9e10);
    }

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
