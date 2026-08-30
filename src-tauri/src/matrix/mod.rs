//! Comms — federated chat over the guild's Matrix homeserver.
//!
//! Guilds that run structs-tel publish their homeserver in guild.json's
//! `services.matrix`. This module discovers those, signs in with the player's
//! existing Cosmos key (see `auth`), keeps a `/sync` loop per signed-in guild
//! (see `client`), and exposes the whole thing to `frontend/chat.js` as a
//! handful of commands.
//!
//! Deliberately unadvertised for now: the only door is the Comms button at the
//! top of the Debug panel. Nothing here runs unless that window is opened —
//! `boot()` restores sync only for guilds the player has ALREADY signed into,
//! so an install that has never used chat makes no chat requests at all.

pub mod avatar;
pub mod work;
pub mod auth;
pub mod client;
pub mod directory;
pub mod discovery;
pub mod refs;
pub mod store;

use serde_json::{json, Value};
use std::sync::RwLock;
use tauri::{Emitter, Manager};

/// Which network the window is looking at. Session-scoped: it is a view
/// preference, not something worth persisting across restarts.
static SELECTED: RwLock<Option<String>> = RwLock::new(None);

/// Why the last sign-in (or session) for a guild ended, kept until the next
/// successful connect. Without this, closing and reopening the window after a
/// failure shows a bare Connect button with no memory of what went wrong —
/// and the failure is usually the same one again.
static LAST_ERROR: std::sync::LazyLock<RwLock<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

pub fn note_error(guild_id: &str, msg: impl Into<String>) {
    if let Ok(mut m) = LAST_ERROR.write() {
        m.insert(guild_id.to_string(), msg.into());
    }
}

pub fn clear_error(guild_id: &str) {
    if let Ok(mut m) = LAST_ERROR.write() {
        m.remove(guild_id);
    }
}

fn last_error(guild_id: Option<&str>) -> Option<String> {
    let id = guild_id?;
    LAST_ERROR.read().ok()?.get(id).cloned()
}

// ── Status ──────────────────────────────────────────────────────────────────

/// The guild this player actually belongs to, from live game state, falling
/// back to the active config before the first sync lands.
fn own_guild_id() -> Option<String> {
    let from_game = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.guild_id.clone())
        .filter(|g| !g.is_empty());
    from_game.or_else(|| crate::guild_config::get_active().map(|c| c.guild_id))
}

/// The player's own guild's homeserver — and ONLY that one.
///
/// Federation means you can talk to other guilds, but you cannot AUTHENTICATE
/// to them: a guild webapp only issues OIDC tokens for addresses approved on
/// its own guild, so offering another guild's server could only ever produce a
/// sign-in that fails at the wallet-login rung. Cross-guild conversation
/// happens inside rooms and DMs, over federation, from this one account.
///
/// Still returned as a list: the window's nav renders whatever it is given,
/// and an empty list is the honest answer when the guild runs no comms server.
fn networks() -> Vec<Value> {
    let Some(guild_id) = own_guild_id() else {
        return Vec::new();
    };
    crate::guild_config::get_guild_configs()
        .into_iter()
        .filter(|c| c.guild_id == guild_id)
        .filter_map(|c| {
            let homeserver = c.matrix_url.clone().filter(|m| !m.is_empty())?;
            let session = store::get(&c.guild_id);
            Some(json!({
                "guild_id": c.guild_id,
                "guild_name": c.name,
                "tag": c.guild_tag,
                "homeserver": homeserver,
                "active": true,
                "logged_in": session.is_some(),
                "user_id": session.as_ref().map(|s| s.user_id.clone()),
            }))
        })
        .collect()
}

fn selected_guild() -> Option<String> {
    if let Ok(g) = SELECTED.read() {
        if let Some(id) = g.clone() {
            return Some(id);
        }
    }
    networks()
        .first()
        .and_then(|n| n.get("guild_id").and_then(|g| g.as_str()).map(String::from))
}

/// The HUD's own numbers, formatted by the game's OWN unit ladders.
///
/// These are pre-rendered here rather than in JS on purpose. `gs.alpha` is in
/// WHOLE Alpha and `gs.total_load()` is in MILLIWATTS, and each has its own
/// ladder (`format_alpha_whole`, `format_power`) already transcribed from the
/// server's UNIT_DISPLAY_FORMAT and used by Team Ops. Re-deriving that in the
/// window produced "128007K/133641K" where the game says "128.01KW/133.64KW".
/// One transcription, one answer.
///
/// `None` before the first sync; the window omits the row rather than showing
/// a placeholder number in a resource slot.
fn resources() -> Option<Value> {
    use crate::mcp::tools::format::{format_alpha_whole, format_power};
    let gs = crate::game_state::GAME_STATE.read().ok()?;
    if gs.player_id.is_none() {
        return None;
    }
    let load = gs.total_load();
    // Capacity is personal + substation, exactly as the HUD's
    // EnergyUsageComponent sums capacity + connection_capacity.
    let capacity = gs.total_capacity();
    Some(json!({
        "energy": format!("{}/{}", format_power(load), format_power(capacity)),
        // The HUD swaps to the insufficient-energy glyph when overloaded; so
        // does the window, from the same comparison.
        "overloaded": load > capacity,
        "alpha": gs.alpha.map(format_alpha_whole),
    }))
}

