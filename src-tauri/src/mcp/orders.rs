//! Standing orders: the economy and upkeep automation as ONE versioned,
//! authored document.
//!
//! The settings already exist, each in its own file — harvest, build, infuse,
//! sweep, replication and crew loops, the user-authored behaviour profiles,
//! and which player runs which profile. This module does not add a third
//! store. It READS them as one document, CHECKS a proposed document as a
//! whole, shows the DIFF against what is live, and APPLIES it by writing
//! through each module's own setter — with a version number, an author and a
//! history of what changed, so "who set the fleet to refine at difficulty 4,
//! and when" has an answer.
//!
//! Rules of engagement are not here: they stay with `structs_doctrine`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mcp::profile::Profile;

/// Document schema.
pub const SCHEMA: u32 = 1;
const META_FILE: &str = "standing_orders.json";
const HISTORY_CAP: usize = 50;

/// The document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Orders {
    pub schema: u32,
    /// Set by the store on apply; ignored in a proposal.
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub note: String,
    pub harvest: crate::mcp::auto_harvest::AutoHarvestConfig,
    pub build: crate::mcp::auto_build::AutoBuildConfig,
    pub infuse: crate::mcp::auto_infuse::AutoInfuseConfig,
    pub sweep: crate::mcp::auto_sweep::AutoSweepConfig,
    pub replicate: crate::mcp::auto_replicate::AutoReplicateConfig,
    pub crew: crate::mcp::crew_work::CrewWorkConfig,
    /// User-authored behaviour profiles (built-ins are code and not listed).
    #[serde(default)]
    pub profiles: Vec<Profile>,
    /// Explicit player → profile assignments; a player not listed runs its
    /// role's built-in.
    #[serde(default)]
    pub assignments: BTreeMap<String, String>,
}

/// One applied revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revision {
    pub version: u64,
    pub author: String,
    pub note: String,
    pub at_ms: f64,
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Meta {
    version: u64,
    author: String,
    note: String,
    #[serde(default)]
    history: Vec<Revision>,
}

fn meta() -> Meta {
    crate::mcp::config_store::load_config::<Meta>(META_FILE)
}

/// The live settings, as one document.
pub fn current() -> Orders {
    let m = meta();
    let mut profiles: Vec<Profile> = crate::mcp::profile::store().custom.into_values().collect();
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    Orders {
        schema: SCHEMA,
        version: m.version,
        author: m.author,
        note: m.note,
        harvest: crate::mcp::auto_harvest::get(),
        build: crate::mcp::auto_build::get(),
        infuse: crate::mcp::auto_infuse::get(),
        sweep: crate::mcp::auto_sweep::get(),
        replicate: crate::mcp::auto_replicate::get(),
        crew: crate::mcp::crew_work::get(),
        profiles,
        assignments: crate::mcp::virtual_players::profile_assignments(),
    }
}

/// Everything wrong with `o`, checked as a whole. Empty = applicable. Pure but
/// for `player_exists` (the registry lookup, injected for tests).
pub fn check(o: &Orders, player_exists: impl Fn(&str) -> bool) -> Vec<String> {
    let mut errs = Vec::new();
    if o.schema != SCHEMA {
        errs.push(format!("schema {} is not {SCHEMA}", o.schema));
    }
    let diff_ok = |name: &str, v: u64, errs: &mut Vec<String>| {
        if !(1..=64).contains(&v) {
            errs.push(format!("{name} {v}: a proof difficulty is 1..=64 hex zeros"));
        }
    };
    diff_ok("harvest.difficulty_threshold", o.harvest.difficulty_threshold, &mut errs);
    diff_ok("build.complete_difficulty", o.build.complete_difficulty, &mut errs);
    diff_ok("crew.difficulty_threshold", o.crew.difficulty_threshold, &mut errs);
    for (name, secs) in [("harvest.interval_secs", o.harvest.interval_secs), ("build.interval_secs", o.build.interval_secs), ("crew.interval_secs", o.crew.interval_secs)] {
        if secs < 10 {
            errs.push(format!("{name} {secs}: under 10 s scans faster than the chain produces blocks worth scanning"));
        }
    }
    let builtin: Vec<String> = crate::mcp::profile::list().into_iter().map(|p| p.id).filter(|id| !o.profiles.iter().any(|p| &p.id == id)).collect();
    let mut seen = std::collections::HashSet::new();
    for p in &o.profiles {
        if !seen.insert(p.id.as_str()) {
            errs.push(format!("profile '{}' is defined twice", p.id));
        }
        if let Err(e) = crate::mcp::profile::validate(p) {
            errs.push(format!("profile '{}': {e}", p.id));
        }
    }
    for (player, profile) in &o.assignments {
        if !player_exists(player) {
            errs.push(format!("assignment {player}: not one of this account's players"));
        }
        if !o.profiles.iter().any(|p| &p.id == profile) && !builtin.contains(profile) {
            errs.push(format!("assignment {player} → '{profile}': no such profile"));
        }
    }
    errs
}

