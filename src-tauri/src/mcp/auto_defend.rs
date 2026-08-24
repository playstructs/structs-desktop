//! Native auto-defense loop — builds and MAINTAINS each vplayer's on-chain
//! defense web (`MsgStructDefenseSet` / `MsgStructDefenseClear`), modeled on the
//! lattice the shard's strongest player (1-61 "JPEG") runs: his home has been
//! cracked once in nine raid attempts, and the crack cost the attacker a
//! counter-immune siege hull grinding through LAYERS of blockers.
//!
//! The web, in priority order (see [`plan_web`]):
//!   1. **Command Ship ← same-ambit armoured blocker** (Tank). The CMD is the
//!      raid gate; a blocker absorbs shots INCLUDING counter-immune Mobile
//!      Artillery fire — blocking is the only defense counter-immunity cannot
//!      bypass (measured 2026-08-13: a Tank blocker ate 3 MA shots aimed at our
//!      raider's CMD).
//!   2. **Command Ship ← counter-guards** — hulls whose weapons cover many
//!      ambits, so whatever ambit the attacker fires from, something answers.
//!   3. **The blocker ← its own guards** — stripping the blocker must cost the
//!      attacker (counter damage STACKS across every armed defender).
//!   4. **Refinery / Extractor ← same-ambit blockers** (Ore Bunkers).
//!   5. **Every remaining armed hull is wired in round-robin** — 1-61 wires his
//!      ENTIRE fleet (15 edges); an idle charge bar defends nothing.
//!
//! Unlike the previous version this loop also CLEARS: a defender pointing at a
//! dead or low-value target while a critical edge is unfilled gets a
//! `MsgStructDefenseClear` (then re-assigned next scan). The chain auto-removes
//! edges on destruction, but never re-points a survivor — that's our job, and
//! it is exactly what 1-61 does by hand after every fight (6 re-adds within 20
//! minutes of losing his CMD on 2026-08-13).
//!
//! One action per player per scan (defend costs charge), off by default.
//! Covers ALL roles: raider fleets especially need webs — fleet defenders
//! travel with the fleet, and a raider's CMD dying mid-raid ends the raid,
//! strands the fleet, and opens its home planet.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_defend.json";
const COMMAND_SHIP_TYPE: &str = "1";
/// The protection priority the loop used before profiles could state one:
/// Command Ship, then Ore Refinery, then Ore Extractor.
const DEFAULT_PROTECT: &[&str] = &[COMMAND_SHIP_TYPE, REFINERY_TYPE, EXTRACTOR_TYPE];

/// One protection target, resolved to chain type IDS so the planner stays pure.
#[derive(Debug, Clone, PartialEq)]
pub struct ProtectTarget {
    pub type_id: String,
    /// Relative pull when a spare hull chooses what to cover.
    pub weight: f64,
    /// Defender type IDS permitted on this target; empty = any.
    pub by: Vec<String>,
}

fn blocks_label(type_id: &str) -> &'static str {
    match type_id {
        COMMAND_SHIP_TYPE => "blocks the Command Ship",
        REFINERY_TYPE => "blocks the Refinery",
        EXTRACTOR_TYPE => "blocks the Extractor",
        _ => "blocks a protected struct",
    }
}

fn counters_label(type_id: &str) -> &'static str {
    match type_id {
        COMMAND_SHIP_TYPE => "counters attacks on the Command Ship",
        REFINERY_TYPE => "counters attacks on the Refinery",
        EXTRACTOR_TYPE => "counters attacks on the Extractor",
        _ => "counters attacks on a protected struct",
    }
}

fn blocker_guard_label(type_id: &str) -> &'static str {
    match type_id {
        COMMAND_SHIP_TYPE => "guards the Command Ship's blocker",
        REFINERY_TYPE => "guards the Refinery's blocker",
        _ => "guards the primary's blocker",
    }
}

impl ProtectTarget {
    pub fn plain(type_id: &str) -> Self {
        Self { type_id: type_id.to_string(), weight: 1.0, by: Vec::new() }
    }
}
const REFINERY_TYPE: &str = "15";
const EXTRACTOR_TYPE: &str = "14";
/// Production / command types — PROTECTED targets, never used as defenders.
const PROTECTED_TYPES: &[&str] = &["14", "15", "1"]; // extractor, refinery, command ship
/// Counter-guards assigned directly to the Command Ship (beyond its blocker).
const CMD_GUARDS: usize = 2;
/// Guards assigned to the Command Ship's blocker.
const BLOCKER_GUARDS: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDefendConfig {
    /// Master on/off. Off by default — it auto-signs defense-set/clear txs.
    pub enabled: bool,
    /// Min seconds between scans.
    pub interval_secs: u64,
    /// Also web BAIT players (default true — bait carry real fleets, and a
    /// blocked CMD turns a free decapitation into a grind).
    pub include_bait: bool,
    /// Also web RAIDER players (default true). Fleet defenders TRAVEL with the
    /// fleet: a raider's Tank blocker keeps absorbing counter-immune fire at
    /// the target planet, which is where its CMD is most likely to die.
    #[serde(default = "default_true")]
    pub include_raiders: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AutoDefendConfig {
    fn default() -> Self {
        Self { enabled: false, interval_secs: 180, include_bait: true, include_raiders: true }
    }
}

static CONFIG: LazyLock<RwLock<AutoDefendConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);

/// A living, relevant struct of the player being planned.
#[derive(Debug, Clone)]
pub struct Hull {
    pub id: String,
    pub type_id: String,
    pub ambit: String,
    pub location_id: String,
}

/// The slice of the type catalog the planner needs. Kept separate from
/// [`crate::game_state::StructTypeInfo`] so [`plan_web`] is a pure function
/// tests can drive without a synced GAME_STATE.
#[derive(Debug, Clone)]
pub struct TypeStats {
    /// Cross-ambit counter damage.
    pub counter: u64,
    /// Same-ambit counter damage.
    pub counter_same: u64,
    /// Armour (attack_reduction) — what makes a hull a good BLOCKER.
    pub armour: u64,
    /// Union of primary|secondary weapon ambit masks (Water=2, Land=4, Air=8, Space=16).
    pub reach: u64,
    /// v0.21.0: only types the chain flags `canDefend` may be registered as
    /// defenders — fleet hulls yes, planetary structs no. The whole "Ore
    /// Bunker blocks the refinery" edge class died with that release
    /// (measured: 155 of 188 auto_defend txs rejected `cannot defend` in the
    /// first two hours it was live).
    pub can_defend: bool,
}

