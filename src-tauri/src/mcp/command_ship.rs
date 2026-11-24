//! Bringing our own Command Ship into range.
//!
//! The Command Ship is the one struct that can change ambit, and its weapon is
//! local: it hits whatever shares its ambit, and only that. So a target nothing
//! else of ours reaches is not out of reach — unless going there would cost the
//! ship. That is the whole of this module: whether it may go, and sending it.
//!
//! Shared by the raid siege (get at the hull shielding their Command Ship) and
//! the raid defence (get at the raider). In both, losing the ship loses the
//! fight: a raider's raid is defeated, a defender's planet opens.

use serde_json::{json, Value};

use crate::mcp::combat::{simulate, survives_exchange, DefenseProfile, WeaponStats};
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::loop_util::{parse_bool, parse_f64};
use crate::mcp::telemetry::{tlog, Sev};

/// Ambit changes one fight may ask for. A ship sent after one target and then
/// another is spending its charge on travel.
pub const MAX_MOVES: u32 = 4;

/// Whose ship, and where the fight is.
pub struct Ship<'a> {
    pub player: &'a str,
    /// HD index; 0 is the primary.
    pub index: u32,
    pub fleet: &'a str,
    /// The planet the fight is at. The fleet must be there.
    pub planet: &'a str,
    /// The loop asking: telemetry component and signing context.
    pub component: &'static str,
    pub context: String,
}

fn text(v: &Value, p: &str) -> String {
    v.pointer(p)
        .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
        .unwrap_or_default()
}

/// The hardest single shot these weapons land on a Command Ship in `bit`.
/// `blocked`: something of ours stands in that ambit to take it instead.
/// One shot, not a volley of all of them: a player fires once per charge bar.
fn incoming(weapons: &[WeaponStats], bit: u64, hp: f64, own: &DefenseProfile, blocked: bool) -> f64 {
    weapons
        .iter()
        .filter(|w| w.ambits & bit != 0 && !(blocked && w.blockable))
        .map(|w| simulate(w, bit, hp, own, false).expected_damage)
        .fold(0.0, f64::max)
}

/// The enemy's weapons at the planet. Their Command Ship's is left out: it
/// reaches any ambit it chooses to stand in, so it is no worse in one than in
/// another, and using it on ours draws our counter.
async fn enemy_weapons(client: &CosmosClient, owner: &str, planet: &str) -> Result<Vec<WeaponStats>, String> {
    let player = client.entity("player", owner).await?;
    let fleet = text(&player, "/Player/fleetId");
    let here = match fleet.is_empty() {
        true => false,
        false => text(&client.entity("fleet", &fleet).await?, "/Fleet/locationId") == planet,
    };
    let structs = crate::mcp::loop_util::player_structs(client, owner).await;
    if structs.is_empty() {
        // They own the target, so this is a failed read.
        return Err(format!("{owner}'s structs could not be read"));
    }
    let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for s in &structs {
        let at = text(s, "/location_id");
        if parse_bool(s.get("is_destroyed")) || !parse_bool(s.get("is_built")) || !(at == planet || (here && at == fleet)) {
            continue;
        }
        let Some(t) = gs.struct_types.get(&text(s, "/type")) else {
            return Err(format!("struct type {} is not in the catalogue", text(s, "/type")));
        };
        if t.trigger_raid_defeat_by_destruction == Some(true) {
            continue;
        }
        let stands = crate::mcp::tools::format::ambit_bit(&text(s, "/operating_ambit"));
        for secondary in [false, true] {
            let w = WeaponStats::from_type(t, secondary).standing_in(stands);
            if w.ambits != 0 && w.shots > 0 {
                out.push(w);
            }
        }
    }
    Ok(out)
}

