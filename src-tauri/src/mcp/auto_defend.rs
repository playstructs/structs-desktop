//! Native auto-defense loop — assigns each productive vplayer's idle combat structs
//! to DEFEND its key structs via `MsgStructDefenseSet`, so newly-built defenders
//! actually intercept raids instead of sitting unassigned. Priority: the Command
//! Ship first (it is the planetary-shield gate — if it dies the raid clock arms —
//! and its 2/2 counter is the best attacker-killer), then the Ore Refinery and Ore
//! Extractor, spreading defenders across targets instead of piling on one. A
//! same-ambit defender is preferred (only same-ambit defenders can BLOCK; cross-ambit
//! ones only counter). One assignment per player per scan (defend costs 1 charge).
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
                let find_type = |t: &str| -> Option<(String, String)> {
                    structs
                        .iter()
                        .filter(|s| !truthy(s.get("is_destroyed")))
                        .find(|s| type_id_of(s) == t)
                        .and_then(|s| {
                            s.get("id").and_then(|x| x.as_str()).map(|id| {
                                let ambit = s
                                    .get("operating_ambit")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                (id.to_string(), ambit)
                            })
                        })
                };
                // (type, id, ambit), priority-ordered.
                let protected: Vec<(&str, String, String)> = [COMMAND_SHIP_TYPE, REFINERY_TYPE, EXTRACTOR_TYPE]
                    .iter()
                    .filter_map(|t| find_type(t).map(|(id, ambit)| (*t, id, ambit)))
                    .collect();
                if protected.is_empty() {
                    return;
                }

                // Pass 1: classify every combat struct — count existing assignments
                // per protected target, collect idle (built, unassigned) candidates.
                let mut counts: HashMap<String, usize> = HashMap::new();
                let mut idle: Vec<(String, String)> = Vec::new(); // (id, ambit)
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
                    let ambit = s
                        .get("operating_ambit")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    idle.push((sid, ambit));
                }
                if idle.is_empty() {
                    return;
                }

                // Pick the target: the Command Ship until it has CMD_MIN_DEFENDERS,
                // then whichever protected struct has the fewest defenders
                // (ties break toward the higher-priority target).
                let (target_id, target_ambit) = {
                    let cmd = protected.iter().find(|(t, _, _)| *t == COMMAND_SHIP_TYPE);
                    match cmd {
                        Some((_, id, ambit)) if counts.get(id).copied().unwrap_or(0) < CMD_MIN_DEFENDERS => {
                            (id.clone(), ambit.clone())
                        }
                        _ => protected
                            .iter()
                            .min_by_key(|(_, id, _)| counts.get(id).copied().unwrap_or(0))
                            .map(|(_, id, ambit)| (id.clone(), ambit.clone()))
                            .unwrap(),
                    }
                };
                // Prefer a same-ambit defender (only same-ambit defenders can block).
                let (sid, _) = idle
                    .iter()
                    .find(|(_, a)| !target_ambit.is_empty() && *a == target_ambit)
                    .or_else(|| idle.first())
                    .cloned()
                    .unwrap();

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

    #[test]
    fn default_off_productive_only() {
        let c = AutoDefendConfig::default();
        assert!(!c.enabled);
        assert!(!c.include_bait);
        assert_eq!(c.interval_secs, 180);
    }

    #[test]
    fn production_types_are_not_defenders() {
        assert!(PROTECTED_TYPES.contains(&REFINERY_TYPE));
        assert!(PROTECTED_TYPES.contains(&EXTRACTOR_TYPE));
        assert!(PROTECTED_TYPES.contains(&"1")); // command ship
    }
}
