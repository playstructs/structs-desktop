//! Native raid target-selection loop — the offensive half of autonomous combat.
//!
//! ## What the data says raiding actually is
//!
//! From 300 reconstructed raid episodes in `planet_activity`:
//!
//! * **Vulnerability is the whole game.** Post-2026-06-15 (when the current
//!   mechanic landed), raids that saw `shieldsVulnerable` went 69 successful vs
//!   7 retreats; raids that never saw it went **0 successful vs 50 retreats**.
//!   Not "unlikely" — zero. So `require_vulnerable_now` defaults on, and moving
//!   a fleet onto a healthy planet is strictly self-harm: it drops YOUR shields
//!   for a raid that cannot complete.
//! * **Loot is a lottery with a fat tail.** 123 successful raids yielded 1,336
//!   ore total but a **median of 1**, and 52 of them seized nothing at all.
//!   Nine raids carried 74% of all ore ever stolen. Hence `min_ore`: below it,
//!   the Command Ship risk is unpriced.
//! * **Shield strength does NOT predict the outcome** (successes averaged 127.9,
//!   retreats 111.5, both spanning 25–325). Shield is a *timer* — it sets the
//!   raid proof's difficulty range — not a defence. It is scored as speed, never
//!   as strength.
//! * **Our own offensive record is the warning.** 22 raids: 2 wins, 11 retreats,
//!   and **9 `attackerDefeated`** — a 41% rate against an ecosystem baseline of
//!   5%, every one of them the primary's Command Ship dying in the field. That
//!   is why only `VPlayerRole::Raider` accounts raid, never the primary.
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

/// Ore pile that counts as "the jackpot" when normalising the prize term. The
/// largest raid ever recorded seized 173.
const ORE_SCALE: f64 = 175.0;

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
pub struct AutoRaidConfig {
    pub enabled: bool,
    pub autonomy: Autonomy,
    pub interval_secs: u64,
    /// Preset that rewrites the gates below in one move. Explicit edits to the
    /// individual gates survive until the posture is set again.
    pub posture: RaidPosture,

    // ── Hard gates ──
    /// A raid seizes ALL of the target's stored ore, so this is the whole prize.
    /// Median historical haul is 1 ore; below this a raid is negative EV.
    pub min_ore: f64,
    /// 0..100 blended score floor.
    pub min_score: f64,
    /// Wall-clock budget for the raid proof, derived from the target's shield.
    pub max_raid_minutes: u32,
    /// Skip targets whose Command Ship is behind more defenders than this.
    pub max_defenders: usize,
    /// Never move onto a planet that isn't already vulnerable. 0-for-50 says
    /// turning this off is how raids get wasted.
    pub require_vulnerable_now: bool,
    /// Allow manufacturing the window by killing the defender's Command Ship.
    pub allow_siege: bool,
    pub siege_max_shots: usize,
    /// Skip a target whose owner acted this recently — an awake defender can
    /// restore shields mid-raid and strand the fleet.
    pub skip_if_defender_active_mins: u32,
    /// Restrict dispatch to these UTC hours. Historical success is 39–57% in
    /// 15:00–20:00 UTC and 0–13% in 00:00–04:00. Empty = any hour.
    pub raid_hours_utc: Vec<u32>,

    // ── Scoring weights (the playstyle dial) ──
    pub w_ore: f64,
    pub w_vulnerability: f64,
    pub w_weakness: f64,
    pub w_grudge: f64,
    pub w_guild: f64,
    pub w_speed: f64,
    pub w_history: f64,

    // ── Fleet management ──
    /// Explicit raider player ids; empty = every `VPlayerRole::Raider`.
    pub raider_players: Vec<String>,
    pub max_concurrent_raids: usize,
    /// Per-target planet cooldown after any attempt.
    pub target_cooldown_mins: u32,
    /// Give up if the defender restores shields (`ongoing`) for this many blocks.
    pub abort_on_ongoing_blocks: u64,
    /// Recall the raider when its own Command Ship drops below this HP.
    pub abort_cmd_hp_below: f64,
    /// Absolute wall-clock cap on one expedition.
    pub max_raid_wall_minutes: u32,
    pub return_home_after: bool,

