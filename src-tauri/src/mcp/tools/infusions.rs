//! Tauri commands backing Team Ops → Industry → **Infusions**.
//!
//! An allocation ROUTES capacity you already have. An infusion CREATES it: you
//! stake Alpha into a reactor and the chain credits you `power × (1 −
//! commission)` of personal `capacity` forever after. Everything on this page
//! follows from four facts that the raw messages do not tell you:
//!
//!  1. **A reactor is a validator.** `MsgReactorInfuse` is a delegation,
//!     `MsgReactorDefuse` an undelegation, `MsgReactorBeginMigration` a
//!     redelegation. So the in-flight state of a removal or a move lives in the
//!     staking module, not in the Infusion record — which carries a `defusing`
//!     total but neither the creation height `MsgReactorCancelDefusion` needs
//!     nor the completion time. Both are read here from `/cosmos/staking/...`.
//!
//!  2. **`ratio` is the reactor's health, and it can be 0.** A jailed or
//!     unbonded validator produces ZERO energy from its infusions; the fuel
//!     stays staked and earns nothing until someone unjails it (and
//!     `MsgReactorRestart` resyncs a reactor whose validator came back below
//!     the active-set cutoff). Four of the galaxy's 42 infusions sit at ratio 0
//!     today, so this is the first thing the page has to show.
//!
//!  3. **Defusing removes capacity IMMEDIATELY and returns the Alpha in four
//!     days.** If that capacity was carrying allocations, the chain brownouts
//!     and DESTROYS them in creation order. Every removal is therefore measured
//!     against the holder's live load before it is signed — the same guard
//!     `power_change_refusal` gives allocations, from the other direction.
//!
//!  4. **Generator infusions are one-way.** `destinationType: "struct"` rows
//!     convert at 2–10 kW/g instead of ~1, but there is no defuse message and a
//!     destroyed generator takes the Alpha with it. They are listed, never
//!     acted on here.
//!
//! Signing goes through the vplayer façade at the holder's own HD index (index
//! 0 derives the primary's key), exactly as `auto_infuse` has done in
//! production — none of these messages is on the primary tx bridge. The signer
//! address is re-derived and compared to the infusion's `address` before any
//! removal or move: an infusion record is keyed by ADDRESS, so signing with the
//! wrong key silently acts on the wrong stake.

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::loop_util::parse_f64 as num;
use crate::mcp::tools::board_pages::require_board;

/// 1 gram of Alpha = 1e6 ualpha, and `ReactorFuelToEnergyConversion = 1`, so a
/// gram of fuel at ratio 1 is 1e6 mW = 1 kW of power before commission.
const UALPHA_PER_GRAM: f64 = 1_000_000.0;
const MW_PER_KW: f64 = 1_000_000.0;

// ── Pure helpers (unit-tested; these are the rules, not the plumbing) ────────

/// What an infusion of `power_mw` at `commission` credits to the INFUSER.
/// The remainder is the reactor's. Verified against live player 1-194:
/// 13,318,001,349 × 0.96 = 12,785,281,295 of its 144,201,281,295 capacity, the
/// rest being a ratio-2 generator infusion at zero commission.
pub fn capacity_gain_mw(power_mw: f64, commission: f64) -> f64 {
    (power_mw * (1.0 - commission)).floor().max(0.0)
}

/// Power an infusion of `fuel_ualpha` would produce at this reactor's `ratio`.
pub fn power_of(fuel_ualpha: f64, ratio: f64) -> f64 {
    fuel_ualpha * ratio
}

/// Why a DEFUSE (or the outbound half of a migration to a dead reactor) must
/// not be signed.
///
/// `capacity_mw`/`load_mw` are the holder's live grid figures. Load here is
/// what the player has allocated OUT — the chain compares exactly those two
/// when it decides to brownout an object and tear down its allocations in
/// creation order, so this is the same arithmetic from the losing side.
pub fn defuse_refusal(
    defuse_ualpha: f64,
    row_fuel_ualpha: f64,
    row_defusing_ualpha: f64,
    capacity_lost_mw: f64,
    capacity_mw: f64,
    load_mw: f64,
) -> Option<String> {
    if !defuse_ualpha.is_finite() || defuse_ualpha <= 0.0 {
        return Some("amount must be more than zero".into());
    }
    let removable = (row_fuel_ualpha - row_defusing_ualpha).max(0.0);
    if defuse_ualpha > removable {
        return Some(format!(
            "only {:.4} g is still removable here ({:.4} g staked, {:.4} g already defusing)",
            removable / UALPHA_PER_GRAM,
            row_fuel_ualpha / UALPHA_PER_GRAM,
            row_defusing_ualpha / UALPHA_PER_GRAM
        ));
    }
    let projected = capacity_mw - capacity_lost_mw;
    if load_mw > projected {
        return Some(format!(
            "that removes {:.2} kW of capacity, leaving {:.2} kW against {:.2} kW of allocated load. \
             The chain brownouts an object whose load exceeds its capacity and DESTROYS its \
             allocations in creation order — lower your allocations first, or defuse less.",
            capacity_lost_mw / MW_PER_KW,
            projected / MW_PER_KW,
            load_mw / MW_PER_KW
        ));
    }
    None
}

/// Why an INFUSE must not be signed. Infusing only ever RAISES capacity, so
/// there is no brownout case here — the only hard stop is the wallet.
pub fn infuse_refusal(infuse_ualpha: f64, balance_ualpha: f64) -> Option<String> {
    if !infuse_ualpha.is_finite() || infuse_ualpha <= 0.0 {
        return Some("amount must be more than zero".into());
    }
    if infuse_ualpha > balance_ualpha {
        return Some(format!(
            "that is {:.4} g but this player holds {:.4} g of liquid Alpha",
            infuse_ualpha / UALPHA_PER_GRAM,
            balance_ualpha / UALPHA_PER_GRAM
        ));
    }
    None
}

/// The staking module caps concurrent unbonding/redelegation entries per
/// (delegator, validator) pair at `max_entries`. Past the cap the chain rejects
/// the message outright, and the operator's only option is to wait one out.
pub fn entries_refusal(in_flight: usize, max_entries: u64, what: &str) -> Option<String> {
    if max_entries > 0 && in_flight as u64 >= max_entries {
        return Some(format!(
            "{in_flight} {what} are already in flight against this reactor and the chain allows \
             {max_entries} — wait for one to complete first"
        ));
    }
    None
}

/// Seconds until an RFC3339 completion time, clamped at 0. `None` when the
/// timestamp is missing or unparseable — the row still renders, without an ETA.
pub fn eta_secs(completion_time: Option<&str>, now_ms: f64) -> Option<i64> {
    let t = completion_time?;
    let parsed = chrono::DateTime::parse_from_rfc3339(t).ok()?;
    Some(((parsed.timestamp_millis() as f64 - now_ms) / 1000.0).max(0.0) as i64)
}

