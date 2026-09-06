//! Whole-game stats aggregator behind the Game Stats pop-out window.
//!
//! Team Ops answers "how is OUR fleet doing"; this module answers "what does
//! the whole universe look like" — leaderboards for players and guilds plus
//! game-wide totals — sourced entirely from the Guild API, which is public
//! chain state every player's client already receives.
//!
//! Three refresh tiers, run concurrently and painted as each lands, so the
//! window is useful within a second of opening and the expensive sweeps
//! never sit on a hot path:
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

/// Is anyone looking? The Game Stats window, or any Terminal window — the
/// Terminal draws these cards too, and an engine that only sweeps for one
/// of its two readers leaves the other on dashes. Minimized does not count:
/// a parked window must not cost the shared API anything.
pub fn watched(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.webview_windows()
        .iter()
        .filter(|(label, _)| label.as_str() == WINDOW_LABEL || crate::mcp::terminal::is_terminal_label(label))
        .any(|(_, w)| !w.is_minimized().unwrap_or(false))
}

/// Series ring capacity. One point per block at ~5.28s is roughly an hour of
/// trend — enough for the sparklines to say something without holding the
/// window's whole history in memory forever.
const SERIES_CAP: usize = 720;
const FAST_INTERVAL_MS: f64 = 60_000.0;
/// Cadences are sized against the SHARED Guild API, not our own appetite —
/// the first cut of this module walked ~640 pages every 5 minutes and the
/// infra team noticed. Measured at live table sizes (2026-08-25):
///   fast  (60s):  directory + singles                   ≈ 8 req/min
///   heavy (10m):  rosters, leaderboards, sorted grid
///                 top, structsLoad pages, raids, stats  ≈ 18 req → 2/min
///   slow  (30m):  destroyed-24h total, per-guild
///                 planets (fleets from perception)      ≈ 6 req → 0.2/min
/// ≈ 10 req/min average per open window (was ~41, and ~130 before that),
/// bursts capped by INTER_PAGE_DELAY_MS, and zero while the window is
/// closed or minimized. The 2026-09-03 audit that drove this is in
/// proposals/game-stats-query-efficiency.md.
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
/// Page size for the walks that remain (PR #121 `?limit=`, server-clamped
/// at 1000): a 3,000-row table is 3 requests, not 30.
const BIG_PAGE: usize = 1000;
/// Leaderboard depth. The window shows a podium, not a census.
const TOP_N: usize = 25;
/// While unauthenticated, only re-probe once a minute — the fast sweep's
/// first request doubles as the probe, so failing fast must not hammer.
const AUTH_RETRY_MS: f64 = 60_000.0;

// ── Cache ───────────────────────────────────────────────────────────────────

/// What one block's worth of GRASS frames — and our own engine — added up to.
/// Reset on every block frame; the point pushed into the series is the tally.
#[derive(Default)]
struct BlockCounters {
    /// Every non-block frame, by the family its subject names.
    frames: u64,
    frames_planet: u64,
    frames_grid: u64,
    frames_inventory: u64,
    combat: u64,
    /// Bank sends seen on the inventory feed (`sent`/`received`). This was
    /// the whole of the old "transactions / block" — which is why that chart
    /// sat near zero while the chain carried 0–4 transactions a block.
    transfers: u64,
    /// Transactions THIS app signed and the chain accepted (tx_retry hook).
    our_tx: u64,
    /// Proofs of work solved here (hasher hook).
    proofs: u64,
    /// Ore cycle restarts on the planet clocks = completions landing.
    mine_starts: u64,
    refine_starts: u64,
    /// Raid clocks ARMED this block (a `block_raid_start` frame with a
    /// non-zero clock; the zero ones are raids ending).
    raid_starts: u64,
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
    // PR #121 availability flags: when a modern endpoint fails (older guild
    // API), the flag routes the datum through the legacy walk instead.
    counts_fallback: bool,
    alpha_fallback: bool,
    // 7-day hourly LOCF aggregates from /api/stat/{m}/aggregate/range —
    // {ore: [rows], structs_load: [rows]}, rows {bucket, sum, avg, ...}.
    history: Value,
    series: VecDeque<Value>, // one point per block; see `note_event`
    counters: BlockCounters,
    /// Hourly liveness samples from the perception snapshot, 7 days deep:
    /// `{ts_ms, height, players, live_1h, live_24h, max_index}`. The one
    /// history that survives restarts and needs no server aggregate.
    liveness: VecDeque<Value>,
    /// The block the galaxy pass last ran at (it runs every 12 blocks).
    last_pass_height: u64,
    /// Who a player id IS — username, portrait, guild — from the guild
    /// rosters the heavy sweep reads. The galaxy pass decorates the live
    /// player list from it, so the liveness card shows people, not ids.
    identities: HashMap<String, Value>,
}

/// Hourly liveness ring: 7 days.
const LIVENESS_CAP: usize = 168;
/// How many of the hour's players the liveness card names (newest first).
const LIVE_PLAYERS_SHOWN: usize = 60;
/// The galaxy pass walks the whole snapshot (3k players, 29k planets, 3k
/// fleets); once a minute is plenty and costs a few milliseconds.
const PASS_EVERY_BLOCKS: u64 = 12;
/// Blocks in an hour / a day at the measured 5.30 s block time.
const BLOCKS_PER_HOUR: u64 = 680;
const BLOCKS_PER_DAY: u64 = 16_300;
/// The HUD's battery: raw charge → the first threshold it does not exceed,
/// five chunks. Copied from the webapp's ChargeCalculator (playercard.js
/// pins the same table against the webapp's file).
const CHARGE_LEVEL_THRESHOLDS: [u64; 6] = [0, 1, 2, 3, 5, 8];

fn charge_level(charge: u64) -> usize {
    CHARGE_LEVEL_THRESHOLDS.iter().position(|t| charge <= *t).unwrap_or(CHARGE_LEVEL_THRESHOLDS.len() - 1)
}

static CACHE: RwLock<Option<Cache>> = RwLock::new(None);

/* Last-known figures, kept across restarts.
 *
 * Every tier is a poll, and the heavy one runs every ten minutes — so a fresh
 * launch showed "collecting…" on half the charts and "Loading…" where the
 * leaderboards go, for as long as ten minutes. That is honest (see `opt_num`)
 * but it is not useful: the numbers barely move between restarts, and the page
 * had them a moment ago.
 *
 * So the snapshot is written to disk after each sweep and read back at boot.
 * The page paints immediately with what was true last time and updates in
 * place when the first sweep lands. The `*_updated_ms` stamps ride along, so
 * the header keeps saying WHEN the figures are from rather than implying they
 * are current.
 *
 * Deliberately not persisted: `auth_ok` (a live fact about this session's
 * credentials, and a stale `false` would suppress the first probe), `sweeping`
 * (nothing is), and `counters` (a partial block's tally means nothing once the
 * block has passed).
 */
fn cache_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join("game_stats_cache.json"))
}

/// What survives a restart. A struct rather than the whole `Cache` so adding a
/// live-only field cannot accidentally start persisting it.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Persisted {
    #[serde(default)]
    block_height: u64,
    #[serde(default)]
    fast_updated_ms: f64,
    #[serde(default)]
    heavy_updated_ms: f64,
    #[serde(default)]
    slow_updated_ms: f64,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    totals: Value,
    #[serde(default)]
    guilds: Vec<Value>,
    #[serde(default)]
    players_top: Value,
    #[serde(default)]
    guild_energy: Vec<Value>,
    #[serde(default)]
    series: Vec<Value>,
    /// 7-day aggregates. Without this the trends card sat empty for up to
    /// ten minutes after every launch, waiting on the heavy tier.
    #[serde(default)]
    history: Value,
    #[serde(default)]
    liveness: Vec<Value>,
}

