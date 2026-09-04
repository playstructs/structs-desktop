//! Adaptive PoW tuning from solve history (opt-in via `auto_tune`).
//!
//! Two runtime knobs, both adjusted one step at a time and always logged:
//!
//! * **max_concurrent** — if the recent median solve duration degrades to
//!   >2× the 24h baseline (same engine), the grinder pool is oversubscribed:
//!   step down (floor 2). After three consecutive healthy checks (≤1.2×),
//!   step back up toward the user's configured cap.
//! * **difficulty_start** — steered toward `log2(hashrate × ~1 block)`, i.e.
//!   the highest difficulty a worker can expect to clear within roughly one
//!   block of becoming grindable. Only moves when ≥2 off the ideal, one step
//!   per pass, clamped to 8..=24.
//!
//! Adjustments touch the RUNTIME atomics only — the persisted `hash_config`
//! stays the user's intent, so a restart returns to the configured values and
//! the tuner re-learns from fresh history.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::LazyLock;

use crate::hasher::types::now_millis;
use crate::mcp::telemetry::{self, Sev};

/// Min interval between tuning passes.
const TUNE_EVERY_MS: f64 = 5.0 * 60_000.0;
/// Baseline / recent windows.
const BASELINE_MS: f64 = 24.0 * 3_600_000.0;
const RECENT_MS: f64 = 3_600_000.0;
/// Degradation / recovery thresholds on median solve duration.
const DEGRADED_RATIO: f64 = 2.0;
const HEALTHY_RATIO: f64 = 1.2;
const HEALTHY_STREAK_TO_GROW: u32 = 3;
/// Bounds.
const MIN_CONCURRENT: u64 = 2;
/// Difficulty is LEADING HEX ZEROS — 4 bits each — so these are hex digits:
/// 4 = 16 bits (65k tries), 12 = 48 bits (2.8e14 tries, days on any GPU).
/// They were 8..=24 with the ideal computed in BITS, which clamped every
/// real GPU at 24 hex digits and walked `difficulty_start` up one notch per
/// pass — measured 5 → 17 over 2026-09-04 — until every task ground at an
/// impossible difficulty, solve times ballooned, and the concurrency rule
/// below cut the pool to 2 workers with 487 tasks pending.
const DIFF_MIN: u64 = 4;
const DIFF_MAX: u64 = 12;
/// Need at least this many recent solves before trusting the stats.
const MIN_SAMPLES: i64 = 5;
/// Target solve horizon for difficulty_start: ~one block of grinding.
const TARGET_SOLVE_SECS: f64 = 6.0;

static LAST_TUNE_MS: AtomicU64 = AtomicU64::new(0);
static HEALTHY_STREAK: AtomicU32 = AtomicU32::new(0);
/// The user's configured cap (from hash_config at startup / explicit set) —
/// the tuner grows back toward this, never past it.
static USER_MAX: LazyLock<AtomicU64> =
    LazyLock::new(|| AtomicU64::new(crate::hasher::max_concurrent()));

/// Record an explicit user cap change so the tuner respects the new ceiling.
pub fn note_user_max(v: u64) {
    USER_MAX.store(v.max(1), Ordering::Relaxed);
    HEALTHY_STREAK.store(0, Ordering::Relaxed);
}

/// Called from the watchdog check (which runs on the tokio timer task).
/// Cheap no-op unless auto_tune is on and the interval elapsed. The actual
/// pass — including its synchronous SQLite reads — runs on the dedicated
/// `hash-tuner` OS thread spawned below, NEVER on the async runtime; this is
/// the telemetry module's "reads go off-runtime" contract.
pub fn maybe_tune() {
    if !crate::hasher::auto_tune() {
        return;
    }
    let now = now_millis() as u64;
    let last = LAST_TUNE_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < TUNE_EVERY_MS as u64 {
        return;
    }
    if LAST_TUNE_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return; // another pass won the race
    }
    let _ = std::thread::Builder::new()
        .name("hash-tuner".into())
        .spawn(tune_pass);
}

/// Per-engine (solves, median_duration_ms, est_hashrate) from a pow_stats blob.
fn engine_stats(stats: &serde_json::Value, engine: &str) -> Option<(i64, f64, Option<f64>)> {
    stats.as_array()?.iter().find_map(|e| {
        if e.get("engine")?.as_str()? != engine {
            return None;
        }
        Some((
            e.get("solves")?.as_i64()?,
            e.get("median_duration_ms")?.as_f64()?,
            e.get("est_hashrate_hps").and_then(|h| h.as_f64()),
        ))
    })
}