    // ── Discovery cost controls ──
    /// How long a swept roster of enemy players stays fresh.
    pub roster_ttl_secs: u64,
    /// Max LCD list pages to walk when sweeping for candidates.
    pub sweep_max_pages: usize,
    /// Max candidates given the expensive per-target reads each scan.
    pub evaluate_per_scan: usize,
    /// Difficulty the raid proof must decay to before we start hashing.
    pub raid_difficulty: u64,

    pub dry_run: bool,
}

impl Default for AutoRaidConfig {
    fn default() -> Self {
        let mut c = Self {
            enabled: false,
            autonomy: Autonomy::Advise,
            interval_secs: 300,
            posture: RaidPosture::Opportunist,
            min_ore: 15.0,
            min_score: 55.0,
            max_raid_minutes: 20,
            max_defenders: 4,
            require_vulnerable_now: true,
            allow_siege: false,
            siege_max_shots: 12,
            skip_if_defender_active_mins: 30,
            raid_hours_utc: vec![],
            w_ore: 1.0,
            w_vulnerability: 1.0,
            w_weakness: 0.8,
            w_grudge: 1.2,
            w_guild: 0.5,
            w_speed: 0.4,
            w_history: 0.6,
            raider_players: vec![],
            max_concurrent_raids: 1,
            target_cooldown_mins: 120,
            abort_on_ongoing_blocks: 30,
            abort_cmd_hp_below: 3.0,
            max_raid_wall_minutes: 90,
            return_home_after: true,
            roster_ttl_secs: 21_600,
            sweep_max_pages: 8,
            evaluate_per_scan: 25,
            raid_difficulty: 4,
            dry_run: false,
        };
        c.apply_posture(RaidPosture::Opportunist);
        c
    }
}

impl AutoRaidConfig {
    /// Rewrite the hard gates from a posture preset. Mirrors how
    /// `doctrine::preset_bundle` works: the preset is a starting point, and any
    /// field the operator sets afterwards wins until the posture is set again.
    pub fn apply_posture(&mut self, p: RaidPosture) {
        self.posture = p;
        let (min_ore, min_score, minutes, defenders, vuln, siege) = match p {
            RaidPosture::Cautious => (30.0, 75.0, 10, 2, true, false),
            RaidPosture::Opportunist => (15.0, 55.0, 20, 4, true, false),
            RaidPosture::Aggressive => (5.0, 35.0, 45, 8, false, true),
        };
        self.min_ore = min_ore;
        self.min_score = min_score;
        self.max_raid_minutes = minutes;
        self.max_defenders = defenders;
        self.require_vulnerable_now = vuln;
        self.allow_siege = siege;
    }
}

static CONFIG: LazyLock<RwLock<AutoRaidConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config::<AutoRaidConfig>(FILENAME)));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
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
type RosterEntry = (String, String);
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
/// Expeditions currently in flight, keyed by raider player id.
static ACTIVE: LazyLock<Mutex<HashMap<String, Expedition>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize)]
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
    /// Shots spent so far trying to open the window by force (`allow_siege`).
    pub siege_shots: usize,
    pub note: String,
}

/// One scored raid target.
#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub player_id: String,
    pub name: String,
    pub guild_id: String,
    pub planet_id: String,
    pub fleet_id: String,
    /// The prize — a raid takes all of it.
    pub stored_ore: f64,
    pub planetary_shield: u64,
    /// Minutes until the raid proof decays to `raid_difficulty`.
    pub raid_minutes: f64,
    pub vulnerable: bool,
    pub vulnerability_reason: String,
    pub command_struct: Option<String>,
    pub defenders_on_cmd: usize,
    /// Occupied fleet slots — a crude but effective measure of return fire.
    pub enemy_fleet_structs: usize,
    pub last_action_block: u64,
    pub blocks_since_action: u64,
    pub score: f64,
    /// `None` = GO. `Some(reason)` = NO-GO, shown verbatim on the board.
    pub blocked_by: Option<String>,
}

pub fn target_board() -> Vec<Candidate> {
    BOARD.lock().map(|b| b.clone()).unwrap_or_default()
}