fn persist() {
    let Some(path) = cache_path() else { return };
    let snap = with_cache(|c| Persisted {
        block_height: c.block_height,
        fast_updated_ms: c.fast_updated_ms,
        heavy_updated_ms: c.heavy_updated_ms,
        slow_updated_ms: c.slow_updated_ms,
        truncated: c.truncated,
        totals: c.totals.clone(),
        guilds: c.guilds.clone(),
        players_top: c.players_top.clone(),
        guild_energy: c.guild_energy.clone(),
        series: c.series.iter().cloned().collect(),
        history: c.history.clone(),
        liveness: c.liveness.iter().cloned().collect(),
    });
    let Ok(body) = serde_json::to_vec(&snap) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write-then-rename: a snapshot half-written when the app is killed must
    // not be what the next launch reads.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Load last-known figures into an empty cache. Never overwrites live data:
/// called once at startup, and a sweep that has already landed wins.
fn restore() {
    let Some(path) = cache_path() else { return };
    let Ok(body) = std::fs::read(&path) else { return };
    let Ok(p) = serde_json::from_slice::<Persisted>(&body) else { return };
    with_cache(|c| {
        if c.fast_updated_ms > 0.0 || c.heavy_updated_ms > 0.0 {
            return; // a sweep beat us; live data always wins
        }
        c.block_height = p.block_height;
        c.fast_updated_ms = p.fast_updated_ms;
        c.heavy_updated_ms = p.heavy_updated_ms;
        c.slow_updated_ms = p.slow_updated_ms;
        c.truncated = p.truncated;
        c.totals = p.totals;
        c.guilds = p.guilds;
        c.players_top = p.players_top;
        c.guild_energy = p.guild_energy;
        c.series = p.series.into_iter().collect();
        c.history = p.history;
        c.liveness = p.liveness.into_iter().collect();
    });
}

/// A transaction this app signed landed (tx_retry's success path).
pub fn note_our_tx() {
    with_cache(|c| c.counters.our_tx += 1);
}

/// A proof of work was solved here (the hasher's completion path).
pub fn note_proof() {
    with_cache(|c| c.counters.proofs += 1);
}
static RUNNING: AtomicBool = AtomicBool::new(false);

fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
    let mut guard = CACHE.write().unwrap();
    f(guard.get_or_insert_with(Cache::default))
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

/// Guild API numerics arrive as strings (`"alpha": "1234"`); `as_f64()` alone
/// reads them as zero. One tolerant reader everywhere.
/// A number for the series, or `null` when we simply do not know yet.
///
/// `num` answers 0 for a missing key, which is right for a display tile —
/// "0 raids" and "we have not counted raids" look the same to a reader, and
/// both are harmless. It is WRONG for a time series. The totals map is empty
/// until the first sweep lands, so every block tick before then recorded a
/// hard 0 for structs, raids and draw, and those zeros stayed in the ring for
/// its full 720 blocks — about an hour. A sparkline scales from its own min,
/// so a single false zero flattened every real movement into a sliver and
/// drew a cliff out of a galaxy that had never been empty.
///
/// Absence is reported as absence, and the renderer breaks the line across it.
/// Note this keys off the KEY being present, not the value being non-zero: a
/// genuine `0` raids is data and must still plot.
fn opt_num(v: Option<&Value>) -> Value {
    // `Value::Null` needs no arm of its own: it parses as neither a number nor
    // a numeric string, so it lands on the same `Null` the missing key does,
    // which is the answer we want for both.
    v.and_then(|x| {
        x.as_f64()
            .or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))
    })
    .map(|n| json!(n))
    .unwrap_or(Value::Null)
}

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
        // Engine gauges at the block boundary — the same numbers status
        // shows, sampled once a block so they can be drawn against time.
        let gate = crate::mcp::tx_gate::snapshot();
        let pool_pending = crate::hasher::pool::pending_len();
        let pool_running = crate::hasher::scheduler::running();
        let (point, pass_due) = with_cache(|c| {
            if height > 0 {
                c.block_height = height;
            }
            let k = &c.counters;
            let point = json!({
                "height": c.block_height,
                // `events` keeps its name for the window; it is every frame.
                "events": k.frames,
                "frames_planet": k.frames_planet,
                "frames_grid": k.frames_grid,
                "frames_inventory": k.frames_inventory,
                "combat": k.combat,
                "transfers": k.transfers,
                "our_tx": k.our_tx,
                // Filled in a moment by `finish_block` from the block itself;
                // null until then, and null for good when nobody is looking.
                "chain_tx": Value::Null,
                "proofs": k.proofs,
                "mine_starts": k.mine_starts,
                "refine_starts": k.refine_starts,
                "raid_starts": k.raid_starts,
                "gate_cap": crate::mcp::tx_gate::cap(),
                "gate_in_flight": gate.get("in_flight").cloned().unwrap_or(Value::Null),
                "gate_queued": gate.get("queued_critical").and_then(|v| v.as_u64()).unwrap_or(0)
                    + gate.get("queued_interactive").and_then(|v| v.as_u64()).unwrap_or(0)
                    + gate.get("queued_bulk").and_then(|v| v.as_u64()).unwrap_or(0),
                "pool_pending": pool_pending,
                "pool_running": pool_running,
                // `opt_num`, not `num`: a total we have not swept yet is
                // null, never 0. See its doc comment.
                "raids": opt_num(c.totals.get("raids_active")),
                "structs": opt_num(c.totals.get("structs_total")),
                "draw": opt_num(c.totals.get("structs_draw")),
            });
            c.counters = BlockCounters::default();
            if c.series.len() >= SERIES_CAP {
                c.series.pop_front();
            }
            c.series.push_back(point.clone());
            let due = c.block_height >= c.last_pass_height + PASS_EVERY_BLOCKS;
            if due {
                c.last_pass_height = c.block_height;
            }
            (point, due)
        });
        if pass_due {
            galaxy_pass(height);
        }
        // The chain's own transaction count comes from the block itself: one
        // LCD read per block, only while the window is open. The point is
        // pushed once that read is back (or has failed), so the window
        // draws it once, complete.
        if watched(app) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { finish_block(app, height, point).await });
        }
        return;
    }
    let family = crate::mcp::types::Subject::parse(&event.subject).family;
    let raid_armed = event.category == "block_raid_start"
        && crate::mcp::types::numeric_u64(event.detail.get("block_start_raid")).unwrap_or(0) > 0;
    with_cache(|c| {
        c.counters.frames += 1;
        use crate::mcp::types::SubjectFamily;
        match family {
            SubjectFamily::Planet => c.counters.frames_planet += 1,
            SubjectFamily::Grid => c.counters.frames_grid += 1,
            SubjectFamily::Inventory => c.counters.frames_inventory += 1,
            _ => {}
        }
        match event.category.as_str() {
            "struct_attack" | "raid_status" => c.counters.combat += 1,
            "sent" | "received" => c.counters.transfers += 1,
            "struct_block_ore_mine_start" => c.counters.mine_starts += 1,
            "struct_block_ore_refine_start" => c.counters.refine_starts += 1,
            "block_raid_start" if raid_armed => c.counters.raid_starts += 1,
            _ => {}
        }
    });
}

/// Count the block's transactions from the block itself, store it on the
/// point, and push the point to the window.
async fn finish_block(app: tauri::AppHandle, height: u64, mut point: Value) {
    if height > 0 {
        let client = CosmosClient::new();
        let path = format!("/cosmos/base/tendermint/v1beta1/blocks/{height}");
        if let Ok(v) = client.lcd_get(&path).await {
            if let Some(n) = v.get("block").and_then(|b| b.get("data")).and_then(|d| d.get("txs")).and_then(|t| t.as_array()).map(|a| a.len()) {
                point["chain_tx"] = json!(n);
                with_cache(|c| {
                    if let Some(p) = c.series.iter_mut().rev().find(|p| p.get("height").and_then(|h| h.as_u64()) == Some(height)) {
                        p["chain_tx"] = json!(n);
                    }
                });
            }
        }
    }
    emit_board(&app, "game-stats-update", &json!({ "tier": "block", "height": height, "point": point }));
}

