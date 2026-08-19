//! Player-authored behaviour profiles.
//!
//! WHY THIS EXISTS. `bait` / `productive` / `raider` were hardcoded in ~44
//! places and decided what a vplayer builds, whether it refines, whether it
//! raids, how it defends, how much it varies and what it looks like. A player
//! could not express any strategy the three roles did not already encode.
//!
//! Measured before building: **32 of those 44 sites were already static data**
//! — the three loadout tables, the per-role temperament table, the avatar
//! config. Only 12 were control flow, and 10 of those reduce to five boolean
//! capabilities. So a profile is a DATA DOCUMENT, not a script.
//!
//! ## Why not a scripting language
//!
//! The variation space is small and enumerable, the loadouts are already
//! tables, and this code signs real transactions with real keys. A sandbox,
//! error model, versioning story and debugger would buy nothing that validated
//! data does not already cover, and a malformed document is containable in a
//! way a runaway script is not.
//!
//! ## Shape borrowed from `callsign::Style`
//!
//! Built-ins and user variants are the SAME struct, so every code path —
//! validate, preview, resolve — works identically on both. [`validate`] is a
//! pure function with a test asserting the shipped built-ins pass the same gate
//! as user input. [`set`] validates before mutating and before persisting, so a
//! rejection leaves prior state untouched. [`find`] is total: an unknown id
//! resolves to a built-in rather than failing.
//!
//! ## What a profile may NOT do
//!
//! Capabilities only ever turn a behaviour OFF. They never grant a new one, and
//! they cannot reach the safety layer: `combat_lists::is_vetoed`,
//! `auto_raid::gate()`, reachability and charge checks and `auto_defend`'s
//! eligibility rank stay in code. `ONE_PER_PLAYER` and `SLOTS_PER_AMBIT` are
//! chain facts, so a profile that "wants" six land slots is invalid, not
//! powerful. The moment a profile can express something the built-ins cannot
//! DO, this has become the scripting language we chose not to build.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use crate::mcp::auto_build::{
    ONE_PER_PLAYER, PRODUCTIVE_LOADOUT, RAIDER_LOADOUT, SLOTS_PER_AMBIT,
};
use crate::mcp::variance::Temperament;
use crate::mcp::virtual_players::VPlayerRole;

/// Bumped only when a change would make an older exported profile unreadable.
pub const SCHEMA: u32 = 1;

const FILENAME: &str = "profiles.json";

const TARGETS: &[&str] = &["planet", "fleet"];
const AMBITS: &[&str] = &["land", "water", "air", "space"];

/// What a profile is allowed to switch off.
///
/// Every field defaults to the SAFEST reading rather than the most permissive,
/// so a truncated or hand-written document cannot accidentally grant offensive
/// behaviour: `raids` defaults false, defensive/economic reading defaults true.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// Fly out and raid other players. Replaces `role == Raider` in auto_raid.
    #[serde(default)]
    pub raids: bool,
    /// Run refineries. Bait deliberately does not — its ore pile is the lure.
    #[serde(default = "yes")]
    pub refines: bool,
    /// Explore only once the planet AND the stored pile are drained. Workers
    /// wait; bait re-planets as soon as the crust is empty.
    #[serde(default)]
    pub explore_when_drained_only: bool,
    /// Sweep Alpha to the primary.
    #[serde(default = "yes")]
    pub sweeps_alpha: bool,
    /// Maintain a defence web.
    #[serde(default = "yes")]
    pub auto_defends: bool,
}

fn yes() -> bool {
    true
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            raids: false,
            refines: true,
            explore_when_drained_only: false,
            sweeps_alpha: true,
            auto_defends: true,
        }
    }
}

/// One row of a build priority list: "keep `want` of `type_name` in this
/// (target, ambit)". Position in the list is priority — see [`Profile::loadout`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoadoutEntry {
    /// "planet" or "fleet".
    pub target: String,
    /// "land" | "water" | "air" | "space".
    pub ambit: String,
    pub type_name: String,
    /// TOTAL kept in that (target, ambit) key, not an increment.
    pub want: usize,
}

impl LoadoutEntry {
    pub(crate) fn from_tuple((target, ambit, type_name, want): &(&str, &str, &str, usize)) -> Self {
        Self {
            target: target.to_string(),
            ambit: ambit.to_string(),
            type_name: type_name.to_string(),
            want: *want,
        }
    }
}