async fn status_payload() -> Value {
    // Identity for every player in the galaxy, so a timeline can show real
    // names and portraits and any player can be addressed. Cached with a TTL;
    // this is a no-op on all but the first call in 15 minutes.
    directory::ensure_fresh().await;
    let nets = networks();
    let guild = selected_guild();
    let profile = match guild.as_deref().and_then(store::get) {
        Some(session) => client::profile(&session).await.ok(),
        None => None,
    };
    json!({
        "networks": nets,
        "selected": guild,
        "profile": profile,
        "resources": resources(),
        "error": last_error(guild.as_deref()),
    })
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn matrix_status() -> Result<Value, String> {
    Ok(status_payload().await)
}

#[tauri::command]
pub async fn matrix_select(guild_id: String) -> Result<Value, String> {
    if let Ok(mut g) = SELECTED.write() {
        *g = Some(guild_id);
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn matrix_connect(app: tauri::AppHandle, guild_id: String) -> Result<Value, String> {
    let mut ladder = auth::Ladder::new();
    // The window draws the ladder from these pushes, so a sign-in that stalls
    // on one hop is visibly stalled ON THAT HOP rather than just slow.
    let emit_app = app.clone();
    let emit = move |l: &auth::Ladder| {
        let _ = emit_app.emit(
            "matrix::status",
            json!({ "connecting": true, "steps": l.steps() }),
        );
    };

    let result = auth::connect(&app, &guild_id, &mut ladder, emit).await;
    let steps = ladder.steps();

    match result {
        Ok(connected) => {
            clear_error(&guild_id);
            // A real id from this homeserver settles what it is called.
            directory::learn_server_name(&guild_id, &connected.user_id);
            client::start_sync(app.clone(), guild_id.clone());
            let _ = app.emit(
                "matrix::status",
                json!({ "connecting": false, "steps": steps, "error": null }),
            );
            Ok(json!({ "ok": true, "steps": steps }))
        }
        Err(e) => {
            note_error(&guild_id, e.clone());
            let _ = app.emit(
                "matrix::status",
                json!({ "connecting": false, "steps": steps, "error": e }),
            );
            // The steps ride along on the error path too — the caller shows
            // the ladder either way, and the failing hop is the whole point.
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn matrix_disconnect(app: tauri::AppHandle, guild_id: String) -> Result<Value, String> {
    if let Some(session) = store::get(&guild_id) {
        // Tell the homeserver first: after `store::remove` we no longer have
        // the token needed to revoke it.
        auth::logout(&session).await;
    }
    store::remove(&guild_id);
    client::stop_sync(&guild_id);
    // A deliberate sign-out is not a failure to remember.
    clear_error(&guild_id);
    let _ = app.emit("matrix::status", status_payload().await);
    Ok(json!({ "ok": true }))
}

/// The session for a guild, or a reason a player can act on.
///
/// The message is read by people, not only by logs: it surfaces on a roster
/// row in Team Ops and on a leaderboard in Game Stats, where "not signed in
/// to 0-5" names an identifier the player has never seen and gives them
/// nothing to do about it.
fn session_for(guild_id: &str) -> Result<store::Session, String> {
    store::get(guild_id).ok_or_else(|| "Comms is not connected — open Comms to sign in".to_string())
}

#[tauri::command]
pub async fn matrix_rooms(guild_id: String) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    // A directory failure is not a room-list failure: the joined rooms come
    // from sync and are already usable.
    if let Err(e) = client::refresh_directory(&guild_id, &session).await {
        eprintln!("[Comms] {} room directory: {}", guild_id, e);
    }
    Ok(json!({ "guild_id": guild_id, "rooms": client::rooms_of(&guild_id) }))
}

/// The homeserver's channel directory — everything public, not just what you
/// are already in. The channel list answers "where am I"; this answers "what
/// else is there", and conflating the two makes both worse.
#[tauri::command]
pub async fn matrix_browse(
    guild_id: String,
    query: Option<String>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let rooms = client::browse(&guild_id, &session, query.as_deref()).await?;
    Ok(json!({ "guild_id": guild_id, "rooms": rooms }))
}

#[tauri::command]
pub async fn matrix_timeline(
    guild_id: String,
    room_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let (room, cached) = client::timeline_of(&guild_id, &room_id, &session.user_id);
    let want = limit.unwrap_or(60).min(200);

    // Sync only carries what arrived since we connected. Opening a room the
    // player has not watched all session would otherwise be an empty screen
    // even though the room is full of history.
    let messages = if cached.len() as u32 >= want {
        cached
    } else {
        match client::fetch_messages(&guild_id, &session, &room_id, want).await {
            Ok(fetched) => {
                client::seed_timeline(&guild_id, &room_id, fetched.clone());
                fetched
            }
            // Backfill is an enhancement; whatever sync gave us still renders.
            Err(e) => {
                eprintln!("[Comms] {} backfill: {}", room_id, e);
                cached
            }
        }
    };
    // Computed after any backfill: it is answered against the timeline this
    // window holds, and a moment ago that timeline may have been empty.
    let seen = client::seen_of(&guild_id, &room_id, &session.user_id);
    Ok(json!({ "room": room, "messages": messages, "seen": seen }))
}

/// Older history, one page at a time — what every chat log does when you
/// scroll up. `more` says whether the room has further back to go, so the
/// window stops asking at the beginning instead of retrying forever.
#[tauri::command]
pub async fn matrix_backfill(
    guild_id: String,
    room_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let want = limit.unwrap_or(40).min(100);
    let (messages, more) = client::backfill(&guild_id, &session, &room_id, want).await?;
    Ok(json!({ "messages": messages, "more": more }))
}

/// What a reply is answering. The window already has all three on the
/// message being replied to, so asking for them costs nothing and saves a
/// fetch per reply on this side.
///
/// `rename_all` is load-bearing. Tauri converts the camelCase names of
/// top-level command ARGUMENTS to snake_case; it does nothing to the fields
/// INSIDE a struct one of them carries. Without this, the window's `eventId`
/// never became `event_id` and every reply failed with "missing field
/// event_id" — at send time, in front of the player, on a message they had
/// already written.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyTarget {
    pub event_id: String,
    pub sender: String,
    pub body: String,
}

#[tauri::command]
pub async fn matrix_send(
    guild_id: String,
    room_id: String,
    body: String,
    msgtype: Option<String>,
    mentions: Option<Vec<Value>>,
    reply_to: Option<ReplyTarget>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let body = body.trim();
    if body.is_empty() {
        return Err("nothing to send".into());
    }
    // `/me` sends an emote; everything else is plain text. The allowlist lives
    // in client.rs so the wire format has exactly one gatekeeper.
    let kind = client::msgtype_or_text(msgtype.as_deref());

    // `@Name` runs the window matched to real people. Both halves matter:
    // `m.mentions` is what NOTIFIES them and the pill is what Element renders,
    // so a message addressed to someone reached them as neither until now.
    let pairs: Vec<(String, String)> = mentions
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let name = m.get("name")?.as_str()?.to_string();
            let user_id = m.get("user_id")?.as_str()?.to_string();
            // Only ever a real Matrix id: the pill becomes a link, and a
            // malformed one would be a link to nothing.
            if name.is_empty() || !user_id.starts_with('@') || !user_id.contains(':') {
                return None;
            }
            Some((name, user_id))
        })
        .collect();

    // Replying carries what is being answered, so the fallback other clients
    // rely on can be built in one place — see `client::send_full`.
    let reply = reply_to.as_ref().map(|r| client::Reply {
        event_id: r.event_id.as_str(),
        sender: r.sender.as_str(),
        body: r.body.as_str(),
    });
    let event_id =
        client::send_full(&session, &room_id, body, kind, &pairs, reply).await?;
    Ok(json!({ "event_id": event_id, "msgtype": kind, "mentioned": pairs.len() }))
}

#[tauri::command]
pub async fn matrix_join(app: tauri::AppHandle, guild_id: String, room_id: String) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    client::join(&session, &room_id).await?;
    // Sync will report the room as joined on its next pass; nudge the window
    // now so the row stops offering a Join button it already honoured.
    if let Err(e) = client::refresh_directory(&guild_id, &session).await {
        eprintln!("[Comms] {} directory after join: {}", guild_id, e);
    }
    let _ = app.emit(
        "matrix::rooms",
        json!({ "guild_id": guild_id, "rooms": client::rooms_of(&guild_id) }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn matrix_leave(app: tauri::AppHandle, guild_id: String, room_id: String) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    client::leave(&session, &room_id).await?;
    let _ = app.emit(
        "matrix::rooms",
        json!({ "guild_id": guild_id, "rooms": client::rooms_of(&guild_id) }),
    );
    Ok(json!({ "ok": true }))
}

/// Open a direct message with any player.
///
/// Their address is public and total: the player id IS the Matrix localpart,
/// and their guild's homeserver is published in that guild's guild.json. So
/// this needs nothing from them — no handle to exchange, no friend request.
///
/// Idempotent: an existing DM with that player is returned rather than a
/// second room created beside it.
#[tauri::command]
pub async fn matrix_dm(
    app: tauri::AppHandle,
    guild_id: String,
    player_id: String,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let player_id = player_id.trim().trim_start_matches('#').to_string();
    if player_id.is_empty() {
        return Err("which player?".into());
    }
    directory::ensure_fresh().await;

    // Messaging yourself would create a room with one member and no purpose.
    if directory::player_id_of(&session.user_id).as_deref() == Some(player_id.as_str()) {
        return Err("that is you".into());
    }
    // Resolves from the chain when the directory has never met them — the
    // normal case now that the bulk roster route needs a login session.
    let their_id = directory::matrix_id_resolving(&player_id).await?;

    let room_id = client::open_dm(&guild_id, &session, &their_id).await?;
    let _ = app.emit(
        "matrix::rooms",
        json!({ "guild_id": guild_id, "rooms": client::rooms_of(&guild_id) }),
    );
    Ok(json!({ "room_id": room_id, "user_id": their_id, "player_id": player_id }))
}

/// Who can be messaged: every player the directory knows, for the window's
/// people picker. Excludes the player themselves and anyone whose guild runs
/// no homeserver — offering a name that cannot be reached is worse than
/// omitting it.
#[tauri::command]
pub async fn matrix_people(guild_id: String, query: Option<String>) -> Result<Value, String> {
    directory::ensure_fresh().await;
    let me = store::get(&guild_id)
        .and_then(|s| directory::player_id_of(&s.user_id))
        .unwrap_or_default();
    let q = query.unwrap_or_default().trim().to_lowercase();

    let mut rows: Vec<Value> = directory::all()
        .into_iter()
        .filter(|(pid, ident)| {
            *pid != me
                && directory::server_name_for_guild(&ident.guild_id).is_some()
                && (q.is_empty()
                    || pid.to_lowercase().contains(&q)
                    || ident.username.to_lowercase().contains(&q))
        })
        .map(|(pid, ident)| {
            json!({
                "player_id": pid,
                "username": ident.username,
                "tag": ident.tag,
                "guild_id": ident.guild_id,
                "pfp_attrs": ident.pfp_attrs,
            })
        })
        .collect();
    // Named players first — an unnamed row is just an id and helps nobody
    // scanning the list.
    rows.sort_by(|a, b| {
        let an = a.get("username").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("username").and_then(|v| v.as_str()).unwrap_or("");
        an.is_empty()
            .cmp(&bn.is_empty())
            .then(an.to_lowercase().cmp(&bn.to_lowercase()))
    });
    rows.truncate(200);
    Ok(json!({ "people": rows }))
}

/// Report that the player is typing (or has stopped).
///
/// Deliberately best-effort: a typing notice that fails to send is not worth
/// an error in the window, and the homeserver expires the state on its own.
#[tauri::command]
pub async fn matrix_typing(
    guild_id: String,
    room_id: String,
    typing: bool,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    if let Err(e) = client::set_typing(&session, &room_id, typing).await {
        eprintln!("[Comms] typing: {}", e);
    }
    Ok(json!({ "ok": true }))
}

/// Put the unread count in the window title — the MSN/ICQ taskbar signal.
///
/// The window is the only thing that knows what the player is actually looking
/// at, so it owns the count and tells Rust; Rust owns the title bar.
#[tauri::command]
pub fn matrix_badge(app: tauri::AppHandle, count: u32, mention: bool) -> Result<(), String> {
    let Some(w) = app.get_webview_window("chat") else {
        return Ok(());
    };
    // A bare count reads as noise; the marker makes "someone wants you"
    // distinguishable from "the room is busy" at a glance in the dock.
    let title = match (count, mention) {
        (0, _) => "Structs — Comms".to_string(),
        (n, true) => format!("({}!) Structs — Comms", n),
        (n, false) => format!("({}) Structs — Comms", n),
    };
    w.set_title(&title).map_err(|e| e.to_string())
}

/// Post a solved nonce back to the room that asked for it.
///
/// Called from the hasher when a borrowed task completes. Lives here rather
/// than there because it is a Comms concern; the hasher should not know what
/// a Matrix room is.
pub async fn post_work_result(
    guild_id: &str,
    room_id: &str,
    body: &str,
    work: Value,
    reply_to: &str,
) -> Result<String, String> {
    let session = session_for(guild_id)?;
    client::send_work(&session, room_id, body, work, Some(reply_to)).await
}

/// Ask a room for help with a proof.
///
/// The anchor comes from the CHAIN, never from the caller: a proof is
/// verified against the chain's own `blockStart*`, so an offer carrying a
/// guessed anchor would have every solver grinding a string that can never
/// be accepted.
#[tauri::command]
pub async fn matrix_work_offer(
    guild_id: String,
    room_id: String,
    object_id: String,
    task: String,
    block_start: u64,
    difficulty: u64,
    target_id: Option<String>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let task = task.to_uppercase();
    if !client_work_kind(&task) {
        return Err(format!("{} is not a kind of work the chain issues proofs for", task));
    }
    if block_start == 0 {
        return Err("that object has no cycle running, so there is nothing to prove yet".into());
    }
    if task == "RAID" && target_id.as_deref().unwrap_or("").is_empty() {
        return Err("a raid proof is anchored to its target planet".into());
    }
    let work = json!({
        "v": 1, "kind": "offer", "task": task, "object": object_id,
        "target": target_id, "block_start": block_start, "difficulty": difficulty,
    });
    let body = match target_id.as_deref() {
        Some(t) => format!("Work wanted: {} on {} against {} (anchor {})", task, object_id, t, block_start),
        None => format!("Work wanted: {} on {} (anchor {})", task, object_id, block_start),
    };
    let event_id = client::send_work(&session, &room_id, &body, work, None).await?;
    Ok(json!({ "ok": true, "event_id": event_id }))
}

fn client_work_kind(task: &str) -> bool {
    work::KINDS.contains(&task)
}

/// Silence a room, or let it speak again.
#[tauri::command]
pub async fn matrix_mute(
    app: tauri::AppHandle,
    guild_id: String,
    room_id: String,
    muted: bool,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    client::set_muted(&session, &room_id, muted).await?;
    client::note_muted(&guild_id, &room_id, muted);
    // The room list carries the flag, so push the new one rather than making
    // the window wait for a sync to tell it what it just did.
    let _ = app.emit(
        "matrix::rooms",
        json!({ "guild_id": guild_id, "rooms": client::rooms_of(&guild_id) }),
    );
    Ok(json!({ "ok": true, "muted": muted }))
}

/// The anchor the chain is currently running for this object, or 0.
///
/// Factored out of `matrix_work_params` because three different callers need
/// the same answer: making an offer, deciding whether one is still worth
/// grinding, and telling a reader that a card has gone dead.
async fn live_anchor(object_id: &str, task: &str) -> Result<u64, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    match task {
        // Since chain v0.21.0 the ore clock lives on the PLANET, not the
        // struct. Reading the struct's own field returns 0 forever, which
        // reads as "no cycle" rather than as a bug.
        "MINE" | "REFINE" => {
            let v = client.query_entity("struct", object_id).await?;
            let planet_id = v
                .get("Struct")
                .and_then(|s| s.get("locationId"))
                .and_then(|l| l.as_str())
                .map(str::to_string)
                .ok_or("that struct has no location, so it has no ore clock")?;
            let p = client.query_entity("planet", &planet_id).await?;
            Ok(crate::mcp::loop_util::planet_ore_anchor(Some(&p), task))
        }
        "BUILD" => {
            let v = client.query_entity("struct", object_id).await?;
            Ok(v.get("structAttributes")
                .and_then(|a| a.get("blockStartBuild"))
                .and_then(num_of)
                .unwrap_or(0))
        }
        // A raid's anchor lives on the fleet's own work record, which this
        // path cannot read. Unknown, never "dead".
        _ => Ok(0),
    }
}

/// Is an offer still worth anything?
///
/// `live` is false only when the chain is certainly running a DIFFERENT
/// cycle. A read failure, or a kind whose anchor this path cannot see, comes
/// back unknown — a card must never be greyed out on a guess.
#[tauri::command]
pub async fn matrix_work_status(
    object_id: String,
    task: String,
    block_start: u64,
) -> Result<Value, String> {
    let task = task.to_uppercase();
    let live = match live_anchor(&object_id, &task).await {
        Ok(a) => a,
        Err(_) => return Ok(json!({ "known": false })),
    };
    if live == 0 {
        return Ok(json!({ "known": false }));
    }
    Ok(json!({ "known": true, "live": live == block_start, "current": live }))
}

/// Everything an offer needs, resolved from the chain rather than guessed.
///
/// The window knows an object id and nothing else. The anchor in particular
/// must come from the chain: it is what the proof is verified against, and an
/// offer carrying a guessed one would have every solver grinding a string
/// that can never be accepted.
#[tauri::command]
pub async fn matrix_work_params(object_id: String, task: String) -> Result<Value, String> {
    let task = task.to_uppercase();
    if !work::KINDS.contains(&task.as_str()) {
        return Err(format!("{} is not a kind of work the chain issues proofs for", task));
    }
    let difficulty = {
        let gs = crate::game_state::GAME_STATE
            .read()
            .map_err(|_| "game state unavailable")?;
        gs.get_difficulty_for_struct(&object_id, &task).unwrap_or(0)
    };

    let block_start = live_anchor(&object_id, &task).await?;
    if block_start == 0 {
        return Err(format!(
            "{} has no {} cycle running, so there is nothing to prove yet",
            object_id, task
        ));
    }
    Ok(json!({ "object": object_id, "task": task,
               "block_start": block_start, "difficulty": difficulty }))
}

fn num_of(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
        .or_else(|| v.as_f64().map(|f| f as u64))
}

/// Submit a proof somebody else found.
///
/// Verified here first, from fields THIS side rebuilds — a result arriving
/// over federation is a claim, and submitting an unchecked one costs a
/// transaction and its charge to discover it was nonsense.
#[tauri::command]
pub async fn matrix_work_submit(
    app: tauri::AppHandle,
    object_id: String,
    task: String,
    block_start: u64,
    difficulty: u64,
    nonce: String,
    target_id: Option<String>,
) -> Result<Value, String> {
    let task = task.to_uppercase();
    let Some(proof) = work::verify(
        &object_id, &task, block_start, target_id.as_deref(), &nonce, difficulty,
    ) else {
        return Err("that nonce does not solve this task".into());
    };

    let (type_url, payload) = match task.as_str() {
        "MINE" => (
            "/structs.structs.MsgStructOreMinerComplete",
            json!({ "structId": object_id, "proof": proof, "nonce": nonce }),
        ),
        "REFINE" => (
            "/structs.structs.MsgStructOreRefineryComplete",
            json!({ "structId": object_id, "proof": proof, "nonce": nonce }),
        ),
        "BUILD" => (
            "/structs.structs.MsgStructBuildComplete",
            json!({ "structId": object_id, "proof": proof, "nonce": nonce }),
        ),
        "RAID" => (
            "/structs.structs.MsgPlanetRaidComplete",
            json!({ "fleetId": object_id, "proof": proof, "nonce": nonce }),
        ),
        _ => return Err(format!("{} is not a kind of work with a completion", task)),
    };

    // The chain rebuilds the hashed input from its OWN clock, so the proof is
    // valid only while that clock still reads what was solved against. This
    // guard re-tests at broadcast, which is the only moment that counts —
    // and a proof that came over chat has waited longer than a local one.
    let guard = match task.as_str() {
        "MINE" | "REFINE" => {
            let client = crate::mcp::cosmos_client::CosmosClient::new();
            client
                .query_entity("struct", &object_id)
                .await
                .ok()
                .and_then(|v| {
                    v.get("Struct")
                        .and_then(|s| s.get("locationId"))
                        .and_then(|l| l.as_str())
                        .map(str::to_string)
                })
                .map(|planet_id| crate::mcp::tx_retry::FreshAnchor {
                    planet_id,
                    task_type: task.clone(),
                    solved_anchor: block_start,
                })
        }
        _ => None,
    };

    // Index 0 is the primary's key: this is the owner submitting their own
    // work, whoever ground it.
    let res = crate::mcp::tx_retry::sign_with_retry_guarded(
        &app, 0, type_url, payload, "comms shared proof", guard,
    )
    .await?;
    Ok(json!({ "ok": true, "result": res }))
}

/// Take on somebody else's task.
///
/// Starts a local grind against the offer's own parameters and registers it
/// so that, on completion, the nonce is REPORTED rather than submitted — the
/// completion tx names its signer as `creator`, and only the owner's is
/// accepted.
#[tauri::command]
pub async fn matrix_work_accept(
    app: tauri::AppHandle,
    guild_id: String,
    room_id: String,
    offer_event: String,
    object_id: String,
    task: String,
    block_start: u64,
    difficulty: u64,
    target_id: Option<String>,
) -> Result<Value, String> {
    let task = task.to_uppercase();
    if !work::KINDS.contains(&task.as_str()) {
        return Err(format!("{} is not a kind of work the chain issues proofs for", task));
    }
    if block_start == 0 {
        return Err("that offer names no cycle to prove against".into());
    }
    if refs::parse_id(&object_id).is_none() {
        return Err(format!("{} is not an object id", object_id));
    }
    if task == "RAID" && target_id.as_deref().unwrap_or("").is_empty() {
        return Err("a raid proof is anchored to its target planet".into());
    }
    // Already grinding this one. Starting a second would spend a worker on a
    // nonce somebody here is about to find anyway.
    if crate::hasher::borrowed_hash(&object_id).is_some() {
        return Ok(json!({ "ok": true, "already": true }));
    }

    // An offer whose cycle has turned over is already worthless: the nonce
    // would be ground against an anchor the chain no longer holds. Checked
    // BEFORE a worker is spent rather than discovered an hour later — and
    // only refused when the chain certainly disagrees, never on a read
    // failure, which would make a working feature look broken offline.
    if let Ok(live) = live_anchor(&object_id, &task).await {
        if live != 0 && live != block_start {
            return Err(format!(
                "that offer is stale — {} is now on cycle {}, not {}",
                object_id, live, block_start
            ));
        }
    }

    let prefix = work::prefix(&object_id, &task, block_start, target_id.as_deref());
    let now_ms = crate::hasher::types::now_millis();
    let nonce_start = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        % 10_000_000_000) as u64;

    let params = crate::hasher::types::TaskParams {
        object_id: object_id.clone(),
        target_id: target_id.clone(),
        object_type: Some(if task == "RAID" { "fleet" } else { "struct" }.to_string()),
        task_type: Some(task.clone()),
        identity: None,
        prefix,
        postfix: String::new(),
        nonce_start,
        nonce_current: nonce_start,
        iterations: 0,
        iterations_since_last_start: 0,
        difficulty_start: None,
        difficulty_target: difficulty,
        block_start,
        block_checkpoint: block_start,
        block_checkpoint_time: now_ms,
        block_current_estimated: Some(block_start),
        result_exists: false,
        result_message: None,
        result_nonce: None,
        result_hash: None,
        result_difficulty: 0,
        estimated_hashrate: 300.0,
        estimated_block_start_offset: 0,
        status: "starting".to_string(),
    };

    crate::hasher::register_borrowed_hash(
        object_id.clone(),
        crate::hasher::BorrowedWork {
            guild_id: guild_id.clone(),
            room_id: room_id.clone(),
            offer_event,
            task: task.clone(),
            target: target_id,
            block_start,
            difficulty,
        },
    );
    use tauri::Manager;
    let registry = app
        .state::<std::sync::Arc<crate::hasher::types::TaskRegistry>>()
        .inner()
        .clone();
    if let Err(e) = crate::hasher::start_hash_task_core(params, app.clone(), &registry) {
        // Never leave a registration behind for a task that is not running:
        // the next completion for this object would report a proof nobody
        // here ground.
        crate::hasher::forget_borrowed_hash(&object_id);
        return Err(e);
    }
    Ok(json!({ "ok": true, "object": object_id, "task": task }))
}

/// Check a nonce somebody sent back.
///
/// Never trust the result's own account of what it solved. Everything except
/// the number is rebuilt from what the OFFER said, and the hash is recomputed
/// here — a forged result otherwise costs the owner a failed transaction and
/// its charge.
#[tauri::command]
pub async fn matrix_work_verify(
    object_id: String,
    task: String,
    block_start: u64,
    difficulty: u64,
    nonce: String,
    target_id: Option<String>,
) -> Result<Value, String> {
    let proof = work::verify(
        &object_id,
        &task.to_uppercase(),
        block_start,
        target_id.as_deref(),
        &nonce,
        difficulty,
    );
    Ok(match proof {
        Some(hash) => json!({ "ok": true, "proof": hash }),
        None => json!({ "ok": false }),
    })
}

/// Rewrite a message that has already been sent.
#[tauri::command]
pub async fn matrix_edit(
    guild_id: String,
    room_id: String,
    event_id: String,
    body: String,
    msgtype: Option<String>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let kind = client::msgtype_or_text(msgtype.as_deref());
    let id = client::edit(&session, &room_id, &event_id, &body, kind).await?;
    Ok(json!({ "ok": true, "event_id": id }))
}

/// Take a message back.
#[tauri::command]
pub async fn matrix_redact(
    guild_id: String,
    room_id: String,
    event_id: String,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    client::redact(&session, &room_id, &event_id).await?;
    Ok(json!({ "ok": true }))
}

/// Ids worth offering while someone is typing one.
///
/// Players talk in ids — "raid 2-15361", "5-2184 is stuck" — and typing one
/// from memory is how you end up referring to somebody else's planet. These
/// are the player's OWN objects, which is what they say most often; the
/// window adds whatever the room itself has already mentioned, which is the
/// other half of the answer and does not need Rust to know it.
#[tauri::command]
pub fn matrix_id_suggestions() -> Result<Value, String> {
    let gs = crate::game_state::GAME_STATE
        .read()
        .map_err(|_| "game state unavailable")?;
    let mut out: Vec<Value> = Vec::new();
    let mut add = |id: &Option<String>, what: &str| {
        if let Some(id) = id.as_ref().filter(|i| !i.trim().is_empty()) {
            out.push(json!({ "id": id, "label": what }));
        }
    };
    add(&gs.player_id, "you");
    add(&gs.planet_id, "your planet");
    add(&gs.fleet_id, "your fleet");
    add(&gs.guild_id, "your guild");
    Ok(json!({ "ids": out }))
}

/// React to a message, or take the reaction back.
#[tauri::command]
pub async fn matrix_react(
    guild_id: String,
    room_id: String,
    event_id: String,
    key: String,
    on: bool,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    client::react(&session, &room_id, &event_id, &key, on).await?;
    // Sync confirms it a round trip away; the window needs an answer now.
    Ok(json!({ "ok": true, "reactions": client::reactions_of(&session, &room_id, &event_id) }))
}

/// The messages a room has pinned.
#[tauri::command]
pub async fn matrix_pinned(guild_id: String, room_id: String) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let messages = client::pinned(&session, &room_id).await?;
    Ok(json!({ "room_id": room_id, "messages": messages }))
}

