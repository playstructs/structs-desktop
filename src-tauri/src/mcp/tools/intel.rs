use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::game_state::{GameStateSync, GAME_STATE};
use crate::hasher::types::TaskRegistry;

#[derive(Debug, Deserialize)]
pub struct IntelParams {
    /// Query type: what_can_i_build, power_forecast, economy_status, valid_targets, plan_timeline
    pub query: String,
    /// Query-specific arguments
    #[serde(default)]
    pub args: Value,
}

pub async fn execute(registry: &Arc<TaskRegistry>, params: IntelParams) -> Vec<Content> {
    match params.query.as_str() {
        "what_can_i_build" => query_buildable(),
        "power_forecast" => query_power_forecast(&params.args),
        "economy_status" => query_economy(registry),
        "plan_timeline" => query_timeline(registry, &params.args),
        other => vec![Content::text(format!(
            "Unknown intel query '{}'. Available: what_can_i_build, power_forecast, economy_status, plan_timeline",
            other
        ))],
    }
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

fn query_power_forecast(args: &Value) -> Vec<Content> {
    let build_type = args
        .get("struct_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let count = args.get("count").and_then(|v| v.as_u64()).unwrap_or(1);

    let gs = GAME_STATE.read().unwrap();
    let load = gs.total_load();
    let capacity = gs.total_capacity();

    let mut out = String::new();
    out.push_str(&format!(
        "Current: {}/{} ({:.0}% utilization)\n\n",
        format_power(load),
        format_power(capacity),
        if capacity > 0.0 { load / capacity * 100.0 } else { 0.0 }
    ));

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
        format_alpha(gs.alpha.unwrap_or(0.0)),
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
        let eta_seconds = blocks_remaining * 5;

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
    let block_time_ms = 5000.0;
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

fn format_alpha(ualpha: f64) -> String {
    let abs = ualpha.abs();
    if abs >= 1e18 { format!("{:.2}Tg", ualpha / 1e18) }
    else if abs >= 1e9 { format!("{:.2}Kg", ualpha / 1e9) }
    else if abs >= 1e6 { format!("{:.2}g", ualpha / 1e6) }
    else if abs >= 1e3 { format!("{:.2}mg", ualpha / 1e3) }
    else { format!("{:.0}μg", ualpha) }
}

fn format_ore(ore: f64) -> String {
    if ore >= 1e12 { format!("{:.2}Tg", ore / 1e12) }
    else if ore >= 1e3 { format!("{:.2}Kg", ore / 1e3) }
    else { format!("{:.0}g", ore) }
}

fn format_power(milliwatts: f64) -> String {
    let abs = milliwatts.abs();
    if abs >= 1e6 { format!("{:.1}KW", milliwatts / 1e6) }
    else if abs >= 1e3 { format!("{:.1}W", milliwatts / 1e3) }
    else { format!("{:.0}mW", milliwatts) }
}
