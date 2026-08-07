//! Native raid-response loop — the defensive half of autonomous combat.
//!
//! ## Why this exists, and why it is fast
//!
//! `planet_activity` (92k events, 2026-03 → 2026-07) says the entire defensive
//! game is decided in the first two minutes:
//!
//! * A raid runs `initiated` → `shieldsVulnerable` → seize. Median time from
//!   `initiated` to `shieldsVulnerable` is **2.1 min**, and the vulnerable→loot
//!   lock is a hard **22 blocks ≈ 2 min 6 s**. So the whole response budget is
//!   roughly four minutes from the moment a hostile fleet arrives.
//! * Of the 16 raids in the entire dataset that ended `attackerDefeated`,
//!   **16/16 had the defender shooting back within ~1.8 min**. Of the 123 that
//!   ended `raidSuccessful`, only 11 saw any return fire at all, median 12.3 min
//!   — far too late.
//! * Destroying the raider's **Command Ship** ends the raid outright: 16/16
//!   `attackerDefeated` episodes had it, 0/279 other outcomes did. It is the one
//!   deterministic lever in the game, and the raiding Command Ship is parked at
//!   OUR planet for the duration, which is what makes it reachable.
//!
//! So this loop triggers on `raid_status: initiated` (not on damage), resolves
//! the raiding fleet's Command Ship, and fires every co-located shooter at it.
//!
//! ## Two things that constrain shooter selection
//!
//! 1. **Combat is co-located.** Every `struct_attack` in the dataset originates
//!    from a fleet, and a struct can only be hit by something at its location.
//!    Our other 180 vplayers sit at their own planets, so their charge bars are
//!    irrelevant here: the responders are the attacked player's own on-station
//!    fleet plus anyone else already parked at that planet.
//! 2. **GRASS stubs real fights.** A `struct_attack` payload over ~8 KB — which
//!    any multi-shot exchange produces — arrives as `{category, stub:"true"}`
//!    with no attacker fields. Detection therefore runs off the effect events
//!    that always stream in full, and the attacker identity is *pulled* from the
//!    Guild API's `planet-activity` feed.
//!
//! Off by default; `autonomy: advise` even once enabled, so turning it on shows
//! you the plan before it ever signs.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_response.json";

/// How the loop is allowed to act. Mirrors the doctrine's own vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Autonomy {
    /// Compute and surface the plan; sign nothing.
    #[default]
    Advise,
    /// Fire without confirmation.
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseMode {
    /// Never shoot: refine the threatened ore and alert. No offensive tx at all.
    Harden,
    /// Shoot the struct that shot us.
    Counter,
    /// Prefer the raider's Command Ship — killing it ends the raid outright and
    /// is the only deterministic defensive win in the data (16/16).
    #[default]
    Decapitate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoResponseConfig {
    /// Master on/off. Off by default — it can auto-sign attacks.
    pub enabled: bool,
    /// advise (surface the plan) | auto (fire).
    pub autonomy: Autonomy,
    /// Scan cadence. Short on purpose: the whole response budget is ~4 minutes.
    pub interval_secs: u64,
    pub mode: ResponseMode,
    /// Cap on shots fired per incident. Each shot is one player's whole charge bar.
    pub max_shots_per_incident: usize,
    /// Rolling one-hour ceiling across all incidents — the runaway guard.
    ///
    /// Sized so ONE raid can actually be fought to a conclusion. A 6 HP Command
    /// Ship behind a blocker takes ~1 net damage per shot (observed: "2 dmg,
    /// 1 blocked"), so ending a raid needs 6-12 shots inside a ~4 minute
    /// window. At the old 30/hour a defender ran dry after two minutes and the
    /// raid finished unopposed.
    pub max_shots_per_hour: usize,
    /// Ignore repeat triggers from the same attacker inside this window; one
    /// fight produces dozens of events.
    pub incident_cooldown_secs: u64,
    /// Charge headroom required above the weapon's cost before a struct fires.
    pub min_charge_margin: u64,
    /// Rank shooters sitting in an ambit the target's defenders cannot counter
    /// into — the docs' "single biggest combat lever".
    pub prefer_counter_free_ambit: bool,
    /// On a raid alarm, immediately refine the attacked player's stored ore.
    /// Refining is the only thing that makes ore unstealable, and a raid seizes
    /// ALL of it — the docs rank this the highest-impact defensive action.
    pub panic_refine: bool,
    /// Let the primary contribute shots. Off by default: its charge is better
    /// spent on its own defense, and it is the galaxy's biggest ore pile.
    pub include_primary_shooters: bool,
    /// Compute and log everything, sign nothing — independent of `autonomy` so
    /// you can rehearse an `auto` config safely.
    pub dry_run: bool,
}

impl Default for AutoResponseConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            autonomy: Autonomy::Advise,
            interval_secs: 20,
            mode: ResponseMode::Decapitate,
            max_shots_per_incident: 8,
            max_shots_per_hour: 120,
            incident_cooldown_secs: 300,
            min_charge_margin: 2,
            prefer_counter_free_ambit: true,
            panic_refine: true,
            include_primary_shooters: false,
            dry_run: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<AutoResponseConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config::<AutoResponseConfig>(FILENAME)));
