//! On-chain guild infrastructure discovery + player-follows-guild switching.
//!
//! The chain is the source of truth: every guild record on the LCD
//! (`GET {reactor_api}/structs/guild`) carries an `endpoint` URL pointing to
//! that guild's config document (guild.json) whose `services` block declares
//! its infrastructure (guild_api, grass NATS websocket, reactor LCD, RPC ws).
//!
//! SECURITY: endpoint URLs and their JSON are untrusted UGC
//! (structs-ai/awareness/agent-security.md). Everything fetched here is
//! schema-validated, size-capped, and fetched with a dedicated cookie-less
//! client so the guild session cookie never leaks to arbitrary servers.
//! Per-guild failures are logged and skipped — one bad guild never aborts
//! a refresh.

use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

use crate::guild_config::{self, ConfigSource, GuildConfig};

/// Public chain node used to bootstrap discovery before any guild config
/// exists (and as fallback when the active reactor_api is unreachable).
pub const BOOTSTRAP_REACTOR_API: &str = "https://public.testnet.structs.network";

const ENDPOINT_BODY_CAP: usize = 64 * 1024;
const MAX_ENDPOINTS_PER_REFRESH: usize = 50;
/// Minimum seconds between silent guild switches (reload-loop guard).
const SWITCH_COOLDOWN_SECS: u64 = 60;
/// Cadence of the LCD backstop check for mid-session guild migrations the
/// webapp can't see (grass subjects are keyed by the player's NEW guild).
const BACKSTOP_SECS: u64 = 60;

// ── HTTP client (cookie-less) ───────────────────────────────────────────────

