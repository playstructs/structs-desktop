//! Paying for work that was actually done.
//!
//! droidsh proved a crew can share proofs and got one Alpha's worth of them
//! confirmed across two Macs. What it could not do is pay anybody: helpers
//! earn a line in a local tally and nothing else. A tally is a nice thing to
//! look at once; it is not a reason for a stranger to leave their GPU running
//! for you tomorrow.
//!
//! So this module turns finished work into money, and the whole design rests
//! on one decision: **nothing is ever paid for on the word of a message.**
//!
//! When a crewmate finishes one of our proofs they announce it in the room,
//! and that announcement carries a transaction hash. The hash is a POINTER.
//! What settles the claim is the transaction itself, fetched from the chain
//! here, containing an `EventHashSuccess{callerAddress, category, difficulty,
//! objectId}` the consensus wrote. From it we learn who did the work and —
//! this is the part that makes the rate honest — how hard it actually was.
//! A forged announcement names a transaction that either does not exist, does
//! not carry the event, or does not name our object; all three are refused
//! before a single unit moves.
//!
//! Two further rules, both inherited rather than invented:
//!
//!   * the destination is read from the CHAIN (`player.primaryAddress` via
//!     `matrix::resolve_payable`, which resolves back to the helper's player
//!     id), never from the message and never even from the address in the
//!     receipt — a message must not be able to name where money goes, and
//!     that rule does not get an exception because the feature is convenient;
//!   * every payment goes through `mcp_transfer_execute_impl`, which re-runs
//!     its own preview server-side and pays vault→vault (`MsgVaultSend`, v0.22)
//!     on validated owner ids.
//!
//! Standing authority to spend is the sharpest thing in this feature, so it is
//! off by default and bounded twice — per helper and per epoch — and it stops
//! at the cap rather than asking to go over it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::crew::{self, Pay};
use crate::mcp::telemetry::{tlog, Sev};

const FILENAME: &str = "crew_ledger.json";

/// How long a settled credit is kept. Long enough to answer "what did I pay
/// last week", short enough that the file never becomes a database.
const KEEP_SETTLED_MS: f64 = 30.0 * 24.0 * 3_600_000.0;

// ── Terms, published ────────────────────────────────────────────────────────
//
// What a payer offers, as ROOM STATE on the bus: `structs.pay`, state_key =
// the payer's own Matrix id. State, not a message, because only the current
// value matters and a machine joining later must see it without scrolling
// history; the payer's id as the key because Matrix lets only that user set
// a state event keyed by their id, so the terms are authentic without any
// signature of ours. A helper reads these to know what finishing somebody's
// work is worth BEFORE spending GPU on it.

pub const PAY_STATE_TYPE: &str = "structs.pay";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Terms {
    pub enabled: bool,
    pub denom: String,
    pub rate_per_difficulty: f64,
    pub epoch_cap: f64,
    pub per_helper_cap: f64,
    pub min_payout: f64,
}

/// What we publish for a crew's pay. Off is published too — a rate that
/// was withdrawn must not go on being advertised.
pub fn terms_of(pay: &Pay) -> Value {
    // Amounts travel as STRINGS. Matrix canonical JSON has no floats — the
    // homeserver refused the first publish with `M_BAD_JSON: Bad JSON
    // value: float` — and the chain's own APIs already carry every amount
    // as a string, so this is the wire's convention, not a workaround.
    let amt = |x: f64| -> String { format!("{x}") };
    json!({
        "v": 1,
        "enabled": pay.enabled && pay.rate_per_difficulty > 0.0,
        "denom": pay.denom,
        "rate_per_difficulty": amt(pay.rate_per_difficulty),
        "epoch_cap": amt(pay.epoch_cap),
        "per_helper_cap": amt(pay.per_helper_cap),
        "min_payout": amt(pay.min_payout),
    })
}

/// Strict: this is another player's JSON. A rate has to be a finite,
/// non-negative number and a denom has to look like one; anything else is
/// not terms, and is not shown as terms.
pub fn parse_terms(content: &Value) -> Option<Terms> {
    if content.get("v").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    // A string is the published form; a bare number is accepted too, for
    // any client that writes one. Anything unparseable reads as 0.
    let num = |k: &str| -> Option<f64> {
        let v = content.get(k);
        let x = v
            .and_then(|v| v.as_f64())
            .or_else(|| v.and_then(|v| v.as_str()).and_then(|s| s.trim().parse::<f64>().ok()))
            .unwrap_or(0.0);
        (x.is_finite() && x >= 0.0).then_some(x)
    };
    let denom = content.get("denom").and_then(|d| d.as_str()).unwrap_or("");
    if denom.is_empty()
        || denom.len() > 64
        || !denom.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return None;
    }
    Some(Terms {
        enabled: content.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false),
        denom: denom.to_string(),
        rate_per_difficulty: num("rate_per_difficulty")?,
        epoch_cap: num("epoch_cap")?,
        per_helper_cap: num("per_helper_cap")?,
        min_payout: num("min_payout")?,
    })
}

/// `matrix user -> terms`, as last seen on the bus.
static TERMS_ON_BUS: LazyLock<RwLock<std::collections::HashMap<String, Terms>>> =
    LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// Called by the sync loop for every `structs.pay` state event.
pub fn note_terms_on_bus(user_id: &str, content: &Value) {
    if !user_id.starts_with('@') {
        return; // not keyed by a user: not terms anyone vouched for
    }
    let Some(t) = parse_terms(content) else { return };
    if let Ok(mut m) = TERMS_ON_BUS.write() {
        m.insert(user_id.to_string(), t);
    }
}

