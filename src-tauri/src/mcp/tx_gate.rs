//! Global priority admission gate for signed transactions.
//!
//! WHY THIS EXISTS. Every transaction — from all six loops, the launch job and
//! every MCP tool — is signed by the ONE signing façade in the main window,
//! which drains roughly one tx per block. Each loop independently allowed
//! `effective_max_concurrent()` (10) in flight, and several loops run at once,
//! so the façade was handed ~40 concurrent requests and queued them FIFO.
//! Measured live at 936 vplayers: **209 s average tx latency with ZERO
//! retries** (attempt=1 for all 964 txs in a 2-hour window) — i.e. pure queue
//! wait — and single explores as slow as 71 minutes.
//!
//! Two consequences, one of them a correctness bug:
//!   * **Combat responses missed their window.** A raid must be answered inside
//!     ~2–4 minutes (`raid_status: initiated` → seize lock is 22 blocks). A
//!     response tx entering a 40-deep FIFO waits ~3.5 min, so the window was
//!     gone before the counter-attack was signed.
//!   * Launches and hand-driven actions sat behind hundreds of bulk builds,
//!     which is what made deploying more vplayers look stuck.
//!
//! Oversubscribing a serial resource cannot raise throughput — it only converts
//! latency into queue depth and destroys ordering. So this gate keeps the
//! façade's own queue SHALLOW (a handful of requests, enough to never leave it
//! idle) and does the ordering here, where priority can be honoured: time-
//! critical combat first, then interactive work, then bulk economy scans.
//! Throughput is unchanged — it was always façade-bound — but a Critical tx now
//! waits for a couple of in-flight signs instead of forty.
//!
//! It also publishes the in-flight count per loop, which is what lets the
//! watchdog tell "waiting on a slow chain" apart from "wedged" (harvest
//! explores legitimately run tens of minutes, so silence alone proves nothing).

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex, MutexGuard};

use tokio::sync::oneshot;

/// How many signs may be outstanding at the façade at once. Deliberately small:
/// the façade serialises, so this only needs to be large enough that it is
/// never starved for work. Bigger values buy nothing and re-create the deep
/// FIFO this module exists to prevent.
const MAX_IN_FLIGHT: usize = 4;

/// Scheduling class. Lower discriminant = admitted first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// Deadline-bound: a raid answer that is worthless if it lands late.
    Critical = 0,
    /// A human (or the launch job) is waiting on this right now.
    Interactive = 1,
    /// Periodic economy work. Throughput matters, latency does not.
    Bulk = 2,
}

impl Priority {
    /// Stable label for telemetry rows.
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Critical => "critical",
            Priority::Interactive => "interactive",
            Priority::Bulk => "bulk",
        }
    }
}

/// Classify a telemetry context (`"auto_response:1-194"`, `"launch:1-1230"`)
/// into a scheduling class. Unknown contexts are treated as Interactive: an
/// unrecognised caller is far more likely to be a tool a person is waiting on
/// than a bulk scan, and mis-ranking bulk work as interactive would only cost
/// some fairness, whereas the reverse costs a raid.
pub fn classify(context: &str) -> Priority {
    let head = context.split(':').next().unwrap_or(context);
    match head {
        "auto_response" => Priority::Critical,
        "auto_build" | "auto_harvest" | "auto_defend" | "auto_sweep" | "auto_infuse"
        | "auto_raid" => Priority::Bulk,
        _ => Priority::Interactive,
    }
}

/// A parked caller. No sequence number needed: one FIFO per class already
/// gives oldest-first ordering within a class, and classes are drained in
/// order, so equal-priority callers can never starve each other.
struct Waiter {
    tx: oneshot::Sender<()>,
}

struct State {
    in_flight: usize,
    /// One FIFO per class, drained strictly in class order.
    queues: [VecDeque<Waiter>; 3],
    /// loop_name → outstanding signs (queued OR executing). Read by the
    /// watchdog: a loop with work outstanding is alive by definition.
    per_loop: HashMap<&'static str, usize>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        in_flight: 0,
        queues: [VecDeque::new(), VecDeque::new(), VecDeque::new()],
        per_loop: HashMap::new(),
    })
});

fn lock() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Held for one signing attempt; releasing admits the next-highest-priority
/// waiter. Dropping on a cancelled future is safe and is the normal way an
/// abandoned attempt gives its slot back.
pub struct Permit {
    loop_name: Option<&'static str>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut st = lock();
        st.in_flight = st.in_flight.saturating_sub(1);
        if let Some(name) = self.loop_name {
            if let Some(n) = st.per_loop.get_mut(name) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    st.per_loop.remove(name);
                }
            }
        }
        // Hand the freed slot to the best waiter. A receiver that has gone away
        // (caller cancelled) frees the slot again on the next iteration.
        while st.in_flight < MAX_IN_FLIGHT {
            let Some(w) = st
                .queues
                .iter_mut()
                .find_map(|q| q.pop_front())
            else {
                break;
            };
            if w.tx.send(()).is_ok() {
                st.in_flight += 1;
                break;
            }
        }
    }
}

