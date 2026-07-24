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
    /// All ids flattened, for the subject/detail contains-filter.
    flat: Vec<String>,
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
    pub fn planet_for(&self, e: &GameEvent) -> Option<String> {
        let ds = e.detail.to_string();
        self.planets
            .iter()
            .find(|p| !p.is_empty() && (e.subject.contains(p.as_str()) || ds.contains(p.as_str())))
            .cloned()
    }
    fn refresh_flat(&mut self) {
        let mut flat: Vec<String> = Vec::new();
        flat.extend(self.players.iter().cloned());
        flat.extend(self.planets.iter().cloned());
        flat.extend(self.fleets.iter().cloned());
        flat.extend(self.structs.iter().cloned());
        flat.retain(|s| !s.is_empty());
        self.flat = flat;
    }
    /// Which owner a threat event belongs to (for tagging in team mode).
    fn label_for(&self, e: &GameEvent) -> String {
        let ds = e.detail.to_string();
        for (planet, name) in &self.label_by_planet {
            if e.subject.contains(planet) || ds.contains(planet) {
                return name.clone();
            }
        }
        "you".to_string()
    }
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
    let detail_str = d.to_string();
    let refs_planet = o
        .planets
        .iter()
        .any(|p| e.subject.contains(p) || detail_str.contains(p));
    let refs_struct = sid.map(|s| o.structs.contains(s)).unwrap_or(false);
    let mine = refs_planet || refs_struct;

    // Raid clock arming on an owned planet — the top alarm (ore at risk).
    if cat.contains("raid") && refs_planet {
        return Some(Threat::RaidArmed);
    }
    // An owned struct destroyed (status bit 32) — by struct id or on an owned planet.
    if cat == "struct_status" && mine {
        if let Some(st) = num(d, "status") {
            if (st as u64) & 32 != 0 {
                return Some(Threat::StructLost);
            }
        }
    }
    // An owned struct losing health → damage (or destroyed if it hit 0).
    if cat == "struct_health" && mine {
        if let (Some(h), Some(ho)) = (num(d, "health"), num(d, "health_old")) {
            if h < ho {
                return Some(if h <= 0.0 { Threat::StructLost } else { Threat::TakingDamage });
            }
        }
    }
    // Planetary shield dropping on an owned planet.
    if cat == "shield_change" && refs_planet {
        if let (Some(s), Some(so)) = (num(d, "planetary_shield"), num(d, "planetary_shield_old")) {
            if s < so {
                return Some(Threat::ShieldDrop);
            }
        }
    }
    // A fleet that isn't ours arriving at an owned planet → incoming hostile.
    if cat == "fleet_arrive" && refs_planet {
        let mine_fleet = o
            .fleets
            .iter()
            .any(|f| e.subject.contains(f) || detail_str.contains(f))
            || o.players.iter().any(|p| detail_str.contains(p));
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
                Some(o) => {
                    let detail_str = e.detail.to_string();
                    o.flat
                        .iter()
                        .any(|id| e.subject.contains(id.as_str()) || detail_str.contains(id.as_str()))
                }
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
