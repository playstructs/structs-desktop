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
use std::sync::atomic::Ordering;
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

// ── Bridge liveness ──
//
// The signing bridge can die while every other health signal stays green: Rust
// keeps reading the chain, the sync tick keeps ticking, loops keep scanning —
// and not one transaction lands, because the webview on the other end of this
// round-trip has stopped answering. That is not hypothetical: 2026-08-20 lost
// 18 minutes of ALL writes (70 sign timeouts, every one at exactly the 60s
// bound) while `structs_system status` reported "ok" the whole way through.
//
// So the bridge reports its own liveness. Any response — success OR error —
// proves the webview is answering; only a full timeout counts against it.
// `watchdog::detect` turns a sustained silence into a page reload, which is
// what a human had to do by hand to end that outage.
static LAST_RESPONSE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LAST_PROBE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CONSEC_TIMEOUTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Consecutive unanswered round-trips before the bridge counts as down. Three
/// at 60s each is ~3 minutes of evidence — long enough that a slow node or one
/// wedged account can't trip it, short enough to heal inside a mine cycle.
const DOWN_AFTER_TIMEOUTS: u32 = 3;
/// …and it must ALSO have been silent this long. A busy bridge answering other
/// calls is not down, however many individual calls time out.
const DOWN_SILENCE_MS: f64 = 90_000.0;
/// While down, let exactly one call through this often to test for recovery.
/// Without a probe the fail-fast below would be self-sealing: no requests, no
/// responses, no way to ever notice the webview came back.
const PROBE_EVERY_MS: f64 = 15_000.0;

fn now_ms() -> f64 {
    crate::hasher::types::now_millis()
}

/// A response arrived — including a late one for a call that already timed out,
/// and including an error response. Either way the webview is alive and talking.
fn note_response() {
    LAST_RESPONSE_MS.store(now_ms() as u64, Ordering::Relaxed);
    CONSEC_TIMEOUTS.store(0, Ordering::Relaxed);
}

fn note_timeout() {
    CONSEC_TIMEOUTS.fetch_add(1, Ordering::Relaxed);
}

/// Is the bridge unresponsive? Requires BOTH sustained timeouts and silence.
pub fn is_down() -> bool {
    if CONSEC_TIMEOUTS.load(Ordering::Relaxed) < DOWN_AFTER_TIMEOUTS {
        return false;
    }
    let last = LAST_RESPONSE_MS.load(Ordering::Relaxed) as f64;
    last <= 0.0 || now_ms() - last > DOWN_SILENCE_MS
}

/// Liveness for `structs_system status` / the watchdog.
pub fn health() -> serde_json::Value {
    let last = LAST_RESPONSE_MS.load(Ordering::Relaxed) as f64;
    serde_json::json!({
        "down": is_down(),
        "consecutive_timeouts": CONSEC_TIMEOUTS.load(Ordering::Relaxed),
        "silent_ms": if last > 0.0 { (now_ms() - last) as u64 } else { 0 },
        "ever_responded": last > 0.0,
        // The bridge can be perfectly alive while unable to LAND anything:
        // see the saturation notes above. Reported separately because during
        // the 2026-08-20 outage this page showed "ok" for 100 minutes.
        "client_saturated": is_saturated(),
        "consecutive_client_failures": CONSEC_CLIENT_FAILURES.load(Ordering::Relaxed),
    })
}

/// Reset after a remediation so the next window is judged on its own evidence
/// (a reload takes seconds; without this the stale count re-fires instantly).
pub fn note_remediated() {
    CONSEC_TIMEOUTS.store(0, Ordering::Relaxed);
    LAST_RESPONSE_MS.store(now_ms() as u64, Ordering::Relaxed);
}

// ── Signing-client saturation ────────────────────────────────────────────────
//
// A SECOND failure mode, disjoint from bridge death, found 2026-08-20: the
// webview ANSWERS every round-trip — so `is_down()` stays false and
// consecutive_timeouts stays 0 — but every answer is "signing client connect
// timed out": its per-host fetch pool is saturated, and each raced-out connect
// leaves its abandoned attempt QUEUED in that same pool. The state is
// metastable: our own 43-signs/min inflow re-saturates the pool faster than it
// drains, so it held for 100 minutes at exactly ~20.3s per failure and ended
// only when the WebContent process died (the black window). The only exit is
// to STOP THE INFLOW: fail fast for a cooldown so the pool drains, and probe
// for recovery on the same cadence the down-state uses.
static CONSEC_CLIENT_FAILURES: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

