//! State transitions: what the chain does to the world when an action lands.
//!
//! Each function applies one message's effects to a [`World`] at the height
//! it executes, after checking the preconditions the chain checks. A refusal
//! carries the chain's rule name. Effects are the keeper's own, cited:
//!
//! * mine (`StructCache.OreMinePlanet`): owner stored ore +1, planet buried
//!   ore −1, planet mine clock := height;
//! * refine (`StructCache.OreRefine`): stored ore −1, 1,000,000 ualpha minted
//!   to the owner's vault (`DepositRefinedAlpha`), planet refine clock :=
//!   height;
//! * build complete (msg_server_struct_build_complete.go + `GoOnline`):
//!   structsLoad −buildDraw +passiveDraw, status +built +online, and the
//!   planet's mining/refining quantity +1 — re-anchoring that clock only when
//!   it was the first rig (`OreMiningActivate`, `OreRefiningActivate`);
//! * any discharging message (`PlayerCache.Discharge`): lastAction := height.
//!
//! Not modelled, and named in [`Applied::unmodelled`] where they apply: a
//! build's planetary shield and defense contributions, and the ore-clock
//! shift when a raid ends (`shiftOreClockForRaid`).

use serde::Serialize;

use super::forecast::{self, CheckState};
use super::world::World;
use crate::mcp::perception::status;

/// Alpha minted per refine, in ualpha (player_cache.go `DepositRefinedAlpha`).
pub const UALPHA_PER_REFINE: u64 = 1_000_000;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "effect", rename_all = "snake_case")]
pub enum Effect {
    StoredOre { player: String, delta: i64, after: u64 },
    BuriedOre { planet: String, delta: i64, after: u64 },
    AlphaMinted { player: String, ualpha: u64 },
    MineClock { planet: String, height: u64 },
    RefineClock { planet: String, height: u64 },
    StructsLoad { player: String, after: u64 },
    Status { structure: String, after: u64 },
    MiningActive { planet: String, after: u64 },
    RefiningActive { planet: String, after: u64 },
    LastAction { player: String, height: u64 },
    FleetLocation { fleet: String, planet: String, on_station: bool },
    /// The planet's visitor list now starts with this fleet ("" = empty).
    ListStart { planet: String, fleet: String },
    /// The planet's raid clock (`blockStartRaid`); 0 = cleared.
    RaidClock { planet: String, height: u64 },
    RaiderArrived { planet: String, height: u64 },
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Applied {
    pub effects: Vec<Effect>,
    /// Chain effects of this message the world does not track.
    pub unmodelled: Vec<&'static str>,
}

/// The chain refused the transition: its rule name and why.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Refused {
    pub rule: &'static str,
    pub detail: String,
}

fn refused(rule: &'static str, detail: impl Into<String>) -> Refused {
    Refused { rule, detail: detail.into() }
}

/// The first precondition the chain would refuse on, among `checks`. Only
/// exact blocks count: an estimate never refuses a transition.
fn first_block(checks: &[forecast::Check]) -> Option<Refused> {
    checks
        .iter()
        .find(|c| c.state == CheckState::Blocked && c.exact)
        .map(|c| refused(c.rule, c.detail.clone()))
}

/// `MsgStructOreMinerComplete` for `struct_id` at `height`, assuming a valid
/// proof.
pub fn mine(world: &mut World, height: u64, struct_id: &str) -> Result<Applied, Refused> {
    let s = world.structs.get(struct_id).ok_or_else(|| refused("not_found", format!("{struct_id} not in the world")))?.clone();
    let pid = s.planet.clone().ok_or_else(|| refused("not_found", format!("{struct_id} is not on a planet")))?;
    let p = world.planets.get(&pid).ok_or_else(|| refused("not_found", format!("planet {pid} not in the world")))?;
    let mut checks = forecast::readiness(&s, world.players.get(&s.owner));
    checks.push(forecast::mining_active(p));
    checks.push(forecast::not_under_raid(p));
    checks.push(forecast::Check::known_pub("complete", p.complete.map(|c| !c), "planet status"));
    checks.push(forecast::Check::known_pub("empty", p.buried_ore.map(|o| o > 0), format!("buried ore {:?}", p.buried_ore)));
    if let Some(r) = first_block(&checks) {
        return Err(r);
    }
    let buried = p.buried_ore.unwrap_or(0).saturating_sub(1);
    let planet = world.planets.get_mut(&pid).expect("checked above");
    planet.buried_ore = Some(buried);
    planet.mine_start = height;
    let owner = world.players.get_mut(&s.owner).ok_or_else(|| refused("not_found", format!("owner {} not in the world", s.owner)))?;
    let stored = owner.stored_ore.unwrap_or(0) + 1;
    owner.stored_ore = Some(stored);
    Ok(Applied {
        effects: vec![
            Effect::StoredOre { player: s.owner.clone(), delta: 1, after: stored },
            Effect::BuriedOre { planet: pid.clone(), delta: -1, after: buried },
            Effect::MineClock { planet: pid, height },
        ],
        unmodelled: vec![],
    })
}

