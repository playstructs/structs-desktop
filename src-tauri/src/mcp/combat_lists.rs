//! Persistent target lists shared by both combat loops — the "who do we care
//! about" layer that outlives any single fight.
//!
//! Three ideas, one file (`combat_lists.json`):
//!
//! * **Grudges** — players we hold something against. `auto_response` appends
//!   one automatically on every confirmed attack and keeps a running tally
//!   (attacks, damage taken, structs lost, ore lost); the operator can also add
//!   a player who has never touched us, because "I want that one raided" is a
//!   perfectly good reason. `auto_raid` uses the accumulated weight to bias
//!   target selection, so retaliation happens on OUR schedule rather than
//!   inside the attacker's window.
//! * **Priority guilds** — a whole guild can be marked as fair game with a
//!   weight, without naming each member.
//! * **Allies / protected players** — a HARD veto in both loops. Our own guild
//!   is seeded here on first load and cannot be scored past: the chain does not
//!   stop you attacking guild-mates, so the restraint has to live here.
//!
//! Why the data lives here rather than in the policy store: policies are flat
//! `{enabled, config}` blobs edited as whole JSON, whereas these are lists the
//! Team Ops WAR page mutates one row at a time.

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, RwLock};

use crate::hasher::types::now_millis;

const FILENAME: &str = "combat_lists.json";

/// Auto-recorded grudges lapse after 30 days of quiet. Manual ones never do
/// unless the operator sets an expiry — an explicit choice shouldn't evaporate.
pub const AUTO_GRUDGE_TTL_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrudgeSource {
    /// Written by `auto_response` when it confirmed an attack on us.
    #[default]
    Auto,
    /// Added by the operator through the WAR page or `structs_doctrine lists`.
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grudge {
    pub player_id: String,
    /// Resolved display name, cached so the UI doesn't re-lookup every render.
    #[serde(default)]
    pub label: Option<String>,
    /// Their guild, cached for the ally veto and guild weighting.
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub source: GrudgeSource,
    /// Operator-tunable priority multiplier. 1.0 is neutral.
    #[serde(default = "one")]
    pub weight: f64,
    /// Free-text reason, shown in the UI (e.g. "killed CMD 5-1958 twice").
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub attacks: u32,
    #[serde(default)]
    pub damage_taken: u64,
    #[serde(default)]
    pub structs_lost: u32,
    #[serde(default)]
    pub ore_lost: f64,
    #[serde(default)]
    pub first_seen_ms: f64,
    #[serde(default)]
    pub last_seen_ms: f64,
    /// `None` = never expires.
    #[serde(default)]
    pub expires_ms: Option<f64>,
    /// Keep the record and its history, but stop acting on it.
    #[serde(default)]
    pub muted: bool,
}

fn one() -> f64 {
    1.0
}

impl Grudge {
    fn new(player_id: &str, source: GrudgeSource, now: f64) -> Self {
        Self {
            player_id: player_id.to_string(),
            label: None,
            guild_id: None,
            source,
            weight: 1.0,
            note: None,
            attacks: 0,
            damage_taken: 0,
            structs_lost: 0,
            ore_lost: 0.0,
            first_seen_ms: now,
            last_seen_ms: now,
            expires_ms: match source {
                GrudgeSource::Auto => Some(now + AUTO_GRUDGE_TTL_MS),
                GrudgeSource::Manual => None,
            },
            muted: false,
        }
    }

    pub fn is_expired(&self, now: f64) -> bool {
        self.expires_ms.map(|e| now >= e).unwrap_or(false)
    }

    /// How much this grudge should push a target up the raid ranking. Grows with
    /// demonstrated hostility but saturates — an attacker with 50 incidents
    /// shouldn't outrank a fat undefended pile by two orders of magnitude.
    pub fn heat(&self) -> f64 {
        if self.muted {
            return 0.0;
        }
        let incidents = (self.attacks as f64).min(20.0) / 20.0;
        let harm = ((self.structs_lost as f64) * 2.0 + self.ore_lost).min(50.0) / 50.0;
        self.weight * (0.35 + 0.4 * incidents + 0.25 * harm)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuildWeight {
    pub guild_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "one")]
    pub weight: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CombatLists {
    #[serde(default)]
    pub grudges: Vec<Grudge>,
    #[serde(default)]
    pub priority_guilds: Vec<GuildWeight>,
    /// Guild ids we will never attack. Seeded with our own guild.
    #[serde(default)]
    pub allies: Vec<String>,
    /// Individual players we will never attack, regardless of guild.
    #[serde(default)]
    pub protected_players: Vec<String>,
    /// Set once our own guild has been seeded into `allies`, so an operator who
    /// deliberately removes it doesn't get it re-added on every launch.
    #[serde(default)]
    pub own_guild_seeded: bool,
}

static LISTS: LazyLock<RwLock<CombatLists>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config::<CombatLists>(FILENAME)));

