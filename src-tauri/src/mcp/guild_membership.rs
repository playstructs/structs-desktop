//! Guild membership as the people on both sides of it see it: the requests
//! and invites waiting on a guild, the ones waiting on you, the one door a
//! guild offers a visitor, what a join does to everyone's power, and the
//! moments worth an alert.
//!
//! Signing stays in `guild_admin` (one plan per chain message, previewed
//! first). This module only READS and decides — so every rule here is a
//! pure function with a test, and the async readers just gather inputs.
//!
//! Chain facts this follows (v0.22.0, `x/structs/keeper`):
//! - An application is one `player@guild` record in `proposed`; it is
//!   DELETED the moment it resolves (approved, denied, revoked). Nothing
//!   expires and there is no note field.
//! - Invite and request each have a level: `closed` (nobody), `permissioned`
//!   (holders of GuildMembership on the guild, direct or by rank), `member`
//!   (any member, or the owner, whose key carries GuildMembership).
//!   `closed` refuses a request outright.
//! - Direct join is gated only by `joinInfusionMinimum`; 0 = anyone.
//! - A join DISCONNECTS the player from their substation and connects them
//!   to the entry substation (or an override). Every connection divides the
//!   substation's usable capacity: `(floor(cap × 9/10) − load) / connections`.
//! - The indexer (structs-pg `GUILD_MEMBERSHIP_NOTIFY`) publishes every
//!   change on GRASS `structs.guild.<id>`, category `guild_membership`, with
//!   the row's snake_case fields — including the resolved statuses the chain
//!   itself no longer stores.

use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::guild_admin::{bits, parse_object_grants, parse_rank_grants, rank_bits};
use crate::mcp::guild_power::substation_usable;
use crate::mcp::loop_util::parse_f64 as num;

/// A join minimum at or above this (1e9 Alpha) is a wall, not a price:
/// founders close direct join by setting the minimum to u64::MAX.
pub const UNREACHABLE_MINIMUM: u64 = 1_000_000_000_000_000;

/// GRASS category the indexer publishes application changes under.
pub const CATEGORY: &str = "guild_membership";
/// Board event every open Members / inbox / guild card listens for.
pub const BOARD_EVENT: &str = "guild-membership";
/// Notification channel (notifications::CHANNELS).
pub const CHANNEL: &str = "guild_membership";

// ── Policy ──────────────────────────────────────────────────────────────────

/// A guild's join rules, as the chain holds them.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Policy {
    pub minimum: u64,
    pub request: String,
    pub invite: String,
    pub rank_join: bool,
    pub entry_rank: u64,
    pub entry_substation: String,
}

fn level(v: Option<&Value>) -> String {
    // LCD sends enum names; tolerate the numbers too (keys.proto:54-58).
    match v {
        Some(Value::String(s)) if !s.is_empty() => match s.as_str() {
            "0" => "closed".into(),
            "1" => "permissioned".into(),
            "2" => "member".into(),
            other => other.to_string(),
        },
        Some(Value::Number(n)) => match n.as_u64() {
            Some(1) => "permissioned".into(),
            Some(2) => "member".into(),
            _ => "closed".into(),
        },
        _ => "closed".into(),
    }
}

fn u64_of(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

fn str_of(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

impl Policy {
    /// From an LCD `Guild` object.
    pub fn from_guild(g: &Value) -> Policy {
        Policy {
            minimum: u64_of(g.get("joinInfusionMinimum")),
            request: level(g.get("joinInfusionMinimumBypassByRequest")),
            invite: level(g.get("joinInfusionMinimumBypassByInvite")),
            rank_join: g.get("joinByRankPurchaseEnabled").and_then(|v| v.as_bool()).unwrap_or(false)
                && u64_of(g.get("rankPurchaseMinimumRank")) > 0,
            entry_rank: u64_of(g.get("entryRank")),
            entry_substation: str_of(g.get("entrySubstationId")),
        }
    }

    pub fn direct_open(&self) -> bool {
        self.minimum < UNREACHABLE_MINIMUM
    }

    /// One word for the founding picker's four choices (plus `closed`).
    pub fn label(&self) -> &'static str {
        if self.minimum == 0 {
            "open"
        } else if self.direct_open() {
            "stake"
        } else if self.request != "closed" {
            "application"
        } else if self.invite != "closed" {
            "invite only"
        } else if self.rank_join {
            "rank sale"
        } else {
            "closed"
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "label": self.label(),
            "minimum": self.minimum.to_string(),
            "direct_open": self.direct_open(),
            "request": self.request,
            "invite": self.invite,
            "rank_join": self.rank_join,
            "entry_rank": self.entry_rank,
            "entry_substation": self.entry_substation,
        })
    }
}

// ── Standing: what the signer may do in one guild ──────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Standing {
    pub me: String,
    pub own_guild: String,
    pub rank: u64,
    /// Owner of THIS guild.
    pub owner: bool,
    /// Owner of the guild they are in now (they cannot leave it).
    pub owns_own_guild: bool,
    pub member: bool,
    pub direct: u64,
    pub ranked: u64,
    /// Bits the signing key itself holds.
    pub key: u64,
}

