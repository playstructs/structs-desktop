//! Fleet mass actions — the Team Ops dashboard's "act on many players at
//! once" pipeline: Sweep Alpha, Launch Players, Set Role, Force Scans.
//!
//! Safety model (user chose one-click, no confirm modal):
//! * `require_board` — only the Team Ops window can invoke this command.
//! * **Ambient dry-run** — the UI continuously shows the computed plan ON the
//!   button ("Sweep 14 selected · ~340α"); executing echoes that exact plan
//!   back and each entry is re-validated against the fresh roster before
//!   signing (stale rows are skipped, not re-planned).
//! * One job at a time (`JOB_RUNNING`), every tx through `tx_retry` (ledgered,
//!   sequence-mismatch-only retry), every outcome in the event feed, progress
//!   streamed to the window, roster re-swept afterward.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use crate::hasher::types::now_millis;
use crate::mcp::telemetry::{tlog, Sev};
use crate::mcp::tools::board_pages::require_board;
use crate::mcp::virtual_players::{self, VPlayerRole, VirtualPlayer, REGISTRY};
use crate::mcp::{board_feed, loop_util, roster_cache, tx_retry, vplayer_bridge};

const UALPHA_PER_ALPHA: f64 = 1_000_000.0;
/// Sweep sign fan-out: stay well under the vplayer bridge SIGN_GATE (8) so a
/// sweep never starves the auto-loops of signing slots.
const SWEEP_CONCURRENCY: usize = 4;
/// Launch is signup-bound (~up to 180s per player); two in flight is plenty.
const LAUNCH_CONCURRENCY: usize = 2;

#[derive(Debug, Deserialize)]
pub struct MassActionRequest {
    /// "sweep_alpha" | "launch_players" | "set_role" | "force_scan"
    pub action: String,
    /// "dry_run" | "execute"
    pub mode: String,
    /// Explicit player_id targets (Fleet selection); None = filter-derived.
    #[serde(default)]
    pub players: Option<Vec<String>>,
    #[serde(default)]
    pub args: Value,
    /// sweep_alpha execute: the echoed dry-run plan (what the button showed).
    #[serde(default)]
    pub plan: Option<Vec<PlanEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanEntry {
    pub player_id: String,
    pub index: u32,
    pub name: String,
    /// Stringified integer ualpha — MsgPlayerSend amount format.
    pub amount_ualpha: String,
    pub alpha_before: f64,
}

/// One mass job at a time, fleet-wide.
static JOB_RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn mcp_mass_action(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: MassActionRequest,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_mass_action_impl(app, request).await
}

/// Body of `mcp_mass_action` — native path enters via the require_board
/// wrapper; the token-authenticated web dashboard calls this directly. The
/// JOB_RUNNING single-job gate and all audit/ledger lines live in the per-
/// action fns, shared by both paths.
pub async fn mcp_mass_action_impl(
    app: tauri::AppHandle,
    request: MassActionRequest,
) -> Result<Value, String> {
    match request.action.as_str() {
        "sweep_alpha" => sweep_alpha(app, request).await,
        "launch_players" => launch_players(app, request).await,
        "set_role" => set_role(app, request),
        "force_scan" => force_scan(app, request),
        other => Err(format!(
            "unknown mass action '{other}'. Available: sweep_alpha, launch_players, set_role, force_scan"
        )),
    }
}

// ── Sweep Alpha ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct SweepArgs {
    pub keep_reserve_alpha: f64,
    pub min_send_alpha: f64,
    pub min_charge: u64,
    pub include_bait: bool,
}

fn sweep_args(v: &Value) -> SweepArgs {
    SweepArgs {
        keep_reserve_alpha: v.get("keep_reserve").and_then(|x| x.as_f64()).unwrap_or(0.0),
        min_send_alpha: v.get("min_send").and_then(|x| x.as_f64()).unwrap_or(1.0),
        min_charge: v.get("min_charge").and_then(|x| x.as_u64()).unwrap_or(8),
        include_bait: v.get("include_bait").and_then(|x| x.as_bool()).unwrap_or(false),
    }
}

