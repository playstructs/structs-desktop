use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// SN Corp — the default/onboarding guild for fresh installs.
pub const DEFAULT_GUILD_ID: &str = "0-5";

/// Shared chain endpoints. Every guild runs on the SAME testnet chain, so the
/// LCD (reactor_api) and RPC websocket (client_ws) are NOT per-guild — the
/// reliable public node serves all of them. Guilds' self-declared reactor/RPC
/// URLs are inconsistent and sometimes point at their own (private, insecure,
/// or intermittent) nodes, so discovery pins these two fields to the public
/// node rather than adopting guild-declared values. Only `guild_api` and
/// `grass_nats_ws` are genuinely per-guild. See guild_directory::normalize_shared.
pub const PUBLIC_REACTOR_API: &str = "https://public.testnet.structs.network";
pub const PUBLIC_CLIENT_WS: &str = "wss://public.testnet.structs.network:26657";

/// Where a config entry came from. Discovery (chain crawl) may overwrite URL
/// fields only when the entry is NOT user-managed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource {
    /// Shipped seed default (upgradable by discovery).
    #[default]
    Seed,
    /// Discovered from the guild's on-chain endpoint document.
    Chain,
    /// Manually created/edited by the user — discovery must not touch URLs.
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuildConfig {
    /// On-chain guild id, e.g. "0-5". Empty on legacy entries until backfilled.
    #[serde(default)]
    pub guild_id: String,
    pub name: String,
    pub guild_tag: String,
    pub guild_api: String,
    pub reactor_api: String,
    pub client_ws: String,
    pub grass_nats_ws: String,
    pub is_active: bool,
    /// The guild's on-chain endpoint URL (its guild.json definition).
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub source: ConfigSource,
    /// Unix seconds of the last successful discovery refresh for this entry.
    #[serde(default)]
    pub last_refreshed: Option<u64>,
    /// Cosmetic names the guild publishes for its own token, keyed by exponent
    /// — SN Corp's `{"0": "ack", "6": "snack"}` means the base unit of
    /// `uguild.0-5` is an *ack* and 10^6 of them is a *snack*, exactly
    /// mirroring ualpha→alpha. Fetched from guild.json since discovery
    /// existed; parsed and kept only since the Inventory work.
    #[serde(default)]
    pub denoms: std::collections::BTreeMap<u32, String>,
}

/// The shape exposed to the frontend as window.__STRUCTS_CONFIG__
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendConfig {
    pub guild_id: String,
    pub name: String,
    pub guild_tag: String,
    pub guild_api: String,
    pub reactor_api: String,
    pub client_ws: String,
    pub grass_nats_ws: String,
}

impl From<&GuildConfig> for FrontendConfig {
    fn from(gc: &GuildConfig) -> Self {
        FrontendConfig {
            guild_id: gc.guild_id.clone(),
            name: gc.name.clone(),
            guild_tag: gc.guild_tag.clone(),
            // Choke point for everything the webapp ever sees (init script AND
            // the guild-switch sessionStorage handoff): the webapp's client
            // appends "/setting" etc., so a trailing slash here becomes
            // "/api//setting" and 404s. Persisted configs are healed on load
            // too; this guards values that haven't round-tripped disk yet.
            guild_api: gc.guild_api.trim_end_matches('/').to_string(),
            reactor_api: gc.reactor_api.clone(),
            client_ws: gc.client_ws.clone(),
            grass_nats_ws: gc.grass_nats_ws.clone(),
        }
    }
}

/// Versioned on-disk envelope. v1 was a bare `Vec<GuildConfig>`; the version
/// field marks one-time migrations so they don't re-run on every load.
#[derive(Debug, Serialize, Deserialize)]
struct ConfigFile {
    version: u32,
    guilds: Vec<GuildConfig>,
}

const CONFIG_VERSION: u32 = 2;

fn config_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("structs-app");
    fs::create_dir_all(&data_dir).ok();
    data_dir.join("guild_configs.json")
}

/// Written by game_state.rs on first player sync — its existence means a
/// player has logged in on this install at least once.
fn player_has_logged_in() -> bool {
    dirs::config_dir()
        .map(|d| d.join("structs-app").join("last_player.txt").exists())
        .unwrap_or(false)
}