/// Which ambits hold a live struct of ours registered to shield `cmd`.
async fn shielded_in(client: &CosmosClient, cmd: &str) -> Result<u64, String> {
    let mut mask = 0;
    for id in crate::mcp::tools::intel::defenders_of(client, cmd).await? {
        match client.query_entity("struct", &id).await {
            Ok(e) if parse_bool(e.pointer("/structAttributes/isDestroyed")) || !parse_bool(e.pointer("/structAttributes/isOnline")) => {}
            Ok(e) => mask |= crate::mcp::tools::format::ambit_bit(&text(&e, "/Struct/operatingAmbit")),
            Err(e) if crate::mcp::cosmos_client::is_absent_object(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(mask)
}

/// Move `ship` into `target`'s ambit, when it would survive killing it there.
/// Returns the ambit it moved to; it fires on a later round, the move having
/// spent the player's charge.
///
/// Survival is judged to the target's death, on live health: what each shot
/// draws back (`intel::shot_cost`), plus what the enemy can ADD between rounds
/// by our standing there instead of here. Anything unread counts as no.
pub async fn bring(app: &tauri::AppHandle, client: &CosmosClient, ship: &Ship<'_>, target: &str) -> Option<&'static str> {
    let fleet = client.entity("fleet", ship.fleet).await.ok()?;
    if text(&fleet, "/Fleet/locationId") != ship.planet {
        return None; // not in this fight
    }
    let cmd = Some(text(&fleet, "/Fleet/commandStruct")).filter(|s| !s.is_empty())?;
    let ours = client.query_entity("struct", &cmd).await.ok()?;
    let theirs = client.query_entity("struct", target).await.ok()?;
    let ambit = match text(&theirs, "/Struct/operatingAmbit").as_str() {
        "water" => "water",
        "land" => "land",
        "air" => "air",
        "space" => "space",
        _ => return None,
    };
    // The target has to be in this fight too: an attack record can name a
    // struct whose fleet has since left.
    let at = text(&theirs, "/Struct/locationId");
    let place = match text(&theirs, "/Struct/locationType").as_str() {
        "planet" => at,
        "fleet" => text(&client.entity("fleet", &at).await.ok()?, "/Fleet/locationId"),
        _ => return None,
    };
    if place != ship.planet {
        return None;
    }
    if !parse_bool(ours.pointer("/structAttributes/isOnline")) {
        return None;
    }
    let from = text(&ours, "/Struct/operatingAmbit");
    if from == ambit {
        // Already there. Either held back for safety, or the planner cached
        // where it stood before the move was included: look again next round.
        crate::mcp::loop_util::invalidate_player_structs(ship.player);
        return None;
    }
    let hp = parse_f64(ours.pointer("/structAttributes/health"));
    let target_hp = parse_f64(theirs.pointer("/structAttributes/health"));
    let (here, there) = (crate::mcp::tools::format::ambit_bit(&from), crate::mcp::tools::format::ambit_bit(ambit));
    let (per_shot, own) = {
        let gs = crate::game_state::GAME_STATE.read().ok()?;
        let own_type = gs.struct_types.get(&text(&ours, "/Struct/type"))?;
        if own_type.possible_ambit.unwrap_or(0) & there == 0 {
            return None;
        }
        let weapon = WeaponStats::from_type(own_type, false).standing_in(there);
        let defense = gs.struct_types.get(&text(&theirs, "/Struct/type")).map(DefenseProfile::from_type)?;
        let r = simulate(&weapon, there, target_hp, &defense, true);
        if !r.reachable {
            return None;
        }
        (r.expected_damage, DefenseProfile::from_type(own_type))
    };
    let cost = crate::mcp::tools::intel::shot_cost(client, target, there).await.ok()?;
    let weapons = enemy_weapons(client, &text(&theirs, "/Struct/owner"), ship.planet).await.ok()?;
    let shield = shielded_in(client, &cmd).await.ok()?;
    let exposed = incoming(&weapons, there, hp, &own, shield & there != 0);
    let added = (exposed - incoming(&weapons, here, hp, &own, shield & here != 0)).max(0.0);
    if !survives_exchange(hp, cost, added, target_hp, per_shot) {
        tlog(
            ship.component,
            Sev::Info,
            format!(
                "{}: Command Ship stays in {from} — it would not survive killing {target} in {ambit} \
                 ({} a shot, {} until it dies, {added:.0} more a round from their fire, against {hp:.0} HP)",
                ship.player, cost.every, cost.unless_killed
            ),
        );
        return None;
    }
    let moved = crate::mcp::tx_retry::sign_with_retry(
        app,
        ship.index,
        "/structs.structs.MsgStructMove",
        json!({
            "structId": cmd,
            // A Command Ship changes ambit within its own FLEET and holds no slot.
            "locationType": crate::mcp::tools::players::location_type_to_enum("fleet"),
            "ambit": crate::mcp::tools::players::ambit_to_enum(ambit),
            "slot": 0,
        }),
        ship.context.as_str(),
    )
    .await;
    match moved {
        Ok(_) => {
            // The planner reads where hulls stand from this cache.
            crate::mcp::loop_util::invalidate_player_structs(ship.player);
            tlog(ship.component, Sev::Notice, format!("{}: Command Ship {cmd} moved {from} → {ambit} to reach {target}", ship.player));
            Some(ambit)
        }
        Err(e) => {
            // Short of charge is the ordinary case: it goes next round.
            let sev = if crate::mcp::tx_retry::worth_retrying_soon(&e) { Sev::Info } else { Sev::Warn };
            tlog(ship.component, sev, format!("{}: Command Ship could not move to {ambit}: {e}", ship.player));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::combat::{ShotCost, WeaponControl};

    fn weapon(ambits: u64, damage: u64, blockable: bool) -> WeaponStats {
        WeaponStats {
            shots: 1,
            guaranteed: 1,
            success_num: 1,
            success_den: 1,
            damage,
            recoil: 0,
            ambits,
            blockable,
            counterable: true,
            control: WeaponControl::Guided,
            armour_piercing: false,
            charge: 3,
        }
    }

    /// Only what reaches the ambit counts, one shot of it, and not through a
    /// ship of ours standing in the way — unless it cannot be blocked.
    #[test]
    fn incoming_fire_is_the_hardest_shot_that_gets_through() {
        let own = DefenseProfile::basic(0, 2, 2);
        let theirs = [weapon(4, 2, true), weapon(4 | 8, 3, true), weapon(16, 5, true)];
        assert_eq!(incoming(&theirs, 4, 6.0, &own, false), 3.0);
        assert_eq!(incoming(&theirs, 2, 6.0, &own, false), 0.0, "nothing reaches water");
        assert_eq!(incoming(&theirs, 4, 6.0, &own, true), 0.0);
        assert_eq!(incoming(&[weapon(4, 2, false)], 4, 6.0, &own, true), 2.0);
    }

    /// Where their guns do not reach, the ship may go; where they do, and it is
    /// sheltered now, the rounds it takes are paid for.
    #[test]
    fn their_fire_decides_a_move_the_counters_would_allow() {
        // A 3 HP blocker, countering 1: two shots, one HP.
        let blocker = ShotCost { every: 0, unless_killed: 1 };
        assert!(survives_exchange(6.0, blocker, 0.0, 3.0, 2.0));
        assert!(survives_exchange(6.0, blocker, 2.0, 3.0, 2.0), "one gun on it: 1 + 4");
        assert!(!survives_exchange(6.0, blocker, 3.0, 3.0, 2.0), "a heavier one: 1 + 6");
        // A lone Command Ship, three shots: fine unseen, fatal under fire.
        let duel = ShotCost { every: 0, unless_killed: 2 };
        assert!(survives_exchange(6.0, duel, 0.0, 6.0, 2.0));
        assert!(!survives_exchange(6.0, duel, 2.0, 6.0, 2.0));
    }
}
