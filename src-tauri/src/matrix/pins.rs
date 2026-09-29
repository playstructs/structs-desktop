//! Rooms pinned above every section of the list — the three Structs-wide
//! channels, which are pinned for every player by default, and whatever the
//! player pinned themselves.
//!
//! One rule for both: a pinned room carries a rank (`Room::home_rank`) and
//! sits in the "Pinned" group at the top, and the player may put them in any
//! order. Until they do, the defaults lead (`client::DEFAULT_PINS`, in that
//! order) and the player's own pins follow in the order they were pinned. A
//! default the player took OUT stays out — that is the whole difference
//! between "pinned for you" and "pinned by you".
//!
//! A pin is known by a KEY: a default by its alias (that is how a default is
//! defined, and a room id would be a different room after an upgrade), a
//! player's pin by its room id (a DM has no alias at all).
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
    /// Aliases of DEFAULT channels the player unpinned.
    #[serde(default)]
    pub unpinned: Vec<String>,
    /// The order the player arranged, as keys. Empty until they move
    /// something; anything pinned that is not in it yet goes after it.
    #[serde(default)]
    pub order: Vec<String>,
}

type File = HashMap<String, Pins>;

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

/// The key a room is pinned under, if it is pinned at all: its alias when
/// that alias is a default the player has not unpinned, else its room id
/// when the player pinned it.
pub fn key_in<'a>(
    pins: Option<&Pins>,
    room_id: &'a str,
    alias: Option<&'a str>,
    defaults: &[String],
) -> Option<&'a str> {
    if let Some(a) = alias {
        let is_default = defaults.iter().any(|d| d == a);
        let removed = pins.is_some_and(|p| p.unpinned.iter().any(|u| u == a));
        if is_default && !removed {
            return Some(a);
        }
    }
    pins.filter(|p| p.pinned.iter().any(|r| r == room_id)).map(|_| room_id)
}

/// Every pinned key, in the order the list shows them: what the player
/// arranged, then any default not yet placed, then any pin not yet placed.
pub fn effective(pins: Option<&Pins>, defaults: &[String]) -> Vec<String> {
    let empty = Pins::default();
    let p = pins.unwrap_or(&empty);
    let live = |k: &str| {
        (defaults.iter().any(|d| d == k) && !p.unpinned.iter().any(|u| u == k))
            || p.pinned.iter().any(|r| r == k)
    };
    let mut out: Vec<String> = Vec::new();
    for k in p.order.iter().chain(defaults.iter()).chain(p.pinned.iter()) {
        if live(k) && !out.iter().any(|o| o == k) {
            out.push(k.clone());
        }
    }
    out
}

/// Where a room sits in the Pinned group, or `None` when it is not pinned.
pub fn rank(user_id: &str, room_id: &str, alias: Option<&str>, defaults: &[String]) -> Option<u8> {
    let file = load();
    rank_in(file.get(user_id), room_id, alias, defaults)
}

/// The decision itself, with nothing global in it.
pub fn rank_in(pins: Option<&Pins>, room_id: &str, alias: Option<&str>, defaults: &[String]) -> Option<u8> {
    let key = key_in(pins, room_id, alias, defaults)?;
    effective(pins, defaults)
        .iter()
        .position(|k| k == key)
        .map(|i| i.min(u8::MAX as usize) as u8)
}

/// Pin or unpin a room for one identity.
pub fn set(user_id: &str, room_id: &str, alias: Option<&str>, defaults: &[String], pinned: bool) {
    let mut file = load();
    let p = file.entry(user_id.to_string()).or_default();
    apply(p, room_id, alias, defaults, pinned);
    save(&file);
}

pub fn apply(p: &mut Pins, room_id: &str, alias: Option<&str>, defaults: &[String], pinned: bool) {
    let default_alias = alias.filter(|a| defaults.iter().any(|d| d == a));
    if pinned {
        match default_alias {
            // Pinning a default again simply forgets that it was taken out.
            Some(a) => p.unpinned.retain(|u| u != a),
            None => {
                if !p.pinned.iter().any(|r| r == room_id) {
                    p.pinned.push(room_id.to_string());
                }
            }
        }
    } else {
        p.pinned.retain(|r| r != room_id);
        p.order.retain(|k| k != room_id);
        if let Some(a) = default_alias {
            p.order.retain(|k| k != a);
            if !p.unpinned.iter().any(|u| u == a) {
                p.unpinned.push(a.to_string());
            }
        }
    }
}

/// Move a pinned room one place up or down. Returns whether it moved — the
/// first cannot go up, the last cannot go down, and a room that is not
/// pinned has no place to move from.
pub fn shift(user_id: &str, room_id: &str, alias: Option<&str>, defaults: &[String], up: bool) -> bool {
    let mut file = load();
    let p = file.entry(user_id.to_string()).or_default();
    let moved = shift_in(p, room_id, alias, defaults, up);
    if moved {
        save(&file);
    }
    moved
}

