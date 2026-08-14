//! Watchdog: detects stale/stuck automation and (policy-gated) self-heals.
//!
//! The GrassManager incident established the failure class this guards
//! against: a loop dies or wedges while the surrounding process looks healthy,
//! and nobody notices until a raid lands unanswered. Every loop reports
//! liveness here (cheap in-memory mirror of the `loop_runs` table, so checks
//! never touch SQLite); `check()` runs from the always-alive Rust timer in
//! `main.rs` — deliberately NOT from the sync tick, because a stalled sync
//! tick is one of the conditions being detected.
//!
//! Remediation (reset a wedged single-flight guard, cancel a stalled hash
//! task, re-nudge the sync tick) runs only while the `watchdog_remediate`
//! policy is enabled (default on). Every finding and every remedy is logged to
//! the telemetry `events` table (component `watchdog`) and the board feed; a
//! native notification fires only when the same remedy has failed twice in a
//! row — detection is loud, healing is quiet.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::hasher::types::{now_millis, TaskRegistry};
use crate::mcp::policy::POLICY_ENGINE;
use crate::mcp::telemetry::{tlog_feed, tlog_kv, Sev};
use crate::mcp::{auto_build, auto_defend, auto_harvest, auto_infuse};

/// Self-throttle: run detections at most this often.
const CHECK_EVERY_MS: f64 = 60_000.0;
/// A loop is OVERDUE when enabled and idle for this many × its interval.
const OVERDUE_FACTOR: f64 = 2.0;
/// A loop is WEDGED when a scan has been "running" this long (its single-flight
/// AtomicBool never cleared — a hang past an .await or a panic outside a body).
const LOOP_STUCK_MS: f64 = 15.0 * 60_000.0;
/// A hash task is STALLED when status is "running" but iterations haven't
/// moved for this long.
const HASH_STALL_MS: f64 = 5.0 * 60_000.0;
/// A task that has NEVER completed an iteration is not stalled — it is queued
/// behind easier work. The scheduler admits easiest-first, so the hardest proof
/// in a busy queue (a RAID at difficulty 46 behind 28 difficulty-8 mines) can
/// legitimately sit at zero iterations for a long time. Reaping it at the
/// 5-minute stall threshold is how a raid proof silently disappeared while its
/// window stayed open on-chain and its fleet sat parked at the target.
///
/// Zombies (workers that died without observing the cancel flag) also sit at
/// zero forever, so they still get collected — just on a horizon long enough
/// that real work is not mistaken for them.
const HASH_STARVED_MS: f64 = 45.0 * 60_000.0;
/// The sync tick is STALLED when nothing has synced for this many × the
/// current sync interval.
const SYNC_STALL_FACTOR: f64 = 3.0;
/// Native notification threshold: same remedy failed this many checks in a row.
const NOTIFY_AFTER_FAILURES: u32 = 2;

#[derive(Debug, Clone, Copy, Default)]
struct LoopStat {
    last_started_ms: f64,
    last_finished_ms: f64,
    /// Last sign of life DURING a scan (a tx attempt or a loop log line).
    /// Distinguishes "long scan, still working" from "guard held, thread gone":
    /// at fleet scale a healthy auto_build scan runs well past LOOP_STUCK_MS,
    /// and resetting its guard mid-run starts an OVERLAPPING scan that makes
    /// every loop slower (seen live at 870 vplayers: sweep/build/harvest all
    /// "wedged" every cycle while doing real work the whole time).
    last_progress_ms: f64,
    running: bool,
}

