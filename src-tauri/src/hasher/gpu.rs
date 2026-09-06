use std::sync::Arc;
use wgpu::util::DeviceExt;

use crate::hasher::difficulty::{
    calculate_difficulty, estimate_age, gpu_checkpoint_due, refresh_checkpoint, DIFFICULTY_START_SLEEP_MS,
};
use crate::hasher::types::{now_millis, TaskHandle};

/// Batch size: number of nonces tested per GPU dispatch
const GPU_BATCH_SIZE: u32 = 1 << 20; // ~1M nonces per dispatch
/// A healthy batch reads back in well under a second; a batch that hasn't
/// mapped after this long is lost (observed live as tasks frozen at exactly
/// one batch of iterations). Generous so slow-device false positives are
/// impossible, but bounded so a pool worker can never wedge forever.
const GPU_READBACK_TIMEOUT_MS: u64 = 60_000;

/// Uniform params matching the WGSL Params struct (8 x u32 = 32 bytes)
#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuParams {
    base_nonce: u32,
    base_nonce_high: u32,
    required_zeros: u32,
    prefix_len: u32,
    postfix_len: u32,
    batch_size: u32,
    _pad0: u32,
    _pad1: u32,
}

/// Pack a byte slice into u32 array (big-endian, matching the shader's get_byte_from_packed)
fn pack_bytes_be(data: &[u8]) -> Vec<u32> {
    let mut packed = Vec::with_capacity((data.len() + 3) / 4);
    for chunk in data.chunks(4) {
        let mut word: u32 = 0;
        for (i, &b) in chunk.iter().enumerate() {
            word |= (b as u32) << (24 - i * 8);
        }
        packed.push(word);
    }
    if packed.is_empty() {
        packed.push(0);
    }
    packed
}

/// Adapter info captured at init time, surfaced via the debug panel.
#[derive(Debug, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub backend: String,
    pub device_type: String,
}

/// Try to initialize the GPU. Returns None if no suitable adapter.
pub fn try_init_gpu() -> Option<(wgpu::Device, wgpu::Queue, GpuInfo)> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))?;

    let info = adapter.get_info();
    let gpu_info = GpuInfo {
        name: info.name.clone(),
        backend: format!("{:?}", info.backend),
        device_type: format!("{:?}", info.device_type),
    };

    eprintln!(
        "[Structs Hasher GPU] Found adapter: {} ({}, {})",
        gpu_info.name, gpu_info.backend, gpu_info.device_type
    );

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("structs-hasher"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .ok()?;

    Some((device, queue, gpu_info))
}

