//! Selling energy: the providers a player owns, what they hold and who buys
//! from them, and every way to run one after the energy card's "Sell" made
//! it — collect earnings, change the contract limits or who may buy, delete.
//!
//! Money (chain v0.22, `provider_cache.go`):
//! - A provider has two pools: COLLATERAL (buyers' prepayments, released to
//!   the provider as blocks of service elapse) and EARNINGS (released money
//!   waiting to be collected).
//! - Withdraw checkpoints first (moves everything earned up to now from
//!   collateral to earnings), then sends the whole earnings pool to the
//!   OWNER'S VAULT when no destination is named — so the pool balance shown
//!   here is a floor on what a withdraw collects.
//! - Delete closes every open agreement at the provider's cancellation
//!   penalty, then drains both pools into the owner's vault.
//!
//! Permissions: withdraw needs ProviderWithdraw, limit/policy changes Update,
//! delete Delete — each on the signing key itself (v0.22) and as standing on
//! the provider (the owner has it).

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::guild_admin::bits;
use crate::mcp::loop_util::parse_f64 as num;
use crate::mcp::send_guard::signer_lacks;

/// One provider action, ready to preview or sign.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub type_url: &'static str,
    pub payload: Value,
    pub key_bits: u64,
    pub summary: String,
}

pub const ACTIONS: &[&str] = &["withdraw", "capacity_min", "capacity_max", "duration_min", "duration_max", "access", "delete"];

/// The limits a provider holds now, for the range checks.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Limits {
    pub capacity_min: u64,
    pub capacity_max: u64,
    pub duration_min: u64,
    pub duration_max: u64,
}

impl Limits {
    pub fn of(p: &Value) -> Self {
        let n = |k: &str| num(p.get(k)) as u64;
        Self {
            capacity_min: n("capacityMinimum"),
            capacity_max: n("capacityMaximum"),
            duration_min: n("durationMinimum"),
            duration_max: n("durationMaximum"),
        }
    }
}

fn value_arg(args: &Value) -> Result<u64, String> {
    match args.get("value") {
        Some(Value::Number(n)) => n.as_u64().ok_or_else(|| "value must be a whole number".into()),
        Some(Value::String(s)) => s.trim().parse().map_err(|_| format!("value must be a whole number, not '{s}'")),
        _ => Err("value is required".into()),
    }
}

