use rmcp::model::Content;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use crate::hasher;
use crate::hasher::difficulty::{calculate_difficulty, estimate_age, ESTIMATED_BLOCK_TIME_MS};
use crate::hasher::types::{now_millis, TaskParams, TaskRegistry};

#[derive(Debug, Deserialize)]
pub struct HashParams {
    /// Command: list, start, progress, stop, config
    pub command: String,
    /// Task ID (object_id, e.g., "5-1386"). Required for start/progress/stop.
    pub task_id: Option<String>,
    /// Task type: MINE, REFINE, BUILD, RAID. Required for start.
    pub task_type: Option<String>,
    /// Block height when the task was initiated on-chain. Required for start.
    pub block_start: Option<u64>,
    /// Difficulty target from the struct type. Required for start.
    pub difficulty_target: Option<u64>,
    /// Planet ID for RAID tasks (e.g., "2-156"). Only for RAID start.
    pub target_id: Option<String>,
    // ── config command ──
    /// Master on/off for the whole hashing system.
    pub enabled: Option<bool>,
    /// Engine preference: "auto" | "cpu" | "gpu".
    pub engine: Option<String>,
    /// DIFFICULTY_START — the difficulty a worker waits for before grinding.
    pub difficulty_start: Option<u64>,
    /// MAX_CONCURRENT_PROCESSES — the webapp TaskManager's concurrent-job cap.
    pub max_concurrent: Option<u64>,
}

