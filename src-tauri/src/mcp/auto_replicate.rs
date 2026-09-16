//! REPLICATION — the no-decisions wrapper over launching virtual players.
//!
//! One button, one switch. A press is always accepted and always does the
//! same thing: `queue += 1`. Nothing else in the app creates a player from a
//! press — only this loop births them, and only as many as the machine can
//! afford this round:
//!
//! ```text
//! energy_room = max(0, guild substation supportable_more)     // keeper-exact dilution, 4 kW each
//! hash_room   = 0             if the GPU budget is saturated or load1/cores > cpu_ceiling
//!             = 1             if the hasher backlog is over pending_per_worker × workers
//!             = max_per_round otherwise
//! room        = min(max_per_round, energy_room, hash_room, ceiling − replicants)
//! ```
//!
//! With **Autonomous Replication** on (off by default), each round draws a
//! target uniformly between 0 and the room and tops the queue up to it —
//! never always the maximum, so the roster grows in fits rather than at a
//! machine-exact pace. Presses on top are kept, never replaced, and are
//! drained to the full room. Presses beyond the room stay queued as
//! `held · <reason>` and are born when the room returns.
//!
//! Which BEHAVIOURAL SNAPSHOT a replicant is born with is a QUOTA over the
//! snapshots' `replication_weight`s: each birth takes the snapshot whose share
//! of the roster is furthest below its target share, so the mix converges on
//! the weights instead of wandering around them, and the pick is known before
//! the signup starts (the card can name it while it incubates).
//!
//! Vocabulary: the card says replicate / replicant / behavioural snapshot;
//! this module, its config file and the registry keep launch / vplayer /
//! profile, like every other player-facing rename.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::events::AppEvent;
use crate::mcp::telemetry::{tlog, LoopRun, Sev};
use crate::mcp::virtual_players::{self, VPlayerRole, REGISTRY};
use crate::mcp::{board_feed, capacity};

const FILENAME: &str = "auto_replicate.json";
const QUEUE_CACHE: &str = "replication_queue";
/// Signup-bound (~up to 180 s each); two in flight, as the mass launch.
const LAUNCH_CONCURRENCY: usize = 2;
/// The guild-power read behind the room is a handful of LCD calls; the card
/// polls every few seconds, so the last answer is reused this long.
const POWER_TTL_MS: f64 = 60_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoReplicateConfig {
    /// "Autonomous Replication". Off by default — it signs signups and
    /// explores, and grows the roster on its own.
    pub enabled: bool,
    /// Seconds between rounds.
    pub interval_secs: u64,
    /// Most births one round may start. A round of five at two concurrent
    /// signups is about eight minutes.
    pub max_per_round: usize,
    /// Per-connection share the entry substation must still offer after the
    /// births (raw mW). The keeper's own dilution rule, one value.
    pub min_share_mw: f64,
    /// 1-minute load average over cores above which hashing room is 0.
    pub cpu_ceiling: f64,
    /// Hasher backlog per worker that counts as "busy" (room drops to 1).
    pub pending_per_worker: u32,
    /// Most replicants to keep, 0 = unlimited (the registry's own cap today).
    pub ceiling: usize,
    /// Compute the round and log it, sign nothing.
    pub dry_run: bool,
    /// Autonomous rounds draw their target uniformly in 0..=room instead of
    /// always taking the whole room. Off = the old exact top-up.
    #[serde(default = "default_true")]
    pub random_rounds: bool,
    /// Replication-weight OVERRIDES by snapshot id. A built-in snapshot is
    /// read-only, so its weight lives here instead; a custom snapshot carries
    /// its own `replication_weight` and an entry here wins over it.
    #[serde(default)]
    pub weights: HashMap<String, f64>,
}

impl Default for AutoReplicateConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_secs: 300,
            max_per_round: 5,
            min_share_mw: crate::mcp::guild_power::MIN_PLAYER_DRAW_MW,
            cpu_ceiling: 0.85,
            pending_per_worker: 4,
            ceiling: 0,
            dry_run: false,
            random_rounds: true,
            weights: HashMap::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

static CONFIG: LazyLock<RwLock<AutoReplicateConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
static RUN_GEN: AtomicU64 = AtomicU64::new(0);

