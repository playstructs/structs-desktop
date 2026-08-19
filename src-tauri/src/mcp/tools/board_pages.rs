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
        "sweep": crate::mcp::auto_sweep::get(),
        "response": crate::mcp::auto_response::get(),
        "raid": crate::mcp::auto_raid::get(),
        "delegation": crate::mcp::delegation::get(),
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

    let registry = crate::guild_config::denom_registry();
    // Normalise every row to ONE convention: base units, the same thing bank
    // balances and `alpha_ualpha` are in.
    //
    // The sources disagree. GRASS inventory events carry BOTH `amount_p` (the
    // precise base-unit value) and `amount` (that value FLOORED to display
    // units — 98 800 000 uguild.0-5 is published as `amount: 98`, losing the
    // .8). The Guild-API ledger ships only the lossy `amount`. Handing those
    // two straight to the UI is how a 2-Alpha sweep credit rendered as "0":
    // the display number was divided by 10^6 a second time.
    //
    // So: prefer `amount_p`; otherwise scale `amount` back up and mark the row
    // `precise: false` so the UI can say the value is approximate rather than
    // quietly claiming a precision the ledger never gave us.
    let rows: Vec<Value> = page_data
        .items
        .into_iter()
        .map(|mut r| {
            let denom = r.get("denom").and_then(|d| d.as_str()).unwrap_or("");
            let exp = registry.get(denom).map(|i| i.exponent).unwrap_or(0);
            let num = |v: Option<&Value>| -> Option<f64> {
                match v? {
                    Value::String(s) => s.parse::<f64>().ok(),
                    other => other.as_f64(),
                }
            };
            let (base, precise) = match num(r.get("amount_p")) {
                Some(p) => (p, true),
                None => (
                    num(r.get("amount")).unwrap_or(0.0) * 10f64.powi(exp as i32),
                    exp == 0,
                ),
            };
            if let Some(obj) = r.as_object_mut() {
                obj.insert("amount_base".into(), json!(base));
                obj.insert("precise".into(), json!(precise));
            }
            r
        })
        .collect();

    Ok(json!({
        "player": { "player_id": player_id, "name": name, "address": address },
        "rows": rows,
        "page": page_data.page,
        "has_more": page_data.has_more,
        "addresses": crate::mcp::enrich::addresses_map(),
        "denoms": registry,
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

// ── ALLOCATIONS ──────────────────────────────────────────────────────────────
// An allocation routes capacity from a SOURCE object (usually you) to a
// DESTINATION (usually a substation). Two facts drive this whole surface:
//
//   * `SetPower` adds the allocation's power to the destination's CAPACITY and
//     to the source's LOAD. Raising an allocation therefore raises YOUR load —
//     it is not free.
//   * If an object's load ever exceeds its capacity the chain runs a brownout
//     (`GridCascade`) and DESTROYS that object's outgoing allocations in
//     creation order, cascading downstream. Over-committing does not merely
//     fail; it tears down the thing you were trying to grow.
//
// So every number here is presented against the headroom it consumes, and a
// change that would exceed capacity is refused rather than signed.

/// Milliwatts per kilowatt — the chain stores power in mW.
const MW_PER_KW: f64 = 1_000_000.0;

fn grid_num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        Some(other) => other.as_f64().unwrap_or(0.0),
        None => 0.0,
    }
}

/// One allocation plus everything the UI needs to reason about a change.
async fn allocation_row(client: &crate::mcp::cosmos_client::CosmosClient, id: &str) -> Option<Value> {
    let e = client.query_entity("allocation", id).await.ok()?;
    let a = e.get("Allocation")?;
    let ga = e.get("gridAttributes");
    Some(json!({
        "id": a.get("id").and_then(|v| v.as_str()).unwrap_or(id),
        "type": a.get("type").and_then(|v| v.as_str()).unwrap_or("static"),
        "source_object_id": a.get("sourceObjectId").and_then(|v| v.as_str()).unwrap_or(""),
        "destination_id": a.get("destinationId").and_then(|v| v.as_str()).unwrap_or(""),
        "controller": a.get("controller").and_then(|v| v.as_str()).unwrap_or(""),
        "creator": a.get("creator").and_then(|v| v.as_str()).unwrap_or(""),
        "locked": a.get("locked").and_then(|v| v.as_bool()).unwrap_or(false),
        "power_mw": grid_num(ga.and_then(|g| g.get("power"))),
    }))
}

/// The primary's allocations, plus the power budget any change is measured
/// against and the substations a connection could point at.
#[tauri::command]
pub async fn mcp_allocations() -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let (pid, addr, guild_id) = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
        (
            gs.player_id.clone().unwrap_or_default(),
            gs.wallet_address.clone().unwrap_or_default(),
            gs.guild_id.clone().unwrap_or_default(),
        )
    };
    if pid.is_empty() {
        return Err("primary player not synced yet".into());
    }

    // Prefer the indexed Guild API; fall back to the LCD list, which is small
    // today but is a full scan and would not stay cheap.
    let mut ids: Vec<String> = Vec::new();
    if let Ok(page) = client.guild.allocation_by_controller(&pid, 1).await {
        for a in page.items {
            if let Some(id) = a.get("id").and_then(|v| v.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    if ids.is_empty() {
        if let Ok(list) = client.list_entities("allocation", None, Some(500)).await {
            let arr = list
                .get("Allocation")
                .or_else(|| list.get("allocation"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for a in arr {
                let mine = a.get("controller").and_then(|v| v.as_str()) == Some(pid.as_str())
                    || a.get("creator").and_then(|v| v.as_str()) == Some(addr.as_str());
                if mine {
                    if let Some(id) = a.get("id").and_then(|v| v.as_str()) {
                        ids.push(id.to_string());
                    }
                }
            }
        }
    }

    // One read per allocation, run concurrently (capped) for the same reason
    // as the substations below: serial round trips are what made this page
    // slow, not any single endpoint.
    let c = client.clone();
    let mut by_index: Vec<(usize, Value)> = crate::mcp::loop_util::map_concurrent(
        ids.iter().cloned().enumerate().collect::<Vec<_>>(),
        8,
        move |(i, id)| {
            let c = c.clone();
            async move { (i, allocation_row(&c, &id).await) }
        },
    )
    .await
    .into_iter()
    .filter_map(|(i, row)| row.map(|r| (i, r)))
    .collect();
    // Stable order: results arrive as they finish, and the list must not
    // reshuffle between refreshes.
    by_index.sort_by_key(|(i, _)| *i);
    let allocations: Vec<Value> = by_index.into_iter().map(|(_, r)| r).collect();

    // The budget. `load` already INCLUDES the power of these allocations, so a
    // change of +X moves load by +X and headroom by −X.
    let (capacity, load, structs_load, capacity_secondary) =
        match client.query_entity("player", &pid).await {
            Ok(p) => {
                let ga = p.get("gridAttributes");
                (
                    grid_num(ga.and_then(|g| g.get("capacity"))),
                    grid_num(ga.and_then(|g| g.get("load"))),
                    grid_num(ga.and_then(|g| g.get("structsLoad"))),
                    // The share received from the substation we're connected to.
                    grid_num(ga.and_then(|g| g.get("connectionCapacity"))),
                )
            }
            Err(e) => return Err(format!("could not read the primary's power: {e}")),
        };

    // Candidate destinations: EVERY substation on the chain.
    //
    // Connecting an allocation needs no permission from the destination, so
    // any substation is a legal target — including another guild's, which is
    // how power is lent across guilds. Listing only "the guild's plus ones we
    // already feed" left exactly one choice in the Move dropdown and made a
    // legal move look impossible. The galaxy holds a couple of dozen
    // substations, so enumerating them is one cheap paged read.
    let mut subs: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut add_sub = |id: &str, subs: &mut Vec<Value>, seen: &mut std::collections::HashSet<String>| {
        if id.is_empty() || !seen.insert(id.to_string()) {
            return;
        }
        subs.push(json!({ "id": id }));
    };
    // Ours first so the familiar entries stay at the top of the dropdown.
    for a in &allocations {
        if let Some(d) = a.get("destination_id").and_then(|v| v.as_str()) {
            add_sub(d, &mut subs, &mut seen);
        }
    }
    if !guild_id.is_empty() {
        if let Ok(gp) = crate::mcp::guild_power::resolve_guild_power(&client, &guild_id).await {
            add_sub(&gp.substation_id, &mut subs, &mut seen);
        }
    }
    // Then everything else. A failure here must not break the page — the
    // familiar destinations above are still perfectly usable on their own.
    // Names come from this listing (the per-entity read below doesn't carry
    // one), and "4-10" tells an operator nothing while "Orbital Hydro" does.
    let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut page_key: Option<String> = None;
    loop {
        let listed = client
            .list_entities("substation", page_key.as_deref(), Some(200))
            .await;
        let Ok(v) = listed else { break };
        if let Some(items) = v.get("Substation").and_then(|x| x.as_array()) {
            for item in items {
                let Some(id) = item.get("id").and_then(|x| x.as_str()) else {
                    continue;
                };
                if let Some(n) = item.get("name").and_then(|x| x.as_str()) {
                    if !n.is_empty() {
                        names.insert(id.to_string(), n.to_string());
                    }
                }
                add_sub(id, &mut subs, &mut seen);
            }
        }
        page_key = v
            .get("pagination")
            .and_then(|p| p.get("next_key"))
            .and_then(|k| k.as_str())
            .filter(|k| !k.is_empty())
            .map(String::from);
        if page_key.is_none() {
            break;
        }
    }
    // Enrich each candidate with what a connection there would actually be
    // worth. CONCURRENTLY: the list read gives names but not grid attributes,
    // so this is one request per substation, and doing them in series made the
    // Power tab take 8–10 s. Individually each read is ~20 ms, but under live
    // loop load the shared connection pool is busy and a queued request waits
    // ~450 ms — so latency here is dominated by the NUMBER of sequential round
    // trips, not by any one endpoint. Fired together, the whole set costs about
    // as much as the slowest single read.
    let ids: Vec<String> = subs
        .iter()
        .map(|s| s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .filter(|id| !id.is_empty())
        .collect();
    // `map_concurrent` rather than a raw JoinSet: it CAPS how many reads are
    // in flight. Firing all of them at once would contradict the AIMD limiter
    // the loops obey and could push the very endpoint pressure it exists to
    // avoid — and the substation count is chain-driven, so it can grow.
    let c = client.clone();
    let enriched: std::collections::HashMap<String, (f64, f64, f64, f64)> =
        crate::mcp::loop_util::map_concurrent(ids.clone(), 8, move |id| {
            let c = c.clone();
            async move {
                let nums = match c.query_entity("substation", &id).await {
                    Ok(v) => {
                        let ga = v.get("gridAttributes");
                        (
                            grid_num(ga.and_then(|g| g.get("capacity"))),
                            grid_num(ga.and_then(|g| g.get("load"))),
                            grid_num(ga.and_then(|g| g.get("connectionCount"))),
                            grid_num(ga.and_then(|g| g.get("connectionCapacity"))),
                        )
                    }
                    // A substation that fails to read still belongs in the
                    // list — it is a legal destination, we just cannot price it.
                    Err(_) => (0.0, 0.0, 0.0, 0.0),
                };
                (id, nums)
            }
        })
        .await
        .into_iter()
        .collect();
    // Rebuild in the ORIGINAL order — ours first, then the rest — because that
    // ordering is what the Move dropdown shows.
    let mut substations = Vec::new();
    for id in ids {
        let (cap, ld, conns, conn_cap) =
            enriched.get(&id).copied().unwrap_or((0.0, 0.0, 0.0, 0.0));
        substations.push(json!({
            "id": id,
            "name": names.get(&id).cloned().unwrap_or_default(),
            "capacity_mw": cap, "load_mw": ld,
            "connection_count": conns, "connection_capacity_mw": conn_cap,
        }));
    }

    Ok(json!({
        "player_id": pid,
        "allocations": allocations,
        // TWO different numbers, and conflating them is the easy mistake:
        //
        //   allocatable = capacity - load
        //       what you can still route OUT into an allocation.
        //   available   = (capacity + capacitySecondary) - (load + structsLoad)
        //       whether your own structs stay ONLINE.
        //
        // Your structs draw against the second, and the incoming substation
        // share only counts there — it cannot be re-allocated onward.
        // (Verified against structs-ai/knowledge/mechanics/energy.md:44.)
        "budget": {
            "capacity_mw": capacity,
            "load_mw": load,
            "structs_load_mw": structs_load,
            "capacity_secondary_mw": capacity_secondary,
            "allocatable_mw": (capacity - load).max(0.0),
            "available_mw": (capacity + capacity_secondary) - (load + structs_load),
            "online": (load + structs_load) <= (capacity + capacity_secondary),
        },
        "substations": substations,
        "mw_per_kw": MW_PER_KW,
    }))
}

/// Shared guard for anything that raises an allocation's power.
///
/// Returns the reason a change must NOT be signed, or None. Kept pure so the
/// brownout rule is unit-testable — this is the check that stands between a
/// typo and the chain tearing down your allocations.
pub fn power_change_refusal(
    new_power_mw: f64,
    current_power_mw: f64,
    capacity_mw: f64,
    load_mw: f64,
) -> Option<String> {
    if !new_power_mw.is_finite() || new_power_mw < 0.0 {
        return Some("power must be zero or more".into());
    }
    // load already includes current_power, so the delta is what moves it.
    let projected_load = load_mw - current_power_mw + new_power_mw;
    if projected_load > capacity_mw {
        return Some(format!(
            "that would put your load at {:.2} kW against {:.2} kW of capacity. \
             The chain brownouts an object whose load exceeds its capacity and \
             DESTROYS its allocations in creation order — reduce the amount or \
             raise capacity first.",
            projected_load / MW_PER_KW,
            capacity_mw / MW_PER_KW
        ));
    }
    None
}


/// Read the budget an allocation change is measured against.
async fn allocation_budget(
    client: &crate::mcp::cosmos_client::CosmosClient,
    pid: &str,
) -> Result<(f64, f64), String> {
    let p = client
        .query_entity("player", pid)
        .await
        .map_err(|e| format!("could not read the primary's power: {e}"))?;
    let ga = p.get("gridAttributes");
    Ok((
        grid_num(ga.and_then(|g| g.get("capacity"))),
        grid_num(ga.and_then(|g| g.get("load"))),
    ))
}

/// Preview a power change without signing: what it costs, what it leaves, and
/// the reason it would be refused. ALWAYS call this before the setter — the
/// setter re-runs the same guard, so a stale UI cannot slip a bad value past.
#[tauri::command]
pub async fn mcp_allocation_preview(allocation_id: String, power_mw: f64) -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let pid = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
        gs.player_id.clone().unwrap_or_default()
    };
    let row = allocation_row(&client, &allocation_id)
        .await
        .ok_or_else(|| format!("allocation {allocation_id} not found"))?;
    let current = row.get("power_mw").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let (capacity, load) = allocation_budget(&client, &pid).await?;
    let refusal = power_change_refusal(power_mw, current, capacity, load);
    let projected_load = load - current + power_mw;
    Ok(json!({
        "ok": refusal.is_none(),
        "refusal": refusal,
        "allocation": row,
        "current_power_mw": current,
        "new_power_mw": power_mw,
        "delta_mw": power_mw - current,
        "capacity_mw": capacity,
        "load_mw": load,
        "projected_load_mw": projected_load,
        "projected_headroom_mw": (capacity - projected_load).max(0.0),
        "projected_headroom_pct": if capacity > 0.0 {
            (capacity - projected_load) / capacity * 100.0
        } else { 0.0 },
    }))
}

/// Set an allocation's power. Board-only; re-runs the brownout guard.
#[tauri::command]
pub async fn mcp_allocation_set_power(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    allocation_id: String,
    power_mw: f64,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_allocation_set_power_impl(app, allocation_id, power_mw).await
}

pub async fn mcp_allocation_set_power_impl(
    app: tauri::AppHandle,
    allocation_id: String,
    power_mw: f64,
) -> Result<Value, String> {
    let preview = mcp_allocation_preview(allocation_id.clone(), power_mw).await?;
    if preview.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "refused: {}",
            preview.get("refusal").and_then(|v| v.as_str()).unwrap_or("unsafe change")
        ));
    }
    // `dynamic` is the only type whose power is meant to be edited: `static` is
    // fixed, `automated` re-sizes itself to the source's full capacity, and
    // provider-agreement allocations are system-managed.
    let atype = preview
        .pointer("/allocation/type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if atype != "dynamic" {
        return Err(format!(
            "allocation {allocation_id} is '{atype}' — only 'dynamic' allocations have an editable power"
        ));
    }
    let args = json!({ "allocation_id": allocation_id, "power": power_mw.round() as i64 });
    match crate::mcp::tx_retry::submit_once(&app, "allocation_update", args, "board:allocation_update").await {
        Ok(r) if r.success => {
            crate::mcp::board_feed::push(
                &app,
                crate::mcp::board_feed::Severity::Notice,
                "allocation",
                format!(
                    "allocation {allocation_id} set to {:.2} kW",
                    power_mw / MW_PER_KW
                ),
            );
            Ok(json!({ "ok": true, "power_mw": power_mw }))
        }
        Ok(r) => Err(r.error.unwrap_or_else(|| "rejected".into())),
        Err(e) => Err(e),
    }
}

