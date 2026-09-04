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

use crate::hasher::difficulty::{calculate_difficulty, estimate_age};
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
            Some(handle) => {
                // Stamp the moment REAL work begins. Everything before this is
                // queue wait, and folding that into "solve duration" is what
                // drove the tuner into its concurrency collapse — see
                // TaskProgress::work_start_time_ms.
                if let Ok(mut p) = handle.progress.lock() {
                    p.work_start_time_ms = Some(now_millis());
                }
                run_one(&app, &registry, handle)
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

/// Pop the easiest ripe task, pruning entries cancelled or superseded while
/// queued. Also refreshes each pending task's `block_current_estimated` so
/// list/board ETAs stay live without a thread per task. Returns `None` when
/// nothing is ripe yet.
fn pop_ripest(registry: &Arc<TaskRegistry>) -> Option<Arc<TaskHandle>> {
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

    let mut best: Option<(u64, usize)> = None;
    for (i, h) in pending.iter().enumerate() {
        let (age, block_est) = {
            let progress = h.progress.lock().unwrap();
            estimate_age(
                h.params.block_start,
                progress.block_checkpoint,
                progress.block_checkpoint_time_ms,
                now_ms,
            )
        };
        let difficulty = calculate_difficulty(age, h.params.difficulty_target);
        {
            let mut progress = h.progress.lock().unwrap();
            progress.block_current_estimated = block_est;
        }
        // Strict `<` keeps the earliest-enqueued task on difficulty ties.
        if difficulty <= difficulty_start && best.is_none_or(|(d, _)| difficulty < d) {
            best = Some((difficulty, i));
        }
    }
    best.map(|(_, i)| pending.swap_remove(i))
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

        let first = pop_ripest(&registry).expect("easiest ripe task pops first");
        assert_eq!(first.params.object_id, "t-easy");
        let second = pop_ripest(&registry).expect("next ripe task pops second");
        assert_eq!(second.params.object_id, "t-hard");
        // Only the unripe task remains; it must NOT pop.
        assert!(pop_ripest(&registry).is_none());
        assert_eq!(pending_len(), 1);
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
}
