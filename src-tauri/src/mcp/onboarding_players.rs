//! Every player on chain, with what the Telemetry card's player pages need:
//! guild, when they were created, when they last acted, and five lifetime
//! counters (ore mined, alpha refined, planets completed, raids initiated,
//! raids won).
//!
//! ## Sources, all from OUR guild's API (every guild indexes the whole chain)
//!
//! | figure | route | cost |
//! |---|---|---|
//! | id · guild · created_at | `/api/player/list/all` | 1 page of 10,000, then `updated_since` |
//! | last acted | `/api/grid/attribute-type/lastAction/object-type/player` | the same |
//! | planets completed | `/api/planet/list/all` (owner, status) | ~7 pages, then `updated_since` |
//! | fleet owners | `/api/fleet/list/all` | 1 page, then `updated_since` |
//! | raids initiated / won | `/api/planet-activity/category/raid_status` | every row, each refresh (a few thousand) |
//! | ore mined · alpha refined | `/api/ledger/list/player/{id}` | ONE READ PER PLAYER — no bulk route totals the ledger |
//! | names | `/api/guild/{id}/roster` | one read per guild |
//! | replicants | `/api/permission/all` | a handful of pages, whole, each crawl |
//!
//! Raids follow the server's own definitions (`PlayerManager::getPlayerRaidsLaunched`
//! / `getPlayerRaidsWon`): initiated = `raid_status=initiated` on a fleet the
//! player owns; won = `raidSuccessful` on their fleet, or `attackerDefeated`
//! on their planet — current owners, as the server joins them.
//!
//! "Last acted" is the chain's `lastAction` attribute (what the guild's own
//! `/api/player/active/count` counts), timed by when that grid row last
//! changed. A value of 0 or 1 means the player never acted. `lastAction` only
//! moves on game actions, so a player who only sends tokens reads as idle.
//!
//! `created_at` is the indexer's insert time: exact for players created
//! since the indexer last rebuilt its player table (late September on the
//! mirror), a floor before that. Play length after signup is therefore
//! measured from the onboarding telemetry's own `signup.employee_record`.
//!
//! ## Replicants
//!
//! A replicant grants its primary `PermAll` on its own player object (every
//! one this app launches does, `delegation.rs`); a human almost never hands
//! another player full control. So `1-X@1-Y` at full control, X ≠ Y, marks
//! 1-X as a replicant of 1-Y. The store is read whole each crawl from the
//! guild's `/api/permission/all` (a handful of 10,000-row pages), falling
//! back to the LCD (1,000-row pages since v0.22.0). Not `updated_since`:
//! a revoked grant DELETES its row, so an incremental read would keep it.
//!
//! A replicant that never granted is caught by a second marker: a name our
//! generators mint (`callsign::is_managed_name`), no game action, no ledger
//! and no telemetry (`Universe::likely`). ~1,500 such accounts arrived after
//! v0.22.0, and every human-only figure counted them. Names come from each
//! guild's roster, because `/api/player/list/all` has none.
//!
//! Neither marker is perfect: a human who gives an alt full control reads as
//! a replicant, and a bot with a name of its own reads as human.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::mcp::guild_api::GuildApiClient;
use crate::mcp::onboarding::parse_ts;

