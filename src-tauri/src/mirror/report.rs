//! `structs_intel forecast`: the mirror's answer, as text an agent or a
//! player can act on.

use serde_json::Value;

use super::forecast::{CheckState, Forecast, Kind, Options, Status};
use super::Now;

const DEFAULT_LIMIT: usize = 25;

/// Who to forecast for, from the query args.
fn owners(args: &Value) -> Result<Option<Vec<String>>, String> {
    if args.get("all").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(None);
    }
    if let Some(list) = args.get("players").and_then(|v| v.as_array()) {
        let ids: Vec<String> = list.iter().filter_map(|v| v.as_str()).map(String::from).collect();
        if ids.is_empty() {
            return Err("forecast: `players` must be a non-empty list of player ids".into());
        }
        return Ok(Some(ids));
    }
    if args.get("team").and_then(|v| v.as_bool()).unwrap_or(false) {
        let ids: Vec<String> = crate::mcp::virtual_players::collect_targets(true)
            .into_iter()
            .map(|(p, _, _)| p.as_str().to_string())
            .collect();
        return Ok(Some(ids));
    }
    if let Some(p) = args.get("player").and_then(|v| v.as_str()) {
        return Ok(Some(vec![p.to_string()]));
    }
    let me = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone());
    me.map(|p| Some(vec![p])).ok_or_else(|| "forecast: no player synced yet — pass {player} or retry shortly".to_string())
}

fn kind_filter(args: &Value) -> Option<Vec<String>> {
    args.get("kinds").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.to_ascii_lowercase()).collect())
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Build => "build",
        Kind::Mine => "mine",
        Kind::Refine => "refine",
        Kind::Raid => "raid",
        Kind::Charge => "charge",
    }
}

fn eta(blocks: u64) -> String {
    let secs = (blocks as f64 * crate::mcp::auto_raid::BLOCK_SECONDS).round() as u64;
    match secs {
        0..=59 => format!("~{secs}s"),
        60..=3599 => format!("~{}m", secs / 60),
        _ => format!("~{}h{:02}m", secs / 3600, (secs % 3600) / 60),
    }
}

fn line(f: &Forecast) -> String {
    let when = match (f.status, f.ready_height, f.blocks_away) {
        (_, None, _) => "never at this target".to_string(),
        (_, Some(h), Some(0)) => format!("now (since {h})"),
        (_, Some(h), Some(b)) => format!("at {h}, +{b} blocks {}", eta(b)),
        (_, Some(h), None) => format!("at {h}"),
    };
    let tag = match f.status {
        Status::Ready => "READY",
        Status::Waiting => "WAIT",
        Status::Uncertain => "UNSURE",
        Status::Blocked => "BLOCKED",
    };
    let what = match f.kind {
        Kind::Charge => format!("{} reaches {} charge for {}", f.subject, f.range, f.label),
        Kind::Raid => format!("raid on {} (shield {})", f.subject, f.range),
        _ => format!("{} {} ({}), range {}", f.label, f.subject, f.owner, f.range),
    };
    let diff = match (f.kind, f.difficulty_now) {
        (Kind::Charge, _) => String::new(),
        (_, Some(d)) => format!(" · needs {d} zeros now, aim {}", f.target),
        (_, None) => format!(" · anchor {} not yet reached", f.anchor),
    };
    let mut s = format!("  {tag:<7} {:<6} {what} — {when}{diff}", kind_name(f.kind));
    if !f.exact && f.status != Status::Blocked {
        s.push_str(" [estimated]");
    }
    for c in f.checks.iter().filter(|c| c.state != CheckState::Met) {
        let st = if c.state == CheckState::Blocked { "blocked" } else { "unknown" };
        let ex = if c.exact { "" } else { ", estimated" };
        s.push_str(&format!("\n            {st}: {} — {}{ex}", c.rule, c.detail));
    }
    s
}

