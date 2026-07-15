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
use std::sync::{Arc, LazyLock, Mutex};

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
/// The sync tick is STALLED when nothing has synced for this many × the
/// current sync interval.
const SYNC_STALL_FACTOR: f64 = 3.0;
/// Native notification threshold: same remedy failed this many checks in a row.
const NOTIFY_AFTER_FAILURES: u32 = 2;

#[derive(Debug, Clone, Copy, Default)]
struct LoopStat {
    last_started_ms: f64,
    last_finished_ms: f64,
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

// ── Liveness reporting (called by telemetry::LoopRun and sync_game_state) ──

pub fn note_loop_started(name: &'static str, ts_ms: f64) {
    if let Ok(mut m) = LOOPS.lock() {
        let s = m.entry(name).or_default();
        s.last_started_ms = ts_ms;
        s.running = true;
    }
}

pub fn note_loop_finished(name: &'static str, ts_ms: f64) {
    if let Ok(mut m) = LOOPS.lock() {
        let s = m.entry(name).or_default();
        s.last_finished_ms = ts_ms;
        s.running = false;
    }
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

/// The four native loops: name → (enabled, interval_ms) from live config.
fn loop_configs() -> [(&'static str, bool, f64); 4] {
    let h = auto_harvest::get();
    let b = auto_build::get();
    let d = auto_defend::get();
    let i = auto_infuse::get();
    [
        ("auto_harvest", h.enabled, h.interval_secs as f64 * 1000.0),
        ("auto_build", b.enabled, b.interval_secs as f64 * 1000.0),
        ("auto_defend", d.enabled, d.interval_secs as f64 * 1000.0),
        ("auto_infuse", i.enabled, i.interval_secs as f64 * 1000.0),
    ]
}

fn reset_loop_guard(name: &str) {
    match name {
        "auto_harvest" => auto_harvest::force_reset_running(),
        "auto_build" => auto_build::force_reset_running(),
        "auto_defend" => auto_defend::force_reset_running(),
        "auto_infuse" => auto_infuse::force_reset_running(),
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
    let stats = LOOPS.lock().map(|m| m.clone()).unwrap_or_default();
    for (name, enabled, interval_ms) in loop_configs() {
        let stat = stats.get(name).copied().unwrap_or_default();

        if stat.running && now - stat.last_started_ms > LOOP_STUCK_MS {
            let mins = ((now - stat.last_started_ms) / 60_000.0) as u64;
            let name_owned = name.to_string();
            findings.push(Finding {
                key: format!("wedged:{name}"),
                severity: Sev::Error,
                message: format!("{name} wedged: scan running for {mins} min (single-flight guard never cleared)"),
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
        let mut progress = HASH_PROGRESS.lock().unwrap();
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
                if now - last_change > HASH_STALL_MS {
                    let handle = entry.value().clone();
                    let mins = ((now - last_change) / 60_000.0) as u64;
                    findings.push(Finding {
                        key: format!("hash:{id}"),
                        severity: Sev::Warn,
                        message: format!(
                            "hash task {id} stalled: status running, no progress for {mins} min"
                        ),
                        remedy: Some(Box::new(move |_| {
                            handle.cancel.store(true, Ordering::Relaxed);
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
        let mut last = LAST_CHECK_MS.lock().unwrap();
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

    let mut fails = REMEDY_FAILS.lock().unwrap();
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

    let stats = LOOPS.lock().map(|m| m.clone()).unwrap_or_default();
    let mut overdue = Vec::new();
    let mut wedged = Vec::new();
    for (name, enabled, interval_ms) in loop_configs() {
        let stat = stats.get(name).copied().unwrap_or_default();
        if stat.running && now - stat.last_started_ms > LOOP_STUCK_MS {
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
