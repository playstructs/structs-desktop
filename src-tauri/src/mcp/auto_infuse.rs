//! Configurable "keep N grams, infuse the rest" rule for the PRIMARY player.
//! Grows the primary's own capacity (reactor infusion is 96% to the infuser,
//! undiluted) while always retaining a reserve of liquid Alpha. This is the last
//! unwired step of the flywheel — productive vplayers funnel alpha to the primary,
//! and this infuses the excess.
//!
//! Mechanism: reactor infuse is NOT on the primary tx bridge, so we sign
//! `MsgReactorInfuse` through the vplayer façade at **HD index 0** — which derives
//! the primary's own key off the shared mnemonic (m/44'/118'/0'/0/0). Keys stay
//! JS-side as always.
//!
//! Off by default (it stakes real Alpha — reversible only via defuse + cooldown).
//! `structs_players infuse {args:{keep_grams, enabled, now}}` configures/runs it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::hasher::types::now_millis;
use crate::mcp::cosmos_client::CosmosClient;

const FILENAME: &str = "auto_infuse.json";
/// 1 gram of Alpha = 1,000,000 ualpha = 1 kW of capacity (ReactorFuelToEnergyConversion = 1).
pub const UALPHA_PER_GRAM: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoInfuseConfig {
    /// Auto-run the rule each scan (off by default — it stakes real Alpha).
    pub enabled: bool,
    /// Always keep at least this many grams of liquid Alpha; infuse the rest.
    pub keep_grams: u64,
    /// Min seconds between auto-runs.
    pub interval_secs: u64,
}

impl Default for AutoInfuseConfig {
    fn default() -> Self {
        Self { enabled: false, keep_grams: 10, interval_secs: 600 }
    }
}

static CONFIG: LazyLock<RwLock<AutoInfuseConfig>> = LazyLock::new(|| RwLock::new(load()));
static LAST_RUN: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static RUNNING: AtomicBool = AtomicBool::new(false);

fn load() -> AutoInfuseConfig {
    crate::mcp::config_store::load_config(FILENAME)
}
pub fn get() -> AutoInfuseConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}
pub fn set(cfg: AutoInfuseConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

/// Outcome of an infuse attempt, for reporting.
pub struct InfuseResult {
    pub infused_ualpha: u64,
    pub kept_ualpha: u64,
    pub tx: String,
}

/// Infuse the primary's Alpha above the `keep_grams` reserve into the guild reactor.
/// Signs `MsgReactorInfuse` as the primary via the façade at HD index 0.
pub async fn infuse_primary_excess(
    app_handle: &tauri::AppHandle,
    keep_grams: u64,
) -> Result<InfuseResult, String> {
    let (primary_addr, primary_pid, guild_id) = {
        let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
        (
            gs.wallet_address.clone().unwrap_or_default(),
            gs.player_id.clone().unwrap_or_default(),
            gs.guild_id.clone().unwrap_or_default(),
        )
    };
    if primary_addr.is_empty() || primary_pid.is_empty() {
        return Err("primary identity not synced yet".into());
    }
    if guild_id.is_empty() {
        return Err("guild id not synced yet".into());
    }
    let client = CosmosClient::new();
    let gp = crate::mcp::guild_power::resolve_guild_power(&client, &guild_id).await?;
    if gp.reactor_validator.is_empty() {
        return Err(format!("couldn't resolve reactor {} validator", gp.reactor_id));
    }

    // Current liquid Alpha (ualpha).
    let balance = match client.query_entity("player", &primary_pid).await {
        Ok(v) => crate::mcp::loop_util::parse_f64(v
            .get("playerInventory")
            .and_then(|i| i.get("rocks"))
            .and_then(|r| r.get("amount"))) as u64,
        Err(e) => return Err(format!("couldn't read primary balance: {}", e)),
    };
    let keep = keep_grams.saturating_mul(UALPHA_PER_GRAM);
    let infuse = balance.saturating_sub(keep);
    if infuse == 0 {
        return Err(format!(
            "nothing to infuse: balance {} ualpha ≤ {} g reserve ({} ualpha)",
            balance, keep_grams, keep
        ));
    }

    let payload = json!({
        "delegatorAddress": primary_addr,
        "validatorAddress": gp.reactor_validator,
        "amount": { "denom": "ualpha", "amount": infuse.to_string() },
    });
    // HD index 0 = the primary's own key off the shared mnemonic.
    let res = crate::mcp::vplayer_bridge::sign_action(
        app_handle,
        0,
        "/structs.structs.MsgReactorInfuse",
        payload,
        60,
    )
    .await?;
    let code = res.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Err(format!("infuse tx rejected (code {}): {}", code, res));
    }
    let tx = res
        .get("transactionHash")
        .and_then(|h| h.as_str())
        .unwrap_or("(pending)")
        .to_string();
    Ok(InfuseResult { infused_ualpha: infuse, kept_ualpha: keep, tx })
}

/// Auto-run hook (throttled). Infuses the primary's excess each interval when enabled.
pub async fn tick(app_handle: &tauri::AppHandle, force: bool) {
    let cfg = get();
    if !cfg.enabled {
        return;
    }
    let now = now_millis();
    if !force {
        let mut last = LAST_RUN.lock().unwrap();
        if now - *last < (cfg.interval_secs as f64) * 1000.0 {
            return;
        }
        *last = now;
    } else if let Ok(mut last) = LAST_RUN.lock() {
        *last = now;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    match infuse_primary_excess(app_handle, cfg.keep_grams).await {
        Ok(r) => {
            eprintln!(
                "[Auto-Infuse] infused {} ualpha (kept {} g), tx {}",
                r.infused_ualpha, cfg.keep_grams, r.tx
            );
            crate::mcp::board_feed::push(
                app_handle,
                crate::mcp::board_feed::Severity::Notice,
                "auto_infuse",
                format!(
                    "infused {:.1} g alpha into the reactor (kept {} g)",
                    r.infused_ualpha as f64 / 1_000_000.0,
                    cfg.keep_grams
                ),
            );
        }
        Err(e) => {
            // "nothing to infuse" is normal/quiet; only note real failures.
            if !e.starts_with("nothing to infuse") {
                eprintln!("[Auto-Infuse] {}", e);
            }
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_off_keep_10g() {
        let c = AutoInfuseConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.keep_grams, 10);
    }

    #[test]
    fn reserve_math() {
        // 55 g balance, keep 10 g → infuse 45 g.
        let balance: u64 = 55 * UALPHA_PER_GRAM;
        let keep: u64 = 10 * UALPHA_PER_GRAM;
        assert_eq!(balance.saturating_sub(keep), 45_000_000);
        // balance at/below reserve → nothing.
        assert_eq!((5 * UALPHA_PER_GRAM).saturating_sub(keep), 0);
    }
}
