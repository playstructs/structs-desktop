//! Team production and combat RATES — the six figures on the Replication
//! card — from the LOCAL record only. Nothing here touches the network.
//!
//! The guild indexer publishes every ledger row as a GRASS frame: category
//! `mined` / `refined` / `seized` / `forfeited`, subject
//! `structs.inventory.<denom>.<guild>.<player>.<address>`, detail = the ledger
//! row itself (`action`, `denom`, `direction`, `amount_p`, `player_id`). The
//! app already keeps every frame for seven days in telemetry's `grass_events`
//! (`event_buffer::ingest` records before anything else sees it). So a rate
//! is a sum over that record: the last hour of `mined` ore credited to our
//! players, the last hour of `refined` ualpha, the last hour of `seized` ore;
//! kills and losses from `struct_attack` volleys over the last day.
//!
//! Live frames are folded as they arrive. At start the last 25 hours are read
//! back from telemetry once, so the figures are there the moment the card
//! opens rather than an hour later. The first cut of this module sampled the
//! guild API per player — at 2,807 replicants that was thousands of requests
//! a sample, and it still had nothing to say for an hour.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::event_buffer::GameEvent;
use crate::mcp::telemetry::{tlog, Sev};
use crate::mcp::types::numeric_f64;

/// The window a production rate is quoted over.
const WINDOW_MS: f64 = 3_600_000.0;
/// Kills and losses are quoted over a day; hits older than this are dropped.
const KEEP_MS: f64 = 25.0 * 3_600_000.0;
/// A rate needs at least this much observed time before it is a number.
const MIN_COVER_MS: f64 = 5.0 * 60_000.0;
/// Telemetry pages at most this many rows per read; the backfill walks back
/// page by page until the window is covered.
const PAGE: usize = 2000;
const MAX_PAGES: usize = 40;
const CATEGORIES: [&str; 4] = ["mined", "refined", "seized", "struct_attack"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Grams of ore mined by one of ours.
    Mined,
    /// ualpha refined by one of ours.
    Refined,
    /// Grams of ore one of ours seized in a raid.
    Seized,
    Kill,
    Loss,
}

#[derive(Debug, Clone)]
struct Hit {
    ts: f64,
    kind: Kind,
    amount: f64,
}

#[derive(Default)]
struct Store {
    hits: VecDeque<Hit>,
    /// When live folding began this process — the backfill stops here.
    live_since: Option<f64>,
    /// The oldest moment the record is known to reach back to.
    observed_since: Option<f64>,
    backfilled: bool,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));
static BACKFILLING: AtomicBool = AtomicBool::new(false);

fn lock() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|p| p.into_inner())
}

fn trim(s: &mut Store, now: f64) {
    while s.hits.front().map(|h| now - h.ts > KEEP_MS).unwrap_or(false) {
        s.hits.pop_front();
    }
}

fn note_observed(s: &mut Store, ts: f64) {
    if s.observed_since.map(|o| ts < o).unwrap_or(true) {
        s.observed_since = Some(ts);
    }
}

// ── Folding one frame ────────────────────────────────────────────────────────

/// What one frame adds to the record. `ours` says whose a player id is.
///
/// A ledger frame is folded only when it is the CREDIT leg to one of our
/// players in the denom the action moves — `refined` writes two legs (ore
/// out, ualpha in) and `seized` / `forfeited` are one movement seen from two
/// sides, so reading every leg would double every figure.
pub fn fold_frame(category: &str, d: &Value, ours: impl Fn(&str) -> bool) -> Vec<(Kind, f64)> {
    let s = |k: &str| d.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match category {
        "mined" | "refined" | "seized" => {
            if s("action") != category || s("direction") != "credit" {
                return Vec::new();
            }
            let want_denom = if category == "refined" { "ualpha" } else { "ore" };
            if s("denom") != want_denom || !ours(s("player_id")) {
                return Vec::new();
            }
            let amount = numeric_f64(d.get("amount_p"))
                .or_else(|| numeric_f64(d.get("amount")))
                .unwrap_or(0.0);
            if amount <= 0.0 {
                return Vec::new();
            }
            let kind = match category {
                "mined" => Kind::Mined,
                "refined" => Kind::Refined,
                _ => Kind::Seized,
            };
            vec![(kind, amount)]
        }
        "struct_attack" => {
            let (kills, losses) = count_volley(d, ours);
            let mut out = Vec::new();
            if kills > 0 {
                out.push((Kind::Kill, kills as f64));
            }
            if losses > 0 {
                out.push((Kind::Loss, losses as f64));
            }
            out
        }
        _ => Vec::new(),
    }
}

/// (our kills, our losses) in one volley. A self-raid — one of ours shooting
/// another of ours — counts on both sides, as the achievements fold does.
pub fn count_volley(d: &Value, ours: impl Fn(&str) -> bool) -> (usize, usize) {
    let attacker = d.get("attackerPlayerId").and_then(|v| v.as_str()).unwrap_or("");
    let attacker_ours = !attacker.is_empty() && ours(attacker);
    let shots = d.get("eventAttackShotDetail").and_then(|s| s.as_array());
    let (mut kills, mut losses) = (0usize, 0usize);
    for shot in shots.into_iter().flatten() {
        let destroyed = match shot.get("targetDestroyed") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s == "true",
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            _ => false,
        };
        if !destroyed {
            continue;
        }
        if attacker_ours {
            kills += 1;
        }
        let target = shot.get("targetPlayerId").and_then(|v| v.as_str()).unwrap_or("");
        if !target.is_empty() && ours(target) {
            losses += 1;
        }
    }
    (kills, losses)
}

