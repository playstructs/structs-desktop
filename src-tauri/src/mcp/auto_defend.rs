//! Native auto-defense loop — assigns each productive vplayer's idle combat structs
//! to DEFEND its key structs via `MsgStructDefenseSet`, so newly-built defenders
//! actually intercept raids instead of sitting unassigned. Priority: the Command
//! Ship first (it is the planetary-shield gate — if it dies the raid clock arms —
//! and its 2/2 counter is the best attacker-killer), then the Ore Refinery and Ore
//! Extractor, spreading defenders across targets instead of piling on one. A
//! same-ambit defender is preferred (only same-ambit defenders can BLOCK; cross-ambit
//! ones only counter), and among those a CO-LOCATED one wins — planetary structs do
//! not travel, so they stop defending a fleet the moment it leaves home, which is
//! exactly when it is raiding. One assignment per player per scan (defend costs 1 charge).
//! Idempotent: a defender whose on-chain `protectedStructIndex` is already non-zero
//! is cached (with its target) and never re-queried. Off by default (it auto-signs).
//!
//! This is the "configure defensive relationships as new structs come online" piece:
//! it runs every scan, so a freshly-built OSG/Tank/Starfighter gets a defender
//! assignment on the next pass. Bait players are skipped by default (they're raid
//! fodder — armor makes raids costly, but we don't shield their structs).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_defend.json";
const COMMAND_SHIP_TYPE: &str = "1";
const REFINERY_TYPE: &str = "15";
const EXTRACTOR_TYPE: &str = "14";
/// Production / command types — PROTECTED targets, never used as defenders.
const PROTECTED_TYPES: &[&str] = &["14", "15", "1"]; // extractor, refinery, command ship
/// The Command Ship gets defenders before anything else, up to this many
/// (ideally one blocker per ambit), before assignments spread to production.
const CMD_MIN_DEFENDERS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDefendConfig {
    /// Master on/off. Off by default — it auto-signs defense-set txs.
    pub enabled: bool,
    /// Min seconds between scans.
    pub interval_secs: u64,
    /// Also assign defenders on BAIT players (default false — bait are raid fodder).
    pub include_bait: bool,
}

impl Default for AutoDefendConfig {
    fn default() -> Self {
        Self { enabled: false, interval_secs: 180, include_bait: false }
    }
}

static CONFIG: LazyLock<RwLock<AutoDefendConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_SCAN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
/// How useful is this hull as a defender of a target in `target_ambit`?
///
/// A defender contributes two SEPARATE things under two DIFFERENT conditions,
/// and the pair is easy to get wrong:
///
///   * **Blocking** — absorbs the shot entirely. Requires the defender to share
///     the TARGET's ambit.
///   * **Countering** — damages the attacker, and can outright NEGATE the attack:
///     measured, a Battleship's counter killed a 1 HP Tank and the Tank's shot
///     then landed for 0 with `counterDestroyedAttacker: true`. Requires the
///     defender's WEAPON to reach the ATTACKER's ambit.
///
/// So a cross-ambit defender is NOT useless — a space Battleship (primary reach
/// water+land) counters a land attacker perfectly well, it just cannot block.
/// An earlier version of this function assumed otherwise, on the strength of a
/// single test where the cross-ambit hull was a Starfighter whose reach is space
/// only and so genuinely could not answer. Reach is what decides it, not ambit.
///
/// Blocking is the stronger effect, so same-ambit dominates; among the rest,
/// value follows counter strength times how many ambits the weapon can answer
/// from. Read off the chain so it stays correct as hulls change.
///
/// Ambit is only half of it — see [`travels_with_target`] for the other half.
fn defender_rank(type_id: &str, target_ambit: &str, defender_ambit: &str) -> u64 {
    let (counter, reach) = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| {
            g.struct_types.get(type_id).map(|t| {
                (
                    t.counter_attack_same_ambit.unwrap_or(0),
                    t.primary_weapon_ambits.unwrap_or(0),
                )
            })
        })
        .unwrap_or((0, 0));
    // How many ambits this hull could counter an attacker in.
    let breadth = (reach & 0b11110).count_ones() as u64;
    let blocks = !target_ambit.is_empty() && defender_ambit == target_ambit;
    // Blocking outranks any amount of counter reach; unarmed planetary hulls
    // (counter 0) still rank above nothing when they can block.
    if blocks { 100 + counter * breadth } else { counter * breadth }
}

