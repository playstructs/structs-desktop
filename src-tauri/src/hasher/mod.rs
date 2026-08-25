pub mod cpu;
pub mod difficulty;
pub mod gpu;
pub mod pool;
pub mod scheduler;
pub mod tuner;
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
/// Concurrent-grind cap. CONSUMED LIVE by `scheduler::admit` (the native
/// admission gate), and mirrored to the webapp `TASK.MAX_CONCURRENT_PROCESSES`
/// spawner cap.
static MAX_CONCURRENT: AtomicU64 = AtomicU64::new(5);
/// Opt-in adaptive tuning of difficulty_start/max_concurrent from solve history.
static AUTO_TUNE: AtomicBool = AtomicBool::new(false);

pub fn set_auto_tune(v: bool) {
    AUTO_TUNE.store(v, Ordering::Relaxed);
}
pub fn auto_tune() -> bool {
    AUTO_TUNE.load(Ordering::Relaxed)
}

/// Persisted mirror of the runtime hash knobs. Before this existed the knobs
/// were memory-only atomics that silently reset to defaults on every restart.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct HashConfig {
    pub enabled: bool,
    /// "auto" | "cpu" | "gpu"
    pub engine: String,
    /// 0 = compile-time default.
    pub difficulty_start: u64,
    pub max_concurrent: u64,
    pub auto_tune: bool,
}

impl Default for HashConfig {
    fn default() -> Self {
        Self { enabled: true, engine: "auto".into(), difficulty_start: 0, max_concurrent: 5, auto_tune: false }
    }
}

const HASH_CONFIG_FILE: &str = "hash_config.json";

/// Apply the persisted knob values to the runtime atomics. Call once at startup.
pub fn load_persisted_config() {
    let cfg: HashConfig = crate::mcp::config_store::load_config(HASH_CONFIG_FILE);
    set_hash_enabled(cfg.enabled);
    set_engine_pref(match cfg.engine.as_str() {
        "cpu" => 1,
        "gpu" => 2,
        _ => 0,
    });
    set_difficulty_start(cfg.difficulty_start);
    set_max_concurrent(cfg.max_concurrent.clamp(1, 64));
    set_auto_tune(cfg.auto_tune);
}

/// Snapshot the runtime atomics to disk. Call after any knob change (the
/// structs_hash config handler and the tuner both do).
pub fn persist_config() {
    let cfg = HashConfig {
        enabled: hash_enabled(),
        engine: engine_pref_label().to_string(),
        difficulty_start: DIFFICULTY_START_OVERRIDE.load(Ordering::Relaxed),
        max_concurrent: max_concurrent(),
        auto_tune: auto_tune(),
    };
    crate::mcp::config_store::save_config(HASH_CONFIG_FILE, &cfg);
}

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
    // A live raise should take effect without waiting for the next enqueue.
    pool::ensure_workers();
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

// ── Virtual-player PoW completion ──
// Hashes started for a virtual player (object_id → (HD index, task_type)). On
// completion the worker calls `maybe_complete_virtual`, which signs the
// completion tx AS that virtual player via the façade (the webapp TaskManager
// only ever signs as the primary, so virtual PoW can't go through it).
static VPLAYER_HASHES: std::sync::LazyLock<dashmap::DashMap<String, (u32, String)>> =
    std::sync::LazyLock::new(dashmap::DashMap::new);

pub fn register_vplayer_hash(object_id: String, index: u32, task_type: String) {
    VPLAYER_HASHES.insert(object_id, (index, task_type));
}

/// Completions that have been dispatched but not yet resolved, as
/// `object_id -> the anchor the proof was solved against`.
///
/// The signing façade is serial, so a completion can sit in the admission gate
/// for the best part of an hour when a backlog drains. For that whole time the
/// chain's clock still reads the OLD anchor — the cycle has not been closed
/// yet — so the harvest loop saw a ripe struct and re-issued the very same
/// proof. Measured over six hours: 3,076 of 3,233 structs were solved TWICE,
/// and 693 sent a second completion. The wasted GPU barely matters at
/// difficulty 1; the wasted QUEUE SLOTS do, because that is the scarce serial
/// resource the whole economy is throttled by.
static PENDING_COMPLETIONS: std::sync::LazyLock<dashmap::DashMap<String, u64>> =
    std::sync::LazyLock::new(dashmap::DashMap::new);

/// The anchor this object already has a completion in flight for, if any.
pub fn completion_in_flight(object_id: &str) -> Option<u64> {
    PENDING_COMPLETIONS.get(object_id).map(|v| *v)
}

