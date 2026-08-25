//! Shared ledgered submit path for automation-initiated transactions.
//!
//! Every auto-loop (and the team-level tools) used to call the signing bridges
//! directly and silently drop failures. These wrappers make each attempt an
//! auditable `tx_attempts` row and feed the AIMD concurrency controller in
//! `loop_util` so a struggling node automatically shrinks the fan-out instead
//! of being hammered by 182 players' worth of scans.
//!
//! RETRY POLICY — resubmit only when non-inclusion is CERTAIN:
//! * `SequenceMismatch` is the ONLY auto-retried class: the node rejected the
//!   tx at CheckTx with the account sequence intact, so it definitively did
//!   NOT land; waiting one block and re-signing is the documented remedy.
//! * `Timeout` / `BridgeDown` / `RateLimited` are UNCERTAIN-OUTCOME: the tx
//!   may have committed on-chain with only the ack lost (e.g. block inclusion
//!   slower than the 60s bridge timeout). Blindly re-signing with a fresh
//!   sequence would double-execute — a second reactor infuse burns alpha
//!   twice, a second strike double-fires. These classes are recorded, feed
//!   the AIMD pressure signal, and return an error so the CALLER re-assesses:
//!   the loops re-derive intent from chain state on their next scan, which is
//!   the safe form of "retry".
//! * Deterministic rejections (insufficient charge/funds, player offline,
//!   invalid target) are never retried — the state that caused them won't
//!   change within a retry budget, and each retry burns a SIGN_GATE permit.

use serde_json::Value;
use std::time::Duration;

use crate::hasher::types::now_millis;
use crate::mcp::error_translator::translate_error;
use crate::mcp::telemetry::{self, TxAttemptRow};
use crate::mcp::{loop_util, tx_queue, vplayer_bridge};

/// Max attempts per submit (1 initial + 2 retries), sequence-mismatch only.
const MAX_ATTEMPTS: u32 = 3;
/// Sequence mismatch: the chain frees the account after the pending tx's
/// block; ~6s block time + margin.
const SEQ_RETRY_BASE_MS: u64 = 7_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    SequenceMismatch,
    InsufficientCharge,
    InsufficientFunds,
    PlayerOffline,
    InvalidTarget,
    RateLimited,
    Timeout,
    BridgeDown,
    Other,
}

impl ErrorClass {
    /// Whether the tx DEFINITIVELY did not land, making a resubmit safe.
    /// Only SequenceMismatch qualifies — every other failure class is either
    /// deterministic (retry can't help) or uncertain-outcome (retry can
    /// double-execute; see module docs).
    fn retryable(self) -> bool {
        matches!(self, ErrorClass::SequenceMismatch)
    }

    /// The `tx_attempts.outcome` value for a failed attempt of this class.
    fn outcome(self) -> &'static str {
        match self {
            ErrorClass::RateLimited => "rate_limited",
            ErrorClass::Timeout => "timeout",
            ErrorClass::BridgeDown => "bridge_error",
            ErrorClass::InsufficientCharge
            | ErrorClass::InsufficientFunds
            | ErrorClass::PlayerOffline
            | ErrorClass::InvalidTarget => "skipped",
            _ => "chain_error",
        }
    }

    fn delay_ms(self, _attempt: u32) -> u64 {
        // Only SequenceMismatch is ever retried (see `retryable`).
        SEQ_RETRY_BASE_MS
    }

    /// Endpoint pressure (as opposed to per-account state) — feeds AIMD.
    ///
    /// `BridgeDown` is deliberately NOT pressure. It means our own webview
    /// stopped answering the signing round-trip; the node may be answering in
    /// 20ms. Counting it halved READ-loop concurrency (5 of a possible 24)
    /// during the 2026-08-20 outage — throttling the one subsystem that still
    /// worked, and slowing the scans needed to recover. Feeding AIMD from a
    /// local failure makes the app punish itself for a fault the endpoint had
    /// no part in.
    fn is_pressure(self) -> bool {
        matches!(self, ErrorClass::RateLimited | ErrorClass::Timeout)
    }
}

