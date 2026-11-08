//! Preview and accuracy: what an action will do, and whether the mirror was
//! right.
//!
//! **Preview.** A proposed action is applied to a copy of the world with the
//! chain's own transition ([`super::transition`]) at the height it would
//! execute: every effect, or the chain's refusal with its rule name, before
//! anything is signed.
//!
//! **Accuracy.** For every action the app signs, the prediction is taken just
//! before signing. When the transaction lands, the prediction waits until the
//! snapshot has caught up (live events, the ore-clock sweep), then each
//! predicted effect is compared with what the world now shows. Matches and
//! mismatches are counted per action. A mismatch is not proof the mirror is
//! wrong — someone else may have acted on the same object in between — so
//! each is kept with its detail for a human to read.

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use serde_json::Value;

use super::transition::{self, Applied, Effect, Refused};
use super::world::World;

/// An action the mirror can apply.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Move {
    Mine { structure: String },
    Refine { structure: String },
    BuildComplete { structure: String },
    Activate { structure: String },
    Deactivate { structure: String },
    StructMove { structure: String, to_fleet: bool, ambit: String, slot: u64 },
    FleetMove { fleet: String, destination: String },
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn ambit_name(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.to_ascii_lowercase(),
        // proto enum numbers: none 0, water 1, land 2, air 3, space 4.
        Some(Value::Number(n)) => match n.as_u64() {
            Some(1) => "water",
            Some(2) => "land",
            Some(3) => "air",
            Some(4) => "space",
            _ => "",
        }
        .to_string(),
        _ => String::new(),
    }
}

impl Move {
    /// From a signed message (`/structs.structs.MsgX` + camelCase payload) or
    /// a webview request (`struct_activate` + snake_case args). `None` = not
    /// an action the mirror models.
    pub fn parse(action: &str, p: &Value) -> Option<Move> {
        let name = action.rsplit('.').next().unwrap_or(action);
        let sid = || {
            let a = s(p, "structId");
            if a.is_empty() { s(p, "struct_id") } else { a }
        };
        Some(match name {
            "MsgStructOreMinerComplete" => Move::Mine { structure: sid() },
            "MsgStructOreRefineryComplete" => Move::Refine { structure: sid() },
            "MsgStructBuildComplete" => Move::BuildComplete { structure: sid() },
            "MsgStructActivate" | "struct_activate" => Move::Activate { structure: sid() },
            "MsgStructDeactivate" | "struct_deactivate" => Move::Deactivate { structure: sid() },
            "MsgStructMove" | "struct_move" => {
                let lt = p.get("locationType").or_else(|| p.get("location_type"));
                let to_fleet = match lt {
                    Some(Value::String(x)) => x.eq_ignore_ascii_case("fleet"),
                    // objectType enum: fleet is 9.
                    Some(Value::Number(n)) => n.as_u64() == Some(9),
                    _ => return None,
                };
                Move::StructMove {
                    structure: sid(),
                    to_fleet,
                    ambit: ambit_name(p.get("ambit")),
                    slot: crate::mcp::types::numeric_u64(p.get("slot")).unwrap_or(0),
                }
            }
            "MsgFleetMove" | "fleet_move" => {
                let fleet = { let a = s(p, "fleetId"); if a.is_empty() { s(p, "fleet_id") } else { a } };
                let dest = {
                    let a = s(p, "destinationLocationId");
                    if a.is_empty() { s(p, "destination_id") } else { a }
                };
                Move::FleetMove { fleet, destination: dest }
            }
            _ => return None,
        })
    }

    /// The object whose owner scopes the world, and any planet that must be
    /// in it besides the owner's own.
    fn subject(&self) -> (&str, Option<&str>) {
        match self {
            Move::FleetMove { fleet, destination } => (fleet, Some(destination)),
            Move::Mine { structure }
            | Move::Refine { structure }
            | Move::BuildComplete { structure }
            | Move::Activate { structure }
            | Move::Deactivate { structure }
            | Move::StructMove { structure, .. } => (structure, None),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Move::Mine { .. } => "mine",
            Move::Refine { .. } => "refine",
            Move::BuildComplete { .. } => "build_complete",
            Move::Activate { .. } => "activate",
            Move::Deactivate { .. } => "deactivate",
            Move::StructMove { .. } => "struct_move",
            Move::FleetMove { .. } => "fleet_move",
        }
    }
}

/// Apply `m` to `world` at `height`. Pure.
pub fn apply(world: &mut World, height: u64, m: &Move) -> Result<Applied, Refused> {
    match m {
        Move::Mine { structure } => transition::mine(world, height, structure),
        Move::Refine { structure } => transition::refine(world, height, structure),
        Move::BuildComplete { structure } => transition::build_complete(world, height, structure),
        Move::Activate { structure } => transition::activate(world, height, structure),
        Move::Deactivate { structure } => transition::deactivate(world, height, structure),
        Move::StructMove { structure, to_fleet, ambit, slot } => transition::struct_move(world, height, structure, *to_fleet, ambit, *slot),
        Move::FleetMove { fleet, destination } => transition::fleet_move(world, height, fleet, destination),
    }
}

