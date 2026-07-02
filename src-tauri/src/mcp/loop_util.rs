//! Shared scaffolding for the native auto-loops (`auto_harvest`, `auto_build`).
//! The loops each fan out a per-player body across the vplayer roster; this
//! module holds the one piece they share today — a bounded-concurrency runner —
//! so a long scan touches every player in the same wave instead of serially
//! (which starved the tail cohort).

use serde_json::Value;
use std::future::Future;
use tokio::task::JoinSet;

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
