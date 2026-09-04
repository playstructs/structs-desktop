//! Who a Matrix id belongs to, in game terms.
//!
//! A Matrix localpart IS a player id (`@1-194:matrix.crew.oh.energy`), which
//! makes the mapping to game identity total and reversible. That single fact
//! carries two features:
//!
//!   * a timeline can show a player's real name, guild tag and portrait
//!     instead of a bare id, and
//!   * ANY player is directly addressable — their contact details are their
//!     player id plus their guild's homeserver, both of which are public.
//!
//! Identity comes from each guild's `/api/guild/{id}/roster`, the same bulk
//! source game_stats uses. There are a handful of guilds and one page each, so
//! the whole galaxy fits in one cheap sweep.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Ident {
    pub username: String,
    pub tag: String,
    pub guild_id: String,
    /// On-chain `pfpClientRenderAttributes` — a JSON string of layer indices,
    /// rendered by the same five-layer composer the roster and Team Ops use.
    pub pfp_attrs: Option<String>,
}

static PLAYERS: std::sync::LazyLock<RwLock<HashMap<String, Ident>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));
static FETCHED_AT: RwLock<u64> = RwLock::new(0);

// ── Survives a restart ──────────────────────────────────────────────────────
// Names, tags and portraits for the whole galaxy, plus the server names the
// homeservers taught us. Restored before the first fetch so every card and
// every chat line has a name at launch; `FETCHED_AT` stays 0 so the TTL
// refresh still runs and the live directory replaces it.
const DIRECTORY_CACHE: &str = "player_directory";
static RESTORED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct SavedDirectory {
    players: HashMap<String, Ident>,
    learned: HashMap<String, String>,
}

fn ensure_restored() {
    RESTORED.get_or_init(|| {
        let Some(saved) = crate::mcp::cache_store::load::<SavedDirectory>(DIRECTORY_CACHE) else { return };
        if let Ok(mut p) = PLAYERS.write() {
            if p.is_empty() {
                *p = saved.players;
            }
        }
        if let Ok(mut l) = LEARNED.write() {
            for (k, v) in saved.learned {
                l.entry(k).or_insert(v);
            }
        }
    });
}

fn persist_directory() {
    let snap = SavedDirectory {
        players: PLAYERS.read().map(|p| p.clone()).unwrap_or_default(),
        learned: LEARNED.read().map(|l| l.clone()).unwrap_or_default(),
    };
    if !snap.players.is_empty() {
        crate::mcp::cache_store::save_in_background(DIRECTORY_CACHE, snap);
    }
}

/// Usernames and portraits change rarely; guild membership less often still.
const TTL_SECS: u64 = 900;

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Refresh from every guild's roster, unless a recent sweep already did.
pub async fn ensure_fresh() {
    ensure_restored();
    {
        let at = *FETCHED_AT.read().unwrap();
        if at != 0 && super::auth::now_secs().saturating_sub(at) < TTL_SECS {
            return;
        }
    }
    // Claim the slot before awaiting so concurrent openers don't all sweep.
    *FETCHED_AT.write().unwrap() = super::auth::now_secs();

    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let mut found: HashMap<String, Ident> = HashMap::new();
    for cfg in crate::guild_config::get_guild_configs() {
        if cfg.guild_id.is_empty() {
            continue;
        }
        let roster = match client.guild.guild_roster(&cfg.guild_id).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[Comms] roster {}: {}", cfg.guild_id, e);
                continue;
            }
        };
        for row in roster.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let pid = text(row.get("id"));
            if pid.is_empty() {
                continue;
            }
            let attrs = text(row.get("pfp_client_render_attributes"));
            found.insert(
                pid,
                Ident {
                    // Sanitized even though the chain settles OWNERSHIP of this
                    // name. Owning a name and the name being legible are
                    // different things: nothing stops a player registering one
                    // that carries a bidi override or a zero-width joiner, and
                    // this string is the one the window trusts outright — it is
                    // the branch of `sender_display` that returns early with no
                    // player id beside it.
                    username: crate::matrix::identity::sanitize(&text(row.get("username"))),
                    tag: crate::matrix::identity::sanitize(&text(row.get("tag"))),
                    guild_id: cfg.guild_id.clone(),
                    pfp_attrs: if attrs.trim().is_empty() { None } else { Some(attrs) },
                },
            );
        }
    }
    if found.is_empty() {
        // Nothing learned — let the next caller try again rather than sitting
        // on an empty map for the full TTL.
        *FETCHED_AT.write().unwrap() = 0;
        return;
    }
    *PLAYERS.write().unwrap() = found;
    persist_directory();
}

pub fn get(player_id: &str) -> Option<Ident> {
    ensure_restored();
    PLAYERS.read().ok()?.get(player_id).cloned()
}

/// Players the chain says do not exist, so a bad id is asked about once
/// rather than on every repaint.
static MISSING: std::sync::LazyLock<RwLock<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashSet::new()));

