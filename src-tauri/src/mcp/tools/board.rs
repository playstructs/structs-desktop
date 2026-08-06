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
use tauri::{Emitter, Manager};

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

/// Tauri command: the registered virtual players, for the board's map dropdown.
#[tauri::command]
pub fn mcp_vplayer_list() -> Vec<serde_json::Value> {
    let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
    reg.players
        .iter()
        .map(|p| serde_json::json!({ "index": p.index, "name": p.name, "player_id": p.player_id }))
        .collect()
}

#[derive(Debug, Default, Deserialize)]
pub struct BoardParams {
    /// Spawn the native "Team Ops" window (do this once; later calls refresh it live).
    #[serde(default)]
    pub open: bool,
    /// Also render the older in-app overlay via structs_ui (off by default).
    #[serde(default)]
    pub push: bool,
    /// Component directive (absorbed from the retired structs_ui tool). When
    /// present, the call shows this surface to the human instead of rendering
    /// the ops board: "notify" shows-and-returns, "prompt" blocks for their answer.
    #[serde(default)]
    pub component: Option<serde_json::Value>,
    /// notify (default) or prompt — only used with `component`.
    #[serde(default)]
    pub mode: Option<String>,
    /// prompt only: seconds to wait for the human (clamped 10–600).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Web dashboard control: "status" (or `true`) reports state + the
    /// shareable URL; "on"/"off" toggles serving. Opt-in, default off.
    #[serde(default)]
    pub web: Option<serde_json::Value>,
}

pub async fn execute(
    app: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    params: BoardParams,
) -> Vec<Content> {
    // Web-dashboard control path (opt-in, default off).
    if let Some(web) = &params.web {
        let op = match web {
            serde_json::Value::Bool(true) => "status",
            serde_json::Value::String(s) => s.as_str(),
            _ => "status",
        };
        let enabled = match op {
            "on" => {
                let e = crate::mcp::web_board::set_enabled(true);
                crate::mcp::board_feed::push(
                    app,
                    crate::mcp::board_feed::Severity::Notice,
                    "web_board",
                    "web dashboard ENABLED (token-authenticated /board)",
                );
                e
            }
            "off" => {
                let e = crate::mcp::web_board::set_enabled(false);
                crate::mcp::board_feed::push(
                    app,
                    crate::mcp::board_feed::Severity::Notice,
                    "web_board",
                    "web dashboard disabled",
                );
                e
            }
            _ => crate::mcp::web_board::is_enabled(),
        };
        let text = if enabled {
            format!(
                "Web dashboard: ENABLED\n  {}\nOpening the link sets a session cookie and drops the token from the address bar.\n\
                 The server binds 127.0.0.1 only — a REMOTE human reaches it through their own tunnel, e.g.\n  \
                 ssh -L 8420:127.0.0.1:8420 <user>@<this-host>\nthen opens the URL locally. \
                 Disable any time with structs_board {{web:\"off\"}}.",
                crate::mcp::web_board::board_url()
            )
        } else {
            "Web dashboard: disabled (default). Enable with structs_board {web:\"on\"} or in Team Ops · Config — \
             then share the returned URL; the bearer token in it grants FULL operator control to whoever holds it."
                .to_string()
        };
        return vec![Content::text(text)];
    }
    // Component directive path (the former structs_ui tool).
    if let Some(component) = &params.component {
        let mode = params.mode.clone().unwrap_or_else(|| "notify".to_string());
        return show_component(app, &mode, component.clone(), params.timeout_secs).await;
    }
    let render = render_board(registry).await;
    let mut out = render.text;

    // Cache for first-paint, spawn the window on demand, and push a live update.
    if let Ok(mut g) = LAST_BOARD.lock() {
        *g = render.inner_html.clone();
    }
    if params.open && app.get_webview_window("board").is_none() {
        match crate::mcp::board_feed::build_board_window(app) {
            Ok(_) => out.push_str(
                "\nOpened the native Team Ops window — it refreshes on its own (auto every 10s + a Refresh button); no need to loop structs_board.\n",
            ),
            Err(e) => out.push_str(&format!("\n(couldn't open the Team Ops window: {})\n", e)),
        }
    }
    // emit_board targets the board window + web viewers; never the main game
    // window.
    crate::mcp::web_board::emit_board(app, "board-update", serde_json::json!({ "html": render.inner_html }));

    // ── Optional summary push into the Team Ops EVENT FEED ──
    // Team/vplayer info never renders in the MAIN game window; `push` pipes a
    // one-line summary into the board's event feed instead.
    if params.push {
        crate::mcp::board_feed::push(
            app,
            crate::mcp::board_feed::Severity::Notice,
            "board",
            render.push_line,
        );
    }

    vec![Content::text(out)]
}

