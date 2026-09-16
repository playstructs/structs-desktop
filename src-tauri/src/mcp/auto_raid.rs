//! Native raid target-selection loop — the offensive half of autonomous combat.
//!
//! ## What the data says raiding actually is
//!
//! From every raid episode in `planet_activity` (1,550 status rows, 2026-03 →
//! 2026-09-16; the 92 terminal raids since chain v0.21.0 on 2026-08-24 are the
//! ones the current defaults are tuned on):
//!
//! * **A raid that never opens never wins.** 0 of 63 raids that never reached
//!   `shieldsVulnerable` seized anything, in every era. But since v0.21.0
//!   **20 of the 24 successes were SIEGES** — the attacker killed the
//!   defender's Command Ship itself — and they carried 9,351 of 10,109 ore.
//!   Walk-ins onto an already-open planet: 4 wins, 758 ore. So the loop
//!   sieges by default; "only already-vulnerable targets" is the cautious
//!   posture, not the norm.
//! * **Loot moved from lottery to prize.** Successful raids now take a median
//!   of 401 ore (1 of 24 seized nothing); before v0.21 the median was 1. The
//!   one gate that matters is `min_ore`.
//! * **Defended targets are where the ore is.** Targets with 12+ defence edges
//!   went 11 wins / 6 defeats / 3 retreats and held all the big piles; a
//!   defender-count cap would have excluded every large haul. Defensive
//!   pressure is SCORED, never gated.
//! * **An active defender is worth more, not less.** Owners who acted in the
//!   30 minutes before the raid: 63 ore per attempt; owners idle a day: 25.
//!   The "skip awake defenders" gate declined the best targets.
//! * **Hour of day is noise** once the raider is a bot: the old 15–20 UTC
//!   sweet spot inverted after July. Gone.
//! * **Shield strength does NOT predict the outcome.** It is the proof timer,
//!   not a defence, so it counts against a target only as time exposed.
//! * **Our own waste was the raider that could not shoot.** 27 of our 31
//!   retreats since v0.21 were one raider flying to the same 2-ore grudge
//!   target, sitting 54 minutes without a single viable shot, coming home, and
//!   going straight back after the cooldown. Dispatch now refuses a raider
//!   with no viable shot into the Command Ship's ambit, a siege that cannot
//!   fire aborts within three scans, and every failed attempt doubles that
//!   planet's cooldown.
//!
//! ## Shape
//!
//! Four phases per tick, deliberately one raider at a time:
//! A refresh candidates → B score & gate → C dispatch → D supervise/retreat.
//! Phases B and C are pure functions over a snapshot ([`score`], [`gate`]), so
//! the scoring policy is unit-testable without a chain.
//!
//! Off by default, `advise` autonomy even once enabled: it will rank targets and
//! tell you what it would do long before it signs anything.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::hasher::types::now_millis;
use crate::mcp::auto_response::Autonomy;
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_raid.json";

/// Measured mean block time over the last 7 days of chain history. Used to turn
/// the raid proof's block cost into wall-clock minutes for the gates.
pub const BLOCK_SECONDS: f64 = 5.76;

/// Ore pile that counts as "the jackpot" when normalising the prize term.
/// Successful raids since chain v0.21.0 take a median of 401 ore (max 1,059).
const ORE_SCALE: f64 = 400.0;

/// How long a swept candidate roster stays fresh. Identity and guild rarely
/// change; the expensive per-target reads happen in `evaluate`, not here.
const ROSTER_TTL_SECS: f64 = 6.0 * 3600.0;
/// LCD list pages walked when the perception snapshot has not loaded yet —
/// the fallback path only. 30 pages × 100 = the whole galaxy.
const SWEEP_FALLBACK_PAGES: usize = 30;
/// Candidates evaluated per scan (four reads each). The vetoed universe is a
/// few hundred players, so this covers all of it every scan.
const EVALUATE_PER_SCAN: usize = 400;
/// Consecutive siege rounds that fire nothing before the expedition is called
/// off. A raider parked at a target it cannot shoot is the single largest
/// waste in the record (27 trips × 54 minutes, zero shots).
const SIEGE_IDLE_ROUNDS: usize = 3;
/// Blocks a cautious (no-siege) raider waits for a closed window to reopen.
const ONGOING_GRACE_BLOCKS: u64 = 60;
/// A failed attempt doubles the target's cooldown, up to 2^this.
const MAX_COOLDOWN_DOUBLINGS: u32 = 4;
/// Difficulty the raid proof is expected to decay to before it is worth
/// hashing — only used to turn a shield into "minutes exposed" for the score.
const RAID_PROOF_DIFFICULTY: u64 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RaidPosture {
    /// Only near-certain, high-value windows.
    Cautious,
    /// The data-backed middle: vulnerable targets with a real pile.
    #[default]
    Opportunist,
    /// Will manufacture windows and accept thin piles.
    Aggressive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoRaidConfig {
    pub enabled: bool,
    pub autonomy: Autonomy,
    /// Scan cadence. Also the siege cadence: each supervise pass fires at most
    /// one round per expedition.
    pub interval_secs: u64,
    /// Preset that rewrites the gates below in one move. Explicit edits to the
    /// individual gates survive until the posture is set again. `cautious` is
    /// the only posture that will not siege: it raids open windows only.
    pub posture: RaidPosture,

    // ── Gates ──
    /// A raid seizes ALL of the target's stored ore, so this is the whole prize.
    pub min_ore: f64,
    /// 0..100 blended score floor.
    pub min_score: f64,
    /// Recall the raider this many minutes after dispatch, whatever state the
    /// raid is in. Successful raids since v0.21.0 finished in a median of 19
    /// minutes (p90 36, max 91); retreats that ran long won nothing.
    pub give_up_after_mins: u32,

    // ── Fleet management ──
    pub max_concurrent_raids: usize,
    /// Per-target planet cooldown after any attempt. Doubles per consecutive
    /// failure on that planet (up to 16×) and resets on a seize.
    pub target_cooldown_mins: u32,

    // ── Scoring weights (the playstyle dial) ──
    pub w_ore: f64,
    /// Window already open now (no siege needed).
    pub w_opening: f64,
    /// Little return fire, few defenders, a short proof.
    pub w_weakness: f64,
    /// Grudge heat or priority-guild weight, whichever is higher.
    pub w_grudge: f64,
}

impl Default for AutoRaidConfig {
    fn default() -> Self {
        let mut c = Self {
            enabled: false,
            autonomy: Autonomy::Advise,
            interval_secs: 120,
            posture: RaidPosture::Opportunist,
            min_ore: 5.0,
            min_score: 40.0,
            give_up_after_mins: 60,
            max_concurrent_raids: 2,
            target_cooldown_mins: 120,
            w_ore: 1.0,
            w_opening: 1.0,
            w_weakness: 0.6,
            w_grudge: 0.6,
        };
        c.apply_posture(RaidPosture::Opportunist);
        c
    }
}

impl AutoRaidConfig {
    /// Rewrite the gates from a posture preset. Mirrors how
    /// `doctrine::preset_bundle` works: the preset is a starting point, and any
    /// field the operator sets afterwards wins until the posture is set again.
    pub fn apply_posture(&mut self, p: RaidPosture) {
        self.posture = p;
        let (min_ore, min_score, give_up) = match p {
            RaidPosture::Cautious => (30.0, 60.0, 30),
            RaidPosture::Opportunist => (5.0, 40.0, 60),
            RaidPosture::Aggressive => (1.0, 25.0, 90),
        };
        self.min_ore = min_ore;
        self.min_score = min_score;
        self.give_up_after_mins = give_up;
    }

    /// May a raider open the window itself by killing the defender's Command
    /// Ship? Everything but `cautious`. Since v0.21.0 this is how 20 of 24
    /// successful raids happened.
    pub fn sieges(&self) -> bool {
        self.posture != RaidPosture::Cautious
    }
}

static CONFIG: LazyLock<RwLock<AutoRaidConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config::<AutoRaidConfig>(FILENAME)));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
/// The last scan's funnel — scored → eligible → dispatching, and the gate
/// that stopped the most — for the Game Stats window.
static LAST_FUNNEL: LazyLock<Mutex<serde_json::Value>> = LazyLock::new(|| Mutex::new(serde_json::Value::Null));

pub fn last_funnel() -> serde_json::Value {
    LAST_FUNNEL.lock().map(|f| f.clone()).unwrap_or(serde_json::Value::Null)
}

fn note_funnel(scanned: usize, eligible: usize, dispatching: bool, top_gate: Option<(&str, usize)>) {
    if let Ok(mut f) = LAST_FUNNEL.lock() {
        *f = serde_json::json!({
            "at_ms": now_millis(), "scored": scanned, "eligible": eligible, "dispatching": dispatching,
            "top_gate": top_gate.map(|(g, n)| serde_json::json!({ "gate": g, "count": n })),
        });
    }
}
static RUNNING: AtomicBool = AtomicBool::new(false);
static RUN_GEN: AtomicU64 = AtomicU64::new(0);

pub fn get() -> AutoRaidConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: AutoRaidConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}

// ─────────────────────────────── state ──────────────────────────────────────

/// One swept candidate: (player_id, guild_id).
/// (player, guild id or "" when unknown). The player is parsed once, where
/// the roster is built; a guild may legitimately be unknown for a grudge.
type RosterEntry = (crate::mcp::types::PlayerId, String);
/// Swept roster of non-team players worth evaluating, with its fetch timestamp.
static ROSTER: LazyLock<Mutex<(f64, Vec<RosterEntry>)>> =
    LazyLock::new(|| Mutex::new((0.0, Vec::new())));
/// Round-robin cursor into ROSTER, so a bounded per-scan budget still covers
/// the whole galaxy over time instead of re-reading the same head every tick.
static SWEEP_CURSOR: AtomicU64 = AtomicU64::new(0);
/// Last scored board, newest first — what the WAR page's TARGET BOARD renders.
static BOARD: LazyLock<Mutex<Vec<Candidate>>> = LazyLock::new(|| Mutex::new(Vec::new()));
/// planet_id -> last attempt ms, for `target_cooldown_mins`.
static TARGET_COOLDOWN: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Our own outcome ledger per target planet: (attempts, wins).
static HISTORY: LazyLock<Mutex<HashMap<String, (u32, u32)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Consecutive failures per target planet. Each one doubles the cooldown, so
/// the loop backs off a target it keeps bouncing off instead of re-flying the
/// same losing trip every two hours.
static FAIL_STREAK: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Expeditions currently in flight, keyed by raider player id.
static ACTIVE: LazyLock<Mutex<HashMap<String, Expedition>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

// ── Survives a restart ──────────────────────────────────────────────────────
// What the loop REMEMBERS, as opposed to what it is configured to do: the
// swept roster (the 800-player sweep is the loop's limiter), the last scored
// board, per-target cooldowns and the win ledger, and — the one that matters
// for correctness — the expeditions in flight. A restart used to forget every
// fleet that was away, and reset every cooldown so the same planet could be
// hit again at once.
const RAID_CACHE: &str = "auto_raid_memory";
static RESTORED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[derive(Default, Serialize, serde::Deserialize)]
#[serde(default)]
struct RaidMemory {
    roster_at_ms: f64,
    roster: Vec<RosterEntry>,
    board: Vec<Candidate>,
    cooldown: HashMap<String, f64>,
    history: HashMap<String, (u32, u32)>,
    /// Consecutive failed attempts per target planet; drives the cooldown.
    fail_streak: HashMap<String, u32>,
    active: HashMap<String, Expedition>,
}