/// If the completed task belongs to a virtual player, sign+broadcast its
/// completion tx (mine/refine/build/raid) as that player. No-op otherwise.
pub fn maybe_complete_virtual(app_handle: &AppHandle, snap: &TaskStateSnapshot) {
    if !snap.result_exists {
        return;
    }
    let Some((_k, (index, task_type))) = VPLAYER_HASHES.remove(&snap.object_id) else {
        return;
    };
    let nonce = snap.result_nonce.clone().unwrap_or_default();
    let proof = snap.result_hash.clone().unwrap_or_default();
    // Completion msg by task type. `creator` is injected by the façade signer.
    let (type_url, payload) = match task_type.as_str() {
        "MINE" => (
            "/structs.structs.MsgStructOreMinerComplete",
            serde_json::json!({ "structId": snap.object_id, "proof": proof, "nonce": nonce }),
        ),
        "REFINE" => (
            "/structs.structs.MsgStructOreRefineryComplete",
            serde_json::json!({ "structId": snap.object_id, "proof": proof, "nonce": nonce }),
        ),
        "BUILD" => (
            "/structs.structs.MsgStructBuildComplete",
            serde_json::json!({ "structId": snap.object_id, "proof": proof, "nonce": nonce }),
        ),
        "RAID" => (
            "/structs.structs.MsgPlanetRaidComplete",
            // For RAID the hash object_id is the fleet id.
            serde_json::json!({ "fleetId": snap.object_id, "proof": proof, "nonce": nonce }),
        ),
        _ => return,
    };
    let app = app_handle.clone();
    let object_id = snap.object_id.clone();
    let solved_anchor = snap.block_start;
    let task_kind = task_type.clone();
    tauri::async_runtime::spawn(async move {
        // ── Is the proof still anchored to a live cycle? ──────────────────
        // The completion message carries only {structId, proof, nonce} — NO
        // anchor. The chain verifies our nonce against ITS current
        // blockStartOre*, so if the cycle restarted between solving and
        // submitting, the proof is dead on arrival and the tx is wasted. That
        // is the "work failure for input (…)" class: the input in the error is
        // the CHAIN's reconstruction — its anchor, our nonce — which is why the
        // block in it always looks correct.
        //
        // Measured 6 of 457 completions (1.3%). Cheap to avoid: one read turns
        // a guaranteed chain rejection into a skip, and auto_harvest re-issues
        // against the new anchor on its next pass.
        // The ore planet is also remembered, so the SAME check can be repeated
        // after the admission gate — the wait there is where most staleness is
        // actually introduced (see tx_retry::FreshAnchor).
        let mut ore_planet: Option<String> = None;
        if let Some(anchor) = anchor_field_for(&task_kind) {
            let client = crate::mcp::cosmos_client::CosmosClient::new();
            if let Ok(e) = client.query_entity("struct", &object_id).await {
                let live = match anchor {
                    Anchor::StructField(field) => {
                        crate::mcp::loop_util::read_u64_field(e.get("structAttributes"), field)
                    }
                    // Chain v0.21.0: the ore clock hangs off the PLANET the rig
                    // stands on, so reach it through the struct's locationId. A
                    // planetary struct's locationId IS its planet id. Reading the
                    // struct here instead would always see 0 and, because 0 means
                    // "unknown, don't block", would wave through every stale ore
                    // proof this guard exists to catch.
                    Anchor::PlanetOreClock => match e
                        .get("Struct")
                        .and_then(|s| s.get("locationId"))
                        .and_then(|l| l.as_str())
                    {
                        Some(planet_id) => {
                            ore_planet = Some(planet_id.to_string());
                            match client.query_entity("planet", planet_id).await {
                                Ok(p) => {
                                    crate::mcp::loop_util::planet_ore_anchor(Some(&p), &task_kind)
                                }
                                Err(_) => 0,
                            }
                        }
                        None => 0,
                    },
                };
                if live != 0 && live != solved_anchor {
                    crate::mcp::telemetry::tlog(
                        "hasher",
                        crate::mcp::telemetry::Sev::Notice,
                        format!(
                            "{task_kind} proof for {object_id} abandoned: solved against anchor \
                             {solved_anchor}, chain is now at {live} (cycle restarted mid-solve)"
                        ),
                    );
                    return;
                }
            }
        }
        // Re-tested once the gate slot is won, immediately before broadcast.
        let guard = ore_planet.map(|planet_id| crate::mcp::tx_retry::FreshAnchor {
            planet_id,
            task_type: task_kind.clone(),
            solved_anchor,
        });
        // Route through tx_retry — NOT vplayer_bridge directly. This is the
        // most important tx class in the economy (every mine/refine/build/raid
        // payoff), and signing it raw meant success AND failure were reported
        // only to stderr: nothing in `tx_attempts`, nothing in the board feed,
        // nothing queryable. A 15-day, ~600k-solve futile-mining incident went
        // undetected precisely because of that blind spot. Now every completion
        // is ledgered like any other tx (sequence-mismatch retry only).
        let context = format!("pow_complete:{}", object_id);
        // Claim this cycle so the harvest loop doesn't re-issue the same proof
        // while this one waits its turn at the gate. Released below, on every
        // path, so a struct is never locked out of its next cycle.
        PENDING_COMPLETIONS.insert(object_id.clone(), solved_anchor);
        let signed = crate::mcp::tx_retry::sign_with_retry_guarded(
            &app, index, type_url, payload, &context, guard,
        )
        .await;
        PENDING_COMPLETIONS.remove(&object_id);
        match signed
        {
            Ok(_) => {
                crate::mcp::telemetry::tlog(
                    "hasher",
                    crate::mcp::telemetry::Sev::Debug,
                    format!("{task_type} completion signed for {object_id} (vplayer {index})"),
                );
            }
            Err(e) => {
                // Surface failures loudly: a completion that never lands leaves
                // the anchor frozen, so the harvest loop will re-issue the same
                // proof indefinitely. That treadmill must be visible.
                crate::mcp::telemetry::tlog(
                    "hasher",
                    crate::mcp::telemetry::Sev::Warn,
                    format!("{task_type} completion FAILED for {object_id} (vplayer {index}): {e}"),
                );
            }
        }
    });
}