/// Pure plan builder over roster rows — unit-tested. Returns (entries, skipped).
/// Shared with `auto_sweep`: the loop and the manual button must agree exactly
/// on who is eligible and how much leaves each player.
pub(crate) fn build_sweep_plan(
    rows: &[roster_cache::RosterRow],
    selection: Option<&Vec<String>>,
    a: SweepArgs,
) -> (Vec<PlanEntry>, Vec<Value>) {
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for r in rows {
        // Primary is the DESTINATION, never a source.
        let Some(index) = r.index else { continue };
        if let Some(sel) = selection {
            if !sel.contains(&r.player_id) {
                continue;
            }
        } else if r.role != "productive" && !(a.include_bait && r.role == "bait") {
            continue;
        }
        let mut skip = |reason: &str| {
            skipped.push(json!({ "player_id": r.player_id, "name": r.name, "reason": reason }));
        };
        if r.err.is_some() {
            skip("stale row (last read failed)");
            continue;
        }
        let send_alpha = r.alpha_ualpha / UALPHA_PER_ALPHA - a.keep_reserve_alpha;
        if send_alpha < a.min_send_alpha {
            skip("below reserve/min-send");
            continue;
        }
        if r.charge < a.min_charge {
            skip("low charge");
            continue;
        }
        let amount_ualpha = (send_alpha * UALPHA_PER_ALPHA).floor() as u64;
        entries.push(PlanEntry {
            player_id: r.player_id.clone(),
            index,
            name: r.name.clone(),
            amount_ualpha: amount_ualpha.to_string(),
            alpha_before: r.alpha_ualpha / UALPHA_PER_ALPHA,
        });
    }
    (entries, skipped)
}

pub(crate) fn primary_send_target() -> Result<(String, String), String> {
    let gs = crate::game_state::GAME_STATE
        .read()
        .unwrap_or_else(|e| e.into_inner());
    let addr = gs
        .wallet_address
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or("primary wallet address not synced yet")?;
    let pid = gs.player_id.clone().unwrap_or_default();
    Ok((addr, pid))
}

