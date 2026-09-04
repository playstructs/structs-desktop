//! Pre-sign verification reads, with a switchable source.
//!
//! Every loop scans from the shared perception snapshot and then, right
//! before it signs, re-reads the one or two facts that decide the action
//! (a slot is free, a rig is online, the ore clock has not moved, a hull is
//! still built). Those reads used to go to the chain's LCD — the public
//! node the whole guild shares — at one to three requests per action, which
//! at fleet scale is a steady few thousand requests an hour against an
//! endpoint that answers 429 to everyone when it is busy.
//!
//! The Guild API serves the same facts from the indexer (the source GRASS
//! streams from), typically one block behind the LCD. This module makes the
//! source a runtime choice (`verify_source`: `guild` by default, `lcd` to
//! revert) and answers each question through ONE narrow function so the
//! loops never parse either shape themselves.
//!
//! Contract on the guild path: a missing or unparseable field is an `Err`,
//! never a silent default — a default of 0 for an ore anchor is exactly how a
//! proof gets solved against the wrong clock. On an error the LCD path is
//! tried (counted as a failover and logged, rate-limited) so a lapsed guild
//! session degrades to the old behaviour instead of stopping every loop.
//!
//! Field vocabulary (from the webapp's own models and the structs-ai docs):
//! guild struct rows are snake_case with `status` as a bit-flag (Built=2,
//! Online=4, Destroyed=32) and `is_destroyed`; player rows carry `planet_id`,
//! `fleet_id`, `ore`; work rows carry `object_id`, `category`, `block_start`;
//! numerics may arrive as strings.

use serde_json::Value;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::LazyLock;

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::guild_api::OBJECTS_BATCH_MAX;
use crate::mcp::loop_util::{parse_bool, parse_f64, read_u64_field};
use crate::mcp::telemetry::{tlog, Sev};

// ── Source knob ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerifySource {
    Guild,
    Lcd,
}

impl VerifySource {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "guild" | "guild_api" | "api" => Some(VerifySource::Guild),
            "lcd" | "chain" => Some(VerifySource::Lcd),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            VerifySource::Guild => "guild",
            VerifySource::Lcd => "lcd",
        }
    }
}

static SOURCE: AtomicU8 = AtomicU8::new(0); // 0 = guild, 1 = lcd

pub fn source() -> VerifySource {
    if SOURCE.load(Ordering::Relaxed) == 1 {
        VerifySource::Lcd
    } else {
        VerifySource::Guild
    }
}

