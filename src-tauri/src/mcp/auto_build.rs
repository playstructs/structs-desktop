//! Native auto-FILL loop — builds out each virtual player's defenses across every
//! free slot, hands-off, so the operator never has to fire hundreds of charge-paced
//! builds by hand. Two jobs per scan, per owned player:
//!   1. COMPLETE — any building struct whose build-PoW difficulty has decayed to ≤
//!      the threshold gets its `complete_build` PoW kicked off (same path as mining).
//!   2. INITIATE — if charge ≥ 8 and power headroom remains, initiate ONE build in
//!      the next free slot, picking a defensive type by a per-ambit loadout.
//! Charge-paced by construction (one initiate per player per scan; charge resets to
//! 0 per action and regenerates ~1/block), power-capped (won't push a player
//! offline), and it idles once every slot is full. Off until enabled. Sibling to
//! [`auto_harvest`]; both spawn from `sync_game_state`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

use crate::hasher::difficulty::calculate_difficulty;
use crate::hasher::types::{now_millis, TaskParams, TaskRegistry};
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_build.json";
pub(crate) const SLOTS_PER_AMBIT: usize = 4;
const BUILD_CHARGE: u64 = 8;

/// Priority-ordered defensive loadout: (target location_type, ambit, type name,
/// want-count). Cheap/high-value first (shields, then evasive ships), heavy Ore
/// Bunkers last so the power gate trims them rather than the cheaper structs.
///
/// `want` is the TOTAL number of that type this loadout keeps in that
/// (location, ambit) key. The old format had no count, and the walk filled all
/// four slots with the FIRST entry per key — so `Submersible`, `Starfighter`
/// and the raider `Tank` were dead letters that never built, and every fleet
/// was a 4×-monoculture per ambit. The game is rock-paper-scissors across 13
/// fleet hulls (guided vs unguided vs jamming vs armour vs counter-immunity);
/// a monoculture has no answer to whole classes of opponent.
///
/// The template is the strongest player on the shard (1-61 "JPEG", 68
/// successful raids, K/D 397:93, home cracked once in 9 attempts): his fleet
/// fields ALL 13 hull types — a diverse line per ambit — and his planet stacks
/// shield contributors (4× Ore Bunker, 3× OSG, Jamming Satellite, PDC).
pub(crate) const LOADOUT: &[(&str, &str, &str, usize)] = &[
    // Miner + core planetary defense first — the 1-per-player types are
    // skipped when already present, but get rebuilt after an explore (the old
    // planet's structs are destroyed on completion, freeing the limit).
    ("planet", "land", "Ore Extractor", 1),
    ("planet", "water", "Planetary Defense Cannon", 1),
    ("planet", "space", "Orbital Shield Generator", 3),
    // Second guided-evasion layer for every planet-borne struct (the
    // interceptor net), +12 planetary shield — and we never fielded one.
    ("planet", "space", "Jamming Satellite", 1),
    // FLEET ORDER IS COVERAGE ORDER. Slots free ONE AT A TIME through combat
    // attrition (the chain has no decommission message), so whatever sits at
    // the top of this list is what a rebuilding fleet actually gets — possibly
    // for months. The old order led with Pursuit Fighter x2 and Tank x2, both
    // of which reach ONLY the ambit they stand in: every shot they can ever
    // offer is same-ambit, which eats the full counter and is refused by
    // auto_response's suicidal-shot gate. Measured on the live roster
    // 2026-08-18: under the old order a fleet was still BLIND after 2 rebuilt
    // slots and PARTIAL after 8; under this one it is READY after 2.
    //
    // The two hulls that buy it, both from LAND slots:
    //   * Mobile Artillery — counter-immune (pays nothing however defended the
    //     target is) and reaches water+land.
    //   * SAM Launcher — reaches AIR+SPACE from land, i.e. cross-ambit into the
    //     two ambits nothing else in the list covers early. Air was blind
    //     across every player audited on the live roster.
    // A Command Ship can sit in ANY of the four ambits, so all four must be
    // answerable — see `mcp::readiness`.
    //
    // Totals per ambit are UNCHANGED (land 4, water 4, air 4, space 4); this is
    // purely priority. Same-ambit-only hulls (Tank, Pursuit Fighter,
    // Starfighter) still build — they block and they add bulk — but last,
    // once every ambit already has a viable answer.
    ("fleet", "land", "Mobile Artillery", 1),
    ("fleet", "land", "SAM Launcher", 1),
    // A Battleship sits in a SPACE slot but its primary reaches [water, land]
    // and is ARMOUR-PIERCING — the only piercing hull, the answer to armoured
    // Tanks and the armoured planetary hulls.
    ("fleet", "space", "Battleship", 2),
    // A Cruiser earns its slot on its SECONDARY: the only unguided weapon in
    // the game that reaches AIR, where signalJamming Pursuit Fighters (2/3
    // evade vs guided) live. Without one we cannot answer that hull.
    ("fleet", "water", "Cruiser", 2),
    // Best counter in the game after the CMD: advancedCounterAttack 2 same /
    // 1 cross, reach water+air.
    ("fleet", "water", "Destroyer", 1),
    ("fleet", "water", "Submersible", 1),
    ("fleet", "space", "Frigate", 1),
    // defensiveManeuver: the ONLY hull that evades UNGUIDED 2/3 — the mirror
    // of the Pursuit Fighter, and the duelist vs Battleships/Tanks/artillery.
    ("fleet", "air", "High Altitude Interceptor", 1),
    ("fleet", "air", "Stealth Bomber", 1),
    // Same-ambit-only from here down: real value as blockers and bulk, no
    // value as an answer to a raider's Command Ship.
    ("fleet", "land", "Tank", 2),
    ("fleet", "air", "Pursuit Fighter", 2),
    ("fleet", "space", "Starfighter", 1),
    ("planet", "land", "Ore Bunker", 3),
];

/// Offence-first loadout for RAIDERS. Their job is to grind down a defended
/// Command Ship and survive to do it again, which rewards a different set from
/// the defensive filler above.
///
/// Leads with the two hulls that change the arithmetic of a siege:
///   * **Mobile Artillery** cannot be countered at all (`attackCounterable:
///     false` overrides its own weapon flag — measured: it shot a surviving
///     same-ambit Tank and took nothing back, where a Tank doing the same took
///     1). Counter damage is what kills raiders: a Command Ship returns 2 and
///     defender counters STACK on top, so a Tank assault loses a hull every two
///     or three shots while Mobile Artillery grinds for free.
///   * **Battleship** pierces armour, doubling damage against the Tank and the
///     armoured planetary hulls, from a space slot the defender is rarely
///     contesting.
///
/// A Command Ship comes early because a raider without one is grounded — the
/// chain refuses `MsgFleetMove` with "needs an online command struct".
pub(crate) const RAIDER_LOADOUT: &[(&str, &str, &str, usize)] = &[
    ("fleet", "land", "Command Ship", 1),
    ("fleet", "land", "Mobile Artillery", 2),
    // Ahead of the Battleship deliberately: the Battleship is 2 slots of
    // armour-piercing damage, but the Frigate is the ONE hull that unlocks two
    // whole ambits. Being able to reach the target at all precedes hitting it
    // harder — a raider that cannot reach the ambit its target sits in has
    // flown out for nothing.
    // Moved up from 10th 2026-08-18: reaches AIR+SPACE from one space slot, so
    // a raider can answer a Command Ship parked in either. Mobile Artillery
    // and the Battleship already cover water+land, so this single hull is what
    // completes all four — and a raider that cannot reach the ambit its target
    // sits in has flown out for nothing.
    ("fleet", "space", "Frigate", 1),
    // The Frigate above buys AIR but not SPACE — it STANDS in space, so a
    // space target is a same-ambit shot for it and the suicidal gate refuses
    // that. This reaches space from an AIR slot, which is what actually closes
    // the last ambit. Kept ahead of the rest of the filler for that reason.
    ("fleet", "air", "High Altitude Interceptor", 1),
    ("fleet", "space", "Battleship", 2),
    ("planet", "land", "Ore Refinery", 1),
    // The Tank was a dead letter before (Mobile Artillery filled all four land
    // slots first): now capped at 2 MA so the raider carries a same-ambit
    // armoured BLOCKER for its own Command Ship. Measured 2026-08-13: our
    // raider's Tank blocker absorbed three counter-immune Mobile Artillery
    // shots aimed at the Command Ship before falling — blocking is the only
    // defense counter-immunity cannot bypass.
    // ONE, not two: land holds 4 and the Command Ship plus 2 Mobile Artillery
    // already claim 3, so a `2` here was a slot that never existed.
    ("fleet", "land", "Tank", 1),
    ("fleet", "water", "Cruiser", 2),
    ("fleet", "air", "Stealth Bomber", 1),
    ("fleet", "space", "Starfighter", 1),
    ("fleet", "water", "Destroyer", 1),
    ("fleet", "water", "Submersible", 1),
    ("fleet", "air", "Pursuit Fighter", 2),
    // A raid dispatch opens the raider's own home for the whole trip; shield
    // contributors lengthen the proof anyone grinds against it meanwhile.
    ("planet", "space", "Orbital Shield Generator", 2),
];