/// Fold one live GRASS frame. Everything but the four categories returns
/// before taking the lock.
pub fn on_grass(event: &GameEvent) {
    if !CATEGORIES.contains(&event.category.as_str()) {
        return;
    }
    let now = now_millis();
    let adds = fold_frame(&event.category, &event.detail, crate::mcp::virtual_players::is_team_player);
    let mut s = lock();
    if s.live_since.is_none() {
        s.live_since = Some(now);
        note_observed(&mut s, now);
    }
    for (kind, amount) in adds {
        s.hits.push_back(Hit { ts: now, kind, amount });
    }
    trim(&mut s, now);
}

// ── The backfill ─────────────────────────────────────────────────────────────

/// Read the last day back from telemetry, once. Rides the sync tick so it
/// runs shortly after launch; the read is local SQLite off the tick's thread.
pub async fn tick(app: &tauri::AppHandle) {
    let _ = app;
    if lock().backfilled || BACKFILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    let now = now_millis();
    let until = {
        let mut s = lock();
        if s.live_since.is_none() {
            s.live_since = Some(now);
        }
        s.live_since.unwrap_or(now)
    };
    let since = now - KEEP_MS;
    let result = tokio::task::spawn_blocking(move || backfill_rows(since, until)).await;
    let mut s = lock();
    match result {
        Ok(Ok((hits, reach))) => {
            let n = hits.len();
            for h in hits {
                s.hits.push_back(h);
            }
            let mut v: Vec<Hit> = s.hits.drain(..).collect();
            v.sort_by(|a, b| a.ts.total_cmp(&b.ts));
            s.hits = v.into_iter().collect();
            if let Some(r) = reach {
                note_observed(&mut s, r);
            }
            trim(&mut s, now);
            tlog("rates", Sev::Info, format!("backfilled {n} production/combat hits from the local record"));
        }
        Ok(Err(e)) => tlog("rates", Sev::Warn, format!("backfill skipped: {e}")),
        Err(e) => tlog("rates", Sev::Warn, format!("backfill task failed: {e}")),
    }
    s.backfilled = true;
    BACKFILLING.store(false, Ordering::SeqCst);
}

/// Every hit in `[since, until)` from the durable record, plus how far back
/// the record actually reached (the oldest frame timestamp seen, of any of
/// the four categories — a quiet hour is still an observed hour).
fn backfill_rows(since: f64, until: f64) -> Result<(Vec<Hit>, Option<f64>), String> {
    let cats: Vec<String> = CATEGORIES.iter().map(|c| c.to_string()).collect();
    let mut hits = Vec::new();
    let mut reach: Option<f64> = None;
    let mut upper = until;
    for _ in 0..MAX_PAGES {
        let rows = crate::mcp::telemetry::grass_history(since, Some(upper), &cats, PAGE)?;
        if rows.is_empty() {
            break;
        }
        let mut oldest = upper;
        for r in &rows {
            let ts = r.get("timestamp").and_then(|v| v.as_f64()).unwrap_or(upper);
            if ts < oldest {
                oldest = ts;
            }
            let category = r.get("category").and_then(|v| v.as_str()).unwrap_or("");
            let detail = r.get("detail").cloned().unwrap_or(Value::Null);
            for (kind, amount) in fold_frame(category, &detail, crate::mcp::virtual_players::is_team_player) {
                hits.push(Hit { ts, kind, amount });
            }
        }
        if reach.map(|x| oldest < x).unwrap_or(true) {
            reach = Some(oldest);
        }
        if rows.len() < PAGE || oldest >= upper {
            break;
        }
        upper = oldest;
    }
    Ok((hits, reach))
}

// ── The card's read ──────────────────────────────────────────────────────────

/// Sum of a kind over the trailing `window_ms`.
fn sum_since(hits: &VecDeque<Hit>, kind: Kind, floor: f64) -> f64 {
    hits.iter().rev().take_while(|h| h.ts >= floor).filter(|h| h.kind == kind).map(|h| h.amount).sum()
}

/// A rate over the last hour, or over however long the record reaches back
/// when that is shorter; `null` under five minutes of observation.
fn per_hour(sum: f64, covered_ms: f64) -> Option<f64> {
    if covered_ms < MIN_COVER_MS {
        return None;
    }
    Some(sum / (covered_ms / WINDOW_MS))
}

