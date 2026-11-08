//! The mirror's input: the slice of chain state the time-driven rules read,
//! pinned to the height it was observed at and labelled with how far it can
//! be trusted.
//!
//! A [`World`] is built from the perception snapshot but owns its data, so a
//! forecast never holds the snapshot lock and the rules stay pure. Every field
//! the chain reads that the snapshot cannot supply is `None`, never 0: the
//! forecast reports it as unknown rather than guessing.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::mcp::perception::{status, Snapshot};

/// Where the world came from and how coherent it is.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Provenance {
    /// The rule set forecasts are computed under.
    pub rules: &'static str,
    /// Newest height any part of the world was served at.
    pub height: u64,
    /// Oldest page height. Bulk pages are fetched concurrently and live
    /// events are applied on top, so the world is only known to be ONE chain
    /// state when `min_height == height`.
    pub min_height: u64,
    /// `min_height == height`: every row describes the same block.
    pub coherent: bool,
    /// Every bulk page was served pinned to `height` (an LCD walk with the
    /// height header): coherence proven by the node, not inferred.
    pub pinned: bool,
    /// Live frames dropped while the snapshot was fetched; non-zero means it
    /// may miss changes after its pages.
    pub replay_gap: u64,
    /// "guild" or "lcd" — which feed served the bulk pages.
    pub source: String,
    /// Seconds since the bulk pages were served (live events may be newer).
    pub age_s: f64,
    /// Live events applied on top of the bulk pages.
    pub events_applied: u64,
}

