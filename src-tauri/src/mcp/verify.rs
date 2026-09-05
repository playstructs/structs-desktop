//! Pre-sign verification reads, answered from the local source of truth.
//!
//! Every loop scans from the perception snapshot and then, right before it
//! signs, re-checks the one or two facts that decide the action (a slot is
//! free, a rig is online, the ore clock has not moved, a hull is still
//! built). Those checks used to be one to three requests to the chain's LCD
//! per action — thousands an hour at fleet scale against the public node.
//!
//! The snapshot IS the answer now. It is bulk-loaded from the indexer's
//! catalog (`perception::guild_pages`, ~45 requests for the galaxy), patched
//! live by GRASS, and its one non-streaming store — the planet ore clocks —
//! is re-swept every two minutes (`perception::hot_refresh_ore_clocks`). So a
//! verify is a memory lookup. A miss (an id the snapshot does not hold, a
//! snapshot too old to trust, none loaded yet) costs one Guild API read; the
//! chain is the last resort, or the whole layer when `verify_source` is
//! `lcd`.
//!
//! Contract on the guild path: a missing or unparseable field is an `Err`,
//! never a silent default — a default of 0 for an ore anchor is exactly how
//! a proof gets solved against the wrong clock. On an error the LCD path is
//! tried (counted as a failover, logged rate-limited), so a lapsed guild
//! session degrades to the old behaviour instead of stopping every loop.

use serde_json::Value;

use crate::mcp::types::{Block, Charge, FleetId, LocationKind, ObjectId, PlanetId, PlayerId, StructId, TaskType};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::loop_util::{parse_bool, parse_f64};
use crate::mcp::perception::{self, Snapshot};
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

static SNAPSHOT_HITS: AtomicU64 = AtomicU64::new(0);
static GUILD_READS: AtomicU64 = AtomicU64::new(0);
static LCD_READS: AtomicU64 = AtomicU64::new(0);
static FAILOVERS: AtomicU64 = AtomicU64::new(0);
static LAST_FAILOVER_LOG_MS: AtomicU64 = AtomicU64::new(0);

/// The snapshot answers verification while younger than this. A refresh is
/// due every `REFRESH_EVERY_MS`; two and a half missed refreshes means the
/// bulk source is down and the per-entity reads should carry the load.
const SNAPSHOT_TRUST_MS: f64 = 2.5 * perception::REFRESH_EVERY_MS;
/// The ore clocks answer while the hot refresh is younger than this.
const HOT_TRUST_MS: f64 = 2.5 * perception::HOT_REFRESH_EVERY_MS;

pub fn health() -> Value {
    serde_json::json!({
        "source": source().name(),
        "snapshot_hits": SNAPSHOT_HITS.load(Ordering::Relaxed),
        "guild_reads": GUILD_READS.load(Ordering::Relaxed),
        "lcd_reads": LCD_READS.load(Ordering::Relaxed),
        "failovers_to_lcd": FAILOVERS.load(Ordering::Relaxed),
        "snapshot_trusted": perception::with_snapshot(|s| s.age_ms() <= SNAPSHOT_TRUST_MS).unwrap_or(false),
        "ore_clocks_trusted": clocks_hot(),
    })
}

fn now_ms() -> f64 {
    crate::hasher::types::now_millis()
}

