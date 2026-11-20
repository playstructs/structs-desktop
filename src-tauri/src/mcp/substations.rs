//! Running a substation: the stations a player may administer, and the
//! per-player connection cap (chain v0.23, `MsgSubstationUpdateConnectionCapacityMaximum`).
//!
//! The share (keeper `grid_context.go` `UpdateSubstationConnectionCapacity`):
//!   share = floor(max(usable − load, 0) / max(connectionCount, 1))
//!   then min(share, maximum) when maximum > 0
//! where usable is [`crate::mcp::guild_power::substation_usable`]. So the cap
//! is a CEILING, never a guarantee: it keeps every connection's share steady
//! while the station has more than it needs (a new connection no longer
//! dilutes everyone), but it cannot raise a share the station cannot fund.
//! 0 removes the cap. The chain re-derives the share in the same transaction.
//!
//! Lowering it can knock connected players offline while the station still
//! has surplus — the preview names who, from the local snapshot.
//!
//! Permissions (keeper `CanUpdateConnectionCapacityMaximumBy`): the station
//! must be accepting connections (not closing), and `PermUpdate` on the
//! signing key AND as standing on the station — see [`standing_of`]. Free:
//! no charge, no proof.

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::founders::Signer;
use crate::mcp::guild_admin::bits;
use crate::mcp::loop_util::parse_f64 as num;
use crate::mcp::send_guard::signer_lacks;

pub const TYPE_URL: &str = "/structs.structs.MsgSubstationUpdateConnectionCapacityMaximum";

/// `op` names the MCP tool and the Terminal accept.
pub const ACTIONS: &[&str] = &["connection_max"];

/// One substation action, ready to preview or sign.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub type_url: &'static str,
    pub payload: Value,
    pub key_bits: u64,
    pub summary: String,
    /// The new cap in mW; 0 = unlimited.
    pub maximum: u64,
}

/// `value` in mW, a whole number, 0 allowed (= unlimited).
fn maximum_arg(args: &Value) -> Result<u64, String> {
    match args.get("value") {
        Some(Value::Number(n)) => n.as_u64().ok_or_else(|| "value must be a whole number of mW (0 = unlimited)".into()),
        Some(Value::String(s)) => s
            .trim()
            .parse()
            .map_err(|_| format!("value must be a whole number of mW (0 = unlimited), not '{s}'")),
        _ => Err("value is required: the per-player maximum in mW, 0 for unlimited".into()),
    }
}

/// "7.42 kW" — mW as a player reads it, for summaries.
pub fn fmt_mw(mw: u64) -> String {
    let w = mw as f64 / 1000.0;
    let (v, unit) = if w >= 1e9 {
        (w / 1e9, "GW")
    } else if w >= 1e6 {
        (w / 1e6, "MW")
    } else if w >= 1e3 {
        (w / 1e3, "kW")
    } else {
        (w, "W")
    };
    let s = format!("{v:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} {unit}")
}

/// Pure: validate and build the message.
pub fn plan(substation_id: &str, action: &str, args: &Value) -> Result<Plan, String> {
    match crate::mcp::types::ObjectId::parse(substation_id) {
        Ok(o) if o.kind == crate::mcp::types::ObjectKind::Substation => {}
        _ => return Err(format!("'{substation_id}' is not a substation id (they look like 4-12)")),
    }
    match action {
        "connection_max" => {
            let maximum = maximum_arg(args)?;
            Ok(Plan {
                type_url: TYPE_URL,
                // uint64 travels as a string, like every other u64 payload.
                payload: json!({ "substationId": substation_id, "connectionCapacityMaximum": maximum.to_string() }),
                key_bits: bits::UPDATE,
                summary: if maximum == 0 {
                    format!("Remove {substation_id}'s per-player cap")
                } else {
                    format!("Cap each player on {substation_id} at {}", fmt_mw(maximum))
                },
                maximum,
            })
        }
        other => Err(format!("unknown substation action '{other}' (one of: {})", ACTIONS.join(", "))),
    }
}

/// The keeper's per-connection share. `usable` is already net of load
/// ([`crate::mcp::guild_power::substation_usable`]).
pub fn share_of(usable: f64, connection_count: u64, maximum: u64) -> u64 {
    let share = (usable.max(0.0) as u128 / connection_count.max(1) as u128) as u64;
    if maximum > 0 { share.min(maximum) } else { share }
}

