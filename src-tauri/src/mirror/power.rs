//! Exact power headroom: the chain's own answer for usable primary capacity.
//!
//! `getPowerHeadroom` (keeper/player_cache.go) decides whether a player is
//! online. Its primary term, usable primary capacity, is derived from the
//! owner's infusion inventory, live staking and reactor diversity
//! (player_primary_supply.go) — state the snapshot does not hold and that
//! would drift if re-derived here. The chain exposes the same computation:
//! `/structs/owner/{id}/reactor-diversity` answers `usablePrimaryCapacity`
//! from `getUsableOwnerCapacityProofWithPortfolio`, the function the
//! readiness check calls. So the mirror reads it, at a known height, for the
//! owners it is asked about, rather than porting staking math.

use std::collections::HashMap;

use futures_util::stream::{self, StreamExt};
use serde_json::Value;

use crate::mcp::cosmos_client::CosmosClient;

/// Reads in flight at once: a team forecast is tens of owners, not thousands.
const CONCURRENCY: usize = 8;
/// Above this many owners the forecast stays on the capacity bound: a
/// whole-galaxy run would be one request per player.
pub const MAX_OWNERS: usize = 200;

/// Usable primary capacity for one owner, as the chain computed it.
#[derive(Clone, Debug, PartialEq)]
pub struct Usable {
    pub capacity: u64,
    /// The height the LCD answered at.
    pub height: u64,
    /// `infusionInventoryComplete`: false means the chain's bounded inventory
    /// read gave up, and the chain then counts the capacity as 0 — which is
    /// what `capacity` already says. Reported, not reinterpreted.
    pub inventory_complete: bool,
}

/// The chain's power inputs the snapshot lacks, for a set of owners.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub usable: HashMap<String, Usable>,
    /// Substation id → whether it exists on-chain (`CheckSubstation`).
    /// Absent = could not be determined.
    pub substation_exists: HashMap<String, bool>,
    pub failures: Vec<String>,
}

/// One `QueryOwnerReactorDiversityResponse`, numbers as strings.
pub fn parse_usable(v: &Value, height: u64) -> Option<Usable> {
    Some(Usable {
        capacity: crate::mcp::types::numeric_u64(v.get("usablePrimaryCapacity"))?,
        height,
        inventory_complete: v.get("infusionInventoryComplete").and_then(|b| b.as_bool()).unwrap_or(false),
    })
}

/// The chain answers a missing object with gRPC code 2 /
/// "codespace structs code 1050: object not found" (HTTP 500).
pub fn is_not_found(err: &str) -> bool {
    err.contains("object not found") || err.contains("code 1050")
}

/// Read usable primary capacity for `owners` and existence for
/// `substations`. Failures leave the owner or substation absent (unknown).
pub async fn fetch(client: &CosmosClient, owners: &[String], substations: &[String]) -> Inputs {
    let mut out = Inputs::default();
    let usable: Vec<(String, Result<Usable, String>)> = stream::iter(owners.iter().cloned())
        .map(|owner| async move {
            let path = format!("/structs/owner/{owner}/reactor-diversity");
            let r = match client.lcd_get_bulk(&path).await {
                Ok((v, height, _)) => parse_usable(&v, height).ok_or_else(|| "no usablePrimaryCapacity in the answer".to_string()),
                Err(e) => Err(e),
            };
            (owner, r)
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    for (owner, r) in usable {
        match r {
            Ok(u) => {
                out.usable.insert(owner, u);
            }
            Err(e) => out.failures.push(format!("{owner}: {}", e.chars().take(120).collect::<String>())),
        }
    }
    let subs: Vec<(String, Result<bool, String>)> = stream::iter(substations.iter().cloned())
        .map(|id| async move {
            let r = match client.query_entity("substation", &id).await {
                Ok(_) => Ok(true),
                Err(e) if is_not_found(&e) => Ok(false),
                Err(e) => Err(e),
            };
            (id, r)
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    for (id, r) in subs {
        match r {
            Ok(b) => {
                out.substation_exists.insert(id, b);
            }
            Err(e) => out.failures.push(format!("{id}: {}", e.chars().take(120).collect::<String>())),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_live_answer_shape() {
        // Recorded from structstestnet at 3,484,543 for 1-194.
        let v = json!({"stored":{"ownerId":"1-194","appliedBonus":"128726655"},"usablePrimaryCapacity":"166940967950","infusionInventoryComplete":true,"storedCapacity":"166940967950"});
        assert_eq!(parse_usable(&v, 3_484_543), Some(Usable { capacity: 166_940_967_950, height: 3_484_543, inventory_complete: true }));
    }

    #[test]
    fn a_missing_field_is_no_answer_not_zero() {
        assert_eq!(parse_usable(&json!({"storedCapacity":"5"}), 1), None);
    }

    #[test]
    fn recognises_the_chains_not_found() {
        assert!(is_not_found(r#"API returned 500 Internal Server Error: {"code":2, "message":"codespace structs code 1050: object not found"}"#));
        assert!(!is_not_found("API returned 503: upstream unavailable"));
    }
}
