//! Finding channels that exist.
//!
//! The obvious mechanism — the homeserver's public room directory — does not
//! work here, and it is worth writing down why, because it looks like it
//! should. Measured against the live deployments on 2026-08-29:
//!
//!   * `GET /publicRooms` on crew.oh.energy returns **zero** rooms. The rooms
//!     are `join_rule: public` but were never *published to the directory*,
//!     which is a separate flag nobody set.
//!   * `GET /publicRooms?server=matrix.beta.playstructs.com` returns
//!     **M_FORBIDDEN**: Synapse will not proxy a directory query to another
//!     server unless configured to, and it is not.
//!
//! So a client that trusts the directory shows an empty Browse on a network
//! that in fact has channels on three homeservers. What DOES work, federated,
//! unauthenticated-by-the-other-side, and today:
//!
//!   * `GET /directory/room/{alias}` resolves an alias anywhere in the
//!     federation, and
//!   * `GET /_matrix/client/v1/room_summary/{alias}` returns the name, topic,
//!     member count and join rule of a room we are NOT in.
//!
//! Structs guilds name their rooms predictably (`#lobby:matrix.crab.la`,
//! `#orbital-hydro:matrix.crew.oh.energy`, `#sn-corp:matrix.beta.playstructs.com`),
//! so probing a short list of candidate aliases against every guild's
//! homeserver finds the real channels. That is what this module does.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

/// Room-name conventions seen across the live guilds, plus a slug of the
/// guild's own name. Short on purpose: each entry is a federated round trip.
const GENERIC_ALIASES: &[&str] = &["lobby", "general"];

const PROBE_TIMEOUT_SECS: u64 = 8;
const HOST_TTL_SECS: u64 = 3600;

/// guild_id → homeserver host, or `None` for "probed and there is none".
static HOSTS: std::sync::LazyLock<RwLock<HashMap<String, (u64, Option<String>)>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Built once. Probing is a cold path, so this matters less than it does for
/// the sync client — but a `reqwest::Client` owns a connection pool and a TLS
/// stack either way, and rebuilding it per probe buys nothing.
static PROBE: std::sync::LazyLock<Option<reqwest::Client>> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
        .ok()
});

fn http() -> Option<reqwest::Client> {
    PROBE.clone()
}

/// `shell.crab.la` → [`matrix.shell.crab.la`, `matrix.crab.la`].
///
/// Kilgore Crabla runs a homeserver at `matrix.crab.la` and does NOT list it in
/// guild.json, which is why a config-only client cannot see them at all. The
/// parent-domain candidate is what finds that case; without it the guild is
/// invisible to every player in the galaxy.
fn candidate_hosts(api_host: &str) -> Vec<String> {
    let mut out = vec![format!("matrix.{}", api_host)];
    let labels: Vec<&str> = api_host.split('.').collect();
    if labels.len() >= 3 {
        out.push(format!("matrix.{}", labels[1..].join(".")));
    }
    out
}

/// Does this host actually speak Matrix?
async fn is_homeserver(client: &reqwest::Client, host: &str) -> bool {
    let url = format!("https://{}/_matrix/client/versions", host);
    matches!(client.get(&url).send().await, Ok(r) if r.status().is_success())
}

/// The homeserver for a guild: the one it publishes, or the one it turns out
/// to run anyway. Cached, including the negative answer.
pub async fn homeserver_host(guild_id: &str) -> Option<String> {
    {
        let map = HOSTS.read().ok()?;
        if let Some((at, host)) = map.get(guild_id) {
            if super::auth::now_secs().saturating_sub(*at) < HOST_TTL_SECS {
                return host.clone();
            }
        }
    }
    let cfg = crate::guild_config::get_guild_configs()
        .into_iter()
        .find(|c| c.guild_id == guild_id)?;

    // Published wins — it is the guild's own statement of the answer.
    let published = cfg
        .matrix_url
        .as_deref()
        .and_then(|u| reqwest::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(|h| h.to_string()));

    let found = match published {
        Some(h) => Some(h),
        None => {
            // Not published: probe the conventional names before concluding the
            // guild has no comms at all.
            let client = http()?;
            let api_host = reqwest::Url::parse(&cfg.guild_api)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))?;
            let mut hit = None;
            for cand in candidate_hosts(&api_host) {
                if is_homeserver(&client, &cand).await {
                    eprintln!(
                        "[Comms] {} runs {} but does not publish it in guild.json",
                        guild_id, cand
                    );
                    hit = Some(cand);
                    break;
                }
            }
            hit
        }
    };

    if let Ok(mut map) = HOSTS.write() {
        map.insert(guild_id.to_string(), (super::auth::now_secs(), found.clone()));
    }
    found
}

