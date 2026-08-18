//! Continuous Alpha sweep: send a vplayer's Alpha to the primary as soon as it
//! crosses a threshold, instead of waiting for someone to press "Sweep All".
//!
//! WHY A LOOP AND NOT JUST THE BUTTON. The manual mass action sweeps the whole
//! roster in one job. At 533 players that is 533 signed transactions queued
//! back to back — minutes of waiting, and every one of those players has its
//! charge reset in the same burst, so a mass sweep competes with auto_harvest
//! for the same charge. Doing it continuously spreads the same work across the
//! day: a handful of players per scan, only the ones actually worth sweeping,
//! and never the ones whose charge is about to be spent mining.
//!
//! It deliberately reuses `mass_action::build_sweep_plan` rather than
//! reimplementing eligibility. The button and the loop must never disagree
//! about who gets swept or how much leaves them.
//!
//! Off by default — it signs real transfers.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::hasher::types::now_millis;
use crate::mcp::telemetry::{tlog, LoopRun, Sev};
use crate::mcp::tools::mass_action::SweepArgs;

const FILENAME: &str = "auto_sweep.json";
const UALPHA_PER_ALPHA: f64 = 1_000_000.0;

/// player_id → the CACHED balance at which the chain rejected their sweep with
/// "insufficient funds". The roster cache lags a successful sweep, so the same
/// stale row would otherwise be re-sent every scan; the entry clears itself as
/// soon as the cache reports any different balance for that player.
static BROKE_AT_BALANCE: LazyLock<Mutex<std::collections::HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// Lock, recovering from poisoning — this map is advisory (worst case a
/// duplicate send the chain rejects again), so a poisoned lock must never
/// take the loop down.
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoSweepConfig {
    /// Off by default — this signs real transfers.
    pub enabled: bool,
    /// Seconds between scans.
    pub interval_secs: u64,
    /// Sweep a player once its balance reaches this many Alpha. This is the
    /// knob that decides "how full before it's worth a transaction".
    pub min_send_alpha: f64,
    /// Leave this much Alpha behind on each player.
    pub keep_reserve_alpha: f64,
    /// Don't take a player's charge unless it has at least this much. Sending
    /// resets charge to 0, so a low bar here steals charge from mining.
    pub min_charge: u64,
    /// How many players may be swept in a single scan. The whole point of the
    /// loop is to avoid a stampede; raise it only if the queue keeps up.
    pub max_sends_per_scan: usize,
    /// Include bait players (they usually hold nothing worth moving).
    pub include_bait: bool,
    /// Compute and log the plan, sign nothing.
    pub dry_run: bool,
}

impl Default for AutoSweepConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_secs: 900,
            min_send_alpha: 5.0,
            keep_reserve_alpha: 0.0,
            min_charge: 8,
            max_sends_per_scan: 25,
            include_bait: false,
            dry_run: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<AutoSweepConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
static RUN_GEN: AtomicU64 = AtomicU64::new(0);

/// Rolling total of Alpha swept, for the board.
static SWEPT_TOTAL: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