/// `MsgStructOreRefineryComplete` for `struct_id` at `height`, assuming a
/// valid proof.
pub fn refine(world: &mut World, height: u64, struct_id: &str) -> Result<Applied, Refused> {
    let s = world.structs.get(struct_id).ok_or_else(|| refused("not_found", format!("{struct_id} not in the world")))?.clone();
    let pid = s.planet.clone().ok_or_else(|| refused("not_found", format!("{struct_id} is not on a planet")))?;
    let p = world.planets.get(&pid).ok_or_else(|| refused("not_found", format!("planet {pid} not in the world")))?;
    let owner = world.players.get(&s.owner);
    let mut checks = forecast::readiness(&s, owner);
    checks.push(forecast::refining_active(p));
    checks.push(forecast::not_under_raid(p));
    checks.push(forecast::stored_ore(owner));
    if let Some(r) = first_block(&checks) {
        return Err(r);
    }
    world.planets.get_mut(&pid).expect("checked above").refine_start = height;
    let owner = world.players.get_mut(&s.owner).ok_or_else(|| refused("not_found", format!("owner {} not in the world", s.owner)))?;
    let stored = owner.stored_ore.unwrap_or(0).saturating_sub(1);
    owner.stored_ore = Some(stored);
    Ok(Applied {
        effects: vec![
            Effect::StoredOre { player: s.owner.clone(), delta: -1, after: stored },
            Effect::AlphaMinted { player: s.owner.clone(), ualpha: UALPHA_PER_REFINE },
            Effect::RefineClock { planet: pid, height },
        ],
        unmodelled: vec![],
    })
}

/// `MsgStructBuildComplete` for `struct_id` at `height`, assuming a valid
/// proof.
pub fn build_complete(world: &mut World, height: u64, struct_id: &str) -> Result<Applied, Refused> {
    let s = world.structs.get(struct_id).ok_or_else(|| refused("not_found", format!("{struct_id} not in the world")))?.clone();
    if s.has(status::DESTROYED) {
        return Err(refused("destroyed", format!("{struct_id} is destroyed")));
    }
    if s.has(status::BUILT) {
        return Err(refused("already_built", format!("{struct_id} is already built")));
    }
    let t = world.types.get(&s.type_id).ok_or_else(|| refused("not_found", format!("type {} not in the catalogue", s.type_id)))?.clone();
    if let Some(r) = first_block(&[forecast::build_headroom(world.players.get(&s.owner), t.build_draw, t.passive_draw)]) {
        return Err(r);
    }
    let mut out = Applied { effects: Vec::new(), unmodelled: vec!["planetary shield contribution", "planetary defense quantities"] };
    if let Some(owner) = world.players.get_mut(&s.owner) {
        if let (Some(load), Some(bd), Some(pd)) = (owner.structs_load, t.build_draw, t.passive_draw) {
            let after = load.saturating_sub(bd) + pd;
            owner.structs_load = Some(after);
            out.effects.push(Effect::StructsLoad { player: s.owner.clone(), after });
        }
    }
    let new_status = s.status | status::BUILT | status::ONLINE;
    world.structs.get_mut(struct_id).expect("present").status = new_status;
    out.effects.push(Effect::Status { structure: struct_id.to_string(), after: new_status });
    if let Some(p) = s.planet.as_ref().and_then(|p| world.planets.get_mut(p)) {
        // A mining/refining system: the type carries a difficulty range for it.
        if t.ore_mining_difficulty > 0 {
            if p.mining_active == 0 {
                p.mine_start = height;
                out.effects.push(Effect::MineClock { planet: p.id.clone(), height });
            }
            p.mining_active += 1;
            out.effects.push(Effect::MiningActive { planet: p.id.clone(), after: p.mining_active });
        }
        if t.ore_refining_difficulty > 0 {
            if p.refining_active == 0 {
                p.refine_start = height;
                out.effects.push(Effect::RefineClock { planet: p.id.clone(), height });
            }
            p.refining_active += 1;
            out.effects.push(Effect::RefiningActive { planet: p.id.clone(), after: p.refining_active });
        }
    }
    Ok(out)
}