/// Default is PERMISSIVE (`can_defend: true`): a type missing from the synced
/// catalog fails open and the chain arbitrates with a clean, ledgered reject —
/// the same doctrine as the unknown-charge rule. Fleet hulls are the common
/// case, so open is also usually correct.
impl Default for TypeStats {
    fn default() -> Self {
        Self { counter: 0, counter_same: 0, armour: 0, reach: 0, can_defend: true }
    }
}

/// One desired edge of the defense web.
#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    pub defender: String,
    pub protected: String,
    pub why: &'static str,
}

/// The ambits this defender can COUNTER an attack from: everything its weapon
/// reaches, plus the ambit it stands in.
///
/// Verified live 2026-08-18 (1-471): a defender standing in the attacker's
/// ambit counters regardless of weapon reach. Scoring on `reach` alone
/// under-counted every hull's real coverage.
fn counter_ambits(stats: &TypeStats, defender_ambit: &str) -> u64 {
    // No weapon, no counter — standing there is not enough. Ore Bunkers
    // (`primary_weapon_ambits = 0`, `noActiveWeaponry`) protecting a land
    // Command Ship were measured blocking EVERY land attack and countering
    // none. Without this guard they would score as full-coverage counter
    // guards and crowd out hulls that can actually shoot back.
    if stats.reach == 0 {
        return 0;
    }
    stats.reach | crate::mcp::tools::format::ambit_bit(defender_ambit)
}

fn breadth(reach: u64) -> u64 {
    (reach & 0b11110).count_ones() as u64
}

/// Does this pairing keep working when it is needed most?
///
/// Both block and counter require the two structs to be CO-LOCATED at the
/// moment of the shot. Planetary structs DO NOT TRAVEL, so they silently stop
/// defending a fleet the instant it leaves home — which is exactly when it is
/// raiding and most exposed. A fleet defender moves with what it guards.
fn travels_with_target(defender_loc: &str, target_loc: &str) -> bool {
    !defender_loc.is_empty() && defender_loc == target_loc
}

/// How useful is this hull as a defender of a target in `target_ambit`?
///
/// A defender contributes two SEPARATE things under two DIFFERENT conditions:
///   * **Blocking** — absorbs the shot entirely (even from counter-immune
///     hulls). Requires the defender to share the TARGET's ambit.
///   * **Countering** — damages the attacker, and can outright NEGATE the
///     attack. Happens when the defender's WEAPON reaches the attacker's ambit
///     **OR** the defender simply STANDS in it. The second half was missing
///     here and it is not academic: on 2026-08-18 vs 1-471, their
///     space-standing Battleship countered our space attacker for 1 despite
///     its weapon reaching only water|land. See [`counter_ambits`].
///
/// Blocking is the stronger effect, so same-ambit dominates; among the rest,
/// value follows counter strength times how many ambits the weapon can answer
/// from. Reach is primary|secondary — the Cruiser's air answer lives on its
/// SECONDARY and a primary-only read made it invisible here.
fn rank(stats: &TypeStats, target_ambit: &str, defender_ambit: &str) -> u64 {
    let blocks = !target_ambit.is_empty() && defender_ambit == target_ambit;
    let counter_value = stats.counter_same.max(stats.counter) * breadth(stats.reach);
    if blocks { 100 + counter_value } else { counter_value }
}

/// Compute the FULL desired defense web for one player's structs.
///
/// Pure: takes the living hulls and a type-stats view, returns priority-ordered
/// edges. Every defender protects at most one struct (`protectedStructIndex` is
/// singular), so this is a greedy allocation down the priority list; a hull
/// whose best remaining assignment scores zero is left free.
pub fn plan_web(hulls: &[Hull], stats: &HashMap<String, TypeStats>) -> Vec<Edge> {
    plan_web_with(hulls, stats, &crate::mcp::variance::Temperament::default())
}

/// [`plan_web`] with an explicit temperament.
///
/// Kept pure (all state passed in) so tests can pin it. The hard filters —
/// same-ambit for a blocker, `rank(..) > 0` for a guard — are applied exactly
/// as before; only the CHOICE among eligible hulls is sampled, so a warm
/// temperament can never produce a pairing that does nothing.
pub fn plan_web_with(
    hulls: &[Hull],
    stats: &HashMap<String, TypeStats>,
    temperament: &crate::mcp::variance::Temperament,
) -> Vec<Edge> {
    let default: Vec<ProtectTarget> = DEFAULT_PROTECT.iter().map(|t| ProtectTarget::plain(t)).collect();
    plan_web_stance(hulls, stats, temperament, "", &default, CMD_GUARDS, BLOCKER_GUARDS)
}

/// [`plan_web_seeded`] with an explicit protection priority list.
///
/// `protect_ids` is struct TYPE IDS, highest priority first. The first entry
/// that this player actually owns becomes the PRIMARY: it gets a same-ambit
/// blocker, counter-guards, and guards on that blocker. Every later entry that
/// exists gets a same-ambit blocker of its own.
///
/// This is what makes "protect the Command Ship, then the Refinery once it is
/// gone" expressible: the list is walked fresh every scan, so when the primary
/// dies the next survivor is promoted automatically — no special-casing.
///
/// Type IDS rather than names so this stays PURE and testable; the caller
/// [`plan_web_stance`] with the shipped priority and guard counts, seeded from
/// `key` so one player's web is stable across scans.
pub fn plan_web_seeded(
    hulls: &[Hull],
    stats: &HashMap<String, TypeStats>,
    temperament: &crate::mcp::variance::Temperament,
    key: &str,
) -> Vec<Edge> {
    let default: Vec<ProtectTarget> = DEFAULT_PROTECT.iter().map(|t| ProtectTarget::plain(t)).collect();
    plan_web_stance(hulls, stats, temperament, key, &default, CMD_GUARDS, BLOCKER_GUARDS)
}