/// Who is paying, best rate first — for the helper's card. Off and zero
/// are left out: an offer of nothing is not an offer.
pub fn terms_on_bus() -> Vec<Value> {
    let me = crate::mcp::crew::primary_player().unwrap_or_default();
    let mut out: Vec<(f64, Value)> = TERMS_ON_BUS
        .read()
        .map(|m| {
            m.iter()
                .filter(|(_, t)| t.enabled && t.rate_per_difficulty > 0.0)
                .filter_map(|(u, t)| {
                    let pid = crate::matrix::directory::player_id_of(u)?;
                    if pid == me {
                        return None; // our own offer is on the bounty card
                    }
                    let name = crate::matrix::directory::get(&pid).map(|i| i.username).unwrap_or_default();
                    Some((t.rate_per_difficulty, json!({
                        "payer": pid, "name": name, "denom": t.denom,
                        "rate": t.rate_per_difficulty, "per_helper_cap": t.per_helper_cap,
                        "min_payout": t.min_payout,
                    })))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, v)| v).collect()
}

/// `player id -> rate per difficulty` for everyone paying on the bus, for
/// the helper's task ordering. Our own terms are not a reason to prefer
/// our own work — that is the harvest loop's job, not the crew's.
pub fn rates_by_player() -> std::collections::HashMap<String, f64> {
    let me = crate::mcp::crew::primary_player().unwrap_or_default();
    TERMS_ON_BUS
        .read()
        .map(|m| {
            m.iter()
                .filter(|(_, t)| t.enabled && t.rate_per_difficulty > 0.0)
                .filter_map(|(u, t)| {
                    let pid = crate::matrix::directory::player_id_of(u)?;
                    (pid != me).then_some((pid, t.rate_per_difficulty))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether this session has managed to publish its terms yet.
static TERMS_PUBLISHED: AtomicBool = AtomicBool::new(false);
/// Not before this instant, after a failure: the tick runs every few
/// seconds and the first live launch asked the homeserver twice every ten
/// seconds to refuse the same event.
static TERMS_NEXT_TRY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const TERMS_RETRY_MS: u64 = 5 * 60 * 1000;
/// When the terms could only go out as a timeline event, they age out with
/// the room's retention (a day on the bus) and are said again well inside it.
const TERMS_REPUBLISH_MS: u64 = 6 * 60 * 60 * 1000;

/// Publish once per session, when the guild is known and the bus is joined.
/// The bus is joined during the first sync, a second after launch, when the
/// guild id is not loaded yet — so the publish that fires then goes
/// nowhere, and this one, from the crew tick, is the one that lands.
pub async fn ensure_terms_published() {
    if TERMS_PUBLISHED.load(Ordering::Relaxed) {
        return;
    }
    let now = now_millis() as u64;
    if now < TERMS_NEXT_TRY_MS.load(Ordering::Relaxed) {
        return;
    }
    let guild = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone()).unwrap_or_default();
    if guild.is_empty() {
        return;
    }
    TERMS_NEXT_TRY_MS.store(now + TERMS_RETRY_MS, Ordering::Relaxed);
    publish_helpers_terms().await;
}

/// Publish our "anyone who helps" terms — or their absence — on the bus.
pub async fn publish_helpers_terms() {
    let terms = match crew::get(crew::HELPERS_CREW) {
        Some(c) => terms_of(&c.pay),
        None => json!({ "v": 1, "enabled": false, "denom": "ualpha",
                        "rate_per_difficulty": "0", "epoch_cap": "0", "per_helper_cap": "0",
                        "min_payout": "0" }),
    };
    let guild = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone()).unwrap_or_default();
    if guild.is_empty() {
        return;
    }
    match crate::matrix::publish_pay_terms(&guild, terms).await {
        Ok(crate::matrix::TermsMode::State) => {
            TERMS_PUBLISHED.store(true, Ordering::Relaxed);
            tlog("crew", Sev::Info, "pay terms published on the bus (state)".to_string());
        }
        Ok(crate::matrix::TermsMode::Timeline) => {
            // Not "published" for good: due again before retention eats it.
            TERMS_NEXT_TRY_MS.store(now_millis() as u64 + TERMS_REPUBLISH_MS, Ordering::Relaxed);
            tlog("crew", Sev::Info, "pay terms published on the bus (timeline; republished every 6 h)".to_string());
        }
        Err(e) => tlog("crew", Sev::Notice, format!("pay terms not published: {e}")),
    }
}

// ── The receipt ─────────────────────────────────────────────────────────────

/// What consensus says about one finished proof.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Receipt {
    /// The address that SUBMITTED the completion. Not a payment destination —
    /// it is an identity, and where that identity gets paid is a separate
    /// question the chain answers separately.
    pub caller_address: String,
    /// `mine` | `refine` | `build` | `raid`, as the chain spells it.
    pub category: String,
    /// The difficulty actually achieved. The measure of work, and what the
    /// rate multiplies.
    pub difficulty: u64,
    pub object_id: String,
}

/// Pull every `EventHashSuccess` out of a transaction response.
///
/// Tolerant of both shapes a Cosmos LCD serves typed events in — one
/// attribute holding the whole detail as a JSON string, or one attribute per
/// field — because which you get depends on the node's SDK version, and a
/// parser that only knew one would silently find no receipts and quietly pay
/// nobody.
pub fn parse_receipts(tx_response: &Value) -> Vec<Receipt> {
    let mut out = Vec::new();
    let events = tx_response
        .get("tx_response")
        .and_then(|r| r.get("events"))
        .or_else(|| tx_response.get("events"))
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    for ev in events {
        let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !ty.ends_with("EventHashSuccess") {
            continue;
        }
        let attrs = ev.get("attributes").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let mut flat = serde_json::Map::new();
        for a in &attrs {
            let key = a.get("key").and_then(|k| k.as_str()).unwrap_or("");
            let raw = a.get("value").cloned().unwrap_or(Value::Null);
            // Values arrive JSON-encoded: a nested object for the detail
            // attribute, a quoted scalar for a flat one.
            let decoded = match &raw {
                Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!(s)),
                other => other.clone(),
            };
            match decoded {
                Value::Object(o) => flat.extend(o),
                other => {
                    flat.insert(key.to_string(), other);
                }
            }
        }
        let get = |k: &str, alt: &str| -> Option<Value> {
            flat.get(k).or_else(|| flat.get(alt)).cloned()
        };
        let text = |v: Option<Value>| -> String {
            v.and_then(|x| x.as_str().map(str::to_string)).unwrap_or_default()
        };
        let object_id = text(get("objectId", "object_id"));
        let caller_address = text(get("callerAddress", "caller_address"));
        if object_id.is_empty() || caller_address.is_empty() {
            continue;
        }
        out.push(Receipt {
            caller_address,
            category: text(get("category", "category")),
            difficulty: get("difficulty", "difficulty")
                .and_then(|d| d.as_u64().or_else(|| d.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0),
            object_id,
        });
    }
    out
}

// ── The ledger ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Credit {
    /// `{tx}|{object}` — the idempotency key. A claim announced twice, or
    /// replayed by somebody else, credits once.
    pub id: String,
    pub ts_ms: f64,
    pub room_id: String,
    pub helper_player: String,
    pub object_id: String,
    pub category: String,
    pub difficulty: u64,
    pub tx_hash: String,
    /// Base units owed, fixed at the rate in force when the work landed —
    /// lowering the rate later must not retroactively cheapen work already
    /// done.
    pub amount_base: f64,
    pub denom: String,
    #[serde(default)]
    pub settled_at: Option<f64>,
    #[serde(default)]
    pub settle_tx: Option<String>,
    /// Base units confirmed paid toward this credit. A cap can cut a payment
    /// through the middle of one; the rest stays owed.
    #[serde(default)]
    pub paid_base: f64,
}

impl Credit {
    /// Still owed, ignoring payments not yet confirmed.
    pub fn owed(&self) -> f64 {
        if self.settled_at.is_some() {
            0.0
        } else {
            (self.amount_base - self.paid_base).max(0.0)
        }
    }
}

/// Where a payment stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentState {
    /// Signed or about to be, outcome unknown. Written BEFORE signing, so a
    /// crash or a timeout leaves a record rather than a debt to pay again.
    Open,
    /// On chain and successful.
    Paid,
}

/// Money that left, or may have left, for one helper. The payments — not the
/// credits they discharge — are what the caps count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Payment {
    pub id: String,
    pub ts_ms: f64,
    pub room_id: String,
    pub helper_player: String,
    /// The owner id paid, as signed. What an unanswered payment is found by.
    #[serde(default)]
    pub to: String,
    pub denom: String,
    pub amount_base: f64,
    /// How much of it goes to which credit.
    pub parts: Vec<(String, f64)>,
    pub state: PaymentState,
    #[serde(default)]
    pub tx: Option<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ledger {
    #[serde(default)]
    pub credits: Vec<Credit>,
    #[serde(default)]
    pub payments: Vec<Payment>,
}

static LEDGER: LazyLock<RwLock<Ledger>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));
static SETTLING: AtomicBool = AtomicBool::new(false);
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

fn save(l: &Ledger) {
    crate::mcp::config_store::save_config(FILENAME, l);
}

pub fn payments() -> Vec<Payment> {
    LEDGER.read().map(|l| l.payments.clone()).unwrap_or_default()
}

pub fn credits() -> Vec<Credit> {
    LEDGER.read().map(|l| l.credits.clone()).unwrap_or_default()
}

/// Add a credit unless its id is already known. Returns whether it was new.
pub fn record(credit: Credit) -> Result<bool, String> {
    let mut l = LEDGER.write().map_err(|_| "ledger unavailable")?;
    if l.credits.iter().any(|c| c.id == credit.id) {
        return Ok(false);
    }
    l.credits.push(credit);
    prune(&mut l, now_millis());
    save(&l);
    Ok(true)
}

fn prune(l: &mut Ledger, now: f64) {
    let cutoff = now - KEEP_SETTLED_MS;
    let open: std::collections::HashSet<String> = l
        .payments
        .iter()
        .filter(|p| p.state == PaymentState::Open)
        .flat_map(|p| p.parts.iter().map(|(id, _)| id.clone()))
        .collect();
    l.credits.retain(|c| {
        open.contains(&c.id)
            || match c.settled_at {
                Some(t) => t > cutoff,
                // Recorded at a rate of nothing: never owed, so never settled.
                None => c.amount_base > 0.0 || c.ts_ms > cutoff,
            }
    });
    l.payments.retain(|p| p.state == PaymentState::Open || p.ts_ms > cutoff);
}

