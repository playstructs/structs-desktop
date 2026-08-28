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
    /// "local" | "galaxy" — see `section_for`.
    pub section: &'static str,
    pub icon: &'static str,
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
            "join" => ("notice", "joined".to_string()),
            "leave" => ("notice", "left".to_string()),
            "ban" => ("notice", "was banned".to_string()),
            // A membership change with nothing to say (a profile edit) is the
            // one event genuinely worth dropping.
            _ => return None,
        }
    } else if etype.starts_with("m.room.") {
        // State changes we have no dedicated rendering for still get a line.
        ("unknown", format!("changed {}", etype.trim_start_matches("m.room.")))
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

    Some(Message {
        event_id: event_id.to_string(),
        sender: sender.to_string(),
        sender_name: gs
            .names
            .get(sender)
            .cloned()
            .unwrap_or_else(|| localpart(sender)),
        // The localpart IS the player id, so a guild tag would have to come
        // from the game roster. Left None until that lookup exists rather than
        // guessed — a wrong tag misattributes a message to another guild.
        sender_tag: None,
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
fn apply_sync(guild_id: &str, session: &Session, v: &Value) -> (Vec<(String, Vec<Message>)>, bool) {
    let server = server_name(session);
    let mut deltas: Vec<(String, Vec<Message>)> = Vec::new();
    let mut rooms_changed = false;

    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.next_batch = v
        .get("next_batch")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());

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

        let existing = gs.rooms.get(&room_id).cloned();
        let display = name
            .clone()
            .or_else(|| existing.as_ref().map(|r| r.name.clone()).filter(|n| !n.is_empty()))
            .or_else(|| alias.clone())
            .unwrap_or_else(|| room_id.clone());
        let final_alias = alias.or_else(|| existing.as_ref().and_then(|r| r.canonical_alias.clone()));

        let entry = Room {
            room_id: room_id.clone(),
            icon: icon_for(&display, final_alias.as_deref()),
            name: display,
            canonical_alias: final_alias,
            topic: topic.or_else(|| existing.as_ref().and_then(|r| r.topic.clone())),
            members: members
                .or_else(|| existing.as_ref().map(|r| r.members))
                .unwrap_or(0),
            joined: true,
            // Unread lives in the window: it is a per-view concern, and the
            // window is the only thing that knows what the player is looking at.
            unread: 0,
            section: section_for(&room_id, &server),
        };
        if existing.as_ref() != Some(&entry) {
            rooms_changed = true;
        }
        gs.rooms.insert(room_id.clone(), entry);

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

    (deltas, rooms_changed)
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
                    let (deltas, rooms_changed) = apply_sync(&guild_id, &session, &v);
                    for (room_id, messages) in deltas {
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
            },
        );
    }
    Ok(())
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
    let url = format!("{}/rooms/{}/messages", base(session), urlseg(room_id));
    let limit_s = limit.to_string();
    let v = authed(session, move |c, s| {
        c.get(&url)
            .bearer_auth(&s.access_token)
            .query(&[("dir", "b"), ("limit", limit_s.as_str())])
    })
    .await?;

    let map = STATE.read().unwrap();
    let empty = GuildState::default();
    let gs = map.get(guild_id).unwrap_or(&empty);
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

/// Replace the cached timeline with a server-authoritative backfill.
pub fn seed_timeline(guild_id: &str, room_id: &str, messages: Vec<Message>) {
    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.timelines.insert(room_id.to_string(), messages);
}

pub async fn send(session: &Session, room_id: &str, body: &str) -> Result<String, String> {
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
    let payload = json!({ "msgtype": "m.text", "body": body });
    let v = authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    v.get("event_id")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "the homeserver accepted the message but returned no event id".to_string())
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
    Ok(json!({
        "user_id": session.user_id,
        "display_name": v.get("displayname").and_then(|d| d.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| localpart(&session.user_id)),
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
            "type": "m.room.server_acl", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "deny": ["evil.example"] }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.kind, "unknown");
        assert!(m.body.contains("server_acl"));
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
        let (deltas, changed) = apply_sync("test-fold", &s, &v);
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
        let (deltas2, changed2) = apply_sync("test-fold", &s, &json!({ "next_batch": "s3" }));
        assert!(deltas2.is_empty());
        assert!(!changed2);
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
        let (_, changed) = apply_sync(
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
