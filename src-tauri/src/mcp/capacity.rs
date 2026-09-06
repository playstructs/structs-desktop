//! The capacity façade: one place to SEE and to CHANGE every slot budget.
//!
//! Three resources, each discovered by its own outage and each with its own
//! module: the GPU grinder pool (`hasher::max_concurrent`, born of the
//! 1,529-thread leak), chain inclusion (`tx_gate::cap`, born of the 0.66
//! signs/s ceiling), and read fan-out (`loop_util::effective_max_concurrent`,
//! the AIMD born of 429s). Two policies move them — the hash tuner and the
//! AIMD — and until now each logged in its own words and showed in its own
//! corner of status, so a question like "why is the pool at 3" meant reading
//! three logs.
//!
//! This module does not yet OWN admission (the three modules keep their
//! semaphores; see proposals/next-steps-2026-09-05.md §3 for the order in
//! which they move behind one `acquire`). It owns the two things that were
//! missing: every change to a budget passes through [`adjust`], which logs
//! one shape and keeps the last changes; and [`snapshot`] shows all three
//! budgets, their live use and their saturation signal in one block.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use crate::hasher::types::now_millis;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resource {
    /// GPU grinder slots (and the difficulty the pool waits for).
    Gpu,
    /// Transactions in flight through the signing façade.
    TxInclusion,
    /// Per-player bodies in flight per scan (guild / LCD reads).
    Reads,
}

impl Resource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gpu => "gpu",
            Self::TxInclusion => "tx",
            Self::Reads => "reads",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Change {
    pub at_ms: f64,
    pub resource: &'static str,
    pub knob: &'static str,
    pub from: u64,
    pub to: u64,
    pub because: String,
}

const KEEP: usize = 40;
static CHANGES: LazyLock<Mutex<VecDeque<Change>>> = LazyLock::new(|| Mutex::new(VecDeque::with_capacity(KEEP)));

/// Record a budget change. Every policy that moves a cap calls this — the
/// tuner, the AIMD, the config command — so the feed shows one shape:
/// `capacity: gpu max_concurrent 12→11 because grind throughput 0.42× baseline`.
pub fn adjust(resource: Resource, knob: &'static str, from: u64, to: u64, because: impl Into<String>) {
    let because = because.into();
    let change = Change { at_ms: now_millis(), resource: resource.as_str(), knob, from, to, because: because.clone() };
    if let Ok(mut c) = CHANGES.lock() {
        if c.len() >= KEEP {
            c.pop_front();
        }
        c.push_back(change);
    }
    let sev = if to < from { crate::mcp::telemetry::Sev::Warn } else { crate::mcp::telemetry::Sev::Notice };
    crate::mcp::telemetry::tlog_kv(
        "capacity",
        sev,
        format!("capacity: {} {knob} {from}→{to} because {because}", resource.as_str()),
        json!({ "resource": resource.as_str(), "knob": knob, "from": from, "to": to }),
    );
}

/// The GPU grinder's two knobs change HERE and nowhere else — the tuner, the
/// `structs_hash config` command and the board's CONFIG page all come
/// through, so every change is recorded with its reason and the raw setters
/// in `hasher` are only for boot. A no-op change is not recorded.
pub fn set_gpu_concurrency(to: u64, because: impl Into<String>) {
    let from = crate::hasher::max_concurrent();
    if from == to {
        return;
    }
    crate::hasher::set_max_concurrent(to);
    adjust(Resource::Gpu, "max_concurrent", from, to, because);
}

pub fn set_gpu_difficulty(to: u64, because: impl Into<String>) {
    let from = crate::hasher::difficulty_start();
    if from == to {
        return;
    }
    crate::hasher::set_difficulty_start(to);
    adjust(Resource::Gpu, "difficulty_start", from, to, because);
}

// ── Admission: the three doors, one module ──────────────────────────────────
// The scheduler, the transaction gate and the loop fan-out keep their own
// mechanics (a priority heap, priority queues, a per-scan JoinSet); every
// caller comes through here so there is one place to read, one to change.

/// Wait for a signing slot. Held for the whole attempt; dropping releases it.
pub async fn acquire_tx(context: &str) -> crate::mcp::tx_gate::Permit {
    crate::mcp::tx_gate::acquire(context).await
}

/// Wait for a grinder slot, easiest difficulty first. `None` if cancelled
/// while waiting.
pub fn admit_gpu(difficulty: u64, cancelled: &dyn Fn() -> bool) -> Option<crate::hasher::scheduler::Permit> {
    crate::hasher::scheduler::admit(difficulty, cancelled)
}

/// How many player bodies a scan may have in flight right now.
pub fn reads_fanout() -> usize {
    crate::mcp::loop_util::effective_max_concurrent()
}

// ── Saturation: the one measured signal per resource ─────────────────────────

/// Why a resource is saturated right now, or `None`. The watchdog reads this
/// rather than inferring pressure from loop timings.
pub fn saturation(resource: Resource) -> Option<String> {
    match resource {
        Resource::Gpu => gpu_saturated(&crate::hasher::tuner::last_signal()),
        Resource::TxInclusion => {
            let g = crate::mcp::tx_gate::snapshot();
            let n = |k: &str| g.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            tx_saturated(n("in_flight"), n("queued_critical") + n("queued_interactive") + n("queued_bulk"), crate::mcp::tx_gate::cap())
        }
        Resource::Reads => reads_saturated(
            crate::mcp::loop_util::recent_pressure_failures(),
            crate::mcp::loop_util::effective_max_concurrent(),
            crate::mcp::loop_util::MIN_CONCURRENT_PLAYERS,
        ),
    }
}

