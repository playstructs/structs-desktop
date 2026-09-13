//! Finishing work somebody else computed, without a person in the loop.
//!
//! A helper needs no rights to compute a proof, so the ordinary shape of
//! shared work is: they grind, they post the number, and whoever holds the
//! authority signs it. That last step used to be a button per message, which
//! is not automation — a crew that needs a click per result is a crew that
//! stops the moment nobody is watching.
//!
//! This is that step, unattended. Everything here exists because the input is
//! a number written by a stranger on a federated homeserver:
//!
//!   * **The difficulty is read HERE, never taken from the message.** A proof
//!     is "valid" only against a difficulty, so a hostile `difficulty: 0`
//!     makes any nonce verify and we would sign rubbish. Ours, or we refuse.
//!   * **The owner is read from the chain**, and we submit only for accounts
//!     we can actually sign for. A stranger therefore cannot aim us at
//!     somebody else's object; the worst they can do is hand us a real proof
//!     for our OWN work, which is a gift.
//!   * **The anchor is re-checked at the gate**, because a nonce is valid only
//!     against the cycle it was ground for and this one has crossed a network.
//!   * **One submission per cycle**, so a room full of duplicate answers costs
//!     one transaction, not twenty.
//!   * **A ceiling per hour**, because a transaction lane is the scarce
//!     resource and a flood of plausible results would otherwise spend it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::telemetry::{tlog, Sev};
use crate::mcp::types::TaskType;

const FILENAME: &str = "crew_submit.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrewSubmitConfig {
    /// ON. A result nobody signs is a helper's wasted electricity, and the
    /// whole point of sharing work is that it completes without supervision.
    /// The safety here is in WHAT is accepted, not in refusing to act.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Transactions this may spend in an hour. The lane is the scarce
    /// resource — one in flight per address — so a room that suddenly
    /// produces hundreds of results must not drain it.
    ///
    /// 240, not 60: the first live helper produced ~115 good proofs an hour
    /// and the old ceiling threw away 51 of them in two hours, each one a
    /// completion the chain would have taken. Every vplayer signs on its own
    /// address, so four a minute is nowhere near the lane; it is a ceiling
    /// against a flood, not a budget.
    #[serde(default = "default_hourly")]
    pub max_per_hour: usize,
}

fn yes() -> bool {
    true
}
fn default_hourly() -> usize {
    240
}

impl Default for CrewSubmitConfig {
    fn default() -> Self {
        Self { enabled: yes(), max_per_hour: default_hourly() }
    }
}

static CONFIG: LazyLock<RwLock<CrewSubmitConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));

pub fn get() -> CrewSubmitConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: CrewSubmitConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

/// Cycles already accepted, as `object|anchor -> when`.
///
/// Two helpers answering the same task is the DESIGN — they grind the same
/// cycle from different nonce starts — so duplicate results are the expected
/// case, not an attack. Exactly one of them may become a transaction.
static ACCEPTED: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Timestamps of the transactions this has spent, for the hourly ceiling.
static SPENT: LazyLock<Mutex<Vec<f64>>> = LazyLock::new(|| Mutex::new(Vec::new()));

// ── What the bus has been doing ─────────────────────────────────────────────
//
// Counters for the card. The loop is silent and the room is hidden, so this
// is how a player learns that proofs are arriving and whether they are being
// spent — and, when they are not, that the ceiling is why. Found necessary
// the first live afternoon: 51 refusals sat at debug level while the card
// said nothing.
use std::sync::atomic::{AtomicU64, Ordering};
static ACCEPTED_TOTAL: AtomicU64 = AtomicU64::new(0);
static REFUSED_CEILING: AtomicU64 = AtomicU64::new(0);
static REFUSED_OTHER: AtomicU64 = AtomicU64::new(0);
static LAST_FRAME_MS: AtomicU64 = AtomicU64::new(0);

fn note_frame() {
    LAST_FRAME_MS.store(now_millis() as u64, Ordering::Relaxed);
}

