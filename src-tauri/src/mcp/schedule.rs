//! The scheduler: one place that decides which automation loop runs on each
//! sync tick, in priority order, and why.
//!
//! Every loop used to be spawned on every sync and throttle itself on a fixed
//! interval, whether or not anything was due. Now:
//!
//! * **Lanes** order the spawns — combat first, then defense, economy, upkeep —
//!   so a raid answer is never queued behind bookkeeping.
//! * **Need-gated loops** (harvest, crew) report, at the end of each scan, the
//!   first height their waiting work ripens at (from the mirror's forecasts)
//!   and whether anything is pending now (an explore). A scheduled run is
//!   SKIPPED while nothing is due, nothing is pending, nothing changed and the
//!   backstop has not elapsed. The loop's own interval still spaces the runs
//!   that do happen, so this only ever removes scans, never adds them.
//! * **Changes** the forecasts cannot see — our own action landing, a fresh
//!   snapshot — mark the need-gated loops dirty, and they run at their next
//!   interval.
//! * Everything else keeps its own cadence (`Wake::Cadence`): combat loops
//!   because a raid must be answered on time, build because its initiate side
//!   is gated by charge that is ready for nearly every player nearly always,
//!   so a forecast wake would fire constantly.
//!
//! Charge and GPU arbitration stay where they already work — per-player charge
//! reservations with combat holds (loop_util, combat_lists) and the shared
//! hasher pool — and are reported here, not re-implemented.

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::AppHandle;

use crate::hasher::types::now_millis;

/// Run order within a sync tick.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    Combat,
    Defense,
    Economy,
    Upkeep,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Wake {
    /// Spawned every sync; the loop's own interval decides.
    Cadence,
    /// Spawned only when due, pending, dirty or past the backstop.
    Need,
}

/// The safety net for a need-gated loop: it runs at least this often even
/// when it reports nothing due, so a world change no forecast or event shows
/// is never missed for long.
pub const BACKSTOP_MS: f64 = 10.0 * 60_000.0;

/// What a need-gated loop last reported, and what the scheduler did.
#[derive(Clone, Debug, Default, Serialize)]
pub struct LoopState {
    /// The first height the loop's waiting work ripens at.
    pub next_due: Option<u64>,
    /// Work it can do now regardless of the clock (e.g. an explore).
    pub pending: usize,
    /// Something changed the forecasts cannot see.
    pub dirty: bool,
    pub last_report_ms: f64,
    pub last_summary: String,
    pub runs: u64,
    /// Scheduled runs skipped because nothing was due.
    pub skipped_idle: u64,
    /// When the scheduler last chose to skip it — a deliberate idle, which
    /// the watchdog counts as a live loop rather than an overdue one.
    pub last_skip_ms: f64,
    /// Why the last run was let through.
    pub last_reason: Option<&'static str>,
}

static STATE: LazyLock<Mutex<BTreeMap<&'static str, LoopState>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// A need-gated loop reports at the end of a scan.
pub fn report(name: &'static str, next_due: Option<u64>, pending: usize, summary: impl Into<String>) {
    if let Ok(mut m) = STATE.lock() {
        let st = m.entry(name).or_default();
        st.next_due = next_due;
        st.pending = pending;
        st.dirty = false;
        st.last_report_ms = now_millis();
        st.last_summary = summary.into();
        st.runs += 1;
    }
}

/// Messages whose landing moves an input of the economy forecasts — ore and
/// clocks (completions, a raid's end), where rigs stand and whether they run
/// (explore, build, activate/deactivate, struct and fleet moves, trash), and
/// power (allocations, substations, infusions, agreements). Defense wiring,
/// stealth, attacks, permissions, guild and bank traffic change none of them,
/// so they do not wake the need-gated loops.
const ECONOMY_INPUTS: &[&str] = &[
    "MsgStructOreMinerComplete",
    "MsgStructOreRefineryComplete",
    "MsgStructBuildComplete",
    "MsgStructBuildInitiate",
    "MsgStructBuildCancel",
    "MsgPlanetExplore",
    "MsgPlanetRaidComplete",
    "MsgStructActivate",
    "MsgStructDeactivate",
    "MsgStructDeactivateBatch",
    "MsgStructMove",
    "MsgFleetMove",
    "MsgStructTrash",
    "MsgStructGeneratorInfuse",
    "MsgReactorInfuse",
    "MsgReactorDefuse",
    "MsgReactorCancelDefusion",
    "MsgAllocationCreate",
    "MsgAllocationDelete",
    "MsgAllocationUpdate",
    "MsgAllocationTransfer",
    "MsgSubstationAllocationConnect",
    "MsgSubstationAllocationDisconnect",
    "MsgSubstationPlayerConnect",
    "MsgSubstationPlayerDisconnect",
    "MsgSubstationPlayerMigrate",
    "MsgAgreementOpen",
    "MsgAgreementClose",
    "MsgAgreementCapacityIncrease",
    "MsgAgreementCapacityDecrease",
];