async fn sweep_alpha(app: tauri::AppHandle, request: MassActionRequest) -> Result<Value, String> {
    let a = sweep_args(&request.args);
    let (to_address, _primary_pid) = primary_send_target()?;
    let rows = roster_cache::all_rows();
    let (entries, skipped) = build_sweep_plan(&rows, request.players.as_ref(), a);
    let total_alpha: f64 = entries
        .iter()
        .map(|e| e.amount_ualpha.parse::<f64>().unwrap_or(0.0) / UALPHA_PER_ALPHA)
        .sum();

    if request.mode == "dry_run" {
        return Ok(json!({
            "mode": "dry_run",
            "entries": entries,
            "total_alpha": total_alpha,
            "skipped": skipped,
            "to_address": to_address,
            "roster_age_ms": now_millis() - roster_cache::refreshed_at_ms(),
            "note": "sending resets each sender's charge",
        }));
    }

    // execute — the plan echo is required: we sign EXACTLY what the UI showed,
    // minus entries the fresh roster no longer supports.
    let plan = request.plan.ok_or(
        "execute requires the dry-run plan (the UI echoes what its button displayed)",
    )?;
    if plan.is_empty() {
        return Err("empty plan — nothing to sweep".into());
    }
    if JOB_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("another mass job is already running".into());
    }
    // Re-validate each echoed entry against the CURRENT roster (5% tolerance):
    // a player that spent/moved alpha since the preview is skipped, not re-planned.
    let mut accepted: Vec<PlanEntry> = Vec::new();
    let mut stale = 0usize;
    for e in plan {
        let ok = roster_cache::get_row(&e.player_id).is_some_and(|r| {
            let amount = e.amount_ualpha.parse::<f64>().unwrap_or(f64::MAX);
            r.err.is_none() && r.alpha_ualpha * 1.05 >= amount + a.keep_reserve_alpha * UALPHA_PER_ALPHA
        });
        if ok {
            accepted.push(e);
        } else {
            stale += 1;
        }
    }
    if accepted.is_empty() {
        JOB_RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("plan is fully stale ({stale} entries) — refresh the roster and retry"));
    }

    let job_id = format!("sweep-{}", now_millis() as u64);
    let total = accepted.len();
    board_feed::push(
        &app,
        board_feed::Severity::Notice,
        "sweep",
        format!("Sweep Alpha started: {} player(s), ~{:.0}α → primary", total, total_alpha),
    );

    let job = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let ok = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));
        let swept = Arc::new(std::sync::Mutex::new(0.0f64));
        let app_c = app.clone();
        let to = to_address.clone();
        let (ok_c, failed_c, done_c, swept_c, job_c) =
            (ok.clone(), failed.clone(), done.clone(), swept.clone(), job.clone());
        loop_util::for_each_player_concurrent(
            accepted,
            SWEEP_CONCURRENCY,
            move |e| {
                let app = app_c.clone();
                let to = to.clone();
                let (ok, failed, done, swept, job) =
                    (ok_c.clone(), failed_c.clone(), done_c.clone(), swept_c.clone(), job_c.clone());
                async move {
                    let payload = json!({
                        "fromAddress": registry_address(e.index),
                        "toAddress": to,
                        "amount": [{ "denom": "ualpha", "amount": e.amount_ualpha }],
                    });
                    let res = tx_retry::sign_with_retry(
                        &app,
                        e.index,
                        "/structs.structs.MsgPlayerSend",
                        payload,
                        &format!("sweep:{}", e.player_id),
                    )
                    .await;
                    match res {
                        Ok(_) => {
                            ok.fetch_add(1, Ordering::Relaxed);
                            let alpha = e.amount_ualpha.parse::<f64>().unwrap_or(0.0) / UALPHA_PER_ALPHA;
                            *swept.lock().unwrap_or_else(|p| p.into_inner()) += alpha;
                        }
                        Err(err) => {
                            failed.fetch_add(1, Ordering::Relaxed);
                            tlog("sweep", Sev::Warn, format!("{} send failed: {err}", e.player_id));
                        }
                    }
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if n % 5 == 0 || n == total {
                        crate::mcp::web_board::emit_board(
                            &app,
                            "board-mass-progress",
                            json!({
                                "job_id": job, "action": "sweep_alpha",
                                "done": n, "ok": ok.load(Ordering::Relaxed),
                                "failed": failed.load(Ordering::Relaxed), "total": total,
                            }),
                        );
                    }
                }
            },
        )
        .await;
        let swept_total = *swept.lock().unwrap_or_else(|p| p.into_inner());
        board_feed::push(
            &app,
            board_feed::Severity::Notice,
            "sweep",
            format!(
                "Sweep Alpha done: {}/{} ok · +{:.0}α to primary{}",
                ok.load(Ordering::Relaxed),
                total,
                swept_total,
                if failed.load(Ordering::Relaxed) > 0 {
                    format!(" · {} failed (see structs_system tx)", failed.load(Ordering::Relaxed))
                } else {
                    String::new()
                }
            ),
        );
        crate::mcp::web_board::emit_board(
            &app,
            "board-mass-done",
            json!({
                "job_id": job, "action": "sweep_alpha",
                "ok": ok.load(Ordering::Relaxed),
                "failed": failed.load(Ordering::Relaxed),
                "total": total, "swept_alpha": swept_total,
            }),
        );
        JOB_RUNNING.store(false, Ordering::SeqCst);
        roster_cache::trigger_sweep(app, 0.0);
    });

    Ok(json!({ "mode": "execute", "job_id": job_id, "accepted": total, "skipped_stale": stale }))
}

fn registry_address(index: u32) -> String {
    REGISTRY
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .players
        .iter()
        .find(|p| p.index == index)
        .map(|p| p.address.clone())
        .unwrap_or_default()
}

// ── Launch Players ───────────────────────────────────────────────────────────

