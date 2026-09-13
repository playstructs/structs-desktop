//! Crews — the people who hash for each other.
//!
//! A proof is the one piece of this game somebody else's machine can do for
//! you. The grinding input is entirely public (`{object}{TASK}{anchor}NONCE`),
//! so a nonce found on their computer is bit-identical to one found on yours.
//! What is NOT public is the right to submit it — and the chain models that
//! right explicitly, as four grantable bits.
//!
//! `matrix/work.rs` built the cautious half of this: grind for a stranger and
//! post the number back for them to submit. That needs no trust and it works,
//! but every proof has to survive a federation round trip and a human click,
//! and every submission still lands on one address — which is our actual
//! throughput ceiling.
//!
//! A crew is the other half. You grant your crewmates `PermHashAll` on your
//! own player object (one free transaction, no charge) and from then on their
//! machines can finish your work outright. Nothing else comes with that grant:
//! not your tokens, not your structs, not your account. The chain checks the
//! single bit matching the message
//! (`keeper/player_cache.go` → `CanMineHashedBy` → `PermissionCheck`), and
//! writes an `EventHashSuccess{callerAddress, category, difficulty}` receipt
//! naming who did the work and how hard it was. That receipt is what the
//! payout ledger is built from — consensus, not a claim in a chat room.
//!
//! This module owns three things and no more: what a crew IS (persisted
//! config), opening and closing your work to one (grant/revoke), and the
//! question every helper must answer before it spends a single GPU cycle on
//! somebody else's object — *am I actually allowed to finish this?*
//!
//! That last one FAILS CLOSED. A read failure is not permission. Grinding
//! without authority burns your own electricity on a transaction the ante will
//! reject, and `send_guard` already taught this codebase what "unknown is not
//! yes" is worth.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::types::TaskType;

const FILENAME: &str = "crew.json";

// ── The permission bits ─────────────────────────────────────────────────────
//
// From the chain's own `x/structs/types/permissions.go`. Each completion
// message is gated on ONE of these, not on the composite — a helper granted
// only `PermHashMine` can finish your mining and nothing else. We grant the
// composite by default because splitting it serves no purpose we can name,
// but the check is always per-bit so a narrower grant works correctly.

pub const PERM_HASH_BUILD: u64 = 1 << 20; // 1_048_576
pub const PERM_HASH_MINE: u64 = 1 << 21; // 2_097_152
pub const PERM_HASH_REFINE: u64 = 1 << 22; // 4_194_304
pub const PERM_HASH_RAID: u64 = 1 << 23; // 8_388_608
/// `PermHashAll` — every completion kind, and nothing else. 15,728,640.
pub const PERM_HASH_ALL: u64 = PERM_HASH_BUILD | PERM_HASH_MINE | PERM_HASH_REFINE | PERM_HASH_RAID;

/// The single bit the chain tests for a completion of this kind.
pub fn bit_for(task: TaskType) -> u64 {
    match task {
        TaskType::Build => PERM_HASH_BUILD,
        TaskType::Mine => PERM_HASH_MINE,
        TaskType::Refine => PERM_HASH_REFINE,
        TaskType::Raid => PERM_HASH_RAID,
    }
}

// ── What a crew is ──────────────────────────────────────────────────────────

/// What this machine does for a crew.
///
/// Deliberately four states rather than a pair of booleans: "grind but never
/// sign" and "sign but never grind" are both real answers — a laptop on
/// battery is the first, a machine with no GPU worth the name is the second —
/// and a boolean pair makes the nonsensical fourth combination representable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// In the crew, doing nothing. Distinct from not being in it: the grants
    /// stay, so turning back on costs no transaction.
    #[default]
    Off,
    /// Grind for crewmates, but never sign a completion.
    HelpOnly,
    /// Never grind for anyone, but finish proofs when asked.
    CollectOnly,
    /// Both.
    Work,
}

impl Role {
    pub fn grinds(self) -> bool {
        matches!(self, Role::HelpOnly | Role::Work)
    }
    pub fn submits(self) -> bool {
        matches!(self, Role::CollectOnly | Role::Work)
    }
}

/// Whose work this crew covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Everyone joined to the room. The default, and the honest one: the room
    /// is the crew.
    #[default]
    Room,
    /// Everyone in the guild, whether or not they are in the room.
    Guild,
    /// A hand-picked list.
    Chosen,
    /// This machine's own roster — the players whose keys we hold.
    Roster,
    /// Nobody in particular: whoever's proof we spend. Grinds for no one —
    /// it exists to carry PAY TERMS for helpers we have no link with, which
    /// on the bus is most of them.
    Anyone,
}

/// The id of the one crew that covers anyone who helps.
pub const HELPERS_CREW: &str = "helpers";

/// The terms-only crew, as first created: switched off, paying nothing,
/// until somebody sets a rate on the bounty card.
pub fn helpers_crew(guild_id: &str) -> Crew {
    Crew {
        room_id: HELPERS_CREW.to_string(),
        guild_id: guild_id.to_string(),
        name: "Any pheral".to_string(),
        role: Role::Off,
        scope: Scope::Anyone,
        ..Default::default()
    }
}

/// Which crew's terms a helper is paid under. Pure, so it can be tested
/// without a config store: the most specific link wins — named as a friend,
/// then the room the frame arrived in, then their guild, then anyone.
pub fn pick_crew(crews: &[Crew], helper: &str, room_id: &str, their_guild: Option<&str>) -> Option<Crew> {
    if let Some(c) = crews.iter().find(|c| c.scope == Scope::Chosen && c.chosen.iter().any(|p| p == helper)) {
        return Some(c.clone());
    }
    if let Some(c) = crews.iter().find(|c| c.room_id == room_id) {
        return Some(c.clone());
    }
    if let Some(g) = their_guild {
        if let Some(c) = crews.iter().find(|c| c.scope == Scope::Guild && c.guild_id == g) {
            return Some(c.clone());
        }
    }
    crews.iter().find(|c| c.scope == Scope::Anyone).cloned()
}

