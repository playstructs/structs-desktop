//! Primary control over every virtual player.
//!
//! A virtual player is a separate on-chain identity — its own player object,
//! its own planet, its own fleet — that we happen to hold the key for, at HD
//! index N off the shared mnemonic. Holding the key is enough to SIGN as it,
//! but the chain's permission model is per-player: the primary player has no
//! standing on a vplayer's objects at all. Every gameplay handler checks
//! `PermPlay` (and the hash bits) on the OWNER player object, so without a
//! grant the primary cannot touch a vplayer's structs, fleet or balance from
//! its own address — only the app, re-deriving that vplayer's key, can.
//!
//! That is a single point of failure with 2,000+ players behind it. This module
//! closes it: each vplayer grants the primary `PermAll` on its own player
//! object, so the primary can operate any of them directly — from the webapp,
//! from `structsd`, from anywhere the primary key signs — with no HD derivation
//! and no dependency on this app.
//!
//! WHY THE VPLAYER SIGNS IT. `PermissionGrantOnObject` checks the caller's
//! permission on the TARGET object, and grants are capped at what the caller
//! already holds. Ownership implies every bit, so the vplayer granting on its
//! own object is the only signer that can hand over `PermAll` — the primary
//! cannot grant itself anything.
//!
//! Two entry points, one grant path:
//!   * creation — `grant_on_create`, best-effort, right after signup registers;
//!   * backfill — `tick`, an always-on loop that finds vplayers still missing
//!     the grant and issues it, budgeted so a 2,000-player roster rolls out
//!     over hours instead of queueing 2,000 transactions at once.
//!
//! The transaction is free (`MsgPermission*` is on the chain's free-gas path)
//! and costs no charge — verified live: a grant left the player's `lastAction`
//! untouched. So this never competes with mining or building.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::telemetry::{tlog, LoopRun, Sev};

const FILENAME: &str = "delegation.json";

/// All 25 permission bits (2^25 - 1) — the chain's `PermAll` / `PermPlayerAll`.
/// The one definition in the app; anything comparing or decoding a full mask
/// reads it from here so a future 26th bit is a one-line change.
pub const PERM_ALL: u64 = 33_554_431;

/// How many pages of the permission store one backfill scan will walk. The LCD
/// paginates the WHOLE store and filters each page, so this bounds the scan
/// rather than the result: at 1,000 records a page it covers 50,000 permission
/// records (the live store is ~5,000). Hitting it is logged, never silent.
const MAX_SCAN_PAGES: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationConfig {
    /// ON by default, unlike the loops that spend resources. This one costs
    /// nothing (free tx, no charge) and its whole purpose is to be true BEFORE
    /// you need it — a grant you have to remember to switch on is a grant you
    /// discover missing on the day the app won't start.
    pub enabled: bool,
    /// Seconds between backfill scans.
    pub interval_secs: u64,
    /// Grants started per scan. A roster of thousands must not become
    /// thousands of queued transactions in one burst (that shape has taken
    /// this app down before); at 100 per 15 minutes a 2,000-player backfill
    /// finishes in about five hours and nothing else notices.
    pub max_grants_per_scan: usize,
    /// Find and report the gap, sign nothing.
    pub dry_run: bool,
}

impl Default for DelegationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_secs: 900,
            max_grants_per_scan: 100,
            dry_run: false,
        }
    }
}

static CONFIG: LazyLock<RwLock<DelegationConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);
static RUN_GEN: AtomicU64 = AtomicU64::new(0);

/// Player ids with a grant CURRENTLY IN FLIGHT, so two overlapping scans — or a
/// scan and a creation hook — never sign the same grant twice. Claimed before
/// signing, released when the attempt settles either way.
///
/// Deliberately NOT a memo of who has been granted: "who holds the grant" is
/// re-read from the chain on every scan, which is what makes a revoked grant
/// come back instead of being remembered as done.
static INFLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn load() -> DelegationConfig {
    crate::mcp::config_store::load_config(FILENAME)
}
pub fn get() -> DelegationConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}
pub fn set(cfg: DelegationConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The player the grants point AT. `None` until the app has signed in and
/// resolved its own id — with no primary there is nothing to delegate to, and
/// granting to the wrong id would hand a stranger full control.
pub fn primary_player_id() -> Option<String> {
    crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|g| g.player_id.clone())
        .filter(|s| !s.is_empty())
}

/// True when `mask` carries every bit of `PermAll` (`HasAll` semantics, the
/// same test the chain applies).
pub fn has_full_control(mask: u64) -> bool {
    mask & PERM_ALL == PERM_ALL
}