fn load() -> AutoSweepConfig {
    crate::mcp::config_store::load_config(FILENAME)
}
pub fn get() -> AutoSweepConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}
pub fn set(cfg: AutoSweepConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

pub fn swept_total_alpha() -> f64 {
    *SWEPT_TOTAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Resolve an HD index to the address we hold the key for. `None` means we do
/// not control that player, which must never result in a transfer.
fn registry_address(index: u32) -> Option<String> {
    crate::mcp::virtual_players::REGISTRY
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .players
        .iter()
        .find(|p| p.index == index)
        .map(|p| p.address.clone())
        .filter(|a| !a.is_empty())
}

impl AutoSweepConfig {
    fn sweep_args(&self) -> SweepArgs {
        SweepArgs {
            keep_reserve_alpha: self.keep_reserve_alpha,
            // A player is worth sweeping once what it would SEND clears the
            // threshold — the reserve is subtracted before this comparison in
            // build_sweep_plan, so a reserve of 2 and a threshold of 5 means
            // "sweep at 7 held".
            min_send_alpha: self.min_send_alpha,
            min_charge: self.min_charge,
            include_bait: self.include_bait,
        }
    }
}

/// One scan. `force` bypasses the interval (used by the manual "run now").
pub async fn tick(app: &tauri::AppHandle, force: bool) {
    let cfg = get();
    if !cfg.enabled && !force {
        return;
    }
    let now = now_millis();
    {
        let mut last = LAST_RUN.lock().unwrap_or_else(|e| e.into_inner());
        if !force && now - *last < cfg.interval_secs as f64 * 1000.0 {
            return;
        }
        *last = now;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = LoopRun::start("auto_sweep");

    scan(app, &cfg, &run).await;

    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-run".into()));
        return;
    }
    run.finish(None);
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(app: &tauri::AppHandle, cfg: &AutoSweepConfig, run: &LoopRun) {
    let to_address = match crate::mcp::tools::mass_action::primary_send_target() {
        Ok((addr, _pid)) => addr,
        Err(e) => {
            run.blocked(format!("no primary destination: {e}"));
            return;
        }
    };

    let rows = crate::mcp::roster_cache::all_rows();
    if rows.is_empty() {
        run.blocked("roster cache is empty — nothing to sweep from yet");
        return;
    }
    run.players.fetch_add(rows.len() as u32, Ordering::Relaxed);

    // Same eligibility as the manual button, by construction.
    let (mut entries, _skipped) =
        crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());

    // Drop candidates the chain already rejected for insufficient funds at
    // this exact cached balance. The roster cache lags a successful sweep, so
    // without this every scan re-sends from the same freshly-emptied players
    // (seen live: 17 rejects in one afternoon, 1-821 hit twice in 6 minutes).
    // A candidate re-qualifies the moment the cache shows a DIFFERENT balance
    // — that's proof the stale row was refreshed.
    {
        let mut broke = lock_recover(&BROKE_AT_BALANCE);
        entries.retain(|e| match broke.get(&e.player_id) {
            Some(bal) if *bal == e.alpha_before => false,
            Some(_) => {
                broke.remove(&e.player_id);
                true
            }
            None => true,
        });
    }

    if entries.is_empty() {
        run.blocked(format!(
            "no player is holding {} Alpha or more with {}+ charge",
            cfg.min_send_alpha, cfg.min_charge
        ));
        return;
    }

    // Fullest first: if the cap bites, the biggest balances move first, which
    // is also what a human pressing the button would want.
    entries.sort_by(|a, b| b.alpha_before.total_cmp(&a.alpha_before));
    let eligible = entries.len();
    entries.truncate(cfg.max_sends_per_scan);
    let taking = entries.len();

    if cfg.dry_run {
        let total: f64 = entries
            .iter()
            .map(|e| e.amount_ualpha.parse::<f64>().unwrap_or(0.0) / UALPHA_PER_ALPHA)
            .sum();
        tlog(
            "auto_sweep",
            Sev::Notice,
            format!(
                "dry run: would sweep {taking} of {eligible} eligible player(s), {total:.1} Alpha to {to_address}"
            ),
        );
        run.acted();
        return;
    }

    let ok = std::sync::Arc::new(AtomicU64::new(0));
    let failed = std::sync::Arc::new(AtomicU64::new(0));
    let swept = std::sync::Arc::new(Mutex::new(0.0f64));

    let app_c = app.clone();
    let to_c = to_address.clone();
    let (ok_c, failed_c, swept_c) = (ok.clone(), failed.clone(), swept.clone());
    crate::mcp::loop_util::for_each_player_concurrent(
        entries,
        crate::mcp::loop_util::effective_max_concurrent(),
        move |e| {
            let app = app_c.clone();
            let to = to_c.clone();
            let (ok, failed, swept) = (ok_c.clone(), failed_c.clone(), swept_c.clone());
            async move {
                // Stand down while this player is answering a raid: charge is
                // one action per block and the response needs it. Deferral
                // only — the work happens on the next scan.
                if crate::mcp::combat_lists::is_held_for_combat(&e.player_id) {
                    return;
                }
                // The source address MUST come from the local vplayer registry —
                // that is the structural guarantee that this loop can only ever
                // move OUR OWN players' Alpha: a player we hold no HD key for
                // has no entry here and cannot be signed for.
                //
                // `unwrap_or_default()` used to turn a missing entry into an
                // EMPTY fromAddress and still attempt the send. The chain would
                // reject it, but a money transaction should never be built
                // malformed in the first place — refuse and count it.
                let from = match registry_address(e.index) {
                    Some(a) => a,
                    None => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        tlog(
                            "auto_sweep",
                            Sev::Warn,
                            format!(
                                "{} (hd index {}) is not in the vplayer registry — refusing to send",
                                e.player_id, e.index
                            ),
                        );
                        return;
                    }
                };
                let payload = json!({
                    "fromAddress": from,
                    "toAddress": to,
                    "amount": [{ "denom": "ualpha", "amount": e.amount_ualpha }],
                });
                match crate::mcp::tx_retry::sign_with_retry(
                    &app,
                    e.index,
                    "/structs.structs.MsgPlayerSend",
                    payload,
                    &format!("auto_sweep:{}", e.player_id),
                )
                .await
                {
                    Ok(_) => {
                        ok.fetch_add(1, Ordering::Relaxed);
                        let alpha = e.amount_ualpha.parse::<f64>().unwrap_or(0.0) / UALPHA_PER_ALPHA;
                        *swept.lock().unwrap_or_else(|p| p.into_inner()) += alpha;
                    }
                    Err(err) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        // Chain says the money isn't there — remember the
                        // cached balance this happened at so the next scans
                        // skip this player until the cache shows movement.
                        if err.to_lowercase().contains("insufficient funds") {
                            lock_recover(&BROKE_AT_BALANCE)
                                .insert(e.player_id.clone(), e.alpha_before);
                        }
                        tlog(
                            "auto_sweep",
                            Sev::Warn,
                            format!("{} send failed: {err}", e.player_id),
                        );
                    }
                }
            }
        },
    )
    .await;

    let n_ok = ok.load(Ordering::Relaxed);
    let n_failed = failed.load(Ordering::Relaxed);
    let total = *swept.lock().unwrap_or_else(|p| p.into_inner());
    run.actions.fetch_add(n_ok as u32, Ordering::Relaxed);
    run.errors.fetch_add(n_failed as u32, Ordering::Relaxed);
    if let Ok(mut t) = SWEPT_TOTAL.lock() {
        *t += total;
    }

    if n_ok > 0 {
        run.acted();
        crate::mcp::board_feed::push(
            app,
            crate::mcp::board_feed::Severity::Notice,
            "auto_sweep",
            format!(
                "swept {total:.1} Alpha from {n_ok} player(s) to the primary{}{}",
                if n_failed > 0 { format!(" · {n_failed} failed") } else { String::new() },
                if eligible > taking {
                    format!(" · {} still over threshold", eligible - taking)
                } else {
                    String::new()
                }
            ),
        );
    } else if n_failed > 0 {
        run.blocked(format!("{n_failed} send(s) failed — see the tx ledger"));
    }
}