impl Standing {
    fn key_has(&self, bit: u64) -> bool {
        self.key & bit == bit
    }
    /// Holds `bit` on the guild: owner, a direct grant, or (members) a rank grant.
    fn holds(&self, bit: u64) -> bool {
        self.owner || (self.direct | if self.member { self.ranked } else { 0 }) & bit == bit
    }
    /// May act at a bypass level (`guild_cache.go:271-353`).
    fn at_level(&self, level: &str) -> bool {
        self.key_has(bits::GUILD_MEMBERSHIP)
            && match level {
                "permissioned" => self.holds(bits::GUILD_MEMBERSHIP),
                "member" => self.member || self.owner,
                _ => false,
            }
    }
    pub fn can_invite(&self, p: &Policy) -> bool {
        self.at_level(&p.invite)
    }
    pub fn can_answer(&self, p: &Policy) -> bool {
        self.at_level(&p.request)
    }
    pub fn can_kick(&self) -> bool {
        self.key_has(bits::GUILD_MEMBERSHIP) && self.holds(bits::GUILD_MEMBERSHIP)
    }
    pub fn can_set_rank(&self) -> bool {
        self.key_has(bits::ADMIN) && (self.owner || self.direct & bits::ADMIN != 0)
    }
    pub fn json(&self, p: &Policy) -> Value {
        json!({
            "player_id": self.me,
            "guild_id": self.own_guild,
            "member": self.member,
            "owner": self.owner,
            "owns_own_guild": self.owns_own_guild,
            "rank": self.member.then_some(self.rank),
            "can_invite": self.can_invite(p),
            "can_answer": self.can_answer(p),
            "can_kick": self.can_kick(),
            "can_set_rank": self.can_set_rank(),
        })
    }
}

// ── Doors: the one way in a guild offers a visitor ─────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Viewer {
    pub member: bool,
    /// The guild they own now, if any (they cannot join another).
    pub owns: Option<String>,
    pub invited: bool,
    pub requested: bool,
    /// Alpha-equivalent fuel the viewer has infused (for a stake guild).
    pub infused: Option<u64>,
}

fn door(action: &str, label: &str, primary: bool, why: Option<String>) -> Value {
    json!({ "action": action, "label": label, "primary": primary, "enabled": why.is_none(), "why": why })
}

/// Every door a guild with policy `p` shows viewer `v`, primary first.
/// Members see none. Closed shows none (the caller states "closed").
pub fn doors(p: &Policy, v: &Viewer) -> Vec<Value> {
    if v.member {
        return vec![];
    }
    let blocked = v.owns.as_ref().map(|g| format!("you own {g}; hand it over first"));
    let mut out = Vec::new();
    if v.invited {
        out.push(door("accept_invite", "Accept invite", true, blocked.clone()));
        out.push(door("decline_invite", "Decline", false, None));
        return out;
    }
    if v.requested {
        out.push(door("request_revoke", "Withdraw request", false, None));
        return out;
    }
    if p.direct_open() {
        let short = match (p.minimum, v.infused) {
            (0, _) => None,
            (min, Some(have)) if have < min => Some(format!("{} infused needed", fmt_alpha(min))),
            _ => None,
        };
        out.push(door("join", "Join", true, blocked.clone().or(short)));
    }
    if p.request != "closed" {
        let primary = out.is_empty();
        out.push(door("request", "Ask to join", primary, blocked.clone()));
    }
    if p.rank_join {
        let primary = out.is_empty();
        out.push(door("rank", "Buy a rank", primary, blocked));
    }
    out
}

fn fmt_alpha(ualpha: u64) -> String {
    crate::mcp::tools::format::format_alpha(ualpha as f64)
}

// ── Power impact ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SubPower {
    pub id: String,
    pub capacity: f64,
    pub load: f64,
    pub connections: u64,
}

impl SubPower {
    /// Each connection's share with `extra` more players connected.
    pub fn share_with(&self, extra: u64) -> f64 {
        let usable = substation_usable(self.capacity, self.load);
        let n = self.connections + extra;
        if n == 0 { usable } else { (usable / n as f64).floor() }
    }
}

/// A player's power, as the online rule reads it (`player_cache.go:297`):
/// online while `load + structsLoad ≤ capacity + substation share`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Draw {
    pub load: f64,
    pub structs_load: f64,
    pub capacity: f64,
    pub substation: String,
}

impl Draw {
    pub fn need(&self) -> f64 {
        self.load + self.structs_load
    }
    pub fn online_with(&self, share: f64) -> bool {
        self.need() <= self.capacity + share
    }
}

