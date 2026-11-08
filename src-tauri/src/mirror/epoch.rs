//! Rules epoch: is the chain running the rules this mirror was built from?
//!
//! The mirror's rules are ported from one structsd release ([`super::rules::RULES`]).
//! A chain upgrade can change any of them. So the app asks the node what it
//! runs (`/cosmos/base/tendermint/v1beta1/node_info`) and whether an upgrade
//! is scheduled (`/cosmos/upgrade/v1beta1/current_plan`), every few minutes.
//! When the versions differ — or an upgrade is within [`UPGRADE_MARGIN`]
//! blocks — the mirror stands down where being wrong costs something:
//!
//! * the pre-sign gate refuses nothing (it still records what it thinks; the
//!   chain decides every transaction);
//! * the need-gated loops do not sleep on forecast due heights.
//!
//! Forecasts and previews keep working, labelled with the mismatch.

use std::sync::{LazyLock, RwLock};

use serde::Serialize;

/// Blocks before a scheduled upgrade at which the mirror stands down.
pub const UPGRADE_MARGIN: u64 = 50;
const REFRESH_MS: f64 = 10.0 * 60_000.0;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Epoch {
    /// The release the mirror's rules come from, e.g. "0.22.0".
    pub mirror: String,
    /// What the node reports; `None` until read.
    pub chain: Option<String>,
    /// A scheduled upgrade: its name and height.
    pub upgrade: Option<(String, u64)>,
    pub checked_ms: f64,
    pub error: Option<String>,
}

/// The mirror's own release, from `RULES` ("structsd v0.22.0" → "0.22.0").
pub fn mirror_version() -> String {
    super::rules::RULES.trim_start_matches("structsd").trim().trim_start_matches('v').to_string()
}

fn norm(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

/// May the mirror act on its rules at `tip`? `Err` = why not. Pure. An epoch
/// never read counts as matching: the mirror was built against the live
/// chain, and a failed read must not disable it — only a known mismatch does.
pub fn trusted_at(e: &Epoch, tip: u64) -> Result<(), String> {
    if let Some(chain) = &e.chain {
        if norm(chain) != norm(&e.mirror) {
            return Err(format!("the chain runs structsd {chain}; the mirror's rules are from {}", e.mirror));
        }
    }
    if let Some((name, h)) = &e.upgrade {
        if tip + UPGRADE_MARGIN >= *h {
            return Err(format!("upgrade '{name}' is scheduled at {h} (tip {tip})"));
        }
    }
    Ok(())
}

static EPOCH: LazyLock<RwLock<Epoch>> = LazyLock::new(|| RwLock::new(Epoch { mirror: mirror_version(), ..Epoch::default() }));

#[cfg(test)]
pub fn set_for_test(e: Epoch) {
    *EPOCH.write().unwrap() = e;
}

pub fn current() -> Epoch {
    EPOCH.read().map(|e| e.clone()).unwrap_or_default()
}

/// Whether the mirror's rules hold right now.
pub fn trusted() -> Result<(), String> {
    let tip = crate::game_state::GAME_STATE.read().map(|g| g.current_block_height).unwrap_or(0);
    trusted_at(&current(), tip)
}

/// Parse `node_info` → version.
pub fn parse_version(v: &serde_json::Value) -> Option<String> {
    v.get("application_version")?.get("version")?.as_str().map(String::from)
}

/// Parse `current_plan` → (name, height); `None` when no plan.
pub fn parse_plan(v: &serde_json::Value) -> Option<(String, u64)> {
    let p = v.get("plan")?;
    if p.is_null() {
        return None;
    }
    Some((p.get("name")?.as_str()?.to_string(), crate::mcp::types::numeric_u64(p.get("height"))?))
}

/// Re-read the node's version and plan (throttled; call freely).
pub async fn refresh(client: &crate::mcp::cosmos_client::CosmosClient) {
    let now = crate::hasher::types::now_millis();
    if now - current().checked_ms < REFRESH_MS {
        return;
    }
    if let Ok(mut e) = EPOCH.write() {
        e.checked_ms = now; // claim the slot so concurrent syncs do not all read
    }
    let info = client.lcd_get("/cosmos/base/tendermint/v1beta1/node_info").await;
    let plan = client.lcd_get("/cosmos/upgrade/v1beta1/current_plan").await;
    let before = current();
    let mut e = before.clone();
    match &info {
        Ok(v) => {
            e.chain = parse_version(v);
            e.error = None;
        }
        Err(err) => e.error = Some(format!("node_info: {err}")),
    }
    if let Ok(v) = &plan {
        e.upgrade = parse_plan(v);
    }
    if e.chain != before.chain || e.upgrade != before.upgrade {
        let sev = if trusted_at(&e, 0).is_ok() { crate::mcp::telemetry::Sev::Info } else { crate::mcp::telemetry::Sev::Warn };
        crate::mcp::telemetry::tlog(
            "mirror",
            sev,
            format!("rules epoch: chain {:?}, upgrade {:?}, mirror {}", e.chain, e.upgrade, e.mirror),
        );
    }
    if let Ok(mut w) = EPOCH.write() {
        *w = e;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn e(chain: Option<&str>, upgrade: Option<(&str, u64)>) -> Epoch {
        Epoch { mirror: "0.22.0".into(), chain: chain.map(String::from), upgrade: upgrade.map(|(n, h)| (n.into(), h)), ..Default::default() }
    }

    #[test]
    fn the_mirror_names_its_own_release() {
        assert_eq!(mirror_version(), "0.22.0");
    }

    #[test]
    fn matching_versions_are_trusted_with_or_without_a_v() {
        assert!(trusted_at(&e(Some("0.22.0"), None), 1).is_ok());
        assert!(trusted_at(&e(Some("v0.22.0"), None), 1).is_ok());
        assert!(trusted_at(&e(None, None), 1).is_ok(), "never read is not a mismatch");
    }

    #[test]
    fn another_release_stands_the_mirror_down() {
        assert!(trusted_at(&e(Some("0.23.0"), None), 1).is_err());
        assert!(trusted_at(&e(Some("0.22.1"), None), 1).is_err(), "a patch release can change a rule too");
    }

    #[test]
    fn a_scheduled_upgrade_stands_it_down_from_the_margin() {
        let x = e(Some("0.22.0"), Some(("v0.23.0", 1_000)));
        assert!(trusted_at(&x, 900).is_ok());
        assert!(trusted_at(&x, 950).is_err());
        assert!(trusted_at(&x, 2_000).is_err(), "and after it until the version is read again");
    }

    #[test]
    fn parses_the_nodes_answers() {
        assert_eq!(parse_version(&json!({"application_version": {"version": "0.22.0"}})), Some("0.22.0".into()));
        assert_eq!(parse_plan(&json!({"plan": null})), None);
        assert_eq!(parse_plan(&json!({"plan": {"name": "v0.23.0", "height": "3600000"}})), Some(("v0.23.0".into(), 3_600_000)));
    }
}