/// Pin or unpin one message.
///
/// Whether this account may is the homeserver's call — see `client::set_pinned`
/// for why that is not decided here.
#[tauri::command]
pub async fn matrix_pin(
    guild_id: String,
    room_id: String,
    event_id: String,
    pin: bool,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let pinned = client::set_pinned(&session, &room_id, &event_id, pin).await?;
    Ok(json!({ "ok": true, "pinned": pinned }))
}

/// Find something that was said.
///
/// `room_id` narrows it to one conversation; omitted, it looks everywhere the
/// account is joined. The homeserver does the searching — see `client::search`
/// for why that is not optional.
#[tauri::command]
pub async fn matrix_search(
    guild_id: String,
    query: String,
    room_id: Option<String>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let hits = client::search(&session, &query, room_id.as_deref(), 50).await?;
    Ok(json!({ "hits": hits, "query": query.trim() }))
}

/// What has been said about one game object, anywhere the player can read.
///
/// The spectator's version of chat. A raid window is where you are already
/// looking at a planet; "has anyone mentioned this" is the question that
/// belongs there, and it is a search the homeserver already knows how to
/// answer — no new room, no new protocol, no invented state.
///
/// Read-only on purpose. Sending from here would need a room to send TO, and
/// guessing which one is worse than handing the player to Comms with the id
/// already in the box, which `matrix_share` does.
#[tauri::command]
pub async fn matrix_object_chatter(
    guild_id: Option<String>,
    object_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let guild = guild_id.or_else(selected_guild).unwrap_or_default();
    // Not signed in, or no homeserver: silence, not an error. A raid window
    // must open and work whether or not Comms is connected.
    let Ok(session) = session_for(&guild) else {
        return Ok(json!({ "connected": false, "hits": [] }));
    };
    if refs::parse_id(&object_id).is_none() {
        return Err(format!("{} is not an object id", object_id));
    }
    let hits = client::search(&session, &object_id, None, limit.unwrap_or(12).min(50)).await?;
    Ok(json!({ "connected": true, "hits": hits }))
}