// ── Identity: which addresses are ours, and at which HD index ────────────────

#[derive(Debug, Clone)]
struct Holder {
    player_id: String,
    name: String,
    address: String,
    /// HD index off the shared mnemonic. 0 is the primary.
    index: u32,
}

/// Every address this operator can sign for: the primary at HD index 0, plus
/// every registered virtual player. Keyed by address — an infusion record has
/// no owner field beyond `address`/`playerId`, and the ADDRESS is what the
/// staking module keys on.
fn our_holders() -> Vec<Holder> {
    let mut out: Vec<Holder> = Vec::new();
    if let Ok(gs) = crate::game_state::GAME_STATE.read() {
        let pid = gs.player_id.clone().unwrap_or_default();
        let addr = gs.wallet_address.clone().unwrap_or_default();
        if !pid.is_empty() && !addr.is_empty() {
            let name = crate::mcp::roster_cache::get_row(&pid)
                .map(|r| r.name)
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "primary".into());
            out.push(Holder { player_id: pid, name, address: addr, index: 0 });
        }
    }
    if let Ok(reg) = crate::mcp::virtual_players::REGISTRY.read() {
        for p in &reg.players {
            if p.address.is_empty() {
                continue;
            }
            out.push(Holder {
                player_id: p.player_id.clone().unwrap_or_default(),
                name: p.name.clone(),
                address: p.address.clone(),
                index: p.index,
            });
        }
    }
    out
}

fn holder_for(address: &str) -> Option<Holder> {
    our_holders().into_iter().find(|h| h.address == address)
}

// ── Chain reads ─────────────────────────────────────────────────────────────

/// Every infusion on the chain. One paged scan: there are a few dozen galaxy
/// wide, and there is no by-address LCD endpoint to narrow it with.
async fn all_infusions(client: &CosmosClient) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut key: Option<String> = None;
    for _ in 0..20 {
        let page = client.list_entities("infusion", key.as_deref(), Some(500)).await?;
        if let Some(items) = page.get("Infusion").and_then(|v| v.as_array()) {
            out.extend(items.iter().cloned());
        }
        key = page
            .get("pagination")
            .and_then(|p| p.get("next_key"))
            .and_then(|k| k.as_str())
            .filter(|k| !k.is_empty())
            .map(String::from);
        if key.is_none() {
            break;
        }
    }
    Ok(out)
}

/// Reactors indexed both ways — the page needs id → validator (to sign) and
/// validator → id (to name the validator an unbonding entry points at).
struct Reactors {
    rows: Vec<Value>,
}

impl Reactors {
    fn by_id(&self, id: &str) -> Option<&Value> {
        self.rows.iter().find(|r| r.get("id").and_then(|v| v.as_str()) == Some(id))
    }
    fn by_validator(&self, validator: &str) -> Option<&Value> {
        self.rows
            .iter()
            .find(|r| r.get("validator").and_then(|v| v.as_str()) == Some(validator))
    }
}

async fn reactors(client: &CosmosClient) -> Reactors {
    let rows = client
        .list_entities("reactor", None, Some(500))
        .await
        .ok()
        .and_then(|v| v.get("Reactor").and_then(|r| r.as_array()).cloned())
        .unwrap_or_default();
    Reactors { rows }
}

/// Validator health, keyed by operator address. `jailed` (or any non-bonded
/// status) is what drives an infusion's `ratio` to zero.
async fn validators(client: &CosmosClient) -> std::collections::HashMap<String, Value> {
    let mut out = std::collections::HashMap::new();
    let Ok(v) = client
        .lcd_get("/cosmos/staking/v1beta1/validators?pagination.limit=500")
        .await
    else {
        return out;
    };
    for val in v.get("validators").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let Some(op) = val.get("operator_address").and_then(|x| x.as_str()) else {
            continue;
        };
        out.insert(
            op.to_string(),
            json!({
                "moniker": val.pointer("/description/moniker").and_then(|x| x.as_str()).unwrap_or(""),
                "jailed": val.get("jailed").and_then(|x| x.as_bool()).unwrap_or(false),
                "status": val.get("status").and_then(|x| x.as_str()).unwrap_or(""),
                "tokens": num(val.get("tokens")),
                "stake_commission": num(val.pointer("/commission/commission_rates/rate")),
            }),
        );
    }
    out
}

/// `unbonding_time` (the defusion cooldown) and `max_entries` (how many
/// removals or moves may be in flight at once against one reactor).
async fn staking_params(client: &CosmosClient) -> (f64, u64) {
    match client.lcd_get("/cosmos/staking/v1beta1/params").await {
        Ok(v) => {
            let secs = v
                .pointer("/params/unbonding_time")
                .and_then(|x| x.as_str())
                .map(|s| s.trim_end_matches('s').parse::<f64>().unwrap_or(0.0))
                .unwrap_or(0.0);
            let entries = v
                .pointer("/params/max_entries")
                .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(7);
            (secs, entries)
        }
        Err(_) => (0.0, 7),
    }
}

/// In-flight defusions for one address, as `(validator, amount, creation_height)`.
async fn unbonding_for(client: &CosmosClient, address: &str) -> Vec<Value> {
    let path =
        format!("/cosmos/staking/v1beta1/delegators/{address}/unbonding_delegations?pagination.limit=200");
    let Ok(v) = client.lcd_get(&path).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for resp in v
        .get("unbonding_responses")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let validator = resp
            .get("validator_address")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        for e in resp.get("entries").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
            out.push(json!({
                "address": address,
                "validator": validator,
                "amount_ualpha": num(e.get("balance")),
                // int64 as a string, and MsgReactorCancelDefusion needs it
                // EXACTLY — it identifies which entry to re-stake.
                "creation_height": e.get("creation_height").and_then(|x| x.as_str()).unwrap_or("0").to_string(),
                "completion_time": e.get("completion_time").and_then(|x| x.as_str()).unwrap_or(""),
            }));
        }
    }
    out
}

/// In-flight migrations for one address.
async fn redelegations_for(client: &CosmosClient, address: &str) -> Vec<Value> {
    let path =
        format!("/cosmos/staking/v1beta1/delegators/{address}/redelegations?pagination.limit=200");
    let Ok(v) = client.lcd_get(&path).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for resp in v
        .get("redelegation_responses")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let src = resp
            .pointer("/redelegation/validator_src_address")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let dst = resp
            .pointer("/redelegation/validator_dst_address")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        for e in resp.get("entries").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
            out.push(json!({
                "address": address,
                "src_validator": src,
                "dst_validator": dst,
                "amount_ualpha": num(e.pointer("/redelegation_entry/initial_balance")),
                "completion_time": e.pointer("/redelegation_entry/completion_time")
                    .and_then(|x| x.as_str()).unwrap_or(""),
            }));
        }
    }
    out
}

