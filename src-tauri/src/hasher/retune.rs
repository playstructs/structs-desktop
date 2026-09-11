//! A raid proof follows the target planet's LIVE shield.
//!
//! `difficulty_target` is not a difficulty — it is the **decay range** the
//! requirement falls over:
//!
//! ```text
//! required = 64 − floor( log10(age) / log10(difficulty_target) × 63 )
//! ```
//!
//! For a RAID that range is the target planet's `planetaryShield`, and the
//! chain recomputes the requirement from its OWN current state when the
//! completion arrives. The shield moves for the whole raid: every
//! shield-contributing struct built, brought online, or destroyed changes it
//! (Ore Bunker 50, Orbital Shield Generator 25, Defense Cannon 13, Jamming
//! Satellite 12). Verified live 2026-08-07 — destroying one Orbital Shield
//! Generator mid-raid moved the chain's RAID `work` record 238 → 213, exactly
//! that struct's contribution.
//!
//! `TaskHandle.params` is immutable and both engines copy `difficulty_target`
//! into a local at entry, so a task that starts grinding is frozen against a
//! value that is still moving:
//!
//! * **Shield rises** — our range is too small, every difficulty we compute is
//!   below the chain's, and the solve is a guaranteed `work failure for input
//!   (…)`: a wasted transaction and usually a wasted raid window.
//! * **Shield falls** — our range is too large and we grind a stricter
//!   requirement than the chain's. This one was self-inflicted:
//!   [`crate::mcp::auto_raid`]'s `shield_grind_round` spends shots killing the
//!   defender's shield structs *to shorten our own proof*, and until this
//!   module existed those shots bought nothing at all.
//!
//! The fix is to cancel and re-enter the task under the same pid with the new
//! range — the shape [`crate::mcp::watchdog`] already uses for stalled tasks.
//! The hash PREIMAGE does not change when the shield moves
//! (`{fleet}@{planet}RAID{blockStartRaid}NONCE`); only the acceptance
//! threshold does. So the searched nonce space is carried forward and a
//! retune costs one pool re-queue and nothing else.
//!
//! It lives in the hasher rather than in `auto_raid` because every raid origin
//! funnels into `TaskRegistry` — the autonomous loop, `structs_action`,
//! `structs_hash start`, the vplayer `act` path, crew/borrowed work, and the
//! game's own TaskManager through the Worker shim — and all of them should
//! track the shield.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use dashmap::DashMap;
use tauri::{AppHandle, Manager};

use super::difficulty::{calculate_difficulty, estimate_age};
use super::types::{now_millis, TaskParams, TaskRegistry, TaskStateSnapshot};

/// A firefight emits `shield_change` in bursts (a volley of kills settles over
/// seconds). Retune once per burst and let [`sweep`] pick up the settled value.
pub const RETUNE_DEBOUNCE_MS: f64 = 10_000.0;

/// Per-task ceiling. Roughly a full raid window at the debounce floor; past it
/// something is oscillating and restarting again only churns.
pub const MAX_RETUNES: u32 = 20;

/// [`sweep`] self-throttle. A raid window is minutes long, so the watchdog's
/// once-a-minute cadence is too slow to host this.
const SWEEP_EVERY_MS: f64 = 15_000.0;

/// `object_id -> (retunes so far, last retune ms)`.
static RETUNES: LazyLock<DashMap<String, (u32, f64)>> = LazyLock::new(DashMap::new);

static LAST_SWEEP_MS: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

/// Retunes applied since launch, for `structs_system pow`.
static RETUNE_COUNT: AtomicU64 = AtomicU64::new(0);
/// Live RAID tasks at the last sweep, for `structs_system pow`.
static LIVE_RAID_TASKS: AtomicU64 = AtomicU64::new(0);

/// Which way the shield moved, and therefore why we are restarting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    /// The defender built or onlined a contributor. Our in-flight proof is
    /// already void — the chain wants more zeros than we are looking for.
    Rose,
    /// A contributor died. The requirement dropped by at least a whole hex
    /// digit, so restarting saves ≥ 16× the remaining work.
    Fell,
}

