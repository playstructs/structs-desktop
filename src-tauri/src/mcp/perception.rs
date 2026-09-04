//! Shared perception — ONE whole-galaxy LCD snapshot, kept fresh by GRASS.
//!
//! Why this exists. Every auto-loop (build / harvest / defend) rebuilt its
//! world view from scratch each scan: `player_structs` (3 reads) plus one
//! entity read per struct — and then read each struct AGAIN in the loop body.
//! At 2,400 players that is ~48k LCD requests per scan, every scan overran its
//! own interval (372 s vs 180 s for auto_build), and the per-request failures
//! fed the AIMD controller 18 concurrency halvings a day.
//!
//! What the chain actually offers (verified live 2026-09-02, see
//! `scripts/perception_probe.mjs`): the LCD serves WHOLE STORES in pages of
//! 60,000 rows under its 25M query-gas ceiling. The entire galaxy — 51k
//! structs, 206k struct-attribute rows, 107k planet-attribute rows, 39k grid
//! rows, every player/planet/fleet — is ~11 requests and ~8 seconds, and the
//! records rebuilt from it matched the per-entity reads field-for-field
//! (3,015 fields, 0 mismatches). GRASS then streams every change with the
//! ABSOLUTE new value (`value_p`, `status`, `health`, …) so the snapshot can be
//! kept current between refreshes without polling.
//!
//! What this module deliberately is NOT: a replacement for the read a loop
//! does right before it SIGNS. Loop reads are action-gating — slot arrays,
//! isOnline/isBuilt, ore anchors decide signed transactions — and the last two
//! times perception drifted from chain truth we got the struct-list fleet
//! freeze and the futile-mining incident. So the contract is:
//!
//!   * SCAN from the snapshot (cheap, fleet-wide, event-fresh);
//!   * RE-VERIFY the specific entity from the LCD before any sign
//!     (one read per ACTION instead of one per struct per scan).
//!
//! Known GRASS blind spots (measured, not assumed): the planet ore clocks
//! (`blockStartOreMine/Refine`) never stream — `struct_block_ore_*_start` has
//! not fired once in 111k recorded frames — and a NEW struct's row (type,
//! location, slot) is only announced by `struct_block_build_start`, which
//! carries just the id. Both are covered by the periodic full refresh and the
//! pre-sign re-verify; `pending_new_structs()` exposes the ids that need an
//! entity read sooner.
//!
//! Attribute enums below were derived EMPIRICALLY (each `{n}-{type}-{index}`
//! record compared to the entity JSON key order and live values) — the chain's
//! OpenAPI does not publish them.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use super::cosmos_client::CosmosClient;

/// `structs.grid` attribute types, indexed by the numeric prefix of
/// `attributeId` (`{attr}-{objectType}-{index}`).
pub const GRID_ATTRS: [&str; 15] = [
    "ore",
    "fuel",
    "capacity",
    "load",
    "structsLoad",
    "power",
    "connectionCapacity",
    "connectionCount",
    "allocationPointerStart",
    "allocationPointerEnd",
    "proxyNonce",
    "lastAction",
    "nonce",
    "ready",
    "checkpointBlock",
];

/// `structs.struct_attribute` types. `typeCount` rows live on PLAYER ids.
pub const STRUCT_ATTRS: [&str; 7] = [
    "health",
    "status",
    "blockStartBuild",
    "blockStartOreMine",
    "blockStartOreRefine",
    "protectedStructIndex",
    "typeCount",
];

/// `structs.planet_attribute` types.
pub const PLANET_ATTRS: [&str; 16] = [
    "planetaryShield",
    "repairNetworkQuantity",
    "defensiveCannonQuantity",
    "coordinatedGlobalShieldNetworkQuantity",
    "lowOrbitBallisticsInterceptorNetworkQuantity",
    "advancedLowOrbitBallisticsInterceptorNetworkQuantity",
    "lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator",
    "lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator",
    "orbitalJammingStationQuantity",
    "advancedOrbitalJammingStationQuantity",
    "blockStartRaid",
    "blockRaiderArrived",
    "blockStartOreMine",
    "blockStartOreRefine",
    "oreMiningActiveQuantity",
    "oreRefiningActiveQuantity",
];

/// Struct `status` bitfield. 1/2/4/16 verified against live entities
/// (statuses 7, 1, 23, 3 ↔ their `isX` booleans). 32 = destroyed: the
/// recorded GRASS stream shows `struct_status` 7→35 as THE destruction
/// signal (37k times; 33 = destroyed while still building), and every
/// status-35 attribute row belongs to a struct the LCD reports "object not
/// found" for — the chain prunes the object and leaves the row. 8 = locked is
/// the remaining bit by elimination (never observed live).
pub mod status {
    pub const MATERIALIZED: u64 = 1;
    pub const BUILT: u64 = 2;
    pub const ONLINE: u64 = 4;
    pub const LOCKED: u64 = 8;
    pub const HIDDEN: u64 = 16;
    pub const DESTROYED: u64 = 32;
}

const S_HEALTH: usize = 0;
const S_STATUS: usize = 1;
const S_BUILD: usize = 2;
const S_MINE: usize = 3;
const S_REFINE: usize = 4;
const S_PROTECTED: usize = 5;
const P_SHIELD: usize = 0;
const P_RAID: usize = 10;
const P_MINE: usize = 12;
const P_REFINE: usize = 13;

/// Bulk page size. The LCD's query-gas ceiling (25M) is hit around ~110k
/// rows of the widest store; 60k is comfortably under it on every store.
pub const PAGE_LIMIT: u32 = 60_000;

/// One row of the `struct` table — the bare, attribute-free record.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StructRow {
    pub id: String,
    pub type_id: String,
    pub owner: String,
    pub location_type: String,
    pub location_id: String,
    pub operating_ambit: String,
    pub slot: u64,
}

/// The whole-galaxy view at one chain height.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Snapshot {
    /// Chain height the bulk pages were served at (max across pages).
    pub height: u64,
    /// Lowest page height — pages are fetched concurrently and can straddle
    /// a block; anything between `min_height` and `height` is "either".
    pub min_height: u64,
    pub taken_ms: f64,
    /// Wall-clock seconds on the LCD when the snapshot was served, for the
    /// grid-event freshness guard (grid payloads carry `updated_at`, not a
    /// block height).
    pub taken_unix_s: f64,
    pub structs: HashMap<String, StructRow>,
    pub struct_attrs: HashMap<String, [u64; 7]>,
    pub planet_attrs: HashMap<String, [u64; 16]>,
    pub grid: HashMap<String, [u64; 15]>,
    pub players: HashMap<String, Value>,
    pub planets: HashMap<String, Value>,
    pub fleets: HashMap<String, Value>,
    /// Struct ids announced by `struct_block_build_start` that have no row
    /// here yet — they need one entity read (or the next refresh).
    pub pending_new: HashSet<String>,
    pub events_applied: u64,
    pub events_skipped_stale: u64,
    pub last_event_ms: f64,
}

/// Outcome of applying one GRASS frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// A stored value changed.
    Changed,
    /// Recognised, but the store already held this value (idempotent replay).
    NoChange,
    /// Recognised, but older than the snapshot — applying it would regress.
    Stale,
    /// A category this store has no field for (inventory, block, …).
    Ignored,
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/// Number-or-numeric-string → u64 (the LCD serialises every integer as a
/// string; GRASS payloads use real numbers). Anything else → 0.
pub fn to_u64(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse::<u64>().or_else(|_| s.parse::<f64>().map(|f| f.max(0.0) as u64)).unwrap_or(0),
        _ => 0,
    }
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// `"{attr}-{objectType}-{index}"` → `(attr, "objectType-index")`.
pub fn parse_attribute_id(id: &str) -> Option<(usize, String)> {
    let mut it = id.splitn(2, '-');
    let attr = it.next()?.parse::<usize>().ok()?;
    let rest = it.next()?;
    // The object id must itself be `type-index`.
    if rest.split('-').count() != 2 {
        return None;
    }
    Some((attr, rest.to_string()))
}

/// `"2026-09-02T17:34:41.606433+00:00"` → unix seconds. Only the
/// UTC-with-offset shape the indexer emits; anything else → None.
fn iso_to_unix(s: &str) -> Option<f64> {
    // YYYY-MM-DDTHH:MM:SS(.frac)?(+HH:MM|Z)
    let (date, rest) = s.split_once('T')?;
    let mut dp = date.split('-');
    let (y, m, d) = (
        dp.next()?.parse::<i64>().ok()?,
        dp.next()?.parse::<i64>().ok()?,
        dp.next()?.parse::<i64>().ok()?,
    );
    let (time, off) = if let Some(i) = rest.find(['+', 'Z']) {
        (&rest[..i], &rest[i..])
    } else if let Some(i) = rest.rfind('-') {
        (&rest[..i], &rest[i..])
    } else {
        (rest, "Z")
    };
    let mut tp = time.split(':');
    let (hh, mm) = (tp.next()?.parse::<i64>().ok()?, tp.next()?.parse::<i64>().ok()?);
    let ss = tp.next()?.parse::<f64>().ok()?;
    let off_s: i64 = if off == "Z" || off.is_empty() {
        0
    } else {
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let mut op = off[1..].split(':');
        let oh = op.next()?.parse::<i64>().ok()?;
        let om = op.next().unwrap_or("0").parse::<i64>().ok()?;
        sign * (oh * 3600 + om * 60)
    };
    // days from civil (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + hh * 3600 + mm * 60 - off_s) as f64 + ss)
}

fn attrs_json<const N: usize>(names: &[&str; N], vals: Option<&[u64; N]>) -> Value {
    let mut m = Map::with_capacity(N);
    for (i, n) in names.iter().enumerate() {
        m.insert((*n).to_string(), Value::String(vals.map(|v| v[i]).unwrap_or(0).to_string()));
    }
    Value::Object(m)
}

impl Snapshot {
    /// Build from raw LCD pages. Rows may arrive in any order and any mix of
    /// prefixes (a walk that starts at key `0-` returns `1-…` rows on the
    /// same page); everything is keyed by object id here.
    pub fn from_pages(
        struct_rows: &[Value],
        struct_attr_rows: &[Value],
        planet_attr_rows: &[Value],
        grid_rows: &[Value],
        player_rows: &[Value],
        planet_rows: &[Value],
        fleet_rows: &[Value],
    ) -> Snapshot {
        let mut s = Snapshot::default();
        for r in struct_rows {
            let id = str_of(r, "id");
            if id.is_empty() {
                continue;
            }
            s.structs.insert(
                id.clone(),
                StructRow {
                    id,
                    type_id: match r.get("type") {
                        Some(Value::Number(n)) => n.to_string(),
                        other => other.and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    },
                    owner: str_of(r, "owner"),
                    location_type: str_of(r, "locationType"),
                    location_id: str_of(r, "locationId"),
                    operating_ambit: str_of(r, "operatingAmbit"),
                    slot: to_u64(r.get("slot")),
                },
            );
        }
        fn fill<const N: usize>(store: &mut HashMap<String, [u64; N]>, rows: &[Value]) {
            for r in rows {
                let Some(id) = r.get("attributeId").and_then(|x| x.as_str()) else { continue };
                let Some((attr, oid)) = parse_attribute_id(id) else { continue };
                if attr >= N {
                    continue;
                }
                store.entry(oid).or_insert([0; N])[attr] = to_u64(r.get("value"));
            }
        }
        fill(&mut s.struct_attrs, struct_attr_rows);
        fill(&mut s.planet_attrs, planet_attr_rows);
        fill(&mut s.grid, grid_rows);
        for (store, rows) in [
            (&mut s.players, player_rows),
            (&mut s.planets, planet_rows),
            (&mut s.fleets, fleet_rows),
        ] {
            for r in rows {
                let id = str_of(r, "id");
                if !id.is_empty() {
                    store.insert(id, r.clone());
                }
            }
        }
        s
    }

    fn sattr(&self, sid: &str, i: usize) -> u64 {
        self.struct_attrs.get(sid).map(|a| a[i]).unwrap_or(0)
    }

