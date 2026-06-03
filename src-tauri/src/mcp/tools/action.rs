use rmcp::model::Content;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::game_state::{StructTypeInfo, GAME_STATE};
use crate::hasher;
use crate::hasher::types::{TaskParams, TaskRegistry};
use crate::mcp::error_translator::translate_error;
use crate::mcp::tx_queue;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct ActionParams {
    /// Action to perform: explore, build, mine, refine, attack, defend, activate,
    /// deactivate, move_fleet, transfer, deploy.
    pub action: String,
    /// Action-specific arguments
    #[serde(default)]
    pub args: Value,
}

pub async fn execute(
    app_handle: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    params: ActionParams,
) -> Vec<Content> {
    let (player_id, _block_height) = {
        let gs = GAME_STATE.read().unwrap();
        (gs.player_id.clone().unwrap_or_default(), gs.current_block_height)
    };

    if player_id.is_empty() {
        return vec![Content::text(
            "Error: gameState not synced yet. Wait for the app to load.",
        )];
    }

    match params.action.as_str() {
        "explore" => action_explore(app_handle, &player_id, &params.args).await,
        "mine" => action_mine(app_handle, registry, &params.args).await,
        "refine" => action_refine(app_handle, registry, &params.args).await,
        "build" => action_build(app_handle, &player_id, &params.args).await,
        "activate" => action_simple(app_handle, "struct_activate", &params.args).await,
        "deactivate" => action_simple(app_handle, "struct_deactivate", &params.args).await,
        "attack" => action_attack(app_handle, &params.args).await,
        "defend" => action_defend(app_handle, &params.args).await,
        "move_fleet" => action_move_fleet(app_handle, &params.args).await,
        "transfer" => action_transfer(app_handle, &params.args).await,
        "deploy" => action_deploy(app_handle, &params.args).await,
        other => vec![Content::text(format!(
            "Unknown action '{}'. Available: explore, mine, refine, build, activate, deactivate, attack, defend, move_fleet, transfer, deploy",
            other
        ))],
    }
}

