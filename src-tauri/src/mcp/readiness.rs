//! Raid readiness — can a player's own fleet actually answer a raid?
//!
//! WHY THIS EXISTS. On 2026-08-17 player 1-61 raided two of ours in a row.
//! `1-1035` ended its raid in **27 seconds** — one Cruiser shot, water → land,
//! and the raider left. `scout1` (1-271) held fire for **three minutes** and
//! never took a shot, because not one of its sixteen fleet hulls could reach the
//! raider's Command Ship. Both outcomes were produced by the same, correct,
//! `auto_response` code. The difference was entirely fleet composition.
//!
//! That difference is invisible until a raid is already underway, and by then it
//! is far too late to do anything about it: an occupied fleet slot can only be
//! freed by the hull being DESTROYED (there is no decommission, salvage or scrap
//! message on the chain), and `auto_build` only ever fills FREE slots. A fleet
//! that cannot reach an ambit today cannot be made to reach it on demand — the
//! only remedy is attrition, which takes as long as it takes.
//!
//! So the useful thing is to know BEFORE the raid. This module answers, per
//! player: *for each ambit a raider's Command Ship could occupy, can this
//! player's own fleet touch it?*
//!
//! AMBIT COVERAGE, NOT "CAN IT REACH LAND". The obvious first cut of this audit
//! asked only about land, because every Command Ship observed in combat happened
//! to be sitting in a land slot. That is a sampling artefact, not a rule — the
//! Command Ship type's `possible_ambit` is water|land|air|space, all four. A
//! raider who parks their Command Ship in space is untouchable by a fleet that
//! only reaches land, and an audit hard-coded to land would have called that
//! fleet READY. So the ambit set is READ FROM THE TYPE (see
//! [`command_ship_ambits`]) and never assumed.
//!
//! Reach is the union of a hull's PRIMARY and SECONDARY weapon masks: a Cruiser
//! earns its slot on its secondary, and judging it by the primary alone would
//! under-report the fleet.

use std::collections::BTreeMap;

use crate::mcp::combat::WeaponStats;
use crate::mcp::tools::format::decode_ambits;

/// Every ambit, as a bitmask (Water=2, Land=4, Air=8, Space=16). The fallback
/// when the Command Ship type has not synced yet — deliberately the WIDEST set,
/// so an unsynced catalog reports gaps we might not have rather than a clean
/// bill of health we have not earned.
pub const ALL_AMBITS: u64 = 2 | 4 | 8 | 16;

/// Ambits in a stable, readable order (surface → orbit).
const AMBIT_ORDER: [(&str, u64); 4] = [("water", 2), ("land", 4), ("air", 8), ("space", 16)];

/// How safely a hull can engage a target in a given ambit.
///
/// REACH IS NOT ENOUGH, and this enum is the whole reason the audit exists in
/// its current form. On 2026-08-17 `scout1` could reach a land Command Ship
/// perfectly well — it had three Tanks. Every one of those shots was refused as
/// suicidal, because a Tank standing in LAND attacking a target in LAND eats
/// the full counter (2 from the Command Ship plus its defenders) against 3 HP.
/// Meanwhile `1-1035` ended its raid in 27 seconds with a single Cruiser firing
/// from WATER into land — cross-ambit, so every counter is halved, and its
/// 3 HP hull walked away.
///
/// An audit that asked only "can you reach it?" would have graded scout1 READY.
/// Ordered best-first: `Immune` > `CrossAmbit` > `SameAmbit` > `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Posture {
    /// A counter-immune weapon reaches it (Mobile Artillery). Grinds for free.
    Immune,
    /// A hull standing in a DIFFERENT ambit reaches it — counters are halved.
    CrossAmbit,
    /// Only hulls standing in the SAME ambit reach it — full counter value.
    /// This is the scout1 trap: reachable on paper, refused in practice.
    SameAmbit,
    /// Nothing reaches it at all.
    None,
}

impl Posture {
    pub fn as_str(self) -> &'static str {
        match self {
            Posture::Immune => "counter-immune",
            Posture::CrossAmbit => "cross-ambit",
            Posture::SameAmbit => "same-ambit only",
            Posture::None => "unreachable",
        }
    }
    /// Is this a shot we would actually expect to take? `SameAmbit` is where
    /// the suicidal-shot gate holds fire, so it does not count as an answer.
    pub fn is_viable(self) -> bool {
        matches!(self, Posture::Immune | Posture::CrossAmbit)
    }
}