/// What joining a guild on `target` does to the joiner. `now_share` is
/// their current substation's share (0 when unconnected).
pub fn joiner_impact(draw: &Draw, now_share: f64, target: Option<&SubPower>) -> Value {
    let after = match target {
        Some(t) if t.id == draw.substation => t.share_with(0),
        Some(t) => t.share_with(1),
        None => 0.0,
    };
    json!({
        "draw_mw": draw.need(),
        "capacity_mw": draw.capacity,
        "share_now_mw": now_share,
        "share_after_mw": after,
        "substation_after": target.map(|t| t.id.clone()).unwrap_or_default(),
        "online_now": draw.online_with(now_share),
        "online_after": draw.online_with(after),
    })
}

/// What admitting `n` more players does to everyone already on `sub`.
pub fn guild_impact(sub: &SubPower, n: u64) -> Value {
    json!({
        "substation": sub.id,
        "connections": sub.connections,
        "share_now_mw": sub.share_with(0),
        "share_after_mw": sub.share_with(n),
        "admitting": n,
    })
}

// ── Applications ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct App {
    pub guild: String,
    pub player: String,
    pub kind: String,
    pub status: String,
    pub proposer: String,
    pub substation: String,
}

fn join_kind(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => match s.as_str() {
            "0" => "invite".into(),
            "1" => "request".into(),
            "2" => "direct".into(),
            "3" => "proxy".into(),
            other => other.to_string(),
        },
        Some(Value::Number(n)) => ["invite", "request", "direct", "proxy"].get(n.as_u64().unwrap_or(9) as usize).unwrap_or(&"").to_string(),
        _ => String::new(),
    }
}

fn reg_status(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => match s.as_str() {
            "0" => "proposed".into(),
            "1" => "approved".into(),
            "2" => "denied".into(),
            "3" => "revoked".into(),
            other => other.to_string(),
        },
        Some(Value::Number(n)) => ["proposed", "approved", "denied", "revoked"].get(n.as_u64().unwrap_or(9) as usize).unwrap_or(&"").to_string(),
        // LCD omits a zero enum: an application on file is proposed.
        _ => "proposed".into(),
    }
}

impl App {
    /// An LCD `GuildMembershipApplication` row (camelCase).
    pub fn from_lcd(v: &Value) -> App {
        App {
            guild: str_of(v.get("guildId")),
            player: str_of(v.get("playerId")),
            kind: join_kind(v.get("joinType")),
            status: reg_status(v.get("registrationStatus")),
            proposer: str_of(v.get("proposer")),
            substation: str_of(v.get("substationId")),
        }
    }
    /// A GRASS `guild_membership` frame or a Guild API row (snake_case).
    pub fn from_row(v: &Value) -> App {
        App {
            guild: str_of(v.get("guild_id")),
            player: str_of(v.get("player_id")),
            kind: join_kind(v.get("join_type")),
            status: reg_status(v.get("status")),
            proposer: str_of(v.get("proposer")),
            substation: str_of(v.get("substation_id")),
        }
    }
}

// ── Alerts ─────────────────────────────────────────────────────────────────

/// Who should hear about an application change, and what they read.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// Only for people who can answer requests in that guild.
    pub answerers_only: bool,
}

/// Pure: the alert for `app` as seen by `me` (in `my_guild`), if any.
/// `name` renders a player or guild id for people.
pub fn notice(app: &App, me: &str, my_guild: &str, name: &dyn Fn(&str) -> String) -> Option<Notice> {
    let n = |title: String, body: String, answerers_only: bool| Some(Notice { title, body, answerers_only });
    let g = name(&app.guild);
    let who = name(&app.player);
    match (app.kind.as_str(), app.status.as_str()) {
        ("request", "proposed") if app.guild == my_guild && app.player != me => {
            n(format!("Request to join {g}"), format!("{who} asked to join"), true)
        }
        ("invite", "proposed") if app.player == me => {
            n(format!("Invited to {g}"), format!("{} invited you", name(&app.proposer)), false)
        }
        ("request", "approved") if app.player == me => n(format!("You joined {g}"), "Your request was approved".into(), false),
        ("request", "denied") if app.player == me => n(format!("{g} turned you down"), "Your request was denied".into(), false),
        ("invite", "approved") if app.proposer == me && app.player != me => n(format!("{who} joined {g}"), "They accepted your invite".into(), false),
        ("invite", "denied") if app.proposer == me && app.player != me => n(format!("{who} declined"), format!("Your invite to {g} was declined"), false),
        _ => None,
    }
}

/// Whether a frame concerns this player at all (their guild, them, or
/// something they proposed).
pub fn concerns(app: &App, me: &str, my_guild: &str) -> bool {
    !me.is_empty() && ((!my_guild.is_empty() && app.guild == my_guild) || app.player == me || app.proposer == me)
}

static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn first_time(key: String) -> bool {
    let Ok(mut g) = SEEN.lock() else { return true };
    let set = g.get_or_insert_with(HashSet::new);
    if set.len() > 4096 {
        set.clear();
    }
    set.insert(key)
}

