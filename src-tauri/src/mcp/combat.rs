//! Pure combat math for the `simulate` intel arm and the autonomous combat
//! loops — lets a player (or a loop) preview an attack before committing,
//! instead of losing structs to learn the rules.
//!
//! Models `knowledge/mechanics/combat.md`:
//!   1. **Evasion** is rolled ONCE PER TARGET, not per shot. On a successful
//!      evade the entire volley misses (counters still fire). The chance is
//!      keyed on the INCOMING weapon's control: a Battleship's `signalJamming`
//!      is guided 2/3 (66% miss) and unguided 0/0 (no effect).
//!   2. `damage = Σ(successful shots) − attackReduction`, floored at 1 if any
//!      shot lands, capped at target health. The first `guaranteed_shots`
//!      always hit; the rest roll `numerator/denominator`.
//!   3. **Armour-piercing** weapons skip the reduction entirely.
//!   4. **Counters** are gated on the defender's weapon reaching the
//!      ATTACKER's ambit — same-ambit full value, cross-ambit halved, and
//!      defenders take no counter-damage themselves.

/// Ambit reach bits (Water=2, Land=4, Air=8, Space=16). Note this is the
/// BITMASK encoding, not the message enum (water=1, land=2, air=3, space=4).
pub const AMBIT_BITS: [u64; 4] = [2, 4, 8, 16];

/// Which control a weapon uses — decides WHICH of the target's two evasion
/// rates applies. `signalJamming` counters guided, `defensiveManeuver`
/// counters unguided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WeaponControl {
    #[default]
    Unknown,
    Guided,
    Unguided,
}

impl WeaponControl {
    /// Parse the chain's `primaryWeaponControl` / `secondaryWeaponControl`
    /// string (`"guided"`, `"unguided"`, `"noWeaponControl"`).
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|v| v.trim().to_ascii_lowercase()) {
            Some(v) if v == "guided" => Self::Guided,
            Some(v) if v == "unguided" => Self::Unguided,
            _ => Self::Unknown,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Guided => "guided",
            Self::Unguided => "unguided",
            Self::Unknown => "?",
        }
    }
}

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
    /// Decides which of the target's evasion rates applies.
    pub control: WeaponControl,
    /// Armour-piercing weapons ignore the target's `attack_reduction`.
    pub armour_piercing: bool,
}

impl WeaponStats {
    /// Build the primary (or secondary) weapon's stats from a synced struct
    /// type. Single source of truth — `simulate`, `plan_strike` and both combat
    /// loops all read weapons through here so a new chain field only has to be
    /// wired once.
    pub fn from_type(t: &crate::game_state::StructTypeInfo, secondary: bool) -> Self {
        if secondary {
            Self {
                shots: t.secondary_weapon_shots.unwrap_or(0),
                guaranteed: t.secondary_weapon_guaranteed_shots.unwrap_or(0),
                success_num: t.secondary_weapon_shot_success_numerator.unwrap_or(0),
                success_den: t.secondary_weapon_shot_success_denominator.unwrap_or(1),
                damage: t.secondary_weapon_damage.unwrap_or(0),
                recoil: t.secondary_weapon_recoil_damage.unwrap_or(0),
                ambits: t.secondary_weapon_ambits.unwrap_or(0),
                blockable: t.secondary_weapon_blockable.unwrap_or(false),
                counterable: t.secondary_weapon_counterable.unwrap_or(false),
                control: WeaponControl::parse(t.secondary_weapon_control.as_deref()),
                armour_piercing: t.secondary_weapon_armour_piercing.unwrap_or(false),
            }
        } else {
            Self {
                shots: t.primary_weapon_shots.unwrap_or(0),
                guaranteed: t.primary_weapon_guaranteed_shots.unwrap_or(0),
                success_num: t.primary_weapon_shot_success_numerator.unwrap_or(0),
                success_den: t.primary_weapon_shot_success_denominator.unwrap_or(1),
                damage: t.primary_weapon_damage.unwrap_or(0),
                recoil: t.primary_weapon_recoil_damage.unwrap_or(0),
                ambits: t.primary_weapon_ambits.unwrap_or(0),
                blockable: t.primary_weapon_blockable.unwrap_or(false),
                counterable: t.primary_weapon_counterable.unwrap_or(false),
                control: WeaponControl::parse(t.primary_weapon_control.as_deref()),
                armour_piercing: t.primary_weapon_armour_piercing.unwrap_or(false),
            }
        }
    }
}

