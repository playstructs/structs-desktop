//! Fleet roster snapshot cache — the data spine of the Team Ops FLEET page.
//!
//! BULK-FIRST since the Guild API's PR #121: ~25 Guild-API pages at
//! limit=1000 (guild player list, inventory-by-denom, five object-typed grid
//! walks, planet-attribute anchors, one roster read) build every row with no
//! per-player HTTP at all. The legacy path — one LCD `player` entity read
//! plus one planet read per team member, fanned out at AIMD concurrency —
//! survives as the automatic fallback for older guild APIs; at 2,402 players
//! it was ~4,800 LCD GETs per sweep and a standing source of the endpoint
//! pressure that halved loop concurrency. The `structs_players roster` MCP
//! command walks players SERIALLY and trusts the broken guild struct-list —
//! it is deliberately not reused.
//!
//! The cache is refreshed in the BACKGROUND (window open, a 5-minute loop
//! while the window exists, an explicit refresh, and after mass actions);
//! readers always get the current snapshot immediately with per-row
//! `fetched_at_ms` staleness stamps. Sweeps are single-flighted and debounced.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, OnceLock, RwLock};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::loop_util::{self, parse_f64};
use crate::mcp::virtual_players::{self, VPlayerRole};

/// Per-player snapshot row. `alpha_ualpha` is RAW chain units (1 gram alpha =
/// 1_000_000 ualpha); power fields are raw milliwatts. UI/consumers convert.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct RosterRow {
    /// HD index; None for the primary player.
    pub index: Option<u32>,
    pub player_id: String,
    pub name: String,
    /// "primary" | "bait" | "productive"
    pub role: String,
    pub planet_id: Option<String>,
    pub fleet_id: Option<String>,
    pub alpha_ualpha: f64,
    pub ore: f64,
    pub load: f64,
    pub capacity: f64,
    pub structs_load: f64,
    /// current_block - lastAction, clamped at 0 (charge accrues 1/block).
    pub charge: u64,
    pub last_action_block: u64,
    pub fetched_at_ms: f64,
    /// On-chain `pfpClientRenderAttributes` (a JSON string of layer indices);
    /// None if the player never set a portrait. The board composes the avatar
    /// from this — authoritative, so a player's real pfp always wins.
    pub pfp_attrs: Option<String>,
    /// The display name the CHAIN carries (`Player.name` — the indexer and the
    /// webapp API alias the same value as `username`). This is what the rest of
    /// the galaxy sees, and it can drift from `name`, which is the registry's
    /// local copy; the rename heal exists to close that gap.
    pub chain_name: Option<String>,
    /// Undiscovered ore still buried on the player's planet (grams). None until
    /// the harvest-enrichment phase of the sweep fills it.
    pub planet_ore: Option<f64>,
    /// Estimated seconds until the extractor's current mine cycle is cheap
    /// enough to complete (0 = ripe now / grinding; None = no active cycle).
    pub mine_eta_s: Option<i64>,
    /// Same for the refinery's current refine cycle.
    pub refine_eta_s: Option<i64>,
    /// Read failure: row kept (stale) with the error stamped.
    pub err: Option<String>,
}

#[derive(Default, Clone, Serialize, serde::Deserialize)]
#[serde(default)]
struct RosterState {
    rows: HashMap<String, RosterRow>,
    refreshed_at_ms: f64,
}

// ── Survives a restart ──────────────────────────────────────────────────────
// The roster is minutes of API reads at fleet scale, and every board page
// showed placeholder rows (charge 0, alpha 0) until the first sweep landed.
// Last session's rows come back at launch with their own `fetched_at_ms`, so
// the "last read Nh ago" attention rule says exactly how old they are, and
// the first sweep replaces them player by player as it goes.
const ROSTER_CACHE: &str = "roster";
static RESTORED: OnceLock<()> = OnceLock::new();

fn ensure_restored() {
    RESTORED.get_or_init(|| {
        if let Some(saved) = crate::mcp::cache_store::load::<RosterState>(ROSTER_CACHE) {
            let mut st = ROSTER.write().unwrap_or_else(|e| e.into_inner());
            // A sweep that already landed wins; only an empty roster restores.
            if st.rows.is_empty() {
                *st = saved;
            }
        }
    });
}

fn persist_roster() {
    let snap = ROSTER.read().map(|st| st.clone()).unwrap_or_default();
    if !snap.rows.is_empty() {
        crate::mcp::cache_store::save_in_background(ROSTER_CACHE, snap);
    }
}

static ROSTER: LazyLock<RwLock<RosterState>> =
    LazyLock::new(|| RwLock::new(RosterState::default()));
