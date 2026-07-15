//! Shared retrying submit path for automation-initiated transactions.
//!
//! Every auto-loop (and the team-level tools) used to call the signing bridges
//! directly and silently drop failures. These wrappers make each attempt an
//! auditable `tx_attempts` row, retry the failure classes where a retry is the
//! documented remedy (sequence mismatch: "wait ~6s and retry"), back off on
//! endpoint pressure, and feed the AIMD concurrency controller in `loop_util`
//! so a struggling node automatically shrinks the fan-out instead of being
//! hammered by 182 players' worth of scans.
//!
//! Deterministic rejections (insufficient charge/funds, player offline,
//! invalid target) are never retried — the state that caused them won't change
//! within a retry budget, and each retry burns a scarce SIGN_GATE permit.

use serde_json::Value;
use std::time::Duration;

use crate::hasher::types::now_millis;
use crate::mcp::error_translator::translate_error;
use crate::mcp::telemetry::{self, TxAttemptRow};
use crate::mcp::{loop_util, tx_queue, vplayer_bridge};

/// Max attempts per submit (1 initial + 2 retries).
const MAX_ATTEMPTS: u32 = 3;
/// Sequence mismatch: the chain frees the account after the pending tx's
/// block; ~6s block time + margin.
const SEQ_RETRY_BASE_MS: u64 = 7_000;
/// Endpoint-pressure backoff base (doubles per attempt).
const BACKOFF_BASE_MS: u64 = 2_000;

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
    /// Whether a retry can plausibly change the outcome.
    fn retryable(self) -> bool {
        matches!(
            self,
            ErrorClass::SequenceMismatch
                | ErrorClass::RateLimited
                | ErrorClass::Timeout
                | ErrorClass::BridgeDown
        )
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

    fn delay_ms(self, attempt: u32) -> u64 {
        match self {
            ErrorClass::SequenceMismatch => SEQ_RETRY_BASE_MS,
            _ => BACKOFF_BASE_MS * (1u64 << (attempt.saturating_sub(1)).min(4)),
        }
    }

    /// Endpoint pressure (as opposed to per-account state) — feeds AIMD.
    fn is_pressure(self) -> bool {
        matches!(self, ErrorClass::RateLimited | ErrorClass::Timeout | ErrorClass::BridgeDown)
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
    } else if l.contains("timed out") || l.contains("timeout") {
        ErrorClass::Timeout
    } else if l.contains("channel closed")
        || l.contains("failed to emit")
        || l.contains("gate closed")
        || l.contains("bridge")
    {
        ErrorClass::BridgeDown
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
    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        let started = now_millis();
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
        let started = now_millis();
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
        assert_eq!(classify("virtual-player op 'sign' timed out after 60s"), ErrorClass::Timeout);
        assert_eq!(classify("virtual-player bridge channel closed"), ErrorClass::BridgeDown);
        assert_eq!(classify("something novel"), ErrorClass::Other);
    }

    #[test]
    fn retry_policy_shape() {
        assert!(ErrorClass::SequenceMismatch.retryable());
        assert!(ErrorClass::RateLimited.retryable());
        assert!(!ErrorClass::InsufficientCharge.retryable());
        assert!(!ErrorClass::Other.retryable());
        assert_eq!(ErrorClass::InsufficientCharge.outcome(), "skipped");
        assert_eq!(ErrorClass::Timeout.outcome(), "timeout");
        // Backoff grows: attempt 1 → 2s, attempt 2 → 4s.
        assert_eq!(ErrorClass::Timeout.delay_ms(1), 2_000);
        assert_eq!(ErrorClass::Timeout.delay_ms(2), 4_000);
        assert_eq!(ErrorClass::SequenceMismatch.delay_ms(1), 7_000);
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
