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
const DIFF_MIN: u64 = 8;
const DIFF_MAX: u64 = 24;
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

/// Called from the watchdog check. Cheap no-op unless auto_tune is on and the
/// interval elapsed; the actual pass runs on a blocking thread (SQLite reads).
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
        // Highest difficulty whose expected solve time fits the target horizon:
        // expected tries = 2^d, so d* = log2(rate × horizon).
        let ideal = (rate * TARGET_SOLVE_SECS).log2().floor() as i64;
        let ideal = (ideal.max(DIFF_MIN as i64) as u64).min(DIFF_MAX);
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
    fn ideal_difficulty_math() {
        // 200M h/s × 6s ≈ 1.2e9 tries → log2 ≈ 30.2 → clamped to DIFF_MAX (24).
        let ideal = ((2.0e8f64 * TARGET_SOLVE_SECS).log2().floor() as i64).max(DIFF_MIN as i64) as u64;
        assert_eq!(ideal.min(DIFF_MAX), 24);
        // 3M h/s CPU × 6s ≈ 1.8e7 → log2 ≈ 24.1 → 24; a slow 10k h/s rig → 15.
        let slow = ((1.0e4f64 * TARGET_SOLVE_SECS).log2().floor() as i64).max(DIFF_MIN as i64) as u64;
        assert_eq!(slow.min(DIFF_MAX), 15);
    }
}
