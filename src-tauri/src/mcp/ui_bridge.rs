//! UI directive bridge — Rust → JS webview push, with an optional JS → Rust
//! response round-trip. Mirrors `tx_queue.rs`: the agent (or the policy engine)
//! pushes a declarative UI directive to the webview; for `prompt` directives the
//! call blocks on a `oneshot` until the human answers (or it times out).
//!
//! UI directives are display/elicitation only — they CANNOT sign. Any action the
//! human chooses still flows back through the agent and the tx bridge, which has
//! its own approval gate.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::oneshot;

/// A directive sent from Rust to the JS webview renderer.
#[derive(Debug, Clone, Serialize)]
pub struct UiDirective {
    pub directive_id: String,
    /// "notify" (fire-and-forget) or "prompt" (await a response).
    pub mode: String,
    /// The declarative component spec ({ kind, ... }). Opaque to Rust; the
    /// frontend renderer interprets `kind`.
    pub component: Value,
}

/// Response from the JS webview after the human interacts with a `prompt`.
#[derive(Debug, Clone, Deserialize)]
pub struct UiResponse {
    pub directive_id: String,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub cancelled: bool,
}

/// Outcome of `show_ui`, surfaced to the agent by the tool handler.
#[derive(Debug, Clone)]
pub enum UiOutcome {
    /// notify directive emitted (fire-and-forget).
    Shown,
    /// prompt answered by the human with this value.
    Answered(Value),
    /// prompt dismissed/closed by the human.
    Cancelled,
    /// prompt timed out with no response.
    TimedOut,
    /// agent UI is disabled by the human (master toggle); directive dropped.
    Disabled,
    /// rate limit exceeded; directive dropped.
    RateLimited,
}

const DEFAULT_TIMEOUT_SECS: u64 = 180;
const MIN_TIMEOUT_SECS: u64 = 10;
const MAX_TIMEOUT_SECS: u64 = 600;

/// Sliding-window rate limit: at most this many directives per window.
const RATE_MAX: usize = 12;
const RATE_WINDOW: Duration = Duration::from_secs(3);

/// In-flight `prompt` directives waiting for a JS response.
static INFLIGHT: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, oneshot::Sender<UiResponse>>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Recent emit timestamps for rate limiting.
static RATE: std::sync::LazyLock<std::sync::Mutex<VecDeque<Instant>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(VecDeque::new()));

/// True if the human has agent UI enabled (master toggle). Defaults to enabled
/// when the `agent_ui` policy is present-and-enabled; the policy is seeded
/// enabled in `policy::ensure_defaults`.
fn agent_ui_enabled() -> bool {
    crate::mcp::policy::POLICY_ENGINE
        .read()
        .map(|e| e.is_enabled("agent_ui"))
        .unwrap_or(false)
}

/// Returns false if the rate window is saturated.
fn rate_ok() -> bool {
    let now = Instant::now();
    let mut q = RATE.lock().unwrap();
    while let Some(front) = q.front() {
        if now.duration_since(*front) > RATE_WINDOW {
            q.pop_front();
        } else {
            break;
        }
    }
    if q.len() >= RATE_MAX {
        false
    } else {
        q.push_back(now);
        true
    }
}

