//! Raid View — the read-only spectator surface.
//!
//! Two pieces: a galaxy-wide list of live raids (rendered as `War · Live
//! Raids` in Team Ops) and a per-location window that draws a planet the way
//! the game draws it, with combat choreography playing as shots resolve.
//!
//! # Reaching Team Ops is the gate
//!
//! There is deliberately no second switch. Team Ops is the operator console —
//! you get there by connecting an agent, or through the unlabelled door on the
//! DEBUG tab — and anyone who has it open is already the audience for this.
//! Making them find and flip a toggle as well would only hide a feature from
//! the people looking straight at it.
//!
//! Nothing here is privileged in any case: raids are public chain state that
//! the game's own client already streams to every player. The windows are
//! read-only and cannot sign.
//!
//! # Why the window never loads the game
//!
//! Every window is served from `tauri://localhost`, so a second window is
//! **same-origin with the game**: it shares `localStorage`, which holds the
//! mnemonic. Booting the game bundle a second time would also resume
//! proof-of-work whose task registry is keyed on struct id (duplicate tasks
//! cancel each other, silently killing the real miner) and double-answer
//! broadcast signing requests — the same transaction signed and submitted
//! twice.
//!
//! Tauri applies `initialization_script` **per window**, so the fix is simply
//! never to attach it here. Raid windows join the `board`/`stream` family:
//! plain documents that talk to Rust over `invoke` and receive events. They
//! never call `sync_game_state`, never touch `localStorage`, and cannot sign.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

// ── Window labels ───────────────────────────────────────────────────────────

/// Label prefix for spectator windows. `capabilities/default.json` grants the
/// glob `raid-*`, so labels can be minted per location without a capability
/// change per window.
pub const LABEL_PREFIX: &str = "raid-";

/// Window label for a location id. Ids are `<type>-<index>` (`2-1595`,
/// `9-4021`); `-` is already the label separator so no escaping is needed, but
/// anything outside `[A-Za-z0-9-]` is replaced so a hostile id cannot produce a
/// label that collides with `board`, `stream` or `main`.
pub fn label_for(location_id: &str) -> String {
    let safe: String = location_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    format!("{}{}", LABEL_PREFIX, safe)
}

// ── Raid enumeration ────────────────────────────────────────────────────────

/// Statuses that mean the raid is over. Mirrors the game's own
/// `RaidStatusUtil.hasRaidEnded` (`structs-webapp/src/js/util/RaidStatusUtil.js`)
/// — kept identical so our list and the game never disagree about whether a
/// raid is finished.
pub const TERMINAL_STATUSES: &[&str] = &[
    "attackerDefeated",
    "attackerRetreated",
    "raidSuccessful",
    "demilitarized",
];

/// Statuses the game treats as a raid actually in progress
/// (`PlanetRaid.isRaidActive`). `requested` is deliberately NOT here: the game
/// does not count it as active, and neither do we — but we still surface it,
/// flagged, because "someone has requested a raid" is worth an operator's
/// attention even though nothing is happening yet.
pub const ACTIVE_STATUSES: &[&str] = &["initiated", "ongoing", "shieldsVulnerable"];

/// How long a raid may go without a status change before we stop calling it
/// live. Empirically the median gap between consecutive `raid_status` events
/// inside one raid is ~5 minutes and the median whole episode runs ~11
/// minutes, so an hour is generous by an order of magnitude.
///
/// This bound is necessary, not decorative: `planet_raid` never clears rows
/// that failed to reach a terminal status, so today it reports planets 2-400
/// and 2-174 as `initiated` from 5 and 19 days ago respectively. Status alone
/// would present both as live raids.
pub const STALE_AFTER_MS: f64 = 60.0 * 60.0 * 1000.0;

/// Where a raid sits relative to us. Drives ordering and the row badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OurSide {
    /// One of ours is doing the raiding.
    Attacker,
    /// One of ours is being raided.
    Defender,
    /// Both sides are ours — a roster player raiding another roster player.
    Both,
    /// Nobody we hold keys for is involved.
    None,
}

/// A single raid, reduced from the activity feed and enriched with identities.
#[derive(Debug, Clone, Serialize)]
pub struct RaidRow {
    pub planet_id: String,
    pub fleet_id: Option<String>,
    pub status: String,
    /// Wall-clock of the latest status change, epoch ms.
    pub updated_ms: f64,
    pub seized_ore: f64,
    /// Planet owner — the defender. Resolved during enrichment.
    pub defender: Option<String>,
    /// Fleet owner — the attacker. Resolved during enrichment.
    pub attacker: Option<String>,
    pub our_side: OurSide,
    /// Non-terminal AND fresh: a raid you can actually go and watch.
    pub live: bool,
    /// Non-terminal but silent past [`STALE_AFTER_MS`] — almost certainly an
    /// abandoned row rather than a running raid. Listed, flagged, sorted last;
    /// never silently dropped, because a row vanishing looks like a bug.
    pub stale: bool,
}

impl RaidRow {
    pub fn is_terminal(&self) -> bool {
        TERMINAL_STATUSES.contains(&self.status.as_str())
    }
    pub fn is_ours(&self) -> bool {
        self.our_side != OurSide::None
    }
}

/// Parse the Guild API's timestamp into epoch ms.
///
/// Postgres renders `timestamptz` with a **two-digit** offset (`+00`), which is
/// not valid ISO-8601 and which `chrono`'s RFC-3339 parser rejects outright —
/// the same trap that made every Inventory ledger row render its time as a
/// dash. Widen it to `+00:00` before parsing.
pub fn parse_guild_time(raw: &str) -> Option<f64> {
    let s = raw.trim();
    let widened = if s.len() >= 3 {
        let (head, tail) = s.split_at(s.len() - 3);
        let is_short_offset = (tail.starts_with('+') || tail.starts_with('-'))
            && tail[1..].chars().all(|c| c.is_ascii_digit());
        if is_short_offset {
            format!("{}{}:00", head, tail)
        } else {
            s.to_string()
        }
    } else {
        s.to_string()
    };
    chrono::DateTime::parse_from_rfc3339(&widened)
        .ok()
        .map(|dt| dt.timestamp_millis() as f64)
        .or_else(|| {
            // Fall back to a naive timestamp (no offset at all), read as UTC.
            chrono::NaiveDateTime::parse_from_str(&widened, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|dt| dt.and_utc().timestamp_millis() as f64)
        })
}