pub fn get() -> CombatLists {
    LISTS.read().map(|l| l.clone()).unwrap_or_default()
}

fn persist(lists: &CombatLists) {
    crate::mcp::config_store::save_config(FILENAME, lists);
}

/// Mutate the lists under the write lock and persist the result.
fn with_mut<R>(f: impl FnOnce(&mut CombatLists) -> R) -> R {
    let mut guard = LISTS.write().unwrap_or_else(|e| e.into_inner());
    let out = f(&mut guard);
    persist(&guard);
    out
}

/// Seed our own guild into `allies` the first time we know it. Idempotent, and
/// respects a later manual removal via the `own_guild_seeded` latch.
pub fn seed_own_guild(guild_id: &str) {
    if guild_id.is_empty() {
        return;
    }
    with_mut(|l| {
        if l.own_guild_seeded {
            return;
        }
        l.own_guild_seeded = true;
        if !l.allies.iter().any(|g| g == guild_id) {
            l.allies.push(guild_id.to_string());
        }
    });
}

/// Replace the in-memory lists WITHOUT persisting. Tests only: the real lists
/// load from the operator's data directory, so any test touching a veto path is
/// otherwise asserting against live machine state — which is exactly how the
/// auto_raid gate tests began failing the day `0-1` was added as an ally.
#[cfg(test)]
pub fn set_for_test(lists: CombatLists) {
    if let Ok(mut l) = LISTS.write() {
        *l = lists;
    }
}

/// True when this target must never be attacked: our own team, an allied guild,
/// or an explicitly protected player. Checked BEFORE scoring in both loops so no
/// score can ever outvote it.
/// Should we refrain from STARTING a fight with this player?
///
/// Offence only. `auto_raid` consults this before scoring a target; the
/// defensive loop deliberately does not, because a veto is a decision about who
/// we pick fights with, not about whether we defend ourselves. A guild-mate who
/// raids us gets the full response.
pub fn is_vetoed(player_id: &str, guild_id: Option<&str>) -> bool {
    if crate::mcp::virtual_players::is_team_player(player_id) {
        return true;
    }
    let l = get();
    if l.protected_players.iter().any(|p| p == player_id) {
        return true;
    }
    match guild_id {
        Some(g) if !g.is_empty() => l.allies.iter().any(|a| a == g),
        _ => false,
    }
}

/// This player's own grudge heat (0 when unknown, muted or lapsed).
pub fn grudge_heat(player_id: &str) -> f64 {
    let now = now_millis();
    get()
        .grudges
        .iter()
        .find(|g| g.player_id == player_id && !g.is_expired(now))
        .map(|g| g.heat())
        .unwrap_or(0.0)
}

/// Weight the operator put on this guild as a whole (0 when unlisted).
pub fn guild_weight(guild_id: Option<&str>) -> f64 {
    guild_id
        .and_then(|gid| get().priority_guilds.iter().find(|p| p.guild_id == gid).map(|p| p.weight))
        .unwrap_or(0.0)
}

/// Record one confirmed attack against us. Creates the grudge if new, refreshes
/// its expiry, and accumulates the harm tally. Returns the updated row so the
/// caller can log/notify with the running count.
pub fn record_attack(
    attacker_player_id: &str,
    guild_id: Option<&str>,
    damage: u64,
    structs_lost: u32,
    ore_lost: f64,
) -> Grudge {
    let now = now_millis();
    with_mut(|l| {
        let idx = match l.grudges.iter().position(|g| g.player_id == attacker_player_id) {
            Some(i) => i,
            None => {
                l.grudges.push(Grudge::new(attacker_player_id, GrudgeSource::Auto, now));
                l.grudges.len() - 1
            }
        };
        let g = &mut l.grudges[idx];
        g.attacks = g.attacks.saturating_add(1);
        g.damage_taken = g.damage_taken.saturating_add(damage);
        g.structs_lost = g.structs_lost.saturating_add(structs_lost);
        g.ore_lost += ore_lost;
        g.last_seen_ms = now;
        if g.guild_id.is_none() {
            g.guild_id = guild_id.map(String::from);
        }
        // Renew the clock on every fresh incident — a repeat offender should
        // never age out while it is still offending.
        if g.source == GrudgeSource::Auto {
            g.expires_ms = Some(now + AUTO_GRUDGE_TTL_MS);
        }
        g.clone()
    })
}

