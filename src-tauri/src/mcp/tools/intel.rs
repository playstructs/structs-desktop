use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::game_state::{GameStateSync, GAME_STATE};
use crate::hasher::types::TaskRegistry;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::guild_api::fetch_all_pages;

/// Parse a JSON value that may be a number OR a string-encoded number into u64.
/// The guild API frequently returns numeric fields as strings (e.g.
/// `"last_action_block_height":"1337217"`), so naive `as_u64()` returns None.
fn json_to_u64(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

/// Float counterpart of [`json_to_u64`] — the Guild API returns `health` and
/// other numerics as strings, so `as_f64()` alone misses them.
fn json_to_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

/// Enemy struct HP isn't in the Guild API `struct/list/location` response — it
/// lives on the full LCD struct entity (`structAttributes.health` cur, string;
/// `Struct.health_max` max, number). Fetch it per struct. Returns "cur/max" (or
/// "cur") or None if the entity/health is unavailable.
async fn fetch_struct_hp(client: &CosmosClient, id: &str) -> Option<String> {
    let v = client.query_entity("struct", id).await.ok()?;
    let cur = v
        .get("structAttributes")
        .and_then(|sa| sa.get("health"))
        .and_then(json_to_f64);
    let max = v
        .get("Struct")
        .and_then(|s| s.get("health_max"))
        .and_then(json_to_f64)
        .or_else(|| v.get("health_max").and_then(json_to_f64));
    match (cur, max) {
        (Some(c), Some(m)) => Some(format!("{:.0}/{:.0}", c, m)),
        (Some(c), None) => Some(format!("{:.0}", c)),
        _ => None,
    }
}

/// Guild-API event `detail` fields arrive as a JSON-encoded STRING (NATS events
/// are pre-parsed objects; the Guild API is not). Return the detail as a parsed
/// object regardless of which form it came in as.
fn coerce_detail(detail: &Value) -> Value {
    match detail {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| detail.clone()),
        other => other.clone(),
    }
}

#[derive(Debug, Deserialize)]
pub struct IntelParams {
    /// Query type. Local-only: what_can_i_build, economy_status, plan_timeline.
    /// Guild-API-backed: planet_history, valid_targets, scout, market, metric_trend.
    /// Power: power_forecast (snapshot + trend if available).
    pub query: String,
    /// Query-specific arguments
    #[serde(default)]
    pub args: Value,
}

pub async fn execute(
    client: &CosmosClient,
    registry: &Arc<TaskRegistry>,
    params: IntelParams,
) -> Vec<Content> {
    match params.query.as_str() {
        // Local-only (no API calls)
        "whoami" => query_whoami(),
        "intents" => query_intents(),
        "ruleset" => query_ruleset(&params.args),
        "simulate" => query_simulate(client, &params.args).await,
        "what_can_i_build" => query_buildable(),
        "economy_status" => query_economy(registry),
        "plan_timeline" => query_timeline(registry, &params.args),
        // Power forecast: tries trend first, falls back to snapshot.
        "power_forecast" => query_power_forecast(client, &params.args).await,
        // Guild-API-backed analytical queries
        "planet_history" => query_planet_history(client, &params.args).await,
        "valid_targets" => query_valid_targets(client, &params.args).await,
        "strike_options" => query_strike_options(client, &params.args).await,
        "scout" => query_scout(client, &params.args).await,
        "battle_log" => query_battle_log(client, &params.args).await,
        "slot_map" => query_slot_map(client, &params.args).await,
        "is_active" => query_is_active(client, &params.args).await,
        "market" => query_market(client, &params.args).await,
        "metric_trend" => query_metric_trend(client, &params.args).await,
        // Raw entity access (absorbed from the retired structs_query tool):
        // read one entity, list a type, or run a Guild-API filtered query.
        "query" | "raw" => {
            let raw: RawQueryParams = match serde_json::from_value(params.args.clone()) {
                Ok(p) => p,
                Err(e) => {
                    return vec![Content::text(format!(
                        "Invalid raw-query args: {e}. Shape: {{type, id?, filter?:{{by,value}}, pagination_key?, limit?, page?}}"
                    ))]
                }
            };
            raw_query(client, raw).await
        }
        other => vec![Content::text(format!(
            "Unknown intel query '{}'. Available: whoami, intents, ruleset, simulate, strike_options, what_can_i_build, power_forecast, economy_status, plan_timeline, planet_history, valid_targets, scout, battle_log, slot_map, is_active, market, metric_trend, query (raw entity read/list/filter)",
            other
        ))],
    }
}

/// `intel.intents` — standing human→agent orders: rules-of-engagement and the
/// combat-policy toggles. Lets the agent honor what the human has set without
/// being told each turn. Set via structs_policy (e.g. set rules_of_engagement
/// {posture:"aggressive", pinned_target:"5-1728"}).
fn query_intents() -> Vec<Content> {
    let engine = match crate::mcp::policy::POLICY_ENGINE.read() {
        Ok(e) => e,
        Err(_) => return vec![Content::text("intents: policy engine unavailable".to_string())],
    };
    let mut out = String::new();
    out.push_str("Standing intents (set via structs_policy)\n");
    match engine.policy_state("rules_of_engagement") {
        Some((enabled, cfg)) => out.push_str(&format!(
            "  Rules of engagement: {} — {}\n",
            if enabled { "ACTIVE" } else { "off" },
            serde_json::to_string(&cfg).unwrap_or_default()
        )),
        None => out.push_str("  Rules of engagement: (unset)\n"),
    }
    for p in ["auto_counterattack", "auto_retreat_if_cmd_below", "auto_rebuild_losses"] {
        if let Some((enabled, cfg)) = engine.policy_state(p) {
            out.push_str(&format!(
                "  {}: {} {}\n",
                p,
                if enabled { "ON" } else { "off" },
                serde_json::to_string(&cfg).unwrap_or_default()
            ));
        }
    }
    out.push_str("\nHonor any ON order when you observe its trigger (watch structs_events / battle_log), acting through structs_action or structs_sequence. These are standing orders for you to follow — the engine does not auto-sign on your behalf.\n");
    vec![Content::text(out)]
}

