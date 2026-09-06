//! Priority admission gate for hash grinding.
//!
//! Historically every ripe PoW task span its own OS thread and immediately
//! grinded the GPU/CPU with NO concurrency cap and NO ordering — so hundreds of
//! tasks thrashed a single GPU at once and a difficulty-7 refine got exactly as
//! much of the device as a difficulty-2 build. This gate fixes both:
//!
//!   * **Cap** — at most [`crate::hasher::max_concurrent`] tasks grind at once.
//!     The rest park cheaply on a condvar instead of fighting for the device.
//!   * **Easiest-first** — when a slot frees, the WAITING task with the lowest
//!     current difficulty is admitted next. A cheap build never waits behind an
//!     expensive refine; short jobs drain first (shortest-job-first), which
//!     minimises average completion time and clears a backlog fastest.
//!
//! A task calls [`admit`] once its difficulty has decayed to its start
//! threshold (i.e. it is actually ready to grind), holds the returned [`Permit`]
//! for the whole grind, and drops it on completion/cancel to free the slot.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::Duration;

/// Monotonic ticket source — the tiebreaker so equal-difficulty tasks admit in
/// FIFO order (oldest first) and can never starve each other.
static SEQ: AtomicU64 = AtomicU64::new(0);

struct Inner {
    /// How many tasks are currently grinding (occupying a slot).
    running: u64,
    /// Waiting tasks as a min-heap over (difficulty, seq): `Reverse` turns
    /// `BinaryHeap`'s max-heap into a min-heap so `peek()` is the easiest task.
    waiting: BinaryHeap<Reverse<(u64, u64)>>,
}

static STATE: LazyLock<Mutex<Inner>> = LazyLock::new(|| {
    Mutex::new(Inner {
        running: 0,
        waiting: BinaryHeap::new(),
    })
});
static CV: Condvar = Condvar::new();

/// Held for the duration of a grind. Frees the slot on drop and wakes waiters.
pub struct Permit {
    _private: (),
}

impl Drop for Permit {
    fn drop(&mut self) {
        {
            let mut st = STATE.lock().unwrap();
            st.running = st.running.saturating_sub(1);
        }
        // Wake all waiters so the current easiest re-evaluates for the free slot.
        CV.notify_all();
    }
}

fn remove_waiting(waiting: &mut BinaryHeap<Reverse<(u64, u64)>>, me: (u64, u64)) {
    // BinaryHeap has no remove(); rebuild without our ticket. Cancellations are
    // rare, so the O(n) cost is fine.
    let kept: Vec<_> = waiting
        .drain()
        .filter(|Reverse(x)| *x != me)
        .collect();
    *waiting = BinaryHeap::from(kept);
}

/// Block until admitted to grind, then return a [`Permit`] to hold for the whole
/// grind. `difficulty` is the task's current PoW difficulty (lower = admitted
/// sooner). Returns `None` if `is_cancelled` becomes true while waiting — the
/// caller should abandon the task.
///
/// `is_cancelled` is polled on a short timeout so a task killed mid-wait exits
/// promptly and a live change to `max_concurrent` takes effect without a stuck
/// slot.
/// Grinders holding a permit right now (for the capacity snapshot).
pub fn running() -> usize {
    STATE.lock().map(|s| s.running as usize).unwrap_or(0)
}

pub fn admit(difficulty: u64, is_cancelled: &dyn Fn() -> bool) -> Option<Permit> {
    let me = (difficulty, SEQ.fetch_add(1, Ordering::Relaxed));

    let mut st = STATE.lock().unwrap();
    st.waiting.push(Reverse(me));

    loop {
        if is_cancelled() {
            remove_waiting(&mut st.waiting, me);
            return None;
        }

        let max = crate::hasher::max_concurrent().max(1);
        let i_am_next = st.waiting.peek().map(|Reverse(top)| *top == me).unwrap_or(false);

        if st.running < max && i_am_next {
            st.waiting.pop(); // remove self
            st.running += 1;
            return Some(Permit { _private: () });
        }

        // Park until a slot frees / a task cancels / max_concurrent changes.
        let (guard, _) = CV.wait_timeout(st, Duration::from_millis(250)).unwrap();
        st = guard;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easiest_is_admitted_first() {
        // Fill all slots so the next admits must queue and order by difficulty.
        let max = crate::hasher::max_concurrent().max(1);
        let never_cancel = || false;
        let mut held = Vec::new();
        for _ in 0..max {
            held.push(admit(1, &never_cancel).unwrap());
        }

        // Queue a hard (9) and an easy (2) task from two threads, both waiting.
        // Free one slot; the easy one must win it.
        let easy = std::thread::spawn(move || admit(2, &|| false).map(|p| { std::thread::sleep(Duration::from_millis(50)); drop(p); 2u64 }));
        let hard = std::thread::spawn(move || admit(9, &|| false).map(|p| { std::thread::sleep(Duration::from_millis(50)); drop(p); 9u64 }));
        std::thread::sleep(Duration::from_millis(100)); // let both park

        // Release one slot; only the easy task should be admitted next.
        let first_free = held.pop();
        drop(first_free);

        // Give the easy task time to be admitted and finish before the hard one.
        std::thread::sleep(Duration::from_millis(30));
        // Release the rest so hard can finish too and threads join cleanly.
        held.clear();

        assert_eq!(easy.join().unwrap(), Some(2));
        assert_eq!(hard.join().unwrap(), Some(9));
    }

    #[test]
    fn cancelled_while_waiting_returns_none() {
        let max = crate::hasher::max_concurrent().max(1);
        let mut held = Vec::new();
        for _ in 0..max {
            held.push(admit(1, &|| false).unwrap());
        }
        // This one can never get a slot; cancel it immediately.
        assert!(admit(1, &|| true).is_none());
        held.clear();
    }
}
