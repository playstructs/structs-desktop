//! Typed client for the Guild API (Symfony backend exposing extended chain data).
//!
//! The Guild API serves at `{base}/api/...` and responds with
//! `{ success: bool, errors: [...], data: T | T[] }`.
//!
//! List endpoints use `/page/{N}` segments (1-indexed) with a fixed server-side
//! page size — see `PAGE_SIZE` below. Callers paginate by walking N=1,2,... and
//! checking `GuildPage::has_more`.

use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::future::Future;
use std::sync::{Arc, RwLock};

use crate::http_proxy::shared_client;

/// Server-side page size — matches `PaginationLimits::DEFAULT` in the Guild API.
/// Used to infer `has_more` on list responses.
pub const PAGE_SIZE: usize = 100;

/// Hard cap for `fetch_all_pages` so a runaway intel query can't hammer the API.
pub const MAX_PAGES: u32 = 5;

/// HTTP client shared with the JS fetch proxy. Critical: when the user logs in
/// via the webapp, the session cookie lands in this client's jar and is reused
/// by our Guild API calls — no separate MCP login needed.
fn http() -> &'static Client {
    shared_client()
}

/// Envelope returned by every Guild API endpoint.
///
/// `errors` is `[]` on success but can be an `{...}` object on failure
/// (e.g., `{"authentication_error": "Login required"}`), so it's accepted
/// as raw JSON and emptiness-checked via `errors_empty`.
#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Value,
    #[serde(default)]
    data: Value,
}

fn errors_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// A page of results plus a hint about whether more pages exist.
#[derive(Debug, Clone)]
pub struct GuildPage<T> {
    pub items: Vec<T>,
    pub page: u32,
    /// True when the page came back full (`items.len() == PAGE_SIZE`).
    /// The next page may still be empty — Guild API doesn't return a total count.
    pub has_more: bool,
}

impl GuildPage<Value> {
    /// Convert the page into the JSON object MCP `query` returns:
    /// `{ data: [...], page: N, has_more: bool, _next_page: "N+1" | null }`.
    pub fn into_response(self) -> Value {
        let next_page = if self.has_more {
            Value::String((self.page + 1).to_string())
        } else {
            Value::Null
        };
        serde_json::json!({
            "data": self.items,
            "page": self.page,
            "has_more": self.has_more,
            "_next_page": next_page,
        })
    }
}

/// Typed Guild API client. Cheap to clone — wraps an `Arc<RwLock<String>>` base URL.
#[derive(Clone)]
pub struct GuildApiClient {
    base: Arc<RwLock<String>>,
}

impl GuildApiClient {
    pub fn new(base: Arc<RwLock<String>>) -> Self {
        Self { base }
    }

    fn build_url(&self, path: &str) -> String {
        let base = self.base.read().unwrap().clone();
        // The configured base may already include the `/api` segment
        // (e.g. `http://crew.oh.energy/api`), and every endpoint path here is
        // written with a leading `/api/...`. Strip one trailing `/api` from the
        // base so we never emit the `/api/api/...` URL that 404s the whole
        // Guild-API perception layer (scout, battle_log, valid_targets, …).
        let base = base.trim_end_matches('/');
        let base = base.strip_suffix("/api").unwrap_or(base);
        format!(
            "{}/{}",
            base.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    /// Low-level GET: returns the unwrapped `data` field, validating the envelope.
    async fn get(&self, path: &str) -> Result<Value, String> {
        let url = self.build_url(path);
        let resp = http()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Guild API HTTP error: {}", e))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Guild API read error: {}", e))?;

        if !status.is_success() {
            return Err(format!("Guild API {} {}: {}", status.as_u16(), url, body));
        }

        let env: Envelope = serde_json::from_str(&body)
            .map_err(|e| format!("Guild API JSON parse error: {} (body: {})", e, body))?;

        if !env.success || !errors_empty(&env.errors) {
            // Recognize the auth-required shape and surface it specifically so
            // the MCP can prompt the user to sign in via the webapp UI.
            if let Some(obj) = env.errors.as_object() {
                if obj.contains_key("authentication_error") {
                    return Err(
                        "Guild API requires login — sign in via the Structs app first".into(),
                    );
                }
            }
            let err_summary = serde_json::to_string(&env.errors).unwrap_or_default();
            return Err(format!("Guild API returned errors: {}", err_summary));
        }

        Ok(env.data)
    }