pub fn note_outcome(outcome: &Result<Option<String>, String>) {
    match outcome {
        Ok(Some(_)) => ACCEPTED_TOTAL.fetch_add(1, Ordering::Relaxed),
        Ok(None) => 0,
        Err(e) if e.contains("hourly ceiling") => REFUSED_CEILING.fetch_add(1, Ordering::Relaxed),
        Err(_) => REFUSED_OTHER.fetch_add(1, Ordering::Relaxed),
    };
}

/// The bus, as numbers: when a result last arrived, how much of the hour's
/// ceiling is spent, and what was refused.
pub fn stats() -> Value {
    json!({
        "signed_this_hour": spent_this_hour(),
        "ceiling": get().max_per_hour,
        "accepted_total": ACCEPTED_TOTAL.load(Ordering::Relaxed),
        "refused_ceiling": REFUSED_CEILING.load(Ordering::Relaxed),
        "refused_other": REFUSED_OTHER.load(Ordering::Relaxed),
        "last_frame_ms": LAST_FRAME_MS.load(Ordering::Relaxed),
        "node_lag": crate::mcp::chain_health::lcd_lag(),
        "node_stalled": crate::mcp::chain_health::lcd_stalled(),
    })
}

const CYCLE_MEMORY_MS: f64 = 6.0 * 3_600_000.0;

/// Claim a cycle, or report that somebody already has it.
fn claim(object: &str, anchor: u64) -> bool {
    let key = format!("{object}|{anchor}");
    let now = now_millis();
    let Ok(mut m) = ACCEPTED.lock() else { return false };
    m.retain(|_, at| now - *at < CYCLE_MEMORY_MS);
    if m.contains_key(&key) {
        return false;
    }
    m.insert(key, now);
    true
}

fn release(object: &str, anchor: u64) {
    if let Ok(mut m) = ACCEPTED.lock() {
        m.remove(&format!("{object}|{anchor}"));
    }
}

/// Is there room under the hourly ceiling? Records the spend if so.
pub fn take_budget(max_per_hour: usize) -> bool {
    let now = now_millis();
    let Ok(mut v) = SPENT.lock() else { return false };
    v.retain(|at| now - *at < 3_600_000.0);
    if v.len() >= max_per_hour {
        return false;
    }
    v.push(now);
    true
}

/// How many transactions this has spent in the last hour.
pub fn spent_this_hour() -> usize {
    let now = now_millis();
    SPENT
        .lock()
        .map(|v| v.iter().filter(|at| now - **at < 3_600_000.0).count())
        .unwrap_or(0)
}

// ── Who may sign ────────────────────────────────────────────────────────────

/// The identity that will submit, as an HD index.
///
/// Only accounts whose key this machine HOLDS, plus the primary when it has
/// been granted rights on the owner. That is the whole defence against being
/// aimed at a stranger's object: we simply cannot sign for one.
#[derive(Debug, Clone, PartialEq)]
pub enum Signer {
    /// The owner is us, or one of ours, and signs for itself.
    Own(u32),
    /// Not ours, but the primary holds a hash grant on them.
    Delegated,
}

pub fn signer_for(owner: &str, primary: &str) -> Option<Signer> {
    if owner == primary {
        return Some(Signer::Own(0));
    }
    crate::mcp::virtual_players::VirtualPlayerStore::load()
        .find(owner)
        .map(|p| Signer::Own(p.index))
}

impl Signer {
    pub fn index(&self) -> u32 {
        match self {
            Signer::Own(i) => *i,
            Signer::Delegated => 0,
        }
    }
}

// ── Accepting a result ──────────────────────────────────────────────────────

/// How old a result frame may be and still be worth checking.
///
/// A launch replays the bus's recent history into the sync loop, and a
/// proof posted twenty minutes ago has either been spent — by us before the
/// restart, or by whoever else was listening — or its cycle has moved on.
/// Checking it costs two chain reads and a claim slot to learn that; the
/// first live restart spent that on a backlog of three-hour-old frames and
/// was refused for every one. Twenty minutes is a full pass plus slack.
pub const STALE_FRAME_MS: u64 = 20 * 60 * 1000;

/// Is a frame recent enough to act on? Pure, for the test; a frame with no
/// timestamp is treated as fresh, since refusing it would refuse a whole
/// homeserver that omits the field.
pub fn fresh_enough(ts_ms: u64, now_ms: u64) -> bool {
    ts_ms == 0 || now_ms.saturating_sub(ts_ms) <= STALE_FRAME_MS
}