/// Does a landed message (type URL, bare name, or webview action like
/// `struct_activate`) move an economy forecast input? Pure.
pub fn affects_economy(action: &str) -> bool {
    let name = action.rsplit('.').next().unwrap_or(action);
    if ECONOMY_INPUTS.contains(&name) {
        return true;
    }
    // Webview actions: snake_case of the message without `Msg`.
    let camel: String = name
        .split('_')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
        })
        .collect();
    ECONOMY_INPUTS.contains(&format!("Msg{camel}").as_str())
}

/// One of our own messages landed: wake the need-gated loops if it moved
/// something they forecast from.
pub fn landed(action: &str) {
    if affects_economy(action) {
        mark_dirty();
    }
}

/// A landed message with its payload. A MINE completion's effect on the
/// harvest plan is known exactly — the planet's mine clock restarts at the
/// inclusion height (`StructCache.OreMinePlanet`), so this rig is next ripe
/// at that height plus `ready_age(range, aim)` — and is folded into the
/// loop's next due height instead of forcing a rescan. Everything else that
/// moves an economy input marks the loops changed (a refine can empty a pile
/// and make an explore due; a build adds a rig).
pub fn landed_with(type_url: &str, payload: &serde_json::Value) {
    if type_url.ends_with("MsgStructOreMinerComplete") {
        let sid = payload.get("structId").and_then(|s| s.as_str()).unwrap_or("");
        let tip = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
        let range = crate::mcp::perception::with_snapshot(|s| s.struct_row(sid).map(|r| r.type_id.clone()))
            .flatten()
            .and_then(|t| crate::game_state::GAME_STATE.read().ok()?.struct_types.get(&t).map(|t| t.ore_mining_difficulty))
            .filter(|r| *r > 0);
        let aim = crate::mcp::auto_harvest::get().difficulty_threshold;
        match (tip, range.and_then(|r| crate::mirror::rules::ready_age(r, aim))) {
            (t, Some(age)) if t > 0 => {
                fold_due("auto_harvest", crate::mirror::rules::earliest_execution(t) + age);
                return;
            }
            _ => {}
        }
    }
    landed(type_url);
}

/// Bring a loop's next due height forward to `height` if that is sooner.
pub fn fold_due(name: &'static str, height: u64) {
    if let Ok(mut m) = STATE.lock() {
        if let Some(st) = m.get_mut(name) {
            st.next_due = Some(st.next_due.map_or(height, |d| d.min(height)));
        }
    }
}

/// Something changed that forecasts do not show; every need-gated loop runs
/// at its next interval.
pub fn mark_dirty() {
    if let Ok(mut m) = STATE.lock() {
        for (_, st) in m.iter_mut() {
            st.dirty = true;
        }
    }
}

/// When the scheduler last skipped `name` because nothing was due (0 = never).
pub fn last_skip_ms(name: &str) -> f64 {
    STATE.lock().ok().and_then(|m| m.get(name).map(|s| s.last_skip_ms)).unwrap_or(0.0)
}

/// Should a need-gated loop run now? `None` = skip; otherwise the reason.
/// Pure.
pub fn reason_to_run(st: Option<&LoopState>, tip: u64, now_ms: f64) -> Option<&'static str> {
    let Some(st) = st else { return Some("first_run") };
    if st.dirty {
        return Some("changed");
    }
    if st.pending > 0 {
        return Some("pending");
    }
    if st.next_due.is_some_and(|h| crate::mirror::rules::earliest_execution(tip) >= h) {
        return Some("due");
    }
    if now_ms - st.last_report_ms >= BACKSTOP_MS {
        return Some("backstop");
    }
    None
}