/// Everything about the TARGET that changes the outcome. Built from the
/// target's `StructTypeInfo` — see `DefenseProfile::from_type`.
#[derive(Debug, Clone, Default)]
pub struct DefenseProfile {
    /// `attackReduction` — armour, subtracted from total damage.
    pub reduction: u64,
    /// Chance the whole volley misses when the incoming weapon is GUIDED.
    pub evade_guided_num: u64,
    pub evade_guided_den: u64,
    /// Chance the whole volley misses when the incoming weapon is UNGUIDED.
    pub evade_unguided_num: u64,
    pub evade_unguided_den: u64,
    /// Counter damage this target deals back: full same-ambit, halved cross.
    pub counter_same: u64,
    pub counter_cross: u64,
}

impl DefenseProfile {
    pub fn from_type(t: &crate::game_state::StructTypeInfo) -> Self {
        Self {
            reduction: t.attack_reduction.unwrap_or(0),
            evade_guided_num: t.guided_defensive_success_rate_numerator.unwrap_or(0),
            evade_guided_den: t.guided_defensive_success_rate_denominator.unwrap_or(0),
            evade_unguided_num: t.unguided_defensive_success_rate_numerator.unwrap_or(0),
            evade_unguided_den: t.unguided_defensive_success_rate_denominator.unwrap_or(0),
            counter_same: t.counter_attack_same_ambit.unwrap_or(0),
            counter_cross: t.counter_attack.unwrap_or(0),
        }
    }

    /// Shorthand for a target whose only defences are armour and counters —
    /// no evasion. Production code builds profiles from a real struct type via
    /// [`DefenseProfile::from_type`]; this exists for tests that want to isolate
    /// one mechanic at a time.
    #[cfg(test)]
    pub fn basic(reduction: u64, counter_same: u64, counter_cross: u64) -> Self {
        Self { reduction, counter_same, counter_cross, ..Default::default() }
    }

    /// Probability the entire volley is evaded, given the incoming control.
    /// An unknown control is treated as the WORST case for the attacker (the
    /// higher of the two rates) so planning never over-promises damage.
    pub fn evade_chance(&self, control: WeaponControl) -> f64 {
        let g = ratio(self.evade_guided_num, self.evade_guided_den);
        let u = ratio(self.evade_unguided_num, self.evade_unguided_den);
        match control {
            WeaponControl::Guided => g,
            WeaponControl::Unguided => u,
            WeaponControl::Unknown => g.max(u),
        }
    }
}

fn ratio(num: u64, den: u64) -> f64 {
    if den == 0 {
        0.0
    } else {
        (num as f64 / den as f64).clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone)]