fn note_failover(what: &str, err: &str) {
    FAILOVERS.fetch_add(1, Ordering::Relaxed);
    let now = now_ms() as u64;
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

/// A lookup in the trusted snapshot. `None` = not answerable from memory.
fn snap<R>(f: impl FnOnce(&Snapshot) -> Option<R>) -> Option<R> {
    if source() == VerifySource::Lcd {
        return None;
    }
    let r = perception::with_snapshot(|s| if s.age_ms() <= SNAPSHOT_TRUST_MS { f(s) } else { None }).flatten();
    if r.is_some() {
        SNAPSHOT_HITS.fetch_add(1, Ordering::Relaxed);
    }
    r
}

fn clocks_hot() -> bool {
    // Either the work-view sweep is recent, or the native GRASS stream is
    // live: every clock restart arrives as a struct_block_ore_*_start frame
    // and is folded into the snapshot within a second, which is fresher
    // than any sweep. (The guild work view now pages at 100 rows and 500s
    // on deep pages, so the sweep alone left the clocks "untrusted" for
    // most of an hour on 2026-09-05 — 1,802 per-entity guild reads it did
    // not need.)
    perception::hot_age_ms().is_some_and(|a| a <= HOT_TRUST_MS)
        || (crate::mcp::grass_native::authoritative()
            && perception::with_snapshot(|s| s.age_ms() <= SNAPSHOT_TRUST_MS).unwrap_or(false))
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

// ── Row helpers ──────────────────────────────────────────────────────────────

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

fn require<'a>(row: &'a Value, key: &str, what: &str) -> Result<&'a Value, String> {
    row.get(key).filter(|v| !v.is_null()).ok_or_else(|| format!("{what}: guild row has no `{key}`"))
}

// ── Questions the loops ask ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructState {
    pub built: bool,
    pub online: bool,
    pub destroyed: bool,
    /// Owning player, when the source reports one that parses.
    pub owner: Option<PlayerId>,
    /// Planet or fleet the struct stands in, when it parses.
    pub location_id: Option<ObjectId>,
}

impl StructState {
    pub fn alive_and_built(&self) -> bool {
        self.built && !self.destroyed
    }
}

pub(crate) fn state_from_status_bits(status: u64) -> StructState {
    use perception::status as st;
    StructState {
        built: status & st::BUILT != 0,
        online: status & st::ONLINE != 0,
        destroyed: status & st::DESTROYED != 0,
        owner: None,
        location_id: None,
    }
}

pub(crate) fn struct_state_from_guild(row: &Value) -> Result<StructState, String> {
    let status = num_u64(Some(require(row, "status", "struct")?)).ok_or("struct: guild `status` is not numeric")?;
    let mut s = state_from_status_bits(status);
    s.destroyed = s.destroyed || parse_bool(row.get("is_destroyed"));
    s.owner = str_field(row, "owner").and_then(|o| PlayerId::parse(o).ok());
    s.location_id = str_field(row, "location_id").and_then(|l| ObjectId::parse(l).ok());
    Ok(s)
}

pub(crate) fn struct_state_from_lcd(entity: &Value) -> Result<StructState, String> {
    let sa = entity.get("structAttributes").ok_or("struct: LCD entity has no structAttributes")?;
    let s = entity.get("Struct");
    Ok(StructState {
        built: parse_bool(sa.get("isBuilt")),
        online: parse_bool(sa.get("isOnline")),
        destroyed: parse_bool(sa.get("isDestroyed")),
        owner: s.and_then(|x| str_field(x, "owner")).and_then(|o| PlayerId::parse(o).ok()),
        location_id: s.and_then(|x| str_field(x, "locationId")).and_then(|l| ObjectId::parse(l).ok()),
    })
}

/// Built / online / destroyed for one struct.
pub async fn struct_state(client: &CosmosClient, sid: &StructId) -> Result<StructState, String> {
    if let Some(s) = snap(|s| {
        s.struct_row(sid.as_str()).map(|row| {
            let mut st = state_from_status_bits(s.struct_status(sid.as_str()));
            st.owner = PlayerId::parse(&row.owner).ok();
            st.location_id = ObjectId::parse(&row.location_id).ok();
            st
        })
    }) {
        return Ok(s);
    }
    struct_state_live(client, sid).await
}

/// [`struct_state`] that skips the snapshot: the indexed source (guild, LCD
/// on failover), never what we believe. For the one decision where a stale
/// belief costs a signed transaction — completing a build the chain already
/// completed. Measured 2026-09-04: ~20% of GRASS frames never reach the
/// snapshot (see structs-config.js grass tap stats), so a struct can sit
/// "building" here long after it went Online there.
pub async fn struct_state_live(client: &CosmosClient, sid: &StructId) -> Result<StructState, String> {
    with_failover!(
        "struct",
        async { struct_state_from_guild(&client.guild.struct_by_id(sid.as_str()).await?) },
        async { struct_state_from_lcd(&crate::mcp::loop_util::verify_struct_entity(client, sid.as_str()).await?) }
    )
}

