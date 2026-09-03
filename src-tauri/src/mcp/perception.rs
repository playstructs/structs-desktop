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
pub fn maybe_refresh(client: &CosmosClient) {
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
        match client.query_entity("struct", &sid).await {
            Ok(e) => {
                absorb_struct_entity(&e);
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
    let outcome = (|| -> Result<Snapshot, String> {
        let (st, sa, pa, gr, pl, pn, fl) = (result.0?, result.1?, result.2?, result.3?, result.4?, result.5?, result.6?);
        let heights = [st.1, sa.1, pa.1, gr.1, pl.1, pn.1, fl.1];
        let mut snap = Snapshot::from_pages(&st.0, &sa.0, &pa.0, &gr.0, &pl.0, &pn.0, &fl.0);
        snap.height = heights.iter().copied().max().unwrap_or(0);
        snap.min_height = heights.iter().copied().filter(|h| *h > 0).min().unwrap_or(0);
        snap.taken_ms = t0;
        snap.taken_unix_s = [st.2, sa.2, pa.2, gr.2, pl.2, pn.2, fl.2].into_iter().fold(0.0, f64::max);
        Ok(snap)
    })();
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
            if let Ok(mut g) = CURRENT.write() {
                *g = Some(snap);
            }
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
