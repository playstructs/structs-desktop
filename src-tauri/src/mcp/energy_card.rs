//! The ENERGY card (⌘K `ENERGY` / `POWER`): the whole power system boiled down
//! to one number, one bar and one button.
//!
//! The player sees HEADROOM — `(capacity + capacitySecondary) − (load +
//! structsLoad)`, the keeper's online rule — as "room for N structs" (or N
//! replicants, once the player runs any), and a
//! supply bar split three ways:
//!
//!   * OWN     — reactor infusions (the 96% the player keeps). The only power
//!               that can be passed on (`capacity − load`).
//!   * SHARED  — the connected substation's `connectionCapacity`.
//!   * RENTED  — open agreements. Their allocation is connected to the
//!               substation the player is on, so the player's slice arrives
//!               inside `connectionCapacity` and is split out of SHARED here.
//!
//! One button follows the state: More power (infuse, or rent the cheapest
//! alpha-priced offer and connect it), Share spare (a dynamic allocation into
//! the guild's, the player's or the crew's substation — or Sell: allocation →
//! own substation → provider), Back online (pause the least-needed structs,
//! Command Ship last, plus an infuse).
//!
//! "Keep me powered" is a small loop of its own, NOT auto_infuse: auto_infuse
//! stakes everything above a reserve, this one infuses only enough to hold a
//! few builds of room.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{LazyLock, Mutex, RwLock};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::loop_util::parse_f64 as num;

const MW_PER_KW: f64 = 1_000_000.0;
const UALPHA_PER_GRAM: f64 = 1_000_000.0;
/// One Ore Extractor's passive draw — the fallback "one build".
const FALLBACK_BUILD_MW: f64 = 500_000.0;
/// Seconds per block, for turning days into an agreement's block duration.
pub const BLOCK_SECS: f64 = 5.3;
const SLOW_TTL_MS: f64 = 60_000.0;

// ── Keep me powered ─────────────────────────────────────────────────────────

const FILENAME: &str = "energy_card.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct KeepPoweredConfig {
    pub enabled: bool,
    /// Hold at least this many builds of room.
    pub target_builds: u32,
    /// Never infuse the wallet below this many grams.
    pub reserve_grams: f64,
    pub interval_secs: u64,
}

impl Default for KeepPoweredConfig {
    fn default() -> Self {
        Self { enabled: false, target_builds: 3, reserve_grams: 5.0, interval_secs: 300 }
    }
}

static CONFIG: LazyLock<RwLock<KeepPoweredConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));
static LAST_TICK: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

pub fn config() -> KeepPoweredConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set_keep(cfg: KeepPoweredConfig) -> KeepPoweredConfig {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
    cfg
}

// ── Pure pieces (tested) ────────────────────────────────────────────────────

/// The four states the card's one button follows.
pub fn state_of(headroom_mw: f64, room: i64, spare_mw: f64) -> &'static str {
    if headroom_mw < 0.0 {
        "dark"
    } else if room < 2 {
        "thin"
    } else if spare_mw >= MW_PER_KW {
        "spare"
    } else {
        "healthy"
    }
}

/// Own power that can be passed on without thinning the player: what is
/// allocatable, never more than the headroom, less a margin of
/// `keep_builds` builds.
pub fn spare_of(capacity_mw: f64, load_mw: f64, headroom_mw: f64, build_mw: f64, keep_builds: f64) -> f64 {
    let allocatable = (capacity_mw - load_mw).max(0.0);
    (allocatable.min(headroom_mw) - keep_builds * build_mw).max(0.0)
}

/// Grams to infuse so the player keeps `need_mw` after the reactor's cut.
pub fn grams_for(need_mw: f64, commission: f64) -> f64 {
    let keep = (1.0 - commission).clamp(0.01, 1.0);
    ((need_mw / keep) / UALPHA_PER_GRAM * 100.0).ceil() / 100.0
}

/// "One build": the median passive draw of the struct types that draw.
fn build_mw() -> f64 {
    let mut d: Vec<f64> = crate::game_state::GAME_STATE
        .read()
        .map(|gs| gs.struct_types.values().filter_map(|t| t.passive_draw).filter(|d| *d > 0.0).collect())
        .unwrap_or_default();
    if d.is_empty() {
        return FALLBACK_BUILD_MW;
    }
    d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    d[d.len() / 2]
}

/// What to switch off to get back online, least-needed first: fleet hulls,
/// then planetary structs, then production; the Command Ship never. Stops as
/// soon as the deficit is covered.
pub fn pause_plan(mut online: Vec<(String, String, f64, u8)>, deficit_mw: f64) -> Vec<Value> {
    online.retain(|(_, name, _, _)| !name.eq_ignore_ascii_case("command ship"));
    online.sort_by(|a, b| a.3.cmp(&b.3).then(b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)));
    let mut freed = 0.0;
    let mut out = Vec::new();
    for (id, name, draw, _) in online {
        if freed >= deficit_mw {
            break;
        }
        freed += draw;
        out.push(json!({ "id": id, "name": name, "draw_mw": draw }));
    }
    out
}

