//! Shared ledgered submit path for automation-initiated transactions.
//!
//! Every auto-loop (and the team-level tools) used to call the signing bridges
//! directly and silently drop failures. These wrappers make each attempt an
//! auditable `tx_attempts` row and feed the AIMD concurrency controller in
//! `loop_util` so a struggling node automatically shrinks the fan-out instead
//! of being hammered by 182 players' worth of scans.
//!
//! RETRY POLICY — resubmit only when non-inclusion is CERTAIN:
//! * `SequenceMismatch` is auto-retried: the node rejected the tx at CheckTx
//!   with the account sequence intact, so it definitively did NOT land;
//!   waiting one block and re-signing is the documented remedy.
//! * `BlockQuota` (v0.22 ante 2031/2033/2040/2041/2043) is auto-retried too:
//!   rejected at CheckTx, or included and FAILED as a whole at delivery —
//!   either way nothing executed, and the quota resets next block.
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
    /// Proof-of-work rejected by the keeper ("work failure for input …").
    WorkFailure,
    InsufficientCharge,
    InsufficientFunds,
    PlayerOffline,
    InvalidTarget,
    /// A per-block quota at admission or delivery (v0.22 ante 2031/2033/
    /// 2040/2041/2043): the player's 40-message cap, the per-address CheckTx
    /// cap, the one-staking-op rule, a per-object throttle. The transaction did
    /// not execute and the quota resets next block.
    BlockQuota,
    RateLimited,
    Timeout,
    BridgeDown,
    Other,
}

impl ErrorClass {
    /// Whether the tx DEFINITIVELY did not land, making a resubmit safe.
    /// SequenceMismatch and BlockQuota qualify — every other failure class is either
    /// deterministic (retry can't help) or uncertain-outcome (retry can
    /// double-execute; see module docs).
    fn retryable(self) -> bool {
        matches!(self, ErrorClass::SequenceMismatch | ErrorClass::BlockQuota)
    }