fn decide(name: &'static str) -> bool {
    // On rules the mirror was not built from, forecast due heights may be
    // wrong: run on the loop's own interval instead of sleeping on them.
    if crate::mirror::epoch::trusted().is_err() {
        return true;
    }
    let tip = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    let Ok(mut m) = STATE.lock() else { return true };
    let reason = reason_to_run(m.get(name), tip, now_millis());
    match (reason, m.get_mut(name)) {
        (Some(r), Some(st)) => {
            st.last_reason = Some(r);
            true
        }
        (Some(_), None) => true,
        (None, Some(st)) => {
            st.skipped_idle += 1;
            st.last_skip_ms = now_millis();
            false
        }
        (None, None) => true,
    }
}

macro_rules! spawn {
    ($app:expr, $f:expr) => {{
        let app = $app.clone();
        tokio::spawn(async move { $f(&app).await });
    }};
}

/// One sync tick: every loop, in lane order, need-gated where it can be.
pub fn on_sync(app: &AppHandle) {
    tokio::spawn(async {
        crate::mirror::epoch::refresh(&crate::mcp::cosmos_client::CosmosClient::new()).await;
    });
    // Keep the snapshot on its own clock. The loops call this only when a
    // scan STARTS, and a sign-bound scan can run for half an hour: on
    // 2026-11-08 harvest, build and defend each spent ~33 min in one scan,
    // nothing refreshed, the snapshot went 34 min stale, and the loops fell
    // back to ~2,500 single-struct chain reads a minute and signed against
    // drifted state (59 failed defense clears). A no-op unless one is due and
    // none is running.
    crate::mcp::perception::maybe_refresh(&crate::mcp::cosmos_client::CosmosClient::new());
    // ── Combat ── a raid resolves in about four minutes end to end, and every
    // defensive win on record fired back inside the first two.
    spawn!(app, |a| crate::mcp::auto_response::tick(a, false));
    spawn!(app, |a| crate::mcp::auto_raid::tick(a, false));
    // ── Defense ──
    spawn!(app, |a| crate::mcp::auto_defend::tick(a, false));
    // ── Economy ── harvest is need-gated by its forecasts; build keeps its
    // cadence (its initiate side waits on charge, ready almost always).
    if decide("auto_harvest") {
        spawn!(app, |a| crate::mcp::auto_harvest::tick(a, false));
    }
    spawn!(app, |a| crate::mcp::auto_build::tick(a, false));
    spawn!(app, |a| crate::mcp::auto_infuse::tick(a, false));
    spawn!(app, |a| crate::mcp::auto_sweep::tick(a, false));
    // Crew only fills hashing slots the colony left free, so it comes after
    // the loops that claim them; need-gated by the members' forecasts.
    if decide("crew_work") {
        spawn!(app, |a| crate::mcp::crew_work::tick(a, false));
    }
    spawn!(app, |a| crate::mcp::crew_pay::tick(a, false));
    // ── Upkeep ── delegation before replication, so a fresh replicant is
    // grantable before any other loop touches it.
    spawn!(app, |a| crate::mcp::delegation::tick(a, false));
    spawn!(app, |a| crate::mcp::auto_replicate::tick(a, false));
    spawn!(app, |a| crate::mcp::energy_card::tick(a));
    spawn!(app, |a| crate::mcp::rates::tick(a));
}

/// The loop table, for the status view.
pub fn table() -> Vec<(&'static str, Lane, Wake)> {
    use Lane::*;
    use Wake::*;
    vec![
        ("auto_response", Combat, Cadence),
        ("auto_raid", Combat, Cadence),
        ("auto_defend", Defense, Cadence),
        ("auto_harvest", Economy, Need),
        ("auto_build", Economy, Cadence),
        ("auto_infuse", Economy, Cadence),
        ("auto_sweep", Economy, Cadence),
        ("crew_work", Economy, Need),
        ("crew_pay", Economy, Cadence),
        ("delegation", Upkeep, Cadence),
        ("auto_replicate", Upkeep, Cadence),
        ("energy_card", Upkeep, Cadence),
        ("rates", Upkeep, Cadence),
    ]
}

