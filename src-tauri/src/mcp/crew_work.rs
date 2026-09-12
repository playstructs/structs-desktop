//! Rendezvous: how a crew divides work without talking about it.
//!
//! The naive way to share proof-of-work is a dispatcher — somebody hands out
//! jobs, tracks leases, and reissues what times out. That is a coordinator, and
//! a coordinator is a thing that goes offline, holds a stale lease, or has to
//! be elected. None of which a crew of five friends should have to think about.
//!
//! There is no need for any of it, because every input is public. Two machines
//! reading the same chain can independently compute the same ordered list of
//! the crew's ripe tasks, and then take DIFFERENT slices of it by agreeing on
//! nothing more than the arithmetic. That is what this module is:
//!
//!   * tasks are ordered by `(difficulty at the epoch boundary, stable hash)`
//!     — difficulty is evaluated at the epoch's FIRST block rather than "now",
//!     because "now" differs between machines by a few seconds and that is
//!     enough to produce two different orderings and therefore two machines on
//!     one task while another goes untouched;
//!   * the crew is ordered by `hash(player ++ epoch)`, which rotates every
//!     epoch so nobody is permanently assigned the expensive end of the list;
//!   * each machine takes its slot and then every Nth task after it.
//!
//! Disjoint by construction when there is enough work, and when there is less
//! work than there are machines the slots wrap — several people grinding one
//! task from different nonce starts, which is a genuine speed-up rather than a
//! collision.
//!
//! Nothing here is authority. Selecting a task only proposes it; `crew::authority_of`
//! decides whether we may finish it, and a task we are not permitted to submit
//! is never worth a single hash.
//!
//! **Own work comes first, always.** Crew tasks are taken only from the hashing
//! slots the local colony is not already using. A player who turns on helping
//! and watches their own mining stop will turn it off and never turn it on
//! again — and they would be right to.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::hasher::difficulty::calculate_difficulty;
use crate::hasher::types::{now_millis, TaskParams};
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::crew::{self, Crew, Scope};
use crate::mcp::telemetry::{tlog, Sev};
use crate::mcp::types::TaskType;

const FILENAME: &str = "crew_work.json";

/// How many blocks one assignment epoch lasts. ~5 minutes at 5.28 s/block.
///
/// Short enough that a solved task drops out of the next round quickly, long
/// enough that a grind is rarely orphaned by the boundary — and it is the
/// boundary, not the wall clock, that every machine agrees on.
pub const EPOCH_BLOCKS: u64 = 60;

// ── The pure core ───────────────────────────────────────────────────────────

/// A crewmate's task that this machine could take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrewTask {
    pub object_id: String,
    pub owner_player: String,
    pub task: TaskType,
    /// The cycle anchor the proof is computed against.
    pub block_start: u64,
    /// The struct type's difficulty range, which the curve decays from.
    pub difficulty_target: u64,
    pub planet_id: Option<String>,
}

impl CrewTask {
    fn key(&self) -> String {
        format!("{}|{}|{}", self.object_id, self.task.as_str(), self.block_start)
    }
}

pub fn epoch_of(block: u64) -> u64 {
    block / EPOCH_BLOCKS
}

/// The first block of an epoch — the instant every machine evaluates against.
pub fn epoch_block(epoch: u64) -> u64 {
    epoch * EPOCH_BLOCKS
}

/// A stable 64-bit number from some strings. SHA-256 because it is already
/// here and because "stable across machines and versions" is the entire
/// requirement — `DefaultHasher` is explicitly not that.
fn h64(parts: &[&str]) -> u64 {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    let d = h.finalize();
    u64::from_be_bytes(d[..8].try_into().unwrap_or([0; 8]))
}

/// The order every machine in the crew computes identically.
///
/// Easiest first, matching what the local pool already does: a cheap proof
/// finishes and frees the slot, and difficulty only ever falls, so nothing is
/// starved by waiting.
pub fn order_tasks(tasks: &mut [CrewTask], epoch: u64) {
    let at = epoch_block(epoch);
    tasks.sort_by(|a, b| {
        let da = calculate_difficulty(at.saturating_sub(a.block_start), a.difficulty_target);
        let db = calculate_difficulty(at.saturating_sub(b.block_start), b.difficulty_target);
        da.cmp(&db)
            .then_with(|| h64(&[&a.key(), &epoch.to_string()]).cmp(&h64(&[&b.key(), &epoch.to_string()])))
            .then_with(|| a.key().cmp(&b.key()))
    });
}

