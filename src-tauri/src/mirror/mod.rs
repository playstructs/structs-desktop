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
pub mod gate;
pub mod power;
pub mod project;
pub mod report;
pub mod rules;
pub mod transition;
pub mod verify;
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
    /// The pre-sign gate's decisions since launch, by rule.
    pub gate: Vec<(&'static str, u64)>,
    /// Planet runs, when asked for (`Options::project`).
    pub projections: Vec<project::Projection>,
    /// Proven facts behind the forecasts, when asked for (`Options::verify`).
    pub verified: Option<Verified>,
}

/// The facts behind a scoped forecast, proven against a verified header,
/// and every place the snapshot disagrees with them.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Verified {
    pub height: u64,
    pub header_height: u64,
    pub anchor: verify::Anchor,
    pub proven: usize,
    pub failed: usize,
    /// `object attribute: snapshot X, chain Y`.
    pub disagreements: Vec<String>,
}

/// The facts the forecasts for `w` rest on, with the snapshot's values.
fn facts_behind(w: &world::World, forecasts: &[forecast::Forecast]) -> Vec<(verify::Fact, Option<u64>)> {
    use verify::{Fact, Store};
    let mut out: Vec<(Fact, Option<u64>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |f: Fact, v: Option<u64>| {
        if seen.insert(f.clone()) {
            out.push((f, v));
        }
    };
    for p in w.players.values() {
        add(Fact { store: Store::Grid, attribute: "lastAction", object: p.id.clone() }, p.last_action);
        add(Fact { store: Store::Grid, attribute: "ore", object: p.id.clone() }, p.stored_ore);
    }
    for f in forecasts {
        if let Some(s) = w.structs.get(&f.subject) {
            add(Fact { store: Store::Struct, attribute: "status", object: s.id.clone() }, Some(s.status));
        }
        if let Some(p) = f.planet.as_ref().and_then(|p| w.planets.get(p)) {
            match f.kind {
                forecast::Kind::Mine => {
                    add(Fact { store: Store::Planet, attribute: "blockStartOreMine", object: p.id.clone() }, Some(p.mine_start));
                    add(Fact { store: Store::Grid, attribute: "ore", object: p.id.clone() }, p.buried_ore);
                }
                forecast::Kind::Refine => {
                    add(Fact { store: Store::Planet, attribute: "blockStartOreRefine", object: p.id.clone() }, Some(p.refine_start));
                }
                forecast::Kind::Raid => {
                    add(Fact { store: Store::Planet, attribute: "blockStartRaid", object: p.id.clone() }, Some(p.raid_start));
                    add(Fact { store: Store::Planet, attribute: "planetaryShield", object: p.id.clone() }, Some(p.shield));
                }
                _ => {}
            }
        }
    }
    out
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
    let projections = match (opts.project, owners) {
        (true, Some(o)) => project::project_all(&w, tip, o, opts.target),
        _ => Vec::new(),
    };
    let verified = match (opts.verify, owners) {
        (true, Some(o)) if o.len() <= power::MAX_OWNERS => {
            let facts = facts_behind(&w, &forecasts);
            let just: Vec<verify::Fact> = facts.iter().map(|(f, _)| f.clone()).collect();
            match verify::prove_many(&just).await {
                Ok(b) => {
                    let disagreements = facts
                        .iter()
                        .filter_map(|(f, snap)| {
                            let chain = b.get(f.store, f.attribute, &f.object)?;
                            (*snap != Some(chain)).then(|| format!("{} {}: snapshot {}, chain {chain}", f.object, f.attribute, snap.map(|v| v.to_string()).unwrap_or_else(|| "absent".into())))
                        })
                        .collect();
                    Some(Verified { height: b.height, header_height: b.header_height, anchor: b.anchor, proven: b.values.len(), failed: b.failed.len(), disagreements })
                }
                Err(e) => {
                    crate::mcp::telemetry::tlog("mirror", crate::mcp::telemetry::Sev::Notice, format!("forecast verify failed: {e}"));
                    None
                }
            }
        }
        _ => None,
    };
    Some(Now { provenance, tip, earliest_execution: rules::earliest_execution(tip), forecasts, power: power_note, gate: gate::stats(), projections, verified })
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
        let t_world = std::time::Instant::now();
        let mut w = world::World::from_snapshot(&snap, types, "saved", players.as_deref());
        println!("world: {} players, {} structs, {} planets in {:?}", w.players.len(), w.structs.len(), w.planets.len(), t_world.elapsed());
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
        let t_fc = std::time::Instant::now();
        let forecasts = forecast::forecast(&w, tip, &forecast::Options { target, within: None, project: false, verify: false });
        println!("forecast: {} in {:?}", forecasts.len(), t_fc.elapsed());
        let p = crate::mcp::auto_harvest::plan(&forecasts, |_| true);
        println!("harvest plan: {} rigs to start, {} owners mined out ({} explore-ready), next due {:?} (tip {tip}), skipped {:?}", p.picks.values().map(Vec::len).sum::<usize>(), p.mined_out.len(), p.explore_ready, p.next_due, p.skipped);
        let b = crate::mcp::auto_build::build_plan(&forecasts);
        println!("build plan: {} builds to complete across {} owners", b.values().map(Vec::len).sum::<usize>(), b.len());
        println!("crew tasks: {} ready mine/refine tasks", crate::mcp::crew_work::crew_tasks_from(&forecasts).len());
        let now = Now { provenance, tip, earliest_execution: rules::earliest_execution(tip), forecasts, power, gate: Vec::new(), projections: {
            let t_p = std::time::Instant::now();
            let v = project::project_all(&w, tip, players.as_deref().unwrap_or(&[]), target);
            println!("projected {} planet runs in {:?}", v.len(), t_p.elapsed());
            v
        }, verified: None };
        if std::env::var("MIRROR_VERIFY").is_ok() {
            let facts = facts_behind(&w, &now.forecasts);
            let just: Vec<verify::Fact> = facts.iter().map(|(f, _)| f.clone()).collect();
            let rt = tokio::runtime::Runtime::new().unwrap();
            let t_v = std::time::Instant::now();
            let b = rt.block_on(verify::prove_many(&just)).unwrap();
            println!("verified {} of {} facts at {} against header {} ({:?}) in {:?}; {} failed", b.values.len(), just.len(), b.height, b.header_height, b.anchor, t_v.elapsed(), b.failed.len());
            for (f, snap) in &facts {
                if let Some(chain) = b.get(f.store, f.attribute, &f.object) {
                    if *snap != Some(chain) {
                        println!("  drift: {} {}: snapshot {:?}, chain {chain}", f.object, f.attribute, snap);
                    }
                }
            }
            for (k, e) in b.failed.iter().take(3) {
                println!("  failed: {k}: {e}");
            }
        }
        let limit = std::env::var("MIRROR_LIMIT").ok().and_then(|t| t.parse().ok()).unwrap_or(40);
        println!("{}", report::render(&now, limit, None));
    }
}
