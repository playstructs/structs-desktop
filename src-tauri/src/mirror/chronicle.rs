//! Chronicle: a planet's history, told from the chain itself.
//!
//! The planet is read at evenly spaced past heights with height-pinned reads
//! (`x-cosmos-block-height`) — the chain's own state at each moment, no guild
//! service involved — and every change between two samples becomes a line:
//! ore leaving the ground, a raider arriving, a raid clock starting or ending,
//! shields rising or falling, rigs switching on or off, a new owner, the
//! planet completing. Resolution is the sample spacing: two changes inside
//! one gap read as one.

use serde::Serialize;
use serde_json::Value;

/// One reading of the planet.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Sample {
    pub height: u64,
    pub owner: String,
    pub status: String,
    pub buried: u64,
    pub mine_clock: u64,
    pub refine_clock: u64,
    pub raid_start: u64,
    pub raider_arrived: u64,
    pub list_start: String,
    pub shield: u64,
    pub mining_active: u64,
    pub refining_active: u64,
}

/// A sample from an LCD planet entity. Pure.
pub fn sample(height: u64, e: &Value) -> Sample {
    let p = e.get("Planet").unwrap_or(&Value::Null);
    let a = e.get("planetAttributes");
    let n = |k: &str| crate::mcp::types::numeric_u64(a.and_then(|a| a.get(k))).unwrap_or(0);
    let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    Sample {
        height,
        owner: s("owner"),
        status: s("status"),
        buried: crate::mcp::types::numeric_u64(e.get("gridAttributes").and_then(|g| g.get("ore"))).unwrap_or(0),
        mine_clock: n("blockStartOreMine"),
        refine_clock: n("blockStartOreRefine"),
        raid_start: n("blockStartRaid"),
        raider_arrived: n("blockRaiderArrived"),
        list_start: s("locationListStart"),
        shield: n("planetaryShield"),
        mining_active: n("oreMiningActiveQuantity"),
        refining_active: n("oreRefiningActiveQuantity"),
    }
}

/// What changed between two samples, as chronicle lines. Pure.
pub fn changes(a: &Sample, b: &Sample) -> Vec<String> {
    let mut out = Vec::new();
    let when = format!("{}–{}", a.height, b.height);
    if a.owner != b.owner {
        out.push(format!("{when}: owner {} → {}", if a.owner.is_empty() { "none" } else { &a.owner }, if b.owner.is_empty() { "none" } else { &b.owner }));
    }
    if b.buried < a.buried {
        let n = a.buried - b.buried;
        out.push(format!("{when}: {n} ore mined out of the ground ({} → {} buried)", a.buried, b.buried));
    }
    if b.mine_clock != a.mine_clock && b.mine_clock > a.mine_clock && b.buried == a.buried && b.raid_start == 0 && a.raid_start == 0 {
        out.push(format!("{when}: mine clock restarted at {} with no ore leaving — a rig came online", b.mine_clock));
    }
    if b.refine_clock > a.refine_clock {
        // The first refinery coming online also restarts the clock
        // (`OreRefiningActivate`): that is not a refine.
        if a.refining_active == 0 && b.refining_active > 0 {
            out.push(format!("{when}: a refinery came online (refine clock started at {})", b.refine_clock));
        } else {
            out.push(format!("{when}: ore refined (refine clock restarted at {})", b.refine_clock));
        }
    }
    if a.list_start.is_empty() && !b.list_start.is_empty() {
        out.push(format!("{when}: fleet {} arrived — a raid began (raider arrived at {})", b.list_start, b.raider_arrived));
    } else if !a.list_start.is_empty() && b.list_start.is_empty() {
        out.push(format!("{when}: the last visitor ({}) left — the raid ended", a.list_start));
    } else if !a.list_start.is_empty() && a.list_start != b.list_start {
        out.push(format!("{when}: {} now leads the visitors (was {})", b.list_start, a.list_start));
    }
    if a.raid_start == 0 && b.raid_start != 0 {
        out.push(format!("{when}: shields went down — the raid clock started at {}", b.raid_start));
    } else if a.raid_start != 0 && b.raid_start == 0 && !b.list_start.is_empty() {
        out.push(format!("{when}: the defender came back — the raid clock stopped"));
    }
    if b.shield != a.shield {
        out.push(format!("{when}: planetary shield {} → {}", a.shield, b.shield));
    }
    if b.mining_active != a.mining_active {
        out.push(format!("{when}: mining rigs online {} → {}", a.mining_active, b.mining_active));
    }
    if b.refining_active != a.refining_active {
        out.push(format!("{when}: refineries online {} → {}", a.refining_active, b.refining_active));
    }
    if a.status != b.status && b.status == "complete" {
        out.push(format!("{when}: the planet was completed"));
    }
    out
}

