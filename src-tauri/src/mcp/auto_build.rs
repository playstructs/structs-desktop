//! Native auto-FILL loop — builds out each virtual player's defenses across every
//! free slot, hands-off, so the operator never has to fire hundreds of charge-paced
//! builds by hand. Two jobs per scan, per owned player:
//!   1. COMPLETE — any building struct whose build-PoW difficulty has decayed to ≤
//!      the threshold gets its `complete_build` PoW kicked off (same path as mining).
//!   2. INITIATE — if charge ≥ 8 and power headroom remains, initiate ONE build in
//!      the next free slot, picking a defensive type by a per-ambit loadout.
//! Charge-paced by construction (one initiate per player per scan; charge resets to
//! 0 per action and regenerates ~1/block), power-capped (won't push a player
//! offline), and it idles once every slot is full. Off until enabled. Sibling to
//! [`auto_harvest`]; both spawn from `sync_game_state`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

use crate::hasher::difficulty::calculate_difficulty;
use crate::hasher::types::{now_millis, TaskParams, TaskRegistry};
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_build.json";
const SLOTS_PER_AMBIT: usize = 4;
const BUILD_CHARGE: u64 = 8;

/// Priority-ordered defensive loadout: (target location_type, ambit, type name).
/// Cheap/high-value first (shields, then evasive ships), heavy Ore Bunkers last so
/// the power gate trims them rather than the cheaper structs. Each (target, ambit)
/// fills up to SLOTS_PER_AMBIT. Planet air/water are left to 1-per-player types
/// (PDC etc.) already placed, so they're not in the fill.
const LOADOUT: &[(&str, &str, &str)] = &[
    // Miner + core planetary defense first — these are 1-per-player, so they're
    // skipped when already present, but get rebuilt after an explore (the old
    // planet's structs are destroyed on completion, freeing the limit).
    ("planet", "land", "Ore Extractor"),
    ("planet", "water", "Planetary Defense Cannon"),
    ("planet", "space", "Orbital Shield Generator"),
    ("fleet", "air", "Pursuit Fighter"),
    ("fleet", "land", "Tank"),
    ("fleet", "water", "Submersible"),
    ("fleet", "space", "Starfighter"),
    ("planet", "land", "Ore Bunker"),
];

/// Production-first loadout for PRODUCTIVE players: extractor + refinery (the
/// alpha pipeline) + a command ship (raid gate) + light defense. The 1-per-player
/// types build only if absent (see ONE_PER_PLAYER); the rest fill by slot count.
const PRODUCTIVE_LOADOUT: &[(&str, &str, &str)] = &[
    ("planet", "land", "Ore Extractor"),
    ("planet", "land", "Ore Refinery"),
    ("fleet", "land", "Command Ship"),
    ("planet", "space", "Orbital Shield Generator"),
    ("fleet", "land", "Tank"),
    ("fleet", "space", "Starfighter"),
];