/// Is the world loaded enough to judge a proof? A launch replays the bus
/// into the sync loop about one second in — before the perception snapshot
/// and the struct-type table exist — and the first live restart refused 28
/// valid frames with "cannot establish this task's difficulty range" for
/// exactly that reason. None of them were ever seen again.
pub fn world_ready() -> bool {
    let gs_ok = crate::game_state::GAME_STATE
        .read()
        .map(|g| !g.struct_types.is_empty() && g.current_block_height > 0)
        .unwrap_or(false);
    // A node that is behind the chain takes a transaction and never gossips
    // it. Held, not refused: the anchor does not move while the node is
    // stuck, so the proof is as good when the node catches up as now.
    gs_ok && crate::mcp::perception::with_snapshot(|_| ()).is_some() && !crate::mcp::chain_health::lcd_stalled()
}

/// A result that arrived before the world was loaded, kept to be judged
/// once it is. Bounded, and still subject to the freshness window when it
/// is finally looked at.
#[derive(Clone)]
struct Held {
    guild: String,
    room: String,
    object: String,
    task: String,
    anchor: u64,
    nonce: String,
    target: Option<String>,
    helper: Option<String>,
    ts: u64,
}

const HOLD_MAX: usize = 200;
static HELD: LazyLock<Mutex<Vec<Held>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn hold(h: Held) {
    if let Ok(mut v) = HELD.lock() {
        if v.len() < HOLD_MAX {
            v.push(h);
        }
    }
}

/// Judge what was held, now that the world is loaded. Called from the
/// crew tick and from the next batch of frames, whichever comes first.
pub fn drain_held(app: &tauri::AppHandle) {
    if !world_ready() {
        return;
    }
    let held: Vec<Held> = match HELD.lock() {
        Ok(mut v) => std::mem::take(&mut *v),
        Err(_) => return,
    };
    if held.is_empty() {
        return;
    }
    let now = now_millis() as u64;
    let (fresh, stale): (Vec<Held>, Vec<Held>) = held.into_iter().partition(|h| fresh_enough(h.ts, now));
    tlog(
        "crew",
        Sev::Info,
        format!("world loaded: judging {} held result frame(s), {} too old", fresh.len(), stale.len()),
    );
    /* One at a time, with a breath between. Judging 33 held frames in
     * parallel at the first live launch put 33 signed transactions into
     * the mempool inside a second: 27 came back `code 19` (already in the
     * mempool cache — the retry layer re-broadcast bytes that were still
     * queued) and the rest sat until they were dropped. The lane is the
     * scarce resource, and a backlog is by definition not urgent. */
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for h in fresh {
            let out = accept(&app, &h.object, &h.task, h.anchor, &h.nonce, h.target.as_deref(), h.helper.as_deref(), &h.guild, &h.room).await;
            note_outcome(&out);
            match out {
                Ok(Some(v)) => tlog("crew", Sev::Info, format!("finished {} from a pheral: {v}", h.object)),
                Ok(None) => {}
                Err(e) => tlog("crew", Sev::Debug, format!("{} not accepted: {e}", h.object)),
            }
            tokio::time::sleep(std::time::Duration::from_millis(HELD_SPACING_MS)).await;
        }
    });
}

/// Between two held frames being judged: roughly a block, so each
/// transaction has a chance to be included before the next is signed.
const HELD_SPACING_MS: u64 = 3_000;