fn pause_class(name: &str, location_type: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if n.contains("extractor") || n.contains("refinery") || n.contains("generator") || n.contains("plant") || n.contains("engine") {
        2
    } else if location_type.eq_ignore_ascii_case("fleet") {
        0
    } else {
        1
    }
}

// ── Slow reads, cached ──────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct Slow {
    at: f64,
    guild: Option<crate::mcp::guild_power::GuildPower>,
    rented_mw: f64,
    rentals: Vec<Value>,
    selling: Vec<Value>,
    income_per_block: f64,
    /// Where Share spare can send power: guild · the player's own substation ·
    /// the crew's (where the replicants are), de-duplicated, each with what we
    /// already route there.
    destinations: Vec<Value>,
    /// The substation the primary is connected to, and how many share it —
    /// rented power lands THERE, so the player sees `rented ÷ connections`.
    my_sub: Option<(String, u64)>,
    /// Our own provider, if we already sell: (provider id, its substation id).
    provider: Option<(String, String)>,
    offers: Vec<Value>,
}
static SLOW: LazyLock<Mutex<Slow>> = LazyLock::new(|| Mutex::new(Slow::default()));

fn invalidate() {
    if let Ok(mut s) = SLOW.lock() {
        s.at = 0.0;
    }
}

/// A substation's connection count and its unrouted capacity (capacity − load).
async fn sub_stats(client: &CosmosClient, sub: &str) -> (u64, f64) {
    client
        .query_entity("substation", sub)
        .await
        .ok()
        .map(|v| {
            let g = |k: &str| num(v.pointer(&format!("/gridAttributes/{k}")));
            (g("connectionCount") as u64, (g("capacity") - g("load")).max(0.0))
        })
        .unwrap_or((0, 0.0))
}

async fn connections_of(client: &CosmosClient, sub: &str) -> u64 {
    sub_stats(client, sub).await.0
}

/// Replicants we run (registry rows that have a chain player).
fn replicant_count() -> u64 {
    crate::mcp::virtual_players::REGISTRY
        .read()
        .map(|r| r.players.iter().filter(|p| p.player_id.is_some()).count() as u64)
        .unwrap_or(0)
}

/// The average draw of our replicants (player passive + their online
/// structs), from the roster sweep — the size of "one replicant". N
/// replicants really do draw about N × this, which is what the card promises.
fn avg_replicant_draw() -> Option<f64> {
    let draws: Vec<f64> = crate::mcp::roster_cache::all_rows()
        .iter()
        .filter(|r| r.index.is_some() && r.err.is_none() && r.structs_load > 0.0)
        .map(|r| r.structs_load)
        .collect();
    average(&draws)
}

pub fn average(v: &[f64]) -> Option<f64> {
    if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) }
}

/// The card counts in whatever the player grows: STRUCTS until they run
/// replicants, then REPLICANTS — one replicant sized at the AVERAGE draw we
/// measure across ours (never below the replication gate's floor).
pub fn unit_for(replicants: u64, struct_mw: f64, replicant_mw: Option<f64>) -> (&'static str, f64) {
    if replicants > 0 {
        let floor = crate::mcp::guild_power::MIN_PLAYER_DRAW_MW;
        ("replicant", replicant_mw.unwrap_or(floor).max(floor))
    } else {
        ("struct", struct_mw)
    }
}

/// The substation most of our replicants are on (a sample of the registry is
/// enough: they all join through the same door).
async fn crew_substation(client: &CosmosClient) -> Option<String> {
    let ids: Vec<String> = crate::mcp::virtual_players::REGISTRY
        .read()
        .ok()?
        .players
        .iter()
        .filter_map(|p| p.player_id.clone())
        .take(6)
        .collect();
    let mut count: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for id in ids {
        if let Ok(v) = client.query_entity("player", &id).await {
            if let Some(s) = v.get("substationId").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                *count.entry(s.to_string()).or_default() += 1;
            }
        }
    }
    count.into_iter().max_by_key(|(_, n)| *n).map(|(s, _)| s)
}

