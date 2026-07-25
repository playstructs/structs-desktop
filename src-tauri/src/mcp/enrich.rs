//! GRASS enrichment — id → name lookups so the live event feed reads like the
//! game, not a debug log. Sources, cheapest first:
//!   * team players: roster cache + vplayer registry (in-memory)
//!   * guilds: guild_config (discovery upserts every chain guild w/ name)
//!   * struct types: GAME_STATE.struct_types (synced from the webapp catalog)
//!   * anyone/anything else: lazy LCD reads, cached forever (names are
//!     append-mostly), single-flighted, capped.
//!
//! `note_event` is called on every grass event (cheap scan; fetches spawn in
//! the background). Newly-resolved names are pushed to the board as a
//! `grass-lookups` event so live rows upgrade in place; the full maps ride the
//! `mcp_grass_recent` back-fill.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, RwLock};

use serde_json::{json, Value};

use crate::mcp::event_buffer::GameEvent;

/// player_id -> username ("" = confirmed nameless; don't refetch).
static PLAYERS: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
/// struct_id -> struct type NAME ("" = unresolved-but-fetched).
static STRUCTS: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
/// Ids currently being fetched (both kinds — ids are globally unique per kind
/// prefix, but we key as "kind:id" to be safe).
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Hard caps so a hostile/very busy galaxy can't grow the maps unbounded.
const MAX_CACHE: usize = 2000;

fn cache_get(map: &RwLock<HashMap<String, String>>, id: &str) -> Option<String> {
    map.read().ok()?.get(id).cloned()
}

fn cache_put(map: &RwLock<HashMap<String, String>>, id: &str, name: String) {
    if let Ok(mut m) = map.write() {
        if m.len() < MAX_CACHE || m.contains_key(id) {
            m.insert(id.to_string(), name);
        }
    }
}

/// Seed the player map from what the app already knows (team names).
fn seed_players() {
    let mut seeds: Vec<(String, String)> = Vec::new();
    for row in crate::mcp::roster_cache::all_rows() {
        seeds.push((row.player_id.clone(), row.name.clone()));
    }
    if let Ok(reg) = crate::mcp::virtual_players::REGISTRY.read() {
        for p in &reg.players {
            if let Some(pid) = &p.player_id {
                seeds.push((pid.clone(), p.name.clone()));
            }
        }
    }
    if let Ok(mut m) = PLAYERS.write() {
        for (id, name) in seeds {
            m.entry(id).or_insert(name);
        }
    }
}

/// bech32 address -> a label we can show.
///
/// The ledger keys rows on `address`, not on a player id, so without this
/// "who did I actually pay" reads as a wall of `structs1…`. Our own team is
/// resolvable locally — the vplayer registry stores an address per player, and
/// the primary's is in game state.
pub fn addresses_map() -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(reg) = crate::mcp::virtual_players::REGISTRY.read() {
        for p in &reg.players {
            if p.address.is_empty() {
                continue;
            }
            let label = match &p.player_id {
                Some(pid) => format!("{} ({})", p.name, pid),
                None => p.name.clone(),
            };
            out.insert(p.address.clone(), label);
        }
    }
    if let Ok(gs) = crate::game_state::GAME_STATE.read() {
        if let Some(addr) = gs.wallet_address.clone() {
            if !addr.is_empty() {
                out.insert(addr, "primary".to_string());
            }
        }
    }
    out
}

/// guild_id -> name from the persisted guild configs (discovery-fresh).
fn guilds_map() -> HashMap<String, String> {
    crate::guild_config::load_configs()
        .into_iter()
        .filter(|c| !c.guild_id.is_empty() && !c.name.is_empty())
        .map(|c| (c.guild_id, c.name))
        .collect()
}

