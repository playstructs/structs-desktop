//! AARRR (pirate metrics) for the Telemetry card: Awareness, Acquisition,
//! Activation, Retention, Referral, over the last day, week and month, plus
//! the daily series behind each and the tutorial's effect on them.
//!
//! | stage | what counts | source |
//! |---|---|---|
//! | Awareness | signup sessions opened | the guilds' signup funnels (no date range: windows are differences in the daily record) |
//! | Acquisition | players created | the chain's player table (`created_at`), and the funnels' finished signups |
//! | Activation | alpha refined AND a raid initiated | each player's ledger (first `refined` ualpha credit) and the raid log (first `initiated` on their fleet) |
//! | Retention | acted in the window (DAU · WAU · MAU) | the chain's `lastAction` |
//! | Referral | — | not recorded anywhere |
//!
//! Everything here is pure: the caller picks the population.

use serde_json::{json, Value};

use crate::mcp::onboarding_history::Day;
use crate::mcp::onboarding_players::{epoch_day, PlayerFacts, PlayerStats, LEDGER_V};

/// The windows every stage is counted over, in days.
pub const WINDOWS: [i64; 3] = [1, 7, 30];
/// How many days back the daily series reach.
pub const SERIES_DAYS: i64 = 60;
const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Copy)]
enum Kind {
    Refine,
    Mine,
    Raid,
}

#[derive(Clone, Copy)]
pub struct Member<'a> {
    pub facts: &'a PlayerFacts,
    pub stats: Option<&'a PlayerStats>,
}

impl Member<'_> {
    pub fn refined(&self) -> bool {
        self.facts.refined_g.map_or(false, |g| g > 0.0)
    }
    pub fn mined(&self) -> bool {
        self.facts.mined_g.map_or(false, |g| g > 0.0)
    }
    pub fn raided(&self) -> bool {
        self.stats.map_or(false, |s| s.raids_initiated > 0.0)
    }
    /// Refined alpha and initiated a raid, ever.
    pub fn activated(&self) -> bool {
        self.refined() && self.raided()
    }
    /// When the second of the two firsts happened. `None` when either is
    /// missing or untimed (a ledger read before times were kept).
    pub fn activated_ms(&self) -> Option<i64> {
        let r = self.facts.first_refined_ms.filter(|_| self.refined())?;
        let a = self.stats.and_then(|s| s.first_raid_ms).filter(|_| self.raided())?;
        Some(r.max(a))
    }
    fn days(&self, k: Kind) -> &[i32] {
        match k {
            Kind::Refine => &self.facts.refine_days,
            Kind::Mine => &self.facts.mine_days,
            Kind::Raid => self.stats.map_or(&[], |s| s.raid_days.as_slice()),
        }
    }
    fn last_raid_ms(&self) -> Option<i64> {
        self.stats.and_then(|s| s.last_raid_ms)
    }
}

/// Whether every player's dates are in: a ledger read before times were kept,
/// or a raid log read before then, would count as "not in the window".
/// `(ledgers, raids)`.
pub fn dated(members: &[Member]) -> (bool, bool) {
    let ledgers = members.iter().all(|m| !(m.refined() || m.mined()) || m.facts.ledger_v >= LEDGER_V);
    let raids = members.iter().all(|m| !m.raided() || m.stats.map_or(false, |s| s.first_raid_ms.is_some()));
    (ledgers, raids)
}

/// A count, or `null` while the dates it needs are still being read.
fn known(ok: bool, n: usize) -> Value {
    if ok {
        json!(n)
    } else {
        Value::Null
    }
}

fn within(t: Option<i64>, now: i64, days: i64) -> bool {
    t.map_or(false, |t| t > now - days * DAY_MS && t <= now)
}

fn ratio(a: usize, b: usize) -> Value {
    if b > 0 {
        json!(a as f64 / b as f64)
    } else {
        Value::Null
    }
}