/// A profile's own working range for its temperament.
///
/// These are BALANCE knobs, not a safety boundary — temperature 8 is only
/// "more random", and nothing a profile does with them can reach past the hard
/// gates (`is_vetoed`, `gate()`, reachability, charge). So each profile
/// declares its own range instead of inheriting one global rule: a deliberately
/// chaotic archetype can allow a hotter temperature than the shipped presets
/// use, and a disciplined one can cap itself far tighter than the default to
/// make an accidental edit impossible.
///
/// The absolute ceilings below exist only to keep the softmax finite and to
/// keep a probability a probability; they are arithmetic, not policy.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TemperamentLimits {
    #[serde(default = "default_temperature_max")]
    pub temperature_max: f64,
    #[serde(default = "default_mistake_rate_max")]
    pub mistake_rate_max: f64,
}

/// Past this the softmax weights are indistinguishable from uniform noise and
/// `exp()` starts losing precision.
pub const TEMPERATURE_CEILING: f64 = 100.0;

fn default_temperature_max() -> f64 {
    5.0
}
fn default_mistake_rate_max() -> f64 {
    1.0
}

impl Default for TemperamentLimits {
    fn default() -> Self {
        Self { temperature_max: default_temperature_max(), mistake_rate_max: default_mistake_rate_max() }
    }
}

/// Optional avatar layer overrides. `None` keeps the role's existing look.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AvatarLayers {
    #[serde(default)]
    pub head: Option<u32>,
    #[serde(default)]
    pub neck: Option<u32>,
    #[serde(default)]
    pub body: Option<u32>,
    #[serde(default)]
    pub arms: Option<u32>,
    #[serde(default)]
    pub background: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub label: String,
    #[serde(default = "current_schema")]
    pub schema: u32,
    #[serde(default)]
    pub capabilities: Capabilities,
    /// ORDER IS PRIORITY. Fleet slots free one at a time through combat loss,
    /// so the head of this list is what a rebuilding fleet actually receives —
    /// possibly for months. Getting the order wrong is expensive and slow to
    /// undo, which is why the editor previews coverage before committing.
    #[serde(default)]
    pub loadout: Vec<LoadoutEntry>,
    #[serde(default)]
    pub temperament: Temperament,
    /// This profile's own working range for `temperament`. Set independently
    /// per profile — see [`TemperamentLimits`].
    #[serde(default)]
    pub limits: TemperamentLimits,
    #[serde(default)]
    pub avatar: Option<AvatarLayers>,
}

fn current_schema() -> u32 {
    SCHEMA
}

/// The shipped profiles, derived from the SAME const tables the loops used
/// before profiles existed — not transcribed, so they cannot drift.
pub static BUILTIN: LazyLock<Vec<Profile>> = LazyLock::new(|| {
    let mut v = crate::mcp::variance::VarianceConfig::default();
    v.apply_preset(crate::mcp::variance::VariancePreset::Human);
    vec![
        Profile {
            id: "bait".into(),
            label: "Bait — mines and holds ore as a lure".into(),
            schema: SCHEMA,
            capabilities: Capabilities {
                raids: false,
                // The pile IS the point; refining it away removes the lure.
                refines: false,
                explore_when_drained_only: false,
                sweeps_alpha: false,
                auto_defends: true,
            },
            loadout: crate::mcp::auto_build::LOADOUT
                .iter()
                .map(LoadoutEntry::from_tuple)
                .collect(),
            temperament: v.bait,
            limits: TemperamentLimits::default(),
            avatar: None,
        },
        Profile {
            id: "productive".into(),
            label: "Productive — runs the mine → refine → sweep flywheel".into(),
            schema: SCHEMA,
            capabilities: Capabilities {
                raids: false,
                refines: true,
                explore_when_drained_only: true,
                sweeps_alpha: true,
                auto_defends: true,
            },
            loadout: PRODUCTIVE_LOADOUT.iter().map(LoadoutEntry::from_tuple).collect(),
            temperament: v.productive,
            limits: TemperamentLimits::default(),
            avatar: None,
        },
        Profile {
            id: "raider".into(),
            label: "Raider — expendable offensive arm".into(),
            schema: SCHEMA,
            capabilities: Capabilities {
                raids: true,
                refines: true,
                explore_when_drained_only: true,
                sweeps_alpha: false,
                auto_defends: true,
            },
            loadout: RAIDER_LOADOUT.iter().map(LoadoutEntry::from_tuple).collect(),
            temperament: v.raider,
            limits: TemperamentLimits::default(),
            avatar: None,
        },
    ]
});