/// What a crew pays for confirmed work.
///
/// The rate is per unit of ACHIEVED difficulty, which is the chain's own
/// measure of how much work a proof cost (`EventHashSuccess.difficulty`). A
/// flat rate per proof would pay the same for a difficulty-1 freebie as for a
/// difficulty-12 grind, and the easy ones are exactly what a bad actor would
/// farm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pay {
    /// OFF by default. This is standing authority to spend, and nothing in
    /// this app turns that on for you.
    #[serde(default)]
    pub enabled: bool,
    /// `ualpha` or `uguild.<id>`. Validated against `is_sendable` at payout —
    /// this field is a preference, not a permission.
    #[serde(default = "default_denom")]
    pub denom: String,
    /// Base units paid per unit of achieved difficulty.
    #[serde(default)]
    pub rate_per_difficulty: f64,
    /// How often the ledger settles.
    #[serde(default = "default_epoch_secs")]
    pub epoch_secs: u64,
    /// Ceiling on everything this crew pays in one epoch.
    #[serde(default)]
    pub epoch_cap: f64,
    /// Ceiling on what any single helper is paid in one epoch.
    #[serde(default)]
    pub per_helper_cap: f64,
    /// A helper is paid only once they are owed at least this much, so a
    /// busy crew settles in a few transactions an epoch rather than one per
    /// proof. Zero pays whatever is owed. Never above the per-helper cap —
    /// a floor the cap can never reach would pay nobody, ever.
    #[serde(default)]
    pub min_payout: f64,
}

fn default_denom() -> String {
    "ualpha".to_string()
}
fn default_epoch_secs() -> u64 {
    3_600
}

impl Default for Pay {
    fn default() -> Self {
        Self {
            enabled: false,
            denom: default_denom(),
            rate_per_difficulty: 0.0,
            epoch_secs: default_epoch_secs(),
            epoch_cap: 0.0,
            per_helper_cap: 0.0,
            min_payout: 0.0,
        }
    }
}

/// A crew's id.
///
/// Usually a Matrix room, because that is where announcements go — but NOT
/// always, and requiring one was the first thing that made this confusing.
/// "Help my guild" and "help this friend" are complete thoughts on their own;
/// making somebody go and create a room first, before they could say either,
/// put a piece of chat plumbing in front of a game decision.
///
/// So a crew may also be `guild:<id>` or `player:<id>` — a link with no room.
/// Everything works the same except payout announcements, which need somewhere
/// to be announced.
pub fn is_matrix_room(id: &str) -> bool {
    id.starts_with('!')
}

/// The id of the "my guild" crew.
pub fn guild_crew_id(guild_id: &str) -> String {
    format!("guild:{guild_id}")
}

/// The id of the crew that is one friend.
pub fn friend_crew_id(player_id: &str) -> String {
    format!("player:{player_id}")
}

/// A crew: a room or a link, a role, and what we've opened to whom.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Crew {
    /// The room IS the crew's identity. Everything else here is local
    /// preference; this is the part two machines agree on.
    pub room_id: String,
    #[serde(default)]
    pub guild_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub scope: Scope,
    /// Members, when `scope` is `Chosen`.
    #[serde(default)]
    pub chosen: Vec<String>,
    #[serde(default)]
    pub pay: Pay,
    /// Player ids we have granted `PermHashAll` on our own player object.
    /// A local record of transactions we sent, never the source of truth —
    /// the chain is, and `authority_of` reads it.
    #[serde(default)]
    pub granted: Vec<String>,
    /// The guild rank our work is open to, when we've opened it guild-wide.
    #[serde(default)]
    pub guild_rank_open: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CrewConfig {
    #[serde(default)]
    pub crews: Vec<Crew>,
}

static CONFIG: LazyLock<RwLock<CrewConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));

pub fn all() -> Vec<Crew> {
    CONFIG.read().map(|c| c.crews.clone()).unwrap_or_default()
}

pub fn get(room_id: &str) -> Option<Crew> {
    CONFIG
        .read()
        .ok()
        .and_then(|c| c.crews.iter().find(|c| c.room_id == room_id).cloned())
}

/// Add or replace a crew, keyed by room. Returns the stored copy.
pub fn upsert(crew: Crew) -> Result<Crew, String> {
    if crew.room_id.trim().is_empty() {
        return Err("a crew needs an id".into());
    }
    let mut cfg = CONFIG.write().map_err(|_| "crew config unavailable")?;
    match cfg.crews.iter_mut().find(|c| c.room_id == crew.room_id) {
        Some(existing) => *existing = crew.clone(),
        None => cfg.crews.push(crew.clone()),
    }
    crate::mcp::config_store::save_config(FILENAME, &*cfg);
    drop(cfg);
    announce_terms_if_public(&crew.room_id);
    Ok(crew)
}

/// The "anyone" terms are a public offer, so a change to them is announced
/// on the bus. Every other crew's pay is between its members.
fn announce_terms_if_public(room_id: &str) {
    if room_id != HELPERS_CREW {
        return;
    }
    #[cfg(not(test))]
    tauri::async_runtime::spawn(crate::mcp::crew_pay::publish_helpers_terms());
}

/// Forget a crew locally. Deliberately does NOT revoke: leaving a room and
/// withdrawing somebody's permission are different acts, and doing the second
/// silently as a side effect of the first is how a crewmate's machine starts
/// failing transactions it has no way to understand.
pub fn remove(room_id: &str) -> Result<bool, String> {
    let mut cfg = CONFIG.write().map_err(|_| "crew config unavailable")?;
    let before = cfg.crews.len();
    cfg.crews.retain(|c| c.room_id != room_id);
    let removed = cfg.crews.len() != before;
    if removed {
        crate::mcp::config_store::save_config(FILENAME, &*cfg);
    }
    drop(cfg);
    if removed {
        announce_terms_if_public(room_id);
    }
    Ok(removed)
}

/// Every crew this machine actually grinds for.
pub fn working_crews() -> Vec<Crew> {
    all().into_iter().filter(|c| c.role.grinds()).collect()
}

// ── Authority ───────────────────────────────────────────────────────────────

/// Why a helper may (or may not) finish somebody's proof.
///
/// Three yeses rather than a bool because they are operationally different:
/// `Owner` needs nothing, `Granted` is revocable by one person, and
/// `GuildRank` disappears the moment your rank changes or you leave. A card
/// that just says "allowed" cannot explain tomorrow's failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authority {
    Owner,
    Granted,
    GuildRank,
    Denied,
}

impl Authority {
    pub fn allows(self) -> bool {
        !matches!(self, Authority::Denied)
    }
}

