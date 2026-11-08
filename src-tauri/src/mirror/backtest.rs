//! Backtest: the mirror's projection against what actually happened.
//!
//! A player's planet is read as the chain held it at a past height H (every
//! read pinned with `x-cosmos-block-height`), the mirror's world is rebuilt
//! from those reads, and the planet run is projected forward from H. Then the
//! same planet is read at the present and the mines that really happened are
//! counted — the buried ore that left the ground.
//!
//! Two things are measured:
//!
//! * **The clock rule.** Every mine restarts the planet's mine clock at its
//!   inclusion height (`OreMinePlanet`). So if ore left the ground the clock
//!   must now read a height after `from` and no later than `to`; if none did
//!   (and no raid paused it) the clock must not have moved. A violation means
//!   the mirror's model of the clock is wrong.
//! * **Calibration.** Mines projected at the configured aim versus mines that
//!   happened. The rules put no ceiling on speed — a higher aim ripens sooner
//!   — so this is not a bound: the gap is hashing, queueing and inclusion
//!   time, plus any pause.

use serde::Serialize;
use serde_json::{json, Value};

use super::project::project;
use super::world::World;
use crate::mcp::perception::{Snapshot, GRID_ATTRS, PLANET_ATTRS, STRUCT_ATTRS};

/// Attribute rows (`{attributeId: "<index>-<object>", value}`) from an
/// entity's attribute map, in the store's own numbering.
fn attr_rows(names: &[&str], object: &str, map: Option<&Value>) -> Vec<Value> {
    let Some(m) = map.and_then(|m| m.as_object()) else { return Vec::new() };
    names
        .iter()
        .enumerate()
        .filter_map(|(i, n)| m.get(*n).map(|v| json!({ "attributeId": format!("{i}-{object}"), "value": v })))
        .collect()
}

/// A snapshot holding exactly the given entity reads (LCD `/structs/<kind>/<id>`
/// answers), pinned at `height`. Pure.
pub fn snapshot_from_entities(height: u64, player: &Value, planet: Option<&Value>, fleet: Option<&Value>, structs: &[Value]) -> Snapshot {
    let pid = player.get("Player").and_then(|p| p.get("id")).and_then(|i| i.as_str()).unwrap_or("");
    let mut grid = attr_rows(&GRID_ATTRS, pid, player.get("gridAttributes"));
    let mut planet_attrs = Vec::new();
    let mut planets = Vec::new();
    if let Some(p) = planet {
        let id = p.get("Planet").and_then(|x| x.get("id")).and_then(|i| i.as_str()).unwrap_or("");
        grid.extend(attr_rows(&GRID_ATTRS, id, p.get("gridAttributes")));
        planet_attrs = attr_rows(&PLANET_ATTRS, id, p.get("planetAttributes"));
        planets.push(p.get("Planet").cloned().unwrap_or(Value::Null));
    }
    let fleets: Vec<Value> = fleet.and_then(|f| f.get("Fleet").cloned()).into_iter().collect();
    let mut struct_rows = Vec::new();
    let mut struct_attrs = Vec::new();
    for e in structs {
        let Some(row) = e.get("Struct") else { continue };
        let id = row.get("id").and_then(|i| i.as_str()).unwrap_or("");
        struct_attrs.extend(attr_rows(&STRUCT_ATTRS, id, e.get("structAttributes")));
        struct_rows.push(row.clone());
    }
    let players = vec![player.get("Player").cloned().unwrap_or(Value::Null)];
    let mut s = Snapshot::from_pages(&struct_rows, &struct_attrs, &planet_attrs, &grid, &players, &planets, &fleets);
    s.height = height;
    s.min_height = height;
    s.pinned = true;
    s.page_heights = true;
    s
}

/// Struct ids in a planet's or fleet's slot arrays, plus a fleet's Command
/// Ship. Pure.
pub fn struct_ids(row: Option<&Value>) -> Vec<String> {
    let Some(r) = row else { return Vec::new() };
    let mut out: Vec<String> = ["land", "water", "air", "space"]
        .iter()
        .filter_map(|a| r.get(*a).and_then(|v| v.as_array()))
        .flatten()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if let Some(c) = r.get("commandStruct").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
        out.push(c.to_string());
    }
    out
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Backtest {
    pub player: String,
    pub planet: String,
    pub from: u64,
    pub to: u64,
    pub buried_then: u64,
    pub buried_now: u64,
    /// Ore that left the ground between the two heights.
    pub actual_mines: u64,
    /// Mines by `to` projected at the configured aim.
    pub at_aim: u64,
    pub aim: u64,
    pub clock_then: u64,
    pub clock_now: u64,
    /// The mine clock agrees with the mines (see the module doc). `None` = a
    /// raid touched the planet in between, which shifts the clock.
    pub clock_rule_held: Option<bool>,
}

