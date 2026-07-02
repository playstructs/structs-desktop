//! Native auto-harvest loop — periodically re-mines (and optionally re-refines)
//! the team's structs WITHOUT the agent having to ask. The key efficiency idea:
//! after each mine/refine the struct's PoW anchor resets and the next proof is
//! expensive until it re-ages, so we only kick off a task once a struct's
//! CURRENT difficulty has decayed to ≤ a configurable threshold. The threshold
//! is the aggressiveness knob — higher = harvest sooner (cheaper-but-not-free
//! proofs), lower = wait for near-instant proofs. Settable via
//! `structs_players harvest`.
//!
//! Same loop drives MINE (extractors, type 14) and REFINE (refineries, type 16,
//! only when they hold stored ore) — refining is dormant until productive
//! players build refineries, but supported.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::hasher::difficulty::calculate_difficulty;
use crate::hasher::types::{now_millis, TaskParams, TaskRegistry};
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_harvest.json";
const MINE_TARGET: u64 = 14_000;
const REFINE_TARGET: u64 = 28_000;
const EXTRACTOR_TYPE: &str = "14";
const REFINERY_TYPE: &str = "16";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoHarvestConfig {
    /// Master on/off. Off by default — the operator opts in (it auto-signs txs).
    pub enabled: bool,
    /// Kick off a task once the struct's current difficulty is ≤ this. Higher =
    /// more aggressive (mine sooner, pricier proof); lower = wait for cheaper.
    /// ~10 ≈ harvest ~6h after the last cycle; ~1 ≈ near-instant (~23h).
    pub difficulty_threshold: u64,
    /// Minimum seconds between scans (the loop is invoked far more often but
    /// throttles to this). 1800 = every 30 min — frequent enough to catch
    /// ripeness promptly without hammering the chain.
    pub interval_secs: u64,
    /// Also auto-refine refineries that hold stored ore.
    pub refine: bool,
    /// Also harvest the PRIMARY player's structs (default just the vplayers).
    pub include_primary: bool,
    /// When a vplayer's planet is mined out (planet ore = 0), auto-explore a fresh
    /// planet so mining/production can continue. The old planet's structs are
    /// destroyed on explore (chain), and auto-build rebuilds the extractor (+
    /// refinery for productive) on the new planet. Off by default — it destroys
    /// the old planetary build-out each cycle.
    pub auto_explore: bool,
}

impl Default for AutoHarvestConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            difficulty_threshold: 10,
            interval_secs: 1800,
            refine: true,
            include_primary: false,
            auto_explore: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<AutoHarvestConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static HARVESTING: AtomicBool = AtomicBool::new(false);

fn load() -> AutoHarvestConfig {
    crate::mcp::config_store::load_config(FILENAME)
}

pub fn get() -> AutoHarvestConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: AutoHarvestConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

/// The decision: is a struct ripe to harvest at the given threshold?
pub fn is_ripe(age: u64, difficulty_target: u64, threshold: u64) -> bool {
    calculate_difficulty(age, difficulty_target) <= threshold
}

use crate::mcp::loop_util::{extract_type_id, parse_bool, parse_f64, read_u64_field};

/// Invoked each sync tick (cheap when throttled). Scans owned extractors (and
/// refineries if enabled) and kicks off a PoW task for each ripe struct that
/// isn't already in flight. Fire-and-forget; errors are swallowed per struct.
/// `force` bypasses the interval throttle (manual trigger).
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
    // One scan at a time.
    if HARVESTING.swap(true, Ordering::SeqCst) {
        return;
    }
    scan(app_handle, &cfg).await;
    HARVESTING.store(false, Ordering::SeqCst);
}

