//! Team production and combat RATES — the six figures on the Replication card.
//!
//! Nothing in the app computed a rate before this: the companion's "α / h" was
//! hardcoded to none and every economy figure was a lifetime total. This
//! module keeps two small, persisted records and derives rates from them:
//!
//! * **Production samples** — every `SAMPLE_INTERVAL_MS` the team's lifetime
//!   `mined` / `seized` ore (the guild's server-side sum, one read per player)
//!   and its `refined` Alpha (the newest ledger page per player, rows since
//!   the previous sample) are summed and appended. A rate is the difference
//!   between the newest sample and the one closest to an hour before it.
//! * **Kills and losses** — counted live from the `struct_attack` volleys the
//!   GRASS feed already delivers (`event_buffer::ingest`), the same per-shot
//!   fields `achievements::fold_attack` reads. A 24-hour window; never a
//!   re-walk of the activity feed, which at roster scale is thousands of pages.
//!
//! Both records survive a restart through `cache_store`. The sampler runs off
//! the sync tick whether or not autonomous replication is on: the card's
//! figures are a fact about the team, not a reward for a switch.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::event_buffer::GameEvent;
use crate::mcp::telemetry::{tlog, Sev};
use crate::mcp::types::numeric_f64;

const CACHE: &str = "replication_rates";
/// Two reads per player per sample, so the cadence is the cost knob: at 30
/// minutes an 870-player roster is ~1 request/second, the roster sweep's scale.
pub const SAMPLE_INTERVAL_MS: f64 = 30.0 * 60_000.0;
/// The window a rate is quoted over, and how far back a sample must exist.
const WINDOW_MS: f64 = 3_600_000.0;
/// Samples older than this are dropped; K/D is quoted over the same day.
const KEEP_MS: f64 = 25.0 * 3_600_000.0;
/// Ledger pages walked per player per sample when looking for `refined` rows
/// newer than the last sample. One page is the normal case; the cap keeps a
/// very busy refinery from turning the sampler into a ledger walk.
const MAX_LEDGER_PAGES: u32 = 3;
const LEDGER_PAGE: usize = 100;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Sample {
    pub ts: f64,
    /// Lifetime grams of ore the team has mined (guild `ore/stats` sum).
    pub mined_g: f64,
    /// Lifetime grams of ore the team has seized in raids.
    pub seized_g: f64,
    /// Cumulative ualpha refined by the team SINCE THIS RECORD BEGAN — the
    /// ledger has no server-side sum, so this is a running total of the rows
    /// seen, not a lifetime figure. Differences are what matter.
    pub refined_ualpha: f64,
    /// Players the sample covered; a partial read is still a sample, but a
    /// rate across two samples of different coverage is marked as such.
    pub players: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    samples: VecDeque<Sample>,
    /// Timestamps (ms) of each struct one of ours destroyed.
    #[serde(default)]
    kills: VecDeque<f64>,
    /// Timestamps (ms) of each struct of ours destroyed.
    #[serde(default)]
    losses: VecDeque<f64>,
    /// Newest ledger `time` (ms) folded per player, so the next sample only
    /// adds rows it has not seen. Keyed by player id.
    #[serde(default)]
    ledger_seen: std::collections::HashMap<String, f64>,
}

static STORE: LazyLock<Mutex<Store>> =
    LazyLock::new(|| Mutex::new(crate::mcp::cache_store::load(CACHE).unwrap_or_default()));
static RUNNING: AtomicBool = AtomicBool::new(false);

fn lock() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|p| p.into_inner())
}

fn persist(s: &Store) {
    crate::mcp::cache_store::save_in_background(CACHE, s.clone());
}

fn trim(s: &mut Store, now: f64) {
    while s.samples.front().map(|x| now - x.ts > KEEP_MS).unwrap_or(false) {
        s.samples.pop_front();
    }
    while s.kills.front().map(|t| now - *t > KEEP_MS).unwrap_or(false) {
        s.kills.pop_front();
    }
    while s.losses.front().map(|t| now - *t > KEEP_MS).unwrap_or(false) {
        s.losses.pop_front();
    }
}

// ── Kills and losses, live ───────────────────────────────────────────────────

/// Fold one GRASS frame. Only `struct_attack` volleys matter; everything else
/// returns before taking the lock.
pub fn on_grass(event: &GameEvent) {
    if event.category != "struct_attack" {
        return;
    }
    let (kills, losses) = count_volley(&event.detail, crate::mcp::virtual_players::is_team_player);
    if kills == 0 && losses == 0 {
        return;
    }
    let now = now_millis();
    let mut s = lock();
    for _ in 0..kills {
        s.kills.push_back(now);
    }
    for _ in 0..losses {
        s.losses.push_back(now);
    }
    trim(&mut s, now);
    persist(&s);
}

/// (our kills, our losses) in one volley. `ours` decides whose a player id is.
///
/// A self-raid — one of ours shooting another of ours — counts on both sides,
/// exactly as the achievements fold does: it really fired and really was hit.
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

// ── Production samples ───────────────────────────────────────────────────────