async fn launch_players(app: tauri::AppHandle, request: MassActionRequest) -> Result<Value, String> {
    let count = request.args.get("count").and_then(|v| v.as_u64()).unwrap_or(1).clamp(1, 50) as usize;
    let role = request
        .args
        .get("role")
        .and_then(|v| v.as_str())
        .and_then(VPlayerRole::parse)
        .unwrap_or_default();
    // No `name_prefix` means generated names (`Dave-Thompson`, `ONYX-7734`);
    // an explicit one is the operator's own scheme and opts the batch out of
    // the rename heal entirely.
    let prefix = request
        .args
        .get("name_prefix")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // Substation-dilution estimate — the "what does launching N do to everyone's
    // power share" preview the button shows live as the count changes.
    let guild_id = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.guild_id.clone())
        .unwrap_or(None)
        .filter(|s| !s.is_empty())
        .ok_or("no guild synced yet")?;
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let gp = crate::mcp::guild_power::resolve_guild_power(&client, &guild_id).await?;
    let available = (gp.sub_capacity - gp.sub_load).max(0.0);
    let n_now = gp.sub_connection_count.max(1) as f64;
    let per_conn_now = available / n_now;
    let per_conn_after = available / (n_now + count as f64);
    let min_draw = crate::mcp::guild_power::MIN_PLAYER_DRAW_MW;
    let power_ok = gp.sub_capacity <= 0.0 || per_conn_after >= min_draw;

    if request.mode == "dry_run" {
        return Ok(json!({
            "mode": "dry_run",
            "count": count,
            "role": format!("{:?}", role).to_lowercase(),
            "per_connection_now_mw": per_conn_now,
            "per_connection_after_mw": per_conn_after,
            "supportable_more": gp.supportable_more,
            "min_draw_mw": min_draw,
            "power_ok": power_ok,
            "note": "each signup takes up to ~3 min; new players auto-explore once created",
        }));
    }

    if !power_ok {
        return Err(format!(
            "BLOCKED: launching {} would dilute the substation to {:.2} kW/connection, below the ~{:.1} kW minimum draw",
            count, per_conn_after / 1e6, min_draw / 1e6
        ));
    }
    if JOB_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("another mass job is already running".into());
    }

    // EXPLICIT index pre-allocation: batch creates racing next_free_index was a
    // real incident (duplicate index collisions across concurrent signups).
    let indices: Vec<u32> = {
        let reg = REGISTRY.read().unwrap_or_else(|e| e.into_inner());
        let base = reg.players.iter().map(|p| p.index).max().unwrap_or(0) + 1;
        (base..base + count as u32).collect()
    };

    let job_id = format!("launch-{}", now_millis() as u64);
    let total = indices.len();
    board_feed::push(
        &app,
        board_feed::Severity::Notice,
        "launch",
        format!("Launching {} {:?} player(s) (indices {}..{})…", total, role, indices[0], indices[total - 1]),
    );

    let job = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let ok = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));
        let app_c = app.clone();
        let prefix_c = prefix.clone();
        let (ok_c, failed_c, done_c, job_c) = (ok.clone(), failed.clone(), done.clone(), job.clone());
        loop_util::for_each_player_concurrent(indices, LAUNCH_CONCURRENCY, move |index| {
            let app = app_c.clone();
            let prefix = prefix_c.clone();
            let (ok, failed, done, job) = (ok_c.clone(), failed_c.clone(), done_c.clone(), job_c.clone());
            async move {
                let auto_name = prefix.is_none();
                let name = match &prefix {
                    Some(p) => format!("{p}{index}"),
                    None => crate::mcp::callsign::name_for(index),
                };
                // Façade signup: derive index → sign guild-join → poll player id.
                let result = vplayer_bridge::call(
                    &app,
                    "signup",
                    json!({ "index": index, "name": name }),
                    180,
                )
                .await;
                match result {
                    Ok(data) => {
                        let address = data.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let player_id = data.get("player_id").and_then(|v| v.as_str()).map(String::from);
                        if address.is_empty() {
                            failed.fetch_add(1, Ordering::Relaxed);
                            tlog("launch", Sev::Warn, format!("idx {index}: signup returned no address"));
                        } else {
                            {
                                let mut reg = REGISTRY.write().unwrap_or_else(|e| e.into_inner());
                                reg.players.push(VirtualPlayer {
                                    index,
                                    address,
                                    player_id: player_id.clone(),
                                    name: name.clone(),
                                    created_at: now_millis(),
                                    role,
                                    auto_name,
                                });
                                let _ = reg.save();
                            }
                            // Hand the primary full permissions on the new
                            // player (best-effort; the delegation loop backfills
                            // anything that misses). Started before the explore
                            // rather than after: an explore that fails must not
                            // leave the player unreachable from the primary key.
                            if let Some(pid) = player_id.as_deref() {
                                crate::mcp::delegation::grant_on_create(&app, index, pid);
                            }
                            // Bootstrap explore — a fresh player owns NOTHING
                            // until this lands (no planet/fleet/CmdShip).
                            if let Some(pid) = player_id {
                                let res = tx_retry::sign_with_retry(
                                    &app,
                                    index,
                                    "/structs.structs.MsgPlanetExplore",
                                    json!({ "playerId": pid }),
                                    &format!("launch:{pid}"),
                                )
                                .await;
                                match res {
                                    Ok(_) => {
                                        virtual_players::invalidate_owned(&pid);
                                        ok.fetch_add(1, Ordering::Relaxed);
                                        board_feed::push(
                                            &app,
                                            board_feed::Severity::Info,
                                            "launch",
                                            format!("{name} ({pid}) launched + explored"),
                                        );
                                    }
                                    Err(e) => {
                                        // Created but not bootstrapped — auto loops
                                        // can't manage it until an explore lands.
                                        failed.fetch_add(1, Ordering::Relaxed);
                                        tlog("launch", Sev::Warn, format!("{name} created but explore failed: {e}"));
                                    }
                                }
                            } else {
                                failed.fetch_add(1, Ordering::Relaxed);
                                tlog("launch", Sev::Warn, format!("{name} created; player id pending — explore it manually shortly"));
                            }
                        }
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        tlog("launch", Sev::Warn, format!("idx {index}: signup failed: {e}"));
                    }
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                crate::mcp::web_board::emit_board(
                    &app,
                    "board-mass-progress",
                    json!({
                        "job_id": job, "action": "launch_players",
                        "done": n, "ok": ok.load(Ordering::Relaxed),
                        "failed": failed.load(Ordering::Relaxed), "total": total,
                    }),
                );
            }
        })
        .await;
        board_feed::push(
            &app,
            board_feed::Severity::Notice,
            "launch",
            format!(
                "Launch done: {}/{} player(s) live{}",
                ok.load(Ordering::Relaxed),
                total,
                if failed.load(Ordering::Relaxed) > 0 {
                    format!(" · {} incomplete (see structs_system logs launch)", failed.load(Ordering::Relaxed))
                } else {
                    String::new()
                }
            ),
        );
        crate::mcp::web_board::emit_board(
            &app,
            "board-mass-done",
            json!({
                "job_id": job, "action": "launch_players",
                "ok": ok.load(Ordering::Relaxed),
                "failed": failed.load(Ordering::Relaxed), "total": total,
            }),
        );
        JOB_RUNNING.store(false, Ordering::SeqCst);
        roster_cache::trigger_sweep(app, 0.0);
    });

    Ok(json!({ "mode": "execute", "job_id": job_id, "accepted": total }))
}

