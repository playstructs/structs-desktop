//! Onboarding telemetry across every guild — the read behind the Terminal's
//! `onboarding` card (⌘K → TELEMETRY · ONBOARDING · FUNNEL · SIGNUPS).
//!
//! ## Where the data is
//!
//! The webapp records each signup and tutorial step a new player reaches or
//! skips (`OnboardingTelemetry.js`, live since 2026-10-19) into ITS OWN guild's
//! database — `onboarding_session` + `onboarding_progress`, not chain data. So
//! the universe is the sum of every guild's server, and each is asked
//! separately (`guild_directory::guild_api_directory`). Reads are
//! session-gated; our device key logs into any guild's server because
//! `player_address` is chain-indexed everywhere (see `guild_auth`).
//!
//! ## Tiers
//!
//! | tier | route | covers | gives |
//! |---|---|---|---|
//! | aggregate | `/api/onboarding/funnel/{v}/{phase}`, `/tutorial/outcome/{v}` | EVERY session, incl. ones that quit before signup finished | reached / skipped / dropped per step, outcome counts |
//! | players | `/api/onboarding/tutorial/players/{v}` and `/steps` | UNIQUE players, first runs and replays together, logged-in runs included | outcome per player, how far each got: the figures to lead with |
//! | sample | `/api/onboarding/player/{id}` | sessions whose signup FINISHED, the signup session only | timestamps: durations, dwell per step, daily cohorts |
//! | runs | `/api/onboarding/tutorial/runs/{v}` | EVERY started run, replays and players who signed up long ago included | who, when, which interface, how far, outcome |
//!
//! The sample is new players' signups. A run taken after signup is a session
//! of its own and belongs to the runs tier, which needs no crawl.
//!
//! No route serves timings in bulk, so the sample is a crawl over each
//! guild's roster, newest first, of players created after the telemetry
//! existed (`TELEMETRY_FLOOR_INDEX`). A finished session never changes, so
//! it is fetched once and kept in `cache/onboarding_players.json`; only
//! sessions still in progress are asked again. Replicants are skipped: they
//! are created from code, never through the signup screens.
//!
//! The servers know nothing of activity or replicants, so a segment split on
//! either has no server figures and falls back to the sample. Run comparison
//! is folded here from the run rows rather than read from
//! `/tutorial/runs/{v}/comparison`: its medians cannot be summed across guilds.
//!
//! Each guild leaves its excluded players (test accounts, kept in its own
//! database by id or username pattern) out of the aggregate, players and runs
//! reads unless `filters.include_excluded` asks for everyone; every read of one
//! card sends the same choice, and the caches key on it. `/player/{id}` and
//! the chain tables are never filtered, so the sample, lifecycle and cohorts
//! count everyone either way.
//!
//! `recorded_at` is the SERVER's insert time and the client batches steps
//! that land within 2 s of each other, so a dwell is accurate to a couple of
//! seconds and a batch of quick steps reads as 0 s each.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::guild_directory::GuildApiEntry;
use crate::mcp::guild_api::GuildApiClient;

pub const PHASES: [&str; 2] = ["signup", "tutorial"];
const PLAYER_STEP: &str = "signup.employee_record";
const SUBMIT_STEP: &str = "signup.submit";
const OFFER_STEP: &str = "orientation.tutorial_offer";
const LOADING_STEP: &str = "tutorial.loading";
const FTL_STEP: &str = "tutorial.end.ftl_jump";

/// Content versions are `tutorial-<n>`, bumped by hand with each design.
/// There is no route that lists them, so each guild's catalog is probed.
const VERSION_PREFIX: &str = "tutorial-";
const VERSION_PROBE_MAX: u32 = 12;
pub const DEFAULT_IDLE_HOURS: u32 = 24;

/// No player below this index can have telemetry: 5,774 was the first index
/// created after the recorder shipped (2026-10-19 20:56 UTC, local mirror).
/// A little lower, so a clock skew costs a few empty reads and never a player.
const TELEMETRY_FLOOR_INDEX: u64 = 5_700;
/// Per guild per crawl: enough for every post-telemetry player of the
/// busiest guild in one round (0-5 had ~3,800 on 2026-10-26).
const CRAWL_BUDGET: usize = 8_000;
const CRAWL_CONCURRENCY: usize = 6;
/// A guild whose reads keep failing is left for the next crawl.
const CRAWL_MAX_ERRORS: usize = 20;
/// The newest players may not have flushed their last batch yet: an empty
/// answer for them is asked again next crawl rather than believed.
const UNSETTLED_NEWEST: usize = 20;

const DIRECTORY_TTL: Duration = Duration::from_secs(30 * 60);
const AGGREGATE_TTL: Duration = Duration::from_secs(120);
/// An open card reads every 30 s; the crawl behind it need not.
const CRAWL_GAP: Duration = Duration::from_secs(15 * 60);
/// History wants a row a day whether or not the card is open.
const HISTORY_TICK: Duration = Duration::from_secs(3_600);
const HISTORY_FIRST_TICK: Duration = Duration::from_secs(5 * 60);
const HISTORY_MAX_AGE_MS: i64 = 12 * 3_600_000;
const HISTORY_SHOWN: usize = 120;
/// Compared at once; older designs stay one pick away in the Tutorial control.
const VERSIONS_COMPARED: usize = 4;
/// Per step in the drill-down.
const STOPPED_SHOWN: usize = 50;
const CACHE_NAME: &str = "onboarding_players";
/// `/tutorial/runs` answers `PaginationLimits::DEFAULT` rows a page.
const RUNS_PAGE: usize = 100;
/// Per guild per read, newest first.
const RUNS_MAX_PAGES: u32 = 20;
/// The card's list; its counts cover every run read.
const RUNS_SHOWN: usize = 100;
const REPLAY_SUFFIX: &str = "-replay";

// ── The per-player sample ───────────────────────────────────────────────────

/// One recorded step: key, skipped (else reached), server time in unix ms.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Ev {
    pub k: String,
    #[serde(default)]
    pub s: bool,
    pub t: i64,
}

/// One player's onboarding session as last fetched.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlayerSession {
    pub guild: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub interface: String,
    /// Empty: the player has no telemetry (signed up elsewhere, or a bot).
    #[serde(default)]
    pub events: Vec<Ev>,
    #[serde(default)]
    pub fetched_ms: i64,
    /// Never fetched again: finished, idle past the window, or known empty.
    #[serde(default)]
    pub settled: bool,
}

impl PlayerSession {
    fn reached(&self, key: &str) -> Option<i64> {
        self.events.iter().find(|e| e.k == key && !e.s).map(|e| e.t)
    }
    fn skipped(&self, key: &str) -> bool {
        self.events.iter().any(|e| e.k == key && e.s)
    }
    fn first_t(&self) -> Option<i64> {
        self.events.iter().map(|e| e.t).min()
    }
    fn last_t(&self) -> Option<i64> {
        self.events.iter().map(|e| e.t).max()
    }
    /// The step furthest along: the latest event, ties broken by its order
    /// in the response (which is catalog order within one batch).
    fn last_step(&self) -> Option<&Ev> {
        self.events.iter().enumerate().max_by_key(|(i, e)| (e.t, *i)).map(|(_, e)| e)
    }
    fn completed(&self) -> bool {
        self.reached(FTL_STEP).is_some()
    }
    fn declined(&self) -> bool {
        !self.completed() && self.skipped(OFFER_STEP)
    }
    fn idle(&self, now_ms: i64, idle_hours: u32) -> bool {
        self.last_t().map(|t| now_ms - t > idle_hours as i64 * 3_600_000).unwrap_or(true)
    }
    /// completed · declined · left · playing (in the tutorial) · deciding (at the offer)
    pub fn outcome(&self, now_ms: i64, idle_hours: u32) -> &'static str {
        if self.completed() {
            "completed"
        } else if self.declined() {
            "declined"
        } else if self.idle(now_ms, idle_hours) {
            "left"
        } else if self.events.iter().any(|e| e.k.starts_with("tutorial.")) {
            "playing"
        } else {
            "deciding"
        }
    }
}

/// `recorded_at` as Postgres prints it (`2026-10-20 19:43:06.133229+00`),
/// or RFC 3339.
pub fn parse_ts(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(d.timestamp_millis());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f%#z", "%Y-%m-%dT%H:%M:%S%.f%#z"] {
        if let Ok(d) = chrono::DateTime::parse_from_str(s, fmt) {
            return Some(d.timestamp_millis());
        }
    }
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f").ok().map(|d| d.and_utc().timestamp_millis())
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(o) => o.to_string(),
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Fold `/api/onboarding/player/{id}` rows into the player's SIGNUP session.
/// The route also answers every later run of theirs; folding those in would
/// time a tutorial taken days later as one long signup. A player with no
/// signup session comes back empty: their runs are in the runs tier.
pub fn session_from_rows(guild: &str, rows: &Value) -> PlayerSession {
    let mut s = PlayerSession { guild: guild.to_string(), ..Default::default() };
    let rows = rows.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
    let Some(signup) = rows.iter().find(|r| text(r.get("step_key")) == PLAYER_STEP).map(|r| text(r.get("session_id"))) else {
        return s;
    };
    for r in rows.iter().filter(|r| text(r.get("session_id")) == signup) {
        let Some(t) = parse_ts(&text(r.get("recorded_at"))) else { continue };
        let k = text(r.get("step_key"));
        if k.is_empty() {
            continue;
        }
        if s.version.is_empty() {
            s.version = text(r.get("content_version"));
            s.interface = text(r.get("interface_name"));
        }
        s.events.push(Ev { k, s: text(r.get("kind")) == "skipped", t });
    }
    s
}

/// Does this answer ever need asking again?
pub fn is_settled(s: &PlayerSession, newest: bool, now_ms: i64, idle_hours: u32) -> bool {
    if s.events.is_empty() {
        return !newest;
    }
    s.completed() || s.declined() || s.idle(now_ms, idle_hours)
}

fn player_index(id: &str) -> Option<u64> {
    let (kind, idx) = id.split_once('-')?;
    if kind != "1" {
        return None;
    }
    idx.parse().ok()
}

static PLAYERS: LazyLock<Mutex<HashMap<String, PlayerSession>>> =
    LazyLock::new(|| Mutex::new(crate::mcp::cache_store::load(CACHE_NAME).unwrap_or_default()));

// ── Guilds ──────────────────────────────────────────────────────────────────

struct Directory {
    at: Instant,
    entries: Vec<GuildApiEntry>,
    versions: Vec<String>,
    /// Each version's step catalog, from the first guild that has it.
    catalogs: HashMap<String, Vec<Value>>,
}
static DIRECTORY: LazyLock<tokio::sync::Mutex<Option<Directory>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));

fn client_for(api: &str) -> GuildApiClient {
    GuildApiClient::new(Arc::new(RwLock::new(api.to_string())))
}

fn version_number(v: &str) -> u32 {
    v.strip_prefix(VERSION_PREFIX).and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// Newest design first.
pub fn sort_versions(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| version_number(b).cmp(&version_number(a)).then_with(|| a.cmp(b)));
    v.dedup();
    v
}

async fn probe_versions(entries: &[GuildApiEntry]) -> HashMap<String, Vec<Value>> {
    let mut asks = Vec::new();
    for e in entries {
        let Some(api) = e.guild_api.clone() else { continue };
        for n in 1..=VERSION_PROBE_MAX {
            let api = api.clone();
            asks.push(async move {
                let v = format!("{VERSION_PREFIX}{n}");
                match client_for(&api).onboarding_catalog(&v).await {
                    Ok(Value::Array(a)) if !a.is_empty() => Some((v, a)),
                    _ => None,
                }
            });
        }
    }
    let mut found = HashMap::new();
    for (v, rows) in futures_util::future::join_all(asks).await.into_iter().flatten() {
        found.entry(v).or_insert(rows);
    }
    found
}

async fn directory(fresh: bool) -> Result<(Vec<GuildApiEntry>, Vec<String>, HashMap<String, Vec<Value>>), String> {
    let mut g = DIRECTORY.lock().await;
    if let Some(d) = g.as_ref() {
        if !fresh && d.at.elapsed() < DIRECTORY_TTL {
            return Ok((d.entries.clone(), d.versions.clone(), d.catalogs.clone()));
        }
    }
    let entries = crate::guild_directory::guild_api_directory().await?;
    let catalogs = probe_versions(&entries).await;
    let versions = sort_versions(catalogs.keys().cloned().collect());
    *g = Some(Directory { at: Instant::now(), entries: entries.clone(), versions: versions.clone(), catalogs: catalogs.clone() });
    Ok((entries, versions, catalogs))
}

// ── Aggregates (every session, every guild) ─────────────────────────────────