fn flatten(prefix: &str, v: &Value, out: &mut BTreeMap<String, Value>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                flatten(&if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") }, x, out);
            }
        }
        _ => {
            out.insert(prefix.to_string(), v.clone());
        }
    }
}

/// Field-level changes from `from` to `to`, document metadata excluded. Pure.
pub fn diff(from: &Orders, to: &Orders) -> Vec<String> {
    let strip = |o: &Orders| {
        let mut v = serde_json::to_value(o).unwrap_or(Value::Null);
        if let Some(m) = v.as_object_mut() {
            for k in ["version", "author", "note", "schema"] {
                m.remove(k);
            }
            // Profiles by id, so a reordering is not a change.
            if let Some(Value::Array(ps)) = m.remove("profiles") {
                let by_id: serde_json::Map<String, Value> =
                    ps.into_iter().filter_map(|p| Some((p.get("id")?.as_str()?.to_string(), p))).collect();
                m.insert("profiles".into(), Value::Object(by_id));
            }
        }
        v
    };
    let (mut a, mut b) = (BTreeMap::new(), BTreeMap::new());
    flatten("", &strip(from), &mut a);
    flatten("", &strip(to), &mut b);
    let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    keys.into_iter()
        .filter_map(|k| match (a.get(k), b.get(k)) {
            (Some(x), Some(y)) if x == y => None,
            (Some(x), Some(y)) => Some(format!("{k}: {x} → {y}")),
            (None, Some(y)) => Some(format!("{k}: (unset) → {y}")),
            (Some(x), None) => Some(format!("{k}: {x} → (removed)")),
            (None, None) => None,
        })
        .collect()
}

/// Apply `proposed` as the complete standing orders: checked as a whole first
/// (nothing is written if anything is wrong), then written through each
/// module's own setter. Profiles and assignments missing from the document
/// are removed. Returns the new live document.
pub fn apply(proposed: Orders, author: &str) -> Result<(Orders, Vec<String>), Vec<String>> {
    let errs = check(&proposed, crate::mcp::virtual_players::is_virtual);
    if !errs.is_empty() {
        return Err(errs);
    }
    let before = current();
    let changes = diff(&before, &proposed);
    crate::mcp::auto_harvest::set(proposed.harvest.clone());
    crate::mcp::auto_build::set(proposed.build.clone());
    crate::mcp::auto_infuse::set(proposed.infuse.clone());
    crate::mcp::auto_sweep::set(proposed.sweep.clone());
    crate::mcp::auto_replicate::set(proposed.replicate.clone());
    crate::mcp::crew_work::set(proposed.crew.clone());
    let mut failures = Vec::new();
    for p in &proposed.profiles {
        if let Err(e) = crate::mcp::profile::set(p.clone()) {
            failures.push(format!("profile '{}': {e}", p.id));
        }
    }
    // Assignments first (clearing ones that go), then retire dropped
    // profiles — a profile still assigned cannot be removed.
    for (player, _) in before.assignments.iter().filter(|(p, _)| !proposed.assignments.contains_key(*p)) {
        if let Err(e) = crate::mcp::virtual_players::set_profile(player, None) {
            failures.push(format!("clear {player}: {e}"));
        }
    }
    for (player, profile) in &proposed.assignments {
        if before.assignments.get(player) != Some(profile) {
            if let Err(e) = crate::mcp::virtual_players::set_profile(player, Some(profile.clone())) {
                failures.push(format!("assign {player}: {e}"));
            }
        }
    }
    for p in before.profiles.iter().filter(|p| !proposed.profiles.iter().any(|q| q.id == p.id)) {
        if let Err(e) = crate::mcp::profile::remove(&p.id) {
            failures.push(format!("remove profile '{}': {e}", p.id));
        }
    }
    let mut m = meta();
    m.version += 1;
    m.author = author.to_string();
    m.note = proposed.note.clone();
    m.history.push(Revision { version: m.version, author: author.to_string(), note: proposed.note.clone(), at_ms: crate::hasher::types::now_millis(), changes: changes.clone() });
    if m.history.len() > HISTORY_CAP {
        let drop = m.history.len() - HISTORY_CAP;
        m.history.drain(..drop);
    }
    crate::mcp::config_store::save_config(META_FILE, &m);
    // New thresholds and switches: the need-gated loops re-plan now.
    crate::mcp::schedule::mark_dirty();
    crate::mcp::telemetry::tlog(
        "orders",
        crate::mcp::telemetry::Sev::Notice,
        format!("standing orders v{} applied by {author}: {} change(s){}", m.version, changes.len(), if failures.is_empty() { String::new() } else { format!(", {} failed", failures.len()) }),
    );
    if failures.is_empty() {
        Ok((current(), changes))
    } else {
        Err(failures)
    }
}

