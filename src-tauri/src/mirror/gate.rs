//! The pre-sign gate: every signed action is judged by the chain's own rules
//! at the height it would execute, before it costs a transaction.
//!
//! The gate REFUSES only on facts that cannot reverse before the transaction
//! lands — the refusal is then as certain as the chain's own:
//!
//! * charge short at execution height (charge only grows with height, and a
//!   lagging snapshot `lastAction` can only overstate it);
//! * the struct is destroyed, or a build target already built;
//! * a mine against a planet with no buried ore, or a completed planet (ore
//!   only ever decreases, a planet never un-completes);
//! * a completion whose proof matches the mirror's anchor but carries fewer
//!   zeros than the rule demands at execution height — it cannot be accepted
//!   before [`Decision::ready_at`], so the caller waits for that height
//!   instead of spending the proof on a certain rejection.
//!
//! Everything that CAN change before inclusion — online state, power,
//! stored ore, raiders, shields, an anchor that differs from the mirror's —
//! is an advisory: recorded, never blocking. When the mirror cannot decide,
//! the transaction goes ahead and the chain decides, as before.

use serde::Serialize;
use serde_json::Value;

use super::forecast::{self, Check, CheckState};
use super::rules;
use super::world::World;
use crate::mcp::perception::status;
use crate::mcp::types::TaskType;

/// How far ahead a not-yet-ripe completion is worth waiting for, in blocks.
/// Past this the caller gets a refusal and keeps the proof's task alive.
pub const MAX_RIPEN_WAIT_BLOCKS: u64 = 30;

/// Inclusion lag allowed for: a transaction sent once its earliest execution
/// height is one short of ripe is included at or after that height.
const RIPEN_SLACK_BLOCKS: u64 = 1;

/// A signed action, normalised from either wire form.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// A proof-of-work completion.
    Complete { kind: TaskType, object_id: String, proof: String, nonce: String },
    /// A message that checks and spends charge (rules::DISCHARGING).
    Discharge { name: &'static str, payer: Payer, need: Need },
    /// Anything the mirror has no rule for.
    Other,
}

/// Whose charge a discharging message spends.
#[derive(Clone, Debug, PartialEq)]
pub enum Payer {
    /// The owner of this struct.
    StructOwner(String),
    /// This player directly (build initiate names its player).
    Player(String),
}

/// Which StructType charge the handler compares against.
#[derive(Clone, Debug, PartialEq)]
pub enum Need {
    /// `BuildCharge` of the type being built (build initiate).
    BuildOfType(String),
    /// `BuildCharge` of the struct's own type (trash).
    BuildOfStruct(String),
    Activate(String),
    Move(String),
    DefendChange(String),
    Stealth(String),
    Weapon { struct_id: String, primary: bool },
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn n(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(x)) => x.to_string(),
        _ => String::new(),
    }
}

fn weapon_is_primary(w: &str) -> Option<bool> {
    match w {
        "primaryWeapon" | "primary" | "0" => Some(true),
        "secondaryWeapon" | "secondary" | "1" => Some(false),
        _ => None,
    }
}

fn discharge(name: &'static str, payer: Payer, need: Need) -> Action {
    Action::Discharge { name, payer, need }
}