#[derive(Clone)]
struct GuildAggregate {
    funnels: BTreeMap<String, Vec<Value>>,
    outcome: Value,
    /// `/tutorial/players`: everyone, then new players only (for take-up).
    /// `Null` on a server without the route.
    players: Value,
    new_players: Value,
    player_steps: Vec<Value>,
    error: Option<String>,
}

/// (guild, version, idle hours, interface, excluded players included)
type AggregateKey = (String, String, u32, Option<String>, bool);
static AGGREGATES: LazyLock<Mutex<HashMap<AggregateKey, (Instant, GuildAggregate)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn missing_route(e: &str) -> bool {
    e.starts_with("Guild API 404 ")
}

// ── The runs ────────────────────────────────────────────────────────────────

/// One started tutorial run, as `/tutorial/runs/{v}` reports it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Run {
    pub guild: String,
    pub session: String,
    /// The design, without the replay suffix.
    pub version: String,
    /// `None`: the session never recorded who was playing.
    pub player: Option<String>,
    pub interface: String,
    pub replay: bool,
    /// The player's nth run.
    pub number: Option<u32>,
    pub new_player: bool,
    pub started_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub steps: Option<f64>,
    pub furthest: Option<String>,
    pub outcome: String,
}

fn flag(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "t" | "true" | "1"),
        _ => false,
    }
}

/// The server's outcome in the words the rest of this card uses.
fn run_outcome(server: &str) -> String {
    match server {
        "left_during_tutorial" => "left",
        "in_progress" => "playing",
        o => o,
    }
    .to_string()
}

pub fn run_from_row(guild: &str, r: &Value) -> Option<Run> {
    let session = text(r.get("session_id"));
    if session.is_empty() {
        return None;
    }
    let some = |s: String| if s.is_empty() { None } else { Some(s) };
    let version = text(r.get("content_version"));
    Some(Run {
        guild: guild.to_string(),
        session,
        version: version.strip_suffix(REPLAY_SUFFIX).unwrap_or(&version).to_string(),
        player: some(text(r.get("player_id"))),
        interface: text(r.get("interface_name")),
        replay: text(r.get("content_version")).ends_with(REPLAY_SUFFIX),
        number: num(r.get("run_number")).map(|n| n as u32),
        new_player: flag(r.get("new_player")),
        started_ms: parse_ts(&text(r.get("started_at"))),
        last_ms: parse_ts(&text(r.get("last_event_at"))),
        steps: num(r.get("steps_reached")),
        furthest: some(text(r.get("furthest_step_key"))),
        outcome: run_outcome(&text(r.get("outcome"))),
    })
}

/// Counts for one population of runs. `players` is unique players, the figure
/// to lead with: one player can have several runs.
pub fn run_summary(runs: &[&Run]) -> Value {
    let count = |f: &dyn Fn(&Run) -> bool| runs.iter().filter(|r| f(r)).count();
    let outcome = |o: &str| runs.iter().filter(|r| r.outcome == o).count();
    json!({
        "runs": runs.len(),
        "players": runs.iter().filter_map(|r| r.player.as_ref()).collect::<HashSet<_>>().len(),
        "repeat": count(&|r| r.number.map_or(false, |n| n > 1)),
        "replays": count(&|r| r.replay),
        "existing": count(&|r| r.player.is_some() && !r.new_player),
        "no_player": count(&|r| r.player.is_none()),
        "completed": outcome("completed"),
        "left": outcome("left"),
        "playing": outcome("playing"),
    })
}

/// A segment's runs side by side, by which run it was for the player: first,
/// second, third and later. Times are `spread`s in seconds.
pub fn run_comparison(runs: &[&Run]) -> Vec<Value> {
    let mut by_player: HashMap<&str, Vec<&Run>> = HashMap::new();
    for r in runs {
        if let Some(p) = &r.player {
            by_player.entry(p).or_default().push(r);
        }
    }
    let mut since: HashMap<&str, f64> = HashMap::new();
    for rs in by_player.values_mut() {
        rs.sort_by_key(|r| r.started_ms);
        for w in rs.windows(2) {
            if let Some(g) = gap(w[0].started_ms, w[1].started_ms) {
                since.insert(w[1].session.as_str(), g);
            }
        }
    }
    let group = |r: &Run| r.number.unwrap_or(1).clamp(1, 3);
    (1..=3)
        .filter_map(|n| {
            let rs: Vec<&&Run> = runs.iter().filter(|r| group(r) == n).collect();
            if rs.is_empty() {
                return None;
            }
            let outcome = |o: &str| rs.iter().filter(|r| r.outcome == o).count();
            let done: Vec<f64> = rs.iter().filter(|r| r.outcome == "completed").filter_map(|r| gap(r.started_ms, r.last_ms)).collect();
            let steps: Vec<f64> = rs.iter().filter_map(|r| r.steps).collect();
            let back: Vec<f64> = rs.iter().filter_map(|r| since.get(r.session.as_str()).copied()).collect();
            Some(json!({
                "run": if n == 3 { "3+".to_string() } else { n.to_string() },
                "runs": rs.len(), "completed": outcome("completed"), "left": outcome("left"), "playing": outcome("playing"),
                "completion_rate": outcome("completed") as f64 / rs.len() as f64,
                "steps": spread(steps), "time": spread(done), "since_previous": spread(back),
            }))
        })
        .collect()
}

/// Who stopped at each step, the people behind a funnel's counts: runs that
/// did not finish, by the furthest step they reached, and signup sessions
/// that quit. Most recent first, `STOPPED_SHOWN` a step.
pub fn who_stopped(runs: &[&Run], sessions: &[(&String, &PlayerSession)], now: i64, idle_hours: u32, name: impl Fn(&str) -> String) -> Value {
    let mut steps: BTreeMap<String, BTreeMap<String, (i64, String, String)>> = BTreeMap::new();
    let mut add = |key: &str, player: &str, last: i64, guild: &str, outcome: &str| {
        let e = steps.entry(key.to_string()).or_default().entry(player.to_string()).or_default();
        if last >= e.0 {
            *e = (last, guild.to_string(), outcome.to_string());
        }
    };
    for r in runs.iter().filter(|r| r.outcome != "completed") {
        if let (Some(p), Some(k)) = (&r.player, &r.furthest) {
            add(k, p, r.last_ms.unwrap_or(0), &r.guild, &r.outcome);
        }
    }
    for (pid, s) in sessions {
        let outcome = s.outcome(now, idle_hours);
        if outcome == "left" {
            if let Some(e) = s.last_step() {
                add(&e.k, pid, e.t, &s.guild, outcome);
            }
        }
    }
    let out: serde_json::Map<String, Value> = steps
        .into_iter()
        .map(|(key, who)| {
            let total = who.len();
            let mut rows: Vec<(String, (i64, String, String))> = who.into_iter().collect();
            rows.sort_by_key(|(_, (last, _, _))| std::cmp::Reverse(*last));
            let players: Vec<Value> = rows
                .into_iter()
                .take(STOPPED_SHOWN)
                .map(|(p, (last, guild, outcome))| json!({ "player_id": p, "name": name(&p), "guild_id": guild, "last_ms": last, "outcome": outcome }))
                .collect();
            (key, json!({ "total": total, "players": players }))
        })
        .collect();
    Value::Object(out)
}

/// What one guild answered. `read` is false for a server without the route,
/// which is not the same as a guild with no runs.
#[derive(Clone, Debug, Default)]
struct GuildRuns {
    runs: Vec<Run>,
    read: bool,
    error: Option<String>,
}

/// `/tutorial/players/{v}`'s counts.
const PLAYER_FIELDS: [&str; 10] = ["players", "new_players", "existing_players", "started", "completed", "declined", "left_at_offer", "left_during_tutorial", "in_progress", "revisited"];

/// Sum the same fields across guilds' one-row answers. Nothing answered is
/// `null`, not zeros.
pub fn sum_rows(rows: &[&Value], keys: &[&str]) -> Value {
    if rows.is_empty() {
        return Value::Null;
    }
    let out: serde_json::Map<String, Value> = keys.iter().map(|k| (k.to_string(), json!(rows.iter().filter_map(|r| num(r.get(*k))).sum::<f64>()))).collect();
    Value::Object(out)
}

/// `/tutorial/players/{v}/steps` summed across guilds. `retained` is against
/// the first step: everyone counted got at least that far.
pub fn merge_player_steps(per_guild: &[&Vec<Value>]) -> Vec<Value> {
    let mut steps: BTreeMap<String, (f64, f64, f64)> = BTreeMap::new();
    for rows in per_guild {
        for r in rows.iter() {
            let key = text(r.get("step_key"));
            if key.is_empty() {
                continue;
            }
            let e = steps.entry(key).or_insert((num(r.get("step_order")).unwrap_or(0.0), 0.0, 0.0));
            e.1 += num(r.get("reached")).unwrap_or(0.0);
            e.2 += num(r.get("furthest")).unwrap_or(0.0);
        }
    }
    let mut out: Vec<(String, (f64, f64, f64))> = steps.into_iter().collect();
    out.sort_by(|a, b| a.1 .0.total_cmp(&b.1 .0));
    let first = out.first().map_or(0.0, |(_, s)| s.1);
    out.into_iter()
        .map(|(key, (order, reached, furthest))| {
            json!({ "key": key, "order": order, "reached": reached, "furthest": furthest,
                    "retained": if first > 0.0 { json!(reached / first) } else { Value::Null } })
        })
        .collect()
}

/// (guild, version, idle hours, excluded players included)
type RunsKey = (String, String, u32, bool);
static RUNS: LazyLock<Mutex<HashMap<RunsKey, (Instant, GuildRuns)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn guild_runs(guild: &str, api: &str, version: &str, idle_hours: u32, all: bool, fresh: bool) -> GuildRuns {
    let key = (guild.to_string(), version.to_string(), idle_hours, all);
    if !fresh {
        if let Some((at, r)) = RUNS.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if at.elapsed() < AGGREGATE_TTL {
                return r.clone();
            }
        }
    }
    let c = client_for(api);
    let mut out = GuildRuns::default();
    for page in 1..=RUNS_MAX_PAGES {
        match c.onboarding_tutorial_runs(version, idle_hours, page, all).await {
            Ok(Value::Array(rows)) => {
                out.read = true;
                out.runs.extend(rows.iter().filter_map(|r| run_from_row(guild, r)));
                if rows.len() < RUNS_PAGE {
                    break;
                }
            }
            Ok(_) => break,
            Err(e) => {
                if !missing_route(&e) {
                    out.error = Some(e);
                }
                break;
            }
        }
    }
    if out.error.is_none() {
        RUNS.lock().unwrap_or_else(|p| p.into_inner()).insert(key, (Instant::now(), out.clone()));
    }
    out
}

async fn guild_aggregate(guild: &str, api: &str, version: &str, idle_hours: u32, interface: Option<&str>, all: bool, fresh: bool) -> GuildAggregate {
    let key = (guild.to_string(), version.to_string(), idle_hours, interface.map(String::from), all);
    if !fresh {
        if let Some((at, a)) = AGGREGATES.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if at.elapsed() < AGGREGATE_TTL {
                return a.clone();
            }
        }
    }
    let c = client_for(api);
    let (signup, tutorial, outcome, players, new_players, player_steps) = tokio::join!(
        c.onboarding_funnel(version, PHASES[0], idle_hours, interface, all),
        c.onboarding_funnel(version, PHASES[1], idle_hours, interface, all),
        c.onboarding_tutorial_outcome(version, idle_hours, interface, all),
        c.onboarding_tutorial_players(version, idle_hours, interface, None, all),
        c.onboarding_tutorial_players(version, idle_hours, interface, Some("new"), all),
        c.onboarding_tutorial_player_steps(version, interface, all),
    );
    let mut a = GuildAggregate { funnels: BTreeMap::new(), outcome: Value::Null, players: Value::Null, new_players: Value::Null, player_steps: Vec::new(), error: None };
    for (phase, r) in [(PHASES[0], signup), (PHASES[1], tutorial)] {
        match r {
            Ok(Value::Array(rows)) => {
                a.funnels.insert(phase.to_string(), rows);
            }
            Ok(_) => {}
            Err(e) => a.error = Some(if missing_route(&e) { "no onboarding telemetry on this guild yet".into() } else { e }),
        }
    }
    match outcome {
        Ok(v) => a.outcome = v,
        Err(e) if a.error.is_none() => a.error = Some(if missing_route(&e) { "no onboarding telemetry on this guild yet".into() } else { e }),
        Err(_) => {}
    }
    // Newer than the routes above: a guild without them is not a failed guild.
    let mut newer = |r: Result<Value, String>, slot: &mut Value| match r {
        Ok(v) => *slot = v,
        Err(e) if !missing_route(&e) && a.error.is_none() => a.error = Some(e),
        Err(_) => {}
    };
    let (mut p, mut n, mut st) = (Value::Null, Value::Null, Value::Null);
    newer(players, &mut p);
    newer(new_players, &mut n);
    newer(player_steps, &mut st);
    (a.players, a.new_players) = (p, n);
    if let Value::Array(rows) = st {
        a.player_steps = rows;
    }
    if a.error.is_none() {
        AGGREGATES.lock().unwrap_or_else(|p| p.into_inner()).insert(key, (Instant::now(), a.clone()));
    }
    a
}

