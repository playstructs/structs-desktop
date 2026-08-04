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
use crate::mcp::virtual_players::{VPlayerRole, VirtualPlayer, MAX_VIRTUAL_PLAYERS, REGISTRY};

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
    /// role: "bait" | "productive" — sets a virtual player's purpose.
    #[serde(default)]
    pub role: Option<String>,
    /// create: guild the new player must join. Signup always goes through the
    /// ACTIVE guild's API, so a mismatch errors rather than redirecting —
    /// switch the active guild first (apply_guild_switch) for cross-guild signup.
    #[serde(default)]
    pub guild_id: Option<String>,
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
                            "role": p.role.as_str(),
                            "status": if p.player_id.is_some() { "active" } else { "pending" },
                        })
                    })
                    .collect()
            };
            vec![Content::text(
                serde_json::to_string_pretty(&json!({
                    "count": players.len(),
                    "max": if MAX_VIRTUAL_PLAYERS == 0 { json!("unlimited") } else { json!(MAX_VIRTUAL_PLAYERS) },
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
            let vplayers: Vec<(u32, String, Option<String>, VPlayerRole)> = {
                let reg = REGISTRY.read().unwrap();
                reg.players
                    .iter()
                    .map(|p| (p.index, p.name.clone(), p.player_id.clone(), p.role))
                    .collect()
            };
            if vplayers.is_empty() {
                out.push_str("  (no virtual players — create with structs_players create {name})\n");
            }
            for (index, name, player_id, role) in vplayers {
                let Some(pid) = player_id else {
                    out.push_str(&format!("    [idx {}] {} ({}) — signup pending\n", index, name, role.as_str()));
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
                    "    [idx {}] {} {} ({}) — planet {} · fleet {} · {} structs · alpha {} ore {}\n",
                    index, pid, name, role.as_str(), planet, fleet, nstructs, alpha, ore
                ));
            }
            out.push_str("\nAct as any player: structs_players act {player, …} or structs_sequence {as, steps}.\n");
            vec![Content::text(out)]
        }

        // Read-only power-budget view: how much the guild substation can still
        // power, salvaged from the bash bot's capacity/(connections+1) heuristic.
        "capacity" => {
            let guild_id_opt = { crate::game_state::GAME_STATE.read().unwrap().guild_id.clone() };
            let Some(gid) = guild_id_opt.as_deref().filter(|s| !s.is_empty()) else {
                return vec![Content::text(
                    "No guild yet — virtual players need one.\n\
                     FOR THE HUMAN: open the Structs window, sign in, and pick a guild (it \
                     covers your join fee). FOR THE AGENT: retry once the app has synced; \
                     structs_intel {query:\"whoami\"} shows sync status."
                        .to_string(),
                )];
            };
            match crate::mcp::guild_power::resolve_guild_power(client, gid).await {
                Ok(gp) => {
                    let (nvp, ours) = {
                        let reg = REGISTRY.read().unwrap();
                        let ours: std::collections::HashSet<String> =
                            reg.players.iter().filter_map(|p| p.player_id.clone()).collect();
                        (reg.players.len(), ours)
                    };
                    let primary_pid = { crate::game_state::GAME_STATE.read().unwrap().player_id.clone().unwrap_or_default() };
                    let mine = |owner: &str| -> &'static str {
                        if owner.is_empty() { "" }
                        else if owner == primary_pid { " (you)" }
                        else if ours.contains(owner) { " (your vplayer)" }
                        else { " (external)" }
                    };
                    let mut out = format!(
                        "Guild power — guild {} · substation {} (owner {}{}) · reactor {} (owner {}{})\n\
                         Substation: capacity {:.1} kW · {} connections · {:.2} kW per connection · load {:.2} kW\n\
                         Reactor: fuel {:.1} kW · capacity {:.1} kW · {}% commission\n\
                         One more connection → {:.2} kW each.\n\
                         Headroom at ~{:.1} kW/player: ~{} more players (guild-wide).\n\
                         Local virtual players: {} (hard cap: {}).\n",
                        gp.guild_id,
                        gp.substation_id, if gp.substation_owner.is_empty() { "?" } else { &gp.substation_owner }, mine(&gp.substation_owner),
                        gp.reactor_id, if gp.reactor_owner.is_empty() { "?" } else { &gp.reactor_owner }, mine(&gp.reactor_owner),
                        gp.sub_capacity / 1e6, gp.sub_connection_count, gp.sub_connection_capacity / 1e6, gp.sub_load / 1e6,
                        gp.reactor_fuel / 1e6, gp.reactor_capacity / 1e6, (gp.reactor_commission * 100.0) as i64,
                        gp.share_if_one_more / 1e6,
                        crate::mcp::guild_power::MIN_PLAYER_DRAW_MW / 1e6, gp.supportable_more,
                        nvp,
                        if MAX_VIRTUAL_PLAYERS == 0 { "unlimited".to_string() } else { MAX_VIRTUAL_PLAYERS.to_string() },
                    );

                    // ── Self-host break-even (1 ualpha → 1 W, minus commission) ──
                    // Should the operator build their OWN substation for the vplayers
                    // instead of using the guild's free connection? Only if they can
                    // infuse enough to beat the free per-connection power.
                    let my_ualpha = match client.query_entity("player", &primary_pid).await {
                        Ok(v) => v
                            .get("playerInventory").and_then(|i| i.get("rocks")).and_then(|r| r.get("amount"))
                            .and_then(|a| a.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                        Err(_) => 0.0,
                    };
                    let infusable_w = my_ualpha * (1.0 - gp.reactor_commission); // mW to personal capacity (1 ualpha = 1 mW)
                    let free = gp.sub_connection_capacity.max(1.0);
                    let conns = (nvp.max(1)) as f64; // self-host the vplayers
                    let self_each = infusable_w / conns;
                    // ualpha needed to MATCH free power for `conns` connections.
                    let breakeven = free * conns / (1.0 - gp.reactor_commission);
                    out.push_str(&format!(
                        "\nSelf-host break-even (build your own substation for the {} vplayers):\n\
                         Your infusable alpha: {:.0} ualpha → ~{:.2} kW personal capacity.\n\
                         Split across {} vplayers = {:.2} kW each vs {:.2} kW FREE from the guild → self-host {}.\n\
                         To MATCH the free power you'd need ~{:.0} ualpha (you have {:.0}).\n\
                         {}",
                        nvp,
                        my_ualpha, infusable_w / 1e6,
                        nvp, self_each / 1e6, free / 1e6,
                        if self_each >= free { "WINS" } else { "LOSES (guild free power is better)" },
                        breakeven, my_ualpha,
                        if self_each >= free {
                            "→ Worth considering for independence/scale; sequence: infuse → MsgAllocationCreate(source=you) → MsgSubstationCreate → MsgSubstationPlayerMigrate the vplayers.\n"
                        } else {
                            "→ Keep the vplayers on the free guild substation. Better use of alpha: infuse to grow the PRIMARY's own capacity (it's near its free-connection cap) or sell surplus on the energy market.\n"
                        }
                    ));
                    vec![Content::text(out)]
                }
                Err(e) => vec![Content::text(format!("Couldn't resolve guild power: {}", e))],
            }
        }

        // Set a virtual player's purpose: bait (mine-only, ore piles up) vs
        // productive (runs the flywheel via `economy`).
        "role" => {
            let Some(key) = params.player.as_deref().filter(|s| !s.is_empty()) else {
                return vec![Content::text(
                    "Error: player required (index, address, or player id).".to_string(),
                )];
            };
            let roles = || {
                VPlayerRole::ALL
                    .iter()
                    .map(|r| format!("\"{}\"", r.as_str()))
                    .collect::<Vec<_>>()
                    .join(" | ")
            };
            let Some(role_str) = params.role.as_deref().filter(|s| !s.is_empty()) else {
                return vec![Content::text(format!("Error: role required — {}.", roles()))];
            };
            let Some(role) = VPlayerRole::parse(role_str) else {
                return vec![Content::text(format!(
                    "Error: unknown role '{}'. Use {}.",
                    role_str,
                    roles()
                ))];
            };
            let mut reg = REGISTRY.write().unwrap();
            let Some(p) = reg.players.iter_mut().find(|p| {
                p.address == key || p.player_id.as_deref() == Some(key) || p.index.to_string() == key
            }) else {
                return vec![Content::text(format!(
                    "No virtual player matches '{}'. Use structs_players list.",
                    key
                ))];
            };
            p.role = role;
            let (name, idx) = (p.name.clone(), p.index);
            let _ = reg.save();
            let note = match role {
                VPlayerRole::Bait => "mines only; ore accumulates on its planet as raid bait (no refinery, no transfers).",
                VPlayerRole::Productive => "runs the flywheel: mine → refine → send alpha to the primary (drive it with structs_players economy).",
                VPlayerRole::Raider => "expendable offensive arm for auto_raid: no extractor, keeps a refinery to launder seized ore into Alpha. Losing its Command Ship is affordable — the primary never leaves home.",
            };
            vec![Content::text(format!(
                "Virtual player {} (idx {}) → role {} — {}",
                name, idx, role.as_str(), note
            ))]
        }

        // Flywheel planner: for each PRODUCTIVE virtual player, name the next
        // step (mine → refine → send alpha to primary). Advises — execution stays
        // on the audited `act` path so nothing signs implicitly. Drive it in a loop.
        "economy" => {
            let (primary_addr, primary_alpha, primary_pid, guild_id) = {
                let gs = crate::game_state::GAME_STATE.read().unwrap();
                (
                    gs.wallet_address.clone().unwrap_or_default(),
                    gs.alpha.unwrap_or(0.0),
                    gs.player_id.clone().unwrap_or_default(),
                    gs.guild_id.clone().unwrap_or_default(),
                )
            };
            let productive: Vec<(u32, String, Option<String>)> = {
                let reg = REGISTRY.read().unwrap();
                reg.players
                    .iter()
                    .filter(|p| p.role == VPlayerRole::Productive)
                    .map(|p| (p.index, p.name.clone(), p.player_id.clone()))
                    .collect()
            };
            let mut out = String::new();
            out.push_str("⚙ Flywheel plan — productive players → primary → reactor\n");
            if productive.is_empty() {
                out.push_str(
                    "No productive players. Set one: structs_players role {player:<idx>, role:\"productive\"}.\n\
                     (Bait players just mine; their ore stays on-planet as raid bait.)\n",
                );
                return vec![Content::text(out)];
            }
            const MIN_SEND_UALPHA: f64 = 1_000_000.0; // ~1 alpha
            for (index, name, player_id) in productive {
                let Some(pid) = player_id else {
                    out.push_str(&format!("  [idx {}] {} — signup pending\n", index, name));
                    continue;
                };
                let (ore, alpha_raw) = match client.query_entity("player", &pid).await {
                    Ok(v) => {
                        let numf = |val: Option<&Value>| -> f64 {
                            match val {
                                Some(Value::String(s)) => s.parse().unwrap_or(0.0),
                                Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                                _ => 0.0,
                            }
                        };
                        (
                            numf(v.get("gridAttributes").and_then(|g| g.get("ore"))),
                            numf(v.get("playerInventory").and_then(|i| i.get("rocks")).and_then(|r| r.get("amount"))),
                        )
                    }
                    Err(_) => (0.0, 0.0),
                };
                let step = if alpha_raw >= MIN_SEND_UALPHA && !primary_addr.is_empty() {
                    format!(
                        "send {:.0} ualpha → primary: structs_players act {{player:{}, action:\"player_send\", args:{{to:\"{}\", amount:\"{:.0}\"}}}}",
                        alpha_raw, index, primary_addr, alpha_raw
                    )
                } else if ore > 0.0 {
                    format!(
                        "refine ore→alpha: structs_players act {{player:{}, action:\"refine\", args:{{struct_id:<refinery>}}}} (build a refinery first if it has none)",
                        index
                    )
                } else {
                    format!(
                        "mine: structs_players act {{player:{}, action:\"mine\", args:{{struct_id:<extractor>}}}}",
                        index
                    )
                };
                out.push_str(&format!(
                    "  [idx {}] {} {} — ore {:.0} · alpha {:.0} ualpha → {}\n",
                    index, pid, name, ore, alpha_raw, step
                ));
            }
            // Ownership-aware infuse guidance. Infusing a reactor grows the
            // INFUSER's personal capacity (96%) + the reactor's capacity (4%
            // commission) — it does NOT grow any substation. Whether that helps
            // the vplayers depends on who owns the entry substation they draw
            // from (resolved live — no hardcoded assumption; works for any guild).
            let gp = if guild_id.is_empty() {
                None
            } else {
                crate::mcp::guild_power::resolve_guild_power(client, &guild_id).await.ok()
            };
            const PRIMARY_INFUSE_MIN_UALPHA: f64 = 10_000_000.0;
            let infuse_lead = if primary_alpha >= PRIMARY_INFUSE_MIN_UALPHA {
                format!("\nPrimary alpha {:.0} → ready to infuse the guild reactor", primary_alpha)
            } else {
                format!("\nPrimary alpha {:.0} ualpha (infuse the reactor once it builds up)", primary_alpha)
            };
            out.push_str(&infuse_lead);
            match &gp {
                Some(gp) => {
                    // "Ours" = the primary + every registered vplayer player id.
                    let mut ours: std::collections::HashSet<String> = {
                        let reg = REGISTRY.read().unwrap();
                        reg.players.iter().filter_map(|p| p.player_id.clone()).collect()
                    };
                    if !primary_pid.is_empty() {
                        ours.insert(primary_pid.clone());
                    }
                    let we_own_sub = !gp.substation_owner.is_empty() && ours.contains(&gp.substation_owner);
                    out.push_str(&format!(
                        " — infusing grows the infuser's PERSONAL capacity (96%; 4% commission to the reactor). It does NOT auto-grow substation {} (owner {}), which is what powers the vplayers.\n",
                        gp.substation_id,
                        if gp.substation_owner.is_empty() { "?" } else { &gp.substation_owner }
                    ));
                    if we_own_sub {
                        out.push_str(&format!(
                            "✓ You own substation {} — to close the loop, after infusing, connect/grow an Allocation INTO it (MsgSubstationAllocationConnect / MsgAllocationUpdate). That raises connectionCapacity ({:.2} kW now) for ALL {} connected players.\n",
                            gp.substation_id, gp.sub_connection_capacity / 1e6, gp.sub_connection_count
                        ));
                    } else {
                        out.push_str(
                            "↳ You do NOT own that substation, so this flywheel makes the PRIMARY stronger (more personal capacity to build/power its own structs) — it can't grow the vplayers' shared pool. The vplayers already have ample headroom anyway.\n",
                        );
                    }
                }
                None => {
                    out.push_str(" (couldn't resolve guild power to assess substation ownership).\n");
                }
            }
            vec![Content::text(out)]
        }

        // Guided "owned hub" infrastructure planner — emits the exact, authorized
        // tx sequence to infuse → route capacity to a substation → feed the guild
        // pool (and the springboard to sell energy later). ADVISORY: it spends
        // real alpha and creates standing/outward infrastructure, so it only
        // PLANS — you execute the steps deliberately. See [[structs_power_model]].
        "infra" => {
            let mode = params
                .args
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("hub")
                .to_lowercase();
            let infuse_arg = params.args.get("infuse_ualpha").and_then(|v| v.as_f64());
            let keep_arg = params.args.get("keep_w").and_then(|v| v.as_f64());
            // Who owns the hub / runs the steps: default the primary; a vplayer
            // host means every step is runnable now via `act {tx}` (raw signing).
            let host = params.player.clone();

            let (primary_pid, primary_addr, guild_id) = {
                let gs = crate::game_state::GAME_STATE.read().unwrap();
                (
                    gs.player_id.clone().unwrap_or_default(),
                    gs.wallet_address.clone().unwrap_or_default(),
                    gs.guild_id.clone().unwrap_or_default(),
                )
            };
            if guild_id.is_empty() {
                return vec![Content::text("No guild id synced yet — open the app and log in.".to_string())];
            }
            let gp = match crate::mcp::guild_power::resolve_guild_power(client, &guild_id).await {
                Ok(g) => g,
                Err(e) => return vec![Content::text(format!("Couldn't resolve guild power: {}", e))],
            };

            // Resolve the HOST player's alpha + struct draw + address (defaults to primary).
            let (host_pid, host_addr, host_label) = match host.as_deref() {
                Some(key) => {
                    let reg = REGISTRY.read().unwrap();
                    match reg.find(key) {
                        Some(p) => (
                            p.player_id.clone().unwrap_or_default(),
                            p.address.clone(),
                            format!("vplayer {} ({})", p.name, p.player_id.clone().unwrap_or_default()),
                        ),
                        None => return vec![Content::text(format!("No virtual player matches '{}'.", key))],
                    }
                }
                None => (primary_pid.clone(), primary_addr.clone(), format!("primary {}", primary_pid)),
            };
            if host_pid.is_empty() {
                return vec![Content::text("Host player has no on-chain id yet.".to_string())];
            }

            let (alpha_ualpha, structs_load) = match client.query_entity("player", &host_pid).await {
                Ok(v) => {
                    let numf = |val: Option<&Value>| -> f64 {
                        match val {
                            Some(Value::String(s)) => s.parse().unwrap_or(0.0),
                            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                            _ => 0.0,
                        }
                    };
                    (
                        numf(v.get("playerInventory").and_then(|i| i.get("rocks")).and_then(|r| r.get("amount"))),
                        numf(v.get("gridAttributes").and_then(|g| g.get("structsLoad"))),
                    )
                }
                Err(e) => return vec![Content::text(format!("Couldn't read host {} state: {}", host_pid, e))],
            };

            let plan = crate::mcp::guild_power::plan_infra(
                alpha_ualpha,
                structs_load,
                gp.reactor_commission,
                gp.sub_connection_count,
                infuse_arg,
                keep_arg,
            );

            let is_vplayer_host = host.is_some();
            let m = |w: f64| format!("{:.2} kW", w / 1e6);
            let mut out = String::new();
            out.push_str(&format!(
                "⚙ INFRASTRUCTURE PLAN ({} mode) — host {}\n\
                 Host alpha {:.0} ualpha · struct draw {} · guild sub {} ({} conns, {} free/conn) · reactor {} (validator {}, {}% commission)\n\n\
                 Amounts: infuse {:.0} ualpha → +{} personal capacity ({} lost to commission).\n\
                 Keep {} for your own expansion · donate {} into the shared pool.\n\
                 ⚠ Dilution: donating into a {}-connection substation returns only {} to YOUR connection (you subsidize the others). Self-expansion comes free from the kept capacity; donating is guild-support/positioning.\n\n",
                mode, host_label,
                alpha_ualpha, m(structs_load), gp.substation_id, gp.sub_connection_count, m(gp.sub_connection_capacity),
                gp.reactor_id, if gp.reactor_validator.is_empty() { "?" } else { &gp.reactor_validator }, (gp.reactor_commission * 100.0) as i64,
                plan.infuse_ualpha, m(plan.gained_capacity_mw), m(plan.commission_mw),
                m(plan.keep_mw), m(plan.donate_mw),
                gp.sub_connection_count, m(plan.own_share_gain_mw),
            ));

            // Build the ordered tx sequence. For a vplayer host, emit ready-to-run
            // `act {tx}` calls (raw signing handles every msg today). For the
            // primary, emit the msgs + the honest execution route.
            let donate_s = format!("{:.0}", plan.donate_mw);
            let infuse_s = format!("{:.0}", plan.infuse_ualpha);
            let wrap = |type_url: &str, msg: String, route: &str| -> String {
                if is_vplayer_host {
                    format!(
                        "   structs_players act {{player:\"{}\", action:\"tx\", args:{{type_url:\"{}\", msg:{}}}}}\n",
                        host.as_deref().unwrap_or(""), type_url, msg
                    )
                } else {
                    format!("   {} {}   [{}]\n", type_url, msg, route)
                }
            };
            out.push_str("Sequence:\n");
            // 1) Infuse (delegate to the reactor's validator).
            out.push_str("1. Infuse alpha → personal capacity:\n");
            out.push_str(&wrap(
                "/structs.structs.MsgReactorInfuse",
                format!("{{\"delegatorAddress\":\"{}\",\"validatorAddress\":\"{}\",\"amount\":{{\"denom\":\"ualpha\",\"amount\":\"{}\"}}}}", host_addr, gp.reactor_validator, infuse_s),
                "primary: do in-app (reactor infuse/staking isn't on the primary tx bridge)",
            ));
            if mode == "direct" {
                // SINGLE-ALLOCATION POLICY: if the host already feeds the guild
                // substation with a dynamic allocation, GROW that one allocation
                // (MsgAllocationUpdate) rather than mint a new one each cycle —
                // simpler for us and lighter on-chain. The update capacity
                // double-count bug that once forced create-new is fixed, so
                // raising an existing allocation into freed/infused capacity works.
                // Only bootstrap a new allocation when none exists yet.
                match crate::mcp::guild_power::find_dynamic_allocation(client, &host_pid, &gp.substation_id).await {
                    Some((aid, cur_power)) => {
                        let new_power = cur_power.saturating_add(plan.donate_mw as u64);
                        out.push_str(&format!(
                            "2. GROW your existing allocation {} into the guild pool (single-allocation policy — {:.0} kW → {:.0} kW):\n",
                            aid, cur_power as f64 / 1e6, new_power as f64 / 1e6,
                        ));
                        out.push_str(&wrap(
                            "/structs.structs.MsgAllocationUpdate",
                            format!("{{\"allocationId\":\"{}\",\"power\":\"{}\"}}", aid, new_power),
                            "primary: sign via act {player:0, tx} (bypasses the tx bridge)",
                        ));
                    }
                    None => {
                        out.push_str("2. Allocate your capacity toward the guild pool (dynamic — FIRST/bootstrap allocation, keep just this one):\n");
                        out.push_str(&wrap(
                            "/structs.structs.MsgAllocationCreate",
                            format!("{{\"controller\":\"{}\",\"sourceObjectId\":\"{}\",\"allocationType\":\"dynamic\",\"power\":\"{}\"}}", host_pid, host_pid, donate_s),
                            "primary: sign via act {player:0, tx}",
                        ));
                        out.push_str("3. Connect that allocation to the guild substation (NO guild-owner permission needed):\n");
                        out.push_str(&wrap(
                            "/structs.structs.MsgSubstationAllocationConnect",
                            format!("{{\"allocationId\":\"<id from step 2>\",\"destinationId\":\"{}\"}}", gp.substation_id),
                            "primary: sign via act {player:0, tx}",
                        ));
                    }
                }
            } else {
                // HUB: build an owned substation S, then feed the guild from it.
                out.push_str("2. Allocate capacity from yourself (dynamic — NOT automated, which would route 100%):\n");
                out.push_str(&wrap(
                    "/structs.structs.MsgAllocationCreate",
                    format!("{{\"controller\":\"{}\",\"sourceObjectId\":\"{}\",\"allocationType\":\"dynamic\",\"power\":\"{}\",\"destinationId\":\"\"}}", host_pid, host_pid, donate_s),
                    "primary: allocation_create on bridge (needs tool arm) / in-app",
                ));
                out.push_str("3. Create YOUR substation S from that allocation (this is the hub you own → can host a Provider to SELL later):\n");
                out.push_str(&wrap(
                    "/structs.structs.MsgSubstationCreate",
                    "{\"allocationId\":\"<id from step 2>\"}".to_string(),
                    "primary: NOT on the tx bridge — do in-app",
                ));
                out.push_str("4. Allocate from S toward the guild pool (dynamic, adjustable / re-pointable):\n");
                out.push_str(&wrap(
                    "/structs.structs.MsgAllocationCreate",
                    format!("{{\"controller\":\"{}\",\"sourceObjectId\":\"<S id from step 3>\",\"allocationType\":\"dynamic\",\"power\":\"{}\",\"destinationId\":\"\"}}", host_pid, donate_s),
                    "primary: bridge / in-app",
                ));
                out.push_str("5. Connect S's allocation to the guild substation (NO guild-owner permission needed):\n");
                out.push_str(&wrap(
                    "/structs.structs.MsgSubstationAllocationConnect",
                    format!("{{\"allocationId\":\"<id from step 4>\",\"destinationId\":\"{}\"}}", gp.substation_id),
                    "primary: NOT on the tx bridge — do in-app",
                ));
                out.push_str("(later) Sell surplus: MsgProviderCreate {substationId:S, rate, accessPolicy, capacity/duration min/max} — a Provider attaches to a substation you own.\n");
            }
            out.push_str(&format!(
                "\nExecutable now? {}\nNothing here auto-signs — run the steps yourself. Verify after each: structs_players capacity (watch substation {} connectionCapacity rise).\n",
                if is_vplayer_host {
                    "YES — host is a vplayer, so each step runs via the raw `act {tx}` calls above (fund it first via structs_action transfer if it has no alpha)."
                } else {
                    "PARTIALLY — the primary tx bridge wires allocation_create + substation_player_connect, but reactor infuse / substation_create / substation_allocation_connect are not, so do those in-app. To test fully via MCP, re-run with player:<vplayer idx> as the host."
                },
                gp.substation_id,
            ));
            vec![Content::text(out)]
        }

        // Configure / inspect the native auto-harvest loop (mine + refine when a
        // struct's PoW difficulty decays to ≤ the threshold). Args: enabled,
        // difficulty, interval_secs, refine, include_primary, now (force a scan).
        "harvest" => {
            let mut cfg = crate::mcp::auto_harvest::get();
            let a = &params.args;
            let mut changed = false;
            if let Some(v) = a.get("enabled").and_then(|v| v.as_bool()) {
                cfg.enabled = v;
                changed = true;
            }
            if let Some(v) = a.get("difficulty").and_then(|v| v.as_u64()) {
                cfg.difficulty_threshold = v.clamp(1, 64);
                changed = true;
            }
            if let Some(v) = a.get("interval_secs").and_then(|v| v.as_u64()) {
                cfg.interval_secs = v.max(60);
                changed = true;
            }
            if let Some(v) = a.get("refine").and_then(|v| v.as_bool()) {
                cfg.refine = v;
                changed = true;
            }
            if let Some(v) = a.get("auto_explore").and_then(|v| v.as_bool()) {
                cfg.auto_explore = v;
                changed = true;
            }
            if let Some(v) = a.get("include_primary").and_then(|v| v.as_bool()) {
                cfg.include_primary = v;
                changed = true;
            }
            if changed {
                crate::mcp::auto_harvest::set(cfg.clone());
            }
            let force_now = a.get("now").and_then(|v| v.as_bool()).unwrap_or(false);
            if force_now && cfg.enabled {
                let app = app_handle.clone();
                tokio::spawn(async move {
                    crate::mcp::auto_harvest::tick(&app, true).await;
                });
            }
            vec![Content::text(format!(
                "Auto-harvest {} — mine/refine each owned struct once its difficulty decays to ≤ {} · scans every {}s · refine {} · auto_explore {} · include_primary {}.{}\n{}",
                if cfg.enabled { "ON" } else { "OFF" },
                cfg.difficulty_threshold,
                cfg.interval_secs,
                cfg.refine,
                cfg.auto_explore,
                cfg.include_primary,
                if changed { " (updated)" } else { "" },
                if force_now && cfg.enabled {
                    "Triggered an immediate scan — ripe extractors/refineries will start hashing now.".to_string()
                } else {
                    "Higher difficulty = more aggressive (harvest sooner, pricier proof); ~10 ≈ every ~6h, ~1 ≈ near-instant ~23h. Set {enabled:true} to run it, {now:true} to scan immediately.".to_string()
                }
            ))]
        }

        // Configure / inspect the native auto-FILL loop (auto-initiate builds in
        // free slots + auto-complete them as PoW ripens). Args: enabled,
        // complete_difficulty, interval_secs, include_primary, now (force a scan).
        "autobuild" => {
            let mut cfg = crate::mcp::auto_build::get();
            let a = &params.args;
            let mut changed = false;
            if let Some(v) = a.get("enabled").and_then(|v| v.as_bool()) {
                cfg.enabled = v;
                changed = true;
            }
            if let Some(v) = a.get("complete_difficulty").and_then(|v| v.as_u64()) {
                cfg.complete_difficulty = v.clamp(1, 64);
                changed = true;
            }
            if let Some(v) = a.get("interval_secs").and_then(|v| v.as_u64()) {
                cfg.interval_secs = v.max(60);
                changed = true;
            }
            if let Some(v) = a.get("include_primary").and_then(|v| v.as_bool()) {
                cfg.include_primary = v;
                changed = true;
            }
            if changed {
                crate::mcp::auto_build::set(cfg.clone());
            }
            let force_now = a.get("now").and_then(|v| v.as_bool()).unwrap_or(false);
            if force_now && cfg.enabled {
                let app = app_handle.clone();
                tokio::spawn(async move {
                    crate::mcp::auto_build::tick(&app, true).await;
                });
            }
            vec![Content::text(format!(
                "Auto-fill (build-out) {} — fills each vplayer's free slots one build/scan (charge + power gated: OSG/shields → fleet defenders → Ore Bunkers), and auto-completes builds at difficulty ≤ {} · scans every {}s · include_primary {}.{}\n{}",
                if cfg.enabled { "ON" } else { "OFF" },
                cfg.complete_difficulty,
                cfg.interval_secs,
                cfg.include_primary,
                if changed { " (updated)" } else { "" },
                if force_now && cfg.enabled {
                    "Triggered an immediate scan.".to_string()
                } else {
                    "Set {enabled:true} to run it, {now:true} to scan immediately. It idles once every slot is full.".to_string()
                }
            ))]
        }

        // Native auto-defense: assign each productive vplayer's idle combat structs
        // to defend its refinery (MsgStructDefenseSet), continuously as new structs
        // come online. One assignment per player per scan (1 charge). Off by default.
        "autodefend" => {
            let mut cfg = crate::mcp::auto_defend::get();
            let a = &params.args;
            let mut changed = false;
            if let Some(v) = a.get("enabled").and_then(|v| v.as_bool()) {
                cfg.enabled = v;
                changed = true;
            }
            if let Some(v) = a.get("interval_secs").and_then(|v| v.as_u64()) {
                cfg.interval_secs = v.max(60);
                changed = true;
            }
            if let Some(v) = a.get("include_bait").and_then(|v| v.as_bool()) {
                cfg.include_bait = v;
                changed = true;
            }
            if changed {
                crate::mcp::auto_defend::set(cfg.clone());
            }
            let force_now = a.get("now").and_then(|v| v.as_bool()).unwrap_or(false);
            if force_now && cfg.enabled {
                let app = app_handle.clone();
                tokio::spawn(async move {
                    crate::mcp::auto_defend::tick(&app, true).await;
                });
            }
            vec![Content::text(format!(
                "Auto-defense {} — assigns each productive vplayer's idle combat structs to defend its refinery (one defender/scan, charge-paced) · scans every {}s · include_bait {}.{}\n{}",
                if cfg.enabled { "ON" } else { "OFF" },
                cfg.interval_secs,
                cfg.include_bait,
                if changed { " (updated)" } else { "" },
                if force_now && cfg.enabled {
                    "Triggered an immediate scan.".to_string()
                } else {
                    "Set {enabled:true} to run it, {now:true} to scan immediately. It idles once all defenders are assigned.".to_string()
                }
            ))]
        }

        // ── Raid-response loop (defensive combat automation) ──
        // The whole raid window is ~4 minutes, so this loop reacts on the raid
        // alarm rather than on damage, and prefers the raider's Command Ship
        // (16/16 of all recorded `attackerDefeated` outcomes came from killing it).
        "autoresponse" | "response" => {
            use crate::mcp::auto_response as ar;
            let mut cfg = ar::get();
            let a = &params.args;
            let mut changed = false;
            if let Some(v) = a.get("enabled").and_then(|v| v.as_bool()) {
                cfg.enabled = v;
                changed = true;
            }
            if let Some(v) = a.get("autonomy").and_then(|v| v.as_str()) {
                cfg.autonomy = match v.to_ascii_lowercase().as_str() {
                    "auto" => ar::Autonomy::Auto,
                    _ => ar::Autonomy::Advise,
                };
                changed = true;
            }
            if let Some(v) = a.get("mode").and_then(|v| v.as_str()) {
                cfg.mode = match v.to_ascii_lowercase().as_str() {
                    "harden" => ar::ResponseMode::Harden,
                    "counter" => ar::ResponseMode::Counter,
                    "decapitate" => ar::ResponseMode::Decapitate,
                    other => {
                        return vec![Content::text(format!(
                            "mode '{other}' unknown — use harden | counter | decapitate."
                        ))]
                    }
                };
                changed = true;
            }
            // Keep the floor at 5 s: the loop is deliberately fast, but a
            // 0-second interval would spin the event drain on every sync tick.
            if let Some(v) = a.get("interval_secs").and_then(|v| v.as_u64()) {
                cfg.interval_secs = v.max(5);
                changed = true;
            }
            for (key, slot) in [
                ("max_shots_per_incident", &mut cfg.max_shots_per_incident),
                ("max_shots_per_hour", &mut cfg.max_shots_per_hour),
            ] {
                if let Some(v) = a.get(key).and_then(|v| v.as_u64()) {
                    *slot = v as usize;
                    changed = true;
                }
            }
            if let Some(v) = a.get("incident_cooldown_secs").and_then(|v| v.as_u64()) {
                cfg.incident_cooldown_secs = v;
                changed = true;
            }
            for (key, slot) in [
                ("prefer_counter_free_ambit", &mut cfg.prefer_counter_free_ambit),
                ("panic_refine", &mut cfg.panic_refine),
                ("include_primary_shooters", &mut cfg.include_primary_shooters),
                ("dry_run", &mut cfg.dry_run),
            ] {
                if let Some(v) = a.get(key).and_then(|v| v.as_bool()) {
                    *slot = v;
                    changed = true;
                }
            }
            if changed {
                ar::set(cfg.clone());
            }
            let force_now = a.get("now").and_then(|v| v.as_bool()).unwrap_or(false);
            if force_now && cfg.enabled {
                let app = app_handle.clone();
                tokio::spawn(async move { ar::tick(&app, true).await });
            }
            let (used, cap) = ar::shot_budget();
            vec![Content::text(format!(
                "Raid response {} ({:?}, mode {:?}) — scans every {}s · ≤{} shots/incident · budget {}/{} this hour · counter-free ambit {} · panic refine {}{}\n{}",
                if cfg.enabled { "ON" } else { "OFF" },
                cfg.autonomy,
                cfg.mode,
                cfg.interval_secs,
                cfg.max_shots_per_incident,
                used,
                cap,
                cfg.prefer_counter_free_ambit,
                cfg.panic_refine,
                if changed { " (updated)" } else { "" },
                if cfg.enabled {
                    "Watch the WAR page's INCIDENTS card. In `advise` it posts the plan; set autonomy:\"auto\" to have it fire."
                } else {
                    "Set {enabled:true} to arm it. It starts in `advise`, so it will show you the shot plan before it ever signs."
                }
            ))]
        }

        // ── Raid target-selection loop (offensive combat automation) ──
        "autoraid" | "raid_loop" => {
            use crate::mcp::auto_raid as arl;
            let mut cfg = arl::get();
            let a = &params.args;
            let mut changed = false;
            // Posture first: it rewrites the gates, so explicit gate args in the
            // same call must be applied after it and win.
            if let Some(v) = a.get("posture").and_then(|v| v.as_str()) {
                let p = match v.to_ascii_lowercase().as_str() {
                    "cautious" => arl::RaidPosture::Cautious,
                    "opportunist" => arl::RaidPosture::Opportunist,
                    "aggressive" => arl::RaidPosture::Aggressive,
                    other => {
                        return vec![Content::text(format!(
                            "posture '{other}' unknown — use cautious | opportunist | aggressive."
                        ))]
                    }
                };
                cfg.apply_posture(p);
                changed = true;
            }
            if let Some(v) = a.get("enabled").and_then(|v| v.as_bool()) {
                cfg.enabled = v;
                changed = true;
            }
            if let Some(v) = a.get("autonomy").and_then(|v| v.as_str()) {
                cfg.autonomy = match v.to_ascii_lowercase().as_str() {
                    "auto" => crate::mcp::auto_response::Autonomy::Auto,
                    _ => crate::mcp::auto_response::Autonomy::Advise,
                };
                changed = true;
            }
            for (key, slot) in [
                ("min_ore", &mut cfg.min_ore),
                ("min_score", &mut cfg.min_score),
                ("abort_cmd_hp_below", &mut cfg.abort_cmd_hp_below),
                ("w_ore", &mut cfg.w_ore),
                ("w_vulnerability", &mut cfg.w_vulnerability),
                ("w_weakness", &mut cfg.w_weakness),
                ("w_grudge", &mut cfg.w_grudge),
                ("w_guild", &mut cfg.w_guild),
                ("w_speed", &mut cfg.w_speed),
                ("w_history", &mut cfg.w_history),
            ] {
                if let Some(v) = a.get(key).and_then(|v| v.as_f64()) {
                    *slot = v;
                    changed = true;
                }
            }
            for (key, slot) in [
                ("max_raid_minutes", &mut cfg.max_raid_minutes),
                ("target_cooldown_mins", &mut cfg.target_cooldown_mins),
                ("skip_if_defender_active_mins", &mut cfg.skip_if_defender_active_mins),
                ("max_raid_wall_minutes", &mut cfg.max_raid_wall_minutes),
            ] {
                if let Some(v) = a.get(key).and_then(|v| v.as_u64()) {
                    *slot = v as u32;
                    changed = true;
                }
            }
            for (key, slot) in [
                ("max_defenders", &mut cfg.max_defenders),
                ("max_concurrent_raids", &mut cfg.max_concurrent_raids),
                ("siege_max_shots", &mut cfg.siege_max_shots),
                ("evaluate_per_scan", &mut cfg.evaluate_per_scan),
                ("sweep_max_pages", &mut cfg.sweep_max_pages),
            ] {
                if let Some(v) = a.get(key).and_then(|v| v.as_u64()) {
                    *slot = v as usize;
                    changed = true;
                }
            }
            for (key, slot) in [
                ("require_vulnerable_now", &mut cfg.require_vulnerable_now),
                ("allow_siege", &mut cfg.allow_siege),
                ("return_home_after", &mut cfg.return_home_after),
                ("dry_run", &mut cfg.dry_run),
            ] {
                if let Some(v) = a.get(key).and_then(|v| v.as_bool()) {
                    *slot = v;
                    changed = true;
                }
            }
            if let Some(v) = a.get("interval_secs").and_then(|v| v.as_u64()) {
                cfg.interval_secs = v.max(60);
                changed = true;
            }
            if let Some(arr) = a.get("raid_hours_utc").and_then(|v| v.as_array()) {
                cfg.raid_hours_utc = arr.iter().filter_map(|v| v.as_u64()).map(|v| (v % 24) as u32).collect();
                changed = true;
            }
            if let Some(arr) = a.get("raider_players").and_then(|v| v.as_array()) {
                cfg.raider_players = arr.iter().filter_map(|v| v.as_str().map(String::from)).collect();
                changed = true;
            }
            if changed {
                arl::set(cfg.clone());
            }
            let force_now = a.get("now").and_then(|v| v.as_bool()).unwrap_or(false);
            if force_now && cfg.enabled {
                let app = app_handle.clone();
                tokio::spawn(async move { arl::tick(&app, true).await });
            }
            let board = arl::target_board();
            let mut out = format!(
                "Raid targeting {} ({:?}, posture {:?}) — min_ore {:.0} · min_score {:.0} · ≤{} min proof · ≤{} defenders · vulnerable-only {} · siege {} · ≤{} concurrent{}\n",
                if cfg.enabled { "ON" } else { "OFF" },
                cfg.autonomy,
                cfg.posture,
                cfg.min_ore,
                cfg.min_score,
                cfg.max_raid_minutes,
                cfg.max_defenders,
                cfg.require_vulnerable_now,
                cfg.allow_siege,
                cfg.max_concurrent_raids,
                if changed { " (updated)" } else { "" }
            );
            if board.is_empty() {
                out.push_str("No target board yet — run with {now:true} once enabled to score candidates.\n");
            } else {
                out.push_str("Top targets:\n");
                for c in board.iter().take(8) {
                    out.push_str(&format!(
                        "  {} {} ({}) — {:.0} ore · shield {} (~{:.0} min) · {} defenders · score {:.0} — {}\n",
                        if c.blocked_by.is_none() { "GO  " } else { "no-go" },
                        c.name,
                        c.planet_id,
                        c.stored_ore,
                        c.planetary_shield,
                        c.raid_minutes,
                        c.defenders_on_cmd,
                        c.score,
                        c.blocked_by.clone().unwrap_or_else(|| c.vulnerability_reason.clone())
                    ));
                }
            }
            let active = arl::active_expeditions();
            if !active.is_empty() {
                out.push_str(&format!("{} expedition(s) in flight.\n", active.len()));
            }
            out.push_str("Raids are flown by VPlayerRole::Raider accounts only — the primary never leaves home.\n");
            vec![Content::text(out)]
        }

        // Configurable "keep N grams, infuse the rest" rule for the PRIMARY.
        // Grows the primary's own capacity via MsgReactorInfuse signed at HD
        // index 0 (the primary's key). Args: keep_grams, enabled (auto-run), now.
        "infuse" => {
            let mut cfg = crate::mcp::auto_infuse::get();
            let a = &params.args;
            let mut changed = false;
            if let Some(v) = a.get("keep_grams").and_then(|v| v.as_u64()) {
                cfg.keep_grams = v;
                changed = true;
            }
            if let Some(v) = a.get("enabled").and_then(|v| v.as_bool()) {
                cfg.enabled = v;
                changed = true;
            }
            if let Some(v) = a.get("interval_secs").and_then(|v| v.as_u64()) {
                cfg.interval_secs = v.max(60);
                changed = true;
            }
            if changed {
                crate::mcp::auto_infuse::set(cfg.clone());
            }
            let run_now = a.get("now").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut out = format!(
                "Primary infuse rule {} — keep {} g in reserve, infuse the rest · auto every {}s.{}\n",
                if cfg.enabled { "ON (auto)" } else { "OFF (manual)" },
                cfg.keep_grams,
                cfg.interval_secs,
                if changed { " (updated)" } else { "" }
            );
            if run_now {
                match crate::mcp::auto_infuse::infuse_primary_excess(app_handle, cfg.keep_grams).await {
                    Ok(r) => out.push_str(&format!(
                        "Infused {} ualpha (~{:.2} g → ~{:.2} kW personal capacity), kept {} g. tx {}\nVerify: structs_players capacity (primary capacity should rise).",
                        r.infused_ualpha,
                        r.infused_ualpha as f64 / crate::mcp::auto_infuse::UALPHA_PER_GRAM as f64,
                        (r.infused_ualpha as f64 * 0.96) / 1e6,
                        cfg.keep_grams,
                        r.tx
                    )),
                    Err(e) => out.push_str(&format!("Did not infuse: {}", e)),
                }
            } else {
                out.push_str("Pass {now:true} to infuse the excess immediately, or {enabled:true} to auto-run.");
            }
            vec![Content::text(out)]
        }

        "create" => {
            let Some(name) = params.name.as_deref().filter(|n| !n.is_empty()) else {
                return vec![Content::text(
                    "Error: name required (3–20 chars: letters/digits/-/_).".to_string(),
                )];
            };

            // Pick the index + enforce the hard count cap (0 = unlimited), under a
            // short read lock. The guild-power soft gate below is the real limit.
            let index = {
                let reg = REGISTRY.read().unwrap();
                if !crate::mcp::virtual_players::under_cap(reg.players.len()) {
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

            // Soft power gate: the entry substation pool is shared, and every new
            // connection dilutes each player's share (connectionCapacity ==
            // capacity / connectionCount). Block if we can't sustain another at
            // the minimum draw — separate from the hard MAX cap above.
            let guild_id_opt = { crate::game_state::GAME_STATE.read().unwrap().guild_id.clone() };
            if let Some(gid) = guild_id_opt.as_deref().filter(|s| !s.is_empty()) {
                if let Ok(gp) = crate::mcp::guild_power::resolve_guild_power(client, gid).await {
                    if gp.sub_capacity > 0.0
                        && gp.share_if_one_more < crate::mcp::guild_power::MIN_PLAYER_DRAW_MW
                    {
                        return vec![Content::text(format!(
                            "BLOCKED: guild substation {} can't power another player. \
                             capacity {:.1} kW / {} connections → {:.2} kW each if one more joins, \
                             below the ~{:.1} kW minimum draw. Free capacity or grow the reactor first.",
                            gp.substation_id,
                            gp.sub_capacity / 1e6,
                            gp.sub_connection_count,
                            gp.share_if_one_more / 1e6,
                            crate::mcp::guild_power::MIN_PLAYER_DRAW_MW / 1e6,
                        ))];
                    }
                }
            }

            // Façade does the whole flow: derive index N → sign guild-join →
            // POST /auth/signup → poll the address for its player id. ~180s budget.
            let result = vplayer_bridge::call(
                app_handle,
                "signup",
                json!({ "index": index, "name": name, "guild_id": params.guild_id }),
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
                            role: params
                                .role
                                .as_deref()
                                .and_then(VPlayerRole::parse)
                                .unwrap_or_default(),
                        });
                        let _ = reg.save();
                    }
                    // Give the new player its role-themed portrait so it lands
                    // in the roster already looking like its squad. Best-effort:
                    // needs the on-chain id (skip if signup is still pending —
                    // the backfill sweeps it up later), and a failure here must
                    // not fail the create.
                    if let Some(pid) = player_id.as_deref() {
                        let role = params
                            .role
                            .as_deref()
                            .and_then(VPlayerRole::parse)
                            .unwrap_or_default();
                        let attrs = crate::mcp::pfp::role_pfp_attrs(role.as_str(), index);
                        let _ = vplayer_bridge::sign_action(
                            app_handle,
                            index,
                            "/structs.structs.MsgPlayerUpdatePfpClientRenderAttributes",
                            json!({ "playerId": pid, "pfpClientRenderAttributes": attrs }),
                            60,
                        )
                        .await;
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
                // Whole-segment match: `contains` put 1-750's activity in 1-75's
                // listing. The address is full-length bech32, so it cannot collide.
                .filter(|e| {
                    crate::mcp::tools::events::subject_names(&e.subject, &player_id)
                        || e.detail.to_string().contains(&address)
                })
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
            // `player:"primary"` (or "0") targets the PRIMARY player at HD index 0 —
            // signed via the same façade path auto_infuse uses. This is the opt-in
            // hook for MCP-managed infrastructure: primary-only txs like
            // MsgAllocationCreate / MsgSubstationAllocationConnect (allocate the
            // primary's infused capacity into the guild substation). Manual only —
            // nothing auto-signs primary txs, so it's off unless deliberately invoked.
            let (index, player_id) = if matches!(key, "primary" | "0") {
                let pid = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone());
                (0u32, pid)
            } else {
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
                let s = |k: &str| params.args.get(k).and_then(|v| v.as_str()).map(|x| x.to_string());
                let dt = |k: &str, d: u64| params.args.get(k).and_then(|v| v.as_u64()).unwrap_or(d);
                // mine/refine proofs anchor on the struct's blockStart*, set when the
                // miner/refinery went online and reset after each successful cycle —
                // NOT the current block (docs hashing.md: input {structId} kWINE{blockStart}NONCE).
                // Read it from the chain like complete_build reads blockStartBuild;
                // using current_block_height yields a proof the chain rejects (→ 0 ore).
                let read_anchor_in = |entity: &Value, container: &str, field: &str| -> u64 {
                    entity
                        .get(container)
                        .and_then(|x| x.get(field))
                        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0)
                };
                let read_anchor = |entity: &Value, field: &str| read_anchor_in(entity, "structAttributes", field);
                let read_anchor_planet = |entity: &Value, field: &str| read_anchor_in(entity, "planetAttributes", field);
                let (object_id, task_type, task_params) = match action {
                    "mine" => {
                        let Some(sid) = s("struct_id") else {
                            return vec![Content::text("mine: struct_id (the player's Ore Extractor) required.".to_string())];
                        };
                        let entity = match client.query_entity("struct", &sid).await {
                            Ok(v) => v,
                            Err(e) => return vec![Content::text(format!("mine: struct {} lookup failed: {}", sid, e))],
                        };
                        let block = read_anchor(&entity, "blockStartOreMine");
                        if block == 0 {
                            return vec![Content::text(format!("mine: {} has blockStartOreMine=0 — the extractor isn't mining (bring it online/activate first; mining starts on going online).", sid))];
                        }
                        (sid.clone(), "MINE", TaskParams::for_ore(&sid, "MINE", block, dt("difficulty_target", 14000)))
                    }
                    "refine" => {
                        let Some(sid) = s("struct_id") else {
                            return vec![Content::text("refine: struct_id (the player's Ore Refinery) required.".to_string())];
                        };
                        let entity = match client.query_entity("struct", &sid).await {
                            Ok(v) => v,
                            Err(e) => return vec![Content::text(format!("refine: struct {} lookup failed: {}", sid, e))],
                        };
                        let block = read_anchor(&entity, "blockStartOreRefine");
                        if block == 0 {
                            return vec![Content::text(format!("refine: {} has blockStartOreRefine=0 — the refinery isn't refining (needs stored ore + online).", sid))];
                        }
                        (sid.clone(), "REFINE", TaskParams::for_ore(&sid, "REFINE", block, dt("difficulty_target", 28000)))
                    }
                    "raid" => {
                        let (Some(fleet), Some(target)) = (s("fleet_id"), s("target_id")) else {
                            return vec![Content::text("raid: fleet_id (this player's fleet) and target_id (planet) required.".to_string())];
                        };
                        // Raid proof anchors on the TARGET planet's blockStartRaid (the
                        // defender's vulnerability clock), not the current block.
                        let entity = match client.query_entity("planet", &target).await {
                            Ok(v) => v,
                            Err(e) => return vec![Content::text(format!("raid: planet {} lookup failed: {}", target, e))],
                        };
                        let block = read_anchor_planet(&entity, "blockStartRaid");
                        if block == 0 {
                            return vec![Content::text(format!("raid: planet {} isn't raidable (blockStartRaid=0) — the defender's CMD ship must be down/absent first.", target))];
                        }
                        (fleet.clone(), "RAID", TaskParams::for_raid(&fleet, &target, block, dt("difficulty_target", 700)))
                    }
                    _ => unreachable!(),
                };
                match hasher::start_hash_task_core(task_params, app_handle.clone(), registry) {
                    Ok(()) => {
                        hasher::register_vplayer_hash(object_id.clone(), index, task_type.to_string());
                        return vec![Content::text(format!(
                            "[vplayer {}] {} hashing started on {} (proof anchored at the struct's blockStart*). The completion tx will be auto-signed as this player when the proof is found. Track with structs_hash list.",
                            index, action, object_id
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

            // Sign+broadcast as the virtual player via the façade (its key, never
            // Rust's) — single ledgered attempt, NO auto-retry: this is the
            // interactive path, so the agent re-assesses and decides whether a
            // fresh transaction even makes sense (a blind resubmit could
            // double-execute if the first landed slowly).
            match crate::mcp::tx_retry::sign_once(
                app_handle,
                index,
                &type_url,
                payload,
                &format!("players_act:{player_id}"),
            )
            .await
            {
                Ok(res) => {
                    let hash = res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("");
                    vec![Content::text(format!(
                        "[vplayer {}] {} submitted — tx {}\nRead the outcome via structs_intel battle_log / structs_events.",
                        index, action, if hash.is_empty() { "(pending)" } else { hash }
                    ))]
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
        // Send alpha to another player (the flywheel's funnel-to-primary step).
        // fromAddress is this virtual player's own address, resolved from the
        // registry by its player id; amount is ualpha (e.g. "1000000").
        "player_send" => {
            let from = REGISTRY
                .read()
                .unwrap()
                .players
                .iter()
                .find(|p| p.player_id.as_deref() == Some(player_id))
                .map(|p| p.address.clone())
                .ok_or("player_send: couldn't resolve this player's address")?;
            let to = s("to").ok_or("player_send: 'to' (recipient address) required")?;
            let amount = s("amount").ok_or("player_send: 'amount' in ualpha (e.g. \"1000000\") required")?;
            Ok((
                "/structs.structs.MsgPlayerSend".into(),
                json!({
                    "fromAddress": from,
                    "toAddress": to,
                    "amount": [{ "denom": "ualpha", "amount": amount }],
                }),
            ))
        }
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
            "action '{}' not supported as a named action. Direct: explore, build, activate, deactivate, deploy, defend, attack, fleet_move, planet_update_name, build_cancel, defense_clear, stealth_activate, stealth_deactivate, storage_stash, storage_recall, generator_infuse, player_send, player_resume, player_update_name. PoW: mine, refine, raid, complete_build. For ANY other message use action \"tx\" {{type_url, msg}}.",
            other
        )),
    }
}
