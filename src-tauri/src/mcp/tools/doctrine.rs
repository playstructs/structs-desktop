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
    // ── `lists` command ──
    /// lists: show | add | remove | mute | unmute. Named `list_action` so it
    /// doesn't collide with the top-level `command`.
    #[serde(default)]
    pub list_action: Option<String>,
    /// lists: grudge | priority_guild | ally | protected.
    #[serde(default)]
    pub kind: Option<String>,
    /// lists: the player id (grudge/protected) or guild id (priority_guild/ally).
    #[serde(default)]
    pub id: Option<String>,
    /// lists: priority multiplier for a grudge or guild.
    #[serde(default)]
    pub weight: Option<f64>,
    /// lists: free-text reason, shown on the WAR page.
    #[serde(default)]
    pub note: Option<String>,
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
            // The flywheel's missing link: infusing only ever had the
            // primary's own Alpha to work with unless the workers' Alpha gets
            // to the primary first.
            let mut sw = crate::mcp::auto_sweep::get();
            sw.enabled = true;
            crate::mcp::auto_sweep::set(sw);
            applied.push("auto_sweep loop → ON (worker alpha to the primary as it accumulates)".into());
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
            let mut sw = crate::mcp::auto_sweep::get();
            sw.enabled = true;
            crate::mcp::auto_sweep::set(sw);
            applied.push("auto_sweep loop → ON (worker alpha to the primary as it accumulates)".into());
            if let Ok(mut e) = POLICY_ENGINE.write() {
                e.set_policy("auto_refine", true, None);
                e.set_policy("combat_alert", true, None);
                e.set_policy("primary_home_guard", true, None);
            }
            applied.push("auto_refine + combat_alert + primary_home_guard policies → ON".into());
            Some(("defensive", "advise", true, Some(4), applied))
        }
        // Turtle, plus the two autonomous combat loops — armed but ADVISING.
        // Deliberately not `auto`: the response loop shoots and the raid loop
        // sends a fleet into someone else's guns, so the operator sees a few
        // rounds of proposals before either of them signs anything.
        "warfighter" => {
            let (_, _, _, _, mut applied) = preset_bundle("turtle")?;
            let mut r = crate::mcp::auto_response::get();
            r.enabled = true;
            r.autonomy = crate::mcp::auto_response::Autonomy::Advise;
            crate::mcp::auto_response::set(r);
            applied.push("auto_response loop → ON (advise — raid alarms produce a shot plan)".into());
            let mut rd = crate::mcp::auto_raid::get();
            rd.enabled = true;
            rd.autonomy = crate::mcp::auto_response::Autonomy::Advise;
            crate::mcp::auto_raid::set(rd);
            applied.push("auto_raid loop → ON (advise — targets are scored and ranked, not flown)".into());
            applied.push(
                "Set autonomy:\"auto\" on either loop (structs_players autoresponse / autoraid) once the proposals look right."
                    .into(),
            );
            Some(("defensive", "auto", true, Some(4), applied))
        }
        _ => None,
    }
}

/// Every preset name, for the tool description and the board's preset buttons.
pub const PRESETS: &[&str] = &["turtle", "economy", "balanced", "warfighter"];

pub async fn execute(params: DoctrineParams) -> Vec<Content> {
    match params.command.as_str() {
        "set" => set_doctrine(params),
        "show" => show_doctrine(),
        "tick" => tick_doctrine().await,
        "lists" => lists(params),
        other => vec![Content::text(format!(
            "structs_doctrine: unknown command '{}'. Use set | show | tick | lists.",
            other
        ))],
    }
}

