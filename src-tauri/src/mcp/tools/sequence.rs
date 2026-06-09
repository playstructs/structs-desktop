//! `structs_sequence` — guarded autonomous action chains. Runs an ordered list
//! of game actions ("strip blockers → kill CMD"), paced to the charge cooldown,
//! re-checking abort predicates (e.g. "my Command Ship HP < 4") against live game
//! state between steps. Aborts cleanly and reports.
//!
//! Trust posture: each step is dispatched through the SAME `action::execute` path
//! as a manual `structs_action` (with its preflight + the webview's signing gate),
//! so a sequence is exactly manual play, automated with safety rails — it adds no
//! new signing authority.

use std::sync::Arc;
use std::time::Duration;

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;

use crate::game_state::GAME_STATE;
use crate::hasher::types::TaskRegistry;
use crate::mcp::tools::action::{self, ActionParams};

#[derive(Debug, Deserialize)]
pub struct StepSpec {
    pub action: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Deserialize, Default)]
pub struct AbortSpec {
    /// Abort if your Command Ship's HP drops below this.
    #[serde(default)]
    pub cmd_hp_below: Option<f64>,
    /// Abort if you go offline (load exceeds capacity).
    #[serde(default)]
    pub stop_if_offline: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SequenceParams {
    pub steps: Vec<StepSpec>,
    #[serde(default)]
    pub abort_if: Option<AbortSpec>,
    /// Total wall-clock budget for charge-waits across the whole sequence
    /// (seconds, clamped 0–300). Default 180. Prevents a long hang.
    #[serde(default)]
    pub max_wait_secs: Option<u64>,
}

/// Returns Some(reason) if an abort predicate currently holds.
fn abort_reason(abort: &AbortSpec) -> Option<String> {
    let gs = GAME_STATE.read().unwrap();
    if abort.stop_if_offline == Some(true) {
        let load = gs.total_load();
        let cap = gs.total_capacity();
        if cap > 0.0 && load > cap {
            return Some("you are OFFLINE (load exceeds capacity)".to_string());
        }
    }
    if let Some(threshold) = abort.cmd_hp_below {
        // Find your Command Ship (1 per player).
        for s in gs.structs.values() {
            let is_cmd = gs
                .struct_types
                .get(&s.struct_type_id.to_string())
                .map(|t| t.name.to_lowercase().contains("command"))
                .unwrap_or(false);
            if is_cmd {
                if let Some(hp) = s.health {
                    if hp < threshold {
                        return Some(format!(
                            "Command Ship HP {:.0} < {:.0} (abort threshold)",
                            hp, threshold
                        ));
                    }
                }
            }
        }
    }
    None
}

pub async fn execute(
    app_handle: &tauri::AppHandle,
    registry: &Arc<TaskRegistry>,
    params: SequenceParams,
) -> Vec<Content> {
    let abort = params.abort_if.unwrap_or_default();
    let budget = params.max_wait_secs.unwrap_or(180).min(300);
    let mut waited = 0u64;
    let mut out = String::new();
    out.push_str(&format!("Sequence: {} step(s)\n", params.steps.len()));

    for (i, step) in params.steps.into_iter().enumerate() {
        // Abort check BEFORE each step.
        if let Some(reason) = abort_reason(&abort) {
            out.push_str(&format!("\n⛔ ABORTED before step {} — {}\n", i + 1, reason));
            return vec![Content::text(out)];
        }

        out.push_str(&format!("\nStep {}: {} ", i + 1, step.action));

        // Run the step, retrying on a charge-block until the budget is spent.
        loop {
            let result = action::execute(
                app_handle,
                registry,
                ActionParams { action: step.action.clone(), args: step.args.clone() },
            )
            .await;
            let text = result
                .iter()
                .filter_map(|c| c.as_text().map(|t| t.text.clone()))
                .collect::<Vec<_>>()
                .join(" ");

            // Charge cooldown: action's own preflight reports it. Wait and retry.
            let is_charge_block = text.contains("BLOCKED") && text.contains("charge");
            if is_charge_block && waited < budget {
                out.push_str("(waiting for charge…) ");
                tokio::time::sleep(Duration::from_secs(6)).await;
                waited += 6;
                // Re-check abort while waiting.
                if let Some(reason) = abort_reason(&abort) {
                    out.push_str(&format!("\n⛔ ABORTED while waiting — {}\n", reason));
                    return vec![Content::text(out)];
                }
                continue;
            }
            out.push_str(&format!("→ {}", text.lines().next().unwrap_or("")));
            if is_charge_block {
                out.push_str(&format!(
                    "\n⏸ PAUSED at step {} — charge wait budget ({}s) exhausted. Re-run the remaining steps later.\n",
                    i + 1, budget
                ));
                return vec![Content::text(out)];
            }
            break;
        }
    }
    out.push_str("\n✓ Sequence complete.\n");
    vec![Content::text(out)]
}
