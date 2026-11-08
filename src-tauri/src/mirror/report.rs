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
