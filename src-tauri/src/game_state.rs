use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

/// Synced subset of the webapp's gameState, pushed from JS to Rust periodically.
/// The MCP server reads this to auto-fill parameters like block_start and difficulty_target.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GameStateSync {
    pub current_block_height: u64,
    pub player_id: Option<String>,
    pub planet_id: Option<String>,
    pub fleet_id: Option<String>,
    pub wallet_address: Option<String>,
    pub player_name: Option<String>,
    pub guild_id: Option<String>,
    pub alpha: Option<f64>,
    pub ore: Option<f64>,
    pub stored_ore: Option<f64>,
    pub load: Option<f64>,
    pub structs_load: Option<f64>,
    pub capacity: Option<f64>,
    pub capacity_secondary: Option<f64>,
    /// Last action block height — used to calculate charge
    pub last_action_block_height: Option<u64>,
    /// Fleet status: "onStation" or "away"
    pub fleet_status: Option<String>,
    /// Remaining ore on current planet
    pub planet_ore: Option<f64>,
    /// Map of struct_id -> StructInfo
    pub structs: HashMap<String, StructInfo>,
    /// Map of struct_type_id -> StructTypeInfo
    pub struct_types: HashMap<String, StructTypeInfo>,
}

impl GameStateSync {
    /// Total load = load (allocated out) + structs_load (struct consumption)
    pub fn total_load(&self) -> f64 {
        self.load.unwrap_or(0.0) + self.structs_load.unwrap_or(0.0)
    }

    /// Total capacity = capacity (personal) + capacity_secondary (substation)
    pub fn total_capacity(&self) -> f64 {
        self.capacity.unwrap_or(0.0) + self.capacity_secondary.unwrap_or(0.0)
    }

    /// Calculate current charge (1 per block since last action)
    pub fn get_charge(&self) -> u64 {
        if self.current_block_height == 0 {
            return 0;
        }
        match self.last_action_block_height {
            Some(last) if last < self.current_block_height => {
                self.current_block_height - (last + 1)
            }
            _ => 0,
        }
    }

    /// Estimate blocks until target charge is reached
    pub fn blocks_until_charge(&self, target: u64) -> u64 {
        let current = self.get_charge();
        if current >= target {
            0
        } else {
            target - current
        }
    }

    /// Check if a struct type has reached its per-player limit
    pub fn count_structs_of_type(&self, type_name: &str) -> usize {
        self.structs
            .values()
            .filter(|s| {
                s.struct_type_name
                    .as_deref()
                    .map(|n| n.eq_ignore_ascii_case(type_name))
                    .unwrap_or(false)
                    && s.status & 32 == 0 // not destroyed
            })
            .count()
    }

    /// Struct types limited to 1 per player
    pub fn is_limited_type(type_name: &str) -> bool {
        matches!(
            type_name.to_lowercase().as_str(),
            "command ship"
                | "ore extractor"
                | "ore refinery"
                | "field generator"
                | "continental power plant"
                | "world engine"
                | "planetary defense cannon"
        )
    }

    /// Get the difficulty target for a given struct and task type.
    pub fn get_difficulty_for_struct(&self, struct_id: &str, task_type: &str) -> Option<u64> {
        let struct_info = self.structs.get(struct_id)?;
        let struct_type = self.struct_types.get(&struct_info.struct_type_id.to_string())?;
        match task_type {
            "BUILD" => Some(struct_type.build_difficulty),
            "MINE" => Some(struct_type.ore_mining_difficulty),
            "REFINE" => Some(struct_type.ore_refining_difficulty),
            _ => None,
        }
    }

