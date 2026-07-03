//! Native auto-defense loop — assigns each productive vplayer's idle combat structs
//! to DEFEND its highest-value production struct (the Ore Refinery, else the Ore
//! Extractor) via `MsgStructDefenseSet`, so newly-built defenders actually intercept
//! raids instead of sitting unassigned. One assignment per player per scan (defend
//! costs 1 charge). Idempotent: a defender whose on-chain `protectedStructIndex` is
//! already non-zero is cached and never re-queried. Off by default (it auto-signs).
//!
//! This is the "configure defensive relationships as new structs come online" piece:
//! it runs every scan, so a freshly-built OSG/Tank/Starfighter gets a defender
//! assignment on the next pass. Bait players are skipped by default (they're raid
//! fodder — armor makes raids costly, but we don't shield their structs).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_defend.json";
const REFINERY_TYPE: &str = "15";
const EXTRACTOR_TYPE: &str = "14";
/// Production / command types — PROTECTED targets, never used as defenders.
const PROTECTED_TYPES: &[&str] = &["14", "15", "1"]; // extractor, refinery, command ship

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
/// Defender struct ids already assigned (protectedStructIndex != 0) — skip re-querying.
static ASSIGNED_CACHE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

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
    scan(app_handle, &cfg).await;
    RUNNING.store(false, Ordering::SeqCst);
}

async fn scan(app_handle: &tauri::AppHandle, cfg: &AutoDefendConfig) {
    use crate::mcp::virtual_players::VPlayerRole;
    let client = CosmosClient::new();
    let targets = crate::mcp::virtual_players::collect_targets(false);
    let include_bait = cfg.include_bait;
    let app = app_handle.clone();

    crate::mcp::loop_util::for_each_player_concurrent(
        targets,
        crate::mcp::loop_util::MAX_CONCURRENT_PLAYERS,
        move |(pid, idx_opt, role)| {
            let client = client.clone();
            let app = app.clone();
            async move {
                let Some(idx) = idx_opt else { return }; // vplayers only (façade signer)
                // Default: only defend productive workers; bait are deliberate raid fodder.
                if !include_bait && role != Some(VPlayerRole::Productive) {
                    return;
                }
                let structs = match client.guild.struct_list_by_owner(&pid, 1).await {
                    Ok(p) => p.items,
                    Err(_) => return,
                };

                // Protected target = the Refinery (highest value), else the Extractor.
                let find_type = |t: &str| -> Option<String> {
                    structs
                        .iter()
                        .filter(|s| !truthy(s.get("is_destroyed")))
                        .find(|s| type_id_of(s) == t)
                        .and_then(|s| s.get("id").and_then(|x| x.as_str()).map(String::from))
                };
                let Some(protected_id) = find_type(REFINERY_TYPE).or_else(|| find_type(EXTRACTOR_TYPE)) else {
                    return;
                };

                // Assign the first idle (unassigned, built) combat struct to defend it.
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
                    if ASSIGNED_CACHE.lock().unwrap().contains(&sid) {
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
                        ASSIGNED_CACHE.lock().unwrap().insert(sid); // already defending — cache & skip
                        continue;
                    }
                    // Assign it to protect the refinery/extractor.
                    let res = crate::mcp::vplayer_bridge::sign_action(
                        &app,
                        idx,
                        "/structs.structs.MsgStructDefenseSet",
                        json!({ "defenderStructId": sid, "protectedStructId": protected_id }),
                        60,
                    )
                    .await;
                    if let Ok(v) = res {
                        if v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) == 0 {
                            ASSIGNED_CACHE.lock().unwrap().insert(sid.clone());
                            eprintln!("[Auto-Defend] {} defends {} (player {})", sid, protected_id, pid);
                        }
                    }
                    break; // one assignment per player per scan (charge-paced)
                }
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