/// One GRASS `guild_membership` frame: refresh any open card that cares,
/// and raise the alert the frame deserves.
pub fn on_grass(app: &tauri::AppHandle, event: &crate::mcp::event_buffer::GameEvent) {
    let a = App::from_row(&event.detail);
    if a.guild.is_empty() || a.player.is_empty() {
        return;
    }
    let (me, my_guild) = match crate::game_state::GAME_STATE.read() {
        Ok(gs) => (gs.player_id.clone().unwrap_or_default(), gs.guild_id.clone().unwrap_or_default()),
        Err(_) => return,
    };
    if !concerns(&a, &me, &my_guild) {
        return;
    }
    let stamp = str_of(event.detail.get("updated_at"));
    if !first_time(format!("{}|{}|{}|{}|{stamp}", a.guild, a.player, a.kind, a.status)) {
        return;
    }
    let _ = crate::mcp::events::emit(
        app,
        crate::mcp::events::AppEvent::Board {
            name: BOARD_EVENT,
            payload: json!({ "guild_id": a.guild, "player_id": a.player, "join_type": a.kind, "status": a.status, "proposer": a.proposer }),
        },
    );
    let name = |id: &str| -> String {
        let snap = crate::mcp::perception::with_snapshot(|s| {
            s.player_row(id).and_then(|r| r.get("username")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from)
        })
        .flatten();
        snap.unwrap_or_else(|| id.to_string())
    };
    let Some(nt) = notice(&a, &me, &my_guild, &name) else { return };
    if !nt.answerers_only {
        crate::notifications::notify_on(CHANNEL, &nt.title, &nt.body);
        return;
    }
    let guild = a.guild.clone();
    tauri::async_runtime::spawn(async move {
        let client = CosmosClient::new();
        if let Ok((st, g)) = standing(&client, &guild).await {
            if st.can_answer(&Policy::from_guild(&g)) {
                crate::notifications::notify_on(CHANNEL, &nt.title, &nt.body);
            }
        }
    });
}

// ── Reads ──────────────────────────────────────────────────────────────────

fn identity() -> Result<(String, String), String> {
    let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
    let pid = gs.player_id.clone().unwrap_or_default();
    let addr = gs.wallet_address.clone().unwrap_or_default();
    if pid.is_empty() || addr.is_empty() {
        return Err("primary identity not synced yet".into());
    }
    Ok((pid, addr))
}

async fn walk(client: &CosmosClient, path: &str, key: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut next: Option<String> = None;
    for _ in 0..20 {
        let url = match &next {
            Some(k) => format!("{path}?pagination.limit=1000&pagination.key={}", crate::mcp::cosmos_client::encode_pagination_key(k)),
            None => format!("{path}?pagination.limit=1000"),
        };
        let Ok(page) = client.lcd_get(&url).await else { break };
        if let Some(Value::Array(a)) = page.get(key) {
            rows.extend(a.iter().cloned());
        }
        next = page.pointer("/pagination/next_key").and_then(|k| k.as_str()).filter(|k| !k.is_empty()).map(String::from);
        if next.is_none() {
            break;
        }
    }
    rows
}

/// Every pending application on chain (a small store: resolved rows vanish).
pub async fn pending(client: &CosmosClient) -> Vec<App> {
    walk(client, "/structs/guild_membership_application", "GuildMembershipApplication")
        .await
        .iter()
        .map(App::from_lcd)
        .filter(|a| a.status == "proposed")
        .collect()
}

/// The signer's standing in `guild_id`, and the guild object.
pub async fn standing(client: &CosmosClient, guild_id: &str) -> Result<(Standing, Value), String> {
    let (me, address) = identity()?;
    let player = client.query_entity("player", &me).await?;
    let p = player.get("Player").cloned().unwrap_or(Value::Null);
    let own_guild = str_of(p.get("guildId"));
    let rank = num(p.get("guildRank")) as u64;
    let guild = client.query_entity("guild", guild_id).await.map_err(|e| format!("guild {guild_id}: {e}"))?;
    let g = guild.get("Guild").cloned().unwrap_or(Value::Null);
    let owner = str_of(g.get("owner")) == me;
    let member = own_guild == guild_id;
    let owns_own_guild = if member {
        owner
    } else if own_guild.starts_with("0-") {
        client
            .query_entity("guild", &own_guild)
            .await
            .ok()
            .and_then(|v| v.pointer("/Guild/owner").and_then(|o| o.as_str()).map(|o| o == me))
            .unwrap_or(false)
    } else {
        false
    };
    let direct = walk(client, &format!("/structs/permission/object/{guild_id}"), "permissionRecords")
        .await;
    let direct = parse_object_grants(&direct, guild_id).into_iter().find(|(w, _)| *w == me).map(|(_, b)| b).unwrap_or(0);
    let ranked = if member {
        client
            .lcd_get(&format!("/structs/guild_rank_permission/object/{guild_id}/guild/{guild_id}"))
            .await
            .ok()
            .and_then(|v| v.get("guild_rank_permission_records").and_then(|a| a.as_array()).cloned())
            .map(|rows| rank_bits(&parse_rank_grants(&rows, guild_id), rank))
            .unwrap_or(0)
    } else {
        0
    };
    let key = client.address_record(&address).await.map(|(_, b)| b).unwrap_or(0);
    Ok((Standing { me, own_guild, rank, owner, owns_own_guild, member, direct, ranked, key }, g))
}

