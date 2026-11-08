//! Bounded worker pool for PoW tasks — the fix for thread-per-task bloat.
//!
//! Historically `start_hash_task_core` spawned ONE OS THREAD PER TASK at
//! enqueue. Each thread slept through the difficulty decay, then parked inside
//! `scheduler::admit` until one of `max_concurrent` slots freed — so the
//! process's thread count tracked the QUEUE DEPTH, not the concurrency cap.
//! With a large roster that meant >1,200 parked threads (observed live:
//! 1,529 threads at 1,305 queued tasks), the same failure family as the
//! historic 343-thread SIGABRT crash, and marching toward the macOS ~4k
//! per-process thread limit as the fleet grows. Every completed proof also
//! `notify_all`ed the whole herd awake just to re-park all but one.
//!
//! Now enqueue is threadless: a task waits in [`PENDING`] as a plain registry
//! entry, and a pool of at most `max_concurrent` workers pops the easiest RIPE
//! task (current difficulty ≤ `difficulty_start`, easiest-first — same policy
//! the scheduler heap enforced) and runs the unchanged gpu/cpu worker body
//! inline. Thread count is now O(cap), not O(queue).
//!
//! The legacy paths are deliberately kept as belt-and-braces guards rather
//! than re-implemented: because the pool only picks ripe tasks, the decay-wait
//! loop inside `run_gpu_hash`/`run_cpu_hash` exits on its first check, and
//! `scheduler::admit` admits immediately (workers ≤ slots) while still
//! enforcing the cap correctly if `max_concurrent` is lowered mid-grind.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;

use crate::hasher::difficulty::{calculate_difficulty, estimate_age, refresh_checkpoint};
use crate::hasher::types::{now_millis, TaskHandle, TaskRegistry};

/// Tasks enqueued but not yet picked by a worker. Order is irrelevant — the
/// pop scans for the easiest ripe task each time (the set is small enough that
/// an O(n) scan every few seconds is free, and difficulty changes as blocks
/// tick so a static ordering would go stale anyway).
static PENDING: LazyLock<Mutex<Vec<Arc<TaskHandle>>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static CV: Condvar = Condvar::new();

/// Live worker-thread count; compared against [`pool_cap`] to grow on demand
/// and self-retire when the cap is lowered.
static WORKERS: AtomicU64 = AtomicU64::new(0);

/// App handle + registry captured on first enqueue; workers read from here so
/// the pool has no per-task closure state.
static CTX: OnceLock<(AppHandle, Arc<TaskRegistry>)> = OnceLock::new();

/// How long an idle worker parks between ripeness re-scans. Blocks tick every
/// ~5.8s, so ripeness changes on that timescale; 2s keeps pickup latency well
/// under one block without busy-scanning.
const IDLE_POLL_MS: u64 = 2000;

/// How long, on average, an idle worker may spend on one task it takes
/// before the task has decayed to `difficulty_start`.
const EARLY_GRIND_SECS: f64 = 30.0;

/// Workers currently grinding a task taken early. Kept below the cap so one
/// worker is always free for work that is ripe at `difficulty_start`.
static EARLY_GRINDS: AtomicU64 = AtomicU64::new(0);

fn pool_cap() -> u64 {
    crate::hasher::max_concurrent().clamp(1, 64)
}

/// Queue a task for the pool. The registry entry must already be inserted.
/// Status flips to "waiting" immediately so list/board snapshots never show a
/// queued task as its stale prior status.
pub fn enqueue(app: &AppHandle, registry: &Arc<TaskRegistry>, handle: Arc<TaskHandle>) {
    let _ = CTX.set((app.clone(), Arc::clone(registry)));
    {
        let mut progress = handle.progress.lock().unwrap();
        progress.status = "waiting".to_string();
        progress.last_status_change_time_ms = now_millis();
    }
    PENDING.lock().unwrap().push(handle);
    ensure_workers();
    CV.notify_all();
}

/// Grow the pool up to the current cap. Called on every enqueue and on live
/// `max_concurrent` raises; a no-op once at cap. Shrinking is handled by the
/// workers themselves (they retire after finishing a task when over cap).
pub fn ensure_workers() {
    if CTX.get().is_none() {
        return; // nothing has ever been enqueued; workers would have no context
    }
    let cap = pool_cap();
    loop {
        let cur = WORKERS.load(Ordering::SeqCst);
        if cur >= cap {
            return;
        }
        if WORKERS
            .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            continue; // raced another grower; re-read
        }
        if std::thread::Builder::new()
            .name("structs-hash-pool".into())
            .spawn(worker_loop)
            .is_err()
        {
            WORKERS.fetch_sub(1, Ordering::SeqCst);
            return; // OS refused a thread; existing workers keep draining
        }
    }
}

