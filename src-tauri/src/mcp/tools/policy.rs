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
                    "Error: policy name required. Available: auto_refine, power_alert, combat_alert, agent_ui, auto_counterattack, auto_retreat_if_cmd_below, auto_rebuild_losses, rules_of_engagement, primary_home_guard",
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
