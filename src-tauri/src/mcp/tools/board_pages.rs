//! Tauri commands backing the Team Ops Command Center pages (FLEET / ENERGY /
//! WORK / CONFIG). All read commands return JSON the page renders client-side;
//! the write command (`mcp_config_set`) and every mass action are gated to the
//! board window (`require_board`) and audit into the event feed.
//!
//! The agent-facing `structs_board` MCP tool and `render_board` (OPS page) are
//! deliberately untouched — human and agent read the same underlying state
//! through different doors, and WRITE through the same underlying setters.

use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

use crate::hasher::types::TaskRegistry;
use crate::mcp::telemetry;
use crate::mcp::{auto_build, auto_defend, auto_harvest, auto_infuse, board_feed, roster_cache};

/// Guard: only the Team Ops window may invoke mutating dashboard commands.
/// Tauri commands are callable from EVERY webview (including the main game
/// window and anything it loads); nothing else in the app enforces caller
/// identity, so this is the fence around the signing/config surface.
pub(crate) fn require_board(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "board" {
        Ok(())
    } else {
        Err(format!(
            "command restricted to the Team Ops window (called from '{}')",
            window.label()
        ))
    }
}

// ── FLEET ────────────────────────────────────────────────────────────────────

/// Roster snapshot — returns the cache immediately (never blocks on a sweep).
/// Pass `refresh_if_older_ms` to opportunistically kick a background sweep.
#[tauri::command]
pub async fn mcp_roster(app: tauri::AppHandle, refresh_if_older_ms: Option<f64>) -> Value {
    if let Some(max_age) = refresh_if_older_ms {
        roster_cache::trigger_sweep(app, max_age);
    }
    roster_cache::snapshot_json()
}

/// Manual roster refresh (Fleet page button). Returns whether a sweep started.
#[tauri::command]
pub fn mcp_roster_refresh(app: tauri::AppHandle) -> bool {
    roster_cache::trigger_sweep(app, 0.0)
}

/// Per-player drill-down: fresh player entity + accurate owned-struct ids
/// (the 3-read gather that's too expensive for the 183-row sweep).
#[tauri::command]
pub async fn mcp_player_detail(player: String) -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    // Resolve loosely: index, address, or player id (same as structs_players).
    let (pid, index, name, role) = {
        let reg = crate::mcp::virtual_players::REGISTRY
            .read()
            .unwrap_or_else(|e| e.into_inner());
        match reg.find(&player) {
            Some(p) => (
                p.player_id.clone().ok_or("player has no on-chain id yet")?,
                Some(p.index),
                p.name.clone(),
                format!("{:?}", p.role).to_lowercase(),
            ),
            None => (player.clone(), None, "primary".to_string(), "primary".to_string()),
        }
    };
    let entity = client.query_entity("player", &pid).await?;
    let struct_ids = crate::mcp::loop_util::player_struct_ids(&client, &pid).await;
    Ok(json!({
        "player_id": pid,
        "index": index,
        "name": name,
        "role": role,
        "entity": entity,
        "struct_ids": struct_ids,
        "struct_count": struct_ids.len(),
    }))
}

// ── ENERGY ───────────────────────────────────────────────────────────────────

/// Guild power (3 live LCD reads) + per-player supply/demand margins computed
/// from the roster cache (free). Margin: supply = personal capacity + the
/// substation per-connection share; demand = load + structsLoad.
#[tauri::command]
pub async fn mcp_energy() -> Result<Value, String> {
    let guild_id = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.guild_id.clone())
        .unwrap_or(None)
        .filter(|s| !s.is_empty())
        .ok_or("no guild synced yet")?;
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let gp = crate::mcp::guild_power::resolve_guild_power(&client, &guild_id).await?;

    let conn_cap = gp.sub_connection_capacity;
    let mut players: Vec<Value> = roster_cache::all_rows()
        .into_iter()
        .map(|r| {
            let supply = r.capacity + conn_cap;
            let demand = r.load + r.structs_load;
            let margin_pct = if supply > 0.0 { (1.0 - demand / supply) * 100.0 } else { 0.0 };
            json!({
                "player_id": r.player_id,
                "name": r.name,
                "role": r.role,
                "load_mw": demand,
                "capacity_mw": supply,
                "margin_pct": margin_pct,
                "ok": supply > 0.0 && margin_pct >= 15.0,
                "err": r.err,
            })
        })
        .collect();
    // Worst margins first — the page is a triage list.
    players.sort_by(|a, b| {
        let ma = a.get("margin_pct").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mb = b.get("margin_pct").and_then(|v| v.as_f64()).unwrap_or(0.0);
        ma.total_cmp(&mb)
    });

    Ok(json!({
        "guild": {
            "guild_id": gp.guild_id,
            "reactor_id": gp.reactor_id,
            "reactor_owner": gp.reactor_owner,
            "reactor_fuel_mw": gp.reactor_fuel,
            "reactor_capacity_mw": gp.reactor_capacity,
            "reactor_commission": gp.reactor_commission,
            "substation_id": gp.substation_id,
            "substation_owner": gp.substation_owner,
            "sub_capacity_mw": gp.sub_capacity,
            "sub_load_mw": gp.sub_load,
            "sub_connection_capacity_mw": gp.sub_connection_capacity,
            "sub_connection_count": gp.sub_connection_count,
            "share_if_one_more_mw": gp.share_if_one_more,
            "supportable_more": gp.supportable_more,
        },
        "players": players,
        "min_draw_mw": crate::mcp::guild_power::MIN_PLAYER_DRAW_MW,
        "roster_refreshed_at_ms": roster_cache::refreshed_at_ms(),
    }))
}

