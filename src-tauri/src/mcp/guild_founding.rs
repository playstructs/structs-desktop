//! Found a guild, as a plan that survives the app closing.
//!
//! The founder answers a handful of questions (name, tag, how many members
//! to be ready for, who may join, where new players sign up, a pitch); the
//! rest is inferred and shown. `preview` turns the answers into the chain's
//! own checks, the founder's power before and after, the cost, and the
//! ordered steps. `run` signs the steps one at a time, recording each result
//! in `guild_founding.<player>.json`, so a crash or a closed window resumes
//! at the step that did not finish — and never founds twice.
//!
//! Two power routes (proposals/guild-founding.md §5.1). PERSONAL — the
//! founder's own capacity powers the guild, built before founding so the
//! founder is never unpowered:
//!   infuse     stake Alpha from the vault so the founder has spare capacity
//!   allocation a dynamic allocation of the sized power from the founder
//!   substation a substation made from it (the guild's entry substation)
//!   found      MsgGuildCreate {reactor, endpoint or "", substation}
//!   policy     join minimum and invite/request levels for the chosen policy
//!   name       MsgGuildUpdateName
//!
//! TREASURY — the guild owns its power, so it outlives the founder going
//! quiet. The guild vault only exists once the guild does, so this route
//! founds first:
//!   found             MsgGuildCreate {reactor, endpoint or "", ""}
//!   policy            as above (the guild is open until this lands)
//!   fund              MsgVaultSend founder → guild vault
//!   guild_stake       MsgReactorInfuse {ownerId: guild} — the guild's capacity
//!   guild_allocation  MsgAllocationCreate automated from the guild, so every
//!                     later guild infusion grows the substation by itself
//!   guild_substation  MsgSubstationCreate {owner: guild}
//!   entry             MsgGuildUpdateEntrySubstationId
//!   connect           MsgSubstationPlayerConnect for the founder — only when
//!                     founding took them off their old guild's entry
//!                     substation (the entry update moves no one)
//!   name              as above
//!
//! Every guild-owned object passes the chain's permission check for the
//! guild's owner (`permissions_context.go`), so the founder signs them all.
//!
//! Chain rules this follows (v0.22.0 `msg_server_guild_create.go`,
//! `guild_charter.go`): 2 Alpha from the player VAULT (1 burned, 1 collateral
//! for one minted guild token); any reactor whose validator exists and is not
//! jailed; a founder who owns a guild is refused; a founder connected to their
//! old guild's entry substation is moved to the new one; the guild starts
//! OPEN (minimum 0) with invites and requests closed until the policy step.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::guild_membership::{draw_of, Draw};
use crate::mcp::loop_util::parse_f64 as num;

/// What founding itself costs, from the vault (1 burned, 1 collateral).
pub const FOUNDING_UALPHA: u64 = 2_000_000;
/// The 75th-percentile power draw of a human player who has built anything:
/// 2.18 kW, measured over 328 such players on 2026-11-13 (replicants and
/// callsign accounts excluded). Sizing for p75 rather than the median keeps
/// a typical recruit online with room to build.
pub const P75_MEMBER_DRAW_MW: f64 = 2_180_000.0;
/// Room on top of p75: a guild sized exactly to today's draw browns out on
/// the first build.
pub const HEADROOM: f64 = 1.5;
/// A substation keeps 90% of what it receives (v0.22 operating loss).
pub const USABLE: f64 = 0.9;
/// "Closed to direct join": the minimum founders set to stop it.
pub const CLOSED_MINIMUM: u64 = u64::MAX;
pub const POLICIES: &[&str] = &["application", "invite", "stake", "open"];
pub const MEMBER_CHOICES: &[u64] = &[5, 10, 25, 50];

// ── Choices and state ──────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Choices {
    pub name: String,
    pub tag: String,
    /// Members to be ready for (the founder counts as one).
    pub members: u64,
    /// application · invite · stake · open
    pub policy: String,
    /// Stake policy: Alpha (ualpha) a joiner must have infused.
    pub stake_ualpha: u64,
    pub pitch: String,
    pub description: String,
    pub logo: String,
    /// none · self
    pub hosting: String,
    /// Self-hosted: where guild.json will be served.
    pub endpoint: String,
    /// Empty = pick the best reactor.
    pub reactor: String,
    /// Who owns the guild's power: personal · treasury. Empty = inferred
    /// ([`pick_route`]). Only read when a new substation is built.
    pub power: String,
    /// The entry substation: "" or "new" = build one (the power route says
    /// whose), "none" = found without one, or an existing substation's id
    /// the founder can connect players to.
    pub substation: String,
    /// Who founds: "" / "you" = the primary; "new" = a founder replicant
    /// made for it, funded from the primary's vault, so the primary keeps
    /// its own guild, rank and substation.
    pub founder: String,
}

impl Choices {
    pub fn with_defaults(mut self) -> Choices {
        if self.members == 0 {
            self.members = 5;
        }
        if self.policy.is_empty() {
            self.policy = "application".into();
        }
        if self.hosting.is_empty() {
            self.hosting = "none".into();
        }
        if self.tag.trim().is_empty() && !self.name.trim().is_empty() {
            self.tag = default_tag(&self.name);
        }
        if self.policy == "stake" && self.stake_ualpha == 0 {
            self.stake_ualpha = stake_for_one_member();
        }
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Step {
    pub id: String,
    pub label: String,
    /// pending · running · done · skipped · failed
    pub status: String,
    pub tx: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FoundState {
    pub founder: String,
    pub choices: Choices,
    /// personal · treasury. Plans saved before the treasury route are "".
    pub route: String,
    pub reactor_id: String,
    /// Alpha staked for power: the founder's (personal) or the guild's
    /// (treasury, also the amount sent to the guild vault).
    pub infuse_ualpha: u64,
    /// Treasury: the guild vault's ualpha just before `fund` signed, so a
    /// resumed run sends only what has not arrived.
    pub fund_base_ualpha: Option<u64>,
    pub allocation_mw: u64,
    pub allocation_id: String,
    pub substation_id: String,
    pub guild_id: String,
    pub steps: Vec<Step>,
    pub started_ms: u64,
    pub updated_ms: u64,
    /// The founder replicant (founder "new"): its HD index (reserved before
    /// signup, so a resumed run adopts the same row), player and address.
    pub founder_index: u32,
    pub founder_player: String,
    pub founder_address: String,
    /// Alpha the primary sends the founder: founding plus any stake.
    pub founder_fund_ualpha: u64,
    /// The founder's vault just before `founder_fund` signed.
    pub founder_fund_base: Option<u64>,
}

impl FoundState {
    pub fn finished(&self) -> bool {
        !self.steps.is_empty() && self.steps.iter().all(|s| s.status == "done" || s.status == "skipped")
    }
    pub fn started(&self) -> bool {
        self.steps.iter().any(|s| s.status != "pending")
    }
    fn step_mut(&mut self, id: &str) -> Option<&mut Step> {
        self.steps.iter_mut().find(|s| s.id == id)
    }
    /// A founder replicant founds, rather than the primary.
    pub fn by_founder(&self) -> bool {
        self.choices.founder == "new"
    }
    /// Who signs the guild's steps: (HD index, player id). The founder
    /// before it exists is (0, "") — only `founder_create` runs then.
    pub fn signer(&self) -> (u32, String) {
        if self.by_founder() {
            (self.founder_index, self.founder_player.clone())
        } else {
            (0, self.founder.clone())
        }
    }
}

// ── Pure rules ─────────────────────────────────────────────────────────────

/// The chain's guild-name rule (`types/ugc.go` ValidateEntityName): 3-20
/// letters, digits, `-`, `_`, `'` or single inner spaces; not an object id.
pub fn name_refusal(name: &str) -> Option<String> {
    use unicode_normalization::UnicodeNormalization;
    let n: String = name.nfc().collect();
    let count = n.chars().count();
    if n.starts_with(' ') || n.ends_with(' ') {
        return Some("a name cannot start or end with a space".into());
    }
    if n.contains("  ") {
        return Some("a name cannot contain two spaces in a row".into());
    }
    let looks_like_id = n.split_once('-').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()));
    if looks_like_id {
        return Some("a name cannot look like an object id".into());
    }
    if !(3..=20).contains(&count) || !n.chars().all(|c| c.is_alphabetic() || c.is_ascii_digit() || "-_' ".contains(c)) {
        return Some("3-20 letters, digits, hyphens, underscores, apostrophes or spaces".into());
    }
    None
}

/// The chain's name-index key: trimmed, lower-cased (`NormalizeName`).
pub fn name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect::<String>().trim().to_lowercase()
}

pub fn tag_refusal(tag: &str) -> Option<String> {
    let t = tag.trim();
    if t.is_empty() || t.chars().count() > 8 || !t.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c)) {
        return Some("a tag is 1-8 letters, digits, '.', '-' or '_'".into());
    }
    None
}

/// Initials of a multi-word name, else its first four letters, upper-cased.
pub fn default_tag(name: &str) -> String {
    let words: Vec<&str> = name.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let t: String = if words.len() >= 2 {
        words.iter().filter_map(|w| w.chars().next()).take(5).collect()
    } else {
        words.first().map(|w| w.chars().take(4).collect()).unwrap_or_default()
    };
    t.to_ascii_uppercase()
}

/// Raw substation capacity (= the allocation's power) that keeps `members`
/// connections at p75 draw with headroom, after the 10% operating loss.
pub fn allocation_for(members: u64, p75_mw: f64) -> u64 {
    ((members.max(1) as f64) * p75_mw * HEADROOM / USABLE).ceil() as u64
}

/// Ualpha to stake so a joiner brings one member's p75 draw with them
/// (Stake policy's suggested minimum), after the reactor's 4% commission.
pub fn stake_for_one_member() -> u64 {
    ((P75_MEMBER_DRAW_MW / 0.96) / 1_000_000.0 * 10.0).ceil() as u64 * 100_000
}

/// Ualpha the founder must infuse so that, while still on their old
/// substation, they can source `alloc_mw` and stay online — and, once moved
/// onto the new substation (alone, so its whole usable share is theirs),
/// still stay online. 1 ualpha = 1 mW, less the reactor's commission.
pub fn infuse_needed(draw: &Draw, old_share: f64, alloc_mw: u64, commission: f64) -> u64 {
    let alloc = alloc_mw as f64;
    let new_share = (alloc * USABLE).floor();
    // Online needs capacity ≥ load + alloc + structsLoad − share, and an
    // allocation needs capacity ≥ load + alloc (its source's spare). The
    // worse of before (old share) and after (new share) decides.
    let short_of = |share: f64| (draw.load + alloc + (draw.structs_load - share).max(0.0)) - draw.capacity;
    let gap = short_of(old_share).max(short_of(new_share)).max(0.0);
    if gap <= 0.0 {
        return 0;
    }
    let keep = (1.0 - commission).clamp(0.5, 1.0);
    // Round up to 0.01 Alpha, plus 1% so a block of drift cannot strand it.
    let need = gap / keep * 1.01;
    ((need / 10_000.0).ceil() as u64) * 10_000
}