/// One combat hull in a player's own fleet, reduced to what readiness needs.
#[derive(Debug, Clone)]
pub struct Hull {
    pub struct_id: String,
    pub type_name: String,
    /// Union of primary and secondary weapon reach masks.
    pub reach: u64,
    /// The ambit this hull STANDS in — decides same- vs cross-ambit counters.
    pub operating_ambit: u64,
    /// True when at least one reaching weapon cannot be countered at all
    /// (Mobile Artillery). The safe instrument against a defended target.
    pub counter_immune: bool,
}

impl Hull {
    /// How safely this hull can engage a target sitting in `target_bit`.
    pub fn posture_against(&self, target_bit: u64) -> Posture {
        if self.reach & target_bit == 0 {
            return Posture::None;
        }
        if self.counter_immune {
            return Posture::Immune;
        }
        if self.operating_ambit != 0 && self.operating_ambit == target_bit {
            Posture::SameAmbit
        } else {
            Posture::CrossAmbit
        }
    }

    /// Build from a synced struct type. Returns `None` for non-combat structs
    /// (both weapon masks empty) — an Ore Bunker is not a readiness answer.
    pub fn from_type(
        struct_id: impl Into<String>,
        operating_ambit: u64,
        t: &crate::game_state::StructTypeInfo,
    ) -> Option<Self> {
        let prim = WeaponStats::from_type(t, false);
        let sec = WeaponStats::from_type(t, true);
        let reach = prim.ambits | sec.ambits;
        if reach == 0 {
            return None;
        }
        // Counter-immunity is per WEAPON, and only counts for a weapon that
        // actually reaches something: an immune weapon with an empty mask is
        // not an option we can ever take.
        let counter_immune = (prim.ambits != 0 && !prim.counterable)
            || (sec.ambits != 0 && !sec.counterable);
        Some(Hull {
            struct_id: struct_id.into(),
            type_name: t.name.clone(),
            reach,
            operating_ambit,
            counter_immune,
        })
    }
}

/// What the fleet can do about one ambit.
#[derive(Debug, Clone, PartialEq)]
pub struct AmbitCoverage {
    pub ambit: &'static str,
    /// The best posture any hull achieves against this ambit.
    pub posture: Posture,
    /// The hull achieving `posture`, as "id (Type, from <ambit>)".
    pub best: Option<String>,
    /// How many hulls reach the ambit at all, viable or not.
    pub reaching: usize,
}

impl AmbitCoverage {
    /// A shot we would actually take. `SameAmbit` reach is NOT an answer — that
    /// is precisely what the suicidal-shot gate refuses.
    pub fn answered(&self) -> bool {
        self.posture.is_viable()
    }
}

/// Overall verdict for one player.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Can reach every ambit a Command Ship could occupy.
    Ready,
    /// Can reach some but not all — a raider who parks in a blind ambit is safe.
    Partial,
    /// Cannot reach ANY of them. This player can never answer a raid on its own,
    /// however good the targeting code is. `scout1` on 2026-08-17.
    Blind,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Ready => "READY",
            Verdict::Partial => "PARTIAL",
            Verdict::Blind => "BLIND",
        }
    }
}

/// The audit result for one player.
#[derive(Debug, Clone)]
pub struct Readiness {
    pub verdict: Verdict,
    pub per_ambit: Vec<AmbitCoverage>,
    /// Ambits a Command Ship could sit in that we cannot touch.
    pub blind_mask: u64,
    /// True when the player's fleet is on station at its own planet. A fleet
    /// that is AWAY leaves the planet raidable no matter how well armed it is —
    /// verified live on 2-7324, where `blockStartRaid` armed on the arrival
    /// block with the owner's Command Ship alive and undamaged.
    pub fleet_home: bool,
    pub hull_count: usize,
}

impl Readiness {
    /// One-line summary for a list view.
    pub fn summary(&self) -> String {
        let mut s = format!("{} — {} combat hull(s)", self.verdict.as_str(), self.hull_count);
        if self.blind_mask != 0 {
            s.push_str(&format!(", no viable shot into [{}]", decode_ambits(self.blind_mask)));
        }
        if !self.fleet_home {
            s.push_str(", FLEET AWAY (planet raidable)");
        }
        s
    }
}

