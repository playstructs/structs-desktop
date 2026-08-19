//! Stochastic move selection — the difference between a bot and an opponent.
//!
//! WHY THIS EXISTS. Every automation loop here computes a score and then takes
//! the argmax, so a given board state always produces the same move. That is
//! cold to play against, and it is *profileable*: on 2026-08-18 we watched
//! 1-471's automation lose two engagements by repeating the same same-ambit
//! shot into a defended Command Ship until its fleet was gone. Ours is exactly
//! as deterministic and would lose the same way to anyone who modelled it.
//!
//! Determinism also has a measured strategic cost. `auto_build` walks ONE fixed
//! loadout order, so every fleet converges on the same composition: **1,876 of
//! 2,238 of our players (84%) had no viable shot into water** — a monoculture
//! built by an argmax. Sampling the build order is a real fix, not decoration.
//!
//! ## Filters are law, rankings are taste
//!
//! Every selection site in this codebase has the shape
//! `filter(hard constraint).max_by_key(soft quality)`. This module replaces the
//! **second half only**. A "mistake" here means a legal-but-worse move — a shot
//! that eats a counter, a thinner raid target, the second-best hull. It never
//! means an *illegal* move: the chain simply rejects those, which is a wasted
//! transaction and a bug-shaped no-op, not interesting play.
//!
//! Callers must therefore sample over an ALREADY-FILTERED set. In particular
//! these stay absolute at every temperature: `combat_lists::is_vetoed` (own
//! team, allies, protected players), `auto_raid::gate()`, reachability and
//! charge checks, and `auto_defend`'s `rank(..) > 0` eligibility.
//!
//! ## Temperature 0 is exactly today's behaviour
//!
//! [`pick`] at `temperature == 0.0` returns the same index `max_by_key` would,
//! **including its tie rule** (Rust's `max_by_key` yields the LAST maximum).
//! That makes this a strict generalisation: the existing suite keeps asserting
//! something true, and `preset: off` is an instant revert.

use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::mcp::virtual_players::VPlayerRole;

/// How a bot behaves when it has a choice.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Temperament {
    /// 0.0 = argmax (today's behaviour). Higher flattens the distribution.
    ///
    /// Scores are normalised to 0..1 before sampling (see [`pick`]), so one
    /// temperature value means the same thing across loops whose raw scores
    /// live on different scales — `auto_defend::rank` runs to ~110,
    /// `auto_raid::score` to 100, expected damage to about 6.
    #[serde(default)]
    pub temperature: f64,
    /// Chance of ignoring the ranking entirely and taking a worse legal option.
    /// This is the "real mistake" dial: it costs hulls and ore.
    #[serde(default)]
    pub mistake_rate: f64,
    /// Lower bound of the pause before acting, milliseconds.
    #[serde(default)]
    pub hesitate_min_ms: u64,
    /// Upper bound of the pause before acting, milliseconds. A bot that always
    /// answers in the same number of milliseconds reads as a machine no matter
    /// how well it chooses.
    #[serde(default)]
    pub hesitate_max_ms: u64,
}

impl Default for Temperament {
    fn default() -> Self {
        // Inert: identical to the pre-variance code path.
        Self { temperature: 0.0, mistake_rate: 0.0, hesitate_min_ms: 0, hesitate_max_ms: 0 }
    }
}

impl Temperament {
    /// A pause to take before acting. Zero when unconfigured.
    pub fn hesitation(&self) -> std::time::Duration {
        let (lo, hi) = (self.hesitate_min_ms, self.hesitate_max_ms.max(self.hesitate_min_ms));
        if hi == 0 {
            return std::time::Duration::ZERO;
        }
        let span = hi.saturating_sub(lo);
        let extra = if span == 0 { 0 } else { rand::thread_rng().gen_range(0..=span) };
        std::time::Duration::from_millis(lo + extra)
    }
}