fn default_configs() -> Vec<GuildConfig> {
    vec![
        // Default/onboarding guild. reactor_api + client_ws are the shared testnet
        // chain (same for every guild); guild_api + grass_nats_ws are SN Corp's own.
        // Values seeded from https://beta.playstructs.com/guild.json; discovery
        // (guild_directory.rs) keeps them fresh from the chain.
        GuildConfig {
            guild_id: DEFAULT_GUILD_ID.into(),
            name: "SN Corp".into(),
            guild_tag: "SN".into(),
            guild_api: "https://beta.playstructs.com/api".into(),
            reactor_api: PUBLIC_REACTOR_API.into(),
            client_ws: PUBLIC_CLIENT_WS.into(),
            grass_nats_ws: "wss://beta.playstructs.com:1443".into(),
            is_active: true,
            endpoint: Some("https://beta.playstructs.com/guild.json".into()),
            source: ConfigSource::Seed,
            last_refreshed: None,
            // Left empty on purpose: discovery fills these from guild.json.
            denoms: Default::default(),
        },
        // Kept (inactive) so players on Orbital Hydro can switch back and still
        // reach their own guild_api — only the active guild's config is exposed.
        GuildConfig {
            guild_id: "0-1".into(),
            name: "Orbital Hydro".into(),
            guild_tag: "OH".into(),
            guild_api: "http://crew.oh.energy/api".into(),
            reactor_api: PUBLIC_REACTOR_API.into(),
            client_ws: PUBLIC_CLIENT_WS.into(),
            grass_nats_ws: "ws://crew.oh.energy:1443".into(),
            is_active: false,
            endpoint: None,
            source: ConfigSource::Seed,
            last_refreshed: None,
            // Left empty on purpose: discovery fills these from guild.json.
            denoms: Default::default(),
        },
    ]
}

/// One guild token, as the UI needs to talk about it.
///
/// Every guild mints `uguild.<guild_id>` and publishes its own cosmetic names
/// for it. Two guilds can independently pick the same word, so anything that
/// can show more than one guild's token at once (the ledger does exactly that)
/// must disambiguate with `tag`.
#[derive(Debug, Clone, Serialize)]
pub struct DenomInfo {
    /// The on-chain denom, e.g. `uguild.0-5` or `ualpha`.
    pub chain: String,
    /// Cosmetic name of the BASE unit (exponent 0), e.g. "ack".
    pub base_name: String,
    /// Cosmetic name of the DISPLAY unit, e.g. "snack".
    pub display_name: String,
    /// How many base units make one display unit (10^exponent).
    pub exponent: u32,
    pub guild_id: String,
    pub guild_name: String,
    pub guild_tag: String,
}

/// Every denom we can name, keyed by its on-chain denom string.
///
/// `ualpha` is chain-wide rather than guild-published, so it is seeded here
/// with the ladder the game itself uses (1 g Alpha = 1,000,000 ualpha).
pub fn denom_registry() -> std::collections::BTreeMap<String, DenomInfo> {
    let mut out = std::collections::BTreeMap::new();
    out.insert(
        "ualpha".to_string(),
        DenomInfo {
            chain: "ualpha".into(),
            base_name: "μg Alpha".into(),
            display_name: "Alpha".into(),
            exponent: 6,
            guild_id: String::new(),
            guild_name: "chain".into(),
            guild_tag: String::new(),
        },
    );
    for c in load_configs() {
        if c.guild_id.is_empty() || c.denoms.is_empty() {
            continue;
        }
        // Lowest exponent is the base unit, highest the display unit. A guild
        // that publishes only one name uses it for both.
        let base = c.denoms.iter().next().map(|(e, n)| (*e, n.clone()));
        let disp = c.denoms.iter().next_back().map(|(e, n)| (*e, n.clone()));
        let (base_exp, base_name) = match base {
            Some(v) => v,
            None => continue,
        };
        let (disp_exp, display_name) = disp.unwrap_or((base_exp, base_name.clone()));
        out.insert(
            format!("uguild.{}", c.guild_id),
            DenomInfo {
                chain: format!("uguild.{}", c.guild_id),
                base_name,
                display_name,
                exponent: disp_exp.saturating_sub(base_exp),
                guild_id: c.guild_id.clone(),
                guild_name: c.name.clone(),
                guild_tag: c.guild_tag.clone(),
            },
        );
    }
    out
}