/// Planets of ours with a raid clock currently running, kept alive across scans.
///
/// A raid does NOT stop because the raider stopped shooting. Observed live: the
/// attacker killed miner4's Command Ship, which armed the raid, then went
/// completely quiet to grind the raid proof. This loop is event-driven — it
/// raises alarms only for events newer than `EVENT_HW` — so with no new shots
/// there were no alarms, and the defence sat idle for the rest of the raid
/// while the ore was taken. Once a raid is seen, the planet stays watched and
/// re-alarms every scan until the clock clears or the raider's CMD is dead.
/// How often [`seed_raid_watch`] reconciles against the chain's raid feed.
///
/// This used to be a one-shot `AtomicBool`, which fired on the FIRST scan —
/// the single worst moment to ask. At startup `team_owned` is walking the whole
/// registry serially against a cold `OWNED_CACHE`, and any query that fails
/// under that burst silently drops its planet from `owned`. The seed then
/// matched nothing, logged nothing, and never ran again, so a raid already in
/// progress across a restart stayed unwatched for the rest of its life.
///
/// Re-seeding costs three pages of one guild-API feed, so just keep doing it:
/// it also recovers raids the event path missed for any other reason.
const SEED_INTERVAL_MS: f64 = 5.0 * 60.0 * 1000.0;

/// Last time the raid watch was reconciled, ms epoch. 0 = never.
static LAST_SEED: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

static RAID_WATCH: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
static RUN_GEN: AtomicU64 = AtomicU64::new(0);

/// Newest event timestamp already considered. The first scan only establishes
/// this baseline so a restart never re-fights hours of buffered history.
static EVENT_HW: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

/// attacker key -> last time we responded to it, for `incident_cooldown_secs`.
static INCIDENT_SEEN: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Timestamps of shots fired, for the rolling hourly budget.
static SHOT_LOG: LazyLock<Mutex<Vec<f64>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Recent incidents, newest first, for the WAR page's INCIDENTS card.
static INCIDENTS: LazyLock<Mutex<Vec<Incident>>> = LazyLock::new(|| Mutex::new(Vec::new()));
const INCIDENT_CAP: usize = 50;

#[derive(Debug, Clone, Serialize)]
pub struct Incident {
    pub at_ms: f64,
    pub planet_id: String,
    pub defender_player: String,
    pub attacker_player: Option<String>,
    pub attacker_struct: Option<String>,
    /// What we actually aimed at (the Command Ship in `decapitate`).
    pub fire_target: Option<String>,
    pub target_kind: String,
    pub mode: String,
    pub shots_planned: usize,
    pub shots_fired: usize,
    pub projected_damage: f64,
    pub note: String,
}

pub fn get() -> AutoResponseConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: AutoResponseConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

/// Watchdog remediation: invalidate the wedged scan and clear the guard.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}

pub fn recent_incidents() -> Vec<Incident> {
    INCIDENTS.lock().map(|i| i.clone()).unwrap_or_default()
}

/// Shots fired in the last hour, and the configured ceiling.
pub fn shot_budget() -> (usize, usize) {
    let cfg = get();
    let now = now_millis();
    let used = SHOT_LOG
        .lock()
        .map(|l| l.iter().filter(|t| now - **t < 3_600_000.0).count())
        .unwrap_or(0);
    (used, cfg.max_shots_per_hour)
}

fn record_incident(i: Incident) {
    if let Ok(mut v) = INCIDENTS.lock() {
        v.insert(0, i);
        v.truncate(INCIDENT_CAP);
    }
}

/// Reserve `n` shots against the rolling hourly budget; returns how many are
/// actually allowed (may be fewer, or zero).
fn reserve_shots(n: usize, cap: usize) -> usize {
    let now = now_millis();
    let Ok(mut log) = SHOT_LOG.lock() else { return 0 };
    log.retain(|t| now - *t < 3_600_000.0);
    let free = cap.saturating_sub(log.len());
    let grant = n.min(free);
    for _ in 0..grant {
        log.push(now);
    }
    grant
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
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = crate::mcp::telemetry::LoopRun::start("auto_response");
    scan(app_handle, &cfg, &run).await;
    if RUN_GEN.load(Ordering::SeqCst) != gen {
        // Invalidated by a watchdog reset mid-scan. Deliberately does NOT clear
        // `RUNNING`: `force_reset_running` already cleared it when it bumped the
        // generation, so a newer tick may own the guard by now. Record the row
        // and touch nothing else.
        run.finish_stale(Some("invalidated by watchdog reset mid-scan".into()));
        return;
    }
    run.finish(None);
    if run.errors.load(Ordering::Relaxed) == 0 {
        crate::mcp::loop_util::report_clean_scan();
    }
    RUNNING.store(false, Ordering::SeqCst);
}

/// One incident, as distilled from the event stream before we go looking for
/// the attacker.
#[derive(Debug, Clone)]
struct Alarm {
    planet_id: String,
    defender_player: String,
    label: String,
    /// A raid alarm is the urgent one — the 22-block clock is running.
    is_raid: bool,
}