const PAGE: usize = 10_000;
const MAX_PAGES: u32 = 20;
/// The busiest account (the primary everything sweeps into) has ~200k
/// ledger rows; a walk that hits this cap is kept but marked truncated.
const LEDGER_MAX_PAGES: u32 = 30;
const LEDGER_BUDGET: usize = 3_000;
const LEDGER_CONCURRENCY: usize = 6;
const LEDGER_MAX_ERRORS: usize = 20;
/// A player who acted since we read their ledger is read again, but not
/// more often than this.
const LEDGER_REFRESH_MS: i64 = 6 * 3_600_000;
/// Incremental reads overlap the last one by this much: `updated_since` is
/// a strict `>` on a timestamp the indexer writes, not a cursor.
const OVERLAP_SECS: i64 = 120;
const CACHE_NAME: &str = "onboarding_universe";
/// The fallback read, at the LCD's maximum page. v0.22.0 clamps every
/// Structs page to 1000 rows (it was ~3 pages of 10,000), so the walk
/// bound has to cover ~40+ pages now.
const PERM_PAGE: usize = 1_000;
const PERM_MAX_PAGES: usize = 200;
/// While a crawl is changing the tables, a read rebuilds the snapshot at most
/// this often.
const SNAPSHOT_MIN_AGE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlayerFacts {
    #[serde(default)]
    pub guild: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_ms: Option<i64>,
    /// When `lastAction` last moved; `None` = never acted.
    #[serde(default)]
    pub last_active_ms: Option<i64>,
    #[serde(default)]
    pub mined_g: Option<f64>,
    #[serde(default)]
    pub refined_g: Option<f64>,
    #[serde(default)]
    pub ledger_ms: i64,
    #[serde(default)]
    pub ledger_truncated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Planet {
    owner: String,
    complete: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Universe {
    pub players: HashMap<String, PlayerFacts>,
    planets: HashMap<String, Planet>,
    fleets: HashMap<String, String>,
    /// (planet_id, fleet_id, status) for every raid_status event.
    raids: Vec<(String, String, String)>,
    /// unix seconds each table was last read from (for `updated_since`).
    #[serde(default)]
    since: HashMap<String, i64>,
    #[serde(default)]
    pub refreshed_ms: i64,
    /// replicant → its primary, from the chain's permission store.
    #[serde(default)]
    pub replicants: HashMap<String, String>,
    #[serde(default)]
    pub replicants_ms: i64,
    /// Where the map was last read from: `guild` or `chain`.
    #[serde(default)]
    pub replicants_source: String,
    /// Replicants that never granted: see `is_likely_replicant`.
    #[serde(default)]
    pub likely: HashSet<String>,
}

/// The five counters, derived from the tables. `None` = not known yet.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PlayerStats {
    pub mined_g: Option<f64>,
    pub refined_g: Option<f64>,
    pub planets: f64,
    pub raids_initiated: f64,
    pub raids_won: f64,
}

pub static UNIVERSE: LazyLock<Mutex<Universe>> =
    LazyLock::new(|| Mutex::new(crate::mcp::cache_store::load(CACHE_NAME).unwrap_or_default()));

/// What a read needs, built once and shared: cloning the tables and folding
/// ~80k planets into counters on every 5-second poll cost more than the read.
#[derive(Default)]
pub struct Snapshot {
    pub players: HashMap<String, PlayerFacts>,
    pub stats: HashMap<String, PlayerStats>,
    pub replicants: HashMap<String, String>,
    pub likely: HashSet<String>,
    pub refreshed_ms: i64,
    pub replicants_ms: i64,
    pub replicants_source: String,
}

impl Snapshot {
    /// Granted, or likely: everything the human-only figures leave out.
    pub fn is_replicant(&self, id: &str) -> bool {
        self.replicants.contains_key(id) || self.likely.contains(id)
    }
}

static GENERATION: AtomicU64 = AtomicU64::new(1);
static SNAPSHOT: LazyLock<Mutex<Option<(u64, Instant, Arc<Snapshot>)>>> = LazyLock::new(|| Mutex::new(None));

/// The tables changed: the next read may rebuild.
fn touch() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub fn snapshot() -> Arc<Snapshot> {
    let generation = GENERATION.load(Ordering::SeqCst);
    let mut held = SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((built, at, s)) = held.as_ref() {
        if *built == generation || at.elapsed() < SNAPSHOT_MIN_AGE {
            return s.clone();
        }
    }
    let s = {
        let u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
        Arc::new(Snapshot {
            players: u.players.clone(),
            stats: u.stats(),
            replicants: u.replicants.clone(),
            likely: u.likely.clone(),
            refreshed_ms: u.refreshed_ms,
            replicants_ms: u.replicants_ms,
            replicants_source: u.replicants_source.clone(),
        })
    };
    *held = Some((generation, Instant::now(), s.clone()));
    s
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

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Walk a catalog list route at the server's maximum page size.
async fn walk(c: &GuildApiClient, base: &str, since: Option<i64>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let q = match since {
            Some(s) => format!("{base}/page/{page}?limit={PAGE}&updated_since={s}"),
            None => format!("{base}/page/{page}?limit={PAGE}"),
        };
        let rows = match c.get_data(&q).await? {
            Value::Array(a) => a,
            Value::Null => Vec::new(),
            other => return Err(format!("{base}: expected a list, got {other}")),
        };
        let n = rows.len();
        out.extend(rows);
        if n < PAGE {
            break;
        }
    }
    Ok(out)
}

impl Universe {
    pub fn fold_players(&mut self, rows: &[Value]) {
        for r in rows {
            let id = text(r.get("id"));
            if id.is_empty() {
                continue;
            }
            let p = self.players.entry(id).or_default();
            p.guild = text(r.get("guild_id"));
            p.created_ms = parse_ts(&text(r.get("created_at"))).or(p.created_ms);
        }
    }

    pub fn fold_last_action(&mut self, rows: &[Value]) {
        for r in rows {
            let id = text(r.get("object_id"));
            if id.is_empty() {
                continue;
            }
            let acted = num(r.get("val")).unwrap_or(0.0) > 1.0;
            let p = self.players.entry(id).or_default();
            p.last_active_ms = if acted { parse_ts(&text(r.get("updated_at"))) } else { None };
        }
    }

    fn fold_planets(&mut self, rows: &[Value]) {
        for r in rows {
            let id = text(r.get("id"));
            if !id.is_empty() {
                self.planets.insert(id, Planet { owner: text(r.get("owner")), complete: text(r.get("status")) == "complete" });
            }
        }
    }

    fn fold_fleets(&mut self, rows: &[Value]) {
        for r in rows {
            let id = text(r.get("id"));
            if !id.is_empty() {
                self.fleets.insert(id, text(r.get("owner")));
            }
        }
    }

    pub fn set_raids(&mut self, rows: &[Value]) {
        self.raids = rows
            .iter()
            .map(|r| {
                // `detail_json` is the server's decode; `detail` the raw string.
                let d = r.get("detail_json").cloned().filter(|v| v.is_object()).unwrap_or_else(|| {
                    serde_json::from_str(&text(r.get("detail"))).unwrap_or(Value::Null)
                });
                (text(r.get("planet_id")), text(d.get("fleet_id")), text(d.get("status")))
            })
            .collect();
    }

    pub fn is_replicant(&self, id: &str) -> bool {
        self.replicants.contains_key(id)
    }

    /// Names from `/api/guild/{id}/roster` rows.
    pub fn fold_names(&mut self, rows: &[Value]) {
        for r in rows {
            let name = text(r.get("username"));
            if name.is_empty() {
                continue;
            }
            if let Some(p) = self.players.get_mut(&text(r.get("id"))) {
                p.name = name;
            }
        }
    }

    /// Recompute the second marker. `telemetry`: players with any recorded
    /// onboarding step or tutorial run.
    pub fn classify(&mut self, telemetry: &HashSet<String>) {
        let likely = self
            .players
            .iter()
            .filter(|(id, p)| !self.replicants.contains_key(*id) && is_likely_replicant(p, telemetry.contains(*id)))
            .map(|(id, _)| id.clone())
            .collect();
        self.likely = likely;
    }

    /// The counters for every player, in one pass over the tables.
    pub fn stats(&self) -> HashMap<String, PlayerStats> {
        let mut out: HashMap<String, PlayerStats> = self
            .players
            .iter()
            .map(|(id, p)| (id.clone(), PlayerStats { mined_g: p.mined_g, refined_g: p.refined_g, ..Default::default() }))
            .collect();
        for pl in self.planets.values() {
            if pl.complete {
                if let Some(s) = out.get_mut(&pl.owner) {
                    s.planets += 1.0;
                }
            }
        }
        for (planet, fleet, status) in &self.raids {
            let fleet_owner = self.fleets.get(fleet);
            let planet_owner = self.planets.get(planet).map(|p| &p.owner);
            match status.as_str() {
                "initiated" => {
                    if let Some(s) = fleet_owner.and_then(|o| out.get_mut(o)) {
                        s.raids_initiated += 1.0;
                    }
                }
                "raidSuccessful" => {
                    if let Some(s) = fleet_owner.and_then(|o| out.get_mut(o)) {
                        s.raids_won += 1.0;
                    }
                }
                "attackerDefeated" => {
                    if let Some(s) = planet_owner.and_then(|o| out.get_mut(o)) {
                        s.raids_won += 1.0;
                    }
                }
                _ => {}
            }
        }
        out
    }
}

/// Ore mined (grams) and alpha refined (grams) from a player's ledger rows.
/// `mined` is an ore credit; `refined` writes an ore debit AND a ualpha
/// credit, and only the credit is counted.
pub fn ledger_totals(rows: &[Value]) -> (f64, f64) {
    let (mut mined, mut refined_u) = (0.0, 0.0);
    for r in rows {
        let credit = text(r.get("direction")) == "credit";
        let amount = num(r.get("amount_p")).unwrap_or(0.0);
        match (text(r.get("action")).as_str(), text(r.get("denom")).as_str()) {
            ("mined", "ore") if credit => mined += amount,
            ("refined", "ualpha") if credit => refined_u += amount,
            _ => {}
        }
    }
    (mined, refined_u / 1_000_000.0)
}

/// A replicant that never granted: an account nobody has touched, carrying a
/// name our generators mint. An empty name is no evidence, and any sign of
/// play rules it out.
pub fn is_likely_replicant(p: &PlayerFacts, telemetry: bool) -> bool {
    !telemetry
        && p.last_active_ms.is_none()
        && p.mined_g.unwrap_or(0.0) == 0.0
        && p.refined_g.unwrap_or(0.0) == 0.0
        && !p.name.trim().is_empty()
        && crate::mcp::callsign::is_managed_name(&p.name)
}

/// Is this grant a player object handing ANOTHER player full control?
fn is_replicant_grant(obj: &str, who: &str, value: u64) -> bool {
    crate::mcp::delegation::has_full_control(value) && obj != who && obj.starts_with("1-") && who.starts_with("1-")
}

/// Replicant → primary from LCD permission records (`permissionId` is
/// `object@grantee`).
pub fn replicants_from(records: &[Value]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for r in records {
        let id = text(r.get("permissionId"));
        let Some((obj, who)) = id.split_once('@') else { continue };
        let value = text(r.get("value")).parse::<u64>().unwrap_or(0);
        if is_replicant_grant(obj, who, value) {
            out.insert(obj.to_string(), who.to_string());
        }
    }
    out
}

/// The same from `/api/permission/all` rows (`object_id`, `player_id`, `val`).
pub fn replicants_from_rows(rows: &[Value]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for r in rows {
        let (obj, who) = (text(r.get("object_id")), text(r.get("player_id")));
        if is_replicant_grant(&obj, &who, num(r.get("val")).unwrap_or(0.0) as u64) {
            out.insert(obj, who);
        }
    }
    out
}

/// The whole permission store from the chain, folded to replicant → primary.
pub async fn read_replicants() -> Result<HashMap<String, String>, String> {
    let c = crate::mcp::cosmos_client::CosmosClient::new();
    let mut records: Vec<Value> = Vec::new();
    let mut key: Option<String> = None;
    for _ in 0..PERM_MAX_PAGES {
        let mut path = format!("/structs/permission?pagination.limit={PERM_PAGE}");
        if let Some(k) = &key {
            path.push_str(&format!("&pagination.key={}", crate::mcp::cosmos_client::encode_pagination_key(k)));
        }
        let (v, _, _) = c.lcd_get_bulk(&path).await?;
        if let Some(Value::Array(rows)) = v.get("permissionRecords") {
            records.extend(rows.iter().cloned());
        }
        key = v.get("pagination").and_then(|p| p.get("next_key")).and_then(|k| k.as_str()).filter(|k| !k.is_empty()).map(String::from);
        if key.is_none() {
            return Ok(replicants_from(&records));
        }
    }
    Err(format!("permission store longer than {PERM_MAX_PAGES} pages"))
}

/// Refresh the replicant map, from our guild's API and else the chain. An
/// empty answer is a failed read: no chain has no permissions. If both fail
/// the last map stays.
pub async fn refresh_replicants() -> Result<(), String> {
    let c = crate::mcp::cosmos_client::CosmosClient::new().guild;
    let guild = walk(&c, "/api/permission/all", None).await.map(|rows| replicants_from_rows(&rows));
    let (map, source) = match guild {
        Ok(m) if !m.is_empty() => (m, "guild"),
        other => match read_replicants().await {
            Ok(m) if !m.is_empty() => (m, "chain"),
            Ok(_) => return Err(format!("no permissions from either source (guild: {:?})", other.err())),
            Err(e) => return Err(format!("chain: {e} (guild: {:?})", other.err())),
        },
    };
    let mut u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
    u.replicants = map;
    u.replicants_ms = now_ms();
    u.replicants_source = source.to_string();
    touch();
    Ok(())
}

/// Which players' ledgers to read now: never read first, then those who have
/// acted since and were read long enough ago; newest player first, and every
/// human before any replicant.
pub fn ledger_plan(players: &HashMap<String, PlayerFacts>, is_replicant: impl Fn(&str) -> bool, now: i64) -> Vec<String> {
    let index = |id: &str| id.split_once('-').and_then(|(_, i)| i.parse::<u64>().ok()).unwrap_or(0);
    // [human never, human stale, replicant never, replicant stale]
    let mut tiers: [Vec<&String>; 4] = Default::default();
    for (id, p) in players {
        if !id.starts_with("1-") {
            continue;
        }
        let r = if is_replicant(id) { 2 } else { 0 };
        if p.ledger_ms == 0 {
            tiers[r].push(id);
        } else if p.last_active_ms.map(|a| a > p.ledger_ms).unwrap_or(false) && now - p.ledger_ms > LEDGER_REFRESH_MS {
            tiers[r + 1].push(id);
        }
    }
    for t in tiers.iter_mut() {
        t.sort_by_key(|id| std::cmp::Reverse(index(id)));
    }
    tiers.into_iter().flatten().take(LEDGER_BUDGET).cloned().collect()
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct UniverseCrawl {
    pub tables_error: Option<String>,
    pub replicants_error: Option<String>,
    pub ledger_todo: usize,
    pub ledger_read: usize,
    pub ledger_errors: usize,
    pub ledger_last_error: Option<String>,
}

pub static UNIVERSE_CRAWL: LazyLock<Mutex<UniverseCrawl>> = LazyLock::new(|| Mutex::new(UniverseCrawl::default()));

async fn refresh_tables(c: &GuildApiClient) -> Result<(), String> {
    let since = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner()).since.clone();
    let start = now_ms() / 1000 - OVERLAP_SECS;
    let s = |k: &str| since.get(k).copied();
    let (players, last, planets, fleets, raids) = tokio::join!(
        walk(c, "/api/player/list/all", s("player")),
        walk(c, "/api/grid/attribute-type/lastAction/object-type/player", s("lastAction")),
        walk(c, "/api/planet/list/all", s("planet")),
        walk(c, "/api/fleet/list/all", s("fleet")),
        walk(c, "/api/planet-activity/category/raid_status", None),
    );
    let mut u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
    let mut err = None;
    for (key, r) in [("player", players), ("lastAction", last), ("planet", planets), ("fleet", fleets)] {
        match r {
            Ok(rows) => {
                match key {
                    "player" => u.fold_players(&rows),
                    "lastAction" => u.fold_last_action(&rows),
                    "planet" => u.fold_planets(&rows),
                    _ => u.fold_fleets(&rows),
                }
                u.since.insert(key.to_string(), start);
            }
            Err(e) => err = Some(format!("{key}: {e}")),
        }
    }
    match raids {
        Ok(rows) => u.set_raids(&rows),
        Err(e) => err = Some(format!("raids: {e}")),
    }
    u.refreshed_ms = now_ms();
    touch();
    err.map_or(Ok(()), Err)
}

/// Every guild's names, from our own API: guilds without one still have rosters.
async fn refresh_names(c: &GuildApiClient, guilds: &[String]) {
    let rosters = futures_util::future::join_all(guilds.iter().map(|g| c.guild_roster(g))).await;
    let mut u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
    for r in rosters {
        if let Ok(Value::Array(rows)) = r {
            u.fold_names(&rows);
        }
    }
}

async fn read_ledger(c: &GuildApiClient, pid: &str) -> Result<(f64, f64, bool), String> {
    let mut rows = Vec::new();
    let mut truncated = true;
    for page in 1..=LEDGER_MAX_PAGES {
        let got = match c.get_data(&format!("/api/ledger/list/player/{pid}/page/{page}?limit={PAGE}")).await? {
            Value::Array(a) => a,
            _ => Vec::new(),
        };
        let n = got.len();
        rows.extend(got);
        if n < PAGE {
            truncated = false;
            break;
        }
    }
    let (m, r) = ledger_totals(&rows);
    Ok((m, r, truncated))
}

/// One round: the tables and names, then up to `LEDGER_BUDGET` ledgers,
/// humans first. The replicant map is read before this
/// (`refresh_replicants`); `finish_round` persists.
pub async fn crawl(replicants_error: Option<String>, guilds: Vec<String>, telemetry: HashSet<String>) {
    use futures_util::StreamExt;
    let c = crate::mcp::cosmos_client::CosmosClient::new().guild;
    let tables = refresh_tables(&c).await;
    refresh_names(&c, &guilds).await;
    let todo = {
        let mut u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
        u.classify(&telemetry);
        touch();
        ledger_plan(&u.players, |id| u.is_replicant(id) || u.likely.contains(id), now_ms())
    };
    {
        let mut st = UNIVERSE_CRAWL.lock().unwrap_or_else(|p| p.into_inner());
        *st = UniverseCrawl { tables_error: tables.err(), replicants_error, ledger_todo: todo.len(), ..Default::default() };
    }
    let mut results = futures_util::stream::iter(todo.into_iter().map(|pid| {
        let c = c.clone();
        async move {
            let r = read_ledger(&c, &pid).await;
            (pid, r)
        }
    }))
    .buffer_unordered(LEDGER_CONCURRENCY);
    let mut errors = 0;
    while let Some((pid, r)) = results.next().await {
        match r {
            Ok((m, rf, truncated)) => {
                if let Some(p) = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner()).players.get_mut(&pid) {
                    p.mined_g = Some(m);
                    p.refined_g = Some(rf);
                    p.ledger_ms = now_ms();
                    p.ledger_truncated = truncated;
                }
                touch();
                UNIVERSE_CRAWL.lock().unwrap_or_else(|p| p.into_inner()).ledger_read += 1;
            }
            Err(e) => {
                errors += 1;
                let mut st = UNIVERSE_CRAWL.lock().unwrap_or_else(|p| p.into_inner());
                st.ledger_errors += 1;
                st.ledger_last_error = Some(e);
                if errors >= LEDGER_MAX_ERRORS {
                    break;
                }
            }
        }
    }
}