/// Ualpha the guild must stake so its capacity covers `alloc_mw` (an
/// automated allocation takes the guild's whole capacity). 1 ualpha = 1 mW
/// less the reactor's commission; rounded up to 0.01 Alpha plus 1%.
pub fn treasury_stake(alloc_mw: u64, commission: f64) -> u64 {
    let keep = (1.0 - commission).clamp(0.5, 1.0);
    let need = alloc_mw as f64 / keep * 1.01;
    ((need / 10_000.0).ceil() as u64) * 10_000
}

/// The power route: the founder's answer, else inferred
/// (guild-founding-experience.md §4.2) — the guild's own above 25 members,
/// the founder's while their spare capacity already covers it, else the
/// guild's (the founder would stake either way, so the stake should outlive
/// them).
pub fn pick_route(asked: &str, members: u64, personal_infuse: u64) -> &'static str {
    match asked {
        "personal" => "personal",
        "treasury" => "treasury",
        _ if members > 25 => "treasury",
        _ if personal_infuse == 0 => "personal",
        _ => "treasury",
    }
}

/// The route for these answers: an existing substation or none at all skip
/// every power step; otherwise the power route decides who builds one.
pub fn route_for(substation: &str, asked_power: &str, members: u64, personal_infuse: u64) -> &'static str {
    match substation.trim() {
        "none" => "none",
        s if s.starts_with("4-") => "existing",
        _ => pick_route(asked_power, members, personal_infuse),
    }
}

/// Key permissions the route signs with (the chain checks the signing key
/// before any object standing).
pub fn route_bits(route: &str) -> u64 {
    use crate::mcp::guild_admin::bits::*;
    let found = PLAY | TOKEN_TRANSFER | GUILD_JOIN_CONSTRAINTS_UPDATE | UPDATE;
    let base = found | TOKEN_INFUSE | SOURCE_ALLOCATION | ALLOCATION_CONNECTION;
    match route {
        "treasury" => base | SUBSTATION_CONNECTION | GUILD_SUBSTATION_UPDATE,
        "existing" => found | SUBSTATION_CONNECTION,
        "none" => found,
        _ => base,
    }
}

/// How the founder may connect players to a substation, in the chain's own
/// order (`permissions_context.go`): owner, a direct grant, or a rank grant
/// in their CURRENT guild — `MsgGuildCreate` checks the entry substation
/// before it moves the founder. "none" means the chain would refuse it.
pub fn substation_access(owner: &str, pid: &str, direct_bits: u64, rank_bits: u64) -> &'static str {
    use crate::mcp::guild_admin::bits::SUBSTATION_CONNECTION;
    if !owner.is_empty() && owner == pid {
        "owner"
    } else if direct_bits & SUBSTATION_CONNECTION != 0 {
        "grant"
    } else if rank_bits & SUBSTATION_CONNECTION != 0 {
        "rank"
    } else {
        "none"
    }
}

/// The id the next guild will get: one past the highest index on chain.
pub fn next_guild_id(guild_ids: &[String]) -> String {
    let top = guild_ids.iter().filter_map(|g| g.strip_prefix("0-").and_then(|n| n.parse::<u64>().ok())).max().unwrap_or(0);
    format!("0-{}", top + 1)
}

/// Which card stage fixes a refusal of the answers alone.
pub fn refusal_fix(text: &str) -> &'static str {
    if text.starts_with("name") || text.starts_with("tag") || text.starts_with("the pitch") || text.starts_with("the guild is founded") {
        "identity"
    } else if text.starts_with("who may join") {
        "joining"
    } else if text.starts_with("self-hosted") {
        "signup"
    } else {
        "substation"
    }
}