/// Returns false (and changes nothing) for an unknown source.
pub fn set_source(s: &str) -> bool {
    match VerifySource::parse(s) {
        Some(v) => {
            SOURCE.store(if v == VerifySource::Lcd { 1 } else { 0 }, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

// ── Accounting ───────────────────────────────────────────────────────────────

static GUILD_READS: AtomicU64 = AtomicU64::new(0);
static LCD_READS: AtomicU64 = AtomicU64::new(0);
static FAILOVERS: AtomicU64 = AtomicU64::new(0);
static LAST_FAILOVER_LOG_MS: AtomicU64 = AtomicU64::new(0);

pub fn health() -> Value {
    let indexer = INDEXER_HEIGHT.load(Ordering::Relaxed);
    let game = crate::game_state::GAME_STATE.read().ok().map(|g| g.current_block_height).unwrap_or(0);
    serde_json::json!({
        "source": source().name(),
        "guild_reads": GUILD_READS.load(Ordering::Relaxed),
        "lcd_reads": LCD_READS.load(Ordering::Relaxed),
        "failovers_to_lcd": FAILOVERS.load(Ordering::Relaxed),
        "objects_batches": OBJECT_BATCHES.load(Ordering::Relaxed),
        "objects_cached": OBJECTS.len(),
        "sweeps": sweeps_health(),
        // How far the indexer trails the game's own block clock, from the
        // last batch response's `meta.height`. 0 = no batch read yet.
        "indexer_height": indexer,
        "indexer_lag_blocks": if indexer > 0 && game > indexer { game - indexer } else { 0 },
    })
}

// ── Batched typed reads (`/api/objects?ids=`, ≤ 200 ids) ─────────────────────
//
// One call answers up to 200 "which planet / fleet / owner / slot" questions,
// so a scan that collects its candidates first pays a handful of requests
// instead of one per action. Rows are cached briefly: the same planet is
// asked about by every ripe entry of the same player within one scan.
// Struct rows here are BASE columns only — built/online still come from
// `/api/struct/{id}` (see `struct_state`) until status lands in the batch.

const OBJECTS_TTL_MS: f64 = 20_000.0;
static OBJECTS: LazyLock<dashmap::DashMap<String, (f64, Value)>> = LazyLock::new(dashmap::DashMap::new);
static OBJECT_BATCHES: AtomicU64 = AtomicU64::new(0);
static INDEXER_HEIGHT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> f64 {
    crate::hasher::types::now_millis()
}

fn cached_object(id: &str) -> Option<Value> {
    let e = OBJECTS.get(id)?;
    (now_ms() - e.0 <= OBJECTS_TTL_MS).then(|| e.1.clone())
}

/// Fetch (and cache) the typed rows for `ids` that are not fresh already, in
/// batches of up to 200. Returns how many rows were fetched. Call it at the
/// top of a scan with every planet / fleet / player / struct id the scan will
/// verify, then the per-action reads below hit the cache.
pub async fn prefetch_objects(client: &CosmosClient, ids: &[String]) -> Result<usize, String> {
    let mut want: Vec<&str> = ids.iter().map(String::as_str).filter(|id| cached_object(id).is_none()).collect();
    want.sort_unstable();
    want.dedup();
    let mut fetched = 0;
    for chunk in want.chunks(OBJECTS_BATCH_MAX) {
        let (rows, height) = client.guild.objects_by_ids(chunk).await?;
        OBJECT_BATCHES.fetch_add(1, Ordering::Relaxed);
        if let Some(h) = height {
            INDEXER_HEIGHT.store(h, Ordering::Relaxed);
        }
        let now = now_ms();
        for row in rows {
            let (Some(id), Some(obj)) = (str_field(&row, "id"), row.get("object")) else { continue };
            if obj.is_object() {
                OBJECTS.insert(id.to_string(), (now, obj.clone()));
                fetched += 1;
            }
        }
    }
    // Keep the map bounded: drop anything stale once it grows past a scan's worth.
    if OBJECTS.len() > 4 * OBJECTS_BATCH_MAX {
        let now = now_ms();
        OBJECTS.retain(|_, (t, _)| now - *t <= OBJECTS_TTL_MS);
    }
    Ok(fetched)
}

/// One typed row from the batch endpoint, via the cache.
async fn object_row(client: &CosmosClient, id: &str) -> Result<Value, String> {
    if let Some(v) = cached_object(id) {
        return Ok(v);
    }
    prefetch_objects(client, &[id.to_string()]).await?;
    cached_object(id).ok_or_else(|| format!("Guild API objects has no {id}"))
}

/// A planet/fleet row's `map` — slot arrays keyed by ambit, serialised as a
/// JSON string inside the row.
pub(crate) fn slot_map(row: &Value) -> Result<Value, String> {
    match row.get("map") {
        Some(Value::String(s)) => serde_json::from_str(s).map_err(|e| format!("map is not JSON: {e}")),
        Some(v @ Value::Object(_)) => Ok(v.clone()),
        _ => Err("row has no `map`".to_string()),
    }
}

pub(crate) fn slot_occupied_in_map(map: &Value, ambit: &str, slot: u64) -> Result<bool, String> {
    let arr = map
        .get(ambit)
        .or_else(|| map.get(ambit.to_ascii_lowercase().as_str()))
        .and_then(|a| a.as_array())
        .ok_or_else(|| format!("map has no `{ambit}` array"))?;
    Ok(arr.get(slot as usize).and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()))
}

pub(crate) fn first_free_in_map(map: &Value, ambits: &[&str]) -> Option<(String, u64)> {
    ambits.iter().find_map(|amb| {
        let arr = map.get(*amb)?.as_array()?;
        arr.iter()
            .position(|x| x.as_str().map(|s| s.is_empty()).unwrap_or(true))
            .map(|i| (amb.to_string(), i as u64))
    })
}

fn note_failover(what: &str, err: &str) {
    FAILOVERS.fetch_add(1, Ordering::Relaxed);
    let now = crate::hasher::types::now_millis() as u64;
    let last = LAST_FAILOVER_LOG_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) > 60_000 {
        LAST_FAILOVER_LOG_MS.store(now, Ordering::Relaxed);
        tlog(
            "verify",
            Sev::Notice,
            format!("guild verify read failed ({what}): {err} — falling back to the LCD (rate-limited log)"),
        );
    }
}

/// Run the guild read; on error fall back to the LCD read. Both futures are
/// built lazily so the LCD request only happens when needed.
macro_rules! with_failover {
    ($what:expr, $guild:expr, $lcd:expr) => {{
        match source() {
            VerifySource::Guild => {
                let r: Result<_, String> = $guild.await;
                match r {
                    Ok(v) => {
                        GUILD_READS.fetch_add(1, Ordering::Relaxed);
                        Ok(v)
                    }
                    Err(e) => {
                        note_failover($what, &e);
                        LCD_READS.fetch_add(1, Ordering::Relaxed);
                        let r: Result<_, String> = $lcd.await;
                        r
                    }
                }
            }
            VerifySource::Lcd => {
                LCD_READS.fetch_add(1, Ordering::Relaxed);
                let r: Result<_, String> = $lcd.await;
                r
            }
        }
    }};
}

// ── Guild row helpers ────────────────────────────────────────────────────────

/// A guild numeric: JSON number, or the LCD's string form.
pub(crate) fn num_u64(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)),
        Value::String(s) => s.trim().parse::<u64>().ok().or_else(|| s.trim().parse::<f64>().ok().map(|f| f.max(0.0) as u64)),
        _ => None,
    }
}

pub(crate) fn num_f64(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

/// Guild `status` bit-flags (knowledge/mechanics/building.md).
const STATUS_BUILT: u64 = 2;
const STATUS_ONLINE: u64 = 4;
const STATUS_DESTROYED: u64 = 32;

fn require<'a>(row: &'a Value, key: &str, what: &str) -> Result<&'a Value, String> {
    row.get(key).filter(|v| !v.is_null()).ok_or_else(|| format!("{what}: guild row has no `{key}`"))
}

// ── Questions the loops ask ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructState {
    pub built: bool,
    pub online: bool,
    pub destroyed: bool,
    /// Owning player id, when the source reports it (guild rows always do).
    pub owner: Option<String>,
    /// Planet or fleet the struct stands in.
    pub location_id: Option<String>,
}

impl StructState {
    pub fn alive_and_built(&self) -> bool {
        self.built && !self.destroyed
    }
}

