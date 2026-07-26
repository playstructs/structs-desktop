use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::RwLock;

/// Ring capacity. The stream is the main way an operator watches the world,
/// and 1000 was under ten minutes of scrollback on a busy guild — raised so
/// the pop-out window is worth leaving open. Each event is a few hundred
/// bytes of JSON, so this is single-digit MB.
const MAX_EVENTS: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameEvent {
    pub category: String,
    pub subject: String,
    pub detail: serde_json::Value,
    pub timestamp: f64,
}

pub static EVENT_BUFFER: std::sync::LazyLock<RwLock<VecDeque<GameEvent>>> =
    std::sync::LazyLock::new(|| RwLock::new(VecDeque::with_capacity(MAX_EVENTS)));

pub fn push_event(event: GameEvent) {
    let mut buffer = EVENT_BUFFER.write().unwrap();
    if buffer.len() >= MAX_EVENTS {
        buffer.pop_front();
    }
    buffer.push_back(event);
}

pub fn get_recent(count: usize, category: Option<&str>, subject_contains: Option<&str>) -> Vec<GameEvent> {
    let buffer = EVENT_BUFFER.read().unwrap();
    buffer
        .iter()
        .rev()
        .filter(|e| {
            if let Some(cat) = category {
                if e.category != cat {
                    return false;
                }
            }
            if let Some(sub) = subject_contains {
                if !e.subject.contains(sub) {
                    return false;
                }
            }
            true
        })
        .take(count)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub fn get_categories() -> Vec<String> {
    let buffer = EVENT_BUFFER.read().unwrap();
    let mut cats: Vec<String> = buffer
        .iter()
        .map(|e| e.category.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    cats.sort();
    cats
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn push_game_event(app: tauri::AppHandle, event: GameEvent) -> Result<(), String> {
    // `block` ticks (~every 6s) are RELAY-ONLY: buffered they'd drown the
    // 1000-entry ring (and every policy/threat scan over it) within the hour,
    // but the GRASS page wants the heartbeat.
    if event.category != "block" {
        push_event(event.clone());
    }
    // Queue background name lookups for any ids this event mentions (cheap
    // scan; fetches spawn; resolved names push to the board as grass-lookups).
    crate::mcp::enrich::note_event(&app, &event);
    // Live-relay to the Team Ops GRASS page when it exists (mirror of the
    // board_feed pattern). Board closing mid-emit is a benign race — the
    // event is already in the ring for the next back-fill.
    crate::mcp::web_board::emit_board(&app, "grass-event", &event);
    Ok(())
}

/// Back-fill for the board GRASS page: newest events (oldest→newest order for
/// direct newest-first insertion client-side) plus the distinct-category list
/// for the filter dropdown. Read-only — unguarded, like the other board reads.
#[tauri::command]
pub fn mcp_grass_recent(limit: Option<usize>, category: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "events": get_recent(limit.unwrap_or(500).min(MAX_EVENTS), category.as_deref(), None),
        "categories": get_categories(),
        "lookups": crate::mcp::enrich::lookups_json(),
    })
}
