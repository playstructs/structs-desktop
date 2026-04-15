use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

/// Parameters received from the JS Worker shim.
/// Mirrors all TaskState fields needed to run the hasher and reconstruct state for JS.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskParams {
    pub object_id: String,
    pub target_id: Option<String>,
    pub object_type: Option<String>,
    pub task_type: Option<String>,
    pub identity: Option<String>,
    pub prefix: String,
    pub postfix: String,
    pub nonce_start: u64,
    pub nonce_current: u64,
    pub iterations: u64,
    pub iterations_since_last_start: u64,
    pub difficulty_start: Option<u64>,
    pub difficulty_target: u64,
    pub block_start: u64,
    pub block_checkpoint: u64,
    /// Milliseconds since epoch
    pub block_checkpoint_time: f64,
    pub block_current_estimated: Option<u64>,
    pub result_exists: bool,
    pub result_message: Option<String>,
    pub result_nonce: Option<String>,
    pub result_hash: Option<String>,
    pub result_difficulty: u64,
    pub estimated_hashrate: f64,
    pub estimated_block_start_offset: u64,
    pub status: String,
}

/// Mutable progress state updated by the hash worker threads.
#[derive(Debug, Clone)]
pub struct TaskProgress {
    pub status: String,
    pub nonce_current: u64,
    pub iterations: u64,
    pub iterations_since_last_start: u64,
    pub block_checkpoint: u64,
    pub block_checkpoint_time_ms: f64,
    pub block_current_estimated: u64,
    pub estimated_hashrate: f64,
    pub result_exists: bool,
    pub result_message: Option<String>,
    pub result_nonce: Option<String>,
    pub result_hash: Option<String>,
    pub result_difficulty: u64,
    pub process_start_time_ms: f64,
    pub last_status_change_time_ms: f64,
    pub process_end_time_ms: Option<f64>,
}

impl TaskProgress {
    pub fn from_params(params: &TaskParams) -> Self {
        let now_ms = now_millis();
        Self {
            status: params.status.clone(),
            nonce_current: params.nonce_current,
            iterations: params.iterations,
            iterations_since_last_start: 0,
            block_checkpoint: params.block_checkpoint,
            block_checkpoint_time_ms: params.block_checkpoint_time,
            block_current_estimated: params.block_current_estimated.unwrap_or(params.block_checkpoint),
            estimated_hashrate: if params.estimated_hashrate <= 300.0 {
                HASHRATE_INITIAL_ESTIMATE
            } else {
                params.estimated_hashrate
            },
            result_exists: params.result_exists,
            result_message: params.result_message.clone(),
            result_nonce: params.result_nonce.clone(),
            result_hash: params.result_hash.clone(),
            result_difficulty: params.result_difficulty,
            process_start_time_ms: now_ms,
            last_status_change_time_ms: now_ms,
            process_end_time_ms: None,
        }
    }
}

/// Snapshot sent back to JS via Tauri events.
/// Must include ALL TaskState fields for Object.assign(new TaskState(), obj) to work.
#[derive(Debug, Clone, Serialize)]
pub struct TaskStateSnapshot {
    pub status: String,
    pub object_id: String,
    pub target_id: Option<String>,
    pub object_type: Option<String>,
    pub task_type: Option<String>,
    pub identity: Option<String>,
    pub prefix: String,
    pub postfix: String,
    pub nonce_start: u64,
    pub nonce_current: u64,
    pub iterations: u64,
    pub iterations_since_last_start: u64,
    pub difficulty_start: Option<u64>,
    pub difficulty_target: u64,
    pub block_start: u64,
    pub block_checkpoint: u64,
    /// Sent as ms epoch — the JS shim converts to Date object
    pub block_checkpoint_time: f64,
    pub block_current_estimated: u64,
    pub result_exists: bool,
    pub result_message: Option<String>,
    pub result_nonce: Option<String>,
    pub result_hash: Option<String>,
    pub result_difficulty: u64,
    pub estimated_hashrate: f64,
    pub estimated_block_start_offset: u64,
    /// Sent as ms epoch — JS shim converts to Date
    pub process_start_time: f64,
    /// Sent as ms epoch — JS shim converts to Date
    pub last_status_change_time: f64,
    pub process_end_time: Option<f64>,
}

impl TaskStateSnapshot {
    pub fn build(params: &TaskParams, progress: &TaskProgress) -> Self {
        Self {
            status: progress.status.clone(),
            object_id: params.object_id.clone(),
            target_id: params.target_id.clone(),
            object_type: params.object_type.clone(),
            task_type: params.task_type.clone(),
            identity: params.identity.clone(),
            prefix: params.prefix.clone(),
            postfix: params.postfix.clone(),
            nonce_start: params.nonce_start,
            nonce_current: progress.nonce_current,
            iterations: progress.iterations,
            iterations_since_last_start: progress.iterations_since_last_start,
            difficulty_start: params.difficulty_start,
            difficulty_target: params.difficulty_target,
            block_start: params.block_start,
            block_checkpoint: progress.block_checkpoint,
            block_checkpoint_time: progress.block_checkpoint_time_ms,
            block_current_estimated: progress.block_current_estimated,
            result_exists: progress.result_exists,
            result_message: progress.result_message.clone(),
            result_nonce: progress.result_nonce.clone(),
            result_hash: progress.result_hash.clone(),
            result_difficulty: progress.result_difficulty,
            estimated_hashrate: progress.estimated_hashrate,
            estimated_block_start_offset: params.estimated_block_start_offset,
            process_start_time: progress.process_start_time_ms,
            last_status_change_time: progress.last_status_change_time_ms,
            process_end_time: progress.process_end_time_ms,
        }
    }
}

/// Handle for a running hash task. Shared between the Tauri command thread and the hasher.
pub struct TaskHandle {
    pub cancel: AtomicBool,
    pub progress: Mutex<TaskProgress>,
    pub params: TaskParams,
    pub join_handle: Mutex<Option<JoinHandle<()>>>,
}

impl TaskHandle {
    pub fn new(params: TaskParams) -> Self {
        let progress = TaskProgress::from_params(&params);
        Self {
            cancel: AtomicBool::new(false),
            progress: Mutex::new(progress),
            params,
            join_handle: Mutex::new(None),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> TaskStateSnapshot {
        let progress = self.progress.lock().unwrap();
        TaskStateSnapshot::build(&self.params, &progress)
    }
}

/// Global registry of active hash tasks.
pub struct TaskRegistry {
    pub tasks: DashMap<String, Arc<TaskHandle>>,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self {
            tasks: DashMap::new(),
        }
    }
}

/// Initial hashrate estimate in hashes per millisecond.
/// ~20M h/s = 20000 h/ms, between CPU (~3M h/s) and GPU (~200M h/s).
pub const HASHRATE_INITIAL_ESTIMATE: f64 = 20000.0;

pub fn now_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0
}