/// The line this player would publish about themselves, or None.
///
/// Derived from state that is already on a public chain — but see
/// `comms_status_enabled`: discoverable and broadcast are different things,
/// and which one applies is the player's call, not this function's.
///
/// Deliberately COARSE. "Fleet away" is already a tactical disclosure; a
/// target id would be a gift to whoever is reading.
pub fn status_line() -> Option<String> {
    let gs = crate::game_state::GAME_STATE.read().ok()?;
    let fleet = gs.fleet_status.as_deref().unwrap_or("");
    Some(match fleet {
        "away" => "Fleet away".to_string(),
        "onStation" => "On station".to_string(),
        _ => "Playing".to_string(),
    })
}

/// Publish, or stop publishing, a line about what this player is doing.
///
/// Turning it OFF clears the message rather than leaving the last one
/// standing: a status that stops updating is worse than none, because it
/// keeps asserting something that has stopped being true.
async fn push_status(guild_id: &str) {
    let Ok(session) = session_for(guild_id) else { return };
    let on = crate::mcp::config::McpConfig::load().comms_status_enabled;
    let msg = if on { status_line() } else { Some(String::new()) };
    if let Err(e) = client::publish_status(&session, "online", msg.as_deref()).await {
        eprintln!("[Comms] could not publish status: {}", e);
    }
}

