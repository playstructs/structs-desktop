//! Web-served Team Ops dashboard — the SAME board.html/board.js the native
//! window runs, served as an authenticated web page from the MCP axum server,
//! so a human can drive the full dashboard from a browser (e.g. through an SSH
//! tunnel to a server-hosted app). A tiny frontend shim (board-shim.js) maps
//! `window.__TAURI__.core.invoke` onto `POST /board/invoke/<cmd>` and
//! `event.listen` onto one SSE stream at `/board/events`.
//!
//! OPT-IN: everything here 404s until the player enables it
//! (`structs_board web:"on"` or the Team Ops CONFIG page). Auth: the existing
//! MCP bearer token, delivered once as `?token=` and converted to an HttpOnly
//! cookie scoped to /board. The bearer token IS the operator authority — the
//! web path deliberately bypasses `require_board` (which gates the *native*
//! window write commands) by calling the shared `*_impl` bodies, which carry
//! the audit-feed pushes so web writes are logged identically.
//!
//! The server binds 127.0.0.1 only; remote humans reach it through the
//! operator's own tunnel (SSH/Tailscale/…). No TLS/CORS surface is added.

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use axum08::extract::{Path, State};
use axum08::http::{header, StatusCode, Uri};
use axum08::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum08::response::{IntoResponse, Response};
use axum08::routing::{get, post};
use axum08::Json;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::hasher::types::TaskRegistry;

pub const BOARD_COOKIE: &str = "structs_board";

// ── Opt-in flag ─────────────────────────────────────────────────────────────

static WEB_BOARD_ENABLED: AtomicBool = AtomicBool::new(false);

/// Load the persisted flag into the runtime atomic. Called at server start.
pub fn init_from_config() {
    let cfg = crate::mcp::config::McpConfig::load();
    WEB_BOARD_ENABLED.store(cfg.web_board_enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    WEB_BOARD_ENABLED.load(Ordering::Relaxed)
}

/// Flip the flag (runtime + persisted). Returns the new state.
pub fn set_enabled(enabled: bool) -> bool {
    WEB_BOARD_ENABLED.store(enabled, Ordering::Relaxed);
    let mut cfg = crate::mcp::config::McpConfig::load();
    cfg.web_board_enabled = enabled;
    if enabled {
        cfg.ensure_token();
    }
    let _ = cfg.save();
    enabled
}

/// The shareable URL (valid once enabled).
pub fn board_url() -> String {
    let mut cfg = crate::mcp::config::McpConfig::load();
    cfg.ensure_token();
    format!(
        "http://127.0.0.1:{}/board?token={}",
        cfg.port,
        cfg.bearer_token.as_deref().unwrap_or("")
    )
}

// ── Event bus ───────────────────────────────────────────────────────────────

/// Fan-out for every board-directed event: native window AND web SSE viewers.
pub static BOARD_BUS: LazyLock<broadcast::Sender<(String, Value)>> =
    LazyLock::new(|| broadcast::channel(256).0);

/// Single choke point replacing every `emit_to("board", …)`. The broadcast
/// always fires (web viewers may exist with no native window); the native emit
/// keeps its window-existence guard.
pub fn emit_board<S: serde::Serialize>(app: &tauri::AppHandle, event: &str, payload: S) {
    let value = serde_json::to_value(&payload).unwrap_or(Value::Null);
    let _ = BOARD_BUS.send((event.to_string(), value.clone()));
    use tauri::{Emitter, Manager};
    if app.get_webview_window("board").is_some() {
        let _ = app.emit_to("board", event, value);
    }
}

// ── Router ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct WebState {
    pub app: tauri::AppHandle,
    pub registry: Arc<TaskRegistry>,
}

pub fn router(state: WebState) -> axum08::Router {
    axum08::Router::new()
        .route("/board", get(board_redirect))
        .route("/board/", get(board_index))
        .route("/board/events", get(board_events))
        .route("/board/invoke/{command}", post(board_invoke))
        .route("/board/{*path}", get(board_asset))
        .with_state(state)
}