// ── Set Role ─────────────────────────────────────────────────────────────────

fn set_role(app: tauri::AppHandle, request: MassActionRequest) -> Result<Value, String> {
    let role = request
        .args
        .get("role")
        .and_then(|v| v.as_str())
        .and_then(VPlayerRole::parse)
        .ok_or("set_role: role must be bait|productive")?;
    let targets = request.players.ok_or("set_role: player selection required")?;
    if request.mode == "dry_run" {
        return Ok(json!({ "mode": "dry_run", "count": targets.len(), "role": format!("{:?}", role).to_lowercase() }));
    }
    let mut changed = 0usize;
    {
        let mut reg = REGISTRY.write().unwrap_or_else(|e| e.into_inner());
        for p in reg.players.iter_mut() {
            if p.player_id.as_deref().map(|id| targets.iter().any(|t| t == id)).unwrap_or(false) {
                p.role = role;
                changed += 1;
            }
        }
        let _ = reg.save();
    }
    board_feed::push(
        &app,
        board_feed::Severity::Notice,
        "config",
        format!("role → {:?} for {} player(s)", role, changed),
    );
    // Roles live in the registry, not on chain — reflect immediately.
    roster_cache::trigger_sweep(app, 0.0);
    Ok(json!({ "ok": true, "changed": changed }))
}

// ── Force Scan ───────────────────────────────────────────────────────────────

