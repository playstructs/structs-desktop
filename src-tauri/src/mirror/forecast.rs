//! What the chain will allow next, and when.
//!
//! For every piece of time-driven work in a [`World`] — a build waiting on
//! its proof, a planet's mine and refine clocks, a raid in progress, a
//! player's charge — the forecast gives the first height the rule is
//! satisfied at, and checks the preconditions the chain enforces beside it.
//! Each check is `met`, `blocked` or `unknown`, and says whether it was
//! decided exactly or estimated from what the feeds carry; `exact` on the
//! forecast says whether its status rests on any estimate.

use serde::Serialize;

use super::rules;
use super::world::{PlanetState, PlayerState, StructState, World};
use crate::mcp::perception::status;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Met,
    Unknown,
    Blocked,
}

/// One precondition the chain checks before the rule even matters.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Check {
    /// The chain's name for the refusal (`offline`, `under_raid`, `empty`, …).
    pub rule: &'static str,
    pub state: CheckState,
    /// Decided from exactly the field the chain reads (`true`), or estimated
    /// from a proxy because the feeds do not carry it (`false`).
    pub exact: bool,
    pub detail: String,
}

impl Check {
    fn exact(rule: &'static str, ok: bool, detail: impl Into<String>) -> Check {
        Check { rule, state: if ok { CheckState::Met } else { CheckState::Blocked }, exact: true, detail: detail.into() }
    }
    fn estimate(rule: &'static str, ok: bool, detail: impl Into<String>) -> Check {
        Check { rule, state: if ok { CheckState::Met } else { CheckState::Blocked }, exact: false, detail: detail.into() }
    }
    fn unknown(rule: &'static str, detail: impl Into<String>) -> Check {
        Check { rule, state: CheckState::Unknown, exact: false, detail: detail.into() }
    }
    /// [`Check::known`], for the transition module.
    pub(crate) fn known_pub(rule: &'static str, v: Option<bool>, detail: impl Into<String>) -> Check {
        Check::known(rule, v, detail)
    }
    /// An exact check when the input is known, otherwise unknown.
    fn known(rule: &'static str, v: Option<bool>, detail: impl Into<String>) -> Check {
        match v {
            Some(ok) => Check::exact(rule, ok, detail),
            None => Check::unknown(rule, detail),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Build,
    Mine,
    Refine,
    Raid,
    Charge,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The rule is satisfied at the earliest execution height and every
    /// precondition is met.
    Ready,
    /// Every precondition is met; the rule is satisfied at `ready_height`.
    Waiting,
    /// No precondition is blocked, but at least one could not be decided.
    Uncertain,
    /// A precondition the chain enforces fails now.
    Blocked,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Forecast {
    pub kind: Kind,
    /// Struct id (build/mine/refine), planet id (raid) or player id (charge).
    pub subject: String,
    pub owner: String,
    /// Struct type name, or the charge-gated action.
    pub label: String,
    /// The planet whose clock and state the rule reads (mine, refine, raid).
    pub planet: Option<String>,
    /// The anchor block the rule counts from (work start, lastAction).
    pub anchor: u64,
    /// The difficulty range (work), or the charge required (charge).
    pub range: u64,
    /// The difficulty the proof is aimed at (work); 0 for charge.
    pub target: u64,
    /// The first height the rule is satisfied at; `None` = never under
    /// this target.
    pub ready_height: Option<u64>,
    /// Blocks from the earliest execution height to `ready_height`.
    pub blocks_away: Option<u64>,
    /// The difficulty a proof would need at the earliest execution height.
    pub difficulty_now: Option<u64>,
    pub status: Status,
    /// Every check was computed from the field the chain itself reads, with
    /// the chain's arithmetic. This is about the CALCULATION: it says nothing
    /// about how fresh or coherent those inputs are — that is the world's
    /// provenance. A `ready` forecast with `exact: false` rests on at least
    /// one estimate.
    pub exact: bool,
    pub checks: Vec<Check>,
}

#[derive(Clone, Debug)]
pub struct Options {
    /// Proof difficulty the work is aimed at (hex zeros).
    pub target: u64,
    /// Only forecasts satisfied within this many blocks of the earliest
    /// execution height (blocked and uncertain ones are always kept).
    pub within: Option<u64>,
    /// Also project each scoped player's planet run (mirror::project).
    pub project: bool,
    /// Also prove the facts behind scoped forecasts (mirror::verify).
    pub verify: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { target: 4, within: None, project: false, verify: false }
    }
}

fn status_of(ready_height: Option<u64>, exec: u64, checks: &[Check]) -> Status {
    match checks.iter().map(|c| c.state).max() {
        Some(CheckState::Blocked) => Status::Blocked,
        Some(CheckState::Unknown) => Status::Uncertain,
        _ => match ready_height {
            Some(h) if h <= exec => Status::Ready,
            _ => Status::Waiting,
        },
    }
}

/// `StructCache.ReadinessCheck` (keeper/struct_cache.go): not destroyed,
/// struct online, owner online.
pub(crate) fn readiness(s: &StructState, owner: Option<&PlayerState>) -> Vec<Check> {
    vec![
        Check::exact("destroyed", !s.has(status::DESTROYED), format!("status {}", s.status)),
        Check::exact("offline", s.has(status::ONLINE), format!("status {}", s.status)),
        owner_power(owner),
    ]
}

/// The owner's power headroom: load against capacity, and whether the
/// capacity is the chain's exact figure or only an upper bound.
///
/// `getPowerHeadroom` (keeper/player_cache.go) compares load + structsLoad
/// with usable primary capacity plus the substation's `connectionCapacity`
/// (zeroed when the substation fails `CheckSubstation`).
///
/// * Exact when the chain's own usable primary capacity has been read
///   (power.rs) and the substation term is decided.
/// * Otherwise an upper bound: usable primary capacity starts from the stored
///   `capacity` and only subtracts, re-adding at most the diversity bonus it
///   removed (player_primary_supply.go), and the grid share is at most what
///   the substation contributes. A load past the bound is still a certain
///   refusal; a load within it is unproven.
struct Headroom {
    load: u128,
    capacity: u128,
    exact: bool,
    basis: String,
}

fn headroom(p: &PlayerState) -> Option<Headroom> {
    let load = p.load? as u128 + p.structs_load? as u128;
    let grid_share = p.capacity_secondary;
    let secondary = if p.substation.is_empty() {
        Some(0)
    } else {
        match p.substation_exists {
            Some(false) => Some(0),
            Some(true) => grid_share,
            None => None,
        }
    };
    match (&p.usable_primary, secondary) {
        (Some(u), Some(sec)) => Some(Headroom {
            load,
            capacity: u.capacity as u128 + sec as u128,
            exact: true,
            basis: format!("usable capacity {} at {}{}", u.capacity, u.height, if u.inventory_complete { "" } else { " (inventory incomplete: chain counts 0)" }),
        }),
        _ => Some(Headroom {
            load,
            capacity: p.capacity? as u128 + grid_share? as u128,
            exact: false,
            basis: "stored capacity bound".to_string(),
        }),
    }
}

/// `PlayerCache.IsOnline`.
pub(crate) fn owner_power(p: Option<&PlayerState>) -> Check {
    let Some(p) = p else { return Check::unknown("player_offline", "owner not in the snapshot") };
    match headroom(p) {
        Some(h) if h.load > h.capacity => Check::exact("player_offline", false, format!("load {} exceeds {} ({})", h.load, h.capacity, h.basis)),
        Some(h) if h.exact => Check::exact("player_offline", true, format!("load {} within {} ({})", h.load, h.capacity, h.basis)),
        Some(h) => Check::estimate("player_offline", true, format!("load {} within {} ({}); usable capacity unproven", h.load, h.capacity, h.basis)),
        None => Check::unknown("player_offline", "power fields missing"),
    }
}

/// `CanSupportLoadAddition(passiveDraw)` at build completion, after the
/// build draw is released (msg_server_struct_build_complete.go).
pub(crate) fn build_headroom(p: Option<&PlayerState>, build_draw: Option<u64>, passive_draw: Option<u64>) -> Check {
    let (Some(p), Some(bd), Some(pd)) = (p, build_draw, passive_draw) else {
        return Check::unknown("capacity_exceeded", "owner power or the type's build/passive draw not known");
    };
    match headroom(p) {
        Some(h) => {
            let after = h.load.saturating_sub(bd as u128) + pd as u128;
            let detail = format!("needs {after} after completion, capacity {} ({})", h.capacity, h.basis);
            if after > h.capacity {
                Check::exact("capacity_exceeded", false, detail)
            } else if h.exact {
                Check::exact("capacity_exceeded", true, detail)
            } else {
                Check::estimate("capacity_exceeded", true, detail)
            }
        }
        None => Check::unknown("capacity_exceeded", "power fields missing"),
    }
}

/// `CanOreMinePlanet` / `CanOreRefine`: `locationListStart == ""`.
///
/// The planet row carries the pointer, but live events patch fleet rows and
/// never the planet's list pointers, so the pointer is trusted only when the
/// fleet rows agree with it (the chain's own list rule, applied to them).
pub(crate) fn not_under_raid(p: &PlanetState) -> Check {
    let scan = p.visitors.is_empty();
    match p.location_list_start.as_deref() {
        Some(start) if start.is_empty() == scan => Check::exact(
            "under_raid",
            scan,
            if scan { "no visiting fleet".to_string() } else { format!("visitor list starts at {start}") },
        ),
        Some(start) => Check::unknown(
            "under_raid",
            format!("planet list start {:?} disagrees with fleets at the planet {:?}", start, p.visitors),
        ),
        None => Check::estimate(
            "under_raid",
            scan,
            if scan { "no visiting fleet".to_string() } else { format!("visitors: {}", p.visitors.join(", ")) },
        ),
    }
}

/// `CanOreMinePlanet`: `oreMiningActiveQuantity > 0`.
pub(crate) fn mining_active(p: &PlanetState) -> Check {
    Check::exact("not_mining", p.mining_active > 0, format!("oreMiningActiveQuantity {}", p.mining_active))
}

/// `CanOreRefine`: `oreRefiningActiveQuantity > 0`.
pub(crate) fn refining_active(p: &PlanetState) -> Check {
    Check::exact("not_refining", p.refining_active > 0, format!("oreRefiningActiveQuantity {}", p.refining_active))
}

/// `CanOreRefine`: the owner has stored ore.
pub(crate) fn stored_ore(owner: Option<&PlayerState>) -> Check {
    let ore = owner.and_then(|o| o.stored_ore);
    Check::known("ore", ore.map(|o| o > 0), format!("stored ore {ore:?}"))
}

/// `IsDefenderCommandStructVulnerable`, the raid-completion gate.
pub(crate) fn shields_down(p: &PlanetState) -> Check {
    Check::known("shields_active", p.defender.vulnerable, p.defender.reason.clone())
}

/// A raid can only complete while a raider is still listed at the planet.
pub(crate) fn raider_present(p: &PlanetState) -> Check {
    let present = match p.location_list_start.as_deref() {
        Some(start) if start.is_empty() == p.visitors.is_empty() => Some(!start.is_empty()),
        Some(_) => None,
        None => Some(!p.visitors.is_empty()),
    };
    Check::known("no_raider", present, format!("visitors {:?}", p.visitors))
}

struct Work<'a> {
    kind: Kind,
    planet: Option<&'a str>,
    subject: &'a str,
    owner: &'a str,
    label: &'a str,
    anchor: u64,
    range: u64,
    checks: Vec<Check>,
}

fn work_forecast(w: Work<'_>, exec: u64, target: u64) -> Forecast {
    let ready_height = rules::ready_height(w.anchor, w.range, target);
    let difficulty_now = rules::work_age(exec, w.anchor).map(|a| rules::difficulty(a, w.range));
    Forecast {
        kind: w.kind,
        subject: w.subject.to_string(),
        owner: w.owner.to_string(),
        label: w.label.to_string(),
        planet: w.planet.map(String::from),
        anchor: w.anchor,
        range: w.range,
        target,
        blocks_away: ready_height.map(|h| h.saturating_sub(exec)),
        difficulty_now,
        status: status_of(ready_height, exec, &w.checks),
        exact: w.checks.iter().all(|c| c.exact),
        ready_height,
        checks: w.checks,
    }
}

/// Every forecast in `world`, as of committed tip `tip`, soonest first.
pub fn forecast(world: &World, tip: u64, opts: &Options) -> Vec<Forecast> {
    let exec = rules::earliest_execution(tip);
    let target = opts.target.clamp(rules::MIN_DIFFICULTY, rules::MAX_DIFFICULTY);
    let mut out = Vec::new();

    let live = world.live_structs();
    for s in live.iter().copied() {
        let Some(t) = world.types.get(&s.type_id) else { continue };
        let owner = world.players.get(&s.owner);
        let planet = s.planet.as_ref().and_then(|p| world.planets.get(p));

        // Build: materialized, not yet built (msg_server_struct_build_complete.go).
        if !s.has(status::BUILT) && s.build_start > 0 && t.build_difficulty > 0 {
            let checks = vec![build_headroom(owner, t.build_draw, t.passive_draw)];
            out.push(work_forecast(
                Work { kind: Kind::Build, planet: None, subject: &s.id, owner: &s.owner, label: &t.name, anchor: s.build_start, range: t.build_difficulty, checks },
                exec,
                target,
            ));
            continue;
        }
        if !s.has(status::BUILT) {
            continue;
        }

        // Mine (msg_server_struct_ore_miner_complete.go + CanOreMinePlanet).
        if t.ore_mining_difficulty > 0 {
            if let Some(p) = planet {
                let mut checks = readiness(s, owner);
                checks.push(mining_active(p));
                checks.push(not_under_raid(p));
                checks.push(Check::known("complete", p.complete.map(|c| !c), "planet status"));
                checks.push(Check::known("empty", p.buried_ore.map(|o| o > 0), format!("buried ore {:?}", p.buried_ore)));
                out.push(work_forecast(
                    Work { kind: Kind::Mine, planet: Some(&p.id), subject: &s.id, owner: &s.owner, label: &t.name, anchor: p.mine_start, range: t.ore_mining_difficulty, checks },
                    exec,
                    target,
                ));
            }
        }

        // Refine (msg_server_struct_ore_refinery_complete.go + CanOreRefine).
        if t.ore_refining_difficulty > 0 {
            if let Some(p) = planet {
                let mut checks = readiness(s, owner);
                checks.push(refining_active(p));
                checks.push(not_under_raid(p));
                checks.push(stored_ore(owner));
                out.push(work_forecast(
                    Work { kind: Kind::Refine, planet: Some(&p.id), subject: &s.id, owner: &s.owner, label: &t.name, anchor: p.refine_start, range: t.ore_refining_difficulty, checks },
                    exec,
                    target,
                ));
            }
        }
    }

    // Raids in progress (msg_server_planet_raid_complete.go): range = shield.
    let mut planets: Vec<&PlanetState> = world.planets.values().filter(|p| p.raid_start > 0).collect();
    planets.sort_by(|a, b| a.id.cmp(&b.id));
    for p in planets {
        let checks = vec![shields_down(p), raider_present(p)];
        out.push(work_forecast(
            Work { kind: Kind::Raid, planet: Some(&p.id), subject: &p.id, owner: &p.owner, label: "raid", anchor: p.raid_start, range: p.shield, checks },
            exec,
            target,
        ));
    }

    // Charge (PlayerCache.GetCharge): one forecast per distinct requirement
    // among the types each player fields. Grouped in one pass over the
    // structs: a per-player rescan is quadratic across a whole galaxy.
    let mut by_owner: std::collections::HashMap<&str, Vec<(u64, &'static str)>> = std::collections::HashMap::new();
    for s in &live {
        if let Some(t) = world.types.get(&s.type_id) {
            by_owner.entry(s.owner.as_str()).or_default().extend(t.charges.iter().map(|(a, c)| (*c, *a)));
        }
    }
    let mut players: Vec<&PlayerState> = world.players.values().collect();
    players.sort_by(|a, b| a.id.cmp(&b.id));
    for p in players {
        let Some(last) = p.last_action else { continue };
        let mut needs = by_owner.remove(p.id.as_str()).unwrap_or_default();
        needs.sort();
        needs.dedup_by_key(|(c, _)| *c);
        for (need, action) in needs {
            let ready = rules::charge_height(last, need);
            out.push(Forecast {
                kind: Kind::Charge,
                subject: p.id.clone(),
                owner: p.id.clone(),
                label: action.to_string(),
                planet: None,
                anchor: last,
                range: need,
                target: 0,
                ready_height: Some(ready),
                blocks_away: Some(ready.saturating_sub(exec)),
                difficulty_now: None,
                status: if rules::charge(exec, last) >= need { Status::Ready } else { Status::Waiting },
                exact: true,
                checks: Vec::new(),
            });
        }
    }

    if let Some(within) = opts.within {
        let horizon = exec.saturating_add(within);
        out.retain(|f| matches!(f.status, Status::Blocked | Status::Uncertain) || f.ready_height.map_or(false, |h| h <= horizon));
    }
    out.sort_by(|a, b| {
        a.ready_height
            .unwrap_or(u64::MAX)
            .cmp(&b.ready_height.unwrap_or(u64::MAX))
            .then_with(|| a.subject.cmp(&b.subject))
            .then_with(|| a.label.cmp(&b.label))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::world::TypeRules;

    const ONLINE_BUILT: u64 = status::MATERIALIZED | status::BUILT | status::ONLINE;

    fn world() -> World {
        let mut w = World::default();
        w.types.insert(
            "14".into(),
            TypeRules { name: "Ore Extractor".into(), ore_mining_difficulty: 28_000, charges: vec![("activate", 5)], ..Default::default() },
        );
        w.types.insert("7".into(), TypeRules { name: "Ore Refinery".into(), ore_refining_difficulty: 28_000, ..Default::default() });
        w.types.insert("1".into(), TypeRules { name: "Command Ship".into(), build_difficulty: 100, charges: vec![("move", 8)], ..Default::default() });
        w.players.insert(
            "1-1".into(),
            PlayerState {
                id: "1-1".into(),
                last_action: Some(1_000),
                stored_ore: Some(0),
                load: Some(10),
                structs_load: Some(5),
                capacity: Some(100),
                capacity_secondary: Some(0),
                ..Default::default()
            },
        );
        w.planets.insert(
            "2-1".into(),
            PlanetState {
                id: "2-1".into(),
                owner: "1-1".into(),
                shield: 125,
                mine_start: 900,
                refine_start: 950,
                mining_active: 1,
                refining_active: 1,
                buried_ore: Some(3),
                complete: Some(false),
                ..Default::default()
            },
        );
        for (id, ty, st, build) in [("5-1", "14", ONLINE_BUILT, 0), ("5-2", "7", ONLINE_BUILT, 0), ("5-3", "1", status::MATERIALIZED, 990)] {
            w.structs.insert(
                id.into(),
                StructState { id: id.into(), owner: "1-1".into(), type_id: ty.into(), status: st, build_start: build, planet: Some("2-1".into()), ..Default::default() },
            );
        }
        w
    }

    fn find<'a>(f: &'a [Forecast], kind: Kind, subject: &str) -> &'a Forecast {
        f.iter().find(|x| x.kind == kind && x.subject == subject).unwrap_or_else(|| panic!("no {kind:?} for {subject}"))
    }

    #[test]
    fn mine_ready_height_is_the_exact_inverse_from_the_planet_clock() {
        let f = forecast(&world(), 1_000, &Options { target: 4, within: None, project: false, verify: false });
        let m = find(&f, Kind::Mine, "5-1");
        let want = 900 + rules::ready_age(28_000, 4).unwrap();
        assert_eq!(m.ready_height, Some(want));
        // And it is the FIRST such height: one block earlier still needs more.
        assert!(rules::difficulty(want - 1 - 900, 28_000) > 4);
        assert!(rules::difficulty(want - 900, 28_000) <= 4);
        assert_eq!(m.status, Status::Waiting);
        assert!(!m.exact, "under_raid and owner power are estimates");
    }

    #[test]
    fn refining_with_no_stored_ore_is_blocked_whatever_the_clock_says() {
        let f = forecast(&world(), 50_000, &Options::default());
        let r = find(&f, Kind::Refine, "5-2");
        assert_eq!(r.status, Status::Blocked);
        assert!(r.checks.iter().any(|c| c.rule == "ore" && c.state == CheckState::Blocked && c.exact));
    }

    #[test]
    fn an_empty_planet_blocks_mining() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().buried_ore = Some(0);
        let f = forecast(&w, 50_000, &Options::default());
        assert_eq!(find(&f, Kind::Mine, "5-1").status, Status::Blocked);
    }

    #[test]
    fn unknown_buried_ore_is_never_treated_as_ore() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().buried_ore = None;
        let f = forecast(&w, 50_000, &Options::default());
        let m = find(&f, Kind::Mine, "5-1");
        assert!(m.checks.iter().any(|c| c.rule == "empty" && c.state == CheckState::Unknown));
        assert_ne!(m.status, Status::Ready);
    }