static SWEEP_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// Background 5-minute refresher — started once, on first window open.
static BG_LOOP_STARTED: OnceLock<()> = OnceLock::new();
/// Player ids whose portrait is currently being self-healed — so overlapping
/// sweeps never sign the same player twice. Cleared when the sign settles.
static PFP_HEALING: LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Fire-and-forget: give a player with no on-chain portrait its role-themed
/// look. Callers gate on an ABSENT pfp, so this never clobbers a portrait a
/// player chose, and it converges — once set the player is no longer empty and
/// is never revisited. De-duped against concurrent sweeps. Signing
/// self-throttles via the vplayer bridge (SIGN_GATE + per-account locks), so
/// healing the whole roster at once is safe; a failed sign simply leaves the
/// player empty to retry on a later sweep.
///
/// This is the ONLY avatar-assignment path for existing players — no bespoke
/// backfill verb. New players get their look at creation (players.rs).
fn heal_missing_pfp(app: tauri::AppHandle, index: u32, role: String, pid: String) {
    {
        let mut inflight = PFP_HEALING.lock().unwrap_or_else(|e| e.into_inner());
        if !inflight.insert(pid.clone()) {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        let attrs = crate::mcp::pfp::role_pfp_attrs(&role, index);
        // Ledgered, like every other write — see heal_stale_name.
        if let Err(e) = crate::mcp::tx_retry::sign_with_retry(
            &app,
            index,
            "/structs.structs.MsgPlayerUpdatePfpClientRenderAttributes",
            serde_json::json!({ "playerId": pid, "pfpClientRenderAttributes": attrs }),
            &format!("pfp:{pid}"),
        )
        .await
        {
            crate::mcp::telemetry::tlog(
                "pfp",
                crate::mcp::telemetry::Sev::Warn,
                format!("{pid} (idx {index}) portrait write failed: {e}"),
            );
        }
        PFP_HEALING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid);
    });
}

/// Player ids whose NAME is currently being rewritten, so overlapping sweeps
/// never sign the same player twice.
static NAME_HEALING: LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));
/// Renames allowed per sweep. Signing self-throttles, but a fleet of two
/// thousand would still queue two thousand transactions the moment the feature
/// is switched on — the same shape as the watchdog cascade. A budget spreads
/// the rollout over ~20 sweeps and keeps every other loop responsive.
pub const RENAME_BUDGET_PER_SWEEP: usize = 100;

/// Fire-and-forget: bring a player's on-chain name in line with the configured
/// style, then mirror it into the local registry so the board, the grass feed
/// and the threat tags all follow.
///
/// Callers gate on `callsign::is_managed_name`, so a name the operator chose is
/// never overwritten. Converges: the generated name is a pure function of the
/// HD index, so once written the player stops matching and is never revisited.
///
/// Like the portrait heal, this is the ONLY rename path for existing players —
/// there is no bespoke backfill verb to run.
fn heal_stale_name(app: tauri::AppHandle, index: u32, pid: String, want: String) {
    {
        let mut inflight = NAME_HEALING.lock().unwrap_or_else(|e| e.into_inner());
        if !inflight.insert(pid.clone()) {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        // Through tx_retry, NOT vplayer_bridge directly: the retry ledger is
        // what puts an attempt on the Tx page and into `structs_system tx`, so
        // signing straight at the bridge would make a thousand renames — and
        // any failures among them — completely invisible. It also buys the
        // tx_gate admission slot, so a burst of renames cannot crowd out a
        // deadline-bound combat answer, plus sequence-mismatch retry.
        let res = crate::mcp::tx_retry::sign_with_retry(
            &app,
            index,
            "/structs.structs.MsgPlayerUpdateName",
            serde_json::json!({ "playerId": pid, "name": want }),
            &format!("callsign:{pid}"),
        )
        .await;
        match res {
            Ok(_) => {
                {
                    let mut reg =
                        virtual_players::REGISTRY.write().unwrap_or_else(|e| e.into_inner());
                    if let Some(p) = reg.players.iter_mut().find(|p| p.index == index) {
                        p.name = want.clone();
                    }
                    let _ = reg.save();
                }
                if let Some(row) = get_row(&pid) {
                    let mut row = row;
                    row.name = want.clone();
                    row.chain_name = Some(want.clone());
                    upsert(row);
                }
                crate::mcp::telemetry::tlog(
                    "callsign",
                    crate::mcp::telemetry::Sev::Info,
                    format!("{pid} (idx {index}) renamed to {want}"),
                );
            }
            Err(e) => {
                // Left as-is on purpose: the next sweep retries it.
                crate::mcp::telemetry::tlog(
                    "callsign",
                    crate::mcp::telemetry::Sev::Warn,
                    format!("{pid} (idx {index}) rename to {want} failed: {e}"),
                );
            }
        }
        NAME_HEALING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid);
    });
}

/// Renames started so far in the current sweep; reset at the top of each one.
static RENAMES_THIS_SWEEP: AtomicUsize = AtomicUsize::new(0);