/// Sum funnels from several guilds step by step. `retained` is recomputed
/// against the summed first step (the one nothing precedes that has a
/// successor — that excludes off-line steps such as the Recovery Key FAQ).
pub fn merge_funnels(per_guild: &[(String, Vec<Value>)]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut steps: HashMap<String, Value> = HashMap::new();
    for (guild, rows) in per_guild {
        for r in rows {
            let key = text(r.get("step_key"));
            if key.is_empty() {
                continue;
            }
            let reached = num(r.get("reached")).unwrap_or(0.0);
            let skipped = num(r.get("skipped")).unwrap_or(0.0);
            let dropped = num(r.get("dropped"));
            let e = steps.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                json!({
                    "key": key,
                    "order": num(r.get("step_order")).unwrap_or(0.0),
                    "previous": r.get("previous_step_key").cloned().unwrap_or(Value::Null),
                    "next": r.get("next_step_key").cloned().unwrap_or(Value::Null),
                    "reached": 0.0, "skipped": 0.0, "dropped": Value::Null,
                    "by_guild": {},
                })
            });
            e["reached"] = json!(e["reached"].as_f64().unwrap_or(0.0) + reached);
            e["skipped"] = json!(e["skipped"].as_f64().unwrap_or(0.0) + skipped);
            if let Some(d) = dropped {
                e["dropped"] = json!(e["dropped"].as_f64().unwrap_or(0.0) + d);
            }
            if reached > 0.0 {
                e["by_guild"][guild.as_str()] = json!(reached);
            }
        }
    }
    let mut out: Vec<Value> = order.into_iter().filter_map(|k| steps.remove(&k)).collect();
    out.sort_by(|a, b| a["order"].as_f64().unwrap_or(0.0).total_cmp(&b["order"].as_f64().unwrap_or(0.0)));
    with_rates(out)
}

/// The rates every funnel row carries, individual and cumulative:
/// `retained` and `lost` (1 − retained) against the phase's first step,
/// `step_drop` = quit here / reached, `skip_rate` = skipped / reached,
/// `cum_skip` = skipped up to and including here / first step. The first step
/// is the one nothing precedes that has a successor — that excludes off-line
/// steps such as the Recovery Key FAQ.
pub fn with_rates(mut steps: Vec<Value>) -> Vec<Value> {
    let first = steps
        .iter()
        .filter(|s| s["previous"].is_null() && !s["next"].is_null())
        .map(|s| s["reached"].as_f64().unwrap_or(0.0))
        .fold(0.0, f64::max);
    let ratio = |a: f64, b: f64| if b > 0.0 { json!(a / b) } else { Value::Null };
    let mut skipped_so_far = 0.0;
    for s in steps.iter_mut() {
        let r = s["reached"].as_f64().unwrap_or(0.0);
        let k = s["skipped"].as_f64().unwrap_or(0.0);
        let on_line = !(s["previous"].is_null() && s["next"].is_null());
        if on_line {
            skipped_so_far += k;
        }
        s["retained"] = ratio(r, first);
        s["lost"] = if first > 0.0 && on_line { json!(1.0 - r / first) } else { Value::Null };
        s["step_drop"] = match s["dropped"].as_f64() {
            Some(d) => ratio(d, r),
            None => Value::Null,
        };
        s["skip_rate"] = ratio(k, r);
        s["cum_skip"] = if on_line { ratio(skipped_so_far, first) } else { Value::Null };
    }
    steps
}

// ── The crawl ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
struct GuildCrawl {
    candidates: usize,
    team_skipped: usize,
    replicants_skipped: usize,
    /// Asked this round. `fetched` of these came back.
    todo: usize,
    fetched: usize,
    errors: usize,
    last_error: Option<String>,
}

#[derive(Default)]
struct CrawlState {
    started: Option<Instant>,
    finished: Option<Instant>,
    finished_ms: i64,
    guilds: BTreeMap<String, GuildCrawl>,
}

static CRAWLING: AtomicBool = AtomicBool::new(false);
static CRAWL: LazyLock<Mutex<CrawlState>> = LazyLock::new(|| Mutex::new(CrawlState::default()));

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Which roster players to ask, newest first. Replicants sign up from code,
/// never through an interface, so they have no telemetry to read.
pub struct CrawlPlan {
    pub todo: Vec<(String, String)>,
    pub newest: HashSet<String>,
    pub team: usize,
    pub replicants: usize,
    pub candidates: usize,
}

pub fn crawl_plan(
    roster: &[(String, String)],
    is_team: impl Fn(&str) -> bool,
    is_replicant: impl Fn(&str) -> bool,
    cached: &HashMap<String, PlayerSession>,
) -> CrawlPlan {
    let mut cands: Vec<(u64, &String, &String)> = roster
        .iter()
        .filter_map(|(id, name)| player_index(id).filter(|i| *i >= TELEMETRY_FLOOR_INDEX).map(|i| (i, id, name)))
        .collect();
    cands.sort_by(|a, b| b.0.cmp(&a.0));
    let total = cands.len();
    let (mut team, mut replicants) = (0, 0);
    let mut todo = Vec::new();
    let mut newest = HashSet::new();
    for (_, id, name) in cands {
        if is_team(id) {
            team += 1;
            continue;
        }
        if is_replicant(id) {
            replicants += 1;
            continue;
        }
        if newest.len() < UNSETTLED_NEWEST {
            newest.insert(id.clone());
        }
        if cached.get(id.as_str()).map(|s| s.settled).unwrap_or(false) {
            continue;
        }
        if todo.len() < CRAWL_BUDGET {
            todo.push((id.clone(), name.clone()));
        }
    }
    CrawlPlan { todo, newest, team, replicants, candidates: total }
}

async fn crawl_guild(guild: String, api: String, idle_hours: u32) {
    use futures_util::StreamExt;
    let c = client_for(&api);
    let roster: Vec<(String, String)> = match c.guild_roster(&guild).await {
        Ok(Value::Array(rows)) => rows.iter().map(|r| (text(r.get("id")), text(r.get("username")))).collect(),
        Ok(_) => Vec::new(),
        Err(e) => {
            let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
            let g = st.guilds.entry(guild).or_default();
            g.errors += 1;
            g.last_error = Some(format!("roster: {e}"));
            return;
        }
    };
    let cached = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let replicants = crate::mcp::onboarding_players::UNIVERSE.lock().unwrap_or_else(|p| p.into_inner()).replicants.clone();
    let plan = crawl_plan(&roster, crate::mcp::virtual_players::is_team_player, |id| replicants.contains_key(id), &cached);
    let newest = plan.newest;
    {
        let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
        let g = st.guilds.entry(guild.clone()).or_default();
        *g = GuildCrawl { candidates: plan.candidates, team_skipped: plan.team, replicants_skipped: plan.replicants, todo: plan.todo.len(), ..Default::default() };
    }
    let mut results = futures_util::stream::iter(plan.todo.into_iter().map(|(pid, name)| {
        let c = c.clone();
        async move {
            let r = c.onboarding_player(&pid).await;
            (pid, name, r)
        }
    }))
    .buffer_unordered(CRAWL_CONCURRENCY);
    let mut errors = 0usize;
    while let Some((pid, name, r)) = results.next().await {
        match r {
            Ok(rows) => {
                let mut s = session_from_rows(&guild, &rows);
                s.name = name;
                s.fetched_ms = now_ms();
                s.settled = is_settled(&s, newest.contains(&pid), s.fetched_ms, idle_hours);
                PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).insert(pid, s);
                let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
                st.guilds.entry(guild.clone()).or_default().fetched += 1;
            }
            Err(e) => {
                errors += 1;
                let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
                let g = st.guilds.entry(guild.clone()).or_default();
                g.errors += 1;
                g.last_error = Some(if missing_route(&e) { "no per-player onboarding route".into() } else { e.clone() });
                if missing_route(&e) || errors >= CRAWL_MAX_ERRORS {
                    break;
                }
            }
        }
    }
}

/// Everyone with any recorded onboarding step or tutorial run: someone was
/// at the keyboard, whatever their name.
fn telemetry_players() -> HashSet<String> {
    let sampled: Vec<String> = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|(_, s)| !s.events.is_empty()).map(|(p, _)| p.clone()).collect();
    let runs = RUNS.lock().unwrap_or_else(|p| p.into_inner());
    sampled.into_iter().chain(runs.values().flat_map(|(_, g)| g.runs.iter().filter_map(|r| r.player.clone()))).collect()
}

fn spawn_crawl(entries: Vec<GuildApiEntry>, idle_hours: u32) {
    if CRAWLING.swap(true, Ordering::SeqCst) {
        return;
    }
    CRAWL.lock().unwrap_or_else(|p| p.into_inner()).started = Some(Instant::now());
    tauri::async_runtime::spawn(async move {
        // Replicants first: both crawls below skip or defer them.
        let replicants_error = crate::mcp::onboarding_players::refresh_replicants().await.err();
        {
            let u = crate::mcp::onboarding_players::UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
            PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).retain(|pid, _| !u.is_replicant(pid));
        }
        let guild_ids: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
        let jobs = entries
            .into_iter()
            .filter_map(|e| e.guild_api.map(|api| crawl_guild(e.id, api, idle_hours)));
        // Each guild's sessions, and the chain-wide player tables from ours.
        tokio::join!(
            futures_util::future::join_all(jobs),
            crate::mcp::onboarding_players::crawl(replicants_error, guild_ids, telemetry_players())
        );
        let snapshot = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).clone();
        crate::mcp::cache_store::save_in_background(CACHE_NAME, snapshot);
        crate::mcp::onboarding_players::finish_round(&telemetry_players());
        crate::mcp::onboarding_history::record_chain(&crate::mcp::onboarding_players::snapshot(), now_ms());
        {
            let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
            st.finished = Some(Instant::now());
            st.finished_ms = now_ms();
        }
        CRAWLING.store(false, Ordering::SeqCst);
    });
}

/// Keep the daily history going while the card is closed, for a player who
/// has used it: every install does not need to crawl every guild.
pub fn start_history_ticker() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(HISTORY_FIRST_TICK).await;
        loop {
            if now_ms() - crate::mcp::onboarding_history::last_ms() > HISTORY_MAX_AGE_MS && crawl_due(false) {
                if let Ok((entries, _, _)) = directory(false).await {
                    spawn_crawl(entries, DEFAULT_IDLE_HOURS);
                }
            }
            tokio::time::sleep(HISTORY_TICK).await;
        }
    });
}

/// At launch: only a player with history has opted in.
pub fn resume_history_ticker() {
    if crate::mcp::onboarding_history::last_ms() > 0 {
        start_history_ticker();
    }
}

fn crawl_due(fresh: bool) -> bool {
    if CRAWLING.load(Ordering::SeqCst) {
        return false;
    }
    let st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
    fresh || st.finished.map(|f| f.elapsed() >= CRAWL_GAP).unwrap_or(true)
}

// ── Folding the sample ──────────────────────────────────────────────────────

/// `{n, p50, p90}` in seconds, or `null` when nothing was measured.
pub fn spread(mut secs: Vec<f64>) -> Value {
    if secs.is_empty() {
        return Value::Null;
    }
    secs.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f64| secs[(((secs.len() - 1) as f64) * q).round() as usize];
    json!({ "n": secs.len(), "p50": at(0.5), "p90": at(0.9), "mean": secs.iter().sum::<f64>() / secs.len() as f64 })
}

fn gap(a: Option<i64>, b: Option<i64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) if b >= a => Some((b - a) as f64 / 1000.0),
        _ => None,
    }
}

