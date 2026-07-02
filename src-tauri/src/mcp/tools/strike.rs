//! `structs_strike` — coordinated team barrage. The counter-attack mechanic is
//! passive and weak (≤1 dmg per defender); a real `attack` does 1–3. Each player
//! (the primary + every virtual player) has its OWN charge bar that resets to 0
//! per action — so the way to hit hard is to fire ALL of them at one target in
//! the same window. This tool plans the team strike (reusing `intel::plan_strike`),
//! picks each player's single BEST reaching weapon (one shot per charge bar), and
//! fires them — primary via the signing queue, virtual players via the façade.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::tools::intel::{plan_strike, StrikeRow};
use crate::mcp::{tx_queue, vplayer_bridge};

#[derive(Debug, Deserialize)]
pub struct StrikeParams {
    /// Enemy struct id to focus-fire (e.g. "5-2288").
    #[serde(default)]
    pub target: Option<String>,
    /// Cap the number of attackers (default: all reachable, one per player).
    #[serde(default)]
    pub max: Option<usize>,
    /// Plan only — show who would fire and projected damage, without attacking.
    #[serde(default)]
    pub dry_run: bool,
    /// Kill-chain mode (default true): you can't damage a struct through its
    /// SAME-AMBIT blockers, so redirect fire to the current blocker until the
    /// target is exposed. Re-invoking each charge cycle walks strip→kill→(raid).
    #[serde(default = "default_true")]
    pub strip_blockers: bool,
}

fn default_true() -> bool {
    true
}