/// One sampling pass if one is due. Rides the sync tick; single-flight.
pub async fn tick(app: &tauri::AppHandle) {
    let now = now_millis();
    let due = {
        let s = lock();
        s.samples.back().map(|x| now - x.ts >= SAMPLE_INTERVAL_MS).unwrap_or(true)
    };
    if !due || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app;
    sample().await;
    RUNNING.store(false, Ordering::SeqCst);
}

async fn sample() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    let targets = crate::mcp::virtual_players::collect_targets(true);
    if targets.is_empty() {
        return;
    }
    let seen: std::collections::HashMap<String, f64> = lock().ledger_seen.clone();

    let mined = Arc::new(Mutex::new(0.0f64));
    let seized = Arc::new(Mutex::new(0.0f64));
    let refined = Arc::new(Mutex::new(0.0f64));
    let newest: Arc<Mutex<std::collections::HashMap<String, f64>>> = Arc::new(Mutex::new(Default::default()));
    let failed = Arc::new(AtomicUsize::new(0));
    let total = targets.len();

    let ids: Vec<String> = targets.iter().map(|(pid, _, _)| pid.to_string()).collect();
    let (m, sz, rf, nw, fl) = (mined.clone(), seized.clone(), refined.clone(), newest.clone(), failed.clone());
    let seen = Arc::new(seen);
    crate::mcp::loop_util::for_each_player_concurrent(ids, crate::mcp::capacity::reads_fanout(), move |pid| {
        let (m, sz, rf, nw, fl, seen) = (m.clone(), sz.clone(), rf.clone(), nw.clone(), fl.clone(), seen.clone());
        async move {
            let client = crate::mcp::cosmos_client::CosmosClient::new();
            match client.guild.player_ore_stats(&pid).await {
                Ok(v) => {
                    if let Some(n) = numeric_f64(v.get("mined")) {
                        *m.lock().unwrap_or_else(|p| p.into_inner()) += n;
                    }
                    if let Some(n) = numeric_f64(v.get("seized")) {
                        *sz.lock().unwrap_or_else(|p| p.into_inner()) += n;
                    }
                }
                Err(_) => {
                    fl.fetch_add(1, Ordering::Relaxed);
                }
            }
            let since = seen.get(&pid).copied();
            let (grams, newest_ts) = refined_since(&client.guild, &pid, since).await;
            if grams > 0.0 {
                *rf.lock().unwrap_or_else(|p| p.into_inner()) += grams;
            }
            if let Some(t) = newest_ts {
                nw.lock().unwrap_or_else(|p| p.into_inner()).insert(pid, t);
            }
        }
    })
    .await;

    let now = now_millis();
    let failed_n = failed.load(Ordering::Relaxed);
    let mut s = lock();
    let prev_refined = s.samples.back().map(|x| x.refined_ualpha).unwrap_or(0.0);
    let sample = Sample {
        ts: now,
        mined_g: *mined.lock().unwrap_or_else(|p| p.into_inner()),
        seized_g: *seized.lock().unwrap_or_else(|p| p.into_inner()),
        refined_ualpha: prev_refined + *refined.lock().unwrap_or_else(|p| p.into_inner()),
        players: total - failed_n,
        failed: failed_n,
    };
    for (pid, t) in newest.lock().unwrap_or_else(|p| p.into_inner()).drain() {
        s.ledger_seen.insert(pid, t);
    }
    s.samples.push_back(sample);
    trim(&mut s, now);
    persist(&s);
    if failed_n > 0 {
        tlog("rates", Sev::Warn, format!("production sample: {failed_n} of {total} ore reads failed"));
    }
}

/// `refined` ualpha for one player from the newest ledger pages, counting only
/// rows newer than `since` (ms). Returns (ualpha, newest row time seen).
///
/// The ledger lists newest first, so the walk stops at the first row at or
/// before `since`. With no `since` (first sample) only the newest page is
/// read and NOTHING is counted — a first sample has no earlier one to
/// difference against, and it only needs to learn where "now" is.
async fn refined_since(g: &crate::mcp::guild_api::GuildApiClient, pid: &str, since: Option<f64>) -> (f64, Option<f64>) {
    let mut grams = 0.0f64;
    let mut newest: Option<f64> = None;
    let mut page = 1u32;
    'pages: loop {
        let Ok(p) = g.ledger_by_player(pid, page).await else { break };
        for r in &p.items {
            let t = r
                .get("time")
                .and_then(|v| v.as_str())
                .and_then(crate::mcp::raid_view::parse_guild_time);
            if let Some(t) = t {
                if newest.map(|n| t > n).unwrap_or(true) {
                    newest = Some(t);
                }
                if let Some(s) = since {
                    if t <= s {
                        break 'pages;
                    }
                } else {
                    // First sample: learn the head, count nothing.
                    continue;
                }
            } else if since.is_none() {
                continue;
            }
            let action = r.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let denom = r.get("denom").and_then(|v| v.as_str()).unwrap_or("");
            if action == "refined" && denom == "ualpha" {
                grams += numeric_f64(r.get("amount_p"))
                    .or_else(|| numeric_f64(r.get("amount")))
                    .unwrap_or(0.0);
            }
        }
        if since.is_none() || !p.has_more || page >= MAX_LEDGER_PAGES || p.items.len() < LEDGER_PAGE / 2 {
            break;
        }
        page += 1;
    }
    (grams, newest)
}