pub(crate) fn struct_state_from_guild(row: &Value) -> Result<StructState, String> {
    let status = num_u64(Some(require(row, "status", "struct")?)).ok_or("struct: guild `status` is not numeric")?;
    let destroyed_flag = parse_bool(row.get("is_destroyed"));
    Ok(StructState {
        built: status & STATUS_BUILT != 0,
        online: status & STATUS_ONLINE != 0,
        destroyed: destroyed_flag || status & STATUS_DESTROYED != 0,
        owner: str_field(row, "owner").map(String::from),
        location_id: str_field(row, "location_id").map(String::from),
    })
}

pub(crate) fn struct_state_from_lcd(entity: &Value) -> Result<StructState, String> {
    let sa = entity.get("structAttributes").ok_or("struct: LCD entity has no structAttributes")?;
    let s = entity.get("Struct");
    Ok(StructState {
        built: parse_bool(sa.get("isBuilt")),
        online: parse_bool(sa.get("isOnline")),
        destroyed: parse_bool(sa.get("isDestroyed")),
        owner: s.and_then(|x| str_field(x, "owner")).map(String::from),
        location_id: s.and_then(|x| str_field(x, "locationId")).map(String::from),
    })
}

// ── Attribute sweeps ─────────────────────────────────────────────────────────
//
// The Guild API lists one attribute type across every object at 10,000 rows a
// page (`struct-attribute/type`, `planet-attribute/type`,
// `grid/attribute-type`). That is the fast-changing data the loops verify —
// status, build clock, ore clocks, last action (charge), ore — each a handful
// of calls for the whole galaxy. GRASS streams changes to most of them, so a
// sweep is refreshed at most every `ttl` and patched live in between
// (`on_grass`). The planet ore clocks do NOT stream (measured: zero frames in
// 111k), so theirs is a short TTL instead. A per-action verify is then a
// lookup; only an id the sweep does not know costs a single read.
//
// Row semantics (docs): an attribute row is DELETED when the chain value
// reaches zero — an id missing from a fresh sweep means 0, not "unknown".

const SWEEP_PAGE_LIMIT: usize = 10_000;
const SWEEP_MAX_PAGES: u32 = 30;
/// After a sweep that fails or returns nothing, don't retry for this long.
const SWEEP_BACKOFF_MS: f64 = 10.0 * 60_000.0;
const STREAMED_TTL_MS: f64 = 5.0 * 60_000.0;
const UNSTREAMED_TTL_MS: f64 = 2.0 * 60_000.0;

#[derive(Clone, Copy)]
enum SweepSource {
    StructAttr,
    PlanetAttr,
    Grid,
}

type SweepMap = std::collections::HashMap<String, u64>;

struct Sweep {
    name: &'static str,
    source: SweepSource,
    attribute: &'static str,
    ttl_ms: f64,
    state: std::sync::Mutex<Option<(f64, SweepMap)>>,
    refresh: tokio::sync::Mutex<()>,
    backoff_until_ms: AtomicU64,
    sweeps: AtomicU64,
    patches: AtomicU64,
}

