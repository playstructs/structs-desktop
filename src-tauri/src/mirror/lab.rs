//! Design lab: the economy played forward under alternative rules.
//!
//! A scenario overrides parts of the rule set — the mining or refining
//! difficulty range of the rig types, and the aim (the difficulty proofs are
//! completed at) — and every player's planet run is projected under it with
//! the same transitions the mirror uses for the live chain
//! ([`super::project`]). Scenarios are compared on what players would get
//! and when: mines, refines, alpha, and how long until a planet is dry and
//! the player can explore.
//!
//! This measures the MECHANICAL effect of a rule change on the world as it
//! stands — it assumes players keep playing as they do (each proof completed
//! the moment it ripens at the aim) and does not model how they would adapt.

use serde::{Deserialize, Serialize};

use super::project::{project_all, Projection};
use super::world::World;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Scenario {
    pub name: String,
    /// Replace every mining rig type's difficulty range.
    #[serde(default)]
    pub mine_range: Option<u64>,
    /// Replace every refining rig type's difficulty range.
    #[serde(default)]
    pub refine_range: Option<u64>,
    /// The difficulty proofs are completed at.
    pub aim: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Outcome {
    pub scenario: Scenario,
    pub players: usize,
    pub mines: u64,
    pub refines: u64,
    pub ualpha: u64,
    /// Players whose run ends in a drained planet (explore-ready) and the
    /// blocks until then: median and 90th percentile.
    pub drained: usize,
    pub median_drained_blocks: Option<u64>,
    pub p90_drained_blocks: Option<u64>,
    /// Runs the chain would stop part-way (offline owner, …).
    pub stalled: usize,
}

fn percentile(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    Some(sorted[i])
}

/// Summarise projections run from tip `tip`. Pure.
pub fn summarise(scenario: &Scenario, runs: &[Projection], tip: u64) -> Outcome {
    let exec = super::rules::earliest_execution(tip);
    let mut drained: Vec<u64> = runs.iter().filter_map(|p| p.drained_at).map(|h| h.saturating_sub(exec)).collect();
    drained.sort_unstable();
    Outcome {
        scenario: scenario.clone(),
        players: runs.len(),
        mines: runs.iter().map(|p| p.mines).sum(),
        refines: runs.iter().map(|p| p.refines).sum(),
        ualpha: runs.iter().map(|p| p.ualpha).sum(),
        drained: drained.len(),
        median_drained_blocks: percentile(&drained, 0.5),
        p90_drained_blocks: percentile(&drained, 0.9),
        stalled: runs.iter().filter(|p| p.stalled.is_some()).count(),
    }
}

/// `world` with `scenario`'s rule overrides applied to the type catalogue.
/// Pure.
pub fn with_rules(world: &World, scenario: &Scenario) -> World {
    let mut w = world.clone();
    for t in w.types.values_mut() {
        if let Some(r) = scenario.mine_range.filter(|_| t.ore_mining_difficulty > 0) {
            t.ore_mining_difficulty = r;
        }
        if let Some(r) = scenario.refine_range.filter(|_| t.ore_refining_difficulty > 0) {
            t.ore_refining_difficulty = r;
        }
    }
    w
}

/// Every scenario over `players`. Pure.
pub fn run(world: &World, tip: u64, players: &[String], scenarios: &[Scenario]) -> Vec<Outcome> {
    scenarios
        .iter()
        .map(|s| {
            let w = with_rules(world, s);
            summarise(s, &project_all(&w, tip, players, s.aim), tip)
        })
        .collect()
}

/// The scenarios run when none are given: the live rules, then each range
/// halved, then a stricter and a looser aim.
pub fn default_scenarios(world: &World, aim: u64) -> Vec<Scenario> {
    let mine = world.types.values().map(|t| t.ore_mining_difficulty).filter(|r| *r > 0).max();
    let refine = world.types.values().map(|t| t.ore_refining_difficulty).filter(|r| *r > 0).max();
    let mut v = vec![Scenario { name: "live rules".into(), mine_range: None, refine_range: None, aim }];
    if let Some(r) = refine {
        v.push(Scenario { name: format!("refine range {} → {}", r, r / 2), mine_range: None, refine_range: Some(r / 2), aim });
    }
    if let Some(r) = mine {
        v.push(Scenario { name: format!("mine range {} → {}", r, r / 2), mine_range: Some(r / 2), refine_range: None, aim });
    }
    v.push(Scenario { name: format!("aim {} → {}", aim, (aim / 2).max(1)), mine_range: None, refine_range: None, aim: (aim / 2).max(1) });
    v.push(Scenario { name: format!("aim {} → {}", aim, (aim * 2).min(64)), mine_range: None, refine_range: None, aim: (aim * 2).min(64) });
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::perception::status;
    use crate::mirror::world::{PlanetState, PlayerState, StructState, TypeRules};

    fn world() -> World {
        let mut w = World::default();
        w.types.insert("14".into(), TypeRules { ore_mining_difficulty: 1_000, ..Default::default() });
        w.types.insert("15".into(), TypeRules { ore_refining_difficulty: 2_000, ..Default::default() });
        for i in 1..=3 {
            let (pid, planet) = (format!("1-{i}"), format!("2-{i}"));
            w.players.insert(pid.clone(), PlayerState { id: pid.clone(), stored_ore: Some(0), load: Some(0), structs_load: Some(0), capacity: Some(10), capacity_secondary: Some(0), ..Default::default() });
            w.planets.insert(
                planet.clone(),
                PlanetState { id: planet.clone(), owner: pid.clone(), mine_start: 100, refine_start: 100, mining_active: 1, refining_active: 1, buried_ore: Some(i), complete: Some(false), location_list_start: Some(String::new()), ..Default::default() },
            );
            for (sid, ty) in [(format!("5-{i}0"), "14"), (format!("5-{i}1"), "15")] {
                w.structs.insert(sid.clone(), StructState { id: sid, owner: pid.clone(), type_id: ty.into(), status: status::MATERIALIZED | status::BUILT | status::ONLINE, planet: Some(planet.clone()), ..Default::default() });
            }
        }
        w
    }

    fn players() -> Vec<String> {
        vec!["1-1".into(), "1-2".into(), "1-3".into()]
    }

    #[test]
    fn the_live_scenario_yields_every_ore_as_alpha() {
        let s = Scenario { name: "live".into(), mine_range: None, refine_range: None, aim: 1 };
        let o = &run(&world(), 100, &players(), &[s])[0];
        assert_eq!((o.players, o.mines, o.refines, o.ualpha), (3, 6, 6, 6_000_000), "1+2+3 ore");
        assert_eq!(o.drained, 3);
    }

    #[test]
    fn halving_the_refine_range_drains_planets_sooner_for_the_same_alpha() {
        let live = Scenario { name: "live".into(), mine_range: None, refine_range: None, aim: 1 };
        let fast = Scenario { name: "fast refine".into(), mine_range: None, refine_range: Some(1_000), aim: 1 };
        let o = run(&world(), 100, &players(), &[live, fast]);
        assert_eq!(o[0].ualpha, o[1].ualpha, "same ore, same alpha");
        assert!(o[1].p90_drained_blocks.unwrap() < o[0].p90_drained_blocks.unwrap());
    }

    #[test]
    fn overrides_touch_only_the_rigs_they_name() {
        let w = with_rules(&world(), &Scenario { name: "x".into(), mine_range: Some(7), refine_range: None, aim: 1 });
        assert_eq!((w.types["14"].ore_mining_difficulty, w.types["15"].ore_refining_difficulty), (7, 2_000));
        assert_eq!(w.types["15"].ore_mining_difficulty, 0, "a refinery does not gain a mining range");
    }

    #[test]
    fn default_scenarios_start_from_the_live_rules() {
        let v = default_scenarios(&world(), 8);
        assert_eq!(v[0].name, "live rules");
        assert!(v.iter().any(|s| s.refine_range == Some(1_000)));
        assert!(v.iter().any(|s| s.aim == 4) && v.iter().any(|s| s.aim == 16));
    }
}