/// Everything the decision needs, already read.
///
/// Split from the reads so the rule itself is testable without a chain: this
/// is the function that decides whether we spend a GPU on someone else's
/// object, and it should be provable at a glance.
#[derive(Debug, Clone, Default)]
pub struct AuthorityFacts {
    /// The player who owns the object being finished.
    pub owner: String,
    /// Us — whoever would sign the completion.
    pub me: String,
    /// What the SIGNING ADDRESS itself is allowed to do.
    ///
    /// The chain gates a completion at TWO independent layers and this is the
    /// first: an ante decorator tests the signing address's own permission
    /// bits before the message ever reaches a handler
    /// (`x/structs/keeper/…_complete.go`, and the ladder in
    /// `permissions_context.go`). Owning the object does not exempt you.
    ///
    /// This check was missing entirely. A primary address carries `PermAll` so
    /// it passes in the ordinary case, which is exactly why its absence was
    /// invisible — but any narrower key (a worker address granted only
    /// `PermPlay`) would grind a full proof and then be refused at ante, and
    /// we would have spent the GPU to find out.
    pub address_mask: u64,
    /// The direct object-permission mask we hold on the owner's player object.
    pub direct_mask: u64,
    /// Our guild rank (lower is more privileged; the chain compares `<=`).
    pub my_rank: u64,
    /// `(permissions, rank)` from the owner's guild-rank register, already
    /// filtered to OUR guild by the query path.
    pub rank_records: Vec<(u64, u64)>,
}

/// The rule, in one place.
///
/// Mirrors `PermissionCheck` (`keeper/permissions_context.go`): ownership, an
/// explicit grant, or a guild-rank threshold — for the SINGLE bit that matches
/// this message kind, never the composite.
pub fn decide(facts: &AuthorityFacts, task: TaskType) -> Authority {
    let bit = bit_for(task);
    // Layer 1 first, and it is unconditional: without the bit on the signing
    // ADDRESS nothing else matters, not even owning the object.
    if facts.address_mask & bit != bit {
        return Authority::Denied;
    }
    if !facts.owner.is_empty() && facts.owner == facts.me {
        return Authority::Owner;
    }
    if facts.direct_mask & bit == bit {
        return Authority::Granted;
    }
    // A rank of 0 is an UNSET slot, not "rank zero" — the chain writes the
    // worst-allowed rank there and reserves 0 for "nothing granted". Reading
    // it as a threshold would hand every bit to every guild member.
    if facts
        .rank_records
        .iter()
        .any(|(perms, rank)| *rank >= 1 && perms & bit == bit && facts.my_rank <= *rank)
    {
        return Authority::GuildRank;
    }
    Authority::Denied
}

/// How long an authority answer is trusted.
///
/// A grant is a deliberate act and a revoke is rare, so this can be generous —
/// and it has to be: the alternative is two LCD reads per task per epoch across
/// a whole crew's worth of objects.
const AUTH_TTL_MS: f64 = 300_000.0;

static AUTH_CACHE: LazyLock<dashmap::DashMap<String, (AuthorityFactsCached, f64)>> =
    LazyLock::new(dashmap::DashMap::new);

#[derive(Debug, Clone)]
struct AuthorityFactsCached {
    address_mask: u64,
    direct_mask: u64,
    my_rank: u64,
    rank_records: Vec<(u64, u64)>,
}

/// The signing address's own permission bits, and the address it read them
/// from. Cached per SIGNER — it does not vary by owner, so a crew of fifty
/// costs one read, not fifty.
static ADDRESS_MASK: LazyLock<dashmap::DashMap<String, (u64, f64)>> =
    LazyLock::new(dashmap::DashMap::new);

/// Drop every cached answer. Called after we grant or revoke, so the card
/// shows what we just did rather than what was true five minutes ago.
pub fn forget_authority() {
    AUTH_CACHE.clear();
    ADDRESS_MASK.clear();
}

/// What the chain lets THIS signing address do, whoever owns the object.
///
/// `/structs/address/{addr}` also names the player it belongs to, and that is
/// checked: an address whose `playerId` is not us is not our authority to
/// spend, however permissive its bits.
async fn address_mask_of(client: &CosmosClient, me: &str) -> Result<u64, String> {
    let now = now_millis();
    if let Some(hit) = ADDRESS_MASK.get(me) {
        if now - hit.1 < AUTH_TTL_MS {
            return Ok(hit.0);
        }
    }
    let player = client.entity("player", me).await?;
    let address = player
        .get("Player")
        .and_then(|p| p.get("primaryAddress"))
        .and_then(|a| a.as_str())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| format!("{me} has no address on chain"))?
        .to_string();
    let rec = client.lcd_get(&format!("/structs/address/{address}")).await?;
    let belongs = rec
        .get("address")
        .and_then(|a| a.get("playerId").or_else(|| rec.get("playerId")))
        .or_else(|| rec.get("playerId"))
        .and_then(|p| p.as_str())
        .unwrap_or_default();
    if belongs != me {
        return Err(format!("{address} is registered to {belongs}, not {me}"));
    }
    let mask = rec
        .get("address")
        .and_then(|a| a.get("permissions"))
        .or_else(|| rec.get("permissions"))
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0);
    ADDRESS_MASK.insert(me.to_string(), (mask, now));
    Ok(mask)
}

/// May `me` submit a `task` completion for an object owned by `owner`?
///
/// Reads the chain. **Fails closed**: an unreadable answer is an `Err`, never
/// a quiet `Denied` and never an optimistic yes — the caller must be able to
/// tell "you are not allowed" from "I could not find out", because the first
/// is a settled fact and the second is worth retrying.
pub async fn authority_of(
    client: &CosmosClient,
    owner: &str,
    me: &str,
    my_guild: &str,
    task: TaskType,
) -> Result<Authority, String> {
    if owner.is_empty() || me.is_empty() {
        return Err("authority needs both an owner and a signer".into());
    }
    // Layer 1 is about US, not about the owner, so it is read even when we own
    // the object — the ante does not exempt an owner either.
    let address_mask = address_mask_of(client, me).await?;
    if owner == me {
        return Ok(if address_mask & bit_for(task) == bit_for(task) {
            Authority::Owner
        } else {
            Authority::Denied
        });
    }
    let key = format!("{owner}|{me}|{my_guild}");
    let now = now_millis();
    if let Some(hit) = AUTH_CACHE.get(&key) {
        if now - hit.1 < AUTH_TTL_MS {
            let c = hit.0.clone();
            return Ok(decide(
                &AuthorityFacts {
                    owner: owner.to_string(),
                    me: me.to_string(),
                    address_mask: c.address_mask,
                    direct_mask: c.direct_mask,
                    my_rank: c.my_rank,
                    rank_records: c.rank_records,
                },
                task,
            ));
        }
    }

    let direct_mask = client.permission_value(owner, me).await?;

    // The guild-rank leg is only asked when we're in a guild at all, and a
    // failure there is not fatal: a direct grant already answers yes, and
    // asking the chain for a register that may not exist should not turn a
    // working crew off.
    let (my_rank, rank_records) = if my_guild.is_empty() {
        (0, Vec::new())
    } else {
        let rank = player_guild_rank(client, me).await.unwrap_or(u64::MAX);
        (rank, rank_records_for(client, owner, my_guild).await.unwrap_or_default())
    };

    AUTH_CACHE.insert(
        key,
        (
            AuthorityFactsCached { address_mask, direct_mask, my_rank, rank_records: rank_records.clone() },
            now,
        ),
    );
    Ok(decide(
        &AuthorityFacts {
            owner: owner.to_string(),
            me: me.to_string(),
            address_mask,
            direct_mask,
            my_rank,
            rank_records,
        },
        task,
    ))
}