// ── WORK ─────────────────────────────────────────────────────────────────────

/// PoW queue detail + loop health + tx ledger summary + hash config — the
/// "what is the machine doing" page. Registry reads are in-memory; telemetry
/// reads run on the blocking pool (SQLite).
#[tauri::command]
pub async fn mcp_work(registry: tauri::State<'_, Arc<TaskRegistry>>) -> Result<Value, String> {
    mcp_work_impl(registry.inner()).await
}

/// Body of `mcp_work`, callable without Tauri state (web dashboard path).
pub async fn mcp_work_impl(registry: &Arc<TaskRegistry>) -> Result<Value, String> {
    let mut tasks: Vec<Value> = Vec::new();
    let mut running = 0usize;
    let mut waiting = 0usize;
    let mut completed = 0usize;
    for entry in registry.tasks.iter() {
        let snap = entry.value().snapshot();
        match snap.status.as_str() {
            "running" => running += 1,
            "waiting" | "starting" => waiting += 1,
            "completed" => completed += 1,
            _ => {}
        }
        tasks.push(crate::mcp::tools::hasher::task_summary(&snap));
    }
    // Running first, then waiting, then done; each group by ETA-ish order.
    let rank = |t: &Value| match t.get("status").and_then(|s| s.as_str()).unwrap_or("") {
        "running" => 0,
        "starting" | "waiting" => 1,
        "completed" => 2,
        _ => 3,
    };
    tasks.sort_by_key(rank);

    const HOUR_MS: f64 = 3_600_000.0;
    let (loop_health, tx_summary, pow_stats) = tokio::task::spawn_blocking(|| {
        (
            telemetry::loop_health(HOUR_MS),
            telemetry::tx_summary(HOUR_MS),
            telemetry::pow_stats(24.0 * HOUR_MS),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "tasks": tasks,
        "counts": { "running": running, "waiting": waiting, "completed": completed },
        "loop_health": loop_health.unwrap_or_default(),
        "tx_summary": tx_summary.unwrap_or_else(|e| json!({ "error": e })),
        "pow_stats": pow_stats.unwrap_or_else(|e| json!({ "error": e })),
        "hash_config": crate::mcp::tools::hasher::hash_config_json(),
        "loops": loops_json(),
    }))
}

fn loops_json() -> Value {
    json!({
        "harvest": auto_harvest::get(),
        "build": auto_build::get(),
        "defend": auto_defend::get(),
        "infuse": auto_infuse::get(),
        "response": crate::mcp::auto_response::get(),
        "raid": crate::mcp::auto_raid::get(),
    })
}

// ── INVENTORY ────────────────────────────────────────────────────────────────
// Balances, the ledger, and (for ualpha only) transfers.
//
// TWO HARD RULES, both of which the chain enforces and this code must not
// invite a player to discover the expensive way:
//
//   1. ORE IS NOT A BANK ASSET. It lives in `gridAttributes.ore`, never in
//      `playerInventory.rocks`, and `MsgPlayerSend` is a bank send — it
//      structurally cannot carry ore. Ore moves by being REFINED into ualpha,
//      or by being seized/forfeited in battle. So ore is read-only here and
//      gets no transfer control at all: not a disabled one, absent.
//   2. Anything whose transferability we have not verified is read-only too.
//      `SENDABLE_DENOMS` is an allow-list, never a free-text denom field.

/// Denoms we know a player can send with `MsgPlayerSend` / `bank_send`.
/// `uguild.*` is deliberately absent: it is observed only in provider/guild
/// flows, so it stays read-only until proven otherwise.
pub const SENDABLE_DENOMS: &[&str] = &["ualpha"];

pub fn is_sendable(denom: &str) -> bool {
    SENDABLE_DENOMS.contains(&denom)
}

/// Resolve a player reference (index, address, player id, or "primary") to
/// `(player_id, index, name, address)`.
fn resolve_player(player: &str) -> Result<(String, Option<u32>, String, String), String> {
    let reg = crate::mcp::virtual_players::REGISTRY
        .read()
        .unwrap_or_else(|e| e.into_inner());
    if !player.is_empty() && player != "primary" {
        if let Some(p) = reg.find(player) {
            return Ok((
                p.player_id.clone().unwrap_or_default(),
                Some(p.index),
                p.name.clone(),
                p.address.clone(),
            ));
        }
    }
    let (pid, addr) = crate::game_state::GAME_STATE
        .read()
        .map(|g| (g.player_id.clone().unwrap_or_default(), g.wallet_address.clone().unwrap_or_default()))
        .unwrap_or_default();
    if addr.is_empty() {
        return Err("no wallet address known yet — is the game window signed in?".into());
    }
    Ok((pid, None, "primary".to_string(), addr))
}