impl Action {
    /// From a signed message: `/structs.structs.MsgX` + its camelCase payload.
    pub fn from_type_url(type_url: &str, p: &Value) -> Action {
        let name = type_url.rsplit('.').next().unwrap_or(type_url);
        let complete = |kind, field| Action::Complete {
            kind,
            object_id: s(p, field).to_string(),
            proof: s(p, "proof").to_string(),
            nonce: s(p, "nonce").to_string(),
        };
        let sid = || s(p, "structId").to_string();
        match name {
            "MsgStructOreMinerComplete" => complete(TaskType::Mine, "structId"),
            "MsgStructOreRefineryComplete" => complete(TaskType::Refine, "structId"),
            "MsgStructBuildComplete" => complete(TaskType::Build, "structId"),
            "MsgPlanetRaidComplete" => complete(TaskType::Raid, "fleetId"),
            "MsgStructActivate" => discharge("MsgStructActivate", Payer::StructOwner(sid()), Need::Activate(sid())),
            "MsgStructMove" => discharge("MsgStructMove", Payer::StructOwner(sid()), Need::Move(sid())),
            "MsgStructStealthActivate" => discharge("MsgStructStealthActivate", Payer::StructOwner(sid()), Need::Stealth(sid())),
            "MsgStructStealthDeactivate" => discharge("MsgStructStealthDeactivate", Payer::StructOwner(sid()), Need::Stealth(sid())),
            "MsgStructTrash" => discharge("MsgStructTrash", Payer::StructOwner(sid()), Need::BuildOfStruct(sid())),
            "MsgStructDefenseSet" | "MsgStructDefenseClear" => {
                let d = s(p, "defenderStructId").to_string();
                let name = if name == "MsgStructDefenseSet" { "MsgStructDefenseSet" } else { "MsgStructDefenseClear" };
                discharge(name, Payer::StructOwner(d.clone()), Need::DefendChange(d))
            }
            "MsgStructAttack" => {
                let a = s(p, "operatingStructId").to_string();
                match weapon_is_primary(&n(p, "weaponSystem")) {
                    Some(primary) => discharge("MsgStructAttack", Payer::StructOwner(a.clone()), Need::Weapon { struct_id: a, primary }),
                    None => Action::Other,
                }
            }
            "MsgStructBuildInitiate" => {
                discharge("MsgStructBuildInitiate", Payer::Player(s(p, "playerId").to_string()), Need::BuildOfType(n(p, "structTypeId")))
            }
            _ => Action::Other,
        }
    }

    /// From a webview-queue request: snake_case action + snake_case args.
    pub fn from_webview(action: &str, a: &Value) -> Action {
        let sid = || s(a, "struct_id").to_string();
        match action {
            "struct_activate" => discharge("MsgStructActivate", Payer::StructOwner(sid()), Need::Activate(sid())),
            "struct_move" => discharge("MsgStructMove", Payer::StructOwner(sid()), Need::Move(sid())),
            "struct_stealth_activate" => discharge("MsgStructStealthActivate", Payer::StructOwner(sid()), Need::Stealth(sid())),
            "struct_stealth_deactivate" => discharge("MsgStructStealthDeactivate", Payer::StructOwner(sid()), Need::Stealth(sid())),
            "struct_trash" => discharge("MsgStructTrash", Payer::StructOwner(sid()), Need::BuildOfStruct(sid())),
            "struct_defense_set" | "struct_defense_clear" => {
                let d = s(a, "defender_struct_id").to_string();
                let name = if action == "struct_defense_set" { "MsgStructDefenseSet" } else { "MsgStructDefenseClear" };
                discharge(name, Payer::StructOwner(d.clone()), Need::DefendChange(d))
            }
            "struct_attack" => {
                let att = s(a, "operating_struct_id").to_string();
                match weapon_is_primary(&n(a, "weapon_system")) {
                    Some(primary) => discharge("MsgStructAttack", Payer::StructOwner(att.clone()), Need::Weapon { struct_id: att, primary }),
                    None => Action::Other,
                }
            }
            "struct_build_initiate" => discharge(
                "MsgStructBuildInitiate",
                Payer::Player(s(a, "player_id").to_string()),
                Need::BuildOfType(n(a, "struct_type_id")),
            ),
            _ => Action::Other,
        }
    }