fn load() -> AutoReplicateConfig {
    crate::mcp::config_store::load_config(FILENAME)
}
pub fn get() -> AutoReplicateConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}
pub fn set(cfg: AutoReplicateConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

// ── The queue ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Incubating {
    pub index: u32,
    pub name: String,
    pub snapshot: String,
    pub started_ms: f64,
}

/// Persisted through `cache_store`: a restart must not lose a press.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct QueueState {
    /// Presses not yet born.
    #[serde(default)]
    pending: u32,
    /// Births in flight right now (transient, but cheap to keep).
    #[serde(default)]
    incubating: Vec<Incubating>,
    /// The last round's room and what bound it.
    #[serde(default)]
    room: usize,
    #[serde(default)]
    held_reason: Option<String>,
    #[serde(default)]
    last_round_ms: f64,
    /// Timestamps (ms) of births, for the card's "24h" count.
    #[serde(default)]
    births: Vec<f64>,
    /// Presses this session, for the feed line.
    #[serde(default)]
    presses: u64,
}

static QUEUE: LazyLock<Mutex<QueueState>> =
    LazyLock::new(|| Mutex::new(crate::mcp::cache_store::load(QUEUE_CACHE).unwrap_or_default()));

fn q() -> std::sync::MutexGuard<'static, QueueState> {
    QUEUE.lock().unwrap_or_else(|p| p.into_inner())
}
fn persist(s: &QueueState) {
    crate::mcp::cache_store::save(QUEUE_CACHE, s);
}

/// The card's live state. Emitted on every change and returned by the read.
pub fn view() -> Value {
    let cfg = get();
    let s = q();
    let now = now_millis();
    let replicants = REGISTRY.read().map(|r| r.players.len()).unwrap_or(0);
    let next_round_ms = if cfg.enabled || s.pending > 0 {
        let last = *LAST_RUN.lock().unwrap_or_else(|p| p.into_inner());
        Some((last + cfg.interval_secs as f64 * 1000.0 - now).max(0.0))
    } else {
        None
    };
    let held = s.pending.saturating_sub(s.incubating.len() as u32);
    json!({
        "queue": s.pending,
        "replicants": replicants,
        "incubating": s.incubating,
        "room": s.room,
        "max_per_round": cfg.max_per_round,
        "enabled": cfg.enabled,
        "held": { "n": held, "reason": if held > 0 { s.held_reason.clone() } else { None } },
        "next_round_ms": next_round_ms,
        "last_round_ms": s.last_round_ms,
        "births_24h": s.births.iter().filter(|t| now - **t <= 24.0 * 3_600_000.0).count(),
        "running": RUNNING.load(Ordering::Relaxed),
    })
}

fn announce(app: &tauri::AppHandle) {
    let _ = crate::mcp::events::emit(app, AppEvent::Replication(view()));
}

/// The button. Always accepted; nudges a round (which still honours the room).
pub fn press(app: &tauri::AppHandle, n: u32) -> Value {
    let n = n.clamp(1, 50);
    {
        let mut s = q();
        s.pending = s.pending.saturating_add(n);
        s.presses += n as u64;
        persist(&s);
    }
    announce(app);
    let app_t = app.clone();
    tauri::async_runtime::spawn(async move {
        tick(&app_t, true).await;
    });
    view()
}

// ── Room: the pure half ──────────────────────────────────────────────────────

/// What the machine sees when it decides a round. Gathered in `round`, judged
/// here, so the judgement is a function tests can drive.
#[derive(Debug, Clone, Default)]
pub struct Signals {
    /// `guild_power::supportable_more` — how many more players fit at
    /// `min_share_mw` each; negative when already oversubscribed. `None` when
    /// the power read failed (room 0, reason "chain").
    pub energy_room: Option<i64>,
    pub gpu_saturated: bool,
    /// 1-minute load average / cores, if the platform answers.
    pub cpu_load: Option<f64>,
    pub hasher_pending: usize,
    pub hasher_workers: usize,
    pub replicants: usize,
    pub bridge_up: bool,
}