pub async fn execute(
    registry: &Arc<TaskRegistry>,
    app_handle: &tauri::AppHandle,
    params: HashParams,
) -> Vec<Content> {
    match params.command.as_str() {
        "list" => {
            let mut tasks = vec![];
            for entry in registry.tasks.iter() {
                let snapshot = entry.value().snapshot();
                tasks.push(task_summary(&snapshot));
            }
            vec![Content::text(
                serde_json::to_string_pretty(&json!({
                    "active_tasks": tasks.len(),
                    "config": hash_config_json(),
                    "tasks": tasks,
                }))
                .unwrap(),
            )]
        }

        "start" => {
            let Some(task_id) = &params.task_id else {
                return vec![Content::text("Error: task_id (struct ID like '5-1386') required for start command")];
            };
            let Some(task_type) = &params.task_type else {
                return vec![Content::text("Error: task_type (MINE/REFINE/BUILD/RAID) required for start command")];
            };

            // Auto-fill from synced gameState if not provided
            let gs = crate::game_state::GAME_STATE.read().unwrap();
            let current_block = gs.current_block_height;
            let block_start = params.block_start.unwrap_or(current_block);
            let difficulty_target = params.difficulty_target.unwrap_or_else(|| {
                gs.get_difficulty_for_struct(task_id, task_type)
                    .unwrap_or(700) // fallback default
            });
            let struct_type_name = gs.get_struct_type_name(task_id);
            drop(gs);
            // Difficulty checkpoint = CURRENT block, distinct from block_start (the
            // proof anchor). If the anchor is old, age = current − anchor is large →
            // difficulty already low; seeding checkpoint=block_start would make the
            // worker wait hours for its fake age to grow. (Same fix as TaskParams::for_ore.)
            let block_checkpoint = if current_block > block_start { current_block } else { block_start };

            if block_start == 0 {
                return vec![Content::text("Error: block_start is 0 — gameState may not be synced yet. Wait a few seconds or provide block_start manually.")];
            }

            // Build the prefix matching TaskStateFactory conventions
            let prefix = if task_type == "RAID" {
                let target = params.target_id.as_deref().unwrap_or("unknown");
                format!("{}@{}{}{}NONCE", task_id, target, task_type, block_start)
            } else {
                format!("{}{}{}NONCE", task_id, task_type, block_start)
            };

            let nonce_start = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                % 10_000_000_000) as u64;

            let now_ms = crate::hasher::types::now_millis();

            let task_params = TaskParams {
                object_id: task_id.clone(),
                target_id: params.target_id.clone(),
                object_type: if task_type == "RAID" {
                    Some("fleet".to_string())
                } else {
                    Some("struct".to_string())
                },
                task_type: Some(task_type.clone()),
                identity: None,
                prefix,
                postfix: String::new(),
                nonce_start,
                nonce_current: nonce_start,
                iterations: 0,
                iterations_since_last_start: 0,
                difficulty_start: None,
                difficulty_target,
                block_start,
                block_checkpoint,
                block_checkpoint_time: now_ms,
                block_current_estimated: Some(block_checkpoint),
                result_exists: false,
                result_message: None,
                result_nonce: None,
                result_hash: None,
                result_difficulty: 0,
                estimated_hashrate: 300.0,
                estimated_block_start_offset: 0,
                status: "starting".to_string(),
            };

            match hasher::start_hash_task_core(task_params, app_handle.clone(), registry) {
                Ok(()) => {
                    let gpu = hasher::ensure_gpu_init();
                    let engine = if gpu { "GPU" } else { "CPU" };
                    vec![Content::text(
                        serde_json::to_string_pretty(&json!({
                            "status": "started",
                            "task_id": task_id,
                            "task_type": task_type,
                            "struct_type": struct_type_name,
                            "block_start": block_start,
                            "difficulty_target": difficulty_target,
                            "engine": engine,
                            "message": format!("{} {} task for {} started on {}",
                                task_type,
                                struct_type_name.as_deref().unwrap_or("Struct"),
                                task_id,
                                engine
                            ),
                        }))
                        .unwrap(),
                    )]
                }
                Err(e) => vec![Content::text(format!("Error starting task: {}", e))],
            }
        }

        "progress" => {
            let Some(task_id) = &params.task_id else {
                return vec![Content::text("Error: task_id required for progress command")];
            };
            match registry.tasks.get(task_id) {
                Some(entry) => {
                    let snapshot = entry.value().snapshot();
                    vec![Content::text(
                        serde_json::to_string_pretty(&task_summary(&snapshot)).unwrap(),
                    )]
                }
                None => vec![Content::text(format!(
                    "No active task with id '{}'",
                    task_id
                ))],
            }
        }

        "stop" => {
            let Some(task_id) = &params.task_id else {
                return vec![Content::text("Error: task_id required for stop command")];
            };
            if stop_task(registry, task_id) {
                vec![Content::text(format!("Task {} stopped", task_id))]
            } else {
                vec![Content::text(format!(
                    "No active task with id '{}'",
                    task_id
                ))]
            }
        }

        "config" => {
            use tauri::Emitter;
            let mut changes: Vec<String> = vec![];
            let mut errors: Vec<String> = vec![];

            // Master enable/disable. On disable: stop the Rust gate, cancel running
            // tasks, and pause the webapp TaskManager so it stops spawning. On
            // enable: lift the gate and resume the manager.
            if let Some(enabled) = params.enabled {
                hasher::set_hash_enabled(enabled);
                if !enabled {
                    let n = registry.tasks.len();
                    for entry in registry.tasks.iter() {
                        entry.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    // clear() AFTER the loop — the iter() RefMulti guards are dropped
                    // at the loop's end. Calling clear() (or remove) *inside* the loop
                    // would deadlock the shard (same footgun as the old `stop` bug).
                    registry.tasks.clear();
                    changes.push(format!("hashing → DISABLED (cancelled {} running task(s))", n));
                } else {
                    changes.push("hashing → enabled".into());
                }
                let _ = app_handle.emit("structs:hash-enabled", json!({ "enabled": enabled }));
            }

            // Engine: auto | cpu | gpu
            if let Some(engine) = params.engine.as_deref() {
                match engine.to_ascii_lowercase().as_str() {
                    "auto" => { hasher::set_engine_pref(0); changes.push("engine → auto".into()); }
                    "cpu" => { hasher::set_engine_pref(1); changes.push("engine → cpu".into()); }
                    "gpu" => { hasher::set_engine_pref(2); changes.push("engine → gpu (used only if a GPU is present)".into()); }
                    other => errors.push(format!("engine '{}' invalid (use auto|cpu|gpu)", other)),
                }
            }

            // DIFFICULTY_START — sane range 1..=64 (difficulty is a 0..64-ish scale).
            if let Some(ds) = params.difficulty_start {
                if (1..=64).contains(&ds) {
                    hasher::set_difficulty_start(ds);
                    changes.push(format!("difficulty_start → {}", ds));
                } else {
                    errors.push(format!("difficulty_start {} out of range (1..=64)", ds));
                }
            }

            // MAX_CONCURRENT_PROCESSES — the webapp TaskManager is the authoritative
            // spawner, so push the value to it via the glue; track it here for reporting.
            if let Some(mc) = params.max_concurrent {
                if (1..=64).contains(&mc) {
                    hasher::set_max_concurrent(mc);
                    let _ = app_handle.emit("structs:task-overrides", json!({ "maxConcurrent": mc }));
                    changes.push(format!("max_concurrent → {}", mc));
                } else {
                    errors.push(format!("max_concurrent {} out of range (1..=64)", mc));
                }
            }

            let mut out = serde_json::to_string_pretty(&hash_config_json()).unwrap();
            if !changes.is_empty() {
                out.push_str(&format!("\n\nApplied: {}", changes.join(", ")));
            }
            if !errors.is_empty() {
                out.push_str(&format!("\n\n⚠ Ignored: {}", errors.join("; ")));
            }
            vec![Content::text(out)]
        }

        other => vec![Content::text(format!(
            "Unknown hash command '{}'. Use: list, start, progress, stop, config",
            other
        ))],
    }
}

