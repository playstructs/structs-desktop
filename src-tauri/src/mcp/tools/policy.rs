use rmcp::model::Content;
use serde::Deserialize;
use serde_json::json;

use crate::mcp::policy::POLICY_ENGINE;

#[derive(Debug, Deserialize)]
pub struct PolicyParams {
    /// Command: list, set, remove, log
    pub command: String,
    /// Policy name (for set/remove)
    pub policy: Option<String>,
    /// Enable/disable (for set)
    pub enabled: Option<bool>,
    /// Policy-specific configuration (for set)
    pub config: Option<serde_json::Value>,
}

pub async fn execute(params: PolicyParams) -> Vec<Content> {
    match params.command.as_str() {
        "list" => {
            let engine = POLICY_ENGINE.read().unwrap();
            let mut policies: Vec<_> = engine.store.policies.values().collect();
            policies.sort_by_key(|p| &p.name);

            let mut out = String::from("Policies:\n");
            for p in &policies {
                let status = if p.enabled { "ON" } else { "OFF" };
                out.push_str(&format!(
                    "  {} [{}] — {}\n",
                    p.name,
                    status,
                    serde_json::to_string(&p.config).unwrap_or_default()
                ));
            }

            // Show recent events
            if !engine.event_log.is_empty() {
                let recent: Vec<_> = engine
                    .event_log
                    .iter()
                    .rev()
                    .take(10)
                    .collect();
                out.push_str("\nRecent policy events:\n");
                for event in recent.iter().rev() {
                    out.push_str(&format!(
                        "  [{}] {} — {}\n",
                        event.policy, event.action, event.detail
                    ));
                }
            }

            vec![Content::text(out)]
        }

        "set" => {
            let Some(name) = &params.policy else {
                return vec![Content::text(
                    "Error: policy name required. Available: auto_refine, power_alert, combat_alert, agent_ui, auto_counterattack, auto_retreat_if_cmd_below, auto_rebuild_losses, rules_of_engagement, primary_home_guard, board_auto_open",
                )];
            };
            let enabled = params.enabled.unwrap_or(true);
            let mut engine = POLICY_ENGINE.write().unwrap();
            engine.set_policy(name, enabled, params.config.clone());

            let status = if enabled { "enabled" } else { "disabled" };
            vec![Content::text(format!(
                "Policy '{}' {} with config: {}",
                name,
                status,
                params
                    .config
                    .map(|c| serde_json::to_string(&c).unwrap_or_default())
                    .unwrap_or_else(|| "unchanged".to_string())
            ))]
        }

        // The economy/upkeep automation as one versioned document (mcp::orders).
        "orders" => {
            let cfg = params.config.clone().unwrap_or(serde_json::Value::Null);
            let action = cfg.get("action").and_then(|a| a.as_str()).unwrap_or("show");
            let pretty = |v: serde_json::Value| vec![Content::text(serde_json::to_string_pretty(&v).unwrap_or_default())];
            let proposed = || -> Result<crate::mcp::orders::Orders, String> {
                let d = cfg.get("document").ok_or("this action needs config.document (start from action 'show')")?;
                serde_json::from_value(d.clone()).map_err(|e| format!("document does not parse: {e}"))
            };
            match action {
                "show" => pretty(json!(crate::mcp::orders::current())),
                "save" => {
                    let name = cfg.get("name").and_then(|a| a.as_str()).unwrap_or("");
                    let by = cfg.get("author").and_then(|a| a.as_str()).unwrap_or("agent");
                    let doc = match cfg.get("document") {
                        Some(_) => match proposed() {
                            Ok(d) => d,
                            Err(e) => return vec![Content::text(format!("Error: {e}"))],
                        },
                        None => crate::mcp::orders::current(),
                    };
                    match crate::mcp::orders::save_named(name, by, doc) {
                        Ok(()) => pretty(json!({ "saved": name })),
                        Err(e) => vec![Content::text(format!("Error: {e}"))],
                    }
                }
                "library" => pretty(json!(crate::mcp::orders::library_list()
                    .into_iter()
                    .map(|(n, by, at)| json!({ "name": n, "saved_by": by, "saved_ms": at }))
                    .collect::<Vec<_>>())),
                "load" => {
                    let name = cfg.get("name").and_then(|a| a.as_str()).unwrap_or("");
                    match crate::mcp::orders::load_named(name) {
                        Some(d) => pretty(json!({
                            "document": d,
                            "problems": crate::mcp::orders::check(&d, crate::mcp::virtual_players::is_virtual),
                            "changes_if_applied": crate::mcp::orders::diff(&crate::mcp::orders::current(), &d),
                        })),
                        None => vec![Content::text(format!("Error: no saved orders named '{name}'"))],
                    }
                }
                "halt" => {
                    let author = cfg.get("author").and_then(|a| a.as_str()).unwrap_or("agent");
                    let reason = cfg.get("reason").and_then(|a| a.as_str()).unwrap_or("halted");
                    match crate::mcp::orders::halt(author, reason) {
                        Ok(v) => pretty(v),
                        Err(p) => pretty(json!({ "halted": false, "problems": p })),
                    }
                }
                "resume" => {
                    let author = cfg.get("author").and_then(|a| a.as_str()).unwrap_or("agent");
                    match crate::mcp::orders::resume(author) {
                        Ok(v) => pretty(v),
                        Err(p) => pretty(json!({ "resumed": false, "problems": p })),
                    }
                }
                "history" => pretty(json!(crate::mcp::orders::history())),
                "check" | "diff" => match proposed() {
                    Ok(d) => pretty(json!({
                        "problems": crate::mcp::orders::check(&d, crate::mcp::virtual_players::is_virtual),
                        "changes": crate::mcp::orders::diff(&crate::mcp::orders::current(), &d),
                    })),
                    Err(e) => vec![Content::text(format!("Error: {e}"))],
                },
                "apply" => match proposed() {
                    Ok(d) => {
                        let author = cfg.get("author").and_then(|a| a.as_str()).unwrap_or("agent");
                        match crate::mcp::orders::apply(d, author) {
                            Ok((now, changes)) => pretty(json!({ "applied": true, "version": now.version, "changes": changes })),
                            Err(problems) => pretty(json!({ "applied": false, "problems": problems })),
                        }
                    }
                    Err(e) => vec![Content::text(format!("Error: {e}"))],
                },
                other => vec![Content::text(format!("Error: unknown orders action '{other}'. Use show, check, diff, apply, history, halt, resume, save, library, load."))],
            }
        }

        "remove" => {
            let Some(name) = &params.policy else {
                return vec![Content::text("Error: policy name required.")];
            };
            let mut engine = POLICY_ENGINE.write().unwrap();
            if engine.remove_policy(name) {
                vec![Content::text(format!("Policy '{}' removed.", name))]
            } else {
                vec![Content::text(format!("Policy '{}' not found.", name))]
            }
        }

        "log" => {
            let engine = POLICY_ENGINE.read().unwrap();
            if engine.event_log.is_empty() {
                return vec![Content::text("No policy events yet.")];
            }
            let mut out = String::from("Policy event log:\n");
            for event in &engine.event_log {
                out.push_str(&format!(
                    "  [{}] {} — {}\n",
                    event.policy, event.action, event.detail
                ));
            }
            vec![Content::text(out)]
        }

        other => vec![Content::text(format!(
            "Unknown policy command '{}'. Use: list, set, remove, log",
            other
        ))],
    }
}