/// The chain's stages for one population: one entry per window, then `all`.
///
/// - `new`: players created in the window.
/// - `activated`: players whose activation (the later of first refine and
///   first raid) fell in the window; `cohort`: of `new`, how many have
///   activated by now.
/// - `refiners` / `raiders` / `miners`: did it at least once in the window.
/// - `active`: acted in the window; `active_activated`: those of them who
///   have ever activated.
pub fn stages(members: &[Member], now: i64) -> Value {
    let count = |f: &dyn Fn(&Member) -> bool| members.iter().filter(|m| f(m)).count();
    let activated_ever = count(&|m| m.activated());
    let (ledgers, raids) = dated(members);
    let windows: Vec<Value> = WINDOWS
        .iter()
        .map(|&w| {
            let new = count(&|m| within(m.facts.created_ms, now, w));
            let cohort = count(&|m| within(m.facts.created_ms, now, w) && m.activated());
            let active = count(&|m| within(m.facts.last_active_ms, now, w));
            let active_activated = count(&|m| m.activated() && within(m.facts.last_active_ms, now, w));
            json!({
                "days": w,
                "new": new,
                "activated": known(ledgers && raids, count(&|m| within(m.activated_ms(), now, w))),
                "cohort": cohort, "cohort_rate": ratio(cohort, new),
                "refiners": known(ledgers, count(&|m| within(m.facts.last_refined_ms, now, w))),
                "miners": known(ledgers, count(&|m| within(m.facts.last_mined_ms, now, w))),
                "raiders": known(raids, count(&|m| within(m.last_raid_ms(), now, w))),
                "active": active,
                "active_activated": active_activated,
                "retention_rate": ratio(active_activated, activated_ever),
            })
        })
        .collect();
    let untimed = count(&|m| m.activated() && m.activated_ms().is_none());
    let acted = count(&|m| m.facts.last_active_ms.is_some());
    json!({
        "windows": windows,
        "all": {
            "players": members.len(),
            "acted": acted,
            "activated": activated_ever, "activation_rate": ratio(activated_ever, members.len()),
            "refiners": count(&|m| m.refined()),
            "miners": count(&|m| m.mined()),
            "raiders": count(&|m| m.raided()),
        },
        // Activated, but when is not known yet: their ledger predates the times.
        "untimed": untimed,
        "dated": { "ledgers": ledgers, "raids": raids },
        "time_to_activate": crate::mcp::onboarding::spread(
            members.iter().filter_map(|m| Some(((m.activated_ms()? - m.facts.created_ms?).max(0) as f64) / 1000.0)).collect()
        ),
        "stickiness": {
            "dau": count(&|m| within(m.facts.last_active_ms, now, 1)),
            "mau": count(&|m| within(m.facts.last_active_ms, now, 30)),
        },
    })
}