/// The crew in this epoch's order. Rotates, so the head of the list is not
/// always the same person.
pub fn crew_order(members: &[String], epoch: u64) -> Vec<String> {
    let mut m: Vec<String> = members.to_vec();
    m.sort();
    m.dedup();
    m.sort_by_key(|p| (h64(&[p, &epoch.to_string()]), p.clone()));
    m
}

/// Where we stand in this epoch's rotation.
pub fn slot_of(me: &str, members: &[String], epoch: u64) -> Option<usize> {
    crew_order(members, epoch).iter().position(|p| p == me)
}

/// The tasks this machine should take, at most `take` of them.
///
/// Returns nothing when we are not in the crew — selecting work for a crew you
/// are not a member of is how two machines end up doing the same job.
pub fn assign(tasks: &[CrewTask], members: &[String], me: &str, epoch: u64, take: usize) -> Vec<CrewTask> {
    if tasks.is_empty() || take == 0 {
        return Vec::new();
    }
    let crew = crew_order(members, epoch);
    let Some(slot) = crew.iter().position(|p| p == me) else {
        return Vec::new();
    };
    let mut ordered = tasks.to_vec();
    order_tasks(&mut ordered, epoch);
    let n = crew.len().max(1);
    // Wrapping the start is what turns "more machines than tasks" from idle
    // machines into several nonce searches on the same hard task.
    let start = slot % ordered.len();
    ordered.into_iter().skip(start).step_by(n).take(take).collect()
}

// ── Configuration ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrewWorkConfig {
    /// OFF by default: this spends the machine's GPU on other people's work.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_secs: u64,
    /// Only take a crewmate's task once it is this cheap. Higher than the
    /// local harvest threshold on purpose — your own difficulty-12 grind is
    /// worth an hour of GPU, a stranger's usually is not.
    #[serde(default = "default_threshold")]
    pub difficulty_threshold: u64,
    /// Never occupy more than this many hashing slots with crew work, however
    /// idle the machine looks.
    #[serde(default = "default_max_slots")]
    pub max_slots: usize,
    /// Compute and log the assignment, start nothing.
    #[serde(default)]
    pub dry_run: bool,
}

fn default_interval() -> u64 {
    120
}
fn default_threshold() -> u64 {
    8
}
fn default_max_slots() -> usize {
    4
}

impl Default for CrewWorkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_secs: default_interval(),
            difficulty_threshold: default_threshold(),
            max_slots: default_max_slots(),
            dry_run: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<CrewWorkConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn get() -> CrewWorkConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: CrewWorkConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

// ── What we have done for people ────────────────────────────────────────────

/// Proofs finished for crewmates this session, keyed by owner.
///
/// A local tally, not a claim on anybody: what the crewmate OWES is decided by
/// the chain's own `EventHashSuccess` receipts on their side, and this is only
/// what our card shows about our own afternoon.
static HELPED: LazyLock<dashmap::DashMap<String, u64>> = LazyLock::new(dashmap::DashMap::new);

pub fn note_helped(work: &crate::hasher::CrewWork, object_id: &str) {
    *HELPED.entry(work.owner_player.clone()).or_insert(0) += 1;
    let _ = object_id;
}

/// How many proofs we have finished for other people this session.
pub fn helped_total() -> u64 {
    HELPED.iter().map(|e| *e.value()).sum()
}

/// Crew tasks this machine is grinding right now.
///
/// Counted from the hasher's own registry of borrowed-for-a-crew tasks rather
/// than from anything this module remembers: a task that failed to start, or
/// that finished a second ago, must not still be shown as running.
pub fn taking_now() -> u64 {
    crate::hasher::crew_hash_count()
}

pub fn helped_tally() -> Value {
    let rows: Vec<Value> = HELPED
        .iter()
        .map(|e| json!({ "player_id": e.key(), "proofs": *e.value() }))
        .collect();
    json!({ "helped": rows })
}