/// Sign the grant AS the virtual player. Returns Ok only when the chain
/// accepted it (`tx_retry` treats a non-zero code as a failure), so a caller
/// may take success as proof the record now exists.
pub async fn grant(
    app: &tauri::AppHandle,
    index: u32,
    player_id: &str,
    primary_id: &str,
) -> Result<(), String> {
    if player_id == primary_id {
        return Err("refusing to grant a player control over itself".into());
    }
    crate::mcp::tx_retry::sign_with_retry(
        app,
        index,
        "/structs.structs.MsgPermissionGrantOnObject",
        json!({
            "objectId": player_id,
            "playerId": primary_id,
            "permissions": PERM_ALL,
        }),
        &format!("delegation:{player_id}"),
    )
    .await
    .map(|_| ())
}

/// Creation hook: hand the primary control of a player that was just signed
/// up. Fire-and-forget and deliberately best-effort — a failure here must
/// never fail the create, because the backfill loop sweeps up anything that
/// didn't land (including players whose id was still pending at creation).
pub fn grant_on_create(app: &tauri::AppHandle, index: u32, player_id: &str) {
    let Some(primary) = primary_player_id() else {
        return; // backfill will do it once we know who the primary is
    };
    if player_id == primary || player_id.is_empty() {
        return;
    }
    if !lock_recover(&INFLIGHT).insert(player_id.to_string()) {
        return; // a scan is already granting this one
    }
    let (app, pid) = (app.clone(), player_id.to_string());
    tauri::async_runtime::spawn(async move {
        let res = grant(&app, index, &pid, &primary).await;
        lock_recover(&INFLIGHT).remove(&pid);
        if let Err(e) = res {
            tlog(
                "delegation",
                Sev::Warn,
                format!("{pid} (idx {index}): primary grant failed at creation: {e} — backfill will retry"),
            );
        }
    });
}

/// Every registered vplayer with an on-chain id, as `(index, player_id)`.
fn roster() -> Vec<(u32, String)> {
    crate::mcp::virtual_players::REGISTRY
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .players
        .iter()
        .filter_map(|p| p.player_id.clone().map(|pid| (p.index, pid)))
        .collect()
}