fn day_label(day: i32) -> String {
    chrono::DateTime::from_timestamp_millis(day as i64 * DAY_MS).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Any of `days` (ascending) in `[lo, hi]`.
fn any_in(days: &[i32], lo: i32, hi: i32) -> bool {
    let i = days.partition_point(|d| *d < lo);
    i < days.len() && days[i] <= hi
}

/// One value a day for the last `SERIES_DAYS` days, rebuilt from each
/// player's own dates, so a series reaches back before the card first ran.
/// `lastAction` keeps only its latest value, so who was ACTIVE on a past day
/// cannot be rebuilt: that series is the daily record's (`history_series`).
pub fn series(members: &[Member], now: i64) -> Value {
    let today = epoch_day(now);
    let days: Vec<i32> = (today - SERIES_DAYS as i32 + 1..=today).collect();
    let created: Vec<Option<i32>> = members.iter().map(|m| m.facts.created_ms.map(epoch_day)).collect();
    let activated: Vec<Option<i32>> = members.iter().map(|m| m.activated_ms().map(epoch_day)).collect();
    let on = |v: &[Option<i32>], d: i32| v.iter().filter(|x| **x == Some(d)).count();
    let upto = |v: &[Option<i32>], d: i32| v.iter().filter(|x| x.map_or(false, |x| x <= d)).count();
    let did = |k: Kind, d: i32, span: i32| members.iter().filter(|m| any_in(m.days(k), d - span + 1, d)).count();
    let (refine, mine, raid) = (Kind::Refine, Kind::Mine, Kind::Raid);
    let (ledgers, raids) = dated(members);
    let col = |f: &dyn Fn(i32) -> usize| days.iter().map(|d| f(*d)).collect::<Vec<_>>();
    let col_if = |ok: bool, f: &dyn Fn(i32) -> usize| days.iter().map(|d| known(ok, f(*d))).collect::<Vec<_>>();
    json!({
        "days": days.iter().map(|d| day_label(*d)).collect::<Vec<_>>(),
        "series": {
            "new": col(&|d| on(&created, d)),
            "players_total": col(&|d| upto(&created, d)),
            "activations": col_if(ledgers && raids, &|d| on(&activated, d)),
            "activated_total": col_if(ledgers && raids, &|d| upto(&activated, d)),
            "refiners": col_if(ledgers, &|d| did(refine, d, 1)),
            "refiners_7d": col_if(ledgers, &|d| did(refine, d, 7)),
            "miners": col_if(ledgers, &|d| did(mine, d, 1)),
            "miners_7d": col_if(ledgers, &|d| did(mine, d, 7)),
            "raiders": col_if(raids, &|d| did(raid, d, 1)),
            "raiders_7d": col_if(raids, &|d| did(raid, d, 7)),
        },
    })
}

/// A server total from one day's record: every guild's, or one guild's.
fn server_total(d: &Day, guild: Option<&str>, i: usize) -> Option<f64> {
    let s = d.server.as_ref()?;
    match guild {
        None => Some(if i == 0 { s.signups_started } else { s.signed_up }),
        Some(g) => s.guilds.get(g).map(|v| v[i]),
    }
}

/// Awareness (signup sessions opened) and finished signups over each window.
/// The servers keep only running totals, so a window is today's total less
/// the total the daily record held `w` days ago; `null` until the record is
/// that old. `now`: today's totals, `[started, finished]`.
pub fn server_windows(history: &[Day], now_totals: Option<[f64; 2]>, guild: Option<&str>, now: i64) -> Value {
    let Some(cur) = now_totals else { return Value::Null };
    let today = epoch_day(now);
    // The reference is the record on the window's first day, or a day or
    // two before a long window's: an older one would stretch "24 hours"
    // over every day the record missed.
    let at = |day: i32, slack: i32, i: usize| -> Option<f64> {
        history
            .iter()
            .rev()
            .filter(|d| d.ts_ms > 0 && epoch_day(d.ts_ms) <= day && epoch_day(d.ts_ms) >= day - slack)
            .find_map(|d| server_total(d, guild, i))
    };
    let since = history.iter().find(|d| server_total(d, guild, 0).is_some()).map(|d| d.day.clone());
    let windows: Vec<Value> = WINDOWS
        .iter()
        .map(|&w| {
            let slack = (w / 7) as i32;
            let diff = |i: usize| at(today - w as i32, slack, i).map(|then| (cur[i] - then).max(0.0));
            json!({ "days": w, "started": diff(0), "signed_up": diff(1) })
        })
        .collect();
    json!({ "windows": windows, "all": { "started": cur[0], "signed_up": cur[1] }, "since": since })
}

/// The daily record's own series (humans, every guild): the ones nothing
/// else can rebuild. Days with no row are `null`, never zero.
pub fn history_series(history: &[Day], now: i64) -> Value {
    let today = epoch_day(now);
    let days: Vec<i32> = (today - SERIES_DAYS as i32 + 1..=today).collect();
    let row = |d: i32| history.iter().rev().find(|r| r.ts_ms > 0 && epoch_day(r.ts_ms) == d);
    let col = |f: &dyn Fn(&Day) -> Option<f64>| days.iter().map(|d| row(*d).and_then(|r| f(r))).collect::<Vec<_>>();
    json!({
        "days": days.iter().map(|d| day_label(*d)).collect::<Vec<_>>(),
        "series": {
            "dau": col(&|r| Some(r.active_1d as f64)),
            "wau": col(&|r| Some(r.active_7d as f64)),
            "mau": col(&|r| Some(r.active_30d as f64)),
            "signups_started": col(&|r| r.server.as_ref().map(|s| s.signups_started)),
            "signed_up": col(&|r| r.server.as_ref().map(|s| s.signed_up)),
        },
    })
}

// ── The tutorial's effect ───────────────────────────────────────────────────

/// What a player did with Combat Training, from their signup session and
/// every run the servers recorded.
pub const TUTORIAL_GROUPS: [(&str, &str); 4] = [("finished", "Finished"), ("quit", "Quit"), ("skipped", "Skipped"), ("none", "No record")];

/// `finished`: completed any run. `quit`: started one, finished none.
/// `skipped`: declined the offer, or left at it without starting. `none`:
/// nothing recorded (an API signup, a lost beacon, or before telemetry).
pub fn tutorial_group(completed: bool, started: bool, offered: bool) -> &'static str {
    if completed {
        "finished"
    } else if started {
        "quit"
    } else if offered {
        "skipped"
    } else {
        "none"
    }
}

fn median(mut v: Vec<f64>) -> Value {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    json!(v[(v.len() - 1) / 2])
}

