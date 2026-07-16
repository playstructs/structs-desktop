//! Role-themed profile pictures for team players — now player-configurable.
//!
//! A Structs player's on-chain `pfpClientRenderAttributes` is a 5-layer
//! portrait (background, arms, body, neck, head — painted back to front). Each
//! ROLE (productive, bait) has an appearance config: for every layer, either a
//! FIXED index (a pinned squad look) or RANDOMIZE (a unique per-player value
//! derived from the HD index). Players edit these in Team Ops · Config; the
//! defaults reproduce the original scheme so nothing changes until they touch
//! it.
//!
//!   * default productive → blue background (6) + blue-trim body (25); face random
//!   * default bait       → red background  (2) + light suit body  (10); face random
//!
//! The PRIMARY is intentionally NOT managed here — the operator owns their own
//! flagship portrait (set in-game). This module only computes what we WRITE for
//! virtual players; the board renders whatever is actually on-chain.

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, RwLock};

/// Part inventory sizes — must match `frontend/img/pfp/<part>/` file counts and
/// the webapp's `PFP_PART_COUNTS`.
pub const HEAD: u32 = 87;
pub const NECK: u32 = 10;
pub const BODY: u32 = 57;
pub const ARMS: u32 = 34;
pub const BACKGROUND: u32 = 6;

const CONFIG_FILE: &str = "role_pfp.json";

/// One role's appearance. Each layer is `Some(index)` (fixed) or `None`
/// (randomize per player). Serializes to clean JSON the UI reads/writes:
/// `{ "background": 2, "body": 10, "head": null, "neck": null, "arms": null }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolePfp {
    pub background: Option<u32>,
    pub body: Option<u32>,
    pub head: Option<u32>,
    pub neck: Option<u32>,
    pub arms: Option<u32>,
}

/// Persisted config for the roles the tooling manages. Primary is excluded by
/// design (operator-owned).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PfpConfig {
    pub productive: RolePfp,
    pub bait: RolePfp,
}

impl Default for PfpConfig {
    fn default() -> Self {
        PfpConfig {
            // bg + body fixed (the role signal); face randomized.
            productive: RolePfp { background: Some(6), body: Some(25), head: None, neck: None, arms: None },
            bait: RolePfp { background: Some(2), body: Some(10), head: None, neck: None, arms: None },
        }
    }
}

static CONFIG: LazyLock<RwLock<PfpConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config::<PfpConfig>(CONFIG_FILE)));

/// FNV-1a (32-bit) over the ASCII bytes of `key`. Small, dependency-free, and
/// stable across builds/platforms so a randomized face never shifts.
fn fnv1a(key: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for b in key.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h
}

/// Resolve one layer to a valid 1..=count index: a fixed choice (clamped into
/// range) or a deterministic per-player value.
fn layer(choice: Option<u32>, index: u32, part: &str, count: u32) -> u32 {
    match choice {
        Some(i) => i.clamp(1, count),
        None => (fnv1a(&format!("{}:{}", index, part)) % count) + 1,
    }
}

/// Compose a role config + HD index into the on-chain attrs JSON string. Pure —
/// key order/spacing match the chain's stored value so a recomputed string
/// compares equal (idempotent self-heal).
fn compose(cfg: &RolePfp, index: u32) -> String {
    format!(
        "{{\"head\":{},\"neck\":{},\"body\":{},\"arms\":{},\"background\":{}}}",
        layer(cfg.head, index, "head", HEAD),
        layer(cfg.neck, index, "neck", NECK),
        layer(cfg.body, index, "body", BODY),
        layer(cfg.arms, index, "arms", ARMS),
        layer(cfg.background, index, "background", BACKGROUND),
    )
}

/// Built-in fallback for any role not in the managed config (i.e. "primary" —
/// never actually written, but keeps this total).
fn fallback_role() -> RolePfp {
    RolePfp { background: Some(1), body: Some(48), head: None, neck: None, arms: None }
}

/// The on-chain `pfpClientRenderAttributes` JSON for a team player, honoring the
/// current per-role config. `index` is the HD index.
pub fn role_pfp_attrs(role: &str, index: u32) -> String {
    let cfg = CONFIG.read().unwrap_or_else(|e| e.into_inner());
    let role_cfg = match role {
        "productive" => cfg.productive.clone(),
        "bait" => cfg.bait.clone(),
        _ => fallback_role(),
    };
    compose(&role_cfg, index)
}