/// One backfill scan. `force` bypasses the interval (manual "run now").
pub async fn tick(app: &tauri::AppHandle, force: bool) {
    let cfg = get();
    if !cfg.enabled && !force {
        return;
    }
    let now = now_millis();
    {
        let mut last = lock_recover(&LAST_RUN);
        if !force && now - *last < cfg.interval_secs as f64 * 1000.0 {
            return;
        }
        *last = now;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = RUN_GEN.load(Ordering::SeqCst);
    let run = LoopRun::start("delegation");

    scan(app, &cfg, &run).await;

    if RUN_GEN.load(Ordering::SeqCst) != gen {
        run.finish_stale(Some("invalidated by watchdog reset mid-run".into()));
        return;
    }
    run.finish(None);
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(app: &tauri::AppHandle, cfg: &DelegationConfig, run: &LoopRun) {
    let Some(primary) = primary_player_id() else {
        run.blocked("not signed in yet — no primary player to delegate to");
        return;
    };
    let roster = roster();
    if roster.is_empty() {
        run.blocked("no virtual players with an on-chain id yet");
        return;
    }
    run.players
        .fetch_add(roster.len() as u32, Ordering::Relaxed);

    // ONE store scan answers "who already granted?" for the whole roster —
    // 6 requests today, against 2,000+ if each player were read individually.
    let client = CosmosClient::new();
    let (records, truncated) = match client.permissions_by_player(&primary, MAX_SCAN_PAGES).await {
        Ok(r) => r,
        Err(e) => {
            run.errors.fetch_add(1, Ordering::Relaxed);
            run.blocked(format!("could not read existing grants: {e}"));
            return;
        }
    };
    if truncated {
        tlog(
            "delegation",
            Sev::Warn,
            format!(
                "permission scan stopped at {MAX_SCAN_PAGES} pages — some existing grants may be \
                 unseen, which only means a redundant (harmless) re-grant"
            ),
        );
    }
    let held: HashSet<&str> = records
        .iter()
        .filter(|(_, mask)| has_full_control(*mask))
        .map(|(object_id, _)| object_id.as_str())
        .collect();

    // Candidates: the chain says they don't grant it, and nobody is already
    // granting it. A creation hook that lands between this read and the sign
    // below would cost one redundant (free, idempotent) transaction — the
    // alternative, remembering grants across scans, would mean never noticing
    // a revoked one.
    let ungranted: Vec<(u32, String)> = roster
        .into_iter()
        .filter(|(_, pid)| *pid != primary && !held.contains(pid.as_str()))
        .collect();
    if ungranted.is_empty() {
        run.blocked(format!(
            "every virtual player already grants {primary} full control"
        ));
        return;
    }
    let mut missing = {
        let inflight = lock_recover(&INFLIGHT);
        ungranted
            .into_iter()
            .filter(|(_, pid)| !inflight.contains(pid))
            .collect::<Vec<_>>()
    };
    if missing.is_empty() {
        // Not idle and not blocked: the gap is already being closed by grants
        // this scan can see are in flight.
        return;
    }

    // Oldest players first (lowest HD index): they are the ones that have been
    // unreachable-without-this-app the longest.
    missing.sort_by_key(|(index, _)| *index);
    let pending = missing.len();
    missing.truncate(cfg.max_grants_per_scan);
    let taking = missing.len();

    if cfg.dry_run {
        tlog(
            "delegation",
            Sev::Notice,
            format!("dry run: {pending} virtual player(s) do not grant {primary} full control"),
        );
        run.acted();
        return;
    }

    // Claim the batch before signing so a scan that overlaps this one (a forced
    // run, say) picks different players rather than double-signing these.
    {
        let mut inflight = lock_recover(&INFLIGHT);
        missing.retain(|(_, pid)| inflight.insert(pid.clone()));
    }

    let ok = std::sync::Arc::new(AtomicU64::new(0));
    let failed = std::sync::Arc::new(AtomicU64::new(0));
    let app_c = app.clone();
    let primary_c = primary.clone();
    let (ok_c, failed_c) = (ok.clone(), failed.clone());
    crate::mcp::loop_util::for_each_player_concurrent(
        missing,
        crate::mcp::capacity::reads_fanout(),
        move |(index, pid)| {
            let app = app_c.clone();
            let primary = primary_c.clone();
            let (ok, failed) = (ok_c.clone(), failed_c.clone());
            async move {
                let res = grant(&app, index, &pid, &primary).await;
                // Release the claim either way: a success is now visible to the
                // next scan's chain read, and a failure must be retryable.
                lock_recover(&INFLIGHT).remove(&pid);
                match res {
                    Ok(()) => {
                        ok.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        tlog(
                            "delegation",
                            Sev::Warn,
                            format!("{pid} (idx {index}): primary grant failed: {e}"),
                        );
                    }
                }
            }
        },
    )
    .await;

    let n_ok = ok.load(Ordering::Relaxed);
    let n_failed = failed.load(Ordering::Relaxed);
    run.actions.fetch_add(n_ok as u32, Ordering::Relaxed);
    run.errors.fetch_add(n_failed as u32, Ordering::Relaxed);

    if n_ok > 0 {
        run.acted();
        let left = pending.saturating_sub(taking);
        let msg = format!(
            "{n_ok} virtual player(s) now grant {primary} full control{}{}",
            if n_failed > 0 {
                format!(" · {n_failed} failed")
            } else {
                String::new()
            },
            if left > 0 {
                format!(" · {left} still to go (budgeted, continues next scan)")
            } else {
                String::new()
            }
        );
        tlog("delegation", Sev::Info, msg.clone());
        crate::mcp::board_feed::push(
            app,
            crate::mcp::board_feed::Severity::Info,
            "delegation",
            msg,
        );
    } else if n_failed > 0 {
        run.blocked(format!("{n_failed} grant(s) failed — see the tx ledger"));
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

    #[test]
    fn perm_all_is_every_bit() {
        assert_eq!(PERM_ALL, (1u64 << 25) - 1);
        assert!(has_full_control(PERM_ALL));
        // The pre-v0.16 24-bit mask is NOT full control any more — a player
        // carrying it must still be re-granted, or the primary would silently
        // lack the UGC moderation bit.
        assert!(!has_full_control(16_777_215));
        assert!(!has_full_control(0));
        assert!(!has_full_control(PERM_ALL - 1));
        // Extra bits beyond PermAll would still be full control.
        assert!(has_full_control(PERM_ALL | 1 << 40));
    }

    #[test]
    fn defaults_are_on_and_paced() {
        let c = DelegationConfig::default();
        assert!(c.enabled, "the grant must exist before it is needed");
        assert!(!c.dry_run);
        assert!(
            c.max_grants_per_scan > 0,
            "a zero budget would back-fill nothing forever"
        );
        assert!(
            c.max_grants_per_scan <= 200,
            "a big roster must not queue thousands of txs in one burst"
        );
    }
}
