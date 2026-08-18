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

/// Has this player already taken its one charged action this block?
pub fn acted_this_block(player_id: &str) -> bool {
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