    /// The player whose state decides this action, for scoping the world.
    pub fn subject_owner(&self, world_hint: impl Fn(&str) -> Option<String>) -> Option<String> {
        match self {
            Action::Complete { object_id, .. } => world_hint(object_id),
            Action::Discharge { payer: Payer::Player(p), .. } => Some(p.clone()),
            Action::Discharge { payer: Payer::StructOwner(sid), .. } => world_hint(sid),
            Action::Other => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Send it: allowed, or the mirror cannot decide (the chain will).
    Send,
    /// Do not send: the chain is certain to reject it.
    Refuse,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Decision {
    pub verdict: Verdict,
    /// The refusing rule, `"allowed"`, or `"undecided"`.
    pub rule: &'static str,
    pub detail: String,
    /// The earliest height the transaction can execute at.
    pub exec: u64,
    /// For a not-yet-ripe proof: the first height it is accepted at.
    pub ready_at: Option<u64>,
    /// Preconditions that fail or are unknown now but can change before
    /// inclusion. Never blocking.
    pub advisories: Vec<Check>,
}

impl Decision {
    fn send(rule: &'static str, detail: impl Into<String>, exec: u64) -> Self {
        Decision { verdict: Verdict::Send, rule, detail: detail.into(), exec, ready_at: None, advisories: Vec::new() }
    }
    fn refuse(rule: &'static str, detail: impl Into<String>, exec: u64) -> Self {
        Decision { verdict: Verdict::Refuse, rule, detail: detail.into(), exec, ready_at: None, advisories: Vec::new() }
    }
    pub fn refused(&self) -> bool {
        self.verdict == Verdict::Refuse
    }
    /// Refused only because the proof is not ripe yet, ripening within `blocks`.
    pub fn ripens_within(&self, blocks: u64) -> Option<u64> {
        match (self.rule, self.ready_at) {
            ("not_ripe", Some(h)) if h <= self.exec.saturating_add(blocks) => Some(h),
            _ => None,
        }
    }
}

fn need_of(world: &World, need: &Need) -> Result<u64, String> {
    let type_of_struct = |sid: &str| -> Result<&super::world::TypeRules, String> {
        let st = world.structs.get(sid).ok_or_else(|| format!("struct {sid} not in the snapshot"))?;
        world.types.get(&st.type_id).ok_or_else(|| format!("type {} not in the catalogue", st.type_id))
    };
    let pick = |v: Option<u64>, what: &str| v.ok_or_else(|| format!("{what} charge not in the catalogue"));
    match need {
        Need::BuildOfType(tid) => pick(world.types.get(tid).ok_or_else(|| format!("type {tid} not in the catalogue"))?.charge.build, "build"),
        Need::BuildOfStruct(sid) => pick(type_of_struct(sid)?.charge.build, "build"),
        Need::Activate(sid) => pick(type_of_struct(sid)?.charge.activate, "activate"),
        Need::Move(sid) => pick(type_of_struct(sid)?.charge.r#move, "move"),
        Need::DefendChange(sid) => pick(type_of_struct(sid)?.charge.defend_change, "defend"),
        Need::Stealth(sid) => pick(type_of_struct(sid)?.charge.stealth_activate, "stealth"),
        Need::Weapon { struct_id, primary } => {
            let t = type_of_struct(struct_id)?;
            pick(if *primary { t.charge.primary_weapon } else { t.charge.secondary_weapon }, "weapon")
        }
    }
}

fn payer_of(world: &World, payer: &Payer) -> Option<String> {
    match payer {
        Payer::Player(p) => Some(p.clone()),
        Payer::StructOwner(sid) => world.structs.get(sid).map(|s| s.owner.clone()),
    }
}

/// Judge `action` against `world`, as of committed tip `tip`. Pure.
pub fn decide(world: &World, tip: u64, action: &Action) -> Decision {
    let exec = rules::earliest_execution(tip);
    match action {
        Action::Other => Decision::send("undecided", "no mirror rule for this message", exec),
        Action::Discharge { name, payer, need } => {
            let Some(pid) = payer_of(world, payer) else {
                return Decision::send("undecided", "payer not in the snapshot", exec);
            };
            let Some(last) = world.players.get(&pid).and_then(|p| p.last_action) else {
                return Decision::send("undecided", format!("{pid}'s lastAction not in the snapshot"), exec);
            };
            let need = match need_of(world, need) {
                Ok(n) => n,
                Err(e) => return Decision::send("undecided", e, exec),
            };
            let have = rules::charge(exec, last);
            if have < need {
                let mut d = Decision::refuse(
                    "insufficient_charge",
                    format!("{name}: {pid} has {have} charge at {exec}, needs {need} (ready at {})", rules::charge_height(last, need)),
                    exec,
                );
                d.ready_at = Some(rules::charge_height(last, need));
                return d;
            }
            Decision::send("allowed", format!("{name}: {pid} has {have} ≥ {need} charge at {exec}"), exec)
        }
        Action::Complete { kind, object_id, proof, nonce } => decide_completion(world, exec, *kind, object_id, proof, nonce),
    }
}

fn decide_completion(world: &World, exec: u64, kind: TaskType, object_id: &str, proof: &str, nonce: &str) -> Decision {
    // Resolve the anchor, the range and the planet the rule reads.
    let (anchor, range, planet_id, mut advisories) = match kind {
        TaskType::Raid => {
            let Some(f) = world.fleets.get(object_id) else {
                return Decision::send("undecided", format!("fleet {object_id} not in the snapshot"), exec);
            };
            let Some(p) = f.planet.as_ref().and_then(|p| world.planets.get(p)) else {
                return Decision::send("undecided", format!("fleet {object_id} is not at a known planet"), exec);
            };
            let checks = vec![forecast::shields_down(p), forecast::raider_present(p)];
            (p.raid_start, p.shield, Some(p.id.clone()), checks)
        }
        _ => {
            let Some(st) = world.structs.get(object_id) else {
                return Decision::send("undecided", format!("struct {object_id} not in the snapshot"), exec);
            };
            if st.has(status::DESTROYED) {
                return Decision::refuse("destroyed", format!("{object_id} is destroyed"), exec);
            }
            let Some(t) = world.types.get(&st.type_id) else {
                return Decision::send("undecided", format!("type {} not in the catalogue", st.type_id), exec);
            };
            let owner = world.players.get(&st.owner);
            match kind {
                TaskType::Build => {
                    if st.has(status::BUILT) {
                        return Decision::refuse("already_built", format!("{object_id} is already built"), exec);
                    }
                    let checks = vec![forecast::build_headroom(owner, t.build_draw, t.passive_draw)];
                    (st.build_start, t.build_difficulty, None, checks)
                }
                _ => {
                    let Some(p) = st.planet.as_ref().and_then(|p| world.planets.get(p)) else {
                        return Decision::send("undecided", format!("{object_id}'s planet not in the snapshot"), exec);
                    };
                    let mut checks = forecast::readiness(st, owner);
                    checks.push(forecast::not_under_raid(p));
                    if kind == TaskType::Mine {
                        if p.buried_ore == Some(0) {
                            return Decision::refuse("empty", format!("planet {} has no buried ore", p.id), exec);
                        }
                        if p.complete == Some(true) {
                            return Decision::refuse("complete", format!("planet {} is complete", p.id), exec);
                        }
                        checks.push(forecast::mining_active(p));
                        (p.mine_start, t.ore_mining_difficulty, Some(p.id.clone()), checks)
                    } else {
                        checks.push(forecast::refining_active(p));
                        checks.push(forecast::stored_ore(owner));
                        (p.refine_start, t.ore_refining_difficulty, Some(p.id.clone()), checks)
                    }
                }
            }
        }
    };
    advisories.retain(|c| c.state != CheckState::Met);

    if anchor == 0 {
        let mut d = Decision::send("undecided", format!("{kind} clock is 0 in the snapshot"), exec);
        d.advisories = advisories;
        return d;
    }
    let raid_planet = if kind == TaskType::Raid { planet_id.as_deref() } else { None };
    let input = rules::proof_input(kind, object_id, raid_planet, anchor, nonce);
    if rules::hash_build(&input) != proof {
        // The proof was solved against another anchor than the mirror holds:
        // either the clock moved (the chain will refuse) or the snapshot lags
        // (the chain will accept). Not certain either way.
        let mut d = Decision::send("undecided", format!("proof does not match the mirror's {kind} anchor {anchor}"), exec);
        d.advisories = advisories;
        return d;
    }
    let Some(age) = rules::work_age(exec, anchor) else {
        return Decision::refuse("future_anchor", format!("anchor {anchor} is after execution height {exec}"), exec);
    };
    let zeros = rules::leading_zeros(proof);
    let (valid, _) = rules::proof_accepted(&input, proof, age, range);
    if !valid {
        let ready = rules::ready_height(anchor, range, zeros);
        if ready.is_some_and(|h| h <= exec + RIPEN_SLACK_BLOCKS) {
            let mut d = Decision::send("allowed", format!("{kind} proof ripens at {}, within inclusion lag", ready.unwrap()), exec);
            d.advisories = advisories;
            return d;
        }
        let mut d = Decision::refuse(
            "not_ripe",
            format!(
                "{kind} proof has {zeros} zeros; {} needed at {exec} (anchor {anchor}, range {range}){}",
                rules::difficulty(age, range),
                ready.map(|h| format!(", accepted from {h}")).unwrap_or_default()
            ),
            exec,
        );
        d.ready_at = ready;
        d.advisories = advisories;
        return d;
    }
    let mut d = Decision::send("allowed", format!("{kind} proof accepted at {exec}: {zeros} zeros ≥ {}", rules::difficulty(age, range)), exec);
    d.advisories = advisories;
    d
}

// ── Running it against the live snapshot ─────────────────────────────────────

/// The chain clock the gate judges against: the app's tip, or the snapshot's
/// own height if newer.
fn tip_now() -> u64 {
    let clock = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    let snap = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    clock.max(snap)
}

/// Judge an action against the live snapshot. `None` = no snapshot or clock
/// yet (the transaction goes ahead as before).
pub fn check(action: &Action) -> Option<Decision> {
    if *action == Action::Other {
        return None;
    }
    let tip = tip_now();
    if tip == 0 {
        return None;
    }
    let types = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        super::world::types_from_game_state(&gs)
    };
    let decision = crate::mcp::perception::with_snapshot(|snap| {
        let owner = action.subject_owner(|id| {
            snap.struct_row(id)
                .map(|r| r.owner.clone())
                .or_else(|| snap.fleet_row(id).and_then(|f| f.get("owner").and_then(|o| o.as_str()).map(String::from)))
        });
        let owners: Vec<String> = owner.into_iter().collect();
        let world = World::from_snapshot(snap, types, "live", if owners.is_empty() { None } else { Some(&owners) });
        if owners.is_empty() {
            // No owner resolved: judging the whole galaxy for one message is
            // not worth it, and the action's subject is not in the snapshot.
            return Decision::send("undecided", "subject not in the snapshot", rules::earliest_execution(tip));
        }
        decide(&world, tip, action)
    })?;
    record(&decision);
    Some(decision)
}

/// Judge a type-URL message.
pub fn check_message(type_url: &str, payload: &Value) -> Option<Decision> {
    check(&Action::from_type_url(type_url, payload))
}

/// Judge a webview-queue request.
pub fn check_webview(action: &str, args: &Value) -> Option<Decision> {
    check(&Action::from_webview(action, args))
}

/// Before taking a signing slot: if the only problem is a proof that ripens
/// within [`MAX_RIPEN_WAIT_BLOCKS`], wait for it instead of failing. Returns
/// the decision that stands after any wait.
pub async fn ripen(type_url: &str, payload: &Value) -> Option<Decision> {
    let action = Action::from_type_url(type_url, payload);
    let mut d = check(&action)?;
    let deadline = crate::hasher::types::now_millis() + (MAX_RIPEN_WAIT_BLOCKS as f64 * 8_000.0);
    while let Some(h) = d.ripens_within(MAX_RIPEN_WAIT_BLOCKS) {
        if crate::hasher::types::now_millis() > deadline {
            break;
        }
        // Execution height must reach `h`: wait for the tip to reach h − 1.
        while tip_now() + rules::INCLUSION_LAG < h && crate::hasher::types::now_millis() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(1_000)).await;
        }
        d = check(&action)?;
    }
    Some(d)
}

/// Why the chain would refuse this struct's `kind` work RIGHT NOW, from any
/// precondition the mirror decides exactly (offline, owner out of power,
/// empty planet, no stored ore, under raid, mining inactive, …); `None` when
/// none is blocked or the struct is not in the snapshot. For a proof someone
/// else computed and asks us to sign: unlike the pre-sign gate, a reversible
/// blocker counts here, because the helper's proof waits for no one.
pub fn blocked_now(kind: TaskType, object_id: &str) -> Option<String> {
    let tip = tip_now();
    if tip == 0 {
        return None;
    }
    let types = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        super::world::types_from_game_state(&gs)
    };
    crate::mcp::perception::with_snapshot(|snap| {
        let owner = snap.struct_row(object_id)?.owner.clone();
        let world = World::from_snapshot(snap, types, "live", Some(&[owner]));
        let want = match kind {
            TaskType::Mine => forecast::Kind::Mine,
            TaskType::Refine => forecast::Kind::Refine,
            TaskType::Build => forecast::Kind::Build,
            TaskType::Raid => return None,
        };
        let opts = forecast::Options { target: rules::MAX_DIFFICULTY, within: None, project: false, verify: false };
        forecast::forecast(&world, tip, &opts)
            .into_iter()
            .find(|f| f.kind == want && f.subject == object_id)?
            .checks
            .into_iter()
            .find(|c| c.state == CheckState::Blocked && c.exact)
            .map(|c| format!("{}: {}", c.rule, c.detail))
    })?
}