/// Current config as JSON for the UI (Options serialize to null).
pub fn config_json() -> serde_json::Value {
    let cfg = CONFIG.read().unwrap_or_else(|e| e.into_inner());
    serde_json::to_value(&*cfg).unwrap_or_else(|_| serde_json::json!({}))
}

/// Layer inventory sizes for the picker.
pub fn part_counts_json() -> serde_json::Value {
    serde_json::json!({
        "head": HEAD, "neck": NECK, "body": BODY, "arms": ARMS, "background": BACKGROUND,
    })
}

/// Update one managed role's appearance (validated + clamped) and persist.
/// Unknown roles (including "primary") are rejected. Returns the stored config.
pub fn set_role(role: &str, mut role_cfg: RolePfp) -> Result<RolePfp, String> {
    let clamp = |v: Option<u32>, count: u32| v.map(|i| i.clamp(1, count));
    role_cfg.head = clamp(role_cfg.head, HEAD);
    role_cfg.neck = clamp(role_cfg.neck, NECK);
    role_cfg.body = clamp(role_cfg.body, BODY);
    role_cfg.arms = clamp(role_cfg.arms, ARMS);
    role_cfg.background = clamp(role_cfg.background, BACKGROUND);
    {
        let mut cfg = CONFIG.write().unwrap_or_else(|e| e.into_inner());
        match role {
            "productive" => cfg.productive = role_cfg.clone(),
            "bait" => cfg.bait = role_cfg.clone(),
            other => return Err(format!("role '{}' is not configurable here", other)),
        }
        crate::mcp::config_store::save_config(CONFIG_FILE, &*cfg);
    }
    Ok(role_cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_role(role: &str) -> RolePfp {
        match role {
            "productive" => PfpConfig::default().productive,
            "bait" => PfpConfig::default().bait,
            _ => fallback_role(),
        }
    }

    #[test]
    fn worker17_matches_the_value_written_on_chain() {
        // Default productive config must reproduce the original on-chain write
        // (worker17, HD index 17). Hermetic: uses the default, not global state.
        assert_eq!(
            compose(&default_role("productive"), 17),
            r#"{"head":69,"neck":1,"body":25,"arms":23,"background":6}"#
        );
    }

    #[test]
    fn fixed_layers_pin_and_random_layers_vary() {
        let a = compose(&default_role("bait"), 1);
        let b = compose(&default_role("bait"), 2);
        assert_ne!(a, b); // faces vary
        assert!(a.contains("\"body\":10") && a.contains("\"background\":2"));
        assert!(b.contains("\"body\":10") && b.contains("\"background\":2"));
    }

    #[test]
    fn all_fixed_makes_a_uniform_role() {
        // A role with every layer pinned → identical avatar for every player.
        let uni = RolePfp { background: Some(3), body: Some(7), head: Some(5), neck: Some(2), arms: Some(9) };
        assert_eq!(compose(&uni, 1), compose(&uni, 999));
        assert_eq!(compose(&uni, 1), r#"{"head":5,"neck":2,"body":7,"arms":9,"background":3}"#);
    }

    #[test]
    fn fixed_indices_clamp_into_range() {
        let bad = RolePfp { background: Some(99), body: Some(0), head: Some(1000), neck: None, arms: None };
        let s = compose(&bad, 3);
        assert!(s.contains("\"background\":6")); // 99 → 6
        assert!(s.contains("\"body\":1")); // 0 → 1
        assert!(s.contains("\"head\":87")); // 1000 → 87
    }

    #[test]
    fn parts_stay_in_range_for_defaults() {
        for idx in 0..300u32 {
            for role in ["productive", "bait"] {
                let s = compose(&default_role(role), idx);
                let get = |k: &str, max: u32| {
                    let v: u32 = s.split(&format!("\"{}\":", k)).nth(1).unwrap()
                        .split(|c| c == ',' || c == '}').next().unwrap().parse().unwrap();
                    assert!(v >= 1 && v <= max, "{}={} out of 1..={}", k, v, max);
                };
                get("head", HEAD);
                get("neck", NECK);
                get("body", BODY);
                get("arms", ARMS);
                get("background", BACKGROUND);
            }
        }
    }
}