/// `intel.ruleset` — the combat rules + weapon matrix, data-driven from synced
/// struct types, so players don't reverse-engineer mechanics from logs.
/// Args: `{ struct_type? }` to focus on one type; otherwise lists all with weapons.
fn query_ruleset(args: &Value) -> Vec<Content> {
    use crate::mcp::tools::format::decode_ambits;
    let gs = GAME_STATE.read().unwrap();
    let focus = args.get("struct_type").and_then(|v| v.as_str());

    let mut out = String::new();
    out.push_str("Combat rules\n");
    out.push_str("  • Ambits: Water=2, Land=4, Air=8, Space=16. A weapon can only hit ambits in its reach mask.\n");
    out.push_str("  • Damage = Σ(landed shots) − target armour (attack_reduction), floored at 1 if any shot lands, capped at HP.\n");
    out.push_str("  • Each shot lands with probability numerator/denominator; total damage = Σ(landed shots × damage).\n");
    out.push_str("  • Counter: a counter-attack fires same-ambit at full value, cross-ambit at half. Defenders counter but take no counter-damage.\n");
    out.push_str("  • Block: a defender must share the target's ambit and the weapon must be blockable.\n");
    out.push_str("  • A fleet AWAY from its home planet cannot defend planetary structs there.\n");
    // Measured on 2-7354 (2026-08-07), six shots, one cannon: every shot at the
    // planet-borne Ore Bunker took 1 cannon damage back; every shot at the
    // fleet-borne Command Ship took 0. The distinction is the TARGET's
    // locationType, and it makes decapitation materially cheaper than the shot
    // count suggests — you only pay the cannon while stripping planet blockers.
    out.push_str("  • Planetary Defense Cannons fire back only when you hit a struct standing ON THE PLANET. \
A struct on the defender's FLEET (their Command Ship included) draws no cannon fire.\n");
    // The per-struct contribution is NOT flat — measured on 2-7354: an Orbital
    // Shield Generator is worth 25 (238 → 213 destroying one), an Ore Bunker 50
    // (288 → 238), and one struct in the build-up added only 13. An earlier
    // draft of this line claimed a flat 50 and was wrong.
    out.push_str("  • Each defensive struct brought online RAISES the planetary shield, by an amount that \
depends on its TYPE (measured: Orbital Shield Generator 25, Ore Bunker 50); destroying one gives that back. \
Shield is the raid proof's decay range and the chain tracks it LIVE, so stripping defences mid-raid \
genuinely shortens the proof you still have to grind.\n\n");
    out.push_str("Weapon matrix\n");

    let mut types: Vec<_> = gs.struct_types.values().collect();
    types.sort_by_key(|t| t.id);
    for t in types {
        if let Some(f) = focus {
            if !t.name.eq_ignore_ascii_case(f) {
                continue;
            }
        }
        let has_weapon = t.primary_weapon_ambits.unwrap_or(0) != 0 || t.secondary_weapon_ambits.unwrap_or(0) != 0;
        if focus.is_none() && !has_weapon {
            continue;
        }
        out.push_str(&format!(
            "\n{} (#{}) — operates [{}]",
            t.name,
            t.id,
            t.possible_ambit.map(decode_ambits).unwrap_or_else(|| "?".to_string())
        ));
        // HP belongs beside armour: every damage number in this matrix is only
        // meaningful against the health it has to chew through, and "how many
        // shots to kill" was previously unanswerable from the combat tool.
        if let Some(hp) = t.max_health {
            out.push_str(&format!(" · {} HP", hp));
        }
        if let Some(r) = t.attack_reduction {
            if r > 0 {
                out.push_str(&format!(" · armour −{}", r));
            }
        }
        if t.has_stealth_system == Some(true) {
            out.push_str(" · stealth");
        }
        out.push('\n');
        let weapon_line = |label: &str, ambits: Option<u64>, wtype: &Option<String>, ctrl: &Option<String>,
                           shots: Option<u64>, dmg: Option<u64>, gtd: Option<u64>,
                           num: Option<u64>, den: Option<u64>, blockable: Option<bool>, counterable: Option<bool>,
                           piercing: Option<bool>| -> Option<String> {
            let a = ambits.unwrap_or(0);
            if a == 0 { return None; }
            // This chain version has no guaranteed-shots field (always 0); only
            // show it if some future type actually carries one.
            let g = gtd.unwrap_or(0);
            let hit = if g > 0 {
                format!("{} guaranteed + {}/{} per-shot", g, num.unwrap_or(0), den.unwrap_or(1))
            } else {
                format!("{}/{} per-shot hit", num.unwrap_or(0), den.unwrap_or(1))
            };
            Some(format!(
                "  {}: reach [{}] · {}×{} dmg · {} · {}{} · {}{}",
                label,
                decode_ambits(a),
                shots.unwrap_or(0),
                dmg.unwrap_or(0),
                hit,
                wtype.clone().unwrap_or_default(),
                ctrl.clone().map(|c| format!("/{}", c)).unwrap_or_default(),
                if blockable == Some(true) { "blockable" } else { "unblockable" },
                if counterable == Some(true) { ", counterable" } else { "" },
            ) + if piercing == Some(true) { " · ARMOUR-PIERCING\n" } else { "\n" })
        };
        if let Some(l) = weapon_line("primary", t.primary_weapon_ambits, &t.primary_weapon, &t.primary_weapon_control,
            t.primary_weapon_shots, t.primary_weapon_damage, t.primary_weapon_guaranteed_shots,
            t.primary_weapon_shot_success_numerator, t.primary_weapon_shot_success_denominator,
            t.primary_weapon_blockable, t.primary_weapon_counterable,
            t.primary_weapon_armour_piercing) {
            out.push_str(&l);
        }
        if let Some(l) = weapon_line("secondary", t.secondary_weapon_ambits, &t.secondary_weapon, &t.secondary_weapon_control,
            t.secondary_weapon_shots, t.secondary_weapon_damage, t.secondary_weapon_guaranteed_shots,
            t.secondary_weapon_shot_success_numerator, t.secondary_weapon_shot_success_denominator,
            t.secondary_weapon_blockable, t.secondary_weapon_counterable,
            t.secondary_weapon_armour_piercing) {
            out.push_str(&l);
        }
        if t.counter_attack.unwrap_or(0) > 0 || t.counter_attack_same_ambit.unwrap_or(0) > 0 {
            out.push_str(&format!(
                "  counter: {} same-ambit / {} cross-ambit\n",
                t.counter_attack_same_ambit.unwrap_or(0),
                t.counter_attack.unwrap_or(0)
            ));
        }
        // ── Evasion ──
        // The defender's own dodge rates against each control type. These are
        // what decide guided-vs-unguided, and the matrix asked you to choose a
        // weapon without showing them.
        let rate = |n: Option<u64>, d: Option<u64>| -> Option<String> {
            match (n, d) {
                (Some(n), Some(d)) if d > 0 && n > 0 => Some(format!("{}/{}", n, d)),
                _ => None,
            }
        };
        let ev_g = rate(t.guided_defensive_success_rate_numerator, t.guided_defensive_success_rate_denominator);
        let ev_u = rate(t.unguided_defensive_success_rate_numerator, t.unguided_defensive_success_rate_denominator);
        if ev_g.is_some() || ev_u.is_some() {
            out.push_str(&format!(
                "  evades: {} vs guided · {} vs unguided{}\n",
                ev_g.unwrap_or_else(|| "never".into()),
                ev_u.unwrap_or_else(|| "never".into()),
                t.unit_defenses_label.clone()
                    .or_else(|| t.unit_defenses.clone())
                    .filter(|d| !d.starts_with("no"))
                    .map(|d| format!(" ({})", d))
                    .unwrap_or_default(),
            ));
        }
        // ── Consequences of destroying it ──
        // `trigger_raid_defeat_by_destruction` is the entire basis of the
        // decapitate doctrine — kill this and the raid ends — and it was not
        // surfaced anywhere. Same for the shield a struct props up, which is
        // what makes Ore Bunkers worth shooting before the Command Ship.
        let mut on_death: Vec<String> = Vec::new();
        if t.trigger_raid_defeat_by_destruction == Some(true) {
            on_death.push("destroying it ENDS A RAID".into());
        }
        if let Some(c) = t.planetary_shield_contribution {
            if c > 0 {
                on_death.push(format!("carries {} planetary shield", c));
            }
        }
        if let Some(p) = t.post_destruction_damage {
            if p > 0 {
                on_death.push(format!("{} splash damage on death", p));
            }
        }
        if !on_death.is_empty() {
            out.push_str(&format!("  on destruction: {}\n", on_death.join(" · ")));
        }
        // ── What a shot costs ──
        // Charge is the real limiter on how often anything can fire, and recoil
        // is self-damage the attacker eats.
        let cost = |label: &str, ch: Option<u64>, recoil: Option<u64>, ambits: Option<u64>| -> Option<String> {
            if ambits.unwrap_or(0) == 0 { return None; }
            let mut bits = vec![format!("{} charge", ch.unwrap_or(0))];
            if recoil.unwrap_or(0) > 0 {
                bits.push(format!("{} recoil", recoil.unwrap_or(0)));
            }
            Some(format!("{} {}", label, bits.join(", ")))
        };
        let costs: Vec<String> = [
            cost("primary", t.primary_weapon_charge, t.primary_weapon_recoil_damage, t.primary_weapon_ambits),
            cost("secondary", t.secondary_weapon_charge, t.secondary_weapon_recoil_damage, t.secondary_weapon_ambits),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !costs.is_empty() {
            out.push_str(&format!("  cost to fire: {}\n", costs.join(" · ")));
        }
    }
    if !gs.struct_types.values().any(|t| t.primary_weapon_shots.is_some()) {
        out.push_str("\n(Combat fields not yet synced — reconnect/reload the app so struct types carry weapon stats.)\n");
    }
    vec![Content::text(out)]
}

/// `intel.simulate` — preview an attack before committing.
/// Args: `{ attacker, target, weapon?="primary" }` (structs resolved from game
/// state); or override the target with `{ target_type, target_hp?, target_ambit? }`.
async fn query_simulate(client: &CosmosClient, args: &Value) -> Vec<Content> {
    use crate::mcp::combat::{simulate, DefenseProfile, WeaponStats};
    use crate::mcp::tools::format::{ambit_bit, decode_ambits};

    let weapon = args.get("weapon").and_then(|v| v.as_str()).unwrap_or("primary");
    let secondary = weapon.eq_ignore_ascii_case("secondary");

    let attacker_id = match args.get("attacker").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return vec![Content::text("simulate: missing required arg 'attacker' (a struct id — yours or a virtual player's).".to_string())],
    };

    // Resolve the attacker's (struct type id, operating ambit). Prefer the synced
    // primary-player state; fall back to an LCD lookup so the agent can also plan
    // attacks for a virtual player's (or any visible) struct — not just its own.
    let resolved = {
        let gs = GAME_STATE.read().unwrap();
        gs.structs
            .get(attacker_id)
            .map(|s| (s.struct_type_id.to_string(), s.operating_ambit.clone()))
    };
    let (att_type_id, att_ambit) = match resolved {
        Some(v) => v,
        None => match client.query_entity("struct", attacker_id).await {
            Ok(v) => {
                let st = v.get("Struct");
                let tid = st.and_then(|s| s.get("type")).and_then(|x| match x {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                });
                let amb = st
                    .and_then(|s| s.get("operatingAmbit"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                match tid {
                    Some(tid) => (tid, amb),
                    None => {
                        return vec![Content::text(format!(
                            "simulate: couldn't resolve attacker {}'s struct type from the chain.",
                            attacker_id
                        ))]
                    }
                }
            }
            Err(e) => {
                return vec![Content::text(format!(
                    "simulate: attacker {} not in your game state and the chain lookup failed: {}",
                    attacker_id, e
                ))]
            }
        },
    };
    let att_ambit_bit = att_ambit.as_deref().map(ambit_bit).unwrap_or(0);

    // Pre-resolve a target given by id BEFORE taking the lock (chain fetch needs
    // an await). Enemy structs live on foreign planets and are NOT in local
    // gs.structs, so an id-only lookup against gameState always missed — fetch
    // from the chain (type/ambit/HP) when it isn't local. Mirrors strike_options.
    let target_resolved: Option<(String, String, f64)> = match args.get("target").and_then(|v| v.as_str()) {
        Some(tid) => {
            let local = {
                let gs = GAME_STATE.read().unwrap();
                gs.structs.get(tid).map(|ts| {
                    let tt = gs.struct_types.get(&ts.struct_type_id.to_string());
                    (
                        ts.struct_type_id.to_string(),
                        ts.operating_ambit.clone().unwrap_or_default(),
                        ts.health.unwrap_or_else(|| tt.and_then(|t| t.max_health).unwrap_or(0.0)),
                    )
                })
            };
            match local {
                Some(v) => Some(v),
                None => match client.query_entity("struct", tid).await {
                    Ok(v) => {
                        let st = v.get("Struct");
                        let type_id = st.and_then(|s| s.get("type")).and_then(|x| match x {
                            Value::String(s) => Some(s.clone()),
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        });
                        let ambit = st
                            .and_then(|s| s.get("operatingAmbit"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let hp = v
                            .get("structAttributes")
                            .and_then(|sa| sa.get("health"))
                            .and_then(json_to_f64)
                            .or_else(|| st.and_then(|s| s.get("health_max")).and_then(json_to_f64))
                            .unwrap_or(0.0);
                        match type_id {
                            Some(t) => Some((t, ambit, hp)),
                            None => return vec![Content::text(format!(
                                "simulate: couldn't resolve target {}'s struct type from the chain.", tid
                            ))],
                        }
                    }
                    Err(e) => return vec![Content::text(format!("simulate: target {} lookup failed: {}", tid, e))],
                },
            }
        }
        None => None,
    };

    // No await past here — safe to hold the GAME_STATE lock for the rest.
    let gs = GAME_STATE.read().unwrap();
    let att_type = match gs.struct_types.get(&att_type_id) {
        Some(t) => t,
        None => return vec![Content::text("simulate: attacker struct type unknown (combat fields not synced?).".to_string())],
    };

    let w = WeaponStats::from_type(att_type, secondary);
    if w.shots == 0 && w.damage == 0 {
        return vec![Content::text(format!(
            "simulate: no {} weapon data for {} — combat fields may not be synced yet (reload the app).",
            weapon, att_type.name
        ))];
    }

    // Resolve target: the pre-fetched struct (local or chain), or explicit overrides.
    let defense_of = |tt: Option<&crate::game_state::StructTypeInfo>| {
        (
            tt.map(DefenseProfile::from_type).unwrap_or_default(),
            tt.and_then(|t| t.unit_defenses.clone()).unwrap_or_else(|| "unit".to_string()),
        )
    };
    let (tgt_name, tgt_hp, tgt_ambit_bit, defense, defense_label) = if let Some((tgt_type_id, tgt_ambit, tgt_hp)) = &target_resolved {
        let tt = gs.struct_types.get(tgt_type_id);
        let (d, label) = defense_of(tt);
        (
            tt.map(|t| t.name.clone()).unwrap_or_else(|| "target".to_string()),
            *tgt_hp,
            ambit_bit(tgt_ambit),
            d,
            label,
        )
    } else if let Some(tt_name) = args.get("target_type").and_then(|v| v.as_str()) {
        let tt = gs.struct_types.values().find(|t| t.name.eq_ignore_ascii_case(tt_name));
        let hp = args.get("target_hp").and_then(|v| v.as_f64())
            .unwrap_or_else(|| tt.and_then(|t| t.max_health).unwrap_or(0.0));
        let ab = args.get("target_ambit").and_then(|v| v.as_str()).map(ambit_bit).unwrap_or(0);
        let (d, label) = defense_of(tt);
        (tt_name.to_string(), hp, ab, d, label)
    } else {
        return vec![Content::text("simulate: provide 'target' (a visible struct id) or 'target_type' (+ optional target_hp/target_ambit).".to_string())];
    };
    let reduction = defense.reduction;

    let same_ambit = att_ambit_bit != 0 && att_ambit_bit == tgt_ambit_bit;
    let r = simulate(&w, tgt_ambit_bit, tgt_hp, &defense, same_ambit);

    let mut out = String::new();
    out.push_str(&format!(
        "Simulate: {} ({} weapon, {}, reach [{}]) → {} (HP {:.0}, armour −{}{})\n",
        att_type.name,
        weapon,
        w.control.as_str(),
        decode_ambits(w.ambits),
        tgt_name,
        tgt_hp,
        // `r.reduction` is 0 when the weapon is armour-piercing, whatever the
        // target's armour says — report what will actually apply.
        r.reduction,
        if w.armour_piercing && reduction > 0 {
            format!(", armour {reduction} PIERCED")
        } else {
            String::new()
        }
    ));
    if !r.reachable {
        out.push_str("  ✗ OUT OF REACH — this weapon cannot hit the target's ambit. No damage.\n");
        return vec![Content::text(out)];
    }
    out.push_str(&format!(
        "  Damage → min {:.0} · expected {:.1} · max {:.0}  (target HP {:.0})\n",
        r.min_damage, r.expected_damage, r.max_damage, r.target_hp
    ));
    if r.evade_chance > 0.0 {
        // Evasion is rolled ONCE per target: on a successful evade the whole
        // volley misses, so "expected" is already discounted by this.
        out.push_str(&format!(
            "  ⚠ Evasion: {:.0}% chance the WHOLE volley misses ({} defense vs {} ordnance) — min/max are the non-evaded case.\n",
            r.evade_chance * 100.0,
            defense_label,
            w.control.as_str()
        ));
    }
    out.push_str(&format!(
        "  Kill → {}\n",
        if r.kills_min { "GUARANTEED (even minimum hits drop it)" }
        else if r.kills_expected { "likely (expected damage ≥ HP)" }
        else { "no (won't drop it this attack)" }
    ));
    if r.recoil_to_attacker > 0 {
        out.push_str(&format!("  Recoil to attacker: {}\n", r.recoil_to_attacker));
    }
    if r.counter_estimate > 0 {
        out.push_str(&format!(
            "  Counter risk: ~{} dmg back if the target counters ({} ambit){}\n",
            r.counter_estimate,
            if same_ambit { "same" } else { "cross" },
            if r.kills_expected { " — but a kill prevents the target's own counter" } else { "" }
        ));
    }
    if w.blockable {
        out.push_str("  Blockable: a defender sharing the TARGET's ambit can absorb this shot — strip same-ambit blockers first (structs_strike does this automatically).\n");
    }
    out.push_str("  (Estimate from synced struct stats; defender blocks/counters and evasion rolls can shift the result.)\n");
    vec![Content::text(out)]
}

/// One team struct's option against a target.
#[derive(Debug, Clone)]
pub struct StrikeRow {
    /// Display label — the vplayer's name, or `"you"` for the primary.
    pub player: String,
    /// The owning player's chain id (`1-xxx`). Lets callers reach roster data
    /// (charge, online) without a name→id round trip.
    pub player_id: Option<String>,
    /// HD index for façade signing; `None` for the primary (webview queue).
    pub hd_index: Option<u32>,
    pub struct_id: String,
    pub weapon: String,
    /// Evasion-aware expected damage — the honest, chain-derived number.
    pub expected_dmg: f64,
    pub reachable: bool,
    /// Ambit this shooter fires FROM (bitmask), which decides counter exposure.
    pub att_ambit_bit: u64,
    /// How many of the target's defenders can counter into this shooter's ambit.
    /// 0 is the free shot the docs call "the single biggest combat lever".
    pub counter_exposure: usize,
    /// Ranking score: expected damage after the planetary interceptor heuristic,
    /// penalised by counter risk. Ordering only — never shown as damage.
    pub score: f64,
    pub control: crate::mcp::combat::WeaponControl,
}

/// A computed team strike plan against a resolved target.
#[derive(Debug, Clone)]
pub struct StrikePlan {
    pub target_id: Option<String>,
    pub target_label: String,
    pub tgt_ambit_bit: u64,
    pub tgt_hp: f64,
    pub reduction: u64,
    /// Bitmask of ambits from which NO registered defender can counter — the
    /// zero-counter-damage lever. 0 when the target wasn't given by id.
    pub counter_free: u64,
    pub rows: Vec<StrikeRow>,
}

/// Plan a team-wide strike: resolve the target, gather every team combat struct
/// (primary + each virtual player), and simulate each one's best reaching weapon.
/// Shared by `strike_options` (display) and `structs_strike` (execute).
pub async fn plan_strike(client: &CosmosClient, args: &Value) -> Result<StrikePlan, String> {
    use crate::mcp::combat::{
        counter_exposure, shooter_score, simulate, DefenseProfile, InterceptorNet, WeaponStats,
    };
    use crate::mcp::tools::format::ambit_bit;

    let num_or_str = |x: &Value| match x {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };

    let target_id_arg = args.get("target").and_then(|v| v.as_str()).map(|s| s.to_string());
    // Optional scoping — the combat loops pass a candidate subset so a strike
    // plan doesn't have to resolve all ~180 vplayers' fleets.
    let only_players: Option<std::collections::HashSet<String>> = args
        .get("players")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect());

    // ── Resolve the target: ambit, HP, armour, counters, evasion. ──
    // Planet the target sits on, if any — its interceptor network is a second
    // evasion layer against guided ordnance.
    let mut target_planet: Option<String> = None;
    // The target's owner never shoots at its own struct — see the `retain` below.
    let mut target_owner: Option<String> = None;
    let (target_label, tgt_ambit_bit, tgt_hp, defense, target_is_planetary) =
        if let Some(tid) = args.get("target").and_then(|v| v.as_str()) {
            match client.query_entity("struct", tid).await {
                Ok(v) => {
                    let st = v.get("Struct");
                    // Where the target actually STANDS. A struct on a planet
                    // names the planet directly; a struct on a FLEET names the
                    // fleet, so resolve one hop further to the planet the fleet
                    // is at.
                    //
                    // Only the planet case was handled, which left
                    // `target_planet` empty for every fleet-borne target — and
                    // the defender's COMMAND SHIP, the whole point of a raid
                    // kill-chain, is exactly that. With no planet the
                    // co-location filter silently disables itself and the
                    // planner goes back to offering the entire roster: six
                    // players from six different planets, all six rejected by
                    // the chain as unreachable.
                    let loc_type = st
                        .and_then(|s| s.get("locationType"))
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let loc_id = st
                        .and_then(|s| s.get("locationId"))
                        .and_then(|x| x.as_str())
                        .map(String::from);
                    target_planet = match (loc_type.as_str(), loc_id) {
                        ("planet", id) => id,
                        ("fleet", Some(fid)) => client
                            .query_entity("fleet", &fid)
                            .await
                            .ok()
                            .and_then(|f| {
                                f.get("Fleet")
                                    .and_then(|x| x.get("locationId"))
                                    .and_then(|x| x.as_str())
                                    .map(String::from)
                            }),
                        _ => None,
                    };
                    target_owner = st
                        .and_then(|s| s.get("owner"))
                        .and_then(|x| x.as_str())
                        .filter(|o| !o.is_empty())
                        .map(String::from);
                    let type_id = st.and_then(|s| s.get("type")).and_then(&num_or_str);
                    let ambit = st
                        .and_then(|s| s.get("operatingAmbit"))
                        .and_then(|x| x.as_str())
                        .map(ambit_bit)
                        .unwrap_or(0);
                    let hp = v
                        .get("structAttributes")
                        .and_then(|sa| sa.get("health"))
                        .and_then(json_to_f64)
                        .or_else(|| st.and_then(|s| s.get("health_max")).and_then(json_to_f64))
                        .unwrap_or(0.0);
                    let on_planet = st
                        .and_then(|s| s.get("locationType"))
                        .and_then(|x| x.as_str())
                        .map(|l| l.eq_ignore_ascii_case("planet"))
                        .unwrap_or(false);
                    let gs = GAME_STATE.read().unwrap();
                    let t = type_id.as_ref().and_then(|t| gs.struct_types.get(t));
                    (
                        format!("{}{}", tid, t.map(|t| format!(" ({})", t.name)).unwrap_or_default()),
                        ambit,
                        hp,
                        t.map(DefenseProfile::from_type).unwrap_or_default(),
                        on_planet,
                    )
                }
                Err(e) => {
                    return Err(format!("target {} lookup failed: {}", tid, e))
                }
            }
        } else if let Some(tt) = args.get("target_type").and_then(|v| v.as_str()) {
            let gs = GAME_STATE.read().unwrap();
            let t = gs.struct_types.values().find(|t| t.name.eq_ignore_ascii_case(tt));
            let ambit = args.get("target_ambit").and_then(|v| v.as_str()).map(ambit_bit).unwrap_or(0);
            let hp = args
                .get("target_hp")
                .and_then(|v| v.as_f64())
                .or_else(|| t.and_then(|t| t.max_health))
                .unwrap_or(0.0);
            let planetary = t
                .and_then(|t| t.category.as_deref())
                .map(|c| c.eq_ignore_ascii_case("planet"))
                .unwrap_or(false);
            (
                tt.to_string(),
                ambit,
                hp,
                t.map(DefenseProfile::from_type).unwrap_or_default(),
                planetary,
            )
        } else {
            return Err(
                "provide 'target' (enemy struct id) or 'target_type' (+ target_ambit, target_hp?).".to_string(),
            );
        };
    let reduction = defense.reduction;

    // ── Counter exposure: which ambits the target's registered defenders can
    // reach. Firing from an uncovered ambit costs zero counter damage. ──
    let defender_masks: Vec<u64> = match &target_id_arg {
        Some(tid) => defender_weapon_masks(client, tid).await,
        None => vec![],
    };
    // The planet's interceptor network only bites guided ordnance aimed at a
    // struct sitting on that planet. Its rate is chain-exposed (e.g. 1/3 per
    // interceptor), so this is real data, not a guess.
    let interceptors = match &target_planet {
        Some(p) => client
            .query_entity("planet", p)
            .await
            .ok()
            .map(|e| InterceptorNet::from_planet_attributes(e.get("planetAttributes")))
            .unwrap_or_default(),
        None => InterceptorNet::default(),
    };

    // ── Who is actually THERE ────────────────────────────────────────────
    // Combat is co-located: a struct can only fire at something at the same
    // planet. Without this the planner ranked every reachable struct the team
    // owns — 1,820 of them across 1,800 planets for one 6 HP bunker — and the
    // chain rejected every single shot with "target struct is unreachable".
    // `None` (an unresolvable target planet) means no filter rather than a
    // silently empty plan.
    let here: Option<std::collections::HashSet<String>> = match &target_planet {
        Some(p) => Some(crate::mcp::spectator::locations_at_planet(client, p).await),
        None => None,
    };
    let colocated = |loc: Option<&str>| -> bool {
        match (&here, loc) {
            (None, _) => true,
            (Some(set), Some(l)) => set.contains(l),
            (Some(_), None) => false,
        }
    };

    // ── Gather attackers: (label, player_id, hd_index, struct_id, type_id, ambit_bit). ──
    // Primary from GAME_STATE; each virtual player from its planet/fleet slots.
    type Attacker = (String, Option<String>, Option<u32>, String, String, u64);
    let mut attackers: Vec<Attacker> = Vec::new();
    {
        let gs = GAME_STATE.read().unwrap();
        if let Some(me) = gs.player_id.clone() {
            if only_players.as_ref().map(|s| s.contains(&me)).unwrap_or(true) {
                for (id, s) in gs.structs.iter() {
                    if s.owner != me || s.status & 2 == 0 || s.status & 32 != 0 {
                        continue;
                    }
                    if !colocated(s.location_id.as_deref()) {
                        continue;
                    }
                    let bit = s.operating_ambit.as_deref().map(ambit_bit).unwrap_or(0);
                    attackers.push((
                        "you".to_string(),
                        Some(me.clone()),
                        None,
                        id.clone(),
                        s.struct_type_id.to_string(),
                        bit,
                    ));
                }
            }
        }
    }
    let vplayers: Vec<(String, String, u32)> = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
        reg.players
            .iter()
            .filter_map(|p| p.player_id.clone().map(|id| (p.name.clone(), id, p.index)))
            .filter(|(_, id, _)| only_players.as_ref().map(|s| s.contains(id)).unwrap_or(true))
            .collect()
    };
    // Resolve every vplayer's fleet concurrently off the TTL'd composition cache.
    // The old code walked the roster serially through the guild `struct/list/owner`
    // endpoint, which IGNORES its owner filter and returns a global page — so every
    // vplayer contributed the same 100 foreign structs and the plan was nonsense.
    // See loop_util::player_struct_ids for the endpoint bug.
    let resolved = {
        let client = client.clone();
        crate::mcp::loop_util::map_concurrent(
            vplayers,
            crate::mcp::loop_util::effective_max_concurrent(),
            move |(name, pid, index)| {
                let client = client.clone();
                async move {
                    let structs = crate::mcp::loop_util::player_structs_cached(
                        &client,
                        &pid,
                        crate::mcp::loop_util::STRUCTS_CACHE_TTL_MS,
                    )
                    .await;
                    (name, pid, index, structs)
                }
            },
        )
        .await
    };
    for (name, pid, index, structs) in resolved {
        for v in structs.iter() {
            if crate::mcp::loop_util::parse_bool(v.get("is_destroyed"))
                || !crate::mcp::loop_util::parse_bool(v.get("is_built"))
            {
                continue;
            }
            let Some(id) = v.get("id").and_then(|x| x.as_str()) else { continue };
            if !colocated(v.get("location_id").and_then(|x| x.as_str())) {
                continue;
            }
            let type_id = v
                .get("type")
                .or_else(|| v.get("struct_type"))
                .and_then(&num_or_str)
                .unwrap_or_default();
            let bit = v.get("operating_ambit").and_then(|x| x.as_str()).map(ambit_bit).unwrap_or(0);
            attackers.push((name.clone(), Some(pid.clone()), Some(index), id.to_string(), type_id, bit));
        }
    }

    // ── Simulate each attacker's best reaching weapon against the target. ──
    // A player never attacks its own struct. Co-location alone does not exclude
    // the TARGET'S OWNER — they are by definition standing at their own planet —
    // so when the owner is a teammate the planner happily proposed that they
    // shoot their own blocker. Seen live: a strike on miner10's Command Ship
    // listed "miner10 · 5-2421" as an attacker against miner10's own Ore Bunker.
    // Invisible against real enemies, nonsense the moment the target is ours.
    if let Some(owner) = target_owner.as_deref() {
        attackers.retain(|(_, pid, ..)| pid.as_deref() != Some(owner));
    }

    let mut rows: Vec<StrikeRow> = Vec::new();
    {
        let gs = GAME_STATE.read().unwrap();
        for (player, player_id, hd_index, id, type_id, att_ambit) in &attackers {
            let Some(t) = gs.struct_types.get(type_id) else { continue };
            let prim = WeaponStats::from_type(t, false);
            let sec = WeaponStats::from_type(t, true);
            if prim.ambits == 0 && sec.ambits == 0 {
                continue; // non-combat struct
            }
            // Prefer the weapon that reaches the target's ambit; between two
            // that both reach, SIMULATE BOTH and take the one that actually
            // does more damage.
            //
            // This used to tie-break on evade chance alone, which silently threw
            // away armour-piercing. A Battleship's AP weapon exists precisely to
            // skip a target's `attack_reduction`, and against an armoured
            // Command Ship that is the difference between the "2 dmg, 1 blocked"
            // we kept landing and a full-strength hit — but with equal evade
            // chances the old rule just took the primary. `simulate` already
            // models armour, piercing, evasion and guaranteed shots, so asking
            // it is both more accurate and self-maintaining as the rules grow.
            let prim_ok = tgt_ambit_bit != 0 && (prim.ambits & tgt_ambit_bit) != 0;
            let sec_ok = tgt_ambit_bit != 0 && (sec.ambits & tgt_ambit_bit) != 0;
            let same = *att_ambit != 0 && *att_ambit == tgt_ambit_bit;
            let (w, wlabel, r) = match (prim_ok, sec_ok) {
                (true, true) => {
                    let rp = simulate(&prim, tgt_ambit_bit, tgt_hp, &defense, same);
                    let rs = simulate(&sec, tgt_ambit_bit, tgt_hp, &defense, same);
                    if rs.expected_damage > rp.expected_damage {
                        (sec, "secondary", rs)
                    } else {
                        (prim, "primary", rp)
                    }
                }
                (true, false) => {
                    let r = simulate(&prim, tgt_ambit_bit, tgt_hp, &defense, same);
                    (prim, "primary", r)
                }
                (false, true) => {
                    let r = simulate(&sec, tgt_ambit_bit, tgt_hp, &defense, same);
                    (sec, "secondary", r)
                }
                (false, false) if prim.ambits != 0 => {
                    let r = simulate(&prim, tgt_ambit_bit, tgt_hp, &defense, same);
                    (prim, "primary", r)
                }
                _ => {
                    let r = simulate(&sec, tgt_ambit_bit, tgt_hp, &defense, same);
                    (sec, "secondary", r)
                }
            };
            let exposure = counter_exposure(&defender_masks, *att_ambit);
            rows.push(StrikeRow {
                player: player.clone(),
                player_id: player_id.clone(),
                hd_index: *hd_index,
                struct_id: id.clone(),
                weapon: wlabel.to_string(),
                expected_dmg: r.expected_damage,
                reachable: r.reachable,
                att_ambit_bit: *att_ambit,
                counter_exposure: exposure,
                score: shooter_score(&r, w.control, interceptors, target_is_planetary, exposure),
                control: w.control,
            });
        }
    }

    // Reachable first, then by score (evasion- and counter-aware), then raw damage.
    rows.sort_by(|a, b| {
        b.reachable
            .cmp(&a.reachable)
            .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
            .then(b.expected_dmg.partial_cmp(&a.expected_dmg).unwrap_or(std::cmp::Ordering::Equal))
    });

    Ok(StrikePlan {
        target_id: target_id_arg,
        target_label,
        tgt_ambit_bit,
        tgt_hp,
        reduction,
        counter_free: crate::mcp::combat::counter_free_ambits(&defender_masks),
        rows,
    })
}

/// Weapon-reach masks of every live struct registered to defend `target`, plus
/// the target's own reach (it counters too). Feeds `counter_free_ambits` /
/// `counter_exposure` so a shooter can be picked in an ambit nobody covers.
pub async fn defender_weapon_masks(client: &CosmosClient, target: &str) -> Vec<u64> {
    let mut ids: Vec<String> = vec![target.to_string()];
    if let Ok(page) = client.guild.struct_defender_by_protected(target, 1).await {
        for d in page.items.iter() {
            if let Some(id) = d.get("defending_struct_id").and_then(|x| x.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    let mut masks = Vec::new();
    for id in ids {
        let Ok(e) = client.query_entity("struct", &id).await else { continue };
        if crate::mcp::loop_util::parse_bool(
            e.get("structAttributes").and_then(|x| x.get("isDestroyed")),
        ) {
            continue;
        }
        let type_id = e
            .get("Struct")
            .and_then(|s| s.get("type"))
            .map(|x| match x {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default();
        let gs = GAME_STATE.read().unwrap();
        if let Some(t) = gs.struct_types.get(&type_id) {
            // A struct with no counter value can't punish anyone regardless of
            // reach (Mobile Artillery's indirectCombatModule, unarmed planetary
            // structs) — it must not make an ambit look covered.
            if t.counter_attack.unwrap_or(0) == 0 && t.counter_attack_same_ambit.unwrap_or(0) == 0 {
                continue;
            }
            let mask = t.primary_weapon_ambits.unwrap_or(0) | t.secondary_weapon_ambits.unwrap_or(0);
            if mask != 0 {
                masks.push(mask);
            }
        }
    }
    masks
}

/// `intel.strike_options` — team-wide strike planner (display). Reports which of
/// YOUR structs across the primary player AND every virtual player can reach a
/// target and for how much, so the commander knows who should fire.
async fn query_strike_options(client: &CosmosClient, args: &Value) -> Vec<Content> {
    use crate::mcp::tools::format::decode_ambits;
    let plan = match plan_strike(client, args).await {
        Ok(p) => p,
        Err(e) => return vec![Content::text(format!("strike_options: {}", e))],
    };
    let mut out = String::new();
    out.push_str(&format!(
        "Strike options vs {} (HP {:.0}, ambit [{}], armour −{})\n",
        plan.target_label,
        plan.tgt_hp,
        if plan.tgt_ambit_bit == 0 { "?".to_string() } else { decode_ambits(plan.tgt_ambit_bit) },
        plan.reduction
    ));
    // The single biggest combat lever: counters are gated on the defender's
    // weapon reaching the ATTACKER's ambit, so firing from an ambit nobody
    // covers costs zero counter damage.
    if plan.counter_free != 0 {
        out.push_str(&format!(
            "Counter-free ambits: [{}] — attacking from these takes NO counter damage.\n",
            decode_ambits(plan.counter_free)
        ));
    } else if plan.target_id.is_some() {
        out.push_str("Counter-free ambits: none — every ambit is covered by a defender that can counter.\n");
    }
    out.push('\n');
    let reachable: Vec<_> = plan.rows.iter().filter(|r| r.reachable).collect();
    if reachable.is_empty() {
        out.push_str("  No combat struct on your team can reach this target's ambit.\n");
    } else {
        for r in &reachable {
            let free = r.att_ambit_bit != 0 && (plan.counter_free & r.att_ambit_bit) != 0;
            out.push_str(&format!(
                "  {} · {} [{}, {}] → ~{:.1} expected dmg · {}\n",
                r.player,
                r.struct_id,
                r.weapon,
                r.control.as_str(),
                r.expected_dmg,
                if free {
                    "FREE SHOT (no counter reaches its ambit)".to_string()
                } else {
                    format!("{} defender(s) can counter into its ambit", r.counter_exposure)
                }
            ));
        }
    }
    let unreachable = plan.rows.len() - reachable.len();
    if unreachable > 0 {
        out.push_str(&format!("  ({} other combat struct(s) can't reach this ambit.)\n", unreachable));
    }
    out.push_str("\nFire individually with structs_action attack / structs_players act, or fire the whole team at once with structs_strike {target}.\n");
    vec![Content::text(out)]
}

/// `intel.whoami` — self identity + sync status. Answers "who am I / what's my
/// player id" without the agent having to be handed an id by the human.
fn query_whoami() -> Vec<Content> {
    let gs = GAME_STATE.read().unwrap();
    let synced = gs.player_id.is_some() && gs.current_block_height > 0;
    let mut out = String::new();
    out.push_str("Identity\n");
    out.push_str(&format!(
        "  Player ID: {}\n",
        gs.player_id.as_deref().unwrap_or("(not synced yet)")
    ));
    out.push_str(&format!(
        "  Name: {}\n",
        gs.player_name.as_deref().unwrap_or("?")
    ));
    out.push_str(&format!(
        "  Wallet: {}\n",
        gs.wallet_address.as_deref().unwrap_or("?")
    ));
    out.push_str(&format!("  Guild: {}\n", gs.guild_id.as_deref().unwrap_or("None")));
    out.push_str(&format!("  Planet: {}\n", gs.planet_id.as_deref().unwrap_or("?")));
    out.push_str(&format!("  Fleet: {}\n", gs.fleet_id.as_deref().unwrap_or("?")));
    out.push_str(&format!("  Block height: {}\n", gs.current_block_height));
    if synced {
        out.push_str("  Sync: ✓ connected — pass this player ID to other tools (or omit; it auto-detects).\n");
    } else {
        out.push_str("  Sync: ⏳ not ready — the app is still loading game state. Retry in a few seconds.\n");
    }
    vec![Content::text(out)]
}

fn query_buildable() -> Vec<Content> {
    let gs = GAME_STATE.read().unwrap();

    let charge = gs.get_charge();
    let load = gs.total_load();
    let capacity = gs.total_capacity();
    let available_power = capacity - load;

    let mut out = String::new();
    out.push_str(&format!(
        "Current state: Charge {} | Power {}/{} ({} available)\n\n",
        charge,
        format_power(load),
        format_power(capacity),
        format_power(available_power)
    ));

    if charge < 8 {
        let blocks = gs.blocks_until_charge(8);
        out.push_str(&format!(
            "Need 8 charge to build — ready in ~{}s ({} blocks)\n\n",
            blocks * 6,
            blocks
        ));
    }

    let mut buildable = vec![];
    let mut blocked = vec![];

    let mut types: Vec<_> = gs.struct_types.values().collect();
    types.sort_by_key(|t| &t.name);

    for t in &types {
        let draw = t.passive_draw.unwrap_or(0.0);
        let new_load = load + draw;
        let would_offline = capacity > 0.0 && new_load > capacity;
        let utilization = if capacity > 0.0 {
            new_load / capacity * 100.0
        } else {
            0.0
        };

        // Check struct limit
        let limited = GameStateSync::is_limited_type(&t.name);
        let at_limit = if limited {
            gs.count_structs_of_type(&t.name) >= 1
        } else {
            false
        };

        let power_str = format_power(draw);
        let util_str = if capacity > 0.0 {
            format!(" → {:.0}% utilization", utilization)
        } else {
            String::new()
        };

        if would_offline {
            blocked.push(format!(
                "  {} — BLOCKED (would go offline: +{} draw){}\n",
                t.name, power_str, if at_limit { " [LIMIT: already have one]" } else { "" }
            ));
        } else if at_limit {
            blocked.push(format!(
                "  {} — BLOCKED (limit 1 per player, already built)\n",
                t.name
            ));
        } else {
            let warning = if utilization > 80.0 { " ⚠ high util" } else { "" };
            buildable.push(format!(
                "  {:<24} draw: {:<8} difficulty: {:<6}{}{}\n",
                t.name, power_str, t.build_difficulty, util_str, warning
            ));
        }
    }

    if !buildable.is_empty() {
        out.push_str("Buildable:\n");
        for line in &buildable {
            out.push_str(line);
        }
    }

    if !blocked.is_empty() {
        out.push_str("\nBlocked:\n");
        for line in &blocked {
            out.push_str(line);
        }
    }

    // Recommendations
    out.push_str("\nRecommendations:\n");

    // Check for missing critical structs
    let has_extractor = gs.count_structs_of_type("Ore Extractor") > 0;
    let has_refinery = gs.count_structs_of_type("Ore Refinery") > 0;
    let has_command = gs.count_structs_of_type("Command Ship") > 0;
    let has_generator = gs.count_structs_of_type("Field Generator") > 0;

    if !has_command {
        out.push_str("  - Command Ship needed (required for planet operations)\n");
    }
    if !has_extractor {
        out.push_str("  - Ore Extractor needed (required for mining)\n");
    }
    if !has_refinery {
        out.push_str("  - Ore Refinery needed (required for refining ore to Alpha)\n");
    }
    if capacity == 0.0 && !has_generator {
        out.push_str("  - Field Generator needed (you have zero power generation!)\n");
    }

    // Check ambit coverage
    let mut ambits: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for s in gs.structs.values() {
        if s.status & 4 != 0 && s.status & 32 == 0 {
            // online and not destroyed
            if let Some(ambit) = &s.operating_ambit {
                *ambits.entry(ambit.as_str()).or_insert(0) += 1;
            }
        }
    }

    for ambit in &["space", "air", "land", "water"] {
        if ambits.get(ambit).copied().unwrap_or(0) == 0 {
            out.push_str(&format!("  - No structs in {} ambit (vulnerable)\n", ambit));
        }
    }

    vec![Content::text(out)]
}

async fn query_power_forecast(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let build_type = args
        .get("struct_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let count = args.get("count").and_then(|v| v.as_u64()).unwrap_or(1);

    let (player_id, load, capacity) = {
        let gs = GAME_STATE.read().unwrap();
        (gs.player_id.clone(), gs.total_load(), gs.total_capacity())
    };

    let mut out = String::new();
    out.push_str(&format!(
        "Current: {}/{} ({:.0}% utilization)\n",
        format_power(load),
        format_power(capacity),
        if capacity > 0.0 { load / capacity * 100.0 } else { 0.0 }
    ));

    // Try a trend read from the Guild API (`stat range`). Degrades gracefully
    // when the API is unreachable or the user isn't authenticated.
    if let Some(pid) = player_id.as_deref() {
        if let Ok(slope) = trend_slope(client, "capacity", pid, 100).await {
            if slope.abs() > 0.001 {
                let direction = if slope > 0.0 { "rising" } else { "DECLINING" };
                out.push_str(&format!(
                    "Capacity trend: {} ({}{} per block)\n",
                    direction,
                    if slope > 0.0 { "+" } else { "" },
                    format_power(slope)
                ));
                if slope < 0.0 && capacity > 0.0 {
                    let blocks_to_offline = ((capacity - load).max(0.0) / slope.abs()) as u64;
                    if blocks_to_offline < 200 {
                        out.push_str(&format!(
                            "⚠ At current trend: forced offline in ~{} blocks even without building\n",
                            blocks_to_offline
                        ));
                    }
                }
            }
        }
    }
    out.push('\n');

    let gs = GAME_STATE.read().unwrap();
    if !build_type.is_empty() {
        if let Some(t) = gs.struct_types.values().find(|t| t.name.eq_ignore_ascii_case(build_type)) {
            let draw = t.passive_draw.unwrap_or(0.0) * count as f64;
            let new_load = load + draw;
            let new_util = if capacity > 0.0 { new_load / capacity * 100.0 } else { 0.0 };
            let safe = capacity == 0.0 || new_load <= capacity;

            out.push_str(&format!(
                "If you build {} {}{}:\n",
                count,
                t.name,
                if count > 1 { "s" } else { "" }
            ));
            out.push_str(&format!(
                "  Load: {} → {} (+{})\n",
                format_power(load),
                format_power(new_load),
                format_power(draw)
            ));
            out.push_str(&format!("  Utilization: {:.0}%\n", new_util));
            if !safe {
                out.push_str("  WOULD GO OFFLINE — do not build!\n");
            } else if new_util > 80.0 {
                out.push_str("  Warning: high utilization\n");
            } else {
                out.push_str("  Safe to build\n");
            }
        } else {
            out.push_str(&format!("Unknown struct type: {}\n", build_type));
        }
    } else {
        // Show forecast for all generator types
        out.push_str("Power generation options:\n");
        for name in &["Field Generator", "Continental Power Plant", "World Engine"] {
            if let Some(t) = gs.struct_types.values().find(|t| t.name.eq_ignore_ascii_case(name)) {
                let draw = t.passive_draw.unwrap_or(0.0);
                let at_limit = gs.count_structs_of_type(name) >= 1;
                let status = if at_limit { " [already built]" } else { "" };
                out.push_str(&format!(
                    "  {}: draw {}{}\n",
                    name,
                    format_power(draw),
                    status
                ));
            }
        }
    }

    vec![Content::text(out)]
}

fn query_economy(registry: &Arc<TaskRegistry>) -> Vec<Content> {
    let gs = GAME_STATE.read().unwrap();

    let mut out = String::new();
    out.push_str(&format!(
        "Alpha: {} | Ore: {}\n",
        format_alpha_whole(gs.alpha.unwrap_or(0.0)),
        format_ore(gs.ore.unwrap_or(0.0))
    ));

    let stored_ore = gs.stored_ore.unwrap_or(0.0);
    if stored_ore > 0.0 {
        out.push_str(&format!(
            "Stored Ore: {} (RAIDABLE — refine ASAP!)\n",
            format_ore(stored_ore)
        ));
    }

    if let Some(planet_ore) = gs.planet_ore {
        out.push_str(&format!("Planet ore remaining: {}\n", planet_ore));
        if planet_ore <= 0.0 {
            out.push_str("  Planet depleted — explore a new planet when ready\n");
        }
    }

    // Mining/refining structs
    out.push('\n');
    let extractors: Vec<_> = gs.structs.iter()
        .filter(|(_, s)| {
            gs.struct_types.get(&s.struct_type_id.to_string())
                .map(|t| t.name.contains("Extractor"))
                .unwrap_or(false)
        })
        .collect();

    let refineries: Vec<_> = gs.structs.iter()
        .filter(|(_, s)| {
            gs.struct_types.get(&s.struct_type_id.to_string())
                .map(|t| t.name.contains("Refinery"))
                .unwrap_or(false)
        })
        .collect();

    out.push_str(&format!("Ore Extractors: {}\n", extractors.len()));
    for (id, s) in &extractors {
        let has_task = registry.tasks.get(*id).is_some();
        let status = if has_task { "mining" } else if s.status & 4 != 0 { "idle" } else { "offline" };
        out.push_str(&format!("  {} — {}\n", id, status));
    }

    out.push_str(&format!("Ore Refineries: {}\n", refineries.len()));
    for (id, s) in &refineries {
        let has_task = registry.tasks.get(*id).is_some();
        let status = if has_task { "refining" } else if s.status & 4 != 0 { "idle" } else { "offline" };
        out.push_str(&format!("  {} — {}\n", id, status));
    }

    // Active hash tasks
    let active: Vec<_> = registry.tasks.iter().collect();
    if !active.is_empty() {
        out.push_str("\nActive hash tasks:\n");
        for entry in &active {
            let snap = entry.value().snapshot();
            let task_type = snap.task_type.as_deref().unwrap_or("?");
            let hr = if snap.estimated_hashrate > 1000.0 {
                format!("{:.0}M h/s", snap.estimated_hashrate / 1000.0)
            } else {
                format!("{:.0}K h/s", snap.estimated_hashrate)
            };
            out.push_str(&format!(
                "  {} {} — {} ({})\n",
                snap.object_id, task_type, snap.status, hr
            ));
        }
    }

    vec![Content::text(out)]
}

fn query_timeline(registry: &Arc<TaskRegistry>, args: &Value) -> Vec<Content> {
    let gs = GAME_STATE.read().unwrap();

    let mut out = String::new();
    out.push_str("Operation Timeline:\n\n");

    // Show all active hash tasks with ETAs
    let mut tasks: Vec<_> = registry.tasks.iter().collect();
    if tasks.is_empty() {
        out.push_str("No active operations.\n");
        return vec![Content::text(out)];
    }

    // Sort by estimated completion
    tasks.sort_by(|a, b| {
        let sa = a.value().snapshot();
        let sb = b.value().snapshot();
        let eta_a = estimate_blocks_remaining_simple(
            gs.current_block_height.saturating_sub(sa.block_start),
            sa.difficulty_target,
            sa.estimated_hashrate,
        );
        let eta_b = estimate_blocks_remaining_simple(
            gs.current_block_height.saturating_sub(sb.block_start),
            sb.difficulty_target,
            sb.estimated_hashrate,
        );
        eta_a.cmp(&eta_b)
    });

    for entry in &tasks {
        let snap = entry.value().snapshot();
        let task_type = snap.task_type.as_deref().unwrap_or("?");
        let type_name = gs.get_struct_type_name(&snap.object_id)
            .unwrap_or_else(|| "Struct".to_string());
        let age = gs.current_block_height.saturating_sub(snap.block_start);
        let blocks_remaining = estimate_blocks_remaining_simple(
            age,
            snap.difficulty_target,
            snap.estimated_hashrate,
        );
        let eta_seconds = blocks_remaining * 6; // ~6s/block

        let eta_str = if eta_seconds < 60 {
            format!("~{}s", eta_seconds)
        } else if eta_seconds < 3600 {
            format!("~{}m", eta_seconds / 60)
        } else {
            format!("~{}h {}m", eta_seconds / 3600, (eta_seconds % 3600) / 60)
        };

        out.push_str(&format!(
            "  {} {} ({}) — {} — ETA {}\n",
            snap.object_id, task_type, type_name, snap.status, eta_str
        ));
    }

    vec![Content::text(out)]
}

fn estimate_blocks_remaining_simple(current_age: u64, difficulty_target: u64, hashrate: f64) -> u64 {
    use crate::hasher::difficulty::calculate_difficulty;
    let block_time_ms = 6000.0; // ~6s/block
    let hr = if hashrate > 0.0 { hashrate } else { 20000.0 };
    let mut cumulative = 0.0f64;
    let mut blocks = 0u64;

    while cumulative < 1.0 && blocks < 30000 {
        let age = current_age + blocks;
        let diff = calculate_difficulty(age, difficulty_target);
        let prob = 1.0 / 16.0f64.powi(diff as i32);
        cumulative += hr * block_time_ms * prob;
        blocks += 1;
    }
    blocks
}

// Shared ladder — see crate::mcp::tools::format.
use crate::mcp::tools::format::{format_alpha_whole, format_ore};

fn format_power(milliwatts: f64) -> String {
    let abs = milliwatts.abs();
    if abs >= 1e6 { format!("{:.1}KW", milliwatts / 1e6) }
    else if abs >= 1e3 { format!("{:.1}W", milliwatts / 1e3) }
    else { format!("{:.0}mW", milliwatts) }
}

// ─────────────────────────────────────────────────────────────────────────
// Analytical sub-queries backed by the Guild API.
// Each one degrades gracefully — if the API errors, the agent gets a clear
// "X unavailable" message rather than a stack trace.
// ─────────────────────────────────────────────────────────────────────────

/// 3a — `intel.planet_history`
///
/// Args: `{ planet_id: string, window_minutes?: number = 60 }`.
/// Walks planet-activity up to MAX_PAGES, buckets by category, shows top
/// attackers and time-since-last-event.
async fn query_planet_history(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let planet_id = match args.get("planet_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("planet_history: missing required arg 'planet_id' (e.g. '2-5')".to_string())],
    };
    let window_minutes = args.get("window_minutes").and_then(|v| v.as_u64()).unwrap_or(60);

    let g = client.guild.clone();
    let pid_for_closure = planet_id.clone();
    let result = fetch_all_pages(
        move |page| {
            let g = g.clone();
            let pid = pid_for_closure.clone();
            async move { g.planet_activity_by_planet(&pid, page).await }
        },
        5,
    )
    .await;

    let events = match result {
        Ok(v) => v,
        Err(e) => return vec![Content::text(format!("planet_history unavailable: {}", e))],
    };

    if events.is_empty() {
        return vec![Content::text(format!(
            "Planet {} — no recorded activity\n",
            planet_id
        ))];
    }

    let now = chrono::Utc::now().timestamp();
    let window_seconds = (window_minutes * 60) as i64;
    let cutoff = now - window_seconds;

    let mut in_window = 0usize;
    let mut by_category: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut by_actor: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut last_event_age: Option<i64> = None;

    for ev in &events {
        let ts = parse_timestamp(ev.get("created_at").or(ev.get("timestamp")).or(ev.get("block_time")));
        let category = ev.get("category").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        let actor = ev
            .get("actor_player_id")
            .or(ev.get("creator"))
            .or(ev.get("player_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();

        if let Some(t) = ts {
            let age = now - t;
            if last_event_age.map(|prev| age < prev).unwrap_or(true) {
                last_event_age = Some(age);
            }
            if t < cutoff {
                continue;
            }
        }
        in_window += 1;
        *by_category.entry(category).or_insert(0) += 1;
        *by_actor.entry(actor).or_insert(0) += 1;
    }

    let mut out = String::new();
    out.push_str(&format!(
        "Planet {} — last {} min activity\n",
        planet_id, window_minutes
    ));
    out.push_str(&format!("{} events total\n", in_window));

    if !by_category.is_empty() {
        let mut cats: Vec<_> = by_category.iter().collect();
        cats.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
        let summary = cats
            .iter()
            .map(|(k, n)| format!("{} {}", n, k))
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("By category: {}\n", summary));
    }
    if !by_actor.is_empty() {
        let mut actors: Vec<_> = by_actor.iter().collect();
        actors.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
        if let Some((top, count)) = actors.first() {
            out.push_str(&format!("Top actor: {} ({} actions)\n", top, count));
        }
    }
    if let Some(age) = last_event_age {
        out.push_str(&format!("Last event: {}s ago\n", age));
    }
    if in_window >= 5 {
        out.push_str("Status: contested\n");
    } else if in_window >= 2 {
        out.push_str("Status: active\n");
    } else {
        out.push_str("Status: quiet\n");
    }

    vec![Content::text(out)]
}

/// 3b — `intel.valid_targets`
///
/// Args: `{ near?: string, limit?: number = 10, attacker?: string, weapon?: "primary"|"secondary" }`.
/// Combines GAME_STATE struct list with `struct-defender/protected` lookups to
/// produce a ranked target list with defender chains. When `attacker` is given,
/// filters/flags by whether the attacker's weapon ambits can actually reach each
/// target's operating ambit (Water=2, Land=4, Air=8, Space=16).
async fn query_valid_targets(client: &CosmosClient, args: &Value) -> Vec<Content> {
    use crate::mcp::tools::format::{ambit_bit, decode_ambits};

    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
    let near = args.get("near").and_then(|v| v.as_str()).map(|s| s.to_string());
    let attacker = args.get("attacker").and_then(|v| v.as_str()).map(|s| s.to_string());
    let weapon = args.get("weapon").and_then(|v| v.as_str()).unwrap_or("primary");

    // Pull candidate (id, ambit_bit) pairs and the attacker's weapon-ambit mask.
    // If `near` is given, candidate ids come from the Guild API location list;
    // otherwise from the current view's enemy structs in GAME_STATE.
    // candidate = (id, ambit_bit, hp_display)
    let (candidates, my_player_id, my_charge, weapon_mask): (Vec<(String, u64, String)>, Option<String>, u64, Option<u64>) = {
        let gs = GAME_STATE.read().unwrap();
        let my_id = gs.player_id.clone();
        let charge = gs.get_charge();
        let weapon_mask = attacker.as_deref().and_then(|aid| {
            let s = gs.structs.get(aid)?;
            let t = gs.struct_types.get(&s.struct_type_id.to_string())?;
            if weapon.eq_ignore_ascii_case("secondary") {
                t.secondary_weapon_ambits
            } else {
                t.primary_weapon_ambits
            }
        });
        let ids = if near.is_some() {
            vec![] // Fetched separately below.
        } else {
            gs.structs
                .iter()
                .filter(|(_, s)| my_id.as_ref().map(|m| &s.owner != m).unwrap_or(false))
                // Status bit semantics (struct_cache.go StructState):
                //   1=Materialized, 2=Built, 4=Online, 8=Stored, 16=Hidden,
                //   32=Destroyed, 64=Locked.
                // v0.19.1 CanAttack rejects both unbuilt (no Built bit) and
                // destroyed (Destroyed bit) — see knowledge/mechanics/combat.md.
                .filter(|(_, s)| s.status & 2 != 0 && s.status & 32 == 0)
                .map(|(id, s)| {
                    let bit = s.operating_ambit.as_deref().map(ambit_bit).unwrap_or(0);
                    let max = gs.struct_types.get(&s.struct_type_id.to_string()).and_then(|t| t.max_health);
                    let hp = match (s.health, max) {
                        (Some(h), Some(m)) => format!("{:.0}/{:.0}", h, m),
                        (Some(h), None) => format!("{:.0}", h),
                        _ => "?".to_string(),
                    };
                    (id.clone(), bit, hp)
                })
                .collect::<Vec<_>>()
        };
        (ids, my_id, charge, weapon_mask)
    };

    // Fallback: if the attacker isn't in the primary GAME_STATE (e.g. a virtual
    // player's struct), resolve its weapon-ambit mask from the chain so we still
    // rank by reachability instead of silently ignoring the attacker.
    let weapon_mask = match (weapon_mask, attacker.as_deref()) {
        (None, Some(aid)) => match client.query_entity("struct", aid).await {
            Ok(v) => {
                let type_id = v.get("Struct").and_then(|s| s.get("type")).and_then(|x| match x {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                });
                type_id.and_then(|tid| {
                    let gs = GAME_STATE.read().unwrap();
                    gs.struct_types.get(&tid).and_then(|t| {
                        if weapon.eq_ignore_ascii_case("secondary") {
                            t.secondary_weapon_ambits
                        } else {
                            t.primary_weapon_ambits
                        }
                    })
                })
            }
            Err(_) => None,
        },
        (mask, _) => mask,
    };

    let candidates: Vec<(String, u64, String)> = if let Some(loc) = near.as_deref() {
        match client.guild.struct_list_by_location(loc, 1).await {
            Ok(page) => {
                let gs = GAME_STATE.read().unwrap();
                page.items
                    .iter()
                    .filter(|v| {
                        // v0.19.1 CanAttack rejects unbuilt + destroyed structs. The
                        // Guild API struct list exposes `is_destroyed` (a bool — what
                        // scout uses) and may omit the numeric `status` bitmask. So:
                        // reject destroyed; only enforce the Built bit when status is
                        // actually present (otherwise a live, listed struct is built).
                        let status = v.get("status").and_then(|x| match x {
                            Value::Number(n) => n.as_u64(),
                            Value::String(s) => s.parse().ok(),
                            _ => None,
                        });
                        let destroyed = v.get("is_destroyed").and_then(|x| x.as_bool()).unwrap_or(false);
                        match status {
                            Some(s) => s & 2 != 0 && s & 32 == 0,
                            None => !destroyed,
                        }
                    })
                    .filter_map(|v| {
                        let id = v.get("id").and_then(|x| x.as_str())?.to_string();
                        let bit = v
                            .get("operating_ambit")
                            .and_then(|x| x.as_str())
                            .map(ambit_bit)
                            .unwrap_or(0);
                        let type_id = v.get("type").or_else(|| v.get("struct_type")).map(|x| match x {
                            Value::Number(n) => n.to_string(),
                            Value::String(s) => s.clone(),
                            _ => String::new(),
                        });
                        let max = type_id.and_then(|t| gs.struct_types.get(&t)).and_then(|t| t.max_health);
                        let hp = match (v.get("health").and_then(json_to_f64), max) {
                            (Some(h), Some(m)) => format!("{:.0}/{:.0}", h, m),
                            (Some(h), None) => format!("{:.0}", h),
                            _ => "?".to_string(),
                        };
                        Some((id, bit, hp))
                    })
                    .collect()
            }
            Err(e) => return vec![Content::text(format!("valid_targets: {} (location lookup failed)", e))],
        }
    } else {
        candidates
    };

    if candidates.is_empty() {
        return vec![Content::text(
            "valid_targets: no candidate enemy structs visible (try the 'near' arg with a location id)".to_string(),
        )];
    }

    // (id, defender_count, reachable, note, owner_stored_ore, owner_vulnerable)
    #[allow(clippy::type_complexity)]
    let mut targets: Vec<(String, usize, bool, String, f64, bool)> = Vec::new();
    for (id, ambit, hp) in candidates.iter().take(20) {
        let defenders = match client.guild.struct_defender_by_protected(id, 1).await {
            Ok(page) => page.items,
            Err(_) => vec![],
        };
        let defender_count = defenders.len();
        let def_ids: Vec<String> = defenders
            .iter()
            .filter_map(|d| {
                d.get("defending_struct_id")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            })
            .take(3)
            .collect();
        let def_note = if defender_count == 0 {
            "undefended".to_string()
        } else {
            format!("{} defender(s)[{}]", defender_count, def_ids.join(","))
        };
        // Reachable unless we know the weapon mask and it doesn't cover the ambit.
        let reachable = match weapon_mask {
            Some(mask) if *ambit != 0 => (mask & *ambit) != 0,
            _ => true,
        };
        // The struct list omits health; enrich from the LCD struct entity.
        let hp_str = if hp == "?" {
            fetch_struct_hp(client, id).await.unwrap_or_else(|| "?".to_string())
        } else {
            hp.clone()
        };
        // What the owner is actually worth taking. A raid seizes ALL of a
        // player's stored ore, and only a *vulnerable* owner can be raided at
        // all — historically 0 of 50 non-vulnerable raids ever completed. Both
        // were missing here, so this ranked a 0-ore fortress above the galaxy's
        // fattest undefended pile.
        let prize = owner_prize(client, id).await;
        let mut note = format!("HP {} · {}", hp_str, def_note);
        if let Some(p) = &prize {
            note.push_str(&format!(
                " · owner {} holds {:.0} ore, {}",
                p.owner,
                p.stored_ore,
                if p.vulnerable { "RAIDABLE NOW" } else { "shields up" }
            ));
        }
        if weapon_mask.is_some() && !reachable {
            note.push_str(" — OUT OF WEAPON AMBIT (cannot reach)");
        }
        let ore = prize.as_ref().map(|p| p.stored_ore).unwrap_or(0.0);
        let vulnerable = prize.as_ref().map(|p| p.vulnerable).unwrap_or(false);
        targets.push((id.clone(), defender_count, reachable, note, ore, vulnerable));
    }

    // Rank: reachable first, then the raidable ones, then by the size of the
    // prize, and only then by how lightly defended the struct itself is.
    targets.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then(b.5.cmp(&a.5))
            .then(b.4.partial_cmp(&a.4).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.1.cmp(&b.1))
    });
    targets.truncate(limit);

    let mut out = String::new();
    out.push_str(&format!(
        "Valid targets (you: charge {}, player {})\n",
        my_charge,
        my_player_id.as_deref().unwrap_or("?")
    ));
    match weapon_mask {
        Some(mask) => out.push_str(&format!(
            "Attacker {} {} weapon reaches: {}\n\n",
            attacker.as_deref().unwrap_or("?"),
            weapon,
            decode_ambits(mask)
        )),
        None => out.push_str(
            "\nNote: pass 'attacker' (your struct id) + 'weapon' to filter by ambit reachability.\n\n",
        ),
    }
    for (id, _, _, note, _, _) in &targets {
        out.push_str(&format!("  {}  — {}\n", id, note));
    }
    out.push_str("\nNote: defender chains are read live from the Guild API. Ranked by reachable → raidable → size of the owner's ore pile → lightly defended, because a raid seizes ALL of the owner's stored ore and cannot complete at all unless their shields are vulnerable.\n");
    out.push_str(
        "Combat rules (v0.17.0): the target's defenders fire a counter-attack but take no counter-damage themselves — only the attacker and the original target can be hit by counters. A fleet that is AWAY from its home planet cannot defend planetary structs there, so on-station targets are better protected than they look.\n",
    );

    vec![Content::text(out)]
}

/// 3c — `intel.scout` (real recon)
///
/// Args: `{ location_id: string }`.
/// Lists every struct at a location with HP, ambit, slot, weapon-reach and owner
/// — the battlefield read the player previously had to get from `view.struct`.
/// Grid attributes are a best-effort extra (the endpoint 404s for some location
/// types, so it never fails the scout).
async fn query_scout(client: &CosmosClient, args: &Value) -> Vec<Content> {
    use crate::mcp::tools::format::decode_ambits;

    let location_id = match args.get("location_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("scout: missing required arg 'location_id'".to_string())],
    };

    let page = match client.guild.struct_list_by_location(&location_id, 1).await {
        Ok(p) => p,
        Err(e) => return vec![Content::text(format!("Scout {}: structs unavailable ({})", location_id, e))],
    };

    // Enemy HP isn't in the struct list — prefetch it from the LCD per struct
    // (skip destroyed). Done before the GAME_STATE lock since fetch is async.
    let mut hp_by_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for v in page.items.iter().take(30) {
        if v.get("is_destroyed").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            if let Some(hp) = fetch_struct_hp(client, id).await {
                hp_by_id.insert(id.to_string(), hp);
            }
        }
    }

    let mut out = String::new();
    out.push_str(&format!("Scout: {} — {} struct(s)\n", location_id, page.items.len()));

    {
        let gs = GAME_STATE.read().unwrap();
        let me = gs.player_id.clone();
        for v in &page.items {
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("?");
            // type id can arrive as number or string
            let type_id = v
                .get("type")
                .or_else(|| v.get("struct_type"))
                .map(|x| match x {
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => s.clone(),
                    _ => String::new(),
                })
                .unwrap_or_default();
            let st = gs.struct_types.get(&type_id);
            let type_name = st.map(|t| t.name.as_str()).unwrap_or("Unknown");
            let reach = st
                .and_then(|t| t.primary_weapon_ambits)
                .map(decode_ambits)
                .unwrap_or_else(|| "—".to_string());
            let owner = v.get("owner").and_then(|x| x.as_str()).unwrap_or("?");
            let owner_tag = if me.as_deref() == Some(owner) { " (you)" } else { "" };
            let ambit = v.get("operating_ambit").and_then(|x| x.as_str()).unwrap_or("?");
            let slot = v.get("slot").map(|x| x.to_string()).unwrap_or_else(|| "?".to_string());
            let destroyed = v.get("is_destroyed").and_then(|x| x.as_bool()).unwrap_or(false);
            let hp = hp_by_id.get(id).cloned().unwrap_or_else(|| {
                // Fallback to any health on the list row (usually absent → "?").
                let h = v.get("health").and_then(json_to_f64);
                let m = st.and_then(|t| t.max_health);
                match (h, m) {
                    (Some(h), Some(m)) => format!("{:.0}/{:.0}", h, m),
                    (Some(h), None) => format!("{:.0}", h),
                    _ => "?".to_string(),
                }
            });
            let defends = v
                .get("defending_struct_ids")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let defends_tag = if defends > 0 { format!(" · defends {}", defends) } else { String::new() };
            let dead_tag = if destroyed { " · DESTROYED" } else { "" };
            out.push_str(&format!(
                "  {} {} owner={}{} HP {} ambit={} slot={} reach=[{}]{}{}\n",
                id, type_name, owner, owner_tag, hp, ambit, slot, reach, defends_tag, dead_tag
            ));
        }
    }

    out.push_str("\nTip: use valid_targets (with attacker+weapon) to rank by reachability & defenders, simulate to preview damage, battle_log to read results.\n");
    vec![Content::text(out)]
}

/// `intel.battle_log` — the primary way to read combat results without the DB.
/// Args: `{ planet_id?, category?="struct_attack", struct_id?, limit?=15 }`.
/// Parses `planet_activity` events into readable combat lines.
async fn query_battle_log(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let planet_id = args
        .get("planet_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| GAME_STATE.read().unwrap().planet_id.clone());
    let Some(planet_id) = planet_id else {
        return vec![Content::text(
            "battle_log: no planet_id given and your planet is unknown — pass {planet_id}.".to_string(),
        )];
    };
    let category = args.get("category").and_then(|v| v.as_str()).unwrap_or("struct_attack").to_string();
    let struct_filter = args.get("struct_id").and_then(|v| v.as_str()).map(|s| s.to_string());
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(15) as usize;

    let pid = planet_id.clone();
    let events = match fetch_all_pages(|page| client.guild.planet_activity_by_planet(&pid, page), 5).await {
        Ok(items) => items,
        Err(e) => return vec![Content::text(format!("battle_log: {} (planet activity unavailable)", e))],
    };

    let mut out = String::new();
    out.push_str(&format!("Battle log — planet {} (category: {})\n", planet_id, category));
    let mut shown = 0;
    for ev in events.iter() {
        let cat = ev.get("category").and_then(|x| x.as_str()).unwrap_or("");
        if cat != category {
            continue;
        }
        let detail = coerce_detail(&ev.get("detail").cloned().unwrap_or(Value::Null));
        let attacker = detail.get("attackerStructId").and_then(|x| x.as_str());
        let attacker_type = detail.get("attackerStructType").and_then(|x| x.as_str()).unwrap_or("?");
        let weapon = detail.get("weaponSystem").and_then(|x| x.as_str()).unwrap_or("");
        // The resolved outcome (damage, target, destroyed) is per-shot in the
        // eventAttackShotDetail array — NOT flat on the detail.
        let shots = detail.get("eventAttackShotDetail").and_then(|x| x.as_array());
        if let Some(sf) = &struct_filter {
            let hits_attacker = attacker == Some(sf.as_str());
            let hits_target = shots
                .map(|ss| {
                    ss.iter().any(|s| {
                        s.get("targetStructId").and_then(|x| x.as_str()) == Some(sf.as_str())
                    })
                })
                .unwrap_or(false);
            if !hits_attacker && !hits_target {
                continue;
            }
        }
        let when = ev.get("time").and_then(|x| x.as_str()).unwrap_or("");
        out.push_str(&format!(
            "\n• [{}] {} ({}) {}\n",
            when,
            attacker.unwrap_or("?"),
            attacker_type,
            weapon
        ));
        match shots {
            Some(ss) if !ss.is_empty() => {
                for s in ss {
                    out.push_str(&format!("    → {}\n", summarize_shot(s)));
                }
            }
            // No shot detail (e.g. a recoil-only or self-destruct row).
            _ => {
                if let Some(r) = detail.get("recoilDamage").and_then(json_to_u64) {
                    if r > 0 {
                        out.push_str(&format!("    (recoil {} to attacker)\n", r));
                    }
                }
            }
        }
        shown += 1;
        if shown >= limit {
            break;
        }
    }
    if shown == 0 {
        out.push_str("  (no matching events — combat may not have resolved yet; events also stream live on structs_events)\n");
    }
    vec![Content::text(out)]
}

/// What raiding a struct's OWNER would actually be worth, and whether it is
/// possible right now. Cached per scan so a 20-candidate ranking doesn't re-read
/// the same owner's player/fleet entities once per struct they own.
struct OwnerPrize {
    owner: String,
    stored_ore: f64,
    vulnerable: bool,
}

/// Resolve the owner of `struct_id` and answer the only two questions that
/// decide whether attacking around them pays: how much stored ore they hold
/// (a raid takes all of it) and whether their shields are currently vulnerable.
async fn owner_prize(client: &CosmosClient, struct_id: &str) -> Option<OwnerPrize> {
    let st = client.query_entity("struct", struct_id).await.ok()?;
    let owner = st.get("Struct")?.get("owner").and_then(|x| x.as_str())?.to_string();
    let pl = client.query_entity("player", &owner).await.ok()?;
    let p = pl.get("Player")?;
    let stored_ore = crate::mcp::loop_util::parse_f64(pl.get("gridAttributes").and_then(|g| g.get("ore")));
    let planet = p.get("planetId").and_then(|x| x.as_str()).unwrap_or("");
    let fleet = p.get("fleetId").and_then(|x| x.as_str()).unwrap_or("");

    // IsDefenderCommandStructVulnerable(): no fleet, fleet off-station, or no /
    // destroyed / offline Command Ship.
    let vulnerable = if fleet.is_empty() {
        true
    } else {
        match client.query_entity("fleet", fleet).await {
            Ok(fl) => {
                let f = fl.get("Fleet");
                let on_station = f.and_then(|x| x.get("status")).and_then(|x| x.as_str()) == Some("onStation")
                    && f.and_then(|x| x.get("locationId")).and_then(|x| x.as_str()) == Some(planet);
                if !on_station {
                    true
                } else {
                    match f.and_then(|x| x.get("commandStruct")).and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                        None => true,
                        Some(cs) => client
                            .query_entity("struct", cs)
                            .await
                            .map(|e| {
                                let sa = e.get("structAttributes");
                                crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isDestroyed")))
                                    || !crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isOnline")))
                            })
                            .unwrap_or(false),
                    }
                }
            }
            Err(_) => false,
        }
    };
    Some(OwnerPrize { owner, stored_ore, vulnerable })
}

/// One resolved `struct_attack` row, typed. The GRASS/NATS stream STUBS this
/// event whenever the payload exceeds ~8 KB — which any multi-shot, multi-defender
/// fight does — so the stub carries no attacker fields at all. The Guild API's
/// `planet-activity` feed always has the full record, which makes this the only
/// reliable way to answer "who just shot me". Used by `battle_log` (display) and
/// by `auto_response` (attacker resolution).
#[derive(Debug, Clone, Default)]
pub struct AttackEvent {
    pub time: String,
    pub seq: i64,
    pub attacker_player_id: Option<String>,
    pub attacker_struct_id: Option<String>,
    pub attacker_struct_type: Option<String>,
    pub attacker_ambit: Option<String>,
    pub target_player_id: Option<String>,
    pub weapon_system: Option<String>,
    pub shots: Vec<AttackShot>,
}

#[derive(Debug, Clone, Default)]
pub struct AttackShot {
    pub target_struct_id: Option<String>,
    pub target_player_id: Option<String>,
    pub damage_dealt: u64,
    pub evaded: bool,
    pub blocked: bool,
    pub destroyed: bool,
    pub countered: bool,
    pub countered_damage: u64,
}

impl AttackEvent {
    /// Did this volley touch any of `mine` (struct ids we own)?
    pub fn hits_any(&self, mine: &std::collections::HashSet<String>) -> bool {
        self.shots
            .iter()
            .any(|s| s.target_struct_id.as_deref().map(|t| mine.contains(t)).unwrap_or(false))
    }
    pub fn total_damage(&self) -> u64 {
        self.shots.iter().map(|s| s.damage_dealt).sum()
    }
    pub fn destroyed_count(&self) -> u32 {
        self.shots.iter().filter(|s| s.destroyed).count() as u32
    }
}

fn json_bool(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => false,
    }
}

/// Read the most recent `struct_attack` rows for a planet, newest first.
pub async fn fetch_attack_events(
    client: &CosmosClient,
    planet_id: &str,
    limit: usize,
) -> Result<Vec<AttackEvent>, String> {
    let pid = planet_id.to_string();
    let items = fetch_all_pages(|page| client.guild.planet_activity_by_planet(&pid, page), 5)
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<AttackEvent> = Vec::new();
    for ev in items.iter() {
        if ev.get("category").and_then(|x| x.as_str()) != Some("struct_attack") {
            continue;
        }
        // The REST feed encodes `detail` as a JSON STRING; GRASS delivers it
        // already parsed. `coerce_detail` normalises both.
        let detail = coerce_detail(&ev.get("detail").cloned().unwrap_or(Value::Null));
        let sval = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from).filter(|s| !s.is_empty());

        let shots: Vec<AttackShot> = detail
            .get("eventAttackShotDetail")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|s| AttackShot {
                        target_struct_id: sval(s, "targetStructId"),
                        target_player_id: sval(s, "targetPlayerId"),
                        damage_dealt: s.get("damageDealt").and_then(json_to_u64).unwrap_or(0),
                        evaded: json_bool(s.get("evaded")),
                        blocked: json_bool(s.get("blocked")),
                        destroyed: json_bool(s.get("targetDestroyed")),
                        countered: json_bool(s.get("targetCountered")),
                        countered_damage: s.get("targetCounteredDamage").and_then(json_to_u64).unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default();

        out.push(AttackEvent {
            time: ev.get("time").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            seq: ev.get("seq").and_then(json_to_u64).unwrap_or(0) as i64,
            attacker_player_id: sval(&detail, "attackerPlayerId"),
            attacker_struct_id: sval(&detail, "attackerStructId"),
            attacker_struct_type: sval(&detail, "attackerStructType"),
            attacker_ambit: sval(&detail, "attackerStructOperatingAmbit"),
            // `targetPlayerId` sits on the flat block in the REST shape and on
            // each shot in combat.md's schema — take whichever is present.
            target_player_id: sval(&detail, "targetPlayerId")
                .or_else(|| shots.iter().find_map(|s: &AttackShot| s.target_player_id.clone())),
            weapon_system: sval(&detail, "weaponSystem"),
            shots,
        });
    }
    // Newest first: `seq` is monotonic per planet; fall back to the timestamp.
    out.sort_by(|a, b| b.seq.cmp(&a.seq).then(b.time.cmp(&a.time)));
    out.truncate(limit);
    Ok(out)
}

/// Summarize one `EventAttackShotDetail` row into a readable combat line:
/// target, damage, HP before→after, and evade/block/destroy/counter flags.
/// Booleans read true whether they arrive as JSON bools or the string "true".
fn summarize_shot(s: &Value) -> String {
    let sval = |k: &str| s.get(k).and_then(|x| x.as_str()).map(|v| v.to_string());
    let bval = |k: &str| match s.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(x)) => x.eq_ignore_ascii_case("true"),
        _ => false,
    };

    let target = sval("targetStructId").unwrap_or_else(|| "?".to_string());
    let ttype = sval("targetStructType").unwrap_or_default();
    let mut out = if ttype.is_empty() {
        target
    } else {
        format!("{} ({})", target, ttype)
    };

    if bval("evaded") {
        out.push_str(": EVADED (0 dmg)");
    } else if bval("blocked") {
        match sval("blockedByStructId").filter(|b| !b.is_empty()) {
            Some(b) => out.push_str(&format!(": BLOCKED by {}", b)),
            None => out.push_str(": BLOCKED"),
        }
    } else {
        // Roll minus armour — see raid_view::describe_activity for why neither
        // `damage` nor `damageDealt` alone is right. `damage` is an accumulator
        // that lands on one shot of a volley; `damageDealt` ignores armour.
        let dmg = s
            .get("damageDealt")
            .and_then(json_to_u64)
            .unwrap_or(0)
            .saturating_sub(s.get("damageReduction").and_then(json_to_u64).unwrap_or(0));
        out.push_str(&format!(": {} dmg", dmg));
        if let (Some(b), Some(a)) = (
            s.get("targetHealthBefore").and_then(json_to_u64),
            s.get("targetHealthAfter").and_then(json_to_u64),
        ) {
            out.push_str(&format!(", HP {}→{}", b, a));
        }
    }
    if bval("targetDestroyed") {
        out.push_str(" · DESTROYED");
    }
    // Counter damage stacks across the target AND every armed defender that
    // blocked for it — see raid_view::describe_activity. Reporting only the
    // target's share understates what the shot actually cost the attacker.
    let defender_counters: u64 = s
        .get("eventAttackDefenderCounterDetail")
        .and_then(|v| v.as_array())
        .map(|cs| {
            cs.iter()
                .filter_map(|c| c.get("counterDamage").and_then(json_to_u64))
                .sum()
        })
        .unwrap_or(0);
    let total_counter =
        s.get("targetCounteredDamage").and_then(json_to_u64).unwrap_or(0) + defender_counters;
    if bval("targetCountered") || defender_counters > 0 {
        if total_counter > 0 {
            out.push_str(&format!(" · countered {}", total_counter));
            if defender_counters > 0 {
                out.push_str(&format!(" ({} from defenders)", defender_counters));
            }
        } else {
            out.push_str(" · countered");
        }
    }
    out
}

/// `intel.slot_map` — occupied/free build slots per ambit at a location.
/// Args: `{ location_id }`. Occupancy is read from the struct list; capacity is
/// best-effort from the location entity (planets start at 4/ambit).
async fn query_slot_map(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let location_id = match args.get("location_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("slot_map: missing required arg 'location_id'".to_string())],
    };
    let page = match client.guild.struct_list_by_location(&location_id, 1).await {
        Ok(p) => p,
        Err(e) => return vec![Content::text(format!("slot_map {}: {}", location_id, e))],
    };
    // occupied[ambit] = set of slot indices
    let mut occupied: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    for v in &page.items {
        if v.get("is_destroyed").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ambit = v.get("operating_ambit").and_then(|x| x.as_str()).unwrap_or("?").to_string();
        let slot = v.get("slot").and_then(|x| x.as_i64()).unwrap_or(-1);
        occupied.entry(ambit).or_default().push(slot);
    }
    let mut out = String::new();
    out.push_str(&format!("Slot map: {}\n", location_id));
    for ambit in ["space", "air", "land", "water"] {
        let used = occupied.get(ambit).map(|v| v.len()).unwrap_or(0);
        let slots = occupied.get(ambit).map(|v| {
            let mut s: Vec<String> = v.iter().map(|x| x.to_string()).collect();
            s.sort();
            s.join(",")
        }).unwrap_or_default();
        out.push_str(&format!("  {:<6} {} occupied [{}]\n", ambit, used, slots));
    }
    out.push_str("(Planets start at 4 slots/ambit; bunkers/world-engine expand capacity. 'occupied' is exact; free = capacity − occupied.)\n");
    vec![Content::text(out)]
}

/// `intel.is_active` — when a player last acted (online-likelihood signal).
/// Args: `{ player_id }`.
async fn query_is_active(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let player_id = match args.get("player_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("is_active: missing required arg 'player_id'".to_string())],
    };
    let current_block = GAME_STATE.read().unwrap().current_block_height;
    match client.guild.player_last_action_block(&player_id).await {
        Ok(v) => {
            // The guild API returns `{"last_action_block_height":"1337217"}` — note the
            // value is a STRING. Accept several key spellings and string-or-number values.
            let last = ["last_action_block_height", "lastActionBlockHeight", "height", "block_height"]
                .iter()
                .find_map(|k| v.get(*k).and_then(json_to_u64))
                .or_else(|| json_to_u64(&v));
            match last {
                Some(last) if current_block > 0 => {
                    let ago = current_block.saturating_sub(last);
                    let secs = ago * 6;
                    let hint = if ago <= 5 {
                        "very recently active — likely ONLINE & watching"
                    } else if ago <= 50 {
                        "recently active"
                    } else {
                        "quiet for a while — may be idle/away"
                    };
                    vec![Content::text(format!(
                        "Player {} last acted at block {} ({} blocks / ~{}s ago) — {}.",
                        player_id, last, ago, secs, hint
                    ))]
                }
                Some(last) => vec![Content::text(format!(
                    "Player {} last acted at block {} (current block unknown).",
                    player_id, last
                ))],
                None => vec![Content::text(format!(
                    "is_active: unexpected response for {}: {}",
                    player_id, v
                ))],
            }
        }
        Err(e) => vec![Content::text(format!("is_active {}: {}", player_id, e))],
    }
}

/// 3d — `intel.market`
///
/// Args: `{ denom?: string }`.
/// Aggregates providers + recent agreements into a "power-rental market" view.
async fn query_market(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let denom = args.get("denom").and_then(|v| v.as_str());

    let providers_res = match denom {
        Some(d) => client.guild.provider_by_denom(d, 1).await,
        None => client.guild.provider_all(1).await,
    };

    let agreements_res = client.guild.agreement_all(1).await;

    let mut out = String::new();
    let header = if let Some(d) = denom {
        format!("Market view — denom {}\n", d)
    } else {
        "Market view — all denoms\n".to_string()
    };
    out.push_str(&header);

    match providers_res {
        Ok(page) => {
            out.push_str(&format!("Providers offering capacity: {}\n", page.items.len()));
            for p in page.items.iter().take(5) {
                let owner = p.get("owner").and_then(|v| v.as_str()).unwrap_or("?");
                let cap = p.get("capacity_maximum").and_then(|v| v.as_str()).unwrap_or("?");
                out.push_str(&format!("  {} — cap_max {}\n", owner, cap));
            }
        }
        Err(e) => out.push_str(&format!("Providers: unavailable ({})\n", e)),
    }

    if let Ok(ag) = agreements_res {
        let recent: Vec<_> = ag.items.iter().take(5).collect();
        if !recent.is_empty() {
            out.push_str(&format!("\nRecent agreements: {}\n", recent.len()));
            for a in recent {
                let id = a.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                let prov = a.get("provider_id").and_then(|v| v.as_str()).unwrap_or("?");
                out.push_str(&format!("  {} (provider {})\n", id, prov));
            }
        }
    }

    vec![Content::text(out)]
}

/// 3e — `intel.metric_trend`
///
/// Args: `{ metric: string, object: string, window_blocks?: number = 100 }`.
/// Returns slope, min/max/mean, and current-vs-mean delta for a stat range.
async fn query_metric_trend(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let metric = match args.get("metric").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("metric_trend: missing 'metric'".to_string())],
    };
    let object = match args.get("object").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("metric_trend: missing 'object'".to_string())],
    };
    let window = args.get("window_blocks").and_then(|v| v.as_u64()).unwrap_or(100) as i64;

    let now = chrono::Utc::now().timestamp();
    let series = match client
        .guild
        .stat_range_by_object(&metric, &object, 1, now - window * 6, now)
        .await
    {
        Ok(page) => page.items,
        Err(e) => return vec![Content::text(format!("metric_trend unavailable: {}", e))],
    };

    let values: Vec<f64> = series
        .iter()
        .filter_map(|v| v.get("value").and_then(|x| x.as_f64()).or_else(|| {
            v.get("value").and_then(|x| x.as_str()).and_then(|s| s.parse().ok())
        }))
        .collect();

    if values.len() < 2 {
        return vec![Content::text(format!(
            "metric_trend({}, {}): not enough samples ({})",
            metric, object, values.len()
        ))];
    }

    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let slope = linreg_slope(&values);
    let current = *values.last().unwrap();

    let mut out = String::new();
    out.push_str(&format!("Metric {} (object {})\n", metric, object));
    out.push_str(&format!("  samples: {} over ~{} blocks\n", values.len(), window));
    out.push_str(&format!("  current: {:.3}  mean: {:.3}  Δ: {:+.3}\n", current, mean, current - mean));
    out.push_str(&format!("  range: [{:.3}, {:.3}]\n", min, max));
    out.push_str(&format!("  slope: {:+.5}/block\n", slope));

    vec![Content::text(out)]
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers used by analytical queries.
// ─────────────────────────────────────────────────────────────────────────