/// A preview against the live snapshot.
#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub action: Move,
    pub exec: u64,
    pub world: Option<super::world::Provenance>,
    pub result: Result<Applied, Refused>,
}

fn live_world(m: &Move) -> Option<(World, u64)> {
    let tip = {
        let clock = crate::game_state::GAME_STATE.read().ok()?.current_block_height;
        clock.max(crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0))
    };
    let types = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        super::world::types_from_game_state(&gs)
    };
    let (subject, extra) = m.subject();
    let w = crate::mcp::perception::with_snapshot(|snap| {
        let owner = snap
            .struct_row(subject)
            .map(|r| r.owner.clone())
            .or_else(|| snap.fleet_row(subject).and_then(|f| f.get("owner").and_then(|o| o.as_str()).map(String::from)))?;
        let extra: Vec<String> = extra.into_iter().map(String::from).collect();
        Some(World::from_snapshot_with(snap, types, "live", Some(&[owner]), &extra))
    })??;
    Some((w, tip))
}

/// Preview `m` against the live snapshot. `None` = no snapshot, or its
/// subject is not in it.
pub fn preview_now(m: &Move) -> Option<Preview> {
    let (mut w, tip) = live_world(m)?;
    let exec = super::rules::earliest_execution(tip);
    let world = w.provenance.clone();
    let result = apply(&mut w, exec, m);
    Some(Preview { action: m.clone(), exec, world, result })
}

// ── Plans ────────────────────────────────────────────────────────────────────

/// One step of a previewed plan.
#[derive(Clone, Debug, Serialize)]
pub struct Step {
    pub action: Move,
    pub height: u64,
    pub result: Result<Applied, Refused>,
}

/// Apply `steps` in order to one copy of `world`, one block apart from
/// `exec`, stopping at the first the chain would refuse — so each step sees
/// the effects of the ones before it. Pure.
pub fn plan(world: &World, exec: u64, steps: &[Move]) -> Vec<Step> {
    let mut w = world.clone();
    let mut out = Vec::new();
    for (i, m) in steps.iter().enumerate() {
        let height = exec + i as u64;
        let result = apply(&mut w, height, m);
        let stop = result.is_err();
        out.push(Step { action: m.clone(), height, result });
        if stop {
            break;
        }
    }
    out
}

/// Preview a plan against the live snapshot: the world covers every step's
/// owner and destination.
pub fn plan_now(steps: &[Move]) -> Option<(u64, Vec<Step>)> {
    let tip = {
        let clock = crate::game_state::GAME_STATE.read().ok()?.current_block_height;
        clock.max(crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0))
    };
    let types = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        super::world::types_from_game_state(&gs)
    };
    let w = crate::mcp::perception::with_snapshot(|snap| {
        let mut owners: Vec<String> = Vec::new();
        let mut extra: Vec<String> = Vec::new();
        for m in steps {
            let (subject, dest) = m.subject();
            if let Some(o) = snap
                .struct_row(subject)
                .map(|r| r.owner.clone())
                .or_else(|| snap.fleet_row(subject).and_then(|f| f.get("owner").and_then(|o| o.as_str()).map(String::from)))
            {
                owners.push(o);
            }
            extra.extend(dest.map(String::from));
        }
        owners.sort();
        owners.dedup();
        World::from_snapshot_with(snap, types, "live", Some(&owners), &extra)
    })?;
    let exec = super::rules::earliest_execution(tip);
    Some((exec, plan(&w, exec, steps)))
}

// ── Accuracy ─────────────────────────────────────────────────────────────────

/// Seconds a landed prediction waits before it is checked: long enough for
/// live events and the 2-minute ore-clock sweep to reach the snapshot.
pub const CHECK_AFTER_S: u64 = 150;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Tally {
    pub checked: u64,
    pub effects_matched: u64,
    pub effects_mismatched: u64,
    /// Predictions the chain then refused although the mirror allowed them.
    pub refused_after_allowed: u64,
    pub last_mismatches: Vec<String>,
}

static TALLY: LazyLock<Mutex<BTreeMap<&'static str, Tally>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// Accuracy so far, per action.
pub fn accuracy() -> BTreeMap<&'static str, Tally> {
    TALLY.lock().map(|m| m.clone()).unwrap_or_default()
}

/// A prediction taken before signing.
#[derive(Clone, Debug)]
pub struct Prediction {
    pub action: Move,
    pub exec: u64,
    pub effects: Vec<Effect>,
}