/// Who stands to administer an object, as the keeper decides it
/// (`permissionCheck`, v0.23) — everything after the signing key's own bits,
/// which [`signer_lacks`] checks. `Some(reason)` = allowed.
pub struct Standing<'a> {
    pub me: &'a str,
    pub owner: &'a str,
    /// When `owner` is a guild (`0-…`): that guild's owner.
    pub owner_guild_owner: Option<&'a str>,
    /// The `{object}@{me}` permission record's value (0 = none).
    pub direct_bits: u64,
    /// `(permissions, rank)` rows from
    /// `/structs/guild_rank_permission/object/{object}/guild/{my guild}`.
    pub rank_records: &'a [(u64, u64)],
    /// My guild rank (lower number = more senior); `None` = guildless.
    pub my_rank: Option<u64>,
}

pub fn standing_of(s: &Standing, need: u64) -> Option<&'static str> {
    if s.owner == s.me {
        return Some("you own it");
    }
    if s.owner_guild_owner == Some(s.me) {
        return Some("you own the guild that owns it");
    }
    if s.direct_bits & need == need {
        return Some("you hold a direct grant on it");
    }
    // Rank leg (`GetPermissionsGuildRank`): every wanted bit must have a
    // registered rank; the worst of them must be ≥ my rank. Admin is never
    // rank-derived.
    if let (Some(my_rank), true) = (s.my_rank, need & bits::ADMIN == 0) {
        let mut worst: Option<u64> = None;
        for bit in 0..64u32 {
            let b = 1u64 << bit;
            if need & b == 0 {
                continue;
            }
            let slot = s.rank_records.iter().filter(|(p, _)| p & b != 0).map(|(_, r)| *r).max().unwrap_or(0);
            if slot == 0 {
                return None;
            }
            worst = Some(worst.map_or(slot, |w: u64| w.min(slot)));
        }
        if worst.is_some_and(|w| w >= my_rank) {
            return Some("your guild rank grants it");
        }
    }
    None
}

/// One player connected to the station: id, own capacity, draw (mW).
pub type Connected = (String, u64, u64);

/// Pure: who is powered now and would not be at `new_share` — a player is
/// online while draw ≤ own capacity + the station's share.
pub fn knocked_offline(players: &[Connected], current_share: u64, new_share: u64) -> Vec<String> {
    if new_share >= current_share {
        return Vec::new();
    }
    players
        .iter()
        .filter(|(_, own, draw)| *draw <= own + current_share && *draw > own + new_share)
        .map(|(id, _, _)| id.clone())
        .collect()
}

/// Every player the local snapshot has on `substation_id`. `None` when the
/// snapshot is not ready (the caller says it could not check).
fn connected_players(substation_id: &str) -> Option<Vec<Connected>> {
    crate::mcp::perception::with_snapshot(|s| {
        s.players
            .iter()
            .filter(|(_, row)| {
                row.get("substationId").or_else(|| row.get("substation_id")).and_then(|v| v.as_str()) == Some(substation_id)
            })
            .map(|(pid, _)| {
                let g = |k: &str| s.grid_attr(pid, k).unwrap_or(0);
                (pid.clone(), g("capacity"), g("load") + g("structsLoad"))
            })
            .collect()
    })
}

/// The station's numbers, from its LCD entity.
struct Station {
    owner: String,
    closing: bool,
    capacity: f64,
    load: f64,
    count: u64,
    share: u64,
    maximum: u64,
}

impl Station {
    fn of(v: &Value) -> Self {
        let g = |k: &str| num(v.pointer(&format!("/gridAttributes/{k}")));
        let s = v.get("Substation").unwrap_or(v);
        Self {
            owner: s.get("owner").and_then(|o| o.as_str()).unwrap_or("").to_string(),
            closing: crate::mcp::tools::board_pages::substation_deletion_pending(v),
            capacity: g("capacity"),
            load: g("load"),
            count: g("connectionCount") as u64,
            share: g("connectionCapacity") as u64,
            maximum: g("connectionCapacityMaximum") as u64,
        }
    }
    fn usable(&self) -> f64 {
        crate::mcp::guild_power::substation_usable(self.capacity, self.load)
    }
    /// What each connection would get with no cap at all.
    fn uncapped(&self) -> u64 {
        share_of(self.usable(), self.count, 0)
    }
}

/// My guild id and rank, from the player entity.
async fn my_guild(client: &CosmosClient, me: &str) -> (String, Option<u64>) {
    let Ok(p) = client.entity("player", me).await else { return (String::new(), None) };
    let p = p.get("Player").unwrap_or(&p);
    let guild = p.get("guildId").and_then(|g| g.as_str()).unwrap_or("").to_string();
    let rank = p.get("guildRank").map(|r| num(Some(r)) as u64).filter(|_| !guild.is_empty());
    (guild, rank)
}

