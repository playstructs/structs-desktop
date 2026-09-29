//! A room for an OBJECT, not for an encounter.
//!
//! A raid is an event; a planet is a place and a fleet is a thing. Both of
//! those have a conversation that outlives any one engagement — "we have lost
//! this planet twice this month", "this fleet is short a water hull" — so the
//! room belongs to the object, and a raid is simply the busiest that room ever
//! gets. Both sides of a contested planet end up in its room by joining it,
//! which is why there is no notion of "sides" anywhere in here.
//!
//! Two decisions are encoded, and both were the player's:
//!
//! * **One room per object, permanently.** Planets are raided again and again,
//!   so the scrollback becomes that planet's history rather than a fragment of
//!   one afternoon.
//! * **Hosted by the OWNER's guild.** The defender's guild keeps the record of
//!   its own planet, and the room outlives whoever happens to be attacking it.
//!
//! Since 2026-09-28 the rooms are made by the owner guild's API, never by a
//! player: a homeserver following GUILD-CHAT-STANDARD refuses `createRoom`
//! with a public preset or an alias from anyone but its guild-bot. The client
//! resolves the alias on the owner's homeserver and, on 404, asks that guild's
//! `chat/room/ensure` to make it — signed with the player's chain key, which
//! works on any guild's API. See `ensure` and `verdict`.

use serde_json::{json, Value};

/// The object types that get a room.
///
/// Not structs (a struct is a component of a fleet, and its conversation is
/// the fleet's), not providers or guilds (they already have owners and
/// channels), and not players — a player has a DM.
pub fn has_room(kind: u8) -> bool {
    matches!(kind, 2 | 9)
}

/// `2-15361` → `planet`, `9-61` → `fleet`: the `kind` the ensure endpoint
/// takes, and the first word of the alias.
pub fn kind_word(object_id: &str) -> Option<&'static str> {
    let (kind, _) = super::refs::parse_id(object_id)?;
    match kind {
        2 => Some("planet"),
        9 => Some("fleet"),
        _ => None,
    }
}

/// `2-15361` → `planet-2-15361`, `9-61` → `fleet-9-61`.
///
/// The type is spelled out rather than left as a number so the alias reads as
/// something in a channel list: `#planet-2-15361` says what it is, `#2-15361`
/// does not. The id is kept whole — never a prefix of it — because a truncated
/// chain id is the oldest bug in this codebase.
pub fn alias_localpart(object_id: &str) -> Option<String> {
    let word = kind_word(object_id)?;
    Some(format!("{word}-{object_id}"))
}

/// Whether an alias localpart names an object room rather than a guild
/// channel. Used to keep `#planet-…` and `#fleet-…` out of the channel
/// furniture at the top of the list.
pub fn is_object_localpart(local: &str) -> bool {
    local.starts_with("planet-") || local.starts_with("fleet-")
}

/// The full alias, given the server that hosts it.
///
/// Split from [`alias_localpart`] so the naming can be tested without a chain
/// or a homeserver, which is most of what there is to get wrong here.
pub fn alias_on(object_id: &str, server: &str) -> Option<String> {
    let local = alias_localpart(object_id)?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    Some(format!("#{local}:{server}"))
}

/// Who owns this object, and therefore whose guild hosts its room.
///
/// The chain is the authority. Reading the owner from a card the window
/// already holds would be faster and wrong: a planet changes hands, and the
/// room has to follow the CURRENT owner rather than whoever was named in a
/// message somebody sent last week.
async fn owner_of(object_id: &str) -> Option<String> {
    let (kind, _) = super::refs::parse_id(object_id)?;
    let entity = match kind {
        2 => "planet",
        9 => "fleet",
        _ => return None,
    };
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let v = client.entity(entity, object_id).await.ok()?;
    // The chain wraps the record in its type name — `{ "Planet": { … } }`.
    let record = v.get(match kind {
        2 => "Planet",
        _ => "Fleet",
    })?;
    let owner = record.get("owner")?.as_str()?.trim().to_string();
    if owner.is_empty() {
        None
    } else {
        Some(owner)
    }
}

/// The guild that hosts an object's room: its id, its API and its homeserver
/// name. Everything the ensure flow needs, from the chain and that guild's
/// own manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerGuild {
    pub guild_id: String,
    pub guild_api: String,
    pub server: String,
}

/// Resolve the owner's guild through the chain and its manifest.
///
/// `None` for every ordinary miss — an id with no room, an owner the directory
/// has not seen, a guild that publishes no homeserver. A caller that cannot
/// find the room simply does not offer one, which is the right behaviour for a
/// rail beside a map. A guild found to run no chat is remembered for a while,
/// so a raid window on one of its planets does not fetch its manifest again
/// every time it opens.
pub async fn owner_guild(object_id: &str) -> Option<OwnerGuild> {
    owner_guild_or_why(object_id).await.ok()
}