fn worker_loop() {
    let Some((app, registry)) = CTX.get().cloned() else {
        WORKERS.fetch_sub(1, Ordering::SeqCst);
        return;
    };
    loop {
        // Self-retire if the cap was lowered below the live worker count.
        loop {
            let cur = WORKERS.load(Ordering::SeqCst);
            if cur <= pool_cap() {
                break;
            }
            if WORKERS
                .compare_exchange(cur, cur - 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return;
            }
        }

        match pop_ripest(&registry) {
            Some((handle, early)) => {
                // Stamp the moment REAL work begins. Everything before this is
                // queue wait, and folding that into "solve duration" is what
                // drove the tuner into its concurrency collapse — see
                // TaskProgress::work_start_time_ms.
                if let Ok(mut p) = handle.progress.lock() {
                    p.work_start_time_ms = Some(now_millis());
                }
                run_one(&app, &registry, handle);
                if early {
                    EARLY_GRINDS.fetch_sub(1, Ordering::SeqCst);
                }
            }
            None => {
                let pending = PENDING.lock().unwrap();
                let _ = CV
                    .wait_timeout(pending, Duration::from_millis(IDLE_POLL_MS))
                    .unwrap();
            }
        }
    }
}

/// Which pending task a free worker takes, by each task's current
/// difficulty. Pure.
///
/// The easiest task at or under `start` first (earliest on ties) — the
/// ordinary rule. With none, and `early_ok`, the easiest task at or under
/// `ceiling`: the chain accepts any proof that meets the CURRENT difficulty,
/// so a worker that would otherwise sit idle grinds it now instead of letting
/// the task wait for the cheap threshold. Refining is the economy's
/// bottleneck and its 28,000-block range takes ~4,000 blocks (~6 h) to decay
/// from 7 to 5, so idle GPU time spent here is cycle time won. Returns the
/// index and whether it was taken early.
pub(crate) fn choose(difficulties: &[u64], start: u64, ceiling: Option<u64>, early_ok: bool) -> Option<(usize, bool)> {
    let easiest = |limit: u64| {
        difficulties
            .iter()
            .enumerate()
            .filter(|(_, d)| **d <= limit)
            .fold(None::<(usize, u64)>, |best, (i, d)| if best.is_none_or(|(_, b)| *d < b) { Some((i, *d)) } else { best })
            .map(|(i, _)| i)
    };
    if let Some(i) = easiest(start) {
        return Some((i, false));
    }
    match ceiling {
        Some(c) if early_ok && c > start => easiest(c).map(|i| (i, true)),
        _ => None,
    }
}

/// Pop the task a free worker should run (see [`choose`]), pruning entries
/// cancelled or superseded while queued. Also refreshes each pending task's
/// `block_current_estimated` so list/board ETAs stay live without a thread
/// per task. Returns `None` when nothing is worth grinding yet, and whether
/// the task was taken early (its `grind_at` is then set).
fn pop_ripest(registry: &Arc<TaskRegistry>) -> Option<(Arc<TaskHandle>, bool)> {
    let now_ms = now_millis();
    let difficulty_start = crate::hasher::difficulty_start();
    let mut pending = PENDING.lock().unwrap();

    // Same ptr-eq guard as reap_self: a task restarted for the same struct
    // while queued leaves a stale Arc here — drop it, never run it.
    pending.retain(|h| {
        !h.is_cancelled()
            && registry
                .tasks
                .get(&h.params.object_id)
                .is_some_and(|e| Arc::ptr_eq(e.value(), h))
    });

    let mut difficulties = Vec::with_capacity(pending.len());
    for h in pending.iter() {
        // The SAME ripeness the worker will compute a moment later: refresh
        // the checkpoint from the live height first. Without this the pool
        // extrapolated from the checkpoint stamped at enqueue, and blocks run
        // 5.30 s, not the assumed 5.28 s — 0.4 % — so a task pending for
        // hours was judged ~30 blocks older than it was, popped a couple of
        // minutes early, and the worker (which DOES refresh) found it unripe
        // and slept it out in 10-second steps holding a pool slot. That was
        // a third of all "solves" over 10 s on 2026-09-05 with a healthy
        // GPU, and the tuner read those sleeps as degradation and removed
        // workers.
        let (age, block_est) = {
            let mut progress = h.progress.lock().unwrap();
            let (cp, cpt) = refresh_checkpoint(
                progress.block_checkpoint,
                progress.block_checkpoint_time_ms,
                now_ms,
            );
            progress.block_checkpoint = cp;
            progress.block_checkpoint_time_ms = cpt;
            estimate_age(h.params.block_start, cp, cpt, now_ms)
        };
        let difficulty = calculate_difficulty(age, h.params.difficulty_target);
        {
            let mut progress = h.progress.lock().unwrap();
            progress.block_current_estimated = block_est;
        }
        difficulties.push(difficulty);
    }
    let ceiling = crate::hasher::tuner::measured_rate().map(|r| crate::hasher::tuner::affordable_difficulty(r, EARLY_GRIND_SECS));
    let early_ok = EARLY_GRINDS.load(Ordering::SeqCst) + 1 < pool_cap();
    let (i, early) = choose(&difficulties, difficulty_start, ceiling, early_ok)?;
    let handle = pending.swap_remove(i);
    if early {
        handle.grind_at.store(difficulties[i], Ordering::Relaxed);
        EARLY_GRINDS.fetch_add(1, Ordering::SeqCst);
    }
    Some((handle, early))
}