/// One row per tutorial group: how far its players got in the game. Counts,
/// not rates, so a small group reads as small.
pub fn tutorial_impact(members: &[(&str, Member)], now: i64) -> Vec<Value> {
    let row = |key: &str, label: &str, ms: Vec<&Member>| {
        let count = |f: &dyn Fn(&Member) -> bool| ms.iter().filter(|m| f(m)).count();
        json!({
            "key": key, "label": label,
            "players": ms.len(),
            "acted": count(&|m| m.facts.last_active_ms.is_some()),
            "mined": count(&|m| m.mined()),
            "refined": count(&|m| m.refined()),
            "raided": count(&|m| m.raided()),
            "activated": count(&|m| m.activated()),
            "active_7d": count(&|m| within(m.facts.last_active_ms, now, 7)),
            "active_30d": count(&|m| within(m.facts.last_active_ms, now, 30)),
            "refined_p50": median(ms.iter().filter(|m| m.refined()).filter_map(|m| m.facts.refined_g).collect()),
            "raids_p50": median(ms.iter().filter(|m| m.raided()).filter_map(|m| m.stats.map(|s| s.raids_initiated)).collect()),
            "activate_days_p50": median(ms.iter().filter_map(|m| Some((m.activated_ms()? - m.facts.created_ms?).max(0) as f64 / DAY_MS as f64)).collect()),
            "play_days_p50": median(ms.iter().filter_map(|m| Some((m.facts.last_active_ms? - m.facts.created_ms?).max(0) as f64 / DAY_MS as f64)).collect()),
        })
    };
    let mut out: Vec<Value> = TUTORIAL_GROUPS
        .iter()
        .map(|(k, l)| row(k, l, members.iter().filter(|(g, _)| g == k).map(|(_, m)| m).collect()))
        .collect();
    out.push(row("all", "All", members.iter().map(|(_, m)| m).collect()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::onboarding_history::ServerDay;

    const NOW: i64 = 1_795_000_000_000;
    const H: i64 = 3_600_000;

    fn facts(created_h: i64, active_h: Option<i64>, refined_h: Option<i64>) -> PlayerFacts {
        PlayerFacts {
            created_ms: Some(NOW - created_h * H),
            last_active_ms: active_h.map(|h| NOW - h * H),
            refined_g: Some(if refined_h.is_some() { 5.0 } else { 0.0 }),
            first_refined_ms: refined_h.map(|h| NOW - h * H),
            last_refined_ms: refined_h.map(|h| NOW - h * H),
            refine_days: refined_h.map(|h| vec![epoch_day(NOW - h * H)]).unwrap_or_default(),
            ledger_v: LEDGER_V,
            ..Default::default()
        }
    }
    fn raids(first_h: i64) -> PlayerStats {
        PlayerStats { raids_initiated: 2.0, first_raid_ms: Some(NOW - first_h * H), last_raid_ms: Some(NOW - first_h * H), raid_days: vec![epoch_day(NOW - first_h * H)], ..Default::default() }
    }

    #[test]
    fn activation_needs_both_a_refine_and_a_raid_and_dates_from_the_later() {
        let (a, b, c) = (facts(100, Some(1), Some(50)), facts(10, Some(2), Some(5)), facts(10, None, None));
        let (ra, rb) = (raids(60), raids(3));
        let ms = [Member { facts: &a, stats: Some(&ra) }, Member { facts: &b, stats: Some(&rb) }, Member { facts: &c, stats: Some(&rb) }];
        assert_eq!(ms[0].activated_ms(), Some(NOW - 50 * H), "the later of the two firsts");
        assert!(!ms[2].activated(), "a raid alone is not activation");
        let s = stages(&ms, NOW);
        let w = |d: usize, k: &str| s["windows"][d][k].as_u64().unwrap();
        assert_eq!((w(0, "new"), w(0, "activated"), w(0, "cohort")), (2, 1, 1), "a day: b and c joined, b activated");
        assert_eq!((w(1, "activated"), w(2, "activated")), (2, 2), "a, 50 hours ago, is inside the week");
        assert_eq!((w(0, "refiners"), w(0, "raiders")), (1, 2));
        assert_eq!((w(0, "active"), w(0, "active_activated")), (2, 2));
        assert_eq!(s["all"]["activated"], 2);
        assert_eq!(s["windows"][0]["retention_rate"], 1.0);
        assert_eq!(s["stickiness"]["dau"], 2);
    }

    #[test]
    fn an_untimed_activation_counts_ever_but_never_in_a_window() {
        let mut a = facts(100, Some(1), Some(50));
        a.first_refined_ms = None;
        let r = raids(60);
        let s = stages(&[Member { facts: &a, stats: Some(&r) }], NOW);
        assert_eq!((s["all"]["activated"].as_u64(), s["untimed"].as_u64()), (Some(1), Some(1)));
        assert_eq!(s["windows"][2]["activated"], 0);
    }

    #[test]
    fn a_window_is_unknown_until_every_date_it_needs_is_read() {
        let mut old = facts(100, Some(1), Some(5));
        old.ledger_v = 1;
        let fresh = facts(100, Some(1), Some(5));
        let r = raids(3);
        let mut untimed = raids(3);
        untimed.first_raid_ms = None;
        let s = stages(&[Member { facts: &old, stats: Some(&r) }, Member { facts: &fresh, stats: Some(&r) }], NOW);
        assert!(s["windows"][0]["refiners"].is_null() && s["windows"][0]["activated"].is_null(), "an old ledger read leaves refining unknown");
        assert_eq!(s["windows"][0]["raiders"], 2);
        let t = stages(&[Member { facts: &fresh, stats: Some(&untimed) }], NOW);
        assert!(t["windows"][0]["raiders"].is_null() && t["windows"][0]["refiners"] == 1);
        assert_eq!(t["dated"], json!({ "ledgers": true, "raids": false }));
        let sr = series(&[Member { facts: &old, stats: Some(&r) }], NOW);
        assert!(sr["series"]["refiners_7d"][0].is_null() && !sr["series"]["raiders_7d"][0].is_null() && !sr["series"]["new"][0].is_null());
    }

    #[test]
    fn series_are_rebuilt_from_each_players_dates() {
        let a = facts(24 * 3, Some(1), Some(24 * 2));
        let r = raids(24 * 2 + 1);
        let s = series(&[Member { facts: &a, stats: Some(&r) }], NOW);
        let col = |k: &str| s["series"][k].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect::<Vec<_>>();
        let n = SERIES_DAYS as usize;
        assert_eq!(col("new")[n - 4..], [1, 0, 0, 0], "joined three days ago");
        assert_eq!(col("refiners")[n - 3..], [1, 0, 0]);
        assert_eq!(col("refiners_7d")[n - 3..], [1, 1, 1], "a refine two days ago is within each later week");
        assert_eq!(col("activated_total")[n - 1], 1);
        assert_eq!(col("players_total")[n - 5..], [0, 1, 1, 1, 1]);
        assert_eq!(s["days"].as_array().unwrap().len(), n);
    }

    fn day(ts: i64, started: f64, signed: f64) -> Day {
        let mut guilds = std::collections::BTreeMap::new();
        guilds.insert("0-1".to_string(), [started / 2.0, signed / 2.0]);
        Day { day: String::new(), ts_ms: ts, server: Some(ServerDay { signups_started: started, signed_up: signed, guilds, ..Default::default() }), ..Default::default() }
    }

    #[test]
    fn server_windows_are_differences_in_the_daily_record() {
        let h = vec![day(NOW - 8 * 24 * H, 10.0, 4.0), day(NOW - 24 * H, 20.0, 8.0), Day { ts_ms: NOW - 12 * H, ..Default::default() }];
        let s = server_windows(&h, Some([25.0, 9.0]), None, NOW);
        assert_eq!(s["windows"][0]["started"], 5.0);
        assert_eq!(s["windows"][1]["started"], 15.0, "a week, from the record a day before it began");
        // The record missed yesterday: 24 hours is unknown, not the nine days since the last row.
        let gap = vec![day(NOW - 9 * 24 * H, 10.0, 4.0)];
        let g = server_windows(&gap, Some([25.0, 9.0]), None, NOW);
        assert!(g["windows"][0]["started"].is_null() && g["windows"][1]["started"].is_null(), "{g}");
        assert!(s["windows"][2]["started"].is_null(), "the record is not a month old");
        let g = server_windows(&h, Some([12.5, 4.5]), Some("0-1"), NOW);
        assert_eq!(g["windows"][0]["signed_up"], 0.5);
        assert!(server_windows(&h, None, None, NOW).is_null());
    }

    #[test]
    fn a_missing_day_is_a_gap_in_the_records_series() {
        let h = vec![Day { ts_ms: NOW - 2 * 24 * H, active_1d: 4, ..Default::default() }];
        let s = history_series(&h, NOW);
        let dau = s["series"]["dau"].as_array().unwrap();
        assert_eq!(dau[dau.len() - 3].as_f64(), Some(4.0));
        assert!(dau[dau.len() - 1].is_null() && dau[dau.len() - 2].is_null());
    }

    #[test]
    fn tutorial_groups_rank_finishing_over_starting_over_the_offer() {
        assert_eq!(tutorial_group(true, true, true), "finished");
        assert_eq!(tutorial_group(false, true, true), "quit");
        assert_eq!(tutorial_group(false, false, true), "skipped");
        assert_eq!(tutorial_group(false, false, false), "none");
        let (a, b) = (facts(100, Some(1), Some(50)), facts(100, None, None));
        let r = raids(60);
        let rows = tutorial_impact(&[("finished", Member { facts: &a, stats: Some(&r) }), ("none", Member { facts: &b, stats: None })], NOW);
        assert_eq!(rows.len(), TUTORIAL_GROUPS.len() + 1);
        assert_eq!((rows[0]["players"].as_u64(), rows[0]["activated"].as_u64(), rows[0]["active_7d"].as_u64()), (Some(1), Some(1), Some(1)));
        assert_eq!((rows[3]["players"].as_u64(), rows[3]["acted"].as_u64()), (Some(1), Some(0)));
        assert_eq!(rows[4]["players"], 2);
        assert!(rows[1]["refined_p50"].is_null(), "an empty group has no median");
    }
}

/// The real caches, read as the card would: `cargo test --bin structs-app pirate_on_the_real_cache -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::mcp::onboarding::PlayerSession;
    use std::collections::HashMap;

    #[test]
    #[ignore]
    fn pirate_on_the_real_cache() {
        let u: crate::mcp::onboarding_players::Universe = crate::mcp::cache_store::load("onboarding_universe").expect("universe cache");
        let sessions: HashMap<String, PlayerSession> = crate::mcp::cache_store::load("onboarding_players").unwrap_or_default();
        let stats = u.stats();
        let now = chrono::Utc::now().timestamp_millis();
        let human = |id: &str| !u.replicants.contains_key(id) && !u.likely.contains(id);
        let ms: Vec<Member> = u.players.iter().filter(|(id, _)| human(id)).map(|(id, p)| Member { facts: p, stats: stats.get(id) }).collect();
        let s = stages(&ms, now);
        println!("ALL {}", s["all"]);
        for w in s["windows"].as_array().unwrap() {
            println!("W {w}");
        }
        println!("untimed {} t2a {} stick {}", s["untimed"], s["time_to_activate"], s["stickiness"]);
        let rows: Vec<(&str, Member)> = u
            .players
            .iter()
            .filter(|(id, _)| human(id) && id.split_once('-').and_then(|(_, i)| i.parse::<u64>().ok()).map_or(false, |i| i >= 5_700))
            .map(|(id, p)| {
                let g = sessions.get(id).filter(|s| !s.events.is_empty()).map_or("none", |s| {
                    let o = s.outcome(now, 24);
                    tutorial_group(o == "completed", s.events.iter().any(|e| e.k == "tutorial.loading" && !e.s), s.events.iter().any(|e| e.k == "orientation.tutorial_offer"))
                });
                (g, Member { facts: p, stats: stats.get(id) })
            })
            .collect();
        for r in tutorial_impact(&rows, now) {
            println!("T {r}");
        }
        let sr = series(&ms, now);
        let tail = |k: &str| sr["series"][k].as_array().unwrap().iter().rev().take(14).rev().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
        println!("DAYS {} .. {}", sr["days"][0], sr["days"][SERIES_DAYS as usize - 1]);
        for k in ["new", "players_total", "activated_total", "refiners_7d", "raiders_7d", "miners_7d"] {
            println!("S {k}: {}", tail(k));
        }
        let h: Vec<Day> = crate::mcp::cache_store::load("onboarding_history").unwrap_or_default();
        let last = h.iter().rev().find_map(|d| d.server.as_ref().map(|s| [s.signups_started, s.signed_up]));
        println!("SRV {}", server_windows(&h, last, None, now));
        let hs = history_series(&h, now);
        let htail = |k: &str| hs["series"][k].as_array().unwrap().iter().rev().take(16).rev().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
        println!("H mau: {}\nH signups_started: {}", htail("mau"), htail("signups_started"));
        if let Ok(path) = std::env::var("PIRATE_OUT") {
            let out = serde_json::json!({
                "pirate": s, "pirate_series": sr, "pirate_server": server_windows(&h, last, None, now),
                "tutorial_impact": tutorial_impact(&rows, now), "history_series": hs, "trend_series": sr,
            });
            std::fs::write(path, out.to_string()).unwrap();
        }
    }
}