/// Write a payment down before it is signed. `Err` = not written, so it must
/// not be signed.
fn open_payment(p: Payment) -> Result<(), String> {
    let mut l = LEDGER.write().map_err(|_| "ledger unavailable")?;
    let id = p.id.clone();
    l.payments.push(p);
    if let Err(e) = crate::mcp::config_store::try_save_config(FILENAME, &*l) {
        l.payments.retain(|p| p.id != id);
        return Err(format!("the ledger could not be saved ({e}); nothing was paid"));
    }
    Ok(())
}

fn note_payment(id: &str, tx: Option<String>, note: &str) {
    if let Ok(mut l) = LEDGER.write() {
        if let Some(p) = l.payments.iter_mut().find(|p| p.id == id) {
            if tx.is_some() {
                p.tx = tx;
            }
            p.note = note.chars().take(300).collect();
        }
        save(&l);
    }
}

/// It landed: apply each part to its credit.
fn confirm_payment(id: &str, tx: Option<String>) {
    if let Ok(mut l) = LEDGER.write() {
        confirm_in(&mut l, id, tx, now_millis());
        save(&l);
    }
}

fn confirm_in(l: &mut Ledger, id: &str, tx: Option<String>, now: f64) {
    let Some(p) = l.payments.iter_mut().find(|p| p.id == id && p.state == PaymentState::Open) else { return };
    p.state = PaymentState::Paid;
    if tx.is_some() {
        p.tx = tx;
    }
    let (parts, tx) = (p.parts.clone(), p.tx.clone());
    for (cid, amount) in parts {
        if let Some(c) = l.credits.iter_mut().find(|c| c.id == cid) {
            c.paid_base += amount;
            if c.amount_base - c.paid_base < 1e-6 {
                c.settled_at = Some(now);
                c.settle_tx = tx.clone();
            }
        }
    }
}

/// It definitely did not happen: the debt stands as it was.
fn drop_payment(id: &str) {
    if let Ok(mut l) = LEDGER.write() {
        l.payments.retain(|p| !(p.id == id && p.state == PaymentState::Open));
        save(&l);
    }
}

// ── What is owed ────────────────────────────────────────────────────────────

/// One helper's settlement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settlement {
    pub helper_player: String,
    pub amount_base: f64,
    pub denom: String,
    /// The credits this settlement pays toward, and how much of each, so
    /// marking them is exact.
    pub parts: Vec<(String, f64)>,
    /// Set when a cap cut the payment short — the card says so rather than
    /// quietly paying less than the ledger shows.
    pub capped: bool,
}

/// What this crew should pay right now, given its caps.
///
/// Pure, because it is the arithmetic that decides how much money leaves the
/// wallet and that should be provable without a chain, a wallet or a clock.
///
/// Both caps are ceilings on what is paid per EPOCH, never targets: hitting
/// one stops the payment at the cap and leaves the rest owed. They count
/// `payments` — money that left or may have — so a payment whose outcome is
/// unknown neither frees its budget nor is made again.
pub fn payable(credits: &[Credit], payments: &[Payment], pay: &Pay, room_id: &str, now: f64) -> Vec<Settlement> {
    if !pay.enabled || pay.rate_per_difficulty <= 0.0 {
        return Vec::new();
    }
    let mut budget = if pay.epoch_cap > 0.0 {
        (pay.epoch_cap - spent_this_epoch(credits, payments, room_id, pay.epoch_secs, now)).max(0.0)
    } else {
        f64::INFINITY
    };
    if budget <= 0.0 {
        return Vec::new();
    }

    // What each credit still owes once every open payment has landed.
    let mut pending: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
    for p in payments.iter().filter(|p| p.state == PaymentState::Open) {
        for (id, amount) in &p.parts {
            *pending.entry(id.as_str()).or_default() += amount;
        }
    }
    let due = |c: &Credit| -> f64 { (c.owed() - pending.get(c.id.as_str()).copied().unwrap_or(0.0)).max(0.0) };
    let ours: Vec<&Credit> = credits
        .iter()
        .filter(|c| c.room_id == room_id && c.denom == pay.denom && due(c) > 0.0)
        .collect();

    // Deterministic order so two runs of the same ledger pay the same people
    // in the same order when the budget is short: whoever has waited longest
    // first, so a short budget cannot starve the same helper forever.
    let mut helpers: Vec<(f64, &str)> = Vec::new();
    for c in &ours {
        match helpers.iter_mut().find(|(_, h)| *h == c.helper_player) {
            Some((oldest, _)) => *oldest = oldest.min(c.ts_ms),
            None => helpers.push((c.ts_ms, &c.helper_player)),
        }
    }
    helpers.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(b.1)));

    let mut out = Vec::new();
    for (_, helper) in helpers {
        let mut mine: Vec<&Credit> = ours.iter().copied().filter(|c| c.helper_player == helper).collect();
        mine.sort_by(|a, b| a.ts_ms.total_cmp(&b.ts_ms).then_with(|| a.id.cmp(&b.id)));
        let owed: f64 = mine.iter().map(|c| due(c)).sum();
        // Batching: below the floor, the debt simply waits. The floor can
        // never exceed the per-helper cap, or a capped helper would never
        // reach it and never be paid.
        let floor = if pay.per_helper_cap > 0.0 { pay.min_payout.min(pay.per_helper_cap) } else { pay.min_payout };
        if floor > 0.0 && owed < floor {
            continue;
        }
        let mut room_left = budget;
        if pay.per_helper_cap > 0.0 {
            room_left = room_left.min(pay.per_helper_cap - spent_on(credits, payments, room_id, helper, pay.epoch_secs, now));
        }
        let capped = owed > room_left;
        // Base units are integers on the wire; paying a fraction of one is a
        // rounding error looking for somewhere to happen.
        let amount = owed.min(room_left).floor();
        if amount < 1.0 {
            continue;
        }
        // Oldest first, through the middle of a credit if need be.
        let mut left = amount;
        let mut parts = Vec::new();
        for c in &mine {
            let take = due(c).min(left);
            if take <= 0.0 {
                break;
            }
            left -= take;
            parts.push((c.id.clone(), take));
        }
        budget -= amount;
        out.push(Settlement { helper_player: helper.to_string(), amount_base: amount, denom: pay.denom.clone(), parts, capped });
        if budget <= 0.0 {
            break;
        }
    }
    out
}

/// What this crew has paid, or may have, inside the current epoch.
pub fn spent_this_epoch(credits: &[Credit], payments: &[Payment], room_id: &str, epoch_secs: u64, now: f64) -> f64 {
    spent(credits, payments, room_id, None, epoch_secs, now)
}

fn spent_on(credits: &[Credit], payments: &[Payment], room_id: &str, helper: &str, epoch_secs: u64, now: f64) -> f64 {
    spent(credits, payments, room_id, Some(helper), epoch_secs, now)
}

fn spent(credits: &[Credit], payments: &[Payment], room_id: &str, helper: Option<&str>, epoch_secs: u64, now: f64) -> f64 {
    let since = now - (epoch_secs as f64) * 1000.0;
    let is = |h: &str| helper.is_none_or(|want| want == h);
    let paid: f64 = payments
        .iter()
        .filter(|p| p.room_id == room_id && is(&p.helper_player) && (p.state == PaymentState::Open || p.ts_ms >= since))
        .map(|p| p.amount_base)
        .sum();
    // Settled before payments were recorded on their own.
    let legacy: f64 = credits
        .iter()
        .filter(|c| c.room_id == room_id && is(&c.helper_player) && c.paid_base == 0.0)
        .filter(|c| c.settled_at.is_some_and(|t| t >= since))
        .map(|c| c.amount_base)
        .sum();
    paid + legacy
}

// ── Claiming ────────────────────────────────────────────────────────────────