/// [`standing_of`] with every input read from the chain.
async fn standing(client: &CosmosClient, me: &str, substation_id: &str, owner: &str, guild: &str, my_rank: Option<u64>) -> Option<&'static str> {
    let owner_guild_owner = if owner.starts_with("0-") {
        client
            .query_entity("guild", owner)
            .await
            .ok()
            .and_then(|g| g.pointer("/Guild/owner").and_then(|o| o.as_str()).map(String::from))
    } else {
        None
    };
    let direct_bits = client.permission_value(substation_id, me).await.unwrap_or(0);
    let rank_records = if guild.is_empty() {
        Vec::new()
    } else {
        client
            .lcd_get(&format!("/structs/guild_rank_permission/object/{substation_id}/guild/{guild}"))
            .await
            .map(|v| crate::mcp::crew::parse_rank_records(&v))
            .unwrap_or_default()
    };
    standing_of(
        &Standing { me, owner, owner_guild_owner: owner_guild_owner.as_deref(), direct_bits, rank_records: &rank_records, my_rank },
        bits::UPDATE,
    )
}

/// The substations the primary may run: its own, its guild's, and any it
/// holds a direct grant on — each with its share, cap and whether you can
/// change it.
pub async fn list() -> Result<Value, String> {
    list_as(&Signer::primary()?).await
}

/// [`list`] for any signer — a founder sees its guild's substations.
pub async fn list_as(signer: &Signer) -> Result<Value, String> {
    let me = signer.player_id.clone();
    let client = CosmosClient::new();
    let (guild, my_rank) = my_guild(&client, &me).await;
    let granted: Vec<String> = client
        .permissions_by_player(&me, 20)
        .await
        .map(|(rows, _)| rows.into_iter().filter(|(o, v)| o.starts_with("4-") && v & bits::UPDATE != 0).map(|(o, _)| o).collect())
        .unwrap_or_default();
    let mut ids: Vec<String> = client
        .list_all_entities("substation", "Substation")
        .await?
        .into_iter()
        .filter_map(|s| {
            let owner = s.get("owner").and_then(|o| o.as_str()).unwrap_or("");
            let id = s.get("id").and_then(|i| i.as_str())?.to_string();
            (owner == me || (!guild.is_empty() && owner == guild) || granted.contains(&id)).then_some(id)
        })
        .collect();
    for g in granted {
        if !ids.contains(&g) {
            ids.push(g);
        }
    }
    let mut out = Vec::new();
    for id in ids {
        let Ok(v) = client.query_entity("substation", &id).await else { continue };
        let st = Station::of(&v);
        let why = standing(&client, &me, &id, &st.owner, &guild, my_rank).await;
        out.push(json!({
            "id": id,
            "owner": st.owner,
            "guild_owned": st.owner != me && st.owner.starts_with("0-"),
            "closing": st.closing,
            "connection_count": st.count,
            "capacity_mw": st.capacity,
            "load_mw": st.load,
            "usable_mw": st.usable(),
            "share_mw": st.share,
            "uncapped_share_mw": st.uncapped(),
            "connection_max_mw": st.maximum,
            "capped": st.maximum > 0 && st.uncapped() > st.maximum,
            "can_update": why.is_some() && !st.closing,
            "standing": why,
        }));
    }
    Ok(json!({ "ok": true, "owner": me, "guild_id": guild, "substations": out }))
}

/// Check a substation action without signing: permissions, the share
/// before/after, and who it would knock offline.
pub async fn preview(substation_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    preview_as(&Signer::primary()?, substation_id, action, args).await
}