/// The planet as it stands now: buried ore, mine clock, raid clocks.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Now {
    pub buried: u64,
    pub mine_clock: u64,
    pub raid_seen: bool,
}

/// Compare a projection-from-the-past with the present. Pure.
pub fn compare(world_then: &World, player: &str, planet: &str, from: u64, to: u64, now: Now, aim: u64) -> Option<Backtest> {
    let set = project(world_then, from, player, aim)?;
    let p = world_then.planets.get(planet)?;
    let buried_then = p.buried_ore.unwrap_or(0);
    let actual = buried_then.saturating_sub(now.buried);
    let raided = now.raid_seen || p.raid_start != 0 || p.raider_arrived != 0;
    let clock_rule_held = (!raided).then(|| {
        if actual > 0 {
            now.mine_clock > from && now.mine_clock <= to
        } else {
            now.mine_clock == p.mine_start
        }
    });
    Some(Backtest {
        player: player.to_string(),
        planet: planet.to_string(),
        from,
        to,
        buried_then,
        buried_now: now.buried,
        actual_mines: actual,
        at_aim: set.mine_heights.iter().filter(|h| **h <= to).count() as u64,
        aim,
        clock_then: p.mine_start,
        clock_now: now.mine_clock,
        clock_rule_held,
    })
}

async fn entity_at(client: &crate::mcp::cosmos_client::CosmosClient, kind: &str, id: &str, height: u64) -> Result<Value, String> {
    client.lcd_get_bulk_at(&format!("/structs/{kind}/{id}"), Some(height)).await.map(|(v, _, _)| v)
}