/// Turn the status line on or off.
#[tauri::command]
pub async fn matrix_status_sharing(
    guild_id: Option<String>,
    enabled: bool,
) -> Result<Value, String> {
    let mut cfg = crate::mcp::config::McpConfig::load();
    cfg.comms_status_enabled = enabled;
    cfg.save().map_err(|e| e.to_string())?;
    let guild = guild_id.or_else(selected_guild).unwrap_or_default();
    // Immediately, in both directions: switching it off must clear what is
    // already published, not merely stop refreshing it.
    push_status(&guild).await;
    Ok(json!({ "enabled": enabled, "status": if enabled { status_line() } else { None } }))
}

/// Who is online, keyed by player id.
///
/// For every window in the app, not only Comms: Team Ops lists players, the
/// raid views list players, and "are they actually here" is the same question
/// in all of them.
#[tauri::command]
pub fn matrix_presence(guild_id: Option<String>) -> Result<Value, String> {
    let guild = guild_id.or_else(selected_guild).unwrap_or_default();
    // What we ourselves are publishing, so the window can say so plainly
    // rather than the player having to ask another client.
    let sharing = crate::mcp::config::McpConfig::load().comms_status_enabled;
    Ok(json!({
        "sharing": sharing,
        "status": if sharing { status_line() } else { None },
        // False means the homeserver has never mentioned anyone's presence —
        // most likely it has presence turned off, which many do. Surfaces
        // must then show NOTHING rather than a wall of grey dots implying an
        // empty guild.
        "known": client::presence_known(&guild),
        "presence": client::presence_by_player(&guild),
    }))
}

