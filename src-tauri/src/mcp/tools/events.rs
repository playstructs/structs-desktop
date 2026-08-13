//! `structs_events` — the event feed. Exposes the NATS-fed event buffer to the
//! agent so it can react to incoming attacks / arrivals / completions instead of
//! babysitting with sleep timers. rmcp 0.15 has no server push, so a `wait_secs`
//! long-poll approximates a live feed: the call blocks until a new event lands
//! (after the `since` cursor) or the wait elapses.
//!
//! `threats_only` turns the feed into a SENTINEL: a server-side classifier scores
//! each of-mine event as a threat (raid armed / struct lost / taking damage /
//! hostile inbound / shield drop) and the long-poll blocks until an actual threat
//! appears. `team:true` widens detection from the primary player to the WHOLE
//! team (primary + every virtual player), so one sentinel watches the bait fleet.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crate::game_state::GAME_STATE;
use crate::mcp::event_buffer::{self, GameEvent};

#[derive(Debug, Deserialize)]
pub struct EventParams {
    /// Only return events strictly newer than this timestamp (ms). Use the
    /// `next_cursor` from the previous call to page forward.
    #[serde(default)]
    pub since: Option<f64>,
    /// Filter to a single category (e.g. "struct_attack", "raid_status").
    #[serde(default)]
    pub category: Option<String>,
    /// Only events whose subject references one of your entities (player/planet/fleet).
    #[serde(default)]
    pub mine_only: bool,
    /// Sentinel mode: classify each of-your events as a threat and return ONLY
    /// threats (raid_armed / struct_lost / taking_damage / hostile_inbound /
    /// shield_drop), highest-priority first. With `wait_secs`, the call blocks
    /// until a real threat lands — a ready-made under-attack detector.
    #[serde(default)]
    pub threats_only: bool,
    /// Widen mine_only / threats_only from just the primary player to the WHOLE
    /// team — the primary plus every virtual player (their planets/fleets) — so a
    /// single sentinel covers the bait fleet. Threats are tagged with which player.
    #[serde(default)]
    pub team: bool,
    /// Max events to return (default 30).
    #[serde(default)]
    pub limit: Option<usize>,
    /// Long-poll: wait up to this many seconds for a new event before returning
    /// (clamped 0–55). 0 = return immediately with whatever's buffered.
    #[serde(default)]
    pub wait_secs: Option<u64>,
}

/// A classified incoming threat to one of the team's own assets, ordered by how
/// urgently it demands a response.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Threat {
    RaidArmed,
    StructLost,
    TakingDamage,
    HostileInbound,
    ShieldDrop,
}

impl Threat {
    pub fn priority(self) -> u8 {
        match self {
            Threat::RaidArmed => 5,
            Threat::StructLost => 4,
            Threat::TakingDamage => 3,
            Threat::HostileInbound => 2,
            Threat::ShieldDrop => 1,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Threat::RaidArmed => "🚨 RAID ARMED — Command Ship vulnerable; stored ore can be seized",
            Threat::StructLost => "💥 STRUCT DESTROYED",
            Threat::TakingDamage => "🔥 TAKING DAMAGE",
            Threat::HostileInbound => "⚠ HOSTILE FLEET INBOUND",
            Threat::ShieldDrop => "🛡 PLANETARY SHIELD DROPPING",
        }
    }
}

/// The set of on-chain entities the caller "owns" — the primary player and,
/// when `team`, every virtual player. Threat classification + the mine-only
/// filter both run against these.
#[derive(Default)]
pub struct Owned {
    pub players: HashSet<String>,
    pub planets: HashSet<String>,
    pub fleets: HashSet<String>,
    pub structs: HashSet<String>,
    /// All ids flattened into one set, for O(1) exact membership tests against
    /// an event's tokens.
    flat: HashSet<String>,
    /// planet id -> owner label (vplayer name, or "you" for the primary).
    pub label_by_planet: HashMap<String, String>,
    /// planet id -> owning player id. Only that player's own fleet is
    /// co-located with an attacker at that planet, so this is who can shoot back.
    pub player_by_planet: HashMap<String, String>,
    pub primary_planet: String,
}