/// The guild_admin actions that turn a fresh guild (minimum 0, both levels
/// closed) into `policy`. Settings already at the chain default are left out.
pub fn policy_actions(policy: &str, stake_ualpha: u64) -> Vec<(&'static str, Value)> {
    let min = |v: u64| ("join_minimum", json!({ "amount": v.to_string() }));
    let invite = ("bypass_invite", json!({ "level": "permissioned" }));
    match policy {
        "application" => vec![min(CLOSED_MINIMUM), ("bypass_request", json!({ "level": "permissioned" })), invite],
        "invite" => vec![min(CLOSED_MINIMUM), invite],
        "stake" => vec![min(stake_ualpha.max(1)), invite],
        // Open: anyone direct-joins; invites stay open so the founder can
        // still bring people who are short of nothing but a nudge.
        _ => vec![invite],
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReactorRow {
    pub id: String,
    pub validator: String,
    pub moniker: String,
    pub jailed: bool,
    pub bonded: bool,
    /// The reactor's cut of every infusion (the founder keeps the rest).
    pub commission: f64,
    pub tokens: f64,
    pub guilds: Vec<String>,
    /// The validator's cut of staking rewards (not of power).
    pub validator_fee: f64,
    pub website: String,
    pub owner: String,
    /// Delegations to the validator, i.e. players infused into it.
    pub infusers: u64,
}

/// A substation as the entry-substation picker sees it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SubstationRow {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub deleting: bool,
    pub capacity: f64,
    pub load: f64,
    pub connections: u64,
    /// owner · grant · rank · none (see [`substation_access`]).
    pub access: String,
}

impl SubstationRow {
    /// Power players can share: capacity after the operating loss, less what
    /// the substation allocates out (the chain's connectionCapacity × count).
    pub fn usable(&self) -> f64 {
        (self.capacity * USABLE - self.load).max(0.0)
    }
    /// Each connection's share once `joining` more players connect.
    pub fn each_at(&self, joining: u64) -> f64 {
        self.usable() / (self.connections + joining.max(1)) as f64
    }
}

/// The default reactor: never jailed; bonded first; lowest commission; then
/// the one fewest guilds already prefer (spreads the risk of one validator);
/// then the most stake.
pub fn pick_reactor(rows: &[ReactorRow]) -> Option<String> {
    let mut ok: Vec<&ReactorRow> = rows.iter().filter(|r| !r.jailed && !r.validator.is_empty()).collect();
    ok.sort_by(|a, b| {
        b.bonded
            .cmp(&a.bonded)
            .then(a.commission.partial_cmp(&b.commission).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.guilds.len().cmp(&b.guilds.len()))
            .then(b.tokens.partial_cmp(&a.tokens).unwrap_or(std::cmp::Ordering::Equal))
    });
    ok.first().map(|r| r.id.clone())
}

/// The ordered steps for these answers. Personal: the infuse step is present
/// only when the founder is short of capacity. Treasury: `connect` only when
/// founding leaves the founder with no substation.
pub fn steps_for(route: &str, infuse_ualpha: u64, connect: bool) -> Vec<Step> {
    let s = |id: &str, label: &str| Step { id: id.into(), label: label.into(), status: "pending".into(), ..Default::default() };
    let mut out = Vec::new();
    // An existing substation (or none): founding names it, nothing to build.
    if route == "existing" || route == "none" {
        out.push(s("found", "Found the guild"));
        out.push(s("policy", "Set who may join"));
        out.push(s("name", "Name the guild"));
        return out;
    }
    if route == "treasury" {
        out.push(s("found", "Found the guild"));
        out.push(s("policy", "Set who may join"));
        out.push(s("fund", "Fund the guild vault"));
        out.push(s("guild_stake", "Stake the guild's Alpha"));
        out.push(s("guild_allocation", "Route the guild's power"));
        out.push(s("guild_substation", "Build the guild substation"));
        out.push(s("entry", "Make it the entry substation"));
        if connect {
            out.push(s("connect", "Connect you to it"));
        }
        out.push(s("name", "Name the guild"));
        return out;
    }
    if infuse_ualpha > 0 {
        out.push(s("infuse", "Stake Alpha for power"));
    }
    out.push(s("allocation", "Route power"));
    out.push(s("substation", "Build the entry substation"));
    out.push(s("found", "Found the guild"));
    out.push(s("policy", "Set who may join"));
    out.push(s("name", "Name the guild"));
    out
}

/// The steps with who founds folded in. A founder replicant is created and
/// funded first (and granted the primary's substation when it is the
/// entry), founds and signs everything after, and finally hands the primary
/// the guild's controls, so the primary never moves.
pub fn plan_steps(route: &str, infuse_ualpha: u64, connect: bool, by_founder: bool, grant: bool) -> Vec<Step> {
    let steps = steps_for(route, infuse_ualpha, connect);
    if !by_founder {
        return steps;
    }
    let s = |id: &str, label: &str| Step { id: id.into(), label: label.into(), status: "pending".into(), ..Default::default() };
    let mut out = vec![s("founder_create", "Create the founder"), s("founder_fund", "Fund the founder")];
    if grant {
        out.push(s("founder_grant", "Let the founder use your substation"));
    }
    out.extend(steps);
    out.push(s("controls", "Give you the guild's controls"));
    out
}

/// What a founder replicant draws before it has built anything: the chain's
/// passive draw per player (`PlayerPassiveDraw`, 25 W), no capacity of its own.
pub fn new_founder_draw() -> Draw {
    Draw { load: 0.0, structs_load: 25_000.0, capacity: 0.0, substation: String::new() }
}

/// guild.json v1 (proposals/guild-json-v1.schema.json) from the answers.
/// `services` is the self-hoster's own stack; the id is written in once the
/// guild exists.
pub fn render_guild_json(guild_id: &str, c: &Choices, services: &Value) -> Value {
    let mut g = json!({
        "schema_version": 1,
        "id": guild_id,
        "name": c.name.trim(),
        "tag": c.tag.trim(),
        "services": services,
    });
    let put = |g: &mut Value, k: &str, v: &str| {
        if !v.trim().is_empty() {
            g[k] = json!(v.trim());
        }
    };
    put(&mut g, "description", &c.description);
    put(&mut g, "logo", &c.logo);
    let base = c.tag.trim().to_ascii_lowercase();
    if !base.is_empty() {
        g["denom"] = json!({ "0": format!("u{base}"), "6": base });
    }
    let status = match c.policy.as_str() {
        "open" | "stake" => "open",
        "application" => "selective",
        _ => "closed",
    };
    let mut rec = json!({ "status": status });
    if !c.pitch.trim().is_empty() {
        rec["pitch"] = json!(c.pitch.trim().chars().take(140).collect::<String>());
    }
    g["recruiting"] = rec;
    json!({ "guild": g })
}

/// Pure refusals on the answers alone.
pub fn choice_refusals(c: &Choices) -> Vec<String> {
    let mut out = Vec::new();
    if c.name.trim().is_empty() {
        out.push("name the guild".into());
    } else if let Some(why) = name_refusal(&c.name) {
        out.push(format!("name: {why}"));
    }
    if let Some(why) = tag_refusal(&c.tag) {
        out.push(format!("tag: {why}"));
    }
    if !POLICIES.contains(&c.policy.as_str()) {
        out.push(format!("who may join is one of {}", POLICIES.join(", ")));
    }
    if c.members == 0 || c.members > 500 {
        out.push("be ready for 1 to 500 members".into());
    }
    if c.hosting == "self" {
        let e = c.endpoint.trim();
        if !(e.starts_with("https://") && e.len() > 12 && !e.contains(char::is_whitespace)) {
            out.push("self-hosted: give the https URL your guild.json will be served from".into());
        }
    }
    if c.pitch.chars().count() > 140 {
        out.push("the pitch is at most 140 characters".into());
    }
    if !matches!(c.founder.as_str(), "" | "you" | "new") {
        out.push("the guild is founded by you or a new founder".into());
    }
    if !matches!(c.power.as_str(), "" | "personal" | "treasury") {
        out.push("power is owned by you (personal) or the guild (treasury)".into());
    }
    out
}

// ── Persistence ────────────────────────────────────────────────────────────

fn file_for(player: &str) -> String {
    format!("guild_founding.{player}.json")
}

pub fn load(player: &str) -> Option<FoundState> {
    let path = crate::mcp::config_store::config_path(&file_for(player))?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save(state: &FoundState) -> Result<(), String> {
    let path = crate::mcp::config_store::config_path(&file_for(&state.founder)).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    crate::hasher::types::now_millis() as u64
}

// ── Reads ──────────────────────────────────────────────────────────────────

fn identity() -> Result<(String, String), String> {
    let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
    let pid = gs.player_id.clone().unwrap_or_default();
    let addr = gs.wallet_address.clone().unwrap_or_default();
    if pid.is_empty() || addr.is_empty() {
        return Err("the game has not signed in yet".into());
    }
    Ok((pid, addr))
}

fn s(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// The preview runs on every keystroke (debounced); reactors and substations
/// change over minutes, so their reads are kept briefly.
const READ_TTL: std::time::Duration = std::time::Duration::from_secs(90);
type Kept<T> = std::sync::Mutex<Option<(std::time::Instant, String, Vec<T>)>>;
static REACTORS: Kept<ReactorRow> = std::sync::Mutex::new(None);
static SUBSTATIONS: Kept<SubstationRow> = std::sync::Mutex::new(None);

fn kept<T: Clone>(slot: &Kept<T>, key: &str) -> Option<Vec<T>> {
    let g = slot.lock().ok()?;
    g.as_ref().filter(|(t, k, _)| t.elapsed() < READ_TTL && k == key).map(|(_, _, rows)| rows.clone())
}

fn keep<T>(slot: &Kept<T>, key: &str, rows: Vec<T>) {
    if let Ok(mut g) = slot.lock() {
        *g = Some((std::time::Instant::now(), key.to_string(), rows));
    }
}

/// Every reactor with its validator's state and which guilds prefer it.
pub async fn reactors(client: &CosmosClient) -> Vec<ReactorRow> {
    if let Some(rows) = kept(&REACTORS, "") {
        return rows;
    }
    let rows = client.list_all_entities("reactor", "Reactor").await.unwrap_or_default();
    let guilds = client.list_all_entities("guild", "Guild").await.unwrap_or_default();
    let vals = client
        .lcd_get("/cosmos/staking/v1beta1/validators?pagination.limit=500")
        .await
        .ok()
        .and_then(|v| v.get("validators").and_then(|a| a.as_array()).cloned())
        .unwrap_or_default();
    let mut out: Vec<ReactorRow> = rows
        .iter()
        .map(|r| {
            let id = s(r.get("id"));
            let validator = s(r.get("validator"));
            let v = vals.iter().find(|v| s(v.get("operator_address")) == validator);
            ReactorRow {
                guilds: guilds.iter().filter(|g| s(g.get("primaryReactorId")) == id).map(|g| s(g.get("id"))).collect(),
                id,
                moniker: v.map(|v| s(v.pointer("/description/moniker"))).unwrap_or_default(),
                jailed: v.map(|v| v.get("jailed").and_then(|j| j.as_bool()).unwrap_or(false)).unwrap_or(true),
                bonded: v.map(|v| s(v.get("status")) == "BOND_STATUS_BONDED").unwrap_or(false),
                commission: num(r.get("defaultCommission")),
                tokens: v.map(|v| num(v.get("tokens"))).unwrap_or(0.0),
                validator_fee: v.map(|v| num(v.pointer("/commission/commission_rates/rate"))).unwrap_or(0.0),
                website: v.map(|v| s(v.pointer("/description/website"))).unwrap_or_default(),
                owner: s(r.get("owner")),
                infusers: 0,
                validator,
            }
        })
        .collect();
    // One count per live validator; a jailed one cannot be picked anyway.
    let counts = futures_util::future::join_all(out.iter().map(|r| async move {
        if r.jailed || r.validator.is_empty() {
            return 0;
        }
        client
            .lcd_get(&format!("/cosmos/staking/v1beta1/validators/{}/delegations?pagination.limit=1&pagination.count_total=true", r.validator))
            .await
            .ok()
            .map(|v| num(v.pointer("/pagination/total")) as u64)
            .unwrap_or(0)
    }))
    .await;
    for (r, n) in out.iter_mut().zip(counts) {
        r.infusers = n;
    }
    if !out.is_empty() {
        keep(&REACTORS, "", out.clone());
    }
    out
}

/// Reactors as the picker lists them: live ones by stake (rank 1 = most),
/// each with its share of all bonded stake; jailed ones last, unranked.
pub fn reactor_list(rows: &[ReactorRow]) -> Vec<Value> {
    let bonded: f64 = rows.iter().filter(|r| r.bonded && !r.jailed).map(|r| r.tokens).sum();
    let mut sorted: Vec<&ReactorRow> = rows.iter().collect();
    sorted.sort_by(|a, b| a.jailed.cmp(&b.jailed).then(b.tokens.partial_cmp(&a.tokens).unwrap_or(std::cmp::Ordering::Equal)).then(a.id.cmp(&b.id)));
    let mut rank = 0;
    sorted
        .into_iter()
        .map(|r| {
            let ranked = r.bonded && !r.jailed;
            if ranked {
                rank += 1;
            }
            let mut v = reactor_json(r);
            v["rank"] = json!(if ranked { rank } else { 0 });
            v["share"] = json!(if ranked && bonded > 0.0 { r.tokens / bonded } else { 0.0 });
            v
        })
        .collect()
}

fn reactor_json(r: &ReactorRow) -> Value {
    json!({
        "id": r.id, "moniker": r.moniker, "jailed": r.jailed, "bonded": r.bonded,
        "commission": r.commission, "tokens": r.tokens.to_string(), "guilds": r.guilds,
        "validator_fee": r.validator_fee, "website": r.website, "owner": r.owner, "infusers": r.infusers,
    })
}

/// Every substation, with whether `pid` (in `guild` at `rank`) may make it
/// an entry substation. Ones they can use first, then by connections.
pub async fn substations(client: &CosmosClient, pid: &str, guild: &str, rank: u64) -> Vec<SubstationRow> {
    let key = format!("{pid}|{guild}|{rank}");
    if let Some(rows) = kept(&SUBSTATIONS, &key) {
        return rows;
    }
    use futures_util::stream::{self, StreamExt};
    let list = client.list_all_entities("substation", "Substation").await.unwrap_or_default();
    let mut out: Vec<SubstationRow> = stream::iter(list)
        .map(|v| async move {
            let id = s(v.get("id"));
            let owner = s(v.get("owner"));
            let grid = client.query_entity("substation", &id).await.ok().and_then(|e| e.get("gridAttributes").cloned()).unwrap_or(Value::Null);
            let (direct, ranked) = if owner == pid {
                (0, 0)
            } else {
                let direct = client
                    .lcd_get(&format!("/structs/permission/{id}%40{pid}"))
                    .await
                    .ok()
                    .map(|p| num(p.pointer("/permissionRecord/value")) as u64)
                    .unwrap_or(0);
                let ranked = if guild.is_empty() {
                    0
                } else {
                    client
                        .lcd_get(&format!("/structs/guild_rank_permission/object/{id}/guild/{guild}"))
                        .await
                        .ok()
                        .and_then(|v| v.get("guild_rank_permission_records").and_then(|a| a.as_array()).cloned())
                        .map(|rows| crate::mcp::guild_admin::rank_bits(&crate::mcp::guild_admin::parse_rank_grants(&rows, guild), rank))
                        .unwrap_or(0)
                };
                (direct, ranked)
            };
            SubstationRow {
                access: substation_access(&owner, pid, direct, ranked).into(),
                name: s(v.get("name")),
                deleting: v.get("deletion_pending").and_then(|d| d.as_bool()).unwrap_or(false),
                capacity: num(grid.get("capacity")),
                load: num(grid.get("load")),
                connections: num(grid.get("connectionCount")) as u64,
                owner,
                id,
            }
        })
        .buffer_unordered(6)
        .collect()
        .await;
    out.sort_by(|a, b| (a.access == "none").cmp(&(b.access == "none")).then(b.connections.cmp(&a.connections)).then(a.id.cmp(&b.id)));
    if !out.is_empty() {
        keep(&SUBSTATIONS, &key, out.clone());
    }
    out
}

fn substation_json(r: &SubstationRow, members: u64, here: &str) -> Value {
    json!({
        "id": r.id, "owner": r.owner, "name": r.name, "deleting": r.deleting, "access": r.access,
        "capacity_mw": r.capacity, "load_mw": r.load, "connections": r.connections,
        "share_now_mw": if r.connections > 0 { r.usable() / r.connections as f64 } else { r.usable() },
        "each_mw": r.each_at(members), "here": r.id == here,
        // A founder can be handed only what the primary owns.
        "founder_ok": r.access == "owner" && !r.deleting,
    })
}

/// Problems the card names: `block` stops Found, `warn` does not. `fix` is
/// the card stage (or door) that answers it.
#[derive(Default)]
struct Issues(Vec<Value>);

impl Issues {
    fn block(&mut self, text: impl Into<String>, fix: &str) {
        self.0.push(json!({ "level": "block", "text": text.into(), "fix": fix }));
    }
    fn warn(&mut self, text: impl Into<String>, fix: &str) {
        self.0.push(json!({ "level": "warn", "text": text.into(), "fix": fix }));
    }
    fn texts(&self, level: &str) -> Vec<String> {
        self.0.iter().filter(|i| i["level"] == level).filter_map(|i| i["text"].as_str().map(String::from)).collect()
    }
}

/// Everything the card shows before Found: checks, the founder's move, the
/// power plan, costs, steps, and the guild.json a self-hoster will publish.
pub async fn preview(choices: Choices) -> Result<Value, String> {
    let c = choices.with_defaults();
    let (pid, address) = identity()?;
    let client = CosmosClient::new();
    let alpha = |u: f64| crate::mcp::tools::format::format_alpha(u);
    let watts = |mw: f64| crate::mcp::tools::format::format_power(mw);
    // A founder replicant founds: the primary only pays (and, for its own
    // substation, grants), so its guild, rank and power are untouched.
    let by_founder = c.founder == "new";
    let mut issues = Issues::default();
    for why in choice_refusals(&c) {
        let fix = refusal_fix(&why);
        issues.block(why, fix);
    }

    // The founder.
    let player = client.query_entity("player", &pid).await?;
    let p = player.get("Player").cloned().unwrap_or(Value::Null);
    let own_guild = s(p.get("guildId"));
    let rank = num(p.get("guildRank")) as u64;
    let guilds = client.list_all_entities("guild", "Guild").await.unwrap_or_default();
    let owned = guilds.iter().find(|g| s(g.get("owner")) == pid).map(|g| s(g.get("id")));
    // A founding already under way owns its guild — that is not a refusal.
    let resuming = load(&pid).filter(|st| !st.guild_id.is_empty() && !st.finished());
    if let (Some(g), None, false) = (&owned, &resuming, by_founder) {
        issues.block(format!("you own {g}; an owner cannot found another guild, but a founder can"), "identity");
    }
    if !c.name.trim().is_empty() {
        let key = name_key(&c.name);
        if let Some(g) = guilds.iter().find(|g| name_key(&s(g.get("name"))) == key && !s(g.get("name")).is_empty()) {
            issues.block(format!("the name '{}' is taken by {}", c.name.trim(), s(g.get("id"))), "identity");
        }
    }
    let vault = crate::mcp::guild_economy::vault_balance(&client, &pid, "ualpha").await.unwrap_or(0) as u64;
    let next_id = next_guild_id(&guilds.iter().map(|g| s(g.get("id"))).collect::<Vec<_>>());

    // Reactor.
    let rows = reactors(&client).await;
    let reactor_id = if c.reactor.trim().is_empty() { pick_reactor(&rows).unwrap_or_default() } else { c.reactor.trim().to_string() };
    let listed = reactor_list(&rows);
    let chosen = rows.iter().find(|r| r.id == reactor_id).cloned();
    match &chosen {
        None => issues.block(if reactor_id.is_empty() { "no reactor can take a guild right now".to_string() } else { format!("no reactor {reactor_id} on chain") }, "reactor"),
        Some(r) if r.jailed => issues.block(format!("the validator of {} is jailed", r.id), "reactor"),
        Some(r) if !r.bonded => issues.warn(format!("the validator of {} is not bonded", r.id), "reactor"),
        _ => {}
    }
    let commission = chosen.as_ref().map(|r| r.commission).filter(|c| *c > 0.0).unwrap_or(0.04);

    // Entry substation. The founder's numbers are a fresh player's.
    let (my_draw, my_share) = draw_of(&client, &pid).await;
    let (draw, old_share) = if by_founder { (new_founder_draw(), 0.0) } else { (my_draw.clone(), my_share) };
    let subs = substations(&client, &pid, &own_guild, rank).await;
    let sub_choice = c.substation.trim().to_string();
    let picked_sub = if sub_choice.starts_with("4-") { subs.iter().find(|r| r.id == sub_choice).cloned() } else { None };
    if sub_choice.starts_with("4-") {
        match &picked_sub {
            None => issues.block(format!("no substation {sub_choice} on chain"), "substation"),
            // The founder gets its connect grant from the primary, which can
            // only pass on a substation it owns.
            Some(r) if by_founder && r.access != "owner" => issues.block(format!("{}: a founder can only be handed a substation you own", r.id), "substation"),
            Some(r) if r.access == "none" => issues.block(format!("{}: you hold no substation_connection grant", r.id), "substation"),
            Some(r) if r.deleting => issues.block(format!("{} is being deleted", r.id), "substation"),
            Some(r) if r.capacity <= 0.0 => issues.warn(format!("{} has no power in; joiners connect to nothing", r.id), "substation"),
            Some(r) if r.each_at(c.members) < P75_MEMBER_DRAW_MW => issues.warn(
                format!("{}: {} each at {} members, under the {} a member draws", r.id, watts(r.each_at(c.members)), c.members, watts(P75_MEMBER_DRAW_MW)),
                "substation",
            ),
            _ => {}
        }
    } else if sub_choice == "none" {
        issues.warn("no entry substation: joiners get no connection until you set one", "substation");
    }

    // Power: size a new substation, then what each route stakes for it.
    let alloc = allocation_for(c.members, P75_MEMBER_DRAW_MW);
    let personal_infuse = infuse_needed(&draw, old_share, alloc, commission);
    let guild_stake = treasury_stake(alloc, commission);
    let route = route_for(&sub_choice, &c.power, c.members, personal_infuse);
    let treasury = route == "treasury";
    let building = route == "personal" || treasury;
    let infuse = match route {
        "treasury" => guild_stake,
        "personal" => personal_infuse,
        _ => 0,
    };
    // The founder hands over a substation the primary owns (grant step).
    let grant = by_founder && picked_sub.as_ref().is_some_and(|r| r.access == "owner");
    // A founder replicant's own key holds everything; the primary's key
    // only funds it (and grants it a substation).
    let key_bits = if by_founder {
        use crate::mcp::guild_admin::bits::*;
        PLAY | TOKEN_TRANSFER | if grant { ADMIN } else { 0 }
    } else {
        route_bits(route)
    };
    if let Some(why) = crate::mcp::send_guard::signer_lacks(&address, key_bits, "the founding steps").await {
        issues.block(why, "key");
    }
    let (share_alone, share_full) = match &picked_sub {
        Some(r) => (r.each_at(1), r.each_at(c.members)),
        None if building => {
            let alone = (alloc as f64 * USABLE).floor();
            (alone, alone / c.members.max(1) as f64)
        }
        None => (0.0, 0.0),
    };
    // Does founding move them? Only off their old guild's entry substation.
    let old_entry = if own_guild.starts_with("0-") {
        guilds.iter().find(|g| s(g.get("id")) == own_guild).map(|g| s(g.get("entrySubstationId"))).unwrap_or_default()
    } else {
        String::new()
    };
    // A founder signs up into the primary's guild, on its entry substation,
    // so founding always moves it.
    let moves = by_founder || draw.substation.is_empty() || draw.substation == old_entry;
    let share_after = if moves { share_alone } else { old_share };
    let substation_after = if !moves {
        draw.substation.clone()
    } else if building {
        "new".to_string()
    } else {
        picked_sub.as_ref().map(|r| r.id.clone()).unwrap_or_default()
    };
    // Personal: the founder's capacity gains the stake and sources the
    // allocation. Otherwise it is untouched.
    let cap_after = if route == "personal" { draw.capacity + infuse as f64 * (1.0 - commission) - alloc as f64 } else { draw.capacity };
    let online_after = draw.load + draw.structs_load <= cap_after.max(0.0) + share_after;
    if !online_after && by_founder {
        issues.warn(format!("the founder has no power after founding ({} in); it builds nothing, so it needs none", watts(cap_after.max(0.0) + share_after)), "substation");
    } else if !online_after {
        issues.block(
            format!("you would go offline: you draw {}, {} comes in", watts(draw.load + draw.structs_load), watts(cap_after.max(0.0) + share_after)),
            "substation",
        );
    }
    let steps = plan_steps(route, infuse, treasury && moves, by_founder, grant);
    // Treasury founds before the guild has power: a founder moved off their
    // old entry substation has none until `connect`.
    let unpowered_steps = if treasury && moves {
        let at = |id: &str| steps.iter().position(|s| s.id == id).unwrap_or(0);
        at("connect").saturating_sub(at("found"))
    } else {
        0
    };
    if unpowered_steps > 0 && !by_founder && draw.load + draw.structs_load > draw.capacity {
        issues.warn(format!("you are offline for {unpowered_steps} steps after founding, until the guild substation connects you"), "substation");
    }
    let total = FOUNDING_UALPHA + infuse;
    if vault < total {
        issues.block(format!("your vault holds {}; founding needs {}", alpha(vault as f64), alpha(total as f64)), "vault");
    }
    if c.policy == "open" {
        issues.warn("anyone can join at once; every join shares the power", "joining");
    } else {
        issues.warn("anyone can join until the join policy lands, a block after founding", "joining");
    }
    if c.hosting != "self" {
        issues.warn("no sign-up site: new players can only join from a client that already plays", "signup");
    }

    let problems = issues.texts("block");
    let warnings = issues.texts("warn");
    let replicants = if by_founder { 0 } else { crate::mcp::virtual_players::count() };
    let founder_index = crate::mcp::virtual_players::REGISTRY.read().map(|r| r.next_free_index()).unwrap_or(0);
    let doc = render_guild_json("0-?", &c, &json!({ "guild_api": "", "grass_nats_websocket": "" }));
    // Founding mints 1 guild token into the guild vault, backed by the 1
    // Alpha of collateral (`guild_creation_payment.go`); the guild has no
    // capacity until something is staked for it.
    let guild_capacity = if treasury { (guild_stake as f64 * (1.0 - commission)).floor() } else { 0.0 };
    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "warnings": warnings,
        "issues": issues.0,
        "choices": c,
        "founder": {
            "player_id": pid, "guild_id": own_guild, "rank": rank, "owns": owned,
            "vault_ualpha": vault.to_string(), "replicants_stay": replicants,
            "draw_mw": draw.need(), "capacity_mw": draw.capacity, "spare_mw": (draw.capacity - draw.load).max(0.0),
            "substation_now": draw.substation, "share_now_mw": old_share,
            "moves": moves, "substation_after": substation_after, "share_after_mw": share_after, "online_after": online_after,
            "unpowered_steps": unpowered_steps,
            "by_founder": by_founder,
            // The primary itself, which a founder leaves exactly where it is.
            "primary": {
                "guild_id": own_guild, "rank": rank, "substation": my_draw.substation,
                "share_mw": my_share, "draw_mw": my_draw.need(),
            },
            "founder_new": if by_founder {
                json!({ "index": founder_index, "name": crate::mcp::callsign::name_for(founder_index), "fund_ualpha": total.to_string(), "grant_substation": if grant { sub_choice.as_str() } else { "" } })
            } else { Value::Null },
        },
        "reactor": listed.iter().find(|r| r["id"] == reactor_id.as_str()).cloned(),
        "reactors": listed,
        "substation": {
            "choice": if sub_choice.is_empty() { "new" } else { sub_choice.as_str() },
            "picked": picked_sub.as_ref().map(|r| substation_json(r, c.members, &draw.substation)),
            "options": subs.iter().map(|r| substation_json(r, c.members, &draw.substation)).collect::<Vec<_>>(),
        },
        "power": {
            "members": c.members, "member_choices": MEMBER_CHOICES, "p75_draw_mw": P75_MEMBER_DRAW_MW, "headroom": HEADROOM,
            "allocation_mw": if building { alloc } else { 0 }, "share_alone_mw": share_alone, "share_full_mw": share_full,
            "infuse_ualpha": infuse.to_string(),
            "route": route, "route_auto": c.power.is_empty(),
            "routes": {
                "personal": { "stake_ualpha": personal_infuse.to_string(), "allocation_mw": alloc, "each_mw": (alloc as f64 * USABLE).floor() / c.members.max(1) as f64 },
                "treasury": { "stake_ualpha": guild_stake.to_string(), "allocation_mw": alloc, "each_mw": (alloc as f64 * USABLE).floor() / c.members.max(1) as f64 },
            },
        },
        "cost": {
            "founding_ualpha": FOUNDING_UALPHA.to_string(),
            "burned_ualpha": "1000000",
            "collateral_ualpha": "1000000",
            "infuse_ualpha": infuse.to_string(),
            "total_ualpha": total.to_string(),
        },
        "treasury": {
            "guild_id": next_id,
            "denom": format!("uguild.{next_id}"),
            "vault_tokens": "1000000",
            "collateral_ualpha": "1000000",
            "convert_in_fee": "0", "convert_out_fee": "0",
            "capacity_mw": guild_capacity,
            "join_minimum": 0, "entry_rank": 101,
        },
        "policy": { "actions": policy_actions(&c.policy, c.stake_ualpha).iter().map(|(a, v)| json!({ "action": a, "args": v })).collect::<Vec<_>>() },
        "steps": steps,
        "guild_json": doc,
        "resuming": resuming.as_ref().map(|r| r.guild_id.clone()),
    }))
}

