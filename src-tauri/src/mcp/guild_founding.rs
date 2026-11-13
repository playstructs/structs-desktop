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
//! Steps (proposals/guild-founding.md §5.1, personal power route):
//!   infuse     stake Alpha from the vault so the founder has spare capacity
//!   allocation a dynamic allocation of the sized power from the founder
//!   substation a substation made from it (the guild's entry substation)
//!   found      MsgGuildCreate {reactor, endpoint or "", substation}
//!   policy     join minimum and invite/request levels for the chosen policy
//!   name       MsgGuildUpdateName
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
    pub reactor_id: String,
    pub infuse_ualpha: u64,
    pub allocation_mw: u64,
    pub allocation_id: String,
    pub substation_id: String,
    pub guild_id: String,
    pub steps: Vec<Step>,
    pub started_ms: u64,
    pub updated_ms: u64,
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
    pub commission: f64,
    pub tokens: f64,
    pub guilds: Vec<String>,
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

/// The ordered steps for these answers. The infuse step is present only when
/// the founder is short of capacity.
pub fn steps_for(infuse_ualpha: u64) -> Vec<Step> {
    let s = |id: &str, label: &str| Step { id: id.into(), label: label.into(), status: "pending".into(), ..Default::default() };
    let mut out = Vec::new();
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

/// Every reactor with its validator's state and which guilds prefer it.
pub async fn reactors(client: &CosmosClient) -> Vec<ReactorRow> {
    let rows = client.list_all_entities("reactor", "Reactor").await.unwrap_or_default();
    let guilds = client.list_all_entities("guild", "Guild").await.unwrap_or_default();
    let vals = client
        .lcd_get("/cosmos/staking/v1beta1/validators?pagination.limit=500")
        .await
        .ok()
        .and_then(|v| v.get("validators").and_then(|a| a.as_array()).cloned())
        .unwrap_or_default();
    rows.iter()
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
                validator,
            }
        })
        .collect()
}

fn reactor_json(r: &ReactorRow) -> Value {
    json!({
        "id": r.id, "moniker": r.moniker, "jailed": r.jailed, "bonded": r.bonded,
        "commission": r.commission, "tokens": r.tokens.to_string(), "guilds": r.guilds,
    })
}