/// The old per-task thread body, run inline on a pool worker: engine dispatch,
/// panic isolation, and self-reaping. A panic poisons nothing — the worker
/// logs, reaps, and moves on to the next task.
fn run_one(app: &AppHandle, registry: &Arc<TaskRegistry>, handle: Arc<TaskHandle>) {
    let pid = handle.params.object_id.clone();
    let use_gpu = crate::hasher::resolve_use_gpu();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if use_gpu {
            let device = super::GPU_DEVICE.get().unwrap().clone();
            let queue = super::GPU_QUEUE.get().unwrap().clone();
            eprintln!("[Structs Hasher] Starting task {} on GPU", pid);
            super::gpu::run_gpu_hash(handle.clone(), device, queue, app.clone());
        } else {
            eprintln!(
                "[Structs Hasher] Starting task {} on CPU ({} threads)",
                pid,
                num_cpus::get().saturating_sub(1).max(1)
            );
            super::cpu::run_cpu_hash(handle.clone(), app.clone());
        }
    }));
    if outcome.is_err() {
        eprintln!("[Structs Hasher] task {} worker panicked; pool worker continuing", pid);
    }
    super::reap_self(registry, &pid, &handle);
}

/// Write off one worker presumed wedged in an unbounded block and spawn a
/// replacement. Called by the watchdog when it reaps a stalled RUNNING task —
/// the GPU readback timeout makes real wedges rare, but any block site we
/// haven't bounded would otherwise silently drain the pool. If the written-off
/// thread later recovers it simply becomes one extra poller: `scheduler::admit`
/// still caps concurrent grinds, so the cap is never exceeded.
pub fn note_wedged() {
    let _ = WORKERS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |c| c.checked_sub(1));
    ensure_workers();
}

/// Pending-queue depth (tasks enqueued but not yet picked). Telemetry only.
pub fn pending_len() -> usize {
    PENDING.lock().unwrap().len()
}

