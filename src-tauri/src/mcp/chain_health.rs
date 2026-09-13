//! Is the node we TRANSACT through keeping up with the chain?
//!
//! Two heads: the live one, from the guild's consensus feed (a GRASS `block`
//! frame every ~5 s), and the reactor LCD's own, polled once a minute. They
//! are normally within a block of each other. On 2026-09-12 at 20:35 EDT the
//! public LCD stopped syncing at 2586840 while the chain went on to 2587288;
//! every transaction this machine signed for the next forty minutes went into
//! that node's mempool and was never gossiped — harvest, crew, all of it —
//! and the only trace was a hundred `code 19` and "not yet found" lines at
//! debug level. The app said nothing and kept spending.
//!
//! This module says something, once, and lets the loops that spend hold.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::telemetry::{tlog, Sev};

/// Blocks the node may trail the chain before it is called stalled — about
/// five minutes at 5.3 s a block, which is longer than any inclusion wait.
pub const STALL_BLOCKS: u64 = 60;
/// A head reading older than this is no reading at all.
const READING_MAX_AGE_MS: u64 = 10 * 60 * 1000;
const POLL_MS: u64 = 60 * 1000;

static LIVE_HEAD: AtomicU64 = AtomicU64::new(0);
static LIVE_AT_MS: AtomicU64 = AtomicU64::new(0);
static LCD_HEAD: AtomicU64 = AtomicU64::new(0);
static LCD_AT_MS: AtomicU64 = AtomicU64::new(0);
static LAST_POLL_MS: AtomicU64 = AtomicU64::new(0);
static STALLED: AtomicBool = AtomicBool::new(false);

/// The chain's head, from the consensus feed.
pub fn note_live_head(height: u64) {
    if height == 0 {
        return;
    }
    LIVE_HEAD.store(height, Ordering::Relaxed);
    LIVE_AT_MS.store(now_millis() as u64, Ordering::Relaxed);
}

/// The reactor node's head, from its own latest-block endpoint.
pub fn note_lcd_head(height: u64) {
    if height == 0 {
        return;
    }
    LCD_HEAD.store(height, Ordering::Relaxed);
    LCD_AT_MS.store(now_millis() as u64, Ordering::Relaxed);
}

/// The verdict, pure: how far behind is the node, given both heads and how
/// old each reading is. `None` when there is not enough to say.
pub fn lag_of(live: u64, live_at: u64, lcd: u64, lcd_at: u64, now: u64) -> Option<u64> {
    if live == 0 || lcd == 0 {
        return None;
    }
    if now.saturating_sub(live_at) > READING_MAX_AGE_MS || now.saturating_sub(lcd_at) > READING_MAX_AGE_MS {
        return None;
    }
    Some(live.saturating_sub(lcd))
}

pub fn lcd_lag() -> Option<u64> {
    lag_of(
        LIVE_HEAD.load(Ordering::Relaxed),
        LIVE_AT_MS.load(Ordering::Relaxed),
        LCD_HEAD.load(Ordering::Relaxed),
        LCD_AT_MS.load(Ordering::Relaxed),
        now_millis() as u64,
    )
}

/// Is the node we transact through too far behind to trust with a
/// transaction? Unknown is NOT stalled: with no reading, the loops run as
/// they always have.
pub fn lcd_stalled() -> bool {
    STALLED.load(Ordering::Relaxed)
}

pub fn status() -> Value {
    json!({
        "live_head": LIVE_HEAD.load(Ordering::Relaxed),
        "lcd_head": LCD_HEAD.load(Ordering::Relaxed),
        "lag": lcd_lag(),
        "stalled": lcd_stalled(),
    })
}

/// Poll the node's head (rate-limited) and settle the verdict. Called from
/// a loop that already runs every few seconds; cheap when it is not time.
pub async fn poll(app: &tauri::AppHandle, client: &CosmosClient) {
    let now = now_millis() as u64;
    if now.saturating_sub(LAST_POLL_MS.load(Ordering::Relaxed)) < POLL_MS {
        return;
    }
    LAST_POLL_MS.store(now, Ordering::Relaxed);
    if let Ok(v) = client.lcd_get("/cosmos/base/tendermint/v1beta1/blocks/latest").await {
        let h = v
            .get("block")
            .and_then(|b| b.get("header"))
            .and_then(|h| h.get("height"))
            .and_then(|h| h.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| h.as_u64()))
            .unwrap_or(0);
        note_lcd_head(h);
    }
    settle(app);
}

/// Move the verdict, and say so exactly at the moments it changes.
fn settle(app: &tauri::AppHandle) {
    let lag = lcd_lag();
    let stalled_now = lag.map(|l| l > STALL_BLOCKS).unwrap_or(false);
    let was = STALLED.swap(stalled_now, Ordering::Relaxed);
    if stalled_now && !was {
        let msg = format!(
            "the node this app transacts through is {} blocks behind the chain (node {}, chain {}); \
             transactions sent to it will not land — holding crew work until it catches up",
            lag.unwrap_or(0),
            LCD_HEAD.load(Ordering::Relaxed),
            LIVE_HEAD.load(Ordering::Relaxed)
        );
        tlog("chain", Sev::Warn, msg.clone());
        crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Important, "chain", msg);
    } else if !stalled_now && was {
        let msg = "the node has caught up with the chain; transactions will land again".to_string();
        tlog("chain", Sev::Notice, msg.clone());
        crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Notice, "chain", msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Behind by more than the window is stalled; a block or two is not;
    /// a stale reading of either head is no verdict at all.
    #[test]
    fn a_node_is_behind_only_when_both_heads_are_fresh() {
        let now = 1_000_000_000u64;
        assert_eq!(lag_of(2_587_288, now, 2_586_840, now, now), Some(448));
        assert!(lag_of(2_587_288, now, 2_586_840, now, now).unwrap() > STALL_BLOCKS);
        assert_eq!(lag_of(100, now, 99, now, now), Some(1));
        assert_eq!(lag_of(100, now, 100, now, now), Some(0));
        assert_eq!(lag_of(0, now, 100, now, now), None, "no live head, no verdict");
        assert_eq!(lag_of(100, now, 0, now, now), None, "no node head, no verdict");
        assert_eq!(lag_of(100, now - READING_MAX_AGE_MS - 1, 50, now, now), None, "a stale live reading is no reading");
        assert_eq!(lag_of(100, now, 50, now - READING_MAX_AGE_MS - 1, now), None, "a stale node reading is no reading");
        assert_eq!(lag_of(50, now, 100, now, now), Some(0), "a node ahead of the feed is not behind");
    }
}
