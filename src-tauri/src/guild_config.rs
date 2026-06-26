use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuildConfig {
    pub name: String,
    pub guild_tag: String,
    pub guild_api: String,
    pub reactor_api: String,
    pub client_ws: String,
    pub grass_nats_ws: String,
    pub is_active: bool,
}

/// The shape exposed to the frontend as window.__STRUCTS_CONFIG__
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendConfig {
    pub guild_api: String,
    pub reactor_api: String,
    pub client_ws: String,
    pub grass_nats_ws: String,
}

impl From<&GuildConfig> for FrontendConfig {
    fn from(gc: &GuildConfig) -> Self {
        FrontendConfig {
            guild_api: gc.guild_api.clone(),
            reactor_api: gc.reactor_api.clone(),
            client_ws: gc.client_ws.clone(),
            grass_nats_ws: gc.grass_nats_ws.clone(),
        }
    }
}

fn config_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("structs-app");
    fs::create_dir_all(&data_dir).ok();
    data_dir.join("guild_configs.json")
}

fn default_configs() -> Vec<GuildConfig> {
    vec![GuildConfig {
        name: "Orbital Hydro".into(),
        guild_tag: "OH".into(),
        guild_api: "http://crew.oh.energy/api".into(),
        // LCD/REST is served over standard HTTPS now; the old :1317 host is dead.
        reactor_api: "https://public.testnet.structs.network".into(),
        client_ws: "wss://public.testnet.structs.network:26657".into(),
        grass_nats_ws: "ws://crew.oh.energy:1443".into(),
        is_active: true,
    }]
}

/// Replace URLs that match a previous bad default with the current default.
/// Each field is checked independently so user customizations on one URL
/// aren't trampled when only the other was on a stale default.
fn migrate_stale_urls(configs: &mut [GuildConfig]) -> bool {
    const STALE_URLS: &[(&str, &str)] = &[
        (
            "ws://reactor.oh.energy:26657",
            "wss://public.testnet.structs.network:26657",
        ),
        (
            "http://reactor.oh.energy:1317",
            "https://public.testnet.structs.network",
        ),
        // The :1317 LCD host stopped responding; REST is now on standard HTTPS.
        // Existing installs persisted the old URL, so migrate it on next load.
        (
            "http://public.testnet.structs.network:1317",
            "https://public.testnet.structs.network",
        ),
    ];

    let mut changed = false;
    for c in configs.iter_mut() {
        for (old, new) in STALE_URLS {
            if c.client_ws == *old {
                c.client_ws = (*new).into();
                changed = true;
            }
            if c.reactor_api == *old {
                c.reactor_api = (*new).into();
                changed = true;
            }
        }
    }
    changed
}

pub fn load_configs() -> Vec<GuildConfig> {
    let path = config_path();
    if path.exists() {
        let mut configs = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<GuildConfig>>(&s).ok())
            .unwrap_or_else(default_configs);
        if migrate_stale_urls(&mut configs) {
            save_configs(&configs).ok();
        }
        configs
    } else {
        let configs = default_configs();
        save_configs(&configs).ok();
        configs
    }
}

pub fn save_configs(configs: &[GuildConfig]) -> Result<()> {
    let path = config_path();
    let json = serde_json::to_string_pretty(configs)?;
    fs::write(path, json)?;
    Ok(())
}

#[tauri::command]
pub fn get_active_guild_config() -> Option<FrontendConfig> {
    load_configs()
        .iter()
        .find(|c| c.is_active)
        .map(FrontendConfig::from)
}

#[tauri::command]
pub fn get_guild_configs() -> Vec<GuildConfig> {
    load_configs()
}

#[tauri::command]
pub fn set_guild_config(config: GuildConfig) -> Result<(), String> {
    let mut configs = load_configs();
    if let Some(existing) = configs.iter_mut().find(|c| c.name == config.name) {
        *existing = config;
    } else {
        configs.push(config);
    }
    save_configs(&configs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_active_guild(name: String) -> Result<(), String> {
    let mut configs = load_configs();
    for c in configs.iter_mut() {
        c.is_active = c.name == name;
    }
    save_configs(&configs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_guild_config(name: String) -> Result<(), String> {
    let mut configs = load_configs();
    configs.retain(|c| c.name != name);
    save_configs(&configs).map_err(|e| e.to_string())
}
