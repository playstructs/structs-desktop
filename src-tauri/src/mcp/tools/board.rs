//! `structs_board` — the team operations board. One at-a-glance command view of
//! the whole force for the human AND the agent to share: primary status, the
//! team-wide PoW queue, active threats, and recommended next moves.
//!
//! Returns the board as text (the agent's situational awareness) and drives a
//! native, app-owned **second window** ("Team Ops"). Pass `open:true` once to
//! spawn that window; every call (looped) pushes a live `board-update` event so
//! it refreshes in place — no browser, no file polling. The window's page
//! (`frontend/board.html`) pulls the latest via the `mcp_board_html` command on
//! load, so it paints immediately too.

use rmcp::model::Content;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::game_state::GAME_STATE;
use crate::hasher::types::TaskRegistry;

/// Last-rendered board inner-HTML, so the board window can paint on load (before
/// the next push) via the `mcp_board_html` command.
pub static LAST_BOARD: LazyLock<Mutex<String>> =
    LazyLock::new(|| Mutex::new("<div class='k'>Waiting for the first board update…</div>".to_string()));

/// Tauri command the board window invokes on load to fetch the current board.
#[tauri::command]
pub fn mcp_board_html() -> String {
    LAST_BOARD.lock().map(|g| g.clone()).unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct BoardParams {
    /// Spawn the native "Team Ops" window (do this once; later calls refresh it live).
    #[serde(default)]
    pub open: bool,
    /// Also render the older in-app overlay via structs_ui (off by default).
    #[serde(default)]
    pub push: bool,
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
    let charge_ready = charge >= 8;

    // ── Team PoW queue ──
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

    // ── Threats across the team (last ~2 min) ──
    let now = crate::hasher::types::now_millis();
    let (_, threats) = crate::mcp::tools::events::poll_team_threats(now - 120_000.0).await;

    let nvp = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
        reg.players.len()
    };

    let margin = if cap > 0.0 { (1.0 - load / cap) * 100.0 } else { 0.0 };

    // ── Recommendations ──
    let mut recs: Vec<String> = Vec::new();
    if !threats.is_empty() {
        recs.push("Under attack — battle_log to ID the attacker, then structs_strike to counter (or structs_action defend).".into());
    }
    if cap > 0.0 && margin < 15.0 {
        recs.push("Power margin low — avoid new online structs or free power.".into());
    }
    if waiting > running && waiting > 5 {
        recs.push(format!("{} PoW tasks waiting on difficulty decay — they complete as they age (PDCs are the long tail).", waiting));
    }
    if charge_ready && threats.is_empty() {
        recs.push("Charge ready & quiet — mine/build/refine, or advance a kill-chain (structs_strike).".into());
    }
    if recs.is_empty() {
        recs.push("Hold — nothing urgent; bait is watching and grinding.".into());
    }

    // ── Text board (agent) ──
    let mut out = String::new();
    out.push_str("══ TEAM OPS BOARD ══\n");
    out.push_str(&format!(
        "Primary {} {} — charge {} ({}) · power {:.1}/{:.1}W ({:.0}% free) · {}/{} structs online · ore {:.0} alpha {:.0}\n",
        pid, name, charge, if charge_ready { "READY" } else { "charging" }, load, cap, margin, nonline, nstructs, ore, alpha
    ));
    out.push_str(&format!("Virtual players: {}\n", nvp));
    out.push_str(&format!(
        "PoW queue: {} running · {} waiting · {} done{}\n",
        running, waiting, completed,
        if type_summary.is_empty() { String::new() } else { format!("  [{}]", type_summary.join(", ")) }
    ));
    if threats.is_empty() {
        out.push_str("Threats: ✓ none (last 2m)\n");
    } else {
        out.push_str(&format!("Threats: ⚠ {} active —\n", threats.len()));
        for t in threats.iter().take(8) {
            out.push_str(&format!("   {}\n", t));
        }
    }
    out.push_str("Recommended:\n");
    for r in &recs {
        out.push_str(&format!("   • {}\n", r));
    }

    // ── Inner HTML for the window, using genuine SUI components so it matches
    //    the game (board.html links the real sui.css + a sui-theme-player wrapper).
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    // Drop any leading non-ASCII (emoji prefix from threat labels) — the board
    // uses real SUI icons instead, never emoji.
    let strip_emoji = |s: &str| -> String {
        s.trim_start().trim_start_matches(|c: char| !c.is_ascii()).trim_start().to_string()
    };
    // A label↔value row inside a sui-data-card, with an optional real SUI icon.
    // `icon` is a sui-icon-* or icon-* class from sui.css (empty = no icon).
    let irow = |icon: &str, label: &str, value: String| {
        let ic = if icon.is_empty() {
            String::new()
        } else {
            format!("<i class='sui-icon {} sui-icon-sm'></i> ", icon)
        };
        format!(
            "<div class='sui-data-card-row'><span>{}{}</span><span class='ops-val'>{}</span></div>",
            ic, label, value
        )
    };
    let card = |title: &str, body: String| {
        format!(
            "<div class='sui-data-card sui-theme-player'><div class='sui-data-card-header'>{}</div>\
<div class='sui-data-card-body sui-mod-spacing-xl'>{}</div></div>",
            title, body
        )
    };

    let charge_badge = format!(
        "<span class='sui-badge'>{} {}</span>",
        charge,
        if charge_ready { "READY" } else { "charging" }
    );
    let status_card = card(
        "PRIMARY",
        format!(
            "{}{}{}{}{}{}",
            irow("", "Charge", charge_badge),
            irow("sui-icon-energy", "Power", format!("{:.1} / {:.1}W &nbsp;({:.0}% free)", load, cap, margin)),
            irow("sui-icon-deployed-structs", "Structs online", format!("{} / {}", nonline, nstructs)),
            irow("sui-icon-alpha-ore", "Ore", format!("{:.0}", ore)),
            irow("sui-icon-alpha-matter", "Alpha", format!("{:.0}", alpha)),
            irow("sui-icon-players", "Virtual players", format!("{}", nvp)),
        ),
    );

    let pow_extra = if type_summary.is_empty() {
        String::new()
    } else {
        irow("", "Types", esc(&type_summary.join(", ")))
    };
    let pow_card = card(
        "PoW QUEUE",
        format!(
            "{}{}",
            irow("icon-in-progress", "Running / Waiting / Done", format!("{} / {} / {}", running, waiting, completed)),
            pow_extra
        ),
    );

    let threats_body = if threats.is_empty() {
        "<div class='sui-data-card-row'><span><i class='sui-icon icon-success sui-icon-sm sui-text-primary'></i> no threats (last 2m)</span></div>".to_string()
    } else {
        let items: String = threats
            .iter()
            .take(10)
            .map(|t| format!(
                "<div class='sui-message-inline-alert'><i class='sui-icon sui-icon-attacker sui-icon-sm sui-text-destructive'></i> <span class='sui-message-inline-alert-text'>{}</span></div>",
                esc(&strip_emoji(t))
            ))
            .collect();
        format!(
            "<div class='sui-data-card-row'><span><i class='sui-icon icon-alert sui-icon-sm sui-text-destructive'></i> {} active</span></div>{}",
            threats.len(),
            items
        )
    };
    let threats_card = card("THREATS", threats_body);

    let rec_items: String = recs.iter().map(|r| format!("<li>{}</li>", esc(r))).collect();
    let rec_card = card("RECOMMENDED", format!("<ul class='ops-list'>{}</ul>", rec_items));

    let inner = format!(
        "{}{}{}{}<div class='ops-title'>{} {} · updates live</div>",
        status_card, pow_card, threats_card, rec_card, esc(&pid), esc(&name)
    );

    // Cache for first-paint, spawn the window on demand, and push a live update.
    if let Ok(mut g) = LAST_BOARD.lock() {
        *g = inner.clone();
    }
    if params.open && app.get_webview_window("board").is_none() {
        match WebviewWindowBuilder::new(app, "board", WebviewUrl::App("board.html".into()))
            .title("Structs — Team Ops")
            .inner_size(460.0, 740.0)
            .build()
        {
            Ok(_) => out.push_str("\nOpened the native Team Ops window — it refreshes live as you loop structs_board.\n"),
            Err(e) => out.push_str(&format!("\n(couldn't open the Team Ops window: {})\n", e)),
        }
    }
    if let Some(w) = app.get_webview_window("board") {
        let _ = w.emit("board-update", serde_json::json!({ "html": inner }));
    }

    // ── Optional in-app overlay (off by default) ──
    if params.push {
        let comp = serde_json::json!({
            "kind": "raw_html",
            "title": "⚡ Team Ops Board",
            "html": format!("<div style='font-family:monospace;font-size:12px'>charge {} · {:.1}/{:.1}W · {}/{} online · {} vp · PoW {}r/{}w · {}</div>",
                charge, load, cap, nonline, nstructs, nvp, running, waiting,
                if threats.is_empty() { "no threats".to_string() } else { format!("⚠ {} threats", threats.len()) })
        });
        let _ = crate::mcp::ui_bridge::show_ui(app, "notify", comp, None).await;
    }

    vec![Content::text(out)]
}