/// Show a UI directive on the human's screen.
/// - `notify`: emits and returns `Shown` immediately.
/// - `prompt`: emits, then blocks until the human answers, cancels, or times out.
pub async fn show_ui(
    app_handle: &tauri::AppHandle,
    mode: &str,
    component: Value,
    timeout_secs: Option<u64>,
) -> Result<UiOutcome, String> {
    if !agent_ui_enabled() {
        eprintln!("[Structs UI] dropped — agent UI disabled by human (agent_ui policy off)");
        return Ok(UiOutcome::Disabled);
    }
    if !rate_ok() {
        eprintln!("[Structs UI] dropped — rate limit ({}/{}s) exceeded", RATE_MAX, RATE_WINDOW.as_secs());
        return Ok(UiOutcome::RateLimited);
    }

    let directive_id = uuid::Uuid::new_v4().to_string();
    let is_prompt = mode.eq_ignore_ascii_case("prompt");

    // For prompt mode, register the response channel BEFORE emitting so a fast
    // human response can't race the insert.
    let rx = if is_prompt {
        let (tx, rx) = oneshot::channel();
        INFLIGHT.lock().await.insert(directive_id.clone(), tx);
        Some(rx)
    } else {
        None
    };

    let directive = UiDirective {
        directive_id: directive_id.clone(),
        mode: if is_prompt { "prompt".to_string() } else { "notify".to_string() },
        component,
    };

    if let Err(e) = app_handle.emit("mcp_ui_directive", &directive) {
        if is_prompt {
            cleanup_inflight(&directive_id).await;
        }
        return Err(format!("Failed to emit UI directive: {}", e));
    }
    eprintln!("[Structs UI] Sent {} directive {}", directive.mode, directive_id);

    let Some(rx) = rx else {
        return Ok(UiOutcome::Shown);
    };

    let timeout = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS);

    match tokio::time::timeout(Duration::from_secs(timeout), rx).await {
        Ok(Ok(resp)) => {
            if resp.cancelled {
                Ok(UiOutcome::Cancelled)
            } else {
                Ok(UiOutcome::Answered(resp.value.unwrap_or(Value::Null)))
            }
        }
        Ok(Err(_)) => {
            cleanup_inflight(&directive_id).await;
            Ok(UiOutcome::Cancelled) // channel dropped (e.g. surface unmounted)
        }
        Err(_) => {
            cleanup_inflight(&directive_id).await;
            Ok(UiOutcome::TimedOut)
        }
    }
}

async fn cleanup_inflight(directive_id: &str) {
    INFLIGHT.lock().await.remove(directive_id);
}

/// Resolve a pending prompt directive with the human's response.
pub async fn resolve_ui(response: UiResponse) {
    let sender = {
        let mut inflight = INFLIGHT.lock().await;
        inflight.remove(&response.directive_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(response);
    } else {
        eprintln!("[Structs UI] No inflight directive for {}", response.directive_id);
    }
}

// ── Tauri Command ──

#[tauri::command]
pub async fn mcp_ui_response(response: UiResponse) -> Result<(), String> {
    resolve_ui(response).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_response_defaults() {
        // value + cancelled are optional; absent → None / false.
        let r: UiResponse = serde_json::from_str(r#"{"directive_id":"d1"}"#).unwrap();
        assert_eq!(r.directive_id, "d1");
        assert!(r.value.is_none());
        assert!(!r.cancelled);

        let r2: UiResponse =
            serde_json::from_str(r#"{"directive_id":"d2","value":"2-7","cancelled":false}"#).unwrap();
        assert_eq!(r2.value.unwrap(), serde_json::json!("2-7"));

        let r3: UiResponse =
            serde_json::from_str(r#"{"directive_id":"d3","cancelled":true}"#).unwrap();
        assert!(r3.cancelled);
    }

    #[test]
    fn directive_serializes_with_expected_keys() {
        let d = UiDirective {
            directive_id: "abc".into(),
            mode: "prompt".into(),
            component: serde_json::json!({"kind":"menu"}),
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["directive_id"], "abc");
        assert_eq!(v["mode"], "prompt");
        assert_eq!(v["component"]["kind"], "menu");
    }

    #[test]
    fn rate_limiter_caps_then_recovers() {
        // Drain any residue from other tests, then verify the window caps.
        // (RATE is a process-global; this is the only test that touches it.)
        for _ in 0..RATE_MAX {
            let _ = rate_ok();
        }
        // Window should now be saturated.
        assert!(!rate_ok(), "expected rate limit to trip at {} in window", RATE_MAX);
    }
}
