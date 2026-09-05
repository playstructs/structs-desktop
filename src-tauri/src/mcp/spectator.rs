//! Spectator service — the data spine behind [`crate::mcp::raid_view`].
//!
//! One task per watched location, shared by every window looking at it. Eight
//! windows on one planet means one poller, not eight; the last window closing
//! stops it.
//!
//! # Three sources, three jobs
//!
//! | source | carries | latency |
//! |---|---|---|
//! | entity reads (LCD + Guild API) | the full snapshot: structs, slots, ambits, health, shield | on demand |
//! | GRASS stream | `struct_health`, `struct_status`, `shield_change`, `raid_status`, fleet moves | instant |
//! | `planet_activity` poll | shot-by-shot `struct_attack` detail | seconds |
//!
//! The split is forced, not chosen. GRASS **stubs `struct_attack` payloads over
//! ~8 KB** — which is exactly the multi-shot fights worth animating — so the
//! only place the per-shot narrative exists is the polled activity feed. The
//! result is that state moves before the choreography describing it arrives:
//! health snaps live, then the animation queue plays a sequence toward values
//! it carries internally. That is why every shot event ships its own
//! `health_before`/`health_after` rather than letting the renderer read current
//! state mid-sequence.
//!
//! # Read-only, by construction
//!
//! Nothing here submits a transaction, and the windows it feeds cannot sign.
//! Watching someone else's planet is exactly as observable to them as any other
//! chain read: none of this is privileged, it is public data the game's own
//! client already streams to every player.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::mcp::raid_view::Target;
// ── Snapshot ────────────────────────────────────────────────────────────────
//
// Placement comes from the chain's own slot arrays, not from inference.
// `Planet` and `Fleet` entities each carry `space[]`, `air[]`, `land[]` and
// `water[]` — the ARRAY INDEX IS THE SLOT and the value is the struct id (empty
// string for a vacant slot). Four slots per ambit, which is exactly what the
// map's two columns × two rows per ambit provide.
//
// This is why the Guild API's struct list is not used here: it reports a slot
// number without saying which slot-space it belongs to, so a planetary struct
// in slot 0 and a fleet struct in slot 0 are indistinguishable. The arrays make
// that structural.
//
// One read per struct then supplies health and status
// (`structAttributes.{health,isDestroyed,isHidden}`). Type name and max
// health are NOT on the raw LCD entity — they only look like they are through
// structs_intel, which enriches from GAME_STATE.struct_types. `build_struct`
// resolves them from that same in-memory catalogue (synced by the game
// window), with the entity fields as fallback.

/// The four ambits, top to bottom, exactly as the map stacks them.
pub const AMBIT_KEYS: &[&str] = &["space", "air", "land", "water"];

/// Guild API and LCD numerics arrive as JSON strings as often as numbers.
fn num_u64(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .or_else(|| v.as_f64().map(|f| f as u64))
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn flag(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true") || s == "t",
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) != 0,
        _ => false,
    }
}

/// Chain type name → asset slug: `"High Altitude Interceptor"` →
/// `"high_altitude_interceptor"`, which is exactly how `frontend/lottie/` names
/// its per-type bundles.
pub fn type_slug(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// Top-to-bottom map order.
pub fn ambit_rank(ambit: &str) -> u8 {
    match ambit.to_ascii_lowercase().as_str() {
        "space" => 0,
        "air" => 1,
        "land" => 2,
        "water" => 3,
        _ => 4,
    }
}

/// Where a struct sits, decided before any struct entity is read.
#[derive(Debug, Clone)]
struct Placement {
    struct_id: String,
    ambit: String,
    slot: i64,
    /// "planet" for a planetary slot, "fleet" for a struct aboard a fleet.
    category: String,
    /// Fleet owner for a fleet struct; the planet's owner for a planetary one.
    owner_hint: String,
    /// The fleet's designated Command Ship. Named by `Fleet.commandStruct`
    /// rather than guessed from the type, because it is the struct whose loss
    /// ends a raid and it gets its own column on the map.
    is_command: bool,
}

/// Read `{space,air,land,water}` off a Planet or Fleet body into placements.
fn placements_from(body: &Value, category: &str, owner: &str, command: Option<&str>) -> Vec<Placement> {
    let mut out = vec![];
    for ambit in AMBIT_KEYS {
        let Some(arr) = body.get(*ambit).and_then(|v| v.as_array()) else {
            continue;
        };
        for (slot, cell) in arr.iter().enumerate() {
            let Some(id) = cell.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue; // an empty string is a vacant slot, not an error
            };
            out.push(Placement {
                struct_id: id.to_string(),
                ambit: (*ambit).to_string(),
                slot: slot as i64,
                category: category.to_string(),
                owner_hint: owner.to_string(),
                is_command: command == Some(id),
            });
        }
    }
    out
}

/// Placements for one fleet: its four ambit arrays PLUS its Command Ship.
///
/// The Command Ship is NOT in the ambit arrays — the game gives it a column
/// of its own, one slot per ambit, always slot 0, and places it by its
/// operating ambit (which `build_struct` reads off the struct entity; the
/// empty ambit here is deliberately just a fallback). Verified live: fleet
/// 9-61's `commandStruct` 5-14098 appears in none of its arrays, which is
/// exactly why command ships were invisible on the first build.
fn fleet_placements(fbody: &Value) -> Vec<Placement> {
    let owner = str_of(fbody.get("owner")).unwrap_or_default();
    let command = str_of(fbody.get("commandStruct"));
    let mut out = placements_from(fbody, "fleet", &owner, command.as_deref());
    if let Some(cmd) = command {
        if !out.iter().any(|p| p.struct_id == cmd) {
            out.push(Placement {
                struct_id: cmd,
                ambit: String::new(),
                slot: 0,
                category: "fleet".into(),
                owner_hint: owner,
                is_command: true,
            });
        }
    }
    out
}

/// One struct as the renderer needs it. Everything here maps to something
/// drawn: `ambit` + `slot` + `category` place it on the grid, `type_slug` picks
/// its art and animation bundles, `health`/`max_health` drive the damaged
/// variant and the HUD bar.
#[derive(Debug, Clone, Serialize)]
pub struct SpectatorStruct {
    pub id: String,
    pub type_id: u64,
    pub type_name: String,
    /// Asset slug — `command_ship`, `ore_extractor`. See [`type_slug`].
    pub type_slug: String,
    /// "planet" | "fleet" — which slot-space, and so which map column block.
    pub category: String,
    pub owner: String,
    pub ambit: String,
    pub slot: i64,
    pub health: Option<u64>,
    pub max_health: u64,
    pub destroyed: bool,
    /// `structAttributes.isOnline` — an offline struct shows the no-power
    /// badge, and its idle loop must not play (the game freezes it).
    pub online: bool,
    /// `structAttributes.isBuilt` — an unbuilt struct renders as the
    /// deployment-indicator gif, not as its hull.
    pub built: bool,
    /// Stealth is chain-visible (`structAttributes.isHidden`); the game renders
    /// a hidden struct at half opacity rather than removing it.
    pub hidden: bool,
    /// Guarding another struct — `structAttributes.protectedStructIndex` is
    /// set. Mirrors the game's `Struct.isDefending()`; drives the `defending`
    /// status icon on the tile.
    pub defending: bool,
    /// Guarded BY another struct: some other struct on this planet points its
    /// `protectedStructIndex` here. The game's `Struct.isDefended()` reads the
    /// inverse relation the same way.
    pub defended: bool,
    /// Id of the struct this one guards, if any (`5-<index>`).
    ///
    /// Sent to the renderer because indicator visibility is FOCUS-DEPENDENT
    /// (Structs Design System, "Unit Tile → Status Indicators"): with a struct
    /// selected, the Defended icon shows only on the unit the selection
    /// guards, and the Defender icon only on the unit guarding the selection.
    /// Both need the relation, not just the two booleans.
    pub protects: Option<String>,
    /// Raw protected index — the relation before it is resolved to an id.
    #[serde(skip)]
    pub protected_index: u64,
    /// The fleet's Command Ship, per `Fleet.commandStruct`.
    pub is_command: bool,
    /// "defender" (belongs to the planet's owner) or "attacker".
    pub side: String,
}

/// One struct type as the Action Bar and its Cheatsheets need it.
///
/// TWO SOURCES, and the difference matters. The chain's LCD `struct_type`
/// entity carries the *mechanics* — which weapon, how much damage, what
/// charge. The **Guild API's** `/struct/type` record additionally carries the
/// human-written *copy*: "Ballistic Weapon", "Fires unguided ordnance…", the
/// cosmetic model number. That endpoint requires a logged-in session, which
/// only the game window has, so the copy reaches us through
/// `GAME_STATE.struct_types` (synced by the window) and the mechanics through
/// a direct read. [`load_struct_types`] merges them, preferring the copy where
/// it exists and degrading to the enum names where it does not.
#[derive(Debug, Clone, Serialize, Default)]
pub struct SpectatorStructType {
    /// Header text of the Action Chunk, e.g. "TANK".
    pub class_abbreviation: String,
    /// Full class name — the Cheatsheet title is "<model number> <class>".
    pub class_name: String,
    pub default_cosmetic_model_number: String,
    /// "fleet" | "planet" — the game offers Defend only on fleet structs.
    pub category: String,
    /// Equipment slots, chain vocabulary (`guidedWeaponry`, `counterAttack`,
    /// `noUnitDefenses`, …). Mapped to icons by `STRUCT_EQUIPMENT_ICON_MAP`.
    pub primary_weapon: String,
    pub primary_weapon_control: String,
    pub secondary_weapon: String,
    pub secondary_weapon_control: String,
    pub passive_weaponry: String,
    pub unit_defenses: String,
    pub ore_reserve_defenses: String,
    pub planetary_defenses: String,
    pub planetary_mining: String,
    pub planetary_refinery: String,
    pub power_generation: String,
    pub stealth_systems: bool,
    pub movable: bool,

    // ── Cheatsheet mechanics ──
    pub build_charge: u64,
    pub build_draw: u64,
    pub generating_rate: u64,
    pub planetary_shield_contribution: u64,
    pub counter_attack: u64,
    pub counter_attack_same_ambit: u64,
    /// Ambit bitmasks — Water=2, Land=4, Air=8, Space=16. The renderer expands
    /// them into the ambit icon rows the Cheatsheet shows as "range".
    pub possible_ambit: u64,
    pub primary_weapon_ambits: u64,
    pub secondary_weapon_ambits: u64,
    pub primary_weapon_damage: u64,
    pub primary_weapon_shots: u64,
    pub primary_weapon_charge: u64,
    pub primary_weapon_armour_piercing: bool,
    pub secondary_weapon_damage: u64,
    pub secondary_weapon_shots: u64,
    pub secondary_weapon_charge: u64,
    pub secondary_weapon_armour_piercing: bool,
    pub move_charge: u64,
    pub defend_change_charge: u64,
    pub stealth_activate_charge: u64,