/// A crewmate says they finished one of our proofs. Check, then credit.
///
/// Everything about the claim except *where to look* is discarded: the object,
/// the worker and the difficulty all come out of the transaction. The only
/// thing the message decides is which transaction gets read, and a hash that
/// names someone else's work simply fails the ownership test below.
pub async fn absorb_claim(
    room_id: &str,
    tx_hash: &str,
    claimed_object: &str,
) -> Result<Option<Credit>, String> {
    if !crate::matrix::work::tx_hash_is_sound(tx_hash) {
        return Err("that is not a transaction hash".into());
    }
    let (me, _) = match crate::game_state::GAME_STATE.read() {
        Ok(gs) => (gs.player_id.clone().unwrap_or_default(), ()),
        Err(_) => return Err("game state unavailable".into()),
    };
    if me.is_empty() {
        return Err("this app does not know who you are yet".into());
    }

    let client = CosmosClient::new();
    let tx = client
        .lcd_get(&format!("/cosmos/tx/v1beta1/txs/{tx_hash}"))
        .await?;
    // Settled credits are forgotten after KEEP_SETTLED_MS, and the memory of
    // them is what stops a claim being paid twice. Past that age the only
    // thing that can be said about a proof is that it is too old to bill.
    if !recent_enough(&tx, now_millis()) {
        return Err(format!("{tx_hash} is more than 30 days old, or carries no time — nothing credited"));
    }
    let receipts = parse_receipts(&tx);
    let Some(r) = receipts.into_iter().find(|r| r.object_id == claimed_object) else {
        return Err(format!(
            "{tx_hash} carries no completion for {claimed_object} — nothing credited"
        ));
    };

    // Ours? The payer is the OWNER of the object, and the chain is the only
    // thing that knows who that is. A claim about somebody else's rig is not
    // our bill however true it is.
    let owner = object_owner(&client, &r.object_id).await?;
    if owner != me {
        return Ok(None);
    }
    // And the worker must not be us: our own completions are not a debt.
    let helper = player_of_address(&client, &r.caller_address).await?;
    if helper == me || helper.is_empty() {
        return Ok(None);
    }
    // Whose terms? The claim arrived on the bus, which is nobody's crew; the
    // crew is the one that covers the HELPER — the friend link naming them,
    // the room they are in, or the guild link for their guild.
    let Some(c) = crew::crew_for_helper(&helper, room_id) else {
        return Ok(None); // no link with this person; nothing to owe
    };

    let amount = (c.pay.rate_per_difficulty * r.difficulty as f64).max(0.0);
    let credit = Credit {
        id: format!("{}|{}", tx_hash.to_uppercase(), r.object_id),
        ts_ms: now_millis(),
        // Filed under the crew, not the bus: settlement runs per crew.
        room_id: c.room_id.clone(),
        helper_player: helper,
        object_id: r.object_id.clone(),
        category: r.category.clone(),
        difficulty: r.difficulty,
        tx_hash: tx_hash.to_uppercase(),
        amount_base: amount,
        denom: c.pay.denom.clone(),
        settled_at: None,
        settle_tx: None,
        paid_base: 0.0,
    };
    if record(credit.clone())? {
        tlog(
            "crew",
            Sev::Info,
            format!(
                "{} finished {} on {} at difficulty {} — {} {} owed",
                credit.helper_player, credit.category, credit.object_id, credit.difficulty,
                credit.amount_base, credit.denom
            ),
        );
        crate::mcp::crew_work::note_event(
            "credit",
            format!("{} owed {} {} for {}", credit.helper_player, credit.amount_base, credit.denom, credit.object_id),
        );
        return Ok(Some(credit));
    }
    Ok(None)
}

fn recent_enough(tx: &Value, now: f64) -> bool {
    tx.pointer("/tx_response/timestamp")
        .and_then(|t| t.as_str())
        .and_then(crate::mcp::onboarding::parse_ts)
        .is_some_and(|t| now - t as f64 <= KEEP_SETTLED_MS)
}

async fn object_owner(client: &CosmosClient, object_id: &str) -> Result<String, String> {
    let kind = if object_id.starts_with("9-") { "fleet" } else { "struct" };
    let v = client.entity(kind, object_id).await?;
    let cap = if kind == "fleet" { "Fleet" } else { "Struct" };
    Ok(v.get(cap)
        .and_then(|s| s.get("owner"))
        .and_then(|o| o.as_str())
        .unwrap_or_default()
        .to_string())
}

async fn player_of_address(client: &CosmosClient, address: &str) -> Result<String, String> {
    let v = client.lcd_get(&format!("/structs/address/{address}")).await?;
    Ok(v.get("address")
        .and_then(|a| a.get("playerId"))
        .or_else(|| v.get("playerId"))
        .and_then(|p| p.as_str())
        .unwrap_or_default()
        .to_string())
}

/// Tell the room we finished one, and where to verify it.
///
/// Posted by the HELPER. It asks for nothing and proves nothing by itself —
/// the owner's client fetches the transaction and does the proving. That is
/// why announcing is safe to do automatically: the worst a false one can cost
/// its reader is a single failed lookup.
pub async fn announce(work: &crate::hasher::CrewWork, object_id: &str, block_start: u64, tx_hash: &str) {
    if !crate::matrix::work::tx_hash_is_sound(tx_hash) {
        return;
    }
    let Some(c) = crew::all().into_iter().find(|c| c.room_id == work.room_id) else {
        return;
    };
    // The bus, whatever the crew is. A plain link — "my guild", "this
    // friend" — has no room of its own, and before the bus that meant
    // nothing was announced and no credit could be raised; now the receipt
    // pointer goes where every owner is listening.
    let Some((guild_id, room_id)) = crate::matrix::work_bus(&c.guild_id).await.or_else(|| {
        crew::is_matrix_room(&c.room_id).then(|| (c.guild_id.clone(), c.room_id.clone()))
    }) else {
        tlog(
            "crew",
            Sev::Notice,
            format!(
                "finished {object_id} for {} — no bus and {} has no room, so nothing was \
                 announced and no credit will be raised",
                work.owner_player, c.name
            ),
        );
        return;
    };
    let body = format!(
        "Finished {} on {} for {} \u{2014} tx {}",
        work.task.as_str(),
        object_id,
        work.owner_player,
        tx_hash
    );
    let payload = json!({
        "v": 1, "kind": "done",
        "task": work.task.as_str(), "object": object_id,
        "block_start": block_start, "tx": tx_hash,
    });
    if let Err(e) = crate::matrix::post_work(&guild_id, &room_id, &body, payload).await {
        // Not being able to say so does not undo the work: the proof landed,
        // the chain has the receipt, and the owner's client can still find it
        // on its next sweep. Worth a line, not a retry storm.
        tlog("crew", Sev::Notice, format!("could not announce {object_id}: {e}"));
    }
}

// ── Settling ────────────────────────────────────────────────────────────────

/// Pay what is owed, within the caps. Returns what was paid.
pub async fn settle(app: &tauri::AppHandle, room_id: &str) -> Result<Value, String> {
    let Some(c) = crew::get(room_id) else {
        return Err(format!("{room_id} is not a crew here"));
    };
    if SETTLING.swap(true, Ordering::SeqCst) {
        return Err("a settlement is already running".into());
    }
    let result = settle_inner(app, &c.room_id, &c.pay).await;
    SETTLING.store(false, Ordering::SeqCst);
    result
}

/// helper → when to try them again after a payment that could not be made.
static BENCHED: LazyLock<Mutex<std::collections::HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
const BENCH_MS: f64 = 10.0 * 60_000.0;

fn bench(helper: &str) {
    BENCHED.lock().unwrap_or_else(|e| e.into_inner()).insert(helper.to_string(), now_millis() + BENCH_MS);
}

