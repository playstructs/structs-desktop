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
    /// Cosmetic denom names keyed by exponent, e.g. `{"0":"ack","6":"snack"}`.
    /// Fetched with the rest of the document and, until the Inventory work,
    /// thrown away — which is why guild tokens could only ever be shown by
    /// their raw `uguild.<id>` name.
    #[serde(default)]
    denom: std::collections::BTreeMap<String, String>,
    services: GuildServices,
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

    let mut configs = guild_config::load_configs();
    if upsert_discovered(&mut configs, found) {
        guild_config::save_configs(&configs).map_err(|e| e.to_string())?;
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

// ── Guild switch (persist + live handoff to the webview) ───────────────────

/// Switch the active guild and push the new config into the running webview.
/// The init-script config is frozen at app start, so the handoff goes through
/// sessionStorage (read synchronously at document-start on reload).
#[tauri::command]
pub async fn apply_guild_switch(app: tauri::AppHandle, guild_id: String) -> Result<(), String> {
    // Best-effort refresh of the target guild so a switch uses fresh URLs.
    match fetch_chain_guild(&guild_id).await {
        Ok(chain) => match fetch_and_validate_guild(&chain).await {
            Ok(cfg) => {
                let mut configs = guild_config::load_configs();
                if upsert_discovered(&mut configs, vec![cfg]) {
                    guild_config::save_configs(&configs).map_err(|e| e.to_string())?;
                }
            }
            Err(e) => eprintln!(
                "[Guild Directory] switch: refresh of {} failed ({}), using stored config",
                guild_id, e
            ),
        },
        Err(e) => eprintln!(
            "[Guild Directory] switch: chain record for {} unavailable ({}), using stored config",
            guild_id, e
        ),
    }

    // Persist active + reload Rust clients (set_active_guild calls reload_all).
    guild_config::set_active_guild(guild_id.clone())?;
    set_cached_active_guild(&guild_id);

    let active = guild_config::get_active()
        .ok_or_else(|| format!("guild '{}' not found after activation", guild_id))?;
    let fc = guild_config::FrontendConfig::from(&active);
    let json = serde_json::to_string(&fc).map_err(|e| e.to_string())?;

    eprintln!(
        "[Guild Directory] switching active guild -> {} ({}), reloading webview",
        active.name, active.guild_id
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

/// Authoritative check: the chain LCD player record. Only switch when the
/// chain confirms the player's guild differs from the active infra.
async fn verify_and_switch(
    app: tauri::AppHandle,
    player_id: &str,
    active_guild: &str,
) -> Result<(), String> {
    let mut lcd_guild: Option<String> = None;
    let mut last_err = String::new();
    for base in lcd_bases() {
        let url = format!("{}/structs/player/{}", base, player_id);
        match fetch_capped(&url, "player record").await {
            Ok(body) => {
                let v: Value = serde_json::from_slice(&body)
                    .map_err(|e| format!("player record: invalid JSON ({})", e))?;
                let g = v
                    .get("Player")
                    .or_else(|| v.get("player"))
                    .and_then(|p| p.get("guildId").or_else(|| p.get("guild_id")))
                    .and_then(|g| g.as_str())
                    .unwrap_or_default()
                    .to_string();
                lcd_guild = Some(g);
                break;
            }
            Err(e) => last_err = e,
        }
    }
    let Some(lcd_guild) = lcd_guild else {
        return Err(format!("LCD player lookup failed: {}", last_err));
    };
    if lcd_guild.is_empty() || lcd_guild == active_guild {
        return Ok(()); // chain agrees with active infra (or player guildless)
    }

    eprintln!(
        "[Guild Directory] player {} belongs to guild {} but active infra is {} — switching",
        player_id, lcd_guild, active_guild
    );
    LAST_SWITCH_AT.store(now_secs(), Ordering::Relaxed);
    apply_guild_switch(app, lcd_guild).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(id: &str) -> ChainGuild {
        ChainGuild {
            id: id.into(),
            endpoint: "https://example.com/guild.json".into(),
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
