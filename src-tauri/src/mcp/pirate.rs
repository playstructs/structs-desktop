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

use std::collections::BTreeMap;

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

/// How many sessions opened and finished between a past day's record and
/// now (`cur`: each guild's running totals today). `None` when that day is
/// not comparable:
/// - its totals are another tutorial version's (each version's funnel is its
///   own count, so a version bump would read as everything vanishing);
/// - for one guild, the guild is missing from it or from today.
///
/// Every guild is diffed on its own and only guilds present on both days
/// are summed, so a guild whose telemetry first appears adds its sessions
/// from then on, not its whole history in one day. A day recorded before
/// per-guild totals were kept falls back to the summed total.
fn server_since(d: &Day, cur: &BTreeMap<String, [f64; 2]>, version: &str, guild: Option<&str>) -> Option<[f64; 2]> {
    let s = d.server.as_ref().filter(|s| s.version == version)?;
    // A day some guild failed on cannot stand for every guild.
    if s.partial && guild.is_none() {
        return None;
    }
    let diff = |now: [f64; 2], then: [f64; 2]| [(now[0] - then[0]).max(0.0), (now[1] - then[1]).max(0.0)];
    match guild {
        Some(g) => Some(diff(*cur.get(g)?, *s.guilds.get(g)?)),
        None if s.guilds.is_empty() => {
            let sum = cur.values().fold([0.0, 0.0], |a, v| [a[0] + v[0], a[1] + v[1]]);
            Some(diff(sum, [s.signups_started, s.signed_up]))
        }
        None => Some(cur.iter().filter_map(|(g, now)| s.guilds.get(g).map(|then| diff(*now, *then))).fold([0.0, 0.0], |a, v| [a[0] + v[0], a[1] + v[1]])),
    }
}

/// Awareness (signup sessions opened) and finished signups over each window.
/// The servers keep only running totals, so a window is today's total less
/// the total the daily record held `w` days ago; `null` until the record is
/// that old, or while it holds another version's totals. `cur`: today's
/// totals per guild, `[started, finished]`, for `version`.
pub fn server_windows(history: &[Day], cur: Option<&BTreeMap<String, [f64; 2]>>, version: &str, guild: Option<&str>, now: i64) -> Value {
    let Some(cur) = cur else { return Value::Null };
    let Some(all) = (match guild {
        Some(g) => cur.get(g).copied(),
        None => Some(cur.values().fold([0.0, 0.0], |a, v| [a[0] + v[0], a[1] + v[1]])),
    }) else {
        return Value::Null;
    };
    let today = epoch_day(now);
    // The reference is the record on the window's first day, or a day or
    // two before a long window's: an older one would stretch "24 hours"
    // over every day the record missed.
    let at = |day: i32, slack: i32| -> Option<[f64; 2]> {
        history
            .iter()
            .rev()
            .filter(|d| d.ts_ms > 0 && epoch_day(d.ts_ms) <= day && epoch_day(d.ts_ms) >= day - slack)
            .find_map(|d| server_since(d, cur, version, guild))
    };
    let since = history.iter().find(|d| server_since(d, cur, version, guild).is_some()).map(|d| d.day.clone());
    let windows: Vec<Value> = WINDOWS
        .iter()
        .map(|&w| {
            let x = at(today - w as i32, (w / 7) as i32);
            json!({ "days": w, "started": x.map(|x| x[0]), "signed_up": x.map(|x| x[1]) })
        })
        .collect();
    // Until a window fills, the newest reading before today still says how
    // many opened since then, over however many days that was.
    let prior = history
        .iter()
        .rev()
        .filter(|d| d.ts_ms > 0 && epoch_day(d.ts_ms) < today)
        .find_map(|d| Some((d.day.clone(), server_since(d, cur, version, guild)?)))
        .map(|(day, x)| json!({ "day": day, "started": x[0], "signed_up": x[1] }));
    // The longest stretch the record can answer: since its oldest usable day.
    let oldest = history
        .iter()
        .filter(|d| d.ts_ms > 0 && epoch_day(d.ts_ms) < today)
        .find_map(|d| Some((d.day.clone(), server_since(d, cur, version, guild)?)))
        .map(|(day, x)| json!({ "day": day, "started": x[0], "signed_up": x[1] }));
    json!({ "windows": windows, "all": { "started": all[0], "signed_up": all[1] }, "since": since, "prior": prior, "oldest": oldest, "version": version })
}