/// The saved plan, if any, plus whether a run is in flight.
pub fn get() -> Result<Value, String> {
    let (pid, _) = identity()?;
    Ok(json!({ "state": load(&pid), "running": RUNNING.load(Ordering::SeqCst) }))
}

/// Forget an unstarted or finished plan. A plan mid-way cannot be dropped:
/// the chain already holds what it made, and resuming is the safe path.
pub fn abandon() -> Result<Value, String> {
    let (pid, _) = identity()?;
    if let Some(st) = load(&pid) {
        if st.started() && !st.finished() && !st.guild_id.is_empty() {
            return Err(format!("{} is founded; finish its setup rather than abandon it", st.guild_id));
        }
    }
    if let Some(path) = crate::mcp::config_store::config_path(&file_for(&pid)) {
        let _ = std::fs::remove_file(path);
    }
    Ok(json!({ "ok": true }))
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Start (or resume) founding. Answers at once with the saved plan; the steps
/// run in the background and every change is pushed as `guild-founding`.
pub async fn start(app: tauri::AppHandle, choices: Option<Choices>) -> Result<Value, String> {
    let (pid, _) = identity()?;
    let existing = load(&pid).filter(|st| st.started() && !st.finished());
    let state = match (existing, choices) {
        // Mid-way: resume exactly what was planned; new answers do not apply.
        (Some(st), _) => st,
        (None, Some(c)) => {
            let pv = preview(c).await?;
            if pv["ok"] != true {
                let why: Vec<String> = pv["problems"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                return Err(format!("refused: {}", why.join("; ")));
            }
            let c: Choices = serde_json::from_value(pv["choices"].clone()).map_err(|e| e.to_string())?;
            let infuse = pv["power"]["infuse_ualpha"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
            let route = pv["power"]["route"].as_str().unwrap_or("personal").to_string();
            let connect = route == "treasury" && pv["founder"]["moves"] == true;
            let by_founder = c.founder == "new";
            let grant = pv["founder"]["founder_new"]["grant_substation"].as_str().is_some_and(|g| !g.is_empty());
            let total: u64 = pv["cost"]["total_ualpha"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
            // An existing substation is named by founding itself; the build
            // routes fill this in as they make one, and "none" leaves it empty.
            let substation_id = if route == "existing" { c.substation.trim().to_string() } else { String::new() };
            let st = FoundState {
                founder: pid.clone(),
                substation_id,
                reactor_id: pv["reactor"]["id"].as_str().unwrap_or("").to_string(),
                infuse_ualpha: infuse,
                allocation_mw: pv["power"]["allocation_mw"].as_u64().unwrap_or(0),
                steps: plan_steps(&route, infuse, connect, by_founder, grant),
                founder_fund_ualpha: if by_founder { total } else { 0 },
                route,
                choices: c,
                started_ms: now_ms(),
                updated_ms: now_ms(),
                ..Default::default()
            };
            save(&st)?;
            st
        }
        (None, None) => return Err("nothing to resume: answer the questions first".into()),
    };
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "state": state, "running": true }));
    }
    let snapshot = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut st = state;
        if let Err(e) = run_steps(&app, &mut st).await {
            crate::mcp::board_feed::push(&app, crate::mcp::board_feed::Severity::Important, "guild", format!("founding paused: {e}"));
        }
        RUNNING.store(false, Ordering::SeqCst);
        emit(&app, &st);
    });
    Ok(json!({ "state": snapshot, "running": true }))
}