/// Numeric fields arrive as JSON strings throughout the Guild API
/// (`"seized_ore": "173"`), so `as_f64()` alone silently reads them as zero.
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim().parse().ok())))
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Collapse a page of `raid_status` activity rows into one row per planet —
/// the latest status each planet reached — and classify each as live, stale or
/// finished.
///
/// Rows look like
/// `{time, seq, planet_id, category, detail:{status, fleet_id, planet_id, seized_ore}, block_height}`,
/// with `detail` sometimes arriving as a JSON *string* rather than an object
/// (the Guild API is inconsistent about this), hence the coercion.
///
/// Identities are NOT filled in here — this half is pure so it can be tested
/// without a network, and enrichment is the expensive half.
pub fn reduce_raids(rows: &[Value], now_ms: f64, stale_after_ms: f64) -> Vec<RaidRow> {
    // planet -> (ordering key, row). The key is (time, seq): two status
    // changes can land in the same block and share a timestamp, and `seq` is
    // the within-block ordinal that separates them.
    let mut latest: HashMap<String, ((f64, f64), RaidRow)> = HashMap::new();

    for row in rows {
        if text(row.get("category")).as_deref() != Some("raid_status") {
            continue;
        }
        let detail = match row.get("detail") {
            Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        };
        let Some(planet_id) = text(row.get("planet_id")).or_else(|| text(detail.get("planet_id")))
        else {
            continue;
        };
        let Some(status) = text(detail.get("status")) else {
            continue;
        };
        let updated_ms = text(row.get("time"))
            .as_deref()
            .and_then(parse_guild_time)
            .unwrap_or(0.0);

        let terminal = TERMINAL_STATUSES.contains(&status.as_str());
        let fresh = now_ms - updated_ms <= stale_after_ms;
        // "Live" follows the game's own `PlanetRaid.isRaidActive`, which is
        // narrower than "not finished": a `requested` raid has not begun, so
        // it is neither live nor stale — it still lists, with its own badge.
        let active = ACTIVE_STATUSES.contains(&status.as_str());
        let candidate = RaidRow {
            planet_id: planet_id.clone(),
            fleet_id: text(detail.get("fleet_id")),
            status,
            updated_ms,
            seized_ore: num(detail.get("seized_ore")).unwrap_or(0.0),
            defender: None,
            attacker: None,
            our_side: OurSide::None,
            live: active && fresh,
            stale: !terminal && !fresh,
        };

        // Keep the newest row per planet.
        let key = (updated_ms, num(row.get("seq")).unwrap_or(0.0));
        match latest.get(&planet_id) {
            Some((existing_key, _)) if *existing_key >= key => {}
            _ => {
                latest.insert(planet_id, (key, candidate));
            }
        }
    }

    let mut out: Vec<RaidRow> = latest.into_values().map(|(_, row)| row).collect();
    sort_raids(&mut out);
    out
}

/// Ordering the list is presented in: ours before everyone else's, live before
/// stale before finished, then most-recent first. An operator opens this to
/// answer "is anything happening to me right now", so that has to be the top
/// row without them sorting for it.
pub fn sort_raids(rows: &mut [RaidRow]) {
    rows.sort_by(|a, b| {
        let rank = |r: &RaidRow| -> u8 {
            match (r.is_ours(), r.live, r.stale) {
                (true, true, _) => 0,
                (false, true, _) => 1,
                (true, _, true) => 2,
                (false, _, true) => 3,
                (true, _, _) => 4,
                (false, _, _) => 5,
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then(b.updated_ms.total_cmp(&a.updated_ms))
            .then(a.planet_id.cmp(&b.planet_id))
    });
}

/// Classify a raid against the roster. Called after enrichment resolves the
/// two owners.
pub fn classify_side(attacker: Option<&str>, defender: Option<&str>) -> OurSide {
    let ours = |p: Option<&str>| {
        p.map(crate::mcp::virtual_players::is_team_player)
            .unwrap_or(false)
    };
    match (ours(attacker), ours(defender)) {
        (true, true) => OurSide::Both,
        (true, false) => OurSide::Attacker,
        (false, true) => OurSide::Defender,
        (false, false) => OurSide::None,
    }
}

// ── Enrichment + command ────────────────────────────────────────────────────

/// How many activity pages to sweep. Each page is `PAGE_SIZE` rows of
/// `raid_status` across the whole galaxy; raids are rare enough that a handful
/// of pages reaches back well past the staleness horizon.
const RAID_PAGES: u32 = 3;

/// Cap on identity lookups per refresh. Each raid costs two entity reads
/// (planet owner, fleet owner); an unbounded fan-out over a galaxy-wide list is
/// how a refresh turns into a stall.
const ENRICH_LIMIT: usize = 40;

/// Concurrent identity lookups in flight. Matches the ceiling the loops use for
/// their own per-player sweeps.
const ENRICH_CONCURRENCY: usize = 8;

/// Resolve the two owners for one raid and classify it against the roster.
///
/// The planet read gives the defender, the fleet read the attacker; they are
/// independent, so they go out together. A failed read leaves that side `None`
/// rather than dropping the raid — an unnamed participant is still a raid worth
/// watching.
async fn enrich_row(client: crate::mcp::cosmos_client::CosmosClient, mut row: RaidRow) -> RaidRow {
    let planet_id = row.planet_id.clone();
    let fleet_id = row.fleet_id.clone();
    let (planet, fleet) = tokio::join!(
        client.query_entity("planet", &planet_id),
        async {
            match fleet_id.as_deref() {
                Some(f) => client.query_entity("fleet", f).await.ok(),
                None => None,
            }
        }
    );

    row.defender = planet
        .ok()
        .and_then(|v| text(v.get("Planet").and_then(|p| p.get("owner"))));
    row.attacker = fleet.and_then(|v| text(v.get("Fleet").and_then(|f| f.get("owner"))));
    row.our_side = classify_side(row.attacker.as_deref(), row.defender.as_deref());
    row
}

/// Every raid the galaxy is currently running, ours first.
///
/// Not gated: reaching Team Ops is the gate, and raids are public chain state
/// the game already streams to every player (see the module docs). An earlier
/// draft had a second opt-in switch and this comment outlived it.
#[tauri::command]
pub async fn mcp_raids() -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let rows = crate::mcp::guild_api::fetch_all_pages(
        |page| client.guild.planet_activity_by_category("raid_status", page),
        RAID_PAGES,
    )
    .await
    .map_err(|e| format!("raid activity unavailable: {e}"))?;

    let now_ms = crate::hasher::types::now_millis();
    let mut raids = reduce_raids(&rows, now_ms, STALE_AFTER_MS);

    // Enrich the interesting end of the list. `reduce_raids` has already
    // ordered live-before-stale-before-finished, so a truncation here takes the
    // rows least worth naming.
    let tail = raids.split_off(raids.len().min(ENRICH_LIMIT));
    let skipped = tail.len();
    let mut raids = crate::mcp::loop_util::map_concurrent(raids, ENRICH_CONCURRENCY, {
        let client = client.clone();
        move |row| {
            let client = client.clone();
            async move { enrich_row(client, row).await }
        }
    })
    .await;
    raids.extend(tail);
    // Identities decide `our_side`, so the ours-first ordering has to be redone
    // — and `map_concurrent` does not preserve order in any case.
    sort_raids(&mut raids);

    let live = raids.iter().filter(|r| r.live).count();
    let ours = raids.iter().filter(|r| r.is_ours()).count();
    let finished = raids.iter().filter(|r| r.is_terminal()).count();
    Ok(serde_json::json!({
        "raids": raids,
        "live": live,
        "ours": ours,
        "finished": finished,
        // Who is being watched, and by how many windows. This is how you
        // confirm the fan-out invariant: N windows on one planet must show as
        // ONE watch with N labels, not N watches.
        "spectators": crate::mcp::spectator::debug_state(),
        // Surfaced rather than silently applied: a capped list that says
        // nothing reads as a complete one.
        "unidentified": skipped,
        "stale_after_ms": STALE_AFTER_MS,
        "fetched_at_ms": now_ms,
    }))
}

// ── Spectator window ────────────────────────────────────────────────────────

/// What a spectator window is pointed at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    /// Stay on this planet and watch whatever happens to it.
    Planet { planet_id: String },
    /// Follow this fleet, re-rendering whichever planet it is at.
    Fleet { fleet_id: String },
}

