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
    error: Option<String>,
}

type AggregateKey = (String, String, u32, Option<String>);
static AGGREGATES: LazyLock<Mutex<HashMap<AggregateKey, (Instant, GuildAggregate)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn missing_route(e: &str) -> bool {
    e.starts_with("Guild API 404 ")
}

async fn guild_aggregate(guild: &str, api: &str, version: &str, idle_hours: u32, interface: Option<&str>, fresh: bool) -> GuildAggregate {
    let key = (guild.to_string(), version.to_string(), idle_hours, interface.map(String::from));
    if !fresh {
        if let Some((at, a)) = AGGREGATES.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if at.elapsed() < AGGREGATE_TTL {
                return a.clone();
            }
        }
    }
    let c = client_for(api);
    let (signup, tutorial, outcome) = tokio::join!(
        c.onboarding_funnel(version, PHASES[0], idle_hours, interface),
        c.onboarding_funnel(version, PHASES[1], idle_hours, interface),
        c.onboarding_tutorial_outcome(version, idle_hours, interface),
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
        *g = GuildCrawl { candidates: plan.candidates, team_skipped: plan.team, replicants_skipped: plan.replicants, ..Default::default() };
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
        let jobs = entries
            .into_iter()
            .filter_map(|e| e.guild_api.map(|api| crawl_guild(e.id, api, idle_hours)));
        // Each guild's sessions, and the chain-wide player tables from ours.
        tokio::join!(futures_util::future::join_all(jobs), crate::mcp::onboarding_players::crawl(replicants_error));
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
    /// `interface` | `guild` | `activity` | `replicant`
    #[serde(default)]
    pub compare: Option<String>,
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
pub fn segments(f: &Filters, guilds: &[(String, String)], interfaces: &[String]) -> Vec<Seg> {
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
    let (entries, mut versions, catalogs) = directory(fresh).await?;
    let now = now_ms();
    let cutoff = now - active_days as i64 * 86_400_000;

    let sessions_all = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    versions = sort_versions(versions.into_iter().chain(sessions_all.values().map(|s| s.version.clone()).filter(|v| !v.is_empty())).collect());
    let version = version
        .filter(|v| !v.trim().is_empty())
        .or_else(|| versions.first().cloned())
        .unwrap_or_else(|| format!("{VERSION_PREFIX}1"));
    let catalog = catalogs.get(&version).cloned().unwrap_or_default();

    if crawl_due(fresh) {
        spawn_crawl(entries.clone(), idle_hours);
    }

    let (players, stats, refreshed_ms, replicants, replicants_ms) = {
        let u = crate::mcp::onboarding_players::UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
        (u.players.clone(), u.stats(), u.refreshed_ms, u.replicants.clone(), u.replicants_ms)
    };
    let is_rep = |pid: &str| replicants.contains_key(pid);
    let interface_of: HashMap<&str, &str> = sessions_all
        .iter()
        .filter(|(_, s)| !s.events.is_empty() && !s.interface.is_empty())
        .map(|(pid, s)| (pid.as_str(), s.interface.as_str()))
        .collect();
    let mut interfaces: Vec<String> = interface_of.values().map(|s| s.to_string()).collect::<HashSet<_>>().into_iter().collect();
    interfaces.sort();
    interfaces.push(NO_INTERFACE.into());
    let guild_labels: Vec<(String, String)> = entries
        .iter()
        .map(|e| (e.id.clone(), if e.tag.is_empty() { if e.name.is_empty() { e.id.clone() } else { e.name.clone() } } else { e.tag.clone() }))
        .collect();
    let segs = segments(&filters, &guild_labels, &interfaces);
    let base = segments(&Filters { compare: None, ..filters.clone() }, &guild_labels, &interfaces).remove(0);

    // The server's aggregates: every (guild, interface) a segment's signup
    // funnel needs, plus each guild unfiltered for the Guilds page.
    let with_api: Vec<&GuildApiEntry> = entries.iter().filter(|e| e.guild_api.is_some()).collect();
    // Replicants sign up from code and record no telemetry, so the servers'
    // funnel is the humans' and a replicants-only segment has none.
    let signup_guilds = |seg: &Seg| -> Option<Vec<String>> {
        if seg.active.is_some() || seg.interface.as_deref() == Some(NO_INTERFACE) || seg.replicant == Some(true) {
            return None;
        }
        Some(with_api.iter().filter(|e| seg.guild.as_ref().map_or(true, |g| *g == e.id)).map(|e| e.id.clone()).collect())
    };
    let mut combos: HashSet<(String, Option<String>)> = with_api.iter().map(|e| (e.id.clone(), None)).collect();
    for seg in &segs {
        for g in signup_guilds(seg).unwrap_or_default() {
            combos.insert((g, seg.interface.clone()));
        }
    }
    let combos: Vec<(String, Option<String>)> = combos.into_iter().collect();
    let api_of: HashMap<&str, &str> = with_api.iter().map(|e| (e.id.as_str(), e.guild_api.as_deref().unwrap_or_default())).collect();
    let aggs = futures_util::future::join_all(combos.iter().map(|(g, i)| {
        guild_aggregate(g, api_of.get(g.as_str()).copied().unwrap_or_default(), &version, idle_hours, i.as_deref(), fresh)
    }))
    .await;
    let agg: HashMap<(String, Option<String>), GuildAggregate> = combos.into_iter().zip(aggs).collect();

    let tutorial_chain = phase_chain(&catalog, PHASES[1]);
    let session_in = |seg: &Seg, pid: &str, s: &PlayerSession| -> bool {
        s.version == version && !s.events.is_empty() && seg.wants(&s.guild, if s.interface.is_empty() { NO_INTERFACE } else { &s.interface }, is_active(players.get(pid), cutoff), is_rep(pid))
    };

    let out_segs: Vec<Value> = segs
        .iter()
        .map(|seg| {
            // Players.
            let members: Vec<(&String, &crate::mcp::onboarding_players::PlayerFacts)> = players
                .iter()
                .filter(|(pid, p)| seg.wants(&p.guild, interface_of.get(pid.as_str()).copied().unwrap_or(NO_INTERFACE), is_active(Some(p), cutoff), is_rep(pid)))
                .collect();
            let active = members.iter().filter(|(_, p)| is_active(Some(p), cutoff)).count();
            let churn_base: Vec<_> = members.iter().filter(|(_, p)| p.created_ms.map_or(true, |c| c <= cutoff)).collect();
            let churned = churn_base.iter().filter(|(_, p)| !is_active(Some(p), cutoff)).count();
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
            dwell_next.extend(phase_chain(&catalog, PHASES[0]).into_iter().filter_map(|(k, _, n)| n.map(|n| (k, n))));
            let dwell = fold_sample(&sess, &dwell_next, now, idle_hours, 0)["dwell"].clone();

            // The server's signup funnel.
            let signup = signup_guilds(seg).map(|gs| {
                let per: Vec<(String, Vec<Value>)> = gs
                    .iter()
                    .filter_map(|g| agg.get(&(g.clone(), seg.interface.clone())).and_then(|a| a.funnels.get(PHASES[0])).map(|f| (g.clone(), f.clone())))
                    .collect();
                let steps = merge_funnels(&per);
                let started = steps.iter().filter(|s| s["previous"].is_null() && !s["next"].is_null()).map(|s| s["reached"].as_f64().unwrap_or(0.0)).fold(0.0, f64::max);
                let signed = steps.iter().find(|s| s["key"] == PLAYER_STEP).and_then(|s| s["reached"].as_f64()).unwrap_or(0.0);
                json!({ "steps": steps, "started": started, "signed_up": signed,
                        "dropoff_rate": if started > 0.0 { json!(1.0 - signed / started) } else { Value::Null } })
            });

            json!({
                "key": seg.key, "label": seg.label,
                "players": members.len(), "active": active, "inactive": members.len() - active,
                "active_rate": ratio(active, members.len()),
                "churn_base": churn_base.len(), "churned": churned, "churn_rate": ratio(churned, churn_base.len()),
                "signup": signup.unwrap_or(Value::Null),
                "tutorial": {
                    "steps": tutorial, "offered": offered.len(), "completed": completed, "declined": declined, "left": left,
                    "playing": count("playing"), "deciding": count("deciding"),
                    "completion_rate": ratio(completed, offered.len()), "decline_rate": ratio(declined, offered.len()), "quit_rate": ratio(left, offered.len()),
                },
                "sessions": sess.len(),
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
                         "refreshed_ms": if refreshed_ms > 0 { json!(refreshed_ms) } else { Value::Null }, "round": u },
            "replicants": { "known": replicants.len(), "primaries": replicants.values().collect::<HashSet<_>>().len(),
                            "read_ms": if replicants_ms > 0 { json!(replicants_ms) } else { Value::Null } },
        })
    };
    let guilds: Vec<Value> = entries
        .iter()
        .map(|e| {
            let a = agg.get(&(e.id.clone(), None));
            let signup = a.and_then(|a| a.funnels.get(PHASES[0]));
            let first = signup.map(|r| merge_funnels(&[(String::new(), r.clone())])).and_then(|m| {
                m.iter().filter(|s| s["previous"].is_null() && !s["next"].is_null()).map(|s| s["reached"].as_f64().unwrap_or(0.0)).reduce(f64::max)
            });
            let signed = signup.and_then(|r| r.iter().find(|s| text(s.get("step_key")) == PLAYER_STEP)).and_then(|s| num(s.get("reached")));
            let mine: Vec<&PlayerSession> = sessions_all.iter().filter(|(pid, s)| s.guild == e.id && !is_rep(pid)).map(|(_, s)| s).collect();
            let all: Vec<(&String, &crate::mcp::onboarding_players::PlayerFacts)> = players.iter().filter(|(_, p)| p.guild == e.id).collect();
            let members: Vec<_> = all.iter().filter(|(pid, _)| base.replicant.map_or(true, |r| r == is_rep(pid))).map(|(_, p)| *p).collect();
            json!({
                "id": e.id, "name": e.name, "tag": e.tag,
                "status": if e.guild_api.is_none() { "no_api" } else if a.and_then(|a| a.error.as_ref()).is_some() { "error" } else { "ok" },
                "error": e.error.clone().or_else(|| a.and_then(|a| a.error.clone())),
                "started": first, "signed_up": signed,
                "outcome": a.map(|a| a.outcome.clone()).unwrap_or(Value::Null),
                "sampled": mine.iter().filter(|s| !s.events.is_empty()).count(),
                "untracked": mine.iter().filter(|s| s.events.is_empty()).count(),
                "players": members.len(),
                "replicants": all.iter().filter(|(pid, _)| is_rep(pid)).count(),
                "active": members.iter().filter(|p| is_active(Some(p), cutoff)).count(),
            })
        })
        .collect();

    Ok(json!({
        "version": version,
        "versions": versions,
        "idle_hours": idle_hours,
        "active_days": active_days,
        "generated_ms": now,
        "filters": { "interface": clean(&filters.interface), "guild": clean(&filters.guild), "activity": clean(&filters.activity),
                     "replicants": filters.replicants == Some(true), "compare": clean(&filters.compare) },
        "options": { "interfaces": interfaces, "guilds": guild_labels.iter().map(|(id, l)| json!({ "id": id, "label": l })).collect::<Vec<_>>() },
        "segments": out_segs,
        "guilds": guilds,
        "recent": recent,
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
        let one = segments(&Filters { guild: Some("0-5".into()), activity: Some("active".into()), ..Default::default() }, &guilds, &ifaces);
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].guild.as_deref(), one[0].active), (Some("0-5"), Some(true)));
        let by_iface = segments(&Filters { compare: Some("interface".into()), guild: Some("0-5".into()), ..Default::default() }, &guilds, &ifaces);
        assert_eq!(by_iface.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), vec!["structs-webapp", "none"]);
        assert!(by_iface.iter().all(|s| s.guild.as_deref() == Some("0-5")), "the filter still applies to every segment");
        let by_guild = segments(&Filters { compare: Some("guild".into()), guild: Some("0-1".into()), ..Default::default() }, &guilds, &ifaces);
        assert_eq!(by_guild.len(), 1, "comparing within a filtered dimension leaves its one value");
        let by_act = segments(&Filters { compare: Some("activity".into()), ..Default::default() }, &guilds, &ifaces);
        assert_eq!(by_act.iter().map(|s| s.active).collect::<Vec<_>>(), vec![Some(true), Some(false)]);
        assert!(by_act[0].wants("0-9", "x", true, false) && !by_act[0].wants("0-9", "x", false, false));
        assert!(!one[0].wants("0-5", "x", true, true), "humans only unless replicants are asked for");
        let with = segments(&Filters { replicants: Some(true), ..Default::default() }, &guilds, &ifaces);
        assert!(with[0].wants("0-5", "x", true, true) && with[0].wants("0-5", "x", true, false));
        let by_rep = segments(&Filters { compare: Some("replicant".into()), ..Default::default() }, &guilds, &ifaces);
        assert_eq!(by_rep.iter().map(|s| (s.key.as_str(), s.replicant)).collect::<Vec<_>>(), vec![("human", Some(false)), ("replicant", Some(true))],
            "comparing them shows both even with the box unchecked");
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
