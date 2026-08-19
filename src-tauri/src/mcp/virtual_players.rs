//! Registry of agent-controlled "virtual players" — extra Structs players derived
//! from the SAME mnemonic at different HD indices. We persist ONLY public
//! identifiers (HD index, bech32 address, on-chain player id, display name).
//! NEVER keys or the mnemonic — those stay in JS and re-derive on demand.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

const FILENAME: &str = "virtual_players.json";
/// Hard count cap on virtual players. **0 = unlimited** — the real limit is the
/// guild-power soft gate in `create` (won't spin up a player the substation can't
/// power). Set to 0 for now; raise to a positive number to re-impose a hard cap.
pub const MAX_VIRTUAL_PLAYERS: usize = 0;

/// True when another virtual player is allowed by the hard count cap (0 = unlimited).
pub fn under_cap(current: usize) -> bool {
    MAX_VIRTUAL_PLAYERS == 0 || current < MAX_VIRTUAL_PLAYERS
}

/// What a virtual player is FOR. `Bait` (default) just mines so ore — which is
/// non-transferable — piles up on its planet as a raid lure. `Productive` runs
/// the self-funding flywheel: mine → refine → send alpha to the primary, which
/// infuses the guild reactor. `Raider` is the expendable offensive arm: it
/// carries no extractor and no stored value, so losing its Command Ship costs
/// nothing but a rebuild — the primary never has to leave home to raid (every
/// one of our Command Ship deaths happened with the fleet in the field).
///
/// A raider DOES keep a refinery: a raid seizes the victim's stored ore into the
/// raider's own `storedOre`, where it is itself stealable until refined into
/// Alpha, which is unstealable and sendable to the primary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VPlayerRole {
    #[default]
    Bait,
    Productive,
    Raider,
}

impl VPlayerRole {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "bait" => Some(Self::Bait),
            "productive" | "miner" | "worker" => Some(Self::Productive),
            "raider" | "raid" | "vulture" => Some(Self::Raider),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bait => "bait",
            Self::Productive => "productive",
            Self::Raider => "raider",
        }
    }
    /// Every role name accepted by `parse`, canonical spellings only — used by
    /// the tool schemas and the board's role pickers so a new role shows up
    /// everywhere without another hardcoded list.
    pub const ALL: &'static [Self] = &[Self::Bait, Self::Productive, Self::Raider];
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualPlayer {
    /// HD index off the shared mnemonic (`m/44'/118'/0'/0/index`). 0 is the
    /// primary player, so virtual players use index >= 1.
    pub index: u32,
    pub address: String,
    /// On-chain player id once guild signup lands; None while pending.
    #[serde(default)]
    pub player_id: Option<String>,
    pub name: String,
    /// Epoch ms, stamped by the caller (Rust can't call Date::now in some paths).
    #[serde(default)]
    pub created_at: f64,
    /// bait (default) vs productive — drives the flywheel. Existing registry
    /// JSON without this field loads as `Bait`.
    #[serde(default)]
    pub role: VPlayerRole,
    /// Behaviour profile id. `None` means "use the built-in named by `role`",
    /// which is what every pre-profile registry entry loads as — so adding
    /// profiles migrated nothing.
    #[serde(default)]
    pub profile: Option<String>,
    /// True when this tooling picked the name, which is what licenses the
    /// roster sweep to rewrite it. False only when the operator passed one
    /// explicitly. Defaults TRUE so the pre-existing `worker<N>` fleet — every
    /// one of them auto-named — is adopted rather than frozen.
    #[serde(default = "default_auto_name")]
    pub auto_name: bool,
}

fn default_auto_name() -> bool {
    true
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct VirtualPlayerStore {
    pub players: Vec<VirtualPlayer>,
}

pub static REGISTRY: std::sync::LazyLock<RwLock<VirtualPlayerStore>> =
    std::sync::LazyLock::new(|| RwLock::new(VirtualPlayerStore::load()));

impl VirtualPlayerStore {
    fn path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("structs-app").join(FILENAME))
    }

    pub fn load() -> Self {
        let Some(path) = Self::path() else {
            return Self::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::path().ok_or("no config dir")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Lowest unused HD index >= 1 (0 is the primary player).
    pub fn next_free_index(&self) -> u32 {
        let mut i = 1u32;
        loop {
            if !self.players.iter().any(|p| p.index == i) {
                return i;
            }
            i += 1;
        }
    }

    pub fn find(&self, key: &str) -> Option<&VirtualPlayer> {
        self.players.iter().find(|p| {
            p.address == key
                || p.player_id.as_deref() == Some(key)
                || p.index.to_string() == key
        })
    }
}

/// Registered vplayers that have an on-chain player id, as
/// `(player_id, HD index, role)`. When `include_primary`, the primary player is
/// appended as `(pid, None, None)`. Shared target list for the auto-loops.
pub fn collect_targets(include_primary: bool) -> Vec<(String, Option<u32>, Option<VPlayerRole>)> {
    let mut targets: Vec<(String, Option<u32>, Option<VPlayerRole>)> = {
        let reg = REGISTRY.read().unwrap();
        reg.players
            .iter()
            .filter_map(|p| p.player_id.clone().map(|pid| (pid, Some(p.index), Some(p.role))))
            .collect()
    };
    if include_primary {
        if let Some(pid) = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone()) {
            if !pid.is_empty() {
                targets.push((pid, None, None));
            }
        }
    }
    targets
}