/// The daily record's own series (humans, every guild): the ones nothing
/// else can rebuild. Days with no row are `null`, never zero.
pub fn history_series(history: &[Day], now: i64) -> Value {
    let today = epoch_day(now);
    let days: Vec<i32> = (today - SERIES_DAYS as i32 + 1..=today).collect();
    let history: Vec<&Day> = crate::mcp::onboarding_history::current(history).collect();
    let row = |d: i32| history.iter().rev().find(|r| r.ts_ms > 0 && epoch_day(r.ts_ms) == d).copied();
    let col = |f: &dyn Fn(&Day) -> Option<f64>| days.iter().map(|d| row(*d).and_then(|r| f(r))).collect::<Vec<_>>();
    // Server totals are per tutorial version: only the newest version's
    // days are one series (an older version's would read as a fall).
    let version = history.iter().rev().find_map(|r| r.server.as_ref().map(|s| s.version.clone()));
    fn srv<'a>(r: &'a Day, version: &Option<String>) -> Option<&'a crate::mcp::onboarding_history::ServerDay> {
        r.server.as_ref().filter(|s| Some(&s.version) == version.as_ref())
    }
    json!({
        "days": days.iter().map(|d| day_label(*d)).collect::<Vec<_>>(),
        "series": {
            "dau": col(&|r| Some(r.active_1d as f64)),
            "wau": col(&|r| Some(r.active_7d as f64)),
            "mau": col(&|r| Some(r.active_30d as f64)),
            "signups_started": col(&|r| srv(r, &version).filter(|s| !s.partial).map(|s| s.signups_started)),
            "signed_up": col(&|r| srv(r, &version).filter(|s| !s.partial).map(|s| s.signed_up)),
        },
        "version": version,
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

/// The pirate funnel over the TRACKED players only: those whose signup was
/// recorded (a signup session reaching the employee record). `signups` counts
/// every such session; `members` are the ones whose chain facts are read, so
/// activation and activity are counted among exactly these players.
/// Active users = activated players who acted within the window.
pub fn tracked(members: &[Member], signups: usize, now: i64) -> Value {
    let activated: Vec<&Member> = members.iter().filter(|m| m.activated()).collect();
    let active = |w: i64| activated.iter().filter(|m| within(m.facts.last_active_ms, now, w)).count();
    json!({
        "signups": signups,
        "read": members.len(),
        // Whose ledger is read: until it is, a refine (and so activation) is unknown.
        "ledgers": members.iter().filter(|m| m.facts.mined_g.is_some()).count(),
        "activated": activated.len(),
        "active_activated": { "1": active(1), "7": active(7), "30": active(30) },
    })
}

// ── Cohorts: every stage counted over the players who joined together ──────
//
// The owner's definitions (2026-11-20):
// - Activated = refined alpha AND initiated a raid. No deadline: how long
//   after joining it happened is the page's time context, not a rule.
// - Retention counts everyone who joined, not only the activated.
// - Played = a gameplay action that day: mine, refine, raid, attack, a
//   defense change, a fleet move, a struct build or move
//   (`onboarding_players::PLAYED_ACTIONS`).

/// Join dates before this are the indexer's floor, not when the player
/// joined: it rebuilt its player table in late September (see
/// `onboarding_players`). Cohorts that start earlier say `exact: false`.
pub const JOIN_DATES_EXACT_FROM_MS: i64 = 1_790_208_000_000; // 2026-09-24 00:00 UTC
/// How many join weeks the cohort table reaches back.
pub const COHORT_WEEKS: i32 = 12;
/// Retained in week N after joining (week 1 = days 0–6).
pub const RETAINED_WEEKS: [i32; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
/// Still playing: played within this many days.
pub const PLAYING_DAYS: i32 = 7;
/// Gone: nothing on chain for this many days.
pub const LEFT_DAYS: i64 = 7;

/// The Monday (UTC) of the week holding `day`. Epoch day 0 was a Thursday.
fn monday(day: i32) -> i32 {
    day - (day + 3).rem_euclid(7)
}

impl Member<'_> {
    /// Every day with a gameplay action: the ledger's mines and refines and
    /// the raid log's raids (all history), and the activity feed's other
    /// actions (30 days a read, kept from read to read).
    fn played_days(&self) -> Vec<i32> {
        let mut d: Vec<i32> = [Kind::Mine, Kind::Refine, Kind::Raid].iter().flat_map(|k| self.days(*k).iter().copied()).collect();
        d.extend(self.facts.play_days.iter().copied());
        d.sort_unstable();
        d.dedup();
        d
    }
}

/// One player's journey so far, from the day they joined.
struct Journey {
    joined: i64,
    tracked: bool,
    acted: bool,
    mined: bool,
    refined: bool,
    raided: bool,
    activated: bool,
    /// Acted, but the ledger is unread: mined/refined (and so activated) unknown.
    ledger_unread: bool,
    /// Acted, but the activity feed is unread: only mines, refines and raids count as played.
    activity_unread: bool,
    days_to_activate: Option<f64>,
    /// Days from joining to the first mine, refine and raid.
    days_to: [Option<f64>; 3],
    retained: [bool; RETAINED_WEEKS.len()],
    playing: bool,
}

fn journey(m: &Member, joined: i64, tracked: bool, today: i32) -> Journey {
    let played = m.played_days();
    let jd = epoch_day(joined);
    // A mine, refine or raid is an action whatever `lastAction` says (it can
    // lag one), so every stage stays a subset of `acted`.
    let acted = m.facts.last_active_ms.is_some() || m.mined() || m.refined() || m.raided();
    Journey {
        joined,
        tracked,
        acted,
        mined: m.mined(),
        refined: m.refined(),
        raided: m.raided(),
        activated: m.activated(),
        ledger_unread: acted && m.facts.mined_g.is_none(),
        activity_unread: acted && m.facts.activity_ms == 0,
        days_to_activate: m.activated_ms().map(|t| (t - joined).max(0) as f64 / DAY_MS as f64),
        days_to: [
            m.facts.first_mined_ms.filter(|_| m.mined()),
            m.facts.first_refined_ms.filter(|_| m.refined()),
            m.stats.and_then(|s| s.first_raid_ms).filter(|_| m.raided()),
        ]
        .map(|t| t.map(|t| (t - joined).max(0) as f64 / DAY_MS as f64)),
        retained: RETAINED_WEEKS.map(|n| any_in(&played, jd + 7 * (n - 1), jd + 7 * n - 1)),
        playing: any_in(&played, today - PLAYING_DAYS + 1, today),
    }
}

/// Counts over one group of journeys. Every stage is a count of the same
/// players. `retained_wN` is `null` ("not yet") while `ready(N)` is false: the
/// group's last possible joiner has not lived through week N.
fn tally(js: &[&Journey], ready: &dyn Fn(i32) -> bool) -> serde_json::Map<String, Value> {
    let n = |f: &dyn Fn(&Journey) -> bool| js.iter().filter(|j| f(j)).count();
    let mut o = serde_json::Map::new();
    o.insert("joined".into(), json!(js.len()));
    o.insert("tracked".into(), json!(n(&|j| j.tracked)));
    o.insert("acted".into(), json!(n(&|j| j.acted)));
    o.insert("mined".into(), json!(n(&|j| j.mined)));
    o.insert("refined".into(), json!(n(&|j| j.refined)));
    o.insert("raided".into(), json!(n(&|j| j.raided)));
    o.insert("refined_or_raided".into(), json!(n(&|j| j.refined || j.raided)));
    o.insert("activated".into(), json!(n(&|j| j.activated)));
    o.insert("ledger_unread".into(), json!(n(&|j| j.ledger_unread)));
    o.insert("activity_unread".into(), json!(n(&|j| j.activity_unread)));
    o.insert("days_to_activate".into(), median(js.iter().filter_map(|j| j.days_to_activate).collect()));
    for (i, k) in ["days_to_mine", "days_to_refine", "days_to_raid"].iter().enumerate() {
        o.insert((*k).into(), median(js.iter().filter_map(|j| j.days_to[i]).collect()));
    }
    o.insert("playing".into(), json!(n(&|j| j.playing)));
    for (i, w) in RETAINED_WEEKS.iter().enumerate() {
        o.insert(format!("retained_w{w}"), if ready(*w) { json!(n(&|j| j.retained[i])) } else { Value::Null });
    }
    o
}

/// The journey of every player who joined together, by join week (Monday,
/// UTC, `COHORT_WEEKS` of them, oldest first), and by join window
/// (`WINDOWS` days, then every player with an exact join date).
///
/// - Every count in a row is of that row's joiners: stages are filters of
///   `joined`, so a share is always "of the players who joined".
/// - Milestones (mined … activated) are "so far": the page's window is the
///   time context. `days_to_activate` is the typical delay.
/// - `retained_wN`: played on a day in week N after joining, of everyone who
///   joined. `null` until the week's last possible joiner has had week N.
/// - `playing`: played in the last `PLAYING_DAYS`.
/// - `tracked[i]`: member i's own signup session was recorded.
/// - `played_since`: the earliest day the activity feed covers for anyone;
///   before it, played counts only mines, refines and raids.
pub fn cohorts(members: &[Member], tracked: &[bool], now: i64) -> Value {
    debug_assert_eq!(members.len(), tracked.len());
    let today = epoch_day(now);
    let js: Vec<Journey> = members.iter().zip(tracked).filter_map(|(m, t)| Some(journey(m, m.facts.created_ms?, *t, today))).collect();
    let first = monday(today) - 7 * (COHORT_WEEKS - 1);
    let weeks: Vec<Value> = (0..COHORT_WEEKS)
        .map(|i| {
            let wk = first + 7 * i;
            let mine: Vec<&Journey> = js.iter().filter(|j| monday(epoch_day(j.joined)) == wk).collect();
            // The week's last joiner joined on its Sunday.
            let mut o = tally(&mine, &|n| today >= wk + 6 + 7 * n);
            o.insert("week".into(), json!(day_label(wk)));
            o.insert("exact".into(), json!(wk as i64 * DAY_MS >= JOIN_DATES_EXACT_FROM_MS));
            Value::Object(o)
        })
        .collect();
    let windows: Vec<Value> = WINDOWS
        .iter()
        .map(|&w| (Some(w), now - w * DAY_MS))
        .chain(std::iter::once((None, JOIN_DATES_EXACT_FROM_MS)))
        .map(|(w, from)| {
            let mine: Vec<&Journey> = js.iter().filter(|j| j.joined > from && j.joined <= now).collect();
            let mut o = tally(&mine, &|_| false);
            o.insert("days".into(), w.map_or(json!("all"), |w| json!(w)));
            o.insert("from".into(), json!(day_label(epoch_day(from))));
            Value::Object(o)
        })
        .collect();
    let played_since = members.iter().filter(|m| m.facts.activity_ms > 0).map(|m| epoch_day(m.facts.activity_ms) - 30).min().map(day_label);
    json!({ "weeks": weeks, "windows": windows, "played_since": played_since, "retained_weeks": RETAINED_WEEKS, "playing_days": PLAYING_DAYS })
}

/// Where the players who left got to: everyone not active in the last
/// `LEFT_DAYS`, each in exactly one bucket by the furthest stage reached.
/// Refining and raiding are two roads, so each has its own bucket.
/// `not_read`: acted, but the ledger is unread, so how far is unknown.
///
/// `who`: the players in each bucket (`ids[i]` is member i), most recently
/// seen first (never-acted: newest joiner first), `LEFT_LISTED` at most.
pub fn left(members: &[Member], ids: &[&str], now: i64) -> Value {
    debug_assert_eq!(members.len(), ids.len());
    let gone: Vec<(&Member, &str)> = members.iter().zip(ids).filter(|(m, _)| !within(m.facts.last_active_ms, now, LEFT_DAYS)).map(|(m, id)| (m, *id)).collect();
    let mut b: BTreeMap<&str, usize> = LEFT_BUCKETS.iter().map(|k| (*k, 0)).collect();
    let mut who: BTreeMap<&str, Vec<(&Member, &str)>> = BTreeMap::new();
    for (m, id) in &gone {
        // What they reached decides, before `lastAction`, which can lag a
        // mine or a raid (a player who mined has acted, whatever it says).
        let unread = m.facts.mined_g.is_none();
        let k = if m.activated() {
            "activated"
        } else if m.raided() {
            if unread { "not_read" } else { "raided_no_refine" }
        } else if m.refined() {
            "refined_no_raid"
        } else if m.mined() {
            "mined_only"
        } else if m.facts.last_active_ms.is_none() {
            "never_acted"
        } else if unread {
            "not_read"
        } else {
            "acted_only"
        };
        *b.get_mut(k).unwrap() += 1;
        who.entry(k).or_default().push((m, id));
    }
    let who: serde_json::Map<String, Value> = who
        .into_iter()
        .map(|(k, mut v)| {
            v.sort_by_key(|(m, _)| std::cmp::Reverse(m.facts.last_active_ms.or(m.facts.created_ms).unwrap_or(0)));
            let rows = v.iter().take(LEFT_LISTED).map(|(m, id)| {
                json!({ "player_id": id, "name": m.facts.name, "guild_id": m.facts.guild, "joined_ms": m.facts.created_ms, "last_ms": m.facts.last_active_ms })
            });
            (k.to_string(), Value::Array(rows.collect()))
        })
        .collect();
    json!({ "days": LEFT_DAYS, "players": members.len(), "active": members.len() - gone.len(), "left": gone.len(), "furthest": b, "who": who })
}

/// The buckets of `left`, in the order a player meets them.
pub const LEFT_BUCKETS: [&str; 7] = ["never_acted", "acted_only", "mined_only", "refined_no_raid", "raided_no_refine", "activated", "not_read"];
/// Players listed per bucket; the count is always the whole bucket.
pub const LEFT_LISTED: usize = 200;
/// Active users listed; the count is always all of them.
pub const ACTIVE_LISTED: usize = 200;

/// The active users by name: activated, and did anything in the last
/// `PLAYED_WINDOW` days, so the page can list any of its windows (`within`
/// = how many in each; the list is cut by `last_ms`). Most days played first.
pub fn active_users(members: &[Member], ids: &[&str], now: i64) -> Value {
    let today = epoch_day(now);
    let mut rows: Vec<(usize, &Member, &str)> = members
        .iter()
        .zip(ids)
        .filter(|(m, _)| m.activated() && within(m.facts.last_active_ms, now, PLAYED_WINDOW as i64))
        .map(|(m, id)| (m.played_days().iter().filter(|d| **d > today - PLAYED_WINDOW && **d <= today).count(), m, *id))
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.facts.last_active_ms.cmp(&a.1.facts.last_active_ms)));
    let list: Vec<Value> = rows
        .iter()
        .take(ACTIVE_LISTED)
        .map(|(n, m, id)| {
            json!({ "player_id": id, "name": m.facts.name, "guild_id": m.facts.guild, "joined_ms": m.facts.created_ms, "last_ms": m.facts.last_active_ms,
                "played_30": n, "raids": m.stats.map(|s| s.raids_initiated), "refined_g": m.facts.refined_g })
        })
        .collect();
    let n = |w: i64| rows.iter().filter(|(_, m, _)| within(m.facts.last_active_ms, now, w)).count();
    json!({ "days": PLAYED_WINDOW, "total": rows.len(), "within": { "1": n(1), "7": n(7), "30": n(30) }, "players": list })
}

