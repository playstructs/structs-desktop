pub mod cpu;
pub mod difficulty;
pub mod gpu;
pub mod types;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, State};
use types::{TaskHandle, TaskParams, TaskRegistry, TaskStateSnapshot};

/// Global GPU state — initialized once at first task
static GPU_AVAILABLE: AtomicBool = AtomicBool::new(false);
static GPU_DEVICE: OnceLock<Arc<wgpu::Device>> = OnceLock::new();
static GPU_QUEUE: OnceLock<Arc<wgpu::Queue>> = OnceLock::new();
static GPU_INIT_DONE: AtomicBool = AtomicBool::new(false);

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
            Some((device, queue)) => {
                let _ = GPU_DEVICE.set(Arc::new(device));
                let _ = GPU_QUEUE.set(Arc::new(queue));
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
    let pid = params.object_id.clone();

    // Cancel any existing task with the same PID
    if let Some(existing) = registry.tasks.remove(&pid) {
        existing.1.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    let handle = Arc::new(TaskHandle::new(params));
    registry.tasks.insert(pid.clone(), handle.clone());

    let app_clone = app.clone();
    let handle_clone = handle.clone();

    let use_gpu = ensure_gpu_init();

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
    let use_gpu = ensure_gpu_init();

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
        let snapshot = entry.value().snapshot();
        tasks.push(serde_json::json!({
            "task_id": snapshot.object_id,
            "task_type": snapshot.task_type,
            "status": snapshot.status,
            "hashrate": snapshot.estimated_hashrate,
            "difficulty_target": snapshot.difficulty_target,
            "result_exists": snapshot.result_exists,
        }));
    }
    Ok(serde_json::json!({
        "gpu_available": ensure_gpu_init(),
        "active_tasks": tasks.len(),
        "tasks": tasks,
    }))
}

#[tauri::command]
pub async fn get_hash_task_progress(
    pid: String,
    registry: State<'_, Arc<TaskRegistry>>,
) -> Result<Option<TaskStateSnapshot>, String> {
    Ok(registry.tasks.get(&pid).map(|entry| entry.snapshot()))
}
