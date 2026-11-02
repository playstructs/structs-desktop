//! Guild economy messages new in chain v0.22: buying a better guild rank (or
//! admission by purchase), and the paid single-route guild founding.
//!
//! Both spend from the player's VAULT, both sign with the primary's device key
//! (`tx_retry::sign_as_primary`), and both are quoted before they are signed —
//! the quote is the same arithmetic the chain does, in exact integers.
//!
//! Rank sales (chain `v0.22.0-economy-client-reference.md`, "Rank sales and
//! admission"): lower numeric ranks are better. For entry rank E, a member at
//! rank R has progress `max(E − R, 0)`; a target rank T has progress `E − T`.
//! With base price B and step S, `cost(n) = B·n + S·n·(n−1)/2`, and a purchase
//! costs `cost(target progress) − cost(current progress)`. Minimum rank 0
//! disables sales; admission (a non-member buying in) starts from progress 0
//! and needs the guild's separate `joinByRankPurchaseEnabled`. Prices are base
//! units of the guild's own token, `uguild.<guild id>`.
//!
//! Founding: `MsgGuildCreate` spends 2,000,000 ualpha from the founder's
//! vault (1,000,000 burned, 1,000,000 becomes the new token's collateral). The
//! retired charter proof fields must be empty — they are never sent.

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::loop_util::parse_f64 as num;
use crate::mcp::send_guard::perm;

/// What founding a guild costs, from the founder's vault.
pub const GUILD_FOUNDING_UALPHA: u128 = 2_000_000;

// ── Rank sales (pure) ───────────────────────────────────────────────────────

/// A guild's rank-sale configuration as the chain stores it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RankSale {
    pub entry_rank: u64,
    pub base_price: u128,
    pub step_increase: u128,
    /// The best (lowest-numbered) rank on sale; 0 = sales disabled.
    pub minimum_rank: u64,
    pub join_enabled: bool,
}

impl RankSale {
    pub fn from_guild(g: &Value) -> Self {
        let g = g.get("Guild").unwrap_or(g);
        let n = |k: &str| num(g.get(k));
        Self {
            entry_rank: n("entryRank") as u64,
            base_price: exact(g.get("rankPurchaseBasePrice")),
            step_increase: exact(g.get("rankPurchaseStepIncrease")),
            minimum_rank: n("rankPurchaseMinimumRank") as u64,
            join_enabled: g.get("joinByRankPurchaseEnabled").is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true")),
        }
    }
}

/// A uint64 field, exactly (prices must not pass through f64).
fn exact(v: Option<&Value>) -> u128 {
    match v {
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as u128,
        _ => 0,
    }
}

/// `cost(n) = B·n + S·n·(n−1)/2` — the total paid to reach `n` steps of progress.
pub fn cost_to_progress(base: u128, step: u128, n: u128) -> u128 {
    base * n + step * (n * n.saturating_sub(1) / 2)
}

/// Price of moving to `target_rank`, from `current_rank` (a member) or from
/// outside the guild (`None`, admission). `Err` names why the chain would
/// refuse it.
pub fn rank_price(sale: &RankSale, current_rank: Option<u64>, target_rank: u64) -> Result<u128, String> {
    if sale.minimum_rank == 0 {
        return Err("this guild does not sell ranks".into());
    }
    if current_rank.is_none() && !sale.join_enabled {
        return Err("this guild does not admit new members by rank purchase".into());
    }
    if target_rank == 0 || target_rank < sale.minimum_rank {
        return Err(format!("this guild sells ranks down to {} only", sale.minimum_rank));
    }
    if target_rank > sale.entry_rank {
        return Err(format!("rank {target_rank} is below the guild's entry rank {}", sale.entry_rank));
    }
    let from = current_rank.map_or(0, |r| sale.entry_rank.saturating_sub(r));
    let to = sale.entry_rank - target_rank;
    if current_rank.is_some_and(|r| target_rank >= r) {
        return Err(format!("already at rank {} — a purchase must improve it", current_rank.unwrap_or(0)));
    }
    let (b, s) = (sale.base_price, sale.step_increase);
    Ok(cost_to_progress(b, s, to as u128) - cost_to_progress(b, s, from as u128))
}

// ── Chain reads ─────────────────────────────────────────────────────────────

