//! Alpha balances, kept current by the GRASS ledger stream.
//!
//! Why this exists. The roster's Alpha column (and so `auto_sweep`) re-read
//! every balance from the guild API on each sweep, and the sweep only ran
//! while the Team Ops window was open — on 2026-11-11 the sweep sat blocked
//! for 12 hours because nobody had that window up. Every balance change in
//! the galaxy already passes through GRASS as an inventory frame.
//!
//! What the stream carries. `structs.inventory.<denom>.<guild>.<player>.<addr>`
//! frames ARE `structs.ledger` rows — same `id`, `amount_p`, `direction`,
//! `owner_id`, `block_height` — and the guild's `api_inventory` balance is the
//! sum of exactly those rows per owner (credits minus debits, see structs-pg
//! `api_inventory_reconcile`). Unlike grid frames they carry the CHANGE, not
//! the new balance, so they need a base and must never be counted twice:
//!
//!   * BASE — one walk of `/api/inventory/denom/ualpha`, every row remembered
//!     with the indexer height its page was stamped at.
//!   * DELTAS — a frame moves an owner's balance only when its block is above
//!     that owner's base height (the base already includes everything at or
//!     below it), and only once per ledger `id`.
//!   * RE-BASE — on the snapshot's own rule: hourly while the native stream is
//!     unbroken, at once after any break (frames lost in a gap cannot be
//!     known about), every 10 minutes while the stream is not the source of
//!     record. A balance that would go negative is proof of a missed frame and
//!     forces a re-base.
//!
//! Frames that arrive while a base is being walked are kept in a ring and
//! replayed against the new base with the same height and id rules.

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;

/// The only denom the roster and the sweep read.
pub const DENOM: &str = "ualpha";
const PAGE_LIMIT: usize = 1000;
const MAX_PAGES: u32 = 100;
/// Recent ualpha deltas kept for replay over a fresh base.
const RING_CAP: usize = 50_000;

/// One ualpha ledger movement, as GRASS delivered it.
#[derive(Clone, Debug, PartialEq)]
pub struct Delta {
    pub id: u64,
    pub height: u64,
    pub owner: String,
    /// Signed base units: credit positive, debit negative.
    pub amount: i128,
}

/// A ledger frame → a ualpha delta for a player owner. Pure. Frames for other
/// denoms, non-player owners (module accounts, the faucet) and frames without
/// an id or height are not deltas this store keeps.
pub fn delta_from_frame(category_subject: &str, detail: &Value) -> Option<Delta> {
    if !category_subject.starts_with("structs.inventory.") {
        return None;
    }
    let d = match detail.get("detail") {
        Some(inner @ Value::Object(_)) => inner,
        _ => detail,
    };
    let s = |k: &str| d.get(k).and_then(|v| v.as_str());
    if s("denom")? != DENOM || s("owner_type")? != "player" {
        return None;
    }
    let owner = s("owner_id").filter(|o| !o.is_empty())?.to_string();
    let num = |k: &str| -> Option<u128> {
        let v = d.get(k)?;
        v.as_u64().map(u128::from).or_else(|| v.as_str().and_then(|x| x.parse().ok()))
    };
    let id = num("id_exact").or_else(|| num("id"))? as u64;
    let height = num("block_height_exact").or_else(|| num("block_height"))? as u64;
    let amount = num("amount_p_exact").or_else(|| num("amount_p"))? as i128;
    let amount = match s("direction")? {
        "credit" => amount,
        "debit" => -amount,
        _ => return None,
    };
    if id == 0 || height == 0 {
        return None;
    }
    Some(Delta { id, height, owner, amount })
}

/// The store. Public for tests; reached through the module functions.
#[derive(Default, Debug)]
pub struct Ledger {
    balances: HashMap<String, i128>,
    /// Height each owner's base row was stamped at.
    base_height: HashMap<String, u64>,
    /// For an owner with no base row: the lowest page height of the walk —
    /// every frame above it is one the walk could not have counted.
    absent_height: u64,
    applied: HashSet<u64>,
    pub based_ms: f64,
    pub ready: bool,
    /// A frame would have driven a balance negative: a frame was missed.
    pub suspect: bool,
    pub deltas_applied: u64,
    pub deltas_skipped: u64,
}

