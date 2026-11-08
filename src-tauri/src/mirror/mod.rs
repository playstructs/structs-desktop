//! The mirror: the chain's own rules, run locally against a pinned state.
//!
//! Today the app learns what the chain will accept by trying, or by
//! re-deriving a rule ad hoc in each loop (float inverses of a curve the chain
//! computes in integers, charge counted at the tip rather than at execution).
//! The mirror is the one place those rules live:
//!
//! * [`rules`] — exact ports of the chain's time-driven rules, each citing the
//!   structsd source it mirrors and pinned by golden vectors generated FROM
//!   that source (`scripts/mirror_golden.sh`).
//! * [`world`] — the rule inputs copied out of the perception snapshot, with
//!   provenance (height, coherence, source, age); missing fields stay `None`.
//! * [`forecast`] — for every build, mine, refine, raid and charge gate: the
//!   first height the chain will allow it, and each precondition the chain
//!   enforces beside it, as met / blocked / unknown, exact or estimated.
//!
//! Pure: no clock, no network, no locks held. Callers pin the inputs.

pub mod forecast;
pub mod power;
pub mod report;
pub mod rules;
pub mod world;

use crate::mcp::perception;

/// A forecast run against the live snapshot.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Now {
    pub provenance: world::Provenance,
    /// The committed tip the forecast is judged against: the app's chain
    /// clock, or the snapshot's own height if that is newer. Live GRASS
    /// events keep the snapshot's rows current past its bulk `height`.
    pub tip: u64,
    /// The first height a transaction signed now can execute at.
    pub earliest_execution: u64,
    pub forecasts: Vec<forecast::Forecast>,
    /// `None` = power was judged on the capacity bound (no client, or a
    /// whole-galaxy run).
    pub power: Option<PowerNote>,
}

/// Forecast for `owners` (every player in the snapshot when `None`) from the
/// live snapshot and the app's struct-type catalogue. `None` until a
/// snapshot and a chain clock exist.
///
/// With a `client`, scoped runs (≤ [`power::MAX_OWNERS`] owners) also read
/// the chain's usable primary capacity and substation existence, so power
/// checks are exact rather than bounded.
pub async fn forecast_now(
    client: Option<&crate::mcp::cosmos_client::CosmosClient>,
    owners: Option<&[String]>,
    opts: &forecast::Options,
) -> Option<Now> {
    let (types, clock) = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        (world::types_from_game_state(&gs), gs.current_block_height)
    };
    let source = match perception::snapshot_source() {
        perception::SnapshotSource::Guild => "guild",
        perception::SnapshotSource::Lcd => "lcd",
    };
    let mut w = perception::with_snapshot(|s| world::World::from_snapshot(s, types, source, owners))?;
    let mut power_note = None;
    if let Some(client) = client {
        let (who, subs) = w.power_targets();
        if owners.is_some() && who.len() <= power::MAX_OWNERS {
            let inputs = power::fetch(client, &who, &subs).await;
            w.apply_power(&inputs);
            power_note = Some(PowerNote { owners: who.len(), read: inputs.usable.len(), failures: inputs.failures });
        }
    }
    let provenance = w.provenance.clone()?;
    let tip = clock.max(provenance.height);
    if tip == 0 {
        return None;
    }
    let forecasts = forecast::forecast(&w, tip, opts);
    Some(Now { provenance, tip, earliest_execution: rules::earliest_execution(tip), forecasts, power: power_note })
}

/// How many owners' power was read from the chain for this run.
#[derive(Clone, Debug, serde::Serialize)]
pub struct PowerNote {
    pub owners: usize,
    pub read: usize,
    pub failures: Vec<String>,
}

/// Run the mirror against a REAL saved galaxy, outside the app:
///
/// ```text
/// MIRROR_TYPES=types.json MIRROR_TIP=3483081 MIRROR_PLAYERS=1-194 \
///   cargo test mirror::live -- --ignored --nocapture
/// ```
///
/// `MIRROR_SNAPSHOT` defaults to the app's own `perception_snapshot` cache;
/// `MIRROR_TYPES` is an LCD `/structs/struct_type` page; `MIRROR_PLAYERS` is
/// comma-separated (omit for the whole galaxy); `MIRROR_POWER=1` reads the
/// chain's usable capacity for those players. Read-only.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live() {
        let snap: perception::Snapshot = match std::env::var("MIRROR_SNAPSHOT") {
            Ok(p) => serde_json::from_slice(&std::fs::read(p).expect("read snapshot")).expect("parse snapshot"),
            Err(_) => crate::mcp::cache_store::load("perception_snapshot").expect("no saved perception snapshot"),
        };
        let types_page: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("MIRROR_TYPES").expect("set MIRROR_TYPES")).unwrap()).unwrap();
        let types = world::types_from_lcd(&types_page);
        assert!(!types.is_empty(), "no struct types in MIRROR_TYPES");
        let players: Option<Vec<String>> = std::env::var("MIRROR_PLAYERS").ok().map(|p| p.split(',').map(|s| s.trim().to_string()).collect());
        let mut w = world::World::from_snapshot(&snap, types, "saved", players.as_deref());
        // MIRROR_POWER=1: read the chain's usable capacity for the scoped
        // owners from the active guild's LCD (read-only GETs).
        let mut power = None;
        if std::env::var("MIRROR_POWER").is_ok() && players.is_some() {
            let client = crate::mcp::cosmos_client::CosmosClient::new();
            let (who, subs) = w.power_targets();
            let rt = tokio::runtime::Runtime::new().unwrap();
            let inputs = rt.block_on(power::fetch(&client, &who, &subs));
            w.apply_power(&inputs);
            power = Some(PowerNote { owners: who.len(), read: inputs.usable.len(), failures: inputs.failures });
        }
        let provenance = w.provenance.clone().unwrap();
        let tip = std::env::var("MIRROR_TIP").ok().and_then(|t| t.parse().ok()).unwrap_or(provenance.height);
        let target = std::env::var("MIRROR_TARGET").ok().and_then(|t| t.parse().ok()).unwrap_or(4);
        let forecasts = forecast::forecast(&w, tip, &forecast::Options { target, within: None });
        let now = Now { provenance, tip, earliest_execution: rules::earliest_execution(tip), forecasts, power };
        let limit = std::env::var("MIRROR_LIMIT").ok().and_then(|t| t.parse().ok()).unwrap_or(40);
        println!("{}", report::render(&now, limit, None));
    }
}