/// resolves the profile's names against the synced catalog.
pub fn plan_web_stance(
    hulls: &[Hull],
    stats: &HashMap<String, TypeStats>,
    temperament: &crate::mcp::variance::Temperament,
    key: &str,
    protect: &[ProtectTarget],
    guards_on_primary: usize,
    guards_on_blocker: usize,
) -> Vec<Edge> {
    let mut rng = crate::mcp::variance::seeded_rng(key);
    let get = |tid: &str| stats.get(tid).cloned().unwrap_or_default();
    // Walk the priority list and keep whatever this player actually owns. The
    // head is the primary; the tail get blockers. Re-derived every scan, so a
    // destroyed primary promotes the next survivor on the following pass.
    let owned: Vec<(&Hull, &ProtectTarget)> = protect
        .iter()
        .filter_map(|p| hulls.iter().find(|h| h.type_id == p.type_id).map(|h| (h, p)))
        .collect();
    let cmd = owned.first().map(|(h, _)| *h);
    let primary_weight = owned.first().map(|(_, p)| p.weight).unwrap_or(1.0);
    let secondary: Vec<(&Hull, f64)> = owned.iter().skip(1).map(|(h, p)| (*h, p.weight)).collect();
    // target hull id -> permitted defender type ids (empty = any).
    let accepts: HashMap<String, Vec<String>> =
        owned.iter().map(|(h, p)| (h.id.clone(), p.by.clone())).collect();

    // The defender pool: everything that is not itself a protected production/
    // command struct AND that the chain will accept as a defender. Until
    // v0.21.0 planetary hulls were eligible and "an Ore Bunker blocking the
    // refinery" was a real, load-bearing edge; the CanDefend flag ended that —
    // only fleet hulls defend now, and a planetary DefenseSet is a guaranteed
    // `cannot defend` reject.
    let mut pool: Vec<&Hull> = hulls
        .iter()
        .filter(|h| !PROTECTED_TYPES.contains(&h.type_id.as_str()))
        .filter(|h| get(&h.type_id).can_defend)
        .collect();
    let mut edges: Vec<Edge> = Vec::new();
    let mut take = |pool: &mut Vec<&Hull>, best: Option<usize>, protected: &Hull, why: &'static str, edges: &mut Vec<Edge>| {
        if let Some(i) = best {
            let d = pool.remove(i);
            edges.push(Edge { defender: d.id.clone(), protected: protected.id.clone(), why });
        }
    };

    let mut cmd_blocker: Option<Hull> = None;
    if let Some(cmd) = cmd {
        // 1. The blocker: same ambit (that is what blocking requires), travels
        // with the CMD, and ARMOUR first — a blocker's job is absorbing, and
        // armour halves what 2-damage weapons do to it. This is the Tank.
        let best = pool
            .iter()
            .enumerate()
            .filter(|(_, h)| h.ambit == cmd.ambit)
            .max_by_key(|(_, h)| {
                let s = get(&h.type_id);
                (travels_with_target(&h.location_id, &cmd.location_id), s.armour, s.counter_same, breadth(s.reach))
            })
            .map(|(i, _)| i);
        if let Some(i) = best {
            cmd_blocker = Some(pool[i].clone());
        }
        take(&mut pool, best, cmd, blocks_label(&cmd.type_id), &mut edges);

        // 2. Counter-guards on the CMD: the attacker's ambit is unknown until
        // the shot lands, so what matters is that SOMETHING answers from every
        // ambit — and that is a property of the guard SET, not of any one hull.
        //
        // Scoring each candidate in isolation (counter x breadth) picked the two
        // highest-breadth hulls, which are often the same TYPE and so cover the
        // same two ambits twice while leaving the other two open. Greedy on
        // MARGINAL coverage instead: each pick is the hull that answers the most
        // ambits nothing already covers, and only then the hardest-hitting.
        //
        // This is what actually won the 2026-08-18 fight against 1-471: the
        // guard set covered all four ambits, so their land, water AND space
        // attacks were each countered, and twelve of their hulls died to the
        // return fire without our Command Ship ever taking a point.
        //
        // The BLOCKER above is chosen deterministically on purpose: it is the
        // one hull whose job is to absorb, armour halves what it takes, and a
        // worse blocker is a straight downgrade with no unpredictability worth
        // buying. The GUARDS are where variety is free — several hulls answer
        // an ambit adequately, so which one takes the slot is taste, and a web
        // that differs per player is harder to read off-chain.
        let mut covered: u64 = 0;
        for _ in 0..guards_on_primary {
            let eligible: Vec<(usize, &Hull)> = pool
                .iter()
                .enumerate()
                .filter(|(_, h)| {
                    let s = get(&h.type_id);
                    rank(&s, &cmd.ambit, &h.ambit) > 0
                })
                .map(|(i, h)| (i, *h))
                .collect();
            // Same key as before, flattened to one scalar so it can be sampled:
            // travels dominates, then newly-covered ambits, then raw counter
            // value, then armour. At temperature 0 this is the old argmax.
            let quality = |h: &Hull| -> f64 {
                let s = get(&h.type_id);
                let gain = (counter_ambits(&s, &h.ambit) & !covered).count_ones() as f64;
                let travels = if travels_with_target(&h.location_id, &cmd.location_id) { 1.0 } else { 0.0 };
                travels * 10_000.0
                    + gain * 100.0
                    + (s.counter_same.max(s.counter) * breadth(s.reach)) as f64
                    + s.armour as f64 / 10.0
            };
            let best =
                crate::mcp::variance::pick(&eligible, |(_, h)| quality(h), temperament, &mut rng)
                    .map(|k| eligible[k].0);
            if let Some(i) = best {
                let s = get(&pool[i].type_id);
                covered |= counter_ambits(&s, &pool[i].ambit);
            }
            take(&mut pool, best, cmd, counters_label(&cmd.type_id), &mut edges);
        }
    }

    // 3. Guards on the blocker: stripping it has to cost the attacker.
    let primary_type: &str = cmd.map(|c| c.type_id.as_str()).unwrap_or("");
    if let Some(blocker) = &cmd_blocker {
        for _ in 0..guards_on_blocker {
            let best = pool
                .iter()
                .enumerate()
                .filter(|(_, h)| {
                    let s = get(&h.type_id);
                    rank(&s, &blocker.ambit, &h.ambit) > 0
                })
                .max_by_key(|(_, h)| {
                    let s = get(&h.type_id);
                    (travels_with_target(&h.location_id, &blocker.location_id), s.counter_same.max(s.counter) * breadth(s.reach))
                })
                .map(|(i, _)| i);
            take(&mut pool, best, blocker, blocker_guard_label(primary_type), &mut edges);
        }
    }

    // 4. Production blockers: same ambit, co-located, armour first (this is
    // where Ore Bunkers earn their keep — they can never counter, but a land
    // bunker blocks every land shot at the refinery).
    for (prod, _w) in secondary.iter().copied() {
        let why: &'static str = blocks_label(&prod.type_id);
        let best = pool
            .iter()
            .enumerate()
            .filter(|(_, h)| h.ambit == prod.ambit && travels_with_target(&h.location_id, &prod.location_id))
            .max_by_key(|(_, h)| {
                let s = get(&h.type_id);
                (s.armour, std::cmp::Reverse(s.counter_same.max(s.counter) * breadth(s.reach)))
            })
            .map(|(i, _)| i);
        take(&mut pool, best, prod, why, &mut edges);
    }

    // 5. Every remaining armed hull picks WHAT IT COVERS, weighted.
    //
    // This used to round-robin targets, which mechanically alternated and gave
    // every player the same web. Now each leftover hull scores its eligible
    // targets — defensive value x the stance's weight for that target — and
    // SAMPLES one at the profile's temperature.
    //
    // Two things fall out that a fixed walk cannot express: two identical hulls
    // can end up on different structs (once one Tank covers the Command Ship
    // the marginal value there drops, so the second is drawn elsewhere), and a
    // stance can restrict a target to particular defender types via `by`, so
    // "Ore Bunkers cover the Refinery, Tanks cover the Command Ship" needs no
    // rule in code.
    let mut targets: Vec<(&Hull, f64)> = Vec::new();
    if let Some(c) = cmd {
        targets.push((c, primary_weight));
    }
    // (The blocker is in `edges`, not `pool`; find it among hulls.)
    if let Some(b) = &cmd_blocker {
        if let Some(h) = hulls.iter().find(|h| h.id == b.id) {
            targets.push((h, 1.0));
        }
    }
    for (r, w) in secondary.iter().copied() {
        targets.push((r, w));
    }
    if !targets.is_empty() {
        // How many defenders each target already carries, so value tapers
        // rather than piling every hull onto the richest target.
        let mut load: HashMap<String, f64> = HashMap::new();
        for e in edges.iter() {
            *load.entry(e.protected.clone()).or_insert(0.0) += 1.0;
        }
        while !pool.is_empty() {
            // Every legal (defender, target) pairing left on the board.
            let mut options: Vec<(usize, usize, f64)> = Vec::new(); // (pool idx, target idx, score)
            for (pi, h) in pool.iter().enumerate() {
                let s = get(&h.type_id);
                for (ti, (t, weight)) in targets.iter().enumerate() {
                    let r = rank(&s, &t.ambit, &h.ambit);
                    if r == 0 {
                        continue; // cannot block or counter for this target — law
                    }
                    let allowed = accepts
                        .get(&t.id)
                        .map(|by| by.is_empty() || by.contains(&h.type_id))
                        .unwrap_or(true);
                    if !allowed {
                        continue; // stance reserves this target for other types
                    }
                    let travels = if travels_with_target(&h.location_id, &t.location_id) { 1.0 } else { 0.0 };
                    let taper = 1.0 / (1.0 + load.get(&t.id).copied().unwrap_or(0.0));
                    options.push((pi, ti, (r as f64) * weight * taper + travels * 1_000.0));
                }
            }
            if options.is_empty() {
                break; // nothing left that can usefully defend anything
            }
            let Some(k) = crate::mcp::variance::pick(&options, |o| o.2, temperament, &mut rng) else {
                break;
            };
            let (pi, ti, _) = options[k];
            let t = targets[ti].0;
            *load.entry(t.id.clone()).or_insert(0.0) += 1.0;
            take(&mut pool, Some(pi), t, "additional counter mass", &mut edges);
        }
    }
    edges
}