/// Every resource that is saturated, with its reason.
pub fn saturated() -> Vec<(Resource, String)> {
    [Resource::Gpu, Resource::TxInclusion, Resource::Reads]
        .into_iter()
        .filter_map(|r| saturation(r).map(|why| (r, why)))
        .collect()
}

fn gpu_saturated(signal: &Value) -> Option<String> {
    if signal.get("wedged").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Some("grinder wedged: p90 solve over the wedge threshold".into());
    }
    let t = signal.get("throughput")?;
    if t.get("verdict").and_then(|v| v.as_str()) == Some("degraded") {
        let ratio = t.get("ratio").and_then(|v| v.as_f64()).unwrap_or(0.0);
        return Some(format!("grind throughput {ratio:.2}× baseline"));
    }
    None
}

/// Saturated when the gate is full AND the queue behind it is at least two
/// gates deep — one gate's worth queued is a normal burst.
fn tx_saturated(in_flight: usize, queued: usize, cap: usize) -> Option<String> {
    if cap > 0 && in_flight >= cap && queued >= cap * 2 {
        Some(format!("{queued} signs queued behind {in_flight} in flight (cap {cap})"))
    } else {
        None
    }
}

/// Saturated when failures are clustering (the AIMD's own trigger) or the
/// fan-out has already been driven to its floor.
fn reads_saturated(failures_last_minute: usize, current: usize, floor: usize) -> Option<String> {
    if failures_last_minute >= 3 {
        return Some(format!("{failures_last_minute} endpoint failures in a minute"));
    }
    if current <= floor {
        return Some(format!("fan-out pinned at its floor of {floor}"));
    }
    None
}

pub fn recent_changes() -> Vec<Change> {
    CHANGES.lock().map(|c| c.iter().cloned().collect()).unwrap_or_default()
}

/// All three budgets, their live use, and the signal each policy acts on.
pub fn snapshot() -> Value {
    let gate = crate::mcp::tx_gate::snapshot();
    let tuner = crate::hasher::tuner::last_signal();
    json!({
        "gpu": {
            "max_concurrent": crate::hasher::max_concurrent(),
            "running": crate::hasher::scheduler::running(),
            "workers": crate::hasher::pool::worker_count(),
            "pending": crate::hasher::pool::pending_len(),
            "difficulty_start": crate::hasher::difficulty_start(),
            "signal": tuner.get("throughput").cloned().unwrap_or(Value::Null),
            "saturated": saturation(Resource::Gpu),
        },
        "tx": {
            "cap": crate::mcp::tx_gate::cap(),
            "saturated": saturation(Resource::TxInclusion),
            "in_flight": gate.get("in_flight").cloned().unwrap_or(Value::Null),
            "queued": {
                "critical": gate.get("queued_critical").cloned().unwrap_or(Value::Null),
                "interactive": gate.get("queued_interactive").cloned().unwrap_or(Value::Null),
                "bulk": gate.get("queued_bulk").cloned().unwrap_or(Value::Null),
            },
        },
        "reads": {
            "max_concurrent": crate::mcp::loop_util::effective_max_concurrent(),
            "saturated": saturation(Resource::Reads),
            "ceiling": crate::mcp::loop_util::MAX_CONCURRENT_PLAYERS,
            "signal": { "pressure_failures_last_minute": crate::mcp::loop_util::recent_pressure_failures() },
        },
        "changes": recent_changes(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_gate_with_a_burst_behind_it_is_not_saturated_but_two_gates_deep_is() {
        assert_eq!(tx_saturated(4, 4, 4), None, "one gate's worth queued is a burst");
        assert_eq!(tx_saturated(3, 40, 4), None, "the gate is not even full");
        assert!(tx_saturated(4, 8, 4).unwrap().contains("8 signs queued"));
        assert_eq!(tx_saturated(0, 0, 0), None);
    }

    #[test]
    fn reads_saturate_on_clustered_failures_or_at_the_floor() {
        assert_eq!(reads_saturated(0, 10, 2), None);
        assert!(reads_saturated(3, 10, 2).unwrap().contains("3 endpoint failures"));
        assert!(reads_saturated(0, 2, 2).unwrap().contains("floor"));
    }

    #[test]
    fn the_gpu_saturates_on_the_tuner_verdict_only() {
        assert_eq!(gpu_saturated(&Value::Null), None, "no signal yet is not saturation");
        assert_eq!(gpu_saturated(&json!({"throughput": {"verdict": "healthy", "ratio": 1.2}})), None);
        assert!(gpu_saturated(&json!({"throughput": {"verdict": "degraded", "ratio": 0.42}})).unwrap().contains("0.42"));
        assert!(gpu_saturated(&json!({"wedged": true})).unwrap().contains("wedged"));
    }

    use super::*;

    #[test]
    fn every_change_is_kept_in_one_shape_and_bounded() {
        // The ring is process-global and other tests (the AIMD, the tuner)
        // record into it concurrently, so this test recognises its own
        // entries by a unique reason rather than assuming it wrote last.
        let mark = format!("test pressure {}", now_millis());
        for i in 0..(KEEP as u64 + 5) {
            adjust(Resource::Reads, "max_concurrent", i + 1, i, mark.clone());
        }
        let c = recent_changes();
        assert!(c.len() <= KEEP, "bounded ring");
        let mine: Vec<&Change> = c.iter().filter(|x| x.because == mark).collect();
        assert!(!mine.is_empty());
        let last = mine.last().unwrap();
        assert_eq!((last.resource, last.knob, last.from, last.to), ("reads", "max_concurrent", KEEP as u64 + 5, KEEP as u64 + 4));
        assert!(mine.windows(2).all(|w| w[0].at_ms <= w[1].at_ms), "kept in order");
        assert_eq!(Resource::Gpu.as_str(), "gpu");
        assert_eq!(Resource::TxInclusion.as_str(), "tx");
    }
}
