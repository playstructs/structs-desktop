//! Adaptive PoW tuning from solve history (opt-in via `auto_tune`).
//!
//! Two runtime knobs, both adjusted one step at a time and always logged:
//!
//! * **max_concurrent** — judged on GRIND THROUGHPUT (each solve's own
//!   hashes/s while running), never on duration: if the recent median
//!   throughput falls under 0.5× the 24h baseline the pool is oversubscribed
//!   or the GPU is contended: step down (floor 2). After three consecutive
//!   healthy checks (≥0.8×), step back up toward the user's configured cap.
//!   Duration is 16× longer per difficulty digit, so a duration rule fought
//!   the steering rule below (see `judge_throughput`).
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

/// One engine's slice of a `pow_stats` blob.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineStats {
    pub solves: i64,
    pub median_duration_ms: f64,
    pub p90_duration_ms: Option<f64>,
    /// sum(iterations)/sum(seconds) — includes every second a task spent
    /// not hashing. Kept for steering, where a conservative figure is fine.
    pub est_hashrate_hps: Option<f64>,
    /// Median per-solve GRIND throughput (hashes/s while actually running).
    /// The only number that says how the GPU is doing.
    pub median_grind_hps: Option<f64>,
}

fn engine_stats(stats: &serde_json::Value, engine: &str) -> Option<EngineStats> {
    stats.as_array()?.iter().find_map(|e| {
        if e.get("engine")?.as_str()? != engine {
            return None;
        }
        Some(EngineStats {
            solves: e.get("solves")?.as_i64()?,
            median_duration_ms: e.get("median_duration_ms")?.as_f64()?,
            p90_duration_ms: e.get("p90_duration_ms").and_then(|h| h.as_f64()),
            est_hashrate_hps: e.get("est_hashrate_hps").and_then(|h| h.as_f64()),
            median_grind_hps: e.get("median_grind_hps").and_then(|h| h.as_f64()),
        })
    })
}

/// What the throughput comparison says about the grinder pool.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Throughput {
    /// Recent grind throughput under [`DEGRADED_THROUGHPUT`] × baseline.
    Degraded { ratio: f64 },
    /// At or above [`HEALTHY_THROUGHPUT`] × baseline.
    Healthy { ratio: f64 },
    /// In between, or not enough samples on either side.
    Unknown,
}

/// Concurrency is judged on THROUGHPUT, never duration. A solve's duration
/// is 16× longer per difficulty digit, so the moment steering raised
/// `difficulty_start` the old duration rule (median > 2× baseline) read the
/// longer solves as an oversubscribed pool, cut `max_concurrent`, and the
/// next pass steered back down: 11 "degraded" verdicts in two hours and
/// `difficulty_start` walking 4→5→6→5 under a steady 100 MH/s on
/// 2026-09-05. Grind throughput does not move when the difficulty does.
pub const DEGRADED_THROUGHPUT: f64 = 0.5;
pub const HEALTHY_THROUGHPUT: f64 = 0.8;
/// A p90 this long with HEALTHY throughput is not the GPU: something is
/// sleeping (an unripe pop, a queue). Logged, never acted on.
pub const WEDGE_P90_MS: f64 = 60_000.0;

/// A grind shorter than this cannot measure a rate: at difficulty 4 a solve
/// takes ~16 ms, the timer quantises, and `median_grind_hps` reads 20 MH/s
/// against a 45 MH/s baseline measured on real grinds — a 0.44× "degraded"
/// verdict every minute after a relaunch (0.1.354), and a pool cut for it.
pub const MIN_MEASURABLE_MS: f64 = 100.0;

pub fn judge_throughput(recent: &EngineStats, baseline: &EngineStats) -> Throughput {
    if recent.median_duration_ms < MIN_MEASURABLE_MS {
        return Throughput::Unknown;
    }
    match (recent.median_grind_hps, baseline.median_grind_hps) {
        (Some(r), Some(b)) if b > 0.0 && recent.solves >= MIN_SAMPLES && baseline.solves >= MIN_SAMPLES => {
            let ratio = r / b;
            if ratio < DEGRADED_THROUGHPUT {
                Throughput::Degraded { ratio }
            } else if ratio >= HEALTHY_THROUGHPUT {
                Throughput::Healthy { ratio }
            } else {
                Throughput::Unknown
            }
        }
        _ => Throughput::Unknown,
    }
}

/// Expected seconds to clear `digits` hex digits at `rate` hashes/s.
pub fn expected_solve_secs(digits: u64, rate_hps: f64) -> f64 {
    if rate_hps <= 0.0 {
        return f64::INFINITY;
    }
    16f64.powi(digits as i32) / rate_hps
}