/// Render a forecast run. Pure, for tests.
pub fn render(now: &Now, limit: usize, kinds: Option<&[String]>) -> String {
    let p = &now.provenance;
    let mut out = format!(
        "Mirror forecast — rules {} · tip {} (a tx signed now executes at ≥ {})\n",
        p.rules, now.tip, now.earliest_execution
    );
    out.push_str(&format!(
        "  world: {} snapshot, pages {}{}, {:.0}s old, {} live events applied{}\n",
        p.source,
        if p.coherent { format!("at {}", p.height) } else { format!("{}–{}", p.min_height, p.height) },
        match (p.pinned, p.coherent) {
            (true, _) => " (pinned: one chain state)",
            (false, true) => "",
            (false, false) => " (straddles blocks)",
        },
        p.age_s,
        p.events_applied,
        if now.tip > p.height { format!(", tip {} blocks past the pages", now.tip - p.height) } else { String::new() },
    ));
    if let Err(why) = crate::mirror::epoch::trusted() {
        out.push_str(&format!("  RULES MISMATCH: {why} — forecasts may be wrong; the pre-sign gate refuses nothing\n"));
    }
    if let Some(v) = &now.verified {
        out.push_str(&format!(
            "  verified: {} facts proven at {} against header {} (light client, anchor {}){}\n",
            v.proven,
            v.height,
            v.header_height,
            match v.anchor {
                crate::mirror::verify::Anchor::Pinned => "pinned",
                crate::mirror::verify::Anchor::FirstUse => "taken on first use",
            },
            if v.failed > 0 { format!(", {} could not be proven", v.failed) } else { String::new() }
        ));
        if v.disagreements.is_empty() {
            out.push_str("  the snapshot agrees with the chain on every proven fact\n");
        } else {
            out.push_str(&format!("  the snapshot disagrees with the chain on {}:\n", v.disagreements.len()));
            for d in v.disagreements.iter().take(10) {
                out.push_str(&format!("    {d}\n"));
            }
        }
    }
    if p.replay_gap > 0 {
        out.push_str(&format!("  continuity: {} live events were dropped during the last refresh — recent changes may be missing\n", p.replay_gap));
    }
    match &now.power {
        Some(n) => {
            out.push_str(&format!("  power: chain's usable capacity read for {} of {} owners", n.read, n.owners));
            if !n.failures.is_empty() {
                out.push_str(&format!(" ({} reads failed: {})", n.failures.len(), n.failures.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
            }
            out.push('\n');
        }
        None => out.push_str("  power: judged on the stored-capacity bound (not read from the chain for this scope)\n"),
    }
    if !now.gate.is_empty() {
        let parts: Vec<String> = now.gate.iter().map(|(r, n)| format!("{r} {n}")).collect();
        out.push_str(&format!("  pre-sign gate since launch: {}\n", parts.join(", ")));
    }
    let shown: Vec<&Forecast> = now
        .forecasts
        .iter()
        .filter(|f| kinds.map_or(true, |k| k.iter().any(|x| x == kind_name(f.kind))))
        .collect();
    let count = |s: Status| shown.iter().filter(|f| f.status == s).count();
    out.push_str(&format!(
        "  {} forecasts: {} ready, {} waiting, {} unsure, {} blocked · {} computed from the fields the chain reads, {} rest on an estimate (as fresh as the world above)\n\n",
        shown.len(),
        count(Status::Ready),
        count(Status::Waiting),
        count(Status::Uncertain),
        count(Status::Blocked),
        shown.iter().filter(|f| f.exact).count(),
        shown.iter().filter(|f| !f.exact).count()
    ));
    if shown.is_empty() {
        out.push_str("  Nothing time-driven in scope.\n");
    }
    for f in shown.iter().take(limit) {
        out.push_str(&line(f));
        out.push('\n');
    }
    if shown.len() > limit {
        out.push_str(&format!("  … {} more (raise `limit`, or narrow with `kinds`/`within`)\n", shown.len() - limit));
    }
    if !now.projections.is_empty() {
        out.push_str(&format!(
            "\nPlanet runs at aim {} (each proof completing the moment it ripens; real runs are later, never earlier; raid pauses not modelled):\n",
            now.projections[0].aim
        ));
        for p in now.projections.iter().take(limit) {
            out.push_str(&projection_line(p, now.earliest_execution));
            out.push('\n');
        }
        if now.projections.len() > limit {
            out.push_str(&format!("  … {} more players\n", now.projections.len() - limit));
        }
    }
    out
}

fn at(h: u64, exec: u64) -> String {
    if h <= exec {
        "now".to_string()
    } else {
        format!("at {h} (+{} {})", h - exec, eta(h - exec))
    }
}

fn projection_line(p: &crate::mirror::project::Projection, exec: u64) -> String {
    let mut s = format!(
        "  {} on {}: {} buried, {} stored → {} mines, {} refines, +{} alpha",
        p.player,
        p.planet,
        p.buried_ore,
        p.stored_ore,
        p.mines,
        p.refines,
        p.ualpha / crate::mirror::transition::UALPHA_PER_REFINE
    );
    if let Some(h) = p.depleted_at {
        s.push_str(&format!("; dry {}", at(h, exec)));
    }
    match (&p.drained_at, &p.stalled) {
        (Some(h), _) => s.push_str(&format!("; explore-ready {}", at(*h, exec))),
        (None, Some(r)) => s.push_str(&format!("; stalls: {} — {}", r.rule, r.detail)),
        (None, None) => s.push_str("; not drained within the projection"),
    }
    s
}

/// `structs_intel {query:"forecast", args}`.
pub async fn intel(client: &crate::mcp::cosmos_client::CosmosClient, args: &Value) -> String {
    let owners = match owners(args) {
        Ok(o) => o,
        Err(e) => return e,
    };
    let target = args
        .get("target")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| crate::mcp::auto_harvest::get().difficulty_threshold);
    let opts = Options {
        target,
        within: args.get("within").and_then(|v| v.as_u64()),
        project: args.get("project").and_then(|v| v.as_bool()).unwrap_or(false),
        verify: args.get("verify").and_then(|v| v.as_bool()).unwrap_or(false),
    };
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|l| l as usize).unwrap_or(DEFAULT_LIMIT);
    let kinds = kind_filter(args);
    match super::forecast_now(Some(client), owners.as_deref(), &opts).await {
        Some(now) => render(&now, limit, kinds.as_deref()),
        None => "forecast: no galaxy snapshot or chain clock yet — the app is still loading; retry shortly".to_string(),
    }
}