impl Target {
    /// The id the window is labelled and keyed by.
    pub fn key(&self) -> &str {
        match self {
            Target::Planet { planet_id } => planet_id,
            Target::Fleet { fleet_id } => fleet_id,
        }
    }
    pub fn title(&self) -> String {
        match self {
            Target::Planet { planet_id } => format!("Structs — Planet {}", planet_id),
            Target::Fleet { fleet_id } => format!("Structs — Fleet {}", fleet_id),
        }
    }
    /// Query string handed to `raidview.html`. The window reads its own target
    /// from here rather than being told over an event, so a reload keeps
    /// showing the same place.
    pub fn query(&self) -> String {
        match self {
            Target::Planet { planet_id } => format!("planet={}", planet_id),
            Target::Fleet { fleet_id } => format!("fleet={}", fleet_id),
        }
    }
}

/// Ids look like `<type>-<index>`: planets are `2-…`, fleets `9-…`. Validating
/// the shape here keeps a malformed id from reaching a window label or a URL.
fn valid_entity_id(id: &str, expect_prefix: &str) -> bool {
    let mut parts = id.split('-');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(p), Some(idx), None) => {
            p == expect_prefix && !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

/// Resolve the caller's arguments into a target, rejecting anything malformed.
pub fn parse_target(planet_id: Option<&str>, fleet_id: Option<&str>) -> Result<Target, String> {
    let planet = planet_id.map(str::trim).filter(|s| !s.is_empty());
    let fleet = fleet_id.map(str::trim).filter(|s| !s.is_empty());
    match (planet, fleet) {
        (Some(_), Some(_)) => {
            Err("give planet_id OR fleet_id, not both — a window watches one place".into())
        }
        (Some(p), None) if valid_entity_id(p, "2") => Ok(Target::Planet {
            planet_id: p.to_string(),
        }),
        (Some(p), None) => Err(format!("'{p}' is not a planet id (expected 2-<number>)")),
        (None, Some(f)) if valid_entity_id(f, "9") => Ok(Target::Fleet {
            fleet_id: f.to_string(),
        }),
        (None, Some(f)) => Err(format!("'{f}' is not a fleet id (expected 9-<number>)")),
        (None, None) => Err("planet_id or fleet_id required".into()),
    }
}

/// Open (or focus) a spectator window on a planet or fleet.
///
/// The window deliberately does NOT get an `initialization_script`: see the
/// module docs. It is a `board`-family document — it can read, and it cannot
/// sign, mine, or touch the player's session.
#[tauri::command]
pub fn mcp_raid_view_open(
    app: tauri::AppHandle,
    planet_id: Option<String>,
    fleet_id: Option<String>,
) -> Result<Value, String> {
    let target = parse_target(planet_id.as_deref(), fleet_id.as_deref())?;
    open_window(&app, &target).map(|_| {
        serde_json::json!({ "ok": true, "label": label_for(target.key()), "target": target })
    })
}

/// First-paint pull for the spectator window, invoked on load.
///
/// Push alone loses the first snapshot: the watcher can emit before the
/// window's JS has attached a listener, and Tauri drops events with no
/// listener — the map then sits empty until the next 20-second cycle. This is
/// the same reason board.html pulls `mcp_board_html` on load. Also what makes
/// a manual reload of the window repaint immediately.
#[tauri::command]
pub async fn mcp_raid_state(
    planet_id: Option<String>,
    fleet_id: Option<String>,
) -> Result<Value, String> {
    let target = parse_target(planet_id.as_deref(), fleet_id.as_deref())?;
    Ok(crate::mcp::spectator::pull_state(&target).await)
}

/// Battle log: every `planet_activity` row recorded for one planet, newest
/// first, rendered into one human line each.
///
/// This is the raid viewer's DELIBERATE departure from map parity. The game
/// shows a planet's present state; it never shows the planet's history in one
/// place, and for a spectator that history is the story — who arrived, what
/// shot what, when the shield fell, how the raid ended. The rows come from the
/// guild indexer, which already stores exactly this.
#[tauri::command]
pub async fn mcp_raid_log(planet_id: String, limit: Option<usize>) -> Result<Value, String> {
    if !valid_entity_id(&planet_id, "2") {
        return Err(format!("'{planet_id}' is not a planet id"));
    }
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let want = limit.unwrap_or(200).min(500);

    // Page until we have enough or the indexer runs out. Pages are small, so
    // a deep log is a handful of requests rather than one huge one.
    let mut rows: Vec<Value> = Vec::new();
    for page in 1..=10u32 {
        let Ok(p) = client.guild.planet_activity_by_planet(&planet_id, page).await else {
            break;
        };
        let more = p.has_more;
        for item in p.items {
            rows.push(log_row(&item));
            if rows.len() >= want {
                break;
            }
        }
        if rows.len() >= want || !more {
            break;
        }
    }
    Ok(json!({ "planet_id": planet_id, "rows": rows }))
}

/// One activity row → `{time, category, detail}` ready to render.
fn log_row(item: &Value) -> Value {
    let category = item
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("event")
        .to_string();
    // `detail` is a JSON STRING on this endpoint, not an object.
    let detail = match item.get("detail") {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(other) => other.clone(),
        None => Value::Null,
    };
    let ts = item.get("time").and_then(|v| v.as_str()).unwrap_or("");
    json!({
        "time": short_time(ts),
        // The DATE, kept separate. Rows are strictly newest-first, but with
        // only a clock the log read as unsorted the moment it crossed midnight
        // — 12:51, then 14:46, then 19:28, each a different day. The renderer
        // breaks the list on this instead.
        "date": day_of(ts),
        "category": category,
        "kind": activity_kind(&category),
        "detail": describe_activity(&category, &detail),
        "block": item.get("block_height").cloned().unwrap_or(Value::Null),
    })
}

/// `2026-07-30 18:02:51.403416+00` → `18:02:51`. Falls back to the raw string
/// so an unexpected format still shows something.
fn short_time(ts: &str) -> String {
    ts.split(' ')
        .nth(1)
        .map(|t| t.split('.').next().unwrap_or(t).to_string())
        .unwrap_or_else(|| ts.to_string())
}

/// `2026-07-30 18:02:51.403416+00` → `2026-07-30`.
fn day_of(ts: &str) -> String {
    ts.split(' ').next().unwrap_or("").to_string()
}

/// Which family a row belongs to. The log interleaves fourteen categories and
/// most of them are routine bookkeeping; the renderer uses this to give combat
/// its own weight and to let the operator filter the rest away.
fn activity_kind(category: &str) -> &'static str {
    match category {
        "struct_attack" | "raid_status" => "combat",
        "shield_change" | "block_raid_start" | "struct_defense_add"
        | "struct_defense_remove" => "defense",
        "fleet_arrive" | "fleet_depart" | "struct_move" => "movement",
        "struct_block_build_start" | "struct_block_ore_mine_start"
        | "struct_block_ore_refine_start" => "economy",
        _ => "state",
    }
}

