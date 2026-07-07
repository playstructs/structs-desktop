use reqwest::Client;
use serde_json::Value;
use std::sync::{Arc, OnceLock, RwLock};

use crate::guild_config;
use crate::mcp::guild_api::GuildApiClient;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .build()
            .expect("failed to build HTTP client")
    })
}

/// Process-global URL cells shared by every CosmosClient (and the
/// GuildApiClient, which clones the guild_api Arc). A guild switch calls
/// `reload_all()` once and every client — including the long-lived MCP
/// handler instance — sees the new URLs immediately.
static REACTOR_API_CELL: OnceLock<Arc<RwLock<String>>> = OnceLock::new();
static GUILD_API_CELL: OnceLock<Arc<RwLock<String>>> = OnceLock::new();

fn reactor_api_cell() -> &'static Arc<RwLock<String>> {
    REACTOR_API_CELL.get_or_init(|| {
        let url = guild_config::get_active_guild_config()
            .map(|c| c.reactor_api)
            .unwrap_or_else(|| "http://localhost:1317".to_string());
        Arc::new(RwLock::new(url))
    })
}

fn guild_api_cell() -> &'static Arc<RwLock<String>> {
    GUILD_API_CELL.get_or_init(|| {
        let url = guild_config::get_active_guild_config()
            .map(|c| c.guild_api)
            .unwrap_or_else(|| "http://localhost/api".to_string());
        Arc::new(RwLock::new(url))
    })
}

/// Re-read the active guild config into the global URL cells.
/// Call after any change to the active guild.
pub fn reload_all() {
    if let Some(c) = guild_config::get_active_guild_config() {
        *reactor_api_cell().write().unwrap() = c.reactor_api;
        *guild_api_cell().write().unwrap() = c.guild_api;
    }
}

/// Typed Cosmos REST API client for querying game state.
/// URLs come from the active guild config.
///
/// `reactor_api` is the Cosmos LCD (canonical chain reads).
/// `guild` is the Symfony backend exposing extended catalog/stat/work endpoints.
#[derive(Clone)]
pub struct CosmosClient {
    reactor_api: Arc<RwLock<String>>,
    guild_api: Arc<RwLock<String>>,
    pub guild: GuildApiClient,
}

impl CosmosClient {
    pub fn new() -> Self {
        let reactor_api = Arc::clone(reactor_api_cell());
        let guild_api = Arc::clone(guild_api_cell());
        let guild = GuildApiClient::new(Arc::clone(&guild_api));

        Self {
            reactor_api,
            guild_api,
            guild,
        }
    }

    /// Reload URLs from the active guild config (e.g., after switching guilds)
    pub fn reload_config(&self) {
        reload_all();
    }

    /// Map entity type name to Cosmos REST API path segment
    fn entity_path(entity_type: &str) -> Result<&str, String> {
        match entity_type {
            "player" => Ok("player"),
            "planet" => Ok("planet"),
            "struct" => Ok("struct"),
            "struct_type" => Ok("struct_type"),
            "fleet" => Ok("fleet"),
            "guild" => Ok("guild"),
            "reactor" => Ok("reactor"),
            "substation" => Ok("substation"),
            "provider" => Ok("provider"),
            "agreement" => Ok("agreement"),
            "allocation" => Ok("allocation"),
            other => Err(format!("Unknown entity type: {}", other)),
        }
    }

    /// Query a single entity by type and ID
    pub async fn query_entity(&self, entity_type: &str, id: &str) -> Result<Value, String> {
        let path = Self::entity_path(entity_type)?;
        let base = self.reactor_api.read().unwrap().clone();
        let url = format!("{}/structs/{}/{}", base, path, id);

        let resp = client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("HTTP error: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("Read error: {}", e))?;

        if !status.is_success() {
            return Err(format!("API returned {}: {}", status, body));
        }

        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))
    }

    /// List entities of a given type with optional pagination
    pub async fn list_entities(
        &self,
        entity_type: &str,
        pagination_key: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        let path = Self::entity_path(entity_type)?;
        let base = self.reactor_api.read().unwrap().clone();
        let mut url = format!("{}/structs/{}", base, path);

        let mut params = vec![];
        if let Some(key) = pagination_key {
            params.push(format!("pagination.key={}", key));
        }
        if let Some(limit) = limit {
            params.push(format!("pagination.limit={}", limit));
        }
        if !params.is_empty() {
            url = format!("{}?{}", url, params.join("&"));
        }

        let resp = client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("HTTP error: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("Read error: {}", e))?;

        if !status.is_success() {
            return Err(format!("API returned {}: {}", status, body));
        }

        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))
    }

}