async fn settle_inner(app: &tauri::AppHandle, room_id: &str, pay: &Pay) -> Result<Value, String> {
    resolve_open().await;
    // A helper who cannot be paid right now steps out of the plan, so the
    // budget they would have taken reaches the next one.
    let now = now_millis();
    let benched: Vec<String> = {
        let mut b = BENCHED.lock().unwrap_or_else(|e| e.into_inner());
        b.retain(|_, until| *until > now);
        b.keys().cloned().collect()
    };
    let mut all = credits();
    all.retain(|c| !benched.contains(&c.helper_player));
    let made = payments();
    let plan = payable(&all, &made, pay, room_id, now);
    if plan.is_empty() {
        return Ok(json!({ "paid": [], "spent_this_epoch": spent_this_epoch(&all, &made, room_id, pay.epoch_secs, now) }));
    }

    let mut paid: Vec<Value> = Vec::new();
    for s in plan {
        // The destination is decided HERE, from the chain, and from a player
        // id — never from the address that appeared in the receipt and never
        // from anything in a message.
        let to = match crate::matrix::resolve_payable(&s.helper_player).await {
            Ok(v) => v.get("to").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
            Err(e) => {
                tlog("crew", Sev::Notice, format!("cannot pay {}: {e}", s.helper_player));
                bench(&s.helper_player);
                continue;
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        open_payment(Payment {
            id: id.clone(),
            ts_ms: now_millis(),
            room_id: room_id.to_string(),
            helper_player: s.helper_player.clone(),
            to: to.clone(),
            denom: s.denom.clone(),
            amount_base: s.amount_base,
            parts: s.parts.clone(),
            state: PaymentState::Open,
            tx: None,
            note: String::new(),
        })?;
        match crate::mcp::tools::board_pages::mcp_transfer_execute_impl(
            app.clone(),
            None, // the primary pays: a crew is the player's own, not a worker's
            to.clone(),
            s.denom.clone(),
            s.amount_base,
        )
        .await
        {
            Ok(v) => {
                // Accepted is not the same as landed: in the async sign modes
                // this is the mempool. The chain's record settles it.
                let tx = v.get("tx").and_then(|h| h.as_str()).filter(|h| !h.is_empty()).map(str::to_string);
                match &tx {
                    Some(_) => note_payment(&id, tx.clone(), "sent"),
                    None => confirm_payment(&id, None),
                }
                tlog(
                    "crew",
                    Sev::Info,
                    format!("paid {} {} {} for {} proofs", s.helper_player, s.amount_base, s.denom, s.parts.len()),
                );
                paid.push(json!({
                    "helper": s.helper_player, "amount": s.amount_base,
                    "denom": s.denom, "credits": s.parts.len(),
                    "capped": s.capped, "tx": tx,
                }));
            }
            Err(e) if definitely_unsent(&e) => {
                drop_payment(&id);
                bench(&s.helper_player);
                tlog("crew", Sev::Notice, format!("payment to {} refused: {e}", s.helper_player));
            }
            // It may have gone. It is held, counted against the caps, and
            // looked for on the chain; it is never sent again on a guess.
            Err(e) => {
                note_payment(&id, tx_hash_in(&e), &e);
                tlog("crew", Sev::Warn, format!("payment to {} unconfirmed, held: {e}", s.helper_player));
            }
        }
    }
    resolve_open().await;
    let (all, made) = (credits(), payments());
    Ok(json!({ "paid": paid, "spent_this_epoch": spent_this_epoch(&all, &made, room_id, pay.epoch_secs, now_millis()) }))
}

/// Did this failure happen before anything could reach the chain, or did the
/// chain itself refuse it? Everything else — a timeout, a bridge that went
/// quiet, an HTTP error mid-broadcast — leaves the outcome unknown.
fn definitely_unsent(err: &str) -> bool {
    err.starts_with("refused:") || crate::mcp::tx_retry::was_skipped(err)
}

/// The transaction hash an error names, if it names one.
fn tx_hash_in(err: &str) -> Option<String> {
    err.split(|c: char| !c.is_ascii_hexdigit())
        .find(|w| w.len() == 64)
        .map(|w| w.to_uppercase())
}

/// A payment nobody can find this long after it was signed was never
/// included: its account sequence has been used by later transactions.
const GIVE_UP_MS: f64 = 60.0 * 60_000.0;

/// Ask the chain what became of each open payment.
async fn resolve_open() {
    let open: Vec<Payment> = payments().into_iter().filter(|p| p.state == PaymentState::Open).collect();
    for p in open {
        let found = match &p.tx {
            Some(tx) => crate::mcp::native_signer::tx_outcome(tx).await.map(|o| o.map(|code| (code, tx.clone()))),
            None => find_send(&p).await.map(|o| o.map(|tx| (0, tx))),
        };
        match found {
            Ok(Some((0, tx))) => confirm_payment(&p.id, Some(tx)),
            Ok(Some((code, tx))) => {
                drop_payment(&p.id);
                tlog("crew", Sev::Notice, format!("payment to {} failed on chain (code {code}, {tx}); still owed", p.helper_player));
            }
            Ok(None) if now_millis() - p.ts_ms > GIVE_UP_MS => {
                drop_payment(&p.id);
                tlog("crew", Sev::Notice, format!("payment to {} never reached the chain; still owed", p.helper_player));
            }
            // Not there yet, or could not look: hold.
            Ok(None) => {}
            Err(e) => tlog("crew", Sev::Debug, format!("could not check the payment to {}: {e}", p.helper_player)),
        }
    }
}

/// An open payment with no hash (the signing round-trip never answered): look
/// for the send itself among the device key's recent transactions.
async fn find_send(p: &Payment) -> Result<Option<String>, String> {
    let signer = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| g.wallet_address.clone())
        .filter(|a| !a.is_empty())
        .ok_or("no wallet address yet")?;
    let v = CosmosClient::new()
        .lcd_get(&format!(
            "/cosmos/tx/v1beta1/txs?query=message.sender%3D%27{signer}%27&order_by=ORDER_BY_DESC&limit=100"
        ))
        .await?;
    let rows = v.get("tx_responses").and_then(|r| r.as_array()).ok_or("no tx_responses in the answer")?;
    // Hashes already claimed by another payment are not this one's.
    let known: Vec<String> = payments().into_iter().filter(|q| q.id != p.id).filter_map(|q| q.tx).collect();
    match match_send(rows, p, &known) {
        Some(tx) => Ok(Some(tx)),
        // "Absent" needs the page to reach back past the signing; otherwise
        // the send may simply be on the next one.
        None if covers(rows, p.ts_ms) => Ok(None),
        None => Err("the recent transactions do not reach back far enough".into()),
    }
}

fn tx_time(row: &Value) -> Option<f64> {
    row.get("timestamp").and_then(|t| t.as_str()).and_then(crate::mcp::onboarding::parse_ts).map(|t| t as f64)
}

fn covers(rows: &[Value], since: f64) -> bool {
    rows.len() < 100 || rows.iter().filter_map(tx_time).any(|t| t < since)
}

/// The hash of a successful vault send of exactly this payment, at or after it
/// was written down (a minute's slack for clocks).
fn match_send(rows: &[Value], p: &Payment, known: &[String]) -> Option<String> {
    let want = format!("{}", p.amount_base.round() as i128);
    rows.iter()
        .filter(|r| r.get("code").and_then(|c| c.as_i64()) == Some(0))
        .filter(|r| tx_time(r).is_some_and(|t| t >= p.ts_ms - 60_000.0))
        .find_map(|r| {
            let hash = r.get("txhash").and_then(|h| h.as_str())?;
            if known.iter().any(|k| k.eq_ignore_ascii_case(hash)) {
                return None;
            }
            let msgs = r.pointer("/tx/body/messages").and_then(|m| m.as_array())?;
            msgs.iter()
                .any(|m| {
                    let to = |k: &str, want: &str| m.get(k).and_then(|x| x.as_str()) == Some(want);
                    (to("recipientOwnerId", &p.helper_player) || to("recipientOwnerId", &p.to) || to("toAddress", &p.to))
                        && m.pointer("/amount/0/denom").and_then(|x| x.as_str()) == Some(p.denom.as_str())
                        && m.pointer("/amount/0/amount").and_then(|x| x.as_str()) == Some(want.as_str())
                })
                .then(|| hash.to_uppercase())
        })
}

/// Settle every crew whose epoch has come round. Rides the sync tick.
pub async fn tick(app: &tauri::AppHandle, force: bool) {
    let now = now_millis();
    if !force {
        if let Ok(mut last) = LAST_RUN.lock() {
            if now - *last < 60_000.0 {
                return;
            }
            *last = now;
        }
    }
    for c in crew::all() {
        if !c.pay.enabled {
            continue;
        }
        if let Err(e) = settle(app, &c.room_id).await {
            tlog("crew", Sev::Notice, format!("settling {}: {e}", c.name));
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The ledger, and what it would pay right now.
#[tauri::command]
pub fn crew_ledger(room_id: Option<String>) -> Result<Value, String> {
    let all = credits();
    let rows: Vec<&Credit> = match room_id.as_deref() {
        Some(r) => all.iter().filter(|c| c.room_id == r).collect(),
        None => all.iter().collect(),
    };
    let owed: f64 = rows.iter().map(|c| c.owed()).sum();
    let plan = room_id
        .as_deref()
        .and_then(crew::get)
        .map(|c| {
            let (made, now) = (payments(), now_millis());
            let spent = spent_this_epoch(&all, &made, &c.room_id, c.pay.epoch_secs, now);
            (payable(&all, &made, &c.pay, &c.room_id, now), spent)
        })
        .unwrap_or((Vec::new(), 0.0));
    Ok(json!({
        "credits": rows,
        "owed_base": owed,
        "plan": plan.0,
        "spent_this_epoch": plan.1,
        "unconfirmed": payments()
            .into_iter()
            .filter(|p| p.state == PaymentState::Open && room_id.as_deref().is_none_or(|r| r == p.room_id))
            .collect::<Vec<_>>(),
    }))
}

/// Pay now, by hand. The same path the loop takes, including every cap.
#[tauri::command]
pub async fn crew_settle(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    room_id: String,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    settle(&app, &room_id).await
}

/// Verify a crewmate's claim and credit it. Reading a transaction costs
/// nothing and moves nothing, so this is not window-gated; paying is.
#[tauri::command]
pub async fn crew_claim(
    room_id: String,
    tx_hash: String,
    object_id: String,
) -> Result<Value, String> {
    let credited = absorb_claim(&room_id, &tx_hash, &object_id).await?;
    Ok(json!({ "ok": true, "credited": credited }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credit(id: &str, helper: &str, amount: f64, ts: f64) -> Credit {
        Credit {
            id: id.into(),
            ts_ms: ts,
            room_id: "!crew:example.org".into(),
            helper_player: helper.into(),
            object_id: "5-2184".into(),
            category: "mine".into(),
            difficulty: 6,
            tx_hash: "A".repeat(64),
            amount_base: amount,
            denom: "ualpha".into(),
            settled_at: None,
            settle_tx: None,
            paid_base: 0.0,
        }
    }

    fn pay(rate: f64, epoch_cap: f64, per_helper: f64) -> Pay {
        Pay {
            enabled: true,
            denom: "ualpha".into(),
            rate_per_difficulty: rate,
            epoch_secs: 3600,
            epoch_cap,
            per_helper_cap: per_helper,
            min_payout: 0.0,
        }
    }

    const ROOM: &str = "!crew:example.org";
    const NOW: f64 = 100_000_000.0;

    fn payment(id: &str, helper: &str, amount: f64, ts: f64, state: PaymentState) -> Payment {
        Payment {
            id: id.into(),
            ts_ms: ts,
            room_id: ROOM.into(),
            helper_player: helper.into(),
            to: helper.into(),
            denom: "ualpha".into(),
            amount_base: amount,
            parts: vec![],
            state,
            tx: None,
            note: String::new(),
        }
    }

    /// The detail arrives as one JSON-encoded attribute. This is the shape the
    /// current chain serves, and every number in it is a string.
    #[test]
    fn a_receipt_is_read_from_the_nested_detail() {
        let tx = json!({ "tx_response": { "events": [
            { "type": "message", "attributes": [] },
            { "type": "structs.structs.EventHashSuccess", "attributes": [
                { "key": "eventHashSuccessDetail",
                  "value": "{\"callerAddress\":\"structs1helper\",\"category\":\"mine\",\"difficulty\":\"9\",\"objectId\":\"5-2184\",\"planetId\":\"2-223\"}" }
            ]}
        ]}});
        assert_eq!(
            parse_receipts(&tx),
            vec![Receipt {
                caller_address: "structs1helper".into(),
                category: "mine".into(),
                difficulty: 9,
                object_id: "5-2184".into(),
            }]
        );
    }

    /// The exact payload the live chain served for tx
    /// `CFB90E64...C30FF2` (a MINE completion, 2026-09-10), copied verbatim.
    ///
    /// Hand-written fixtures test the parser against what somebody THOUGHT the
    /// chain sends. This one tests it against what the chain actually sent,
    /// including the two details that would otherwise be guesses: the whole
    /// detail rides in ONE attribute as a JSON string, and every number inside
    /// it is a string. Both are how the ledger reads difficulty, which is what
    /// the rate multiplies.
    #[test]
    fn the_live_chains_own_receipt_parses() {
        let tx = json!({ "tx_response": { "code": 0, "events": [
            { "type": "message", "attributes": [
                { "key": "action", "value": "/structs.structs.MsgStructOreMinerComplete", "index": true }
            ]},
            { "type": "structs.structs.EventHashSuccess", "attributes": [
                { "key": "eventHashSuccessDetail",
                  "value": "{\"callerAddress\":\"structs1xcutd0hd72ytxrmpzwdywxguedamddqmy4ll2h\",\"category\":\"mine\",\"difficulty\":\"5\",\"objectId\":\"5-259727\",\"planetId\":\"\"}",
                  "index": true },
                { "key": "msg_index", "value": "0", "index": true }
            ]}
        ]}});
        assert_eq!(
            parse_receipts(&tx),
            vec![Receipt {
                caller_address: "structs1xcutd0hd72ytxrmpzwdywxguedamddqmy4ll2h".into(),
                category: "mine".into(),
                difficulty: 5,
                object_id: "5-259727".into(),
            }]
        );
    }

    /// Older nodes flatten typed events into one attribute per field. A parser
    /// that only knew the other shape would find no receipts and silently pay
    /// nobody — a failure with no error message anywhere.
    #[test]
    fn a_receipt_is_also_read_from_flat_attributes() {
        let tx = json!({ "events": [
            { "type": "structs.structs.EventHashSuccess", "attributes": [
                { "key": "callerAddress", "value": "\"structs1helper\"" },
                { "key": "category", "value": "\"refine\"" },
                { "key": "difficulty", "value": "\"4\"" },
                { "key": "objectId", "value": "\"5-99\"" }
            ]}
        ]});
        let got = parse_receipts(&tx);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].difficulty, 4);
        assert_eq!(got[0].object_id, "5-99");
    }

    /// Terms are another player's JSON: a rate must be a finite non-negative
    /// number, a denom must look like one, and anything else is not shown.
    #[test]
    fn terms_off_the_bus_are_read_strictly() {
        let ok = json!({ "v": 1, "enabled": true, "denom": "ualpha", "rate_per_difficulty": 10.0,
                         "epoch_cap": 500.0, "per_helper_cap": 200.0 });
        let t = parse_terms(&ok).expect("terms");
        assert!(t.enabled && t.rate_per_difficulty == 10.0 && t.denom == "ualpha");
        assert!(parse_terms(&json!({ "v": 2, "denom": "ualpha" })).is_none(), "unknown version");
        assert!(parse_terms(&json!({ "v": 1, "denom": "ualpha", "rate_per_difficulty": -1 })).is_none(), "negative");
        let words = parse_terms(&json!({ "v": 1, "denom": "ualpha", "rate_per_difficulty": "lots" })).unwrap();
        assert_eq!(words.rate_per_difficulty, 0.0, "a rate that is not a number pays nothing");
        assert!(parse_terms(&json!({ "v": 1, "denom": "<b>x</b>" })).is_none(), "a denom is not markup");
        assert!(parse_terms(&json!({ "v": 1 })).is_none(), "no denom, no terms");
        // Nothing published may be a float: Matrix canonical JSON forbids it.
        fn no_floats(v: &Value) -> bool {
            match v {
                Value::Number(n) => n.is_i64() || n.is_u64(),
                Value::Array(a) => a.iter().all(no_floats),
                Value::Object(o) => o.values().all(no_floats),
                _ => true,
            }
        }
        let mut p = Pay::default();
        p.rate_per_difficulty = 12.5;
        assert!(no_floats(&terms_of(&p)), "{}", terms_of(&p));
        assert_eq!(parse_terms(&terms_of(&p)).unwrap().rate_per_difficulty, 12.5, "and the string reads back exactly");
        assert_eq!(parse_terms(&json!({ "v": 1, "denom": "ualpha", "rate_per_difficulty": 7 })).unwrap().rate_per_difficulty, 7.0, "a bare number still reads");
        // Published terms round-trip, and "on at zero" publishes as off.
        let mut pay = Pay::default();
        pay.enabled = true;
        assert_eq!(parse_terms(&terms_of(&pay)).unwrap().enabled, false);
        pay.rate_per_difficulty = 3.0;
        assert!(parse_terms(&terms_of(&pay)).unwrap().enabled);
        // Only a user-keyed state event is anyone's word.
        note_terms_on_bus("not-a-user", &ok);
        note_terms_on_bus("@1-999999:h", &ok);
        assert!(TERMS_ON_BUS.read().unwrap().contains_key("@1-999999:h"));
        assert!(!TERMS_ON_BUS.read().unwrap().contains_key("not-a-user"));
    }

    #[test]
    fn a_transaction_with_no_completion_credits_nothing() {
        assert!(parse_receipts(&json!({ "tx_response": { "events": [] } })).is_empty());
        assert!(parse_receipts(&json!({})).is_empty());
        // An event of the right type but missing the fields that identify the
        // work is not a receipt.
        let tx = json!({ "events": [
            { "type": "structs.structs.EventHashSuccess", "attributes": [
                { "key": "category", "value": "\"mine\"" }
            ]}
        ]});
        assert!(parse_receipts(&tx).is_empty());
    }

    #[test]
    fn the_rate_multiplies_the_difficulty() {
        let cs = vec![credit("a", "1-61", 90.0, 1.0)];
        let p = pay(10.0, 0.0, 0.0);
        let plan = payable(&cs, &[], &p, ROOM, NOW);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].amount_base, 90.0);
        assert!(!plan[0].capped);
    }

    #[test]
    fn payment_is_off_until_it_is_turned_on() {
        let cs = vec![credit("a", "1-61", 90.0, 1.0)];
        let mut p = pay(10.0, 0.0, 0.0);
        p.enabled = false;
        assert!(payable(&cs, &[], &p, ROOM, NOW).is_empty());
        // ...and a rate of zero pays nothing even when enabled.
        assert!(payable(&cs, &[], &pay(0.0, 0.0, 0.0), ROOM, NOW).is_empty());
    }

    /// Below the floor a debt waits; at it, it is paid whole. A floor above
    /// the per-helper cap collapses to the cap, or a capped helper would
    /// never be paid at all.
    #[test]
    fn a_payout_waits_for_the_floor_then_batches() {
        let mut terms = pay(1.0, 0.0, 0.0);
        terms.min_payout = 100.0;
        let small = vec![credit("a", "1-61", 40.0, 1.0), credit("b", "1-61", 30.0, 2.0)];
        assert!(payable(&small, &[], &terms, ROOM, NOW).is_empty(), "70 owed, floor 100: waits");
        let enough = vec![credit("a", "1-61", 40.0, 1.0), credit("b", "1-61", 30.0, 2.0), credit("c", "1-61", 50.0, 3.0)];
        let plan = payable(&enough, &[], &terms, ROOM, NOW);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].amount_base, 120.0, "paid whole, in one transaction");
        assert_eq!(plan[0].parts.len(), 3);
        // Floor 100 but a cap of 50: the floor is the cap.
        let mut capped = terms.clone();
        capped.per_helper_cap = 50.0;
        let plan = payable(&enough, &[], &capped, ROOM, NOW);
        assert_eq!(plan.len(), 1, "a floor the cap cannot reach still pays");
        assert_eq!(plan[0].amount_base, 50.0);
        // Published and read back.
        assert_eq!(parse_terms(&terms_of(&terms)).unwrap().min_payout, 100.0);
    }

    /// Settle `plan` into the ledger the way a landed payment does.
    fn land(l: &mut Ledger, plan: Vec<Settlement>, now: f64) {
        for s in plan {
            let id = format!("p{}", l.payments.len());
            let mut p = payment(&id, &s.helper_player, s.amount_base, now, PaymentState::Open);
            p.parts = s.parts;
            l.payments.push(p);
            confirm_in(l, &id, Some("T".into()), now);
        }
    }

    /// The bug this ledger was rebuilt around: a credit bigger than the cap
    /// was paid the cap, marked nothing, counted nothing, and was paid the cap
    /// again a minute later, forever.
    #[test]
    fn a_capped_payment_is_made_once_an_epoch_until_the_debt_is_gone() {
        let terms = pay(1.0, 0.0, 100.0);
        let mut l = Ledger { credits: vec![credit("a", "1-61", 250.0, 1.0)], ..Default::default() };
        let plan = payable(&l.credits, &l.payments, &terms, ROOM, NOW);
        assert_eq!(plan[0].amount_base, 100.0);
        assert!(plan[0].capped);
        assert_eq!(plan[0].parts, vec![("a".to_string(), 100.0)]);
        land(&mut l, plan, NOW);
        assert_eq!(l.credits[0].owed(), 150.0, "and the rest stays owed");
        assert!(payable(&l.credits, &l.payments, &terms, ROOM, NOW + 60_000.0).is_empty(), "a minute later: capped");
        // Two more epochs finish it, and it is never paid past what was owed.
        let mut now = NOW;
        for want in [100.0, 50.0] {
            now += 3_600_001.0;
            let plan = payable(&l.credits, &l.payments, &terms, ROOM, now);
            assert_eq!(plan[0].amount_base, want);
            land(&mut l, plan, now);
        }
        assert!(l.credits[0].settled_at.is_some());
        assert!(payable(&l.credits, &l.payments, &terms, ROOM, now + 3_600_001.0).is_empty());
        assert_eq!(l.payments.iter().map(|p| p.amount_base).sum::<f64>(), 250.0);
    }

    /// A payment whose outcome is unknown is neither free nor made again.
    #[test]
    fn an_unconfirmed_payment_is_held() {
        let terms = pay(1.0, 100.0, 0.0);
        let cs = vec![credit("a", "1-61", 80.0, 1.0), credit("b", "1-62", 80.0, 2.0)];
        let mut open = payment("p", "1-61", 80.0, NOW, PaymentState::Open);
        open.parts = vec![("a".into(), 80.0)];
        let plan = payable(&cs, &[open.clone()], &terms, ROOM, NOW + 60_000.0);
        assert_eq!(plan.len(), 1);
        assert_eq!((plan[0].helper_player.as_str(), plan[0].amount_base), ("1-62", 20.0), "its budget stays spent");
        // However old it is: only the chain's answer releases it.
        let plan = payable(&cs, &[open], &terms, ROOM, NOW + 86_400_000.0);
        assert!(plan.iter().all(|s| s.helper_player != "1-61"));
    }

    #[test]
    fn only_a_definite_refusal_releases_a_payment() {
        assert!(definitely_unsent("refused: not enough ualpha"));
        assert!(definitely_unsent("skipped by a mandate: cap reached"));
        assert!(!definitely_unsent("virtual-player op 'sign' timed out after 60s"));
        assert!(!definitely_unsent("broadcast HTTP error: connection reset"));
        let h = "44AD4FC1C9E3FF1B51195575027DEF7249A70EB6F0C4995E1952DC9B3DBE7468";
        let e = format!("Resource not found. Original: Transaction with ID {h} was submitted but was not yet found");
        assert!(!definitely_unsent(&e));
        assert_eq!(tx_hash_in(&e).as_deref(), Some(h));
        assert_eq!(tx_hash_in("timed out"), None);
    }

    /// The send is matched on who, what and when — never on amount alone.
    #[test]
    fn an_unanswered_payment_is_found_by_its_own_send() {
        let t0 = crate::mcp::onboarding::parse_ts("2026-11-24T21:07:00Z").unwrap() as f64;
        let p = payment("p", "1-61", 80.0, t0, PaymentState::Open);
        let row = |hash: &str, to: &str, amt: &str, at: &str, code: i64| {
            json!({ "txhash": hash, "timestamp": at, "code": code, "tx": { "body": { "messages": [
                { "@type": "/structs.structs.MsgVaultSend", "ownerId": "1-194", "recipientOwnerId": to,
                  "amount": [{ "denom": "ualpha", "amount": amt }] } ] } } })
        };
        let after = "2026-11-24T21:07:13Z";
        assert_eq!(match_send(&[row("AA", "1-61", "80", after, 0)], &p, &[]).as_deref(), Some("AA"));
        assert_eq!(match_send(&[row("AA", "1-61", "80", after, 0)], &p, &["aa".into()]), None, "another payment's");
        assert_eq!(match_send(&[row("AA", "1-610", "80", after, 0)], &p, &[]), None);
        assert_eq!(match_send(&[row("AA", "1-61", "800", after, 0)], &p, &[]), None);
        assert_eq!(match_send(&[row("AA", "1-61", "80", after, 5)], &p, &[]), None, "failed on chain");
        assert_eq!(match_send(&[row("AA", "1-61", "80", "2026-11-24T20:00:00Z", 0)], &p, &[]), None, "an earlier payment");
        // "Not there" needs a page that reaches back past the signing.
        assert!(covers(&[row("AA", "1-9", "1", after, 0)], t0), "a short page is the whole history");
        let full: Vec<Value> = (0..100).map(|i| row(&format!("{i}"), "1-9", "1", after, 0)).collect();
        assert!(!covers(&full, t0));
    }

    #[test]
    fn an_old_proof_cannot_be_billed() {
        let now = crate::mcp::onboarding::parse_ts("2026-11-24T21:07:00Z").unwrap() as f64;
        let at = |t: &str| json!({ "tx_response": { "timestamp": t } });
        assert!(recent_enough(&at("2026-11-20T00:00:00Z"), now));
        assert!(!recent_enough(&at("2026-10-01T00:00:00Z"), now));
        assert!(!recent_enough(&json!({}), now));
    }

    #[test]
    fn the_epoch_cap_bounds_everyone_together() {
        let cs = vec![
            credit("a", "1-61", 80.0, 1.0),
            credit("b", "1-62", 80.0, 2.0),
        ];
        let plan = payable(&cs, &[], &pay(1.0, 100.0, 0.0), ROOM, NOW);
        let total: f64 = plan.iter().map(|s| s.amount_base).sum();
        assert_eq!(total, 100.0, "the cap is the cap, however many helpers there are");
    }

    #[test]
    fn a_spent_epoch_pays_nothing_more() {
        let cs = vec![credit("a", "1-61", 80.0, 1.0)];
        let made = [payment("p", "1-62", 100.0, NOW, PaymentState::Paid)];
        assert!(payable(&cs, &made, &pay(1.0, 100.0, 0.0), ROOM, NOW).is_empty());
        assert_eq!(payable(&cs, &made, &pay(1.0, 100.0, 0.0), ROOM, NOW + 3_600_001.0).len(), 1, "the next one does");
    }

    /// Settlement must be idempotent: a credit already paid is never paid
    /// again, whatever else happens in the ledger.
    #[test]
    fn settled_credits_are_never_paid_twice() {
        let mut c = credit("a", "1-61", 50.0, 1.0);
        c.settled_at = Some(now_millis());
        let plan = payable(&[c], &[], &pay(1.0, 0.0, 0.0), ROOM, NOW);
        assert!(plan.is_empty());
    }

    #[test]
    fn another_crews_credits_are_not_this_crews_bill() {
        let mut c = credit("a", "1-61", 50.0, 1.0);
        c.room_id = "!other:example.org".into();
        assert!(payable(&[c], &[], &pay(1.0, 0.0, 0.0), ROOM, NOW).is_empty());
    }

    /// A crew paying in a guild token must not settle debts denominated in
    /// Alpha, and the reverse — the denom is part of what was promised.
    #[test]
    fn a_credit_in_another_denom_is_left_alone() {
        let mut c = credit("a", "1-61", 50.0, 1.0);
        c.denom = "uguild.0-1".into();
        assert!(payable(&[c], &[], &pay(1.0, 0.0, 0.0), ROOM, NOW).is_empty());
    }

    #[test]
    fn fractions_of_a_base_unit_are_not_paid() {
        let cs = vec![credit("a", "1-61", 0.4, 1.0)];
        assert!(payable(&cs, &[], &pay(1.0, 0.0, 0.0), ROOM, NOW).is_empty());
    }

    /// Credits settled before payments were recorded still count.
    #[test]
    fn the_epoch_counts_payments_and_older_settlements() {
        let now = 1_000_000_000.0;
        let mut fresh = credit("a", "1-61", 40.0, now);
        fresh.settled_at = Some(now - 1_000.0);
        let mut old = credit("b", "1-61", 40.0, now);
        old.settled_at = Some(now - 10_000_000.0);
        let unsettled = credit("c", "1-61", 40.0, now);
        let made = [payment("p", "1-62", 7.0, now - 1_000.0, PaymentState::Paid), payment("q", "1-62", 9.0, now - 10_000_000.0, PaymentState::Paid)];
        let cs = [fresh, old, unsettled];
        assert_eq!(spent_this_epoch(&cs, &made, ROOM, 3600, now), 47.0);
        assert_eq!(spent_on(&cs, &made, ROOM, "1-62", 3600, now), 7.0);
    }

    #[test]
    fn a_credit_recorded_twice_is_credited_once() {
        let c = credit("dup-test-unique", "1-61", 10.0, 1.0);
        assert!(record(c.clone()).unwrap());
        assert!(!record(c).unwrap());
        assert_eq!(credits().iter().filter(|x| x.id == "dup-test-unique").count(), 1);
    }
}

