//! One row a day of the Telemetry card's headline figures.
//!
//! No guild route has a date range, and `lastAction` holds only its latest
//! value, so last week's active count cannot be asked for later: a day not
//! written down is gone. The chain figures are written when a crawl ends;
//! the servers' cumulative counts when a read sees them. Rows go to
//! `cache/onboarding_history.json` and feed the card's Trends page and the
//! Chart card's `telemetry` source.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use crate::mcp::onboarding_players::Snapshot;

const CACHE_NAME: &str = "onboarding_history";
const KEEP_DAYS: usize = 730;
const DAY_MS: i64 = 86_400_000;
/// The definitions a row's figures were counted by. Bump it when one
/// changes: Trends and the Chart card draw only the newest version's rows as
/// one line, so a redefinition starts a new line instead of reading as a step.
/// 2 (2026-11-21): "active" = last seen by any clock (lastAction, a mine, a
/// refine, a raid, a played day), not `lastAction` alone.
pub const DEF_VERSION: u32 = 2;
fn def_v1() -> u32 {
    1
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GuildDay {
    pub humans: usize,
    pub active_7d: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Day {
    pub day: String,
    pub ts_ms: i64,
    pub humans: usize,
    pub replicants: usize,
    /// Humans who ever acted on chain (`lastAction` set). Stored as
    /// `activated` before 2026-11-21, which meant the same thing.
    #[serde(alias = "activated")]
    pub acted: usize,
    pub active_1d: usize,
    pub active_7d: usize,
    pub active_30d: usize,
    pub mined: usize,
    pub refined: usize,
    pub raided: usize,
    #[serde(default)]
    pub guilds: BTreeMap<String, GuildDay>,
    /// The servers' running totals for the newest design, once a read saw them.
    #[serde(default)]
    pub server: Option<ServerDay>,
    /// `DEF_VERSION` when the row was written.
    #[serde(default = "def_v1")]
    pub def: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ServerDay {
    pub version: String,
    pub signups_started: f64,
    pub signed_up: f64,
    /// `None`: not recoverable (`drop_shared`).
    #[serde(default)]
    pub tutorial_players: Option<f64>,
    #[serde(default)]
    pub tutorial_completed: Option<f64>,
    /// Each server's own `[signups started, signups finished]`, by its host guild.
    #[serde(default)]
    pub guilds: BTreeMap<String, [f64; 2]>,
    /// A guild that records telemetry failed to answer: `guilds` holds the
    /// rest, and the summed totals are not a reading (they would dip).
    #[serde(default)]
    pub partial: bool,
    /// Written with each server counted once. Older rows may hold one shared
    /// server under every guild that publishes it.
    #[serde(default)]
    pub per_server: bool,
}

/// (metric, unit, label), for the Chart card.
pub const METRICS: &[(&str, &str, &str)] = &[
    ("humans", "count", "humans"),
    ("replicants", "count", "replicants"),
    ("acted", "count", "humans who ever acted"),
    ("active_1d", "count", "humans active in a day"),
    ("active_7d", "count", "humans active in 7 days"),
    ("active_30d", "count", "humans active in 30 days"),
    ("mined", "count", "humans who ever mined"),
    ("refined", "count", "humans who ever refined"),
    ("raided", "count", "humans who ever raided"),
    ("signups_started", "count", "signups started"),
    ("signed_up", "count", "signups finished"),
    ("tutorial_players", "count", "tutorial players"),
    ("tutorial_completed", "count", "tutorial finishers"),
    // Rebuilt from each player's own dates (`pirate::series`), not the record.
    ("new", "count", "new humans a day"),
    ("activations", "count", "humans activated a day (refined + raided)"),
    ("activated_total", "count", "humans ever activated (refined + raided)"),
    ("refiners", "count", "humans who refined that day"),
    ("refiners_7d", "count", "humans who refined in the 7 days to that day"),
    ("miners_7d", "count", "humans who mined in the 7 days to that day"),
    ("raiders", "count", "humans who initiated a raid that day"),
    ("raiders_7d", "count", "humans who initiated a raid in the 7 days to that day"),
];

/// The metrics `samples` rebuilds from player dates rather than reads from the record.
const DERIVED: &[&str] = &["new", "activations", "activated_total", "refiners", "refiners_7d", "miners_7d", "raiders", "raiders_7d"];

static HISTORY: LazyLock<Mutex<Vec<Day>>> =
    LazyLock::new(|| Mutex::new(crate::mcp::cache_store::load(CACHE_NAME).unwrap_or_default()));

fn day_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Today's chain figures. Human means neither replicant marker.
pub fn day_row(s: &Snapshot, now: i64) -> Day {
    let mut d = Day { day: day_of(now), ts_ms: now, def: DEF_VERSION, ..Default::default() };
    let within = |t: Option<i64>, days: i64| t.map_or(false, |t| t >= now - days * DAY_MS);
    for (id, p) in &s.players {
        if s.is_replicant(id) {
            d.replicants += 1;
            continue;
        }
        d.humans += 1;
        let g = d.guilds.entry(p.guild.clone()).or_default();
        g.humans += 1;
        d.acted += p.last_active_ms.is_some() as usize;
        d.active_1d += within(p.last_active_ms, 1) as usize;
        d.active_30d += within(p.last_active_ms, 30) as usize;
        if within(p.last_active_ms, 7) {
            d.active_7d += 1;
            g.active_7d += 1;
        }
        let st = s.stats.get(id);
        d.mined += st.and_then(|x| x.mined_g).map_or(false, |v| v > 0.0) as usize;
        d.refined += st.and_then(|x| x.refined_g).map_or(false, |v| v > 0.0) as usize;
        d.raided += st.map_or(false, |x| x.raids_initiated > 0.0) as usize;
    }
    d
}

/// Today's row replaces today's, keeping what only a read can add.
pub fn merge(rows: &mut Vec<Day>, mut row: Day) {
    match rows.last_mut() {
        Some(last) if last.day == row.day => {
            row.server = row.server.take().or_else(|| last.server.take());
            *last = row;
        }
        _ => rows.push(row),
    }
    let extra = rows.len().saturating_sub(KEEP_DAYS);
    rows.drain(..extra);
}

fn save(rows: &[Day]) {
    crate::mcp::cache_store::save_in_background(CACHE_NAME, rows.to_vec());
}

/// A crawl ended. An empty snapshot is a table not read yet, not a day
/// with no players.
pub fn record_chain(s: &Snapshot, now: i64) {
    if s.players.is_empty() {
        return;
    }
    let mut rows = HISTORY.lock().unwrap_or_else(|p| p.into_inner());
    merge(&mut rows, day_row(s, now));
    save(&rows);
}

/// A read saw the servers' totals. Only ever fills in today's row.
pub fn record_server(server: ServerDay, now: i64) {
    let mut rows = HISTORY.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(last) = rows.last_mut().filter(|r| r.day == day_of(now)) {
        // A full reading is never replaced by a partial one the same day.
        let downgrade = server.partial && last.server.as_ref().map_or(false, |s| !s.partial && s.version == server.version);
        if !downgrade && last.server.as_ref() != Some(&server) {
            last.server = Some(server);
            save(&rows);
        }
    }
}

/// Fold one row's repeats of a shared server into its host. The signup
/// totals are re-summed from the guilds kept; the tutorial totals were only
/// kept as sums, so a row with repeats has none.
fn fold_shared(day: &mut ServerDay, servers: &[crate::mcp::onboarding::Server]) -> bool {
    if day.per_server {
        return false;
    }
    let mut dropped = 0;
    for sv in servers.iter().filter(|sv| sv.shared()) {
        let held: Vec<String> = sv.guilds.iter().filter(|g| **g != sv.host && day.guilds.contains_key(*g)).cloned().collect();
        let mut copies = held.iter().filter_map(|g| day.guilds.remove(g)).collect::<Vec<_>>();
        if !copies.is_empty() && !day.guilds.contains_key(&sv.host) {
            day.guilds.insert(sv.host.clone(), copies.remove(0));
        }
        dropped += copies.len();
    }
    if dropped == 0 {
        return false;
    }
    day.signups_started = day.guilds.values().map(|t| t[0]).sum();
    day.signed_up = day.guilds.values().map(|t| t[1]).sum();
    (day.tutorial_players, day.tutorial_completed) = (None, None);
    true
}

/// The repaired rows, for a read-only look.
#[cfg(test)]
pub fn folded(servers: &[crate::mcp::onboarding::Server]) -> Vec<Day> {
    let mut rows: Vec<Day> = crate::mcp::cache_store::load(CACHE_NAME).unwrap_or_default();
    rows.iter_mut().filter_map(|r| r.server.as_mut()).for_each(|d| {
        fold_shared(d, servers);
    });
    rows.into_iter().filter(|r| r.server.is_some()).collect()
}

/// Repair days recorded while a shared server was read once per guild
/// (2026-11-21 to the fix). Safe to run again: a repaired row has no repeats.
pub fn drop_shared(servers: &[crate::mcp::onboarding::Server]) {
    let mut rows = HISTORY.lock().unwrap_or_else(|p| p.into_inner());
    let mut changed = false;
    for d in rows.iter_mut().filter_map(|r| r.server.as_mut()) {
        changed |= fold_shared(d, servers);
    }
    if changed {
        save(&rows);
    }
}

pub fn recent(n: usize) -> Vec<Day> {
    let rows = HISTORY.lock().unwrap_or_else(|p| p.into_inner());
    rows[rows.len().saturating_sub(n)..].to_vec()
}

/// When the newest row was written; 0 when there is no history.
pub fn last_ms() -> i64 {
    HISTORY.lock().unwrap_or_else(|p| p.into_inner()).last().map_or(0, |r| r.ts_ms)
}

fn value_of(d: &Day, metric: &str) -> Option<f64> {
    let s = d.server.as_ref().filter(|s| !s.partial);
    Some(match metric {
        "humans" => d.humans as f64,
        "replicants" => d.replicants as f64,
        // `activated` is the old name, kept for saved Chart cards.
        "acted" | "activated" => d.acted as f64,
        "active_1d" => d.active_1d as f64,
        "active_7d" => d.active_7d as f64,
        "active_30d" => d.active_30d as f64,
        "mined" => d.mined as f64,
        "refined" => d.refined as f64,
        "raided" => d.raided as f64,
        "signups_started" => s?.signups_started,
        "signed_up" => s?.signed_up,
        "tutorial_players" => s?.tutorial_players?,
        "tutorial_completed" => s?.tutorial_completed?,
        _ => return None,
    })
}

/// `(ts_ms, value)` for one metric, for the Chart card.
pub fn samples(metric: &str) -> Vec<(f64, f64)> {
    if DERIVED.contains(&metric) {
        return derived(&crate::mcp::onboarding_players::snapshot_for(false), metric, now_ms());
    }
    let rows = HISTORY.lock().unwrap_or_else(|p| p.into_inner());
    current(&rows).filter_map(|d| value_of(d, metric).map(|v| (d.ts_ms as f64, v))).collect()
}

/// The rows counted by the newest row's definitions: one line, no step
/// where a definition changed.
pub fn current(rows: &[Day]) -> impl Iterator<Item = &Day> {
    let v = rows.last().map_or(DEF_VERSION, |r| r.def);
    rows.iter().filter(move |r| r.def == v)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A rebuilt series over the humans, one point at each day's noon. Nothing
/// until the player table has been read.
pub fn derived(s: &Snapshot, metric: &str, now: i64) -> Vec<(f64, f64)> {
    if s.players.is_empty() {
        return Vec::new();
    }
    let members: Vec<crate::mcp::pirate::Member> =
        s.players.iter().filter(|(id, _)| !s.is_replicant(id)).map(|(id, p)| crate::mcp::pirate::Member { facts: p, stats: s.stats.get(id) }).collect();
    let v = crate::mcp::pirate::series(&members, now);
    let first = crate::mcp::onboarding_players::epoch_day(now) as i64 - crate::mcp::pirate::SERIES_DAYS + 1;
    v["series"][metric]
        .as_array()
        .map(|a| a.iter().enumerate().filter_map(|(i, x)| x.as_f64().map(|x| (((first + i as i64) * DAY_MS + DAY_MS / 2) as f64, x))).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::onboarding_players::{PlayerFacts, PlayerStats};

    const NOW: i64 = 1_793_000_000_000;

    fn player(guild: &str, last: Option<i64>) -> PlayerFacts {
        PlayerFacts { guild: guild.into(), last_active_ms: last, ..Default::default() }
    }

    #[test]
    fn a_redefinition_starts_a_new_line() {
        let row = |day: &str, def: u32| Day { day: day.into(), humans: 1, def, ..Default::default() };
        let rows = vec![row("2026-11-01", 1), row("2026-11-02", 1), row("2026-11-03", 2)];
        assert_eq!(current(&rows).map(|r| r.day.as_str()).collect::<Vec<_>>(), vec!["2026-11-03"]);
        let old: Day = serde_json::from_str(r#"{"day":"2026-11-01","ts_ms":1,"humans":3,"replicants":0,"activated":2,"active_1d":0,"active_7d":0,"active_30d":0,"mined":0,"refined":0,"raided":0}"#).unwrap();
        assert_eq!((old.acted, old.def), (2, 1), "a row stored as `activated` reads as acted, version 1");
    }

    #[test]
    fn a_day_counts_humans_and_sets_replicants_apart() {
        let mut s = Snapshot::default();
        s.players.insert("1-1".into(), player("0-1", Some(NOW - 1_000)));
        s.players.insert("1-2".into(), player("0-5", Some(NOW - 3 * DAY_MS)));
        s.players.insert("1-3".into(), player("0-5", Some(NOW - 20 * DAY_MS)));
        s.players.insert("1-4".into(), player("0-5", None));
        s.players.insert("1-8".into(), player("0-5", Some(NOW)));
        s.players.insert("1-9".into(), player("0-5", None));
        s.replicants.insert("1-8".into(), "1-1".into());
        s.likely.insert("1-9".into());
        s.stats.insert("1-1".into(), PlayerStats { mined_g: Some(4.0), raids_initiated: 1.0, ..Default::default() });
        s.stats.insert("1-2".into(), PlayerStats { mined_g: Some(0.0), ..Default::default() });
        let d = day_row(&s, NOW);
        assert_eq!((d.humans, d.replicants, d.acted, d.def), (4, 2, 3, DEF_VERSION));
        assert_eq!((d.active_1d, d.active_7d, d.active_30d), (1, 2, 3));
        assert_eq!((d.mined, d.refined, d.raided), (1, 0, 1));
        assert_eq!(d.guilds["0-5"], GuildDay { humans: 3, active_7d: 1 });
    }

    #[test]
    fn a_day_is_rewritten_in_place_and_keeps_the_servers_figures() {
        let server = ServerDay { version: "tutorial-4".into(), signed_up: 5.0, ..Default::default() };
        let mut rows = vec![Day { day: "2026-11-04".into(), ..Default::default() }, Day { day: "2026-11-05".into(), humans: 1, server: Some(server.clone()), ..Default::default() }];
        merge(&mut rows, Day { day: "2026-11-05".into(), humans: 2, ..Default::default() });
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[1].humans, rows[1].server.as_ref()), (2, Some(&server)));
        merge(&mut rows, Day { day: "2026-11-06".into(), ..Default::default() });
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn days_that_counted_a_shared_server_once_per_guild_are_folded() {
        use crate::mcp::onboarding::Server;
        let sv = |host: &str, gs: &[&str]| Server { host: host.into(), api: String::new(), guilds: gs.iter().map(|g| g.to_string()).collect() };
        let servers = vec![sv("0-1", &["0-1"]), sv("0-5", &["0-5", "0-7", "0-8", "0-9"])];
        // 2026-11-21 as it was written.
        let mut d: ServerDay = serde_json::from_str(r#"{"version":"tutorial-4","signups_started":162,"signed_up":69,"tutorial_players":95,"tutorial_completed":43,"partial":false,
            "guilds":{"0-1":[2,1],"0-5":[40,17],"0-7":[40,17],"0-8":[40,17],"0-9":[40,17]}}"#).unwrap();
        assert!(fold_shared(&mut d, &servers));
        assert_eq!((d.signups_started, d.signed_up), (42.0, 18.0));
        assert_eq!(d.guilds.keys().cloned().collect::<Vec<_>>(), vec!["0-1", "0-5"]);
        assert_eq!((d.tutorial_players, d.tutorial_completed), (None, None), "sums that cannot be taken apart are a gap");
        assert!(!fold_shared(&mut d, &servers), "once");
        // One guild on the server that day: nothing repeated, nothing lost.
        let mut one: ServerDay = serde_json::from_str(r#"{"version":"tutorial-4","signups_started":28,"signed_up":14,"tutorial_players":22,"tutorial_completed":12,"guilds":{"0-1":[1,1],"0-5":[27,13]}}"#).unwrap();
        assert!(!fold_shared(&mut one, &servers));
        assert_eq!((one.signups_started, one.tutorial_players), (28.0, Some(22.0)));
        // A row written since is never touched: a guild may have moved onto the server.
        let mut new = ServerDay { per_server: true, guilds: [("0-5".to_string(), [4.0, 2.0]), ("0-7".to_string(), [3.0, 1.0])].into(), ..Default::default() };
        assert!(!fold_shared(&mut new, &servers) && new.guilds.len() == 2);
    }

    #[test]
    fn a_metric_without_a_server_figure_is_a_gap_not_a_zero() {
        let d = Day::default();
        assert_eq!(value_of(&d, "signed_up"), None);
        assert_eq!(value_of(&d, "humans"), Some(0.0));
        assert!(
            METRICS.iter().filter(|(m, _, _)| !DERIVED.contains(m)).all(|(m, _, _)| value_of(&Day { server: Some(ServerDay { tutorial_players: Some(0.0), tutorial_completed: Some(0.0), ..Default::default() }), ..Default::default() }, m).is_some()),
            "every recorded metric has a value"
        );
    }

    #[test]
    fn a_derived_metric_is_rebuilt_from_dates_and_leaves_replicants_out() {
        let mut s = Snapshot::default();
        let v = crate::mcp::onboarding_players::LEDGER_V;
        s.players.insert("1-1".into(), PlayerFacts { refine_days: vec![crate::mcp::onboarding_players::epoch_day(NOW)], refined_g: Some(1.0), ledger_v: v, ..Default::default() });
        s.players.insert("1-2".into(), PlayerFacts { refine_days: vec![crate::mcp::onboarding_players::epoch_day(NOW)], refined_g: Some(1.0), ledger_v: v, ..Default::default() });
        s.replicants.insert("1-2".into(), "1-1".into());
        let pts = derived(&s, "refiners", NOW);
        assert_eq!(pts.len(), crate::mcp::pirate::SERIES_DAYS as usize);
        assert_eq!(pts.last().map(|p| p.1), Some(1.0));
        assert!(DERIVED.iter().all(|m| METRICS.iter().any(|(k, _, _)| k == m)), "every derived metric is listed for the chart");
        assert!(derived(&Snapshot::default(), "refiners", NOW).is_empty());
        s.players.get_mut("1-1").unwrap().ledger_v = 1;
        assert!(derived(&s, "refiners", NOW).is_empty(), "an undated ledger leaves the chart empty, not zero");
        assert_eq!(derived(&s, "new", NOW).len(), crate::mcp::pirate::SERIES_DAYS as usize);
    }
}