pub struct SimResult {
    pub reachable: bool,
    pub target_hp: f64,
    pub reduction: u64,
    /// Damage when the volley is NOT evaded and only the guaranteed shots land.
    pub min_damage: f64,
    /// Expected damage including the per-target evasion roll — this is the
    /// number to rank shooters by.
    pub expected_damage: f64,
    /// Damage when the volley is not evaded and every shot lands.
    pub max_damage: f64,
    pub kills_min: bool,
    pub kills_expected: bool,
    pub recoil_to_attacker: u64,
    /// Counter damage the attacker risks if the target/defenders counter
    /// (advisory; conditional on the defender being online & able to reach).
    pub counter_estimate: u64,
    /// Probability the whole volley is evaded (0.0 when the target has no
    /// defense against this weapon's control).
    pub evade_chance: f64,
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
pub fn simulate(
    weapon: &WeaponStats,
    target_ambit_bit: u64,
    target_hp: f64,
    defense: &DefenseProfile,
    same_ambit_as_attacker: bool,
) -> SimResult {
    let reachable = target_ambit_bit == 0 || weapon.ambits == 0 || (weapon.ambits & target_ambit_bit) != 0;

    let shots = weapon.shots;
    let guaranteed = weapon.guaranteed.min(shots);
    let rolled = shots.saturating_sub(guaranteed);
    let p = ratio(weapon.success_num, weapon.success_den);
    let expected_hits = guaranteed as f64 + rolled as f64 * p;

    // Armour-piercing skips the target's damage reduction entirely.
    let reduction = if weapon.armour_piercing { 0 } else { defense.reduction };
    let evade = defense.evade_chance(weapon.control);

    let min_damage = after_reduction(guaranteed as f64, weapon.damage, reduction).min(target_hp);
    // Evasion is rolled once per target: on a hit the volley resolves normally,
    // on an evade it deals nothing. So expectation scales linearly by (1−p).
    let landed = after_reduction(expected_hits, weapon.damage, reduction).min(target_hp);
    let expected_damage = landed * (1.0 - evade);
    let max_damage = after_reduction(shots as f64, weapon.damage, reduction).min(target_hp);

    // Counter: same-ambit does full, cross-ambit halves (combat.md). Use whichever
    // counter value the target type exposes; advisory only.
    let counter_estimate = if same_ambit_as_attacker {
        if defense.counter_same > 0 { defense.counter_same } else { defense.counter_cross }
    } else {
        let base = if defense.counter_cross > 0 { defense.counter_cross } else { defense.counter_same };
        base / 2
    };

    SimResult {
        reachable,
        target_hp,
        reduction,
        min_damage,
        expected_damage,
        max_damage,
        // A kill claim must not assume the volley connects — an evadable volley
        // can never be called a guaranteed kill.
        kills_min: reachable && evade == 0.0 && min_damage >= target_hp && target_hp > 0.0,
        kills_expected: reachable && landed >= target_hp && target_hp > 0.0,
        recoil_to_attacker: weapon.recoil,
        counter_estimate: if weapon.counterable { counter_estimate } else { 0 },
        evade_chance: evade,
    }
}

// ─────────────────────────── counter-free ambits ────────────────────────────

/// Given the weapon-reach masks of every live defender registered on a target
/// (plus the target's own weapon reach), return the bitmask of ambits an
/// attacker can fire FROM while taking zero counter damage.
///
/// Counters are gated on the defender's weapon reaching the *attacker's* ambit
/// (`CanCounterTargetAmbit`), independently of the defended struct's ambit —
/// so this is purely "which ambits nobody covers". Attacking from one of these
/// is, per the docs, "the single biggest combat lever".
pub fn counter_free_ambits(defender_weapon_masks: &[u64]) -> u64 {
    let covered = defender_weapon_masks.iter().fold(0u64, |acc, m| acc | m);
    AMBIT_BITS.iter().fold(0u64, |acc, b| acc | b) & !covered
}

/// How exposed an attacker sitting in `attacker_ambit_bit` is: the number of
/// defenders whose weapons reach that ambit. 0 means a free shot.
pub fn counter_exposure(defender_weapon_masks: &[u64], attacker_ambit_bit: u64) -> usize {
    if attacker_ambit_bit == 0 {
        return defender_weapon_masks.len();
    }
    defender_weapon_masks
        .iter()
        .filter(|m| **m & attacker_ambit_bit != 0)
        .count()
}

// ───────────────────────── planetary interceptor layer ──────────────────────

/// The planet's low-orbit ballistic interceptor network — a second evasion layer
/// that only ever fires at GUIDED ordnance aimed at a struct sitting on that
/// planet. Unlike unit defenses, its rate lives on the PLANET entity
/// (`planetAttributes.lowOrbitBallisticsInterceptorNetworkSuccessRate*`), and
/// each additional interceptor compounds the chance.
#[derive(Debug, Clone, Copy, Default)]
pub struct InterceptorNet {
    pub quantity: u32,
    pub success_num: u64,
    pub success_den: u64,
}

impl InterceptorNet {
    /// Read from a planet entity's `planetAttributes`.
    pub fn from_planet_attributes(pa: Option<&serde_json::Value>) -> Self {
        let n = |k: &str| -> u64 {
            pa.and_then(|x| x.get(k))
                .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0)
        };
        Self {
            quantity: n("lowOrbitBallisticsInterceptorNetworkQuantity") as u32,
            success_num: n("lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator"),
            success_den: n("lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator"),
        }
    }

    /// Fraction of guided volleys that still get through. Unguided ordnance
    /// "carries no guidance to jam and passes through untouched".
    pub fn hit_factor(&self, control: WeaponControl, target_is_planetary: bool) -> f64 {
        if !target_is_planetary || self.quantity == 0 || control == WeaponControl::Unguided {
            return 1.0;
        }
        let evade = ratio(self.success_num, self.success_den);
        if evade <= 0.0 {
            return 1.0;
        }
        (1.0 - evade).powi(self.quantity as i32)
    }
}