/// `(room, binding reason)`. The reason names what stopped the room reaching
/// `max_per_round`, or `None` when nothing did. Order of blame: the bridge
/// (nothing can be born), then the ceiling, then energy, then hashing.
pub fn room_for(cfg: &AutoReplicateConfig, s: &Signals) -> (usize, Option<&'static str>) {
    if !s.bridge_up {
        return (0, Some("bridge"));
    }
    let max = cfg.max_per_round;
    let mut room = max;
    let mut why: Option<&'static str> = None;
    if cfg.ceiling > 0 {
        let left = cfg.ceiling.saturating_sub(s.replicants);
        if left < room {
            room = left;
            why = Some("ceiling");
        }
    }
    match s.energy_room {
        None => return (0, Some("chain")),
        Some(e) => {
            let e = e.max(0) as usize;
            if e < room {
                room = e;
                why = Some("energy");
            }
        }
    }
    let hash_room = if s.gpu_saturated || s.cpu_load.map(|l| l > cfg.cpu_ceiling).unwrap_or(false) {
        0
    } else if s.hasher_workers > 0 && s.hasher_pending > s.hasher_workers * cfg.pending_per_worker as usize {
        1
    } else {
        max
    };
    if hash_room < room {
        room = hash_room;
        why = Some("hashing");
    }
    (room, if room < max { why } else { None })
}

/// How many births an autonomous round asks for, given the room. `roll` is a
/// uniform draw in [0, 1): every count from 0 to `room` inclusive is equally
/// likely, so a round may sit out entirely or take the whole room. With
/// `random_rounds` off it is the room itself.
pub fn autonomous_target(cfg: &AutoReplicateConfig, room: usize, roll: f64) -> usize {
    if !cfg.random_rounds {
        return room;
    }
    let r = if roll.is_finite() { roll.clamp(0.0, 1.0) } else { 0.0 };
    (((room + 1) as f64) * r).floor().min(room as f64) as usize
}

/// Quota pick: the snapshot whose share of the roster is furthest below its
/// target share. `weights` is (snapshot id, replication_weight), `counts` how
/// many replicants each snapshot has today. Snapshots at weight 0 are never
/// picked. Ties fall to the earlier entry, so the pick is deterministic.
pub fn quota_pick(weights: &[(String, f64)], counts: &HashMap<String, usize>) -> Option<String> {
    let eligible: Vec<&(String, f64)> = weights.iter().filter(|(_, w)| *w > 0.0 && w.is_finite()).collect();
    let total_w: f64 = eligible.iter().map(|(_, w)| w).sum();
    if eligible.is_empty() || total_w <= 0.0 {
        return None;
    }
    let total_n: usize = eligible.iter().map(|(id, _)| counts.get(id).copied().unwrap_or(0)).sum();
    let mut best: Option<(&String, f64)> = None;
    for (id, w) in &eligible {
        let target = w / total_w;
        let actual = if total_n > 0 { counts.get(id).copied().unwrap_or(0) as f64 / total_n as f64 } else { 0.0 };
        let deficit = target - actual;
        if best.map(|(_, d)| deficit > d).unwrap_or(true) {
            best = Some((id, deficit));
        }
    }
    best.map(|(id, _)| id.clone())
}

/// The legacy `role` a snapshot implies, for the consumers that still read
/// it (the portrait theme, the variance temperaments). A fork of a built-in
/// keeps its parent's answer because it keeps its parent's capabilities.
pub fn role_for_snapshot(p: &crate::mcp::profile::Profile) -> VPlayerRole {
    if p.capabilities.raids {
        VPlayerRole::Raider
    } else if p.capabilities.refines {
        VPlayerRole::Productive
    } else {
        VPlayerRole::Bait
    }
}

fn snapshot_counts() -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    if let Ok(reg) = REGISTRY.read() {
        for v in reg.players.iter() {
            let id = v.profile.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| v.role.as_str().to_string());
            *counts.entry(id).or_insert(0) += 1;
        }
    }
    counts
}

/// The weight that counts for a snapshot: the loop's override when one is
/// set, else the snapshot's own.
pub fn weight_of(p: &crate::mcp::profile::Profile) -> f64 {
    get().weights.get(&p.id).copied().unwrap_or(p.replication_weight)
}

fn snapshot_weights() -> Vec<(String, f64)> {
    let cfg = get();
    crate::mcp::profile::list()
        .into_iter()
        .map(|p| {
            let w = cfg.weights.get(&p.id).copied().unwrap_or(p.replication_weight);
            (p.id, w)
        })
        .collect()
}