async fn slow(client: &CosmosClient, pid: &str, guild_id: &str, my_sub_id: &str, fresh: bool) -> Slow {
    let now = now_millis();
    if !fresh {
        if let Ok(s) = SLOW.lock() {
            if s.at > 0.0 && now - s.at < SLOW_TTL_MS {
                return s.clone();
            }
        }
    }
    let guild = if guild_id.is_empty() {
        None
    } else {
        crate::mcp::guild_power::resolve_guild_power(client, guild_id).await.ok()
    };
    let agreements = crate::mcp::terminal::terminal_agreements(pid.to_string()).await.unwrap_or(Value::Null);
    let active = |k: &str| -> Vec<Value> {
        agreements
            .get(k)
            .and_then(|b| b.as_array())
            .map(|a| a.iter().filter(|r| r["active"] == true).cloned().collect())
            .unwrap_or_default()
    };
    let rentals = active("bought");
    let selling = active("sold");
    let income_per_block = num(agreements.get("income_per_block"));
    let rented_mw = rentals.iter().map(|r| num(r.get("capacity"))).sum();

    let my_sub = if my_sub_id.is_empty() {
        None
    } else {
        Some((my_sub_id.to_string(), connections_of(client, my_sub_id).await))
    };
    let crew = crew_substation(client).await;
    let mut destinations: Vec<Value> = Vec::new();
    let mut add = |key: &str, id: &str, connections: u64| {
        if id.is_empty() || destinations.iter().any(|d| d["id"] == id) {
            return;
        }
        destinations.push(json!({ "key": key, "id": id, "connections": connections }));
    };
    if let Some(g) = guild.as_ref() {
        add("guild", &g.substation_id, g.sub_connection_count);
    }
    if let Some((id, n)) = my_sub.as_ref() {
        add("mine", id, *n);
    }
    let mut crew_room: Option<(u64, i64)> = None;
    if let Some(c) = crew.as_deref() {
        let (n, available) = sub_stats(client, c).await;
        let per = avg_replicant_draw().unwrap_or(0.0).max(crate::mcp::guild_power::MIN_PLAYER_DRAW_MW);
        let (_, more) = crate::mcp::guild_power::derive_headroom(available, n, per);
        crew_room = Some((n, more));
        add("crew", c, n);
    }
    for d in destinations.iter_mut() {
        let id = d["id"].as_str().unwrap_or("").to_string();
        if d["key"] == "crew" {
            if let Some((_, more)) = crew_room {
                d["supportable_more"] = json!(more);
            }
        }
        if let Some((aid, mw)) = crate::mcp::guild_power::find_dynamic_allocation(client, pid, &id).await {
            d["sharing"] = json!({ "allocation_id": aid, "power_mw": mw });
        }
    }
    // Rent candidates: open to anyone and priced in alpha — an offer in a
    // guild token is refused at broadcast unless the player holds that token.
    let market = crate::mcp::terminal::terminal_market().await.unwrap_or(Value::Null);
    let ours = market
        .get("providers")
        .and_then(|p| p.as_array())
        .and_then(|a| a.iter().find(|r| r.pointer("/owner/id").and_then(|v| v.as_str()) == Some(pid)))
        .and_then(|r| r.get("id").and_then(|v| v.as_str()).map(String::from));
    let provider = match ours {
        Some(id) => {
            let sub = client
                .entity("provider", &id)
                .await
                .ok()
                .and_then(|v| v.pointer("/Provider/substationId").and_then(|s| s.as_str()).map(String::from))
                .unwrap_or_default();
            Some((id, sub))
        }
        None => None,
    };
    let offers: Vec<Value> = market
        .get("providers")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|row| {
                    if row.pointer("/owner/id").and_then(|v| v.as_str()) == Some(pid) {
                        return None;
                    }
                    let p = row.get("provider")?;
                    if p.get("open").and_then(|v| v.as_bool()) != Some(true) {
                        return None;
                    }
                    if p.get("fx_source").and_then(|v| v.as_str()) != Some("alpha") {
                        return None;
                    }
                    let rate = p.get("rate_ualpha_per_mw_block").and_then(|v| v.as_f64())?;
                    Some(json!({
                        "id": row.get("id").cloned().unwrap_or(Value::Null),
                        "owner": row.pointer("/owner/name").cloned().unwrap_or(Value::Null),
                        "rate_ualpha_per_mw_block": rate,
                        "capacity_min": p.get("capacity_min").cloned().unwrap_or(json!(0)),
                        "capacity_max": p.get("capacity_max").cloned().unwrap_or(json!(0)),
                        "duration_min": p.get("duration_min").cloned().unwrap_or(json!(0)),
                        "duration_max": p.get("duration_max").cloned().unwrap_or(json!(0)),
                    }))
                })
                .take(40)
                .collect()
        })
        .unwrap_or_default();
    let s = Slow { at: now, guild, rented_mw, rentals, selling, income_per_block, destinations, my_sub, provider, offers };
    if let Ok(mut c) = SLOW.lock() {
        *c = s.clone();
    }
    s
}

// ── The read ────────────────────────────────────────────────────────────────