/// Backfill guild ids on legacy entries by known infrastructure host.
/// Unknown hosts are treated as user-managed so discovery leaves them alone.
fn backfill_guild_id(c: &mut GuildConfig) {
    if !c.guild_id.is_empty() {
        return;
    }
    if c.guild_api.contains("beta.playstructs.com") {
        c.guild_id = DEFAULT_GUILD_ID.into();
    } else if c.guild_api.contains("crew.oh.energy") {
        c.guild_id = "0-1".into();
    } else {
        c.source = ConfigSource::User;
    }
}

/// One-time v1 → v2 migration:
/// 1. Backfill `guild_id` on legacy entries (known hosts).
/// 2. Seed-insert SN Corp if missing (existing installs never saw it).
/// 3. If the active guild is not SN Corp AND no player has ever logged in on
///    this install (`player_logged_in`), make SN Corp active — a
///    fresh-but-persisted install should onboard to the default guild.
///    Installs with sessions keep their active guild; the player-follows-guild
///    reconciler corrects it after login.
fn migrate_v1_to_v2(configs: &mut Vec<GuildConfig>, player_logged_in: bool) {
    for c in configs.iter_mut() {
        backfill_guild_id(c);
    }

    if !configs.iter().any(|c| c.guild_id == DEFAULT_GUILD_ID) {
        let mut sn = default_configs()
            .into_iter()
            .find(|c| c.guild_id == DEFAULT_GUILD_ID)
            .expect("defaults include SN Corp");
        sn.is_active = false;
        configs.push(sn);
    }

    let active_is_default = configs
        .iter()
        .any(|c| c.is_active && c.guild_id == DEFAULT_GUILD_ID);
    if !active_is_default && !player_logged_in {
        for c in configs.iter_mut() {
            c.is_active = c.guild_id == DEFAULT_GUILD_ID;
        }
    }
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
        // A trailing slash on guild_api produces `/api//setting`-style URLs in
        // the webapp (its client does `apiUrl + '/setting'`), which the server
        // 404s. The original SN Corp seed shipped with one and it persisted to
        // disk on existing installs; discovery already trims
        // (guild_directory.rs), so this heals the remaining sources — seeds,
        // legacy persists, hand-edited configs.
        let trimmed = c.guild_api.trim_end_matches('/');
        if trimmed.len() != c.guild_api.len() {
            c.guild_api = trimmed.to_string();
            changed = true;
        }
    }
    changed
}

pub fn load_configs() -> Vec<GuildConfig> {
    let path = config_path();
    if !path.exists() {
        let configs = default_configs();
        save_configs(&configs).ok();
        return configs;
    }

    let raw = fs::read_to_string(&path).ok();

    // v2 envelope first, then legacy bare array.
    if let Some(file) = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<ConfigFile>(s).ok())
    {
        let mut configs = file.guilds;
        if migrate_stale_urls(&mut configs) {
            save_configs(&configs).ok();
        }
        return configs;
    }

    let mut configs = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<GuildConfig>>(s).ok())
        .unwrap_or_else(default_configs);
    migrate_v1_to_v2(&mut configs, player_has_logged_in());
    migrate_stale_urls(&mut configs);
    save_configs(&configs).ok();
    configs
}

pub fn save_configs(configs: &[GuildConfig]) -> Result<()> {
    let path = config_path();
    let file = ConfigFile {
        version: CONFIG_VERSION,
        guilds: configs.to_vec(),
    };
    let json = serde_json::to_string_pretty(&file)?;
    fs::write(path, json)?;
    Ok(())
}

/// Match an entry by guild_id, falling back to name for legacy callers /
/// entries without an id.
fn find_mut<'a>(configs: &'a mut [GuildConfig], key: &str) -> Option<&'a mut GuildConfig> {
    if let Some(i) = configs
        .iter()
        .position(|c| !c.guild_id.is_empty() && c.guild_id == key)
    {
        return configs.get_mut(i);
    }
    configs.iter_mut().find(|c| c.name == key)
}

pub fn get_active() -> Option<GuildConfig> {
    load_configs().into_iter().find(|c| c.is_active)
}

#[tauri::command]
pub fn get_active_guild_config() -> Option<FrontendConfig> {
    get_active().map(|c| FrontendConfig::from(&c))
}

#[tauri::command]
pub fn get_guild_configs() -> Vec<GuildConfig> {
    load_configs()
}