/// `shiftOreClockForRaid` (planet_cache.go): an ore clock advances past the
/// window a raid held it paused — from the later of the clock and the raider's
/// arrival to the raid's end. A clock at or past the end is untouched.
pub fn shift_ore_clock_for_raid(clock: u64, raider_arrived: u64, raid_end: u64) -> u64 {
    let pause_start = clock.max(raider_arrived);
    if pause_start >= raid_end {
        clock
    } else {
        clock + (raid_end - pause_start)
    }
}

/// `SetLocationListStart` on `planet` at `height`.
fn set_list_start(p: &mut super::world::PlanetState, height: u64, fleet: &str, out: &mut Applied) {
    let previous = p.location_list_start.clone().unwrap_or_default();
    p.location_list_start = Some(fleet.to_string());
    out.effects.push(Effect::ListStart { planet: p.id.clone(), fleet: fleet.to_string() });
    if fleet.is_empty() {
        // `PauseOreClocksForRaid`, then clear the raid's clocks.
        if p.raider_arrived != 0 {
            if p.mining_active != 0 {
                p.mine_start = shift_ore_clock_for_raid(p.mine_start, p.raider_arrived, height);
                out.effects.push(Effect::MineClock { planet: p.id.clone(), height: p.mine_start });
            }
            if p.refining_active != 0 {
                p.refine_start = shift_ore_clock_for_raid(p.refine_start, p.raider_arrived, height);
                out.effects.push(Effect::RefineClock { planet: p.id.clone(), height: p.refine_start });
            }
        }
        p.raider_arrived = 0;
        p.raid_start = 0;
        out.effects.push(Effect::RaiderArrived { planet: p.id.clone(), height: 0 });
        out.effects.push(Effect::RaidClock { planet: p.id.clone(), height: 0 });
        return;
    }
    if previous.is_empty() {
        p.raider_arrived = height;
        out.effects.push(Effect::RaiderArrived { planet: p.id.clone(), height });
    }
    if p.complete == Some(true) {
        p.raid_start = 0;
        out.effects.push(Effect::RaidClock { planet: p.id.clone(), height: 0 });
        return;
    }
    match p.defender.vulnerable {
        Some(true) => {
            if previous.is_empty() || p.raid_start == 0 {
                p.raid_start = height;
                out.effects.push(Effect::RaidClock { planet: p.id.clone(), height });
            }
        }
        Some(false) => {
            p.raid_start = 0;
            out.effects.push(Effect::RaidClock { planet: p.id.clone(), height: 0 });
        }
        None => out.unmodelled.push("raid clock: the defender's vulnerability is not known"),
    }
}