/// Defender struct id -> protected struct id it defends on-chain (cached to
/// avoid re-querying every struct every scan). Entries are EVICTED when either
/// side dies or when we clear the edge — the old version never removed
/// anything, so a defender whose target died was frozen out of the web forever.
static ASSIGNED_CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join(FILENAME))
}
fn load() -> AutoDefendConfig {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
pub fn get() -> AutoDefendConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

/// Run generation: bumped by every watchdog reset. See auto_build::RUN_GEN —
/// a scan whose generation went stale must not clear the guard or report
/// liveness (a newer scan owns them).
static RUN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Watchdog remediation: invalidate the wedged scan and clear the
/// single-flight guard so the next tick can scan again.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}
pub fn set(cfg: AutoDefendConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    if let (Some(p), Ok(j)) = (path(), serde_json::to_string_pretty(&cfg)) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, j);
    }
}

fn type_id_of(s: &Value) -> String {
    s.get("type")
        .or_else(|| s.get("struct_type"))
        .map(|x| match x {
            Value::Number(n) => n.to_string(),
            Value::String(t) => t.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
}
fn truthy(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true))) || matches!(v, Some(Value::String(s)) if s.eq_ignore_ascii_case("true"))
}

/// Build the planner's type-stats view from the synced game state.
fn catalog() -> HashMap<String, TypeStats> {
    let mut out = HashMap::new();
    if let Ok(gs) = crate::game_state::GAME_STATE.read() {
        for (tid, t) in gs.struct_types.iter() {
            out.insert(
                tid.clone(),
                TypeStats {
                    counter: t.counter_attack.unwrap_or(0),
                    counter_same: t.counter_attack_same_ambit.unwrap_or(0),
                    armour: t.attack_reduction.unwrap_or(0),
                    reach: t.primary_weapon_ambits.unwrap_or(0) | t.secondary_weapon_ambits.unwrap_or(0),
                    // Pre-0.21 sync payloads lack the flag; fall back to the
                    // category (fleet defends, planetary does not — exactly
                    // the ship rule the flag encodes).
                    can_defend: t
                        .can_defend
                        .unwrap_or_else(|| t.category.as_deref() == Some("fleet")),
                },
            );
        }
    }
    out
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
    let run = crate::mcp::telemetry::LoopRun::start("auto_defend");
    scan(app_handle, &cfg, &run).await;
    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-scan".into()));
        return;
    }
    run.finish(Some(format!(
        "eff_conc={}",
        crate::mcp::loop_util::effective_max_concurrent()
    )));
    if run.errors.load(Ordering::Relaxed) == 0 {
        crate::mcp::loop_util::report_clean_scan();
    }
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(
    app_handle: &tauri::AppHandle,
    cfg: &AutoDefendConfig,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) {
    use crate::mcp::virtual_players::VPlayerRole;
    let client = CosmosClient::new();
    let targets = crate::mcp::virtual_players::collect_targets(false);
    let include_bait = cfg.include_bait;
    let include_raiders = cfg.include_raiders;
    let app = app_handle.clone();
    let run_c = run.clone();
    let stats = catalog();

    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::effective_max_concurrent(),
        move |(pid, idx_opt, role)| {
            let client = client.clone();
            let app = app.clone();
            let run = run_c.clone();
            let stats = stats.clone();
            async move {
                let Some(idx) = idx_opt else { return }; // vplayers only (façade signer)
                run.players.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                // Whether this player maintains a web is a PROFILE capability.
                // The loop-level include_bait / include_raiders flags remain as
                // a roster-wide override on top, so an operator can still mute a
                // whole role without editing every profile.
                let caps = crate::mcp::profile::for_player(
                    crate::mcp::virtual_players::profile_of(&pid).as_deref(),
                    role,
                )
                .capabilities;
                if !caps.auto_defends {
                    return;
                }
                if !include_raiders && role == Some(VPlayerRole::Raider) {
                    return;
                }
                if !include_bait && role == Some(VPlayerRole::Bait) {
                    return;
                }
                // Resolve THIS player's structs from its planet + fleet slot arrays;
                // the guild struct-LIST endpoints are broken (return a global page,
                // not the owner's). See loop_util::player_structs.
                let structs = crate::mcp::loop_util::player_structs(&client, &pid).await;
                if structs.is_empty() {
                    return;
                }
                let alive: Vec<&Value> = structs.iter().filter(|s| !truthy(s.get("is_destroyed"))).collect();
                let alive_ids: HashSet<String> = alive
                    .iter()
                    .filter_map(|s| s.get("id").and_then(|x| x.as_str()).map(String::from))
                    .collect();

                // Evict cache entries invalidated by combat: the chain removes
                // an edge when either side dies, so our mirror must too.
                {
                    let mut cache = ASSIGNED_CACHE.lock().unwrap();
                    cache.retain(|d, t| {
                        // Only judge entries belonging to this player's structs.
                        let ours = alive_ids.contains(d)
                            || structs.iter().any(|s| s.get("id").and_then(|x| x.as_str()) == Some(d.as_str()));
                        if !ours {
                            return true;
                        }
                        alive_ids.contains(d) && alive_ids.contains(t)
                    });
                }

                // Current on-chain edges + built-ness for this player's hulls.
                let mut current: HashMap<String, String> = HashMap::new();
                let mut built: HashSet<String> = HashSet::new();
                for s in &alive {
                    let Some(sid) = s.get("id").and_then(|x| x.as_str()).map(String::from) else { continue };
                    if let Some(target) = ASSIGNED_CACHE.lock().unwrap().get(&sid).cloned() {
                        current.insert(sid.clone(), target);
                        built.insert(sid);
                        continue;
                    }
                    let entity = match client.query_entity("struct", &sid).await {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let sa = entity.get("structAttributes");
                    if !truthy(sa.and_then(|x| x.get("isBuilt"))) {
                        continue; // not online yet — neither defender nor edge target
                    }
                    built.insert(sid.clone());
                    let prot_idx = sa
                        .and_then(|x| x.get("protectedStructIndex"))
                        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|v| v.parse().ok())))
                        .unwrap_or(0);
                    if prot_idx != 0 {
                        let target = format!("5-{}", prot_idx);
                        ASSIGNED_CACHE.lock().unwrap().insert(sid.clone(), target.clone());
                        current.insert(sid, target);
                    }
                }

                // Plan the full desired web over BUILT hulls only.
                let hulls: Vec<Hull> = alive
                    .iter()
                    .filter_map(|s| {
                        let id = s.get("id").and_then(|x| x.as_str())?.to_string();
                        if !built.contains(&id) {
                            return None;
                        }
                        let f = |k: &str| s.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                        Some(Hull { id, type_id: type_id_of(s), ambit: f("operating_ambit"), location_id: f("location_id") })
                    })
                    .collect();
                // The defence web varies by role: a raider's is loose, the
                // economy's is tight. The blocker stays deterministic either
                // way — only the guard slots are sampled.
                // The defensive stance is the profile's, resolved to type ids.
                // An empty resolution (cold catalog, or every name unknown)
                // falls back to the shipped priority rather than leaving the
                // player with no web at all.
                let profile = crate::mcp::profile::for_player(
                    crate::mcp::virtual_players::profile_of(&pid).as_deref(),
                    role,
                );
                let mut protect = crate::mcp::profile::resolved_protect(&profile);
                if protect.is_empty() {
                    protect = DEFAULT_PROTECT.iter().map(|t| ProtectTarget::plain(t)).collect();
                }
                let desired = plan_web_stance(
                    &hulls,
                    &stats,
                    &profile.temperament,
                    &pid,
                    &protect,
                    profile.defence.guards_on_primary,
                    profile.defence.guards_on_blocker,
                );
                if desired.is_empty() {
                    return;
                }

                // Diff → ONE action this scan, highest-priority first:
                // the first desired edge not yet on chain. If its defender is
                // currently wired to something else, CLEAR it (set happens next
                // scan); otherwise SET it.
                let missing = desired
                    .iter()
                    .find(|e| current.get(&e.defender).map(|t| t != &e.protected).unwrap_or(true));
                let Some(edge) = missing else { return }; // web complete

                // One charged action per player per BLOCK, and auto_build /
                // auto_harvest sweep the same roster concurrently. Racing them
                // is a guaranteed code-2022 reject ("already discharged") that
                // costs a signing slot and a transaction attempt — 24 of them
                // in one hour, always the same players. Defer to the next scan.
                if crate::mcp::loop_util::acted_this_block(&pid) {
                    return;
                }
                let needs_clear = current.contains_key(&edge.defender);

                let (msg, payload, verb) = if needs_clear {
                    (
                        "/structs.structs.MsgStructDefenseClear",
                        json!({ "defenderStructId": edge.defender }),
                        "re-pointing (clear)",
                    )
                } else {
                    (
                        "/structs.structs.MsgStructDefenseSet",
                        json!({ "defenderStructId": edge.defender, "protectedStructId": edge.protected }),
                        "set",
                    )
                };
                let res = crate::mcp::tx_retry::sign_with_retry(
                    &app,
                    idx,
                    msg,
                    payload,
                    &format!("auto_defend:{pid}"),
                )
                .await;
                match res {
                    Ok(_) => {
                        let mut cache = ASSIGNED_CACHE.lock().unwrap();
                        if needs_clear {
                            cache.remove(&edge.defender);
                        } else {
                            cache.insert(edge.defender.clone(), edge.protected.clone());
                        }
                        drop(cache);
                        run.actions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        crate::mcp::telemetry::tlog(
                            "auto_defend",
                            crate::mcp::telemetry::Sev::Info,
                            format!("{verb}: {} → {} [{}] (player {pid})", edge.defender, edge.protected, edge.why),
                        );
                        crate::mcp::board_feed::push(
                            &app,
                            crate::mcp::board_feed::Severity::Info,
                            "auto_defend",
                            format!("{pid}: {} {} → {} ({})", verb, edge.defender, edge.protected, edge.why),
                        );
                    }
                    Err(e) => {
                        // Two rejects are CONVERGENCE, not failure — the chain
                        // is telling us the desired end-state already holds:
                        //  · "is not_defending … for defense_clear": the
                        //    registration we wanted gone is already gone (the
                        //    v0.21.0 upgrade wiped every planetary-defender
                        //    registration wholesale; our cache lagged it).
                        //  · "cannot defend": the defender is a type the chain
                        //    no longer accepts — un-cache it so the planner
                        //    stops re-proposing a doomed edge on stale state.
                        let benign = e.contains("not_defending");
                        if benign || e.contains("cannot defend") {
                            ASSIGNED_CACHE.lock().unwrap().remove(&edge.defender);
                        }
                        if benign {
                            crate::mcp::telemetry::tlog(
                                "auto_defend",
                                crate::mcp::telemetry::Sev::Debug,
                                format!("defense {verb} for {pid}: already converged ({e})"),
                            );
                        } else {
                            run.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            crate::mcp::telemetry::tlog(
                                "auto_defend",
                                crate::mcp::telemetry::Sev::Warn,
                                format!("defense {verb} failed for {pid}: {e}"),
                            );
                        }
                    }
                }
                // One action per player per scan (charge-paced).
            }
        },
    )
    .await;
}