async fn action_explore(app_handle: &tauri::AppHandle, player_id: &str, args: &Value) -> Vec<Content> {
    let fleet_id = {
        let gs = GAME_STATE.read().unwrap();
        gs.fleet_id.clone().unwrap_or_default()
    };

    if fleet_id.is_empty() {
        return vec![Content::text("Error: No fleet found for this player.")];
    }

    // Optional planet name (v1.11.0). Validated chain-side; passed through only when set.
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");

    let mut tx_args = json!({
        "action_type": "planet_explore",
        "player_id": player_id,
    });
    if !name.is_empty() {
        tx_args["name"] = json!(name);
    }

    match tx_queue::submit_tx(app_handle, "planet_explore".to_string(), tx_args).await {
        Ok(resp) if resp.success => {
            let named = if name.is_empty() { String::new() } else { format!(" (name: {})", name) };
            vec![Content::text(format!(
                "Planet exploration initiated for player {}{}.\nTx hash: {}",
                player_id,
                named,
                resp.tx_hash.unwrap_or_else(|| "pending".to_string())
            ))]
        }
        Ok(resp) => vec![Content::text(format!(
            "Explore failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_mine(
    app_handle: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    args: &Value,
) -> Vec<Content> {
    let struct_id = args
        .get("struct_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if struct_id.is_empty() {
        return vec![Content::text(
            "Error: struct_id required. Provide the Ore Extractor's ID (e.g., '5-1509').",
        )];
    }

    // Preflight and get difficulty
    let (type_name, difficulty_target, block_height) = {
        let gs = GAME_STATE.read().unwrap();
        let block_height = gs.current_block_height;
        if let Some(s) = gs.structs.get(struct_id) {
            let type_info = gs.struct_types.get(&s.struct_type_id.to_string());
            let type_name = type_info.map(|t| t.name.clone()).unwrap_or_else(|| "Unknown".to_string());
            if !type_name.contains("Extractor") {
                return vec![Content::text(format!(
                    "Error: {} is a {}, not an Ore Extractor.",
                    struct_id, type_name
                ))];
            }
            if s.status & 4 == 0 {
                return vec![Content::text(format!(
                    "Error: {} is not online. Activate it first.",
                    struct_id
                ))];
            }
            // Preflight: charge (mining completion costs ore_mining_charge, default 20)
            let cost = charge_cost_for_type(type_info, "mine", "");
            let charge = gs.get_charge();
            if charge < cost {
                let blocks_needed = gs.blocks_until_charge(cost);
                return vec![Content::text(format!(
                    "BLOCKED: Need {} charge to mine, you have {}. Ready in ~{}s (~{} blocks).",
                    cost, charge, blocks_needed * 6, blocks_needed
                ))];
            }
            let difficulty = type_info.map(|t| t.ore_mining_difficulty).unwrap_or(14000);
            (type_name, difficulty, block_height)
        } else {
            return vec![Content::text(format!("Error: Struct {} not found in gameState.", struct_id))];
        }
    };

    // Start hash task directly — no initiation tx needed for mining
    let prefix = format!("{}MINE{}NONCE", struct_id, block_height);
    let nonce_start = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        % 10_000_000_000) as u64;
    let now_ms = crate::hasher::types::now_millis();

    let task_params = TaskParams {
        object_id: struct_id.to_string(),
        target_id: None,
        object_type: Some("struct".to_string()),
        task_type: Some("MINE".to_string()),
        identity: None,
        prefix,
        postfix: String::new(),
        nonce_start,
        nonce_current: nonce_start,
        iterations: 0,
        iterations_since_last_start: 0,
        difficulty_start: None,
        difficulty_target,
        block_start: block_height,
        block_checkpoint: block_height,
        block_checkpoint_time: now_ms,
        block_current_estimated: Some(block_height),
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
            vec![Content::text(format!(
                "Mining started on {} ({}) using {}.\nDifficulty: {}, block: {}\nHash task running in the background — the completion tx is submitted automatically when the proof is found. Track it with structs_hash {{ command: \"list\" }}.",
                struct_id, type_name, engine, difficulty_target, block_height
            ))]
        }
        Err(e) => vec![Content::text(format!("Error starting mine hash: {}", e))],
    }
}

async fn action_refine(
    app_handle: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    args: &Value,
) -> Vec<Content> {
    let struct_id = args
        .get("struct_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if struct_id.is_empty() {
        return vec![Content::text(
            "Error: struct_id required. Provide the Ore Refinery's ID (e.g., '5-1510').",
        )];
    }

    let (type_name, difficulty_target, block_height) = {
        let gs = GAME_STATE.read().unwrap();
        let block_height = gs.current_block_height;
        if let Some(s) = gs.structs.get(struct_id) {
            let type_info = gs.struct_types.get(&s.struct_type_id.to_string());
            let type_name = type_info.map(|t| t.name.clone()).unwrap_or_else(|| "Unknown".to_string());
            if !type_name.contains("Refinery") {
                return vec![Content::text(format!(
                    "Error: {} is a {}, not an Ore Refinery.",
                    struct_id, type_name
                ))];
            }
            if s.status & 4 == 0 {
                return vec![Content::text(format!(
                    "Error: {} is not online. Activate it first.",
                    struct_id
                ))];
            }
            if gs.stored_ore.unwrap_or(0.0) <= 0.0 {
                return vec![Content::text(format!(
                    "Error: No stored ore to refine. Mine ore first (refinery {} has nothing to process).",
                    struct_id
                ))];
            }
            // Preflight: charge (refining completion costs ore_refining_charge, default 20)
            let cost = charge_cost_for_type(type_info, "refine", "");
            let charge = gs.get_charge();
            if charge < cost {
                let blocks_needed = gs.blocks_until_charge(cost);
                return vec![Content::text(format!(
                    "BLOCKED: Need {} charge to refine, you have {}. Ready in ~{}s (~{} blocks).",
                    cost, charge, blocks_needed * 6, blocks_needed
                ))];
            }
            let difficulty = type_info.map(|t| t.ore_refining_difficulty).unwrap_or(28000);
            (type_name, difficulty, block_height)
        } else {
            return vec![Content::text(format!("Error: Struct {} not found.", struct_id))];
        }
    };

    let prefix = format!("{}REFINE{}NONCE", struct_id, block_height);
    let nonce_start = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        % 10_000_000_000) as u64;
    let now_ms = crate::hasher::types::now_millis();

    let task_params = TaskParams {
        object_id: struct_id.to_string(),
        target_id: None,
        object_type: Some("struct".to_string()),
        task_type: Some("REFINE".to_string()),
        identity: None,
        prefix,
        postfix: String::new(),
        nonce_start,
        nonce_current: nonce_start,
        iterations: 0,
        iterations_since_last_start: 0,
        difficulty_start: None,
        difficulty_target,
        block_start: block_height,
        block_checkpoint: block_height,
        block_checkpoint_time: now_ms,
        block_current_estimated: Some(block_height),
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
            vec![Content::text(format!(
                "Refining started on {} ({}) using {}.\nDifficulty: {}, block: {}",
                struct_id, type_name, engine, difficulty_target, block_height
            ))]
        }
        Err(e) => vec![Content::text(format!("Error starting refine hash: {}", e))],
    }
}