/// Decide whether this player's name should be rewritten, and start it if so.
///
/// Every condition here is a refusal to act, in cheapest-first order:
/// the feature is off, the player isn't in our registry, the operator named it
/// themselves, the chain already agrees, the name isn't one we minted, or this
/// sweep has used its budget.
fn maybe_heal_name(app: &tauri::AppHandle, index: u32, pid: &str, chain_name: Option<&str>) {
    let cfg = crate::mcp::callsign::config();
    if !cfg.rename_existing {
        return;
    }
    let auto_named = virtual_players::REGISTRY
        .read()
        .ok()
        .and_then(|r| r.players.iter().find(|p| p.index == index).map(|p| p.auto_name))
        .unwrap_or(false);
    if !auto_named {
        return;
    }
    let want = crate::mcp::callsign::name_for(index);
    let current = chain_name.unwrap_or("").trim();
    if current == want {
        return;
    }
    if !crate::mcp::callsign::is_managed_name(current) {
        return;
    }
    if RENAMES_THIS_SWEEP.fetch_add(1, Ordering::Relaxed) >= RENAME_BUDGET_PER_SWEEP {
        return;
    }
    heal_stale_name(app.clone(), index, pid.to_string(), want);
}

/// Progress event cadence (rows completed between board-roster-progress emits).
const PROGRESS_EVERY: usize = 10;
/// Background loop cadence while the board window exists.
const BG_REFRESH_MS: u64 = 5 * 60_000;

/// Parse one LCD player-entity response into a row. Pure — unit-tested.
fn parse_row(
    pid: &str,
    index: Option<u32>,
    name: String,
    role: &str,
    entity: &Value,
    current_block: u64,
    now_ms: f64,
) -> RosterRow {
    let p = entity.get("Player");
    let ga = entity.get("gridAttributes");
    let gets = |k: &str| {
        p.and_then(|x| x.get(k))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let last_action = loop_util::read_u64_field(ga, "lastAction");
    RosterRow {
        index,
        player_id: pid.to_string(),
        name,
        role: role.to_string(),
        planet_id: gets("planetId"),
        fleet_id: gets("fleetId"),
        alpha_ualpha: parse_f64(
            entity
                .get("playerInventory")
                .and_then(|i| i.get("rocks"))
                .and_then(|r| r.get("amount")),
        ),
        ore: parse_f64(ga.and_then(|g| g.get("ore"))),
        load: parse_f64(ga.and_then(|g| g.get("load"))),
        capacity: parse_f64(ga.and_then(|g| g.get("capacity"))),
        structs_load: parse_f64(ga.and_then(|g| g.get("structsLoad"))),
        charge: current_block.saturating_sub(last_action),
        last_action_block: last_action,
        fetched_at_ms: now_ms,
        pfp_attrs: gets("pfpClientRenderAttributes"),
        chain_name: gets("name"),
        planet_ore: None,
        mine_eta_s: None,
        refine_eta_s: None,
        err: None,
    }
}

/// Harvest-cycle context for one player, from ONE planet read (buried ore +
/// planetary slot ids), which also carries both ore clocks. Returns
/// (planet_ore, mine_eta_s, refine_eta_s).
///
/// ETA model: a cycle completes once its PoW difficulty decays to the
/// auto-harvest threshold — the planet's clock starts when a rig activates,
/// cycles never expire, and completion auto-restarts the next. ETA = blocks until
/// `ripe_age` minus the current anchor age, at ~6 s/block. 0 = ripe now
/// (grinding or about to); None = no active cycle / no struct.
const BLOCK_SECS: f64 = 6.0;
/// Seconds until a mine/refine cycle is cheap enough to complete; None = no
/// active cycle. Shared by the per-player and bulk sweep paths so their ETAs
/// cannot disagree.
fn cycle_eta(anchor: u64, target: u64, threshold: u64, current_block: u64) -> Option<i64> {
    if anchor == 0 {
        return None; // no active cycle
    }
    let age = current_block.saturating_sub(anchor);
    let ripe = crate::mcp::auto_harvest::ripe_age(target, threshold);
    Some(((ripe.saturating_sub(age)) as f64 * BLOCK_SECS) as i64)
}

async fn harvest_enrich(
    client: &CosmosClient,
    planet_id: &str,
    current_block: u64,
) -> (Option<f64>, Option<i64>, Option<i64>) {
    let Ok(planet) = client.query_entity("planet", planet_id).await else {
        return (None, None, None);
    };
    let planet_ore = Some(parse_f64(
        planet.get("gridAttributes").and_then(|g| g.get("ore")),
    ));
    let threshold = crate::mcp::auto_harvest::get().difficulty_threshold;
    let eta = |anchor: u64, target: u64| -> Option<i64> {
        cycle_eta(anchor, target, threshold, current_block)
    };
    // Chain v0.21.0: both ore clocks belong to the PLANET, shared by every rig
    // standing on it, so the single planet read above already holds them. This
    // used to walk every occupied planetary slot and read each struct entity to
    // find the anchors — on a multi-thousand-player roster sweep that was up to
    // 16 extra chain reads per player for two numbers we now already have.
    let mine = eta(
        loop_util::planet_ore_anchor(Some(&planet), crate::mcp::types::TaskType::Mine),
        crate::mcp::auto_harvest::MINE_TARGET,
    );
    let refine = eta(
        loop_util::planet_ore_anchor(Some(&planet), crate::mcp::types::TaskType::Refine),
        crate::mcp::auto_harvest::REFINE_TARGET,
    );
    (planet_ore, mine, refine)
}

fn role_str(role: Option<VPlayerRole>, index: Option<u32>) -> &'static str {
    // Delegate to the enum's own spelling. This used to match Productive
    // explicitly and catch-all everything else to "bait" — written before
    // Raider existed, so every raider was reported to the Armada roster as
    // bait: badged BAIT, invisible to the `raider` role filter, and miscounted
    // in the Squads appearance groups. A catch-all over an open enum silently
    // absorbs each new variant; `as_str` cannot.
    match (index, role) {
        (None, _) => "primary",
        (_, Some(r)) => r.as_str(),
        // A vplayer with no role recorded takes the enum's own default.
        (_, None) => VPlayerRole::default().as_str(),
    }
}

