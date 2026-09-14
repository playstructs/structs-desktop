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
/// `GET /api/objects?ids=` accepts this many ids per call (raised from 25 on
/// 2026-09-04).
pub const OBJECTS_BATCH_MAX: usize = 200;

/// Hard cap for `fetch_all_pages` so a runaway intel query can't hammer the API.
pub const MAX_PAGES: u32 = 5;

/// HTTP client shared with the JS fetch proxy. Critical: when the user logs in
/// via the webapp, the session cookie lands in this client's jar and is reused
/// by our Guild API calls — no separate MCP login needed.
fn http() -> &'static Client {
    shared_client()
}

// ── Request accounting ──────────────────────────────────────────────────────
// How hard is THIS client hitting the shared Guild API? The infra team can
// see aggregate load but not who causes it; these counters make our own
// contribution observable (structs_system status → guild_api_requests) so
// "are we hammering the API" is a lookup, not a debate.
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
static REQ_TOTAL: AtomicU64 = AtomicU64::new(0);
static REQ_WINDOW: std::sync::Mutex<(u64, u64, u64)> = std::sync::Mutex::new((0, 0, 0)); // (minute, current, previous)

fn note_request() {
    REQ_TOTAL.fetch_add(1, AtomicOrdering::Relaxed);
    let minute = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0);
    let mut w = REQ_WINDOW.lock().unwrap();
    if w.0 != minute {
        w.2 = if w.0 + 1 == minute { w.1 } else { 0 };
        w.0 = minute;
        w.1 = 0;
    }
    w.1 += 1;
}

/// (total since launch, this minute so far, the last full minute).
pub fn request_stats() -> (u64, u64, u64) {
    let minute = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0);
    let w = REQ_WINDOW.lock().unwrap();
    let (cur, prev) = if w.0 == minute {
        (w.1, w.2)
    } else if w.0 + 1 == minute {
        (0, w.1)
    } else {
        (0, 0)
    };
    (REQ_TOTAL.load(AtomicOrdering::Relaxed), cur, prev)
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

/// `Envelope` plus the optional `total` that `include_total=1` adds.
#[derive(Debug, Deserialize)]
struct EnvelopeWithTotal {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Value,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    total: Option<Value>,
}

/// Does a walk continue after a page of `this_len` rows, given the first
/// page had `first_len`? The first page reveals the server's real page size
/// (whatever `?limit=` it clamped to); any shorter page is the last.
/// The roles the indexer writes on `structs.planet_activity_player` — the
/// server's own allowlist (`TableReadManager::PLANET_ACTIVITY_PLAYER_ROLES`).
pub const ACTIVITY_ROLES: &[&str] = &[
    "attacker", "target", "owner", "planet_owner", "defender", "protected", "fleet_owner",
];

/// The categories the per-player feed serves (the server's
/// `PLANET_ACTIVITY_PLAYER_CATEGORIES`); anything else is a 400.
pub const ACTIVITY_CATEGORIES: &[&str] = &[
    "struct_attack", "raid_status", "fleet_arrive", "fleet_depart", "struct_status",
    "struct_health", "struct_move", "struct_block_build_start", "struct_block_ore_mine_start",
    "struct_block_ore_refine_start", "struct_defense_add", "struct_defense_remove",
    "shield_change", "block_raid_start",
];

/// What `planet_activity_by_player` asks the feed for. `Default` is the
/// whole feed, every role, collapsed to one row per event.
#[derive(Clone, Debug, Default)]
pub struct ActivityFilter {
    pub category: Option<String>,
    /// One of `ACTIVITY_ROLES`. Refused (not ignored) on a guild that does
    /// not filter by role — see `activity_roles_supported`.
    pub role: Option<String>,
    /// Only rows with `block_height > since_height`. Applied server-side
    /// where the guild knows the parameter and client-side always.
    pub since_height: Option<u64>,
}

impl ActivityFilter {
    /// The query string, `?`-prefixed, or empty. `limit` is NOT here — the
    /// page reader appends it.
    pub fn query_string(&self) -> String {
        let mut q: Vec<String> = Vec::new();
        if let Some(c) = self.category.as_deref().filter(|c| !c.is_empty()) {
            q.push(format!("category={c}"));
        }
        if let Some(r) = self.role.as_deref().filter(|r| !r.is_empty()) {
            q.push(format!("role={r}"));
        }
        if let Some(h) = self.since_height {
            q.push(format!("since_height={h}"));
        }
        if q.is_empty() { String::new() } else { format!("?{}", q.join("&")) }
    }
}

/// Drop rows at or below the high-water mark. A row with no readable
/// `block_height` is kept: the feed has always carried the column, so its
/// absence is a shape we have not seen, not a row below the mark.
pub fn apply_since_height(mut rows: Vec<Value>, since: Option<u64>) -> Vec<Value> {
    let Some(since) = since else { return rows };
    rows.retain(|r| {
        r.get("block_height")
            .and_then(|h| h.as_u64().or_else(|| h.as_str().and_then(|s| s.trim().parse().ok())))
            .map(|h| h > since)
            .unwrap_or(true)
    });
    rows
}

/// A role no indexer will ever write; the probe asks for it on purpose.
const ROLE_PROBE_VALUE: &str = "probe";
pub const ROLE_FILTER_UNSUPPORTED: &str =
    "the guild does not filter activity by role yet — an older guild API ignores the parameter and would answer every role";
static ACTIVITY_ROLE_PROBE: std::sync::Mutex<Option<(bool, std::time::Instant)>> = std::sync::Mutex::new(None);