/// Watchdog remediation: invalidate the wedged run and clear the guard.
pub fn force_reset_running() {
    RUN_GEN.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::roster_cache::RosterRow;

    fn row(pid: &str, index: Option<u32>, role: &str, alpha: f64, charge: u64) -> RosterRow {
        RosterRow {
            index,
            player_id: pid.into(),
            name: pid.into(),
            role: role.into(),
            planet_id: None,
            fleet_id: None,
            alpha_ualpha: alpha * UALPHA_PER_ALPHA,
            ore: 0.0,
            load: 0.0,
            capacity: 0.0,
            structs_load: 0.0,
            charge,
            last_action_block: 0,
            fetched_at_ms: 0.0,
            pfp_attrs: None,
            chain_name: None,
            planet_ore: None,
            mine_eta_s: None,
            refine_eta_s: None,
            err: None,
        }
    }

    #[test]
    fn defaults_are_off_and_conservative() {
        let c = AutoSweepConfig::default();
        assert!(!c.enabled, "must not sign transfers until switched on");
        assert!(!c.include_bait);
        assert_eq!(c.min_charge, 8);
        assert!(c.max_sends_per_scan > 0, "a zero cap would sweep nothing forever");
    }

    /// The threshold is the whole feature: below it, a player is left alone.
    #[test]
    fn only_players_over_the_threshold_are_swept() {
        let cfg = AutoSweepConfig { min_send_alpha: 5.0, ..Default::default() };
        let rows = vec![
            row("1-1", Some(1), "productive", 4.9, 20),
            row("1-2", Some(2), "productive", 5.0, 20),
            row("1-3", Some(3), "productive", 99.0, 20),
        ];
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());
        let ids: Vec<&str> = plan.iter().map(|e| e.player_id.as_str()).collect();
        assert_eq!(ids, vec!["1-2", "1-3"]);
    }

    /// Sending resets charge to 0, so a player saving charge to mine is skipped.
    #[test]
    fn low_charge_players_are_left_alone() {
        let cfg = AutoSweepConfig { min_send_alpha: 1.0, min_charge: 8, ..Default::default() };
        let rows = vec![
            row("1-1", Some(1), "productive", 50.0, 7),
            row("1-2", Some(2), "productive", 50.0, 8),
        ];
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].player_id, "1-2");
    }

    /// The primary has no HD index and must never be a source.
    #[test]
    fn primary_is_never_swept() {
        let cfg = AutoSweepConfig { min_send_alpha: 1.0, ..Default::default() };
        let rows = vec![row("1-194", None, "primary", 800.0, 99)];
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());
        assert!(plan.is_empty());
    }

    /// The reserve is subtracted before the threshold test, so "keep 2, sweep
    /// at 5" means a player is swept once it holds 7.
    #[test]
    fn reserve_is_kept_and_shifts_the_trigger() {
        let cfg = AutoSweepConfig {
            min_send_alpha: 5.0,
            keep_reserve_alpha: 2.0,
            ..Default::default()
        };
        let rows = vec![
            row("1-1", Some(1), "productive", 6.9, 20),
            row("1-2", Some(2), "productive", 7.0, 20),
        ];
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].player_id, "1-2");
        // 7 held − 2 reserve = 5 sent.
        assert_eq!(plan[0].amount_ualpha, "5000000");
    }

    /// The per-scan cap is what stops this becoming the stampede it replaces.
    #[test]
    fn cap_takes_the_fullest_players_first() {
        let cfg = AutoSweepConfig { min_send_alpha: 1.0, max_sends_per_scan: 2, ..Default::default() };
        let rows = vec![
            row("1-1", Some(1), "productive", 10.0, 20),
            row("1-2", Some(2), "productive", 90.0, 20),
            row("1-3", Some(3), "productive", 50.0, 20),
        ];
        let (mut plan, _) =
            crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());
        plan.sort_by(|a, b| b.alpha_before.total_cmp(&a.alpha_before));
        plan.truncate(cfg.max_sends_per_scan);
        let ids: Vec<&str> = plan.iter().map(|e| e.player_id.as_str()).collect();
        assert_eq!(ids, vec!["1-2", "1-3"]);
    }

    /// The safety property the whole loop rests on: a source must be a player
    /// we hold an HD key for. Anything else — someone else's account, a stale
    /// roster row — resolves to None and must never produce a transfer.
    #[test]
    fn only_players_we_hold_keys_for_can_be_a_source() {
        // Index 999_999 is not in any registry this test could load.
        assert!(registry_address(999_999).is_none());
    }

    /// The roster is the union of our own vplayers plus the primary, and the
    /// primary is the only row without an index — so "everyone" in a sweep
    /// plan is, by construction, our own workers.
    #[test]
    fn a_plan_only_ever_contains_indexed_team_players() {
        let cfg = AutoSweepConfig { min_send_alpha: 1.0, ..Default::default() };
        let rows = vec![
            row("1-194", None, "primary", 500.0, 99),      // primary: no index
            row("1-271", Some(1), "productive", 50.0, 20), // ours
            row("1-999", Some(2), "productive", 50.0, 20), // ours
        ];
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, cfg.sweep_args());
        assert!(plan.iter().all(|e| e.player_id != "1-194"), "primary must never be a source");
        assert_eq!(plan.len(), 2);
    }

    /// Bait players are excluded unless asked for.
    #[test]
    fn bait_is_opt_in() {
        let rows = vec![row("1-9", Some(9), "bait", 50.0, 20)];
        let off = AutoSweepConfig { min_send_alpha: 1.0, ..Default::default() };
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, off.sweep_args());
        assert!(plan.is_empty());
        let on = AutoSweepConfig { min_send_alpha: 1.0, include_bait: true, ..Default::default() };
        let (plan, _) = crate::mcp::tools::mass_action::build_sweep_plan(&rows, None, on.sweep_args());
        assert_eq!(plan.len(), 1);
    }
}