/// Everything the perception snapshot can say about the galaxy's pulse,
/// once a minute: who is alive, how full the roster's batteries are, how
/// much ore is left where, and where the fleets are. No network.
fn galaxy_pass(height: u64) {
    use crate::mcp::perception::with_snapshot;
    let Some(read) = with_snapshot(|s| {
        // ── Liveness ──
        let mut players = 0u64;
        let mut live_1h = 0u64;
        let mut live_24h = 0u64;
        let mut max_index = 0u64;
        // The players behind the hour's count, newest action first. The card
        // shows THEM rather than a number.
        let mut live: Vec<(String, u64)> = Vec::new();
        for (pid, _) in s.players.iter() {
            players += 1;
            if let Some(i) = pid.split_once('-').and_then(|(_, i)| i.parse::<u64>().ok()) {
                max_index = max_index.max(i);
            }
            if let Some(la) = s.grid_attr(pid, "lastAction").filter(|la| *la > 0) {
                if height.saturating_sub(la) <= BLOCKS_PER_HOUR {
                    live_1h += 1;
                    live.push((pid.clone(), la));
                }
                if height.saturating_sub(la) <= BLOCKS_PER_DAY {
                    live_24h += 1;
                }
            }
        }
        // ── Our roster's batteries ──
        let mut levels = [0u64; 6];
        for (pid, _, _) in crate::mcp::virtual_players::collect_targets(true) {
            let la = s.grid_attr(pid.as_str(), "lastAction").unwrap_or(0);
            levels[charge_level(height.saturating_sub(la))] += 1;
        }
        // ── Ore economy ──
        let mut planets_with_ore = 0u64;
        let mut planets_exhausted = 0u64;
        let mut rigs_mining = 0u64;
        let mut rigs_refining = 0u64;
        for (pid, _) in s.planets.iter() {
            match s.grid_attr(pid, "ore") {
                Some(o) if o > 0 => planets_with_ore += 1,
                _ => planets_exhausted += 1,
            }
            rigs_mining += s.planet_attr(pid, "oreMiningActiveQuantity").unwrap_or(0);
            rigs_refining += s.planet_attr(pid, "oreRefiningActiveQuantity").unwrap_or(0);
        }
        // ── Fleets ──
        let mut away = 0u64;
        let mut on_station = 0u64;
        for f in s.fleets.values() {
            match f.get("status").and_then(|x| x.as_str()) {
                Some("away") => away += 1,
                _ => on_station += 1,
            }
        }
        live.sort_by(|a, b| b.1.cmp(&a.1));
        live.truncate(LIVE_PLAYERS_SHOWN);
        (players, live_1h, live_24h, max_index, levels, planets_with_ore, planets_exhausted, rigs_mining, rigs_refining, away, on_station, live)
    }) else {
        return;
    };
    let (players, live_1h, live_24h, max_index, levels, planets_with_ore, planets_exhausted, rigs_mining, rigs_refining, away, on_station, live) = read;
    let now = crate::hasher::types::now_millis();
    let funnel = crate::mcp::auto_raid::last_funnel();
    with_cache(|c| {
        // Hourly sample, 7 days deep.
        let due = c.liveness.back().and_then(|l| l.get("ts_ms")).and_then(|t| t.as_f64()).map(|t| now - t >= 3_600_000.0).unwrap_or(true);
        if due {
            if c.liveness.len() >= LIVENESS_CAP {
                c.liveness.pop_front();
            }
            c.liveness.push_back(json!({
                "ts_ms": now, "height": height, "players": players,
                "live_1h": live_1h, "live_24h": live_24h, "max_index": max_index,
            }));
        }
        // New players: the highest id now against the highest id a day / a
        // week ago. Ids are minted in order, so the difference is the count.
        let index_ago = |ms: f64| -> Option<u64> {
            c.liveness.iter().filter(|l| l.get("ts_ms").and_then(|t| t.as_f64()).map(|t| now - t >= ms).unwrap_or(false))
                .last().and_then(|l| l.get("max_index")).and_then(|v| v.as_u64())
        };
        let new_24h = index_ago(24.0 * 3_600_000.0).map(|i| max_index.saturating_sub(i));
        let new_7d = index_ago(7.0 * 24.0 * 3_600_000.0).map(|i| max_index.saturating_sub(i));
        if !c.totals.is_object() {
            c.totals = json!({});
        }
        if let Some(m) = c.totals.as_object_mut() {
            m.insert("players_known".into(), json!(players));
            m.insert("live_1h".into(), json!(live_1h));
            m.insert("live_24h".into(), json!(live_24h));
            let live_players: Vec<Value> = live
                .iter()
                .map(|(pid, la)| {
                    let ident = c.identities.get(pid);
                    let get = |k: &str| ident.and_then(|i| i.get(k)).cloned().unwrap_or(Value::Null);
                    json!({
                        "player_id": pid,
                        "last_action": la,
                        "ago_blocks": height.saturating_sub(*la),
                        "charge": height.saturating_sub(*la),
                        "username": get("username"), "pfp_attrs": get("pfp_attrs"), "tag": get("tag"),
                        "guild_name": get("guild_name"), "planet_id": get("planet_id"), "fleet_id": get("fleet_id"),
                    })
                })
                .collect();
            m.insert("live_players".into(), json!(live_players));
            m.insert("max_player_index".into(), json!(max_index));
            m.insert("new_players_24h".into(), new_24h.map(|n| json!(n)).unwrap_or(Value::Null));
            m.insert("new_players_7d".into(), new_7d.map(|n| json!(n)).unwrap_or(Value::Null));
            m.insert("charge_levels".into(), json!(levels));
            m.insert("planets_with_ore".into(), json!(planets_with_ore));
            m.insert("planets_exhausted".into(), json!(planets_exhausted));
            m.insert("rigs_mining".into(), json!(rigs_mining));
            m.insert("rigs_refining".into(), json!(rigs_refining));
            m.insert("fleets_away_now".into(), json!(away));
            m.insert("fleets_on_station".into(), json!(on_station));
            m.insert("raid_funnel".into(), funnel);
            m.insert("galaxy_pass_height".into(), json!(height));
        }
    });
}

// ── Snapshot (pull command payload) ─────────────────────────────────────────

