use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use crate::game_state::{GameStateSync, GAME_STATE};

const POLICY_FILENAME: &str = "policies.json";

/// A declarative automation policy evaluated on state transitions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub name: String,
    pub enabled: bool,
    pub config: serde_json::Value,
}

/// All policies persisted to disk.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolicyStore {
    pub policies: HashMap<String, Policy>,
}

/// Events emitted by the policy engine when a policy triggers.
#[derive(Debug, Clone, Serialize)]
pub struct PolicyEvent {
    pub policy: String,
    pub action: String,
    pub detail: String,
    pub timestamp: f64,
}

/// A refinery the auto_refine policy wants to start a REFINE task on.
#[derive(Debug, Clone)]
pub struct AutoRefine {
    pub struct_id: String,
    pub difficulty_target: u64,
    pub block_height: u64,
}

/// Result of evaluating hash-completion policies: events to log plus an optional
/// auto-refine request for the caller to launch.
pub struct HashCompletionOutcome {
    pub events: Vec<PolicyEvent>,
    pub auto_refine: Option<AutoRefine>,
}

/// Snapshot of state for delta tracking.
#[derive(Debug, Clone, Default)]
pub struct StateSnapshot {
    /// Map of struct_id -> (status, task_in_progress)
    pub struct_states: HashMap<String, (u64, bool)>,
    pub block_height: u64,
    pub load: f64,
    pub capacity: f64,
    pub stored_ore: f64,
}

impl StateSnapshot {
    pub fn from_game_state(gs: &GameStateSync, has_hash_task: impl Fn(&str) -> bool) -> Self {
        let mut struct_states = HashMap::new();
        for (id, s) in &gs.structs {
            let in_progress = has_hash_task(id);
            struct_states.insert(id.clone(), (s.status, in_progress));
        }
        Self {
            struct_states,
            block_height: gs.current_block_height,
            load: gs.total_load(),
            capacity: gs.total_capacity(),
            stored_ore: gs.stored_ore.unwrap_or(0.0),
        }
    }
}

/// The policy engine. Evaluates policies on state transitions.
pub static POLICY_ENGINE: std::sync::LazyLock<RwLock<PolicyEngine>> =
    std::sync::LazyLock::new(|| RwLock::new(PolicyEngine::new()));

pub struct PolicyEngine {
    pub store: PolicyStore,
    pub previous_state: Option<StateSnapshot>,
    pub event_log: Vec<PolicyEvent>,
    pub combat_mode: bool,
    pub last_combat_event_block: u64,
}

impl PolicyEngine {
    pub fn new() -> Self {
        let store = PolicyStore::load();
        // Set defaults if empty
        let mut engine = Self {
            store,
            previous_state: None,
            event_log: Vec::new(),
            combat_mode: false,
            last_combat_event_block: 0,
        };
        engine.ensure_defaults();
        engine
    }

    fn ensure_defaults(&mut self) {
        // Only policies the engine actually evaluates are seeded as defaults.
        // (never_build_unsafe / auto_defend / sequence_retry were advertised but
        // never wired up — removed to keep `structs_policy list` honest.)
        let defaults = vec![
            ("auto_refine", true, serde_json::json!({})),
            ("power_alert", true, serde_json::json!({"threshold_pct": 80})),
            // Master toggle for agent-driven UI. Enabled by default; the human can
            // turn it off via `structs_policy set agent_ui false`.
            ("agent_ui", true, serde_json::json!({})),
        ];

        for (name, default_enabled, default_config) in defaults {
            if !self.store.policies.contains_key(name) {
                self.store.policies.insert(
                    name.to_string(),
                    Policy {
                        name: name.to_string(),
                        enabled: default_enabled,
                        config: default_config,
                    },
                );
            }
        }
        let _ = self.store.save();
    }