fn emit(app: &tauri::AppHandle, st: &FoundState) {
    let _ = crate::mcp::events::emit(
        app,
        crate::mcp::events::AppEvent::Board { name: "guild-founding", payload: json!({ "state": st, "running": RUNNING.load(Ordering::SeqCst) }) },
    );
}

fn mark(app: &tauri::AppHandle, st: &mut FoundState, id: &str, status: &str, tx: &str, error: &str) {
    if let Some(step) = st.step_mut(id) {
        step.status = status.into();
        if !tx.is_empty() {
            step.tx = tx.into();
        }
        step.error = error.into();
    }
    st.updated_ms = now_ms();
    let _ = save(st);
    emit(app, st);
}

fn tx_of(v: &Value) -> String {
    s(v.get("transactionHash")).chars().take(16).collect()
}

/// The guild `pid` owns, if any (a founder owns at most one).
async fn owned_guild(client: &CosmosClient, pid: &str) -> Option<String> {
    client.list_all_entities("guild", "Guild").await.ok().and_then(|gs| gs.iter().find(|g| s(g.get("owner")) == pid).map(|g| s(g.get("id"))))
}

async fn run_steps(app: &tauri::AppHandle, st: &mut FoundState) -> Result<(), String> {
    let client = CosmosClient::new();
    let (_, address) = identity()?;
    let ids: Vec<(String, String)> = st.steps.iter().filter(|s| s.status != "done" && s.status != "skipped").map(|s| (s.id.clone(), s.status.clone())).collect();
    for (id, before) in ids {
        // A step that was already running or failed may have signed before
        // the app lost it: that run adopts what the chain shows it made.
        let resumed = before == "running" || before == "failed";
        mark(app, st, &id, "running", "", "");
        match run_one(app, &client, &address, st, &id, resumed).await {
            Ok(tx) => mark(app, st, &id, "done", &tx, ""),
            Err(e) => {
                mark(app, st, &id, "failed", "", &e);
                return Err(e);
            }
        }
    }
    crate::mcp::board_feed::push(
        app,
        crate::mcp::board_feed::Severity::Notice,
        "guild",
        format!("founded {} · {}", st.guild_id, st.choices.name.trim()),
    );
    Ok(())
}