    /// Get struct type name for a given struct
    pub fn get_struct_type_name(&self, struct_id: &str) -> Option<String> {
        let struct_info = self.structs.get(struct_id)?;
        let struct_type = self.struct_types.get(&struct_info.struct_type_id.to_string())?;
        Some(struct_type.name.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructInfo {
    pub id: String,
    pub struct_type_id: u64,
    pub struct_type_name: Option<String>,
    pub owner: String,
    pub status: u64,
    pub location_type: Option<String>,
    pub location_id: Option<String>,
    pub operating_ambit: Option<String>,
    pub health: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructTypeInfo {
    pub id: u64,
    pub name: String,
    pub category: Option<String>,
    pub build_difficulty: u64,
    pub ore_mining_difficulty: u64,
    pub ore_refining_difficulty: u64,
    pub passive_draw: Option<f64>,
    pub max_health: Option<f64>,
}

/// Global synced game state, protected by RwLock for concurrent access
/// from both Tauri commands (write) and MCP server (read).
pub static GAME_STATE: std::sync::LazyLock<RwLock<GameStateSync>> =
    std::sync::LazyLock::new(|| {
        let mut gs = GameStateSync::default();
        // Load persisted player ID so it's available before first JS sync
        if let Some(path) = dirs::config_dir().map(|d| d.join("structs-app").join("last_player.txt")) {
            if let Ok(pid) = std::fs::read_to_string(&path) {
                let pid = pid.trim().to_string();
                if !pid.is_empty() {
                    eprintln!("[Structs Sync] Loaded persisted player ID: {}", pid);
                    gs.player_id = Some(pid);
                }
            }
        }
        RwLock::new(gs)
    });


// ── Tauri Command ──

static SYNC_LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub async fn sync_game_state(state: GameStateSync) -> Result<(), String> {
    if !SYNC_LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        eprintln!(
            "[Structs Sync] Connected: player={:?}, block={}, structs={}, types={}",
            state.player_id, state.current_block_height, state.structs.len(), state.struct_types.len()
        );
        // Persist player ID so it's available immediately on next launch
        if let Some(pid) = &state.player_id {
            let _ = std::fs::create_dir_all(
                dirs::config_dir()
                    .map(|d| d.join("structs-app"))
                    .unwrap_or_default(),
            );
            if let Some(path) = dirs::config_dir().map(|d| d.join("structs-app").join("last_player.txt")) {
                let _ = std::fs::write(&path, pid);
            }
        }
    }

    // Evaluate policies on state transition
    {
        use crate::mcp::policy::{StateSnapshot, POLICY_ENGINE};
        let snapshot = StateSnapshot::from_game_state(&state, |_struct_id| false);
        if let Ok(mut engine) = POLICY_ENGINE.write() {
            let events = engine.evaluate(snapshot);
            for event in &events {
                eprintln!(
                    "[Structs Policy] {} — {} — {}",
                    event.policy, event.action, event.detail
                );
            }
        }
    }

    let mut gs = GAME_STATE.write().map_err(|e| e.to_string())?;
    *gs = state;
    Ok(())
}

// ── Sync Interval Control ──

static SYNC_INTERVAL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(10000);

#[tauri::command]
pub async fn get_sync_interval() -> Result<u64, String> {
    Ok(SYNC_INTERVAL_MS.load(std::sync::atomic::Ordering::Relaxed))
}

pub fn set_sync_interval(ms: u64) {
    let clamped = ms.clamp(2000, 30000);
    SYNC_INTERVAL_MS.store(clamped, std::sync::atomic::Ordering::Relaxed);
}

/// Snapshot of the current sync interval for non-async callers (e.g. the
/// Rust-driven sync-tick loop). Returns the same value as `get_sync_interval`.
pub fn current_sync_interval_ms() -> u64 {
    SYNC_INTERVAL_MS.load(std::sync::atomic::Ordering::Relaxed)
}

// ── Hash Completion Notification ──

#[tauri::command]
pub async fn notify_hash_complete(struct_id: String, task_type: String) -> Result<(), String> {
    use crate::mcp::policy::POLICY_ENGINE;

    eprintln!("[Structs Auto] Hash complete: {} {}", task_type, struct_id);

    if let Ok(mut engine) = POLICY_ENGINE.write() {
        let events = engine.evaluate_hash_completion(&task_type, &struct_id);
        for event in &events {
            eprintln!(
                "[Structs Policy] {} — {} — {}",
                event.policy, event.action, event.detail
            );
        }
    }
    Ok(())
}

// ── Connection Health Logging ──

/// Mirror a connection-monitor status/remedy message to the terminal, so dropped
/// grass/signing connections and auto-reloads are visible even with DevTools closed.
#[tauri::command]
pub async fn conn_log(msg: String) -> Result<(), String> {
    eprintln!("[Structs Conn] {}", msg);
    Ok(())
}