/// Best-effort slope read for power-related metrics. Returns Err when the API
/// can't satisfy the query (auth, unreachable, no data) so the caller can fall
/// back to the snapshot-only view.
async fn trend_slope(
    client: &CosmosClient,
    metric: &str,
    object_key: &str,
    window_blocks: i64,
) -> Result<f64, String> {
    let now = chrono::Utc::now().timestamp();
    let page = client
        .guild
        .stat_range_by_object(metric, object_key, 1, now - window_blocks * 6, now)
        .await?;
    let values: Vec<f64> = page
        .items
        .iter()
        .filter_map(|v| {
            v.get("value")
                .and_then(|x| x.as_f64())
                .or_else(|| v.get("value").and_then(|x| x.as_str()).and_then(|s| s.parse().ok()))
        })
        .collect();
    if values.len() < 2 {
        return Err("insufficient samples".into());
    }
    Ok(linreg_slope(&values))
}

/// Simple ordinary least-squares slope over evenly-spaced samples (`x = 0..n`).
fn linreg_slope(values: &[f64]) -> f64 {
    let n = values.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let x_mean = (n - 1.0) / 2.0;
    let y_mean = values.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (i, y) in values.iter().enumerate() {
        let dx = i as f64 - x_mean;
        num += dx * (y - y_mean);
        den += dx * dx;
    }
    if den == 0.0 {
        0.0
    } else {
        num / den
    }
}