/// Point an allocation at a different substation. Connecting needs no
/// permission from the destination — the chain checks only your own allocation.
#[tauri::command]
pub async fn mcp_allocation_connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    allocation_id: String,
    destination_id: String,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_allocation_connect_impl(app, allocation_id, destination_id).await
}

pub async fn mcp_allocation_connect_impl(
    app: tauri::AppHandle,
    allocation_id: String,
    destination_id: String,
) -> Result<Value, String> {
    if !destination_id.starts_with("4-") {
        return Err(format!(
            "'{destination_id}' is not a substation id (they look like 4-1)"
        ));
    }
    let args = json!({ "allocation_id": allocation_id, "destination_id": destination_id });
    match crate::mcp::tx_retry::submit_once(
        &app, "substation_allocation_connect", args, "board:allocation_connect",
    ).await {
        Ok(r) if r.success => {
            crate::mcp::board_feed::push(
                &app,
                crate::mcp::board_feed::Severity::Notice,
                "allocation",
                format!("allocation {allocation_id} now feeds {destination_id}"),
            );
            Ok(json!({ "ok": true }))
        }
        Ok(r) => Err(r.error.unwrap_or_else(|| "rejected".into())),
        Err(e) => Err(e),
    }
}

/// Create a new allocation from a source you control.
#[tauri::command]
pub async fn mcp_allocation_create(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    source_object_id: String,
    allocation_type: String,
    power_mw: f64,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_allocation_create_impl(app, source_object_id, allocation_type, power_mw).await
}