fn primary_identity() -> Result<(String, String), String> {
    let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
    let pid = gs.player_id.clone().unwrap_or_default();
    let addr = gs.wallet_address.clone().unwrap_or_default();
    if pid.is_empty() || addr.is_empty() {
        return Err("primary identity not synced yet".into());
    }
    Ok((pid, addr))
}

/// Base units of `denom` in `owner`'s vault (0 for an unfunded vault).
async fn vault_balance(client: &CosmosClient, owner: &str, denom: &str) -> Result<u128, String> {
    let (vault, _) = client.vault(owner).await?;
    let coins = client.bank_balances(&vault).await?;
    Ok(coins
        .iter()
        .find(|c| c.get("denom").and_then(|d| d.as_str()) == Some(denom))
        .map(|c| exact(c.get("amount")))
        .unwrap_or(0))
}

/// Quote a rank purchase for the primary in `guild_id` (default: its own
/// guild). Read-only; the answer carries `refusal` when the chain would
/// refuse, and `price` otherwise.
pub async fn quote_rank(guild_id: Option<String>, target_rank: u64) -> Result<Value, String> {
    let (pid, address) = primary_identity()?;
    let client = CosmosClient::new();
    let player = client.query_entity("player", &pid).await?;
    let p = player.get("Player").cloned().unwrap_or(Value::Null);
    let own_guild = p.get("guildId").and_then(|g| g.as_str()).unwrap_or("").to_string();
    let guild_id = guild_id.filter(|g| !g.trim().is_empty()).unwrap_or_else(|| own_guild.clone());
    crate::mcp::send_guard::validate_owner_id("guild", &guild_id)?;
    if !guild_id.starts_with("0-") {
        return Err(format!("{guild_id} is not a guild id"));
    }
    let guild = client.query_entity("guild", &guild_id).await?;
    let sale = RankSale::from_guild(&guild);
    let member = own_guild == guild_id;
    let current_rank = member.then(|| num(p.get("guildRank")) as u64);
    let denom = format!("uguild.{guild_id}");
    let balance = vault_balance(&client, &pid, &denom).await.unwrap_or(0);

    let mut refusal = rank_price(&sale, current_rank, target_rank).err();
    let price = rank_price(&sale, current_rank, target_rank).unwrap_or(0);
    if refusal.is_none() && balance < price {
        refusal = Some(format!("the price is {price} {denom}; the vault holds {balance}"));
    }
    if refusal.is_none() {
        // Purchase and admission both need the key's membership AND
        // token-transfer bits, even when the price is zero.
        refusal = crate::mcp::send_guard::signer_lacks(&address, perm::GUILD_MEMBERSHIP | perm::TOKEN_TRANSFER, "guild-membership and token-transfer").await;
    }
    Ok(json!({
        "ok": refusal.is_none(),
        "refusal": refusal,
        "guild_id": guild_id,
        "member": member,
        "current_guild_id": own_guild,
        "current_rank": current_rank,
        "entry_rank": sale.entry_rank,
        "minimum_rank": sale.minimum_rank,
        "target_rank": target_rank,
        // Strings: exact uint64 amounts, never floats.
        "price": price.to_string(),
        "denom": denom,
        "denom_info": crate::guild_config::denom_registry().get(&format!("uguild.{guild_id}")).cloned(),
        "balance": balance.to_string(),
        "kind": if member { "rank_purchase" } else { "join_by_rank_purchase" },
    }))
}

