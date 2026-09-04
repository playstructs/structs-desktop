//! Shared scaffolding for the native auto-loops (`auto_harvest`, `auto_build`).
//! The loops each fan out a per-player body across the vplayer roster; this
//! module holds the one piece they share today — a bounded-concurrency runner —
//! so a long scan touches every player in the same wave instead of serially
//! (which starved the tail cohort).

use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use tokio::task::JoinSet;

use crate::mcp::cosmos_client::CosmosClient;

// ── Shared JSON coercion helpers ──
// The chain/guild APIs return numerics as either JSON numbers or strings and
// booleans as either bools or "true"/"false" strings; these normalize both.

/// Coerce an optional JSON value to f64 (number or numeric string), else 0.0.
pub fn parse_f64(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Coerce an optional JSON value to bool (`true` or "true"), else false.
pub fn parse_bool(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// Read a u64 sub-field (number or numeric string) from an optional JSON object,
/// else 0 — used for the block-anchor / lastAction fields.
pub fn read_u64_field(v: Option<&Value>, field: &str) -> u64 {
    v.and_then(|x| x.get(field))
        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}

/// Read a PLANET entity's shared ore clock — the block a MINE or REFINE proof
/// anchors on. Zero means the clock is clear and there is nothing to hash.
///
/// Chain v0.21.0 moved these clocks off the struct and onto the planet: one
/// clock per planet, shared by every eligible rig standing on it. The struct's
/// own `blockStartOre*` fields survive for wire compatibility and permanently
/// read 0, so a reader still pointed at the struct anchors on 0 and silently
/// does no work — which is exactly how the harvest leg went dark for 38 hours
/// after the upgrade. Route every ore anchor read through here so there is one
/// place to change if the clock ever moves again.
pub fn planet_ore_anchor(planet: Option<&Value>, task_type: &str) -> u64 {
    let field = match task_type {
        "MINE" => "blockStartOreMine",
        "REFINE" => "blockStartOreRefine",
        _ => return 0,
    };
    read_u64_field(planet.and_then(|p| p.get("planetAttributes")), field)
}

/// Struct type id as a string, from `"type"` or the `"struct_type"` fallback,
/// accepting either a JSON number or string. Empty when neither is present.
pub fn extract_type_id(s: &Value) -> String {
    s.get("type")
        .or_else(|| s.get("struct_type"))
        .map(|x| match x {
            Value::Number(n) => n.to_string(),
            Value::String(t) => t.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// Resolve a player's OWN struct ids from its planet + fleet entity slot arrays.
///
/// The guild `struct/list/owner` AND `struct/list/location` endpoints are broken:
/// both IGNORE their filter path segment and return a global page-1 of ALL
/// structs (verified live — querying any owner/location returns the same first
/// 100 struct ids, `total` ≈ every struct in the game). So they cannot enumerate
/// a specific vplayer's structs, which silently broke auto_harvest/auto_defend
/// (they scanned other players' structs) and made auto_build over-build.
///
/// Planets and fleets, however, list their occupant struct ids directly in the
/// `land`/`water`/`air`/`space` slot arrays of their ENTITY (LCD data, which we
/// read correctly). Union those and you have exactly the player's structs.
/// Returns `[]` on any resolve error (caller treats it as "nothing to act on").
pub async fn player_struct_ids(client: &CosmosClient, pid: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let Ok(player) = client.query_entity("player", pid).await else {
        return ids;
    };
    let p = player.get("Player");
    let planet_id = p
        .and_then(|x| x.get("planetId"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let fleet_id = p
        .and_then(|x| x.get("fleetId"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    for (kind, wrapper, loc) in [
        ("planet", "Planet", planet_id),
        ("fleet", "Fleet", fleet_id),
    ] {
        if loc.is_empty() {
            continue;
        }
        if let Ok(e) = client.query_entity(kind, loc).await {
            let obj = e.get(wrapper);
            for ambit in ["land", "water", "air", "space"] {
                if let Some(arr) = obj.and_then(|o| o.get(ambit)).and_then(|a| a.as_array()) {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            if !s.is_empty() {
                                ids.push(s.to_string());
                            }
                        }
                    }
                }
            }
            // The fleet's Command Ship lives in the `commandStruct` field, NOT in
            // the land/water/air/space slot arrays. Without this the resolver never
            // sees it, so callers thought the player had no Command Ship — auto_build
            // kept trying to build a second one (a 1-per-player struct → endless
            // "cannot handle new load (required:1, available:1)" count-cap rejects)
            // and auto_defend couldn't protect it. Include it explicitly.
            if kind == "fleet" {
                if let Some(cs) = obj.and_then(|o| o.get("commandStruct")).and_then(|c| c.as_str()) {
                    if !cs.is_empty() {
                        ids.push(cs.to_string());
                    }
                }
            }
        }
    }
    // De-dup (order-preserving) in case a struct is ever listed in both a slot
    // array and commandStruct — avoids double-querying it in player_structs.
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    ids
}

/// Like [`player_struct_ids`], but returns each struct as a FLAT, list-shaped
/// item — the snake_case shape the auto-loops used to get from the (broken)
/// guild struct-list: `id`, `type`, `type_name`, `location_type`,
/// `operating_ambit`, `slot`, `is_destroyed`. Built by reading each struct's
/// ENTITY (one LCD read per struct) and remapping its camelCase fields. Use this
/// where a loop needs per-struct location/ambit/slot/type_name (auto_build slot
/// detection, auto_defend combat-struct classification); use `player_struct_ids`
/// where the loop re-queries the entity itself anyway (auto_harvest).
pub async fn player_structs(client: &CosmosClient, pid: &str) -> Vec<Value> {
    let ids = player_struct_ids(client, pid).await;
    let mut out = Vec::with_capacity(ids.len());
    for sid in ids {
        let Ok(e) = client.query_entity("struct", &sid).await else {
            continue;
        };
        let s = e.get("Struct");
        let sa = e.get("structAttributes");
        let get = |k: &str| s.and_then(|x| x.get(k)).cloned().unwrap_or(Value::Null);
        out.push(serde_json::json!({
            "id": get("id"),
            "type": get("type"),
            "type_name": get("type_name"),
            "location_type": get("locationType"),
            // Combat is co-located: a struct can only be attacked by something at
            // the same planet (the raider's fleet parks there), so shooter
            // selection needs the location id, not just its kind.
            "location_id": get("locationId"),
            "operating_ambit": get("operatingAmbit"),
            // LCD numerics are STRINGS ("slot": "1"); coerce to a real number
            // here so consumers' as_u64() works. A raw copy made every struct
            // read as slot 0 → auto_build picked "free" slot 1 on planets whose
            // slot 1 was occupied → a permanent chain-reject loop (3.6k dead
            // txs/hour across the fleet before structs_system surfaced it).
            "slot": read_u64_field(s, "slot"),
            "is_destroyed": Value::Bool(parse_bool(sa.and_then(|x| x.get("isDestroyed")))),
            // Built vs still-under-construction — auto_build's command-first
            // gate needs to know a replacement Command Ship isn't online yet.
            "is_built": Value::Bool(parse_bool(sa.and_then(|x| x.get("isBuilt")))),
        }));
    }
    out
}

/// TTL'd cache behind [`player_structs`]. `player_structs` costs 3 + N LCD reads
/// per player, which is fine for a per-player loop body but ruinous for anything
/// that sweeps the WHOLE roster (180 vplayers ≈ 1,000+ requests per pass) —
/// exactly what team-wide strike planning and the combat loops need to do.
///
/// The cached data is composition (type / ambit / slot / built / destroyed),
/// which only changes when a struct is built or dies — both of which invalidate
/// explicitly. Anything needing live HP or `protectedStructIndex` must still
/// read the entity itself.
/// (fetched_at_ms, the player's structs).
type CachedStructs = (f64, Vec<Value>);
static STRUCTS_CACHE: LazyLock<Mutex<HashMap<String, CachedStructs>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Default freshness for the struct-composition cache (10 min).
pub const STRUCTS_CACHE_TTL_MS: f64 = 600_000.0;

/// [`player_structs`], memoised for `ttl_ms`. Use from roster-wide sweeps.
pub async fn player_structs_cached(client: &CosmosClient, pid: &str, ttl_ms: f64) -> Vec<Value> {
    let now = crate::hasher::types::now_millis();
    if let Ok(c) = STRUCTS_CACHE.lock() {
        if let Some((at, v)) = c.get(pid) {
            if now - *at < ttl_ms {
                return v.clone();
            }
        }
    }
    let fresh = player_structs(client, pid).await;
    // Don't cache an empty result: it's indistinguishable from a failed resolve,
    // and caching it would blind every sweep for the whole TTL.
    if !fresh.is_empty() {
        if let Ok(mut c) = STRUCTS_CACHE.lock() {
            c.insert(pid.to_string(), (now, fresh.clone()));
        }
    }
    fresh
}

/// Drop a player's cached composition — call after a build completes or a
/// struct is destroyed, so the next sweep sees the new fleet.
pub fn invalidate_player_structs(pid: &str) {
    if let Ok(mut c) = STRUCTS_CACHE.lock() {
        c.remove(pid);
    }
}

/// Drop every player's cached composition.
pub fn invalidate_all_player_structs() {
    if let Ok(mut c) = STRUCTS_CACHE.lock() {
        c.clear();
    }
}

// ── Scan reads: perception snapshot first, chain otherwise ──────────────────
//
// The auto-loops split their reads in two. SCAN reads decide which players
// and structs are candidates (fleet-wide, thousands per pass); VERIFY reads
// happen once per action, right before a sign, and always go to the chain.
// These helpers serve the SCAN half from `mcp::perception`'s whole-galaxy
// snapshot when it is fresh, and transparently fall back to the LCD when it
// is not (no snapshot yet, refresh failed, GRASS went quiet). A loop written
// against them behaves exactly as before until a snapshot exists, and never
// scans from a stale one.

/// A snapshot older than this is not scanned from, whatever GRASS says: the
/// refresh cadence is ~10 min, so this is "two missed refreshes".
pub const PERCEPTION_MAX_AGE_MS: f64 = 20.0 * 60_000.0;
/// If no GRASS frame has been folded in for this long, the feed is presumed
/// dead (the signing-bridge-death tell is exactly a decaying grass stream)
/// and the snapshot is treated as stale from that moment.
pub const PERCEPTION_MAX_EVENT_GAP_MS: f64 = 120_000.0;

/// Where a scan read was served from — surfaced in loop summaries so a
/// silent fallback to the chain is visible, not inferred from timings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadSource {
    Snapshot,
    Chain,
}

/// The freshness rule, pure so it is testable: a snapshot is scannable when
/// it is younger than [`PERCEPTION_MAX_AGE_MS`] AND the GRASS feed is alive —
/// either a frame landed within [`PERCEPTION_MAX_EVENT_GAP_MS`] or the
/// snapshot itself is younger than that gap (a quiet galaxy right after a
/// refresh is fine; a quiet feed an hour later is not).
pub fn perception_is_fresh(age_ms: f64, last_event_age_ms: Option<f64>) -> bool {
    if age_ms < 0.0 || age_ms >= PERCEPTION_MAX_AGE_MS {
        return false;
    }
    match last_event_age_ms {
        Some(gap) => gap < PERCEPTION_MAX_EVENT_GAP_MS,
        None => age_ms < PERCEPTION_MAX_EVENT_GAP_MS,
    }
}

/// Wait (bounded) for a scannable snapshot before a scan fans out.
///
/// Without this, a scan that starts before the launch refresh has landed
/// reads every player's structs from the chain: measured 2026-09-04, ~59,000
/// LCD requests in the first three minutes of a 0.1.330 launch — the single
/// worst thing this app does to the shared node, and it happened at EVERY
/// launch and guild switch. A refresh takes ~4 s from the guild and ~8 s from
/// the LCD; waiting for it costs one scan a few seconds. Returns whether the
/// snapshot is usable; a `false` means the caller's chain fallback will run,
/// and says so loudly.
pub async fn ensure_perception(client: &CosmosClient, loop_name: &'static str, max_wait_ms: f64) -> bool {
    if perception_usable_now() {
        return true;
    }
    let t0 = crate::hasher::types::now_millis();
    crate::mcp::perception::request_refresh(client);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if perception_usable_now() {
            let waited = crate::hasher::types::now_millis() - t0;
            if waited > 2_000.0 {
                crate::mcp::telemetry::tlog(
                    loop_name,
                    crate::mcp::telemetry::Sev::Info,
                    format!("waited {:.1}s for the perception snapshot before scanning", waited / 1000.0),
                );
            }
            return true;
        }
        if crate::hasher::types::now_millis() - t0 > max_wait_ms {
            crate::mcp::telemetry::tlog(
                loop_name,
                crate::mcp::telemetry::Sev::Warn,
                format!(
                    "perception snapshot still not scannable after {:.0}s — this scan reads the CHAIN per player (refreshing: {})",
                    max_wait_ms / 1000.0,
                    crate::mcp::perception::is_refreshing()
                ),
            );
            return false;
        }
        if !crate::mcp::perception::is_refreshing() && !perception_usable_now() {
            // The refresh finished without producing a usable snapshot (failed,
            // or the feed is quiet); kick another rather than idle out.
            crate::mcp::perception::request_refresh(client);
        }
    }
}

fn perception_usable_now() -> bool {
    let now = crate::hasher::types::now_millis();
    crate::mcp::perception::with_snapshot(|s| {
        let gap = if s.last_event_ms > 0.0 { Some(now - s.last_event_ms) } else { None };
        perception_is_fresh(now - s.taken_ms, gap)
    })
    .unwrap_or(false)
}

/// Scan-time entity read: `query_entity` shape, snapshot-first. `kind` is
/// one of `struct` / `planet` / `player` / `fleet`. An object the snapshot
/// does not know (created since the refresh, or pruned) falls through to the
/// chain, so a fresh id is never mistaken for a missing one.
pub async fn scan_entity(client: &CosmosClient, kind: &str, id: &str) -> Result<(Value, ReadSource), String> {
    if perception_usable_now() {
        let hit = crate::mcp::perception::with_snapshot(|s| match kind {
            "struct" => s.struct_entity(id),
            "planet" => s.planet_entity(id),
            "player" => s.player_entity(id),
            "fleet" => s.fleet_entity(id),
            _ => None,
        })
        .flatten();
        if let Some(v) = hit {
            return Ok((v, ReadSource::Snapshot));
        }
    }
    client.query_entity(kind, id).await.map(|v| (v, ReadSource::Chain))
}

/// Scan-time [`player_struct_ids`], snapshot-first.
pub async fn scan_player_struct_ids(client: &CosmosClient, pid: &str) -> (Vec<String>, ReadSource) {
    if perception_usable_now() {
        if let Some(ids) = crate::mcp::perception::with_snapshot(|s| s.player_struct_ids(pid)) {
            if !ids.is_empty() {
                return (ids, ReadSource::Snapshot);
            }
        }
    }
    (player_struct_ids(client, pid).await, ReadSource::Chain)
}

/// Scan-time [`player_structs`], snapshot-first.
pub async fn scan_player_structs(client: &CosmosClient, pid: &str) -> (Vec<Value>, ReadSource) {
    if perception_usable_now() {
        if let Some(v) = crate::mcp::perception::with_snapshot(|s| s.player_structs(pid)) {
            if !v.is_empty() {
                return (v, ReadSource::Snapshot);
            }
        }
    }
    (player_structs(client, pid).await, ReadSource::Chain)
}

/// VERIFY read: always the chain, and the result is folded back into the
/// snapshot so the next scan already reflects it. Use this for the one read
/// a loop does right before signing.
pub async fn verify_struct_entity(client: &CosmosClient, sid: &str) -> Result<Value, String> {
    let v = client.query_entity("struct", sid).await?;
    crate::mcp::perception::absorb_struct_entity(&v);
    Ok(v)
}

/// Max player bodies in flight per scan. Each body does a handful of LCD reads
/// and possibly one webview sign, so this also caps simultaneous LCD requests
/// and sign events. 8–12 is the working band. This is the CEILING; the live
/// value is `effective_max_concurrent()`, which AIMD-adjusts itself downward
/// when the node shows pressure (429s/timeouts) and recovers one step per
/// clean scan — no more manual constant-editing when the endpoint struggles.
pub const MAX_CONCURRENT_PLAYERS: usize = 10;

/// AIMD floor — never drop below this or long scans starve entirely.
const MIN_CONCURRENT_PLAYERS: usize = 2;
/// Halve when this many pressure failures land inside the window…
const FAILURE_WINDOW_MS: f64 = 60_000.0;
const FAILURES_TO_HALVE: usize = 3;
/// …but at most once per window (debounce), so one burst = one halving.
static EFFECTIVE_MAX: AtomicUsize = AtomicUsize::new(MAX_CONCURRENT_PLAYERS);
static RECENT_FAILURES: std::sync::LazyLock<std::sync::Mutex<std::collections::VecDeque<f64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::VecDeque::new()));
static LAST_HALVE_MS: std::sync::LazyLock<std::sync::Mutex<f64>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(0.0));

/// The live fan-out cap. Loops pass this (not `MAX_CONCURRENT_PLAYERS`) to
/// `for_each_player_concurrent`.
pub fn effective_max_concurrent() -> usize {
    EFFECTIVE_MAX.load(Ordering::Relaxed)
}

/// Endpoint-pressure signal (429 / timeout / bridge failure), fed by
/// `tx_retry` and `CosmosClient`. Multiplicative decrease: halve (floor
/// MIN_CONCURRENT_PLAYERS) when failures cluster.
pub fn report_failure() {
    let now = crate::hasher::types::now_millis();
    let mut window = RECENT_FAILURES.lock().unwrap();
    window.push_back(now);
    while window.front().is_some_and(|t| now - *t > FAILURE_WINDOW_MS) {
        window.pop_front();
    }
    if window.len() >= FAILURES_TO_HALVE {
        let mut last = LAST_HALVE_MS.lock().unwrap();
        if now - *last >= FAILURE_WINDOW_MS {
            *last = now;
            let cur = EFFECTIVE_MAX.load(Ordering::Relaxed);
            let next = (cur / 2).max(MIN_CONCURRENT_PLAYERS);
            if next < cur {
                EFFECTIVE_MAX.store(next, Ordering::Relaxed);
                crate::mcp::telemetry::tlog_kv(
                    "auto",
                    crate::mcp::telemetry::Sev::Warn,
                    "endpoint pressure: lowering loop concurrency",
                    serde_json::json!({ "from": cur, "to": next, "failures_in_window": window.len() }),
                );
            }
        }
    }
}

/// Additive increase: a scan finished with zero errors → +1 toward the ceiling.
pub fn report_clean_scan() {
    let cur = EFFECTIVE_MAX.load(Ordering::Relaxed);
    if cur < MAX_CONCURRENT_PLAYERS {
        EFFECTIVE_MAX.store(cur + 1, Ordering::Relaxed);
    }
}

/// Run `body` for every target with at most `max` in flight. Each task gets an
/// owned target; bodies are independent (no shared borrows). A panicking body is
/// logged, not propagated, so one bad player can't abort the wave.
pub async fn for_each_player_concurrent<T, F, Fut>(targets: Vec<T>, max: usize, body: F)
where
    T: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + Clone + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let max = max.max(1);
    let mut it = targets.into_iter();
    let mut set: JoinSet<()> = JoinSet::new();
    for _ in 0..max {
        // prime up to `max`
        match it.next() {
            Some(t) => {
                let b = body.clone();
                set.spawn(async move { b(t).await });
            }
            None => break,
        }
    }
    while let Some(res) = set.join_next().await {
        // steady state: drain one, admit one
        if let Err(e) = res {
            eprintln!("[loop_util] player task failed: {e}");
        }
        if let Some(t) = it.next() {
            let b = body.clone();
            set.spawn(async move { b(t).await });
        }
    }
}

/// Like [`for_each_player_concurrent`], but collects each body's return value.
/// Ordering is NOT preserved (results arrive as tasks finish); a panicking body
/// is logged and simply contributes no result.
pub async fn map_concurrent<T, R, F, Fut>(targets: Vec<T>, max: usize, body: F) -> Vec<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + Clone + 'static,
    Fut: Future<Output = R> + Send + 'static,
{
    let max = max.max(1);
    let mut it = targets.into_iter();
    let mut set: JoinSet<R> = JoinSet::new();
    let mut out = Vec::new();
    for _ in 0..max {
        match it.next() {
            Some(t) => {
                let b = body.clone();
                set.spawn(async move { b(t).await });
            }
            None => break,
        }
    }
    while let Some(res) = set.join_next().await {
        match res {
            Ok(r) => out.push(r),
            Err(e) => eprintln!("[loop_util] mapped task failed: {e}"),
        }
        if let Some(t) = it.next() {
            let b = body.clone();
            set.spawn(async move { b(t).await });
        }
    }
    out
}


// ── Per-block charge ledger ──────────────────────────────────────────────────
//
// A player may take ONE charged action per block. Our loops do not know about
// each other, and `auto_build`/`auto_defend`/`auto_harvest` all start within
// milliseconds and sweep the same roster concurrently for minutes — so two of
// them routinely reach the same player inside one block. The loser gets
// chain code **2022 "player has zero charge this block (already discharged)"**.
//
// Measured 2026-08-18: 24 such rejects in one hour from `auto_defend` alone,
// always the same handful of players (1-635, 1-566, 1-571, 1-324, 1-1038) —
// a guaranteed-loss race repeated every scan, each costing a signing slot and
// a transaction attempt for nothing.
//
// So charged actions are recorded centrally as they succeed, and a loop can ask
// whether a player has already spent this block before trying.

/// A block is ~5.28 s; round up so a marginally slow read still suppresses the
/// duplicate rather than letting it through to a certain reject.
pub const BLOCK_WINDOW_MS: f64 = 6_000.0;

/// Message types that consume a player's once-per-block charge. Deliberately a
/// short allow-list of types confirmed to cost charge: being conservative means
/// we occasionally fail to suppress a race, never that we wrongly withhold work.
const CHARGED_TYPES: &[&str] = &[
    "MsgStructBuildInitiate",
    "MsgStructDefenseSet",
    "MsgStructDefenseClear",
    "MsgStructAttack",
    "MsgFleetMove",
    "MsgStructMove",
];

pub fn is_charged_type(type_url: &str) -> bool {
    CHARGED_TYPES.iter().any(|t| type_url.ends_with(t))
}

static CHARGE_LEDGER: LazyLock<Mutex<HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Record that `player_id` has spent its charge for this block.
pub fn note_charged_action(player_id: &str) {
    if player_id.is_empty() {
        return;
    }
    if let Ok(mut m) = CHARGE_LEDGER.lock() {
        let now = crate::hasher::types::now_millis();
        // Opportunistic sweep so a long-running process does not accumulate an
        // entry per player forever.
        if m.len() > 4096 {
            m.retain(|_, at| now - *at < BLOCK_WINDOW_MS);
        }
        m.insert(player_id.to_string(), now);
    }
}

/// Charged signs that are QUEUED or IN FLIGHT, per player. A sign waits in
/// the admission gate (measured ~26 s at 17 deep) and then a full block for
/// inclusion, and the ledger above is stamped only when it lands — so for
/// half a minute a second loop verifying the same player saw a clean ledger,
/// passed its own pre-sign check, and queued a tx the chain was certain to
/// reject ("required charge of 8 but player only had 6": 12 in 45 min, each a
/// wasted 6 s sign slot AND a 30-minute initiate backoff). This set closes
/// that window: reserve at enqueue, release when the attempt is over.
static PENDING_CHARGE: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// RAII reservation of a player's charge for one queued sign. Dropping it
/// (success, failure, cancel) releases the reservation; `acted_this_block`
/// is true for the player while any reservation is alive.
pub struct ChargeReservation(String);

impl Drop for ChargeReservation {
    fn drop(&mut self) {
        if let Ok(mut m) = PENDING_CHARGE.lock() {
            match m.get_mut(&self.0) {
                Some(n) if *n > 1 => *n -= 1,
                _ => {
                    m.remove(&self.0);
                }
            }
        }
    }
}

/// Reserve `player_id`'s charge for a sign that is about to be queued.
pub fn reserve_charge(player_id: &str) -> Option<ChargeReservation> {
    if player_id.is_empty() {
        return None;
    }
    if let Ok(mut m) = PENDING_CHARGE.lock() {
        *m.entry(player_id.to_string()).or_insert(0) += 1;
    }
    Some(ChargeReservation(player_id.to_string()))
}

/// Has this player already taken — or queued — its one charged action this
/// block?
pub fn acted_this_block(player_id: &str) -> bool {
    if PENDING_CHARGE.lock().map(|m| m.contains_key(player_id)).unwrap_or(false) {
        return true;
    }
    CHARGE_LEDGER
        .lock()
        .map(|m| {
            m.get(player_id)
                .is_some_and(|at| crate::hasher::types::now_millis() - *at < BLOCK_WINDOW_MS)
        })
        .unwrap_or(false)
}

/// The player id embedded in a telemetry context like `auto_defend:1-635`.
pub fn player_from_context(context: &str) -> Option<&str> {
    context.split_once(':').map(|(_, p)| p).filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {

    /// Chain v0.21.0 moved the ore clocks from the struct to the planet. The
    /// struct's fields survive and read 0 forever, so a reader left pointed at
    /// them anchors on 0 — and every caller treats 0 as "no cycle, skip". That
    /// is silent: no error, no rejected tx, just a harvest loop scanning 28,812
    /// players an hour and starting nothing, for 38 hours before anyone noticed.
    /// These assertions pin the container so the regression can't come back
    /// wearing the same disguise.
    #[test]
    fn ore_anchor_comes_from_the_planet_not_the_struct() {
        use super::planet_ore_anchor;
        let planet = serde_json::json!({
            "planetAttributes": {
                "blockStartOreMine": "2273508",
                "blockStartOreRefine": "2275440",
            }
        });
        // Numeric strings are what the LCD actually returns for these.
        assert_eq!(planet_ore_anchor(Some(&planet), "MINE"), 2_273_508);
        assert_eq!(planet_ore_anchor(Some(&planet), "REFINE"), 2_275_440);

        // A STRUCT entity must never satisfy an ore anchor read, even though it
        // still carries the retired fields — this is the exact shape the chain
        // returns for a live, online, actively-refining rig.
        let struct_entity = serde_json::json!({
            "structAttributes": {
                "blockStartOreMine": "0",
                "blockStartOreRefine": "0",
                "isOnline": true,
            }
        });
        assert_eq!(planet_ore_anchor(Some(&struct_entity), "MINE"), 0);
        assert_eq!(planet_ore_anchor(Some(&struct_entity), "REFINE"), 0);

        // Non-ore task types have their anchors elsewhere and must not be
        // silently answered with an ore clock.
        assert_eq!(planet_ore_anchor(Some(&planet), "BUILD"), 0);
        assert_eq!(planet_ore_anchor(Some(&planet), "RAID"), 0);
        assert_eq!(planet_ore_anchor(None, "MINE"), 0);
    }

    /// The live failure: auto_build and auto_defend sweep the same roster
    /// concurrently, both reach one player inside a block, and the loser gets
    /// chain code 2022 "already discharged". 24 rejects in an hour, always the
    /// same players.
    #[test]
    fn a_player_that_spent_its_charge_is_skipped_until_the_next_block() {
        assert!(!acted_this_block("1-571"));
        note_charged_action("1-571");
        assert!(acted_this_block("1-571"), "second loop must defer, not race");
        assert!(!acted_this_block("1-999"), "per player, not global");
    }

    #[test]
    fn only_charged_message_types_consume_the_block() {
        assert!(is_charged_type("/structs.structs.MsgStructDefenseSet"));
        assert!(is_charged_type("/structs.structs.MsgStructBuildInitiate"));
        assert!(is_charged_type("/structs.structs.MsgFleetMove"));
        // Free traffic must never suppress a later charged action.
        assert!(!is_charged_type("/structs.structs.MsgPermissionGrantOnObject"));
        assert!(!is_charged_type("/cosmos.bank.v1beta1.MsgSend"));
    }

    #[test]
    fn player_id_is_read_from_the_telemetry_context() {
        assert_eq!(player_from_context("auto_defend:1-635"), Some("1-635"));
        assert_eq!(player_from_context("auto_raid_abort:1-2308"), Some("1-2308"));
        assert_eq!(player_from_context("auto_harvest"), None);
        assert_eq!(player_from_context("launch:"), None);
    }

    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Peak in-flight bodies must never exceed the cap, and every target runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn respects_concurrency_cap() {
        let cap = 3usize;
        let n = 50usize;
        let cur = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));

        let targets: Vec<usize> = (0..n).collect();
        let (cur_b, peak_b, done_b) = (cur.clone(), peak.clone(), done.clone());
        for_each_player_concurrent(targets, cap, move |_t| {
            let (cur, peak, done) = (cur_b.clone(), peak_b.clone(), done_b.clone());
            async move {
                let now = cur.fetch_add(1, Ordering::SeqCst) + 1;
                // Raise the watermark to the highest simultaneous count observed.
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::task::yield_now().await;
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                cur.fetch_sub(1, Ordering::SeqCst);
                done.fetch_add(1, Ordering::SeqCst);
            }
        })
        .await;

        assert_eq!(done.load(Ordering::SeqCst), n, "every target ran");
        assert!(peak.load(Ordering::SeqCst) <= cap, "peak concurrency exceeded cap");
        assert_eq!(cur.load(Ordering::SeqCst), 0, "all bodies drained");
    }

    /// A body that panics is logged, not propagated — the wave still completes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn panicking_body_does_not_abort_wave() {
        let done = Arc::new(AtomicUsize::new(0));
        let targets: Vec<usize> = (0..10).collect();
        let done_b = done.clone();
        for_each_player_concurrent(targets, 4, move |t| {
            let done = done_b.clone();
            async move {
                if t == 3 {
                    panic!("boom");
                }
                done.fetch_add(1, Ordering::SeqCst);
            }
        })
        .await;
        assert_eq!(done.load(Ordering::SeqCst), 9, "one panic, nine completions");
    }
}