/// The whole chronicle from a run of samples, oldest first. Pure.
pub fn tell(samples: &[Sample]) -> Vec<String> {
    samples.windows(2).flat_map(|w| changes(&w[0], &w[1])).collect()
}

/// Read `planet` at `samples` evenly spaced heights over the last
/// `span_blocks` and tell what changed. Read-only.
pub async fn chronicle(client: &crate::mcp::cosmos_client::CosmosClient, planet: &str, span_blocks: u64, samples: u64) -> Result<(Vec<Sample>, Vec<String>), String> {
    let latest = crate::mcp::perception::latest_block_height(&client.lcd_get("/cosmos/base/tendermint/v1beta1/blocks/latest").await?)
        .ok_or("no latest height")?;
    let to = latest.saturating_sub(1);
    let n = samples.clamp(2, 96);
    let step = (span_blocks / (n - 1)).max(1);
    let mut out = Vec::new();
    for i in 0..n {
        let h = to.saturating_sub(step * (n - 1 - i));
        match client.lcd_get_bulk_at(&format!("/structs/planet/{planet}"), Some(h)).await {
            Ok((v, _, _)) => out.push(sample(h, &v)),
            Err(_) if out.is_empty() => continue, // the planet may not exist yet that far back
            Err(e) => return Err(format!("read at {h}: {e}")),
        }
    }
    if out.is_empty() {
        return Err(format!("planet {planet} could not be read over that span"));
    }
    let lines = tell(&out);
    Ok((out, lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(h: u64) -> Sample {
        Sample { height: h, owner: "1-1".into(), status: "active".into(), buried: 3, mine_clock: 100, refine_clock: 100, mining_active: 1, refining_active: 1, ..Default::default() }
    }

    #[test]
    fn mining_and_refining_are_told() {
        let a = s(1_000);
        let b = Sample { buried: 2, mine_clock: 1_200, refine_clock: 1_300, ..s(2_000) };
        let lines = changes(&a, &b);
        assert!(lines.iter().any(|l| l.contains("1 ore mined")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("ore refined")), "{lines:?}");
        assert!(!lines.iter().any(|l| l.contains("rig came online")), "a mine explains the clock");
    }

    #[test]
    fn a_raid_is_told_from_arrival_to_its_end() {
        let quiet = s(1_000);
        let arrived = Sample { list_start: "9-7".into(), raider_arrived: 1_100, ..s(2_000) };
        let down = Sample { raid_start: 2_500, ..arrived.clone() };
        let left = Sample { height: 4_000, ..s(4_000) };
        let lines = tell(&[quiet, arrived, Sample { height: 3_000, ..down }, left]);
        assert!(lines[0].contains("fleet 9-7 arrived"), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("shields went down")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("raid ended")), "{lines:?}");
    }

    #[test]
    fn owner_shield_rigs_and_completion_are_told() {
        let a = s(1);
        let b = Sample { owner: "1-2".into(), shield: 25, mining_active: 0, status: "complete".into(), ..s(2) };
        let lines = changes(&a, &b);
        for want in ["owner 1-1 → 1-2", "planetary shield 0 → 25", "mining rigs online 1 → 0", "completed"] {
            assert!(lines.iter().any(|l| l.contains(want)), "missing {want}: {lines:?}");
        }
    }

    #[test]
    fn a_quiet_planet_has_no_story() {
        assert!(tell(&[s(1), s(2), s(3)]).is_empty());
    }

    #[test]
    fn samples_read_the_lcd_planet_shape() {
        let e = serde_json::json!({"Planet": {"owner": "1-9", "status": "active", "locationListStart": "9-4"},
            "gridAttributes": {"ore": "4"},
            "planetAttributes": {"blockStartOreMine": "77", "planetaryShield": "212", "oreMiningActiveQuantity": "1"}});
        let x = sample(5, &e);
        assert_eq!((x.owner.as_str(), x.buried, x.mine_clock, x.shield, x.list_start.as_str(), x.mining_active), ("1-9", 4, 77, 212, "9-4", 1));
    }

    #[test]
    fn a_refinery_coming_online_is_not_a_refine() {
        let a = Sample { refining_active: 0, ..s(1) };
        let b = Sample { refining_active: 1, refine_clock: 500, ..s(2) };
        let lines = changes(&a, &b);
        assert!(lines.iter().any(|l| l.contains("refinery came online")), "{lines:?}");
        assert!(!lines.iter().any(|l| l.contains("ore refined")), "{lines:?}");
    }

    /// `MIRROR_PLANET=2-29890 cargo test mirror::chronicle::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live() {
        let planet = std::env::var("MIRROR_PLANET").unwrap();
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (s, lines) = rt.block_on(chronicle(&client, &planet, 60_000, 30)).unwrap();
        println!("{} readings {}–{}", s.len(), s[0].height, s[s.len() - 1].height);
        for l in lines {
            println!("  {l}");
        }
    }
}