/// Pick the result frames out of a batch of new messages and finish them.
///
/// Called from the Matrix sync loop, so a result completes whether or not the
/// Comms window is open. A closed window must never be the reason a crewmate's
/// proof goes unspent.
pub fn absorb_result_frames(
    app: &tauri::AppHandle,
    guild_id: &str,
    room_id: &str,
    messages: &[crate::matrix::client::Message],
) {
    let cfg = get();
    if !cfg.enabled {
        return;
    }
    // Anything held from before the world was loaded goes first.
    drain_held(app);
    let ready = world_ready();
    let now = now_millis() as u64;
    let mut stale = 0usize;
    let mut held = 0usize;
    for m in messages {
        if m.is_self {
            continue; // our own report; we are not our own helper
        }
        let Some(w) = m.work.as_ref() else { continue };
        if w.get("kind").and_then(|k| k.as_str()) != Some("result") {
            continue;
        }
        if !fresh_enough(m.ts, now) {
            stale += 1;
            continue;
        }
        let (Some(object), Some(task), Some(nonce), Some(anchor)) = (
            w.get("object").and_then(|v| v.as_str()).map(str::to_string),
            w.get("task").and_then(|v| v.as_str()).map(str::to_string),
            w.get("nonce").and_then(|v| v.as_str()).map(str::to_string),
            w.get("block_start").and_then(|v| v.as_u64()),
        ) else {
            continue;
        };
        note_frame();
        let target = w.get("target").and_then(|v| v.as_str()).map(str::to_string);
        // Who did the work, from the Matrix sender — a player id IS a Matrix
        // localpart here, and it is the only thing about the message that is
        // authenticated (by the homeserver, not by us).
        let helper = crate::matrix::directory::player_id_of(&m.sender);
        if !ready {
            // Not refused: kept. A proof judged against an empty world is
            // a proof thrown away.
            hold(Held {
                guild: guild_id.to_string(), room: room_id.to_string(),
                object, task, anchor, nonce, target, helper, ts: m.ts,
            });
            held += 1;
            continue;
        }
        let guild = guild_id.to_string();
        let room = room_id.to_string();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let out = accept(&app, &object, &task, anchor, &nonce, target.as_deref(), helper.as_deref(), &guild, &room).await;
            note_outcome(&out);
            match out {
                Ok(Some(v)) => tlog(
                    "crew",
                    Sev::Info,
                    format!("finished {object} from a pheral: {v}"),
                ),
                Ok(None) => {}
                Err(e) => tlog("crew", Sev::Debug, format!("{object} not accepted: {e}")),
            }
        });
    }
    if stale > 0 {
        tlog("crew", Sev::Debug, format!("left {stale} stale result frame(s) alone — older than the freshness window"));
    }
    if held > 0 {
        tlog("crew", Sev::Info, format!("holding {held} result frame(s) until the world is loaded"));
    }
}