/// Everything the board needs, computed once: the agent-facing text, the
/// window inner-HTML, and the one-line event-feed summary. Shared by the
/// `structs_board` tool and the window's own `mcp_board_refresh` command so the
/// two renders never drift.
struct BoardRender {
    text: String,
    inner_html: String,
    push_line: String,
}

async fn render_board(registry: &Arc<TaskRegistry>) -> BoardRender {
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

    // ── Guild power infrastructure (reactor + entry substation) ──
    let guild_id_opt = { GAME_STATE.read().unwrap().guild_id.clone() };
    let gpower = if let Some(gid) = guild_id_opt.as_deref().filter(|s| !s.is_empty()) {
        crate::mcp::guild_power::resolve_guild_power(
            &crate::mcp::cosmos_client::CosmosClient::new(),
            gid,
        )
        .await
        .ok()
    } else {
        None
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
        "Primary {} {} — charge {} ({}) · power {}/{} ({:.0}% free) · {}/{} structs online · ore {} alpha {}\n",
        pid, name, charge, if charge_ready { "READY" } else { "charging" },
        crate::mcp::tools::format::format_power(load),
        crate::mcp::tools::format::format_power(cap),
        margin, nonline, nstructs,
        crate::mcp::tools::format::format_ore(ore),
        crate::mcp::tools::format::format_alpha(alpha * 1e6)
    ));
    out.push_str(&format!("Virtual players: {}\n", nvp));
    if let Some(gp) = &gpower {
        out.push_str(&format!(
            "Guild power: reactor fuel {} ({}% comm) · substation {} cap / {} conns / {} each · headroom ~{} more\n",
            crate::mcp::tools::format::format_power(gp.reactor_fuel),
            (gp.reactor_commission * 100.0) as i64,
            crate::mcp::tools::format::format_power(gp.sub_capacity),
            gp.sub_connection_count,
            crate::mcp::tools::format::format_power(gp.sub_connection_capacity),
            gp.supportable_more
        ));
    }
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
            // `format_power` has existed unused since the formatters landed;
            // printing raw milliwatts as "5672579.0 / 5685836.0W" was both
            // wrong by 1000 and unreadable.
            irow("sui-icon-energy", "Power", format!(
                "{} / {} &nbsp;({:.0}% free)",
                crate::mcp::tools::format::format_power(load),
                crate::mcp::tools::format::format_power(cap),
                margin
            )),
            irow("sui-icon-deployed-structs", "Structs online", format!("{} / {}", nonline, nstructs)),
            // Ore and Alpha are QUANTITIES and must carry their units — this
            // card printed both as bare integers, so "7546" could equally have
            // been 7546 μg or 7546 g (it is the latter). `alpha` arrives from
            // the webapp in whole Alpha, i.e. GRAMS, so the ladder — which
            // takes ualpha — needs the 10^6.
            irow("sui-icon-alpha-ore", "Ore", crate::mcp::tools::format::format_ore(ore)),
            irow("sui-icon-alpha-matter", "Alpha", crate::mcp::tools::format::format_alpha(alpha * 1e6)),
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

    let guild_card = if let Some(gp) = &gpower {
        // Was hard-wired to kW, which printed a 15.5 MW substation as
        // "15515.70 kW" — five digits where the ladder gives two. Same
        // formatter as every other power figure on the board.
        let m = |w: f64| crate::mcp::tools::format::format_power(w);
        card(
            "GUILD POWER",
            format!(
                "{}{}{}{}{}",
                irow(
                    "sui-icon-energy",
                    "Reactor fuel",
                    format!("{} &nbsp;({}% commission)", m(gp.reactor_fuel), (gp.reactor_commission * 100.0) as i64)
                ),
                irow("", "Substation capacity", format!("{} &nbsp;· {} connections", m(gp.sub_capacity), gp.sub_connection_count)),
                irow("", "Per-connection", format!("{} &nbsp;(&rarr; {} with 1 more)", m(gp.sub_connection_capacity), m(gp.share_if_one_more))),
                irow("", "Substation load", m(gp.sub_load)),
                irow(
                    if gp.supportable_more > 0 { "icon-success" } else { "icon-alert" },
                    "Growth headroom",
                    format!("~{} more players", gp.supportable_more)
                ),
            ),
        )
    } else {
        String::new()
    };

    let inner = format!(
        "{}{}{}{}{}<div class='ops-title'>{} {} · live</div>",
        status_card, guild_card, pow_card, threats_card, rec_card, esc(&pid), esc(&name)
    );

    // `load`/`cap` are MILLIWATTS. Printing them with a bare "W" suffix was the
    // exact off-by-1000 the status card had fixed and this line still carried,
    // so the feed summary read "15407370.0/15467472.0W".
    let push_line = format!(
        "charge {} · {}/{} · {}/{} online · {} vp · PoW {}r/{}w · {}",
        charge,
        crate::mcp::tools::format::format_power(load),
        crate::mcp::tools::format::format_power(cap),
        nonline, nstructs, nvp, running, waiting,
        if threats.is_empty() { "no threats".to_string() } else { format!("⚠ {} threats", threats.len()) }
    );

    BoardRender { text: out, inner_html: inner, push_line }
}