#[cfg(test)]
mod tests {

    /// Guard selection must cover AMBITS, not maximise per-hull breadth.
    ///
    /// Two Battleships both answer water+land; picking both leaves air and
    /// space open, which is a raider's free lane. The set that actually won on
    /// 2026-08-18 was Battleship + High Altitude Interceptor — between them all
    /// four ambits answer, which is why every incoming attack was countered.
    #[test]
    fn cmd_guards_cover_distinct_ambits_rather_than_doubling_up() {
        const WATER: u64 = 2;
        const LAND: u64 = 4;
        const AIR: u64 = 8;
        const SPACE: u64 = 16;
        // Real type ids: 1 = Command Ship, 9 = Tank, 2 = Battleship,
        // 6 = High Altitude Interceptor.
        let mut st: HashMap<String, TypeStats> = HashMap::new();
        st.insert("1".into(), TypeStats::default());
        st.insert("9".into(), TypeStats { counter: 1, counter_same: 1, reach: LAND, armour: 1, ..Default::default() });
        st.insert("2".into(), TypeStats { counter: 1, counter_same: 1, reach: WATER | LAND, ..Default::default() });
        st.insert("6".into(), TypeStats { counter: 1, counter_same: 1, reach: AIR | SPACE, ..Default::default() });

        let hulls = vec![
            hull("5-cmd", "1", "land", "9-1"),
            hull("5-tank", "9", "land", "9-1"),
            hull("5-b1", "2", "space", "9-1"),
            hull("5-b2", "2", "space", "9-1"),
            hull("5-hai", "6", "air", "9-1"),
        ];
        let web = plan_web(&hulls, &st);
        let guards: Vec<&str> = web
            .iter()
            .filter(|e| e.protected == "5-cmd" && e.why.contains("counters"))
            .map(|e| e.defender.as_str())
            .collect();
        assert!(
            guards.contains(&"5-hai"),
            "the air/space answer must beat a second identical Battleship, got {guards:?} (web {web:?})"
        );
        let mut covered = 0u64;
        for g in &guards {
            let h = hulls.iter().find(|x| &x.id == g).unwrap();
            covered |= counter_ambits(st.get(&h.type_id).unwrap(), &h.ambit);
        }
        assert_eq!(
            covered & (WATER | LAND | AIR | SPACE),
            WATER | LAND | AIR | SPACE,
            "guard set leaves an ambit unanswered: covered={covered:b}"
        );
    }

