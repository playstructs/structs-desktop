//! Native auto-harvest loop — periodically re-mines (and optionally re-refines)
//! the team's structs WITHOUT the agent having to ask. The key efficiency idea:
//! after each mine/refine the PoW anchor resets and the next proof is
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
    /// throttles to this). 60 = every minute.
    ///
    /// A long interval does NOT reduce work, it only DELAYS it: ripeness is
    /// decided per struct by `difficulty_threshold`, so a scan that finds
    /// nothing ripe is cheap, and one that finds ripe work should act on it
    /// now rather than leave proofs aging for another half hour. The cost of
    /// scanning is bounded elsewhere — the mined-out guard skips drained
    /// planets, and the tx gate bounds signing pressure — so the interval is
    /// free to be short. It was raised to 1800 while runaway futile mining was
    /// being diagnosed; with that cause fixed, throttling the scan is just lost
    /// production, most visibly right after launch when a backlog is waiting.
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
            interval_secs: 60,
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

use crate::mcp::loop_util::{extract_type_id, parse_bool, parse_f64};

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

// PANIC-REFINE IS GONE, AND CANNOT COME BACK. It used to fire on a raid alarm
// to convert a seizable ore pile into unstealable Alpha before the raider took
// it. Chain v0.21.0 removed the opening: a planet under raid can neither mine
// nor refine, so a proof started on the alarm is refused no matter how fast we
// solve it. The call site was already retired; the body followed it here rather
// than sit around as a working-looking answer to "we're being raided".
// The defence that remains is combat, not economics — see auto_response.

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

    // (player_id, Some(vplayer index) | None for primary, capabilities).
    //
    // Refining and the explore precondition come from the player's PROFILE
    // rather than a role literal. The built-in profiles reproduce the old
    // reading exactly — bait never refines, because its ore pile IS the lure —
    // so nothing changes until an author says otherwise.
    let targets: Vec<(String, Option<u32>, crate::mcp::profile::Capabilities)> =
        crate::mcp::virtual_players::collect_targets(cfg.include_primary)
            .into_iter()
            .map(|(pid, idx, role)| {
                let caps = crate::mcp::profile::for_player(
                    crate::mcp::virtual_players::profile_of(&pid).as_deref(),
                    role,
                )
                .capabilities;
                (pid, idx, caps)
            })
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
    // Keep the shared perception snapshot current (no-op if fresh or already
    // refreshing). The scan below reads from it when it is fresh and from the
    // chain when it is not, so this never blocks the pass. Structs announced
    // since the last refresh get their one entity read here (bounded).
    crate::mcp::perception::maybe_refresh(&client);
    crate::mcp::perception::resolve_pending(&client, 50).await;
    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::effective_max_concurrent(),
        move |(pid, idx_opt, caps)| {
            let app = app.clone();
            let client = client.clone();
            let registry = registry.clone();
            let started = started_body.clone();
            let run = run_c.clone();
            async move {
                // Stand down while this player is answering a raid: charge is
                // one action per block and the response needs it. Deferral
                // only — the work happens on the next scan.
                if crate::mcp::combat_lists::is_held_for_combat(&pid) {
                    return;
                }
                run.players.fetch_add(1, Ordering::Relaxed);
                // Resolve THIS player's structs from its planet + fleet slot arrays.
                // The guild struct-LIST endpoints (owner AND location) are broken —
                // they ignore their filter and return a global page of every
                // player's structs, so scanning them meant we never saw a vplayer's
                // OWN extractor/refinery (refines never completed, explores never
                // fired, the whole fleet froze). See loop_util::player_struct_ids.
                //
                // SCAN reads come from the shared perception snapshot when it
                // is fresh (one whole-galaxy pull + GRASS deltas, see
                // mcp::perception) and from the chain otherwise; the read
                // right before a task is issued always goes to the chain.
                let (sids, scan_src) = crate::mcp::loop_util::scan_player_struct_ids(&client, &pid).await;
                let scanned_from_snapshot = scan_src == crate::mcp::loop_util::ReadSource::Snapshot;
                let mut extractor_planet: Option<String> = None;
                // The planet ENTITY, read at most ONCE per player per scan. It
                // carries BOTH the mined-out guard's ore reserve and — since
                // chain v0.21.0 — the shared ore clock this player's rigs
                // anchor their proofs on, so one read serves both.
                let mut planet_cache: Option<serde_json::Value> = None;
                let mut planet_fetched = false;
                // The PLAYER's stored ore, read at most once per player per scan
                // (see the futile-refine guard below).
                let mut player_ore_cache: Option<f64> = None;
                for sid in sids.iter() {
                    // The struct ENTITY is the reliable source for type + location +
                    // online + anchors (the struct-LIST endpoints are unusable, above).
                    let entity = match crate::mcp::loop_util::scan_entity(&client, "struct", sid).await {
                        Ok((e, _)) => e,
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
                    if !is_extractor && !(is_refinery && refine && caps.refines) {
                        continue;
                    }
                    // Chain v0.21.0: a planet under raid can neither mine nor
                    // refine — the chain rejects the completion, so issuing the
                    // task burns real GPU time on a proof that cannot land, and
                    // the completion sign spends the defender's once-per-block
                    // action mid-fight (see economy_steals_combat_charge; this
                    // is the same theft with a new mechanism). Difficulty keeps
                    // decaying while paused, so skipping costs nothing: the
                    // proof is CHEAPER when the raid ends and this loop
                    // re-issues on its next pass. Explore is deliberately NOT
                    // gated — re-planeting mid-raid is the defender's escape
                    // hatch, not a casualty of the pause.
                    if let Some(loc) = s.and_then(|x| x.get("locationId")).and_then(|x| x.as_str()) {
                        if crate::mcp::auto_response::planet_under_raid(loc) {
                            continue;
                        }
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
                    // The planet backs BOTH guards below and the proof anchor, so
                    // read it once here — a planetary rig's `locationId` IS its
                    // planet id. Fetched at most once per player per scan, and
                    // only ONCE even on failure, so a planet the LCD refuses
                    // can't spin a retry per struct.
                    if !planet_fetched {
                        planet_fetched = true;
                        if let Some(loc) = s.and_then(|x| x.get("locationId")).and_then(|x| x.as_str()) {
                            if let Ok((p, _)) = crate::mcp::loop_util::scan_entity(&client, "planet", loc).await {
                                planet_cache = Some(p);
                            }
                        }
                    }
                    let planet = planet_cache.as_ref();
                    // MINED-OUT GUARD. An extractor on a planet with no undiscovered
                    // ore can never complete: the chain rejects the completion, the
                    // anchor never resets, and this loop re-issues the task forever.
                    // Measured on 2026-07-30: one struct burned 448 solves in 16h
                    // (difficulty decaying 7→1 the whole time — proof of a frozen
                    // anchor), and 19 of 25 sampled fleet planets were drained, which
                    // accounted for ~95% of ALL GPU work.
                    if is_extractor {
                        // Unknown → don't block mining on a read failure.
                        let planet_ore = planet
                            .map(|p| parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))))
                            .unwrap_or(1.0);
                        if planet_ore <= 0.0 {
                            continue;
                        }
                    } else {
                        // THE SAME TRAP, ON THE REFINE SIDE. The guard above is
                        // extractor-only, so a refinery whose owner holds NO ore
                        // kept issuing proofs: the GPU solves them, and the
                        // completion is then rejected with "player (1-2136)
                        // cannot afford refine: requires ore". Refine cycles
                        // auto-restart, so the anchor never clears and the loop
                        // re-issues forever.
                        //
                        // Measured 2026-08-18: 41 such rejects in two hours from
                        // ONE player — the single largest error source in the
                        // whole system, and every one of them paid for with
                        // wasted proof-of-work.
                        if player_ore_cache.is_none() {
                            player_ore_cache = Some(match crate::mcp::loop_util::scan_entity(&client, "player", &pid).await {
                                Ok((p, _)) => parse_f64(p.get("gridAttributes").and_then(|g| g.get("ore"))),
                                // Unknown → don't block refining on a read failure.
                                Err(_) => 1.0,
                            });
                        }
                        if player_ore_cache.unwrap_or(1.0) <= 0.0 {
                            continue;
                        }
                    }
                    let (task_type, target) = if is_extractor {
                        ("MINE", MINE_TARGET)
                    } else {
                        ("REFINE", REFINE_TARGET)
                    };
                    // CHAIN v0.21.0: THE ORE CLOCK LIVES ON THE PLANET. It used to
                    // be a struct attribute; now one clock per planet is shared by
                    // every eligible rig standing on it, and the struct's own
                    // `blockStartOre*` fields survive for wire compatibility only,
                    // permanently reading 0. Reading the struct therefore returned
                    // anchor 0 for every extractor and refinery in the game and this
                    // loop skipped all of them — 28,812 player-scans an hour, ZERO
                    // tasks started, for 38 hours. That silence starved the whole
                    // flywheel downstream: no proofs, so no Alpha (auto_sweep idle
                    // for want of a single holder), and no ore for auto_raid to want.
                    let anchor = crate::mcp::loop_util::planet_ore_anchor(planet, task_type);
                    if anchor == 0 {
                        continue; // planet's clock is clear — nothing to hash against
                    }
                    // A proof for this exact cycle is already solved and waiting
                    // to be signed. The chain's clock stays put until it lands,
                    // so the struct still looks ripe and we would grind the very
                    // same proof again and queue a second, doomed completion
                    // behind the first. See hasher::PENDING_COMPLETIONS.
                    if crate::hasher::completion_in_flight(sid) == Some(anchor) {
                        continue;
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
                    // ── CHAIN RE-VERIFY before committing GPU work. ──
                    // Everything above may have come from the perception
                    // snapshot. The anchor and the rig's online state are
                    // action-gating (a wrong anchor is a proof that cannot
                    // land — the futile-mining incident), so when the scan was
                    // served from the snapshot, read the two entities that
                    // decide this task from the chain now: one planet read +
                    // one struct read per ISSUED task, instead of one per
                    // struct per scan. Both results fold back into the
                    // snapshot. A disagreement is logged: it is the measure of
                    // how far perception drifts, and the reason this step stays.
                    let mut anchor = anchor;
                    if scanned_from_snapshot {
                        let loc = s.and_then(|x| x.get("locationId")).and_then(|x| x.as_str()).unwrap_or("");
                        // Source-switched (mcp/verify.rs): Guild API by default.
                        let Ok(live_struct) = crate::mcp::verify::struct_state(&client, sid).await else { continue };
                        if !live_struct.online || live_struct.destroyed {
                            crate::mcp::telemetry::tlog(
                                "auto_harvest",
                                crate::mcp::telemetry::Sev::Notice,
                                format!("perception drift: {sid} scanned online, chain says not — skipped"),
                            );
                            continue;
                        }
                        // The ore clocks never stream; the LCD path folds the
                        // live planet back into the snapshot, the guild path
                        // reads the work view (one row per rig, one call).
                        let Ok(live_anchor) =
                            crate::mcp::verify::ore_anchor(&client, Some(&*pid), loc, sid, task_type).await
                        else {
                            continue;
                        };
                        if live_anchor != anchor {
                            crate::mcp::telemetry::tlog(
                                "auto_harvest",
                                crate::mcp::telemetry::Sev::Notice,
                                format!("perception drift: {sid} {task_type} anchor {anchor} scanned vs {live_anchor} on chain"),
                            );
                            anchor = live_anchor;
                            if anchor == 0
                                || crate::hasher::completion_in_flight(sid) == Some(anchor)
                                || !is_ripe(current_block.saturating_sub(anchor), target, difficulty_threshold)
                            {
                                continue;
                            }
                        }
                    }
                    let params = TaskParams::for_ore(sid, task_type, anchor, target);
                    if crate::hasher::start_hash_task_core(params, app.clone(), &registry).is_ok() {
                        if let Some(idx) = idx_opt {
                            crate::hasher::register_vplayer_hash(sid.clone(), idx, task_type.to_string());
                        }
                        started.fetch_add(1, Ordering::Relaxed);
                        run.actions.fetch_add(1, Ordering::Relaxed);
                        // Debug, not Info: one line per struct per scan was
                        // 5,041 events/hour (90% of the whole telemetry DB) on
                        // a 750-player fleet. The per-scan summary below keeps
                        // the loop observable at Info.
                        crate::mcp::telemetry::tlog(
                            "auto_harvest",
                            crate::mcp::telemetry::Sev::Debug,
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
                    if let (Some(_extractor_planet), Some(idx)) = (extractor_planet, idx_opt) {
                        // The planet to judge is the player's CURRENT planet from
                        // the CHAIN, not the extractor's location. After an
                        // explore the rig can linger on the old, drained planet
                        // (and the snapshot's player row still points there
                        // until refresh), so keying off the struct re-signed
                        // explores every scan for six minutes — each one a
                        // wasted sign slot and a chain reject ("new planet
                        // cannot be explored while current planet has ore").
                        // One chain read; this is the pre-sign verify for explore.
                        let Ok(live_player) = crate::mcp::verify::player_view(&client, &pid).await else { return };
                        let planet_id = live_player.planet_id.clone();
                        if planet_id.is_empty() {
                            return;
                        }
                        // unknown → don't explore
                        let planet_ore = crate::mcp::verify::planet_ore(&client, &planet_id).await.unwrap_or(1.0);
                        // Workers explore only once fully drained: stored ore <= 0 means
                        // every ore has been refined to Alpha (which survives explore).
                        // stored_ore already counts ore committed to an active refine cycle,
                        // so this alone prevents stranding — no separate "mid-refine" flag is
                        // needed. (That flag plus a residual sliver of un-refined ore was the
                        // deadlock that pinned mined-out workers: refine couldn't clear the
                        // ore because its cycle looked "stale", and the leftover ore then
                        // blocked the explore. With refines completing, the ore drains to 0
                        // and the worker moves on.)
                        let role_ready = if caps.explore_when_drained_only {
                            // Same chain read as above — the stored pile is on the player grid.
                            live_player.stored_ore <= 0.0
                        } else {
                            true // no stored pile to protect — re-planet at once
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
                                    // The snapshot's player row now points at a
                                    // planet that no longer exists for this player
                                    // and nothing streams the new id: read from the
                                    // chain for this player until the next refresh.
                                    crate::mcp::perception::forget_player(&pid);
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