fn day_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Everything the sample can say about one content version. `next` maps a
/// step to the step after it, from the funnel rows.
pub fn fold_sample(sessions: &[(&String, &PlayerSession)], next: &HashMap<String, String>, now: i64, idle_hours: u32, recent_n: usize) -> Value {
    let mut dur: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    let mut dwell: HashMap<String, Vec<f64>> = HashMap::new();
    let mut stopped: HashMap<String, usize> = HashMap::new();
    let mut daily: BTreeMap<String, [usize; 4]> = BTreeMap::new();
    let mut outcomes: BTreeMap<&str, usize> = BTreeMap::new();
    let mut interfaces: BTreeMap<String, usize> = BTreeMap::new();
    for (_, s) in sessions {
        let first = s.first_t();
        let record = s.reached(PLAYER_STEP);
        let offer = s.reached(OFFER_STEP);
        let loading = s.reached(LOADING_STEP);
        let ftl = s.reached(FTL_STEP);
        let decided = if s.skipped(OFFER_STEP) { s.events.iter().find(|e| e.k == OFFER_STEP && e.s).map(|e| e.t) } else { loading };
        for (k, v) in [
            ("signup", gap(first, record)),
            ("chain_wait", gap(s.reached(SUBMIT_STEP), record)),
            ("to_offer", gap(record, offer)),
            ("decision", gap(offer, decided)),
            ("tutorial", gap(loading, ftl)),
            ("total", gap(first, ftl)),
        ] {
            if let Some(v) = v {
                dur.entry(k).or_default().push(v);
            }
        }
        let at: HashMap<&str, i64> = s.events.iter().filter(|e| !e.s).map(|e| (e.k.as_str(), e.t)).collect();
        for (k, t) in &at {
            if let Some(n) = next.get(*k).and_then(|n| at.get(n.as_str())) {
                if *n >= *t {
                    dwell.entry(k.to_string()).or_default().push((*n - *t) as f64 / 1000.0);
                }
            }
        }
        let outcome = s.outcome(now, idle_hours);
        *outcomes.entry(outcome).or_default() += 1;
        if outcome == "left" {
            if let Some(e) = s.last_step() {
                *stopped.entry(e.k.clone()).or_default() += 1;
            }
        }
        *interfaces.entry(if s.interface.is_empty() { "unknown".into() } else { s.interface.clone() }).or_default() += 1;
        if let Some(t) = record.or(first) {
            let d = daily.entry(day_of(t)).or_default();
            d[0] += 1;
            if offer.is_some() {
                d[1] += 1;
            }
            if s.completed() {
                d[2] += 1;
            }
            if s.declined() {
                d[3] += 1;
            }
        }
    }
    let mut recent: Vec<&(&String, &PlayerSession)> = sessions.iter().collect();
    recent.sort_by_key(|(_, s)| std::cmp::Reverse(s.last_t().unwrap_or(0)));
    let recent: Vec<Value> = recent
        .into_iter()
        .take(recent_n)
        .map(|(pid, s)| {
            json!({
                "player_id": pid,
                "name": s.name,
                "guild_id": s.guild,
                "started_ms": s.first_t(),
                "last_ms": s.last_t(),
                "last_step": s.last_step().map(|e| e.k.clone()),
                "outcome": s.outcome(now, idle_hours),
                "signup_s": gap(s.first_t(), s.reached(PLAYER_STEP)),
                "tutorial_s": gap(s.reached(LOADING_STEP), s.reached(FTL_STEP)),
            })
        })
        .collect();
    json!({
        "sessions": sessions.len(),
        "durations": dur.into_iter().map(|(k, v)| (k.to_string(), spread(v))).collect::<serde_json::Map<_, _>>(),
        "dwell": dwell.into_iter().map(|(k, v)| (k, spread(v))).collect::<serde_json::Map<_, _>>(),
        "stopped": stopped,
        "outcomes": outcomes,
        "interfaces": interfaces,
        "daily": daily.into_iter().map(|(day, d)| json!({ "day": day, "signed_up": d[0], "offered": d[1], "completed": d[2], "declined": d[3] })).collect::<Vec<_>>(),
        "recent": recent,
    })
}

// ── Filters and segments ────────────────────────────────────────────────────

/// One population, optionally split along one dimension. Every page of the
/// card reads the same filters.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Filters {
    #[serde(default)]
    pub interface: Option<String>,
    #[serde(default)]
    pub guild: Option<String>,
    /// `active` | `inactive`
    #[serde(default)]
    pub activity: Option<String>,
    /// Count replicants too; humans only when unset.
    #[serde(default)]
    pub replicants: Option<bool>,
    /// `interface` | `guild` | `activity` | `replicant` | `version`
    #[serde(default)]
    pub compare: Option<String>,
    /// Ask the guilds' reports for their excluded players too
    /// (`include_excluded=1`); left out when unset.
    #[serde(default)]
    pub include_excluded: Option<bool>,
}

/// The interface of a player with no onboarding telemetry: signed up before
/// it existed, through the API (agents, this app's replicants), or elsewhere.
pub const NO_INTERFACE: &str = "none";
pub const DEFAULT_ACTIVE_DAYS: u32 = 7;

#[derive(Clone, Debug, PartialEq)]
pub struct Seg {
    pub key: String,
    pub label: String,
    pub guild: Option<String>,
    pub interface: Option<String>,
    pub active: Option<bool>,
    /// `Some(false)` = humans only, `Some(true)` = replicants only.
    pub replicant: Option<bool>,
    /// A design other than the card's chosen one, when comparing designs.
    pub version: Option<String>,
}

impl Seg {
    pub fn wants(&self, guild: &str, interface: &str, active: bool, replicant: bool) -> bool {
        self.guild.as_deref().map_or(true, |g| g == guild)
            && self.interface.as_deref().map_or(true, |i| i == interface)
            && self.active.map_or(true, |a| a == active)
            && self.replicant.map_or(true, |r| r == replicant)
    }
}

fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The filtered population, or one segment per value of the compared
/// dimension (narrowed by the filter on that same dimension, if any).
pub fn segments(f: &Filters, guilds: &[(String, String)], interfaces: &[String], versions: &[String]) -> Vec<Seg> {
    let base = Seg {
        key: "all".into(),
        label: "All".into(),
        guild: clean(&f.guild),
        interface: clean(&f.interface),
        active: match clean(&f.activity).as_deref() {
            Some("active") => Some(true),
            Some("inactive") => Some(false),
            _ => None,
        },
        replicant: if f.replicants == Some(true) { None } else { Some(false) },
        version: None,
    };
    match clean(&f.compare).as_deref() {
        Some("guild") => guilds
            .iter()
            .filter(|(id, _)| base.guild.as_ref().map_or(true, |g| g == id))
            .map(|(id, label)| Seg { key: id.clone(), label: label.clone(), guild: Some(id.clone()), ..base.clone() })
            .collect(),
        Some("interface") => interfaces
            .iter()
            .filter(|i| base.interface.as_ref().map_or(true, |b| b == *i))
            .map(|i| Seg { key: i.clone(), label: i.clone(), interface: Some(i.clone()), ..base.clone() })
            .collect(),
        Some("activity") => [(true, "active", "Active"), (false, "inactive", "Inactive")]
            .iter()
            .filter(|(a, _, _)| base.active.map_or(true, |b| b == *a))
            .map(|(a, k, l)| Seg { key: (*k).into(), label: (*l).into(), active: Some(*a), ..base.clone() })
            .collect(),
        // Comparing the two is asking for both, whatever the checkbox says.
        Some("replicant") => [(false, "human", "Humans"), (true, "replicant", "Replicants")]
            .iter()
            .map(|(r, k, l)| Seg { key: (*k).into(), label: (*l).into(), replicant: Some(*r), ..base.clone() })
            .collect(),
        Some("version") => versions
            .iter()
            .take(VERSIONS_COMPARED)
            .map(|v| Seg { key: v.clone(), label: v.clone(), version: Some(v.clone()), ..base.clone() })
            .collect(),
        _ => vec![base],
    }
}

// ── Folds over a segment ────────────────────────────────────────────────────

/// One phase of a catalog in order: (key, previous, next).
pub fn phase_chain(catalog: &[Value], phase: &str) -> Vec<(String, Option<String>, Option<String>)> {
    let mut rows: Vec<&Value> = catalog.iter().filter(|r| text(r.get("phase")) == phase).collect();
    rows.sort_by(|a, b| num(a.get("step_order")).unwrap_or(0.0).total_cmp(&num(b.get("step_order")).unwrap_or(0.0)));
    let next: HashMap<String, String> = rows
        .iter()
        .filter_map(|r| {
            let p = text(r.get("previous_step_key"));
            (!p.is_empty()).then(|| (p, text(r.get("step_key"))))
        })
        .collect();
    rows.iter()
        .map(|r| {
            let k = text(r.get("step_key"));
            let p = text(r.get("previous_step_key"));
            let n = next.get(&k).cloned();
            (k, (!p.is_empty()).then_some(p), n)
        })
        .collect()
}

/// A funnel over player sessions, the server's columns plus rates. Quitting
/// is the server's rule (reached, never reached the next step, idle) less
/// the players who SKIPPED this step: a skip is counted as a skip, not a quit.
pub fn sample_funnel(chain: &[(String, Option<String>, Option<String>)], sessions: &[&PlayerSession], now: i64, idle_hours: u32) -> Vec<Value> {
    let steps = chain
        .iter()
        .enumerate()
        .map(|(i, (k, prev, next))| {
            let reached: Vec<&&PlayerSession> = sessions.iter().filter(|s| s.reached(k).is_some()).collect();
            let skipped = sessions.iter().filter(|s| s.skipped(k)).count();
            let dropped = next.as_ref().map(|n| {
                reached.iter().filter(|s| s.reached(n).is_none() && !s.skipped(k) && s.idle(now, idle_hours)).count()
            });
            json!({ "key": k, "order": i, "previous": prev, "next": next, "reached": reached.len() as f64,
                    "skipped": skipped as f64, "dropped": dropped.map(|d| d as f64) })
        })
        .collect();
    with_rates(steps)
}

/// `{n, zero, mean, p25, p50, p75, p90, max, hist}`; `hist` counts values in
/// `[0]` then each `[edges[i], edges[i+1])`, the last open-ended.
pub fn dist(mut v: Vec<f64>, edges: &[f64]) -> Value {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return json!({ "n": 0, "hist": [] });
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    let at = |q: f64| v[(((n - 1) as f64) * q).round() as usize];
    let mut hist = vec![json!({ "lo": 0, "hi": 0, "n": v.iter().filter(|x| **x < edges[0]).count() })];
    for (i, lo) in edges.iter().enumerate() {
        let hi = edges.get(i + 1).copied();
        let c = v.iter().filter(|x| **x >= *lo && hi.map_or(true, |h| **x < h)).count();
        hist.push(json!({ "lo": lo, "hi": hi, "n": c }));
    }
    json!({
        "n": n, "zero": v.iter().filter(|x| **x == 0.0).count(),
        "mean": v.iter().sum::<f64>() / n as f64,
        "p25": at(0.25), "p50": at(0.5), "p75": at(0.75), "p90": at(0.9), "max": v[n - 1],
        "hist": hist,
    })
}

