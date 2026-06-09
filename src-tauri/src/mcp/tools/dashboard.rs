use rmcp::model::Content;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;

use crate::game_state::GAME_STATE;
use crate::hasher::types::TaskRegistry;
use crate::mcp::cosmos_client::CosmosClient;

#[derive(Debug, Deserialize)]
pub struct DashboardParams {
    /// Player ID (e.g., "1-18"). If omitted, uses the currently logged-in player.
    pub player_id: Option<String>,
}

struct SyncOutput {
    out: String,
    me: Option<String>,
    owned_planets: Vec<String>,
    local_task_count: usize,
}

pub async fn execute(
    client: &CosmosClient,
    registry: &Arc<TaskRegistry>,
    params: DashboardParams,
) -> Vec<Content> {
    // All synchronous dashboard rendering happens inside `build_sync`, which
    // owns the RwLockReadGuard and releases it on return. We then await the
    // Guild API enrichments outside any lock — required for Send.
    let SyncOutput {
        mut out,
        me,
        owned_planets,
        local_task_count,
    } = match build_sync(registry, &params) {
        Ok(s) => s,
        Err(content) => return content,
    };

    if let Some(my_id) = me {
        // 1. Active work line (work_by_player) — flag chain/local desync.
        let work_fut = client.guild.work_by_player(&my_id);
        if let Ok(Ok(work)) =
            tokio::time::timeout(Duration::from_millis(500), work_fut).await
        {
            let active_count = match &work {
                serde_json::Value::Array(a) => a.len(),
                serde_json::Value::Object(_) => 1,
                _ => 0,
            };
            if active_count > 0 || local_task_count > 0 {
                let desync = if active_count != local_task_count {
                    format!(" (local says {}, chain says {})", local_task_count, active_count)
                } else {
                    String::new()
                };
                out.push_str(&format!("\nMining: {} active tasks{}\n", active_count, desync));
            }
        }

        // 2. Activity warning — scan owned planets for hostile events in last 5 min.
        let now = chrono::Utc::now().timestamp();
        let cutoff = now - 300;
        for planet_id in owned_planets.iter().take(5) {
            let fut = client.guild.planet_activity_by_planet(planet_id, 1);
            if let Ok(Ok(page)) =
                tokio::time::timeout(Duration::from_millis(500), fut).await
            {
                for ev in page.items.iter().take(20) {
                    let ts = ev
                        .get("created_at")
                        .or(ev.get("timestamp"))
                        .and_then(|v| v.as_str())
                        .and_then(parse_pg_timestamp);
                    let category = ev.get("category").and_then(|v| v.as_str()).unwrap_or("");
                    let is_hostile = matches!(category, "raid" | "attack" | "conquer");
                    if let Some(t) = ts {
                        if t >= cutoff && is_hostile {
                            let actor = ev
                                .get("actor_player_id")
                                .or(ev.get("creator"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            out.push_str(&format!(
                                "⚠ Planet {} {} {}s ago by {}\n",
                                planet_id,
                                category,
                                now - t,
                                actor
                            ));
                            break;
                        }
                    }
                }
            }
        }
    }

    vec![Content::text(out)]
}

fn parse_pg_timestamp(s: &str) -> Option<i64> {
    // RFC3339 first
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    // Postgres "2026-05-07 14:35:21.226052+00"
    let normalized = s.replace(' ', "T");
    if let Ok(dt) = chrono::DateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S%.f%#z") {
        return Some(dt.timestamp());
    }
    None
}

/// Builds the synchronous portion of the dashboard. Owns the GAME_STATE read
/// guard for its entire scope and releases it on return — the guard is not
/// `Send`, so this MUST stay non-async and not hold the lock across awaits.
fn build_sync(
    registry: &Arc<TaskRegistry>,
    params: &DashboardParams,
) -> Result<SyncOutput, Vec<Content>> {
    let gs = GAME_STATE.read().unwrap();

    let player_id = params
        .player_id
        .clone()
        .or_else(|| gs.player_id.clone())
        .unwrap_or_default();

    if player_id.is_empty() {
        return Err(vec![Content::text(
            "Player ID not available yet — the Structs app is still loading game state.\n\
            Call structs_intel {query:\"whoami\"} to check sync status, retry in a few seconds, \
            or pass player_id explicitly (e.g., '1-18').",
        )]);
    }

    let mut out = String::new();

    if gs.player_id.as_deref() == Some(&player_id) {
        // ── Header ──
        let name = gs.player_name.as_deref().unwrap_or("Unknown");
        let guild = gs.guild_id.as_deref().unwrap_or("None");
        out.push_str(&format!("Player: {} ({}) — Guild: {}\n", name, player_id, guild));

        // ── Power ──
        let total_load = gs.total_load();
        let total_capacity = gs.total_capacity();
        let online = total_load <= total_capacity || total_capacity == 0.0;
        let margin = if total_capacity > 0.0 {
            ((total_capacity - total_load) / total_capacity * 100.0) as i32
        } else {
            0
        };
        let load_alloc = gs.load.unwrap_or(0.0);
        let load_structs = gs.structs_load.unwrap_or(0.0);
        let cap_personal = gs.capacity.unwrap_or(0.0);
        let cap_substation = gs.capacity_secondary.unwrap_or(0.0);
        out.push_str(&format!(
            "Power: {}/{} ({}, {}% margin){}\n",
            format_power(total_load),
            format_power(total_capacity),
            if online { "online" } else { "OFFLINE" },
            margin.max(0),
            if !online { " ⚠ HALTED — all operations stopped!" } else { "" }
        ));
        out.push_str(&format!(
            "  Load: {} allocated + {} structs | Capacity: {} personal + {} substation\n",
            format_power(load_alloc),
            format_power(load_structs),
            format_power(cap_personal),
            format_power(cap_substation),
        ));

        // ── Charge ──
        // Charge is a single player-level value = blocks since your last action.
        // ANY charged action resets it to 0, and "cost" is a minimum threshold,
        // not a subtracted pool — so banking beyond one action's cost does nothing.
        // Surface that honestly + per-action readiness, so nobody idles to
        // "stockpile a burst" that doesn't exist.
        let charge = gs.get_charge();
        let ready = |cost: u64| -> String {
            if charge >= cost {
                "ready".to_string()
            } else {
                format!("~{}s", gs.blocks_until_charge(cost) * 6)
            }
        };
        // Cheapest attack = lowest primary-weapon charge among your online combat structs.
        let cheapest_attack = gs
            .structs
            .values()
            .filter(|s| s.status & 4 != 0 && s.status & 32 == 0)
            .filter_map(|s| gs.struct_types.get(&s.struct_type_id.to_string()))
            .filter_map(|t| t.primary_weapon_charge)
            .filter(|c| *c > 0)
            .min();
        out.push_str(&format!("Charge: {} (blocks since your last action)\n", charge));
        out.push_str(
            "  ⚠ Any action resets charge to 0 — you can't bank or burst. One action, then wait.\n",
        );
        out.push_str(&format!(
            "  Ready → build {} · move {} · mine/refine {} · activate/defend {}",
            ready(8),
            ready(8),
            ready(20),
            ready(1)
        ));
        match cheapest_attack {
            Some(c) => out.push_str(&format!(" · attack(min {}) {}\n", c, ready(c))),
            None => out.push('\n'),
        }

        // ── Resources ──
        let alpha = gs.alpha.unwrap_or(0.0);
        let ore = gs.ore.unwrap_or(0.0);
        let stored_ore = gs.stored_ore.unwrap_or(0.0);
        out.push_str(&format!(
            "Alpha: {} | Ore: {}",
            format_alpha(alpha),
            format_ore(ore)
        ));
        if stored_ore > 0.0 {
            out.push_str(&format!(" | Stored Ore: {} (RAIDABLE!)", format_ore(stored_ore)));
        }
        out.push('\n');
        if stored_ore > 0.0 {
            out.push_str(
                "  ⚠ Stored ore is vulnerable for the whole refining window (~34h at D=3). A successful raid takes ALL of it — refine promptly.\n",
            );
        }

        // ── Planet & Fleet ──
        out.push('\n');
        if let Some(planet_id) = &gs.planet_id {
            let planet_ore_str = match gs.planet_ore {
                Some(o) if o <= 0.0 => " — ore depleted (can explore new planet)".to_string(),
                Some(o) => format!(" — {} ore remaining", o),
                None => String::new(),
            };
            out.push_str(&format!("Planet: {}{}\n", planet_id, planet_ore_str));
        }
        if let Some(fleet_id) = &gs.fleet_id {
            let fleet_status = gs.fleet_status.as_deref().unwrap_or("unknown");
            out.push_str(&format!("Fleet: {} ({})\n", fleet_id, fleet_status));
        }

        // ── Structs ──
        out.push('\n');
        if gs.structs.is_empty() {
            out.push_str("Structs: None\n");
        } else {
            out.push_str(&format!("Structs ({}):\n", gs.structs.len()));
            let mut structs: Vec<_> = gs.structs.iter().collect();
            structs.sort_by_key(|(id, _)| id.clone());

            for (sid, s) in &structs {
                let type_name = gs
                    .struct_types
                    .get(&s.struct_type_id.to_string())
                    .map(|t| t.name.as_str())
                    .unwrap_or("Unknown");
                let status = crate::mcp::tools::format::decode_status(s.status);
                let ambit = s.operating_ambit.as_deref().unwrap_or("?");
                // HP cur/max — health is already synced; max from the struct type.
                let hp = {
                    let max = gs
                        .struct_types
                        .get(&s.struct_type_id.to_string())
                        .and_then(|t| t.max_health);
                    match (s.health, max) {
                        (Some(h), Some(m)) => format!(" HP {:.0}/{:.0}", h, m),
                        (Some(h), None) => format!(" HP {:.0}", h),
                        _ => String::new(),
                    }
                };

                let hash_info = registry
                    .tasks
                    .get(*sid)
                    .map(|entry| {
                        let snap = entry.value().snapshot();
                        let task_type = snap.task_type.as_deref().unwrap_or("?");
                        if snap.status == "completed" {
                            format!(" — {} complete!", task_type)
                        } else if snap.status == "waiting" {
                            format!(" — {} waiting (difficulty too high)", task_type)
                        } else {
                            let hr = if snap.estimated_hashrate > 1000.0 {
                                format!("{:.0}M h/s", snap.estimated_hashrate / 1000.0)
                            } else {
                                format!("{:.0}K h/s", snap.estimated_hashrate)
                            };
                            format!(" — {} in progress ({})", task_type, hr)
                        }
                    })
                    .unwrap_or_default();

                out.push_str(&format!(
                    "  {} {:<20} [{}] {}{}{}\n",
                    sid, type_name, status, ambit, hp, hash_info
                ));
            }
        }

        // ── Hash Tasks (not tied to structs) ──
        let orphan_tasks: Vec<_> = registry
            .tasks
            .iter()
            .filter(|entry| !gs.structs.contains_key(entry.key()))
            .collect();
        if !orphan_tasks.is_empty() {
            out.push('\n');
            out.push_str("Hash Tasks (external):\n");
            for entry in &orphan_tasks {
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

        // ── Recent Events ──
        {
            let events = crate::mcp::event_buffer::get_recent(10, None, None);
            if !events.is_empty() {
                out.push('\n');
                out.push_str("Recent Events:\n");
                for event in &events {
                    let detail_str = if event.detail.is_object() && !event.detail.as_object().unwrap().is_empty() {
                        let obj = event.detail.as_object().unwrap();
                        let mut parts = vec![];
                        for (k, v) in obj.iter().take(3) {
                            parts.push(format!("{}={}", k, v));
                        }
                        format!(" ({})", parts.join(", "))
                    } else {
                        String::new()
                    };
                    out.push_str(&format!("  {} — {}{}\n", event.category, event.subject, detail_str));
                }
            }
        }

        // ── Struct Types Reference ──
        if !gs.struct_types.is_empty() {
            out.push('\n');
            out.push_str("Struct Types:\n");
            let mut types: Vec<_> = gs.struct_types.values().collect();
            types.sort_by(|a, b| a.name.cmp(&b.name));
            for t in &types {
                let draw = t.passive_draw.map(|d| format_power(d)).unwrap_or_default();
                out.push_str(&format!(
                    "  {:<24} build:{:<6} mine:{:<6} refine:{:<6} draw:{}\n",
                    t.name, t.build_difficulty, t.ore_mining_difficulty, t.ore_refining_difficulty, draw
                ));
            }
        }
    } else {
        out.push_str(&format!(
            "Player {} is not the logged-in player. Only local player data is available.\n",
            player_id
        ));
    }

    out.push_str(&format!("\nBlock height: {}\n", gs.current_block_height));

    // Capture the bits the async section needs, then drop `gs` (implicit at
    // return). Owned planet IDs are derived from struct location_ids that
    // look like planet entity refs ("2-…").
    let owned_planets: Vec<String> = gs
        .structs
        .values()
        .filter_map(|s| s.location_id.clone())
        .filter(|id| id.starts_with("2-"))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let me = gs.player_id.clone();
    let local_task_count = registry.tasks.len();

    Ok(SyncOutput {
        out,
        me,
        owned_planets,
        local_task_count,
    })
}

fn format_alpha(ualpha: f64) -> String {
    let abs = ualpha.abs();
    if abs >= 1e18 {
        format!("{:.2}Tg", ualpha / 1e18)
    } else if abs >= 1e9 {
        format!("{:.2}Kg", ualpha / 1e9)
    } else if abs >= 1e6 {
        format!("{:.2}g", ualpha / 1e6)
    } else if abs >= 1e3 {
        format!("{:.2}mg", ualpha / 1e3)
    } else {
        format!("{:.0}μg", ualpha)
    }
}

fn format_ore(ore: f64) -> String {
    if ore >= 1e12 {
        format!("{:.2}Tg", ore / 1e12)
    } else if ore >= 1e3 {
        format!("{:.2}Kg", ore / 1e3)
    } else {
        format!("{:.0}g", ore)
    }
}

fn format_power(milliwatts: f64) -> String {
    let abs = milliwatts.abs();
    if abs >= 1e18 {
        format!("{:.1}TW", milliwatts / 1e18)
    } else if abs >= 1e9 {
        format!("{:.1}MW", milliwatts / 1e9)
    } else if abs >= 1e6 {
        format!("{:.1}KW", milliwatts / 1e6)
    } else if abs >= 1e3 {
        format!("{:.1}W", milliwatts / 1e3)
    } else {
        format!("{:.0}mW", milliwatts)
    }
}