/// Production-first loadout for PRODUCTIVE players: extractor + refinery (the
/// alpha pipeline) + a command ship (raid gate) + light defense. The 1-per-player
/// types build only if absent (see ONE_PER_PLAYER); the rest fill by slot count.
pub(crate) const PRODUCTIVE_LOADOUT: &[(&str, &str, &str, usize)] = &[
    ("planet", "land", "Ore Extractor", 1),
    ("planet", "land", "Ore Refinery", 1),
    ("fleet", "land", "Command Ship", 1),
    ("planet", "space", "Orbital Shield Generator", 3),
    ("planet", "space", "Jamming Satellite", 1),
    // Coverage order, same rationale as LOADOUT: a Command Ship can sit in any
    // of the four ambits, and a hull that only reaches its OWN ambit can never
    // offer a shot auto_response will take. Counter-immune decapitation first
    // (killing the raider's Command Ship ends a raid 17/17, and Mobile
    // Artillery does it with zero attrition), then the one hull that covers
    // the two hard ambits at once.
    ("fleet", "land", "Mobile Artillery", 1),
    // Reaches AIR+SPACE from a space slot. Added 2026-08-18: without it a
    // productive player was BLIND IN AIR outright — nothing in this list
    // reached air cross-ambit, so a raider parking a Command Ship there was
    // untouchable. Fits the one free space slot; nothing was displaced.
    ("fleet", "space", "Frigate", 1),
    // Same reasoning as LOADOUT: one armour-piercing hull that can answer a
    // land-based raider before the cheaper filler.
    // Closes SPACE. The Frigate above stands IN space, so a space target is a
    // same-ambit shot for it; this reaches space from an AIR slot.
    ("fleet", "air", "High Altitude Interceptor", 1),
    ("fleet", "space", "Battleship", 2),
    ("fleet", "water", "Cruiser", 1),
    // Same-ambit-only: blockers and bulk, never an answer. Last.
    ("fleet", "land", "Tank", 2),
    ("fleet", "space", "Starfighter", 1),
    // Workers hold the ore pile between sweeps; bunkers block the refinery and
    // add +50 shield each (a longer raid proof for the attacker).
    ("planet", "land", "Ore Bunker", 2),
];

/// Struct types limited to one per player (buildLimit 1) — a loadout entry for
/// one of these is skipped when the player already has it, instead of trying
/// (and having the chain reject) a duplicate.
pub(crate) const ONE_PER_PLAYER: &[&str] = &[
    "Ore Extractor",
    "Ore Refinery",
    "Command Ship",
    "Field Generator",
    "Planetary Defense Cannon",
    // buildLimit 1 on the chain type table (verified 2026-08-13); it was
    // missing here AND from game_state::is_limited_type.
    "Jamming Satellite",
];

