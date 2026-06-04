//! `structs_ui` tool — lets the agent drive the human's screen for co-op play.
//! Sends a declarative component spec to the webview renderer via `ui_bridge`.
//! `notify` shows-and-returns; `prompt` blocks until the human answers.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;

use crate::mcp::ui_bridge::{self, UiOutcome};

#[derive(Debug, Deserialize)]
pub struct UiParams {
    /// "notify" (fire-and-forget) or "prompt" (await the human's choice).
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Declarative component spec: { kind: "...", ... }. See tool description.
    pub component: Value,
    /// For prompt mode: how long to wait for the human (seconds; clamped 10–600).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

fn default_mode() -> String {
    "notify".to_string()
}

/// Component kinds the frontend renderer understands.
const KNOWN_KINDS: &[&str] = &[
    "open_menu", "panel", "menu", "dialogue", "info", "map_preview", "hud_badge", "toast",
    "raw_html", "dismiss",
];

/// Validate a directive spec. Returns the resolved `kind` on success, or a
/// human-readable error. Pure (no I/O) so it is unit-testable.
fn validate_component(mode: &str, component: &Value) -> Result<String, String> {
    let kind = component
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "component must be an object with a string `kind` (one of: {}).",
                KNOWN_KINDS.join(", ")
            )
        })?;
    if !KNOWN_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "unknown component kind '{}'. Known kinds: {}.",
            kind,
            KNOWN_KINDS.join(", ")
        ));
    }
    if mode.eq_ignore_ascii_case("prompt")
        && matches!(kind.as_str(), "toast" | "hud_badge" | "map_preview" | "dismiss")
    {
        return Err(format!(
            "kind '{}' is display-only and cannot be used in prompt mode. Use mode 'notify', or a prompt-capable kind (menu, dialogue, panel).",
            kind
        ));
    }
    Ok(kind)
}

pub async fn execute(app_handle: &tauri::AppHandle, params: UiParams) -> Vec<Content> {
    let kind = match validate_component(&params.mode, &params.component) {
        Ok(k) => k,
        Err(e) => return vec![Content::text(format!("Error: {}", e))],
    };

    match ui_bridge::show_ui(app_handle, &params.mode, params.component, params.timeout_secs).await {
        Ok(UiOutcome::Shown) => vec![Content::text(format!(
            "Shown to the human ({} surface). Display-only — returns no input.",
            kind
        ))],
        Ok(UiOutcome::Answered(value)) => vec![Content::text(format!(
            "Human responded: {}",
            serde_json::to_string(&value).unwrap_or_else(|_| "<unserializable>".to_string())
        ))],
        Ok(UiOutcome::Cancelled) => {
            vec![Content::text("Human dismissed the prompt without choosing (cancelled).".to_string())]
        }
        Ok(UiOutcome::TimedOut) => vec![Content::text(
            "Prompt timed out — the human did not respond in time. Proceed without their input or try again.".to_string(),
        )],
        Ok(UiOutcome::Disabled) => vec![Content::text(
            "Agent UI is disabled by the human (agent_ui policy is off). Directive dropped. Re-enable with structs_policy set agent_ui true.".to_string(),
        )],
        Ok(UiOutcome::RateLimited) => vec![Content::text(
            "Rate limit exceeded — too many UI directives in a short window. Slow down and retry.".to_string(),
        )],
        Err(e) => vec![Content::text(format!("Error showing UI: {}", e))],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_kinds_pass() {
        assert_eq!(validate_component("notify", &json!({"kind":"toast"})).unwrap(), "toast");
        assert_eq!(validate_component("prompt", &json!({"kind":"menu"})).unwrap(), "menu");
        assert_eq!(validate_component("prompt", &json!({"kind":"dialogue"})).unwrap(), "dialogue");
    }

    #[test]
    fn missing_kind_errors() {
        assert!(validate_component("notify", &json!({"title":"x"})).is_err());
    }

    #[test]
    fn unknown_kind_errors() {
        let e = validate_component("notify", &json!({"kind":"hologram"})).unwrap_err();
        assert!(e.contains("unknown component kind"));
    }

    #[test]
    fn display_only_kinds_rejected_in_prompt_mode() {
        for k in ["toast", "hud_badge", "map_preview", "dismiss"] {
            let e = validate_component("prompt", &json!({"kind": k})).unwrap_err();
            assert!(e.contains("display-only"), "{} should be display-only", k);
        }
        // …but allowed in notify mode
        assert!(validate_component("notify", &json!({"kind":"hud_badge"})).is_ok());
    }
}