/// Buy `target_rank` (or admission at it) for the primary. Re-quotes first;
/// `max_price` defaults to the fresh quote and may never be below it — the
/// chain rejects without payment when the price moved above it.
pub async fn purchase_rank(
    app: &tauri::AppHandle,
    guild_id: Option<String>,
    target_rank: u64,
    max_price: Option<u128>,
) -> Result<Value, String> {
    let q = quote_rank(guild_id, target_rank).await?;
    if q.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("refused: {}", q.get("refusal").and_then(|v| v.as_str()).unwrap_or("not purchasable")));
    }
    let price: u128 = q["price"].as_str().unwrap_or("0").parse().unwrap_or(0);
    let max_price = max_price.unwrap_or(price);
    if max_price < price {
        return Err(format!("refused: the price is {price}, above your maximum {max_price}"));
    }
    let guild_id = q["guild_id"].as_str().unwrap_or("").to_string();
    let (type_url, payload) = if q["member"].as_bool() == Some(true) {
        (
            "/structs.structs.MsgGuildRankPurchase",
            json!({
                "guildId": guild_id,
                "targetRank": target_rank.to_string(),
                "maxPrice": max_price.to_string(),
                "expectedRank": q["current_rank"].as_u64().unwrap_or(0).to_string(),
            }),
        )
    } else {
        (
            "/structs.structs.MsgGuildMembershipJoinByRankPurchase",
            json!({
                "guildId": guild_id,
                "targetRank": target_rank.to_string(),
                "maxPrice": max_price.to_string(),
                // Empty = "I expect to be guildless"; otherwise the guild being left.
                "expectedGuildId": q["current_guild_id"].as_str().unwrap_or(""),
            }),
        )
    };
    let res = crate::mcp::tx_retry::sign_as_primary(app, type_url, payload, "guild:rank_purchase").await?;
    Ok(json!({
        "ok": true,
        "quote": q,
        "max_price": max_price.to_string(),
        "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)"),
    }))
}

// ── Founding ────────────────────────────────────────────────────────────────

/// Pure checks on a founding request's own fields.
pub fn founding_fields_refusal(reactor_id: &str, endpoint: &str, entry_substation_id: &str) -> Option<String> {
    use crate::mcp::types::{ObjectId, ObjectKind};
    let is = |id: &str, kind: ObjectKind| ObjectId::parse(id).is_ok_and(|o| o.kind == kind);
    if !is(reactor_id, ObjectKind::Reactor) {
        return Some(format!("'{reactor_id}' is not a reactor id (they look like 3-1)"));
    }
    if !is(entry_substation_id, ObjectKind::Substation) {
        return Some(format!("'{entry_substation_id}' is not a substation id (they look like 4-1)"));
    }
    let e = endpoint.trim();
    if !(e.starts_with("https://") || e.starts_with("http://")) || e.len() < 12 || e.contains(char::is_whitespace) {
        return Some(format!("'{e}' is not an endpoint URL (the guild's guild.json)"));
    }
    None
}

/// Preview founding a guild as the primary: fields, the reactor and entry
/// substation exist (and the substation is not being deleted), the vault
/// holds the founding cost, and the device key may spend it.
pub async fn preview_found_guild(reactor_id: &str, endpoint: &str, entry_substation_id: &str) -> Result<Value, String> {
    let (pid, address) = primary_identity()?;
    let client = CosmosClient::new();
    let mut problems: Vec<String> = founding_fields_refusal(reactor_id, endpoint, entry_substation_id).into_iter().collect();
    if problems.is_empty() {
        if client.query_entity("reactor", reactor_id).await.is_err() {
            problems.push(format!("no reactor {reactor_id} on chain"));
        }
        match client.query_entity("substation", entry_substation_id).await {
            Ok(s) if crate::mcp::tools::board_pages::substation_deletion_pending(&s) => {
                problems.push(format!("substation {entry_substation_id} is pending deletion"));
            }
            Ok(_) => {}
            Err(_) => problems.push(format!("no substation {entry_substation_id} on chain")),
        }
    }
    let balance = vault_balance(&client, &pid, "ualpha").await.unwrap_or(0);
    if balance < GUILD_FOUNDING_UALPHA {
        problems.push(format!("founding costs {GUILD_FOUNDING_UALPHA} ualpha from your vault; it holds {balance}"));
    }
    if let Some(why) = crate::mcp::send_guard::signer_lacks(&address, perm::TOKEN_TRANSFER, "token-transfer").await {
        problems.push(why);
    }
    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "founder": pid,
        "cost_ualpha": GUILD_FOUNDING_UALPHA.to_string(),
        "burned_ualpha": "1000000",
        "collateral_ualpha": "1000000",
        "vault_ualpha": balance.to_string(),
    }))
}