    /// Warm temperaments must vary the WEB without ever producing a pairing
    /// that does nothing — the eligibility filter (`rank(..) > 0`) is law at
    /// every temperature, only the choice among eligible hulls is taste.
    #[test]
    fn a_warm_web_varies_but_never_wires_a_useless_pairing() {
        const WATER: u64 = 2;
        const LAND: u64 = 4;
        const AIR: u64 = 8;
        const SPACE: u64 = 16;
        let mut st: HashMap<String, TypeStats> = HashMap::new();
        st.insert("1".into(), TypeStats::default());
        st.insert("9".into(), TypeStats { counter: 1, counter_same: 1, reach: LAND, armour: 1, ..Default::default() });
        st.insert("2".into(), TypeStats { counter: 1, counter_same: 1, reach: WATER | LAND, ..Default::default() });
        st.insert("6".into(), TypeStats { counter: 1, counter_same: 1, reach: AIR | SPACE, ..Default::default() });
        // A hull that can neither block the land CMD nor counter anything.
        st.insert("99".into(), TypeStats::default());

        let hulls = vec![
            hull("5-cmd", "1", "land", "9-1"),
            hull("5-tank", "9", "land", "9-1"),
            hull("5-b1", "2", "space", "9-1"),
            hull("5-b2", "2", "space", "9-1"),
            hull("5-hai", "6", "air", "9-1"),
            hull("5-dud", "99", "space", "9-1"),
        ];
        let warm = crate::mcp::variance::Temperament { temperature: 1.2, ..Default::default() };

        // Variance lives BETWEEN players (see `plan_web_seeded`), so vary the
        // key rather than re-rolling one player's web — re-rolling is the churn
        // this design exists to prevent.
        let mut seen = std::collections::HashSet::new();
        for i in 0..60 {
            let web = plan_web_seeded(&hulls, &st, &warm, &format!("1-{i:04}"));
            for e in &web {
                assert_ne!(e.defender, "5-dud", "a useless hull was wired in — filter was sampled");
            }
            // The blocker is deliberately NOT sampled: it absorbs, and armour
            // halves what it takes, so a worse one is a pure downgrade.
            assert_eq!(web[0].defender, "5-tank", "blocker must stay deterministic");
            seen.insert(web.iter().map(|e| e.defender.clone()).collect::<Vec<_>>());
        }
        assert!(seen.len() > 1, "warm temperament produced one fixed web across all players");
    }