/// Everything the card draws, in one read.
#[tauri::command]
pub async fn terminal_energy(fresh: Option<bool>) -> Result<Value, String> {
    let (pid, address, guild_id, mine) = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
        let pid = gs.player_id.clone().unwrap_or_default();
        let mine: Vec<(String, String, f64, u8)> = gs
            .structs
            .values()
            .filter(|s| s.owner == pid && s.status & 4 != 0 && s.status & 32 == 0)
            .map(|s| {
                let t = gs.struct_types.get(&s.struct_type_id.to_string());
                let name = s
                    .struct_type_name
                    .clone()
                    .or_else(|| t.map(|t| t.name.clone()))
                    .unwrap_or_else(|| format!("struct {}", s.struct_type_id));
                let draw = t.and_then(|t| t.passive_draw).unwrap_or(0.0);
                let class = pause_class(&name, s.location_type.as_deref().unwrap_or(""));
                (s.id.clone(), name, draw, class)
            })
            .collect();
        (pid, gs.wallet_address.clone().unwrap_or_default(), gs.guild_id.clone().unwrap_or_default(), mine)
    };
    if pid.is_empty() {
        return Err("the game has not signed in yet".into());
    }
    let client = CosmosClient::new();
    let p = client.query_entity("player", &pid).await.map_err(|e| format!("could not read your power: {e}"))?;
    let ga = p.get("gridAttributes");
    let g = |k: &str| num(ga.and_then(|g| g.get(k)));
    let capacity = g("capacity");
    let load = g("load");
    let structs_load = g("structsLoad");
    let shared = g("connectionCapacity");
    let wallet_g = num(p.pointer("/playerInventory/rocks/amount")) / UALPHA_PER_GRAM;
    let substation_id = p.get("substationId").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let s = slow(&client, &pid, &guild_id, &substation_id, fresh.unwrap_or(false)).await;
    // Rented power is connected to the substation the player is on, so it
    // arrives inside `connectionCapacity`, split across everyone there. Show
    // the player's slice of it as Rented and the rest of the share as Shared.
    let my_connections = s.my_sub.as_ref().map(|(_, n)| (*n).max(1)).unwrap_or(1) as f64;
    let rented = (s.rented_mw / my_connections).min(shared);
    let shared = shared - rented;
    let own = capacity;
    let supply = capacity + shared + rented;
    let draw = load + structs_load;
    let headroom = supply - draw;
    let build = build_mw();
    let replicants = replicant_count();
    let (unit, unit_mw) = unit_for(replicants, build, avg_replicant_draw());
    let room = (headroom / unit_mw).floor() as i64;
    let spare = spare_of(capacity, load, headroom, build, 3.0);
    let state = state_of(headroom, room, spare);
    let commission = s.guild.as_ref().map(|g| g.reactor_commission).unwrap_or(0.04);
    let cfg = config();

    // Back online: infuse what the wallet allows above the reserve, pause
    // structs for the rest. Half a build of margin so one tick of drift does
    // not put the player straight back out.
    let deficit = if headroom < 0.0 { -headroom + build * 0.5 } else { 0.0 };
    let spendable_g = (wallet_g - cfg.reserve_grams).max(0.0);
    let infuse_g = if deficit > 0.0 { grams_for(deficit, commission).min(spendable_g) } else { 0.0 };
    let infuse_mw = infuse_g * UALPHA_PER_GRAM * (1.0 - commission);
    let pause = if deficit > infuse_mw { pause_plan(mine, deficit - infuse_mw) } else { Vec::new() };

    Ok(json!({
        "state": state,
        "own_mw": own, "shared_mw": shared, "rented_mw": rented,
        "supply_mw": supply, "draw_mw": draw, "headroom_mw": headroom,
        "build_mw": build, "unit": unit, "unit_mw": unit_mw, "replicants": replicants,
        "room": room, "spare_mw": spare,
        "wallet_g": wallet_g, "address": address, "player_id": pid,
        "reactor": s.guild.as_ref().map(|g| json!({
            "id": g.reactor_id, "commission": g.reactor_commission, "ready": !g.reactor_validator.is_empty(),
        })),
        "substation": { "id": substation_id, "connections": my_connections as u64 },
        "destinations": s.destinations,
        "rented_total_mw": s.rented_mw,
        "rentals": s.rentals,
        "selling": s.provider.as_ref().map(|(id, sub)| json!({
            "provider_id": id, "substation_id": sub,
            "sold_mw": s.selling.iter().map(|r| num(r.get("capacity"))).sum::<f64>(),
            "agreements": s.selling.len(),
            "income_g_day": s.income_per_block * (86400.0 / BLOCK_SECS) / UALPHA_PER_GRAM,
        })),
        "offers": s.offers,
        "block_secs": BLOCK_SECS,
        "online_plan": { "infuse_g": infuse_g, "pause": pause },
        "keep": cfg,
    }))
}