/// Pure: validate and build the message. `limits` are the provider's current
/// ones — the chain refuses a minimum above the maximum (and the reverse),
/// and zero for either.
pub fn plan(provider_id: &str, action: &str, args: &Value, limits: Limits) -> Result<Plan, String> {
    match crate::mcp::types::ObjectId::parse(provider_id) {
        Ok(o) if o.kind == crate::mcp::types::ObjectKind::Provider => {}
        _ => return Err(format!("'{provider_id}' is not a provider id (they look like 10-5)")),
    }
    let id = provider_id;
    let limit = |field: &'static str, type_url: &'static str, key: &str, what: &str, unit: &str| -> Result<Plan, String> {
        let v = value_arg(args)?;
        if v == 0 {
            return Err(format!("the {what} cannot be 0"));
        }
        let check = match field {
            "capacity_min" if v > limits.capacity_max => Some(format!("above the capacity maximum ({})", limits.capacity_max)),
            "capacity_max" if v < limits.capacity_min => Some(format!("below the capacity minimum ({})", limits.capacity_min)),
            "duration_min" if v > limits.duration_max => Some(format!("above the duration maximum ({})", limits.duration_max)),
            "duration_max" if v < limits.duration_min => Some(format!("below the duration minimum ({})", limits.duration_min)),
            _ => None,
        };
        if let Some(why) = check {
            return Err(format!("{v} is {why}"));
        }
        Ok(Plan {
            type_url,
            payload: json!({ "providerId": id, key: v.to_string() }),
            key_bits: bits::UPDATE,
            summary: format!("{id}'s {what} becomes {v} {unit}"),
        })
    };
    match action {
        "withdraw" => Ok(Plan {
            type_url: "/structs.structs.MsgProviderWithdrawBalance",
            // Empty destination = the owner's vault (v0.22).
            payload: json!({ "providerId": id, "destinationAddress": "" }),
            key_bits: bits::PROVIDER_WITHDRAW,
            summary: format!("Collect {id}'s earnings into your vault"),
        }),
        "capacity_min" => limit("capacity_min", "/structs.structs.MsgProviderUpdateCapacityMinimum", "newMinimumCapacity", "smallest contract", "mW"),
        "capacity_max" => limit("capacity_max", "/structs.structs.MsgProviderUpdateCapacityMaximum", "newMaximumCapacity", "largest contract", "mW"),
        "duration_min" => limit("duration_min", "/structs.structs.MsgProviderUpdateDurationMinimum", "newMinimumDuration", "shortest contract", "blocks"),
        "duration_max" => limit("duration_max", "/structs.structs.MsgProviderUpdateDurationMaximum", "newMaximumDuration", "longest contract", "blocks"),
        "access" => {
            let policy = args.get("policy").and_then(|v| v.as_str()).unwrap_or("").trim();
            let (wire, said) = match policy {
                "open" | "openMarket" => ("openMarket", "anyone"),
                "guild" | "guildMarket" => ("guildMarket", "players granted access"),
                "closed" | "closedMarket" => ("closedMarket", "nobody new"),
                _ => return Err("policy is open, guild or closed".into()),
            };
            Ok(Plan {
                type_url: "/structs.structs.MsgProviderUpdateAccessPolicy",
                payload: json!({ "providerId": id, "accessPolicy": wire }),
                key_bits: bits::UPDATE,
                summary: format!("{id} sells to {said}"),
            })
        }
        "delete" => Ok(Plan {
            type_url: "/structs.structs.MsgProviderDelete",
            payload: json!({ "providerId": id }),
            key_bits: bits::DELETE,
            summary: format!("Delete {id}: open contracts close, both pools go to your vault"),
        }),
        other => Err(format!("unknown provider action '{other}' (one of: {})", ACTIONS.join(", "))),
    }
}

fn primary_identity() -> Result<(String, String), String> {
    let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
    let pid = gs.player_id.clone().unwrap_or_default();
    let addr = gs.wallet_address.clone().unwrap_or_default();
    if pid.is_empty() || addr.is_empty() {
        return Err("primary identity not synced yet".into());
    }
    Ok((pid, addr))
}

/// The coins at a provider pool (`kind` = "earnings" | "collateral").
async fn pool(client: &CosmosClient, provider_id: &str, kind: &str) -> Vec<Value> {
    let Ok(v) = client.lcd_get(&format!("/structs/provider_{kind}_address/{provider_id}")).await else {
        return Vec::new();
    };
    let Some(addr) = v.pointer("/internalAddressAssociation/0/address").and_then(|a| a.as_str()) else {
        return Vec::new();
    };
    client.bank_balances(addr).await.unwrap_or_default()
}

/// Every provider row (a few dozen galaxy-wide).
async fn all_providers(client: &CosmosClient) -> Result<Vec<Value>, String> {
    client.list_all_entities("provider", "Provider").await
}

/// Pure: a provider's buyers, and what they pay per block at `rate`.
pub fn summarise_agreements(rows: &[Value], height: u64, rate: f64) -> (Vec<Value>, f64, u64) {
    let mut out = Vec::new();
    let mut per_block = 0.0;
    let mut sold = 0u64;
    for a in rows {
        let cap = num(a.get("capacity")) as u64;
        let end = num(a.get("endBlock")) as u64;
        sold += cap;
        per_block += cap as f64 * rate;
        out.push(json!({
            "id": a.get("id"),
            "owner": a.get("owner"),
            "capacity_mw": cap,
            "start_block": num(a.get("startBlock")) as u64,
            "end_block": end,
            "blocks_left": end.saturating_sub(height),
        }));
    }
    (out, per_block, sold)
}