/// Stop a hash task: remove it from the registry and signal cancel to its worker.
///
/// IMPORTANT: uses `remove` (which returns the value) rather than `get`-then-
/// `remove`. The latter DEADLOCKS DashMap — the `get` Ref holds a read lock on the
/// task's shard while `remove` waits for that shard's write lock on the same
/// thread, hanging forever (this was the reported "stop hangs the agent" bug).
/// The worker thread holds its own `Arc<TaskHandle>` clone, so setting `cancel`
/// on the removed handle still signals it to exit. Returns true if a task was found.
fn stop_task(registry: &Arc<TaskRegistry>, task_id: &str) -> bool {
    match registry.tasks.remove(task_id) {
        Some((_, handle)) => {
            handle.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Current hashing configuration (engine pref, effective DIFFICULTY_START,
/// concurrency cap, GPU availability) — shared by `config` and `list`.
fn hash_config_json() -> serde_json::Value {
    let gpu_available = hasher::ensure_gpu_init();
    let pref = hasher::engine_pref_label();
    // What a NEW task would actually run on, given the preference + hardware.
    let effective = if pref == "cpu" || !gpu_available { "cpu" } else { "gpu" };
    json!({
        "enabled": hasher::hash_enabled(),
        "engine_pref": pref,
        "effective_engine": effective,
        "gpu_available": gpu_available,
        "difficulty_start": hasher::difficulty_start(),
        "max_concurrent": hasher::max_concurrent(),
    })
}

/// Estimate blocks remaining until proof is found.
/// Port of TaskState.getBlockRemainingEstimate from JS.
fn estimate_blocks_remaining(
    current_age: u64,
    difficulty_target: u64,
    hashrate: f64, // hashes per millisecond
) -> u64 {
    let max_blocks: u64 = 30000;
    let block_time_ms: f64 = ESTIMATED_BLOCK_TIME_MS; // 5000ms
    let mut cumulative_expected: f64 = 0.0;
    let mut blocks_ahead: u64 = 0;

    while cumulative_expected < 1.0 && blocks_ahead < max_blocks {
        let age_at_block = current_age + blocks_ahead;
        let difficulty = calculate_difficulty(age_at_block, difficulty_target);
        let success_probability = 1.0 / 16.0_f64.powi(difficulty as i32);
        let expected_in_block = hashrate * block_time_ms * success_probability;
        cumulative_expected += expected_in_block;
        blocks_ahead += 1;
    }

    blocks_ahead.min(max_blocks)
}

/// Format a duration in milliseconds to human-readable string
fn format_duration(ms: f64) -> String {
    let seconds = ms / 1000.0;
    if seconds < 60.0 {
        format!("{:.0}s", seconds)
    } else if seconds < 3600.0 {
        format!("{:.0}m", seconds / 60.0)
    } else if seconds < 86400.0 {
        let hours = seconds / 3600.0;
        let mins = (seconds % 3600.0) / 60.0;
        if mins > 0.0 {
            format!("{:.0}h {:.0}m", hours.floor(), mins)
        } else {
            format!("{:.0}h", hours)
        }
    } else {
        format!("{:.1}d", seconds / 86400.0)
    }
}

/// Build a task summary with ETA for list/progress output
fn task_summary(snapshot: &crate::hasher::types::TaskStateSnapshot) -> serde_json::Value {
    let hashrate_display = if snapshot.estimated_hashrate > 1000.0 {
        format!("{:.0}M h/s", snapshot.estimated_hashrate / 1000.0)
    } else if snapshot.estimated_hashrate > 0.0 {
        format!("{:.0}K h/s", snapshot.estimated_hashrate)
    } else {
        "measuring...".to_string()
    };

    let now_ms = now_millis();
    let (current_age, _) = estimate_age(
        snapshot.block_start,
        snapshot.block_checkpoint,
        snapshot.block_checkpoint_time,
        now_ms,
    );

    // Use actual measured hashrate if running, otherwise initial estimate
    let hr = if snapshot.estimated_hashrate > 0.0 {
        snapshot.estimated_hashrate
    } else {
        crate::hasher::types::HASHRATE_INITIAL_ESTIMATE
    };

    let blocks_remaining = estimate_blocks_remaining(
        current_age,
        snapshot.difficulty_target,
        hr,
    );
    let time_remaining_ms = blocks_remaining as f64 * ESTIMATED_BLOCK_TIME_MS;
    let total_blocks = current_age + blocks_remaining;
    let percent = if total_blocks > 0 {
        (current_age as f64 / total_blocks as f64 * 100.0).min(100.0)
    } else {
        0.0
    };

    let current_difficulty = calculate_difficulty(current_age, snapshot.difficulty_target);

    let eta = if snapshot.status == "completed" {
        "Done!".to_string()
    } else {
        format_duration(time_remaining_ms)
    };

    json!({
        "task_id": snapshot.object_id,
        "task_type": snapshot.task_type,
        "status": snapshot.status,
        "percent_complete": format!("{:.1}%", percent),
        "eta": eta,
        "current_difficulty": current_difficulty,
        "difficulty_target": snapshot.difficulty_target,
        "hashrate": hashrate_display,
        "hashrate_per_ms": snapshot.estimated_hashrate,
        "iterations": snapshot.iterations,
        "block_start": snapshot.block_start,
        "block_age": current_age,
        "blocks_remaining": blocks_remaining,
        "result_exists": snapshot.result_exists,
        "result_hash": snapshot.result_hash,
        "result_nonce": snapshot.result_nonce,
        "result_difficulty": snapshot.result_difficulty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hasher::types::TaskHandle;
    use std::sync::atomic::Ordering;

    // Regression guard for the "stop hangs the agent" DashMap deadlock: stop_task
    // must not get-then-remove the same key. If reintroduced, this test deadlocks
    // (CI timeout) instead of passing.
    #[test]
    fn stop_task_removes_and_cancels_without_deadlock() {
        let registry = Arc::new(TaskRegistry::new());
        let handle = Arc::new(TaskHandle::new(TaskParams::for_ore("5-2188", "MINE", 100, 14000)));
        registry.tasks.insert("5-2188".to_string(), handle.clone());

        assert!(stop_task(&registry, "5-2188"));
        assert!(handle.cancel.load(Ordering::SeqCst), "worker should be signalled to cancel");
        assert!(registry.tasks.get("5-2188").is_none(), "task should be removed");
    }

    #[test]
    fn stop_task_missing_returns_false() {
        let registry = Arc::new(TaskRegistry::new());
        assert!(!stop_task(&registry, "5-9999"));
    }
}
