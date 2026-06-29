//! `structs_board` — the team operations board. One at-a-glance command view of
//! the whole force for the human AND the agent to share: primary status, the
//! team-wide PoW queue, active threats, and recommended next moves.
//!
//! Returns the board as text (the agent's situational awareness) and writes a
//! self-contained, auto-refreshing HTML file to the app data dir. Pass
//! `open:true` once to pop it out as a real separate OS window (default browser)
//! — it then auto-refreshes every few seconds as later calls rewrite the file,
//! so a loop keeps a live board visible alongside the game without overlapping
//! it. (`push:true` re-enables the older in-app overlay; off by default.)

use rmcp::model::Content;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri_plugin_opener::OpenerExt;

use crate::game_state::GAME_STATE;
use crate::hasher::types::TaskRegistry;

#[derive(Debug, Deserialize)]
pub struct BoardParams {
    /// Pop the board out as a separate OS window (default browser). Do this once;
    /// later calls just rewrite the file and the window auto-refreshes.
    #[serde(default)]
    pub open: bool,
    /// Also render the board as an in-app overlay via structs_ui (off by default —
    /// it can crowd the game view; the separate window is the recommended surface).
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
        recs.push("⚔ Under attack — battle_log to ID the attacker, then structs_strike to counter (or structs_action defend).".into());
    }
    if cap > 0.0 && margin < 15.0 {
        recs.push("⚡ Power margin low — avoid new online structs or free power.".into());
    }
    if waiting > running && waiting > 5 {
        recs.push(format!("⏳ {} PoW tasks waiting on difficulty decay — they complete as they age (PDCs are the long tail).", waiting));
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

    // ── Self-contained HTML board → file (auto-refreshing separate window) ──
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let threat_block = if threats.is_empty() {
        "<div class='ok'>✓ no threats (last 2m)</div>".to_string()
    } else {
        let items: String = threats.iter().take(10).map(|t| format!("<li>{}</li>", esc(t))).collect();
        format!("<div class='warn'>⚠ {} active</div><ul>{}</ul>", threats.len(), items)
    };
    let rec_items: String = recs.iter().map(|r| format!("<li>{}</li>", esc(r))).collect();
    let type_line = if type_summary.is_empty() { String::new() } else { format!(" &nbsp;[{}]", esc(&type_summary.join(", "))) };
    let html = format!(
        "<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='refresh' content='8'>\
<title>Structs — Team Ops</title><style>\
body{{background:#11131a;color:#cfe3ff;font-family:ui-monospace,Menlo,monospace;font-size:14px;margin:0;padding:20px}}\
h1{{font-size:16px;letter-spacing:2px;color:#8fb6ff;margin:0 0 14px}}\
.card{{background:#1a1e28;border:1px solid #2a3142;border-radius:8px;padding:12px 14px;margin:0 0 12px}}\
.k{{color:#7f8aa3}} .big{{font-size:22px;color:#fff}} .ok{{color:#5fd35f}} .warn{{color:#ff6b6b;font-weight:bold}}\
ul{{margin:6px 0 0;padding-left:18px}} li{{margin:3px 0}} .row{{display:flex;gap:24px;flex-wrap:wrap}}\
.foot{{color:#566;font-size:11px;margin-top:8px}}</style></head><body>\
<h1>⚡ STRUCTS · TEAM OPS</h1>\
<div class='card'><div class='row'>\
<div><div class='k'>charge</div><div class='big'>{} {}</div></div>\
<div><div class='k'>power</div><div class='big'>{:.1}/{:.1}W</div><div class='k'>{:.0}% free</div></div>\
<div><div class='k'>structs online</div><div class='big'>{}/{}</div></div>\
<div><div class='k'>ore / alpha</div><div class='big'>{:.0} / {:.0}</div></div>\
<div><div class='k'>virtual players</div><div class='big'>{}</div></div>\
</div></div>\
<div class='card'><div class='k'>PoW queue</div><div class='big'>{}r · {}w · {}d</div>{}</div>\
<div class='card'><div class='k'>threats</div>{}</div>\
<div class='card'><div class='k'>recommended</div><ul>{}</ul></div>\
<div class='foot'>auto-refreshes every 8s · {} {}</div>\
</body></html>",
        charge, if charge_ready { "READY" } else { "…" },
        load, cap, margin, nonline, nstructs, ore, alpha, nvp,
        running, waiting, completed, type_line,
        threat_block, rec_items, esc(&pid), esc(&name)
    );

    let mut opened_note = String::new();
    if let Some(dir) = dirs::data_dir() {
        let path = dir.join("structs-app").join("team-board.html");
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        if std::fs::write(&path, &html).is_ok() {
            if params.open {
                let url = format!("file://{}", path.display());
                match app.opener().open_url(url, None::<&str>) {
                    Ok(_) => opened_note = format!("\nOpened the board in a separate window ({}). It auto-refreshes every 8s — keep calling structs_board (without open) to update it.\n", path.display()),
                    Err(e) => opened_note = format!("\n(couldn't open the window: {} — file is at {})\n", e, path.display()),
                }
            }
        }
    }
    out.push_str(&opened_note);

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