/// `Kilgore Crabla` → `kilgore-crabla`. Guilds alias their room after
/// themselves, so the guild's own name is the best single guess.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Every alias worth trying for one guild.
pub fn candidate_aliases(guild_name: &str, host: &str) -> Vec<String> {
    let mut names: Vec<String> = GENERIC_ALIASES.iter().map(|s| s.to_string()).collect();
    let s = slug(guild_name);
    if !s.is_empty() && !names.contains(&s) {
        names.insert(0, s);
    }
    names
        .into_iter()
        .map(|n| format!("#{}:{}", n, host))
        .collect()
}

/// What a room looks like from outside it.
pub struct Summary {
    pub room_id: String,
    pub alias: String,
    pub name: String,
    pub topic: Option<String>,
    pub members: u64,
}

/// Ask OUR homeserver about a room anywhere in the federation. MSC3266's
/// `room_summary` answers for rooms we are not in, which is exactly the
/// question Browse asks.
async fn summarise(
    session: &super::store::Session,
    alias: &str,
) -> Option<Summary> {
    let client = http()?;
    let url = format!(
        "{}/_matrix/client/v1/room_summary/{}",
        session.homeserver.trim_end_matches('/'),
        urlseg(alias)
    );
    let resp = client
        .get(&url)
        .bearer_auth(&session.access_token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let room_id = v.get("room_id")?.as_str()?.to_string();
    // Only rooms anyone can walk into. Offering a Join that will be refused is
    // worse than not listing the room.
    if v.get("join_rule").and_then(|j| j.as_str()) != Some("public") {
        return None;
    }
    Some(Summary {
        name: v
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| alias.to_string()),
        topic: v.get("topic").and_then(|t| t.as_str()).map(|s| s.to_string()),
        members: v
            .get("num_joined_members")
            .and_then(|n| n.as_u64())
            .unwrap_or(0),
        room_id,
        alias: alias.to_string(),
    })
}

fn urlseg(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Every channel we can find across every guild's homeserver.
///
/// Deliberately breadth-first over guilds rather than depth-first over
/// aliases: the point is that each guild contributes something, and a guild
/// with an unconventional room name should not delay the ones that answer.
pub async fn federated_rooms(session: &super::store::Session) -> Vec<Summary> {
    let guilds = crate::guild_config::get_guild_configs();
    let mut out: Vec<Summary> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cfg in guilds {
        if cfg.guild_id.is_empty() {
            continue;
        }
        let Some(host) = homeserver_host(&cfg.guild_id).await else {
            continue;
        };
        for alias in candidate_aliases(&cfg.name, &host) {
            if let Some(s) = summarise(session, &alias).await {
                if seen.insert(s.room_id.clone()) {
                    out.push(s);
                }
                // One room per guild is what these deployments have; stop
                // spending federated round trips once it answers.
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_guild_name_becomes_its_alias() {
        // The live aliases these produce: #kilgore-crabla, #orbital-hydro,
        // #sn-corp.
        assert_eq!(slug("Kilgore Crabla"), "kilgore-crabla");
        assert_eq!(slug("Orbital Hydro"), "orbital-hydro");
        assert_eq!(slug("SN Corp"), "sn-corp");
        assert_eq!(slug("  Odd   Name!  "), "odd-name");
        assert_eq!(slug(""), "");
        assert_eq!(slug("!!!"), "");
    }

    #[test]
    fn an_unpublished_homeserver_is_still_findable() {
        // shell.crab.la is the guild API; the homeserver is matrix.crab.la,
        // one label up. Without the parent-domain candidate, Kilgore Crabla is
        // invisible to every client in the galaxy.
        let cands = candidate_hosts("shell.crab.la");
        assert!(cands.contains(&"matrix.crab.la".to_string()), "{:?}", cands);
        assert!(cands.contains(&"matrix.shell.crab.la".to_string()), "{:?}", cands);

        // A two-label domain has no parent worth trying.
        assert_eq!(candidate_hosts("crab.la"), vec!["matrix.crab.la".to_string()]);
    }

    #[test]
    fn the_guilds_own_name_is_tried_first() {
        let a = candidate_aliases("Kilgore Crabla", "matrix.crab.la");
        assert_eq!(a[0], "#kilgore-crabla:matrix.crab.la");
        // …then the conventions, one of which is where Crabla actually is.
        assert!(a.contains(&"#lobby:matrix.crab.la".to_string()), "{:?}", a);
    }

    #[test]
    fn an_alias_survives_as_one_path_segment() {
        // `#` and `:` both terminate a path otherwise.
        let e = urlseg("#lobby:matrix.crab.la");
        assert!(!e.contains('#') && !e.contains(':'), "{}", e);
        assert_eq!(e, "%23lobby%3Amatrix.crab.la");
    }
}