// ── Accounting ───────────────────────────────────────────────────────────────

static STATS: std::sync::LazyLock<std::sync::Mutex<std::collections::BTreeMap<&'static str, u64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::BTreeMap::new()));

fn record(d: &Decision) {
    if let Ok(mut m) = STATS.lock() {
        *m.entry(d.rule).or_insert(0) += 1;
    }
    if d.refused() {
        crate::mcp::telemetry::tlog("mirror", crate::mcp::telemetry::Sev::Info, format!("gate refused ({}): {}", d.rule, d.detail));
    }
}

/// Decisions since launch, by rule.
pub fn stats() -> Vec<(&'static str, u64)> {
    STATS.lock().map(|m| m.iter().map(|(k, v)| (*k, *v)).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::world::{ChargeCosts, FleetState, PlanetState, PlayerState, StructState, TypeRules};
    use serde_json::json;

    const BUILT_ONLINE: u64 = status::MATERIALIZED | status::BUILT | status::ONLINE;

    fn world() -> World {
        let mut w = World::default();
        w.types.insert(
            "14".into(),
            TypeRules {
                name: "Ore Extractor".into(),
                ore_mining_difficulty: 14_000,
                charge: ChargeCosts { activate: Some(1), r#move: Some(2), defend_change: Some(1), build: Some(8), ..Default::default() },
                ..Default::default()
            },
        );
        w.types.insert(
            "1".into(),
            TypeRules {
                name: "Command Ship".into(),
                build_difficulty: 200,
                charge: ChargeCosts { build: Some(8), primary_weapon: Some(3), secondary_weapon: Some(0), ..Default::default() },
                ..Default::default()
            },
        );
        w.players.insert("1-1".into(), PlayerState { id: "1-1".into(), last_action: Some(1_000), stored_ore: Some(2), ..Default::default() });
        w.planets.insert(
            "2-1".into(),
            PlanetState { id: "2-1".into(), owner: "1-1".into(), mine_start: 500, mining_active: 1, buried_ore: Some(3), complete: Some(false), shield: 125, ..Default::default() },
        );
        w.structs.insert("5-1".into(), StructState { id: "5-1".into(), owner: "1-1".into(), type_id: "14".into(), status: BUILT_ONLINE, planet: Some("2-1".into()), ..Default::default() });
        w.structs.insert("5-9".into(), StructState { id: "5-9".into(), owner: "1-1".into(), type_id: "1".into(), status: status::MATERIALIZED, build_start: 900, ..Default::default() });
        w.fleets.insert("9-1".into(), FleetState { id: "9-1".into(), owner: "1-1".into(), planet: Some("2-1".into()) });
        w
    }

    /// A nonce whose hash over `input_prefix + nonce` has exactly `zeros`
    /// leading zeros.
    fn nonce_with(prefix: &str, zeros: u64) -> (String, String) {
        for i in 0..2_000_000u64 {
            let nonce = i.to_string();
            let h = rules::hash_build(&format!("{prefix}{nonce}"));
            if rules::leading_zeros(&h) == zeros {
                return (nonce, h);
            }
        }
        panic!("no nonce with {zeros} zeros");
    }

    fn mine(nonce: &str, proof: &str) -> Action {
        Action::Complete { kind: TaskType::Mine, object_id: "5-1".into(), proof: proof.into(), nonce: nonce.into() }
    }

    #[test]
    fn short_charge_is_refused_with_the_height_it_arrives() {
        let w = world();
        let a = Action::from_type_url("/structs.structs.MsgStructMove", &json!({"structId": "5-1"}));
        // tip 1000 → exec 1001: charge 1 < move 2.
        let d = decide(&w, 1_000, &a);
        assert_eq!((d.verdict, d.rule, d.ready_at), (Verdict::Refuse, "insufficient_charge", Some(1_002)));
        assert_eq!(decide(&w, 1_001, &a).verdict, Verdict::Send);
    }

    #[test]
    fn weapon_charge_follows_the_weapon_system() {
        let w = world();
        let primary = Action::from_type_url("/structs.structs.MsgStructAttack", &json!({"operatingStructId": "5-9", "weaponSystem": "primaryWeapon", "targetStructId": ["5-77"]}));
        let secondary = Action::from_type_url("/structs.structs.MsgStructAttack", &json!({"operatingStructId": "5-9", "weaponSystem": "secondaryWeapon"}));
        assert_eq!(decide(&w, 1_001, &primary).rule, "insufficient_charge", "primary costs 3, charge 2");
        assert_eq!(decide(&w, 1_001, &secondary).verdict, Verdict::Send);
    }

    #[test]
    fn webview_requests_are_judged_like_signed_messages() {
        let w = world();
        let a = Action::from_webview("struct_build_initiate", &json!({"player_id": "1-1", "struct_type_id": 14, "operating_ambit": "land", "slot": 0}));
        assert_eq!(a, Action::Discharge { name: "MsgStructBuildInitiate", payer: Payer::Player("1-1".into()), need: Need::BuildOfType("14".into()) });
        assert_eq!(decide(&w, 1_003, &a).rule, "insufficient_charge", "build 8, charge 4");
        assert_eq!(decide(&w, 1_007, &a).verdict, Verdict::Send);
    }

    #[test]
    fn an_unknown_charge_never_refuses() {
        let w = world();
        let a = Action::from_type_url("/structs.structs.MsgStructStealthActivate", &json!({"structId": "5-1"}));
        assert_eq!(decide(&w, 1_000, &a).rule, "undecided");
    }

    #[test]
    fn fleet_move_is_not_a_charged_message() {
        assert_eq!(Action::from_type_url("/structs.structs.MsgFleetMove", &json!({"fleetId": "9-1"})), Action::Other);
    }

    #[test]
    fn a_ripe_proof_against_the_mirrors_anchor_is_allowed() {
        let w = world();
        // At tip 14_499 → exec 14_500, age 14_000 = range → difficulty 1.
        let (nonce, proof) = nonce_with("5-1MINE500NONCE", 1);
        assert_eq!(decide(&w, 14_499, &mine(&nonce, &proof)).rule, "allowed");
    }

    #[test]
    fn an_unripe_proof_is_refused_with_its_ripening_height() {
        let w = world();
        let (nonce, proof) = nonce_with("5-1MINE500NONCE", 1);
        let d = decide(&w, 1_000, &mine(&nonce, &proof));
        assert_eq!(d.rule, "not_ripe");
        assert_eq!(d.ready_at, Some(500 + 14_000), "one zero is enough only once age reaches the range");
        assert!(d.ripens_within(MAX_RIPEN_WAIT_BLOCKS).is_none());
        // One block before ripe, within inclusion lag: sent.
        assert_eq!(decide(&w, 14_498, &mine(&nonce, &proof)).verdict, Verdict::Send);
    }

    #[test]
    fn a_proof_against_another_anchor_is_left_to_the_chain() {
        let w = world();
        let (nonce, proof) = nonce_with("5-1MINE499NONCE", 1);
        let d = decide(&w, 14_499, &mine(&nonce, &proof));
        assert_eq!((d.verdict, d.rule), (Verdict::Send, "undecided"));
    }

    #[test]
    fn mining_an_empty_planet_is_refused() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().buried_ore = Some(0);
        let (nonce, proof) = nonce_with("5-1MINE500NONCE", 1);
        assert_eq!(decide(&w, 14_499, &mine(&nonce, &proof)).rule, "empty");
    }

    #[test]
    fn a_reversible_blocker_is_advisory_only() {
        let mut w = world();
        // Offline struct: the chain would refuse NOW, but it can come back
        // online before inclusion — never a refusal from the gate.
        w.structs.get_mut("5-1").unwrap().status = status::MATERIALIZED | status::BUILT;
        let (nonce, proof) = nonce_with("5-1MINE500NONCE", 1);
        let d = decide(&w, 14_499, &mine(&nonce, &proof));
        assert_eq!(d.verdict, Verdict::Send);
        assert!(d.advisories.iter().any(|c| c.rule == "offline"));
    }

    #[test]
    fn building_an_already_built_struct_is_refused() {
        let mut w = world();
        w.structs.get_mut("5-9").unwrap().status = BUILT_ONLINE;
        let a = Action::Complete { kind: TaskType::Build, object_id: "5-9".into(), proof: "00".into(), nonce: "1".into() };
        assert_eq!(decide(&w, 2_000, &a).rule, "already_built");
    }

    #[test]
    fn a_raid_proof_hashes_fleet_at_planet() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().raid_start = 1_000;
        let (nonce, proof) = nonce_with("9-1@2-1RAID1000NONCE", 1);
        let a = Action::Complete { kind: TaskType::Raid, object_id: "9-1".into(), proof, nonce };
        // shield 125: difficulty 1 at age 125.
        assert_eq!(decide(&w, 1_124, &a).rule, "allowed");
        assert_eq!(decide(&w, 1_050, &a).rule, "not_ripe");
    }
}