/// Read the probe: a 400 naming `role_invalid` is the new server saying no
/// to a bad role (so it WOULD honour a good one); a 200 is the old server
/// ignoring the parameter. Anything else is a real failure to surface.
pub fn classify_role_probe(probe: &Result<Value, String>) -> Result<bool, String> {
    match probe {
        Ok(_) => Ok(false),
        Err(e) if e.contains("role_invalid") => Ok(true),
        Err(e) => Err(e.clone()),
    }
}

/// `data` of a validated envelope as a list (`null` → empty).
fn envelope_rows(env: &Value) -> Result<Vec<Value>, String> {
    match env.get("data") {
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(Value::Null) | None => Ok(vec![]),
        Some(other) => Err(format!("expected a list, got {other}")),
    }
}

/// `meta.height` of an envelope, when the caller asked for it.
fn envelope_height(env: &Value) -> Option<u64> {
    env.get("meta")
        .and_then(|m| m.get("height"))
        .and_then(|h| h.as_u64().or_else(|| h.as_str().and_then(|s| s.parse().ok())))
}

pub fn page_walk_continues(first_len: usize, this_len: usize) -> bool {
    first_len > 0 && this_len == first_len
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
    // (see `query_esc` below)
    pub(crate) fn base_url(&self) -> String {
        self.base.read().map(|b| b.clone()).unwrap_or_default()
    }

    /// A route that needs no session (`/api/timestamp`): no login retry, so
    /// the login itself can use it without recursing.
    pub(crate) async fn get_public(&self, path: &str) -> Result<Value, String> {
        self.get_once(path).await
    }

    /// `POST` a JSON body to a public route and return the whole envelope
    /// (`/api/auth/login` answers `success` + `errors`, no `data`).
    pub(crate) async fn post_public(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = self.build_url(path);
        note_request();
        let resp = http()
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Guild API HTTP error: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("Guild API read error: {e}"))?;
        if !status.is_success() {
            return Err(format!("Guild API {} {}: {}", status.as_u16(), url, text));
        }
        serde_json::from_str(&text).map_err(|e| format!("Guild API JSON parse error: {e} (body: {text})"))
    }

    /// Whether an error from the client means "no session" — the guild's
    /// `authentication_error` envelope, or a bare 401.
    fn is_auth_error(e: &str) -> bool {
        e.contains("requires login") || e.starts_with("Guild API 401 ")
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        match self.get_once(path).await {
            Err(e) if Self::is_auth_error(&e) => {
                // The session is gone (never made, or idled out). Rust can
                // sign the login itself — see mcp/guild_auth.rs — so make one
                // and retry once instead of failing over to the LCD.
                if crate::mcp::guild_auth::recover(self).await {
                    self.get_once(path).await
                } else {
                    Err(e)
                }
            }
            other => other,
        }
    }

    async fn get_once(&self, path: &str) -> Result<Value, String> {
        note_request();
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

    /* Every activity row that names this player, on either side of it.
     *
     * Served from `structs.planet_activity_player`, a side table the indexer
     * writes at insert time: one row per (event, player, ROLE). Ownership is
     * as-of-event, so a struct that changes hands no longer takes its past
     * with it (history before 2026-09-15 was backfilled with the ownership of
     * that day). The roles the indexer assigns, measured on the mirror:
     *
     *   struct_attack           attacker · target
     *   raid_status             fleet_owner · planet_owner
     *   fleet_arrive/depart     fleet_owner · planet_owner
     *   struct_defense_add/rm   defender · protected
     *   struct_status/health/move/block_build_start   owner
     *   struct_block_ore_*      owner · planet_owner
     *   shield_change · block_raid_start              planet_owner
     *
     * Without a `role` the server collapses dual-role rows (`DISTINCT ON` the
     * parent event) so a self-raid is one row, not two; with a `role` every
     * row is that role's. Rows are the parent's columns, unchanged:
     * `time, seq, planet_id, block_height, category, detail` (+ decoded
     * `detail_json`), newest first on `(block_height, time, planet_id, seq)`.
     *
     * `since_height` is a high-water mark (`block_height > n`), not a cursor —
     * OFFSET paging still applies inside it. It is ALSO applied here on the
     * rows, because a guild that predates the parameter ignores it and
     * answers the whole feed; the client-side pass makes the result the same
     * on both. `role` cannot be repaired that way (an older guild silently
     * returns every role, mislabelled), so a role filter is refused outright
     * when the probe says the guild does not know the parameter — see
     * [`activity_roles_supported`].
     *
     * The walk is written out rather than handed to `walk_list` because the
     * query string has to survive the `/page/{n}` segment, and `walk_list`
     * builds that segment by string append.
     *
     * Returns (rows, height, completed) — `completed: false` means the walk
     * hit `max_pages` and the rows are a truncated tail, never a total. */
    pub async fn planet_activity_by_player(
        &self,
        player_id: &str,
        filter: &ActivityFilter,
        limit: usize,
        max_pages: u32,
    ) -> Result<(Vec<Value>, Option<u64>, bool), String> {
        if let Some(role) = filter.role.as_deref() {
            if !ACTIVITY_ROLES.contains(&role) {
                return Err(format!("{role:?} is not an activity role ({})", ACTIVITY_ROLES.join(", ")));
            }
            if !self.activity_roles_supported(player_id).await? {
                return Err(ROLE_FILTER_UNSUPPORTED.into());
            }
        }
        // `list_page_with_meta` appends `?limit=`/`&limit=` itself — adding a
        // second one here silently halved the page size on the first walk.
        let query = filter.query_string();
        let mut rows = Vec::new();
        let mut height: Option<u64> = None;
        let mut page_size: Option<usize> = None;
        let mut page = 1u32;
        loop {
            let (items, h, _) = self
                .list_page_with_meta(
                    &format!("/api/planet-activity/player/{player_id}/page/{page}{query}"),
                    limit,
                )
                .await
                .map_err(|e| {
                    // The page number is noise in the common case (the route
                    // is not there at all); keep the raw error so
                    // `achievements::is_missing_route` can still read the 404.
                    if page == 1 { e } else { format!("page {page}: {e}") }
                })?;
            if let Some(h) = h {
                height = Some(height.map_or(h, |x| x.max(h)));
            }
            let n = items.len();
            rows.extend(items);
            let first = *page_size.get_or_insert(n);
            if !page_walk_continues(first, n) {
                break;
            }
            if page >= max_pages {
                return Ok((apply_since_height(rows, filter.since_height), height, false));
            }
            page += 1;
        }
        Ok((apply_since_height(rows, filter.since_height), height, true))
    }

    /// One page of the per-player feed, for the raw `structs_intel query`
    /// probe (`type: planet_activity, filter: {by: player, value: 1-61}`).
    pub async fn planet_activity_by_player_page(
        &self,
        player_id: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/planet-activity/player/{}/page/{}", player_id, page),
            page,
        )
        .await
    }

    /// Does this guild filter the per-player feed by `role`?
    ///
    /// The parameter arrived with the side-table cutover; a guild from before
    /// it does not reject an unknown query parameter, it IGNORES it — so a
    /// `role=target` read of an older guild answers every role with a
    /// straight face, and "attacks on me" quietly becomes "every attack I
    /// was part of". The only way to tell the two apart is to ask for a role
    /// that cannot exist: the new code answers 400 `role_invalid`, the old
    /// code answers 200. Probed once an hour so a deploy is picked up
    /// without a restart, and shared by every caller.
    pub async fn activity_roles_supported(&self, player_id: &str) -> Result<bool, String> {
        const TTL: std::time::Duration = std::time::Duration::from_secs(3600);
        if let Some((ok, at)) = *ACTIVITY_ROLE_PROBE.lock().unwrap_or_else(|e| e.into_inner()) {
            if at.elapsed() < TTL {
                return Ok(ok);
            }
        }
        let probe = self
            .get_envelope(&format!("/api/planet-activity/player/{player_id}/page/1?limit=1&role={ROLE_PROBE_VALUE}"))
            .await;
        let ok = classify_role_probe(&probe)?;
        *ACTIVITY_ROLE_PROBE.lock().unwrap_or_else(|e| e.into_inner()) = Some((ok, std::time::Instant::now()));
        Ok(ok)
    }

    /// Per-player DAILY activity counts for the last 30 days, straight from
    /// the indexer's continuous aggregate: rows `{bucket, category, role,
    /// count}`, one per (day, category, role) the player appears in. Empty
    /// days are ABSENT (this is a complete count over the window, so absence
    /// here IS zero — unlike the stat store); the current day is partial.
    ///
    /// Roles are per event, so summing every role of one category
    /// double-counts events where the player holds two roles at once (their
    /// own struct on their own planet, a self-raid). Read one role, or the
    /// role a category is keyed on — see `planet_activity_by_player`.
    ///
    /// Daily only: the server answers 400 for `bucket=1h`. A guild that has
    /// not deployed the route answers 404, which the error carries verbatim
    /// so a caller can say "not served yet" rather than "zero".
    pub async fn planet_activity_player_stats(
        &self,
        player_id: &str,
        category: Option<&str>,
        role: Option<&str>,
    ) -> Result<(Vec<Value>, Option<u64>), String> {
        let mut q: Vec<String> = Vec::new();
        if let Some(c) = category.filter(|c| !c.is_empty()) {
            q.push(format!("category={c}"));
        }
        if let Some(r) = role.filter(|r| !r.is_empty()) {
            if !ACTIVITY_ROLES.contains(&r) {
                return Err(format!("{r:?} is not an activity role ({})", ACTIVITY_ROLES.join(", ")));
            }
            q.push(format!("role={r}"));
        }
        let query = if q.is_empty() { String::new() } else { format!("?{}", q.join("&")) };
        let env = self
            .get_envelope(&format!("/api/planet-activity/player/{player_id}/stats{query}"))
            .await?;
        Ok((envelope_rows(&env)?, envelope_height(&env)))
    }

    /// Galaxy-wide activity counts per bucket and category over the last 30
    /// days (`/api/planet-activity/stats`): rows `{bucket, category, count}`.
    /// `bucket` is `1h` or `1d`; the window is fixed server-side at 30 days
    /// either way. Read from the hourly/daily continuous aggregates, so it
    /// is cheap enough to poll. Empty buckets are absent and mean zero.
    pub async fn planet_activity_stats(
        &self,
        category: Option<&str>,
        bucket: &str,
    ) -> Result<(Vec<Value>, Option<u64>), String> {
        let mut q = vec![format!("bucket={bucket}")];
        if let Some(c) = category.filter(|c| !c.is_empty()) {
            q.push(format!("category={c}"));
        }
        let env = self
            .get_envelope(&format!("/api/planet-activity/stats?{}", q.join("&")))
            .await?;
        Ok((envelope_rows(&env)?, envelope_height(&env)))
    }

    // -- planet-raid --
    //
    // `planet_raid` holds only the LATEST raid per planet, as a `PlanetRaid`:
    // `{planet_id, planet_owner, fleet_id, fleet_owner, status, updated_at}`.
    // It is the only source that carries the two OWNERS — the activity feed
    // carries ids only — so it is what turns "planet 2-1595 is being raided"
    // into "who is raiding whom".
    //
    // Note the table keeps non-terminal rows indefinitely: a raid that never
    // reached a terminal status stays `initiated` forever (two such rows are
    // live today, one 19 days old). Freshness is decided by the caller, not by
    // the status field. See [`crate::mcp::raid_view::reduce_raids`].
    pub async fn planet_raid_active_by_planet(&self, planet_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/planet/{}/raid/active", planet_id))
            .await
    }
    pub async fn planet_raid_active_by_fleet(&self, fleet_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/planet/raid/active/fleet/{}", fleet_id))
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
    // -- batched typed reads: `GET /api/objects?ids=a,b,c` (see mcp/verify.rs) --
    /// Up to `OBJECTS_BATCH_MAX` ids in one call. Returns the typed rows
    /// (`{id, type, object}`) and the indexer height the response was
    /// stamped with. Struct rows are BASE columns (owner, location, slot,
    /// is_destroyed) — no status/health; planet and fleet rows carry `map`
    /// (slot arrays as a JSON string), fleets also `status` and
    /// `command_struct`; player rows carry `planet_id` / `fleet_id`.
    pub async fn objects_by_ids(&self, ids: &[&str]) -> Result<(Vec<Value>, Option<u64>), String> {
        if ids.is_empty() {
            return Ok((vec![], None));
        }
        if ids.len() > OBJECTS_BATCH_MAX {
            return Err(format!("objects batch of {} exceeds the {OBJECTS_BATCH_MAX}-id cap", ids.len()));
        }
        let env = self.get_envelope(&format!("/api/objects?ids={}", ids.join(","))).await?;
        let height = env
            .get("meta")
            .and_then(|m| m.get("height"))
            .and_then(|h| h.as_u64().or_else(|| h.as_str().and_then(|s| s.parse().ok())));
        let rows = match env.get("data") {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::Null) | None => vec![],
            Some(other) => return Err(format!("objects: expected a list, got {other}")),
        };
        Ok((rows, height))
    }

    /// One catalog page at a caller-chosen size, with the indexer height the
    /// envelope was stamped with and whether a next page exists. The bulk
    /// source for the perception snapshot (`perception::guild_pages`).
    pub async fn list_page_with_meta(&self, path: &str, limit: usize) -> Result<(Vec<Value>, Option<u64>, bool), String> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let env = self.get_envelope(&format!("{path}{sep}limit={limit}")).await?;
        let height = env
            .get("meta")
            .and_then(|m| m.get("height"))
            .and_then(|h| h.as_u64().or_else(|| h.as_str().and_then(|s| s.parse().ok())));
        let items = match env.get("data") {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::Null) | None => vec![],
            Some(other) => return Err(format!("expected a list, got {other}")),
        };
        let more = items.len() >= limit;
        Ok((items, height, more))
    }

    /// Walk a catalog list from page 1 until it ends. Returns the rows, the
    /// highest indexer height seen, and whether the walk COMPLETED (false =
    /// it hit `max_pages` and the rows are a truncated store — never install
    /// those as the truth).
    ///
    /// The end of a list is a page SHORTER than the first page, not shorter
    /// than the limit we asked for: the server clamps `?limit=` (1,000 on
    /// 0.1.330's guild), and trusting the requested size ended every walk
    /// after page one — a 1,000-row "galaxy" that verified explores against
    /// planets it had never seen (32 chain rejections in an hour).
    pub async fn walk_list(&self, path_base: &str, limit: usize, max_pages: u32) -> Result<(Vec<Value>, Option<u64>, bool), String> {
        let mut rows = Vec::new();
        let mut height: Option<u64> = None;
        let mut page_size: Option<usize> = None;
        let mut page = 1u32;
        loop {
            let (items, h, _) = self
                .list_page_with_meta(&format!("{path_base}/page/{page}"), limit)
                .await
                .map_err(|e| format!("{path_base} page {page}: {e}"))?;
            if let Some(h) = h {
                height = Some(height.map_or(h, |x| x.max(h)));
            }
            let n = items.len();
            rows.extend(items);
            let first = *page_size.get_or_insert(n);
            if !page_walk_continues(first, n) {
                return Ok((rows, height, true));
            }
            if page >= max_pages {
                return Ok((rows, height, false));
            }
            page += 1;
        }
    }

    /// Low-level GET returning the whole validated envelope (for callers
    /// that need `meta`), same error handling as `get`. Also the raw probe
    /// behind `structs_intel query {guild_path}`.
    pub(crate) async fn get_envelope(&self, path: &str) -> Result<Value, String> {
        match self.get_envelope_once(path).await {
            Err(e) if Self::is_auth_error(&e) => {
                if crate::mcp::guild_auth::recover(self).await {
                    self.get_envelope_once(path).await
                } else {
                    Err(e)
                }
            }
            other => other,
        }
    }

    async fn get_envelope_once(&self, path: &str) -> Result<Value, String> {
        note_request();
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
        let env: Value = serde_json::from_str(&body)
            .map_err(|e| format!("Guild API JSON parse error: {} (body: {})", e, body))?;
        let ok = env.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
        let errors = env.get("errors").cloned().unwrap_or(Value::Null);
        if !ok || !errors_empty(&errors) {
            if errors.get("authentication_error").is_some() {
                return Err("Guild API requires login — sign in via the Structs app first".into());
            }
            return Err(format!("Guild API returned errors: {}", serde_json::to_string(&errors).unwrap_or_default()));
        }
        Ok(env)
    }

    /// The indexer's current height (`GET /api/block`: `height`, with
    /// `tip_height` / `lag_blocks` beside it). Used to stamp a guild-fed
    /// snapshot, since the catalog lists carry no `meta.height`.
    pub async fn indexer_height(&self) -> Result<u64, String> {
        let v = self.get("/api/block").await?;
        let row = if v.is_array() { v.get(0).cloned().unwrap_or(Value::Null) } else { v };
        ["height", "tip_height"]
            .iter()
            .find_map(|k| row.get(*k).and_then(|h| h.as_u64().or_else(|| h.as_str().and_then(|s| s.parse().ok()))))
            .ok_or_else(|| "block: no height in response".to_string())
    }

    // -- single-entity reads (the pre-sign verify source, see mcp/verify.rs) --
    /// One struct row: `id, type, owner, location_type, location_id,
    /// operating_ambit, slot, is_destroyed, health, status(bit-flags),
    /// defending_struct_ids`. `data` is null for an unknown id.
    pub async fn struct_by_id(&self, struct_id: &str) -> Result<Value, String> {
        let v = self.get(&format!("/api/struct/{}", struct_id)).await?;
        if v.is_null() {
            return Err(format!("Guild API has no struct {struct_id}"));
        }
        Ok(v)
    }
    /// One planet row: `id, owner, name, *_slots, undiscovered_ore, …`.
    pub async fn planet_by_id(&self, planet_id: &str) -> Result<Value, String> {
        let v = self.get(&format!("/api/planet/{}", planet_id)).await?;
        if v.is_null() {
            return Err(format!("Guild API has no planet {planet_id}"));
        }
        Ok(v)
    }
    /// One player row (flat snake_case SQL columns): `planet_id, fleet_id,
    /// ore, alpha, …` plus an embedded `fleet` row.
    pub async fn player_by_id(&self, player_id: &str) -> Result<Value, String> {
        let v = self.get(&format!("/api/player/{}", player_id)).await?;
        if v.is_null() {
            return Err(format!("Guild API has no player {player_id}"));
        }
        Ok(v)
    }

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

    /* -- player profile reads --
     *
     * The four the webapp's own Account → Profile screen makes, so a profile
     * we draw for somebody ELSE reports the same figures theirs would
     * (`AccountProfileViewModel.fetchPageData`). Kept as separate calls rather
     * than folded into one because that is what the API offers; the caller
     * runs them concurrently.
     */
    pub async fn player_ore_stats(&self, player_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/player/{}/ore/stats", player_id)).await
    }
    pub async fn player_planets_completed(&self, player_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/player/{}/planet/completed", player_id))
            .await
    }
    pub async fn player_raids_launched(&self, player_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/player/{}/raid/launched", player_id))
            .await
    }

    /* -- the stat store (`/api/stat/...`) --
     *
     * The guild indexes a TIME SERIES per object, not just the current value:
     * ten metrics, sampled whenever the value moves. Two shapes — the
     * galaxy-wide roll-up (`stat_aggregate`, below, which Game Stats has read
     * since it was written) and this one, ONE object's own samples,
     * `[{time, value}]`.
     *
     * `object_key` is the chain id itself (`1-194`, `2-29604`, `4-1`): the
     * prefix is what tells the API which store to read.
     *
     * Windows are capped SERVER-side and differently per shape — 7 days of raw
     * samples, 30 days once a bucket is named — so the caller picks the bucket
     * from the window it wants rather than discovering the cap as a 400.
     *
     * Samples are change-triggered: a flat stretch means nothing moved, never
     * that nothing was recorded, so a reader carries the last value forward
     * rather than drawing a gap or a zero.
     */
    pub const STAT_MAX_RAW_SECONDS: u64 = 604_800;
    pub const STAT_MAX_BUCKET_SECONDS: u64 = 2_592_000;

    pub async fn stat_range(
        &self,
        metric: &str,
        object_key: &str,
        start_s: u64,
        end_s: u64,
        bucket: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let mut path = format!(
            "/api/stat/{}/object/{}/range/page/1?start_time={}&end_time={}&limit={}",
            metric, object_key, start_s, end_s, limit
        );
        if let Some(b) = bucket {
            path.push_str(&format!("&bucket={}", b));
        }
        match self.get(&path).await? {
            Value::Array(a) => Ok(a),
            Value::Null => Ok(vec![]),
            other => Err(format!("stat {metric}: expected a list, got {other}")),
        }
    }

    /* Find a player by id, name or address.
     *
     * The endpoint is named for the screen that first needed it — picking who
     * to pay — but what it answers is "which players match this string", which
     * is also what a lookup needs. Reusing it means one search behaviour in
     * the app rather than two that disagree about what matches.
     *
     * The string is URL-encoded here: a name may contain a space or an `&`,
     * and a raw one would silently truncate the query at the first separator.
     */
    pub async fn player_search(&self, q: &str, guild_id: Option<&str>) -> Result<Value, String> {
        let mut path = format!("/api/player/transfer/search?search_string={}", query_esc(q));
        if let Some(g) = guild_id.filter(|g| !g.is_empty()) {
            path.push_str(&format!("&guild_id={}", query_esc(g)));
        }
        self.get(&path).await
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
    /// One grid attribute type across every object, `?limit=` rows a page
    /// (rows: `object_id`, `object_type`, `val`). The batch source for the
    /// verify layer's `lastAction` (charge) and `ore` sweeps.
    pub async fn grid_by_attribute_type_limited(
        &self,
        attribute_type: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(
            &format!("/api/grid/attribute-type/{}/page/{}", attribute_type, page),
            page,
            limit,
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

    // ──────────────────────────────────────────────────────────────────────
    // Whole-game endpoints used by the Game Stats aggregator
    // (`crate::mcp::game_stats`). Same thin-wrapper style as everything
    // above; the aggregator owns pagination depth and cadence.
    // ──────────────────────────────────────────────────────────────────────

    /// Guilds with at least one member, pre-ranked `members DESC, alpha DESC`.
    /// Rows: `{guild_id, name, logo, alpha, members}` — numerics as strings.
    pub async fn guild_directory(&self) -> Result<Value, String> {
        self.get("/api/guild/directory").await
    }
    pub async fn guild_count(&self) -> Result<Value, String> {
        self.get("/api/guild/count").await
    }
    /// `{guild_id, total_fuel, total_load, total_capacity, avg_connection_capacity}`.
    /// One guild's record — its NAME and TAG, which the chain's player entity
    /// does not carry. A profile that can only say "0-1" is naming the row in
    /// a database rather than the guild the player belongs to.
    /// Every guild's bank: `{guild_id, denom, collateral, supply, ratio}` —
    /// collateral and supply are base-unit strings, ratio a number.
    pub async fn guild_bank(&self) -> Result<Value, String> {
        self.get("/api/guild-bank").await
    }
    /// Thirty days of a guild's token movements, bucketed by hour or day:
    /// `{bucket, action (minted|burned|infused|defusion_completed), denom, volume}`.
    pub async fn guild_bank_history(&self, guild_id: &str, hourly: bool) -> Result<Value, String> {
        self.get(&format!("/api/guild-bank/{}/history?bucket={}", guild_id, if hourly { "1h" } else { "1d" })).await
    }
    pub async fn guild_by_id(&self, guild_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/guild/{}", guild_id)).await
    }
    pub async fn guild_power_stats(&self, guild_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/guild/{}/power/stats", guild_id))
            .await
    }
    pub async fn guild_planet_complete_count(&self, guild_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/guild/{}/planet/complete/count", guild_id))
            .await
    }
    /// Members with identity: `{id, username, pfp, pfp_client_render_attributes,
    /// guild_name, tag, alpha}` — the only bulk source of usernames + alpha.
    pub async fn guild_roster(&self, guild_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/guild/{}/roster", guild_id)).await
    }
    pub async fn guild_list_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/guild/list/all/page/{}", page), page)
            .await
    }
    pub async fn player_list_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/player/list/all/page/{}", page), page)
            .await
    }
    pub async fn planet_list_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/planet/list/all/page/{}", page), page)
            .await
    }
    pub async fn fleet_list_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/fleet/list/all/page/{}", page), page)
            .await
    }
    pub async fn struct_list_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/struct/list/all/page/{}", page), page)
            .await
    }
    /// The full struct-type catalog (one page, ordered by id).
    pub async fn struct_type_catalog(&self) -> Result<Value, String> {
        self.get("/api/struct/type").await
    }
    /// All rows of the `setting` table (public route, no session needed).
    pub async fn settings(&self) -> Result<Value, String> {
        self.get("/api/setting").await
    }
    pub async fn work_all(&self, page: u32) -> Result<GuildPage<Value>, String> {
        self.get_page(&format!("/api/work/all/page/{}", page), page)
            .await
    }

    // ──────────────────────────────────────────────────────────────────────
    // PR #121 endpoints (the wishlist deliveries). Every caller must keep a
    // legacy fallback: guilds run different webapp versions, and an older
    // API answers these with a 404.
    // ──────────────────────────────────────────────────────────────────────

    /// `{height, tip_height, lag_blocks, status, updated_at}` — the indexer's
    /// block clock over HTTP (wishlist #2).
    pub async fn current_block(&self) -> Result<Value, String> {
        self.get("/api/block").await
    }
    /// Ranked rows from the server-side leaderboard tables (wishlist #1).
    /// kinds: player|guild|reactor|substation|provider; `order` must be on
    /// the server's allowlist; amounts arrive as `*_p` base-unit strings.
    pub async fn leaderboard(
        &self,
        kind: &str,
        order: Option<&str>,
        limit: u32,
    ) -> Result<Value, String> {
        let mut path = format!("/api/leaderboard/{}?limit={}", kind, limit);
        if let Some(o) = order {
            path.push_str(&format!("&order={}", o));
        }
        self.get(&path).await
    }
    /// One row of per-flag totals over view.struct_status (wishlist #5).
    pub async fn struct_status_counts(&self) -> Result<Value, String> {
        self.get("/api/struct/status/counts").await
    }
    pub async fn planet_count(&self) -> Result<Value, String> {
        self.get("/api/planet/count").await
    }
    pub async fn struct_count(&self, is_destroyed: Option<bool>) -> Result<Value, String> {
        match is_destroyed {
            Some(d) => {
                self.get(&format!("/api/struct/count?is_destroyed={}", if d { 1 } else { 0 }))
                    .await
            }
            None => self.get("/api/struct/count").await,
        }
    }
    pub async fn work_count(&self) -> Result<Value, String> {
        self.get("/api/work/count").await
    }
    pub async fn player_active_count(&self, window_blocks: u64) -> Result<Value, String> {
        self.get(&format!(
            "/api/player/active/count?window_blocks={}",
            window_blocks
        ))
        .await
    }
    /// Grid rows for one attribute filtered to one object type (wishlist #7)
    /// — the ore walk drops from 233 pages to ~24.
    pub async fn grid_by_attribute_and_object_type(
        &self,
        attribute_type: &str,
        object_type: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!(
                "/api/grid/attribute-type/{}/object-type/{}/page/{}",
                attribute_type, object_type, page
            ),
            page,
        )
        .await
    }
    /// Current raid rows by status (wishlist #3), ordered `updated_at DESC`.
    /// The table keeps stale non-terminal rows forever — callers filter by
    /// `updated_at` freshness, exactly as with the activity feed.
    pub async fn planet_raid_by_status(
        &self,
        status: &str,
        page: u32,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page(
            &format!("/api/planet-raid/status/{}/page/{}", status, page),
            page,
        )
        .await
    }
    /// GET a list endpoint at a caller-chosen page size (PR #121 `?limit=`,
    /// server-clamped at 1000). `has_more` keys off the REQUESTED size, so a
    /// 500-row final page under limit=1000 ends the walk without an extra
    /// empty fetch.
    async fn get_page_limited(
        &self,
        path: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let data = self.get(&format!("{}{}limit={}", path, sep, limit)).await?;
        let items = match data {
            Value::Array(arr) => arr,
            Value::Null => vec![],
            other => return Err(format!("expected array, got {}", other)),
        };
        let has_more = items.len() >= limit;
        Ok(GuildPage {
            items,
            page,
            has_more,
        })
    }
    /// Every holder of one denom, richest first: `{owner_type, owner_id,
    /// denom, balance}` — the whole galaxy's alpha in one or two pages.
    pub async fn inventory_by_denom(
        &self,
        denom: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(
            &format!("/api/inventory/denom/{}/page/{}", denom, page),
            page,
            limit,
        )
        .await
    }
    pub async fn player_list_by_guild_limited(
        &self,
        guild_id: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(
            &format!("/api/player/list/guild/{}/page/{}", guild_id, page),
            page,
            limit,
        )
        .await
    }
    pub async fn grid_by_attribute_and_object_type_limited(
        &self,
        attribute_type: &str,
        object_type: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(
            &format!(
                "/api/grid/attribute-type/{}/object-type/{}/page/{}",
                attribute_type, object_type, page
            ),
            page,
            limit,
        )
        .await
    }
    /// One struct attribute type across every struct, `?limit=` rows a page
    /// (rows: `object_id`, `val`). With the 10,000-row limit the whole
    /// galaxy's `status` is ~6 calls — the batch source for `verify::struct_state`.
    pub async fn struct_attribute_by_type_limited(
        &self,
        attribute_type: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(
            &format!("/api/struct-attribute/type/{}/page/{}", attribute_type, page),
            page,
            limit,
        )
        .await
    }

    pub async fn planet_attribute_by_type_limited(
        &self,
        attribute_type: &str,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(
            &format!("/api/planet-attribute/type/{}/page/{}", attribute_type, page),
            page,
            limit,
        )
        .await
    }

    /// Galaxy-wide LOCF-aligned totals per bucket (wishlist #11): rows carry
    /// a `bucket` timestamp and a running `sum` for every object of
    /// `object_type`, absent objects carried forward, never zero-filled.
    ///
    /// Since the 2026-09-15 cutover this reads `structs.stat_rollup`, an
    /// hourly snapshot the indexer writes at :02 past the hour, rather than a
    /// LOCF CTE over the raw samples. Same columns (`bucket, sum, avg,
    /// population, samples`), three differences a reader must expect:
    /// an hour with no rollup row is ABSENT (it used to be present with a
    /// null `sum`); the unfinished current hour is absent until the cron
    /// writes it, so the newest row is up to an hour old; and `object_type`
    /// is now required for every metric (the old query skipped it for the
    /// single-type metrics). `1d` rows are the LAST hourly rollup of each day
    /// with `samples` summed over the day.
    pub async fn stat_aggregate(
        &self,
        metric: &str,
        object_type: &str,
        bucket: &str,
        start: i64,
        end: i64,
    ) -> Result<Value, String> {
        self.get(&format!(
            "/api/stat/{}/aggregate/range?object_type={}&bucket={}&start_time={}&end_time={}",
            metric, object_type, bucket, start, end
        ))
        .await
    }
    // ── Filtered / sorted singles (TableReadManager list params) ──────────
    // The catalog list routes accept `limit` (≤1000), `include_total=1`
    // (adds `total` = count of the FILTERED set), `updated_since=<unix>`,
    // `is_destroyed=0|1` (struct lists) and `order=` (grid only,
    // allowlisted). Together they turn a table walk into one request; every
    // caller keeps the walk as its fallback because an older guild API
    // answers these with a 400/404.

    /// GET returning both `data` and the envelope's `total` (present only
    /// when the caller asked for `include_total=1`).
    async fn get_with_total(&self, path: &str) -> Result<(Value, Option<u64>), String> {
        note_request();
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
        let env: EnvelopeWithTotal = serde_json::from_str(&body)
            .map_err(|e| format!("Guild API JSON parse error: {} (body: {})", e, body))?;
        if !env.success || !errors_empty(&env.errors) {
            return Err(format!(
                "Guild API returned errors: {}",
                serde_json::to_string(&env.errors).unwrap_or_default()
            ));
        }
        let total = env.total.and_then(|t| {
            t.as_u64()
                .or_else(|| t.as_str().and_then(|s| s.trim().parse().ok()))
        });
        Ok((env.data, total))
    }

    /// The top `limit` grid rows for one attribute × object type, richest
    /// first — a leaderboard in one request instead of a 30-page walk.
    pub async fn grid_top(
        &self,
        attribute_type: &str,
        object_type: &str,
        limit: u32,
    ) -> Result<Vec<Value>, String> {
        let data = self
            .get(&format!(
                "/api/grid/attribute-type/{}/object-type/{}/page/1?order=val.desc&limit={}",
                attribute_type, object_type, limit
            ))
            .await?;
        match data {
            Value::Array(a) => Ok(a),
            Value::Null => Ok(vec![]),
            other => Err(format!("expected array, got {}", other)),
        }
    }

    /// How many structs were destroyed since `since_unix` (seconds): the
    /// filtered set's `total`, no rows. `Err` when the API predates
    /// `include_total`, so the caller can walk instead.
    pub async fn struct_destroyed_since_total(&self, since_unix: i64) -> Result<u64, String> {
        let (_, total) = self
            .get_with_total(&format!(
                "/api/struct/list/all/page/1?is_destroyed=1&updated_since={}&limit=1&include_total=1",
                since_unix
            ))
            .await?;
        total.ok_or_else(|| "include_total not honoured by this guild API".to_string())
    }

    /// Fleet list at a caller-chosen page size (≤1000).
    pub async fn fleet_list_all_limited(
        &self,
        page: u32,
        limit: usize,
    ) -> Result<GuildPage<Value>, String> {
        self.get_page_limited(&format!("/api/fleet/list/all/page/{}", page), page, limit)
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
    fn activity_filter_query_string_is_empty_by_default_and_joins_the_rest() {
        assert_eq!(ActivityFilter::default().query_string(), "");
        let f = ActivityFilter { category: Some("struct_attack".into()), role: Some("target".into()), since_height: Some(2_600_000) };
        assert_eq!(f.query_string(), "?category=struct_attack&role=target&since_height=2600000");
        // An empty string is "not asked", the same as None.
        let g = ActivityFilter { category: Some(String::new()), role: None, since_height: None };
        assert_eq!(g.query_string(), "");
    }

    #[test]
    fn since_height_is_applied_client_side_too() {
        // An older guild ignores the parameter and answers the whole feed;
        // the client pass makes both guilds answer the same rows.
        let rows = vec![
            json!({ "block_height": 10, "seq": 1 }),
            json!({ "block_height": "11", "seq": 2 }),
            json!({ "block_height": 12, "seq": 3 }),
            json!({ "seq": 4 }),
        ];
        let kept = apply_since_height(rows.clone(), Some(11));
        let seqs: Vec<u64> = kept.iter().map(|r| r["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, vec![3, 4], "strictly above the mark; an unreadable height is kept");
        assert_eq!(apply_since_height(rows, None).len(), 4);
    }

    #[test]
    fn role_probe_tells_a_new_guild_from_an_old_one() {
        // New server: 400 role_invalid → it WOULD honour a real role.
        let rejected: Result<Value, String> = Err("Guild API 400 https://x/api/planet-activity/player/1-61/page/1?limit=1&role=probe: {\"success\":false,\"errors\":{\"role_invalid\":\"role is not allowlisted\"}}".into());
        assert_eq!(classify_role_probe(&rejected), Ok(true));
        // Old server: the parameter is ignored and the page comes back.
        let ignored: Result<Value, String> = Ok(json!({ "success": true, "data": [] }));
        assert_eq!(classify_role_probe(&ignored), Ok(false));
        // Anything else is a real failure, not an answer.
        let down: Result<Value, String> = Err("Guild API HTTP error: connection refused".into());
        assert!(classify_role_probe(&down).is_err());
    }

    #[test]
    fn activity_role_and_category_lists_match_the_server_allowlists() {
        // TableReadManager::PLANET_ACTIVITY_PLAYER_ROLES / _CATEGORIES.
        assert_eq!(ACTIVITY_ROLES.len(), 7);
        assert_eq!(ACTIVITY_CATEGORIES.len(), 14);
        assert!(ACTIVITY_ROLES.contains(&"fleet_owner"));
        assert!(ACTIVITY_CATEGORIES.contains(&"block_raid_start"));
    }

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

/// Percent-encode one query-string VALUE.
///
/// A player's name is free text: a space, an `&` or a `#` in it would end the
/// value early and the server would search for the truncated half — quietly
/// returning the wrong players rather than failing. Every byte outside the
/// unreserved set goes through, so this is safe for names, ids and addresses
/// alike.
fn query_esc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

#[cfg(test)]
mod query_tests {
    use super::query_esc;

    #[test]
    fn a_name_cannot_break_out_of_its_parameter() {
        assert_eq!(query_esc("1-194"), "1-194");
        assert_eq!(query_esc("Slow Ninja"), "Slow%20Ninja");
        // The characters that would end the value or start another parameter.
        assert_eq!(query_esc("a&guild_id=0-5"), "a%26guild_id%3D0-5");
        assert_eq!(query_esc("a#b"), "a%23b");
        assert_eq!(query_esc("a?b"), "a%3Fb");
        // Unreserved characters are left alone, so ordinary queries stay legible.
        assert_eq!(query_esc("Mark_lifer.1~2"), "Mark_lifer.1~2");
        // Non-ASCII is encoded per byte, not dropped.
        assert_eq!(query_esc("\u{e9}"), "%C3%A9");
    }
}