fn disabled() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// /board → /board/ (preserving the query) so board.html's relative asset
/// paths (css/…, board.js) resolve under /board/ with no base-href tricks.
async fn board_redirect(uri: Uri) -> Response {
    if !is_enabled() {
        return disabled();
    }
    let location = match uri.query() {
        Some(q) => format!("/board/?{q}"),
        None => "/board/".to_string(),
    };
    (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
}

/// /board/ — token-in-query gets swapped for an HttpOnly cookie (and the token
/// scrubbed from the address bar via redirect); otherwise serve board.html.
async fn board_index(State(st): State<WebState>, uri: Uri) -> Response {
    if !is_enabled() {
        return disabled();
    }
    let has_token = uri
        .query()
        .unwrap_or("")
        .split('&')
        .any(|p| p.split_once('=').map(|(k, _)| k == "token").unwrap_or(false));
    if has_token {
        // Middleware already validated it — mint the session cookie.
        let token = uri
            .query()
            .unwrap_or("")
            .split('&')
            .find_map(|p| p.strip_prefix("token="))
            .unwrap_or("");
        return (
            StatusCode::FOUND,
            [
                (header::LOCATION, "/board/".to_string()),
                (
                    header::SET_COOKIE,
                    format!("{BOARD_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/board"),
                ),
            ],
        )
            .into_response();
    }
    serve_asset(&st, "board.html")
}

/// Embedded frontend assets via the Tauri asset resolver (same bytes the
/// native webview gets; falls back to disk reads in dev).
async fn board_asset(State(st): State<WebState>, Path(path): Path<String>) -> Response {
    if !is_enabled() {
        return disabled();
    }
    serve_asset(&st, &path)
}

fn serve_asset(st: &WebState, path: &str) -> Response {
    match st.app.asset_resolver().get(path.to_string()) {
        Some(asset) => (
            [(header::CONTENT_TYPE, asset.mime_type)],
            asset.bytes,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// SSE tail of the board event bus. Keep-alive comments (~15s) keep SSH
/// tunnels from idling out. Lagged receivers skip (the board self-heals via
/// its own polling cadences).
async fn board_events() -> Response {
    if !is_enabled() {
        return disabled();
    }
    use tokio_stream::StreamExt;
    let stream = tokio_stream::wrappers::BroadcastStream::new(BOARD_BUS.subscribe()).filter_map(
        |msg| -> Option<Result<SseEvent, Infallible>> {
            match msg {
                Ok((name, payload)) => {
                    Some(Ok(SseEvent::default().event(name).data(payload.to_string())))
                }
                Err(_lagged) => None,
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

// ── Invoke dispatcher ───────────────────────────────────────────────────────

fn ok_json<S: serde::Serialize>(v: S) -> Response {
    Json(serde_json::to_value(v).unwrap_or(Value::Null)).into_response()
}

fn err_json(e: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response()
}

fn from_result<S: serde::Serialize>(r: Result<S, String>) -> Response {
    match r {
        Ok(v) => ok_json(v),
        Err(e) => err_json(e),
    }
}

/// POST /board/invoke/{command} — the web twin of Tauri `invoke`. Body keys are
/// the SAME camelCase the board frontend already sends (we bypass Tauri's
/// key-conversion layer). Commands taking WebviewWindow natively route through
/// their `*_impl` bodies here (token = authority; audits live in the impls).
async fn board_invoke(
    State(st): State<WebState>,
    Path(command): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !is_enabled() {
        return disabled();
    }
    use crate::mcp::tools::{board, board_pages, map, mass_action};
    let s = |k: &str| body.get(k).and_then(|v| v.as_str()).map(String::from);
    match command.as_str() {
        "mcp_board_html" => ok_json(board::mcp_board_html()),
        "mcp_board_refresh" => {
            from_result(board::mcp_board_refresh_impl(&st.app, &st.registry).await)
        }
        "mcp_board_feed" => ok_json(crate::mcp::board_feed::mcp_board_feed()),
        "mcp_ui_response" => {
            match serde_json::from_value::<crate::mcp::ui_bridge::UiResponse>(
                body.get("response").cloned().unwrap_or(Value::Null),
            ) {
                Ok(r) => from_result(crate::mcp::ui_bridge::mcp_ui_response(r).await),
                Err(e) => err_json(format!("bad response payload: {e}")),
            }
        }
        "mcp_roster" => ok_json(
            board_pages::mcp_roster(
                st.app.clone(),
                body.get("refreshIfOlderMs").and_then(|v| v.as_f64()),
            )
            .await,
        ),
        "mcp_roster_refresh" => ok_json(board_pages::mcp_roster_refresh(st.app.clone())),
        "mcp_player_detail" => match s("player") {
            Some(p) => from_result(board_pages::mcp_player_detail(p).await),
            None => err_json("player required".into()),
        },
        "mcp_energy" => from_result(board_pages::mcp_energy().await),
        "mcp_work" => from_result(board_pages::mcp_work_impl(&st.registry).await),
        "mcp_config_bundle" => from_result(board_pages::mcp_config_bundle().await),
        "mcp_config_set" => match (s("domain"), body.get("payload").cloned()) {
            (Some(d), Some(p)) => {
                from_result(board_pages::mcp_config_set_impl(st.app.clone(), d, p).await)
            }
            _ => err_json("domain + payload required".into()),
        },
        "mcp_role_pfp_get" => ok_json(board_pages::mcp_role_pfp_get().await),
        "mcp_role_pfp_set" => match (s("role"), body.get("config").cloned()) {
            (Some(r), Some(c)) => {
                from_result(board_pages::mcp_role_pfp_set_impl(st.app.clone(), r, c).await)
            }
            _ => err_json("role + config required".into()),
        },
        "mcp_tx_snapshot" => ok_json(board_pages::mcp_tx_snapshot(st.app.clone()).await),
        "mcp_tx_mutate" => match (s("op"), s("id")) {
            (Some(op), Some(id)) => from_result(
                board_pages::mcp_tx_mutate_impl(
                    st.app.clone(),
                    op,
                    id,
                    body.get("newIndex").and_then(|v| v.as_i64()),
                )
                .await,
            ),
            _ => err_json("op + id required".into()),
        },
        "mcp_grass_recent" => ok_json(crate::mcp::event_buffer::mcp_grass_recent(
            body.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize),
            s("category"),
        )),
        "mcp_mass_action" => {
            match serde_json::from_value::<mass_action::MassActionRequest>(
                body.get("request").cloned().unwrap_or(Value::Null),
            ) {
                Ok(req) => from_result(mass_action::mcp_mass_action_impl(st.app.clone(), req).await),
                Err(e) => err_json(format!("bad mass-action request: {e}")),
            }
        }
        "mcp_vplayer_list" => ok_json(board::mcp_vplayer_list()),
        "mcp_render_map" => match s("player") {
            Some(p) => from_result(map::mcp_render_map(st.app.clone(), p).await),
            None => err_json("player required".into()),
        },
        other => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown command '{other}'") })),
        )
            .into_response(),
    }
}