/// Does this pairing keep working when it is needed most?
///
/// Both block and counter require the two structs to be CO-LOCATED at the
/// moment of the shot. Measured live (2026-08-12): a Command Ship raiding away
/// from home was "defended" by three Ore Bunkers still sitting on its home
/// planet — the attack landed completely unblocked, with no counter, and the
/// relationship might as well not have existed.
///
/// A planetary defender is not useless: while the fleet is on station it blocks
/// perfectly well (verified the same day, an Ore Bunker absorbing 2 damage for a
/// fleet Command Ship). But planetary structs DO NOT TRAVEL, so they silently
/// stop defending the instant the fleet leaves — which is exactly when it is
/// raiding and most exposed. A fleet defender moves with what it guards and is
/// therefore strictly better for anything that can leave home.
fn travels_with_target(defender_loc: &str, target_loc: &str) -> bool {
    !defender_loc.is_empty() && defender_loc == target_loc
}

/// Defender struct id -> protected struct id it already defends (protectedStructIndex
/// != 0 on chain) — skip re-querying, and count toward spread balancing.
static ASSIGNED_CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join(FILENAME))
}
fn load() -> AutoDefendConfig {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
pub fn get() -> AutoDefendConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

/// Run generation: bumped by every watchdog reset. See auto_build::RUN_GEN —
/// a scan whose generation went stale must not clear the guard or report
/// liveness (a newer scan owns them).
static RUN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Watchdog remediation: invalidate the wedged scan and clear the
/// single-flight guard so the next tick can scan again.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}
pub fn set(cfg: AutoDefendConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    if let (Some(p), Ok(j)) = (path(), serde_json::to_string_pretty(&cfg)) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, j);
    }
}

