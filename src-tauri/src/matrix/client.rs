//! Matrix client-server API, and the long-poll that feeds the Comms window.
//!
//! The window never polls and never holds a token: this module owns both. It
//! keeps one `/sync` loop per signed-in guild, folds each response into an
//! in-memory room map, and pushes deltas to the window as `matrix::timeline` /
//! `matrix::rooms`.
//!
//! Only `m.room.message` is rendered as prose. Everything else in a timeline
//! is summarised rather than dropped — a client that silently swallows event
//! types it does not know looks broken in exactly the cases where knowing
//! something happened matters most.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use tauri::Emitter;

use super::auth;
use super::directory;
use super::store::{self, Session};

/// Long-poll bound. The homeserver holds the request open until something
/// happens or this elapses, so this is idle cost, not latency.
const SYNC_TIMEOUT_MS: u64 = 30_000;
/// Slightly longer than the server's hold, so a healthy long-poll is never
/// killed by our own client timeout.
const HTTP_TIMEOUT_SECS: u64 = 45;
/// Events kept per room in memory. Scrollback beyond this is re-fetched.
const TIMELINE_CAP: usize = 500;

// ── Rendered shapes (the window's contract) ─────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub event_id: String,
    pub sender: String,
    pub sender_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_tag: Option<String>,
    pub body: String,
    /// "text" | "emote" | "notice" | "unknown"
    pub kind: &'static str,
    #[serde(rename = "self")]
    pub is_self: bool,
    pub admin: bool,
    pub ts: u64,
    /// The player's on-chain portrait attributes, so the timeline shows the
    /// same face the roster and Team Ops show. `None` for bots and service
    /// accounts, which are not players and have no portrait.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp_attrs: Option<String>,
    /// Their player id, when the sender is one — the window uses it to offer
    /// "message this player" straight off a message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Room {
    pub room_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub members: u64,
    pub joined: bool,
    pub unread: u64,
    /// "local" | "galaxy" | "direct" — see `section_for`.
    pub section: &'static str,
    pub icon: &'static str,
    /// For a direct message, the other player's portrait — a DM row should
    /// show a face, not a channel glyph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp_attrs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
}

// ── Per-guild live state ────────────────────────────────────────────────────

#[derive(Default)]
struct GuildState {
    next_batch: Option<String>,
    rooms: HashMap<String, Room>,
    timelines: HashMap<String, Vec<Message>>,
    /// user_id → display name, from m.room.member state.
    names: HashMap<String, String>,
    /// user_id → power level, per room.
    power: HashMap<String, HashMap<String, i64>>,
    /// Directory rooms we are not in, refreshed far less often than sync.
    directory_at: u64,
    /// room_id → the other party's user id, for rooms that are direct
    /// messages. Sourced from `m.direct` account data, which is where Matrix
    /// records that fact.
    dm_with: HashMap<String, String>,
    /// room_id → who is typing right now. Ephemeral by definition: it is
    /// rebuilt from each sync rather than accumulated, because "stopped
    /// typing" arrives as an empty list, not as a removal.
    typing: HashMap<String, Vec<String>>,
    /// room_id → the pagination token for the NEXT page of older messages.
    /// Absent means "never paged"; `None` inside means the room has been read
    /// back to its beginning and there is nothing more to ask for.
    back_token: HashMap<String, Option<String>>,
}

static STATE: std::sync::LazyLock<RwLock<HashMap<String, GuildState>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Guilds whose sync loop is running, so a reconnect does not start a second.
static RUNNING: std::sync::LazyLock<RwLock<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashSet::new()));

static TXN: AtomicU64 = AtomicU64::new(1);

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("StructsDesktop/comms")
        .build()
        .map_err(|e| e.to_string())
}

/// The homeserver's own name, taken from our user id (`@1-42:server`) rather
/// than from the URL — a homeserver's client URL and its server name are
/// routinely different (matrix.example vs example).
fn server_name(session: &Session) -> String {
    session
        .user_id
        .rsplit_once(':')
        .map(|(_, s)| s.to_string())
        .unwrap_or_default()
}

/// LOCAL NET vs GALAXY NET.
///
/// A room id's suffix is the server that CREATED it, so this splits "rooms my
/// guild runs" from "rooms reached across federation" — which is exactly what
/// the two labels mean for a federated client, and is derivable from data we
/// already hold rather than guessed from a name.
///
/// If structs-tel later defines a canonical room taxonomy (per-planet, per-raid
/// rooms and the Spaces that hold them), this is the one function to change.
fn section_for(room_id: &str, server: &str) -> &'static str {
    match room_id.rsplit_once(':') {
        Some((_, s)) if !server.is_empty() && s == server => "local",
        _ => "galaxy",
    }
}

/// A DM is not a channel and does not belong in either net: it is a person.
const SECTION_DIRECT: &'static str = "direct";

/// `#orbital-hydro:matrix.crew.oh.energy` → `Orbital Hydro`. An alias is a
/// routing detail; its localpart is what someone actually named the room.
fn pretty_alias(alias: &str) -> Option<String> {
    let local = alias.trim_start_matches('#').split(':').next()?;
    if local.is_empty() {
        return None;
    }
    let words: Vec<String> = local
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

/// Name a room after the people in it, the way every client does for a room
/// with no name of its own.
fn name_heroes(heroes: &[String]) -> String {
    let names: Vec<String> = heroes
        .iter()
        .take(3)
        .map(|u| {
            directory::player_id_of(u)
                .and_then(|pid| directory::get(&pid).map(|i| i.username))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| localpart(u))
        })
        .collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        _ => format!("{}, {} and others", names[0], names[1]),
    }
}

/// Pick a shipped structicon for a room. Name-based, deliberately: there is no
/// room-type metadata to read, and inventing an icon set is not an option.
fn icon_for(name: &str, alias: Option<&str>) -> &'static str {
    let hay = format!("{} {}", name, alias.unwrap_or_default()).to_lowercase();
    if hay.contains("raid") || hay.contains("war") || hay.contains("combat") {
        "icon-raid"
    } else if hay.contains("planet") || hay.contains("base") || hay.contains("alpha") {
        "icon-planet"
    } else if hay.contains("guild") || hay.contains("corp") || hay.contains("crew") {
        "icon-guild"
    } else if hay.contains("community") || hay.contains("general") || hay.contains("lobby") {
        "icon-member"
    } else if hay.contains("announce") || hay.contains("info") || hay.contains("news") {
        "icon-info"
    } else {
        "icon-beacon"
    }
}

// ── Requests ────────────────────────────────────────────────────────────────

/// Every authenticated call goes through here so that exactly one place knows
/// how to react to an expired token: refresh once, retry once, and only then
/// give up. Without this an expiring session would look like a random failure
/// somewhere in the middle of the UI.
async fn authed(
    session: &Session,
    build: impl Fn(&reqwest::Client, &Session) -> reqwest::RequestBuilder,
) -> Result<Value, String> {
    let client = http()?;
    let resp = build(&client, session)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let errcode = v.get("errcode").and_then(|e| e.as_str()).unwrap_or("");
    if errcode == "M_UNKNOWN_TOKEN" && session.refresh_token.is_some() {
        let refreshed = auth::refresh(session).await?;
        let resp = build(&client, &refreshed)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(v);
        }
        return Err(matrix_error(status.as_u16(), &v));
    }
    Err(matrix_error(status.as_u16(), &v))
}

