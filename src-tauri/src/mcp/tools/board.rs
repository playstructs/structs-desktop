//! `structs_board` — the team operations board. One at-a-glance command view of
//! the whole force for the human AND the agent to share: primary status, the
//! team-wide PoW queue, active threats, and recommended next moves. Returns the
//! board as text (the agent's situational awareness) and, by default, pushes a
//! compact version to the human's screen via structs_ui — so both teammates work
//! from one picture instead of each reconstructing it.

use rmcp::model::Content;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

use crate::game_state::GAME_STATE;
use crate::hasher::types::TaskRegistry;

#[derive(Debug, Deserialize)]
pub struct BoardParams {
    /// Also push the board to the human's screen via structs_ui (default true).
    #[serde(default = "default_true")]
    pub push: bool,
}
fn default_true() -> bool {
    true
}

pub async fn execute(
    app: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    params: BoardParams,
) -> Vec<Content> {
    // ── Primary player status ──
    let (charge, load, cap, ore, alpha, nstructs, nonline, pid, name) = {
        let gs = GAME_STATE.read().unwrap();
        let online = gs
            .structs
            .values()
            .filter(|s| s.status & 4 != 0 && s.status & 32 == 0)
            .count();
        (
            gs.get_charge(),
            gs.total_load(),
            gs.total_capacity(),
            gs.ore.unwrap_or(0.0),
            gs.alpha.unwrap_or(0.0),
            gs.structs.len(),
            online,
            gs.player_id.clone().unwrap_or_else(|| "?".into()),
            gs.player_name.clone().unwrap_or_default(),
        )
    };
    let charge_ready = charge >= 8; // cheapest charge-gated actions

    // ── Team PoW queue (all hash tasks across primary + virtual players) ──
    let mut running = 0usize;
    let mut waiting = 0usize;
    let mut completed = 0usize;
    let mut by_type: HashMap<String, usize> = HashMap::new();
    for entry in registry.tasks.iter() {
        let s = entry.value().snapshot();
        match s.status.as_str() {
            "running" => running += 1,
            "waiting" | "starting" => waiting += 1,
            "completed" => completed += 1,
            _ => {}
        }
        if let Some(t) = &s.task_type {
            *by_type.entry(t.clone()).or_insert(0) += 1;
        }
    }
    let mut type_summary: Vec<String> = by_type.iter().map(|(t, n)| format!("{}×{}", n, t)).collect();
    type_summary.sort();

    // ── Threats across the whole team (last ~2 min) ──
    let now = crate::hasher::types::now_millis();
    let (_, threats) = crate::mcp::tools::events::poll_team_threats(now - 120_000.0).await;

    // ── Virtual player count ──
    let nvp = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
        reg.players.len()
    };

    // ── Compose the board ──
    let margin = if cap > 0.0 { (1.0 - load / cap) * 100.0 } else { 0.0 };
    let mut out = String::new();
    out.push_str("══ TEAM OPS BOARD ══\n");
    out.push_str(&format!(
        "Primary {} {} — charge {} ({}) · power {:.1}/{:.1}W ({:.0}% free) · {}/{} structs online · ore {:.0} alpha {:.0}\n",
        pid,
        name,
        charge,
        if charge_ready { "READY" } else { "charging" },
        load / 1_000_000.0,
        cap / 1_000_000.0,
        margin,
        nonline,
        nstructs,
        ore,
        alpha
    ));
    out.push_str(&format!("Virtual players: {}\n", nvp));
    out.push_str(&format!(
        "PoW queue: {} running · {} waiting · {} done{}\n",
        running,
        waiting,
        completed,
        if type_summary.is_empty() { String::new() } else { format!("  [{}]", type_summary.join(", ")) }
    ));

    // ── Threats ──
    if threats.is_empty() {
        out.push_str("Threats: ✓ none (last 2m)\n");
    } else {
        out.push_str(&format!("Threats: ⚠ {} active —\n", threats.len()));
        for t in threats.iter().take(8) {
            out.push_str(&format!("   {}\n", t));
        }
    }

    // ── Recommendations ──
    out.push_str("Recommended:\n");
    let mut recs: Vec<String> = Vec::new();
    if !threats.is_empty() {
        recs.push("⚔ Under attack — structs_intel battle_log to find the attacker, then structs_strike to counter (or structs_action defend).".into());
    }
    if cap > 0.0 && margin < 15.0 {
        recs.push("⚡ Power margin low — avoid new online structs or free power (deactivate non-essential).".into());
    }
    if waiting > running && waiting > 5 {
        recs.push(format!("⏳ {} PoW tasks waiting on difficulty decay — they'll complete as they age; the heavy ones (PDC) are the long tail.", waiting));
    }
    if charge_ready && threats.is_empty() {
        recs.push("Charge ready & quiet — good window to mine/build/refine, or advance an offensive kill-chain (structs_strike).".into());
    }
    if recs.is_empty() {
        recs.push("Hold — nothing urgent; bait is watching and grinding.".into());
    }
    for r in &recs {
        out.push_str(&format!("   • {}\n", r));
    }

    // ── Push a compact board to the human's screen ──
    if params.push {
        let threat_html = if threats.is_empty() {
            "<div style='color:#5fd35f'>✓ no threats</div>".to_string()
        } else {
            format!("<div style='color:#ff6b6b'>⚠ {} threat(s)</div>", threats.len())
        };
        let html = format!(
            "<div style='font-family:monospace;font-size:12px;line-height:1.5'>\
             <b>TEAM OPS</b><br>\
             charge {} ({}) · power {:.1}/{:.1}W · {}/{} online<br>\
             {} virtual players · PoW {}r/{}w/{}d<br>{}</div>",
            charge,
            if charge_ready { "READY" } else { "charging" },
            load / 1_000_000.0,
            cap / 1_000_000.0,
            nonline,
            nstructs,
            nvp,
            running,
            waiting,
            completed,
            threat_html
        );
        let comp = serde_json::json!({
            "kind": "raw_html",
            "title": "⚡ Team Ops Board",
            "html": html
        });
        let _ = crate::mcp::ui_bridge::show_ui(app, "notify", comp, None).await;
    }

    vec![Content::text(out)]
}