/// The struct a defender is currently wired to, if any.
pub async fn defender_target(client: &CosmosClient, defender: &StructId) -> Result<Option<StructId>, String> {
    if let Some(t) = snap(|s| {
        s.struct_attr(defender.as_str(), "protectedStructIndex")
            .map(|i| if i == 0 { None } else { Some(StructId::from_index(i)) })
    }) {
        return Ok(t);
    }
    defender_target_live(client, defender).await
}

/// [`defender_target`] that skips the snapshot — the pre-sign read for a
/// defense clear. The indexer's `struct_attribute` rows for
/// `protectedStructIndex` were left stale by the v0.21.0 wipe of planetary
/// defenders (an upsert never revisits an unchanged row), so the snapshot
/// can hold a link the chain dropped: "is not_defending but must be
/// defending for defense_clear", 15 in the first hour of the native build.
pub async fn defender_target_live(client: &CosmosClient, defender: &StructId) -> Result<Option<StructId>, String> {
    with_failover!(
        "defender",
        async {
            let row = client.guild.struct_defender_by_defending(defender.as_str()).await?;
            if row.is_null() {
                return Ok(None);
            }
            match str_field(&row, "protected_struct_id") {
                None => Ok(None),
                Some(p) => StructId::parse(p).map(Some).map_err(|e| format!("defender: {e}")),
            }
        },
        async {
            let e = crate::mcp::loop_util::verify_struct_entity(client, defender.as_str()).await?;
            let idx = crate::mcp::types::EntityView::new(&e).struct_attr_u64("protectedStructIndex");
            Ok(if idx == 0 { None } else { Some(StructId::from_index(idx)) })
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
pub async fn build_anchor(client: &CosmosClient, sid: &StructId) -> Result<Block, String> {
    if let Some(a) = snap(|s| s.struct_attr(sid.as_str(), "blockStartBuild")) {
        return Ok(Block::new(a));
    }
    // The chain's struct entity, not the guild work view: the view is a join
    // over stores the snapshot already holds, and on a snapshot miss the
    // one object we need is a single LCD read (see mcp/perception.rs on why
    // the view was retired, 2026-09-05).
    LCD_READS.fetch_add(1, Ordering::Relaxed);
    let e = crate::mcp::loop_util::verify_struct_entity(client, sid.as_str()).await?;
    Ok(crate::mcp::types::EntityView::new(&e).struct_block("blockStartBuild"))
}

/// Live ore clock (MINE / REFINE) of `planet`. From the snapshot only while
/// the clocks are trusted (native GRASS authoritative, or a hot refresh
/// within the window); otherwise the planet entity itself, folded back in.
pub async fn ore_anchor(client: &CosmosClient, planet: &PlanetId, kind: TaskType) -> Result<Block, String> {
    let attr = kind.planet_clock_attr().ok_or_else(|| format!("{kind} has no ore clock"))?;
    if clocks_hot() {
        if let Some(a) = snap(|s| s.planet_attr(planet.as_str(), attr)) {
            return Ok(Block::new(a));
        }
    }
    LCD_READS.fetch_add(1, Ordering::Relaxed);
    let p = client.query_entity("planet", planet.as_str()).await?;
    perception::absorb_planet_entity(&p);
    Ok(Block::new(crate::mcp::loop_util::planet_ore_anchor(Some(&p), kind)))
}

/// Blocks of charge the player has at `current`.
pub async fn player_charge(client: &CosmosClient, pid: &PlayerId, current: Block) -> Result<Charge, String> {
    if let Some(c) = snap(|s| s.grid_attr(pid.as_str(), "lastAction").map(|la| current.since(Block::new(la)))) {
        return Ok(Charge::new(c));
    }
    with_failover!(
        "charge",
        async {
            let v = client.guild.player_last_action_block(pid.as_str()).await?;
            // `{ "last_action_block_height": "12345" }` — a single row.
            let row = if v.is_array() { v.get(0).cloned().unwrap_or(Value::Null) } else { v };
            let last = num_u64(row.get("last_action_block_height").or_else(|| row.get("val")))
                .ok_or("charge: guild row has no last_action_block_height")?;
            Ok(Charge::new(current.since(Block::new(last))))
        },
        async {
            let player = client.query_entity("player", pid.as_str()).await?;
            Ok(Charge::new(current.since(crate::mcp::types::EntityView::new(&player).last_action())))
        }
    )
}

/// What the player's profile says right now: current planet, fleet, stored ore.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerView {
    /// None = no planet (a fresh member who has not explored).
    pub planet_id: Option<PlanetId>,
    pub fleet_id: Option<FleetId>,
    pub stored_ore: f64,
}

impl PlayerView {
    pub fn location(&self, kind: LocationKind) -> Option<ObjectId> {
        match kind {
            LocationKind::Planet => self.planet_id.as_ref().map(|p| p.object_id()),
            LocationKind::Fleet => self.fleet_id.as_ref().map(|f| f.object_id()),
        }
    }
}

pub(crate) fn player_view_from_guild(row: &Value) -> Result<PlayerView, String> {
    Ok(PlayerView {
        planet_id: str_field(row, "planet_id").and_then(|p| PlanetId::parse(p).ok()),
        fleet_id: str_field(row, "fleet_id").and_then(|f| FleetId::parse(f).ok()),
        stored_ore: num_f64(row.get("ore")).ok_or("player: guild row has no numeric `ore`")?,
    })
}

pub(crate) fn player_view_from_lcd(entity: &Value) -> Result<PlayerView, String> {
    let p = entity.get("Player").ok_or("player: LCD entity has no Player")?;
    Ok(PlayerView {
        planet_id: str_field(p, "planetId").and_then(|x| PlanetId::parse(x).ok()),
        fleet_id: str_field(p, "fleetId").and_then(|x| FleetId::parse(x).ok()),
        stored_ore: parse_f64(entity.get("gridAttributes").and_then(|g| g.get("ore"))),
    })
}

pub async fn player_view(client: &CosmosClient, pid: &PlayerId) -> Result<PlayerView, String> {
    if let Some(v) = snap(|s| {
        s.player_row(pid.as_str()).map(|p| PlayerView {
            planet_id: str_field(p, "planetId").and_then(|x| PlanetId::parse(x).ok()),
            fleet_id: str_field(p, "fleetId").and_then(|x| FleetId::parse(x).ok()),
            stored_ore: s.grid_attr(pid.as_str(), "ore").unwrap_or(0) as f64,
        })
    }) {
        return Ok(v);
    }
    player_view_live(client, pid).await
}

/// [`player_view`] that skips the snapshot: the indexed source, never what
/// we believe. The pre-sign read for an EXPLORE — the one action whose
/// precondition ("my current planet is mined out") is about a planet the
/// snapshot may have already been moved off of.
pub async fn player_view_live(client: &CosmosClient, pid: &PlayerId) -> Result<PlayerView, String> {
    with_failover!(
        "player",
        async { player_view_from_guild(&client.guild.player_by_id(pid.as_str()).await?) },
        async { player_view_from_lcd(&client.query_entity("player", pid.as_str()).await?) }
    )
}

/// Just the player's current planet or fleet. `Ok(None)` = has none.
pub async fn player_location(client: &CosmosClient, pid: &PlayerId, kind: LocationKind) -> Result<Option<ObjectId>, String> {
    Ok(player_view(client, pid).await?.location(kind))
}

/// Undiscovered ore left on a planet.
pub async fn planet_ore(client: &CosmosClient, planet: &PlanetId) -> Result<f64, String> {
    if let Some(o) = snap(|s| s.grid_attr(planet.as_str(), "ore").map(|v| v as f64)) {
        return Ok(o);
    }
    planet_ore_live(client, planet).await
}

/// [`planet_ore`] that skips the snapshot (see `player_view_live`).
pub async fn planet_ore_live(client: &CosmosClient, planet: &PlanetId) -> Result<f64, String> {
    with_failover!(
        "planet_ore",
        async {
            let row = client.guild.planet_by_id(planet.as_str()).await?;
            num_f64(row.get("undiscovered_ore")).ok_or_else(|| "planet: guild row has no numeric undiscovered_ore".to_string())
        },
        async {
            let p = client.query_entity("planet", planet.as_str()).await?;
            Ok(parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))))
        }
    )
}