/// `MsgFleetMove` of `fleet_id` to `dest` at `height` (msg_server_fleet_move.go
/// + `FleetCache.SetLocationToPlanet`). The fleet, the planet it leaves and
/// the destination must be in the world; visiting fleets of other players are
/// handled through the list pointers the planets and fleets carry.
pub fn fleet_move(world: &mut World, height: u64, fleet_id: &str, dest: &str) -> Result<Applied, Refused> {
    let f = world.fleets.get(fleet_id).ok_or_else(|| refused("not_found", format!("fleet {fleet_id} not in the world")))?.clone();
    let d = world.planets.get(dest).ok_or_else(|| refused("not_found", format!("planet {dest} not in the world")))?;
    if d.complete == Some(true) {
        return Err(refused("not_active", format!("planet {dest} is complete")));
    }
    let mut out = Applied::default();
    if f.planet.as_deref() == Some(dest) {
        return Ok(out);
    }
    // `PlanetMoveReadinessCheck`: owner online, a Command Ship, and it online.
    if let Some(r) = first_block(&[forecast::owner_power(world.players.get(&f.owner))]) {
        return Err(r);
    }
    if f.command_struct.is_empty() {
        return Err(refused("no_command_struct", format!("fleet {fleet_id} has no Command Ship")));
    }
    match world.structs.get(&f.command_struct) {
        Some(c) if !c.has(status::ONLINE) => return Err(refused("command_offline", format!("Command Ship {} is offline", c.id))),
        Some(_) => {}
        None => out.unmodelled.push("Command Ship state not in the world"),
    }
    let home = world.players.get(&f.owner).map(|p| p.home_planet.clone()).unwrap_or_default();
    // A visit queues behind the planet's visitor capacity (1 + extra).
    if dest != home {
        match (d.location_list_count, d.location_list_extra) {
            (Some(count), Some(extra)) if count >= 1 + extra => {
                return Err(refused("queue_full", format!("planet {dest} holds {count} visitors, capacity {}", 1 + extra)));
            }
            (Some(_), Some(_)) => {}
            _ => out.unmodelled.push("visitor queue capacity not known"),
        }
    }

    // ── Leave the previous planet's visitor list (it was not home). ──
    if let Some(prev_id) = f.planet.clone().filter(|p| *p != home) {
        let (fwd, back) = (f.forward.clone(), f.backward.clone());
        if let Some(prev) = world.planets.get_mut(&prev_id) {
            prev.visitors.retain(|v| v != fleet_id);
            prev.location_list_count = prev.location_list_count.map(|c| c.saturating_sub(1));
            if fwd.is_empty() {
                if back.is_empty() {
                    prev.location_list_end = Some(String::new());
                }
                set_list_start(prev, height, &back, &mut out);
            } else if back.is_empty() {
                prev.location_list_end = Some(fwd.clone());
            }
        } else {
            out.unmodelled.push("the planet the fleet leaves is not in the world");
        }
        match (fwd.is_empty(), back.is_empty()) {
            (true, false) => {
                if let Some(b) = world.fleets.get_mut(&back) {
                    b.forward.clear();
                }
            }
            (false, true) => {
                if let Some(x) = world.fleets.get_mut(&fwd) {
                    x.backward.clear();
                }
            }
            (false, false) => {
                if let Some(x) = world.fleets.get_mut(&fwd) {
                    x.backward = back.clone();
                }
                if let Some(b) = world.fleets.get_mut(&back) {
                    b.forward = fwd.clone();
                }
            }
            (true, true) => {}
        }
    }

    // ── Arrive. ──
    let on_station = dest == home;
    {
        let fl = world.fleets.get_mut(fleet_id).expect("present");
        fl.forward.clear();
        fl.backward.clear();
        fl.planet = Some(dest.to_string());
        fl.on_station = Some(on_station);
    }
    if !on_station {
        let d = world.planets.get_mut(dest).expect("checked above");
        let start = d.location_list_start.clone().unwrap_or_default();
        if start.is_empty() {
            set_list_start(d, height, fleet_id, &mut out);
        } else {
            let last = d.location_list_end.clone().unwrap_or_default();
            if let Some(fl) = world.fleets.get_mut(fleet_id) {
                fl.forward = last.clone();
            }
            if let Some(l) = world.fleets.get_mut(&last) {
                l.backward = fleet_id.to_string();
            }
        }
        let d = world.planets.get_mut(dest).expect("checked above");
        d.location_list_end = Some(fleet_id.to_string());
        d.location_list_count = d.location_list_count.map(|c| c + 1);
        d.visitors.push(fleet_id.to_string());
        d.visitors.sort();
    }
    out.effects.push(Effect::FleetLocation { fleet: fleet_id.to_string(), planet: dest.to_string(), on_station });

    // ── The Command Ship travels with the fleet: refresh the home planet's
    //    defense and any raid there (`RefreshRaidVulnerability`). ──
    let cmd_online = world.structs.get(&f.command_struct).map(|c| c.has(status::ONLINE) && !c.has(status::DESTROYED));
    if let Some(h) = world.planets.get_mut(&home) {
        h.defender = match (on_station, cmd_online) {
            (false, _) => super::world::Defender { vulnerable: Some(true), reason: format!("fleet {fleet_id} is away") },
            (true, Some(true)) => super::world::Defender { vulnerable: Some(false), reason: format!("Command Ship {} online on station", f.command_struct) },
            (true, Some(false)) => super::world::Defender { vulnerable: Some(true), reason: format!("Command Ship {} offline", f.command_struct) },
            (true, None) => super::world::Defender { vulnerable: None, reason: "Command Ship state not in the world".into() },
        };
        if h.location_list_start.as_deref().is_some_and(|s| !s.is_empty()) {
            match h.defender.vulnerable {
                Some(true) if h.raid_start == 0 => {
                    h.raid_start = height;
                    out.effects.push(Effect::RaidClock { planet: h.id.clone(), height });
                }
                Some(false) if h.raid_start != 0 => {
                    h.raid_start = 0;
                    out.effects.push(Effect::RaidClock { planet: h.id.clone(), height: 0 });
                }
                _ => {}
            }
        }
    }
    Ok(out)
}

