//! Onboarding telemetry across every guild — the read behind the Terminal's
//! `onboarding` card (⌘K → ONBOARDING · TELEMETRY · FUNNEL · TUTORIAL).
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
//! ## Two tiers
//!
//! | tier | route | covers | gives |
//! |---|---|---|---|
//! | aggregate | `/api/onboarding/funnel/{v}/{phase}`, `/tutorial/outcome/{v}` | EVERY session, incl. ones that quit before signup finished | reached / skipped / dropped per step, outcome counts |
//! | sample | `/api/onboarding/player/{id}` | sessions whose signup FINISHED (only `signup.employee_record` carries a player id) | timestamps: durations, dwell per step, daily cohorts |
//!
//! No route serves timings in bulk, so the sample is a crawl over each
//! guild's roster, newest first, of players created after the telemetry
//! existed (`TELEMETRY_FLOOR_INDEX`). A finished session never changes, so
//! it is fetched once and kept in `cache/onboarding_players.json`; only
//! sessions still in progress are asked again. Our own replicants are skipped:
//! they are created through the MCP, never through the signup screens.
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
/// Per guild per crawl. A first crawl of a busy guild takes a few rounds.
const CRAWL_BUDGET: usize = 1_500;
const CRAWL_CONCURRENCY: usize = 6;
/// A guild whose reads keep failing is left for the next crawl.
const CRAWL_MAX_ERRORS: usize = 20;
/// The newest players may not have flushed their last batch yet: an empty
/// answer for them is asked again next crawl rather than believed.
const UNSETTLED_NEWEST: usize = 20;

const DIRECTORY_TTL: Duration = Duration::from_secs(30 * 60);
const AGGREGATE_TTL: Duration = Duration::from_secs(120);
const CRAWL_GAP: Duration = Duration::from_secs(180);
const CACHE_NAME: &str = "onboarding_players";

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

/// Fold `/api/onboarding/player/{id}` rows into one session.
pub fn session_from_rows(guild: &str, rows: &Value) -> PlayerSession {
    let mut s = PlayerSession { guild: guild.to_string(), ..Default::default() };
    for r in rows.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
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

async fn probe_versions(entries: &[GuildApiEntry]) -> Vec<String> {
    let mut asks = Vec::new();
    for e in entries {
        let Some(api) = e.guild_api.clone() else { continue };
        for n in 1..=VERSION_PROBE_MAX {
            let api = api.clone();
            asks.push(async move {
                let v = format!("{VERSION_PREFIX}{n}");
                match client_for(&api).onboarding_catalog(&v).await {
                    Ok(Value::Array(a)) if !a.is_empty() => Some(v),
                    _ => None,
                }
            });
        }
    }
    let found: Vec<String> = futures_util::future::join_all(asks).await.into_iter().flatten().collect();
    sort_versions(found)
}

async fn directory(fresh: bool) -> Result<(Vec<GuildApiEntry>, Vec<String>), String> {
    let mut g = DIRECTORY.lock().await;
    if let Some(d) = g.as_ref() {
        if !fresh && d.at.elapsed() < DIRECTORY_TTL {
            return Ok((d.entries.clone(), d.versions.clone()));
        }
    }
    let entries = crate::guild_directory::guild_api_directory().await?;
    let versions = probe_versions(&entries).await;
    *g = Some(Directory { at: Instant::now(), entries: entries.clone(), versions: versions.clone() });
    Ok((entries, versions))
}

// ── Aggregates (every session, every guild) ─────────────────────────────────

#[derive(Clone)]
struct GuildAggregate {
    funnels: BTreeMap<String, Vec<Value>>,
    outcome: Value,
    error: Option<String>,
}

static AGGREGATES: LazyLock<Mutex<HashMap<(String, String, u32), (Instant, GuildAggregate)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn missing_route(e: &str) -> bool {
    e.starts_with("Guild API 404 ")
}

async fn guild_aggregate(guild: &str, api: &str, version: &str, idle_hours: u32, fresh: bool) -> GuildAggregate {
    let key = (guild.to_string(), version.to_string(), idle_hours);
    if !fresh {
        if let Some((at, a)) = AGGREGATES.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if at.elapsed() < AGGREGATE_TTL {
                return a.clone();
            }
        }
    }
    let c = client_for(api);
    let (signup, tutorial, outcome) = tokio::join!(
        c.onboarding_funnel(version, PHASES[0], idle_hours),
        c.onboarding_funnel(version, PHASES[1], idle_hours),
        c.onboarding_tutorial_outcome(version, idle_hours),
    );
    let mut a = GuildAggregate { funnels: BTreeMap::new(), outcome: Value::Null, error: None };
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
    let first = out
        .iter()
        .filter(|s| s["previous"].is_null() && !s["next"].is_null())
        .map(|s| s["reached"].as_f64().unwrap_or(0.0))
        .fold(0.0, f64::max);
    for s in out.iter_mut() {
        let r = s["reached"].as_f64().unwrap_or(0.0);
        s["retained"] = if first > 0.0 { json!(r / first) } else { Value::Null };
    }
    out
}

