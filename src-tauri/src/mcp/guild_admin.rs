//! Guild management on chain v0.22: membership (invites, requests, kicks),
//! ranks and admin grants, and the guild's own settings — plus the player's
//! side of joining (request, accept or decline an invite).
//!
//! Every action is one chain message signed by a `founders::Signer` — the
//! primary's device key, or a founder's (`as: "<label>"`) — and every
//! action is previewed first: the
//! same `plan` builds the payload the writer signs, so a preview cannot show
//! one thing and sign another.
//!
//! v0.22 permission rules this follows (chain `docs/upgrades/v0.22.0.md`,
//! "Guild administration, ranks and dismissal", "Guild rank fallback",
//! "Guild join bypass level `member`"):
//! - Two layers: the SIGNING KEY must hold the bit itself, and the player must
//!   have standing on the guild (owner, a direct grant, or — for operational
//!   bits only — a rank grant). A refused key bit is certain; standing is
//!   reported as a warning, since rank standing has rules this does not model.
//! - Rank-register entries carrying Admin no longer make anyone an admin.
//!   Officers need Admin granted to them directly. `overview` lists who has
//!   which, so a guild can see who lost admin at the upgrade.
//! - Changing a member's rank needs Admin on the key; the actor must outrank
//!   the target and cannot hand out a better rank than their own.

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::founders::Signer;
use crate::mcp::loop_util::parse_f64 as num;
use crate::mcp::send_guard::signer_lacks;

/// Permission bits (chain `x/structs/types/permissions.go`, v0.22).
pub mod bits {
    pub const PLAY: u64 = 1;
    pub const ADMIN: u64 = 1 << 1;
    pub const UPDATE: u64 = 1 << 2;
    pub const DELETE: u64 = 1 << 3;
    pub const TOKEN_TRANSFER: u64 = 1 << 4;
    pub const TOKEN_INFUSE: u64 = 1 << 5;
    pub const TOKEN_MIGRATE: u64 = 1 << 6;
    pub const TOKEN_DEFUSE: u64 = 1 << 7;
    pub const SOURCE_ALLOCATION: u64 = 1 << 8;
    pub const GUILD_MEMBERSHIP: u64 = 1 << 9;
    pub const SUBSTATION_CONNECTION: u64 = 1 << 10;
    pub const ALLOCATION_CONNECTION: u64 = 1 << 11;
    pub const GUILD_TOKEN_BURN: u64 = 1 << 12;
    pub const GUILD_TOKEN_MINT: u64 = 1 << 13;
    pub const GUILD_ENDPOINT_UPDATE: u64 = 1 << 14;
    pub const GUILD_JOIN_CONSTRAINTS_UPDATE: u64 = 1 << 15;
    pub const GUILD_SUBSTATION_UPDATE: u64 = 1 << 16;
    pub const PROVIDER_WITHDRAW: u64 = 1 << 17;
    pub const PROVIDER_OPEN: u64 = 1 << 18;
    pub const REACTOR_GUILD_CREATE: u64 = 1 << 19;
    pub const HASH_BUILD: u64 = 1 << 20;
    pub const HASH_MINE: u64 = 1 << 21;
    pub const HASH_REFINE: u64 = 1 << 22;
    pub const HASH_RAID: u64 = 1 << 23;
    pub const GUILD_UGC_UPDATE: u64 = 1 << 24;

    pub const LABELS: [(u64, &str); 25] = [
        (PLAY, "play"),
        (ADMIN, "admin"),
        (UPDATE, "update"),
        (DELETE, "delete"),
        (TOKEN_TRANSFER, "token transfer"),
        (TOKEN_INFUSE, "token infuse"),
        (TOKEN_MIGRATE, "token migrate"),
        (TOKEN_DEFUSE, "token defuse"),
        (SOURCE_ALLOCATION, "source allocation"),
        (GUILD_MEMBERSHIP, "membership"),
        (SUBSTATION_CONNECTION, "substation connection"),
        (ALLOCATION_CONNECTION, "allocation connection"),
        (GUILD_TOKEN_BURN, "token burn"),
        (GUILD_TOKEN_MINT, "token mint"),
        (GUILD_ENDPOINT_UPDATE, "endpoint"),
        (GUILD_JOIN_CONSTRAINTS_UPDATE, "join rules"),
        (GUILD_SUBSTATION_UPDATE, "entry substation"),
        (PROVIDER_WITHDRAW, "provider withdraw"),
        (PROVIDER_OPEN, "provider open"),
        (REACTOR_GUILD_CREATE, "guild create"),
        (HASH_BUILD, "hash build"),
        (HASH_MINE, "hash mine"),
        (HASH_REFINE, "hash refine"),
        (HASH_RAID, "hash raid"),
        (GUILD_UGC_UPDATE, "names and pictures"),
    ];

    /// Every bit set in `v`, named.
    pub fn labels(v: u64) -> Vec<&'static str> {
        LABELS.iter().filter(|(b, _)| v & b != 0).map(|(_, l)| *l).collect()
    }

    /// The names of the bits in `need`, joined — for refusal messages.
    pub fn describe(need: u64) -> String {
        labels(need).join(" + ")
    }
}

/// Whether an action acts on the guild (an officer's move) or on the
/// signing player's own membership.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Side {
    Guild,
    Own,
}

/// One action, ready to preview or sign.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub action: String,
    pub side: Side,
    pub type_url: &'static str,
    pub payload: Value,
    /// Bits the signing key must hold itself.
    pub key_bits: u64,
    /// Bits the player needs on the guild (owner always has them). 0 = none.
    pub standing_bits: u64,
    /// The member this acts on, when there is one.
    pub target: Option<String>,
    pub summary: String,
}

/// Every action this module signs, for the MCP schema and the card.
pub const ACTIONS: &[&str] = &[
    "invite", "invite_revoke", "approve", "deny", "kick", "set_rank", "grant_admin", "revoke_admin",
    "entry_rank", "entry_substation", "join_minimum", "bypass_request", "bypass_invite", "endpoint",
    "name", "rank_sale", "convert_in_fee", "convert_out_fee", "request", "request_revoke",
    "accept_invite", "decline_invite", "join",
    "primary_reactor", "owner", "pfp", "rank_permission", "rank_permission_revoke",
    "join_proxy",
];

// ── Join by proxy ──────────────────────────────────────────────────────────
//
// `MsgGuildMembershipJoinProxy` (v0.23 `msg_server_guild_membership_join_proxy.go`):
// a member with Membership on the guild signs up a NEW address into the
// guild it is in — the proxy's own guild, never one named in the message.
// The joiner proves the address is theirs by signing
// `GUILD<guild>ADDRESS<address>NONCE<n>` with its key (secp256k1 over
// SHA-256, 64-byte r||s, hex) and handing over the 33-byte compressed
// public key (hex); n is the address's proxy nonce (grid attribute 11,
// 0 for an address the chain has never seen), bumped by every proxy join.

/// The exact text a joiner signs for a proxy join.
pub fn join_proxy_challenge(guild: &str, address: &str, nonce: u64) -> String {
    format!("GUILD{guild}ADDRESS{address}NONCE{nonce}")
}

