//! `structs_system` — the agent-facing observability surface. One tool that
//! answers "is the automation healthy, and if not, why": persistent logs,
//! per-loop liveness, the tx-attempt ledger, PoW solve stats, watchdog
//! findings/remediations, the board feed (previously invisible over MCP), and
//! the live adaptive values (AIMD concurrency, hash tuning).
//!
//! All reads go through `telemetry`'s read-only SQLite connections inside
//! `spawn_blocking`, so a big query never stalls the MCP runtime.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::json;

use crate::hasher::types::now_millis;
use crate::mcp::telemetry::{self, EventFilter, Sev};
use crate::mcp::{board_feed, loop_util, watchdog};

#[derive(Debug, Deserialize)]
pub struct SystemParams {
    /// Command: status | logs | loops | tx | pow | watchdog | feed | config
    pub command: String,
    /// logs: filter by component (e.g. "auto_build", "tx", "watchdog", "policy", "conn")
    pub component: Option<String>,
    /// logs: minimum severity (debug|info|notice|warn|error)
    pub severity: Option<String>,
    /// logs: only events at/after this ms epoch
    pub since_ms: Option<f64>,
    /// logs/feed: max rows (default 50, cap 1000)
    pub limit: Option<usize>,
    /// loops/tx/pow/watchdog: lookback window in minutes (default 60)
    pub window_minutes: Option<u64>,
    /// config: values to change, e.g. {"remediate": false}
    pub set: Option<serde_json::Value>,
}

fn text(v: serde_json::Value) -> Vec<Content> {
    vec![Content::text(
        serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()),
    )]
}

fn err(msg: impl Into<String>) -> Vec<Content> {
    vec![Content::text(format!("Error: {}", msg.into()))]
}