/// The tuner's last reading, for `structs_system status` — so a
/// concurrency or difficulty change is explainable from the numbers it
/// was made on, not reconstructed from the log afterwards.
static LAST_SIGNAL: LazyLock<std::sync::Mutex<serde_json::Value>> =
    LazyLock::new(|| std::sync::Mutex::new(serde_json::Value::Null));

pub fn last_signal() -> serde_json::Value {
    LAST_SIGNAL.lock().map(|v| v.clone()).unwrap_or(serde_json::Value::Null)
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

    let Some(rs) = engine_stats(&recent, &engine) else { return };
    if rs.solves < MIN_SAMPLES {
        return;
    }
    let bs = engine_stats(&baseline, &engine);

    // ── Concurrency: throughput only ──
    let verdict = bs.as_ref().map(|b| judge_throughput(&rs, b)).unwrap_or(Throughput::Unknown);
    let cur_conc = crate::hasher::max_concurrent();
    match verdict {
        Throughput::Degraded { ratio } if cur_conc > MIN_CONCURRENT => {
            HEALTHY_STREAK.store(0, Ordering::Relaxed);
            crate::mcp::capacity::set_gpu_concurrency(cur_conc - 1, format!("grind throughput {ratio:.2}× baseline"));
            telemetry::tlog_kv(
                "hasher",
                Sev::Warn,
                "tuner: grind throughput degraded; lowering max_concurrent",
                serde_json::json!({
                    "engine": engine, "throughput_ratio": ratio,
                    "recent_hps": rs.median_grind_hps, "baseline_hps": bs.as_ref().and_then(|b| b.median_grind_hps),
                    "from": cur_conc, "to": cur_conc - 1
                }),
            );
        }
        Throughput::Healthy { .. } => {
            let streak = HEALTHY_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
            let user_cap = USER_MAX.load(Ordering::Relaxed);
            if streak >= HEALTHY_STREAK_TO_GROW && cur_conc < user_cap {
                HEALTHY_STREAK.store(0, Ordering::Relaxed);
                crate::mcp::capacity::set_gpu_concurrency(cur_conc + 1, "grind throughput healthy for three passes");
                telemetry::tlog_kv(
                    "hasher",
                    Sev::Notice,
                    "tuner: grind throughput healthy; raising max_concurrent",
                    serde_json::json!({ "engine": engine, "from": cur_conc, "to": cur_conc + 1 }),
                );
            }
        }
        Throughput::Degraded { .. } => {
            HEALTHY_STREAK.store(0, Ordering::Relaxed);
        }
        Throughput::Unknown => {
            HEALTHY_STREAK.store(0, Ordering::Relaxed);
        }
    }

    // ── Wedge detector: slow solves that are NOT the GPU's doing ──
    let wedged = matches!(verdict, Throughput::Healthy { .. }) && rs.p90_duration_ms.is_some_and(|p| p > WEDGE_P90_MS);
    if wedged {
        telemetry::tlog_kv(
            "hasher",
            Sev::Warn,
            "tuner: solves slow with healthy grind throughput — something sleeps before or after the grind (queue, unripe pop)",
            serde_json::json!({ "engine": engine, "p90_ms": rs.p90_duration_ms, "recent_hps": rs.median_grind_hps }),
        );
    }

    // ── difficulty_start steering: only while the throughput rule is quiet ──
    let rate = rs.median_grind_hps.or(rs.est_hashrate_hps).filter(|r| *r > 0.0);
    let ideal = rate.map(ideal_difficulty);
    let cur = crate::hasher::difficulty_start();
    if let (Some(rate), Some(ideal)) = (rate, ideal) {
        if !matches!(verdict, Throughput::Degraded { .. }) && ideal.abs_diff(cur) >= 2 {
            let next = if ideal > cur { cur + 1 } else { cur - 1 };
            crate::mcp::capacity::set_gpu_difficulty(next, format!("ideal {ideal} at {:.0} MH/s ({:.1} s per proof at {next})", rate / 1e6, expected_solve_secs(next, rate)));
            telemetry::tlog_kv(
                "hasher",
                Sev::Notice,
                "tuner: steering difficulty_start toward measured throughput",
                serde_json::json!({
                    "engine": engine, "grind_hps": rate,
                    "ideal": ideal, "from": cur, "to": next,
                    "expected_solve_s_at_next": expected_solve_secs(next, rate)
                }),
            );
        }
    }

    if let Ok(mut sig) = LAST_SIGNAL.lock() {
        *sig = serde_json::json!({
            "engine": engine,
            "at_ms": now_millis(),
            "recent_solves": rs.solves,
            "recent_grind_hps": rs.median_grind_hps,
            "baseline_grind_hps": bs.as_ref().and_then(|b| b.median_grind_hps),
            "throughput": match verdict {
                Throughput::Degraded { ratio } => serde_json::json!({"verdict": "degraded", "ratio": ratio}),
                Throughput::Healthy { ratio } => serde_json::json!({"verdict": "healthy", "ratio": ratio}),
                Throughput::Unknown => serde_json::json!({"verdict": "unknown"}),
            },
            "p90_ms": rs.p90_duration_ms,
            "wedged": wedged,
            "ideal_difficulty": ideal,
            "difficulty_start": crate::hasher::difficulty_start(),
            "expected_solve_s": rate.map(|r| expected_solve_secs(crate::hasher::difficulty_start(), r)),
            "max_concurrent": crate::hasher::max_concurrent(),
        });
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
             "median_difficulty":10,"est_hashrate_hps":2.0e8,"median_grind_hps":1.0e8},
            {"engine":"cpu","solves":3,"median_duration_ms":9000.0,"p90_duration_ms":12000.0,
             "median_difficulty":8,"est_hashrate_hps":null}
        ]);
        let g = engine_stats(&blob, "gpu").unwrap();
        assert_eq!((g.solves, g.median_duration_ms, g.est_hashrate_hps, g.median_grind_hps), (12, 800.0, Some(2.0e8), Some(1.0e8)));
        let c = engine_stats(&blob, "cpu").unwrap();
        assert_eq!((c.est_hashrate_hps, c.median_grind_hps), (None, None));
        assert!(engine_stats(&blob, "npu").is_none());
    }

    fn stats(solves: i64, median_ms: f64, p90_ms: Option<f64>, grind: Option<f64>) -> EngineStats {
        EngineStats { solves, median_duration_ms: median_ms, p90_duration_ms: p90_ms, est_hashrate_hps: grind, median_grind_hps: grind }
    }

    /// The 2026-09-05 oscillation: steering raised the difficulty two digits,
    /// every solve took ~256× longer, the GPU was exactly as fast as before.
    /// The old duration rule called that "degraded"; throughput must not.
    #[test]
    fn a_difficulty_step_is_not_degradation() {
        let baseline = stats(500, 170.0, Some(400.0), Some(1.0e8));
        let recent = stats(40, 43_000.0, Some(60_000.0), Some(1.0e8));
        assert_eq!(judge_throughput(&recent, &baseline), Throughput::Healthy { ratio: 1.0 });
    }

    /// 0.1.354 after a relaunch: difficulty back at 4, solves of ~16 ms, the
    /// timer quantising the rate to 20 MH/s against a 45 MH/s baseline. No
    /// verdict can be read from a grind that short — the pool must not be cut.
    #[test]
    fn a_solve_too_short_to_time_is_no_verdict() {
        let baseline = stats(500, 170.0, Some(400.0), Some(4.5e7));
        let recent = stats(17, 15.8, Some(29.0), Some(2.0e7));
        assert_eq!(judge_throughput(&recent, &baseline), Throughput::Unknown);
        let long_enough = stats(17, MIN_MEASURABLE_MS, Some(200.0), Some(2.0e7));
        assert!(matches!(judge_throughput(&long_enough, &baseline), Throughput::Degraded { .. }), "at a measurable length the same ratio IS a verdict");
    }

    #[test]
    fn halved_grind_throughput_is_degradation() {
        let baseline = stats(500, 170.0, Some(400.0), Some(1.0e8));
        let recent = stats(40, 300.0, Some(500.0), Some(4.0e7));
        assert!(matches!(judge_throughput(&recent, &baseline), Throughput::Degraded { ratio } if (ratio - 0.4).abs() < 1e-9));
        // Between the two thresholds nothing is concluded.
        let between = stats(40, 300.0, None, Some(6.5e7));
        assert_eq!(judge_throughput(&between, &baseline), Throughput::Unknown);
    }

    #[test]
    fn too_few_samples_or_no_grind_figure_is_unknown() {
        let baseline = stats(500, 170.0, None, Some(1.0e8));
        assert_eq!(judge_throughput(&stats(3, 170.0, None, Some(1.0e7)), &baseline), Throughput::Unknown);
        assert_eq!(judge_throughput(&stats(40, 170.0, None, None), &baseline), Throughput::Unknown);
        assert_eq!(judge_throughput(&stats(40, 170.0, None, Some(1.0e8)), &stats(2, 170.0, None, Some(1.0e8))), Throughput::Unknown);
    }

    #[test]
    fn expected_solve_time_is_sixteen_fold_per_digit() {
        let r = 1.0e8;
        assert!((expected_solve_secs(6, r) - 0.167).abs() < 0.01);
        assert!((expected_solve_secs(7, r) - 2.68).abs() < 0.05);
        assert!((expected_solve_secs(8, r) / expected_solve_secs(7, r) - 16.0).abs() < 1e-9);
        assert!(expected_solve_secs(7, 0.0).is_infinite());
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