/// The chain OVERLOADS one error string — `cannot handle new load requirements
/// (required: X, available: Y)` — for two gates, told apart by magnitude: tiny
/// equal integers = the per-player build-COUNT cap (we already own this
/// 1-per-player struct); large values = a real milliwatt power shortage. Returns
/// true only for the COUNT-cap variant, so the caller can treat the type as
/// already-present and advance instead of backing the whole player off. We
/// pre-gate power before initiating (see `available <= draw`), so a load error
/// reaching us is almost always the count cap — but we still check the numbers
/// so a power reject that slips through (e.g. when conn_cap is unknown) is NOT
/// mistaken for a count cap. See the `build_load_error_is_count_cap` notes.
fn is_count_cap_reject(err: &str) -> bool {
    if !err.contains("cannot handle new load requirements") {
        return false;
    }
    // The trailing "(required: X, available: Y)" are the last two integers in the
    // string (earlier digits are the message index and the player id). Count cap
    // when both are small; a power shortage reports milliwatt magnitudes.
    let nums: Vec<u64> = err
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse::<u64>().ok())
        .collect();
    match nums.as_slice() {
        [.., required, available] => *required < 1000 && *available < 1000,
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoBuildConfig {
    /// Master on/off. Off by default — it auto-signs build txs.
    pub enabled: bool,
    /// Complete a building struct once its build difficulty is ≤ this. Lower =
    /// more patient (waits for the proof to decay cheaper); default 4 lets one
    /// GPU complete builds for a much larger vplayer fleet.
    pub complete_difficulty: u64,
    /// Min seconds between scans. Charge regenerates ~1/block (~6s), so a build
    /// becomes affordable again ~48s after the last; 120s leaves comfortable margin.
    pub interval_secs: u64,
    /// Also fill the primary player's slots (default just the vplayers).
    pub include_primary: bool,
}

impl Default for AutoBuildConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            complete_difficulty: 4,
            interval_secs: 120,
            include_primary: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<AutoBuildConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Struct ids confirmed built — never re-read their entity again (steady-state
/// completion reads → ~0 once the fleet is built out).
static BUILT_CACHE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Thrash guard: player_id -> don't attempt another INITIATE before this ms
/// epoch. Set when the chain deterministically rejects a build (slot occupied,
/// load requirements, …) — state we mis-modeled won't change in 120s, so
/// retrying every scan just burns cycles and floods the ledger (the failure
/// mode structs_system caught live: 3.6k identical rejects/hour). The next
/// attempt after the backoff re-derives everything from fresh chain state.
static INITIATE_BACKOFF: LazyLock<Mutex<HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// ── Survives a restart ──────────────────────────────────────────────────────
// The set of structs confirmed built is what keeps steady-state completion
// reads at ~0; a restart used to re-read every one. The initiate backoffs
// come back too, so a deterministic rejection is not retried the instant the
// app relaunches.
const BUILD_CACHE: &str = "auto_build_memory";
static RESTORED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct BuildMemory {
    built: HashSet<String>,
    backoff: HashMap<String, f64>,
}

fn ensure_restored() {
    RESTORED.get_or_init(|| {
        let Some(m) = crate::mcp::cache_store::load::<BuildMemory>(BUILD_CACHE) else { return };
        if let Ok(mut b) = BUILT_CACHE.lock() {
            b.extend(m.built);
        }
        if let Ok(mut bo) = INITIATE_BACKOFF.lock() {
            for (k, v) in m.backoff {
                bo.entry(k).or_insert(v);
            }
        }
    });
}

fn persist_memory() {
    let m = BuildMemory {
        built: BUILT_CACHE.lock().map(|b| b.clone()).unwrap_or_default(),
        backoff: INITIATE_BACKOFF.lock().map(|b| b.clone()).unwrap_or_default(),
    };
    crate::mcp::cache_store::save_in_background(BUILD_CACHE, m);
}
/// How long a player sits out after a deterministic initiate rejection.
const INITIATE_BACKOFF_MS: f64 = 30.0 * 60_000.0;

fn load() -> AutoBuildConfig {
    crate::mcp::config_store::load_config(FILENAME)
}
pub fn get() -> AutoBuildConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}
pub fn set(cfg: AutoBuildConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

/// Run generation: bumped by every watchdog reset. A scan captures the value
/// at start; if it changed by the time the scan finishes, the scan was
/// invalidated (a newer scan may already own RUNNING) and its epilogue must
/// not clear the guard or report liveness — otherwise a slow-but-alive scan
/// that survives a reset would unlock a THIRD concurrent scan and corrupt the
/// watchdog's picture, exactly when the node is already struggling.
static RUN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Watchdog remediation: invalidate the wedged scan and clear the
/// single-flight guard so the next tick can scan again.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}

/// Rebuild a player's Command Ship the moment it is known dead — callable from
/// ANY loop, not just this one's roster walk.
///
/// The in-scan command-first gate above does the same thing, but it only runs
/// when the sweep REACHES the player: on 2026-08-20, 1-1040 lost its Command
/// Ship to a raid at 19:49 and sat instantly-raidable for 50+ minutes because
/// the walk was still in the 1-2xx range. A Command Ship death is an EVENT,
/// and the answer to an event cannot be "wait for the tour to come around".
/// auto_response calls this the moment it works an incident whose defender
/// has no living command struct.
///
/// Idempotent by the chain's own registration: an initiate registers in
/// `commandStruct` immediately (verified live on 1-396), so a fleet whose
/// commandStruct exists and is not destroyed — built OR mid-build — is left
/// alone. Insufficient charge just after a fight is expected: the reject is
/// ledgered and the next incident (or the roster walk) retries.
pub(crate) async fn ensure_command_ship(
    app: &tauri::AppHandle,
    client: &crate::mcp::cosmos_client::CosmosClient,
    pid: &str,
    index: u32,
) -> Option<String> {
    // A player's fleet shares its index (fleet 9-N belongs to player 1-N).
    let fleet = crate::mcp::types::FleetId::from_index(crate::mcp::types::PlayerId::parse(pid).ok()?.index());
    let fleet_id = fleet.to_string();
    let cmd = crate::mcp::verify::fleet_command_struct(client, &fleet).await.ok()?;
    if let Some(cmd) = cmd {
        let alive = crate::mcp::verify::struct_state(client, &cmd)
            .await
            .map(|s| !s.destroyed)
            .unwrap_or(true); // unreadable = assume alive; the walk re-checks
        if alive {
            return None;
        }
    }
    let type_id = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        gs.struct_types
            .values()
            .find(|t| t.name.eq_ignore_ascii_case("Command Ship"))?
            .id
    };
    // Prefer a genuinely free fleet slot; the initiate names one but does not
    // consume it (verified live on 1-280), so a full fleet still rebuilds.
    // Source-switched (mcp/verify.rs); a failed read just names slot 0.
    let (amb, slot) = crate::mcp::verify::first_free_slot(client, &fleet.object_id(), &["land", "water", "air", "space"])
        .await
        .ok()
        .flatten()
        .unwrap_or(("land".to_string(), 0));
    let amb = amb.as_str();
    let payload = serde_json::json!({
        "playerId": pid,
        "structTypeId": type_id,
        "operatingAmbit": ambit_to_enum(amb),
        "slot": slot,
    });
    match crate::mcp::tx_retry::sign_with_retry(
        app,
        index,
        "/structs.structs.MsgStructBuildInitiate",
        payload,
        &format!("cmd_rebuild:{pid}"),
    )
    .await
    {
        Ok(_) => {
            crate::mcp::telemetry::tlog_feed(
                app,
                "auto_build",
                crate::mcp::telemetry::Sev::Notice,
                format!("{pid}: Command Ship destroyed — rebuild initiated immediately ({amb} slot {slot})"),
            );
            Some(format!("rebuild initiated ({amb} slot {slot})"))
        }
        Err(e) => {
            crate::mcp::telemetry::tlog(
                "auto_build",
                crate::mcp::telemetry::Sev::Warn,
                format!("{pid}: immediate Command Ship rebuild failed ({e}) — the roster walk retries"),
            );
            None
        }
    }
}

fn ambit_to_enum(a: &str) -> i64 {
    match a {
        "water" => 1,
        "land" => 2,
        "air" => 3,
        "space" => 4,
        "local" => 5,
        _ => 0,
    }
}

use crate::mcp::loop_util::{parse_bool, parse_f64, read_u64_field};

/// Lowest free slot index in 0..SLOTS_PER_AMBIT not present in `occupied`.
fn first_free(occupied: &HashSet<u64>) -> Option<u64> {
    (0..SLOTS_PER_AMBIT as u64).find(|i| !occupied.contains(i))
}

/// One loadout entry that could be built right now.
/// Pre-sign chain check for a build initiate that was DECIDED from the
/// perception snapshot. One player read (charge + location ids) and, when
/// the build consumes a slot, one location read (is that slot still empty?).
/// Two reads per ACTION, replacing the one-per-struct-per-scan fan-out.
/// Anything but `Verified` means do not sign (logged as perception drift, or
/// a read failed — never sign blind). `NoCharge` / `ReadFailed` are about the
/// PLAYER, so the caller stops trying other loadout entries for this scan;
/// `SlotTaken` is about one entry, so the caller moves to the next. (Before
/// this distinction a player with no charge was re-read once per ripe entry —
/// five identical drift lines 20 ms apart in the log.) The Command Ship
/// passes `require_free_slot = false`: its initiate does not consume the slot
/// it names (verified live, 1-280).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InitiateCheck {
    Verified,
    NoCharge,
    SlotTaken,
    ReadFailed,
}

async fn initiate_verified_on_chain(
    client: &CosmosClient,
    pid: &str,
    target: &str,
    ambit: &str,
    slot: u64,
    require_free_slot: bool,
    current_block: u64,
) -> InitiateCheck {
    // Source-switched reads (mcp/verify.rs): Guild API by default, LCD on
    // failover or when `verify_source` says so.
    let Ok(pid_t) = crate::mcp::types::PlayerId::parse(pid) else {
        return InitiateCheck::ReadFailed;
    };
    let Ok(charge) = crate::mcp::verify::player_charge(client, &pid_t, crate::mcp::types::Block::new(current_block)).await else {
        return InitiateCheck::ReadFailed;
    };
    if !charge.covers(BUILD_CHARGE) {
        crate::mcp::telemetry::tlog(
            "auto_build",
            crate::mcp::telemetry::Sev::Notice,
            format!("perception drift: {pid} charge {charge} < {BUILD_CHARGE} on chain — initiate skipped"),
        );
        return InitiateCheck::NoCharge;
    }
    if !require_free_slot {
        return InitiateCheck::Verified;
    }
    let Some(kind) = crate::mcp::types::LocationKind::parse(target) else { return InitiateCheck::ReadFailed };
    let Ok(Some(loc)) = crate::mcp::verify::player_location(client, &pid_t, kind).await else { return InitiateCheck::ReadFailed };
    // LIVE, not snapshot: a slot the snapshot still shows free (its frame
    // lost) is a rejected initiate and a 30-minute back-off. 35 in one hour.
    let Ok(occupied) = crate::mcp::verify::slot_occupied_live(client, &loc, ambit, slot).await else {
        return InitiateCheck::ReadFailed;
    };
    if occupied {
        crate::mcp::telemetry::tlog(
            "auto_build",
            crate::mcp::telemetry::Sev::Notice,
            format!("perception drift: {pid} {target} {ambit} slot {slot} occupied on chain — initiate skipped"),
        );
        return InitiateCheck::SlotTaken;
    }
    InitiateCheck::Verified
}

#[derive(Debug, Clone, PartialEq)]
pub struct RipeEntry {
    /// Position in the loadout — lower is higher priority.
    pub idx: usize,
    pub target: String,
    pub ambit: String,
    pub type_name: String,
    pub slot: u64,
}