fn ensure_restored() {
    RESTORED.get_or_init(|| {
        let Some(m) = crate::mcp::cache_store::load::<RaidMemory>(RAID_CACHE) else { return };
        if let Ok(mut r) = ROSTER.lock() {
            if r.1.is_empty() {
                *r = (m.roster_at_ms, m.roster);
            }
        }
        if let Ok(mut b) = BOARD.lock() {
            if b.is_empty() {
                *b = m.board;
            }
        }
        if let Ok(mut c) = TARGET_COOLDOWN.lock() {
            for (k, v) in m.cooldown {
                c.entry(k).or_insert(v);
            }
        }
        if let Ok(mut h) = HISTORY.lock() {
            for (k, v) in m.history {
                h.entry(k).or_insert(v);
            }
        }
        if let Ok(mut f) = FAIL_STREAK.lock() {
            for (k, v) in m.fail_streak {
                f.entry(k).or_insert(v);
            }
        }
        if let Ok(mut a) = ACTIVE.lock() {
            for (k, v) in m.active {
                a.entry(k).or_insert(v);
            }
        }
    });
}

fn persist_memory() {
    let (roster_at_ms, roster) = ROSTER.lock().map(|r| r.clone()).unwrap_or_default();
    let m = RaidMemory {
        roster_at_ms,
        roster,
        board: BOARD.lock().map(|b| b.clone()).unwrap_or_default(),
        cooldown: TARGET_COOLDOWN.lock().map(|c| c.clone()).unwrap_or_default(),
        history: HISTORY.lock().map(|h| h.clone()).unwrap_or_default(),
        fail_streak: FAIL_STREAK.lock().map(|f| f.clone()).unwrap_or_default(),
        active: ACTIVE.lock().map(|a| a.clone()).unwrap_or_default(),
    };
    crate::mcp::cache_store::save_in_background(RAID_CACHE, m);
}

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Expedition {
    pub raider_player: String,
    pub raider_index: u32,
    pub fleet_id: String,
    pub home_planet: String,
    pub target_planet: String,
    pub target_player: String,
    pub started_ms: f64,
    /// Set once the raid proof has been kicked off.
    pub hashing: bool,
    /// First block at which we saw the target's shields back up.
    pub ongoing_since_block: Option<u64>,
    /// Shots spent so far trying to open the window by force.
    pub siege_shots: usize,
    /// Consecutive siege rounds that could not fire. `SIEGE_IDLE_ROUNDS` of
    /// them end the expedition.
    pub idle_rounds: usize,
    pub note: String,
}

/// One scored raid target.
// No struct-level Default: a candidate without a player is not a candidate,
// so `player_id` is required and every other field defaults on its own.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Candidate {
    pub player_id: crate::mcp::types::PlayerId,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub guild_id: String,
    #[serde(default)]
    pub planet_id: String,
    #[serde(default)]
    pub fleet_id: String,
    /// The prize — a raid takes all of it.
    #[serde(default)]
    pub stored_ore: f64,
    /// Ore left in the target PLANET's crust. A raid dies if the defender
    /// re-planets, and a planet is exhaustible — see the `gate` that reads this.
    #[serde(default)]
    pub planet_ore_remaining: f64,
    /// A fleet already parked at the target, if any. Someone else's raid.
    #[serde(default)]
    pub occupied_by: Option<String>,
    #[serde(default)]
    pub planetary_shield: u64,
    /// Minutes until the raid proof decays to `raid_difficulty`.
    #[serde(default)]
    pub raid_minutes: f64,
    #[serde(default)]
    pub vulnerable: bool,
    #[serde(default)]
    pub vulnerability_reason: String,
    #[serde(default)]
    pub command_struct: Option<String>,
    /// The ambit the target's Command Ship STANDS in. A Command Ship may sit in
    /// any of water/land/air/space, and a raider that cannot put a viable shot
    /// into that ambit has flown out for nothing — see `dispatch`.
    #[serde(default)]
    pub command_ambit: String,
    #[serde(default)]
    pub defenders_on_cmd: usize,
    /// Occupied fleet slots — a crude but effective measure of return fire.
    #[serde(default)]
    pub enemy_fleet_structs: usize,
    #[serde(default)]
    pub last_action_block: u64,
    #[serde(default)]
    pub blocks_since_action: u64,
    #[serde(default)]
    pub score: f64,
    /// `None` = GO. `Some(reason)` = NO-GO, shown verbatim on the board.
    #[serde(default)]
    pub blocked_by: Option<String>,
}

pub fn target_board() -> Vec<Candidate> {
    ensure_restored();
    BOARD.lock().map(|b| b.clone()).unwrap_or_default()
}

pub fn active_expeditions() -> Vec<Expedition> {
    ensure_restored();
    ACTIVE.lock().map(|a| a.values().cloned().collect()).unwrap_or_default()
}

// ───────────────────────────── pure scoring ─────────────────────────────────

/// Blocks until a raid proof against a planet with `shield` decays to
/// `difficulty`. The chain's decay is
/// `difficulty = 64 − floor(log10(age)/log10(range) × 63)` with `range` = the
/// planet's `planetaryShield`, so the inverse is `age = shield^((64−d)/63)`.
/// A shield of 125 therefore reaches difficulty 1 at age 125 blocks, which is
/// exactly what the docs state.
pub fn raid_ready_blocks(shield: u64, difficulty: u64) -> f64 {
    let range = shield.max(2) as f64; // log10(1) = 0 would divide by zero
    let d = difficulty.clamp(1, 64) as f64;
    range.powf((64.0 - d) / 63.0)
}

/// The same figure in wall-clock minutes.
pub fn raid_ready_minutes(shield: u64, difficulty: u64) -> f64 {
    raid_ready_blocks(shield, difficulty) * BLOCK_SECONDS / 60.0
}

/// Score a candidate 0..100 under `cfg`. Pure — no chain, no clock.
///
/// Each term is normalised to 0..1 and then weighted, and the total is divided
/// by the sum of the weights, so re-weighting changes the *ordering* without
/// silently moving the `min_score` goalposts.
pub fn score(c: &Candidate, cfg: &AutoRaidConfig) -> f64 {
    let ore_term = (c.stored_ore.max(0.0) + 1.0).ln() / (ORE_SCALE + 1.0).ln();
    // An open window is a raid we can start proving on arrival; a closed one
    // is a siege first. Partial credit only when this posture will siege —
    // a cautious loop cannot use a closed window at all.
    let opening_term = if c.vulnerable {
        1.0
    } else if cfg.sieges() {
        0.4
    } else {
        0.0
    };
    // Defensive pressure: registered defenders on the Command Ship, the size of
    // the fleet that would shoot back, and how long the proof keeps us exposed
    // (the shield is a timer, not a defence — a 325 shield is ~40 minutes on
    // station). Scored, never gated: the richest targets in the record were
    // the best defended.
    let pressure = ((c.defenders_on_cmd as f64) / 8.0
        + (c.enemy_fleet_structs as f64) / 16.0
        + c.raid_minutes.max(0.0) / 120.0)
        .min(1.0);
    let weakness_term = 1.0 - pressure;
    // Personal grudge or standing priority on the whole guild, whichever the
    // operator has set higher.
    let grudge_term = crate::mcp::combat_lists::grudge_heat(c.player_id.as_str())
        .max(crate::mcp::combat_lists::guild_weight(Some(&c.guild_id)))
        .min(1.0);

    let terms = [
        (cfg.w_ore, ore_term),
        (cfg.w_opening, opening_term),
        (cfg.w_weakness, weakness_term),
        (cfg.w_grudge, grudge_term),
    ];
    let total_w: f64 = terms.iter().map(|(w, _)| w.max(0.0)).sum();
    if total_w <= 0.0 {
        return 0.0;
    }
    let sum: f64 = terms.iter().map(|(w, t)| w.max(0.0) * t.clamp(0.0, 1.0)).sum();
    (100.0 * sum / total_w).clamp(0.0, 100.0)
}

/// Hard gates, evaluated BEFORE the score so nothing can outrank a veto.
/// Returns `None` for GO, or the reason it's a NO-GO.
/// Does this player's PROFILE let it fly raids?
///
/// Replaces three separate `role == Raider` literals. The built-in `raider`
/// profile sets `raids: true` and nothing else does, so the reading is
/// unchanged until an author says otherwise — but a player can now define, say,
/// a productive profile that also raids, without a new enum variant.
fn raids(p: &crate::mcp::virtual_players::VirtualPlayer) -> bool {
    crate::mcp::profile::for_player(p.profile.as_deref(), Some(p.role))
        .capabilities
        .raids
}

pub fn gate(c: &Candidate, cfg: &AutoRaidConfig, cooldown_remaining_mins: f64) -> Option<String> {
    // Friend-or-foe first: our own accounts, allied guilds and protected players
    // are never targets, whatever they're holding.
    if crate::mcp::combat_lists::is_vetoed(c.player_id.as_str(), Some(&c.guild_id)) {
        return Some("vetoed (own team, allied guild, or protected)".into());
    }
    if c.planet_id.is_empty() {
        return Some("no planet".into());
    }
    if c.stored_ore < cfg.min_ore {
        return Some(format!("ore {:.0} < min_ore {:.0}", c.stored_ore, cfg.min_ore));
    }
    // Someone is already parked here. A planet runs ONE raid at a time — and
    // as of chain v0.21.0 the enemy-fleet queue is CAPPED at one: a second
    // arrival is turned around and sent home by the chain itself. The trip is
    // a pure loss — travel out and back with the raider's OWN planet exposed
    // the whole time.
    if let Some(fid) = &c.occupied_by {
        return Some(format!("fleet {fid} is already raiding here — a second fleet is inert"));
    }
    // A raid that never opens never wins (0 of 63 in the record). Cautious
    // will not open one itself, so it only flies at windows already open; the
    // other postures siege, which is where 20 of the last 24 successes came
    // from.
    if !cfg.sieges() && !c.vulnerable {
        return Some("shields up — cautious posture raids only open windows".into());
    }
    if cooldown_remaining_mins > 0.0 {
        return Some(format!("target cooldown, {:.0} min left", cooldown_remaining_mins));
    }
    None
}