/// Live pool worker count. Telemetry only.
pub fn worker_count() -> u64 {
    WORKERS.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hasher::types::{TaskParams, TaskRegistry};

    // PENDING is process-global; serialize tests that touch it.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Enqueue a task whose current block age is exactly `age` — with
    /// difficulty_target 10_000, age 10_000 → difficulty 1 (ripe), age 4_000
    /// → difficulty 8 (ripe, harder — exactly DIFFICULTY_START), age 10 →
    /// difficulty 49 (unripe).
    fn task(registry: &Arc<TaskRegistry>, id: &str, age: u64) -> Arc<TaskHandle> {
        let block_start = 100;
        let mut params = TaskParams::for_ore(id, "MINE", block_start, 10_000);
        params.block_checkpoint = block_start + age;
        params.block_checkpoint_time = now_millis();
        let handle = Arc::new(TaskHandle::new(params));
        registry.tasks.insert(id.to_string(), handle.clone());
        PENDING.lock().unwrap().push(handle.clone());
        handle
    }

    fn drain_pending() {
        PENDING.lock().unwrap().clear();
    }

    #[test]
    fn pop_prefers_easiest_ripe_and_skips_unripe() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let registry = Arc::new(TaskRegistry::new());
        drain_pending();
        task(&registry, "t-easy", 10_000); // difficulty 1
        task(&registry, "t-hard", 4_000); // difficulty 8 == DIFFICULTY_START, still ripe
        task(&registry, "t-unripe", 10); // difficulty 49 > DIFFICULTY_START

        let (first, _) = pop_ripest(&registry).expect("easiest ripe task pops first");
        assert_eq!(first.params.object_id, "t-easy");
        let (second, _) = pop_ripest(&registry).expect("next ripe task pops second");
        assert_eq!(second.params.object_id, "t-hard");
        // Only the unripe task remains; it must NOT pop.
        assert!(pop_ripest(&registry).is_none());
        assert_eq!(pending_len(), 1);
        drain_pending();
    }

    /// The ripeness scan must judge age from the SAME refreshed checkpoint
    /// the worker uses, so a task the pool pops is one the worker will grind
    /// immediately rather than sleep on. Here a pending task's checkpoint is
    /// stale (stamped long ago); the scan writes the refreshed checkpoint
    /// back, exactly as the worker's own wait loop does.
    #[test]
    fn pop_refreshes_the_checkpoint_it_judges_ripeness_from() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let registry = Arc::new(TaskRegistry::new());
        drain_pending();
        let h = task(&registry, "5-77", 100_000);
        let before = h.progress.lock().unwrap().block_checkpoint;
        let _ = pop_ripest(&registry);
        let p = h.progress.lock().unwrap();
        // refresh_checkpoint keeps the checkpoint unless the live height is
        // ahead of it; with no live height in tests the pair is unchanged,
        // and the pop path stores whatever refresh returned.
        let (cp, _) = refresh_checkpoint(before, p.block_checkpoint_time_ms, now_millis());
        assert_eq!(p.block_checkpoint, cp);
        drop(p);
        drain_pending();
    }

    #[test]
    fn pop_prunes_cancelled_and_superseded() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let registry = Arc::new(TaskRegistry::new());
        drain_pending();
        let cancelled = task(&registry, "t-cancel", 10_000);
        cancelled.cancel.store(true, Ordering::SeqCst);
        // Superseded: registry now holds a DIFFERENT handle for the same pid.
        let stale = task(&registry, "t-super", 10_000);
        let fresh = Arc::new(TaskHandle::new(TaskParams::for_ore("t-super", "MINE", 100, 10_000)));
        registry.tasks.insert("t-super".to_string(), fresh);
        assert!(!Arc::ptr_eq(registry.tasks.get("t-super").unwrap().value(), &stale));

        assert!(pop_ripest(&registry).is_none());
        assert_eq!(pending_len(), 0, "cancelled + superseded entries pruned");
    }
}
#[cfg(test)]
mod work_start_tests {
    use super::*;
    use crate::hasher::types::{TaskParams, TaskProgress};

    /// A task's duration must measure the SOLVE, not the queue wait. Stamping
    /// only at construction is what let a deep queue convince the tuner to
    /// remove workers, deepening the queue further until it pinned at
    /// MIN_CONCURRENT with a configured cap four times higher.
    #[test]
    fn work_start_is_unset_until_a_worker_picks_the_task_up() {
        let p = TaskProgress::from_params(&TaskParams::for_ore("5-1", "REFINE", 0, 1));
        assert!(
            p.work_start_time_ms.is_none(),
            "a queued task has not started work yet"
        );
        assert!(p.process_start_time_ms > 0.0, "creation time is still stamped");
    }

    #[test]
    fn a_free_worker_takes_ripe_work_first_then_the_easiest_affordable() {
        // Ripe at start 5 wins, earliest on ties.
        assert_eq!(choose(&[7, 5, 3, 3], 5, Some(7), true), Some((2, false)));
        // Nothing ripe: the easiest task the GPU can afford, taken early.
        assert_eq!(choose(&[8, 7, 9], 5, Some(7), true), Some((1, true)));
        // Too hard for the budget, no measured rate, or no spare worker: wait.
        assert_eq!(choose(&[8, 9], 5, Some(7), true), None);
        assert_eq!(choose(&[7], 5, None, true), None);
        assert_eq!(choose(&[7], 5, Some(7), false), None);
        // A ceiling at or under start adds nothing.
        assert_eq!(choose(&[6], 5, Some(5), true), None);
        assert_eq!(choose(&[], 5, Some(7), true), None);
    }

    #[test]
    fn affordable_difficulty_follows_the_measured_rate() {
        use crate::hasher::tuner::affordable_difficulty;
        // 20 MH/s: 16^7 = 268M tries ≈ 13 s fits 30 s; 16^8 ≈ 215 s does not.
        assert_eq!(affordable_difficulty(2.0e7, 30.0), 7);
        assert_eq!(affordable_difficulty(2.0e8, 30.0), 8, "16^8 / 2e8 = 21 s fits; 16^9 does not");
        assert_eq!(affordable_difficulty(2.0e8, 20.0), 7);
        assert_eq!(affordable_difficulty(1.0, 30.0), 1);
        assert_eq!(affordable_difficulty(0.0, 30.0), 0);
    }
}