// ── The one new write ───────────────────────────────────────────────────────

/// Share `power_mw` of OWN power into a substation — the guild's, the one the
/// player is on, the crew's — or stop sharing there with `power_mw = 0`.
/// Grows the one dynamic allocation we keep per destination, or creates and
/// connects it the first time. The brownout guard in the allocation commands
/// still runs. No destination = the guild's substation.
#[tauri::command]
pub async fn mcp_energy_share(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    power_mw: f64,
    destination_id: Option<String>,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    mcp_energy_share_impl(app, power_mw, destination_id).await
}

fn primary() -> Result<(String, String, String), String> {
    let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
    let pid = gs.player_id.clone().unwrap_or_default();
    if pid.is_empty() {
        return Err("the game has not signed in yet".into());
    }
    Ok((pid, gs.guild_id.clone().unwrap_or_default(), gs.wallet_address.clone().unwrap_or_default()))
}

fn is_substation(id: &str) -> bool {
    crate::mcp::types::ObjectId::parse(id).is_ok_and(|o| o.kind == crate::mcp::types::ObjectKind::Substation)
}

pub async fn mcp_energy_share_impl(app: tauri::AppHandle, power_mw: f64, destination_id: Option<String>) -> Result<Value, String> {
    if !power_mw.is_finite() || power_mw < 0.0 {
        return Err("power must be zero or more".into());
    }
    let (pid, guild_id, _) = primary()?;
    let client = CosmosClient::new();
    let dest = match destination_id.filter(|d| !d.trim().is_empty()) {
        Some(d) => d.trim().to_string(),
        None => {
            if guild_id.is_empty() {
                return Err("the game has not signed in yet".into());
            }
            crate::mcp::guild_power::resolve_guild_power(&client, &guild_id).await?.substation_id
        }
    };
    if !is_substation(&dest) {
        return Err(format!("'{dest}' is not a substation"));
    }
    share_into(&app, &client, &pid, &dest, power_mw).await
}

/// Grow (or create + connect, or with 0 delete) our one dynamic allocation
/// into `dest`. Shared by Share spare and Sell, which feeds our own
/// provider's substation the same way.
async fn share_into(app: &tauri::AppHandle, client: &CosmosClient, pid: &str, dest: &str, power_mw: f64) -> Result<Value, String> {
    let app = app.clone();
    let pid = pid.to_string();
    let existing = crate::mcp::guild_power::find_dynamic_allocation(client, &pid, dest).await;
    let out = match existing {
        Some((id, _)) if power_mw == 0.0 => {
            let args = json!({ "allocation_id": id });
            match crate::mcp::tx_retry::submit_once(&app, "allocation_delete", args, "energy:stop_sharing").await {
                Ok(r) if r.success => json!({ "ok": true, "stopped": id }),
                Ok(r) => return Err(r.error.unwrap_or_else(|| "rejected".into())),
                Err(e) => return Err(e),
            }
        }
        Some((id, current)) => {
            let next = current as f64 + power_mw;
            crate::mcp::tools::board_pages::mcp_allocation_set_power_impl(app.clone(), id.clone(), next).await?;
            json!({ "ok": true, "allocation_id": id, "power_mw": next })
        }
        None if power_mw == 0.0 => json!({ "ok": true }),
        None => {
            crate::mcp::tools::board_pages::mcp_allocation_create_impl(app.clone(), pid.clone(), "dynamic".into(), power_mw).await?;
            // The create answers no id: find the unconnected dynamic allocation
            // we just made (the highest index of ours with no destination).
            let id = newest_unconnected(&client, &pid).await.ok_or(
                "created the allocation but could not find it to connect — it will show on the ALLOC card",
            )?;
            crate::mcp::tools::board_pages::mcp_allocation_connect_impl(app.clone(), id.clone(), dest.to_string()).await?;
            json!({ "ok": true, "allocation_id": id, "power_mw": power_mw, "substation_id": dest })
        }
    };
    invalidate();
    Ok(out)
}

fn index_of(id: &str) -> u64 {
    id.rsplit('-').next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0)
}

/// The highest-index entity of `kind` matching `keep` — how we find what a
/// create just made, since the create answers no id.
async fn newest(client: &CosmosClient, kind: &str, list_key: &str, keep: impl Fn(&Value) -> bool) -> Option<Value> {
    let list = client.list_entities(kind, None, Some(2000)).await.ok()?;
    let arr = list.get(list_key).and_then(|a| a.as_array())?;
    arr.iter()
        .filter(|a| keep(a))
        .max_by_key(|a| a.get("id").and_then(|i| i.as_str()).map(index_of).unwrap_or(0))
        .cloned()
}

