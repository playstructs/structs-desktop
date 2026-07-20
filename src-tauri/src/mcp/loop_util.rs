//! Shared scaffolding for the native auto-loops (`auto_harvest`, `auto_build`).
//! The loops each fan out a per-player body across the vplayer roster; this
//! module holds the one piece they share today — a bounded-concurrency runner —
//! so a long scan touches every player in the same wave instead of serially
//! (which starved the tail cohort).

use serde_json::Value;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
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
            "operating_ambit": get("operatingAmbit"),
            // LCD numerics are STRINGS ("slot": "1"); coerce to a real number
            // here so consumers' as_u64() works. A raw copy made every struct
            // read as slot 0 → auto_build picked "free" slot 1 on planets whose
            // slot 1 was occupied → a permanent chain-reject loop (3.6k dead
            // txs/hour across the fleet before structs_system surfaced it).
            "slot": read_u64_field(s, "slot"),
            "is_destroyed": Value::Bool(parse_bool(sa.and_then(|x| x.get("isDestroyed")))),
        }));
    }
    out
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

#[cfg(test)]
mod tests {
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
