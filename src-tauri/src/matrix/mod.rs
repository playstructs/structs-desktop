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

/// Guilds that publish a homeserver, in the order the window should show them:
/// the player's own guild first, then the rest by name.
fn networks() -> Vec<Value> {
    let active = crate::guild_config::get_active().map(|c| c.guild_id);
    let mut out: Vec<(bool, String, Value)> = crate::guild_config::get_guild_configs()
        .into_iter()
        .filter_map(|c| {
            let homeserver = c.matrix_url.clone().filter(|m| !m.is_empty())?;
            let session = store::get(&c.guild_id);
            let is_active = active.as_deref() == Some(c.guild_id.as_str());
            let name = c.name.clone();
            Some((
                is_active,
                name.to_lowercase(),
                json!({
                    "guild_id": c.guild_id,
                    "guild_name": c.name,
                    // The window shows this in the nav, where the game shows
                    // section names — short and already uppercase in-game.
                    "tag": c.guild_tag,
                    "homeserver": homeserver,
                    "active": is_active,
                    "logged_in": session.is_some(),
                    "user_id": session.as_ref().map(|s| s.user_id.clone()),
                }),
            ))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    out.into_iter().map(|(_, _, v)| v).collect()
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

/// The HUD's own numbers, read from the same live game state the HUD reads.
/// `None` before the first sync, and the window simply omits the row then —
/// a placeholder number in a resource slot is worse than an empty one.
fn resources() -> Option<Value> {
    let gs = crate::game_state::GAME_STATE.read().ok()?;
    if gs.player_id.is_none() {
        return None;
    }
    Some(json!({
        "energy_used": gs.total_load(),
        "energy_max": gs.capacity,
        "alpha": gs.alpha,
    }))
}

async fn status_payload() -> Value {
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
) -> Result<Value, String> {
    let session = session_for(&guild_id)?;
    let body = body.trim();
    if body.is_empty() {
        return Err("nothing to send".into());
    }
    let event_id = client::send(&session, &room_id, body).await?;
    Ok(json!({ "event_id": event_id }))
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