/// Balances for one player (default: the primary), plus the denom registry the
/// UI needs to name them, plus the team-wide totals the roster cache already
/// holds for free.
#[tauri::command]
pub async fn mcp_inventory(player: Option<String>) -> Result<Value, String> {
    let who = player.unwrap_or_else(|| "primary".into());
    let (player_id, index, name, address) = resolve_player(&who)?;

    let client = crate::mcp::cosmos_client::CosmosClient::new();
    // Bank coins: ualpha AND every uguild.<id> the address holds. A single-key
    // `playerInventory.rocks` read could never have shown the latter.
    let (balances, bank_err) = match client.bank_balances(&address).await {
        Ok(b) => (b, None),
        Err(e) => (vec![], Some(e)),
    };

    // Ore is NOT in the bank — it is a planet grid attribute — so it is fetched
    // separately and marked read-only.
    let ore = if player_id.is_empty() {
        None
    } else {
        client
            .query_entity("player", &player_id)
            .await
            .ok()
            .and_then(|p| {
                p.get("gridAttributes")
                    .and_then(|g| g.get("ore"))
                    .and_then(|o| match o {
                        Value::String(s) => s.parse::<f64>().ok(),
                        other => other.as_f64(),
                    })
            })
    };

    let registry = crate::guild_config::denom_registry();
    let mut assets: Vec<Value> = balances
        .iter()
        .map(|c| {
            let denom = c.get("denom").and_then(|d| d.as_str()).unwrap_or("").to_string();
            let amount = c
                .get("amount")
                .and_then(|a| a.as_str())
                .and_then(|a| a.parse::<f64>().ok())
                .unwrap_or(0.0);
            let info = registry.get(&denom);
            json!({
                "denom": denom,
                "amount": amount,
                "sendable": is_sendable(&denom),
                "base_name": info.map(|i| i.base_name.clone()),
                "display_name": info.map(|i| i.display_name.clone()),
                "exponent": info.map(|i| i.exponent).unwrap_or(0),
                "guild_id": info.map(|i| i.guild_id.clone()),
                "guild_tag": info.map(|i| i.guild_tag.clone()),
            })
        })
        .collect();
    if let Some(o) = ore {
        assets.push(json!({
            "denom": "ore",
            "amount": o,
            "sendable": false,
            "display_name": "Ore",
            "base_name": "g",
            "exponent": 0,
            // Said in the payload, not just in a tooltip, so every surface
            // that renders this row gets the same explanation.
            "note": "not transferable — ore only moves by refining it into Alpha, or by being seized in battle",
        }));
    }

    // Team totals: free, already swept, and the reason to have a per-player
    // filter at all.
    let rows = roster_cache::all_rows();
    let team_alpha: f64 = rows.iter().map(|r| r.alpha_ualpha).sum();
    let team_ore: f64 = rows.iter().map(|r| r.ore).sum();

    Ok(json!({
        "player": { "player_id": player_id, "index": index, "name": name, "address": address },
        "assets": assets,
        "bank_error": bank_err,
        "team": { "players": rows.len(), "alpha_ualpha": team_alpha, "ore": team_ore },
        "sendable_denoms": SENDABLE_DENOMS,
        "denoms": registry,
        "roster_refreshed_at_ms": roster_cache::refreshed_at_ms(),
    }))
}

/// A page of the durable Guild-API ledger for one player. This reaches back
/// further than the app has been running — the GRASS inventory stream is the
/// live tail on top of it, not the system of record.
#[tauri::command]
pub async fn mcp_inventory_history(player: Option<String>, page: Option<u32>) -> Result<Value, String> {
    let who = player.unwrap_or_else(|| "primary".into());
    let (player_id, _index, name, address) = resolve_player(&who)?;
    let page = page.unwrap_or(1).max(1);
    let client = crate::mcp::cosmos_client::CosmosClient::new();

    // Prefer the player-keyed endpoint; fall back to the address one for a
    // player that has no on-chain id yet.
    let res = if player_id.is_empty() {
        client.guild.ledger_by_address(&address, page).await
    } else {
        client.guild.ledger_by_player(&player_id, page).await
    };
    let page_data = res.map_err(|e| format!("ledger unavailable: {e}"))?;

    Ok(json!({
        "player": { "player_id": player_id, "name": name, "address": address },
        "rows": page_data.items,
        "page": page_data.page,
        "has_more": page_data.has_more,
        "addresses": crate::mcp::enrich::addresses_map(),
        "denoms": crate::guild_config::denom_registry(),
    }))
}