/// A discharging message landed for `player` at `height`.
pub fn discharge(world: &mut World, height: u64, player: &str) -> Applied {
    if let Some(p) = world.players.get_mut(player) {
        p.last_action = Some(height);
    }
    Applied { effects: vec![Effect::LastAction { player: player.to_string(), height }], unmodelled: vec![] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::world::{PlanetState, PlayerState, StructState, TypeRules};

    const BUILT_ONLINE: u64 = status::MATERIALIZED | status::BUILT | status::ONLINE;

    fn world() -> World {
        let mut w = World::default();
        w.types.insert("14".into(), TypeRules { name: "Ore Extractor".into(), ore_mining_difficulty: 14_000, build_draw: Some(10), passive_draw: Some(20), ..Default::default() });
        w.types.insert("15".into(), TypeRules { name: "Ore Refinery".into(), ore_refining_difficulty: 28_000, build_draw: Some(10), passive_draw: Some(30), ..Default::default() });
        w.players.insert(
            "1-1".into(),
            PlayerState { id: "1-1".into(), stored_ore: Some(0), load: Some(0), structs_load: Some(10), capacity: Some(100), capacity_secondary: Some(0), ..Default::default() },
        );
        w.planets.insert(
            "2-1".into(),
            PlanetState { id: "2-1".into(), owner: "1-1".into(), mine_start: 500, refine_start: 600, mining_active: 1, refining_active: 1, buried_ore: Some(2), complete: Some(false), location_list_start: Some(String::new()), ..Default::default() },
        );
        w.structs.insert("5-1".into(), StructState { id: "5-1".into(), owner: "1-1".into(), type_id: "14".into(), status: BUILT_ONLINE, planet: Some("2-1".into()), ..Default::default() });
        w.structs.insert("5-2".into(), StructState { id: "5-2".into(), owner: "1-1".into(), type_id: "15".into(), status: BUILT_ONLINE, planet: Some("2-1".into()), ..Default::default() });
        w
    }

    #[test]
    fn mining_moves_one_ore_and_restarts_the_planet_clock() {
        let mut w = world();
        let a = mine(&mut w, 20_000, "5-1").unwrap();
        assert_eq!(w.planets["2-1"].buried_ore, Some(1));
        assert_eq!(w.planets["2-1"].mine_start, 20_000);
        assert_eq!(w.players["1-1"].stored_ore, Some(1));
        assert!(a.effects.contains(&Effect::MineClock { planet: "2-1".into(), height: 20_000 }));
    }

    #[test]
    fn an_empty_planet_refuses_mining() {
        let mut w = world();
        mine(&mut w, 20_000, "5-1").unwrap();
        mine(&mut w, 40_000, "5-1").unwrap();
        assert_eq!(mine(&mut w, 60_000, "5-1").unwrap_err().rule, "empty");
    }

    #[test]
    fn refining_needs_stored_ore_and_mints_one_alpha() {
        let mut w = world();
        assert_eq!(refine(&mut w, 30_000, "5-2").unwrap_err().rule, "ore");
        mine(&mut w, 20_000, "5-1").unwrap();
        let a = refine(&mut w, 30_000, "5-2").unwrap();
        assert_eq!(w.players["1-1"].stored_ore, Some(0));
        assert_eq!(w.planets["2-1"].refine_start, 30_000);
        assert!(a.effects.contains(&Effect::AlphaMinted { player: "1-1".into(), ualpha: 1_000_000 }));
    }

    #[test]
    fn completing_the_first_rig_starts_the_planets_clock() {
        let mut w = world();
        let p = w.planets.get_mut("2-1").unwrap();
        p.mining_active = 0;
        p.mine_start = 0;
        w.structs.get_mut("5-1").unwrap().status = status::MATERIALIZED;
        let a = build_complete(&mut w, 7_000, "5-1").unwrap();
        assert_eq!(w.planets["2-1"].mine_start, 7_000);
        assert_eq!(w.planets["2-1"].mining_active, 1);
        assert_eq!(w.players["1-1"].structs_load, Some(10 - 10 + 20));
        assert_eq!(w.structs["5-1"].status, BUILT_ONLINE);
        assert!(!a.unmodelled.is_empty());
    }

    #[test]
    fn a_second_rig_leaves_the_running_clock_alone() {
        let mut w = world();
        w.structs.insert("5-3".into(), StructState { id: "5-3".into(), owner: "1-1".into(), type_id: "14".into(), status: status::MATERIALIZED, planet: Some("2-1".into()), ..Default::default() });
        build_complete(&mut w, 7_000, "5-3").unwrap();
        assert_eq!(w.planets["2-1"].mine_start, 500);
        assert_eq!(w.planets["2-1"].mining_active, 2);
    }

    #[test]
    fn a_completion_the_power_cannot_carry_is_refused() {
        let mut w = world();
        w.types.get_mut("14").unwrap().passive_draw = Some(200);
        w.structs.get_mut("5-1").unwrap().status = status::MATERIALIZED;
        assert_eq!(build_complete(&mut w, 7_000, "5-1").unwrap_err().rule, "capacity_exceeded");
    }

    #[test]
    fn a_discharge_resets_charge_to_zero() {
        let mut w = world();
        discharge(&mut w, 9_000, "1-1");
        assert_eq!(crate::mirror::rules::charge(9_000, w.players["1-1"].last_action.unwrap()), 0);
    }

    fn fleets_world() -> World {
        use crate::mirror::world::{Defender, FleetState};
        let mut w = world();
        // 1-1 at home on 2-1 with Command Ship 5-9; 2-2 belongs to 1-2, whose
        // Command Ship is down; 1-3 lives on 2-3.
        w.players.get_mut("1-1").unwrap().home_planet = "2-1".into();
        for (pid, home) in [("1-2", "2-2"), ("1-3", "2-3")] {
            w.players.insert(pid.into(), PlayerState { id: pid.into(), home_planet: home.into(), load: Some(0), structs_load: Some(0), capacity: Some(10), capacity_secondary: Some(0), ..Default::default() });
        }
        w.structs.insert("5-9".into(), StructState { id: "5-9".into(), owner: "1-1".into(), type_id: "14".into(), status: BUILT_ONLINE, ..Default::default() });
        w.structs.insert("5-8".into(), StructState { id: "5-8".into(), owner: "1-3".into(), type_id: "14".into(), status: BUILT_ONLINE, ..Default::default() });
        w.planets.get_mut("2-1").unwrap().defender = Defender { vulnerable: Some(false), reason: "on station".into() };
        w.planets.insert(
            "2-2".into(),
            PlanetState {
                id: "2-2".into(),
                owner: "1-2".into(),
                mine_start: 100,
                mining_active: 1,
                complete: Some(false),
                location_list_start: Some(String::new()),
                location_list_end: Some(String::new()),
                location_list_count: Some(0),
                location_list_extra: Some(1),
                defender: Defender { vulnerable: Some(true), reason: "Command Ship offline".into() },
                ..Default::default()
            },
        );
        w.planets.insert("2-3".into(), PlanetState { id: "2-3".into(), owner: "1-3".into(), complete: Some(false), location_list_start: Some(String::new()), ..Default::default() });
        w.fleets.insert("9-1".into(), FleetState { id: "9-1".into(), owner: "1-1".into(), planet: Some("2-1".into()), on_station: Some(true), command_struct: "5-9".into(), ..Default::default() });
        w.fleets.insert("9-3".into(), FleetState { id: "9-3".into(), owner: "1-3".into(), planet: Some("2-3".into()), on_station: Some(true), command_struct: "5-8".into(), ..Default::default() });
        w
    }

    #[test]
    fn arriving_first_starts_the_raid_and_leaves_home_open() {
        let mut w = fleets_world();
        fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap();
        let p = &w.planets["2-2"];
        assert_eq!((p.location_list_start.as_deref(), p.raider_arrived, p.raid_start), (Some("9-1"), 1_000, 1_000));
        assert_eq!(w.fleets["9-1"].on_station, Some(false));
        assert_eq!(w.planets["2-1"].defender.vulnerable, Some(true), "the Command Ship left home");
    }

    #[test]
    fn a_second_visitor_queues_behind_the_first_and_is_promoted_when_it_leaves() {
        let mut w = fleets_world();
        fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap();
        fleet_move(&mut w, 1_010, "9-3", "2-2").unwrap();
        assert_eq!(w.planets["2-2"].location_list_end.as_deref(), Some("9-3"));
        assert_eq!((w.fleets["9-3"].forward.as_str(), w.fleets["9-1"].backward.as_str()), ("9-1", "9-3"));
        assert_eq!(w.planets["2-2"].location_list_count, Some(2));
        // 9-1 goes home: 9-3 heads the list; the raid's arrival stands.
        fleet_move(&mut w, 1_050, "9-1", "2-1").unwrap();
        let p = &w.planets["2-2"];
        assert_eq!((p.location_list_start.as_deref(), p.raider_arrived, p.raid_start), (Some("9-3"), 1_000, 1_000));
        assert_eq!(w.fleets["9-3"].forward, "");
        assert_eq!(w.fleets["9-1"].on_station, Some(true));
        assert_eq!(w.planets["2-1"].defender.vulnerable, Some(false), "home again, Command Ship online");
    }

    #[test]
    fn the_last_visitor_leaving_ends_the_raid_and_shifts_the_ore_clock() {
        let mut w = fleets_world();
        fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap();
        let a = fleet_move(&mut w, 1_300, "9-1", "2-1").unwrap();
        let p = &w.planets["2-2"];
        assert_eq!((p.location_list_start.as_deref(), p.raider_arrived, p.raid_start), (Some(""), 0, 0));
        // Clock 100 paused from the raider's arrival (1000) to the end (1300).
        assert_eq!(p.mine_start, 400);
        assert!(a.effects.contains(&Effect::MineClock { planet: "2-2".into(), height: 400 }));
    }

    #[test]
    fn the_ore_clock_shift_is_the_chains() {
        assert_eq!(shift_ore_clock_for_raid(100, 1_000, 1_300), 400, "paused from arrival");
        assert_eq!(shift_ore_clock_for_raid(1_100, 1_000, 1_300), 1_300, "anchored mid-raid lands at age zero");
        assert_eq!(shift_ore_clock_for_raid(1_400, 1_000, 1_300), 1_400, "past the end: untouched");
    }

    #[test]
    fn moves_the_chain_refuses_are_refused() {
        let mut w = fleets_world();
        w.planets.get_mut("2-2").unwrap().complete = Some(true);
        assert_eq!(fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap_err().rule, "not_active");
        let mut w = fleets_world();
        w.structs.get_mut("5-9").unwrap().status = status::MATERIALIZED | status::BUILT;
        assert_eq!(fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap_err().rule, "command_offline");
        let mut w = fleets_world();
        let p = w.planets.get_mut("2-2").unwrap();
        p.location_list_count = Some(2);
        p.location_list_extra = Some(1);
        assert_eq!(fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap_err().rule, "queue_full");
    }

    #[test]
    fn an_unknown_queue_is_named_not_guessed() {
        let mut w = fleets_world();
        w.planets.get_mut("2-2").unwrap().location_list_count = None;
        let a = fleet_move(&mut w, 1_000, "9-1", "2-2").unwrap();
        assert!(a.unmodelled.contains(&"visitor queue capacity not known"));
    }
}