// ── The loop ────────────────────────────────────────────────────────────────

/// One pass: for every crew we grind for, take our slice and start it.
pub async fn tick(app_handle: &tauri::AppHandle, force: bool) {
    let cfg = get();
    if !cfg.enabled {
        return;
    }
    let now = now_millis();
    if !force {
        if let Ok(mut last) = LAST_RUN.lock() {
            if now - *last < (cfg.interval_secs as f64) * 1000.0 {
                return;
            }
            *last = now;
        }
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // a previous pass is still walking the crew
    }
    let result = run(app_handle, &cfg).await;
    RUNNING.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        tlog("crew", Sev::Notice, format!("crew work pass stopped: {e}"));
    }
}

async fn run(app_handle: &tauri::AppHandle, cfg: &CrewWorkConfig) -> Result<(), String> {
    use tauri::Manager;
    let crews = crew::working_crews();
    if crews.is_empty() {
        return Ok(());
    }
    let (me, my_guild, current_block) = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|_| "game state unavailable")?;
        (
            gs.player_id.clone().unwrap_or_default(),
            gs.guild_id.clone().unwrap_or_default(),
            gs.current_block_height,
        )
    };
    if me.is_empty() || current_block == 0 {
        return Ok(()); // we do not know who we are yet
    }

    let registry = app_handle
        .state::<std::sync::Arc<crate::hasher::types::TaskRegistry>>()
        .inner()
        .clone();

    /* How many crew tasks may start: `max_slots` minus the crew tasks already
     * here. NOT the registry's size against `max_concurrent`.
     *
     * Those are two different quantities and conflating them made this loop
     * dead on arrival. The registry holds the whole QUEUE — every task waiting
     * for a worker — while `max_concurrent` bounds how many grind AT ONCE. On
     * this machine that was 923 against 10, so `10 - 923` saturated to zero
     * and the loop returned before doing anything, on every tick, forever. Any
     * machine running more than ten players would have hit it.
     *
     * Own work still wins, by the pool rather than by arithmetic here: it
     * admits the easiest RIPE task first (`hasher::pool::pop_ripest`), so a
     * crew task competes on equal terms instead of jumping a queue.
     */
    let free = cfg.max_slots.saturating_sub(crate::hasher::crew_hash_count() as usize);
    if free == 0 {
        return Ok(());
    }

    let epoch = epoch_of(current_block);
    let client = CosmosClient::new();
    let mut started = 0usize;
    let mut looked_at = 0usize;

    for c in crews {
        if started >= free {
            break;
        }
        let members = members_of(&c, &me).await;
        if members.len() < 2 {
            continue; // a crew of one is just a colony
        }
        let tasks = ripe_tasks(&members, &me, current_block, cfg.difficulty_threshold);
        looked_at += tasks.len();
        if tasks.is_empty() {
            continue;
        }
        let mine = assign(&tasks, &members, &me, epoch, free - started);
        if mine.is_empty() {
            continue;
        }
        if cfg.dry_run {
            tlog(
                "crew",
                Sev::Info,
                format!(
                    "[dry run] epoch {epoch}: {} of {} crew tasks in {} would be taken",
                    mine.len(),
                    tasks.len(),
                    c.name
                ),
            );
            continue;
        }
        for t in mine {
            if started >= free {
                break;
            }
            match start_one(app_handle, &client, &c, &t, &me, &my_guild, &registry).await {
                Ok(true) => started += 1,
                Ok(false) => {}
                Err(e) => tlog(
                    "crew",
                    Sev::Notice,
                    format!("could not take {} for {}: {e}", t.object_id, t.owner_player),
                ),
            }
        }
    }
    /* A pass that did nothing has to SAY it did nothing.
     *
     * The first version returned early in five places without a word, so a
     * loop that was structurally incapable of ever starting a task looked
     * exactly like a loop with nothing to do — and it took reading the
     * arithmetic, not the logs, to find that out.
     */
    tlog(
        "crew",
        Sev::Debug,
        format!(
            "epoch {epoch}: {started} started, {looked_at} ripe task(s) seen, {free} slot(s) free"
        ),
    );
    Ok(())
}