/// `structs_intel {query:"backtest", args:{player?|players?|team?, blocks_back?, aim?}}`.
pub async fn backtest_intel(args: &Value) -> String {
    let owners = match owners(args) {
        Ok(Some(o)) => o,
        Ok(None) => return "backtest: give a scope (player, players or team)".into(),
        Err(e) => return e,
    };
    if owners.len() > 20 {
        return format!("backtest: {} players is too many (each is ~6 pinned historical reads); give up to 20", owners.len());
    }
    let back = args.get("blocks_back").and_then(|v| v.as_u64()).unwrap_or(20_000);
    let aim = args.get("aim").and_then(|v| v.as_u64()).unwrap_or_else(|| crate::mcp::auto_harvest::get().difficulty_threshold);
    let types = match crate::game_state::GAME_STATE.read() {
        Ok(gs) => crate::mirror::world::types_from_game_state(&gs),
        Err(_) => return "backtest: game state unavailable".into(),
    };
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let mut out = format!(
        "Backtest — each planet rebuilt from chain reads pinned {back} blocks ago, projected forward, and compared with the ore that actually left the ground since\n"
    );
    for p in owners {
        match crate::mirror::backtest::run(&client, &p, back, aim, types.clone()).await {
            Ok(b) => out.push_str(&format!(
                "  {p} on {}: {} → {} buried, {} mined (aim {} projected {}); mine clock {} → {}: {}\n",
                b.planet,
                b.buried_then,
                b.buried_now,
                b.actual_mines,
                b.aim,
                b.at_aim,
                b.clock_then,
                b.clock_now,
                match b.clock_rule_held {
                    Some(true) => "agrees with the mines",
                    Some(false) => "DISAGREES with the mines — the mirror's clock model is wrong here",
                    None => "a raid touched the planet; not judged",
                }
            )),
            Err(e) => out.push_str(&format!("  {p}: {e}\n")),
        }
    }
    out
}