/// Rank score for choosing a shooter: expected damage after both evasion layers,
/// penalised by the counter damage the shooter would eat. Used by the combat
/// loops for ordering only — `SimResult::expected_damage` remains the honest,
/// chain-derived number shown to the player.
pub fn shooter_score(
    sim: &SimResult,
    control: WeaponControl,
    interceptors: InterceptorNet,
    target_is_planetary: bool,
    counter_exposure: usize,
) -> f64 {
    if !sim.reachable {
        return f64::MIN;
    }
    let dmg = sim.expected_damage * interceptors.hit_factor(control, target_is_planetary);
    // Each defender that can reach us costs roughly `counter_estimate` HP.
    let risk = sim.counter_estimate as f64 * counter_exposure as f64 + sim.recoil_to_attacker as f64;
    dmg - 0.35 * risk
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
            control: WeaponControl::Unguided,
            armour_piercing: false,
        }
    }
    fn no_def() -> DefenseProfile {
        DefenseProfile::default()
    }

    #[test]
    fn guaranteed_shots_set_the_floor() {
        // 3 shots, 1 guaranteed, 1/3 success, 1 dmg each, no armour.
        let r = simulate(&w(3, 1, 1, 3, 1), 16, 3.0, &no_def(), true);
        assert_eq!(r.min_damage, 1.0); // only the guaranteed shot
        // expected = 1 + 2*(1/3) = 1.667 → after_reduction floor doesn't apply (>1)
        assert!((r.expected_damage - 1.6667).abs() < 0.01);
        assert_eq!(r.max_damage, 3.0); // all 3 land
    }

    #[test]
    fn armour_reduces_but_floors_at_one() {
        // 2 hits @ 2 dmg = 4 raw, armour 3 → 1 (floored), not -1 or 0.
        let r = simulate(&w(2, 2, 1, 1, 2), 16, 10.0, &DefenseProfile::basic(3, 0, 0), true);
        assert_eq!(r.min_damage, 1.0);
    }

    #[test]
    fn armour_piercing_ignores_reduction() {
        let mut ap = w(2, 2, 1, 1, 2);
        ap.armour_piercing = true;
        let r = simulate(&ap, 16, 10.0, &DefenseProfile::basic(3, 0, 0), true);
        assert_eq!(r.min_damage, 4.0); // full 2×2, armour skipped
    }

    #[test]
    fn out_of_ambit_is_unreachable_and_no_kill() {
        // weapon hits space(16); target in land(4).
        let r = simulate(&w(5, 5, 1, 1, 5), 4, 3.0, &no_def(), false);
        assert!(!r.reachable);
        assert!(!r.kills_expected);
    }

    #[test]
    fn cross_ambit_counter_is_halved() {
        let same = simulate(&w(1, 1, 1, 1, 1), 16, 5.0, &DefenseProfile::basic(0, 8, 4), true);
        assert_eq!(same.counter_estimate, 8); // same-ambit → full
        let cross = simulate(&w(1, 1, 1, 1, 1), 16, 5.0, &DefenseProfile::basic(0, 8, 4), false);
        assert_eq!(cross.counter_estimate, 2); // cross → 4/2
    }

    /// The Battleship's signalJamming: guided 2/3, unguided 0/0. A guided volley
    /// into it should lose two thirds of its expected damage; an unguided volley
    /// should lose nothing. This is the meta the data confirmed (guided evaded
    /// 12.4% vs unguided 2.5%).
    #[test]
    fn signal_jamming_only_bites_guided() {
        let jammer = DefenseProfile {
            evade_guided_num: 2,
            evade_guided_den: 3,
            ..Default::default()
        };
        let mut guided = w(1, 1, 1, 1, 2);
        guided.control = WeaponControl::Guided;
        let unguided = w(1, 1, 1, 1, 2); // control defaults to Unguided in `w`

        let g = simulate(&guided, 16, 6.0, &jammer, true);
        let u = simulate(&unguided, 16, 6.0, &jammer, true);

        assert!((g.evade_chance - 0.6667).abs() < 0.01);
        assert_eq!(u.evade_chance, 0.0);
        assert!((g.expected_damage - 2.0 * (1.0 / 3.0)).abs() < 0.01);
        assert_eq!(u.expected_damage, 2.0);
        assert!(u.expected_damage > g.expected_damage);
    }

    /// The High Altitude Interceptor's defensiveManeuver is the mirror image —
    /// it evades UNGUIDED, so guided is the right answer into one.
    #[test]
    fn defensive_maneuver_only_bites_unguided() {
        let hai = DefenseProfile {
            evade_unguided_num: 2,
            evade_unguided_den: 3,
            ..Default::default()
        };
        let mut guided = w(1, 1, 1, 1, 2);
        guided.control = WeaponControl::Guided;
        let unguided = w(1, 1, 1, 1, 2);
        assert!(simulate(&guided, 16, 6.0, &hai, true).expected_damage
            > simulate(&unguided, 16, 6.0, &hai, true).expected_damage);
    }

    #[test]
    fn an_evadable_volley_is_never_a_guaranteed_kill() {
        let jammer = DefenseProfile { evade_guided_num: 2, evade_guided_den: 3, ..Default::default() };
        let mut guided = w(4, 4, 1, 1, 2); // 8 damage into 6 HP
        guided.control = WeaponControl::Guided;
        let r = simulate(&guided, 16, 6.0, &jammer, true);
        assert!(!r.kills_min, "evasion can always spare the target");
        assert!(r.kills_expected, "but it does kill when the volley connects");
    }

    #[test]
    fn unknown_control_assumes_the_worst_for_the_attacker() {
        let both = DefenseProfile {
            evade_guided_num: 2,
            evade_guided_den: 3,
            evade_unguided_num: 1,
            evade_unguided_den: 3,
            ..Default::default()
        };
        assert!((both.evade_chance(WeaponControl::Unknown) - 0.6667).abs() < 0.01);
    }

    #[test]
    fn counter_free_ambits_are_the_uncovered_ones() {
        // One land-only defender (mask 4) and one water/land (mask 6).
        let free = counter_free_ambits(&[4, 6]);
        assert_eq!(free & 4, 0, "land is covered");
        assert_eq!(free & 2, 0, "water is covered");
        assert_eq!(free & 8, 8, "air is free");
        assert_eq!(free & 16, 16, "space is free");
        assert_eq!(counter_exposure(&[4, 6], 4), 2);
        assert_eq!(counter_exposure(&[4, 6], 16), 0);
    }

    #[test]
    fn no_defenders_means_every_ambit_is_free() {
        assert_eq!(counter_free_ambits(&[]), 2 | 4 | 8 | 16);
    }

    /// Live planet 2-855 carries one interceptor at 1/3 — so a guided volley at
    /// a struct on that planet gets through two thirds of the time, and an
    /// unguided one is untouched.
    #[test]
    fn interceptors_only_penalise_guided_at_planetary_targets() {
        let net = InterceptorNet { quantity: 1, success_num: 1, success_den: 3 };
        assert_eq!(net.hit_factor(WeaponControl::Unguided, true), 1.0);
        assert_eq!(net.hit_factor(WeaponControl::Guided, false), 1.0);
        assert!((net.hit_factor(WeaponControl::Guided, true) - 2.0 / 3.0).abs() < 1e-9);
        // Each extra interceptor compounds.
        let two = InterceptorNet { quantity: 2, success_num: 1, success_den: 3 };
        assert!((two.hit_factor(WeaponControl::Guided, true) - (2.0f64 / 3.0).powi(2)).abs() < 1e-9);
        // No network, or a zero rate, changes nothing.
        assert_eq!(InterceptorNet::default().hit_factor(WeaponControl::Guided, true), 1.0);
    }

    #[test]
    fn interceptor_net_parses_planet_attributes() {
        let pa = serde_json::json!({
            "lowOrbitBallisticsInterceptorNetworkQuantity": "1",
            "lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator": "1",
            "lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator": "3",
        });
        let net = InterceptorNet::from_planet_attributes(Some(&pa));
        assert_eq!(net.quantity, 1);
        assert_eq!((net.success_num, net.success_den), (1, 3));
    }

    #[test]
    fn shooter_score_prefers_the_counter_free_ambit() {
        let sim = simulate(&w(1, 1, 1, 1, 2), 16, 6.0, &DefenseProfile::basic(0, 2, 2), true);
        let n = InterceptorNet::default();
        let exposed = shooter_score(&sim, WeaponControl::Unguided, n, false, 3);
        let free = shooter_score(&sim, WeaponControl::Unguided, n, false, 0);
        assert!(free > exposed);
    }

    #[test]
    fn control_parses_the_chain_strings() {
        assert_eq!(WeaponControl::parse(Some("guided")), WeaponControl::Guided);
        assert_eq!(WeaponControl::parse(Some("unguided")), WeaponControl::Unguided);
        assert_eq!(WeaponControl::parse(Some("noWeaponControl")), WeaponControl::Unknown);
        assert_eq!(WeaponControl::parse(None), WeaponControl::Unknown);
    }
}