    /// Evaluate all policies against the current vs previous state.
    /// Returns any triggered events.
    pub fn evaluate(&mut self, current: StateSnapshot) -> Vec<PolicyEvent> {
        let mut events = vec![];
        let now = crate::hasher::types::now_millis();

        if let Some(prev) = &self.previous_state {
            // ── Power Alert ──
            if self.is_enabled("power_alert") {
                let threshold = self
                    .store
                    .policies
                    .get("power_alert")
                    .and_then(|p| p.config.get("threshold_pct"))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(80.0);

                if current.capacity > 0.0 {
                    let utilization = current.load / current.capacity * 100.0;
                    let prev_util = if prev.capacity > 0.0 {
                        prev.load / prev.capacity * 100.0
                    } else {
                        0.0
                    };

                    // Alert on crossing the threshold
                    if utilization >= threshold && prev_util < threshold {
                        events.push(PolicyEvent {
                            policy: "power_alert".to_string(),
                            action: "alert".to_string(),
                            detail: format!(
                                "Power utilization crossed {}% — now at {:.0}% ({}/{})",
                                threshold,
                                utilization,
                                current.load,
                                current.capacity
                            ),
                            timestamp: now,
                        });
                    }

                    // Critical alert if offline
                    if current.load > current.capacity && prev.load <= prev.capacity {
                        events.push(PolicyEvent {
                            policy: "power_alert".to_string(),
                            action: "critical".to_string(),
                            detail: "PLAYER OFFLINE — load exceeds capacity! All operations halted."
                                .to_string(),
                            timestamp: now,
                        });
                    }
                }
            }

            // ── Struct state transitions ──
            for (struct_id, &(status, in_progress)) in &current.struct_states {
                let prev_state = prev.struct_states.get(struct_id);

                // Detect: was building (status & 2 == 0), now built (status & 2 != 0)
                if let Some(&(prev_status, _)) = prev_state {
                    if prev_status & 2 == 0 && status & 2 != 0 {
                        events.push(PolicyEvent {
                            policy: "info".to_string(),
                            action: "struct_built".to_string(),
                            detail: format!("Struct {} has finished building", struct_id),
                            timestamp: now,
                        });
                    }

                    // Detect: was online (status & 4 != 0), now offline (status & 4 == 0)
                    if prev_status & 4 != 0 && status & 4 == 0 && status & 32 == 0 {
                        events.push(PolicyEvent {
                            policy: "info".to_string(),
                            action: "struct_offline".to_string(),
                            detail: format!("Struct {} went offline", struct_id),
                            timestamp: now,
                        });
                    }

                    // Detect: destroyed
                    if prev_status & 32 == 0 && status & 32 != 0 {
                        events.push(PolicyEvent {
                            policy: "info".to_string(),
                            action: "struct_destroyed".to_string(),
                            detail: format!("Struct {} was destroyed!", struct_id),
                            timestamp: now,
                        });
                    }
                }
            }
        }

        // ── Combat Mode ──
        // Check event buffer for recent combat events that actually involve
        // the logged-in player. NATS streams events for the whole guild (and
        // sometimes beyond), so a raid on someone else's planet used to flip
        // combat_mode too — fixed here by filtering on the event subject.
        //
        // Subject pattern produced by webapp listeners is `structs.<entity>.<id>`,
        // e.g. `structs.planet.2-5` for a raid on planet 2-5. We accept the event
        // only when that id matches one of our owned entities (planet, fleet, or
        // any struct).
        {
            use crate::mcp::event_buffer;
            use crate::game_state::GAME_STATE;

            // Snapshot the player's owned-entity IDs once, drop the lock before
            // the iter below — avoids holding it across get_recent's own lock.
            let owned: std::collections::HashSet<String> = {
                let gs = GAME_STATE.read().unwrap();
                let mut s = std::collections::HashSet::new();
                if let Some(p) = &gs.planet_id { s.insert(p.clone()); }
                if let Some(f) = &gs.fleet_id { s.insert(f.clone()); }
                for sid in gs.structs.keys() { s.insert(sid.clone()); }
                s
            };

            let involves_me = |subject: &str| -> bool {
                // Pattern is "structs.<entity>.<id>" — take whatever is after the
                // last dot and compare. Defensive against future subject shapes:
                // also check substring containment as a fallback.
                if let Some(id) = subject.rsplit('.').next() {
                    if owned.contains(id) {
                        return true;
                    }
                }
                owned.iter().any(|id| !id.is_empty() && subject.contains(id))
            };

            let combat_events = event_buffer::get_recent(20, None, None);
            let has_combat = combat_events.iter().any(|e| {
                matches!(
                    e.category.as_str(),
                    "raid_status" | "struct_attack" | "fleet_arrive"
                ) && involves_me(&e.subject)
            });

            if has_combat {
                self.last_combat_event_block = current.block_height;
                if !self.combat_mode {
                    self.combat_mode = true;
                    crate::game_state::set_sync_interval(3000);
                    events.push(PolicyEvent {
                        policy: "combat_mode".to_string(),
                        action: "activated".to_string(),
                        detail: "Combat detected — sync interval reduced to 3s".to_string(),
                        timestamp: now,
                    });
                }
            } else if self.combat_mode
                && current.block_height > self.last_combat_event_block + 30
            {
                self.combat_mode = false;
                crate::game_state::set_sync_interval(10000);
                events.push(PolicyEvent {
                    policy: "combat_mode".to_string(),
                    action: "deactivated".to_string(),
                    detail: "No combat for 30 blocks — sync interval restored to 10s".to_string(),
                    timestamp: now,
                });
            }
        }

        // Store events in log (single pass — logged exactly once)
        for event in &events {
            self.event_log.push(event.clone());
            if self.event_log.len() > 500 {
                self.event_log.remove(0);
            }
        }

        // Rotate state
        self.previous_state = Some(current);

        events
    }