/// Pure: whether `pubkey_hex` is `address`'s key and `sig_hex` signs the
/// challenge — the two checks the chain makes, made before anything is sent.
pub fn verify_join_proof(guild: &str, address: &str, nonce: u64, pubkey_hex: &str, sig_hex: &str) -> Result<(), String> {
    use k256::ecdsa::signature::Verifier;
    let pk = hex::decode(pubkey_hex.trim()).map_err(|_| "proof_pub_key is not hex".to_string())?;
    if pk.len() != 33 {
        return Err("proof_pub_key must be the 33-byte compressed key".into());
    }
    let derived = cosmrs::crypto::secp256k1::VerifyingKey::from_sec1_bytes(&pk)
        .map(cosmrs::crypto::PublicKey::from)
        .map_err(|_| "proof_pub_key is not a secp256k1 key".to_string())?
        .account_id("structs")
        .map_err(|e| e.to_string())?
        .to_string();
    if derived != address {
        return Err(format!("proof_pub_key belongs to {derived}, not {address}"));
    }
    let sig = hex::decode(sig_hex.trim()).map_err(|_| "proof_signature is not hex".to_string())?;
    if !(64..=65).contains(&sig.len()) {
        return Err("proof_signature must be 64 or 65 bytes".into());
    }
    let vk = k256::ecdsa::VerifyingKey::from_sec1_bytes(&pk).map_err(|_| "proof_pub_key is not a secp256k1 key".to_string())?;
    let sig = k256::ecdsa::Signature::from_slice(&sig[..64]).map_err(|_| "proof_signature is malformed".to_string())?;
    vk.verify(join_proxy_challenge(guild, address, nonce).as_bytes(), &sig)
        .map_err(|_| format!("proof_signature does not sign \"{}\"", join_proxy_challenge(guild, address, nonce)))
}

/// The address's proxy nonce and player id (if the chain knows it).
pub async fn proxy_nonce(client: &CosmosClient, address: &str) -> (u64, Option<String>) {
    let pid = client
        .lcd_get(&format!("/structs/address/{address}"))
        .await
        .ok()
        .and_then(|v| v.get("playerId").and_then(|p| p.as_str()).map(String::from))
        .filter(|p| !p.is_empty() && p != "1-0");
    let Some(pid) = pid else { return (0, None) };
    let n = client
        .lcd_get(&format!("/structs/grid/11-{pid}"))
        .await
        .ok()
        .map(|v| num(v.pointer("/gridRecord/value")) as u64)
        .unwrap_or(0);
    (n, Some(pid))
}

/// What a joiner must sign so `signer` can proxy-join them into `signer`'s
/// guild — read-only, for the front-end that collects the proof.
pub async fn join_proxy_challenge_for(signer: &Signer, address: &str) -> Result<Value, String> {
    let address = address.trim();
    if !address.starts_with("structs1") {
        return Err(format!("'{address}' is not a structs address"));
    }
    let client = CosmosClient::new();
    let p = client.query_entity("player", &signer.player_id).await?;
    let guild = p.pointer("/Player/guildId").and_then(|g| g.as_str()).unwrap_or("").to_string();
    if !guild.starts_with("0-") {
        return Err(format!("{} is in no guild, so it cannot proxy anyone in", signer.who()));
    }
    let (nonce, pid) = proxy_nonce(&client, address).await;
    Ok(json!({
        "ok": true,
        "signed_as": signer.describe(),
        "guild_id": guild,
        "address": address,
        "existing_player": pid,
        "nonce": nonce,
        "challenge": join_proxy_challenge(&guild, address, nonce),
        "how": "the joiner signs `challenge` (UTF-8 bytes, secp256k1 over SHA-256) with the address's key; send join_proxy {address, proof_pub_key: 33-byte compressed hex, proof_signature: 64-byte r||s hex}",
    }))
}

/// Permission bits from a number, or from names (`bits::LABELS`, `_` for
/// spaces) given as an array or a comma-separated string.
pub fn bits_arg(args: &Value, k: &str) -> Result<u64, String> {
    let from_name = |n: &str| -> Result<u64, String> {
        let n = n.trim().to_ascii_lowercase().replace('_', " ");
        bits::LABELS.iter().find(|(_, l)| *l == n).map(|(b, _)| *b).ok_or_else(|| format!("'{n}' is not a permission ({})", bits::LABELS.iter().map(|(_, l)| l.replace(' ', "_")).collect::<Vec<_>>().join(", ")))
    };
    let v = match args.get(k) {
        Some(Value::Number(n)) => n.as_u64().ok_or_else(|| format!("{k} must be a whole number"))?,
        Some(Value::String(t)) if t.trim().chars().all(|c| c.is_ascii_digit()) && !t.trim().is_empty() => t.trim().parse().map_err(|_| format!("{k} is too large"))?,
        Some(Value::String(t)) => t.split(',').filter(|x| !x.trim().is_empty()).map(from_name).collect::<Result<Vec<_>, _>>()?.into_iter().fold(0, |a, b| a | b),
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().ok_or_else(|| format!("{k}: names are strings")).and_then(from_name)).collect::<Result<Vec<_>, _>>()?.into_iter().fold(0, |a, b| a | b),
        _ => return Err(format!("{k} is required (a number, or names like membership,substation_connection)")),
    };
    if v == 0 {
        return Err(format!("{k} names no permission"));
    }
    if v & !crate::mcp::delegation::PERM_ALL != 0 {
        return Err(format!("{k} has bits beyond the 25 the chain knows"));
    }
    Ok(v)
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

fn arg_bool(args: &Value, k: &str) -> bool {
    match args.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.trim(), "true" | "yes" | "on" | "1"),
        _ => false,
    }
}

fn id_of_kind(id: &str, kind: crate::mcp::types::ObjectKind, what: &str, example: &str) -> Result<String, String> {
    match crate::mcp::types::ObjectId::parse(id) {
        Ok(o) if o.kind == kind => Ok(id.to_string()),
        _ => Err(format!("'{id}' is not a {what} id (they look like {example})")),
    }
}

fn player_arg(args: &Value) -> Result<String, String> {
    let p = arg_str(args, "player").ok_or("player is required")?;
    id_of_kind(&p, crate::mcp::types::ObjectKind::Player, "player", "1-42")
}

fn substation_arg(args: &Value) -> Result<String, String> {
    match arg_str(args, "substation") {
        Some(s) => id_of_kind(&s, crate::mcp::types::ObjectKind::Substation, "substation", "4-1"),
        None => Ok(String::new()),
    }
}

/// A fraction between 0 and 1 as the chain's LegacyDec wire form: the value
/// times 10^18 as an integer string ("0.05" → "50000000000000000"). The
/// codec sends string fields as given, and gogoproto's LegacyDec unmarshals
/// that integer form — a plain "0.05" would be refused at decode.
pub fn legacy_dec_wire(s: &str) -> Result<String, String> {
    let s = s.trim().trim_end_matches('%');
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty() && frac.is_empty() || !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("'{s}' is not a decimal fraction like 0.05"));
    }
    if frac.len() > 18 {
        return Err("at most 18 decimal places".into());
    }
    let whole: u128 = if whole.is_empty() { 0 } else { whole.parse().map_err(|_| format!("'{s}' is too large"))? };
    let frac_val: u128 = if frac.is_empty() { 0 } else { format!("{frac:0<18}").parse().unwrap_or(0) };
    let wire = whole.checked_mul(1_000_000_000_000_000_000).and_then(|w| w.checked_add(frac_val)).ok_or("too large")?;
    if wire > 1_000_000_000_000_000_000 {
        return Err(format!("a fee is a fraction of 1 (0.05 = 5%); {s} is more than 1"));
    }
    Ok(wire.to_string())
}