pub fn snapshot() -> Value {
    let s = lock();
    let now = now_millis();
    let covered = s.observed_since.map(|o| (now - o).clamp(0.0, WINDOW_MS)).unwrap_or(0.0);
    let hour = now - WINDOW_MS;
    let day = now - 24.0 * WINDOW_MS;
    let kills = sum_since(&s.hits, Kind::Kill, day) as usize;
    let losses = sum_since(&s.hits, Kind::Loss, day) as usize;
    json!({
        "ore_g_h": per_hour(sum_since(&s.hits, Kind::Mined, hour), covered),
        "alpha_ualpha_h": per_hour(sum_since(&s.hits, Kind::Refined, hour), covered),
        "seized_g_h": per_hour(sum_since(&s.hits, Kind::Seized, hour), covered),
        "window_h": if covered > 0.0 { Some(covered / WINDOW_MS) } else { None },
        "kills_24h": kills,
        "losses_24h": losses,
        "kd": if losses > 0 { Some(kills as f64 / losses as f64) } else if kills > 0 { Some(kills as f64) } else { None },
        "hits": s.hits.len(),
        "backfilled": s.backfilled,
        "source": "local",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(action: &str, denom: &str, direction: &str, player: &str, amount_p: f64) -> Value {
        json!({ "action": action, "denom": denom, "direction": direction, "player_id": player, "amount": 1, "amount_p": amount_p })
    }
    fn ours(id: &str) -> bool {
        id == "1-194" || id == "1-248"
    }

    #[test]
    fn only_the_credit_leg_in_the_moved_denom_for_one_of_ours_counts() {
        assert_eq!(fold_frame("mined", &ledger("mined", "ore", "credit", "1-194", 3.0), ours), vec![(Kind::Mined, 3.0)]);
        // `refined` writes two legs; the ore debit is not production.
        assert_eq!(fold_frame("refined", &ledger("refined", "ore", "debit", "1-194", 1.0), ours), vec![]);
        assert_eq!(fold_frame("refined", &ledger("refined", "ualpha", "credit", "1-194", 1_000_000.0), ours), vec![(Kind::Refined, 1_000_000.0)]);
        // A seizure seen from the victim's side is `forfeited`, never folded here.
        assert_eq!(fold_frame("seized", &ledger("seized", "ore", "credit", "1-248", 1058.0), ours), vec![(Kind::Seized, 1058.0)]);
        assert_eq!(fold_frame("forfeited", &ledger("forfeited", "ore", "debit", "1-194", 1058.0), ours), vec![]);
        // Somebody else's mining is the galaxy's business.
        assert_eq!(fold_frame("mined", &ledger("mined", "ore", "credit", "1-61", 3.0), ours), vec![]);
        // The category and the row's own action must agree.
        assert_eq!(fold_frame("mined", &ledger("refined", "ore", "credit", "1-194", 3.0), ours), vec![]);
        assert_eq!(fold_frame("block", &json!({"height": 1}), ours), vec![]);
    }

    fn volley(attacker: &str, shots: &[(&str, bool)]) -> Value {
        json!({
            "attackerPlayerId": attacker,
            "eventAttackShotDetail": shots.iter().map(|(t, d)| json!({"targetPlayerId": t, "targetDestroyed": d})).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn kills_and_losses_come_from_destroyed_shots_only() {
        assert_eq!(count_volley(&volley("1-194", &[("1-61", true), ("1-61", false)]), ours), (1, 0));
        assert_eq!(count_volley(&volley("1-61", &[("1-194", true), ("1-248", true), ("1-9", true)]), ours), (0, 2));
        assert_eq!(count_volley(&volley("1-194", &[("1-248", true)]), ours), (1, 1));
        assert_eq!(count_volley(&json!({"attackerPlayerId": "1-194"}), ours), (0, 0));
        let v = json!({"attackerPlayerId": "1-194", "eventAttackShotDetail": [{"targetPlayerId": "1-61", "targetDestroyed": "true"}]});
        assert_eq!(count_volley(&v, ours), (1, 0));
        assert_eq!(fold_frame("struct_attack", &volley("1-194", &[("1-248", true)]), ours), vec![(Kind::Kill, 1.0), (Kind::Loss, 1.0)]);
    }

    #[test]
    fn a_rate_is_the_last_hour_or_the_record_s_reach_and_never_a_guess() {
        let now = 100.0 * WINDOW_MS;
        let mut hits: VecDeque<Hit> = VecDeque::new();
        hits.push_back(Hit { ts: now - 2.0 * WINDOW_MS, kind: Kind::Mined, amount: 99.0 }); // too old
        hits.push_back(Hit { ts: now - 0.5 * WINDOW_MS, kind: Kind::Mined, amount: 30.0 });
        hits.push_back(Hit { ts: now - 0.1 * WINDOW_MS, kind: Kind::Mined, amount: 12.0 });
        hits.push_back(Hit { ts: now - 0.1 * WINDOW_MS, kind: Kind::Refined, amount: 5.0 });
        assert_eq!(sum_since(&hits, Kind::Mined, now - WINDOW_MS), 42.0);
        assert_eq!(per_hour(42.0, WINDOW_MS), Some(42.0));
        // Half an hour observed: the same sum is quoted at twice the rate.
        assert_eq!(per_hour(21.0, WINDOW_MS / 2.0), Some(42.0));
        // Under five minutes there is no rate, only a dash.
        assert_eq!(per_hour(21.0, 60_000.0), None);
    }
}
