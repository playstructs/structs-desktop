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
// Pub: the roster sweep reuses these to estimate per-player cycle ETAs.
pub const MINE_TARGET: u64 = 14_000;
pub const REFINE_TARGET: u64 = 28_000;
pub const EXTRACTOR_TYPE: &str = "14";
// Ore Refinery is struct type 15 (verified live: worker refinery entities report
// `"type": 15, "type_name": "Ore Refinery"`). Was "16", so auto-refine never matched
// a refinery and the refine step of the flywheel never fired.
pub const REFINERY_TYPE: &str = "15";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoHarvestConfig {
    /// Master on/off. Off by default — the operator opts in (it auto-signs txs).
    pub enabled: bool,
    /// Kick off a task once the struct's current difficulty is ≤ this. Higher =
    /// more aggressive (mine sooner, pricier proof); lower = wait for cheaper.
    /// ~10 ≈ harvest ~6h after the last cycle; ~1 ≈ near-instant (~23h). Default
    /// 4 is deliberately patient: each proof is far cheaper (difficulty is
    /// exponential work), so one GPU can carry a much larger vplayer fleet.
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
            difficulty_threshold: 4,
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

/// The anchor age (in blocks) at which a proof becomes "ripe" for the given
/// threshold — the inverse of `calculate_difficulty`:
///   difficulty(age) = 64 − floor(log10(age)/log10(target)·63) ≤ t
///   ⇒ age ≥ target^((64−t)/63)
/// Used by the roster sweep to estimate time-to-next-completion per player.
pub fn ripe_age(difficulty_target: u64, threshold: u64) -> u64 {
    let t = threshold.min(64) as f64;
    let exp = (64.0 - t) / 63.0;
    (difficulty_target as f64).powf(exp).ceil() as u64
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
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = crate::mcp::telemetry::LoopRun::start("auto_harvest");
    scan(app_handle, &cfg, &run).await;
    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-scan".into()));
        return;
    }
    run.finish(Some(format!(
        "eff_conc={}",
        crate::mcp::loop_util::effective_max_concurrent()
    )));
    if run.errors.load(Ordering::Relaxed) == 0 {
        crate::mcp::loop_util::report_clean_scan();
    }
    HARVESTING.store(false, Ordering::SeqCst);
}

/// Run generation: bumped by every watchdog reset. See auto_build::RUN_GEN —
/// a scan whose generation went stale must not clear the guard or report
/// liveness (a newer scan owns them).
static RUN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Start a REFINE proof for `player_id` RIGHT NOW, ignoring both the loop's
/// cadence and its difficulty threshold.
///
/// Called by `auto_response` when a raid alarm fires. A raid seizes **all** of a
/// player's stored ore in one go, and refining is the only thing that converts
/// it into Alpha, which cannot be stolen — so during a raid the usual "wait for
/// the anchor to age into a cheap proof" economics are irrelevant. Even an
/// expensive proof beats losing the pile.
///
/// Independent of `AutoHarvestConfig::enabled`: hardening under fire must not
/// depend on the economy loop being switched on. No-ops when the player has no
/// online refinery, no ore, or a refine already in flight.
pub async fn request_priority_refine(app_handle: &tauri::AppHandle, player_id: &str) -> bool {
    let Some(registry) = app_handle.try_state::<Arc<TaskRegistry>>().map(|r| r.inner().clone()) else {
        return false;
    };
    let client = CosmosClient::new();
    let idx = crate::mcp::virtual_players::REGISTRY
        .read()
        .ok()
        .and_then(|r| {
            r.players
                .iter()
                .find(|p| p.player_id.as_deref() == Some(player_id))
                .map(|p| p.index)
        });

    for sid in crate::mcp::loop_util::player_struct_ids(&client, player_id).await {
        let Ok(entity) = client.query_entity("struct", &sid).await else { continue };
        let s = entity.get("Struct");
        let sa = entity.get("structAttributes");
        if s.map(extract_type_id).unwrap_or_default() != REFINERY_TYPE {
            continue;
        }
        if !parse_bool(sa.and_then(|x| x.get("isOnline"))) {
            continue;
        }
        if let Some(t) = registry.tasks.get(&sid) {
            if matches!(t.snapshot().status.as_str(), "running" | "waiting" | "starting") {
                return true; // already refining — nothing more to do
            }
        }
        let anchor = read_u64_field(sa, "blockStartOreRefine");
        if anchor == 0 {
            continue; // refinery isn't in a cycle, so there's nothing to complete
        }
        let params = TaskParams::for_ore(&sid, "REFINE", anchor, REFINE_TARGET);
        if crate::hasher::start_hash_task_core(params, app_handle.clone(), &registry).is_ok() {
            if let Some(i) = idx {
                crate::hasher::register_vplayer_hash(sid.clone(), i, "REFINE".to_string());
            }
            crate::mcp::telemetry::tlog(
                "auto_harvest",
                crate::mcp::telemetry::Sev::Notice,
                format!("priority REFINE {} for {} (under attack — ore is seizable)", sid, player_id),
            );
            return true;
        }
    }
    false
}