/// Is anything waiting in Comms?
///
/// For surfaces outside the Comms window — the door into it, most obviously.
/// The window pushes `matrix::unread` as it changes; this is the cold read
/// for anything that renders before the first sync of a session lands.
#[tauri::command]
pub fn matrix_unread() -> Result<Value, String> {
    let (count, mention) = client::unread_totals();
    Ok(json!({ "count": count, "mention": mention }))
}

/// Summarise the object ids a message mentioned.
///
/// Players talk in ids — "raid 2-15361", "5-2184 is stuck", "ask 1-61". The
/// window sends the ids it found; this answers with a card for each one it can
/// resolve, in the same shape Team Ops and the dashboard use. Unknown or
/// uninteresting ids simply come back absent and stay plain text.
#[tauri::command]
pub async fn matrix_refs(ids: Vec<String>) -> Result<Value, String> {
    // Bounded per call: a pasted log could otherwise name hundreds of objects
    // and turn one message into a burst of chain reads.
    const MAX: usize = 8;
    directory::ensure_fresh().await;
    // Player ids among the request resolve directly; owners named INSIDE a
    // card (a planet's owner, a struct's) come through the same cache.
    let players: Vec<String> = ids
        .iter()
        .filter(|id| refs::parse_id(id).map(|(k, _)| k) == Some(1))
        .cloned()
        .collect();
    directory::resolve_many(&players).await;

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids.into_iter().take(MAX * 4) {
        if out.len() >= MAX {
            break;
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(card) = refs::resolve(&id).await {
            out.push(card);
        }
    }
    Ok(json!({ "refs": out }))
}

/// Open a link found in a chat message, in the SYSTEM browser.
///
/// Deliberately not the app's existing `updater::open_url`: that one opens
/// whatever it is handed, and this one is fed by federated strangers. Only
/// http and https pass — `javascript:`, `file:`, `tauri:` and every custom
/// scheme a host might have registered are refused here rather than trusted to
/// the OS. Opening externally is also the point: nothing in a chat message can
/// navigate the app itself.
#[tauri::command]
pub async fn matrix_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let safe = openable(&url)?;
    app.opener()
        .open_url(safe, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The decision half of `matrix_open_url`, split out so it can be tested.
///
/// A security control with no test is one that gets simplified away later by
/// somebody who cannot see what it was for — and this one is fed by federated
/// strangers.
fn openable(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| format!("not a link: {}", url))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refusing to open a {} link", parsed.scheme()));
    }
    Ok(parsed.to_string())
}

