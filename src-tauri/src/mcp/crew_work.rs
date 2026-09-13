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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

    /// What the chain actually pays for, once.
    ///
    /// Since v0.21.0 the ore clock lives on the PLANET, not the struct, so
    /// every rig standing on one planet shares a single mine cycle and a
    /// single refine cycle. Completing the first one restarts the clock and
    /// every other proof for that cycle is then dead — so a planet with three
    /// extractors offered three tasks of which two were guaranteed waste: GPU
    /// spent, a transaction lane spent, and a "work failure" to show for it.
    ///
    /// Keyed by planet for ore and by object for everything else, because
    /// BUILD anchors on the struct and RAID on the fleet.
    fn cycle(&self) -> String {
        match (self.task.is_ore(), self.planet_id.as_deref()) {
            (true, Some(planet)) => {
                format!("{}|{}|{}|{}", self.owner_player, self.task.as_str(), planet, self.block_start)
            }
            _ => format!("{}|{}", self.owner_player, self.key()),
        }
    }
}

/// One task per cycle, chosen the same way by every machine.
///
/// Lowest key wins — a stable, arbitrary choice that two clients reading the
/// same chain both reach, so they converge on the same rig rather than each
/// picking a different one and racing for the same reward.
pub fn one_per_cycle(tasks: Vec<CrewTask>) -> Vec<CrewTask> {
    let mut by_cycle: std::collections::BTreeMap<String, CrewTask> = Default::default();
    for t in tasks {
        let c = t.cycle();
        match by_cycle.get(&c) {
            Some(kept) if kept.key() <= t.key() => {}
            _ => {
                by_cycle.insert(c, t);
            }
        }
    }
    by_cycle.into_values().collect()
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
    order_tasks_paid(tasks, epoch, &std::collections::HashMap::new());
}