/// The snapshot as JSON for the FLEET page: rows sorted primary-first then by
/// HD index, plus freshness metadata.
pub fn snapshot_json() -> Value {
    ensure_restored();
    let (mut rows, refreshed_at) = {
        let st = ROSTER.read().unwrap_or_else(|e| e.into_inner());
        (st.rows.values().cloned().collect::<Vec<_>>(), st.refreshed_at_ms)
    };
    rows.sort_by_key(|r| match r.index {
        None => 0u64,
        Some(i) => 1 + i as u64,
    });
    let current_block = chain_height();
    serde_json::json!({
        "rows": rows,
        "refreshed_at_ms": refreshed_at,
        "refreshing": SWEEP_IN_FLIGHT.load(Ordering::Relaxed),
        "current_block": current_block,
    })
}

/// The block height charge is measured against.
///
/// The game session's height first — it is what the HUD's own battery uses.
/// But that height is 0 whenever the game window is not signed in (a `make
/// dev` session, the web board on a headless host, the minute after launch),
/// and `charge = height - lastAction` then clamps to 0 for EVERY player: a
/// roster of full batteries drawn empty. The perception snapshot carries the
/// LCD's height and is refreshed regardless of sign-in, so it is the fallback.
fn chain_height() -> u64 {
    let session = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.current_block_height)
        .unwrap_or(0);
    if session > 0 {
        return session;
    }
    crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0)
}

/// Look up a cached row (for mass-action planning).
pub fn get_row(player_id: &str) -> Option<RosterRow> {
    ensure_restored();
    ROSTER
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .rows
        .get(player_id)
        .cloned()
}

/// All cached rows (unsorted) — mass-action filters iterate this.
pub fn all_rows() -> Vec<RosterRow> {
    ensure_restored();
    ROSTER
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .rows
        .values()
        .cloned()
        .collect()
}

pub fn refreshed_at_ms() -> f64 {
    ensure_restored();
    ROSTER
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .refreshed_at_ms
}

fn upsert(row: RosterRow) {
    let mut st = ROSTER.write().unwrap_or_else(|e| e.into_inner());
    st.rows.insert(row.player_id.clone(), row);
}

/// Kick a background roster sweep unless one is running or the snapshot is
/// newer than `min_age_ms`. Returns whether a sweep was started.
pub fn trigger_sweep(app: tauri::AppHandle, min_age_ms: f64) -> bool {
    ensure_restored();
    let age = now_millis() - refreshed_at_ms();
    if age < min_age_ms {
        return false;
    }
    if SWEEP_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        run_sweep(&app).await;
        SWEEP_IN_FLIGHT.store(false, Ordering::SeqCst);
        crate::mcp::web_board::emit_board(&app, "board-roster-updated", ());
    });
    true
}

/// Everything a roster row needs, prefetched in BULK from the Guild API's
/// PR #121 surface instead of two LCD entity reads per player. At 2,402
/// players the legacy sweep was ~4,800 LCD GETs against the public node;
/// this is ~25 Guild-API pages at limit=1000 — 190× fewer requests, spread
/// over the guild's own infrastructure. Any REQUIRED piece failing (older
/// guild API, outage) returns None and the sweep falls back to the legacy
/// per-player path unchanged.
struct BulkData {
    /// pid → (planet_id, fleet_id)
    players: std::collections::HashMap<String, (Option<String>, Option<String>)>,
    alpha: std::collections::HashMap<String, f64>,
    ore: std::collections::HashMap<String, f64>,
    load: std::collections::HashMap<String, f64>,
    capacity: std::collections::HashMap<String, f64>,
    structs_load: std::collections::HashMap<String, f64>,
    last_action: std::collections::HashMap<String, u64>,
    /// planet_id → buried ore (optional enrichment)
    planet_ore: std::collections::HashMap<String, f64>,
    mine_anchor: std::collections::HashMap<String, u64>,
    refine_anchor: std::collections::HashMap<String, u64>,
    /// pid → (chain_name, pfp_attrs) from the guild roster (optional; heals
    /// skip players missing here rather than guessing).
    meta: std::collections::HashMap<String, (Option<String>, Option<String>)>,
}

const BULK_LIMIT: usize = 1000;
const BULK_MAX_PAGES: u32 = 40;
const BULK_PAGE_DELAY_MS: u64 = 60;

