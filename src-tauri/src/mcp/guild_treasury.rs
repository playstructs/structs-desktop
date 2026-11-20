//! A guild's own power: its vault, its stake, the allocations it sources and
//! the substations it owns — run by the guild's owner (usually a founder,
//! `as: "<label>"`) after founding.
//!
//! Chain v0.23 rules this follows: guild-owned objects pass the permission
//! check for the guild's CURRENT owner (`permissions_context.go`, "Guild
//! assets follow the guild's current owner"), then direct grants on that
//! object, then rank grants. A grant on the guild object itself does NOT
//! reach its substations, allocations or stake — so the primary, holding
//! PermAll on a founder's guild, still cannot run its power. Sign these as
//! the owner.
//!
//! Every op is previewed first and `execute` signs exactly the previewed
//! payload, like `guild_admin`.

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::founders::Signer;
use crate::mcp::guild_admin::bits;
use crate::mcp::send_guard::signer_lacks;

pub const ACTIONS: &[&str] = &[
    "fund", "stake", "unstake", "allocation_create", "allocation_update", "substation_create",
    "allocation_connect", "player_connect", "substation_name",
];

/// One op, ready to preview or sign.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub action: String,
    pub type_url: &'static str,
    pub payload: Value,
    /// Bits the signing key must hold.
    pub key_bits: u64,
    pub summary: String,
}