/// Pick the crew announcements out of a batch of new messages and verify each.
///
/// Called from the sync loop with everything that arrived, because a claim has
/// to be noticed by the person who owes for it — the helper cannot make us
/// look, and a chat window that happens to be closed must not be the reason
/// somebody goes unpaid.
///
/// Every frame is checked independently and against the chain. A room full of
/// invented hashes costs one failed lookup each and credits nothing.
pub fn absorb_done_frames(room_id: &str, messages: &[crate::matrix::client::Message]) {
    let me = crate::mcp::crew::primary_player().unwrap_or_default();
    let now = now_millis() as u64;
    for m in messages {
        if m.is_self {
            continue; // our own announcement is not a bill we owe ourselves
        }
        let Some(w) = m.work.as_ref() else { continue };
        if w.get("kind").and_then(|k| k.as_str()) != Some("done") {
            continue;
        }
        // The launch backlog again: an old `done` was credited before the
        // restart (the ledger is on disk and idempotent) or counted on the
        // helper's card in a session that is over. Neither wants a tx fetch.
        if !crate::mcp::crew_submit::fresh_enough(m.ts, now) {
            continue;
        }
        let (Some(tx), Some(object)) = (
            w.get("tx").and_then(|t| t.as_str()).map(str::to_string),
            w.get("object").and_then(|o| o.as_str()).map(str::to_string),
        ) else {
            continue;
        };
        /* Somebody spent a proof WE computed. Not a bill — we did the work
         * and they paid the transaction — but it is the only way the
         * reporting path ever reads as "finished" on this machine, and a
         * helper whose card says 0 forever concludes the feature is broken. */
        if !me.is_empty() && w.get("helper").and_then(|h| h.as_str()) == Some(me.as_str()) {
            let owner = crate::matrix::directory::player_id_of(&m.sender).unwrap_or_default();
            crate::mcp::crew_work::note_finished_by_owner(&owner, &object);
            tlog("crew", Sev::Info, format!("{owner} finished {object} from our proof: {tx}"));
            continue;
        }
        let room = room_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = absorb_claim(&room, &tx, &object).await {
                tlog("crew", Sev::Notice, format!("claim for {object} not credited: {e}"));
            }
        });
    }
}