/// Struct types limited to one per player (buildLimit 1) — a loadout entry for
/// one of these is skipped when the player already has it, instead of trying
/// (and having the chain reject) a duplicate.
const ONE_PER_PLAYER: &[&str] = &[
    "Ore Extractor",
    "Ore Refinery",
    "Command Ship",
    "Field Generator",
    "Planetary Defense Cannon",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoBuildConfig {
    /// Master on/off. Off by default — it auto-signs build txs.
    pub enabled: bool,
    /// Complete a building struct once its build difficulty is ≤ this.
    pub complete_difficulty: u64,
    /// Min seconds between scans. Charge regenerates ~1/block (~6s), so a build
    /// becomes affordable again ~48s after the last; 120s leaves comfortable margin.
    pub interval_secs: u64,
    /// Also fill the primary player's slots (default just the vplayers).
    pub include_primary: bool,
}

impl Default for AutoBuildConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            complete_difficulty: 12,
            interval_secs: 120,
            include_primary: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<AutoBuildConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Struct ids confirmed built — never re-read their entity again (steady-state
/// completion reads → ~0 once the fleet is built out).
static BUILT_CACHE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn load() -> AutoBuildConfig {
    crate::mcp::config_store::load_config(FILENAME)
}
pub fn get() -> AutoBuildConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}
pub fn set(cfg: AutoBuildConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

fn ambit_to_enum(a: &str) -> i64 {
    match a {
        "water" => 1,
        "land" => 2,
        "air" => 3,
        "space" => 4,
        "local" => 5,
        _ => 0,
    }
}

use crate::mcp::loop_util::{parse_bool, parse_f64, read_u64_field};

/// Lowest free slot index in 0..SLOTS_PER_AMBIT not present in `occupied`.
fn first_free(occupied: &HashSet<u64>) -> Option<u64> {
    (0..SLOTS_PER_AMBIT as u64).find(|i| !occupied.contains(i))
}

pub async fn tick(app_handle: &tauri::AppHandle, force: bool) {
    let cfg = get();
    if !cfg.enabled {
        return;
    }
    let now = now_millis();
    if !force {
        let mut last = LAST_SCAN.lock().unwrap();
        if now - *last < (cfg.interval_secs as f64) * 1000.0 {
            return;
        }
        *last = now;
    } else if let Ok(mut last) = LAST_SCAN.lock() {
        *last = now;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    scan(app_handle, &cfg).await;
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(app_handle: &tauri::AppHandle, cfg: &AutoBuildConfig) {
    let registry = match app_handle.try_state::<Arc<TaskRegistry>>() {
        Some(r) => r.inner().clone(),
        None => return,
    };
    let current_block = crate::game_state::GAME_STATE
        .read()
        .map(|g| g.current_block_height)
        .unwrap_or(0);
    if current_block == 0 {
        return;
    }
    let client = CosmosClient::new();

    // Guild substation per-connection capacity = each player's capacitySecondary.
    let conn_cap = {
        let gid = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.guild_id.clone());
        match gid.filter(|s| !s.is_empty()) {
            Some(g) => crate::mcp::guild_power::resolve_guild_power(&client, &g)
                .await
                .map(|gp| gp.sub_connection_capacity)
                .unwrap_or(0.0),
            None => 0.0,
        }
    };

    // (player_id, vplayer index | None for primary, role | None for primary).
    use crate::mcp::virtual_players::VPlayerRole;
    let targets = crate::mcp::virtual_players::collect_targets(cfg.include_primary);

    // Fan out the per-player body with bounded concurrency so every player is
    // scanned in the same wave (≤ MAX_CONCURRENT_PLAYERS in flight) instead of
    // serially — the serial walk reached the tail cohort minutes late.
    let complete_difficulty = cfg.complete_difficulty;
    let app = app_handle.clone();
    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::MAX_CONCURRENT_PLAYERS,
        move |(pid, idx_opt, role)| {
            let app = app.clone();
            let client = client.clone();
            let registry = registry.clone();
            async move {
                let structs = match client.guild.struct_list_by_owner(&pid, 1).await {
                    Ok(p) => p.items,
                    Err(_) => return,
                };

                // ── 1. Complete ripe building structs ──
                for s in &structs {
                    if parse_bool(s.get("is_destroyed")) {
                        continue;
                    }
                    let Some(sid) = s.get("id").and_then(|x| x.as_str()).map(String::from) else { continue };
                    if BUILT_CACHE.lock().unwrap().contains(&sid) {
                        continue;
                    }
                    if let Some(t) = registry.tasks.get(&sid) {
                        if matches!(t.snapshot().status.as_str(), "running" | "waiting" | "starting") {
                            continue;
                        }
                    }
                    let entity = match client.query_entity("struct", &sid).await {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let sa = entity.get("structAttributes");
                    if parse_bool(sa.and_then(|x| x.get("isBuilt"))) {
                        BUILT_CACHE.lock().unwrap().insert(sid);
                        continue;
                    }
                    let anchor = read_u64_field(sa, "blockStartBuild");
                    if anchor == 0 {
                        continue;
                    }
                    let type_id = s.get("type").map(|x| match x {
                        Value::Number(n) => n.to_string(),
                        Value::String(t) => t.clone(),
                        _ => String::new(),
                    });
                    let difficulty_target = type_id
                        .as_ref()
                        .and_then(|t| {
                            crate::game_state::GAME_STATE.read().ok().and_then(|g| g.struct_types.get(t).map(|st| st.build_difficulty))
                        })
                        .unwrap_or(0);
                    if difficulty_target == 0 {
                        continue;
                    }
                    let age = current_block.saturating_sub(anchor);
                    if calculate_difficulty(age, difficulty_target) > complete_difficulty {
                        continue;
                    }
                    let params = TaskParams::for_ore(&sid, "BUILD", anchor, difficulty_target);
                    if crate::hasher::start_hash_task_core(params, app.clone(), &registry).is_ok() {
                        if let Some(idx) = idx_opt {
                            crate::hasher::register_vplayer_hash(sid.clone(), idx, "BUILD".to_string());
                        }
                        eprintln!("[Auto-Build] complete {} (age {}, build-difficulty ≤ {})", sid, age, complete_difficulty);
                    }
                }

                // ── 2. Initiate one build in the next free slot (charge + power gated) ──
                // Read the player's grid (charge from lastAction, structsLoad, personal cap).
                let player = match client.query_entity("player", &pid).await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                let ga = player.get("gridAttributes");
                let last_action = read_u64_field(ga, "lastAction");
                let charge = current_block.saturating_sub(last_action);
                if charge < BUILD_CHARGE {
                    return; // not enough charge to build this scan
                }
                let structs_load = parse_f64(ga.and_then(|x| x.get("structsLoad")));
                let personal_cap = parse_f64(ga.and_then(|x| x.get("capacity")));
                let personal_load = parse_f64(ga.and_then(|x| x.get("load")));
                let total_cap = personal_cap + conn_cap;
                let available = total_cap - structs_load - personal_load;

                // Occupied slots per (location_type, ambit).
                let mut occ: HashMap<(String, String), HashSet<u64>> = HashMap::new();
                for s in &structs {
                    if parse_bool(s.get("is_destroyed")) {
                        continue;
                    }
                    let lt = s.get("location_type").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let amb = s.get("operating_ambit").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let slot = s.get("slot").and_then(|x| x.as_u64()).unwrap_or(0);
                    occ.entry((lt, amb)).or_default().insert(slot);
                }

                // Productive players build a production-first loadout (extractor +
                // refinery + light defense); bait players (and the primary) get the
                // defensive fill. Bait never gets a refinery — that stays productive-only.
                let loadout: &[(&str, &str, &str)] = match role {
                    Some(VPlayerRole::Productive) => PRODUCTIVE_LOADOUT,
                    _ => LOADOUT,
                };
                // Type names the player already has (to skip 1-per-player duplicates).
                let present: HashSet<String> = structs
                    .iter()
                    .filter(|s| !parse_bool(s.get("is_destroyed")))
                    .filter_map(|s| s.get("type_name").and_then(|x| x.as_str()).map(String::from))
                    .collect();

                // ── TEMP DIAGNOSTIC: record entry into the initiate walk + what the loop sees.
                if idx_opt.is_some() {
                    if let Some(mut dp) = dirs::config_dir() {
                        dp.push("structs-app");
                        let _ = std::fs::create_dir_all(&dp);
                        dp.push("auto_build_debug.log");
                        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&dp) {
                            use std::io::Write;
                            let occ_keys: Vec<_> = occ.keys().cloned().collect();
                            let _ = writeln!(
                                f,
                                "WALK player {} charge {} structs {} present {:?} occ_keys {:?} loadout_len {}",
                                pid, charge, structs.len(), present, occ_keys, loadout.len()
                            );
                        }
                    }
                }
                // Walk the loadout; build the first ripe (free slot + power + known type).
                for (target, ambit, type_name) in loadout {
                    if ONE_PER_PLAYER.contains(type_name) && present.contains(*type_name) {
                        continue; // already have this 1-per-player struct
                    }
                    let key = (target.to_string(), ambit.to_string());
                    let used = occ.get(&key).map(|s| s.len()).unwrap_or(0);
                    if used >= SLOTS_PER_AMBIT {
                        continue;
                    }
                    let Some(slot) = first_free(occ.get(&key).unwrap_or(&HashSet::new())) else { continue };
                    // Resolve type id + draw from the catalog.
                    let (type_id, draw) = {
                        let gs = crate::game_state::GAME_STATE.read().unwrap();
                        match gs.struct_types.values().find(|t| t.name.eq_ignore_ascii_case(type_name)) {
                            Some(t) => (t.id, t.passive_draw.unwrap_or(0.0)),
                            None => continue,
                        }
                    };
                    if conn_cap > 0.0 && available < draw {
                        continue; // would push offline — skip this (heavier) type, try a cheaper one
                    }
                    let payload = json!({
                        "playerId": pid,
                        "structTypeId": type_id,
                        "operatingAmbit": ambit_to_enum(ambit),
                        "slot": slot,
                    });
                    // Only vplayers route through the façade signer; primary needs its own
                    // path (not wired here), so skip primary initiates for now.
                    let Some(idx) = idx_opt else { break };
                    // ── TEMP DIAGNOSTIC: capture the exact decision before signing.
                    let dbg_pre = format!(
                        "player {} idx {} :: {} {}/{} slot {} typeId {} occ{:?}={:?} avail {} draw {} conn_cap {}",
                        pid, idx, type_name, target, ambit, slot, type_id, key, occ.get(&key), available, draw, conn_cap
                    );
                    let res = crate::mcp::vplayer_bridge::sign_action(
                        &app,
                        idx,
                        "/structs.structs.MsgStructBuildInitiate",
                        payload,
                        60,
                    )
                    .await;
                    // ── TEMP DIAGNOSTIC: append decision + chain result to a readable log file.
                    {
                        let dbg_post = match &res {
                            Ok(v) => format!(
                                "OK code={:?} rawLog={:?} tx={:?}",
                                v.get("code"), v.get("rawLog"), v.get("transactionHash")
                            ),
                            Err(e) => format!("ERR {}", e),
                        };
                        if let Some(mut dp) = dirs::config_dir() {
                            dp.push("structs-app");
                            let _ = std::fs::create_dir_all(&dp);
                            dp.push("auto_build_debug.log");
                            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&dp) {
                                use std::io::Write;
                                let _ = writeln!(f, "{} => {}", dbg_pre, dbg_post);
                            }
                        }
                    }
                    match res {
                        Ok(v) if v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) == 0 => {
                            eprintln!("[Auto-Build] {} {} {} slot {} (player {})", target, ambit, type_name, slot, pid);
                        }
                        _ => {}
                    }
                    break; // one initiate per player per scan (charge resets to 0)
                }
            }
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_off_and_loadout_shape() {
        let c = AutoBuildConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.complete_difficulty, 12);
        assert_eq!(LOADOUT[0].2, "Ore Extractor"); // miner first (rebuilt after explore)
        assert_eq!(LOADOUT.last().unwrap().2, "Ore Bunker"); // heavy last
        assert_eq!(PRODUCTIVE_LOADOUT[0].2, "Ore Extractor");
        assert_eq!(PRODUCTIVE_LOADOUT[1].2, "Ore Refinery");
    }

    #[test]
    fn first_free_slot() {
        let mut occ = HashSet::new();
        assert_eq!(first_free(&occ), Some(0));
        occ.insert(0);
        occ.insert(1);
        assert_eq!(first_free(&occ), Some(2));
        occ.insert(2);
        occ.insert(3);
        assert_eq!(first_free(&occ), None); // full
    }
}