async fn action_build(
    app_handle: &tauri::AppHandle,
    player_id: &str,
    args: &Value,
) -> Vec<Content> {
    let struct_type = args
        .get("struct_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let ambit = args
        .get("ambit")
        .and_then(|v| v.as_str())
        .unwrap_or("space");
    let slot = args.get("slot").and_then(|v| v.as_u64()).unwrap_or(0);

    if struct_type.is_empty() {
        return vec![Content::text(
            "Error: struct_type required (e.g., 'Battleship', 'Ore Extractor', 'Field Generator').",
        )];
    }

    // Look up struct type ID and run preflights
    let (type_id, build_difficulty, utilization, power_warning) = {
        let gs = GAME_STATE.read().unwrap();
        let type_info = gs
            .struct_types
            .values()
            .find(|t| t.name.eq_ignore_ascii_case(struct_type));
        let (type_id, type_name_resolved, build_difficulty, passive_draw) = match type_info {
            Some(t) => (t.id, t.name.clone(), t.build_difficulty, t.passive_draw.unwrap_or(0.0)),
            None => {
                let available: Vec<String> = gs.struct_types.values().map(|t| t.name.clone()).collect();
                return vec![Content::text(format!(
                    "Error: Unknown struct type '{}'. Available: {}",
                    struct_type,
                    available.join(", ")
                ))];
            }
        };

        // Preflight: struct limit (1 per player for certain types)
        if crate::game_state::GameStateSync::is_limited_type(&type_name_resolved) {
            let count = gs.count_structs_of_type(&type_name_resolved);
            if count >= 1 {
                return vec![Content::text(format!(
                    "BLOCKED: You already have a {} (limit 1 per player).",
                    type_name_resolved
                ))];
            }
        }

        // Preflight: charge (data-driven build cost, genesis default 8)
        let build_charge_cost = charge_cost_for_type(type_info, "build", "");
        let charge = gs.get_charge();
        if charge < build_charge_cost {
            let blocks_needed = gs.blocks_until_charge(build_charge_cost);
            return vec![Content::text(format!(
                "BLOCKED: Need {} charge to build, you have {}. Ready in ~{}s (~{} blocks).",
                build_charge_cost, charge, blocks_needed * 6, blocks_needed
            ))];
        }

        // Preflight: power budget
        let load = gs.total_load();
        let capacity = gs.total_capacity();
        let new_load = load + passive_draw;
        if capacity > 0.0 && new_load > capacity {
            return vec![Content::text(format!(
                "BLOCKED: Building {} would push load to {}/{} — you'd go offline!\nDeactivate something first or increase power capacity.",
                type_name_resolved,
                format_power(new_load),
                format_power(capacity)
            ))];
        }
        let util = if capacity > 0.0 { new_load / capacity * 100.0 } else { 0.0 };
        (type_id, build_difficulty, util, util > 80.0)
    };

    let warning = if power_warning {
        format!("\nWarning: Power utilization will be {:.0}% after build.", utilization)
    } else {
        String::new()
    };

    let tx_args = json!({
        "action_type": "struct_build_initiate",
        "player_id": player_id,
        "struct_type_id": type_id,
        "operating_ambit": ambit,
        "slot": slot,
    });

    match tx_queue::submit_tx(app_handle, "struct_build_initiate".to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "{} build initiated in {} (slot {}). Build difficulty: {}.\nHash will start automatically when chain confirms.{}\nTx hash: {}",
            struct_type,
            ambit,
            slot,
            build_difficulty,
            warning,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Build failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_attack(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let attacker_id = args
        .get("attacker_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let target_id = args
        .get("target_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let weapon = args
        .get("weapon")
        .and_then(|v| v.as_str())
        .unwrap_or("primary");

    if attacker_id.is_empty() || target_id.is_empty() {
        return vec![Content::text(
            "Error: attacker_id and target_id required.",
        )];
    }

    // Preflight: charge + weapon-ambit reachability.
    {
        use crate::mcp::tools::format::{ambit_bit, decode_ambits};
        let gs = GAME_STATE.read().unwrap();
        if let Some(att) = gs.structs.get(attacker_id) {
            let t = gs.struct_types.get(&att.struct_type_id.to_string());
            // Charge
            let cost = charge_cost_for_type(t, "attack", weapon);
            let charge = gs.get_charge();
            if charge < cost {
                let blocks_needed = gs.blocks_until_charge(cost);
                return vec![Content::text(format!(
                    "BLOCKED: Need {} charge to attack ({} weapon), you have {}. Ready in ~{}s (~{} blocks).",
                    cost, weapon, charge, blocks_needed * 6, blocks_needed
                ))];
            }
            // Ambit reachability (only when we know both masks)
            let weapon_mask = if weapon.eq_ignore_ascii_case("secondary") {
                t.and_then(|t| t.secondary_weapon_ambits)
            } else {
                t.and_then(|t| t.primary_weapon_ambits)
            };
            let target_bit = gs
                .structs
                .get(target_id)
                .and_then(|s| s.operating_ambit.as_deref())
                .map(ambit_bit);
            if let (Some(mask), Some(bit)) = (weapon_mask, target_bit) {
                if bit != 0 && mask & bit == 0 {
                    return vec![Content::text(format!(
                        "BLOCKED: {}'s {} weapon reaches [{}] but target {} is in a different ambit. Pick a target this weapon can hit (or use intel valid_targets with attacker={}).",
                        attacker_id, weapon, decode_ambits(mask), target_id, attacker_id
                    ))];
                }
            }
        }
    }

    let tx_args = json!({
        "action_type": "struct_attack",
        "operating_struct_id": attacker_id,
        "target_struct_id": target_id,
        "weapon_system": weapon,
    });

    match tx_queue::submit_tx(app_handle, "struct_attack".to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Attack executed: {} → {} (weapon: {})\nTx hash: {}",
            attacker_id,
            target_id,
            weapon,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Attack failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_defend(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let defender_id = args
        .get("defender_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let protected_id = args
        .get("protected_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if defender_id.is_empty() || protected_id.is_empty() {
        return vec![Content::text(
            "Error: defender_id and protected_id required.",
        )];
    }

    if let Some(blocked) = struct_charge_preflight(defender_id, "defend", "") {
        return vec![blocked];
    }

    let tx_args = json!({
        "action_type": "struct_defense_set",
        "defender_struct_id": defender_id,
        "protected_struct_id": protected_id,
    });

    match tx_queue::submit_tx(app_handle, "struct_defense_set".to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Defense set: {} now defending {}\nTx hash: {}",
            defender_id,
            protected_id,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Defense failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_move_fleet(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let destination = args
        .get("destination")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if destination.is_empty() {
        return vec![Content::text(
            "Error: destination (planet ID) required.",
        )];
    }

    let fleet_id = {
        let gs = GAME_STATE.read().unwrap();
        gs.fleet_id.clone().unwrap_or_default()
    };

    let tx_args = json!({
        "action_type": "fleet_move",
        "fleet_id": fleet_id,
        "destination_id": destination,
    });

    match tx_queue::submit_tx(app_handle, "fleet_move".to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Fleet {} moving to planet {}\nTx hash: {}",
            fleet_id,
            destination,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Fleet move failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_transfer(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let to_address = args
        .get("to")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let amount = args
        .get("amount")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if to_address.is_empty() || amount.is_empty() {
        return vec![Content::text(
            "Error: 'to' (address) and 'amount' (e.g., '1000000ualpha') required.",
        )];
    }

    let from_address = {
        let gs = GAME_STATE.read().unwrap();
        gs.wallet_address.clone().unwrap_or_default()
    };

    let tx_args = json!({
        "action_type": "bank_send",
        "from_address": from_address,
        "to_address": to_address,
        "amount": amount,
    });

    match tx_queue::submit_tx(app_handle, "bank_send".to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Transfer sent: {} to {}\nTx hash: {}",
            amount,
            to_address,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Transfer failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_deploy(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let struct_id = args
        .get("struct_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let planet_id = args
        .get("planet_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let ambit = args
        .get("ambit")
        .and_then(|v| v.as_str())
        .unwrap_or("space");
    let slot = args.get("slot").and_then(|v| v.as_u64()).unwrap_or(0);

    if struct_id.is_empty() {
        return vec![Content::text("Error: struct_id required.")];
    }

    if let Some(blocked) = struct_charge_preflight(struct_id, "deploy", "") {
        return vec![blocked];
    }

    let tx_args = json!({
        "action_type": "struct_move",
        "struct_id": struct_id,
        "location_type": "planet",
        "ambit": ambit,
        "slot": slot,
    });

    match tx_queue::submit_tx(app_handle, "struct_move".to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Struct {} deployed to {} slot {}\nTx hash: {}",
            struct_id,
            ambit,
            slot,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Deploy failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_simple(
    app_handle: &tauri::AppHandle,
    action_type: &str,
    args: &Value,
) -> Vec<Content> {
    let struct_id = args
        .get("struct_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if struct_id.is_empty() {
        return vec![Content::text("Error: struct_id required.")];
    }

    // activate/deactivate both cost activateCharge (genesis default 1)
    if let Some(blocked) = struct_charge_preflight(struct_id, "activate", "") {
        return vec![blocked];
    }

    let tx_args = json!({
        "action_type": action_type,
        "struct_id": struct_id,
    });

    match tx_queue::submit_tx(app_handle, action_type.to_string(), tx_args).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "{} on {} succeeded.\nTx hash: {}",
            action_type,
            struct_id,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "{} failed: {}",
            action_type,
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

/// Required charge for an action against a given struct type. Reads the cost
/// from the synced StructType record, falling back to genesis defaults when the
/// field is absent (e.g. a sync that predates the widened struct-type fields).
fn charge_cost_for_type(t: Option<&StructTypeInfo>, action: &str, weapon: &str) -> u64 {
    match action {
        "build" => t.and_then(|t| t.build_charge).unwrap_or(8),
        "deploy" => t.and_then(|t| t.move_charge).unwrap_or(8),
        "activate" | "deactivate" => t.and_then(|t| t.activate_charge).unwrap_or(1),
        "defend" => t.and_then(|t| t.defend_change_charge).unwrap_or(1),
        "mine" => t.and_then(|t| t.ore_mining_charge).unwrap_or(20),
        "refine" => t.and_then(|t| t.ore_refining_charge).unwrap_or(20),
        "attack" => {
            if weapon.eq_ignore_ascii_case("secondary") {
                t.and_then(|t| t.secondary_weapon_charge).unwrap_or(1)
            } else {
                t.and_then(|t| t.primary_weapon_charge).unwrap_or(1)
            }
        }
        _ => 0,
    }
}

/// Charge preflight for an action performed by a specific struct. Compares the
/// action's required charge against the player's built-up charge bar
/// (`get_charge`). Returns the BLOCKED message on shortfall, else None.
/// Returns None when the struct is unknown so the caller's own not-found path
/// handles it.
fn struct_charge_preflight(struct_id: &str, action: &str, weapon: &str) -> Option<Content> {
    let gs = GAME_STATE.read().unwrap();
    let s = gs.structs.get(struct_id)?;
    let cost = charge_cost_for_type(
        gs.struct_types.get(&s.struct_type_id.to_string()),
        action,
        weapon,
    );
    let charge = gs.get_charge();
    if charge < cost {
        let blocks_needed = gs.blocks_until_charge(cost);
        Some(Content::text(format!(
            "BLOCKED: Need {} charge to {}, you have {}. Ready in ~{}s (~{} blocks).",
            cost, action, charge, blocks_needed * 6, blocks_needed
        )))
    } else {
        None
    }
}

fn format_power(milliwatts: f64) -> String {
    let abs = milliwatts.abs();
    if abs >= 1e6 {
        format!("{:.1}KW", milliwatts / 1e6)
    } else if abs >= 1e3 {
        format!("{:.1}W", milliwatts / 1e3)
    } else {
        format!("{:.0}mW", milliwatts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_type() -> StructTypeInfo {
        StructTypeInfo {
            id: 1,
            name: "Test".to_string(),
            category: None,
            build_difficulty: 0,
            ore_mining_difficulty: 0,
            ore_refining_difficulty: 0,
            passive_draw: None,
            max_health: None,
            build_charge: None,
            activate_charge: None,
            move_charge: None,
            defend_change_charge: None,
            stealth_activate_charge: None,
            ore_mining_charge: None,
            ore_refining_charge: None,
            primary_weapon_charge: None,
            secondary_weapon_charge: None,
            possible_ambit: None,
            primary_weapon_ambits: None,
            secondary_weapon_ambits: None,
        }
    }

    #[test]
    fn charge_falls_back_to_genesis_defaults_when_unknown() {
        // No struct-type data at all.
        assert_eq!(charge_cost_for_type(None, "build", ""), 8);
        assert_eq!(charge_cost_for_type(None, "deploy", ""), 8);
        assert_eq!(charge_cost_for_type(None, "activate", ""), 1);
        assert_eq!(charge_cost_for_type(None, "deactivate", ""), 1);
        assert_eq!(charge_cost_for_type(None, "defend", ""), 1);
        assert_eq!(charge_cost_for_type(None, "mine", ""), 20);
        assert_eq!(charge_cost_for_type(None, "refine", ""), 20);
        assert_eq!(charge_cost_for_type(None, "attack", "primary"), 1);
        assert_eq!(charge_cost_for_type(None, "attack", "secondary"), 1);
        // A type record present but missing the field also falls back.
        let t = empty_type();
        assert_eq!(charge_cost_for_type(Some(&t), "build", ""), 8);
    }

    #[test]
    fn charge_reads_from_struct_type_when_present() {
        let mut t = empty_type();
        t.build_charge = Some(12);
        t.primary_weapon_charge = Some(20);
        t.secondary_weapon_charge = Some(8);
        t.ore_mining_charge = Some(20);
        assert_eq!(charge_cost_for_type(Some(&t), "build", ""), 12);
        assert_eq!(charge_cost_for_type(Some(&t), "attack", "primary"), 20);
        assert_eq!(charge_cost_for_type(Some(&t), "attack", "secondary"), 8);
        assert_eq!(charge_cost_for_type(Some(&t), "mine", ""), 20);
    }
}
