use reqwest::Client;
use serde_json::Value;
use std::sync::{Arc, OnceLock, RwLock};

use crate::guild_config;
use crate::mcp::guild_api::GuildApiClient;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

pub(crate) fn client() -> &'static Client {
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

/// A Cosmos `next_key` is base64, which contains '+', '/' and '=' — all of
/// which change meaning inside a query string. Percent-encode them or page 2
/// silently returns page 1 (or an error).
pub(crate) fn encode_pagination_key(key: &str) -> String {
    key.chars()
        .map(|c| match c {
            '+' => "%2B".to_string(),
            '/' => "%2F".to_string(),
            '=' => "%3D".to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Pull the `(object_id, mask)` pairs granting `player_id` out of one page of
/// permission records. Pure — unit-tested.
///
/// A permission id is `{objectId}@{playerId}`. The id is split on `@` and the
/// grantee compared as a WHOLE token, never by substring: `1-19` is a prefix of
/// `1-194`, so a `contains` test here would silently credit one player with
/// another's grants.
fn parse_permission_page(v: &Value, player_id: &str) -> Vec<(String, u64)> {
    let Some(recs) = v.get("permissionRecords").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    recs.iter()
        .filter_map(|rec| {
            let (object_id, grantee) = rec
                .get("permissionId")
                .and_then(|x| x.as_str())?
                .split_once('@')?;
            if grantee != player_id {
                return None;
            }
            let value = rec
                .get("value")
                .and_then(|x| x.as_str().and_then(|s| s.parse().ok()).or_else(|| x.as_u64()))
                .unwrap_or(0);
            Some((object_id.to_string(), value))
        })
        .collect()
}

/// One shared GET with a single jittered retry on transport errors, timeouts,
/// 429s, and 5xx — safe because these are idempotent reads. Retried-and-still-
/// failing pressure errors feed the AIMD loop-concurrency controller.
pub(crate) async fn get_json(url: &str) -> Result<Value, String> {
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

/// The active guild's LCD base (no trailing slash) — what every read and,
/// in native sign mode, every broadcast goes to.
pub(crate) fn reactor_api_base() -> String {
    reactor_api_cell().read().unwrap().trim_end_matches('/').to_string()
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
            // Keyed `{destinationId}/{address}`, not by a single id — so a
            // by-id read passes both segments as one `id` string. The LIST
            // endpoint is a full scan, but the whole galaxy holds a few dozen
            // infusions, so one page covers it.
            "infusion" => Ok("infusion"),
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

    /// Raw LCD GET for endpoints that are NOT Structs entities — the Cosmos SDK
    /// modules the game abstracts over. Reactor infusion IS staking delegation,
    /// so the in-flight state of a defusion (unbonding) or a migration
    /// (redelegation) exists only in `/cosmos/staking/...`: the Infusion record
    /// carries a `defusing` total but neither the creation height that
    /// `MsgReactorCancelDefusion` requires nor the completion time.
    ///
    /// `path` is absolute-from-root, e.g. "/cosmos/staking/v1beta1/params".
    pub async fn lcd_get(&self, path: &str) -> Result<Value, String> {
        let base = self.reactor_api.read().unwrap().clone();
        get_json(&format!("{}{}", base.trim_end_matches('/'), path)).await
    }

    /// Bulk LCD GET for whole-store page walks (`mcp::perception`). Returns
    /// the body plus the chain height and server wall-clock the page was
    /// served at (`grpc-metadata-x-cosmos-block-height`, `x-server-time`), so
    /// a snapshot can be ordered against GRASS frames.
    ///
    /// Uses its own HTTP client: the shared one is tuned for thousands of
    /// tiny entity reads (15 s timeout), while a 60k-row page is ~2.5 MB and
    /// takes 1–6 s on a quiet node — a loaded node would trip the small
    /// timeout and turn one big read into a retry storm. Not retried here:
    /// the caller decides whether a failed snapshot matters.
    pub async fn lcd_get_bulk(&self, path: &str) -> Result<(Value, u64, f64), String> {
        static BULK_CLIENT: OnceLock<Client> = OnceLock::new();
        let c = BULK_CLIENT.get_or_init(|| {
            Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(90))
                .pool_max_idle_per_host(4)
                .build()
                .expect("failed to build bulk HTTP client")
        });
        let base = self.reactor_api.read().unwrap().clone();
        let url = format!("{}{}", base.trim_end_matches('/'), path);
        let resp = c.get(&url).send().await.map_err(|e| format!("HTTP error: {}", e))?;
        let status = resp.status();
        let height = resp
            .headers()
            .get("grpc-metadata-x-cosmos-block-height")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let server_time = resp
            .headers()
            .get("x-server-time")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let body = resp.text().await.map_err(|e| format!("Read error: {}", e))?;
        if !status.is_success() {
            if status.as_u16() == 429 || status.is_server_error() {
                crate::mcp::loop_util::report_failure();
            }
            return Err(format!("API returned {}: {}", status, body.chars().take(300).collect::<String>()));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;
        Ok((v, height, server_time))
    }

    /// How many of an entity type exist on-chain right now, via the LCD's
    /// `pagination.count_total` (one request, no page walk). For structs this
    /// counts LIVE objects only — the chain prunes destroyed structs, so it is
    /// the honest "deployed" figure where the indexer's `struct` table keeps
    /// every corpse (96k destroyed rows and counting).
    pub async fn count_entities(&self, entity_type: &str) -> Result<u64, String> {
        let path = Self::entity_path(entity_type)?;
        let base = self.reactor_api.read().unwrap().clone();
        let url = format!(
            "{}/structs/{}?pagination.limit=1&pagination.count_total=true",
            base.trim_end_matches('/'),
            path
        );
        let v = get_json(&url).await?;
        v.get("pagination")
            .and_then(|p| p.get("total"))
            .and_then(|t| {
                t.as_u64()
                    .or_else(|| t.as_str().and_then(|s| s.parse().ok()))
            })
            .ok_or_else(|| format!("LCD {} count: no pagination.total", entity_type))
    }

    /// The permission bitmask player `player_id` holds on object `object_id`.
    ///
    /// Permission records are keyed `{objectId}@{playerId}`, so this is a plain
    /// by-id read — and a MISSING record answers `0` rather than 404, which is
    /// exactly the "holds nothing" answer callers want. Bypasses `entity_path`:
    /// the id carries an `@`, which is percent-encoded so it can never be read
    /// as a userinfo separator.
    pub async fn permission_value(&self, object_id: &str, player_id: &str) -> Result<u64, String> {
        let base = self.reactor_api.read().unwrap().clone();
        let url = format!(
            "{}/structs/permission/{}%40{}",
            base.trim_end_matches('/'),
            object_id,
            player_id
        );
        let v = get_json(&url).await?;
        Ok(v.get("permissionRecord")
            .and_then(|r| r.get("value"))
            .and_then(|x| x.as_str().and_then(|s| s.parse().ok()).or_else(|| x.as_u64()))
            .unwrap_or(0))
    }

    /// Every address holding `denom`, as `(address, base_units)` pairs,
    /// straight from the bank module — the only denom-scoped bulk balance
    /// read anywhere in the stack. The Guild API's roster/search "alpha"
    /// columns sum EVERY denom (no `denom=` filter in their SQL), so guild
    /// tokens masquerade as alpha there; this is the honest source.
    pub async fn denom_owners(
        &self,
        denom: &str,
        max_pages: usize,
    ) -> Result<(Vec<(String, f64)>, bool), String> {
        let base = self.reactor_api.read().unwrap().clone();
        let base = base.trim_end_matches('/').to_string();
        let mut out: Vec<(String, f64)> = Vec::new();
        let mut next_key: Option<String> = None;
        for page in 0..max_pages {
            let mut url = format!(
                "{}/cosmos/bank/v1beta1/denom_owners/{}?pagination.limit=1000",
                base, denom
            );
            if let Some(k) = &next_key {
                url.push_str(&format!("&pagination.key={}", encode_pagination_key(k)));
            }
            let v = get_json(&url).await?;
            for row in v
                .get("denom_owners")
                .and_then(|d| d.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[])
            {
                let addr = row.get("address").and_then(|a| a.as_str()).unwrap_or("");
                let amount = row
                    .get("balance")
                    .and_then(|b| b.get("amount"))
                    .and_then(|x| {
                        x.as_f64()
                            .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
                    })
                    .unwrap_or(0.0);
                if !addr.is_empty() && amount > 0.0 {
                    out.push((addr.to_string(), amount));
                }
            }
            next_key = v
                .get("pagination")
                .and_then(|p| p.get("next_key"))
                .and_then(|k| k.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            if next_key.is_none() {
                return Ok((out, false));
            }
            if page + 1 == max_pages {
                return Ok((out, true));
            }
        }
        Ok((out, false))
    }

    /// Every permission record naming `player_id` as the GRANTEE, as
    /// `(object_id, value)` pairs, plus whether the scan hit `max_pages`.
    ///
    /// The LCD filter is applied AFTER pagination: each page is a slice of the
    /// whole permission store that happens to be filtered down to the matches
    /// inside it. An empty page therefore means "no matches in this slice", NOT
    /// "no more matches" — the scan must follow `next_key` to exhaustion or it
    /// silently reports far fewer grants than exist. `max_pages` bounds a
    /// runaway store; hitting it is reported so the caller can say so.
    pub async fn permissions_by_player(
        &self,
        player_id: &str,
        max_pages: usize,
    ) -> Result<(Vec<(String, u64)>, bool), String> {
        let base = self.reactor_api.read().unwrap().clone();
        let base = base.trim_end_matches('/').to_string();
        let mut out: Vec<(String, u64)> = Vec::new();
        let mut next_key: Option<String> = None;
        for page in 0..max_pages {
            let mut url = format!(
                "{}/structs/permission/player/{}?pagination.limit=1000",
                base, player_id
            );
            if let Some(k) = &next_key {
                url.push_str(&format!("&pagination.key={}", encode_pagination_key(k)));
            }
            let v = get_json(&url).await?;
            out.extend(parse_permission_page(&v, player_id));
            next_key = v
                .get("pagination")
                .and_then(|p| p.get("next_key"))
                .and_then(|k| k.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            if next_key.is_none() {
                return Ok((out, false));
            }
            if page + 1 == max_pages {
                return Ok((out, true));
            }
        }
        Ok((out, true))
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
            params.push(format!("pagination.key={}", encode_pagination_key(key)));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Shape mirrors a live LCD page: `value` is a STRING, and the page is a
    /// slice of the whole permission store, so it carries other players' rows.
    fn page() -> Value {
        json!({
            "permissionRecords": [
                { "permissionId": "1-2562@1-194", "value": "33554431" },
                { "permissionId": "6-53@1-194", "value": "2062" },
                { "permissionId": "1-300@1-1940", "value": "33554431" },
                { "permissionId": "1-301@1-19", "value": "33554431" },
                { "permissionId": "1-302@1-1", "value": "1" },
                { "malformed": true }
            ],
            "pagination": { "next_key": "abc", "total": "0" }
        })
    }

    #[test]
    fn keeps_only_whole_token_grantee_matches() {
        let got = parse_permission_page(&page(), "1-194");
        assert_eq!(
            got,
            vec![("1-2562".to_string(), 33_554_431), ("6-53".to_string(), 2062)],
            "1-1940 and 1-19 share a prefix with 1-194 and must not match"
        );
    }

    #[test]
    fn a_page_with_no_matches_is_empty_not_an_error() {
        assert!(parse_permission_page(&page(), "1-99999").is_empty());
        assert!(parse_permission_page(&json!({}), "1-194").is_empty());
    }

    #[test]
    fn pagination_key_is_query_safe() {
        // A raw base64 next_key would break the query string at '+', '/', '='.
        assert_eq!(encode_pagination_key("MS0xOTY0QDEtM+/="), "MS0xOTY0QDEtM%2B%2F%3D");
    }
}