    // ── Cheatsheet copy (Guild API only; empty when the window has not
    // synced, which the renderer treats as "fall back to the enum name") ──
    pub primary_weapon_label: String,
    pub primary_weapon_description: String,
    pub secondary_weapon_label: String,
    pub secondary_weapon_description: String,
    pub passive_weaponry_label: String,
    pub passive_weaponry_description: String,
    pub unit_defenses_label: String,
    pub unit_defenses_description: String,
    pub ore_reserve_defenses_label: String,
    pub ore_reserve_defenses_description: String,
    pub planetary_defenses_label: String,
    pub planetary_defenses_description: String,
    pub drive_label: String,
    pub drive_description: String,
}

/// Struct types never change once the chain is up, so one read per type per app
/// run is enough. Shared across every spectator window.
static STRUCT_TYPE_CACHE: std::sync::LazyLock<
    std::sync::RwLock<HashMap<String, SpectatorStructType>>,
> = std::sync::LazyLock::new(|| std::sync::RwLock::new(HashMap::new()));

fn parse_struct_type(v: &Value) -> SpectatorStructType {
    // The LCD wraps the record; a raw body is accepted too so a future shape
    // change degrades to blank fields rather than a panic.
    let b = v.get("StructType").unwrap_or(v);
    let s = |k: &str| str_of(b.get(k)).unwrap_or_default();
    let n = |k: &str| b.get(k).and_then(num_u64).unwrap_or(0);
    SpectatorStructType {
        class_abbreviation: {
            let abbr = s("classAbbreviation");
            if abbr.is_empty() { s("type") } else { abbr }
        },
        class_name: {
            let c = s("class");
            if c.is_empty() { s("type") } else { c }
        },
        default_cosmetic_model_number: s("defaultCosmeticModelNumber"),
        category: s("category"),
        primary_weapon: s("primaryWeapon"),
        primary_weapon_control: s("primaryWeaponControl"),
        secondary_weapon: s("secondaryWeapon"),
        secondary_weapon_control: s("secondaryWeaponControl"),
        passive_weaponry: s("passiveWeaponry"),
        unit_defenses: s("unitDefenses"),
        ore_reserve_defenses: s("oreReserveDefenses"),
        planetary_defenses: s("planetaryDefenses"),
        planetary_mining: s("planetaryMining"),
        planetary_refinery: s("planetaryRefinery"),
        power_generation: s("powerGeneration"),
        stealth_systems: flag(b.get("stealthSystems")),
        movable: flag(b.get("movable")),

        build_charge: n("buildCharge"),
        // UNITS. The chain stores power in MILLIWATTS (`buildDraw: 500000` is
        // 500 W — structs.ai energy.md, and `structs.struct_type` in production
        // keeps both: `build_draw_p` = 500000 raw, `build_draw` = 500 via
        // `unit_legacy_format(…, 'milliwatt')`). The Guild API serves the
        // divided one, which is what the game's own HUD prints. Normalise to
        // WATTS here so the readout can never be a factor of 1000 out.
        build_draw: n("buildDraw") / 1000,
        // NOT the same convention: `generatingRate` is already kW per gram of
        // Alpha (the chain's `_p` value; production's display column is the one
        // that multiplies by 1000, to W/g). Taken verbatim — dividing it here
        // would be the same mistake in the other direction.
        generating_rate: n("generatingRate"),
        planetary_shield_contribution: n("planetaryShieldContribution"),
        counter_attack: n("counterAttack"),
        counter_attack_same_ambit: n("counterAttackSameAmbit"),
        possible_ambit: n("possibleAmbit"),
        primary_weapon_ambits: n("primaryWeaponAmbits"),
        secondary_weapon_ambits: n("secondaryWeaponAmbits"),
        primary_weapon_damage: n("primaryWeaponDamage"),
        primary_weapon_shots: n("primaryWeaponShots"),
        primary_weapon_charge: n("primaryWeaponCharge"),
        primary_weapon_armour_piercing: flag(b.get("primaryWeaponArmourPiercing")),
        secondary_weapon_damage: n("secondaryWeaponDamage"),
        secondary_weapon_shots: n("secondaryWeaponShots"),
        secondary_weapon_charge: n("secondaryWeaponCharge"),
        secondary_weapon_armour_piercing: flag(b.get("secondaryWeaponArmourPiercing")),
        move_charge: n("moveCharge"),
        defend_change_charge: n("defendChangeCharge"),
        stealth_activate_charge: n("stealthActivateCharge"),

        // The LCD has no copy at all; `merge_synced_copy` fills these in.
        ..Default::default()
    }
}

/// Overlay the Guild-API copy the game window synced onto an LCD-derived
/// record. Only non-empty values win, so a partial sync can never blank a
/// field the LCD already answered.
fn merge_synced_copy(t: &mut SpectatorStructType, type_id: u64) {
    let gs = crate::game_state::GAME_STATE.read().unwrap();
    let Some(st) = gs.struct_types.get(&type_id.to_string()) else {
        return;
    };
    fn put(dst: &mut String, src: &Option<String>) {
        if let Some(v) = src {
            if !v.is_empty() {
                *dst = v.clone();
            }
        }
    }
    put(&mut t.class_abbreviation, &st.class_abbreviation);
    put(&mut t.class_name, &st.class_name);
    put(
        &mut t.default_cosmetic_model_number,
        &st.default_cosmetic_model_number,
    );
    put(&mut t.primary_weapon_label, &st.primary_weapon_label);
    put(
        &mut t.primary_weapon_description,
        &st.primary_weapon_description,
    );
    put(&mut t.secondary_weapon_label, &st.secondary_weapon_label);
    put(
        &mut t.secondary_weapon_description,
        &st.secondary_weapon_description,
    );
    put(&mut t.passive_weaponry_label, &st.passive_weaponry_label);
    put(
        &mut t.passive_weaponry_description,
        &st.passive_weaponry_description,
    );
    put(&mut t.unit_defenses_label, &st.unit_defenses_label);
    put(
        &mut t.unit_defenses_description,
        &st.unit_defenses_description,
    );
    put(
        &mut t.ore_reserve_defenses_label,
        &st.ore_reserve_defenses_label,
    );
    put(
        &mut t.ore_reserve_defenses_description,
        &st.ore_reserve_defenses_description,
    );
    put(
        &mut t.planetary_defenses_label,
        &st.planetary_defenses_label,
    );
    put(
        &mut t.planetary_defenses_description,
        &st.planetary_defenses_description,
    );
    put(&mut t.drive_label, &st.drive_label);
    put(&mut t.drive_description, &st.drive_description);
    // Deliberately NOT merged: `build_draw` and `generating_rate`.
    //
    // The two sources disagree on units for both — the Guild API serves
    // `build_draw` already divided to watts and `generating_rate` MULTIPLIED to
    // watts-per-gram, while the chain serves milliwatts and kW-per-gram. Taking
    // whichever arrived first would make the readout depend on sync timing.
    // `parse_struct_type` normalises both from the chain, which is always
    // available, and that is the only place either is set.
}