fn id_of(v: &Value) -> Option<String> {
    v.get("id").and_then(|i| i.as_str()).map(String::from)
}

async fn newest_unconnected(client: &CosmosClient, pid: &str) -> Option<String> {
    let s = |a: &Value, k: &str| a.get(k).and_then(|c| c.as_str()).unwrap_or("").to_string();
    newest(client, "allocation", "Allocation", |a| {
        s(a, "controller") == pid && s(a, "sourceObjectId") == pid && s(a, "type") == "dynamic" && s(a, "destinationId").is_empty()
    })
    .await
    .as_ref()
    .and_then(id_of)
}

/// Poll for something a just-signed tx created (inclusion is a block or two).
async fn wait_for<F, Fut>(mut probe: F) -> Option<Value>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    for _ in 0..8 {
        if let Some(v) = probe().await {
            return Some(v);
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    None
}

// ── Rent: open the agreement, then connect its allocation ───────────────────

/// Rent `capacity` mW from a provider for `duration` blocks. An agreement
/// creates a provider-agreement allocation that goes nowhere until it is
/// connected, so this connects it to the substation the player is on — the
/// power then arrives in the player's share of that substation.
#[tauri::command]
pub async fn mcp_energy_rent(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    provider_id: String,
    capacity: u64,
    duration: u64,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    mcp_energy_rent_impl(app, provider_id, capacity, duration).await
}

pub async fn mcp_energy_rent_impl(app: tauri::AppHandle, provider_id: String, capacity: u64, duration: u64) -> Result<Value, String> {
    let (pid, _, _) = primary()?;
    let client = CosmosClient::new();
    let my_sub = client
        .query_entity("player", &pid)
        .await
        .ok()
        .and_then(|p| p.get("substationId").and_then(|s| s.as_str()).map(String::from))
        .filter(|s| is_substation(s))
        .ok_or("you are not connected to a substation, so rented power would have nowhere to land")?;
    let agreement_of = |a: &Value| {
        a.get("owner").and_then(|v| v.as_str()) == Some(pid.as_str())
            && a.get("providerId").and_then(|v| v.as_str()) == Some(provider_id.as_str())
    };
    let before = newest(&client, "agreement", "Agreement", agreement_of).await.as_ref().and_then(id_of);

    let opened = crate::matrix::matrix_agreement_open(app.clone(), provider_id.clone(), capacity, duration).await?;

    let found = wait_for(|| {
        let client = &client;
        let before = before.clone();
        async move {
            newest(client, "agreement", "Agreement", agreement_of)
                .await
                .filter(|a| id_of(a) != before && a.get("allocationId").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()))
        }
    })
    .await;
    invalidate();
    let Some(agreement) = found else {
        return Ok(json!({ "ok": true, "opened": opened, "connected": false,
            "note": "the agreement opened; its allocation has not appeared yet to connect — the card will show it" }));
    };
    let allocation = agreement.get("allocationId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    crate::mcp::tools::board_pages::mcp_allocation_connect_impl(app.clone(), allocation.clone(), my_sub.clone()).await?;
    invalidate();
    Ok(json!({ "ok": true, "agreement_id": id_of(&agreement), "allocation_id": allocation, "substation_id": my_sub, "connected": true }))
}

// ── Sell: allocation → own substation → provider ────────────────────────────

/// Sell `power_mw` of OWN power on the open market at `rate` ualpha per mW per
/// block, for agreements of one day up to `max_days`. The first time this
/// builds the whole pipeline — a dynamic allocation from the player, a
/// substation made from it, a provider on that substation. After that it only
/// grows the allocation feeding the provider's substation.
#[tauri::command]
pub async fn mcp_energy_sell(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    power_mw: f64,
    rate: u64,
    max_days: f64,
) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    mcp_energy_sell_impl(app, power_mw, rate, max_days).await
}

pub fn provider_terms(power_mw: f64, max_days: f64) -> (u64, u64, u64, u64) {
    let per_day = (86400.0 / BLOCK_SECS).round() as u64;
    let cap_max = power_mw.round().max(1.0) as u64;
    let cap_min = cap_max.min(MW_PER_KW as u64);
    let dur_max = ((max_days.max(1.0)) * 86400.0 / BLOCK_SECS).round() as u64;
    (cap_min, cap_max, per_day.min(dur_max), dur_max)
}