pub fn classify(raw: &str) -> ErrorClass {
    let l = raw.to_lowercase();
    if l.contains("account sequence mismatch") {
        ErrorClass::SequenceMismatch
    } else if l.contains("insufficient charge") || l.contains("code 7") {
        ErrorClass::InsufficientCharge
    } else if l.contains("insufficient funds") || l.contains("code 2:") {
        ErrorClass::InsufficientFunds
    } else if l.contains("player halted") || l.contains("code 6") {
        ErrorClass::PlayerOffline
    } else if l.contains("invalid target")
        || l.contains("code 9")
        || l.contains("invalid location")
        || l.contains("code 8")
    {
        ErrorClass::InvalidTarget
    } else if l.contains("429") || l.contains("too many requests") || l.contains("rate limit") {
        ErrorClass::RateLimited
    } else if l.contains("channel closed")
        || l.contains("failed to emit")
        || l.contains("gate closed")
        || l.contains("bridge")
        || l.contains("virtual-player op")
        || l.contains("tx-queue op")
        || l.contains("façade unavailable")
        || l.contains("facade unavailable")
        // The webview's own signing client failing to CONNECT (the 20s bound
        // added 2026-08-20) is a saturation of the webview's per-host fetch
        // pool, not node slowness — the node kept answering native LCD reads
        // throughout the 100-minute outage where this string was 100% of
        // failures. Classified as Timeout it fed endpoint AIMD and throttled
        // the read loops: the exact self-harm this branch exists to prevent,
        // introduced the same morning as the branch. Keep them in sync.
        || l.contains("signing client connect")
    {
        // BEFORE the generic timeout test on purpose. The bridge's own message
        // is "virtual-player op 'sign' timed out after 60s (is the app signed
        // in?)" — it contains "timed out", so it used to classify as Timeout
        // and feed endpoint AIMD. The distinction that matters is not "did we
        // wait" but "who failed to answer": the node, or our own webview.
        ErrorClass::BridgeDown
    } else if l.contains("timed out") || l.contains("timeout") {
        ErrorClass::Timeout
    } else {
        ErrorClass::Other
    }
}

/// Cheap jitter (±50%) without a rand dependency: fold the sub-millisecond
/// clock bits. Good enough to de-synchronize retry stampedes.
fn jitter(base_ms: u64) -> u64 {
    let frac = (now_millis().fract() * 1000.0) as u64 % 100; // 0..100
    base_ms / 2 + base_ms * frac / 100
}

/// Player id parsed from the "<source>:<player_id>" context convention.
fn player_from_context(context: &str) -> Option<String> {
    context.split(':').nth(1).filter(|s| !s.is_empty()).map(String::from)
}

enum AttemptResult {
    /// Bridge round-trip ok and chain accepted (code 0).
    Success { tx_hash: Option<String>, value: Value },
    /// Definitive failure this attempt (raw error, chain code if any).
    Failure { raw: String, code: Option<i64> },
}

/// Log a transaction the instant it is built, before the signer is handed it.
/// `tx_attempts` only ever held OUTCOMES, so a tx that was built and then never
/// answered for (app quit mid-flight, façade silent, queue dropped it) left no
/// evidence it had ever existed. Payloads are game messages — no keys, no
/// credentials — so they are stored verbatim for replay/diagnosis.
fn log_build(context: &str, action: &str, attempt: u32, payload: Option<&Value>) {
    telemetry::record_tx_build(telemetry::TxBuildRow {
        ts_ms: now_millis(),
        context: context.to_string(),
        action: action.to_string(),
        player_id: player_from_context(context),
        attempt,
        priority: crate::mcp::tx_gate::classify(context).as_str(),
        payload: payload.map(|p| p.to_string()),
    });
}

fn record(
    context: &str,
    action: &str,
    attempt: u32,
    started_ms: f64,
    res: &AttemptResult,
) -> Option<ErrorClass> {
    let duration_ms = now_millis() - started_ms;
    match res {
        AttemptResult::Success { tx_hash, .. } => {
            telemetry::record_tx_attempt(TxAttemptRow {
                ts_ms: now_millis(),
                context: context.to_string(),
                action: action.to_string(),
                player_id: player_from_context(context),
                attempt,
                outcome: "success",
                tx_hash: tx_hash.clone(),
                code: Some(0),
                raw_error: None,
                translated: None,
                duration_ms,
            });
            None
        }
        AttemptResult::Failure { raw, code } => {
            let class = classify(raw);
            telemetry::record_tx_attempt(TxAttemptRow {
                ts_ms: now_millis(),
                context: context.to_string(),
                action: action.to_string(),
                player_id: player_from_context(context),
                attempt,
                outcome: class.outcome(),
                tx_hash: None,
                code: *code,
                raw_error: Some(raw.clone()),
                translated: Some(translate_error(raw)),
                duration_ms,
            });
            if class.is_pressure() {
                loop_util::report_failure();
            }
            Some(class)
        }
    }
}