    /// The `tx_attempts.outcome` value for a failed attempt of this class.
    fn outcome(self) -> &'static str {
        match self {
            ErrorClass::RateLimited => "rate_limited",
            ErrorClass::Timeout => "timeout",
            ErrorClass::BridgeDown => "bridge_error",
            ErrorClass::WorkFailure => "work_failure",
            ErrorClass::BlockQuota => "block_quota",
            ErrorClass::InsufficientCharge
            | ErrorClass::InsufficientFunds
            | ErrorClass::PlayerOffline
            | ErrorClass::InvalidTarget => "skipped",
            _ => "chain_error",
        }
    }

    fn delay_ms(self, _attempt: u32) -> u64 {
        // Both retryable classes clear at the next block (see `retryable`).
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

/// "429" as an HTTP status, not as three digits inside a nonce or a block
/// height: neither neighbour may be a digit.
fn standalone_429(l: &str) -> bool {
    let b = l.as_bytes();
    let mut from = 0;
    while let Some(off) = l[from..].find("429") {
        let i = from + off;
        let before_digit = i > 0 && b[i - 1].is_ascii_digit();
        let after_digit = b.get(i + 3).map_or(false, |c| c.is_ascii_digit());
        if !before_digit && !after_digit {
            return true;
        }
        from = i + 3;
    }
    false
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
    } else if l.contains("exceeded per-block message cap")
        || l.contains("exceeded checktx free-tx cap")
        || l.contains("already submitted a free staking tx this block")
        || l.contains("already attempted this block")
        || l.contains("is throttled for this block")
    {
        ErrorClass::BlockQuota
    } else if l.contains("work failure") {
        // The proof's anchor disagreed with the chain's clock. Deterministic,
        // and NOT endpoint pressure — this used to fall through to the "429"
        // test below, which matched the digits inside the proof's nonce and
        // fed every stale-anchor rejection into AIMD as throttling.
        ErrorClass::WorkFailure
    } else if standalone_429(&l) || l.contains("too many requests") || l.contains("rate limit") {
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

use crate::mcp::types::Context;

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
fn log_build(context: &Context, action: &str, attempt: u32, payload: Option<&Value>) {
    telemetry::record_tx_build(telemetry::TxBuildRow {
        ts_ms: now_millis(),
        context: context.to_string(),
        action: action.to_string(),
        player_id: context.subject().map(String::from),
        attempt,
        priority: crate::mcp::tx_gate::classify(context.as_str()).as_str(),
        payload: payload.map(|p| p.to_string()),
    });
}

fn record(
    context: &Context,
    action: &str,
    attempt: u32,
    started_ms: f64,
    res: &AttemptResult,
) -> Option<ErrorClass> {
    let duration_ms = now_millis() - started_ms;
    match res {
        AttemptResult::Success { tx_hash, .. } => {
            crate::mcp::game_stats::note_our_tx();
            telemetry::record_tx_attempt(TxAttemptRow {
                ts_ms: now_millis(),
                context: context.to_string(),
                action: action.to_string(),
                player_id: context.subject().map(String::from),
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
                player_id: context.subject().map(String::from),
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

/// Record a send the mirror's gate refused: the chain was certain to reject
/// it, so no transaction was spent. Returns the caller's error.
fn gate_refusal(context: &Context, action: &str, attempt: u32, since: f64, d: &crate::mirror::gate::Decision) -> String {
    telemetry::record_tx_attempt(TxAttemptRow {
        ts_ms: now_millis(),
        context: context.to_string(),
        action: action.to_string(),
        player_id: context.subject().map(String::from),
        attempt,
        outcome: "skipped",
        tx_hash: None,
        code: None,
        raw_error: Some(format!("mirror {}: {}", d.rule, d.detail)),
        translated: None,
        duration_ms: now_millis() - since,
    });
    format!("skipped by the mirror ({}): {}", d.rule, d.detail)
}

/// A mandate in the standing orders caps this loop and the cap is reached.
fn mandate_refusal(context: &Context, action: &str, why: &str) -> String {
    telemetry::record_tx_attempt(TxAttemptRow {
        ts_ms: now_millis(),
        context: context.to_string(),
        action: action.to_string(),
        player_id: context.subject().map(String::from),
        attempt: 1,
        outcome: "skipped",
        tx_hash: None,
        code: None,
        raw_error: Some(format!("mandate: {why}")),
        translated: None,
        duration_ms: 0.0,
    });
    format!("skipped by a mandate: {why}")
}

fn mandate_check(context: &Context) -> Option<String> {
    crate::mcp::mandate::exceeds(&crate::mcp::mandate::live(), context.as_str(), now_millis())
}

/// Sign & broadcast as a vplayer (HD `index`), with classification, ledger
/// rows, and bounded retries. Returns the chain response Value on success or
/// the translated error after the final attempt.
pub async fn sign_with_retry(
    app: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    context: impl Into<Context>,
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
    pub planet_id: crate::mcp::types::PlanetId,
    /// Mine or refine — the two kinds with a planet clock.
    pub task_type: crate::mcp::types::TaskType,
    /// The anchor the proof was actually solved against.
    pub solved_anchor: crate::mcp::types::Block,
}

impl FreshAnchor {
    /// True when the chain's clock has moved away from what we solved against.
    /// A read failure or a 0 reads as "unknown" and never blocks — this guard
    /// may only ever cancel a send it is certain is already dead.
    async fn is_stale(&self) -> bool {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let Ok(live) = crate::mcp::verify::ore_anchor(&client, &self.planet_id, self.task_type).await else {
            return false;
        };
        !live.is_zero() && live != self.solved_anchor
    }
}

pub async fn sign_with_retry_guarded(
    app: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    context: impl Into<Context>,
    guard: Option<FreshAnchor>,
) -> Result<Value, String> {
    let context: Context = context.into();
    let context = &context;
    let mut last_err = String::new();
    // RESERVE the player's once-per-block charge for the whole attempt —
    // queue wait, sign, inclusion — not just after it lands. The gate wait
    // (~26 s at 17 deep) plus a block of inclusion is a window in which the
    // other loops used to verify the same player against a clean ledger and
    // queue a tx the chain was certain to reject: "required charge of 8 but
    // player only had 6" (12 in 45 min, each a wasted 6 s sign slot AND a
    // 30-minute initiate backoff) and code 2022 "already discharged". See
    // loop_util::acted_this_block. Released on drop (any exit path).
    let _reservation = if crate::mcp::loop_util::is_charged_type(type_url) {
        context.player().and_then(crate::mcp::loop_util::reserve_charge)
    } else {
        None
    };
    // A proof that ripens within a few blocks waits for its height here,
    // before taking a signing slot, instead of being spent on a certain
    // rejection; anything the gate is certain of is refused without a tx.
    let t_gate = now_millis();
    if let Some(d) = crate::mirror::gate::ripen(type_url, &payload).await {
        if d.refused() {
            return Err(gate_refusal(context, type_url, 1, t_gate, &d));
        }
    }
    if let Some(why) = mandate_check(context) {
        return Err(mandate_refusal(context, type_url, &why));
    }
    // What the mirror expects this message to do, checked once it lands.
    let prediction = crate::mirror::preview::predict(type_url, &payload);
    for attempt in 1..=MAX_ATTEMPTS {
        // Admission gate: keeps the signing façade's own FIFO shallow so a
        // deadline-bound combat answer isn't stuck behind hundreds of bulk
        // builds. Held for the attempt; released on success, failure or cancel.
        let _slot = crate::mcp::capacity::acquire_tx(context.as_str()).await;
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
                    player_id: context.subject().map(String::from),
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
        // Re-judge now that the slot is ours: the wait can be long, and
        // another loop's charged action for the same player may have landed
        // meanwhile (auto_build's initiate and auto_defend's set/clear are
        // decided in the same tick). Let a sibling's in-flight action clear
        // the block window first, then ask the mirror — the chain's own
        // charge rule against the type's own cost — and SKIP (no tx, no
        // back-off) anything it is certain the chain would refuse.
        if loop_util::is_charged_type(type_url) {
            if let Some(pid) = context.player() {
                let t0 = now_millis();
                while (loop_util::charge_reservations(pid) > 1 || loop_util::charged_this_block(pid))
                    && now_millis() - t0 < 12_000.0
                {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
        if let Some(d) = crate::mirror::gate::check_message(type_url, &payload) {
            if d.refused() {
                return Err(gate_refusal(context, type_url, attempt, slot_won, &d));
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
                        if let Some(pid) = context.player() {
                            crate::mcp::loop_util::note_charged_action(pid);
                            // Async: accepted, not landed — hold the player
                            // until the settler sees its block.
                            if value.get("async").and_then(|a| a.as_bool()) == Some(true) {
                                if let Some(h) = value.get("transactionHash").and_then(|h| h.as_str()) {
                                    crate::mcp::loop_util::note_charged_unlanded(pid, h);
                                }
                            }
                        }
                    }
                    // Our own action landed: a mine completion folds its
                    // known next ripening into the harvest plan; anything else
                    // that moved an economy input makes the loops re-forecast.
                    crate::mcp::schedule::landed_with(type_url, &payload);
                    crate::mcp::mandate::note_landed(context.as_str(), now_millis());
                    if let Some(p) = prediction {
                        crate::mirror::preview::landed(p);
                    }
                    return Ok(value);
                }
                unreachable!("success outcome without value");
            }
            Some(class) => {
                if let AttemptResult::Failure { raw, code } = &outcome {
                    last_err = raw.clone();
                    // A refusal by the chain itself (it answered with a code),
                    // not a transport failure: count it against the mirror.
                    if code.is_some_and(|c| c != 0) && !class.retryable() {
                        if let Some(p) = &prediction {
                            crate::mirror::preview::refused(p, raw);
                        }
                    }
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
    context: impl Into<Context>,
) -> Result<tx_queue::TxResponse, String> {
    let context: Context = context.into();
    let context = &context;
    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        // Primary-player txs share the same façade, so they share the gate.
        let _slot = crate::mcp::capacity::acquire_tx(context.as_str()).await;
        let started = now_millis();
        if let Some(d) = crate::mirror::gate::check_webview(action, &args) {
            if d.refused() {
                return Err(gate_refusal(context, action, attempt, started, &d));
            }
        }
        if let Some(why) = mandate_check(context) {
            return Err(mandate_refusal(context, action, &why));
        }
        log_build(context, action, attempt, Some(&args));
        let res = tx_queue::submit_tx(app, action.to_string(), args.clone()).await;
        let outcome = match res {
            Ok(resp) if resp.success => {
                let r = AttemptResult::Success { tx_hash: resp.tx_hash.clone(), value: Value::Null };
                record(context, action, attempt, started, &r);
                crate::mcp::schedule::landed(action);
                crate::mcp::mandate::note_landed(context.as_str(), now_millis());
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

/// Sign one message as the PRIMARY with the device key (HD index 0 — the key
/// the game window signed in with, a registered key of the primary), on our
/// own signer, one attempt.
///
/// For the primary's non-gameplay messages (allocations, substations, guild
/// settings, vault sends). The v0.22 webapp queue refuses anything that is
/// not a gameplay/transfer/reactor/generator INTENT once the chain is on the
/// new protocol, and the pinned webapp cannot encode the new messages; this
/// path works under both. Returns the chain response, not a "queued" ack.
pub async fn sign_as_primary(
    app: &tauri::AppHandle,
    type_url: &str,
    payload: Value,
    context: impl Into<Context>,
) -> Result<Value, String> {
    sign_once(app, 0, type_url, payload, context).await
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
    context: impl Into<Context>,
) -> Result<Value, String> {
    let context: Context = context.into();
    let context = &context;
    let started = now_millis();
    if let Some(d) = crate::mirror::gate::check_message(type_url, &payload) {
        if d.refused() {
            return Err(gate_refusal(context, type_url, 1, started, &d));
        }
    }
    if let Some(why) = mandate_check(context) {
        return Err(mandate_refusal(context, type_url, &why));
    }
    let payload_seen = payload.clone();
    let prediction = crate::mirror::preview::predict(type_url, &payload);
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
        AttemptResult::Success { value, .. } => {
            crate::mcp::schedule::landed_with(type_url, &payload_seen);
            crate::mcp::mandate::note_landed(context.as_str(), now_millis());
            if let Some(p) = prediction {
                crate::mirror::preview::landed(p);
            }
            Ok(value)
        }
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
    context: impl Into<Context>,
) -> Result<tx_queue::TxResponse, String> {
    let context: Context = context.into();
    let context = &context;
    let started = now_millis();
    if let Some(d) = crate::mirror::gate::check_webview(action, &args) {
        if d.refused() {
            return Ok(tx_queue::TxResponse {
                request_id: String::new(),
                success: false,
                tx_hash: None,
                error: Some(gate_refusal(context, action, 1, started, &d)),
            });
        }
    }
    if let Some(why) = mandate_check(context) {
        return Ok(tx_queue::TxResponse { request_id: String::new(), success: false, tx_hash: None, error: Some(mandate_refusal(context, action, &why)) });
    }
    let prediction = crate::mirror::preview::predict(action, &args);
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
    if matches!(&res, Ok(r) if r.success) {
        crate::mcp::schedule::landed(action);
        crate::mcp::mandate::note_landed(context.as_str(), now_millis());
        if let Some(p) = prediction {
            crate::mirror::preview::landed(p);
        }
    }
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
        // v0.22 ante quotas: did not execute, clears next block, not pressure.
        for q in [
            "codespace ante code 2040: player exceeded per-block message cap",
            "address exceeded CheckTx free-tx cap for this block",
            "address already submitted a free staking tx this block",
            "proof for this struct was already attempted this block",
            "object is throttled for this block",
        ] {
            assert_eq!(classify(q), ErrorClass::BlockQuota, "{q}");
        }
        assert!(ErrorClass::BlockQuota.retryable());
        assert!(!ErrorClass::BlockQuota.is_pressure());
        // 2026-09-04: a rejected proof's error text carries the proof input,
        // and a nonce containing the digits 429 read as an HTTP 429 — 94
        // stale-anchor rejections an hour were feeding AIMD as throttling.
        let wf = "Broadcasting transaction failed with code 1 (codespace: structs). Log: work failure for input (5-234309MINE2470534NONCE9142937)";
        assert_eq!(classify(wf), ErrorClass::WorkFailure);
        assert!(!ErrorClass::WorkFailure.is_pressure());
        assert!(!ErrorClass::WorkFailure.retryable());
        assert_eq!(ErrorClass::WorkFailure.outcome(), "work_failure");
        assert_eq!(classify("block 2471429: something else"), ErrorClass::Other);
        assert_eq!(classify("status 429"), ErrorClass::RateLimited);
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
    fn the_ledger_column_carries_the_raw_subject_and_only_players_reserve() {
        let c = Context::parse("auto_build:1-271");
        assert_eq!(c.subject(), Some("1-271"));
        assert!(c.player().is_some());
        assert_eq!(Context::parse("mcp").subject(), None);
        let c = Context::parse("pow_complete:5-234309");
        assert_eq!(c.subject(), Some("5-234309"), "ledger rows keep the struct id, as they always have");
        assert!(c.player().is_none(), "but it reserves no player's charge");
    }
}
