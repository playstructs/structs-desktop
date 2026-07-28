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
    /// Raid View — the read-only spectator window and its galaxy-wide raid
    /// list. OPT-IN, off by default: while this is false the feature is not
    /// merely refused but *absent* — every entry point 404s and no trace of it
    /// renders in Team Ops, so a player who has not enabled it has no way to
    /// discover it exists. Enable via `structs_board raid_view:"on"` or the
    /// Team Ops System · Access page.
    #[serde(default)]
    pub raid_view_enabled: bool,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8420,
            bearer_token: None,
            web_board_enabled: false,
            raid_view_enabled: false,
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