/// Index of the maximum, matching `Iterator::max_by_key`'s tie rule (last wins).
fn argmax_last(scores: &[f64]) -> usize {
    let mut best = 0usize;
    for (i, s) in scores.iter().enumerate() {
        if *s >= scores[best] {
            best = i;
        }
    }
    best
}

/// Choose an index from `items`, weighted by `score`.
///
/// Returns `None` only for an empty slice — the caller has already filtered to
/// legal options, so every index this can return is safe to act on.
pub fn pick<T, R: Rng + ?Sized>(
    items: &[T],
    score: impl Fn(&T) -> f64,
    t: &Temperament,
    rng: &mut R,
) -> Option<usize> {
    if items.is_empty() {
        return None;
    }
    let scores: Vec<f64> = items.iter().map(&score).collect();
    if items.len() == 1 {
        return Some(0);
    }
    if t.temperature <= 0.0 && t.mistake_rate <= 0.0 {
        return Some(argmax_last(&scores));
    }

    // A deliberate error: take a legal option that is NOT the best one. Bounded
    // by construction — the pool was filtered before it got here — but it does
    // cost something real, which is the point.
    if t.mistake_rate > 0.0 && rng.gen::<f64>() < t.mistake_rate {
        let best = argmax_last(&scores);
        let others: Vec<usize> = (0..items.len()).filter(|i| *i != best).collect();
        if !others.is_empty() {
            return Some(others[rng.gen_range(0..others.len())]);
        }
    }
    if t.temperature <= 0.0 {
        return Some(argmax_last(&scores));
    }

    // Normalise to 0..1 so `temperature` is scale-free across call sites.
    let lo = scores.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = hi - lo;
    let weights: Vec<f64> = if span <= f64::EPSILON {
        vec![1.0; scores.len()] // all equal — uniform
    } else {
        scores.iter().map(|s| (((s - lo) / span) / t.temperature).exp()).collect()
    };
    let total: f64 = weights.iter().sum();
    if !total.is_finite() || total <= 0.0 {
        return Some(argmax_last(&scores));
    }
    let mut roll = rng.gen::<f64>() * total;
    for (i, w) in weights.iter().enumerate() {
        roll -= w;
        if roll <= 0.0 {
            return Some(i);
        }
    }
    Some(argmax_last(&scores))
}

/// A deterministic RNG seeded from `key`, for choices that must be STABLE.
///
/// Some loops reconcile toward a declared state rather than taking a one-shot
/// action — `auto_defend` computes a desired defence web each scan and issues
/// the clear/set transactions needed to reach it. Sampling that per scan would
/// mean a different target every time and therefore permanent churn: the loop
/// could never converge, and every re-roll costs a charged transaction.
///
/// For those, variance belongs ACROSS PLAYERS, not across time — one player's
/// web differs from another's, but its own web settles. Seeding from the player
/// id gives exactly that. FNV-1a, matching the house style in `pfp.rs`.
pub fn seeded_rng(key: &str) -> rand::rngs::StdRng {
    use rand::SeedableRng;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    rand::rngs::StdRng::seed_from_u64(h)
}

/// [`pick`] against the thread RNG — the production entry point.
pub fn pick_now<T>(items: &[T], score: impl Fn(&T) -> f64, t: &Temperament) -> Option<usize> {
    pick(items, score, t, &mut rand::thread_rng())
}

// ── Config ───────────────────────────────────────────────────────────────────

/// Preset bundles, mirroring `auto_raid::RaidPosture` / `apply_posture`: the
/// preset rewrites every temperament, and explicit edits afterwards win until
/// the preset is set again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VariancePreset {
    /// Temperature 0 everywhere — the pre-variance code path, and the revert.
    Off,
    /// Visible variety, no deliberate errors.
    Measured,
    /// Mild temperature, occasional real mistakes, genuine hesitation.
    #[default]
    Human,
    /// Frequently wrong and hard to read.
    Wild,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarianceConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub preset: VariancePreset,
    /// Offensive and expendable: impulsive, quick, error-prone.
    #[serde(default)]
    pub raider: Temperament,
    /// Holds ore as a lure and fights defensively: patient, deliberate.
    #[serde(default)]
    pub bait: Temperament,
    /// Runs the economy. Kept coolest — chaotic mining and sweeping costs alpha
    /// and buys no unpredictability anyone can observe.
    #[serde(default)]
    pub productive: Temperament,
    /// The primary player. Off by default: it is the one account whose losses
    /// are not interchangeable.
    #[serde(default)]
    pub primary: Temperament,
}

