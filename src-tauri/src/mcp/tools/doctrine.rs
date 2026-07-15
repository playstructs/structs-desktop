//! `structs_doctrine` — standing rules of engagement + a per-tick evaluator.
//!
//! The human sets the doctrine ONCE (posture, pinned target, auto-counter,
//! retreat threshold, autonomy). `tick` reads it against live state (threats,
//! charge, command-ship HP) and returns the prioritized next move WITHIN those
//! rails. Run `tick` on a loop and the agent holds the watch — executing the
//! doctrine through the normal action/strike tools and escalating to a human
//! prompt for anything beyond the standing mandate.
//!
//! The doctrine persists in the `rules_of_engagement` policy (survives restarts,
//! visible via `structs_intel intents`); `set` also flips the matching combat
//! policy toggles so the rest of the engine honors the same orders.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::json;

use crate::game_state::GAME_STATE;
use crate::mcp::policy::POLICY_ENGINE;

#[derive(Debug, Deserialize)]
pub struct DoctrineParams {
    /// "set" | "show" | "tick".
    pub command: String,
    /// set: defensive | aggressive | raid.
    #[serde(default)]
    pub posture: Option<String>,
    /// set: an enemy struct id to focus offense on (kill-chain target).
    #[serde(default)]
    pub pinned_target: Option<String>,
    /// set: auto-counter when attacked (drives the auto_counterattack policy).
    #[serde(default)]
    pub auto_counter: Option<bool>,
    /// set: retreat the fleet when the Command Ship HP drops below this.
    #[serde(default)]
    pub retreat_cmd_below: Option<u64>,
    /// set: "advise" (tick recommends; agent executes) | "auto" (tick green-lights
    /// defensive actions itself). Aggressive moves always stay advise/prompt.
    #[serde(default)]
    pub autonomy: Option<String>,
    /// set: one-call configuration bundle for new players — "turtle" (max
    /// defense), "economy" (mine→refine→infuse flywheel), or "balanced".
    /// Explicit fields in the same call override the preset's values.
    #[serde(default)]
    pub preset: Option<String>,
}

/// Apply a named preset: a coherent bundle of doctrine values + auto-loop
/// configs, replacing ~10 individual knob edits with one call. Returns
/// (posture, autonomy, auto_counter, retreat_hp, summary lines).
fn preset_bundle(name: &str) -> Option<(&'static str, &'static str, bool, Option<u64>, Vec<String>)> {
    let mut applied: Vec<String> = Vec::new();
    match name {
        // Maximum defense: fill slots with the defensive loadout, assign
        // defenders, keep the fleet home, counter when hit.
        "turtle" => {
            let mut b = crate::mcp::auto_build::get();
            b.enabled = true;
            crate::mcp::auto_build::set(b);
            applied.push("auto_build loop → ON (defensive loadout, power-gated)".into());
            let mut d = crate::mcp::auto_defend::get();
            d.enabled = true;
            crate::mcp::auto_defend::set(d);
            applied.push("auto_defend loop → ON (Command Ship first, then production)".into());
            if let Ok(mut e) = POLICY_ENGINE.write() {
                e.set_policy("primary_home_guard", true, None);
                e.set_policy("combat_alert", true, None);
            }
            applied.push("primary_home_guard + combat_alert policies → ON".into());
            Some(("defensive", "auto", true, Some(4), applied))
        }
        // Economy flywheel: mine → refine → infuse; combat stays notify-only.
        "economy" => {
            let mut h = crate::mcp::auto_harvest::get();
            h.enabled = true;
            h.refine = true;
            crate::mcp::auto_harvest::set(h);
            applied.push("auto_harvest loop → ON (mine + refine when difficulty is ripe)".into());
            let mut i = crate::mcp::auto_infuse::get();
            i.enabled = true;
            crate::mcp::auto_infuse::set(i);
            applied.push("auto_infuse loop → ON (excess alpha into the guild reactor)".into());
            if let Ok(mut e) = POLICY_ENGINE.write() {
                e.set_policy("auto_refine", true, None);
                e.set_policy("combat_alert", true, None);
            }
            applied.push("auto_refine + combat_alert policies → ON (combat stays notify-only)".into());
            Some(("defensive", "advise", false, None, applied))
        }
        // A bit of everything: economy loops + defense loops + counter.
        "balanced" => {
            for (label, on) in [("auto_harvest", true), ("auto_build", true), ("auto_defend", true)] {
                match label {
                    "auto_harvest" => {
                        let mut c = crate::mcp::auto_harvest::get();
                        c.enabled = on;
                        crate::mcp::auto_harvest::set(c);
                    }
                    "auto_build" => {
                        let mut c = crate::mcp::auto_build::get();
                        c.enabled = on;
                        crate::mcp::auto_build::set(c);
                    }
                    _ => {
                        let mut c = crate::mcp::auto_defend::get();
                        c.enabled = on;
                        crate::mcp::auto_defend::set(c);
                    }
                }
                applied.push(format!("{label} loop → ON"));
            }
            if let Ok(mut e) = POLICY_ENGINE.write() {
                e.set_policy("auto_refine", true, None);
                e.set_policy("combat_alert", true, None);
                e.set_policy("primary_home_guard", true, None);
            }
            applied.push("auto_refine + combat_alert + primary_home_guard policies → ON".into());
            Some(("defensive", "advise", true, Some(4), applied))
        }
        _ => None,
    }
}