pub async fn mcp_allocation_create_impl(
    app: tauri::AppHandle,
    source_object_id: String,
    allocation_type: String,
    power_mw: f64,
) -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let pid = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
        gs.player_id.clone().unwrap_or_default()
    };
    if !matches!(allocation_type.as_str(), "static" | "dynamic" | "automated") {
        return Err(format!(
            "'{allocation_type}' is not a creatable type (static, dynamic or automated; \
             provider-agreement allocations are system-managed)"
        ));
    }
    // A new allocation adds its power to our load from nothing, so the guard
    // runs with current = 0.
    if source_object_id == pid {
        let (capacity, load) = allocation_budget(&client, &pid).await?;
        if let Some(why) = power_change_refusal(power_mw, 0.0, capacity, load) {
            return Err(format!("refused: {why}"));
        }
    }
    let args = json!({
        "controller": pid,
        "source_object_id": source_object_id,
        "allocation_type": allocation_type,
        "power": power_mw.round() as i64,
    });
    match crate::mcp::tx_retry::submit_once(&app, "allocation_create", args, "board:allocation_create").await {
        Ok(r) if r.success => {
            crate::mcp::board_feed::push(
                &app,
                crate::mcp::board_feed::Severity::Notice,
                "allocation",
                format!(
                    "created a {allocation_type} allocation of {:.2} kW from {source_object_id}",
                    power_mw / MW_PER_KW
                ),
            );
            Ok(json!({ "ok": true }))
        }
        Ok(r) => Err(r.error.unwrap_or_else(|| "rejected".into())),
        Err(e) => Err(e),
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
        // `bind` and `port` are readings the Access card shows as tiles — the
        // console used to explain the loopback binding in a sentence instead of
        // simply displaying the address it is bound to.
        "web_board": {
            "enabled": crate::mcp::web_board::is_enabled(),
            "bind": "127.0.0.1",
            "port": crate::mcp::config::McpConfig::load().port,
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
        // Row-scoped, like `combat_lists` — the loadout is an ordered table and
        // two operators editing different rows must not clobber each other, so
        // this takes ONE action at a time rather than a whole document.
        "profile" => {
            use crate::mcp::profile as pr;
            let action = payload
                .get("action")
                .and_then(|v| v.as_str())
                .ok_or("profile: action required")?;
            let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

            let summary = match action {
                "fork" => {
                    let from = payload.get("from").and_then(|v| v.as_str()).unwrap_or("bait");
                    let mut p = pr::find(from);
                    p.id = id.clone();
                    p.label = payload
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    pr::set(p)?;
                    format!("profile '{id}' forked from '{from}'")
                }
                "rename" => {
                    let to = payload.get("new_id").and_then(|v| v.as_str()).unwrap_or("");
                    let label = payload.get("label").and_then(|v| v.as_str());
                    let p = pr::rename(&id, to, label)?;
                    format!("profile '{id}' renamed to '{}'", p.id)
                }
                "delete" => {
                    pr::remove(&id)?;
                    format!("profile '{id}' deleted")
                }
                // Whole-profile replace, used by import and by the row editor
                // after it has applied one change locally.
                "save" => {
                    let doc = payload.get("profile").cloned().ok_or("profile: document required")?;
                    let p: pr::Profile =
                        serde_json::from_value(doc).map_err(|e| format!("not readable: {e}"))?;
                    let saved = pr::set(p)?;
                    format!("profile '{}' saved ({} rows)", saved.id, saved.loadout.len())
                }
                "assign" => {
                    let who = payload
                        .get("player")
                        .and_then(|v| v.as_str())
                        .ok_or("profile assign: which player?")?;
                    let next = if id.is_empty() { None } else { Some(id.clone()) };
                    // set_profile updates REGISTRY and persists; save() alone
                    // would leave every loop reading the old value.
                    let name = crate::mcp::virtual_players::set_profile(who, next.clone())?;
                    match next {
                        Some(p) => format!("{name} → profile '{p}'"),
                        None => format!("{name} → cleared (falls back to its role)"),
                    }
                }
                other => return Err(format!("profile: unknown action '{other}'")),
            };
            crate::mcp::board_feed::push(
                &app,
                crate::mcp::board_feed::Severity::Notice,
                "config",
                summary.clone(),
            );
            return Ok(serde_json::json!({ "ok": true, "summary": summary }));
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
                // Not a loop of its own — the behavioural profile every loop
                // reads when it has a choice. Lives here so the generic config
                // editor renders it with no bespoke UI.
                "variance" => {
                    let mut c: crate::mcp::variance::VarianceConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    // Same ordering rule as `posture`: a preset rewrites every
                    // temperament, so apply it FIRST and let explicit edits in
                    // the same payload win.
                    if payload.get("apply_preset").and_then(|v| v.as_bool()).unwrap_or(false) {
                        let p = c.preset;
                        c.apply_preset(p);
                    }
                    let s = format!(
                        "variance → {} ({})",
                        if c.enabled { "ON" } else { "off" },
                        serde_json::to_string(&c.preset).unwrap_or_default().trim_matches('"')
                    );
                    crate::mcp::variance::set(c);
                    s
                }
                "infuse" => {
                    let c: auto_infuse::AutoInfuseConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!("auto_infuse → {}", if c.enabled { "ON" } else { "off" });
                    auto_infuse::set(c);
                    s
                }
                "sweep" => {
                    let c: crate::mcp::auto_sweep::AutoSweepConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!(
                        "auto_sweep → {} (at {} Alpha, {} per scan)",
                        if c.enabled { "ON" } else { "off" },
                        c.min_send_alpha,
                        c.max_sends_per_scan
                    );
                    crate::mcp::auto_sweep::set(c);
                    s
                }
                "delegation" => {
                    let c: crate::mcp::delegation::DelegationConfig =
                        serde_json::from_value(cfg).map_err(|e| e.to_string())?;
                    let s = format!(
                        "delegation → {} ({} per scan)",
                        if c.enabled { "ON" } else { "off" },
                        c.max_grants_per_scan
                    );
                    crate::mcp::delegation::set(c);
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

// ── CALLSIGNS (generated player names) ─────────────────────────────────────

/// The naming config, the styles to choose from, and a live preview against
/// the operator's OWN fleet — the preview uses real HD indices so what they see
/// is exactly what will be signed, not an abstract sample.
#[tauri::command]
pub async fn mcp_callsign_get() -> Value {
    let cfg = crate::mcp::callsign::config();

    // Real indices from the registry, so the preview names actual players.
    let (indices, fleet): (Vec<u32>, usize) = {
        let reg = crate::mcp::virtual_players::REGISTRY
            .read()
            .unwrap_or_else(|e| e.into_inner());
        let mut idx: Vec<u32> = reg.players.iter().map(|p| p.index).collect();
        idx.sort_unstable();
        let n = idx.len();
        idx.truncate(8);
        (idx, n)
    };
    let indices = if indices.is_empty() { vec![1, 2, 3, 4, 5, 6, 7, 8] } else { indices };

    let styles: Vec<Value> = crate::mcp::callsign::BUILTIN
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "label": s.label,
                "capacity": crate::mcp::callsign::capacity(s),
                "example": crate::mcp::callsign::preview_with(s, &cfg.prefix, &[1])
                    .first().map(|(_, n)| n.clone()).unwrap_or_default(),
            })
        })
        .collect();

    // Rollout progress. A budgeted rename takes many sweeps, and without a
    // count on this card the only evidence it is working at all is the log —
    // which is not where anyone looks after flipping a switch.
    let (renamed, pending, operator_named) = {
        let rows = crate::mcp::roster_cache::all_rows();
        let reg = crate::mcp::virtual_players::REGISTRY
            .read()
            .unwrap_or_else(|e| e.into_inner());
        let (mut done, mut todo, mut theirs) = (0usize, 0usize, 0usize);
        for p in &reg.players {
            let Some(pid) = p.player_id.as_deref() else { continue };
            let want = crate::mcp::callsign::name_for(p.index);
            let chain = rows
                .iter()
                .find(|r| r.player_id == pid)
                .and_then(|r| r.chain_name.clone())
                .unwrap_or_default();
            if chain == want {
                done += 1;
            } else if p.auto_name && crate::mcp::callsign::is_managed_name(&chain) {
                todo += 1;
            } else {
                theirs += 1;
            }
        }
        (done, todo, theirs)
    };

    let active = crate::mcp::callsign::find_style(&cfg, &cfg.style);
    let capacity = crate::mcp::callsign::capacity(&active);
    json!({
        "renamed": renamed,
        "pending": pending,
        // Names the operator chose; reported so the count reconciles with the
        // fleet size rather than looking like players went missing.
        "operator_named": operator_named,
        "per_sweep": crate::mcp::roster_cache::RENAME_BUDGET_PER_SWEEP,
        "config": crate::mcp::callsign::config_json(),
        "styles": styles,
        "capacity": capacity,
        "fleet": fleet,
        // The operator's own legibility check: fewer slots than players means
        // some colleagues would share a name.
        "capacity_ok": capacity as usize >= fleet,
        "preview": crate::mcp::callsign::preview(&indices)
            .into_iter()
            .map(|(i, n)| json!({ "index": i, "name": n }))
            .collect::<Vec<_>>(),
    })
}

