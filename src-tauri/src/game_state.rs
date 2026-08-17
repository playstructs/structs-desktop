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
                | "jamming satellite"
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StructTypeInfo {
    pub id: u64,
    pub name: String,
    pub category: Option<String>,
    pub build_difficulty: u64,
    pub ore_mining_difficulty: u64,
    pub ore_refining_difficulty: u64,
    pub passive_draw: Option<f64>,
    pub max_health: Option<f64>,
    // Per-action charge costs (from the chain's StructType record). All optional
    // so a sync that predates these fields degrades gracefully to fallbacks.
    #[serde(default)]
    pub build_charge: Option<u64>,
    #[serde(default)]
    pub activate_charge: Option<u64>,
    #[serde(default)]
    pub move_charge: Option<u64>,
    #[serde(default)]
    pub defend_change_charge: Option<u64>,
    #[serde(default)]
    pub stealth_activate_charge: Option<u64>,
    #[serde(default)]
    pub ore_mining_charge: Option<u64>,
    #[serde(default)]
    pub ore_refining_charge: Option<u64>,
    #[serde(default)]
    pub primary_weapon_charge: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_charge: Option<u64>,
    // Combat targeting bitmasks (Water=2, Land=4, Air=8, Space=16).
    #[serde(default)]
    pub possible_ambit: Option<u64>,
    #[serde(default)]
    pub primary_weapon_ambits: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_ambits: Option<u64>,
    // Combat math fields (for the ruleset matrix + damage simulator). All optional.
    #[serde(default)]
    pub primary_weapon: Option<String>,
    #[serde(default)]
    pub primary_weapon_control: Option<String>,
    #[serde(default)]
    pub primary_weapon_shots: Option<u64>,
    #[serde(default)]
    pub primary_weapon_damage: Option<u64>,
    #[serde(default)]
    pub primary_weapon_recoil_damage: Option<u64>,
    #[serde(default)]
    pub primary_weapon_shot_success_numerator: Option<u64>,
    #[serde(default)]
    pub primary_weapon_shot_success_denominator: Option<u64>,
    #[serde(default)]
    pub primary_weapon_guaranteed_shots: Option<u64>,
    #[serde(default)]
    pub primary_weapon_blockable: Option<bool>,
    #[serde(default)]
    pub primary_weapon_counterable: Option<bool>,
    #[serde(default)]
    pub secondary_weapon: Option<String>,
    #[serde(default)]
    pub secondary_weapon_control: Option<String>,
    #[serde(default)]
    pub secondary_weapon_shots: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_damage: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_recoil_damage: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_shot_success_numerator: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_shot_success_denominator: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_guaranteed_shots: Option<u64>,
    #[serde(default)]
    pub secondary_weapon_blockable: Option<bool>,
    #[serde(default)]
    pub secondary_weapon_counterable: Option<bool>,
    #[serde(default)]
    pub counter_attack: Option<u64>,
    #[serde(default)]
    pub counter_attack_same_ambit: Option<u64>,
    #[serde(default)]
    pub attack_reduction: Option<u64>,
    /// Can attacks made BY this struct be countered at all?
    ///
    /// Struct-level, and it OVERRIDES the per-weapon `*_counterable` flags.
    /// Mobile Artillery declares `attackCounterable: false` while its primary
    /// declares `primaryWeaponCounterable: true`; measured live, the struct-level
    /// flag wins — it shot a surviving same-ambit Tank and took no counter at
    /// all, where a Tank doing the same took 1. That makes it the only hull that
    /// can grind a defended target without attrition (`indirectCombatModule`).
    #[serde(default)]
    pub attack_counterable: Option<bool>,
    #[serde(default)]
    pub post_destruction_damage: Option<u64>,
    #[serde(default)]
    pub has_stealth_system: Option<bool>,
    // ── Defensive / evasion model ──
    // The chain exposes evasion as two rates keyed on the INCOMING weapon's
    // control. e.g. the Battleship's signalJamming is guided 2/3 (66% miss vs
    // guided) and unguided 0/0 (no effect). Without these the simulator treated
    // every shot as landing, which is why guided attacks kept underperforming.
    #[serde(default)]
    pub unit_defenses: Option<String>,
    #[serde(default)]
    pub guided_defensive_success_rate_numerator: Option<u64>,
    #[serde(default)]
    pub guided_defensive_success_rate_denominator: Option<u64>,
    #[serde(default)]
    pub unguided_defensive_success_rate_numerator: Option<u64>,
    #[serde(default)]
    pub unguided_defensive_success_rate_denominator: Option<u64>,
    // Armour-piercing weapons ignore the target's attack_reduction.
    #[serde(default)]
    pub primary_weapon_armour_piercing: Option<bool>,
    #[serde(default)]
    pub secondary_weapon_armour_piercing: Option<bool>,
    // Planetary layer: `lowOrbitBallisticInterceptorNetwork` (Jamming Satellite)
    // gives the whole planet a compounding evade chance vs GUIDED ordnance only.
    #[serde(default)]
    pub planetary_defenses: Option<String>,
    #[serde(default)]
    pub planetary_shield_contribution: Option<u64>,
    /// True on the Command Ship: destroying it while its fleet is away ends the
    /// raid (`attackerDefeated`). The authoritative marker for a decapitation
    /// target — preferred over hardcoding struct type "1".
    #[serde(default)]
    pub trigger_raid_defeat_by_destruction: Option<bool>,
    #[serde(default)]
    pub movable: Option<bool>,

    // ── Cheatsheet copy ──
    // Human-written labels and descriptions for each ability, synced from the
    // game window. They live only on the Guild API's `/struct/type` record,
    // which requires a logged-in session, so the window is the sole path by
    // which they can reach anything else in the app. All optional: an app that
    // has not synced yet must degrade to the enum names, not to "undefined".
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub class_abbreviation: Option<String>,
    #[serde(default)]
    pub default_cosmetic_model_number: Option<String>,
    #[serde(default)]
    pub default_cosmetic_name: Option<String>,
    #[serde(default)]
    pub build_draw: Option<u64>,
    #[serde(default)]
    pub generating_rate: Option<u64>,
    #[serde(default)]
    pub primary_weapon_label: Option<String>,
    #[serde(default)]
    pub primary_weapon_description: Option<String>,
    #[serde(default)]
    pub secondary_weapon_label: Option<String>,
    #[serde(default)]
    pub secondary_weapon_description: Option<String>,
    #[serde(default)]
    pub passive_weaponry: Option<String>,
    #[serde(default)]
    pub passive_weaponry_label: Option<String>,
    #[serde(default)]
    pub passive_weaponry_description: Option<String>,
    #[serde(default)]
    pub unit_defenses_label: Option<String>,
    #[serde(default)]
    pub unit_defenses_description: Option<String>,
    #[serde(default)]
    pub ore_reserve_defenses: Option<String>,
    #[serde(default)]
    pub ore_reserve_defenses_label: Option<String>,
    #[serde(default)]
    pub ore_reserve_defenses_description: Option<String>,
    #[serde(default)]
    pub planetary_defenses_label: Option<String>,
    #[serde(default)]
    pub planetary_defenses_description: Option<String>,
    #[serde(default)]
    pub planetary_mining: Option<String>,
    #[serde(default)]
    pub planetary_refinery: Option<String>,
    #[serde(default)]
    pub power_generation: Option<String>,
    #[serde(default)]
    pub drive_label: Option<String>,
    #[serde(default)]
    pub drive_description: Option<String>,
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
pub async fn sync_game_state(
    state: GameStateSync,
    // Used by the Tier-1/2 autonomous threat responder below (notify / prompt / tx).
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Liveness heartbeat for the watchdog — a stalled sync starves every loop.
    crate::mcp::watchdog::note_sync_ran();
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

    // Player-follows-guild reconciler: if the player's guild (chain-verified)
    // differs from the active infrastructure config, silently switch and
    // reload. Cheap fast path — spawns async LCD verification only on
    // mismatch or slow backstop cadence.
    crate::guild_directory::note_player_guild(
        app_handle.clone(),
        state.guild_id.clone(),
        state.player_id.clone(),
    );

    // Evaluate policies on state transition. Collect events outside the lock so
    // we can push autonomous UI directives without holding the engine write lock
    // across an await.
    let events = {
        use crate::mcp::policy::{StateSnapshot, POLICY_ENGINE};
        let snapshot = StateSnapshot::from_game_state(&state, |_struct_id| false);
        match POLICY_ENGINE.write() {
            Ok(mut engine) => engine.evaluate(snapshot),
            Err(_) => Vec::new(),
        }
    };
    for event in &events {
        eprintln!(
            "[Structs Policy] {} — {} — {}",
            event.policy, event.action, event.detail
        );
        // Pipe into the Team Ops feed. Power problems are the silent
        // planet-opener (offline CMD ⇒ raidable), so they rate Important.
        let sev = if event.policy == "power_alert" && event.action.contains("critical") {
            crate::mcp::board_feed::Severity::Important
        } else {
            crate::mcp::board_feed::Severity::Notice
        };
        crate::mcp::board_feed::push(
            &app_handle,
            sev,
            &event.policy,
            format!("{} — {}", event.action, event.detail),
        );
    }

    // ── Tier 1/2 autonomous threat response ──
    // When this tick's events signal combat/destruction involving us, assess the
    // threat against the enabled combat policies (lock-free), then act with the
    // AppHandle: Tier 2 = fire a real-time native notification + UI toast; Tier 1
    // = per-policy response — "auto" submits the tx within budget, "ask" pops a
    // structs_ui approval prompt and submits only on approval, "notify" just alerts.
    // (Discrete event triggers — combat_mode/activated, struct_destroyed — are
    // emitted once, so this is naturally debounced and won't spam each sync tick.)
    let assessment = {
        use crate::mcp::policy::POLICY_ENGINE;
        POLICY_ENGINE
            .read()
            .ok()
            .and_then(|engine| engine.assess_threats(&events, &state))
    };

    {
        let mut gs = GAME_STATE.write().map_err(|e| e.to_string())?;
        *gs = state;
    }

    if let Some(assess) = assessment {
        let combat_alert_on = {
            use crate::mcp::policy::POLICY_ENGINE;
            POLICY_ENGINE.read().map(|e| e.is_enabled("combat_alert")).unwrap_or(false)
        };
        // Tier 2 — real-time alert (native notification + in-app toast), plus an
        // IMPORTANT feed entry (auto-opens the Team Ops window so the player
        // actually sees it — the feed is invisible while that window is closed).
        if combat_alert_on {
            let title = format!("⚠ Structs: {}", assess.headline);
            let body = if assess.detail.is_empty() {
                "Open Structs to respond.".to_string()
            } else {
                assess.detail.clone()
            };
            tokio::spawn(async move {
                let _ = crate::notifications::send_notification(title, body).await;
            });
            // No main-window toast: the native notification above + this
            // Important feed entry (which can auto-open the Team Ops window if
            // the player opted in) are the alert surfaces. Agent/automation
            // visuals never overlay the game view.
            crate::mcp::board_feed::push(
                &app_handle,
                crate::mcp::board_feed::Severity::Important,
                "combat",
                format!("{} — {}", assess.headline, assess.detail),
            );
        }
        // Tier 1 — per-policy response.
        for r in assess.responses {
            match r.mode.as_str() {
                "auto" => {
                    if let Some((action, args)) = r.action.clone() {
                        let app_a = app_handle.clone();
                        let pol = r.policy.clone();
                        tokio::spawn(async move {
                            // Through tx_retry, not tx_queue directly: an
                            // autonomous combat action must land in the
                            // tx_attempts ledger and feed the AIMD controller
                            // like every other loop-issued transaction.
                            let ctx = format!("policy:{pol}");
                            match crate::mcp::tx_retry::submit_with_retry(&app_a, &action, args, &ctx).await {
                                Ok(r) if r.success => {
                                    eprintln!("[Structs Auto] {} auto-response submitted", pol)
                                }
                                Ok(r) => eprintln!(
                                    "[Structs Auto] {} auto-response rejected: {}",
                                    pol,
                                    r.error.unwrap_or_else(|| "unknown".into())
                                ),
                                Err(e) => eprintln!("[Structs Auto] {} auto-response failed: {}", pol, e),
                            }
                        });
                    }
                }
                "ask" => {
                    let app_p = app_handle.clone();
                    let pol = r.policy.clone();
                    let rec = r.recommendation.clone();
                    let act = r.action.clone();
                    tokio::spawn(async move {
                        let comp = serde_json::json!({
                            "kind": "dialogue",
                            "title": format!("⚡ Agent: {}", pol),
                            "message": rec,
                            "buttons": [
                                {"label": "Approve", "value": "approve"},
                                {"label": "Dismiss", "value": "dismiss"}
                            ]
                        });
                        match crate::mcp::ui_bridge::show_ui(&app_p, "prompt", comp, Some(120)).await {
                            Ok(crate::mcp::ui_bridge::UiOutcome::Answered(v))
                                if v.as_str() == Some("approve") =>
                            {
                                if let Some((action, args)) = act {
                                    let ctx = format!("policy:{pol}");
                                    let _ = crate::mcp::tx_retry::submit_with_retry(&app_p, &action, args, &ctx).await;
                                }
                            }
                            _ => {}
                        }
                    });
                }
                _ => { /* "notify" — covered by the Tier-2 alert above */ }
            }
        }
    }

    // ── Tier 2, team coverage ──
    // The assessment above only sees the PRIMARY player (GAME_STATE). The bait
    // fleet — every virtual player — is the most likely attack target, so scan
    // the grass buffer against the whole team's planets/fleets each tick and fire
    // a native notification + toast when a vplayer is hit. Cheap: team ownership
    // is cached after the first resolve; the buffer scan is in-memory. A persistent
    // high-water mark debounces (first tick only baselines; alerts only on new hits).
    {
        use crate::mcp::policy::POLICY_ENGINE;
        static TEAM_HW: std::sync::LazyLock<std::sync::Mutex<f64>> =
            std::sync::LazyLock::new(|| std::sync::Mutex::new(0.0));
        let combat_alert_on = POLICY_ENGINE
            .read()
            .map(|e| e.is_enabled("combat_alert"))
            .unwrap_or(false);
        if combat_alert_on {
            let since = *TEAM_HW.lock().unwrap();
            let (hw, lines) = crate::mcp::tools::events::poll_team_threats(since).await;
            *TEAM_HW.lock().unwrap() = hw;
            if !lines.is_empty() {
                let n = lines.len();
                let body = lines.into_iter().take(6).collect::<Vec<_>>().join("; ");
                let title = format!("⚠ Structs: {} team threat(s) detected", n);
                let body_n = body.clone();
                tokio::spawn(async move {
                    let _ = crate::notifications::send_notification(title, body_n).await;
                });
                // Vplayer info stays OUT of the main game window: pipe it into
                // the Team Ops feed instead (Important ⇒ the window auto-opens).
                crate::mcp::board_feed::push(
                    &app_handle,
                    crate::mcp::board_feed::Severity::Important,
                    "team",
                    format!("{} team threat(s): {}", n, body),
                );
            }
        }
    }

    // ── Native auto-harvest + auto-build ── (throttled internally; off unless
    // configured) Spawned so a periodic scan never blocks the sync cycle.
    {
        let app_h = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_harvest::tick(&app_h, false).await;
        });
        let app_b = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_build::tick(&app_b, false).await;
        });
        let app_i = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_infuse::tick(&app_i, false).await;
        });
        let app_d = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_defend::tick(&app_d, false).await;
        });
        let app_s = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_sweep::tick(&app_s, false).await;
        });
        // Backfill of primary control over the vplayers. Rides the sync tick
        // rather than the roster sweep on purpose: the roster sweep only runs
        // while the Team Ops window is open, and this grant needs to converge
        // whether or not anyone is looking at the board.
        let app_dg = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::delegation::tick(&app_dg, false).await;
        });
        // Combat loops. auto_response deliberately rides the sync tick at its
        // own 20 s cadence — a raid resolves in about four minutes end to end,
        // and every defensive win on record fired back inside the first two.
        let app_r = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_response::tick(&app_r, false).await;
        });
        let app_rd = app_handle.clone();
        tokio::spawn(async move {
            crate::mcp::auto_raid::tick(&app_rd, false).await;
        });
    }

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
pub async fn notify_hash_complete(
    struct_id: String,
    task_type: String,
    app_handle: tauri::AppHandle,
    registry: tauri::State<'_, std::sync::Arc<crate::hasher::types::TaskRegistry>>,
) -> Result<(), String> {
    use crate::mcp::policy::POLICY_ENGINE;

    eprintln!("[Structs Auto] Hash complete: {} {}", task_type, struct_id);

    // Evaluate inside a tight lock scope, then release before launching any task.
    let auto_refine = {
        if let Ok(mut engine) = POLICY_ENGINE.write() {
            let outcome = engine.evaluate_hash_completion(&task_type, &struct_id);
            for event in &outcome.events {
                eprintln!(
                    "[Structs Policy] {} — {} — {}",
                    event.policy, event.action, event.detail
                );
            }
            outcome.auto_refine
        } else {
            None
        }
    };

    // auto_refine: start the REFINE hash task now that we hold AppHandle + registry.
    if let Some(req) = auto_refine {
        // Never stomp a refine already in flight on this refinery.
        // `start_hash_task_core` CANCELS any task sharing the struct id, so
        // without this guard a completing MINE would kill a live REFINE (e.g.
        // one auto_harvest started when include_primary is on) and restart it.
        // Completed tasks linger in the registry — those we do re-issue.
        if let Some(t) = registry.tasks.get(&req.struct_id) {
            if matches!(
                t.snapshot().status.as_str(),
                "running" | "waiting" | "starting"
            ) {
                eprintln!(
                    "[Structs Auto] auto_refine skipped {} — a refine is already in flight",
                    req.struct_id
                );
                return Ok(());
            }
        }

        // Anchor the proof on the refinery's on-chain blockStartOreRefine, read
        // fresh from the chain. The current block height is NOT a valid anchor —
        // the prefix is {structId}REFINE{blockStartOreRefine}NONCE and the chain
        // rejects anything else (mirrors tools::action::action_refine).
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let block_height = match client.query_entity("struct", &req.struct_id).await {
            Ok(v) => v
                .get("structAttributes")
                .and_then(|x| x.get("blockStartOreRefine"))
                .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0),
            Err(e) => {
                eprintln!(
                    "[Structs Auto] auto_refine lookup failed for {}: {}",
                    req.struct_id, e
                );
                return Ok(());
            }
        };
        if block_height == 0 {
            eprintln!(
                "[Structs Auto] auto_refine skipped {} — blockStartOreRefine=0 (not in a refining cycle yet)",
                req.struct_id
            );
            return Ok(());
        }

        let params = crate::hasher::types::TaskParams::for_ore(
            &req.struct_id,
            "REFINE",
            block_height,
            req.difficulty_target,
        );
        match crate::hasher::start_hash_task_core(params, app_handle.clone(), registry.inner()) {
            Ok(()) => eprintln!(
                "[Structs Auto] auto_refine started REFINE on {} (difficulty {}, block {})",
                req.struct_id, req.difficulty_target, block_height
            ),
            Err(e) => eprintln!("[Structs Auto] auto_refine failed to start: {}", e),
        }
    }

    Ok(())
}

// ── Connection Health Logging ──

/// Mirror a connection-monitor status/remedy message to the terminal AND the
/// persistent telemetry store, so dropped grass/signing connections and
/// auto-reloads are visible after the fact (not just with DevTools open).
#[tauri::command]
pub async fn conn_log(msg: String) -> Result<(), String> {
    crate::mcp::telemetry::tlog("conn", crate::mcp::telemetry::Sev::Notice, &msg);
    Ok(())
}