// ─────────────────────────────── the loop ───────────────────────────────────

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
    let run = crate::mcp::telemetry::LoopRun::start("auto_raid");
    ensure_restored();
    scan(app_handle, &cfg, &run).await;
    persist_memory();
    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-scan".into()));
        return;
    }
    run.finish(None);
    if run.errors.load(Ordering::Relaxed) == 0 {
        crate::mcp::loop_util::report_clean_scan();
    }
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(
    app: &tauri::AppHandle,
    cfg: &AutoRaidConfig,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) {
    let client = CosmosClient::new();
    crate::mcp::combat_lists::prune_expired();

    // Seed the ally veto with our own guild the first time we know it.
    if let Some(g) = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone()) {
        crate::mcp::combat_lists::seed_own_guild(&g);
    }

    // ── Phase D first: an expedition already in flight outranks new targets. ──
    // Recover anything that was in flight across a restart before supervising,
    // or the raider sits at the enemy planet forever.
    static READOPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !READOPTED.swap(true, Ordering::Relaxed) {
        readopt_expeditions(&client).await;
    }
    supervise(app, &client, cfg, run).await;

    // ── Is there anyone to send? ──
    // Raids are flown only by players whose profile grants `raids`. With none in the
    // registry the loop can never dispatch, whatever the target board says —
    // and it would still report the gate that stopped the most CANDIDATES
    // ("24 stopped at 'ore'"), sending you off to lower min_ore when the real
    // fix is one click of the Armada roster's role control. Report the
    // unconditional blocker first, and skip the scan that cannot be acted on.
    let raider_count = crate::mcp::virtual_players::REGISTRY
        .read()
        .map(|reg| {
            reg.players
                .iter()
                .filter(|p| raids(p))
                .count()
        })
        .unwrap_or(0);
    if raider_count == 0 {
        run.blocked(
            "no players with the `raids` capability — assign a profile that enables it \
             (Armada → select a player → Set role → raider, or Launch one)",
        );
        return;
    }

    // ── Phase A: candidates. ──
    let roster = refresh_roster(&client).await;
    if roster.is_empty() {
        return;
    }
    let batch = next_batch(&roster, EVALUATE_PER_SCAN);

    // ── Phase B: evaluate + score. ──
    let client_c = client.clone();
    let mut board: Vec<Candidate> = crate::mcp::loop_util::map_concurrent(
        batch,
        crate::mcp::capacity::reads_fanout(),
        move |(pid, guild)| {
            let client = client_c.clone();
            async move { evaluate(&client, &pid, &guild).await }
        },
    )
    .await
    .into_iter()
    .flatten()
    .collect();

    for c in board.iter_mut() {
        run.players.fetch_add(1, Ordering::Relaxed);
        c.score = score(c, cfg);
        c.blocked_by = gate(c, cfg, cooldown_remaining_mins(&c.planet_id, cfg.target_cooldown_mins));
    }
    board.sort_by(|a, b| {
        a.blocked_by
            .is_some()
            .cmp(&b.blocked_by.is_some())
            .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    if let Ok(mut b) = BOARD.lock() {
        *b = board.clone();
    }

    // ── Phase C: dispatch the best GO, if we have room and a raider. ──
    // Every early return below is a DIFFERENT reason the loop did nothing, and
    // all of them used to leave the loop reporting "running normally" — 13 runs
    // that scored 25 candidates and dispatched nothing looked identical to a
    // healthy idle loop. Each one now says why (see telemetry::LoopRun::blocked).
    let scanned = board.len();
    // Every candidate that cleared the GATES and the score floor. The gates are
    // absolute — vetoed players, occupied planets, exhausted crusts and closed
    // windows never reach this list — so anything here is a legal raid, and the
    // pick among them is a matter of taste rather than legality.
    let eligible: Vec<&Candidate> = board
        .iter()
        .filter(|c| c.blocked_by.is_none() && c.score >= cfg.min_score)
        .collect();
    // Raiders choose with a raider's temperament. At temperature 0 this is the
    // top-scoring candidate, exactly as before; warmer spreads our pressure
    // across the board instead of hammering one planet into its cooldown.
    let best = crate::mcp::variance::pick_now(
        &eligible,
        |c| c.score,
        &crate::mcp::variance::for_role(Some(crate::mcp::virtual_players::VPlayerRole::Raider)),
        // TODO(profile): once dispatch resolves its raider before scoring, take
        // the temperament from that player's own profile instead of the role.
    )
    .map(|i| eligible[i])
    .or_else(|| board
        .iter()
        .find(|c| c.blocked_by.is_none() && c.score >= cfg.min_score))
        .cloned();
    {
        let mut tally: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for c in &board {
            if let Some(why) = c.blocked_by.as_deref() {
                *tally.entry(why.split_whitespace().next().unwrap_or(why)).or_default() += 1;
            }
        }
        let top = tally.iter().max_by_key(|(_, n)| **n).map(|(k, n)| (*k, *n));
        note_funnel(scanned, eligible.len(), best.is_some(), top);
    }
    let Some(target) = best else {
        if scanned == 0 {
            run.blocked("no candidate planets in range this scan");
        } else {
            // Name the gate that actually stopped the most targets — "25
            // blocked" is not actionable, "all 25 hold less than min_ore 15" is.
            let mut tally: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
            let mut passed_gates_but_low_score = 0usize;
            for c in &board {
                match c.blocked_by.as_deref() {
                    Some(why) => {
                        // Collapse "ore 0 < min_ore 15" to its gate name.
                        let key = why.split_whitespace().next().unwrap_or(why);
                        *tally.entry(key).or_default() += 1;
                    }
                    None => passed_gates_but_low_score += 1,
                }
            }
            let top = tally.iter().max_by_key(|(_, n)| **n).map(|(k, n)| (*k, *n));
            match top {
                Some((gate_name, n)) => run.blocked(format!(
                    "{scanned} scored, none dispatchable — {n} stopped at '{gate_name}'{}",
                    if passed_gates_but_low_score > 0 {
                        format!(", {passed_gates_but_low_score} passed the gates but scored under min_score {}", cfg.min_score)
                    } else {
                        String::new()
                    }
                )),
                None => run.blocked(format!(
                    "{scanned} scored and all passed the gates, but none reached min_score {}",
                    cfg.min_score
                )),
            }
        }
        return;
    };

    let in_flight = ACTIVE.lock().map(|a| a.len()).unwrap_or(0);
    if in_flight >= cfg.max_concurrent_raids {
        run.blocked(format!(
            "{in_flight} raid(s) already in flight (max_concurrent_raids {})",
            cfg.max_concurrent_raids
        ));
        return;
    }

    if cfg.autonomy == Autonomy::Advise {
        crate::mcp::board_feed::push(
            app,
            crate::mcp::board_feed::Severity::Notice,
            "auto_raid",
            format!(
                "GO recommendation: {} ({}) — {:.0} ore, shield {} (~{:.0} min proof), {} defenders, score {:.0}. {}",
                target.name,
                target.planet_id,
                target.stored_ore,
                target.planetary_shield,
                target.raid_minutes,
                target.defenders_on_cmd,
                target.score,
                target.vulnerability_reason
            ),
        );
        return;
    }

    match dispatch(app, &client, cfg, &target).await {
        Ok(msg) => {
            run.acted();   // clears any blocked reason from an earlier scan
            run.actions.fetch_add(1, Ordering::Relaxed);
            crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Important, "auto_raid", msg);
        }
        Err(e) => {
            run.errors.fetch_add(1, Ordering::Relaxed);
            crate::mcp::telemetry::tlog(
                "auto_raid",
                crate::mcp::telemetry::Sev::Warn,
                format!("dispatch to {} failed: {}", target.planet_id, e),
            );
        }
    }
}

/// Sweep the perception snapshot (or, before it loads, the chain's player
/// list) into a cached roster of non-team candidates. Long-lived
/// (`ROSTER_TTL_SECS`): identity and guild rarely change, and the expensive
/// per-target reads happen in `evaluate`, not here.
async fn refresh_roster(client: &CosmosClient) -> Vec<RosterEntry> {
    {
        let cache = ROSTER.lock().unwrap();
        if !cache.1.is_empty() && now_millis() - cache.0 < ROSTER_TTL_SECS * 1000.0 {
            return cache.1.clone();
        }
    }
    let mut out: Vec<RosterEntry> = Vec::new();
    let consider = |out: &mut Vec<RosterEntry>, p: &serde_json::Value| {
        let Some(id) = p.get("id").and_then(|x| x.as_str()) else { return };
        let Ok(pid) = crate::mcp::types::PlayerId::parse(id) else { return };
        // A player with no planet has nothing to raid.
        if p.get("planetId").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
            return;
        }
        let guild = p.get("guildId").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if crate::mcp::combat_lists::is_vetoed(id, Some(&guild)) {
            return;
        }
        out.push((pid, guild));
    };
    // The whole player table is in the perception snapshot (every player,
    // GRASS-fresh); walking the chain's player store in pages of 100 — up to
    // `SWEEP_FALLBACK_PAGES` LCD requests per roster — is only the fallback
    // for a snapshot that has not loaded yet.
    let from_snapshot: Vec<serde_json::Value> =
        crate::mcp::perception::with_snapshot(|s| s.players.values().cloned().collect()).unwrap_or_default();
    if !from_snapshot.is_empty() {
        for p in &from_snapshot {
            consider(&mut out, p);
        }
    } else {
        let mut key: Option<String> = None;
        for _ in 0..SWEEP_FALLBACK_PAGES {
            let Ok(page) = client.list_entities("player", key.as_deref(), Some(100)).await else { break };
            if let Some(arr) = page.get("Player").and_then(|x| x.as_array()) {
                for p in arr {
                    consider(&mut out, p);
                }
            }
            key = page
                .get("pagination")
                .and_then(|x| x.get("next_key"))
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            if key.is_none() {
                break;
            }
        }
    }
    // Anyone we hold a grudge against is always a candidate, even if the bounded
    // sweep never reached their page.
    for g in crate::mcp::combat_lists::get().grudges {
        if g.muted || out.iter().any(|(id, _)| id.as_str() == g.player_id) {
            continue;
        }
        let Ok(pid) = crate::mcp::types::PlayerId::parse(&g.player_id) else { continue };
        out.push((pid, g.guild_id.clone().unwrap_or_default()));
    }
    if !out.is_empty() {
        *ROSTER.lock().unwrap() = (now_millis(), out.clone());
    }
    out
}

/// Take the next `n` roster entries round-robin, so a bounded per-scan budget
/// still sweeps the whole galaxy over successive ticks. Grudge-listed players
/// jump the queue — they're the reason the list exists.
fn next_batch(roster: &[RosterEntry], n: usize) -> Vec<RosterEntry> {
    if roster.is_empty() {
        return vec![];
    }
    let n = n.max(1).min(roster.len());
    let mut out: Vec<RosterEntry> = Vec::with_capacity(n);
    let lists = crate::mcp::combat_lists::get();
    for (id, guild) in roster {
        if out.len() >= n {
            break;
        }
        if lists.grudges.iter().any(|g| g.player_id == id.as_str() && !g.muted) {
            out.push((id.clone(), guild.clone()));
        }
    }
    let start = SWEEP_CURSOR.fetch_add(n as u64, Ordering::Relaxed) as usize;
    for i in 0..roster.len() {
        if out.len() >= n {
            break;
        }
        let e = &roster[(start + i) % roster.len()];
        if !out.iter().any(|(id, _)| *id == e.0) {
            out.push(e.clone());
        }
    }
    out
}

