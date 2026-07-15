use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::Emitter;
use tokio::sync::oneshot;

/// Request sent from Rust to JS webview for signing
#[derive(Debug, Clone, Serialize)]
pub struct TxRequest {
    pub request_id: String,
    pub action: String,
    pub args: Value,
}

/// Response from JS webview after signing/broadcasting
#[derive(Debug, Clone, Deserialize)]
pub struct TxResponse {
    pub request_id: String,
    pub success: bool,
    pub tx_hash: Option<String>,
    pub error: Option<String>,
}

/// In-flight transaction requests waiting for JS responses
static INFLIGHT: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, oneshot::Sender<TxResponse>>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Submit a transaction via the webview signing bridge.
/// Returns the response when the JS side completes signing and broadcasting.
pub async fn submit_tx(
    app_handle: &tauri::AppHandle,
    action: String,
    args: Value,
) -> Result<TxResponse, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();

    // Store the response channel
    {
        let mut inflight = INFLIGHT.lock().await;
        inflight.insert(request_id.clone(), tx);
    }

    // Emit the request to the webview
    let request = TxRequest {
        request_id: request_id.clone(),
        action,
        args,
    };

    app_handle
        .emit("mcp_transaction_request", &request)
        .map_err(|e| format!("Failed to emit tx request: {}", e))?;

    crate::mcp::telemetry::tlog(
        "tx",
        crate::mcp::telemetry::Sev::Debug,
        format!("Sent request {}: {}", request_id, request.action),
    );

    // Wait for response with timeout (30s)
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(response)) => {
            if response.success {
                crate::mcp::telemetry::tlog(
                    "tx",
                    crate::mcp::telemetry::Sev::Info,
                    format!("Success {}: hash={:?}", request_id, response.tx_hash),
                );
            } else {
                crate::mcp::telemetry::tlog(
                    "tx",
                    crate::mcp::telemetry::Sev::Warn,
                    format!("Failed {}: {:?}", request_id, response.error),
                );
            }
            Ok(response)
        }
        Ok(Err(_)) => {
            cleanup_inflight(&request_id).await;
            Err("Transaction channel closed unexpectedly".to_string())
        }
        Err(_) => {
            cleanup_inflight(&request_id).await;
            Err("Transaction signing timed out (30s). The webview may be unresponsive.".to_string())
        }
    }
}

async fn cleanup_inflight(request_id: &str) {
    let mut inflight = INFLIGHT.lock().await;
    inflight.remove(request_id);
}

/// Called by the Tauri command when JS responds to a signing request
pub async fn resolve_tx(response: TxResponse) {
    let sender = {
        let mut inflight = INFLIGHT.lock().await;
        inflight.remove(&response.request_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(response);
    } else {
        eprintln!(
            "[Structs TX] No inflight request for {}",
            response.request_id
        );
    }
}

// ── Tauri Command ──

#[tauri::command]
pub async fn mcp_transaction_response(response: TxResponse) -> Result<(), String> {
    resolve_tx(response).await;
    Ok(())
}