pub fn active_expeditions() -> Vec<Expedition> {
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
    let vuln_term = if c.vulnerable {
        1.0
    } else if cfg.allow_siege {
        0.4
    } else {
        0.0
    };
    // Defensive pressure: registered defenders on the Command Ship plus the size
    // of the fleet that would shoot back.
    let pressure = ((c.defenders_on_cmd as f64) / 8.0 + (c.enemy_fleet_structs as f64) / 16.0).min(1.0);
    let weakness_term = 1.0 - pressure;
    let grudge_term = crate::mcp::combat_lists::grudge_heat(&c.player_id).min(1.0);
    let guild_term = crate::mcp::combat_lists::guild_weight(Some(&c.guild_id)).min(1.0);
    let speed_term = if cfg.max_raid_minutes == 0 {
        0.0
    } else {
        (1.0 - c.raid_minutes / cfg.max_raid_minutes as f64).clamp(0.0, 1.0)
    };
    let history_term = history_win_rate(&c.planet_id);

    let terms = [
        (cfg.w_ore, ore_term),
        (cfg.w_vulnerability, vuln_term),
        (cfg.w_weakness, weakness_term),
        (cfg.w_grudge, grudge_term),
        (cfg.w_guild, guild_term),
        (cfg.w_speed, speed_term),
        (cfg.w_history, history_term),
    ];
    let total_w: f64 = terms.iter().map(|(w, _)| w.max(0.0)).sum();
    if total_w <= 0.0 {
        return 0.0;
    }
    let sum: f64 = terms.iter().map(|(w, t)| w.max(0.0) * t.clamp(0.0, 1.0)).sum();
    (100.0 * sum / total_w).clamp(0.0, 100.0)
}

/// Our record against this planet: 0.5 when we've never tried it (neutral), the
/// realised win rate otherwise.
fn history_win_rate(planet_id: &str) -> f64 {
    HISTORY
        .lock()
        .ok()
        .and_then(|h| h.get(planet_id).copied())
        .map(|(att, win)| if att == 0 { 0.5 } else { win as f64 / att as f64 })
        .unwrap_or(0.5)
}

/// Hard gates, evaluated BEFORE the score so nothing can outrank a veto.
/// Returns `None` for GO, or the reason it's a NO-GO.
pub fn gate(c: &Candidate, cfg: &AutoRaidConfig, cooldown_remaining_mins: f64) -> Option<String> {
    // Friend-or-foe first: our own accounts, allied guilds and protected players
    // are never targets, whatever they're holding.
    if crate::mcp::combat_lists::is_vetoed(&c.player_id, Some(&c.guild_id)) {
        return Some("vetoed (own team, allied guild, or protected)".into());
    }
    if c.planet_id.is_empty() {
        return Some("no planet".into());
    }
    if c.stored_ore < cfg.min_ore {
        return Some(format!("ore {:.0} < min_ore {:.0}", c.stored_ore, cfg.min_ore));
    }
    if cfg.require_vulnerable_now && !c.vulnerable {
        // The decisive gate: 0 of 50 non-vulnerable raids in the dataset ever
        // succeeded, and going anyway drops our own shields for the trip.
        return Some("shields not vulnerable (0-for-50 historically)".into());
    }
    if c.raid_minutes > cfg.max_raid_minutes as f64 {
        return Some(format!(
            "raid proof needs ~{:.0} min > max_raid_minutes {}",
            c.raid_minutes, cfg.max_raid_minutes
        ));
    }
    if c.defenders_on_cmd > cfg.max_defenders {
        return Some(format!(
            "{} defenders on the Command Ship > max_defenders {}",
            c.defenders_on_cmd, cfg.max_defenders
        ));
    }
    if cooldown_remaining_mins > 0.0 {
        return Some(format!("target cooldown, {:.0} min left", cooldown_remaining_mins));
    }
    if cfg.skip_if_defender_active_mins > 0 {
        let active_mins = c.blocks_since_action as f64 * BLOCK_SECONDS / 60.0;
        if active_mins < cfg.skip_if_defender_active_mins as f64 {
            return Some(format!(
                "defender acted {:.0} min ago (< {})",
                active_mins, cfg.skip_if_defender_active_mins
            ));
        }
    }
    None
}