pub async fn preview_as(signer: &Signer, substation_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    let plan = plan(substation_id, action, args)?;
    let (me, address) = (signer.player_id.clone(), signer.address.clone());
    let client = CosmosClient::new();
    let v = client.query_entity("substation", substation_id).await.map_err(|e| format!("substation {substation_id}: {e}"))?;
    let st = Station::of(&v);
    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if st.closing {
        problems.push(format!("{substation_id} is closing and no longer takes changes"));
    }
    if let Some(why) = signer_lacks(&address, plan.key_bits, &bits::describe(plan.key_bits)).await {
        problems.push(why);
    }
    let (guild, my_rank) = my_guild(&client, &me).await;
    let why = standing(&client, &me, substation_id, &st.owner, &guild, my_rank).await;
    if why.is_none() {
        problems.push(format!(
            "you need {} on {substation_id} (owned by {}): ownership, a direct grant, or a guild rank that carries it",
            bits::describe(plan.key_bits),
            if st.owner.is_empty() { "nobody" } else { &st.owner }
        ));
    }
    if plan.maximum == st.maximum {
        warnings.push(if st.maximum == 0 { "already unlimited".into() } else { format!("already capped at {}", fmt_mw(st.maximum)) });
    }
    let uncapped = st.uncapped();
    let after = share_of(st.usable(), st.count, plan.maximum);
    if plan.maximum > 0 && plan.maximum > uncapped {
        warnings.push(format!(
            "a ceiling, not a guarantee: the station funds only {} per player now, so the cap does nothing until it grows",
            fmt_mw(uncapped)
        ));
    }
    let (offline, checked) = match connected_players(substation_id) {
        Some(players) => (knocked_offline(&players, st.share, after), true),
        None => (Vec::new(), false),
    };
    if !offline.is_empty() {
        warnings.push(format!("{} connected player(s) lose power at {} per player", offline.len(), fmt_mw(after)));
    } else if !checked && after < st.share {
        warnings.push("could not check who loses power: the local snapshot is not ready".into());
    }
    Ok(json!({
        "ok": problems.is_empty(),
        "signed_as": signer.describe(),
        "problems": problems,
        "warnings": warnings,
        "substation_id": substation_id,
        "action": action,
        "summary": plan.summary,
        "message": plan.type_url.trim_start_matches("/structs.structs."),
        "payload": plan.payload,
        "standing": why,
        "connection_count": st.count,
        "connection_max_mw": st.maximum,
        "new_connection_max_mw": plan.maximum,
        "share_mw": st.share,
        "share_after_mw": after,
        "uncapped_share_mw": uncapped,
        "knocked_offline": offline,
        "offline_checked": checked,
    }))
}

/// Sign a substation action, after re-running the preview.
pub async fn execute(app: &tauri::AppHandle, substation_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    execute_as(app, &Signer::primary()?, substation_id, action, args).await
}