impl Sweep {
    const fn new(name: &'static str, source: SweepSource, attribute: &'static str, ttl_ms: f64) -> Self {
        Sweep {
            name,
            source,
            attribute,
            ttl_ms,
            state: std::sync::Mutex::new(None),
            refresh: tokio::sync::Mutex::const_new(()),
            backoff_until_ms: AtomicU64::new(0),
            sweeps: AtomicU64::new(0),
            patches: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(f64, SweepMap)>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `Some(lookup)` when the sweep is fresh, `None` when it needs a refresh.
    fn fresh_lookup(&self, id: &str) -> Option<Option<u64>> {
        let g = self.lock();
        let (t, m) = g.as_ref()?;
        (now_ms() - t <= self.ttl_ms).then(|| m.get(id).copied())
    }

    async fn page(&self, client: &CosmosClient, page: u32) -> Result<crate::mcp::guild_api::GuildPage<Value>, String> {
        match self.source {
            SweepSource::StructAttr => client.guild.struct_attribute_by_type_limited(self.attribute, page, SWEEP_PAGE_LIMIT).await,
            SweepSource::PlanetAttr => client.guild.planet_attribute_by_type_limited(self.attribute, page, SWEEP_PAGE_LIMIT).await,
            SweepSource::Grid => client.guild.grid_by_attribute_type_limited(self.attribute, page, SWEEP_PAGE_LIMIT).await,
        }
    }

    /// `Ok(Some)` known; `Ok(None)` absent from a fresh sweep (0 on chain, or
    /// not indexed yet); `Err` the sweep is unavailable.
    async fn get(&self, client: &CosmosClient, id: &str) -> Result<Option<u64>, String> {
        if let Some(hit) = self.fresh_lookup(id) {
            return Ok(hit);
        }
        if now_ms() < self.backoff_until_ms.load(Ordering::Relaxed) as f64 {
            return Err(format!("{} sweep backing off after a failed sweep", self.name));
        }
        // Single-flight: whoever gets the lock second finds a fresh map.
        let _flight = self.refresh.lock().await;
        if let Some(hit) = self.fresh_lookup(id) {
            return Ok(hit);
        }
        let mut map = SweepMap::new();
        let mut page = 1;
        let sweep = async {
            loop {
                let p = self.page(client, page).await?;
                let more = p.has_more;
                status_rows_into_map(&p.items, &mut map);
                if !more || page >= SWEEP_MAX_PAGES {
                    break;
                }
                page += 1;
            }
            Ok::<(), String>(())
        }
        .await;
        match sweep {
            Ok(()) if !map.is_empty() => {
                self.sweeps.fetch_add(1, Ordering::Relaxed);
                let hit = map.get(id).copied();
                *self.lock() = Some((now_ms(), map));
                Ok(hit)
            }
            Ok(()) => {
                self.backoff_until_ms.store((now_ms() + SWEEP_BACKOFF_MS) as u64, Ordering::Relaxed);
                Err(format!("{} sweep returned no rows for attribute `{}`", self.name, self.attribute))
            }
            Err(e) => {
                self.backoff_until_ms.store((now_ms() + SWEEP_BACKOFF_MS) as u64, Ordering::Relaxed);
                Err(format!("{} sweep failed on page {page}: {e}", self.name))
            }
        }
    }

    /// GRASS delta. Only patches a sweep that exists (a patch is worthless
    /// without the baseline it corrects).
    fn patch(&self, id: &str, v: u64) {
        if let Some((_, m)) = self.lock().as_mut() {
            m.insert(id.to_string(), v);
            self.patches.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn health(&self) -> Value {
        let g = self.lock();
        serde_json::json!({
            "sweeps": self.sweeps.load(Ordering::Relaxed),
            "size": g.as_ref().map(|(_, m)| m.len()).unwrap_or(0),
            "age_s": g.as_ref().map(|(t, _)| ((now_ms() - t) / 1000.0) as u64),
            "grass_patches": self.patches.load(Ordering::Relaxed),
            "backing_off": now_ms() < self.backoff_until_ms.load(Ordering::Relaxed) as f64,
        })
    }
}

static STATUS_SWEEP: Sweep = Sweep::new("struct_status", SweepSource::StructAttr, "status", STREAMED_TTL_MS);
static BUILD_SWEEP: Sweep = Sweep::new("build_clock", SweepSource::StructAttr, "blockStartBuild", STREAMED_TTL_MS);
static MINE_CLOCK_SWEEP: Sweep = Sweep::new("mine_clock", SweepSource::PlanetAttr, "blockStartOreMine", UNSTREAMED_TTL_MS);
static REFINE_CLOCK_SWEEP: Sweep = Sweep::new("refine_clock", SweepSource::PlanetAttr, "blockStartOreRefine", UNSTREAMED_TTL_MS);
static LAST_ACTION_SWEEP: Sweep = Sweep::new("last_action", SweepSource::Grid, "lastAction", STREAMED_TTL_MS);
static ORE_SWEEP: Sweep = Sweep::new("ore", SweepSource::Grid, "ore", STREAMED_TTL_MS);

fn sweeps_health() -> Value {
    serde_json::json!({
        "struct_status": STATUS_SWEEP.health(),
        "build_clock": BUILD_SWEEP.health(),
        "mine_clock": MINE_CLOCK_SWEEP.health(),
        "refine_clock": REFINE_CLOCK_SWEEP.health(),
        "last_action": LAST_ACTION_SWEEP.health(),
        "ore": ORE_SWEEP.health(),
    })
}

pub(crate) fn status_rows_into_map(rows: &[Value], map: &mut SweepMap) -> usize {
    let mut n = 0;
    for r in rows {
        if let (Some(id), Some(v)) = (str_field(r, "object_id"), num_u64(r.get("val").or_else(|| r.get("value")))) {
            map.insert(id.to_string(), v);
            n += 1;
        }
    }
    n
}

/// GRASS keeps the sweeps current between refreshes. Called for every event
/// the webapp forwards; grid frames are keyed by `object_id`, struct frames
/// by `struct_id`.
pub fn on_grass(category: &str, detail: &Value) {
    match category {
        "struct_status" => {
            if let (Some(id), Some(v)) = (str_field(detail, "struct_id"), num_u64(detail.get("status"))) {
                STATUS_SWEEP.patch(id, v);
            }
        }
        "struct_block_build_start" => {
            if let (Some(id), Some(v)) = (str_field(detail, "struct_id"), num_u64(detail.get("block"))) {
                BUILD_SWEEP.patch(id, v);
            }
        }
        "lastAction" => {
            if let (Some(id), Some(v)) = (str_field(detail, "object_id"), num_u64(detail.get("value"))) {
                LAST_ACTION_SWEEP.patch(id, v);
            }
        }
        "ore" => {
            if let (Some(id), Some(v)) = (str_field(detail, "object_id"), num_u64(detail.get("value"))) {
                ORE_SWEEP.patch(id, v);
            }
        }
        _ => {}
    }
}

pub(crate) fn state_from_status_bits(status: u64) -> StructState {
    StructState {
        built: status & STATUS_BUILT != 0,
        online: status & STATUS_ONLINE != 0,
        destroyed: status & STATUS_DESTROYED != 0,
        owner: None,
        location_id: None,
    }
}

/// Built / online / destroyed for one struct.
pub async fn struct_state(client: &CosmosClient, sid: &str) -> Result<StructState, String> {
    with_failover!(
        "struct",
        async {
            match STATUS_SWEEP.get(client, sid).await {
                Ok(Some(status)) => return Ok(state_from_status_bits(status)),
                // Not in the sweep (new, or zeroed row) or sweep unavailable:
                // one per-struct read, which carries status and health.
                Ok(None) | Err(_) => {}
            }
            struct_state_from_guild(&client.guild.struct_by_id(sid).await?)
        },
        async { struct_state_from_lcd(&crate::mcp::loop_util::verify_struct_entity(client, sid).await?) }
    )
}

/// The struct a defender is currently wired to, if any.
pub async fn defender_target(client: &CosmosClient, defender: &str) -> Result<Option<String>, String> {
    with_failover!(
        "defender",
        async {
            let row = client.guild.struct_defender_by_defending(defender).await?;
            if row.is_null() {
                return Ok(None);
            }
            Ok(str_field(&row, "protected_struct_id").map(String::from))
        },
        async {
            let e = crate::mcp::loop_util::verify_struct_entity(client, defender).await?;
            let idx = read_u64_field(e.get("structAttributes"), "protectedStructIndex");
            Ok(if idx == 0 { None } else { Some(format!("5-{idx}")) })
        }
    )
}

/// The `block_start` of the player's outstanding work item for `object_id`
/// in `category` (BUILD / MINE / REFINE), from the guild work view — the
/// same rows the webapp hashes against. 0 = no such work outstanding.
pub(crate) fn work_anchor(rows: &Value, object_id: &str, category: &str) -> Result<u64, String> {
    let arr = rows.as_array().ok_or("work: guild response is not a list")?;
    let hit = arr.iter().find(|r| {
        str_field(r, "object_id") == Some(object_id)
            && str_field(r, "category").is_some_and(|c| c.eq_ignore_ascii_case(category))
    });
    match hit {
        Some(r) => num_u64(r.get("block_start")).ok_or_else(|| format!("work: {object_id} {category} row has no numeric block_start")),
        None => Ok(0),
    }
}

/// Live BUILD anchor for a struct (0 = built, or no build outstanding).
pub async fn build_anchor(client: &CosmosClient, pid: &str, sid: &str) -> Result<u64, String> {
    with_failover!(
        "build_anchor",
        async {
            match BUILD_SWEEP.get(client, sid).await {
                Ok(Some(v)) => Ok(v),
                // Absent from a fresh sweep = clock 0 (built, or not indexed yet;
                // GRASS `struct_block_build_start` patches a new build in).
                Ok(None) => Ok(0),
                Err(_) => work_anchor(&client.guild.work_by_player(pid).await?, sid, "BUILD"),
            }
        },
        async {
            let e = crate::mcp::loop_util::verify_struct_entity(client, sid).await?;
            Ok(read_u64_field(e.get("structAttributes"), "blockStartBuild"))
        }
    )
}

/// Live ore clock (MINE / REFINE) for a rig. `pid` is the rig's owner when
/// known; on the guild path an unknown owner costs one extra struct read.
/// `planet_id` is the rig's planet, for the LCD path.
pub async fn ore_anchor(
    client: &CosmosClient,
    pid: Option<&str>,
    planet_id: &str,
    sid: &str,
    task_type: &str,
) -> Result<u64, String> {
    with_failover!(
        "ore_anchor",
        async {
            // The planet's shared clock, from the sweep (short TTL: it never
            // streams). Absent from a fresh sweep = 0 = nothing to hash.
            let sweep = if task_type == "REFINE" { &REFINE_CLOCK_SWEEP } else { &MINE_CLOCK_SWEEP };
            match sweep.get(client, planet_id).await {
                Ok(Some(v)) => return Ok(v),
                Ok(None) => return Ok(0),
                Err(_) => {}
            }
            let owner = match pid {
                Some(p) => p.to_string(),
                None => str_field(&object_row(client, sid).await?, "owner")
                    .map(String::from)
                    .ok_or("ore_anchor: struct row has no owner")?,
            };
            work_anchor(&client.guild.work_by_player(&owner).await?, sid, task_type)
        },
        async {
            let p = client.query_entity("planet", planet_id).await?;
            // Fold the live planet back in: the ore clocks never stream.
            crate::mcp::perception::absorb_planet_entity(&p);
            Ok(crate::mcp::loop_util::planet_ore_anchor(Some(&p), task_type))
        }
    )
}

/// Blocks of charge the player has right now.
pub async fn player_charge(client: &CosmosClient, pid: &str, current_block: u64) -> Result<u64, String> {
    with_failover!(
        "charge",
        async {
            match LAST_ACTION_SWEEP.get(client, pid).await {
                Ok(Some(last)) => return Ok(current_block.saturating_sub(last)),
                // No row = never acted = full charge.
                Ok(None) => return Ok(current_block),
                Err(_) => {}
            }
            let v = client.guild.player_last_action_block(pid).await?;
            // `{ "last_action_block_height": "12345" }` — a single row.
            let row = if v.is_array() { v.get(0).cloned().unwrap_or(Value::Null) } else { v };
            let last = num_u64(row.get("last_action_block_height").or_else(|| row.get("val")))
                .ok_or("charge: guild row has no last_action_block_height")?;
            Ok(current_block.saturating_sub(last))
        },
        async {
            let player = client.query_entity("player", pid).await?;
            Ok(current_block.saturating_sub(read_u64_field(player.get("gridAttributes"), "lastAction")))
        }
    )
}

/// What the player's profile says right now: current planet, fleet, stored ore.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerView {
    pub planet_id: String,
    pub fleet_id: String,
    pub stored_ore: f64,
    /// Raw fleet row when the source embeds one (guild player rows do).
    pub fleet_row: Option<Value>,
}

pub(crate) fn player_view_from_guild(row: &Value) -> Result<PlayerView, String> {
    Ok(PlayerView {
        planet_id: str_field(row, "planet_id").unwrap_or("").to_string(),
        fleet_id: str_field(row, "fleet_id").unwrap_or("").to_string(),
        stored_ore: num_f64(row.get("ore")).ok_or("player: guild row has no numeric `ore`")?,
        fleet_row: row.get("fleet").filter(|f| f.is_object()).cloned(),
    })
}

pub(crate) fn player_view_from_lcd(entity: &Value) -> Result<PlayerView, String> {
    let p = entity.get("Player").ok_or("player: LCD entity has no Player")?;
    Ok(PlayerView {
        planet_id: str_field(p, "planetId").unwrap_or("").to_string(),
        fleet_id: str_field(p, "fleetId").unwrap_or("").to_string(),
        stored_ore: parse_f64(entity.get("gridAttributes").and_then(|g| g.get("ore"))),
        fleet_row: None,
    })
}

/// Just the player's current planet or fleet id (`target` = "planet" |
/// "fleet"). Guild path: one batch-cacheable row, no ore needed.
pub async fn player_location(client: &CosmosClient, pid: &str, target: &str) -> Result<String, String> {
    let key = if target == "fleet" { "fleet_id" } else { "planet_id" };
    with_failover!(
        "player_location",
        async {
            let row = object_row(client, pid).await?;
            Ok(str_field(&row, key).unwrap_or("").to_string())
        },
        async { player_view_from_lcd(&client.query_entity("player", pid).await?).map(|v| if target == "fleet" { v.fleet_id } else { v.planet_id }) }
    )
}

pub async fn player_view(client: &CosmosClient, pid: &str) -> Result<PlayerView, String> {
    with_failover!(
        "player",
        async {
            // Location from the batch row, stored ore from the grid sweep;
            // the profile row only when either is unavailable.
            if let (Ok(row), Ok(ore)) = (object_row(client, pid).await, ORE_SWEEP.get(client, pid).await) {
                return Ok(PlayerView {
                    planet_id: str_field(&row, "planet_id").unwrap_or("").to_string(),
                    fleet_id: str_field(&row, "fleet_id").unwrap_or("").to_string(),
                    stored_ore: ore.unwrap_or(0) as f64,
                    fleet_row: None,
                });
            }
            player_view_from_guild(&client.guild.player_by_id(pid).await?)
        },
        async { player_view_from_lcd(&client.query_entity("player", pid).await?) }
    )
}

/// Undiscovered ore left on a planet.
pub async fn planet_ore(client: &CosmosClient, planet_id: &str) -> Result<f64, String> {
    with_failover!(
        "planet_ore",
        async {
            match ORE_SWEEP.get(client, planet_id).await {
                Ok(Some(v)) => return Ok(v as f64),
                // Row deleted at zero: a drained planet.
                Ok(None) => return Ok(0.0),
                Err(_) => {}
            }
            let row = client.guild.planet_by_id(planet_id).await?;
            num_f64(row.get("undiscovered_ore")).ok_or_else(|| "planet: guild row has no numeric undiscovered_ore".to_string())
        },
        async {
            let p = client.query_entity("planet", planet_id).await?;
            Ok(parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))))
        }
    )
}