/// Pure: validate `args` for `action` in `guild_id` and build the message.
/// `me` is the signing player's id (for the actions on one's own membership).
pub fn plan(guild_id: &str, me: &str, action: &str, args: &Value) -> Result<Plan, String> {
    use bits::*;
    if !guild_id.starts_with("0-") || crate::mcp::send_guard::validate_owner_id("guild", guild_id).is_err() {
        return Err(format!("'{guild_id}' is not a guild id (they look like 0-1)"));
    }
    let g = guild_id;
    let mk = |action: &str, side: Side, type_url: &'static str, payload: Value, key_bits: u64, standing_bits: u64, target: Option<String>, summary: String| Plan {
        action: action.to_string(),
        side,
        type_url,
        payload,
        key_bits,
        standing_bits,
        target,
        summary,
    };
    let p = match action {
        "invite" => {
            let who = player_arg(args)?;
            let sub = substation_arg(args)?;
            let at = if sub.is_empty() { String::new() } else { format!(", connected to {sub}") };
            mk(action, Side::Guild, "/structs.structs.MsgGuildMembershipInvite",
               json!({ "guildId": g, "playerId": who, "substationId": sub }),
               GUILD_MEMBERSHIP, GUILD_MEMBERSHIP, Some(who.clone()), format!("Invite {who} to {g}{at}"))
        }
        "invite_revoke" => {
            let who = player_arg(args)?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildMembershipInviteRevoke",
               json!({ "guildId": g, "playerId": who }),
               GUILD_MEMBERSHIP, GUILD_MEMBERSHIP, Some(who.clone()), format!("Withdraw {g}'s invite to {who}"))
        }
        "approve" => {
            let who = player_arg(args)?;
            let sub = substation_arg(args)?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildMembershipRequestApprove",
               json!({ "guildId": g, "playerId": who, "substationId": sub }),
               GUILD_MEMBERSHIP, GUILD_MEMBERSHIP, Some(who.clone()), format!("Admit {who} to {g}"))
        }
        "deny" => {
            let who = player_arg(args)?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildMembershipRequestDeny",
               json!({ "guildId": g, "playerId": who }),
               GUILD_MEMBERSHIP, GUILD_MEMBERSHIP, Some(who.clone()), format!("Turn down {who}'s request to join {g}"))
        }
        "kick" => {
            let who = player_arg(args)?;
            if who == me {
                return Err("you cannot kick yourself".into());
            }
            mk(action, Side::Guild, "/structs.structs.MsgGuildMembershipKick",
               json!({ "guildId": g, "playerId": who }),
               GUILD_MEMBERSHIP, GUILD_MEMBERSHIP, Some(who.clone()), format!("Remove {who} from {g}"))
        }
        "set_rank" => {
            let who = player_arg(args)?;
            let rank = arg_u64(args, "rank")?;
            if rank == 0 {
                return Err("rank 0 is not a rank (1 is the best)".into());
            }
            mk(action, Side::Guild, "/structs.structs.MsgPlayerUpdateGuildRank",
               json!({ "playerId": who, "guildRank": rank.to_string(), "guildId": g }),
               ADMIN, 0, Some(who.clone()), format!("Set {who}'s rank in {g} to {rank}"))
        }
        "grant_admin" | "revoke_admin" => {
            let who = player_arg(args)?;
            let grant = action == "grant_admin";
            mk(action, Side::Guild,
               if grant { "/structs.structs.MsgPermissionGrantOnObject" } else { "/structs.structs.MsgPermissionRevokeOnObject" },
               json!({ "objectId": g, "playerId": who, "permissions": ADMIN.to_string() }),
               ADMIN, ADMIN, Some(who.clone()),
               if grant { format!("Make {who} an admin of {g}") } else { format!("Take admin on {g} away from {who}") })
        }
        "entry_rank" => {
            let rank = arg_u64(args, "rank")?;
            if rank == 0 {
                return Err("rank 0 is not a rank (1 is the best)".into());
            }
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateEntryRank",
               json!({ "newEntryRank": rank.to_string(), "guildId": g }),
               ADMIN, ADMIN, None, format!("New members of {g} start at rank {rank}"))
        }
        "entry_substation" => {
            let sub = substation_arg(args)?;
            if sub.is_empty() {
                return Err("substation is required".into());
            }
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateEntrySubstationId",
               json!({ "guildId": g, "entrySubstationId": sub }),
               GUILD_SUBSTATION_UPDATE | SUBSTATION_CONNECTION, GUILD_SUBSTATION_UPDATE, None,
               format!("New members of {g} connect to {sub}"))
        }
        "join_minimum" => {
            let amount = arg_u64(args, "amount")?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateJoinInfusionMinimum",
               json!({ "guildId": g, "joinInfusionMinimum": amount.to_string() }),
               GUILD_JOIN_CONSTRAINTS_UPDATE, GUILD_JOIN_CONSTRAINTS_UPDATE, None,
               format!("Joining {g} directly needs {amount} ualpha infused"))
        }
        "bypass_request" | "bypass_invite" => {
            let level = arg_str(args, "level").unwrap_or_default();
            if !matches!(level.as_str(), "closed" | "permissioned" | "member") {
                return Err("level is closed, permissioned or member".into());
            }
            let by_request = action == "bypass_request";
            mk(action, Side::Guild,
               if by_request { "/structs.structs.MsgGuildUpdateJoinInfusionMinimumBypassByRequest" } else { "/structs.structs.MsgGuildUpdateJoinInfusionMinimumBypassByInvite" },
               json!({ "guildId": g, "guildJoinBypassLevel": level }),
               GUILD_JOIN_CONSTRAINTS_UPDATE, GUILD_JOIN_CONSTRAINTS_UPDATE, None,
               format!("Who may waive the stake minimum by {}: {level}", if by_request { "request" } else { "invite" }))
        }
        "endpoint" => {
            let e = arg_str(args, "endpoint").ok_or("endpoint is required")?;
            if !(e.starts_with("https://") || e.starts_with("http://")) || e.contains(char::is_whitespace) {
                return Err(format!("'{e}' is not an endpoint URL (the guild's guild.json)"));
            }
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateEndpoint",
               json!({ "guildId": g, "endpoint": e }),
               GUILD_ENDPOINT_UPDATE, GUILD_ENDPOINT_UPDATE, None, format!("{g}'s endpoint becomes {e}"))
        }
        "name" => {
            let n = arg_str(args, "name").ok_or("name is required")?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateName",
               json!({ "guildId": g, "name": n }),
               UPDATE, UPDATE, None, format!("Rename {g} to {n}"))
        }
        "rank_sale" => {
            let base = arg_u64(args, "base").unwrap_or(0);
            let step = arg_u64(args, "step").unwrap_or(0);
            let minimum = arg_u64(args, "minimum_rank")?;
            let join = arg_bool(args, "join_enabled");
            if minimum == 0 && join {
                return Err("admission by purchase needs ranks on sale (a minimum rank above 0)".into());
            }
            let summary = if minimum == 0 {
                format!("Stop selling ranks in {g}")
            } else {
                format!("{g} sells ranks down to {minimum}: first step {base}, each next step {step} more{}",
                        if join { ", and non-members may buy their way in" } else { "" })
            };
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateRankPurchase",
               json!({ "guildId": g, "basePrice": base.to_string(), "stepIncrease": step.to_string(),
                       "minimumRank": minimum.to_string(), "joinByRankPurchaseEnabled": join }),
               ADMIN, ADMIN, None, summary)
        }
        "convert_in_fee" | "convert_out_fee" => {
            let fee = arg_str(args, "fee").ok_or("fee is required (a fraction, 0.05 = 5%)")?;
            let wire = legacy_dec_wire(&fee)?;
            let inbound = action == "convert_in_fee";
            mk(action, Side::Guild,
               if inbound { "/structs.structs.MsgGuildUpdateBankConvertInFee" } else { "/structs.structs.MsgGuildUpdateBankConvertOutFee" },
               if inbound { json!({ "guildId": g, "bankConvertInFee": wire }) } else { json!({ "guildId": g, "bankConvertOutFee": wire }) },
               ADMIN, ADMIN, None,
               format!("{g}'s fee for converting {} its token: {fee}", if inbound { "into" } else { "out of" }))
        }
        "request" => {
            let sub = substation_arg(args)?;
            mk(action, Side::Own, "/structs.structs.MsgGuildMembershipRequest",
               json!({ "guildId": g, "playerId": me, "substationId": sub }),
               GUILD_MEMBERSHIP, 0, None, format!("Ask to join {g}"))
        }
        "request_revoke" => mk(action, Side::Own, "/structs.structs.MsgGuildMembershipRequestRevoke",
            json!({ "guildId": g, "playerId": me }), GUILD_MEMBERSHIP, 0, None, format!("Withdraw your request to join {g}")),
        "accept_invite" => {
            let sub = substation_arg(args)?;
            mk(action, Side::Own, "/structs.structs.MsgGuildMembershipInviteApprove",
               json!({ "guildId": g, "playerId": me, "substationId": sub }),
               GUILD_MEMBERSHIP, 0, None, format!("Accept {g}'s invite"))
        }
        "decline_invite" => mk(action, Side::Own, "/structs.structs.MsgGuildMembershipInviteDeny",
            json!({ "guildId": g, "playerId": me }), GUILD_MEMBERSHIP, 0, None, format!("Decline {g}'s invite")),
        // Direct join. `infusions` are the ids the stake minimum is counted
        // from; `preview` fills them in from the chain, and `execute` signs
        // the previewed payload, so the two never differ.
        "join" => {
            let sub = substation_arg(args)?;
            let infusions: Vec<String> = args
                .get("infusions")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            mk(action, Side::Own, "/structs.structs.MsgGuildMembershipJoin",
               json!({ "guildId": g, "playerId": me, "substationId": sub, "infusionId": infusions }),
               GUILD_MEMBERSHIP, 0, None, format!("Join {g}"))
        }
        "primary_reactor" => {
            let r = arg_str(args, "reactor").ok_or("reactor is required")?;
            let r = id_of_kind(&r, crate::mcp::types::ObjectKind::Reactor, "reactor", "3-1")?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdatePrimaryReactor",
               json!({ "guildId": g, "reactorId": r }),
               ADMIN, ADMIN, None, format!("{g}'s primary reactor becomes {r}"))
        }
        "owner" => {
            let who = player_arg(args)?;
            if who == me {
                return Err(format!("you already own {g}"));
            }
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdateOwnerId",
               json!({ "guildId": g, "owner": who }),
               0, 0, Some(who.clone()),
               format!("Hand {g} to {who}: they own it, its vault and everything it owns; you keep only what they grant back"))
        }
        "pfp" => {
            let pfp = arg_str(args, "pfp").ok_or("pfp is required")?;
            mk(action, Side::Guild, "/structs.structs.MsgGuildUpdatePfp",
               json!({ "guildId": g, "pfp": pfp }),
               UPDATE, UPDATE, None, format!("Set {g}'s picture"))
        }
        "rank_permission" | "rank_permission_revoke" => {
            let object = arg_str(args, "object").unwrap_or_else(|| g.to_string());
            if crate::mcp::types::ObjectId::parse(&object).is_err() {
                return Err(format!("'{object}' is not an object id"));
            }
            let perms = bits_arg(args, "permissions")?;
            if perms & ADMIN != 0 {
                return Err("Admin is never rank-derived on v0.22+; grant it directly with grant_admin".into());
            }
            let on_guild = object == g;
            if action == "rank_permission" {
                let rank = arg_u64(args, "rank")?;
                if rank == 0 {
                    return Err("rank 0 is not a rank (1 is the best)".into());
                }
                mk(action, Side::Guild, "/structs.structs.MsgPermissionGuildRankSet",
                   json!({ "objectId": object, "guildId": g, "permission": perms.to_string(), "rank": rank.to_string() }),
                   ADMIN | perms, if on_guild { ADMIN } else { 0 }, None,
                   format!("Members of {g} at rank {rank} or better may {} on {object}", bits::describe(perms)))
            } else {
                mk(action, Side::Guild, "/structs.structs.MsgPermissionGuildRankRevoke",
                   json!({ "objectId": object, "guildId": g, "permission": perms.to_string() }),
                   ADMIN, if on_guild { ADMIN } else { 0 }, None,
                   format!("No rank in {g} confers {} on {object} any more", bits::describe(perms)))
            }
        }
        "join_proxy" => {
            let address = arg_str(args, "address").ok_or("address is required (the joiner's structs1… address)")?;
            if !address.starts_with("structs1") {
                return Err(format!("'{address}' is not a structs address"));
            }
            let pk = arg_str(args, "proof_pub_key").ok_or("proof_pub_key is required (join_proxy_challenge says what to sign)")?;
            let sig = arg_str(args, "proof_signature").ok_or("proof_signature is required")?;
            let sub = substation_arg(args)?;
            let name = arg_str(args, "name").unwrap_or_default();
            let at = if sub.is_empty() { " (entry substation)".to_string() } else { format!(", connected to {sub}") };
            mk(action, Side::Guild, "/structs.structs.MsgGuildMembershipJoinProxy",
               json!({
                   "address": address, "substationId": sub, "proofPubKey": pk, "proofSignature": sig,
                   "playerName": name,
                   "playerPfp": arg_str(args, "pfp").unwrap_or_default(),
                   "playerPfpClientRenderAttributes": arg_str(args, "pfp_attributes").unwrap_or_default(),
               }),
               GUILD_MEMBERSHIP | if sub.is_empty() { 0 } else { SUBSTATION_CONNECTION }, GUILD_MEMBERSHIP, None,
               format!("Sign {address} up into {g}{at}"))
        }
        other => return Err(format!("unknown guild action '{other}' (one of: {})", ACTIONS.join(", "))),
    };
    Ok(p)
}

