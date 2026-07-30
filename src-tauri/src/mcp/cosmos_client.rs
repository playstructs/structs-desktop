use reqwest::Client;
use serde_json::Value;
use std::sync::{Arc, OnceLock, RwLock};

use crate::guild_config;
use crate::mcp::guild_api::GuildApiClient;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            // Bounded so a dead/unroutable LCD fails a scan in seconds instead
            // of hanging a loop body for the OS socket timeout (or forever).
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            // Bound the idle-connection pool. Fleet-wide scans open many short
            // requests to one host; without a cap the pool retains idle sockets
            // (memory + fds) and churns more buffers than needed. Cap idle
            // sockets per host and reap them after 30s idle so resources are
            // released promptly once a scan wave finishes.
            .pool_max_idle_per_host(8)
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build HTTP client")
    })
}

/// One shared GET with a single jittered retry on transport errors, timeouts,
/// 429s, and 5xx — safe because these are idempotent reads. Retried-and-still-
/// failing pressure errors feed the AIMD loop-concurrency controller.
async fn get_json(url: &str) -> Result<Value, String> {
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            // 300–800ms jitter, from the sub-ms clock bits (no rand dep).
            let frac = (crate::hasher::types::now_millis().fract() * 1000.0) as u64 % 500;
            tokio::time::sleep(std::time::Duration::from_millis(300 + frac)).await;
        }
        match client().get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                let body = match resp.text().await {
                    Ok(b) => b,
                    Err(e) => {
                        last_err = format!("Read error: {}", e);
                        continue;
                    }
                };
                if status.is_success() {
                    return serde_json::from_str(&body)
                        .map_err(|e| format!("JSON parse error: {}", e));
                }
                last_err = format!("API returned {}: {}", status, body);
                let retryable = status.as_u16() == 429 || status.is_server_error();
                if !retryable {
                    return Err(last_err);
                }
            }
            Err(e) => {
                last_err = format!("HTTP error: {}", e);
            }
        }
    }
    // Both attempts failed on a retryable class → endpoint pressure.
    crate::mcp::loop_util::report_failure();
    Err(last_err)
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

    /// Every coin an address holds, straight from the bank module.
    ///
    /// `playerInventory.rocks` is a single `Coin` and is always `ualpha`, so it
    /// structurally cannot show a player's guild tokens (`uguild.<id>`). This
    /// bypasses `entity_path` — it is a Cosmos SDK endpoint, not a Structs one.
    /// Returns the raw `balances` array: `[{denom, amount}, …]`.
    pub async fn bank_balances(&self, address: &str) -> Result<Vec<Value>, String> {
        let base = self.reactor_api.read().unwrap().clone();
        let url = format!(
            "{}/cosmos/bank/v1beta1/balances/{}",
            base.trim_end_matches('/'),
            address
        );
        let v = get_json(&url).await?;
        Ok(v.get("balances")
            .and_then(|b| b.as_array())
            .cloned()
            .unwrap_or_default())
    }

    /// Query a single entity by type and ID
    pub async fn query_entity(&self, entity_type: &str, id: &str) -> Result<Value, String> {
        let path = Self::entity_path(entity_type)?;
        let base = self.reactor_api.read().unwrap().clone();
        let url = format!("{}/structs/{}/{}", base, path, id);
        get_json(&url).await
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
            // next_key is base64, which contains '+', '/' and '=' — all of
            // which change meaning inside a query string. Percent-encode them
            // or page 2 silently returns page 1 (or an error).
            let encoded: String = key
                .chars()
                .map(|c| match c {
                    '+' => "%2B".to_string(),
                    '/' => "%2F".to_string(),
                    '=' => "%3D".to_string(),
                    other => other.to_string(),
                })
                .collect();
            params.push(format!("pagination.key={}", encoded));
        }
        if let Some(limit) = limit {
            params.push(format!("pagination.limit={}", limit));
        }
        if !params.is_empty() {
            url = format!("{}?{}", url, params.join("&"));
        }
        get_json(&url).await
    }

}