/// The live document's version and author, for status views.
pub fn version() -> (u64, String) {
    let m = meta();
    (m.version, m.author)
}

/// Applied revisions, newest last.
pub fn history() -> Vec<Revision> {
    meta().history
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Orders {
        Orders {
            schema: SCHEMA,
            version: 0,
            author: String::new(),
            note: String::new(),
            harvest: crate::mcp::auto_harvest::AutoHarvestConfig::default(),
            build: crate::mcp::auto_build::AutoBuildConfig::default(),
            infuse: crate::mcp::auto_infuse::AutoInfuseConfig::default(),
            sweep: crate::mcp::auto_sweep::AutoSweepConfig::default(),
            replicate: crate::mcp::auto_replicate::AutoReplicateConfig::default(),
            crew: crate::mcp::crew_work::CrewWorkConfig::default(),
            profiles: vec![],
            assignments: BTreeMap::new(),
        }
    }

    #[test]
    fn the_default_document_is_applicable() {
        assert_eq!(check(&doc(), |_| true), Vec::<String>::new());
    }

    #[test]
    fn out_of_range_thresholds_and_intervals_are_refused_together() {
        let mut d = doc();
        d.harvest.difficulty_threshold = 0;
        d.crew.difficulty_threshold = 65;
        d.build.interval_secs = 1;
        let e = check(&d, |_| true);
        assert_eq!(e.len(), 3, "{e:?}");
    }

    #[test]
    fn assignments_must_name_a_known_player_and_profile() {
        let mut d = doc();
        d.assignments.insert("1-9".into(), "no-such-profile".into());
        let e = check(&d, |p| p != "1-9");
        assert!(e.iter().any(|x| x.contains("not one of this account's players")), "{e:?}");
        assert!(e.iter().any(|x| x.contains("no such profile")), "{e:?}");
        let mut d = doc();
        d.assignments.insert("1-9".into(), "bait".into());
        assert!(check(&d, |_| true).is_empty(), "a built-in profile is a valid assignment");
    }

    #[test]
    fn a_wrong_schema_is_refused() {
        let mut d = doc();
        d.schema = 99;
        assert!(check(&d, |_| true).iter().any(|e| e.contains("schema")));
    }

    #[test]
    fn the_diff_names_each_changed_field_and_ignores_metadata() {
        let a = doc();
        let mut b = doc();
        b.harvest.difficulty_threshold = 9;
        b.crew.enabled = !a.crew.enabled;
        b.author = "someone".into();
        b.version = 7;
        let d = diff(&a, &b);
        assert_eq!(d.len(), 2, "{d:?}");
        assert!(d.iter().any(|x| x.starts_with("harvest.difficulty_threshold:")));
        assert!(d.iter().any(|x| x.starts_with("crew.enabled:")));
        assert!(diff(&a, &a).is_empty());
    }

    #[test]
    fn assignment_changes_show_in_the_diff() {
        let a = doc();
        let mut b = doc();
        b.assignments.insert("1-5".into(), "bait".into());
        assert_eq!(diff(&a, &b), vec!["assignments.1-5: (unset) → \"bait\"".to_string()]);
    }
}
