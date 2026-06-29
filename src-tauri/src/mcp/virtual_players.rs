//! Registry of agent-controlled "virtual players" — extra Structs players derived
//! from the SAME mnemonic at different HD indices. We persist ONLY public
//! identifiers (HD index, bech32 address, on-chain player id, display name).
//! NEVER keys or the mnemonic — those stay in JS and re-derive on demand.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

const FILENAME: &str = "virtual_players.json";
/// Safety cap on how many virtual players the agent may spin up.
pub const MAX_VIRTUAL_PLAYERS: usize = 16;

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
}

/// player_id -> (planet_id, fleet_id), resolved lazily; planet/fleet never change
/// for a player, so a permanent cache is safe and avoids per-poll LCD storms.
static OWNED_CACHE: std::sync::LazyLock<RwLock<std::collections::HashMap<String, (String, String)>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

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
            out.label_by_planet.insert(planet, name.clone());
        }
        if !fleet.is_empty() {
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
        s.players.push(VirtualPlayer { index: 1, address: "a".into(), player_id: None, name: "x".into(), created_at: 0.0 });
        s.players.push(VirtualPlayer { index: 3, address: "c".into(), player_id: None, name: "z".into(), created_at: 0.0 });
        assert_eq!(s.next_free_index(), 2);
    }

    #[test]
    fn find_by_index_address_or_player_id() {
        let mut s = VirtualPlayerStore::default();
        s.players.push(VirtualPlayer { index: 2, address: "structs1abc".into(), player_id: Some("1-5".into()), name: "scout".into(), created_at: 0.0 });
        assert!(s.find("2").is_some());
        assert!(s.find("structs1abc").is_some());
        assert!(s.find("1-5").is_some());
        assert!(s.find("nope").is_none());
    }
}