/// Set a snapshot's replication weight from the editor. A built-in is
/// read-only, so its weight is an override here; a custom snapshot's own
/// field is written and any stale override for it cleared, so the profile
/// document stays the one truth for a snapshot the operator authored.
pub fn set_weight(id: &str, weight: f64) -> Result<String, String> {
    if !weight.is_finite() || !(0.0..=100.0).contains(&weight) {
        return Err(format!("replication weight {weight} is outside 0..100"));
    }
    let builtin = crate::mcp::profile::BUILTIN.iter().any(|b| b.id == id);
    let mut cfg = get();
    if builtin {
        cfg.weights.insert(id.to_string(), weight);
        set(cfg);
    } else {
        let mut p = crate::mcp::profile::find(id);
        if p.id != id {
            return Err(format!("no behavioural snapshot '{id}'"));
        }
        p.replication_weight = weight;
        crate::mcp::profile::set(p)?;
        if cfg.weights.remove(id).is_some() {
            set(cfg);
        }
    }
    Ok(format!("snapshot '{id}' → replication weight {weight}"))
}

/// 1-minute load average over cores. `None` where the platform has no answer.
pub fn cpu_load_1m() -> Option<f64> {
    #[cfg(unix)]
    {
        let mut loads = [0f64; 3];
        // SAFETY: getloadavg writes at most `3` doubles into a 3-double array.
        let n = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
        if n >= 1 {
            let cores = num_cpus::get().max(1) as f64;
            return Some(loads[0] / cores);
        }
        None
    }
    #[cfg(not(unix))]
    {
        None
    }
}

// ── Guild power, cached for the card ─────────────────────────────────────────

static POWER: LazyLock<Mutex<(f64, Option<crate::mcp::guild_power::GuildPower>)>> =
    LazyLock::new(|| Mutex::new((0.0, None)));

async fn guild_power(fresh: bool) -> Option<crate::mcp::guild_power::GuildPower> {
    let now = now_millis();
    if !fresh {
        let c = POWER.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(gp) = &c.1 {
            if now - c.0 < POWER_TTL_MS {
                return Some(gp.clone());
            }
        }
    }
    let guild_id = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| g.guild_id.clone())
        .filter(|s| !s.is_empty())?;
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    match crate::mcp::guild_power::resolve_guild_power(&client, &guild_id).await {
        Ok(gp) => {
            *POWER.lock().unwrap_or_else(|p| p.into_inner()) = (now, Some(gp.clone()));
            Some(gp)
        }
        Err(e) => {
            tlog("replicate", Sev::Warn, format!("guild power unreadable: {e}"));
            None
        }
    }
}

fn signals(gp: Option<&crate::mcp::guild_power::GuildPower>, cfg: &AutoReplicateConfig) -> Signals {
    let energy_room = gp.map(|g| {
        if g.sub_capacity <= 0.0 {
            // No entry substation resolved: the create gate treats this as
            // "nothing to dilute" and lets one through; so do we, one at a time.
            1
        } else {
            let available = (g.sub_capacity - g.sub_load).max(0.0);
            crate::mcp::guild_power::derive_headroom(available, g.sub_connection_count, cfg.min_share_mw).1
        }
    });
    Signals {
        energy_room,
        gpu_saturated: capacity::saturation(capacity::Resource::Gpu).is_some(),
        cpu_load: cpu_load_1m(),
        hasher_pending: crate::hasher::pool::pending_len(),
        hasher_workers: crate::hasher::pool::worker_count() as usize,
        replicants: REGISTRY.read().map(|r| r.players.len()).unwrap_or(0),
        bridge_up: !crate::mcp::vplayer_bridge::is_down(),
    }
}

// ── The loop ─────────────────────────────────────────────────────────────────

/// One round. `force` (a press) skips the interval, never the room.
pub async fn tick(app: &tauri::AppHandle, force: bool) {
    let cfg = get();
    let pending = q().pending;
    if !cfg.enabled && !force && pending == 0 {
        return;
    }
    let now = now_millis();
    {
        let mut last = LAST_RUN.lock().unwrap_or_else(|e| e.into_inner());
        if !force && now - *last < cfg.interval_secs as f64 * 1000.0 {
            return;
        }
        *last = now;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        // A press during a round has already been counted; the round in
        // flight re-reads the queue at its end and the next tick drains it.
        return;
    }
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = LoopRun::start("auto_replicate");

    round(app, &cfg, &run).await;

    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-run".into()));
        return;
    }
    run.finish(None);
    RUNNING.store(false, Ordering::SeqCst);
    announce(app);
}

