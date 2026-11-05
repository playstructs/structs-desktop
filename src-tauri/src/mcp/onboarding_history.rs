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
    pub activated: usize,
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
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ServerDay {
    pub version: String,
    pub signups_started: f64,
    pub signed_up: f64,
    pub tutorial_players: f64,
    pub tutorial_completed: f64,
}

/// (metric, unit, label), for the Chart card.
pub const METRICS: &[(&str, &str, &str)] = &[
    ("humans", "count", "humans"),
    ("replicants", "count", "replicants"),
    ("activated", "count", "humans who ever acted"),
    ("active_1d", "count", "humans active in a day"),
    ("active_7d", "count", "humans active in 7 days"),
    ("active_30d", "count", "humans active in 30 days"),
    ("mined", "count", "humans who mined"),
    ("refined", "count", "humans who refined"),
    ("raided", "count", "humans who raided"),
    ("signups_started", "count", "signups started"),
    ("signed_up", "count", "signups finished"),
    ("tutorial_players", "count", "tutorial players"),
    ("tutorial_completed", "count", "tutorial finishers"),
];

static HISTORY: LazyLock<Mutex<Vec<Day>>> =
    LazyLock::new(|| Mutex::new(crate::mcp::cache_store::load(CACHE_NAME).unwrap_or_default()));

fn day_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Today's chain figures. Human means neither replicant marker.
pub fn day_row(s: &Snapshot, now: i64) -> Day {
    let mut d = Day { day: day_of(now), ts_ms: now, ..Default::default() };
    let within = |t: Option<i64>, days: i64| t.map_or(false, |t| t >= now - days * DAY_MS);
    for (id, p) in &s.players {
        if s.is_replicant(id) {
            d.replicants += 1;
            continue;
        }
        d.humans += 1;
        let g = d.guilds.entry(p.guild.clone()).or_default();
        g.humans += 1;
        d.activated += p.last_active_ms.is_some() as usize;
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
        if last.server.as_ref() != Some(&server) {
            last.server = Some(server);
            save(&rows);
        }
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
    let s = d.server.as_ref();
    Some(match metric {
        "humans" => d.humans as f64,
        "replicants" => d.replicants as f64,
        "activated" => d.activated as f64,
        "active_1d" => d.active_1d as f64,
        "active_7d" => d.active_7d as f64,
        "active_30d" => d.active_30d as f64,
        "mined" => d.mined as f64,
        "refined" => d.refined as f64,
        "raided" => d.raided as f64,
        "signups_started" => s?.signups_started,
        "signed_up" => s?.signed_up,
        "tutorial_players" => s?.tutorial_players,
        "tutorial_completed" => s?.tutorial_completed,
        _ => return None,
    })
}

/// `(ts_ms, value)` for one metric, for the Chart card.
pub fn samples(metric: &str) -> Vec<(f64, f64)> {
    let rows = HISTORY.lock().unwrap_or_else(|p| p.into_inner());
    rows.iter().filter_map(|d| value_of(d, metric).map(|v| (d.ts_ms as f64, v))).collect()
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
        assert_eq!((d.humans, d.replicants, d.activated), (4, 2, 3));
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
    fn a_metric_without_a_server_figure_is_a_gap_not_a_zero() {
        let d = Day::default();
        assert_eq!(value_of(&d, "signed_up"), None);
        assert_eq!(value_of(&d, "humans"), Some(0.0));
        assert!(METRICS.iter().all(|(m, _, _)| value_of(&Day { server: Some(ServerDay::default()), ..Default::default() }, m).is_some()), "every listed metric has a value");
    }
}
