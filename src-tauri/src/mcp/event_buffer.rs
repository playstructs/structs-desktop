use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::RwLock;

const MAX_EVENTS: usize = 1000;

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

// ── Tauri Command ──

#[tauri::command]
pub async fn push_game_event(event: GameEvent) -> Result<(), String> {
    push_event(event);
    Ok(())
}