/// Which ambits can a Command Ship actually occupy?
///
/// Read from the synced type catalog rather than assumed — the whole point of
/// this audit is that a raider may park their Command Ship anywhere. Falls back
/// to [`ALL_AMBITS`] when the catalog has not synced, which over-reports gaps
/// rather than under-reporting them.
pub fn command_ship_ambits() -> u64 {
    let Ok(gs) = crate::game_state::GAME_STATE.read() else {
        return ALL_AMBITS;
    };
    gs.struct_types
        .values()
        .find(|t| t.name.eq_ignore_ascii_case("Command Ship"))
        .and_then(|t| t.possible_ambit)
        .filter(|m| *m != 0)
        .unwrap_or(ALL_AMBITS)
}

/// Assess one fleet against the ambits a Command Ship could occupy.
///
/// Pure: no network, no globals. `cmd_ambits` is passed in so the caller reads
/// it once for a whole roster sweep, and so tests can pin it.
pub fn assess(hulls: &[Hull], cmd_ambits: u64, fleet_home: bool) -> Readiness {
    let mut per_ambit = Vec::new();
    let mut blind_mask = 0u64;
    let mut covered_any = false;

    for (name, bit) in AMBIT_ORDER {
        if cmd_ambits & bit == 0 {
            continue; // a Command Ship can never be here — not a gap
        }
        // Best posture wins. `Posture` is ordered best-first, so the minimum is
        // the strongest option: counter-immune, else cross-ambit, else the
        // same-ambit shot we would refuse anyway.
        let best_hull = hulls
            .iter()
            .filter(|h| h.reach & bit != 0)
            .min_by_key(|h| (h.posture_against(bit), h.struct_id.clone()));
        let reaching = hulls.iter().filter(|h| h.reach & bit != 0).count();
        let posture = best_hull.map(|h| h.posture_against(bit)).unwrap_or(Posture::None);

        if posture.is_viable() {
            covered_any = true;
        } else {
            // Unreachable AND same-ambit-only both count as gaps: the second is
            // reachable on paper and refused in practice, which is the failure
            // this audit was built to make visible.
            blind_mask |= bit;
        }
        per_ambit.push(AmbitCoverage {
            ambit: name,
            posture,
            best: best_hull.map(|h| {
                format!(
                    "{} ({}, from {})",
                    h.struct_id,
                    h.type_name,
                    decode_ambits(h.operating_ambit)
                )
            }),
            reaching,
        });
    }

    let verdict = if blind_mask == 0 {
        Verdict::Ready
    } else if covered_any {
        Verdict::Partial
    } else {
        Verdict::Blind
    };

    Readiness {
        verdict,
        per_ambit,
        blind_mask,
        fleet_home,
        hull_count: hulls.len(),
    }
}