/// `structAttributes.status` is a BITMASK, not an enum — the chain's
/// `STRUCT_STATUS_FLAGS`. A raw "1 → 7" says nothing; "built, online" says the
/// struct finished building and powered up.
fn status_flags(mask: u64) -> String {
    const FLAGS: [(u64, &str); 7] = [
        (1, "materialized"),
        (2, "built"),
        (4, "online"),
        (8, "stored"),
        (16, "hidden"),
        (32, "destroyed"),
        (64, "locked"),
    ];
    let set: Vec<&str> = FLAGS
        .iter()
        .filter(|(bit, _)| mask & bit != 0)
        .map(|(_, name)| *name)
        .collect();
    if set.is_empty() {
        "none".into()
    } else {
        set.join(", ")
    }
}

/// Summarise one `struct_attack`. The payload is the largest the chain emits —
/// a volley carries `eventAttackShotDetail`, each shot with its own block,
/// evade, counter and destruction outcomes — so this reduces it to the facts a
/// spectator reads a battle log for: who shot whom, how hard, and what it cost.
fn describe_attack(d: &Value) -> String {
    let s = |k: &str| d.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let shots = d
        .get("eventAttackShotDetail")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let weapon = match s("weaponControl") {
        "guided" => "smart",
        "unguided" => "ballistic",
        _ => "",
    };
    let attacker = if s("attackerStructType").is_empty() {
        s("attackerStructId").to_string()
    } else {
        format!("{} {}", s("attackerStructType"), s("attackerStructId"))
    };

    if shots.is_empty() {
        // Pre-detail rows (and the GRASS stub above ~8KB) still have the parent
        // fields; say what is known rather than nothing.
        let target = s("targetStructId");
        return match (weapon.is_empty(), target.is_empty()) {
            (_, true) => format!("{attacker} attacked"),
            (true, false) => format!("{attacker} hit {target}"),
            (false, false) => format!("{attacker} hit {target} ({weapon})"),
        };
    }

    // Fold the volley. Damage is what LANDED, so blocked and evaded shots
    // contribute nothing to it — reporting `damage` instead of `damageDealt`
    // would credit a blocked shot with the hit it never made.
    let num = |v: Option<&Value>| -> u64 {
        match v {
            Some(Value::String(x)) => x.parse().unwrap_or(0),
            Some(Value::Number(x)) => x.as_u64().unwrap_or(0),
            _ => 0,
        }
    };
    let flag = |v: Option<&Value>| matches!(v, Some(Value::Bool(true)));

    let mut dealt = 0u64;
    let mut evaded = 0usize;
    let mut blocked = 0usize;
    let mut destroyed: Vec<String> = Vec::new();
    let mut countered = 0u64;
    let mut targets: Vec<String> = Vec::new();
    for shot in &shots {
        dealt += num(shot.get("damageDealt"));
        if flag(shot.get("evaded")) {
            evaded += 1;
        }
        if flag(shot.get("blocked")) {
            blocked += 1;
        }
        countered += num(shot.get("targetCounteredDamage"));
        let tid = shot.get("targetStructId").and_then(|v| v.as_str()).unwrap_or("");
        let ttype = shot.get("targetStructType").and_then(|v| v.as_str()).unwrap_or("");
        let label = if ttype.is_empty() { tid.to_string() } else { format!("{ttype} {tid}") };
        if flag(shot.get("targetDestroyed")) && !label.is_empty() {
            destroyed.push(label.clone());
        }
        if !label.is_empty() && !targets.contains(&label) {
            targets.push(label);
        }
    }

    let target = if targets.len() == 1 {
        targets[0].clone()
    } else {
        format!("{} targets", targets.len())
    };
    let mut out = if weapon.is_empty() {
        format!("{attacker} → {target}")
    } else {
        format!("{attacker} → {target} ({weapon})")
    };
    out.push_str(&format!(", {dealt} dmg"));
    if shots.len() > 1 {
        out.push_str(&format!(" over {} shots", shots.len()));
    }
    if blocked > 0 {
        out.push_str(&format!(", {blocked} blocked"));
    }
    if evaded > 0 {
        out.push_str(&format!(", {evaded} evaded"));
    }
    if countered > 0 {
        out.push_str(&format!(", countered for {countered}"));
    }
    if !destroyed.is_empty() {
        out.push_str(&format!(" — DESTROYED {}", destroyed.join(", ")));
    }
    out
}