/// The providers the primary owns (and its guild's, marked), with pools,
/// buyers and terms.
pub async fn list() -> Result<Value, String> {
    let (me, _) = primary_identity()?;
    let client = CosmosClient::new();
    let player = client.query_entity("player", &me).await?;
    let guild = player.pointer("/Player/guildId").and_then(|g| g.as_str()).unwrap_or("").to_string();
    let height = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    let mut out = Vec::new();
    for p in all_providers(&client).await? {
        let owner = p.get("owner").and_then(|o| o.as_str()).unwrap_or("");
        if owner != me && (guild.is_empty() || owner != guild) {
            continue;
        }
        let id = p.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        let rate = p.pointer("/rate/amount").map(|v| num(Some(v))).unwrap_or(0.0);
        let agreements = client
            .lcd_get(&format!("/structs/agreement_by_provider/{id}?pagination.limit=1000"))
            .await
            .ok()
            .and_then(|v| v.get("Agreement").and_then(|a| a.as_array()).cloned())
            .unwrap_or_default();
        let (buyers, per_block, sold) = summarise_agreements(&agreements, height, rate);
        let substation = p.get("substationId").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let sub = client.query_entity("substation", &substation).await.ok();
        out.push(json!({
            "id": id,
            "owner": owner,
            "guild_owned": owner != me,
            "substation_id": substation,
            "substation_closing": sub.as_ref().is_some_and(crate::mcp::tools::board_pages::substation_deletion_pending),
            "rate": p.get("rate"),
            "access": p.get("accessPolicy"),
            "capacity_min": num(p.get("capacityMinimum")) as u64,
            "capacity_max": num(p.get("capacityMaximum")) as u64,
            "duration_min": num(p.get("durationMinimum")) as u64,
            "duration_max": num(p.get("durationMaximum")) as u64,
            "provider_penalty": p.get("providerCancellationPenalty"),
            "consumer_penalty": p.get("consumerCancellationPenalty"),
            "earnings": pool(&client, &id, "earnings").await,
            "collateral": pool(&client, &id, "collateral").await,
            "agreements": buyers,
            "sold_mw": sold,
            "income_per_block": per_block,
        }));
    }
    Ok(json!({ "ok": true, "owner": me, "height": height, "providers": out }))
}

/// Check a provider action without signing.
pub async fn preview(provider_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    let (me, address) = primary_identity()?;
    let client = CosmosClient::new();
    let p = client.query_entity("provider", provider_id).await.map_err(|e| format!("provider {provider_id}: {e}"))?;
    let p = p.get("Provider").cloned().unwrap_or(Value::Null);
    let plan = plan(provider_id, action, args, Limits::of(&p))?;
    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if let Some(why) = signer_lacks(&address, plan.key_bits, &bits::describe(plan.key_bits)).await {
        problems.push(why);
    }
    let owner = p.get("owner").and_then(|o| o.as_str()).unwrap_or("");
    if owner != me {
        warnings.push(format!("{provider_id} belongs to {owner}; this needs a {} grant on it", bits::describe(plan.key_bits)));
    }
    let earnings = pool(&client, provider_id, "earnings").await;
    let collateral = pool(&client, provider_id, "collateral").await;
    let open = client
        .lcd_get(&format!("/structs/agreement_by_provider/{provider_id}?pagination.limit=1000"))
        .await
        .ok()
        .and_then(|v| v.get("Agreement").and_then(|a| a.as_array()).map(|a| a.len()))
        .unwrap_or(0);
    if action == "delete" && open > 0 {
        warnings.push(format!("{open} open contract(s) close now, at your cancellation penalty ({})",
            p.get("providerCancellationPenalty").and_then(|v| v.as_str()).unwrap_or("0")));
    }
    if action == "access" && open > 0 {
        warnings.push("open contracts keep running; the policy decides only who may open new ones".into());
    }
    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "warnings": warnings,
        "provider_id": provider_id,
        "action": action,
        "summary": plan.summary,
        "message": plan.type_url.trim_start_matches("/structs.structs."),
        "payload": plan.payload,
        "earnings": earnings,
        "collateral": collateral,
        "open_agreements": open,
    }))
}