/// One step. Returns the (short) tx hash it signed, or "" when nothing
/// needed signing.
async fn run_one(app: &tauri::AppHandle, client: &CosmosClient, address: &str, st: &mut FoundState, id: &str, resumed: bool) -> Result<String, String> {
    // The primary pays and (for the founder steps) grants; whoever founds
    // signs every guild step.
    let primary = st.founder.clone();
    if id.starts_with("founder_") {
        return run_founder_step(app, client, st, id).await;
    }
    if st.by_founder() && st.founder_player.is_empty() {
        return Err("the founder does not exist yet; resume to create it".into());
    }
    let (idx, pid) = st.signer();
    let signer_address = if st.by_founder() { st.founder_address.clone() } else { address.to_string() };
    match id {
        "controls" => {
            // The founder owns the guild; this gives the primary every guild
            // permission so the guild cards work from the primary as before.
            let guild = st.guild_id.clone();
            let held = grant_on(client, &guild, &primary).await;
            if held & crate::mcp::delegation::PERM_ALL == crate::mcp::delegation::PERM_ALL {
                return Ok(String::new());
            }
            let r = sign(
                app,
                idx,
                "/structs.structs.MsgPermissionGrantOnObject",
                json!({ "objectId": guild, "playerId": primary, "permissions": crate::mcp::delegation::PERM_ALL }),
                "guild:found:controls",
            )
            .await?;
            Ok(tx_of(&r))
        }
        "infuse" => {
            // Capacity may already be there (a resumed plan, or staked since).
            let (draw, old) = draw_of(client, &pid).await;
            if infuse_needed(&draw, old, st.allocation_mw, 0.04) == 0 {
                return Ok(String::new());
            }
            let r = crate::mcp::tools::infusions::mcp_infusion_infuse_impl(app.clone(), signer_address.clone(), st.reactor_id.clone(), st.infuse_ualpha as f64).await?;
            // The capacity lands a block later; wait for it.
            let need = st.allocation_mw as f64;
            let probe = || {
                let pid = pid.clone();
                async move {
                    let (d, _) = draw_of(client, &pid).await;
                    (d.capacity - d.load >= need).then(|| json!(true))
                }
            };
            crate::mcp::energy_card::wait_for(probe).await;
            Ok(r.get("tx").map(tx_of).unwrap_or_default())
        }
        "allocation" => {
            if resumed {
                if let Some(a) = crate::mcp::energy_card::newest_unconnected(client, &pid).await {
                    st.allocation_id = a;
                    return Ok(String::new());
                }
            }
            if idx == 0 {
                crate::mcp::tools::board_pages::mcp_allocation_create_impl(app.clone(), pid.clone(), "dynamic".into(), st.allocation_mw as f64).await?;
            } else {
                // The founder's own capacity: the same message the board signs.
                sign(
                    app,
                    idx,
                    "/structs.structs.MsgAllocationCreate",
                    json!({ "controller": pid, "sourceObjectId": pid, "allocationType": "dynamic", "power": st.allocation_mw }),
                    "guild:found:allocation",
                )
                .await?;
            }
            let probe = || {
                let pid = pid.clone();
                async move { crate::mcp::energy_card::newest_unconnected(client, &pid).await.map(Value::String) }
            };
            st.allocation_id = crate::mcp::energy_card::wait_for(probe)
                .await
                .and_then(|v| v.as_str().map(String::from))
                .ok_or("the allocation was signed but has not appeared yet; resume in a minute")?;
            Ok(String::new())
        }
        "substation" => build_substation(app, client, st, idx, &pid).await,
        "guild_substation" => {
            let guild = st.guild_id.clone();
            build_substation(app, client, st, idx, &guild).await
        }
        "fund" => {
            let guild = st.guild_id.clone();
            // Already staked: the Alpha went where it was meant to.
            if grid(client, "2", &guild).await > 0.0 {
                return Ok(String::new());
            }
            let held = guild_vault(client, &guild).await;
            // The baseline is saved BEFORE signing, so a resumed run counts
            // what already arrived and sends only the rest.
            let base = match st.fund_base_ualpha {
                Some(b) => b,
                None => {
                    st.fund_base_ualpha = Some(held);
                    save(st)?;
                    held
                }
            };
            let need = st.infuse_ualpha.saturating_sub(held.saturating_sub(base));
            if need == 0 {
                return Ok(String::new());
            }
            let payload = crate::mcp::send_guard::vault_send_payload(&pid, &guild, "ualpha", &need.to_string())?;
            let r = sign(app, idx, "/structs.structs.MsgVaultSend", payload, "guild:found:fund").await?;
            let want = base + st.infuse_ualpha;
            let probe = || {
                let guild = guild.clone();
                async move { (guild_vault(client, &guild).await >= want).then(|| json!(true)) }
            };
            crate::mcp::energy_card::wait_for(probe).await.ok_or("the Alpha was sent but has not arrived yet; resume in a minute")?;
            Ok(tx_of(&r))
        }
        "guild_stake" => {
            let guild = st.guild_id.clone();
            let staked = || {
                let guild = guild.clone();
                async move { (grid(client, "2", &guild).await > 0.0).then(|| json!(true)) }
            };
            if staked().await.is_some() {
                return Ok(String::new());
            }
            // Short of the stake: either it was infused and the capacity is
            // a block behind, or the fund step never landed.
            let held = guild_vault(client, &guild).await;
            if held < st.infuse_ualpha {
                if crate::mcp::energy_card::wait_for(staked).await.is_some() {
                    return Ok(String::new());
                }
                return Err(format!(
                    "the guild vault holds {}; staking needs {}",
                    crate::mcp::tools::format::format_alpha(held as f64),
                    crate::mcp::tools::format::format_alpha(st.infuse_ualpha as f64)
                ));
            }
            let validator = client.query_entity("reactor", &st.reactor_id).await.ok().map(|r| s(r.pointer("/Reactor/validator"))).unwrap_or_default();
            if validator.is_empty() {
                return Err(format!("reactor {} has no validator address", st.reactor_id));
            }
            let r = sign(
                app,
                idx,
                "/structs.structs.MsgReactorInfuse",
                json!({
                    "validatorAddress": validator,
                    "amount": { "denom": "ualpha", "amount": st.infuse_ualpha.to_string() },
                    "ownerId": guild,
                }),
                "guild:found:stake",
            )
            .await?;
            crate::mcp::energy_card::wait_for(staked).await.ok_or("the stake was signed but the guild has no capacity yet; resume in a minute")?;
            Ok(tx_of(&r))
        }
        "guild_allocation" => {
            let guild = st.guild_id.clone();
            let find = || {
                let guild = guild.clone();
                async move {
                    crate::mcp::energy_card::newest(client, "allocation", "Allocation", |a| s(a.get("sourceObjectId")) == guild && s(a.get("destinationId")).is_empty())
                        .await
                        .as_ref()
                        .and_then(crate::mcp::energy_card::id_of)
                        .map(Value::String)
                }
            };
            if resumed {
                if let Some(a) = find().await.and_then(|v| v.as_str().map(String::from)) {
                    st.allocation_id = a;
                    return Ok(String::new());
                }
            }
            // Automated: the allocation tracks the guild's whole capacity, so
            // every later guild infusion grows the substation unasked.
            let automated = json!({ "controller": guild, "sourceObjectId": guild, "allocationType": "automated", "power": 0 });
            let r = match sign(app, idx, "/structs.structs.MsgAllocationCreate", automated, "guild:found:allocation").await {
                Ok(r) => r,
                // The chain refuses automated when the guild already carries
                // load or its capacity is not all usable; route the spare as
                // a dynamic allocation instead.
                Err(e) if e.contains("automated_conflict") || e.contains("unsupported_supply") => {
                    let spare = (grid(client, "2", &guild).await - grid(client, "3", &guild).await).floor();
                    if spare <= 0.0 {
                        return Err(format!("the guild has no spare capacity to route ({e})"));
                    }
                    let dynamic = json!({ "controller": guild, "sourceObjectId": guild, "allocationType": "dynamic", "power": spare as u64 });
                    sign(app, idx, "/structs.structs.MsgAllocationCreate", dynamic, "guild:found:allocation").await?
                }
                Err(e) => return Err(e),
            };
            st.allocation_id = crate::mcp::energy_card::wait_for(find)
                .await
                .and_then(|v| v.as_str().map(String::from))
                .ok_or("the allocation was signed but has not appeared yet; resume in a minute")?;
            Ok(tx_of(&r))
        }
        "entry" => {
            let g = client.query_entity("guild", &st.guild_id).await?;
            if s(g.pointer("/Guild/entrySubstationId")) == st.substation_id {
                return Ok(String::new());
            }
            guild_act(app, st, "entry_substation", &json!({ "substation": st.substation_id })).await
        }
        "connect" => {
            // Connected anywhere already (here, or a substation of their own
            // they chose since): leave them where they are.
            let (d, _) = draw_of(client, &pid).await;
            if !d.substation.is_empty() {
                return Ok(String::new());
            }
            let r = sign(
                app,
                idx,
                "/structs.structs.MsgSubstationPlayerConnect",
                json!({ "substationId": st.substation_id, "playerId": pid }),
                "guild:found:connect",
            )
            .await?;
            let want = st.substation_id.clone();
            let probe = || {
                let pid = pid.clone();
                let want = want.clone();
                async move { (draw_of(client, &pid).await.0.substation == want).then(|| json!(true)) }
            };
            crate::mcp::energy_card::wait_for(probe).await.ok_or("the connection was signed but has not landed yet; resume in a minute")?;
            Ok(tx_of(&r))
        }
        "found" => {
            // Never found twice: a guild this founder owns IS the founding.
            if let Some(g) = owned_guild(client, &pid).await {
                st.guild_id = g;
                return Ok(String::new());
            }
            let endpoint = if st.choices.hosting == "self" { st.choices.endpoint.trim().to_string() } else { String::new() };
            let r = sign(
                app,
                idx,
                "/structs.structs.MsgGuildCreate",
                json!({ "reactorId": st.reactor_id, "endpoint": endpoint, "entrySubstationId": st.substation_id }),
                "guild:found",
            )
            .await?;
            let probe = || {
                let pid = pid.clone();
                async move { owned_guild(client, &pid).await.map(Value::String) }
            };
            st.guild_id = crate::mcp::energy_card::wait_for(probe)
                .await
                .and_then(|v| v.as_str().map(String::from))
                .ok_or("the guild was signed but has not appeared yet; resume in a minute")?;
            Ok(tx_of(&r))
        }
        "policy" => {
            let g = client.query_entity("guild", &st.guild_id).await?;
            let now = crate::mcp::guild_membership::Policy::from_guild(g.get("Guild").unwrap_or(&Value::Null));
            let mut last = String::new();
            for (action, args) in policy_actions(&st.choices.policy, st.choices.stake_ualpha) {
                let already = match action {
                    "join_minimum" => args["amount"].as_str().and_then(|a| a.parse::<u64>().ok()) == Some(now.minimum),
                    "bypass_request" => now.request == args["level"],
                    "bypass_invite" => now.invite == args["level"],
                    _ => false,
                };
                if already {
                    continue;
                }
                last = guild_act(app, st, action, &args).await?;
            }
            Ok(last)
        }
        "name" => {
            let g = client.query_entity("guild", &st.guild_id).await?;
            if s(g.pointer("/Guild/name")) == st.choices.name.trim() {
                return Ok(String::new());
            }
            guild_act(app, st, "name", &json!({ "name": st.choices.name.trim() })).await
        }
        other => Err(format!("unknown step {other}")),
    }
}

/// A grid record (`/structs/grid/<type>-<object id>`: 2 capacity, 3 load).
/// Guild queries carry no grid attributes, so a guild's power is read here.
async fn grid(client: &CosmosClient, kind: &str, object: &str) -> f64 {
    client.lcd_get(&format!("/structs/grid/{kind}-{object}")).await.ok().map(|v| num(v.pointer("/gridRecord/value"))).unwrap_or(0.0)
}

async fn guild_vault(client: &CosmosClient, guild: &str) -> u64 {
    crate::mcp::guild_economy::vault_balance(client, guild, "ualpha").await.unwrap_or(0).min(u64::MAX as u128) as u64
}

/// Sign one founding message as HD `idx` (0 = the primary). Recorded on the
/// ledger like every other attempt; no retry, the run resumes instead.
async fn sign(app: &tauri::AppHandle, idx: u32, type_url: &str, payload: Value, context: &str) -> Result<Value, String> {
    crate::mcp::tx_retry::sign_once(app, idx, type_url, payload, context.to_string()).await
}

/// One guild setting as whoever founds. The primary goes through
/// guild_admin's own preview and checks; the founder owns the guild it just
/// made, so the plan is signed as is.
async fn guild_act(app: &tauri::AppHandle, st: &FoundState, action: &str, args: &Value) -> Result<String, String> {
    let (idx, pid) = st.signer();
    if idx == 0 {
        let r = crate::mcp::guild_admin::execute(app, Some(st.guild_id.clone()), action, args).await?;
        return Ok(s(r.get("tx")));
    }
    let plan = crate::mcp::guild_admin::plan(&st.guild_id, &pid, action, args)?;
    let r = sign(app, idx, plan.type_url, plan.payload, &format!("guild:found:{action}")).await?;
    Ok(tx_of(&r))
}

/// Bits `player` holds directly on `object` (a missing record reads 0).
async fn grant_on(client: &CosmosClient, object: &str, player: &str) -> u64 {
    client
        .lcd_get(&format!("/structs/permission/{object}%40{player}"))
        .await
        .ok()
        .map(|p| num(p.pointer("/permissionRecord/value")) as u64)
        .unwrap_or(0)
}