impl Ledger {
    /// Install a base: `(owner, balance, page_height)` rows. Clears the
    /// applied set — the base already includes every frame at or below each
    /// owner's height.
    pub fn install(&mut self, rows: &[(String, i128, u64)], now_ms: f64) {
        self.balances.clear();
        self.base_height.clear();
        self.applied.clear();
        let mut min_h = u64::MAX;
        for (owner, bal, h) in rows {
            // A duplicate (a row that moved pages mid-walk) keeps the later read.
            let later = self.base_height.get(owner).map_or(true, |prev| h >= prev);
            if later {
                self.balances.insert(owner.clone(), *bal);
                self.base_height.insert(owner.clone(), *h);
            }
            min_h = min_h.min(*h);
        }
        self.absent_height = if min_h == u64::MAX { 0 } else { min_h };
        self.based_ms = now_ms;
        self.ready = true;
        self.suspect = false;
    }

    /// Apply one delta under the height and id rules. Returns whether it moved
    /// a balance.
    pub fn apply(&mut self, d: &Delta) -> bool {
        if !self.ready {
            return false;
        }
        let floor = self.base_height.get(&d.owner).copied().unwrap_or(self.absent_height);
        if d.height <= floor || !self.applied.insert(d.id) {
            self.deltas_skipped += 1;
            return false;
        }
        let bal = self.balances.entry(d.owner.clone()).or_insert(0);
        *bal += d.amount;
        if *bal < 0 {
            *bal = 0;
            self.suspect = true;
        }
        self.deltas_applied += 1;
        true
    }

    pub fn balance(&self, owner: &str) -> Option<i128> {
        if !self.ready {
            return None;
        }
        Some(self.balances.get(owner).copied().unwrap_or(0))
    }
}

/// Whether a base is due. Pure: the snapshot's refresh rule applied to the
/// ledger (see `perception::refresh_interval_for`).
pub fn rebase_due(l: &Ledger, now_ms: f64, feed_authoritative: bool, feed_break_ms: f64) -> bool {
    if !l.ready || l.suspect {
        return true;
    }
    let interval = crate::mcp::perception::refresh_interval_for(feed_authoritative, feed_break_ms, l.based_ms, 0);
    now_ms - l.based_ms >= interval
}

static LEDGER: LazyLock<RwLock<Ledger>> = LazyLock::new(|| RwLock::new(Ledger::default()));
static RING: LazyLock<std::sync::Mutex<VecDeque<Delta>>> = LazyLock::new(|| std::sync::Mutex::new(VecDeque::new()));
static REBASING: AtomicBool = AtomicBool::new(false);

/// GRASS hook — every frame passes; only ualpha player deltas are kept.
pub fn on_grass(subject: &str, detail: &Value) {
    let Some(d) = delta_from_frame(subject, detail) else { return };
    if let Ok(mut r) = RING.lock() {
        if r.len() >= RING_CAP {
            r.pop_front();
        }
        r.push_back(d.clone());
    }
    if let Ok(mut l) = LEDGER.write() {
        l.apply(&d);
    }
}

/// An owner's ualpha balance, or None until the first base has landed.
pub fn balance(owner: &str) -> Option<i128> {
    LEDGER.read().ok()?.balance(owner)
}

pub fn is_ready() -> bool {
    LEDGER.read().map(|l| l.ready).unwrap_or(false)
}

pub fn status_json() -> Value {
    let l = LEDGER.read();
    match l {
        Ok(l) => serde_json::json!({
            "ready": l.ready,
            "owners": l.balances.len(),
            "base_age_s": if l.based_ms > 0.0 { ((now_millis() - l.based_ms) / 1000.0).round() } else { -1.0 },
            "deltas_applied": l.deltas_applied,
            "deltas_skipped": l.deltas_skipped,
            "suspect": l.suspect,
            "rebasing": REBASING.load(Ordering::Relaxed),
        }),
        Err(_) => Value::Null,
    }
}

