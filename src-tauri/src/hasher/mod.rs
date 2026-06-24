pub mod cpu;
pub mod difficulty;
pub mod gpu;
pub mod types;

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, State};
use types::{TaskHandle, TaskParams, TaskRegistry, TaskStateSnapshot};

/// Global GPU state — initialized once at first task
static GPU_AVAILABLE: AtomicBool = AtomicBool::new(false);
static GPU_DEVICE: OnceLock<Arc<wgpu::Device>> = OnceLock::new();
static GPU_QUEUE: OnceLock<Arc<wgpu::Queue>> = OnceLock::new();
static GPU_INFO: OnceLock<gpu::GpuInfo> = OnceLock::new();
static GPU_INIT_DONE: AtomicBool = AtomicBool::new(false);

// ── Runtime hashing config (agent-controllable via the structs_hash tool) ──
/// Master on/off for the hashing system. When false, no new tasks start.
static HASH_ENABLED: AtomicBool = AtomicBool::new(true);
/// Engine preference for new tasks: 0 = auto, 1 = force CPU, 2 = prefer GPU.
static ENGINE_PREF: AtomicU8 = AtomicU8::new(0);
/// DIFFICULTY_START override; 0 = use the compile-time default in `difficulty`.
static DIFFICULTY_START_OVERRIDE: AtomicU64 = AtomicU64::new(0);
/// Last max-concurrent value (mirrors the webapp `TASK.MAX_CONCURRENT_PROCESSES`,
/// which is the authoritative spawner cap — tracked here only for reporting).
static MAX_CONCURRENT: AtomicU64 = AtomicU64::new(5);

pub fn set_hash_enabled(v: bool) {
    HASH_ENABLED.store(v, Ordering::Relaxed);
}
pub fn hash_enabled() -> bool {
    HASH_ENABLED.load(Ordering::Relaxed)
}
pub fn set_engine_pref(p: u8) {
    ENGINE_PREF.store(p, Ordering::Relaxed);
}
pub fn engine_pref_label() -> &'static str {
    match ENGINE_PREF.load(Ordering::Relaxed) {
        1 => "cpu",
        2 => "gpu",
        _ => "auto",
    }
}
pub fn set_difficulty_start(v: u64) {
    DIFFICULTY_START_OVERRIDE.store(v, Ordering::Relaxed);
}
/// Effective DIFFICULTY_START — the difficulty a worker waits for before it
/// starts grinding. Read live by the CPU/GPU workers each loop.
pub fn difficulty_start() -> u64 {
    let o = DIFFICULTY_START_OVERRIDE.load(Ordering::Relaxed);
    if o == 0 {
        difficulty::DIFFICULTY_START
    } else {
        o
    }
}
pub fn set_max_concurrent(v: u64) {
    MAX_CONCURRENT.store(v, Ordering::Relaxed);
}
pub fn max_concurrent() -> u64 {
    MAX_CONCURRENT.load(Ordering::Relaxed)
}

/// Whether a NEW task should run on the GPU, honoring the engine preference.
/// Force-CPU never touches the GPU; auto/prefer-GPU use it only when present.
pub fn resolve_use_gpu() -> bool {
    if ENGINE_PREF.load(Ordering::Relaxed) == 1 {
        false
    } else {
        ensure_gpu_init()
    }
}

pub fn ensure_gpu_init() -> bool {
    if GPU_INIT_DONE.load(std::sync::atomic::Ordering::Relaxed) {
        return GPU_AVAILABLE.load(std::sync::atomic::Ordering::Relaxed);
    }

    // Only one thread initializes
    if GPU_INIT_DONE
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::Relaxed,
        )
        .is_ok()
    {
        match gpu::try_init_gpu() {
            Some((device, queue, info)) => {
                let _ = GPU_DEVICE.set(Arc::new(device));
                let _ = GPU_QUEUE.set(Arc::new(queue));
                let _ = GPU_INFO.set(info);
                GPU_AVAILABLE.store(true, std::sync::atomic::Ordering::SeqCst);
                eprintln!("[Structs Hasher] GPU available — will use GPU for hashing");
            }
            None => {
                eprintln!("[Structs Hasher] No GPU available — using CPU only");
            }
        }
    }

    GPU_AVAILABLE.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