fn default_true() -> bool {
    true
}

impl Default for VarianceConfig {
    fn default() -> Self {
        let mut c = Self {
            enabled: true,
            preset: VariancePreset::Human,
            raider: Temperament::default(),
            bait: Temperament::default(),
            productive: Temperament::default(),
            primary: Temperament::default(),
        };
        c.apply_preset(VariancePreset::Human);
        c
    }
}

impl VarianceConfig {
    /// Rewrite every temperament from a preset.
    pub fn apply_preset(&mut self, p: VariancePreset) {
        self.preset = p;
        // (temperature, mistake_rate, hesitate_min_ms, hesitate_max_ms)
        let (raider, bait, productive) = match p {
            VariancePreset::Off => {
                let z = (0.0, 0.0, 0, 0);
                (z, z, z)
            }
            VariancePreset::Measured => (
                (0.25, 0.00, 200, 1_200),
                (0.20, 0.00, 400, 2_000),
                (0.10, 0.00, 0, 0),
            ),
            VariancePreset::Human => (
                (0.40, 0.08, 300, 2_500),
                (0.30, 0.04, 800, 4_000),
                (0.15, 0.00, 0, 500),
            ),
            VariancePreset::Wild => (
                (0.80, 0.25, 100, 5_000),
                (0.65, 0.15, 500, 6_000),
                (0.30, 0.05, 0, 1_000),
            ),
        };
        let t = |(temperature, mistake_rate, hesitate_min_ms, hesitate_max_ms)| Temperament {
            temperature,
            mistake_rate,
            hesitate_min_ms,
            hesitate_max_ms,
        };
        self.raider = t(raider);
        self.bait = t(bait);
        self.productive = t(productive);
        // The primary is never swept up by a preset.
        self.primary = Temperament::default();
    }

    /// The temperament governing one player.
    pub fn for_role(&self, role: Option<VPlayerRole>) -> Temperament {
        if !self.enabled {
            return Temperament::default();
        }
        match role {
            Some(VPlayerRole::Raider) => self.raider,
            Some(VPlayerRole::Bait) => self.bait,
            Some(VPlayerRole::Productive) => self.productive,
            // `collect_targets` yields the primary with no role.
            None => self.primary,
        }
    }
}

const FILENAME: &str = "variance.json";

static CONFIG: std::sync::LazyLock<std::sync::RwLock<VarianceConfig>> =
    std::sync::LazyLock::new(|| {
        std::sync::RwLock::new(crate::mcp::config_store::load_config::<VarianceConfig>(FILENAME))
    });

pub fn get() -> VarianceConfig {
    CONFIG.read().map(|c| c.clone()).unwrap_or_default()
}

pub fn set(cfg: VarianceConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &cfg);
}

/// The temperament for one player's role, in one call.
pub fn for_role(role: Option<VPlayerRole>) -> Temperament {
    get().for_role(role)
}