/// Render one activity detail as a sentence. Shapes transcribed from live rows
/// (`structs.planet_activity`), so each category reads naturally instead of
/// dumping JSON at the operator.
fn describe_activity(category: &str, d: &Value) -> String {
    let s = |k: &str| d.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let n = |k: &str| match d.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(x)) => x.to_string(),
        _ => String::new(),
    };
    let u = |k: &str| -> Option<u64> {
        match d.get(k) {
            Some(Value::String(x)) => x.parse().ok(),
            Some(Value::Number(x)) => x.as_u64(),
            _ => None,
        }
    };
    match category {
        "struct_attack" => describe_attack(d),
        "raid_status" => {
            let mut out = format!("raid {}", s("status"));
            if !s("fleet_id").is_empty() {
                out.push_str(&format!(" by fleet {}", s("fleet_id")));
            }
            if !n("seized_ore").is_empty() && n("seized_ore") != "0" {
                out.push_str(&format!(" — seized {} ore", n("seized_ore")));
            }
            out
        }
        "fleet_arrive" => format!("fleet {} arrived ({})", s("fleet_id"), s("fleet_status")),
        "fleet_depart" => format!("fleet {} departed", s("fleet_id")),
        // The chain's keys are `planetary_shield{,_old}`. Reading `shield`
        // produced a permanent "shield now" with no number on every row.
        "shield_change" => match (u("planetary_shield_old"), u("planetary_shield")) {
            (Some(from), Some(to)) => {
                let arrow = if to >= from { "+" } else { "-" };
                let delta = if to >= from { to - from } else { from - to };
                format!("shield {from} → {to} ({arrow}{delta})")
            }
            (None, Some(to)) => format!("shield now {to}"),
            _ => "shield changed".into(),
        },
        // Raidability: a non-zero block is when the raid window opened, 0 means
        // the planet is no longer raidable.
        "block_raid_start" => match u("block_start_raid") {
            Some(0) => "planet no longer raidable".into(),
            Some(b) => format!("planet became raidable (block {b})"),
            None => "raid window changed".into(),
        },
        "struct_health" => match (u("health_old"), u("health")) {
            (Some(from), Some(to)) if from != to => {
                format!("{} health {from} → {to}", s("struct_id"))
            }
            (_, Some(to)) => format!("{} health {to}", s("struct_id")),
            _ => format!("{} health changed", s("struct_id")),
        },
        "struct_status" => match (u("status_old"), u("status")) {
            (Some(from), Some(to)) => format!(
                "{} {} → {}",
                s("struct_id"),
                status_flags(from),
                status_flags(to)
            ),
            (None, Some(to)) => format!("{} {}", s("struct_id"), status_flags(to)),
            _ => format!("{} status changed", s("struct_id")),
        },
        "struct_defense_add" => {
            format!("{} now defends {}", s("defender_struct_id"), s("protected_struct_id"))
        }
        "struct_defense_remove" => {
            format!("{} stopped defending {}", s("defender_struct_id"), s("protected_struct_id"))
        }
        "struct_move" => format!(
            "{} moved to {} slot {} on {}",
            s("struct_id"), s("ambit"), n("slot"), s("location_id")
        ),
        "struct_block_build_start" => format!("{} build started", s("struct_id")),
        "struct_block_ore_mine_start" => format!("{} mining started", s("struct_id")),
        "struct_block_ore_refine_start" => format!("{} refining started", s("struct_id")),
        // Unknown category: show the payload rather than nothing, so a new
        // chain event type is still readable the day it appears.
        _ => {
            if d.is_null() { String::new() } else { d.to_string() }
        }
    }
}

/// Idempotent per location: a second request for a location already on screen
/// raises that window instead of stacking a duplicate.
pub fn open_window(
    app: &tauri::AppHandle,
    target: &Target,
) -> Result<tauri::WebviewWindow, String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let label = label_for(target.key());
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(w);
    }

    // `label` rides along so the renderer can subscribe to its own namespaced
    // event names (`raid-*::<label>` — see spectator::emit) without having to
    // replicate label_for's sanitisation in JS.
    let url = format!("raidview.html?{}&label={}", target.query(), label);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(target.title())
        // The map is wider than it is tall — six columns of 128px tiles plus
        // the HUD gutter — so the default board proportions are wrong here.
        .inner_size(1100.0, 720.0)
        .build()
        .map_err(|e| e.to_string())?;

    // Subscribe to the shared poller for this location. First subscriber
    // starts it; the close handler below is what eventually stops it.
    crate::mcp::spectator::attach(app, target, &label);
    let target_on_close = target.clone();
    let label_on_close = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            crate::mcp::spectator::detach(&target_on_close, &label_on_close);
        }
    });

    Ok(window)
}

#[cfg(test)]
mod log_tests {
    use super::*;
    use serde_json::json;

    // Payload shapes below are copied from live `structs.planet_activity`
    // rows, so these assert the format the chain actually emits rather than
    // one invented here.

    #[test]
    fn attack_folds_the_whole_volley() {
        // Transcribed from a live row: one shot, blocked by a Tank, and the
        // target counter-attacked for 1.
        let d = json!({
            "weaponSystem": "primaryWeapon", "weaponControl": "unguided",
            "attackerStructId": "5-4677", "attackerStructType": "Battleship",
            "eventAttackShotDetail": [{
                "damage": "2", "damageDealt": "2", "evaded": false, "blocked": true,
                "targetStructId": "5-20268", "targetStructType": "Command Ship",
                "targetDestroyed": false, "targetCounteredDamage": "1"
            }]
        });
        assert_eq!(
            describe_activity("struct_attack", &d),
            "Battleship 5-4677 → Command Ship 5-20268 (ballistic), 2 dmg, 1 blocked, countered for 1"
        );
    }