pub async fn sub_power(client: &CosmosClient, id: &str) -> Option<SubPower> {
    if id.is_empty() {
        return None;
    }
    let sub = client.query_entity("substation", id).await.ok()?;
    let ga = sub.get("gridAttributes");
    Some(SubPower {
        id: id.to_string(),
        capacity: num(ga.and_then(|x| x.get("capacity"))),
        load: num(ga.and_then(|x| x.get("load"))),
        connections: num(ga.and_then(|x| x.get("connectionCount"))) as u64,
    })
}

/// A player's draw and their current substation's share.
pub async fn draw_of(client: &CosmosClient, player: &str) -> (Draw, f64) {
    let Ok(v) = client.query_entity("player", player).await else { return (Draw::default(), 0.0) };
    let ga = v.get("gridAttributes");
    let d = Draw {
        load: num(ga.and_then(|x| x.get("load"))),
        structs_load: num(ga.and_then(|x| x.get("structsLoad"))),
        capacity: num(ga.and_then(|x| x.get("capacity"))),
        substation: str_of(v.pointer("/Player/substationId")),
    };
    let share = match sub_power(client, &d.substation).await {
        Some(s) => s.share_with(0),
        None => 0.0,
    };
    (d, share)
}

/// Fuel the player has infused across every reactor (direct join counts the
/// guild's reactor as it is and redelegates the rest).
pub async fn infused(client: &CosmosClient, address: &str) -> (u64, Vec<(String, String, u64)>) {
    let reactors = walk(client, "/structs/reactor", "Reactor").await;
    let mut total = 0u64;
    let mut found = Vec::new();
    for r in reactors {
        let rid = str_of(r.get("id"));
        if rid.is_empty() {
            continue;
        }
        let Ok(v) = client.lcd_get(&format!("/structs/infusion/{rid}/{address}")).await else { continue };
        let inf = v.get("Infusion").cloned().unwrap_or(Value::Null);
        let fuel = u64_of(inf.get("fuel"));
        if fuel > 0 {
            total = total.saturating_add(fuel);
            // Infusion ids are `<reactor id>-<address>` (keeper/infusion.go:62-68).
            found.push((format!("{rid}-{address}"), rid, fuel));
        }
    }
    (total, found)
}

/// A short, read-only profile of an applicant from the shared snapshot.
fn brief(id: &str, height: u64) -> Value {
    crate::mcp::perception::with_snapshot(|s| {
        let row = s.player_row(id);
        let last = s.grid_attr(id, "lastAction").filter(|b| *b > 0);
        json!({
            "player_id": id,
            "name": row.and_then(|r| r.get("username")).cloned().unwrap_or(Value::Null),
            "pfp": row.and_then(|r| r.get("pfpClientRenderAttributes")).cloned().unwrap_or(Value::Null),
            "guild_id": row.and_then(|r| r.get("guildId")).cloned().unwrap_or(Value::Null),
            "rank": row.and_then(|r| r.get("guildRank")).cloned().unwrap_or(Value::Null),
            "draw_mw": s.grid_attr(id, "structsLoad").unwrap_or(0) + s.grid_attr(id, "load").unwrap_or(0),
            "quiet_blocks": last.map(|b| height.saturating_sub(b)),
        })
    })
    .unwrap_or_else(|| json!({ "player_id": id }))
}

/// Resolved applications (and pending ones' ages) from the Guild API. Best
/// effort: the route needs a guild login, so an error is returned as text.
async fn history(client: &CosmosClient, path: &str) -> Result<Vec<Value>, String> {
    let (rows, _, _) = client.guild.walk_list(path, 100, 3).await?;
    Ok(rows)
}

fn history_rows(rows: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let a = App::from_row(r);
            json!({
                "guild_id": a.guild, "player_id": a.player, "join_type": a.kind, "status": a.status,
                "proposer": a.proposer, "created_at": r.get("created_at"), "updated_at": r.get("updated_at"),
            })
        })
        .collect();
    out.sort_by(|a, b| b["updated_at"].as_str().unwrap_or("").cmp(a["updated_at"].as_str().unwrap_or("")));
    out
}

fn since_of(hist: &[Value], guild: &str, player: &str) -> Value {
    hist.iter()
        .find(|h| h["guild_id"] == guild && h["player_id"] == player && h["status"] == "proposed")
        .and_then(|h| h.get("created_at").cloned())
        .unwrap_or(Value::Null)
}