/// Consecutive in-webview signing-client failures before signs fail fast.
/// Five at ~20s each is ~100s of one-sided evidence; a mixed stream (some
/// succeed) resets on every success and never trips this.
const SATURATED_AFTER_FAILURES: u32 = 5;

/// The webview answered a sign with an error that means ITS OWN network stack
/// could not reach the node (pool saturation), not that the tx was rejected.
fn is_client_stack_error(err: &str) -> bool {
    err.contains("signing client connect timed out") || err.contains("signAndBroadcast timed out (WS)")
}

fn note_client_result(err: Option<&str>) {
    match err {
        Some(e) if is_client_stack_error(e) => {
            CONSEC_CLIENT_FAILURES.fetch_add(1, Ordering::Relaxed);
        }
        _ => {
            CONSEC_CLIENT_FAILURES.store(0, Ordering::Relaxed);
        }
    }
}

/// Is the webview's signing client saturated? (The bridge itself is ALIVE —
/// that is what makes this invisible to `is_down`.)
pub fn is_saturated() -> bool {
    CONSEC_CLIENT_FAILURES.load(Ordering::Relaxed) >= SATURATED_AFTER_FAILURES
}

/// Timeout for the liveness probe. It performs no network I/O, so an answer is
/// a few milliseconds of work — 10s is already an eternity.
const PROBE_TIMEOUT_SECS: u64 = 10;
static PROBE_INFLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Actively test the round-trip, so a bridge that dies while the app is IDLE is
/// still noticed. Detection that rides only on real traffic is detection that
/// arrives after the damage: the first mine to complete pays 60s to discover
/// what a 5ms probe already knew.
///
/// Uses the `list` op deliberately — pure JS, no network, no signing, no keys.
/// It answers one question and only one: is the webview listening and able to
/// call back into Rust? That also draws the distinction the old error message
/// fumbled ("is the app signed in?"): a façade that replies "unavailable" is an
/// ANSWER, so the bridge counts as alive and no reload is triggered. Reloading
/// the page because the human has not signed in yet would be a loop.
pub fn spawn_liveness_probe(app: &tauri::AppHandle) {
    if PROBE_INFLIGHT.swap(true, Ordering::SeqCst) {
        return; // one at a time
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = call(&app, "list", serde_json::json!({}), PROBE_TIMEOUT_SECS).await;
        PROBE_INFLIGHT.store(false, Ordering::SeqCst);
    });
}

/// How long the bridge may stay silent before the watchdog probes it.
pub fn silent_ms() -> f64 {
    let last = LAST_RESPONSE_MS.load(Ordering::Relaxed) as f64;
    if last <= 0.0 {
        return f64::MAX;
    }
    now_ms() - last
}

/// One caller per `PROBE_EVERY_MS` wins the right to test a down bridge.
fn claim_probe_slot() -> bool {
    let now = now_ms();
    let prev = LAST_PROBE_MS.load(Ordering::Relaxed) as f64;
    if now - prev < PROBE_EVERY_MS {
        return false;
    }
    LAST_PROBE_MS
        .compare_exchange(
            prev as u64,
            now as u64,
            Ordering::SeqCst,
            Ordering::Relaxed,
        )
        .is_ok()
}

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
    // Fail fast while the bridge is known dead — BEFORE taking the account lock or a
    // SIGN_GATE permit. Waiting the full 60s on a webview that is not listening does
    // not make the tx land; it just holds one of 8 permits hostage, so a dead bridge
    // used to cap the whole app at 8 doomed signs per minute and kept every caller
    // blocked for a minute apiece. One probe per PROBE_EVERY_MS still goes through, so
    // recovery is noticed without anyone asking.
    if matches!(op, "sign" | "signup") && is_down() && !claim_probe_slot() {
        let h = health();
        return Err(format!(
            "virtual-player bridge is not answering ({} consecutive timeouts, silent {}s) \
             — failing fast instead of queueing; the watchdog reloads the webview to recover",
            h["consecutive_timeouts"], h["silent_ms"].as_u64().unwrap_or(0) / 1000
        ));
    }
    // Saturation fail-fast: the bridge answers, but its signing client cannot
    // reach the node and every queued attempt DEEPENS the saturation (each
    // 20s-raced-out connect stays in the webview's fetch pool). Stopping the
    // inflow is the cure, not a concession: the pool drains in seconds once we
    // stop feeding it, and the probe slot notices recovery on its own.
    if matches!(op, "sign" | "signup") && is_saturated() && !claim_probe_slot() {
        return Err(format!(
            "signing client saturated ({} consecutive in-webview connect/broadcast failures) \
             — failing fast so the webview's connection pool can drain; probing for recovery",
            CONSEC_CLIENT_FAILURES.load(Ordering::Relaxed)
        ));
    }

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
            note_response();
            if resp.success {
                if op == "sign" {
                    note_client_result(None);
                }
                Ok(resp.data)
            } else {
                let err = resp.error.unwrap_or_else(|| "virtual-player op failed".to_string());
                if op == "sign" {
                    note_client_result(Some(&err));
                }
                Err(err)
            }
        }
        Ok(Err(_)) => {
            cleanup(&req_id).await;
            Err("virtual-player bridge channel closed".to_string())
        }
        Err(_) => {
            cleanup(&req_id).await;
            note_timeout();
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
/// How the façade returns a sign: `sync` waits for block inclusion (the
/// DeliverTx result comes back inline, p50 6.1 s); `async` returns once the
/// mempool accepts the tx and the settlement arrives later as a `tx_settled`
/// event. Set from `McpConfig::sign_mode` at startup and at runtime via
/// `structs_system config set {sign_mode}`.
static SIGN_ASYNC: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn sign_mode() -> &'static str {
    if SIGN_ASYNC.load(std::sync::atomic::Ordering::Relaxed) {
        "async"
    } else {
        "sync"
    }
}