async fn scan(
    app_handle: &tauri::AppHandle,
    cfg: &AutoResponseConfig,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) {
    use crate::mcp::tools::events;

    let client = CosmosClient::new();
    let owned = events::build_owned(true).await;
    if owned.planets.is_empty() {
        return;
    }

    // ── Drain the event buffer since the high-water mark. ──
    let recent = crate::mcp::event_buffer::get_recent(200, None, None);
    let since = *EVENT_HW.lock().unwrap();
    let mut hw = since;
    let mut alarms: HashMap<String, Alarm> = HashMap::new(); // planet -> alarm
    for e in &recent {
        hw = hw.max(e.timestamp);
        // First scan only establishes the baseline; never refight history.
        if since <= 0.0 || e.timestamp <= since {
            continue;
        }
        let Some(threat) = events::classify(e, &owned) else { continue };
        let Some(planet) = owned.planet_for(e) else { continue };
        // A raid alarm supersedes a damage alarm for the same planet.
        let is_raid = threat == events::Threat::RaidArmed
            || threat == events::Threat::HostileInbound
            || e.category.contains("raid");
        let entry = alarms.entry(planet.clone()).or_insert_with(|| Alarm {
            planet_id: planet.clone(),
            defender_player: owned.player_by_planet.get(&planet).cloned().unwrap_or_default(),
            label: owned.label_by_planet.get(&planet).cloned().unwrap_or_else(|| "you".into()),
            is_raid,
        });
        entry.is_raid |= is_raid;
    }
    *EVENT_HW.lock().unwrap() = hw;

    // ── Recover raids that were already running ───────────────────────────
    // `RAID_WATCH` is in-memory and only ever populated by a NEW event, so a
    // restart mid-raid leaves the raider parked at our planet and completely
    // unopposed: nothing has shot recently, so nothing alarms, so the planet is
    // never watched. Observed live — a raider sat on 2-6607 through a relaunch
    // and the loop ran 162 times without raising a single incident.
    //
    // Same shape as auto_raid's `readopt_expeditions`: reconcile against
    // reality rather than trying to persist our own bookkeeping. One paged
    // guild-API read of the raid feed, no per-planet queries and no enrichment
    // — we only need the planet ids, and `owned` already tells us which are
    // ours. Runs on a timer rather than once, so a seed that lands during a
    // cold start (when `owned` can still be incomplete) is not the only chance
    // we get. See [`SEED_INTERVAL_MS`].
    let due = LAST_SEED
        .lock()
        .map(|last| now_millis() - *last >= SEED_INTERVAL_MS)
        .unwrap_or(false);
    if due {
        if let Ok(mut last) = LAST_SEED.lock() {
            *last = now_millis();
        }
        seed_raid_watch(&client, &owned).await;
    }

    // ── Sustained defence ────────────────────────────────────────────────
    // Re-raise an alarm for every planet whose raid clock is still running,
    // whether or not anything new happened this scan. Cost is bounded by the
    // number of raids actually running against us (normally one), not by the
    // roster: only watched planets are read.
    let watched: Vec<(String, String)> = RAID_WATCH
        .lock()
        .map(|w| w.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    for (planet_id, defender) in watched {
        let armed = client
            .query_entity("planet", &planet_id)
            .await
            .ok()
            .map(|e| {
                crate::mcp::loop_util::read_u64_field(e.get("planetAttributes"), "blockStartRaid")
            })
            .unwrap_or(0);
        // A raid has TWO phases and the clock only covers the second one.
        // `blockStartRaid` stays 0 for the whole `initiated` phase — the raider
        // is parked at our planet working through the defences, and the clock
        // arms only once our Command Ship dies.
        //
        // Standing down on `armed == 0` therefore did the opposite of the
        // intent: the defence engaged only AFTER our CMD was destroyed, which
        // is exactly when the defender has nothing left to fight with. Verified
        // live — a raider sat at 2-6607 with `raid_status: initiated`,
        // `block_start_raid: 0`, and the watch dropped it on the next scan.
        //
        // So keep fighting while EITHER the clock is running OR a hostile fleet
        // is still parked here. Reading the fleet also re-identifies the
        // attacker, which is what the event path fails to do once the shooting
        // stops ("attacker not identifiable yet").
        let still_here = if armed != 0 {
            true
        } else {
            raiding_fleet(&client, &planet_id, None).await.is_some()
        };
        if !still_here {
            if let Ok(mut w) = RAID_WATCH.lock() {
                w.remove(&planet_id);
            }
            crate::mcp::telemetry::tlog(
                "auto_response",
                crate::mcp::telemetry::Sev::Notice,
                format!("{planet_id}: raider gone and clock clear — standing down"),
            );
            continue;
        }
        alarms.entry(planet_id.clone()).or_insert_with(|| Alarm {
            planet_id: planet_id.clone(),
            defender_player: defender.clone(),
            label: owned
                .label_by_planet
                .get(&planet_id)
                .cloned()
                .unwrap_or_else(|| "you".into()),
            is_raid: true,
        });
    }

    if alarms.is_empty() {
        return;
    }

    crate::mcp::combat_lists::prune_expired();

    for (_, alarm) in alarms {
        // Keep fighting this one until the raider leaves, even if it never
        // fires another shot. `is_raid` covers both phases: `classify` returns
        // RaidArmed for any non-terminal raid_status on our planet, which
        // includes `initiated`.
        if alarm.is_raid && !alarm.defender_player.is_empty() {
            if let Ok(mut w) = RAID_WATCH.lock() {
                w.insert(alarm.planet_id.clone(), alarm.defender_player.clone());
            }
        }
        run.players.fetch_add(1, Ordering::Relaxed);
        if let Err(e) = handle_alarm(app_handle, &client, cfg, &owned, &alarm, run).await {
            run.errors.fetch_add(1, Ordering::Relaxed);
            crate::mcp::telemetry::tlog(
                "auto_response",
                crate::mcp::telemetry::Sev::Warn,
                format!("{}: {}", alarm.planet_id, e),
            );
        } else {
            run.actions.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn handle_alarm(
    app: &tauri::AppHandle,
    client: &CosmosClient,
    cfg: &AutoResponseConfig,
    owned: &crate::mcp::tools::events::Owned,
    alarm: &Alarm,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) -> Result<(), String> {
    // ── 1. Who hit us? ──
    // The GRASS event may be a stub, so the authoritative record comes from the
    // Guild API's planet-activity feed. A raid alarm can also identify the
    // attacker straight from the raiding fleet, which is faster and works even
    // before a single shot has been exchanged.
    // Our struct ids at this planet, so a volley between two OTHER players on a
    // shared planet can't be mistaken for an attack on us.
    let mine: HashSet<String> = owned.structs.clone();
    let attack = crate::mcp::tools::intel::fetch_attack_events(client, &alarm.planet_id, 10)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|a| {
            let hostile = a
                .attacker_player_id
                .as_deref()
                .map(|p| !crate::mcp::virtual_players::is_team_player(p))
                .unwrap_or(false);
            // Prefer the explicit target id; fall back to matching struct ids
            // when the flat `targetPlayerId` is absent from this payload shape.
            let at_us = a
                .target_player_id
                .as_deref()
                .map(crate::mcp::virtual_players::is_team_player)
                .unwrap_or_else(|| mine.is_empty() || a.hits_any(&mine));
            hostile && at_us
        });

    let from_shots = attack.as_ref().and_then(|a| a.attacker_player_id.clone());
    let raider_fleet = raiding_fleet(client, &alarm.planet_id, from_shots.as_deref()).await;
    let attacker_player = from_shots.or_else(|| raider_fleet.as_ref().and_then(|f| f.owner.clone()));

    // ── 2. Record the grudge, whatever we decide to do about it. ──
    // This happens even in `harden` and even when no shot is possible: the raid
    // loop uses it to retaliate later, on our schedule instead of theirs.
    if let Some(atk) = attacker_player.as_deref() {
        let (dmg, lost) = attack
            .as_ref()
            .map(|a| (a.total_damage(), a.destroyed_count()))
            .unwrap_or((0, 0));
        if lost > 0 {
            // Someone's fleet just got smaller. We only know the planet, not
            // which side lost what, so drop every cached composition rather than
            // plan the next volley around a hull that no longer exists.
            crate::mcp::loop_util::invalidate_all_player_structs();
        }
        let g = crate::mcp::combat_lists::record_attack(atk, None, dmg, lost, 0.0);
        crate::mcp::telemetry::tlog_kv(
            "auto_response",
            crate::mcp::telemetry::Sev::Notice,
            format!("attack on {} ({}) by {}", alarm.planet_id, alarm.label, atk),
            json!({ "attacks": g.attacks, "structs_lost": g.structs_lost, "raid": alarm.is_raid }),
        );
    }

    // ── 3. Hardening runs regardless of mode — it costs nothing offensive. ──
    if cfg.panic_refine && alarm.is_raid && !alarm.defender_player.is_empty() && !cfg.dry_run {
        // A raid seizes ALL stored ore; refining is the only thing that removes
        // it from the pot. Fire immediately rather than waiting out auto_harvest's
        // 30-minute cadence — the whole raid resolves in about four minutes.
        // Deliberately runs in `advise` mode too: it is purely defensive.
        crate::mcp::auto_harvest::request_priority_refine(app, &alarm.defender_player).await;
    }

    // The cooldown exists so one skirmish does not produce dozens of incidents.
    // A RAID is the opposite case: the clock is running, the whole window is
    // about four minutes, and every scan we skip is a shot the raider does not
    // have to survive. At the shipped 300s cooldown a defender got ONE shot per
    // raid against an attacker firing every 38 seconds.
    let cooldown_key = attacker_player.clone().unwrap_or_else(|| alarm.planet_id.clone());
    if cooldown_gags_us(alarm.is_raid, in_cooldown(&cooldown_key, cfg.incident_cooldown_secs)) {
        return Ok(());
    }

    if cfg.mode == ResponseMode::Harden {
        record_incident(Incident {
            at_ms: now_millis(),
            planet_id: alarm.planet_id.clone(),
            defender_player: alarm.label.clone(),
            attacker_player,
            attacker_struct: attack.as_ref().and_then(|a| a.attacker_struct_id.clone()),
            fire_target: None,
            target_kind: "none".into(),
            mode: "harden".into(),
            shots_planned: 0,
            shots_fired: 0,
            projected_damage: 0.0,
            note: "harden mode — refined ore and alerted, no offensive response".into(),
        });
        alert(app, alarm, "hardening only (mode: harden)");
        return Ok(());
    }

    // ── 4. Pick what to shoot. ──
    // Decapitate: the raider's Command Ship. Killing it while its fleet is away
    // sets `attackerDefeated` and sends the fleet home — 16/16 in the data, and
    // the only mechanic that ends a raid without losing the ore.
    let (fire_target, target_kind) = match cfg.mode {
        ResponseMode::Decapitate => match raider_fleet.as_ref().and_then(|f| f.command_struct.clone()) {
            Some(cmd) => (Some(cmd), "raider_command_ship"),
            // No reachable Command Ship (fleet already left, or it is a plain
            // attack rather than a raid) — fall back to the shooter.
            None => (
                attack.as_ref().and_then(|a| a.attacker_struct_id.clone()),
                "attacking_struct",
            ),
        },
        _ => (
            attack.as_ref().and_then(|a| a.attacker_struct_id.clone()),
            "attacking_struct",
        ),
    };
    let Some(fire_target) = fire_target else {
        run.blocked("attacker not identifiable yet (no resolved attack record)");
        alert(app, alarm, "attacker not yet identifiable — no shot taken");
        return Ok(());
    };

    // ── 5. Who can actually reach it? ──
    // Combat is co-located: only structs at this planet can engage. Every other
    // vplayer's charge bar is useless here, however many we have.
    let shooters = co_located_players(owned, &alarm.planet_id, cfg.include_primary_shooters);
    if shooters.is_empty() {
        run.blocked(format!(
            "no co-located combat structs at {} — nothing can reach the attacker",
            alarm.planet_id
        ));
        alert(app, alarm, "no co-located combat structs — nothing can reach the attacker");
        return Ok(());
    }

    let plan = crate::mcp::tools::intel::plan_strike(
        client,
        &json!({ "target": fire_target, "players": shooters }),
    )
    .await?;

    // One shot per player (any action zeroes that player's charge bar), best
    // first, and only from players whose charge is actually ready.
    let charge_ready = charge_ready_map();
    let mut best: HashMap<String, &crate::mcp::tools::intel::StrikeRow> = HashMap::new();
    for r in plan.rows.iter().filter(|r| r.reachable) {
        let Some(pid) = r.player_id.as_deref() else { continue };
        if !charge_ready
            .get(pid)
            .map(|c| *c >= weapon_cost(&r.struct_id, &r.weapon) + cfg.min_charge_margin)
            .unwrap_or(false)
        {
            continue;
        }
        let e = best.entry(pid.to_string()).or_insert(r);
        let better = if cfg.prefer_counter_free_ambit {
            (r.counter_exposure, -r.score) < (e.counter_exposure, -e.score)
        } else {
            r.score > e.score
        };
        if better {
            *e = r;
        }
    }
    let mut shots: Vec<&crate::mcp::tools::intel::StrikeRow> = best.into_values().collect();
    shots.sort_by(|a, b| {
        if cfg.prefer_counter_free_ambit {
            a.counter_exposure
                .cmp(&b.counter_exposure)
                .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
        } else {
            b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
        }
    });
    shots.truncate(cfg.max_shots_per_incident);

    let projected: f64 = shots.iter().map(|s| s.expected_dmg).sum();
    let planned = shots.len();

    if planned == 0 {
        // The live failure mode: the loop is on, the target is right, and every
        // shooter's charge has been spent by the economy loops.
        run.blocked(format!(
            "{} co-located shooter(s) at {}, none with charge ready (need weapon cost + {} margin)",
            shooters.len(), alarm.planet_id, cfg.min_charge_margin
        ));
        alert(app, alarm, "co-located shooters exist but none have charge ready");
        return Ok(());
    }

    // ── 6. Fire, or surface the plan. ──
    let advise = cfg.autonomy == Autonomy::Advise || cfg.dry_run;
    let mut fired = 0usize;
    if advise {
        let lines: Vec<String> = shots
            .iter()
            .map(|s| {
                format!(
                    "{} · {} [{}, {}] → ~{:.1} dmg, counter exposure {}",
                    s.player, s.struct_id, s.weapon, s.control.as_str(), s.expected_dmg, s.counter_exposure
                )
            })
            .collect();
        crate::mcp::board_feed::push(
            app,
            crate::mcp::board_feed::Severity::Important,
            "auto_response",
            format!(
                "{} under attack — PLAN: {} shot(s) at {} ({}), ~{:.1} dmg vs {:.0} HP\n{}",
                alarm.label,
                planned,
                fire_target,
                target_kind,
                projected,
                plan.tgt_hp,
                lines.join("\n")
            ),
        );
    } else {
        let granted = reserve_shots(planned, cfg.max_shots_per_hour);
        if granted == 0 {
            run.blocked(format!("hourly shot budget exhausted ({} max)", cfg.max_shots_per_hour));
            alert(app, alarm, "hourly shot budget exhausted — no response fired");
            return Ok(());
        }
        for s in shots.iter().take(granted) {
            let ok = fire(app, s, &fire_target).await;
            if ok {
                fired += 1;
            }
        }
        crate::mcp::board_feed::push(
            app,
            crate::mcp::board_feed::Severity::Important,
            "auto_response",
            format!(
                "{} under attack — fired {}/{} shot(s) at {} ({}), ~{:.1} projected dmg vs {:.0} HP{}",
                alarm.label,
                fired,
                planned,
                fire_target,
                target_kind,
                projected,
                plan.tgt_hp,
                if target_kind == "raider_command_ship" && projected >= plan.tgt_hp {
                    " — projected KILL, which ends the raid (attackerDefeated)"
                } else {
                    ""
                }
            ),
        );
    }

    run.acted();
    mark_incident(&cooldown_key);
    record_incident(Incident {
        at_ms: now_millis(),
        planet_id: alarm.planet_id.clone(),
        defender_player: alarm.label.clone(),
        attacker_player,
        attacker_struct: attack.as_ref().and_then(|a| a.attacker_struct_id.clone()),
        fire_target: Some(fire_target),
        target_kind: target_kind.into(),
        mode: if advise { "advise".into() } else { "auto".into() },
        shots_planned: planned,
        shots_fired: fired,
        projected_damage: projected,
        note: format!("target HP {:.0}{}", plan.tgt_hp, incoming_summary(attack.as_ref())),
    });
    Ok(())
}

async fn fire(
    app: &tauri::AppHandle,
    s: &crate::mcp::tools::intel::StrikeRow,
    target: &str,
) -> bool {
    match s.hd_index {
        Some(index) => {
            let wsys = if s.weapon.eq_ignore_ascii_case("secondary") {
                "secondaryWeapon"
            } else {
                "primaryWeapon"
            };
            let payload = json!({
                "operatingStructId": s.struct_id,
                "targetStructId": [target],
                "weaponSystem": wsys,
            });
            crate::mcp::tx_retry::sign_with_retry(
                app,
                index,
                "/structs.structs.MsgStructAttack",
                payload,
                &format!("auto_response:{}", s.player_id.clone().unwrap_or_default()),
            )
            .await
            .is_ok()
        }
        // The primary signs through the webview queue, not the façade.
        None => {
            let args = json!({
                "action_type": "struct_attack",
                "operating_struct_id": s.struct_id,
                "target_struct_id": target,
                "weapon_system": s.weapon,
                "charge_cost": weapon_cost(&s.struct_id, &s.weapon),
            });
            matches!(
                crate::mcp::tx_retry::submit_with_retry(app, "struct_attack", args, "auto_response:primary").await,
                Ok(r) if r.success
            )
        }
    }
}

/// A one-line reading of the incoming volley for the INCIDENTS card: what hit
/// us, with what, and how the shots actually resolved. Empty when the attack
/// record hasn't landed yet (a raid alarm can fire before the first shot).
fn incoming_summary(a: Option<&crate::mcp::tools::intel::AttackEvent>) -> String {
    let Some(a) = a else { return String::new() };
    let evaded = a.shots.iter().filter(|s| s.evaded).count();
    let blocked = a.shots.iter().filter(|s| s.blocked).count();
    let countered: u64 = a.shots.iter().filter(|s| s.countered).map(|s| s.countered_damage).sum();
    let hit: Vec<&str> = a
        .shots
        .iter()
        .filter(|s| s.damage_dealt > 0)
        .filter_map(|s| s.target_struct_id.as_deref())
        .collect();
    let mut out = format!(
        " · incoming: {} ({}) {} {}",
        a.attacker_struct_id.as_deref().unwrap_or("?"),
        a.attacker_struct_type.as_deref().unwrap_or("?"),
        a.weapon_system.as_deref().unwrap_or("weapon"),
        a.attacker_ambit
            .as_deref()
            .map(|x| format!("from {x}"))
            .unwrap_or_default()
    );
    out.push_str(&format!(" → {} dmg", a.total_damage()));
    if !hit.is_empty() {
        out.push_str(&format!(" on {}", hit.join(", ")));
    }
    for (n, label) in [(evaded, "evaded"), (blocked, "blocked")] {
        if n > 0 {
            out.push_str(&format!(", {n} {label}"));
        }
    }
    if countered > 0 {
        out.push_str(&format!(", we countered for {countered}"));
    }
    if a.destroyed_count() > 0 {
        out.push_str(&format!(", {} struct(s) LOST", a.destroyed_count()));
    }
    out
}

fn alert(app: &tauri::AppHandle, alarm: &Alarm, why: &str) {
    crate::mcp::board_feed::push(
        app,
        crate::mcp::board_feed::Severity::Important,
        "auto_response",
        format!("{} ({}) under attack — {}", alarm.label, alarm.planet_id, why),
    );
}

fn in_cooldown(key: &str, cooldown_secs: u64) -> bool {
    let now = now_millis();
    INCIDENT_SEEN
        .lock()
        .map(|m| m.get(key).map(|t| now - *t < cooldown_secs as f64 * 1000.0).unwrap_or(false))
        .unwrap_or(false)
}

/// Adopt any raid already in progress against one of our planets.
///
/// Called once per process. Reads the chain's raid feed and watches every
/// non-terminal raid on a planet we own, so a restart cannot leave a raider
/// unopposed simply because it has stopped shooting.
async fn seed_raid_watch(client: &CosmosClient, owned: &crate::mcp::tools::events::Owned) {
    let rows = match crate::mcp::guild_api::fetch_all_pages(
        |page| client.guild.planet_activity_by_category("raid_status", page),
        3,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::mcp::telemetry::tlog(
                "auto_response",
                crate::mcp::telemetry::Sev::Warn,
                format!("could not seed raid watch: {e}"),
            );
            return;
        }
    };
    let now = now_millis();
    let mut adopted = 0usize;
    for r in crate::mcp::raid_view::reduce_raids(&rows, now, crate::mcp::raid_view::STALE_AFTER_MS) {
        if r.is_terminal() || !owned.planets.contains(&r.planet_id) {
            continue;
        }
        let Some(defender) = owned.player_by_planet.get(&r.planet_id).cloned() else { continue };
        // Already watching it — this is a routine re-seed, not news.
        let fresh = match RAID_WATCH.lock() {
            Ok(mut w) => w.insert(r.planet_id.clone(), defender).is_none(),
            Err(_) => continue,
        };
        if !fresh {
            continue;
        }
        adopted += 1;
        crate::mcp::telemetry::tlog(
            "auto_response",
            crate::mcp::telemetry::Sev::Notice,
            format!("adopted in-progress raid on {} ({})", r.planet_id, r.status),
        );
    }
    if adopted > 0 {
        crate::mcp::telemetry::tlog(
            "auto_response",
            crate::mcp::telemetry::Sev::Notice,
            format!("raid watch seeded with {adopted} in-progress raid(s)"),
        );
    }
}

/// Should the per-attacker cooldown suppress this response?
///
/// The cooldown exists so one skirmish does not produce dozens of incidents.
/// A RAID is the opposite case: the clock is running, the whole window is about
/// four minutes, and every scan skipped is a shot the raider does not have to
/// survive. Live evidence — at the shipped 300s cooldown a defender landed ONE
/// shot against an attacker firing every 38 seconds, and lost the ore.
fn cooldown_gags_us(is_raid: bool, cooling: bool) -> bool {
    !is_raid && cooling
}

fn mark_incident(key: &str) {
    if let Ok(mut m) = INCIDENT_SEEN.lock() {
        m.insert(key.to_string(), now_millis());
    }
}

/// A hostile fleet parked at one of our planets, with its Command Ship.
#[derive(Debug, Clone, Default)]
struct RaiderFleet {
    #[allow(dead_code)]
    fleet_id: String,
    owner: Option<String>,
    command_struct: Option<String>,
}

/// Is this fleet a raider we can actually shoot at `planet_id`?
///
/// Split out from [`raiding_fleet`] so the "keep looking" semantics below are
/// testable without a chain to talk to.
fn hostile_and_here(
    owner: Option<&str>,
    location: Option<&str>,
    planet_id: &str,
    is_team: fn(&str) -> bool,
) -> bool {
    // One of ours visiting is not a raider.
    if owner.map(is_team).unwrap_or(false) {
        return false;
    }
    // Combat is co-located: a Command Ship sitting at its own home planet is
    // unreachable from ours, and firing at it would just burn the roster's
    // charge on a guaranteed reject.
    location == Some(planet_id)
}

/// Find the hostile fleet sitting at `planet_id` and resolve its Command Ship.
///
/// Two routes, because each covers the other's blind spot:
/// * If we already know who shot us, go straight to their fleet and confirm it
///   is parked here. This works even before a raid clock has armed.
/// * Otherwise sweep every fleet parked at the planet and take the first
///   hostile one.
///
/// That sweep used to read `locationListStart` alone — the HEAD of the planet's
/// visitor list — and return `None` outright if that one fleet turned out to be
/// friendly. The visitor list is a linked list, so a single friendly fleet
/// ahead of the raider blinded the defence completely: no raider found means
/// the watch stands down and the planet is left to be seized. Worse, it was
/// self-inflicted — `auto_defend` sending a teammate's fleet to help is exactly
/// what puts a friendly entry at the head of that list.
async fn raiding_fleet(
    client: &CosmosClient,
    planet_id: &str,
    attacker_player: Option<&str>,
) -> Option<RaiderFleet> {
    let is_team: fn(&str) -> bool = crate::mcp::virtual_players::is_team_player;

    // Candidates, best first. A named attacker is the strongest signal, so try
    // their fleet before paying for the visitor walk.
    let mut candidates: Vec<String> = Vec::new();
    if let Some(atk) = attacker_player.filter(|p| !is_team(p)) {
        if let Ok(pl) = client.query_entity("player", atk).await {
            if let Some(f) = pl
                .get("Player")
                .and_then(|p| p.get("fleetId"))
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
            {
                candidates.push(f.to_string());
            }
        }
    }
    if candidates.is_empty() {
        // Reuses the spectator's walker: both list directions, with the same
        // dangling-pointer guard. Sorted only so the pick is deterministic —
        // `locations_at_planet` returns a set.
        let mut visitors: Vec<String> = crate::mcp::spectator::locations_at_planet(client, planet_id)
            .await
            .into_iter()
            .filter(|id| id != planet_id)
            .collect();
        visitors.sort();
        candidates = visitors;
    }

    for fleet_id in candidates {
        let Ok(fleet) = client.query_entity("fleet", &fleet_id).await else { continue };
        let Some(f) = fleet.get("Fleet") else { continue };
        let owner = f.get("owner").and_then(|x| x.as_str()).map(String::from);
        if !hostile_and_here(
            owner.as_deref(),
            f.get("locationId").and_then(|x| x.as_str()),
            planet_id,
            is_team,
        ) {
            continue; // the raider may be further down the list
        }
        let command_struct = f
            .get("commandStruct")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        // A destroyed Command Ship is not a target.
        let command_struct = match command_struct {
            Some(cs) => {
                let dead = client
                    .query_entity("struct", &cs)
                    .await
                    .map(|e| {
                        crate::mcp::loop_util::parse_bool(
                            e.get("structAttributes").and_then(|a| a.get("isDestroyed")),
                        )
                    })
                    .unwrap_or(true);
                if dead {
                    None
                } else {
                    Some(cs)
                }
            }
            None => None,
        };
        return Some(RaiderFleet { fleet_id, owner, command_struct });
    }
    None
}

/// Team players with structs AT `planet_id` — the only ones that can engage.
/// In practice this is the attacked player itself plus any teammate whose fleet
/// happens to be parked there.
fn co_located_players(
    owned: &crate::mcp::tools::events::Owned,
    planet_id: &str,
    include_primary: bool,
) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    if let Some(pid) = owned.player_by_planet.get(planet_id) {
        out.insert(pid.clone());
    }
    if !include_primary {
        if let Some(me) = crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone()) {
            // Only exclude the primary when it isn't the victim — a player under
            // attack always defends itself.
            let victim = owned.player_by_planet.get(planet_id).cloned().unwrap_or_default();
            if victim != me {
                out.remove(&me);
            }
        }
    }
    out.into_iter().collect()
}