/// Tauri command: the board window's OWN refresh. Recomputes the board and
/// returns the fresh inner-HTML so the window stays live on a timer + a Refresh
/// button, WITHOUT an agent looping structs_board. That gap left the header
/// frozen at the "waiting for first update" placeholder while only the
/// independently-pushed event feed moved. Also re-caches LAST_BOARD and emits
/// board-update so first-paint and any other listeners stay in sync.
#[tauri::command]
pub async fn mcp_board_refresh(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<TaskRegistry>>,
) -> Result<String, String> {
    mcp_board_refresh_impl(&app, registry.inner()).await
}

/// Body of `mcp_board_refresh`, callable without Tauri state (web dashboard).
pub async fn mcp_board_refresh_impl(
    app: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
) -> Result<String, String> {
    let render = render_board(registry).await;
    if let Ok(mut g) = LAST_BOARD.lock() {
        *g = render.inner_html.clone();
    }
    crate::mcp::web_board::emit_board(app, "board-update", serde_json::json!({ "html": render.inner_html }));
    Ok(render.inner_html)
}

// ══════════════════════════════════════════════════════════════════════════
// Human-facing component directives — absorbed from the retired `structs_ui`
// tool. `structs_board {component:{kind:...}, mode:"notify"|"prompt"}` sends a
// declarative spec to the webview renderer via `ui_bridge`; `notify`
// shows-and-returns, `prompt` blocks until the human answers.
// ══════════════════════════════════════════════════════════════════════════

/// Component kinds the frontend renderer understands.
const KNOWN_KINDS: &[&str] = &[
    "open_menu", "panel", "menu", "dialogue", "info", "map_preview", "hud_badge", "toast",
    "raw_html", "dismiss",
];