/// Everything the Members card needs about `guild_id` (default: your own).
pub async fn board(guild_id: Option<String>) -> Result<Value, String> {
    let client = CosmosClient::new();
    let gid = match guild_id.filter(|g| !g.trim().is_empty()) {
        Some(g) => g.trim().to_string(),
        None => crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone()).unwrap_or_default(),
    };
    if !gid.starts_with("0-") {
        return Err(if gid.is_empty() { "you are not in a guild — name one".into() } else { format!("{gid} is not a guild id") });
    }
    let (st, g) = standing(&client, &gid).await?;
    let policy = Policy::from_guild(&g);
    let sub = sub_power(&client, &policy.entry_substation).await;
    let apps: Vec<App> = pending(&client).await.into_iter().filter(|a| a.guild == gid).collect();
    let height = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    let (hist, hist_err) = match history(&client, &format!("/api/guild-membership-application/guild/{gid}")).await {
        Ok(rows) => (history_rows(&rows), Value::Null),
        Err(e) => (Vec::new(), json!(e)),
    };
    let row = |a: &App| {
        let mut b = brief(&a.player, height);
        b["join_type"] = json!(a.kind);
        b["proposer"] = json!(a.proposer);
        b["substation_id"] = json!(a.substation);
        b["since"] = since_of(&hist, &a.guild, &a.player);
        b
    };
    let requests: Vec<Value> = apps.iter().filter(|a| a.kind == "request").map(row).collect();
    let invites: Vec<Value> = apps.iter().filter(|a| a.kind == "invite").map(row).collect();
    let resolved: Vec<Value> = hist.iter().filter(|h| h["status"] != "proposed").take(50).cloned().collect();
    Ok(json!({
        "guild_id": gid,
        "owner": str_of(g.get("owner")),
        "policy": policy.json(),
        "me": st.json(&policy),
        "power": sub.as_ref().map(|s| guild_impact(s, 1)),
        "requests": requests,
        "invites": invites,
        "history": resolved,
        "history_error": hist_err,
    }))
}

/// The door a guild shows the signer, and what walking through it does to
/// their power.
pub async fn door_for(guild_id: String) -> Result<Value, String> {
    let client = CosmosClient::new();
    let (st, g) = standing(&client, &guild_id).await?;
    let policy = Policy::from_guild(&g);
    let mine: Vec<App> = pending(&client).await.into_iter().filter(|a| a.player == st.me).collect();
    let here = |kind: &str| mine.iter().find(|a| a.guild == guild_id && a.kind == kind).cloned();
    let invite = here("invite");
    let infused_total = if policy.minimum > 0 && policy.direct_open() && !st.member {
        let (_, address) = identity()?;
        Some(infused(&client, &address).await.0)
    } else {
        None
    };
    let viewer = Viewer {
        member: st.member,
        owns: (st.owns_own_guild && !st.member).then(|| st.own_guild.clone()),
        invited: invite.is_some(),
        requested: here("request").is_some(),
        infused: infused_total,
    };
    let target_id = invite.as_ref().map(|a| a.substation.clone()).filter(|s| !s.is_empty()).unwrap_or(policy.entry_substation.clone());
    let target = sub_power(&client, &target_id).await;
    let (draw, now_share) = draw_of(&client, &st.me).await;
    Ok(json!({
        "guild_id": guild_id,
        "policy": policy.json(),
        "me": st.json(&policy),
        "doors": doors(&policy, &viewer),
        "infused": infused_total.map(|v| v.to_string()),
        "impact": (!st.member).then(|| joiner_impact(&draw, now_share, target.as_ref())),
        "pending_elsewhere": mine.iter().filter(|a| a.guild != guild_id).count(),
    }))
}