/// `structs_intel {query:"chronicle", args:{planet_id, blocks_back?, samples?}}`.
pub async fn chronicle_intel(args: &Value) -> String {
    let Some(planet) = args.get("planet_id").and_then(|p| p.as_str()) else {
        return "chronicle: give planet_id".into();
    };
    let back = args.get("blocks_back").and_then(|v| v.as_u64()).unwrap_or(20_000);
    let samples = args.get("samples").and_then(|v| v.as_u64()).unwrap_or(24);
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    match crate::mirror::chronicle::chronicle(&client, planet, back, samples).await {
        Ok((s, lines)) => {
            let mut out = format!(
                "Chronicle of {planet} — {} readings of the chain's own state from {} to {} (about {} blocks apart; changes inside one gap read as one)\n",
                s.len(),
                s.first().map(|x| x.height).unwrap_or(0),
                s.last().map(|x| x.height).unwrap_or(0),
                back / samples.clamp(2, 96).saturating_sub(1).max(1)
            );
            if lines.is_empty() {
                out.push_str("  nothing changed\n");
            }
            for l in lines {
                out.push_str(&format!("  {l}\n"));
            }
            out
        }
        Err(e) => format!("chronicle: {e}"),
    }
}

/// `preview {action:"plan", steps, ask_approval:true}`: preview the plan, and
/// — only when every step would be accepted — put it in front of the human
/// as an approve/reject prompt (the Team Ops window, and a phone through the
/// web board when it is enabled) and wait for the answer. The answer is
/// returned to the agent; carrying the plan out stays with the action tools.
pub async fn plan_approval(app: &tauri::AppHandle, args: &Value) -> String {
    let text = preview_intel(args);
    if text.contains("the chain would refuse it") || !text.starts_with("Plan of") {
        return format!("{text}\nNot sent for approval: the plan as it stands would not go through.");
    }
    let timeout = args.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(600);
    let component = serde_json::json!({
        "kind": "dialogue",
        "title": "Approve this plan?",
        "message": text,
        "buttons": [
            { "label": "Approve", "value": "approve" },
            { "label": "Reject", "value": "reject" },
        ],
    });
    use crate::mcp::ui_bridge::UiOutcome;
    let verdict = match crate::mcp::ui_bridge::show_ui(app, "prompt", component, Some(timeout)).await {
        Ok(UiOutcome::Answered(v)) if v.as_str() == Some("approve") => "APPROVED by the human".to_string(),
        Ok(UiOutcome::Answered(_)) => "REJECTED by the human".to_string(),
        Ok(UiOutcome::Cancelled) => "dismissed by the human without a choice — treat as not approved".to_string(),
        Ok(UiOutcome::TimedOut) => format!("no answer within {timeout} s — not approved"),
        Ok(other) => format!("not shown ({other:?}) — not approved"),
        Err(e) => format!("could not be shown ({e}) — not approved"),
    };
    crate::mcp::telemetry::tlog("mirror", crate::mcp::telemetry::Sev::Notice, format!("plan approval: {verdict}"));
    format!("{text}\nApproval: {verdict}.")
}

/// Render design-lab outcomes. Pure.
pub fn render_lab(outcomes: &[crate::mirror::lab::Outcome]) -> String {
    let mut out = String::from(
        "Design lab — the current world played forward under each rule set (mechanical effect only: players complete each proof the moment it ripens; adaptation not modelled)\n",
    );
    for o in outcomes {
        let alpha = o.ualpha / crate::mirror::transition::UALPHA_PER_REFINE;
        let blocks = |b: Option<u64>| b.map(|b| format!("{b} blocks {}", eta(b))).unwrap_or_else(|| "—".into());
        out.push_str(&format!(
            "  {}: {} players → {} mines, {} refines, +{alpha} alpha; {} explore-ready, median {} / p90 {}{}\n",
            o.scenario.name,
            o.players,
            o.mines,
            o.refines,
            o.drained,
            blocks(o.median_drained_blocks),
            blocks(o.p90_drained_blocks),
            if o.stalled > 0 { format!("; {} runs stall", o.stalled) } else { String::new() }
        ));
    }
    out
}

