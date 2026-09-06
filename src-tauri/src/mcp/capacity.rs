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
        },
        "tx": {
            "cap": crate::mcp::tx_gate::cap(),
            "in_flight": gate.get("in_flight").cloned().unwrap_or(Value::Null),
            "queued": {
                "critical": gate.get("queued_critical").cloned().unwrap_or(Value::Null),
                "interactive": gate.get("queued_interactive").cloned().unwrap_or(Value::Null),
                "bulk": gate.get("queued_bulk").cloned().unwrap_or(Value::Null),
            },
        },
        "reads": {
            "max_concurrent": crate::mcp::loop_util::effective_max_concurrent(),
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
