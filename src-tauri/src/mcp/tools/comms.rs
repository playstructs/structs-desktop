//! `structs_comms` — headless Matrix (guild chat) for the agent.
//!
//! The desktop app already ships a full Matrix client (`crate::matrix`), but
//! its commands are wired only to the comms window. This tool re-exposes the
//! same functions over MCP so an agent can read and post to guild rooms as the
//! player it is already signed in as — sign-in is the in-app wallet signature,
//! so no key or token ever leaves the app.
//!
//! Every action defaults `guild_id` to `matrix::default_guild()`, so the
//! single-guild case needs no argument.

use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;

use crate::matrix;

#[derive(Debug, Deserialize)]
pub struct CommsParams {
    /// status, connect, disconnect, rooms, browse, timeline, backfill, send,
    /// join, leave, dm, react, people.
    pub action: String,
    /// Action-specific arguments.
    #[serde(default)]
    pub args: Value,
}

/// Uniform JSON envelope for a matrix command result.
fn out(result: Result<Value, String>) -> Vec<Content> {
    match result {
        Ok(v) => vec![Content::text(
            serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()),
        )],
        Err(e) => vec![Content::text(format!("Error: {}", e))],
    }
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn u32_arg(args: &Value, key: &str) -> Option<u32> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u32)
}

/// Resolve the guild: explicit `args.guild_id` wins, else the app default.
fn guild_of(args: &Value) -> Result<String, String> {
    str_arg(args, "guild_id")
        .or_else(matrix::default_guild)
        .ok_or_else(|| "no guild selected and none could be inferred".to_string())
}

fn missing(field: &str) -> Vec<Content> {
    vec![Content::text(format!("Error: '{}' is required", field))]
}

pub async fn execute(app_handle: &tauri::AppHandle, params: CommsParams) -> Vec<Content> {
    let args = &params.args;

    // `status` is the one action that never needs a guild — it reports every
    // network the app knows and which one is connected.
    if params.action == "status" {
        return out(matrix::matrix_status().await);
    }

    let guild = match guild_of(args) {
        Ok(g) => g,
        Err(e) => return vec![Content::text(format!("Error: {}", e))],
    };

    match params.action.as_str() {
        "connect" => out(matrix::matrix_connect(app_handle.clone(), guild).await),
        "disconnect" => out(matrix::matrix_disconnect(app_handle.clone(), guild).await),
        "rooms" => out(matrix::matrix_rooms(guild).await),
        "browse" => out(matrix::matrix_browse(guild, str_arg(args, "query")).await),
        "people" => out(matrix::matrix_people(guild, str_arg(args, "query")).await),
        "timeline" => {
            let Some(room_id) = str_arg(args, "room_id") else {
                return missing("room_id");
            };
            out(matrix::matrix_timeline(guild, room_id, u32_arg(args, "limit")).await)
        }
        "backfill" => {
            let Some(room_id) = str_arg(args, "room_id") else {
                return missing("room_id");
            };
            out(matrix::matrix_backfill(guild, room_id, u32_arg(args, "limit")).await)
        }
        "join" => {
            let Some(room_id) = str_arg(args, "room_id") else {
                return missing("room_id");
            };
            out(matrix::matrix_join(app_handle.clone(), guild, room_id).await)
        }
        "leave" => {
            let Some(room_id) = str_arg(args, "room_id") else {
                return missing("room_id");
            };
            out(matrix::matrix_leave(app_handle.clone(), guild, room_id).await)
        }
        "dm" => {
            let Some(player_id) = str_arg(args, "player_id") else {
                return missing("player_id");
            };
            out(matrix::matrix_dm(app_handle.clone(), guild, player_id).await)
        }
        "send" => {
            let Some(room_id) = str_arg(args, "room_id") else {
                return missing("room_id");
            };
            let Some(body) = str_arg(args, "body") else {
                return missing("body");
            };
            let mentions = args
                .get("mentions")
                .and_then(|v| v.as_array())
                .map(|a| a.to_vec());
            let reply_to = match args.get("reply_to") {
                Some(v) if !v.is_null() => match serde_json::from_value(v.clone()) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        return vec![Content::text(format!("Error: bad reply_to: {}", e))]
                    }
                },
                _ => None,
            };
            out(matrix::matrix_send(
                guild,
                room_id,
                body,
                str_arg(args, "msgtype"),
                mentions,
                reply_to,
            )
            .await)
        }
        "react" => {
            let (Some(room_id), Some(event_id), Some(key)) = (
                str_arg(args, "room_id"),
                str_arg(args, "event_id"),
                str_arg(args, "key"),
            ) else {
                return vec![Content::text(
                    "Error: 'room_id', 'event_id' and 'key' are required".to_string(),
                )];
            };
            let on = args.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
            out(matrix::matrix_react(guild, room_id, event_id, key, on).await)
        }
        other => vec![Content::text(format!(
            "Unknown comms action '{}'. Available: status, connect, disconnect, rooms, browse, people, timeline, backfill, join, leave, dm, send, react.",
            other
        ))],
    }
}