/// Add (or update) a grudge by hand. `weight`/`note`/`expires_ms` are applied
/// when present; an existing auto grudge is promoted to Manual so it stops
/// aging out.
pub fn upsert_grudge(
    player_id: &str,
    label: Option<String>,
    guild_id: Option<String>,
    weight: Option<f64>,
    note: Option<String>,
    expires_ms: Option<Option<f64>>,
) -> Grudge {
    let now = now_millis();
    with_mut(|l| {
        let idx = match l.grudges.iter().position(|g| g.player_id == player_id) {
            Some(i) => i,
            None => {
                l.grudges.push(Grudge::new(player_id, GrudgeSource::Manual, now));
                l.grudges.len() - 1
            }
        };
        let g = &mut l.grudges[idx];
        g.source = GrudgeSource::Manual;
        if label.is_some() {
            g.label = label;
        }
        if guild_id.is_some() {
            g.guild_id = guild_id;
        }
        if let Some(w) = weight {
            g.weight = w.clamp(0.0, 10.0);
        }
        if note.is_some() {
            g.note = note;
        }
        match expires_ms {
            Some(e) => g.expires_ms = e,
            // A hand-added grudge defaults to permanent.
            None => g.expires_ms = None,
        }
        g.clone()
    })
}

pub fn set_muted(player_id: &str, muted: bool) -> bool {
    with_mut(|l| match l.grudges.iter_mut().find(|g| g.player_id == player_id) {
        Some(g) => {
            g.muted = muted;
            true
        }
        None => false,
    })
}

pub fn remove_grudge(player_id: &str) -> bool {
    with_mut(|l| {
        let before = l.grudges.len();
        l.grudges.retain(|g| g.player_id != player_id);
        l.grudges.len() != before
    })
}

pub fn upsert_priority_guild(guild_id: &str, label: Option<String>, weight: Option<f64>) -> GuildWeight {
    with_mut(|l| {
        let idx = match l.priority_guilds.iter().position(|g| g.guild_id == guild_id) {
            Some(i) => i,
            None => {
                l.priority_guilds.push(GuildWeight {
                    guild_id: guild_id.to_string(),
                    label: None,
                    weight: 1.0,
                });
                l.priority_guilds.len() - 1
            }
        };
        let g = &mut l.priority_guilds[idx];
        if label.is_some() {
            g.label = label;
        }
        if let Some(w) = weight {
            g.weight = w.clamp(0.0, 10.0);
        }
        g.clone()
    })
}

pub fn remove_priority_guild(guild_id: &str) -> bool {
    with_mut(|l| {
        let before = l.priority_guilds.len();
        l.priority_guilds.retain(|g| g.guild_id != guild_id);
        l.priority_guilds.len() != before
    })
}

pub fn set_ally(guild_id: &str, allied: bool) {
    with_mut(|l| {
        l.allies.retain(|g| g != guild_id);
        if allied {
            l.allies.push(guild_id.to_string());
        }
        // An explicit removal must survive the next launch.
        l.own_guild_seeded = true;
    });
}

pub fn set_protected(player_id: &str, protected: bool) {
    with_mut(|l| {
        l.protected_players.retain(|p| p != player_id);
        if protected {
            l.protected_players.push(player_id.to_string());
        }
    });
}

/// Drop lapsed auto grudges. Cheap; call from either loop's scan.
pub fn prune_expired() -> usize {
    let now = now_millis();
    with_mut(|l| {
        let before = l.grudges.len();
        l.grudges.retain(|g| !g.is_expired(now));
        before - l.grudges.len()
    })
}

