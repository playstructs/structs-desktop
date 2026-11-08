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

use crate::hasher::types::{now_millis, TaskParams, TaskRegistry};
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_harvest.json";
// The roster sweep's per-player cycle ETA model. The harvest scan itself
// takes each rig's range from the chain's struct-type catalogue (mirror).
pub const MINE_TARGET: u64 = 14_000;
pub const REFINE_TARGET: u64 = 28_000;

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
    /// refinery for productive) on the new planet. On by default: a mined-out
    /// planet produces nothing, so leaving it is the only way the economy keeps
    /// running; the rebuild is the price of that, not a reason to sit idle.
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
            auto_explore: true,
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

/// Is work aged `age` against `difficulty_target` ripe at the threshold?
/// The chain's own integer curve (mirror::rules).
pub fn is_ripe(age: u64, difficulty_target: u64, threshold: u64) -> bool {
    crate::mirror::rules::difficulty(age, difficulty_target) <= threshold
}

/// The anchor age at which work becomes ripe at the threshold: the exact
/// inverse of the chain's curve (mirror::rules::ready_age). Used by the
/// roster sweep for per-player cycle ETAs.
pub fn ripe_age(difficulty_target: u64, threshold: u64) -> u64 {
    crate::mirror::rules::ready_age(difficulty_target, threshold).unwrap_or(difficulty_target)
}

/// One ripe rig the mirror says the chain will accept work from.
#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    pub struct_id: String,
    pub kind: crate::mcp::types::TaskType,
    pub anchor: u64,
    /// The struct TYPE's own difficulty range, from the chain's catalogue.
    pub range: u64,
    pub planet: String,
}

/// What a scan does, decided from the mirror's forecasts.
#[derive(Debug, Default)]
pub struct Plan {
    /// Ripe, accepted work per owner.
    pub picks: std::collections::HashMap<String, Vec<Pick>>,
    /// Owners whose extractor stands on a planet with no buried ore — the
    /// chain's own `empty` refusal, and the cue to explore.
    pub mined_out: std::collections::HashSet<String>,
    /// Ripe-or-blocked work NOT started, by the reason the chain would give.
    pub skipped: std::collections::BTreeMap<&'static str, u64>,
    /// The first height any WAITING work ripens at — when this loop next has
    /// something to start (the scheduler wakes it then).
    pub next_due: Option<u64>,
    /// Mined-out owners with no ore left to refine: they can explore now.
    pub explore_ready: usize,
}

