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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
}

impl Default for AutoHarvestConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            difficulty_threshold: 10,
            interval_secs: 1800,
            refine: true,
            include_primary: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<AutoHarvestConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static HARVESTING: AtomicBool = AtomicBool::new(false);

fn path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join(FILENAME))
}

fn load() -> AutoHarvestConfig {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn get() -> AutoHarvestConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: AutoHarvestConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    if let (Some(p), Ok(json)) = (path(), serde_json::to_string_pretty(&cfg)) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, json);
    }
}

/// The decision: is a struct ripe to harvest at the given threshold?
pub fn is_ripe(age: u64, difficulty_target: u64, threshold: u64) -> bool {
    calculate_difficulty(age, difficulty_target) <= threshold
}

fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn read_anchor(sa: Option<&Value>, field: &str) -> u64 {
    sa.and_then(|x| x.get(field))
        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}

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
    let mut targets: Vec<(String, Option<u32>, bool)> = {
        let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
        reg.players
            .iter()
            .filter_map(|p| {
                p.player_id
                    .clone()
                    .map(|pid| (pid, Some(p.index), p.role == VPlayerRole::Productive))
            })
            .collect()
    };
    if cfg.include_primary {
        if let Some(pid) = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone()) {
            if !pid.is_empty() {
                targets.push((pid, None, true)); // primary may refine
            }
        }
    }

    let mut started = 0u32;
    for (pid, idx_opt, may_refine) in targets {
        let page = match client.guild.struct_list_by_owner(&pid, 1).await {
            Ok(p) => p,
            Err(_) => continue,
        };
        for s in page.items.iter() {
            let Some(sid) = s.get("id").and_then(|x| x.as_str()).map(String::from) else {
                continue;
            };
            let type_id = s
                .get("type")
                .or_else(|| s.get("struct_type"))
                .map(|x| match x {
                    Value::Number(n) => n.to_string(),
                    Value::String(t) => t.clone(),
                    _ => String::new(),
                })
                .unwrap_or_default();
            let is_extractor = type_id == EXTRACTOR_TYPE;
            let is_refinery = type_id == REFINERY_TYPE;
            // Refine only for productive players (and if the config allows it);
            // bait players mine only.
            if !is_extractor && !(is_refinery && cfg.refine && may_refine) {
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
            if !truthy(sa.and_then(|x| x.get("isOnline"))) {
                continue;
            }
            let (task_type, target, anchor) = if is_extractor {
                ("MINE", MINE_TARGET, read_anchor(sa, "blockStartOreMine"))
            } else {
                ("REFINE", REFINE_TARGET, read_anchor(sa, "blockStartOreRefine"))
            };
            if anchor == 0 {
                continue; // not in a cycle (extractor offline-cycle / refinery has no stored ore)
            }
            if is_refinery {
                // Refining needs stored ore.
                if num(entity.get("gridAttributes").and_then(|g| g.get("ore"))) <= 0.0 {
                    continue;
                }
            }
            let age = current_block.saturating_sub(anchor);
            if !is_ripe(age, target, cfg.difficulty_threshold) {
                continue;
            }
            let params = TaskParams::for_ore(&sid, task_type, anchor, target);
            if crate::hasher::start_hash_task_core(params, app_handle.clone(), &registry).is_ok() {
                if let Some(idx) = idx_opt {
                    crate::hasher::register_vplayer_hash(sid.clone(), idx, task_type.to_string());
                }
                started += 1;
                eprintln!(
                    "[Auto-Harvest] {} {} (age {}, difficulty {} ≤ {})",
                    task_type,
                    sid,
                    age,
                    calculate_difficulty(age, target),
                    cfg.difficulty_threshold
                );
            }
        }
    }
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