/// Is `ambit` slot `slot` of planet/fleet `loc` occupied by a live struct?
pub(crate) fn slot_occupied_in_rows(rows: &[Value], ambit: &str, slot: u64) -> bool {
    rows.iter().any(|r| {
        !parse_bool(r.get("is_destroyed"))
            && str_field(r, "operating_ambit").is_some_and(|a| a.eq_ignore_ascii_case(ambit))
            && num_u64(r.get("slot")) == Some(slot)
    })
}

pub async fn slot_occupied(client: &CosmosClient, target: &str, loc: &str, ambit: &str, slot: u64) -> Result<bool, String> {
    with_failover!(
        "slot",
        async {
            // The planet/fleet row's own slot arrays — exact, one batchable
            // read, and the same shape the LCD path checks.
            let map = slot_map(&object_row(client, loc).await?)?;
            slot_occupied_in_map(&map, ambit, slot)
        },
        async {
            let entity = client.query_entity(target, loc).await?;
            if target == "planet" {
                crate::mcp::perception::absorb_planet_entity(&entity);
            }
            let wrapper = if target == "fleet" { "Fleet" } else { "Planet" };
            Ok(entity
                .get(wrapper)
                .and_then(|o| o.get(ambit))
                .and_then(|a| a.as_array())
                .and_then(|a| a.get(slot as usize))
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty()))
        }
    )
}