/// `(permissions, rank)` pairs the owner has opened to one guild.
async fn rank_records_for(
    client: &CosmosClient,
    object_id: &str,
    guild_id: &str,
) -> Result<Vec<(u64, u64)>, String> {
    let v = client
        .lcd_get(&format!(
            "/structs/guild_rank_permission/object/{object_id}/guild/{guild_id}"
        ))
        .await?;
    Ok(parse_rank_records(&v))
}

/// Pull `(permissions, rank)` out of an LCD response.
///
/// Split out and tested because this shape is the chain's, not ours, and every
/// numeric field on it arrives as a STRING — reading them as numbers silently
/// yields zero, and a zero rank means "nothing granted", so the whole
/// guild-rank leg would fail closed for a reason nobody could see.
pub fn parse_rank_records(v: &Value) -> Vec<(u64, u64)> {
    let num = |x: Option<&Value>| -> u64 {
        x.and_then(|n| n.as_u64().or_else(|| n.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0)
    };
    v.get("guildRankPermissionRecords")
        .or_else(|| v.get("guild_rank_permission_records"))
        .and_then(|r| r.as_array())
        .map(|rows| {
            rows.iter()
                .map(|r| (num(r.get("permissions")), num(r.get("rank"))))
                .collect()
        })
        .unwrap_or_default()
}

async fn player_guild_rank(client: &CosmosClient, player_id: &str) -> Result<u64, String> {
    let v = client.entity("player", player_id).await?;
    Ok(v.get("Player")
        .and_then(|p| p.get("guildRank"))
        .and_then(|r| r.as_u64().or_else(|| r.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(u64::MAX))
}

/// Everyone who has opened their work to us, straight from the chain.
///
/// THE DIRECTION MATTERS, and getting it backwards is what makes a crew look
/// broken. Opening your work to a guild grants OTHERS the right to finish
/// YOUR proofs; it grants you nothing. Helping is two-sided and each side
/// opens separately, so "who am I in a guild with" is not an answer to "whose
/// work may I finish" — only this is.
///
/// It is also the only affordable shape. Asking per candidate is one read per
/// player per pass, which for a 2,500-member guild is a scan measured in
/// minutes; this is one paginated walk of the records that name US, however
/// large the guild.
///
/// `permissionId` is `"{owner}@{signer}"`. The endpoint filters AFTER
/// pagination, so an empty page is not the end of the list — stopping there
/// would silently under-report who we may help.
pub async fn grants_to_me(client: &CosmosClient, me: &str) -> Result<HashMap<String, u64>, String> {
    let mut out: HashMap<String, u64> = HashMap::new();
    let mut cursor: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        let mut path = format!("/structs/permission/player/{me}?pagination.limit=1000");
        if let Some(c) = &cursor {
            path.push_str(&format!("&pagination.key={}", urlencode(c)));
        }
        let page = client.lcd_get(&path).await?;
        for rec in page
            .get("permissionRecords")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let Some(id) = rec.get("permissionId").and_then(|v| v.as_str()) else { continue };
            let Some((owner, signer)) = id.split_once('@') else { continue };
            if signer != me || crate::matrix::refs::parse_id(owner).is_none() {
                continue;
            }
            let value = rec
                .get("value")
                .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0);
            out.insert(owner.to_string(), value);
        }
        let next = page
            .get("pagination")
            .and_then(|p| p.get("next_key"))
            .and_then(|k| k.as_str())
            .unwrap_or_default()
            .to_string();
        if next.is_empty() {
            break;
        }
        // A cursor that repeats, or a walk that will not end, is a broken
        // inventory — and an under-reported one reads as "nobody has opened
        // their work to you", which is a lie we must not tell quietly.
        if !seen.insert(next.clone()) || seen.len() > 200 {
            return Err("permission inventory did not terminate".into());
        }
        cursor = Some(next);
    }
    Ok(out)
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

// ── Opening and closing your work ───────────────────────────────────────────

/// Grant a crewmate the right to finish your proofs.
///
/// One `MsgPermissionGrantOnObject` on your OWN player object — the same
/// message `delegation.rs` has been sending for the whole roster, with
/// `PermHashAll` in place of `PermAll`. Free gas, no charge: a grant leaves
/// `lastAction` untouched, so it never competes with mining.
///
/// What this hands over, precisely: the right to send four completion
/// messages naming objects you own. Not your tokens, not your structs, not
/// your account. The narrowness is the reason a crew can be strangers.
pub async fn grant(
    app: &tauri::AppHandle,
    index: u32,
    my_player_id: &str,
    helper_player_id: &str,
    permissions: u64,
) -> Result<(), String> {
    if helper_player_id == my_player_id {
        return Err("you already hold every bit on your own work".into());
    }
    if permissions & !PERM_HASH_ALL != 0 {
        // A crew grant is hashing and nothing else. If a caller ever wants to
        // hand over more than that, it must be a different function with its
        // own name, not an unnoticed argument to this one.
        return Err("a crew grant carries hash permissions only".into());
    }
    crate::mcp::tx_retry::sign_with_retry(
        app,
        index,
        "/structs.structs.MsgPermissionGrantOnObject",
        json!({
            "objectId": my_player_id,
            "playerId": helper_player_id,
            "permissions": permissions,
        }),
        &format!("crew:grant:{helper_player_id}"),
    )
    .await
    .map(|_| ())?;
    forget_authority();
    Ok(())
}

/// Withdraw a crewmate's right to finish your proofs.
pub async fn revoke(
    app: &tauri::AppHandle,
    index: u32,
    my_player_id: &str,
    helper_player_id: &str,
    permissions: u64,
) -> Result<(), String> {
    crate::mcp::tx_retry::sign_with_retry(
        app,
        index,
        "/structs.structs.MsgPermissionRevokeOnObject",
        json!({
            "objectId": my_player_id,
            "playerId": helper_player_id,
            "permissions": permissions & PERM_HASH_ALL,
        }),
        &format!("crew:revoke:{helper_player_id}"),
    )
    .await
    .map(|_| ())?;
    forget_authority();
    Ok(())
}

/// Open your work to a whole guild at a rank, in one transaction.
///
/// `rank` is the WORST rank still allowed and must be >= 1 — the chain stores
/// it per bit and reserves 0 for "unset". A guild of 200 becomes a crew here
/// without 200 grants.
pub async fn open_to_guild(
    app: &tauri::AppHandle,
    index: u32,
    my_player_id: &str,
    guild_id: &str,
    rank: u64,
) -> Result<(), String> {
    if rank < 1 {
        return Err("rank must be 1 or greater — 0 means nothing is granted".into());
    }
    crate::mcp::tx_retry::sign_with_retry(
        app,
        index,
        "/structs.structs.MsgPermissionGuildRankSet",
        json!({
            "objectId": my_player_id,
            "guildId": guild_id,
            "permission": PERM_HASH_ALL,
            "rank": rank,
        }),
        &format!("crew:guild-rank:{guild_id}"),
    )
    .await
    .map(|_| ())?;
    forget_authority();
    Ok(())
}

/// Close your work to a guild again.
pub async fn close_to_guild(
    app: &tauri::AppHandle,
    index: u32,
    my_player_id: &str,
    guild_id: &str,
) -> Result<(), String> {
    crate::mcp::tx_retry::sign_with_retry(
        app,
        index,
        "/structs.structs.MsgPermissionGuildRankRevoke",
        json!({
            "objectId": my_player_id,
            "guildId": guild_id,
            "permission": PERM_HASH_ALL,
        }),
        &format!("crew:guild-rank-revoke:{guild_id}"),
    )
    .await
    .map(|_| ())?;
    forget_authority();
    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────────────
//
// Grant and revoke are chain writes that hand somebody authority over your
// objects, so they are gated to the windows that are allowed to act for you.
// Comms is deliberately not on that list: it renders text written by federated
// strangers, and the rule that chat ASKS while Team Ops DECIDES is the same
// rule that keeps a chat message from naming where money goes.

/// Who this machine is, on chain. Public because the submit path needs it too.
pub fn primary_player() -> Result<String, String> {
    crate::mcp::delegation::primary_player_id().ok_or_else(|| "this app does not know who you are yet".into())
}

fn me() -> Result<(String, String), String> {
    let gs = crate::game_state::GAME_STATE
        .read()
        .map_err(|_| "game state unavailable")?;
    let player = gs
        .player_id
        .clone()
        .filter(|p| !p.is_empty())
        .ok_or("this app does not know who you are yet")?;
    Ok((player, gs.guild_id.clone().unwrap_or_default()))
}

/// Every crew, plus who we are — one read for a card that needs both.
///
/// Not knowing our own identity yet is not an error here: the crews are still
/// worth drawing, and the card can say the identity is missing rather than
/// render as a failure during the seconds before game state arrives.
#[tauri::command]
pub fn crew_list() -> Result<Value, String> {
    let (player, guild) = me().unwrap_or_default();
    Ok(json!({
        "crews": all(),
        "player_id": player,
        "guild_id": guild,
        "perm_hash_all": PERM_HASH_ALL,
    }))
}

#[tauri::command]
pub fn crew_save(window: tauri::WebviewWindow, crew: Crew) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let saved = upsert(crew)?;
    Ok(json!({ "ok": true, "crew": saved }))
}

#[tauri::command]
pub fn crew_forget(window: tauri::WebviewWindow, room_id: String) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    Ok(json!({ "ok": true, "removed": remove(&room_id)? }))
}