/// Everything the WAR page needs, already sorted the way it renders: hottest
/// grudge first.
pub fn snapshot_json() -> serde_json::Value {
    let now = now_millis();
    let l = get();
    let mut grudges: Vec<&Grudge> = l.grudges.iter().collect();
    grudges.sort_by(|a, b| b.heat().partial_cmp(&a.heat()).unwrap_or(std::cmp::Ordering::Equal));
    serde_json::json!({
        "grudges": grudges.iter().map(|g| serde_json::json!({
            "player_id": g.player_id,
            "label": g.label,
            "guild_id": g.guild_id,
            "source": g.source,
            "weight": g.weight,
            "note": g.note,
            "attacks": g.attacks,
            "damage_taken": g.damage_taken,
            "structs_lost": g.structs_lost,
            "ore_lost": g.ore_lost,
            "first_seen_ms": g.first_seen_ms,
            "last_seen_ms": g.last_seen_ms,
            "expires_ms": g.expires_ms,
            "muted": g.muted,
            "expired": g.is_expired(now),
            "heat": g.heat(),
        })).collect::<Vec<_>>(),
        "priority_guilds": l.priority_guilds,
        "allies": l.allies,
        "protected_players": l.protected_players,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Defence must never be restrained by the ally/protected veto.
    ///
    /// Those lists say who we do not START fights with. Applying them to the
    /// DEFENSIVE loop would mean standing still while an ally empties our ore.
    /// The distinction is easy to lose — the two loops sit side by side and the
    /// veto looks like something both should honour "for consistency" — so pin
    /// it at the source level, which is the only place the absence of a call
    /// can be asserted.
    #[test]
    fn the_defensive_loop_never_consults_the_veto() {
        let src = include_str!("auto_response.rs");
        let calls: Vec<&str> = src
            .lines()
            .filter(|l| l.contains("is_vetoed"))
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect();
        assert!(
            calls.is_empty(),
            "auto_response must not gate defence on the ally veto — a guild-mate who \
             raids us gets fought like anyone else. Offending line(s): {calls:?}"
        );
    }

    // These tests exercise the pure logic on hand-built values rather than the
    // global (which would touch the real config file and race across tests).
    fn g(source: GrudgeSource, attacks: u32, structs_lost: u32, ore: f64) -> Grudge {
        let mut x = Grudge::new("1-61", source, 1000.0);
        x.attacks = attacks;
        x.structs_lost = structs_lost;
        x.ore_lost = ore;
        x
    }

    #[test]
    fn auto_grudges_expire_manual_ones_do_not() {
        let auto = g(GrudgeSource::Auto, 1, 0, 0.0);
        let manual = g(GrudgeSource::Manual, 1, 0, 0.0);
        assert_eq!(auto.expires_ms, Some(1000.0 + AUTO_GRUDGE_TTL_MS));
        assert!(manual.expires_ms.is_none());
        assert!(!auto.is_expired(1000.0 + AUTO_GRUDGE_TTL_MS - 1.0));
        assert!(auto.is_expired(1000.0 + AUTO_GRUDGE_TTL_MS));
        assert!(!manual.is_expired(f64::MAX));
    }

    #[test]
    fn heat_grows_with_harm_but_saturates() {
        let light = g(GrudgeSource::Auto, 1, 0, 0.0);
        let heavy = g(GrudgeSource::Auto, 20, 25, 50.0);
        let absurd = g(GrudgeSource::Auto, 500, 500, 5000.0);
        assert!(heavy.heat() > light.heat());
        // Saturation: an attacker 25x worse than "heavy" must not score 25x.
        assert!((absurd.heat() - heavy.heat()).abs() < 1e-9);
        assert!(heavy.heat() <= 1.01);
    }

    #[test]
    fn muted_grudges_contribute_nothing() {
        let mut x = g(GrudgeSource::Auto, 20, 25, 50.0);
        assert!(x.heat() > 0.0);
        x.muted = true;
        assert_eq!(x.heat(), 0.0);
    }

    #[test]
    fn weight_scales_heat() {
        let mut x = g(GrudgeSource::Manual, 5, 1, 2.0);
        let base = x.heat();
        x.weight = 2.0;
        assert!((x.heat() - base * 2.0).abs() < 1e-9);
    }

    /// A brand-new manual grudge (no recorded harm) must still carry weight —
    /// "raid this player" is an instruction, not an observation.
    #[test]
    fn a_manual_grudge_with_no_history_still_has_heat() {
        let x = g(GrudgeSource::Manual, 0, 0, 0.0);
        assert!(x.heat() > 0.0);
    }
}