/// Dry-run a transfer. ALWAYS called before a send: it names the sender,
/// resolves the destination against the roster, and says plainly when the
/// destination is an address we do not know.
#[tauri::command]
pub async fn mcp_transfer_preview(
    from: Option<String>,
    to: String,
    denom: String,
    amount: f64,
) -> Result<Value, String> {
    let who = from.unwrap_or_else(|| "primary".into());
    let (player_id, index, name, address) = resolve_player(&who)?;

    let mut problems: Vec<String> = Vec::new();
    if !is_sendable(&denom) {
        problems.push(format!(
            "{denom} cannot be sent from here — only {} may be transferred",
            SENDABLE_DENOMS.join(", ")
        ));
    }
    // bech32 for this chain: `structs1` + data. Cheap shape check, not a
    // checksum — the chain rejects a bad one, but a typo caught here costs
    // nothing.
    let to = to.trim().to_string();
    if !to.starts_with("structs1") || to.len() < 39 {
        problems.push("destination is not a well-formed structs1… address".into());
    }
    if to == address {
        problems.push("destination is the sender's own address".into());
    }
    if !(amount > 0.0) {
        problems.push("amount must be greater than zero".into());
    }

    // Who is on the other end?
    let known = crate::mcp::enrich::addresses_map();
    let recipient = known.get(&to).cloned();

    // Can they afford it?
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let balance = client
        .bank_balances(&address)
        .await
        .ok()
        .and_then(|bs| {
            bs.iter()
                .find(|c| c.get("denom").and_then(|d| d.as_str()) == Some(denom.as_str()))
                .and_then(|c| c.get("amount").and_then(|a| a.as_str()))
                .and_then(|a| a.parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    if amount > balance {
        problems.push(format!("balance is {balance} {denom}, short by {}", amount - balance));
    }

    let registry = crate::guild_config::denom_registry();
    let info = registry.get(&denom);
    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "from": { "player_id": player_id, "index": index, "name": name, "address": address },
        "to": to,
        // null here is the point: an unrecognised destination must be shown as
        // an external address, not silently rendered as if it were a teammate.
        "recipient": recipient,
        "denom": denom,
        "amount": amount,
        "balance": balance,
        "denom_info": info,
        "route": if index.is_some() { "vplayer bridge" } else { "primary signing queue" },
    }))
}

/// Execute a transfer. Board-only, and it re-runs the preview server-side so a
/// stale or hand-crafted client payload cannot skip the gates.
#[tauri::command]
pub async fn mcp_transfer_execute(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    from: Option<String>,
    to: String,
    denom: String,
    amount: f64,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_transfer_execute_impl(app, from, to, denom, amount).await
}

/// Body of `mcp_transfer_execute`, callable without a window (web dashboard;
/// the bearer token there IS the operator authority).
pub async fn mcp_transfer_execute_impl(
    app: tauri::AppHandle,
    from: Option<String>,
    to: String,
    denom: String,
    amount: f64,
) -> Result<Value, String> {
    let preview = mcp_transfer_preview(from.clone(), to.clone(), denom.clone(), amount).await?;
    if preview.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let why = preview
            .get("problems")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default();
        return Err(format!("refused: {why}"));
    }

    let who = from.unwrap_or_else(|| "primary".into());
    let (_pid, index, name, address) = resolve_player(&who)?;
    let amount_str = format!("{}", amount.round() as i128);

    let result = match index {
        // A vplayer signs through the same bridge every loop uses.
        Some(i) => {
            let payload = json!({
                "fromAddress": address,
                "toAddress": to,
                "amount": [{ "denom": denom, "amount": amount_str }],
            });
            crate::mcp::tx_retry::sign_with_retry(
                &app,
                i,
                "/structs.structs.MsgPlayerSend",
                payload,
                "board:transfer",
            )
            .await
            .map(|_| ())
        }
        // The primary signs through the webview queue (`bank_send`). Sweep
        // deliberately excludes the primary as a SOURCE, so this is the first
        // place on the board it can send from.
        None => {
            let tx_args = json!({
                "action_type": "bank_send",
                "from_address": address,
                "to_address": to,
                "amount": format!("{amount_str}{denom}"),
            });
            crate::mcp::tx_retry::submit_once(&app, "bank_send", tx_args, "board:transfer")
                .await
                .and_then(|r| {
                    if r.success {
                        Ok(())
                    } else {
                        Err(r.error.unwrap_or_else(|| "unknown error".into()))
                    }
                })
        }
    };

    match result {
        Ok(()) => {
            board_feed::push(
                &app,
                board_feed::Severity::Notice,
                "transfer",
                format!("Sent {amount_str} {denom} from {name} to {to}"),
            );
            Ok(json!({ "ok": true, "sent": amount_str, "denom": denom, "to": to }))
        }
        Err(e) => {
            board_feed::push(
                &app,
                board_feed::Severity::Important,
                "transfer",
                format!("Transfer from {name} failed: {e}"),
            );
            Err(e)
        }
    }
}

// ── HEALTH ───────────────────────────────────────────────────────────────────