/// Persist naming settings. Renaming itself is NOT done here — the roster sweep
/// converges the fleet on its own, budgeted, exactly as portraits do. This just
/// decides what the target names are and whether the sweep may write them.
#[tauri::command]
pub async fn mcp_callsign_set(
    window: tauri::WebviewWindow,
    config: Value,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_callsign_set_impl(config).await
}

/// Body of `mcp_callsign_set` (see mcp_config_set_impl for the split rationale).
pub async fn mcp_callsign_set_impl(config: Value) -> Result<Value, String> {
    let next: crate::mcp::callsign::CallsignConfig =
        serde_json::from_value(config).map_err(|e| format!("bad callsign config: {e}"))?;
    crate::mcp::callsign::set_config(next)?;
    Ok(mcp_callsign_get().await)
}

// ── BEHAVIOUR PROFILES ─────────────────────────────────────────────────────

/// Everything the profile card needs: each profile plus a PREVIEW of what it
/// would actually build, so the editor can show consequences before commit.
#[tauri::command]
pub async fn mcp_profiles_get() -> Value {
    use crate::mcp::profile as pr;
    let rows: Vec<Value> = pr::list()
        .iter()
        .map(|p| {
            let pv = pr::preview(p, 8);
            serde_json::json!({
                "id": p.id,
                "label": p.label,
                "builtin": pr::BUILTIN.iter().any(|b| b.id == p.id),
                "capabilities": p.capabilities,
                "loadout": p.loadout,
                "defence": p.defence,
                "temperament": p.temperament,
                "limits": p.limits,
                "temperament_label": p.temperament_label(),
                "preview": {
                    "verdict": pv.verdict,
                    "blind": pv.blind,
                    "covered_after": pv.covered_after,
                    "builds": pv.builds,
                    "unknown_types": pv.unknown_types,
                },
            })
        })
        .collect();
    // Assignment counts, so the card can warn before a profile is edited.
    let reg = crate::mcp::virtual_players::REGISTRY
        .read()
        .unwrap_or_else(|e| e.into_inner());
    let mut assigned: std::collections::HashMap<String, usize> = Default::default();
    for v in reg.players.iter() {
        if let Some(id) = &v.profile {
            *assigned.entry(id.clone()).or_insert(0) += 1;
        }
    }
    serde_json::json!({
        "profiles": rows,
        "assigned": assigned,
        "targets": crate::mcp::profile::TARGET_NAMES,
        "ambits": crate::mcp::profile::AMBIT_NAMES,
        "schema": pr::SCHEMA,
    })
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
                    // Ledgered: a batch restyle is the LARGEST burst of writes
                    // this app makes, so it is the last one that should be
                    // invisible to the Tx page and the failure ledger.
                    if let Err(e) = crate::mcp::tx_retry::sign_with_retry(
                        &app,
                        index,
                        PFP_TYPE_URL,
                        json!({ "playerId": pid, "pfpClientRenderAttributes": attrs }),
                        &format!("pfp:{pid}"),
                    )
                    .await
                    {
                        crate::mcp::telemetry::tlog(
                            "pfp",
                            crate::mcp::telemetry::Sev::Warn,
                            format!("{pid} (idx {index}) restyle failed: {e}"),
                        );
                    }
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

#[cfg(test)]
mod ledger_amount_tests {
    use serde_json::{json, Value};

    /// Mirrors the normalisation in `mcp_inventory_history` so the convention
    /// is pinned by a test rather than by a comment.
    fn base_units(row: &Value, exp: u32) -> (f64, bool) {
        let num = |v: Option<&Value>| -> Option<f64> {
            match v? {
                Value::String(s) => s.parse::<f64>().ok(),
                other => other.as_f64(),
            }
        };
        match num(row.get("amount_p")) {
            Some(p) => (p, true),
            None => (
                num(row.get("amount")).unwrap_or(0.0) * 10f64.powi(exp as i32),
                exp == 0,
            ),
        }
    }

    /// GRASS publishes both, and `amount` is the FLOORED display value —
    /// 98 800 000 base units surface as `amount: 98`. Taking `amount` would
    /// silently discard 800 000.
    #[test]
    fn precise_field_wins_over_the_floored_one() {
        let row = json!({ "denom": "uguild.0-5", "amount": 98, "amount_p": 98_800_000i64 });
        assert_eq!(base_units(&row, 6), (98_800_000.0, true));
    }

    /// The Guild-API ledger ships only the lossy value, so it is scaled back
    /// up and flagged — never presented as exact.
    #[test]
    fn display_only_rows_scale_up_and_are_marked_imprecise() {
        let row = json!({ "denom": "ualpha", "amount": "2" });
        assert_eq!(base_units(&row, 6), (2_000_000.0, false));
    }

    /// This is the bug that shipped: treating the ledger's display `amount`
    /// as base units divided it by 10^6 a second time, so a 2-Alpha credit
    /// rendered as "0".
    #[test]
    fn a_two_alpha_credit_is_never_zero() {
        let row = json!({ "denom": "ualpha", "amount": "2" });
        let (base, _) = base_units(&row, 6);
        assert!(base / 1e6 >= 1.0, "2 Alpha must not round away, got {}", base / 1e6);
    }

    /// Ore has no sub-unit, so a display-only row is already exact.
    #[test]
    fn zero_exponent_denoms_need_no_scaling() {
        let row = json!({ "denom": "ore", "amount": "340" });
        assert_eq!(base_units(&row, 0), (340.0, true));
    }
}

#[cfg(test)]
mod allocation_tests {
    use super::power_change_refusal;

    const KW: f64 = 1_000_000.0;

    /// The live shape: 5.67 kW allocated out of 6.46 kW capacity, load == the
    /// allocation. Raising it into the spare headroom is fine.
    #[test]
    fn raising_within_headroom_is_allowed() {
        assert!(power_change_refusal(6.4 * KW, 5.67 * KW, 6.46 * KW, 5.67 * KW).is_none());
    }

    /// The whole point of the guard: exceeding capacity does not merely fail,
    /// the chain brownouts and DESTROYS the allocations in creation order.
    #[test]
    fn exceeding_capacity_is_refused_with_the_reason() {
        let why = power_change_refusal(7.0 * KW, 5.67 * KW, 6.46 * KW, 5.67 * KW)
            .expect("must refuse");
        assert!(why.contains("DESTROYS"), "the reason must state the stake: {why}");
    }

    /// Exactly at capacity is the boundary and is permitted — the chain
    /// brownouts on load > capacity, not >=.
    #[test]
    fn exactly_at_capacity_is_the_boundary() {
        assert!(power_change_refusal(6.46 * KW, 5.67 * KW, 6.46 * KW, 5.67 * KW).is_none());
        assert!(power_change_refusal(6.47 * KW, 5.67 * KW, 6.46 * KW, 5.67 * KW).is_some());
    }

    /// Load already INCLUDES the allocation, so the delta is what moves it.
    /// Treating `new` as additive would refuse every legal raise.
    #[test]
    fn the_delta_moves_load_not_the_absolute_value() {
        // Lowering always frees headroom, even from a fully committed grid.
        assert!(power_change_refusal(1.0 * KW, 6.46 * KW, 6.46 * KW, 6.46 * KW).is_none());
    }

    /// A second allocation from the same source competes for the same budget.
    #[test]
    fn a_new_allocation_is_measured_from_zero() {
        // 0.79 kW of headroom: 0.5 fits, 1.0 does not.
        assert!(power_change_refusal(0.5 * KW, 0.0, 6.46 * KW, 5.67 * KW).is_none());
        assert!(power_change_refusal(1.0 * KW, 0.0, 6.46 * KW, 5.67 * KW).is_some());
    }

    #[test]
    fn negative_and_nonfinite_are_refused() {
        assert!(power_change_refusal(-1.0, 0.0, 6.46 * KW, 0.0).is_some());
        assert!(power_change_refusal(f64::NAN, 0.0, 6.46 * KW, 0.0).is_some());
    }
}