/// Where a task type's proof anchor lives on chain.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Anchor {
    /// A field on the struct's own `structAttributes`.
    StructField(&'static str),
    /// The shared ore clock on the PLANET the struct stands on.
    PlanetOreClock,
}

/// Which on-chain value anchors this task type's proof.
///
/// Chain v0.21.0 moved the mine/refine clocks off the struct and onto the
/// planet, so MINE and REFINE resolve through the struct's location. BUILD is
/// still a struct attribute. RAID anchors on the planet too, but its object_id
/// is a FLEET rather than a struct, so it has no entry here and is left
/// unchecked.
fn anchor_field_for(task_type: &str) -> Option<Anchor> {
    match task_type {
        "MINE" | "REFINE" => Some(Anchor::PlanetOreClock),
        "BUILD" => Some(Anchor::StructField("blockStartBuild")),
        _ => None,
    }
}

#[cfg(test)]
mod completion_tests {
    use super::{completion_in_flight, PENDING_COMPLETIONS};

    /// The re-issue loop this prevents: a completion waits at the serial signing
    /// gate, the chain's clock therefore still reads the old anchor, the struct
    /// still looks ripe, and the harvest loop grinds the identical proof again.
    /// The claim must be keyed by ANCHOR, not merely by struct: releasing it on
    /// the next cycle is what lets the struct keep earning.
    #[test]
    fn a_queued_completion_claims_only_its_own_cycle() {
        PENDING_COMPLETIONS.insert("5-161258".to_string(), 2_303_353);

        // Same cycle → the loop must not re-issue.
        assert_eq!(completion_in_flight("5-161258"), Some(2_303_353));
        // A struct with nothing in flight is untouched.
        assert_eq!(completion_in_flight("5-999999"), None);
        // The NEXT cycle has a different anchor, so the guard cannot match it
        // and the struct is free to earn again.
        assert_ne!(completion_in_flight("5-161258"), Some(2_303_400));

        PENDING_COMPLETIONS.remove("5-161258");
        assert_eq!(completion_in_flight("5-161258"), None);
    }
}

#[cfg(test)]
mod anchor_tests {
    use super::{anchor_field_for, Anchor};

    #[test]
    fn each_struct_task_type_knows_its_anchor() {
        // Chain v0.21.0: the ore clocks live on the PLANET, shared by every rig
        // on it. Resolving these against the struct reads a permanent 0, which
        // this guard treats as "unknown" and waves through — so pointing them
        // back at a struct field silently disables the staleness check.
        assert_eq!(anchor_field_for("MINE"), Some(Anchor::PlanetOreClock));
        assert_eq!(anchor_field_for("REFINE"), Some(Anchor::PlanetOreClock));
        assert_eq!(
            anchor_field_for("BUILD"),
            Some(Anchor::StructField("blockStartBuild"))
        );
        // RAID's object_id is a fleet, not a struct, so it must NOT be checked
        // here — doing so would abandon every raid proof.
        assert_eq!(anchor_field_for("RAID"), None);
        assert_eq!(anchor_field_for("nonsense"), None);
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

    // No thread here: the task waits in the pool's pending queue and a bounded
    // worker (≤ max_concurrent) picks it up once ripe. Thread-per-task at this
    // point is what drove the process past 1,500 threads at fleet scale.
    pool::enqueue(&app, registry, handle);
    Ok(())
}

/// Release a finished task's registry slot so the worker thread is reclaimed
/// (its retained JoinHandle drops with the TaskHandle instead of lingering as a
/// zombie — one leaked thread per completed proof was the source of the
/// grows-over-time thread/memory bloat). Ptr-eq guard: never evict a NEWER task
/// re-issued for the same struct while this one was running.
fn reap_self(registry: &Arc<TaskRegistry>, pid: &str, handle: &Arc<TaskHandle>) {
    let is_current = registry
        .tasks
        .get(pid)
        .is_some_and(|e| Arc::ptr_eq(e.value(), handle));
    if is_current {
        registry.tasks.remove(pid);
    }
    // Drop any orphaned vplayer-hash mapping (normally removed on completion).
    VPLAYER_HASHES.remove(pid);
}

#[tauri::command]
pub async fn start_hash_task(
    params: TaskParams,
    app: AppHandle,
    registry: State<'_, Arc<TaskRegistry>>,
) -> Result<(), String> {
    // Same path as MCP-started tasks: registry insert + pool enqueue.
    start_hash_task_core(params, app, registry.inner())
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