/// The founder replicant's own steps: made, funded from the primary's vault,
/// and (when the entry is the primary's substation) granted it.
async fn run_founder_step(app: &tauri::AppHandle, client: &CosmosClient, st: &mut FoundState, id: &str) -> Result<String, String> {
    use crate::mcp::virtual_players::{VPlayerRole, REGISTRY};
    let primary = st.founder.clone();
    match id {
        "founder_create" => {
            if !st.founder_player.is_empty() {
                return Ok(String::new());
            }
            // The index is reserved in the plan BEFORE signup, so a resumed
            // run adopts the row the first attempt made instead of a second.
            if st.founder_index > 0 {
                let row = REGISTRY.read().ok().and_then(|r| r.players.iter().find(|p| p.index == st.founder_index).cloned());
                if let Some(v) = row {
                    if let Some(p) = v.player_id.filter(|p| !p.is_empty()) {
                        st.founder_player = p;
                        st.founder_address = v.address;
                        return Ok(String::new());
                    }
                    return Err("the founder signed up but has no player id yet; resume in a minute".into());
                }
            }
            let index = if st.founder_index > 0 { st.founder_index } else { REGISTRY.read().map(|r| r.next_free_index()).map_err(|e| e.to_string())? };
            st.founder_index = index;
            save(st)?;
            let name = crate::mcp::callsign::name_for(index);
            let made = crate::mcp::virtual_players::spawn_one(app, index, name, true, VPlayerRole::Founder, None, None).await?;
            st.founder_address = made.address;
            st.founder_player = made.player_id.ok_or("the founder signed up but has no player id yet; resume in a minute")?;
            Ok(String::new())
        }
        "founder_fund" => {
            let to = st.founder_player.clone();
            // Spent already: the founder founded with it.
            if owned_guild(client, &to).await.is_some() {
                return Ok(String::new());
            }
            let held = guild_vault(client, &to).await;
            let base = match st.founder_fund_base {
                Some(b) => b,
                None => {
                    st.founder_fund_base = Some(held);
                    save(st)?;
                    held
                }
            };
            let need = st.founder_fund_ualpha.saturating_sub(held.saturating_sub(base));
            if need == 0 {
                return Ok(String::new());
            }
            let payload = crate::mcp::send_guard::vault_send_payload(&primary, &to, "ualpha", &need.to_string())?;
            let r = sign(app, 0, "/structs.structs.MsgVaultSend", payload, "guild:found:founder_fund").await?;
            let want = base + st.founder_fund_ualpha;
            let probe = || {
                let to = to.clone();
                async move { (guild_vault(client, &to).await >= want).then(|| json!(true)) }
            };
            crate::mcp::energy_card::wait_for(probe).await.ok_or("the Alpha was sent but has not arrived yet; resume in a minute")?;
            Ok(tx_of(&r))
        }
        "founder_grant" => {
            use crate::mcp::guild_admin::bits::SUBSTATION_CONNECTION;
            let sub = st.substation_id.clone();
            let to = st.founder_player.clone();
            if grant_on(client, &sub, &to).await & SUBSTATION_CONNECTION != 0 {
                return Ok(String::new());
            }
            let r = sign(
                app,
                0,
                "/structs.structs.MsgPermissionGrantOnObject",
                json!({ "objectId": sub, "playerId": to, "permissions": SUBSTATION_CONNECTION }),
                "guild:found:founder_grant",
            )
            .await?;
            Ok(tx_of(&r))
        }
        other => Err(format!("unknown step {other}")),
    }
}

/// Build a substation owned by `owner` from `st.allocation_id`, or adopt the
/// one a resumed run already built from it.
async fn build_substation(app: &tauri::AppHandle, client: &CosmosClient, st: &mut FoundState, idx: u32, owner: &str) -> Result<String, String> {
    let dest = client
        .query_entity("allocation", &st.allocation_id)
        .await
        .ok()
        .map(|a| s(a.pointer("/Allocation/destinationId")))
        .unwrap_or_default();
    if !dest.is_empty() {
        st.substation_id = dest;
        return Ok(String::new());
    }
    let mine = |v: &Value| s(v.get("owner")) == owner;
    let before = crate::mcp::energy_card::newest(client, "substation", "Substation", mine).await.as_ref().and_then(crate::mcp::energy_card::id_of);
    let r = sign(
        app,
        idx,
        "/structs.structs.MsgSubstationCreate",
        json!({ "owner": owner, "allocationId": st.allocation_id }),
        "guild:found:substation",
    )
    .await?;
    let probe = || {
        let before = before.clone();
        async move {
            crate::mcp::energy_card::newest(client, "substation", "Substation", |v| s(v.get("owner")) == owner)
                .await
                .filter(|v| crate::mcp::energy_card::id_of(v) != before)
        }
    };
    st.substation_id = crate::mcp::energy_card::wait_for(probe)
        .await
        .as_ref()
        .and_then(crate::mcp::energy_card::id_of)
        .ok_or("the substation was signed but has not appeared yet; resume in a minute")?;
    Ok(tx_of(&r))
}


/// guild.json for the founded guild (or a draft), with the self-hoster's
/// services filled in, plus whether the app itself would accept it.
pub fn guild_json(guild_id: Option<String>, choices: Option<Choices>, services: Value) -> Result<Value, String> {
    let (pid, _) = identity()?;
    let saved = load(&pid);
    let c = choices.or_else(|| saved.as_ref().map(|s| s.choices.clone())).unwrap_or_default().with_defaults();
    let id = guild_id.or_else(|| saved.as_ref().map(|s| s.guild_id.clone()).filter(|g| !g.is_empty())).unwrap_or_else(|| "0-?".into());
    let services = if services.is_object() { services } else { json!({ "guild_api": "", "grass_nats_websocket": "" }) };
    let doc = render_guild_json(&id, &c, &services);
    let body = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
    let check = crate::guild_directory::check_doc(&id, &body);
    Ok(json!({ "guild_id": id, "doc": doc, "text": serde_json::to_string_pretty(&doc).unwrap_or_default(), "valid": check.is_ok(), "why": check.err() }))
}