/// System health for the board's status strip. Everything here was already
/// computed for the watchdog and the `structs_system` agent tool, and none of
/// it had a UI: whether sync is alive, which loops are overdue or wedged, how
/// far the AIMD controller has backed off, and whether telemetry is dropping.
#[tauri::command]
pub async fn mcp_health() -> Result<Value, String> {
    let mut h = crate::mcp::watchdog::health_snapshot();
    if let Some(obj) = h.as_object_mut() {
        obj.insert(
            "concurrency".into(),
            json!({
                "effective": crate::mcp::loop_util::effective_max_concurrent(),
                "max": crate::mcp::loop_util::MAX_CONCURRENT_PLAYERS,
            }),
        );
        // Loops that are running fine but cannot act — see telemetry::blocked.
        let blocked: Vec<Value> = crate::mcp::telemetry::blocked_reasons()
            .into_iter()
            .map(|(name, (reason, at))| json!({ "loop": name, "reason": reason, "at_ms": at }))
            .collect();
        obj.insert("loops_blocked".into(), json!(blocked));
    }
    Ok(h)
}

// ── WAR ──────────────────────────────────────────────────────────────────────

/// Everything the WAR page renders, in one call: the grudge/guild lists, the
/// scored target board from `auto_raid`, expeditions in flight, recent
/// `auto_response` incidents, and both combat loops' configs.
#[tauri::command]
pub async fn mcp_war_bundle() -> Result<Value, String> {
    let (shots_used, shots_cap) = crate::mcp::auto_response::shot_budget();
    Ok(json!({
        "lists": crate::mcp::combat_lists::snapshot_json(),
        "targets": crate::mcp::auto_raid::target_board(),
        "expeditions": crate::mcp::auto_raid::active_expeditions(),
        "incidents": crate::mcp::auto_response::recent_incidents(),
        "shot_budget": { "used": shots_used, "cap": shots_cap },
        "response": crate::mcp::auto_response::get(),
        "raid": crate::mcp::auto_raid::get(),
        "postures": ["cautious", "opportunist", "aggressive"],
        "modes": ["harden", "counter", "decapitate"],
    }))
}

// ── CONFIG ───────────────────────────────────────────────────────────────────

/// Everything the Config page shows, in one call.
#[tauri::command]
pub async fn mcp_config_bundle() -> Result<Value, String> {
    let policies = crate::mcp::policy::list_policies().await?;
    let (posture, pinned, autonomy) = crate::mcp::tools::doctrine::read_doctrine();
    Ok(json!({
        "policies": policies,
        "loops": loops_json(),
        "hash": crate::mcp::tools::hasher::hash_config_json(),
        "doctrine": { "posture": posture, "pinned_target": pinned, "autonomy": autonomy },
        "presets": crate::mcp::tools::doctrine::PRESETS,
        "web_board": {
            "enabled": crate::mcp::web_board::is_enabled(),
            "url": if crate::mcp::web_board::is_enabled() {
                json!(crate::mcp::web_board::board_url())
            } else { json!(null) },
        },
    }))
}

/// One multiplexed, board-guarded write path for every dashboard config
/// mutation. Domains: "policy" | "loop" | "hash" | "doctrine". Each write is
/// audited to the event feed so human changes appear in the same stream the
/// agent's do.
#[tauri::command]
pub async fn mcp_config_set(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    domain: String,
    payload: Value,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_config_set_impl(app, domain, payload).await
}