    /// GET a list endpoint and wrap as `GuildPage`.
    async fn get_page(&self, path: &str, page: u32) -> Result<GuildPage<Value>, String> {
        let data = self.get(path).await?;
        let items = match data {
            Value::Array(arr) => arr,
            Value::Null => vec![],
            other => return Err(format!("expected array, got {}", other)),
        };
        let has_more = items.len() >= PAGE_SIZE;
        Ok(GuildPage {
            items,
            page,
            has_more,
        })
    }

    // ──────────────────────────────────────────────────────────────────────
    // Endpoint methods. One per route I actually use from Phase 2/3.
    // ──────────────────────────────────────────────────────────────────────

    // -- planet-activity --
    pub async fn planet_activity_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/planet-activity/all/page/{}", page), page)
            .await
    }
    pub async fn planet_activity_by_planet(
        &self,
        planet_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/planet-activity/planet/{}/page/{}", planet_id, page),
            page,
        )
        .await
    }
    pub async fn planet_activity_by_category(
        &self,
        category: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/planet-activity/category/{}/page/{}", category, page),
            page,
        )
        .await
    }

    // -- struct-defender --
    pub async fn struct_defender_by_defending(&self, struct_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/struct-defender/defending/{}", struct_id))
            .await
    }
    pub async fn struct_defender_by_protected(
        &self,
        struct_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/struct-defender/protected/{}/page/{}", struct_id, page),
            page,
        )
        .await
    }

    // -- stat ranges --
    pub async fn stat_range_by_object(
        &self,
        metric: &str,
        object_key: &str,
        page: u32,
        start: i64,
        end: i64,
    ) -> Result<GuildPage<Value>, String> {
        // The API requires the params named `start_time`/`end_time` (unix
        // seconds); `start`/`end` are rejected with a 400.
        self.get_page(
            &format!(
                "/api/stat/{}/object/{}/range/page/{}?start_time={}&end_time={}",
                metric, object_key, page, start, end
            ),
            page,
        )
        .await
    }

    // -- struct lists --
    pub async fn struct_list_by_location(
        &self,
        location_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/struct/list/location/{}/page/{}", location_id, page),
            page,
        )
        .await
    }
    pub async fn struct_list_by_owner(
        &self,
        owner: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/struct/list/owner/{}/page/{}", owner, page),
            page,
        )
        .await
    }

    // -- player activity (is-online / last-action recency) --
    pub async fn player_last_action_block(&self, player_id: &str) -> Result<Value, String> {
        self.get(&format!(
            "/api/player/{}/action/last/block/height",
            player_id
        ))
        .await
    }

    // -- grid --
    pub async fn grid_by_object(
        &self,
        object_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/grid/object/{}/page/{}", object_id, page),
            page,
        )
        .await
    }
    pub async fn grid_by_attribute_type(
        &self,
        attribute_type: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!(
                "/api/grid/attribute-type/{}/page/{}",
                attribute_type, page
            ),
            page,
        )
        .await
    }

    // -- work --
    pub async fn work_by_player(&self, player_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/work/player/{}", player_id)).await
    }
    pub async fn work_by_guild(
        &self,
        guild_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/work/guild/{}/page/{}", guild_id, page),
            page,
        )
        .await
    }

    // -- infusions --
    pub async fn infusion_by_player(
        &self,
        player_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/infusion/list/player/{}/page/{}", player_id, page),
            page,
        )
        .await
    }
    pub async fn infusion_by_destination(
        &self,
        destination_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!(
                "/api/infusion/list/destination/{}/page/{}",
                destination_id, page
            ),
            page,
        )
        .await
    }
    pub async fn infusion_by_address(
        &self,
        address: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/infusion/list/address/{}/page/{}", address, page),
            page,
        )
        .await
    }

    // -- ledger --
    // The double-entry ledger the Guild API has always served and this client
    // never called. It is durable and chain-authoritative, so it reaches
    // further back than the app has been running — the GRASS inventory stream
    // is the live tail on top of it, not the system of record.
    //
    // `action` is wider than a live sample suggests: genesis · received · sent ·
    // migrated · infused · defusion_started/cancelled/completed · mined ·
    // refined · seized · forfeited · minted · burned ·
    // diversion_started/completed.
    pub async fn ledger_by_player(
        &self,
        player_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/ledger/player/{}/page/{}", player_id, page),
            page,
        )
        .await
    }
    pub async fn ledger_count_by_player(&self, player_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/ledger/player/{}/count", player_id))
            .await
    }
    pub async fn ledger_by_address(
        &self,
        address: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/ledger/list/address/{}/page/{}", address, page),
            page,
        )
        .await
    }
    pub async fn ledger_by_tx(&self, tx_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/ledger/{}", tx_id)).await
    }

    // -- allocations --
    // An allocation moves capacity from a source object to a destination
    // (usually a substation). `controller` is a PLAYER id; `creator` is the
    // signing address — the two differ, so both lookups exist.
    pub async fn allocation_by_controller(
        &self,
        controller: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/allocation/controller/{}/page/{}", controller, page),
            page,
        )
        .await
    }
    pub async fn allocation_by_creator(
        &self,
        creator: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/allocation/creator/{}/page/{}", creator, page),
            page,
        )
        .await
    }
    pub async fn allocation_by_destination(
        &self,
        destination_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/allocation/destination/{}/page/{}", destination_id, page),
            page,
        )
        .await
    }

    // -- agreements --
    pub async fn agreement_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/agreement/all/page/{}", page), page)
            .await
    }
    pub async fn agreement_by_provider(
        &self,
        provider_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/agreement/provider/{}/page/{}", provider_id, page),
            page,
        )
        .await
    }
    pub async fn agreement_by_allocation(&self, allocation_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/agreement/allocation/{}", allocation_id))
            .await
    }
    pub async fn agreement_by_creator(&self, creator: &str) -> Result<Value, String> {
        self.get(&format!("/api/agreement/creator/{}", creator)).await
    }
    pub async fn agreement_by_owner(&self, owner: &str) -> Result<Value, String> {
        self.get(&format!("/api/agreement/owner/{}", owner)).await
    }

    // -- providers --
    pub async fn provider_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/provider/all/page/{}", page), page)
            .await
    }
    pub async fn provider_by_owner(
        &self,
        owner: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/provider/owner/{}/page/{}", owner, page),
            page,
        )
        .await
    }
    pub async fn provider_by_denom(
        &self,
        denom: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/provider/denom/{}/page/{}", denom, page),
            page,
        )
        .await
    }
    pub async fn provider_by_substation(
        &self,
        substation_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/provider/substation/{}/page/{}", substation_id, page),
            page,
        )
        .await
    }

    // -- attributes --
    pub async fn planet_attribute_by_object(
        &self,
        object_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/planet-attribute/object/{}/page/{}", object_id, page),
            page,
        )
        .await
    }
    pub async fn planet_attribute_by_type(
        &self,
        attribute_type: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!(
                "/api/planet-attribute/type/{}/page/{}",
                attribute_type, page
            ),
            page,
        )
        .await
    }
    pub async fn struct_attribute_by_object(
        &self,
        object_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/struct-attribute/object/{}/page/{}", object_id, page),
            page,
        )
        .await
    }
    pub async fn struct_attribute_by_type(
        &self,
        attribute_type: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!(
                "/api/struct-attribute/type/{}/page/{}",
                attribute_type, page
            ),
            page,
        )
        .await
    }

    // -- permissions --
    pub async fn permission_by_object(
        &self,
        object_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/permission/object/{}/page/{}", object_id, page),
            page,
        )
        .await
    }
    pub async fn permission_by_player(
        &self,
        player_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/permission/player/{}/page/{}", player_id, page),
            page,
        )
        .await
    }
}