// ── The card's read ──────────────────────────────────────────────────────────

/// Pick the sample to difference against: the newest one at least `WINDOW_MS`
/// old, else the oldest we have (and the window it actually spans).
fn baseline<'a>(samples: &'a VecDeque<Sample>, now_ts: f64) -> Option<&'a Sample> {
    samples
        .iter()
        .rev()
        .find(|s| now_ts - s.ts >= WINDOW_MS)
        .or_else(|| samples.front().filter(|s| now_ts - s.ts > 0.0))
}

/// Rates over the last hour (or the longest window we have), with K/D over
/// the last day. Every figure is `null` until there is something to say.
pub fn snapshot() -> Value {
    let s = lock();
    let now = now_millis();
    let day = |q: &VecDeque<f64>| q.iter().filter(|t| now - **t <= 24.0 * 3_600_000.0).count();
    let kills = day(&s.kills);
    let losses = day(&s.losses);

    let latest = s.samples.back();
    let base = latest.and_then(|l| baseline(&s.samples, l.ts)).filter(|b| latest.map(|l| b.ts < l.ts).unwrap_or(false));
    let (ore, alpha, seized, window_h, partial) = match (latest, base) {
        (Some(l), Some(b)) => {
            let hours = (l.ts - b.ts) / 3_600_000.0;
            let per_h = |a: f64, b: f64| if hours > 0.0 { ((a - b) / hours).max(0.0) } else { 0.0 };
            (
                Some(per_h(l.mined_g, b.mined_g)),
                Some(per_h(l.refined_ualpha, b.refined_ualpha)),
                Some(per_h(l.seized_g, b.seized_g)),
                Some(hours),
                l.players != b.players || l.failed > 0 || b.failed > 0,
            )
        }
        _ => (None, None, None, None, false),
    };
    json!({
        "ore_g_h": ore,
        "alpha_ualpha_h": alpha,
        "seized_g_h": seized,
        "window_h": window_h,
        "partial": partial,
        "kills_24h": kills,
        "losses_24h": losses,
        "kd": if losses > 0 { Some(kills as f64 / losses as f64) } else if kills > 0 { Some(kills as f64) } else { None },
        "sampled_at_ms": latest.map(|l| l.ts),
        "samples": s.samples.len(),
        "next_sample_ms": latest.map(|l| (l.ts + SAMPLE_INTERVAL_MS - now).max(0.0)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volley(attacker: &str, shots: &[(&str, bool)]) -> Value {
        json!({
            "attackerPlayerId": attacker,
            "eventAttackShotDetail": shots.iter().map(|(t, d)| json!({"targetPlayerId": t, "targetDestroyed": d})).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn kills_and_losses_come_from_destroyed_shots_only() {
        let ours = |id: &str| id == "1-194" || id == "1-248";
        assert_eq!(count_volley(&volley("1-194", &[("1-61", true), ("1-61", false)]), ours), (1, 0));
        assert_eq!(count_volley(&volley("1-61", &[("1-194", true), ("1-248", true), ("1-9", true)]), ours), (0, 2));
        // A self-raid counts on both sides, as the achievements fold does.
        assert_eq!(count_volley(&volley("1-194", &[("1-248", true)]), ours), (1, 1));
        assert_eq!(count_volley(&json!({"attackerPlayerId": "1-194"}), ours), (0, 0));
        // The flag arrives as a string from some feeds.
        let v = json!({"attackerPlayerId": "1-194", "eventAttackShotDetail": [{"targetPlayerId": "1-61", "targetDestroyed": "true"}]});
        assert_eq!(count_volley(&v, ours), (1, 0));
    }

    #[test]
    fn baseline_prefers_the_newest_sample_an_hour_old_and_falls_back_to_the_oldest() {
        let mk = |ts: f64| Sample { ts, ..Default::default() };
        let mut q: VecDeque<Sample> = VecDeque::new();
        let now = 10.0 * 3_600_000.0;
        q.push_back(mk(now - 3.0 * 3_600_000.0));
        q.push_back(mk(now - 1.5 * 3_600_000.0));
        q.push_back(mk(now - 0.5 * 3_600_000.0));
        assert_eq!(baseline(&q, now).unwrap().ts, now - 1.5 * 3_600_000.0);
        let mut short: VecDeque<Sample> = VecDeque::new();
        short.push_back(mk(now - 0.4 * 3_600_000.0));
        short.push_back(mk(now - 0.1 * 3_600_000.0));
        assert_eq!(baseline(&short, now).unwrap().ts, now - 0.4 * 3_600_000.0);
        assert!(baseline(&VecDeque::new(), now).is_none());
    }
}