pub async fn execute(params: DoctrineParams) -> Vec<Content> {
    match params.command.as_str() {
        "set" => set_doctrine(params),
        "show" => show_doctrine(),
        "tick" => tick_doctrine().await,
        other => vec![Content::text(format!(
            "structs_doctrine: unknown command '{}'. Use set | show | tick.",
            other
        ))],
    }
}

/// Read the current doctrine (posture, pinned_target, autonomy) from the
/// rules_of_engagement policy config.
fn read_doctrine() -> (String, Option<String>, String) {
    let engine = POLICY_ENGINE.read().ok();
    let cfg = engine
        .as_ref()
        .and_then(|e| e.policy_state("rules_of_engagement"))
        .map(|(_, c)| c)
        .unwrap_or_else(|| json!({}));
    let posture = cfg.get("posture").and_then(|v| v.as_str()).unwrap_or("defensive").to_string();
    let pinned = cfg.get("pinned_target").and_then(|v| v.as_str()).map(|s| s.to_string());
    let autonomy = cfg.get("autonomy").and_then(|v| v.as_str()).unwrap_or("advise").to_string();
    (posture, pinned, autonomy)
}

fn set_doctrine(p: DoctrineParams) -> Vec<Content> {
    let (cur_posture, cur_pinned, cur_autonomy) = read_doctrine();

    // A preset supplies the baseline; explicit fields still override it below.
    let mut preset_lines: Vec<String> = Vec::new();
    let (base_posture, base_autonomy, base_counter, base_retreat) = match p.preset.as_deref() {
        Some(name) => match preset_bundle(name) {
            Some((po, au, ac, rt, lines)) => {
                preset_lines = lines;
                (po.to_string(), au.to_string(), Some(ac), rt)
            }
            None => {
                return vec![Content::text(format!(
                    "structs_doctrine: unknown preset '{name}'. Available: turtle (max defense), economy (mine→refine→infuse), balanced."
                ))]
            }
        },
        None => (cur_posture, cur_autonomy, None, None),
    };

    let posture = p.posture.clone().unwrap_or(base_posture);
    let autonomy = p.autonomy.clone().unwrap_or(base_autonomy);
    // pinned_target: explicit value sets it; absent keeps current.
    let pinned = p.pinned_target.clone().or(cur_pinned);
    let auto_counter = p.auto_counter.or(base_counter);
    let retreat_cmd_below = p.retreat_cmd_below.or(base_retreat);

    let mut cfg = json!({ "posture": posture, "autonomy": autonomy });
    if let Some(t) = &pinned {
        cfg["pinned_target"] = json!(t);
    }

    let mut engine = match POLICY_ENGINE.write() {
        Ok(e) => e,
        Err(_) => return vec![Content::text("structs_doctrine: policy engine unavailable".to_string())],
    };
    engine.set_policy("rules_of_engagement", true, Some(cfg.clone()));
    // Mirror the standing orders onto the combat-policy toggles the engine evaluates.
    if let Some(ac) = auto_counter {
        engine.set_policy("auto_counterattack", ac, None);
    }
    if let Some(hp) = retreat_cmd_below {
        engine.set_policy("auto_retreat_if_cmd_below", true, Some(json!({ "hp": hp })));
    }
    drop(engine);

    let mut out = String::from("Doctrine set:\n");
    if let Some(name) = &p.preset {
        out.push_str(&format!("  preset: {} —\n", name));
        for line in &preset_lines {
            out.push_str(&format!("    • {}\n", line));
        }
    }
    out.push_str(&format!("  posture: {}\n", cfg.get("posture").and_then(|v| v.as_str()).unwrap_or("?")));
    out.push_str(&format!(
        "  pinned_target: {}\n",
        pinned.as_deref().unwrap_or("(none)")
    ));
    out.push_str(&format!("  autonomy: {}\n", cfg.get("autonomy").and_then(|v| v.as_str()).unwrap_or("?")));
    if let Some(ac) = auto_counter {
        out.push_str(&format!("  auto_counter: {}\n", ac));
    }
    if let Some(hp) = retreat_cmd_below {
        out.push_str(&format!("  retreat_cmd_below: HP {}\n", hp));
    }
    out.push_str("\nRun structs_doctrine {command:\"tick\"} on a loop to execute the doctrine.\n");
    vec![Content::text(out)]
}