/// Sign & broadcast as a vplayer (HD `index`), with classification, ledger
/// rows, and bounded retries. Returns the chain response Value on success or
/// the translated error after the final attempt.
pub async fn sign_with_retry(
    app: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    context: &str,
) -> Result<Value, String> {
    sign_with_retry_guarded(app, index, type_url, payload, context, None).await
}

/// A proof-of-work completion's precondition, re-tested immediately before the
/// message is broadcast.
///
/// A completion carries `{structId, proof, nonce}` and NO anchor: the chain
/// rebuilds the hashed input from ITS OWN current clock, so the proof is valid
/// only while that clock still reads what we solved against. Checking that at
/// dispatch proves nothing, because the admission gate then holds the message
/// for as long as the backlog takes to drain — measured at 29 to 94 minutes
/// (avg 61) while ~2,400 simultaneously-ripe proofs queued behind a façade that
/// signs about one per block. The planet's shared ore clock moves during that
/// wait, so 22% of completions arrived stale and were spent on a certain
/// rejection. Re-testing here turns each of those into a free skip that also
/// hands the slot straight back, which drains the backlog faster.
pub struct FreshAnchor {
    /// The planet carrying the shared ore clock (resolved off the hot path).
    pub planet_id: String,
    /// "MINE" or "REFINE".
    pub task_type: String,
    /// The anchor the proof was actually solved against.
    pub solved_anchor: u64,
}

impl FreshAnchor {
    /// True when the chain's clock has moved away from what we solved against.
    /// A read failure or a 0 reads as "unknown" and never blocks — this guard
    /// may only ever cancel a send it is certain is already dead.
    async fn is_stale(&self) -> bool {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let Ok(p) = client.query_entity("planet", &self.planet_id).await else {
            return false;
        };
        let live = crate::mcp::loop_util::planet_ore_anchor(Some(&p), &self.task_type);
        live != 0 && live != self.solved_anchor
    }
}

pub async fn sign_with_retry_guarded(
    app: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    context: &str,
    guard: Option<FreshAnchor>,
) -> Result<Value, String> {
    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        // Admission gate: keeps the signing façade's own FIFO shallow so a
        // deadline-bound combat answer isn't stuck behind hundreds of bulk
        // builds. Held for the attempt; released on success, failure or cancel.
        let _slot = crate::mcp::tx_gate::acquire(context).await;
        let slot_won = now_millis();
        // The wait above can be an hour deep. Re-test the proof's anchor now
        // that we hold the slot, so a message the chain is guaranteed to reject
        // is dropped here instead of costing a full sign round-trip.
        if let Some(g) = &guard {
            if g.is_stale().await {
                telemetry::record_tx_attempt(TxAttemptRow {
                    ts_ms: now_millis(),
                    context: context.to_string(),
                    action: type_url.to_string(),
                    player_id: player_from_context(context),
                    attempt,
                    outcome: "skipped",
                    tx_hash: None,
                    code: None,
                    raw_error: Some("ore clock moved while this proof waited to be signed".to_string()),
                    translated: None,
                    duration_ms: now_millis() - slot_won,
                });
                return Err("stale: the planet's ore clock moved while this proof waited to be signed".into());
            }
        }
        let started = now_millis();
        log_build(context, type_url, attempt, Some(&payload));
        let res = vplayer_bridge::sign_action(app, index, type_url, payload.clone(), 60).await;
        let outcome = match res {
            Ok(v) => {
                let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                if code == 0 {
                    AttemptResult::Success {
                        tx_hash: v
                            .get("transactionHash")
                            .or_else(|| v.get("txhash"))
                            .and_then(|h| h.as_str())
                            .map(String::from),
                        value: v,
                    }
                } else {
                    let raw = v
                        .get("rawLog")
                        .or_else(|| v.get("raw_log"))
                        .and_then(|r| r.as_str())
                        .map(String::from)
                        .unwrap_or_else(|| format!("code {code}: {v}"));
                    AttemptResult::Failure { raw, code: Some(code) }
                }
            }
            Err(e) => AttemptResult::Failure { raw: e, code: None },
        };
        match record(context, type_url, attempt, started, &outcome) {
            None => {
                if let AttemptResult::Success { value, .. } = outcome {
                    // This player has now spent its once-per-block charge.
                    // Recorded centrally so the OTHER loops sweeping the same
                    // roster concurrently can skip it instead of racing into a
                    // certain code-2022 reject. See loop_util::acted_this_block.
                    if crate::mcp::loop_util::is_charged_type(type_url) {
                        if let Some(pid) = crate::mcp::loop_util::player_from_context(context) {
                            crate::mcp::loop_util::note_charged_action(pid);
                        }
                    }
                    return Ok(value);
                }
                unreachable!("success outcome without value");
            }
            Some(class) => {
                if let AttemptResult::Failure { raw, .. } = &outcome {
                    last_err = raw.clone();
                }
                if class.retryable() && attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(jitter(class.delay_ms(attempt)))).await;
                    continue;
                }
                break;
            }
        }
    }
    Err(translate_error(&last_err))
}

