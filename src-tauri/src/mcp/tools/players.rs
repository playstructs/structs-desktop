//! `structs_players` — create and manage agent-controlled virtual players
//! (extra players off the same mnemonic). Signing/derivation happen in JS via
//! the vplayer bridge; this tool orchestrates and keeps the public registry.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::hasher;
use crate::hasher::types::{TaskParams, TaskRegistry};
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::vplayer_bridge;
use crate::mcp::virtual_players::{VirtualPlayer, MAX_VIRTUAL_PLAYERS, REGISTRY};

#[derive(Debug, Deserialize)]
pub struct PlayerParams {
    /// "list" | "create" | "state"
    pub command: String,
    /// state/act: which virtual player (index, address, or player id).
    #[serde(default)]
    pub player: Option<String>,
    /// act: the game action to perform as the virtual player.
    #[serde(default)]
    pub action: Option<String>,
    /// act: action-specific args (same shapes as structs_action).
    #[serde(default)]
    pub args: Value,
    /// create: display name (3–20 chars, validated chain-side).
    #[serde(default)]
    pub name: Option<String>,
    /// create: HD index to use; defaults to the next free index (>= 1).
    #[serde(default)]
    pub index: Option<u32>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

pub async fn execute(
    app_handle: &tauri::AppHandle,
    client: &CosmosClient,
    registry: &Arc<TaskRegistry>,
    params: PlayerParams,
) -> Vec<Content> {
    match params.command.as_str() {
        "list" => {
            let players: Vec<Value> = {
                let reg = REGISTRY.read().unwrap();
                reg.players
                    .iter()
                    .map(|p| {
                        json!({
                            "index": p.index,
                            "address": p.address,
                            "player_id": p.player_id,
                            "name": p.name,
                            "status": if p.player_id.is_some() { "active" } else { "pending" },
                        })
                    })
                    .collect()
            };
            vec![Content::text(
                serde_json::to_string_pretty(&json!({
                    "count": players.len(),
                    "max": MAX_VIRTUAL_PLAYERS,
                    "virtual_players": players,
                }))
                .unwrap(),
            )]
        }

        // Team overview: the primary player + every virtual player in one view,
        // so an agent commanding a team sees everyone's planet/fleet/structs/
        // resources at a glance (otherwise it's dashboard + N separate states).
        "roster" => {
            let mut out = String::new();
            {
                let gs = crate::game_state::GAME_STATE.read().unwrap();
                let charge = gs.get_charge();
                out.push_str(&format!(
                    "Team roster\n  ★ {} {} (you) — planet {} · fleet {} · {} structs · charge {} · alpha {} ore {}\n",
                    gs.player_id.clone().unwrap_or_else(|| "?".to_string()),
                    gs.player_name.clone().unwrap_or_default(),
                    gs.planet_id.clone().unwrap_or_else(|| "none".to_string()),
                    gs.fleet_id.clone().unwrap_or_else(|| "none".to_string()),
                    gs.structs.len(),
                    charge,
                    gs.alpha.map(|a| format!("{:.0}", a)).unwrap_or_else(|| "?".to_string()),
                    gs.ore.map(|o| format!("{:.0}", o)).unwrap_or_else(|| "?".to_string()),
                ));
            }
            let vplayers: Vec<(u32, String, Option<String>)> = {
                let reg = REGISTRY.read().unwrap();
                reg.players
                    .iter()
                    .map(|p| (p.index, p.name.clone(), p.player_id.clone()))
                    .collect()
            };
            if vplayers.is_empty() {
                out.push_str("  (no virtual players — create with structs_players create {name})\n");
            }
            for (index, name, player_id) in vplayers {
                let Some(pid) = player_id else {
                    out.push_str(&format!("    [idx {}] {} — signup pending\n", index, name));
                    continue;
                };
                let (planet, fleet, alpha, ore) = match client.query_entity("player", &pid).await {
                    Ok(v) => {
                        let player = v.get("Player");
                        let grid = v.get("gridAttributes");
                        let inv = v.get("playerInventory");
                        let id_or = |val: Option<&Value>| {
                            val.and_then(|x| x.as_str())
                                .filter(|s| !s.is_empty())
                                .unwrap_or("none")
                                .to_string()
                        };
                        let num = |val: Option<&Value>| match val {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Number(n)) => n.to_string(),
                            _ => "0".to_string(),
                        };
                        (
                            id_or(player.and_then(|p| p.get("planetId"))),
                            id_or(player.and_then(|p| p.get("fleetId"))),
                            num(inv.and_then(|i| i.get("rocks")).and_then(|r| r.get("amount"))),
                            num(grid.and_then(|g| g.get("ore"))),
                        )
                    }
                    Err(_) => ("?".to_string(), "?".to_string(), "?".to_string(), "?".to_string()),
                };
                let nstructs = match client.guild.struct_list_by_owner(&pid, 1).await {
                    Ok(page) => page.items.len().to_string(),
                    Err(_) => "?".to_string(),
                };
                out.push_str(&format!(
                    "    [idx {}] {} {} — planet {} · fleet {} · {} structs · alpha {} ore {}\n",
                    index, pid, name, planet, fleet, nstructs, alpha, ore
                ));
            }
            out.push_str("\nAct as any player: structs_players act {player, …} or structs_sequence {as, steps}.\n");
            vec![Content::text(out)]
        }

        "create" => {
            let Some(name) = params.name.as_deref().filter(|n| !n.is_empty()) else {
                return vec![Content::text(
                    "Error: name required (3–20 chars: letters/digits/-/_).".to_string(),
                )];
            };

            // Pick the index + enforce the cap, under a short read lock.
            let index = {
                let reg = REGISTRY.read().unwrap();
                if reg.players.len() >= MAX_VIRTUAL_PLAYERS {
                    return vec![Content::text(format!(
                        "BLOCKED: virtual-player cap reached ({}). Remove one before creating more.",
                        MAX_VIRTUAL_PLAYERS
                    ))];
                }
                match params.index {
                    Some(i) if i == 0 => {
                        return vec![Content::text(
                            "Error: index 0 is the primary player; virtual players use index >= 1.".to_string(),
                        )]
                    }
                    Some(i) if reg.players.iter().any(|p| p.index == i) => {
                        return vec![Content::text(format!("Error: HD index {} already in use.", i))]
                    }
                    Some(i) => i,
                    None => reg.next_free_index(),
                }
            };

            // Façade does the whole flow: derive index N → sign guild-join →
            // POST /auth/signup → poll the address for its player id. ~180s budget.
            let result = vplayer_bridge::call(
                app_handle,
                "signup",
                json!({ "index": index, "name": name }),
                180,
            )
            .await;

            match result {
                Ok(data) => {
                    let address = data.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let player_id = data
                        .get("player_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if address.is_empty() {
                        return vec![Content::text(format!(
                            "Signup returned no address. Raw: {}",
                            data
                        ))];
                    }
                    {
                        let mut reg = REGISTRY.write().unwrap();
                        reg.players.push(VirtualPlayer {
                            index,
                            address: address.clone(),
                            player_id: player_id.clone(),
                            name: name.to_string(),
                            created_at: now_ms(),
                        });
                        let _ = reg.save();
                    }
                    vec![Content::text(format!(
                        "Virtual player '{}' created at HD index {}.\nAddress: {}\nPlayer id: {}\n{}",
                        name,
                        index,
                        address,
                        player_id.as_deref().unwrap_or("(pending — chain hasn't assigned an id yet; re-run list shortly)"),
                        "It plays from its own address off the same mnemonic — keys never leave the app."
                    ))]
                }
                Err(e) => vec![Content::text(format!("Virtual player create failed: {}", e))],
            }
        }

        "state" | "dashboard" => {
            let Some(key) = params.player.as_deref().filter(|s| !s.is_empty()) else {
                return vec![Content::text(
                    "Error: player required (index, address, or player id).".to_string(),
                )];
            };
            // Resolve from the registry → its on-chain player id.
            let (name, address, player_id) = {
                let reg = REGISTRY.read().unwrap();
                match reg.find(key) {
                    Some(p) => (p.name.clone(), p.address.clone(), p.player_id.clone()),
                    None => {
                        return vec![Content::text(format!(
                            "No virtual player matches '{}'. Use structs_players list.",
                            key
                        ))]
                    }
                }
            };
            let Some(player_id) = player_id else {
                return vec![Content::text(format!(
                    "Virtual player '{}' ({}) has no on-chain id yet (signup still pending). Retry shortly.",
                    name, address
                ))];
            };

            let mut out = String::new();
            out.push_str(&format!("Virtual player: {} [{}] — {}\n", name, player_id, address));

            // Player-level data from the LCD (unauthenticated — avoids the shared
            // session cookie jar). Best-effort; degrade to a note on failure.
            match client.query_entity("player", &player_id).await {
                Ok(v) => {
                    // The LCD player entity nests data: identity under `Player`,
                    // resources under `gridAttributes`, alpha under
                    // `playerInventory.rocks.amount`. Values are JSON strings.
                    let player = v.get("Player").or_else(|| v.get("player"));
                    let grid = v.get("gridAttributes");
                    let inv = v.get("playerInventory");
                    // string-or-number → bare string (no JSON quotes); default "0".
                    let s = |val: Option<&Value>| -> String {
                        match val {
                            Some(Value::String(x)) => x.clone(),
                            Some(Value::Number(n)) => n.to_string(),
                            _ => "0".to_string(),
                        }
                    };
                    let id_str = |val: Option<&Value>| -> String {
                        val.and_then(|x| x.as_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("none")
                            .to_string()
                    };
                    out.push_str(&format!(
                        "  Guild: {} | Alpha: {} | Ore: {} | Load/Cap: {}/{}\n",
                        id_str(player.and_then(|p| p.get("guildId"))),
                        s(inv.and_then(|i| i.get("rocks")).and_then(|r| r.get("amount"))),
                        s(grid.and_then(|g| g.get("ore"))),
                        s(grid.and_then(|g| g.get("load"))),
                        s(grid.and_then(|g| g.get("capacity"))),
                    ));
                    out.push_str(&format!(
                        "  Planet: {} | Fleet: {}\n",
                        id_str(player.and_then(|p| p.get("planetId"))),
                        id_str(player.and_then(|p| p.get("fleetId"))),
                    ));
                    // Charge ≈ blocks since lastAction (shared chain height).
                    let last = grid
                        .and_then(|g| g.get("lastAction"))
                        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0);
                    if last > 0 {
                        let h = crate::game_state::GAME_STATE.read().unwrap().current_block_height;
                        out.push_str(&format!("  Charge: ~{} (blocks since last action)\n", h.saturating_sub(last)));
                    }
                }
                Err(e) => out.push_str(&format!("  Player data unavailable (LCD): {}\n", e)),
            }

            // Their structs via the Guild API (guild-wide read; uses the primary
            // session, which can read any owner — same path scout uses).
            match client.guild.struct_list_by_owner(&player_id, 1).await {
                Ok(page) => {
                    out.push_str(&format!("  Structs ({}):\n", page.items.len()));
                    let gs = crate::game_state::GAME_STATE.read().unwrap();
                    for s in page.items.iter().take(30) {
                        let id = s.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                        let type_id = s.get("type").or_else(|| s.get("struct_type")).map(|x| match x {
                            Value::Number(n) => n.to_string(),
                            Value::String(t) => t.clone(),
                            _ => String::new(),
                        });
                        let type_name = type_id
                            .as_deref()
                            .and_then(|t| gs.struct_types.get(t))
                            .map(|t| t.name.as_str())
                            .unwrap_or("?");
                        let hp = s.get("health").and_then(|x| x.as_f64()).map(|h| format!(" HP {:.0}", h)).unwrap_or_default();
                        let ambit = s.get("operating_ambit").and_then(|x| x.as_str()).unwrap_or("?");
                        out.push_str(&format!("    {} {} [{}]{}\n", id, type_name, ambit, hp));
                    }
                }
                Err(e) => out.push_str(&format!("  Structs unavailable: {}\n", e)),
            }

            // Recent grass activity for this player.
            let evs = crate::mcp::event_buffer::get_recent(60, None, None);
            let mine: Vec<_> = evs
                .iter()
                .filter(|e| e.subject.contains(&player_id) || e.detail.to_string().contains(&address))
                .rev()
                .take(6)
                .collect();
            if !mine.is_empty() {
                out.push_str("  Recent activity:\n");
                for e in mine.iter().rev() {
                    out.push_str(&format!("    [{}] {} — {}\n", e.timestamp, e.category, e.subject));
                }
            }
            out.push_str("\nAct as this player: structs_players act {player, action, args} for one action, or structs_sequence {as, steps} for a guarded chain.\n");
            vec![Content::text(out)]
        }

        "act" => {
            let Some(key) = params.player.as_deref().filter(|s| !s.is_empty()) else {
                return vec![Content::text("Error: player required (index/address/player id).".to_string())];
            };
            let Some(action) = params.action.as_deref().filter(|s| !s.is_empty()) else {
                return vec![Content::text("Error: action required (explore|build|attack|defend|activate|deactivate|deploy).".to_string())];
            };
            let (index, player_id) = {
                let reg = REGISTRY.read().unwrap();
                match reg.find(key) {
                    Some(p) => (p.index, p.player_id.clone()),
                    None => return vec![Content::text(format!("No virtual player matches '{}'.", key))],
                }
            };
            let Some(player_id) = player_id else {
                return vec![Content::text("Virtual player has no on-chain id yet (signup pending).".to_string())];
            };

            // Build PoW completion: a struct initiated via `build` sits in a
            // building state. Compute its build proof and auto-sign
            // MsgStructBuildComplete. We read blockStartBuild + the type's build
            // difficulty from the chain so the proof prefix
            // ({structId}BUILD{blockStartBuild}NONCE) matches what the chain verifies.
            if action == "complete_build" {
                let Some(sid) = params.args.get("struct_id").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    return vec![Content::text("complete_build: struct_id (the building struct from `build`) required.".to_string())];
                };
                let entity = match client.query_entity("struct", &sid).await {
                    Ok(v) => v,
                    Err(e) => return vec![Content::text(format!("complete_build: struct {} lookup failed: {}", sid, e))],
                };
                let sa = entity.get("structAttributes");
                let truthy = |b: Option<&Value>| match b {
                    Some(Value::Bool(v)) => *v,
                    Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
                    _ => false,
                };
                if truthy(sa.and_then(|x| x.get("isBuilt"))) {
                    return vec![Content::text(format!("[vplayer {}] {} is already built — nothing to complete.", index, sid))];
                }
                let block_start = sa
                    .and_then(|x| x.get("blockStartBuild"))
                    .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0);
                if block_start == 0 {
                    return vec![Content::text(format!("complete_build: {} has no blockStartBuild — is it actually building?", sid))];
                }
                let type_id = entity.get("Struct").and_then(|s| s.get("type")).and_then(|x| match x {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                });
                let difficulty = {
                    let gs = crate::game_state::GAME_STATE.read().unwrap();
                    type_id.as_ref().and_then(|t| gs.struct_types.get(t)).map(|t| t.build_difficulty).unwrap_or(0)
                };
                if difficulty == 0 {
                    return vec![Content::text(format!("complete_build: couldn't resolve build difficulty for {}.", sid))];
                }
                let task_params = TaskParams::for_ore(&sid, "BUILD", block_start, difficulty);
                match hasher::start_hash_task_core(task_params, app_handle.clone(), registry) {
                    Ok(()) => {
                        hasher::register_vplayer_hash(sid.clone(), index, "BUILD".to_string());
                        return vec![Content::text(format!(
                            "[vplayer {}] build PoW started on {} (blockStartBuild {}, difficulty {}). MsgStructBuildComplete auto-signs when the proof lands. Track with structs_hash list.",
                            index, sid, block_start, difficulty
                        ))];
                    }
                    Err(e) => return vec![Content::text(format!("[vplayer {}] complete_build failed to start: {}", index, e))],
                }
            }