/// `structs_intel {query:"lab", args:{scenarios?, aim?, player?|players?|team?}}`.
pub fn lab_intel(args: &Value) -> String {
    let owners = match owners(args) {
        Ok(Some(o)) => o,
        Ok(None) => return "lab: give a scope (player, players or team) — a whole-galaxy lab run is not offered".into(),
        Err(e) => return e,
    };
    let aim = args.get("aim").and_then(|v| v.as_u64()).unwrap_or_else(|| crate::mcp::auto_harvest::get().difficulty_threshold);
    let types = match crate::game_state::GAME_STATE.read() {
        Ok(gs) => crate::mirror::world::types_from_game_state(&gs),
        Err(_) => return "lab: game state unavailable".into(),
    };
    let tip = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    let Some(world) = crate::mcp::perception::with_snapshot(|s| crate::mirror::world::World::from_snapshot(s, types, "live", Some(&owners))) else {
        return "lab: no snapshot yet".into();
    };
    let tip = tip.max(world.provenance.as_ref().map(|p| p.height).unwrap_or(0));
    let scenarios: Vec<crate::mirror::lab::Scenario> = match args.get("scenarios") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(s) => s,
            Err(e) => return format!("lab: scenarios do not parse ({e}); each is {{name, aim, mine_range?, refine_range?}}"),
        },
        None => crate::mirror::lab::default_scenarios(&world, aim),
    };
    render_lab(&crate::mirror::lab::run(&world, tip, &owners, &scenarios))
}