fn type_id_of(s: &Value) -> String {
    s.get("type")
        .or_else(|| s.get("struct_type"))
        .map(|x| match x {
            Value::Number(n) => n.to_string(),
            Value::String(t) => t.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
}
fn truthy(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true))) || matches!(v, Some(Value::String(s)) if s.eq_ignore_ascii_case("true"))
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
    let run = crate::mcp::telemetry::LoopRun::start("auto_defend");
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
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(
    app_handle: &tauri::AppHandle,
    cfg: &AutoDefendConfig,
    run: &std::sync::Arc<crate::mcp::telemetry::LoopRun>,
) {
    use crate::mcp::virtual_players::VPlayerRole;
    let client = CosmosClient::new();
    let targets = crate::mcp::virtual_players::collect_targets(false);
    let include_bait = cfg.include_bait;
    let app = app_handle.clone();
    let run_c = run.clone();

    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::effective_max_concurrent(),
        move |(pid, idx_opt, role)| {
            let client = client.clone();
            let app = app.clone();
            let run = run_c.clone();
            async move {
                let Some(idx) = idx_opt else { return }; // vplayers only (façade signer)
                run.players.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                // Raiders are deliberately expendable — their whole point is that
                // losing a Command Ship costs a rebuild, not the economy. Never
                // spend charge hardening them, even with include_bait on.
                if role == Some(VPlayerRole::Raider) {
                    return;
                }
                // Default: only defend productive workers; bait are deliberate raid fodder.
                if !include_bait && role != Some(VPlayerRole::Productive) {
                    return;
                }
                // Resolve THIS player's structs from its planet + fleet slot arrays;
                // the guild struct-LIST endpoints are broken (return a global page,
                // not the owner's), which made auto_defend classify OTHER players'
                // combat structs. See loop_util::player_structs.
                let structs = crate::mcp::loop_util::player_structs(&client, &pid).await;
                if structs.is_empty() {
                    return;
                }

                // Protected targets in priority order: Command Ship (the shield
                // gate) first, then Refinery, then Extractor. (id, ambit) pairs.
                let find_type = |t: &str| -> Option<(String, String, String)> {
                    structs
                        .iter()
                        .filter(|s| !truthy(s.get("is_destroyed")))
                        .find(|s| type_id_of(s) == t)
                        .and_then(|s| {
                            s.get("id").and_then(|x| x.as_str()).map(|id| {
                                let field = |k: &str| {
                                    s.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
                                };
                                (id.to_string(), field("operating_ambit"), field("location_id"))
                            })
                        })
                };
                // (type, id, ambit, location), priority-ordered.
                let protected: Vec<(&str, String, String, String)> = [COMMAND_SHIP_TYPE, REFINERY_TYPE, EXTRACTOR_TYPE]
                    .iter()
                    .filter_map(|t| find_type(t).map(|(id, ambit, loc)| (*t, id, ambit, loc)))
                    .collect();
                if protected.is_empty() {
                    return;
                }

                // Pass 1: classify every combat struct — count existing assignments
                // per protected target, collect idle (built, unassigned) candidates.
                let mut counts: HashMap<String, usize> = HashMap::new();
                // (id, ambit, type_id, location_id)
                let mut idle: Vec<(String, String, String, String)> = Vec::new();
                for s in &structs {
                    if truthy(s.get("is_destroyed")) {
                        continue;
                    }
                    let tid = type_id_of(s);
                    if PROTECTED_TYPES.contains(&tid.as_str()) {
                        continue; // never use a production/command struct as a defender
                    }
                    let Some(sid) = s.get("id").and_then(|x| x.as_str()).map(String::from) else {
                        continue;
                    };
                    if let Some(target) = ASSIGNED_CACHE.lock().unwrap().get(&sid).cloned() {
                        *counts.entry(target).or_insert(0) += 1;
                        continue;
                    }
                    // On-chain check: built + not already defending something.
                    let entity = match client.query_entity("struct", &sid).await {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let sa = entity.get("structAttributes");
                    if !truthy(sa.and_then(|x| x.get("isBuilt"))) {
                        continue; // not online yet
                    }
                    let prot_idx = sa
                        .and_then(|x| x.get("protectedStructIndex"))
                        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|v| v.parse().ok())))
                        .unwrap_or(0);
                    if prot_idx != 0 {
                        // Already defending — cache with its target (struct ids are "5-<index>").
                        let target = format!("5-{}", prot_idx);
                        *counts.entry(target.clone()).or_insert(0) += 1;
                        ASSIGNED_CACHE.lock().unwrap().insert(sid, target);
                        continue;
                    }
                    let field = |k: &str| {
                        s.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
                    };
                    idle.push((sid, field("operating_ambit"), tid, field("location_id")));
                }
                if idle.is_empty() {
                    return;
                }

                // Pick the target: the Command Ship until it has CMD_MIN_DEFENDERS,
                // then whichever protected struct has the fewest defenders
                // (ties break toward the higher-priority target).
                let (target_id, target_ambit, target_loc) = {
                    let cmd = protected.iter().find(|(t, _, _, _)| *t == COMMAND_SHIP_TYPE);
                    match cmd {
                        Some((_, id, ambit, loc)) if counts.get(id).copied().unwrap_or(0) < CMD_MIN_DEFENDERS => {
                            (id.clone(), ambit.clone(), loc.clone())
                        }
                        _ => protected
                            .iter()
                            .min_by_key(|(_, id, _, _)| counts.get(id).copied().unwrap_or(0))
                            .map(|(_, id, ambit, loc)| (id.clone(), ambit.clone(), loc.clone()))
                            .unwrap(),
                    }
                };
                // ── Pick a defender that will actually do something ──────────
                //
                // A defender contributes two SEPARATE things, with different
                // conditions, and it is easy to assign one that does neither:
                //
                //   * BLOCKING needs the defender to share the TARGET's ambit.
                //   * COUNTERING needs the defender's WEAPON to reach the
                //     ATTACKER's ambit.
                //
                // Cross-ambit assignment was measured to be worthless: a
                // Starfighter (space) registered as defender of a Tank (land)
                // took `protectedStructIndex`, and a land attack then landed
                // completely unblocked with no counter from it. It had consumed
                // a defender slot to do nothing.
                //
                // The old code fell back to `idle.first()`, which cheerfully
                // paired hulls that could do neither. `defender_rank` scores
                // both contributions instead, and anything scoring zero is left
                // idle rather than burning its one assignment slot.
                // Co-location outranks everything else: a defender that does not
                // travel with its target stops defending the moment the target
                // leaves home, and a raiding Command Ship is exactly the case
                // where that happens. Within a location, `defender_rank` decides.
                let pick = idle
                    .iter()
                    .max_by_key(|(_, a, tid, loc)| {
                        (
                            travels_with_target(loc, &target_loc),
                            defender_rank(tid, &target_ambit, a),
                        )
                    })
                    .cloned();
                let Some((sid, _, _, _)) = pick.filter(|(_, a, tid, _)| {
                    defender_rank(tid, &target_ambit, a) > 0
                }) else {
                    return; // nothing here can block OR counter — leave them free
                };

                let res = crate::mcp::tx_retry::sign_with_retry(
                    &app,
                    idx,
                    "/structs.structs.MsgStructDefenseSet",
                    json!({ "defenderStructId": sid, "protectedStructId": target_id }),
                    &format!("auto_defend:{pid}"),
                )
                .await;
                match res {
                    Ok(_) => {
                        ASSIGNED_CACHE.lock().unwrap().insert(sid.clone(), target_id.clone());
                        run.actions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        crate::mcp::telemetry::tlog(
                            "auto_defend",
                            crate::mcp::telemetry::Sev::Info,
                            format!("{} defends {} (player {})", sid, target_id, pid),
                        );
                        crate::mcp::board_feed::push(
                            &app,
                            crate::mcp::board_feed::Severity::Info,
                            "auto_defend",
                            format!("{} now defends {} (player {})", sid, target_id, pid),
                        );
                    }
                    Err(e) => {
                        run.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        crate::mcp::telemetry::tlog(
                            "auto_defend",
                            crate::mcp::telemetry::Sev::Warn,
                            format!("defense-set failed for {pid}: {e}"),
                        );
                    }
                }
                // One assignment per player per scan (charge-paced).
            }
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Co-location is the half of the pairing `defender_rank` cannot see.
    /// Measured live: three Ore Bunkers left at home "defending" a Command Ship
    /// that had gone raiding blocked nothing and countered nothing — the shot
    /// landed clean. The same Ore Bunkers absorbed 2 damage for a Command Ship
    /// that was still on station, so this is a preference, not a veto.
    #[test]
    fn a_defender_that_cannot_travel_loses_the_tie() {
        // The failure mode: planetary hull, fleet target.
        assert!(!travels_with_target("2-10813", "9-281"));
        // A fleet hull guarding its own fleet goes where the fleet goes.
        assert!(travels_with_target("9-281", "9-281"));
        // Planet-to-planet is co-located too — nothing there ever moves.
        assert!(travels_with_target("2-10813", "2-10813"));
        // Unknown location: never claim it travels.
        assert!(!travels_with_target("", "9-281"));

        // Ordering: the pick is keyed on (travels, rank), so co-location wins
        // a tie and rank still decides among equals. An Ore Bunker that CAN
        // block (same ambit) but is stuck on the planet must lose to a fleet
        // hull that travels, even one that can only counter.
        let stranded_blocker = (true, 100u64); // same-ambit, wrong location
        let travelling_counter = (true, 2u64);
        assert!(
            (true, travelling_counter.1) > (false, stranded_blocker.1),
            "travelling beats stranded regardless of rank"
        );
    }

    #[test]
    fn default_off_productive_only() {
        let c = AutoDefendConfig::default();
        assert!(!c.enabled);
        assert!(!c.include_bait);
        assert_eq!(c.interval_secs, 180);
    }

    #[test]
    /// A defender's two contributions have two different conditions, so ranking
    /// has to score both. Same-ambit blocks and dominates; cross-ambit still
    /// counters if its WEAPON reaches — measured, a space Battleship (reach
    /// water+land) countered a land attacker and killed it outright, while a
    /// space Starfighter (reach space only) assigned to a land target did
    /// nothing at all. An earlier version of this test asserted the second case
    /// generalised, which was wrong.
    #[test]
    fn ranking_scores_blocking_above_counter_reach_but_values_both() {
        // With no synced struct types every hull scores on blocking alone,
        // which is exactly the conservative fallback we want.
        let blocks = defender_rank("9", "land", "land");
        let cross = defender_rank("9", "land", "space");
        assert!(blocks > cross, "a blocker must outrank a non-blocker");
        assert!(blocks >= 100, "blocking is worth a flat dominant bonus");
    }

    /// Nothing that can neither block nor counter should consume an assignment.
    #[test]
    fn a_hull_that_can_do_nothing_scores_zero() {
        // Unknown type, wrong ambit → no blocking, no known weapon reach.
        assert_eq!(defender_rank("not-a-type", "land", "space"), 0);
    }

    #[test]
    fn production_types_are_not_defenders() {
        assert!(PROTECTED_TYPES.contains(&REFINERY_TYPE));
        assert!(PROTECTED_TYPES.contains(&EXTRACTOR_TYPE));
        assert!(PROTECTED_TYPES.contains(&"1")); // command ship
    }
}