/// Kick a re-base in the background when one is due. Non-blocking.
pub fn maybe_rebase(client: &CosmosClient) {
    let due = LEDGER
        .read()
        .map(|l| {
            rebase_due(
                &l,
                now_millis(),
                crate::mcp::grass_native::authoritative(),
                crate::mcp::grass_native::last_break_ms() as f64,
            )
        })
        .unwrap_or(true);
    if !due || REBASING.swap(true, Ordering::SeqCst) {
        return;
    }
    let client = client.clone();
    tokio::spawn(async move {
        let t0 = now_millis();
        let res = rebase(&client).await;
        REBASING.store(false, Ordering::SeqCst);
        let sev = if res.is_ok() { crate::mcp::telemetry::Sev::Info } else { crate::mcp::telemetry::Sev::Warn };
        crate::mcp::telemetry::tlog_kv(
            "ledger",
            sev,
            "alpha base",
            serde_json::json!({ "ms": (now_millis() - t0).round(), "result": match &res { Ok(n) => serde_json::json!(n), Err(e) => serde_json::json!(e) } }),
        );
    });
}

/// Walk the guild's ualpha balances, install them as the base, then replay
/// the ring over it. Returns the number of owners.
async fn rebase(client: &CosmosClient) -> Result<usize, String> {
    let mut rows: Vec<(String, i128, u64)> = Vec::new();
    let mut first_len: Option<usize> = None;
    for page in 1..=MAX_PAGES {
        let (items, height, _) = client
            .guild
            .list_page_with_meta(&format!("/api/inventory/denom/{DENOM}/page/{page}"), PAGE_LIMIT)
            .await
            .map_err(|e| format!("inventory page {page}: {e}"))?;
        // An unstamped page cannot be placed against the stream; refuse the
        // base rather than guess (the roster falls back to its own read).
        let h = height.ok_or_else(|| format!("inventory page {page} carries no meta.height"))?;
        let n = items.len();
        for r in &items {
            if r.get("owner_type").and_then(|v| v.as_str()) != Some("player") {
                continue;
            }
            let Some(owner) = r.get("owner_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else { continue };
            let bal = match r.get("balance") {
                Some(Value::String(s)) => s.split('.').next().unwrap_or("0").parse::<i128>().unwrap_or(0),
                Some(v) => v.as_f64().unwrap_or(0.0) as i128,
                None => 0,
            };
            rows.push((owner.to_string(), bal, h));
        }
        let first = *first_len.get_or_insert(n);
        if !crate::mcp::guild_api::page_walk_continues(first, n) {
            let owners = {
                let mut l = LEDGER.write().map_err(|_| "ledger lock poisoned".to_string())?;
                l.install(&rows, now_millis());
                let replay: Vec<Delta> = RING.lock().map(|r| r.iter().cloned().collect()).unwrap_or_default();
                for d in &replay {
                    l.apply(d);
                }
                l.balances.len()
            };
            return Ok(owners);
        }
    }
    Err(format!("inventory walk capped at {MAX_PAGES} pages — refusing a truncated base"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(id: u64, h: u64, owner: &str, dir: &str, amt: u64) -> Value {
        json!({"action":"refined","denom":"ualpha","owner_type":"player","owner_id":owner,
               "direction":dir,"amount":amt/1_000_000,"amount_p":amt,"amount_p_exact":amt.to_string(),
               "id":id,"id_exact":id.to_string(),"block_height":h,"block_height_exact":h.to_string(),"is_vault":true})
    }
    const SUBJ: &str = "structs.inventory.ualpha.0-1.1-7.structs1x";

    #[test]
    fn frames_become_signed_player_deltas() {
        let d = delta_from_frame(SUBJ, &frame(5, 100, "1-7", "credit", 1_000_000)).unwrap();
        assert_eq!(d, Delta { id: 5, height: 100, owner: "1-7".into(), amount: 1_000_000 });
        let d = delta_from_frame(SUBJ, &frame(6, 100, "1-7", "debit", 3)).unwrap();
        assert_eq!(d.amount, -3);
        // The faucet's own debit: no player owner → not ours to keep.
        let mut f = frame(7, 100, "1-7", "debit", 3);
        f["owner_type"] = Value::Null;
        f["owner_id"] = Value::Null;
        assert!(delta_from_frame(SUBJ, &f).is_none());
        // Ore moves are grid frames' business.
        let mut f = frame(8, 100, "1-7", "credit", 1);
        f["denom"] = json!("ore");
        assert!(delta_from_frame(SUBJ, &f).is_none());
        assert!(delta_from_frame("structs.planet.2-1.1-7", &frame(9, 1, "1-7", "credit", 1)).is_none());
    }

    #[test]
    fn base_height_and_id_decide_what_counts() {
        let mut l = Ledger::default();
        let d = |id, h, amt| Delta { id, height: h, owner: "1-7".into(), amount: amt };
        assert!(!l.apply(&d(1, 10, 5)), "no base yet: nothing applies");
        l.install(&[("1-7".into(), 100, 50)], 0.0);
        assert!(!l.apply(&d(2, 50, 5)), "at the base height: already counted");
        assert!(!l.apply(&d(3, 40, 5)), "below the base height: already counted");
        assert!(l.apply(&d(4, 51, 5)));
        assert!(!l.apply(&d(4, 51, 5)), "same ledger id twice: once");
        assert!(l.apply(&d(5, 52, -30)));
        assert_eq!(l.balance("1-7"), Some(75));
    }

    #[test]
    fn an_owner_without_a_base_row_starts_at_zero_from_the_lowest_page() {
        let mut l = Ledger::default();
        l.install(&[("1-1".into(), 10, 60), ("1-2".into(), 5, 70)], 0.0);
        assert_eq!(l.balance("1-9"), Some(0));
        assert!(!l.apply(&Delta { id: 1, height: 60, owner: "1-9".into(), amount: 4 }));
        assert!(l.apply(&Delta { id: 2, height: 61, owner: "1-9".into(), amount: 4 }));
        assert_eq!(l.balance("1-9"), Some(4));
    }

    #[test]
    fn a_duplicate_base_row_keeps_the_later_page() {
        let mut l = Ledger::default();
        l.install(&[("1-1".into(), 10, 60), ("1-1".into(), 7, 65)], 0.0);
        assert_eq!(l.balance("1-1"), Some(7));
        assert!(!l.apply(&Delta { id: 1, height: 64, owner: "1-1".into(), amount: 1 }));
    }

    #[test]
    fn a_missed_frame_is_caught_and_forces_a_rebase() {
        let mut l = Ledger::default();
        l.install(&[("1-1".into(), 2, 10)], 1_000.0);
        assert!(!rebase_due(&l, 2_000.0, true, 0.0));
        l.apply(&Delta { id: 1, height: 11, owner: "1-1".into(), amount: -5 });
        assert_eq!(l.balance("1-1"), Some(0), "never negative");
        assert!(rebase_due(&l, 2_000.0, true, 0.0));
    }

    #[test]
    fn rebase_follows_the_snapshot_cadence() {
        let mut l = Ledger::default();
        assert!(rebase_due(&l, 0.0, true, 0.0), "no base yet");
        l.install(&[], 1_000.0);
        let m = 60_000.0;
        assert!(!rebase_due(&l, 1_000.0 + 30.0 * m, true, 0.0), "unbroken stream: hourly");
        assert!(rebase_due(&l, 1_000.0 + 61.0 * m, true, 0.0));
        assert!(rebase_due(&l, 1_000.0 + 11.0 * m, false, 0.0), "stream not authoritative: 10 minutes");
        assert!(rebase_due(&l, 1_000.0 + 11.0 * m, true, 5_000.0), "a break since the base: base again");
    }
}
