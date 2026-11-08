//! Multi-cycle projection: a player's planet run, played forward through the
//! chain's own transitions.
//!
//! From the pinned world, each rig's next completion is the first height its
//! proof is accepted at the aim difficulty (`rules::ready_height`); the
//! earliest one is applied with [`transition`], which restarts that clock and
//! moves the ore, and the loop repeats until the planet is dry and the pile
//! refined — the moment the player can explore — or something the chain
//! would refuse stops it.
//!
//! Assumptions, stated in every result: each proof is found and included the
//! moment it ripens at the aim (real runs are later by hashing and queue
//! time, never earlier); no other player acts on the planet; a raid's
//! clock pause is not modelled.

use serde::Serialize;

use super::rules;
use super::transition::{self, Refused, UALPHA_PER_REFINE};
use super::world::{PlanetState, World};
use crate::mcp::perception::status;

/// Upper bound on simulated completions per player (a planet holds a few ore).
const MAX_STEPS: usize = 512;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Projection {
    pub player: String,
    pub planet: String,
    /// Buried ore and stored ore at the start.
    pub buried_ore: u64,
    pub stored_ore: u64,
    pub mines: u64,
    pub refines: u64,
    pub ualpha: u64,
    /// Height of the mine that takes the planet's last ore.
    pub depleted_at: Option<u64>,
    /// Planet dry AND pile refined (or nothing to refine with): the player
    /// can explore without stranding ore.
    pub drained_at: Option<u64>,
    /// The chain would refuse the next step for this reason.
    pub stalled: Option<Refused>,
    pub aim: u64,
}

fn rig(world: &World, planet: &str, mining: bool) -> Option<(String, u64)> {
    let mut rigs: Vec<(String, u64)> = world
        .structs
        .values()
        .filter(|s| s.planet.as_deref() == Some(planet) && s.has(status::BUILT) && !s.has(status::DESTROYED))
        .filter_map(|s| {
            let t = world.types.get(&s.type_id)?;
            let range = if mining { t.ore_mining_difficulty } else { t.ore_refining_difficulty };
            (range > 0).then(|| (s.id.clone(), range))
        })
        .collect();
    rigs.sort();
    rigs.into_iter().next()
}

/// The next height this clock's work is accepted at `aim`, never before `exec`.
fn next_at(anchor: u64, range: u64, aim: u64, exec: u64) -> Option<u64> {
    if anchor == 0 {
        return None;
    }
    rules::ready_height(anchor, range, aim).map(|h| h.max(exec))
}

/// Project every player in `players` (each on its own home planet), in one
/// pass over the world: structs are grouped by owner once and each run works
/// on a small world of its own — the player, the planet, its rigs — so the
/// cost is linear in the team, not quadratic.
pub fn project_all(world: &World, tip: u64, players: &[String], aim: u64) -> Vec<Projection> {
    let mut by_owner: std::collections::HashMap<&str, Vec<&super::world::StructState>> = std::collections::HashMap::new();
    for s in world.structs.values() {
        by_owner.entry(s.owner.as_str()).or_default().push(s);
    }
    let mut out: Vec<Projection> = players
        .iter()
        .filter_map(|pid| {
            let mine = by_owner.get(pid.as_str())?;
            let planet = mine
                .iter()
                .find_map(|s| s.planet.as_ref().filter(|p| world.planets.get(*p).is_some_and(|pl: &PlanetState| pl.owner == *pid)))?;
            let mut small = World { types: world.types.clone(), ..World::default() };
            small.planets.insert(planet.clone(), world.planets.get(planet)?.clone());
            small.players.insert(pid.clone(), world.players.get(pid)?.clone());
            for s in mine.iter().filter(|s| s.planet.as_deref() == Some(planet.as_str())) {
                small.structs.insert(s.id.clone(), (*s).clone());
            }
            project(&small, tip, pid, aim)
        })
        .collect();
    out.sort_by_key(|p| (p.drained_at.unwrap_or(u64::MAX), p.player.clone()));
    out
}