fn show_doctrine() -> Vec<Content> {
    let (posture, pinned, autonomy) = read_doctrine();
    let engine = POLICY_ENGINE.read().ok();
    let on = |n: &str| engine.as_ref().and_then(|e| e.policy_state(n)).map(|(b, _)| b).unwrap_or(false);
    let mut out = String::from("Standing doctrine (rules of engagement)\n");
    out.push_str(&format!("  posture: {}\n", posture));
    out.push_str(&format!("  pinned_target: {}\n", pinned.as_deref().unwrap_or("(none)")));
    out.push_str(&format!("  autonomy: {}\n", autonomy));
    out.push_str(&format!("  auto_counterattack: {}\n", if on("auto_counterattack") { "ON" } else { "off" }));
    out.push_str(&format!("  auto_retreat_if_cmd_below: {}\n", if on("auto_retreat_if_cmd_below") { "ON" } else { "off" }));
    out.push_str("\nSet with structs_doctrine {command:\"set\", posture, pinned_target, auto_counter, retreat_cmd_below, autonomy}.\n");
    vec![Content::text(out)]
}

/// The loop body: read the doctrine, assess live state, return the prioritized
/// move(s) within the standing mandate.
async fn tick_doctrine() -> Vec<Content> {
    let (posture, pinned, autonomy) = read_doctrine();

    // Assess: command-ship HP + charge readiness (primary), team threats.
    let (charge_ready, cmd_hp, retreat_hp) = {
        let gs = GAME_STATE.read().unwrap();
        let charge_ready = gs.get_charge() >= 3; // cheapest attack threshold
        let cmd_hp = gs
            .structs
            .values()
            .find(|s| s.struct_type_name.as_deref().map(|n| n.contains("Command")).unwrap_or(false))
            .and_then(|s| s.health);
        let retreat_hp = POLICY_ENGINE
            .read()
            .ok()
            .and_then(|e| e.policy_state("auto_retreat_if_cmd_below"))
            .filter(|(on, _)| *on)
            .and_then(|(_, c)| c.get("hp").and_then(|v| v.as_f64()));
        (charge_ready, cmd_hp, retreat_hp)
    };
    let now = crate::hasher::types::now_millis();
    let (_, threats) = crate::mcp::tools::events::poll_team_threats(now - 120_000.0).await;

    let mut out = String::new();
    out.push_str(&format!("Doctrine tick — posture {} · autonomy {}\n", posture, autonomy));

    // Prioritized decision: retreat > defend > attack > hold.
    let mut plan: Vec<String> = Vec::new();

    if let (Some(hp), Some(thr)) = (cmd_hp, retreat_hp) {
        if hp < thr {
            plan.push(format!(
                "🛟 RETREAT — Command Ship HP {:.0} < {:.0}: move the fleet to your home planet (structs_action move_fleet).",
                hp, thr
            ));
        }
    }

    if !threats.is_empty() {
        let counter_on = POLICY_ENGINE
            .read()
            .ok()
            .and_then(|e| e.policy_state("auto_counterattack"))
            .map(|(b, _)| b)
            .unwrap_or(false);
        out.push_str(&format!("⚠ {} threat(s) active:\n", threats.len()));
        for t in threats.iter().take(6) {
            out.push_str(&format!("   {}\n", t));
        }
        if counter_on && posture != "defensive" {
            plan.push("⚔ COUNTER — identify the attacker (structs_intel battle_log), then structs_strike at it (or structs_players act attack as the hit player).".into());
        } else if counter_on {
            plan.push("🛡 COUNTER (defensive) — structs_intel battle_log to ID the attacker; counter only the aggressor, don't escalate.".into());
        } else {
            plan.push("🛡 HOLD FIRE — under attack but auto_counter is off; defenders are countering passively. Enable auto_counter or decide manually.".into());
        }
    }

    if matches!(posture.as_str(), "aggressive" | "raid") {
        if let Some(reason) = crate::mcp::policy::home_guard_block_reason() {
            plan.push(format!(
                "🏰 HOME GUARD — offense with the PRIMARY fleet is blocked: {} Use an expendable raider vplayer (structs_players act) for offense.",
                reason
            ));
        } else if let Some(t) = &pinned {
            if charge_ready {
                plan.push(format!(
                    "🎯 STRIKE — posture {} + charge ready: advance the kill-chain on pinned target {} (structs_strike {{target:\"{}\"}}).",
                    posture, t, t
                ));
                if posture == "raid" {
                    plan.push("   ↳ Once the target's Command Ship is down, move a fleet to its planet and raid for its stored ore.".into());
                }
            } else {
                plan.push(format!("🎯 PINNED {} — waiting on charge before the next strike.", t));
            }
        } else {
            plan.push("🎯 Posture is offensive but no pinned_target set — scout (structs_intel valid_targets) and pin one via structs_doctrine set.".into());
        }
    }

    if plan.is_empty() {
        plan.push("✓ HOLD — no threats, doctrine satisfied. Maintain mining/builds; bait is watching.".into());
    }

    out.push_str("Plan:\n");
    for step in &plan {
        out.push_str(&format!("  {}\n", step));
    }
    if autonomy == "auto" {
        out.push_str("\n(autonomy=auto) Execute the defensive steps now; surface a structs_ui prompt before any irreversible offensive move. Re-tick after acting.\n");
    } else {
        out.push_str("\n(autonomy=advise) Execute the top step via the named tool, then re-tick. Switch to autonomy=auto to let defensive responses fire without confirmation.\n");
    }
    vec![Content::text(out)]
}