/// Validate a directive spec. Returns the resolved `kind` on success, or a
/// human-readable error. Pure (no I/O) so it is unit-testable.
fn validate_component(mode: &str, component: &serde_json::Value) -> Result<String, String> {
    let kind = component
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "component must be an object with a string `kind` (one of: {}).",
                KNOWN_KINDS.join(", ")
            )
        })?;
    if !KNOWN_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "unknown component kind '{}'. Known kinds: {}.",
            kind,
            KNOWN_KINDS.join(", ")
        ));
    }
    if mode.eq_ignore_ascii_case("prompt")
        && matches!(kind.as_str(), "toast" | "hud_badge" | "map_preview" | "dismiss")
    {
        return Err(format!(
            "kind '{}' is display-only and cannot be used in prompt mode. Use mode 'notify', or a prompt-capable kind (menu, dialogue, panel).",
            kind
        ));
    }
    Ok(kind)
}

async fn show_component(
    app_handle: &tauri::AppHandle,
    mode: &str,
    component: serde_json::Value,
    timeout_secs: Option<u64>,
) -> Vec<Content> {
    use crate::mcp::ui_bridge::{self, UiOutcome};
    let kind = match validate_component(mode, &component) {
        Ok(k) => k,
        Err(e) => return vec![Content::text(format!("Error: {}", e))],
    };

    match ui_bridge::show_ui(app_handle, mode, component, timeout_secs).await {
        Ok(UiOutcome::Shown) => vec![Content::text(format!(
            "Shown to the human ({} surface). Display-only — returns no input.",
            kind
        ))],
        Ok(UiOutcome::Answered(value)) => vec![Content::text(format!(
            "Human responded: {}",
            serde_json::to_string(&value).unwrap_or_else(|_| "<unserializable>".to_string())
        ))],
        Ok(UiOutcome::Cancelled) => {
            vec![Content::text("Human dismissed the prompt without choosing (cancelled).".to_string())]
        }
        Ok(UiOutcome::TimedOut) => vec![Content::text(
            "Prompt timed out — the human did not respond in time. Proceed without their input or try again.".to_string(),
        )],
        Ok(UiOutcome::Disabled) => vec![Content::text(
            "Agent UI is disabled by the human (agent_ui policy is off). Directive dropped. Re-enable with structs_policy set agent_ui true.".to_string(),
        )],
        Ok(UiOutcome::RateLimited) => vec![Content::text(
            "Rate limit exceeded — too many UI directives in a short window. Slow down and retry.".to_string(),
        )],
        Err(e) => vec![Content::text(format!("Error showing UI: {}", e))],
    }
}

#[cfg(test)]
mod component_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_kinds_pass() {
        assert_eq!(validate_component("notify", &json!({"kind":"toast"})).unwrap(), "toast");
        assert_eq!(validate_component("prompt", &json!({"kind":"menu"})).unwrap(), "menu");
        assert_eq!(validate_component("prompt", &json!({"kind":"dialogue"})).unwrap(), "dialogue");
    }

    #[test]
    fn missing_kind_errors() {
        assert!(validate_component("notify", &json!({"title":"x"})).is_err());
    }

    #[test]
    fn unknown_kind_errors() {
        let e = validate_component("notify", &json!({"kind":"hologram"})).unwrap_err();
        assert!(e.contains("unknown component kind"));
    }

    #[test]
    fn display_only_kinds_rejected_in_prompt_mode() {
        for k in ["toast", "hud_badge", "map_preview", "dismiss"] {
            let e = validate_component("prompt", &json!({"kind": k})).unwrap_err();
            assert!(e.contains("display-only"), "{} should be display-only", k);
        }
        // …but allowed in notify mode
        assert!(validate_component("notify", &json!({"kind":"hud_badge"})).is_ok());
    }
}
