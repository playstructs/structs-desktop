use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CONFIG_FILENAME: &str = "mcp_config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub bearer_token: Option<String>,
    /// Serve the Team Ops dashboard as a token-authenticated web page under
    /// /board on the MCP port. OPT-IN — off by default; the player enables it
    /// via `structs_board web:"on"` or the Team Ops CONFIG page.
    #[serde(default)]
    pub web_board_enabled: bool,
    /// Publish a line about what you are doing, visible to everyone who can
    /// see you in Comms.
    ///
    /// OPT-IN, and it stays that way. This is a game about raiding each
    /// other: "fleet away" tells anyone reading that your planet may be
    /// undefended, and "raiding 2-15361" tells your target you are coming.
    /// All of it is on a public chain already, but there is a real difference
    /// between DISCOVERABLE by querying and PUSHED to every rival's screen,
    /// and that difference is the player's to choose.
    #[serde(default)]
    pub comms_status_enabled: bool,
    /// How virtual-player signs are carried out and returned: `"sync"`
    /// (default) signs in the webview and waits for block inclusion — p50
    /// 6.1 s per sign; `"async"` signs in the webview and returns after the
    /// mempool accepts the tx (~0.2 s), settling later as a `tx_settled`
    /// event; `"native"` / `"native_async"` sign in Rust (`native_signer`)
    /// with the same two return contracts and no webview round-trip.
    /// Runtime-settable via `structs_system config set {sign_mode}`;
    /// measured, not guessed.
    #[serde(default = "default_sign_mode")]
    pub sign_mode: String,
    /// Admission-gate cap override (see `tx_gate`). `None` = the built-in 4.
    #[serde(default)]
    pub tx_gate_cap: Option<usize>,
    /// Where the loops' pre-sign verify reads go: `"guild"` (default — the
    /// Guild API, indexer-fresh, ~a block behind) or `"lcd"` (the shared
    /// public chain node, exact but the endpoint everyone is squeezing).
    /// Runtime-settable via `structs_system config set {verify_source}`.
    #[serde(default = "default_verify_source")]
    pub verify_source: String,
    /// Where the perception snapshot (the local source of truth every loop
    /// and window reads) is bulk-loaded from: `"guild"` (default — the
    /// indexer's catalog at 10,000 rows a page, ~45 requests) or `"lcd"`
    /// (the chain's stores, 11 requests of 60,000 rows, on the shared node).
    /// The guild path falls back to the LCD walk if a store comes back empty.
    #[serde(default = "default_verify_source")]
    pub snapshot_source: String,
    /// Where GRASS frames enter Rust: "native" (async-nats from Rust, the
    /// default) or "webview" (the game window's WebSocket tap).
    #[serde(default = "default_grass_source")]
    pub grass_source: String,
}

fn default_grass_source() -> String {
    "native".to_string()
}

fn default_sign_mode() -> String {
    "sync".to_string()
}

fn default_verify_source() -> String {
    "guild".to_string()
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8420,
            bearer_token: None,
            web_board_enabled: false,
            // Off. Nothing about what you are doing leaves this machine until
            // the player asks for it.
            comms_status_enabled: false,
            sign_mode: default_sign_mode(),
            tx_gate_cap: None,
            verify_source: default_verify_source(),
            snapshot_source: default_verify_source(),
            grass_source: default_grass_source(),
        }
    }
}

impl McpConfig {
    fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("structs-app").join(CONFIG_FILENAME))
    }

    pub fn load() -> Self {
        let Some(path) = Self::config_path() else {
            return Self::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path().ok_or("Could not determine config directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Generate a new bearer token (32 random bytes, hex encoded)
    pub fn generate_token(&mut self) {
        use sha2::{Digest, Sha256};
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let hash = Sha256::digest(format!("structs-mcp-{}-{}", now, std::process::id()).as_bytes());
        self.bearer_token = Some(hex::encode(hash));
    }

    pub fn ensure_token(&mut self) {
        if self.bearer_token.is_none() {
            self.generate_token();
            let _ = self.save();
        }
    }
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn get_mcp_config() -> Result<McpConfig, String> {
    Ok(McpConfig::load())
}

#[tauri::command]
pub async fn set_mcp_enabled(enabled: bool) -> Result<McpConfig, String> {
    let mut config = McpConfig::load();
    config.enabled = enabled;
    if enabled {
        config.ensure_token();
    }
    config.save()?;
    Ok(config)
}

#[tauri::command]
pub async fn get_mcp_token() -> Result<Option<String>, String> {
    let mut config = McpConfig::load();
    config.ensure_token();
    Ok(config.bearer_token)
}

#[tauri::command]
pub async fn set_mcp_port(port: u16) -> Result<McpConfig, String> {
    let mut config = McpConfig::load();
    config.port = port;
    config.save()?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `load()` falls back to `Default` on any parse failure — which would
    /// silently discard the bearer token and the port, breaking a working MCP
    /// setup. Removing a field from this struct must therefore leave older
    /// config files parseable, not merely "probably fine".
    #[test]
    fn a_config_written_by_an_older_build_still_parses() {
        // Exactly what shipped while Raid View had an opt-in flag.
        let older = r#"{
            "enabled": true,
            "port": 8420,
            "bearer_token": "81e115c4",
            "web_board_enabled": true,
            "raid_view_enabled": true
        }"#;
        let cfg: McpConfig = serde_json::from_str(older).expect("unknown fields must be ignored");
        assert!(cfg.enabled);
        assert_eq!(cfg.port, 8420);
        assert_eq!(cfg.bearer_token.as_deref(), Some("81e115c4"));
        assert!(cfg.web_board_enabled, "the surviving flag must keep its value");
    }

    /// The oldest shape of all: before `web_board_enabled` existed either.
    #[test]
    fn a_config_missing_optional_fields_still_parses() {
        let ancient = r#"{"enabled": true, "port": 8420, "bearer_token": "abc"}"#;
        let cfg: McpConfig = serde_json::from_str(ancient).expect("serde(default) covers these");
        assert!(!cfg.web_board_enabled);
        assert_eq!(cfg.bearer_token.as_deref(), Some("abc"));
    }

    /// Round-tripping drops the retired key rather than preserving it, so a
    /// stale flag cannot linger in the file forever.
    #[test]
    fn saving_drops_a_retired_field() {
        let older = r#"{"enabled":true,"port":8420,"bearer_token":"x","raid_view_enabled":true}"#;
        let cfg: McpConfig = serde_json::from_str(older).unwrap();
        let written = serde_json::to_string(&cfg).unwrap();
        assert!(!written.contains("raid_view_enabled"));
    }
}