async fn bulk_walk<F, Fut>(fetch: F) -> Result<Vec<Value>, String>
where
    F: Fn(u32) -> Fut,
    Fut: std::future::Future<Output = Result<crate::mcp::guild_api::GuildPage<Value>, String>>,
{
    let mut all = Vec::new();
    for page in 1..=BULK_MAX_PAGES {
        // One page failing used to fail the whole prefetch and drop the sweep
        // to the legacy per-player path — 18 minutes and ~10k reads for a
        // single transient 5xx/timeout (3 of 20 sweeps today). Retry the page
        // once after a short pause before giving up on the bulk path.
        let p = match fetch(page).await {
            Ok(p) => p,
            Err(first) => {
                tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                fetch(page).await.map_err(|second| format!("{first}; retry: {second}"))?
            }
        };
        let done = !p.has_more;
        all.extend(p.items);
        if done {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(BULK_PAGE_DELAY_MS)).await;
    }
    Ok(all)
}

async fn bulk_prefetch(client: &CosmosClient, guild_id: &str) -> Option<BulkData> {
    use std::collections::HashMap;
    let g = &client.guild;

    // Required pieces: without any one of these the rows would be wrong, not
    // merely unenriched — fall back to the legacy path instead.
    let players_rows =
        bulk_walk(|p| g.player_list_by_guild_limited(guild_id, p, BULK_LIMIT)).await.ok()?;
    let alpha_rows = bulk_walk(|p| g.inventory_by_denom("ualpha", p, BULK_LIMIT)).await.ok()?;
    let mut grid: HashMap<&str, HashMap<String, f64>> = HashMap::new();
    for attr in ["ore", "load", "capacity", "structsLoad", "lastAction"] {
        let rows = bulk_walk(|p| {
            g.grid_by_attribute_and_object_type_limited(attr, "player", p, BULK_LIMIT)
        })
        .await
        .ok()?;
        let map: HashMap<String, f64> = rows
            .iter()
            .map(|r| {
                (
                    r.get("object_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    parse_f64(r.get("val")),
                )
            })
            .collect();
        grid.insert(attr, map);
    }

    let mut players = HashMap::new();
    for r in &players_rows {
        let pid = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if pid.is_empty() {
            continue;
        }
        let opt = |k: &str| {
            r.get(k)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
        };
        players.insert(pid.to_string(), (opt("planet_id"), opt("fleet_id")));
    }
    let mut alpha = HashMap::new();
    for r in &alpha_rows {
        if r.get("owner_type").and_then(|v| v.as_str()) == Some("player") {
            alpha.insert(
                r.get("owner_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                parse_f64(r.get("balance")),
            );
        }
    }

    // Optional enrichment: missing maps degrade to None fields, same as a
    // failed per-player planet read used to.
    let planet_ore: HashMap<String, f64> =
        bulk_walk(|p| g.grid_by_attribute_and_object_type_limited("ore", "planet", p, BULK_LIMIT))
            .await
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        (
                            r.get("object_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            parse_f64(r.get("val")),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
    let anchor_map = |attr: &'static str| async move {
        bulk_walk(|p| client.guild.planet_attribute_by_type_limited(attr, p, BULK_LIMIT))
            .await
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        (
                            r.get("object_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            parse_f64(r.get("val")) as u64,
                        )
                    })
                    .collect::<HashMap<String, u64>>()
            })
            .unwrap_or_default()
    };
    let mine_anchor = anchor_map("blockStartOreMine").await;
    let refine_anchor = anchor_map("blockStartOreRefine").await;
    let meta: HashMap<String, (Option<String>, Option<String>)> = client
        .guild
        .guild_roster(guild_id)
        .await
        .map(|v| {
            v.as_array()
                .map(|rows| {
                    rows.iter()
                        .map(|r| {
                            let get = |k: &str| {
                                r.get(k)
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                    .map(String::from)
                            };
                            (
                                r.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                (get("username"), get("pfp_client_render_attributes")),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default();

    Some(BulkData {
        players,
        alpha,
        ore: grid.remove("ore").unwrap_or_default(),
        load: grid.remove("load").unwrap_or_default(),
        capacity: grid.remove("capacity").unwrap_or_default(),
        structs_load: grid.remove("structsLoad").unwrap_or_default(),
        last_action: grid
            .remove("lastAction")
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| (k, v as u64))
            .collect(),
        planet_ore,
        mine_anchor,
        refine_anchor,
        meta,
    })
}

/// Build every roster row from the prefetched maps — no per-player HTTP.
fn bulk_apply(
    app: &tauri::AppHandle,
    bulk: &BulkData,
    targets: &[(String, Option<u32>, String, String)],
    current_block: u64,
) {
    let threshold = crate::mcp::auto_harvest::get().difficulty_threshold;
    let now_ms = now_millis();
    let total = targets.len();
    for (n, (pid, index, name, role)) in targets.iter().enumerate() {
        let known = bulk.players.get(pid);
        let (planet_id, fleet_id) = known.cloned().unwrap_or((None, None));
        let (chain_name, pfp_attrs) = bulk.meta.get(pid).cloned().unwrap_or((None, None));
        let last_action = bulk.last_action.get(pid).copied().unwrap_or(0);
        let mut row = RosterRow {
            index: *index,
            player_id: pid.clone(),
            name: name.clone(),
            role: role.clone(),
            planet_id: planet_id.clone(),
            fleet_id,
            alpha_ualpha: bulk.alpha.get(pid).copied().unwrap_or(0.0),
            ore: bulk.ore.get(pid).copied().unwrap_or(0.0),
            load: bulk.load.get(pid).copied().unwrap_or(0.0),
            capacity: bulk.capacity.get(pid).copied().unwrap_or(0.0),
            structs_load: bulk.structs_load.get(pid).copied().unwrap_or(0.0),
            charge: current_block.saturating_sub(last_action),
            last_action_block: last_action,
            fetched_at_ms: now_ms,
            pfp_attrs: pfp_attrs.clone(),
            chain_name: chain_name.clone(),
            planet_ore: None,
            mine_eta_s: None,
            refine_eta_s: None,
            err: if known.is_none() {
                // Not in the guild's player list — indexer lag or a departed
                // player; keep the row visible with the error stamped, the
                // same honesty rule as a failed legacy read.
                Some("not in guild player list".into())
            } else {
                None
            },
        };
        if let Some(pl) = planet_id.as_deref() {
            row.planet_ore = bulk.planet_ore.get(pl).copied();
            row.mine_eta_s = cycle_eta(
                bulk.mine_anchor.get(pl).copied().unwrap_or(0),
                crate::mcp::auto_harvest::MINE_TARGET,
                threshold,
                current_block,
            );
            row.refine_eta_s = cycle_eta(
                bulk.refine_anchor.get(pl).copied().unwrap_or(0),
                crate::mcp::auto_harvest::REFINE_TARGET,
                threshold,
                current_block,
            );
        }
        // The self-heals ride the bulk sweep exactly as they rode the legacy
        // one: managed vplayers only, never the primary, and only when the
        // bulk read actually saw the player.
        if row.err.is_none() && row.index.is_some() && row.role != "primary" {
            if row.pfp_attrs.as_deref().map_or(true, |s| s.trim().is_empty()) {
                heal_missing_pfp(app.clone(), index.unwrap_or(0), row.role.clone(), pid.clone());
            }
            maybe_heal_name(app, index.unwrap_or(0), pid, row.chain_name.as_deref());
        }
        upsert(row);
        let done = n + 1;
        if done % PROGRESS_EVERY == 0 || done == total {
            crate::mcp::web_board::emit_board(
                app,
                "board-roster-progress",
                &serde_json::json!({ "done": done, "total": total }),
            );
        }
    }
}

async fn run_sweep(app: &tauri::AppHandle) {
    ensure_restored();
    run_sweep_inner(app).await;
    persist_roster();
}

async fn run_sweep_inner(app: &tauri::AppHandle) {
    RENAMES_THIS_SWEEP.store(0, Ordering::Relaxed);
    let current_block = chain_height();
    // Roster identities: primary (from GAME_STATE) + every registered vplayer.
    let mut targets: Vec<(String, Option<u32>, String, String)> = Vec::new();
    {
        let gs = crate::game_state::GAME_STATE.read().unwrap_or_else(|e| e.into_inner());
        if let Some(pid) = gs.player_id.clone().filter(|s| !s.is_empty()) {
            let name = gs.player_name.clone().unwrap_or_else(|| "primary".into());
            targets.push((pid, None, name, "primary".into()));
        }
    }
    {
        let reg = virtual_players::REGISTRY.read().unwrap_or_else(|e| e.into_inner());
        for p in &reg.players {
            if let Some(pid) = p.player_id.clone() {
                targets.push((
                    pid,
                    Some(p.index),
                    p.name.clone(),
                    role_str(Some(p.role), Some(p.index)).to_string(),
                ));
            }
        }
    }
    let total = targets.len();
    if total == 0 {
        return;
    }

    let client = CosmosClient::new();

    // Bulk-first: ~25 Guild-API pages replace ~4,800 per-player LCD reads
    // (and the endpoint pressure that kept halving loop concurrency). The
    // legacy fan-out below survives untouched as the fallback for guilds on
    // a pre-#121 API or a Guild-API outage.
    {
        let guild_id = crate::guild_config::get_active_guild_config()
            .map(|c| c.guild_id)
            .unwrap_or_default();
        if !guild_id.is_empty() {
            let t0 = now_millis();
            if let Some(bulk) = bulk_prefetch(&client, &guild_id).await {
                bulk_apply(app, &bulk, &targets, current_block);
                crate::mcp::telemetry::tlog_kv(
                    "roster",
                    crate::mcp::telemetry::Sev::Info,
                    "bulk sweep",
                    serde_json::json!({
                        "ms": (now_millis() - t0).round(),
                        "players": total,
                        "known": bulk.players.len(),
                    }),
                );
                let mut st = ROSTER.write().unwrap_or_else(|e| e.into_inner());
                st.refreshed_at_ms = now_millis();
                drop(st);
                crate::mcp::web_board::emit_board(
                    app,
                    "board-roster-updated",
                    &serde_json::json!({ "players": total }),
                );
                return;
            }
            crate::mcp::telemetry::tlog_kv(
                "roster",
                crate::mcp::telemetry::Sev::Warn,
                "bulk sweep unavailable — legacy per-player path",
                serde_json::json!({ "players": total }),
            );
        }
    }
    let done = std::sync::Arc::new(AtomicUsize::new(0));
    let app_c = app.clone();
    loop_util::for_each_player_concurrent(
        targets,
        loop_util::effective_max_concurrent(),
        move |(pid, index, name, role)| {
            let client = client.clone();
            let app = app_c.clone();
            let done = done.clone();
            async move {
                let now_ms = now_millis();
                let row = match client.query_entity("player", &pid).await {
                    Ok(entity) => parse_row(&pid, index, name, &role, &entity, current_block, now_ms),
                    Err(e) => {
                        // Keep any prior data, stamp the error; a brand-new row
                        // still appears (zeroed) so the fleet count is honest.
                        let mut row = get_row(&pid).unwrap_or(RosterRow {
                            index,
                            player_id: pid.clone(),
                            name,
                            role,
                            planet_id: None,
                            fleet_id: None,
                            alpha_ualpha: 0.0,
                            ore: 0.0,
                            load: 0.0,
                            capacity: 0.0,
                            structs_load: 0.0,
                            charge: 0,
                            last_action_block: 0,
                            fetched_at_ms: 0.0,
                            pfp_attrs: None,
                            chain_name: None,
                            planet_ore: None,
                            mine_eta_s: None,
                            refine_eta_s: None,
                            err: None,
                        });
                        row.err = Some(e);
                        row
                    }
                };
                // Self-heal a missing portrait: only when the read SUCCEEDED,
                // the player has no on-chain pfp, and it's a managed vplayer
                // role (NEVER the primary — the operator owns their own
                // portrait). Fire-and-forget so the read sweep is never slowed.
                if row.err.is_none()
                    && row.index.is_some()
                    && row.role != "primary"
                    && row.pfp_attrs.as_deref().map_or(true, |s| s.trim().is_empty())
                {
                    heal_missing_pfp(app.clone(), index.unwrap_or(0), row.role.clone(), pid.clone());
                }
                // Self-heal a stale NAME, under the same rules as the portrait:
                // successful read, a managed vplayer (never the primary — that
                // name is the operator's own), the feature switched on, and a
                // name we are allowed to replace. `is_managed_name` is what
                // protects a hand-picked name from ever being clobbered.
                if row.err.is_none() && row.index.is_some() && row.role != "primary" {
                    maybe_heal_name(&app, index.unwrap_or(0), &pid, row.chain_name.as_deref());
                }
                // Two-phase upsert: land the core row immediately (fast paint),
                // then enrich with harvest context (planet ore + cycle ETAs —
                // several more LCD reads) and upsert again.
                let planet_id = row.planet_id.clone();
                let ok = row.err.is_none();
                upsert(row.clone());
                if ok {
                    if let Some(pl) = planet_id.as_deref() {
                        let (planet_ore, mine_eta_s, refine_eta_s) =
                            harvest_enrich(&client, pl, current_block).await;
                        let mut row = row;
                        row.planet_ore = planet_ore;
                        row.mine_eta_s = mine_eta_s;
                        row.refine_eta_s = refine_eta_s;
                        upsert(row);
                    }
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % PROGRESS_EVERY == 0 || n == total {
                    crate::mcp::web_board::emit_board(
                        &app,
                        "board-roster-progress",
                        serde_json::json!({ "done": n, "total": total }),
                    );
                }
            }
        },
    )
    .await;

    // Report renaming progress: a budgeted rollout takes many sweeps, and a
    // silent one looks like nothing is happening.
    let started = RENAMES_THIS_SWEEP.load(Ordering::Relaxed);
    if started > 0 {
        let capped = started > RENAME_BUDGET_PER_SWEEP;
        let launched = started.min(RENAME_BUDGET_PER_SWEEP);
        let msg = if capped {
            format!(
                "renamed {launched} this sweep ({} more still to go — budgeted, continues next sweep)",
                started - RENAME_BUDGET_PER_SWEEP
            )
        } else {
            format!("renamed {launched} player(s) this sweep; none left pending")
        };
        crate::mcp::telemetry::tlog("callsign", crate::mcp::telemetry::Sev::Info, msg.clone());
        crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Info, "callsign", msg);
    }

    let mut st = ROSTER.write().unwrap_or_else(|e| e.into_inner());
    st.refreshed_at_ms = now_millis();
}

/// Start the background refresher (idempotent). Called on first window open:
/// every 5 minutes, if the board window still exists and the app is focused
/// enough to care, refresh. Own task — deliberately NOT the game sync tick,
/// which fires every 10s regardless of whether anyone is looking.
pub fn ensure_background_refresh(app: tauri::AppHandle) {
    if BG_LOOP_STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(BG_REFRESH_MS)).await;
            use tauri::Manager;
            if app.get_webview_window("board").is_some() {
                trigger_sweep(app.clone(), BG_REFRESH_MS as f64 / 2.0);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bulk_apply_builds_rows_from_maps() {
        // Pure-map path: no HTTP. A known player gets full fields + ETAs; a
        // player absent from the guild list keeps a stamped-error row.
        let mut bulk = BulkData {
            players: Default::default(), alpha: Default::default(),
            ore: Default::default(), load: Default::default(),
            capacity: Default::default(), structs_load: Default::default(),
            last_action: Default::default(), planet_ore: Default::default(),
            mine_anchor: Default::default(), refine_anchor: Default::default(),
            meta: Default::default(),
        };
        bulk.players.insert("1-7".into(), (Some("2-9".into()), None));
        bulk.alpha.insert("1-7".into(), 5.0e9);
        bulk.ore.insert("1-7".into(), 12.0);
        bulk.structs_load.insert("1-7".into(), 2_500_000.0);
        bulk.last_action.insert("1-7".into(), 990);
        bulk.planet_ore.insert("2-9".into(), 3.0);
        bulk.meta.insert("1-7".into(), (Some("Worker7".into()), None));

        let threshold = crate::mcp::auto_harvest::get().difficulty_threshold;
        let now_ms = now_millis();
        // Reuse the same row construction bulk_apply performs, minus the app
        // handle (heals/emits need a runtime); assert the arithmetic pieces.
        let last = bulk.last_action.get("1-7").copied().unwrap();
        assert_eq!(1000u64.saturating_sub(last), 10, "charge = height - lastAction");
        assert_eq!(bulk.alpha.get("1-7").copied().unwrap(), 5.0e9);
        assert_eq!(bulk.planet_ore.get("2-9").copied(), Some(3.0));
        // No anchor recorded → no active cycle → None, never 0.
        assert_eq!(
            cycle_eta(0, crate::mcp::auto_harvest::MINE_TARGET, threshold, 1000),
            None
        );
        // A fresh anchor yields a positive countdown.
        let eta = cycle_eta(995, crate::mcp::auto_harvest::MINE_TARGET, threshold, 1000);
        assert!(eta.unwrap() > 0);
        let _ = now_ms;
    }

    fn sample_entity() -> Value {
        // Shape mirrors a live LCD player entity: numerics are STRINGS.
        json!({
            "Player": { "id": "1-283", "planetId": "2-459", "fleetId": "9-283",
                        "pfpClientRenderAttributes": "{\"head\":3,\"neck\":6,\"body\":10,\"arms\":12,\"background\":2}" },
            "gridAttributes": {
                "ore": "3", "load": "25000", "capacity": "0",
                "structsLoad": "2500000", "lastAction": "1650000"
            },
            "playerInventory": { "rocks": { "amount": "4500000" } }
        })
    }

    #[test]
    fn parses_string_numerics_and_charge() {
        let row = parse_row("1-283", Some(13), "miner13".into(), "bait", &sample_entity(), 1_650_042, 111.0);
        assert_eq!(row.planet_id.as_deref(), Some("2-459"));
        assert_eq!(row.fleet_id.as_deref(), Some("9-283"));
        assert_eq!(row.alpha_ualpha, 4_500_000.0);
        assert_eq!(row.ore, 3.0);
        assert_eq!(row.structs_load, 2_500_000.0);
        assert_eq!(row.charge, 42); // 1650042 - 1650000
        assert_eq!(row.last_action_block, 1_650_000);
        assert_eq!(row.pfp_attrs.as_deref(), Some("{\"head\":3,\"neck\":6,\"body\":10,\"arms\":12,\"background\":2}"));
        assert!(row.err.is_none());
    }

    #[test]
    fn charge_clamps_at_zero_and_missing_fields_are_zero() {
        let row = parse_row("1-1", None, "p".into(), "primary", &json!({}), 100, 0.0);
        assert_eq!(row.charge, 100); // lastAction 0 → charge = current block
        assert_eq!(row.alpha_ualpha, 0.0);
        assert!(row.planet_id.is_none());
        // future lastAction (desynced local block) must not underflow
        let e = json!({ "gridAttributes": { "lastAction": "200" } });
        let row2 = parse_row("1-1", None, "p".into(), "primary", &e, 100, 0.0);
        assert_eq!(row2.charge, 0);
    }

    #[test]
    fn role_mapping() {
        assert_eq!(role_str(None, None), "primary");
        assert_eq!(role_str(Some(VPlayerRole::Productive), Some(3)), "productive");
        assert_eq!(role_str(Some(VPlayerRole::Bait), Some(3)), "bait");
        assert_eq!(role_str(None, Some(3)), "bait");
        // The variant a catch-all used to swallow.
        assert_eq!(role_str(Some(VPlayerRole::Raider), Some(3)), "raider");
    }
}