/// The holder's live grid figures — `capacity` is what a defusion eats into and
/// `load` is what brownouts when it goes under.
async fn holder_grid_strict(client: &CosmosClient, pid: &str) -> Result<(f64, f64, f64, f64), String> {
    let p = client
        .query_entity("player", pid)
        .await
        .map_err(|e| format!("could not read {pid}'s power: {e}"))?;
    let ga = p.get("gridAttributes");
    Ok((
        num(ga.and_then(|g| g.get("capacity"))),
        num(ga.and_then(|g| g.get("load"))),
        num(ga.and_then(|g| g.get("structsLoad"))),
        num(ga.and_then(|g| g.get("connectionCapacity"))),
    ))
}

/// Display variant: a stale row is still worth showing. NEVER use this to price
/// a change — zeros here would read as "no capacity, no load", and the brownout
/// guard would then refuse (or worse, allow) for the wrong reason.
async fn holder_grid(client: &CosmosClient, pid: &str) -> (f64, f64, f64, f64) {
    holder_grid_strict(client, pid).await.unwrap_or((0.0, 0.0, 0.0, 0.0))
}

async fn liquid_alpha(client: &CosmosClient, address: &str) -> f64 {
    client
        .bank_balances(address)
        .await
        .ok()
        .and_then(|b| {
            b.into_iter()
                .find(|c| c.get("denom").and_then(|d| d.as_str()) == Some("ualpha"))
                .map(|c| num(c.get("amount")))
        })
        .unwrap_or(0.0)
}

// ── READ: the whole page in one command ─────────────────────────────────────