/// First free slot on a planet/fleet, trying `ambits` in order.
pub async fn first_free_slot(client: &CosmosClient, target: &str, loc: &str, ambits: &[&str]) -> Result<Option<(String, u64)>, String> {
    with_failover!(
        "free_slot",
        async { Ok(first_free_in_map(&slot_map(&object_row(client, loc).await?)?, ambits)) },
        async {
            let entity = client.query_entity(target, loc).await?;
            let wrapper = if target == "fleet" { "Fleet" } else { "Planet" };
            Ok(entity.get(wrapper).and_then(|m| first_free_in_map(m, ambits)))
        }
    )
}

/// The fleet's Command Ship id, if it has one. Guild path: the fleet row
/// from the batch endpoint (`command_struct`).
pub async fn fleet_command_struct(client: &CosmosClient, _pid: &str, fleet_id: &str) -> Result<Option<String>, String> {
    with_failover!(
        "fleet_command",
        async {
            let fleet = object_row(client, fleet_id).await?;
            // An empty/absent command field on a present fleet row means "none".
            Ok(str_field(&fleet, "command_struct").map(String::from))
        },
        async {
            let fleet = client.query_entity("fleet", fleet_id).await?;
            Ok(fleet
                .get("Fleet")
                .and_then(|f| str_field(f, "commandStruct"))
                .map(String::from))
        }
    )
}