/// Take the prediction for an action about to be signed. `None` = not an
/// action the mirror models, or the mirror would refuse it (the gate decides
/// what happens then).
pub fn predict(action: &str, payload: &Value) -> Option<Prediction> {
    let m = Move::parse(action, payload)?;
    let p = preview_now(&m)?;
    let applied = p.result.ok()?;
    Some(Prediction { action: m, exec: p.exec, effects: applied.effects })
}

/// Does the world now show `e`? `None` = not comparable from the snapshot
/// (alpha is a bank balance; list pointers do not stream). Pure.
pub fn shows(w: &World, e: &Effect, exec: u64, tip_now: u64) -> Option<bool> {
    let clock_ok = |h: u64| h >= exec && h <= tip_now.max(exec);
    Some(match e {
        Effect::StoredOre { player, after, .. } => w.players.get(player)?.stored_ore? == *after,
        Effect::BuriedOre { planet, after, .. } => w.planets.get(planet)?.buried_ore? == *after,
        Effect::MineClock { planet, height } => {
            let c = w.planets.get(planet)?.mine_start;
            if *height >= exec { clock_ok(c) } else { c == *height }
        }
        Effect::RefineClock { planet, height } => {
            let c = w.planets.get(planet)?.refine_start;
            if *height >= exec { clock_ok(c) } else { c == *height }
        }
        Effect::StructsLoad { player, after } => w.players.get(player)?.structs_load? == *after,
        Effect::Status { structure, after } => {
            let st = w.structs.get(structure)?.status;
            let bits = crate::mcp::perception::status::BUILT | crate::mcp::perception::status::ONLINE | crate::mcp::perception::status::DESTROYED;
            st & bits == after & bits
        }
        Effect::MiningActive { planet, after } => w.planets.get(planet)?.mining_active == *after,
        Effect::RefiningActive { planet, after } => w.planets.get(planet)?.refining_active == *after,
        Effect::Shield { planet, after } => w.planets.get(planet)?.shield == *after,
        Effect::LastAction { player, .. } => clock_ok(w.players.get(player)?.last_action?),
        Effect::FleetLocation { fleet, planet, .. } => w.fleets.get(fleet)?.planet.as_deref() == Some(planet.as_str()),
        Effect::RaidClock { planet, height } => {
            let c = w.planets.get(planet)?.raid_start;
            if *height == 0 { c == 0 } else { clock_ok(c) }
        }
        Effect::StructPlace { structure, ambit, slot, .. } => {
            let s = w.structs.get(structure)?;
            s.ambit == *ambit && s.slot == *slot
        }
        Effect::AlphaMinted { .. } | Effect::ListStart { .. } | Effect::RaiderArrived { .. } => return None,
    })
}

/// Score a landed prediction against `w`. Pure.
pub fn score(p: &Prediction, w: &World, tip_now: u64) -> (u64, u64, Vec<String>) {
    let (mut ok, mut bad, mut why) = (0, 0, Vec::new());
    for e in &p.effects {
        match shows(w, e, p.exec, tip_now) {
            Some(true) => ok += 1,
            Some(false) => {
                bad += 1;
                why.push(format!("{} {:?} not shown after landing (may include a concurrent change)", p.action.kind(), e));
            }
            None => {}
        }
    }
    (ok, bad, why)
}

/// The transaction for `prediction` landed: check it once the snapshot has
/// caught up.
pub fn landed(prediction: Prediction) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(CHECK_AFTER_S)).await;
        let Some((w, tip)) = live_world(&prediction.action) else { return };
        let (ok, bad, why) = score(&prediction, &w, tip);
        if let Ok(mut m) = TALLY.lock() {
            let t = m.entry(prediction.action.kind()).or_default();
            t.checked += 1;
            t.effects_matched += ok;
            t.effects_mismatched += bad;
            for line in why {
                crate::mcp::telemetry::tlog("mirror", crate::mcp::telemetry::Sev::Notice, format!("prediction drift: {line}"));
                t.last_mismatches.push(line);
            }
            let n = t.last_mismatches.len();
            if n > 10 {
                t.last_mismatches.drain(..n - 10);
            }
        }
    });
}

