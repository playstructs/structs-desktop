//! Mandates: limits a standing order sets on what a loop may do.
//!
//! A mandate caps how many transactions a loop may LAND per rolling hour —
//! `auto_sweep` moving alpha, `auto_infuse` staking it, `auto_build` starting
//! builds. The loop is named by the prefix of the transaction's context
//! (`auto_sweep:1-123` → `auto_sweep`). A send past the cap is refused
//! before it is signed and recorded like any other skip; the loop simply
//! tries again once the hour rolls on. The caps live in the standing orders
//! (`Orders::mandates`), so who set them and when is in the revision history.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

const HOUR_MS: f64 = 3_600_000.0;

/// The limits on one loop.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Mandate {
    /// Landed transactions per rolling hour; `None` = no cap.
    #[serde(default)]
    pub max_tx_per_hour: Option<u32>,
}

static LANDED: LazyLock<Mutex<BTreeMap<String, VecDeque<f64>>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// The loop a transaction context belongs to.
pub fn loop_of(context: &str) -> &str {
    context.split(':').next().unwrap_or(context)
}

fn prune(q: &mut VecDeque<f64>, now: f64) {
    while q.front().is_some_and(|t| now - *t >= HOUR_MS) {
        q.pop_front();
    }
}

/// Would one more landed transaction for `context` exceed its mandate?
/// `Some(why)` = refuse. Pure but for the clock and the counters.
pub fn exceeds(mandates: &BTreeMap<String, Mandate>, context: &str, now: f64) -> Option<String> {
    let name = loop_of(context);
    let cap = mandates.get(name)?.max_tx_per_hour?;
    let mut m = LANDED.lock().ok()?;
    let q = m.entry(name.to_string()).or_default();
    prune(q, now);
    (q.len() as u32 >= cap).then(|| format!("{name} landed {} of its {cap} transactions this hour", q.len()))
}

/// A transaction for `context` landed.
pub fn note_landed(context: &str, now: f64) {
    if let Ok(mut m) = LANDED.lock() {
        let q = m.entry(loop_of(context).to_string()).or_default();
        prune(q, now);
        q.push_back(now);
    }
}

/// Landed transactions per loop in the last hour.
pub fn usage(now: f64) -> BTreeMap<String, usize> {
    LANDED
        .lock()
        .map(|mut m| {
            m.iter_mut()
                .map(|(k, q)| {
                    prune(q, now);
                    (k.clone(), q.len())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The live mandates (from the standing orders).
pub fn live() -> BTreeMap<String, Mandate> {
    crate::mcp::orders::current().mandates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(n: u32) -> BTreeMap<String, Mandate> {
        BTreeMap::from([("test_sweep".to_string(), Mandate { max_tx_per_hour: Some(n) })])
    }

    #[test]
    fn a_loop_is_named_by_its_context_prefix() {
        assert_eq!(loop_of("auto_sweep:1-123"), "auto_sweep");
        assert_eq!(loop_of("pow_complete"), "pow_complete");
    }

    #[test]
    fn a_cap_refuses_once_the_hour_is_full_and_frees_as_it_rolls() {
        let m = cap(2);
        let t0 = 10_000_000.0;
        assert!(exceeds(&m, "test_sweep:1-1", t0).is_none());
        note_landed("test_sweep:1-1", t0);
        note_landed("test_sweep:1-2", t0 + 1.0);
        assert!(exceeds(&m, "test_sweep:1-3", t0 + 2.0).is_some());
        assert!(exceeds(&m, "test_sweep:1-3", t0 + HOUR_MS + 2.0).is_none(), "an hour later both have rolled off");
    }

    #[test]
    fn loops_without_a_mandate_are_never_refused() {
        assert!(exceeds(&cap(0), "auto_build:1-1", 1.0).is_none());
    }
}