/// Is `hour_utc` inside the configured raid window? An empty list means always.
pub fn in_raid_window(cfg: &AutoRaidConfig, hour_utc: u32) -> bool {
    cfg.raid_hours_utc.is_empty() || cfg.raid_hours_utc.contains(&hour_utc)
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
    scan(app_handle, &cfg, &run).await;
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
    supervise(app, &client, cfg, run).await;

    // ── Phase A: candidates. ──
    let roster = refresh_roster(&client, cfg).await;
    if roster.is_empty() {
        return;
    }
    let batch = next_batch(&roster, cfg.evaluate_per_scan);

    // ── Phase B: evaluate + score. ──
    let client_c = client.clone();
    let mut board: Vec<Candidate> = crate::mcp::loop_util::map_concurrent(
        batch,
        crate::mcp::loop_util::effective_max_concurrent(),
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
    let best = board
        .iter()
        .find(|c| c.blocked_by.is_none() && c.score >= cfg.min_score)
        .cloned();
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

    let advise = cfg.autonomy == Autonomy::Advise || cfg.dry_run;
    if advise {
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

    if !in_raid_window(cfg, current_hour_utc()) {
        run.blocked(format!(
            "outside the configured raid window (UTC hour {} not in raid_hours_utc)",
            current_hour_utc()
        ));
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

/// Sweep the chain's player list into a cached roster of non-team candidates.
/// Deliberately bounded (`sweep_max_pages`) and long-lived (`roster_ttl_secs`):
/// identity and guild rarely change, and the expensive per-target reads happen
/// in `evaluate`, not here.
async fn refresh_roster(client: &CosmosClient, cfg: &AutoRaidConfig) -> Vec<RosterEntry> {
    {
        let cache = ROSTER.lock().unwrap();
        if !cache.1.is_empty() && now_millis() - cache.0 < cfg.roster_ttl_secs as f64 * 1000.0 {
            return cache.1.clone();
        }
    }
    let mut out: Vec<RosterEntry> = Vec::new();
    let mut key: Option<String> = None;
    for _ in 0..cfg.sweep_max_pages.max(1) {
        let Ok(page) = client.list_entities("player", key.as_deref(), Some(100)).await else { break };
        if let Some(arr) = page.get("Player").and_then(|x| x.as_array()) {
            for p in arr {
                let Some(id) = p.get("id").and_then(|x| x.as_str()) else { continue };
                // A player with no planet has nothing to raid.
                if p.get("planetId").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
                    continue;
                }
                let guild = p.get("guildId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if crate::mcp::combat_lists::is_vetoed(id, Some(&guild)) {
                    continue;
                }
                out.push((id.to_string(), guild));
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
    // Anyone we hold a grudge against is always a candidate, even if the bounded
    // sweep never reached their page.
    for g in crate::mcp::combat_lists::get().grudges {
        if g.muted || out.iter().any(|(id, _)| *id == g.player_id) {
            continue;
        }
        out.push((g.player_id.clone(), g.guild_id.clone().unwrap_or_default()));
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
        if lists.grudges.iter().any(|g| &g.player_id == id && !g.muted) {
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
async fn evaluate(client: &CosmosClient, player_id: &str, guild_id: &str) -> Option<Candidate> {
    let pl = client.query_entity("player", player_id).await.ok()?;
    let p = pl.get("Player")?;
    let planet_id = p.get("planetId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let fleet_id = p.get("fleetId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if planet_id.is_empty() {
        return None;
    }
    let ga = pl.get("gridAttributes");
    let stored_ore = crate::mcp::loop_util::parse_f64(ga.and_then(|x| x.get("ore")));
    let last_action = crate::mcp::loop_util::read_u64_field(ga, "lastAction");
    let current_block = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.current_block_height)
        .unwrap_or(0);

    let planet = client.query_entity("planet", &planet_id).await.ok()?;
    let planetary_shield = crate::mcp::loop_util::read_u64_field(planet.get("planetAttributes"), "planetaryShield");

    // ── Vulnerability: the chain's IsDefenderCommandStructVulnerable(), which is
    // the single variable that decides whether a raid can complete at all. ──
    let mut reasons: Vec<&str> = Vec::new();
    let mut command_struct: Option<String> = None;
    let mut enemy_fleet_structs = 0usize;
    if fleet_id.is_empty() {
        reasons.push("no fleet");
    } else if let Ok(fl) = client.query_entity("fleet", &fleet_id).await {
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
                if let Ok(e) = client.query_entity("struct", cs).await {
                    let sa = e.get("structAttributes");
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
        player_id: player_id.to_string(),
        name: p
            .get("name")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(player_id)
            .to_string(),
        guild_id: guild_id.to_string(),
        planet_id,
        fleet_id,
        stored_ore,
        planetary_shield,
        raid_minutes: raid_ready_minutes(planetary_shield, get().raid_difficulty),
        vulnerable,
        vulnerability_reason: if vulnerable {
            format!("VULNERABLE — {}", reasons.join(", "))
        } else {
            "shields up (Command Ship online, fleet on station)".to_string()
        },
        command_struct,
        defenders_on_cmd,
        enemy_fleet_structs,
        last_action_block: last_action,
        blocks_since_action: current_block.saturating_sub(last_action),
        score: 0.0,
        blocked_by: None,
    })
}

fn cooldown_remaining_mins(planet_id: &str, cooldown_mins: u32) -> f64 {
    let now = now_millis();
    TARGET_COOLDOWN
        .lock()
        .ok()
        .and_then(|m| m.get(planet_id).copied())
        .map(|t| {
            let elapsed_mins = (now - t) / 60_000.0;
            (cooldown_mins as f64 - elapsed_mins).max(0.0)
        })
        .unwrap_or(0.0)
}

fn current_hour_utc() -> u32 {
    // Chain block height is the only monotonic clock available inside a loop
    // (Date::now is unavailable in some build paths), so derive the hour from
    // the system clock via std, which IS available here.
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| ((d.as_secs() / 3600) % 24) as u32)
        .unwrap_or(0)
}

/// Send a raider to `target`. Phase C proper: pick an idle raider, move its
/// fleet, and register the expedition for Phase D to supervise.
async fn dispatch(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    cfg: &AutoRaidConfig,
    target: &Candidate,
) -> Result<String, String> {
    let (raider_pid, raider_idx) = pick_raider(client, cfg).await.ok_or_else(|| {
        "no idle raider available (need a VPlayerRole::Raider with a live Command Ship, on station)".to_string()
    })?;
    let (fleet_id, home_planet) = raider_location(client, &raider_pid)
        .await
        .ok_or_else(|| format!("could not resolve {}'s fleet", raider_pid))?;

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
            target_player: target.player_id.clone(),
            started_ms: now_millis(),
            hashing: false,
            ongoing_since_block: None,
            siege_shots: 0,
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
async fn pick_raider(client: &CosmosClient, cfg: &AutoRaidConfig) -> Option<(String, u32)> {
    use crate::mcp::virtual_players::VPlayerRole;
    let busy: Vec<String> = ACTIVE.lock().map(|a| a.keys().cloned().collect()).unwrap_or_default();
    let candidates: Vec<(String, u32)> = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().ok()?;
        reg.players
            .iter()
            .filter(|p| p.role == VPlayerRole::Raider)
            .filter_map(|p| p.player_id.clone().map(|id| (id, p.index)))
            .filter(|(id, _)| {
                !busy.contains(id)
                    && (cfg.raider_players.is_empty() || cfg.raider_players.contains(id))
            })
            .collect()
    };
    for (pid, idx) in candidates {
        let Ok(pl) = client.query_entity("player", &pid).await else { continue };
        let p = pl.get("Player");
        let fleet = p.and_then(|x| x.get("fleetId")).and_then(|x| x.as_str()).unwrap_or("");
        if fleet.is_empty() {
            continue;
        }
        let Ok(fl) = client.query_entity("fleet", fleet).await else { continue };
        let f = fl.get("Fleet");
        if f.and_then(|x| x.get("status")).and_then(|x| x.as_str()) != Some("onStation") {
            continue; // already in the field
        }
        // A raider with no Command Ship can neither move nor raid.
        let cmd = f.and_then(|x| x.get("commandStruct")).and_then(|x| x.as_str()).unwrap_or("");
        if cmd.is_empty() {
            continue;
        }
        if let Ok(e) = client.query_entity("struct", cmd).await {
            if crate::mcp::loop_util::parse_bool(
                e.get("structAttributes").and_then(|x| x.get("isDestroyed")),
            ) {
                continue;
            }
        }
        return Some((pid, idx));
    }
    None
}

async fn raider_location(client: &CosmosClient, pid: &str) -> Option<(String, String)> {
    let pl = client.query_entity("player", pid).await.ok()?;
    let p = pl.get("Player")?;
    let fleet = p.get("fleetId").and_then(|x| x.as_str())?.to_string();
    let planet = p.get("planetId").and_then(|x| x.as_str())?.to_string();
    Some((fleet, planet))
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
        if elapsed_mins > cfg.max_raid_wall_minutes as f64 {
            abort = Some(format!("exceeded max_raid_wall_minutes ({})", cfg.max_raid_wall_minutes));
        }
        // The raider's own Command Ship dying while away is exactly how our 9
        // `attackerDefeated` losses happened; pull out before that.
        if abort.is_none() {
            if let Ok(fl) = client.query_entity("fleet", &ex.fleet_id).await {
                let cmd = fl
                    .get("Fleet")
                    .and_then(|x| x.get("commandStruct"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if cmd.is_empty() {
                    abort = Some("raider Command Ship lost".into());
                } else if let Ok(e) = client.query_entity("struct", cmd).await {
                    let sa = e.get("structAttributes");
                    if crate::mcp::loop_util::parse_bool(sa.and_then(|x| x.get("isDestroyed"))) {
                        abort = Some("raider Command Ship destroyed".into());
                    } else {
                        let hp = crate::mcp::loop_util::parse_f64(sa.and_then(|x| x.get("health")));
                        if hp > 0.0 && hp < cfg.abort_cmd_hp_below {
                            abort = Some(format!("raider Command Ship at {hp:.0} HP"));
                        }
                    }
                }
            }
        }

        // ── The raid clock. `blockStartRaid == 0` means either no raider is
        // present or the defender isn't vulnerable — the chain collapses both
        // into one value, so a zero after we've arrived means shields are back. ──
        if abort.is_none() {
            let clock = client
                .query_entity("planet", &ex.target_planet)
                .await
                .ok()
                .map(|e| crate::mcp::loop_util::read_u64_field(e.get("planetAttributes"), "blockStartRaid"))
                .unwrap_or(0);
            if clock == 0 {
                // Siege: the clock stays unset while the defender's Command Ship
                // is up, so with `allow_siege` we spend the trip trying to take
                // it down rather than waiting out the abort timer. Capped by
                // `siege_max_shots` across the whole expedition — this is the
                // expensive, provocative path and it should never run away.
                if cfg.allow_siege && ex.siege_shots < cfg.siege_max_shots {
                    let spent = siege_round(app, client, cfg, &ex).await;
                    if spent > 0 {
                        ex.siege_shots += spent;
                        ex.note = format!("siege — {}/{} shots spent", ex.siege_shots, cfg.siege_max_shots);
                        // Keep the abort clock parked while we're making progress.
                        ex.ongoing_since_block = None;
                        ACTIVE.lock().unwrap().insert(ex.raider_player.clone(), ex);
                        continue;
                    }
                }
                let since = *ex.ongoing_since_block.get_or_insert(current_block);
                if current_block.saturating_sub(since) > cfg.abort_on_ongoing_blocks {
                    abort = Some(if cfg.allow_siege {
                        "siege failed to open a window".into()
                    } else {
                        "defender restored shields (raid clock unset)".to_string()
                    });
                }
            } else {
                ex.ongoing_since_block = None;
                if !ex.hashing {
                    match start_raid_proof(app, &ex, clock, cfg.raid_difficulty).await {
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
                }
            }
        }

        match abort {
            Some(why) => {
                if cfg.return_home_after {
                    let _ = crate::mcp::tx_retry::sign_with_retry(
                        app,
                        ex.raider_index,
                        "/structs.structs.MsgFleetMove",
                        json!({ "fleetId": ex.fleet_id, "destinationLocationId": ex.home_planet }),
                        &format!("auto_raid:{}", ex.raider_player),
                    )
                    .await;
                }
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
    cfg: &AutoRaidConfig,
    ex: &Expedition,
) -> usize {
    // Re-resolve the defender's Command Ship each round: it may have been
    // rebuilt, or already killed by the previous round.
    let Ok(pl) = client.query_entity("player", &ex.target_player).await else { return 0 };
    let fleet = pl
        .get("Player")
        .and_then(|p| p.get("fleetId"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty());
    let Some(fleet) = fleet else { return 0 };
    let Ok(fl) = client.query_entity("fleet", fleet).await else { return 0 };
    let cmd = fl
        .get("Fleet")
        .and_then(|f| f.get("commandStruct"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty());
    let Some(cmd) = cmd else { return 0 }; // already down — the clock should arm
    if client
        .query_entity("struct", cmd)
        .await
        .map(|e| {
            crate::mcp::loop_util::parse_bool(e.get("structAttributes").and_then(|a| a.get("isDestroyed")))
        })
        .unwrap_or(false)
    {
        return 0;
    }

    let Ok(plan) = crate::mcp::tools::intel::plan_strike(
        client,
        &json!({ "target": cmd, "players": [ex.raider_player.clone()] }),
    )
    .await
    else {
        return 0;
    };
    // One shot per player per charge cycle, best (evasion- and counter-aware)
    // first, bounded by whatever siege budget is left.
    let budget = cfg.siege_max_shots.saturating_sub(ex.siege_shots);
    let mut shots: Vec<&crate::mcp::tools::intel::StrikeRow> =
        plan.rows.iter().filter(|r| r.reachable).collect();
    shots.sort_by(|a, b| {
        a.counter_exposure
            .cmp(&b.counter_exposure)
            .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    let Some(best) = shots.first() else { return 0 };
    if budget == 0 || cfg.dry_run {
        return 0;
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
            "targetStructId": [cmd],
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
                    "siege: {} fired {} at {}'s Command Ship {} (~{:.1} dmg, {} counter exposure)",
                    ex.raider_player, best.struct_id, ex.target_player, cmd, best.expected_dmg, best.counter_exposure
                ),
            );
            1
        }
        Err(e) => {
            crate::mcp::telemetry::tlog(
                "auto_raid",
                crate::mcp::telemetry::Sev::Warn,
                format!("siege shot failed for {}: {}", ex.raider_player, e),
            );
            0
        }
    }
}

async fn start_raid_proof(
    app: &tauri::AppHandle,
    ex: &Expedition,
    block_start_raid: u64,
    difficulty: u64,
) -> Result<(), String> {
    use crate::hasher::types::{TaskParams, TaskRegistry};
    use std::sync::Arc;
    use tauri::Manager;
    let registry = app
        .try_state::<Arc<TaskRegistry>>()
        .map(|r| r.inner().clone())
        .ok_or_else(|| "task registry unavailable".to_string())?;
    let params = TaskParams::for_raid(&ex.fleet_id, &ex.target_planet, block_start_raid, difficulty);
    crate::hasher::start_hash_task_core(params, app.clone(), &registry)?;
    crate::hasher::register_vplayer_hash(ex.fleet_id.clone(), ex.raider_index, "RAID".to_string());
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
            player_id: "1-61".into(),
            name: "JPEG".into(),
            guild_id: "0-1".into(),
            planet_id: "2-855".into(),
            fleet_id: "9-61".into(),
            stored_ore: 100.0,
            planetary_shield: 125,
            raid_minutes: 12.0,
            vulnerable: true,
            vulnerability_reason: "VULNERABLE — fleet off-station".into(),
            command_struct: Some("5-14098".into()),
            defenders_on_cmd: 1,
            enemy_fleet_structs: 4,
            last_action_block: 0,
            blocks_since_action: 100_000,
            score: 0.0,
            blocked_by: None,
        }
    }

    #[test]
    fn defaults_are_safe_and_opportunist() {
        isolate_lists();
        let c = AutoRaidConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.autonomy, Autonomy::Advise);
        assert!(c.require_vulnerable_now);
        assert!(!c.allow_siege);
        assert_eq!(c.max_concurrent_raids, 1);
    }

    /// Each posture must produce exactly the documented gate table.
    #[test]
    fn postures_set_the_documented_gates() {
        isolate_lists();
        let mut c = AutoRaidConfig::default();
        c.apply_posture(RaidPosture::Cautious);
        assert_eq!((c.min_ore, c.min_score, c.max_raid_minutes, c.max_defenders), (30.0, 75.0, 10, 2));
        assert!(c.require_vulnerable_now && !c.allow_siege);

        c.apply_posture(RaidPosture::Opportunist);
        assert_eq!((c.min_ore, c.min_score, c.max_raid_minutes, c.max_defenders), (15.0, 55.0, 20, 4));

        c.apply_posture(RaidPosture::Aggressive);
        assert_eq!((c.min_ore, c.min_score, c.max_raid_minutes, c.max_defenders), (5.0, 35.0, 45, 8));
        assert!(!c.require_vulnerable_now && c.allow_siege);
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

    #[test]
    fn a_non_vulnerable_target_is_gated_out() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.vulnerable = false;
        let why = gate(&c, &cfg, 0.0).expect("must be blocked");
        assert!(why.contains("vulnerable"), "got: {why}");
    }

    #[test]
    fn thin_piles_are_gated_out() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.stored_ore = 3.0;
        assert!(gate(&c, &cfg, 0.0).unwrap().contains("min_ore"));
    }

    #[test]
    fn a_slow_proof_and_a_thick_guard_are_gated_out() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut slow = cand();
        slow.raid_minutes = 999.0;
        assert!(gate(&slow, &cfg, 0.0).unwrap().contains("max_raid_minutes"));

        let mut guarded = cand();
        guarded.defenders_on_cmd = 99;
        assert!(gate(&guarded, &cfg, 0.0).unwrap().contains("max_defenders"));
    }

    #[test]
    fn an_awake_defender_and_a_cooldown_both_block() {
        isolate_lists();
        let cfg = AutoRaidConfig::default();
        let mut fresh = cand();
        fresh.blocks_since_action = 10; // ~1 minute ago
        assert!(gate(&fresh, &cfg, 0.0).unwrap().contains("acted"));
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
        cfg.w_vulnerability = 0.0;
        cfg.w_weakness = 0.0;
        cfg.w_grudge = 0.0;
        cfg.w_guild = 0.0;
        cfg.w_speed = 0.0;
        cfg.w_history = 0.0;
        assert_eq!(score(&cand(), &cfg), 0.0);
    }

    #[test]
    fn siege_gives_a_non_vulnerable_target_partial_credit_but_only_when_allowed() {
        isolate_lists();
        let mut cfg = AutoRaidConfig::default();
        let mut c = cand();
        c.vulnerable = false;
        let closed = score(&c, &cfg);
        cfg.allow_siege = true;
        assert!(score(&c, &cfg) > closed);
    }

    /// Aggressive posture is the only configuration that lets a non-vulnerable
    /// target through the gate — and it must also turn siege on, because
    /// otherwise the raider would sit at the planet doing nothing until the
    /// abort timer fired. The two settings have to move together.
    #[test]
    fn only_aggressive_dispatches_against_a_closed_window_and_it_sieges() {
        isolate_lists();
        let mut c = cand();
        c.vulnerable = false;

        let mut cfg = AutoRaidConfig::default();
        for p in [RaidPosture::Cautious, RaidPosture::Opportunist] {
            cfg.apply_posture(p);
            assert!(gate(&c, &cfg, 0.0).is_some(), "{p:?} must refuse a closed window");
        }
        cfg.apply_posture(RaidPosture::Aggressive);
        assert!(gate(&c, &cfg, 0.0).is_none(), "aggressive should accept it");
        assert!(cfg.allow_siege, "…and must be able to force the window open");
        assert!(cfg.siege_max_shots > 0, "…with a non-zero shot budget");
    }

    #[test]
    fn raid_window_is_open_when_unconfigured() {
        isolate_lists();
        let mut cfg = AutoRaidConfig::default();
        assert!(in_raid_window(&cfg, 3));
        cfg.raid_hours_utc = vec![15, 16, 17, 18, 19, 20];
        assert!(in_raid_window(&cfg, 17));
        assert!(!in_raid_window(&cfg, 3));
    }

    #[test]
    fn round_robin_covers_the_roster_across_scans() {
        isolate_lists();
        let roster: Vec<RosterEntry> = (0..10)
            .map(|i| (format!("1-{i}"), "0-9".to_string()))
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
