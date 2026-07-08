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
use tokio::sync::{oneshot, Semaphore};

/// Cap concurrent signing round-trips. Each `sign`/`signup` goes to the JS façade
/// (`signAndBroadcastAs`), which now POOLS one `SigningStargateClient` per address and
/// REUSES it (no per-call WS churn — that churn caused "Insufficient resources" and
/// wedged the app's own feeds). With pooling the sockets are stable, so a few
/// concurrent signs are safe again — and necessary: each `signAndBroadcast` waits for
/// block inclusion (~6s), so strictly-serial signing (1 permit) starved the tail of a
/// wave past the 60s per-call bound. Since the façade now signs over HTTP RPC (stateless,
/// no persistent socket per vplayer — see apply-patches.sh signAndBroadcastAs), the old
/// "keep few sockets open" ceiling is gone: the WS-pool exhaustion that used to wedge the
/// whole app on large sweeps can no longer happen. 8 concurrent halves the drain time of a
/// big batch (e.g. 116 workers ÷ 8 × ~6s ≈ 87s vs ~174s at 4) while staying gentle on the
/// node. Reads still fan out wider (`loop_util::MAX_CONCURRENT_PLAYERS`).
static SIGN_GATE: Semaphore = Semaphore::const_new(8);

/// Per-account (HD index) serialization. Two txs from the SAME vplayer must never be
/// in flight together: the pooled `SigningStargateClient` caches the account sequence,
/// so concurrent broadcasts from one account race it and fail with
/// "account sequence mismatch expected N got N-1". That wedged the mass build-out —
/// a worker with N structs completing at once collides N ways and NONE land. Serialize
/// per index (held for the whole round-trip); different vplayers still sign
/// concurrently up to SIGN_GATE.
static ACCOUNT_LOCKS: std::sync::LazyLock<std::sync::Mutex<HashMap<i64, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn account_lock(index: i64) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut m = ACCOUNT_LOCKS.lock().unwrap();
    m.entry(index)
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

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
    // Serialize per account FIRST (before the global gate, so a same-account tx waiting
    // its turn doesn't hold a scarce SIGN_GATE permit). Held for the whole round-trip so
    // one vplayer's txs never race their cached sequence.
    let _acct_guard = if matches!(op, "sign" | "signup") {
        let idx = args.get("index").and_then(|v| v.as_i64()).unwrap_or(-1);
        Some(account_lock(idx).lock_owned().await)
    } else {
        None
    };

    // Throttle the WS-opening ops so a wide loop fan-out can't exhaust the webview
    // WebSocket pool. Held for the whole round-trip (dropped on return). Read-only
    // ops ("derive"/"list") don't open a socket, so they skip the gate.
    let _sign_permit = if matches!(op, "sign" | "signup") {
        match SIGN_GATE.acquire().await {
            Ok(p) => Some(p),
            Err(_) => return Err("signing gate closed".to_string()),
        }
    } else {
        None
    };

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

/// Convenience wrapper for the common "sign & broadcast as HD index N" op —
/// builds the `{index, type_url, payload}` args the façade's `sign` handler
/// expects. `index` 0 is the primary's key; >= 1 are the virtual players.
pub async fn sign_action(
    app_handle: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    call(
        app_handle,
        "sign",
        serde_json::json!({ "index": index, "type_url": type_url, "payload": payload }),
        timeout_secs,
    )
    .await
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