fn tune_pass() {
    let (Ok(baseline), Ok(recent)) = (
        telemetry::pow_stats(BASELINE_MS),
        telemetry::pow_stats(RECENT_MS),
    ) else {
        return;
    };

    // Tune against the engine doing the recent work (most solves wins).
    let engine = recent
        .as_array()
        .and_then(|a| {
            a.iter()
                .max_by_key(|e| e.get("solves").and_then(|s| s.as_i64()).unwrap_or(0))
        })
        .and_then(|e| e.get("engine").and_then(|s| s.as_str()))
        .map(String::from);
    let Some(engine) = engine else { return };

    let Some((n_recent, med_recent, rate_recent)) = engine_stats(&recent, &engine) else {
        return;
    };
    if n_recent < MIN_SAMPLES {
        return;
    }

    // ── Concurrency guard ──
    if let Some((n_base, med_base, _)) = engine_stats(&baseline, &engine) {
        if n_base >= MIN_SAMPLES && med_base > 0.0 {
            let ratio = med_recent / med_base;
            let cur = crate::hasher::max_concurrent();
            if ratio > DEGRADED_RATIO && cur > MIN_CONCURRENT {
                HEALTHY_STREAK.store(0, Ordering::Relaxed);
                crate::hasher::set_max_concurrent(cur - 1);
                telemetry::tlog_kv(
                    "hasher",
                    Sev::Warn,
                    "tuner: solve durations degraded; lowering max_concurrent",
                    serde_json::json!({
                        "engine": engine, "median_recent_ms": med_recent,
                        "median_baseline_ms": med_base, "from": cur, "to": cur - 1
                    }),
                );
            } else if ratio <= HEALTHY_RATIO {
                let streak = HEALTHY_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
                let user_cap = USER_MAX.load(Ordering::Relaxed);
                if streak >= HEALTHY_STREAK_TO_GROW && cur < user_cap {
                    HEALTHY_STREAK.store(0, Ordering::Relaxed);
                    crate::hasher::set_max_concurrent(cur + 1);
                    telemetry::tlog_kv(
                        "hasher",
                        Sev::Notice,
                        "tuner: solve durations healthy; raising max_concurrent",
                        serde_json::json!({ "engine": engine, "from": cur, "to": cur + 1 }),
                    );
                }
            } else {
                HEALTHY_STREAK.store(0, Ordering::Relaxed);
            }
        }
    }

    // ── difficulty_start steering ──
    if let Some(rate) = rate_recent.filter(|r| *r > 0.0) {
        // Highest difficulty whose expected solve time fits the target horizon.
        // Difficulty is hex digits: expected tries = 16^d, so d* = log2(rate × horizon) / 4.
        let ideal = ideal_difficulty(rate);
        let cur = crate::hasher::difficulty_start();
        if ideal.abs_diff(cur) >= 2 {
            let next = if ideal > cur { cur + 1 } else { cur - 1 };
            crate::hasher::set_difficulty_start(next);
            telemetry::tlog_kv(
                "hasher",
                Sev::Notice,
                "tuner: steering difficulty_start toward measured hashrate",
                serde_json::json!({
                    "engine": engine, "est_hashrate_hps": rate,
                    "ideal": ideal, "from": cur, "to": next
                }),
            );
        }
    }
}

/// The highest difficulty (hex digits) a worker at `rate` hashes/s clears in
/// about one block: expected tries = 16^d, so d* = log2(rate × horizon) / 4.
pub fn ideal_difficulty(rate_hps: f64) -> u64 {
    let ideal = ((rate_hps * TARGET_SOLVE_SECS).log2() / 4.0).floor() as i64;
    (ideal.max(DIFF_MIN as i64) as u64).min(DIFF_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_stats_parses_pow_blob() {
        let blob = serde_json::json!([
            {"engine":"gpu","solves":12,"median_duration_ms":800.0,"p90_duration_ms":1500.0,
             "median_difficulty":10,"est_hashrate_hps":2.0e8},
            {"engine":"cpu","solves":3,"median_duration_ms":9000.0,"p90_duration_ms":12000.0,
             "median_difficulty":8,"est_hashrate_hps":null}
        ]);
        let (n, med, rate) = engine_stats(&blob, "gpu").unwrap();
        assert_eq!(n, 12);
        assert_eq!(med, 800.0);
        assert_eq!(rate, Some(2.0e8));
        let (_, _, cpu_rate) = engine_stats(&blob, "cpu").unwrap();
        assert_eq!(cpu_rate, None);
        assert!(engine_stats(&blob, "npu").is_none());
    }

    #[test]
    fn ideal_difficulty_is_in_hex_digits_a_gpu_can_clear_in_a_block() {
        // 200M h/s × 6 s ≈ 1.2e9 tries → log2 ≈ 30.2 bits → 7 hex digits.
        assert_eq!(ideal_difficulty(2.0e8), 7);
        // An M1 at ~40M h/s → 2.4e8 tries → 27.8 bits → 6.
        assert_eq!(ideal_difficulty(4.0e7), 6);
        // A slow 10k h/s rig → 6e4 tries → 15.9 bits → 3, floored to DIFF_MIN.
        assert_eq!(ideal_difficulty(1.0e4), DIFF_MIN);
        // Nothing steers past 12 hex digits (48 bits): that is days, not a block.
        assert_eq!(ideal_difficulty(1.0e15), DIFF_MAX);
        // The old bits formula would have said 24 for the GPU — the value the
        // tuner walked toward one notch per pass.
        assert!(ideal_difficulty(2.0e8) < 24);
    }
}