    pub fn struct_status(&self, sid: &str) -> u64 {
        self.sattr(sid, S_STATUS)
    }

    /// Snapshot age in ms.
    pub fn age_ms(&self) -> f64 {
        crate::hasher::types::now_millis() - self.taken_ms
    }

    /// A struct attribute by name; `None` when the struct has no row here.
    pub fn struct_attr(&self, sid: &str, name: &str) -> Option<u64> {
        if !self.structs.contains_key(sid) {
            return None;
        }
        let i = STRUCT_ATTRS.iter().position(|n| *n == name)?;
        Some(self.sattr(sid, i))
    }

    /// A planet attribute by name; `None` when the planet has no row here.
    pub fn planet_attr(&self, pid: &str, name: &str) -> Option<u64> {
        if !self.planets.contains_key(pid) {
            return None;
        }
        let i = PLANET_ATTRS.iter().position(|n| *n == name)?;
        Some(self.planet_attrs.get(pid).map(|a| a[i]).unwrap_or(0))
    }

    /// A grid attribute (player or planet) by name; `None` when the object
    /// has no row here at all.
    pub fn grid_attr(&self, oid: &str, name: &str) -> Option<u64> {
        if !self.players.contains_key(oid) && !self.planets.contains_key(oid) && !self.structs.contains_key(oid) {
            return None;
        }
        let i = GRID_ATTRS.iter().position(|n| *n == name)?;
        Some(self.grid.get(oid).map(|a| a[i]).unwrap_or(0))
    }

    pub fn player_row(&self, pid: &str) -> Option<&Value> {
        self.players.get(pid)
    }
    pub fn planet_row(&self, pid: &str) -> Option<&Value> {
        self.planets.get(pid)
    }
    pub fn fleet_row(&self, fid: &str) -> Option<&Value> {
        self.fleets.get(fid)
    }
    pub fn struct_row(&self, sid: &str) -> Option<&StructRow> {
        self.structs.get(sid)
    }

    /// The struct exists on-chain (row present). Attribute rows can outlive
    /// a pruned struct (seen live: `1-5-205054` = 35 with no struct object),
    /// so the ROW is the existence test, never an attribute.
    pub fn struct_exists(&self, sid: &str) -> bool {
        self.structs.contains_key(sid)
    }