/// Submit a PRIMARY-player transaction through the webview bridge, with the
/// same ledger + retry semantics as `sign_with_retry`.
pub async fn submit_with_retry(
    app: &tauri::AppHandle,
    action: &str,
    args: Value,
    context: &str,
) -> Result<tx_queue::TxResponse, String> {
    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        // Primary-player txs share the same façade, so they share the gate.
        let _slot = crate::mcp::tx_gate::acquire(context).await;
        let started = now_millis();
        log_build(context, action, attempt, Some(&args));
        let res = tx_queue::submit_tx(app, action.to_string(), args.clone()).await;
        let outcome = match res {
            Ok(resp) if resp.success => {
                let r = AttemptResult::Success { tx_hash: resp.tx_hash.clone(), value: Value::Null };
                record(context, action, attempt, started, &r);
                return Ok(resp);
            }
            Ok(resp) => AttemptResult::Failure {
                raw: resp.error.unwrap_or_else(|| "transaction failed".into()),
                code: None,
            },
            Err(e) => AttemptResult::Failure { raw: e, code: None },
        };
        if let Some(class) = record(context, action, attempt, started, &outcome) {
            if let AttemptResult::Failure { raw, .. } = &outcome {
                last_err = raw.clone();
            }
            if class.retryable() && attempt < MAX_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(jitter(class.delay_ms(attempt)))).await;
                continue;
            }
            break;
        }
    }
    Err(translate_error(&last_err))
}

/// Single recorded VPLAYER sign attempt, NO retry — for interactive MCP paths
/// (`structs_players act`) where the connected agent decides what happens
/// next; the ledger still sees the attempt. Returns the chain response Value
/// on success (code 0) or the translated error.
pub async fn sign_once(
    app: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    context: &str,
) -> Result<Value, String> {
    let started = now_millis();
    let res = vplayer_bridge::sign_action(app, index, type_url, payload, 60).await;
    let outcome = match res {
        Ok(v) => {
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
            if code == 0 {
                AttemptResult::Success {
                    tx_hash: v
                        .get("transactionHash")
                        .or_else(|| v.get("txhash"))
                        .and_then(|h| h.as_str())
                        .map(String::from),
                    value: v,
                }
            } else {
                let raw = v
                    .get("rawLog")
                    .or_else(|| v.get("raw_log"))
                    .and_then(|r| r.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("code {code}: {v}"));
                AttemptResult::Failure { raw, code: Some(code) }
            }
        }
        Err(e) => AttemptResult::Failure { raw: e, code: None },
    };
    record(context, type_url, 1, started, &outcome);
    match outcome {
        AttemptResult::Success { value, .. } => Ok(value),
        AttemptResult::Failure { raw, .. } => Err(translate_error(&raw)),
    }
}

