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

#[derive(Debug, Clone, Default)]
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
                    username: text(row.get("username")),
                    tag: text(row.get("tag")),
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
}

pub fn get(player_id: &str) -> Option<Ident> {
    PLAYERS.read().ok()?.get(player_id).cloned()
}

/// Everyone the directory knows, for the people picker.
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
        .find(|c| c.guild_id == guild_id)?;
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
    fn addressing_an_unknown_player_fails_loudly() {
        // Never fabricate a Matrix id: inventing a server would send a DM
        // invite into the void and look like the other player ignoring it.
        assert!(matrix_id_for("9-999999").is_err());
    }
}