/// Everything Industry → Infusions renders: our holdings, what is in flight,
/// the reactor directory to infuse into, and who has Alpha to infuse.
#[tauri::command]
pub async fn mcp_infusions() -> Result<Value, String> {
    let client = CosmosClient::new();
    let holders = our_holders();
    if holders.is_empty() {
        return Err("primary identity not synced yet".into());
    }
    let by_address: std::collections::HashMap<String, Holder> =
        holders.iter().map(|h| (h.address.clone(), h.clone())).collect();

    let (rows, reactors, vals, (unbonding_secs, max_entries)) = tokio::join!(
        all_infusions(&client),
        reactors(&client),
        validators(&client),
        staking_params(&client),
    );
    let rows = rows?;

    // Ours only. Addresses are compared WHOLE — never by prefix: bech32 shares
    // a long prefix across every account on the chain.
    let mine: Vec<&Value> = rows
        .iter()
        .filter(|r| {
            r.get("address")
                .and_then(|a| a.as_str())
                .map(|a| by_address.contains_key(a))
                .unwrap_or(false)
        })
        .collect();

    // Grid figures for the players that actually hold something — this is the
    // budget every removal is measured against, so it is read live rather than
    // taken from the roster cache.
    let holder_pids: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        mine.iter()
            .filter_map(|r| r.get("playerId").and_then(|v| v.as_str()).map(String::from))
            .filter(|p| !p.is_empty() && seen.insert(p.clone()))
            .collect()
    };
    let c = client.clone();
    let grids: std::collections::HashMap<String, (f64, f64, f64, f64)> =
        crate::mcp::loop_util::map_concurrent(holder_pids.clone(), 6, move |pid| {
            let c = c.clone();
            async move {
                let g = holder_grid(&c, &pid).await;
                (pid, g)
            }
        })
        .await
        .into_iter()
        .collect();

    // Generator destinations need a name and a "still alive?" — a destroyed
    // generator took its Alpha with it, and that is the only place the loss
    // shows. Only a handful of rows, so one read each.
    let gen_ids: Vec<String> = mine
        .iter()
        .filter(|r| r.get("destinationType").and_then(|v| v.as_str()) == Some("struct"))
        .filter_map(|r| r.get("destinationId").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let c = client.clone();
    let gens: std::collections::HashMap<String, Value> =
        crate::mcp::loop_util::map_concurrent(gen_ids, 6, move |id| {
            let c = c.clone();
            async move {
                let v = match c.query_entity("struct", &id).await {
                    Ok(s) => {
                        let type_id = s.pointer("/Struct/type").and_then(|x| x.as_str()).unwrap_or("");
                        let name = c
                            .query_entity("struct_type", type_id)
                            .await
                            .ok()
                            .and_then(|t| {
                                t.pointer("/StructType/type").and_then(|x| x.as_str()).map(String::from)
                            })
                            .unwrap_or_else(|| format!("type {type_id}"));
                        json!({
                            "name": name,
                            "destroyed": s.pointer("/structAttributes/isDestroyed")
                                .and_then(|x| x.as_bool()).unwrap_or(false),
                            "online": s.pointer("/structAttributes/isOnline")
                                .and_then(|x| x.as_bool()).unwrap_or(false),
                            "location_id": s.pointer("/Struct/locationId")
                                .and_then(|x| x.as_str()).unwrap_or(""),
                        })
                    }
                    Err(e) => json!({ "name": "unreadable", "err": e.to_string() }),
                };
                (id, v)
            }
        })
        .await
        .into_iter()
        .collect();

    // In-flight state, per holding ADDRESS (staking keys on the address, and a
    // defusion is invisible in the Infusion record beyond a `defusing` total).
    let flight_addrs: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        mine.iter()
            .filter_map(|r| r.get("address").and_then(|v| v.as_str()).map(String::from))
            .filter(|a| seen.insert(a.clone()))
            .collect()
    };
    let c = client.clone();
    let flight: Vec<(Vec<Value>, Vec<Value>)> =
        crate::mcp::loop_util::map_concurrent(flight_addrs.clone(), 6, move |addr| {
            let c = c.clone();
            async move {
                let (u, r) = tokio::join!(unbonding_for(&c, &addr), redelegations_for(&c, &addr));
                (u, r)
            }
        })
        .await;

    let now_ms = crate::hasher::types::now_millis();
    let name_of = |addr: &str| -> (String, String, i64) {
        by_address
            .get(addr)
            .map(|h| (h.player_id.clone(), h.name.clone(), h.index as i64))
            .unwrap_or_else(|| (String::new(), addr.to_string(), -1))
    };
    let label_validator = |v: &str| -> (String, String) {
        let rid = reactors
            .by_validator(v)
            .and_then(|r| r.get("id").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        let moniker = vals
            .get(v)
            .and_then(|x| x.get("moniker"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        (rid, moniker)
    };

    let mut pending = Vec::new();
    let mut migrations = Vec::new();
    for (u, r) in flight {
        for e in u {
            let addr = e.get("address").and_then(|x| x.as_str()).unwrap_or("");
            let validator = e.get("validator").and_then(|x| x.as_str()).unwrap_or("");
            let (pid, name, idx) = name_of(addr);
            let (rid, moniker) = label_validator(validator);
            pending.push(json!({
                "address": addr, "player_id": pid, "player_name": name, "hd_index": idx,
                "validator": validator, "reactor_id": rid, "moniker": moniker,
                "amount_ualpha": e.get("amount_ualpha").and_then(|x| x.as_f64()).unwrap_or(0.0),
                "creation_height": e.get("creation_height").and_then(|x| x.as_str()).unwrap_or("0"),
                "completion_time": e.get("completion_time").and_then(|x| x.as_str()).unwrap_or(""),
                "eta_secs": eta_secs(e.get("completion_time").and_then(|x| x.as_str()), now_ms),
            }));
        }
        for e in r {
            let addr = e.get("address").and_then(|x| x.as_str()).unwrap_or("");
            let src = e.get("src_validator").and_then(|x| x.as_str()).unwrap_or("");
            let dst = e.get("dst_validator").and_then(|x| x.as_str()).unwrap_or("");
            let (pid, name, idx) = name_of(addr);
            let (src_rid, src_mon) = label_validator(src);
            let (dst_rid, dst_mon) = label_validator(dst);
            migrations.push(json!({
                "address": addr, "player_id": pid, "player_name": name, "hd_index": idx,
                "src_validator": src, "dst_validator": dst,
                "src_reactor_id": src_rid, "dst_reactor_id": dst_rid,
                "src_moniker": src_mon, "dst_moniker": dst_mon,
                "amount_ualpha": e.get("amount_ualpha").and_then(|x| x.as_f64()).unwrap_or(0.0),
                "completion_time": e.get("completion_time").and_then(|x| x.as_str()).unwrap_or(""),
                "eta_secs": eta_secs(e.get("completion_time").and_then(|x| x.as_str()), now_ms),
            }));
        }
    }

    // ── The holdings themselves ──
    let mut infusions = Vec::new();
    let (mut t_fuel, mut t_power, mut t_defusing, mut t_dead, mut t_commission) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    for r in &mine {
        let dest_type = r.get("destinationType").and_then(|v| v.as_str()).unwrap_or("");
        let dest_id = r.get("destinationId").and_then(|v| v.as_str()).unwrap_or("");
        let address = r.get("address").and_then(|v| v.as_str()).unwrap_or("");
        let fuel = num(r.get("fuel"));
        let power = num(r.get("power"));
        let commission = num(r.get("commission"));
        let ratio = num(r.get("ratio"));
        let defusing = num(r.get("defusing"));
        let (pid, name, idx) = name_of(address);
        let is_reactor = dest_type == "reactor";
        let gain = capacity_gain_mw(power, commission);
        let reactor = if is_reactor { reactors.by_id(dest_id) } else { None };
        let validator = reactor
            .and_then(|x| x.get("validator"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let vinfo = vals.get(&validator);
        let gen = gens.get(dest_id);
        let (cap, load, structs_load, cap_secondary) =
            grids.get(&pid).copied().unwrap_or((0.0, 0.0, 0.0, 0.0));

        t_fuel += fuel;
        t_power += gain;
        t_defusing += defusing;
        t_commission += power - gain;
        if ratio == 0.0 {
            t_dead += fuel;
        }

        infusions.push(json!({
            "key": format!("{dest_id}|{address}"),
            "destination_type": dest_type,
            "destination_id": dest_id,
            "destination_label": if is_reactor {
                let m = vinfo.and_then(|x| x.get("moniker")).and_then(|x| x.as_str()).unwrap_or("");
                if m.is_empty() { dest_id.to_string() } else { format!("{dest_id} · {m}") }
            } else {
                let n = gen.and_then(|g| g.get("name")).and_then(|x| x.as_str()).unwrap_or("generator");
                format!("{dest_id} · {n}")
            },
            "guild_id": reactor.and_then(|x| x.get("guildId")).and_then(|x| x.as_str()).unwrap_or(""),
            "validator": validator,
            "moniker": vinfo.and_then(|x| x.get("moniker")).and_then(|x| x.as_str()).unwrap_or(""),
            "validator_jailed": vinfo.and_then(|x| x.get("jailed")).and_then(|x| x.as_bool()).unwrap_or(false),
            "validator_status": vinfo.and_then(|x| x.get("status")).and_then(|x| x.as_str()).unwrap_or(""),
            "player_id": pid,
            "player_name": name,
            "hd_index": idx,
            "address": address,
            "fuel_ualpha": fuel,
            "power_mw": power,
            "capacity_mw": gain,
            "commission": commission,
            "commission_mw": power - gain,
            "ratio": ratio,
            "defusing_ualpha": defusing,
            // ratio 0 = the validator is jailed or unbonded: this fuel is
            // staked and producing nothing at all.
            "dead": ratio == 0.0,
            // Generator infusions have no defuse message and no migration.
            "reversible": is_reactor,
            "destroyed": gen.and_then(|g| g.get("destroyed")).and_then(|x| x.as_bool()).unwrap_or(false),
            "holder_grid": {
                "capacity_mw": cap, "load_mw": load,
                "structs_load_mw": structs_load, "capacity_secondary_mw": cap_secondary,
                "allocatable_mw": (cap - load).max(0.0),
            },
        }));
    }
    // Biggest stake first, dead ones ahead of everything: a ratio-0 row is
    // Alpha earning literally nothing and it is the action to take today.
    infusions.sort_by(|a, b| {
        let dead = |v: &Value| v.get("dead").and_then(|x| x.as_bool()).unwrap_or(false);
        dead(b)
            .cmp(&dead(a))
            .then(
                num(b.get("fuel_ualpha"))
                    .partial_cmp(&num(a.get("fuel_ualpha")))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    // ── The reactor directory (every legal infusion destination) ──
    let mut our_stake: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut infuser_count: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();
    for r in &rows {
        let Some(d) = r.get("destinationId").and_then(|v| v.as_str()) else { continue };
        *infuser_count.entry(d.to_string()).or_insert(0) += 1;
        if r.get("address")
            .and_then(|a| a.as_str())
            .map(|a| by_address.contains_key(a))
            .unwrap_or(false)
        {
            *our_stake.entry(d.to_string()).or_insert(0.0) += num(r.get("fuel"));
        }
    }
    let guild_id = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| g.guild_id.clone())
        .unwrap_or_default();
    let mut reactor_rows: Vec<Value> = reactors
        .rows
        .iter()
        .map(|r| {
            let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let validator = r.get("validator").and_then(|v| v.as_str()).unwrap_or("");
            let vinfo = vals.get(validator);
            json!({
                "id": id,
                "validator": validator,
                "guild_id": r.get("guildId").and_then(|v| v.as_str()).unwrap_or(""),
                "is_our_guild": r.get("guildId").and_then(|v| v.as_str()) == Some(guild_id.as_str()),
                "commission": num(r.get("defaultCommission")),
                "moniker": vinfo.and_then(|x| x.get("moniker")).and_then(|x| x.as_str()).unwrap_or(""),
                "jailed": vinfo.and_then(|x| x.get("jailed")).and_then(|x| x.as_bool()).unwrap_or(false),
                "status": vinfo.and_then(|x| x.get("status")).and_then(|x| x.as_str()).unwrap_or(""),
                "stake_commission": vinfo.map(|x| num(x.get("stake_commission"))).unwrap_or(0.0),
                "our_fuel_ualpha": our_stake.get(id).copied().unwrap_or(0.0),
                "infusers": infuser_count.get(id).copied().unwrap_or(0),
            })
        })
        .collect();
    // Our guild's reactor first, then the cheapest commission — that ordering
    // IS the advice ("infuse your guild's reactor; pick the lowest commission").
    reactor_rows.sort_by(|a, b| {
        let ours = |v: &Value| v.get("is_our_guild").and_then(|x| x.as_bool()).unwrap_or(false);
        ours(b)
            .cmp(&ours(a))
            .then(
                num(a.get("commission"))
                    .partial_cmp(&num(b.get("commission")))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    // ── Who could infuse: roster players holding liquid Alpha ──
    // The roster cache already carries per-player Alpha, so this costs nothing.
    // Joined to the registry for the address + HD index we would sign with.
    let mut candidates: Vec<Value> = Vec::new();
    for h in &holders {
        if h.player_id.is_empty() {
            continue;
        }
        let row = crate::mcp::roster_cache::get_row(&h.player_id);
        let alpha = row.as_ref().map(|r| r.alpha_ualpha).unwrap_or(0.0);
        if alpha <= 0.0 && h.index != 0 {
            continue;
        }
        candidates.push(json!({
            "player_id": h.player_id,
            "name": h.name,
            "address": h.address,
            "hd_index": h.index,
            "alpha_ualpha": alpha,
            "capacity_mw": row.as_ref().map(|r| r.capacity).unwrap_or(0.0),
            "load_mw": row.as_ref().map(|r| r.load).unwrap_or(0.0),
        }));
    }
    candidates.sort_by(|a, b| {
        num(b.get("alpha_ualpha"))
            .partial_cmp(&num(a.get("alpha_ualpha")))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(50);

    let cfg = crate::mcp::auto_infuse::get();
    Ok(json!({
        "player_id": holders[0].player_id,
        "address": holders[0].address,
        "guild_id": guild_id,
        "infusions": infusions,
        "pending": pending,
        "migrations": migrations,
        "reactors": reactor_rows,
        "candidates": candidates,
        "totals": {
            "fuel_ualpha": t_fuel,
            "capacity_mw": t_power,
            "commission_mw": t_commission,
            "defusing_ualpha": t_defusing,
            "dead_fuel_ualpha": t_dead,
            "holders": flight_addrs.len(),
        },
        "unbonding_secs": unbonding_secs,
        "max_entries": max_entries,
        // The auto-rule that already infuses the primary's excess, so the page
        // can say why Alpha keeps leaving the wallet on its own.
        "auto_infuse": { "enabled": cfg.enabled, "keep_grams": cfg.keep_grams,
                         "interval_secs": cfg.interval_secs },
        "ualpha_per_gram": UALPHA_PER_GRAM,
    }))
}

// ── PREVIEW: what a change does, and why it would be refused ────────────────

/// Dry-run one infuse / defuse / migrate. ALWAYS called before the writer, and
/// the writer re-runs it, so a stale page cannot slip a bad amount past.
///
/// `op` is "infuse" | "defuse" | "migrate"; `destination_id` is the reactor
/// acted on and `target_id` the migration destination.
#[tauri::command]
pub async fn mcp_infusion_preview(
    op: String,
    address: String,
    destination_id: String,
    target_id: Option<String>,
    amount_ualpha: f64,
) -> Result<Value, String> {
    let client = CosmosClient::new();
    let holder = holder_for(&address)
        .ok_or_else(|| format!("{address} is not one of this operator's addresses"))?;
    let reactors = reactors(&client).await;
    let vals = validators(&client).await;
    let (unbonding_secs, max_entries) = staking_params(&client).await;

    let reactor = reactors
        .by_id(&destination_id)
        .ok_or_else(|| format!("no reactor {destination_id}"))?
        .clone();
    let validator = reactor.get("validator").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let commission = num(reactor.get("defaultCommission"));

    // The existing holding at this destination, if any — `ratio` is only known
    // from a live infusion, so a first infusion into a reactor is priced at the
    // reactor's own health instead.
    let existing = client
        .query_entity("infusion", &format!("{destination_id}/{address}"))
        .await
        .ok()
        .and_then(|v| v.get("Infusion").cloned());
    let row_fuel = existing.as_ref().map(|r| num(r.get("fuel"))).unwrap_or(0.0);
    let row_defusing = existing.as_ref().map(|r| num(r.get("defusing"))).unwrap_or(0.0);
    let row_commission = existing
        .as_ref()
        .map(|r| num(r.get("commission")))
        .unwrap_or(commission);
    let ratio = existing.as_ref().map(|r| num(r.get("ratio"))).unwrap_or(1.0);

    let vinfo = vals.get(&validator);
    let jailed = vinfo.and_then(|x| x.get("jailed")).and_then(|x| x.as_bool()).unwrap_or(false);
    let status = vinfo
        .and_then(|x| x.get("status"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let bonded = status == "BOND_STATUS_BONDED";

    // Strict: every refusal below is arithmetic against these four numbers, so
    // a failed read must stop the preview rather than quietly become zeros.
    let (capacity, load, structs_load, cap_secondary) =
        holder_grid_strict(&client, &holder.player_id).await?;
    let mut warnings: Vec<String> = Vec::new();
    let mut facts = json!({});
    let refusal: Option<String>;

    match op.as_str() {
        "infuse" => {
            let balance = liquid_alpha(&client, &address).await;
            refusal = infuse_refusal(amount_ualpha, balance);
            // A first infusion into a reactor whose validator is down produces
            // nothing at all until it is unjailed — that is not a refusal (the
            // Alpha is recoverable) but it IS the whole decision.
            if jailed || !bonded {
                warnings.push(format!(
                    "reactor {destination_id}'s validator is {} — infusions there produce ZERO \
                     energy until it is back in the active set",
                    if jailed { "JAILED".to_string() } else { format!("{status} (not bonded)") }
                ));
            }
            if ratio == 0.0 && existing.is_some() {
                warnings.push(
                    "your existing infusion here is already at ratio 0 (earning nothing)".into(),
                );
            }
            // The honest rate, not the nominal one. An existing holding already
            // knows its ratio (0 if the validator is down); a first infusion is
            // priced at 1 into a healthy reactor and at 0 into a dead one —
            // promising ~96% of a jailed reactor's fuel back as capacity would
            // be the page telling the exact lie it exists to prevent.
            let effective_ratio = match (&existing, jailed || !bonded) {
                (Some(_), _) => ratio,
                (None, false) => 1.0,
                (None, true) => 0.0,
            };
            let power = power_of(amount_ualpha, effective_ratio);
            let gained = capacity_gain_mw(power, commission);
            facts = json!({
                "balance_ualpha": balance,
                "balance_after_ualpha": (balance - amount_ualpha).max(0.0),
                "gained_mw": gained,
                "ratio": effective_ratio,
                "commission_mw": power - gained,
                "commission": commission,
                "capacity_mw": capacity,
                "capacity_after_mw": capacity + gained,
                "load_mw": load,
                "headroom_after_mw": (capacity + gained - load).max(0.0),
                "online_after": (load + structs_load) <= (capacity + gained + cap_secondary),
            });
        }
        "defuse" => {
            // The capacity that leaves is the share this fuel was crediting —
            // its OWN locked commission, which may differ from the reactor's
            // current default.
            let lost = capacity_gain_mw(power_of(amount_ualpha, ratio), row_commission);
            refusal = if existing.is_none() {
                Some(format!("no infusion from {address} into {destination_id}"))
            } else {
                match defuse_refusal(amount_ualpha, row_fuel, row_defusing, lost, capacity, load) {
                    Some(why) => Some(why),
                    None => {
                        let in_flight = unbonding_for(&client, &address)
                            .await
                            .iter()
                            .filter(|e| {
                                e.get("validator").and_then(|x| x.as_str()) == Some(&validator)
                            })
                            .count();
                        entries_refusal(in_flight, max_entries, "defusions")
                    }
                }
            };
            if ratio == 0.0 {
                warnings.push(
                    "this infusion is at ratio 0, so defusing costs you no capacity — it is \
                     already producing nothing"
                        .into(),
                );
            }
            facts = json!({
                "staked_ualpha": row_fuel,
                "already_defusing_ualpha": row_defusing,
                "capacity_lost_mw": lost,
                "capacity_mw": capacity,
                "capacity_after_mw": (capacity - lost).max(0.0),
                "load_mw": load,
                "headroom_after_mw": capacity - lost - load,
                "online_after": (load + structs_load) <= (capacity - lost + cap_secondary),
                "cooldown_secs": unbonding_secs,
            });
        }
        "migrate" => {
            let to_id = target_id.clone().unwrap_or_default();
            let to = reactors
                .by_id(&to_id)
                .ok_or_else(|| format!("no reactor {to_id}"))?
                .clone();
            let to_validator = to.get("validator").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let to_commission = num(to.get("defaultCommission"));
            let to_info = vals.get(&to_validator);
            let to_jailed =
                to_info.and_then(|x| x.get("jailed")).and_then(|x| x.as_bool()).unwrap_or(false);
            let to_status = to_info
                .and_then(|x| x.get("status"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let to_ratio = if to_jailed || to_status != "BOND_STATUS_BONDED" { 0.0 } else { 1.0 };
            let lost = capacity_gain_mw(power_of(amount_ualpha, ratio), row_commission);
            let gained = capacity_gain_mw(power_of(amount_ualpha, to_ratio), to_commission);

            refusal = if existing.is_none() {
                Some(format!("no infusion from {address} into {destination_id}"))
            } else if to_id == destination_id {
                Some("source and destination reactor are the same".into())
            } else if amount_ualpha <= 0.0 {
                Some("amount must be more than zero".into())
            } else if amount_ualpha > (row_fuel - row_defusing).max(0.0) {
                Some(format!(
                    "only {:.4} g is movable here ({:.4} g staked, {:.4} g already defusing)",
                    (row_fuel - row_defusing).max(0.0) / UALPHA_PER_GRAM,
                    row_fuel / UALPHA_PER_GRAM,
                    row_defusing / UALPHA_PER_GRAM
                ))
            } else {
                // A migration is a swap, so it only brownouts when the
                // destination is worth LESS than the source (a dead validator,
                // or a fatter commission).
                let net = gained - lost;
                if net < 0.0 && load > capacity + net {
                    Some(format!(
                        "that destination pays {:.2} kW less than the source, leaving {:.2} kW \
                         against {:.2} kW of allocated load — the chain would brownout and \
                         DESTROY your allocations in creation order",
                        -net / MW_PER_KW,
                        (capacity + net) / MW_PER_KW,
                        load / MW_PER_KW
                    ))
                } else {
                    let in_flight = redelegations_for(&client, &address)
                        .await
                        .iter()
                        .filter(|e| {
                            e.get("dst_validator").and_then(|x| x.as_str()) == Some(&to_validator)
                        })
                        .count();
                    entries_refusal(in_flight, max_entries, "migrations")
                }
            };
            if to_jailed || to_status != "BOND_STATUS_BONDED" {
                warnings.push(format!(
                    "reactor {to_id}'s validator is {} — moving there produces ZERO energy until \
                     it is back in the active set",
                    if to_jailed { "JAILED".to_string() } else { to_status.clone() }
                ));
            }
            if to_commission > row_commission {
                warnings.push(format!(
                    "commission rises from {:.1}% to {:.1}% on the moved fuel",
                    row_commission * 100.0,
                    to_commission * 100.0
                ));
            }
            facts = json!({
                "staked_ualpha": row_fuel,
                "from_reactor": destination_id, "to_reactor": to_id,
                "from_commission": row_commission, "to_commission": to_commission,
                "capacity_lost_mw": lost, "capacity_gained_mw": gained,
                "net_mw": gained - lost,
                "capacity_mw": capacity,
                "capacity_after_mw": (capacity - lost + gained).max(0.0),
                "load_mw": load,
                "headroom_after_mw": capacity - lost + gained - load,
                "cooldown_secs": unbonding_secs,
            });
        }
        other => return Err(format!("unknown op '{other}' (infuse, defuse or migrate)")),
    }

    // Permission check on the holder's own player object. A player owns itself,
    // so this normally passes — it fails on a delegated or restricted account,
    // and the chain's rejection ("unauthorized") says nothing about which bit.
    if let Ok(mask) = client.permission_value(&holder.player_id, &holder.player_id).await {
        let bit = match op.as_str() {
            "infuse" => 5u64,   // PermTokenInfuse
            "migrate" => 6,     // PermTokenMigrate
            _ => 7,             // PermTokenDefuse
        };
        if mask != 0 && mask & (1 << bit) == 0 {
            warnings.push(format!(
                "{} does not hold Perm{} on its own player object — the chain may reject this",
                holder.name,
                match bit { 5 => "TokenInfuse", 6 => "TokenMigrate", _ => "TokenDefuse" }
            ));
        }
    }

    Ok(json!({
        "ok": refusal.is_none(),
        "refusal": refusal,
        "warnings": warnings,
        "op": op,
        "player_id": holder.player_id,
        "player_name": holder.name,
        "hd_index": holder.index,
        "address": address,
        "validator": validator,
        "amount_ualpha": amount_ualpha,
        "facts": facts,
    }))
}

// ── WRITES ──────────────────────────────────────────────────────────────────

/// Re-derive the signer for `index` and prove it is the address we mean to act
/// as. An infusion record is keyed by ADDRESS: if HD index 0 does not derive
/// the primary's on-chain address (it does not on a second-device install —
/// see [[sweep_null_counterparty_burn]]), signing anyway would defuse a
/// DIFFERENT stake, or create a second infusion nobody is tracking.
async fn verify_signer(
    app: &tauri::AppHandle,
    index: u32,
    expect_address: &str,
) -> Result<(), String> {
    let derived = crate::mcp::vplayer_bridge::call(app, "derive", json!({ "index": index }), 20)
        .await
        .map_err(|e| format!("could not derive the signing key for HD index {index}: {e}"))?;
    let addr = derived
        .get("address")
        .and_then(|a| a.as_str())
        .unwrap_or_default();
    if addr != expect_address {
        return Err(format!(
            "refusing to sign: HD index {index} derives {addr}, but this infusion belongs to \
             {expect_address}"
        ));
    }
    Ok(())
}

/// Sign one reactor message as the holder of `address`, after checking that the
/// key we would sign with really is that address.
async fn sign_as(
    app: &tauri::AppHandle,
    address: &str,
    type_url: &str,
    payload: Value,
    context: &str,
) -> Result<String, String> {
    let holder = holder_for(address)
        .ok_or_else(|| format!("{address} is not one of this operator's addresses"))?;
    verify_signer(app, holder.index, address).await?;
    let res = crate::mcp::tx_retry::sign_with_retry(app, holder.index, type_url, payload, context)
        .await?;
    Ok(res
        .get("transactionHash")
        .and_then(|h| h.as_str())
        .unwrap_or("(pending)")
        .to_string())
}

fn coin(amount_ualpha: f64) -> Value {
    json!({ "denom": "ualpha", "amount": (amount_ualpha.round() as u64).to_string() })
}

fn feed(app: &tauri::AppHandle, msg: String) {
    crate::mcp::board_feed::push(
        app,
        crate::mcp::board_feed::Severity::Notice,
        "infusion",
        msg,
    );
}

/// Stake Alpha into a reactor. Raises the holder's own capacity by
/// `power × (1 − commission)`; the remainder is the reactor's.
#[tauri::command]
pub async fn mcp_infusion_infuse(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    address: String,
    reactor_id: String,
    amount_ualpha: f64,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_infusion_infuse_impl(app, address, reactor_id, amount_ualpha).await
}

pub async fn mcp_infusion_infuse_impl(
    app: tauri::AppHandle,
    address: String,
    reactor_id: String,
    amount_ualpha: f64,
) -> Result<Value, String> {
    let preview = mcp_infusion_preview(
        "infuse".into(),
        address.clone(),
        reactor_id.clone(),
        None,
        amount_ualpha,
    )
    .await?;
    if preview.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "refused: {}",
            preview.get("refusal").and_then(|v| v.as_str()).unwrap_or("unsafe change")
        ));
    }
    let validator = preview.get("validator").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if validator.is_empty() {
        return Err(format!("reactor {reactor_id} has no validator address"));
    }
    let tx = sign_as(
        &app,
        &address,
        "/structs.structs.MsgReactorInfuse",
        json!({
            "delegatorAddress": address,
            "validatorAddress": validator,
            "amount": coin(amount_ualpha),
        }),
        &format!("board:infuse:{}", preview["player_id"].as_str().unwrap_or("")),
    )
    .await?;
    feed(
        &app,
        format!(
            "{} infused {:.4} g Alpha into reactor {reactor_id}",
            preview["player_name"].as_str().unwrap_or("a player"),
            amount_ualpha / UALPHA_PER_GRAM
        ),
    );
    Ok(json!({ "ok": true, "tx": tx, "preview": preview }))
}

/// Begin removing staked Alpha. The capacity goes NOW; the Alpha comes back
/// after the chain's unbonding cooldown (four days on this chain).
#[tauri::command]
pub async fn mcp_infusion_defuse(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    address: String,
    reactor_id: String,
    amount_ualpha: f64,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_infusion_defuse_impl(app, address, reactor_id, amount_ualpha).await
}

pub async fn mcp_infusion_defuse_impl(
    app: tauri::AppHandle,
    address: String,
    reactor_id: String,
    amount_ualpha: f64,
) -> Result<Value, String> {
    let preview = mcp_infusion_preview(
        "defuse".into(),
        address.clone(),
        reactor_id.clone(),
        None,
        amount_ualpha,
    )
    .await?;
    if preview.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "refused: {}",
            preview.get("refusal").and_then(|v| v.as_str()).unwrap_or("unsafe change")
        ));
    }
    let validator = preview.get("validator").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tx = sign_as(
        &app,
        &address,
        "/structs.structs.MsgReactorDefuse",
        json!({
            "delegatorAddress": address,
            "validatorAddress": validator,
            "amount": coin(amount_ualpha),
        }),
        &format!("board:defuse:{}", preview["player_id"].as_str().unwrap_or("")),
    )
    .await?;
    feed(
        &app,
        format!(
            "{} started defusing {:.4} g Alpha from reactor {reactor_id}",
            preview["player_name"].as_str().unwrap_or("a player"),
            amount_ualpha / UALPHA_PER_GRAM
        ),
    );
    Ok(json!({ "ok": true, "tx": tx, "preview": preview }))
}

/// Move staked Alpha from one reactor to another without an unbonding wait —
/// the capacity follows the stake, repriced at the destination's commission.
#[tauri::command]
pub async fn mcp_infusion_migrate(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    address: String,
    from_reactor_id: String,
    to_reactor_id: String,
    amount_ualpha: f64,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_infusion_migrate_impl(app, address, from_reactor_id, to_reactor_id, amount_ualpha).await
}

pub async fn mcp_infusion_migrate_impl(
    app: tauri::AppHandle,
    address: String,
    from_reactor_id: String,
    to_reactor_id: String,
    amount_ualpha: f64,
) -> Result<Value, String> {
    let preview = mcp_infusion_preview(
        "migrate".into(),
        address.clone(),
        from_reactor_id.clone(),
        Some(to_reactor_id.clone()),
        amount_ualpha,
    )
    .await?;
    if preview.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "refused: {}",
            preview.get("refusal").and_then(|v| v.as_str()).unwrap_or("unsafe change")
        ));
    }
    let client = CosmosClient::new();
    let reactors = reactors(&client).await;
    let src = reactors
        .by_id(&from_reactor_id)
        .and_then(|r| r.get("validator"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let dst = reactors
        .by_id(&to_reactor_id)
        .and_then(|r| r.get("validator"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if src.is_empty() || dst.is_empty() {
        return Err("could not resolve both reactors' validator addresses".into());
    }
    let tx = sign_as(
        &app,
        &address,
        "/structs.structs.MsgReactorBeginMigration",
        json!({
            "delegatorAddress": address,
            "validatorSrcAddress": src,
            "validatorDstAddress": dst,
            "amount": coin(amount_ualpha),
        }),
        &format!("board:migrate:{}", preview["player_id"].as_str().unwrap_or("")),
    )
    .await?;
    feed(
        &app,
        format!(
            "{} is migrating {:.4} g Alpha from reactor {from_reactor_id} to {to_reactor_id}",
            preview["player_name"].as_str().unwrap_or("a player"),
            amount_ualpha / UALPHA_PER_GRAM
        ),
    );
    Ok(json!({ "ok": true, "tx": tx, "preview": preview }))
}

/// Re-stake a defusion that is still in its cooldown. `creation_height`
/// identifies WHICH unbonding entry — the staking module keys on it, so it must
/// come from the pending row, never be guessed.
#[tauri::command]
pub async fn mcp_infusion_cancel_defusion(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    address: String,
    validator: String,
    amount_ualpha: f64,
    creation_height: String,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_infusion_cancel_defusion_impl(app, address, validator, amount_ualpha, creation_height).await
}

pub async fn mcp_infusion_cancel_defusion_impl(
    app: tauri::AppHandle,
    address: String,
    validator: String,
    amount_ualpha: f64,
    creation_height: String,
) -> Result<Value, String> {
    if amount_ualpha <= 0.0 {
        return Err("amount must be more than zero".into());
    }
    if creation_height.trim().is_empty() || creation_height.parse::<u64>().is_err() {
        return Err(format!(
            "'{creation_height}' is not a block height — it identifies which defusion to cancel \
             and must come from the pending row"
        ));
    }
    let tx = sign_as(
        &app,
        &address,
        "/structs.structs.MsgReactorCancelDefusion",
        json!({
            "delegatorAddress": address,
            "validatorAddress": validator,
            "amount": coin(amount_ualpha),
            "creationHeight": creation_height,
        }),
        "board:cancel_defusion",
    )
    .await?;
    feed(
        &app,
        format!(
            "cancelled a defusion of {:.4} g Alpha (height {creation_height})",
            amount_ualpha / UALPHA_PER_GRAM
        ),
    );
    Ok(json!({ "ok": true, "tx": tx }))
}

/// Resync a reactor from live staking. Permissionless — it only writes state
/// derived from the staking module — and it is the fix for a reactor whose
/// validator was unjailed but never rebonded, which leaves every infusion in it
/// stuck at ratio 0.
#[tauri::command]
pub async fn mcp_infusion_restart(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    reactor_id: String,
) -> Result<Value, String> {
    require_board(&window)?;
    mcp_infusion_restart_impl(app, reactor_id).await
}

pub async fn mcp_infusion_restart_impl(
    app: tauri::AppHandle,
    reactor_id: String,
) -> Result<Value, String> {
    let client = CosmosClient::new();
    let reactors = reactors(&client).await;
    let validator = reactors
        .by_id(&reactor_id)
        .and_then(|r| r.get("validator"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if validator.is_empty() {
        return Err(format!("no reactor {reactor_id}"));
    }
    let address = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| g.wallet_address.clone())
        .unwrap_or_default();
    let tx = sign_as(
        &app,
        &address,
        "/structs.structs.MsgReactorRestart",
        json!({ "validatorAddress": validator }),
        "board:reactor_restart",
    )
    .await?;
    feed(&app, format!("restarted reactor {reactor_id} from live staking"));
    Ok(json!({ "ok": true, "tx": tx }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_split_matches_live_player() {
        // Live 1-194 (2026-08-26): a 13,318,001,349 ualpha reactor infusion at
        // 4% plus a ratio-2 generator infusion of 65,708,000,000 at 0%, and the
        // player's capacity reads 144,201,281,295.
        let reactor = capacity_gain_mw(power_of(13_318_001_349.0, 1.0), 0.04);
        let generator = capacity_gain_mw(power_of(65_708_000_000.0, 2.0), 0.0);
        assert_eq!(reactor, 12_785_281_295.0);
        assert_eq!(generator, 131_416_000_000.0);
        assert_eq!(reactor + generator, 144_201_281_295.0);
    }

    #[test]
    fn defuse_that_would_brownout_is_refused() {
        // Capacity 144.2 GW carrying 123 GW of allocations. Removing the whole
        // generator stake (131.4 GW) drops capacity under the load.
        let why = defuse_refusal(
            65_708_000_000.0, 65_708_000_000.0, 0.0,
            131_416_000_000.0, 144_201_281_295.0, 123_000_000_000.0,
        );
        assert!(why.expect("must refuse").contains("DESTROYS its allocations"));
        // The reactor half is small enough to leave the load covered.
        assert!(defuse_refusal(
            13_318_001_349.0, 13_318_001_349.0, 0.0,
            12_785_281_295.0, 144_201_281_295.0, 123_000_000_000.0,
        )
        .is_none());
    }

    #[test]
    fn cannot_defuse_more_than_is_left_after_a_pending_defusion() {
        let why = defuse_refusal(5_000_000.0, 6_000_000.0, 2_000_000.0, 0.0, 1e12, 0.0);
        assert!(why.expect("must refuse").contains("still removable"));
        // Exactly the remainder is fine.
        assert!(defuse_refusal(4_000_000.0, 6_000_000.0, 2_000_000.0, 0.0, 1e12, 0.0).is_none());
    }

    #[test]
    fn zero_and_negative_amounts_are_refused_on_both_sides() {
        assert!(infuse_refusal(0.0, 1e9).is_some());
        assert!(infuse_refusal(-1.0, 1e9).is_some());
        assert!(defuse_refusal(0.0, 1e9, 0.0, 0.0, 1e12, 0.0).is_some());
        assert!(infuse_refusal(2e9, 1e9).expect("over balance").contains("liquid Alpha"));
    }

    #[test]
    fn entry_cap_is_reported_before_the_chain_rejects() {
        assert!(entries_refusal(6, 7, "defusions").is_none());
        assert!(entries_refusal(7, 7, "defusions").expect("at cap").contains("7"));
    }

    #[test]
    fn eta_is_clamped_and_survives_a_missing_timestamp() {
        let now = 1_700_000_000_000.0;
        assert_eq!(eta_secs(Some("2023-11-14T22:13:20Z"), now), Some(0)); // exactly now
        assert_eq!(eta_secs(Some("2023-11-14T21:13:20Z"), now), Some(0)); // past → 0
        assert_eq!(eta_secs(Some("2023-11-14T23:13:20Z"), now), Some(3600));
        assert_eq!(eta_secs(None, now), None);
        assert_eq!(eta_secs(Some(""), now), None);
    }
}