    /// The `/structs/struct/{id}` response shape, rebuilt from the snapshot:
    /// `Struct` row, `structAttributes` (numeric strings + the derived `isX`
    /// booleans), `gridAttributes`. Consumers written against the LCD entity
    /// (`parse_bool(sa.get("isBuilt"))`, `read_u64_field(sa, "blockStartBuild")`)
    /// read this unchanged. `None` when the struct has no row (pruned).
    ///
    /// `structDefenders` is not in any bulk store, so it is omitted rather
    /// than emitted as a misleading `[]`.
    pub fn struct_entity(&self, sid: &str) -> Option<Value> {
        let row = self.structs.get(sid)?;
        let a = self.struct_attrs.get(sid).copied().unwrap_or([0; 7]);
        let st = a[S_STATUS];
        let mut sa = match attrs_json(&STRUCT_ATTRS, Some(&a)) {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        sa.insert("isMaterialized".into(), json!(st & status::MATERIALIZED != 0));
        sa.insert("isBuilt".into(), json!(st & status::BUILT != 0));
        sa.insert("isOnline".into(), json!(st & status::ONLINE != 0));
        sa.insert("isHidden".into(), json!(st & status::HIDDEN != 0));
        sa.insert("isDestroyed".into(), json!(st & status::DESTROYED != 0));
        sa.insert("isLocked".into(), json!(st & status::LOCKED != 0));
        Some(json!({
            "Struct": {
                "id": row.id,
                "index": row.id.split('-').nth(1).unwrap_or(""),
                "type": row.type_id,
                "owner": row.owner,
                "locationType": row.location_type,
                "locationId": row.location_id,
                "operatingAmbit": row.operating_ambit,
                "slot": row.slot.to_string(),
            },
            "structAttributes": Value::Object(sa),
            "gridAttributes": attrs_json(&GRID_ATTRS, self.grid.get(sid)),
        }))
    }

    /// `/structs/planet/{id}` shape: `Planet` row + `gridAttributes` +
    /// `planetAttributes` — so `loop_util::planet_ore_anchor` reads it as-is.
    pub fn planet_entity(&self, pid: &str) -> Option<Value> {
        let row = self.planets.get(pid)?;
        Some(json!({
            "Planet": row,
            "gridAttributes": attrs_json(&GRID_ATTRS, self.grid.get(pid)),
            "planetAttributes": attrs_json(&PLANET_ATTRS, self.planet_attrs.get(pid)),
        }))
    }

    /// `/structs/player/{id}` shape minus `playerInventory` (the bank is not
    /// a bulk store; read balances through `bank_balances` as today).
    pub fn player_entity(&self, pid: &str) -> Option<Value> {
        let row = self.players.get(pid)?;
        Some(json!({
            "Player": row,
            "gridAttributes": attrs_json(&GRID_ATTRS, self.grid.get(pid)),
        }))
    }

    pub fn fleet_entity(&self, fid: &str) -> Option<Value> {
        self.fleets.get(fid).map(|row| json!({ "Fleet": row }))
    }

    /// Exactly `loop_util::player_struct_ids`, from the snapshot: the union
    /// of the player's planet + fleet slot arrays plus the fleet's
    /// `commandStruct`, de-duplicated in order.
    pub fn player_struct_ids(&self, pid: &str) -> Vec<String> {
        let mut ids = Vec::new();
        let Some(p) = self.players.get(pid) else { return ids };
        let planet_id = str_of(p, "planetId");
        let fleet_id = str_of(p, "fleetId");
        for (obj, is_fleet) in [
            (self.planets.get(&planet_id), false),
            (self.fleets.get(&fleet_id), true),
        ] {
            let Some(o) = obj else { continue };
            for ambit in ["land", "water", "air", "space"] {
                if let Some(arr) = o.get(ambit).and_then(|a| a.as_array()) {
                    ids.extend(arr.iter().filter_map(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from));
                }
            }
            if is_fleet {
                let cs = str_of(o, "commandStruct");
                if !cs.is_empty() {
                    ids.push(cs);
                }
            }
        }
        let mut seen = HashSet::new();
        ids.retain(|id| seen.insert(id.clone()));
        ids
    }

    /// Exactly the flat records `loop_util::player_structs` returns, from the
    /// snapshot. A struct listed in a slot array but with no row (pruned
    /// between the planet page and the struct page, or a stale slot) is
    /// skipped — the same way a failed entity read is skipped today.
    pub fn player_structs(&self, pid: &str) -> Vec<Value> {
        self.player_struct_ids(pid)
            .iter()
            .filter_map(|sid| {
                let row = self.structs.get(sid)?;
                let st = self.struct_status(sid);
                Some(json!({
                    "id": row.id,
                    "type": row.type_id,
                    "type_name": Value::Null,
                    "location_type": row.location_type,
                    "location_id": row.location_id,
                    "operating_ambit": row.operating_ambit,
                    "slot": row.slot,
                    "is_destroyed": st & status::DESTROYED != 0,
                    "is_built": st & status::BUILT != 0,
                }))
            })
            .collect()
    }

    /// Ids announced by a build-start event that have no row yet.
    pub fn pending_new_structs(&self) -> Vec<String> {
        let mut v: Vec<String> = self.pending_new.iter().cloned().collect();
        v.sort();
        v
    }

    /// Restart a KNOWN planet's mine/refine clock at `block` (a completion
    /// we signed landed). Unknown planets and zero blocks are refused: this
    /// records what the chain did, it never invents a planet.
    pub fn restart_clock(&mut self, planet_id: &str, task_type: &str, block: u64) -> bool {
        let idx = match task_type {
            "MINE" => P_MINE,
            "REFINE" => P_REFINE,
            _ => return false,
        };
        if block == 0 || !self.planets.contains_key(planet_id) {
            return false;
        }
        Self::set(&mut self.planet_attrs, planet_id, idx, block) == Applied::Changed
    }

    fn set<const N: usize>(store: &mut HashMap<String, [u64; N]>, oid: &str, i: usize, val: u64) -> Applied {
        let slot = store.entry(oid.to_string()).or_insert([0; N]);
        if slot[i] == val {
            Applied::NoChange
        } else {
            slot[i] = val;
            Applied::Changed
        }
    }

    /// Fold one GRASS frame into the store.
    ///
    /// Values in these payloads are ABSOLUTE (the new value, never a delta),
    /// so re-applying a change the snapshot already reflects is harmless. The
    /// hazard is the other direction — an OLD frame replayed over a NEWER
    /// snapshot would regress a field — so planet-activity frames (which
    /// carry `block_height`) are dropped when older than the snapshot, and
    /// grid frames (which carry only `updated_at`) when stamped before it.
    /// A frame that beats the guard by indexer lag alone is corrected by the
    /// very next frame for that field, and every sign re-verifies anyway.
    pub fn apply(&mut self, category: &str, subject: &str, detail: &Value) -> Applied {
        // Two transports, two shapes. The in-app tap (structs-config.js)
        // flattens top-level extras + `detail` into one object before Rust
        // sees it; a raw NATS planet-activity frame still nests the row fields
        // (`struct_id`, `status`, …) under `detail`. Accept both, nested keys
        // winning, so a direct subscriber and the webview tap agree.
        let merged;
        let detail = match detail.get("detail") {
            Some(Value::Object(inner)) => {
                let mut m = detail.as_object().cloned().unwrap_or_default();
                m.remove("detail");
                for (k, v) in inner {
                    m.insert(k.clone(), v.clone());
                }
                merged = Value::Object(m);
                &merged
            }
            _ => detail,
        };
        let now = crate::hasher::types::now_millis();
        let bh = to_u64(detail.get("block_height"));
        if bh != 0 && bh < self.min_height {
            self.events_skipped_stale += 1;
            return Applied::Stale;
        }
        let res = if subject.starts_with("structs.grid.") {
            let Some(idx) = detail
                .get("attribute_type")
                .and_then(|x| x.as_str())
                .and_then(|n| GRID_ATTRS.iter().position(|g| *g == n))
            else {
                return Applied::Ignored;
            };
            let oid = str_of(detail, "object_id");
            if oid.is_empty() {
                return Applied::Ignored;
            }
            if let Some(ts) = detail.get("updated_at").and_then(|x| x.as_str()).and_then(iso_to_unix) {
                if self.taken_unix_s > 0.0 && ts + 2.0 < self.taken_unix_s {
                    self.events_skipped_stale += 1;
                    return Applied::Stale;
                }
            }
            // `value_p` is the precise base-unit value; `value` is a floored
            // display figure (structsLoad 2935 vs 2935000). Never mix them.
            let v = detail.get("value_p").or_else(|| detail.get("value"));
            Self::set(&mut self.grid, &oid, idx, to_u64(v))
        } else {
            let sid = str_of(detail, "struct_id");
            match category {
                "struct_status" => {
                    let new = to_u64(detail.get("status"));
                    let was = self.sattr(&sid, S_STATUS);
                    let r = Self::set(&mut self.struct_attrs, &sid, S_STATUS, new);
                    // Build completion is announced only as 1→7; the chain
                    // clears `blockStartBuild` in the same tx and never streams
                    // that. Measured: 11 of 41 build-clock changes in a window
                    // were exactly these silent resets. Mirror the chain.
                    if new & status::BUILT != 0 && was & status::BUILT == 0 {
                        Self::set(&mut self.struct_attrs, &sid, S_BUILD, 0);
                    }
                    r
                }
                "struct_health" => Self::set(&mut self.struct_attrs, &sid, S_HEALTH, to_u64(detail.get("health"))),
                "struct_block_build_start" => {
                    if !sid.is_empty() && !self.structs.contains_key(&sid) {
                        self.pending_new.insert(sid.clone());
                    }
                    let b = to_u64(detail.get("block").or_else(|| detail.get("block_height")));
                    Self::set(&mut self.struct_attrs, &sid, S_BUILD, b)
                }
                "struct_defense_add" => {
                    let defender = str_of(detail, "defender_struct_id");
                    let protected = str_of(detail, "protected_struct_id");
                    let idx = protected.split('-').nth(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                    if defender.is_empty() {
                        return Applied::Ignored;
                    }
                    Self::set(&mut self.struct_attrs, &defender, S_PROTECTED, idx)
                }
                "struct_defense_remove" => {
                    let defender = str_of(detail, "defender_struct_id");
                    if defender.is_empty() {
                        return Applied::Ignored;
                    }
                    Self::set(&mut self.struct_attrs, &defender, S_PROTECTED, 0)
                }
                "struct_move" => match self.structs.get_mut(&sid) {
                    Some(row) => {
                        let next = StructRow {
                            location_type: str_of(detail, "location_type"),
                            location_id: str_of(detail, "location_id"),
                            operating_ambit: str_of(detail, "ambit"),
                            slot: to_u64(detail.get("slot")),
                            ..row.clone()
                        };
                        if *row == next {
                            Applied::NoChange
                        } else {
                            *row = next;
                            Applied::Changed
                        }
                    }
                    None => Applied::Ignored,
                },
                "shield_change" => {
                    let pid = str_of(detail, "planet_id");
                    Self::set(&mut self.planet_attrs, &pid, P_SHIELD, to_u64(detail.get("planetary_shield")))
                }
                // The planet ore clocks. `structs.planet_activity` records these
                // (`{block, planet_id}`, ~10k rows/day) and the local stack's
                // notify trigger emits them; the production stream delivered
                // none in 111k recorded frames, so the work-view hot refresh
                // stays as the backstop. When they do arrive, they are the
                // freshest source there is.
                "struct_block_ore_mine_start" | "struct_block_ore_refine_start" => {
                    let pid = str_of(detail, "planet_id");
                    if pid.is_empty() {
                        return Applied::Ignored;
                    }
                    let b = to_u64(detail.get("block").or_else(|| detail.get("block_height")));
                    let idx = if category == "struct_block_ore_mine_start" { P_MINE } else { P_REFINE };
                    Self::set(&mut self.planet_attrs, &pid, idx, b)
                }
                "block_raid_start" => {
                    let pid = str_of(detail, "planet_id");
                    let b = to_u64(detail.get("block").or_else(|| detail.get("block_height")));
                    Self::set(&mut self.planet_attrs, &pid, P_RAID, b)
                }
                _ => Applied::Ignored,
            }
        };
        if res == Applied::Changed {
            self.events_applied += 1;
            self.last_event_ms = now;
        }
        res
    }

    /// Fold a freshly-read struct entity (the pre-sign re-verify, or a
    /// `pending_new` fetch) back into the store so the next scan sees it.
    pub fn absorb_struct_entity(&mut self, entity: &Value) {
        let Some(s) = entity.get("Struct") else { return };
        let id = str_of(s, "id");
        if id.is_empty() {
            return;
        }
        self.structs.insert(
            id.clone(),
            StructRow {
                id: id.clone(),
                type_id: match s.get("type") {
                    Some(Value::Number(n)) => n.to_string(),
                    other => other.and_then(|x| x.as_str()).unwrap_or("").to_string(),
                },
                owner: str_of(s, "owner"),
                location_type: str_of(s, "locationType"),
                location_id: str_of(s, "locationId"),
                operating_ambit: str_of(s, "operatingAmbit"),
                slot: to_u64(s.get("slot")),
            },
        );
        if let Some(sa) = entity.get("structAttributes") {
            let a = self.struct_attrs.entry(id.clone()).or_insert([0; 7]);
            for (i, n) in STRUCT_ATTRS.iter().enumerate() {
                if let Some(v) = sa.get(*n) {
                    a[i] = to_u64(Some(v));
                }
            }
            // The entity carries the booleans; if `status` was absent (older
            // node), rebuild it from them.
            if sa.get("status").is_none() {
                let mut st = 0;
                for (k, bit) in [
                    ("isMaterialized", status::MATERIALIZED),
                    ("isBuilt", status::BUILT),
                    ("isOnline", status::ONLINE),
                    ("isDestroyed", status::DESTROYED),
                    ("isHidden", status::HIDDEN),
                    ("isLocked", status::LOCKED),
                ] {
                    if sa.get(k).and_then(|v| v.as_bool()).unwrap_or(false) {
                        st |= bit;
                    }
                }
                a[S_STATUS] = st;
            }
        }
        self.pending_new.remove(&id);
    }

    pub fn summary(&self) -> Value {
        json!({
            "height": self.height,
            "min_height": self.min_height,
            "age_s": ((crate::hasher::types::now_millis() - self.taken_ms) / 1000.0).max(0.0).round(),
            "structs": self.structs.len(),
            "struct_attr_objects": self.struct_attrs.len(),
            "planets": self.planets.len(),
            "fleets": self.fleets.len(),
            "players": self.players.len(),
            "grid_objects": self.grid.len(),
            "events_applied": self.events_applied,
            "events_skipped_stale": self.events_skipped_stale,
            "pending_new_structs": self.pending_new.len(),
            "fed_by": fed_by(),
            "hot_age_s": hot_age_ms().map(|a| (a / 1000.0) as u64),
            "last_event_age_s": if self.last_event_ms > 0.0 {
                json!(((crate::hasher::types::now_millis() - self.last_event_ms) / 1000.0).round())
            } else { Value::Null },
        })
    }
}

// ── Process-global instance ─────────────────────────────────────────────────

static CURRENT: LazyLock<RwLock<Option<Snapshot>>> = LazyLock::new(|| RwLock::new(None));
/// Frames that arrive while a refresh is in flight are queued and replayed
/// onto the NEW snapshot (guarded by height), so a refresh never loses the
/// changes that landed during its own ~8 s fetch.
static REFRESHING: AtomicBool = AtomicBool::new(false);
static PENDING: LazyLock<Mutex<Vec<(String, String, Value)>>> = LazyLock::new(|| Mutex::new(Vec::new()));
const PENDING_CAP: usize = 20_000;

/// Read the live snapshot, if one has been taken. Callers hold the read lock
/// only for the closure — clone out what you need, do not await inside.
// ── Survives a restart ──────────────────────────────────────────────────────
// The galaxy is ~11 LCD requests and ~8 seconds to rebuild, and every loop's
// first scan waits on it. Last session's snapshot is restored on the first
// read, off-thread (it is tens of megabytes), and only if nothing live has
// landed first. Its `taken_ms` and `height` are OLD, deliberately: every
// consumer already measures a snapshot's age against its own cadence, and the
// loops verify against the chain before they sign — a restored snapshot is a
// head start, never a source of truth.
const SNAPSHOT_CACHE: &str = "perception_snapshot";
static RESTORE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn restore_in_background() {
    if RESTORE_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("perception-restore".into())
        .spawn(|| {
            let Some(saved) = crate::mcp::cache_store::load::<Snapshot>(SNAPSHOT_CACHE) else { return };
            if let Ok(mut g) = CURRENT.write() {
                if g.is_none() {
                    *g = Some(saved);
                }
            }
        })
        .ok();
}

fn persist_snapshot(snap: &Snapshot) {
    crate::mcp::cache_store::save_in_background(SNAPSHOT_CACHE, snap.clone());
}

pub fn with_snapshot<R>(f: impl FnOnce(&Snapshot) -> R) -> Option<R> {
    restore_in_background();
    CURRENT.read().ok()?.as_ref().map(f)
}

pub fn is_ready() -> bool {
    CURRENT.read().map(|g| g.is_some()).unwrap_or(false)
}

/// GRASS ingest hook — call from `push_game_event` for EVERY frame (the
/// webapp subscribes `structs.>`, so the whole galaxy's deltas pass through).
/// Cheap: a category match and one hash-map write.
pub fn on_grass(category: &str, subject: &str, detail: &Value) {
    if REFRESHING.load(Ordering::Relaxed) {
        if let Ok(mut q) = PENDING.lock() {
            if q.len() < PENDING_CAP {
                q.push((category.to_string(), subject.to_string(), detail.clone()));
            }
        }
        // Fall through: also apply to the OLD snapshot so readers during the
        // refresh stay as fresh as before.
    }
    if let Ok(mut g) = CURRENT.write() {
        if let Some(s) = g.as_mut() {
            s.apply(category, subject, detail);
        }
    }
}

/// Fold a just-read entity into the live snapshot (pre-sign re-verify path).
pub fn absorb_struct_entity(entity: &Value) {
    if let Ok(mut g) = CURRENT.write() {
        if let Some(s) = g.as_mut() {
            s.absorb_struct_entity(entity);
        }
    }
}

/// Fold a just-read PLANET entity into the live snapshot: its attributes
/// (the ore clocks — GRASS never streams them) and grid. Call after a
/// pre-sign planet read so the next scan stops re-nominating a struct whose
/// planet clock already moved (measured: a dozen false candidates per scan,
/// each costing two chain reads, until the next 10-minute refresh).
pub fn absorb_planet_entity(entity: &Value) {
    let Some(p) = entity.get("Planet") else { return };
    let id = str_of(p, "id");
    if id.is_empty() {
        return;
    }
    if let Ok(mut g) = CURRENT.write() {
        if let Some(s) = g.as_mut() {
            s.planets.insert(id.clone(), p.clone());
            if let Some(pa) = entity.get("planetAttributes") {
                let a = s.planet_attrs.entry(id.clone()).or_insert([0; 16]);
                for (i, n) in PLANET_ATTRS.iter().enumerate() {
                    if let Some(v) = pa.get(*n) {
                        a[i] = to_u64(Some(v));
                    }
                }
            }
            if let Some(ga) = entity.get("gridAttributes") {
                let g2 = s.grid.entry(id).or_insert([0; 15]);
                for (i, n) in GRID_ATTRS.iter().enumerate() {
                    if let Some(v) = ga.get(*n) {
                        g2[i] = to_u64(Some(v));
                    }
                }
            }
        }
    }
}

/// Drop a player's row so scans fall through to the chain for it until the
/// next refresh. For actions that change what the row POINTS AT and are not
/// streamed — an explore moves `planetId` to a planet we have never seen and
/// no GRASS frame carries the new id. Without this the loop kept re-signing
/// explores for six minutes against the old planet ("new planet cannot be
/// explored while current planet has ore available").
pub fn forget_player(pid: &str) {
    if let Ok(mut g) = CURRENT.write() {
        if let Some(s) = g.as_mut() {
            s.players.remove(pid);
        }
    }
}

pub fn summary() -> Value {
    with_snapshot(|s| s.summary()).unwrap_or_else(|| json!({ "ready": false }))
}

/// Refresh cadence for the background snapshot. GRASS carries the deltas in
/// between; this bounds the blind spots (ore clocks, planet defence counts,
/// pruned rows) to one interval.
pub const REFRESH_EVERY_MS: f64 = 10.0 * 60_000.0;

/// Kick a background refresh if the snapshot is missing or older than
/// [`REFRESH_EVERY_MS`] and none is in flight. Non-blocking: the caller's scan
/// proceeds on whatever is current (or the chain, via the loop_util shims).
/// Call from the top of any loop scan.
/// Start a refresh now if one is not already running (whether or not one is
/// due). Used at launch and by `loop_util::ensure_perception`.
pub fn request_refresh(client: &CosmosClient) {
    if REFRESHING.load(Ordering::Relaxed) {
        return;
    }
    let client = client.clone();
    tokio::spawn(async move {
        let _ = refresh(&client).await;
    });
}

pub fn is_refreshing() -> bool {
    REFRESHING.load(Ordering::Relaxed)
}

pub fn maybe_refresh(client: &CosmosClient) {
    maybe_hot_refresh(client);
    if REFRESHING.load(Ordering::Relaxed) {
        return;
    }
    let now = crate::hasher::types::now_millis();
    let due = with_snapshot(|s| now - s.taken_ms >= REFRESH_EVERY_MS).unwrap_or(true);
    if !due {
        return;
    }
    let client = client.clone();
    tokio::spawn(async move {
        // `refresh` logs its own outcome; a concurrent-start race just
        // returns "already in flight".
        let _ = refresh(&client).await;
    });
}

/// Structs announced by `struct_block_build_start` have no row until they
/// are read; give up to `max` of them their one entity read now so the very
/// next scan sees the new hull (type, location, slot) instead of waiting for
/// the 10-minute refresh. Bounded, so a build storm cannot turn this into a
/// fan-out. Returns how many were resolved.
pub async fn resolve_pending(client: &CosmosClient, max: usize) -> usize {
    let ids: Vec<String> = with_snapshot(|s| s.pending_new_structs()).unwrap_or_default();
    let mut done = 0;
    for sid in ids.into_iter().take(max) {
        match entity(client, "struct", &sid).await {
            Ok(_) => {
                // `entity` folded it in already.
                done += 1;
            }
            // Not found = pruned before we looked (or not yet indexed); drop
            // it so it does not queue forever. A real transient read error
            // leaves it for the next call.
            Err(e) if e.contains("not found") => {
                if let Ok(mut g) = CURRENT.write() {
                    if let Some(s) = g.as_mut() {
                        s.pending_new.remove(&sid);
                    }
                }
            }
            Err(_) => {}
        }
    }
    done
}

/// Walk one LCD store to the end. Returns (rows, max height, server time).
// ── Guild-API ingest ────────────────────────────────────────────────────────
//
// The same seven stores from the indexer instead of the chain node: the
// catalog lists at 10,000 rows a page (~45 requests for the galaxy against
// the LCD's 11 of 60,000). Rows are snake_case SQL columns; a planet or fleet
// `map` is its slot arrays as a JSON string; attribute rows are
// (object_id, attribute_type, val). Everything is adapted to the LCD shapes
// `from_pages` and every consumer already speak, so the store's schema and
// the GRASS patching are identical whichever source fed it. The LCD walk
// stays as the failover, and `snapshot_source` picks the default.
//
// One thing the indexer changes: an attribute row is DELETED when its value
// reaches zero, so a zero is an absent row (from_pages already defaults
// absent to 0), and destroyed structs keep a base row with `is_destroyed`
// (the chain prunes them) — those are dropped so `structs` means "exists".

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SnapshotSource {
    Guild,
    Lcd,
}

impl SnapshotSource {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "guild" | "guild_api" | "api" => Some(SnapshotSource::Guild),
            "lcd" | "chain" => Some(SnapshotSource::Lcd),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            SnapshotSource::Guild => "guild",
            SnapshotSource::Lcd => "lcd",
        }
    }
}