/// Found a guild. Re-runs the preview; never sends the retired proof fields.
pub async fn found_guild(app: &tauri::AppHandle, reactor_id: &str, endpoint: &str, entry_substation_id: &str) -> Result<Value, String> {
    let preview = preview_found_guild(reactor_id, endpoint, entry_substation_id).await?;
    if preview.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let why: Vec<&str> = preview["problems"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        return Err(format!("refused: {}", why.join("; ")));
    }
    let res = crate::mcp::tx_retry::sign_as_primary(
        app,
        "/structs.structs.MsgGuildCreate",
        json!({ "reactorId": reactor_id, "endpoint": endpoint.trim(), "entrySubstationId": entry_substation_id }),
        "guild:found",
    )
    .await?;
    Ok(json!({
        "ok": true,
        "preview": preview,
        "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sale(base: u128, step: u128, minimum: u64, join: bool) -> RankSale {
        RankSale { entry_rank: 101, base_price: base, step_increase: step, minimum_rank: minimum, join_enabled: join }
    }

    /// The chain reference's own example: entry 101, base 10 tokens, step 5 —
    /// the first two steps cost 10 and 15 whole tokens.
    #[test]
    fn rank_price_matches_the_chain_reference_example() {
        let s = sale(10_000_000, 5_000_000, 1, true);
        assert_eq!(rank_price(&s, Some(101), 100).unwrap(), 10_000_000);
        assert_eq!(rank_price(&s, Some(101), 99).unwrap(), 25_000_000);
        assert_eq!(rank_price(&s, Some(100), 99).unwrap(), 15_000_000, "priced from current progress");
        // Admission starts from zero progress.
        assert_eq!(rank_price(&s, None, 99).unwrap(), 25_000_000);
    }

    #[test]
    fn rank_price_refuses_what_the_chain_refuses() {
        assert!(rank_price(&sale(1, 1, 0, true), Some(101), 99).unwrap_err().contains("does not sell"));
        assert!(rank_price(&sale(1, 1, 50, false), None, 99).unwrap_err().contains("admit"));
        assert!(rank_price(&sale(1, 1, 50, true), Some(101), 10).unwrap_err().contains("down to 50"));
        assert!(rank_price(&sale(1, 1, 50, true), Some(99), 99).unwrap_err().contains("improve"));
        assert!(rank_price(&sale(1, 1, 50, true), Some(101), 102).unwrap_err().contains("entry rank"));
        // A member already better than entry (rank 5 of entry 101) still
        // prices from its own progress: 96 → 97 steps.
        let s = sale(2, 1, 1, false);
        assert_eq!(rank_price(&s, Some(5), 4).unwrap(), cost_to_progress(2, 1, 97) - cost_to_progress(2, 1, 96));
    }

    #[test]
    fn sale_reads_the_live_guild_shape() {
        // 0-1 on chain, 2026-11-01: sales off.
        let g = json!({ "Guild": { "id": "0-1", "entryRank": "101", "rankPurchaseBasePrice": "0",
            "rankPurchaseStepIncrease": "0", "rankPurchaseMinimumRank": "0", "joinByRankPurchaseEnabled": false } });
        assert_eq!(RankSale::from_guild(&g), sale(0, 0, 0, false));
        let big = json!({ "rankPurchaseBasePrice": "18446744073709551615", "entryRank": "101" });
        assert_eq!(RankSale::from_guild(&big).base_price, u64::MAX as u128, "exact, not through f64");
    }

    #[test]
    fn founding_fields_are_checked_before_any_read() {
        assert!(founding_fields_refusal("3-1", "https://example.org/guild.json", "4-1").is_none());
        assert!(founding_fields_refusal("4-1", "https://example.org/guild.json", "4-1").is_some());
        assert!(founding_fields_refusal("3-1", "https://example.org/guild.json", "3-1").is_some());
        assert!(founding_fields_refusal("3-1", "example.org", "4-1").is_some());
        assert!(founding_fields_refusal("3-1", "https://exa mple.org/g.json", "4-1").is_some());
    }

    #[test]
    fn founding_and_rank_messages_encode() {
        use crate::mcp::chain_codec::encode;
        for (t, p) in [
            ("/structs.structs.MsgGuildCreate", json!({ "reactorId": "3-1", "endpoint": "https://e.org/guild.json", "entrySubstationId": "4-1" })),
            ("/structs.structs.MsgGuildRankPurchase", json!({ "guildId": "0-1", "targetRank": "99", "maxPrice": "25000000", "expectedRank": "101" })),
            ("/structs.structs.MsgGuildMembershipJoinByRankPurchase", json!({ "guildId": "0-1", "targetRank": "99", "maxPrice": "25000000", "expectedGuildId": "" })),
        ] {
            assert!(encode(t, &p, "structs1signer").is_ok_and(|b| b.len() > 20), "{t}");
        }
    }
}