/// How far back `played` looks.
pub const PLAYED_WINDOW: i32 = 30;

/// How many of the last `PLAYED_WINDOW` days each player played:
/// `days[k]` = players who played on exactly k+1 of them. `activity_unread`:
/// players who acted but whose activity feed is unread, so only their
/// mines, refines and raids count.
pub fn played(members: &[Member], now: i64) -> Value {
    let today = epoch_day(now);
    let mut days = vec![0usize; PLAYED_WINDOW as usize];
    for m in members {
        let n = m.played_days().iter().filter(|d| **d > today - PLAYED_WINDOW && **d <= today).count();
        if n > 0 {
            days[n - 1] += 1;
        }
    }
    let unread = members.iter().filter(|m| m.facts.last_active_ms.is_some() && m.facts.activity_ms == 0).count();
    json!({ "window": PLAYED_WINDOW, "players": days.iter().sum::<usize>(), "days": days, "activity_unread": unread })
}

/// How many of the players who joined since telemetry began have a recorded
/// signup: `(guild, joined ms, tracked)` per player. `since`: the first
/// recorded signup anywhere. Overall and per guild.
pub fn coverage(rows: &[(&str, Option<i64>, bool)], since: Option<i64>) -> Value {
    let Some(since) = since else { return Value::Null };
    let mut by: BTreeMap<&str, [usize; 2]> = BTreeMap::new();
    for (g, joined, t) in rows {
        if joined.map_or(false, |j| j >= since) {
            let e = by.entry(*g).or_default();
            e[0] += 1;
            e[1] += *t as usize;
        }
    }
    let (joined, tracked) = by.values().fold((0, 0), |a, v| (a.0 + v[0], a.1 + v[1]));
    json!({
        "since": day_label(epoch_day(since)),
        "joined": joined, "tracked": tracked, "rate": ratio(tracked, joined),
        "guilds": by.iter().map(|(g, v)| json!({ "guild": g, "joined": v[0], "tracked": v[1] })).collect::<Vec<_>>(),
    })
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

    #[test]
    fn tracked_counts_activation_and_activity_among_recorded_signups_only() {
        const NOW: i64 = 100 * DAY_MS;
        let mut a = PlayerFacts::default();
        a.refined_g = Some(5.0);
        a.last_active_ms = Some(NOW - DAY_MS * 3);
        let ra = PlayerStats { raids_initiated: 2.0, ..Default::default() };
        let mut b = PlayerFacts::default();
        b.refined_g = Some(1.0);
        b.last_active_ms = Some(NOW - DAY_MS * 20);
        let c = PlayerFacts::default();
        let ms = [Member { facts: &a, stats: Some(&ra) }, Member { facts: &b, stats: None }, Member { facts: &c, stats: None }];
        let t = tracked(&ms, 4, NOW);
        assert_eq!(t["signups"], 4, "every recorded signup, read or not");
        assert_eq!(t["read"], 3);
        assert_eq!(t["activated"], 1, "refined AND raided: only a");
        assert_eq!((t["active_activated"]["1"].as_u64(), t["active_activated"]["7"].as_u64(), t["active_activated"]["30"].as_u64()), (Some(0), Some(1), Some(1)));
    }
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

    const V: &str = "tutorial-4";

    /// A record day holding two guilds' totals: 0-1 has `a`, 0-2 has `b`.
    fn day_v(ts: i64, version: &str, a: [f64; 2], b: Option<[f64; 2]>) -> Day {
        let mut guilds = BTreeMap::new();
        guilds.insert("0-1".to_string(), a);
        if let Some(b) = b {
            guilds.insert("0-2".to_string(), b);
        }
        let (s, f) = guilds.values().fold((0.0, 0.0), |x, v| (x.0 + v[0], x.1 + v[1]));
        Day { day: String::new(), ts_ms: ts, server: Some(ServerDay { version: version.into(), signups_started: s, signed_up: f, guilds, ..Default::default() }), ..Default::default() }
    }
    fn day(ts: i64, started: f64, signed: f64) -> Day {
        day_v(ts, V, [started / 2.0, signed / 2.0], Some([started / 2.0, signed / 2.0]))
    }
    fn cur(a: [f64; 2], b: Option<[f64; 2]>) -> BTreeMap<String, [f64; 2]> {
        let mut m = BTreeMap::new();
        m.insert("0-1".to_string(), a);
        if let Some(b) = b {
            m.insert("0-2".to_string(), b);
        }
        m
    }

    #[test]
    fn server_windows_are_differences_in_the_daily_record() {
        let h = vec![day(NOW - 8 * 24 * H, 10.0, 4.0), day(NOW - 24 * H, 20.0, 8.0), Day { ts_ms: NOW - 12 * H, ..Default::default() }];
        let now = cur([12.5, 4.5], Some([12.5, 4.5]));
        let s = server_windows(&h, Some(&now), V, None, NOW);
        assert_eq!(s["windows"][0]["started"], 5.0);
        assert_eq!(s["windows"][1]["started"], 15.0, "a week, from the record a day before it began");
        assert_eq!(s["all"]["started"], 25.0);
        // The record missed yesterday: 24 hours is unknown, not the nine days since the last row.
        let gap = vec![day(NOW - 9 * 24 * H, 10.0, 4.0)];
        let g = server_windows(&gap, Some(&now), V, None, NOW);
        assert!(g["windows"][0]["started"].is_null() && g["windows"][1]["started"].is_null(), "{g}");
        // …but the reading nine days back still counts what opened since.
        assert_eq!(g["prior"]["started"], 15.0);
        assert_eq!(g["prior"]["signed_up"], 5.0);
        assert!(server_windows(&[], Some(&now), V, None, NOW)["prior"].is_null());
        assert!(s["windows"][2]["started"].is_null(), "the record is not a month old");
        assert_eq!(s["oldest"]["started"], 15.0, "the oldest usable day answers the longest stretch it can");
        assert_eq!(s["oldest"]["day"], s["since"]);
        // A day a guild failed on stands for that guild, never for every guild.
        let mut part = day(NOW - 8 * 24 * H, 10.0, 4.0);
        part.server.as_mut().unwrap().partial = true;
        let p = server_windows(&[part], Some(&now), V, None, NOW);
        assert!(p["windows"][1]["started"].is_null() && p["oldest"].is_null(), "{p}");
        let g = server_windows(&h, Some(&now), V, Some("0-1"), NOW);
        assert_eq!(g["windows"][0]["signed_up"], 0.5);
        assert_eq!(g["all"]["started"], 12.5);
        assert!(server_windows(&h, None, V, None, NOW).is_null());
        assert!(server_windows(&h, Some(&now), V, Some("0-9"), NOW).is_null(), "a guild with no totals today");
    }

    #[test]
    fn a_new_tutorial_version_starts_its_own_windows_instead_of_reading_zero() {
        // Yesterday's record is tutorial-4's; today the servers count tutorial-5 from zero.
        let h = vec![day_v(NOW - 24 * H, V, [40.0, 20.0], Some([40.0, 20.0]))];
        let now = cur([1.0, 0.0], Some([2.0, 1.0]));
        let s = server_windows(&h, Some(&now), "tutorial-5", None, NOW);
        assert!(s["windows"][0]["started"].is_null(), "another version's total is not comparable: {s}");
        assert!(s["prior"].is_null() && s["since"].is_null());
        assert_eq!(s["all"]["started"], 3.0);
        let hs = history_series(&[day_v(NOW - 2 * 24 * H, V, [9.0, 3.0], None), day_v(NOW - 24 * H, "tutorial-5", [1.0, 0.0], None)], NOW);
        let col = hs["series"]["signups_started"].as_array().unwrap();
        assert_eq!((col[col.len() - 3].as_f64(), col[col.len() - 2].as_f64()), (None, Some(1.0)), "only the newest version's days form the series");
    }

    #[test]
    fn a_guild_whose_telemetry_appears_adds_its_sessions_from_then_not_its_history() {
        // Yesterday only 0-1 had totals; today 0-2 answers with 300 sessions from before.
        let h = vec![day_v(NOW - 24 * H, V, [10.0, 5.0], None)];
        let now = cur([12.0, 6.0], Some([300.0, 150.0]));
        let s = server_windows(&h, Some(&now), V, None, NOW);
        assert_eq!((s["windows"][0]["started"].as_f64(), s["windows"][0]["signed_up"].as_f64()), (Some(2.0), Some(1.0)));
        assert_eq!(s["all"]["started"], 312.0, "the running total still counts everyone");
    }

    #[test]
    fn a_missing_day_is_a_gap_in_the_records_series() {
        let h = vec![Day { ts_ms: NOW - 2 * 24 * H, active_1d: 4, ..Default::default() }];
        let s = history_series(&h, NOW);
        let dau = s["series"]["dau"].as_array().unwrap();
        assert_eq!(dau[dau.len() - 3].as_f64(), Some(4.0));
        assert!(dau[dau.len() - 1].is_null() && dau[dau.len() - 2].is_null());
    }

    /// A player who joined `joined_d` days before NOW, with these play days (days before NOW).
    fn joiner(joined_d: i64, active_d: Option<i64>, refined_d: Option<i64>, play_d: &[i64]) -> PlayerFacts {
        let day = |d: i64| epoch_day(NOW - d * 24 * H);
        PlayerFacts {
            created_ms: Some(NOW - joined_d * 24 * H),
            last_active_ms: active_d.map(|d| NOW - d * 24 * H),
            mined_g: Some(0.0),
            refined_g: Some(if refined_d.is_some() { 5.0 } else { 0.0 }),
            first_refined_ms: refined_d.map(|d| NOW - d * 24 * H),
            refine_days: refined_d.map(|d| vec![day(d)]).unwrap_or_default(),
            play_days: play_d.iter().map(|d| day(*d)).collect(),
            activity_ms: if active_d.is_some() { NOW } else { 0 },
            ledger_v: LEDGER_V,
            ..Default::default()
        }
    }

    #[test]
    fn a_cohort_counts_every_stage_over_the_same_joiners_and_waits_for_each_week() {
        // Three joined 30 days ago: one activated (refined, then raided 20 days in) and played in
        // week 2 (an attack) and this week; one only acted; one never acted.
        let a = joiner(30, Some(1), Some(28), &[22, 1]);
        let b = joiner(30, Some(29), None, &[]);
        let c = joiner(30, None, None, &[]);
        let ra = raids(24 * 10);
        let young = joiner(2, Some(1), None, &[1]);
        let ms = [Member { facts: &a, stats: Some(&ra) }, Member { facts: &b, stats: None }, Member { facts: &c, stats: None }, Member { facts: &young, stats: None }];
        let co = cohorts(&ms, &[true, false, false, true], NOW);
        let weeks = co["weeks"].as_array().unwrap();
        assert_eq!(weeks.len(), COHORT_WEEKS as usize);
        let old = weeks.iter().find(|w| w["joined"] == 3).expect("the three share a week");
        assert_eq!((old["acted"].as_u64(), old["refined"].as_u64(), old["raided"].as_u64(), old["activated"].as_u64()), (Some(2), Some(1), Some(1), Some(1)));
        assert_eq!(old["tracked"], 1);
        assert_eq!(old["days_to_activate"].as_f64(), Some(20.0), "activation has no deadline; its delay is reported");
        assert_eq!((old["days_to_refine"].as_f64(), old["days_to_raid"].as_f64(), old["days_to_mine"].as_f64()), (Some(2.0), Some(20.0), None), "first moves are timed from joining");
        assert_eq!(old["retained_w3"], 1, "every week is kept: a's raid on day 20 is week 3");
        assert_eq!((old["retained_w1"].as_u64(), old["retained_w2"].as_u64()), (Some(1), Some(1)), "a's attack on day 8 counts as play, b's lastAction does not");
        assert!(old["retained_w8"].is_null(), "week 8 has not happened for anyone in it");
        assert_eq!(old["playing"], 1);
        let new = weeks.last().unwrap();
        if new["joined"] == 1 {
            assert!(new["retained_w1"].is_null(), "a week still under way is not yet");
        }
        let w30 = co["windows"].as_array().unwrap().iter().find(|w| w["days"] == 30).unwrap();
        assert_eq!(w30["joined"], 1, "only the young one joined inside 30 days");
        let all = co["windows"].as_array().unwrap().last().unwrap();
        assert_eq!((all["days"].as_str(), all["joined"].as_u64()), (Some("all"), Some(4)));
        assert!(all["retained_w1"].is_null(), "windows carry no week retention");
    }

    #[test]
    fn an_unread_ledger_or_feed_is_counted_as_unread_not_as_nothing() {
        let mut a = joiner(10, Some(1), None, &[]);
        a.mined_g = None;
        a.refined_g = None;
        a.activity_ms = 0;
        let co = cohorts(&[Member { facts: &a, stats: None }], &[false], NOW);
        let all = co["windows"].as_array().unwrap().last().unwrap();
        assert_eq!((all["ledger_unread"].as_u64(), all["activity_unread"].as_u64()), (Some(1), Some(1)));
        assert!(co["played_since"].is_null());
    }

    #[test]
    fn everyone_who_left_is_in_exactly_one_bucket_by_how_far_they_got() {
        let gone = |refined: bool| joiner(40, Some(20), refined.then_some(30), &[]);
        let (never, acted, refined_only, raided_only, activated) = (joiner(40, None, None, &[]), gone(false), gone(true), gone(false), gone(true));
        let mut mined = gone(false);
        mined.mined_g = Some(3.0);
        let mut unread = gone(false);
        unread.mined_g = None;
        let here = joiner(40, Some(1), None, &[]);
        let r = raids(24 * 30);
        let ms = [
            Member { facts: &never, stats: None },
            Member { facts: &acted, stats: None },
            Member { facts: &mined, stats: None },
            Member { facts: &refined_only, stats: None },
            Member { facts: &raided_only, stats: Some(&r) },
            Member { facts: &activated, stats: Some(&r) },
            Member { facts: &unread, stats: None },
            Member { facts: &here, stats: None },
        ];
        let ids = ["1-1", "1-2", "1-3", "1-4", "1-5", "1-6", "1-7", "1-8"];
        let l = left(&ms, &ids, NOW);
        assert_eq!((l["active"].as_u64(), l["left"].as_u64()), (Some(1), Some(7)));
        let f = &l["furthest"];
        for (i, k) in LEFT_BUCKETS.iter().enumerate() {
            assert_eq!(f[k], 1, "{k}: {f}");
            assert_eq!(l["who"][k][0]["player_id"], ids[i], "each bucket names its player");
        }
        assert!(l["who"].get("1-8").is_none() && l["who"].as_object().unwrap().values().all(|v| v.as_array().unwrap().len() == 1), "the active player is in no list");
    }

    #[test]
    fn played_counts_days_with_a_gameplay_action_in_the_last_thirty() {
        // a: an attack 1 day ago and a refine 5 days ago; b: an attack 40 days ago only;
        // c: never acted; d: acted, feed unread, refined 3 days ago.
        let a = joiner(60, Some(1), Some(5), &[1]);
        let b = joiner(60, Some(40), None, &[40]);
        let c = joiner(60, None, None, &[]);
        let mut d = joiner(60, Some(3), Some(3), &[]);
        d.activity_ms = 0;
        let ms = [Member { facts: &a, stats: None }, Member { facts: &b, stats: None }, Member { facts: &c, stats: None }, Member { facts: &d, stats: None }];
        let p = played(&ms, NOW);
        assert_eq!(p["players"], 2, "b played only outside the window: {p}");
        assert_eq!((p["days"][0].as_u64(), p["days"][1].as_u64()), (Some(1), Some(1)), "d one day, a two");
        assert_eq!(p["activity_unread"], 1);
    }

    #[test]
    fn active_users_are_activated_players_seen_in_each_window_most_days_first() {
        let a = joiner(60, Some(1), Some(30), &[1, 2, 3]);
        let b = joiner(60, Some(2), Some(30), &[2]);
        let gone = joiner(60, Some(20), Some(30), &[]);
        let unactivated = joiner(60, Some(1), None, &[1]);
        let r = raids(24 * 40);
        let ms = [Member { facts: &b, stats: Some(&r) }, Member { facts: &a, stats: Some(&r) }, Member { facts: &gone, stats: Some(&r) }, Member { facts: &unactivated, stats: None }];
        let u = active_users(&ms, &["1-2", "1-1", "1-3", "1-4"], NOW);
        assert_eq!(u["total"], 3, "activated and seen in 30 days: {u}");
        assert_eq!((u["within"]["1"].as_u64(), u["within"]["7"].as_u64(), u["within"]["30"].as_u64()), (Some(0), Some(2), Some(3)), "{u}");
        assert_eq!((u["players"][0]["player_id"].as_str(), u["players"][0]["played_30"].as_u64()), (Some("1-1"), Some(3)), "most days played first");
    }

    #[test]
    fn coverage_is_tracked_of_joined_since_telemetry_began() {
        let rows = [("0-1", Some(5), true), ("0-1", Some(6), false), ("0-2", Some(7), false), ("0-2", Some(1), true), ("0-2", None, false)];
        let c = coverage(&rows, Some(5));
        assert_eq!((c["joined"].as_u64(), c["tracked"].as_u64()), (Some(3), Some(1)), "before telemetry, or undated, is not counted: {c}");
        assert_eq!(c["guilds"][1], json!({ "guild": "0-2", "joined": 1, "tracked": 0 }));
        assert!(coverage(&rows, None).is_null());
    }

    #[test]
    fn weeks_start_on_monday() {
        // 2026-11-20 is a Friday; its Monday is 2026-11-16.
        let fri = epoch_day(1_795_132_800_000);
        assert_eq!(day_label(fri), "2026-11-20");
        assert_eq!(day_label(monday(fri)), "2026-11-16");
        assert_eq!(monday(monday(fri)), monday(fri), "a Monday is its own week");
        assert_eq!(day_label(monday(fri + 3)), "2026-11-23", "Monday the 23rd starts the next");
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
        let ids: Vec<&str> = u.players.keys().filter(|id| human(id)).map(|id| id.as_str()).collect();
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
        let last = h.iter().rev().find_map(|d| d.server.as_ref().map(|s| (s.guilds.clone(), s.version.clone())));
        let srv = last.as_ref().map(|(g, v)| server_windows(&h, Some(g), v, None, now)).unwrap_or(Value::Null);
        println!("SRV {srv}");
        let tr: Vec<bool> = u.players.iter().filter(|(id, _)| human(id)).map(|(id, _)| sessions.get(id).map_or(false, |s| s.reached(crate::mcp::onboarding::PLAYER_STEP).is_some())).collect();
        let co = cohorts(&ms, &tr, now);
        for w in co["weeks"].as_array().unwrap() {
            println!("C {w}");
        }
        for w in co["windows"].as_array().unwrap() {
            println!("WIN {w}");
        }
        let lf = left(&ms, &ids, now);
        println!("LEFT {}", lf["furthest"]);
        let pl = played(&ms, now);
        println!("PLAYED {pl}");
        let au = active_users(&ms, &ids, now);
        println!("ACTIVE_USERS {} {}", au["total"], au["players"].as_array().unwrap().iter().take(5).map(|p| format!("{}:{}", p["player_id"], p["played_30"])).collect::<Vec<_>>().join(" "));
        let since = sessions.values().filter_map(|s| s.reached(crate::mcp::onboarding::PLAYER_STEP)).min();
        let cov_rows: Vec<(&str, Option<i64>, bool)> =
            u.players.iter().filter(|(id, _)| human(id)).map(|(id, p)| (p.guild.as_str(), p.created_ms, sessions.get(id).map_or(false, |s| s.reached(crate::mcp::onboarding::PLAYER_STEP).is_some()))).collect();
        println!("COVERAGE {}", coverage(&cov_rows, since));
        let hs = history_series(&h, now);
        let htail = |k: &str| hs["series"][k].as_array().unwrap().iter().rev().take(16).rev().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
        println!("H mau: {}\nH signups_started: {}", htail("mau"), htail("signups_started"));
        if let Ok(path) = std::env::var("PIRATE_OUT") {
            let out = serde_json::json!({
                "pirate": s, "pirate_series": sr, "pirate_server": srv, "cohorts": co, "left": lf, "played": pl,
                "tutorial_impact": tutorial_impact(&rows, now), "history_series": hs, "trend_series": sr,
            });
            std::fs::write(path, out.to_string()).unwrap();
        }
    }
}