/// Project `player`'s planet run from `world` as of committed tip `tip`.
/// Copies `world`: pass a small one (see [`project_all`]).
pub fn project(world: &World, tip: u64, player: &str, aim: u64) -> Option<Projection> {
    let planet_id = world
        .structs
        .values()
        .filter(|s| s.owner == player)
        .find_map(|s| s.planet.clone().filter(|p| world.planets.get(p).is_some_and(|pl: &PlanetState| pl.owner == player)))?;
    let mut w = world.clone();
    let p0 = w.planets.get(&planet_id)?.clone();
    let stored0 = w.players.get(player).and_then(|p| p.stored_ore).unwrap_or(0);
    let mut out = Projection {
        player: player.to_string(),
        planet: planet_id.clone(),
        buried_ore: p0.buried_ore.unwrap_or(0),
        stored_ore: stored0,
        mines: 0,
        refines: 0,
        ualpha: 0,
        depleted_at: (p0.buried_ore == Some(0)).then_some(rules::earliest_execution(tip)),
        drained_at: None,
        stalled: None,
        aim,
    };
    let miner = rig(&w, &planet_id, true);
    let refinery = rig(&w, &planet_id, false);
    let mut now = rules::earliest_execution(tip);
    for _ in 0..MAX_STEPS {
        let p = w.planets.get(&planet_id)?;
        let buried = p.buried_ore.unwrap_or(0);
        let stored = w.players.get(player).and_then(|x| x.stored_ore).unwrap_or(0);
        let mine_at = match &miner {
            Some((_, range)) if buried > 0 => next_at(p.mine_start, *range, aim, now),
            _ => None,
        };
        // A refine needs ore in the pile: with none, it waits for the next mine.
        let refine_at = match &refinery {
            Some((_, range)) if stored > 0 => next_at(p.refine_start, *range, aim, now),
            Some((_, range)) if mine_at.is_some() => next_at(p.refine_start, *range, aim, now).map(|h| h.max(mine_at.unwrap() + 1)),
            _ => None,
        };
        let step = match (mine_at, refine_at) {
            (None, None) => {
                if buried == 0 && (stored == 0 || refinery.is_none()) {
                    out.drained_at.get_or_insert(now);
                }
                break;
            }
            (Some(m), Some(r)) if r < m => (false, r),
            (Some(m), _) => (true, m),
            (None, Some(r)) => (false, r),
        };
        now = step.1;
        let res = if step.0 {
            transition::mine(&mut w, now, &miner.as_ref().unwrap().0)
        } else {
            transition::refine(&mut w, now, &refinery.as_ref().unwrap().0)
        };
        match res {
            Ok(_) if step.0 => {
                out.mines += 1;
                if w.planets.get(&planet_id).and_then(|p| p.buried_ore) == Some(0) {
                    out.depleted_at = Some(now);
                }
            }
            Ok(_) => {
                out.refines += 1;
                out.ualpha += UALPHA_PER_REFINE;
            }
            Err(r) => {
                out.stalled = Some(r);
                break;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::world::{PlayerState, StructState, TypeRules};

    const BUILT_ONLINE: u64 = status::MATERIALIZED | status::BUILT | status::ONLINE;

    fn world(buried: u64, with_refinery: bool) -> World {
        let mut w = World::default();
        w.types.insert("14".into(), TypeRules { ore_mining_difficulty: 125, ..Default::default() });
        w.types.insert("15".into(), TypeRules { ore_refining_difficulty: 125, ..Default::default() });
        w.players.insert(
            "1-1".into(),
            PlayerState { id: "1-1".into(), stored_ore: Some(0), load: Some(0), structs_load: Some(0), capacity: Some(10), capacity_secondary: Some(0), ..Default::default() },
        );
        w.planets.insert(
            "2-1".into(),
            PlanetState {
                id: "2-1".into(),
                owner: "1-1".into(),
                mine_start: 1_000,
                refine_start: 1_000,
                mining_active: 1,
                refining_active: u64::from(with_refinery),
                buried_ore: Some(buried),
                complete: Some(false),
                location_list_start: Some(String::new()),
                ..Default::default()
            },
        );
        w.structs.insert("5-1".into(), StructState { id: "5-1".into(), owner: "1-1".into(), type_id: "14".into(), status: BUILT_ONLINE, planet: Some("2-1".into()), ..Default::default() });
        if with_refinery {
            w.structs.insert("5-2".into(), StructState { id: "5-2".into(), owner: "1-1".into(), type_id: "15".into(), status: BUILT_ONLINE, planet: Some("2-1".into()), ..Default::default() });
        }
        w
    }

    #[test]
    fn a_miner_alone_drains_the_planet_one_cycle_per_ore() {
        // Range 125 at aim 1: ripe at age 125.
        let p = project(&world(3, false), 1_000, "1-1", 1).unwrap();
        assert_eq!((p.mines, p.refines), (3, 0));
        assert_eq!(p.depleted_at, Some(1_000 + 3 * 125));
        assert_eq!(p.drained_at, Some(1_375), "no refinery: dry is drained");
    }

    #[test]
    fn a_refinery_turns_every_mined_ore_into_alpha_before_explore() {
        let p = project(&world(3, true), 1_000, "1-1", 1).unwrap();
        assert_eq!((p.mines, p.refines, p.ualpha), (3, 3, 3_000_000));
        assert_eq!(p.depleted_at, Some(1_375));
        // The last ore can be refined in the very block it was mined.
        assert!(p.drained_at.unwrap() >= p.depleted_at.unwrap(), "the last ore is refined no earlier than the last mine");
    }

    #[test]
    fn an_empty_planet_with_an_empty_pile_is_drained_now() {
        let p = project(&world(0, true), 1_000, "1-1", 1).unwrap();
        assert_eq!((p.mines, p.refines), (0, 0));
        assert_eq!(p.drained_at, Some(1_001));
    }

    #[test]
    fn an_offline_owner_stalls_the_run() {
        let mut w = world(3, false);
        w.players.get_mut("1-1").unwrap().load = Some(50);
        let p = project(&w, 1_000, "1-1", 1).unwrap();
        assert_eq!(p.stalled.map(|r| r.rule), Some("player_offline"));
        assert_eq!(p.mines, 0);
    }
}