/// The chain refused a transaction the mirror predicted would land.
pub fn refused(prediction: &Prediction, reason: &str) {
    if let Ok(mut m) = TALLY.lock() {
        let t = m.entry(prediction.action.kind()).or_default();
        t.refused_after_allowed += 1;
        t.last_mismatches.push(format!("{} refused by the chain: {}", prediction.action.kind(), reason.chars().take(160).collect::<String>()));
        let n = t.last_mismatches.len();
        if n > 10 {
            t.last_mismatches.drain(..n - 10);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn both_wire_forms_parse_to_the_same_action() {
        assert_eq!(Move::parse("/structs.structs.MsgStructActivate", &json!({"structId": "5-1"})), Move::parse("struct_activate", &json!({"struct_id": "5-1"})));
        assert_eq!(
            Move::parse("/structs.structs.MsgFleetMove", &json!({"fleetId": "9-1", "destinationLocationId": "2-2"})),
            Some(Move::FleetMove { fleet: "9-1".into(), destination: "2-2".into() })
        );
        assert_eq!(Move::parse("fleet_move", &json!({"fleet_id": "9-1", "destination_id": "2-2"})), Some(Move::FleetMove { fleet: "9-1".into(), destination: "2-2".into() }));
        assert_eq!(
            Move::parse("struct_move", &json!({"struct_id": "5-3", "location_type": "fleet", "ambit": "space", "slot": 2})),
            Some(Move::StructMove { structure: "5-3".into(), to_fleet: true, ambit: "space".into(), slot: 2 })
        );
        assert_eq!(Move::parse("/structs.structs.MsgStructAttack", &json!({})), None, "not modelled here");
    }

    fn rig_world() -> World {
        use crate::mirror::world::{PlanetState, PlayerState, StructState, TypeRules};
        use crate::mcp::perception::status;
        let mut w = World::default();
        w.types.insert("14".into(), TypeRules { ore_mining_difficulty: 14_000, ..Default::default() });
        w.players.insert("1-1".into(), PlayerState { id: "1-1".into(), stored_ore: Some(0), load: Some(0), structs_load: Some(0), capacity: Some(10), capacity_secondary: Some(0), ..Default::default() });
        w.planets.insert(
            "2-1".into(),
            PlanetState { id: "2-1".into(), owner: "1-1".into(), mine_start: 500, mining_active: 1, buried_ore: Some(3), complete: Some(false), location_list_start: Some(String::new()), ..Default::default() },
        );
        w.structs.insert("5-1".into(), StructState { id: "5-1".into(), owner: "1-1".into(), type_id: "14".into(), status: status::MATERIALIZED | status::BUILT | status::ONLINE, planet: Some("2-1".into()), ..Default::default() });
        w
    }

    #[test]
    fn a_prediction_that_landed_scores_every_comparable_effect() {
        let before = rig_world();
        let mut after = before.clone();
        let m = Move::Mine { structure: "5-1".into() };
        let applied = apply(&mut after.clone(), 20_000, &m).unwrap();
        let p = Prediction { action: m.clone(), exec: 20_000, effects: applied.effects };
        // The chain did exactly that, including the clock at inclusion 20_002.
        apply(&mut after, 20_002, &m).unwrap();
        let (ok, bad, why) = score(&p, &after, 20_010);
        assert_eq!((ok, bad), (3, 0), "{why:?}");
    }

    #[test]
    fn a_world_that_did_not_change_is_a_mismatch_with_its_detail() {
        let w = rig_world();
        let m = Move::Mine { structure: "5-1".into() };
        let applied = apply(&mut w.clone(), 20_000, &m).unwrap();
        let p = Prediction { action: m, exec: 20_000, effects: applied.effects };
        let (ok, bad, why) = score(&p, &w, 20_010);
        assert_eq!((ok, bad), (0, 3));
        assert!(why[0].contains("may include a concurrent change"));
    }

    #[test]
    fn a_clock_restarted_before_execution_is_not_a_match() {
        let mut w = rig_world();
        w.planets.get_mut("2-1").unwrap().mine_start = 19_000;
        assert_eq!(shows(&w, &Effect::MineClock { planet: "2-1".into(), height: 20_000 }, 20_000, 20_010), Some(false));
        w.planets.get_mut("2-1").unwrap().mine_start = 20_004;
        assert_eq!(shows(&w, &Effect::MineClock { planet: "2-1".into(), height: 20_000 }, 20_000, 20_010), Some(true));
    }

    #[test]
    fn alpha_and_list_pointers_are_not_scored() {
        let w = rig_world();
        assert_eq!(shows(&w, &Effect::AlphaMinted { player: "1-1".into(), ualpha: 1 }, 1, 2), None);
        assert_eq!(shows(&w, &Effect::ListStart { planet: "2-1".into(), fleet: "9-1".into() }, 1, 2), None);
    }

    #[test]
    fn a_plan_runs_in_order_and_stops_at_the_first_refusal() {
        let w = rig_world();
        let steps = vec![
            Move::Deactivate { structure: "5-1".into() },
            Move::Mine { structure: "5-1".into() }, // offline now: refused
            Move::Activate { structure: "5-1".into() },
        ];
        let out = plan(&w, 20_000, &steps);
        assert_eq!(out.len(), 2, "stops at the refused mine");
        assert!(out[0].result.is_ok());
        assert_eq!(out[1].result.as_ref().unwrap_err().rule, "offline");
        assert_eq!((out[0].height, out[1].height), (20_000, 20_001));
    }
}