/// `structs_doctrine lists` — read and edit the persistent grudge / priority-
/// guild / never-attack lists that both combat loops consult.
///
/// These live outside the policy store because they are row-oriented (the WAR
/// page edits one entry at a time), and outside either loop because both read
/// them: `auto_response` writes grudges as it observes attacks, `auto_raid`
/// reads them to decide who deserves a visit.
fn lists(p: DoctrineParams) -> Vec<Content> {
    use crate::mcp::combat_lists as cl;
    let action = p.list_action.as_deref().unwrap_or("show");
    let kind = p.kind.as_deref().unwrap_or("grudge");

    if action == "show" {
        let snap = cl::snapshot_json();
        let mut out = String::from("Combat lists\n");
        let grudges = snap.get("grudges").and_then(|g| g.as_array()).cloned().unwrap_or_default();
        if grudges.is_empty() {
            out.push_str("  Grudges: (none yet — auto_response adds one on every confirmed attack, or add one by hand)\n");
        } else {
            out.push_str("  Grudges (hottest first):\n");
            for g in grudges.iter().take(25) {
                let s = |k: &str| g.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let n = |k: &str| g.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
                out.push_str(&format!(
                    "    {} {} — {:.0} attacks, {:.0} structs lost, weight {:.1}, heat {:.2}{}{}\n",
                    s("player_id"),
                    if s("label").is_empty() { String::new() } else { format!("({})", s("label")) },
                    n("attacks"),
                    n("structs_lost"),
                    n("weight"),
                    n("heat"),
                    if g.get("muted").and_then(|v| v.as_bool()) == Some(true) { " [muted]" } else { "" },
                    if g.get("expired").and_then(|v| v.as_bool()) == Some(true) { " [lapsed]" } else { "" },
                ));
            }
        }
        let list = |k: &str| -> String {
            snap.get(k)
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "(none)".into())
        };
        out.push_str(&format!("  Priority guilds: {}\n", list("priority_guilds")));
        out.push_str(&format!("  Allied guilds (never attack): {}\n", list("allies")));
        out.push_str(&format!("  Protected players (never attack): {}\n", list("protected_players")));
        out.push_str("\nEdit with {command:\"lists\", list_action:\"add\"|\"remove\"|\"mute\"|\"unmute\", kind:\"grudge\"|\"priority_guild\"|\"ally\"|\"protected\", id, weight?, note?}.\n");
        return vec![Content::text(out)];
    }

    let Some(id) = p.id.clone().filter(|s| !s.is_empty()) else {
        return vec![Content::text(
            "lists: 'id' required (a player id for grudge/protected, a guild id for priority_guild/ally).".to_string(),
        )];
    };
    let msg = match (kind, action) {
        ("grudge", "remove") => {
            if cl::remove_grudge(&id) {
                format!("grudge on {id} removed")
            } else {
                format!("no grudge on {id}")
            }
        }
        ("grudge", "mute") | ("grudge", "unmute") => {
            let muted = action == "mute";
            if cl::set_muted(&id, muted) {
                format!("grudge on {id} {}", if muted { "muted (kept, but no longer acted on)" } else { "unmuted" })
            } else {
                format!("no grudge on {id}")
            }
        }
        ("grudge", _) => {
            let g = cl::upsert_grudge(&id, None, None, p.weight, p.note.clone(), Some(None));
            format!(
                "grudge on {id} → weight {:.1} (manual, never expires). auto_raid will prioritise it.",
                g.weight
            )
        }
        ("priority_guild", "remove") => {
            cl::remove_priority_guild(&id);
            format!("guild {id} removed from the priority list")
        }
        ("priority_guild", _) => {
            let g = cl::upsert_priority_guild(&id, None, p.weight);
            format!("guild {id} → priority weight {:.1}; every member gains that bonus", g.weight)
        }
        ("ally", a) => {
            let allied = a != "remove";
            cl::set_ally(&id, allied);
            format!(
                "guild {id} {} the never-attack list",
                if allied { "added to" } else { "REMOVED from" }
            )
        }
        ("protected", a) => {
            let prot = a != "remove";
            cl::set_protected(&id, prot);
            format!(
                "player {id} {} the never-attack list",
                if prot { "added to" } else { "REMOVED from" }
            )
        }
        (other, _) => format!("unknown kind '{other}' — use grudge | priority_guild | ally | protected."),
    };
    vec![Content::text(msg)]
}

/// Read the current doctrine (posture, pinned_target, autonomy) from the
/// rules_of_engagement policy config.
pub(crate) fn read_doctrine() -> (String, Option<String>, String) {
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