static LOOPS: LazyLock<Mutex<HashMap<&'static str, LoopStat>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SYNC_LAST_RUN_MS: AtomicU64 = AtomicU64::new(0);
static LAST_CHECK_MS: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
/// Baseline for "never ran yet" loops — first time anything touches the
/// watchdog, which in practice is the first sync tick after launch.
static APP_START_MS: LazyLock<f64> = LazyLock::new(now_millis);
/// task_id -> (last seen iterations, when they last changed).
static HASH_PROGRESS: LazyLock<Mutex<HashMap<String, (u64, f64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// finding key (e.g. "wedged:auto_build", "sync") -> consecutive checks the
/// condition survived a remediation attempt.
static REMEDY_FAILS: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Lock a mutex, recovering from poisoning. The watchdog is the LAST line of
/// defense — if some earlier panic poisoned a mutex, propagating that panic
/// here would kill the whole resilience loop (the exact silent death this
/// module exists to prevent). The guarded data are plain liveness scalars, so
/// recovering the inner value is always safe.
fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Liveness reporting (called by telemetry::LoopRun and sync_game_state) ──

pub fn note_loop_started(name: &'static str, ts_ms: f64) {
    let mut m = lock_recover(&LOOPS);
    let s = m.entry(name).or_default();
    s.last_started_ms = ts_ms;
    s.running = true;
}

pub fn note_loop_finished(name: &'static str, ts_ms: f64) {
    let mut m = lock_recover(&LOOPS);
    let s = m.entry(name).or_default();
    s.last_finished_ms = ts_ms;
    s.running = false;
}

/// Record a sign of life from a running scan. Called from the telemetry
/// choke points (every tx attempt and every loop log line), so no loop needs
/// to remember to heartbeat explicitly. Cheap: one mutex + two stores.
pub fn note_loop_progress(name: &'static str) {
    let mut m = lock_recover(&LOOPS);
    let s = m.entry(name).or_default();
    s.last_progress_ms = now_millis();
}

/// The seven native loop names — used to map free-form telemetry components /
/// tx contexts back onto a loop's liveness entry.
pub const LOOP_NAMES: [&str; 7] = [
    "auto_harvest",
    "auto_build",
    "auto_defend",
    "auto_infuse",
    "auto_sweep",
    "auto_response",
    "auto_raid",
];

/// Resolve a component name or tx context ("auto_sweep", "auto_sweep:1-821")
/// to its static loop name, if it belongs to a native loop.
pub fn loop_name_of(component_or_context: &str) -> Option<&'static str> {
    let head = component_or_context
        .split(':')
        .next()
        .unwrap_or(component_or_context);
    LOOP_NAMES.iter().find(|n| **n == head).copied()
}

pub fn note_sync_ran() {
    LazyLock::force(&APP_START_MS);
    SYNC_LAST_RUN_MS.store(now_millis() as u64, Ordering::Relaxed);
}

// ── Findings ──

struct Finding {
    /// Stable key for consecutive-failure tracking.
    key: String,
    severity: Sev,
    message: String,
    /// Remedy to apply when `watchdog_remediate` is on. Returns a short
    /// description of what was done.
    remedy: Option<Box<dyn FnOnce(&tauri::AppHandle) -> String + Send>>,
}