#[cfg(test)]
mod perception_shim_tests {
    use super::*;

    #[test]
    fn a_young_snapshot_with_a_live_feed_is_fresh() {
        assert!(perception_is_fresh(60_000.0, Some(5_000.0)));
    }

    #[test]
    fn a_young_snapshot_with_no_frames_yet_is_fresh_until_the_gap_elapses() {
        assert!(perception_is_fresh(30_000.0, None));
        assert!(!perception_is_fresh(PERCEPTION_MAX_EVENT_GAP_MS + 1.0, None), "quiet feed, snapshot past the gap");
    }

    #[test]
    fn a_dead_feed_makes_any_snapshot_stale() {
        assert!(!perception_is_fresh(60_000.0, Some(PERCEPTION_MAX_EVENT_GAP_MS)));
        assert!(!perception_is_fresh(60_000.0, Some(3_600_000.0)));
    }

    #[test]
    fn an_old_snapshot_is_stale_even_with_a_live_feed() {
        assert!(!perception_is_fresh(PERCEPTION_MAX_AGE_MS, Some(1_000.0)));
        assert!(!perception_is_fresh(-1.0, Some(1_000.0)), "clock skew never counts as fresh");
    }
}

#[cfg(test)]
mod charge_reservation_tests {
    use super::*;

    #[test]
    fn a_reservation_marks_the_player_acted_until_dropped() {
        let pid = "1-777001"; // unique: the ledger is process-global
        assert!(!acted_this_block(pid));
        let r = reserve_charge(pid).expect("reservation");
        assert!(acted_this_block(pid), "queued sign counts as acted");
        drop(r);
        assert!(!acted_this_block(pid), "released on drop");
    }

    #[test]
    fn overlapping_reservations_release_independently() {
        let pid = "1-777002";
        let a = reserve_charge(pid).unwrap();
        let b = reserve_charge(pid).unwrap();
        drop(a);
        assert!(acted_this_block(pid), "one reservation still alive");
        drop(b);
        assert!(!acted_this_block(pid));
    }

    #[test]
    fn empty_player_id_reserves_nothing() {
        assert!(reserve_charge("").is_none());
    }
}