const COUNT_EDGES: [f64; 6] = [1.0, 10.0, 100.0, 1e3, 1e4, 1e5];
const GRAM_EDGES: [f64; 9] = [1.0, 10.0, 100.0, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
/// 10 min · 1 h · 6 h · 1 d · 3 d · 7 d · 30 d
const PLAY_EDGES: [f64; 8] = [1.0, 600.0, 3_600.0, 21_600.0, 86_400.0, 259_200.0, 604_800.0, 2_592_000.0];

fn is_active(p: Option<&crate::mcp::onboarding_players::PlayerFacts>, cutoff: i64) -> bool {
    p.and_then(|p| p.last_active_ms).map_or(false, |t| t >= cutoff)
}

/// How many of a population reached each milestone, in the order a new player
/// meets them. Not a strict funnel: a raider need not have refined.
const DAY_MS: i64 = 86_400_000;
/// Weeks after joining the Retention grid follows.
const COHORT_WEEKS: i64 = 8;

/// Where every player stands now, by when they last acted. The five buckets
/// are exclusive, so they sum to the players; `new_7d` is apart from them.
pub fn lifecycle(members: &[&crate::mcp::onboarding_players::PlayerFacts], now: i64) -> Value {
    let (mut today, mut week, mut month, mut gone, mut never) = (0, 0, 0, 0, 0);
    for p in members {
        match p.last_active_ms.map(|a| now - a) {
            None => never += 1,
            Some(age) if age <= DAY_MS => today += 1,
            Some(age) if age <= 7 * DAY_MS => week += 1,
            Some(age) if age <= 30 * DAY_MS => month += 1,
            Some(_) => gone += 1,
        }
    }
    let new_7d = members.iter().filter(|p| p.created_ms.map_or(false, |c| now - c < 7 * DAY_MS)).count();
    json!({ "today": today, "week": week, "month": month, "gone": gone, "never": never, "new_7d": new_7d })
}

/// One row per ISO week joined: how many joined, how many ever acted, and
/// `alive[n]` = how many last acted at least n+1 weeks after joining. `lastAction`
/// keeps only the latest action, so this is survival, not week-by-week return.
/// A week is left off a row until every member has had that long.
pub fn cohorts(members: &[&crate::mcp::onboarding_players::PlayerFacts], now: i64) -> Vec<Value> {
    use chrono::Datelike;
    let mut weeks: std::collections::BTreeMap<(i32, u32), Vec<(i64, Option<i64>)>> = Default::default();
    for p in members {
        let Some(created) = p.created_ms else { continue };
        let Some(at) = chrono::DateTime::from_timestamp_millis(created) else { continue };
        let w = at.iso_week();
        weeks.entry((w.year(), w.week())).or_default().push((created, p.last_active_ms));
    }
    weeks
        .into_iter()
        .map(|((year, week), rows)| {
            let newest = rows.iter().map(|r| r.0).max().unwrap_or(now);
            let alive: Vec<usize> = (1..=COHORT_WEEKS)
                .take_while(|n| newest + n * 7 * DAY_MS <= now)
                .map(|n| rows.iter().filter(|(c, last)| last.map_or(false, |l| l >= c + n * 7 * DAY_MS)).count())
                .collect();
            json!({ "week": format!("W{week:02}"), "year": year, "n": rows.len(), "acted": rows.iter().filter(|r| r.1.is_some()).count(), "alive": alive })
        })
        .collect()
}

pub fn activation(members: &[(&crate::mcp::onboarding_players::PlayerFacts, Option<&crate::mcp::onboarding_players::PlayerStats>)], cutoff: i64) -> Vec<Value> {
    let count = |f: &dyn Fn(&crate::mcp::onboarding_players::PlayerFacts, &crate::mcp::onboarding_players::PlayerStats) -> bool| {
        let none = crate::mcp::onboarding_players::PlayerStats::default();
        members.iter().filter(|(p, s)| f(p, s.unwrap_or(&none))).count()
    };
    let total = members.len();
    [
        ("signed_up", total),
        ("acted", count(&|p, _| p.last_active_ms.is_some())),
        ("mined", count(&|_, s| s.mined_g.map_or(false, |v| v > 0.0))),
        ("refined", count(&|_, s| s.refined_g.map_or(false, |v| v > 0.0))),
        ("planet", count(&|_, s| s.planets > 0.0)),
        ("raided", count(&|_, s| s.raids_initiated > 0.0)),
        ("active", count(&|p, _| is_active(Some(p), cutoff))),
    ]
    .iter()
    .map(|(k, n)| json!({ "key": k, "n": n, "rate": if total > 0 { json!(*n as f64 / total as f64) } else { Value::Null } }))
    .collect()
}

// ── The read ────────────────────────────────────────────────────────────────

/// The onboarding and player dashboard for one content version (default: the
/// newest any guild has a catalog for), filtered and split by `filters`.
/// Starts or continues the background crawls and answers with what they hold.
#[tauri::command]
pub async fn terminal_onboarding(
    version: Option<String>,
    idle_hours: Option<u32>,
    active_days: Option<u32>,
    filters: Option<Filters>,
    fresh: Option<bool>,
) -> Result<Value, String> {
    let fresh = fresh.unwrap_or(false);
    let idle_hours = idle_hours.filter(|h| (1..=24 * 30).contains(h)).unwrap_or(DEFAULT_IDLE_HOURS);
    let active_days = active_days.filter(|d| (1..=365).contains(d)).unwrap_or(DEFAULT_ACTIVE_DAYS);
    let filters = filters.unwrap_or_default();
    let all = filters.include_excluded == Some(true);
    let (entries, mut versions, catalogs) = directory(fresh).await?;
    let now = now_ms();
    let cutoff = now - active_days as i64 * 86_400_000;

    let sessions_all = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    versions = sort_versions(versions.into_iter().chain(sessions_all.values().map(|s| s.version.clone()).filter(|v| !v.is_empty())).collect());
    let version = version
        .filter(|v| !v.trim().is_empty())
        .or_else(|| versions.first().cloned())
        .unwrap_or_else(|| format!("{VERSION_PREFIX}1"));

    if crawl_due(fresh) {
        spawn_crawl(entries.clone(), idle_hours);
    }
    start_history_ticker();

    let universe = crate::mcp::onboarding_players::snapshot();
    let (players, stats, replicants) = (&universe.players, &universe.stats, &universe.replicants);
    let is_rep = |pid: &str| universe.is_replicant(pid);
    let compared_versions: Vec<String> = if clean(&filters.compare).as_deref() == Some("version") {
        versions.iter().take(VERSIONS_COMPARED).cloned().collect()
    } else {
        vec![version.clone()]
    };
    let guild_reads = futures_util::future::join_all(entries.iter().filter_map(|e| e.guild_api.as_deref().map(|api| (e, api))).flat_map(|(e, api)| {
        compared_versions.iter().map(move |v| async move { ((e.id.clone(), v.clone()), guild_runs(&e.id, api, v, idle_hours, all, fresh).await) })
    }))
    .await;
    let runs_of: HashMap<(String, String), GuildRuns> = guild_reads.into_iter().collect();
    let runs_all = || runs_of.values().flat_map(|g| g.runs.iter());
    let version_of: HashMap<&str, &str> = sessions_all.iter().filter(|(_, s)| !s.events.is_empty()).map(|(pid, s)| (pid.as_str(), s.version.as_str())).collect();
    let interface_of: HashMap<&str, &str> = sessions_all
        .iter()
        .filter(|(_, s)| !s.events.is_empty() && !s.interface.is_empty())
        .map(|(pid, s)| (pid.as_str(), s.interface.as_str()))
        .collect();
    let mut interfaces: Vec<String> = interface_of
        .values()
        .map(|s| s.to_string())
        .chain(runs_all().map(|r| r.interface.clone()).filter(|i| !i.is_empty()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    interfaces.sort();
    interfaces.push(NO_INTERFACE.into());
    let guild_labels: Vec<(String, String)> = entries
        .iter()
        .map(|e| (e.id.clone(), if e.tag.is_empty() { if e.name.is_empty() { e.id.clone() } else { e.name.clone() } } else { e.tag.clone() }))
        .collect();
    let segs = segments(&filters, &guild_labels, &interfaces, &versions);
    let base = segments(&Filters { compare: None, ..filters.clone() }, &guild_labels, &interfaces, &versions).remove(0);
    let seg_version = |seg: &Seg| seg.version.clone().unwrap_or_else(|| version.clone());

    // The server's aggregates: every (guild, design, interface) a segment needs,
    // plus each guild unfiltered for the Guilds page.
    let with_api: Vec<&GuildApiEntry> = entries.iter().filter(|e| e.guild_api.is_some()).collect();
    // Replicants sign up from code and record no telemetry, so the servers'
    // funnel is the humans' and a replicants-only segment has none.
    let signup_guilds = |seg: &Seg| -> Option<Vec<String>> {
        if seg.active.is_some() || seg.interface.as_deref() == Some(NO_INTERFACE) || seg.replicant == Some(true) {
            return None;
        }
        Some(with_api.iter().filter(|e| seg.guild.as_ref().map_or(true, |g| *g == e.id)).map(|e| e.id.clone()).collect())
    };
    type Combo = (String, String, Option<String>);
    let mut combos: HashSet<Combo> = with_api.iter().map(|e| (e.id.clone(), version.clone(), None)).collect();
    for seg in &segs {
        for g in signup_guilds(seg).unwrap_or_default() {
            combos.insert((g, seg_version(seg), seg.interface.clone()));
        }
    }
    let combos: Vec<Combo> = combos.into_iter().collect();
    let api_of: HashMap<&str, &str> = with_api.iter().map(|e| (e.id.as_str(), e.guild_api.as_deref().unwrap_or_default())).collect();
    let aggs = futures_util::future::join_all(combos.iter().map(|(g, v, i)| {
        guild_aggregate(g, api_of.get(g.as_str()).copied().unwrap_or_default(), v, idle_hours, i.as_deref(), all, fresh)
    }))
    .await;
    let agg: HashMap<Combo, GuildAggregate> = combos.into_iter().zip(aggs).collect();

    let session_in = |seg: &Seg, pid: &str, s: &PlayerSession| -> bool {
        s.version == seg_version(seg) && !s.events.is_empty() && seg.wants(&s.guild, if s.interface.is_empty() { NO_INTERFACE } else { &s.interface }, is_active(players.get(pid), cutoff), is_rep(pid))
    };

    let run_in = |seg: &Seg, r: &Run| -> bool {
        let p = r.player.as_deref();
        r.version == seg_version(seg) && seg.wants(&r.guild, &r.interface, p.map_or(false, |p| is_active(players.get(p), cutoff)), p.map_or(false, |p| is_rep(p)))
    };

    let out_segs: Vec<Value> = segs
        .iter()
        .map(|seg| {
            // Players. Comparing designs, a design's players are those who signed up on it.
            let seg_v = seg_version(seg);
            let chain = catalogs.get(&seg_v).map(|c| c.as_slice()).unwrap_or(&[]);
            let tutorial_chain = phase_chain(chain, PHASES[1]);
            let members: Vec<(&String, &crate::mcp::onboarding_players::PlayerFacts)> = players
                .iter()
                .filter(|(pid, p)| seg.wants(&p.guild, interface_of.get(pid.as_str()).copied().unwrap_or(NO_INTERFACE), is_active(Some(p), cutoff), is_rep(pid)))
                .filter(|(pid, _)| seg.version.is_none() || version_of.get(pid.as_str()).copied() == Some(seg_v.as_str()))
                .collect();
            let active = members.iter().filter(|(_, p)| is_active(Some(p), cutoff)).count();
            // Churn is leaving: a player who never acted never arrived.
            let never_acted = members.iter().filter(|(_, p)| p.last_active_ms.is_none()).count();
            let churn_base: Vec<_> = members.iter().filter(|(_, p)| p.last_active_ms.is_some() && p.created_ms.map_or(true, |c| c <= cutoff)).collect();
            let churned = churn_base.iter().filter(|(_, p)| !is_active(Some(p), cutoff)).count();
            let milestones: Vec<_> = members.iter().map(|(pid, p)| (*p, stats.get(*pid))).collect();
            let facts: Vec<_> = members.iter().map(|(_, p)| *p).collect();
            let st: Vec<&crate::mcp::onboarding_players::PlayerStats> = members.iter().filter_map(|(pid, _)| stats.get(*pid)).collect();
            let gather = |f: &dyn Fn(&crate::mcp::onboarding_players::PlayerStats) -> Option<f64>| st.iter().filter_map(|s| f(s)).collect::<Vec<f64>>();

            // Sessions.
            let sess: Vec<(&String, &PlayerSession)> = sessions_all.iter().filter(|(pid, s)| session_in(seg, pid, s)).collect();
            let refs: Vec<&PlayerSession> = sess.iter().map(|(_, s)| *s).collect();
            let tutorial = sample_funnel(&tutorial_chain, &refs, now, idle_hours);
            let offered: Vec<&&PlayerSession> = refs.iter().filter(|s| s.reached(OFFER_STEP).is_some()).collect();
            let count = |o: &str| offered.iter().filter(|s| s.outcome(now, idle_hours) == o).count();
            let (completed, declined, left) = (count("completed"), count("declined"), count("left"));
            let ratio = |a: usize, b: usize| if b > 0 { json!(a as f64 / b as f64) } else { Value::Null };
            let play: Vec<f64> = sess
                .iter()
                .filter(|(pid, _)| !is_active(players.get(pid.as_str()), cutoff))
                .filter_map(|(pid, s)| {
                    let signed = s.reached(PLAYER_STEP)?;
                    let last = players.get(pid.as_str()).and_then(|p| p.last_active_ms).unwrap_or(signed);
                    Some(((last - signed).max(0) as f64) / 1000.0)
                })
                .collect();
            let folded = fold_sample(&sess, &HashMap::new(), now, idle_hours, 0);
            let mut dwell_next: HashMap<String, String> = tutorial_chain.iter().filter_map(|(k, _, n)| n.clone().map(|n| (k.clone(), n))).collect();
            dwell_next.extend(phase_chain(chain, PHASES[0]).into_iter().filter_map(|(k, _, n)| n.map(|n| (k, n))));
            let dwell = fold_sample(&sess, &dwell_next, now, idle_hours, 0)["dwell"].clone();

            // The server's signup funnel.
            let signup = signup_guilds(seg).map(|gs| {
                let per: Vec<(String, Vec<Value>)> = gs
                    .iter()
                    .filter_map(|g| agg.get(&(g.clone(), seg_v.clone(), seg.interface.clone())).and_then(|a| a.funnels.get(PHASES[0])).map(|f| (g.clone(), f.clone())))
                    .collect();
                let steps = merge_funnels(&per);
                let started = steps.iter().filter(|s| s["previous"].is_null() && !s["next"].is_null()).map(|s| s["reached"].as_f64().unwrap_or(0.0)).fold(0.0, f64::max);
                let signed = steps.iter().find(|s| s["key"] == PLAYER_STEP).and_then(|s| s["reached"].as_f64()).unwrap_or(0.0);
                json!({ "steps": steps, "started": started, "signed_up": signed,
                        "dropoff_rate": if started > 0.0 { json!(1.0 - signed / started) } else { Value::Null } })
            });

            // The servers' unique players, where a segment is one they can count.
            let server: Vec<&GuildAggregate> = signup_guilds(seg)
                .unwrap_or_default()
                .iter()
                .filter_map(|g| agg.get(&(g.clone(), seg_v.clone(), seg.interface.clone())))
                .collect();
            let answered = |f: &dyn Fn(&GuildAggregate) -> &Value| -> Vec<&Value> { server.iter().map(|a| f(a)).filter(|v| v.is_object()).collect() };
            let unique = sum_rows(&answered(&|a| &a.players), &PLAYER_FIELDS);
            let new_only = sum_rows(&answered(&|a| &a.new_players), &["players", "started"]);
            let player_steps = merge_player_steps(&server.iter().map(|a| &a.player_steps).collect::<Vec<_>>());
            let seg_runs: Vec<&Run> = runs_all().filter(|r| run_in(seg, r)).collect();

            json!({
                "key": seg.key, "label": seg.label,
                "players": members.len(), "active": active, "inactive": members.len() - active,
                "active_rate": ratio(active, members.len()),
                "never_acted": never_acted, "never_acted_rate": ratio(never_acted, members.len()),
                "churn_base": churn_base.len(), "churned": churned, "churn_rate": ratio(churned, churn_base.len()),
                "activation": activation(&milestones, cutoff),
                "lifecycle": lifecycle(&facts, now),
                "cohorts": cohorts(&facts, now),
                "signup": signup.unwrap_or(Value::Null),
                "tutorial_players": unique,
                "take_up": new_only,
                "player_steps": player_steps,
                "tutorial": {
                    "steps": tutorial, "offered": offered.len(), "completed": completed, "declined": declined, "left": left,
                    "playing": count("playing"), "deciding": count("deciding"),
                    "completion_rate": ratio(completed, offered.len()), "decline_rate": ratio(declined, offered.len()), "quit_rate": ratio(left, offered.len()),
                },
                "sessions": sess.len(),
                "runs": run_summary(&seg_runs),
                "run_comparison": run_comparison(&seg_runs),
                "durations": folded["durations"], "daily": folded["daily"], "dwell": dwell,
                "stats": {
                    "mined": dist(gather(&|s| s.mined_g), &GRAM_EDGES),
                    "refined": dist(gather(&|s| s.refined_g), &GRAM_EDGES),
                    "planets": dist(gather(&|s| Some(s.planets)), &COUNT_EDGES),
                    "raids_initiated": dist(gather(&|s| Some(s.raids_initiated)), &COUNT_EDGES),
                    "raids_won": dist(gather(&|s| Some(s.raids_won)), &COUNT_EDGES),
                },
                "play_length": dist(play, &PLAY_EDGES),
            })
        })
        .collect();

    let recent_sessions: Vec<(&String, &PlayerSession)> = sessions_all.iter().filter(|(pid, s)| session_in(&base, pid, s)).collect();
    let recent = fold_sample(&recent_sessions, &HashMap::new(), now, idle_hours, 30)["recent"].clone();

    let mut run_list: Vec<&Run> = runs_all().filter(|r| run_in(&base, r)).collect();
    let name_of = |p: &str| players.get(p).map(|f| f.name.clone()).filter(|n| !n.is_empty()).or_else(|| sessions_all.get(p).map(|s| s.name.clone())).unwrap_or_default();
    let stopped = who_stopped(&run_list, &recent_sessions, now, idle_hours, name_of);
    run_list.sort_by_key(|r| std::cmp::Reverse(r.started_ms));
    let runs: Vec<Value> = run_list
        .iter()
        .take(RUNS_SHOWN)
        .map(|r| {
            json!({
                "session_id": r.session,
                "player_id": r.player,
                "name": r.player.as_deref().map(name_of).unwrap_or_default(),
                "guild_id": r.guild,
                "interface": r.interface,
                "replay": r.replay,
                "new_player": r.new_player,
                "run_number": r.number,
                "started_ms": r.started_ms,
                "last_ms": r.last_ms,
                "seconds": gap(r.started_ms, r.last_ms),
                "steps": r.steps,
                "furthest": r.furthest,
                "outcome": r.outcome,
            })
        })
        .collect();

    let crawl = {
        let st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
        let u = crate::mcp::onboarding_players::UNIVERSE_CRAWL.lock().unwrap_or_else(|p| p.into_inner()).clone();
        json!({
            "running": CRAWLING.load(Ordering::SeqCst),
            "finished_ms": if st.finished_ms > 0 { json!(st.finished_ms) } else { Value::Null },
            "guilds": st.guilds,
            "players": { "known": players.len(), "ledgers": players.values().filter(|p| p.mined_g.is_some()).count(),
                         "humans": players.keys().filter(|pid| !is_rep(pid)).count(),
                         "human_ledgers": players.iter().filter(|(pid, p)| !is_rep(pid) && p.mined_g.is_some()).count(),
                         "refreshed_ms": if universe.refreshed_ms > 0 { json!(universe.refreshed_ms) } else { Value::Null }, "round": u },
            "replicants": { "known": replicants.len(), "likely": universe.likely.len(), "primaries": replicants.values().collect::<HashSet<_>>().len(),
                            "source": universe.replicants_source,
                            "read_ms": if universe.replicants_ms > 0 { json!(universe.replicants_ms) } else { Value::Null } },
        })
    };
    let guilds: Vec<Value> = entries
        .iter()
        .map(|e| {
            let a = agg.get(&(e.id.clone(), version.clone(), None));
            let signup = a.and_then(|a| a.funnels.get(PHASES[0]));
            let first = signup.map(|r| merge_funnels(&[(String::new(), r.clone())])).and_then(|m| {
                m.iter().filter(|s| s["previous"].is_null() && !s["next"].is_null()).map(|s| s["reached"].as_f64().unwrap_or(0.0)).reduce(f64::max)
            });
            let signed = signup.and_then(|r| r.iter().find(|s| text(s.get("step_key")) == PLAYER_STEP)).and_then(|s| num(s.get("reached")));
            let mine: Vec<&PlayerSession> = sessions_all.iter().filter(|(pid, s)| s.guild == e.id && !is_rep(pid)).map(|(_, s)| s).collect();
            let all: Vec<(&String, &crate::mcp::onboarding_players::PlayerFacts)> = players.iter().filter(|(_, p)| p.guild == e.id).collect();
            let members: Vec<_> = all.iter().filter(|(pid, _)| base.replicant.map_or(true, |r| r == is_rep(pid))).map(|(_, p)| *p).collect();
            let guild_runs = runs_of.get(&(e.id.clone(), version.clone()));
            let read = guild_runs.filter(|g| g.read);
            let human_runs = read.map(|g| g.runs.iter().filter(|r| base.replicant.map_or(true, |x| x == r.player.as_deref().map_or(false, |p| is_rep(p)))).count());
            json!({
                "id": e.id, "name": e.name, "tag": e.tag,
                "status": if e.guild_api.is_none() { "no_api" } else if a.and_then(|a| a.error.as_ref()).is_some() { "error" } else { "ok" },
                "error": e.error.clone().or_else(|| a.and_then(|a| a.error.clone())),
                "started": first, "signed_up": signed,
                "outcome": a.map(|a| a.outcome.clone()).unwrap_or(Value::Null),
                "runs": human_runs,
                "runs_error": guild_runs.and_then(|g| g.error.clone()),
                "no_player": read.map(|g| g.runs.iter().filter(|r| r.player.is_none()).count()),
                "tutorial_players": a.map(|a| a.players.clone()).unwrap_or(Value::Null),
                "sampled": mine.iter().filter(|s| !s.events.is_empty()).count(),
                "untracked": mine.iter().filter(|s| s.events.is_empty()).count(),
                "players": members.len(),
                "replicants": all.iter().filter(|(pid, _)| is_rep(pid)).count(),
                "active": members.iter().filter(|p| is_active(Some(p), cutoff)).count(),
            })
        })
        .collect();

    // The running totals, when every API answered for the newest design: a
    // partial sum would read as a fall in the trend.
    if versions.first() == Some(&version) {
        let all: Vec<&GuildAggregate> = with_api.iter().filter_map(|e| agg.get(&(e.id.clone(), version.clone(), None))).collect();
        if !all.is_empty() && all.iter().all(|a| a.error.is_none()) {
            let total = |key: &str| guilds.iter().filter_map(|g| g[key].as_f64()).sum::<f64>();
            let unique = |key: &str| all.iter().filter_map(|a| num(a.players.get(key))).sum::<f64>();
            crate::mcp::onboarding_history::record_server(
                crate::mcp::onboarding_history::ServerDay {
                    version: version.clone(),
                    signups_started: total("started"),
                    signed_up: total("signed_up"),
                    tutorial_players: unique("players"),
                    tutorial_completed: unique("completed"),
                },
                now,
            );
        }
    }

    Ok(json!({
        "version": version,
        "versions": versions,
        "idle_hours": idle_hours,
        "active_days": active_days,
        "generated_ms": now,
        "filters": { "interface": clean(&filters.interface), "guild": clean(&filters.guild), "activity": clean(&filters.activity),
                     "replicants": filters.replicants == Some(true), "compare": clean(&filters.compare),
                     "include_excluded": all },
        "options": { "interfaces": interfaces, "guilds": guild_labels.iter().map(|(id, l)| json!({ "id": id, "label": l })).collect::<Vec<_>>() },
        "segments": out_segs,
        "guilds": guilds,
        "recent": recent,
        "runs": runs,
        "stopped": stopped,
        "history": crate::mcp::onboarding_history::recent(HISTORY_SHOWN),
        "untracked": sessions_all.iter().filter(|(pid, s)| s.events.is_empty() && !is_rep(pid)).count(),
        "crawl": crawl,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(step: &str, kind: &str, at: &str) -> Value {
        json!({"session_id": "s", "content_version": "tutorial-4", "interface_name": "structs-webapp",
               "phase": "signup", "step_order": 1, "step_key": step, "kind": kind, "recorded_at": at})
    }

    /// The real shape: a local-mirror session (2026-10-20) up to the tutorial.
    fn mirror_rows() -> Value {
        json!([
            row("signup.connecting", "reached", "2026-10-20 19:40:53.195451+00"),
            row("signup.submit", "reached", "2026-10-20 19:41:38.58373+00"),
            row("signup.employee_record", "reached", "2026-10-20 19:42:14.020984+00"),
            row("orientation.tutorial_offer", "reached", "2026-10-20 19:43:06.133229+00"),
            row("tutorial.loading", "reached", "2026-10-20 19:43:08.682171+00"),
            row("tutorial.intro.welcome", "reached", "2026-10-20 19:43:12.541703+00"),
        ])
    }

    #[test]
    fn postgres_timestamps_parse_to_unix_ms() {
        assert_eq!(parse_ts("2026-10-20 19:40:53.195451+00"), Some(1_792_525_253_195));
        assert_eq!(parse_ts("2026-10-20T19:40:53Z"), Some(1_792_525_253_000));
        assert_eq!(parse_ts("2026-10-20 19:40:53+00:00"), Some(1_792_525_253_000));
        assert_eq!(parse_ts("yesterday"), None);
    }

    #[test]
    fn rows_fold_into_one_session_with_its_durations() {
        let s = session_from_rows("0-5", &mirror_rows());
        assert_eq!(s.version, "tutorial-4");
        assert_eq!(s.interface, "structs-webapp");
        assert_eq!(s.events.len(), 6);
        assert_eq!(gap(s.first_t(), s.reached(PLAYER_STEP)).map(|v| v.round()), Some(81.0));
        assert_eq!(gap(s.reached(SUBMIT_STEP), s.reached(PLAYER_STEP)).map(|v| v.round()), Some(35.0));
        assert_eq!(s.last_step().map(|e| e.k.as_str()), Some("tutorial.intro.welcome"));
    }

    #[test]
    fn a_later_run_stays_out_of_the_signup_session() {
        let mut rows = mirror_rows().as_array().unwrap().clone();
        for (step, at) in [("orientation.tutorial_offer", "2026-10-23 19:00:00+00"), ("tutorial.end.ftl_jump", "2026-10-23 19:10:00+00")] {
            let mut r = row(step, "reached", at);
            r["session_id"] = json!("later");
            r["interface_name"] = json!("structs-desktop");
            rows.insert(0, r);
        }
        let s = session_from_rows("0-5", &Value::Array(rows));
        assert_eq!(s.events.len(), 6);
        assert_eq!(s.interface, "structs-webapp");
        assert!(!s.completed());
        assert_eq!(gap(s.first_t(), s.last_t()).map(|v| v.round()), Some(139.0));
    }

    #[test]
    fn a_player_with_only_later_runs_has_no_signup_session() {
        let rows = json!([row("orientation.tutorial_offer", "reached", "2026-10-23 19:00:00+00")]);
        assert!(session_from_rows("0-1", &rows).events.is_empty());
    }

    fn run_row(session: &str, player: Value, version: &str, number: Value, new_player: bool, outcome: &str) -> Value {
        json!({"session_id": session, "content_version": version, "interface_name": "structs-desktop", "player_id": player,
               "new_player": new_player, "run_number": number, "started_at": "2026-11-05 03:27:00.5+00",
               "last_event_at": "2026-11-05 03:32:00.5+00", "minutes": "5.0", "steps_reached": 51,
               "furthest_step_key": "tutorial.end.ftl_jump", "outcome": outcome})
    }

    #[test]
    fn a_run_row_reads_in_the_cards_words() {
        let r = run_from_row("0-1", &run_row("a", json!("1-194"), "tutorial-4-replay", json!("2"), false, "left_during_tutorial")).unwrap();
        assert!(r.replay && !r.new_player);
        assert_eq!((r.player.as_deref(), r.number, r.outcome.as_str()), (Some("1-194"), Some(2), "left"));
        assert_eq!(gap(r.started_ms, r.last_ms), Some(300.0));
        assert_eq!(run_from_row("0-1", &run_row("b", json!(null), "tutorial-4", json!(1), true, "in_progress")).unwrap().outcome, "playing");
        assert!(run_from_row("0-1", &json!({"outcome": "completed"})).is_none());
    }

    #[test]
    fn run_counts_lead_on_players_and_keep_the_nameless_apart() {
        let rows = [
            run_row("a", json!("1-194"), "tutorial-4", json!(1), false, "completed"),
            run_row("b", json!("1-194"), "tutorial-4-replay", json!(2), false, "completed"),
            run_row("c", json!("1-13710"), "tutorial-4", json!(1), true, "left_during_tutorial"),
            run_row("d", json!(null), "tutorial-4", json!(1), true, "in_progress"),
        ];
        let runs: Vec<Run> = rows.iter().filter_map(|r| run_from_row("0-1", r)).collect();
        let s = run_summary(&runs.iter().collect::<Vec<_>>());
        assert_eq!(s, json!({"runs": 4, "players": 2, "repeat": 1, "replays": 1, "existing": 2, "no_player": 1, "completed": 2, "left": 1, "playing": 1}));
    }

    #[test]
    fn outcomes_follow_the_servers_definitions() {
        let base = session_from_rows("0-5", &mirror_rows());
        let last = base.last_t().unwrap();
        assert_eq!(base.outcome(last + 60_000, 24), "playing");
        assert_eq!(base.outcome(last + 25 * 3_600_000, 24), "left");
        let mut done = base.clone();
        done.events.push(Ev { k: FTL_STEP.into(), s: false, t: last + 1 });
        assert_eq!(done.outcome(last + 25 * 3_600_000, 24), "completed");
        let mut skip = session_from_rows("0-5", &json!([
            row("signup.employee_record", "reached", "2026-10-20 19:42:14+00"),
            row("orientation.tutorial_offer", "reached", "2026-10-20 19:43:06+00"),
            row("orientation.tutorial_offer", "skipped", "2026-10-20 19:43:30+00"),
        ]));
        assert_eq!(skip.outcome(0, 24), "declined");
        skip.events.retain(|e| !e.s);
        assert_eq!(skip.outcome(skip.last_t().unwrap() + 1000, 24), "deciding");
    }

    #[test]
    fn settled_sessions_are_never_asked_again_but_the_newest_empty_ones_are() {
        let empty = PlayerSession::default();
        assert!(is_settled(&empty, false, 0, 24));
        assert!(!is_settled(&empty, true, 0, 24), "a brand-new player may not have flushed yet");
        let s = session_from_rows("0-5", &mirror_rows());
        let last = s.last_t().unwrap();
        assert!(!is_settled(&s, false, last + 1000, 24), "still in the tutorial");
        assert!(is_settled(&s, false, last + 25 * 3_600_000, 24), "idle past the window");
    }

    #[test]
    fn the_crawl_asks_newest_first_above_the_floor_and_skips_the_team_and_the_settled() {
        let roster: Vec<(String, String)> = [("1-5000", "old"), ("1-6000", "a"), ("1-9000", "b"), ("1-8000", "team"), ("1-7000", "done"), ("2-9999", "planet")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let mut cached = HashMap::new();
        cached.insert("1-7000".to_string(), PlayerSession { settled: true, ..Default::default() });
        let plan = crawl_plan(&roster, |id| id == "1-8000", |_| false, &cached);
        assert_eq!(plan.todo.iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), vec!["1-9000", "1-6000"]);
        assert_eq!(plan.team, 1);
        assert_eq!(plan.candidates, 4);
        assert!(plan.newest.contains("1-9000") && plan.newest.contains("1-7000"));
        let plan = crawl_plan(&roster, |id| id == "1-8000", |id| id == "1-9000", &cached);
        assert_eq!(plan.todo.iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), vec!["1-6000"], "replicants have no telemetry to read");
        assert_eq!(plan.replicants, 1);
    }

    #[test]
    fn funnels_sum_across_guilds_and_retention_is_against_the_summed_first_step() {
        let a = vec![
            json!({"step_order": 0, "step_key": "signup.recovery_key_faq", "previous_step_key": null, "next_step_key": null, "reached": 3, "skipped": 0, "dropped": null}),
            json!({"step_order": 1, "step_key": "signup.connecting", "previous_step_key": null, "next_step_key": "signup.connected", "reached": 10, "skipped": 0, "dropped": 2}),
            json!({"step_order": 2, "step_key": "signup.connected", "previous_step_key": "signup.connecting", "next_step_key": null, "reached": 8, "skipped": 1, "dropped": null}),
        ];
        let b = vec![
            json!({"step_order": 1, "step_key": "signup.connecting", "previous_step_key": null, "next_step_key": "signup.connected", "reached": "30", "skipped": 0, "dropped": 5}),
            json!({"step_order": 2, "step_key": "signup.connected", "previous_step_key": "signup.connecting", "next_step_key": null, "reached": 15, "skipped": 0, "dropped": null}),
        ];
        let m = merge_funnels(&[("0-1".into(), a), ("0-5".into(), b)]);
        assert_eq!(m.iter().map(|s| s["key"].as_str().unwrap()).collect::<Vec<_>>(), vec!["signup.recovery_key_faq", "signup.connecting", "signup.connected"]);
        assert_eq!(m[1]["reached"], json!(40.0));
        assert_eq!(m[1]["dropped"], json!(7.0));
        assert_eq!(m[2]["dropped"], Value::Null, "the last step has no drop figure, never a zero");
        assert_eq!(m[2]["retained"], json!(23.0 / 40.0));
        assert_eq!(m[0]["retained"], json!(3.0 / 40.0), "the off-line FAQ is not the first step");
        assert_eq!(m[1]["by_guild"]["0-5"], json!(30.0));
    }

    #[test]
    fn the_sample_folds_into_durations_dwell_and_daily_cohorts() {
        let a = session_from_rows("0-5", &mirror_rows());
        let mut b = a.clone();
        b.events.push(Ev { k: FTL_STEP.into(), s: false, t: a.last_t().unwrap() + 600_000 });
        let (ia, ib) = ("1-6001".to_string(), "1-6002".to_string());
        let sessions = vec![(&ia, &a), (&ib, &b)];
        let next: HashMap<String, String> = [("signup.submit", "signup.employee_record"), ("tutorial.loading", "tutorial.intro.welcome")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let now = a.last_t().unwrap() + 48 * 3_600_000;
        let f = fold_sample(&sessions, &next, now, 24, 10);
        assert_eq!(f["sessions"], json!(2));
        assert_eq!(f["durations"]["signup"]["n"], json!(2));
        assert_eq!(f["durations"]["tutorial"]["n"], json!(1));
        assert_eq!(f["dwell"]["signup.submit"]["n"], json!(2));
        assert_eq!(f["outcomes"]["completed"], json!(1));
        assert_eq!(f["outcomes"]["left"], json!(1));
        assert_eq!(f["stopped"]["tutorial.intro.welcome"], json!(1));
        assert_eq!(f["daily"][0]["day"], json!("2026-10-20"));
        assert_eq!(f["daily"][0]["completed"], json!(1));
        assert_eq!(f["recent"][0]["player_id"], json!("1-6002"), "most recent activity first");
    }

    fn catalog() -> Vec<Value> {
        [("tutorial", 1, "orientation.tutorial_offer", ""), ("tutorial", 2, "tutorial.loading", "orientation.tutorial_offer"),
         ("tutorial", 3, "tutorial.end.ftl_jump", "tutorial.loading"), ("signup", 12, "signup.employee_record", "signup.submit")]
            .iter()
            .map(|(p, o, k, prev)| json!({"phase": p, "step_order": o, "step_key": k, "previous_step_key": if prev.is_empty() { Value::Null } else { json!(prev) }}))
            .collect()
    }

    fn sess(steps: &[(&str, bool, i64)]) -> PlayerSession {
        PlayerSession { guild: "0-5".into(), version: "tutorial-4".into(), interface: "structs-webapp".into(),
            events: steps.iter().map(|(k, s, t)| Ev { k: k.to_string(), s: *s, t: *t }).collect(), ..Default::default() }
    }

    #[test]
    fn the_tutorial_funnel_counts_a_skip_as_a_skip_not_a_quit() {
        let chain = phase_chain(&catalog(), "tutorial");
        assert_eq!(chain.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec![OFFER_STEP, LOADING_STEP, FTL_STEP]);
        assert_eq!(chain[0].2.as_deref(), Some(LOADING_STEP));
        let done = sess(&[(OFFER_STEP, false, 0), (LOADING_STEP, false, 1), (FTL_STEP, false, 2)]);
        let skip = sess(&[(OFFER_STEP, false, 0), (OFFER_STEP, true, 1)]);
        let quit = sess(&[(OFFER_STEP, false, 0), (LOADING_STEP, false, 1)]);
        let fresh = sess(&[(OFFER_STEP, false, 0)]);
        let now = 2 * 86_400_000;
        let mut late = fresh.clone();
        late.events[0].t = now - 1000;
        let f = sample_funnel(&chain, &[&done, &skip, &quit, &late], now, 24);
        assert_eq!(f[0]["reached"], json!(4.0));
        assert_eq!(f[0]["skipped"], json!(1.0));
        assert_eq!(f[0]["dropped"], json!(0.0), "the skipper is not a quit, and the one still deciding is not idle");
        assert_eq!(f[0]["skip_rate"], json!(0.25));
        assert_eq!(f[1]["dropped"], json!(1.0));
        assert_eq!(f[1]["step_drop"], json!(0.5));
        assert_eq!(f[1]["lost"], json!(0.5), "cumulative: half the players offered never got past loading");
        assert_eq!(f[1]["cum_skip"], json!(0.25));
        assert_eq!(f[2]["dropped"], Value::Null, "the last step has no quit figure");
        assert_eq!(f[2]["retained"], json!(0.25));
    }

    #[test]
    fn segments_split_one_dimension_within_the_filter() {
        let guilds = vec![("0-1".to_string(), "OH".to_string()), ("0-5".to_string(), "SN.C".to_string())];
        let ifaces = vec!["structs-webapp".to_string(), NO_INTERFACE.to_string()];
        let vers = vec!["tutorial-4".to_string(), "tutorial-3".to_string()];
        let one = segments(&Filters { guild: Some("0-5".into()), activity: Some("active".into()), ..Default::default() }, &guilds, &ifaces, &vers);
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].guild.as_deref(), one[0].active), (Some("0-5"), Some(true)));
        let by_iface = segments(&Filters { compare: Some("interface".into()), guild: Some("0-5".into()), ..Default::default() }, &guilds, &ifaces, &vers);
        assert_eq!(by_iface.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), vec!["structs-webapp", "none"]);
        assert!(by_iface.iter().all(|s| s.guild.as_deref() == Some("0-5")), "the filter still applies to every segment");
        let by_guild = segments(&Filters { compare: Some("guild".into()), guild: Some("0-1".into()), ..Default::default() }, &guilds, &ifaces, &vers);
        assert_eq!(by_guild.len(), 1, "comparing within a filtered dimension leaves its one value");
        let by_act = segments(&Filters { compare: Some("activity".into()), ..Default::default() }, &guilds, &ifaces, &vers);
        assert_eq!(by_act.iter().map(|s| s.active).collect::<Vec<_>>(), vec![Some(true), Some(false)]);
        assert!(by_act[0].wants("0-9", "x", true, false) && !by_act[0].wants("0-9", "x", false, false));
        assert!(!one[0].wants("0-5", "x", true, true), "humans only unless replicants are asked for");
        let with = segments(&Filters { replicants: Some(true), ..Default::default() }, &guilds, &ifaces, &vers);
        assert!(with[0].wants("0-5", "x", true, true) && with[0].wants("0-5", "x", true, false));
        let by_ver = segments(&Filters { compare: Some("version".into()), ..Default::default() }, &guilds, &ifaces, &vers);
        assert_eq!(by_ver.iter().map(|s| s.version.as_deref()).collect::<Vec<_>>(), vec![Some("tutorial-4"), Some("tutorial-3")]);
        let by_rep = segments(&Filters { compare: Some("replicant".into()), ..Default::default() }, &guilds, &ifaces, &vers);
        assert_eq!(by_rep.iter().map(|s| (s.key.as_str(), s.replicant)).collect::<Vec<_>>(), vec![("human", Some(false)), ("replicant", Some(true))],
            "comparing them shows both even with the box unchecked");
    }

    fn run(player: Option<&str>, session: &str, number: u32, outcome: &str, start: i64, last: i64, furthest: &str) -> Run {
        Run { guild: "0-1".into(), session: session.into(), version: "tutorial-4".into(), player: player.map(String::from), number: Some(number),
              outcome: outcome.into(), started_ms: Some(start), last_ms: Some(last), steps: Some(10.0), furthest: Some(furthest.into()), ..Default::default() }
    }

    #[test]
    fn runs_compare_by_run_number_with_later_runs_together() {
        let rs = vec![
            run(Some("1-1"), "a", 1, "left", 0, 60_000, "tutorial.x"),
            run(Some("1-1"), "b", 2, "completed", 3_600_000, 3_660_000, "tutorial.end.ftl_jump"),
            run(Some("1-2"), "c", 1, "completed", 0, 120_000, "tutorial.end.ftl_jump"),
            run(Some("1-1"), "d", 3, "playing", 7_200_000, 7_210_000, "tutorial.x"),
            run(Some("1-1"), "e", 4, "left", 9_000_000, 9_010_000, "tutorial.x"),
        ];
        let refs: Vec<&Run> = rs.iter().collect();
        let c = run_comparison(&refs);
        assert_eq!(c.iter().map(|r| r["run"].as_str().unwrap()).collect::<Vec<_>>(), vec!["1", "2", "3+"]);
        assert_eq!((c[0]["runs"].as_u64(), c[0]["completed"].as_u64(), c[0]["completion_rate"].as_f64()), (Some(2), Some(1), Some(0.5)));
        assert_eq!(c[0]["time"]["p50"].as_f64(), Some(120.0), "time only counts finished runs");
        assert_eq!(c[1]["since_previous"]["p50"].as_f64(), Some(3_600.0));
        assert_eq!(c[2]["runs"].as_u64(), Some(2));
        assert!(run_comparison(&[]).is_empty());
    }

    #[test]
    fn stopped_lists_the_people_behind_a_step_once_each_newest_first() {
        let rs = vec![
            run(Some("1-1"), "a", 1, "left", 0, 100, "tutorial.x"),
            run(Some("1-1"), "b", 2, "left", 0, 200, "tutorial.x"),
            run(Some("1-2"), "c", 1, "left", 0, 300, "tutorial.x"),
            run(Some("1-3"), "d", 1, "completed", 0, 400, "tutorial.x"),
            run(None, "e", 1, "left", 0, 500, "tutorial.x"),
        ];
        let refs: Vec<&Run> = rs.iter().collect();
        let (id, s) = ("1-4".to_string(), sess(&[("signup.employee_record", false, 0), ("tutorial.y", false, 1_000)]));
        let w = who_stopped(&refs, &[(&id, &s)], 100 * 3_600_000, 24, |p| format!("n{p}"));
        assert_eq!(w["tutorial.x"]["total"].as_u64(), Some(2), "a player counts once, a finisher and an unknown not at all");
        assert_eq!(w["tutorial.x"]["players"][0]["player_id"], json!("1-2"));
        assert_eq!(w["tutorial.x"]["players"][0]["name"], json!("n1-2"));
        assert_eq!(w["tutorial.y"]["players"][0]["player_id"], json!("1-4"), "a signup session that quit");
    }

    #[test]
    fn server_answers_sum_and_a_guild_without_the_route_is_no_answer() {
        assert_eq!(sum_rows(&[], &PLAYER_FIELDS), Value::Null);
        let (a, b) = (json!({"players": "3", "completed": 1}), json!({"players": 4, "completed": "2"}));
        let s = sum_rows(&[&a, &b], &PLAYER_FIELDS);
        assert_eq!((s["players"].as_f64(), s["completed"].as_f64(), s["revisited"].as_f64()), (Some(7.0), Some(3.0), Some(0.0)));
        let g1 = vec![json!({"step_order": 1, "step_key": "tutorial.a", "reached": "4", "furthest": "1"}), json!({"step_order": 2, "step_key": "tutorial.b", "reached": 3, "furthest": 3})];
        let g2 = vec![json!({"step_order": 1, "step_key": "tutorial.a", "reached": 6, "furthest": 5}), json!({"step_order": 2, "step_key": "tutorial.b", "reached": 1, "furthest": 1})];
        let m = merge_player_steps(&[&g1, &g2]);
        assert_eq!(m.iter().map(|r| r["key"].as_str().unwrap()).collect::<Vec<_>>(), vec!["tutorial.a", "tutorial.b"]);
        assert_eq!((m[0]["reached"].as_f64(), m[0]["retained"].as_f64()), (Some(10.0), Some(1.0)));
        assert_eq!((m[1]["furthest"].as_f64(), m[1]["retained"].as_f64()), (Some(4.0), Some(0.4)));
    }

    #[test]
    fn lifecycle_buckets_sum_to_the_players() {
        use crate::mcp::onboarding_players::PlayerFacts;
        let now = 100 * DAY_MS;
        let at = |days: i64| PlayerFacts { last_active_ms: Some(now - days * DAY_MS), created_ms: Some(0), ..Default::default() };
        let (a, b, c, e) = (at(0), at(3), at(20), at(90));
        let never = PlayerFacts { created_ms: Some(now - DAY_MS), ..Default::default() };
        let l = lifecycle(&[&a, &b, &c, &e, &never], now);
        assert_eq!(l, json!({ "today": 1, "week": 1, "month": 1, "gone": 1, "never": 1, "new_7d": 1 }));
    }

    #[test]
    fn a_cohort_counts_only_weeks_its_newest_member_has_lived() {
        use crate::mcp::onboarding_players::PlayerFacts;
        // Monday 2026-01-05 and the Friday after: one ISO week.
        let monday = 1_767_571_200_000;
        let stayed = PlayerFacts { created_ms: Some(monday), last_active_ms: Some(monday + 15 * DAY_MS), ..Default::default() };
        let left = PlayerFacts { created_ms: Some(monday + 4 * DAY_MS), last_active_ms: Some(monday + 4 * DAY_MS), ..Default::default() };
        let never = PlayerFacts { created_ms: Some(monday), ..Default::default() };
        let unknown = PlayerFacts::default();
        let rows = cohorts(&[&stayed, &left, &never, &unknown], monday + 19 * DAY_MS);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], json!({ "week": "W02", "year": 2026, "n": 3, "acted": 2, "alive": [1, 1] }));
    }

    #[test]
    fn activation_counts_each_milestone_against_everyone() {
        use crate::mcp::onboarding_players::{PlayerFacts, PlayerStats};
        let acted = PlayerFacts { last_active_ms: Some(500), ..Default::default() };
        let idle = PlayerFacts { last_active_ms: Some(50), ..Default::default() };
        let never = PlayerFacts::default();
        let miner = PlayerStats { mined_g: Some(3.0), planets: 1.0, ..Default::default() };
        let rows = vec![(&acted, Some(&miner)), (&idle, None), (&never, None), (&never, None)];
        let a = activation(&rows, 100);
        let n = |k: &str| a.iter().find(|r| r["key"] == k).unwrap()["n"].as_u64().unwrap();
        assert_eq!((n("signed_up"), n("acted"), n("mined"), n("refined"), n("planet"), n("raided"), n("active")), (4, 2, 1, 0, 1, 0, 1));
        assert_eq!(a[1]["rate"].as_f64(), Some(0.5));
    }

    #[test]
    fn distributions_bucket_by_decade_with_zero_apart() {
        let d = dist(vec![0.0, 0.0, 3.0, 12.0, 150.0, f64::NAN], &COUNT_EDGES);
        assert_eq!(d["n"], json!(5));
        assert_eq!(d["zero"], json!(2));
        assert_eq!(d["p50"], json!(3.0));
        assert_eq!(d["max"], json!(150.0));
        let h: Vec<u64> = d["hist"].as_array().unwrap().iter().map(|b| b["n"].as_u64().unwrap()).collect();
        assert_eq!(h, vec![2, 1, 1, 1, 0, 0, 0]);
        assert_eq!(d["hist"][6]["hi"], Value::Null, "the last bucket is open-ended");
        assert_eq!(dist(vec![], &COUNT_EDGES)["n"], json!(0));
    }

    #[test]
    fn spread_is_null_when_nothing_was_measured() {
        assert_eq!(spread(vec![]), Value::Null);
        let s = spread(vec![10.0, 1.0, 5.0]);
        assert_eq!(s["p50"], json!(5.0));
        assert_eq!(s["p90"], json!(10.0));
    }

    #[test]
    fn versions_sort_newest_design_first() {
        assert_eq!(sort_versions(vec!["tutorial-2".into(), "tutorial-10".into(), "tutorial-4".into(), "tutorial-4".into()]), vec!["tutorial-10", "tutorial-4", "tutorial-2"]);
    }

    /// Live: every guild on chain, with the API it publishes (no login needed).
    /// `cargo test --bin structs-app -- --ignored live_guild_api_directory`
    #[tokio::test]
    #[ignore]
    async fn live_guild_api_directory() {
        let d = crate::guild_directory::guild_api_directory().await.expect("directory");
        eprintln!("{}", serde_json::to_string_pretty(&d).unwrap());
        assert!(d.iter().any(|e| e.guild_api.is_some()), "no guild publishes an API");
    }

    /// Live: each guild's login accepts a signature for OUR guild id and gets
    /// as far as the address lookup — a throwaway key is refused only there
    /// (`player_address_does_not_exists`), never at the signature.
    /// `cargo test --bin structs-app -- --ignored live_foreign_login_reaches_the_address_lookup`
    #[tokio::test]
    #[ignore]
    async fn live_foreign_login_reaches_the_address_lookup() {
        use cosmrs::crypto::secp256k1::SigningKey;
        let key = SigningKey::random();
        let address = key.public_key().account_id("structs").unwrap().to_string();
        for e in crate::guild_directory::guild_api_directory().await.expect("directory") {
            let Some(api) = e.guild_api else { continue };
            let c = client_for(&api);
            let ts = c.get_public("/api/timestamp").await.expect("timestamp");
            let ts = ts.get("unix_timestamp").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap();
            let msg = crate::mcp::guild_auth::login_message("0-1", &address, &ts);
            let body = json!({"address": address, "signature": hex::encode(key.sign(msg.as_bytes()).unwrap().to_bytes()),
                "pubkey": hex::encode(key.public_key().to_bytes()), "guild_id": "0-1", "unix_timestamp": ts});
            let r = c.post_public("/api/auth/login", &body).await;
            eprintln!("{} {api}: {r:?}", e.id);
            let r = r.err().unwrap_or_default();
            assert!(r.contains("player_address_does_not_exists"), "{}: refused before the address lookup: {r}", e.id);
        }
    }

    /// Live: every guild with an API answers the aggregate routes for us.
    /// `cargo test --bin structs-app -- --ignored live_onboarding`
    #[tokio::test]
    #[ignore]
    async fn live_onboarding_aggregates() {
        let v = terminal_onboarding(None, None, None, None, Some(true)).await.expect("read");
        eprintln!("{}", serde_json::to_string_pretty(&json!({"guilds": v["guilds"], "outcome": v["outcome"], "versions": v["versions"]})).unwrap());
    }
}
