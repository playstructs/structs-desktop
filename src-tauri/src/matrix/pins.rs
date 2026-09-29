//! Rooms a player has pinned above every section of the list — and the
//! guild's own channels, which are pinned for them by default.
//!
//! One rule for both: a pinned room carries a rank (`Room::home_rank`) and
//! sits in the "Pinned" group at the top. The guild's channels get their rank
//! from the room directory (`client::guild_channel_rank`: lobby first); a
//! player's own pins come after those, in the order they were pinned. A
//! default the player took OUT stays out — that is the whole difference
//! between "pinned for you" and "pinned by you", and it is why the file keeps
//! two lists rather than one.
//!
//! Per IDENTITY, like every other membership fact on this install: a roster
//! player's pins are that player's, not the primary's.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pins {
    /// Room ids the player pinned, in the order they pinned them.
    #[serde(default)]
    pub pinned: Vec<String>,
    /// Aliases of DEFAULT channels the player unpinned. Aliases, because that
    /// is how a default is known; a room id would be a different room after
    /// an upgrade.
    #[serde(default)]
    pub unpinned: Vec<String>,
}

type File = HashMap<String, Pins>;

/// Player pins come after the guild's own channels, whose ranks are 0 (the
/// lobby) and 1 (everything else the guild made).
pub const FIRST_PLAYER_RANK: u8 = 2;

static CACHE: RwLock<Option<File>> = RwLock::new(None);

fn path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join("room_pins.json"))
}

fn load() -> File {
    if let Ok(g) = CACHE.read() {
        if let Some(f) = g.as_ref() {
            return f.clone();
        }
    }
    let file: File = path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if let Ok(mut g) = CACHE.write() {
        *g = Some(file.clone());
    }
    file
}

fn save(file: &File) {
    if let Ok(mut g) = CACHE.write() {
        *g = Some(file.clone());
    }
    let Some(p) = path() else { return };
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new(".")));
    if let Ok(t) = serde_json::to_string(file) {
        let tmp = p.with_extension("tmp");
        if std::fs::write(&tmp, t).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

/// Where a room sits in the Pinned group, or `None` when it is not pinned.
///
/// `default_rank` is what the guild directory says (lobby 0, other guild
/// channels 1, everything else None). A player's own pin outranks nothing
/// and follows the defaults; a default the player unpinned is gone.
pub fn rank(user_id: &str, room_id: &str, alias: Option<&str>, default_rank: Option<u8>) -> Option<u8> {
    let file = load();
    rank_in(file.get(user_id), room_id, alias, default_rank)
}

/// The decision itself, with nothing global in it.
pub fn rank_in(pins: Option<&Pins>, room_id: &str, alias: Option<&str>, default_rank: Option<u8>) -> Option<u8> {
    let Some(p) = pins else { return default_rank };
    if let Some(i) = p.pinned.iter().position(|r| r == room_id) {
        return Some(FIRST_PLAYER_RANK.saturating_add(i.min(u8::MAX as usize - FIRST_PLAYER_RANK as usize) as u8));
    }
    if alias.is_some_and(|a| p.unpinned.iter().any(|u| u == a)) {
        return None;
    }
    default_rank
}

/// Pin or unpin a room for one identity. `is_default` says whether the room
/// is one of the guild's own channels (then unpinning is remembered by alias,
/// and pinning again simply forgets that).
pub fn set(user_id: &str, room_id: &str, alias: Option<&str>, is_default: bool, pinned: bool) {
    let mut file = load();
    let p = file.entry(user_id.to_string()).or_default();
    apply(p, room_id, alias, is_default, pinned);
    save(&file);
}

pub fn apply(p: &mut Pins, room_id: &str, alias: Option<&str>, is_default: bool, pinned: bool) {
    if pinned {
        if let Some(a) = alias {
            p.unpinned.retain(|u| u != a);
        }
        if !is_default && !p.pinned.iter().any(|r| r == room_id) {
            p.pinned.push(room_id.to_string());
        }
    } else {
        p.pinned.retain(|r| r != room_id);
        if is_default {
            if let Some(a) = alias {
                if !p.unpinned.iter().any(|u| u == a) {
                    p.unpinned.push(a.to_string());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_is_pinned_until_the_player_says_otherwise() {
        let mut p = Pins::default();
        let lobby = Some("#orbital-hydro:matrix.crew.oh.energy");
        assert_eq!(rank_in(Some(&p), "!lobby", lobby, Some(0)), Some(0), "the guild's lobby leads by default");
        apply(&mut p, "!lobby", lobby, true, false);
        assert_eq!(rank_in(Some(&p), "!lobby", lobby, Some(0)), None, "unpinning a default sticks");
        assert!(p.pinned.is_empty(), "a default is never in the player's own list");
        apply(&mut p, "!lobby", lobby, true, true);
        assert_eq!(rank_in(Some(&p), "!lobby", lobby, Some(0)), Some(0), "pinning it again forgets the unpin");
        assert!(p.unpinned.is_empty());
    }

    #[test]
    fn a_players_pins_follow_the_defaults_in_the_order_they_were_pinned() {
        let mut p = Pins::default();
        apply(&mut p, "!trade", Some("#trade:elsewhere"), false, true);
        apply(&mut p, "!dm", None, false, true);
        apply(&mut p, "!trade", Some("#trade:elsewhere"), false, true); // twice is once
        assert_eq!(p.pinned, vec!["!trade", "!dm"]);
        assert_eq!(rank_in(Some(&p), "!trade", Some("#trade:elsewhere"), None), Some(FIRST_PLAYER_RANK));
        assert_eq!(rank_in(Some(&p), "!dm", None, None), Some(FIRST_PLAYER_RANK + 1));
        assert!(rank_in(Some(&p), "!trade", None, None) < rank_in(Some(&p), "!dm", None, None));
        // Every player pin sits after every default.
        assert!(rank_in(Some(&p), "!dm", None, None) > Some(1));
        apply(&mut p, "!trade", None, false, false);
        assert_eq!(rank_in(Some(&p), "!trade", None, None), None);
        assert_eq!(p.pinned, vec!["!dm"]);
    }

    #[test]
    fn nobody_with_no_pins_gets_the_defaults_and_nothing_else() {
        assert_eq!(rank_in(None, "!x", Some("#help:s"), Some(1)), Some(1));
        assert_eq!(rank_in(None, "!x", None, None), None);
    }
}