impl Owned {
    /// Which of our planets does this event concern, if any? The response loop
    /// needs the planet to pull the authoritative attack record from the Guild
    /// API (GRASS stubs any real fight).
    ///
    /// The subject's own planet segment wins over a detail reference: an event
    /// keyed to planet A can name planet B in its payload, and only A is where
    /// the thing actually happened.
    pub fn planet_for(&self, e: &GameEvent) -> Option<String> {
        if let Some(p) = subject_planet(&e.subject) {
            if self.planets.contains(p) {
                return Some(p.to_string());
            }
        }
        event_tokens(e)
            .into_iter()
            .find(|t| !t.is_empty() && self.planets.contains(*t))
            .map(|t| t.to_string())
    }
    fn refresh_flat(&mut self) {
        let mut flat: HashSet<String> = HashSet::new();
        flat.extend(self.players.iter().cloned());
        flat.extend(self.planets.iter().cloned());
        flat.extend(self.fleets.iter().cloned());
        flat.extend(self.structs.iter().cloned());
        flat.retain(|s| !s.is_empty());
        self.flat = flat;
    }
    /// Does this event reference any owned entity at all? Backs `mine_only`.
    fn refs_any(&self, e: &GameEvent) -> bool {
        event_tokens(e).into_iter().any(|t| self.flat.contains(t))
    }
    /// Which owner a threat event belongs to (for tagging in team mode).
    ///
    /// Subject first, for the same reason as `planet_for` — and because two
    /// owned planets matching one event would otherwise let the HashMap's
    /// arbitrary iteration order pick the name.
    fn label_for(&self, e: &GameEvent) -> String {
        if let Some(p) = subject_planet(&e.subject) {
            if let Some(name) = self.label_by_planet.get(p) {
                return name.clone();
            }
        }
        for t in event_tokens(e) {
            if let Some(name) = self.label_by_planet.get(t) {
                return name.clone();
            }
        }
        "you".to_string()
    }
}

/// Does this subject name `id` as a whole segment?
///
/// Grass subjects are dot-delimited (`structs.planet.2-4228.1-750`), so an id is
/// always a complete segment — never part of one. Shared with the callers outside
/// this module that were doing `subject.contains(id)`.
pub fn subject_names(subject: &str, id: &str) -> bool {
    !id.is_empty() && subject.split('.').any(|s| s == id)
}

/// The planet id a subject is keyed to, if any. Both `structs.planet.<pid>.<player>`
/// and `structs.grid.planet.<pid>.<player>` name it in the segment right after
/// the literal `planet`.
fn subject_planet(subject: &str) -> Option<&str> {
    let mut it = subject.split('.');
    while let Some(s) = it.next() {
        if s == "planet" {
            return it.next();
        }
    }
    None
}

/// Every id-shaped token an event carries: its dot-delimited subject segments
/// plus every string value in the detail (ids are always JSON strings in grass
/// payloads).
///
/// This exists so ownership tests are EXACT. The previous `subject.contains(id)`
/// matched any id that was a prefix of a longer one — ids are dense integers, so
/// owning `2-422` claimed every event on `2-4220`..`2-4229`, and owning `1-61`
/// claimed `1-611`. On the live guild that was 80 foreign planets reading as ours.
fn event_tokens(e: &GameEvent) -> Vec<&str> {
    let mut out: Vec<&str> = e.subject.split('.').collect();
    collect_strs(&e.detail, &mut out);
    out
}

fn collect_strs<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s.as_str()),
        Value::Array(a) => a.iter().for_each(|x| collect_strs(x, out)),
        Value::Object(m) => m.values().for_each(|x| collect_strs(x, out)),
        _ => {}
    }
}

/// Does this event name any id in `set`? Exact, whole-token matches only.
fn refs_set(e: &GameEvent, set: &HashSet<String>) -> bool {
    event_tokens(e).into_iter().any(|t| set.contains(t))
}

/// Raid statuses that mean the raid is OVER. `category.contains("raid")` fires on
/// every `raid_status` transition, so without this the alarm that says "ore can be
/// seized" also rings on the message announcing the raid ended.
const RAID_TERMINAL: &[&str] = &[
    "raidSuccessful",
    "attackerDefeated",
    "attackerRetreated",
    "demilitarized",
];

/// How far either side of a destruction to look for the departure that explains
/// it. Same-block events share a chain timestamp and arrive milliseconds apart;
/// this is slack for ingest jitter, not a real time window.
const RELOCATE_WINDOW_MS: f64 = 30_000.0;