/// player_id -> current charge, from the roster cache (primary from game state).
fn charge_ready_map() -> HashMap<String, u64> {
    let mut m: HashMap<String, u64> = crate::mcp::roster_cache::all_rows()
        .into_iter()
        .map(|r| (r.player_id, r.charge))
        .collect();
    if let Ok(gs) = crate::game_state::GAME_STATE.read() {
        if let Some(me) = gs.player_id.clone() {
            m.insert(me, gs.get_charge());
        }
    }
    m
}

/// Charge cost of one weapon on one struct, from synced struct types.
/// Falls back to the genesis default of 3 when types aren't synced yet.
fn weapon_cost(struct_id: &str, weapon: &str) -> u64 {
    let gs = crate::game_state::GAME_STATE.read().unwrap();
    gs.structs
        .get(struct_id)
        .and_then(|s| gs.struct_types.get(&s.struct_type_id.to_string()))
        .and_then(|t| {
            if weapon.eq_ignore_ascii_case("secondary") {
                t.secondary_weapon_charge
            } else {
                t.primary_weapon_charge
            }
        })
        .unwrap_or(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_safe() {
        let c = AutoResponseConfig::default();
        assert!(!c.enabled, "must not fight on first launch");
        assert_eq!(c.autonomy, Autonomy::Advise, "enabling it shows the plan first");
        assert!(!c.include_primary_shooters, "the primary's charge stays home");
        assert_eq!(c.mode, ResponseMode::Decapitate);
    }

    /// A raid must never be gagged by the per-attacker cooldown: the raider
    /// stops shooting once the clock is armed and simply grinds the proof, so
    /// waiting for "new activity" means waiting out the raid.
    #[test]
    fn a_raid_keeps_firing_through_the_cooldown() {
        assert!(!cooldown_gags_us(true, true), "a live raid must not be gagged");
        assert!(!cooldown_gags_us(true, false));
        // A plain skirmish still gets the anti-spam cooldown.
        assert!(cooldown_gags_us(false, true));
        assert!(!cooldown_gags_us(false, false));
    }

    /// A friendly fleet parked at our planet must not hide the raider behind
    /// it. `locationListStart` is the HEAD of a linked list, and the old code
    /// tested only that one entry — so a teammate sent by `auto_defend` was
    /// enough to make the raid invisible and stand the defence down.
    #[test]
    fn a_friendly_fleet_at_the_head_does_not_hide_the_raider() {
        const HOME: &str = "2-6607";
        let is_team: fn(&str) -> bool = |p: &str| p == "1-275" || p == "1-2136";
        // (fleet, owner, location) in visitor-list order: ours first.
        let visitors = [
            ("9-2136", Some("1-2136"), Some(HOME)), // teammate helping out
            ("9-61", Some("1-61"), Some(HOME)),     // the actual raider
        ];
        let picked = visitors
            .iter()
            .find(|(_, owner, loc)| hostile_and_here(*owner, *loc, HOME, is_team))
            .map(|(f, ..)| *f);
        assert_eq!(picked, Some("9-61"), "the raider behind a friendly must still be found");
    }

    /// The co-location rule still holds: a hostile fleet that has gone home is
    /// unreachable, and shooting at it only burns charge on a certain reject.
    #[test]
    fn a_hostile_fleet_that_left_is_not_a_target() {
        const HOME: &str = "2-6607";
        let is_team: fn(&str) -> bool = |p: &str| p == "1-275";
        assert!(hostile_and_here(Some("1-61"), Some(HOME), HOME, is_team));
        assert!(!hostile_and_here(Some("1-61"), Some("2-9"), HOME, is_team));
        assert!(!hostile_and_here(Some("1-275"), Some(HOME), HOME, is_team));
        // Unknown owner is treated as hostile — better to check than to ignore.
        assert!(hostile_and_here(None, Some(HOME), HOME, is_team));
    }

    /// Sizing check: a 6 HP Command Ship taking ~1 net damage per shot needs
    /// more shots than the old 30/hour ceiling allowed inside one raid.
    #[test]
    fn hourly_budget_can_finish_one_raid() {
        let cfg = AutoResponseConfig::default();
        let window_secs = 4 * 60;
        let shots_available = window_secs / cfg.interval_secs.max(1) as usize;
        assert!(
            cfg.max_shots_per_hour >= shots_available,
            "hourly cap {} cuts off a raid that affords {} shots",
            cfg.max_shots_per_hour, shots_available
        );
        assert!(shots_available >= 6, "need >=6 shots to kill a 6 HP CMD at ~1 net dmg");
    }

    /// The whole response budget is ~4 minutes (2.1 min to shieldsVulnerable +
    /// a 22-block ≈ 2.1 min lock), and every observed defensive win fired inside
    /// ~1.8 min. A scan interval near that budget would miss the window.
    #[test]
    fn scan_interval_fits_inside_the_raid_window() {
        assert!(AutoResponseConfig::default().interval_secs <= 30);
    }

    #[test]
    fn hourly_budget_grants_then_refuses() {
        SHOT_LOG.lock().unwrap().clear();
        assert_eq!(reserve_shots(4, 5), 4);
        assert_eq!(reserve_shots(4, 5), 1, "only one slot left in the window");
        assert_eq!(reserve_shots(1, 5), 0);
        SHOT_LOG.lock().unwrap().clear();
    }

    #[test]
    fn incident_cooldown_suppresses_a_repeat() {
        INCIDENT_SEEN.lock().unwrap().clear();
        assert!(!in_cooldown("1-61", 300));
        mark_incident("1-61");
        assert!(in_cooldown("1-61", 300));
        // A zero-length cooldown never suppresses.
        assert!(!in_cooldown("1-61", 0));
        INCIDENT_SEEN.lock().unwrap().clear();
    }

    #[test]
    fn modes_round_trip_through_json() {
        for m in ["harden", "counter", "decapitate"] {
            let parsed: ResponseMode = serde_json::from_str(&format!("\"{m}\"")).unwrap();
            assert_eq!(serde_json::to_string(&parsed).unwrap(), format!("\"{m}\""));
        }
    }
}