/// Roll a set of per-player verdicts into counts, for a fleet-wide headline.
pub fn tally<'a>(rows: impl Iterator<Item = &'a Readiness>) -> BTreeMap<&'static str, usize> {
    let mut out = BTreeMap::new();
    for r in rows {
        *out.entry(r.verdict.as_str()).or_insert(0) += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const WATER: u64 = 2;
    const LAND: u64 = 4;
    const AIR: u64 = 8;
    const SPACE: u64 = 16;

    /// `stands` is the ambit the hull occupies, `reach` what its weapons hit.
    fn hull(id: &str, name: &str, stands: u64, reach: u64, immune: bool) -> Hull {
        Hull {
            struct_id: id.into(),
            type_name: name.into(),
            reach,
            operating_ambit: stands,
            counter_immune: immune,
        }
    }

    /// THE regression. scout1 (1-271) on 2026-08-17: three Tanks standing in
    /// land, reaching land. It could reach the raider's land Command Ship all
    /// day — and `auto_response` refused every shot as suicidal, because a
    /// same-ambit attack eats the full counter. Three minutes, zero shots.
    ///
    /// A reach-only audit grades this READY. It must not.
    #[test]
    fn same_ambit_only_reach_is_not_an_answer() {
        let hulls = vec![
            hull("5-53584", "Tank", LAND, LAND, false),
            hull("5-31174", "Tank", LAND, LAND, false),
        ];
        let r = assess(&hulls, LAND, true);
        assert_eq!(r.per_ambit[0].posture, Posture::SameAmbit);
        assert!(!r.per_ambit[0].answered(), "a shot we would refuse is not an answer");
        assert_eq!(r.verdict, Verdict::Blind);
        assert_eq!(r.per_ambit[0].reaching, 2, "still reports that they DO reach");
    }

    /// The other half of the same day: 1-1035's Cruiser stands in water and
    /// reaches land. Cross-ambit halves every counter, the 3 HP hull survives,
    /// and the raid ended in 27 seconds.
    #[test]
    fn cross_ambit_reach_is_a_real_answer() {
        let hulls = vec![hull("5-96724", "Cruiser", WATER, WATER | LAND, false)];
        let r = assess(&hulls, LAND, true);
        assert_eq!(r.per_ambit[0].posture, Posture::CrossAmbit);
        assert_eq!(r.verdict, Verdict::Ready);
        assert!(r.per_ambit[0].best.as_ref().unwrap().contains("from water"));
    }

    /// Counter-immune beats cross-ambit and must be offered even when it stands
    /// in the target's own ambit — Mobile Artillery pays nothing either way.
    #[test]
    fn counter_immune_outranks_cross_ambit_and_ignores_its_own_ambit() {
        let hulls = vec![
            hull("5-9", "Cruiser", WATER, LAND, false),
            hull("5-1", "Mobile Artillery", LAND, LAND, true),
        ];
        let r = assess(&hulls, LAND, true);
        assert_eq!(r.per_ambit[0].posture, Posture::Immune);
        assert!(r.per_ambit[0].best.as_ref().unwrap().contains("Mobile Artillery"));
    }

    /// A Command Ship can sit in ANY of the four ambits. A fleet that answers
    /// land but nothing else is Partial — a raider who parks in space is safe.
    #[test]
    fn covering_one_ambit_is_partial_not_ready() {
        let hulls = vec![hull("5-1", "Cruiser", WATER, LAND, false)];
        let r = assess(&hulls, ALL_AMBITS, true);
        assert_eq!(r.verdict, Verdict::Partial);
        assert_eq!(r.blind_mask, WATER | AIR | SPACE);
        assert!(r.summary().contains("no viable shot into [water, air, space]"));
    }

    #[test]
    fn a_fleet_answering_every_ambit_is_ready() {
        let hulls = vec![
            hull("5-1", "Cruiser", WATER, LAND, false),
            hull("5-2", "Frigate", SPACE, AIR | WATER, false),
            hull("5-3", "Stealth Bomber", AIR, SPACE, false),
        ];
        let r = assess(&hulls, ALL_AMBITS, true);
        assert_eq!(r.verdict, Verdict::Ready, "{}", r.summary());
        assert_eq!(r.blind_mask, 0);
    }

    #[test]
    fn a_fleet_reaching_nothing_is_blind() {
        let hulls = vec![hull("5-1", "Starfighter", SPACE, 0, false)];
        let r = assess(&hulls, ALL_AMBITS, true);
        assert_eq!(r.verdict, Verdict::Blind);
        assert_eq!(r.blind_mask, ALL_AMBITS);
        assert_eq!(r.per_ambit[0].posture, Posture::None);
    }

    /// Ambits a Command Ship cannot occupy are not gaps. If the type ever
    /// narrows, the audit must narrow with it rather than invent blind spots.
    #[test]
    fn ambits_a_command_ship_cannot_occupy_are_not_counted_as_gaps() {
        let hulls = vec![hull("5-1", "Cruiser", WATER, LAND, false)];
        let r = assess(&hulls, LAND, true);
        assert_eq!(r.verdict, Verdict::Ready);
        assert_eq!(r.per_ambit.len(), 1, "only the land row is assessed");
    }

    /// An armed fleet sitting somewhere else is not a defence — the planet is
    /// raidable while it is away, so the summary has to say so.
    #[test]
    fn an_away_fleet_is_called_out_even_when_ready() {
        let hulls = vec![hull("5-1", "Cruiser", WATER, LAND, false)];
        let r = assess(&hulls, LAND, false);
        assert_eq!(r.verdict, Verdict::Ready);
        assert!(r.summary().contains("FLEET AWAY"));
    }

    #[test]
    fn tally_counts_verdicts() {
        // Two hulls, because one hull can never answer its OWN ambit viably:
        // standing in water and shooting into water is a same-ambit shot.
        let ready = assess(
            &[
                hull("5-1", "Cruiser", WATER, ALL_AMBITS, false),
                hull("5-2", "Frigate", SPACE, ALL_AMBITS, false),
            ],
            ALL_AMBITS,
            true,
        );
        let blind = assess(&[], ALL_AMBITS, true);
        let t = tally([&ready, &blind].into_iter());
        assert_eq!(t.get("READY"), Some(&1));
        assert_eq!(t.get("BLIND"), Some(&1));
    }

    /// An empty fleet is blind, not "ready by vacuous truth".
    #[test]
    fn no_hulls_at_all_is_blind() {
        let r = assess(&[], ALL_AMBITS, true);
        assert_eq!(r.verdict, Verdict::Blind);
        assert_eq!(r.hull_count, 0);
    }
}
