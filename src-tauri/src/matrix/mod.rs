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

pub mod auth;
pub mod client;
pub mod directory;
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
        Ok(_) => {
            clear_error(&guild_id);
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

fn session_for(guild_id: &str) -> Result<store::Session, String> {
    store::get(guild_id).ok_or_else(|| format!("not signed in to {}", guild_id))
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

#[tauri::command]
pub async fn matrix_timeline(
    guild_id: String,
    room_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let (room, cached) = client::timeline_of(&guild_id, &room_id);
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
    Ok(json!({ "room": room, "messages": messages }))
}

#[tauri::command]
pub async fn matrix_send(
    guild_id: String,
    room_id: String,
    body: String,
    msgtype: Option<String>,
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let body = body.trim();
    if body.is_empty() {
        return Err("nothing to send".into());
    }
    // `/me` sends an emote; everything else is plain text. The allowlist lives
    // in client.rs so the wire format has exactly one gatekeeper.
    let kind = client::msgtype_or_text(msgtype.as_deref());
    let event_id = client::send(&session, &room_id, body, kind).await?;
    Ok(json!({ "event_id": event_id, "msgtype": kind }))
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
    let their_id = directory::matrix_id_for(&player_id)?;

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