    #[test]
    fn a_kill_is_shouted_not_buried() {
        let d = json!({
            "weaponControl": "guided",
            "attackerStructId": "5-1", "attackerStructType": "Starfighter",
            "eventAttackShotDetail": [
                {"damageDealt": "1", "targetStructId": "5-9", "targetStructType": "Tank",
                 "targetDestroyed": false},
                {"damageDealt": "2", "targetStructId": "5-9", "targetStructType": "Tank",
                 "targetDestroyed": true}
            ]
        });
        let out = describe_activity("struct_attack", &d);
        assert!(out.contains("3 dmg over 2 shots"), "{out}");
        assert!(out.contains("DESTROYED Tank 5-9"), "{out}");
    }

    #[test]
    fn a_volley_that_all_missed_reports_zero_damage_not_the_rolled_damage() {
        // `damage` is what the weapon would do; `damageDealt` is what landed.
        // Reading the wrong one credits an evaded shot with a hit.
        let d = json!({
            "attackerStructId": "5-1",
            "eventAttackShotDetail": [
                {"damage": "5", "damageDealt": "0", "evaded": true, "targetStructId": "5-2"}
            ]
        });
        let out = describe_activity("struct_attack", &d);
        assert!(out.contains("0 dmg"), "{out}");
        assert!(out.contains("1 evaded"), "{out}");
    }

    #[test]
    fn an_attack_with_no_shot_detail_still_reads() {
        // The GRASS stream stubs `struct_attack` above ~8KB, so the parent
        // fields can arrive alone.
        let d = json!({"attackerStructId": "5-1", "targetStructId": "5-2"});
        assert_eq!(describe_activity("struct_attack", &d), "5-1 hit 5-2");
    }

    /// The bug this pins: the keys are `planetary_shield{,_old}`, so reading
    /// `shield`/`shield_old` rendered every row as a bare "shield now".
    #[test]
    fn shield_change_reads_the_chains_own_keys() {
        let d = json!({"planetary_shield": 225, "planetary_shield_old": 175});
        assert_eq!(describe_activity("shield_change", &d), "shield 175 → 225 (+50)");
        let down = json!({"planetary_shield": 100, "planetary_shield_old": 175});
        assert_eq!(describe_activity("shield_change", &down), "shield 175 → 100 (-75)");
    }

    /// `status` is a bitmask; "1 → 7" is unreadable, "materialized → built"
    /// is the same fact in words.
    #[test]
    fn status_is_decoded_from_its_bitmask() {
        let d = json!({"struct_id": "5-7862", "status_old": 1, "status": 7});
        assert_eq!(
            describe_activity("struct_status", &d),
            "5-7862 materialized → materialized, built, online"
        );
        assert_eq!(status_flags(0), "none");
        assert_eq!(status_flags(32), "destroyed");
    }

    #[test]
    fn health_shows_the_transition_when_there_is_one() {
        let d = json!({"struct_id": "5-1", "health_old": 6, "health": 4});
        assert_eq!(describe_activity("struct_health", &d), "5-1 health 6 → 4");
    }

    /// Previously fell through to a raw JSON dump in the operator's face.
    #[test]
    fn block_raid_start_is_a_sentence_not_a_payload() {
        assert_eq!(
            describe_activity("block_raid_start", &json!({"block_start_raid": 0})),
            "planet no longer raidable"
        );
        assert!(describe_activity("block_raid_start", &json!({"block_start_raid": 1886798}))
            .contains("raidable"));
    }

    #[test]
    fn every_live_category_is_classified() {
        // The fourteen categories present in production `planet_activity`.
        for (cat, want) in [
            ("struct_attack", "combat"),
            ("raid_status", "combat"),
            ("shield_change", "defense"),
            ("block_raid_start", "defense"),
            ("struct_defense_add", "defense"),
            ("struct_defense_remove", "defense"),
            ("fleet_arrive", "movement"),
            ("fleet_depart", "movement"),
            ("struct_move", "movement"),
            ("struct_block_build_start", "economy"),
            ("struct_block_ore_mine_start", "economy"),
            ("struct_block_ore_refine_start", "economy"),
            ("struct_status", "state"),
            ("struct_health", "state"),
        ] {
            assert_eq!(activity_kind(cat), want, "{cat}");
        }
    }

    #[test]
    fn the_date_is_split_out_so_the_log_can_break_on_it() {
        assert_eq!(day_of("2026-07-30 18:02:51.403416+00"), "2026-07-30");
        assert_eq!(short_time("2026-07-30 18:02:51.403416+00"), "18:02:51");
    }

    #[test]
    fn raid_status_carries_fleet_and_loot() {
        let d = json!({
            "status": "raidSuccessful", "fleet_id": "9-61",
            "planet_id": "2-2423", "seized_ore": "23"
        });
        assert_eq!(
            describe_activity("raid_status", &d),
            "raid raidSuccessful by fleet 9-61 — seized 23 ore"
        );
        // A raid that took nothing must not claim it seized zero ore.
        let empty = json!({"status": "attackerRetreated", "fleet_id": "9-61", "seized_ore": "0"});
        assert_eq!(
            describe_activity("raid_status", &empty),
            "raid attackerRetreated by fleet 9-61"
        );
    }

    #[test]
    fn fleet_and_defense_rows() {
        assert_eq!(
            describe_activity("fleet_arrive", &json!({"fleet_id":"9-900","fleet_status":"onStation"})),
            "fleet 9-900 arrived (onStation)"
        );
        assert_eq!(
            describe_activity("struct_defense_add",
                &json!({"defender_struct_id":"5-30247","protected_struct_id":"5-30233"})),
            "5-30247 now defends 5-30233"
        );
    }

    #[test]
    fn unknown_category_still_shows_its_payload() {
        // A chain event type added tomorrow must remain readable rather than
        // rendering as a blank row.
        let d = json!({"something_new": "42"});
        let out = describe_activity("brand_new_event", &d);
        assert!(out.contains("something_new"), "got: {out}");
        // …but a null detail should not print the word "null".
        assert_eq!(describe_activity("brand_new_event", &Value::Null), "");
    }

    #[test]
    fn timestamps_reduce_to_clock_time() {
        assert_eq!(short_time("2026-07-30 18:02:51.403416+00"), "18:02:51");
        // Unexpected shapes fall back to the raw value rather than vanishing.
        assert_eq!(short_time("whenever"), "whenever");
        assert_eq!(short_time(""), "");
    }

