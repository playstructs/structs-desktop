use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::game_state::{GameStateSync, GAME_STATE};
use crate::hasher::types::TaskRegistry;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::guild_api::fetch_all_pages;

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
        "what_can_i_build" => query_buildable(),
        "economy_status" => query_economy(registry),
        "plan_timeline" => query_timeline(registry, &params.args),
        // Power forecast: tries trend first, falls back to snapshot.
        "power_forecast" => query_power_forecast(client, &params.args).await,
        // Guild-API-backed analytical queries
        "planet_history" => query_planet_history(client, &params.args).await,
        "valid_targets" => query_valid_targets(client, &params.args).await,
        "scout" => query_scout(client, &params.args).await,
        "market" => query_market(client, &params.args).await,
        "metric_trend" => query_metric_trend(client, &params.args).await,
        other => vec![Content::text(format!(
            "Unknown intel query '{}'. Available: what_can_i_build, power_forecast, economy_status, plan_timeline, planet_history, valid_targets, scout, market, metric_trend",
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
    let (candidates, my_player_id, my_charge, weapon_mask): (Vec<(String, u64)>, Option<String>, u64, Option<u64>) = {
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
                .filter(|(_, s)| s.status & 32 == 0) // not destroyed
                .map(|(id, s)| {
                    let bit = s.operating_ambit.as_deref().map(ambit_bit).unwrap_or(0);
                    (id.clone(), bit)
                })
                .collect::<Vec<_>>()
        };
        (ids, my_id, charge, weapon_mask)
    };

    let candidates: Vec<(String, u64)> = if let Some(loc) = near.as_deref() {
        match client.guild.struct_list_by_location(loc, 1).await {
            Ok(page) => page
                .items
                .iter()
                .filter_map(|v| {
                    let id = v.get("id").and_then(|x| x.as_str())?.to_string();
                    let bit = v
                        .get("operating_ambit")
                        .and_then(|x| x.as_str())
                        .map(ambit_bit)
                        .unwrap_or(0);
                    Some((id, bit))
                })
                .collect(),
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

    // (id, defender_count, reachable, note)
    let mut targets: Vec<(String, usize, bool, String)> = Vec::new();
    for (id, ambit) in candidates.iter().take(20) {
        let defenders = match client.guild.struct_defender_by_protected(id, 1).await {
            Ok(page) => page.items,
            Err(_) => vec![],
        };
        let defender_count = defenders.len();
        let def_note = if defender_count == 0 {
            "undefended".to_string()
        } else if defender_count == 1 {
            "1 defender".to_string()
        } else {
            format!("{} defenders", defender_count)
        };
        // Reachable unless we know the weapon mask and it doesn't cover the ambit.
        let reachable = match weapon_mask {
            Some(mask) if *ambit != 0 => (mask & *ambit) != 0,
            _ => true,
        };
        let note = if weapon_mask.is_some() && !reachable {
            format!("{} — OUT OF WEAPON AMBIT (cannot reach)", def_note)
        } else {
            def_note
        };
        targets.push((id.clone(), defender_count, reachable, note));
    }

    // Rank: reachable first, then undefended first, then lowest defender count.
    targets.sort_by(|a, b| {
        b.2.cmp(&a.2).then(a.1.cmp(&b.1))
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
    for (id, _, _, note) in &targets {
        out.push_str(&format!("  {}  — {}\n", id, note));
    }
    out.push_str("\nNote: defender chains are read live from the Guild API.\n");

    vec![Content::text(out)]
}

/// 3c — `intel.scout`
///
/// Args: `{ location_id: string }`.
/// Parallel fetch of structs-at-location and grid-by-object, returns a summary.
async fn query_scout(client: &CosmosClient, args: &Value) -> Vec<Content> {
    let location_id = match args.get("location_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return vec![Content::text("scout: missing required arg 'location_id'".to_string())],
    };

    let (structs_res, grid_res) = tokio::join!(
        client.guild.struct_list_by_location(&location_id, 1),
        client.guild.grid_by_object(&location_id, 1),
    );

    let mut out = String::new();
    out.push_str(&format!("Scout: {}\n", location_id));

    match structs_res {
        Ok(page) => {
            let by_type: std::collections::HashMap<String, usize> =
                page.items.iter().fold(std::collections::HashMap::new(), |mut m, v| {
                    let t = v
                        .get("type")
                        .and_then(|x| x.as_str())
                        .or_else(|| v.get("struct_type").and_then(|x| x.as_str()))
                        .unwrap_or("?");
                    *m.entry(t.to_string()).or_insert(0) += 1;
                    m
                });
            out.push_str(&format!("Structs present: {}\n", page.items.len()));
            for (t, n) in by_type.iter() {
                out.push_str(&format!("  {} × {}\n", n, t));
            }
        }
        Err(e) => out.push_str(&format!("Structs: unavailable ({})\n", e)),
    }

    match grid_res {
        Ok(page) => {
            if !page.items.is_empty() {
                out.push_str(&format!("Grid attributes: {} entries\n", page.items.len()));
            }
        }
        Err(_) => {}
    }

    vec![Content::text(out)]
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