fn arg_str(args: &Value, k: &str) -> Option<String> {
    match args.get(k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn arg_u64(args: &Value, k: &str) -> Result<u64, String> {
    match args.get(k) {
        Some(Value::Number(n)) => n.as_u64().ok_or_else(|| format!("{k} must be a whole number")),
        Some(Value::String(s)) => s.trim().parse().map_err(|_| format!("{k} must be a whole number, not '{s}'")),
        _ => Err(format!("{k} is required")),
    }
}

fn id_arg(args: &Value, k: &str, kind: crate::mcp::types::ObjectKind, what: &str, example: &str) -> Result<String, String> {
    let v = arg_str(args, k).ok_or_else(|| format!("{k} is required"))?;
    match crate::mcp::types::ObjectId::parse(&v) {
        Ok(o) if o.kind == kind => Ok(v),
        _ => Err(format!("'{v}' is not a {what} id (they look like {example})")),
    }
}

fn alpha(u: u64) -> String {
    crate::mcp::tools::format::format_alpha(u as f64)
}

/// Pure: validate `args` for `action` on `guild` and build the message.
/// `me` signs; `validator` is the stake reactor's validator address (stake
/// and unstake only — the caller reads it).
pub fn plan(guild: &str, me: &str, action: &str, args: &Value, validator: &str) -> Result<Plan, String> {
    use crate::mcp::types::ObjectKind;
    if !guild.starts_with("0-") || crate::mcp::send_guard::validate_owner_id("guild", guild).is_err() {
        return Err(format!("'{guild}' is not a guild id (they look like 0-1)"));
    }
    let mk = |type_url: &'static str, payload: Value, key_bits: u64, summary: String| Plan { action: action.to_string(), type_url, payload, key_bits, summary };
    let p = match action {
        "fund" => {
            let amount = arg_u64(args, "amount")?;
            if amount == 0 {
                return Err("amount is ualpha, more than 0".into());
            }
            let payload = crate::mcp::send_guard::vault_send_payload(me, guild, "ualpha", &amount.to_string())?;
            mk("/structs.structs.MsgVaultSend", payload, bits::TOKEN_TRANSFER, format!("Send {} from {me}'s vault to {guild}'s", alpha(amount)))
        }
        "stake" | "unstake" => {
            let amount = arg_u64(args, "amount")?;
            if amount == 0 {
                return Err("amount is ualpha, more than 0".into());
            }
            if validator.is_empty() {
                return Err("the reactor's validator is unknown".into());
            }
            let stake = action == "stake";
            mk(
                if stake { "/structs.structs.MsgReactorInfuse" } else { "/structs.structs.MsgReactorDefuse" },
                json!({ "validatorAddress": validator, "amount": { "denom": "ualpha", "amount": amount.to_string() }, "ownerId": guild }),
                if stake { bits::TOKEN_INFUSE } else { bits::TOKEN_DEFUSE },
                if stake {
                    format!("Stake {} of {guild}'s vault for capacity", alpha(amount))
                } else {
                    format!("Begin unstaking {} of {guild}'s stake (its capacity drops now)", alpha(amount))
                },
            )
        }
        "allocation_create" => {
            let kind = arg_str(args, "type").unwrap_or_else(|| "automated".into()).to_ascii_lowercase();
            if !matches!(kind.as_str(), "automated" | "dynamic" | "static") {
                return Err("type is automated, dynamic or static".into());
            }
            let power = if kind == "automated" { 0 } else { arg_u64(args, "power")? };
            if kind != "automated" && power == 0 {
                return Err("power is mW, more than 0".into());
            }
            let what = if kind == "automated" { "all of its capacity, growing with every stake".to_string() } else { crate::mcp::tools::format::format_power(power as f64) };
            mk("/structs.structs.MsgAllocationCreate",
               json!({ "controller": guild, "sourceObjectId": guild, "allocationType": kind, "power": power }),
               bits::SOURCE_ALLOCATION, format!("A {kind} allocation from {guild}: {what}"))
        }
        "allocation_update" => {
            let a = id_arg(args, "allocation", ObjectKind::Allocation, "allocation", "6-1")?;
            let power = arg_u64(args, "power")?;
            mk("/structs.structs.MsgAllocationUpdate", json!({ "allocationId": a, "power": power }),
               bits::SOURCE_ALLOCATION, format!("{a} carries {}", crate::mcp::tools::format::format_power(power as f64)))
        }
        "substation_create" => {
            let a = id_arg(args, "allocation", ObjectKind::Allocation, "allocation", "6-1")?;
            mk("/structs.structs.MsgSubstationCreate", json!({ "owner": guild, "allocationId": a }),
               bits::ALLOCATION_CONNECTION, format!("A substation owned by {guild}, fed by {a}"))
        }
        "allocation_connect" => {
            let a = id_arg(args, "allocation", ObjectKind::Allocation, "allocation", "6-1")?;
            let sub = id_arg(args, "substation", ObjectKind::Substation, "substation", "4-1")?;
            mk("/structs.structs.MsgSubstationAllocationConnect", json!({ "allocationId": a, "destinationId": sub }),
               bits::ALLOCATION_CONNECTION, format!("Feed {sub} from {a}"))
        }
        "player_connect" => {
            let who = id_arg(args, "player", ObjectKind::Player, "player", "1-42")?;
            let sub = id_arg(args, "substation", ObjectKind::Substation, "substation", "4-1")?;
            mk("/structs.structs.MsgSubstationPlayerConnect", json!({ "substationId": sub, "playerId": who }),
               bits::SUBSTATION_CONNECTION, format!("Connect {who} to {sub}"))
        }
        "substation_name" => {
            let sub = id_arg(args, "substation", ObjectKind::Substation, "substation", "4-1")?;
            let name = arg_str(args, "name").ok_or("name is required")?;
            if let Some(why) = crate::mcp::guild_founding::name_refusal(&name) {
                return Err(format!("name: {why}"));
            }
            mk("/structs.structs.MsgSubstationUpdateName", json!({ "substationId": sub, "name": name }),
               bits::UPDATE, format!("Name {sub} \"{name}\""))
        }
        other => return Err(format!("unknown treasury op '{other}' (one of: status, {})", ACTIONS.join(", "))),
    };
    Ok(p)
}

fn s(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// The guild `guild_id` names, else the signer's own.
async fn guild_for(client: &CosmosClient, signer: &Signer, guild_id: Option<String>) -> Result<(String, Value), String> {
    let gid = match guild_id.map(|g| g.trim().to_string()).filter(|g| !g.is_empty()) {
        Some(g) => g,
        None => {
            let p = client.query_entity("player", &signer.player_id).await?;
            s(p.pointer("/Player/guildId"))
        }
    };
    if !gid.starts_with("0-") {
        return Err(format!("{} is in no guild — name one with guild_id", signer.who()));
    }
    let g = client.query_entity("guild", &gid).await.map_err(|e| format!("guild {gid}: {e}"))?;
    Ok((gid, g.get("Guild").cloned().unwrap_or(Value::Null)))
}

/// The guild's vault, stake capacity, allocations and substations.
pub async fn status(signer: &Signer, guild_id: Option<String>) -> Result<Value, String> {
    let client = CosmosClient::new();
    let (gid, g) = guild_for(&client, signer, guild_id).await?;
    let grid = |k: &'static str| {
        let client = &client;
        let gid = gid.clone();
        async move { crate::mcp::guild_founding::grid(client, k, &gid).await }
    };
    let (capacity, load) = (grid("2").await, grid("3").await);
    let vault = crate::mcp::guild_founding::vault_of(&client, &gid).await;
    let allocations: Vec<Value> = client
        .list_all_entities("allocation", "Allocation")
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|a| s(a.get("sourceObjectId")) == gid)
        .map(|a| json!({ "id": a.get("id"), "type": a.get("type"), "destination_id": a.get("destinationId"), "controller": a.get("controller") }))
        .collect();
    let mut substations = Vec::new();
    for row in client.list_all_entities("substation", "Substation").await.unwrap_or_default() {
        if s(row.get("owner")) != gid {
            continue;
        }
        let id = s(row.get("id"));
        let v = client.query_entity("substation", &id).await.unwrap_or(Value::Null);
        let a = |k: &str| crate::mcp::loop_util::parse_f64(v.pointer(&format!("/gridAttributes/{k}")));
        substations.push(json!({
            "id": id,
            "name": row.get("name"),
            "capacity_mw": a("capacity"),
            "load_mw": a("load"),
            "connections": a("connectionCount") as u64,
            "share_mw": a("connectionCapacity") as u64,
            "connection_max_mw": a("connectionCapacityMaximum") as u64,
            "entry": s(g.get("entrySubstationId")) == id,
        }));
    }
    let owner = s(g.get("owner"));
    Ok(json!({
        "ok": true,
        "guild_id": gid,
        "owner": owner,
        "you_own_it": owner == signer.player_id,
        "signed_as": signer.describe(),
        "primary_reactor_id": g.get("primaryReactorId"),
        "entry_substation_id": g.get("entrySubstationId"),
        "vault_ualpha": vault.to_string(),
        "capacity_mw": capacity,
        "load_mw": load,
        "spare_mw": (capacity - load).max(0.0),
        "allocations": allocations,
        "substations": substations,
    }))
}

/// Check `action` without signing.
pub async fn preview(signer: &Signer, guild_id: Option<String>, action: &str, args: &Value) -> Result<Value, String> {
    let client = CosmosClient::new();
    let (gid, g) = guild_for(&client, signer, guild_id).await?;
    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Stake/unstake: the reactor (default the guild's primary) and its validator.
    let mut reactor = String::new();
    let mut validator = String::new();
    if matches!(action, "stake" | "unstake") {
        reactor = arg_str(args, "reactor").unwrap_or_else(|| s(g.get("primaryReactorId")));
        match client.query_entity("reactor", &reactor).await {
            Ok(r) => validator = s(r.pointer("/Reactor/validator")),
            Err(_) => problems.push(format!("no reactor {reactor} on chain")),
        }
    }
    let plan = plan(&gid, &signer.player_id, action, args, if validator.is_empty() { "-" } else { &validator })?;

    if let Some(why) = signer_lacks(&signer.address, plan.key_bits, &bits::describe(plan.key_bits)).await {
        problems.push(why);
    }
    let owner = s(g.get("owner"));
    if owner != signer.player_id {
        warnings.push(format!(
            "{} does not own {gid} (owner {owner}); guild-owned power answers to its owner or to direct grants on each object",
            signer.who()
        ));
    }

    let amount = arg_u64(args, "amount").unwrap_or(0);
    match action {
        "fund" => {
            let held = crate::mcp::guild_founding::vault_of(&client, &signer.player_id).await;
            if held < amount {
                problems.push(format!("{}'s vault holds {}; sending needs {}", signer.who(), alpha(held), alpha(amount)));
            }
        }
        "stake" => {
            let held = crate::mcp::guild_founding::vault_of(&client, &gid).await;
            if held < amount {
                problems.push(format!("{gid}'s vault holds {}; staking needs {} (fund it first)", alpha(held), alpha(amount)));
            }
        }
        "unstake" => warnings.push("unstaking lowers the guild's capacity at once; an automated allocation shrinks with it and members may brown out".into()),
        "allocation_create" => {
            let capacity = crate::mcp::guild_founding::grid(&client, "2", &gid).await;
            let load = crate::mcp::guild_founding::grid(&client, "3", &gid).await;
            let power = plan.payload["power"].as_u64().unwrap_or(0) as f64;
            if capacity <= 0.0 {
                problems.push(format!("{gid} has no capacity yet — stake first"));
            } else if plan.payload["allocationType"] == "automated" && load > 0.0 {
                warnings.push(format!("{gid} already carries load; the chain may refuse automated — use dynamic with power ≤ {}", crate::mcp::tools::format::format_power((capacity - load).max(0.0))));
            } else if power > (capacity - load) {
                problems.push(format!("{gid} has {} spare; that allocation needs {}", crate::mcp::tools::format::format_power((capacity - load).max(0.0)), crate::mcp::tools::format::format_power(power)));
            }
        }
        "substation_create" | "allocation_connect" | "allocation_update" => {
            let a = plan.payload["allocationId"].as_str().unwrap_or("").to_string();
            match client.query_entity("allocation", &a).await {
                Ok(v) => {
                    let row = v.get("Allocation").cloned().unwrap_or(v);
                    if s(row.get("sourceObjectId")) != gid {
                        warnings.push(format!("{a} is not sourced from {gid}"));
                    }
                    if action != "allocation_update" && !s(row.get("destinationId")).is_empty() {
                        problems.push(format!("{a} already feeds {}", s(row.get("destinationId"))));
                    }
                }
                Err(_) => problems.push(format!("no allocation {a} on chain")),
            }
        }
        "player_connect" => {
            let who = plan.payload["playerId"].as_str().unwrap_or("").to_string();
            match client.query_entity("player", &who).await {
                Ok(p) if s(p.pointer("/Player/guildId")) != gid => warnings.push(format!("{who} is not a member of {gid}")),
                Ok(_) => {}
                Err(_) => problems.push(format!("no player {who} on chain")),
            }
        }
        _ => {}
    }
    if matches!(action, "allocation_connect" | "player_connect" | "substation_name") {
        let sub = plan.payload.get("destinationId").or_else(|| plan.payload.get("substationId")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        match client.query_entity("substation", &sub).await {
            Ok(v) if crate::mcp::tools::board_pages::substation_deletion_pending(&v) => problems.push(format!("substation {sub} is pending deletion")),
            Ok(_) => {}
            Err(_) => problems.push(format!("no substation {sub} on chain")),
        }
    }

    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "warnings": warnings,
        "signed_as": signer.describe(),
        "guild_id": gid,
        "action": plan.action,
        "summary": plan.summary,
        "reactor_id": if reactor.is_empty() { Value::Null } else { json!(reactor) },
        "message": plan.type_url.trim_start_matches("/structs.structs."),
        "payload": plan.payload,
    }))
}