/// Walk the kill-chain: if `target` is shielded by alive SAME-AMBIT blockers,
/// the effective fire target becomes the first blocker (cross-ambit defenders
/// only counter, they don't block, so they don't need stripping). Returns
/// (effective_target, phase, note).
async fn resolve_fire_target(
    client: &CosmosClient,
    target: &str,
) -> Result<(String, String, String), String> {
    let entity = client.query_entity("struct", target).await.map_err(|e| format!("target {} lookup failed: {}", target, e))?;
    let target_ambit = entity
        .get("Struct")
        .and_then(|s| s.get("operatingAmbit"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let destroyed = entity
        .get("structAttributes")
        .and_then(|a| a.get("isDestroyed"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if destroyed {
        return Ok((target.to_string(), "DOWN".to_string(), "target already destroyed".to_string()));
    }

    let defenders = client
        .guild
        .struct_defender_by_protected(target, 1)
        .await
        .map(|p| p.items)
        .unwrap_or_default();
    let mut blockers: Vec<String> = Vec::new();
    for d in &defenders {
        let Some(did) = d.get("defending_struct_id").and_then(|x| x.as_str()) else { continue };
        if let Ok(de) = client.query_entity("struct", did).await {
            let dead = de
                .get("structAttributes")
                .and_then(|a| a.get("isDestroyed"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let damb = de
                .get("Struct")
                .and_then(|s| s.get("operatingAmbit"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            // Same-ambit, alive defender = a real blocker that must die first.
            if !dead && !damb.is_empty() && damb == target_ambit {
                blockers.push(did.to_string());
            }
        }
    }
    if let Some(b) = blockers.first() {
        Ok((
            b.clone(),
            "STRIP".to_string(),
            format!("{} same-ambit blocker(s) shield {} — clearing blocker first", blockers.len(), target),
        ))
    } else {
        Ok((target.to_string(), "KILL".to_string(), String::new()))
    }
}

pub async fn execute(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    params: StrikeParams,
) -> Vec<Content> {
    let Some(target) = params.target.clone().filter(|s| !s.is_empty()) else {
        return vec![Content::text(
            "structs_strike: 'target' (an enemy struct id, e.g. \"5-2288\") required.".to_string(),
        )];
    };

    // Kill-chain: redirect fire to the current same-ambit blocker if any.
    let (fire_target, phase, note) = if params.strip_blockers {
        match resolve_fire_target(client, &target).await {
            Ok(t) => t,
            Err(e) => return vec![Content::text(format!("structs_strike: {}", e))],
        }
    } else {
        (target.clone(), "DIRECT".to_string(), String::new())
    };

    if phase == "DOWN" {
        return vec![Content::text(format!(
            "structs_strike: {} is already destroyed. If it was the defender's Command Ship, the raid window is OPEN — move a fleet to its planet (structs_action move_fleet / structs_players act fleet_move) then raid (structs_action raid / structs_players act raid) to seize stored ore before they rebuild.",
            target
        ))];
    }

    let plan = match plan_strike(client, &json!({ "target": fire_target })).await {
        Ok(p) => p,
        Err(e) => return vec![Content::text(format!("structs_strike: {}", e))],
    };

    // One shot per player — charge resets to 0 on any action, so a player can
    // only fire once this window; pick its highest-expected-damage reaching weapon.
    let mut best: HashMap<String, &StrikeRow> = HashMap::new();
    for r in plan.rows.iter().filter(|r| r.reachable) {
        let e = best.entry(r.player.clone()).or_insert(r);
        if r.expected_dmg > e.expected_dmg {
            *e = r;
        }
    }
    if best.is_empty() {
        return vec![Content::text(format!(
            "structs_strike: no team struct can reach {} (check its ambit vs your weapons). Nothing to fire.",
            plan.target_label
        ))];
    }

    let mut shots: Vec<&StrikeRow> = best.into_values().collect();
    shots.sort_by(|a, b| {
        b.expected_dmg
            .partial_cmp(&a.expected_dmg)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if let Some(m) = params.max {
        shots.truncate(m.max(1));
    }

    let projected: f64 = shots.iter().map(|s| s.expected_dmg).sum();

    let note_line = if note.is_empty() { String::new() } else { format!("  ({})\n", note) };

    if params.dry_run {
        let mut out = format!(
            "structs_strike [{}] PLAN → fire {} (HP {:.0}) — {} attacker(s), one best shot each:\n{}",
            phase, plan.target_label, plan.tgt_hp, shots.len(), note_line
        );
        for s in &shots {
            out.push_str(&format!("  {} · {} [{}] → ~{:.1} dmg\n", s.player, s.struct_id, s.weapon, s.expected_dmg));
        }
        out.push_str(&format!(
            "Projected total ~{:.1} dmg vs {:.0} HP{}. Re-run without dry_run to fire.\n",
            projected,
            plan.tgt_hp,
            if projected >= plan.tgt_hp { " — KILL" } else { "" }
        ));
        return vec![Content::text(out)];
    }

    // name -> vplayer HD index, for routing each shot to its signer.
    let name_to_index: HashMap<String, u32> = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
        reg.players.iter().map(|p| (p.name.clone(), p.index)).collect()
    };
    let primary_charge = |sid: &str, weapon: &str| -> u64 {
        let gs = crate::game_state::GAME_STATE.read().unwrap();
        gs.structs
            .get(sid)
            .and_then(|s| gs.struct_types.get(&s.struct_type_id.to_string()))
            .map(|t| {
                if weapon.eq_ignore_ascii_case("secondary") {
                    t.secondary_weapon_charge
                } else {
                    t.primary_weapon_charge
                }
                .unwrap_or(3)
            })
            .unwrap_or(3)
    };

    let mut out = format!(
        "⚔ Team strike [{}] on {} (HP {:.0}) — firing {} attacker(s), best shot each:\n{}",
        phase, plan.target_label, plan.tgt_hp, shots.len(), note_line
    );
    let mut fired = 0u32;
    for s in &shots {
        if s.player == "you" {
            let cost = primary_charge(&s.struct_id, &s.weapon);
            let tx_args = json!({
                "action_type": "struct_attack",
                "operating_struct_id": s.struct_id,
                "target_struct_id": target,
                "weapon_system": s.weapon,
                "charge_cost": cost,
            });
            match tx_queue::submit_tx(app, "struct_attack".to_string(), tx_args).await {
                Ok(r) if r.success => {
                    fired += 1;
                    out.push_str(&format!("  ✓ you · {} [{}] → ~{:.1} dmg (queued; fires when charge ready)\n", s.struct_id, s.weapon, s.expected_dmg));
                }
                Ok(r) => out.push_str(&format!("  ✗ you · {}: {}\n", s.struct_id, r.error.unwrap_or_else(|| "rejected".into()))),
                Err(e) => out.push_str(&format!("  ✗ you · {}: {}\n", s.struct_id, e)),
            }
        } else if let Some(&index) = name_to_index.get(&s.player) {
            let wsys = if s.weapon.eq_ignore_ascii_case("secondary") {
                "secondaryWeapon"
            } else {
                "primaryWeapon"
            };
            let payload = json!({
                "operatingStructId": s.struct_id,
                "targetStructId": [target.clone()],
                "weaponSystem": wsys,
            });
            match vplayer_bridge::sign_action(app, index, "/structs.structs.MsgStructAttack", payload, 60).await
            {
                Ok(res) => {
                    let code = res.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                    if code == 0 {
                        fired += 1;
                        out.push_str(&format!("  ✓ {} · {} [{}] → ~{:.1} dmg\n", s.player, s.struct_id, s.weapon, s.expected_dmg));
                    } else {
                        let raw: String = res.get("rawLog").and_then(|r| r.as_str()).unwrap_or("").chars().take(90).collect();
                        out.push_str(&format!("  ✗ {} · {}: code {} {}\n", s.player, s.struct_id, code, raw));
                    }
                }
                Err(e) => out.push_str(&format!("  ✗ {} · {}: {}\n", s.player, s.struct_id, e)),
            }
        }
    }
    out.push_str(&format!(
        "\n{} shot(s) launched, ~{:.1} projected dmg vs {:.0} HP. Each shot resets that player's charge.\n",
        fired, projected, plan.tgt_hp
    ));
    // Kill-chain guidance: what to do next charge cycle.
    let next = match phase.as_str() {
        "STRIP" => format!(
            "Kill-chain: clearing a blocker of {}. Re-run structs_strike {{target:\"{}\"}} after charge regens — it advances to the next blocker, then the target itself.",
            target, target
        ),
        "KILL" => {
            let raid = if plan.target_label.contains("Command") {
                " Destroying this Command Ship opens the raid window → move a fleet to its planet then raid to seize stored ore."
            } else {
                ""
            };
            format!("Kill-chain: target is exposed (no same-ambit blockers). Re-run after charge to keep hitting it until destroyed.{}", raid)
        }
        _ => "Read outcomes via structs_intel battle_log or structs_events.".to_string(),
    };
    out.push_str(&next);
    out.push('\n');
    vec![Content::text(out)]
}