static SNAPSHOT_SOURCE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub fn snapshot_source() -> SnapshotSource {
    if SNAPSHOT_SOURCE.load(Ordering::Relaxed) == 1 {
        SnapshotSource::Lcd
    } else {
        SnapshotSource::Guild
    }
}

/// Returns false (and changes nothing) for an unknown source.
pub fn set_snapshot_source(s: &str) -> bool {
    match SnapshotSource::parse(s) {
        Some(v) => {
            SNAPSHOT_SOURCE.store(if v == SnapshotSource::Lcd { 1 } else { 0 }, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// Which source fed the CURRENT snapshot ("guild" / "lcd" / "").
static FED_BY: std::sync::Mutex<&'static str> = std::sync::Mutex::new("");

pub fn fed_by() -> &'static str {
    *FED_BY.lock().unwrap_or_else(|e| e.into_inner())
}

pub const GUILD_PAGE_LIMIT: usize = 10_000;
const GUILD_MAX_PAGES: u32 = 60;

pub(crate) fn snake_to_camel(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// A planet/fleet `map` (JSON string or object) → the four ambit arrays.
fn map_arrays(v: &Value) -> Option<Map<String, Value>> {
    let parsed: Value = match v {
        Value::String(s) => serde_json::from_str(s).ok()?,
        Value::Object(_) => v.clone(),
        _ => return None,
    };
    let obj = parsed.as_object()?;
    let mut out = Map::new();
    for amb in ["land", "water", "air", "space"] {
        out.insert(amb.to_string(), obj.get(amb).cloned().unwrap_or_else(|| json!([])));
    }
    Some(out)
}

/// Generic guild row → LCD row: snake_case keys become camelCase and a `map`
/// string becomes the ambit arrays the LCD carries inline.
pub(crate) fn adapt_row(row: &Value) -> Value {
    let Some(obj) = row.as_object() else { return row.clone() };
    let mut out = Map::new();
    for (k, v) in obj {
        if k == "map" {
            if let Some(arrays) = map_arrays(v) {
                out.extend(arrays);
                continue;
            }
        }
        out.insert(snake_to_camel(k), v.clone());
    }
    Value::Object(out)
}

/// Struct base rows: destroyed ones are dropped (the LCD prunes them; their
/// status-35 attribute row still says destroyed for anyone who asks).
pub(crate) fn adapt_struct_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|r| !crate::mcp::loop_util::parse_bool(r.get("is_destroyed")))
        .map(adapt_row)
        .collect()
}

/// Attribute rows (object_id, attribute_type, val) → the LCD's
/// `{attributeId: "<index>-<object_id>", value}` for `names`. Rows whose
/// type is not in `names` are dropped (the store has no slot for them).
pub(crate) fn adapt_attribute_rows(rows: &[Value], names: &[&str]) -> Vec<Value> {
    rows.iter()
        .filter_map(|r| {
            let oid = r.get("object_id").and_then(|x| x.as_str()).filter(|s| !s.is_empty())?;
            // The row id IS the chain's attribute id
            // (`<attr index>-<object type>-<object index>[-<sub index>]`, e.g.
            // `12-2-23537` = planet 2-23537's mine clock, `6-1-100-1` = a
            // typeCount with a sub index) and is authoritative: pass it through
            // verbatim so `parse_attribute_id` applies exactly the rules it
            // applies to LCD rows (unknown index or sub-indexed rows are
            // skipped the same way). The `attribute_type` name is a courtesy
            // the indexer does not always extend — every planet ore-clock row
            // it has written since 2026-08-24 carries a NULL name because its
            // index→name table stops at 10 — so it is only the fallback for a
            // row with no id.
            let val = r.get("val").or_else(|| r.get("value"))?;
            if let Some(id) = r.get("id").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                return Some(json!({ "attributeId": id, "value": val }));
            }
            let t = ["attribute_type", "type", "attribute"]
                .iter()
                .find_map(|k| r.get(*k).and_then(|x| x.as_str()))?;
            let idx = names.iter().position(|n| *n == t)?;
            Some(json!({ "attributeId": format!("{idx}-{oid}"), "value": val }))
        })
        .collect()
}

/// Walk one guild catalog list at GUILD_PAGE_LIMIT rows a page. Returns the
/// rows and the highest indexer height stamped on the pages.
async fn walk_guild_list(client: &CosmosClient, path: &str) -> Result<(Vec<Value>, u64), String> {
    let (rows, height, complete) = client.guild.walk_list(path, GUILD_PAGE_LIMIT, GUILD_MAX_PAGES).await?;
    if !complete {
        return Err(format!("{path}: walk capped at {GUILD_MAX_PAGES} pages ({} rows) — refusing a truncated store", rows.len()));
    }
    Ok((rows, height.unwrap_or(0)))
}

/// A new snapshot must be in the same league as the one it replaces. A
/// store that came back at a fraction of its previous size is a truncated
/// or mis-parsed walk, and installing it would make the loops act on a
/// galaxy most of which "does not exist".
pub(crate) fn snapshot_plausible(prev: Option<(usize, usize, usize)>, new: (usize, usize, usize)) -> Result<(), String> {
    let Some((ps, pp, pl)) = prev else { return Ok(()) };
    for (name, p, n) in [("structs", ps, new.0), ("players", pp, new.1), ("planets", pl, new.2)] {
        if p >= 100 && n < p / 2 {
            return Err(format!("guild snapshot has {n} {name} where the previous had {p} — refusing a truncated store"));
        }
    }
    Ok(())
}

/// Build a snapshot from the guild catalog. Errors (so the caller can fall
/// back to the LCD) when a store that can never legitimately be empty is.
async fn guild_pages(client: &CosmosClient, t0: f64) -> Result<Snapshot, String> {
    let result = tokio::join!(
        walk_guild_list(client, "/api/struct/list/all"),
        walk_guild_list(client, "/api/struct-attribute/all"),
        walk_guild_list(client, "/api/planet-attribute/all"),
        walk_guild_list(client, "/api/grid/all"),
        walk_guild_list(client, "/api/player/list/all"),
        walk_guild_list(client, "/api/planet/list/all"),
        walk_guild_list(client, "/api/fleet/list/all"),
    );
    let (st, sa, pa, gr, pl, pn, fl) = (result.0?, result.1?, result.2?, result.3?, result.4?, result.5?, result.6?);
    let structs = adapt_struct_rows(&st.0);
    let sattr = adapt_attribute_rows(&sa.0, &STRUCT_ATTRS);
    let pattr = adapt_attribute_rows(&pa.0, &PLANET_ATTRS);
    let grid = adapt_attribute_rows(&gr.0, &GRID_ATTRS);
    let players: Vec<Value> = pl.0.iter().map(adapt_row).collect();
    let planets: Vec<Value> = pn.0.iter().map(adapt_row).collect();
    let fleets: Vec<Value> = fl.0.iter().map(adapt_row).collect();
    for (name, n) in [
        ("structs", structs.len()),
        ("struct attributes", sattr.len()),
        ("players", players.len()),
        ("planets", planets.len()),
        ("grid", grid.len()),
    ] {
        if n == 0 {
            return Err(format!("guild catalog gave 0 usable {name} rows — row shape or route mismatch"));
        }
    }
    let prev = with_snapshot(|s| (s.structs.len(), s.players.len(), s.planets.len()));
    snapshot_plausible(prev, (structs.len(), players.len(), planets.len()))?;
    let mut snap = Snapshot::from_pages(&structs, &sattr, &pattr, &grid, &players, &planets, &fleets);
    let heights = [st.1, sa.1, pa.1, gr.1, pl.1, pn.1, fl.1];
    snap.height = heights.iter().copied().max().unwrap_or(0);
    if snap.height == 0 {
        // The catalog lists do not stamp `meta.height`; the indexer's own
        // block endpoint does. Without it every guild snapshot reads "@0".
        snap.height = client.guild.indexer_height().await.unwrap_or(0);
    }
    snap.min_height = heights.iter().copied().filter(|h| *h > 0).min().unwrap_or(snap.height);
    snap.taken_ms = t0;
    // Grid GRASS frames carry the indexer's `updated_at`; the indexer and this
    // machine keep wall clocks, so "served now" is the right freshness anchor.
    snap.taken_unix_s = t0 / 1000.0;
    Ok(snap)
}

// ── Hot refresh: the ore and build clocks, from the work view ────────────────
//
// `blockStartOreMine/Refine` never stream (measured: zero frames in 111k),
// and a proof solved against a moved clock is a proof the chain rejects. The
// planet-attribute BY-TYPE route cannot serve them either: the indexer has
// written every ore-clock row since 2026-08-24 with a NULL `attribute_type`
// (its index→name table stops at 10), so `type/blockStartOreMine` answers
// `[]` while the table holds thousands of rows. The guild WORK view is the
// right source anyway — one row per rig with the clock it hashes against
// (verified: every MINE row's block_start equals its planet's clock), and
// our whole guild fits in one 10,000-row page. Every HOT_REFRESH_EVERY_MS
// those rows are folded into the snapshot: planet ore clocks, struct build
// clocks, and a clear (0) for any planet of ours with no outstanding work.

pub const HOT_REFRESH_EVERY_MS: f64 = 2.0 * 60_000.0;
static HOT_REFRESHING: AtomicBool = AtomicBool::new(false);
static LAST_HOT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Age of the last clock hot refresh, or `None` if none has run.
pub fn hot_age_ms() -> Option<f64> {
    let t = LAST_HOT_MS.load(Ordering::Relaxed);
    (t > 0).then(|| crate::hasher::types::now_millis() - t as f64)
}

/// Fold guild work rows (`object_id, player_id, category, block_start`) into
/// the snapshot. Planets belonging to `guild_id`'s players that have no
/// MINE / REFINE row get that clock cleared: the work view is complete for a
/// guild, so absence means nothing to hash. Returns how many values changed.
pub(crate) fn apply_work_rows(snap: &mut Snapshot, rows: &[Value], guild_id: &str) -> usize {
    let mut changed = 0usize;
    let mut mine_seen: HashSet<String> = HashSet::new();
    let mut refine_seen: HashSet<String> = HashSet::new();
    for r in rows {
        let oid = str_of(r, "object_id");
        let cat = str_of(r, "category").to_ascii_uppercase();
        let block = to_u64(r.get("block_start"));
        if oid.is_empty() {
            continue;
        }
        match cat.as_str() {
            "BUILD" => {
                if snap.structs.contains_key(&oid) && Snapshot::set(&mut snap.struct_attrs, &oid, S_BUILD, block) == Applied::Changed {
                    changed += 1;
                }
            }
            "MINE" | "REFINE" => {
                let Some(planet) = snap.structs.get(&oid).filter(|s| s.location_type == "planet").map(|s| s.location_id.clone()) else { continue };
                if planet.is_empty() {
                    continue;
                }
                let (idx, seen) = if cat == "MINE" { (12usize, &mut mine_seen) } else { (13usize, &mut refine_seen) };
                seen.insert(planet.clone());
                if Snapshot::set(&mut snap.planet_attrs, &planet, idx, block) == Applied::Changed {
                    changed += 1;
                }
            }
            _ => {}
        }
    }
    // Our players' planets with no outstanding ore work: clocks clear.
    let ours: Vec<String> = snap
        .players
        .values()
        .filter(|p| str_of(p, "guildId") == guild_id)
        .map(|p| str_of(p, "planetId"))
        .filter(|id| !id.is_empty() && snap.planets.contains_key(id))
        .collect();
    for planet in ours {
        if !mine_seen.contains(&planet) && Snapshot::set(&mut snap.planet_attrs, &planet, 12, 0) == Applied::Changed {
            changed += 1;
        }
        if !refine_seen.contains(&planet) && Snapshot::set(&mut snap.planet_attrs, &planet, 13, 0) == Applied::Changed {
            changed += 1;
        }
    }
    changed
}

pub async fn hot_refresh_ore_clocks(client: &CosmosClient) -> Result<usize, String> {
    if HOT_REFRESHING.swap(true, Ordering::SeqCst) {
        return Err("hot refresh already in flight".into());
    }
    let result = async {
        let guild_id = crate::guild_config::get_active_guild_config()
            .map(|c| c.guild_id)
            .filter(|g| !g.is_empty())
            .ok_or("no active guild")?;
        let (rows, _, complete) = client
            .guild
            .walk_list(&format!("/api/work/guild/{guild_id}"), GUILD_PAGE_LIMIT, GUILD_MAX_PAGES)
            .await?;
        if !complete {
            return Err(format!("work view capped at {GUILD_MAX_PAGES} pages — refusing a truncated sweep"));
        }
        if rows.is_empty() {
            // A guild with 2,400 rigs never has zero outstanding work; an
            // empty answer is a route or session problem, not a quiet galaxy.
            return Err("work view returned no rows".to_string());
        }
        let mut g = CURRENT.write().map_err(|_| "snapshot lock poisoned".to_string())?;
        let s = g.as_mut().ok_or("no snapshot to patch")?;
        Ok(apply_work_rows(s, &rows, &guild_id))
    }
    .await;
    if result.is_ok() {
        LAST_HOT_MS.store(crate::hasher::types::now_millis() as u64, Ordering::Relaxed);
    }
    HOT_REFRESHING.store(false, Ordering::SeqCst);
    result
}

/// A completion we signed landed: the chain restarted that planet's clock at
/// the inclusion block. Record it NOW rather than waiting for the next sweep
/// — with the clock frames not reaching us from production, the two-minute
/// gap was long enough for the harvest loop to re-nominate the same rig
/// against the old anchor and grind a proof the chain then rejected
/// ("work failure", 94 an hour on 2026-09-04).
pub fn note_clock_restart(planet_id: &str, task_type: &str, block: u64) -> bool {
    if let Ok(mut g) = CURRENT.write() {
        if let Some(s) = g.as_mut() {
            return s.restart_clock(planet_id, task_type, block);
        }
    }
    false
}

/// Force a clock sweep now (a "work failure" means the snapshot's clock was
/// wrong; do not wait out the interval to find out how).
pub fn request_hot_refresh(client: &CosmosClient) {
    if snapshot_source() != SnapshotSource::Guild || !is_ready() || HOT_REFRESHING.load(Ordering::Relaxed) {
        return;
    }
    let client = client.clone();
    tokio::spawn(async move {
        if let Err(e) = hot_refresh_ore_clocks(&client).await {
            crate::mcp::telemetry::tlog(
                "perception",
                crate::mcp::telemetry::Sev::Warn,
                format!("forced clock refresh failed: {e}"),
            );
        }
    });
}

fn maybe_hot_refresh(client: &CosmosClient) {
    if snapshot_source() != SnapshotSource::Guild || !is_ready() || HOT_REFRESHING.load(Ordering::Relaxed) {
        return;
    }
    if hot_age_ms().is_some_and(|a| a < HOT_REFRESH_EVERY_MS) {
        return;
    }
    let client = client.clone();
    tokio::spawn(async move {
        if let Err(e) = hot_refresh_ore_clocks(&client).await {
            crate::mcp::telemetry::tlog(
                "perception",
                crate::mcp::telemetry::Sev::Warn,
                format!("ore-clock hot refresh failed: {e}"),
            );
        }
    });
}

// ── Snapshot-first entity reads ─────────────────────────────────────────────
//
// THE way to read a struct / planet / player / fleet: the snapshot answers
// from memory in the LCD's own entity shape; a miss costs one read (the
// guild's per-entity endpoints when the snapshot is guild-fed, else the
// chain) and the result is folded in so the next caller hits. Every other
// entity kind goes straight to the chain as before.

pub fn snapshot_entity(kind: &str, id: &str) -> Option<Value> {
    with_snapshot(|s| match kind {
        "struct" => s.struct_entity(id),
        "planet" => s.planet_entity(id),
        "player" => s.player_entity(id),
        "fleet" => s.fleet_entity(id),
        _ => None,
    })
    .flatten()
}

fn absorb_entity(kind: &str, v: &Value) {
    match kind {
        "struct" => absorb_struct_entity(v),
        "planet" => absorb_planet_entity(v),
        "player" | "fleet" => {
            let (wrapper, store_is_player) = if kind == "player" { ("Player", true) } else { ("Fleet", false) };
            let Some(row) = v.get(wrapper) else { return };
            let id = str_of(row, "id");
            if id.is_empty() {
                return;
            }
            if let Ok(mut g) = CURRENT.write() {
                if let Some(s) = g.as_mut() {
                    if store_is_player {
                        s.players.insert(id, row.clone());
                    } else {
                        s.fleets.insert(id, row.clone());
                    }
                }
            }
        }
        _ => {}
    }
}

/// One entity from the guild's own endpoints, in LCD shape. Structs use the
/// bespoke route (it carries status/health); players and fleets the batch
/// row. Planets are NOT served here: the row has no shield or ore, and a
/// caller that missed the snapshot is exactly the caller who needs them.
async fn guild_entity(client: &CosmosClient, kind: &str, id: &str) -> Result<Value, String> {
    match kind {
        "struct" => {
            let row = client.guild.struct_by_id(id).await?;
            if crate::mcp::loop_util::parse_bool(row.get("is_destroyed")) {
                return Err(format!("struct {id} not found (destroyed)"));
            }
            let st = to_u64(row.get("status"));
            let mut base = match adapt_row(&row) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            base.remove("status");
            base.remove("health");
            base.remove("isDestroyed");
            base.remove("defendingStructIds");
            let sa = json!({
                "health": to_u64(row.get("health")).to_string(),
                "status": st.to_string(),
                "blockStartBuild": "0", "blockStartOreMine": "0", "blockStartOreRefine": "0",
                "protectedStructIndex": "0", "typeCount": "0",
                "isMaterialized": st & status::MATERIALIZED != 0,
                "isBuilt": st & status::BUILT != 0,
                "isOnline": st & status::ONLINE != 0,
                "isHidden": st & status::HIDDEN != 0,
                "isDestroyed": st & status::DESTROYED != 0,
                "isLocked": st & status::LOCKED != 0,
            });
            Ok(json!({ "Struct": Value::Object(base), "structAttributes": sa, "gridAttributes": {} }))
        }
        "player" | "fleet" => {
            let (rows, _) = client.guild.objects_by_ids(&[id]).await?;
            let row = rows
                .iter()
                .find(|r| r.get("id").and_then(|x| x.as_str()) == Some(id))
                .and_then(|r| r.get("object"))
                .filter(|o| o.is_object())
                .ok_or_else(|| format!("Guild API objects has no {kind} {id}"))?;
            let wrapper = if kind == "player" { "Player" } else { "Fleet" };
            let mut v = json!({ wrapper: adapt_row(row) });
            if kind == "player" {
                v["gridAttributes"] = with_snapshot(|s| attrs_json(&GRID_ATTRS, s.grid.get(id))).unwrap_or_else(|| json!({}));
            }
            Ok(v)
        }
        _ => Err(format!("no guild entity route for {kind}")),
    }
}

pub async fn entity(client: &CosmosClient, kind: &str, id: &str) -> Result<Value, String> {
    if let Some(v) = snapshot_entity(kind, id) {
        SNAPSHOT_HITS.fetch_add(1, Ordering::Relaxed);
        return Ok(v);
    }
    if matches!(kind, "struct" | "player" | "fleet") && snapshot_source() == SnapshotSource::Guild {
        if let Ok(v) = guild_entity(client, kind, id).await {
            ENTITY_GUILD_READS.fetch_add(1, Ordering::Relaxed);
            absorb_entity(kind, &v);
            return Ok(v);
        }
    }
    let v = client.query_entity(kind, id).await?;
    ENTITY_LCD_READS.fetch_add(1, Ordering::Relaxed);
    absorb_entity(kind, &v);
    Ok(v)
}

static SNAPSHOT_HITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ENTITY_GUILD_READS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ENTITY_LCD_READS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn entity_stats() -> Value {
    json!({
        "snapshot_hits": SNAPSHOT_HITS.load(Ordering::Relaxed),
        "guild_reads": ENTITY_GUILD_READS.load(Ordering::Relaxed),
        "lcd_reads": ENTITY_LCD_READS.load(Ordering::Relaxed),
        "source": snapshot_source().name(),
        "fed_by": fed_by(),
        "hot_age_s": hot_age_ms().map(|a| (a / 1000.0) as u64),
    })
}

/// Install a snapshot as the current one (refresh, restore, tests).
pub fn install_snapshot(snap: Snapshot, source: &'static str) {
    if let Ok(mut g) = CURRENT.write() {
        *g = Some(snap);
    }
    *FED_BY.lock().unwrap_or_else(|e| e.into_inner()) = source;
}

/// The original source: the chain's own stores in 60k-row pages.
async fn lcd_pages(client: &CosmosClient, t0: f64) -> Result<Snapshot, String> {
    let result = tokio::join!(
        walk_store(client, "/structs/struct", "Struct", None),
        // The struct_attribute store rejects an un-keyed walk (query gas), but
        // walks fine from its first key.
        walk_store(client, "/structs/struct_attribute", "structAttributeRecords", Some("0-")),
        walk_store(client, "/structs/planet_attribute", "planetAttributeRecords", None),
        walk_store(client, "/structs/grid", "gridRecords", None),
        walk_store(client, "/structs/player", "Player", None),
        walk_store(client, "/structs/planet", "Planet", None),
        walk_store(client, "/structs/fleet", "Fleet", None),
    );
    let (st, sa, pa, gr, pl, pn, fl) = (result.0?, result.1?, result.2?, result.3?, result.4?, result.5?, result.6?);
    let heights = [st.1, sa.1, pa.1, gr.1, pl.1, pn.1, fl.1];
    let mut snap = Snapshot::from_pages(&st.0, &sa.0, &pa.0, &gr.0, &pl.0, &pn.0, &fl.0);
    snap.height = heights.iter().copied().max().unwrap_or(0);
    snap.min_height = heights.iter().copied().filter(|h| *h > 0).min().unwrap_or(0);
    snap.taken_ms = t0;
    snap.taken_unix_s = [st.2, sa.2, pa.2, gr.2, pl.2, pn.2, fl.2].into_iter().fold(0.0, f64::max);
    Ok(snap)
}

async fn walk_store(
    client: &CosmosClient,
    path: &str,
    list_key: &str,
    start_key: Option<&str>,
) -> Result<(Vec<Value>, u64, f64), String> {
    use base64::Engine as _;
    let mut rows = Vec::new();
    let mut key: Option<String> = start_key.map(|k| base64::engine::general_purpose::STANDARD.encode(k));
    let mut height = 0;
    let mut server_time = 0.0;
    loop {
        let q = match &key {
            Some(k) => format!("{path}?pagination.limit={PAGE_LIMIT}&pagination.key={}", super::cosmos_client::encode_pagination_key(k)),
            None => format!("{path}?pagination.limit={PAGE_LIMIT}"),
        };
        let (body, h, st) = client.lcd_get_bulk(&q).await?;
        height = height.max(h);
        server_time = f64::max(server_time, st);
        if let Some(arr) = body.get(list_key).and_then(|v| v.as_array()) {
            rows.extend(arr.iter().cloned());
        }
        key = body
            .get("pagination")
            .and_then(|p| p.get("next_key"))
            .and_then(|k| k.as_str())
            .filter(|k| !k.is_empty())
            .map(String::from);
        if key.is_none() {
            break;
        }
    }
    Ok((rows, height, server_time))
}

/// Pull a whole-galaxy snapshot and install it. ~11 requests; the pages run
/// concurrently. Returns the new snapshot's summary.
pub async fn refresh(client: &CosmosClient) -> Result<Value, String> {
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return Err("refresh already in flight".into());
    }
    let t0 = crate::hasher::types::now_millis();
    let mut fed = "lcd";
    let outcome = match snapshot_source() {
        SnapshotSource::Guild => match guild_pages(client, t0).await {
            Ok(snap) => {
                fed = "guild";
                Ok(snap)
            }
            Err(e) => {
                crate::mcp::telemetry::tlog(
                    "perception",
                    crate::mcp::telemetry::Sev::Warn,
                    format!("guild snapshot failed, falling back to the LCD walk: {e}"),
                );
                lcd_pages(client, t0).await
            }
        },
        SnapshotSource::Lcd => lcd_pages(client, t0).await,
    };
    let summary = match outcome {
        Ok(mut snap) => {
            // Replay what arrived mid-fetch, then swap in.
            let pending: Vec<_> = PENDING.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default();
            for (c, s, d) in &pending {
                snap.apply(c, s, d);
            }
            let s = snap.summary();
            // A full refresh is the one moment the snapshot is known-good
            // end to end; that is what the next launch should start from.
            persist_snapshot(&snap);
            install_snapshot(snap, fed);
            crate::mcp::telemetry::tlog_kv(
                "perception",
                crate::mcp::telemetry::Sev::Info,
                format!(
                    "snapshot refreshed @{} in {:.1}s ({} replayed)",
                    s.get("height").and_then(|h| h.as_u64()).unwrap_or(0),
                    (crate::hasher::types::now_millis() - t0) / 1000.0,
                    pending.len()
                ),
                s.clone(),
            );
            Ok(s)
        }
        Err(e) => {
            if let Ok(mut q) = PENDING.lock() {
                q.clear();
            }
            crate::mcp::telemetry::tlog("perception", crate::mcp::telemetry::Sev::Warn, format!("snapshot refresh failed: {e}"));
            Err(e)
        }
    };
    REFRESHING.store(false, Ordering::SeqCst);
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    // Live LCD shapes, captured 2026-09-02 (struct 5-1, player 1-194, planet 2-223).
    fn struct_row_5_1() -> Value {
        json!({"id":"5-1","index":"1","type":"1","creator":"structs1enc","owner":"1-2","locationType":"fleet","locationId":"9-2","operatingAmbit":"space","slot":"0"})
    }
    fn attr_rows_5_1() -> Vec<Value> {
        // health 6, status 7, everything else 0 (absent rows = zero)
        vec![json!({"attributeId":"0-5-1","value":"6"}), json!({"attributeId":"1-5-1","value":"7"})]
    }
    fn live_entity_5_1() -> Value {
        json!({"Struct":{"id":"5-1","index":"1","type":"1","creator":"structs1enc","owner":"1-2","locationType":"fleet","locationId":"9-2","operatingAmbit":"space","slot":"0"},
          "structAttributes":{"health":"6","status":"7","blockStartBuild":"0","blockStartOreMine":"0","blockStartOreRefine":"0","protectedStructIndex":"0","typeCount":"0","isMaterialized":true,"isBuilt":true,"isOnline":true,"isHidden":false,"isDestroyed":false,"isLocked":false},
          "gridAttributes":{"ore":"0","fuel":"0","capacity":"0","load":"0","structsLoad":"0","power":"0","connectionCapacity":"0","connectionCount":"0","allocationPointerStart":"0","allocationPointerEnd":"0","proxyNonce":"0","lastAction":"0","nonce":"0","ready":"0","checkpointBlock":"0"},
          "structDefenders":[]})
    }
    fn galaxy() -> Snapshot {
        let structs = vec![
            struct_row_5_1(),
            json!({"id":"5-2184","type":"14","owner":"1-194","locationType":"planet","locationId":"2-223","operatingAmbit":"space","slot":"0"}),
            json!({"id":"5-2297","type":"7","owner":"1-194","locationType":"planet","locationId":"2-223","operatingAmbit":"land","slot":"0"}),
            json!({"id":"5-9000","type":"1","owner":"1-194","locationType":"fleet","locationId":"9-194","operatingAmbit":"space","slot":"0"}),
        ];
        let mut sattr = attr_rows_5_1();
        sattr.extend([
            json!({"attributeId":"1-5-2184","value":"7"}),
            json!({"attributeId":"1-5-2297","value":"1"}), // materialized, not built
            json!({"attributeId":"2-5-2297","value":"2435000"}),
            json!({"attributeId":"1-5-9000","value":"7"}),
            json!({"attributeId":"5-5-9000","value":"2184"}),
            json!({"attributeId":"1-5-205054","value":"35"}), // orphan: no struct row
            json!({"attributeId":"6-1-194","value":"3"}),     // typeCount on a PLAYER id
        ]);
        let pattr = vec![
            json!({"attributeId":"0-2-223","value":"225"}),
            json!({"attributeId":"12-2-223","value":"1358696"}),
            json!({"attributeId":"13-2-223","value":"1616486"}),
        ];
        let grid = vec![
            json!({"attributeId":"2-1-194","value":"133641281295"}),
            json!({"attributeId":"3-1-194","value":"128000000000"}),
            json!({"attributeId":"4-1-194","value":"6530000"}),
            json!({"attributeId":"11-1-194","value":"2338643"}),
            json!({"attributeId":"0-2-223","value":"4"}),
        ];
        let players = vec![json!({"id":"1-194","guildId":"0-1","planetId":"2-223","fleetId":"9-194","primaryAddress":"structs12w"})];
        let planets = vec![json!({"id":"2-223","owner":"1-194","space":["5-2184","","",""],"air":["","","",""],"land":["5-2297","","",""],"water":["","","",""],"maxOre":"5"})];
        let fleets = vec![json!({"id":"9-194","owner":"1-194","commandStruct":"5-9000","space":["5-9000","","",""],"air":["","","",""],"land":["","","",""],"water":["","","",""]})];
        let mut s = Snapshot::from_pages(&structs, &sattr, &pattr, &grid, &players, &planets, &fleets);
        s.height = 2_436_000;
        s.min_height = 2_435_998;
        s.taken_unix_s = 1_788_370_000.0; // 2026-09-02T18:06:40Z
        s
    }

    #[test]
    fn attribute_id_parses_to_type_and_object() {
        assert_eq!(parse_attribute_id("3-5-17"), Some((3, "5-17".to_string())));
        assert_eq!(parse_attribute_id("12-2-223"), Some((12, "2-223".to_string())));
        assert_eq!(parse_attribute_id("5-17"), None);
        assert_eq!(parse_attribute_id("x-5-17"), None);
    }

    #[test]
    fn status_bits_match_live_entities() {
        // (status, isBuilt, isOnline, isHidden, isDestroyed) as read live
        // 2026-09-02; 35 and 33 are the recorded destruction transitions.
        for (st, built, online, hidden, destroyed) in [
            (7u64, true, true, false, false),
            (1, false, false, false, false),
            (23, true, true, true, false),
            (3, true, false, false, false),
            (35, true, false, false, true),
            (33, false, false, false, true),
        ] {
            assert_eq!(st & status::BUILT != 0, built, "status {st} built");
            assert_eq!(st & status::ONLINE != 0, online, "status {st} online");
            assert_eq!(st & status::HIDDEN != 0, hidden, "status {st} hidden");
            assert_eq!(st & status::DESTROYED != 0, destroyed, "status {st} destroyed");
            assert_eq!(st & status::LOCKED, 0, "status {st} never locked");
        }
    }

    #[test]
    fn destruction_is_a_status_35_event_and_shows_as_is_destroyed() {
        let mut s = galaxy();
        // The recorded shape, verbatim: 7 → 35 on the planet subject.
        let d = json!({"block_height":2436050,"planet_id":"2-223","player_id":"1-194","seq":9,"status":35,"status_old":7,"struct_id":"5-2184"});
        assert_eq!(s.apply("struct_status", "structs.planet.2-223.1-194", &d), Applied::Changed);
        let e = s.struct_entity("5-2184").unwrap();
        assert_eq!(e["structAttributes"]["isDestroyed"], true);
        assert_eq!(e["structAttributes"]["isOnline"], false);
        let mine: Vec<Value> = s.player_structs("1-194").into_iter().filter(|r| r["id"] == "5-2184").collect();
        assert_eq!(mine[0]["is_destroyed"], true, "loops filter on is_destroyed, as they do today");
        assert!(s.struct_exists("5-2184"), "row lingers until the next refresh prunes it, flagged destroyed");
    }

    #[test]
    fn struct_entity_matches_the_lcd_shape_field_for_field() {
        let s = galaxy();
        let ours = s.struct_entity("5-1").unwrap();
        let live = live_entity_5_1();
        assert_eq!(ours["Struct"]["id"], live["Struct"]["id"]);
        assert_eq!(ours["Struct"]["type"], live["Struct"]["type"]);
        assert_eq!(ours["Struct"]["locationType"], live["Struct"]["locationType"]);
        assert_eq!(ours["Struct"]["locationId"], live["Struct"]["locationId"]);
        assert_eq!(ours["Struct"]["operatingAmbit"], live["Struct"]["operatingAmbit"]);
        assert_eq!(ours["Struct"]["slot"], live["Struct"]["slot"]);
        assert_eq!(ours["structAttributes"], live["structAttributes"], "structAttributes incl. derived booleans");
        assert_eq!(ours["gridAttributes"], live["gridAttributes"]);
        // consumers' coercions see identical values
        use crate::mcp::loop_util::{parse_bool, read_u64_field};
        let sa = ours.get("structAttributes");
        assert!(parse_bool(sa.and_then(|x| x.get("isBuilt"))));
        assert!(parse_bool(sa.and_then(|x| x.get("isOnline"))));
        assert_eq!(read_u64_field(sa, "blockStartBuild"), 0);
    }

    #[test]
    fn pruned_struct_with_orphan_attribute_row_does_not_exist() {
        let s = galaxy();
        assert_eq!(s.struct_status("5-205054"), 35, "attribute row is present");
        assert!(!s.struct_exists("5-205054"));
        assert!(s.struct_entity("5-205054").is_none());
    }

    #[test]
    fn player_struct_ids_union_slots_and_command_struct() {
        let s = galaxy();
        assert_eq!(s.player_struct_ids("1-194"), vec!["5-2297", "5-2184", "5-9000"]);
        assert!(s.player_struct_ids("1-999").is_empty());
    }

    #[test]
    fn player_structs_has_the_loop_util_shape() {
        let s = galaxy();
        let v = s.player_structs("1-194");
        assert_eq!(v.len(), 3);
        let r = &v[0];
        assert_eq!(r["id"], "5-2297");
        assert_eq!(r["type"], "7");
        assert_eq!(r["location_type"], "planet");
        assert_eq!(r["location_id"], "2-223");
        assert_eq!(r["operating_ambit"], "land");
        assert_eq!(r["slot"].as_u64(), Some(0));
        assert_eq!(r["is_built"], false);
        assert_eq!(r["is_destroyed"], false);
        assert_eq!(v[1]["is_built"], true);
    }

    #[test]
    fn planet_entity_feeds_planet_ore_anchor_unchanged() {
        let s = galaxy();
        let p = s.planet_entity("2-223").unwrap();
        assert_eq!(crate::mcp::loop_util::planet_ore_anchor(Some(&p), "MINE"), 1_358_696);
        assert_eq!(crate::mcp::loop_util::planet_ore_anchor(Some(&p), "REFINE"), 1_616_486);
        assert_eq!(p["planetAttributes"]["planetaryShield"], "225");
        assert_eq!(p["gridAttributes"]["ore"], "4");
        assert_eq!(p["Planet"]["maxOre"], "5");
    }

    #[test]
    fn player_entity_grid_matches_live_values() {
        let s = galaxy();
        let p = s.player_entity("1-194").unwrap();
        let ga = p.get("gridAttributes");
        assert_eq!(crate::mcp::loop_util::parse_f64(ga.and_then(|g| g.get("structsLoad"))), 6_530_000.0);
        assert_eq!(crate::mcp::loop_util::parse_f64(ga.and_then(|g| g.get("capacity"))), 133_641_281_295.0);
        assert_eq!(ga.and_then(|g| g.get("lastAction")), Some(&json!("2338643")));
    }

    // ── GRASS apply, using the recorded payloads verbatim ──

    #[test]
    fn grid_event_updates_player_ore_with_precise_value() {
        let mut s = galaxy();
        let d = json!({"attribute_type":"structsLoad","object_id":"1-194","object_type":"player","player_id":"1-194","updated_at":"2026-09-02T18:10:00.000000+00:00","value":2935,"value_old":2735,"value_old_p":2735000,"value_p":2935000});
        assert_eq!(s.apply("structsLoad", "structs.grid.player.1-194.1-194", &d), Applied::Changed);
        assert_eq!(s.player_entity("1-194").unwrap()["gridAttributes"]["structsLoad"], "2935000");
        assert_eq!(s.apply("structsLoad", "structs.grid.player.1-194.1-194", &d), Applied::NoChange, "replay is idempotent");
        assert_eq!(s.events_applied, 1);
    }

    #[test]
    fn grid_event_older_than_the_snapshot_is_dropped() {
        let mut s = galaxy();
        let d = json!({"attribute_type":"ore","object_id":"2-223","object_type":"planet","updated_at":"2026-09-02T17:00:00.000000+00:00","value":1,"value_p":1});
        assert_eq!(s.apply("ore", "structs.grid.planet.2-223.1-194", &d), Applied::Stale);
        assert_eq!(s.planet_entity("2-223").unwrap()["gridAttributes"]["ore"], "4");
    }

    #[test]
    fn struct_status_event_flips_built_and_online() {
        let mut s = galaxy();
        let d = json!({"block_height":2435999,"planet_id":"2-223","player_id":"1-194","seq":21,"status":7,"status_old":1,"struct_id":"5-2297","time":"2026-09-02T17:34:35.841447+00:00"});
        assert_eq!(s.apply("struct_status", "structs.planet.2-223.1-194", &d), Applied::Changed);
        let e = s.struct_entity("5-2297").unwrap();
        assert_eq!(e["structAttributes"]["isBuilt"], true);
        assert_eq!(e["structAttributes"]["isOnline"], true);
        assert_eq!(e["structAttributes"]["blockStartBuild"], "0", "completion clears the build clock silently; mirrored");
        assert_eq!(s.player_structs("1-194")[0]["is_built"], true);
        // A status change that does NOT cross into built leaves the clock alone.
        let mut s2 = galaxy();
        let offline = json!({"block_height":2436001,"status":3,"status_old":7,"struct_id":"5-2184"});
        assert_eq!(s2.apply("struct_status", "structs.planet.2-223.1-194", &offline), Applied::Changed);
        assert_eq!(s2.struct_entity("5-2184").unwrap()["structAttributes"]["isOnline"], false);
    }

    #[test]
    fn planet_activity_event_older_than_the_snapshot_is_stale() {
        let mut s = galaxy();
        let d = json!({"block_height":2435000,"status":1,"status_old":7,"struct_id":"5-2184"});
        assert_eq!(s.apply("struct_status", "structs.planet.2-223.1-194", &d), Applied::Stale);
        assert_eq!(s.struct_status("5-2184"), 7);
        assert_eq!(s.events_skipped_stale, 1);
    }

    #[test]
    fn health_defense_and_move_events_land_on_the_right_fields() {
        let mut s = galaxy();
        let h = json!({"block_height":2436001,"health":1,"health_old":6,"struct_id":"5-1"});
        assert_eq!(s.apply("struct_health", "structs.planet.2-9.1-2", &h), Applied::Changed);
        assert_eq!(s.struct_entity("5-1").unwrap()["structAttributes"]["health"], "1");

        let add = json!({"block_height":2436001,"defender_struct_id":"5-2184","planet_id":"2-223","protected_struct_id":"5-2297"});
        assert_eq!(s.apply("struct_defense_add", "structs.planet.2-223.1-194", &add), Applied::Changed);
        assert_eq!(s.struct_entity("5-2184").unwrap()["structAttributes"]["protectedStructIndex"], "2297");
        let rm = json!({"block_height":2436002,"defender_struct_id":"5-2184","planet_id":"2-223","protected_struct_id":"5-2297"});
        assert_eq!(s.apply("struct_defense_remove", "structs.planet.2-223.1-194", &rm), Applied::Changed);
        assert_eq!(s.struct_entity("5-2184").unwrap()["structAttributes"]["protectedStructIndex"], "0");

        let mv = json!({"ambit":"air","block_height":2436003,"location_id":"9-194","location_type":"fleet","planet_id":"2-223","slot":2,"struct_id":"5-2184"});
        assert_eq!(s.apply("struct_move", "structs.planet.2-223.1-194", &mv), Applied::Changed);
        let e = s.struct_entity("5-2184").unwrap();
        assert_eq!(e["Struct"]["locationType"], "fleet");
        assert_eq!(e["Struct"]["locationId"], "9-194");
        assert_eq!(e["Struct"]["operatingAmbit"], "air");
        assert_eq!(e["Struct"]["slot"], "2");
        assert_eq!(s.apply("struct_move", "structs.planet.2-223.1-194", &mv), Applied::NoChange);
    }

    #[test]
    fn build_start_for_an_unknown_struct_is_queued_for_a_read() {
        let mut s = galaxy();
        let d = json!({"block":2436005,"block_height":2436005,"planet_id":"2-223","player_id":"1-194","struct_id":"5-777777"});
        assert_eq!(s.apply("struct_block_build_start", "structs.planet.2-223.1-194", &d), Applied::Changed);
        assert_eq!(s.pending_new_structs(), vec!["5-777777"]);
        assert!(s.struct_entity("5-777777").is_none(), "no row until read");
        // The follow-up entity read resolves it.
        s.absorb_struct_entity(&json!({"Struct":{"id":"5-777777","type":"14","owner":"1-194","locationType":"planet","locationId":"2-223","operatingAmbit":"land","slot":"1"},
            "structAttributes":{"health":"0","status":"1","blockStartBuild":"2436005","isBuilt":false,"isOnline":false}}));
        assert!(s.pending_new_structs().is_empty());
        let e = s.struct_entity("5-777777").unwrap();
        assert_eq!(e["Struct"]["slot"], "1");
        assert_eq!(e["structAttributes"]["blockStartBuild"], "2436005");
        assert_eq!(e["structAttributes"]["isBuilt"], false);
        assert_eq!(s.player_structs("1-194").len(), 3, "not in a slot array until the planet row says so");
    }

    #[test]
    fn shield_and_raid_events_update_planet_attributes() {
        let mut s = galaxy();
        let d = json!({"block_height":2436010,"planet_id":"2-223","planetary_shield":50,"planetary_shield_old":25,"player_id":"1-194"});
        assert_eq!(s.apply("shield_change", "structs.planet.2-223.1-194", &d), Applied::Changed);
        assert_eq!(s.planet_entity("2-223").unwrap()["planetAttributes"]["planetaryShield"], "50");
        let r = json!({"block_height":2436011,"block":2436011,"planet_id":"2-223"});
        assert_eq!(s.apply("block_raid_start", "structs.planet.2-223.1-194", &r), Applied::Changed);
        assert_eq!(s.planet_entity("2-223").unwrap()["planetAttributes"]["blockStartRaid"], "2436011");
    }

    #[test]
    fn raw_nats_frame_with_nested_detail_applies_like_the_flattened_one() {
        // Exactly what a direct `structs.>` subscriber receives for a planet
        // event: row fields under `detail`, routing fields at the top.
        let mut s = galaxy();
        let raw = json!({"subject":"structs.planet.2-223.1-194","planet_id":"2-223","player_id":"1-194","seq":21,"category":"struct_status",
            "time":"2026-09-02T17:34:35.841447+00:00",
            "detail":{"block_height":2436001,"status":7,"status_old":1,"struct_id":"5-2297"}});
        assert_eq!(s.apply("struct_status", "structs.planet.2-223.1-194", &raw), Applied::Changed);
        assert_eq!(s.struct_status("5-2297"), 7);
        // …and the stale guard still reads the nested height.
        let old = json!({"category":"struct_status","detail":{"block_height":2435000,"status":1,"struct_id":"5-2297"}});
        assert_eq!(s.apply("struct_status", "structs.planet.2-223.1-194", &old), Applied::Stale);
        assert_eq!(s.struct_status("5-2297"), 7);
    }

    #[test]
    fn inventory_and_block_frames_are_ignored_not_errors() {
        let mut s = galaxy();
        let mined = json!({"action":"mined","amount":1,"block_height":2436020,"player_id":"1-194"});
        assert_eq!(s.apply("mined", "structs.inventory.ore.0-1.1-194.structs12w", &mined), Applied::Ignored);
        assert_eq!(s.apply("block", "structs.global", &json!({"height":2436021})), Applied::Ignored);
        assert_eq!(s.events_applied, 0);
    }

    #[test]
    fn iso_timestamps_parse_to_unix_seconds() {
        assert_eq!(iso_to_unix("2026-09-02T17:34:41.606433+00:00").map(|t| t.floor()), Some(1_788_370_481.0));
        assert_eq!(iso_to_unix("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(iso_to_unix("2026-09-02T19:34:41+02:00").map(|t| t.floor()), Some(1_788_370_481.0));
        assert_eq!(iso_to_unix("garbage"), None);
    }

    #[test]
    fn to_u64_accepts_lcd_strings_and_grass_numbers() {
        assert_eq!(to_u64(Some(&json!("133641281295"))), 133_641_281_295);
        assert_eq!(to_u64(Some(&json!(2935000))), 2_935_000);
        assert_eq!(to_u64(Some(&json!(null))), 0);
        assert_eq!(to_u64(None), 0);
    }
}

#[cfg(test)]
mod guild_ingest_tests {
    use super::*;

    #[test]
    fn a_signed_completion_restarts_only_a_known_planets_clock() {
        let mut snap = Snapshot::default();
        snap.planets.insert("2-223".into(), json!({"id": "2-223"}));
        snap.planet_attrs.insert("2-223".into(), {
            let mut a = [0u64; 16];
            a[P_MINE] = 1_358_696;
            a
        });
        assert!(snap.restart_clock("2-223", "MINE", 2_470_534));
        assert_eq!(snap.planet_attrs["2-223"][P_MINE], 2_470_534);
        assert!(!snap.restart_clock("2-223", "MINE", 2_470_534), "same block twice is no change");
        assert!(snap.restart_clock("2-223", "REFINE", 2_470_540));
        assert_eq!(snap.planet_attrs["2-223"][P_REFINE], 2_470_540);
        assert!(!snap.restart_clock("2-999", "MINE", 5), "never invents a planet");
        assert!(!snap.restart_clock("2-223", "BUILD", 5), "build clocks live on the struct");
        assert!(!snap.restart_clock("2-223", "MINE", 0));
    }

    #[test]
    fn guild_rows_adapt_to_the_lcd_shapes_the_snapshot_speaks() {
        // Verbatim from live `/api/objects?ids=` rows (2026-09-04).
        let planet = json!({"id": "2-22432", "max_ore": 5, "owner": "1-195",
            "map": "{\"air\": [\"\", \"\", \"\", \"\"], \"land\": [\"5-236182\", \"5-192030\", \"\", \"\"], \"space\": [\"5-232859\", \"5-205581\", \"\", \"\"], \"water\": [\"\", \"5-237384\", \"\", \"\"]}",
            "space_slots": 4, "status": "active", "name": "Oymop Major"});
        let p = adapt_row(&planet);
        assert_eq!(p["maxOre"], json!(5));
        assert_eq!(p["spaceSlots"], json!(4));
        assert_eq!(p["land"][1], json!("5-192030"));
        assert_eq!(p["air"].as_array().unwrap().len(), 4);
        assert!(p.get("map").is_none(), "map is expanded, not carried");
        let fleet = json!({"id": "9-195", "owner": "1-195", "map": "{\"air\": [\"5-200230\"], \"land\": [], \"space\": [], \"water\": []}",
            "location_type": "planet", "location_id": "2-22432", "status": "onStation", "command_struct": "5-203656"});
        let f = adapt_row(&fleet);
        assert_eq!(f["commandStruct"], json!("5-203656"));
        assert_eq!(f["locationId"], json!("2-22432"));
        assert_eq!(f["status"], json!("onStation"));
        let player = json!({"id": "1-195", "guild_id": "0-1", "planet_id": "2-22432", "fleet_id": "9-195", "primary_address": "structs1f9h"});
        let pl = adapt_row(&player);
        assert_eq!((pl["guildId"].as_str(), pl["planetId"].as_str(), pl["fleetId"].as_str()), (Some("0-1"), Some("2-22432"), Some("9-195")));
    }

    #[test]
    fn struct_rows_drop_destroyed_and_attribute_rows_become_attribute_ids() {
        let structs = vec![
            json!({"id": "5-1", "type": 14, "owner": "1-1", "location_type": "planet", "location_id": "2-1", "operating_ambit": "land", "slot": 1, "is_destroyed": false}),
            json!({"id": "5-2", "type": 1, "owner": "1-1", "location_type": "fleet", "location_id": "9-1", "operating_ambit": "space", "slot": 0, "is_destroyed": true}),
        ];
        let rows = adapt_struct_rows(&structs);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["locationType"], json!("planet"));
        assert_eq!(rows[0]["operatingAmbit"], json!("land"));
        let attrs = vec![
            json!({"object_id": "5-1", "attribute_type": "status", "val": "7"}),
            json!({"object_id": "5-1", "attribute_type": "blockStartBuild", "val": 2455000}),
            json!({"object_id": "5-1", "attribute_type": "somethingNew", "val": 1}),
            json!({"object_id": "", "attribute_type": "status", "val": 1}),
        ];
        let a = adapt_attribute_rows(&attrs, &STRUCT_ATTRS);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0]["attributeId"], json!("1-5-1"));
        assert_eq!(a[1]["attributeId"], json!("2-5-1"));
        // …and the snapshot reads them exactly like LCD attribute rows.
        let snap = Snapshot::from_pages(&rows, &a, &[], &[], &[], &[], &[]);
        assert_eq!(snap.struct_status("5-1"), 7);
        assert_eq!(snap.struct_attr("5-1", "blockStartBuild"), Some(2455000));
        assert!(!snap.struct_exists("5-2"));
    }

    #[test]
    fn attribute_rows_key_on_the_id_prefix_when_the_name_is_missing() {
        // Verbatim shape of the indexer's unnamed ore-clock rows (2026-09-04).
        let rows = vec![
            json!({"id": "12-2-27264", "object_id": "2-27264", "object_type": "planet", "attribute_type": null, "val": 2469533}),
            json!({"id": "13-2-27264", "object_id": "2-27264", "object_type": "planet", "val": 2469000}),
            json!({"id": "0-2-27264", "object_id": "2-27264", "attribute_type": "planetaryShield", "val": "225"}),
            json!({"id": "99-2-27264", "object_id": "2-27264", "val": 1}),
            json!({"object_id": "2-1", "attribute_type": "planetaryShield", "val": 5}),
        ];
        let a = adapt_attribute_rows(&rows, &PLANET_ATTRS);
        let ids: Vec<&str> = a.iter().map(|r| r["attributeId"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["12-2-27264", "13-2-27264", "0-2-27264", "99-2-27264", "0-2-1"]);
        let snap = Snapshot::from_pages(&[], &[], &a, &[], &[], &[json!({"id": "2-27264"})], &[]);
        assert_eq!(snap.planet_attr("2-27264", "blockStartOreMine"), Some(2469533));
        assert_eq!(snap.planet_attr("2-27264", "blockStartOreRefine"), Some(2469000));
        // An index the store has no slot for is dropped by from_pages (99 ≥ 16),
        // exactly as an LCD row with that id would be.
        assert!(snap.planet_attrs.get("2-27264").unwrap().iter().all(|v| *v < 2_500_000));
        // typeCount rows carry a SUB index (`6-1-100-1` on the LCD, same on the
        // guild): the id passes through untouched and from_pages skips it, so
        // the two sources agree instead of the guild path inventing a
        // per-player typeCount from the name.
        let tc = adapt_attribute_rows(&[json!({"id": "6-1-1386-1", "object_id": "1-1386", "sub_index": 1, "attribute_type": "typeCount", "val": 1})], &STRUCT_ATTRS);
        assert_eq!(tc[0]["attributeId"], json!("6-1-1386-1"));
        let s2 = Snapshot::from_pages(&[], &tc, &[], &[], &[], &[], &[]);
        assert!(s2.struct_attrs.get("1-1386").is_none());
    }

    #[test]
    fn work_rows_set_ore_and_build_clocks_and_clear_our_idle_planets() {
        let structs = vec![
            json!({"id": "5-1", "type": "14", "owner": "1-10", "locationType": "planet", "locationId": "2-1", "operatingAmbit": "land", "slot": "0"}),
            json!({"id": "5-2", "type": "15", "owner": "1-10", "locationType": "planet", "locationId": "2-1", "operatingAmbit": "land", "slot": "1"}),
            json!({"id": "5-3", "type": "7", "owner": "1-10", "locationType": "fleet", "locationId": "9-10", "operatingAmbit": "air", "slot": "0"}),
            json!({"id": "5-4", "type": "14", "owner": "1-11", "locationType": "planet", "locationId": "2-2", "operatingAmbit": "land", "slot": "0"}),
        ];
        let players = vec![
            json!({"id": "1-10", "guildId": "0-1", "planetId": "2-1"}),
            json!({"id": "1-11", "guildId": "0-1", "planetId": "2-2"}),
            json!({"id": "1-99", "guildId": "0-5", "planetId": "2-9"}),
        ];
        let planets = vec![json!({"id": "2-1"}), json!({"id": "2-2"}), json!({"id": "2-9"})];
        let pattr = vec![json!({"attributeId": "12-2-2", "value": "5"}), json!({"attributeId": "12-2-9", "value": "7"})];
        let mut snap = Snapshot::from_pages(&structs, &[], &pattr, &[], &players, &planets, &[]);
        let rows = vec![
            json!({"object_id": "5-1", "player_id": "1-10", "category": "MINE", "block_start": 2283000}),
            json!({"object_id": "5-2", "player_id": "1-10", "category": "REFINE", "block_start": "2280000"}),
            json!({"object_id": "5-3", "player_id": "1-10", "category": "BUILD", "block_start": 2290000}),
            json!({"object_id": "5-404", "player_id": "1-10", "category": "MINE", "block_start": 1}),
        ];
        let changed = apply_work_rows(&mut snap, &rows, "0-1");
        assert_eq!(snap.planet_attr("2-1", "blockStartOreMine"), Some(2283000));
        assert_eq!(snap.planet_attr("2-1", "blockStartOreRefine"), Some(2280000));
        assert_eq!(snap.struct_attr("5-3", "blockStartBuild"), Some(2290000));
        // 1-11's planet has no MINE row → cleared; 1-99 is another guild → untouched.
        assert_eq!(snap.planet_attr("2-2", "blockStartOreMine"), Some(0));
        assert_eq!(snap.planet_attr("2-9", "blockStartOreMine"), Some(7));
        assert_eq!(changed, 4, "mine, refine, build, and the one clear");
        // Idempotent.
        assert_eq!(apply_work_rows(&mut snap, &rows, "0-1"), 0);
    }

    #[test]
    fn ore_clock_start_frames_set_the_planet_clocks() {
        let mut snap = Snapshot::from_pages(&[], &[], &[], &[], &[], &[json!({"id": "2-28137"})], &[]);
        snap.min_height = 2_469_000;
        // Verbatim planet_activity rows (2026-09-04): detail carries block + planet_id.
        assert_eq!(snap.apply("struct_block_ore_mine_start", "structs.planet.2-28137.1-9", &json!({"block": 2469864, "planet_id": "2-28137", "block_height": 2469864})), Applied::Changed);
        assert_eq!(snap.apply("struct_block_ore_refine_start", "structs.planet.2-28137.1-9", &json!({"block": 2469870, "planet_id": "2-28137", "block_height": 2469870})), Applied::Changed);
        assert_eq!(snap.planet_attr("2-28137", "blockStartOreMine"), Some(2469864));
        assert_eq!(snap.planet_attr("2-28137", "blockStartOreRefine"), Some(2469870));
        assert_eq!(snap.apply("struct_block_ore_mine_start", "s", &json!({"block": 2469864, "planet_id": "2-28137"})), Applied::NoChange);
        assert_eq!(snap.apply("struct_block_ore_mine_start", "s", &json!({"block": 1})), Applied::Ignored);
    }

    #[test]
    fn a_shrunken_snapshot_is_refused() {
        assert!(snapshot_plausible(None, (10, 1, 1)).is_ok(), "first snapshot: nothing to compare");
        assert!(snapshot_plausible(Some((51_000, 2_700, 16_000)), (50_100, 2_690, 16_010)).is_ok());
        let e = snapshot_plausible(Some((51_000, 2_700, 16_000)), (1_000, 2_700, 16_000)).unwrap_err();
        assert!(e.contains("1000 structs"), "{e}");
        assert!(snapshot_plausible(Some((50, 5, 5)), (10, 5, 5)).is_ok(), "tiny previous stores don't gate");
    }

    #[test]
    fn page_walks_end_on_a_short_page_not_the_requested_limit() {
        use crate::mcp::guild_api::page_walk_continues;
        // Server clamped us to 1,000: page 1 has 1,000 → continue; 1,000 again → continue; 412 → stop.
        assert!(page_walk_continues(1000, 1000));
        assert!(!page_walk_continues(1000, 412));
        assert!(!page_walk_continues(0, 0), "an empty first page is the end");
        assert!(!page_walk_continues(1000, 0));
    }
}