            // PoW actions (mine/refine/raid): start a Rust hash for this virtual
            // player's struct/fleet and register it — `maybe_complete_virtual`
            // signs the completion tx as this player when the proof lands.
            if matches!(action, "mine" | "refine" | "raid") {
                let block = crate::game_state::GAME_STATE.read().unwrap().current_block_height;
                if block == 0 {
                    return vec![Content::text("gameState not synced yet (block 0). Retry shortly.".to_string())];
                }
                let s = |k: &str| params.args.get(k).and_then(|v| v.as_str()).map(|x| x.to_string());
                let dt = |k: &str, d: u64| params.args.get(k).and_then(|v| v.as_u64()).unwrap_or(d);
                let (object_id, task_type, task_params) = match action {
                    "mine" => {
                        let Some(sid) = s("struct_id") else {
                            return vec![Content::text("mine: struct_id (the player's Ore Extractor) required.".to_string())];
                        };
                        (sid.clone(), "MINE", TaskParams::for_ore(&sid, "MINE", block, dt("difficulty_target", 14000)))
                    }
                    "refine" => {
                        let Some(sid) = s("struct_id") else {
                            return vec![Content::text("refine: struct_id (the player's Ore Refinery) required.".to_string())];
                        };
                        (sid.clone(), "REFINE", TaskParams::for_ore(&sid, "REFINE", block, dt("difficulty_target", 28000)))
                    }
                    "raid" => {
                        let (Some(fleet), Some(target)) = (s("fleet_id"), s("target_id")) else {
                            return vec![Content::text("raid: fleet_id (this player's fleet) and target_id (planet) required.".to_string())];
                        };
                        (fleet.clone(), "RAID", TaskParams::for_raid(&fleet, &target, block, dt("difficulty_target", 700)))
                    }
                    _ => unreachable!(),
                };
                match hasher::start_hash_task_core(task_params, app_handle.clone(), registry) {
                    Ok(()) => {
                        hasher::register_vplayer_hash(object_id.clone(), index, task_type.to_string());
                        return vec![Content::text(format!(
                            "[vplayer {}] {} hashing started on {} (block {}). The completion tx will be auto-signed as this player when the proof is found. Track with structs_hash list.",
                            index, action, object_id, block
                        ))];
                    }
                    Err(e) => return vec![Content::text(format!("[vplayer {}] {} failed to start: {}", index, action, e))],
                }
            }