/// Open your work to one crewmate.
#[tauri::command]
pub async fn crew_grant(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    helper_player_id: String,
    room_id: Option<String>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, _) = me()?;
    grant(&app, 0, &mine, &helper_player_id, PERM_HASH_ALL).await?;
    // Remember locally only AFTER the chain accepted it: `sign_with_retry`
    // treats a non-zero code as a failure, so reaching here means the record
    // exists. A hopeful entry written first would show a crewmate as helping
    // when nothing was granted.
    if let Some(room) = room_id {
        if let Some(mut c) = get(&room) {
            if !c.granted.contains(&helper_player_id) {
                c.granted.push(helper_player_id.clone());
                upsert(c)?;
            }
        }
    }
    Ok(json!({ "ok": true, "granted": helper_player_id }))
}

/// Withdraw one crewmate's right to finish your proofs.
#[tauri::command]
pub async fn crew_revoke(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    helper_player_id: String,
    room_id: Option<String>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, _) = me()?;
    revoke(&app, 0, &mine, &helper_player_id, PERM_HASH_ALL).await?;
    if let Some(room) = room_id {
        if let Some(mut c) = get(&room) {
            c.granted.retain(|p| p != &helper_player_id);
            upsert(c)?;
        }
    }
    Ok(json!({ "ok": true, "revoked": helper_player_id }))
}

/// Open your work to a whole guild at a rank — one transaction for everyone.
#[tauri::command]
pub async fn crew_open_guild(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    guild_id: Option<String>,
    rank: u64,
    room_id: Option<String>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, my_guild) = me()?;
    let guild = guild_id.filter(|g| !g.is_empty()).unwrap_or(my_guild);
    if guild.is_empty() {
        return Err("you are not in a guild, so there is no rank to open to".into());
    }
    open_to_guild(&app, 0, &mine, &guild, rank).await?;
    if let Some(room) = room_id {
        if let Some(mut c) = get(&room) {
            c.guild_rank_open = Some(rank);
            upsert(c)?;
        }
    }
    Ok(json!({ "ok": true, "guild_id": guild, "rank": rank }))
}

#[tauri::command]
pub async fn crew_close_guild(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    guild_id: Option<String>,
    room_id: Option<String>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, my_guild) = me()?;
    let guild = guild_id.filter(|g| !g.is_empty()).unwrap_or(my_guild);
    if guild.is_empty() {
        return Err("you are not in a guild".into());
    }
    close_to_guild(&app, 0, &mine, &guild).await?;
    if let Some(room) = room_id {
        if let Some(mut c) = get(&room) {
            c.guild_rank_open = None;
            upsert(c)?;
        }
    }
    Ok(json!({ "ok": true, "guild_id": guild }))
}

