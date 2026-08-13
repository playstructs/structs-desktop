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

/// How many of the planned shots to show in a dry run before rolling the rest
/// up. Enough to see the shape of the barrage, short enough to read.
const SHOT_PREVIEW: usize = 12;

/// Damage headroom over the target's HP. Shots miss (per-weapon success rate),
/// get evaded, jammed or blocked, so "exactly lethal on paper" is not lethal in
/// practice — but 300x is not insurance, it is waste.
const OVERKILL: f64 = 2.0;

/// The smallest prefix of `shots` (already sorted strongest-first) that is
/// worth firing at a target with `tgt_hp` health.
///
/// Accumulates expected damage until it covers `OVERKILL x tgt_hp`, with a
/// floor of 3 so a single unlucky miss cannot waste the whole sortie. Returns
/// at most `shots.len()`.
fn shots_to_kill(shots: &[&StrikeRow], tgt_hp: f64) -> usize {
    const MIN_SHOTS: usize = 3;
    if shots.is_empty() {
        return 0;
    }
    let want = (tgt_hp.max(0.0)) * OVERKILL;
    let mut acc = 0.0;
    for (i, s) in shots.iter().enumerate() {
        acc += s.expected_dmg;
        if acc >= want && i + 1 >= MIN_SHOTS {
            return i + 1;
        }
    }
    shots.len()
}

#[cfg(test)]
mod proportionality_tests {
    use super::*;

    // Built field-by-field rather than via `..Default::default()`: StrikeRow is
    // a production type and does not derive Default, and adding one just to
    // shorten a test invites a silently-wrong zero somewhere real.
    fn row(dmg: f64) -> StrikeRow {
        StrikeRow {
            player: "p".into(),
            player_id: None,
            hd_index: None,
            struct_id: "5-1".into(),
            weapon: "primary".into(),
            expected_dmg: dmg,
            reachable: true,
            att_ambit_bit: 4,
            counter_exposure: 0,
            score: dmg,
            control: crate::mcp::combat::WeaponControl::Unguided,
        }
    }

    #[test]
    fn a_six_hp_target_does_not_summon_the_whole_roster() {
        let rows: Vec<StrikeRow> = (0..1820).map(|_| row(2.0)).collect();
        let refs: Vec<&StrikeRow> = rows.iter().collect();
        // 6 HP x2 headroom = 12 damage = 6 shots at 2.0, not 1,820.
        assert_eq!(shots_to_kill(&refs, 6.0), 6);
    }

    #[test]
    fn a_floor_of_three_survives_a_miss() {
        let rows = vec![row(50.0), row(50.0), row(50.0), row(50.0)];
        let refs: Vec<&StrikeRow> = rows.iter().collect();
        assert_eq!(shots_to_kill(&refs, 1.0), 3);
    }