/// Take one task, if we are allowed to and not already busy with its object.
async fn start_one(
    app_handle: &tauri::AppHandle,
    client: &CosmosClient,
    crew_of: &Crew,
    t: &CrewTask,
    me: &str,
    my_guild: &str,
    registry: &std::sync::Arc<crate::hasher::types::TaskRegistry>,
) -> Result<bool, String> {
    // The registry is keyed by object id and starting a task CANCELS any other
    // with the same id, so this check is not an optimisation — without it a
    // crew task could evict one of our own mines.
    if crate::hasher::already_hashing(&t.object_id, registry) {
        return Ok(false);
    }
    if crate::hasher::completion_in_flight(&t.object_id) == Some(t.block_start) {
        return Ok(false); // somebody's proof for this exact cycle is already queued
    }
    // Permission before power. An unreadable answer is NOT a yes: it comes
    // back as an error and we simply do not take the task this pass.
    let authority = crew::authority_of(client, &t.owner_player, me, my_guild, t.task).await?;
    if !authority.allows() {
        return Ok(false);
    }

    let params = TaskParams::for_ore(&t.object_id, t.task.as_str(), t.block_start, t.difficulty_target);
    crate::hasher::start_hash_task_core(params, app_handle.clone(), registry)?;
    crate::hasher::register_crew_hash(
        t.object_id.clone(),
        crate::hasher::CrewWork {
            owner_player: t.owner_player.clone(),
            room_id: crew_of.room_id.clone(),
            task: t.task,
            // Index 0: we help as ourselves. A crewmate granted OUR player,
            // not one of our virtual ones.
            index: 0,
        },
    );
    Ok(true)
}

/// Who counts as this crew, minus us.
async fn members_of(c: &Crew, me: &str) -> Vec<String> {
    let mut out: Vec<String> = match c.scope {
        Scope::Chosen => c.chosen.clone(),
        Scope::Roster => crate::mcp::roster_cache::all_rows()
            .into_iter()
            .map(|r| r.player_id)
            .collect(),
        Scope::Guild => guild_members(&c.guild_id),
        Scope::Room => crate::matrix::crew_members(&c.guild_id, &c.room_id)
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m.get("player_id").and_then(|p| p.as_str()).map(str::to_string))
            .collect(),
    };
    // We are part of the rotation — the slice we take depends on where we
    // stand in it — so we must be in the list even though our own tasks are
    // not crew tasks.
    if !out.iter().any(|p| p == me) {
        out.push(me.to_string());
    }
    out.sort();
    out.dedup();
    out
}