/// Wait for permission to sign. Returns a [`Permit`] to hold for the whole
/// attempt. Cheap and lock-free in the uncontended case (slot available →
/// no channel, no await point beyond the immediate return).
pub async fn acquire(context: &str) -> Permit {
    let priority = classify(context);
    let loop_name = crate::mcp::watchdog::loop_name_of(context);
    let rx = {
        let mut st = lock();
        // Count the request the moment it is made, not when it is admitted:
        // time spent QUEUED is still time the loop is legitimately busy.
        if let Some(name) = loop_name {
            *st.per_loop.entry(name).or_insert(0) += 1;
        }
        if st.in_flight < MAX_IN_FLIGHT {
            st.in_flight += 1;
            return Permit { loop_name };
        }
        let (tx, rx) = oneshot::channel();
        st.queues[priority as usize].push_back(Waiter { tx });
        rx
    };
    // Admission increments `in_flight` on the RELEASING side (that is what
    // hands us the slot). If the sender vanished without sending — no live path
    // does this, since waiters are only ever dropped by sending — we would owe
    // ourselves that increment, or the Permit's decrement would under-count and
    // permanently inflate capacity. Balance it here rather than leave a latent
    // accounting hole.
    if rx.await.is_err() {
        lock().in_flight += 1;
    }
    Permit { loop_name }
}

/// Outstanding signs (queued or executing) for a loop — the watchdog's proof
/// that a silent loop is waiting on the chain rather than wedged.
pub fn in_flight_for(loop_name: &str) -> usize {
    lock().per_loop.get(loop_name).copied().unwrap_or(0)
}

/// Gate gauges for `structs_system tx`.
pub fn snapshot() -> serde_json::Value {
    let st = lock();
    serde_json::json!({
        "in_flight": st.in_flight,
        "cap": MAX_IN_FLIGHT,
        "queued_critical": st.queues[0].len(),
        "queued_interactive": st.queues[1].len(),
        "queued_bulk": st.queues[2].len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gate is ONE process-global semaphore, so the two tests that fill it
    /// to `MAX_IN_FLIGHT` cannot run at the same time — `cargo test` runs them
    /// in parallel by default and each would then count the other's permits.
    /// Poisoning is ignored: a panic in one test should fail that test, not
    /// cascade into every later one.
    static GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn exclusive() -> std::sync::MutexGuard<'static, ()> {
        GATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn classify_by_context_head() {
        assert_eq!(classify("auto_response:1-194"), Priority::Critical);
        assert_eq!(classify("auto_build:1-1044"), Priority::Bulk);
        assert_eq!(classify("auto_harvest"), Priority::Bulk);
        assert_eq!(classify("auto_raid:2-855"), Priority::Bulk);
        // Launch and tool traffic outrank bulk scans.
        assert_eq!(classify("launch:1-1230"), Priority::Interactive);
        assert_eq!(classify("structs_action"), Priority::Interactive);
        assert_eq!(classify("mass_action:sweep"), Priority::Interactive);
    }

    #[test]
    fn priority_order_is_critical_first() {
        assert!(Priority::Critical < Priority::Interactive);
        assert!(Priority::Interactive < Priority::Bulk);
    }

    #[tokio::test]
    async fn cap_bounds_in_flight_and_permits_release() {
        let _gate = exclusive();
        let mut held = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            held.push(acquire("auto_build:test").await);
        }
        assert_eq!(lock().in_flight, MAX_IN_FLIGHT);
        assert_eq!(in_flight_for("auto_build"), MAX_IN_FLIGHT);

        // One more must QUEUE, not admit.
        let queued = tokio::spawn(async { acquire("auto_build:test").await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(lock().queues[Priority::Bulk as usize].len(), 1);

        held.clear(); // release everything
        let p = tokio::time::timeout(std::time::Duration::from_secs(2), queued)
            .await
            .expect("queued acquire completes once a slot frees")
            .unwrap();
        drop(p);
        assert_eq!(in_flight_for("auto_build"), 0, "per-loop count unwinds");
    }

    #[tokio::test]
    async fn critical_jumps_ahead_of_bulk() {
        let _gate = exclusive();
        let mut held = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            held.push(acquire("auto_build:fill").await);
        }
        // Queue bulk FIRST, then critical: order of arrival must not decide.
        let bulk = tokio::spawn(async { acquire("auto_harvest:later").await });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let critical = tokio::spawn(async { acquire("auto_response:raid").await });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        // Free exactly ONE slot; the critical waiter must take it.
        held.pop();
        let winner = tokio::time::timeout(std::time::Duration::from_secs(2), critical)
            .await
            .expect("critical admitted on the first free slot")
            .unwrap();
        assert!(!bulk.is_finished(), "bulk still waiting behind critical");
        drop(winner);
        held.clear();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), bulk).await;
    }
}