/// Is this player id one of ours — the primary, or any registered vplayer?
/// The combat loops veto on this before anything else: friendly fire between
/// our own accounts is never a legitimate target, however it scores.
/// The role of one of our players, or `None` for the primary / an unknown id.
///
/// `collect_targets` already yields roles for a whole sweep; this is the
/// single-player lookup for code that starts from an id (an incoming raid
/// alarm, say) rather than from the roster.
pub fn role_of(player_id: &str) -> Option<VPlayerRole> {
    if player_id.is_empty() {
        return None;
    }
    // REGISTRY, not `load()`: this is called ONCE PER PLAYER PER SCAN by
    // auto_build / auto_harvest / auto_defend, and `load()` reads and reparses
    // the whole registry file every call. At 2,241 players across four loops
    // that is tens of thousands of full-file JSON parses a minute.
    REGISTRY
        .read()
        .ok()
        .and_then(|r| r.find(player_id).map(|v| v.role))
}

/// The profile id assigned to one of our players, if any. `None` falls back to
/// the built-in named by its role — see `profile::for_player`.
pub fn profile_of(player_id: &str) -> Option<String> {
    if player_id.is_empty() {
        return None;
    }
    // In-memory for the same reason as `role_of` above.
    REGISTRY
        .read()
        .ok()
        .and_then(|r| r.find(player_id).and_then(|v| v.profile.clone()))
        .filter(|p| !p.is_empty())
}

/// Point a player at a profile (or clear it with `None`), updating the
/// in-memory registry AND persisting.
///
/// `VirtualPlayerStore::save()` only writes the file — it does not refresh
/// `REGISTRY`, which is what every loop actually reads. Mutating a loaded copy
/// and saving it therefore looks successful and changes nothing until restart.
pub fn set_profile(player_key: &str, profile: Option<String>) -> Result<String, String> {
    let mut reg = REGISTRY.write().unwrap_or_else(|e| e.into_inner());
    let v = reg
        .players
        .iter_mut()
        .find(|v| v.player_id.as_deref() == Some(player_key) || v.name == player_key)
        .ok_or_else(|| format!("no virtual player '{player_key}'"))?;
    v.profile = profile;
    let name = v.name.clone();
    reg.save()?;
    Ok(name)
}

pub fn is_team_player(player_id: &str) -> bool {
    if player_id.is_empty() {
        return false;
    }
    if crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| g.player_id.clone())
        .as_deref()
        == Some(player_id)
    {
        return true;
    }
    REGISTRY
        .read()
        .map(|r| r.players.iter().any(|p| p.player_id.as_deref() == Some(player_id)))
        .unwrap_or(false)
}

/// The team's owned on-chain entities (for threat detection across all virtual
/// players, not just the primary). Planet-subject matching covers each vplayer's
/// structs too (their struct events are keyed to the planet subject), so we only
/// need each vplayer's planet + fleet — resolved once from the chain and cached.
#[derive(Debug, Clone, Default)]
pub struct TeamOwned {
    pub players: std::collections::HashSet<String>,
    pub planets: std::collections::HashSet<String>,
    pub fleets: std::collections::HashSet<String>,
    /// planet id -> vplayer display name, for tagging which player was hit.
    pub label_by_planet: std::collections::HashMap<String, String>,
    /// planet id -> owning player id. The response loop needs the id, not the
    /// label: only the attacked player's OWN fleet is co-located with the
    /// raider, so that's who can actually shoot back.
    pub player_by_planet: std::collections::HashMap<String, String>,
    /// player id -> its fleet id, for locating that player's shooters.
    pub fleet_by_player: std::collections::HashMap<String, String>,
}

