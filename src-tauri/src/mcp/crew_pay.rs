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
//!     `matrix::resolve_payable`), never from the message and never even from
//!     the address in the receipt — a message must not be able to name where
//!     money goes, and that rule does not get an exception because the feature
//!     is convenient;
//!   * every payment goes through `mcp_transfer_execute_impl`, which re-runs
//!     its own preview and `send_guard::validate_send` server-side. The chain
//!     does NOT validate `MsgPlayerSend.toAddress`; a malformed one is a
//!     silent burn, not a rejection.
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ledger {
    #[serde(default)]
    pub credits: Vec<Credit>,
}

static LEDGER: LazyLock<RwLock<Ledger>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));
static SETTLING: AtomicBool = AtomicBool::new(false);
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

fn save(l: &Ledger) {
    crate::mcp::config_store::save_config(FILENAME, l);
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
    let cutoff = now_millis() - KEEP_SETTLED_MS;
    l.credits.retain(|c| c.settled_at.map(|t| t > cutoff).unwrap_or(true));
    save(&l);
    Ok(true)
}

fn mark_settled(ids: &[String], tx: Option<String>) {
    if let Ok(mut l) = LEDGER.write() {
        let now = now_millis();
        for c in l.credits.iter_mut() {
            if ids.contains(&c.id) {
                c.settled_at = Some(now);
                c.settle_tx = tx.clone();
            }
        }
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
    /// The credits this settlement discharges, so marking them is exact.
    pub credit_ids: Vec<String>,
    /// Set when a cap cut the payment short — the card says so rather than
    /// quietly paying less than the ledger shows.
    pub capped: bool,
}

/// What this crew should pay right now, given its caps.
///
/// Pure, because it is the arithmetic that decides how much money leaves the
/// wallet and that should be provable without a chain, a wallet or a clock.
///
/// `already_spent` is what the crew has paid inside the current epoch. Both
/// caps are ceilings, never targets: hitting one stops the payment at the cap
/// and leaves the rest owed, which is the honest behaviour — the alternative
/// is a loop that decides a cap means "pay this much".
pub fn payable(credits: &[Credit], pay: &Pay, room_id: &str, already_spent: f64) -> Vec<Settlement> {
    if !pay.enabled || pay.rate_per_difficulty <= 0.0 {
        return Vec::new();
    }
    let mut budget = if pay.epoch_cap > 0.0 {
        (pay.epoch_cap - already_spent).max(0.0)
    } else {
        f64::INFINITY
    };
    if budget <= 0.0 {
        return Vec::new();
    }

    // Deterministic order so two runs of the same ledger pay the same people
    // in the same order when the budget is short.
    let mut helpers: Vec<String> = credits
        .iter()
        .filter(|c| c.settled_at.is_none() && c.room_id == room_id && c.denom == pay.denom)
        .map(|c| c.helper_player.clone())
        .collect();
    helpers.sort();
    helpers.dedup();

    let mut out = Vec::new();
    for helper in helpers {
        let mine: Vec<&Credit> = credits
            .iter()
            .filter(|c| {
                c.settled_at.is_none()
                    && c.room_id == room_id
                    && c.denom == pay.denom
                    && c.helper_player == helper
            })
            .collect();
        let owed: f64 = mine.iter().map(|c| c.amount_base).sum();
        if owed <= 0.0 {
            continue;
        }
        let mut amount = owed;
        let mut capped = false;
        if pay.per_helper_cap > 0.0 && amount > pay.per_helper_cap {
            amount = pay.per_helper_cap;
            capped = true;
        }
        if amount > budget {
            amount = budget;
            capped = true;
        }
        // Base units are integers on the wire; paying a fraction of one is a
        // rounding error looking for somewhere to happen.
        amount = amount.floor();
        if amount < 1.0 {
            continue;
        }
        budget -= amount;
        out.push(Settlement {
            helper_player: helper,
            amount_base: amount,
            denom: pay.denom.clone(),
            // A capped payment still discharges the credits it covers, oldest
            // first, and leaves the remainder owed.
            credit_ids: cover(&mine, amount),
            capped,
        });
        if budget <= 0.0 {
            break;
        }
    }
    out
}

/// The oldest credits an amount fully covers.
///
/// Partial credits are deliberately NOT discharged: a half-paid credit that
/// looks settled is how somebody ends up permanently owed the other half.
fn cover(credits: &[&Credit], amount: f64) -> Vec<String> {
    let mut sorted: Vec<&&Credit> = credits.iter().collect();
    sorted.sort_by(|a, b| a.ts_ms.total_cmp(&b.ts_ms).then_with(|| a.id.cmp(&b.id)));
    let mut left = amount;
    let mut ids = Vec::new();
    for c in sorted {
        if c.amount_base > left {
            break;
        }
        left -= c.amount_base;
        ids.push(c.id.clone());
    }
    ids
}

/// What this crew has already paid inside the current epoch.
pub fn spent_this_epoch(credits: &[Credit], room_id: &str, epoch_secs: u64, now: f64) -> f64 {
    let since = now - (epoch_secs as f64) * 1000.0;
    credits
        .iter()
        .filter(|c| c.room_id == room_id && c.settled_at.map(|t| t >= since).unwrap_or(false))
        .map(|c| c.amount_base)
        .sum()
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
    let Some(c) = crew::get(room_id) else {
        return Ok(None); // not a crew of ours; nothing to owe
    };
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

    let amount = (c.pay.rate_per_difficulty * r.difficulty as f64).max(0.0);
    let credit = Credit {
        id: format!("{}|{}", tx_hash.to_uppercase(), r.object_id),
        ts_ms: now_millis(),
        room_id: room_id.to_string(),
        helper_player: helper,
        object_id: r.object_id.clone(),
        category: r.category.clone(),
        difficulty: r.difficulty,
        tx_hash: tx_hash.to_uppercase(),
        amount_base: amount,
        denom: c.pay.denom.clone(),
        settled_at: None,
        settle_tx: None,
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
        return Ok(Some(credit));
    }
    Ok(None)
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
    if let Err(e) = crate::matrix::post_work(&c.guild_id, &c.room_id, &body, payload).await {
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

async fn settle_inner(app: &tauri::AppHandle, room_id: &str, pay: &Pay) -> Result<Value, String> {
    let all = credits();
    let spent = spent_this_epoch(&all, room_id, pay.epoch_secs, now_millis());
    let plan = payable(&all, pay, room_id, spent);
    if plan.is_empty() {
        return Ok(json!({ "paid": [], "spent_this_epoch": spent }));
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
                continue;
            }
        };
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
                let tx = v
                    .get("result")
                    .and_then(|r| r.get("transactionHash").or_else(|| r.get("txhash")))
                    .and_then(|h| h.as_str())
                    .map(str::to_string);
                // Only now. A credit marked settled before the send returns is
                // a payment nobody will ever make again.
                mark_settled(&s.credit_ids, tx.clone());
                tlog(
                    "crew",
                    Sev::Info,
                    format!("paid {} {} {} for {} proofs", s.helper_player, s.amount_base, s.denom, s.credit_ids.len()),
                );
                paid.push(json!({
                    "helper": s.helper_player, "amount": s.amount_base,
                    "denom": s.denom, "credits": s.credit_ids.len(),
                    "capped": s.capped, "tx": tx,
                }));
            }
            Err(e) => tlog(
                "crew",
                Sev::Notice,
                format!("payment to {} refused: {e}", s.helper_player),
            ),
        }
    }
    Ok(json!({ "paid": paid, "spent_this_epoch": spent }))
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
    let owed: f64 = rows.iter().filter(|c| c.settled_at.is_none()).map(|c| c.amount_base).sum();
    let plan = room_id
        .as_deref()
        .and_then(crew::get)
        .map(|c| {
            let spent = spent_this_epoch(&all, &c.room_id, c.pay.epoch_secs, now_millis());
            (payable(&all, &c.pay, &c.room_id, spent), spent)
        })
        .unwrap_or((Vec::new(), 0.0));
    Ok(json!({
        "credits": rows,
        "owed_base": owed,
        "plan": plan.0,
        "spent_this_epoch": plan.1,
    }))
}