/// Deep-validate a profile. Pure, so tests can drive it and so [`set`] can
/// reject BEFORE touching stored state.
///
/// Every message names the offending value and the limit it broke — the house
/// style set by `callsign::validate`.
pub fn validate(p: &Profile) -> Result<(), String> {
    if p.id.trim().is_empty() {
        return Err("a profile needs an id".into());
    }
    if !p.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!(
            "id '{}' must be letters, digits, '-' or '_' only",
            p.id
        ));
    }
    if p.label.trim().is_empty() {
        return Err(format!("profile '{}' needs a label", p.id));
    }
    if p.schema > SCHEMA {
        return Err(format!(
            "profile '{}' is schema {} but this build understands up to {} — update the app",
            p.id, p.schema, SCHEMA
        ));
    }
    if p.loadout.is_empty() {
        return Err(format!("profile '{}' has an empty loadout — it would build nothing", p.id));
    }

    // Per-(target, ambit) totals, checked against the CHAIN's slot count. A
    // profile cannot buy more slots by asking for them.
    let mut totals: HashMap<(&str, &str), usize> = HashMap::new();
    for e in &p.loadout {
        if !TARGETS.contains(&e.target.as_str()) {
            return Err(format!(
                "profile '{}': target '{}' must be one of {:?}",
                p.id, e.target, TARGETS
            ));
        }
        if !AMBITS.contains(&e.ambit.as_str()) {
            return Err(format!(
                "profile '{}': ambit '{}' must be one of {:?}",
                p.id, e.ambit, AMBITS
            ));
        }
        if e.type_name.trim().is_empty() {
            return Err(format!("profile '{}': a loadout row has no struct type", p.id));
        }
        if e.want == 0 {
            return Err(format!(
                "profile '{}': '{}' wants 0 — remove the row instead",
                p.id, e.type_name
            ));
        }
        if ONE_PER_PLAYER.contains(&e.type_name.as_str()) && e.want > 1 {
            return Err(format!(
                "profile '{}': the chain allows only ONE {} per player, not {}",
                p.id, e.type_name, e.want
            ));
        }
        *totals.entry((e.target.as_str(), e.ambit.as_str())).or_insert(0) += e.want;
    }
    for ((target, ambit), n) in totals {
        if n > SLOTS_PER_AMBIT {
            return Err(format!(
                "profile '{}': {target}/{ambit} wants {n} structs but only {SLOTS_PER_AMBIT} slots exist",
                p.id
            ));
        }
    }

    // The profile's own declared range, then the arithmetic ceilings.
    if !(0.0..=TEMPERATURE_CEILING).contains(&p.limits.temperature_max) {
        return Err(format!(
            "profile '{}': temperature_max {} is outside 0..{TEMPERATURE_CEILING} (beyond that the \
             weighting is indistinguishable from uniform noise)",
            p.id, p.limits.temperature_max
        ));
    }
    if !(0.0..=1.0).contains(&p.limits.mistake_rate_max) {
        return Err(format!(
            "profile '{}': mistake_rate_max {} is outside 0..1 — it is a probability",
            p.id, p.limits.mistake_rate_max
        ));
    }
    if !(0.0..=p.limits.temperature_max).contains(&p.temperament.temperature) {
        return Err(format!(
            "profile '{}': temperature {} is outside this profile's range 0..{}",
            p.id, p.temperament.temperature, p.limits.temperature_max
        ));
    }
    if !(0.0..=p.limits.mistake_rate_max).contains(&p.temperament.mistake_rate) {
        return Err(format!(
            "profile '{}': mistake_rate {} is outside this profile's range 0..{}",
            p.id, p.temperament.mistake_rate, p.limits.mistake_rate_max
        ));
    }
    if p.temperament.hesitate_min_ms > p.temperament.hesitate_max_ms
        && p.temperament.hesitate_max_ms != 0
    {
        return Err(format!(
            "profile '{}': hesitate_min_ms {} exceeds hesitate_max_ms {}",
            p.id, p.temperament.hesitate_min_ms, p.temperament.hesitate_max_ms
        ));
    }
    Ok(())
}