/// Every loadout entry that is buildable for this player right now, in loadout
/// order.
///
/// Extracted from the scan loop so PRODUCTION AND TESTS SHARE ONE WALK. The
/// tests previously drove a private reimplementation of this logic, which meant
/// that once selection became stochastic they would have kept passing while
/// asserting nothing true about the running system — the worst kind of test.
///
/// Pure: every input is passed in. `buildable` answers "is this type known to
/// the catalog and affordable on the current power budget", which is the only
/// part that needs `GAME_STATE`.
pub fn ripe_entries(
    loadout: &[crate::mcp::profile::LoadoutEntry],
    present: &HashSet<String>,
    have: &HashMap<(String, String, String), usize>,
    occ: &HashMap<(String, String), HashSet<u64>>,
    buildable: impl Fn(&str) -> bool,
) -> Vec<RipeEntry> {
    let empty = HashSet::new();
    let mut out = Vec::new();
    for (idx, e) in loadout.iter().enumerate() {
        if ONE_PER_PLAYER.contains(&e.type_name.as_str()) && present.contains(&e.type_name) {
            continue; // already have this 1-per-player struct
        }
        let have_n = have
            .get(&(e.target.clone(), e.ambit.clone(), e.type_name.clone()))
            .copied()
            .unwrap_or(0);
        if have_n >= e.want {
            continue; // this entry's share of the ambit is filled
        }
        let key = (e.target.clone(), e.ambit.clone());
        let occupied = occ.get(&key).unwrap_or(&empty);
        if occupied.len() >= SLOTS_PER_AMBIT {
            continue;
        }
        let Some(slot) = first_free(occupied) else { continue };
        if !buildable(&e.type_name) {
            continue; // unknown type, or would push the player offline
        }
        out.push(RipeEntry {
            idx,
            target: e.target.clone(),
            ambit: e.ambit.clone(),
            type_name: e.type_name.clone(),
            slot,
        });
    }
    out
}

/// Walk a loadout forward `n` builds on an EMPTY player, returning what gets
/// built in order.
///
/// Production code path shared with the editor's preview and with the tests, so
/// "what would this profile build?" is answered by the same walk that actually
/// builds. `buildable` decides whether a type is known/affordable — pass
/// `|_| true` to ask the pure ordering question.
pub fn simulate_builds(
    loadout: &[crate::mcp::profile::LoadoutEntry],
    n: usize,
    t: &crate::mcp::variance::Temperament,
    buildable: impl Fn(&str) -> bool,
) -> Vec<RipeEntry> {
    let mut built: Vec<RipeEntry> = Vec::new();
    let present: HashSet<String> = HashSet::new();
    let mut have: HashMap<(String, String, String), usize> = HashMap::new();
    let mut occ: HashMap<(String, String), HashSet<u64>> = HashMap::new();
    while built.len() < n {
        let ripe = ripe_entries(loadout, &present, &have, &occ, &buildable);
        if ripe.is_empty() {
            break;
        }
        let Some(k) = choose_entry(&ripe, t) else { break };
        let e = ripe[k].clone();
        *have
            .entry((e.target.clone(), e.ambit.clone(), e.type_name.clone()))
            .or_insert(0) += 1;
        occ.entry((e.target.clone(), e.ambit.clone()))
            .or_default()
            .insert(e.slot);
        built.push(e);
    }
    built
}

/// Which ripe entry to build, honouring this player's temperament.
///
/// Scored by negated loadout position, so the deterministic path
/// (`temperature 0`) picks the earliest entry — byte-for-byte the old
/// "first ripe wins" walk. Warmer temperaments wander down the list, which is
/// how a roster stops converging on one composition.
pub fn choose_entry(ripe: &[RipeEntry], t: &crate::mcp::variance::Temperament) -> Option<usize> {
    crate::mcp::variance::pick_now(ripe, |e| -(e.idx as f64), t)
}