/// Is a task holding `held_target` worth restarting against `live_target`?
///
/// The threshold is expressed in **required difficulty at the task's current
/// age**, not in shield points — a shield can move by ten and not change what
/// the chain asks for.
///
/// A rise is honoured unconditionally. Even where the two curves agree at
/// today's age they diverge as age grows, and the arithmetic is floored, so
/// waiting for the difference to show up means racing a solve that lands
/// between sweeps. A rise is cheap to honour because the nonce is carried.
///
/// A fall is honoured only when it actually buys a hex digit; below that a
/// restart buys nothing and only churns.
pub fn decide(age: u64, held_target: u64, live_target: u64) -> Option<Move> {
    // Never retune toward a value we did not actually read. `log10(1) = 0`
    // would divide by zero, so 0 and 1 are both "unknown".
    if live_target < 2 || held_target < 2 || live_target == held_target {
        return None;
    }
    if live_target > held_target {
        return Some(Move::Rose);
    }
    (calculate_difficulty(age, live_target) < calculate_difficulty(age, held_target))
        .then_some(Move::Fell)
}

/// The live decay range for a raid on `planet_id`: its current
/// `planetaryShield`, straight from the perception snapshot (GRASS keeps it
/// current, so this is free and needs no chain read). `None` when the snapshot
/// does not know the planet or holds no shield for it.
pub fn live_raid_target(planet_id: &str) -> Option<u64> {
    crate::mcp::perception::with_snapshot(|s| s.planet_attr(planet_id, "planetaryShield"))
        .flatten()
        .filter(|v| *v >= 2)
}

/// Rebuild a raid task's params against a new decay range.
///
/// Pure, so the field-carrying can be tested without an `AppHandle`. Every
/// field that represents WORK ALREADY DONE is carried forward:
///
/// * `nonce_current` / `iterations` — the preimage is unchanged, so the
///   searched space is still searched.
/// * `block_checkpoint` / `block_checkpoint_time` — `TaskProgress::from_params`
///   would otherwise stamp a fresh checkpoint against an unchanged
///   `block_start`, and both `pool::pop_ripest` and the engines derive
///   ripeness from exactly those two fields. Resetting them would throw away
///   the age the task genuinely accumulated.
/// * `estimated_hashrate` — no reason to re-measure from the initial guess.
pub fn retuned_params(
    old: &TaskParams,
    snap: &TaskStateSnapshot,
    live_target: u64,
) -> TaskParams {
    let mut p = old.clone();
    let rose = live_target > old.difficulty_target;
    p.difficulty_target = live_target.max(2);
    p.nonce_current = snap.nonce_current;
    p.iterations = snap.iterations;
    p.iterations_since_last_start = 0;
    p.block_checkpoint = snap.block_checkpoint;
    p.block_checkpoint_time = snap.block_checkpoint_time;
    p.block_current_estimated = Some(snap.block_current_estimated);
    p.estimated_hashrate = snap.estimated_hashrate;
    if rose {
        // A proof found for a weaker curve has no business surviving into the
        // stricter one. `cpu::run_cpu_hash` finishes a task from a stashed
        // result once the requirement decays past it; that path is gated on
        // `result_difficulty >= difficulty` so a raised requirement fails it
        // anyway, but leaving a void proof in the params only invites a later
        // reader to trust it.
        p.result_exists = false;
        p.result_nonce = None;
        p.result_hash = None;
        p.result_message = None;
        p.result_difficulty = 0;
    } else {
        // A fall keeps it. A stashed proof that was too weak for the old curve
        // may already clear the new one — that is precisely the reuse path,
        // and throwing it away would re-grind work we have already done. The
        // live values are on the PROGRESS, not the params the task started
        // with, so they have to be carried across explicitly.
        p.result_exists = snap.result_exists;
        p.result_nonce = snap.result_nonce.clone();
        p.result_hash = snap.result_hash.clone();
        p.result_message = snap.result_message.clone();
        p.result_difficulty = snap.result_difficulty;
    }
    p.status = "starting".to_string();
    p
}

/// Is this task past the point where retuning it means anything?
///
/// Deliberately does NOT consult `result_exists`. A RUNNING task can carry a
/// stashed proof that failed to clear its difficulty — the game's own
/// TaskManager re-spawns exactly that shape after
/// `TaskState.checkResultHashDifficulty()` rejects a result — and those are the
/// tasks that most need a new range, not the ones to skip.
pub fn is_settled(status: &str, completion_in_flight: bool) -> bool {
    status == "completed" || completion_in_flight
}