// ── Chain reads ─────────────────────────────────────────────────────────────

/// Every row of a list endpoint, following `next_key` (v0.22 pages hold 1000).
async fn walk(client: &CosmosClient, path: &str, list_key: &str) -> Result<Vec<Value>, String> {
    let mut rows = Vec::new();
    let mut key: Option<String> = None;
    for _ in 0..50 {
        let sep = if path.contains('?') { '&' } else { '?' };
        let url = match &key {
            Some(k) => format!("{path}{sep}pagination.limit=1000&pagination.key={}", crate::mcp::cosmos_client::encode_pagination_key(k)),
            None => format!("{path}{sep}pagination.limit=1000"),
        };
        let page = client.lcd_get(&url).await?;
        if let Some(Value::Array(a)) = page.get(list_key) {
            rows.extend(a.iter().cloned());
        }
        key = page.pointer("/pagination/next_key").and_then(|k| k.as_str()).filter(|k| !k.is_empty()).map(String::from);
        if key.is_none() {
            return Ok(rows);
        }
    }
    Err(format!("{path}: more than 50 pages"))
}

/// Direct grants on `object`: player id → bits.
pub fn parse_object_grants(rows: &[Value], object: &str) -> Vec<(String, u64)> {
    let prefix = format!("{object}@");
    let mut out: Vec<(String, u64)> = rows
        .iter()
        .filter_map(|r| {
            let id = r.get("permissionId")?.as_str()?;
            let who = id.strip_prefix(&prefix)?;
            // Grantees are players; anything else is not an officer.
            if !crate::mcp::types::ObjectId::parse(who).is_ok_and(|o| o.kind == crate::mcp::types::ObjectKind::Player) {
                return None;
            }
            let v = r.get("value").and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))?;
            (v != 0).then(|| (who.to_string(), v))
        })
        .collect();
    out.sort();
    out
}

/// Rank grants on a guild: (rank, bits) — "rank N or better holds these".
pub fn parse_rank_grants(rows: &[Value], guild: &str) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = rows
        .iter()
        .filter(|r| r.get("guildId").and_then(|g| g.as_str()) == Some(guild))
        .filter_map(|r| Some((num(r.get("rank")) as u64, num(r.get("permissions")) as u64)))
        .filter(|(_, b)| *b != 0)
        .collect();
    out.sort();
    out
}