/// Turn forecasts into a scan plan. Pure. Work is started only when the
/// forecast is READY: ripe at the execution height and every precondition the
/// chain checks met. Blocked work is counted by the blocking rule; work with
/// an undecidable precondition is counted as `unsure` and not hashed — GPU
/// time is never spent on a proof the chain may refuse for a reason we can
/// already see.
pub fn plan(forecasts: &[crate::mirror::forecast::Forecast], may_refine: impl Fn(&str) -> bool) -> Plan {
    use crate::mirror::forecast::{CheckState, Kind, Status};
    use crate::mcp::types::TaskType;
    let mut out = Plan::default();
    // Owners whose refinery still has ore to work through: not explore-ready.
    let mut still_refining: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for f in forecasts {
        let kind = match f.kind {
            Kind::Mine => TaskType::Mine,
            Kind::Refine if may_refine(&f.owner) => TaskType::Refine,
            _ => continue,
        };
        if kind == TaskType::Mine
            && f.checks.iter().any(|c| c.rule == "empty" && c.state == CheckState::Blocked && c.exact)
        {
            out.mined_out.insert(f.owner.clone());
        }
        if kind == TaskType::Refine && !f.checks.iter().any(|c| c.rule == "ore" && c.state == CheckState::Blocked) {
            still_refining.insert(f.owner.as_str());
        }
        match f.status {
            Status::Waiting => {
                if let Some(h) = f.ready_height {
                    out.next_due = Some(out.next_due.map_or(h, |d: u64| d.min(h)));
                }
            }
            Status::Blocked => {
                for c in f.checks.iter().filter(|c| c.state == CheckState::Blocked) {
                    *out.skipped.entry(c.rule).or_insert(0) += 1;
                }
            }
            Status::Uncertain => *out.skipped.entry("unsure").or_insert(0) += 1,
            Status::Ready => {
                let Some(planet) = f.planet.clone() else { continue };
                if f.anchor == 0 {
                    *out.skipped.entry("no_clock").or_insert(0) += 1;
                    continue;
                }
                out.picks.entry(f.owner.clone()).or_default().push(Pick {
                    struct_id: f.subject.clone(),
                    kind,
                    anchor: f.anchor,
                    range: f.range,
                    planet,
                });
            }
        }
    }
    out.explore_ready = out.mined_out.iter().filter(|o| !still_refining.contains(o.as_str())).count();
    out
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
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = crate::mcp::telemetry::LoopRun::start("auto_harvest");
    scan(app_handle, &cfg, &run).await;
    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-scan".into()));
        return;
    }
    run.finish(Some(format!(
        "eff_conc={}",
        crate::mcp::capacity::reads_fanout()
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
    let targets: Vec<(crate::mcp::types::PlayerId, Option<u32>, crate::mcp::profile::Capabilities)> =
        crate::mcp::virtual_players::collect_targets(cfg.include_primary)
            .into_iter()
            .map(|(pid, idx, role)| {
                let caps = crate::mcp::profile::for_player(
                    crate::mcp::virtual_players::profile_of(pid.as_str()).as_deref(),
                    role,
                )
                .capabilities;
                (pid, idx, caps)
            })
            .collect();

    // Keep the shared perception snapshot current (no-op if fresh or already
    // refreshing), and never fan out to the chain just because the launch
    // refresh has not landed yet (that was ~59k LCD requests per launch).
    crate::mcp::perception::maybe_refresh(&client);
    crate::mcp::loop_util::ensure_perception(&client, "auto_harvest", 120_000.0).await;
    crate::mcp::perception::resolve_pending(&client, 50).await;

    // ── WHAT TO HASH: the mirror decides. ──
    // One forecast over the whole team from the snapshot: the chain's own
    // rules — the planet's ore clock, the TYPE's own difficulty range, the
    // integer difficulty curve at the height a completion would execute — and
    // every precondition the chain checks beside them (offline, owner power,
    // no buried ore, no stored ore, under raid, mining/refining inactive).
    // Only work the chain would accept is started; anything blocked or
    // undecidable is counted, never hashed. This is where the futile-mining
    // and futile-refine guards now live, as the chain's rules rather than
    // hand-written skips.
    let owners: Vec<String> = targets.iter().map(|(p, _, _)| p.as_str().to_string()).collect();
    let opts = crate::mirror::forecast::Options { target: cfg.difficulty_threshold, within: None, project: false, verify: false };
    let Some(now) = crate::mirror::forecast_now(None, Some(&owners), &opts).await else {
        crate::mcp::telemetry::tlog("auto_harvest", crate::mcp::telemetry::Sev::Notice, "no snapshot or chain clock yet — scan deferred");
        return;
    };
    let refiners: std::collections::HashSet<String> = targets
        .iter()
        .filter(|(_, _, caps)| cfg.refine && caps.refines)
        .map(|(p, _, _)| p.as_str().to_string())
        .collect();
    let plan = plan(&now.forecasts, |owner| refiners.contains(owner));
    // Tell the scheduler when this loop next has work: the first waiting
    // rig's ripening height, and how many players can explore now.
    crate::mcp::schedule::report(
        "auto_harvest",
        plan.next_due,
        if cfg.auto_explore { plan.explore_ready } else { 0 },
        format!(
            "{} rigs ripe, {} explore-ready, skipped {:?}",
            plan.picks.values().map(Vec::len).sum::<usize>(),
            plan.explore_ready,
            plan.skipped
        ),
    );
    if !plan.skipped.is_empty() {
        let parts: Vec<String> = plan.skipped.iter().map(|(r, n)| format!("{r} {n}")).collect();
        crate::mcp::telemetry::tlog(
            "auto_harvest",
            crate::mcp::telemetry::Sev::Debug,
            format!("mirror: {} ripe, not started — {}", plan.picks.values().map(Vec::len).sum::<usize>(), parts.join(", ")),
        );
    }
    // Prove what each pick's last check reads — the rig's status and the
    // planet's clock — in ONE batch against a header the light client
    // verified. Unprovable facts fall back to the ordinary reads below.
    let facts: Vec<crate::mirror::verify::Fact> = plan
        .picks
        .values()
        .flatten()
        .flat_map(|p| {
            use crate::mirror::verify::{Fact, Store};
            let clock = if p.kind == crate::mcp::types::TaskType::Mine { "blockStartOreMine" } else { "blockStartOreRefine" };
            [
                Fact { store: Store::Struct, attribute: "status", object: p.struct_id.clone() },
                Fact { store: Store::Planet, attribute: clock, object: p.planet.clone() },
            ]
        })
        .collect();
    let proven = Arc::new(crate::mirror::verify::prove_for("auto_harvest", &facts).await);
    let plan = Arc::new(plan);

    // Fan out the per-player body with bounded concurrency so every player is
    // scanned in the same wave (≤ MAX_CONCURRENT_PLAYERS in flight) instead of
    // serially — the serial walk reached the tail cohort minutes late.
    let started = Arc::new(AtomicU32::new(0));
    let started_body = started.clone();
    let auto_explore = cfg.auto_explore;
    let app = app_handle.clone();
    let run_c = run.clone();
    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::capacity::reads_fanout(),
        move |(pid, idx_opt, caps)| {
            let app = app.clone();
            let client = client.clone();
            let registry = registry.clone();
            let started = started_body.clone();
            let run = run_c.clone();
            let plan = plan.clone();
            let proven = proven.clone();
            async move {
                // Stand down while this player is answering a raid: charge is
                // one action per block and the response needs it. Deferral
                // only — the work happens on the next scan.
                if crate::mcp::combat_lists::is_held_for_combat(pid.as_str()) {
                    return;
                }
                run.players.fetch_add(1, Ordering::Relaxed);
                let mined_out = plan.mined_out.contains(pid.as_str());
                for pick in plan.picks.get(pid.as_str()).into_iter().flatten() {
                    let sid = &pick.struct_id;
                    // Skip if a task for this struct is already in flight
                    // (completed ones linger in the registry — those we DO
                    // allow to re-issue).
                    if let Some(t) = registry.tasks.get(sid) {
                        if matches!(t.snapshot().status.as_str(), "running" | "waiting" | "starting") {
                            continue;
                        }
                    }
                    // A proof for this exact cycle is already solved and
                    // waiting to be signed: the chain's clock stays put until
                    // it lands, so it still looks ripe. See
                    // hasher::PENDING_COMPLETIONS.
                    if crate::hasher::completion_in_flight(sid) == Some(pick.anchor) {
                        continue;
                    }
                    // ── CHAIN RE-VERIFY before committing GPU work. ──
                    // The forecast ran on the snapshot. The anchor and the
                    // rig's online state decide whether a proof can land (a
                    // wrong anchor is the futile-mining incident), so the two
                    // entities that decide this task are read from the chain
                    // now: one planet read + one struct read per ISSUED task.
                    // Both fold back into the snapshot. A disagreement is
                    // logged: it measures how far perception drifts.
                    use crate::mirror::verify::Store;
                    let clock = if pick.kind == crate::mcp::types::TaskType::Mine { "blockStartOreMine" } else { "blockStartOreRefine" };
                    let proven_status = proven.as_ref().as_ref().and_then(|b| b.get(Store::Struct, "status", sid));
                    let proven_clock = proven.as_ref().as_ref().and_then(|b| b.get(Store::Planet, clock, &pick.planet));
                    let (online, destroyed) = match proven_status {
                        Some(st) => (
                            st & crate::mcp::perception::status::ONLINE != 0,
                            st & crate::mcp::perception::status::DESTROYED != 0,
                        ),
                        None => {
                            let Ok(sid_t) = crate::mcp::types::StructId::parse(sid) else { continue };
                            let Ok(live_struct) = crate::mcp::verify::struct_state(&client, &sid_t).await else { continue };
                            (live_struct.online, live_struct.destroyed)
                        }
                    };
                    if !online || destroyed {
                        crate::mcp::telemetry::tlog(
                            "auto_harvest",
                            crate::mcp::telemetry::Sev::Notice,
                            format!("perception drift: {sid} forecast online, chain says not — skipped"),
                        );
                        continue;
                    }
                    let live_anchor = match proven_clock {
                        Some(c) => crate::mcp::types::Block::new(c),
                        None => {
                            let Ok(planet_t) = crate::mcp::types::PlanetId::parse(&pick.planet) else { continue };
                            let Ok(a) = crate::mcp::verify::ore_anchor(&client, &planet_t, pick.kind).await else { continue };
                            a
                        }
                    };
                    let mut anchor = pick.anchor;
                    if live_anchor.get() != anchor {
                        crate::mcp::telemetry::tlog(
                            "auto_harvest",
                            crate::mcp::telemetry::Sev::Notice,
                            format!("perception drift: {sid} {} anchor {anchor} forecast vs {} on chain", pick.kind, live_anchor.get()),
                        );
                        anchor = live_anchor.get();
                        let exec = crate::mirror::rules::earliest_execution(now.tip);
                        let ripe = anchor != 0
                            && crate::mirror::rules::ready_height(anchor, pick.range, opts.target).is_some_and(|h| h <= exec);
                        if !ripe || crate::hasher::completion_in_flight(sid) == Some(anchor) {
                            continue;
                        }
                    }
                    let params = TaskParams::for_ore(sid, pick.kind.as_str(), anchor, pick.range);
                    if crate::hasher::start_hash_task_core(params, app.clone(), &registry).is_ok() {
                        if let Some(idx) = idx_opt {
                            crate::hasher::register_vplayer_hash(sid.clone(), idx, pick.kind);
                        }
                        started.fetch_add(1, Ordering::Relaxed);
                        run.actions.fetch_add(1, Ordering::Relaxed);
                        // Debug, not Info: one line per struct per scan was
                        // 5,041 events/hour on a 750-player fleet.
                        crate::mcp::telemetry::tlog(
                            "auto_harvest",
                            crate::mcp::telemetry::Sev::Debug,
                            format!("{} {sid} (anchor {anchor}, range {}, aim {})", pick.kind, pick.range, opts.target),
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
                    // The mirror found this player's extractor on a planet
                    // with no buried ore — the chain's own `empty` refusal.
                    if let (true, Some(idx)) = (mined_out, idx_opt) {
                        // The planet to judge is the player's CURRENT planet from
                        // the CHAIN, not the extractor's location. After an
                        // explore the rig can linger on the old, drained planet
                        // (and the snapshot's player row still points there
                        // until refresh), so keying off the struct re-signed
                        // explores every scan for six minutes — each one a
                        // wasted sign slot and a chain reject ("new planet
                        // cannot be explored while current planet has ore").
                        // One chain read; this is the pre-sign verify for explore.
                        // LIVE (guild → LCD), never the snapshot: the snapshot moved
                        // players only at refresh until the fleet_arrive arm landed,
                        // and 59 explores a day were signed against the planet the
                        // player had already left.
                        let Ok(live_player) = crate::mcp::verify::player_view_live(&client, &pid).await else { return };
                        let Some(planet_id) = live_player.planet_id.clone() else {
                            return;
                        };
                        // unknown → don't explore
                        let planet_ore = crate::mcp::verify::planet_ore_live(&client, &planet_id).await.unwrap_or(1.0);
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
                                crate::mcp::types::Context::player_action("auto_harvest", &pid),
                            )
                            .await;
                            match res {
                                Ok(_) => {
                                    // Planet changed → bust the owned-cache so threat
                                    // detection re-resolves this player's new planet.
                                    crate::mcp::virtual_players::invalidate_owned(pid.as_str());
                                    // The snapshot's player row now points at a
                                    // planet that no longer exists for this player
                                    // and nothing streams the new id: read from the
                                    // chain for this player until the next refresh.
                                    crate::mcp::perception::forget_player(pid.as_str());
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
        // Re-planeting a mined-out planet is how the economy keeps running;
        // the loop's explore branch itself skips the primary (no HD index).
        assert!(c.auto_explore);
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
        let d = crate::mirror::rules::difficulty(3600, MINE_TARGET);
        assert_eq!(is_ripe(3600, MINE_TARGET, 10), d <= 10);
        // Lower threshold (efficient) rejects the same partially-aged struct.
        assert!(!is_ripe(3600, MINE_TARGET, 1));
    }

    fn fc(kind: crate::mirror::forecast::Kind, sid: &str, owner: &str, status: crate::mirror::forecast::Status, checks: Vec<crate::mirror::forecast::Check>) -> crate::mirror::forecast::Forecast {
        crate::mirror::forecast::Forecast {
            kind,
            subject: sid.into(),
            owner: owner.into(),
            label: "rig".into(),
            planet: Some("2-1".into()),
            anchor: 100,
            range: 14_000,
            target: 4,
            ready_height: Some(200),
            blocks_away: Some(0),
            difficulty_now: Some(4),
            status,
            exact: true,
            checks,
        }
    }

    fn blocked(rule: &'static str) -> crate::mirror::forecast::Check {
        crate::mirror::forecast::Check { rule, state: crate::mirror::forecast::CheckState::Blocked, exact: true, detail: String::new() }
    }

    #[test]
    fn only_ready_work_is_started() {
        use crate::mirror::forecast::{Kind, Status};
        let f = vec![
            fc(Kind::Mine, "5-1", "1-1", Status::Ready, vec![]),
            fc(Kind::Mine, "5-2", "1-2", Status::Waiting, vec![]),
            fc(Kind::Mine, "5-3", "1-3", Status::Uncertain, vec![]),
            fc(Kind::Refine, "5-4", "1-1", Status::Blocked, vec![blocked("ore")]),
        ];
        let p = plan(&f, |_| true);
        assert_eq!(p.picks.len(), 1);
        assert_eq!(p.picks["1-1"][0].struct_id, "5-1");
        assert_eq!(p.picks["1-1"][0].range, 14_000, "the type's own range, not a constant");
        assert_eq!(p.skipped.get("ore"), Some(&1));
        assert_eq!(p.skipped.get("unsure"), Some(&1));
    }

    #[test]
    fn an_empty_planet_marks_the_owner_for_explore_and_is_never_hashed() {
        use crate::mirror::forecast::{Kind, Status};
        let p = plan(&[fc(Kind::Mine, "5-1", "1-9", Status::Blocked, vec![blocked("empty")])], |_| true);
        assert!(p.mined_out.contains("1-9"));
        assert!(p.picks.is_empty());
    }

    #[test]
    fn refining_follows_the_owners_profile() {
        use crate::mirror::forecast::{Kind, Status};
        let f = vec![fc(Kind::Refine, "5-4", "1-1", Status::Ready, vec![])];
        assert!(plan(&f, |_| false).picks.is_empty(), "bait never refines");
        assert_eq!(plan(&f, |_| true).picks["1-1"][0].kind, crate::mcp::types::TaskType::Refine);
    }

    #[test]
    fn a_clear_clock_is_never_hashed() {
        use crate::mirror::forecast::{Kind, Status};
        let mut f = fc(Kind::Mine, "5-1", "1-1", Status::Ready, vec![]);
        f.anchor = 0;
        let p = plan(&[f], |_| true);
        assert!(p.picks.is_empty());
        assert_eq!(p.skipped.get("no_clock"), Some(&1));
    }

    #[test]
    fn the_plan_reports_when_work_is_next_due_and_who_can_explore() {
        use crate::mirror::forecast::{Kind, Status};
        let mut waiting = fc(Kind::Mine, "5-1", "1-1", Status::Waiting, vec![]);
        waiting.ready_height = Some(900);
        let mut later = fc(Kind::Mine, "5-2", "1-2", Status::Waiting, vec![]);
        later.ready_height = Some(1_200);
        let f = vec![
            waiting,
            later,
            // 1-3: mined out, pile empty → can explore.
            fc(Kind::Mine, "5-3", "1-3", Status::Blocked, vec![blocked("empty")]),
            fc(Kind::Refine, "5-4", "1-3", Status::Blocked, vec![blocked("ore")]),
            // 1-4: mined out, still refining → not yet.
            fc(Kind::Mine, "5-5", "1-4", Status::Blocked, vec![blocked("empty")]),
            fc(Kind::Refine, "5-6", "1-4", Status::Waiting, vec![]),
        ];
        let p = plan(&f, |_| true);
        assert_eq!(p.next_due, Some(200), "the earliest waiting work (5-6's default 200)");
        assert_eq!(p.mined_out.len(), 2);
        assert_eq!(p.explore_ready, 1);
    }
}