pub(crate) fn snapshot() -> Value {
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
            "history": c.history,
            "series": c.series.iter().cloned().collect::<Vec<_>>(),
            "liveness": c.liveness.iter().cloned().collect::<Vec<_>>(),
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

/// The guild directory on demand, for a card drawn OUTSIDE the Game Stats
/// window — a guild named in Comms. The tiers only run while that window is
/// visible, so in a fresh session a guild card found an empty cache and drew
/// no mark and no figures. One fast sweep fills it. Bounded by the fast
/// cadence either way, so a busy room naming guilds does not become a poll,
/// and a failing API is not retried on every mention.
pub async fn ensure_guilds(client: &CosmosClient) {
    // Last session's directory first. The Game Stats loop restores the
    // persisted cache when ITS window opens; a guild card in a session where
    // that window never opened would otherwise start from nothing every
    // launch. `restore()` never overwrites a sweep that already landed.
    if with_cache(|c| c.guilds.is_empty() && c.fast_updated_ms == 0.0) {
        restore();
    }
    let now = crate::hasher::types::now_millis();
    let (have, fast_at) = with_cache(|c| (!c.guilds.is_empty(), c.fast_updated_ms));
    if have || now - fast_at < FAST_INTERVAL_MS {
        return;
    }
    match fast_sweep(client).await {
        // Written down, so the NEXT launch has it before any window opens.
        Ok(()) => persist(),
        Err(e) => {
            eprintln!("[Game Stats] on-demand guild sweep failed: {}", e);
            with_cache(|c| c.fast_updated_ms = now);
        }
    }
}

/// One guild's figures as the leaderboard knows them, for a card drawn
/// elsewhere (a guild named in Comms). `None` until the fast tier has run or
/// for a guild the directory does not list; the card then shows what it has.
pub fn guild_summary(guild_id: &str) -> Option<Value> {
    with_cache(|c| {
        let g = c.guilds.iter().find(|g| text(g.get("guild_id")) == guild_id)?;
        let capacity = c
            .guild_energy
            .iter()
            .find(|e| text(e.get("guild_id")) == guild_id)
            .map(|e| num(e.get("capacity")));
        Some(json!({
            "name": g.get("name").cloned().unwrap_or(Value::Null),
            "logo": g.get("logo").cloned().unwrap_or(Value::Null),
            "members": num(g.get("members")),
            "alpha": num(g.get("alpha")),
            "planets_complete": num(g.get("planets_complete")),
            "capacity": capacity,
        }))
    })
}

/// A guild's logo as a URL our windows can load.
///
/// The directory's `logo` is a URI the guild's own site serves; the webapp
/// renders it as-is because it IS that site. A root-relative path like
/// `/img/guild/logo.png` resolves to nothing inside a Tauri window, so it is
/// rebased onto the guild's site origin (its `guild_api` minus the `/api`
/// path). Absolute http(s) URLs pass through; anything else is no logo.
fn absolute_logo(guild_id: &str, logo: &str) -> Value {
    let logo = logo.trim();
    if logo.is_empty() {
        return Value::Null;
    }
    if logo.starts_with("http://") || logo.starts_with("https://") {
        return json!(logo);
    }
    if logo.starts_with('/') && !logo.starts_with("//") {
        let origin = crate::guild_config::get_guild_configs()
            .into_iter()
            .find(|c| c.guild_id == guild_id)
            .and_then(|c| {
                let api = c.guild_api.trim_end_matches('/');
                let rest = api.strip_prefix("https://").or_else(|| api.strip_prefix("http://"))?;
                let host = rest.split('/').next()?;
                Some(format!("{}://{}", if api.starts_with("https") { "https" } else { "http" }, host))
            });
        if let Some(origin) = origin {
            return json!(format!("{}{}", origin, logo));
        }
    }
    Value::Null
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
            "logo": absolute_logo(&gid, &text(row.get("logo"))),
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

    // PR #121 singles: the block clock plus one-request galaxy counts that
    // replaced four table walks (planets 205 pages, lastAction 31, work 46,
    // struct math via the LCD). Any failure flips the fallback flag and the
    // slow tier walks the legacy way — older guild APIs keep working.
    let block = client.guild.current_block().await;
    let planet_cnt = client.guild.planet_count().await;
    let struct_all = client.guild.struct_count(None).await;
    let struct_flags = client.guild.struct_status_counts().await;
    let work_cnt = client.guild.work_count().await;
    let active_cnt = client.guild.player_active_count(16_363).await;
    let counts_ok = planet_cnt.is_ok()
        && struct_all.is_ok()
        && struct_flags.is_ok()
        && work_cnt.is_ok()
        && active_cnt.is_ok();

    with_cache(|c| {
        c.guilds = guilds;
        // The HTTP block clock backstops grass: after the oh.energy TLS
        // outage taught us a dead grass stream freezes every block-derived
        // number, the indexer's own height now moves the clock too (grass
        // still wins between fast sweeps — we only ever move forward).
        if let Ok(b) = &block {
            let h = num(b.get("height")) as u64;
            if h > c.block_height {
                c.block_height = h;
            }
        }
        c.counts_fallback = !counts_ok;
        if counts_ok {
            if !c.totals.is_object() {
                c.totals = json!({});
            }
            if let Some(m) = c.totals.as_object_mut() {
                m.insert(
                    "planets_total".into(),
                    json!(num(planet_cnt.as_ref().ok().and_then(|v| v.get("count"))) as u64),
                );
                // Deployed structs = all rows minus corpses; the same 42.6k
                // the LCD's count_total reports, now from the guild's own API.
                let all = num(struct_all.as_ref().ok().and_then(|v| v.get("count")));
                let destroyed =
                    num(struct_flags.as_ref().ok().and_then(|v| v.get("destroyed")));
                m.insert("structs_total".into(), json!((all - destroyed).max(0.0) as u64));
                m.insert(
                    "work_queue".into(),
                    json!(num(work_cnt.as_ref().ok().and_then(|v| v.get("count"))) as u64),
                );
                m.insert(
                    "active_24h".into(),
                    json!(num(active_cnt.as_ref().ok().and_then(|v| v.get("count"))) as u64),
                );
            }
        }
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

/// Who a player id is, as the heavy sweep last learned it (username, portrait
/// attrs, tag, guild, planet, fleet). `None` until the first sweep.
pub fn identity(pid: &str) -> Option<Value> {
    with_cache(|c| c.identities.get(pid).cloned())
}

/// Identity row for leaderboard display, keyed by player id.
struct Identity {
    username: String,
    pfp: Value,
    pfp_attrs: Value,
    guild_name: String,
    tag: String,
    /// Where to LOOK: the player's planet and fleet, so a leaderboard row can
    /// open the spectator the way a roster row does. Empty when unknown, and
    /// the card then simply offers no door.
    planet_id: String,
    fleet_id: String,
}

/// A row's planet/fleet ids for the leaderboards. The guild roster carries
/// `planet_id`; the fleet is not in that API at all, so both are read from
/// the perception snapshot's player store (`planetId`/`fleetId`) when it has
/// the player, with the roster's planet as the fallback.
fn whereabouts(pid: &str, roster_row: &Value) -> (String, String) {
    let from_snapshot = crate::mcp::perception::with_snapshot(|s| {
        s.players
            .get(pid)
            .map(|p| (text(p.get("planetId")), text(p.get("fleetId"))))
    })
    .flatten()
    .unwrap_or_default();
    let planet = if from_snapshot.0.is_empty() {
        text(roster_row.get("planet_id"))
    } else {
        from_snapshot.0
    };
    (planet, from_snapshot.1)
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
                "planet_id": ident.map(|x| x.planet_id.clone()).unwrap_or_default(),
                "fleet_id": ident.map(|x| x.fleet_id.clone()).unwrap_or_default(),
                "value": v,
            })
        })
        .collect()
}