/// Verify one result and submit it. `Ok(None)` means "not ours / not now",
/// which is ordinary; `Err` means the claim was bad.
pub async fn accept(
    app: &tauri::AppHandle,
    object: &str,
    task: &str,
    anchor: u64,
    nonce: &str,
    target: Option<&str>,
    helper: Option<&str>,
    guild_id: &str,
    room_id: &str,
) -> Result<Option<String>, String> {
    let cfg = get();
    if !cfg.enabled {
        return Ok(None);
    }
    let Some(kind) = TaskType::parse(task) else {
        return Err(format!("{task} is not a kind of work"));
    };
    if crate::matrix::refs::parse_id(object).is_none() {
        return Err(format!("{object} is not an object id"));
    }

    let primary = crate::mcp::crew::primary_player()?;
    let client = CosmosClient::new();

    // WHOSE is it? From the chain, never from the message.
    let on_chain = object_view(&client, object, kind).await?;
    let owner = on_chain.owner.clone();
    let signer = match signer_for(&owner, &primary) {
        Some(s) => s,
        // Not one of ours. The primary may still hold a hash grant on them —
        // that is what a grant is FOR — and the chain is asked, not assumed.
        None => {
            let my_guild = crate::game_state::GAME_STATE.read().ok()
                .and_then(|g| g.guild_id.clone()).unwrap_or_default();
            match crate::mcp::crew::authority_of(&client, &owner, &primary, &my_guild, kind).await {
                Ok(a) if a.allows() => Signer::Delegated,
                _ => return Ok(None), // nothing we could sign, so nothing to check
            }
        }
    };

    /* HOW HARD was it? Ours, or we refuse.
     *
     * A proof is only "valid" against a bar, and taking that number from the
     * message would let a stranger set it to zero and have us sign anything.
     * The bar is not stored anywhere: it is DERIVED from the struct type's
     * difficulty RANGE (thousands of blocks) and the cycle's age. Those are
     * two different numbers that both get called "difficulty", and handing
     * the range to the check — as the first version of this did, and as the
     * shipped verify path had done since it was written — demanded thousands
     * of leading zeros and refused every real proof ever computed.
     */
    let (range, planet) = task_view(&owner, object, kind, &on_chain)
        .ok_or("cannot establish this task's difficulty range from our own state or the chain")?;
    /* Would the chain even take it? Asked BEFORE the nonce is checked and
     * long before a transaction is spent. The first live pass spent one
     * every two minutes being told "planet (2-29903) is empty, nothing to
     * mine" for a proof that was, as a proof, perfect. */
    if let Some(why) = crate::mcp::crew_work::nothing_to_do(kind, planet.as_deref(), &owner) {
        return Err(format!("{why}; not submitted"));
    }
    let at_block = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    let Some(proof) =
        crate::matrix::work::verify_at(object, kind.as_str(), anchor, target, nonce, range, at_block)
    else {
        return Err("that nonce does not solve this task".into());
    };
    let bar = crate::matrix::work::required_zeros(anchor, range, at_block);

    // One transaction per cycle, however many people answer.
    if crate::hasher::completion_in_flight(object) == Some(anchor) {
        return Ok(None);
    }
    if !claim(object, anchor) {
        return Ok(None);
    }
    if !take_budget(cfg.max_per_hour) {
        release(object, anchor);
        return Err(format!(
            "hourly ceiling of {} submissions reached; this one was not spent",
            cfg.max_per_hour
        ));
    }

    let out = submit(app, object, kind, anchor, &proof, nonce, &signer).await;
    match &out {
        Err(e) => {
            /* A transport failure may be answered again. A refusal by the
             * chain may NOT: the same cycle with the same nonce gets the same
             * answer, and releasing it here had this machine re-spending a
             * transaction on every re-post of the same proof. The claim
             * stays until the cycle memory expires or the anchor moves. */
            if chain_refused(e) {
                crate::mcp::crew_work::note_event(
                    "refused",
                    format!("chain refused {}'s proof for {object}: {e}", helper.unwrap_or("a pheral")),
                );
            } else {
                release(object, anchor);
            }
        }
        Ok(tx) => {
            crate::mcp::crew_work::note_event(
                "accepted",
                format!("assimilated {}'s proof for {object}: {tx}", helper.unwrap_or("a pheral")),
            );
            // Say so where the proof came from, naming who computed it, so
            // the helper's own card can count a job finished.
            tell_the_room(guild_id, room_id, object, kind, anchor, tx, helper);
            /* Pay the person who did the work.
             *
             * This is the only place the reward loop closes for the ordinary
             * (no-grant) path: the helper computed, WE submitted, so no chain
             * receipt names them — the Matrix sender is who they are. Credit
             * at the bar the proof actually cleared, which is what the rate
             * is per. No crew with pay switched on for them ⇒ no credit, and
             * that is a config choice, not a failure.
             */
            if let Some(h) = helper.filter(|h| *h != primary) {
                credit_helper(h, room_id, object, kind, bar, tx);
            }
        }
    }
    out.map(Some)
}

/// The chain said no, and will keep saying no for this cycle: wrong nonce
/// for its clock, an empty planet, an owner who cannot afford the refine.
/// Only a failure to REACH the chain is worth answering again.
fn chain_refused(e: &str) -> bool {
    e.contains("failed to execute message") || e.contains("cycle moved on") || e.contains("work failure")
}

/// A `done` frame back into the room the result came from.
///
/// Not evidence of anything — the transaction is — but it is how the helper's
/// machine learns its proof was spent, and the only thing in the room that
/// says whose work it was.
fn tell_the_room(
    guild_id: &str,
    room_id: &str,
    object: &str,
    kind: TaskType,
    anchor: u64,
    tx: &str,
    helper: Option<&str>,
) {
    if !crate::matrix::work::tx_hash_is_sound(tx) {
        return;
    }
    let body = format!(
        "Finished {} on {} from {}'s proof \u{2014} tx {}",
        kind.as_str(),
        object,
        helper.unwrap_or("a pheral"),
        tx
    );
    let payload = json!({
        "v": 1, "kind": "done", "task": kind.as_str(), "object": object,
        "block_start": anchor, "tx": tx, "helper": helper,
    });
    let (guild, room, object) = (guild_id.to_string(), room_id.to_string(), object.to_string());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::matrix::post_work(&guild, &room, &body, payload).await {
            tlog("crew", Sev::Debug, format!("finished {object} but could not say so in the room: {e}"));
        }
    });
}

