//! Pure combat math for the `simulate` intel arm — lets a player preview an
//! attack before committing, instead of losing structs to learn the rules.
//! Models the `knowledge/mechanics/combat.md` formula:
//!   damage = Σ(successful shots) − damageReduction   (min 1 if any shot lands,
//!   capped at target health). The first `guaranteed_shots` always hit; the rest
//!   roll success = numerator/denominator.

/// A single weapon's stats (primary or secondary), pulled from StructTypeInfo.
#[derive(Debug, Clone, Default)]
pub struct WeaponStats {
    pub shots: u64,
    pub guaranteed: u64,
    pub success_num: u64,
    pub success_den: u64,
    pub damage: u64,
    pub recoil: u64,
    pub ambits: u64, // bitmask of ambits this weapon can hit
    pub blockable: bool,
    pub counterable: bool,
}

#[derive(Debug, Clone)]
pub struct SimResult {
    pub reachable: bool,
    pub target_hp: f64,
    pub reduction: u64,
    pub min_damage: f64,      // only guaranteed shots land
    pub expected_damage: f64, // expected hits
    pub max_damage: f64,      // every shot lands
    pub kills_min: bool,      // guaranteed shots alone kill
    pub kills_expected: bool,
    pub recoil_to_attacker: u64,
    /// Counter damage the attacker risks if the target/defenders counter
    /// (advisory; conditional on the defender being online & able to reach).
    pub counter_estimate: u64,
}

/// Apply armour: total reduced by `reduction`, floored at 1 if any shot landed.
fn after_reduction(hits: f64, damage: u64, reduction: u64) -> f64 {
    if hits <= 0.0 {
        return 0.0;
    }
    let raw = hits * damage as f64;
    let reduced = raw - reduction as f64;
    reduced.max(1.0)
}

/// Simulate one `weapon` firing at a target.
/// - `target_ambit_bit`: the target's current ambit bit (0 if unknown → reachability assumed).
/// - `same_ambit_as_attacker`: whether the target sits in the attacker's ambit
///   (a same-ambit counter does full `counter_estimate`; cross-ambit halves it).
#[allow(clippy::too_many_arguments)]
pub fn simulate(
    weapon: &WeaponStats,
    target_ambit_bit: u64,
    target_hp: f64,
    reduction: u64,
    target_counter_same: u64,
    target_counter_cross: u64,
    same_ambit_as_attacker: bool,
) -> SimResult {
    let reachable = target_ambit_bit == 0 || weapon.ambits == 0 || (weapon.ambits & target_ambit_bit) != 0;

    let shots = weapon.shots;
    let guaranteed = weapon.guaranteed.min(shots);
    let rolled = shots.saturating_sub(guaranteed);
    let p = if weapon.success_den > 0 {
        weapon.success_num as f64 / weapon.success_den as f64
    } else {
        0.0
    };
    let expected_hits = guaranteed as f64 + rolled as f64 * p;

    let min_damage = after_reduction(guaranteed as f64, weapon.damage, reduction).min(target_hp);
    let expected_damage = after_reduction(expected_hits, weapon.damage, reduction).min(target_hp);
    let max_damage = after_reduction(shots as f64, weapon.damage, reduction).min(target_hp);

    // Counter: same-ambit does full, cross-ambit halves (combat.md). Use whichever
    // counter value the target type exposes; advisory only.
    let counter_estimate = if same_ambit_as_attacker {
        if target_counter_same > 0 { target_counter_same } else { target_counter_cross }
    } else {
        let base = if target_counter_cross > 0 { target_counter_cross } else { target_counter_same };
        base / 2
    };

    SimResult {
        reachable,
        target_hp,
        reduction,
        min_damage,
        expected_damage,
        max_damage,
        kills_min: reachable && min_damage >= target_hp && target_hp > 0.0,
        kills_expected: reachable && expected_damage >= target_hp && target_hp > 0.0,
        recoil_to_attacker: weapon.recoil,
        counter_estimate: if weapon.counterable { counter_estimate } else { 0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(shots: u64, guaranteed: u64, num: u64, den: u64, damage: u64) -> WeaponStats {
        WeaponStats {
            shots,
            guaranteed,
            success_num: num,
            success_den: den,
            damage,
            recoil: 0,
            ambits: 16, // space
            blockable: false,
            counterable: true,
        }
    }

    #[test]
    fn guaranteed_shots_set_the_floor() {
        // 3 shots, 1 guaranteed, 1/3 success, 1 dmg each, no armour.
        let r = simulate(&w(3, 1, 1, 3, 1), 16, 3.0, 0, 0, 0, true);
        assert_eq!(r.min_damage, 1.0); // only the guaranteed shot
        // expected = 1 + 2*(1/3) = 1.667 → after_reduction floor doesn't apply (>1)
        assert!((r.expected_damage - 1.6667).abs() < 0.01);
        assert_eq!(r.max_damage, 3.0); // all 3 land
    }

    #[test]
    fn armour_reduces_but_floors_at_one() {
        // 2 hits @ 2 dmg = 4 raw, armour 3 → 1 (floored), not -1 or 0.
        let r = simulate(&w(2, 2, 1, 1, 2), 16, 10.0, 3, 0, 0, true);
        assert_eq!(r.min_damage, 1.0);
    }

    #[test]
    fn out_of_ambit_is_unreachable_and_no_kill() {
        // weapon hits space(16); target in land(4).
        let r = simulate(&w(5, 5, 1, 1, 5), 4, 3.0, 0, 0, 0, false);
        assert!(!r.reachable);
        assert!(!r.kills_expected);
    }

    #[test]
    fn cross_ambit_counter_is_halved() {
        let same = simulate(&w(1, 1, 1, 1, 1), 16, 5.0, 0, 8, 4, true);
        assert_eq!(same.counter_estimate, 8); // same-ambit → full
        let cross = simulate(&w(1, 1, 1, 1, 1), 16, 5.0, 0, 8, 4, false);
        assert_eq!(cross.counter_estimate, 2); // cross → 4/2
    }
}