/// Everything the card shows before Found: checks, the founder's move, the
/// power plan, costs, steps, and the guild.json a self-hoster will publish.
pub async fn preview(choices: Choices) -> Result<Value, String> {
    let c = choices.with_defaults();
    let (pid, address) = identity()?;
    let client = CosmosClient::new();
    let mut problems = choice_refusals(&c);
    let mut warnings: Vec<String> = Vec::new();

    // The founder.
    let player = client.query_entity("player", &pid).await?;
    let p = player.get("Player").cloned().unwrap_or(Value::Null);
    let own_guild = s(p.get("guildId"));
    let rank = num(p.get("guildRank")) as u64;
    let guilds = client.list_all_entities("guild", "Guild").await.unwrap_or_default();
    let owned = guilds.iter().find(|g| s(g.get("owner")) == pid).map(|g| s(g.get("id")));
    // A founding already under way owns its guild — that is not a refusal.
    let resuming = load(&pid).filter(|st| !st.guild_id.is_empty() && !st.finished());
    if let (Some(g), None) = (&owned, &resuming) {
        problems.push(format!("you own {g}; hand it over before founding another"));
    }
    if !c.name.trim().is_empty() {
        let key = name_key(&c.name);
        if let Some(g) = guilds.iter().find(|g| name_key(&s(g.get("name"))) == key && !s(g.get("name")).is_empty()) {
            problems.push(format!("the name '{}' is taken by {}", c.name.trim(), s(g.get("id"))));
        }
    }
    let vault = crate::mcp::guild_economy::vault_balance(&client, &pid, "ualpha").await.unwrap_or(0) as u64;
    if let Some(why) = crate::mcp::send_guard::signer_lacks(&address, crate::mcp::guild_admin::bits::PLAY | crate::mcp::guild_admin::bits::TOKEN_TRANSFER, "play + token transfer").await {
        problems.push(why);
    }

    // Reactor.
    let rows = reactors(&client).await;
    let reactor_id = if c.reactor.trim().is_empty() { pick_reactor(&rows).unwrap_or_default() } else { c.reactor.trim().to_string() };
    let chosen = rows.iter().find(|r| r.id == reactor_id).cloned();
    match &chosen {
        None => problems.push(if reactor_id.is_empty() { "no reactor can take a guild right now".into() } else { format!("no reactor {reactor_id} on chain") }),
        Some(r) if r.jailed => problems.push(format!("{} is jailed; pick another reactor", r.id)),
        Some(r) if !r.bonded => warnings.push(format!("{} is not in the bonded set", r.id)),
        _ => {}
    }
    let commission = chosen.as_ref().map(|r| r.commission).filter(|c| *c > 0.0).unwrap_or(0.04);

    // Power: size the substation, then what the founder must stake for it.
    let (draw, old_share) = draw_of(&client, &pid).await;
    let alloc = allocation_for(c.members, P75_MEMBER_DRAW_MW);
    let infuse = infuse_needed(&draw, old_share, alloc, commission);
    let share_alone = (alloc as f64 * USABLE).floor();
    let share_full = share_alone / c.members.max(1) as f64;
    // Does founding move them? Only off their old guild's entry substation.
    let old_entry = if own_guild.starts_with("0-") {
        client.query_entity("guild", &own_guild).await.ok().map(|g| s(g.pointer("/Guild/entrySubstationId"))).unwrap_or_default()
    } else {
        String::new()
    };
    let moves = draw.substation.is_empty() || draw.substation == old_entry;
    let share_after = if moves { share_alone } else { old_share };
    let cap_after = draw.capacity + infuse as f64 * (1.0 - commission) - alloc as f64;
    let online_after = draw.load + draw.structs_load <= cap_after.max(0.0) + share_after;
    if !online_after {
        problems.push("you would go offline after founding: ready for fewer members, or stake more".into());
    }
    let total = FOUNDING_UALPHA + infuse;
    if vault < total {
        problems.push(format!(
            "your vault holds {}; founding needs {}",
            crate::mcp::tools::format::format_alpha(vault as f64),
            crate::mcp::tools::format::format_alpha(total as f64)
        ));
    }
    if c.hosting != "self" {
        warnings.push("no sign-up site: new players can only join from a client that already plays".into());
    }

    let replicants = crate::mcp::virtual_players::count();
    let steps = steps_for(infuse);
    let doc = render_guild_json("0-?", &c, &json!({ "guild_api": "", "grass_nats_websocket": "" }));
    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "warnings": warnings,
        "choices": c,
        "founder": {
            "player_id": pid, "guild_id": own_guild, "rank": rank, "owns": owned,
            "vault_ualpha": vault.to_string(), "replicants_stay": replicants,
            "draw_mw": draw.need(), "capacity_mw": draw.capacity,
            "substation_now": draw.substation, "share_now_mw": old_share,
            "moves": moves, "share_after_mw": share_after, "online_after": online_after,
        },
        "reactor": chosen.as_ref().map(reactor_json),
        "reactors": rows.iter().map(reactor_json).collect::<Vec<_>>(),
        "power": {
            "members": c.members, "member_choices": MEMBER_CHOICES, "p75_draw_mw": P75_MEMBER_DRAW_MW, "headroom": HEADROOM,
            "allocation_mw": alloc, "share_alone_mw": share_alone, "share_full_mw": share_full,
            "infuse_ualpha": infuse.to_string(),
        },
        "cost": {
            "founding_ualpha": FOUNDING_UALPHA.to_string(),
            "burned_ualpha": "1000000",
            "infuse_ualpha": infuse.to_string(),
            "total_ualpha": total.to_string(),
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
            let st = FoundState {
                founder: pid.clone(),
                reactor_id: pv["reactor"]["id"].as_str().unwrap_or("").to_string(),
                infuse_ualpha: infuse,
                allocation_mw: pv["power"]["allocation_mw"].as_u64().unwrap_or(0),
                steps: steps_for(infuse),
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
    let pid = st.founder.clone();
    match id {
        "infuse" => {
            // Capacity may already be there (a resumed plan, or staked since).
            let (draw, old) = draw_of(client, &pid).await;
            if infuse_needed(&draw, old, st.allocation_mw, 0.04) == 0 {
                return Ok(String::new());
            }
            let r = crate::mcp::tools::infusions::mcp_infusion_infuse_impl(app.clone(), address.to_string(), st.reactor_id.clone(), st.infuse_ualpha as f64).await?;
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
            crate::mcp::tools::board_pages::mcp_allocation_create_impl(app.clone(), pid.clone(), "dynamic".into(), st.allocation_mw as f64).await?;
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
        "substation" => {
            // Already built from this allocation (a resumed run)? Adopt it.
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
            let before = crate::mcp::energy_card::newest(client, "substation", "Substation", |v| s(v.get("owner")) == pid)
                .await
                .as_ref()
                .and_then(crate::mcp::energy_card::id_of);
            let r = crate::mcp::tx_retry::sign_as_primary(
                app,
                "/structs.structs.MsgSubstationCreate",
                json!({ "owner": pid, "allocationId": st.allocation_id }),
                "guild:found:substation",
            )
            .await?;
            let probe = || {
                let before = before.clone();
                let pid = pid.clone();
                async move {
                    crate::mcp::energy_card::newest(client, "substation", "Substation", |v| s(v.get("owner")) == pid)
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
        "found" => {
            // Never found twice: a guild this founder owns IS the founding.
            if let Some(g) = owned_guild(client, &pid).await {
                st.guild_id = g;
                return Ok(String::new());
            }
            let endpoint = if st.choices.hosting == "self" { st.choices.endpoint.trim().to_string() } else { String::new() };
            let r = crate::mcp::tx_retry::sign_as_primary(
                app,
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
                let r = crate::mcp::guild_admin::execute(app, Some(st.guild_id.clone()), action, &args).await?;
                last = s(r.get("tx"));
            }
            Ok(last)
        }
        "name" => {
            let g = client.query_entity("guild", &st.guild_id).await?;
            if s(g.pointer("/Guild/name")) == st.choices.name.trim() {
                return Ok(String::new());
            }
            let r = crate::mcp::guild_admin::execute(app, Some(st.guild_id.clone()), "name", &json!({ "name": st.choices.name.trim() })).await?;
            Ok(s(r.get("tx")))
        }
        other => Err(format!("unknown step {other}")),
    }
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
        assert_eq!(steps_for(0).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["allocation", "substation", "found", "policy", "name"]);
        assert_eq!(steps_for(5).first().unwrap().id, "infuse");
        let mut st = FoundState { steps: steps_for(0), ..Default::default() };
        assert!(!st.started() && !st.finished());
        st.steps.iter_mut().for_each(|s| s.status = "done".into());
        assert!(st.finished());
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
        let st = FoundState { founder: "1-9".into(), guild_id: "0-6".into(), steps: steps_for(10), ..Default::default() };
        let text = serde_json::to_string(&st).unwrap();
        let back: FoundState = serde_json::from_str(&text).unwrap();
        assert_eq!(back, st);
        // A file from an older build with fewer fields still loads.
        let old: FoundState = serde_json::from_str(r#"{"founder":"1-9","guild_id":"0-6"}"#).unwrap();
        assert_eq!(old.guild_id, "0-6");
    }
}