/// Whether a task's retune history allows another one right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Go,
    /// Inside the debounce window — a burst of frames, one restart.
    Debounced,
    /// Past [`MAX_RETUNES`]: something is oscillating and restarting again
    /// only churns.
    Capped,
}

/// Rate-limit one task's retunes.
///
/// Pure so a simulated firefight can be run against it without a task registry
/// or a clock. `last_ms == 0.0` means "never retuned", which must not be read
/// as "retuned at the epoch and therefore long overdue" — it is the same thing,
/// but stating it keeps a future refactor from inverting it.
pub fn gate(count: u32, last_ms: f64, now_ms: f64) -> Gate {
    if last_ms > 0.0 && now_ms - last_ms < RETUNE_DEBOUNCE_MS {
        return Gate::Debounced;
    }
    if count >= MAX_RETUNES {
        return Gate::Capped;
    }
    Gate::Go
}

/// Drop a task's retune bookkeeping. Called from `reap_self` when the task
/// genuinely leaves the registry.
pub(crate) fn forget(pid: &str) {
    RETUNES.remove(pid);
}

/// Gauges for `structs_system pow`.
pub fn stats() -> serde_json::Value {
    serde_json::json!({
        "live_raid_tasks": LIVE_RAID_TASKS.load(Ordering::Relaxed),
        "retunes": RETUNE_COUNT.load(Ordering::Relaxed),
    })
}

/// How many times this task has been retuned, for `structs_hash list`.
pub fn retunes_for(pid: &str) -> u32 {
    RETUNES.get(pid).map(|v| v.0).unwrap_or(0)
}

/// One planet's shield moved: retune any live RAID proof aimed at it.
///
/// Called from the GRASS ingest path on a `shield_change` frame. Every shield
/// move in the galaxy arrives here — a few frames a minute — and almost none of
/// them concern a planet we are raiding, so the cheap registry question is
/// asked FIRST and the perception read lock is only taken when the answer is
/// yes.
pub fn note_shield_change(app: &AppHandle, planet_id: &str) {
    if planet_id.is_empty() {
        return;
    }
    let Some(registry) = app.try_state::<Arc<TaskRegistry>>() else { return };
    let registry = registry.inner().clone();
    if registry.tasks.is_empty() {
        return;
    }
    // Collect first: never hold a DashMap iterator across the remove/insert
    // that `start_hash_task_core` performs.
    //
    // Every raid pointed at this planet, not just one — two of our fleets can
    // sit on the same target, and they face the same shield.
    let pids: Vec<String> = registry
        .tasks
        .iter()
        .filter(|e| {
            e.params.task_type.as_deref() == Some("RAID")
                && e.params.target_id.as_deref() == Some(planet_id)
        })
        .map(|e| e.params.object_id.clone())
        .collect();
    if pids.is_empty() {
        return;
    }
    // Read the settled value from the snapshot rather than the frame: this
    // hook runs after `perception::on_grass` has folded the frame in, and a
    // burst of kills leaves the snapshot holding the total rather than the
    // first step of it.
    let Some(live) = live_raid_target(planet_id) else { return };
    for pid in pids {
        retune_one(app, &registry, &pid, planet_id, live);
    }
}

/// Re-check every live RAID task against the snapshot.
///
/// The backstop for the two cases no frame announces: a dropped `shield_change`
/// (the ingest path can shed frames while a bulk refresh is draining) and a
/// whole new snapshot installed by a refresh. Self-throttled, so it is safe to
/// call from the timer loop on every tick.
pub fn sweep(app: &AppHandle) {
    let now = now_millis();
    {
        let Ok(mut last) = LAST_SWEEP_MS.lock() else { return };
        if now - *last < SWEEP_EVERY_MS {
            return;
        }
        *last = now;
    }
    let Some(registry) = app.try_state::<Arc<TaskRegistry>>() else { return };
    let registry = registry.inner().clone();

    // Collect first: never hold a DashMap iterator across the remove/insert
    // that `start_hash_task_core` performs.
    let raids: Vec<(String, String, u64)> = registry
        .tasks
        .iter()
        .filter(|e| e.params.task_type.as_deref() == Some("RAID"))
        .filter_map(|e| {
            let planet = e.params.target_id.clone()?;
            Some((e.params.object_id.clone(), planet, e.params.difficulty_target))
        })
        .collect();
    LIVE_RAID_TASKS.store(raids.len() as u64, Ordering::Relaxed);

    for (pid, planet, held) in raids {
        let Some(live) = live_raid_target(&planet) else { continue };
        if live != held {
            retune_one(app, &registry, &pid, &planet, live);
        }
    }

    // Prune bookkeeping for tasks that have left the registry, the way the
    // watchdog prunes HASH_PROGRESS / HASH_RESTARTS.
    RETUNES.retain(|pid, _| registry.tasks.contains_key(pid));
}