/// Resolve everything the gates and score need for one candidate.
/// Four reads: player, planet, fleet, Command Ship.
async fn evaluate(client: &CosmosClient, player_id: &crate::mcp::types::PlayerId, guild_id: &str) -> Option<Candidate> {
    use crate::mcp::types::EntityView;
    let pl = client.entity("player", player_id.as_str()).await.ok()?;
    let p = pl.get("Player")?;
    let planet_id = p.get("planetId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let fleet_id = p.get("fleetId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if planet_id.is_empty() {
        return None;
    }
    let pv = EntityView::new(&pl);
    let stored_ore = pv.grid_f64("ore");
    let last_action = pv.last_action().get();
    let current_block = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.current_block_height)
        .unwrap_or(0);

    let planet = client.entity("planet", &planet_id).await.ok()?;
    let planetary_shield = EntityView::new(&planet).planet_attr_u64("planetaryShield");
    let planet_ore_remaining = EntityView::new(&planet).grid_f64("ore");
    // Is somebody else already raiding here? A planet hosts ONE raid: a second
    // fleet that arrives is completely inert — it creates no raid, cannot
    // attack, and cannot be attacked. Verified live on 2-7324, where a third
    // party's Tank and the defender's Mobile Artillery each rejected the other
    // as "unreachable" while both stood on the planet.
    //
    // The visitor list is left DANGLING when a fleet departs (`locationListLast`
    // keeps naming it), so confirm the fleet is really still there rather than
    // trusting the pointer.
    let occupied_by = match planet
        .get("Planet")
        .and_then(|p| p.get("locationListStart"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        Some(fid) => client
            .entity("fleet", fid)
            .await
            .ok()
            .filter(|f| {
                f.get("Fleet")
                    .and_then(|x| x.get("locationId"))
                    .and_then(|x| x.as_str())
                    == Some(planet_id.as_str())
            })
            .map(|_| fid.to_string()),
        None => None,
    };

    // ── Vulnerability: the chain's IsDefenderCommandStructVulnerable(), which is
    // the single variable that decides whether a raid can complete at all. ──
    let mut reasons: Vec<&str> = Vec::new();
    let mut command_struct: Option<String> = None;
    let mut command_ambit = String::new();
    let mut enemy_fleet_structs = 0usize;
    if fleet_id.is_empty() {
        reasons.push("no fleet");
    } else if let Ok(fl) = client.entity("fleet", &fleet_id).await {
        let f = fl.get("Fleet");
        let on_station = f.and_then(|x| x.get("status")).and_then(|x| x.as_str()) == Some("onStation")
            && f.and_then(|x| x.get("locationId")).and_then(|x| x.as_str()) == Some(planet_id.as_str());
        if !on_station {
            reasons.push("fleet off-station");
        }
        for ambit in ["land", "water", "air", "space"] {
            if let Some(arr) = f.and_then(|x| x.get(ambit)).and_then(|a| a.as_array()) {
                enemy_fleet_structs += arr.iter().filter(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false)).count();
            }
        }
        command_struct = f
            .and_then(|x| x.get("commandStruct"))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        match &command_struct {
            None => reasons.push("no Command Ship"),
            Some(cs) => {
                if let Ok(e) = client.entity("struct", cs).await {
                    let sa = e.get("structAttributes");
                    command_ambit = e
                        .get("Struct")
                        .and_then(|x| x.get("operatingAmbit"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isDestroyed"))) {
                        reasons.push("Command Ship destroyed");
                    } else if !crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isOnline"))) {
                        reasons.push("Command Ship offline");
                    }
                }
            }
        }
    }
    let vulnerable = !reasons.is_empty();

    // Defenders registered on the Command Ship — what a siege would have to strip.
    let defenders_on_cmd = match &command_struct {
        Some(cs) => client
            .guild
            .struct_defender_by_protected(cs, 1)
            .await
            .map(|p| p.items.len())
            .unwrap_or(0),
        None => 0,
    };

    Some(Candidate {
        player_id: player_id.clone(),
        name: p
            .get("name")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(player_id.as_str())
            .to_string(),
        guild_id: guild_id.to_string(),
        planet_id,
        fleet_id,
        stored_ore,
        planet_ore_remaining,
        occupied_by,
        planetary_shield,
        raid_minutes: raid_ready_minutes(planetary_shield, RAID_PROOF_DIFFICULTY),
        vulnerable,
        vulnerability_reason: if vulnerable {
            format!("VULNERABLE — {}", reasons.join(", "))
        } else {
            "shields up (Command Ship online, fleet on station)".to_string()
        },
        command_struct,
        command_ambit,
        defenders_on_cmd,
        enemy_fleet_structs,
        last_action_block: last_action,
        blocks_since_action: crate::mcp::types::Block::new(current_block).since(crate::mcp::types::Block::new(last_action)),
        score: 0.0,
        blocked_by: None,
    })
}

/// Minutes of cooldown left on a target. The configured cooldown doubles for
/// every consecutive failed attempt on that planet (capped at 2^4 = 16×), so a
/// target we keep bouncing off drifts from two hours to a day and a half
/// instead of being re-flown every two hours forever.
fn cooldown_remaining_mins(planet_id: &str, cooldown_mins: u32) -> f64 {
    let now = now_millis();
    let streak = FAIL_STREAK
        .lock()
        .ok()
        .and_then(|f| f.get(planet_id).copied())
        .unwrap_or(0)
        .min(MAX_COOLDOWN_DOUBLINGS);
    let effective = effective_cooldown_mins(cooldown_mins, streak);
    TARGET_COOLDOWN
        .lock()
        .ok()
        .and_then(|m| m.get(planet_id).copied())
        .map(|t| {
            let elapsed_mins = (now - t) / 60_000.0;
            (effective - elapsed_mins).max(0.0)
        })
        .unwrap_or(0.0)
}

/// Pure: the cooldown after `streak` consecutive failures.
pub fn effective_cooldown_mins(cooldown_mins: u32, streak: u32) -> f64 {
    cooldown_mins as f64 * (1u32 << streak.min(MAX_COOLDOWN_DOUBLINGS)) as f64
}

/// Book the end of an expedition against its target planet.
fn record_outcome(planet_id: &str, won: bool) {
    if won {
        if let Ok(mut h) = HISTORY.lock() {
            h.entry(planet_id.to_string()).or_insert((0, 0)).1 += 1;
        }
        if let Ok(mut f) = FAIL_STREAK.lock() {
            f.remove(planet_id);
        }
    } else if let Ok(mut f) = FAIL_STREAK.lock() {
        *f.entry(planet_id.to_string()).or_insert(0) += 1;
    }
    // The cooldown runs from the END of the attempt, not its dispatch — a
    // 90-minute siege used to come home with most of its cooldown spent.
    if let Ok(mut c) = TARGET_COOLDOWN.lock() {
        c.insert(planet_id.to_string(), now_millis());
    }
}

/// Did the chain already close this expedition as a seize? On `raidSuccessful`
/// the raiding fleet is sent home by the chain, so a fleet found back at its
/// own planet with the raid recorded against it is a win — anything else that
/// ends an expedition is a failure for cooldown purposes.
async fn expedition_won(client: &CosmosClient, ex: &Expedition) -> bool {
    let Ok(raid) = client.guild.planet_raid_active_by_fleet(&ex.fleet_id).await else { return false };
    let r = raid.as_array().and_then(|a| a.first()).cloned().unwrap_or(raid);
    r.get("planet_id").and_then(|x| x.as_str()) == Some(ex.target_planet.as_str())
        && r.get("status").and_then(|x| x.as_str()) == Some("raidSuccessful")
}

/// A raider's own combat hulls, reduced to what readiness needs. Fleet structs
/// only: planetary structs have no weapon reach and cannot travel.
async fn raider_hulls(
    client: &CosmosClient,
    raider_pid: &str,
    fleet_id: &str,
) -> Vec<crate::mcp::readiness::Hull> {
    let structs = crate::mcp::loop_util::player_structs_cached(
        client,
        raider_pid,
        crate::mcp::loop_util::STRUCTS_CACHE_TTL_MS,
    )
    .await;
    let gs = crate::game_state::GAME_STATE.read().unwrap();
    structs
        .iter()
        .filter(|s| {
            !crate::mcp::loop_util::parse_bool(s.get("is_destroyed"))
                && crate::mcp::loop_util::parse_bool(s.get("is_built"))
                && s.get("location_id").and_then(|x| x.as_str()) == Some(fleet_id)
        })
        .filter_map(|s| {
            let id = s.get("id").and_then(|x| x.as_str())?;
            let t = gs.struct_types.get(&crate::mcp::loop_util::extract_type_id(s))?;
            let stands = s
                .get("operating_ambit")
                .and_then(|x| x.as_str())
                .map(crate::mcp::tools::format::ambit_bit)
                .unwrap_or(0);
            crate::mcp::readiness::Hull::from_type(id, stands, t)
        })
        .collect()
}

/// Send a raider to `target`. Phase C proper: pick an idle raider, move its
/// fleet, and register the expedition for Phase D to supervise.
async fn dispatch(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    cfg: &AutoRaidConfig,
    target: &Candidate,
) -> Result<String, String> {
    let (raider_pid, raider_idx) = pick_raider(client).await.ok_or_else(|| {
        "no idle raider available (need a profile with `raids`, a live Command Ship, and a fleet on station)".to_string()
    })?;
    let (fleet_id, home_planet) = raider_location(client, &raider_pid)
        .await
        .ok_or_else(|| format!("could not resolve {}'s fleet", raider_pid))?;

    // Can this raider actually hurt the thing it is being sent to kill?
    // Checked HERE rather than in `gate` because it depends on the raider that
    // was picked, not on the target alone. Not optional: with this check
    // switched off one raider flew 27 round trips to a planet it could not put
    // a shot into, 54 minutes each, and fired nothing.
    if !target.command_ambit.is_empty() {
        let bit = crate::mcp::tools::format::ambit_bit(&target.command_ambit);
        if bit != 0 {
            let hulls = raider_hulls(client, &raider_pid, &fleet_id).await;
            let r = crate::mcp::readiness::assess(&hulls, bit, true);
            if r.blind_mask & bit != 0 {
                let posture = r
                    .per_ambit
                    .first()
                    .map(|a| a.posture.as_str())
                    .unwrap_or("unreachable");
                return Err(format!(
                    "{raider_pid} has no viable shot into {} where {}'s Command Ship sits ({posture}) —                      the trip would leave its own planet raidable and never land a hit",
                    target.command_ambit, target.planet_id
                ));
            }
        }
    }

    crate::mcp::tx_retry::sign_with_retry(
        app,
        raider_idx,
        "/structs.structs.MsgFleetMove",
        json!({ "fleetId": fleet_id, "destinationLocationId": target.planet_id }),
        &format!("auto_raid:{raider_pid}"),
    )
    .await?;

    TARGET_COOLDOWN
        .lock()
        .unwrap()
        .insert(target.planet_id.clone(), now_millis());
    HISTORY
        .lock()
        .unwrap()
        .entry(target.planet_id.clone())
        .or_insert((0, 0))
        .0 += 1;
    ACTIVE.lock().unwrap().insert(
        raider_pid.clone(),
        Expedition {
            raider_player: raider_pid.clone(),
            raider_index: raider_idx,
            fleet_id,
            home_planet,
            target_planet: target.planet_id.clone(),
            target_player: target.player_id.to_string(),
            started_ms: now_millis(),
            hashing: false,
            ongoing_since_block: None,
            siege_shots: 0,
            idle_rounds: 0,
            note: "en route".into(),
        },
    );
    Ok(format!(
        "raider {} dispatched to {} ({}) — {:.0} ore, {}",
        raider_pid, target.planet_id, target.name, target.stored_ore, target.vulnerability_reason
    ))
}