/// `structs_intel {query:"preview", args:{action, args}}`; with no action,
/// the mirror's prediction accuracy so far.
pub fn preview_intel(args: &Value) -> String {
    let Some(action) = args.get("action").and_then(|a| a.as_str()) else {
        let acc = crate::mirror::preview::accuracy();
        if acc.is_empty() {
            return "Mirror accuracy: no landed predictions checked yet (each is checked ~150 s after it lands).".into();
        }
        let mut out = String::from("Mirror accuracy (predicted effects vs the chain after landing):\n");
        for (kind, t) in &acc {
            let total = t.effects_matched + t.effects_mismatched;
            let pct = if total > 0 { 100.0 * t.effects_matched as f64 / total as f64 } else { 100.0 };
            out.push_str(&format!(
                "  {kind}: {} checked, {}/{} effects matched ({pct:.1}%), {} refused by the chain after the mirror allowed them\n",
                t.checked, t.effects_matched, total, t.refused_after_allowed
            ));
            for m in t.last_mismatches.iter().rev().take(3) {
                out.push_str(&format!("      {m}\n"));
            }
        }
        return out;
    };
    let empty = Value::Object(Default::default());
    if action == "plan" {
        let Some(steps) = args.get("steps").and_then(|s| s.as_array()) else {
            return "preview plan: give steps:[{action, args}, …]".into();
        };
        let mut moves = Vec::new();
        for (i, st) in steps.iter().enumerate() {
            let a = st.get("action").and_then(|a| a.as_str()).unwrap_or("");
            match crate::mirror::preview::Move::parse(a, st.get("args").unwrap_or(&empty)) {
                Some(m) => moves.push(m),
                None => return format!("preview plan: step {} ('{a}') is not an action the mirror models", i + 1),
            }
        }
        let Some((exec, out)) = crate::mirror::preview::plan_now(&moves) else {
            return "preview plan: no snapshot yet, or a step's struct or fleet is not in it".into();
        };
        let mut s = format!("Plan of {} steps from execution height ≥ {exec} (each step one block after the last):\n", moves.len());
        for (i, st) in out.iter().enumerate() {
            match &st.result {
                Ok(a) => s.push_str(&format!("  {}. {} at {} — {} effects{}\n", i + 1, st.action.kind(), st.height, a.effects.len(), if a.unmodelled.is_empty() { String::new() } else { format!(" (not modelled: {})", a.unmodelled.join("; ")) })),
                Err(r) => s.push_str(&format!("  {}. {} at {} — the chain would refuse it: {} — {}; the plan stops here\n", i + 1, st.action.kind(), st.height, r.rule, r.detail)),
            }
        }
        if out.len() == moves.len() && out.last().is_some_and(|x| x.result.is_ok()) {
            s.push_str("  every step would be accepted, in this order, on the world as it stands\n");
        }
        return s;
    }
    let payload = args.get("args").unwrap_or(&empty);
    let Some(m) = crate::mirror::preview::Move::parse(action, payload) else {
        return format!("preview: '{action}' is not an action the mirror models (mine, refine, build complete, activate, deactivate, struct move, fleet move)");
    };
    let Some(p) = crate::mirror::preview::preview_now(&m) else {
        return "preview: no snapshot yet, or the action's struct or fleet is not in it".into();
    };
    let mut out = format!("Preview of {} at execution height ≥ {}", m.kind(), p.exec);
    if let Some(w) = &p.world {
        out.push_str(&format!(" · world {} {}", w.source, if w.coherent { format!("at {}", w.height) } else { format!("{}–{}", w.min_height, w.height) }));
    }
    out.push('\n');
    match &p.result {
        Ok(a) => {
            out.push_str("  the chain would accept it, with these effects:\n");
            for e in &a.effects {
                out.push_str(&format!("    {}\n", serde_json::to_string(e).unwrap_or_default()));
            }
            if !a.unmodelled.is_empty() {
                out.push_str(&format!("  not modelled: {}\n", a.unmodelled.join("; ")));
            }
        }
        Err(r) => out.push_str(&format!("  the chain would refuse it: {} — {}\n", r.rule, r.detail)),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::forecast::Check;
    use crate::mirror::world::Provenance;

    fn now(forecasts: Vec<Forecast>) -> Now {
        Now {
            provenance: Provenance {
                rules: "structsd v0.22.0",
                height: 100,
                min_height: 98,
                coherent: false,
                pinned: false,
                replay_gap: 0,
                source: "guild".into(),
                age_s: 12.0,
                events_applied: 3,
            },
            tip: 105,
            earliest_execution: 106,
            forecasts,
            power: None,
            gate: vec![("allowed", 3), ("insufficient_charge", 1)],
            projections: vec![],
            verified: None,
        }
    }

    fn mine(status: Status, checks: Vec<Check>) -> Forecast {
        Forecast {
            kind: Kind::Mine,
            subject: "5-1".into(),
            owner: "1-1".into(),
            label: "Ore Extractor".into(),
            planet: Some("2-1".into()),
            anchor: 50,
            range: 28_000,
            target: 4,
            ready_height: Some(200),
            blocks_away: Some(94),
            difficulty_now: Some(30),
            status,
            exact: checks.iter().all(|c| c.exact),
            checks,
        }
    }

    #[test]
    fn the_header_says_what_the_world_is_and_when_a_tx_would_land() {
        let s = render(&now(vec![]), 10, None);
        assert!(s.contains("tip 105 (a tx signed now executes at ≥ 106)"), "{s}");
        assert!(s.contains("pages 98–100 (straddles blocks)"), "{s}");
        assert!(s.contains("tip 5 blocks past the pages"), "{s}");
        assert!(s.contains("pre-sign gate since launch: allowed 3, insufficient_charge 1"), "{s}");
    }

    #[test]
    fn blocked_checks_are_spelled_out_under_their_forecast() {
        let c = Check { rule: "empty", state: CheckState::Blocked, exact: true, detail: "buried ore Some(0)".into() };
        let s = render(&now(vec![mine(Status::Blocked, vec![c])]), 10, None);
        assert!(s.contains("BLOCKED mine"), "{s}");
        assert!(s.contains("blocked: empty — buried ore Some(0)"), "{s}");
        assert!(s.contains("1 blocked"), "{s}");
    }

    #[test]
    fn estimates_are_labelled() {
        let c = Check { rule: "under_raid", state: CheckState::Met, exact: false, detail: "no visiting fleet".into() };
        let s = render(&now(vec![mine(Status::Waiting, vec![c])]), 10, None);
        assert!(s.contains("[estimated]"), "{s}");
        assert!(s.contains("+94 blocks"), "{s}");
    }

    #[test]
    fn kinds_and_limit_narrow_the_list() {
        let s = render(&now(vec![mine(Status::Waiting, vec![]), mine(Status::Waiting, vec![])]), 1, Some(&["mine".into()]));
        assert!(s.contains("… 1 more"), "{s}");
        let none = render(&now(vec![mine(Status::Waiting, vec![])]), 10, Some(&["raid".into()]));
        assert!(none.contains("Nothing time-driven in scope"), "{none}");
    }
}