/// Body of `mcp_config_set` — the native path enters via the require_board
/// wrapper above; the token-authenticated web dashboard calls this directly
/// (the bearer token IS the operator authority there). Audit feed pushes live
/// in here so both paths are logged identically.
pub async fn mcp_config_set_impl(
    app: tauri::AppHandle,
    domain: String,
    payload: Value,
) -> Result<Value, String> {
    match domain.as_str() {
        "policy" => {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or("policy: name required")?
                .to_string();
            let enabled = payload.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let config = payload.get("config").cloned();
            {
                let mut engine = crate::mcp::policy::POLICY_ENGINE
                    .write()
                    .map_err(|_| "policy engine unavailable")?;
                engine.set_policy(&name, enabled, config);
            }
            board_feed::push(
                &app,
                board_feed::Severity::Notice,
                "config",
                format!("policy {} → {}", name, if enabled { "ON" } else { "off" }),
            );
            Ok(json!({ "ok": true }))
        }
        "loop" => {
            let which = payload
                .get("loop")
                .and_then(|v| v.as_str())
                .ok_or("loop: which loop?")?;
            let cfg = payload.get("config").cloned().ok_or("loop: config required")?;
            let summary = match which {
                "harvest" => {
                    let c: auto_harvest::AutoHarvestConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!("auto_harvest → {}", if c.enabled { "ON" } else { "off" });
                    auto_harvest::set(c);
                    s
                }
                "build" => {
                    let c: auto_build::AutoBuildConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!("auto_build → {}", if c.enabled { "ON" } else { "off" });
                    auto_build::set(c);
                    s
                }
                "defend" => {
                    let c: auto_defend::AutoDefendConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!("auto_defend → {}", if c.enabled { "ON" } else { "off" });
                    auto_defend::set(c);
                    s
                }
                "infuse" => {
                    let c: auto_infuse::AutoInfuseConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!("auto_infuse → {}", if c.enabled { "ON" } else { "off" });
                    auto_infuse::set(c);
                    s
                }
                "response" => {
                    let c: crate::mcp::auto_response::AutoResponseConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!(
                        "auto_response → {} ({:?}, {:?})",
                        if c.enabled { "ON" } else { "off" },
                        c.autonomy,
                        c.mode
                    );
                    crate::mcp::auto_response::set(c);
                    s
                }
                "raid" => {
                    let mut c: crate::mcp::auto_raid::AutoRaidConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    // A posture change rewrites the gates; an explicit posture in
                    // the same payload therefore wins over stale gate values the
                    // UI round-tripped from before the change.
                    if payload.get("apply_posture").and_then(|v| v.as_bool()) == Some(true) {
                        c.apply_posture(c.posture);
                    }
                    let s = format!(
                        "auto_raid → {} ({:?}, posture {:?})",
                        if c.enabled { "ON" } else { "off" },
                        c.autonomy,
                        c.posture
                    );
                    crate::mcp::auto_raid::set(c);
                    s
                }
                other => return Err(format!("unknown loop '{other}'")),
            };
            board_feed::push(&app, board_feed::Severity::Notice, "config", summary);
            Ok(json!({ "ok": true, "loops": loops_json() }))
        }
        "hash" => {
            let mut changes: Vec<String> = Vec::new();
            if let Some(enabled) = payload.get("enabled").and_then(|v| v.as_bool()) {
                crate::hasher::set_hash_enabled(enabled);
                // Mirror the structs_hash config behavior: disabling cancels tasks.
                if !enabled {
                    if let Some(reg) = app.try_state::<Arc<TaskRegistry>>() {
                        for entry in reg.tasks.iter() {
                            entry.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                        reg.tasks.clear();
                    }
                }
                use tauri::Emitter;
                let _ = app.emit("structs:hash-enabled", json!({ "enabled": enabled }));
                changes.push(format!("hashing → {}", if enabled { "on" } else { "OFF" }));
            }
            if let Some(engine) = payload.get("engine").and_then(|v| v.as_str()) {
                let p = match engine {
                    "cpu" => 1,
                    "gpu" => 2,
                    _ => 0,
                };
                crate::hasher::set_engine_pref(p);
                changes.push(format!("engine → {engine}"));
            }
            if let Some(ds) = payload.get("difficulty_start").and_then(|v| v.as_u64()) {
                if (1..=64).contains(&ds) {
                    crate::hasher::set_difficulty_start(ds);
                    changes.push(format!("difficulty_start → {ds}"));
                }
            }
            if let Some(mc) = payload.get("max_concurrent").and_then(|v| v.as_u64()) {
                if (1..=64).contains(&mc) {
                    crate::hasher::set_max_concurrent(mc);
                    crate::hasher::tuner::note_user_max(mc);
                    use tauri::Emitter;
                    let _ = app.emit("structs:task-overrides", json!({ "maxConcurrent": mc }));
                    changes.push(format!("max_concurrent → {mc}"));
                }
            }
            if let Some(at) = payload.get("auto_tune").and_then(|v| v.as_bool()) {
                crate::hasher::set_auto_tune(at);
                changes.push(format!("auto_tune → {}", if at { "on" } else { "off" }));
            }
            if !changes.is_empty() {
                crate::hasher::persist_config();
                board_feed::push(
                    &app,
                    board_feed::Severity::Notice,
                    "config",
                    format!("hash: {}", changes.join(", ")),
                );
            }
            Ok(json!({ "ok": true, "hash": crate::mcp::tools::hasher::hash_config_json() }))
        }
        "doctrine" => {
            // Reuse the doctrine tool's set path wholesale (presets included).
            let params = crate::mcp::tools::doctrine::DoctrineParams {
                command: "set".into(),
                posture: payload.get("posture").and_then(|v| v.as_str()).map(String::from),
                pinned_target: payload.get("pinned_target").and_then(|v| v.as_str()).map(String::from),
                auto_counter: payload.get("auto_counter").and_then(|v| v.as_bool()),
                retreat_cmd_below: payload.get("retreat_cmd_below").and_then(|v| v.as_u64()),
                autonomy: payload.get("autonomy").and_then(|v| v.as_str()).map(String::from),
                preset: payload.get("preset").and_then(|v| v.as_str()).map(String::from),
                list_action: None,
                kind: None,
                id: None,
                weight: None,
                note: None,
            };
            let out = crate::mcp::tools::doctrine::execute(params).await;
            let text = out
                .first()
                .and_then(|c| c.as_text().map(|t| t.text.clone()))
                .unwrap_or_default();
            board_feed::push(
                &app,
                board_feed::Severity::Notice,
                "config",
                format!(
                    "doctrine set{}",
                    payload
                        .get("preset")
                        .and_then(|v| v.as_str())
                        .map(|p| format!(" (preset {p})"))
                        .unwrap_or_default()
                ),
            );
            Ok(json!({ "ok": true, "detail": text }))
        }
        // ── Grudge / guild lists, edited one row at a time from the WAR page. ──
        // Shape: {action, kind, id, ...}. Kept row-scoped rather than
        // whole-document so two operators editing different rows can't clobber
        // each other's list.
        "combat_lists" => {
            use crate::mcp::combat_lists as cl;
            let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("add");
            let kind = payload.get("kind").and_then(|v| v.as_str()).unwrap_or("grudge");
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("combat_lists: id required (player id or guild id)")?
                .to_string();
            let f = |k: &str| payload.get(k).and_then(|v| v.as_f64());
            let s = |k: &str| payload.get(k).and_then(|v| v.as_str()).map(String::from);

            let summary = match (kind, action) {
                ("grudge", "remove") => {
                    cl::remove_grudge(&id);
                    format!("grudge {id} removed")
                }
                ("grudge", "mute") | ("grudge", "unmute") => {
                    let muted = action == "mute";
                    cl::set_muted(&id, muted);
                    format!("grudge {id} {}", if muted { "muted" } else { "unmuted" })
                }
                ("grudge", _) => {
                    let g = cl::upsert_grudge(
                        &id,
                        s("label"),
                        s("guild_id"),
                        f("weight"),
                        s("note"),
                        // `expires_ms: null` in the payload means "never expire".
                        payload.get("expires_ms").map(|v| v.as_f64()),
                    );
                    format!("grudge {id} → weight {:.1}", g.weight)
                }
                ("priority_guild", "remove") => {
                    cl::remove_priority_guild(&id);
                    format!("priority guild {id} removed")
                }
                ("priority_guild", _) => {
                    let g = cl::upsert_priority_guild(&id, s("label"), f("weight"));
                    format!("priority guild {id} → weight {:.1}", g.weight)
                }
                ("ally", a) => {
                    let allied = a != "remove";
                    cl::set_ally(&id, allied);
                    format!("guild {id} {} the never-attack list", if allied { "added to" } else { "removed from" })
                }
                ("protected", a) => {
                    let prot = a != "remove";
                    cl::set_protected(&id, prot);
                    format!("player {id} {} the never-attack list", if prot { "protected" } else { "unprotected" })
                }
                (other, _) => return Err(format!("combat_lists: unknown kind '{other}'")),
            };
            board_feed::push(&app, board_feed::Severity::Notice, "war", summary);
            Ok(json!({ "ok": true, "lists": cl::snapshot_json() }))
        }
        "web_board" => {
            let enabled = payload
                .get("enabled")
                .and_then(|v| v.as_bool())
                .ok_or("web_board: enabled (bool) required")?;
            crate::mcp::web_board::set_enabled(enabled);
            board_feed::push(
                &app,
                board_feed::Severity::Notice,
                "web_board",
                format!("web dashboard → {}", if enabled { "ENABLED" } else { "off" }),
            );
            Ok(json!({
                "ok": true,
                "web_board": {
                    "enabled": enabled,
                    "url": if enabled { json!(crate::mcp::web_board::board_url()) } else { json!(null) },
                },
            }))
        }
        other => Err(format!("unknown config domain '{other}'")),
    }
}

// ── ROLE APPEARANCE ────────────────────────────────────────────────────────

const PFP_TYPE_URL: &str = "/structs.structs.MsgPlayerUpdatePfpClientRenderAttributes";

/// Read the per-role appearance config + the picker's layer inventory + how
/// many players each managed role currently has (for the "Apply to all N" label).
#[tauri::command]
pub async fn mcp_role_pfp_get() -> Value {
    let (mut productive, mut bait) = (0u32, 0u32);
    {
        let reg = crate::mcp::virtual_players::REGISTRY
            .read()
            .unwrap_or_else(|e| e.into_inner());
        for p in &reg.players {
            match p.role.as_str() {
                "productive" => productive += 1,
                "bait" => bait += 1,
                _ => {}
            }
        }
    }
    json!({
        "config": crate::mcp::pfp::config_json(),
        "part_counts": crate::mcp::pfp::part_counts_json(),
        "counts": { "productive": productive, "bait": bait },
    })
}

/// Persist a managed role's appearance, then re-style every player currently in
/// that role to the new look. Board-guarded; the batch signs in the background
/// (self-throttled by the vplayer bridge) and reports start/finish to the feed.
#[tauri::command]
pub async fn mcp_role_pfp_set(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    role: String,
    config: Value,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_role_pfp_set_impl(app, role, config).await
}

/// Body of `mcp_role_pfp_set` (see mcp_config_set_impl for the split rationale).
pub async fn mcp_role_pfp_set_impl(
    app: tauri::AppHandle,
    role: String,
    config: Value,
) -> Result<Value, String> {
    let role_cfg: crate::mcp::pfp::RolePfp =
        serde_json::from_value(config).map_err(|e| format!("bad appearance config: {e}"))?;
    let stored = crate::mcp::pfp::set_role(&role, role_cfg)?;

    // Every player currently in this role gets the new look (explicit restyle —
    // unlike the passive empty-only self-heal, this intentionally overwrites).
    let targets: Vec<(u32, String)> = {
        let reg = crate::mcp::virtual_players::REGISTRY
            .read()
            .unwrap_or_else(|e| e.into_inner());
        reg.players
            .iter()
            .filter(|p| p.role.as_str() == role)
            .filter_map(|p| p.player_id.clone().map(|pid| (p.index, pid)))
            .collect()
    };
    let n = targets.len();
    board_feed::push(
        &app,
        board_feed::Severity::Notice,
        "appearance",
        format!("{role} look updated — restyling {n} player(s)"),
    );

    let app2 = app.clone();
    let role2 = role.clone();
    tauri::async_runtime::spawn(async move {
        // Clones for the per-player closure; app2/role2 survive for the summary.
        let (fa, fr) = (app2.clone(), role2.clone());
        crate::mcp::loop_util::for_each_player_concurrent(
            targets,
            crate::mcp::loop_util::effective_max_concurrent(),
            move |(index, pid)| {
                let app = fa.clone();
                let role = fr.clone();
                async move {
                    let attrs = crate::mcp::pfp::role_pfp_attrs(&role, index);
                    let _ = crate::mcp::vplayer_bridge::sign_action(
                        &app,
                        index,
                        PFP_TYPE_URL,
                        json!({ "playerId": pid, "pfpClientRenderAttributes": attrs }),
                        60,
                    )
                    .await;
                }
            },
        )
        .await;
        board_feed::push(
            &app2,
            board_feed::Severity::Notice,
            "appearance",
            format!("{role2} restyle complete ({n} player(s))"),
        );
        roster_cache::trigger_sweep(app2.clone(), 0.0);
    });

    Ok(json!({
        "ok": true,
        "restyling": n,
        "config": serde_json::to_value(&stored).unwrap_or_else(|_| json!({})),
    }))
}

// ── TX (signing-queue lifecycle + team tx history) ──────────────────────────

/// Read the primary's live signing queue (via the txq bridge to the main
/// webview) plus the whole team's recent tx attempts (telemetry). Read-only —
/// unguarded, like the other board reads. Each half degrades independently:
/// a signed-out webview still leaves history working, and vice versa.
#[tauri::command]
pub async fn mcp_tx_snapshot(app: tauri::AppHandle) -> Value {
    let (queue, queue_error) =
        match crate::mcp::txq_bridge::call(&app, "snapshot", json!({}), 10).await {
            Ok(v) => (v, Value::Null),
            Err(e) => (Value::Null, json!(e)),
        };
    let (history, history_error) = match tokio::task::spawn_blocking(|| {
        crate::mcp::telemetry::tx_attempts_recent(50)
    })
    .await
    {
        Ok(Ok(rows)) => (json!(rows), Value::Null),
        Ok(Err(e)) => (json!([]), json!(e)),
        Err(e) => (json!([]), json!(format!("history query panicked: {e}"))),
    };
    json!({
        "queue": queue,
        "queue_error": queue_error,
        "history": history,
        "history_error": history_error,
    })
}

/// Mutate the primary's signing queue: cancel / move_up / move_down / reorder.
/// Board-guarded — this is the write path. Delegates to the queue's own
/// mutation API (which refuses in-flight items by returning ok:false).
#[tauri::command]
pub async fn mcp_tx_mutate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    op: String,
    id: String,
    new_index: Option<i64>,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_tx_mutate_impl(app, op, id, new_index).await
}