/// Who is in this crew, and what may each of us do for the other?
///
/// Two directions, and they are not the same question: `they_can_help_me` is
/// what I granted, `i_can_help_them` is what they granted me. A card that
/// showed only one would make a half-open crew look symmetrical.
#[tauri::command]
pub async fn crew_roster(guild_id: String, room_id: String) -> Result<Value, String> {
    let (mine, my_guild) = me()?;
    let members = crate::matrix::crew_members(&guild_id, &room_id).await?;
    let client = CosmosClient::new();
    let mut out: Vec<Value> = Vec::new();
    for m in members {
        let Some(pid) = m.get("player_id").and_then(|p| p.as_str()).map(str::to_string) else {
            continue; // a bot or a Matrix-only account: no player, no proofs
        };
        if pid == mine {
            continue;
        }
        // Mine is the cheapest of the four to ask about and the one every
        // colony has, so it stands for "is this link open at all".
        let theirs = authority_of(&client, &mine, &pid, &my_guild, TaskType::Mine)
            .await
            .ok();
        let ours = authority_of(&client, &pid, &mine, &my_guild, TaskType::Mine)
            .await
            .ok();
        out.push(json!({
            "player_id": pid,
            "name": m.get("name").cloned().unwrap_or(Value::Null),
            "user_id": m.get("user_id").cloned().unwrap_or(Value::Null),
            // The portrait a player wrote about themselves on chain. Passed
            // through as the raw attribute string: `pfp.js` validates it, and
            // it is the one piece of this row that is not ours.
            "pfp_attrs": m.get("pfp_attrs").cloned().unwrap_or(Value::Null),
            "tag": m.get("tag").cloned().unwrap_or(Value::Null),
            "they_can_help_me": theirs,
            "i_can_help_them": ours,
        }));
    }
    Ok(json!({ "members": out, "player_id": mine, "guild_id": my_guild }))
}


// ── The two things anybody actually wants to say ────────────────────────────
//
// "I want to help my guild" and "I want to help this person" are complete
// thoughts, and each used to take five controls: make a room a crew, pick a
// scope, pick a role, switch on grinding, then grant. Every one of those is a
// consequence of the decision, not part of it — so each is now ONE call that
// does the lot, and the panel above it is two buttons.
//
// Both directions open at once, deliberately. "Helping" that only ran one way
// would need a sixth control to explain which way, and a crew where nobody
// helps back is not a crew. Either side can be closed again afterwards.

/// Rank 101 reaches everybody: the chain's default rank for a new member sits
/// above anything an admin hands out, and "my guild" has to mean the whole
/// guild or the button is a lie.
const DEFAULT_GUILD_RANK: u64 = 101;

/// Saying "I want to help" has to actually start the helping. Leaving the loop
/// switched off behind a button labelled Help is the kind of thing that makes
/// somebody conclude the feature does not work.
fn start_helping() {
    let mut cfg = crate::mcp::crew_work::get();
    if !cfg.enabled {
        cfg.enabled = true;
        crate::mcp::crew_work::set(cfg);
    }
}

/// Open your work to your guild, and start doing theirs.
///
/// One transaction (`MsgPermissionGuildRankSet`), one config write. `rank` is
/// the worst guild rank still allowed; the default reaches everybody.
#[tauri::command]
pub async fn crew_help_guild(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    guild_id: Option<String>,
    rank: Option<u64>,
    open_my_work: Option<bool>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, my_guild) = me()?;
    let guild = guild_id.filter(|g| !g.is_empty()).unwrap_or(my_guild);
    if guild.is_empty() {
        return Err("you are not in a guild".into());
    }
    // A rank of 0 means "granted to nobody" on chain, which would silently do
    // the opposite of what the button says.
    let rank = rank.filter(|r| *r >= 1).unwrap_or(DEFAULT_GUILD_RANK);

    /* Helping signs NOTHING.
     *
     * Computing a proof needs no rights, so starting to help is a local
     * decision. The first version also opened this player's work to the
     * guild in the same click — a chain transaction handing rights to ~2,500
     * accounts, buried inside a button that said "help". Letting others
     * finish YOUR work is a separate act with its own button, and it is
     * `open_my_work` here only so a caller can ask for both deliberately. */
    if open_my_work.unwrap_or(false) {
        open_to_guild(&app, 0, &mine, &guild, rank).await?;
    }

    let id = guild_crew_id(&guild);
    let mut crew = get(&id).unwrap_or(Crew {
        room_id: id.clone(),
        guild_id: guild.clone(),
        name: "My guild".into(),
        ..Default::default()
    });
    crew.scope = Scope::Guild;
    crew.role = Role::Work;
    if open_my_work.unwrap_or(false) {
        crew.guild_rank_open = Some(rank);
    }
    upsert(crew)?;
    start_helping();
    Ok(json!({ "ok": true, "guild_id": guild, "rank": rank }))
}

/// Open your work to one player, and start doing theirs.
#[tauri::command]
pub async fn crew_help_player(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    player_id: String,
    open_my_work: Option<bool>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, my_guild) = me()?;
    let friend = player_id.trim().to_string();
    if crate::matrix::refs::parse_id(&friend).is_none() {
        return Err(format!("{friend} is not a player id"));
    }

    // See `crew_help_guild`: helping is local; opening your work is a
    // separate, explicit transaction.
    if open_my_work.unwrap_or(false) {
        grant(&app, 0, &mine, &friend, PERM_HASH_ALL).await?;
    }

    let id = friend_crew_id(&friend);
    let mut crew = get(&id).unwrap_or(Crew {
        room_id: id.clone(),
        guild_id: my_guild,
        name: friend.clone(),
        ..Default::default()
    });
    crew.scope = Scope::Chosen;
    crew.chosen = vec![friend.clone()];
    crew.role = Role::Work;
    if open_my_work.unwrap_or(false) && !crew.granted.contains(&friend) {
        crew.granted.push(friend.clone());
    }
    upsert(crew)?;
    start_helping();
    Ok(json!({ "ok": true, "player_id": friend }))
}

/// Stop. Closes our side on chain and takes the link out of the list.
#[tauri::command]
pub async fn crew_stop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    crew_id: String,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (mine, _) = me()?;
    let Some(crew) = get(&crew_id) else {
        return Err(format!("{crew_id} is not a crew here"));
    };
    // Withdraw the grant this link stands on, whichever kind it is. A link
    // removed locally while the grant stays open on chain is the version where
    // somebody keeps finishing your work and you cannot see why.
    if crew.guild_rank_open.is_some() && !crew.guild_id.is_empty() {
        close_to_guild(&app, 0, &mine, &crew.guild_id).await?;
    }
    for p in crew.granted.clone() {
        revoke(&app, 0, &mine, &p, PERM_HASH_ALL).await?;
    }
    remove(&crew_id)?;
    Ok(json!({ "ok": true }))
}