/// Returns false (and changes nothing) for an unknown mode.
pub fn set_sign_mode(mode: &str) -> bool {
    match mode {
        "async" => SIGN_ASYNC.store(true, std::sync::atomic::Ordering::Relaxed),
        "sync" => SIGN_ASYNC.store(false, std::sync::atomic::Ordering::Relaxed),
        _ => return false,
    }
    true
}

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
        serde_json::json!({ "index": index, "type_url": type_url, "payload": payload, "mode": sign_mode() }),
        timeout_secs,
    )
    .await
}

async fn cleanup(req_id: &str) {
    INFLIGHT.lock().await.remove(req_id);
}

pub async fn resolve(resp: VPlayerResponse) {
    // Stamp liveness BEFORE the lookup: a response whose caller already gave up
    // is still proof that the webview is answering, and it is exactly the signal
    // that ends a fail-fast window early.
    note_response();
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

#[cfg(test)]
mod health_tests {
    use super::*;

    /// These assertions drive process-global liveness statics, so they must not
    /// interleave with each other.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn reset() {
        CONSEC_TIMEOUTS.store(0, Ordering::SeqCst);
        LAST_RESPONSE_MS.store(0, Ordering::SeqCst);
        LAST_PROBE_MS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn a_bridge_that_answers_is_never_down() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset();
        // Even a long run of timeouts does not condemn a bridge that is also
        // answering: a busy app times individual calls out while healthy.
        for _ in 0..10 {
            note_timeout();
            note_response();
        }
        assert!(!is_down(), "responses must clear the timeout streak");
        reset();
    }

    #[test]
    fn sustained_timeouts_plus_silence_is_down() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset();
        // Fresh silence (last response = now) is not yet down…
        note_response();
        for _ in 0..DOWN_AFTER_TIMEOUTS {
            note_timeout();
        }
        assert!(!is_down(), "recent response means the silence test fails");

        // …but the same streak with the last response well in the past is.
        LAST_RESPONSE_MS.store((now_ms() - DOWN_SILENCE_MS - 1_000.0) as u64, Ordering::SeqCst);
        assert!(is_down(), "sustained timeouts + silence = down");

        // One late answer is enough to call it back.
        note_response();
        assert!(!is_down(), "a single response ends the outage");
        reset();
    }

    #[test]
    fn a_bridge_that_never_answered_needs_the_full_streak() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset();
        note_timeout();
        assert!(!is_down(), "one timeout is not evidence");
        for _ in 1..DOWN_AFTER_TIMEOUTS {
            note_timeout();
        }
        assert!(is_down(), "never-answered + full streak = down");
        reset();
    }

    #[test]
    fn probe_slot_is_rate_limited_but_always_reopens() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset();
        assert!(claim_probe_slot(), "first probe goes through");
        assert!(!claim_probe_slot(), "second is throttled");
        // Backdate the last probe: the window must reopen, or a fail-fast
        // bridge would never be retested and could never be seen to recover.
        LAST_PROBE_MS.store((now_ms() - PROBE_EVERY_MS - 1_000.0) as u64, Ordering::SeqCst);
        assert!(claim_probe_slot(), "window reopens after PROBE_EVERY_MS");
        reset();
    }
}