/// The same, saying WHY when there is no host — a planet that is not on
/// chain and a guild that runs no chat are different things to the player
/// who just tried to open a room.
pub async fn owner_guild_or_why(object_id: &str) -> Result<OwnerGuild, String> {
    alias_localpart(object_id).ok_or_else(|| format!("{object_id} does not get a room"))?;
    let owner = owner_of(object_id)
        .await
        .ok_or_else(|| format!("{object_id} is not on chain, or has no owner"))?;
    super::directory::ensure_fresh().await;
    let ident = super::directory::get(&owner)
        .ok_or_else(|| format!("{object_id}'s owner {owner} is not in the directory yet"))?;
    guild_by_id(&ident.guild_id)
        .await
        .ok_or_else(|| format!("{object_id}'s owner guild {} publishes no chat service", ident.guild_id))
}

/// The same, for a guild the ensure endpoint named in a 409.
pub async fn guild_at(guild_id: &str, endpoint: &str) -> Option<OwnerGuild> {
    let cfg = crate::guild_directory::manifest_at(guild_id, endpoint).await.ok()?;
    owner_guild_from(cfg)
}

async fn guild_by_id(guild_id: &str) -> Option<OwnerGuild> {
    if no_chat_recently(guild_id) {
        return None;
    }
    let cfg = match crate::guild_directory::manifest_for(guild_id).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Comms] {guild_id}: manifest: {e}");
            return None;
        }
    };
    let found = owner_guild_from(cfg);
    if found.is_none() {
        note_no_chat(guild_id);
    }
    found
}

fn owner_guild_from(cfg: crate::guild_config::GuildConfig) -> Option<OwnerGuild> {
    let server = super::directory::server_name_for_guild(&cfg.guild_id).or_else(|| {
        let url = cfg.matrix_url.clone()?;
        reqwest::Url::parse(&url).ok()?.host_str().map(|h| h.to_string())
    })?;
    if cfg.guild_api.trim().is_empty() {
        return None;
    }
    Some(OwnerGuild { guild_id: cfg.guild_id, guild_api: cfg.guild_api, server })
}

const NO_CHAT_TTL_SECS: u64 = 15 * 60;
static NO_CHAT: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn no_chat_recently(guild_id: &str) -> bool {
    NO_CHAT
        .lock()
        .ok()
        .and_then(|m| m.get(guild_id).copied())
        .is_some_and(|until| super::auth::now_secs() < until)
}

fn note_no_chat(guild_id: &str) {
    if let Ok(mut m) = NO_CHAT.lock() {
        m.insert(guild_id.to_string(), super::auth::now_secs() + NO_CHAT_TTL_SECS);
    }
}

/// The homeserver an alias lives on.
pub fn server_of(alias: &str) -> Option<&str> {
    // An alias is `#localpart:server`. Split from the RIGHT so a localpart
    // that somehow contains a colon cannot steal the server.
    alias.rsplit_once(':').map(|(_, s)| s).filter(|s| !s.is_empty())
}

// ── The ensure endpoint ─────────────────────────────────────────────────────

/// What a guild API's answer to `chat/room/ensure` means for us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The room exists (made now, or already there): join it via `server`.
    Room { room_id: String, server: String, created: bool },
    /// Our owner lookup was stale; this guild hosts it. Fetch its manifest
    /// and ask there, once.
    Follow { guild_id: String, endpoint: String },
    /// Our signature was refused. Sign again, once.
    Reauth,
    /// The object does not exist (yet). No room, and no retrying.
    Gone(String),
    /// The guild's chat is down or not configured. Back off.
    Unavailable(String),
    /// We sent something malformed. A bug, not a condition.
    Bug(String),
}