fn matrix_error(status: u16, v: &Value) -> String {
    let code = v.get("errcode").and_then(|e| e.as_str());
    let msg = v.get("error").and_then(|e| e.as_str());
    match (code, msg) {
        (Some(c), Some(m)) => format!("{}: {}", c, m),
        (Some(c), None) => c.to_string(),
        (None, Some(m)) => m.to_string(),
        _ => format!("HTTP {}", status),
    }
}

fn base(session: &Session) -> String {
    format!(
        "{}/_matrix/client/v3",
        session.homeserver.trim_end_matches('/')
    )
}

// ── Event rendering ─────────────────────────────────────────────────────────

/// The state a room sets up with. Emitted in a burst at creation, meaningless
/// to a reader, and never worth a line in the timeline.
const SETUP_EVENTS: &[&str] = &[
    "m.room.create",
    "m.room.power_levels",
    "m.room.join_rules",
    "m.room.history_visibility",
    "m.room.guest_access",
    "m.room.server_acl",
    "m.room.encryption",
    "m.room.canonical_alias",
    "m.space.child",
    "m.space.parent",
];

fn render_event(ev: &Value, gs: &GuildState, room_id: &str, me: &str) -> Option<Message> {
    let etype = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let sender = ev.get("sender").and_then(|s| s.as_str()).unwrap_or("");
    let event_id = ev.get("event_id").and_then(|s| s.as_str()).unwrap_or("");
    let ts = ev
        .get("origin_server_ts")
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let content = ev.get("content").cloned().unwrap_or(Value::Null);

    // A redacted event has an empty content object; showing "message removed"
    // is more honest than a blank line.
    let redacted = ev.get("unsigned").and_then(|u| u.get("redacted_because")).is_some();

    let (kind, body): (&'static str, String) = if redacted {
        ("notice", "message removed".to_string())
    } else if etype == "m.room.message" {
        let msgtype = content
            .get("msgtype")
            .and_then(|m| m.as_str())
            .unwrap_or("m.text");
        let text = content
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .to_string();
        match msgtype {
            "m.emote" => ("emote", text),
            "m.notice" => ("notice", text),
            // Attachments are not rendered yet; naming the file is better than
            // an empty bubble the player cannot explain.
            "m.image" | "m.file" | "m.audio" | "m.video" => {
                ("notice", format!("sent an attachment: {}", text))
            }
            _ => ("text", text),
        }
    } else if etype == "m.room.member" {
        let membership = content
            .get("membership")
            .and_then(|m| m.as_str())
            .unwrap_or("");
        match membership {
            "join" => ("event", "joined".to_string()),
            "leave" => ("event", "left".to_string()),
            "ban" => ("event", "was banned".to_string()),
            "invite" => ("event", "was invited".to_string()),
            // A membership change with nothing to say (a profile edit) is the
            // one event genuinely worth dropping.
            _ => return None,
        }
    } else if SETUP_EVENTS.contains(&etype) {
        // Room plumbing. Every room ever created emits this burst — "changed
        // create", "changed power_levels", "changed join_rules",
        // "changed history_visibility", "changed guest_access" — and not one
        // of them is something a player wants to read. They were the first
        // six lines of every room in the client.
        return None;
    } else if etype == "m.room.name" {
        let n = content.get("name").and_then(|x| x.as_str()).unwrap_or("");
        ("event", if n.is_empty() { "removed the room name".into() }
                  else { format!("named the room “{}”", n) })
    } else if etype == "m.room.topic" {
        ("event", "changed the topic".to_string())
    } else if etype.starts_with("m.room.") {
        // Anything else that IS state but has no rendering of its own: still
        // worth a line, because a silently dropped event looks like a bug.
        ("event", format!("changed {}", etype.trim_start_matches("m.room.")))
    } else {
        return None;
    };

    if body.is_empty() {
        return None;
    }

    let level = gs
        .power
        .get(room_id)
        .and_then(|p| p.get(sender).copied())
        .unwrap_or(0);

    // The localpart IS the player id, so the game's own identity for this
    // sender — real name, guild tag, portrait — is a direct lookup. The
    // homeserver's display name is the fallback, not the other way round: a
    // Matrix display name is self-chosen and can impersonate, while the
    // directory's name is the on-chain one.
    let player_id = directory::player_id_of(sender);
    let ident = player_id.as_deref().and_then(directory::get);

    Some(Message {
        event_id: event_id.to_string(),
        sender: sender.to_string(),
        sender_name: ident
            .as_ref()
            .map(|i| i.username.clone())
            .filter(|n| !n.is_empty())
            .or_else(|| gs.names.get(sender).cloned())
            .unwrap_or_else(|| localpart(sender)),
        sender_tag: ident.as_ref().map(|i| i.tag.clone()).filter(|t| !t.is_empty()),
        pfp_attrs: ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
        player_id,
        body,
        kind,
        is_self: sender == me,
        admin: level >= 100,
        ts,
    })
}

fn localpart(user_id: &str) -> String {
    user_id
        .trim_start_matches('@')
        .split(':')
        .next()
        .unwrap_or(user_id)
        .to_string()
}

// ── Sync ────────────────────────────────────────────────────────────────────

/// Fold one `/sync` response into the guild's state and return what changed.
type SyncDelta = (Vec<(String, Vec<Message>)>, bool, Vec<(String, Vec<String>)>);