#[cfg(test)]
pub fn set_for_test(cfg: VarianceConfig) {
    if let Ok(mut c) = CONFIG.write() {
        *c = cfg;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn seeded() -> StdRng {
        StdRng::seed_from_u64(0xC0FFEE)
    }

    /// THE contract. At temperature 0 with no mistakes this must return exactly
    /// what `max_by_key` returns — including the tie rule (last wins) — so the
    /// whole existing suite keeps asserting something true.
    #[test]
    fn temperature_zero_is_the_argmax_including_ties() {
        let items = [1.0f64, 5.0, 3.0];
        let t = Temperament::default();
        assert_eq!(pick(&items, |x| *x, &t, &mut seeded()), Some(1));

        // Ties: `Iterator::max_by_key` yields the LAST maximum.
        let tied = [5.0f64, 2.0, 5.0];
        let expect = tied
            .iter()
            .enumerate()
            .max_by_key(|(_, v)| (**v * 1000.0) as i64)
            .map(|(i, _)| i);
        assert_eq!(pick(&tied, |x| *x, &t, &mut seeded()), expect);
    }

    #[test]
    fn an_empty_pool_yields_nothing_and_a_single_option_is_forced() {
        let empty: [f64; 0] = [];
        assert_eq!(pick(&empty, |x| *x, &Temperament::default(), &mut seeded()), None);
        assert_eq!(pick(&[7.0], |x| *x, &Temperament::default(), &mut seeded()), Some(0));
    }

    /// Sampling must stay INSIDE the pool it was handed — the caller has
    /// already applied the hard filters, so every returned index is legal.
    #[test]
    fn every_draw_is_a_member_of_the_pool() {
        let items = [1.0f64, 2.0, 3.0, 4.0];
        let t = Temperament { temperature: 0.9, mistake_rate: 0.3, ..Default::default() };
        let mut rng = seeded();
        for _ in 0..500 {
            let i = pick(&items, |x| *x, &t, &mut rng).unwrap();
            assert!(i < items.len(), "sampler invented an index");
        }
    }

    /// Warmer is more varied, but the best option still wins most often — the
    /// bots should be unpredictable, not bad.
    #[test]
    fn the_best_option_still_dominates_at_mild_temperature() {
        let items = [1.0f64, 2.0, 10.0];
        let t = Temperament { temperature: 0.4, ..Default::default() };
        let mut rng = seeded();
        let mut best_hits = 0;
        for _ in 0..1000 {
            if pick(&items, |x| *x, &t, &mut rng) == Some(2) {
                best_hits += 1;
            }
        }
        assert!(best_hits > 600, "best chosen only {best_hits}/1000 at mild temperature");
        assert!(best_hits < 1000, "no variation at all — temperature did nothing");
    }

    #[test]
    fn a_hotter_temperament_explores_more() {
        let items = [1.0f64, 2.0, 10.0];
        let count = |temp: f64| {
            let t = Temperament { temperature: temp, ..Default::default() };
            let mut rng = seeded();
            (0..1000).filter(|_| pick(&items, |x| *x, &t, &mut rng) != Some(2)).count()
        };
        assert!(count(1.5) > count(0.3), "hotter must wander more");
    }

    /// The mistake dial takes a legal option that is NOT the best one.
    #[test]
    fn mistakes_choose_a_worse_but_legal_option() {
        let items = [1.0f64, 2.0, 10.0];
        let t = Temperament { temperature: 0.0, mistake_rate: 1.0, ..Default::default() };
        let mut rng = seeded();
        for _ in 0..200 {
            assert_ne!(pick(&items, |x| *x, &t, &mut rng), Some(2), "a certain mistake picked the best");
        }
    }

    /// Scores on wildly different scales must behave the same at one
    /// temperature — otherwise a single knob means three different things.
    #[test]
    fn temperature_is_scale_free() {
        let t = Temperament { temperature: 0.5, ..Default::default() };
        let small = [0.0f64, 0.5, 1.0];
        let large = [0.0f64, 50.0, 100.0];
        let explore = |items: &[f64]| {
            let mut rng = seeded();
            (0..1000).filter(|_| pick(items, |x| *x, &t, &mut rng) != Some(2)).count()
        };
        let (a, b) = (explore(&small), explore(&large));
        assert!((a as i64 - b as i64).abs() < 80, "scale changed behaviour: {a} vs {b}");
    }

    #[test]
    fn identical_scores_are_drawn_uniformly() {
        let items = [3.0f64; 4];
        let t = Temperament { temperature: 0.5, ..Default::default() };
        let mut rng = seeded();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            seen.insert(pick(&items, |x| *x, &t, &mut rng).unwrap());
        }
        assert_eq!(seen.len(), 4, "a flat distribution should reach every option");
    }

    /// Stable seeding: the same key must always produce the same sequence, and
    /// different keys must diverge. This is what lets a reconciling loop settle
    /// while still differing between players.
    #[test]
    fn a_seeded_choice_is_stable_per_key_and_varies_across_keys() {
        let items = [1.0f64, 2.0, 3.0, 4.0, 5.0];
        let t = Temperament { temperature: 1.0, ..Default::default() };
        let draw = |key: &str| {
            let mut r = seeded_rng(key);
            (0..8).map(|_| pick(&items, |x| *x, &t, &mut r).unwrap()).collect::<Vec<_>>()
        };
        assert_eq!(draw("1-2136"), draw("1-2136"), "same player must settle, not churn");
        assert_ne!(draw("1-2136"), draw("1-0271"), "different players should differ");
    }

    #[test]
    fn off_preset_restores_the_deterministic_path() {
        let mut c = VarianceConfig::default();
        c.apply_preset(VariancePreset::Off);
        for role in [VPlayerRole::Raider, VPlayerRole::Bait, VPlayerRole::Productive] {
            let t = c.for_role(Some(role));
            assert_eq!(t.temperature, 0.0);
            assert_eq!(t.mistake_rate, 0.0);
        }
    }

    #[test]
    fn disabling_overrides_every_preset() {
        let mut c = VarianceConfig::default();
        c.apply_preset(VariancePreset::Wild);
        c.enabled = false;
        assert_eq!(c.for_role(Some(VPlayerRole::Raider)), Temperament::default());
    }

    /// Role character: raiders are the loose ones, the economy is the tight one,
    /// and the primary is never swept up by a preset.
    #[test]
    fn presets_order_the_roles_by_temperament() {
        let mut c = VarianceConfig::default();
        c.apply_preset(VariancePreset::Human);
        assert!(c.raider.temperature > c.bait.temperature);
        assert!(c.bait.temperature > c.productive.temperature);
        assert!(c.raider.mistake_rate >= c.bait.mistake_rate);
        assert_eq!(c.productive.mistake_rate, 0.0, "economy variance costs alpha and buys nothing");
        assert_eq!(c.primary.temperature, 0.0, "the primary is not interchangeable");
    }

    #[test]
    fn presets_round_trip_through_json() {
        for p in [VariancePreset::Off, VariancePreset::Measured, VariancePreset::Human, VariancePreset::Wild] {
            let s = serde_json::to_string(&p).unwrap();
            assert_eq!(serde_json::from_str::<VariancePreset>(&s).unwrap(), p);
        }
    }

    /// The load-failure hazard: a config written before a field existed must
    /// still parse, or `load_config` falls back to Default and the loop
    /// silently disables itself (this cost ~24h of zero raids once already).
    #[test]
    fn an_older_config_without_the_new_fields_still_parses() {
        let old = serde_json::json!({ "enabled": true, "preset": "human" });
        let cfg: VarianceConfig = serde_json::from_value(old).expect("must tolerate missing fields");
        assert!(cfg.enabled);
        assert_eq!(cfg.preset, VariancePreset::Human);
        assert_eq!(cfg.raider.temperature, 0.0);
    }

    #[test]
    fn hesitation_is_zero_when_unconfigured() {
        assert_eq!(Temperament::default().hesitation(), std::time::Duration::ZERO);
        let t = Temperament { hesitate_min_ms: 100, hesitate_max_ms: 200, ..Default::default() };
        let d = t.hesitation().as_millis() as u64;
        assert!((100..=200).contains(&d), "hesitation {d} outside its band");
    }
}