/// Struct type names in a profile that the synced catalog does not know.
///
/// Deliberately NOT part of [`validate`]: the catalog is cold on a fresh start,
/// and rejecting a good profile because the app has not synced yet would be a
/// worse failure than building nothing for one scan. Surfaced as a warning.
pub fn unknown_types(p: &Profile) -> Vec<String> {
    let Ok(gs) = crate::game_state::GAME_STATE.read() else {
        return Vec::new();
    };
    if gs.struct_types.is_empty() {
        return Vec::new(); // catalog not synced — cannot judge
    }
    p.loadout
        .iter()
        .filter(|e| {
            !gs.struct_types
                .values()
                .any(|t| t.name.eq_ignore_ascii_case(&e.type_name))
        })
        .map(|e| e.type_name.clone())
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileStore {
    /// id → profile. User-authored only; built-ins are code.
    #[serde(default)]
    pub custom: HashMap<String, Profile>,
}

static STORE: LazyLock<RwLock<ProfileStore>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config::<ProfileStore>(FILENAME)));

pub fn store() -> ProfileStore {
    STORE.read().map(|s| s.clone()).unwrap_or_default()
}

/// Resolve an id to a profile. TOTAL — an unknown or malformed id falls back to
/// a built-in rather than failing, because the alternative is a loop that
/// silently stops acting.
pub fn find(id: &str) -> Profile {
    if let Ok(s) = STORE.read() {
        if let Some(p) = s.custom.get(id) {
            return p.clone();
        }
    }
    BUILTIN
        .iter()
        .find(|p| p.id == id)
        .or_else(|| BUILTIN.first())
        .cloned()
        .unwrap_or_else(|| Profile {
            id: "bait".into(),
            label: "Bait".into(),
            schema: SCHEMA,
            capabilities: Capabilities::default(),
            loadout: Vec::new(),
            temperament: Temperament::default(),
            limits: TemperamentLimits::default(),
            avatar: None,
        })
}

/// The profile governing a player: its explicit assignment when it has one,
/// otherwise the built-in named by its legacy role. Zero-migration by design.
pub fn for_player(profile_id: Option<&str>, role: Option<VPlayerRole>) -> Profile {
    match profile_id {
        Some(id) if !id.is_empty() => find(id),
        _ => find(role.unwrap_or_default().as_str()),
    }
}

/// Every profile the operator can choose, built-ins first.
pub fn list() -> Vec<Profile> {
    let mut out: Vec<Profile> = BUILTIN.clone();
    let s = store();
    let mut custom: Vec<Profile> = s.custom.into_values().collect();
    custom.sort_by(|a, b| a.id.cmp(&b.id));
    out.extend(custom);
    out
}

/// Register or replace a user profile. Validates BEFORE mutating and before
/// persisting, so a rejection leaves the stored set untouched.
pub fn set(p: Profile) -> Result<Profile, String> {
    validate(&p)?;
    if BUILTIN.iter().any(|b| b.id == p.id) {
        return Err(format!(
            "'{}' is a built-in profile — fork it under a new id instead of shadowing it",
            p.id
        ));
    }
    let mut s = store();
    s.custom.insert(p.id.clone(), p.clone());
    if let Ok(mut w) = STORE.write() {
        *w = s.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &s);
    Ok(p)
}

pub fn remove(id: &str) -> Result<(), String> {
    if BUILTIN.iter().any(|b| b.id == id) {
        return Err(format!("'{id}' is a built-in profile and cannot be deleted"));
    }
    let mut s = store();
    if s.custom.remove(id).is_none() {
        return Err(format!("no profile '{id}'"));
    }
    if let Ok(mut w) = STORE.write() {
        *w = s.clone();
    }
    crate::mcp::config_store::save_config(FILENAME, &s);
    Ok(())
}