/// The round is over: settle the second marker on what the crawls found, and persist.
pub fn finish_round(telemetry: &HashSet<String>) {
    let mut u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
    u.classify(telemetry);
    touch();
    crate::mcp::cache_store::save_in_background(CACHE_NAME, u.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ledger_totals_count_ore_credits_and_alpha_credits_only() {
        let rows = vec![
            json!({"action": "mined", "denom": "ore", "direction": "credit", "amount_p": 1}),
            json!({"action": "mined", "denom": "ore", "direction": "credit", "amount_p": "1"}),
            json!({"action": "refined", "denom": "ore", "direction": "debit", "amount_p": 1}),
            json!({"action": "refined", "denom": "ualpha", "direction": "credit", "amount_p": 1_000_000}),
            json!({"action": "received", "denom": "ualpha", "direction": "credit", "amount_p": 1_000_000}),
            json!({"action": "seized", "denom": "ore", "direction": "credit", "amount_p": 80}),
        ];
        assert_eq!(ledger_totals(&rows), (2.0, 1.0));
    }

    #[test]
    fn raids_and_planets_follow_the_servers_definitions() {
        let mut u = Universe::default();
        u.fold_players(&[json!({"id": "1-1", "guild_id": "0-1", "created_at": "2026-10-20 10:00:00+00"}), json!({"id": "1-2", "guild_id": "0-5"})]);
        u.fold_planets(&[json!({"id": "2-1", "owner": "1-1", "status": "complete"}), json!({"id": "2-2", "owner": "1-2", "status": "active"})]);
        u.fold_fleets(&[json!({"id": "9-1", "owner": "1-1"}), json!({"id": "9-2", "owner": "1-2"})]);
        u.set_raids(&[
            json!({"planet_id": "2-2", "detail_json": {"fleet_id": "9-1", "status": "initiated"}}),
            json!({"planet_id": "2-2", "detail": "{\"fleet_id\":\"9-1\",\"status\":\"raidSuccessful\"}"}),
            json!({"planet_id": "2-1", "detail_json": {"fleet_id": "9-2", "status": "initiated"}}),
            json!({"planet_id": "2-1", "detail_json": {"fleet_id": "9-2", "status": "attackerDefeated"}}),
        ]);
        let s = u.stats();
        assert_eq!((s["1-1"].planets, s["1-1"].raids_initiated, s["1-1"].raids_won), (1.0, 1.0, 2.0), "a raid won + a defence won");
        assert_eq!((s["1-2"].planets, s["1-2"].raids_initiated, s["1-2"].raids_won), (0.0, 1.0, 0.0));
        assert_eq!(s["1-1"].mined_g, None, "unread ledgers are unknown, not zero");
        assert_eq!(u.players["1-1"].created_ms, Some(1_792_490_400_000));
    }

    #[test]
    fn last_action_of_zero_or_one_is_never_acted() {
        let mut u = Universe::default();
        u.fold_last_action(&[
            json!({"object_id": "1-1", "val": "3290769", "updated_at": "2026-10-26 10:00:00+00"}),
            json!({"object_id": "1-2", "val": 1, "updated_at": "2026-10-24 20:48:00+00"}),
        ]);
        assert!(u.players["1-1"].last_active_ms.is_some());
        assert_eq!(u.players["1-2"].last_active_ms, None);
    }

    #[test]
    fn ledgers_are_read_newest_first_then_only_when_the_player_acted_since() {
        let now = 100 * 3_600_000;
        let mut p: HashMap<String, PlayerFacts> = HashMap::new();
        p.insert("1-5".into(), PlayerFacts::default());
        p.insert("1-50".into(), PlayerFacts::default());
        p.insert("1-7".into(), PlayerFacts { ledger_ms: 10 * 3_600_000, last_active_ms: Some(20 * 3_600_000), ..Default::default() });
        p.insert("1-8".into(), PlayerFacts { ledger_ms: 10 * 3_600_000, last_active_ms: Some(5 * 3_600_000), ..Default::default() });
        p.insert("1-9".into(), PlayerFacts { ledger_ms: now - 3_600_000, last_active_ms: Some(now), ..Default::default() });
        assert_eq!(ledger_plan(&p, |_| false, now), vec!["1-50", "1-5", "1-7"]);
        assert_eq!(ledger_plan(&p, |id| id == "1-50", now), vec!["1-5", "1-7", "1-50"], "every human before any replicant");
    }

    #[test]
    fn a_player_granting_another_full_control_is_a_replicant() {
        let rows = vec![
            json!({"permissionId": "1-300@1-194", "value": "33554431"}),
            json!({"permissionId": "1-301@1-301", "value": "33554431"}),
            json!({"permissionId": "1-302@1-194", "value": "15728640"}),
            json!({"permissionId": "1-303@1-194", "value": "16777215"}),
            json!({"permissionId": "2-9@1-194", "value": "33554431"}),
            json!({"permissionId": "1-304@8-1", "value": "33554431"}),
            json!({"permissionId": "garbage", "value": "33554431"}),
        ];
        let r = replicants_from(&rows);
        assert_eq!(r.len(), 1, "{r:?}");
        assert_eq!(r.get("1-300").map(String::as_str), Some("1-194"));
    }

    #[test]
    fn guild_rows_mark_the_same_replicants_as_lcd_records() {
        let rows = vec![
            json!({"id": "1-300@1-194", "object_id": "1-300", "player_id": "1-194", "val": "33554431"}),
            json!({"id": "1-301@1-194", "object_id": "1-301", "player_id": "1-194", "val": 33554431}),
            json!({"id": "1-301@1-301", "object_id": "1-301", "player_id": "1-301", "val": 33554431}),
            json!({"id": "1-302@1-194", "object_id": "1-302", "player_id": "1-194", "val": 15728640}),
            json!({"id": "2-9@1-194", "object_id": "2-9", "player_id": "1-194", "val": 33554431}),
        ];
        let r = replicants_from_rows(&rows);
        assert_eq!(r.len(), 2, "{r:?}");
        assert_eq!(r.get("1-301").map(String::as_str), Some("1-194"));
    }

    #[test]
    fn an_untouched_account_with_a_minted_name_is_a_likely_replicant() {
        let ghost = |name: &str| PlayerFacts { name: name.into(), ..Default::default() };
        // Names read off the live roster, 2026-11-05.
        for n in ["MAGMA-1606", "FLINT-8462", "PEREGRINE-6067", "TRITON-6132", "PENUMBRA-9948", "CASTOR-1969", "CANOPUS-1364", "GRANITE-4185", "KESTREL-4465", "ABYSSAL-5628", "MERLIN-3040", "PLASMA-4689"] {
            assert!(is_likely_replicant(&ghost(n), false), "{n}");
        }
        assert!(!is_likely_replicant(&ghost("Wixby"), false), "a name of their own");
        assert!(!is_likely_replicant(&ghost(""), false), "no name is no evidence");
        assert!(!is_likely_replicant(&ghost("MAGMA-1606"), true), "telemetry means someone was there");
        assert!(!is_likely_replicant(&PlayerFacts { name: "MAGMA-1606".into(), last_active_ms: Some(1), ..Default::default() }, false), "played");
        assert!(!is_likely_replicant(&PlayerFacts { name: "MAGMA-1606".into(), mined_g: Some(5.0), ..Default::default() }, false), "mined");
    }

    #[test]
    fn classify_leaves_granted_replicants_to_the_first_marker() {
        let mut u = Universe::default();
        u.fold_players(&[json!({"id": "1-1", "guild_id": "0-1"}), json!({"id": "1-2", "guild_id": "0-1"}), json!({"id": "1-3", "guild_id": "0-1"})]);
        u.fold_names(&[json!({"id": "1-1", "username": "MAGMA-1606"}), json!({"id": "1-2", "username": "FLINT-8462"}), json!({"id": "1-3", "username": "Wixby"}), json!({"id": "1-9", "username": "TRITON-6132"})]);
        u.replicants.insert("1-2".into(), "1-194".into());
        u.classify(&HashSet::new());
        assert_eq!(u.likely, HashSet::from(["1-1".to_string()]));
        u.classify(&HashSet::from(["1-1".to_string()]));
        assert!(u.likely.is_empty(), "telemetry clears it next round");
    }

    /// `cargo test --bin structs-app live_replicants -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_replicants_come_from_the_whole_permission_store() {
        let r = read_replicants().await.expect("permission store");
        let primaries: std::collections::HashSet<&String> = r.values().collect();
        println!("{} replicants under {} primaries", r.len(), primaries.len());
        assert!(r.len() > 1_000 && primaries.len() < r.len() / 10);
        assert!(!primaries.iter().any(|p| r.contains_key(*p)), "no primary is itself a replicant");
    }
}