/// An idle raider: role `Raider`, fleet on station at its own planet, Command
/// Ship alive, and not already on an expedition.
async fn pick_raider(client: &CosmosClient) -> Option<(String, u32)> {
    let busy: Vec<String> = ACTIVE.lock().map(|a| a.keys().cloned().collect()).unwrap_or_default();
    let candidates: Vec<(String, u32)> = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().ok()?;
        reg.players
            .iter()
            .filter(|p| raids(p))
            .filter_map(|p| p.player_id.clone().map(|id| (id, p.index)))
            .filter(|(id, _)| !busy.contains(id))
            .collect()
    };
    // Eligible raiders with the ore they are carrying, so the pick can prefer the
    // one with least to lose. Sending a fleet out makes its OWN planet instantly
    // raidable — verified live on 2-7324: a raider arrived and `blockStartRaid`
    // armed the same block, status straight to `shieldsVulnerable`, even though
    // the absent player's Command Ship was alive and undamaged. Being on station
    // is what protects you, not owning a Command Ship somewhere.
    //
    // So every dispatch trades our own exposure for the target's ore, and a
    // raider sitting on a previous haul is the worst one to send.
    let mut eligible: Vec<(String, u32, f64, bool)> = Vec::new();
    for (pid, idx) in candidates {
        let Ok(pl) = client.entity("player", &pid).await else { continue };
        let p = pl.get("Player");
        let fleet = p.and_then(|x| x.get("fleetId")).and_then(|x| x.as_str()).unwrap_or("");
        if fleet.is_empty() {
            continue;
        }
        let Ok(fl) = client.entity("fleet", fleet).await else { continue };
        let f = fl.get("Fleet");
        if f.and_then(|x| x.get("status")).and_then(|x| x.as_str()) != Some("onStation") {
            continue; // already in the field
        }
        // A raider with no Command Ship can neither move nor raid.
        let cmd = f.and_then(|x| x.get("commandStruct")).and_then(|x| x.as_str()).unwrap_or("");
        if cmd.is_empty() {
            continue;
        }
        // ONLINE, not merely undestroyed. A Command Ship that has been rebuilt
        // but whose BUILD proof has not landed sits at `status: 1`
        // (materialized) — `commandStruct` is populated and `isDestroyed` is
        // false, yet the chain refuses the move with "fleet (9-X) needs an
        // online command struct before deploy". Checking only `isDestroyed`
        // picked such a raider and burned a transaction on a certain reject.
        match client.entity("struct", cmd).await {
            Ok(e) => {
                let sa = e.get("structAttributes");
                if crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isDestroyed")))
                    || !crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isOnline")))
                {
                    continue;
                }
            }
            Err(_) => continue,
        }
        let ore = crate::mcp::loop_util::parse_f64(
            pl.get("gridAttributes").and_then(|g| g.get("ore")),
        );
        // Does this raider actually carry the siege kit its doctrine assumes?
        // Mobile Artillery (8) grinds a defended Command Ship with ZERO
        // attrition (counter-immune); the Battleship (2) is the only
        // armour-piercing hull. A raider without either pays 2+ HP per landed
        // shot to stacked counters and loses Tanks every 2-3 shots — the
        // dispatch itself is what should notice, not the siege after arrival.
        let siege_kit = crate::mcp::loop_util::player_structs(client, &pid)
            .await
            .iter()
            .filter(|s| !crate::mcp::loop_util::parse_bool(s.get("is_destroyed")))
            .filter_map(|s| s.get("type").map(|t| t.to_string().trim_matches('"').to_string()))
            .any(|t| t == "8" || t == "2");
        eligible.push((pid, idx, ore, siege_kit));
    }
    // Siege-equipped first, then least ore at risk; ties keep registry order.
    // A preference rather than a hard gate so a young fleet still raids while
    // auto_build converges it toward RAIDER_LOADOUT.
    eligible.sort_by(|a, b| {
        b.3.cmp(&a.3)
            .then(a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
    });
    eligible.into_iter().next().map(|(pid, idx, _, _)| (pid, idx))
}

async fn raider_location(client: &CosmosClient, pid: &str) -> Option<(String, String)> {
    let pl = client.entity("player", pid).await.ok()?;
    let p = pl.get("Player")?;
    let fleet = p.get("fleetId").and_then(|x| x.as_str())?.to_string();
    let planet = p.get("planetId").and_then(|x| x.as_str())?.to_string();
    Some((fleet, planet))
}