/// The bits a rank grant gives a member at `rank` (lower numbers are better).
pub fn rank_bits(grants: &[(u64, u64)], rank: u64) -> u64 {
    grants.iter().filter(|(r, _)| rank > 0 && rank <= *r).fold(0, |acc, (_, b)| acc | b)
}

/// Pure: standing problems for `plan` given what the chain holds. Admin can
/// only come from ownership or a direct grant (v0.22); other bits may also
/// come from a rank grant.
pub fn standing_gap(plan: &Plan, owner: bool, direct: u64, ranked: u64) -> Option<String> {
    if plan.standing_bits == 0 || owner {
        return None;
    }
    let via_rank = if plan.standing_bits & bits::ADMIN != 0 { 0 } else { ranked };
    let have = direct | via_rank;
    (have & plan.standing_bits != plan.standing_bits).then(|| {
        format!(
            "you hold no {} grant on this guild{}",
            bits::describe(plan.standing_bits & !have),
            if plan.standing_bits & bits::ADMIN != 0 { " (since v0.22 admin must be granted directly — a rank no longer gives it)" } else { "" }
        )
    })
}

/// Everything an officer (or a would-be member) needs to see about a guild:
/// its settings, who holds which grants on it, the rank grants (flagging the
/// ones that carry admin the chain no longer honours), pending invites and
/// requests, and the signing player's own standing.
pub async fn overview(guild_id: Option<String>) -> Result<Value, String> {
    overview_as(&Signer::primary()?, guild_id).await
}

/// [`overview`] seen by any signer: "me" is that signer, and a founder's
/// default guild is the one it is in (the one it founded).
pub async fn overview_as(signer: &Signer, guild_id: Option<String>) -> Result<Value, String> {
    let (me, address) = (signer.player_id.clone(), signer.address.clone());
    let client = CosmosClient::new();
    let player = client.query_entity("player", &me).await?;
    let p = player.get("Player").cloned().unwrap_or(Value::Null);
    let own_guild = p.get("guildId").and_then(|g| g.as_str()).unwrap_or("").to_string();
    let my_rank = num(p.get("guildRank")) as u64;
    let guild_id = guild_id.filter(|g| !g.trim().is_empty()).map(|g| g.trim().to_string()).unwrap_or_else(|| own_guild.clone());
    if !guild_id.starts_with("0-") {
        return Err(if guild_id.is_empty() { "you are not in a guild — name one".into() } else { format!("{guild_id} is not a guild id") });
    }
    let guild = client.query_entity("guild", &guild_id).await?;
    let g = guild.get("Guild").cloned().unwrap_or(Value::Null);
    let owner = g.get("owner").and_then(|o| o.as_str()).unwrap_or("").to_string();

    let grants = walk(&client, &format!("/structs/permission/object/{guild_id}"), "permissionRecords")
        .await
        .map(|rows| parse_object_grants(&rows, &guild_id))
        .unwrap_or_default();
    let rank_grants = client
        .lcd_get(&format!("/structs/guild_rank_permission/object/{guild_id}/guild/{guild_id}"))
        .await
        .ok()
        .and_then(|v| v.get("guild_rank_permission_records").and_then(|a| a.as_array()).cloned())
        .map(|rows| parse_rank_grants(&rows, &guild_id))
        .unwrap_or_default();
    let applications = walk(&client, "/structs/guild_membership_application", "GuildMembershipApplication")
        .await
        .unwrap_or_default();

    let member = own_guild == guild_id;
    let is_owner = owner == me;
    let my_direct = grants.iter().find(|(w, _)| *w == me).map(|(_, b)| *b).unwrap_or(0);
    let my_ranked = if member { rank_bits(&rank_grants, my_rank) } else { 0 };
    let key_bits = client.address_record(&address).await.map(|(_, b)| b).ok();

    let pending: Vec<Value> = applications
        .iter()
        .filter(|a| a.get("guildId").and_then(|g| g.as_str()) == Some(guild_id.as_str()) || a.get("playerId").and_then(|p| p.as_str()) == Some(me.as_str()))
        .map(|a| json!({
            "guild_id": a.get("guildId"),
            "player_id": a.get("playerId"),
            "kind": a.get("joinType"),
            "status": a.get("registrationStatus"),
            "proposer": a.get("proposer"),
            "substation_id": a.get("substationId"),
            "mine": a.get("playerId").and_then(|p| p.as_str()) == Some(me.as_str()),
        }))
        .collect();

    // Members from the perception snapshot (already the whole galaxy).
    // None when the snapshot has not loaded: "unknown", never 0 members.
    let (member_count, officers) = match crate::mcp::perception::with_snapshot(|s| {
        let entry = num(g.get("entryRank")) as u64;
        let mut count = 0usize;
        let mut officers: Vec<(u64, String)> = Vec::new();
        for (id, v) in s.players.iter() {
            if v.get("guildId").and_then(|x| x.as_str()) != Some(guild_id.as_str()) {
                continue;
            }
            count += 1;
            let r = num(v.get("guildRank")) as u64;
            if r > 0 && (entry == 0 || r < entry) {
                officers.push((r, id.clone()));
            }
        }
        officers.sort();
        officers.truncate(40);
        (count, officers)
    }) {
        Some((c, o)) => (Some(c), o),
        None => (None, Vec::new()),
    };

    let admins: Vec<Value> = grants
        .iter()
        .map(|(who, b)| json!({ "player_id": who, "bits": b.to_string(), "labels": bits::labels(*b), "admin": b & bits::ADMIN != 0, "owner": *who == owner }))
        .collect();
    let ranks: Vec<Value> = rank_grants
        .iter()
        .map(|(r, b)| json!({
            "rank": r, "bits": b.to_string(), "labels": bits::labels(*b),
            // v0.22: a rank entry carrying admin is stored but confers nothing.
            "stale_admin": b & bits::ADMIN != 0,
        }))
        .collect();

    Ok(json!({
        "ok": true,
        "guild_id": guild_id,
        "name": g.get("name"),
        "owner": owner,
        "endpoint": g.get("endpoint"),
        "entry_rank": num(g.get("entryRank")) as u64,
        "entry_substation_id": g.get("entrySubstationId"),
        "primary_reactor_id": g.get("primaryReactorId"),
        "join_minimum": g.get("joinInfusionMinimum"),
        "bypass_by_request": g.get("joinInfusionMinimumBypassByRequest"),
        "bypass_by_invite": g.get("joinInfusionMinimumBypassByInvite"),
        "convert_in_fee": g.get("bankConvertInFee"),
        "convert_out_fee": g.get("bankConvertOutFee"),
        "rank_sale": {
            "base_price": g.get("rankPurchaseBasePrice"),
            "step_increase": g.get("rankPurchaseStepIncrease"),
            "minimum_rank": g.get("rankPurchaseMinimumRank"),
            "join_enabled": g.get("joinByRankPurchaseEnabled"),
        },
        "member_count": member_count,
        "officers": officers.iter().map(|(r, id)| json!({ "player_id": id, "rank": r })).collect::<Vec<_>>(),
        "grants": admins,
        "rank_grants": ranks,
        "pending": pending,
        "me": {
            "player_id": me,
            "member": member,
            "rank": member.then_some(my_rank),
            "owner": is_owner,
            "direct_bits": bits::labels(my_direct),
            "rank_bits": bits::labels(my_ranked),
            "admin": is_owner || my_direct & bits::ADMIN != 0,
            "key_bits": key_bits.map(bits::labels),
        },
    }))
}

/// Check `action` without signing: the plan, plus every reason the chain
/// would refuse that this can see (key bits certainly; standing, rank order
/// and member/application state as warnings).
pub async fn preview(guild_id: Option<String>, action: &str, args: &Value) -> Result<Value, String> {
    preview_as(&Signer::primary()?, guild_id, action, args).await
}