fn envelope_error(body: &Value) -> String {
    body.get("errors")
        .and_then(|e| e.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("{}: {}", k, v.as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

/// Read the endpoint's answer. Pure, so every row of the response table in
/// the handoff can be pinned without a guild API.
pub fn verdict(status: u16, body: &Value) -> Verdict {
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    let text = |k: &str| data.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    match status {
        200 | 201 => match (text("room_id"), text("server_name")) {
            (Some(room_id), Some(server)) if !room_id.is_empty() && !server.is_empty() => Verdict::Room {
                room_id,
                server,
                created: data.get("created").and_then(|c| c.as_bool()).unwrap_or(status == 201),
            },
            _ => Verdict::Bug(format!("ensure answered {status} without a room_id and server_name")),
        },
        409 => match (text("owner_guild_id"), text("owner_guild_endpoint")) {
            (Some(guild_id), Some(endpoint)) if !guild_id.is_empty() && !endpoint.is_empty() => {
                Verdict::Follow { guild_id, endpoint }
            }
            _ => Verdict::Bug("ensure answered 409 without naming the owner guild".into()),
        },
        401 => Verdict::Reauth,
        404 => Verdict::Gone(non_empty(envelope_error(body), "the object does not exist")),
        400 => Verdict::Bug(non_empty(envelope_error(body), "ensure refused the request")),
        502 | 503 => Verdict::Unavailable(non_empty(envelope_error(body), "chat is unavailable for this guild")),
        s => Verdict::Unavailable(non_empty(envelope_error(body), &format!("ensure answered HTTP {s}"))),
    }
}

fn non_empty(s: String, fallback: &str) -> String {
    if s.is_empty() { fallback.to_string() } else { s }
}

/// The room the owner guild's API made (or already had) for this object.
#[derive(Debug, Clone)]
pub struct Ensured {
    pub room_id: String,
    pub server: String,
    pub created: bool,
    /// The guild that actually hosts it — after a 409 this differs from the
    /// one we first asked.
    pub guild: OwnerGuild,
}

/// Ask the owner guild to make (or find) the object's room. Signed with the
/// player's chain key per request, as the endpoint requires; follows one 409
/// to the guild it names; re-signs once on 401.
pub async fn ensure(
    app: &tauri::AppHandle,
    session_key: &str,
    object_id: &str,
    guild: &OwnerGuild,
) -> Result<Ensured, String> {
    let kind = kind_word(object_id).ok_or_else(|| format!("{object_id} does not get a room"))?;
    let as_player = super::store::player_of(session_key);
    let mut target = guild.clone();
    let mut followed = false;
    let mut resigned = false;
    loop {
        let (status, body) = ensure_once(app, kind, object_id, &target, as_player).await?;
        match verdict(status, &body) {
            Verdict::Room { room_id, server, created } => {
                return Ok(Ensured { room_id, server, created, guild: target });
            }
            Verdict::Follow { guild_id, endpoint } => {
                if followed {
                    return Err(format!("{object_id}'s room keeps being referred elsewhere ({guild_id})"));
                }
                followed = true;
                target = guild_at(&guild_id, &endpoint)
                    .await
                    .ok_or_else(|| format!("{guild_id} hosts {object_id}'s room but publishes no usable chat service"))?;
            }
            Verdict::Reauth => {
                if resigned {
                    return Err(format!(
                        "{} refused our signature twice — check the clock and the login key",
                        target.guild_id
                    ));
                }
                resigned = true;
            }
            Verdict::Gone(why) => return Err(format!("{object_id}: {why}")),
            Verdict::Unavailable(why) => return Err(format!("{}: {why}", target.guild_id)),
            Verdict::Bug(why) => return Err(format!("ensure {object_id} on {}: {why}", target.guild_id)),
        }
    }
}

async fn ensure_once(
    app: &tauri::AppHandle,
    kind: &str,
    object_id: &str,
    guild: &OwnerGuild,
    as_player: Option<&str>,
) -> Result<(u16, Value), String> {
    let http = reqwest::Client::builder()
        .dns_resolver(super::dns::resolver())
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("StructsDesktop/comms")
        .build()
        .map_err(|e| e.to_string())?;
    let api = guild.guild_api.trim_end_matches('/');
    // The guild's clock, not ours: the signature is good for ten minutes by
    // the SERVER's reckoning, and a skewed local clock fails as a signature
    // error that looks like a key problem — the same rule as login.
    let ts = super::auth::guild_timestamp(&http, api).await?;
    let signed = super::auth::sign_chatroom(app, kind, object_id, &ts, as_player).await?;
    let url = format!("{api}/chat/room/ensure");
    let body = json!({
        "kind": kind,
        "id": object_id,
        "address": signed.address,
        "pubkey": signed.pubkey,
        "signature": signed.signature,
        "unix_timestamp": ts.parse::<u64>().map(Value::from).unwrap_or_else(|_| Value::from(ts.clone())),
    });
    let resp = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{}: ensure: {e}", guild.guild_id))?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    Ok((status, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_places_and_things_get_a_room() {
        // A planet is a place; a fleet is a thing. Both outlive a raid.
        assert!(has_room(2));
        assert!(has_room(9));
        // A struct's conversation is its fleet's, a player's is a DM, and a
        // provider or guild already has somewhere to be talked about.
        for kind in [0, 1, 4, 5, 10] {
            assert!(!has_room(kind), "kind {kind} should not get a room");
        }
    }

    #[test]
    fn an_alias_says_what_the_thing_is() {
        assert_eq!(alias_localpart("2-15361").unwrap(), "planet-2-15361");
        assert_eq!(alias_localpart("9-61").unwrap(), "fleet-9-61");
        assert_eq!(kind_word("2-15361"), Some("planet"));
        assert_eq!(kind_word("9-61"), Some("fleet"));
        // Not every id is a room.
        assert!(alias_localpart("5-2184").is_none()); // a struct
        assert!(alias_localpart("1-194").is_none()); // a player
        // Nor is every string an id.
        assert!(alias_localpart("").is_none());
        assert!(alias_localpart("planet").is_none());
        assert!(alias_localpart("2-").is_none());
        // Object rooms are not channel furniture.
        assert!(is_object_localpart("planet-2-15361"));
        assert!(is_object_localpart("fleet-9-61"));
        assert!(!is_object_localpart("help"));
        assert!(!is_object_localpart("planets"), "a channel merely CALLED planets is a channel");
    }

    #[test]
    fn the_whole_id_survives_into_the_alias() {
        // `2-1` is a prefix of `2-15361`. Two planets must never share a room,
        // and a truncated chain id is the oldest bug in this codebase.
        let a = alias_localpart("2-1").unwrap();
        let b = alias_localpart("2-15361").unwrap();
        assert_ne!(a, b);
        assert!(b.ends_with("-2-15361"));
        assert!(a.ends_with("-2-1"));
    }

    #[test]
    fn the_owners_guild_hosts_it() {
        assert_eq!(
            alias_on("2-15361", "matrix.crew.oh.energy").unwrap(),
            "#planet-2-15361:matrix.crew.oh.energy",
        );
        // The same planet on a different guild's server is a different alias —
        // which is the point: the room follows the OWNER.
        assert_ne!(
            alias_on("2-15361", "matrix.crew.oh.energy"),
            alias_on("2-15361", "matrix.beta.playstructs.com"),
        );
        // No server, no alias: better to have no room than one addressed at
        // nowhere.
        assert!(alias_on("2-15361", "").is_none());
        assert!(alias_on("2-15361", "   ").is_none());
    }

    #[test]
    fn the_server_is_taken_from_the_right() {
        assert_eq!(server_of("#planet-2-1:matrix.oh.energy"), Some("matrix.oh.energy"));
        // A colon in the localpart must not become the server.
        assert_eq!(server_of("#odd:name:matrix.oh.energy"), Some("matrix.oh.energy"));
        assert_eq!(server_of("#planet-2-1:"), None);
        assert_eq!(server_of("no-colon"), None);
    }

    /* Every row of the handoff's response table, as the client reads it.
     * Pure, so a guild API is not needed to know that a 404 is "no room, no
     * retry" and a 409 is "ask the guild it names".
     */
    #[test]
    fn the_ensure_table_is_read_row_by_row() {
        let ok = json!({ "success": true, "data": { "room_id": "!r:matrix.crew.oh.energy",
            "alias": "#planet-2-22432:matrix.crew.oh.energy", "server_name": "matrix.crew.oh.energy", "created": true } });
        assert_eq!(verdict(201, &ok), Verdict::Room {
            room_id: "!r:matrix.crew.oh.energy".into(), server: "matrix.crew.oh.energy".into(), created: true });
        let had = json!({ "data": { "room_id": "!r:s", "server_name": "s", "created": false } });
        assert_eq!(verdict(200, &had), Verdict::Room { room_id: "!r:s".into(), server: "s".into(), created: false });

        let elsewhere = json!({ "success": false, "errors": { "owner_in_other_guild": "owned by 0-5" },
            "data": { "owner_guild_id": "0-5", "owner_guild_endpoint": "https://beta.playstructs.com/guild.json" } });
        assert_eq!(verdict(409, &elsewhere), Verdict::Follow {
            guild_id: "0-5".into(), endpoint: "https://beta.playstructs.com/guild.json".into() });

        assert_eq!(verdict(401, &json!({ "errors": { "authentication_error": "bad signature" } })), Verdict::Reauth);
        assert_eq!(verdict(404, &json!({ "errors": { "object_not_found": "no planet 2-99" } })),
            Verdict::Gone("object_not_found: no planet 2-99".into()));
        assert!(matches!(verdict(400, &json!({ "errors": { "invalid_object": "kind" } })), Verdict::Bug(_)));
        assert!(matches!(verdict(502, &json!({ "errors": { "homeserver_error": "down" } })), Verdict::Unavailable(_)));
        assert!(matches!(verdict(503, &json!({ "errors": { "chat_not_configured": "" } })), Verdict::Unavailable(_)));
        // A success with no room in it is a bug on one side or the other,
        // never a room to join by guesswork.
        assert!(matches!(verdict(200, &json!({ "data": {} })), Verdict::Bug(_)));
        assert!(matches!(verdict(409, &json!({ "data": {} })), Verdict::Bug(_)));
        // Anything unlisted is treated as the guild having a bad day.
        assert!(matches!(verdict(500, &Value::Null), Verdict::Unavailable(_)));
    }
}