/// Dedicated client for untrusted guild endpoints and public LCD reads.
/// Deliberately NOT http_proxy::shared_client(): that jar carries the guild
/// session cookie, which must never be sent to guild-declared URLs.
fn directory_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .expect("failed to build directory HTTP client")
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Chain + endpoint document shapes ────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ChainGuild {
    #[serde(default)]
    id: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct GuildDoc {
    guild: GuildDocBody,
}

#[derive(Debug, Deserialize)]
struct GuildDocBody {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    logo: String,
    #[serde(default)]
    recruiting: Option<GuildRecruiting>,
    /// Cosmetic denom names keyed by exponent, e.g. `{"0":"ack","6":"snack"}`.
    /// Fetched with the rest of the document and, until the Inventory work,
    /// thrown away — which is why guild tokens could only ever be shown by
    /// their raw `uguild.<id>` name.
    #[serde(default)]
    denom: std::collections::BTreeMap<String, String>,
    services: GuildServices,
}

#[derive(Debug, Deserialize)]
struct GuildRecruiting {
    #[serde(default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct GuildServices {
    // Some guilds publish camelCase keys (documented gotcha).
    #[serde(default, alias = "guildApi")]
    guild_api: String,
    #[serde(default, alias = "reactorApi")]
    reactor_api: String,
    #[serde(default, alias = "clientWebsocket")]
    client_websocket: String,
    #[serde(default, alias = "grassNatsWebsocket")]
    grass_nats_websocket: String,
    /// Federated chat homeserver (structs-tel: Synapse + MAS). Absent for
    /// every guild that has not stood one up, which is most of them.
    #[serde(default)]
    matrix: String,
}

// ── Validation ──────────────────────────────────────────────────────────────

fn sanitize_label(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Validate a guild-declared service URL. `schemes` lists the allowed URL
/// schemes (e.g. ["http", "https"]). Rejects local/loopback hosts — these
/// URLs end up in the webview fetch proxy and Rust clients, and localhost
/// would alias the Tauri IPC origin.
fn validate_service_url(url: &str, schemes: &[&str], what: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("{}: unparseable ({})", what, e))?;
    if !schemes.contains(&parsed.scheme()) {
        return Err(format!(
            "{}: scheme '{}' not allowed (want one of {:?})",
            what,
            parsed.scheme(),
            schemes
        ));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host == "ipc.localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host == "[::1]"
        || host.starts_with("127.")
    {
        return Err(format!("{}: local host '{}' not allowed", what, host));
    }
    Ok(())
}

/// True when switching from `old` to `new` would downgrade an already-secure
/// URL (https→http / wss→ws) for the same host.
fn is_downgrade(old: &str, new: &str) -> bool {
    let (Ok(o), Ok(n)) = (reqwest::Url::parse(old), reqwest::Url::parse(new)) else {
        return false;
    };
    let secure_old = matches!(o.scheme(), "https" | "wss");
    let secure_new = matches!(n.scheme(), "https" | "wss");
    secure_old && !secure_new && o.host_str() == n.host_str()
}

/// Parse + validate a fetched guild.json against its chain record.
fn validate_guild_doc(chain: &ChainGuild, body: &[u8]) -> Result<GuildConfig, String> {
    let doc: GuildDoc =
        serde_json::from_slice(body).map_err(|e| format!("invalid guild.json: {}", e))?;

    // Anti-impersonation: the document must claim the same guild id as the
    // chain record that pointed at it.
    if doc.guild.id != chain.id {
        return Err(format!(
            "guild.json id '{}' does not match chain id '{}'",
            doc.guild.id, chain.id
        ));
    }

    // Only guild_api + grass_nats_ws are genuinely per-guild; validate those.
    // reactor_api + client_ws are shared chain infra and get pinned to the
    // public node below, so we ignore the guild's self-declared values for them
    // (guilds declare inconsistent/insecure/private reactor+RPC URLs — adopting
    // them caused a reload loop when the built-in stale-URL migration kept
    // rewriting client_ws back to the public node).
    let s = &doc.guild.services;
    validate_service_url(&s.guild_api, &["http", "https"], "guild_api")?;
    validate_service_url(
        &s.grass_nats_websocket,
        &["ws", "wss"],
        "grass_nats_websocket",
    )?;

    Ok(GuildConfig {
        guild_id: chain.id.clone(),
        name: sanitize_label(&doc.guild.name, 64),
        guild_tag: sanitize_label(&doc.guild.tag, 8),
        // Strip a trailing slash: the webapp's GuildAPI appends "/auth/..."
        // style paths to this base, so "http://host/api/" would yield a
        // double slash ("http://host/api//auth/...").
        guild_api: s.guild_api.trim_end_matches('/').to_string(),
        reactor_api: guild_config::PUBLIC_REACTOR_API.to_string(),
        client_ws: guild_config::PUBLIC_CLIENT_WS.to_string(),
        grass_nats_ws: s.grass_nats_websocket.clone(),
        is_active: false,
        endpoint: Some(chain.endpoint.clone()),
        source: ConfigSource::Chain,
        last_refreshed: Some(now_secs()),
        // Same sanitising as name/tag: this is guild-authored text that ends
        // up rendered next to real balances.
        // Optional, and validated on the same terms as the rest (https/http,
        // no loopback — it is fetched by Rust and its issuer drives an OAuth
        // redirect chain). A guild that declares a bad one loses chat, not its
        // whole directory entry, so this warns instead of returning Err.
        matrix_url: {
            let m = s.matrix.trim();
            if m.is_empty() {
                None
            } else if let Err(e) = validate_service_url(m, &["http", "https"], "matrix") {
                eprintln!("[Guild Directory] {} declares an unusable matrix URL: {}", chain.id, e);
                None
            } else {
                Some(m.trim_end_matches('/').to_string())
            }
        },
        denoms: doc
            .guild
            .denom
            .iter()
            .filter_map(|(k, v)| {
                let exp: u32 = k.trim().parse().ok()?;
                let label = sanitize_label(v, 24);
                if label.is_empty() {
                    return None;
                }
                Some((exp, label))
            })
            .collect(),
    })
}

// ── Fetching ────────────────────────────────────────────────────────────────

async fn fetch_capped(url: &str, what: &str) -> Result<Vec<u8>, String> {
    let resp = directory_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{}: fetch failed ({})", what, e))?;
    if !resp.status().is_success() {
        return Err(format!("{}: HTTP {}", what, resp.status().as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > ENDPOINT_BODY_CAP {
            return Err(format!("{}: body too large ({} bytes)", what, len));
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("{}: read failed ({})", what, e))?;
    if body.len() > ENDPOINT_BODY_CAP {
        return Err(format!("{}: body too large ({} bytes)", what, body.len()));
    }
    Ok(body.to_vec())
}

/// Reactor LCD base to use for chain reads: active config first, bootstrap
/// as fallback.
fn lcd_bases() -> Vec<String> {
    let mut bases = Vec::new();
    if let Some(active) = guild_config::get_active() {
        let b = active.reactor_api.trim_end_matches('/').to_string();
        if !b.is_empty() {
            bases.push(b);
        }
    }
    if !bases.iter().any(|b| b == BOOTSTRAP_REACTOR_API) {
        bases.push(BOOTSTRAP_REACTOR_API.to_string());
    }
    bases
}

fn parse_chain_guilds(v: &Value) -> Vec<ChainGuild> {
    let arr = v
        .get("Guild")
        .or_else(|| v.get("guild"))
        .and_then(|g| g.as_array())
        .cloned()
        .unwrap_or_default();
    arr.into_iter()
        .filter_map(|g| serde_json::from_value::<ChainGuild>(g).ok())
        .collect()
}

async fn fetch_guild_list() -> Result<Vec<ChainGuild>, String> {
    let mut last_err = String::new();
    for base in lcd_bases() {
        let url = format!("{}/structs/guild", base);
        match fetch_capped(&url, "guild list").await {
            Ok(body) => {
                let v: Value = serde_json::from_slice(&body)
                    .map_err(|e| format!("guild list: invalid JSON ({})", e))?;
                return Ok(parse_chain_guilds(&v));
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

async fn fetch_chain_guild(guild_id: &str) -> Result<ChainGuild, String> {
    let mut last_err = String::new();
    for base in lcd_bases() {
        let url = format!("{}/structs/guild/{}", base, guild_id);
        match fetch_capped(&url, "guild record").await {
            Ok(body) => {
                let v: Value = serde_json::from_slice(&body)
                    .map_err(|e| format!("guild record: invalid JSON ({})", e))?;
                let g = v.get("Guild").or_else(|| v.get("guild")).cloned();
                if let Some(g) = g {
                    if let Ok(cg) = serde_json::from_value::<ChainGuild>(g) {
                        return Ok(cg);
                    }
                }
                last_err = "guild record: unexpected shape".into();
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// Fetch + validate one guild's endpoint document.
async fn fetch_and_validate_guild(chain: &ChainGuild) -> Result<GuildConfig, String> {
    if chain.endpoint.trim().is_empty() {
        return Err("no endpoint declared".into());
    }
    validate_service_url(&chain.endpoint, &["http", "https"], "endpoint")?;
    let body = fetch_capped(&chain.endpoint, "endpoint doc").await?;
    validate_guild_doc(chain, &body)
}

/// One on-chain guild and the guild API it publishes, for reads that must ask
/// EVERY guild's own server (onboarding telemetry lives in each guild's
/// database, not on chain). Looser than `validate_guild_doc` on purpose: a
/// guild with no GRASS endpoint is refused as game infrastructure, but its
/// API still answers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GuildApiEntry {
    pub id: String,
    pub name: String,
    pub tag: String,
    /// `None` when the guild publishes no usable API; `error` says why.
    pub guild_api: Option<String>,
    pub error: Option<String>,
}

fn guild_api_entry(chain: &ChainGuild, body: Result<Vec<u8>, String>) -> GuildApiEntry {
    let mut e = GuildApiEntry { id: chain.id.clone(), name: String::new(), tag: String::new(), guild_api: None, error: None };
    let doc = body.and_then(|b| serde_json::from_slice::<GuildDoc>(&b).map_err(|err| format!("invalid guild.json: {err}")));
    match doc {
        Err(err) => e.error = Some(err),
        Ok(doc) if doc.guild.id != chain.id => {
            e.error = Some(format!("guild.json id '{}' does not match chain id '{}'", doc.guild.id, chain.id));
        }
        Ok(doc) => {
            e.name = sanitize_label(&doc.guild.name, 64);
            e.tag = sanitize_label(&doc.guild.tag, 8);
            let api = doc.guild.services.guild_api.trim();
            if api.is_empty() {
                e.error = Some("no guild API published".into());
            } else if let Err(err) = validate_service_url(api, &["http", "https"], "guild_api") {
                e.error = Some(err);
            } else {
                e.guild_api = Some(api.trim_end_matches('/').to_string());
            }
        }
    }
    e
}

/// Every guild on chain with its published API (or why it has none).
pub async fn guild_api_directory() -> Result<Vec<GuildApiEntry>, String> {
    let chain_guilds = fetch_guild_list().await?;
    let futs = chain_guilds.iter().take(MAX_ENDPOINTS_PER_REFRESH).map(|chain| async move {
        let body = if chain.endpoint.trim().is_empty() {
            Err("no endpoint declared".to_string())
        } else {
            match validate_service_url(&chain.endpoint, &["http", "https"], "endpoint") {
                Ok(()) => fetch_capped(&chain.endpoint, "endpoint doc").await,
                Err(e) => Err(e),
            }
        };
        guild_api_entry(chain, body)
    });
    Ok(futures_util::future::join_all(futs).await)
}

// ── Upsert into persisted configs ───────────────────────────────────────────

/// Merge discovered configs into the persisted set. Matches by guild_id;
/// respects user-managed entries (URLs untouched); never deletes entries;
/// never changes is_active.
fn upsert_discovered(existing: &mut Vec<GuildConfig>, found: Vec<GuildConfig>) -> bool {
    let mut changed = false;
    for f in found {
        match existing
            .iter_mut()
            .find(|c| !c.guild_id.is_empty() && c.guild_id == f.guild_id)
        {
            Some(c) => {
                if c.source == ConfigSource::User {
                    continue;
                }
                // Never downgrade an already-secure URL for the same host.
                if !is_downgrade(&c.guild_api, &f.guild_api) {
                    c.guild_api = f.guild_api;
                }
                if !is_downgrade(&c.reactor_api, &f.reactor_api) {
                    c.reactor_api = f.reactor_api;
                }
                if !is_downgrade(&c.client_ws, &f.client_ws) {
                    c.client_ws = f.client_ws;
                }
                if !is_downgrade(&c.grass_nats_ws, &f.grass_nats_ws) {
                    c.grass_nats_ws = f.grass_nats_ws;
                }
                if !f.name.is_empty() {
                    c.name = f.name;
                }
                if !f.guild_tag.is_empty() {
                    c.guild_tag = f.guild_tag;
                }
                if !f.denoms.is_empty() {
                    c.denoms = f.denoms;
                }
                // Assigned unconditionally, not merged: a guild that removes
                // `matrix` from its guild.json has retired its homeserver, and
                // keeping a stale URL would leave Comms pointed at nothing.
                c.matrix_url = f.matrix_url;
                c.endpoint = f.endpoint;
                c.source = ConfigSource::Chain;
                c.last_refreshed = f.last_refreshed;
                changed = true; // at minimum last_refreshed advanced
            }
            None => {
                existing.push(f);
                changed = true;
            }
        }
    }
    changed
}

// ── One guild's manifest, on demand ─────────────────────────────────────────

/// The manifest of one guild — from the persisted directory when it already
/// carries what Comms needs, otherwise fetched fresh off the guild's on-chain
/// endpoint and remembered. Comms needs this for guilds it has never heard
/// of: a planet's room lives on its OWNER's guild homeserver, and its API is
/// what makes the room.
pub async fn manifest_for(guild_id: &str) -> Result<GuildConfig, String> {
    if let Some(c) = guild_config::get_guild_configs()
        .into_iter()
        .find(|c| c.guild_id == guild_id)
    {
        if !c.guild_api.trim().is_empty() && c.matrix_url.is_some() {
            return Ok(c);
        }
    }
    let chain = fetch_chain_guild(guild_id).await?;
    let cfg = fetch_and_validate_guild(&chain).await?;
    remember(cfg.clone());
    Ok(cfg)
}

/// A manifest at an endpoint another guild's API named — the route a 409
/// from `chat/room/ensure` sends us down. Validated exactly like one the
/// chain pointed at: the document must claim the id we were told.
pub async fn manifest_at(guild_id: &str, endpoint: &str) -> Result<GuildConfig, String> {
    let chain = ChainGuild { id: guild_id.to_string(), endpoint: endpoint.to_string(), name: String::new() };
    let cfg = fetch_and_validate_guild(&chain).await?;
    remember(cfg.clone());
    Ok(cfg)
}

/// Read an endpoint the way the directory would — fetch, then validate it
/// claims `guild_id` and names a Guild API and a GRASS stream — WITHOUT
/// adopting it. The founding card's "Check" for a self-hosted guild.json.
pub async fn probe_endpoint(guild_id: &str, endpoint: &str) -> Result<GuildConfig, String> {
    let chain = ChainGuild { id: guild_id.to_string(), endpoint: endpoint.to_string(), name: String::new() };
    fetch_and_validate_guild(&chain).await
}

/// The same validation over a document already in hand (a rendered
/// guild.json, before it is ever published).
pub fn check_doc(guild_id: &str, body: &[u8]) -> Result<GuildConfig, String> {
    validate_guild_doc(&ChainGuild { id: guild_id.to_string(), endpoint: String::new(), name: String::new() }, body)
}

fn remember(cfg: GuildConfig) {
    if let Err(e) = guild_config::update_configs(|all| upsert_discovered(all, vec![cfg])) {
        eprintln!("[Guild Directory] could not persist a fetched manifest: {e}");
    }
}

#[derive(Debug, Default, serde::Serialize)]
pub struct RefreshReport {
    pub discovered: usize,
    pub skipped: Vec<String>,
    /// True when the ACTIVE guild's URLs changed (frontend reload needed).
    pub active_changed: bool,
}

/// Full directory refresh: chain guild list → each endpoint doc → upsert.
pub async fn refresh_directory() -> Result<RefreshReport, String> {
    let chain_guilds = fetch_guild_list().await?;
    let mut report = RefreshReport::default();

    let active_before = guild_config::get_active();

    let mut found = Vec::new();
    for chain in chain_guilds.iter().take(MAX_ENDPOINTS_PER_REFRESH) {
        match fetch_and_validate_guild(chain).await {
            Ok(cfg) => found.push(cfg),
            Err(e) => {
                eprintln!("[Guild Directory] skip {}: {}", chain.id, e);
                report.skipped.push(format!("{}: {}", chain.id, e));
            }
        }
    }
    report.discovered = found.len();

    if guild_config::update_configs(|configs| upsert_discovered(configs, found)).map_err(|e| e.to_string())? {
        crate::mcp::cosmos_client::reload_all();
    }

    if let (Some(before), Some(after)) = (active_before, guild_config::get_active()) {
        report.active_changed = before.guild_api != after.guild_api
            || before.grass_nats_ws != after.grass_nats_ws
            || before.client_ws != after.client_ws
            || before.reactor_api != after.reactor_api;
    }
    Ok(report)
}

#[tauri::command]
pub async fn refresh_guild_directory() -> Result<RefreshReport, String> {
    refresh_directory().await
}

// ── One guild's connection, whatever it takes ───────────────────────────────

fn stored(guild_id: &str) -> Option<GuildConfig> {
    guild_config::get_guild_configs()
        .into_iter()
        .find(|c| c.guild_id == guild_id)
}

/// The connection for a guild that publishes no server of its own: the host's,
/// under this guild's id. Every guild server indexes the whole chain and signs
/// an address in under whichever guild the chain says it belongs to, so the
/// player keeps playing; the next refresh replaces it if the guild ever
/// publishes one. No `endpoint` and no homeserver: this is not a guild anybody
/// can be offered, only one its own members can be in.
fn hosted_by(chain: &ChainGuild, host: &GuildConfig) -> GuildConfig {
    let name = sanitize_label(&chain.name, 64);
    GuildConfig {
        guild_id: chain.id.clone(),
        name: if name.is_empty() { format!("Guild {}", chain.id) } else { name },
        guild_tag: String::new(),
        is_active: false,
        endpoint: None,
        source: ConfigSource::Chain,
        last_refreshed: Some(now_secs()),
        denoms: Default::default(),
        matrix_url: None,
        ..host.clone()
    }
}

/// The persisted connection for `guild_id`, freshly read from the guild when
/// it answers.
async fn ensure_config(guild_id: &str) -> Result<GuildConfig, String> {
    let chain = fetch_chain_guild(guild_id).await;
    let trouble = match &chain {
        Ok(c) => fetch_and_validate_guild(c).await.map(remember).err(),
        Err(e) => Some(e.clone()),
    };
    if let Some(e) = &trouble {
        eprintln!("[Guild Directory] {guild_id}: no fresh guild.json ({e})");
    }
    if let Some(cfg) = stored(guild_id) {
        return Ok(cfg);
    }
    let chain = chain?;
    let host = guild_config::get_active().ok_or("no active guild to stand in for it")?;
    crate::mcp::telemetry::tlog(
        "guild_directory",
        crate::mcp::telemetry::Sev::Warn,
        format!("{guild_id} publishes no usable server ({}); using {}'s", trouble.unwrap_or_default(), host.name),
    );
    let cfg = hosted_by(&chain, &host);
    guild_config::update_configs(|all| {
        all.push(cfg.clone());
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(cfg)
}

fn is_guild_id(s: &str) -> bool {
    s.strip_prefix("0-").is_some_and(|n| !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_digit()))
}

// ── Guild switch (persist + live handoff to the webview) ───────────────────

/// Point the app at `guild_id`: the persisted config, the Rust clients, the
/// Guild API session (the next call signs in as this guild's member; GRASS
/// reconnects itself when its address changed), and the game window. The
/// window's init-script config is frozen at app start, so the handoff goes
/// through sessionStorage (read synchronously at document-start on reload).
async fn switch_to(app: &tauri::AppHandle, guild_id: &str) -> Result<(), String> {
    ensure_config(guild_id).await?;
    guild_config::set_active_guild(guild_id.to_string())?;
    set_cached_active_guild(guild_id);
    crate::mcp::guild_auth::forget();

    let active = guild_config::get_active()
        .ok_or_else(|| format!("guild '{}' not found after activation", guild_id))?;
    let fc = guild_config::FrontendConfig::from(&active);
    let json = serde_json::to_string(&fc).map_err(|e| e.to_string())?;

    crate::mcp::telemetry::tlog(
        "guild_directory",
        crate::mcp::telemetry::Sev::Info,
        format!("active guild is now {} ({}) on {}", active.name, active.guild_id, active.guild_api),
    );

    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            r#"try {{ sessionStorage.setItem('structs_config_override', {json}); }} catch(e) {{}} location.reload();"#,
            json = serde_json::to_string(&json).map_err(|e| e.to_string())?
        );
        window.eval(&script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The guild directory's pick, before anyone is signed in.
#[tauri::command]
pub async fn apply_guild_switch(window: tauri::WebviewWindow, guild_id: String) -> Result<(), String> {
    game_window(&window)?;
    if !is_guild_id(&guild_id) {
        return Err(format!("'{guild_id}' is not a guild id"));
    }
    switch_to(window.app_handle(), &guild_id).await
}

/// The game window, or one the app built for the player. Never a window that
/// renders what strangers wrote.
fn game_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        return Ok(());
    }
    crate::mcp::tools::board_pages::require_trusted(window)
}

// ── The directory a player picks from ───────────────────────────────────────

/// One guild a player can join or sign in to: it publishes a server this app
/// can play on.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GuildListing {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub logo: Option<String>,
    pub description: String,
    /// `None` when no server could say.
    pub members: Option<u64>,
    pub recruiting: bool,
    pub active: bool,
}

const LISTINGS_TTL_SECS: u64 = 300;
static LISTINGS: Mutex<(u64, Vec<GuildListing>)> = Mutex::new((0, Vec::new()));

fn listing_of(cfg: &GuildConfig, body: &[u8]) -> GuildListing {
    let doc = serde_json::from_slice::<GuildDoc>(body).ok().map(|d| d.guild);
    GuildListing {
        id: cfg.guild_id.clone(),
        name: cfg.name.clone(),
        tag: cfg.guild_tag.clone(),
        logo: doc
            .as_ref()
            .map(|d| d.logo.trim().to_string())
            .filter(|l| validate_service_url(l, &["https"], "logo").is_ok()),
        description: doc.as_ref().map(|d| sanitize_label(&d.description, 160)).unwrap_or_default(),
        members: None,
        recruiting: doc
            .as_ref()
            .and_then(|d| d.recruiting.as_ref())
            .is_some_and(|r| r.status.trim().eq_ignore_ascii_case("open")),
        active: false,
    }
}

/// Member counts by guild id, from a guild server's public directory. Every
/// server indexes every guild, so any one answers for all of them.
fn parse_members(v: &Value) -> std::collections::HashMap<String, u64> {
    let mut out = std::collections::HashMap::new();
    for row in v.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
        let n = row.get("members").and_then(|m| m.as_u64().or_else(|| m.as_str()?.parse().ok()));
        if let (Some(id), Some(n)) = (row.get("guild_id").and_then(|g| g.as_str()), n) {
            out.insert(id.to_string(), n);
        }
    }
    out
}

async fn member_counts() -> std::collections::HashMap<String, u64> {
    let mut apis: Vec<String> = guild_config::get_active().map(|c| c.guild_api).into_iter().collect();
    for c in guild_config::get_guild_configs() {
        if !apis.contains(&c.guild_api) {
            apis.push(c.guild_api);
        }
    }
    for api in apis.iter().take(3) {
        let url = format!("{}/guild/directory", api.trim_end_matches('/'));
        if let Ok(body) = fetch_capped(&url, "guild directory").await {
            if let Ok(v) = serde_json::from_slice::<Value>(&body) {
                let m = parse_members(&v);
                if !m.is_empty() {
                    return m;
                }
            }
        }
    }
    Default::default()
}

/// Largest first; a guild nobody counted sits after those somebody did.
fn sort_listings(all: &mut [GuildListing]) {
    let index = |id: &str| id.rsplit('-').next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(u64::MAX);
    all.sort_by(|a, b| b.members.cmp(&a.members).then_with(|| index(&a.id).cmp(&index(&b.id))));
}

async fn read_listings() -> Result<Vec<GuildListing>, String> {
    let chain = fetch_guild_list().await?;
    let reads = chain.iter().take(MAX_ENDPOINTS_PER_REFRESH).map(|c| async move {
        if c.endpoint.trim().is_empty() || validate_service_url(&c.endpoint, &["http", "https"], "endpoint").is_err() {
            return None;
        }
        let body = fetch_capped(&c.endpoint, "endpoint doc").await.ok()?;
        let cfg = validate_guild_doc(c, &body).ok()?;
        let listing = listing_of(&cfg, &body);
        Some((cfg, listing))
    });
    let (found, members) = futures_util::future::join(futures_util::future::join_all(reads), member_counts()).await;
    let (configs, mut listings): (Vec<_>, Vec<_>) = found.into_iter().flatten().unzip();
    if listings.is_empty() {
        return Err("no guild answered".into());
    }
    for l in listings.iter_mut() {
        l.members = members.get(&l.id).copied();
    }
    if let Err(e) = guild_config::update_configs(|all| upsert_discovered(all, configs)) {
        eprintln!("[Guild Directory] could not persist the directory: {e}");
    }
    sort_listings(&mut listings);
    Ok(listings)
}

/// Every guild a player can be pointed at, read off the chain and each guild's
/// own guild.json, kept for five minutes. With the chain unreachable it is the
/// guilds this install already knows.
#[tauri::command]
pub async fn guild_listings() -> Result<Vec<GuildListing>, String> {
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = ONE.lock().await;
    let fresh = |g: &(u64, Vec<GuildListing>)| !g.1.is_empty() && now_secs().saturating_sub(g.0) < LISTINGS_TTL_SECS;
    let held = LISTINGS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let mut all = if fresh(&held) {
        held.1
    } else {
        match read_listings().await {
            Ok(all) => {
                *LISTINGS.lock().unwrap_or_else(|p| p.into_inner()) = (now_secs(), all.clone());
                all
            }
            Err(e) if !held.1.is_empty() => {
                eprintln!("[Guild Directory] listings: {e}; showing the last good list");
                held.1
            }
            Err(e) => {
                eprintln!("[Guild Directory] listings: {e}; showing stored guilds");
                let mut known: Vec<GuildListing> = guild_config::get_guild_configs()
                    .iter()
                    .filter(|c| c.endpoint.is_some() && is_guild_id(&c.guild_id))
                    .map(|c| listing_of(c, b""))
                    .collect();
                sort_listings(&mut known);
                known
            }
        }
    };
    let active = guild_config::get_active().map(|c| c.guild_id).unwrap_or_default();
    for l in all.iter_mut() {
        l.active = l.id == active;
    }
    Ok(all)
}

// ── Player-follows-guild reconciler ─────────────────────────────────────────

fn cached_active_guild() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(guild_config::get_active().map(|c| c.guild_id)))
}

fn set_cached_active_guild(guild_id: &str) {
    *cached_active_guild().lock().unwrap() = Some(guild_id.to_string());
}

static LAST_SWITCH_AT: AtomicU64 = AtomicU64::new(0);
static LAST_BACKSTOP_AT: AtomicU64 = AtomicU64::new(0);
static CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Called from the ~10s game-state sync tick. Cheap fast path: no disk I/O.
/// Spawns an async LCD verification when the webapp-synced guild differs
/// from the active infra, or on a slow backstop cadence (the webapp on old
/// infra can miss its own player's migration — grass subjects are keyed by
/// the player's NEW guild id).
pub fn note_player_guild(
    app: tauri::AppHandle,
    synced_guild_id: Option<String>,
    player_id: Option<String>,
) {
    let Some(player_id) = player_id.filter(|p| !p.is_empty()) else {
        return;
    };

    let active = cached_active_guild().lock().unwrap().clone();
    let Some(active) = active.filter(|a| !a.is_empty()) else {
        return;
    };

    let now = now_secs();
    let mismatch = synced_guild_id
        .as_deref()
        .map(|g| !g.is_empty() && g != active)
        .unwrap_or(false);
    let backstop_due = now.saturating_sub(LAST_BACKSTOP_AT.load(Ordering::Relaxed)) >= BACKSTOP_SECS;
    if !mismatch && !backstop_due {
        return;
    }
    // Reload-loop guard: never switch again within the cooldown window.
    if now.saturating_sub(LAST_SWITCH_AT.load(Ordering::Relaxed)) < SWITCH_COOLDOWN_SECS {
        return;
    }
    if CHECK_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    LAST_BACKSTOP_AT.store(now, Ordering::Relaxed);

    tauri::async_runtime::spawn(async move {
        let result = verify_and_switch(app, &player_id, &active).await;
        CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            eprintln!("[Guild Directory] reconcile: {}", e);
        }
    });
}

/// The guild the chain has this player in; empty for a guildless player.
async fn chain_guild_of(player_id: &str) -> Result<String, String> {
    let mut last_err = String::new();
    for base in lcd_bases() {
        let url = format!("{}/structs/player/{}", base, player_id);
        match fetch_capped(&url, "player record").await {
            Ok(body) => {
                let v: Value = serde_json::from_slice(&body)
                    .map_err(|e| format!("player record: invalid JSON ({})", e))?;
                let p = v.get("Player").or_else(|| v.get("player"));
                return match p {
                    Some(p) => Ok(p
                        .get("guildId")
                        .or_else(|| p.get("guild_id"))
                        .and_then(|g| g.as_str())
                        .unwrap_or_default()
                        .to_string()),
                    None => Err("player record: unexpected shape".into()),
                };
            }
            Err(e) => last_err = e,
        }
    }
    Err(format!("LCD player lookup failed: {}", last_err))
}

/// Authoritative check: the chain LCD player record. Only switch when the
/// chain confirms the player's guild differs from the active infra.
async fn verify_and_switch(
    app: tauri::AppHandle,
    player_id: &str,
    active_guild: &str,
) -> Result<(), String> {
    let lcd_guild = chain_guild_of(player_id).await?;
    if lcd_guild.is_empty() || lcd_guild == active_guild {
        return Ok(()); // chain agrees with active infra (or player guildless)
    }
    follow(&app, player_id, &lcd_guild, true).await
}

/// The player is in `guild` now: take everything that talks to a guild there.
/// `wait` holds the switch until the new guild's server has indexed the move —
/// until then it refuses the sign-in the reload makes, and the old server no
/// longer lists the address under the old guild either.
async fn follow(app: &tauri::AppHandle, player_id: &str, guild: &str, wait: bool) -> Result<(), String> {
    if !is_guild_id(guild) {
        return Err(format!("'{guild}' is not a guild id"));
    }
    let old = cached_active_guild().lock().unwrap().clone().unwrap_or_default();
    eprintln!("[Guild Directory] player {player_id} belongs to guild {guild} but active infra is {old} — switching");
    let cfg = ensure_config(guild).await?;
    if wait {
        wait_for_member(&cfg, player_id).await;
    }
    // Two paths can have seen the same move while this one waited.
    if cached_active_guild().lock().unwrap().as_deref() == Some(guild) {
        return Ok(());
    }
    LAST_SWITCH_AT.store(now_secs(), Ordering::Relaxed);
    switch_to(app, guild).await?;
    settle_player_guild(app, &old, guild);
    Ok(())
}

/// What follows the player rather than the server: their guild in the synced
/// state, their Guild API session, and the Comms identity they speak as.
fn settle_player_guild(app: &tauri::AppHandle, old: &str, guild: &str) {
    if let Ok(mut gs) = crate::game_state::GAME_STATE.write() {
        gs.guild_id = Some(guild.to_string());
    }
    crate::matrix::guild_changed(app, old, guild);
    tauri::async_runtime::spawn(async move {
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        crate::mcp::guild_auth::recover(&client.guild).await;
    });
}

/// Wait for a guild server to list the player's address as its member, as its
/// sign-in will ask. Gives up after a minute: a server that cannot say so is
/// no reason to stay on one the player has left.
async fn wait_for_member(cfg: &GuildConfig, player_id: &str) {
    let address = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.wallet_address.clone()).unwrap_or_default();
    if address.is_empty() {
        return;
    }
    let url = format!(
        "{}/auth/player-address/{}/guild/{}/player-id",
        cfg.guild_api.trim_end_matches('/'),
        address,
        cfg.guild_id
    );
    for _ in 0..30 {
        if let Ok(body) = fetch_capped(&url, "membership").await {
            if names_member(&body, player_id) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    eprintln!("[Guild Directory] {} does not list {} yet", cfg.guild_api, player_id);
}

fn names_member(body: &[u8], player_id: &str) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/data/player_id").and_then(|p| p.as_str()).map(|p| p == player_id))
        .unwrap_or(false)
}

static FOLLOWING: AtomicBool = AtomicBool::new(false);

/// The player's guild is changing, or just did: a join was signed, or a frame
/// said so. Follow it as soon as the chain shows it rather than on the minute
/// backstop. Asks for up to two minutes; harmless when nothing moved.
pub fn player_guild_moving(app: &tauri::AppHandle) {
    let Some(player_id) = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone()).filter(|p| !p.is_empty()) else {
        return;
    };
    if FOLLOWING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..40 {
            let active = cached_active_guild().lock().unwrap().clone().unwrap_or_default();
            match chain_guild_of(&player_id).await {
                Ok(g) if !g.is_empty() && g != active => {
                    if let Err(e) = follow(&app, &player_id, &g, true).await {
                        eprintln!("[Guild Directory] follow: {e}");
                    }
                    break;
                }
                Ok(_) => {}
                Err(e) => eprintln!("[Guild Directory] follow: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        FOLLOWING.store(false, Ordering::SeqCst);
    });
}

/// A `player_consensus` frame: the whole player row, guild included.
pub fn on_player_frame(app: &tauri::AppHandle, detail: &Value) {
    let Some(id) = detail.get("id").and_then(|v| v.as_str()) else { return };
    let mine = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone());
    let active = cached_active_guild().lock().unwrap().clone().unwrap_or_default();
    if mine.as_deref() == Some(id) && frame_moves_guild(detail, &active) {
        player_guild_moving(app);
    }
}

fn frame_moves_guild(detail: &Value, active: &str) -> bool {
    detail
        .get("guild_id")
        .and_then(|g| g.as_str())
        .is_some_and(|g| is_guild_id(g) && g != active)
}

/// At load, for the account saved on this machine: the guild the chain has the
/// player in, and that guild's current server, against what the game window is
/// about to sign in with. A stale guild or a moved server is corrected before
/// the sign-in it would break. Answers `current`, `switching` (the window is
/// reloading) or `guildless`.
#[tauri::command]
pub async fn follow_saved_player(
    window: tauri::WebviewWindow,
    player_id: String,
    running: Option<guild_config::FrontendConfig>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("only the game window signs the player in".into());
    }
    crate::mcp::types::PlayerId::parse(&player_id).map_err(|e| e.to_string())?;
    let app = window.app_handle().clone();
    let guild = chain_guild_of(&player_id).await?;
    if guild.is_empty() {
        return Ok("guildless".into());
    }
    if !is_guild_id(&guild) {
        return Err(format!("'{guild}' is not a guild id"));
    }
    let want = guild_config::FrontendConfig::from(&ensure_config(&guild).await?);
    let old = guild_config::get_active().map(|c| c.guild_id).unwrap_or_default();
    if running.as_ref().is_some_and(|r| same_connection(r, &want)) {
        // The window is right; a saved setting that disagrees is put right
        // without disturbing it.
        if old != guild {
            guild_config::set_active_guild(guild.clone())?;
            set_cached_active_guild(&guild);
            crate::mcp::guild_auth::forget();
            settle_player_guild(&app, &old, &guild);
        }
        return Ok("current".into());
    }
    // The same correction twice in a row means the window did not take it;
    // reloading again would not help.
    static LAST: Mutex<Option<(u64, String)>> = Mutex::new(None);
    let key = serde_json::to_string(&want).map_err(|e| e.to_string())?;
    {
        let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
        if last.as_ref().is_some_and(|(at, k)| *k == key && now_secs().saturating_sub(*at) < SWITCH_COOLDOWN_SECS) {
            return Err("already corrected once; not reloading again".into());
        }
        *last = Some((now_secs(), key));
    }
    LAST_SWITCH_AT.store(now_secs(), Ordering::Relaxed);
    switch_to(&app, &guild).await?;
    settle_player_guild(&app, &old, &guild);
    Ok("switching".into())
}

fn same_connection(a: &guild_config::FrontendConfig, b: &guild_config::FrontendConfig) -> bool {
    a.guild_id == b.guild_id
        && a.guild_api == b.guild_api
        && a.reactor_api == b.reactor_api
        && a.client_ws == b.client_ws
        && a.grass_nats_ws == b.grass_nats_ws
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(id: &str) -> ChainGuild {
        ChainGuild {
            id: id.into(),
            endpoint: "https://example.com/guild.json".into(),
            name: String::new(),
        }
    }

    fn doc_json(id: &str, guild_api: &str, grass: &str) -> Vec<u8> {
        format!(
            r#"{{"guild":{{"id":"{id}","name":"Test","tag":"TG","services":{{
                "guild_api":"{guild_api}",
                "reactor_api":"https://public.testnet.structs.network/",
                "client_websocket":"wss://public.testnet.structs.network:26657/websocket",
                "grass_nats_websocket":"{grass}"}}}}}}"#
        )
        .into_bytes()
    }

    /// Kilgore Crabla (0-4) publishes an API but no GRASS endpoint: refused as
    /// game infra, still listed for API reads. Imperial One (0-2) publishes
    /// camelCase `guildApi: ""`, i.e. none.
    #[test]
    fn the_api_directory_keeps_guilds_the_infra_check_refuses() {
        let crab = guild_api_entry(&chain("0-4"), Ok(doc_json("0-4", "https://shell.crab.la/api/", "")));
        assert!(validate_guild_doc(&chain("0-4"), &doc_json("0-4", "https://shell.crab.la/api/", "")).is_err());
        assert_eq!(crab.guild_api.as_deref(), Some("https://shell.crab.la/api"));
        assert_eq!(crab.error, None);
        let one = guild_api_entry(&chain("0-2"), Ok(br#"{"guild":{"id":"0-2","name":"Imperial One","tag":"ONE","services":{"guildApi":"","reactorApi":""}}}"#.to_vec()));
        assert_eq!(one.guild_api, None);
        assert_eq!(one.name, "Imperial One");
        assert!(one.error.unwrap().contains("no guild API"));
        let liar = guild_api_entry(&chain("0-3"), Ok(doc_json("0-9", "https://x.example/api", "wss://x.example")));
        assert_eq!(liar.guild_api, None, "a document claiming another id is not trusted");
        let down = guild_api_entry(&chain("0-6"), Err("endpoint doc: HTTP 502".into()));
        assert_eq!(down.error.as_deref(), Some("endpoint doc: HTTP 502"));
    }

    /// Rekt Gang's live guild.json (2026-11-24): hosted by SN Corp's server,
    /// recruiting, with a logo on its own site.
    #[test]
    fn a_listing_carries_what_the_directory_shows() {
        let body = br#"{"guild":{"id":"0-8","name":"Rekt Gang","tag":"REKT","description":"Rekt Gang Structs Guild",
            "logo":"https://rekt.structs.zone/rekt/img/rekt-gang-logo.png","recruiting":{"status":"open"},
            "services":{"guild_api":"https://beta.playstructs.com/api/","grass_nats_websocket":"wss://beta.playstructs.com:1443"}}}"#;
        let cfg = validate_guild_doc(&chain("0-8"), body).unwrap();
        let l = listing_of(&cfg, body);
        assert_eq!((l.id.as_str(), l.tag.as_str(), l.recruiting), ("0-8", "REKT", true));
        assert_eq!(l.logo.as_deref(), Some("https://rekt.structs.zone/rekt/img/rekt-gang-logo.png"));
        assert_eq!(l.description, "Rekt Gang Structs Guild");
        for bad in ["javascript:alert(1)", "http://x.example/l.png", "/img/l.png", "https://127.0.0.1/l.png", ""] {
            let body = format!(r#"{{"guild":{{"id":"0-8","logo":"{bad}","services":{{}}}}}}"#);
            assert_eq!(listing_of(&cfg, body.as_bytes()).logo, None, "{bad}");
        }
    }

    #[test]
    fn listings_are_largest_first_and_uncounted_last() {
        let l = |id: &str, members| GuildListing {
            id: id.into(), name: String::new(), tag: String::new(), logo: None,
            description: String::new(), members, recruiting: false, active: false,
        };
        let mut all = vec![l("0-10", None), l("0-9", Some(6)), l("0-5", Some(9463)), l("0-11", Some(6)), l("0-1", Some(5067))];
        sort_listings(&mut all);
        let ids: Vec<&str> = all.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["0-5", "0-1", "0-9", "0-11", "0-10"]);
        let m = parse_members(&serde_json::json!({"success":true,"data":[{"guild_id":"0-5","members":9463},{"guild_id":"0-1","members":"5067"},{"guild_id":"0-2"}]}));
        assert_eq!((m.get("0-5"), m.get("0-1"), m.get("0-2")), (Some(&9463), Some(&5067), None));
    }

    /// A member of a guild with no server keeps playing on the one they are
    /// on, under the guild they are in, and it is not offered to anyone else.
    #[test]
    fn a_guild_without_a_server_is_hosted_under_its_own_id() {
        let host = validate_guild_doc(&chain("0-5"), &doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443")).unwrap();
        let mut host = host;
        host.is_active = true;
        host.matrix_url = Some("https://matrix.beta.playstructs.com".into());
        let c = hosted_by(&ChainGuild { id: "0-6".into(), endpoint: String::new(), name: "ANODE TEAM".into() }, &host);
        assert_eq!((c.guild_id.as_str(), c.name.as_str()), ("0-6", "ANODE TEAM"));
        assert_eq!(c.guild_api, host.guild_api);
        assert!(!c.is_active && c.endpoint.is_none() && c.matrix_url.is_none());
    }

    /// Same server, different guild is a different connection: 11 guilds share
    /// beta.playstructs.com and each signs in under its own id.
    #[test]
    fn a_shared_server_does_not_make_two_guilds_one_connection() {
        let fc = |id: &str| {
            guild_config::FrontendConfig::from(
                &validate_guild_doc(&chain(id), &doc_json(id, "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443")).unwrap(),
            )
        };
        assert!(same_connection(&fc("0-5"), &fc("0-5")));
        assert!(!same_connection(&fc("0-5"), &fc("0-8")));
        let mut moved = fc("0-5");
        moved.guild_api = "https://new.playstructs.com/api".into();
        assert!(!same_connection(&moved, &fc("0-5")));
        // What the window hands back is what it was given.
        let back: guild_config::FrontendConfig = serde_json::from_str(&serde_json::to_string(&fc("0-8")).unwrap()).unwrap();
        assert!(same_connection(&back, &fc("0-8")));
    }

    #[test]
    fn a_frame_moves_the_player_only_to_another_real_guild() {
        let f = |g: Value| frame_moves_guild(&serde_json::json!({"id": "1-194", "guild_id": g}), "0-1");
        assert!(f("0-8".into()));
        assert!(!f("0-1".into()));
        assert!(!f("".into()) && !f(Value::Null));
        // 0-1 is a prefix of 0-11: a different guild all the same.
        assert!(f("0-11".into()));
        assert!(is_guild_id("0-17") && !is_guild_id("0-") && !is_guild_id("1-17") && !is_guild_id("0-1/../2"));
    }

    /// Live: the directory, and a player of a hosted guild, as the load check
    /// reads them. Writes guild_configs.json under HOME — point that elsewhere.
    /// `HOME=/tmp/x <test binary> --ignored live_directory`
    #[tokio::test]
    #[ignore]
    async fn live_directory_and_hosted_member() {
        let all = guild_listings().await.unwrap();
        for g in &all {
            eprintln!("{} [{}] {} members={:?} open={} logo={:?}", g.id, g.tag, g.name, g.members, g.recruiting, g.logo);
        }
        assert!(all.len() > 5 && all.iter().any(|g| g.id == "0-5" && g.active && g.members.unwrap_or(0) > 1000));
        assert_eq!(chain_guild_of("1-579").await.unwrap(), "0-10");
        let cfg = ensure_config("0-10").await.unwrap();
        let url = format!("{}/auth/player-address/structs1qrr9an8jevuy4d5vs2djtvsvp623ccqxyu0au9/guild/0-10/player-id", cfg.guild_api);
        assert!(names_member(&fetch_capped(&url, "membership").await.unwrap(), "1-579"));
        // ANODE TEAM publishes nothing: hosted, not offered.
        let anode = ensure_config("0-6").await.unwrap();
        assert_eq!((anode.guild_id.as_str(), anode.endpoint), ("0-6", None));
        assert!(!guild_listings().await.unwrap().iter().any(|g| g.id == "0-6"));
    }

    #[test]
    fn membership_is_the_server_naming_this_player() {
        assert!(names_member(br#"{"success":true,"errors":[],"data":{"player_id":"1-579"}}"#, "1-579"));
        assert!(!names_member(br#"{"success":true,"errors":[],"data":{"player_id":"1-57"}}"#, "1-579"));
        assert!(!names_member(br#"{"success":true,"errors":[],"data":null}"#, "1-579"));
    }

    /// Verbatim `services` block from https://beta.playstructs.com/guild.json
    /// (2026-08-28), so this asserts the shape guilds ACTUALLY publish rather
    /// than one invented here.
    #[test]
    fn matrix_service_is_picked_up_from_a_live_guild_json() {
        let body = br#"{"guild":{"id":"0-5","name":"SN Corp","tag":"SN.C",
            "denom":{"6":"snack","0":"ack"},
            "services":{
              "guild_api":"https://beta.playstructs.com/api/",
              "reactor_api":"https://public.testnet.structs.network/",
              "client_websocket":"wss://public.testnet.structs.network:26657/websocket",
              "grass_nats_websocket":"wss://beta.playstructs.com:1443",
              "matrix":"https://matrix.beta.playstructs.com",
              "explorer":""}}}"#;
        let cfg = validate_guild_doc(&chain("0-5"), body).unwrap();
        assert_eq!(
            cfg.matrix_url.as_deref(),
            Some("https://matrix.beta.playstructs.com")
        );
    }

    /// Most guilds publish no `matrix` key at all (crab.la's live document is
    /// exactly this). That is a normal guild, not a broken one.
    #[test]
    fn a_guild_without_matrix_still_validates() {
        let body = doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443");
        let cfg = validate_guild_doc(&chain("0-5"), &body).unwrap();
        assert!(cfg.matrix_url.is_none());
    }

    /// Chat is optional; the directory entry is not. A guild that declares an
    /// unusable homeserver must lose only its chat.
    #[test]
    fn a_bad_matrix_url_costs_chat_not_the_whole_guild() {
        for bad in [
            r#""http://127.0.0.1:8008""#,   // loopback would alias the IPC origin
            r#""ws://matrix.example""#,     // wrong scheme for a client base URL
            r#""not a url""#,
        ] {
            let body = format!(
                r#"{{"guild":{{"id":"0-5","name":"T","tag":"T","services":{{
                    "guild_api":"https://beta.playstructs.com/api/",
                    "grass_nats_websocket":"wss://beta.playstructs.com:1443",
                    "matrix":{bad}}}}}}}"#
            )
            .into_bytes();
            let cfg = validate_guild_doc(&chain("0-5"), &body)
                .unwrap_or_else(|e| panic!("{} sank the whole entry: {}", bad, e));
            assert!(cfg.matrix_url.is_none(), "{} was accepted", bad);
        }
    }

    /// A guild retiring its homeserver must not leave Comms pointed at a
    /// server that is no longer there.
    #[test]
    fn dropping_matrix_from_guild_json_clears_the_stored_url() {
        let mut existing = vec![validate_guild_doc(
            &chain("0-5"),
            br#"{"guild":{"id":"0-5","name":"T","tag":"T","services":{
                "guild_api":"https://beta.playstructs.com/api/",
                "grass_nats_websocket":"wss://beta.playstructs.com:1443",
                "matrix":"https://matrix.beta.playstructs.com"}}}"#,
        )
        .unwrap()];
        assert!(existing[0].matrix_url.is_some());

        let without = validate_guild_doc(
            &chain("0-5"),
            &doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443"),
        )
        .unwrap();
        upsert_discovered(&mut existing, vec![without]);
        assert!(existing[0].matrix_url.is_none());
    }

    /// The `denom` block is guild-authored text rendered next to real
    /// balances, so it is parsed with the same sanitising as name/tag —
    /// non-numeric exponents and empty labels are dropped, not shown.
    #[test]
    fn denom_block_is_parsed_and_sanitised() {
        let body = format!(
            r#"{{"guild":{{"id":"0-5","name":"Test","tag":"TG",
                "denom":{{"0":"ack","6":"snack","x":"junk","9":"  "}},
                "services":{{
                "guild_api":"https://beta.playstructs.com/api/",
                "grass_nats_websocket":"wss://beta.playstructs.com:1443"}}}}}}"#
        )
        .into_bytes();
        let cfg = validate_guild_doc(&chain("0-5"), &body).unwrap();
        assert_eq!(cfg.denoms.get(&0).map(String::as_str), Some("ack"));
        assert_eq!(cfg.denoms.get(&6).map(String::as_str), Some("snack"));
        assert_eq!(cfg.denoms.len(), 2, "non-numeric and blank entries dropped");
    }

    /// A guild without a denom block must still validate — most do not
    /// publish one, and losing the guild over a cosmetic field would be absurd.
    #[test]
    fn missing_denom_block_is_not_an_error() {
        let body = doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443");
        let cfg = validate_guild_doc(&chain("0-5"), &body).unwrap();
        assert!(cfg.denoms.is_empty());
    }

    #[test]
    fn valid_doc_passes() {
        let body = doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443");
        let cfg = validate_guild_doc(&chain("0-5"), &body).unwrap();
        assert_eq!(cfg.guild_id, "0-5");
        assert_eq!(cfg.source, ConfigSource::Chain);
        // Per-guild services adopted; guild_api trailing slash stripped.
        assert_eq!(cfg.guild_api, "https://beta.playstructs.com/api");
        assert_eq!(cfg.grass_nats_ws, "wss://beta.playstructs.com:1443");
    }

    #[test]
    fn shared_endpoints_pinned_ignoring_declared() {
        // doc_json declares reactor_api "https://.../" and client_websocket
        // ".../websocket" — both must be ignored in favor of the public pins,
        // no matter what the guild self-declares (incl. a dead OH-style node).
        let body = doc_json("0-1", "http://crew.oh.energy/api/", "ws://crew.oh.energy:1443");
        let cfg = validate_guild_doc(&chain("0-1"), &body).unwrap();
        assert_eq!(cfg.reactor_api, guild_config::PUBLIC_REACTOR_API);
        assert_eq!(cfg.client_ws, guild_config::PUBLIC_CLIENT_WS);
        // No stray /websocket suffix that would double-append in CosmJS.
        assert!(!cfg.client_ws.ends_with("/websocket"));
    }

    #[test]
    fn id_mismatch_rejected() {
        // A guild's endpoint doc claiming to be a different guild is impersonation.
        let body = doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443");
        assert!(validate_guild_doc(&chain("0-9"), &body).is_err());
    }

    #[test]
    fn bad_schemes_and_local_hosts_rejected() {
        for bad in [
            doc_json("0-5", "javascript:alert(1)", "wss://x.example:1443"),
            doc_json("0-5", "file:///etc/passwd", "wss://x.example:1443"),
            doc_json("0-5", "https://localhost/api", "wss://x.example:1443"),
            doc_json("0-5", "https://ipc.localhost/api", "wss://x.example:1443"),
            doc_json("0-5", "https://127.0.0.1/api", "wss://x.example:1443"),
            // websocket field must be ws/wss, not http
            doc_json("0-5", "https://x.example/api", "https://x.example:1443"),
        ] {
            assert!(validate_guild_doc(&chain("0-5"), &bad).is_err());
        }
    }

    #[test]
    fn plain_http_allowed_for_guilds_that_publish_it() {
        // OH publishes http/ws intentionally — must not be rejected.
        let body = doc_json("0-1", "http://crew.oh.energy/api/", "ws://crew.oh.energy:1443");
        assert!(validate_guild_doc(&chain("0-1"), &body).is_ok());
    }

    #[test]
    fn downgrade_guard_same_host_only() {
        assert!(is_downgrade("https://a.example/api", "http://a.example/api"));
        assert!(is_downgrade("wss://a.example:1443", "ws://a.example:1443"));
        // Different host = a real infra change, not a downgrade.
        assert!(!is_downgrade("https://a.example/api", "http://b.example/api"));
        assert!(!is_downgrade("http://a.example/api", "https://a.example/api"));
    }

    #[test]
    fn upsert_respects_user_entries_and_never_touches_active() {
        let mut existing = vec![GuildConfig {
            guild_id: "0-5".into(),
            name: "SN Corp".into(),
            guild_tag: "SN".into(),
            guild_api: "https://my-override.example/api".into(),
            reactor_api: "https://my-override.example/".into(),
            client_ws: "wss://my-override.example:26657".into(),
            grass_nats_ws: "wss://my-override.example:1443".into(),
            is_active: true,
            endpoint: None,
            source: ConfigSource::User,
            last_refreshed: None,
            denoms: Default::default(),
            matrix_url: None,
        }];
        let body = doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443");
        let found = validate_guild_doc(&chain("0-5"), &body).unwrap();
        upsert_discovered(&mut existing, vec![found]);
        assert_eq!(existing[0].guild_api, "https://my-override.example/api");
        assert!(existing[0].is_active);

        // Seed entries DO get updated by discovery.
        existing[0].source = ConfigSource::Seed;
        let body = doc_json("0-5", "https://beta.playstructs.com/api/", "wss://beta.playstructs.com:1443");
        let found = validate_guild_doc(&chain("0-5"), &body).unwrap();
        upsert_discovered(&mut existing, vec![found]);
        assert_eq!(existing[0].guild_api, "https://beta.playstructs.com/api");
        assert!(existing[0].is_active, "discovery never flips is_active");
    }
}

/// Non-blocking startup refresh. The persisted config is authoritative at
/// boot, so this only updates the persisted file + Rust clients (refresh_directory
/// already calls reload_all on change). It deliberately does NOT reload the
/// webview: the baked config is already correct at boot, and reloading mid-init
/// aborts in-flight connection promises. A guild that changed its guild_api /
/// grass URL on-chain takes effect on the next natural launch; a player who
/// switched guilds is handled live by the player-follows-guild reconciler
/// (note_player_guild), which is the only case that warrants a reload.
pub fn startup_refresh(_app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        match refresh_directory().await {
            Ok(report) => {
                eprintln!(
                    "[Guild Directory] startup refresh: {} guilds discovered, {} skipped{}",
                    report.discovered,
                    report.skipped.len(),
                    if report.active_changed {
                        " (active guild URLs refreshed; effective next launch)"
                    } else {
                        ""
                    }
                );
            }
            Err(e) => eprintln!("[Guild Directory] startup refresh failed: {}", e),
        }
    });
}