async fn scan(app_handle: &tauri::AppHandle, cfg: &AutoHarvestConfig) {
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

    // (player_id, Some(vplayer index) | None for primary, may_refine).
    // Refining is PRODUCTIVE-only — bait players mine but never refine (their ore
    // stays as raid bait). The primary may refine.
    use crate::mcp::virtual_players::VPlayerRole;
    let targets: Vec<(String, Option<u32>, bool)> =
        crate::mcp::virtual_players::collect_targets(cfg.include_primary)
            .into_iter()
            // may_refine: productive vplayers and the primary refine; bait never does.
            .map(|(pid, idx, role)| (pid, idx, !matches!(role, Some(VPlayerRole::Bait))))
            .collect();

    // Fan out the per-player body with bounded concurrency so every player is
    // scanned in the same wave (≤ MAX_CONCURRENT_PLAYERS in flight) instead of
    // serially — the serial walk reached the tail cohort minutes late.
    let started = Arc::new(AtomicU32::new(0));
    let started_body = started.clone();
    let difficulty_threshold = cfg.difficulty_threshold;
    let refine = cfg.refine;
    let auto_explore = cfg.auto_explore;
    let app = app_handle.clone();
    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::MAX_CONCURRENT_PLAYERS,
        move |(pid, idx_opt, may_refine)| {
            let app = app.clone();
            let client = client.clone();
            let registry = registry.clone();
            let started = started_body.clone();
            async move {
                let page = match client.guild.struct_list_by_owner(&pid, 1).await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                let mut extractor_planet: Option<String> = None;
                for s in page.items.iter() {
                    let Some(sid) = s.get("id").and_then(|x| x.as_str()).map(String::from) else {
                        continue;
                    };
                    let type_id = extract_type_id(s);
                    let is_extractor = type_id == EXTRACTOR_TYPE;
                    // A planetary extractor's location_id IS the player's planet id.
                    if is_extractor && !parse_bool(s.get("is_destroyed")) {
                        if let Some(loc) = s.get("location_id").and_then(|x| x.as_str()) {
                            extractor_planet = Some(loc.to_string());
                        }
                    }
                    let is_refinery = type_id == REFINERY_TYPE;
                    // Refine only for productive players (and if the config allows it);
                    // bait players mine only.
                    if !is_extractor && !(is_refinery && refine && may_refine) {
                        continue;
                    }
                    // Skip if a task for this struct is already in flight (completed ones
                    // linger in the registry — those we DO allow to re-issue).
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
                    if !parse_bool(sa.and_then(|x| x.get("isOnline"))) {
                        continue;
                    }
                    let (task_type, target, anchor) = if is_extractor {
                        ("MINE", MINE_TARGET, read_u64_field(sa, "blockStartOreMine"))
                    } else {
                        ("REFINE", REFINE_TARGET, read_u64_field(sa, "blockStartOreRefine"))
                    };
                    if anchor == 0 {
                        continue; // not in a cycle (extractor offline-cycle / refinery has no stored ore)
                    }
                    if is_refinery {
                        // Refining needs stored ore.
                        if parse_f64(entity.get("gridAttributes").and_then(|g| g.get("ore"))) <= 0.0 {
                            continue;
                        }
                    }
                    let age = current_block.saturating_sub(anchor);
                    if !is_ripe(age, target, difficulty_threshold) {
                        continue;
                    }
                    let params = TaskParams::for_ore(&sid, task_type, anchor, target);
                    if crate::hasher::start_hash_task_core(params, app.clone(), &registry).is_ok() {
                        if let Some(idx) = idx_opt {
                            crate::hasher::register_vplayer_hash(sid.clone(), idx, task_type.to_string());
                        }
                        started.fetch_add(1, Ordering::Relaxed);
                        eprintln!(
                            "[Auto-Harvest] {} {} (age {}, difficulty {} ≤ {})",
                            task_type,
                            sid,
                            age,
                            calculate_difficulty(age, target),
                            difficulty_threshold
                        );
                    }
                }

                // ── Auto-explore when the planet is mined out (ore reserve = 0) ──
                // Explore a fresh planet so mining can continue. The chain only allows
                // explore when the planet is empty of ore, destroys the old planetary
                // structs (freeing 1-per-player), and migrates the fleet; auto-build then
                // rebuilds the extractor (+ refinery for productive) on the new planet.
                // VPLAYERS ONLY — never the primary/main player (its base must never be
                // auto-abandoned). Enforced by requiring a vplayer HD index below; the
                // primary has idx_opt == None and is always skipped here.
                if auto_explore {
                    if let (Some(planet_id), Some(idx)) = (extractor_planet, idx_opt) {
                        let planet_ore = match client.query_entity("planet", &planet_id).await {
                            Ok(p) => parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))),
                            Err(_) => 1.0, // unknown → don't explore
                        };
                        if planet_ore <= 0.0 {
                            let res = crate::mcp::vplayer_bridge::sign_action(
                                &app,
                                idx,
                                "/structs.structs.MsgPlanetExplore",
                                serde_json::json!({ "playerId": pid }),
                                60,
                            )
                            .await;
                            if let Ok(v) = res {
                                if v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) == 0 {
                                    // Planet changed → bust the owned-cache so threat
                                    // detection re-resolves this player's new planet.
                                    crate::mcp::virtual_players::invalidate_owned(&pid);
                                    eprintln!("[Auto-Harvest] explored (planet {} mined out) for {}", planet_id, pid);
                                }
                            }
                        }
                    }
                }
            }
        },
    )
    .await;
    let started = started.load(Ordering::Relaxed);
    if started > 0 {
        eprintln!("[Auto-Harvest] started {} task(s)", started);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_off_and_aggressive_threshold() {
        let c = AutoHarvestConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.difficulty_threshold, 10);
        assert!(c.refine);
        assert!(!c.include_primary);
    }

    #[test]
    fn ripeness_tracks_difficulty_decay() {
        // Fresh anchor (age ≤ 1) → difficulty 64, never ripe at threshold 10.
        assert!(!is_ripe(1, MINE_TARGET, 10));
        // Fully aged (huge age) → difficulty 1, ripe even at threshold 1.
        assert!(is_ripe(100_000, MINE_TARGET, 1));
        // ~6h of aging (~3600 blocks) → difficulty ~10, ripe at the aggressive default.
        let d = calculate_difficulty(3600, MINE_TARGET);
        assert_eq!(is_ripe(3600, MINE_TARGET, 10), d <= 10);
        // Lower threshold (efficient) rejects the same partially-aged struct.
        assert!(!is_ripe(3600, MINE_TARGET, 1));
    }
}