/// Backtest `player` from `blocks_back` blocks ago to now. Read-only.
pub async fn run(
    client: &crate::mcp::cosmos_client::CosmosClient,
    player: &str,
    blocks_back: u64,
    aim: u64,
    types: std::collections::HashMap<String, super::world::TypeRules>,
) -> Result<Backtest, String> {
    let latest = crate::mcp::perception::latest_block_height(&client.lcd_get("/cosmos/base/tendermint/v1beta1/blocks/latest").await?)
        .ok_or("no latest height")?;
    let to = latest.saturating_sub(1);
    let from = to.saturating_sub(blocks_back);
    let p = entity_at(client, "player", player, from).await?;
    let planet_id = p.get("Player").and_then(|x| x.get("planetId")).and_then(|x| x.as_str()).unwrap_or("").to_string();
    if planet_id.is_empty() {
        return Err(format!("{player} had no planet at {from}"));
    }
    let fleet_id = p.get("Player").and_then(|x| x.get("fleetId")).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let planet = entity_at(client, "planet", &planet_id, from).await?;
    let fleet = if fleet_id.is_empty() { None } else { entity_at(client, "fleet", &fleet_id, from).await.ok() };
    let mut ids = struct_ids(planet.get("Planet"));
    ids.extend(struct_ids(fleet.as_ref().and_then(|f| f.get("Fleet"))));
    let mut structs = Vec::new();
    for id in ids {
        if let Ok(e) = entity_at(client, "struct", &id, from).await {
            structs.push(e);
        }
    }
    let snap = snapshot_from_entities(from, &p, Some(&planet), fleet.as_ref(), &structs);
    let world = World::from_snapshot(&snap, types, "pinned history", Some(&[player.to_string()]));
    let now = entity_at(client, "planet", &planet_id, to).await?;
    let n = |v: Option<&Value>| crate::mcp::types::numeric_u64(v).unwrap_or(0);
    let pa = now.get("planetAttributes");
    let state = Now {
        buried: n(now.get("gridAttributes").and_then(|g| g.get("ore"))),
        mine_clock: n(pa.and_then(|a| a.get("blockStartOreMine"))),
        raid_seen: n(pa.and_then(|a| a.get("blockStartRaid"))) != 0 || n(pa.and_then(|a| a.get("blockRaiderArrived"))) != 0,
    };
    compare(&world, player, &planet_id, from, to, state, aim).ok_or_else(|| format!("{player}'s planet {planet_id} could not be projected (no rigs at {from}?)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entities() -> (Value, Value, Vec<Value>) {
        let player = json!({"Player": {"id": "1-1", "planetId": "2-1", "fleetId": "", "substationId": ""},
            "gridAttributes": {"ore": "0", "load": "0", "structsLoad": "0", "capacity": "10", "lastAction": "0"}});
        let planet = json!({"Planet": {"id": "2-1", "owner": "1-1", "status": "active", "locationListStart": "", "land": ["5-1", "", "", ""], "landSlots": 4},
            "gridAttributes": {"ore": "3"},
            "planetAttributes": {"blockStartOreMine": "1000", "oreMiningActiveQuantity": "1", "planetaryShield": "0"}});
        let rig = json!({"Struct": {"id": "5-1", "type": "14", "owner": "1-1", "locationType": "planet", "locationId": "2-1", "operatingAmbit": "land", "slot": "0"},
            "structAttributes": {"health": "3", "status": "7"}});
        (player, planet, vec![rig])
    }

    fn world_then() -> World {
        let (p, pl, st) = entities();
        let snap = snapshot_from_entities(1_000, &p, Some(&pl), None, &st);
        let mut types = std::collections::HashMap::new();
        types.insert("14".to_string(), crate::mirror::world::TypeRules { ore_mining_difficulty: 100, ..Default::default() });
        World::from_snapshot(&snap, types, "test", Some(&["1-1".to_string()]))
    }

    #[test]
    fn entity_reads_rebuild_the_world_the_mirror_projects_from() {
        let w = world_then();
        let p = &w.planets["2-1"];
        assert_eq!((p.buried_ore, p.mine_start, p.mining_active), (Some(3), 1_000, 1));
        assert!(w.structs["5-1"].has(crate::mcp::perception::status::ONLINE));
        assert_eq!(w.provenance.as_ref().map(|p| p.pinned), Some(true));
    }

    #[test]
    fn a_mine_moves_the_clock_into_the_window() {
        let b = compare(&world_then(), "1-1", "2-1", 1_000, 1_250, Now { buried: 2, mine_clock: 1_120, raid_seen: false }, 1).unwrap();
        assert_eq!((b.actual_mines, b.at_aim), (1, 2), "aim 1 at range 100: one every 100 blocks");
        assert_eq!(b.clock_rule_held, Some(true));
    }

    #[test]
    fn ore_gone_with_the_clock_unmoved_breaks_the_rule() {
        let b = compare(&world_then(), "1-1", "2-1", 1_000, 1_250, Now { buried: 2, mine_clock: 1_000, raid_seen: false }, 1).unwrap();
        assert_eq!(b.clock_rule_held, Some(false));
    }

    #[test]
    fn no_mine_means_no_clock_movement() {
        let ok = compare(&world_then(), "1-1", "2-1", 1_000, 1_250, Now { buried: 3, mine_clock: 1_000, raid_seen: false }, 1).unwrap();
        assert_eq!(ok.clock_rule_held, Some(true));
        let moved = compare(&world_then(), "1-1", "2-1", 1_000, 1_250, Now { buried: 3, mine_clock: 1_200, raid_seen: false }, 1).unwrap();
        assert_eq!(moved.clock_rule_held, Some(false));
        let raided = compare(&world_then(), "1-1", "2-1", 1_000, 1_250, Now { buried: 3, mine_clock: 1_200, raid_seen: true }, 1).unwrap();
        assert_eq!(raided.clock_rule_held, None, "a raid shifts the clock: not judged");
    }

    #[test]
    fn slot_arrays_and_the_command_ship_name_the_structs_to_read() {
        assert_eq!(struct_ids(Some(&json!({"land": ["5-1", ""], "space": ["5-2"], "commandStruct": "5-9"}))), vec!["5-1", "5-2", "5-9"]);
        assert!(struct_ids(None).is_empty());
    }

    /// Against the live testnet, read-only:
    /// `MIRROR_TYPES=types.json MIRROR_PLAYERS=1-1401,... cargo test mirror::backtest::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live() {
        let page: Value = serde_json::from_slice(&std::fs::read(std::env::var("MIRROR_TYPES").unwrap()).unwrap()).unwrap();
        let types = crate::mirror::world::types_from_lcd(&page);
        let players: Vec<String> = std::env::var("MIRROR_PLAYERS").unwrap().split(',').map(String::from).collect();
        let back: u64 = std::env::var("MIRROR_BACK").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000);
        let client = crate::mcp::cosmos_client::CosmosClient::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            for p in players {
                match run(&client, &p, back, 8, types.clone()).await {
                    Ok(b) => println!("{p}: {} buried → {} now: {} mined (aim 8 projected {}); clock {} → {}: {:?}", b.buried_then, b.buried_now, b.actual_mines, b.at_aim, b.clock_then, b.clock_now, b.clock_rule_held),
                    Err(e) => println!("{p}: {e}"),
                }
            }
        });
    }
}