    /// The web must SETTLE. It is reconciled state, not a one-shot action: if
    /// each scan sampled a different desired web, auto_defend would clear and
    /// re-set defenders forever, burning a charged transaction every time.
    #[test]
    fn a_players_web_is_stable_across_scans_but_differs_between_players() {
        const WATER: u64 = 2;
        const LAND: u64 = 4;
        const AIR: u64 = 8;
        const SPACE: u64 = 16;
        let mut st: HashMap<String, TypeStats> = HashMap::new();
        st.insert("1".into(), TypeStats::default());
        st.insert("9".into(), TypeStats { counter: 1, counter_same: 1, reach: LAND, armour: 1, ..Default::default() });
        st.insert("2".into(), TypeStats { counter: 1, counter_same: 1, reach: WATER | LAND, ..Default::default() });
        st.insert("6".into(), TypeStats { counter: 1, counter_same: 1, reach: AIR | SPACE, ..Default::default() });
        let hulls = vec![
            hull("5-cmd", "1", "land", "9-1"),
            hull("5-tank", "9", "land", "9-1"),
            hull("5-b1", "2", "space", "9-1"),
            hull("5-b2", "2", "space", "9-1"),
            hull("5-hai", "6", "air", "9-1"),
        ];
        let warm = crate::mcp::variance::Temperament { temperature: 1.2, ..Default::default() };
        let web_of = |key: &str| {
            plan_web_seeded(&hulls, &st, &warm, key)
                .iter()
                .map(|e| format!("{}->{}", e.defender, e.protected))
                .collect::<Vec<_>>()
        };
        // Same player, ten scans: identical every time, so nothing to reconcile.
        let first = web_of("1-2136");
        for _ in 0..10 {
            assert_eq!(web_of("1-2136"), first, "web churned between scans");
        }
        // Across a spread of players at least one web differs — variance lives
        // BETWEEN players, which is where it cannot cost a transaction.
        let ids = ["1-0271", "1-1035", "1-2308", "1-0400", "1-0365", "1-2464"];
        assert!(
            ids.iter().any(|k| web_of(k) != first),
            "every player produced an identical web — no variance at all"
        );
    }

    fn stance(ids: &[&str]) -> Vec<ProtectTarget> {
        ids.iter().map(|t| ProtectTarget::plain(t)).collect()
    }

    /// "Protect the Command Ship, then the Refinery if it explodes."
    ///
    /// No special-casing: the priority list is walked fresh each scan, so the
    /// first SURVIVING entry becomes the primary and takes the blocker.
    #[test]
    fn the_next_survivor_is_promoted_when_the_primary_dies() {
        let st = stats();
        let cold = crate::mcp::variance::Temperament::default();
        let with_cmd = vec![
            hull("5-cmd", COMMAND_SHIP_TYPE, "land", "9-1"),
            hull("5-ref", REFINERY_TYPE, "land", "2-1"),
            hull("5-tank", "9", "land", "9-1"),
        ];
        let web = plan_web_stance(&with_cmd, &st, &cold, "p", &stance(&[COMMAND_SHIP_TYPE, REFINERY_TYPE]), CMD_GUARDS, BLOCKER_GUARDS);
        assert_eq!(web[0].protected, "5-cmd", "primary takes the blocker");
        assert_eq!(web[0].why, "blocks the Command Ship");

        // Same stance, Command Ship destroyed (absent from the hull list).
        let without_cmd = vec![
            hull("5-ref", REFINERY_TYPE, "land", "2-1"),
            hull("5-tank", "9", "land", "2-1"),
        ];
        let web2 = plan_web_stance(&without_cmd, &st, &cold, "p", &stance(&[COMMAND_SHIP_TYPE, REFINERY_TYPE]), CMD_GUARDS, BLOCKER_GUARDS);
        assert_eq!(web2[0].protected, "5-ref", "the next survivor is promoted");
        assert_eq!(web2[0].why, "blocks the Refinery", "and the label names it correctly");
    }

    /// A stance may reserve a target for particular defender TYPES, so
    /// "Ore Bunkers cover the Refinery" needs no rule in code.
    #[test]
    fn a_target_can_be_reserved_for_named_defender_types() {
        let st = stats();
        let cold = crate::mcp::variance::Temperament::default();
        let hulls = vec![
            hull("5-cmd", COMMAND_SHIP_TYPE, "land", "9-1"),
            hull("5-ref", REFINERY_TYPE, "land", "9-1"),
            hull("5-tank", "9", "land", "9-1"),
            hull("5-bunker", "16", "land", "9-1"),
        ];
        // Refinery accepts ONLY Ore Bunkers (type 16).
        let mut protect = stance(&[COMMAND_SHIP_TYPE, REFINERY_TYPE]);
        protect[1].by = vec!["16".into()];
        let web = plan_web_stance(&hulls, &st, &cold, "p", &protect, CMD_GUARDS, BLOCKER_GUARDS);
        for e in web.iter().filter(|e| e.protected == "5-ref") {
            assert_ne!(e.defender, "5-tank", "a Tank took a Bunker-only target");
        }
    }

    /// Identical hulls should be able to cover DIFFERENT structs rather than
    /// doubling up — the value of a target tapers as defenders pile onto it.
    #[test]
    fn identical_hulls_can_split_across_targets() {
        let st = stats();
        let cold = crate::mcp::variance::Temperament::default();
        let hulls = vec![
            hull("5-cmd", COMMAND_SHIP_TYPE, "land", "9-1"),
            hull("5-ref", REFINERY_TYPE, "land", "9-1"),
            hull("5-t1", "9", "land", "9-1"),
            hull("5-t2", "9", "land", "9-1"),
            hull("5-t3", "9", "land", "9-1"),
            hull("5-t4", "9", "land", "9-1"),
        ];
        // guards_on_primary 1, none on the blocker: the author is buying
        // BREADTH. With the default 2+2 a four-hull fleet is legitimately
        // consumed by the primary alone.
        let web = plan_web_stance(&hulls, &st, &cold, "p", &stance(&[COMMAND_SHIP_TYPE, REFINERY_TYPE]), 1, 0);
        let covered: std::collections::HashSet<&str> =
            web.iter().map(|e| e.protected.as_str()).collect();
        assert!(
            covered.contains("5-ref"),
            "four identical Tanks all piled onto one target: {web:?}"
        );
    }

    /// A defender standing in the attacker's ambit counters even when its
    /// weapon cannot reach there — their space Battleship countered our space
    /// attacker for 1 on 2026-08-18 with reach water|land.
    #[test]
    fn counter_ambits_includes_the_ambit_the_defender_stands_in() {
        let bship = TypeStats { reach: 2 | 4, ..Default::default() };
        assert_eq!(counter_ambits(&bship, "space") & 16, 16, "standing in space must count");
        assert_eq!(counter_ambits(&bship, "space") & 2, 2, "reach is still counted");
    }

    /// ...but a hull with NO weapon never counters, wherever it stands. Ore
    /// Bunkers block every land attack on a land Command Ship and counter none
    /// of them; crediting them with coverage would let them displace a real
    /// counter-guard.
    #[test]
    fn a_weaponless_hull_counters_from_nowhere() {
        let bunker = TypeStats { reach: 0, counter: 0, counter_same: 0, armour: 1, ..Default::default() };
        assert_eq!(counter_ambits(&bunker, "land"), 0);
    }