/// Sign a provider action, after re-running the preview.
pub async fn execute(app: &tauri::AppHandle, provider_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    let pv = preview(provider_id, action, args).await?;
    if pv.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let why: Vec<&str> = pv["problems"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        return Err(format!("refused: {}", why.join("; ")));
    }
    let client = CosmosClient::new();
    let p = client.query_entity("provider", provider_id).await?;
    let plan = plan(provider_id, action, args, Limits::of(p.get("Provider").unwrap_or(&Value::Null)))?;
    let res = crate::mcp::tx_retry::sign_as_primary(app, plan.type_url, plan.payload, format!("provider:{action}")).await?;
    crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Notice, "energy", plan.summary.clone());
    Ok(json!({
        "ok": true,
        "summary": plan.summary,
        "preview": pv,
        "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits { capacity_min: 1000, capacity_max: 1_000_000, duration_min: 100, duration_max: 10_000 }
    }

    #[test]
    fn withdraw_goes_to_the_owner_vault() {
        let p = plan("10-5", "withdraw", &json!({}), limits()).unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgProviderWithdrawBalance");
        assert_eq!(p.payload, json!({ "providerId": "10-5", "destinationAddress": "" }));
        assert_eq!(p.key_bits, bits::PROVIDER_WITHDRAW);
    }

    #[test]
    fn limits_respect_the_other_end_of_the_range() {
        let p = plan("10-5", "capacity_max", &json!({ "value": "5000" }), limits()).unwrap();
        assert_eq!(p.payload, json!({ "providerId": "10-5", "newMaximumCapacity": "5000" }));
        assert!(plan("10-5", "capacity_max", &json!({ "value": 999 }), limits()).is_err(), "below the minimum");
        assert!(plan("10-5", "capacity_min", &json!({ "value": 2_000_000 }), limits()).is_err(), "above the maximum");
        assert!(plan("10-5", "duration_min", &json!({ "value": 0 }), limits()).is_err(), "zero");
        assert!(plan("10-5", "duration_max", &json!({ "value": 50 }), limits()).is_err());
        assert_eq!(plan("10-5", "duration_min", &json!({ "value": 200 }), limits()).unwrap().payload["newMinimumDuration"], "200");
    }

    #[test]
    fn access_names_map_to_the_chain_enum() {
        assert_eq!(plan("10-5", "access", &json!({ "policy": "guild" }), limits()).unwrap().payload["accessPolicy"], "guildMarket");
        assert_eq!(plan("10-5", "access", &json!({ "policy": "closedMarket" }), limits()).unwrap().payload["accessPolicy"], "closedMarket");
        assert!(plan("10-5", "access", &json!({ "policy": "friends" }), limits()).is_err());
    }

    #[test]
    fn every_action_encodes_against_the_v022_schema() {
        for a in ACTIONS {
            let args = json!({ "value": 5000, "policy": "guild" });
            let p = plan("10-5", a, &args, limits()).unwrap_or_else(|e| panic!("{a}: {e}"));
            crate::mcp::guild_admin::tests::assert_encodes(p.type_url, &p.payload);
        }
    }

    #[test]
    fn only_provider_ids_are_accepted() {
        assert!(plan("4-5", "delete", &json!({}), limits()).is_err());
        assert_eq!(plan("10-8", "delete", &json!({}), limits()).unwrap().key_bits, bits::DELETE);
    }

    #[test]
    fn buyers_sum_capacity_and_income() {
        let rows = [
            json!({ "id": "11-1", "owner": "1-7", "capacity": "1000", "startBlock": "10", "endBlock": "500" }),
            json!({ "id": "11-2", "owner": "1-8", "capacity": "3000", "startBlock": "20", "endBlock": "90" }),
        ];
        let (buyers, per_block, sold) = summarise_agreements(&rows, 100, 2.0);
        assert_eq!(sold, 4000);
        assert_eq!(per_block, 8000.0);
        assert_eq!(buyers[0]["blocks_left"], 400);
        assert_eq!(buyers[1]["blocks_left"], 0, "past its end, not negative");
    }
}
