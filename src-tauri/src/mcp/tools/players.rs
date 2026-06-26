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
                    let p = v.get("Player").or_else(|| v.get("player")).unwrap_or(&v);
                    let g = |k: &str| p.get(k).map(|x| x.to_string()).unwrap_or_default();
                    out.push_str(&format!(
                        "  Guild: {} | Alpha: {} | Ore: {} | Load/Cap: {}/{} | lastAction: {}\n",
                        g("guildId"), g("alpha"), g("ore"), g("load"), g("capacity"), g("lastActionBlockHeight")
                    ));
                    // Charge ≈ blocks since lastAction (shared chain height).
                    if let Some(last) = p.get("lastActionBlockHeight").and_then(|x| x.as_str()).and_then(|s| s.parse::<u64>().ok()) {
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
            out.push_str("\nAct as this player with structs_action / structs_sequence + `as`.\n");
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

            let (type_url, payload) = match build_virtual_msg(action, &params.args, &player_id) {
                Ok(v) => v,
                Err(e) => return vec![Content::text(format!("Error: {}", e))],
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
                    "operatingAmbit": s("ambit").unwrap_or_else(|| "space".into()),
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
                "locationType": "planet",
                "ambit": s("ambit").unwrap_or_else(|| "space".into()),
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
        other => Err(format!(
            "action '{}' not supported for virtual players. Direct: explore, build, activate, deactivate, deploy, defend, attack. PoW (auto-completes): mine, refine, raid.",
            other
        )),
    }
}
