//! `structs_events` — the event feed. Exposes the NATS-fed event buffer to the
//! agent so it can react to incoming attacks / arrivals / completions instead of
//! babysitting with sleep timers. rmcp 0.15 has no server push, so a `wait_secs`
//! long-poll approximates a live feed: the call blocks until a new event lands
//! (after the `since` cursor) or the wait elapses.

use rmcp::model::Content;
use serde::Deserialize;
use std::time::Duration;

use crate::game_state::GAME_STATE;
use crate::mcp::event_buffer::{self, GameEvent};

#[derive(Debug, Deserialize)]
pub struct EventParams {
    /// Only return events strictly newer than this timestamp (ms). Use the
    /// `next_cursor` from the previous call to page forward.
    #[serde(default)]
    pub since: Option<f64>,
    /// Filter to a single category (e.g. "struct_attack", "raid_status").
    #[serde(default)]
    pub category: Option<String>,
    /// Only events whose subject references one of your entities (player/planet/fleet).
    #[serde(default)]
    pub mine_only: bool,
    /// Max events to return (default 30).
    #[serde(default)]
    pub limit: Option<usize>,
    /// Long-poll: wait up to this many seconds for a new event before returning
    /// (clamped 0–55). 0 = return immediately with whatever's buffered.
    #[serde(default)]
    pub wait_secs: Option<u64>,
}

pub async fn execute(params: EventParams) -> Vec<Content> {
    let since = params.since.unwrap_or(0.0);
    let limit = params.limit.unwrap_or(30);
    let wait = params.wait_secs.unwrap_or(0).min(55);

    // My entity ids for mine_only filtering: player/planet/fleet AND my struct ids
    // (combat surfaces as `struct_health`/`struct_status` keyed by struct_id in the
    // detail, often on another player's planet subject — so subject-only matching
    // misses my structs taking damage).
    let mine: Vec<String> = if params.mine_only {
        let gs = GAME_STATE.read().unwrap();
        let mut ids: Vec<String> = [gs.player_id.clone(), gs.planet_id.clone(), gs.fleet_id.clone()]
            .into_iter()
            .flatten()
            .collect();
        ids.extend(gs.structs.keys().cloned());
        ids
    } else {
        vec![]
    };

    // Poll the buffer until something new arrives or the wait elapses.
    let deadline_polls = (wait).max(0);
    let mut polled = 0u64;
    let fresh = loop {
        let recent = event_buffer::get_recent(200, params.category.as_deref(), None);
        let fresh: Vec<GameEvent> = recent
            .into_iter()
            .filter(|e| e.timestamp > since)
            .filter(|e| {
                if mine.is_empty() {
                    return true;
                }
                // Match my ids in the subject OR the detail (combat events carry
                // the struct_id in detail, with the planet — often enemy — as subject).
                let detail_str = e.detail.to_string();
                mine.iter()
                    .any(|id| e.subject.contains(id.as_str()) || detail_str.contains(id.as_str()))
            })
            .collect();
        if !fresh.is_empty() || polled >= deadline_polls {
            break fresh;
        }
        polled += 1;
        tokio::time::sleep(Duration::from_secs(1)).await;
    };

    let shown: Vec<&GameEvent> = fresh.iter().rev().take(limit).collect();
    let next_cursor = fresh.iter().map(|e| e.timestamp).fold(since, f64::max);

    let mut out = String::new();
    if shown.is_empty() {
        out.push_str(&format!(
            "No new events{}{}. (cursor {})\n",
            params.category.as_ref().map(|c| format!(" in '{}'", c)).unwrap_or_default(),
            if params.mine_only { " for you" } else { "" },
            next_cursor
        ));
    } else {
        out.push_str(&format!("{} new event(s):\n", shown.len()));
        for e in shown.iter().rev() {
            out.push_str(&format!("  [{}] {} — {}", e.timestamp, e.category, e.subject));
            let d = serde_json::to_string(&e.detail).unwrap_or_default();
            if d.len() > 2 {
                let snip: String = d.chars().take(160).collect();
                out.push_str(&format!("  {}", snip));
            }
            out.push('\n');
        }
        out.push_str(&format!("\nnext_cursor: {} (pass as 'since' to page forward)\n", next_cursor));
    }
    vec![Content::text(out)]
}