    /// Evaluate policies triggered by hash task completion.
    /// Called from game_state::notify_hash_complete.
    ///
    /// Returns the events plus, when `auto_refine` should fire, the refinery to
    /// start a REFINE task on. The caller (a Tauri command) performs the actual
    /// task launch since it holds the AppHandle + TaskRegistry — keeping the lock
    /// scope here minimal and the engine free of UI dependencies.
    pub fn evaluate_hash_completion(
        &mut self,
        task_type: &str,
        struct_id: &str,
    ) -> HashCompletionOutcome {
        let mut events = vec![];
        let mut auto_refine: Option<AutoRefine> = None;
        let now = crate::hasher::types::now_millis();

        // Auto-refine: when MINE completes, auto-start REFINE
        if task_type == "MINE" && self.is_enabled("auto_refine") {
            let gs = GAME_STATE.read().unwrap();

            // Find an online Ore Refinery owned by the player.
            let refinery = gs.structs.iter().find_map(|(id, s)| {
                let t = gs.struct_types.get(&s.struct_type_id.to_string())?;
                if t.name.contains("Refinery") && s.status & 4 != 0 {
                    Some((id.clone(), t.ore_refining_difficulty))
                } else {
                    None
                }
            });

            match refinery {
                Some((refinery_id, difficulty)) if gs.stored_ore.unwrap_or(0.0) > 0.0 => {
                    events.push(PolicyEvent {
                        policy: "auto_refine".to_string(),
                        action: "triggered".to_string(),
                        detail: format!(
                            "Mining complete on {}. Auto-starting refine on {}.",
                            struct_id, refinery_id
                        ),
                        timestamp: now,
                    });
                    auto_refine = Some(AutoRefine {
                        struct_id: refinery_id,
                        difficulty_target: difficulty,
                        block_height: gs.current_block_height,
                    });
                }
                Some((refinery_id, _)) => {
                    events.push(PolicyEvent {
                        policy: "auto_refine".to_string(),
                        action: "skipped".to_string(),
                        detail: format!(
                            "Refinery {} is online but there is no stored ore to refine yet.",
                            refinery_id
                        ),
                        timestamp: now,
                    });
                }
                None => {
                    events.push(PolicyEvent {
                        policy: "auto_refine".to_string(),
                        action: "skipped".to_string(),
                        detail: format!(
                            "Mining complete on {} but no online Ore Refinery found.",
                            struct_id
                        ),
                        timestamp: now,
                    });
                }
            }
        }

        // Log all events
        for event in &events {
            self.event_log.push(event.clone());
            if self.event_log.len() > 500 {
                self.event_log.remove(0);
            }
        }

        HashCompletionOutcome { events, auto_refine }
    }

    pub fn is_enabled(&self, name: &str) -> bool {
        self.store
            .policies
            .get(name)
            .map(|p| p.enabled)
            .unwrap_or(false)
    }

    pub fn set_policy(&mut self, name: &str, enabled: bool, config: Option<serde_json::Value>) {
        let policy = self
            .store
            .policies
            .entry(name.to_string())
            .or_insert_with(|| Policy {
                name: name.to_string(),
                enabled,
                config: serde_json::json!({}),
            });
        policy.enabled = enabled;
        if let Some(c) = config {
            policy.config = c;
        }
        let _ = self.store.save();
    }

    pub fn remove_policy(&mut self, name: &str) -> bool {
        let removed = self.store.policies.remove(name).is_some();
        if removed {
            let _ = self.store.save();
        }
        removed
    }
}

// ── Tauri Command ──

#[tauri::command]
pub async fn list_policies() -> Result<serde_json::Value, String> {
    let engine = POLICY_ENGINE.read().map_err(|e| e.to_string())?;
    let mut policies = serde_json::Map::new();
    for (name, policy) in &engine.store.policies {
        policies.insert(
            name.clone(),
            serde_json::json!({
                "enabled": policy.enabled,
                "config": policy.config,
            }),
        );
    }
    Ok(serde_json::json!(policies))
}

impl PolicyStore {
    fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("structs-app").join(POLICY_FILENAME))
    }

    pub fn load() -> Self {
        let Some(path) = Self::config_path() else {
            return Self::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path().ok_or("Could not determine config directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}