pub async fn mcp_energy_sell_impl(app: tauri::AppHandle, power_mw: f64, rate: u64, max_days: f64) -> Result<Value, String> {
    if !power_mw.is_finite() || power_mw < MW_PER_KW {
        return Err("sell at least 1 kW".into());
    }
    if rate == 0 {
        return Err("the price must be at least 1 ualpha per mW per block".into());
    }
    let (pid, guild_id, _) = primary()?;
    let client = CosmosClient::new();
    let existing = slow(&client, &pid, &guild_id, "", true).await.provider;
    if let Some((provider_id, sub)) = existing.filter(|(_, s)| is_substation(s)) {
        let out = share_into(&app, &client, &pid, &sub, power_mw).await?;
        return Ok(json!({ "ok": true, "provider_id": provider_id, "substation_id": sub, "grew": out }));
    }

    // 1. A dynamic allocation from the player (the brownout guard runs here).
    crate::mcp::tools::board_pages::mcp_allocation_create_impl(app.clone(), pid.clone(), "dynamic".into(), power_mw).await?;
    let allocation = wait_for(|| async { newest_unconnected(&client, &pid).await.map(Value::String) })
        .await
        .and_then(|v| v.as_str().map(String::from))
        .ok_or("created the allocation but could not find it to build the substation on")?;

    // 2. A substation made from it — ours, so a provider may attach to it.
    let subs_before = newest(&client, "substation", "Substation", |s| s.get("owner").and_then(|v| v.as_str()) == Some(pid.as_str()))
        .await
        .as_ref()
        .and_then(id_of);
    crate::mcp::tx_retry::sign_with_retry(
        &app,
        0,
        "/structs.structs.MsgSubstationCreate",
        json!({ "owner": pid, "allocationId": allocation }),
        "energy:sell:substation",
    )
    .await?;
    let substation = wait_for(|| {
        let before = subs_before.clone();
        let client = &client;
        let pid = pid.clone();
        async move {
            newest(client, "substation", "Substation", |s| s.get("owner").and_then(|v| v.as_str()) == Some(pid.as_str()))
                .await
                .filter(|s| id_of(s) != before)
        }
    })
    .await
    .as_ref()
    .and_then(id_of)
    .ok_or("the substation was signed but has not appeared yet — try Sell again in a minute")?;

    // 3. The provider: open market, no penalties, a day up to `max_days`.
    let (cap_min, cap_max, dur_min, dur_max) = provider_terms(power_mw, max_days);
    crate::mcp::tx_retry::sign_with_retry(
        &app,
        0,
        "/structs.structs.MsgProviderCreate",
        json!({
            "substationId": substation,
            "rate": { "denom": "ualpha", "amount": rate.to_string() },
            "accessPolicy": "openMarket",
            "providerCancellationPenalty": "0",
            "consumerCancellationPenalty": "0",
            "capacityMinimum": cap_min.to_string(),
            "capacityMaximum": cap_max.to_string(),
            "durationMinimum": dur_min.to_string(),
            "durationMaximum": dur_max.to_string(),
        }),
        "energy:sell:provider",
    )
    .await?;
    crate::mcp::board_feed::push(
        &app,
        crate::mcp::board_feed::Severity::Notice,
        "energy",
        format!("selling {:.1} kW on {substation} at {rate} ualpha per mW·block", power_mw / MW_PER_KW),
    );
    invalidate();
    Ok(json!({ "ok": true, "allocation_id": allocation, "substation_id": substation }))
}

/// The card's switch.
#[tauri::command]
pub fn mcp_energy_keep(window: tauri::WebviewWindow, enabled: bool) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    let mut cfg = config();
    cfg.enabled = enabled;
    Ok(json!(set_keep(cfg)))
}

// ── The loop ────────────────────────────────────────────────────────────────