/// Tell the homeserver how far you have read.
///
/// Without this, every other Matrix client the player uses still shows the
/// room as unread — and the desktop window's own notion of "read" would be
/// private to this machine.
#[tauri::command]
pub async fn matrix_mark_read(
    guild_id: String,
    room_id: String,
    event_id: String,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    // A local echo has no server event id; marking one would be a 400.
    if !event_id.starts_with('$') {
        return Ok(json!({ "ok": false }));
    }
    if let Err(e) = client::mark_read(&session, &room_id, &event_id).await {
        // Read markers are a courtesy to your other clients; failing to set
        // one must never surface as an error over the conversation.
        eprintln!("[Comms] read marker: {}", e);
    }
    Ok(json!({ "ok": true }))
}

/// Rent capacity from a provider, straight from the card that advertised it.
///
/// The whole cost — `rate × capacity × duration` — is debited AT OPEN in the
/// provider's own denom, not metered per block and not necessarily in Alpha.
/// So this reports the quote it is about to commit to, and the window shows it
/// before the player confirms: an agreement is a purchase, and a purchase made
/// by accident from a chat message would be indefensible.
#[tauri::command]
pub async fn matrix_agreement_open(
    app: tauri::AppHandle,
    provider_id: String,
    capacity: u64,
    duration: u64,
) -> Result<Value, String> {
    let provider_id = provider_id.trim().to_string();
    if refs::parse_id(&provider_id).map(|(k, _)| k) != Some(10) {
        return Err(format!("{} is not a provider", provider_id));
    }
    if capacity == 0 || duration == 0 {
        return Err("capacity and duration are both required".into());
    }

    // Re-read the provider rather than trusting numbers that came back from
    // the window: the card may be minutes old and the bounds are the chain's.
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let v = client
        .query_entity("provider", &provider_id)
        .await
        .map_err(|e| format!("provider {}: {}", provider_id, e))?;
    let p = v.get("Provider").cloned().unwrap_or(Value::Null);
    let n = |k: &str| -> u64 {
        p.get(k)
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    };
    let (cmin, cmax) = (n("capacityMinimum"), n("capacityMaximum"));
    let (dmin, dmax) = (n("durationMinimum"), n("durationMaximum"));
    if cmax > 0 && (capacity < cmin || capacity > cmax) {
        return Err(format!("capacity must be between {} and {}", cmin, cmax));
    }
    if dmax > 0 && (duration < dmin || duration > dmax) {
        return Err(format!("duration must be between {} and {} blocks", dmin, dmax));
    }

    let creator = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.wallet_address.clone())
        .ok_or("not signed in to the game")?;

    let payload = json!({
        "creator": creator,
        "providerId": provider_id,
        "capacity": capacity.to_string(),
        "duration": duration.to_string(),
    });
    // Index 0 is the primary — the player themselves, not a virtual worker.
    let res = crate::mcp::tx_retry::sign_with_retry(
        &app,
        0,
        "/structs.structs.MsgAgreementOpen",
        payload,
        &format!("comms agreement {}", provider_id),
    )
    .await?;

    Ok(json!({
        "ok": true,
        "provider_id": provider_id,
        "tx": res.get("transactionHash").and_then(|h| h.as_str()).unwrap_or("(pending)"),
    }))
}

/// The bytes of an image someone posted. Cached per (mxc, size) — a room
/// scrolled up and down would otherwise re-download every picture in it.
#[tauri::command]
pub async fn matrix_media(
    guild_id: String,
    mxc: String,
    size: Option<u32>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let size = size.unwrap_or(320);
    let key = format!("{}@{}", mxc, size);
    if let Some(hit) = MEDIA_CACHE.read().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }
    let (data_url, mime) = client::media_data_url(&session, &mxc, size).await?;
    let out = json!({ "data_url": data_url, "mime": mime });
    if let Ok(mut c) = MEDIA_CACHE.write() {
        // A handful of pictures, not a session's worth: these are base64 and
        // each is measured in tens of KB.
        if c.len() > 24 {
            c.clear();
        }
        c.insert(key, out.clone());
    }
    Ok(out)
}

static MEDIA_CACHE: std::sync::LazyLock<RwLock<std::collections::HashMap<String, Value>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// Who is in this room.
#[tauri::command]
pub async fn matrix_members(guild_id: String, room_id: String) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    Ok(json!({ "members": client::members(&session, &room_id).await? }))
}

// ── The window ──────────────────────────────────────────────────────────────

