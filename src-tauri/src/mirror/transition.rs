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
}