pub async fn tick(app_handle: &tauri::AppHandle, force: bool) {
    let cfg = get();
    if !cfg.enabled {
        return;
    }
    let now = now_millis();
    if !force {
        let mut last = LAST_SCAN.lock().unwrap();
        if now - *last < (cfg.interval_secs as f64) * 1000.0 {
            return;
        }
        *last = now;
    } else if let Ok(mut last) = LAST_SCAN.lock() {
        *last = now;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = crate::mcp::telemetry::LoopRun::start("auto_build");
    ensure_restored();
    scan(app_handle, &cfg, &run).await;
    persist_memory();
    if RUN_GEN.load(Ordering::SeqCst) != gen {
        // Invalidated by a watchdog reset mid-scan: a newer scan owns the
        // guard now — record the row, touch nothing else.
        run.finish_stale(Some("invalidated by watchdog reset mid-scan".into()));
        return;
    }
    run.finish(Some(format!(
        "eff_conc={}",
        crate::mcp::loop_util::effective_max_concurrent()
    )));
    if run.errors.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        crate::mcp::loop_util::report_clean_scan();
    }
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(
    app_handle: &tauri::AppHandle,
    cfg: &AutoBuildConfig,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) {
    let registry = match app_handle.try_state::<Arc<TaskRegistry>>() {
        Some(r) => r.inner().clone(),
        None => return,
    };
    let current_block = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.current_block_height)
        .unwrap_or(0);
    if current_block == 0 {
        return;
    }
    let client = CosmosClient::new();

    // Guild substation per-connection capacity = each player's capacitySecondary.
    let conn_cap = {
        let gid = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone());
        match gid.filter(|s| !s.is_empty()) {
            Some(g) => crate::mcp::guild_power::resolve_guild_power(&client, &g)
                .await
                .map(|gp| gp.sub_connection_capacity)
                .unwrap_or(0.0),
            None => 0.0,
        }
    };

    // (player_id, vplayer index | None for primary, role | None for primary).
    let targets = crate::mcp::virtual_players::collect_targets(cfg.include_primary);

    // Fan out the per-player body with bounded concurrency so every player is
    // scanned in the same wave (≤ MAX_CONCURRENT_PLAYERS in flight) instead of
    // serially — the serial walk reached the tail cohort minutes late.
    let complete_difficulty = cfg.complete_difficulty;
    let app = app_handle.clone();
    // Scan-level counters → one summary feed entry instead of per-player spam.
    let completes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let initiates = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (completes_c, initiates_c) = (completes.clone(), initiates.clone());
    let run_c = run.clone();
    // Keep the shared perception snapshot current (no-op if fresh or already
    // refreshing); the scan below reads from it when fresh, the chain otherwise.
    // Structs announced since the last refresh get their one entity read here.
    crate::mcp::perception::maybe_refresh(&client);
    // Never fan out to the chain just because the launch refresh has not
    // landed yet (that was ~59k LCD requests per launch): wait for it.
    crate::mcp::loop_util::ensure_perception(&client, "auto_build", 120_000.0).await;
    crate::mcp::perception::resolve_pending(&client, 50).await;
    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::effective_max_concurrent(),
        move |(pid, idx_opt, role)| {
            let app = app.clone();
            let client = client.clone();
            let registry = registry.clone();
            let completes = completes_c.clone();
            let initiates = initiates_c.clone();
            let run = run_c.clone();
            async move {
                // Stand down while this player is answering a raid: charge is
                // one action per block and the response needs it. Deferral
                // only — the work happens on the next scan.
                if crate::mcp::combat_lists::is_held_for_combat(&pid) {
                    return;
                }
                run.players.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                // Resolve THIS player's structs from its planet + fleet slot arrays.
                // The guild struct-LIST endpoints are broken (ignore their filter,
                // return a global page) — using them made auto_build see no structs
                // on the player's own planet and OVER-BUILD duplicates, inflating
                // structsLoad toward a brownout. See loop_util::player_structs.
                //
                // SCAN reads: perception snapshot when fresh, chain otherwise
                // (mcp::perception). Every read before a sign is the chain.
                let (structs, scan_src) = crate::mcp::loop_util::scan_player_structs(&client, &pid).await;
                let scanned_from_snapshot = scan_src == crate::mcp::loop_util::ReadSource::Snapshot;
                if structs.is_empty() {
                    return;
                }

                // ── 1. Complete ripe building structs ──
                for s in &structs {
                    if parse_bool(s.get("is_destroyed")) {
                        continue;
                    }
                    let Some(sid) = s.get("id").and_then(|x| x.as_str()).map(String::from) else { continue };
                    if BUILT_CACHE.lock().unwrap().contains(&sid) {
                        continue;
                    }
                    if let Some(t) = registry.tasks.get(&sid) {
                        if matches!(t.snapshot().status.as_str(), "running" | "waiting" | "starting") {
                            continue;
                        }
                    }
                    let entity = match crate::mcp::loop_util::scan_entity(&client, "struct", &sid).await {
                        Ok((e, _)) => e,
                        Err(_) => continue,
                    };
                    let sa = entity.get("structAttributes");
                    if parse_bool(sa.and_then(|x| x.get("isBuilt"))) {
                        BUILT_CACHE.lock().unwrap().insert(sid);
                        continue;
                    }
                    let anchor = read_u64_field(sa, "blockStartBuild");
                    if anchor == 0 {
                        continue;
                    }
                    let type_id = s.get("type").map(|x| match x {
                        Value::Number(n) => n.to_string(),
                        Value::String(t) => t.clone(),
                        _ => String::new(),
                    });
                    let difficulty_target = type_id
                        .as_ref()
                        .and_then(|t| {
                            crate::game_state::GAME_STATE.read().ok().and_then(|g| g.struct_types.get(t).map(|st| st.build_difficulty))
                        })
                        .unwrap_or(0);
                    if difficulty_target == 0 {
                        continue;
                    }
                    let age = current_block.saturating_sub(anchor);
                    if calculate_difficulty(age, difficulty_target) > complete_difficulty {
                        continue;
                    }
                    // ── CHAIN RE-VERIFY before committing GPU work. ── The
                    // struct came from the perception snapshot; the build
                    // clock is the proof anchor, so read it from the chain
                    // once per ISSUED completion (not once per struct per scan).
                    let mut anchor = anchor;
                    if scanned_from_snapshot {
                        let Ok(sid_t) = crate::mcp::types::StructId::parse(&sid) else { continue };
                        let Ok(live) = crate::mcp::verify::struct_state(&client, &sid_t).await else { continue };
                        if live.built || live.destroyed {
                            BUILT_CACHE.lock().unwrap().insert(sid.clone());
                            continue;
                        }
                        let Ok(live_anchor) = crate::mcp::verify::build_anchor(&client, &sid_t).await else { continue };
                        let live_anchor = live_anchor.get();
                        if live_anchor != anchor {
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Notice,
                                format!("perception drift: {sid} build anchor {anchor} scanned vs {live_anchor} on chain"),
                            );
                            anchor = live_anchor;
                            if anchor == 0
                                || calculate_difficulty(current_block.saturating_sub(anchor), difficulty_target) > complete_difficulty
                            {
                                continue;
                            }
                        }
                    }
                    let params = TaskParams::for_ore(&sid, "BUILD", anchor, difficulty_target);
                    if crate::hasher::start_hash_task_core(params, app.clone(), &registry).is_ok() {
                        if let Some(idx) = idx_opt {
                            crate::hasher::register_vplayer_hash(sid.clone(), idx, "BUILD".to_string());
                        }
                        completes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        run.actions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        crate::mcp::telemetry::tlog(
                            "auto_build",
                            crate::mcp::telemetry::Sev::Info,
                            format!("complete {} (age {}, build-difficulty ≤ {})", sid, age, complete_difficulty),
                        );
                    }
                }

                // ── 2. Initiate one build in the next free slot (charge + power gated) ──
                // Thrash guard: sit out the backoff window after a deterministic
                // chain rejection instead of re-failing every scan.
                if INITIATE_BACKOFF
                    .lock()
                    .unwrap()
                    .get(&pid)
                    .is_some_and(|until| now_millis() < *until)
                {
                    return;
                }
                // Read the player's grid (charge from lastAction, structsLoad, personal cap).
                let player = match crate::mcp::loop_util::scan_entity(&client, "player", &pid).await {
                    Ok((p, _)) => p,
                    Err(_) => return,
                };
                let ga = player.get("gridAttributes");
                let last_action = read_u64_field(ga, "lastAction");
                let charge = current_block.saturating_sub(last_action);
                if charge < BUILD_CHARGE {
                    return; // not enough charge to build this scan
                }
                let structs_load = parse_f64(ga.and_then(|x| x.get("structsLoad")));
                let personal_cap = parse_f64(ga.and_then(|x| x.get("capacity")));
                let personal_load = parse_f64(ga.and_then(|x| x.get("load")));
                let total_cap = personal_cap + conn_cap;
                let available = total_cap - structs_load - personal_load;

                // Occupied slots per (location_type, ambit).
                let mut occ: HashMap<(String, String), HashSet<u64>> = HashMap::new();
                for s in &structs {
                    if parse_bool(s.get("is_destroyed")) {
                        continue;
                    }
                    let lt = s.get("location_type").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let amb = s.get("operating_ambit").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let slot = s.get("slot").and_then(|x| x.as_u64()).unwrap_or(0);
                    occ.entry((lt, amb)).or_default().insert(slot);
                }

                // The loadout comes from this player's PROFILE. Built-ins are
                // derived from the same const tables the three roles used, so a
                // player with no explicit profile builds exactly what it did
                // before; a player with one builds what its author specified.
                let profile = crate::mcp::profile::for_player(
                    crate::mcp::virtual_players::profile_of(&pid).as_deref(),
                    role,
                );
                let loadout: &[crate::mcp::profile::LoadoutEntry] = &profile.loadout;
                // Type names the player already has (to skip 1-per-player duplicates).
                // The guild list response can omit `type_name` (occ works off
                // `location_type`, but `type_name` came back absent → `present` was
                // empty → the loop kept trying to rebuild the 1-per-player Ore
                // Extractor, which the chain rejects with "cannot handle new load",
                // and never advanced to the refinery). So fall back to resolving the
                // numeric `type` id through the catalog, which is always present.
                // Resolve a struct's type NAME robustly: `type_name` is EMPTY or
                // ABSENT on some entities (notably the Command Ship, resolved via
                // `commandStruct`), so fall back to the numeric `type` id through
                // the catalog — which is always present. Used for both `present`
                // (1-per-player skip) and the command-built check below. A raw
                // `type_name` read made `cmd_built` never match "Command Ship",
                // so the gate `!cmd_built` returned for EVERY player → auto_build
                // built nothing fleet-wide (workers stranded on empty planets).
                let (present, cmd_built, have): (HashSet<String>, bool, HashMap<(String, String, String), usize>) = {
                    let gs = crate::game_state::GAME_STATE.read().unwrap();
                    let name_of = |s: &Value| -> Option<String> {
                        if let Some(n) = s.get("type_name").and_then(|x| x.as_str()) {
                            if !n.is_empty() {
                                return Some(n.to_string());
                            }
                        }
                        let tid = s.get("type").map(|t| match t {
                            Value::Number(n) => n.to_string(),
                            Value::String(s) => s.clone(),
                            _ => String::new(),
                        })?;
                        gs.struct_types.get(&tid).map(|st| st.name.clone())
                    };
                    let present: HashSet<String> = structs
                        .iter()
                        .filter(|s| !parse_bool(s.get("is_destroyed")))
                        .filter_map(name_of)
                        .collect();
                    let cmd_built = structs.iter().any(|s| {
                        !parse_bool(s.get("is_destroyed"))
                            && parse_bool(s.get("is_built"))
                            && name_of(s).as_deref() == Some("Command Ship")
                    });
                    // Per-(location, ambit, type) counts, so a loadout can hold
                    // a MIX per ambit (want-counts) instead of the first entry
                    // monopolising all four slots.
                    let mut have: HashMap<(String, String, String), usize> = HashMap::new();
                    for s in structs.iter().filter(|s| !parse_bool(s.get("is_destroyed"))) {
                        let Some(name) = name_of(s) else { continue };
                        let lt = s.get("location_type").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let amb = s.get("operating_ambit").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        *have.entry((lt, amb, name)).or_insert(0) += 1;
                    }
                    (present, cmd_built, have)
                };

                // ── Command-struct-first gate ──
                // Raids target the Command Ship (it's the raid gate), and a fleet
                // with no living command struct can build almost NOTHING: every
                // other fleet deploy rejects with "fleet (9-X) needs a command
                // struct before deploy" and planet builds require the Command Ship
                // online. So when it's been destroyed, rebuilding it is the only
                // useful (or even possible) initiate. Verified live on 1-396: a
                // command-less fleet CAN initiate a replacement (no catch-22) and
                // the new ship registers in `commandStruct` immediately.
                //
                // It also does not occupy a fleet slot — and, verified live on
                // 1-280, the initiate does not even require the slot it names to
                // be FREE. A Command Ship was built into land slot 0 while
                // `5-2421` sat in that slot; the land slots came back unchanged
                // and `commandStruct` was populated.
                //
                // That matters because this used to give up when every fleet slot
                // was occupied, and a player with no Command Ship is INSTANTLY
                // raidable — the loot clock arms the block a raider arrives, with
                // no `initiated` phase to buy time. Four accounts (1-273, 1-275,
                // 1-279, 1-280) were found stuck exactly there, re-logging the
                // same warning every three minutes while sitting wide open. So
                // prefer a genuinely free slot for tidiness, but never refuse to
                // rebuild for want of one.
                let cmd_alive = present.contains("Command Ship");
                if !cmd_alive {
                    let (type_id, draw) = {
                        let gs = crate::game_state::GAME_STATE.read().unwrap();
                        match gs.struct_types.values().find(|t| t.name.eq_ignore_ascii_case("Command Ship")) {
                            Some(t) => (t.id, t.passive_draw.unwrap_or(0.0)),
                            None => return,
                        }
                    };
                    if conn_cap > 0.0 && available <= draw {
                        return; // no headroom even for the CMD ship — wait for power
                    }
                    let (amb, slot) = ["land", "water", "air", "space"]
                        .iter()
                        .find_map(|amb| {
                            let key = ("fleet".to_string(), amb.to_string());
                            let used = occ.get(&key).cloned().unwrap_or_default();
                            if used.len() >= SLOTS_PER_AMBIT {
                                return None;
                            }
                            first_free(&used).map(|slot| (*amb, slot))
                        })
                        // Fleet full: name a valid slot anyway. The Command Ship
                        // does not consume it, and being command-less is far more
                        // dangerous than an untidy slot number.
                        .unwrap_or(("land", 0));
                    let Some(idx) = idx_opt else { return };
                    // Chain re-verify (charge only — the Command Ship needs no free slot).
                    if scanned_from_snapshot
                        && initiate_verified_on_chain(&client, &pid, "fleet", amb, slot, false, current_block).await
                            != InitiateCheck::Verified
                    {
                        return;
                    }
                    let payload = json!({
                        "playerId": pid,
                        "structTypeId": type_id,
                        "operatingAmbit": ambit_to_enum(amb),
                        "slot": slot,
                    });
                    let res = crate::mcp::tx_retry::sign_with_retry(
                        &app,
                        idx,
                        "/structs.structs.MsgStructBuildInitiate",
                        payload,
                        &format!("auto_build:{pid}"),
                    )
                    .await;
                    match res {
                        Ok(_) => {
                            initiates.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            run.actions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            // The player's composition just changed; drop the
                            // shared cache so strike planning sees the new hull.
                            crate::mcp::loop_util::invalidate_player_structs(&pid);
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Notice,
                                format!("rebuilding LOST Command Ship for {pid} (fleet {} slot {})", amb, slot),
                            );
                            crate::mcp::board_feed::push(
                                &app,
                                crate::mcp::board_feed::Severity::Notice,
                                "auto_build",
                                format!("{} lost its Command Ship — rebuild initiated (fleet {} slot {})", pid, amb, slot),
                            );
                        }
                        Err(e) if is_count_cap_reject(&e) => {
                            // We actually do have one (stale read) — benign; no backoff.
                        }
                        // A charge lost to a same-block race (a completion the hasher signed a
                        // moment earlier) is a DEFER like a skip, not a 30-minute back-off:
                        // the charge is back next block and nothing about the plan was wrong.
                        Err(e) if e.starts_with("skipped:") || e.contains("already discharged") => {
                            // Charge was spent by a sibling loop while this sat in
                            // the gate: nothing hit the chain, nothing to back off.
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Notice,
                                format!("initiate for {pid} deferred to the next scan: {e}"),
                            );
                            return; // the CMD ship is the only thing buildable this scan
                        }
                        Err(e) => {
                            run.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let until = now_millis() + INITIATE_BACKOFF_MS;
                            INITIATE_BACKOFF.lock().unwrap().insert(pid.clone(), until);
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Warn,
                                format!("Command Ship rebuild failed for {pid} (backing off): {e}"),
                            );
                        }
                    }
                    return; // the CMD ship is the only thing buildable this scan
                }
                if !cmd_built {
                    // Replacement CMD is still under construction — every other
                    // initiate would still be rejected, so wait; the completion
                    // pass above finishes it as its difficulty decays.
                    return;
                }

                // One charged action per player per BLOCK, and the other loops
                // sweep the same roster concurrently. Racing them is a certain
                // code-2022 reject — and here it costs more than the wasted
                // attempt, because a generic Err also arms INITIATE_BACKOFF and
                // sits the player out for minutes. Defer to the next scan.
                if crate::mcp::types::PlayerId::parse(&pid).map(|p| crate::mcp::loop_util::acted_this_block(&p)).unwrap_or(false) {
                    return;
                }

                // Resolve a loadout type name to (id, passive draw) from the
                // catalog. `<=` on the budget: the chain rejects equality too
                // ("cannot handle new load requirements (required: 1,
                // available: 1)" seen live).
                let resolve = |type_name: &str| -> Option<(u64, f64)> {
                    let gs = crate::game_state::GAME_STATE.read().unwrap();
                    let t = gs
                        .struct_types
                        .values()
                        .find(|t| t.name.eq_ignore_ascii_case(type_name))?;
                    let draw = t.passive_draw.unwrap_or(0.0);
                    if conn_cap > 0.0 && available <= draw {
                        return None; // would push offline
                    }
                    Some((t.id, draw))
                };

                // Everything buildable right now, then ONE pick weighted by this
                // player's temperament. At temperature 0 this is the old
                // "first ripe entry wins" walk exactly.
                let mut ripe = ripe_entries(loadout, &present, &have, &occ, |tn| resolve(tn).is_some());
                let temperament = crate::mcp::variance::for_role(role);
                while !ripe.is_empty() {
                    let Some(k) = choose_entry(&ripe, &temperament) else { break };
                    let entry = ripe.remove(k);
                    let (target, ambit, type_name, slot) =
                        (entry.target, entry.ambit, entry.type_name, entry.slot);
                    let Some((type_id, _draw)) = resolve(&type_name) else { continue };
                    let payload = json!({
                        "playerId": pid,
                        "structTypeId": type_id,
                        "operatingAmbit": ambit_to_enum(&ambit),
                        "slot": slot,
                    });
                    // Only vplayers route through the façade signer; primary needs its own
                    // path (not wired here), so skip primary initiates for now.
                    let Some(idx) = idx_opt else { break };
                    // Chain re-verify: charge, and that the chosen slot is
                    // still empty on the live planet/fleet row. A drift here
                    // means the snapshot missed a build or a move; try the
                    // next ripe entry rather than sign into an occupied slot.
                    if scanned_from_snapshot {
                        match initiate_verified_on_chain(&client, &pid, &target, &ambit, slot, true, current_block).await {
                            InitiateCheck::Verified => {}
                            // This entry's slot is gone; another may still be free.
                            InitiateCheck::SlotTaken => continue,
                            // The PLAYER cannot initiate this scan — stop, don't re-read per entry.
                            InitiateCheck::NoCharge | InitiateCheck::ReadFailed => break,
                        }
                    }
                    let res = crate::mcp::tx_retry::sign_with_retry(
                        &app,
                        idx,
                        "/structs.structs.MsgStructBuildInitiate",
                        payload,
                        &format!("auto_build:{pid}"),
                    )
                    .await;
                    match res {
                        Ok(_) => {
                            initiates.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            run.actions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            // Composition changed — drop the shared struct cache
                            // so strike planning picks the new hull up next scan.
                            crate::mcp::loop_util::invalidate_player_structs(&pid);
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Info,
                                format!("{} {} {} slot {} (player {})", target, ambit, type_name, slot, pid),
                            );
                            break; // one successful initiate per player per scan (charge resets to 0)
                        }
                        // The chain rejected a 1-per-player struct we actually already
                        // own — our `present` set missed it (a stale/cold struct read).
                        // Don't back the whole player off (that stranded freshly-explored
                        // workers retrying an extractor they already have); treat the type
                        // as present and advance to the next loadout item THIS scan. A
                        // count-cap reject doesn't consume charge, so this is free.
                        Err(e) if is_count_cap_reject(&e) => {
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Debug,
                                format!("{pid} already has {type_name} (count cap) — advancing to next type"),
                            );
                            continue; // try the next loadout item, no backoff/break
                        }
                        Err(e) if e.starts_with("skipped:") || e.contains("already discharged") => {
                            // Charge was spent by a sibling loop while this sat in
                            // the gate: nothing hit the chain, nothing to back off.
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Notice,
                                format!("initiate for {pid} deferred to the next scan: {e}"),
                            );
                            break;
                        }
                        Err(e) => {
                            run.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let until = now_millis() + INITIATE_BACKOFF_MS;
                            INITIATE_BACKOFF.lock().unwrap().insert(pid.clone(), until);
                            crate::mcp::telemetry::tlog(
                                "auto_build",
                                crate::mcp::telemetry::Sev::Warn,
                                format!(
                                    "initiate failed for {pid} (backing off {} min): {e}",
                                    (INITIATE_BACKOFF_MS / 60_000.0) as u64
                                ),
                            );
                            break; // real failure — stop this player for this scan
                        }
                    }
                }
            }
        },
    )
    .await;
    let (nc, ni) = (
        completes.load(std::sync::atomic::Ordering::Relaxed),
        initiates.load(std::sync::atomic::Ordering::Relaxed),
    );
    if nc + ni > 0 {
        crate::mcp::board_feed::push(
            app_handle,
            crate::mcp::board_feed::Severity::Info,
            "auto_build",
            format!("{} build completion(s) started, {} build(s) initiated", nc, ni),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reach masks for every fleet hull, each confirmed from a live `scout`
    /// on 2026-08-18 (chain values Water=2 Land=4 Air=8 Space=16). Test-only:
    /// production reads these from the synced type catalog.
    /// (type, ambit it STANDS in, ambits its weapons REACH, counter-immune)
    const HULLS: &[(&str, u64, u64, bool)] = &[
        ("Pursuit Fighter", 8, 8, false),
        ("Battleship", 16, 2 | 4, false),
        ("Tank", 4, 4, false),
        ("Cruiser", 2, 2 | 4, false),
        ("Mobile Artillery", 4, 2 | 4, true),
        ("SAM Launcher", 4, 8 | 16, false),
        ("High Altitude Interceptor", 8, 8 | 16, false),
        ("Stealth Bomber", 8, 2 | 4, false),
        ("Destroyer", 2, 2 | 8, false),
        ("Submersible", 2, 2 | 16, false),
        ("Starfighter", 16, 16, false),
        ("Frigate", 16, 8 | 16, false),
        ("Command Ship", 4, 0, false),
    ];

    /// Ambits still lacking a VIABLE shot after walking `loadout`'s fleet
    /// entries in order and building the first `n` hulls. Viable = counter-
    /// immune, or cross-ambit (counters halve); a same-ambit-only shot is
    /// refused by auto_response's suicidal gate, so it does not count.
    /// Ambits still lacking a VIABLE shot after `n` builds, driving the REAL
    /// selection (`ripe_entries` + `choose_entry`) rather than a private copy
    /// of the walk.
    ///
    /// This used to be a test-local reimplementation that consumed the loadout
    /// in strict array order. Once selection became stochastic that would have
    /// kept passing while asserting nothing true about the running system, so
    /// it now shares production's code path and takes a `Temperament` — pass
    /// the default for the deterministic ordering claim, or a warm one to make
    /// a distributional claim.
    /// Ambits still lacking a VIABLE shot after `n` builds, driving the REAL
    /// walk via `simulate_builds` — production and tests share one path, so a
    /// change to selection can never leave these assertions silently vacuous.
    fn blind_after_with(
        loadout: &[(&'static str, &'static str, &'static str, usize)],
        n: usize,
        t: &crate::mcp::variance::Temperament,
    ) -> Vec<&'static str> {
        let loadout: Vec<crate::mcp::profile::LoadoutEntry> = loadout
            .iter()
            .map(crate::mcp::profile::LoadoutEntry::from_tuple)
            .collect();
        let built: Vec<(u64, u64, bool)> = simulate_builds(&loadout, n, t, |tn| {
            HULLS.iter().any(|(hn, ..)| *hn == tn)
        })
        .iter()
        .filter(|e| e.target == "fleet")
        .filter_map(|e| {
            HULLS
                .iter()
                .find(|(hn, ..)| *hn == e.type_name.as_str())
                .map(|h| (h.1, h.2, h.3))
        })
        .collect();

        [("water", 2u64), ("land", 4), ("air", 8), ("space", 16)]
            .into_iter()
            .filter(|(_, bit)| {
                !built.iter().any(|(stands, reach, immune)| {
                    reach & bit != 0 && (*immune || *stands != *bit)
                })
            })
            .map(|(n, _)| n)
            .collect()
    }

    /// The deterministic walk: what `temperature 0` builds, in order.
    fn blind_after(
        loadout: &[(&'static str, &'static str, &'static str, usize)],
        n: usize,
    ) -> Vec<&'static str> {
        blind_after_with(loadout, n, &crate::mcp::variance::Temperament::default())
    }

    /// A Command Ship can occupy ANY of the four ambits, so a fully-built fleet
    /// must be able to answer all four. Regression guard for 2026-08-17, when
    /// scout1 held fire for three minutes against a land Command Ship.
    #[test]
    fn every_loadout_answers_all_four_ambits_when_fully_built() {
        for (name, l) in [
            ("LOADOUT", LOADOUT),
            ("RAIDER_LOADOUT", RAIDER_LOADOUT),
            ("PRODUCTIVE_LOADOUT", PRODUCTIVE_LOADOUT),
        ] {
            assert!(
                blind_after(l, usize::MAX).is_empty(),
                "{name} leaves {:?} with no viable shot when fully built",
                blind_after(l, usize::MAX)
            );
        }
    }

    /// Slots free ONE AT A TIME through combat attrition, so the ORDER decides
    /// what a rebuilding fleet gets. Coverage must come from the first handful
    /// of builds, not the last. The old order was still blind in air+space
    /// after eight.
    #[test]
    fn coverage_is_bought_early_not_late() {
        assert!(
            blind_after(LOADOUT, 2).is_empty(),
            "LOADOUT must answer all four ambits within 2 builds (Mobile Artillery + SAM Launcher), still blind in {:?}",
            blind_after(LOADOUT, 2)
        );
        for (name, l, budget) in [
            ("RAIDER_LOADOUT", RAIDER_LOADOUT, 5),
            ("PRODUCTIVE_LOADOUT", PRODUCTIVE_LOADOUT, 4),
        ] {
            assert!(
                blind_after(l, budget).is_empty(),
                "{name} still blind in {:?} after {budget} builds",
                blind_after(l, budget)
            );
        }
    }

    /// The POINT of variance: two rebuilds must not produce the same fleet.
    ///
    /// A fixed order is why 1,876 of 2,238 players ended up with no viable shot
    /// into water — every fleet walked the same list and converged on the same
    /// composition. Sampling is the fix, so assert the diversity directly.
    #[test]
    fn a_warm_temperament_produces_different_fleets() {
        let warm = crate::mcp::variance::Temperament {
            temperature: 0.8,
            ..Default::default()
        };
        let mut shapes = std::collections::HashSet::new();
        for _ in 0..40 {
            shapes.insert(blind_after_with(LOADOUT, 4, &warm));
        }
        assert!(
            shapes.len() > 1,
            "warm temperament still produced one fixed composition — no diversification"
        );
    }

    /// ...but variance must not throw the coverage win away. The reordered
    /// loadout front-loads Mobile Artillery + SAM Launcher; at the shipped
    /// raider temperature most rebuilds should still reach all four ambits
    /// quickly, even though individual ones wander.
    #[test]
    fn coverage_still_arrives_quickly_at_the_shipped_temperature() {
        let mut cfg = crate::mcp::variance::VarianceConfig::default();
        cfg.apply_preset(crate::mcp::variance::VariancePreset::Human);
        let t = cfg.raider;
        let trials = 200;
        let covered = (0..trials)
            .filter(|_| blind_after_with(LOADOUT, 6, &t).is_empty())
            .count();
        assert!(
            covered * 2 > trials,
            "only {covered}/{trials} rebuilds covered all four ambits within 6 builds — \
             variance is costing more than it buys"
        );
    }

    /// Temperature 0 must reproduce the old deterministic walk exactly, which
    /// is what lets every ordering assertion in this file keep meaning something.
    #[test]
    fn temperature_zero_reproduces_the_fixed_order() {
        let zero = crate::mcp::variance::Temperament::default();
        for _ in 0..20 {
            assert!(blind_after_with(LOADOUT, 2, &zero).is_empty());
        }
    }

    /// The reorder must not change WHAT a fleet ends up as — same hulls, same
    /// counts, only priority. Guards against a reorder quietly dropping a type.
    #[test]
    fn reorder_did_not_change_per_ambit_slot_totals() {
        let mut per: std::collections::BTreeMap<&str, usize> = Default::default();
        for (target, ambit, _, want) in LOADOUT {
            if *target == "fleet" {
                *per.entry(ambit).or_insert(0) += want;
            }
        }
        assert_eq!(per.get("land"), Some(&4));
        assert_eq!(per.get("water"), Some(&4));
        assert_eq!(per.get("air"), Some(&4));
        assert_eq!(per.get("space"), Some(&4));
    }

    #[test]
    fn default_off_and_loadout_shape() {
        let c = AutoBuildConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.complete_difficulty, 4);
        assert_eq!(LOADOUT[0].2, "Ore Extractor"); // miner first (rebuilt after explore)
        assert_eq!(LOADOUT.last().unwrap().2, "Ore Bunker"); // heavy last
        // The only armour-piercing hull we field must be in the defensive
        // loadout, and ahead of the Starfighter that shares its slot — a
        // raider's Command Ship is armoured and nothing else we build pierces.
        let space: Vec<&str> = LOADOUT.iter()
            .filter(|(t, a, _, _)| *t == "fleet" && *a == "space").map(|(_, _, n, _)| *n).collect();
        assert_eq!(space.first(), Some(&"Battleship"), "Battleship must lead the fleet space slot");
        assert!(space.contains(&"Starfighter"));
        // Only unguided weapon reaching AIR, and Pursuit Fighters evade guided
        // 2-in-3 — without it we cannot answer the hull we ourselves field.
        assert!(
            LOADOUT.iter().any(|(_, _, n, _)| *n == "Cruiser"),
            "need an unguided air answer to signalJamming"
        );
        // Raiders lead with the counter-immune hull, then the armour-piercing
        // one — counter damage, not HP, is what kills a besieging fleet.
        let raider_fleet: Vec<&str> = RAIDER_LOADOUT
            .iter()
            .filter(|(loc, _, _, _)| *loc == "fleet")
            .map(|(_, _, n, _)| *n)
            .collect();
        assert_eq!(raider_fleet.first(), Some(&"Command Ship"), "grounded without one");
        assert_eq!(
            raider_fleet.get(1),
            Some(&"Mobile Artillery"),
            "the counter-immune siege hull must lead the offensive set"
        );
        assert!(
            raider_fleet.iter().position(|n| *n == "Mobile Artillery")
                < raider_fleet.iter().position(|n| *n == "Tank"),
            "Mobile Artillery grinds for free; a Tank pays a counter every shot"
        );
        assert!(
            raider_fleet.contains(&"Tank"),
            "the raider CMD needs a same-ambit armoured blocker — the only defense counter-immunity cannot bypass"
        );
        assert!(PRODUCTIVE_LOADOUT.iter().any(|(_, _, n, _)| *n == "Battleship"));
        assert_eq!(PRODUCTIVE_LOADOUT[0].2, "Ore Extractor");
        assert_eq!(PRODUCTIVE_LOADOUT[1].2, "Ore Refinery");
    }

    /// The rock-paper-scissors point: every fleet hull class has to actually be
    /// buildable. The old walk let the first entry per (location, ambit) key
    /// monopolise all four slots, so Submersible/Starfighter/raider-Tank were
    /// dead letters. Want-counts make the mix explicit — verify the mix fits.
    #[test]
    fn loadouts_fit_slots_and_field_the_full_roster() {
        for (label, lo) in [
            ("LOADOUT", LOADOUT),
            ("RAIDER_LOADOUT", RAIDER_LOADOUT),
            ("PRODUCTIVE_LOADOUT", PRODUCTIVE_LOADOUT),
        ] {
            let mut per_key: HashMap<(&str, &str), usize> = HashMap::new();
            for (loc, amb, name, want) in lo {
                assert!(*want >= 1, "{label}: zero-want entry {name}");
                // The Command Ship does not consume a fleet slot.
                if *name != "Command Ship" {
                    *per_key.entry((*loc, *amb)).or_insert(0) += want;
                }
                // No duplicate entries for the same (key, type): counts are totals.
                assert_eq!(
                    lo.iter().filter(|(l, a, n, _)| l == loc && a == amb && n == name).count(),
                    1,
                    "{label}: duplicate entry for {loc}/{amb}/{name}"
                );
            }
            for ((loc, amb), total) in &per_key {
                assert!(
                    *total <= SLOTS_PER_AMBIT,
                    "{label}: {loc}/{amb} wants {total} > {SLOTS_PER_AMBIT} slots"
                );
            }
        }
        // The default (bait) loadout must field ALL 13 fleet hull types — the
        // strongest player on the shard does, and each answers a class the
        // others cannot (1-61's fleet, measured 2026-08-13).
        let fleet_types: HashSet<&str> = LOADOUT
            .iter()
            .filter(|(l, _, _, _)| *l == "fleet")
            .map(|(_, _, n, _)| *n)
            .collect();
        for hull in [
            "Battleship", "Starfighter", "Frigate", "Pursuit Fighter", "Stealth Bomber",
            "High Altitude Interceptor", "Mobile Artillery", "Tank", "SAM Launcher",
            "Cruiser", "Destroyer", "Submersible",
        ] {
            assert!(fleet_types.contains(hull), "LOADOUT missing fleet hull {hull}");
        }
        // Jamming Satellite is buildLimit 1 — the walk must know that or it
        // will retry forever after the first one builds.
        assert!(ONE_PER_PLAYER.contains(&"Jamming Satellite"));
    }

    #[test]
    fn count_cap_reject_detection() {
        // Tiny equal integers = build-count cap → true (advance, don't back off).
        assert!(is_count_cap_reject(
            "failed to execute message; message index: 0: player (1-403) cannot handle new load requirements (required: 1, available: 1)"
        ));
        // Large milliwatt values = real power shortage → false (back off).
        assert!(!is_count_cap_reject(
            "player (1-403) cannot handle new load requirements (required: 500000, available: 300000)"
        ));
        // Unrelated errors → false.
        assert!(!is_count_cap_reject("account sequence mismatch"));
        assert!(!is_count_cap_reject("insufficient charge"));
    }

    #[test]
    fn first_free_slot() {
        let mut occ = HashSet::new();
        assert_eq!(first_free(&occ), Some(0));
        occ.insert(0);
        occ.insert(1);
        assert_eq!(first_free(&occ), Some(2));
        occ.insert(2);
        occ.insert(3);
        assert_eq!(first_free(&occ), None); // full
    }
}