pub fn shift_in(p: &mut Pins, room_id: &str, alias: Option<&str>, defaults: &[String], up: bool) -> bool {
    let Some(key) = key_in(Some(p), room_id, alias, defaults).map(String::from) else {
        return false;
    };
    let mut order = effective(Some(p), defaults);
    let Some(i) = order.iter().position(|k| *k == key) else { return false };
    let j = if up {
        match i.checked_sub(1) {
            Some(j) => j,
            None => return false,
        }
    } else {
        i + 1
    };
    if j >= order.len() {
        return false;
    }
    order.swap(i, j);
    // The whole arrangement is kept, not just the move: from here on the
    // order is the player's, defaults and all.
    p.order = order;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Vec<String> {
        ["#sn-corp:h", "#help:h", "#infrastructure:h"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_three_defaults_lead_until_the_player_says_otherwise() {
        let d = defaults();
        assert_eq!(rank_in(None, "!a", Some("#sn-corp:h"), &d), Some(0));
        assert_eq!(rank_in(None, "!b", Some("#help:h"), &d), Some(1));
        assert_eq!(rank_in(None, "!c", Some("#infrastructure:h"), &d), Some(2));
        assert_eq!(rank_in(None, "!x", Some("#orbital-hydro:oh"), &d), None, "a guild lobby is the player's to pin");
        assert_eq!(rank_in(None, "!dm", None, &d), None);
    }

    #[test]
    fn a_default_is_pinned_until_the_player_takes_it_out() {
        let d = defaults();
        let mut p = Pins::default();
        apply(&mut p, "!b", Some("#help:h"), &d, false);
        assert_eq!(rank_in(Some(&p), "!b", Some("#help:h"), &d), None, "unpinning a default sticks");
        assert_eq!(rank_in(Some(&p), "!c", Some("#infrastructure:h"), &d), Some(1), "and the rest close up");
        assert!(p.pinned.is_empty(), "a default is never in the player's own list");
        apply(&mut p, "!b", Some("#help:h"), &d, true);
        assert_eq!(rank_in(Some(&p), "!b", Some("#help:h"), &d), Some(1), "pinning it again forgets the unpin");
        assert!(p.unpinned.is_empty());
    }

    #[test]
    fn a_players_pins_follow_the_defaults_in_the_order_they_were_pinned() {
        let d = defaults();
        let mut p = Pins::default();
        apply(&mut p, "!trade", Some("#trade:elsewhere"), &d, true);
        apply(&mut p, "!dm", None, &d, true);
        apply(&mut p, "!trade", Some("#trade:elsewhere"), &d, true); // twice is once
        assert_eq!(p.pinned, vec!["!trade", "!dm"]);
        assert_eq!(rank_in(Some(&p), "!trade", Some("#trade:elsewhere"), &d), Some(3));
        assert_eq!(rank_in(Some(&p), "!dm", None, &d), Some(4));
        apply(&mut p, "!trade", None, &d, false);
        assert_eq!(rank_in(Some(&p), "!trade", None, &d), None);
        assert_eq!(rank_in(Some(&p), "!dm", None, &d), Some(3));
    }

    #[test]
    fn the_player_may_put_anything_anywhere_including_above_a_default() {
        let d = defaults();
        let mut p = Pins::default();
        apply(&mut p, "!lobby", Some("#orbital-hydro:oh"), &d, true);
        assert_eq!(rank_in(Some(&p), "!lobby", Some("#orbital-hydro:oh"), &d), Some(3));
        // Up three times: to the very top, over all three defaults.
        for _ in 0..3 {
            assert!(shift_in(&mut p, "!lobby", Some("#orbital-hydro:oh"), &d, true));
        }
        assert_eq!(rank_in(Some(&p), "!lobby", Some("#orbital-hydro:oh"), &d), Some(0));
        assert_eq!(rank_in(Some(&p), "!a", Some("#sn-corp:h"), &d), Some(1));
        assert!(!shift_in(&mut p, "!lobby", Some("#orbital-hydro:oh"), &d, true), "the first cannot go up");
        // A default moves like anything else.
        assert!(shift_in(&mut p, "!c", Some("#infrastructure:h"), &d, false) == false, "the last cannot go down");
        assert!(shift_in(&mut p, "!c", Some("#infrastructure:h"), &d, true));
        assert_eq!(rank_in(Some(&p), "!c", Some("#infrastructure:h"), &d), Some(2));
        assert_eq!(rank_in(Some(&p), "!b", Some("#help:h"), &d), Some(3));
        // Something pinned AFTER the arrangement goes to the end of it.
        apply(&mut p, "!late", None, &d, true);
        assert_eq!(rank_in(Some(&p), "!late", None, &d), Some(4));
        // Unpinning takes it out of the arrangement too.
        apply(&mut p, "!lobby", Some("#orbital-hydro:oh"), &d, false);
        assert_eq!(effective(Some(&p), &d), vec!["#sn-corp:h", "#infrastructure:h", "#help:h", "!late"]);
    }

    #[test]
    fn a_room_that_is_not_pinned_has_nowhere_to_move_from() {
        let d = defaults();
        let mut p = Pins::default();
        assert!(!shift_in(&mut p, "!x", None, &d, true));
        assert!(p.order.is_empty());
    }
}