/// Was this planet's carnage self-inflicted?
///
/// `explore` relocates a player to a new planet and destroys everything left on
/// the old one — which reaches us as exactly the `struct_status` bit-32 burst and
/// shield collapse an enemy would produce. 33 of the team's own vplayers
/// relocated in one hour on the live guild, paging "19 structs destroyed" each
/// time.
///
/// The tell is in the same block on the same planet: a `fleet_depart` for a fleet
/// WE own carrying `fleet_status: onStation` — the planet's own garrison leaving
/// home. A raider departing a victim's planet is `away`, and an enemy killing our
/// structs departs nothing at all, so neither is suppressed.
fn is_self_relocation(e: &GameEvent, o: &Owned) -> bool {
    let Some(planet) = subject_planet(&e.subject) else {
        return false;
    };
    event_buffer::get_recent(200, Some("fleet_depart"), None)
        .iter()
        .any(|d| {
            (e.timestamp - d.timestamp).abs() <= RELOCATE_WINDOW_MS
                && subject_planet(&d.subject) == Some(planet)
                && d.detail.get("fleet_status").and_then(|v| v.as_str()) == Some("onStation")
                && d.detail
                    .get("fleet_id")
                    .and_then(|v| v.as_str())
                    .map(|f| o.fleets.contains(f))
                    .unwrap_or(false)
        })
}

fn num(d: &Value, k: &str) -> Option<f64> {
    d.get(k)
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
}

/// Classify a single event as a threat to an owned asset, or `None`. Combat has
/// no `struct_attack` in grass — it surfaces as the *consequences* below. Struct
/// events are keyed to the planet subject, so matching an owned planet covers a
/// vplayer's structs without enumerating each one.
pub fn classify(e: &GameEvent, o: &Owned) -> Option<Threat> {
    let cat = e.category.as_str();
    let d = &e.detail;
    let sid = d.get("struct_id").and_then(|v| v.as_str());
    let refs_planet = refs_set(e, &o.planets);
    let refs_struct = sid.map(|s| o.structs.contains(s)).unwrap_or(false);
    let mine = refs_planet || refs_struct;

    // Raid clock arming on an owned planet — the top alarm (ore at risk). The
    // message that ENDS a raid is also a raid_status; it is not an alarm.
    if cat.contains("raid") && refs_planet {
        let status = d.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !RAID_TERMINAL.contains(&status) {
            return Some(Threat::RaidArmed);
        }
        return None;
    }
    // An owned struct destroyed (status bit 32) — by struct id or on an owned planet.
    if cat == "struct_status" && mine {
        if let Some(st) = num(d, "status") {
            if (st as u64) & 32 != 0 && !is_self_relocation(e, o) {
                return Some(Threat::StructLost);
            }
        }
    }
    // An owned struct losing health → damage (or destroyed if it hit 0).
    if cat == "struct_health" && mine && !is_self_relocation(e, o) {
        if let (Some(h), Some(ho)) = (num(d, "health"), num(d, "health_old")) {
            if h < ho {
                return Some(if h <= 0.0 { Threat::StructLost } else { Threat::TakingDamage });
            }
        }
    }
    // Planetary shield dropping on an owned planet. Abandoning a planet collapses
    // its shield too, so the same relocation gate applies.
    if cat == "shield_change" && refs_planet && !is_self_relocation(e, o) {
        if let (Some(s), Some(so)) = (num(d, "planetary_shield"), num(d, "planetary_shield_old")) {
            if s < so {
                return Some(Threat::ShieldDrop);
            }
        }
    }
    // A fleet that isn't ours arriving at an owned planet → incoming hostile.
    if cat == "fleet_arrive" && refs_planet {
        // Only `fleet_id` says who arrived. The payload's `player_id` is stamped
        // by the grass trigger with the PLANET's owner — us, on our own planets —
        // so testing it made every arrival look friendly and this alarm never
        // fired at all.
        let mine_fleet = d
            .get("fleet_id")
            .and_then(|v| v.as_str())
            .map(|f| o.fleets.contains(f))
            .unwrap_or(false);
        if !mine_fleet {
            return Some(Threat::HostileInbound);
        }
    }
    None
}

