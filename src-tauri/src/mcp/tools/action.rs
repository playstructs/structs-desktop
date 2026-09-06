use rmcp::model::Content;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::game_state::{StructTypeInfo, GAME_STATE};
use crate::hasher;
use crate::hasher::types::{TaskParams, TaskRegistry};
use crate::mcp::error_translator::translate_error;
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
        "raid" => action_raid(app_handle, registry, &params.args).await,
        "update_primary_reactor" => action_update_primary_reactor(app_handle, &params.args).await,
        "resync" => action_resync(app_handle, &params.args),
        other => vec![Content::text(format!(
            "Unknown action '{}'. Available: explore, mine, refine, build, activate, deactivate, attack, defend, move_fleet, transfer, deploy, raid, update_primary_reactor, resync",
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

    match crate::mcp::tx_retry::submit_once(app_handle, "planet_explore", tx_args, "mcp:planet_explore").await {
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
    let (type_name, difficulty_target) = {
        let gs = GAME_STATE.read().unwrap();
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
            // No charge preflight here: charge is consumed at the COMPLETE tx (auto-
            // submitted ~17h later when the proof lands), not at hash start — and the
            // signing queue schedules that itself. Gating the hash start on current
            // charge was premature.
            let difficulty = type_info.map(|t| t.ore_mining_difficulty).unwrap_or(14000);
            (type_name, difficulty)
        } else {
            return vec![Content::text(format!("Error: Struct {} not found in gameState.", struct_id))];
        }
    };

    // The mine proof anchors on the PLANET's shared mine clock — NOT the current
    // block, and (since chain v0.21.0) no longer the extractor's own attribute,
    // which now permanently reads 0. Read it from the chain; anything else
    // yields a proof the chain rejects ({structId}MINE{blockStartOreMine}NONCE
    // — see docs hashing.md).
    let block_start = {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let planet_id = match client.query_entity("struct", struct_id).await {
            // A planetary rig's locationId IS its planet id.
            Ok(v) => v
                .get("Struct")
                .and_then(|s| s.get("locationId"))
                .and_then(|l| l.as_str())
                .map(str::to_string),
            Err(e) => return vec![Content::text(format!("mine: struct {} lookup failed: {}", struct_id, e))],
        };
        let Some(planet_id) = planet_id else {
            return vec![Content::text(format!(
                "mine: {} has no planet location — only a planetary extractor can mine.",
                struct_id
            ))];
        };
        match client.query_entity("planet", &planet_id).await {
            Ok(p) => crate::mcp::loop_util::planet_ore_anchor(Some(&p), crate::mcp::types::TaskType::Mine),
            Err(e) => {
                return vec![Content::text(format!("mine: planet {} lookup failed: {}", planet_id, e))]
            }
        }
    };
    if block_start == 0 {
        return vec![Content::text(format!(
            "mine: {}'s planet has no mine clock running (blockStartOreMine=0) — bring an extractor online there to start one.",
            struct_id
        ))];
    }

    // Start hash task — proof anchored at the planet's mine clock. No initiation
    // tx: going online already started the cycle; we only compute + submit it.
    let block_height = block_start;
    let task_params = TaskParams::for_ore(struct_id, "MINE", block_start, difficulty_target);

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

    let (type_name, difficulty_target) = {
        let gs = GAME_STATE.read().unwrap();
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
            // No charge preflight: charge is consumed at the COMPLETE tx (~34h later),
            // scheduled by the signing queue — not at hash start.
            let difficulty = type_info.map(|t| t.ore_refining_difficulty).unwrap_or(28000);
            (type_name, difficulty)
        } else {
            return vec![Content::text(format!("Error: Struct {} not found.", struct_id))];
        }
    };

    // Anchor the refine proof on the PLANET's shared refine clock, read from the
    // chain — not the current block, and (since chain v0.21.0) not the
    // refinery's own attribute, which now permanently reads 0.
    let block_height = {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let planet_id = match client.query_entity("struct", struct_id).await {
            // A planetary rig's locationId IS its planet id.
            Ok(v) => v
                .get("Struct")
                .and_then(|s| s.get("locationId"))
                .and_then(|l| l.as_str())
                .map(str::to_string),
            Err(e) => return vec![Content::text(format!("refine: struct {} lookup failed: {}", struct_id, e))],
        };
        let Some(planet_id) = planet_id else {
            return vec![Content::text(format!(
                "refine: {} has no planet location — only a planetary refinery can refine.",
                struct_id
            ))];
        };
        match client.query_entity("planet", &planet_id).await {
            Ok(p) => crate::mcp::loop_util::planet_ore_anchor(Some(&p), crate::mcp::types::TaskType::Refine),
            Err(e) => {
                return vec![Content::text(format!("refine: planet {} lookup failed: {}", planet_id, e))]
            }
        }
    };
    if block_height == 0 {
        return vec![Content::text(format!(
            "refine: {}'s planet has no refine clock running (blockStartOreRefine=0) — bring a refinery online there with ore to refine.",
            struct_id
        ))];
    }

    let task_params = TaskParams::for_ore(struct_id, "REFINE", block_height, difficulty_target);

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
    let (type_id, build_difficulty, utilization, power_warning, build_charge_cost, charge_note) = {
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

        // Charge: data-driven cost, no block — the signing queue schedules the
        // build initiate in its charge lane and broadcasts when charge is ready.
        let build_charge_cost = charge_cost_for_type(type_info, "build", "");
        let charge_note = charge_status_note(&gs, build_charge_cost);

        // Preflight: power budget (this DOES still block — building while it would
        // push you offline is a real error, not a charge-schedulable one).
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
        (type_id, build_difficulty, util, util > 80.0, build_charge_cost, charge_note)
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
        "charge_cost": build_charge_cost,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "struct_build_initiate", tx_args, "mcp:struct_build_initiate").await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "{} build submitted in {} (slot {}). Build difficulty: {}.\nCharge: {}\nHash starts automatically once the initiate lands; the receipt appears in structs_events (tx_settled).{}",
            struct_type,
            ambit,
            slot,
            build_difficulty,
            charge_note,
            warning
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

    // Preflight: weapon-ambit reachability (still blocks — an out-of-ambit attack
    // is a real mistake, not charge-schedulable). Charge is NOT blocked: the
    // signing queue holds the attack in its charge lane until charge is ready.
    let (charge_cost, charge_note) = {
        use crate::mcp::tools::format::{ambit_bit, decode_ambits};
        let gs = GAME_STATE.read().unwrap();
        match gs.structs.get(attacker_id) {
            Some(att) => {
                let t = gs.struct_types.get(&att.struct_type_id.to_string());
                let cost = charge_cost_for_type(t, "attack", weapon);
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
                (cost, charge_status_note(&gs, cost))
            }
            None => (0, String::new()),
        }
    };

    let tx_args = json!({
        "action_type": "struct_attack",
        "operating_struct_id": attacker_id,
        "target_struct_id": target_id,
        "weapon_system": weapon,
        "charge_cost": charge_cost,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "struct_attack", tx_args, "mcp:struct_attack").await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Attack submitted: {} → {} (weapon: {})\nCharge: {}\nResult resolves on-chain — read it with structs_intel {{query:\"battle_log\"}} or watch structs_events (tx_settled + struct_attack).{}",
            attacker_id,
            target_id,
            weapon,
            charge_note,
            approval_surface("attack", 1, target_id, "irreversible (damage/destruction)", "target struct + counter-attack risk to attacker")
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

    let (charge_cost, charge_note) = struct_charge_info(defender_id, "defend", "");

    let tx_args = json!({
        "action_type": "struct_defense_set",
        "defender_struct_id": defender_id,
        "protected_struct_id": protected_id,
        "charge_cost": charge_cost,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "struct_defense_set", tx_args, "mcp:struct_defense_set").await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Defense set: {} now defending {}\nCharge: {}",
            defender_id,
            protected_id,
            charge_note
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

    let (fleet_id, home_planet) = {
        let gs = GAME_STATE.read().unwrap();
        (gs.fleet_id.clone().unwrap_or_default(), gs.planet_id.clone().unwrap_or_default())
    };

    // Home guard: leaving home arms our own raid clock and exposes the Command
    // Ship. Moving BACK home (retreat) is always allowed.
    if destination != home_planet {
        if let Some(reason) = crate::mcp::policy::home_guard_block_reason() {
            crate::mcp::board_feed::push(
                app_handle,
                crate::mcp::board_feed::Severity::Notice,
                "home_guard",
                format!("blocked fleet move to {} — {}", destination, reason),
            );
            return vec![Content::text(format!(
                "BLOCKED — {}\nRaid with an expendable vplayer instead (structs_players act), or adjust via structs_policy set primary_home_guard.",
                reason
            ))];
        }
    }

    let tx_args = json!({
        "action_type": "fleet_move",
        "fleet_id": fleet_id,
        "destination_id": destination,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "fleet_move", tx_args, "mcp:fleet_move").await {
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

    // Both addresses must be well-formed before anything reaches a signer:
    // the chain does not validate MsgPlayerSend's toAddress, so a malformed
    // destination is a silent burn, not a reject.
    if let Err(e) = crate::mcp::send_guard::validate_addr("sender", &from_address)
        .and_then(|_| crate::mcp::send_guard::validate_addr("destination", to_address))
    {
        return vec![Content::text(format!("Transfer refused: {e}"))];
    }

    let tx_args = json!({
        "action_type": "bank_send",
        "from_address": from_address,
        "to_address": to_address,
        "amount": amount,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "bank_send", tx_args, "mcp:bank_send").await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Transfer sent: {} to {}\nTx hash: {}{}",
            amount,
            to_address,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string()),
            approval_surface("transfer", 1, to_address, "irreversible (funds leave wallet)", amount)
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

    let (charge_cost, charge_note) = struct_charge_info(struct_id, "deploy", "");

    let tx_args = json!({
        "action_type": "struct_move",
        "struct_id": struct_id,
        "location_type": "planet",
        "ambit": ambit,
        "slot": slot,
        "charge_cost": charge_cost,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "struct_move", tx_args, "mcp:struct_move").await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Struct {} deploy submitted to {} slot {}\nCharge: {}",
            struct_id,
            ambit,
            slot,
            charge_note
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Deploy failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

async fn action_raid(
    app_handle: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    args: &Value,
) -> Vec<Content> {
    let target_id = args
        .get("target_id")
        .or_else(|| args.get("planet_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if target_id.is_empty() {
        return vec![Content::text(
            "Error: target_id (the planet to raid, e.g. '2-7') required.",
        )];
    }

    // Home guard: a raid keeps the primary fleet away (our own shield window
    // open) for the whole PoW wait — the exact pattern behind every historical
    // Command Ship loss. Blocked while the pile/power make that a bad gamble.
    if let Some(reason) = crate::mcp::policy::home_guard_block_reason() {
        crate::mcp::board_feed::push(
            app_handle,
            crate::mcp::board_feed::Severity::Notice,
            "home_guard",
            format!("blocked primary raid on {} — {}", target_id, reason),
        );
        return vec![Content::text(format!(
            "BLOCKED — {}\nRaid with an expendable vplayer instead (structs_players act {{action:raid}}), or adjust via structs_policy set primary_home_guard.",
            reason
        ))];
    }

    let (fleet_id, difficulty_target) = {
        let gs = GAME_STATE.read().unwrap();
        let fleet_id = gs.fleet_id.clone().unwrap_or_default();
        let difficulty = gs.get_difficulty_for_struct(&fleet_id, "RAID").unwrap_or(700);
        (fleet_id, difficulty)
    };
    if fleet_id.is_empty() {
        return vec![Content::text("Error: No fleet found for this player.")];
    }

    // The raid proof anchors on the TARGET planet's blockStartRaid — the
    // defender's vulnerability clock, armed only when their Command Ship is
    // down/absent — NOT the current block (docs: {fleetId}@{planetId}RAID{blockStart}NONCE).
    // 0 ⇒ the planet isn't raidable (chain error "raid_clock_unset"); grinding
    // at any other block is wasted (rejected, or trivial-difficulty-collapse guard).
    let block_height = {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        match client.query_entity("planet", target_id).await {
            Ok(v) => v
                .get("planetAttributes")
                .and_then(|x| x.get("blockStartRaid"))
                .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0),
            Err(e) => return vec![Content::text(format!("raid: planet {} lookup failed: {}", target_id, e))],
        }
    };
    if block_height == 0 {
        return vec![Content::text(format!(
            "raid: planet {} isn't raidable (blockStartRaid=0). The clock arms only when the defender's Command Ship is offline/destroyed/absent (their planetary shield is up otherwise). Strip blockers → drop the CMD ship → then raid.",
            target_id
        ))];
    }

    // Start the RAID hash task. The completion tx (planet-raid-complete) is
    // submitted automatically when the proof is found, like mine/refine.
    let task_params = TaskParams::for_raid(&fleet_id, target_id, block_height, difficulty_target);
    match hasher::start_hash_task_core(task_params, app_handle.clone(), registry) {
        Ok(()) => {
            let gpu = hasher::ensure_gpu_init();
            let engine = if gpu { "GPU" } else { "CPU" };
            vec![Content::text(format!(
                "Raid started: fleet {} → planet {} using {} (difficulty {}, block {}).\nReminder: a raid requires your fleet to be AWAY from its home planet with the Command Ship online. A successful raid seizes ALL of the target's stored ore.\nTrack progress with structs_hash {{ command: \"list\" }}.{}",
                fleet_id, target_id, engine, difficulty_target, block_height,
                approval_surface("raid", 1, target_id, "irreversible (seizes ore, provokes defense)", "target's entire stored ore + combat with defenders")
            ))]
        }
        Err(e) => vec![Content::text(format!("Error starting raid hash: {}", e))],
    }
}

async fn action_update_primary_reactor(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let reactor_id = args
        .get("reactor_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if reactor_id.is_empty() {
        return vec![Content::text(
            "Error: reactor_id required (the reactor to set as the guild's primary, e.g. '3-2').",
        )];
    }

    let guild_id = {
        let gs = GAME_STATE.read().unwrap();
        gs.guild_id.clone().unwrap_or_default()
    };
    if guild_id.is_empty() {
        return vec![Content::text(
            "Error: you are not in a guild (no guild_id in gameState). This action requires guild admin permission.",
        )];
    }

    let tx_args = json!({
        "action_type": "guild_update_primary_reactor",
        "guild_id": guild_id,
        "reactor_id": reactor_id,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, "guild_update_primary_reactor", tx_args, "mcp:guild_update_primary_reactor").await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "Guild {} primary reactor updated to {}.\nTx hash: {}",
            guild_id,
            reactor_id,
            resp.tx_hash.unwrap_or_else(|| "pending".to_string())
        ))],
        Ok(resp) => vec![Content::text(format!(
            "Update primary reactor failed: {}",
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

/// Force the webview to refresh its game state / reconnect its stream. `hard:true`
/// triggers a full page reload (nuclear option for a badly stale map); otherwise
/// it re-runs the sync + grass-resume path. Helps when the app's data layer looks
/// stale after a slow load.
fn action_resync(app_handle: &tauri::AppHandle, args: &Value) -> Vec<Content> {
    let hard = args.get("hard").and_then(|v| v.as_bool()).unwrap_or(false);
    match crate::mcp::events::emit(app_handle, crate::mcp::events::AppEvent::ForceResync { hard }) {
        Ok(()) => vec![Content::text(format!(
            "Resync requested ({}). The app will {}.",
            if hard { "hard" } else { "soft" },
            if hard { "reload the page" } else { "re-sync game state and reconnect its event stream" }
        ))],
        Err(e) => vec![Content::text(format!("Resync failed to dispatch: {}", e))],
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

    // activate/deactivate both cost activateCharge (genesis default 1). Not blocked —
    // the signing queue schedules it; we just report charge status.
    let (charge_cost, charge_note) = struct_charge_info(struct_id, "activate", "");

    let tx_args = json!({
        "action_type": action_type,
        "struct_id": struct_id,
        "charge_cost": charge_cost,
    });

    match crate::mcp::tx_retry::submit_once(app_handle, action_type, tx_args, &format!("mcp:{}", action_type)).await {
        Ok(resp) if resp.success => vec![Content::text(format!(
            "{} on {} submitted.\nCharge: {}",
            action_type,
            struct_id,
            charge_note
        ))],
        Ok(resp) => vec![Content::text(format!(
            "{} failed: {}",
            action_type,
            translate_error(&resp.error.unwrap_or_else(|| "unknown error".to_string()))
        ))],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

/// A compact consent surface for higher-impact (Tier 1+) actions. Returned in
/// the response so the agent/desktop app can present the v1.10 "Approval Block"
/// (action, tier, target, reversibility, blast radius) at the point of action.
fn approval_surface(action: &str, tier: u8, target: &str, reversibility: &str, blast_radius: &str) -> String {
    format!(
        "\n[Approval surface] action={} · tier={} · target={} · reversibility={} · blast_radius={}\n",
        action, tier, target, reversibility, blast_radius
    )
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

/// Non-blocking charge status note. The webapp signing queue now schedules
/// charge-gated messages itself — it holds them in a charge lane and broadcasts
/// when the on-chain charge bar is sufficient — so the MCP no longer BLOCKS on
/// charge. We just tell the agent whether it broadcasts this block or queues.
fn charge_status_note(gs: &crate::game_state::GameStateSync, cost: u64) -> String {
    let charge = gs.get_charge();
    if cost == 0 || charge >= cost {
        format!("charge OK ({}/{}) — broadcasts this block", charge, cost)
    } else {
        let blocks = gs.blocks_until_charge(cost);
        format!(
            "queued — broadcasts in ~{}s (~{} blocks) once charge reaches {} (have {})",
            blocks * 6,
            blocks,
            cost,
            charge
        )
    }
}

/// Charge cost + non-blocking status note for an action by a specific struct.
/// Returns (0, "") when the struct is unknown (caller's own not-found path handles it).
fn struct_charge_info(struct_id: &str, action: &str, weapon: &str) -> (u64, String) {
    let gs = GAME_STATE.read().unwrap();
    let Some(s) = gs.structs.get(struct_id) else {
        return (0, String::new());
    };
    let cost = charge_cost_for_type(
        gs.struct_types.get(&s.struct_type_id.to_string()),
        action,
        weapon,
    );
    let note = charge_status_note(&gs, cost);
    (cost, note)
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
            ..Default::default()
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