/// Identity for ONE player, from the chain.
///
/// The bulk roster (`/api/guild/{id}/roster`) is a webapp route behind a login
/// session and it serves only its OWN guild — measured live on 2026-08-29, it
/// answers `authentication_error: Login required` for every guild including
/// the caller's. When it gives nothing the whole directory is empty, and the
/// window degrades to bare player ids and placeholder portraits everywhere:
/// no names, no tags, no faces, and no DMs at all, because addressing needs
/// the guild.
///
/// `structs/player/{id}` needs no session, serves every guild, and carries the
/// name, the guild and the portrait attributes. It is the reliable source; the
/// roster is only a bulk shortcut when it happens to work.
pub async fn resolve(player_id: &str) -> Option<Ident> {
    if let Some(known) = get(player_id) {
        return Some(known);
    }
    if MISSING.read().ok()?.contains(player_id) {
        return None;
    }
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let v = match client.entity("player", player_id).await {
        Ok(v) => v,
        Err(_) => {
            // A destroyed or invented id answers 500; remember so the next
            // repaint does not ask again.
            if let Ok(mut m) = MISSING.write() {
                m.insert(player_id.to_string());
            }
            return None;
        }
    };
    let p = v.get("Player")?;
    let guild_id = text(p.get("guildId"));
    let attrs = text(p.get("pfpClientRenderAttributes"));
    let ident = Ident {
        // Same reasoning as the roster path above: owned is not the same as
        // legible.
        username: crate::matrix::identity::sanitize(&text(p.get("name"))),
        // The chain has no guild TAG — that is the guild's own cosmetic name,
        // which the directory config already carries.
        tag: crate::guild_config::get_guild_configs()
            .into_iter()
            // `guild_of`: this may arrive as a session key when a second
            // identity is signed in. Idempotent for a plain guild id.
            .find(|c| c.guild_id == super::store::guild_of(&guild_id))
            .map(|c| c.guild_tag)
            .unwrap_or_default(),
        guild_id,
        pfp_attrs: if attrs.trim().is_empty() { None } else { Some(attrs) },
    };
    if let Ok(mut m) = PLAYERS.write() {
        m.insert(player_id.to_string(), ident.clone());
    }
    Some(ident)
}

/// Resolve a batch, skipping everything already known. Bounded per call: a
/// backfilled page can name a great many distinct senders.
pub async fn resolve_many(player_ids: &[String]) {
    const MAX: usize = 24;
    let mut done = 0;
    for id in player_ids {
        if done >= MAX {
            break;
        }
        if get(id).is_some() {
            continue;
        }
        resolve(id).await;
        done += 1;
    }
}

/// Every player id mentioned as a SENDER in a sync or messages response, so
/// they can be resolved before the timeline is rendered against them.
pub fn senders_in(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_senders(v, &mut out);
    out
}

fn collect_senders(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(sender)) = map.get("sender") {
                if let Some(pid) = player_id_of(sender) {
                    if !out.contains(&pid) {
                        out.push(pid);
                    }
                }
            }
            for child in map.values() {
                collect_senders(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_senders(child, out);
            }
        }
        _ => {}
    }
}

/// Everyone the directory knows, for the people picker.
/// Is this the on-chain name of some player?
///
/// A Matrix display name is self-chosen and unverified; a player's name comes
/// from the chain and cannot be taken. So a non-player calling themselves
/// "Marklifer" is impersonation, and the client has to notice — people
/// negotiate raids and agreements in these rooms.
///
/// A scan rather than an index: it only runs for senders who are NOT players,
/// which is a small minority (bots and service accounts), and a few thousand
/// string compares is nothing beside the network call that delivered the
/// message.
/// Put a player into the directory directly. Tests only — the real path is a
/// chain lookup, which a unit test has no business making.
#[cfg(test)]
pub fn remember_for_test(player_id: &str, ident: Ident) {
    if let Ok(mut m) = PLAYERS.write() {
        m.insert(player_id.to_string(), ident);
    }
}

#[cfg(test)]
pub fn forget_for_test(player_id: &str) {
    if let Ok(mut m) = PLAYERS.write() {
        m.remove(player_id);
    }
}

pub fn name_belongs_to_a_player(name: &str) -> bool {
    // Folded, not merely lowercased. An exact comparison misses every attack
    // worth running: `Marklifer` with a Cyrillic `а` is a different string and
    // an identical picture, so a lowercase match reported "no collision" and
    // the imitation rendered with no player id beside it.
    let needle = super::identity::fold(name);
    if needle.is_empty() {
        return false;
    }
    PLAYERS
        .read()
        .map(|m| m.values().any(|i| super::identity::fold(&i.username) == needle))
        .unwrap_or(false)
}