#[tauri::command]
pub fn set_guild_config(mut config: GuildConfig) -> Result<(), String> {
    // Manual edits are user-managed: discovery must not overwrite them.
    config.source = ConfigSource::User;
    let mut configs = load_configs();
    let key = if config.guild_id.is_empty() {
        config.name.clone()
    } else {
        config.guild_id.clone()
    };
    if let Some(existing) = find_mut(&mut configs, &key) {
        *existing = config;
    } else {
        configs.push(config);
    }
    save_configs(&configs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_active_guild(key: String) -> Result<(), String> {
    let mut configs = load_configs();
    if find_mut(&mut configs, &key).is_none() {
        return Err(format!("no guild config matching '{}'", key));
    }
    for c in configs.iter_mut() {
        c.is_active = (!c.guild_id.is_empty() && c.guild_id == key) || c.name == key;
    }
    save_configs(&configs).map_err(|e| e.to_string())?;
    crate::mcp::cosmos_client::reload_all();
    Ok(())
}

#[tauri::command]
pub fn delete_guild_config(key: String) -> Result<(), String> {
    let mut configs = load_configs();
    configs.retain(|c| !((!c.guild_id.is_empty() && c.guild_id == key) || c.name == key));
    save_configs(&configs).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_oh_active() -> Vec<GuildConfig> {
        // Shape of a real v1 file: only Orbital Hydro, active, no new fields.
        serde_json::from_str::<Vec<GuildConfig>>(
            r#"[{
                "name": "Orbital Hydro",
                "guild_tag": "OH",
                "guild_api": "http://crew.oh.energy/api",
                "reactor_api": "https://public.testnet.structs.network",
                "client_ws": "wss://public.testnet.structs.network:26657",
                "grass_nats_ws": "ws://crew.oh.energy:1443",
                "is_active": true
            }]"#,
        )
        .expect("legacy shape parses via serde defaults")
    }

    #[test]
    fn migrate_trims_trailing_slash_on_guild_api() {
        // The original seed shipped "https://beta.playstructs.com/api/" and
        // persisted it; the webapp appends "/setting" and the double slash
        // 404s. Loading must heal it (and report changed so it re-persists).
        let mut configs = default_configs();
        configs[0].guild_api = "https://beta.playstructs.com/api/".into();
        assert!(migrate_stale_urls(&mut configs));
        assert_eq!(configs[0].guild_api, "https://beta.playstructs.com/api");
        // Idempotent: a clean config reports no change.
        assert!(!migrate_stale_urls(&mut configs));
    }

    #[test]
    fn legacy_parse_backfills_and_seeds_sn_corp() {
        let mut configs = legacy_oh_active();
        migrate_v1_to_v2(&mut configs, true);
        let oh = configs.iter().find(|c| c.name == "Orbital Hydro").unwrap();
        assert_eq!(oh.guild_id, "0-1");
        assert!(configs.iter().any(|c| c.guild_id == DEFAULT_GUILD_ID));
    }

    #[test]
    fn session_install_keeps_active_guild() {
        let mut configs = legacy_oh_active();
        migrate_v1_to_v2(&mut configs, true); // player has logged in
        let active = configs.iter().find(|c| c.is_active).unwrap();
        assert_eq!(active.guild_id, "0-1", "OH stays active with a session");
    }

    #[test]
    fn sessionless_install_switches_to_default() {
        let mut configs = legacy_oh_active();
        migrate_v1_to_v2(&mut configs, false); // never logged in
        let active = configs.iter().find(|c| c.is_active).unwrap();
        assert_eq!(active.guild_id, DEFAULT_GUILD_ID);
        assert_eq!(configs.iter().filter(|c| c.is_active).count(), 1);
    }

    #[test]
    fn unknown_host_becomes_user_managed() {
        let mut c = legacy_oh_active().remove(0);
        c.guild_api = "https://my-custom-guild.example/api".into();
        backfill_guild_id(&mut c);
        assert!(c.guild_id.is_empty());
        assert_eq!(c.source, ConfigSource::User);
    }

    #[test]
    fn v2_envelope_round_trips() {
        let file = ConfigFile {
            version: CONFIG_VERSION,
            guilds: default_configs(),
        };
        let json = serde_json::to_string(&file).unwrap();
        let back: ConfigFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, CONFIG_VERSION);
        assert_eq!(back.guilds.len(), 2);
        assert_eq!(back.guilds[0].guild_id, DEFAULT_GUILD_ID);
    }
}