/// Parse a timestamp field that might be RFC3339 string, ISO 8601, or unix seconds.
fn parse_timestamp(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(n) = v.as_f64() {
        return Some(n as i64);
    }
    if let Some(s) = v.as_str() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.timestamp());
        }
        // Postgres-style "2026-05-07 14:35:21.226052+00"
        if let Ok(dt) = chrono::DateTime::parse_from_str(
            &s.replace(' ', "T"),
            "%Y-%m-%dT%H:%M:%S%.f%#z",
        ) {
            return Some(dt.timestamp());
        }
    }
    None
}

// ══════════════════════════════════════════════════════════════════════════
// Raw entity access — absorbed from the retired `structs_query` tool.
// `structs_intel {query:"query", args:{type, id?, filter?, ...}}` reads one
// entity by id (LCD), lists a type with pagination (LCD), or routes a
// (type, filter.by) pair to the matching Guild API endpoint. Responses are
// enriched in place (status decode, type names, owner hints).
// ══════════════════════════════════════════════════════════════════════════
#[derive(Debug, Deserialize)]
pub struct RawQueryFilter {
    /// Filter dimension, e.g. "planet", "owner", "location", "provider".
    pub by: String,
    /// Filter value (the ID, owner address, etc.).
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct RawQueryParams {
    /// Entity type. Core (LCD-backed): player, planet, struct, struct_type, fleet, guild,
    /// reactor, substation, provider, agreement, allocation.
    /// Extended (Guild API-backed): planet_activity, struct_defender, work, grid,
    /// infusion, planet_attribute, struct_attribute, permission.
    pub r#type: String,
    /// Entity ID (e.g., "1-18" for player). If omitted with no `filter`, lists all.
    pub id: Option<String>,
    /// Pagination key for LCD list queries (from previous response).
    pub pagination_key: Option<String>,
    /// Max results per page for LCD list queries (default: 100).
    pub limit: Option<u32>,
    /// Filtered list query via Guild API. Mutually exclusive with `id`.
    pub filter: Option<RawQueryFilter>,
    /// Page number (1-indexed) for Guild API filtered queries. Defaults to 1.
    pub page: Option<u32>,
}

/// Guild-API types that have an UNFILTERED list endpoint. Listing one of these
/// with no filter used to fall through to the LCD, which answered "Unknown
/// entity type: planet_activity" — for a type the tool's own schema advertises.
/// The other Guild-API types genuinely require a filter, and reach
/// `route_guild_query`'s fallthrough, which names the valid pairs.
const GUILD_LISTABLE_TYPES: [&str; 3] = ["planet_activity", "agreement", "provider"];

async fn raw_query(client: &CosmosClient, params: RawQueryParams) -> Vec<Content> {
    let page = params.page.unwrap_or(1).max(1);
    let result: Result<Value, String> = if let Some(filter) = &params.filter {
        route_guild_query(client, &params.r#type, filter, page).await
    } else if let Some(id) = &params.id {
        client.query_entity(&params.r#type, id).await
    } else if GUILD_LISTABLE_TYPES.contains(&params.r#type.as_str()) {
        route_guild_query(
            client,
            &params.r#type,
            &RawQueryFilter { by: "all".into(), value: String::new() },
            page,
        )
        .await
    } else {
        client
            .list_entities(
                &params.r#type,
                params.pagination_key.as_deref(),
                params.limit,
            )
            .await
    };

    match result {
        Ok(mut data) => {
            enrich_response(&mut data);
            vec![Content::text(
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string()),
            )]
        }
        Err(e) => vec![Content::text(format!("Error: {}", crate::mcp::error_translator::translate_error(&e)))],
    }
}

/// Route a `(type, filter.by)` pair to the matching Guild API call.
/// Returns the unwrapped envelope `data` plus pagination hints when it's a page.
async fn route_guild_query(
    client: &CosmosClient,
    entity: &str,
    f: &RawQueryFilter,
    page: u32,
) -> Result<Value, String> {
    let g = &client.guild;
    let by = f.by.as_str();
    let v = f.value.as_str();

    // Pages → Value via crate::mcp::guild_api::GuildPage::into_response (adds page/has_more/_next_page).
    // Single-record GET → returned as-is.
    match (entity, by) {
        // planet-activity
        ("planet_activity", "planet") => g.planet_activity_by_planet(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("planet_activity", "category") => g.planet_activity_by_category(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("planet_activity", "all") | ("planet_activity", "") => g.planet_activity_all(page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // struct-defender
        ("struct_defender", "defending") => g.struct_defender_by_defending(v).await,
        ("struct_defender", "protected") => g.struct_defender_by_protected(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // structs by location/owner via Guild API
        ("struct", "location") => g.struct_list_by_location(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("struct", "owner") => g.struct_list_by_owner(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // grid
        ("grid", "object") => g.grid_by_object(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("grid", "attribute_type") | ("grid", "attribute-type") => g.grid_by_attribute_type(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // work
        ("work", "player") => g.work_by_player(v).await,
        ("work", "guild") => g.work_by_guild(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // infusions
        ("infusion", "player") => g.infusion_by_player(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("infusion", "destination") => g.infusion_by_destination(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("infusion", "address") => g.infusion_by_address(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // agreements
        ("agreement", "provider") => g.agreement_by_provider(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("agreement", "allocation") => g.agreement_by_allocation(v).await,
        ("agreement", "creator") => g.agreement_by_creator(v).await,
        ("agreement", "owner") => g.agreement_by_owner(v).await,
        ("agreement", "all") | ("agreement", "") => g.agreement_all(page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // providers
        ("provider", "owner") => g.provider_by_owner(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("provider", "denom") => g.provider_by_denom(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("provider", "substation") => g.provider_by_substation(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("provider", "all") | ("provider", "") => g.provider_all(page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // attributes
        ("planet_attribute", "object") => g.planet_attribute_by_object(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("planet_attribute", "type") => g.planet_attribute_by_type(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("struct_attribute", "object") => g.struct_attribute_by_object(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("struct_attribute", "type") => g.struct_attribute_by_type(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        // permissions
        ("permission", "object") => g.permission_by_object(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),
        ("permission", "player") => g.permission_by_player(v, page).await.map(crate::mcp::guild_api::GuildPage::into_response),

        _ => Err(format!(
            "Unsupported filter for type={}: filter.by={} (see the structs_intel raw-query arg docs for valid pairs)",
            entity, by
        )),
    }
}

/// Walk JSON recursively and add human-readable annotations.
/// Keeps original data intact, adds enrichment fields alongside.
fn enrich_response(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut additions = vec![];

            // Decode status bitflags
            if let Some(Value::String(s)) = map.get("status") {
                if let Ok(status) = s.parse::<u64>() {
                    additions.push((
                        "status_decoded".to_string(),
                        Value::String(crate::mcp::tools::format::decode_status(status)),
                    ));
                }
            }
            if let Some(Value::Number(n)) = map.get("status") {
                if let Some(status) = n.as_u64() {
                    additions.push((
                        "status_decoded".to_string(),
                        Value::String(crate::mcp::tools::format::decode_status(status)),
                    ));
                }
            }

            // Decode permission bitmask (25-bit) on permission-specific fields
            for field in &["permissions", "perms", "permission_flags", "val"] {
                let mask = match map.get(*field) {
                    Some(Value::String(s)) => s.parse::<u64>().ok(),
                    Some(Value::Number(n)) => n.as_u64(),
                    _ => None,
                };
                if let Some(mask) = mask {
                    additions.push((
                        format!("{}_decoded", field),
                        Value::String(crate::mcp::tools::format::decode_permissions(mask)),
                    ));
                }
            }

            // Resolve struct type ID to name
            if let Some(type_val) = map.get("type").or(map.get("structType")) {
                let type_id_str = match type_val {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                };
                if let Some(type_id) = type_id_str {
                    let gs = GAME_STATE.read().unwrap();
                    if let Some(st) = gs.struct_types.get(&type_id) {
                        additions.push((
                            "type_name".to_string(),
                            Value::String(st.name.clone()),
                        ));
                        // Surface max HP alongside the (already-present) health field
                        // so a struct query shows current/max at a glance.
                        if let Some(max) = st.max_health {
                            additions.push((
                                "health_max".to_string(),
                                Value::Number(serde_json::Number::from(max as u64)),
                            ));
                        }
                    }
                }
            }

            // Resolve owner to player name
            if let Some(Value::String(owner)) = map.get("owner") {
                let gs = GAME_STATE.read().unwrap();
                if gs.player_id.as_deref() == Some(owner.as_str()) {
                    if let Some(name) = &gs.player_name {
                        additions.push((
                            "owner_name".to_string(),
                            Value::String(format!("{} (you)", name)),
                        ));
                    }
                }
                // Add entity type hint
                additions.push((
                    "owner_type".to_string(),
                    Value::String(crate::mcp::tools::format::entity_type_from_id(owner).to_string()),
                ));
            }

            // Entity ID type hints for common reference fields
            for field in &["playerId", "player_id", "planetId", "planet_id", "fleetId", "fleet_id", "guildId", "guild_id"] {
                if let Some(Value::String(id)) = map.get(*field) {
                    let type_name = crate::mcp::tools::format::entity_type_from_id(id);
                    if type_name != "Unknown" {
                        additions.push((
                            format!("{}_type", field),
                            Value::String(type_name.to_string()),
                        ));
                    }
                }
            }

            // Apply additions
            for (key, val) in additions {
                map.insert(key, val);
            }

            // Recurse into nested objects
            for (_, v) in map.iter_mut() {
                enrich_response(v);
            }
        }
        Value::Array(arr) => {
            for v in arr.iter_mut() {
                enrich_response(v);
            }
        }
        _ => {}
    }
}
