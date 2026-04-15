use rmcp::model::Content;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use crate::hasher;
use crate::hasher::difficulty::{calculate_difficulty, estimate_age, ESTIMATED_BLOCK_TIME_MS};
use crate::hasher::types::{now_millis, TaskParams, TaskRegistry};

#[derive(Debug, Deserialize)]
pub struct HashParams {
    /// Command: list, start, progress, stop
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
                    "gpu_available": hasher::ensure_gpu_init(),
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
            let block_start = params.block_start.unwrap_or(gs.current_block_height);
            let difficulty_target = params.difficulty_target.unwrap_or_else(|| {
                gs.get_difficulty_for_struct(task_id, task_type)
                    .unwrap_or(700) // fallback default
            });
            let struct_type_name = gs.get_struct_type_name(task_id);
            drop(gs);

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
                block_checkpoint: block_start,
                block_checkpoint_time: now_ms,
                block_current_estimated: Some(block_start),
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
            if let Some(entry) = registry.tasks.get(task_id) {
                entry
                    .cancel
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                registry.tasks.remove(task_id);
                vec![Content::text(format!("Task {} stopped", task_id))]
            } else {
                vec![Content::text(format!(
                    "No active task with id '{}'",
                    task_id
                ))]
            }
        }

        other => vec![Content::text(format!(
            "Unknown hash command '{}'. Use: list, start, progress, stop",
            other
        ))],
    }
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