fn outcome_sum(outcomes: &[Value]) -> Value {
    let mut t: BTreeMap<&str, f64> = BTreeMap::new();
    for k in ["offered", "completed", "declined", "left_during_tutorial", "in_progress"] {
        t.insert(k, outcomes.iter().filter_map(|o| num(o.get(k))).sum());
    }
    json!(t)
}

// ── The crawl ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
struct GuildCrawl {
    candidates: usize,
    team_skipped: usize,
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

/// Which roster players to ask, newest first: (to fetch, newest set, team skipped, candidates).
pub fn crawl_plan(
    roster: &[(String, String)],
    is_team: impl Fn(&str) -> bool,
    cached: &HashMap<String, PlayerSession>,
) -> (Vec<(String, String)>, HashSet<String>, usize, usize) {
    let mut cands: Vec<(u64, &String, &String)> = roster
        .iter()
        .filter_map(|(id, name)| player_index(id).filter(|i| *i >= TELEMETRY_FLOOR_INDEX).map(|i| (i, id, name)))
        .collect();
    cands.sort_by(|a, b| b.0.cmp(&a.0));
    let total = cands.len();
    let mut team = 0;
    let mut todo = Vec::new();
    let mut newest = HashSet::new();
    for (_, id, name) in cands {
        if is_team(id) {
            team += 1;
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
    (todo, newest, team, total)
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
    let (todo, newest, team, total) = crawl_plan(&roster, crate::mcp::virtual_players::is_team_player, &cached);
    {
        let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
        let g = st.guilds.entry(guild.clone()).or_default();
        *g = GuildCrawl { candidates: total, team_skipped: team, ..Default::default() };
    }
    let mut results = futures_util::stream::iter(todo.into_iter().map(|(pid, name)| {
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

fn spawn_crawl(entries: Vec<GuildApiEntry>, idle_hours: u32) {
    if CRAWLING.swap(true, Ordering::SeqCst) {
        return;
    }
    CRAWL.lock().unwrap_or_else(|p| p.into_inner()).started = Some(Instant::now());
    tauri::async_runtime::spawn(async move {
        let jobs = entries
            .into_iter()
            .filter_map(|e| e.guild_api.map(|api| crawl_guild(e.id, api, idle_hours)));
        futures_util::future::join_all(jobs).await;
        let snapshot = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).clone();
        crate::mcp::cache_store::save_in_background(CACHE_NAME, snapshot);
        {
            let mut st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
            st.finished = Some(Instant::now());
            st.finished_ms = now_ms();
        }
        CRAWLING.store(false, Ordering::SeqCst);
    });
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

// ── The read ────────────────────────────────────────────────────────────────

/// The onboarding dashboard for one content version (default: the newest any
/// guild has a catalog for). Starts or continues the per-player crawl in the
/// background and answers with whatever the sample holds so far.
#[tauri::command]
pub async fn terminal_onboarding(version: Option<String>, idle_hours: Option<u32>, fresh: Option<bool>) -> Result<Value, String> {
    let fresh = fresh.unwrap_or(false);
    let idle_hours = idle_hours.filter(|h| (1..=24 * 30).contains(h)).unwrap_or(DEFAULT_IDLE_HOURS);
    let (entries, mut versions) = directory(fresh).await?;
    {
        let cached = PLAYERS.lock().unwrap_or_else(|p| p.into_inner());
        let seen: Vec<String> = cached.values().map(|s| s.version.clone()).filter(|v| !v.is_empty()).collect();
        versions = sort_versions(versions.into_iter().chain(seen).collect());
    }
    let version = version
        .filter(|v| !v.trim().is_empty())
        .or_else(|| versions.first().cloned())
        .unwrap_or_else(|| format!("{VERSION_PREFIX}1"));

    let with_api: Vec<&GuildApiEntry> = entries.iter().filter(|e| e.guild_api.is_some()).collect();
    let aggs = futures_util::future::join_all(with_api.iter().map(|e| {
        guild_aggregate(&e.id, e.guild_api.as_deref().unwrap_or_default(), &version, idle_hours, fresh)
    }))
    .await;
    let by_id: HashMap<&str, &GuildAggregate> = with_api.iter().map(|e| e.id.as_str()).zip(aggs.iter()).collect();

    if crawl_due(fresh) {
        spawn_crawl(entries.clone(), idle_hours);
    }

    let mut phases = serde_json::Map::new();
    let mut next: HashMap<String, String> = HashMap::new();
    for phase in PHASES {
        let per: Vec<(String, Vec<Value>)> = with_api
            .iter()
            .filter_map(|e| by_id.get(e.id.as_str()).and_then(|a| a.funnels.get(phase)).map(|f| (e.id.clone(), f.clone())))
            .collect();
        let merged = merge_funnels(&per);
        for s in &merged {
            if let (Some(k), Some(n)) = (s["key"].as_str(), s["next"].as_str()) {
                next.insert(k.to_string(), n.to_string());
            }
        }
        phases.insert(phase.to_string(), Value::Array(merged));
    }
    let outcome = outcome_sum(&aggs.iter().map(|a| a.outcome.clone()).collect::<Vec<_>>());

    let first_reached = |rows: Option<&Vec<Value>>| -> f64 {
        rows.map(|r| merge_funnels(&[(String::new(), r.clone())]))
            .and_then(|m| m.iter().filter(|s| s["previous"].is_null() && !s["next"].is_null()).map(|s| s["reached"].as_f64().unwrap_or(0.0)).reduce(f64::max))
            .unwrap_or(0.0)
    };
    let step_reached = |rows: Option<&Vec<Value>>, key: &str| -> f64 {
        rows.and_then(|r| r.iter().find(|s| text(s.get("step_key")) == key)).and_then(|s| num(s.get("reached"))).unwrap_or(0.0)
    };

    let now = now_ms();
    let cached = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let crawl = {
        let st = CRAWL.lock().unwrap_or_else(|p| p.into_inner());
        json!({
            "running": CRAWLING.load(Ordering::SeqCst),
            "finished_ms": if st.finished_ms > 0 { json!(st.finished_ms) } else { Value::Null },
            "guilds": st.guilds,
        })
    };
    let guilds: Vec<Value> = entries
        .iter()
        .map(|e| {
            let a = by_id.get(e.id.as_str());
            let signup = a.and_then(|a| a.funnels.get(PHASES[0]));
            let mine: Vec<&PlayerSession> = cached.values().filter(|s| s.guild == e.id).collect();
            json!({
                "id": e.id, "name": e.name, "tag": e.tag,
                "status": if e.guild_api.is_none() { "no_api" } else if a.and_then(|a| a.error.as_ref()).is_some() { "error" } else { "ok" },
                "error": e.error.clone().or_else(|| a.and_then(|a| a.error.clone())),
                "started": first_reached(signup),
                "signed_up": step_reached(signup, PLAYER_STEP),
                "outcome": a.map(|a| a.outcome.clone()).unwrap_or(Value::Null),
                "sampled": mine.iter().filter(|s| !s.events.is_empty()).count(),
                "untracked": mine.iter().filter(|s| s.events.is_empty()).count(),
            })
        })
        .collect();

    let sample: Vec<(&String, &PlayerSession)> = cached.iter().filter(|(_, s)| s.version == version).collect();
    let folded = fold_sample(&sample, &next, now, idle_hours, 30);

    Ok(json!({
        "version": version,
        "versions": versions,
        "idle_hours": idle_hours,
        "generated_ms": now,
        "guilds": guilds,
        "phases": phases,
        "outcome": outcome,
        "sample": folded,
        "untracked": cached.values().filter(|s| s.events.is_empty()).count(),
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
        let (todo, newest, team, total) = crawl_plan(&roster, |id| id == "1-8000", &cached);
        assert_eq!(todo.iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), vec!["1-9000", "1-6000"]);
        assert_eq!(team, 1);
        assert_eq!(total, 4);
        assert!(newest.contains("1-9000") && newest.contains("1-7000"));
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
        let v = terminal_onboarding(None, None, Some(true)).await.expect("read");
        eprintln!("{}", serde_json::to_string_pretty(&json!({"guilds": v["guilds"], "outcome": v["outcome"], "versions": v["versions"]})).unwrap());
    }
}