    #[test]
    fn everything_fires_when_everything_is_needed() {
        let rows = vec![row(1.0), row(1.0), row(1.0)];
        let refs: Vec<&StrikeRow> = rows.iter().collect();
        assert_eq!(shots_to_kill(&refs, 100.0), 3);
        assert_eq!(shots_to_kill(&[], 6.0), 0);
    }
}

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
///
/// `pub(crate)`: `auto_response` and `auto_raid` share this walk — firing
/// through a blocker wastes the whole volley (the blocker absorbs everything),
/// and both loops used to do exactly that while only the manual strike tool
/// stripped. Measured on 1-61's home: his Tank blocker ate seven straight
/// Mobile Artillery shots aimed at his Command Ship before falling.
pub(crate) async fn resolve_fire_target(
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
    // ── Fire only as many guns as the target is worth ──────────────────────
    //
    // The default used to be EVERY reachable struct, one shot each. On a
    // 1,820-player roster that planned 1,820 transactions and ~3,640 damage to
    // kill a 6 HP Ore Bunker — a 300x overkill that resets 1,820 workers'
    // charge to zero, stalling the whole economy for a full cycle to do six
    // damage. Proportionality has to be the default; `max` still overrides in
    // either direction for an operator who genuinely wants everything.
    let planned_all = shots.len();
    match params.max {
        Some(m) => shots.truncate(m.max(1)),
        None => {
            let want = shots_to_kill(&shots, plan.tgt_hp);
            shots.truncate(want);
        }
    }
    let held_back = planned_all - shots.len();

    let projected: f64 = shots.iter().map(|s| s.expected_dmg).sum();

    let note_line = if note.is_empty() { String::new() } else { format!("  ({})\n", note) };

    if params.dry_run {
        let mut out = format!(
            "structs_strike [{}] PLAN → fire {} (HP {:.0}) — {} attacker(s), one best shot each:\n{}",
            phase, plan.target_label, plan.tgt_hp, shots.len(), note_line
        );
        // A plan you cannot read is not a plan. Listing every shot produced a
        // 79,000-character answer that overflowed the tool's own token budget,
        // so the one output whose entire job is "check this before you fire"
        // was the one you could not see.
        for s in shots.iter().take(SHOT_PREVIEW) {
            out.push_str(&format!("  {} · {} [{}] → ~{:.1} dmg\n", s.player, s.struct_id, s.weapon, s.expected_dmg));
        }
        if shots.len() > SHOT_PREVIEW {
            out.push_str(&format!("  … and {} more like these\n", shots.len() - SHOT_PREVIEW));
        }
        if held_back > 0 {
            out.push_str(&format!(
                "  ({} further reachable struct(s) held back — this is enough to kill. `max` overrides.)\n",
                held_back
            ));
        }
        out.push_str(&format!(
            "Projected total ~{:.1} dmg vs {:.0} HP{}. Each shot resets that player's charge. Re-run without dry_run to fire.\n",
            projected,
            plan.tgt_hp,
            if projected >= plan.tgt_hp { " — KILL" } else { "" }
        ));
        return vec![Content::text(out)];
    }

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
                // Fire at the EFFECTIVE target. In a STRIP phase that is the
                // same-ambit blocker, not the struct it shields — previously the
                // plan was computed against the blocker but the shot was sent at
                // the protected struct, so every strip round was blocked.
                "operating_struct_id": s.struct_id,
                "target_struct_id": fire_target,
                "weapon_system": s.weapon,
                "charge_cost": cost,
            });
            match crate::mcp::tx_retry::submit_with_retry(app, "struct_attack", tx_args, "strike:primary").await {
                Ok(r) if r.success => {
                    fired += 1;
                    out.push_str(&format!("  ✓ you · {} [{}] → ~{:.1} dmg (queued; fires when charge ready)\n", s.struct_id, s.weapon, s.expected_dmg));
                }
                Ok(r) => out.push_str(&format!("  ✗ you · {}: {}\n", s.struct_id, r.error.unwrap_or_else(|| "rejected".into()))),
                Err(e) => out.push_str(&format!("  ✗ you · {}: {}\n", s.struct_id, e)),
            }
        } else if let Some(index) = s.hd_index {
            let wsys = if s.weapon.eq_ignore_ascii_case("secondary") {
                "secondaryWeapon"
            } else {
                "primaryWeapon"
            };
            let payload = json!({
                "operatingStructId": s.struct_id,
                "targetStructId": [fire_target.clone()],
                "weaponSystem": wsys,
            });
            match crate::mcp::tx_retry::sign_with_retry(
                app,
                index,
                "/structs.structs.MsgStructAttack",
                payload,
                &format!("strike:{}", s.player),
            )
            .await
            {
                Ok(_) => {
                    fired += 1;
                    out.push_str(&format!("  ✓ {} · {} [{}] → ~{:.1} dmg\n", s.player, s.struct_id, s.weapon, s.expected_dmg));
                }
                Err(e) => {
                    let short: String = e.chars().take(90).collect();
                    out.push_str(&format!("  ✗ {} · {}: {}\n", s.player, s.struct_id, short));
                }
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