/// Fetch the self-hosted endpoint and validate it as the directory would.
pub async fn check_endpoint(guild_id: String, endpoint: String) -> Result<Value, String> {
    match crate::guild_directory::probe_endpoint(&guild_id, endpoint.trim()).await {
        Ok(cfg) => Ok(json!({ "ok": true, "name": cfg.name, "tag": cfg.guild_tag, "guild_api": cfg.guild_api, "grass": cfg.grass_nats_ws })),
        Err(e) => Ok(json!({ "ok": false, "why": e })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_chain_rule() {
        assert!(name_refusal("Iron Tide").is_none());
        assert!(name_refusal("Kilgore Crabla").is_none());
        assert!(name_refusal("O'Neil-s_Crew").is_none());
        assert!(name_refusal("Ünïcode Guild").is_none(), "letters, not just ASCII");
        assert!(name_refusal("ab").is_some(), "too short");
        assert!(name_refusal("a very long guild name indeed").is_some(), "too long");
        assert!(name_refusal(" Tide").is_some());
        assert!(name_refusal("Iron  Tide").is_some());
        assert!(name_refusal("0-12").is_some(), "looks like an id");
        assert!(name_refusal("Tide!").is_some());
        assert_eq!(name_key("  Iron Tide "), "iron tide", "the name index folds case and trims");
    }

    #[test]
    fn tags_default_from_the_name() {
        assert_eq!(default_tag("Iron Tide"), "IT");
        assert_eq!(default_tag("Orbital Hydro Energy"), "OHE");
        assert_eq!(default_tag("Crabla"), "CRAB");
        assert!(tag_refusal("TIDE").is_none());
        assert!(tag_refusal("SN.C").is_none(), "SN Corp's live tag");
        assert!(tag_refusal("TOOLONGTAG").is_some());
        assert!(tag_refusal("").is_some());
    }

    #[test]
    fn power_is_sized_in_members() {
        // 5 members at 2.18 kW with 1.5× headroom, after the 10% loss.
        assert_eq!(allocation_for(5, P75_MEMBER_DRAW_MW), 18_166_667);
        // Each of the 5 keeps ≥ 1.5× the p75 draw.
        let share = (allocation_for(5, P75_MEMBER_DRAW_MW) as f64 * USABLE).floor() / 5.0;
        assert!(share >= P75_MEMBER_DRAW_MW * HEADROOM - 1.0);
        assert_eq!(allocation_for(0, P75_MEMBER_DRAW_MW), allocation_for(1, P75_MEMBER_DRAW_MW), "the founder counts");
        // The stake that brings one member's draw: ≈ 2.3 Alpha.
        assert_eq!(stake_for_one_member(), 2_300_000);
    }

    #[test]
    fn a_founder_with_no_spare_power_must_stake_for_it() {
        // Typical: 3.1 kW of structs on a 7.4 kW guild share, no own capacity.
        let draw = Draw { load: 0.0, structs_load: 3_100_000.0, capacity: 0.0, substation: "4-1".into() };
        let alloc = allocation_for(5, P75_MEMBER_DRAW_MW);
        let need = infuse_needed(&draw, 7_400_000.0, alloc, 0.04);
        // At least the allocation, after the 4% commission.
        assert!(need as f64 >= alloc as f64 / 0.96, "{need}");
        assert!((need as f64) < alloc as f64 / 0.96 * 1.05, "and not wildly more: {need}");
        assert_eq!(need % 10_000, 0, "whole hundredths of an Alpha");
        // Plenty of capacity already: nothing to stake.
        let rich = Draw { capacity: 60_000_000.0, ..draw.clone() };
        assert_eq!(infuse_needed(&rich, 7_400_000.0, alloc, 0.04), 0);
        // A heavy founder whose draw exceeds what the new substation gives
        // alone must also cover the difference.
        let heavy = Draw { structs_load: 30_000_000.0, ..draw };
        assert!(infuse_needed(&heavy, 7_400_000.0, alloc, 0.04) > need);
    }

    #[test]
    fn each_policy_sets_both_routes() {
        let names = |p: &str| policy_actions(p, 2_300_000).iter().map(|(a, _)| *a).collect::<Vec<_>>();
        assert_eq!(names("application"), vec!["join_minimum", "bypass_request", "bypass_invite"]);
        assert_eq!(names("invite"), vec!["join_minimum", "bypass_invite"]);
        assert_eq!(names("stake"), vec!["join_minimum", "bypass_invite"]);
        assert_eq!(names("open"), vec!["bypass_invite"], "minimum 0 and requests closed are already the default");
        let app = policy_actions("application", 0);
        assert_eq!(app[0].1["amount"], u64::MAX.to_string());
        assert_eq!(policy_actions("stake", 2_300_000)[0].1["amount"], "2300000");
        // Every action is one guild_admin knows how to sign.
        for p in POLICIES {
            for (a, args) in policy_actions(p, 2_300_000) {
                assert!(crate::mcp::guild_admin::plan("0-6", "1-9", a, &args).is_ok(), "{p}: {a}");
            }
        }
        // And reads back as the label the membership cards show.
        let max = u64::MAX.to_string();
        let g = json!({ "joinInfusionMinimum": max, "joinInfusionMinimumBypassByRequest": "permissioned", "joinInfusionMinimumBypassByInvite": "permissioned" });
        assert_eq!(crate::mcp::guild_membership::Policy::from_guild(&g).label(), "application");
    }

    #[test]
    fn the_default_reactor_is_never_jailed() {
        let r = |id: &str, jailed: bool, bonded: bool, commission: f64, guilds: usize| ReactorRow {
            id: id.into(), validator: "v".into(), jailed, bonded, commission, tokens: 1.0, guilds: vec!["0-1".into(); guilds], ..Default::default()
        };
        let rows = vec![r("3-10", true, false, 0.01, 0), r("3-1", false, true, 0.04, 1), r("3-7", false, true, 0.04, 0), r("3-9", false, false, 0.02, 0)];
        assert_eq!(pick_reactor(&rows).as_deref(), Some("3-7"), "bonded, then fewest guilds");
        assert_eq!(pick_reactor(&[r("3-10", true, true, 0.0, 0)]), None);
    }

    #[test]
    fn steps_stake_only_when_short() {
        assert_eq!(steps_for("personal", 0, false).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["allocation", "substation", "found", "policy", "name"]);
        assert_eq!(steps_for("personal", 5, false).first().unwrap().id, "infuse");
        let mut st = FoundState { steps: steps_for("personal", 0, false), ..Default::default() };
        assert!(!st.started() && !st.finished());
        st.steps.iter_mut().for_each(|s| s.status = "done".into());
        assert!(st.finished());
    }

    #[test]
    fn an_existing_substation_or_none_builds_nothing() {
        assert_eq!(route_for("4-17", "treasury", 50, 9), "existing");
        assert_eq!(route_for("none", "", 5, 0), "none");
        assert_eq!(route_for("new", "", 5, 0), "personal");
        assert_eq!(route_for("", "treasury", 5, 0), "treasury");
        for route in ["existing", "none"] {
            // The infuse amount is ignored: there is nothing to power.
            assert_eq!(steps_for(route, 7, true).into_iter().map(|s| s.id).collect::<Vec<_>>(), vec!["found", "policy", "name"]);
        }
        use crate::mcp::guild_admin::bits::*;
        assert_eq!(route_bits("existing") & SUBSTATION_CONNECTION, SUBSTATION_CONNECTION);
        assert_eq!(route_bits("none") & (TOKEN_INFUSE | SOURCE_ALLOCATION), 0);
    }

    #[test]
    fn a_founder_is_made_and_paid_first_and_hands_back_the_controls_last() {
        let ids = |route: &str, by_founder, grant| plan_steps(route, 5, route == "treasury", by_founder, grant).into_iter().map(|s| s.id).collect::<Vec<_>>();
        // The primary founding is unchanged.
        assert_eq!(ids("personal", false, false), steps_for("personal", 5, false).into_iter().map(|s| s.id).collect::<Vec<_>>());
        assert_eq!(ids("existing", true, true), vec!["founder_create", "founder_fund", "founder_grant", "found", "policy", "name", "controls"]);
        assert_eq!(ids("none", true, false), vec!["founder_create", "founder_fund", "found", "policy", "name", "controls"]);
        let t = ids("treasury", true, false);
        assert_eq!((t.first().map(String::as_str), t.last().map(String::as_str)), (Some("founder_create"), Some("controls")));
        assert!(t.iter().position(|s| s == "founder_fund") < t.iter().position(|s| s == "found"));
    }

    #[test]
    fn whoever_founds_signs() {
        let mut st = FoundState { founder: "1-194".into(), ..Default::default() };
        assert_eq!(st.signer(), (0, "1-194".to_string()));
        st.choices.founder = "new".into();
        assert!(st.by_founder());
        // Before the founder exists nobody signs a guild step.
        assert_eq!(st.signer(), (0, String::new()));
        st.founder_index = 3001;
        st.founder_player = "1-9000".into();
        assert_eq!(st.signer(), (3001, "1-9000".to_string()));
        // The founder needs only the chain's passive draw.
        assert_eq!(new_founder_draw().need(), 25_000.0);
        let bad = Choices { founder: "someone".into(), ..Choices { name: "Iron Tide".into(), ..Default::default() }.with_defaults() };
        assert_eq!(choice_refusals(&bad).iter().map(|r| refusal_fix(r)).collect::<Vec<_>>(), vec!["identity"]);
    }

    #[test]
    fn substation_access_follows_the_chains_order() {
        use crate::mcp::guild_admin::bits::*;
        assert_eq!(substation_access("1-194", "1-194", 0, 0), "owner");
        assert_eq!(substation_access("1-1", "1-194", SUBSTATION_CONNECTION | PLAY, 0), "grant");
        assert_eq!(substation_access("1-1", "1-194", PLAY, SUBSTATION_CONNECTION), "rank");
        // Other bits on a grant are not a connect grant (4-1@1-194 = 0 live).
        assert_eq!(substation_access("1-1", "1-194", SOURCE_ALLOCATION | ADMIN, 0), "none");
        assert_eq!(substation_access("", "1-194", 0, 0), "none");
    }

    #[test]
    fn a_substations_share_matches_the_chains_connection_capacity() {
        // Live 2026-11-13: 4-1 cap 41,614.9 kW, 5,071 connections → 7.39 kW;
        // 4-3 cap 2,350.1 kW, load 200 kW, none connected → 1,915.07 kW.
        let oh = SubstationRow { capacity: 41_614_900_000.0, connections: 5071, ..Default::default() };
        assert!((oh.usable() / 5071.0 - 7_385_000.0).abs() < 10_000.0);
        let ls = SubstationRow { capacity: 2_350_100_000.0, load: 200_000_000.0, ..Default::default() };
        assert!((ls.each_at(1) - 1_915_090_000.0).abs() < 1_000.0);
        // 4-17: 1 kW in, five members share 0.9 kW.
        let mine = SubstationRow { capacity: 1_000_000.0, ..Default::default() };
        assert_eq!(mine.each_at(5), 180_000.0);
        assert_eq!(mine.each_at(0), 900_000.0);
    }

    #[test]
    fn the_next_guild_is_one_past_the_highest_and_refusals_name_their_stage() {
        assert_eq!(next_guild_id(&["0-1".into(), "0-5".into(), "0-3".into()]), "0-6");
        assert_eq!(next_guild_id(&[]), "0-1");
        let bad = Choices { name: "x".into(), tag: "toolongtag".into(), policy: "anyone".into(), members: 0, hosting: "self".into(), ..Default::default() };
        let fixes: Vec<&str> = choice_refusals(&bad).iter().map(|r| refusal_fix(r)).collect();
        assert_eq!(fixes, vec!["identity", "identity", "joining", "substation", "signup"]);
    }

    #[test]
    fn reactors_rank_by_stake_and_jailed_ones_go_last() {
        let r = |id: &str, tokens: f64, jailed: bool| ReactorRow { id: id.into(), tokens, jailed, bonded: !jailed, validator: "v".into(), ..Default::default() };
        let list = reactor_list(&[r("3-9", 5.0, true), r("3-2", 30.0, false), r("3-1", 70.0, false)]);
        let ids: Vec<&str> = list.iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["3-1", "3-2", "3-9"]);
        assert_eq!((list[0]["rank"].as_u64(), list[2]["rank"].as_u64()), (Some(1), Some(0)));
        assert!((list[0]["share"].as_f64().unwrap() - 0.7).abs() < 1e-9);
    }

    #[test]
    fn treasury_founds_first_and_locks_down_before_spending() {
        let ids = |connect| steps_for("treasury", 25_000_000, connect).into_iter().map(|s| s.id).collect::<Vec<_>>();
        assert_eq!(ids(true), vec!["found", "policy", "fund", "guild_stake", "guild_allocation", "guild_substation", "entry", "connect", "name"]);
        // A founder on a substation of their own is never pulled off it.
        assert!(!ids(false).contains(&"connect".to_string()));
    }

    #[test]
    fn the_guild_stakes_enough_for_the_whole_substation() {
        let alloc = allocation_for(5, P75_MEMBER_DRAW_MW);
        let stake = treasury_stake(alloc, 0.04);
        // Capacity after commission covers the automated allocation…
        assert!(stake as f64 * 0.96 >= alloc as f64, "{stake} for {alloc}");
        // …without staking a whole extra member's worth.
        assert!((stake as f64 * 0.96) < alloc as f64 * 1.02);
        assert_eq!(stake % 10_000, 0, "whole 0.01 Alpha");
    }

    #[test]
    fn the_route_is_the_founders_answer_else_inferred() {
        assert_eq!(pick_route("personal", 50, 9), "personal");
        assert_eq!(pick_route("treasury", 5, 0), "treasury");
        assert_eq!(pick_route("", 5, 0), "personal", "spare capacity covers it");
        assert_eq!(pick_route("", 5, 1), "treasury", "staking either way: let the guild own it");
        assert_eq!(pick_route("", 50, 0), "treasury", "big guilds own their power");
        assert!(route_bits("treasury") & crate::mcp::guild_admin::bits::GUILD_SUBSTATION_UPDATE != 0);
        assert!(route_bits("personal") & crate::mcp::guild_admin::bits::GUILD_SUBSTATION_UPDATE == 0);
        let bad = Choices { name: "Iron Tide".into(), power: "borrowed".into(), ..Default::default() }.with_defaults();
        assert!(choice_refusals(&bad).iter().any(|r| r.contains("power")));
    }

    #[test]
    fn answers_are_checked_before_any_read() {
        let ok = Choices { name: "Iron Tide".into(), ..Default::default() }.with_defaults();
        assert!(choice_refusals(&ok).is_empty(), "{:?}", choice_refusals(&ok));
        assert_eq!((ok.tag.as_str(), ok.members, ok.policy.as_str(), ok.hosting.as_str()), ("IT", 5, "application", "none"));
        let selfhost = Choices { hosting: "self".into(), endpoint: "http://x".into(), ..ok.clone() };
        assert!(choice_refusals(&selfhost).iter().any(|r| r.contains("https")));
        let bad = Choices { policy: "anyone".into(), members: 9999, ..ok };
        assert_eq!(choice_refusals(&bad).len(), 2);
    }

    #[test]
    fn rendered_guild_json_is_v1_and_the_app_accepts_it() {
        let c = Choices { name: "Iron Tide".into(), tag: "TIDE".into(), pitch: "Five friends, one sector.".into(), ..Default::default() }.with_defaults();
        let services = json!({ "guild_api": "https://tide.example/api/", "grass_nats_websocket": "wss://tide.example/grass" });
        let doc = render_guild_json("0-6", &c, &services);
        assert_eq!(doc["guild"]["schema_version"], 1);
        assert_eq!(doc["guild"]["denom"], json!({ "0": "utide", "6": "tide" }));
        assert_eq!(doc["guild"]["recruiting"]["status"], "selective");
        assert_eq!(doc["guild"]["recruiting"]["pitch"], "Five friends, one sector.");
        let body = serde_json::to_vec(&doc).unwrap();
        assert!(crate::guild_directory::check_doc("0-6", &body).is_ok(), "{:?}", crate::guild_directory::check_doc("0-6", &body).err());
        assert!(crate::guild_directory::check_doc("0-7", &body).is_err(), "another guild's id is refused");
        // No services yet: the app would not adopt it.
        let draft = render_guild_json("0-6", &c, &json!({ "guild_api": "", "grass_nats_websocket": "" }));
        assert!(crate::guild_directory::check_doc("0-6", &serde_json::to_vec(&draft).unwrap()).is_err());
    }

    #[test]
    fn state_round_trips_through_its_file() {
        let st = FoundState { founder: "1-9".into(), guild_id: "0-6".into(), steps: steps_for("personal", 10, false), route: "personal".into(), fund_base_ualpha: Some(3), ..Default::default() };
        let text = serde_json::to_string(&st).unwrap();
        let back: FoundState = serde_json::from_str(&text).unwrap();
        assert_eq!(back, st);
        // A file from an older build with fewer fields still loads.
        let old: FoundState = serde_json::from_str(r#"{"founder":"1-9","guild_id":"0-6"}"#).unwrap();
        assert_eq!(old.guild_id, "0-6");
    }
}