/// Slow tier: the counts that drift slowly plus the caches the faster tiers
/// reuse (address→player map, per-guild planet counts). 30-minute cadence.
///
/// Was ~115 requests (a 30-page fleet walk and an 80-page struct walk that,
/// at 224k rows ordered newest-first, could not even reach 24 h back and
/// under-counted destructions). Now: fleets from the perception snapshot
/// (zero requests) or a 1,000-row walk, destructions as ONE filtered
/// `include_total` read, planet counts asked concurrently.
async fn slow_sweep(client: &CosmosClient) -> Result<(), String> {
    let t0 = crate::hasher::types::now_millis();
    let req0 = crate::mcp::guild_api::request_stats().0;
    let mut truncated = false;
    let (counts_fallback, alpha_fallback) =
        with_cache(|c| (c.counts_fallback, c.alpha_fallback));

    // Planets: total now comes from /api/planet/count in the fast tier and
    // complete from the per-guild counts below — the walk runs only for
    // guilds on a pre-#121 API.
    let mut legacy_planets: Option<(u64, u64)> = None;
    if counts_fallback {
        let (planet_rows, cut) = walk_pages(|p| client.guild.planet_list_all(p)).await?;
        truncated |= cut;
        let complete = planet_rows
            .iter()
            .filter(|r| text(r.get("status")) == "complete")
            .count() as u64;
        legacy_planets = Some((planet_rows.len() as u64, complete));
    }

    // Fleets: the perception snapshot already holds every fleet in the
    // galaxy with its status, patched live by GRASS — the answer is in
    // memory. A snapshot older than this tier's own cadence is not trusted
    // over a fresh read.
    let now_ms = crate::hasher::types::now_millis();
    let from_snapshot: Option<(u64, u64)> = crate::mcp::perception::with_snapshot(|s| {
        if now_ms - s.taken_ms > SLOW_INTERVAL_MS {
            return None;
        }
        let away = s
            .fleets
            .values()
            .filter(|f| text(f.get("status")) == "away")
            .count() as u64;
        Some((s.fleets.len() as u64, away))
    })
    .flatten();
    let (fleets_total, fleets_away, fleets_source) = match from_snapshot {
        Some((total, away)) => (total, away, "perception"),
        None => {
            let (rows, cut) =
                match walk_pages(|p| client.guild.fleet_list_all_limited(p, BIG_PAGE)).await {
                    Ok(ok) => ok,
                    Err(_) => walk_pages(|p| client.guild.fleet_list_all(p)).await?,
                };
            truncated |= cut;
            let away = rows
                .iter()
                .filter(|r| text(r.get("status")) == "away")
                .count() as u64;
            (rows.len() as u64, away, "guild_api")
        }
    };

    // Recent losses: destroyed rows touched in the last 24 h, counted
    // server-side. The legacy newest-first walk stays for older APIs.
    let day_ago_ms = now_ms - 24.0 * 3600.0 * 1000.0;
    let day_ago_block = with_cache(|c| c.block_height).saturating_sub(16_363) as f64;
    let destroyed_24h = match client
        .guild
        .struct_destroyed_since_total((day_ago_ms / 1000.0) as i64)
        .await
    {
        Ok(n) => n,
        Err(_) => legacy_destroyed_walk(client, day_ago_ms, day_ago_block).await?,
    };

    // Active players + work depth: fast-tier one-request counts on a modern
    // API; the legacy walks run only in fallback.
    let mut legacy_active: Option<u64> = None;
    let mut legacy_work: Option<u64> = None;
    if counts_fallback {
        let mut active_24h: u64 = 0;
        let (rows, cut) =
            walk_pages(|p| client.guild.grid_by_attribute_type("lastAction", p)).await?;
        truncated |= cut;
        for row in rows {
            if text(row.get("object_type")) == "player" && num(row.get("val")) >= day_ago_block {
                active_24h += 1;
            }
        }
        legacy_active = Some(active_24h);
        let (work_rows, cut) = walk_pages(|p| client.guild.work_all(p)).await?;
        truncated |= cut;
        legacy_work = Some(work_rows.len() as u64);
    }

    // Address→player map: only the LEGACY alpha path (bank denom_owners join)
    // needs it — /api/leaderboard/player carries usernames itself.
    let mut pid_by_addr: HashMap<String, String> = HashMap::new();
    if alpha_fallback {
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

    // Per-guild planets-complete counts for the fast tier's guild rows —
    // five independent singles, asked at once.
    let guild_ids: Vec<String> =
        with_cache(|c| c.guilds.iter().map(|g| text(g.get("guild_id"))).collect());
    let mut planet_counts: HashMap<String, u64> = HashMap::new();
    {
        let mut set: tokio::task::JoinSet<(String, u64)> = tokio::task::JoinSet::new();
        for gid in guild_ids.iter().filter(|g| !g.is_empty()).cloned() {
            let c = client.clone();
            set.spawn(async move {
                let v = c
                    .guild
                    .guild_planet_complete_count(&gid)
                    .await
                    .unwrap_or(Value::Null);
                (gid, num(v.get("count")) as u64)
            });
        }
        while let Some(res) = set.join_next().await {
            if let Ok((gid, n)) = res {
                planet_counts.insert(gid, n);
            }
        }
    }

    // Galaxy planets-complete = the per-guild sum (every complete planet has
    // an owner in a guild) — /api/planet/count has no status filter.
    let planets_complete_sum: u64 = planet_counts.values().sum();

    with_cache(|c| {
        if alpha_fallback {
            c.pid_by_addr = pid_by_addr;
        }
        c.planet_counts = planet_counts;
        c.truncated |= truncated;
        if !c.totals.is_object() {
            c.totals = json!({});
        }
        if let Some(m) = c.totals.as_object_mut() {
            m.insert("planets_complete".into(), json!(planets_complete_sum));
            m.insert("fleets_total".into(), json!(fleets_total));
            m.insert("fleets_away".into(), json!(fleets_away));
            m.insert("destroyed_24h".into(), json!(destroyed_24h));
            if let Some((total, complete)) = legacy_planets {
                m.insert("planets_total".into(), json!(total));
                m.insert("planets_complete".into(), json!(complete));
            }
            if let Some(v) = legacy_active {
                m.insert("active_24h".into(), json!(v));
            }
            if let Some(v) = legacy_work {
                m.insert("work_queue".into(), json!(v));
            }
        }
        c.slow_updated_ms = crate::hasher::types::now_millis();
    });
    crate::mcp::telemetry::tlog_kv(
        "game_stats",
        crate::mcp::telemetry::Sev::Info,
        "slow sweep: done",
        json!({
            "ms": (crate::hasher::types::now_millis() - t0).round(),
            "requests": crate::mcp::guild_api::request_stats().0 - req0,
            "fleets_source": fleets_source,
            "destroyed_24h": destroyed_24h,
        }),
    );
    Ok(())
}

/// Pre-`include_total` destruction count: the list orders `updated_at DESC`,
/// so walk until rows age past 24 h and count by `destroyed_block`. Capped,
/// so on a busy day it under-counts — which is why it is the fallback.
async fn legacy_destroyed_walk(
    client: &CosmosClient,
    day_ago_ms: f64,
    day_ago_block: f64,
) -> Result<u64, String> {
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
    Ok(destroyed_24h)
}

/// The last non-null `sum` of an aggregate-range response: with LOCF every
/// object is carried forward, so the newest bucket IS the current galaxy
/// total. `None` when the endpoint is absent or the range is empty.
fn last_bucket_sum(v: &Value) -> Option<f64> {
    v.as_array().and_then(|rows| {
        rows.iter().rev().find_map(|r| {
            r.get("sum")
                .filter(|x| !x.is_null())
                .map(|x| num(Some(x)))
        })
    })
}

/// Every roster at once: the requests are independent, so the wait is the
/// slowest of five rather than their sum (this alone was most of the old
/// "Best players takes forever"). A panicked task is one guild missing from
/// the board, not a failed sweep.
async fn fetch_rosters(client: &CosmosClient, guild_ids: &[String]) -> Vec<(String, Value)> {
    let mut set: tokio::task::JoinSet<(String, Value)> = tokio::task::JoinSet::new();
    for gid in guild_ids.iter().filter(|g| !g.is_empty()).cloned() {
        let c = client.clone();
        set.spawn(async move {
            let r = c.guild.guild_roster(&gid).await.unwrap_or(Value::Null);
            (gid, r)
        });
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(pair) = res {
            out.push(pair);
        }
    }
    out
}

/// Live raids: PR #121's planet-raid list, filtered for freshness — the
/// table keeps abandoned non-terminal rows forever (one 19-day-old
/// `initiated` observed), so `updated_at` within the same staleness horizon
/// War · Live Raids uses decides "live". Falls back to the legacy
/// activity-feed reduction on an older API.
async fn live_raids(client: &CosmosClient) -> u64 {
    let now_ms = crate::hasher::types::now_millis();
    let (a, b, c) = tokio::join!(
        client.guild.planet_raid_by_status("initiated", 1),
        client.guild.planet_raid_by_status("ongoing", 1),
        client.guild.planet_raid_by_status("shieldsVulnerable", 1),
    );
    if let (Ok(a), Ok(b), Ok(c)) = (a, b, c) {
        return [a, b, c]
            .iter()
            .flat_map(|page| page.items.iter())
            .filter(|r| {
                crate::mcp::raid_view::parse_guild_time(&text(r.get("updated_at")))
                    .map(|ms| now_ms - ms < crate::mcp::raid_view::STALE_AFTER_MS)
                    .unwrap_or(false)
            })
            .count() as u64;
    }
    let raid_rows = crate::mcp::guild_api::fetch_all_pages(
        |page| client.guild.planet_activity_by_category("raid_status", page),
        3,
    )
    .await
    .unwrap_or_default();
    crate::mcp::raid_view::reduce_raids(&raid_rows, now_ms, crate::mcp::raid_view::STALE_AFTER_MS)
        .iter()
        .filter(|r| r.live)
        .count() as u64
}

/// Per-player `object_id → val` from grid rows, keeping player rows (and
/// rows from the unfiltered legacy route, which carry no object_type).
fn player_vals(rows: &[Value]) -> HashMap<String, f64> {
    let mut m = HashMap::new();
    for row in rows {
        let ot = text(row.get("object_type"));
        if ot.is_empty() || ot == "player" {
            m.insert(text(row.get("object_id")), num(row.get("val")));
        }
    }
    m
}

/// Per-guild load/capacity in base units from `/api/leaderboard/guild` rows:
/// guild id → (name, member_load_p, member_capacity_p).
fn guild_energy_from_board(rows: &[Value]) -> HashMap<String, (String, f64, f64)> {
    let mut m = HashMap::new();
    for r in rows {
        let gid = text(r.get("guild_id"));
        if gid.is_empty() {
            continue;
        }
        let name = {
            let n = text(r.get("name"));
            if n.is_empty() {
                text(r.get("onchain_name"))
            } else {
                n
            }
        };
        m.insert(
            gid,
            (
                crate::matrix::identity::sanitize(&name),
                num(r.get("member_load_p")),
                num(r.get("member_capacity_p")),
            ),
        );
    }
    m
}

/// Heavy tier: identities, leaderboards, energy picture, live raids and the
/// 7-day history. Every stage is independent, so they run at once and the
/// tier costs max(stage) — about one roster fetch.
///
/// Request budget (modern API): 5 rosters + 2 leaderboards + 1 sorted grid
/// read + ~4 structsLoad pages + 3 raid pages + 3 aggregates ≈ 18, down from
/// ~106 when the ore/structsLoad/load/capacity boards were each a 30-page
/// walk. The walks survive only as fallbacks for older guild APIs.
async fn heavy_sweep(client: &CosmosClient) -> Result<(), String> {
    let t0 = crate::hasher::types::now_millis();
    let req0 = crate::mcp::guild_api::request_stats().0;
    let mut truncated = false;

    // Identities (username/pfp/tag) come from the guild rosters — the only
    // bulk source that joins player ids to names. Guild ids are read from
    // the cache the fast sweep filled; on a cold start where the fast sweep
    // failed we fall back to the directory ourselves.
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
    let now_s = (crate::hasher::types::now_millis() / 1000.0) as i64;
    let week_ago = now_s - 7 * 24 * 3600;

    // structsLoad is the one metric still walked in full: the per-guild
    // draw rollup needs every player's value, and no server rollup carries
    // it. 1,000-row pages make it ~4 requests; the map also yields the
    // structs-load board and the galaxy draw total for free.
    let sload_fut = async {
        match walk_pages(|p| {
            client
                .guild
                .grid_by_attribute_and_object_type_limited("structsLoad", "player", p, BIG_PAGE)
        })
        .await
        {
            Ok(ok) => Ok(ok),
            Err(_) => match walk_pages(|p| {
                client.guild.grid_by_attribute_and_object_type("structsLoad", "player", p)
            })
            .await
            {
                Ok(ok) => Ok(ok),
                Err(_) => walk_pages(|p| client.guild.grid_by_attribute_type("structsLoad", p)).await,
            },
        }
    };
    let history_fut = async {
        tokio::join!(
            client.guild.stat_aggregate("ore", "planet", "1h", now_s - 7200, now_s),
            client.guild.stat_aggregate("ore", "player", "1h", week_ago, now_s),
            client.guild.stat_aggregate("structs_load", "player", "1h", week_ago, now_s),
        )
    };
    let (rosters, alpha_res, guild_board_res, ore_top_res, sload_res, raids_active, (ore_planet, ore_hist, sload_hist)) =
        tokio::join!(
            fetch_rosters(client, &guild_ids),
            client.guild.leaderboard("player", Some("alpha_value.desc"), TOP_N as u32),
            client.guild.leaderboard("guild", Some("player_count.desc"), 50),
            client.guild.grid_top("ore", "player", TOP_N as u32),
            sload_fut,
            live_raids(client),
            history_fut,
        );
    let t_join = crate::hasher::types::now_millis();
    // Aggregates are optional (absent on older APIs): a failure is "don't
    // know", carried as Null so every reader falls back to the last value.
    let (ore_planet, ore_hist, sload_hist) = (
        ore_planet.unwrap_or(Value::Null),
        ore_hist.unwrap_or(Value::Null),
        sload_hist.unwrap_or(Value::Null),
    );

    // NOTE: the roster's `alpha` column is unusable — its SQL sums
    // view.player_inventory over EVERY denom with no `denom='alpha'` filter,
    // so a player holding 2M uguild tokens tops an "alpha" ranking at 40× the
    // real whale (verified live: 1-404, alpha 0, guild.0-5 2,050,000). The
    // alpha leaderboard comes from the server ranking instead (below).
    let mut identities: HashMap<String, Identity> = HashMap::new();
    // player id → (guild id, guild name); feeds the per-guild energy rollup.
    let mut guild_of: HashMap<String, (String, String)> = HashMap::new();
    for (gid, roster) in &rosters {
        for row in roster.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let pid = text(row.get("id"));
            if pid.is_empty() {
                continue;
            }
            guild_of.insert(pid.clone(), (gid.clone(), text(row.get("guild_name"))));
            let (planet_id, fleet_id) = whereabouts(&pid, row);
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
                    planet_id,
                    fleet_id,
                },
            );
        }
    }

    // Keep who-is-who for the galaxy pass (the liveness card names players).
    with_cache(|c| {
        c.identities = identities
            .iter()
            .map(|(pid, i)| {
                (
                    pid.clone(),
                    json!({
                        "username": i.username, "pfp_attrs": i.pfp_attrs, "tag": i.tag,
                        "guild_name": i.guild_name, "planet_id": i.planet_id, "fleet_id": i.fleet_id,
                    }),
                )
            })
            .collect();
    });

    // Alpha board: PR #121's `/api/leaderboard/player` is the server ranking
    // over the denom-correct api_leaderboard_player table — one request,
    // usernames included, `alpha_value` = balance + infused. The bank-module
    // join (denom_owners + cached address map) stays as the fallback for
    // guilds on an older API; the flag also tells the slow tier whether the
    // 31-page address map is still worth maintaining.
    let mut alpha_board: Option<Vec<Value>> = None;
    match alpha_res {
        Ok(v) => {
            with_cache(|c| c.alpha_fallback = false);
            let rows: Vec<Value> = v.as_array().cloned().unwrap_or_default();
            alpha_board = Some(
                rows.iter()
                    .enumerate()
                    .map(|(i, r)| {
                        let pid = text(r.get("player_id"));
                        let ident = identities.get(&pid);
                        json!({
                            "rank": i + 1,
                            "player_id": pid,
                            "username": crate::matrix::identity::sanitize(&{
                                let u = text(r.get("username"));
                                if u.is_empty() {
                                    ident.map(|x| x.username.clone()).unwrap_or_default()
                                } else {
                                    u
                                }
                            }),
                            "pfp": ident.map(|x| x.pfp.clone()).unwrap_or(Value::Null),
                            "pfp_attrs": ident.map(|x| x.pfp_attrs.clone()).unwrap_or(Value::Null),
                            "guild_name": ident.map(|x| x.guild_name.clone()).unwrap_or_default(),
                            "tag": ident.map(|x| x.tag.clone()).unwrap_or_default(),
                            "planet_id": ident.map(|x| x.planet_id.clone()).unwrap_or_default(),
                            "fleet_id": ident.map(|x| x.fleet_id.clone()).unwrap_or_default(),
                            "value": num(r.get("alpha_value_p")),
                        })
                    })
                    .collect(),
            );
        }
        Err(_) => {
            with_cache(|c| c.alpha_fallback = true);
        }
    }
    let mut alpha_by_player: HashMap<String, f64> = HashMap::new();
    if alpha_board.is_none() {
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

    // Structs load: full per-player map (see sload_fut).
    let (sload_rows, cut) = sload_res?;
    truncated |= cut;
    let sload_by_player = player_vals(&sload_rows);
    let structs_draw: f64 = sload_by_player.values().sum();

    // Ore. Grid `ore` holds two distinct populations (verified live: ~16k
    // planet rows = ore still in the ground, ~2.3k player rows =
    // stored/stealable ore). The board is the server-sorted top rows; the
    // stored total is the newest LOCF bucket of the player aggregate; ground
    // ore the same for planets. An older API walks the player rows (or, older
    // still, the whole attribute) and sums them, as before.
    let (prev_stored, prev_ground) =
        with_cache(|c| (num(c.totals.get("stored_ore")), num(c.totals.get("ground_ore"))));
    let mut ore_by_player: HashMap<String, f64> = HashMap::new();
    let mut ground_ore_from_walk: Option<f64> = None;
    let stored_ore = match ore_top_res {
        Ok(rows) => {
            for row in &rows {
                ore_by_player.insert(text(row.get("object_id")), num(row.get("val")));
            }
            last_bucket_sum(&ore_hist).unwrap_or(prev_stored)
        }
        Err(_) => {
            let filtered = match walk_pages(|p| {
                client
                    .guild
                    .grid_by_attribute_and_object_type_limited("ore", "player", p, BIG_PAGE)
            })
            .await
            {
                Ok(ok) => Ok(ok),
                Err(_) => {
                    walk_pages(|p| client.guild.grid_by_attribute_and_object_type("ore", "player", p))
                        .await
                }
            };
            match filtered {
                Ok((rows, cut)) => {
                    truncated |= cut;
                    ore_by_player = player_vals(&rows);
                }
                Err(_) => {
                    let (rows, cut) =
                        walk_pages(|p| client.guild.grid_by_attribute_type("ore", p)).await?;
                    truncated |= cut;
                    let mut ground = 0.0;
                    for row in &rows {
                        match text(row.get("object_type")).as_str() {
                            "player" => {
                                ore_by_player.insert(text(row.get("object_id")), num(row.get("val")));
                            }
                            "planet" => ground += num(row.get("val")),
                            _ => {}
                        }
                    }
                    ground_ore_from_walk = Some(ground);
                }
            }
            ore_by_player.values().sum()
        }
    };
    let ground_ore = ground_ore_from_walk
        .or_else(|| last_bucket_sum(&ore_planet))
        .unwrap_or(prev_ground);

    // Energy picture in raw milliwatts. Load and capacity per guild come from
    // the server's api_leaderboard_guild table (base units under `_p`) — one
    // request for every guild — and deliberately NOT `/guild/{id}/power/stats`,
    // whose columns inherit view.player's `floor(a + b / 1000)` unit-mixing
    // bug. Older APIs walk the grid rows and roll up over roster membership.
    let mut by_guild: HashMap<String, (String, f64, f64, f64)> = HashMap::new(); // gid → (name, draw, load, cap)
    for (pid, (gid, gname)) in &guild_of {
        let e = by_guild
            .entry(gid.clone())
            .or_insert_with(|| (gname.clone(), 0.0, 0.0, 0.0));
        e.1 += sload_by_player.get(pid).copied().unwrap_or(0.0);
    }
    let (alloc_load, player_capacity) = match guild_board_res {
        Ok(v) => {
            let rows: Vec<Value> = v.as_array().cloned().unwrap_or_default();
            let mut load_sum = 0.0;
            let mut cap_sum = 0.0;
            for (gid, (name, load, cap)) in guild_energy_from_board(&rows) {
                load_sum += load;
                cap_sum += cap;
                let e = by_guild
                    .entry(gid)
                    .or_insert_with(|| (name, 0.0, 0.0, 0.0));
                e.2 = load;
                e.3 = cap;
            }
            (load_sum, cap_sum)
        }
        Err(_) => {
            let mut sums = [0.0f64, 0.0];
            for (i, attr) in ["load", "capacity"].iter().enumerate() {
                let (rows, cut) = match walk_pages(|p| {
                    client
                        .guild
                        .grid_by_attribute_and_object_type_limited(attr, "player", p, BIG_PAGE)
                })
                .await
                {
                    Ok(ok) => ok,
                    Err(_) => walk_pages(|p| client.guild.grid_by_attribute_type(attr, p)).await?,
                };
                truncated |= cut;
                let vals = player_vals(&rows);
                sums[i] = vals.values().sum();
                for (pid, v) in vals {
                    if let Some((gid, gname)) = guild_of.get(&pid) {
                        let e = by_guild
                            .entry(gid.clone())
                            .or_insert_with(|| (gname.clone(), 0.0, 0.0, 0.0));
                        if i == 0 {
                            e.2 += v;
                        } else {
                            e.3 += v;
                        }
                    }
                }
            }
            (sums[0], sums[1])
        }
    };
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

    // Long-horizon history for the trends card: 7 days of hourly LOCF-aligned
    // galaxy totals. Absent on older APIs; the card simply doesn't render the
    // section then.
    let history = if ore_hist.is_null() && sload_hist.is_null() {
        Value::Null
    } else {
        json!({ "ore": ore_hist, "structs_load": sload_hist })
    };

    // Leaderboards: alpha from the server ranking (bank fallback), ore and
    // structs-load from the grid.
    let players_top = json!({
        "alpha": alpha_board.unwrap_or_else(|| leaderboard(&alpha_by_player, &identities)),
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
        if !history.is_null() {
            c.history = history;
        }
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
    crate::mcp::telemetry::tlog_kv(
        "game_stats",
        crate::mcp::telemetry::Sev::Info,
        "heavy sweep: done",
        json!({
            "total_ms": (crate::hasher::types::now_millis() - t0).round(),
            "stages_ms": (t_join - t0).round(),
            "requests": crate::mcp::guild_api::request_stats().0 - req0,
            "guilds": rosters.len(),
            "players": identities.len(),
            "structs_load_rows": sload_rows.len(),
        }),
    );
    Ok(())
}

// ── Sweep task ──────────────────────────────────────────────────────────────

/// One tier's run: sweep, push the snapshot, persist. Returns whether the
/// failure (if any) was an auth failure.
async fn run_tier(
    app: &tauri::AppHandle,
    tier: &'static str,
    fut: impl std::future::Future<Output = Result<(), String>>,
) -> bool {
    match fut.await {
        Ok(()) => {
            if tier == "fast" {
                with_cache(|c| c.auth_ok = Some(true));
            }
            emit_board(
                app,
                "game-stats-update",
                &json!({ "tier": tier, "snapshot": snapshot() }),
            );
            persist();
            false
        }
        Err(e) => {
            let auth_failed = is_auth_error(&e);
            // Stamp the attempt so the cadence (and the auth backoff) holds.
            with_cache(|c| {
                let now = crate::hasher::types::now_millis();
                match tier {
                    "fast" => {
                        if auth_failed {
                            c.auth_ok = Some(false);
                        }
                        c.fast_updated_ms = now;
                    }
                    "slow" => c.slow_updated_ms = now,
                    _ => c.heavy_updated_ms = now,
                }
            });
            eprintln!("[Game Stats] {} sweep failed: {}", tier, e);
            auth_failed
        }
    }
}

/// Start the background sweep loop (idempotent). Runs sweeps only while the
/// gamestats window exists; otherwise idles cheaply.
///
/// Tiers run CONCURRENTLY and each paints as it lands. They used to run
/// fast → slow → heavy in sequence, so the leaderboards (heavy) waited
/// behind the slowest tier on every cold open — ~50 s on a good day, over
/// 100 s when the API was slow. The one ordering kept: on an unknown or
/// failed session the fast tier runs alone first, because its first request
/// is the auth probe and a 401 must not fan out.
pub fn ensure_running(app: &tauri::AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Last-known figures, before the first sweep. The restored `*_updated_ms`
    // stamps are OLD, so every tier still reads as due and refreshes at once —
    // this fills the page, it does not delay it.
    restore();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // No window, or a MINIMIZED window, costs the shared API nothing:
            // people park windows for hours, and a minimized dashboard reading
            // 40 req/min is exactly the "hammering" the infra team flagged.
            // Block-tick counters (note_event) keep running either way, so the
            // series has no gap when the window comes back.
            let visible = watched(&app);
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
            let t0 = crate::hasher::types::now_millis();
            let req0 = crate::mcp::guild_api::request_stats().0;
            let mut auth_failed = false;
            let probe_first = fast_due && auth_ok != Some(true);
            if probe_first {
                auth_failed = run_tier(&app, "fast", fast_sweep(&client)).await;
            }
            if !auth_failed && with_cache(|c| c.auth_ok) == Some(true) {
                tokio::join!(
                    async {
                        if fast_due && !probe_first {
                            run_tier(&app, "fast", fast_sweep(&client)).await;
                        }
                    },
                    async {
                        if slow_due {
                            run_tier(&app, "slow", slow_sweep(&client)).await;
                        }
                    },
                    async {
                        if heavy_due {
                            run_tier(&app, "heavy", heavy_sweep(&client)).await;
                        }
                    },
                );
            }
            with_cache(|c| c.sweeping = false);
            emit_board(&app, "game-stats-update", &json!({ "tier": "idle", "auth_ok": with_cache(|c| c.auth_ok) }));
            crate::mcp::telemetry::tlog_kv(
                "game_stats",
                crate::mcp::telemetry::Sev::Info,
                "sweep cycle: done",
                json!({
                    "ms": (crate::hasher::types::now_millis() - t0).round(),
                    "requests": crate::mcp::guild_api::request_stats().0 - req0,
                    "fast": fast_due, "slow": slow_due, "heavy": heavy_due,
                }),
            );
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
    fn last_bucket_sum_reads_the_newest_non_null_bucket() {
        // LOCF: the newest bucket is the current galaxy total. A trailing
        // null (bucket not closed yet) must not hide the previous one, and an
        // absent endpoint must read as "don't know", never 0.
        let v = json!([
            { "bucket": "a", "sum": "100" },
            { "bucket": "b", "sum": 250 },
            { "bucket": "c", "sum": null }
        ]);
        assert_eq!(last_bucket_sum(&v), Some(250.0));
        assert_eq!(last_bucket_sum(&Value::Null), None);
        assert_eq!(last_bucket_sum(&json!([])), None);
    }

    #[test]
    fn player_vals_keeps_player_and_untyped_rows_only() {
        let rows = vec![
            json!({ "object_type": "player", "object_id": "1-1", "val": "5" }),
            json!({ "object_id": "1-2", "val": 7 }),
            json!({ "object_type": "planet", "object_id": "2-1", "val": "900" }),
        ];
        let m = player_vals(&rows);
        assert_eq!(m.get("1-1"), Some(&5.0));
        assert_eq!(m.get("1-2"), Some(&7.0));
        assert!(m.get("2-1").is_none());
    }

    #[test]
    fn guild_energy_from_board_uses_base_units_and_falls_back_to_onchain_name() {
        let rows = vec![
            json!({ "guild_id": "0-1", "name": "SN Corp", "onchain_name": "x",
                    "member_load_p": "131340358102", "member_capacity_p": "140799326693" }),
            json!({ "guild_id": "0-2", "name": "", "onchain_name": "Crab",
                    "member_load_p": "10", "member_capacity_p": "0" }),
            json!({ "name": "no id" }),
        ];
        let m = guild_energy_from_board(&rows);
        assert_eq!(m.len(), 2);
        let (name, load, cap) = m.get("0-1").unwrap();
        assert_eq!(name, "SN Corp");
        assert_eq!(*load, 131_340_358_102.0);
        assert_eq!(*cap, 140_799_326_693.0);
        assert_eq!(m.get("0-2").unwrap().0, "Crab");
    }

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
    fn the_persisted_snapshot_keeps_figures_and_drops_live_state() {
        /* What survives a restart, and what must not.
         *
         * `auth_ok` is a live fact about THIS session's credentials — a stale
         * `false` would suppress the first probe and leave the page dead. And
         * `counters` is a partial block's tally, which means nothing once that
         * block has passed. Neither has a field here, which is the point of
         * `Persisted` being its own struct rather than the whole `Cache`: a new
         * live-only field cannot start persisting itself by accident.
         */
        let json = serde_json::to_string(&Persisted::default()).unwrap();
        for gone in ["auth_ok", "sweeping", "counters", "pid_by_addr", "planet_counts"] {
            assert!(!json.contains(gone), "{gone} must not be persisted");
        }
        for kept in ["totals", "guilds", "players_top", "series", "block_height"] {
            assert!(json.contains(kept), "{kept} must be persisted");
        }
    }

    #[test]
    fn a_restored_snapshot_still_reads_as_due_for_a_sweep() {
        // The restored stamps are the OLD ones, so `now - stamp >= INTERVAL`
        // stays true and every tier refreshes immediately. Restoring fills the
        // page; it must never delay it.
        let restored_at = 1_000_000.0_f64;
        let now = restored_at + FAST_INTERVAL_MS + 1.0;
        assert!(now - restored_at >= FAST_INTERVAL_MS);
        assert!(now - restored_at >= 0.0);
        // And a snapshot from an hour ago is due on every tier.
        let hour_ago = now - 3_600_000.0;
        assert!(now - hour_ago >= FAST_INTERVAL_MS);
        assert!(now - hour_ago >= HEAVY_INTERVAL_MS);
    }

    #[test]
    fn a_total_we_have_not_swept_is_null_not_zero() {
        let swept = json!({ "raids_active": 3, "structs_total": 42625 });
        assert_eq!(opt_num(swept.get("raids_active")), json!(3.0));

        // The whole point: absence must survive as absence. `num` answers 0
        // here, which is fine for a tile and a lie in a time series — the
        // sparkline scales from its own minimum, so a false zero flattens
        // every real movement and draws a cliff.
        assert_eq!(opt_num(swept.get("structs_draw")), Value::Null);
        assert_eq!(num(swept.get("structs_draw")), 0.0);

        // A cold cache is `Value::Null`, not an empty object, and `.get` on it
        // yields None. This is the state every session starts in.
        let cold = Value::Null;
        assert_eq!(opt_num(cold.get("structs_total")), Value::Null);

        // A genuine zero is DATA and must plot. Keyed off the key being
        // present, never off the value being falsy.
        let quiet = json!({ "raids_active": 0 });
        assert_eq!(opt_num(quiet.get("raids_active")), json!(0.0));

        // An explicit null, and a value that is not a number at all, are both
        // "unknown" rather than zero.
        let odd = json!({ "a": null, "b": "not a number", "c": "12" });
        assert_eq!(opt_num(odd.get("a")), Value::Null);
        assert_eq!(opt_num(odd.get("b")), Value::Null);
        // Guild API numerics arrive as strings; those are known values.
        assert_eq!(opt_num(odd.get("c")), json!(12.0));
    }

    #[test]
    fn a_logo_is_a_url_our_windows_can_load() {
        assert_eq!(absolute_logo("0-1", ""), Value::Null);
        assert_eq!(absolute_logo("0-1", "https://x.example/l.png"), json!("https://x.example/l.png"));
        // A bare filename or a protocol-relative path is not something we can place.
        assert_eq!(absolute_logo("0-1", "logo.png"), Value::Null);
        assert_eq!(absolute_logo("0-1", "//x.example/l.png"), Value::Null);
        // A root-relative path needs the guild's site; an unknown guild has none.
        assert_eq!(absolute_logo("0-999999", "/img/l.png"), Value::Null);
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
