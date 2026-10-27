//! Every player on chain, with what the Onboarding card's player pages need:
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
//! 1-X as a replicant of 1-Y. The chain's whole permission store is three
//! LCD pages (~30k rows, under a second), so it is read whole each crawl
//! rather than tracked. Not perfect: a human who gives an alt full control
//! reads as a replicant, and a bot that grants nothing reads as human.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

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
/// The permission store at the LCD's maximum page; a few pages cover it.
const PERM_PAGE: usize = 10_000;
const PERM_MAX_PAGES: usize = 20;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlayerFacts {
    #[serde(default)]
    pub guild: String,
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

/// Replicant → primary from LCD permission records (`permissionId` is
/// `object@grantee`): a player object granting full control to ANOTHER player.
pub fn replicants_from(records: &[Value]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for r in records {
        let id = text(r.get("permissionId"));
        let Some((obj, who)) = id.split_once('@') else { continue };
        let full = text(r.get("value")).parse::<u64>().map_or(false, crate::mcp::delegation::has_full_control);
        if full && obj != who && obj.starts_with("1-") && who.starts_with("1-") {
            out.insert(obj.to_string(), who.to_string());
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

/// Refresh the replicant map. A failed read keeps the last one.
pub async fn refresh_replicants() -> Result<(), String> {
    let map = read_replicants().await?;
    let mut u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
    u.replicants = map;
    u.replicants_ms = now_ms();
    Ok(())
}

/// Which players' ledgers to read now: never read first, then those who have
/// acted since and were read long enough ago; newest player first, and every
/// human before any replicant.
pub fn ledger_plan(players: &HashMap<String, PlayerFacts>, replicants: &HashMap<String, String>, now: i64) -> Vec<String> {
    let index = |id: &str| id.split_once('-').and_then(|(_, i)| i.parse::<u64>().ok()).unwrap_or(0);
    // [human never, human stale, replicant never, replicant stale]
    let mut tiers: [Vec<&String>; 4] = Default::default();
    for (id, p) in players {
        if !id.starts_with("1-") {
            continue;
        }
        let r = if replicants.contains_key(id) { 2 } else { 0 };
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
    err.map_or(Ok(()), Err)
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

/// One round: the tables, then up to `LEDGER_BUDGET` ledgers, humans first.
/// The replicant map is read before this (`refresh_replicants`). Persists.
pub async fn crawl(replicants_error: Option<String>) {
    use futures_util::StreamExt;
    let c = crate::mcp::cosmos_client::CosmosClient::new().guild;
    let tables = refresh_tables(&c).await;
    let todo = {
        let u = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner());
        ledger_plan(&u.players, &u.replicants, now_ms())
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
    let snapshot = UNIVERSE.lock().unwrap_or_else(|p| p.into_inner()).clone();
    crate::mcp::cache_store::save_in_background(CACHE_NAME, snapshot);
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
        assert_eq!(ledger_plan(&p, &HashMap::new(), now), vec!["1-50", "1-5", "1-7"]);
        let reps: HashMap<String, String> = [("1-50".to_string(), "1-1".to_string())].into();
        assert_eq!(ledger_plan(&p, &reps, now), vec!["1-5", "1-7", "1-50"], "every human before any replicant");
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