/// The signer's own applications: invites to them, their requests.
pub async fn inbox() -> Result<Value, String> {
    let client = CosmosClient::new();
    let (me, _) = identity()?;
    let own_guild = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone()).unwrap_or_default();
    let mine: Vec<App> = pending(&client).await.into_iter().filter(|a| a.player == me).collect();
    let (draw, now_share) = draw_of(&client, &me).await;
    let (hist, hist_err) = match history(&client, &format!("/api/guild-membership-application/player/{me}")).await {
        Ok(rows) => (history_rows(&rows), Value::Null),
        Err(e) => (Vec::new(), json!(e)),
    };
    let mut rows = Vec::new();
    for a in &mine {
        let g = client.query_entity("guild", &a.guild).await.ok().and_then(|v| v.get("Guild").cloned()).unwrap_or(Value::Null);
        let policy = Policy::from_guild(&g);
        let target_id = if a.substation.is_empty() { policy.entry_substation.clone() } else { a.substation.clone() };
        let target = sub_power(&client, &target_id).await;
        rows.push(json!({
            "guild_id": a.guild,
            "guild_name": str_of(g.get("name")),
            "join_type": a.kind,
            "proposer": a.proposer,
            "substation_id": a.substation,
            "since": since_of(&hist, &a.guild, &me),
            "impact": joiner_impact(&draw, now_share, target.as_ref()),
        }));
    }
    Ok(json!({
        "player_id": me,
        "guild_id": own_guild,
        "invites": rows.iter().filter(|r| r["join_type"] == "invite").cloned().collect::<Vec<_>>(),
        "requests": rows.iter().filter(|r| r["join_type"] == "request").cloned().collect::<Vec<_>>(),
        "history": hist.iter().filter(|h| h["status"] != "proposed").take(30).cloned().collect::<Vec<_>>(),
        "history_error": hist_err,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guild(min: &str, req: &str, inv: &str) -> Value {
        json!({ "joinInfusionMinimum": min, "joinInfusionMinimumBypassByRequest": req,
                "joinInfusionMinimumBypassByInvite": inv, "entryRank": "101", "entrySubstationId": "4-9" })
    }

    #[test]
    fn the_four_founding_choices_read_back_as_themselves() {
        let max = u64::MAX.to_string();
        assert_eq!(Policy::from_guild(&guild("0", "closed", "closed")).label(), "open");
        assert_eq!(Policy::from_guild(&guild("2500000", "closed", "permissioned")).label(), "stake");
        assert_eq!(Policy::from_guild(&guild(&max, "permissioned", "permissioned")).label(), "application");
        assert_eq!(Policy::from_guild(&guild(&max, "closed", "permissioned")).label(), "invite only");
        assert_eq!(Policy::from_guild(&guild(&max, "closed", "closed")).label(), "closed");
        // Every live guild on 2026-11-13: the chain default.
        let live = Policy::from_guild(&json!({ "joinInfusionMinimum": "0", "joinInfusionMinimumBypassByRequest": "closed",
            "joinInfusionMinimumBypassByInvite": "closed", "entryRank": "101" }));
        assert_eq!(live.label(), "open");
        assert_eq!(live.entry_substation, "");
    }

    #[test]
    fn levels_tolerate_enum_numbers() {
        let p = Policy::from_guild(&json!({ "joinInfusionMinimumBypassByRequest": 2, "joinInfusionMinimumBypassByInvite": "1" }));
        assert_eq!((p.request.as_str(), p.invite.as_str()), ("member", "permissioned"));
    }

    fn st(member: bool, owner: bool, direct: u64, ranked: u64, key: u64) -> Standing {
        Standing { me: "1-9".into(), own_guild: if member { "0-6".into() } else { "0-1".into() }, rank: 50, owner, member, direct, ranked, key, ..Default::default() }
    }

    #[test]
    fn who_may_invite_and_answer_follows_the_level() {
        let m = bits::GUILD_MEMBERSHIP;
        let p = |req: &str, inv: &str| Policy { request: req.into(), invite: inv.into(), ..Default::default() };
        // closed: nobody, the owner included.
        assert!(!st(true, true, 0, 0, m).can_invite(&p("closed", "closed")));
        // permissioned: a holder of 512, by direct or rank grant.
        assert!(st(true, false, m, 0, m).can_answer(&p("permissioned", "closed")));
        assert!(st(true, false, 0, m, m).can_answer(&p("permissioned", "closed")));
        assert!(!st(true, false, 0, 0, m).can_answer(&p("permissioned", "closed")));
        assert!(!st(false, false, 0, m, m).can_answer(&p("permissioned", "closed")), "rank grants need membership");
        // member: any member — but the KEY must still carry 512.
        assert!(st(true, false, 0, 0, m).can_invite(&p("closed", "member")));
        assert!(!st(true, false, 0, 0, 0).can_invite(&p("closed", "member")));
        assert!(!st(false, false, 0, 0, m).can_invite(&p("closed", "member")));
        // The owner holds every bit.
        assert!(st(true, true, 0, 0, m).can_answer(&p("permissioned", "closed")));
    }

    #[test]
    fn rank_changes_need_admin_directly() {
        assert!(st(true, false, bits::ADMIN, 0, bits::ADMIN).can_set_rank());
        assert!(!st(true, false, 0, bits::ADMIN, bits::ADMIN).can_set_rank(), "v0.22: rank admin is inert");
        assert!(st(true, true, 0, 0, bits::ADMIN).can_set_rank());
    }

    fn pol(min: u64, req: &str, rank_join: bool) -> Policy {
        Policy { minimum: min, request: req.into(), invite: "permissioned".into(), rank_join, ..Default::default() }
    }

    #[test]
    fn a_visitor_sees_one_primary_door() {
        let open = doors(&pol(0, "closed", false), &Viewer::default());
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["action"], "join");
        assert_eq!(open[0]["primary"], true);

        let app = doors(&pol(u64::MAX, "permissioned", true), &Viewer::default());
        assert_eq!(app.iter().map(|d| d["action"].as_str().unwrap()).collect::<Vec<_>>(), vec!["request", "rank"]);
        assert_eq!(app[0]["primary"], true);
        assert_eq!(app[1]["primary"], false);

        assert!(doors(&pol(u64::MAX, "closed", false), &Viewer::default()).is_empty(), "closed: no door");
        assert!(doors(&pol(0, "member", true), &Viewer { member: true, ..Default::default() }).is_empty(), "members see none");
    }

    #[test]
    fn a_pending_application_replaces_the_way_in() {
        let p = pol(0, "permissioned", false);
        let inv = doors(&p, &Viewer { invited: true, ..Default::default() });
        assert_eq!(inv[0]["action"], "accept_invite");
        assert_eq!(inv[1]["action"], "decline_invite");
        let req = doors(&p, &Viewer { requested: true, ..Default::default() });
        assert_eq!(req.len(), 1);
        assert_eq!(req[0]["action"], "request_revoke");
    }

    #[test]
    fn an_owner_and_a_short_stake_are_blocked_with_a_reason() {
        let owner = doors(&pol(0, "permissioned", false), &Viewer { owns: Some("0-3".into()), ..Default::default() });
        assert!(owner.iter().all(|d| d["enabled"] == false || d["action"] == "decline_invite"));
        assert!(owner[0]["why"].as_str().unwrap().contains("0-3"));
        let short = doors(&pol(2_500_000, "closed", false), &Viewer { infused: Some(1_000_000), ..Default::default() });
        assert_eq!(short[0]["enabled"], false);
        let enough = doors(&pol(2_500_000, "closed", false), &Viewer { infused: Some(3_000_000), ..Default::default() });
        assert_eq!(enough[0]["enabled"], true);
    }

    #[test]
    fn shares_follow_the_keeper_rule() {
        // Live 4-1 on 2026-11-01: 41,614,860,000 capacity, 0 load, 5,046
        // connections → connectionCapacity 7,422,388.
        let s = SubPower { id: "4-1".into(), capacity: 41_614_860_000.0, load: 0.0, connections: 5046 };
        assert_eq!(s.share_with(0), 7_422_388.0);
        assert!(s.share_with(1) < s.share_with(0));
        let empty = SubPower { id: "4-3".into(), capacity: 1000.0, load: 0.0, connections: 0 };
        assert_eq!(empty.share_with(0), 900.0, "no connections: the whole usable pool");
    }

    #[test]
    fn a_joiner_sees_whether_they_stay_online() {
        // 0-2 today: 1.05 kW a member; a typical p75 member draws 2.18 kW.
        let target = SubPower { id: "4-2".into(), capacity: 93_148_795.0, load: 0.0, connections: 80 };
        let draw = Draw { load: 0.0, structs_load: 2_180_000.0, capacity: 0.0, substation: "4-1".into() };
        let v = joiner_impact(&draw, 7_400_000.0, Some(&target));
        assert_eq!(v["online_now"], true);
        assert_eq!(v["online_after"], false);
        // Already on the target: no extra connection.
        let here = Draw { substation: "4-2".into(), ..draw.clone() };
        assert_eq!(joiner_impact(&here, 0.0, Some(&target))["share_after_mw"], target.share_with(0));
        // No entry substation: nothing after.
        assert_eq!(joiner_impact(&draw, 7_400_000.0, None)["share_after_mw"], 0.0);
    }

    #[test]
    fn applications_parse_from_every_source() {
        let lcd = App::from_lcd(&json!({ "guildId": "0-6", "playerId": "1-42", "joinType": "invite", "proposer": "1-9", "substationId": "" }));
        assert_eq!((lcd.kind.as_str(), lcd.status.as_str()), ("invite", "proposed"), "LCD omits the zero status");
        let grass = App::from_row(&json!({ "guild_id": "0-6", "player_id": "1-42", "join_type": "request", "status": "approved", "proposer": "1-42" }));
        assert_eq!((grass.kind.as_str(), grass.status.as_str()), ("request", "approved"));
        assert_eq!(App::from_lcd(&json!({ "joinType": 1, "registrationStatus": 3 })).status, "revoked");
    }

    #[test]
    fn alerts_go_to_the_people_they_concern() {
        let name = |id: &str| id.to_string();
        let app = |kind: &str, status: &str, player: &str, proposer: &str| App {
            guild: "0-6".into(), player: player.into(), kind: kind.into(), status: status.into(), proposer: proposer.into(), substation: String::new(),
        };
        // A request reaches the guild's answerers, never the requester.
        let n = notice(&app("request", "proposed", "1-42", "1-42"), "1-9", "0-6", &name).unwrap();
        assert!(n.answerers_only);
        assert!(notice(&app("request", "proposed", "1-42", "1-42"), "1-42", "0-1", &name).is_none());
        // An invite reaches the invitee; the outcome reaches the inviter.
        assert!(!notice(&app("invite", "proposed", "1-9", "1-7"), "1-9", "0-1", &name).unwrap().answerers_only);
        assert!(notice(&app("invite", "approved", "1-42", "1-9"), "1-9", "0-6", &name).unwrap().title.contains("joined"));
        assert!(notice(&app("request", "denied", "1-9", "1-9"), "1-9", "0-1", &name).unwrap().title.contains("turned you down"));
        // Someone else's business: nothing.
        let other = app("invite", "proposed", "1-42", "1-7");
        assert!(notice(&other, "1-9", "0-1", &name).is_none());
        assert!(!concerns(&other, "1-9", "0-1"));
        assert!(concerns(&other, "1-9", "0-6"), "a change in my own guild refreshes my cards");
    }
}