/// The native loops: name → (enabled, interval_ms) from live config.
fn loop_configs() -> [(&'static str, bool, f64); 7] {
    let h = auto_harvest::get();
    let b = auto_build::get();
    let d = auto_defend::get();
    let i = auto_infuse::get();
    let sw = crate::mcp::auto_sweep::get();
    let r = crate::mcp::auto_response::get();
    let rd = crate::mcp::auto_raid::get();
    [
        ("auto_harvest", h.enabled, h.interval_secs as f64 * 1000.0),
        ("auto_build", b.enabled, b.interval_secs as f64 * 1000.0),
        ("auto_defend", d.enabled, d.interval_secs as f64 * 1000.0),
        ("auto_infuse", i.enabled, i.interval_secs as f64 * 1000.0),
        ("auto_sweep", sw.enabled, sw.interval_secs as f64 * 1000.0),
        ("auto_response", r.enabled, r.interval_secs as f64 * 1000.0),
        ("auto_raid", rd.enabled, rd.interval_secs as f64 * 1000.0),
    ]
}

fn reset_loop_guard(name: &str) {
    match name {
        "auto_harvest" => auto_harvest::force_reset_running(),
        "auto_build" => auto_build::force_reset_running(),
        "auto_defend" => auto_defend::force_reset_running(),
        "auto_infuse" => auto_infuse::force_reset_running(),
        "auto_sweep" => crate::mcp::auto_sweep::force_reset_running(),
        "auto_response" => crate::mcp::auto_response::force_reset_running(),
        "auto_raid" => crate::mcp::auto_raid::force_reset_running(),
        _ => {}
    }
}

fn detect(app: &tauri::AppHandle, now: f64) -> Vec<Finding> {
    let mut findings = Vec::new();
    let app_start = *APP_START_MS;

    // Sync tick first: if sync is dead every loop is starved, so report the
    // root cause and skip the (noisy, misleading) per-loop overdue findings.
    let sync_last = SYNC_LAST_RUN_MS.load(Ordering::Relaxed) as f64;
    let sync_interval = crate::game_state::current_sync_interval_ms() as f64;
    let sync_baseline = if sync_last > 0.0 { sync_last } else { app_start };
    let sync_stalled = now - sync_baseline > SYNC_STALL_FACTOR * sync_interval;
    if sync_stalled {
        let age_s = ((now - sync_baseline) / 1000.0) as u64;
        findings.push(Finding {
            key: "sync".into(),
            severity: Sev::Error,
            message: format!(
                "sync tick stalled: no game-state sync for {age_s}s (interval {}s)",
                (sync_interval / 1000.0) as u64
            ),
            remedy: Some(Box::new(|app: &tauri::AppHandle| {
                // The JS handler is debounced, so an extra tick is always safe.
                let _ = app.emit("structs://sync-tick", ());
                "re-emitted structs://sync-tick".into()
            })),
        });
    }

    // Per-loop overdue / wedged.
    let stats = lock_recover(&LOOPS).clone();
    for (name, enabled, interval_ms) in loop_configs() {
        let stat = stats.get(name).copied().unwrap_or_default();

        // Wedged = guard held AND no sign of life. Run duration alone is NOT
        // wedged: at fleet scale a healthy scan legitimately outlives
        // LOOP_STUCK_MS, and resetting the guard mid-run lets the cadence
        // start an OVERLAPPING scan — doubling API + signing load and slowing
        // every loop further (the self-amplifying spiral seen at 870 players).
        // Progress is stamped by every tx attempt and loop log line, so a
        // working scan is never silent for LOOP_STUCK_MS.
        // Outstanding signs prove liveness on their own: a single explore has
        // been measured at 71 minutes, so a loop awaiting one is silent for
        // far longer than LOOP_STUCK_MS while being perfectly healthy. Only a
        // loop holding its guard with NOTHING outstanding and no log line is
        // actually wedged.
        let last_life = stat.last_progress_ms.max(stat.last_started_ms);
        if stat.running
            && now - stat.last_started_ms > LOOP_STUCK_MS
            && now - last_life > LOOP_STUCK_MS
            && crate::mcp::tx_gate::in_flight_for(name) == 0
        {
            let mins = ((now - last_life) / 60_000.0) as u64;
            let name_owned = name.to_string();
            findings.push(Finding {
                key: format!("wedged:{name}"),
                severity: Sev::Error,
                message: format!("{name} wedged: guard held with no sign of life for {mins} min"),
                remedy: Some(Box::new(move |_| {
                    reset_loop_guard(&name_owned);
                    format!("reset {name_owned} RUNNING guard")
                })),
            });
            continue;
        }

        if enabled && !sync_stalled && !stat.running {
            let baseline = stat.last_finished_ms.max(app_start);
            if now - baseline > OVERDUE_FACTOR * interval_ms {
                let mins = ((now - baseline) / 60_000.0) as u64;
                findings.push(Finding {
                    key: format!("overdue:{name}"),
                    severity: Sev::Warn,
                    message: format!(
                        "{name} overdue: enabled but no completed scan for {mins} min (interval {}s)",
                        (interval_ms / 1000.0) as u64
                    ),
                    remedy: None, // next healthy sync tick runs it; nothing to force
                });
            }
        }
    }

    // Hasher: a "running" task whose iteration counter stopped moving.
    if let Some(registry) = app.try_state::<Arc<TaskRegistry>>() {
        let mut progress = lock_recover(&HASH_PROGRESS);
        let mut live_ids = Vec::new();
        for entry in registry.tasks.iter() {
            let id = entry.key().clone();
            let snap = entry.value().snapshot();
            live_ids.push(id.clone());
            if snap.status != "running" {
                progress.remove(&id);
                continue;
            }
            let (last_iters, last_change) = *progress.get(&id).unwrap_or(&(snap.iterations, now));
            if snap.iterations != last_iters {
                progress.insert(id, (snap.iterations, now));
            } else {
                progress.insert(id.clone(), (last_iters, last_change));
                // Frozen AFTER doing work is a stall; frozen having never done
                // any is starvation. Same symptom, opposite remedy — killing a
                // starved task destroys work that only needed a turn.
                let ever_ran = snap.iterations > 0;
                let limit = if ever_ran { HASH_STALL_MS } else { HASH_STARVED_MS };
                if now - last_change > limit {
                    let handle = entry.value().clone();
                    let mins = ((now - last_change) / 60_000.0) as u64;
                    findings.push(Finding {
                        key: format!("hash:{id}"),
                        severity: Sev::Warn,
                        message: if ever_ran {
                            format!("hash task {id} stalled: status running, no progress for {mins} min")
                        } else {
                            format!(
                                "hash task {id} never started: admitted {mins} min ago and still \
                                 at zero iterations (starved behind easier proofs, or a dead worker)"
                            )
                        },
                        remedy: Some(Box::new(move |app: &tauri::AppHandle| {
                            // REMOVE + cancel, not just cancel: a zombie task
                            // whose worker died (e.g. unclean restart) never
                            // observes the cancel flag — it would sit in the
                            // registry as "running" forever and re-trigger
                            // this finding every cycle (seen live: 238 wedged
                            // MINE tasks, watchdog "2nd attempt" spam). Same
                            // remove-first shape as tools/hasher.rs stop_task
                            // (avoids the DashMap get-then-remove deadlock).
                            // A stalled RUNNING task may have its pool worker
                            // wedged in an unbounded block — write that worker
                            // off and spawn a replacement so the bounded pool
                            // never silently drains.
                            crate::hasher::pool::note_wedged();
                            if let Some(reg) = app.try_state::<Arc<TaskRegistry>>() {
                                if let Some((_, h)) = reg.tasks.remove(&id) {
                                    h.cancel.store(true, Ordering::SeqCst);
                                    return format!("removed stalled hash task {id} from the queue");
                                }
                            }
                            handle.cancel.store(true, Ordering::SeqCst);
                            format!("cancelled stalled hash task {id}")
                        })),
                    });
                }
            }
        }
        progress.retain(|id, _| live_ids.contains(id));
    }

    findings
}

// ── The periodic check ──

/// Run detections + remediation. Self-throttled to `CHECK_EVERY_MS`; safe to
/// call every timer tick. Sync (no awaits) so it can run anywhere.
pub fn check(app: &tauri::AppHandle) {
    let now = now_millis();
    {
        let mut last = lock_recover(&LAST_CHECK_MS);
        if now - *last < CHECK_EVERY_MS {
            return;
        }
        *last = now;
    }
    LazyLock::force(&APP_START_MS);

    // Adaptive PoW tuning rides the same cadence (no-op unless auto_tune is on).
    crate::hasher::tuner::maybe_tune();

    let findings = detect(app, now);
    let remediate = POLICY_ENGINE
        .read()
        .map(|e| e.is_enabled("watchdog_remediate"))
        .unwrap_or(false);

    let mut fails = lock_recover(&REMEDY_FAILS);
    let current_keys: Vec<String> = findings.iter().map(|f| f.key.clone()).collect();

    for f in findings {
        tlog_feed(app, "watchdog", f.severity, &f.message);

        // A key that was remediated last check and is still firing = the
        // remedy failed. Escalate to a native notification at the threshold.
        let attempts = fails.entry(f.key.clone()).or_insert(0);
        if *attempts >= NOTIFY_AFTER_FAILURES {
            crate::notifications::notify(
                "Structs watchdog",
                &format!("{} — remediation failed {} times", f.message, *attempts),
            );
            *attempts = 0; // re-escalate only after another full cycle of failures
        }

        match (remediate, f.remedy) {
            (true, Some(remedy)) => {
                let did = remedy(app);
                tlog_kv(
                    "watchdog",
                    Sev::Notice,
                    format!("remediation: {did}"),
                    json!({ "finding": f.key, "attempt": *fails.get(&f.key).unwrap_or(&0) + 1 }),
                );
                *fails.get_mut(&f.key).unwrap() += 1;
            }
            _ => {
                // Detection-only (no remedy, or remediation disabled): count
                // persistence anyway so repeated findings still escalate.
                *fails.get_mut(&f.key).unwrap() += 1;
            }
        }
    }

    // Conditions that cleared: drop their failure counters.
    fails.retain(|k, _| current_keys.contains(k));
}

// ── Health snapshot (for GET /health and structs_system status) ──

/// Shallow liveness summary. Deliberately contains no player data and no
/// token — it is served unauthenticated on the localhost-only MCP port.
pub fn health_snapshot() -> Value {
    let now = now_millis();
    let app_start = *APP_START_MS;
    let sync_last = SYNC_LAST_RUN_MS.load(Ordering::Relaxed) as f64;
    let sync_baseline = if sync_last > 0.0 { sync_last } else { app_start };
    let sync_age_ms = now - sync_baseline;
    let sync_interval = crate::game_state::current_sync_interval_ms() as f64;

    let stats = lock_recover(&LOOPS).clone();
    let mut overdue = Vec::new();
    let mut wedged = Vec::new();
    for (name, enabled, interval_ms) in loop_configs() {
        let stat = stats.get(name).copied().unwrap_or_default();
        // Same progress-aware test as the findings pass: a guard held for a
        // long time is NOT wedged while the scan keeps logging / signing txs.
        // The duration-only version here reported auto_defend's first
        // full-fleet wiring scan (30+ min, 1,200+ successful txs) as
        // "wedged"/degraded the whole way through.
        let last_life = stat.last_progress_ms.max(stat.last_started_ms);
        if stat.running
            && now - stat.last_started_ms > LOOP_STUCK_MS
            && now - last_life > LOOP_STUCK_MS
            && crate::mcp::tx_gate::in_flight_for(name) == 0
        {
            wedged.push(name);
        } else if enabled
            && !stat.running
            && now - stat.last_finished_ms.max(app_start) > OVERDUE_FACTOR * interval_ms
        {
            overdue.push(name);
        }
    }

    let sync_stalled = sync_age_ms > SYNC_STALL_FACTOR * sync_interval;
    let status = if sync_stalled || !wedged.is_empty() {
        "degraded"
    } else if !overdue.is_empty() {
        "warn"
    } else {
        "ok"
    };
    json!({
        "status": status,
        "sync_age_ms": sync_age_ms as u64,
        "sync_interval_ms": sync_interval as u64,
        "loops_overdue": overdue,
        "loops_wedged": wedged,
        "uptime_s": ((now - app_start) / 1000.0) as u64,
        "telemetry_dropped": crate::mcp::telemetry::dropped_count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_name_of_maps_components_and_contexts() {
        assert_eq!(loop_name_of("auto_sweep"), Some("auto_sweep"));
        assert_eq!(loop_name_of("auto_sweep:1-821"), Some("auto_sweep"));
        assert_eq!(loop_name_of("auto_build:1-1044"), Some("auto_build"));
        // Non-loop telemetry must NOT stamp loop progress.
        assert_eq!(loop_name_of("launch:1-1165"), None);
        assert_eq!(loop_name_of("watchdog"), None);
        assert_eq!(loop_name_of("hasher"), None);
        // A context whose prefix merely STARTS with a loop name is not a match.
        assert_eq!(loop_name_of("auto_sweeper:1-1"), None);
    }

    #[test]
    fn progress_note_marks_liveness() {
        note_loop_started("auto_build", 1000.0);
        note_loop_progress("auto_build");
        let m = lock_recover(&LOOPS);
        let s = m.get("auto_build").unwrap();
        assert!(s.running);
        assert!(s.last_progress_ms > 0.0, "progress stamp recorded");
    }
}