/// Single recorded attempt, NO retry — for interactive MCP paths where the
/// connected agent is itself the retry loop, but the ledger should still see
/// every attempt. Same row shape as the retrying wrappers.
pub async fn submit_once(
    app: &tauri::AppHandle,
    action: &str,
    args: Value,
    context: &str,
) -> Result<tx_queue::TxResponse, String> {
    let started = now_millis();
    let res = tx_queue::submit_tx(app, action.to_string(), args).await;
    let outcome = match &res {
        Ok(resp) if resp.success => AttemptResult::Success { tx_hash: resp.tx_hash.clone(), value: Value::Null },
        Ok(resp) => AttemptResult::Failure {
            raw: resp.error.clone().unwrap_or_else(|| "transaction failed".into()),
            code: None,
        },
        Err(e) => AttemptResult::Failure { raw: e.clone(), code: None },
    };
    record(context, action, 1, started, &outcome);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_matches_chain_vocabulary() {
        assert_eq!(classify("account sequence mismatch, expected 5, got 4"), ErrorClass::SequenceMismatch);
        assert_eq!(classify("failed: insufficient charge"), ErrorClass::InsufficientCharge);
        assert_eq!(classify("code 7"), ErrorClass::InsufficientCharge);
        assert_eq!(classify("player halted"), ErrorClass::PlayerOffline);
        assert_eq!(classify("HTTP 429 Too Many Requests"), ErrorClass::RateLimited);
        // A bridge timeout is a BRIDGE failure, not endpoint slowness — even
        // though its text says "timed out". Regression guard for the outage
        // where this misread throttled the read loops instead of the webview.
        assert_eq!(classify("virtual-player op 'sign' timed out after 60s"), ErrorClass::BridgeDown);
        assert_eq!(classify("virtual-player bridge channel closed"), ErrorClass::BridgeDown);
        assert_eq!(classify("tx-queue op 'snapshot' timed out after 30s"), ErrorClass::BridgeDown);
        // The webview's signing client failing to CONNECT is the same family:
        // OUR side is saturated, the node may be fine. During the 2026-08-20
        // crash this string was 1,400+ failures classified as endpoint
        // pressure, halving read concurrency while the endpoint was healthy.
        assert_eq!(classify("signing client connect timed out"), ErrorClass::BridgeDown);
        // A genuine endpoint timeout still classifies as Timeout.
        assert_eq!(classify("error sending request: operation timed out"), ErrorClass::Timeout);
        assert_eq!(classify("something novel"), ErrorClass::Other);
    }

    #[test]
    fn retry_policy_shape() {
        // ONLY sequence mismatch (definitively-not-included) may resubmit.
        assert!(ErrorClass::SequenceMismatch.retryable());
        // Uncertain-outcome classes must NEVER auto-retry — the tx may have
        // landed with only the ack lost; a resubmit would double-execute
        // (double infuse, double strike). This is the regression guard for
        // the reported double-execution bug.
        assert!(!ErrorClass::Timeout.retryable());
        assert!(!ErrorClass::BridgeDown.retryable());
        assert!(!ErrorClass::RateLimited.retryable());
        // Deterministic rejections never retry either.
        assert!(!ErrorClass::InsufficientCharge.retryable());
        assert!(!ErrorClass::Other.retryable());
        assert_eq!(ErrorClass::InsufficientCharge.outcome(), "skipped");
        assert_eq!(ErrorClass::Timeout.outcome(), "timeout");
        assert_eq!(ErrorClass::SequenceMismatch.delay_ms(1), 7_000);
        // Uncertain classes still count as pressure for the AIMD controller.
        assert!(ErrorClass::Timeout.is_pressure());
        assert!(ErrorClass::RateLimited.is_pressure());
        // Our own webview failing is not the endpoint's fault: it must never
        // throttle the read loops.
        assert!(!ErrorClass::BridgeDown.is_pressure());
        assert!(!ErrorClass::SequenceMismatch.is_pressure());
    }

    #[test]
    fn jitter_stays_in_band() {
        for _ in 0..50 {
            let j = jitter(2_000);
            assert!((1_000..=3_000).contains(&j), "jitter {j} out of ±50% band");
        }
    }

    #[test]
    fn player_id_from_context() {
        assert_eq!(player_from_context("auto_build:1-271"), Some("1-271".into()));
        assert_eq!(player_from_context("mcp"), None);
    }
}