pub async fn execute(params: SystemParams) -> Vec<Content> {
    let window_ms = params.window_minutes.unwrap_or(60) as f64 * 60_000.0;
    let limit = params.limit.unwrap_or(50).min(1000);

    match params.command.as_str() {
        // One-page health: the first thing an agent should look at.
        "status" => {
            let health = watchdog::health_snapshot();
            let loops = tokio::task::spawn_blocking(move || telemetry::loop_health(window_ms))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            let tx = tokio::task::spawn_blocking(move || telemetry::tx_summary(window_ms))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            text(json!({
                "health": health,
                "loops_last_hour": loops.unwrap_or_else(|e| vec![json!({"error": e})]),
                "tx_last_hour": tx.unwrap_or_else(|e| json!({"error": e})),
                "adaptive": {
                    "effective_loop_concurrency": loop_util::effective_max_concurrent(),
                    "hash_enabled": crate::hasher::hash_enabled(),
                    "hash_engine": crate::hasher::engine_pref_label(),
                    "hash_difficulty_start": crate::hasher::difficulty_start(),
                    "hash_max_concurrent": crate::hasher::max_concurrent(),
                },
                "telemetry": {
                    "dropped_messages": telemetry::dropped_count(),
                    "db_bytes": telemetry::db_size_bytes(),
                },
            }))
        }

        // Filtered persistent log — the app's own diary, finally readable.
        "logs" => {
            let filter = EventFilter {
                component: params.component.clone(),
                severity_min: params.severity.as_deref().and_then(Sev::parse),
                since_ms: params.since_ms,
                limit,
            };
            match tokio::task::spawn_blocking(move || telemetry::query_events(&filter))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
            {
                Ok(rows) if rows.is_empty() => {
                    vec![Content::text("No events match that filter.")]
                }
                Ok(rows) => text(json!(rows)),
                Err(e) => err(e),
            }
        }

        "loops" => {
            match tokio::task::spawn_blocking(move || telemetry::loop_health(window_ms))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
            {
                Ok(rows) if rows.is_empty() => vec![Content::text(
                    "No loop runs in the window. Either the loops are disabled (check `structs_players` automation configs) or the window is too narrow.",
                )],
                Ok(rows) => text(json!(rows)),
                Err(e) => err(e),
            }
        }

        "tx" => {
            match tokio::task::spawn_blocking(move || telemetry::tx_summary(window_ms))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
            {
                // Gate gauges alongside the history: deep `queued_bulk` with a
                // full `in_flight` is normal saturation; a non-zero
                // `queued_critical` means combat answers are being delayed and
                // is the number to watch.
                Ok(v) => text(json!({
                    "history": v,
                    "gate": crate::mcp::tx_gate::snapshot(),
                })),
                Err(e) => err(e),
            }
        }

        "pow" => {
            match tokio::task::spawn_blocking(move || telemetry::pow_stats(window_ms))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
            {
                // pow_stats returns a per-engine ARRAY; wrap it so the live
                // pool gauges ride alongside. Workers should track the cap
                // (never the queue depth — that was the 1,500-thread crash),
                // and pending is the threadless backlog awaiting ripeness.
                Ok(v) => text(json!({
                    "engines": v,
                    "pool": {
                        "workers": crate::hasher::pool::worker_count(),
                        "pending": crate::hasher::pool::pending_len(),
                        "cap": crate::hasher::max_concurrent(),
                    },
                })),
                Err(e) => err(e),
            }
        }

        // Watchdog findings + remediation history from the events table.
        "watchdog" => {
            let filter = EventFilter {
                component: Some("watchdog".into()),
                severity_min: None,
                since_ms: Some(now_millis() - window_ms.max(24.0 * 3_600_000.0)),
                limit,
            };
            let events = tokio::task::spawn_blocking(move || telemetry::query_events(&filter))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            text(json!({
                "health": watchdog::health_snapshot(),
                "remediation_enabled": crate::mcp::policy::POLICY_ENGINE
                    .read()
                    .map(|e| e.is_enabled("watchdog_remediate"))
                    .unwrap_or(false),
                "recent_findings": events.unwrap_or_else(|e| vec![json!({"error": e})]),
            }))
        }

        // The Team Ops board feed, until now only visible in the board window.
        "feed" => {
            let entries = board_feed::recent(limit);
            if entries.is_empty() {
                vec![Content::text("Board feed is empty.")]
            } else {
                text(json!(entries))
            }
        }

        "config" => {
            if let Some(set) = &params.set {
                let mut applied = Vec::new();
                if let Some(remediate) = set.get("remediate").and_then(|v| v.as_bool()) {
                    if let Ok(mut engine) = crate::mcp::policy::POLICY_ENGINE.write() {
                        engine.set_policy("watchdog_remediate", remediate, None);
                        applied.push(format!("watchdog_remediate={remediate}"));
                    }
                }
                if applied.is_empty() {
                    return err("nothing recognized in `set`. Settable here: {\"remediate\": bool}. Hash knobs live in structs_hash config; loop knobs in structs_players.");
                }
                return text(json!({ "applied": applied }));
            }
            text(json!({
                "effective_loop_concurrency": loop_util::effective_max_concurrent(),
                "loop_concurrency_ceiling": loop_util::MAX_CONCURRENT_PLAYERS,
                "watchdog_remediate": crate::mcp::policy::POLICY_ENGINE
                    .read()
                    .map(|e| e.is_enabled("watchdog_remediate"))
                    .unwrap_or(false),
                "hash": {
                    "enabled": crate::hasher::hash_enabled(),
                    "engine": crate::hasher::engine_pref_label(),
                    "difficulty_start": crate::hasher::difficulty_start(),
                    "max_concurrent": crate::hasher::max_concurrent(),
                },
                "note": "Adaptive values move on their own (AIMD / tuner). Hash knobs: structs_hash config. Loop configs: structs_players.",
            }))
        }

        other => err(format!(
            "unknown command '{other}'. Use: status, logs, loops, tx, pow, watchdog, feed, config"
        )),
    }
}