    use super::*;

    fn stats() -> HashMap<String, TypeStats> {
        // A minimal but realistic catalog (values from the live chain table).
        let mut m = HashMap::new();
        let fleet = |counter, counter_same, armour, reach| TypeStats {
            counter, counter_same, armour, reach, can_defend: true
        };
        // v0.21.0: planetary types carry canDefend=false on the chain.
        let planetary = TypeStats { can_defend: false, ..Default::default() };
        m.insert("1".into(), fleet(2, 2, 1, 32)); // Command Ship
        m.insert("2".into(), fleet(1, 1, 0, 6)); // Battleship (water|land, AP)
        m.insert("9".into(), fleet(1, 1, 1, 4)); // Tank (armoured)
        m.insert("8".into(), fleet(0, 0, 0, 6)); // Mobile Artillery
        m.insert("11".into(), fleet(1, 1, 0, 6 | 8)); // Cruiser (secondary reaches air)
        m.insert("12".into(), fleet(1, 2, 0, 10)); // Destroyer
        m.insert("18".into(), planetary.clone()); // Ore Bunker
        m.insert("15".into(), planetary.clone()); // Refinery
        m.insert("14".into(), planetary); // Extractor
        m
    }

    fn hull(id: &str, tid: &str, ambit: &str, loc: &str) -> Hull {
        Hull { id: id.into(), type_id: tid.into(), ambit: ambit.into(), location_id: loc.into() }
    }

    #[test]
    fn default_off_covers_all_roles() {
        let c = AutoDefendConfig::default();
        assert!(!c.enabled);
        assert!(c.include_bait, "bait carry real fleets — web them");
        assert!(c.include_raiders, "fleet defenders travel; raiders need their CMD blocked most");
        assert_eq!(c.interval_secs, 180);
    }

    /// The heart of the lattice: the CMD gets a SAME-AMBIT ARMOURED blocker
    /// first — blocking is the only defense counter-immune artillery cannot
    /// bypass, so this edge outranks everything.
    #[test]
    fn cmd_blocker_is_armoured_same_ambit_and_first() {
        let hulls = vec![
            hull("5-cmd", "1", "land", "9-1"),
            hull("5-tank", "9", "land", "9-1"),
            hull("5-ma", "8", "land", "9-1"),   // same ambit but no armour
            hull("5-bb", "2", "space", "9-1"),  // cross-ambit
        ];
        let web = plan_web(&hulls, &stats());
        assert_eq!(web[0].defender, "5-tank", "armoured same-ambit hull must be the blocker");
        assert_eq!(web[0].protected, "5-cmd");
    }

    /// Counter-guards then pile on the CMD, and the blocker itself gets guarded
    /// — stripping the blocker has to cost the attacker.
    #[test]
    fn web_layers_guards_on_cmd_and_blocker() {
        let hulls = vec![
            hull("5-cmd", "1", "land", "9-1"),
            hull("5-tank", "9", "land", "9-1"),
            hull("5-bb", "2", "space", "9-1"),
            hull("5-cruiser", "11", "water", "9-1"),
            hull("5-destroyer", "12", "water", "9-1"),
        ];
        let web = plan_web(&hulls, &stats());
        // Everything armed gets wired somewhere.
        assert_eq!(web.len(), 4, "every useful hull is in the web: {web:?}");
        let on_cmd = web.iter().filter(|e| e.protected == "5-cmd").count();
        let on_blocker = web.iter().filter(|e| e.protected == "5-tank").count();
        assert!(on_cmd >= 2, "CMD gets blocker + counter-guards");
        assert!(on_blocker >= 1, "the blocker is itself guarded");
    }

    /// Ore Bunkers can never counter, but a same-ambit co-located bunker blocks
    /// every shot at the refinery — production gets blocked, not guarded.
    #[test]
    fn production_gets_same_ambit_blockers() {
        // v0.21.0 (chain): only canDefend types may register as defenders, and
        // every planetary type ships canDefend=false. The Ore Bunker → Refinery
        // block was a real, load-bearing edge before that release; wiring it
        // now is a guaranteed `cannot defend` reject (measured: 155 of 188
        // auto_defend txs failed in the first two hours v0.21.0 was live).
        let hulls = vec![
            hull("5-ref", "15", "land", "2-1"),
            hull("5-bunker", "18", "land", "2-1"),
        ];
        let web = plan_web(&hulls, &stats());
        assert!(web.is_empty(), "a planetary hull must never be wired as a defender: {web:?}");

        // A same-ambit FLEET hull still takes the job.
        let hulls = vec![
            hull("5-ref", "15", "land", "2-1"),
            hull("5-bunker", "18", "land", "2-1"),
            hull("5-tank", "9", "land", "9-1"),
        ];
        let web = plan_web(&hulls, &stats());
        assert_eq!(
            web,
            vec![Edge { defender: "5-tank".into(), protected: "5-ref".into(), why: "blocks the Refinery" }]
        );
    }

    /// A hull that can neither block nor counter its would-be target is left
    /// free instead of burning its singular defender slot.
    #[test]
    fn useless_pairings_are_not_made() {
        // A lone space bunker-analogue (no weapon, wrong ambit) with a land CMD.
        let hulls = vec![
            hull("5-cmd", "1", "land", "9-1"),
            hull("5-osg", "18", "space", "2-1"),
        ];
        let web = plan_web(&hulls, &stats());
        assert!(web.is_empty(), "no zero-value edges: {web:?}");
    }

    /// The Cruiser's air reach lives on its SECONDARY weapon; the planner's
    /// stats view must include it (a primary-only read scored it lower than a
    /// Battleship for guard duty despite broader coverage).
    #[test]
    fn reach_is_primary_or_secondary_union() {
        let s = stats();
        assert_eq!(breadth(s["11"].reach), 3, "Cruiser reaches water+land+air via secondary");
        assert!(breadth(s["11"].reach) > breadth(s["2"].reach));
    }

    #[test]
    fn travels_with_target_basics() {
        assert!(!travels_with_target("2-10813", "9-281")); // planetary hull, fleet target
        assert!(travels_with_target("9-281", "9-281"));
        assert!(travels_with_target("2-10813", "2-10813"));
        assert!(!travels_with_target("", "9-281"));
    }

    #[test]
    fn production_types_are_not_defenders() {
        assert!(PROTECTED_TYPES.contains(&REFINERY_TYPE));
        assert!(PROTECTED_TYPES.contains(&EXTRACTOR_TYPE));
        assert!(PROTECTED_TYPES.contains(&COMMAND_SHIP_TYPE));
    }
}