/// Walk a paginated endpoint until `has_more` is false or `max_pages` is hit.
/// Hard-capped by `MAX_PAGES` to prevent runaway intel queries.
///
/// `fetch` receives 1-indexed page numbers (Guild API convention).
pub async fn fetch_all_pages<F, Fut>(
    fetch: F,
    max_pages: u32,
) -> Result<Vec<Value>, String>
where
    F: Fn(u32) -> Fut,
    Fut: Future<Output = Result<GuildPage<Value>, String>>,
{
    let cap = max_pages.min(MAX_PAGES);
    let mut all = Vec::new();
    for page in 1..=cap {
        let p = fetch(page).await?;
        let done = !p.has_more;
        all.extend(p.items);
        if done {
            break;
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_accepts_array_errors() {
        let body = r#"{"success":true,"errors":[],"data":[{"x":1}]}"#;
        let env: Envelope = serde_json::from_str(body).unwrap();
        assert!(env.success);
        assert!(errors_empty(&env.errors));
        assert!(env.data.is_array());
    }

    #[test]
    fn envelope_accepts_object_errors() {
        // Real-world auth-failure shape from the live API.
        let body = r#"{"success":false,"errors":{"authentication_error":"Login required"},"data":null}"#;
        let env: Envelope = serde_json::from_str(body).unwrap();
        assert!(!env.success);
        assert!(!errors_empty(&env.errors));
        assert!(env.errors.as_object().unwrap().contains_key("authentication_error"));
    }

    #[test]
    fn page_into_response_emits_next_page_when_more() {
        let p = GuildPage {
            items: (0..PAGE_SIZE).map(|i| json!({"i": i})).collect(),
            page: 1,
            has_more: true,
        };
        let v = p.into_response();
        assert_eq!(v["page"], json!(1));
        assert_eq!(v["has_more"], json!(true));
        assert_eq!(v["_next_page"], json!("2"));
    }

    #[test]
    fn page_into_response_null_next_page_on_last() {
        let p = GuildPage {
            items: vec![json!({})],
            page: 3,
            has_more: false,
        };
        let v = p.into_response();
        assert_eq!(v["page"], json!(3));
        assert_eq!(v["has_more"], json!(false));
        assert!(v["_next_page"].is_null());
    }

    #[test]
    fn build_url_avoids_double_api_prefix() {
        // Every endpoint path is written with a leading `/api/...`. The configured
        // base may or may not already include `/api` — either way we want exactly
        // one `/api`, never the `/api/api/...` that 404s the live API.
        let with = GuildApiClient::new(Arc::new(RwLock::new("http://crew.oh.energy/api".into())));
        assert_eq!(
            with.build_url("/api/struct/list/location/2-1/page/1"),
            "http://crew.oh.energy/api/struct/list/location/2-1/page/1"
        );
        let with_slash = GuildApiClient::new(Arc::new(RwLock::new("http://crew.oh.energy/api/".into())));
        assert_eq!(with_slash.build_url("/api/foo"), "http://crew.oh.energy/api/foo");
        let without = GuildApiClient::new(Arc::new(RwLock::new("http://crew.oh.energy".into())));
        assert_eq!(without.build_url("/api/foo"), "http://crew.oh.energy/api/foo");
        let localhost = GuildApiClient::new(Arc::new(RwLock::new("http://localhost/api".into())));
        assert_eq!(localhost.build_url("/api/foo"), "http://localhost/api/foo");
    }
}
