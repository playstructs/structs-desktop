use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Emitter;

use crate::hasher::difficulty::{
    calculate_difficulty, check_difficulty, estimate_age, refresh_checkpoint, CHECKPOINT_COMMIT,
    DIFFICULTY_RECALCULATE, DIFFICULTY_START_SLEEP_MS,
};
use crate::hasher::types::{now_millis, TaskHandle};

/// Run the CPU hasher on a rayon thread pool.
/// Emits Tauri events for progress and completion.
pub fn run_cpu_hash(handle: Arc<TaskHandle>, app_handle: tauri::AppHandle) {
    let num_threads = num_cpus::get().saturating_sub(1).max(1);
    let prefix = handle.params.prefix.clone();
    let postfix = handle.params.postfix.clone();
    let block_start = handle.params.block_start;
    let difficulty_target = handle.params.difficulty_target;
    let pid = handle.params.object_id.clone();

    // Read initial state from params
    let initial_nonce = handle.params.nonce_current;
    let initial_iterations = handle.params.iterations;

    // Update progress to WAITING
    {
        let mut progress = handle.progress.lock().unwrap();
        progress.status = "waiting".to_string();
        progress.last_status_change_time_ms = now_millis();
    }
    emit_progress(&app_handle, &handle, &pid);

    // Wait until difficulty drops to DIFFICULTY_START. `break`s with the current
    // difficulty once ripe — used as the admission priority below.
    let admit_difficulty = loop {
        if handle.is_cancelled() {
            return;
        }
        let now_ms = now_millis();
        let (age, block_est) = {
            let mut progress = handle.progress.lock().unwrap();
            let (cp, cpt) = refresh_checkpoint(
                progress.block_checkpoint,
                progress.block_checkpoint_time_ms,
                now_ms,
            );
            progress.block_checkpoint = cp;
            progress.block_checkpoint_time_ms = cpt;
            estimate_age(block_start, cp, cpt, now_ms)
        };
        let difficulty = calculate_difficulty(age, difficulty_target);

        {
            let mut progress = handle.progress.lock().unwrap();
            progress.block_current_estimated = block_est;
        }

        let difficulty_start = crate::hasher::difficulty_start();
        if difficulty <= difficulty_start {
            break difficulty;
        }

        {
            let progress = handle.progress.lock().unwrap();
            eprintln!(
                "[Structs Hasher] {} waiting: difficulty {} > {} (age={}, block_start={}, checkpoint={}, checkpoint_time={:.0}, now={:.0})",
                pid, difficulty, difficulty_start, age, block_start,
                progress.block_checkpoint, progress.block_checkpoint_time_ms, now_ms
            );
        }
        // Emit progress during wait so UI stays updated
        emit_progress(&app_handle, &handle, &pid);
        std::thread::sleep(std::time::Duration::from_millis(DIFFICULTY_START_SLEEP_MS));
    };

    // Priority admission: cap concurrent grinders at max_concurrent and admit the
    // easiest-difficulty task first (see hasher::scheduler). Held for the whole
    // grind; freed on drop. `None` = cancelled while queued for a slot.
    let _permit = match crate::hasher::scheduler::admit(admit_difficulty, &|| handle.is_cancelled()) {
        Some(p) => p,
        None => return,
    };

    // Transition to RUNNING
    {
        let mut progress = handle.progress.lock().unwrap();
        progress.status = "running".to_string();
        progress.last_status_change_time_ms = now_millis();
    }
    emit_progress(&app_handle, &handle, &pid);

    eprintln!(
        "[Structs Hasher] {} running with {} threads",
        pid, num_threads
    );

    // Shared atomics for cross-thread coordination
    let total_iterations = Arc::new(AtomicU64::new(0));
    let found = Arc::new(AtomicBool::new(false));
    let found_nonce = Arc::new(AtomicU64::new(0));

    // Start nonce: JS does ++nonce_current before first use
    let start_nonce = initial_nonce + 1;

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build()
        .expect("failed to build rayon pool");

    pool.scope(|s| {
        for thread_id in 0..num_threads {
            let handle = handle.clone();
            let app_handle = app_handle.clone();
            let prefix = prefix.clone();
            let postfix = postfix.clone();
            let total_iterations = total_iterations.clone();
            let found = found.clone();
            let found_nonce = found_nonce.clone();
            let pid = pid.clone();

            s.spawn(move |_| {
                let mut nonce = start_nonce + thread_id as u64;
                let stride = num_threads as u64;
                let mut _local_iterations: u64 = 0;
                let mut difficulty = {
                    let now_ms = now_millis();
                    let (age, _) = {
                        let progress = handle.progress.lock().unwrap();
                        estimate_age(
                            block_start,
                            progress.block_checkpoint,
                            progress.block_checkpoint_time_ms,
                            now_ms,
                        )
                    };
                    calculate_difficulty(age, difficulty_target)
                };

                loop {
                    if handle.is_cancelled() || found.load(Ordering::Relaxed) {
                        break;
                    }

                    // Build message: prefix + nonce_as_decimal + postfix
                    let message = format!("{}{}{}", prefix, nonce, postfix);
                    let hash_result = Sha256::digest(message.as_bytes());
                    let hash_bytes: [u8; 32] = hash_result.into();

                    _local_iterations += 1;
                    let global_iters =
                        total_iterations.fetch_add(1, Ordering::Relaxed) + 1;

                    if check_difficulty(&hash_bytes, difficulty) {
                        // Found a valid hash!
                        if !found.swap(true, Ordering::SeqCst) {
                            found_nonce.store(nonce, Ordering::SeqCst);
                            let hash_hex = hex::encode(hash_bytes);
                            let now_ms = now_millis();

                            {
                                let mut progress = handle.progress.lock().unwrap();
                                progress.status = "completed".to_string();
                                progress.nonce_current = nonce;
                                progress.iterations =
                                    initial_iterations + global_iters;
                                progress.iterations_since_last_start = global_iters;
                                progress.result_exists = true;
                                progress.result_message = Some(message);
                                progress.result_nonce =
                                    Some(format!("{}{}", nonce, postfix));
                                progress.result_hash = Some(hash_hex);
                                progress.result_difficulty = difficulty;
                                progress.process_end_time_ms = Some(now_ms);
                                progress.last_status_change_time_ms = now_ms;
                            }

                            eprintln!(
                                "[Structs Hasher] {} FOUND at nonce {} (difficulty {}, {} iterations)",
                                pid, nonce, difficulty, global_iters
                            );
                            emit_complete(&app_handle, &handle, &pid);
                        }
                        break;
                    }

                    // Progress checkpoint (only one thread reports)
                    if global_iters % CHECKPOINT_COMMIT == 0 && thread_id == 0 {
                        let now_ms = now_millis();
                        {
                            let mut progress = handle.progress.lock().unwrap();
                            progress.nonce_current = nonce;
                            progress.iterations =
                                initial_iterations + global_iters;
                            progress.iterations_since_last_start = global_iters;

                            let elapsed_ms =
                                now_ms - progress.last_status_change_time_ms;
                            if elapsed_ms > 0.0 {
                                progress.estimated_hashrate =
                                    global_iters as f64 / elapsed_ms;
                            }

                            let (_, block_est) = estimate_age(
                                block_start,
                                progress.block_checkpoint,
                                progress.block_checkpoint_time_ms,
                                now_ms,
                            );
                            progress.block_current_estimated = block_est;
                        }
                        emit_progress(&app_handle, &handle, &pid);
                    }

                    // Difficulty recalculation
                    if global_iters % DIFFICULTY_RECALCULATE == 0 && thread_id == 0 {
                        let now_ms = now_millis();
                        let (age, block_est) = {
                            let mut progress = handle.progress.lock().unwrap();
                            let (cp, cpt) = refresh_checkpoint(
                                progress.block_checkpoint,
                                progress.block_checkpoint_time_ms,
                                now_ms,
                            );
                            progress.block_checkpoint = cp;
                            progress.block_checkpoint_time_ms = cpt;
                            estimate_age(block_start, cp, cpt, now_ms)
                        };
                        difficulty = calculate_difficulty(age, difficulty_target);

                        {
                            let mut progress = handle.progress.lock().unwrap();
                            progress.block_current_estimated = block_est;
                        }

                        // Check if a previous result is now valid at lower difficulty
                        let reuse = {
                            let progress = handle.progress.lock().unwrap();
                            progress.result_exists
                                && progress.result_difficulty >= difficulty
                        };
                        if reuse && !found.swap(true, Ordering::SeqCst) {
                            {
                                let mut progress = handle.progress.lock().unwrap();
                                progress.status = "completed".to_string();
                                progress.result_difficulty = difficulty;
                                progress.process_end_time_ms = Some(now_ms);
                                progress.last_status_change_time_ms = now_ms;
                                progress.iterations =
                                    initial_iterations + global_iters;
                                progress.iterations_since_last_start = global_iters;
                            }
                            eprintln!(
                                "[Structs Hasher] {} reusing previous result at difficulty {}",
                                pid, difficulty
                            );
                            emit_complete(&app_handle, &handle, &pid);
                            break;
                        }
                    }

                    nonce += stride;
                }
            });
        }
    });
}

fn emit_progress(app_handle: &tauri::AppHandle, handle: &TaskHandle, _pid: &str) {
    let snapshot = handle.snapshot();
    let _ = app_handle.emit("hash_progress", &snapshot);
}

fn emit_complete(app_handle: &tauri::AppHandle, handle: &TaskHandle, _pid: &str) {
    let snapshot = handle.snapshot();
    let _ = app_handle.emit("hash_complete", &snapshot);
    // Solve history feeds the adaptive tuner (difficulty_start / max_concurrent).
    crate::mcp::telemetry::record_solve(&snapshot, "cpu");
    // If this hash belongs to a virtual player, sign its completion tx.
    crate::hasher::maybe_complete_virtual(app_handle, &snapshot);
}
