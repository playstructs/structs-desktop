//! Shared scaffolding for the native auto-loops (`auto_harvest`, `auto_build`).
//! The loops each fan out a per-player body across the vplayer roster; this
//! module holds the one piece they share today — a bounded-concurrency runner —
//! so a long scan touches every player in the same wave instead of serially
//! (which starved the tail cohort).

use serde_json::Value;
use std::future::Future;
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
        }
    }
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
            "slot": get("slot"),
            "is_destroyed": Value::Bool(parse_bool(sa.and_then(|x| x.get("isDestroyed")))),
        }));
    }
    out
}

/// Max player bodies in flight per scan. Each body does a handful of LCD reads
/// and possibly one webview sign, so this also caps simultaneous LCD requests
/// and sign events. 8–12 is the working band; drop it if the node 429s or the
/// PoW burst saturates CPU.
pub const MAX_CONCURRENT_PLAYERS: usize = 10;

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