            // Raw passthrough: sign ANY chain message directly. The agent supplies
            // {type_url, msg}; the façade injects `creator` and encodes via the
            // proto's fromJSON (enum names, string-numbers, defaults all handled).
            // This gives full coverage of every direct (non-PoW) message type.
            let (type_url, payload) = if action == "tx" || action == "raw" {
                let Some(tu) = params.args.get("type_url").and_then(|v| v.as_str()) else {
                    return vec![Content::text(
                        "tx: type_url required (e.g. \"/structs.structs.MsgFleetMove\"), plus msg{...}.".to_string(),
                    )];
                };
                (tu.to_string(), params.args.get("msg").cloned().unwrap_or_else(|| json!({})))
            } else {
                match build_virtual_msg(action, &params.args, &player_id) {
                    Ok(v) => v,
                    Err(e) => return vec![Content::text(format!("Error: {}", e))],
                }
            };

            // Sign+broadcast as the virtual player via the façade (its key, never Rust's).
            match vplayer_bridge::call(
                app_handle,
                "sign",
                json!({ "index": index, "type_url": type_url, "payload": payload }),
                60,
            )
            .await
            {
                Ok(res) => {
                    let code = res.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                    let hash = res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("");
                    if code == 0 {
                        vec![Content::text(format!(
                            "[vplayer {}] {} submitted — tx {}\nRead the outcome via structs_intel battle_log / structs_events.",
                            index, action, if hash.is_empty() { "(pending)" } else { hash }
                        ))]
                    } else {
                        let raw = res.get("rawLog").and_then(|r| r.as_str()).unwrap_or("");
                        vec![Content::text(format!(
                            "[vplayer {}] {} rejected — chain code {}{}",
                            index, action, code,
                            if raw.is_empty() { String::new() } else { format!(": {}", raw) }
                        ))]
                    }
                }
                Err(e) => vec![Content::text(format!("[vplayer {}] {} failed: {}", index, action, e))],
            }
        }

        other => vec![Content::text(format!(
            "Unknown structs_players command '{}'. Use: list, create, state, act.",
            other
        ))],
    }
}