/// Idempotent: a second request raises the window already open rather than
/// stacking a duplicate, the way the raid windows do.
#[tauri::command]
pub fn open_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if let Some(w) = app.get_webview_window("chat") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    // No initialization_script, for the same reason the raid windows have
    // none: this document shares an origin with the game, and the game's init
    // script would give a non-game window the signing façades.
    WebviewWindowBuilder::new(&app, "chat", WebviewUrl::App("chat.html".into()))
        .title("Structs — Comms")
        // Portrait-ish: the mockup is a single column of channels and a single
        // column of messages, and the game's own menu panel is this shape.
        .inner_size(560.0, 820.0)
        .min_inner_size(380.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close it again. The nav's X goes through Rust rather than the JS window
/// API for two reasons: the v1 `getCurrent()` spelling silently no-ops on
/// Tauri 2, and closing from JS depends on a window ACL this capability set
/// does not obviously grant. The window is opened from Rust; closing it from
/// Rust is one mechanism instead of two.
#[tauri::command]
pub fn close_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("chat") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Message a player from ANYWHERE in the app.
///
/// Team Ops lists players constantly — the roster, the war board, raid
/// windows — and every one of those is a place where "talk to this person" is
/// the obvious next thought. This is the one call that turns a player id into
/// an open conversation: raise the window, resolve the DM, and tell the window
/// to show it.
#[tauri::command]
pub async fn matrix_message_player(
    app: tauri::AppHandle,
    player_id: String,
) -> Result<Value, String> {
    open_chat_window(app.clone())?;

    let guild_id = selected_guild()
        .ok_or("no guild you belong to runs a comms server")?;
    // The window signs in by itself when it boots, but this call may arrive
    // before that has happened — say so plainly rather than failing obscurely.
    let session = store::get(&guild_id).ok_or(
        "Comms is still signing in — try again in a moment",
    )?;
    let their_id = directory::matrix_id_resolving(player_id.trim()).await?;
    let room_id = client::open_dm(&guild_id, &session, &their_id).await?;

    // The window may still be booting, so this is also replayed: chat.js asks
    // for any pending target once it is ready.
    set_pending_room(&guild_id, &room_id);
    let _ = app.emit(
        "matrix::show_room",
        json!({ "guild_id": guild_id, "room_id": room_id }),
    );
    Ok(json!({ "room_id": room_id, "player_id": player_id }))
}

/// Bring something from the game into a conversation.
///
/// The game is full of moments worth saying something about — a raid on your
/// planet, a provider selling cheap, a player who just took a fleet apart —
/// and chat sat beside all of it. This is the bridge: anywhere in the app can
/// hand Comms an object, and it arrives as a DRAFT.
///
/// Deliberately a draft and not a post. Sharing is one click from a game
/// window, and one click must never put a message in front of other people:
/// the player picks the room and presses send, and gets to say why first.
#[tauri::command]
pub async fn matrix_share(app: tauri::AppHandle, text: String) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to share".into());
    }
    open_chat_window(app.clone())?;
    set_pending_draft(&text);
    let _ = app.emit("matrix::compose", json!({ "text": text }));
    Ok(json!({ "ok": true, "text": text }))
}

/// A draft the app handed Comms before the window was listening. Same
/// replay problem as a pending room: the share usually OPENS the window, so
/// the event fires into nothing.
static PENDING_DRAFT: RwLock<Option<String>> = RwLock::new(None);

fn set_pending_draft(text: &str) {
    if let Ok(mut d) = PENDING_DRAFT.write() {
        *d = Some(text.to_string());
    }
}

/// Take whatever the app asked to be composed, if anything. Consuming: a
/// draft already delivered must not reappear on the next status poll.
#[tauri::command]
pub fn matrix_take_pending_draft() -> Result<Value, String> {
    let taken = PENDING_DRAFT.write().ok().and_then(|mut d| d.take());
    Ok(match taken {
        Some(text) => json!({ "text": text }),
        None => Value::Null,
    })
}

/// A room the app has asked the window to show but which the window may not
/// have been alive to hear about. Claimed once, then forgotten.
static PENDING_ROOM: RwLock<Option<(String, String)>> = RwLock::new(None);

fn set_pending_room(guild_id: &str, room_id: &str) {
    if let Ok(mut p) = PENDING_ROOM.write() {
        *p = Some((guild_id.to_string(), room_id.to_string()));
    }
}

/// Take whatever the window was asked to show, if anything. Deliberately
/// consuming: a target already opened must not reopen on every status poll.
#[tauri::command]
pub fn matrix_take_pending_room() -> Result<Value, String> {
    let taken = PENDING_ROOM.write().ok().and_then(|mut p| p.take());
    Ok(match taken {
        Some((guild_id, room_id)) => json!({ "guild_id": guild_id, "room_id": room_id }),
        None => Value::Null,
    })
}

/// Restore sync for guilds already signed in. Called once at startup.
///
/// Only touches guilds with a STORED session — a player who has never opened
/// Comms causes no chat traffic, which is what keeps this feature genuinely
/// hidden rather than merely unlinked.
pub fn boot(app: tauri::AppHandle) {
    for session in store::all() {
        client::start_sync(app.clone(), session.guild_id.clone());
    }
}

#[cfg(test)]
mod tests {
    /// Links in chat come from federated strangers, and this is the only
    /// thing standing between one of them and the OS's scheme handlers.
    #[test]
    fn only_web_links_open() {
        assert!(super::openable("https://playstructs.com/x").is_ok());
        assert!(super::openable("http://example.com").is_ok());
        // Case is normalised by the parser, so an uppercase scheme is not a
        // way past the check.
        assert!(super::openable("HTTPS://example.com").is_ok());
        // Surrounding whitespace is trimmed rather than making it unparseable.
        assert!(super::openable("  https://example.com  ").is_ok());

        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost/x",
            "data:text/html,<script>x</script>",
            "vscode://file/etc/passwd",
            "mailto:someone@example.com",
        ] {
            assert!(super::openable(bad).is_err(), "should refuse: {}", bad);
        }
        // Not a link at all.
        assert!(super::openable("just some words").is_err());
        assert!(super::openable("").is_err());
    }

    use super::*;

    #[test]
    fn only_guilds_that_publish_a_homeserver_are_offered() {
        // networks() reads the live config, so this asserts the SHAPE rather
        // than the contents: every row must carry the fields chat.js reads,
        // and none may claim a homeserver it does not have.
        for n in networks() {
            let hs = n.get("homeserver").and_then(|h| h.as_str()).unwrap_or("");
            assert!(!hs.is_empty(), "a network row with no homeserver: {}", n);
            assert!(n.get("guild_id").is_some());
            assert!(n.get("logged_in").and_then(|l| l.as_bool()).is_some());
        }
    }
}