/// Record what a helper is owed for a proof we just submitted for them.
fn credit_helper(helper: &str, room_id: &str, object: &str, kind: TaskType, bar: u64, tx: &str) {
    let Some(c) = crate::mcp::crew::crew_for_helper(helper, room_id) else { return };
    if !c.pay.enabled || c.pay.rate_per_difficulty <= 0.0 {
        return;
    }
    let credit = crate::mcp::crew_pay::Credit {
        id: format!("{}|{}", tx.to_uppercase(), object),
        ts_ms: now_millis(),
        room_id: c.room_id.clone(),
        helper_player: helper.to_string(),
        object_id: object.to_string(),
        category: kind.as_str().to_lowercase(),
        difficulty: bar,
        tx_hash: tx.to_uppercase(),
        amount_base: c.pay.rate_per_difficulty * bar as f64,
        denom: c.pay.denom.clone(),
        settled_at: None,
        settle_tx: None,
    };
    match crate::mcp::crew_pay::record(credit) {
        Ok(true) => {
            tlog("crew", Sev::Info, format!("{helper} owed for {object} at bar {bar}"));
            crate::mcp::crew_work::note_event("credit", format!("{helper} owed for {object} at bar {bar}"));
        }
        Ok(false) => {}
        Err(e) => tlog("crew", Sev::Notice, format!("could not credit {helper}: {e}")),
    }
}

async fn submit(
    app: &tauri::AppHandle,
    object: &str,
    kind: TaskType,
    anchor: u64,
    proof: &str,
    nonce: &str,
    signer: &Signer,
) -> Result<String, String> {
    let client = CosmosClient::new();

    /* The anchor, again, at the last possible moment.
     *
     * The completion message carries no anchor of its own — the chain checks
     * the nonce against ITS current clock — so a proof is only alive while the
     * cycle it was ground for is. This one has crossed a homeserver and sat in
     * a queue, so it has had far longer to die than a local one.
     */
    let guard = match (kind.is_ore(), crate::mcp::types::StructId::parse(object)) {
        (true, Ok(sid)) => match crate::mcp::verify::solved_anchor_live(&client, &sid, kind).await {
            Ok((live, planet, _)) => {
                let live = live.get();
                if live != 0 && live != anchor {
                    return Err(format!(
                        "cycle moved on: solved against {anchor}, chain is at {live}"
                    ));
                }
                planet.map(|planet_id| crate::mcp::tx_retry::FreshAnchor {
                    planet_id,
                    task_type: kind,
                    solved_anchor: crate::mcp::types::Block::new(anchor),
                })
            }
            Err(_) => None,
        },
        _ => None,
    };

    let clock_planet = guard.as_ref().map(|g| g.planet_id.clone());
    crate::hasher::note_completion_in_flight(object, anchor);
    let res = crate::mcp::tx_retry::sign_with_retry_guarded(
        app,
        signer.index(),
        kind.completion_type_url(),
        kind.completion_payload(object, proof, nonce),
        &crate::mcp::types::Context::parse(&format!("crew_accept:{object}")),
        guard,
    )
    .await;
    crate::hasher::clear_completion_in_flight(object);
    // The chain restarted the planet's clock at inclusion: tell the local
    // source of truth now, or the harvest loop re-nominates this rig against
    // the consumed anchor and grinds a proof the chain then refuses.
    if let (Ok(v), Some(planet)) = (&res, clock_planet.as_ref()) {
        let height = v
            .get("height")
            .and_then(|h| h.as_u64().or_else(|| h.as_str().and_then(|s| s.parse().ok())))
            .filter(|h| *h > 0)
            .unwrap_or_else(|| {
                crate::game_state::GAME_STATE.read().ok().map(|g| g.current_block_height).unwrap_or(0)
            });
        crate::mcp::perception::note_clock_restart(planet, kind, crate::mcp::types::Block::new(height));
    }
    res.map(|v| {
        v.get("transactionHash")
            .or_else(|| v.get("txhash"))
            .and_then(|h| h.as_str())
            .unwrap_or("accepted")
            .to_string()
    })
}