#[cfg(test)]
pub fn set_for_test(s: ProfileStore) {
    if let Ok(mut w) = STORE.write() {
        *w = s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped profiles must pass exactly the gate user input passes —
    /// otherwise the built-ins are privileged and the validator is untested
    /// against anything real.
    #[test]
    fn every_builtin_profile_is_valid() {
        for p in BUILTIN.iter() {
            validate(p).unwrap_or_else(|e| panic!("built-in '{}' is invalid: {e}", p.id));
        }
    }

    /// Built-ins must reproduce the const tables the loops used before profiles
    /// existed, so switching auto_build over provably changes nothing.
    #[test]
    fn builtins_reproduce_the_original_loadout_tables() {
        let cases: [(&str, &[(&str, &str, &str, usize)]); 3] = [
            ("bait", crate::mcp::auto_build::LOADOUT),
            ("productive", PRODUCTIVE_LOADOUT),
            ("raider", RAIDER_LOADOUT),
        ];
        for (id, table) in cases {
            let p = find(id);
            assert_eq!(p.loadout.len(), table.len(), "{id} row count drifted");
            for (row, t) in p.loadout.iter().zip(table.iter()) {
                assert_eq!((row.target.as_str(), row.ambit.as_str(), row.type_name.as_str(), row.want),
                           (t.0, t.1, t.2, t.3), "{id} row drifted");
            }
        }
    }

    fn sample() -> Profile {
        Profile {
            id: "vulture".into(),
            label: "Vulture".into(),
            schema: SCHEMA,
            capabilities: Capabilities::default(),
            loadout: vec![LoadoutEntry {
                target: "fleet".into(),
                ambit: "land".into(),
                type_name: "Mobile Artillery".into(),
                want: 1,
            }],
            temperament: Temperament::default(),
            limits: TemperamentLimits::default(),
            avatar: None,
        }
    }

    #[test]
    fn a_profile_cannot_ask_for_more_slots_than_the_chain_has() {
        let mut p = sample();
        p.loadout[0].want = SLOTS_PER_AMBIT + 1;
        let e = validate(&p).unwrap_err();
        assert!(e.contains("slots exist"), "{e}");
    }

    #[test]
    fn a_profile_cannot_duplicate_a_one_per_player_struct() {
        let mut p = sample();
        p.loadout[0].type_name = "Command Ship".into();
        p.loadout[0].want = 2;
        let e = validate(&p).unwrap_err();
        assert!(e.contains("only ONE"), "{e}");
    }

    #[test]
    fn bad_targets_and_ambits_are_named_in_the_error() {
        let mut p = sample();
        p.loadout[0].ambit = "orbit".into();
        assert!(validate(&p).unwrap_err().contains("orbit"));
        let mut p2 = sample();
        p2.loadout[0].target = "moon".into();
        assert!(validate(&p2).unwrap_err().contains("moon"));
    }

    #[test]
    fn an_empty_loadout_is_rejected_rather_than_silently_building_nothing() {
        let mut p = sample();
        p.loadout.clear();
        assert!(validate(&p).unwrap_err().contains("empty loadout"));
    }

    #[test]
    fn a_future_schema_is_rejected_with_an_actionable_message() {
        let mut p = sample();
        p.schema = SCHEMA + 5;
        let e = validate(&p).unwrap_err();
        assert!(e.contains("update the app"), "{e}");
    }

    /// A profile is judged against ITS OWN declared range, not a global rule.
    #[test]
    fn temperament_is_bounded_by_the_profiles_own_limits() {
        // Default range rejects a hot value...
        let mut p = sample();
        p.temperament.temperature = 9.0;
        assert!(validate(&p).unwrap_err().contains("this profile's range"));

        // ...but a profile that declares a wider range accepts it.
        let mut wild = sample();
        wild.limits.temperature_max = 12.0;
        wild.temperament.temperature = 9.0;
        validate(&wild).expect("a profile may widen its own range");

        // And a profile may cap itself TIGHTER than the default, which is the
        // more useful direction: it makes an accidental edit impossible.
        let mut disciplined = sample();
        disciplined.limits.temperature_max = 0.2;
        disciplined.temperament.temperature = 0.5;
        let e = validate(&disciplined).unwrap_err();
        assert!(e.contains("0..0.2"), "{e}");
    }

    /// The absolute ceilings are arithmetic, not policy: past them the softmax
    /// stops meaning anything and a probability stops being one.
    #[test]
    fn limits_themselves_are_bounded_by_arithmetic() {
        let mut p = sample();
        p.limits.temperature_max = TEMPERATURE_CEILING + 1.0;
        assert!(validate(&p).unwrap_err().contains("uniform noise"));

        let mut p2 = sample();
        p2.limits.mistake_rate_max = 1.5;
        assert!(validate(&p2).unwrap_err().contains("it is a probability"));
    }

    /// An older exported profile without `limits` takes the shipped defaults.
    #[test]
    fn a_profile_without_limits_takes_the_default_range() {
        let json = serde_json::json!({
            "id": "legacy", "label": "Legacy",
            "loadout": [{"target":"fleet","ambit":"land","type_name":"Tank","want":1}]
        });
        let p: Profile = serde_json::from_value(json).unwrap();
        assert_eq!(p.limits.temperature_max, 5.0);
        assert_eq!(p.limits.mistake_rate_max, 1.0);
    }

    /// Resolution must never fail — a loop with no profile is a loop that stops.
    #[test]
    fn resolution_is_total() {
        set_for_test(ProfileStore::default());
        assert_eq!(find("bait").id, "bait");
        assert!(!find("no-such-profile").loadout.is_empty(), "unknown id must fall back");
    }

    #[test]
    fn a_player_without_a_profile_falls_back_to_its_role() {
        set_for_test(ProfileStore::default());
        assert_eq!(for_player(None, Some(VPlayerRole::Raider)).id, "raider");
        assert_eq!(for_player(Some(""), Some(VPlayerRole::Productive)).id, "productive");
        assert_eq!(for_player(None, None).id, "bait", "default role");
    }

    #[test]
    fn built_ins_cannot_be_shadowed_or_deleted() {
        set_for_test(ProfileStore::default());
        let mut p = sample();
        p.id = "raider".into();
        assert!(set(p).unwrap_err().contains("fork it"));
        assert!(remove("raider").unwrap_err().contains("cannot be deleted"));
    }

    /// A rejected save must leave the stored set exactly as it was.
    #[test]
    fn a_rejected_save_does_not_mutate_the_store() {
        set_for_test(ProfileStore::default());
        let before = store().custom.len();
        let mut bad = sample();
        bad.loadout[0].ambit = "orbit".into();
        assert!(set(bad).is_err());
        assert_eq!(store().custom.len(), before, "store mutated despite rejection");
    }

    /// Capability defaults must be the SAFE reading: a truncated document does
    /// not accidentally acquire the ability to raid.
    #[test]
    fn missing_capabilities_default_to_the_safe_reading() {
        let c: Capabilities = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!c.raids, "an unspecified profile must not raid");
        assert!(c.refines && c.sweeps_alpha && c.auto_defends);
    }

    /// Forward compatibility for imports: unknown keys are ignored, not fatal.
    #[test]
    fn an_imported_profile_with_unknown_fields_still_loads() {
        let json = serde_json::json!({
            "id": "imported", "label": "Imported",
            "loadout": [{"target":"fleet","ambit":"land","type_name":"Tank","want":2}],
            "some_future_field": {"nested": true}
        });
        let p: Profile = serde_json::from_value(json).expect("unknown fields must not be fatal");
        assert_eq!(p.id, "imported");
        assert_eq!(p.schema, SCHEMA, "missing schema takes the current one");
        validate(&p).expect("should be valid");
    }

    /// End-to-end: a custom profile must actually drive the build walk, not just
    /// sit in a config file. Drives the REAL `ripe_entries` + `choose_entry`.
    #[test]
    fn a_custom_profile_changes_what_gets_built() {
        use crate::mcp::auto_build::{choose_entry, ripe_entries};
        use std::collections::{HashMap, HashSet};

        let mut p = sample();
        p.id = "artillery-first".into();
        p.loadout = vec![
            LoadoutEntry { target: "fleet".into(), ambit: "land".into(),
                           type_name: "Mobile Artillery".into(), want: 1 },
            LoadoutEntry { target: "fleet".into(), ambit: "space".into(),
                           type_name: "Battleship".into(), want: 2 },
        ];
        validate(&p).expect("valid");

        let present = HashSet::new();
        let have = HashMap::new();
        let occ = HashMap::new();
        let ripe = ripe_entries(&p.loadout, &present, &have, &occ, |_| true);
        assert_eq!(ripe.len(), 2, "both rows should be buildable on an empty fleet");

        // Deterministic pick takes the head of the author's list.
        let k = choose_entry(&ripe, &Temperament::default()).expect("a pick");
        assert_eq!(ripe[k].type_name, "Mobile Artillery",
                   "the profile's own ordering must drive the build");
        assert_eq!(ripe[k].slot, 0);
    }

    #[test]
    fn profiles_round_trip_through_json() {
        for p in BUILTIN.iter() {
            let s = serde_json::to_string(p).unwrap();
            let back: Profile = serde_json::from_str(&s).unwrap();
            assert_eq!(&back, p);
        }
    }
}