async fn round(app: &tauri::AppHandle, cfg: &AutoReplicateConfig, run: &LoopRun) {
    let gp = guild_power(true).await;
    let sig = signals(gp.as_ref(), cfg);
    let (room, why) = room_for(cfg, &sig);

    // Autonomous: top the queue up to this round's target — a draw between
    // nothing and the room, so growth has a pulse rather than a pace. Presses
    // on top are kept, and are drained to the full room below.
    let take = {
        let target = if cfg.enabled {
            autonomous_target(cfg, room, rand::Rng::gen::<f64>(&mut rand::thread_rng()))
        } else {
            0
        };
        let mut s = q();
        if (s.pending as usize) < target {
            s.pending = target as u32;
        }
        s.room = room;
        s.held_reason = why.map(String::from);
        s.last_round_ms = now_millis();
        let take = (s.pending as usize).min(room);
        persist(&s);
        take
    };
    if take == 0 {
        if q().pending > 0 {
            run.blocked(format!("{} held · {}", q().pending, why.unwrap_or("room")));
        }
        return;
    }

    // Pick every snapshot up front so the quota sees each earlier pick.
    let weights = snapshot_weights();
    let mut counts = snapshot_counts();
    let mut picks: Vec<String> = Vec::with_capacity(take);
    for _ in 0..take {
        match quota_pick(&weights, &counts) {
            Some(id) => {
                *counts.entry(id.clone()).or_insert(0) += 1;
                picks.push(id);
            }
            None => break,
        }
    }
    if picks.is_empty() {
        let mut s = q();
        s.held_reason = Some("no snapshot".into());
        persist(&s);
        run.blocked("every behavioural snapshot has replication weight 0");
        return;
    }

    // Explicit index pre-allocation, as the mass launch: concurrent signups
    // racing `next_free_index` was a real incident.
    let base = REGISTRY
        .read()
        .map(|r| r.players.iter().map(|p| p.index).max().unwrap_or(0) + 1)
        .unwrap_or(1);
    let jobs: Vec<(u32, String)> = picks.into_iter().enumerate().map(|(i, snap)| (base + i as u32, snap)).collect();

    if cfg.dry_run {
        let names: Vec<String> = jobs.iter().map(|(i, s)| format!("{} ({s})", crate::mcp::callsign::name_for(*i))).collect();
        board_feed::push(app, board_feed::Severity::Notice, "replicate", format!("dry run: would replicate {} — {}", jobs.len(), names.join(", ")));
        return;
    }

    {
        let mut s = q();
        let now = now_millis();
        for (index, snap) in &jobs {
            s.incubating.push(Incubating { index: *index, name: crate::mcp::callsign::name_for(*index), snapshot: snap.clone(), started_ms: now });
        }
        persist(&s);
    }
    announce(app);
    board_feed::push(
        app,
        board_feed::Severity::Notice,
        "replicate",
        format!("replicating {}{}", jobs.len(), why.map(|w| format!(" · {} held ({w})", q().pending as usize - jobs.len())).unwrap_or_default()),
    );

    let guild_id = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone()).filter(|s| !s.is_empty());
    let app_c = app.clone();
    let guild_c = guild_id.clone();
    crate::mcp::loop_util::for_each_player_concurrent(jobs, LAUNCH_CONCURRENCY, move |(index, snap)| {
        let app = app_c.clone();
        let guild_id = guild_c.clone();
        async move {
            let name = crate::mcp::callsign::name_for(index);
            let profile = crate::mcp::profile::find(&snap);
            let role = role_for_snapshot(&profile);
            // A built-in snapshot is the role's default; storing its id would
            // only pin a fork's future edits away from this player.
            let stored = if crate::mcp::profile::BUILTIN.iter().any(|b| b.id == snap) { None } else { Some(snap.clone()) };
            let res = virtual_players::spawn_one(&app, index, name.clone(), true, role, stored, guild_id).await;
            let mut s = q();
            s.incubating.retain(|i| i.index != index);
            match res {
                Ok(sp) => {
                    s.pending = s.pending.saturating_sub(1);
                    s.births.push(now_millis());
                    let keep = now_millis() - 25.0 * 3_600_000.0;
                    s.births.retain(|t| *t >= keep);
                    persist(&s);
                    drop(s);
                    board_feed::push(
                        &app,
                        board_feed::Severity::Info,
                        "replicate",
                        format!(
                            "replicated {} ({snap}){}{}",
                            sp.name,
                            sp.player_id.as_deref().map(|p| format!(" · {p}")).unwrap_or_default(),
                            if sp.explored { "" } else { " · explore pending" }
                        ),
                    );
                }
                Err(e) => {
                    // The press stays queued for the next round; the reason is
                    // what the card shows meanwhile.
                    s.held_reason = Some("bridge".into());
                    persist(&s);
                    drop(s);
                    tlog("replicate", Sev::Warn, format!("{name}: signup failed: {e}"));
                }
            }
            announce(&app);
        }
    })
    .await;
    run.acted();
    crate::mcp::roster_cache::trigger_sweep(app.clone(), 0.0);
}

