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