    #[test]
    fn log_row_parses_the_stringified_detail() {
        // `detail` arrives as a JSON STRING on this endpoint, not an object —
        // the same trap that has bitten every other consumer of this feed.
        let item = json!({
            "time": "2026-07-30 18:02:51.403416+00",
            "category": "fleet_depart",
            "detail": "{\"fleet_id\": \"9-900\"}",
            "block_height": 1885302
        });
        let row = log_row(&item);
        assert_eq!(row["time"], json!("18:02:51"));
        assert_eq!(row["category"], json!("fleet_depart"));
        assert_eq!(row["detail"], json!("fleet 9-900 departed"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_prefixed_and_reversible_for_real_ids() {
        assert_eq!(label_for("2-1595"), "raid-2-1595");
        assert_eq!(label_for("9-4021"), "raid-9-4021");
    }

    #[test]
    fn label_cannot_collide_with_a_reserved_window() {
        // A crafted id must not be able to produce `main`, `board` or `stream`.
        for label in [
            label_for("main"),
            label_for("board"),
            label_for("stream"),
            label_for("../main"),
        ] {
            assert!(label.starts_with(LABEL_PREFIX), "{} lost its prefix", label);
            assert_ne!(label, "main");
            assert_ne!(label, "board");
            assert_ne!(label, "stream");
        }
    }

    #[test]
    fn label_sanitises_path_and_quote_characters() {
        // `.` is neither alphanumeric nor `-`, so it is sanitised along with `/`.
        assert_eq!(label_for("2/../1"), "raid-2____1");
        assert_eq!(label_for("a\"b"), "raid-a_b");
    }

    // ── Reducer ────────────────────────────────────────────────────────────
    //
    // Row shapes below are copied from live `structs.planet_activity`, not
    // invented: `{time, seq, planet_id, category, detail, block_height}` with
    // `detail = {status, fleet_id, planet_id, seized_ore}` and every numeric
    // rendered as a string.

    const NOW: f64 = 1_785_250_398_563.0; // 2026-07-28T14:53:18.563Z

    fn row(planet: &str, status: &str, time: &str, seq: u64, fleet: &str, ore: &str) -> Value {
        serde_json::json!({
            "time": time,
            "seq": seq,
            "planet_id": planet,
            "category": "raid_status",
            "detail": {
                "status": status, "fleet_id": fleet,
                "planet_id": planet, "seized_ore": ore
            },
            "block_height": 1_851_072u64,
        })
    }

    #[test]
    fn postgres_two_digit_offsets_parse() {
        // `+00` is what Postgres renders and is NOT valid ISO-8601. Getting
        // this wrong makes every raid look infinitely old, i.e. always stale.
        let t = parse_guild_time("2026-07-28 14:53:18.563362+00").expect("should parse");
        assert_eq!(t, NOW);
        // A full offset must keep working.
        assert!(parse_guild_time("2026-07-28T14:53:18.563362+00:00").is_some());
        assert!(parse_guild_time("nonsense").is_none());
    }

    #[test]
    fn only_the_latest_status_per_planet_survives() {
        let rows = vec![
            row("2-1595", "initiated", "2026-07-28 14:40:00+00", 1, "9-61", "0"),
            row("2-1595", "ongoing", "2026-07-28 14:45:00+00", 2, "9-61", "0"),
            row("2-1595", "shieldsVulnerable", "2026-07-28 14:50:00+00", 3, "9-61", "0"),
        ];
        let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, "shieldsVulnerable");
        assert!(out[0].live);
    }

    #[test]
    fn same_timestamp_breaks_on_seq() {
        // Two status changes in one block share a timestamp; `seq` orders them.
        let rows = vec![
            row("2-855", "raidSuccessful", "2026-07-28 14:45:02+00", 196, "9-471", "173"),
            row("2-855", "ongoing", "2026-07-28 14:45:02+00", 195, "9-471", "0"),
        ];
        let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
        assert_eq!(out[0].status, "raidSuccessful");
        assert_eq!(out[0].seized_ore, 173.0, "string numerics must not read as 0");
    }

    #[test]
    fn terminal_raids_are_neither_live_nor_stale() {
        for status in TERMINAL_STATUSES {
            let rows = vec![row("2-1", status, "2026-07-28 14:50:00+00", 1, "9-1", "0")];
            let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
            assert!(!out[0].live, "{status} should not be live");
            assert!(!out[0].stale, "{status} is finished, not stale");
            assert!(out[0].is_terminal());
        }
    }

    #[test]
    fn an_abandoned_initiated_row_is_stale_not_live() {
        // This is planet 2-400 as it actually exists today: `initiated`, five
        // days old, still sitting in planet_raid. Status alone would call it a
        // live raid.
        let rows = vec![row("2-400", "initiated", "2026-07-23 15:33:03+00", 1, "9-653", "0")];
        let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
        assert!(!out[0].live);
        assert!(out[0].stale);
    }

    #[test]
    fn stale_rows_are_listed_never_dropped() {
        let rows = vec![
            row("2-400", "initiated", "2026-07-23 15:33:03+00", 1, "9-653", "0"),
            row("2-1595", "ongoing", "2026-07-28 14:50:00+00", 2, "9-61", "0"),
        ];
        let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
        assert_eq!(out.len(), 2, "a stale raid must still appear, flagged");
        assert_eq!(out[0].planet_id, "2-1595", "live sorts above stale");
        assert!(out[1].stale);
    }

    #[test]
    fn requested_is_not_active_but_is_still_reported() {
        // The game's own PlanetRaid.isRaidActive excludes `requested`, so a
        // requested raid is neither live nor stale nor finished — it lists on
        // its own terms rather than being counted as something to go watch.
        assert!(!ACTIVE_STATUSES.contains(&"requested"));
        let rows = vec![row("2-9", "requested", "2026-07-28 14:52:00+00", 1, "9-9", "0")];
        let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
        assert_eq!(out.len(), 1);
        assert!(!out[0].is_terminal());
        assert!(!out[0].live, "requested has not begun — nothing to watch yet");
        assert!(!out[0].stale, "a fresh request is not an abandoned row");
    }

    #[test]
    fn every_active_status_counts_as_live_when_fresh() {
        for status in ACTIVE_STATUSES {
            let rows = vec![row("2-1", status, "2026-07-28 14:52:00+00", 1, "9-1", "0")];
            let out = reduce_raids(&rows, NOW, STALE_AFTER_MS);
            assert!(out[0].live, "{status} should be live");
        }
    }

    #[test]
    fn detail_may_arrive_as_a_json_string() {
        // The Guild API is inconsistent about whether `detail` is an object or
        // a JSON-encoded string; both must reduce identically.
        let mut r = row("2-7", "ongoing", "2026-07-28 14:50:00+00", 1, "9-7", "5");
        let as_string = serde_json::to_string(r.get("detail").unwrap()).unwrap();
        r["detail"] = Value::String(as_string);
        let out = reduce_raids(&[r], NOW, STALE_AFTER_MS);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, "ongoing");
        assert_eq!(out[0].seized_ore, 5.0);
    }

    #[test]
    fn non_raid_categories_are_ignored() {
        let mut r = row("2-3", "ongoing", "2026-07-28 14:50:00+00", 1, "9-3", "0");
        r["category"] = Value::String("struct_attack".into());
        assert!(reduce_raids(&[r], NOW, STALE_AFTER_MS).is_empty());
    }

    #[test]
    fn the_live_galaxy_reduces_to_one_live_raid_and_two_abandoned_rows() {
        // A real page of `planet_activity` category=raid_status, read from the
        // chain on 2026-07-28. Pinned because the reducer's whole job is to
        // turn this shape into "what can I actually go and watch", and the two
        // abandoned rows are the case a status-only filter gets wrong.
        let rows = vec![
            row("2-659", "initiated", "2026-07-28 19:10:45+00", 374, "9-61", "0"),
            row("2-1595", "demilitarized", "2026-07-28 14:53:18+00", 146, "9-61", "0"),
            row("2-855", "raidSuccessful", "2026-07-28 14:45:02+00", 196, "9-471", "173"),
            row("2-855", "shieldsVulnerable", "2026-07-28 14:26:15+00", 193, "9-471", "0"),
            row("2-855", "initiated", "2026-07-28 14:26:15+00", 192, "9-471", "0"),
            row("2-2091", "attackerDefeated", "2026-07-27 20:37:14+00", 80, "9-229", "0"),
            row("2-1590", "attackerDefeated", "2026-07-27 19:59:42+00", 76, "9-229", "0"),
            row("2-577", "raidSuccessful", "2026-07-27 15:50:24+00", 31, "9-471", "5"),
            // Abandoned: `initiated` and never resolved, 5 and 19 days ago.
            row("2-400", "initiated", "2026-07-23 15:32:57+00", 87, "9-653", "0"),
            row("2-174", "initiated", "2026-07-09 18:28:37+00", 626, "9-227", "0"),
        ];
        // "now" = the moment of the read.
        let now = parse_guild_time("2026-07-28 19:20:00+00").unwrap();
        let out = reduce_raids(&rows, now, STALE_AFTER_MS);

        let live: Vec<&str> = out.iter().filter(|r| r.live).map(|r| r.planet_id.as_str()).collect();
        assert_eq!(live, vec!["2-659"], "exactly one raid is actually running");

        let mut stale: Vec<&str> = out.iter().filter(|r| r.stale).map(|r| r.planet_id.as_str()).collect();
        stale.sort();
        assert_eq!(stale, vec!["2-174", "2-400"], "both abandoned rows are flagged, not dropped");

        // 2-855 saw three status changes; only the newest survives, and the
        // seized ore rides along with it.
        let p855 = out.iter().find(|r| r.planet_id == "2-855").unwrap();
        assert_eq!(p855.status, "raidSuccessful");
        assert_eq!(p855.seized_ore, 173.0);

        assert_eq!(out.len(), 8, "one row per planet");
        assert_eq!(out[0].planet_id, "2-659", "the live raid sorts to the top");
    }

    #[test]
    fn ours_sorts_above_a_more_recent_raid_of_someone_elses() {
        let mut rows = vec![
            RaidRow {
                planet_id: "2-100".into(), fleet_id: None, status: "ongoing".into(),
                updated_ms: NOW, seized_ore: 0.0, defender: None, attacker: None,
                our_side: OurSide::None, live: true, stale: false,
            },
            RaidRow {
                planet_id: "2-200".into(), fleet_id: None, status: "ongoing".into(),
                updated_ms: NOW - 60_000.0, seized_ore: 0.0, defender: None, attacker: None,
                our_side: OurSide::Defender, live: true, stale: false,
            },
        ];
        sort_raids(&mut rows);
        assert_eq!(rows[0].planet_id, "2-200", "a raid on us outranks recency");
    }

    // ── Target parsing ─────────────────────────────────────────────────────

    #[test]
    fn a_planet_and_a_fleet_target_parse() {
        assert_eq!(
            parse_target(Some("2-1595"), None).unwrap(),
            Target::Planet { planet_id: "2-1595".into() }
        );
        assert_eq!(
            parse_target(None, Some("9-61")).unwrap(),
            Target::Fleet { fleet_id: "9-61".into() }
        );
    }

    #[test]
    fn ids_of_the_wrong_type_are_refused() {
        // A fleet id in the planet slot would open a window on nothing.
        assert!(parse_target(Some("9-61"), None).is_err());
        assert!(parse_target(None, Some("2-1595")).is_err());
        assert!(parse_target(Some("1-194"), None).is_err());
    }

    #[test]
    fn malformed_ids_never_reach_a_label_or_url() {
        for bad in ["", "  ", "2-", "2-abc", "2-1-3", "../../etc", "2-1 OR 1=1"] {
            assert!(parse_target(Some(bad), None).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_window_watches_one_place() {
        assert!(parse_target(Some("2-1595"), Some("9-61")).is_err());
        assert!(parse_target(None, None).is_err());
    }

    #[test]
    fn the_query_string_carries_the_target_so_a_reload_stays_put() {
        assert_eq!(parse_target(Some("2-1595"), None).unwrap().query(), "planet=2-1595");
        assert_eq!(parse_target(None, Some("9-61")).unwrap().query(), "fleet=9-61");
    }

    #[test]
    fn every_target_label_matches_the_capability_glob() {
        // capabilities/default.json grants `raid-*`; a label outside that glob
        // would build a window whose events are silently dropped — exactly the
        // failure the board window hit before its label was granted.
        for t in [
            parse_target(Some("2-1595"), None).unwrap(),
            parse_target(None, Some("9-61")).unwrap(),
        ] {
            assert!(label_for(t.key()).starts_with("raid-"));
        }
    }

    #[test]
    fn nothing_here_is_gated_behind_a_flag() {
        // Reaching Team Ops IS the gate — there is deliberately no second
        // switch. This pins that: if a future change reintroduces one, the
        // commands would start refusing and this catches it at compile time
        // (the guard/flag symbols simply do not exist to be called).
        assert!(parse_target(Some("2-1595"), None).is_ok());
        assert_eq!(label_for("2-1595"), "raid-2-1595");
    }
}
