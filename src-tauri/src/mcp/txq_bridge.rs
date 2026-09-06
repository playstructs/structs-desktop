//! Signing-queue bridge — Rust → JS round-trip to the main webview's
//! `SigningQueueManager` (via the injected `window.__STRUCTS_TXQ__` façade).
//! Mirrors `vplayer_bridge.rs`: Rust emits `structs:txq-request`, the glue in
//! structs-config.js dispatches to the façade, and replies via the
//! `txq_response` Tauri command, resolving a `oneshot`.
//!
//! Unlike the vplayer bridge there is no semaphore or per-account lock here:
//! these ops are instant, in-memory JS (queue snapshots and lane mutations) —
//! they never sign or broadcast anything themselves.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;

/// A request sent to the webapp façade.
#[derive(Debug, Clone, Serialize)]
pub struct TxqRequest {
    pub req_id: String,
    /// "snapshot" | "mutate" (interpreted by the façade).
    pub op: String,
    pub args: Value,
}

/// The façade's reply.
#[derive(Debug, Clone, Deserialize)]
pub struct TxqResponse {
    pub req_id: String,
    pub success: bool,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Option<String>,
}

static INFLIGHT: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, oneshot::Sender<TxqResponse>>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Send an op to the façade and await its result.
pub async fn call(
    app_handle: &tauri::AppHandle,
    op: &str,
    args: Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    INFLIGHT.lock().await.insert(req_id.clone(), tx);

    let request = TxqRequest {
        req_id: req_id.clone(),
        op: op.to_string(),
        args,
    };
    if let Err(e) = crate::mcp::events::emit(app_handle, crate::mcp::events::AppEvent::TxqRequest(serde_json::to_value(&request).unwrap_or_default())) {
        cleanup(&req_id).await;
        return Err(format!("Failed to emit txq request: {}", e));
    }

    match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(resp)) => {
            if resp.success {
                Ok(resp.data)
            } else {
                Err(resp.error.unwrap_or_else(|| "tx-queue op failed".to_string()))
            }
        }
        Ok(Err(_)) => {
            cleanup(&req_id).await;
            Err("tx-queue bridge channel closed".to_string())
        }
        Err(_) => {
            cleanup(&req_id).await;
            Err(format!(
                "tx-queue op '{}' timed out after {}s — is the game window signed in?",
                op, timeout_secs
            ))
        }
    }
}

async fn cleanup(req_id: &str) {
    INFLIGHT.lock().await.remove(req_id);
}

// ── Tauri command ──

#[tauri::command]
pub async fn txq_response(response: TxqResponse) -> Result<(), String> {
    let sender = {
        let mut inflight = INFLIGHT.lock().await;
        inflight.remove(&response.req_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(response);
    } else {
        eprintln!("[Structs TXQ] no inflight request for {}", response.req_id);
    }
    Ok(())
}