/// Run the GPU hasher.
pub fn run_gpu_hash(
    handle: Arc<TaskHandle>,
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    app_handle: tauri::AppHandle,
) {
    let prefix = handle.params.prefix.as_bytes();
    let postfix = handle.params.postfix.as_bytes();
    let block_start = handle.params.block_start;
    let difficulty_target = handle.params.difficulty_target;
    let pid = handle.params.object_id.clone();
    let initial_iterations = handle.params.iterations;
    let initial_nonce = handle.params.nonce_current;

    // Update to WAITING
    {
        let mut progress = handle.progress.lock().unwrap();
        progress.status = "waiting".to_string();
        progress.last_status_change_time_ms = now_millis();
    }
    emit_event(&app_handle, "hash_progress", &handle);

    // Wait for difficulty. `break`s with the current difficulty once ripe — used
    // as the admission priority below (easiest tasks grind first).
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
        eprintln!(
            "[Structs Hasher GPU] {} waiting: difficulty {} > {}",
            pid, difficulty, difficulty_start
        );
        // The pool only pops RIPE tasks, so landing here means the pool and
        // this worker disagree about ripeness — a slot is about to sleep.
        if handle.progress.lock().map(|p| p.work_start_time_ms.is_some()).unwrap_or(false) {
            crate::mcp::telemetry::tlog_kv(
                "hasher",
                crate::mcp::telemetry::Sev::Warn,
                format!("pool popped {pid} unripe: difficulty {difficulty} > {difficulty_start} (age {age}); worker sleeping"),
                serde_json::json!({"object_id": pid, "difficulty": difficulty, "difficulty_start": difficulty_start, "age": age}),
            );
        }
        emit_event(&app_handle, "hash_progress", &handle);
        std::thread::sleep(std::time::Duration::from_millis(DIFFICULTY_START_SLEEP_MS));
    };

    // Priority admission: cap concurrent grinders at max_concurrent and admit the
    // easiest-difficulty task first, so a cheap build never waits behind an
    // expensive refine. Held for the whole grind; freed on drop. `None` = the
    // task was cancelled while queued for a slot.
    let _permit = match crate::mcp::capacity::admit_gpu(admit_difficulty, &|| handle.is_cancelled()) {
        Some(p) => p,
        None => return,
    };

    // Transition to RUNNING
    {
        let mut progress = handle.progress.lock().unwrap();
        progress.status = "running".to_string();
        progress.last_status_change_time_ms = now_millis();
    }
    emit_event(&app_handle, "hash_progress", &handle);

    eprintln!("[Structs Hasher GPU] {} running on GPU", pid);

    // Create shader module
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("sha256-compute"),
        source: wgpu::ShaderSource::Wgsl(include_str!("sha256.wgsl").into()),
    });

    // Pack prefix and postfix
    let prefix_packed = pack_bytes_be(prefix);
    let postfix_packed = pack_bytes_be(postfix);

    // Create GPU buffers
    let prefix_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("prefix"),
        contents: bytemuck::cast_slice(&prefix_packed),
        usage: wgpu::BufferUsages::STORAGE,
    });

    let postfix_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("postfix"),
        contents: bytemuck::cast_slice(&postfix_packed),
        usage: wgpu::BufferUsages::STORAGE,
    });

    // Result buffer: [found_flag, nonce_low, nonce_high, hash[0..7]] = 11 u32s
    let result_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("result"),
        size: 11 * 4,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let result_staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("result-staging"),
        size: 11 * 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("params"),
        size: std::mem::size_of::<GpuParams>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    // Bind group layout
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("hasher-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("hasher-pipeline-layout"),
        bind_group_layouts: &[&bind_group_layout],
        push_constant_ranges: &[],
    });

    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("hasher-pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("hasher-bind-group"),
        layout: &bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: prefix_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: postfix_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: result_buffer.as_entire_binding(),
            },
        ],
    });

    // Main dispatch loop
    let mut current_nonce: u64 = initial_nonce + 1;
    let mut total_hashes: u64 = 0;
    let mut difficulty = {
        let now_ms = now_millis();
        let (age, _) = {
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
        calculate_difficulty(age, difficulty_target)
    };

    loop {
        if handle.is_cancelled() {
            return;
        }

        // Update params for this batch
        let gpu_params = GpuParams {
            base_nonce: current_nonce as u32,
            base_nonce_high: (current_nonce >> 32) as u32,
            required_zeros: difficulty as u32,
            prefix_len: prefix.len() as u32,
            postfix_len: postfix.len() as u32,
            batch_size: GPU_BATCH_SIZE,
            _pad0: 0,
            _pad1: 0,
        };

        queue.write_buffer(&params_buffer, 0, bytemuck::bytes_of(&gpu_params));

        // Clear result buffer
        let clear_data = [0u32; 11];
        queue.write_buffer(&result_buffer, 0, bytemuck::cast_slice(&clear_data));

        // Dispatch
        let workgroups = (GPU_BATCH_SIZE + 255) / 256;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("hasher-encoder"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("hasher-pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(workgroups, 1, 1);
        }

        // Copy result to staging for readback
        encoder.copy_buffer_to_buffer(&result_buffer, 0, &result_staging, 0, 11 * 4);
        queue.submit(std::iter::once(encoder.finish()));

        // Read back result. BOUNDED wait, never Maintain::Wait + recv():
        // a lost batch (seen live ~40×/hr, iterations frozen at exactly one
        // batch) used to block this thread forever — tolerable when every task
        // had its own thread, fatal now that a bounded pool runs the grinds
        // (each wedge would permanently eat a worker). On timeout we abandon
        // the task; reap + the auto loops re-enqueue it later.
        let result_slice = result_staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        result_slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(GPU_READBACK_TIMEOUT_MS);
        let mapped = loop {
            device.poll(wgpu::Maintain::Poll);
            match rx.try_recv() {
                Ok(r) => break Some(r),
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break None,
            }
            if std::time::Instant::now() >= deadline || handle.is_cancelled() {
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        match mapped {
            Some(Ok(())) => {}
            Some(Err(_)) => {
                eprintln!("[Structs Hasher GPU] Failed to read result buffer");
                return;
            }
            None => {
                eprintln!(
                    "[Structs Hasher GPU] {} readback timed out after {}ms — abandoning batch (task will be re-issued)",
                    pid, GPU_READBACK_TIMEOUT_MS
                );
                return;
            }
        }

        let data = result_slice.get_mapped_range();
        let result_data: &[u32] = bytemuck::cast_slice(&data);
        let found_flag = result_data[0];

        if found_flag != 0 {
            let nonce_low = result_data[1];
            let nonce_high = result_data[2];
            let found_nonce = (nonce_high as u64) << 32 | nonce_low as u64;
            let hash_words: Vec<u32> = result_data[3..11].to_vec();
            drop(data);
            result_staging.unmap();

            // Reconstruct hash hex
            let mut hash_bytes = [0u8; 32];
            for (i, &w) in hash_words.iter().enumerate() {
                hash_bytes[i * 4] = (w >> 24) as u8;
                hash_bytes[i * 4 + 1] = (w >> 16) as u8;
                hash_bytes[i * 4 + 2] = (w >> 8) as u8;
                hash_bytes[i * 4 + 3] = w as u8;
            }
            let hash_hex = hex::encode(hash_bytes);
            let message = format!(
                "{}{}{}",
                handle.params.prefix, found_nonce, handle.params.postfix
            );

            total_hashes += GPU_BATCH_SIZE as u64;
            let now_ms = now_millis();
            {
                let mut progress = handle.progress.lock().unwrap();
                progress.status = "completed".to_string();
                progress.nonce_current = found_nonce;
                progress.iterations = initial_iterations + total_hashes;
                progress.iterations_since_last_start = total_hashes;
                progress.result_exists = true;
                progress.result_message = Some(message);
                progress.result_nonce =
                    Some(format!("{}{}", found_nonce, handle.params.postfix));
                progress.result_hash = Some(hash_hex);
                progress.result_difficulty = difficulty;
                progress.process_end_time_ms = Some(now_ms);
                progress.last_status_change_time_ms = now_ms;
            }

            eprintln!(
                "[Structs Hasher GPU] {} FOUND at nonce {} (difficulty {}, {} total hashes)",
                pid, found_nonce, difficulty, total_hashes
            );
            emit_event(&app_handle, "hash_complete", &handle);
            return;
        }

        drop(data);
        result_staging.unmap();

        total_hashes += GPU_BATCH_SIZE as u64;
        current_nonce += GPU_BATCH_SIZE as u64;

        // Progress checkpoint
        // Checkpoint on BATCH boundaries. `total_hashes % CHECKPOINT_COMMIT`
        // was the old test, but total_hashes only ever takes multiples of the
        // 2^20 batch and 5,000,000 is not one of them — the two first coincide
        // at 2^20 × 5^7 ≈ 8.2e10 hashes, 20–35 minutes into a grind. Until
        // then the iteration counter sat at exactly one batch, the watchdog
        // read that as "running, no progress for 5 min" and reaped a healthy
        // task, and the grinding difficulty never decayed either (see below).
        // A human player's webapp never hears about the reap, so its struct
        // simply never builds. Seen in a player's log bundle 2026-09-04 and
        // 260 times in our own telemetry that week.
        if gpu_checkpoint_due(total_hashes, GPU_BATCH_SIZE as u64) || total_hashes == GPU_BATCH_SIZE as u64 {
            let now_ms = now_millis();
            {
                let mut progress = handle.progress.lock().unwrap();
                progress.nonce_current = current_nonce;
                progress.iterations = initial_iterations + total_hashes;
                progress.iterations_since_last_start = total_hashes;
                let elapsed_ms = now_ms - progress.last_status_change_time_ms;
                if elapsed_ms > 0.0 {
                    progress.estimated_hashrate = total_hashes as f64 / elapsed_ms;
                }
                let (_, block_est) = estimate_age(
                    block_start,
                    progress.block_checkpoint,
                    progress.block_checkpoint_time_ms,
                    now_ms,
                );
                progress.block_current_estimated = block_est;
            }
            emit_event(&app_handle, "hash_progress", &handle);
        }

        // Difficulty recalculation
        if gpu_checkpoint_due(total_hashes, GPU_BATCH_SIZE as u64) {
            let now_ms = now_millis();
            let (age, block_est) = {
                let progress = handle.progress.lock().unwrap();
                estimate_age(
                    block_start,
                    progress.block_checkpoint,
                    progress.block_checkpoint_time_ms,
                    now_ms,
                )
            };
            difficulty = calculate_difficulty(age, difficulty_target);
            {
                let mut progress = handle.progress.lock().unwrap();
                progress.block_current_estimated = block_est;
            }

            // Check previous result reuse
            let reuse = {
                let progress = handle.progress.lock().unwrap();
                progress.result_exists && progress.result_difficulty >= difficulty
            };
            if reuse {
                let now_ms = now_millis();
                {
                    let mut progress = handle.progress.lock().unwrap();
                    progress.status = "completed".to_string();
                    progress.result_difficulty = difficulty;
                    progress.process_end_time_ms = Some(now_ms);
                    progress.last_status_change_time_ms = now_ms;
                    progress.iterations = initial_iterations + total_hashes;
                    progress.iterations_since_last_start = total_hashes;
                }
                eprintln!(
                    "[Structs Hasher GPU] {} reusing previous result at difficulty {}",
                    pid, difficulty
                );
                emit_event(&app_handle, "hash_complete", &handle);
                return;
            }
        }
    }
}

fn emit_event(app_handle: &tauri::AppHandle, event: &str, handle: &TaskHandle) {
    let snapshot = handle.snapshot();
    let payload = serde_json::to_value(&snapshot).unwrap_or_default();
    let _ = crate::mcp::events::emit(
        app_handle,
        if event == "hash_complete" { crate::mcp::events::AppEvent::HashComplete(payload) } else { crate::mcp::events::AppEvent::HashProgress(payload) },
    );
    // If this hash belongs to a virtual player, sign its completion tx.
    if event == "hash_complete" {
        // Solve history feeds the adaptive tuner (difficulty_start / max_concurrent).
        crate::mcp::telemetry::record_solve(&snapshot, "gpu");
        crate::hasher::maybe_complete_virtual(app_handle, &snapshot);
        crate::hasher::maybe_report_borrowed(app_handle, &snapshot);
    }
}