pub async fn preview_as(signer: &Signer, guild_id: Option<String>, action: &str, args: &Value) -> Result<Value, String> {
    let (me, address) = (signer.player_id.clone(), signer.address.clone());
    let client = CosmosClient::new();
    let player = client.query_entity("player", &me).await?;
    let p = player.get("Player").cloned().unwrap_or(Value::Null);
    let own_guild = p.get("guildId").and_then(|g| g.as_str()).unwrap_or("").to_string();
    let my_rank = num(p.get("guildRank")) as u64;
    let guild_id = guild_id.filter(|g| !g.trim().is_empty()).map(|g| g.trim().to_string()).unwrap_or_else(|| own_guild.clone());
    let mut plan = plan(&guild_id, &me, action, args)?;

    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let guild = client.query_entity("guild", &guild_id).await.map_err(|e| format!("guild {guild_id}: {e}"))?;
    let g = guild.get("Guild").cloned().unwrap_or(Value::Null);
    let owner = g.get("owner").and_then(|o| o.as_str()) == Some(me.as_str());
    let member = own_guild == guild_id;

    if let Some(why) = signer_lacks(&address, plan.key_bits, &bits::describe(plan.key_bits)).await {
        problems.push(why);
    }

    if plan.side == Side::Guild {
        let direct = walk(&client, &format!("/structs/permission/object/{guild_id}"), "permissionRecords")
            .await
            .map(|rows| parse_object_grants(&rows, &guild_id))
            .unwrap_or_default()
            .into_iter()
            .find(|(w, _)| *w == me)
            .map(|(_, b)| b)
            .unwrap_or(0);
        let ranked = if member {
            client
                .lcd_get(&format!("/structs/guild_rank_permission/object/{guild_id}/guild/{guild_id}"))
                .await
                .ok()
                .and_then(|v| v.get("guild_rank_permission_records").and_then(|a| a.as_array()).cloned())
                .map(|rows| rank_bits(&parse_rank_grants(&rows, &guild_id), my_rank))
                .unwrap_or(0)
        } else {
            0
        };
        if let Some(gap) = standing_gap(&plan, owner, direct, ranked) {
            warnings.push(gap);
        }
    }

    // The member this acts on, where it matters.
    if let Some(target) = &plan.target {
        let t = client.query_entity("player", target).await.ok().and_then(|v| v.get("Player").cloned());
        let t_guild = t.as_ref().and_then(|t| t.get("guildId")).and_then(|g| g.as_str()).unwrap_or("").to_string();
        let t_rank = t.as_ref().map(|t| num(t.get("guildRank")) as u64).unwrap_or(0);
        match (action, t.is_some()) {
            (_, false) => problems.push(format!("no player {target} on chain")),
            ("kick" | "set_rank", _) if t_guild != guild_id => problems.push(format!("{target} is not a member of {guild_id}")),
            ("invite", _) if t_guild == guild_id => problems.push(format!("{target} is already a member of {guild_id}")),
            _ => {}
        }
        if action == "set_rank" && !owner && t.is_some() {
            let rank = arg_u64(args, "rank").unwrap_or(0);
            if !member || my_rank == 0 || t_rank <= my_rank {
                warnings.push(format!("you must outrank {target} (rank {t_rank}) to change it; you are rank {}", if member { my_rank.to_string() } else { "—".into() }));
            }
            if member && rank < my_rank {
                warnings.push(format!("you cannot hand out rank {rank}, better than your own {my_rank}"));
            }
        }
        if action == "kick" && g.get("owner").and_then(|o| o.as_str()) == Some(target.as_str()) {
            problems.push(format!("{target} owns {guild_id}"));
        }
    }

    if action == "join_proxy" {
        // The chain joins into the PROXY's guild, whatever guild_id says.
        if !member {
            problems.push(format!("a proxy signs players into its own guild; {} is not in {guild_id}", if signer.is_primary() { "you are".to_string() } else { signer.who() + " is" }));
        }
        let address = plan.payload["address"].as_str().unwrap_or("").to_string();
        let (nonce, pid) = proxy_nonce(&client, &address).await;
        if let Err(why) = verify_join_proof(
            &guild_id,
            &address,
            nonce,
            plan.payload["proofPubKey"].as_str().unwrap_or(""),
            plan.payload["proofSignature"].as_str().unwrap_or(""),
        ) {
            problems.push(why);
        }
        if let Some(pid) = pid {
            if let Ok(t) = client.query_entity("player", &pid).await {
                let tg = t.pointer("/Player/guildId").and_then(|g| g.as_str()).unwrap_or("");
                if tg == guild_id {
                    problems.push(format!("{address} is already {pid}, a member of {guild_id}"));
                } else if tg.starts_with("0-") {
                    warnings.push(format!("{address} is already {pid} in {tg}; joining moves it"));
                }
            }
        }
        let n = plan.payload["playerName"].as_str().unwrap_or("");
        if !n.is_empty() {
            if let Some(why) = crate::mcp::guild_founding::name_refusal(n) {
                problems.push(format!("name: {why}"));
            }
        }
    }
    match action {
        "owner" if !owner => problems.push(format!("only {guild_id}'s owner can hand it over")),
        "primary_reactor" => {
            let r = plan.payload["reactorId"].as_str().unwrap_or("").to_string();
            if client.query_entity("reactor", &r).await.is_err() {
                problems.push(format!("no reactor {r} on chain"));
            }
        }
        "rank_sale" => {
            let minimum = arg_u64(args, "minimum_rank").unwrap_or(0);
            let entry = num(g.get("entryRank")) as u64;
            if minimum > 0 && minimum > entry {
                problems.push(format!("the best rank on sale ({minimum}) cannot be worse than the entry rank ({entry})"));
            }
        }
        "entry_substation" => {
            let sub = plan.payload["entrySubstationId"].as_str().unwrap_or("");
            match client.query_entity("substation", sub).await {
                Ok(s) if crate::mcp::tools::board_pages::substation_deletion_pending(&s) => problems.push(format!("substation {sub} is pending deletion")),
                Ok(_) => {}
                Err(_) => problems.push(format!("no substation {sub} on chain")),
            }
        }
        "request" | "accept_invite" | "join" if member => problems.push(format!("you are already a member of {guild_id}")),
        _ => {}
    }

    // The routes in follow the guild's own policy: refuse what the chain
    // would refuse before anything is signed.
    let policy = crate::mcp::guild_membership::Policy::from_guild(&g);
    match action {
        "request" if policy.request == "closed" => problems.push(format!("{guild_id} takes no requests")),
        "approve" | "deny" if policy.request == "closed" => problems.push(format!("{guild_id} takes no requests, so there are none to answer")),
        "invite" | "invite_revoke" if policy.invite == "closed" => problems.push(format!("{guild_id} sends no invites (Settings: who may invite)")),
        "join" if !policy.direct_open() => problems.push(format!("{guild_id} cannot be joined directly")),
        _ => {}
    }
    // An owner cannot leave the guild they own (`is_owner`).
    if matches!(action, "join" | "request" | "accept_invite") && !member && own_guild.starts_with("0-") {
        let owns = client
            .query_entity("guild", &own_guild)
            .await
            .ok()
            .and_then(|v| v.pointer("/Guild/owner").and_then(|o| o.as_str()).map(|o| o == me))
            .unwrap_or(false);
        if owns {
            problems.push(format!("you own {own_guild}; hand it over before joining another guild"));
        }
    }
    // Direct join with a stake: count every infusion; the chain keeps the
    // ones on the guild's reactor and redelegates the rest (TokenMigrate).
    if action == "join" && !member && policy.direct_open() && policy.minimum > 0 {
        let (total, found) = crate::mcp::guild_membership::infused(&client, &address).await;
        if total < policy.minimum {
            problems.push(format!(
                "{guild_id} needs {} infused to join; you have {}",
                crate::mcp::tools::format::format_alpha(policy.minimum as f64),
                crate::mcp::tools::format::format_alpha(total as f64)
            ));
        }
        let reactor = g.get("primaryReactorId").and_then(|r| r.as_str()).unwrap_or("").to_string();
        if found.iter().any(|(_, r, _)| *r != reactor) {
            if let Some(why) = signer_lacks(&address, bits::TOKEN_MIGRATE, "token migrate").await {
                problems.push(format!("{why} (infusions on other reactors move to {reactor})"));
            }
            warnings.push(format!("infusions on other reactors are redelegated to {reactor}"));
        }
        plan.payload["infusionId"] = json!(found.iter().map(|(id, _, _)| id.clone()).collect::<Vec<_>>());
    }
    // What it does to power: the joiner's own, or everyone already on the
    // substation the new member lands on.
    let impact = match action {
        "join" | "accept_invite" | "request" if !member => {
            let override_sub = plan.payload.get("substationId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let target_id = if override_sub.is_empty() { policy.entry_substation.clone() } else { override_sub };
            if target_id.is_empty() {
                warnings.push(format!("{guild_id} has no entry substation: you would join unpowered"));
            }
            let target = crate::mcp::guild_membership::sub_power(&client, &target_id).await;
            let (draw, now) = crate::mcp::guild_membership::draw_of(&client, &me).await;
            let v = crate::mcp::guild_membership::joiner_impact(&draw, now, target.as_ref());
            if v["online_now"] == true && v["online_after"] == false {
                warnings.push("you would go offline after joining: the new share is below your draw".into());
            }
            Some(v)
        }
        "approve" | "invite" => {
            let override_sub = plan.payload.get("substationId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let target_id = if override_sub.is_empty() { policy.entry_substation.clone() } else { override_sub };
            crate::mcp::guild_membership::sub_power(&client, &target_id)
                .await
                .map(|s| crate::mcp::guild_membership::guild_impact(&s, 1))
        }
        _ => None,
    };

    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "warnings": warnings,
        "signed_as": signer.describe(),
        "guild_id": guild_id,
        "action": plan.action,
        "summary": plan.summary,
        "target": plan.target,
        "message": plan.type_url.trim_start_matches("/structs.structs."),
        "payload": plan.payload,
        "impact": impact,
    }))
}

