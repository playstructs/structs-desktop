//! Virtual-player bridge — Rust → JS round-trip for operations that need the
//! mnemonic / signing (which live ONLY in the webapp, never in Rust). Mirrors
//! `tx_queue.rs`: Rust emits `structs:vplayer-request`, the glue dispatches to
//! the `window.__STRUCTS_VPLAYERS__` façade, and replies via the
//! `vplayer_response` Tauri command, resolving a `oneshot`.
//!
//! Security boundary: this carries OPERATIONS and their RESULTS (addresses,
//! player ids, tx hashes) — never private keys or the mnemonic. The façade
//! re-derives keys in JS from `gameState.mnemonic` on demand.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::oneshot;

/// A request sent to the webapp façade.
#[derive(Debug, Clone, Serialize)]
pub struct VPlayerRequest {
    pub req_id: String,
    /// "derive" | "signup" | "sign" | "list" (interpreted by the façade).
    pub op: String,
    pub args: Value,
}

/// The façade's reply.
#[derive(Debug, Clone, Deserialize)]
pub struct VPlayerResponse {
    pub req_id: String,
    pub success: bool,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Option<String>,
}

static INFLIGHT: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, oneshot::Sender<VPlayerResponse>>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Send an op to the façade and await its result. `timeout_secs` is generous
/// because `signup` polls the chain for the new player id (can take ~minutes).
pub async fn call(
    app_handle: &tauri::AppHandle,
    op: &str,
    args: Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    INFLIGHT.lock().await.insert(req_id.clone(), tx);

    let request = VPlayerRequest {
        req_id: req_id.clone(),
        op: op.to_string(),
        args,
    };
    if let Err(e) = app_handle.emit("structs:vplayer-request", &request) {
        cleanup(&req_id).await;
        return Err(format!("Failed to emit vplayer request: {}", e));
    }

    match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(resp)) => {
            if resp.success {
                Ok(resp.data)
            } else {
                Err(resp.error.unwrap_or_else(|| "virtual-player op failed".to_string()))
            }
        }
        Ok(Err(_)) => {
            cleanup(&req_id).await;
            Err("virtual-player bridge channel closed".to_string())
        }
        Err(_) => {
            cleanup(&req_id).await;
            Err(format!(
                "virtual-player op '{}' timed out after {}s (is the app signed in?)",
                op, timeout_secs
            ))
        }
    }
}

async fn cleanup(req_id: &str) {
    INFLIGHT.lock().await.remove(req_id);
}

pub async fn resolve(resp: VPlayerResponse) {
    let sender = {
        let mut inflight = INFLIGHT.lock().await;
        inflight.remove(&resp.req_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(resp);
    } else {
        eprintln!("[Structs VPlayer] no inflight request for {}", resp.req_id);
    }
}

// ── Tauri command ──

#[tauri::command]
pub async fn vplayer_response(response: VPlayerResponse) -> Result<(), String> {
    resolve(response).await;
    Ok(())
}
