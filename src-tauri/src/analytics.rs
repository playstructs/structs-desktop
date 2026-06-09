//! GA4 telemetry via the Measurement Protocol, sent from the native side.
//!
//! Why not just use gtag.js in the webview? The app runs under a custom
//! `tauri://localhost` origin, where gtag.js can't reliably persist its
//! `client_id` cookie and its `sendBeacon`/`fetch` transport is dropped or
//! reshaped by our global fetch proxy (see main.rs). So client-side hits never
//! land. Instead the frontend forwards every `gtag('event', …)` to the
//! `track_event` command here, and we POST it server-to-server to
//! `https://www.google-analytics.com/mp/collect` — which has none of those
//! webview constraints.
//!
//! Reuses the shared `reqwest::Client` from `http_proxy` and the same
//! `dirs::config_dir()/structs-app/` config convention as `mcp::config`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use crate::http_proxy::shared_client;

const MEASUREMENT_ID: &str = "G-C5QXN9TH5M";
const MP_COLLECT_URL: &str = "https://www.google-analytics.com/mp/collect";
const MP_DEBUG_URL: &str = "https://www.google-analytics.com/debug/mp/collect";
const CONFIG_FILENAME: &str = "analytics.json";
const APP_NAME: &str = "Structs Desktop";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Persisted analytics state. `client_id` is generated once and reused across
/// launches so GA4 attributes events to a stable pseudonymous user. `api_secret`
/// is optional here — it can also be supplied via the `STRUCTS_GA_API_SECRET`
/// env var, which takes precedence.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnalyticsConfig {
    #[serde(default)]
    pub api_secret: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

impl AnalyticsConfig {
    fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("structs-app").join(CONFIG_FILENAME))
    }

    fn load() -> Self {
        let Some(path) = Self::config_path() else {
            return Self::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    fn save(&self) -> Result<(), String> {
        let path = Self::config_path().ok_or("Could not determine config directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}

/// Stable per-install client id, generated once and persisted.
fn client_id() -> String {
    static CLIENT_ID: OnceLock<String> = OnceLock::new();
    CLIENT_ID
        .get_or_init(|| {
            let mut cfg = AnalyticsConfig::load();
            if let Some(id) = &cfg.client_id {
                if !id.is_empty() {
                    return id.clone();
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            cfg.client_id = Some(id.clone());
            if let Err(e) = cfg.save() {
                eprintln!("[analytics] failed to persist client_id: {e}");
            }
            id
        })
        .clone()
}

/// Per-launch session id. GA4 needs `session_id` (+ `engagement_time_msec`) on
/// each event for it to attribute to a session and appear in Realtime.
fn session_id() -> String {
    static SESSION_ID: OnceLock<String> = OnceLock::new();
    SESSION_ID
        .get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
        .clone()
}

/// API secret: env var wins, then the persisted config file. `None` disables
/// sending (the app keeps working; we just skip telemetry).
fn api_secret() -> Option<String> {
    if let Ok(s) = std::env::var("STRUCTS_GA_API_SECRET") {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    AnalyticsConfig::load()
        .api_secret
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn debug_enabled() -> bool {
    std::env::var("STRUCTS_GA_DEBUG")
        .map(|v| !v.trim().is_empty() && v != "0" && v.to_lowercase() != "false")
        .unwrap_or(false)
}

/// Build the MP request body for a single event.
fn build_payload(name: &str, params: HashMap<String, Value>) -> Value {
    // GA4 event names: <=40 chars, alphanumeric + underscore, start with a letter.
    let event_name: String = name.chars().take(40).collect();

    let mut p: Map<String, Value> = params.into_iter().collect();
    // Injected on every event so GA4 attributes it correctly.
    p.entry("app_name".to_string())
        .or_insert_with(|| json!(APP_NAME));
    p.entry("app_version".to_string())
        .or_insert_with(|| json!(APP_VERSION));
    p.insert("session_id".to_string(), json!(session_id()));
    p.entry("engagement_time_msec".to_string())
        .or_insert_with(|| json!("100"));

    json!({
        "client_id": client_id(),
        "events": [ { "name": event_name, "params": Value::Object(p) } ]
    })
}

/// POST a single event to GA4. No-op (with a one-time warning) when no API
/// secret is configured. Never returns an error that could disrupt the caller.
#[tauri::command]
pub async fn track_event(name: String, params: HashMap<String, Value>) -> Result<(), String> {
    static WARNED: AtomicBool = AtomicBool::new(false);

    let Some(secret) = api_secret() else {
        if !WARNED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "[analytics] no GA API secret set (STRUCTS_GA_API_SECRET or analytics.json) — \
                 telemetry disabled"
            );
        }
        return Ok(());
    };

    let payload = build_payload(&name, params);
    let url = if debug_enabled() { MP_DEBUG_URL } else { MP_COLLECT_URL };

    let resp = shared_client()
        .post(url)
        .query(&[("measurement_id", MEASUREMENT_ID), ("api_secret", secret.as_str())])
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if debug_enabled() {
        let body = resp.text().await.unwrap_or_default();
        eprintln!("[analytics] event '{name}' -> {status} {body}");
    } else if !status.is_success() {
        eprintln!("[analytics] event '{name}' -> {status}");
    }
    Ok(())
}

/// Send an event to GA4's validation endpoint and return its JSON response
/// (`validationMessages`), so the debug panel can confirm the payload is valid.
#[tauri::command]
pub async fn track_event_validate(
    name: String,
    params: HashMap<String, Value>,
) -> Result<String, String> {
    let Some(secret) = api_secret() else {
        return Err("No GA API secret configured (STRUCTS_GA_API_SECRET or analytics.json)".into());
    };
    let payload = build_payload(&name, params);
    let resp = shared_client()
        .post(MP_DEBUG_URL)
        .query(&[("measurement_id", MEASUREMENT_ID), ("api_secret", secret.as_str())])
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}

/// Write the API secret to the persisted config (alternative to the env var).
#[tauri::command]
pub fn set_ga_api_secret(secret: String) -> Result<(), String> {
    let mut cfg = AnalyticsConfig::load();
    let trimmed = secret.trim();
    cfg.api_secret = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    cfg.save()
}

/// Whether telemetry is currently deliverable (an API secret is configured).
/// Lets the debug panel show an accurate status.
#[tauri::command]
pub fn ga_status() -> bool {
    api_secret().is_some()
}