/// player_id -> (planet_id, fleet_id), resolved lazily; planet/fleet never change
/// for a player, so a permanent cache is safe and avoids per-poll LCD storms.
static OWNED_CACHE: std::sync::LazyLock<RwLock<std::collections::HashMap<String, (String, String)>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// Drop a player's cached (planet, fleet) — call after it EXPLORES, since its
/// planet id changes (the cache otherwise assumes planet/fleet are permanent).
pub fn invalidate_owned(player_id: &str) {
    if let Ok(mut c) = OWNED_CACHE.write() {
        c.remove(player_id);
    }
    // Exploring destroys every planetary struct and migrates the fleet, so the
    // cached composition is wrong too.
    crate::mcp::loop_util::invalidate_player_structs(player_id);
}

/// How many virtual players are registered. Used by the log bundle manifest
/// (and anything else that wants fleet size without loading the roster).
pub fn count() -> usize {
    REGISTRY
        .read()
        .map(|r| r.players.len())
        .unwrap_or(0)
}

/// Resolve the planet/fleet ids of every registered virtual player (cached),
/// for team-wide threat detection.
pub async fn team_owned(client: &crate::mcp::cosmos_client::CosmosClient) -> TeamOwned {
    let entries: Vec<(String, String)> = {
        let reg = REGISTRY.read().unwrap();
        reg.players
            .iter()
            .filter_map(|vp| vp.player_id.clone().map(|p| (p, vp.name.clone())))
            .collect()
    };
    let mut out = TeamOwned::default();
    for (pid, name) in entries {
        out.players.insert(pid.clone());
        let cached = OWNED_CACHE.read().unwrap().get(&pid).cloned();
        let (planet, fleet) = match cached {
            Some(pf) => pf,
            None => {
                let pf = match client.query_entity("player", &pid).await {
                    Ok(v) => {
                        let g = |k: &str| {
                            v.get("Player")
                                .and_then(|x| x.get(k))
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string()
                        };
                        (g("planetId"), g("fleetId"))
                    }
                    Err(_) => (String::new(), String::new()),
                };
                if !pf.0.is_empty() {
                    OWNED_CACHE.write().unwrap().insert(pid.clone(), pf.clone());
                }
                pf
            }
        };
        if !planet.is_empty() {
            out.planets.insert(planet.clone());
            out.label_by_planet.insert(planet.clone(), name.clone());
            out.player_by_planet.insert(planet, pid.clone());
        }
        if !fleet.is_empty() {
            out.fleet_by_player.insert(pid.clone(), fleet.clone());
            out.fleets.insert(fleet);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_free_index_skips_used() {
        let mut s = VirtualPlayerStore::default();
        assert_eq!(s.next_free_index(), 1);
        s.players.push(VirtualPlayer { profile: None, index: 1, address: "a".into(), player_id: None, name: "x".into(), created_at: 0.0, role: VPlayerRole::Bait, auto_name: true });
        s.players.push(VirtualPlayer { profile: None, index: 3, address: "c".into(), player_id: None, name: "z".into(), created_at: 0.0, role: VPlayerRole::Bait, auto_name: true });
        assert_eq!(s.next_free_index(), 2);
    }

    #[test]
    fn find_by_index_address_or_player_id() {
        let mut s = VirtualPlayerStore::default();
        s.players.push(VirtualPlayer { profile: None, index: 2, address: "structs1abc".into(), player_id: Some("1-5".into()), name: "scout".into(), created_at: 0.0, role: VPlayerRole::Bait, auto_name: true });
        assert!(s.find("2").is_some());
        assert!(s.find("structs1abc").is_some());
        assert!(s.find("1-5").is_some());
        assert!(s.find("nope").is_none());
    }

    #[test]
    fn role_parse_roundtrip_and_default() {
        assert_eq!(VPlayerRole::default(), VPlayerRole::Bait);
        assert_eq!(VPlayerRole::parse("bait"), Some(VPlayerRole::Bait));
        assert_eq!(VPlayerRole::parse("PRODUCTIVE"), Some(VPlayerRole::Productive));
        assert_eq!(VPlayerRole::parse("miner"), Some(VPlayerRole::Productive));
        assert_eq!(VPlayerRole::parse("nonsense"), None);
        assert_eq!(VPlayerRole::Productive.as_str(), "productive");
    }

    #[test]
    fn role_missing_in_json_defaults_to_bait() {
        // Back-compat: an existing registry entry written before `role` existed.
        let json = r#"{"players":[{"index":1,"address":"a","player_id":"1-9","name":"old","created_at":0.0}]}"#;
        let store: VirtualPlayerStore = serde_json::from_str(json).unwrap();
        assert_eq!(store.players[0].role, VPlayerRole::Bait);
    }
}