/// Watchdog remediation: invalidate the wedged run and clear the guard.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
    let mut s = q();
    s.incubating.clear();
    persist(&s);
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The REPLICATE button. Not board-gated on purpose: the card lives in a
/// Terminal window, whose label a `require_board` check would refuse.
#[tauri::command]
pub async fn mcp_replicate(app: tauri::AppHandle, n: Option<u32>) -> Result<Value, String> {
    Ok(press(&app, n.unwrap_or(1)))
}

/// Everything the Replication card draws, in one read.
#[tauri::command]
pub async fn terminal_replication(app: tauri::AppHandle) -> Result<Value, String> {
    let _ = &app;
    let cfg = get();
    let gp = guild_power(false).await;
    let sig = signals(gp.as_ref(), &cfg);
    let (room, why) = room_for(&cfg, &sig);
    let mut v = view();
    let queue_now = v.get("queue").and_then(|q| q.as_u64()).unwrap_or(0);
    if let Some(o) = v.as_object_mut() {
        // The room as it stands NOW, not as the last round saw it.
        o.insert("room_now".into(), json!(room));
        o.insert("room_reason".into(), json!(why));
        // Energy, the way the create gate sees it: the substation's
        // per-connection share now, and what it becomes once the queue has
        // been born — the keeper's own dilution rule, `(capacity − load) /
        // connectionCount` (grid_context.go), with the queue added to the
        // count. The card draws the projection in amber while a queue exists.
        o.insert(
            "energy".into(),
            match gp.as_ref() {
                Some(g) => {
                    let queue = queue_now;
                    let available = (g.sub_capacity - g.sub_load).max(0.0);
                    let after = if g.sub_connection_count + queue > 0 {
                        available / (g.sub_connection_count + queue) as f64
                    } else {
                        available
                    };
                    json!({
                        "connection_capacity_mw": g.sub_connection_capacity,
                        "connection_count": g.sub_connection_count,
                        "queue": queue,
                        "after_queue_mw": if queue > 0 { Some(after) } else { None },
                        "min_share_mw": cfg.min_share_mw,
                        "supportable_more": sig.energy_room,
                    })
                }
                None => Value::Null,
            },
        );
        o.insert(
            "hashing".into(),
            json!({
                "cpu_1m": sig.cpu_load,
                "pending": sig.hasher_pending,
                "workers": sig.hasher_workers,
                "running": crate::hasher::scheduler::running(),
                "max_concurrent": crate::hasher::max_concurrent(),
                "saturated": sig.gpu_saturated,
            }),
        );
        o.insert("rates".into(), crate::mcp::rates::snapshot());
        // The whole loop config, so the switch can write it back unchanged
        // but for `enabled` — the same round trip CONFIG's row makes.
        o.insert("config".into(), json!(cfg));
        o.insert("snapshots".into(), json!(snapshot_weights().into_iter().map(|(id, w)| json!({"id": id, "weight": w, "n": snapshot_counts().get(&id).copied().unwrap_or(0)})).collect::<Vec<_>>()));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig() -> Signals {
        Signals { energy_room: Some(10), gpu_saturated: false, cpu_load: Some(0.3), hasher_pending: 0, hasher_workers: 8, replicants: 100, bridge_up: true }
    }

    #[test]
    fn room_is_the_tightest_of_the_budgets_and_names_what_bound_it() {
        let cfg = AutoReplicateConfig::default();
        assert_eq!(room_for(&cfg, &sig()), (5, None), "nothing binds: the per-round max");
        assert_eq!(room_for(&cfg, &Signals { energy_room: Some(2), ..sig() }), (2, Some("energy")));
        assert_eq!(room_for(&cfg, &Signals { energy_room: Some(-3), ..sig() }), (0, Some("energy")), "oversubscribed is zero, not negative");
        assert_eq!(room_for(&cfg, &Signals { energy_room: None, ..sig() }), (0, Some("chain")));
        assert_eq!(room_for(&cfg, &Signals { gpu_saturated: true, ..sig() }), (0, Some("hashing")));
        assert_eq!(room_for(&cfg, &Signals { cpu_load: Some(0.9), ..sig() }), (0, Some("hashing")));
        assert_eq!(room_for(&cfg, &Signals { hasher_pending: 100, ..sig() }), (1, Some("hashing")), "a deep backlog leaves one");
        assert_eq!(room_for(&cfg, &Signals { bridge_up: false, ..sig() }), (0, Some("bridge")));
        let capped = AutoReplicateConfig { ceiling: 103, ..cfg.clone() };
        assert_eq!(room_for(&capped, &sig()), (3, Some("ceiling")));
        assert_eq!(room_for(&capped, &Signals { replicants: 200, ..sig() }), (0, Some("ceiling")));
        // Energy tighter than the ceiling: energy is what is named.
        assert_eq!(room_for(&capped, &Signals { energy_room: Some(1), ..sig() }), (1, Some("energy")));
    }

    #[test]
    fn an_autonomous_round_may_take_anything_from_nothing_to_the_room() {
        let cfg = AutoReplicateConfig::default();
        assert!(cfg.random_rounds, "randomness is the default");
        assert_eq!(autonomous_target(&cfg, 5, 0.0), 0);
        assert_eq!(autonomous_target(&cfg, 5, 0.999), 5);
        assert_eq!(autonomous_target(&cfg, 5, 0.5), 3);
        assert_eq!(autonomous_target(&cfg, 0, 0.7), 0, "no room, no births, whatever the roll");
        // Uniform over 0..=room: six equal bins for a room of five.
        let mut seen = [0usize; 6];
        for i in 0..600 {
            seen[autonomous_target(&cfg, 5, i as f64 / 600.0)] += 1;
        }
        assert!(seen.iter().all(|n| *n == 100), "{seen:?}");
        let exact = AutoReplicateConfig { random_rounds: false, ..cfg.clone() };
        assert_eq!(autonomous_target(&exact, 5, 0.0), 5, "switched off, the round is the room");
        assert_eq!(autonomous_target(&cfg, 5, f64::NAN), 0, "a bad roll births nothing");
    }

    #[test]
    fn quota_converges_on_the_weights_and_never_picks_a_zero() {
        let w = vec![("productive".to_string(), 60.0), ("bait".to_string(), 25.0), ("raider".to_string(), 15.0), ("never".to_string(), 0.0)];
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut picks: Vec<String> = Vec::new();
        for _ in 0..100 {
            let id = quota_pick(&w, &counts).unwrap();
            *counts.entry(id.clone()).or_insert(0) += 1;
            picks.push(id);
        }
        assert_eq!(counts["productive"], 60);
        assert_eq!(counts["bait"], 25);
        assert_eq!(counts["raider"], 15);
        assert!(!counts.contains_key("never"));
        // The first pick on an empty roster is the heaviest snapshot.
        assert_eq!(picks[0], "productive");
        // An existing roster skewed to bait is corrected, not ignored.
        let mut skew: HashMap<String, usize> = HashMap::new();
        skew.insert("bait".into(), 50);
        assert_eq!(quota_pick(&w, &skew).unwrap(), "productive");
        assert_eq!(quota_pick(&[("x".to_string(), 0.0)], &HashMap::new()), None);
        assert_eq!(quota_pick(&[], &HashMap::new()), None);
    }

    #[test]
    fn a_snapshot_implies_the_legacy_role_its_capabilities_describe() {
        assert_eq!(role_for_snapshot(&crate::mcp::profile::find("raider")), VPlayerRole::Raider);
        assert_eq!(role_for_snapshot(&crate::mcp::profile::find("productive")), VPlayerRole::Productive);
        assert_eq!(role_for_snapshot(&crate::mcp::profile::find("bait")), VPlayerRole::Bait);
    }

    #[test]
    fn config_default_is_off_and_paced() {
        let c = AutoReplicateConfig::default();
        assert!(!c.enabled, "Autonomous Replication is OFF until the switch is thrown");
        assert_eq!(c.interval_secs, 300);
        assert_eq!(c.max_per_round, 5);
        assert_eq!(c.min_share_mw, crate::mcp::guild_power::MIN_PLAYER_DRAW_MW);
    }
}