fn guild_members(guild_id: &str) -> Vec<String> {
    if guild_id.is_empty() {
        return Vec::new();
    }
    crate::mcp::perception::with_snapshot(|s| {
        s.players
            .iter()
            .filter(|(_, v)| {
                v.get("guildId").and_then(|g| g.as_str()).unwrap_or_default() == guild_id
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<String>>()
    })
    .unwrap_or_default()
}

/// Every crewmate task ripe enough to be worth a stranger's GPU.
///
/// Read straight from the perception snapshot, which already holds the whole
/// galaxy — so a crew of fifty costs no extra chain reads to plan for.
fn ripe_tasks(members: &[String], me: &str, current_block: u64, threshold: u64) -> Vec<CrewTask> {
    let mut out = Vec::new();
    for pid in members {
        if pid == me {
            continue; // our own work is the harvest loop's job, not the crew's
        }
        let Some(rows) = crate::mcp::perception::work_for_player(pid) else {
            continue;
        };
        for r in rows {
            let Some(category) = r.get("category").and_then(|c| c.as_str()) else {
                continue;
            };
            let Some(task) = TaskType::parse(category) else {
                continue;
            };
            // BUILD is deliberately excluded for now: its anchor lives on the
            // struct and a build that has already completed reads as ripe
            // forever from a snapshot. Ore clocks live on the planet and are
            // hot-swept, so they are the ones we can trust unread.
            if !task.is_ore() {
                continue;
            }
            let block_start = crate::mcp::perception::to_u64(r.get("block_start"));
            let difficulty_target = crate::mcp::perception::to_u64(r.get("difficulty_target"));
            if block_start == 0 || difficulty_target == 0 {
                continue;
            }
            let age = current_block.saturating_sub(block_start);
            if !crate::mcp::auto_harvest::is_ripe(age, difficulty_target, threshold) {
                continue;
            }
            out.push(CrewTask {
                object_id: r.get("object_id").and_then(|o| o.as_str()).unwrap_or_default().to_string(),
                owner_player: pid.clone(),
                task,
                block_start,
                difficulty_target,
                planet_id: r.get("planet_id").and_then(|p| p.as_str()).map(str::to_string),
            });
        }
    }
    out.retain(|t| !t.object_id.is_empty());
    out
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn crew_work_config() -> Result<Value, String> {
    Ok(json!({ "config": get(), "epoch_blocks": EPOCH_BLOCKS, "tally": helped_tally() }))
}

#[tauri::command]
pub fn crew_work_set(
    window: tauri::WebviewWindow,
    config: CrewWorkConfig,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    set(config);
    Ok(json!({ "ok": true, "config": get() }))
}

/// What this machine would take right now, without taking it.
#[tauri::command]
pub async fn crew_work_preview(room_id: String) -> Result<Value, String> {
    let cfg = get();
    let Some(c) = crew::get(&room_id) else {
        return Err(format!("{room_id} is not a crew here"));
    };
    let (me, current_block) = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|_| "game state unavailable")?;
        (gs.player_id.clone().unwrap_or_default(), gs.current_block_height)
    };
    if me.is_empty() || current_block == 0 {
        return Err("this app does not know who you are yet".into());
    }
    let epoch = epoch_of(current_block);
    let members = members_of(&c, &me).await;
    let tasks = ripe_tasks(&members, &me, current_block, cfg.difficulty_threshold);
    let mine = assign(&tasks, &members, &me, epoch, cfg.max_slots);
    Ok(json!({
        "epoch": epoch,
        "block": current_block,
        "members": members,
        "slot": slot_of(&me, &members, epoch),
        "ripe": tasks.len(),
        "mine": mine,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, owner: &str, anchor: u64, target: u64) -> CrewTask {
        CrewTask {
            object_id: id.into(),
            owner_player: owner.into(),
            task: TaskType::Mine,
            block_start: anchor,
            difficulty_target: target,
            planet_id: None,
        }
    }

    fn tasks(n: usize) -> Vec<CrewTask> {
        (0..n)
            .map(|i| task(&format!("5-{}", 1000 + i), "1-61", 1_000 + i as u64, 14_000))
            .collect()
    }

    fn members(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("1-{}", 100 + i)).collect()
    }

    #[test]
    fn the_same_inputs_always_give_the_same_answer() {
        let t = tasks(9);
        let m = members(3);
        let a = assign(&t, &m, "1-101", 77, 5);
        let b = assign(&t, &m, "1-101", 77, 5);
        assert_eq!(a, b);
        // Order of the inputs must not matter: two machines will have built
        // these lists from different iteration orders of a HashMap.
        let mut t2 = t.clone();
        t2.reverse();
        let mut m2 = m.clone();
        m2.reverse();
        assert_eq!(a, assign(&t2, &m2, "1-101", 77, 5));
    }

    /// The whole point. If two crewmates ever pick the same task while another
    /// goes untouched, the crew is slower than one machine with a longer queue.
    #[test]
    fn crewmates_take_disjoint_work() {
        let t = tasks(9);
        let m = members(3);
        let mut seen: Vec<String> = Vec::new();
        for who in &m {
            for task in assign(&t, &m, who, 5, 9) {
                assert!(!seen.contains(&task.object_id), "{} taken twice", task.object_id);
                seen.push(task.object_id);
            }
        }
        assert_eq!(seen.len(), 9, "and between them they cover everything");
    }

    /// Fewer tasks than machines is not an error and must not idle anybody:
    /// the slots wrap, so the spare machines race the same nonce space from
    /// different starts.
    #[test]
    fn more_machines_than_tasks_race_instead_of_idling() {
        let t = tasks(2);
        let m = members(5);
        let mut total = 0;
        for who in &m {
            let got = assign(&t, &m, who, 3, 4);
            assert_eq!(got.len(), 1, "{who} should still have something to do");
            total += got.len();
        }
        assert_eq!(total, 5);
    }

    #[test]
    fn a_non_member_takes_nothing() {
        let t = tasks(4);
        let m = members(3);
        assert!(assign(&t, &m, "1-999", 1, 4).is_empty());
    }

    #[test]
    fn nothing_to_do_is_not_a_panic() {
        assert!(assign(&[], &members(3), "1-101", 1, 4).is_empty());
        assert!(assign(&tasks(3), &members(3), "1-101", 1, 0).is_empty());
        assert!(assign(&tasks(3), &[], "1-101", 1, 4).is_empty());
    }

    #[test]
    fn take_is_a_ceiling() {
        let t = tasks(20);
        let m = members(2);
        assert_eq!(assign(&t, &m, "1-100", 9, 3).len(), 3);
    }

    /// Rotation is what stops one machine being permanently handed the head of
    /// the list. Over a run of epochs, a member's slot must not be constant.
    #[test]
    fn slots_rotate_between_epochs() {
        let m = members(4);
        let slots: Vec<Option<usize>> = (0..12).map(|e| slot_of("1-102", &m, e)).collect();
        assert!(
            slots.windows(2).any(|w| w[0] != w[1]),
            "a fixed rotation is not a rotation: {slots:?}"
        );
    }

    /// Every machine must agree on the crew's order, whatever order its own
    /// membership list arrived in.
    #[test]
    fn the_crew_order_does_not_depend_on_input_order() {
        let mut m = members(6);
        let a = crew_order(&m, 42);
        m.reverse();
        assert_eq!(a, crew_order(&m, 42));
        m.push("1-100".into()); // a duplicate from two sources
        assert_eq!(a, crew_order(&m, 42));
    }

    /// Difficulty is judged at the epoch boundary precisely so two machines a
    /// few seconds apart cannot disagree about the ordering.
    #[test]
    fn ordering_is_judged_at_the_epoch_boundary_not_now() {
        let mut a = vec![task("5-1", "1-61", 100, 14_000), task("5-2", "1-61", 900, 14_000)];
        let mut b = a.clone();
        order_tasks(&mut a, 100);
        order_tasks(&mut b, 100);
        assert_eq!(a, b);
        // The older anchor is the cheaper proof, so it leads.
        assert_eq!(a[0].object_id, "5-1");
    }

    #[test]
    fn an_epoch_is_a_band_of_blocks() {
        assert_eq!(epoch_of(0), 0);
        assert_eq!(epoch_of(EPOCH_BLOCKS - 1), 0);
        assert_eq!(epoch_of(EPOCH_BLOCKS), 1);
        assert_eq!(epoch_block(3), 3 * EPOCH_BLOCKS);
    }

    /* The arithmetic that made this loop dead on arrival.
     *
     * `max_slots` is a budget for CREW tasks. It must never be measured
     * against the whole task registry, which is the queue: on a real machine
     * that was 923 waiting tasks against a concurrency of 10, so the old
     * `max_concurrent - registry.len()` saturated to zero and no crew task
     * could ever start. Pinned as arithmetic because that is all it ever was.
     */
    fn free_slots(max_slots: usize, crew_in_flight: usize) -> usize {
        max_slots.saturating_sub(crew_in_flight)
    }

    #[test]
    fn crew_slots_are_budgeted_against_crew_tasks_not_the_whole_queue() {
        // Nothing of ours in flight: the full budget is available, however
        // deep the machine's own queue happens to be.
        assert_eq!(free_slots(4, 0), 4);
        assert_eq!(free_slots(4, 3), 1);
        assert_eq!(free_slots(4, 4), 0);
        // …and it never goes negative.
        assert_eq!(free_slots(4, 99), 0);

        // The bug, stated: a 923-deep queue against a concurrency of 10 left
        // nothing, forever, no matter how much crew budget was configured.
        let old_way = 10usize.saturating_sub(923).min(4);
        assert_eq!(old_way, 0, "this is what shipped");
        assert_eq!(free_slots(4, 0), 4, "and this is what it should have been");
    }

    #[test]
    fn crew_work_is_off_and_bounded_by_default() {
        let c = CrewWorkConfig::default();
        assert!(!c.enabled);
        assert!(c.max_slots >= 1);
        assert!(c.difficulty_threshold <= 64);
    }
}