/// Pay now, by hand. The same path the loop takes, including every cap.
#[tauri::command]
pub async fn crew_settle(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    room_id: String,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
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
        }
    }

    const ROOM: &str = "!crew:example.org";

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
        let plan = payable(&cs, &p, ROOM, 0.0);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].amount_base, 90.0);
        assert!(!plan[0].capped);
    }

    #[test]
    fn payment_is_off_until_it_is_turned_on() {
        let cs = vec![credit("a", "1-61", 90.0, 1.0)];
        let mut p = pay(10.0, 0.0, 0.0);
        p.enabled = false;
        assert!(payable(&cs, &p, ROOM, 0.0).is_empty());
        // ...and a rate of zero pays nothing even when enabled.
        assert!(payable(&cs, &pay(0.0, 0.0, 0.0), ROOM, 0.0).is_empty());
    }

    #[test]
    fn the_per_helper_cap_is_a_ceiling() {
        let cs = vec![credit("a", "1-61", 500.0, 1.0)];
        let plan = payable(&cs, &pay(1.0, 0.0, 100.0), ROOM, 0.0);
        assert_eq!(plan[0].amount_base, 100.0);
        assert!(plan[0].capped);
        // A capped payment must not pretend to discharge the whole debt.
        assert!(plan[0].credit_ids.is_empty(), "500 owed, 100 paid: nothing is fully covered");
    }

    #[test]
    fn the_epoch_cap_bounds_everyone_together() {
        let cs = vec![
            credit("a", "1-61", 80.0, 1.0),
            credit("b", "1-62", 80.0, 2.0),
        ];
        let plan = payable(&cs, &pay(1.0, 100.0, 0.0), ROOM, 0.0);
        let total: f64 = plan.iter().map(|s| s.amount_base).sum();
        assert_eq!(total, 100.0, "the cap is the cap, however many helpers there are");
    }

    #[test]
    fn a_spent_epoch_pays_nothing_more() {
        let cs = vec![credit("a", "1-61", 80.0, 1.0)];
        assert!(payable(&cs, &pay(1.0, 100.0, 0.0), ROOM, 100.0).is_empty());
    }

    /// Settlement must be idempotent: a credit already paid is never paid
    /// again, whatever else happens in the ledger.
    #[test]
    fn settled_credits_are_never_paid_twice() {
        let mut c = credit("a", "1-61", 50.0, 1.0);
        c.settled_at = Some(now_millis());
        let plan = payable(&[c], &pay(1.0, 0.0, 0.0), ROOM, 0.0);
        assert!(plan.is_empty());
    }

    #[test]
    fn another_crews_credits_are_not_this_crews_bill() {
        let mut c = credit("a", "1-61", 50.0, 1.0);
        c.room_id = "!other:example.org".into();
        assert!(payable(&[c], &pay(1.0, 0.0, 0.0), ROOM, 0.0).is_empty());
    }

    /// A crew paying in a guild token must not settle debts denominated in
    /// Alpha, and the reverse — the denom is part of what was promised.
    #[test]
    fn a_credit_in_another_denom_is_left_alone() {
        let mut c = credit("a", "1-61", 50.0, 1.0);
        c.denom = "uguild.0-1".into();
        assert!(payable(&[c], &pay(1.0, 0.0, 0.0), ROOM, 0.0).is_empty());
    }

    #[test]
    fn fractions_of_a_base_unit_are_not_paid() {
        let cs = vec![credit("a", "1-61", 0.4, 1.0)];
        assert!(payable(&cs, &pay(1.0, 0.0, 0.0), ROOM, 0.0).is_empty());
    }

    #[test]
    fn cover_discharges_whole_credits_oldest_first() {
        let a = credit("a", "1-61", 30.0, 1.0);
        let b = credit("b", "1-61", 30.0, 2.0);
        let c = credit("c", "1-61", 30.0, 3.0);
        let refs: Vec<&Credit> = vec![&a, &b, &c];
        assert_eq!(cover(&refs, 65.0), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(cover(&refs, 20.0), Vec::<String>::new());
    }

    #[test]
    fn only_settled_credits_count_against_the_epoch() {
        let now = 1_000_000.0;
        let mut fresh = credit("a", "1-61", 40.0, now);
        fresh.settled_at = Some(now - 1_000.0);
        let mut old = credit("b", "1-61", 40.0, now);
        old.settled_at = Some(now - 10_000_000.0);
        let unsettled = credit("c", "1-61", 40.0, now);
        let spent = spent_this_epoch(&[fresh, old, unsettled], ROOM, 3600, now);
        assert_eq!(spent, 40.0);
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
    if crew::get(room_id).is_none() {
        return; // not a crew of ours
    }
    for m in messages {
        if m.is_self {
            continue; // our own announcement is not a bill we owe ourselves
        }
        let Some(w) = m.work.as_ref() else { continue };
        if w.get("kind").and_then(|k| k.as_str()) != Some("done") {
            continue;
        }
        let (Some(tx), Some(object)) = (
            w.get("tx").and_then(|t| t.as_str()).map(str::to_string),
            w.get("object").and_then(|o| o.as_str()).map(str::to_string),
        ) else {
            continue;
        };
        let room = room_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = absorb_claim(&room, &tx, &object).await {
                tlog("crew", Sev::Notice, format!("claim for {object} not credited: {e}"));
            }
        });
    }
}