/// The crew whose terms apply to a helper who just did work for us.
///
/// A result carries no crew id — the helper may not even know they are in
/// one — so it is matched here: a crew that names them, a guild crew they
/// belong to, or a room crew the result arrived in. None ⇒ no terms ⇒ no
/// credit, which is a choice the player made by not setting any.
pub fn crew_for_helper(helper: &str, room_id: &str) -> Option<Crew> {
    let their_guild = crate::mcp::perception::with_snapshot(|s| {
        s.player_row(helper)
            .and_then(|p| p.get("guildId"))
            .and_then(|g| g.as_str())
            .map(str::to_string)
    })
    .flatten();
    pick_crew(&all(), helper, room_id, their_guild.as_deref())
}

/// Start paying anyone who helps: creates the terms-only crew if there is
/// none, and returns it. Setting the rate is the bounty card's job.
#[tauri::command]
pub fn crew_pay_anyone(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, &["board", "terminal"])?;
    let (_, my_guild) = me()?;
    if let Some(c) = get(HELPERS_CREW) {
        return Ok(json!({ "ok": true, "crew": c, "created": false }));
    }
    let c = upsert(helpers_crew(&my_guild))?;
    Ok(json!({ "ok": true, "crew": c, "created": true }))
}

/// Everyone we are linked to, in one flat list — the only thing the simple
/// panel shows. Two directions per row, because a half-open link is normal.
#[tauri::command]
pub async fn crew_links() -> Result<Value, String> {
    let (mine, my_guild) = me()?;
    let client = CosmosClient::new();
    let mut rows: Vec<Value> = Vec::new();
    for c in all() {
        let (kind, subject) = match c.scope {
            Scope::Guild => ("guild", c.guild_id.clone()),
            Scope::Anyone => ("anyone", String::new()),
            _ => ("player", c.chosen.first().cloned().unwrap_or_default()),
        };
        /* For a person, ask the chain both ways.
         *
         * For a GUILD the old comment here said "the grant IS the state",
         * which was only half true and hid the half that matters: opening
         * your work to a guild does NOT let you finish anyone else's. Each
         * side opens its own, and one player pressing the button achieves
         * nothing visible on their own. What the card needs is `last_pass`
         * above — whether the loop found work it was permitted to take.
         */
        let (theirs, ours) = if kind == "player" && !subject.is_empty() {
            (
                authority_of(&client, &mine, &subject, &my_guild, TaskType::Mine).await.ok(),
                authority_of(&client, &subject, &mine, &my_guild, TaskType::Mine).await.ok(),
            )
        } else {
            (None, None)
        };
        rows.push(json!({
            "crew_id": c.room_id,
            "kind": kind,
            "subject": subject,
            "pay_enabled": c.pay.enabled,
            "rate": c.pay.rate_per_difficulty,
            "denom": c.pay.denom,
            "name": c.name,
            "working": c.role.grinds(),
            "open_to_guild": c.guild_rank_open,
            "they_can_help_me": theirs,
            "i_can_help_them": ours,
        }));
    }
    Ok(json!({
        "links": rows,
        "player_id": mine,
        "guild_id": my_guild,
        "helping": crate::mcp::crew_work::get().enabled,
        "taking": crate::mcp::crew_work::taking_now(),
        "helped": crate::mcp::crew_work::helped_total(),
        "reported": crate::mcp::crew_work::reported_total(),
        "feed": crate::mcp::crew_work::feed(),
        "bus": crate::mcp::crew_submit::stats(),
        "rates": crate::mcp::crew_pay::terms_on_bus(),
        // Two thresholds, deliberately: what we grind for others, and what
        // the harvest loop grinds for us.
        "crew_threshold": crate::mcp::crew_work::get().difficulty_threshold,
        "own_threshold": crate::mcp::auto_harvest::get().difficulty_threshold,
        // What the loop last saw. Without this, a crew that is working
        // perfectly and a crew nobody has opened their work to look identical
        // — both are simply "0 finished".
        "last_pass": crate::mcp::crew_work::last_pass(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A signing address that holds every hash bit — the ordinary case, since
    /// a player's primary address carries `PermAll`. Tests that care about the
    /// address layer set it explicitly.
    fn facts(direct: u64, rank: u64, records: Vec<(u64, u64)>) -> AuthorityFacts {
        AuthorityFacts {
            owner: "1-61".into(),
            me: "1-194".into(),
            address_mask: PERM_HASH_ALL,
            direct_mask: direct,
            my_rank: rank,
            rank_records: records,
        }
    }

    #[test]
    fn the_bits_are_the_chains_bits() {
        assert_eq!(PERM_HASH_BUILD, 1_048_576);
        assert_eq!(PERM_HASH_MINE, 2_097_152);
        assert_eq!(PERM_HASH_REFINE, 4_194_304);
        assert_eq!(PERM_HASH_RAID, 8_388_608);
        assert_eq!(PERM_HASH_ALL, 15_728_640);
    }

    /* Layer 1: the SIGNING ADDRESS's own bits, checked by the ante before the
     * message reaches a handler. It outranks everything — owning the object
     * does not exempt you from it.
     *
     * This check was missing entirely and its absence was invisible, because a
     * primary address carries `PermAll` and always passed. A narrower key
     * would have ground a whole proof and then been refused at ante.
     */
    #[test]
    fn an_address_without_the_bit_is_refused_even_to_the_owner() {
        let mut f = facts(PERM_HASH_ALL, 0, vec![]);
        f.me = f.owner.clone();          // we own it outright
        f.address_mask = 1;              // …but the key may only PLAY
        assert_eq!(decide(&f, TaskType::Mine), Authority::Denied);
        // With the bit, the same owner is allowed.
        f.address_mask = PERM_HASH_ALL;
        assert_eq!(decide(&f, TaskType::Mine), Authority::Owner);
    }

    #[test]
    fn the_address_layer_is_per_bit_too() {
        let mut f = facts(PERM_HASH_ALL, 0, vec![]);
        f.address_mask = PERM_HASH_MINE;   // this key may finish mining only
        assert_eq!(decide(&f, TaskType::Mine), Authority::Granted);
        assert_eq!(decide(&f, TaskType::Raid), Authority::Denied);
    }

    #[test]
    fn an_owner_needs_no_grant() {
        let mut f = facts(0, 0, vec![]);
        f.me = f.owner.clone();
        assert_eq!(decide(&f, TaskType::Mine), Authority::Owner);
    }

    #[test]
    fn a_direct_grant_of_the_matching_bit_allows_it() {
        let f = facts(PERM_HASH_MINE, 0, vec![]);
        assert_eq!(decide(&f, TaskType::Mine), Authority::Granted);
    }

    /// The whole reason the check is per-bit: a mining grant is not a raid
    /// grant, and treating the composite as one permission would quietly hand
    /// over the most consequential of the four.
    #[test]
    fn a_grant_of_another_bit_does_not_allow_this_one() {
        let f = facts(PERM_HASH_MINE, 0, vec![]);
        assert_eq!(decide(&f, TaskType::Raid), Authority::Denied);
        assert_eq!(decide(&f, TaskType::Build), Authority::Denied);
    }

    #[test]
    fn hash_all_covers_every_kind() {
        let f = facts(PERM_HASH_ALL, 0, vec![]);
        for t in [TaskType::Mine, TaskType::Refine, TaskType::Build, TaskType::Raid] {
            assert_eq!(decide(&f, t), Authority::Granted, "{t:?}");
        }
    }

    #[test]
    fn a_rank_at_or_above_the_threshold_allows_it() {
        let f = facts(0, 3, vec![(PERM_HASH_MINE, 5)]);
        assert_eq!(decide(&f, TaskType::Mine), Authority::GuildRank);
    }

    #[test]
    fn a_rank_below_the_threshold_does_not() {
        let f = facts(0, 7, vec![(PERM_HASH_MINE, 5)]);
        assert_eq!(decide(&f, TaskType::Mine), Authority::Denied);
    }

    /// Rank 0 is an unset slot. Reading it as a threshold would grant the bit
    /// to every member of the guild, which is the worst possible direction for
    /// this mistake to go.
    #[test]
    fn an_unset_rank_slot_grants_nothing() {
        let f = facts(0, 0, vec![(PERM_HASH_MINE, 0)]);
        assert_eq!(decide(&f, TaskType::Mine), Authority::Denied);
    }

    #[test]
    fn nothing_at_all_is_denied() {
        assert_eq!(decide(&facts(0, 0, vec![]), TaskType::Mine), Authority::Denied);
    }

    /// The chain hands back every number as a string. Parsing them as numbers
    /// yields zero, and a zero rank reads as "nothing granted" — so this
    /// mistake fails closed and silently, which is the hardest kind to find.
    #[test]
    fn rank_records_parse_string_numerics() {
        let v = json!({ "guildRankPermissionRecords": [
            { "objectId": "1-61", "guildId": "0-1", "permissions": "2097152", "rank": "4" }
        ]});
        assert_eq!(parse_rank_records(&v), vec![(PERM_HASH_MINE, 4)]);
    }

    /// The shape the live LCD actually serves, copied from
    /// `/structs/guild_rank_permission/object/0-1` on 2026-09-10.
    ///
    /// The wrapper key is SNAKE_case while the fields inside it are camelCase,
    /// which is not a combination anyone would guess — and reading the wrapper
    /// wrong yields an empty list, which this module would then read as "no
    /// guild-rank grant" and refuse legitimate work for a reason nothing logs.
    #[test]
    fn the_live_lcd_response_parses() {
        let v = json!({
            "guild_rank_permission_records": [
                { "objectId": "0-1", "guildId": "0-1", "permissions": "16777216", "rank": "1" }
            ],
            "pagination": { "next_key": null, "total": "1" }
        });
        assert_eq!(parse_rank_records(&v), vec![(16_777_216, 1)]);
    }

    #[test]
    fn rank_records_survive_an_empty_or_odd_response() {
        assert!(parse_rank_records(&json!({})).is_empty());
        assert!(parse_rank_records(&json!({ "guildRankPermissionRecords": [] })).is_empty());
    }

    #[test]
    fn roles_say_what_they_do() {
        assert!(!Role::Off.grinds() && !Role::Off.submits());
        assert!(Role::HelpOnly.grinds() && !Role::HelpOnly.submits());
        assert!(!Role::CollectOnly.grinds() && Role::CollectOnly.submits());
        assert!(Role::Work.grinds() && Role::Work.submits());
    }

    /// The most specific link pays: a named friend over the room, the room
    /// over their guild, their guild over "anyone" — and "anyone" catches
    /// the helper with no link at all, which on the bus is most of them.
    #[test]
    fn the_most_specific_link_pays_and_anyone_catches_the_rest() {
        let mk = |id: &str, scope: Scope| Crew { room_id: id.into(), guild_id: "0-1".into(), scope, ..Default::default() };
        let mut friend = mk("player:1-195", Scope::Chosen);
        friend.chosen = vec!["1-195".into()];
        let room = mk("!night:h", Scope::Room);
        let guild = mk("guild:0-1", Scope::Guild);
        let anyone = mk(HELPERS_CREW, Scope::Anyone);
        let crews = vec![anyone.clone(), guild.clone(), room.clone(), friend.clone()];
        assert_eq!(pick_crew(&crews, "1-195", "!bus:h", Some("0-1")).unwrap().room_id, "player:1-195");
        assert_eq!(pick_crew(&crews, "1-61", "!night:h", Some("0-9")).unwrap().room_id, "!night:h");
        assert_eq!(pick_crew(&crews, "1-61", "!bus:h", Some("0-1")).unwrap().room_id, "guild:0-1");
        assert_eq!(pick_crew(&crews, "1-61", "!bus:h", Some("0-9")).unwrap().room_id, HELPERS_CREW);
        assert_eq!(pick_crew(&crews, "1-61", "!bus:h", None).unwrap().room_id, HELPERS_CREW);
        assert!(pick_crew(&crews[1..], "1-61", "!bus:h", None).is_none(), "no anyone, no link, no bill");
        let h = helpers_crew("0-1");
        assert!(!h.pay.enabled && h.pay.rate_per_difficulty == 0.0 && !h.role.grinds(), "terms only, and off until set");
    }

    #[test]
    fn a_crew_needs_a_room() {
        assert!(upsert(Crew::default()).is_err());
    }

    #[test]
    fn crews_round_trip_and_replace_by_room() {
        let room = "!roundtrip:example.org";
        let mut c = Crew { room_id: room.into(), name: "First".into(), ..Default::default() };
        upsert(c.clone()).unwrap();
        c.name = "Renamed".into();
        c.role = Role::Work;
        upsert(c.clone()).unwrap();
        let stored: Vec<Crew> = all().into_iter().filter(|x| x.room_id == room).collect();
        assert_eq!(stored.len(), 1, "upsert must replace, not append");
        assert_eq!(stored[0].name, "Renamed");
        assert!(remove(room).unwrap());
        assert!(get(room).is_none());
    }

    #[test]
    fn pay_is_off_and_costs_nothing_by_default() {
        let p = Pay::default();
        assert!(!p.enabled);
        assert_eq!(p.rate_per_difficulty, 0.0);
        assert_eq!(p.epoch_cap, 0.0);
        assert_eq!(p.denom, "ualpha");
    }
}