/// For a solved proof about to be signed: the anchor the chain holds NOW for
/// `object_id`'s `task_kind` (BUILD / MINE / REFINE), plus the rig's planet
/// (ore kinds) and owner when the source reports them. `Ok(0)` = unknown or
/// no work outstanding; callers treat that as "don't block".
pub async fn solved_anchor_live(
    client: &CosmosClient,
    object_id: &str,
    task_kind: &str,
) -> Result<(u64, Option<String>, Option<String>), String> {
    let is_ore = matches!(task_kind, "MINE" | "REFINE");
    with_failover!(
        "solved_anchor",
        async {
            // Base struct row is enough here: owner + location, no status needed.
            let row = object_row(client, object_id).await?;
            let owner = str_field(&row, "owner").map(String::from).ok_or("solved_anchor: struct row has no owner")?;
            let location = str_field(&row, "location_id").map(String::from);
            // Sweeps first (a lookup), the work view only if a sweep is down.
            let swept = if is_ore {
                match location.as_deref() {
                    Some(planet) => {
                        let sweep = if task_kind == "REFINE" { &REFINE_CLOCK_SWEEP } else { &MINE_CLOCK_SWEEP };
                        sweep.get(client, planet).await.ok()
                    }
                    None => None,
                }
            } else {
                BUILD_SWEEP.get(client, object_id).await.ok()
            };
            let live = match swept {
                Some(v) => v.unwrap_or(0),
                None => work_anchor(&client.guild.work_by_player(&owner).await?, object_id, task_kind)?,
            };
            Ok((live, if is_ore { location } else { None }, Some(owner)))
        },
        async {
            let e = client.query_entity("struct", object_id).await?;
            let owner = e.get("Struct").and_then(|s| str_field(s, "owner")).map(String::from);
            if !is_ore {
                return Ok((read_u64_field(e.get("structAttributes"), "blockStartBuild"), None, owner));
            }
            // Chain v0.21.0: the ore clock hangs off the PLANET the rig stands
            // on; a planetary struct's locationId IS its planet id.
            let Some(planet_id) = e.get("Struct").and_then(|s| str_field(s, "locationId")).map(String::from) else {
                return Ok((0, None, owner));
            };
            let live = match client.query_entity("planet", &planet_id).await {
                Ok(p) => crate::mcp::loop_util::planet_ore_anchor(Some(&p), task_kind),
                Err(_) => 0,
            };
            Ok((live, Some(planet_id), owner))
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guild_status_bits_decode_built_online_destroyed() {
        let s = struct_state_from_guild(&json!({"status": 7, "is_destroyed": false, "owner": "1-195", "location_id": "2-22432"})).unwrap();
        assert!(s.built && s.online && !s.destroyed);
        assert_eq!(s.owner.as_deref(), Some("1-195"));
        // Status as an LCD-style string, destroyed via the flag.
        let d = struct_state_from_guild(&json!({"status": "35", "is_destroyed": false})).unwrap();
        assert!(d.destroyed && d.built);
        let d2 = struct_state_from_guild(&json!({"status": 3, "is_destroyed": true})).unwrap();
        assert!(d2.destroyed);
        // Materialized only: not built.
        let m = struct_state_from_guild(&json!({"status": 1, "is_destroyed": false})).unwrap();
        assert!(!m.built && !m.online);
        // Missing status is an error, never "not built".
        assert!(struct_state_from_guild(&json!({"is_destroyed": false})).is_err());
    }

    #[test]
    fn lcd_struct_state_reads_the_attribute_flags() {
        let e = json!({"Struct": {"owner": "1-1", "locationId": "2-9"},
            "structAttributes": {"isBuilt": true, "isOnline": "false", "isDestroyed": false}});
        let s = struct_state_from_lcd(&e).unwrap();
        assert!(s.built && !s.online && !s.destroyed);
        assert_eq!(s.location_id.as_deref(), Some("2-9"));
    }

    #[test]
    fn work_anchor_matches_whole_ids_and_category() {
        let rows = json!([
            {"object_id": "5-195", "category": "MINE", "block_start": "2455000"},
            {"object_id": "5-1950", "category": "MINE", "block_start": 2456000},
            {"object_id": "5-195", "category": "BUILD", "block_start": 10}
        ]);
        assert_eq!(work_anchor(&rows, "5-195", "MINE").unwrap(), 2455000);
        assert_eq!(work_anchor(&rows, "5-1950", "mine").unwrap(), 2456000);
        assert_eq!(work_anchor(&rows, "5-195", "BUILD").unwrap(), 10);
        assert_eq!(work_anchor(&rows, "5-19", "MINE").unwrap(), 0, "no prefix matching");
        assert!(work_anchor(&json!({"not": "a list"}), "5-195", "MINE").is_err());
        assert!(work_anchor(&json!([{"object_id": "5-195", "category": "MINE", "block_start": "x"}]), "5-195", "MINE").is_err());
    }

    #[test]
    fn status_sweep_rows_and_grass_patches_decode_to_state() {
        let mut map = std::collections::HashMap::new();
        let rows = vec![
            json!({"object_id": "5-1", "val": "7"}),
            json!({"object_id": "5-2", "val": 35}),
            json!({"object_id": "5-3", "value": 1}),
            json!({"object_id": "5-4"}),
        ];
        assert_eq!(status_rows_into_map(&rows, &mut map), 3);
        assert!(state_from_status_bits(map["5-1"]).online);
        assert!(state_from_status_bits(map["5-2"]).destroyed);
        assert!(!state_from_status_bits(map["5-3"]).built);
        // GRASS frames (verbatim shapes) patch a live sweep — and only a live one.
        on_grass("struct_status", &json!({"struct_id": "5-9", "status": 7}));
        assert!(STATUS_SWEEP.lock().is_none(), "no baseline, no patch");
        *STATUS_SWEEP.lock() = Some((now_ms(), map));
        on_grass("struct_status", &json!({"struct_id": "5-3", "status": 7, "status_old": 1, "player_id": "1-382"}));
        on_grass("struct_health", &json!({"struct_id": "5-3", "health": 0}));
        assert_eq!(STATUS_SWEEP.lock().as_ref().unwrap().1["5-3"], 7);
        assert_eq!(STATUS_SWEEP.fresh_lookup("5-3"), Some(Some(7)));
        assert_eq!(STATUS_SWEEP.fresh_lookup("5-404"), Some(None), "fresh sweep, unknown id = absent");
        *STATUS_SWEEP.lock() = None;
        assert_eq!(STATUS_SWEEP.fresh_lookup("5-3"), None, "no sweep = needs a refresh");

        // Grid frames key by object_id; the build clock by struct_id + block.
        *LAST_ACTION_SWEEP.lock() = Some((now_ms(), SweepMap::new()));
        on_grass("lastAction", &json!({"attribute_type": "lastAction", "object_id": "1-1810", "object_type": "player", "value": 2468355, "value_old": 2468321}));
        assert_eq!(LAST_ACTION_SWEEP.fresh_lookup("1-1810"), Some(Some(2468355)));
        *LAST_ACTION_SWEEP.lock() = None;
        *BUILD_SWEEP.lock() = Some((now_ms(), SweepMap::new()));
        on_grass("struct_block_build_start", &json!({"block": 2352382, "block_height": 2352382, "planet_id": "2-16116", "struct_id": "5-192029"}));
        assert_eq!(BUILD_SWEEP.fresh_lookup("5-192029"), Some(Some(2352382)));
        *BUILD_SWEEP.lock() = None;
    }

    #[test]
    fn a_stale_sweep_asks_for_a_refresh() {
        *ORE_SWEEP.lock() = Some((now_ms() - STREAMED_TTL_MS - 1.0, SweepMap::from([("2-1".to_string(), 5u64)])));
        assert_eq!(ORE_SWEEP.fresh_lookup("2-1"), None);
        *ORE_SWEEP.lock() = None;
    }

    #[test]
    fn slot_maps_come_as_json_strings_on_batch_rows() {
        // Verbatim from a live `/api/objects?ids=` planet row (2026-09-04).
        let row = json!({"id": "2-22432", "map": "{\"air\": [\"\", \"\", \"\", \"\"], \"land\": [\"5-236182\", \"5-192030\", \"\", \"\"], \"space\": [\"5-232859\", \"5-205581\", \"\", \"\"], \"water\": [\"\", \"5-237384\", \"\", \"\"]}"});
        let map = slot_map(&row).unwrap();
        assert!(slot_occupied_in_map(&map, "land", 1).unwrap());
        assert!(!slot_occupied_in_map(&map, "land", 2).unwrap());
        assert!(!slot_occupied_in_map(&map, "air", 0).unwrap());
        assert!(slot_occupied_in_map(&map, "orbit", 0).is_err(), "unknown ambit is an error, not free");
        assert_eq!(first_free_in_map(&map, &["land", "water", "air", "space"]), Some(("land".to_string(), 2)));
        assert_eq!(first_free_in_map(&map, &["water"]), Some(("water".to_string(), 0)));
        // A full ambit yields nothing from that ambit.
        let full = json!({"air": ["5-1", "5-2"]});
        assert_eq!(first_free_in_map(&full, &["air"]), None);
        assert!(slot_map(&json!({"id": "9-1"})).is_err());
    }

    #[test]
    fn slot_occupancy_ignores_destroyed_and_other_ambits() {
        let rows = vec![
            json!({"operating_ambit": "space", "slot": 0, "is_destroyed": false}),
            json!({"operating_ambit": "land", "slot": 1, "is_destroyed": true}),
            json!({"operating_ambit": "air", "slot": "2", "is_destroyed": false}),
        ];
        assert!(slot_occupied_in_rows(&rows, "space", 0));
        assert!(!slot_occupied_in_rows(&rows, "land", 1), "a destroyed hull frees its slot");
        assert!(slot_occupied_in_rows(&rows, "AIR", 2));
        assert!(!slot_occupied_in_rows(&rows, "water", 0));
    }

    #[test]
    fn player_view_reads_guild_and_lcd_shapes() {
        let g = player_view_from_guild(&json!({"planet_id": "2-1", "fleet_id": "9-11", "ore": "17", "fleet": {"command_struct": "5-3"}})).unwrap();
        assert_eq!((g.planet_id.as_str(), g.fleet_id.as_str(), g.stored_ore), ("2-1", "9-11", 17.0));
        assert!(g.fleet_row.is_some());
        assert!(player_view_from_guild(&json!({"planet_id": "2-1"})).is_err(), "ore is required");
        let l = player_view_from_lcd(&json!({"Player": {"planetId": "2-2", "fleetId": "9-2"}, "gridAttributes": {"ore": "3"}})).unwrap();
        assert_eq!((l.planet_id.as_str(), l.stored_ore), ("2-2", 3.0));
    }

    #[test]
    fn source_knob_parses_and_defaults_to_guild() {
        assert_eq!(VerifySource::parse("guild"), Some(VerifySource::Guild));
        assert_eq!(VerifySource::parse("LCD"), Some(VerifySource::Lcd));
        assert_eq!(VerifySource::parse("chain"), Some(VerifySource::Lcd));
        assert_eq!(VerifySource::parse("nope"), None);
        assert!(!set_source("nope"));
    }

    #[test]
    fn numerics_accept_numbers_and_strings() {
        assert_eq!(num_u64(Some(&json!("2455000"))), Some(2455000));
        assert_eq!(num_u64(Some(&json!(7))), Some(7));
        assert_eq!(num_u64(Some(&json!("abc"))), None);
        assert_eq!(num_u64(None), None);
        assert_eq!(num_f64(Some(&json!("1.5"))), Some(1.5));
    }
}