/// Sign `action` as `signer`, after re-running the preview.
pub async fn execute(app: &tauri::AppHandle, signer: &Signer, guild_id: Option<String>, action: &str, args: &Value) -> Result<Value, String> {
    let pv = preview(signer, guild_id, action, args).await?;
    if pv.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let why: Vec<&str> = pv["problems"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        return Err(format!("refused: {}", why.join("; ")));
    }
    let type_url = plan(pv["guild_id"].as_str().unwrap_or(""), &signer.player_id, action, args, "-")?.type_url;
    let res = crate::mcp::tx_retry::sign_once(app, signer.index, type_url, pv["payload"].clone(), format!("treasury:{action}")).await?;
    crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Notice, "energy", pv["summary"].as_str().unwrap_or("").to_string());
    Ok(json!({
        "ok": true,
        "summary": pv["summary"],
        "signed_as": signer.describe(),
        "preview": pv,
        "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_build_the_chain_payloads() {
        let p = plan("0-12", "1-70", "fund", &json!({ "amount": 5_000_000 }), "").unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgVaultSend");
        assert_eq!(p.payload["recipientOwnerId"], "0-12");

        let p = plan("0-12", "1-70", "stake", &json!({ "amount": "2000000" }), "structsvaloper1x").unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgReactorInfuse");
        assert_eq!(p.payload, json!({ "validatorAddress": "structsvaloper1x", "amount": { "denom": "ualpha", "amount": "2000000" }, "ownerId": "0-12" }));
        let p = plan("0-12", "1-70", "unstake", &json!({ "amount": 1 }), "structsvaloper1x").unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgReactorDefuse");
        assert_eq!(p.payload["ownerId"], "0-12");

        let p = plan("0-12", "1-70", "allocation_create", &json!({}), "").unwrap();
        assert_eq!(p.payload, json!({ "controller": "0-12", "sourceObjectId": "0-12", "allocationType": "automated", "power": 0 }));
        let p = plan("0-12", "1-70", "allocation_create", &json!({ "type": "dynamic", "power": 9000 }), "").unwrap();
        assert_eq!(p.payload["power"], 9000);

        let p = plan("0-12", "1-70", "substation_create", &json!({ "allocation": "6-40" }), "").unwrap();
        assert_eq!(p.payload, json!({ "owner": "0-12", "allocationId": "6-40" }));
        let p = plan("0-12", "1-70", "allocation_connect", &json!({ "allocation": "6-40", "substation": "4-9" }), "").unwrap();
        assert_eq!(p.payload, json!({ "allocationId": "6-40", "destinationId": "4-9" }));
        let p = plan("0-12", "1-70", "player_connect", &json!({ "player": "1-71", "substation": "4-9" }), "").unwrap();
        assert_eq!(p.payload, json!({ "substationId": "4-9", "playerId": "1-71" }));
        let p = plan("0-12", "1-70", "substation_name", &json!({ "substation": "4-9", "name": "Acme Grid" }), "").unwrap();
        assert_eq!(p.payload, json!({ "substationId": "4-9", "name": "Acme Grid" }));
    }

    #[test]
    fn every_op_encodes_against_the_chain_schema() {
        let args = json!({ "amount": 1000, "type": "dynamic", "power": 5000, "allocation": "6-1", "substation": "4-1", "player": "1-42", "name": "Acme Grid" });
        for a in ACTIONS {
            let p = plan("0-1", "1-9", a, &args, "structsvaloper1x").unwrap_or_else(|e| panic!("{a}: {e}"));
            crate::mcp::guild_admin::tests::assert_encodes(p.type_url, &p.payload);
        }
    }

    #[test]
    fn plans_refuse_bad_input() {
        assert!(plan("4-1", "1-70", "fund", &json!({ "amount": 1 }), "").is_err(), "not a guild");
        assert!(plan("0-12", "1-70", "fund", &json!({ "amount": 0 }), "").is_err());
        assert!(plan("0-12", "1-70", "stake", &json!({ "amount": 1 }), "").is_err(), "no validator");
        assert!(plan("0-12", "1-70", "allocation_create", &json!({ "type": "dynamic" }), "").is_err(), "dynamic needs power");
        assert!(plan("0-12", "1-70", "allocation_create", &json!({ "type": "weird" }), "").is_err());
        assert!(plan("0-12", "1-70", "substation_create", &json!({ "allocation": "4-1" }), "").is_err(), "wrong kind");
        assert!(plan("0-12", "1-70", "player_connect", &json!({ "player": "1-71" }), "").is_err(), "substation missing");
        assert!(plan("0-12", "1-70", "launch", &json!({}), "").is_err());
    }
}