/// struct type id -> display name from the synced catalog.
fn struct_types_map() -> HashMap<String, String> {
    crate::game_state::GAME_STATE
        .read()
        .map(|gs| {
            gs.struct_types
                .iter()
                .map(|(id, st)| (id.clone(), st.name.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Everything the grass renderer needs, in one JSON object.
pub fn lookups_json() -> Value {
    seed_players();
    let players = PLAYERS.read().map(|m| m.clone()).unwrap_or_default();
    let structs = STRUCTS.read().map(|m| m.clone()).unwrap_or_default();
    json!({
        "addresses": addresses_map(),
        "players": players,
        "structs": structs,
        "guilds": guilds_map(),
        "struct_types": struct_types_map(),
    })
}

/// Does this look like an entity id ("1-433", "5-7280")? Kind prefix decides
/// what it is: 1- player, 5- struct (per the chain's id scheme).
fn id_kind(id: &str) -> Option<&'static str> {
    let (prefix, rest) = id.split_once('-')?;
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match prefix {
        "1" => Some("player"),
        "5" => Some("struct"),
        _ => None,
    }
}

/// Scan a grass event for player/struct ids we can't name yet. Returns the
/// (kind, id) pairs to fetch — pure, unit-tested; spawning happens in
/// `note_event`.
fn unknown_ids(event: &GameEvent) -> Vec<(&'static str, String)> {
    let mut candidates: Vec<String> = Vec::new();
    for seg in event.subject.split('.') {
        candidates.push(seg.to_string());
    }
    if let Some(obj) = event.detail.as_object() {
        for (k, v) in obj {
            let id_like = k == "player_id"
                || k == "struct_id"
                || k.ends_with("_struct_id")
                || k == "counterparty"
                || k == "object_id";
            if !id_like {
                continue;
            }
            if let Some(s) = v.as_str() {
                candidates.push(s.to_string());
            }
        }
    }
    let mut out: Vec<(&'static str, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for c in candidates {
        let Some(kind) = id_kind(&c) else { continue };
        if !seen.insert(c.clone()) {
            continue;
        }
        let known = match kind {
            "player" => cache_get(&PLAYERS, &c).is_some(),
            _ => cache_get(&STRUCTS, &c).is_some(),
        };
        if !known {
            out.push((kind, c));
        }
    }
    out
}

/// Cheap per-event hook: queue background LCD fetches for unnamed ids and
/// push resolved names to the board. Never blocks the event path.
pub fn note_event(app: &tauri::AppHandle, event: &GameEvent) {
    seed_players();
    let targets = unknown_ids(event);
    if targets.is_empty() {
        return;
    }
    for (kind, id) in targets {
        {
            let mut inflight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
            if !inflight.insert(format!("{kind}:{id}")) {
                continue;
            }
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let client = crate::mcp::cosmos_client::CosmosClient::new();
            let resolved: Option<(&'static str, String)> = match kind {
                "player" => client.query_entity("player", &id).await.ok().map(|e| {
                    let name = e
                        .get("Player")
                        .and_then(|p| p.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    ("players", name)
                }),
                _ => client.query_entity("struct", &id).await.ok().map(|e| {
                    // Struct entity → type id → catalog name.
                    let s = e.get("Struct").unwrap_or(&e);
                    let tid = crate::mcp::loop_util::extract_type_id(s);
                    let name = struct_types_map().get(&tid).cloned().unwrap_or_default();
                    ("structs", name)
                }),
            };
            if let Some((map_key, name)) = resolved {
                match map_key {
                    "players" => cache_put(&PLAYERS, &id, name.clone()),
                    _ => cache_put(&STRUCTS, &id, name.clone()),
                }
                // Only bother the board when we actually learned something.
                if !name.is_empty() {
                    crate::mcp::web_board::emit_board(
                        &app,
                        "grass-lookups",
                        json!({ map_key: { id.clone(): name } }),
                    );
                }
            }
            IN_FLIGHT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&format!("{kind}:{id}"));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(subject: &str, detail: Value) -> GameEvent {
        GameEvent {
            category: "test".into(),
            subject: subject.into(),
            detail,
            timestamp: 0.0,
        }
    }

    #[test]
    fn scans_subject_and_id_keys() {
        let e = ev(
            "structs.planet.2-620.1-433",
            json!({ "struct_id": "5-7280", "player_id": "1-433", "seq": 40, "status": 35 }),
        );
        let ids = unknown_ids(&e);
        // planet 2-620 is not a fetchable kind; 1-433 appears twice → once.
        assert!(ids.contains(&("player", "1-433".to_string())));
        assert!(ids.contains(&("struct", "5-7280".to_string())));
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn ignores_non_ids_and_known_entries() {
        cache_put(&PLAYERS, "1-999999", "cached".into());
        let e = ev(
            "consensus",
            json!({ "player_id": "1-999999", "height": 1702522, "updated_at": "2026-07-20" }),
        );
        assert!(unknown_ids(&e).is_empty());
    }
}
