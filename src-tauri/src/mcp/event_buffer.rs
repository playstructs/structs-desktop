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

/// Recent events, newest last.
///
/// `subject_token` matches a WHOLE dot-delimited segment of the subject, never a
/// substring. This used to be `subject_contains` doing `subject.contains(sub)`,
/// which is the trap that has bitten this codebase repeatedly: an id is a prefix
/// of every longer id in its decade, so filtering on `1-195` also returns
/// `1-1950`…`1-1959`, and filtering on `2-422` returns `2-4228`. No caller
/// relied on the substring behaviour, so the semantics are simply exact now.
pub fn get_recent(count: usize, category: Option<&str>, subject_token: Option<&str>) -> Vec<GameEvent> {
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
            if let Some(tok) = subject_token {
                if !e.subject.split('.').any(|seg| seg == tok) {
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
    // Durable copy FIRST, and unconditionally — including `block` heartbeats.
    // The in-memory ring below is a working set (2000 entries = minutes at
    // fleet scale); this is the 7-day record that a support bundle carries.
    crate::mcp::telemetry::record_grass(&event.category, &event.subject, &event.detail);

    // A DROPPED settlement is the most dangerous event in the system and used
    // to be the quietest. The signing bridge acks "queued" the moment a message
    // is accepted — it must, because charge-gated messages settle minutes later
    // — so `tx_attempts` records success for a tx that may never reach the
    // chain. When the real receipt finally arrives as `tx_settled`, a failure
    // was going only to the webview console. That is the same blind spot that
    // hid 15 days of futile mining; surface it loudly instead.
    if event.category == "tx_settled" {
        note_failed_settlement(&app, &event);
    }

    // `block` ticks (~every 6s) are RELAY-ONLY: buffered they'd drown the
    // 1000-entry ring (and every policy/threat scan over it) within the hour,
    // but the GRASS page wants the heartbeat.
    if event.category != "block" {
        push_event(event.clone());
    }
    // Queue background name lookups for any ids this event mentions (cheap
    // scan; fetches spawn; resolved names push to the board as grass-lookups).
    crate::mcp::enrich::note_event(&app, &event);
    // Route live deltas to any open spectator window watching this planet. A
    // no-op (and near-free) unless Raid View is enabled AND a window is up.
    crate::mcp::spectator::note_event(&app, &event);
    // Live-relay to the Team Ops GRASS page when it exists (mirror of the
    // board_feed pattern). Board closing mid-emit is a benign race — the
    // event is already in the ring for the next back-fill.
    crate::mcp::web_board::emit_board(&app, "grass-event", &event);
    Ok(())
}

/// Did this settlement fail to land?
///
/// The vocabulary is the webapp's `TX_STATUS`
/// (`structs-webapp/src/js/models/SigningTransaction.js`): `queued`,
/// `in_flight`, `succeeded`, `dropped`, `cancelled` — of which the last three
/// are terminal. Transcribed rather than guessed: an earlier version of this
/// allow-listed "success"/"settled"/"confirmed", none of which the queue ever
/// emits, so every SUCCESSFUL transaction was reported as a failure.
///
/// Non-terminal statuses are NOT failures — they simply have not finished, and
/// the real receipt arrives in a later event.
fn settlement_failed(status: &str, code: Option<i64>, error: Option<&str>) -> bool {
    match status {
        "succeeded" => {
            // Terminal-good, but the chain can still have rejected the message
            // inside a delivered tx (non-zero code carries the reason).
            code.is_some_and(|c| c != 0) || error.is_some_and(|e| !e.is_empty())
        }
        "dropped" | "cancelled" => true,
        // queued / in_flight / anything unrecognised: not yet settled.
        _ => false,
    }
}

/// Log + surface a settlement that did not land. Ledgered as a real tx failure
/// so `structs_system tx` and the board's Transactions page stop reporting a
/// success that never happened.
fn note_failed_settlement(app: &tauri::AppHandle, event: &GameEvent) {
    let d = &event.detail;
    let status = d.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
    let code = d.get("code").and_then(|v| v.as_i64());
    let error = d.get("error").and_then(|v| v.as_str());
    if !settlement_failed(status, code, error) {
        return;
    }
    let action = d
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or(&event.subject);
    let reason = error
        .or_else(|| d.get("rawLog").and_then(|v| v.as_str()))
        .unwrap_or(status);
    let msg = format!("{action} did NOT land: {reason}");

    crate::mcp::telemetry::record_tx_attempt(crate::mcp::telemetry::TxAttemptRow {
        ts_ms: crate::hasher::types::now_millis(),
        context: format!("settle:{action}"),
        action: action.to_string(),
        player_id: None,
        attempt: 1,
        outcome: "settle_failed",
        tx_hash: d
            .get("transactionHash")
            .and_then(|v| v.as_str())
            .map(String::from),
        code,
        raw_error: Some(reason.to_string()),
        translated: Some(msg.clone()),
        duration_ms: 0.0,
    });
    crate::mcp::telemetry::tlog_feed(
        app,
        "tx",
        crate::mcp::telemetry::Sev::Warn,
        msg,
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    // Statuses are TX_STATUS from the webapp's SigningTransaction model:
    // queued | in_flight | succeeded | dropped | cancelled.

    #[test]
    fn dropped_settlements_are_flagged() {
        // The exact shape that silently swallowed five allocation attempts:
        // bridge acked "queued", then the encoder rejected the message.
        assert!(settlement_failed("dropped", None, Some("Error: invalid int32: NaN")));
        assert!(settlement_failed("cancelled", None, None));
        // Delivered, but the chain rejected the message inside it.
        assert!(settlement_failed("succeeded", Some(11), None));
        assert!(settlement_failed("succeeded", None, Some("insufficient funds")));
    }

    #[test]
    fn genuine_settlements_are_not_flagged() {
        // REGRESSION: "succeeded" is the queue's real success value. Allow-
        // listing invented names ("success"/"settled") flagged every good tx.
        assert!(!settlement_failed("succeeded", Some(0), None));
        assert!(!settlement_failed("succeeded", None, None));
        assert!(!settlement_failed("succeeded", Some(0), Some("")));
    }

    #[test]
    fn in_flight_is_not_a_failure() {
        // Non-terminal: the receipt simply has not arrived yet. Treating these
        // as failures would fire a warning for every transaction submitted.
        assert!(!settlement_failed("queued", None, None));
        assert!(!settlement_failed("in_flight", None, None));
        assert!(!settlement_failed("unknown", None, None));
    }
}