/// Body of `mcp_tx_mutate` (see mcp_config_set_impl for the split rationale).
pub async fn mcp_tx_mutate_impl(
    app: tauri::AppHandle,
    op: String,
    id: String,
    new_index: Option<i64>,
) -> Result<Value, String> {
    match op.as_str() {
        "cancel" | "move_up" | "move_down" => {}
        "reorder" => {
            if new_index.is_none() {
                return Err("reorder requires new_index".into());
            }
        }
        other => return Err(format!("unknown tx op '{other}'")),
    }
    let result = crate::mcp::txq_bridge::call(
        &app,
        "mutate",
        json!({ "op": op, "id": id, "new_index": new_index }),
        10,
    )
    .await?;
    if op == "cancel" && result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let short: String = id.chars().take(8).collect();
        board_feed::push(
            &app,
            board_feed::Severity::Info,
            "txq",
            format!("cancelled queued tx {short}…"),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod inventory_tests {
    use super::*;

    /// The whole point of the allow-list. A failed ore send is exactly the
    /// mistake an Inventory page could invite, so this is asserted rather than
    /// left to the UI to remember.
    #[test]
    fn ore_is_never_sendable() {
        assert!(!is_sendable("ore"));
        assert!(!SENDABLE_DENOMS.contains(&"ore"));
    }

    /// Guild tokens are real bank assets but their transferability is not
    /// verified, so they stay read-only until it is.
    #[test]
    fn guild_tokens_are_read_only_for_now() {
        assert!(!is_sendable("uguild.0-5"));
        assert!(!is_sendable("uguild.0-1"));
    }

    #[test]
    fn alpha_is_the_only_sendable_denom() {
        assert_eq!(SENDABLE_DENOMS, &["ualpha"]);
        assert!(is_sendable("ualpha"));
    }
}