/// What a struct type demands, from the chain's StructType record.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TypeRules {
    pub name: String,
    pub build_difficulty: u64,
    pub ore_mining_difficulty: u64,
    pub ore_refining_difficulty: u64,
    /// Per-action charge requirements the chain checks (`< …Charge` refuses).
    pub charges: Vec<(&'static str, u64)>,
    /// Load held while building, released at completion; `None` = not known.
    pub build_draw: Option<u64>,
    /// Load the built struct draws from then on; `None` = not known.
    pub passive_draw: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlayerState {
    pub id: String,
    pub last_action: Option<u64>,
    pub stored_ore: Option<u64>,
    pub load: Option<u64>,
    pub structs_load: Option<u64>,
    pub capacity: Option<u64>,
    /// `connectionCapacity` of the player's substation (the chain's
    /// `GetCapacitySecondary`); `None` when the player has no substation row.
    pub capacity_secondary: Option<u64>,
    /// The player's substation id, `""` when none.
    pub substation: String,
    /// `CheckSubstation`: the substation exists on-chain. `None` = not read.
    pub substation_exists: Option<bool>,
    /// The chain's usable primary capacity (power.rs); `None` = not read, in
    /// which case stored `capacity` serves as an upper bound.
    pub usable_primary: Option<super::power::Usable>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanetState {
    pub id: String,
    pub owner: String,
    pub shield: u64,
    pub raid_start: u64,
    pub mine_start: u64,
    pub refine_start: u64,
    pub mining_active: u64,
    pub refining_active: u64,
    /// Planet grid `ore` = buried ore (`PlanetCache.GetBuriedOre`).
    pub buried_ore: Option<u64>,
    /// `Planet.status == complete`; `None` when the row does not carry it.
    pub complete: Option<bool>,
    /// `Planet.locationListStart`: the first visiting fleet, `""` when none;
    /// `None` when the row does not carry the field.
    pub location_list_start: Option<String>,
    /// Fleets at the planet by the chain's own list rule (fleet_cache.go
    /// `SetLocationToPlanet`): a fleet joins a planet's list when it arrives
    /// somewhere that is not its owner's home planet.
    pub visitors: Vec<String>,
    /// `PlanetCache.IsDefenderCommandStructVulnerable`, decided from the
    /// owner, their fleet and its Command Ship.
    pub defender: Defender,
}

/// Is the planet's defending Command Ship vulnerable (the raid puzzle can be
/// won)? `vulnerable: None` = an input the rule reads is missing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Defender {
    pub vulnerable: Option<bool>,
    pub reason: String,
}

impl Defender {
    fn known(vulnerable: bool, reason: impl Into<String>) -> Self {
        Defender { vulnerable: Some(vulnerable), reason: reason.into() }
    }
    fn unknown(reason: impl Into<String>) -> Self {
        Defender { vulnerable: None, reason: reason.into() }
    }
}

/// planet_cache.go `IsDefenderCommandStructVulnerable`, step for step.
fn defender_of(snap: &Snapshot, owner: &str) -> Defender {
    if owner.is_empty() {
        return Defender::known(true, "planet has no owner");
    }
    let Some(player) = snap.player_row(owner) else { return Defender::unknown(format!("owner {owner} not in the snapshot")) };
    let fleet_id = s(player, "fleetId");
    if fleet_id.is_empty() {
        return Defender::known(true, "owner has no fleet");
    }
    // The chain answers "vulnerable" when the fleet cannot be loaded; a row
    // missing from a snapshot is not proof it is missing on-chain.
    let Some(fleet) = snap.fleet_row(&fleet_id) else { return Defender::unknown(format!("fleet {fleet_id} not in the snapshot")) };
    match s(fleet, "status").as_str() {
        "onStation" => {}
        "away" => return Defender::known(true, format!("fleet {fleet_id} is away")),
        other => return Defender::unknown(format!("fleet {fleet_id} status {other:?}")),
    }
    let cmd = s(fleet, "commandStruct");
    if cmd.is_empty() {
        return Defender::known(true, "fleet has no Command Ship");
    }
    if !snap.struct_exists(&cmd) {
        return Defender::unknown(format!("Command Ship {cmd} not in the snapshot"));
    }
    let st = snap.struct_status(&cmd);
    if st & status::DESTROYED != 0 {
        return Defender::known(true, format!("Command Ship {cmd} destroyed"));
    }
    if st & status::ONLINE == 0 {
        return Defender::known(true, format!("Command Ship {cmd} offline"));
    }
    Defender::known(false, format!("Command Ship {cmd} online on station"))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StructState {
    pub id: String,
    pub owner: String,
    pub type_id: String,
    pub status: u64,
    pub build_start: u64,
    /// The planet the struct works on (`StructCache.GetPlanet`: its own
    /// location, or its fleet's).
    pub planet: Option<String>,
}

impl StructState {
    pub fn has(&self, bit: u64) -> bool {
        self.status & bit != 0
    }
}

/// The pinned state forecasts run over.
#[derive(Clone, Debug, Default)]
pub struct World {
    pub provenance: Option<Provenance>,
    pub players: HashMap<String, PlayerState>,
    pub planets: HashMap<String, PlanetState>,
    pub structs: HashMap<String, StructState>,
    pub types: HashMap<String, TypeRules>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn planet_complete(row: &Value) -> Option<bool> {
    // PlanetStatus: active = 0, complete = 1 (types/keys.pb.go). The LCD
    // serialises the enum by name; a guild row may carry either form.
    match row.get("status")? {
        Value::String(x) => match x.as_str() {
            "complete" | "1" => Some(true),
            "active" | "0" => Some(false),
            _ => None,
        },
        Value::Number(n) => n.as_u64().map(|n| n == 1),
        _ => None,
    }
}

impl World {
    /// Copy the rule inputs for `owners` (or every player when `None`) out of
    /// the snapshot.
    pub fn from_snapshot(
        snap: &Snapshot,
        types: HashMap<String, TypeRules>,
        source: &str,
        owners: Option<&[String]>,
    ) -> World {
        let wanted = |owner: &str| owners.map_or(true, |o| o.iter().any(|x| x == owner));
        let mut w = World {
            provenance: Some(Provenance {
                rules: super::rules::RULES,
                height: snap.height,
                min_height: snap.min_height,
                coherent: snap.min_height == snap.height && snap.height > 0,
                pinned: snap.pinned,
                replay_gap: snap.replay_gap,
                source: source.to_string(),
                age_s: (snap.age_ms() / 1000.0).max(0.0),
                events_applied: snap.events_applied,
            }),
            types,
            ..World::default()
        };

        for (id, row) in &snap.structs {
            if !wanted(&row.owner) {
                continue;
            }
            let planet = match row.location_type.as_str() {
                "planet" => Some(row.location_id.clone()),
                "fleet" => snap.fleet_row(&row.location_id).map(|f| s(f, "locationId")).filter(|p| !p.is_empty()),
                _ => None,
            };
            w.structs.insert(
                id.clone(),
                StructState {
                    id: id.clone(),
                    owner: row.owner.clone(),
                    type_id: row.type_id.clone(),
                    status: snap.struct_status(id),
                    build_start: snap.struct_attr(id, "blockStartBuild").unwrap_or(0),
                    planet,
                },
            );
        }

        let mut player_ids: Vec<String> = w.structs.values().map(|s| s.owner.clone()).collect();
        if let Some(o) = owners {
            player_ids.extend(o.iter().cloned());
        }
        player_ids.sort();
        player_ids.dedup();
        for pid in player_ids {
            let Some(row) = snap.player_row(&pid) else { continue };
            let substation = s(row, "substationId");
            w.players.insert(
                pid.clone(),
                PlayerState {
                    id: pid.clone(),
                    last_action: snap.grid_attr(&pid, "lastAction"),
                    stored_ore: snap.grid_attr(&pid, "ore"),
                    load: snap.grid_attr(&pid, "load"),
                    structs_load: snap.grid_attr(&pid, "structsLoad"),
                    capacity: snap.grid_attr(&pid, "capacity"),
                    substation: substation.clone(),
                    substation_exists: None,
                    usable_primary: None,
                    // No substation = no secondary capacity. A substation with
                    // no grid row here is unknown, not zero.
                    capacity_secondary: if substation.is_empty() {
                        Some(0)
                    } else {
                        let i = crate::mcp::perception::GRID_ATTRS.iter().position(|n| *n == "connectionCapacity");
                        i.and_then(|i| snap.grid.get(&substation).map(|a| a[i]))
                    },
                },
            );
        }

        let mut planet_ids: Vec<String> = w.structs.values().filter_map(|s| s.planet.clone()).collect();
        planet_ids.extend(w.players.keys().filter_map(|p| snap.player_row(p).map(|r| s(r, "planetId"))));
        planet_ids.retain(|p| !p.is_empty());
        planet_ids.sort();
        planet_ids.dedup();
        // Visiting fleets by planet, in one pass (`fleets_at` per planet is a
        // full fleet scan each — quadratic over a galaxy). The chain lists a
        // fleet at a planet that is not its owner's home.
        let mut fleets_at: HashMap<String, Vec<String>> = HashMap::new();
        for (fid, f) in &snap.fleets {
            if s(f, "locationType") != "planet" {
                continue;
            }
            let at = s(f, "locationId");
            let home = snap.player_row(&s(f, "owner")).map(|p| s(p, "planetId")).unwrap_or_default();
            if home != at {
                fleets_at.entry(at).or_default().push(fid.clone());
            }
        }
        for pid in planet_ids {
            let Some(row) = snap.planet_row(&pid) else { continue };
            let owner = s(row, "owner");
            let attr = |n: &str| snap.planet_attr(&pid, n).unwrap_or(0);
            let mut visitors: Vec<String> = fleets_at.remove(&pid).unwrap_or_default();
            visitors.sort();
            let defender = defender_of(snap, &owner);
            w.planets.insert(
                pid.clone(),
                PlanetState {
                    id: pid.clone(),
                    owner,
                    shield: attr("planetaryShield"),
                    raid_start: attr("blockStartRaid"),
                    mine_start: attr("blockStartOreMine"),
                    refine_start: attr("blockStartOreRefine"),
                    mining_active: attr("oreMiningActiveQuantity"),
                    refining_active: attr("oreRefiningActiveQuantity"),
                    buried_ore: snap.grid_attr(&pid, "ore"),
                    complete: planet_complete(row),
                    location_list_start: row.get("locationListStart").and_then(|v| v.as_str()).map(String::from),
                    visitors,
                    defender,
                },
            );
        }
        w
    }

    /// Owners and substations whose exact power inputs a forecast needs.
    pub fn power_targets(&self) -> (Vec<String>, Vec<String>) {
        let mut owners: Vec<String> = self.players.keys().cloned().collect();
        owners.sort();
        let mut subs: Vec<String> = self.players.values().map(|p| p.substation.clone()).filter(|s| !s.is_empty()).collect();
        subs.sort();
        subs.dedup();
        (owners, subs)
    }

    /// Fold the chain's power answers in.
    pub fn apply_power(&mut self, inputs: &super::power::Inputs) {
        for p in self.players.values_mut() {
            p.usable_primary = inputs.usable.get(&p.id).cloned();
            if !p.substation.is_empty() {
                p.substation_exists = inputs.substation_exists.get(&p.substation).copied();
            }
        }
    }

    /// Struct ids with no DESTROYED bit, sorted (stable output).
    pub fn live_structs(&self) -> Vec<&StructState> {
        let mut v: Vec<&StructState> = self.structs.values().filter(|s| !s.has(status::DESTROYED)).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }
}

/// The struct-type catalogue the app already holds, in the mirror's shape.
pub fn types_from_game_state(gs: &crate::game_state::GameStateSync) -> HashMap<String, TypeRules> {
    gs.struct_types
        .iter()
        .map(|(id, t)| {
            let mut charges = Vec::new();
            for (name, v) in [
                ("build", t.build_charge),
                ("activate", t.activate_charge),
                ("move", t.move_charge),
                ("defend", t.defend_change_charge),
                ("stealth", t.stealth_activate_charge),
            ] {
                if let Some(v) = v.filter(|v| *v > 0) {
                    charges.push((name, v));
                }
            }
            (
                id.clone(),
                TypeRules {
                    name: t.name.clone(),
                    build_difficulty: t.build_difficulty,
                    ore_mining_difficulty: t.ore_mining_difficulty,
                    ore_refining_difficulty: t.ore_refining_difficulty,
                    charges,
                    build_draw: t.build_draw,
                    passive_draw: t.passive_draw.filter(|d| *d >= 0.0).map(|d| d as u64),
                },
            )
        })
        .collect()
}

/// The catalogue from an LCD `/structs/struct_type` page (`{StructType: […]}`),
/// numbers as strings. The chain's live catalogue, never genesis (they differ).
pub fn types_from_lcd(page: &Value) -> HashMap<String, TypeRules> {
    let n = |t: &Value, k: &str| crate::mcp::types::numeric_u64(t.get(k)).unwrap_or(0);
    let rows = page.get("StructType").or_else(|| page.get("structType")).and_then(|v| v.as_array());
    rows.into_iter()
        .flatten()
        .map(|t| {
            let charges = [
                ("build", "buildCharge"),
                ("activate", "activateCharge"),
                ("move", "moveCharge"),
                ("defend", "defendChangeCharge"),
                ("stealth", "stealthActivateCharge"),
            ]
            .into_iter()
            .map(|(a, k)| (a, n(t, k)))
            .filter(|(_, v)| *v > 0)
            .collect();
            (
                s(t, "id"),
                TypeRules {
                    name: s(t, "type"),
                    build_difficulty: n(t, "buildDifficulty"),
                    ore_mining_difficulty: n(t, "oreMiningDifficulty"),
                    ore_refining_difficulty: n(t, "oreRefiningDifficulty"),
                    charges,
                    build_draw: crate::mcp::types::numeric_u64(t.get("buildDraw")),
                    passive_draw: crate::mcp::types::numeric_u64(t.get("passiveDraw")),
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Owner 1-1 with fleet 9-1 (Command Ship 5-9) and home planet 2-1.
    fn snap(fleet_status: &str, cmd_status: u64) -> Snapshot {
        let mut s = Snapshot::default();
        s.players.insert("1-1".into(), json!({"id":"1-1","fleetId":"9-1","planetId":"2-1","substationId":""}));
        s.planets.insert("2-1".into(), json!({"id":"2-1","owner":"1-1","status":"active","locationListStart":""}));
        s.fleets.insert(
            "9-1".into(),
            json!({"id":"9-1","owner":"1-1","status":fleet_status,"commandStruct":"5-9","locationType":"planet","locationId":"2-1"}),
        );
        s.structs.insert(
            "5-9".into(),
            crate::mcp::perception::StructRow { id: "5-9".into(), type_id: "1".into(), owner: "1-1".into(), location_type: "fleet".into(), location_id: "9-1".into(), ..Default::default() },
        );
        s.struct_attrs.insert("5-9".into(), [6, cmd_status, 0, 0, 0, 0, 0]);
        s.height = 10;
        s.min_height = 10;
        s
    }

    fn world(s: &Snapshot) -> World {
        World::from_snapshot(s, HashMap::new(), "test", Some(&["1-1".to_string()]))
    }

    const ONLINE: u64 = status::MATERIALIZED | status::BUILT | status::ONLINE;

    #[test]
    fn an_online_command_ship_on_station_defends() {
        let w = world(&snap("onStation", ONLINE));
        assert_eq!(w.planets["2-1"].defender.vulnerable, Some(false));
    }

    #[test]
    fn each_step_of_the_vulnerability_rule() {
        assert_eq!(world(&snap("away", ONLINE)).planets["2-1"].defender.vulnerable, Some(true), "fleet away");
        assert_eq!(world(&snap("onStation", status::MATERIALIZED | status::BUILT)).planets["2-1"].defender.vulnerable, Some(true), "offline");
        assert_eq!(world(&snap("onStation", ONLINE | status::DESTROYED)).planets["2-1"].defender.vulnerable, Some(true), "destroyed");
        let mut s = snap("onStation", ONLINE);
        s.fleets.get_mut("9-1").unwrap()["commandStruct"] = json!("");
        assert_eq!(world(&s).planets["2-1"].defender.vulnerable, Some(true), "no Command Ship");
        let mut s = snap("onStation", ONLINE);
        s.players.get_mut("1-1").unwrap()["fleetId"] = json!("");
        assert_eq!(world(&s).planets["2-1"].defender.vulnerable, Some(true), "no fleet");
    }

    #[test]
    fn a_row_missing_from_the_snapshot_is_unknown_not_vulnerable() {
        let mut s = snap("onStation", ONLINE);
        s.structs.remove("5-9");
        assert_eq!(world(&s).planets["2-1"].defender.vulnerable, None);
        let mut s = snap("onStation", ONLINE);
        s.fleets.remove("9-1");
        assert_eq!(world(&s).planets["2-1"].defender.vulnerable, None);
    }

    #[test]
    fn a_fleet_is_listed_only_away_from_its_owners_home() {
        let mut s = snap("onStation", ONLINE);
        // The owner's own fleet at home is not a visitor.
        assert!(world(&s).planets["2-1"].visitors.is_empty());
        // Another player's fleet at 2-1 is.
        s.players.insert("1-2".into(), json!({"id":"1-2","fleetId":"9-2","planetId":"2-2"}));
        s.fleets.insert("9-2".into(), json!({"id":"9-2","owner":"1-2","status":"away","locationType":"planet","locationId":"2-1"}));
        assert_eq!(world(&s).planets["2-1"].visitors, vec!["9-2".to_string()]);
    }

    #[test]
    fn the_list_pointer_and_planet_status_are_read_when_present() {
        let w = world(&snap("onStation", ONLINE));
        assert_eq!(w.planets["2-1"].location_list_start.as_deref(), Some(""));
        assert_eq!(w.planets["2-1"].complete, Some(false));
    }
}