    #[test]
    fn an_offline_struct_cannot_mine() {
        let mut w = world();
        w.structs.get_mut("5-1").unwrap().status = status::MATERIALIZED | status::BUILT;
        let f = forecast(&w, 50_000, &Options::default());
        assert_eq!(find(&f, Kind::Mine, "5-1").status, Status::Blocked);
    }

    #[test]
    fn a_visitor_at_the_planet_blocks_mining_as_an_estimate() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().visitors = vec!["9-77".into()];
        let f = forecast(&w, 50_000, &Options::default());
        let m = find(&f, Kind::Mine, "5-1");
        assert_eq!(m.status, Status::Blocked);
        assert!(m.checks.iter().any(|c| c.rule == "under_raid" && !c.exact));
    }

    #[test]
    fn build_forecasts_count_from_the_build_start() {
        let f = forecast(&world(), 1_000, &Options { target: 1, within: None, project: false, verify: false });
        let b = find(&f, Kind::Build, "5-3");
        assert_eq!(b.ready_height, Some(990 + 100), "difficulty 1 at age == range");
    }

    #[test]
    fn charge_forecasts_land_on_last_action_plus_need_once_per_requirement() {
        let f = forecast(&world(), 1_000, &Options::default());
        let c: Vec<&Forecast> = f.iter().filter(|x| x.kind == Kind::Charge).collect();
        // Command Ship (5-3) is unbuilt but alive: its move charge still counts.
        assert_eq!(c.iter().map(|x| (x.range, x.ready_height)).collect::<Vec<_>>(), vec![(5, Some(1_005)), (8, Some(1_008))]);
        assert!(c.iter().all(|x| x.status == Status::Waiting));
        let later = forecast(&world(), 1_007, &Options::default());
        let ready: Vec<u64> = later.iter().filter(|x| x.kind == Kind::Charge && x.status == Status::Ready).map(|x| x.range).collect();
        assert_eq!(ready, vec![5, 8], "at tip 1007 a tx executes at 1008 with charge 8");
    }

    #[test]
    fn a_raid_in_progress_uses_the_shield_as_its_range() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().raid_start = 1_000;
        let f = forecast(&w, 1_000, &Options { target: 1, within: None, project: false, verify: false });
        let r = find(&f, Kind::Raid, "2-1");
        assert_eq!((r.range, r.ready_height), (125, Some(1_125)));
    }

    #[test]
    fn within_drops_distant_waits_but_keeps_problems() {
        let f = forecast(&world(), 1_000, &Options { target: 1, within: Some(10), project: false, verify: false });
        assert!(f.iter().all(|x| x.ready_height.map_or(true, |h| h <= 1_011) || matches!(x.status, Status::Blocked | Status::Uncertain)));
        assert!(f.iter().any(|x| x.kind == Kind::Refine), "the blocked refine is kept");
    }

    #[test]
    fn output_is_sorted_soonest_first() {
        let f = forecast(&world(), 1_000, &Options::default());
        let hs: Vec<u64> = f.iter().map(|x| x.ready_height.unwrap_or(u64::MAX)).collect();
        let mut sorted = hs.clone();
        sorted.sort();
        assert_eq!(hs, sorted);
    }

    fn check<'a>(f: &'a Forecast, rule: &str) -> &'a Check {
        f.checks.iter().find(|c| c.rule == rule).unwrap_or_else(|| panic!("no {rule} check"))
    }

    #[test]
    fn a_visitor_list_that_agrees_with_the_fleets_is_exact() {
        let mut w = world();
        w.planets.get_mut("2-1").unwrap().location_list_start = Some(String::new());
        let f = forecast(&w, 50_000, &Options::default());
        let c = check(find(&f, Kind::Mine, "5-1"), "under_raid");
        assert_eq!((c.state, c.exact), (CheckState::Met, true));

        let p = w.planets.get_mut("2-1").unwrap();
        p.location_list_start = Some("9-7".into());
        p.visitors = vec!["9-7".into()];
        let f = forecast(&w, 50_000, &Options::default());
        let c = check(find(&f, Kind::Mine, "5-1"), "under_raid");
        assert_eq!((c.state, c.exact), (CheckState::Blocked, true));
    }

    #[test]
    fn a_stale_list_pointer_is_unknown_not_trusted() {
        let mut w = world();
        // Pointer says clear, but a fleet that is not home sits here: live
        // events moved the fleet and never patched the planet's pointer.
        let p = w.planets.get_mut("2-1").unwrap();
        p.location_list_start = Some(String::new());
        p.visitors = vec!["9-7".into()];
        let f = forecast(&w, 50_000, &Options::default());
        assert_eq!(check(find(&f, Kind::Mine, "5-1"), "under_raid").state, CheckState::Unknown);
    }

    #[test]
    fn load_past_even_the_capacity_bound_is_an_exact_refusal() {
        let mut w = world();
        w.players.get_mut("1-1").unwrap().load = Some(200);
        let f = forecast(&w, 50_000, &Options::default());
        let m = find(&f, Kind::Mine, "5-1");
        let c = check(m, "player_offline");
        assert_eq!((c.state, c.exact), (CheckState::Blocked, true));
        assert_eq!(m.status, Status::Blocked);
    }

    #[test]
    fn load_within_the_bound_stays_an_estimate() {
        let f = forecast(&world(), 50_000, &Options::default());
        let c = check(find(&f, Kind::Mine, "5-1"), "player_offline");
        assert_eq!((c.state, c.exact), (CheckState::Met, false));
    }

    #[test]
    fn build_completion_checks_passive_draw_after_releasing_build_draw() {
        let mut w = world();
        let t = w.types.get_mut("1").unwrap();
        t.build_draw = Some(10);
        t.passive_draw = Some(90);
        // load 15 − build 10 + passive 90 = 95 ≤ 100: fits (unproven).
        let f = forecast(&w, 50_000, &Options::default());
        let c = check(find(&f, Kind::Build, "5-3"), "capacity_exceeded");
        assert_eq!((c.state, c.exact), (CheckState::Met, false));
        // passive 96 → 101 > 100: the chain will refuse, certainly.
        w.types.get_mut("1").unwrap().passive_draw = Some(96);
        let f = forecast(&w, 50_000, &Options::default());
        let b = find(&f, Kind::Build, "5-3");
        assert_eq!((check(b, "capacity_exceeded").state, b.status), (CheckState::Blocked, Status::Blocked));
    }

    #[test]
    fn unknown_draws_leave_the_build_uncertain() {
        let f = forecast(&world(), 50_000, &Options::default());
        assert_eq!(find(&f, Kind::Build, "5-3").status, Status::Uncertain);
    }

    #[test]
    fn a_raid_completes_only_with_shields_down_and_a_raider_listed() {
        use crate::mirror::world::Defender;
        let mut w = world();
        let p = w.planets.get_mut("2-1").unwrap();
        p.raid_start = 1_000;
        p.location_list_start = Some("9-7".into());
        p.visitors = vec!["9-7".into()];
        p.defender = Defender { vulnerable: Some(true), reason: "Command Ship 5-9 offline".into() };
        let f = forecast(&w, 2_000, &Options { target: 1, within: None, project: false, verify: false });
        let r = find(&f, Kind::Raid, "2-1");
        assert_eq!((r.status, r.exact), (Status::Ready, true));

        w.planets.get_mut("2-1").unwrap().defender = Defender { vulnerable: Some(false), reason: "online on station".into() };
        let f = forecast(&w, 2_000, &Options { target: 1, within: None, project: false, verify: false });
        assert_eq!(find(&f, Kind::Raid, "2-1").status, Status::Blocked);
    }

    fn with_usable(w: &mut World, capacity: u64) {
        w.players.get_mut("1-1").unwrap().usable_primary =
            Some(crate::mirror::power::Usable { capacity, height: 999, inventory_complete: true });
    }

    #[test]
    fn the_chains_usable_capacity_makes_power_exact() {
        let mut w = world();
        with_usable(&mut w, 100);
        let f = forecast(&w, 50_000, &Options::default());
        let c = check(find(&f, Kind::Mine, "5-1"), "player_offline");
        assert_eq!((c.state, c.exact), (CheckState::Met, true));
    }

    #[test]
    fn usable_capacity_below_the_stored_figure_takes_a_player_offline() {
        // Stored capacity 100 would pass load 15; the chain counts only 10.
        let mut w = world();
        with_usable(&mut w, 10);
        let f = forecast(&w, 50_000, &Options::default());
        let m = find(&f, Kind::Mine, "5-1");
        assert_eq!((check(m, "player_offline").state, check(m, "player_offline").exact), (CheckState::Blocked, true));
        assert_eq!(m.status, Status::Blocked);
    }

    #[test]
    fn an_unread_substation_keeps_power_on_the_bound() {
        let mut w = world();
        with_usable(&mut w, 100);
        let p = w.players.get_mut("1-1").unwrap();
        p.substation = "4-1".into();
        p.capacity_secondary = Some(50);
        let f = forecast(&w, 50_000, &Options::default());
        assert!(!check(find(&f, Kind::Mine, "5-1"), "player_offline").exact);
        // Once read, the substation's share counts exactly.
        w.players.get_mut("1-1").unwrap().substation_exists = Some(true);
        let f = forecast(&w, 50_000, &Options::default());
        let c = check(find(&f, Kind::Mine, "5-1"), "player_offline");
        assert!(c.exact && c.detail.contains("within 150"), "{}", c.detail);
    }

    #[test]
    fn a_deleted_substation_contributes_nothing() {
        let mut w = world();
        with_usable(&mut w, 10);
        let p = w.players.get_mut("1-1").unwrap();
        p.substation = "4-1".into();
        p.capacity_secondary = Some(50);
        p.substation_exists = Some(false);
        let f = forecast(&w, 50_000, &Options::default());
        assert_eq!(check(find(&f, Kind::Mine, "5-1"), "player_offline").state, CheckState::Blocked);
    }
}