fn apply_sync(guild_id: &str, session: &Session, v: &Value) -> SyncDelta {
    let server = server_name(session);
    let mut deltas: Vec<(String, Vec<Message>)> = Vec::new();
    let mut rooms_changed = false;
    let mut typing_changed: Vec<(String, Vec<String>)> = Vec::new();

    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.next_batch = v
        .get("next_batch")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());

    // `m.direct` is where Matrix records "this room is a DM with that user":
    // {user_id: [room_id, …]}. Without reading it, a DM is indistinguishable
    // from a two-person channel named after its room id.
    for ev in v
        .get("account_data")
        .and_then(|a| a.get("events"))
        .and_then(|e| e.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
    {
        if ev.get("type").and_then(|t| t.as_str()) != Some("m.direct") {
            continue;
        }
        if let Some(obj) = ev.get("content").and_then(|c| c.as_object()) {
            for (user_id, rooms) in obj {
                for r in rooms.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                    if let Some(rid) = r.as_str() {
                        gs.dm_with.insert(rid.to_string(), user_id.clone());
                    }
                }
            }
        }
    }

    let joined = v
        .get("rooms")
        .and_then(|r| r.get("join"))
        .and_then(|j| j.as_object())
        .cloned()
        .unwrap_or_default();

    for (room_id, room) in joined {
        // ── State first: names and power levels feed message rendering, so
        //    they must land before the timeline is rendered against them.
        let state_events = room
            .get("state")
            .and_then(|s| s.get("events"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let timeline_events = room
            .get("timeline")
            .and_then(|t| t.get("events"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();

        let mut name: Option<String> = None;
        let mut alias: Option<String> = None;
        let mut topic: Option<String> = None;

        for ev in state_events.iter().chain(timeline_events.iter()) {
            let etype = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let content = ev.get("content");
            match etype {
                "m.room.name" => {
                    name = content
                        .and_then(|c| c.get("name"))
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string());
                }
                "m.room.canonical_alias" => {
                    alias = content
                        .and_then(|c| c.get("alias"))
                        .and_then(|a| a.as_str())
                        .map(|s| s.to_string());
                }
                "m.room.topic" => {
                    topic = content
                        .and_then(|c| c.get("topic"))
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string());
                }
                "m.room.member" => {
                    if let (Some(uid), Some(c)) =
                        (ev.get("state_key").and_then(|k| k.as_str()), content)
                    {
                        if let Some(dn) = c.get("displayname").and_then(|d| d.as_str()) {
                            if !dn.is_empty() {
                                gs.names.insert(uid.to_string(), dn.to_string());
                            }
                        }
                    }
                }
                "m.room.power_levels" => {
                    if let Some(users) = content.and_then(|c| c.get("users")).and_then(|u| u.as_object())
                    {
                        let entry = gs.power.entry(room_id.clone()).or_default();
                        for (uid, lvl) in users {
                            if let Some(n) = lvl.as_i64() {
                                entry.insert(uid.clone(), n);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let members = room
            .get("summary")
            .and_then(|s| s.get("m.joined_member_count"))
            .and_then(|c| c.as_u64());
        // `m.heroes` is the spec's answer for a room with no name: the other
        // people in it. Without reading it, an unnamed room has nothing to be
        // called except its own id.
        let heroes: Vec<String> = room
            .get("summary")
            .and_then(|s| s.get("m.heroes"))
            .and_then(|h| h.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|u| u != &session.user_id)
                    .collect()
            })
            .unwrap_or_default();

        let existing = gs.rooms.get(&room_id).cloned();
        let final_alias = alias
            .clone()
            .or_else(|| existing.as_ref().and_then(|r| r.canonical_alias.clone()));
        let display = name
            .clone()
            .or_else(|| existing.as_ref().map(|r| r.name.clone()).filter(|n| !n.is_empty()))
            // An alias reads far better as its localpart: "#orbital-hydro:host"
            // is plumbing, "Orbital Hydro" is a name.
            .or_else(|| final_alias.as_deref().and_then(pretty_alias))
            // Then whoever is in it — the spec's own fallback.
            .or_else(|| {
                let named = name_heroes(&heroes);
                if named.is_empty() { None } else { Some(named) }
            })
            // NEVER a raw `!room_id`. A room we know nothing about is still
            // better described as "a conversation" than as an opaque handle.
            .unwrap_or_else(|| "Untitled room".to_string());

        // A DM is presented as the person it is with: their name, their guild
        // tag, their portrait — never a room id or an auto-generated title.
        //
        // `m.direct` is authoritative when present, but it is routinely ABSENT:
        // a DM created by another client, or by the guild's own tooling, never
        // writes it into our account data. So an unnamed two-person room counts
        // as a direct message on its own evidence.
        let dm_peer = gs.dm_with.get(&room_id).cloned().or_else(|| {
            let two_or_fewer = members.map(|m| m <= 2).unwrap_or(false);
            if name.is_none() && final_alias.is_none() && two_or_fewer {
                heroes.first().cloned()
            } else {
                None
            }
        });
        let dm_player = dm_peer.as_deref().and_then(directory::player_id_of);
        let dm_ident = dm_player.as_deref().and_then(directory::get);

        let entry = Room {
            room_id: room_id.clone(),
            icon: if dm_peer.is_some() {
                "icon-member"
            } else {
                icon_for(&display, final_alias.as_deref())
            },
            name: match dm_ident.as_ref() {
                Some(i) if !i.username.is_empty() => i.username.clone(),
                // Not in the game directory (a bot, or another guild's service
                // account): the homeserver's own display name beats the id.
                _ => match dm_peer.as_deref() {
                    Some(peer) => gs
                        .names
                        .get(peer)
                        .cloned()
                        .or_else(|| dm_player.clone())
                        .unwrap_or_else(|| localpart(peer)),
                    None => display,
                },
            },
            canonical_alias: final_alias,
            topic: topic.or_else(|| existing.as_ref().and_then(|r| r.topic.clone())),
            members: members
                .or_else(|| existing.as_ref().map(|r| r.members))
                .unwrap_or(0),
            joined: true,
            // Unread lives in the window: it is a per-view concern, and the
            // window is the only thing that knows what the player is looking at.
            unread: 0,
            section: if dm_peer.is_some() {
                SECTION_DIRECT
            } else {
                section_for(&room_id, &server)
            },
            pfp_attrs: dm_ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
            player_id: dm_player,
        };
        if existing.as_ref() != Some(&entry) {
            rooms_changed = true;
        }
        gs.rooms.insert(room_id.clone(), entry);

        // ── Typing (ephemeral)
        // `m.typing` carries the WHOLE current set every time, so replacing is
        // correct and removing stale entries is automatic.
        if let Some(events) = room
            .get("ephemeral")
            .and_then(|e| e.get("events"))
            .and_then(|e| e.as_array())
        {
            for ev in events {
                if ev.get("type").and_then(|t| t.as_str()) != Some("m.typing") {
                    continue;
                }
                let mut who: Vec<String> = ev
                    .get("content")
                    .and_then(|c| c.get("user_ids"))
                    .and_then(|u| u.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                // Never report yourself as typing back at yourself.
                who.retain(|u| u != &session.user_id);
                let prev = gs.typing.get(&room_id);
                if prev.map(|p| p.as_slice()) != Some(who.as_slice()) {
                    typing_changed.push((room_id.clone(), who.clone()));
                }
                gs.typing.insert(room_id.clone(), who);
            }
        }

        // ── Timeline
        let mut rendered: Vec<Message> = Vec::new();
        for ev in &timeline_events {
            if let Some(m) = render_event(ev, gs, &room_id, &session.user_id) {
                rendered.push(m);
            }
        }
        if !rendered.is_empty() {
            let buf = gs.timelines.entry(room_id.clone()).or_default();
            buf.extend(rendered.iter().cloned());
            if buf.len() > TIMELINE_CAP {
                let cut = buf.len() - TIMELINE_CAP;
                buf.drain(..cut);
            }
            deltas.push((room_id.clone(), rendered));
        }
    }

    // A room we left elsewhere should stop being listed here too.
    if let Some(left) = v
        .get("rooms")
        .and_then(|r| r.get("leave"))
        .and_then(|l| l.as_object())
    {
        for room_id in left.keys() {
            if gs.rooms.remove(room_id).is_some() {
                gs.timelines.remove(room_id);
                rooms_changed = true;
            }
        }
    }

    (deltas, rooms_changed, typing_changed)
}

// ── Being contacted ─────────────────────────────────────────────────────────
//
// ICQ's whole personality was telling you someone wanted you. The sync loop
// runs whether or not the Comms window is open, so this decision belongs here
// rather than in the window: Rust knows the message, knows whether the room is
// a direct message, and can ask whether anyone is actually looking.

/// The names that count as "me" in a message body: the on-chain username and
/// the player id. Matched at word boundaries — see `is_mention`.
fn my_names(session: &Session) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(pid) = directory::player_id_of(&session.user_id) {
        if let Some(ident) = directory::get(&pid) {
            if !ident.username.is_empty() {
                out.push(ident.username);
            }
        }
        out.push(pid);
    }
    out.retain(|n| n.chars().count() >= 2);
    out
}

/// Word-boundary match, treating anything that is not a letter, digit,
/// underscore or hyphen as a boundary. A plain `contains` would fire
/// "Marklifer" on "Marklifers", and `\b` alone does not hold for ids like
/// `1-194` because the hyphen is itself a word boundary.
fn is_mention(body: &str, names: &[String]) -> bool {
    let hay: Vec<char> = body.to_lowercase().chars().collect();
    for name in names {
        let needle: Vec<char> = name.to_lowercase().chars().collect();
        if needle.is_empty() || needle.len() > hay.len() {
            continue;
        }
        let boundary = |c: char| !(c.is_alphanumeric() || c == '_' || c == '-');
        for start in 0..=(hay.len() - needle.len()) {
            if hay[start..start + needle.len()] != needle[..] {
                continue;
            }
            let before_ok = start == 0 || boundary(hay[start - 1]);
            let after = start + needle.len();
            let after_ok = after == hay.len() || boundary(hay[after]);
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

/// Never more than one notification per room per this long. A room that is
/// mid-argument would otherwise produce a notification per line.
const NOTIFY_COOLDOWN_SECS: u64 = 45;
static NOTIFIED_AT: std::sync::LazyLock<RwLock<HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

fn claim_notify_slot(room_id: &str) -> bool {
    let now = auth::now_secs();
    let mut map = NOTIFIED_AT.write().unwrap();
    match map.get(room_id) {
        Some(at) if now.saturating_sub(*at) < NOTIFY_COOLDOWN_SECS => false,
        _ => {
            map.insert(room_id.to_string(), now);
            true
        }
    }
}

/// True when nobody is looking at the Comms window — closed, minimised, or
/// simply behind something else. Notifying someone about a message they are
/// already reading is the fastest way to get notifications turned off.
fn window_is_watched(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    match app.get_webview_window("chat") {
        Some(w) => w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false),
        None => false,
    }
}

/// Decide and send. Only a direct message or a mention earns one: everything
/// else is traffic, and traffic that interrupts is noise.
fn maybe_notify(
    app: &tauri::AppHandle,
    guild_id: &str,
    room_id: &str,
    messages: &[Message],
    session: &Session,
) {
    if window_is_watched(app) {
        return;
    }
    let is_dm = {
        let map = STATE.read().unwrap();
        map.get(guild_id)
            .map(|gs| gs.dm_with.contains_key(room_id))
            .unwrap_or(false)
    };
    let names = my_names(session);
    let hit = messages.iter().find(|m| {
        !m.is_self && m.kind != "unknown" && (is_dm || is_mention(&m.body, &names))
    });
    let Some(m) = hit else { return };
    if !claim_notify_slot(room_id) {
        return;
    }

    let room_name = {
        let map = STATE.read().unwrap();
        map.get(guild_id)
            .and_then(|gs| gs.rooms.get(room_id).map(|r| r.name.clone()))
            .unwrap_or_else(|| room_id.to_string())
    };
    // A DM is already titled by the person, so repeating their name in the
    // body would say it twice.
    let title = if is_dm {
        room_name
    } else {
        format!("{} — {}", m.sender_name, room_name)
    };
    let mut body = m.body.replace('\n', " ");
    if body.chars().count() > 140 {
        body = body.chars().take(139).collect::<String>() + "…";
    }
    crate::notifications::notify(&title, &body);
}

/// Render a typing set for the window: who, by the name a player would know
/// them by. Bots and service accounts keep their localpart.
pub fn typing_names(users: &[String]) -> Vec<String> {
    users
        .iter()
        .map(|u| {
            directory::player_id_of(u)
                .and_then(|pid| directory::get(&pid).map(|i| i.username))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| localpart(u))
        })
        .collect()
}

/// Tell the homeserver we are (or have stopped) typing. Fire-and-forget: a
/// failed typing notice is not worth telling anyone about.
pub async fn set_typing(session: &Session, room_id: &str, typing: bool) -> Result<(), String> {
    let url = format!(
        "{}/rooms/{}/typing/{}",
        base(session),
        urlseg(room_id),
        urlseg(&session.user_id)
    );
    // The timeout is how long the server keeps believing us without another
    // notice — long enough to survive a pause for thought, short enough that a
    // closed window stops claiming to type.
    let payload = if typing {
        json!({ "typing": true, "timeout": 20_000 })
    } else {
        json!({ "typing": false })
    };
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

/// PartialEq on Room lets `apply_sync` tell a real change from a no-op sync,
/// so an idle homeserver does not repaint the window every 30 seconds.
impl PartialEq for Room {
    fn eq(&self, other: &Self) -> bool {
        self.room_id == other.room_id
            && self.name == other.name
            && self.canonical_alias == other.canonical_alias
            && self.topic == other.topic
            && self.members == other.members
            && self.joined == other.joined
            && self.section == other.section
            && self.player_id == other.player_id
            && self.pfp_attrs == other.pfp_attrs
    }
}

/// Start the long-poll for one guild. Idempotent: a second call while the loop
/// is alive is a no-op, so reconnecting cannot double the traffic.
pub fn start_sync(app: tauri::AppHandle, guild_id: String) {
    {
        let mut running = RUNNING.write().unwrap();
        if !running.insert(guild_id.clone()) {
            return;
        }
    }
    // Our own user id is a REAL id from this guild's homeserver, so it settles
    // what that server is actually called — better than inferring it from the
    // client URL, which a deploy is free to make differ. Everything addressed
    // to this guild (every DM) depends on getting that right.
    if let Some(session) = store::get(&guild_id) {
        directory::learn_server_name(&guild_id, &session.user_id);
    }
    tauri::async_runtime::spawn(async move {
        let mut backoff = 2u64;
        loop {
            let Some(session) = store::get(&guild_id) else {
                break; // signed out
            };
            let since = STATE
                .read()
                .unwrap()
                .get(&guild_id)
                .and_then(|g| g.next_batch.clone());

            let result = sync_once(&session, since.as_deref()).await;
            match result {
                Ok(v) => {
                    backoff = 2;
                    let (deltas, rooms_changed, typing) = apply_sync(&guild_id, &session, &v);
                    for (room_id, users) in typing {
                        let _ = app.emit(
                            "matrix::typing",
                            json!({
                                "guild_id": guild_id,
                                "room_id": room_id,
                                "names": typing_names(&users),
                            }),
                        );
                    }
                    for (room_id, messages) in deltas {
                        maybe_notify(&app, &guild_id, &room_id, &messages, &session);
                        let _ = app.emit(
                            "matrix::timeline",
                            json!({
                                "guild_id": guild_id,
                                "room_id": room_id,
                                "messages": messages,
                            }),
                        );
                    }
                    if rooms_changed {
                        let _ = app.emit(
                            "matrix::rooms",
                            json!({ "guild_id": guild_id, "rooms": rooms_of(&guild_id) }),
                        );
                    }
                }
                Err(e) => {
                    // A signed-out session ends the loop; anything else is
                    // transient and worth backing off over rather than
                    // hammering a homeserver that is having a bad time.
                    if e.contains("M_UNKNOWN_TOKEN") {
                        eprintln!("[Comms] {} session rejected, stopping sync: {}", guild_id, e);
                        store::remove(&guild_id);
                        let reason = "the homeserver ended this session — sign in again";
                        super::note_error(&guild_id, reason);
                        // Partial by necessity (there is no async here to
                        // rebuild the full snapshot); the window re-reads
                        // status when it sees an error-only push.
                        let _ = app.emit("matrix::status", json!({ "error": reason }));
                        break;
                    }
                    eprintln!("[Comms] {} sync: {} (retry in {}s)", guild_id, e, backoff);
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
        RUNNING.write().unwrap().remove(&guild_id);
    });
}

pub fn stop_sync(guild_id: &str) {
    // The loop exits on its own once the session is gone; this just clears the
    // cached view so a re-connect does not show stale rooms.
    STATE.write().unwrap().remove(guild_id);
}

async fn sync_once(session: &Session, since: Option<&str>) -> Result<Value, String> {
    let url = format!("{}/sync", base(session));
    let timeout = SYNC_TIMEOUT_MS.to_string();
    let since_owned = since.map(|s| s.to_string());
    authed(session, move |c, s| {
        let mut req = c.get(&url).bearer_auth(&s.access_token).query(&[
            ("timeout", timeout.as_str()),
            // Enough scrollback that opening a room straight after connecting
            // is not an empty screen.
            // `ephemeral` is left unfiltered on purpose: it is how m.typing
            // arrives, and a filter that omits it silently kills the feature.
            ("filter", r#"{"room":{"timeline":{"limit":40}}}"#),
        ]);
        if let Some(b) = since_owned.as_deref() {
            req = req.query(&[("since", b)]);
        }
        req
    })
    .await
}

// ── Reads the window makes ──────────────────────────────────────────────────

pub fn rooms_of(guild_id: &str) -> Vec<Room> {
    let map = STATE.read().unwrap();
    let Some(gs) = map.get(guild_id) else {
        return Vec::new();
    };
    let mut rooms: Vec<Room> = gs.rooms.values().cloned().collect();
    // Joined first, then by section, then by name — a stable order so the list
    // does not reshuffle under the cursor on every sync.
    rooms.sort_by(|a, b| {
        b.joined
            .cmp(&a.joined)
            .then(a.section.cmp(b.section))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    rooms
}

/// Merge the public room directory in, so rooms the player has NOT joined are
/// visible with a Join button. Refreshed lazily — the directory changes far
/// more slowly than a timeline.
pub async fn refresh_directory(guild_id: &str, session: &Session) -> Result<(), String> {
    const DIRECTORY_TTL_SECS: u64 = 300;
    {
        let map = STATE.read().unwrap();
        if let Some(gs) = map.get(guild_id) {
            if auth::now_secs().saturating_sub(gs.directory_at) < DIRECTORY_TTL_SECS {
                return Ok(());
            }
        }
    }
    let url = format!("{}/publicRooms", base(session));
    let v = authed(session, move |c, s| {
        c.get(&url).bearer_auth(&s.access_token).query(&[("limit", "100")])
    })
    .await?;

    let server = server_name(session);
    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.directory_at = auth::now_secs();
    for chunk in v
        .get("chunk")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let Some(room_id) = chunk.get("room_id").and_then(|r| r.as_str()) else {
            continue;
        };
        // Never let the directory overwrite a room we are actually in: sync is
        // authoritative there, and the directory's member count lags.
        if gs.rooms.get(room_id).map(|r| r.joined) == Some(true) {
            if let Some(n) = chunk.get("num_joined_members").and_then(|n| n.as_u64()) {
                if let Some(r) = gs.rooms.get_mut(room_id) {
                    r.members = n;
                }
            }
            continue;
        }
        let alias = chunk
            .get("canonical_alias")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());
        let name = chunk
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string())
            .or_else(|| alias.clone())
            .unwrap_or_else(|| room_id.to_string());
        gs.rooms.insert(
            room_id.to_string(),
            Room {
                room_id: room_id.to_string(),
                icon: icon_for(&name, alias.as_deref()),
                name,
                canonical_alias: alias,
                topic: chunk
                    .get("topic")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string()),
                members: chunk
                    .get("num_joined_members")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0),
                joined: false,
                unread: 0,
                section: section_for(room_id, &server),
                pfp_attrs: None,
                player_id: None,
            },
        );
    }
    Ok(())
}

/// Search the homeserver's public room directory — IRC's `/list`.
///
/// A live query rather than a filter over the cached page: a homeserver with
/// hundreds of rooms only ever hands us the first hundred, so searching
/// locally would search the wrong set. Federated servers can be searched too
/// once the `server` argument is wired; for now this is the guild's own.
pub async fn browse(
    guild_id: &str,
    session: &Session,
    query: Option<&str>,
) -> Result<Vec<Room>, String> {
    let url = format!("{}/publicRooms", base(session));
    let term = query.unwrap_or("").trim().to_string();
    let mut body = json!({ "limit": 60 });
    if !term.is_empty() {
        body["filter"] = json!({ "generic_search_term": term });
    }
    // POST, not GET: the search term goes in a filter object, which the GET
    // form has no way to carry.
    let v = authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&body)
    })
    .await?;

    let server = server_name(session);
    let joined: std::collections::HashSet<String> = {
        let map = STATE.read().unwrap();
        map.get(guild_id)
            .map(|gs| {
                gs.rooms
                    .iter()
                    .filter(|(_, r)| r.joined)
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut out = Vec::new();
    for chunk in v
        .get("chunk")
        .and_then(|c| c.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
    {
        let Some(room_id) = chunk.get("room_id").and_then(|r| r.as_str()) else {
            continue;
        };
        let alias = chunk
            .get("canonical_alias")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());
        let name = chunk
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string())
            .or_else(|| alias.clone())
            .unwrap_or_else(|| room_id.to_string());
        out.push(Room {
            room_id: room_id.to_string(),
            icon: icon_for(&name, alias.as_deref()),
            name,
            canonical_alias: alias,
            topic: chunk.get("topic").and_then(|t| t.as_str()).map(|s| s.to_string()),
            members: chunk
                .get("num_joined_members")
                .and_then(|n| n.as_u64())
                .unwrap_or(0),
            joined: joined.contains(room_id),
            unread: 0,
            section: section_for(room_id, &server),
            pfp_attrs: None,
            player_id: None,
        });
    }
    // ── Federated discovery ──
    // The public directory is empty on these deployments and cross-server
    // directory queries are refused, so the directory ALONE shows nothing. The
    // aliases every guild actually uses do resolve — see discovery.rs.
    if term.is_empty() {
        let known: std::collections::HashSet<String> =
            out.iter().map(|r| r.room_id.clone()).collect();
        for s in super::discovery::federated_rooms(session).await {
            if known.contains(&s.room_id) {
                continue;
            }
            out.push(Room {
                room_id: s.room_id.clone(),
                icon: icon_for(&s.name, Some(&s.alias)),
                name: s.name,
                canonical_alias: Some(s.alias),
                topic: s.topic,
                members: s.members,
                joined: joined.contains(&s.room_id),
                unread: 0,
                section: section_for(&s.room_id, &server),
                pfp_attrs: None,
                player_id: None,
            });
        }
    }

    // Busiest first: on a directory, population is the best proxy for "worth
    // looking at", and alphabetical order buries every active room.
    out.sort_by(|a, b| {
        b.members
            .cmp(&a.members)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn timeline_of(guild_id: &str, room_id: &str) -> (Option<Room>, Vec<Message>) {
    let map = STATE.read().unwrap();
    let Some(gs) = map.get(guild_id) else {
        return (None, Vec::new());
    };
    (
        gs.rooms.get(room_id).cloned(),
        gs.timelines.get(room_id).cloned().unwrap_or_default(),
    )
}

/// Backfill from the server when the in-memory timeline is thin — right after
/// connecting, or for a room just joined.
pub async fn fetch_messages(
    guild_id: &str,
    session: &Session,
    room_id: &str,
    limit: u32,
) -> Result<Vec<Message>, String> {
    page_back(guild_id, session, room_id, limit, None).await
}

/// One page of history, walking backwards.
///
/// `from` is the token a previous page returned; `None` starts at the live
/// end. The token for the NEXT page is recorded per room, and recorded as
/// `None` once the room has been read back to its beginning — that is what
/// stops the window asking forever at the top of a short room.
async fn page_back(
    guild_id: &str,
    session: &Session,
    room_id: &str,
    limit: u32,
    from: Option<String>,
) -> Result<Vec<Message>, String> {
    let url = format!("{}/rooms/{}/messages", base(session), urlseg(room_id));
    let limit_s = limit.to_string();
    let v = authed(session, move |c, s| {
        let mut req = c
            .get(&url)
            .bearer_auth(&s.access_token)
            .query(&[("dir", "b"), ("limit", limit_s.as_str())]);
        if let Some(tok) = from.as_deref() {
            req = req.query(&[("from", tok)]);
        }
        req
    })
    .await?;

    let chunk_len = v
        .get("chunk")
        .and_then(|c| c.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    // Synapse omits `end` at the start of the room. An empty chunk means the
    // same thing, and is the more reliable signal of the two.
    let next = v
        .get("end")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string())
        .filter(|_| chunk_len > 0);

    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.back_token.insert(room_id.to_string(), next);
    let mut out: Vec<Message> = v
        .get("chunk")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ev| render_event(ev, gs, room_id, &session.user_id))
                .collect()
        })
        .unwrap_or_default();
    // `dir=b` returns newest-first; the window renders oldest-first.
    out.reverse();
    Ok(out)
}

/// The next page of older messages, prepended to what is already cached.
///
/// Returns the page and whether more remain, so the window can stop offering
/// to load history that does not exist.
pub async fn backfill(
    guild_id: &str,
    session: &Session,
    room_id: &str,
    limit: u32,
) -> Result<(Vec<Message>, bool), String> {
    let token = {
        let map = STATE.read().unwrap();
        match map.get(guild_id).and_then(|gs| gs.back_token.get(room_id)) {
            // Read back to the beginning already; nothing to ask for.
            Some(None) => return Ok((Vec::new(), false)),
            Some(Some(t)) => Some(t.clone()),
            // Never paged: the caller wants older than the live end.
            None => None,
        }
    };
    let older = page_back(guild_id, session, room_id, limit, token).await?;
    let more = {
        let map = STATE.read().unwrap();
        matches!(
            map.get(guild_id).and_then(|gs| gs.back_token.get(room_id)),
            Some(Some(_))
        )
    };

    if !older.is_empty() {
        let mut map = STATE.write().unwrap();
        let gs = map.entry(guild_id.to_string()).or_default();
        let buf = gs.timelines.entry(room_id.to_string()).or_default();
        // Prepend, skipping anything already held: a page can overlap the
        // live tail, and a duplicated message reads as the room repeating
        // itself.
        let have: std::collections::HashSet<String> =
            buf.iter().map(|m| m.event_id.clone()).collect();
        let mut merged: Vec<Message> = older
            .into_iter()
            .filter(|m| !have.contains(&m.event_id))
            .collect();
        let fresh = merged.len();
        merged.extend(buf.drain(..));
        *buf = merged;
        return Ok((buf[..fresh].to_vec(), more));
    }
    Ok((Vec::new(), more))
}

/// Replace the cached timeline with a server-authoritative backfill.
pub fn seed_timeline(guild_id: &str, room_id: &str, messages: Vec<Message>) {
    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.timelines.insert(room_id.to_string(), messages);
}

/// The message types this client will emit. An allowlist, not a passthrough:
/// `msgtype` reaches here from the composer's slash commands, and letting an
/// arbitrary string through would let a typo mint event types no client
/// renders.
pub fn msgtype_or_text(requested: Option<&str>) -> &'static str {
    match requested {
        Some("m.emote") => "m.emote",
        Some("m.notice") => "m.notice",
        _ => "m.text",
    }
}

pub async fn send(
    session: &Session,
    room_id: &str,
    body: &str,
    msgtype: &str,
) -> Result<String, String> {
    let txn = format!(
        "structs{}{}",
        auth::now_secs(),
        TXN.fetch_add(1, Ordering::Relaxed)
    );
    let url = format!(
        "{}/rooms/{}/send/m.room.message/{}",
        base(session),
        urlseg(room_id),
        urlseg(&txn)
    );
    let payload = json!({ "msgtype": msgtype, "body": body });
    let v = authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    v.get("event_id")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "the homeserver accepted the message but returned no event id".to_string())
}

/// Find or create the direct-message room with `their_id`.
///
/// Reuses an existing DM when there is one: Matrix will happily create a
/// second room with the same two people, which then splits the conversation
/// in half with no way to tell which half is current.
pub async fn open_dm(
    guild_id: &str,
    session: &Session,
    their_id: &str,
) -> Result<String, String> {
    if let Some(existing) = {
        let map = STATE.read().unwrap();
        map.get(guild_id).and_then(|gs| {
            gs.dm_with
                .iter()
                .find(|(_, peer)| peer.as_str() == their_id)
                .map(|(room, _)| room.clone())
        })
    } {
        return Ok(existing);
    }

    let url = format!("{}/createRoom", base(session));
    let payload = json!({
        "is_direct": true,
        "preset": "trusted_private_chat",
        "invite": [their_id],
    });
    let v = authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    let room_id = v
        .get("room_id")
        .and_then(|r| r.as_str())
        .ok_or("the homeserver created no room")?
        .to_string();

    // Record it locally AND in account data. Local so the room is a DM in this
    // window immediately; account data so every other Matrix client the player
    // uses agrees, and so a reinstall does not lose the fact.
    {
        let mut map = STATE.write().unwrap();
        let gs = map.entry(guild_id.to_string()).or_default();
        gs.dm_with.insert(room_id.clone(), their_id.to_string());
    }
    if let Err(e) = publish_direct(guild_id, session).await {
        // Not fatal: the DM works, it just may not look like one elsewhere.
        eprintln!("[Comms] m.direct update: {}", e);
    }
    Ok(room_id)
}

/// Write the whole `m.direct` map back. Matrix has no partial update for
/// account data, so this always sends the complete map.
async fn publish_direct(guild_id: &str, session: &Session) -> Result<(), String> {
    let mut by_user: HashMap<String, Vec<String>> = HashMap::new();
    {
        let map = STATE.read().unwrap();
        if let Some(gs) = map.get(guild_id) {
            for (room, peer) in &gs.dm_with {
                by_user.entry(peer.clone()).or_default().push(room.clone());
            }
        }
    }
    let url = format!(
        "{}/user/{}/account_data/m.direct",
        base(session),
        urlseg(&session.user_id)
    );
    let payload = serde_json::to_value(&by_user).map_err(|e| e.to_string())?;
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

pub async fn join(session: &Session, room_id: &str) -> Result<(), String> {
    // `/join/{roomIdOrAlias}` takes an alias too, which is what makes a
    // directory row joinable before we know its room id.
    let url = format!("{}/join/{}", base(session), urlseg(room_id));
    authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&json!({}))
    })
    .await
    .map(|_| ())
}

/// Set both the private read marker and the public read receipt, which is
/// what other clients actually read.
pub async fn mark_read(
    session: &Session,
    room_id: &str,
    event_id: &str,
) -> Result<(), String> {
    let url = format!("{}/rooms/{}/read_markers", base(session), urlseg(room_id));
    let payload = json!({
        "m.fully_read": event_id,
        "m.read": event_id,
    });
    authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

pub async fn leave(session: &Session, room_id: &str) -> Result<(), String> {
    let url = format!("{}/rooms/{}/leave", base(session), urlseg(room_id));
    authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&json!({}))
    })
    .await
    .map(|_| ())
}

/// Room ids and aliases contain `!`, `#`, `:` and `$` — all of which must be
/// percent-encoded to survive as ONE path segment.
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

/// The player's Matrix profile, for the composer portrait.
pub async fn profile(session: &Session) -> Result<Value, String> {
    let url = format!("{}/profile/{}", base(session), urlseg(&session.user_id));
    let v = authed(session, move |c, s| c.get(&url).bearer_auth(&s.access_token))
        .await
        .unwrap_or(Value::Null);
    // The composer shows YOUR face, so the profile has to carry it. The
    // homeserver knows nothing about game portraits — the on-chain attributes
    // come from the same galaxy directory every other portrait uses.
    let ident = directory::player_id_of(&session.user_id).and_then(|pid| directory::get(&pid));
    Ok(json!({
        "user_id": session.user_id,
        "display_name": v.get("displayname").and_then(|d| d.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| localpart(&session.user_id)),
        "pfp_attrs": ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
        "tag": ident.as_ref().map(|i| i.tag.clone()).unwrap_or_default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            guild_id: "0-5".into(),
            homeserver: "https://matrix.example.com".into(),
            user_id: "@1-194:example.com".into(),
            device_id: "ABCDEFGHIJ".into(),
            access_token: "t".into(),
            refresh_token: None,
            expires_at: None,
            client_id: "c".into(),
            token_endpoint: "https://auth.example.com/oauth2/token".into(),
        }
    }

    #[test]
    fn server_name_comes_from_the_user_id_not_the_url() {
        // The client URL (matrix.example.com) and the server name
        // (example.com) routinely differ; getting this wrong would put every
        // room in GALAXY NET.
        assert_eq!(server_name(&session()), "example.com");
    }

    #[test]
    fn sectioning_splits_own_server_from_federated() {
        assert_eq!(section_for("!abc:example.com", "example.com"), "local");
        assert_eq!(section_for("!abc:other.example", "example.com"), "galaxy");
        // No server name known yet — never claim a room is local on a guess.
        assert_eq!(section_for("!abc:example.com", ""), "galaxy");
    }

    #[test]
    fn room_ids_survive_as_one_path_segment() {
        assert_eq!(urlseg("!abc:example.com"), "%21abc%3Aexample.com");
        assert_eq!(urlseg("#raid:example.com"), "%23raid%3Aexample.com");
        // A bare id with no escaping would make "/rooms/!abc:h/send/..." split
        // on the colon and 404.
        assert!(!urlseg("$event:h").contains(':'));
    }

    #[test]
    fn a_message_renders_with_its_sender_and_power() {
        let mut gs = GuildState::default();
        gs.names
            .insert("@1-42:example.com".into(), "Netlag".into());
        gs.power
            .entry("!r:example.com".into())
            .or_default()
            .insert("@1-42:example.com".into(), 100);
        let ev = json!({
            "type": "m.room.message", "event_id": "$1",
            "sender": "@1-42:example.com", "origin_server_ts": 1700,
            "content": { "msgtype": "m.text", "body": "what what what" }
        });
        let m = render_event(&ev, &gs, "!r:example.com", "@1-194:example.com").unwrap();
        assert_eq!(m.sender_name, "Netlag");
        assert_eq!(m.body, "what what what");
        assert_eq!(m.kind, "text");
        assert!(m.admin);
        assert!(!m.is_self);
    }

    #[test]
    fn an_unknown_sender_falls_back_to_the_player_id() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.message", "event_id": "$1",
            "sender": "@1-77:example.com", "origin_server_ts": 1,
            "content": { "msgtype": "m.text", "body": "hi" }
        });
        let m = render_event(&ev, &gs, "!r:example.com", "@me:example.com").unwrap();
        // The localpart IS the player id, which is the most useful fallback
        // there is — never a raw matrix id in the name slot.
        assert_eq!(m.sender_name, "1-77");
    }

    #[test]
    fn a_redacted_event_says_so_instead_of_rendering_blank() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.message", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": {},
            "unsigned": { "redacted_because": { "type": "m.room.redaction" } }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.kind, "notice");
        assert_eq!(m.body, "message removed");
    }

    #[test]
    fn an_unhandled_state_change_is_summarised_not_dropped() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.pinned_events", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "pinned": ["$x"] }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.kind, "event");
        assert!(m.body.contains("pinned_events"), "{}", m.body);
    }

    /// Every room emits this burst when it is created. It opened every
    /// timeline in the client with six lines of "changed create",
    /// "changed power_levels", "changed join_rules"… none of which is
    /// something a player reads.
    #[test]
    fn room_setup_events_never_reach_the_timeline() {
        let gs = GuildState::default();
        for t in [
            "m.room.create", "m.room.power_levels", "m.room.join_rules",
            "m.room.history_visibility", "m.room.guest_access",
            "m.room.canonical_alias", "m.room.server_acl", "m.room.encryption",
        ] {
            let ev = json!({
                "type": t, "event_id": "$1", "sender": "@a:h",
                "origin_server_ts": 1, "content": {}
            });
            assert!(render_event(&ev, &gs, "!r:h", "@me:h").is_none(), "{} leaked", t);
        }
    }

    #[test]
    fn membership_and_renames_are_events_not_chat() {
        let gs = GuildState::default();
        let join = json!({
            "type": "m.room.member", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "membership": "join" }
        });
        let m = render_event(&join, &gs, "!r:h", "@me:h").unwrap();
        // Its own kind, so the window can render it as a dim one-liner rather
        // than as something someone said.
        assert_eq!(m.kind, "event");
        assert_eq!(m.body, "joined");

        let rename = json!({
            "type": "m.room.name", "event_id": "$2", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "name": "Guild Lobby" }
        });
        let r = render_event(&rename, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(r.kind, "event");
        assert!(r.body.contains("Guild Lobby"), "{}", r.body);
    }

    #[test]
    fn sync_folds_rooms_and_timelines() {
        let s = session();
        let v = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!snc:example.com": {
                "summary": { "m.joined_member_count": 25 },
                "state": { "events": [
                    { "type": "m.room.name", "content": { "name": "SN.Corporation" } },
                    { "type": "m.room.member", "state_key": "@1-42:example.com",
                      "content": { "displayname": "Netlag", "membership": "join" } }
                ]},
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$1",
                      "sender": "@1-42:example.com", "origin_server_ts": 5,
                      "content": { "msgtype": "m.text", "body": "Ok." } }
                ]}
            }}}
        });
        let (deltas, changed, _typing) = apply_sync("test-fold", &s, &v);
        assert!(changed);
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].1[0].sender_name, "Netlag");

        let rooms = rooms_of("test-fold");
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].name, "SN.Corporation");
        assert_eq!(rooms[0].members, 25);
        assert_eq!(rooms[0].section, "local");
        assert!(rooms[0].joined);
        assert_eq!(rooms[0].icon, "icon-guild");

        // A second, empty sync must not report a change — an idle homeserver
        // long-polls every 30s and would otherwise repaint the window forever.
        let (deltas2, changed2, _) = apply_sync("test-fold", &s, &json!({ "next_batch": "s3" }));
        assert!(deltas2.is_empty());
        assert!(!changed2);
    }

    #[test]
    fn typing_is_read_from_the_ephemeral_edu() {
        let s = session();
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [] },
                "ephemeral": { "events": [{
                    "type": "m.typing",
                    // The EDU always carries the WHOLE set, ourselves included.
                    "content": { "user_ids": ["@1-42:example.com", "@1-194:example.com"] }
                }]}
            }}}
        });
        let (_, _, typing) = apply_sync("test-typing", &s, &v);
        assert_eq!(typing.len(), 1);
        // Never report yourself as typing back at yourself.
        assert_eq!(typing[0].1, vec!["@1-42:example.com".to_string()]);

        // An empty set is how "stopped typing" arrives, and it must register
        // as a change so the line clears.
        let stop = json!({
            "next_batch": "2",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] }, "timeline": { "events": [] },
                "ephemeral": { "events": [{ "type": "m.typing", "content": { "user_ids": [] } }]}
            }}}
        });
        let (_, _, cleared) = apply_sync("test-typing", &s, &stop);
        assert_eq!(cleared.len(), 1);
        assert!(cleared[0].1.is_empty());

        // Repeating the same set is NOT a change — sync reports it constantly
        // and every repeat would repaint the window.
        let (_, _, again) = apply_sync("test-typing", &s, &stop);
        assert!(again.is_empty());
    }

    /// The SAME cases the window's own matcher is held to
    /// (scripts/harness-tests/chat.test.mjs, "mention matching"). Two
    /// implementations of one rule is a liability unless both are pinned to
    /// the same table — Rust decides whether to interrupt you, the window
    /// decides whether to highlight, and they must never disagree.
    #[test]
    fn mentions_match_on_word_boundaries() {
        let names = vec!["Marklifer".to_string(), "1-194".to_string()];
        for (body, want, why) in [
            ("Marklifer, are you seeing this?", true, "name followed by a comma"),
            ("hey Marklifer", true, "name at the end"),
            ("ping 1-194 please", true, "player id counts too"),
            ("Marklifers everywhere", false, "a longer word that starts with it"),
            ("xMarklifer", false, "a longer word that ends with it"),
            ("1-1944 is not me", false, "a longer id"),
            ("MARKLIFER", true, "case does not matter"),
            ("", false, "an empty body"),
            ("nothing to see", false, "no mention at all"),
        ] {
            assert_eq!(is_mention(body, &names), want, "{}: {:?}", why, body);
        }
    }

    #[test]
    fn a_short_name_is_not_matched_at_all() {
        // A one-character username would fire on almost every message; better
        // to miss those mentions than to interrupt constantly.
        let s = Session { user_id: "@1-1:example.com".into(), ..session() };
        assert!(!my_names(&s).iter().any(|n| n.chars().count() < 2));
    }

    #[test]
    fn a_room_is_notified_about_at_most_once_per_cooldown() {
        let room = "!cooldown-test:example.com";
        assert!(claim_notify_slot(room), "first notification should go out");
        assert!(!claim_notify_slot(room), "a second within the cooldown must not");
    }

    #[test]
    fn only_known_message_types_reach_the_wire() {
        assert_eq!(msgtype_or_text(Some("m.emote")), "m.emote");
        assert_eq!(msgtype_or_text(Some("m.notice")), "m.notice");
        assert_eq!(msgtype_or_text(None), "m.text");
        // A typo must not mint an event type no client renders.
        assert_eq!(msgtype_or_text(Some("m.emoat")), "m.text");
        assert_eq!(msgtype_or_text(Some("")), "m.text");
    }

    /// Transcribed from the LIVE crew.oh.energy account (2026-08-29): a real
    /// DM with `chatrbocks` that has no name, no alias, and NO `m.direct`
    /// entry — the homeserver simply never wrote one. It was rendering as its
    /// own room id.
    #[test]
    fn an_unnamed_two_person_room_is_a_direct_message() {
        let s = session();
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!LXmKAaU5h6gPr6VMuqsHXI2BiDUs:example.com": {
                "summary": {
                    "m.joined_member_count": 2,
                    "m.heroes": ["@1-3076:example.com", "@1-194:example.com"]
                },
                "state": { "events": [
                    { "type": "m.room.member", "state_key": "@1-3076:example.com",
                      "content": { "displayname": "chatrbocks", "membership": "join" } }
                ]},
                "timeline": { "events": [] }
            }}}
        });
        apply_sync("test-dm-heroes", &s, &v);
        let rooms = rooms_of("test-dm-heroes");
        assert_eq!(rooms.len(), 1);
        // Named after the person, filed under Direct — not a nameless channel.
        assert_eq!(rooms[0].name, "chatrbocks");
        assert_eq!(rooms[0].section, "direct");
        // Ourselves must never be the hero the room is named after.
        assert_ne!(rooms[0].name, "1-194");
    }

    /// A room id is never a name. This was the actual symptom: a real room
    /// showing as `!LXmKAaU5h6gPr6VMuqsHXI2BiDUs-FXky-w4gxDPUSk`.
    #[test]
    fn a_room_is_never_called_by_its_id() {
        let s = session();
        // No name, no alias, no heroes, and more than two people — nothing to
        // go on at all, which is exactly when the id used to leak through.
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!opaque:example.com": {
                "summary": { "m.joined_member_count": 9 },
                "state": { "events": [] }, "timeline": { "events": [] }
            }}}
        });
        apply_sync("test-noname", &s, &v);
        let rooms = rooms_of("test-noname");
        assert_eq!(rooms[0].name, "Untitled room");
        assert!(!rooms[0].name.starts_with('!'));
    }

    #[test]
    fn an_alias_reads_as_a_name() {
        // Live aliases from both homeservers.
        assert_eq!(pretty_alias("#orbital-hydro:matrix.crew.oh.energy").as_deref(),
            Some("Orbital Hydro"));
        assert_eq!(pretty_alias("#sn-corp:matrix.beta.playstructs.com").as_deref(),
            Some("Sn Corp"));
        assert_eq!(pretty_alias("#lobby:matrix.crab.la").as_deref(), Some("Lobby"));
        assert_eq!(pretty_alias("#:host").as_deref(), None);
    }

    #[test]
    fn a_named_room_keeps_its_own_name() {
        // The alias must never override a name the room actually set.
        let s = session();
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!x:example.com": {
                "state": { "events": [
                    { "type": "m.room.name", "content": { "name": "Kilgore Crabla — Guild Lobby" } },
                    { "type": "m.room.canonical_alias", "content": { "alias": "#lobby:example.com" } }
                ]},
                "timeline": { "events": [] }
            }}}
        });
        apply_sync("test-named", &s, &v);
        assert_eq!(rooms_of("test-named")[0].name, "Kilgore Crabla — Guild Lobby");
    }

    #[test]
    fn leaving_a_room_elsewhere_drops_it_here() {
        let s = session();
        apply_sync(
            "test-leave",
            &s,
            &json!({ "next_batch": "1", "rooms": { "join": { "!x:example.com": {
                "state": { "events": [{ "type": "m.room.name", "content": { "name": "X" } }] },
                "timeline": { "events": [] } } } } }),
        );
        assert_eq!(rooms_of("test-leave").len(), 1);
        let (_, changed, _) = apply_sync(
            "test-leave",
            &s,
            &json!({ "next_batch": "2", "rooms": { "leave": { "!x:example.com": {} } } }),
        );
        assert!(changed);
        assert!(rooms_of("test-leave").is_empty());
    }

    #[test]
    fn icons_only_ever_come_from_the_shipped_set() {
        const SHIPPED: &[&str] = &[
            "icon-raid", "icon-planet", "icon-guild", "icon-member", "icon-info", "icon-beacon",
        ];
        for (name, alias) in [
            ("Raid", None),
            ("Alpha Base", None),
            ("SN.Corporation", None),
            ("Community", None),
            ("Announcements", None),
            ("Something Else Entirely", Some("#zzz:h")),
        ] {
            assert!(SHIPPED.contains(&icon_for(name, alias)), "{}", name);
        }
    }
}