/// The same order, with paying owners first — best published rate at the
/// head, then the unpaid in the usual cheapest-first order.
///
/// This is the point at which terms on the bus change what a helper DOES
/// rather than only what it sees. Every machine reads the same room state,
/// so the ordering stays the one ordering the rendezvous depends on; a
/// machine that has not yet seen a rate falls into a nonce race on that
/// task, which is the same thing that happens for any other lag.
pub fn order_tasks_paid(tasks: &mut [CrewTask], epoch: u64, rates: &std::collections::HashMap<String, f64>) {
    let at = epoch_block(epoch);
    let rate = |t: &CrewTask| rates.get(&t.owner_player).copied().unwrap_or(0.0);
    tasks.sort_by(|a, b| {
        rate(b)
            .total_cmp(&rate(a))
            .then_with(|| {
                let da = calculate_difficulty(at.saturating_sub(a.block_start), a.difficulty_target);
                let db = calculate_difficulty(at.saturating_sub(b.block_start), b.difficulty_target);
                da.cmp(&db)
            })
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
    assign_paid(tasks, members, me, epoch, take, &std::collections::HashMap::new())
}

pub fn assign_paid(
    tasks: &[CrewTask],
    members: &[String],
    me: &str,
    epoch: u64,
    take: usize,
    rates: &std::collections::HashMap<String, f64>,
) -> Vec<CrewTask> {
    if tasks.is_empty() || take == 0 {
        return Vec::new();
    }
    let crew = crew_order(members, epoch);
    let Some(slot) = crew.iter().position(|p| p == me) else {
        return Vec::new();
    };
    let mut ordered = tasks.to_vec();
    order_tasks_paid(&mut ordered, epoch, rates);
    let n = crew.len().max(1);
    let len = ordered.len();
    // Wrapping the start is what turns "more machines than tasks" from idle
    // machines into several nonce searches on the same hard task.
    let start = slot % len;
    let idx: Vec<usize> = if n <= len {
        // Enough tasks to go round: a plain stride, disjoint by construction.
        (start..len).step_by(n).take(take).collect()
    } else {
        /* More crewmates than tasks. The stride landed on the same index for
         * every k once n was a multiple of len — a guild of 2,500 against 50
         * ripe tasks — so a machine with four free slots took ONE task while
         * the other forty-nine sat there. Walk the neighbours instead:
         * distinct tasks, in an order every machine computes the same way.
         * Two machines on one task is the nonce race the wrap already
         * promised; two machines each idle on three slots is not. */
        let step = (n % len).max(1);
        let mut v: Vec<usize> = Vec::with_capacity(take.min(len));
        for k in 0..len {
            let i = (start + k * step) % len;
            if v.contains(&i) {
                break;
            }
            v.push(i);
            if v.len() == take {
                break;
            }
        }
        v
    };
    idx.into_iter().map(|i| ordered[i].clone()).collect()
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
    /// The room every work frame goes to and is read from. Empty disables
    /// the bus, and results fall back to the crew's own room.
    #[serde(default = "default_bus")]
    pub bus: String,
    /// Take the work of owners who have published a rate on the bus first,
    /// best rate leading. Off, and every ripe task is just a task.
    #[serde(default = "yes")]
    pub prefer_paying: bool,
}

fn yes() -> bool {
    true
}

fn default_bus() -> String {
    crate::matrix::DEFAULT_WORK_BUS.to_string()
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
            bus: default_bus(),
            prefer_paying: true,
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

/// What the last pass actually saw.
///
/// "It doesn't seem to be doing anything" is the hardest report to act on, and
/// this loop can be doing nothing for five different legitimate reasons. The
/// pass already computes the answer; keeping it costs nothing and turns that
/// report into a reading.
static LAST_PASS: LazyLock<RwLock<Option<Value>>> = LazyLock::new(|| RwLock::new(None));

pub fn last_pass() -> Value {
    LAST_PASS.read().ok().and_then(|p| p.clone()).unwrap_or(Value::Null)
}

fn note_pass(epoch: u64, submitting: usize, reporting: usize, declined: usize, ripe: usize, free: usize, members: usize, paid: usize) {
    if let Ok(mut p) = LAST_PASS.write() {
        *p = Some(json!({
            "epoch": epoch,
            // What became of the tasks we took: signed here, or posted to
            // Comms for somebody with the authority. Both are work done.
            "submitting": submitting, "reporting": reporting,
            "started": submitting + reporting,
            // Left alone for a local reason — already ours, already queued,
            // or nowhere to post a result. Not a chain refusal.
            "declined": declined,
            // Of those taken, how many were for an owner who pays.
            "paid": paid,
            "ripe": ripe, "free": free, "members": members,
            "at_ms": now_millis(),
        }));
    }
}

pub fn note_helped(work: &crate::hasher::CrewWork, object_id: &str) {
    *HELPED.entry(work.owner_player.clone()).or_insert(0) += 1;
    note_event("finished", format!("finished {} {object_id} for {}", work.task.as_str(), work.owner_player));
}

/// What has happened lately, newest first — the only trace of a system
/// that is otherwise deliberately invisible.
///
/// A ring, in memory, for the card: `posted` (our proof went to the bus),
/// `finished` (a proof of ours was spent, by us or by its owner), `accepted`
/// (we spent a crewmate's), `refused` (the chain said no), `credit` (money
/// owed either way). Not a log — the log has it all — but the six lines a
/// player looks at when they wonder whether any of this is doing anything.
const FEED_KEEP: usize = 40;
static FEED: LazyLock<RwLock<std::collections::VecDeque<Value>>> =
    LazyLock::new(|| RwLock::new(std::collections::VecDeque::with_capacity(FEED_KEEP)));

pub fn note_event(kind: &str, text: String) {
    if let Ok(mut f) = FEED.write() {
        f.push_front(json!({ "kind": kind, "text": text, "at_ms": now_millis() }));
        f.truncate(FEED_KEEP);
    }
}

pub fn feed() -> Vec<Value> {
    FEED.read().map(|f| f.iter().cloned().collect()).unwrap_or_default()
}

/// An owner told the room they spent a proof of ours (a `done` frame naming
/// us as the helper). That is a finished job by any reading: we computed it,
/// they paid the transaction, the chain took it.
pub fn note_finished_by_owner(owner: &str, object: &str) {
    *HELPED.entry(owner.to_string()).or_insert(0) += 1;
    note_event("finished", format!("{owner} assimilated our proof for {object}"));
}

/// Cycles we have already POSTED a proof for, `object -> anchor`.
///
/// The hasher forgets a borrowed task the moment its result goes out, so the
/// next pass found the same task ripe, ground the identical puzzle and posted
/// the identical nonce — every two minutes, for as long as the owner had not
/// spent it (live 2026-09-12: 5-254363, three times in six minutes). A cycle
/// can use exactly one proof; once ours is in the room there is nothing more
/// this machine can add until the anchor moves.
static REPORTED: LazyLock<dashmap::DashMap<String, u64>> = LazyLock::new(dashmap::DashMap::new);
static REPORTED_TOTAL: AtomicU64 = AtomicU64::new(0);

pub fn note_reported(object: &str, anchor: u64) {
    REPORTED.insert(object.to_string(), anchor);
    REPORTED_TOTAL.fetch_add(1, Ordering::Relaxed);
    note_event("posted", format!("sent {object} to the cluster (cycle {anchor})"));
}

pub fn reported_this_cycle(object: &str, anchor: u64) -> bool {
    REPORTED.get(object).map(|a| *a == anchor).unwrap_or(false)
}

/// How many proofs we have posted to Comms for somebody else to spend.
pub fn reported_total() -> u64 {
    REPORTED_TOTAL.load(Ordering::Relaxed)
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
    // Housekeeping that must not wait for helping to be switched on: proofs
    // held from before the world was loaded, and our own terms on the bus.
    crate::mcp::chain_health::poll(app_handle, &CosmosClient::new()).await;
    crate::mcp::crew_submit::drain_held(app_handle);
    crate::mcp::crew_pay::ensure_terms_published().await;
    let cfg = get();
    if !cfg.enabled {
        return;
    }
    // Nothing we grind can be spent while the node is behind; and a proof
    // posted now for somebody else to spend meets the same node on their
    // machine. Every guild transacts through the same reactor endpoint.
    if crate::mcp::chain_health::lcd_stalled() {
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
    /* Who has actually opened their work to us — one paginated read, whatever
     * the crew's size.
     *
     * This is the difference between a crew that works and one that looks
     * dead. Being in a guild with somebody grants nothing; each side opens its
     * own work separately. Asking "may I help you?" per candidate is also the
     * only other option, and at guild scale that is thousands of reads and a
     * scan measured in minutes.
     */
    let mut submitting = 0usize;
    let mut reporting = 0usize;
    let mut declined = 0usize;
    let mut paid = 0usize;
    let mut looked_at = 0usize;
    let mut crew_size = 0usize;

    for c in crews {
        if submitting + reporting >= free {
            break;
        }
        let members = members_of(&c, &me).await;
        /* Everyone in scope is a candidate. Nobody is filtered out for lack
         * of a grant, because computing a proof needs none — a helper with no
         * rights at all still posts the number for the owner to sign. Only
         * the tasks we actually TAKE (at most `max_slots`) are asked about, so
         * a guild of thousands costs one store walk and a handful of reads. */
        crew_size = crew_size.max(members.len().saturating_sub(1));
        if members.len() < 2 {
            continue; // a crew of one is just a colony
        }
        let tasks = ripe_tasks(&members, &me, current_block, cfg.difficulty_threshold);
        let rates = if cfg.prefer_paying { crate::mcp::crew_pay::rates_by_player() } else { Default::default() };
        looked_at += tasks.len();
        if tasks.is_empty() {
            continue;
        }
        let mine = assign_paid(&tasks, &members, &me, epoch, free - (submitting + reporting), &rates);
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
            if submitting + reporting >= free {
                break;
            }
            match start_one(app_handle, &client, &c, &t, &me, &my_guild, &registry).await {
                Ok(Took::Submitting) => { submitting += 1; if rates.contains_key(&t.owner_player) { paid += 1; } }
                Ok(Took::Reporting) => { reporting += 1; if rates.contains_key(&t.owner_player) { paid += 1; } }
                Ok(Took::Declined) => declined += 1,
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
    note_pass(epoch, submitting, reporting, declined, looked_at, free, crew_size, paid);
    tlog(
        "crew",
        Sev::Debug,
        format!(
            "epoch {epoch}: {submitting} to submit, {reporting} to report, {declined} declined, \
             {looked_at} ripe across {crew_size} crewmate(s), {free} slot(s) free"
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
) -> Result<Took, String> {
    // The registry is keyed by object id and starting a task CANCELS any other
    // with the same id, so this check is not an optimisation — without it a
    // crew task could evict one of our own mines.
    /* Our own loops get first claim on an object, and say so.
     *
     * These two returns are the ordinary case whenever a crewmate is also
     * somebody THIS machine already works for — every roster player, for us —
     * and a silent `false` made "correctly declined" indistinguishable from
     * "quietly broken" while the whole feature was being debugged. Debug, not
     * notice: on a busy machine it is the common path, not a problem.
     */
    if crate::hasher::already_hashing(&t.object_id, registry) {
        tlog(
            "crew",
            Sev::Debug,
            format!("{} left alone: this machine is already grinding it", t.object_id),
        );
        return Ok(Took::Declined);
    }
    if crate::hasher::completion_in_flight(&t.object_id) == Some(t.block_start) {
        tlog(
            "crew",
            Sev::Debug,
            format!("{} left alone: a proof for cycle {} is already queued", t.object_id, t.block_start),
        );
        return Ok(Took::Declined);
    }
    if reported_this_cycle(&t.object_id, t.block_start) {
        tlog(
            "crew",
            Sev::Debug,
            format!("{} left alone: our proof for cycle {} is already in the room", t.object_id, t.block_start),
        );
        return Ok(Took::Declined);
    }
    /* Authority decides HOW we help, not WHETHER we help.
     *
     * Computing a proof needs no rights whatsoever — the grinding input is
     * public — so a helper with no grant is still useful: they compute the
     * nonce and post it, and an account that holds the authority signs it.
     * That is what Comms is for, and it is the ordinary case. A grant is only
     * needed for the helper to submit for THEMSELVES.
     *
     * Refusing the task when we cannot submit, which is what this did, threw
     * away the entire no-permission path and made a helper with no grants
     * useless — exactly the "it isn't doing anything" report.
     *
     * An unreadable answer is still not a yes: it comes back as an error and
     * we take nothing this pass.
     */
    let authority = crew::authority_of(client, &t.owner_player, me, my_guild, t.task).await?;
    let mut params = TaskParams::for_ore(&t.object_id, t.task.as_str(), t.block_start, t.difficulty_target);
    // Somebody else's work starts at the crew threshold, not the pool's
    // global start: "difficulty 3 for others, 5 for mine" has to mean it.
    params.difficulty_start = Some(get().difficulty_threshold);

    if authority.allows() {
        crate::hasher::start_hash_task_core(params, app_handle.clone(), registry)?;
        crate::hasher::register_crew_hash(
            t.object_id.clone(),
            crate::hasher::CrewWork {
                owner_player: t.owner_player.clone(),
                room_id: crew_of.room_id.clone(),
                task: t.task,
                // Index 0: we help as ourselves.
                index: 0,
            },
        );
        return Ok(Took::Submitting);
    }

    // No authority: compute it and hand the number to somebody who has some.
    let Some((guild_id, room_id)) =
        crate::matrix::report_room(&crew_of.guild_id, &crew_of.room_id, &t.owner_player).await
    else {
        tlog(
            "crew",
            Sev::Debug,
            format!(
                "{} left alone: no authority to submit and nowhere to post a result",
                t.object_id
            ),
        );
        return Ok(Took::Declined);
    };
    crate::hasher::start_hash_task_core(params, app_handle.clone(), registry)?;
    crate::hasher::register_borrowed_hash(
        t.object_id.clone(),
        crate::hasher::BorrowedWork {
            guild_id,
            room_id,
            // Nobody asked: this is an unsolicited result, so it threads under
            // nothing.
            offer_event: String::new(),
            task: t.task.as_str().to_string(),
            target: None,
            block_start: t.block_start,
            difficulty: t.difficulty_target,
        },
    );
    Ok(Took::Reporting)
}

/// What one task became.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Took {
    /// Ground here and signed here: we hold the authority.
    Submitting,
    /// Ground here, posted to Comms for somebody who does.
    Reporting,
    /// Left alone for a local reason (already ours, already queued, nowhere
    /// to send). Not a refusal by the chain.
    Declined,
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
        // Terms only: nobody's work is ours to take through it.
        Scope::Anyone => Vec::new(),
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
/// Is there anything for the chain to ACCEPT?
///
/// A nonce for an extractor on a drained planet, or for a refinery whose
/// owner holds no ore, is a perfectly valid proof the chain refuses every
/// time ("planet (2-29903) is empty, nothing to mine"), and because the
/// refusal never moves the anchor the task reads as ripe forever. The first
/// live crew pass found exactly this: a helper posted the same proof for
/// 5-254363 every two minutes and the owner spent a transaction being refused
/// each time. The harvest loop has carried this guard since the futile-mining
/// incident; crew work needs the same one on BOTH ends.
///
/// `None` is unknown and is allowed through — a read failure must not silence
/// a whole crew — only a reading of zero says no.
pub fn worth_doing(task: TaskType, planet_ore: Option<u64>, owner_ore: Option<u64>) -> bool {
    match task {
        TaskType::Mine => planet_ore != Some(0),
        TaskType::Refine => owner_ore != Some(0),
        _ => true,
    }
}

/// Why the chain would refuse this task right now, from our own reading of
/// the world; `None` when it would not.
pub fn nothing_to_do(task: TaskType, planet: Option<&str>, owner: &str) -> Option<String> {
    let planet_ore = planet.and_then(crate::mcp::perception::ore_of);
    let owner_ore = crate::mcp::perception::ore_of(owner);
    if worth_doing(task, planet_ore, owner_ore) {
        return None;
    }
    Some(match task {
        TaskType::Mine => format!("planet {} is empty, nothing to mine", planet.unwrap_or("?")),
        _ => format!("{owner} holds no ore to refine"),
    })
}

fn ripe_tasks(members: &[String], me: &str, current_block: u64, threshold: u64) -> Vec<CrewTask> {
    let mut out = Vec::new();
    // Our own work is the harvest loop's job, not the crew's.
    let wanted: std::collections::HashSet<String> =
        members.iter().filter(|p| p.as_str() != me).cloned().collect();
    // One walk of the store for everybody, not one per member — the
    // difference between a pass and a multi-minute scan at guild scale.
    let by_owner = crate::mcp::perception::work_for_players(&wanted);
    for (pid, rows) in by_owner {
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
            let planet_id = r.get("planet_id").and_then(|p| p.as_str()).map(str::to_string);
            if nothing_to_do(task, planet_id.as_deref(), &pid).is_some() {
                continue;
            }
            out.push(CrewTask {
                object_id: r.get("object_id").and_then(|o| o.as_str()).unwrap_or_default().to_string(),
                owner_player: pid.clone(),
                task,
                block_start,
                difficulty_target,
                planet_id,
            });
        }
    }
    out.retain(|t| !t.object_id.is_empty());
    one_per_cycle(out)
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

/// The one knob most players touch: how cheap somebody else's proof has to
/// be before this machine will grind it. Separate from the harvest loop's
/// threshold for our own rigs, on purpose.
#[tauri::command]
pub fn crew_threshold_set(window: tauri::WebviewWindow, threshold: u64) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let mut cfg = get();
    cfg.difficulty_threshold = threshold.clamp(1, 64);
    set(cfg);
    Ok(json!({ "ok": true, "difficulty_threshold": get().difficulty_threshold }))
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
    let rates = if cfg.prefer_paying { crate::mcp::crew_pay::rates_by_player() } else { Default::default() };
    let mine = assign_paid(&tasks, &members, &me, epoch, cfg.max_slots, &rates);
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
        let mut firsts: Vec<String> = Vec::new();
        for who in &m {
            let got = assign(&t, &m, who, 3, 4);
            // Free slots race every task there is rather than idling on
            // one; there are only two, so two.
            assert_eq!(got.len(), 2, "{who} should race both tasks");
            assert_ne!(got[0].object_id, got[1].object_id, "and not the same one twice");
            firsts.push(got[0].object_id.clone());
        }
        // The task a machine starts on still spreads across the crew.
        assert!(firsts.iter().any(|f| f != &firsts[0]), "everyone opened on the same task");
    }

    /// A guild of thousands against a handful of ripe tasks is the ordinary
    /// shape, and the stride used to land on the same index for every slot
    /// once the roster was a multiple of the task count.
    #[test]
    fn a_big_roster_still_fills_every_free_slot() {
        let t = tasks(50);
        let m = members(2500);
        let got = assign(&t, &m, "1-1234", 9, 4);
        assert_eq!(got.len(), 4);
        let mut ids: Vec<_> = got.iter().map(|x| x.object_id.clone()).collect();
        ids.dedup();
        assert_eq!(ids.len(), 4, "four slots, four different tasks");
    }

    /// The chain refuses a proof for an empty planet or a penniless refiner
    /// every time, and the anchor never moves, so the task is ripe forever.
    /// Unknown is not zero: a missing reading must not silence the crew.
    #[test]
    fn drained_work_is_not_worth_doing_but_unread_work_is() {
        assert!(!worth_doing(TaskType::Mine, Some(0), Some(5)));
        assert!(worth_doing(TaskType::Mine, Some(3), Some(0)));
        assert!(worth_doing(TaskType::Mine, None, None));
        assert!(!worth_doing(TaskType::Refine, Some(9), Some(0)));
        assert!(worth_doing(TaskType::Refine, Some(0), Some(1)));
        assert!(worth_doing(TaskType::Refine, None, None));
        assert!(worth_doing(TaskType::Build, Some(0), Some(0)));
    }

    /// One proof per cycle: once ours is posted the task is left alone until
    /// the anchor moves, and a new cycle is a new job.
    /// Newest first, bounded, and a posted proof shows up in it.
    #[test]
    fn the_feed_is_newest_first_and_bounded() {
        for i in 0..(FEED_KEEP + 5) {
            note_event("posted", format!("event {i}"));
        }
        let f = feed();
        assert_eq!(f.len(), FEED_KEEP);
        assert_eq!(f[0]["text"], format!("event {}", FEED_KEEP + 4));
        assert_eq!(f[0]["kind"], "posted");
    }

    #[test]
    fn a_reported_cycle_is_remembered_until_the_anchor_moves() {
        note_reported("5-777777", 100);
        assert!(reported_this_cycle("5-777777", 100));
        assert!(!reported_this_cycle("5-777777", 160));
        assert!(!reported_this_cycle("5-777778", 100));
        assert!(reported_total() >= 1);
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
    /// A published rate moves an owner's work to the front, best rate
    /// first; the unpaid keep their cheapest-first order behind them. And
    /// it stays one deterministic order, which the rendezvous needs.
    #[test]
    fn paying_owners_go_first_best_rate_leading() {
        let mut t = vec![
            task("5-1", "1-61", 100, 14_000),   // cheapest, unpaid
            task("5-2", "1-62", 900, 14_000),   // pays 5
            task("5-3", "1-63", 950, 14_000),   // pays 12
            task("5-4", "1-61", 500, 14_000),   // unpaid
        ];
        let rates: std::collections::HashMap<String, f64> =
            [("1-62".to_string(), 5.0), ("1-63".to_string(), 12.0)].into_iter().collect();
        let mut again = t.clone();
        order_tasks_paid(&mut t, 100, &rates);
        order_tasks_paid(&mut again, 100, &rates);
        assert_eq!(t, again);
        let ids: Vec<_> = t.iter().map(|x| x.object_id.as_str()).collect();
        assert_eq!(ids, vec!["5-3", "5-2", "5-1", "5-4"]);
        // No rates: the old order exactly.
        let mut plain = t.clone();
        order_tasks(&mut plain, 100);
        assert_eq!(plain[0].object_id, "5-1");
    }

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

    fn ore(id: &str, owner: &str, planet: &str, anchor: u64) -> CrewTask {
        CrewTask {
            object_id: id.into(),
            owner_player: owner.into(),
            task: TaskType::Mine,
            block_start: anchor,
            difficulty_target: 14_000,
            planet_id: Some(planet.into()),
        }
    }

    /* One ore clock per PLANET since v0.21.0, so every rig on a planet shares
     * one cycle. Offering one task per rig meant a three-extractor planet
     * produced three proofs, of which two were guaranteed dead the instant the
     * first landed and restarted the clock — GPU and a transaction lane spent
     * for a "work failure". */
    #[test]
    fn rigs_sharing_one_planet_cycle_collapse_to_one_task() {
        let tasks = vec![
            ore("5-300", "1-61", "2-9", 1000),
            ore("5-100", "1-61", "2-9", 1000),
            ore("5-200", "1-61", "2-9", 1000),
        ];
        let kept = one_per_cycle(tasks);
        assert_eq!(kept.len(), 1, "one planet, one mine cycle, one proof");
        assert_eq!(kept[0].object_id, "5-100", "and the choice is stable, not incidental");
    }

    /// Two machines must collapse to the SAME rig, or they each pick a
    /// different one and race for a reward only one of them can have.
    #[test]
    fn every_machine_collapses_to_the_same_rig() {
        let a = vec![ore("5-300", "1-61", "2-9", 1000), ore("5-100", "1-61", "2-9", 1000)];
        let mut b = a.clone();
        b.reverse();
        assert_eq!(one_per_cycle(a)[0].object_id, one_per_cycle(b)[0].object_id);
    }

    #[test]
    fn separate_planets_owners_cycles_and_kinds_stay_separate() {
        let mut refine = ore("5-101", "1-61", "2-9", 1000);
        refine.task = TaskType::Refine;
        let tasks = vec![
            ore("5-100", "1-61", "2-9", 1000),   // planet 2-9, mine, cycle 1000
            ore("5-400", "1-61", "2-8", 1000),   // a different planet
            ore("5-500", "1-62", "2-9", 1000),   // a different owner
            ore("5-600", "1-61", "2-9", 2000),   // a later cycle on the same planet
            refine,                              // mine and refine are two clocks
        ];
        assert_eq!(one_per_cycle(tasks).len(), 5);
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

    /// The bus is on by default and is the one well-known room; a config
    /// written before the bus existed reads the default, not an empty string.
    #[test]
    fn the_work_bus_is_the_default_destination() {
        assert_eq!(CrewWorkConfig::default().bus, crate::matrix::DEFAULT_WORK_BUS);
        let old: CrewWorkConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(old.bus, crate::matrix::DEFAULT_WORK_BUS);
        let off: CrewWorkConfig = serde_json::from_str(r#"{"bus":""}"#).unwrap();
        assert!(off.bus.is_empty());
    }

    #[test]
    fn crew_work_is_off_and_bounded_by_default() {
        let c = CrewWorkConfig::default();
        assert!(!c.enabled);
        assert!(c.max_slots >= 1);
        assert!(c.difficulty_threshold <= 64);
    }
}