pub fn all() -> Vec<(String, Ident)> {
    PLAYERS
        .read()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// `@1-194:matrix.crew.oh.energy` → `1-194`. Returns None for anything that is
/// not a Matrix user id, so a malformed sender never becomes a lookup key.
pub fn player_id_of(user_id: &str) -> Option<String> {
    let rest = user_id.strip_prefix('@')?;
    let (local, _server) = rest.split_once(':')?;
    // Player ids are `<guild-ish>-<n>`; bots and service accounts are not.
    let mut parts = local.split('-');
    let a = parts.next()?;
    let b = parts.next()?;
    if parts.next().is_some() || a.is_empty() || b.is_empty() {
        return None;
    }
    if !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(local.to_string())
}

/// A guild's Matrix server name — the host of its published homeserver URL.
///
/// structs-tel sets `MATRIX_SERVER_NAME` to the client host (crew's live ids
/// are `@1-194:matrix.crew.oh.energy`, matching `https://matrix.crew.oh.energy`),
/// so the host is the server name. If a guild ever splits the two, the ids we
/// actually observe from that server win — see `learn_server_name`.
pub fn server_name_for_guild(guild_id: &str) -> Option<String> {
    if let Some(learned) = LEARNED.read().ok()?.get(guild_id) {
        return Some(learned.clone());
    }
    let cfg = crate::guild_config::get_guild_configs()
        .into_iter()
        .find(|c| c.guild_id == super::store::guild_of(guild_id))?;
    let url = cfg.matrix_url?;
    reqwest::Url::parse(&url).ok()?.host_str().map(|h| h.to_string())
}

static LEARNED: std::sync::LazyLock<RwLock<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Record the server name a guild's users actually carry, learned from a real
/// user id. Cheap insurance against a deploy whose server name differs from
/// its client URL — guessing wrong would address a DM to a server that does
/// not exist.
pub fn learn_server_name(guild_id: &str, user_id: &str) {
    let Some(server) = user_id.rsplit_once(':').map(|(_, s)| s.to_string()) else {
        return;
    };
    if server.is_empty() {
        return;
    }
    if let Ok(mut m) = LEARNED.write() {
        m.insert(guild_id.to_string(), server);
    }
}

/// The Matrix id for a player, resolving them from the chain if the directory
/// has never heard of them. The async twin of `matrix_id_for`.
pub async fn matrix_id_resolving(player_id: &str) -> Result<String, String> {
    resolve(player_id).await;
    matrix_id_for(player_id)
}

/// The Matrix id for a player: their player id at their own guild's server.
pub fn matrix_id_for(player_id: &str) -> Result<String, String> {
    let ident = get(player_id)
        .ok_or_else(|| format!("no player {} in the galaxy directory", player_id))?;
    let server = server_name_for_guild(&ident.guild_id).ok_or_else(|| {
        format!(
            "{}'s guild ({}) runs no comms server, so they cannot be messaged",
            if ident.username.is_empty() { player_id } else { &ident.username },
            ident.guild_id
        )
    })?;
    Ok(format!("@{}:{}", player_id, server))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matrix_id_yields_its_player_id() {
        assert_eq!(
            player_id_of("@1-194:matrix.crew.oh.energy").as_deref(),
            Some("1-194")
        );
        assert_eq!(player_id_of("@0-5:matrix.example").as_deref(), Some("0-5"));
    }

    #[test]
    fn service_accounts_are_not_players() {
        // The live Orbital Hydro room has an `orbitalhydro bot` and a
        // `chatbocks`; neither is a player and neither may be looked up as one.
        for id in [
            "@orbitalhydro-bot:matrix.crew.oh.energy",
            "@chatbocks:matrix.crew.oh.energy",
            "@1-194",
            "1-194:matrix.crew.oh.energy",
            "@:matrix.crew.oh.energy",
            "@a-b:matrix.crew.oh.energy",
        ] {
            assert!(player_id_of(id).is_none(), "{} was read as a player", id);
        }
    }

    #[test]
    fn a_learned_server_name_wins_over_the_url_guess() {
        learn_server_name("test-guild", "@1-1:actual.example");
        assert_eq!(
            server_name_for_guild("test-guild").as_deref(),
            Some("actual.example")
        );
    }

    #[test]
    fn senders_are_pulled_out_of_a_sync_response() {
        // The shape /sync actually returns: senders buried under
        // rooms → join → <room> → timeline → events.
        let v = serde_json::json!({
            "rooms": { "join": { "!r:h": {
                "timeline": { "events": [
                    { "sender": "@1-61:matrix.crew.oh.energy" },
                    { "sender": "@1-194:matrix.crew.oh.energy" },
                    { "sender": "@1-61:matrix.crew.oh.energy" }
                ]},
                "state": { "events": [{ "sender": "@1-9:matrix.crew.oh.energy" }] }
            }}}
        });
        let mut found = senders_in(&v);
        found.sort();
        assert_eq!(found, vec!["1-194", "1-61", "1-9"]);
    }

    #[test]
    fn non_players_are_not_collected_as_senders() {
        // Bots and service accounts share the timeline and are not players.
        let v = serde_json::json!({ "events": [
            { "sender": "@guild-bot:matrix.crew.oh.energy" },
            { "sender": "@crabla-ai:matrix.crab.la" },
            { "sender": "@1-61:matrix.crew.oh.energy" }
        ]});
        assert_eq!(senders_in(&v), vec!["1-61"]);
    }

    #[test]
    fn addressing_an_unknown_player_fails_loudly() {
        // Never fabricate a Matrix id: inventing a server would send a DM
        // invite into the void and look like the other player ignoring it.
        assert!(matrix_id_for("9-999999").is_err());
    }
}