/// Build the owned-entity set: the primary player, plus (when `team`) every
/// virtual player's planet/fleet. Shared by the tool and the autonomous scan.
pub async fn build_owned(team: bool) -> Owned {
    let mut o = Owned::default();
    {
        let gs = GAME_STATE.read().unwrap();
        if let Some(p) = &gs.player_id {
            o.players.insert(p.clone());
        }
        if let Some(p) = &gs.planet_id {
            o.planets.insert(p.clone());
            o.label_by_planet.insert(p.clone(), "you".to_string());
            if let Some(me) = &gs.player_id {
                o.player_by_planet.insert(p.clone(), me.clone());
            }
            o.primary_planet = p.clone();
        }
        if let Some(f) = &gs.fleet_id {
            o.fleets.insert(f.clone());
        }
        o.structs.extend(gs.structs.keys().cloned());
    }
    if team {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let t = crate::mcp::virtual_players::team_owned(&client).await;
        o.players.extend(t.players);
        o.planets.extend(t.planets);
        o.fleets.extend(t.fleets);
        for (planet, name) in t.label_by_planet {
            o.label_by_planet.entry(planet).or_insert(name);
        }
        for (planet, pid) in t.player_by_planet {
            o.player_by_planet.entry(planet).or_insert(pid);
        }
    }
    o.refresh_flat();
    o
}

/// Autonomous threat scan for the sync path, scoped to the VIRTUAL PLAYERS only
/// (the primary is handled by the policy assessment, so this avoids double
/// alerts). Classifies recent buffer events newer than `since` and returns one
/// alert line per threat + the new high-water timestamp. First call (since == 0)
/// only establishes the baseline — it never alerts on already-buffered history.
pub async fn poll_team_threats(since: f64) -> (f64, Vec<String>) {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let t = crate::mcp::virtual_players::team_owned(&client).await;
    let mut o = Owned::default();
    o.players = t.players;
    o.planets = t.planets;
    o.fleets = t.fleets;
    o.label_by_planet = t.label_by_planet;
    o.player_by_planet = t.player_by_planet;
    o.refresh_flat();

    let recent = event_buffer::get_recent(200, None, None);
    let mut hw = since;
    let mut lines = Vec::new();
    for e in &recent {
        hw = hw.max(e.timestamp);
        if since <= 0.0 || e.timestamp <= since || o.flat.is_empty() {
            continue;
        }
        if let Some(t) = classify(e, &o) {
            lines.push(format!("{} — {}", t.label(), o.label_for(e)));
        }
    }
    (hw, lines)
}