/// Core hash start logic, usable from both Tauri commands and MCP tools
pub fn start_hash_task_core(
    params: TaskParams,
    app: AppHandle,
    registry: &Arc<TaskRegistry>,
) -> Result<(), String> {
    if !hash_enabled() {
        return Err("Hashing is disabled. Re-enable with structs_hash config { enabled: true }.".to_string());
    }
    let pid = params.object_id.clone();

    // Cancel any existing task with the same PID
    if let Some(existing) = registry.tasks.remove(&pid) {
        existing.1.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    let handle = Arc::new(TaskHandle::new(params));
    registry.tasks.insert(pid.clone(), handle.clone());

    let app_clone = app.clone();
    let handle_clone = handle.clone();

    let use_gpu = resolve_use_gpu();

    let join = std::thread::spawn(move || {
        if use_gpu {
            let device = GPU_DEVICE.get().unwrap().clone();
            let queue = GPU_QUEUE.get().unwrap().clone();
            eprintln!("[Structs Hasher] Starting task {} on GPU", handle_clone.params.object_id);
            gpu::run_gpu_hash(handle_clone, device, queue, app_clone);
        } else {
            eprintln!("[Structs Hasher] Starting task {} on CPU ({} threads)",
                handle_clone.params.object_id, num_cpus::get().saturating_sub(1).max(1));
            cpu::run_cpu_hash(handle_clone, app_clone);
        }
    });

    *handle.join_handle.lock().unwrap() = Some(join);
    Ok(())
}

#[tauri::command]
pub async fn start_hash_task(
    params: TaskParams,
    app: AppHandle,
    registry: State<'_, Arc<TaskRegistry>>,
) -> Result<(), String> {
    if !hash_enabled() {
        return Err("Hashing is disabled. Re-enable with structs_hash config { enabled: true }.".to_string());
    }
    let pid = params.object_id.clone();

    // Cancel any existing task with the same PID
    if let Some(existing) = registry.tasks.remove(&pid) {
        existing.1.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    let handle = Arc::new(TaskHandle::new(params));
    registry.tasks.insert(pid.clone(), handle.clone());

    let app_clone = app.clone();
    let handle_clone = handle.clone();

    // Check GPU availability
    let use_gpu = resolve_use_gpu();

    let join = std::thread::spawn(move || {
        if use_gpu {
            let device = GPU_DEVICE.get().unwrap().clone();
            let queue = GPU_QUEUE.get().unwrap().clone();
            eprintln!("[Structs Hasher] Starting task {} on GPU", handle_clone.params.object_id);
            gpu::run_gpu_hash(handle_clone, device, queue, app_clone);
        } else {
            eprintln!("[Structs Hasher] Starting task {} on CPU ({} threads)",
                handle_clone.params.object_id, num_cpus::get().saturating_sub(1).max(1));
            cpu::run_cpu_hash(handle_clone, app_clone);
        }
    });

    *handle.join_handle.lock().unwrap() = Some(join);

    Ok(())
}

#[tauri::command]
pub async fn stop_hash_task(
    pid: String,
    registry: State<'_, Arc<TaskRegistry>>,
) -> Result<(), String> {
    if let Some(entry) = registry.tasks.get(&pid) {
        entry.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        eprintln!("[Structs Hasher] Stopping task {}", pid);
    }
    registry.tasks.remove(&pid);
    Ok(())
}

#[tauri::command]
pub async fn list_hash_tasks(
    registry: State<'_, Arc<TaskRegistry>>,
) -> Result<serde_json::Value, String> {
    let mut tasks = vec![];
    for entry in registry.tasks.iter() {
        let s = entry.value().snapshot();
        tasks.push(serde_json::json!({
            "task_id": s.object_id,
            "task_type": s.task_type,
            "object_type": s.object_type,
            "target_id": s.target_id,
            "status": s.status,
            "hashrate": s.estimated_hashrate,
            "difficulty_target": s.difficulty_target,
            "difficulty_start": s.difficulty_start,
            "result_exists": s.result_exists,
            "result_difficulty": s.result_difficulty,
            "result_nonce": s.result_nonce,
            "iterations": s.iterations,
            "iterations_since_last_start": s.iterations_since_last_start,
            "nonce_start": s.nonce_start,
            "nonce_current": s.nonce_current,
            "block_start": s.block_start,
            "block_checkpoint": s.block_checkpoint,
            "block_current_estimated": s.block_current_estimated,
            "process_start_time": s.process_start_time,
            "last_status_change_time": s.last_status_change_time,
            "process_end_time": s.process_end_time,
            "prefix": s.prefix,
        }));
    }

    // Engine — global since the GPU/CPU decision is shared across all tasks.
    let gpu_available = ensure_gpu_init();
    let engine = if gpu_available { "gpu" } else { "cpu" };

    let mut payload = serde_json::json!({
        "engine": engine,
        "gpu_available": gpu_available,
        "active_tasks": tasks.len(),
        "tasks": tasks,
    });

    if gpu_available {
        if let Some(info) = GPU_INFO.get() {
            payload["gpu_info"] = serde_json::json!({
                "name": info.name,
                "backend": info.backend,
                "device_type": info.device_type,
            });
        }
    } else {
        // For CPU mode, report the thread count we'd actually use (matches
        // the eprintln in start_hash_task_core: cpus - 1, min 1).
        let threads = num_cpus::get().saturating_sub(1).max(1);
        payload["cpu_threads"] = serde_json::json!(threads);
        payload["cpu_total_cores"] = serde_json::json!(num_cpus::get());
    }

    Ok(payload)
}

#[tauri::command]
pub async fn get_hash_task_progress(
    pid: String,
    registry: State<'_, Arc<TaskRegistry>>,
) -> Result<Option<TaskStateSnapshot>, String> {
    Ok(registry.tasks.get(&pid).map(|entry| entry.snapshot()))
}