/// Cancel and re-enter one raid task against `live_target`.
fn retune_one(
    app: &AppHandle,
    registry: &Arc<TaskRegistry>,
    pid: &str,
    planet_id: &str,
    live_target: u64,
) {
    // ── Every precondition is checked BEFORE anything is removed. ──
    // `start_hash_task_core` refuses while hashing is disabled, and a refusal
    // after the remove would have destroyed a raid proof we cannot re-create.
    if !super::hash_enabled() {
        return;
    }
    let Some(handle) = registry.tasks.get(pid).map(|e| e.value().clone()) else { return };
    let held = handle.params.difficulty_target;
    let snap = handle.snapshot();
    // Finished, or already queued for broadcast: leave it to the completion
    // path. Note this is NOT `snap.result_exists` — a RUNNING task can carry a
    // stashed proof that did not clear its difficulty (the webapp's TaskManager
    // re-spawns exactly that shape), and those are the tasks that most need
    // retuning.
    if is_settled(&snap.status, super::completion_in_flight(pid).is_some()) {
        return;
    }
    let age = {
        let p = handle.progress.lock().unwrap();
        estimate_age(
            handle.params.block_start,
            p.block_checkpoint,
            p.block_checkpoint_time_ms,
            now_millis(),
        )
        .0
    };
    let Some(direction) = decide(age, held, live_target) else { return };

    let now = now_millis();
    let (count, last) = RETUNES.get(pid).map(|v| *v).unwrap_or((0, 0.0));
    match gate(count, last, now) {
        Gate::Go => {}
        Gate::Debounced => return,
        Gate::Capped => {
            // The debounce already rate-limits how often we reach this, so it
            // does not spam; re-stamping `last` keeps it that way.
            crate::mcp::telemetry::tlog(
                "hasher",
                crate::mcp::telemetry::Sev::Warn,
                format!(
                    "RAID {pid} has retuned {MAX_RETUNES} times — holding decay range {held} \
                     against {planet_id}'s {live_target}; the shield is oscillating faster than \
                     a proof can be ground"
                ),
            );
            RETUNES.insert(pid.to_string(), (count, now));
            return;
        }
    }

    // ── Restart. Same pid, so the webapp TaskManager (which only learns about
    // a Rust task through hash_progress / hash_complete for that pid) keeps
    // its contract; see the watchdog's stall remedy for the same shape. ──
    let Some((_, old)) = registry.tasks.remove(pid) else { return };
    old.cancel.store(true, Ordering::SeqCst);
    let vplayer = super::vplayer_hash(pid);
    let params = retuned_params(&old.params, &snap, live_target);
    let required_was = calculate_difficulty(age, held);
    let required_now = calculate_difficulty(age, params.difficulty_target);

    match super::start_hash_task_core(params, app.clone(), registry) {
        Ok(()) => {
            // Re-register the completion signer. `reap_self` is ptr-eq guarded
            // so the old worker's unwind leaves the new mapping alone, but the
            // retune should not depend on that ordering.
            if let Some((index, kind)) = vplayer {
                super::register_vplayer_hash(pid.to_string(), index, kind);
            }
            // Judge the restarted task on its own evidence: it inherits
            // `iterations` unchanged, so a stale progress entry would look
            // frozen and the watchdog could reap it on its predecessor's
            // record.
            crate::mcp::watchdog::note_hash_restarted(pid);
            RETUNES.insert(pid.to_string(), (count + 1, now));
            RETUNE_COUNT.fetch_add(1, Ordering::Relaxed);
            crate::mcp::telemetry::tlog(
                "hasher",
                crate::mcp::telemetry::Sev::Notice,
                format!(
                    "RAID {pid} retuned: decay range {held} → {live_target} ({planet_id} shield \
                     {}), required difficulty {required_was} → {required_now} at age {age} — \
                     resuming at nonce {}",
                    if direction == Move::Rose { "rose" } else { "fell" },
                    snap.nonce_current
                ),
            );
            if direction == Move::Fell {
                crate::mcp::board_feed::push(
                    app,
                    crate::mcp::board_feed::Severity::Important,
                    "auto_raid",
                    format!(
                        "shield grind paid: {planet_id} raid proof now needs difficulty \
                         {required_now} (was {required_was})"
                    ),
                );
            }
            if required_now > super::difficulty_start() {
                crate::mcp::telemetry::tlog(
                    "hasher",
                    crate::mcp::telemetry::Sev::Warn,
                    format!(
                        "RAID {pid} retuned UP to difficulty {required_now}, above difficulty_start \
                         {} — the proof is re-queued until it decays back",
                        super::difficulty_start()
                    ),
                );
            }
        }
        Err(e) => {
            // A raid proof we cancelled and could not re-create. The raid
            // window is still open on chain and nothing else re-issues a RAID
            // proof except the next auto_raid pass, so this must be loud.
            crate::mcp::telemetry::tlog(
                "hasher",
                crate::mcp::telemetry::Sev::Error,
                format!("RAID {pid} retune could not restart the proof: {e}"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hasher::types::{TaskHandle, TaskParams};

    fn raid_params(target: u64) -> TaskParams {
        TaskParams::for_raid("9-61", "2-855", 2_000_000, target)
    }

    /// The direction that costs a transaction. Our held range being too SMALL
    /// means every difficulty we compute is below the chain's, so the solve is
    /// a guaranteed `work failure` — honour it at every age, including the ones
    /// where the two curves happen to agree today.
    #[test]
    fn a_rising_shield_always_wins_a_retune() {
        for age in [2, 10, 50, 125, 238, 1_000, 10_000] {
            assert_eq!(
                decide(age, 213, 238),
                Some(Move::Rose),
                "age {age}: a bigger shield must always retune"
            );
        }
    }

    /// A fall is a bonus, not a correction — the held proof stays valid, it is
    /// just stronger than needed. Only pay for a restart when it buys a whole
    /// hex digit (16× less work).
    #[test]
    fn a_falling_shield_retunes_only_when_it_buys_a_digit() {
        let mut saved = 0;
        let mut skipped = 0;
        for age in 2..2_000u64 {
            match decide(age, 238, 213) {
                Some(Move::Fell) => {
                    assert!(
                        calculate_difficulty(age, 213) < calculate_difficulty(age, 238),
                        "age {age}: retuned down without lowering the requirement"
                    );
                    saved += 1;
                }
                None => {
                    assert_eq!(
                        calculate_difficulty(age, 213),
                        calculate_difficulty(age, 238),
                        "age {age}: declined a retune that would have lowered the requirement"
                    );
                    skipped += 1;
                }
                Some(Move::Rose) => panic!("age {age}: a smaller shield is not a rise"),
            }
        }
        assert!(saved > 0 && skipped > 0, "the asymmetry should show both outcomes");
    }

    /// `log10(1) = 0` divides by zero, and a snapshot miss reads as 0. Neither
    /// is a shield observation, so neither may move a live proof.
    #[test]
    fn an_unknown_shield_never_retunes() {
        for live in [0, 1] {
            assert_eq!(decide(100, 238, live), None, "live {live} is not an observation");
        }
        for held in [0, 1] {
            assert_eq!(decide(100, held, 238), None, "held {held} is not an observation");
        }
        assert_eq!(decide(100, 238, 238), None, "an unchanged shield is a no-op");
    }

    /// A retune replaces the acceptance threshold, not the search. The preimage
    /// is unchanged, so everything already computed must survive.
    #[test]
    fn a_retune_carries_the_nonce_the_checkpoint_and_the_hashrate() {
        let old = raid_params(238);
        let handle = TaskHandle::new(old.clone());
        {
            let mut p = handle.progress.lock().unwrap();
            p.nonce_current = 999_888_777;
            p.iterations = 4_200_000;
            p.block_checkpoint = 2_000_400;
            p.block_checkpoint_time_ms = 1_700_000_000_000.0;
            p.block_current_estimated = 2_000_450;
            p.estimated_hashrate = 170_000.0;
        }
        let snap = handle.snapshot();
        let next = retuned_params(&old, &snap, 213);

        assert_eq!(next.difficulty_target, 213, "the range is the point of the exercise");
        assert_eq!(next.object_id, old.object_id);
        assert_eq!(next.prefix, old.prefix, "the preimage must not change");
        assert_eq!(next.block_start, old.block_start);
        assert_eq!(next.target_id, old.target_id);
        assert_eq!(next.nonce_current, 999_888_777, "the searched space is still searched");
        assert_eq!(next.iterations, 4_200_000);
        assert_eq!(next.block_checkpoint, 2_000_400, "resetting this throws away real age");
        assert_eq!(next.block_checkpoint_time, 1_700_000_000_000.0);
        assert_eq!(next.estimated_hashrate, 170_000.0);
        assert_eq!(next.iterations_since_last_start, 0);
        assert_eq!(next.status, "starting");
    }

    /// A proof found against a weaker curve has no business surviving into a
    /// stricter one — `cpu::run_cpu_hash` can complete a task from a stashed
    /// result.
    #[test]
    fn a_retune_upward_drops_a_stashed_result() {
        let old = raid_params(213);
        let handle = TaskHandle::new(old.clone());
        {
            let mut p = handle.progress.lock().unwrap();
            p.result_exists = true;
            p.result_difficulty = 9;
            p.result_nonce = Some("123".into());
            p.result_hash = Some("000000000abc".into());
        }
        let snap = handle.snapshot();

        let up = retuned_params(&old, &snap, 238);
        assert!(!up.result_exists, "a raised requirement must void the stashed proof");
        assert_eq!(up.result_difficulty, 0);
        assert!(up.result_nonce.is_none() && up.result_hash.is_none());

        // A fall keeps it: the proof is still at least as strong as required.
        let down = retuned_params(&old, &snap, 125);
        assert!(down.result_exists);
        assert_eq!(down.result_difficulty, 9);
    }

    /// A shield grind is a volley: several contributors die inside a few
    /// seconds and each one emits its own frame. Restart once per burst, not
    /// once per kill — and stop entirely if the shield oscillates faster than
    /// a proof can ever be ground.
    #[test]
    fn the_debounce_and_the_cap_bound_a_firefight() {
        let mut count = 0u32;
        let mut last = 0.0f64;
        let mut restarts = 0u32;
        let mut now = 1_000_000.0;

        // 100 frames, one every 500 ms — a sustained forty-second exchange.
        for _ in 0..100 {
            if gate(count, last, now) == Gate::Go {
                count += 1;
                last = now;
                restarts += 1;
            }
            now += 500.0;
        }
        assert_eq!(
            restarts, 5,
            "50 s of frames at a {RETUNE_DEBOUNCE_MS} ms debounce is 5 restarts, not 100"
        );

        // Keep going long enough and the cap takes over.
        for _ in 0..1000 {
            if gate(count, last, now) == Gate::Go {
                count += 1;
                last = now;
                restarts += 1;
            }
            now += 500.0;
        }
        assert_eq!(restarts, MAX_RETUNES, "the cap is the ceiling, whatever the stream does");
        assert_eq!(gate(count, last, now + 1_000_000.0), Gate::Capped, "and it does not expire");
    }

    /// Retuning a proof that is already on its way to the chain would cancel a
    /// task whose transaction is in flight — but a proof merely *stashed* on a
    /// still-running task is the opposite case, and skipping those is how this
    /// check was wrong in its first draft.
    #[test]
    fn only_a_finished_or_in_flight_proof_is_left_alone() {
        assert!(is_settled("completed", false));
        assert!(is_settled("running", true), "a completion at the gate must not be cancelled");
        assert!(!is_settled("running", false));
        assert!(!is_settled("starting", false));
        assert!(!is_settled("waiting", false), "a task waiting out decay is exactly what a retune helps");
    }

    /// A first-ever retune must not be read as "last retuned at the epoch".
    #[test]
    fn a_task_that_has_never_retuned_is_not_debounced() {
        assert_eq!(gate(0, 0.0, 1_000_000.0), Gate::Go);
        assert_eq!(gate(0, 1_000_000.0, 1_000_000.0), Gate::Debounced);
        assert_eq!(gate(0, 1_000_000.0, 1_000_000.0 + RETUNE_DEBOUNCE_MS), Gate::Go);
    }
}