pub async fn execute(params: EventParams) -> Vec<Content> {
    let since = params.since.unwrap_or(0.0);
    let limit = params.limit.unwrap_or(30);
    let wait = params.wait_secs.unwrap_or(0).min(55);
    let threats_only = params.threats_only;
    let restrict = params.mine_only || threats_only;

    let owned: Option<Owned> = if restrict {
        Some(build_owned(params.team).await)
    } else {
        None
    };

    // Poll the buffer until something relevant arrives or the wait elapses. In
    // threats_only mode "relevant" means a classified threat (not just any of-mine
    // event), so a sentinel loop blocks until the team is actually hit.
    let deadline_polls = wait;
    let mut polled = 0u64;
    let (fresh, threats): (Vec<GameEvent>, Vec<(GameEvent, Threat)>) = loop {
        let recent = event_buffer::get_recent(200, params.category.as_deref(), None);
        let fresh: Vec<GameEvent> = recent
            .into_iter()
            .filter(|e| e.timestamp > since)
            .filter(|e| match &owned {
                None => true,
                Some(o) => o.refs_any(e),
            })
            .collect();
        let threats: Vec<(GameEvent, Threat)> = if threats_only {
            let o = owned.as_ref().unwrap();
            fresh
                .iter()
                .filter_map(|e| classify(e, o).map(|t| (e.clone(), t)))
                .collect()
        } else {
            vec![]
        };
        let got = if threats_only { !threats.is_empty() } else { !fresh.is_empty() };
        if got || polled >= deadline_polls {
            break (fresh, threats);
        }
        polled += 1;
        tokio::time::sleep(Duration::from_secs(1)).await;
    };

    let next_cursor = fresh.iter().map(|e| e.timestamp).fold(since, f64::max);

    let mut out = String::new();

    if threats_only {
        let o = owned.as_ref().unwrap();
        if threats.is_empty() {
            let scope = if params.team { " (team)" } else { "" };
            out.push_str(&format!("✓ No threats detected{}. (cursor {})\n", scope, next_cursor));
        } else {
            let mut hits = threats;
            hits.sort_by(|a, b| {
                b.1.priority().cmp(&a.1.priority()).then(
                    b.0.timestamp
                        .partial_cmp(&a.0.timestamp)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
            });
            out.push_str(&format!("⚠ {} THREAT(S) DETECTED — under attack:\n", hits.len()));
            for (e, t) in hits.iter().take(limit) {
                let who = if params.team { format!("[{}] ", o.label_for(e)) } else { String::new() };
                let snip: String = serde_json::to_string(&e.detail)
                    .unwrap_or_default()
                    .chars()
                    .take(140)
                    .collect();
                out.push_str(&format!("  {} — {}[{}] {} {}\n", t.label(), who, e.timestamp, e.subject, snip));
            }
            out.push_str(&format!("\nnext_cursor: {} (pass as 'since' to page forward)\n", next_cursor));
            out.push_str("Respond: structs_intel scout/valid_targets/simulate → structs_action attack/defend/move_fleet (primary) or structs_players act {player,…} (a virtual player).\n");
        }
        return vec![Content::text(out)];
    }

    let shown: Vec<&GameEvent> = fresh.iter().rev().take(limit).collect();
    if shown.is_empty() {
        out.push_str(&format!(
            "No new events{}{}. (cursor {})\n",
            params.category.as_ref().map(|c| format!(" in '{}'", c)).unwrap_or_default(),
            if params.mine_only { " for you" } else { "" },
            next_cursor
        ));
    } else {
        out.push_str(&format!("{} new event(s):\n", shown.len()));
        for e in shown.iter().rev() {
            out.push_str(&format!("  [{}] {} — {}", e.timestamp, e.category, e.subject));
            let d = serde_json::to_string(&e.detail).unwrap_or_default();
            if d.len() > 2 {
                let snip: String = d.chars().take(160).collect();
                out.push_str(&format!("  {}", snip));
            }
            out.push('\n');
        }
        out.push_str(&format!("\nnext_cursor: {} (pass as 'since' to page forward)\n", next_cursor));
    }
    vec![Content::text(out)]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ids must never be matched against a subject by substring — anywhere.
    ///
    /// A chain id is a prefix of every longer id in its decade, so `1-195`
    /// matches `1-1950`…`1-1959` and `2-422` matches `2-4228`. The failure is
    /// invisible until somebody registers an id in the colliding range, and then
    /// it silently attributes other players' events to you. It has now bitten
    /// this codebase three times:
    ///
    ///   * `policy.rs`  — someone else's fight read as our combat (fixed).
    ///   * `structs-config.js` — player 1-195 was notified "You sent 1 Alpha
    ///     Matter" for an event belonging to 1-1957. Of 40 subjects the old
    ///     filter matched for that player, 36 were other people's (fixed).
    ///   * `event_buffer::get_recent` — a `subject_contains` filter nothing used
    ///     yet, removed before it could (fixed).
    ///
    /// Rust matching goes through `event_tokens`/`refs_set`, which split on the
    /// delimiter. The frontend has no such choke point, so guard it at the
    /// source: subjects are dot-delimited and an id is always a whole segment,
    /// so `split('.')` is the only correct test.
    #[test]
    fn the_frontend_never_substring_matches_an_id_against_a_subject() {
        const FILES: [(&str, &str); 3] = [
            ("structs-config.js", include_str!("../../../../frontend/structs-config.js")),
            ("board-pages.js", include_str!("../../../../frontend/board-pages.js")),
            ("board.js", include_str!("../../../../frontend/board.js")),
        ];
        for (name, src) in FILES {
            for (n, line) in src.lines().enumerate() {
                let l = line.trim();
                if l.starts_with("//") || l.starts_with('*') || l.starts_with("/*") {
                    continue; // the explanatory comments quote the bad pattern
                }
                // `split('.').indexOf(id)` is Array::indexOf — an exact whole-token
                // test, and the correct form. Only a scan of the raw string is a bug.
                let tokenised = l.contains("split('.')") || l.contains("split(\".\")");
                let scans_subject = l.contains("subject")
                    && (l.contains(".indexOf(") || l.contains(".includes("))
                    && !tokenised;
                assert!(
                    !scans_subject,
                    "{name}:{} matches an id against a subject by substring — split('.') and \
                     compare whole tokens instead (see subjectRefersTo): {l}",
                    n + 1
                );
            }
        }
    }
    /// A helper called from two functions must be declared at module scope.
    ///
    /// REGRESSION: `subjectHasToken` shipped nested inside `grassVal` but was
    /// also called from `grassRow`, so every grass row carrying an `address`
    /// detail — every inventory event — threw `ReferenceError` out of
    /// `renderGrassList`'s render loop. The block tick ahead of it rendered and
    /// nothing after it did: the live Stream tab froze on a single row.
    ///
    /// `node --check` cannot see this (it is scope, not syntax) and neither can
    /// the substring guard above. This pins the two helpers involved; eslint's
    /// `no-undef` is the general answer if the frontend ever grows a linter.
    #[test]
    fn shared_grass_helpers_are_declared_at_module_scope() {
        const SRC: &str = include_str!("../../../../frontend/board-pages.js");
        // Inside the file's single top-level IIFE, module scope is exactly two
        // spaces of indentation; anything deeper is inside another function.
        for helper in ["subjectHasToken", "grassIdAlreadyShown"] {
            let decl = format!("function {helper}(");
            let lines: Vec<&str> = SRC
                .lines()
                .filter(|l| l.contains(&decl) && !l.trim_start().starts_with("//"))
                .collect();
            assert_eq!(
                lines.len(),
                1,
                "board-pages.js should declare {helper} exactly once, found {}",
                lines.len()
            );
            let indent = lines[0].len() - lines[0].trim_start().len();
            assert_eq!(
                indent, 2,
                "board-pages.js declares {helper} at indent {indent}, i.e. nested inside another \
                 function. It is called from both grassVal and grassRow, so a nested declaration \
                 is a ReferenceError at render time that freezes the Stream tab. Hoist it to \
                 module scope."
            );
        }
    }

    use serde_json::json;

    fn ev(cat: &str, subject: &str, detail: Value) -> GameEvent {
        GameEvent {
            category: cat.to_string(),
            subject: subject.to_string(),
            detail,
            timestamp: 1_000.0,
        }
    }

    /// Owns planet 2-422 / fleet 9-434 — the shape that made 2-4228 look ours.
    fn owned() -> Owned {
        let mut o = Owned::default();
        o.players.insert("1-434".into());
        o.planets.insert("2-422".into());
        o.fleets.insert("9-434".into());
        o.label_by_planet.insert("2-422".into(), "worker153".into());
        o.refresh_flat();
        o
    }

    #[test]
    fn planet_id_prefix_is_not_a_match() {
        // 2-4228 merely starts with 2-422; it belongs to someone else.
        let e = ev(
            "struct_status",
            "structs.planet.2-4228.1-750",
            json!({"planet_id": "2-4228", "status": 35, "status_old": 7, "struct_id": "5-39196"}),
        );
        assert_eq!(classify(&e, &owned()), None);
        assert!(!owned().refs_any(&e));
    }

    #[test]
    fn exact_planet_still_matches() {
        let e = ev(
            "struct_status",
            "structs.planet.2-422.1-434",
            json!({"planet_id": "2-422", "status": 35, "status_old": 7, "struct_id": "5-1"}),
        );
        assert_eq!(classify(&e, &owned()), Some(Threat::StructLost));
    }

    #[test]
    fn player_id_prefix_is_not_a_match() {
        // The 1-61 / 1-611 case, on the player set.
        let mut o = Owned::default();
        o.players.insert("1-61".into());
        o.refresh_flat();
        let e = ev("lastAction", "structs.grid.player.1-611.1-611", json!({"player_id": "1-611"}));
        assert!(!o.refs_any(&e));
    }

    #[test]
    fn label_follows_the_subject_not_whichever_planet_hashes_first() {
        let mut o = owned();
        o.planets.insert("2-4228".into());
        o.label_by_planet.insert("2-4228".into(), "worker458".into());
        o.refresh_flat();
        let e = ev("struct_status", "structs.planet.2-4228.1-750", json!({"planet_id": "2-4228"}));
        // Deterministic across runs: 2-422 must never win an event keyed to 2-4228.
        for _ in 0..50 {
            assert_eq!(o.label_for(&e), "worker458");
        }
    }

    #[test]
    fn terminal_raid_status_is_not_an_alarm() {
        let o = owned();
        let armed = ev(
            "raid_status",
            "structs.planet.2-422.1-434",
            json!({"planet_id": "2-422", "status": "initiated"}),
        );
        assert_eq!(classify(&armed, &o), Some(Threat::RaidArmed));
        for done in ["raidSuccessful", "attackerDefeated", "attackerRetreated", "demilitarized"] {
            let e = ev(
                "raid_status",
                "structs.planet.2-422.1-434",
                json!({"planet_id": "2-422", "status": done}),
            );
            assert_eq!(classify(&e, &o), None, "{done} should not raise an alarm");
        }
    }

    #[test]
    fn hostile_arrival_fires_despite_the_owner_stamped_player_id() {
        // The grass trigger stamps `player_id` with the PLANET's owner (us), which
        // used to make every arrival read as friendly.
        let o = owned();
        let e = ev(
            "fleet_arrive",
            "structs.planet.2-422.1-434",
            json!({"planet_id": "2-422", "player_id": "1-434", "fleet_id": "9-61", "fleet_status": "away"}),
        );
        assert_eq!(classify(&e, &o), Some(Threat::HostileInbound));
    }

    #[test]
    fn our_own_fleet_coming_home_is_not_hostile() {
        let o = owned();
        let e = ev(
            "fleet_arrive",
            "structs.planet.2-422.1-434",
            json!({"planet_id": "2-422", "player_id": "1-434", "fleet_id": "9-434", "fleet_status": "onStation"}),
        );
        assert_eq!(classify(&e, &o), None);
    }

    #[test]
    fn subject_planet_extraction() {
        assert_eq!(subject_planet("structs.planet.2-5348.1-61"), Some("2-5348"));
        assert_eq!(subject_planet("structs.grid.planet.2-6013.1-748"), Some("2-6013"));
        assert_eq!(subject_planet("structs.grid.player.1-194.1-194"), None);
        assert_eq!(subject_planet("consensus"), None);
    }

    #[test]
    fn tokens_cover_nested_detail() {
        let e = ev(
            "fleet_arrive",
            "structs.planet.2-5348.1-61",
            json!({"fleet_id": "9-61", "fleet_list": ["9-61", "9-77"]}),
        );
        let t = event_tokens(&e);
        assert!(t.contains(&"2-5348"));
        assert!(t.contains(&"9-77"), "array members must be reachable");
    }

    /// Uses its own planet id so it can populate the shared global event buffer
    /// without changing what the other tests in this module classify.
    #[test]
    fn abandoning_a_planet_is_not_an_attack() {
        let mut o = owned();
        o.planets.insert("2-999".into());
        o.fleets.insert("9-999".into());
        o.refresh_flat();

        let killed = ev(
            "struct_status",
            "structs.planet.2-999.1-999",
            json!({"planet_id": "2-999", "status": 35, "status_old": 7, "struct_id": "5-1"}),
        );
        let shield = ev(
            "shield_change",
            "structs.planet.2-999.1-999",
            json!({"planet_id": "2-999", "planetary_shield": 25, "planetary_shield_old": 125}),
        );
        // Nothing explains it yet, so it reads as combat.
        assert_eq!(classify(&killed, &o), Some(Threat::StructLost));
        assert_eq!(classify(&shield, &o), Some(Threat::ShieldDrop));

        // Our own garrison leaving home in the same block: this is an `explore`.
        event_buffer::push_event(ev(
            "fleet_depart",
            "structs.planet.2-999.1-999",
            json!({"fleet_id": "9-999", "fleet_status": "onStation"}),
        ));
        assert_eq!(classify(&killed, &o), None);
        assert_eq!(classify(&shield, &o), None);
    }

    #[test]
    fn a_raider_leaving_our_planet_does_not_excuse_the_damage() {
        let mut o = owned();
        o.planets.insert("2-998".into());
        o.refresh_flat();
        let killed = ev(
            "struct_status",
            "structs.planet.2-998.1-998",
            json!({"planet_id": "2-998", "status": 35, "status_old": 7, "struct_id": "5-2"}),
        );
        // A hostile fleet departing is `away`, and is not one of ours.
        event_buffer::push_event(ev(
            "fleet_depart",
            "structs.planet.2-998.1-998",
            json!({"fleet_id": "9-61", "fleet_status": "away"}),
        ));
        assert_eq!(classify(&killed, &o), Some(Threat::StructLost));
    }
}