/// Hold `target_builds` of room: when the player is below it, infuse just
/// enough (above the wallet reserve) to get back to it. Never pauses structs,
/// never rents, never touches allocations.
pub async fn tick(app: &tauri::AppHandle) {
    let cfg = config();
    if !cfg.enabled {
        return;
    }
    let now = now_millis();
    {
        let mut last = LAST_TICK.lock().unwrap_or_else(|p| p.into_inner());
        if now - *last < cfg.interval_secs as f64 * 1000.0 {
            return;
        }
        *last = now;
    }
    let Ok(v) = terminal_energy(Some(false)).await else { return };
    let headroom = num(v.get("headroom_mw"));
    let build = num(v.get("build_mw")).max(1.0);
    let want = cfg.target_builds as f64 * build;
    if headroom >= want {
        return;
    }
    let commission = v.pointer("/reactor/commission").and_then(|c| c.as_f64()).unwrap_or(0.04);
    let spendable = (num(v.get("wallet_g")) - cfg.reserve_grams).max(0.0);
    let grams = grams_for(want - headroom, commission).min(spendable);
    if grams < 0.01 {
        return;
    }
    let (Some(address), Some(reactor)) = (
        v.get("address").and_then(|a| a.as_str()).filter(|a| !a.is_empty()),
        v.pointer("/reactor/id").and_then(|r| r.as_str()),
    ) else {
        return;
    };
    let res = crate::mcp::tools::infusions::mcp_infusion_infuse_impl(
        app.clone(),
        address.to_string(),
        reactor.to_string(),
        grams * UALPHA_PER_GRAM,
    )
    .await;
    let msg = match res {
        Ok(_) => format!("kept you powered: infused {grams:.2} g"),
        Err(e) => format!("keep me powered: infuse {grams:.2} g failed — {e}"),
    };
    crate::mcp::board_feed::push(app, crate::mcp::board_feed::Severity::Notice, "energy", msg);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_follow_headroom_room_and_spare() {
        assert_eq!(state_of(-1.0, -1, 0.0), "dark");
        assert_eq!(state_of(0.0, 0, 0.0), "thin");
        assert_eq!(state_of(700_000.0, 1, 0.0), "thin");
        assert_eq!(state_of(4_700_000.0, 9, 0.0), "healthy");
        assert_eq!(state_of(22_700_000.0, 45, 10_000_000.0), "spare");
    }

    #[test]
    fn spare_is_allocatable_capped_by_headroom_less_a_margin() {
        // 30 kW own, nothing routed, 22.7 kW headroom, 0.5 kW builds, keep 3.
        assert_eq!(spare_of(30e6, 0.0, 22.7e6, 0.5e6, 3.0), 21.2e6);
        // Shared power can't be passed on: no own capacity, nothing spare.
        assert_eq!(spare_of(0.0, 0.0, 6.0e6, 0.5e6, 3.0), 0.0);
        // Thin: the margin eats it.
        assert_eq!(spare_of(12e6, 11e6, 0.7e6, 0.5e6, 3.0), 0.0);
    }

    #[test]
    fn grams_cover_the_commission() {
        // 1.8 kW after a 4% cut → 1.875 g, rounded up to the centigram.
        assert_eq!(grams_for(1.8e6, 0.04), 1.88);
        assert_eq!(grams_for(1e6, 0.0), 1.0);
    }

    #[test]
    fn pause_plan_keeps_the_command_ship_and_takes_fleet_first() {
        let online = vec![
            ("5-1".into(), "Command Ship".into(), 50_000.0, 0),
            ("5-2".into(), "Ore Extractor".into(), 500_000.0, 2),
            ("5-3".into(), "Starfighter".into(), 450_000.0, 0),
            ("5-4".into(), "Planetary Defense Cannon".into(), 600_000.0, 1),
        ];
        let plan = pause_plan(online, 400_000.0);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0]["id"], "5-3");
        let all = pause_plan(
            vec![("5-1".into(), "Command Ship".into(), 50_000.0, 0), ("5-2".into(), "Ore Extractor".into(), 500_000.0, 2)],
            10e9,
        );
        assert!(all.iter().all(|p| p["name"] != "Command Ship"));
    }

    #[test]
    fn provider_terms_are_a_day_up_to_the_max_and_at_least_a_kilowatt() {
        let (cmin, cmax, dmin, dmax) = provider_terms(10e6, 7.0);
        assert_eq!((cmin, cmax), (1_000_000, 10_000_000));
        assert_eq!(dmin, (86400.0 / BLOCK_SECS).round() as u64);
        assert_eq!(dmax, (7.0 * 86400.0 / BLOCK_SECS).round() as u64);
        // Selling under a day's minimum: the minimum never exceeds the maximum.
        let (_, _, dmin, dmax) = provider_terms(2e6, 0.5);
        assert!(dmin <= dmax);
    }

    #[test]
    fn the_unit_grows_with_the_player() {
        let floor = crate::mcp::guild_power::MIN_PLAYER_DRAW_MW;
        assert_eq!(unit_for(0, 500_000.0, Some(9e6)), ("struct", 500_000.0));
        assert_eq!(average(&[4e6, 6e6, 11e6]), Some(7e6));
        assert_eq!(average(&[]), None);
        // With replicants: their average draw…
        assert_eq!(unit_for(3, 500_000.0, Some(9e6)), ("replicant", 9e6));
        // …never below the replication floor, and the floor when unmeasured.
        assert_eq!(unit_for(3, 500_000.0, Some(1e6)), ("replicant", floor));
        assert_eq!(unit_for(3, 500_000.0, None), ("replicant", floor));
    }

    #[test]
    fn index_orders_ids_numerically() {
        assert!(index_of("6-100") > index_of("6-99"));
    }

    #[test]
    fn pause_classes() {
        assert_eq!(pause_class("Starfighter", "fleet"), 0);
        assert_eq!(pause_class("Planetary Defense Cannon", "planet"), 1);
        assert_eq!(pause_class("Ore Refinery", "planet"), 2);
    }
}