/// What the chain says about the object: who owns it, what type it is, and
/// which planet it stands on. One read, used for the owner AND as the
/// fallback for the difficulty range.
struct ObjectView {
    owner: String,
    type_id: Option<String>,
    planet: Option<String>,
}

async fn object_view(client: &CosmosClient, object: &str, kind: TaskType) -> Result<ObjectView, String> {
    let (entity, cap) = if kind == TaskType::Raid { ("fleet", "Fleet") } else { ("struct", "Struct") };
    let v = client.entity(entity, object).await?;
    let e = v.get(cap).cloned().unwrap_or(Value::Null);
    let owner = e
        .get("owner")
        .and_then(|o| o.as_str())
        .filter(|o| !o.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{object} has no owner on chain"))?;
    let type_id = e.get("type").and_then(|t| t.as_str()).map(str::to_string);
    let planet = match e.get("locationType").and_then(|t| t.as_str()) {
        Some("planet") => e.get("locationId").and_then(|l| l.as_str()).map(str::to_string),
        _ => None,
    };
    Ok(ObjectView { owner, type_id, planet })
}

/// The struct type's difficulty range for this kind of work, and the planet
/// whose clock it runs on: from OUR view of the world first, and failing
/// that from the type the chain just told us. `None` is a refusal, not a
/// zero.
///
/// The fallback exists because a helper's snapshot and ours disagree all
/// afternoon — their rig is ripe in theirs and offline, or unknown, in ours
/// — and the first live run refused 34 valid proofs for want of a row we did
/// not need: the range is a property of the TYPE, and the type was already
/// in the reply that named the owner. The chain still judges the anchor.
fn task_view(owner: &str, object: &str, kind: TaskType, on_chain: &ObjectView) -> Option<(u64, Option<String>)> {
    if let Some(v) = local_task_view(owner, object, kind) {
        return Some(v);
    }
    let type_id = on_chain.type_id.as_deref()?;
    let gs = crate::game_state::GAME_STATE.read().ok()?;
    let t = gs.struct_types.get(type_id)?;
    let range = match kind {
        TaskType::Mine => t.ore_mining_difficulty,
        TaskType::Refine => t.ore_refining_difficulty,
        TaskType::Build => t.build_difficulty,
        TaskType::Raid => 0,
    };
    (range > 0).then(|| (range, on_chain.planet.clone()))
}

fn local_task_view(owner: &str, object: &str, kind: TaskType) -> Option<(u64, Option<String>)> {
    if let Some(rows) = crate::mcp::perception::work_for_player(owner) {
        for r in rows {
            if r.get("object_id").and_then(|v| v.as_str()) == Some(object)
                && r.get("category").and_then(|v| v.as_str()) == Some(kind.as_str())
            {
                let d = crate::mcp::perception::to_u64(r.get("difficulty_target"));
                if d > 0 {
                    let planet = r.get("planet_id").and_then(|p| p.as_str()).map(str::to_string);
                    return Some((d, planet));
                }
            }
        }
    }
    crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.get_difficulty_for_struct(object, kind.as_str()))
        .filter(|d| *d > 0)
        .map(|d| (d, None))
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn crew_submit_config() -> Result<Value, String> {
    Ok(json!({ "config": get(), "spent_this_hour": spent_this_hour() }))
}

#[tauri::command]
pub fn crew_submit_set(
    window: tauri::WebviewWindow,
    config: CrewSubmitConfig,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    set(config);
    Ok(json!({ "ok": true, "config": get() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepting_results_is_on_by_default_and_bounded() {
        let c = CrewSubmitConfig::default();
        assert!(c.enabled, "a result nobody signs is wasted electricity");
        assert!(c.max_per_hour > 0, "and an unbounded one drains the tx lane");
    }

    /// Two helpers answering the same cycle is the DESIGN — they grind it from
    /// different nonce starts — so the duplicate must cost nothing.
    #[test]
    fn one_cycle_is_claimed_once() {
        assert!(claim("5-claimtest", 100));
        assert!(!claim("5-claimtest", 100), "a second answer is not a second transaction");
        // A different cycle on the same object is a different piece of work.
        assert!(claim("5-claimtest", 101));
        // Releasing lets a failed attempt be answered again.
        release("5-claimtest", 100);
        assert!(claim("5-claimtest", 100));
    }

    #[test]
    fn the_hourly_ceiling_stops_a_flood() {
        // A ceiling of zero admits nothing, whatever else is true.
        assert!(!take_budget(0));
    }

    /// Without a chain read, we can only name a signer for an account we hold
    /// a key for. A stranger's object comes back `None` here and is then asked
    /// about ON CHAIN — a real grant to the primary is the only other way in.
    /// The chain's no is final for the cycle; only not reaching it is worth
    /// another try. Getting this backwards re-spends a transaction on every
    /// re-post of the same refused proof.
    /// Outcomes are counted for the card: spent, refused at the ceiling,
    /// refused for anything else; "not ours" is not an event at all.
    #[test]
    fn outcomes_are_tallied_for_the_card() {
        let before = stats();
        note_outcome(&Ok(Some("TX".into())));
        note_outcome(&Ok(None));
        note_outcome(&Err("hourly ceiling of 240 submissions reached".into()));
        note_outcome(&Err("that nonce does not solve this task".into()));
        let after = stats();
        let d = |k: &str| after[k].as_u64().unwrap() - before[k].as_u64().unwrap();
        assert_eq!((d("accepted_total"), d("refused_ceiling"), d("refused_other")), (1, 1, 1));
        assert!(after["ceiling"].as_u64().unwrap() >= 240, "the ceiling is a flood guard, not a budget");
    }

    /// The backlog a launch replays is mostly spent or dead; a frame older
    /// than the window is left alone without a chain read.
    /// What arrives before the world is loaded is kept, not refused — and
    /// kept within a bound, so a very long outage cannot grow it forever.
    #[test]
    fn early_frames_are_held_within_a_bound() {
        let mk = |i: usize| Held {
            guild: "0-1".into(), room: "!bus:h".into(), object: format!("5-{i}"), task: "MINE".into(),
            anchor: 100, nonce: "1".into(), target: None, helper: None, ts: 0,
        };
        HELD.lock().unwrap().clear();
        for i in 0..(HOLD_MAX + 25) {
            hold(mk(i));
        }
        assert_eq!(HELD.lock().unwrap().len(), HOLD_MAX);
        HELD.lock().unwrap().clear();
    }

    #[test]
    fn old_frames_from_the_backlog_are_left_alone() {
        let now = 10_000_000_000u64;
        assert!(fresh_enough(now - 60_000, now), "a minute old is fresh");
        assert!(fresh_enough(now - STALE_FRAME_MS, now), "at the window is still fresh");
        assert!(!fresh_enough(now - STALE_FRAME_MS - 1, now), "past it is not");
        assert!(fresh_enough(0, now), "no timestamp is not a reason to refuse");
        assert!(fresh_enough(now + 5_000, now), "a clock slightly ahead is fresh, not negative");
    }

    #[test]
    fn a_chain_refusal_is_final_and_a_transport_failure_is_not() {
        assert!(chain_refused("failed to execute message; message index: 0: planet (2-29903) is empty, nothing to mine"));
        assert!(chain_refused("cycle moved on: solved against 2572000, chain is at 2572700"));
        assert!(chain_refused("work failure: hash does not meet difficulty"));
        assert!(!chain_refused("timed out waiting for the signing bridge"));
        assert!(!chain_refused("connection reset by peer"));
    }

    #[test]
    fn a_key_we_hold_is_a_signer_and_a_stranger_is_a_question_for_the_chain() {
        assert_eq!(signer_for("1-194", "1-194"), Some(Signer::Own(0)));
        assert_eq!(signer_for("1-999999", "1-194"), None);
        assert_eq!(Signer::Delegated.index(), 0, "a delegated proof is signed by the primary");
    }
}