/// A planet/fleet row's slot arrays: inline (`land`/`water`/`air`/`space`,
/// the LCD and snapshot shape) or a guild `map` (JSON string or object).
pub(crate) fn slot_map(row: &Value) -> Result<Value, String> {
    if ["land", "water", "air", "space"].iter().any(|a| row.get(*a).is_some_and(|v| v.is_array())) {
        return Ok(row.clone());
    }
    match row.get("map") {
        Some(Value::String(s)) => serde_json::from_str(s).map_err(|e| format!("map is not JSON: {e}")),
        Some(v @ Value::Object(_)) => Ok(v.clone()),
        _ => Err("row has no slot arrays or `map`".to_string()),
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

/// The guild batch row for a planet or fleet (slot arrays, command struct).
async fn guild_object_row(client: &CosmosClient, id: &str) -> Result<Value, String> {
    let (rows, _) = client.guild.objects_by_ids(&[id]).await?;
    rows.iter()
        .find(|r| r.get("id").and_then(|x| x.as_str()) == Some(id))
        .and_then(|r| r.get("object"))
        .filter(|o| o.is_object())
        .cloned()
        .ok_or_else(|| format!("Guild API objects has no {id}"))
}

fn location_row(s: &Snapshot, kind: LocationKind, loc: &str) -> Option<Value> {
    match kind {
        LocationKind::Fleet => s.fleet_row(loc),
        LocationKind::Planet => s.planet_row(loc),
    }
    .cloned()
}

/// A planet or fleet id, with its kind decided by the id itself.
fn location_kind(loc: &ObjectId) -> Result<LocationKind, String> {
    LocationKind::of(loc).ok_or_else(|| format!("{loc} is neither a planet nor a fleet"))
}

/// Is `ambit` slot `slot` of planet/fleet `loc` occupied by a live struct?
pub async fn slot_occupied(client: &CosmosClient, loc: &ObjectId, ambit: &str, slot: u64) -> Result<bool, String> {
    let kind = location_kind(loc)?;
    let id = loc.to_string();
    if let Some(o) = snap(|s| location_row(s, kind, &id).and_then(|row| slot_occupied_in_map(&row, ambit, slot).ok())) {
        return Ok(o);
    }
    slot_occupied_live(client, loc, ambit, slot).await
}

/// [`slot_occupied`] that skips the snapshot — the pre-sign check for a build
/// initiate, where a slot the snapshot still shows free (its struct_status
/// frame lost) costs a rejected tx and a 30-minute back-off for that player.
pub async fn slot_occupied_live(client: &CosmosClient, loc: &ObjectId, ambit: &str, slot: u64) -> Result<bool, String> {
    let kind = location_kind(loc)?;
    let id = loc.to_string();
    with_failover!(
        "slot",
        async { slot_occupied_in_map(&slot_map(&guild_object_row(client, &id).await?)?, ambit, slot) },
        async {
            let entity = client.query_entity(kind.as_str(), &id).await?;
            if kind == LocationKind::Planet {
                perception::absorb_planet_entity(&entity);
            }
            let wrapper = kind.lcd_wrapper();
            let row = entity.get(wrapper).ok_or_else(|| format!("{kind} {id}: LCD entity has no {wrapper}"))?;
            slot_occupied_in_map(row, ambit, slot)
        }
    )
}

/// First free slot on a planet/fleet, trying `ambits` in order.
pub async fn first_free_slot(client: &CosmosClient, loc: &ObjectId, ambits: &[&str]) -> Result<Option<(String, u64)>, String> {
    let kind = location_kind(loc)?;
    let id = loc.to_string();
    if let Some(f) = snap(|s| location_row(s, kind, &id).map(|row| first_free_in_map(&row, ambits))) {
        return Ok(f);
    }
    with_failover!(
        "free_slot",
        async { Ok(first_free_in_map(&slot_map(&guild_object_row(client, &id).await?)?, ambits)) },
        async {
            let entity = client.query_entity(kind.as_str(), &id).await?;
            Ok(entity.get(kind.lcd_wrapper()).and_then(|m| first_free_in_map(m, ambits)))
        }
    )
}

/// The fleet's Command Ship, if it has one. An empty or unparsable command
/// field on a present fleet row means "none".
pub async fn fleet_command_struct(client: &CosmosClient, fleet: &FleetId) -> Result<Option<StructId>, String> {
    let cmd = |v: Option<&str>| v.and_then(|c| StructId::parse(c).ok());
    if let Some(c) = snap(|s| s.fleet_row(fleet.as_str()).map(|f| cmd(str_field(f, "commandStruct")))) {
        return Ok(c);
    }
    with_failover!(
        "fleet_command",
        async {
            let row = guild_object_row(client, fleet.as_str()).await?;
            Ok(cmd(str_field(&row, "command_struct")))
        },
        async {
            let row = client.query_entity("fleet", fleet.as_str()).await?;
            Ok(cmd(row.get("Fleet").and_then(|f| str_field(f, "commandStruct"))))
        }
    )
}

/// For a solved proof about to be signed: the anchor the chain holds NOW for
/// `object_id`'s `task_kind` (BUILD / MINE / REFINE), plus the rig's planet
/// (ore kinds) and owner when known. `Ok(0)` = unknown or no work
/// outstanding; callers treat that as "don't block".
pub async fn solved_anchor_live(
    client: &CosmosClient,
    object: &StructId,
    kind: TaskType,
) -> Result<(Block, Option<PlanetId>, Option<PlayerId>), String> {
    // Owner and location from the snapshot's struct row, then the anchor
    // through the same source-aware readers every loop uses.
    if let Some((owner, location)) = snap(|s| s.struct_row(object.as_str()).map(|r| (r.owner.clone(), r.location_id.clone()))) {
        let owner = PlayerId::parse(&owner).ok();
        if !kind.is_ore() {
            return Ok((build_anchor(client, object).await?, None, owner));
        }
        // Chain v0.21.0: the ore clock hangs off the PLANET the rig stands
        // on; a planetary struct's location IS its planet. A rig in a fleet
        // has no clock: unknown, never "dead".
        let Ok(planet) = PlanetId::parse(&location) else {
            return Ok((Block::new(0), None, owner));
        };
        let live = ore_anchor(client, &planet, kind).await?;
        return Ok((live, Some(planet), owner));
    }
    // Not in the snapshot: the chain's own struct (and planet) entities.
    LCD_READS.fetch_add(1, Ordering::Relaxed);
    let e = client.query_entity("struct", object.as_str()).await?;
    let owner = e.get("Struct").and_then(|s| str_field(s, "owner")).and_then(|o| PlayerId::parse(o).ok());
    if !kind.is_ore() {
        return Ok((crate::mcp::types::EntityView::new(&e).struct_block("blockStartBuild"), None, owner));
    }
    let Some(planet) = e.get("Struct").and_then(|s| str_field(s, "locationId")).and_then(|l| PlanetId::parse(l).ok()) else {
        return Ok((Block::new(0), None, owner));
    };
    let live = match client.query_entity("planet", planet.as_str()).await {
        Ok(p) => crate::mcp::loop_util::planet_ore_anchor(Some(&p), kind),
        Err(_) => 0,
    };
    Ok((Block::new(live), Some(planet), owner))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guild_status_bits_decode_built_online_destroyed() {
        let s = struct_state_from_guild(&json!({"status": 7, "is_destroyed": false, "owner": "1-195", "location_id": "2-22432"})).unwrap();
        assert!(s.built && s.online && !s.destroyed);
        assert_eq!(s.owner.as_ref().map(|p| p.as_str()), Some("1-195"));
        let d = struct_state_from_guild(&json!({"status": "35", "is_destroyed": false})).unwrap();
        assert!(d.destroyed && d.built);
        let d2 = struct_state_from_guild(&json!({"status": 3, "is_destroyed": true})).unwrap();
        assert!(d2.destroyed);
        let m = struct_state_from_guild(&json!({"status": 1, "is_destroyed": false})).unwrap();
        assert!(!m.built && !m.online);
        assert!(struct_state_from_guild(&json!({"is_destroyed": false})).is_err(), "missing status is an error, never 'not built'");
    }

    #[test]
    fn lcd_struct_state_reads_the_attribute_flags() {
        let e = json!({"Struct": {"owner": "1-1", "locationId": "2-9"},
            "structAttributes": {"isBuilt": true, "isOnline": "false", "isDestroyed": false}});
        let s = struct_state_from_lcd(&e).unwrap();
        assert!(s.built && !s.online && !s.destroyed);
        assert_eq!(s.location_id.as_ref().map(|l| l.to_string()).as_deref(), Some("2-9"));
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
    fn slot_maps_come_as_json_strings_on_batch_rows_or_inline_arrays() {
        // Verbatim from a live `/api/objects?ids=` planet row (2026-09-04).
        let row = json!({"id": "2-22432", "map": "{\"air\": [\"\", \"\", \"\", \"\"], \"land\": [\"5-236182\", \"5-192030\", \"\", \"\"], \"space\": [\"5-232859\", \"5-205581\", \"\", \"\"], \"water\": [\"\", \"5-237384\", \"\", \"\"]}"});
        let map = slot_map(&row).unwrap();
        assert!(slot_occupied_in_map(&map, "land", 1).unwrap());
        assert!(!slot_occupied_in_map(&map, "land", 2).unwrap());
        assert!(!slot_occupied_in_map(&map, "air", 0).unwrap());
        assert!(slot_occupied_in_map(&map, "orbit", 0).is_err(), "unknown ambit is an error, not free");
        assert_eq!(first_free_in_map(&map, &["land", "water", "air", "space"]), Some(("land".to_string(), 2)));
        // The LCD / snapshot shape carries the arrays inline.
        let inline = json!({"id": "9-1", "land": ["5-1", ""], "water": [], "air": [], "space": [], "commandStruct": "5-1"});
        let m2 = slot_map(&inline).unwrap();
        assert!(slot_occupied_in_map(&m2, "land", 0).unwrap());
        assert_eq!(first_free_in_map(&m2, &["land"]), Some(("land".to_string(), 1)));
        assert!(slot_map(&json!({"id": "9-1"})).is_err());
    }

    #[test]
    fn player_view_reads_guild_and_lcd_shapes() {
        let g = player_view_from_guild(&json!({"planet_id": "2-1", "fleet_id": "9-11", "ore": "17"})).unwrap();
        assert_eq!((g.planet_id.as_ref().map(|p| p.as_str()), g.fleet_id.as_ref().map(|f| f.as_str()), g.stored_ore), (Some("2-1"), Some("9-11"), 17.0));
        assert!(player_view_from_guild(&json!({"planet_id": "2-1"})).is_err(), "ore is required");
        let l = player_view_from_lcd(&json!({"Player": {"planetId": "2-2", "fleetId": "9-2"}, "gridAttributes": {"ore": "3"}})).unwrap();
        assert_eq!((l.planet_id.as_ref().map(|p| p.as_str()), l.stored_ore), (Some("2-2"), 3.0));
        let none = player_view_from_guild(&json!({"planet_id": "", "ore": 0})).unwrap();
        assert_eq!(none.planet_id, None, "no planet is None, not an empty id");
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

    /// A small galaxy in the LCD row shapes `Snapshot::from_pages` speaks.
    fn fixture() -> Snapshot {
        let structs = vec![
            json!({"id":"5-2184","type":"14","owner":"1-194","locationType":"planet","locationId":"2-223","operatingAmbit":"space","slot":"0"}),
            json!({"id":"5-2297","type":"7","owner":"1-194","locationType":"planet","locationId":"2-223","operatingAmbit":"land","slot":"0"}),
            json!({"id":"5-9000","type":"1","owner":"1-194","locationType":"fleet","locationId":"9-194","operatingAmbit":"space","slot":"0"}),
        ];
        let sattr = vec![
            json!({"attributeId":"1-5-2184","value":"7"}),
            json!({"attributeId":"1-5-2297","value":"1"}),
            json!({"attributeId":"2-5-2297","value":"2435000"}),
            json!({"attributeId":"1-5-9000","value":"7"}),
            json!({"attributeId":"5-5-9000","value":"2184"}),
        ];
        let pattr = vec![
            json!({"attributeId":"12-2-223","value":"1358696"}),
            json!({"attributeId":"13-2-223","value":"1616486"}),
        ];
        let grid = vec![
            json!({"attributeId":"11-1-194","value":"2338643"}),
            json!({"attributeId":"0-1-194","value":"9"}),
            json!({"attributeId":"0-2-223","value":"4"}),
        ];
        let players = vec![json!({"id":"1-194","guildId":"0-1","planetId":"2-223","fleetId":"9-194"})];
        let planets = vec![json!({"id":"2-223","owner":"1-194","space":["5-2184","","",""],"air":["","","",""],"land":["5-2297","","",""],"water":["","","",""]})];
        let fleets = vec![json!({"id":"9-194","owner":"1-194","commandStruct":"5-9000","status":"onStation","space":["5-9000","","",""],"air":["","","",""],"land":["","","",""],"water":["","","",""]})];
        let mut s = Snapshot::from_pages(&structs, &sattr, &pattr, &grid, &players, &planets, &fleets);
        s.taken_ms = now_ms();
        s
    }

    #[test]
    fn the_snapshot_answers_every_verify_question_from_memory() {
        let s = fixture();
        assert_eq!(s.struct_attr("5-2297", "blockStartBuild"), Some(2435000));
        assert_eq!(s.struct_attr("5-404", "blockStartBuild"), None, "unknown struct is a miss, not 0");
        assert_eq!(s.struct_attr("5-9000", "protectedStructIndex"), Some(2184));
        assert_eq!(s.planet_attr("2-223", "blockStartOreMine"), Some(1358696));
        assert_eq!(s.planet_attr("2-223", "blockStartOreRefine"), Some(1616486));
        assert_eq!(s.grid_attr("1-194", "lastAction"), Some(2338643));
        assert_eq!(s.grid_attr("1-194", "ore"), Some(9));
        assert_eq!(s.grid_attr("2-223", "ore"), Some(4));
        assert_eq!(s.grid_attr("2-999", "ore"), None);
        let st = state_from_status_bits(s.struct_status("5-2184"));
        assert!(st.built && st.online);
        assert!(!state_from_status_bits(s.struct_status("5-2297")).built, "materialized only");
        let planet = s.planet_row("2-223").unwrap();
        assert!(slot_occupied_in_map(planet, "space", 0).unwrap());
        assert_eq!(first_free_in_map(planet, &["land", "water"]), Some(("land".to_string(), 1)));
        assert_eq!(str_field(s.fleet_row("9-194").unwrap(), "commandStruct"), Some("5-9000"));
    }

    #[test]
    fn snapshot_lookups_respect_trust_and_the_lcd_knob() {
        let mut s = fixture();
        perception::install_snapshot(s.clone(), "test");
        assert_eq!(snap(|s| s.grid_attr("1-194", "lastAction")), Some(2338643));
        // Too old to trust → miss.
        s.taken_ms = now_ms() - SNAPSHOT_TRUST_MS - 1.0;
        perception::install_snapshot(s.clone(), "test");
        assert_eq!(snap(|s| s.grid_attr("1-194", "lastAction")), None);
        // Fresh again, but the knob says chain → miss.
        s.taken_ms = now_ms();
        perception::install_snapshot(s, "test");
        set_source("lcd");
        assert_eq!(snap(|s| s.grid_attr("1-194", "lastAction")), None);
        set_source("guild");
        assert_eq!(snap(|s| s.grid_attr("1-194", "lastAction")), Some(2338643));
    }
}