pub async fn execute_as(app: &tauri::AppHandle, signer: &Signer, substation_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    let pv = preview_as(signer, substation_id, action, args).await?;
    if pv.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let why: Vec<&str> = pv["problems"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        return Err(format!("refused: {}", why.join("; ")));
    }
    let plan = plan(substation_id, action, args)?;
    let res = crate::mcp::tx_retry::sign_once(app, signer.index, plan.type_url, plan.payload, format!("substation:{action}")).await?;
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

    #[test]
    fn the_cap_is_a_u64_string_and_zero_means_unlimited() {
        let p = plan("4-12", "connection_max", &json!({ "value": 5_000_000 })).unwrap();
        assert_eq!(p.type_url, TYPE_URL);
        assert_eq!(p.payload, json!({ "substationId": "4-12", "connectionCapacityMaximum": "5000000" }));
        assert_eq!(p.key_bits, bits::UPDATE);
        assert_eq!(p.summary, "Cap each player on 4-12 at 5 kW");
        let off = plan("4-12", "connection_max", &json!({ "value": "0" })).unwrap();
        assert_eq!(off.maximum, 0);
        assert_eq!(off.summary, "Remove 4-12's per-player cap");
    }

    #[test]
    fn bad_input_is_refused_before_anything_is_read() {
        assert!(plan("10-5", "connection_max", &json!({ "value": 1 })).is_err(), "a provider id");
        assert!(plan("4-12", "connection_max", &json!({})).is_err(), "no value");
        assert!(plan("4-12", "connection_max", &json!({ "value": -1 })).is_err(), "negative");
        assert!(plan("4-12", "connection_max", &json!({ "value": "1.5" })).is_err(), "fractional mW");
        assert!(plan("4-12", "rename", &json!({ "value": 1 })).is_err());
    }

    #[test]
    fn every_action_encodes_against_the_v023_schema() {
        for a in ACTIONS {
            let p = plan("4-12", a, &json!({ "value": 7_422_388 })).unwrap();
            crate::mcp::guild_admin::tests::assert_encodes(p.type_url, &p.payload);
        }
    }

    /// The bug class from chain_codec: an unknown key is silently DROPPED, so
    /// a misspelt field would sign "no cap" whatever the player typed. Decode
    /// what we encode and read the number back.
    #[test]
    fn the_maximum_survives_the_encoder() {
        let p = plan("4-12", "connection_max", &json!({ "value": 7_422_388 })).unwrap();
        let bytes = crate::mcp::chain_codec::encode(p.type_url, &p.payload, "structs1signer").unwrap();
        let desc = crate::mcp::chain_codec::descriptor(p.type_url).unwrap();
        let msg = prost_reflect::DynamicMessage::decode(desc, bytes.as_slice()).unwrap();
        assert_eq!(msg.get_field_by_name("connectionCapacityMaximum").unwrap().as_u64(), Some(7_422_388));
        assert_eq!(msg.get_field_by_name("substationId").unwrap().as_str(), Some("4-12"));
        assert_eq!(msg.get_field_by_name("creator").unwrap().as_str(), Some("structs1signer"));
    }

    /// Verified live on 4-1 (guild_power): 41,614,860,000 capacity, 0 load,
    /// 5,046 connections → 7,422,388.
    #[test]
    fn share_matches_the_keeper_and_the_cap_only_lowers_it() {
        let usable = crate::mcp::guild_power::substation_usable(41_614_860_000.0, 0.0);
        assert_eq!(share_of(usable, 5046, 0), 7_422_388);
        assert_eq!(share_of(usable, 5046, 5_000_000), 5_000_000);
        assert_eq!(share_of(usable, 5046, 9_000_000), 7_422_388, "a ceiling, never a guarantee");
        assert_eq!(share_of(usable, 0, 0), usable as u64, "no connections divides by one");
        assert_eq!(share_of(0.0, 10, 5), 0);
    }

    #[test]
    fn a_lower_share_names_exactly_who_goes_dark() {
        let players: Vec<Connected> = vec![
            ("1-1".into(), 0, 3_000),     // needs 3k of the share
            ("1-2".into(), 10_000, 9_000), // own capacity covers it
            ("1-3".into(), 0, 9_000),     // already dark at 5k
            ("1-4".into(), 1_000, 2_500), // needs 1.5k
        ];
        assert_eq!(knocked_offline(&players, 5_000, 2_000), vec!["1-1".to_string()]);
        assert_eq!(knocked_offline(&players, 5_000, 1_000), vec!["1-1".to_string(), "1-4".to_string()]);
        assert!(knocked_offline(&players, 5_000, 6_000).is_empty(), "a raise knocks nobody off");
    }

    fn st<'a>(owner: &'a str, ggo: Option<&'a str>, direct: u64, ranks: &'a [(u64, u64)], my_rank: Option<u64>) -> Standing<'a> {
        Standing { me: "1-7", owner, owner_guild_owner: ggo, direct_bits: direct, rank_records: ranks, my_rank }
    }

    /// keeper permissionCheck, after the key's own bits.
    #[test]
    fn standing_follows_the_keeper() {
        let u = bits::UPDATE;
        assert_eq!(standing_of(&st("1-7", None, 0, &[], None), u), Some("you own it"));
        assert_eq!(standing_of(&st("0-2", Some("1-7"), 0, &[], None), u), Some("you own the guild that owns it"));
        assert_eq!(standing_of(&st("1-9", None, u | bits::PLAY, &[], None), u), Some("you hold a direct grant on it"));
        assert_eq!(standing_of(&st("1-9", None, bits::DELETE, &[], None), u), None, "the wrong bit");
        // Rank: slot rank 3 admits ranks 1..=3.
        let ranks = [(u, 3)];
        assert_eq!(standing_of(&st("0-2", Some("1-1"), 0, &ranks, Some(3)), u), Some("your guild rank grants it"));
        assert_eq!(standing_of(&st("0-2", Some("1-1"), 0, &ranks, Some(4)), u), None, "too junior");
        assert_eq!(standing_of(&st("0-2", Some("1-1"), 0, &ranks, None), u), None, "guildless");
        assert_eq!(standing_of(&st("0-2", Some("1-1"), 0, &[(bits::DELETE, 9)], Some(1)), u), None, "no UPDATE slot");
        assert_eq!(standing_of(&st("0-2", Some("1-1"), 0, &[(bits::ADMIN, 9)], Some(1)), bits::ADMIN), None, "Admin is never rank-derived");
    }

    #[test]
    fn mw_reads_as_watts() {
        assert_eq!(fmt_mw(7_422_388), "7.42 kW");
        assert_eq!(fmt_mw(5_000_000), "5 kW");
        assert_eq!(fmt_mw(500), "0.5 W");
        assert_eq!(fmt_mw(2_500_000_000), "2.5 MW");
    }
}