/// Watchdog remediation: invalidate the wedged scan and clear the
/// single-flight guard so the next tick can scan again.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    HARVESTING.store(false, Ordering::SeqCst);
}

async fn scan(
    app_handle: &tauri::AppHandle,
    cfg: &AutoHarvestConfig,
    run: &Arc<crate::mcp::telemetry::LoopRun>,
) {
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
    let run_c = run.clone();
    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::effective_max_concurrent(),
        move |(pid, idx_opt, may_refine)| {
            let app = app.clone();
            let client = client.clone();
            let registry = registry.clone();
            let started = started_body.clone();
            let run = run_c.clone();
            async move {
                run.players.fetch_add(1, Ordering::Relaxed);
                // Resolve THIS player's structs from its planet + fleet slot arrays.
                // The guild struct-LIST endpoints (owner AND location) are broken —
                // they ignore their filter and return a global page of every
                // player's structs, so scanning them meant we never saw a vplayer's
                // OWN extractor/refinery (refines never completed, explores never
                // fired, the whole fleet froze). See loop_util::player_struct_ids.
                let sids = crate::mcp::loop_util::player_struct_ids(&client, &pid).await;
                let mut extractor_planet: Option<String> = None;
                for sid in sids.iter() {
                    // The struct ENTITY is the reliable source for type + location +
                    // online + anchors (the struct-LIST endpoints are unusable, above).
                    let entity = match client.query_entity("struct", sid).await {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let s = entity.get("Struct");
                    let sa = entity.get("structAttributes");
                    let type_id = s.map(extract_type_id).unwrap_or_default();
                    let is_extractor = type_id == EXTRACTOR_TYPE;
                    let is_refinery = type_id == REFINERY_TYPE;
                    // A planetary extractor's locationId IS the player's planet id → the
                    // anchor the auto-explore block below keys off.
                    if is_extractor && !parse_bool(sa.and_then(|x| x.get("isDestroyed"))) {
                        if let Some(loc) = s.and_then(|x| x.get("locationId")).and_then(|x| x.as_str()) {
                            extractor_planet = Some(loc.to_string());
                        }
                    }
                    // Refine only for productive players (and if the config allows it);
                    // bait players mine only.
                    if !is_extractor && !(is_refinery && refine && may_refine) {
                        continue;
                    }
                    // Skip if a task for this struct is already in flight (completed ones
                    // linger in the registry — those we DO allow to re-issue).
                    if let Some(t) = registry.tasks.get(sid) {
                        if matches!(t.snapshot().status.as_str(), "running" | "waiting" | "starting") {
                            continue;
                        }
                    }
                    if !parse_bool(sa.and_then(|x| x.get("isOnline"))) {
                        continue;
                    }
                    let (task_type, target, anchor) = if is_extractor {
                        ("MINE", MINE_TARGET, read_u64_field(sa, "blockStartOreMine"))
                    } else {
                        ("REFINE", REFINE_TARGET, read_u64_field(sa, "blockStartOreRefine"))
                    };
                    if anchor == 0 {
                        continue; // not in a cycle (extractor between mines / refinery idle)
                    }
                    let age = current_block.saturating_sub(anchor);
                    // Refines do NOT expire. An aged refine anchor is simply a LOW-difficulty
                    // (cheap) proof — exactly like an aged mine — so it completes instantly
                    // and the chain auto-restarts the cycle (resets blockStartOreRefine).
                    // Verified live: completing a 49k-block-old "stale" refine yielded Alpha
                    // and reset the anchor. The old STALE_REFINE_BLOCKS guard skipped these as
                    // "unrecoverable", which silently froze the ENTIRE productive refine leg
                    // (0 Alpha across 116 workers holding 461 ore). Removed — an old anchor is
                    // the EASIEST alpha, not a phantom.
                    if !is_ripe(age, target, difficulty_threshold) {
                        continue;
                    }
                    let params = TaskParams::for_ore(sid, task_type, anchor, target);
                    if crate::hasher::start_hash_task_core(params, app.clone(), &registry).is_ok() {
                        if let Some(idx) = idx_opt {
                            crate::hasher::register_vplayer_hash(sid.clone(), idx, task_type.to_string());
                        }
                        started.fetch_add(1, Ordering::Relaxed);
                        run.actions.fetch_add(1, Ordering::Relaxed);
                        crate::mcp::telemetry::tlog(
                            "auto_harvest",
                            crate::mcp::telemetry::Sev::Info,
                            format!(
                                "{} {} (age {}, difficulty {} ≤ {})",
                                task_type,
                                sid,
                                age,
                                calculate_difficulty(age, target),
                                difficulty_threshold
                            ),
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
                // Exploring destroys ALL of the old planet's structs (incl. a PRODUCTIVE
                // worker's planetary Ore Refinery) and migrates the fleet; storedOre
                // carries over, and auto-build + auto-defend rebuild the new planet.
                //   • BAIT (`!may_refine`): explore as soon as the planet is mined out.
                //   • WORKERS (`may_refine`): explore only once FULLY drained — planet out
                //     AND not mid-refine AND storedOre refined to ~0 — so we never destroy
                //     the refinery mid-cycle or strand un-refined ore (refine-it-all-first;
                //     Alpha survives explore, the refinery rebuilds on the new planet).
                if auto_explore {
                    if let (Some(planet_id), Some(idx)) = (extractor_planet, idx_opt) {
                        let planet_ore = match client.query_entity("planet", &planet_id).await {
                            Ok(p) => parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))),
                            Err(_) => 1.0, // unknown → don't explore
                        };
                        // Workers explore only once fully drained: stored ore <= 0 means
                        // every ore has been refined to Alpha (which survives explore).
                        // stored_ore already counts ore committed to an active refine cycle,
                        // so this alone prevents stranding — no separate "mid-refine" flag is
                        // needed. (That flag plus a residual sliver of un-refined ore was the
                        // deadlock that pinned mined-out workers: refine couldn't clear the
                        // ore because its cycle looked "stale", and the leftover ore then
                        // blocked the explore. With refines completing, the ore drains to 0
                        // and the worker moves on.)
                        let role_ready = if may_refine {
                            match client.query_entity("player", &pid).await {
                                Ok(p) => parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))) <= 0.0,
                                Err(_) => false, // unknown → don't explore
                            }
                        } else {
                            true // bait: no refinery to protect
                        };
                        if planet_ore <= 0.0 && role_ready {
                            let res = crate::mcp::tx_retry::sign_with_retry(
                                &app,
                                idx,
                                "/structs.structs.MsgPlanetExplore",
                                serde_json::json!({ "playerId": pid }),
                                &format!("auto_harvest:{pid}"),
                            )
                            .await;
                            match res {
                                Ok(_) => {
                                    // Planet changed → bust the owned-cache so threat
                                    // detection re-resolves this player's new planet.
                                    crate::mcp::virtual_players::invalidate_owned(&pid);
                                    run.actions.fetch_add(1, Ordering::Relaxed);
                                    crate::mcp::telemetry::tlog(
                                        "auto_harvest",
                                        crate::mcp::telemetry::Sev::Notice,
                                        format!("explored (planet {} mined out) for {}", planet_id, pid),
                                    );
                                    crate::mcp::board_feed::push(
                                        &app,
                                        crate::mcp::board_feed::Severity::Notice,
                                        "auto_harvest",
                                        format!("{} explored to a fresh planet ({} mined out)", pid, planet_id),
                                    );
                                }
                                Err(e) => {
                                    run.errors.fetch_add(1, Ordering::Relaxed);
                                    crate::mcp::telemetry::tlog(
                                        "auto_harvest",
                                        crate::mcp::telemetry::Sev::Warn,
                                        format!("explore failed for {pid}: {e}"),
                                    );
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
        crate::mcp::telemetry::tlog(
            "auto_harvest",
            crate::mcp::telemetry::Sev::Info,
            format!("started {} task(s)", started),
        );
        crate::mcp::board_feed::push(
            app_handle,
            crate::mcp::board_feed::Severity::Info,
            "auto_harvest",
            format!("started {} mine/refine task(s)", started),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_off_and_aggressive_threshold() {
        let c = AutoHarvestConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.difficulty_threshold, 4);
        assert!(c.refine);
        assert!(!c.include_primary);
    }

    #[test]
    fn ripe_age_inverts_difficulty_decay() {
        for threshold in [1u64, 4, 10, 32] {
            for target in [MINE_TARGET, REFINE_TARGET] {
                let a = ripe_age(target, threshold);
                assert!(is_ripe(a, target, threshold), "age {a} should be ripe (t={threshold})");
                assert!(
                    a < 3 || !is_ripe(a * 9 / 10, target, threshold),
                    "10% younger than {a} should not be ripe (t={threshold})"
                );
            }
        }
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