fn force_scan(app: tauri::AppHandle, request: MassActionRequest) -> Result<Value, String> {
    let which = request
        .args
        .get("loop")
        .and_then(|v| v.as_str())
        .ok_or("force_scan: which loop? harvest|build|defend|infuse")?
        .to_string();
    if request.mode == "dry_run" {
        return Ok(json!({ "mode": "dry_run", "loop": which }));
    }
    let app_c = app.clone();
    match which.as_str() {
        "harvest" => {
            tauri::async_runtime::spawn(async move { crate::mcp::auto_harvest::tick(&app_c, true).await });
        }
        "build" => {
            tauri::async_runtime::spawn(async move { crate::mcp::auto_build::tick(&app_c, true).await });
        }
        "defend" => {
            tauri::async_runtime::spawn(async move { crate::mcp::auto_defend::tick(&app_c, true).await });
        }
        "infuse" => {
            tauri::async_runtime::spawn(async move { crate::mcp::auto_infuse::tick(&app_c, true).await });
        }
        "response" => {
            tauri::async_runtime::spawn(async move { crate::mcp::auto_response::tick(&app_c, true).await });
        }
        "raid" => {
            tauri::async_runtime::spawn(async move { crate::mcp::auto_raid::tick(&app_c, true).await });
        }
        other => return Err(format!("unknown loop '{other}'")),
    }
    board_feed::push(
        &app,
        board_feed::Severity::Info,
        "config",
        format!("forced {which} scan"),
    );
    Ok(json!({ "ok": true, "loop": which }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: &str, index: Option<u32>, role: &str, alpha_ualpha: f64, charge: u64, err: Option<&str>) -> roster_cache::RosterRow {
        roster_cache::RosterRow {
            index,
            player_id: pid.into(),
            name: format!("p{pid}"),
            role: role.into(),
            planet_id: None,
            fleet_id: None,
            alpha_ualpha,
            ore: 0.0,
            load: 0.0,
            capacity: 0.0,
            structs_load: 0.0,
            charge,
            last_action_block: 0,
            fetched_at_ms: 1.0,
            pfp_attrs: None,
            chain_name: None,
            planet_ore: None,
            mine_eta_s: None,
            refine_eta_s: None,
            err: err.map(String::from),
        }
    }

    fn args(keep: f64, min_send: f64, min_charge: u64, bait: bool) -> SweepArgs {
        SweepArgs { keep_reserve_alpha: keep, min_send_alpha: min_send, min_charge, include_bait: bait }
    }

    #[test]
    fn sweep_plan_filters_and_amounts() {
        let rows = vec![
            row("1-194", None, "primary", 99e6, 8, None),          // primary: never a source
            row("1-300", Some(30), "productive", 5_500_000.0, 9, None), // sends 4.5α after 1α reserve
            row("1-301", Some(31), "productive", 1_200_000.0, 9, None), // below min_send after reserve
            row("1-302", Some(32), "productive", 9e6, 2, None),         // low charge
            row("1-303", Some(33), "bait", 9e6, 9, None),               // bait excluded by default
            row("1-304", Some(34), "productive", 9e6, 9, Some("boom")), // stale row
        ];
        let (entries, skipped) = build_sweep_plan(&rows, None, args(1.0, 1.0, 8, false));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].player_id, "1-300");
        assert_eq!(entries[0].amount_ualpha, "4500000");
        assert_eq!(skipped.len(), 3); // min_send, charge, stale (bait+primary not "skipped", just not sources)
    }

    #[test]
    fn sweep_plan_selection_overrides_role_filter() {
        let rows = vec![
            row("1-303", Some(33), "bait", 9e6, 9, None),
            row("1-305", Some(35), "productive", 9e6, 9, None),
        ];
        let sel = vec!["1-303".to_string()];
        let (entries, _) = build_sweep_plan(&rows, Some(&sel), args(0.0, 1.0, 8, false));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].player_id, "1-303"); // explicit selection wins, even bait
    }

    #[test]
    fn sweep_plan_include_bait_flag() {
        let rows = vec![row("1-303", Some(33), "bait", 9e6, 9, None)];
        let (none, _) = build_sweep_plan(&rows, None, args(0.0, 1.0, 8, false));
        assert!(none.is_empty());
        let (some, _) = build_sweep_plan(&rows, None, args(0.0, 1.0, 8, true));
        assert_eq!(some.len(), 1);
    }
}