/// Map an ambit name to its chain `ambit` enum int (proto keys.ts):
/// none=0, water=1, land=2, air=3, space=4, local=5. Build/Move messages take
/// this enum, NOT the combat reach BITMASK (Water=2/Land=4/…) and NOT a string.
fn ambit_to_enum(name: &str) -> i64 {
    match name.trim().to_ascii_lowercase().as_str() {
        "water" => 1,
        "land" => 2,
        "air" => 3,
        "space" => 4,
        "local" => 5,
        _ => 0,
    }
}

/// Build the proto (typeUrl, payload) for a virtual-player action. `creator` is
/// injected by the façade from the signer address, so it's omitted here. Player-
/// level fields use the virtual player's id; entity ids come from the agent's args.
fn build_virtual_msg(action: &str, args: &Value, player_id: &str) -> Result<(String, Value), String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|x| x.to_string());
    let u = |k: &str| args.get(k).and_then(|v| v.as_u64());
    match action {
        "explore" => Ok((
            "/structs.structs.MsgPlanetExplore".into(),
            json!({ "playerId": player_id }),
        )),
        "build" => {
            let struct_type = s("struct_type").ok_or("build: struct_type required")?;
            // Resolve the type name → id from the shared struct-type catalog.
            let type_id = {
                let gs = crate::game_state::GAME_STATE.read().unwrap();
                gs.struct_types
                    .values()
                    .find(|t| t.name.eq_ignore_ascii_case(&struct_type))
                    .map(|t| t.id)
                    .ok_or_else(|| format!("build: unknown struct type '{}'", struct_type))?
            };
            Ok((
                "/structs.structs.MsgStructBuildInitiate".into(),
                json!({
                    "playerId": player_id,
                    "structTypeId": type_id,
                    // operatingAmbit is the `ambit` ENUM (none0 water1 land2 air3
                    // space4 local5), not a string — sending a string encodes as
                    // "invalid int32: NaN".
                    "operatingAmbit": ambit_to_enum(s("ambit").as_deref().unwrap_or("space")),
                    "slot": u("slot").unwrap_or(0),
                }),
            ))
        }
        "activate" => Ok((
            "/structs.structs.MsgStructActivate".into(),
            json!({ "structId": s("struct_id").ok_or("activate: struct_id required")? }),
        )),
        "deactivate" => Ok((
            "/structs.structs.MsgStructDeactivate".into(),
            json!({ "structId": s("struct_id").ok_or("deactivate: struct_id required")? }),
        )),
        "deploy" => Ok((
            "/structs.structs.MsgStructMove".into(),
            json!({
                "structId": s("struct_id").ok_or("deploy: struct_id required")?,
                // locationType is the `objectType` enum (planet = 2); ambit is the
                // `ambit` enum — both int32, not strings.
                "locationType": 2,
                "ambit": ambit_to_enum(s("ambit").as_deref().unwrap_or("space")),
                "slot": u("slot").unwrap_or(0),
            }),
        )),
        "defend" => Ok((
            "/structs.structs.MsgStructDefenseSet".into(),
            json!({
                "defenderStructId": s("defender_id").ok_or("defend: defender_id required")?,
                "protectedStructId": s("protected_id").ok_or("defend: protected_id required")?,
            }),
        )),
        "attack" => {
            let weapon = match s("weapon").unwrap_or_else(|| "primary".into()).as_str() {
                "secondary" | "secondaryWeapon" => "secondaryWeapon",
                _ => "primaryWeapon",
            };
            Ok((
                "/structs.structs.MsgStructAttack".into(),
                json!({
                    "operatingStructId": s("attacker_id").ok_or("attack: attacker_id required")?,
                    "targetStructId": [s("target_id").ok_or("attack: target_id required")?],
                    "weaponSystem": weapon,
                }),
            ))
        }
        // ── Fleet / planet ──
        "fleet_move" => Ok((
            "/structs.structs.MsgFleetMove".into(),
            json!({
                "fleetId": s("fleet_id").ok_or("fleet_move: fleet_id required")?,
                "destinationLocationId": s("destination_id").or_else(|| s("destination"))
                    .ok_or("fleet_move: destination_id (a planet id) required")?,
            }),
        )),
        "planet_update_name" => Ok((
            "/structs.structs.MsgPlanetUpdateName".into(),
            json!({
                "planetId": s("planet_id").ok_or("planet_update_name: planet_id required")?,
                "name": s("name").unwrap_or_default(),
            }),
        )),
        // ── Struct lifecycle extras ──
        "build_cancel" => Ok((
            "/structs.structs.MsgStructBuildCancel".into(),
            json!({ "structId": s("struct_id").ok_or("build_cancel: struct_id required")? }),
        )),
        "defense_clear" => Ok((
            "/structs.structs.MsgStructDefenseClear".into(),
            json!({ "defenderStructId": s("defender_id").ok_or("defense_clear: defender_id required")? }),
        )),
        "stealth_activate" => Ok((
            "/structs.structs.MsgStructStealthActivate".into(),
            json!({ "structId": s("struct_id").ok_or("stealth_activate: struct_id required")? }),
        )),
        "stealth_deactivate" => Ok((
            "/structs.structs.MsgStructStealthDeactivate".into(),
            json!({ "structId": s("struct_id").ok_or("stealth_deactivate: struct_id required")? }),
        )),
        "storage_stash" => Ok((
            "/structs.structs.MsgStructStorageStash".into(),
            json!({
                "structId": s("struct_id").ok_or("storage_stash: struct_id required")?,
                "locationId": s("location_id").ok_or("storage_stash: location_id required")?,
                "ambit": ambit_to_enum(s("ambit").as_deref().unwrap_or("space")),
                "slot": u("slot").unwrap_or(0),
            }),
        )),
        "storage_recall" => Ok((
            "/structs.structs.MsgStructStorageRecall".into(),
            json!({
                "structId": s("struct_id").ok_or("storage_recall: struct_id required")?,
                "locationId": s("location_id").ok_or("storage_recall: location_id required")?,
                "ambit": ambit_to_enum(s("ambit").as_deref().unwrap_or("space")),
                "slot": u("slot").unwrap_or(0),
                "activate": args.get("activate").and_then(|v| v.as_bool()).unwrap_or(true),
            }),
        )),
        "generator_infuse" => Ok((
            "/structs.structs.MsgStructGeneratorInfuse".into(),
            json!({
                "structId": s("struct_id").ok_or("generator_infuse: struct_id required")?,
                "infuseAmount": s("amount").ok_or("generator_infuse: amount required")?,
            }),
        )),
        // ── Player self-management ──
        "player_resume" => Ok((
            "/structs.structs.MsgPlayerResume".into(),
            json!({ "playerId": player_id }),
        )),
        "player_update_name" => Ok((
            "/structs.structs.MsgPlayerUpdateName".into(),
            json!({ "playerId": player_id, "name": s("name").unwrap_or_default() }),
        )),
        other => Err(format!(
            "action '{}' not supported as a named action. Direct: explore, build, activate, deactivate, deploy, defend, attack, fleet_move, planet_update_name, build_cancel, defense_clear, stealth_activate, stealth_deactivate, storage_stash, storage_recall, generator_infuse, player_resume, player_update_name. PoW: mine, refine, raid, complete_build. For ANY other message use action \"tx\" {{type_url, msg}}.",
            other
        )),
    }
}