/// Resolve every type id in `ids`, reading only the ones not already cached.
/// A read failure drops that one type: the Action Bar falls back to a bare
/// header rather than the whole snapshot failing.
///
/// The CACHE holds the LCD half only. The Guild-API copy is merged fresh on
/// every call because the game window syncs it asynchronously — cache it and a
/// spectator opened before the first sync would show enum names forever, with
/// nothing to invalidate it.
async fn load_struct_types(
    client: &crate::mcp::cosmos_client::CosmosClient,
    ids: &[u64],
) -> HashMap<String, SpectatorStructType> {
    let mut out = HashMap::new();
    let mut missing = Vec::new();
    {
        let cache = STRUCT_TYPE_CACHE.read().unwrap();
        for id in ids {
            let key = id.to_string();
            match cache.get(&key) {
                Some(t) => {
                    out.insert(key, t.clone());
                }
                None => missing.push(key),
            }
        }
    }
    for key in missing {
        if let Ok(v) = client.entity("struct_type", &key).await {
            let t = parse_struct_type(&v);
            STRUCT_TYPE_CACHE
                .write()
                .unwrap()
                .insert(key.clone(), t.clone());
            out.insert(key, t);
        }
    }
    for (key, t) in out.iter_mut() {
        if let Ok(id) = key.parse::<u64>() {
            merge_synced_copy(t, id);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub planet_id: String,
    pub owner: Option<String>,
    pub planetary_shield: u64,
    /// 0 means the planet is not currently raidable.
    pub block_start_raid: u64,
    pub raid_status: Option<String>,
    pub raiding_fleet: Option<String>,
    /// Every fleet parked at this planet, in list order.
    pub fleets: Vec<String>,
    /// Planetary slots per ambit (`spaceSlots` etc. off the Planet body). The
    /// renderer needs the COUNT, not just the occupants: an unoccupied slot
    /// under the count shows a build beacon, a cell past it shows blocked art.
    pub slots: HashMap<String, u64>,
    pub structs: Vec<SpectatorStruct>,
    /// Capability record per struct type present, keyed by type id as a string.
    /// Drives the Action Chunk's properties screen and ability buttons.
    pub struct_types: HashMap<String, SpectatorStructType>,
    // ── HUD fields ──
    // The game's HUD shows whose planet this is, their charge and energy, and
    // the ore at stake. The spectator HUD mirrors it, so the snapshot has to
    // carry the same facts. All optional: a read failure must degrade the HUD
    // to dashes, never fail the whole snapshot.
    /// Stealable ore held by the planet's owner.
    pub stored_ore: Option<f64>,
    /// Owner's charge (blocks since their last action) — drives the battery.
    pub owner_charge: Option<f64>,
    /// "8M/8M"-style capacity readout, pre-formatted the way the game shows it.
    pub owner_energy: Option<String>,
    pub owner_name: Option<String>,
    pub owner_pfp: Option<String>,
    /// The raiding fleet's owner, for the enemy-side action bar.
    pub raider_id: Option<String>,
    pub raider_name: Option<String>,
    pub raider_charge: Option<f64>,
    pub raider_pfp: Option<String>,
    /// The VIEWER's own charge — the player this app is signed in as, who is
    /// usually neither combatant. Read from `GAME_STATE`, which derives it the
    /// way the game itself does (`ChargeCalculator.calcCharge`), so the rail's
    /// battery agrees with the player's own HUD in the main window. Rides the
    /// snapshot rather than a command of its own because the raid window
    /// already polls this live, and charge accrues per block.
    pub viewer_charge: Option<f64>,
    pub fetched_at_ms: f64,
    /// Populated when a read failed, so the window can say "stale" rather than
    /// silently showing a half-built map.
    pub warning: Option<String>,
}

/// How many fleets to follow off a planet before giving up. The linked list is
/// chain data; a cycle would otherwise hang the poller.
const MAX_FLEETS_AT_PLANET: usize = 16;

/// Build the full picture of a planet: its own structs, plus every struct
/// aboard every fleet parked there.
pub async fn snapshot_planet(
    client: &crate::mcp::cosmos_client::CosmosClient,
    planet_id: &str,
) -> Snapshot {
    let mut warning = None;

    let planet = match client.entity("planet", planet_id).await {
        Ok(v) => v,
        Err(e) => {
            return Snapshot {
                planet_id: planet_id.to_string(),
                owner: None,
                planetary_shield: 0,
                block_start_raid: 0,
                raid_status: None,
                raiding_fleet: None,
                fleets: vec![],
                slots: HashMap::new(),
                structs: vec![],
                struct_types: HashMap::new(),
                stored_ore: None,
                owner_charge: None,
                viewer_charge: None,
                owner_energy: None,
                owner_name: None,
                owner_pfp: None,
                raider_id: None,
                raider_name: None,
                raider_charge: None,
                raider_pfp: None,
                fetched_at_ms: crate::hasher::types::now_millis(),
                warning: Some(format!("planet unavailable: {e}")),
            }
        }
    };
    let body = planet.get("Planet").unwrap_or(&planet);
    let owner = str_of(body.get("owner"));
    let attrs = planet.get("planetAttributes");
    let planetary_shield = attrs
        .and_then(|a| a.get("planetaryShield"))
        .and_then(num_u64)
        .unwrap_or(0);
    let block_start_raid = attrs
        .and_then(|a| a.get("blockStartRaid"))
        .and_then(num_u64)
        .unwrap_or(0);

    // Planetary capacity per ambit — `"spaceSlots": "4"` etc., strings again.
    let mut slots: HashMap<String, u64> = HashMap::new();
    for ambit in AMBIT_KEYS {
        let n = body
            .get(format!("{ambit}Slots"))
            .and_then(num_u64)
            .unwrap_or_else(|| {
                body.get(*ambit)
                    .and_then(|v| v.as_array())
                    .map(|a| a.len() as u64)
                    .unwrap_or(0)
            });
        slots.insert((*ambit).to_string(), n);
    }

    let mut placements = placements_from(
        body,
        "planet",
        owner.as_deref().unwrap_or_default(),
        None,
    );

    // The DEFENDER's fleet first. A planet's `locationList` holds only
    // VISITING fleets — the owner's own fleet, even onStation at this exact
    // planet, is not in it (verified live: 2-2124 is 1-274's active planet,
    // fleet 9-274 sits there onStation, and the list is empty). Without this
    // read, a defended raid renders with the defender's entire fleet — command
    // ship included — missing. `Player.fleetId` names it.
    let mut fleets: Vec<String> = vec![];
    if let Some(owner_id) = owner.as_deref() {
        let owner_fleet = match client.entity("player", owner_id).await {
            Ok(v) => str_of(v.get("Player").unwrap_or(&v).get("fleetId")),
            Err(_) => None,
        };
        if let Some(fid) = owner_fleet {
            if let Ok(fleet) = client.entity("fleet", &fid).await {
                let fbody = fleet.get("Fleet").unwrap_or(&fleet);
                // Only when it is actually HERE — the owner may be off raiding
                // someone else, and a fleet that left must not be drawn.
                if str_of(fbody.get("locationId")).as_deref() == Some(planet_id) {
                    placements.extend(fleet_placements(fbody));
                    fleets.push(fid);
                }
            }
        }
    }

    // Then every VISITING fleet. The linked list's naming is from the CHAIN's
    // perspective and inverts intuition — verified live with two fleets at
    // 2-1590: START's `locationListBackward` points at the next fleet, and
    // `locationListForward` points from the LAST back toward the start. So
    // start→forward (the obvious reading) enumerates exactly one fleet and
    // silently drops every later arrival. Walk BOTH directions, deduped, so
    // either reading of the naming still enumerates the whole list.
    for (head, link) in [
        ("locationListStart", "locationListBackward"),
        ("locationListLast", "locationListForward"),
    ] {
        let mut next = str_of(body.get(head));
        while let Some(fleet_id) = next.take() {
            if fleets.len() >= MAX_FLEETS_AT_PLANET {
                break;
            }
            if fleets.contains(&fleet_id) {
                break; // reached fleets the other walk already covered
            }
            let Ok(fleet) = client.entity("fleet", &fleet_id).await else {
                warning = Some(format!("fleet {fleet_id} unavailable"));
                break;
            };
            let fbody = fleet.get("Fleet").unwrap_or(&fleet);
            // The pointers DANGLE: when the last visitor leaves, the chain
            // clears `locationListStart` but leaves `locationListLast` naming
            // the departed fleet (verified live on 2-2124 — start "", last
            // "9-275", 9-275 onStation at its own home). A fleet the list
            // names is only real if the fleet itself agrees it is here;
            // otherwise it would render as a ghost army.
            if str_of(fbody.get("locationId")).as_deref() != Some(planet_id) {
                break;
            }
            placements.extend(fleet_placements(fbody));
            fleets.push(fleet_id);
            next = str_of(fbody.get(link));
        }
    }

    // One read per struct supplies type, health and status together.
    let client2 = client.clone();
    let planet_owner = owner.clone();
    let mut structs = crate::mcp::loop_util::map_concurrent(placements, 8, move |p| {
        let client = client2.clone();
        let planet_owner = planet_owner.clone();
        async move { build_struct(&client, planet_owner.as_deref(), p).await }
    })
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    // `defended` is a RELATION: a struct is defended when some OTHER struct
    // points its protected index at it, so it can only be resolved once every
    // struct on the board is known.
    mark_defended(&mut structs);

    // Stable order so a refresh never reshuffles the DOM.
    structs.sort_by(|a, b| {
        ambit_rank(&a.ambit)
            .cmp(&ambit_rank(&b.ambit))
            .then(a.category.cmp(&b.category))
            .then(a.slot.cmp(&b.slot))
            .then(a.id.cmp(&b.id))
    });

    // HUD facts for the planet's owner. One extra read, concurrent with
    // nothing else here because it needs `owner` which the planet read gave us.
    let owner_hud = read_owner_hud(client, owner.as_deref()).await;

    // Capability records for the types actually on the board — cached across
    // snapshots, so this is usually free.
    let mut type_ids = structs.iter().map(|s| s.type_id).collect::<Vec<_>>();
    type_ids.sort_unstable();
    type_ids.dedup();
    let struct_types = load_struct_types(client, &type_ids).await;

    Snapshot {
        planet_id: planet_id.to_string(),
        owner,
        planetary_shield,
        block_start_raid,
        raid_status: None,
        raiding_fleet: None,
        fleets,
        slots,
        structs,
        struct_types,
        stored_ore: owner_hud.0,
        owner_charge: owner_hud.1,
        viewer_charge: crate::game_state::GAME_STATE
            .read()
            .ok()
            .map(|g| g.get_charge() as f64),
        owner_energy: owner_hud.2,
        owner_name: owner_hud.3,
        owner_pfp: owner_hud.4,
        raider_id: None,
        raider_name: None,
        raider_charge: None,
        raider_pfp: None,
        fetched_at_ms: crate::hasher::types::now_millis(),
        warning,
    }
}

/// Every `locationId` that means "present at this planet": the planet itself,
/// plus each fleet docked there (the owner's own, which the chain's visitor
/// list omits, and every visitor).
///
/// Combat in Structs is CO-LOCATED — a struct can only fire at something at
/// the same planet. `plan_strike` had no such filter, so it offered every
/// reachable struct the team owns across 1,800 planets and the chain rejected
/// each shot with "target struct is unreachable". This is the set that makes
/// that filter possible, sharing the spectator's fleet walk rather than
/// growing a second, drifting copy of it.
pub async fn locations_at_planet(
    client: &crate::mcp::cosmos_client::CosmosClient,
    planet_id: &str,
) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    out.insert(planet_id.to_string());
    let Ok(planet) = client.entity("planet", planet_id).await else { return out };
    let body = planet.get("Planet").unwrap_or(&planet);

    // The owner's own fleet is never in the visitor list even when on station.
    if let Some(owner_id) = str_of(body.get("owner")) {
        if let Ok(v) = client.entity("player", &owner_id).await {
            if let Some(fid) = str_of(v.get("Player").unwrap_or(&v).get("fleetId")) {
                if let Ok(fleet) = client.entity("fleet", &fid).await {
                    let fbody = fleet.get("Fleet").unwrap_or(&fleet);
                    if str_of(fbody.get("locationId")).as_deref() == Some(planet_id) {
                        out.insert(fid);
                    }
                }
            }
        }
    }

    // Visitors. Same both-directions walk, and the same dangling-pointer guard,
    // as the spectator board.
    for (head, link) in [
        ("locationListStart", "locationListBackward"),
        ("locationListLast", "locationListForward"),
    ] {
        let mut next = str_of(body.get(head));
        while let Some(fleet_id) = next.take() {
            if out.len() > MAX_FLEETS_AT_PLANET + 1 || out.contains(&fleet_id) {
                break;
            }
            let Ok(fleet) = client.entity("fleet", &fleet_id).await else { break };
            let fbody = fleet.get("Fleet").unwrap_or(&fleet);
            if str_of(fbody.get("locationId")).as_deref() != Some(planet_id) {
                break;
            }
            out.insert(fleet_id);
            next = str_of(fbody.get(link));
        }
    }
    out
}

/// Resolve `defended` across a board: any struct named by another struct's
/// `protectedStructIndex` is defended. Struct ids are `5-<index>`, so the
/// index is matched against the id's suffix rather than assuming a position.
fn mark_defended(structs: &mut [SpectatorStruct]) {
    let guarded: std::collections::HashSet<u64> = structs
        .iter()
        .map(|s| s.protected_index)
        .filter(|i| *i != 0)
        .collect();
    if guarded.is_empty() {
        return;
    }
    for s in structs.iter_mut() {
        if let Ok(sid) = crate::mcp::types::StructId::parse(&s.id) {
            s.defended = guarded.contains(&sid.index());
        }
    }
}

#[cfg(test)]
mod defence_tests {
    use super::*;

    fn s(id: &str, protects: u64) -> SpectatorStruct {
        SpectatorStruct {
            id: id.into(), type_id: 1, type_name: "Tank".into(), type_slug: "tank".into(),
            category: "planet".into(), owner: "1-1".into(), ambit: "land".into(), slot: 0,
            health: Some(3), max_health: 3, destroyed: false, online: true, built: true,
            hidden: false, defending: protects != 0, defended: false,
            protects: (protects != 0).then(|| crate::mcp::types::StructId::from_index(protects).to_string()),
            protected_index: protects, is_command: false, side: "defender".into(),
        }
    }

    #[test]
    fn defended_is_the_inverse_of_defending() {
        // 5-2 guards 5-1; nobody guards 5-2.
        let mut board = vec![s("5-1", 0), s("5-2", 1), s("5-3", 0)];
        mark_defended(&mut board);
        assert!(board[0].defended, "5-1 is guarded by 5-2");
        assert!(!board[1].defended, "nobody guards the guard");
        assert!(!board[2].defended);
        assert!(board[1].defending, "5-2 is defending");
        assert!(!board[0].defending);
    }

    #[test]
    fn no_defenders_leaves_everything_undefended() {
        let mut board = vec![s("5-1", 0), s("5-2", 0)];
        mark_defended(&mut board);
        assert!(board.iter().all(|x| !x.defended));
    }
}

/// The planet owner's HUD facts: stored ore, charge, an "8M/8M" energy
/// readout, display name and pfp URL.
///
/// Returned as a tuple of options because EVERY one of them is decoration: a
/// failed read must dim one HUD chip, never cost the caller its map. The
/// energy string is formatted here rather than in JS so the window and the
/// game's own HUD phrase it the same way.
type OwnerHud = (Option<f64>, Option<f64>, Option<String>, Option<String>, Option<String>);

/// A name for one of OUR players when the chain carries none: the primary from
/// the synced game state, virtual players from the registry.
fn local_player_name(pid: &str) -> Option<String> {
    if let Ok(gs) = crate::game_state::GAME_STATE.read() {
        if gs.player_id.as_deref() == Some(pid) {
            if let Some(n) = gs.player_name.clone().filter(|s| !s.is_empty()) {
                return Some(n);
            }
        }
    }
    let reg = crate::mcp::virtual_players::REGISTRY.read().ok()?;
    reg.players
        .iter()
        .find(|p| p.player_id.as_deref() == Some(pid))
        .map(|p| p.name.clone())
        .filter(|n| !n.is_empty())
}

async fn read_owner_hud(
    client: &crate::mcp::cosmos_client::CosmosClient,
    owner: Option<&str>,
) -> OwnerHud {
    let Some(pid) = owner else {
        return (None, None, None, None, None);
    };
    let Ok(p) = client.entity("player", pid).await else {
        return (None, None, None, None, None);
    };
    let ga = p.get("gridAttributes");
    let f = |k: &str| ga.and_then(|g| g.get(k)).and_then(|v| {
        v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    });
    let ore = f("ore");
    // Charge is derived, not stored: it is the block count since the player's
    // last action, which is exactly how the game computes it.
    let charge = f("lastAction").map(|last| {
        let now = crate::game_state::GAME_STATE
            .read()
            .map(|g| g.current_block_height)
            .unwrap_or(0) as f64;
        (now - last).max(0.0)
    });
    // The game's OWN energy readout (EnergyUsageComponent.getEnergyUsage):
    //   load  = load + structsLoad
    //   total = capacity + connectionCapacity
    //   text  = "<load>/<total>"
    // It is USAGE over total, not headroom, and it counts the structs' draw
    // and the share coming back from the substation. Getting either half
    // wrong makes the number quietly disagree with the same player's own HUD —
    // a vplayer with capacity 0 drawing 5.59 MW through its substation
    // rendered as a meaningless "0/0" before this.
    let total_load = f("load").unwrap_or(0.0) + f("structsLoad").unwrap_or(0.0);
    // The substation share is NOT on the player. `connectionCapacity` is a
    // SUBSTATION attribute (production's `structs.grid` has 14 of them, all
    // `object_type = substation`, and not one on a player), so reading it off
    // the player always yielded 0 — which is why a worker drawing 2.5 kW
    // through the guild substation rendered as "2k/0", claiming it was over
    // capacity when it has 7.7 kW available.
    //
    // The player side of that link is documented as `capacitySecondary`, but
    // THIS LCD does not expose it — a live read of 1-1005 returns a
    // gridAttributes block with `connectionCapacity: "0"` and no
    // `capacitySecondary` key at all. It is still preferred when present (a
    // future LCD may carry it); in practice the substation read below is what
    // answers, every time.
    let secondary = match f("capacitySecondary") {
        Some(v) if v > 0.0 => v,
        _ => substation_share(client, p.get("Player").unwrap_or(&p)).await,
    };
    let total_capacity = f("capacity").unwrap_or(0.0) + secondary;
    // UNITS: `gridAttributes` are raw chain integers, i.e. MILLIWATTS — a
    // defender showing `structsLoad: 2500000` is drawing 2.5 kW, not 2.5 MW.
    // The shipped webapp formats them undivided, so its HUD reads a factor of
    // 1000 high; this window deliberately does not follow it there. Same
    // correction as the Action Bar Cheatsheets, so the two never disagree
    // about what a watt is.
    let energy = Some(format!(
        "{}/{}",
        fmt_watts(total_load / 1000.0),
        fmt_watts(total_capacity / 1000.0)
    ));
    let body = p.get("Player").unwrap_or(&p);
    // The LCD player entity spells the display name `name`; `username` is the
    // INDEXER/webapp-API alias for the same value and is never present here, so
    // reading it always missed and every player showed as a bare "1-272". Keep
    // the local fallback for a player whose name we know but whose read failed.
    let name = str_of(body.get("name"))
        .or_else(|| str_of(body.get("username")))
        .or_else(|| local_player_name(pid));
    // The pfp is LAYERED, not a URL: `pfpClientRenderAttributes` is a JSON
    // string of part indices that the renderer stacks as images, the same way
    // the game's PfpViewerComponent and the Team Ops roster do.
    let pfp = str_of(body.get("pfpClientRenderAttributes"))
        .or_else(|| str_of(body.get("pfp_client_render_attributes")));
    (ore, charge, energy, name, pfp)
}

/// The capacity a player receives from the substation they are connected to.
///
/// Zero when they are connected to nothing, or when the substation cannot be
/// read — a HUD that under-reports capacity is wrong, but a HUD that fails to
/// render because one extra entity read hiccuped is worse.
async fn substation_share(
    client: &crate::mcp::cosmos_client::CosmosClient,
    player_body: &Value,
) -> f64 {
    let Some(sub_id) = str_of(player_body.get("substationId"))
        .or_else(|| str_of(player_body.get("substation_id")))
        .filter(|s| !s.is_empty())
    else {
        return 0.0;
    };
    if let Some(v) = cached_substation_share(&sub_id) {
        return v;
    }
    let Ok(sub) = client.entity("substation", &sub_id).await else {
        return 0.0;
    };
    let share = connection_capacity_of(&sub);
    SUBSTATION_CACHE
        .lock()
        .unwrap()
        .insert(sub_id, (share, crate::hasher::types::now_millis()));
    share
}

/// Substation share, memoised briefly.
///
/// Because the LCD carries no `capacitySecondary`, the read above fires on
/// EVERY snapshot — once per watched location per [`SNAPSHOT_INTERVAL_MS`].
/// Worse, it is usually the SAME substation: a whole roster shares one (all
/// 1,283 connections on 4-1 here), so eight open windows meant eight identical
/// requests every 20 seconds. The value only moves when someone connects,
/// disconnects, or re-allocates, so a short TTL costs nothing in accuracy.
const SUBSTATION_TTL_MS: f64 = 60_000.0;

static SUBSTATION_CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (f64, f64)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn cached_substation_share(sub_id: &str) -> Option<f64> {
    let now = crate::hasher::types::now_millis();
    let cache = SUBSTATION_CACHE.lock().unwrap();
    cache
        .get(sub_id)
        .filter(|(_, at)| now - at < SUBSTATION_TTL_MS)
        .map(|(v, _)| *v)
}

/// A substation's per-connection share, in milliwatts.
///
/// Deliberately does NOT divide by `connectionCount`: the chain has already
/// done that when it wrote the value ("the stored `connectionCapacity` is
/// already the per-player share — do not divide by `connectionCount` again",
/// structs.ai energy.md). Production's substation 4-1 stores capacity
/// 9,962,700,000 across 1,283 connections and a `connectionCapacity` of
/// 7,765,159 — dividing again would report 6 kW as 4.7 W.
fn connection_capacity_of(substation: &Value) -> f64 {
    substation
        .get("gridAttributes")
        .and_then(|g| g.get("connectionCapacity"))
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
        .unwrap_or(0.0)
}

/// Watts → the game's compact HUD form.
///
/// Port of `util/NumberFormatter.format`: keep the leading 1-3 digits and
/// append a scale letter, TRUNCATING rather than rounding — 5,590,000 is
/// "5M" in the game, not "6M". Copied so the spectator's numbers are
/// character-for-character the ones a player sees.
fn fmt_watts(w: f64) -> String {
    let n = w.max(0.0).trunc() as i64;
    let s = n.to_string();
    let digits = s.len();
    if digits <= 3 {
        return s;
    }
    const SCALE: [&str; 10] = ["k", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"];
    let remainder = match digits % 3 {
        0 => 3,
        r => r,
    };
    let scale_index = (digits - remainder) / 3;
    let unit = SCALE.get(scale_index - 1).copied().unwrap_or("");
    format!("{}{}", &s[..remainder], unit)
}

#[cfg(test)]
mod struct_type_tests {
    use super::parse_struct_type;
    use serde_json::json;

    /// The live Starfighter record, transcribed field-for-field from the LCD.
    /// If the chain ever renames one of these the Action Bar goes blank, so the
    /// spelling is worth pinning.
    fn starfighter() -> serde_json::Value {
        json!({"StructType": {
            "id": "3",
            "type": "Starfighter",
            "class": "Starfighter",
            "classAbbreviation": "Starfighter",
            "category": "fleet",
            "buildCharge": "8",
            "buildDraw": "100000",
            "primaryWeapon": "guidedWeaponry",
            "primaryWeaponControl": "guided",
            "secondaryWeapon": "attackRun",
            "secondaryWeaponControl": "unguided",
            "passiveWeaponry": "counterAttack",
            "unitDefenses": "noUnitDefenses",
            "oreReserveDefenses": "noOreReserveDefenses",
            "planetaryDefenses": "noPlanetaryDefense",
            "planetaryMining": "noPlanetaryMining",
            "planetaryRefinery": "noPlanetaryRefinery",
            "powerGeneration": "noPowerGeneration",
            "stealthSystems": false,
            "movable": false
        }})
    }

    #[test]
    fn reads_every_field_the_action_bar_draws() {
        let t = parse_struct_type(&starfighter());
        assert_eq!(t.class_abbreviation, "Starfighter");
        assert_eq!(t.category, "fleet");
        assert_eq!(t.primary_weapon, "guidedWeaponry");
        assert_eq!(t.primary_weapon_control, "guided");
        assert_eq!(t.secondary_weapon, "attackRun");
        assert_eq!(t.secondary_weapon_control, "unguided");
        assert_eq!(t.passive_weaponry, "counterAttack");
        assert_eq!(t.unit_defenses, "noUnitDefenses");
        assert!(!t.stealth_systems);
        assert!(!t.movable);
    }

    /// The bug this pins: the chain serves power in MILLIWATTS but the game
    /// prints watts, so reading `buildDraw` straight through showed a
    /// Battleship costing "135k" when it costs 135 W. Verified against
    /// production `structs.struct_type`, which stores both
    /// (`build_draw_p` 135000 / `build_draw` 135).
    #[test]
    fn build_draw_is_normalised_from_milliwatts_to_watts() {
        let t = parse_struct_type(&starfighter());
        assert_eq!(t.build_draw, 100, "100000 mW is 100 W, not 100k anything");

        let cpp = json!({"StructType": {"buildDraw": "10000000"}});
        assert_eq!(parse_struct_type(&cpp).build_draw, 10_000);
    }

    /// …and the same field name in the OTHER direction: `generatingRate` is
    /// already kW per gram on the chain (Field Generator = 2, matching the
    /// documented "2 kW/g"). Production's display column is the one that
    /// multiplies by 1000, so dividing here would be the mirror-image bug.
    #[test]
    fn generating_rate_is_taken_verbatim() {
        let gen = json!({"StructType": {"generatingRate": "2", "buildDraw": "500000"}});
        let t = parse_struct_type(&gen);
        assert_eq!(t.generating_rate, 2);
        assert_eq!(t.build_draw, 500);
    }

    #[test]
    fn accepts_an_unwrapped_body() {
        let wrapped = starfighter();
        let bare = wrapped.get("StructType").unwrap().clone();
        assert_eq!(
            parse_struct_type(&bare).class_abbreviation,
            parse_struct_type(&wrapped).class_abbreviation
        );
    }

    #[test]
    fn falls_back_to_type_when_the_abbreviation_is_absent() {
        let v = json!({"StructType": {"type": "Ore Extractor", "category": "planet"}});
        assert_eq!(parse_struct_type(&v).class_abbreviation, "Ore Extractor");
    }

    #[test]
    fn a_shape_it_does_not_recognise_yields_blanks_not_a_panic() {
        let t = parse_struct_type(&json!({"unexpected": 1}));
        assert!(t.class_abbreviation.is_empty());
        assert!(t.category.is_empty());
        assert!(!t.movable);
    }
}

#[cfg(test)]
mod fmt_tests {
    use super::fmt_watts;

    #[test]
    fn matches_the_games_number_formatter() {
        // Values below 1000 print whole; above, 1-3 leading digits + scale.
        assert_eq!(fmt_watts(72.0), "72");
        assert_eq!(fmt_watts(999.0), "999");
        assert_eq!(fmt_watts(1_000.0), "1k");
        assert_eq!(fmt_watts(8_469_986.0), "8M");
        // TRUNCATES, never rounds up — the game shows "5M" here.
        assert_eq!(fmt_watts(5_590_000.0), "5M");
        assert_eq!(fmt_watts(450_000.0), "450k");
        assert_eq!(fmt_watts(0.0), "0");
    }

    /// The bug this pins: `connectionCapacity` is a SUBSTATION attribute, not a
    /// player one — production's `structs.grid` holds fourteen of them and every
    /// single one has `object_type = substation`. Reading it off the player
    /// always yielded 0, so a worker drawing 2.5 kW through the guild substation
    /// rendered "2k/0" and looked catastrophically over capacity when it in fact
    /// had 7.7 kW available.
    #[test]
    fn the_substation_share_comes_off_the_substation() {
        use super::connection_capacity_of;
        use serde_json::json;

        // Substation 4-1 as production stores it.
        let sub = json!({"gridAttributes": {
            "capacity": "9962700000",
            "connectionCapacity": "7765159",
            "connectionCount": "1283",
            "load": "0"
        }});
        assert_eq!(connection_capacity_of(&sub), 7_765_159.0);

        // Player 1-1005: no own capacity, 2.5 kW of struct load, on 4-1.
        let own = 0.0;
        let total = own + connection_capacity_of(&sub);
        assert_eq!(fmt_watts(2_500_000.0 / 1000.0), "2k");
        assert_eq!(fmt_watts(total / 1000.0), "7k", "reads 2k/7k, never 2k/0");

        // A player connected to nothing degrades to zero, not to a panic.
        assert_eq!(connection_capacity_of(&json!({})), 0.0);
        assert_eq!(connection_capacity_of(&json!({"gridAttributes": {}})), 0.0);
    }

    /// The HUD readout after the milliwatt→watt correction. `gridAttributes`
    /// are raw chain integers: the live defender of planet 2-3176 carries
    /// `structsLoad: 2500000`, which is 2.5 kW — five planetary structs at
    /// 500 W each, not the 2.5 MW the undivided number implied.
    #[test]
    fn grid_attributes_are_milliwatts_before_they_are_formatted() {
        assert_eq!(fmt_watts(2_500_000.0 / 1000.0), "2k");
        assert_eq!(fmt_watts(8_000_000.0 / 1000.0), "8k");
        // A single Ore Extractor's draw: 500000 mW is 500 W.
        assert_eq!(fmt_watts(500_000.0 / 1000.0), "500");
        // Sub-watt loads must not vanish into a bare "0" surprise — they do
        // round down, which is the same truncation the game applies.
        assert_eq!(fmt_watts(999.0 / 1000.0), "0");
    }
}

/// Full snapshot enriched with the raid record — shared by the watcher's push
/// and the window's pull so the two can never disagree on shape.
pub async fn enriched_snapshot(
    client: &crate::mcp::cosmos_client::CosmosClient,
    planet_id: &str,
) -> Snapshot {
    let mut snap = snapshot_planet(client, planet_id).await;
    if let Ok(raid) = client.guild.planet_raid_active_by_planet(planet_id).await {
        let r = raid.as_array().and_then(|a| a.first()).unwrap_or(&raid);
        snap.raid_status = str_of(r.get("status"));
        snap.raiding_fleet = str_of(r.get("fleet_id"));
    }
    snap
}

/// Current re-target generation for a watched location; 0 when nothing
/// watches it yet. A pulled snapshot must carry this so the attack payloads
/// that follow (stamped by the watcher) reconcile against it.
pub fn generation_for(target: &Target) -> u64 {
    WATCHES
        .lock()
        .unwrap()
        .get(&watch_key(target))
        .map(|w| w.generation)
        .unwrap_or(0)
}

/// The pull half of the protocol: build the current state for a target ON
/// DEMAND, for the window to fetch on load.
///
/// The push path alone has a first-paint hole: `open_window` attaches the
/// watcher before the window's JS has parsed, so the first `raid-snapshot`
/// emit can fire at a document with no listeners — Tauri drops events nobody
/// is listening for — and the map then sits empty until the NEXT cycle,
/// 20 seconds later. The game's own map does not have this problem because it
/// pulls first (`MapStructLayerComponent.initPageCode` → `renderAllStructs`)
/// and treats events purely as updates; this mirrors that, the same way
/// board.html pulls `mcp_board_html` on load.
pub async fn pull_state(target: &Target) -> Value {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let planet_id = match target {
        Target::Planet { planet_id } => Some(planet_id.clone()),
        Target::Fleet { fleet_id } => client
            .entity("fleet", fleet_id)
            .await
            .ok()
            .and_then(|v| {
                let b = v.get("Fleet").unwrap_or(&v).clone();
                str_of(b.get("locationId"))
            }),
    };
    let Some(pid) = planet_id else {
        return json!({
            "snapshot": Value::Null,
            "reason": "fleet is not at a planet right now",
        });
    };
    let snap = enriched_snapshot(&client, &pid).await;
    json!({ "generation": generation_for(target), "snapshot": snap })
}

/// Resolve one placement into a drawable struct.
///
/// A destroyed struct is dropped: it is not on the map any more, and the
/// destroy animation that removed it has already played for anyone watching.
/// A spectator arriving later should see the aftermath, not ghosts.
async fn build_struct(
    client: &crate::mcp::cosmos_client::CosmosClient,
    planet_owner: Option<&str>,
    p: Placement,
) -> Option<SpectatorStruct> {
    let v = client.entity("struct", &p.struct_id).await.ok()?;
    let body = v.get("Struct").unwrap_or(&v);
    let sattrs = v.get("structAttributes");
    let protected_index = sattrs
        .and_then(|a| a.get("protectedStructIndex"))
        .and_then(num_u64)
        .unwrap_or(0);

    if flag(sattrs.and_then(|a| a.get("isDestroyed"))) {
        return None;
    }

    let owner = str_of(body.get("owner")).unwrap_or(p.owner_hint);
    let type_id = body.get("type").and_then(num_u64).unwrap_or(0);

    // `type_name` and `health_max` are NOT on the raw LCD entity — they are
    // enrichments the intel layer adds from GAME_STATE.struct_types (verified
    // the hard way: the same struct returns them through structs_intel and
    // blanks through a raw read). The game window keeps that table synced, so
    // resolve from it here too, with the entity fields as a fallback for any
    // future LCD that starts carrying them.
    let (catalog_name, catalog_max) = {
        let gs = crate::game_state::GAME_STATE.read().unwrap();
        match gs.struct_types.get(&type_id.to_string()) {
            Some(st) => (Some(st.name.clone()), st.max_health.map(|m| m as u64)),
            None => (None, None),
        }
    };
    let type_name = catalog_name
        .or_else(|| str_of(body.get("type_name")))
        .unwrap_or_default();

    Some(SpectatorStruct {
        id: p.struct_id,
        type_id,
        type_slug: type_slug(&type_name),
        type_name,
        category: p.category,
        // A struct defends iff its owner owns the planet. Everything else
        // standing here arrived to attack.
        side: match planet_owner {
            Some(po) if po == owner => "defender".into(),
            _ => "attacker".into(),
        },
        owner,
        // The chain's own operatingAmbit wins over the array we found it in;
        // they agree, but the struct entity is the authority on itself.
        ambit: str_of(body.get("operatingAmbit")).unwrap_or(p.ambit),
        slot: p.slot,
        health: sattrs.and_then(|a| a.get("health")).and_then(num_u64),
        // The catalogue is authoritative; entity fields (both LCD and DB
        // spellings) are fallbacks only.
        max_health: catalog_max
            .or_else(|| body.get("health_max").and_then(num_u64))
            .or_else(|| body.get("maxHealth").and_then(num_u64))
            .unwrap_or(0),
        destroyed: false,
        // Both default to true when absent: a read hiccup must degrade to a
        // normal-looking struct, not a board of powerless ghosts.
        online: sattrs
            .and_then(|a| a.get("isOnline"))
            .map(|v| flag(Some(v)))
            .unwrap_or(true),
        built: sattrs
            .and_then(|a| a.get("isBuilt"))
            .map(|v| flag(Some(v)))
            .unwrap_or(true),
        hidden: flag(sattrs.and_then(|a| a.get("isHidden"))),
        // A non-zero protected index means this struct is guarding something.
        defending: protected_index != 0,
        // Filled by `mark_defended` once every struct is known — it is a
        // relation, not a property, so it cannot be read off one entity.
        defended: false,
        // Struct ids are `5-<index>`; the chain stores only the index.
        protects: (protected_index != 0).then(|| crate::mcp::types::StructId::from_index(protected_index).to_string()),
        protected_index,
        is_command: p.is_command,
    })
}

// ── Registry: one watcher per location ──────────────────────────────────────

struct Watch {
    target: Target,
    /// Window labels currently looking at this location. When it empties, the
    /// task stops.
    windows: Vec<String>,
    /// Planet actually being rendered. For a fleet target this follows the
    /// fleet and changes as it moves.
    planet_id: Option<String>,
    /// Wall-clock (epoch ms) of the newest `struct_attack` row already sent, so
    /// the poll never replays a fight the window has already animated. Seeded to
    /// `fresh_shot_cursor()` rather than 0 — see there for why.
    shot_cursor: f64,
    /// Same idea as `shot_cursor`, for the BATTLE LOG. The log shows every
    /// activity category, not just attacks, so it needs its own high-water mark
    /// — the shot cursor only ever advances past `struct_attack` rows.
    log_cursor: f64,
    generation: u64,
    /// Set by the GRASS fan-out when a fleet arrives or departs: the board's
    /// composition changed, so the next poll tick rebuilds the snapshot
    /// immediately instead of waiting out the 20-second cadence. The game
    /// reacts to arrivals instantly; a spectator should too.
    force_snapshot: bool,
}

static WATCHES: LazyLock<Mutex<HashMap<String, Watch>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Key a watch by its target, so a planet window and a fleet window that
/// happen to be showing the same planet still poll independently — the fleet
/// one has to keep checking whether the fleet moved.
fn watch_key(target: &Target) -> String {
    match target {
        Target::Planet { planet_id } => format!("planet:{planet_id}"),
        Target::Fleet { fleet_id } => format!("fleet:{fleet_id}"),
    }
}

/// Register a window against a location, starting the poller if this is the
/// first one. Returns true when a new task was spawned.
pub fn attach(app: &tauri::AppHandle, target: &Target, window_label: &str) -> bool {
    let key = watch_key(target);
    let mut fresh = false;
    {
        let mut w = WATCHES.lock().unwrap();
        let entry = w.entry(key.clone()).or_insert_with(|| {
            fresh = true;
            Watch {
                target: target.clone(),
                windows: vec![],
                planet_id: match target {
                    Target::Planet { planet_id } => Some(planet_id.clone()),
                    Target::Fleet { .. } => None,
                },
                shot_cursor: fresh_shot_cursor(),
                log_cursor: fresh_shot_cursor(),
                generation: 0,
                force_snapshot: false,
            }
        });
        if !entry.windows.iter().any(|l| l == window_label) {
            entry.windows.push(window_label.to_string());
        }
    }
    if fresh {
        spawn_watcher(app.clone(), key);
    }
    fresh
}

/// Drop a window. The task notices its subscriber list emptied and exits.
pub fn detach(target: &Target, window_label: &str) {
    let key = watch_key(target);
    let mut w = WATCHES.lock().unwrap();
    if let Some(entry) = w.get_mut(&key) {
        entry.windows.retain(|l| l != window_label);
        if entry.windows.is_empty() {
            w.remove(&key);
        }
    }
}

/// Window labels watching a given planet, for the GRASS fan-out.
fn windows_for_planet(planet_id: &str) -> Vec<String> {
    WATCHES
        .lock()
        .unwrap()
        .values()
        .filter(|w| w.planet_id.as_deref() == Some(planet_id))
        .flat_map(|w| w.windows.clone())
        .collect()
}

/// How often the full snapshot is rebuilt. The stream carries the fast-moving
/// fields (health, status, shield) between refreshes, so this only needs to be
/// often enough to catch arrivals, departures and new builds.
const SNAPSHOT_INTERVAL_MS: u64 = 20_000;

/// How often `planet_activity` is checked for new shots. Combat resolves in
/// bursts; the response window in this game is measured in minutes, so a few
/// seconds of lag on the animation is imperceptible next to the fight itself.
const SHOT_POLL_MS: u64 = 4_000;
/// Shot-poll cadence while the planet is QUIET (no raider present, no live
/// raid status, no shots landing). A spectator window left open on a peaceful
/// planet was 15 requests/minute against the shared Guild API for nothing;
/// combat re-heats the poll the moment a snapshot or shot says so.
const SHOT_POLL_QUIET_MS: u64 = 20_000;

/// How much combat history a freshly-attached window is allowed to animate.
///
/// The cursor used to start at 0, which meant "everything is newer than this" —
/// so the first poll replayed every `struct_attack` still on page 1 of the
/// planet's activity (100 rows; up to ~31 attacks, some MONTHS old) as live
/// choreography. Opening a raid view looked like a fight was already underway:
/// health bars stepped down, then snapped back on the next snapshot, with no
/// matching charge spend and nothing new in the battle log.
///
/// Seeding it just behind `now` keeps the useful half of that — attach mid-fight
/// and the last few seconds still play in — while making the archive unreachable.
const SHOT_BACKFILL_MS: f64 = 30_000.0;

/// Cursor for a window that is starting to watch a location for the first time,
/// or that just followed its fleet to a different planet.
fn fresh_shot_cursor() -> f64 {
    crate::hasher::types::now_millis() - SHOT_BACKFILL_MS
}

fn spawn_watcher(app: tauri::AppHandle, key: String) {
    tauri::async_runtime::spawn(async move {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let mut last_snapshot = 0f64;
        // Start hot: a freshly-opened window should feel live immediately;
        // the first snapshot then decides whether the planet is actually quiet.
        let mut raid_hot = true;
        loop {
            // Exit as soon as nobody is looking, or the feature was disabled.
            let (target, windows, planet_id, generation) = {
                let w = WATCHES.lock().unwrap();
                match w.get(&key) {
                    Some(e) if !e.windows.is_empty() => (
                        e.target.clone(),
                        e.windows.clone(),
                        e.planet_id.clone(),
                        e.generation,
                    ),
                    _ => return,
                }
            };

            // A fleet target has to resolve (and keep re-resolving) which
            // planet it is at — that is the whole point of following one.
            let planet_id = match &target {
                Target::Planet { planet_id } => Some(planet_id.clone()),
                Target::Fleet { fleet_id } => {
                    let at = client
                        .entity("fleet", fleet_id)
                        .await
                        .ok()
                        .and_then(|v| str_of(v.get("Fleet").and_then(|f| f.get("locationId"))));
                    if at != planet_id {
                        // Moved: reset the shot cursor and force a rebuild, so
                        // the new planet never inherits the old one's combat —
                        // nor, via a zeroed cursor, the new planet's own archive.
                        // This is the tick that fires when a followed fleet
                        // launches a raid and reaches the target.
                        let mut w = WATCHES.lock().unwrap();
                        if let Some(e) = w.get_mut(&key) {
                            e.planet_id = at.clone();
                            e.shot_cursor = fresh_shot_cursor();
                            e.log_cursor = fresh_shot_cursor();
                            e.generation += 1;
                        }
                        last_snapshot = 0.0;
                        for label in &windows {
                            emit(&app, label, "raid-target-moved",
                                json!({ "fleet_id": fleet_id, "planet_id": at }));
                        }
                    }
                    at
                }
            };

            let Some(pid) = planet_id else {
                // A fleet with no location (in transit) — say so rather than
                // render an empty map that looks like a bug.
                for label in &windows {
                    emit(&app, label, "raid-detached",
                        json!({ "reason": "fleet is not at a planet right now" }));
                }
                tokio::time::sleep(std::time::Duration::from_millis(SHOT_POLL_MS)).await;
                continue;
            };

            let forced = {
                let mut w = WATCHES.lock().unwrap();
                match w.get_mut(&key) {
                    Some(e) if e.force_snapshot => {
                        e.force_snapshot = false;
                        true
                    }
                    _ => false,
                }
            };
            let now = crate::hasher::types::now_millis();
            if forced || now - last_snapshot >= SNAPSHOT_INTERVAL_MS as f64 {
                last_snapshot = now;
                let snap = enriched_snapshot(&client, &pid).await;
                // A raider on the planet (or a non-terminal raid status) keeps
                // the shot poll hot; a quiet planet drops to the slow cadence.
                raid_hot = snap.raiding_fleet.is_some()
                    || matches!(
                        snap.raid_status.as_deref(),
                        Some("initiated") | Some("ongoing") | Some("shieldsVulnerable")
                    );
                let payload = json!({ "generation": generation, "snapshot": snap });
                for label in &windows {
                    emit(&app, label, "raid-snapshot", payload.clone());
                }
            }

            // Shots: the choreography source. Only rows newer than the cursor.
            if let Ok(page) = client.guild.planet_activity_by_planet(&pid, 1).await {
                let cursor = WATCHES
                    .lock()
                    .unwrap()
                    .get(&key)
                    .map(|e| e.shot_cursor)
                    .unwrap_or(0.0);
                let (shots, high) = collect_shots(&page.items, cursor);
                if !shots.is_empty() {
                    // Shots landing = combat, whatever the last snapshot said.
                    raid_hot = true;
                    if let Ok(mut w) = WATCHES.lock() {
                        if let Some(e) = w.get_mut(&key) {
                            e.shot_cursor = high;
                        }
                    }
                    let payload = json!({ "generation": generation, "attacks": shots });
                    for label in &windows {
                        emit(&app, label, "raid-attacks", payload.clone());
                    }
                }

                // ── Battle log ──────────────────────────────────────────────
                // The log used to load ONCE — on open, or when a followed fleet
                // re-targeted — and then never again, so a window left open
                // showed a frozen log while the map animated live beside it.
                // Only a reload brought it up to date.
                //
                // This page is the same one the shots came from and it carries
                // every activity category, so live rows cost no extra request.
                let log_cursor = WATCHES
                    .lock()
                    .unwrap()
                    .get(&key)
                    .map(|e| e.log_cursor)
                    .unwrap_or(0.0);
                let (log_rows, log_high) =
                    crate::mcp::raid_view::collect_log_rows(&page.items, log_cursor);
                if !log_rows.is_empty() {
                    if let Ok(mut w) = WATCHES.lock() {
                        if let Some(e) = w.get_mut(&key) {
                            e.log_cursor = log_high;
                        }
                    }
                    let payload = json!({ "generation": generation, "rows": log_rows });
                    for label in &windows {
                        emit(&app, label, "raid-log", payload.clone());
                    }
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(
                if raid_hot { SHOT_POLL_MS } else { SHOT_POLL_QUIET_MS },
            ))
            .await;
        }
    });
}

/// Emit to one spectator window. `emit_board` is not reused here: it fans out
/// to a fixed list of board labels, and a raid window must receive only the
/// location it is actually watching.
///
/// The event NAME is namespaced with the window label (`raid-attacks::raid-2-1595`):
/// the renderer's plain `listen()` registers with `EventTarget::Any`, which
/// Tauri matches against targeted emits meant for OTHER windows too — with two
/// raid windows open, un-namespaced names delivered every location's events to
/// every window (each would replace its state with whichever planet emitted
/// last). Distinct names make cross-delivery impossible regardless of listener
/// target semantics. raidview.js learns its label from the window URL.
fn emit(app: &tauri::AppHandle, label: &str, event: &str, payload: Value) {
    use tauri::{Emitter, Manager};
    if app.get_webview_window(label).is_some() {
        let _ = app.emit_to(label, format!("{event}::{label}").as_str(), payload);
    }
}

/// Pull `struct_attack` rows newer than `cursor` into renderer-ready attacks,
/// oldest first so the animation queue plays them in the order they happened.
///
/// Returns the attacks and the new high-water mark. The cursor is the row's
/// wall-clock in ms — `seq` is only unique within a block, so it cannot order
/// across them.
pub fn collect_shots(rows: &[Value], cursor: f64) -> (Vec<Value>, f64) {
    let mut out: Vec<(f64, Value)> = vec![];
    let mut high = cursor;

    for row in rows {
        if row.get("category").and_then(|c| c.as_str()) != Some("struct_attack") {
            continue;
        }
        let ts = str_of(row.get("time"))
            .as_deref()
            .and_then(crate::mcp::raid_view::parse_guild_time)
            .unwrap_or(0.0);
        // Strictly newer: a `>=` here would replay the newest fight forever.
        if ts <= cursor {
            continue;
        }
        if ts > high {
            high = ts;
        }
        let detail = match row.get("detail") {
            Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        };
        // The resolved outcome is per-shot in `eventAttackShotDetail`, never
        // flat on the detail — the same shape `intel.rs` battle_log parses.
        let shots = detail
            .get("eventAttackShotDetail")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        out.push((
            ts,
            json!({
                "at_ms": ts,
                "attacker_id": str_of(detail.get("attackerStructId")),
                "attacker_type": str_of(detail.get("attackerStructType")),
                // On the PARENT detail, not the shot — this is the one ambit
                // the shots themselves omit, and it completes the dispatch
                // geometry without leaning on the snapshot.
                "attacker_ambit": str_of(detail.get("attackerStructOperatingAmbit")),
                "weapon": str_of(detail.get("weaponSystem")),
                "recoil": detail.get("recoilDamage").and_then(num_u64).unwrap_or(0),
                // Counters and recoil land on the attacker; threading these
                // lets the choreography step the attacker's bar down (and play
                // its destroy when a counter kills it) instead of waiting for
                // the next snapshot.
                "attacker_health_before": detail.get("attackerHealthBefore").and_then(num_u64),
                "attacker_health_after": detail.get("attackerHealthAfter").and_then(num_u64),
                // The planet's own cannon answering the volley lives on the
                // PARENT detail, not in any shot. The game plays the cannon's
                // weapon animation and the attacker's impact for it
                // (StructListener: planetaryDefenseCannonDamageToAttacker);
                // without these three the viewer could not.
                "pdc_damage_to_attacker": detail
                    .get("planetaryDefenseCannonDamageToAttacker")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                "pdc_damage": detail.get("planetaryDefenseCannonDamage").and_then(num_u64).unwrap_or(0),
                "pdc_destroyed_attacker": detail
                    .get("planetaryDefenseCannonDamageDestroyedAttacker")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                "shots": shots,
            }),
        ));
    }

    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    (out.into_iter().map(|(_, v)| v).collect(), high)
}

// ── GRASS fan-out ───────────────────────────────────────────────────────────

/// Categories a spectator cares about. Everything else on the stream — and it
/// carries every planet in the galaxy — is dropped before it costs anything.
const WATCHED_CATEGORIES: &[&str] = &[
    "struct_health",
    "struct_status",
    "shield_change",
    "raid_status",
    "fleet_arrive",
    "fleet_depart",
    "block_raid_start",
];

/// Route a live event to any window watching the planet it concerns.
///
/// Called from the single GRASS ingest point. The webapp already subscribes
/// `structs.>`, so every planet's events arrive here regardless of who is
/// watching — this only decides where they go.
pub fn note_event(app: &tauri::AppHandle, event: &crate::mcp::event_buffer::GameEvent) {
    if !WATCHED_CATEGORIES.contains(&event.category.as_str()) {
        return;
    }
    let Some(planet_id) = planet_of(event) else {
        return;
    };
    let windows = windows_for_planet(&planet_id);
    if windows.is_empty() {
        return;
    }
    // Fleet movement changes WHO IS ON THE BOARD — deltas alone can't add or
    // remove a whole fleet's structs, so ask the watcher for a fresh snapshot
    // on its next tick (≤4s) instead of waiting out the snapshot cadence.
    if event.category == "fleet_arrive" || event.category == "fleet_depart" {
        let mut w = WATCHES.lock().unwrap();
        for e in w.values_mut() {
            if e.planet_id.as_deref() == Some(planet_id.as_str()) {
                e.force_snapshot = true;
            }
        }
    }
    let payload = json!({
        "category": event.category,
        "subject": event.subject,
        "detail": event.detail,
        "at_ms": event.timestamp,
        "planet_id": planet_id,
    });
    for label in windows {
        emit(app, &label, "raid-delta", payload.clone());
    }
}

/// Which planet an event concerns.
///
/// Subjects look like `structs.planet.<planet_id>.<player_id>`; some categories
/// instead name the planet in the detail. Both are checked because a missed id
/// means a window that silently stops updating.
pub fn planet_of(event: &crate::mcp::event_buffer::GameEvent) -> Option<String> {
    if let Some(p) = str_of(event.detail.get("planet_id")) {
        return Some(p);
    }
    if let Some(p) = str_of(event.detail.get("planetId")) {
        return Some(p);
    }
    let mut parts = event.subject.split('.');
    while let Some(seg) = parts.next() {
        if seg == "planet" {
            return parts.next().filter(|s| !s.is_empty()).map(String::from);
        }
    }
    None
}

// ── Window bookkeeping ──────────────────────────────────────────────────────

/// Snapshot of who is watching what, for diagnostics and tests.
pub fn debug_state() -> Value {
    let w = WATCHES.lock().unwrap();
    json!({
        "watches": w.iter().map(|(k, v)| json!({
            "key": k,
            "planet_id": v.planet_id,
            "windows": v.windows,
            "shot_cursor": v.shot_cursor,
            "log_cursor": v.log_cursor,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::event_buffer::GameEvent;

    #[test]
    fn type_slug_matches_the_lottie_bundle_names() {
        // These are directory names that exist on disk under frontend/lottie/;
        // getting one wrong means a silently missing animation.
        assert_eq!(type_slug("Command Ship"), "command_ship");
        assert_eq!(type_slug("High Altitude Interceptor"), "high_altitude_interceptor");
        assert_eq!(type_slug("Planetary Defense Cannon"), "planetary_defense_cannon");
        assert_eq!(type_slug("Orbital Shield Generator"), "orbital_shield_generator");
        assert_eq!(type_slug("Ore Extractor"), "ore_extractor");
        assert_eq!(type_slug("Tank"), "tank");
        assert_eq!(type_slug("SAM Launcher"), "sam_launcher");
    }

    #[test]
    fn type_slug_never_emits_leading_or_doubled_separators() {
        assert_eq!(type_slug("  Ore  Bunker "), "ore_bunker");
        assert_eq!(type_slug("Field-Generator"), "field_generator");
    }

    // ── Placement ──────────────────────────────────────────────────────────
    //
    // Bodies below are copied from live LCD reads of planet 2-659 and fleet
    // 9-61, not invented.

    fn planet_body() -> Value {
        json!({
            "id": "2-659",
            "owner": "1-471",
            "locationListStart": "9-61",
            "locationListLast": "9-61",
            "space": ["5-6403", "5-14117", "5-6439", "5-6443"],
            "air":   ["", "", "", ""],
            "land":  ["5-14119", "5-6400", "5-6401", "5-6402"],
            "water": ["", "5-14144", "5-7863", ""],
            "spaceSlots": "4", "airSlots": "4", "landSlots": "4", "waterSlots": "4",
        })
    }

    fn fleet_body() -> Value {
        json!({
            "id": "9-61",
            "owner": "1-61",
            "commandStruct": "5-14098",
            "locationId": "2-659",
            "locationListForward": "",
            "space": ["5-14108", "5-2219", "5-4672", "5-8291"],
            "air":   ["5-4643", "", "5-2364", "5-14109"],
            "land":  ["5-14112", "", "5-14113", ""],
            "water": ["5-2065", "5-14114", "5-14115", "5-2035"],
        })
    }

    #[test]
    fn the_array_index_is_the_slot() {
        let p = placements_from(&planet_body(), "planet", "1-471", None);
        let land: Vec<_> = p.iter().filter(|x| x.ambit == "land").collect();
        assert_eq!(land.len(), 4);
        assert_eq!(land[0].struct_id, "5-14119");
        assert_eq!(land[0].slot, 0);
        assert_eq!(land[3].struct_id, "5-6402");
        assert_eq!(land[3].slot, 3);
    }

    #[test]
    fn an_empty_string_is_a_vacant_slot_not_a_struct() {
        let p = placements_from(&planet_body(), "planet", "1-471", None);
        // Air is entirely empty; water has two holes at slots 0 and 3.
        assert!(!p.iter().any(|x| x.ambit == "air"), "air is unoccupied");
        let water: Vec<_> = p.iter().filter(|x| x.ambit == "water").collect();
        assert_eq!(water.len(), 2);
        assert_eq!(water[0].slot, 1, "the hole at slot 0 must not shift slot 1 down");
        assert_eq!(water[1].slot, 2);
    }

    #[test]
    fn four_slots_per_ambit_matches_the_maps_two_columns_by_two_rows() {
        // The map gives 2 columns × MAP_TILE_ROWS_PER_AMBIT(2) = 4 slots per
        // ambit per block. If the chain ever widened its arrays the grid would
        // silently drop structs, so pin the assumption.
        for ambit in AMBIT_KEYS {
            let n = planet_body().get(*ambit).unwrap().as_array().unwrap().len();
            assert_eq!(n, 4, "{ambit} should have 4 slots");
        }
    }

    #[test]
    fn the_command_ship_is_named_not_guessed() {
        let p = placements_from(&fleet_body(), "fleet", "1-61", Some("5-14098"));
        // 5-14098 is not in this fleet's arrays at all (it sits elsewhere), so
        // nothing should be flagged — and crucially nothing should panic.
        assert!(!p.iter().any(|x| x.is_command));

        // With a command struct that IS present, exactly one is flagged.
        let p2 = placements_from(&fleet_body(), "fleet", "1-61", Some("5-14112"));
        let flagged: Vec<_> = p2.iter().filter(|x| x.is_command).collect();
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0].struct_id, "5-14112");
    }

    #[test]
    fn a_command_ship_absent_from_the_arrays_is_still_placed() {
        // fleet 9-61 exactly as read live: commandStruct 5-14098 appears in
        // NONE of its ambit arrays. It must get a synthetic slot-0 placement
        // or the raid's most important struct never renders.
        let p = fleet_placements(&fleet_body());
        let cmd: Vec<_> = p.iter().filter(|x| x.is_command).collect();
        assert_eq!(cmd.len(), 1);
        assert_eq!(cmd[0].struct_id, "5-14098");
        assert_eq!(cmd[0].slot, 0, "command tiles are always slot 0");
        assert_eq!(cmd[0].category, "fleet");
        assert_eq!(cmd[0].owner_hint, "1-61");
        // 13 array occupants (space 4 + air 3 + land 2 + water 4) + the
        // injected command ship.
        assert_eq!(p.len(), 14);
    }

    #[test]
    fn a_command_ship_that_is_in_the_arrays_is_not_duplicated() {
        let mut body = fleet_body();
        body["commandStruct"] = json!("5-14112"); // land slot 0 occupant
        let p = fleet_placements(&body);
        assert_eq!(
            p.iter().filter(|x| x.struct_id == "5-14112").count(),
            1,
            "one placement, flagged, never a second synthetic one"
        );
        assert!(p.iter().find(|x| x.struct_id == "5-14112").unwrap().is_command);
        assert_eq!(p.len(), 13);
    }

    #[test]
    fn planet_and_fleet_slots_are_separate_spaces() {
        // Both a planetary struct and a fleet struct can be "land slot 0".
        // Conflating them is exactly what the Guild API's flat slot number
        // would do, and why the arrays are used instead.
        let mut all = placements_from(&planet_body(), "planet", "1-471", None);
        all.extend(placements_from(&fleet_body(), "fleet", "1-61", None));
        let land0: Vec<_> = all
            .iter()
            .filter(|x| x.ambit == "land" && x.slot == 0)
            .collect();
        assert_eq!(land0.len(), 2, "two different structs share land slot 0");
        assert_ne!(land0[0].category, land0[1].category);
    }

    #[test]
    fn max_health_reads_from_either_naming() {
        // LCD says `health_max` (a number); the DB column is `max_health`.
        // Reading only one of them silently yields 0, which would render every
        // struct with no health bar and never show the damaged variant.
        let lcd = json!({ "health_max": 6 });
        let db = json!({ "max_health": "6" });
        let pick = |b: &Value| {
            b.get("health_max")
                .and_then(num_u64)
                .or_else(|| b.get("maxHealth").and_then(num_u64))
                .unwrap_or(0)
        };
        assert_eq!(pick(&lcd), 6);
        assert_eq!(pick(&db), 0, "the DB spelling is deliberately not the LCD one");
    }

    #[test]
    fn boolean_flags_survive_string_encoding() {
        assert!(flag(Some(&json!(true))));
        assert!(flag(Some(&json!("true"))));
        assert!(flag(Some(&json!("t"))));
        assert!(!flag(Some(&json!(false))));
        assert!(!flag(Some(&json!("false"))));
        assert!(!flag(None));
    }

    #[test]
    fn ambits_stack_space_to_water() {
        let mut a = vec!["water", "land", "space", "air"];
        a.sort_by_key(|x| ambit_rank(x));
        assert_eq!(a, vec!["space", "air", "land", "water"]);
    }

    fn attack_row(time: &str, attacker: &str, target: &str, before: u64, after: u64) -> Value {
        json!({
            "time": time,
            "seq": 1,
            "planet_id": "2-1595",
            "category": "struct_attack",
            "detail": {
                "attackerStructId": attacker,
                "attackerStructType": "Battleship",
                "weaponSystem": "primaryWeapon",
                "recoilDamage": "0",
                "eventAttackShotDetail": [{
                    "targetStructId": target,
                    "targetStructType": "Tank",
                    "targetHealthBefore": before.to_string(),
                    "targetHealthAfter": after.to_string(),
                    "damageDealt": (before - after).to_string(),
                    "targetDestroyed": after == 0,
                }],
            },
        })
    }

    #[test]
    fn shots_come_back_oldest_first() {
        // The animation queue plays in arrival order, so a newest-first feed
        // would replay a fight backwards.
        let rows = vec![
            attack_row("2026-07-28 14:50:00+00", "5-1", "5-2", 4, 2),
            attack_row("2026-07-28 14:49:00+00", "5-1", "5-2", 6, 4),
        ];
        let (shots, _) = collect_shots(&rows, 0.0);
        assert_eq!(shots.len(), 2);
        assert!(shots[0]["at_ms"].as_f64().unwrap() < shots[1]["at_ms"].as_f64().unwrap());
    }

    #[test]
    fn the_cursor_is_strict_so_a_fight_never_replays() {
        let rows = vec![attack_row("2026-07-28 14:50:00+00", "5-1", "5-2", 4, 2)];
        let (first, high) = collect_shots(&rows, 0.0);
        assert_eq!(first.len(), 1);
        // Second pass with the returned cursor must yield nothing.
        let (second, high2) = collect_shots(&rows, high);
        assert!(second.is_empty(), "the same attack was emitted twice");
        assert_eq!(high, high2);
    }

    #[test]
    fn per_shot_health_survives_into_the_payload() {
        // The renderer animates toward these numbers rather than reading live
        // state, because live state has already moved by the time shots arrive.
        let rows = vec![attack_row("2026-07-28 14:50:00+00", "5-1", "5-2", 4, 0)];
        let (shots, _) = collect_shots(&rows, 0.0);
        let shot = &shots[0]["shots"][0];
        assert_eq!(shot["targetHealthBefore"], "4");
        assert_eq!(shot["targetHealthAfter"], "0");
        assert_eq!(shot["targetDestroyed"], true);
    }

    /// Render an epoch-ms instant in the Guild API's timestamp format.
    fn iso_at(ms: f64) -> String {
        chrono::DateTime::from_timestamp_millis(ms as i64)
            .unwrap()
            .format("%Y-%m-%d %H:%M:%S%.6f+00")
            .to_string()
    }

    #[test]
    fn a_fresh_watch_animates_the_live_fight_but_not_the_archive() {
        // The cursor used to start at 0, which means "everything is newer than
        // this": attaching a window replayed every struct_attack still on page 1
        // — up to ~31 rows, some of them months old — as live choreography.
        let now = crate::hasher::types::now_millis();
        let rows = vec![
            attack_row("2026-05-12 22:29:33+00", "5-1", "5-2", 6, 4), // the archive
            attack_row(&iso_at(now - 5_000.0), "5-3", "5-4", 4, 2),   // happening now
        ];
        let (shots, _) = collect_shots(&rows, fresh_shot_cursor());
        assert_eq!(shots.len(), 1, "only the in-flight fight should animate");
        assert_eq!(shots[0]["attacker_id"], "5-3");
    }

    #[test]
    fn the_backfill_window_is_the_only_thing_a_new_watch_can_see() {
        let now = crate::hasher::types::now_millis();
        let stale = attack_row(&iso_at(now - SHOT_BACKFILL_MS - 60_000.0), "5-1", "5-2", 4, 2);
        let (shots, _) = collect_shots(&[stale], fresh_shot_cursor());
        assert!(shots.is_empty(), "anything older than the backfill window is history");
    }

    #[test]
    fn non_attack_categories_are_not_choreography() {
        let mut row = attack_row("2026-07-28 14:50:00+00", "5-1", "5-2", 4, 2);
        row["category"] = Value::String("raid_status".into());
        let (shots, high) = collect_shots(&[row], 0.0);
        assert!(shots.is_empty());
        assert_eq!(high, 0.0);
    }

    fn ev(category: &str, subject: &str, detail: Value) -> GameEvent {
        GameEvent {
            category: category.into(),
            subject: subject.into(),
            detail,
            timestamp: 0.0,
        }
    }

    #[test]
    fn planet_is_read_from_the_subject_when_the_detail_omits_it() {
        let e = ev("struct_health", "structs.planet.2-1595.1-278", json!({ "health": 3 }));
        assert_eq!(planet_of(&e).as_deref(), Some("2-1595"));
    }

    #[test]
    fn planet_in_the_detail_wins() {
        let e = ev("raid_status", "structs.something.else", json!({ "planet_id": "2-855" }));
        assert_eq!(planet_of(&e).as_deref(), Some("2-855"));
    }

    #[test]
    fn an_event_naming_no_planet_is_dropped() {
        let e = ev("struct_health", "structs.player.1-194", json!({ "health": 3 }));
        assert!(planet_of(&e).is_none());
    }
}