/// Re-adopt expeditions that were in flight when the app last stopped.
///
/// `ACTIVE` is in-memory, and so is the PoW task queue — so a restart mid-raid
/// loses both. On-chain the consequences persist: the raid window stays armed
/// and the raider's fleet stays parked at the target, but nothing is grinding a
/// proof and nothing is watching for the abort conditions. Observed live: an
/// app restart during a raid left the window open at `blockStartRaid` with the
/// raider stranded at the enemy planet indefinitely.
///
/// Reality is the source of truth, so reconcile against it rather than trying
/// to persist our own bookkeeping: any Raider whose fleet is somewhere other
/// than its own planet is, by definition, on an expedition. Re-created entries
/// carry `hashing: false`, which is exactly what makes `supervise` restart the
/// proof (or abort and sail home) on the very next pass.
async fn readopt_expeditions(client: &CosmosClient) {
    let raiders: Vec<(String, u32)> = {
        let Ok(reg) = crate::mcp::virtual_players::REGISTRY.read() else { return };
        reg.players
            .iter()
            .filter(|p| raids(p))
            .filter_map(|p| p.player_id.clone().map(|id| (id, p.index)))
            .collect()
    };
    for (pid, idx) in raiders {
        if ACTIVE.lock().map(|a| a.contains_key(&pid)).unwrap_or(true) {
            continue; // already tracked
        }
        let Some((fleet_id, home_planet)) = raider_location(client, &pid).await else { continue };
        let Ok(fl) = client.entity("fleet", &fleet_id).await else { continue };
        let where_now = fl
            .get("Fleet")
            .and_then(|x| x.get("locationId"))
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        if where_now.is_empty() || where_now == home_planet {
            continue; // at home — nothing in flight
        }
        let target_player = client
            .entity("planet", &where_now)
            .await
            .ok()
            .and_then(|e| {
                e.get("Planet")
                    .and_then(|p| p.get("owner"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        ACTIVE.lock().unwrap().insert(
            pid.clone(),
            Expedition {
                raider_player: pid.clone(),
                raider_index: idx,
                fleet_id,
                home_planet,
                target_planet: where_now.clone(),
                target_player,
                // Unknown — treat as just-started so the wall-clock abort gives
                // the re-adopted raid a full window rather than killing it at
                // once for time it may never have spent.
                started_ms: now_millis(),
                hashing: false,
                ongoing_since_block: None,
                siege_shots: 0,
                idle_rounds: 0,
                note: "re-adopted after restart".into(),
            },
        );
        crate::mcp::telemetry::tlog(
            "auto_raid",
            crate::mcp::telemetry::Sev::Notice,
            format!("re-adopted in-flight expedition: {pid} is at {where_now}, not home"),
        );
    }
}

/// Phase D — watch every expedition: start the proof when the clock arms, and
/// pull the fleet home the moment the window closes or the raider is in danger.
async fn supervise(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    cfg: &AutoRaidConfig,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) {
    let expeditions: Vec<Expedition> = ACTIVE.lock().map(|a| a.values().cloned().collect()).unwrap_or_default();
    let current_block = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.current_block_height)
        .unwrap_or(0);

    for mut ex in expeditions {
        let elapsed_mins = (now_millis() - ex.started_ms) / 60_000.0;

        // ── Abort conditions, cheapest first. ──
        let mut abort: Option<String> = None;
        // Set when the chain has already closed the raid in our favour and
        // sent the fleet home — the expedition is over, not aborted.
        let mut won = false;
        if elapsed_mins > cfg.give_up_after_mins as f64 {
            abort = Some(format!("gave up after {} min", cfg.give_up_after_mins));
        }
        // A raider without a Command Ship can neither raid nor move; the
        // expedition is over. There is deliberately no "recall at N HP" rule:
        // hulls are the raid's budget (operator doctrine), our winning raids
        // lost none, and our losses were decided by the defender's response,
        // not by how early we ran.
        if abort.is_none() {
            if let Ok(fl) = client.entity("fleet", &ex.fleet_id).await {
                let cmd = fl
                    .get("Fleet")
                    .and_then(|x| x.get("commandStruct"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if cmd.is_empty() {
                    abort = Some("raider Command Ship lost".into());
                } else if let Ok(e) = client.entity("struct", cmd).await {
                    let sa = e.get("structAttributes");
                    if crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isDestroyed"))) {
                        abort = Some("raider Command Ship destroyed".into());
                    }
                }
                // The chain sends a fleet home the moment its raid seizes (and
                // turns a second arrival around). A fleet found back at its
                // own planet is therefore an expedition that has ENDED, and
                // the raid record says how. Before this, a win sat here as a
                // "siege" that could not fire until the give-up timer ran out,
                // and was then booked as a failure.
                let where_now = fl
                    .get("Fleet")
                    .and_then(|x| x.get("locationId"))
                    .and_then(|x| x.as_str())
                    .unwrap_or_default();
                if abort.is_none() && where_now == ex.home_planet {
                    won = expedition_won(client, &ex).await;
                    abort = Some(if won {
                        "raid seized — fleet home".into()
                    } else {
                        "fleet already home (chain closed the raid)".into()
                    });
                }
            }
        }

        // ── The raid clock. `blockStartRaid == 0` means either no raider is
        // present or the defender isn't vulnerable — the chain collapses both
        // into one value, so a zero after we've arrived means shields are back. ──
        if abort.is_none() {
            // The shield comes back with the clock because the raid proof's
            // difficulty decays over `planetaryShield` blocks — see
            // `start_raid_proof`, which needs it as the decay RANGE.
            let (clock, shield) = client
                .entity("planet", &ex.target_planet)
                .await
                .ok()
                .map(|e| {
                    let v = crate::mcp::types::EntityView::new(&e);
                    (v.planet_block("blockStartRaid").get(), v.planet_attr_u64("planetaryShield"))
                })
                .unwrap_or((0, 0));
            if clock == 0 {
                // Siege: the clock stays unset while the defender's Command Ship
                // is up, so every posture but cautious spends the trip trying to
                // take it down rather than waiting out the timer. Bounded by
                // `give_up_after_mins` — and by the raider's ability to fire at
                // all: a round that cannot shoot is counted, and three in a row
                // end the trip. That is the failure the record is full of.
                if cfg.sieges() {
                    let spent = siege_round(app, client, &ex).await;
                    if spent > 0 {
                        ex.siege_shots += spent;
                        ex.idle_rounds = 0;
                        ex.note = format!("siege — {} shots spent", ex.siege_shots);
                        ACTIVE.lock().unwrap().insert(ex.raider_player.clone(), ex);
                        continue;
                    }
                    ex.idle_rounds += 1;
                    if ex.idle_rounds >= SIEGE_IDLE_ROUNDS {
                        abort = Some(format!(
                            "siege cannot fire — {} scans without a viable shot at the Command Ship",
                            ex.idle_rounds
                        ));
                    } else {
                        ex.note = format!("siege — waiting for a shot ({}/{})", ex.idle_rounds, SIEGE_IDLE_ROUNDS);
                    }
                } else {
                    let since = *ex.ongoing_since_block.get_or_insert(current_block);
                    if current_block.saturating_sub(since) > ONGOING_GRACE_BLOCKS {
                        abort = Some("defender restored shields (raid clock unset)".to_string());
                    }
                }
            } else {
                ex.ongoing_since_block = None;
                // ── Slot ownership. A planet runs ONE raid, and the chain
                // auto-promotes the next co-located fleet in the SAME block
                // when the holder leaves — ignoring team. An armed clock does
                // NOT mean it is OUR raid: if another fleet holds the slot our
                // fleet is inert here (attacks rejected both directions) and
                // any proof we grind can never land. Observed live 2026-08-13:
                // an armed window transferred to a co-located sibling fleet
                // with no proof running, which sat for 31 minutes and lost its
                // Command Ship to the defender's response.
                let slot_holder = client
                    .guild
                    .planet_raid_active_by_planet(&ex.target_planet)
                    .await
                    .ok()
                    .and_then(|raid| {
                        let r = raid.as_array().and_then(|a| a.first()).cloned().unwrap_or(raid);
                        r.get("fleet_id").and_then(|x| x.as_str()).map(String::from)
                    });
                if let Some(holder) = slot_holder {
                    if holder != ex.fleet_id {
                        // Kill our proof if one is grinding — it can never land.
                        if ex.hashing {
                            use crate::hasher::types::TaskRegistry;
                            use std::sync::Arc as StdArc;
                            use tauri::Manager;
                            if let Some(reg) = app.try_state::<StdArc<TaskRegistry>>() {
                                if let Some((_, h)) = reg.tasks.remove(&ex.fleet_id) {
                                    h.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                                }
                            }
                        }
                        abort = Some(format!(
                            "raid slot held by {holder} — our fleet is inert here"
                        ));
                    }
                }
                // A proof that vanished without seizing the ore must be re-issued
                // — see `proof_running`. The clock is still armed, so there is
                // still a raid to win.
                if abort.is_none() && ex.hashing && !proof_running(app, &ex.fleet_id) {
                    ex.hashing = false;
                    crate::mcp::telemetry::tlog(
                        "auto_raid",
                        crate::mcp::telemetry::Sev::Warn,
                        format!(
                            "{}: raid proof ended without seizing {} — re-issuing",
                            ex.raider_player, ex.target_planet
                        ),
                    );
                }
                if abort.is_none() && !ex.hashing {
                    let target =
                        raid_difficulty_target(client, &ex.raider_player, &ex.fleet_id, shield).await;
                    match start_raid_proof(app, &ex, clock, target).await {
                        Ok(()) => {
                            ex.hashing = true;
                            ex.note = "raid proof running".into();
                            run.actions.fetch_add(1, Ordering::Relaxed);
                            crate::mcp::board_feed::push(
                                app,
                                crate::mcp::board_feed::Severity::Important,
                                "auto_raid",
                                format!(
                                    "{}: raid clock armed at {} — proof started against {}",
                                    ex.raider_player, ex.target_planet, ex.target_player
                                ),
                            );
                        }
                        Err(e) => crate::mcp::telemetry::tlog(
                            "auto_raid",
                            crate::mcp::telemetry::Sev::Warn,
                            format!("{}: raid proof failed to start: {}", ex.raider_player, e),
                        ),
                    }
                } else if abort.is_none() && cfg.sieges() {
                    // Proof grinding: keep shooting the defender's
                    // planetary-shield structs — the raid difficulty is a decay
                    // range tracking the LIVE shield, so every kill shortens our
                    // own proof (and 1-61 does exactly this to us).
                    let spent = shield_grind_round(app, client, &ex).await;
                    if spent > 0 {
                        ex.siege_shots += spent;
                    }
                }
            }
        }

        match abort {
            Some(why) => {
                // Always bring the fleet home: a raider left standing at an
                // enemy planet is a queued loss, and its own planet is raidable
                // for as long as it is away. Skipped only when the chain has
                // already returned it.
                if !why.contains("home") {
                    let _ = crate::mcp::tx_retry::sign_with_retry(
                        app,
                        ex.raider_index,
                        "/structs.structs.MsgFleetMove",
                        json!({ "fleetId": ex.fleet_id, "destinationLocationId": ex.home_planet }),
                        // NOT `auto_raid:` — this is the deadline-bound retreat.
                        // See tx_gate::classify.
                        &format!("auto_raid_abort:{}", ex.raider_player),
                    )
                    .await;
                }
                record_outcome(&ex.target_planet, won);
                ACTIVE.lock().unwrap().remove(&ex.raider_player);
                crate::mcp::board_feed::push(
                    app,
                    crate::mcp::board_feed::Severity::Notice,
                    "auto_raid",
                    format!("{} recalled from {} — {}", ex.raider_player, ex.target_planet, why),
                );
            }
            None => {
                ACTIVE.lock().unwrap().insert(ex.raider_player.clone(), ex);
            }
        }
    }
}

/// One round of the siege kill-chain: fire the raider's own co-located structs
/// at the defender's Command Ship (or, when a same-ambit blocker shields it, at
/// that blocker first — `structs_strike`'s STRIP phase). Killing the Command
/// Ship is what arms the raid clock. Returns how many shots were actually spent.
///
/// Only the raider's own structs take part: they are the ones parked at the
/// target planet, and the whole point of the raider role is that these are the
/// hulls we can afford to lose.
async fn siege_round(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    ex: &Expedition,
) -> usize {
    // Re-resolve the defender's Command Ship each round: it may have been
    // rebuilt, or already killed by the previous round.
    let Ok(pl) = client.entity("player", &ex.target_player).await else { return 0 };
    let fleet = pl
        .get("Player")
        .and_then(|p| p.get("fleetId"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty());
    let Some(fleet) = fleet else { return 0 };
    let Ok(fl) = client.entity("fleet", fleet).await else { return 0 };
    let cmd = fl
        .get("Fleet")
        .and_then(|f| f.get("commandStruct"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty());
    let Some(cmd) = cmd else { return 0 }; // already down — the clock should arm
    if client
        .entity("struct", cmd)
        .await
        .map(|e| {
            crate::mcp::loop_util::parse_bool(e.get("structAttributes").and_then(|a| a.get("isDestroyed")))
        })
        .unwrap_or(false)
    {
        return 0;
    }

    // Kill-chain: you cannot damage the Command Ship through a living
    // SAME-AMBIT blocker — the blocker absorbs everything, even counter-immune
    // artillery fire. The doc used to CLAIM this walk happened; now it does.
    // (1-61's Tank blocker ate seven straight MA shots aimed at his CMD.)
    let fire_at = match crate::mcp::tools::strike::resolve_fire_target(client, cmd).await {
        Ok((t, phase, note)) => {
            if phase == "STRIP" {
                crate::mcp::telemetry::tlog(
                    "auto_raid",
                    crate::mcp::telemetry::Sev::Info,
                    format!("siege kill-chain for {}: {}", ex.raider_player, note),
                );
            }
            t
        }
        Err(_) => cmd.to_string(),
    };
    fire_best_at(app, client, ex, &fire_at, "siege").await
}

/// While the raid proof is grinding, every planetary-shield contributor the
/// defender loses shortens OUR OWN proof: the raid difficulty is a decay range
/// tracking the LIVE `planetaryShield` (−50 per Ore Bunker, −25 per OSG, −13
/// per PDC, −12 per Jamming Satellite). 1-61 does exactly this — 84 Tank shots
/// at Ore Bunkers, 80 counter-immune artillery shots at Defense Cannons, 54 at
/// Shield Generators. Costs the PDC's 1 damage per shot; shares the siege
/// budget so it cannot run away.
async fn shield_grind_round(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    ex: &Expedition,
) -> usize {
    let structs = crate::mcp::loop_util::player_structs(client, &ex.target_player).await;
    let best_shield = {
        let gs = crate::game_state::GAME_STATE.read().unwrap();
        let mut candidates: Vec<(u64, String)> = structs
            .iter()
            .filter(|s| {
                !crate::mcp::loop_util::parse_bool(s.get("is_destroyed"))
                    && s.get("location_id").and_then(|x| x.as_str()) == Some(ex.target_planet.as_str())
            })
            .filter_map(|s| {
                let id = s.get("id").and_then(|x| x.as_str())?.to_string();
                let tid = s.get("type").map(|t| match t {
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::String(v) => v.clone(),
                    _ => String::new(),
                })?;
                let contrib = gs
                    .struct_types
                    .get(&tid)
                    .and_then(|t| t.planetary_shield_contribution)
                    .unwrap_or(0);
                (contrib > 0).then_some((contrib, id))
            })
            .collect();
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        candidates.into_iter().next()
    };
    let Some((contrib, target)) = best_shield else { return 0 };
    crate::mcp::telemetry::tlog(
        "auto_raid",
        crate::mcp::telemetry::Sev::Info,
        format!(
            "shield grind: {} targeting {} (−{} planetary shield on kill → shorter proof)",
            ex.raider_player, target, contrib
        ),
    );
    fire_best_at(app, client, ex, &target, "shield-grind").await
}

/// Fire the raider's best co-located shooter (evasion-, armour- and
/// counter-aware via `plan_strike`) once at `target`. Returns shots spent.
async fn fire_best_at(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    ex: &Expedition,
    target: &str,
    label: &str,
) -> usize {
    let Ok(plan) = crate::mcp::tools::intel::plan_strike(
        client,
        &json!({ "target": target, "players": [ex.raider_player.clone()] }),
    )
    .await
    else {
        return 0;
    };
    // One shot per player per charge cycle, best (evasion- and counter-aware)
    // first. Bounded by the expedition's give-up timer, not a shot count.
    let mut shots: Vec<&crate::mcp::tools::intel::StrikeRow> =
        plan.rows.iter().filter(|r| r.reachable).collect();
    shots.sort_by(|a, b| {
        a.counter_risk
            .cmp(&b.counter_risk)
            .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    // Survival is a RANKING, not a filter: prefer a shooter that outlives its
    // own shot, but when every reaching hull is doomed, the best doomed one
    // fires anyway — a siege that stops shooting has already lost, and the
    // hulls are the raid's budget (operator doctrine 2026-08-20: "doing
    // nothing shouldn't be a result").
    let mut best = None;
    let mut doomed_fallback = None;
    for s in &shots {
        if crate::mcp::tools::intel::shot_is_suicidal(client, s).await {
            if doomed_fallback.is_none() {
                doomed_fallback = Some(*s);
            }
            continue;
        }
        best = Some(*s);
        break;
    }
    let sacrificial = best.is_none() && doomed_fallback.is_some();
    let Some(best) = best.or(doomed_fallback) else { return 0 };
    if sacrificial {
        crate::mcp::telemetry::tlog(
            "auto_raid",
            crate::mcp::telemetry::Sev::Notice,
            format!(
                "{}: every reaching shooter is doomed — firing {} anyway ({} counter damage will destroy it)",
                label, best.struct_id, best.counter_risk
            ),
        );
    }

    let wsys = if best.weapon.eq_ignore_ascii_case("secondary") {
        "secondaryWeapon"
    } else {
        "primaryWeapon"
    };
    match crate::mcp::tx_retry::sign_with_retry(
        app,
        ex.raider_index,
        "/structs.structs.MsgStructAttack",
        json!({
            "operatingStructId": best.struct_id,
            "targetStructId": [target],
            "weaponSystem": wsys,
        }),
        &format!("auto_raid_siege:{}", ex.raider_player),
    )
    .await
    {
        Ok(_) => {
            crate::mcp::telemetry::tlog(
                "auto_raid",
                crate::mcp::telemetry::Sev::Notice,
                format!(
                    "{}: {} fired {} at {} (~{:.1} dmg, {} counter exposure)",
                    label, ex.raider_player, best.struct_id, target, best.expected_dmg, best.counter_exposure
                ),
            );
            1
        }
        Err(e) => {
            crate::mcp::telemetry::tlog(
                "auto_raid",
                crate::mcp::telemetry::Sev::Warn,
                format!("{} shot failed for {}: {}", label, ex.raider_player, e),
            );
            0
        }
    }
}

/// Is a raid proof genuinely still running for this expedition?
///
/// `Expedition::hashing` is set optimistically the moment the task starts and
/// was never checked again, so a proof that died — rejected by the chain,
/// cancelled by the pool, dropped on a tuner reset — left the flag stuck `true`
/// while `supervise`'s `if !ex.hashing` guard refused to re-issue it. The raid
/// then sat in `shieldsVulnerable` until the wall-clock abort, doing nothing.
/// Reconcile against the registry rather than trusting our own bookkeeping.
///
/// `start_hash_task_core` inserts into `registry.tasks` synchronously before it
/// returns `Ok`, so there is no window where a live task reads as missing.
fn proof_running(app: &tauri::AppHandle, fleet_id: &str) -> bool {
    use crate::hasher::types::TaskRegistry;
    use std::sync::Arc;
    use tauri::Manager;
    app.try_state::<Arc<TaskRegistry>>()
        .map(|r| r.tasks.contains_key(fleet_id))
        .unwrap_or(false)
}

/// The raid proof's `difficulty_target`, straight from the chain.
///
/// This is the DECAY RANGE, not a difficulty: the required difficulty is
/// `64 − floor(log10(age)/log10(range) × 63)`, the same slot `MINE_TARGET` /
/// `REFINE_TARGET` (14_000 / 28_000) fill. The chain publishes the raid's value
/// on a `work` record, which is where the game's own client reads it
/// (`TaskStateFactory.initTaskFromWork`) — so read it rather than derive it.
///
/// The value is **live, not frozen at arm time** — a claim that stood in this
/// comment for weeks and is exactly backwards. Verified 2026-08-07 by
/// destroying one Orbital Shield Generator mid-raid: the chain's RAID `work`
/// record went 238 → 213, precisely that struct's −25 contribution. It has to
/// be live, or `shield_grind_round` thirty lines above — which spends shots on
/// the defender's shield structs specifically to shorten our own proof — would
/// be pointless.
///
/// So this read is the START of the story, not the end: a task that begins
/// grinding here is frozen against a number that keeps moving, and
/// [`crate::hasher::retune`] is what keeps it tracking. Reading the work record
/// rather than the planet still matters at start time (it is the chain's own
/// answer); the shield is the fallback when the feed is unavailable, and the
/// two agree.
async fn raid_difficulty_target(
    client: &CosmosClient,
    raider_player: &str,
    fleet_id: &str,
    fallback_shield: u64,
) -> u64 {
    let rows = client.guild.work_by_player(raider_player).await.ok();
    let found = rows.as_ref().and_then(|v| v.as_array()).and_then(|arr| {
        arr.iter()
            .find(|w| {
                w.get("category").and_then(|x| x.as_str()) == Some("RAID")
                    && w.get("object_id").and_then(|x| x.as_str()) == Some(fleet_id)
            })
            .and_then(|w| crate::mcp::loop_util::parse_f64(w.get("difficulty_target")).into())
    });
    let target = found.filter(|v| *v >= 2.0).map(|v| v as u64).unwrap_or(fallback_shield);
    // log10(1) = 0 would divide by zero in the decay formula.
    target.max(2)
}

/// Start the proof-of-work that completes a raid.
///
/// `difficulty_target` is a decay RANGE — see [`raid_difficulty_target`]. This
/// used to pass `cfg.raid_difficulty` (default **4**) into that slot, conflating
/// a difficulty level with a range. With range 4 the app believes the
/// requirement has decayed to 1 after four blocks — about twenty seconds — so it
/// solved a trivial proof and submitted it immediately. The chain, whose `work`
/// record said 238, still wanted difficulty ~48 and rejected every one:
///
/// ```text
/// work failure for input (9-2136@2-6607RAID2007423NONCE6452945563)
/// ```
///
/// Observed live on planet 2-6607: two proofs submitted seconds after the clock
/// armed, both rejected, and the raid then sat in `shieldsVulnerable`
/// indefinitely because `hashing` stayed `true`.
async fn start_raid_proof(
    app: &tauri::AppHandle,
    ex: &Expedition,
    block_start_raid: u64,
    difficulty_target: u64,
) -> Result<(), String> {
    use crate::hasher::types::{TaskParams, TaskRegistry};
    use std::sync::Arc;
    use tauri::Manager;
    let registry = app
        .try_state::<Arc<TaskRegistry>>()
        .map(|r| r.inner().clone())
        .ok_or_else(|| "task registry unavailable".to_string())?;
    let params = TaskParams::for_raid(
        &ex.fleet_id,
        &ex.target_planet,
        block_start_raid,
        difficulty_target,
    );
    crate::hasher::start_hash_task_core(params, app.clone(), &registry)?;
    crate::hasher::register_vplayer_hash(ex.fleet_id.clone(), ex.raider_index, crate::mcp::types::TaskType::Raid);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `gate()` consults the combat lists, which load from the OPERATOR'S data
    /// directory — so without this these tests assert against whatever guilds
    /// and players happen to be on the running machine. They passed until `0-1`
    /// (the fixture's guild) was added as a real ally, at which point every
    /// gate test failed with "vetoed". Pin the lists to empty first.
    fn isolate_lists() {
        crate::mcp::combat_lists::set_for_test(Default::default());
    }

    fn cand() -> Candidate {
        Candidate {
            player_id: crate::mcp::types::PlayerId::parse("1-61").unwrap(),
            name: "JPEG".into(),
            guild_id: "0-1".into(),
            planet_id: "2-855".into(),
            fleet_id: "9-61".into(),
            stored_ore: 100.0,
            planet_ore_remaining: 5.0,
            occupied_by: None,
            planetary_shield: 125,
            raid_minutes: 12.0,
            vulnerable: true,
            vulnerability_reason: "VULNERABLE — fleet off-station".into(),
            command_struct: Some("5-14098".into()),
            command_ambit: "land".into(),
            defenders_on_cmd: 1,
            enemy_fleet_structs: 4,
            last_action_block: 0,
            blocks_since_action: 100_000,
            score: 0.0,
            blocked_by: None,
        }
    }

    /// A config written before a new field existed must still load, with the
    /// loop's `enabled` intact.
    ///
    /// This is the regression that took auto_raid offline for a day: adding
    /// `min_planet_ore` without a serde default made every existing
    /// `auto_raid.json` unparseable, `load_config` fell back to `Default`
    /// (`enabled: false`), and the watchdog read `enabled` from that same value
    /// so it reported nothing wrong.
    #[test]
    fn an_older_config_file_still_loads_and_stays_enabled() {
        // Exactly the shape on disk before the field was introduced.
        let older = r#"{
            "enabled": true, "autonomy": "auto", "interval_secs": 300,
            "posture": "opportunist", "min_ore": 15.0, "min_score": 55.0,
            "max_raid_minutes": 20, "max_defenders": 34,
            "require_vulnerable_now": true, "allow_siege": true,
            "siege_max_shots": 12, "skip_if_defender_active_mins": 30,
            "raid_hours_utc": [], "w_ore": 1.0, "w_vulnerability": 1.0,
            "w_weakness": 0.8, "w_grudge": 1.2, "w_guild": 0.5, "w_speed": 0.4,
            "w_history": 0.6, "raider_players": [], "max_concurrent_raids": 1,
            "target_cooldown_mins": 120, "abort_on_ongoing_blocks": 300,
            "abort_cmd_hp_below": 0.0, "max_raid_wall_minutes": 90,
            "return_home_after": true, "roster_ttl_secs": 21600,
            "sweep_max_pages": 8, "evaluate_per_scan": 25,
            "raid_difficulty": 4, "dry_run": false
        }"#;
        let cfg: AutoRaidConfig =
            serde_json::from_str(older).expect("an older config must still deserialize");
        assert!(cfg.enabled, "the operator's enabled flag must survive an upgrade");
        assert_eq!(cfg.posture, RaidPosture::Opportunist, "known fields still read");
        assert_eq!(cfg.w_opening, 1.0, "a field the file predates takes its default");
        assert_eq!(cfg.give_up_after_mins, 60, "…and so does every other new one");
    }


    /// Off and advising on first launch — but once armed, the default posture
    /// sieges. Since v0.21.0 that is where 20 of 24 successful raids came from.
    #[test]
    fn defaults_are_safe_and_opportunist() {
        isolate_lists();
        let c = AutoRaidConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.autonomy, Autonomy::Advise);
        assert_eq!(c.posture, RaidPosture::Opportunist);
        assert!(c.sieges(), "the default posture must be able to open a window");
        assert_eq!(c.max_concurrent_raids, 2);
    }

    /// Each posture must produce exactly the documented gate table.
    /// A Command Ship can sit in ANY ambit, and most of our fleets answer only
    /// one or two of the four. Sending a raider that can only manage a
    /// same-ambit shot means it parks at the target, never fires (the
    /// survivability gate refuses those), and leaves its OWN planet raidable
    /// for the whole trip. Modelled directly on the live roster: a fleet whose
    /// only land reach is Tanks standing in land.
    #[test]
    fn same_ambit_only_raider_is_not_a_viable_dispatch() {
        use crate::mcp::readiness::{assess, Hull, Posture};
        const LAND: u64 = 4;
        let tanks = vec![
            Hull { struct_id: "5-1".into(), type_name: "Tank".into(), reach: LAND,
                   operating_ambit: LAND, counter_immune: false },
        ];
        let r = assess(&tanks, LAND, true);
        assert_eq!(r.per_ambit[0].posture, Posture::SameAmbit);
        assert!(r.blind_mask & LAND != 0, "dispatch must treat this as no viable shot");

        // A Battleship standing in SPACE reaching land is the shot that worked
        // live against 1-471 on 2026-08-18.
        let bship = vec![
            Hull { struct_id: "5-2".into(), type_name: "Battleship".into(), reach: 2 | LAND,
                   operating_ambit: 16, counter_immune: false },
        ];
        let r2 = assess(&bship, LAND, true);
        assert_eq!(r2.per_ambit[0].posture, Posture::CrossAmbit);
        assert_eq!(r2.blind_mask & LAND, 0, "cross-ambit into land is a viable dispatch");
    }

    #[test]
    fn postures_set_the_documented_gates() {
        isolate_lists();
        let mut c = AutoRaidConfig::default();
        c.apply_posture(RaidPosture::Cautious);
        assert_eq!((c.min_ore, c.min_score, c.give_up_after_mins), (30.0, 60.0, 30));
        assert!(!c.sieges());

        c.apply_posture(RaidPosture::Opportunist);
        assert_eq!((c.min_ore, c.min_score, c.give_up_after_mins), (5.0, 40.0, 60));
        assert!(c.sieges());

        c.apply_posture(RaidPosture::Aggressive);
        assert_eq!((c.min_ore, c.min_score, c.give_up_after_mins), (1.0, 25.0, 90));
        assert!(c.sieges());
    }

    /// The docs state a shield of 125 reaches difficulty 1 at age 125 blocks —
    /// the inverse of the chain's decay formula must reproduce that exactly.
    #[test]
    fn raid_proof_decay_matches_the_documented_example() {
        isolate_lists();
        assert!((raid_ready_blocks(125, 1) - 125.0).abs() < 0.001);
        // A harder proof is reached sooner; an easier one takes longer.
        assert!(raid_ready_blocks(125, 8) < raid_ready_blocks(125, 1));
        // A bigger shield is a longer wait at the same difficulty.
        assert!(raid_ready_blocks(325, 4) > raid_ready_blocks(125, 4));
    }

    /// The raid proof's `difficulty_target` is a DECAY RANGE, not a difficulty.
    /// Passing `cfg.raid_difficulty` (4) into that slot made the app think the
    /// requirement had decayed to 1 after four blocks, so it submitted a trivial
    /// proof seconds after the clock armed and the chain rejected every one with
    /// "work failure". Pin the two apart.
    #[test]
    fn raid_proof_range_is_the_shield_not_the_difficulty() {
        use crate::hasher::difficulty::calculate_difficulty;
        const SHIELD: u64 = 238; // planet 2-6607, live
        const BAD: u64 = 4; // the old value: cfg.raid_difficulty

        // Four blocks in, the shield-ranged requirement is still brutal...
        let real = calculate_difficulty(4, SHIELD);
        assert!(real > 40, "chain still wants a hard proof at age 4, got {real}");
        // ...while the mis-scaled range says "trivial, ship it".
        assert_eq!(calculate_difficulty(4, BAD), 1);

        // The range must also behave like MINE/REFINE's: bigger range = slower
        // decay, so the requirement at a given age is strictly harder.
        assert!(calculate_difficulty(100, SHIELD) > calculate_difficulty(100, BAD));
        // And it does eventually decay to 1, once age reaches the shield.
        assert_eq!(calculate_difficulty(SHIELD, SHIELD), 1);
    }

    /// The range is LIVE, not frozen when the raid arms — the fact the doc
    /// comment on `raid_difficulty_target` got backwards, and the reason
    /// `shield_grind_round` spends shots on shield structs at all. Observed
    /// 2026-08-07: one Orbital Shield Generator destroyed mid-raid moved the
    /// chain's RAID work record 238 → 213, exactly its −25 contribution.
    ///
    /// Both directions matter, and they are not symmetric. A shield that FALLS
    /// leaves our held proof valid but needlessly strong; one that RISES makes
    /// it too weak to be accepted at all. `hasher::retune` is what acts on this.
    #[test]
    fn the_decay_range_is_live_so_a_shield_kill_shortens_our_own_proof() {
        use crate::hasher::difficulty::calculate_difficulty;
        const ARMED: u64 = 238; // at arm time
        const AFTER_KILL: u64 = 213; // one Orbital Shield Generator later

        // Killing a contributor is a strictly easier proof at every age that
        // still asks for work.
        for age in [4u64, 20, 100, 200] {
            assert!(
                calculate_difficulty(age, AFTER_KILL) <= calculate_difficulty(age, ARMED),
                "age {age}: a smaller shield must never be the harder proof"
            );
        }
        assert!(calculate_difficulty(100, AFTER_KILL) < calculate_difficulty(100, ARMED));

        // And the dangerous direction: a defender who BUILDS raises the
        // chain's requirement above the one a frozen task is solving for, so
        // the proof it finds is rejected.
        let held = calculate_difficulty(100, ARMED);
        let chain_wants = calculate_difficulty(100, ARMED + 50); // an Ore Bunker
        assert!(
            chain_wants > held,
            "a rebuilt shield must demand more than the range we started with"
        );
    }


    /// A planet runs ONE raid. The second fleet to arrive is inert in both
    /// directions — verified live on 2-7324, where a third party's Tank and the
    /// defender's Mobile Artillery each rejected the other as "unreachable"
    /// while both stood on the planet, and the arrival created no raid record.
    /// Dispatching there costs a trip and exposes our own planet for nothing.
    #[test]
    fn a_planet_someone_else_is_raiding_is_gated_out() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.occupied_by = Some("9-280".into());
        let why = gate(&c, &cfg, 0.0).expect("an occupied planet must be gated out");
        assert!(why.contains("inert"), "unexpected reason: {why}");
        // Empty planet is fine.
        c.occupied_by = None;
        assert_eq!(gate(&c, &cfg, 0.0), None);
    }

    /// A closed window is a siege, and only the cautious posture refuses one.
    #[test]
    fn a_closed_window_is_gated_only_for_cautious() {
        isolate_lists();
        let mut cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.vulnerable = false;
        assert_eq!(gate(&c, &cfg, 0.0), None, "opportunist sieges");
        cfg.apply_posture(RaidPosture::Cautious);
        let why = gate(&c, &cfg, 0.0).expect("cautious must refuse");
        assert!(why.contains("shields up"), "got: {why}");
    }

    #[test]
    fn thin_piles_are_gated_out() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.stored_ore = 3.0;
        assert!(gate(&c, &cfg, 0.0).unwrap().contains("min_ore"));
    }

    /// Defenders, fleet size and proof length are SCORED, never gated: the
    /// richest targets in the record (12+ defence edges, 325 shield) were the
    /// ones worth flying at.
    #[test]
    fn a_slow_proof_and_a_thick_guard_are_scored_not_gated() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut hard = cand();
        hard.raid_minutes = 45.0;
        hard.defenders_on_cmd = 12;
        hard.enemy_fleet_structs = 16;
        assert_eq!(gate(&hard, &cfg, 0.0), None);
        assert!(score(&hard, &cfg) < score(&cand(), &cfg));
    }

    /// An awake defender is not a reason to skip (owners active in the last 30
    /// minutes returned 63 ore per attempt against 25 for a day-idle owner);
    /// a cooldown is.
    #[test]
    fn an_awake_defender_passes_and_a_cooldown_blocks() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut fresh = cand();
        fresh.blocks_since_action = 10; // ~1 minute ago
        assert_eq!(gate(&fresh, &cfg, 0.0), None);
        assert!(gate(&cand(), &cfg, 45.0).unwrap().contains("cooldown"));
    }

    #[test]
    fn a_clean_target_passes_every_gate() {
        isolate_lists();
        assert!(gate(&cand(), &AutoRaidConfig::default(), 0.0).is_none());
    }

    #[test]
    fn score_rewards_ore_vulnerability_and_weakness() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let base = score(&cand(), &cfg);

        let mut poorer = cand();
        poorer.stored_ore = 16.0;
        assert!(score(&poorer, &cfg) < base);

        let mut shielded = cand();
        shielded.vulnerable = false;
        assert!(score(&shielded, &cfg) < base);

        let mut guarded = cand();
        guarded.defenders_on_cmd = 8;
        guarded.enemy_fleet_structs = 16;
        assert!(score(&guarded, &cfg) < base);

        let mut slower = cand();
        slower.raid_minutes = 19.0;
        assert!(score(&slower, &cfg) < base);
    }

    /// Re-weighting must change the ORDER of targets without moving the 0..100
    /// scale, so `min_score` keeps meaning the same thing.
    #[test]
    fn score_stays_on_a_zero_to_hundred_scale_under_reweighting() {
        isolate_lists();
        let mut cfg = AutoRaidConfig::default();
        for w in [0.1, 1.0, 5.0] {
            cfg.w_ore = w;
            cfg.w_grudge = 10.0 - w;
            let s = score(&cand(), &cfg);
            assert!((0.0..=100.0).contains(&s), "score {s} out of range at w={w}");
        }
        // All-zero weights degrade to 0 rather than dividing by zero.
        cfg = AutoRaidConfig::default();
        cfg.w_ore = 0.0;
        cfg.w_opening = 0.0;
        cfg.w_weakness = 0.0;
        cfg.w_grudge = 0.0;
        assert_eq!(score(&cand(), &cfg), 0.0);
    }

    #[test]
    fn siege_gives_a_closed_window_partial_credit_but_only_when_the_posture_sieges() {
        isolate_lists();
        let mut cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.vulnerable = false;
        let sieging = score(&c, &cfg);
        cfg.apply_posture(RaidPosture::Cautious);
        assert!(score(&c, &cfg) < sieging);
    }

    /// Every posture that lets a closed window through the gate must also
    /// siege, or the raider would sit at the planet doing nothing until the
    /// give-up timer fired. One switch, `posture`, decides both.
    #[test]
    fn a_posture_that_accepts_a_closed_window_sieges() {
        isolate_lists();
        let mut c = cand();
        c.vulnerable = false;
        let mut cfg = AutoRaidConfig::default();
        for p in [RaidPosture::Cautious, RaidPosture::Opportunist, RaidPosture::Aggressive] {
            cfg.apply_posture(p);
            assert_eq!(gate(&c, &cfg, 0.0).is_none(), cfg.sieges(), "{p:?}");
        }
    }

    /// A target we keep bouncing off backs off geometrically: 27 identical
    /// failed trips two hours apart is the pattern this exists to end.
    #[test]
    fn a_failed_attempt_doubles_the_cooldown_up_to_a_cap() {
        assert_eq!(effective_cooldown_mins(120, 0), 120.0);
        assert_eq!(effective_cooldown_mins(120, 1), 240.0);
        assert_eq!(effective_cooldown_mins(120, 3), 960.0);
        assert_eq!(effective_cooldown_mins(120, 4), 1920.0);
        assert_eq!(effective_cooldown_mins(120, 9), 1920.0, "capped at 2^4");
    }

    #[test]
    fn round_robin_covers_the_roster_across_scans() {
        isolate_lists();
        let roster: Vec<RosterEntry> = (0..10)
            .map(|i| (crate::mcp::types::PlayerId::from_index(i), "0-9".to_string()))
            .collect();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..5 {
            for (id, _) in next_batch(&roster, 3) {
                seen.insert(id);
            }
        }
        assert!(seen.len() > 3, "cursor should advance past the first page, saw {}", seen.len());
    }
}