/// Sign `action`. Re-runs the preview, refuses on any problem, and signs
/// exactly the previewed payload with the primary's device key.
pub async fn execute(app: &tauri::AppHandle, guild_id: Option<String>, action: &str, args: &Value) -> Result<Value, String> {
    execute_as(app, &Signer::primary()?, guild_id, action, args).await
}

/// Sign `action` as `signer` (the primary or a founder).
pub async fn execute_as(app: &tauri::AppHandle, signer: &Signer, guild_id: Option<String>, action: &str, args: &Value) -> Result<Value, String> {
    let pv = preview_as(signer, guild_id.clone(), action, args).await?;
    if pv.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let why: Vec<&str> = pv["problems"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        return Err(format!("refused: {}", why.join("; ")));
    }
    let me = signer.player_id.clone();
    let mut plan = plan(pv["guild_id"].as_str().unwrap_or(""), &me, action, args)?;
    // `join` carries the infusion ids the preview read off the chain.
    if action == "join" {
        plan.payload = pv["payload"].clone();
    }
    let res = crate::mcp::tx_retry::sign_once(app, signer.index, plan.type_url, plan.payload, format!("guild:{action}")).await?;
    // The primary moved guild: the servers this app talks to move too.
    if signer.is_primary() && matches!(action, "join" | "accept_invite") {
        crate::guild_directory::player_guild_moving(app);
    }
    Ok(json!({
        "ok": true,
        "signed_as": signer.describe(),
        "summary": plan.summary,
        "preview": pv,
        "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)"),
    }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn bits_match_live_records() {
        // Live 0-1 grants, 2026-11-02: 16777216 is the rank-1 UGC grant,
        // 262656 = provider open + membership, 8192 = mint.
        assert_eq!(bits::labels(16_777_216), vec!["names and pictures"]);
        assert_eq!(bits::labels(262_656), vec!["membership", "provider open"]);
        assert_eq!(bits::labels(8192), vec!["token mint"]);
        assert!(17_166_862 & bits::ADMIN != 0);
    }

    #[test]
    fn legacy_dec_is_scaled_by_ten_to_the_eighteen() {
        assert_eq!(legacy_dec_wire("0.05").unwrap(), "50000000000000000");
        assert_eq!(legacy_dec_wire("0").unwrap(), "0");
        assert_eq!(legacy_dec_wire(".5").unwrap(), "500000000000000000");
        assert_eq!(legacy_dec_wire("1").unwrap(), "1000000000000000000");
        assert!(legacy_dec_wire("1.01").is_err(), "a fee above 1");
        assert!(legacy_dec_wire("5%x").is_err());
        assert!(legacy_dec_wire("").is_err());
    }

    #[test]
    fn join_proxy_proof_checks_like_the_chain() {
        use k256::ecdsa::{signature::Signer as _, Signature, SigningKey};
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let pk = key.verifying_key().to_encoded_point(true);
        let pk_hex = hex::encode(pk.as_bytes());
        let address = cosmrs::crypto::PublicKey::from(cosmrs::crypto::secp256k1::VerifyingKey::from_sec1_bytes(pk.as_bytes()).unwrap()).account_id("structs").unwrap().to_string();
        let msg = join_proxy_challenge("0-12", &address, 3);
        assert_eq!(msg, format!("GUILD0-12ADDRESS{address}NONCE3"));
        let sig: Signature = key.sign(msg.as_bytes());
        let sig_hex = hex::encode(sig.to_bytes());
        assert!(verify_join_proof("0-12", &address, 3, &pk_hex, &sig_hex).is_ok());
        // A recovery byte on the end is tolerated, as the chain does.
        assert!(verify_join_proof("0-12", &address, 3, &pk_hex, &format!("{sig_hex}01")).is_ok());
        // Stale nonce, another guild, another address: refused.
        assert!(verify_join_proof("0-12", &address, 4, &pk_hex, &sig_hex).unwrap_err().contains("does not sign"));
        assert!(verify_join_proof("0-13", &address, 3, &pk_hex, &sig_hex).is_err());
        assert!(verify_join_proof("0-12", "structs1xyz", 3, &pk_hex, &sig_hex).unwrap_err().contains("belongs to"));
        assert!(verify_join_proof("0-12", &address, 3, "zz", &sig_hex).is_err());

        let p = plan("0-12", "1-70", "join_proxy", &json!({ "address": address, "proof_pub_key": pk_hex, "proof_signature": sig_hex, "name": "Newbie" }), ).unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgGuildMembershipJoinProxy");
        assert_eq!(p.payload["playerName"], "Newbie");
        assert_eq!(p.payload["substationId"], "");
        assert_eq!(p.key_bits, bits::GUILD_MEMBERSHIP);
    }

    #[test]
    fn new_guild_ops_build_the_chain_payloads() {
        let p = plan("0-12", "1-70", "primary_reactor", &json!({ "reactor": "3-4" })).unwrap();
        assert_eq!(p.payload, json!({ "guildId": "0-12", "reactorId": "3-4" }));
        assert!(plan("0-12", "1-70", "primary_reactor", &json!({ "reactor": "4-4" })).is_err());
        let p = plan("0-12", "1-70", "owner", &json!({ "player": "1-99" })).unwrap();
        assert_eq!(p.payload, json!({ "guildId": "0-12", "owner": "1-99" }));
        assert!(plan("0-12", "1-70", "owner", &json!({ "player": "1-70" })).is_err());
        let p = plan("0-12", "1-70", "rank_permission", &json!({ "object": "4-9", "permissions": "substation_connection", "rank": 5 })).unwrap();
        assert_eq!(p.payload, json!({ "objectId": "4-9", "guildId": "0-12", "permission": "1024", "rank": "5" }));
        assert_eq!(p.key_bits, bits::ADMIN | bits::SUBSTATION_CONNECTION);
        let p = plan("0-12", "1-70", "rank_permission_revoke", &json!({ "permissions": ["membership", "token mint"] })).unwrap();
        assert_eq!(p.payload["objectId"], "0-12");
        assert_eq!(p.payload["permission"], (bits::GUILD_MEMBERSHIP | bits::GUILD_TOKEN_MINT).to_string());
        assert!(plan("0-12", "1-70", "rank_permission", &json!({ "permissions": "admin", "rank": 1 })).is_err());
        assert!(plan("0-12", "1-70", "rank_permission", &json!({ "permissions": "nonsense", "rank": 1 })).is_err());
        assert_eq!(bits_arg(&json!({ "p": 1536 }), "p").unwrap(), 1536);
    }

    #[test]
    fn plans_build_the_chain_payloads() {
        let p = plan("0-1", "1-9", "invite", &json!({ "player": "1-42", "substation": "4-1" })).unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgGuildMembershipInvite");
        assert_eq!(p.payload, json!({ "guildId": "0-1", "playerId": "1-42", "substationId": "4-1" }));
        assert_eq!(p.key_bits, bits::GUILD_MEMBERSHIP);

        let p = plan("0-1", "1-9", "set_rank", &json!({ "player": "1-42", "rank": "7" })).unwrap();
        assert_eq!(p.payload, json!({ "playerId": "1-42", "guildRank": "7", "guildId": "0-1" }));
        assert_eq!(p.key_bits, bits::ADMIN);

        let p = plan("0-1", "1-9", "grant_admin", &json!({ "player": "1-42" })).unwrap();
        assert_eq!(p.payload["permissions"], "2");

        let p = plan("0-1", "1-9", "rank_sale", &json!({ "base": 10_000_000, "step": "5000000", "minimum_rank": 1, "join_enabled": true })).unwrap();
        assert_eq!(p.payload["minimumRank"], "1");
        assert_eq!(p.payload["joinByRankPurchaseEnabled"], true);

        let p = plan("0-1", "1-9", "accept_invite", &json!({})).unwrap();
        assert_eq!(p.payload, json!({ "guildId": "0-1", "playerId": "1-9", "substationId": "" }));
        assert_eq!(p.side, Side::Own);

        let p = plan("0-6", "1-9", "join", &json!({ "infusions": ["3-15-structs1abc"] })).unwrap();
        assert_eq!(p.type_url, "/structs.structs.MsgGuildMembershipJoin");
        assert_eq!(p.payload, json!({ "guildId": "0-6", "playerId": "1-9", "substationId": "", "infusionId": ["3-15-structs1abc"] }));
        assert_eq!(p.side, Side::Own);

        let p = plan("0-1", "1-9", "convert_out_fee", &json!({ "fee": "0.1" })).unwrap();
        assert_eq!(p.payload["bankConvertOutFee"], "100000000000000000");
    }

    /// Every action's payload names only real fields of its message and
    /// encodes — the codec DROPS unknown keys, so a misspelt field would
    /// otherwise sign an empty value.
    pub(crate) fn assert_encodes(type_url: &str, payload: &Value) {
        let desc = crate::mcp::chain_codec::descriptor(type_url).unwrap_or_else(|e| panic!("{e}"));
        for k in payload.as_object().unwrap().keys() {
            assert!(desc.get_field_by_json_name(k).is_some() || desc.get_field_by_name(k).is_some(), "{type_url} has no field {k}");
        }
        crate::mcp::chain_codec::encode(type_url, payload, "structs1signer").unwrap_or_else(|e| panic!("{e}"));
    }

    #[test]
    fn every_action_encodes_against_the_v022_schema() {
        let args = json!({
            "player": "1-42", "substation": "4-1", "rank": 5, "amount": 1000, "level": "member",
            "endpoint": "https://example.org/guild.json", "name": "Hydro", "base": 10, "step": 5,
            "minimum_rank": 1, "join_enabled": true, "fee": "0.05",
            "reactor": "3-1", "pfp": "https://example.org/p.png", "permissions": "membership",
            "address": "structs1abc", "proof_pub_key": "02ab", "proof_signature": "cd",
        });
        for a in ACTIONS {
            let p = plan("0-1", "1-9", a, &args).unwrap_or_else(|e| panic!("{a}: {e}"));
            assert_encodes(p.type_url, &p.payload);
        }
    }

    #[test]
    fn bad_input_is_refused_before_any_read() {
        assert!(plan("1-1", "1-9", "invite", &json!({ "player": "1-2" })).is_err(), "not a guild");
        assert!(plan("0-1", "1-9", "invite", &json!({ "player": "4-2" })).is_err(), "not a player");
        assert!(plan("0-1", "1-9", "kick", &json!({ "player": "1-9" })).is_err(), "self kick");
        assert!(plan("0-1", "1-9", "set_rank", &json!({ "player": "1-2", "rank": 0 })).is_err());
        assert!(plan("0-1", "1-9", "rank_sale", &json!({ "minimum_rank": 0, "join_enabled": true })).is_err());
        assert!(plan("0-1", "1-9", "bypass_invite", &json!({ "level": "open" })).is_err());
        assert!(plan("0-1", "1-9", "endpoint", &json!({ "endpoint": "ftp://x" })).is_err());
        assert!(plan("0-1", "1-9", "launch", &json!({})).is_err());
    }

    #[test]
    fn admin_standing_comes_only_from_owner_or_a_direct_grant() {
        let p = plan("0-1", "1-9", "entry_rank", &json!({ "rank": 50 })).unwrap();
        assert!(standing_gap(&p, true, 0, 0).is_none(), "the owner");
        assert!(standing_gap(&p, false, bits::ADMIN, 0).is_none(), "a direct grant");
        let gap = standing_gap(&p, false, 0, bits::ADMIN).expect("a rank grant no longer gives admin");
        assert!(gap.contains("granted directly"), "{gap}");

        // Operational bits may still come from rank.
        let p = plan("0-1", "1-9", "kick", &json!({ "player": "1-2" })).unwrap();
        assert!(standing_gap(&p, false, 0, bits::GUILD_MEMBERSHIP).is_none());
        assert!(standing_gap(&p, false, 0, 0).is_some());
    }

    #[test]
    fn rank_grants_apply_to_that_rank_and_better() {
        let grants = parse_rank_grants(
            &[
                json!({ "objectId": "0-1", "guildId": "0-1", "permissions": "16777216", "rank": "1" }),
                json!({ "objectId": "0-1", "guildId": "0-1", "permissions": "512", "rank": "20" }),
                json!({ "objectId": "0-1", "guildId": "0-9", "permissions": "2", "rank": "100" }),
            ],
            "0-1",
        );
        assert_eq!(grants, vec![(1, 16_777_216), (20, 512)], "another guild's row is ignored");
        assert_eq!(rank_bits(&grants, 1), 16_777_216 | 512);
        assert_eq!(rank_bits(&grants, 20), 512);
        assert_eq!(rank_bits(&grants, 21), 0);
        assert_eq!(rank_bits(&grants, 0), 0, "rank 0 = not a member");
    }

    #[test]
    fn object_grants_match_the_whole_object_id() {
        let rows = [
            json!({ "permissionId": "0-1@1-1", "value": "17166862" }),
            json!({ "permissionId": "0-10@1-2", "value": "2" }),
            json!({ "permissionId": "0-1@1-3", "value": "0" }),
            json!({ "permissionId": "0-1@2-243", "value": "16777216" }),
        ];
        assert_eq!(parse_object_grants(&rows, "0-1"), vec![("1-1".to_string(), 17_166_862)]);
    }
}