/// `structs_system schedule`.
pub fn status() -> serde_json::Value {
    let tip = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    let exec = crate::mirror::rules::earliest_execution(tip);
    let state = STATE.lock().map(|m| m.clone()).unwrap_or_default();
    let loops: Vec<serde_json::Value> = table()
        .into_iter()
        .map(|(name, lane, wake)| {
            let st = state.get(name);
            serde_json::json!({
                "loop": name,
                "lane": lane,
                "wake": wake,
                "state": st,
                "due_in_blocks": st.and_then(|s| s.next_due).map(|h| h.saturating_sub(exec)),
                "would_run_now": if wake == Wake::Need { serde_json::json!(reason_to_run(st, tip, now_millis())) } else { serde_json::json!("own interval") },
            })
        })
        .collect();
    let (orders_version, orders_author) = crate::mcp::orders::version();
    serde_json::json!({
        "tip": tip,
        "standing_orders": { "version": orders_version, "author": orders_author },
        "mandates": { "caps": crate::mcp::mandate::live(), "landed_last_hour": crate::mcp::mandate::usage(now_millis()) },
        "rules_epoch": { "epoch": crate::mirror::epoch::current(), "trusted": crate::mirror::epoch::trusted().err().unwrap_or_else(|| "yes".into()) },
        "backstop_s": BACKSTOP_MS / 1000.0,
        "loops": loops,
        "gate": crate::mirror::gate::stats(),
        "arbitration": "charge: per-player reservations, combat holds first (loop_util, combat_lists); GPU: shared hasher pool, crew fills only free slots",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(next_due: Option<u64>, pending: usize, dirty: bool, age_ms: f64) -> LoopState {
        LoopState { next_due, pending, dirty, last_report_ms: 1_000_000.0 - age_ms, ..Default::default() }
    }

    #[test]
    fn a_loop_that_never_ran_runs() {
        assert_eq!(reason_to_run(None, 100, 1_000_000.0), Some("first_run"));
    }

    #[test]
    fn nothing_due_nothing_pending_nothing_changed_is_skipped() {
        assert_eq!(reason_to_run(Some(&st(Some(500), 0, false, 1_000.0)), 100, 1_000_000.0), None);
        assert_eq!(reason_to_run(Some(&st(None, 0, false, 1_000.0)), 100, 1_000_000.0), None);
    }

    #[test]
    fn due_work_runs_from_the_height_it_can_execute_at() {
        // Tip 499 → a tx executes at 500.
        assert_eq!(reason_to_run(Some(&st(Some(500), 0, false, 1_000.0)), 499, 1_000_000.0), Some("due"));
        assert_eq!(reason_to_run(Some(&st(Some(500), 0, false, 1_000.0)), 498, 1_000_000.0), None);
    }

    #[test]
    fn pending_work_and_changes_run_regardless_of_the_clock() {
        assert_eq!(reason_to_run(Some(&st(Some(9_999), 2, false, 1_000.0)), 1, 1_000_000.0), Some("pending"));
        assert_eq!(reason_to_run(Some(&st(Some(9_999), 0, true, 1_000.0)), 1, 1_000_000.0), Some("changed"));
    }

    #[test]
    fn the_backstop_catches_what_nothing_reported() {
        assert_eq!(reason_to_run(Some(&st(None, 0, false, BACKSTOP_MS)), 1, 1_000_000.0), Some("backstop"));
    }

    #[test]
    fn only_messages_that_move_economy_inputs_wake_the_loops() {
        for a in ["/structs.structs.MsgStructOreMinerComplete", "/structs.structs.MsgPlanetExplore", "MsgFleetMove", "struct_activate", "planet_explore", "fleet_move", "struct_build_initiate"] {
            assert!(affects_economy(a), "{a}");
        }
        for a in ["/structs.structs.MsgStructDefenseSet", "/structs.structs.MsgStructAttack", "/structs.structs.MsgStructStealthActivate", "/cosmos.bank.v1beta1.MsgSend", "struct_defense_set", "struct_attack", "/structs.structs.MsgPermissionGrantOnObject"] {
            assert!(!affects_economy(a), "{a}");
        }
    }

    #[test]
    fn a_folded_due_height_only_ever_moves_earlier() {
        report("test_fold", Some(1_000), 0, "");
        fold_due("test_fold", 1_500);
        assert_eq!(STATE.lock().unwrap()["test_fold"].next_due, Some(1_000));
        fold_due("test_fold", 900);
        assert_eq!(STATE.lock().unwrap()["test_fold"].next_due, Some(900));
        fold_due("never_reported", 5);
        assert!(!STATE.lock().unwrap().contains_key("never_reported"), "folding does not invent a loop");
    }

    #[test]
    fn combat_runs_before_everything_else() {
        let t = table();
        let lanes: Vec<Lane> = t.iter().map(|(_, l, _)| *l).collect();
        let mut sorted = lanes.clone();
        sorted.sort();
        assert_eq!(lanes, sorted, "the table is in lane order");
        assert_eq!(t[0].1, Lane::Combat);
    }
}
