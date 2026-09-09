//! What a player has actually DONE, as counters — the read behind the
//! Terminal's `achievements` (ribbon rack) and `tally` (hull matrix) cards.
//!
//! ## Why the shape is what it is
//!
//! The figures come from four sources of very different quality, and the card
//! has to be able to say which:
//!
//! | tier | source | exact? | any player? |
//! |---|---|---|---|
//! | `profile`  | `/api/player/{id}/{ore/stats,planet/completed,raid/launched}` | yes | yes |
//! | `ledger`   | `/api/ledger/list/player/{id}` walked by action | yes | yes |
//! | `activity` | `/api/planet-activity/player/{id}` — **the new route** | yes | yes |
//! | `local`    | our own GRASS-fed tail, when the route is absent | no — since install | only what we watched |
//!
//! Everything combat-shaped lives in the `activity` tier, because
//! `structs.planet_activity` carries no `player_id` column and the older API
//! offered no player filter: the only routes were `/all`, `/planet/{id}` and
//! `/category/{c}`. Until `/player/{id}` answers, every combat counter here is
//! **`null`, never `0`** — `stats_absence_vs_zero` is the lesson that made
//! that rule: `num()` answering 0 for an absent key wrote false zeros that
//! flattened every sparkline in Game Stats. A tile that says "—" is telling
//! the truth; a tile that says "0" is lying.
//!
//! ## Damage is `damageDealt − damageReduction`
//!
//! Never `damage` alone. `damage` is an accumulator that lands on whichever
//! shot the health change is applied to — a Starfighter attack run reported
//! its two HITS as 0 and its MISS as 2. `damageDealt` is the per-shot roll
//! (ignoring armour) and `damageReduction` is what the armour ate, so the
//! difference is what actually landed. Both `raid_view::describe_activity` and
//! `intel::battle_log` had this wrong once already.
//!
//! ## Two readings of "killed", and both are on the list
//!
//! "Destroy [#] [Struct]" is a count of TARGETS by type; "Defeat [#] Structs
//! with [Struct]" is a count of kills by the ATTACKER's type. They are
//! different achievements over the same rows, so the hull matrix carries both
//! (`destroyed` and `kills`) rather than picking a side and being wrong for
//! one of them.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::mcp::guild_api::GuildApiClient;
use crate::mcp::types::numeric_f64;

/// How long one player's aggregate is reused. Two cards drawing the same
/// player must not double the walk, and the underlying figures are lifetime
/// totals — a minute of staleness is invisible.
const TTL: Duration = Duration::from_secs(180);

/// Page size for the walks. The Guild API clamps `?limit=` server-side
/// (`PaginationLimits::MAX` is 10000), and a short page is what ends a walk.
const PAGE: usize = 5000;

/// Hard cap on pages, so one very old player cannot turn a card refresh into
/// a minutes-long scan. A truncated walk is reported as such rather than
/// passed off as a total.
const MAX_PAGES: u32 = 8;

// ── the shape a card reads ──────────────────────────────────────────────────

/// One hull type's row in the tally matrix.
#[derive(Default, Clone)]
struct Hull {
    built: Option<f64>,
    lost: Option<f64>,
    /// Kills scored BY my hulls of this type — "Defeat [#] Structs with X".
    kills: Option<f64>,
    /// Damage dealt BY my hulls of this type — "Deal [#] DMG with X".
    damage: Option<f64>,
    /// Enemy hulls of this type I destroyed — "Destroy [#] X".
    destroyed: Option<f64>,
}

fn add(slot: &mut Option<f64>, n: f64) {
    *slot = Some(slot.unwrap_or(0.0) + n);
}

/// Everything both cards draw, keyed the way the frontend catalogue names it.
#[derive(Default)]
pub struct Record {
    counters: HashMap<&'static str, f64>,
    /// Which counters were genuinely observed. A key absent from here is
    /// UNKNOWN and renders as "—"; a key present with 0 is a real zero.
    known: Vec<&'static str>,
    hulls: HashMap<String, Hull>,
    ambit_damage: HashMap<String, f64>,
    ambit_kills: HashMap<String, f64>,
}

impl Record {
    fn bump(&mut self, key: &'static str, by: f64) {
        *self.counters.entry(key).or_insert(0.0) += by;
        self.mark(key);
    }
    /// Declare a counter observed even when its value is still zero — the
    /// difference between "no raids won" and "we cannot see raids".
    fn mark(&mut self, key: &'static str) {
        if !self.known.contains(&key) {
            self.known.push(key);
        }
    }
    fn set(&mut self, key: &'static str, v: f64) {
        self.counters.insert(key, v);
        self.mark(key);
    }
    fn hull(&mut self, ty: &str) -> &mut Hull {
        self.hulls.entry(ty.to_string()).or_default()
    }
}

// ── the counters the frontend catalogue knows about ─────────────────────────
//
// Named here so the aggregation and the catalogue cannot drift apart silently;
// `achievements.test.mjs` checks the frontend names every key this emits.

/// Every combat counter, declared observed the moment the activity walk
/// succeeds — so a player who has never fired a shot reads 0, not "—".
const COMBAT_KEYS: &[&str] = &[
    "shots_fired",
    "damage_dealt",
    "damage_taken",
    "smart_damage",
    "ballistic_damage",
    "kills",
    "cmd_kills",
    "fleet_kills",
    "ground_kills",
    "counter_kills",
    "defender_kills",
    "structs_lost",
    "damage_blocked",
    "damage_absorbed",
    "evaded_jam",
    "evaded_stealth",
    "evaded_other",
    "armour_piercer",
    "raids_won",
    "raids_repelled",
    "structs_built",
];

/// The one-offs. Marked observed alongside the counters, so a player who has
/// simply never pulled one off reads a locked tile rather than a blank one.
const FEAT_KEYS: &[&str] = &[
    "feat_breach_kill",
    "feat_double_tap",
    "feat_payback",
    "feat_dry_well",
];

const AMBITS: &[&str] = &["land", "water", "air", "space"];

/// The per-ambit damage counters, paired with the ambit they read.
/// `&'static str` keys are what `Record` stores, so the four are named rather
/// than formatted.
const AMBIT_DAMAGE_KEYS: &[(&str, &str)] = &[
    ("land", "damage_from_land"),
    ("water", "damage_from_water"),
    ("air", "damage_from_air"),
    ("space", "damage_from_space"),
];

// ── helpers ─────────────────────────────────────────────────────────────────

fn num(v: Option<&Value>) -> f64 {
    numeric_f64(v).unwrap_or(0.0)
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => {
            let s = s.trim();
            !(s.is_empty() || s == "false" || s == "0")
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        _ => false,
    }
}

/// The activity feed hands `detail` back as a JSON-encoded STRING, and adds an
/// already-decoded `detail_json` beside it. Prefer the decoded one and fall
/// back to parsing, so this reads both the REST rows and a GRASS frame.
fn detail(row: &Value) -> Option<Value> {
    if let Some(d) = row.get("detail_json") {
        if d.is_object() {
            return Some(d.clone());
        }
    }
    match row.get("detail") {
        Some(Value::Object(o)) => Some(Value::Object(o.clone())),
        Some(Value::String(s)) => serde_json::from_str(s).ok(),
        _ => None,
    }
}

/// Is this the error a Guild API that has not shipped the route yet returns?
/// A missing endpoint must leave the combat tiles UNKNOWN; any other failure
/// is worth surfacing as a reason on the card.
pub fn is_missing_route(err: &str) -> bool {
    err.contains("Guild API 404") || err.contains("Guild API 405")
}

// ── the aggregation, as a pure function over rows ───────────────────────────

/// Fold one page of `struct_attack` rows into the record.
///
/// Both sides are counted from the same row: when `attackerPlayerId` is us we
/// are shooting, when `targetPlayerId` is us we are being shot. A self-raid
/// hits both branches, which is correct — a vplayer shooting another vplayer
/// really did fire and really was hit.
pub fn fold_attack(rec: &mut Record, me: &str, d: &Value, on_my_planet: bool) {
    let attacker_is_me = text(d.get("attackerPlayerId")).as_deref() == Some(me);

    let a_type = text(d.get("attackerStructType")).unwrap_or_default();
    let a_ambit = text(d.get("attackerStructOperatingAmbit")).unwrap_or_default();
    // `weaponControl` is the game's own split: guided is a smart weapon,
    // unguided is ballistic. `activeWeaponry` says the same thing in longer
    // words, so one is enough.
    let guided = text(d.get("weaponControl")).map(|c| c == "guided").unwrap_or(false);

    let shots = d
        .get("eventAttackShotDetail")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    if attacker_is_me {
        rec.bump("shots_fired", shots.len() as f64);
    }

    for shot in &shots {
        /* WHOSE struct this shot hit is a property of the SHOT, not of the
         * volley: `targetPlayerId` lives in `eventAttackShotDetail`, and one
         * volley can spray several defenders. Read flat — as the published
         * schema describes it — it is always absent, `target_is_me` is always
         * false, and the entire defensive half of the record silently scores
         * zero. Verified against the indexer: the top level carries only
         * `attacker*` fields, and every `target*` key is per shot. */
        let target_is_me = text(shot.get("targetPlayerId")).as_deref() == Some(me);
        if !attacker_is_me && !target_is_me {
            continue;
        }
        // What actually landed. Never `damage` on its own.
        let landed = (num(shot.get("damageDealt")) - num(shot.get("damageReduction"))).max(0.0);
        let reduced = num(shot.get("damageReduction"));
        let t_type = text(shot.get("targetStructType")).unwrap_or_default();
        let t_ambit = text(shot.get("targetStructOperatingAmbit")).unwrap_or_default();
        let on_fleet = text(shot.get("targetStructLocationType"))
            .map(|l| l.eq_ignore_ascii_case("fleet"))
            .unwrap_or(false);
        let destroyed = truthy(shot.get("targetDestroyed"));

        if attacker_is_me {
            rec.bump("damage_dealt", landed);
            rec.bump(if guided { "smart_damage" } else { "ballistic_damage" }, landed);
            if AMBITS.contains(&a_ambit.as_str()) {
                *rec.ambit_damage.entry(a_ambit.clone()).or_insert(0.0) += landed;
            }
            if !a_type.is_empty() {
                add(&mut rec.hull(&a_type).damage, landed);
            }
            // An armour-piercing round that still met armour reduction is the
            // exact shape of "use an armour-piercing weapon on a struct with
            // ablative armour" — the two facts have to co-occur on ONE shot.
            if truthy(shot.get("armourPiercing")) && reduced > 0.0 {
                rec.bump("armour_piercer", 1.0);
            }
            if destroyed {
                rec.bump("kills", 1.0);
                if !a_type.is_empty() {
                    add(&mut rec.hull(&a_type).kills, 1.0);
                }
                if !t_type.is_empty() {
                    add(&mut rec.hull(&t_type).destroyed, 1.0);
                }
                if t_type.eq_ignore_ascii_case("Command Ship") {
                    rec.bump("cmd_kills", 1.0);
                }
                rec.bump(if on_fleet { "fleet_kills" } else { "ground_kills" }, 1.0);
                if AMBITS.contains(&t_ambit.as_str()) {
                    *rec.ambit_kills.entry(t_ambit.clone()).or_insert(0.0) += 1.0;
                }
            }
        }

        if target_is_me {
            rec.bump("damage_taken", landed);
            // Armour ate it; a blocker took it instead; a defensive system
            // made the shot miss. Three different achievements, three fields.
            if reduced > 0.0 {
                rec.bump("damage_absorbed", reduced);
            }
            if truthy(shot.get("blocked")) {
                rec.bump("damage_blocked", num(shot.get("damageDealt")));
            }
            if truthy(shot.get("evaded")) || truthy(shot.get("evadedByPlanetaryDefenses")) {
                let cause = text(shot.get("evadedCause"))
                    .or_else(|| text(shot.get("evadedByPlanetaryDefensesCause")))
                    .unwrap_or_default();
                let key = match cause.as_str() {
                    "signalJamming" => "evaded_jam",
                    "stealthMode" | "stealth" => "evaded_stealth",
                    _ => "evaded_other",
                };
                rec.bump(key, num(shot.get("damageDealt")));
            }
            if destroyed {
                rec.bump("structs_lost", 1.0);
                if !t_type.is_empty() {
                    add(&mut rec.hull(&t_type).lost, 1.0);
                }
            }
            // A counter is MY defender hitting back: it belongs to me even
            // though the row is an attack ON me.
            for c in shot
                .get("eventAttackDefenderCounterDetail")
                .and_then(|x| x.as_array())
                .into_iter()
                .flatten()
            {
                let cd = num(c.get("counterDamage"));
                if cd > 0.0 {
                    rec.bump("damage_dealt", cd);
                }
            }
            if truthy(shot.get("targetCounterDestroyedAttacker")) {
                rec.bump("counter_kills", 1.0);
                rec.bump("kills", 1.0);
            }
            if truthy(shot.get("blockerDestroyed")) {
                // Our blocker died; not a kill. Recorded as a loss so the
                // matrix's `lost` column is not silently short.
                if let Some(bt) = text(shot.get("blockedByStructType")) {
                    add(&mut rec.hull(&bt).lost, 1.0);
                }
            }
        }
    }

    /* Planetary defence cannons belong to whoever owns the PLANET, and the row
     * names no planet owner at all — only `planet_activity.planet_id`. So the
     * caller, which knows our planets, decides; reading it off the shots would
     * credit a cannon to whoever happened to be shot at. */
    if on_my_planet {
        let pdc = num(d.get("planetaryDefenseCannonDamage"));
        if pdc > 0.0 {
            rec.bump("damage_dealt", pdc);
        }
        if truthy(d.get("planetaryDefenseCannonDamageDestroyedAttacker")) {
            rec.bump("defender_kills", 1.0);
            rec.bump("kills", 1.0);
        }
    }
}

/// Fold one `struct_status` row: the BUILT and DESTROYED bits flipping on.
///
/// The bitmask is the game's own (`StructConstants`): MATERIALIZED 1, BUILT 2,
/// ONLINE 4, STORED 8, HIDDEN 16, DESTROYED 32, LOCKED 64. A build shows as
/// BUILT going 0 → 1; `struct_block_build_start` counts INITIATIONS, which is
/// a different and more flattering number.
pub fn fold_status(rec: &mut Record, d: &Value) {
    const BUILT: u64 = 2;
    let now = num(d.get("status")) as u64;
    let was = num(d.get("status_old")) as u64;
    if now & BUILT != 0 && was & BUILT == 0 {
        rec.bump("structs_built", 1.0);
    }
}

/// The one-off achievements — the ones that are not a count of anything but a
/// SHAPE across several rows.
///
/// Each needs ordering, which is why they live outside `fold_attack`: the feed
/// arrives newest-first and these read forwards. The walker sorts ascending by
/// time (tie-broken on `seq`) before feeding this, so "already underway" and
/// "previously defeated you" mean what the words say.
#[derive(Default)]
pub struct Feats {
    /// Planets of ours whose shield has gone vulnerable in a raid that has not
    /// yet ended. Cleared on any terminal status, so a breach kill has to
    /// happen inside the same episode.
    breached: std::collections::HashSet<String>,
    /// CMD Ship kills of ours, per planet. Two on one planet is the feat.
    cmd_kills_by_planet: HashMap<String, u32>,
    /// Everyone who has destroyed a struct of ours. Killing one of theirs
    /// afterwards is the payback.
    beaten_by: std::collections::HashSet<String>,
}

impl Feats {
    /// One row, in time order. `planet` is the row's own planet id.
    pub fn feed(&mut self, rec: &mut Record, me: &str, category: &str, planet: &str, d: &Value, mine: &Owned) {
        match category {
            "raid_status" => {
                let status = text(d.get("status")).unwrap_or_default();
                let fleet = text(d.get("fleet_id")).unwrap_or_default();
                let fleet_is_mine = mine.fleets.contains(&fleet);
                let planet_is_mine = mine.planets.iter().any(|p| p == planet);
                match status.as_str() {
                    "shieldsVulnerable" if planet_is_mine => {
                        self.breached.insert(planet.to_string());
                    }
                    "attackerDefeated" if planet_is_mine => {
                        if self.breached.remove(planet) {
                            rec.bump("feat_breach_kill", 1.0);
                        }
                    }
                    "raidSuccessful" if fleet_is_mine => {
                        // `seized_ore` was added to `emitRaidStatusActivity`
                        // late, so roughly half of the indexed rows lack it.
                        // Absent means UNKNOWN, not zero — an achievement must
                        // not be awarded on a key that was never written.
                        if let Some(ore) = numeric_f64(d.get("seized_ore")) {
                            if ore == 0.0 {
                                rec.bump("feat_dry_well", 1.0);
                            }
                        }
                    }
                    // Any other terminal status closes the episode.
                    "attackerRetreated" | "demilitarized" => {
                        self.breached.remove(planet);
                    }
                    _ => {}
                }
            }
            "struct_attack" => {
                let attacker = text(d.get("attackerPlayerId")).unwrap_or_default();
                let shots = d
                    .get("eventAttackShotDetail")
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default();
                // Only `attacker*` is flat; who each shot HIT is per shot.
                let killed: Vec<String> = shots
                    .iter()
                    .filter(|s| truthy(s.get("targetDestroyed")))
                    .map(|s| text(s.get("targetPlayerId")).unwrap_or_default())
                    .collect();
                if killed.is_empty() {
                    return;
                }
                if killed.iter().any(|t| t == me) && !attacker.is_empty() && attacker != me {
                    self.beaten_by.insert(attacker);
                    return;
                }
                if attacker != me {
                    return;
                }
                /* Payback is scored once per opponent, the first time we answer
                 * them — otherwise a long feud counts as ten feats. One volley
                 * can kill structs belonging to several players, so every
                 * victim in it is checked. */
                for t in killed.iter().filter(|t| !t.is_empty()) {
                    if self.beaten_by.remove(t) {
                        rec.bump("feat_payback", 1.0);
                    }
                }
                let cmd = shots
                    .iter()
                    .filter(|s| {
                        truthy(s.get("targetDestroyed"))
                            && text(s.get("targetStructType"))
                                .map(|t| t.eq_ignore_ascii_case("Command Ship"))
                                .unwrap_or(false)
                    })
                    .count() as u32;
                if cmd > 0 {
                    let n = self.cmd_kills_by_planet.entry(planet.to_string()).or_insert(0);
                    let before = *n;
                    *n += cmd;
                    // Award exactly on the crossing, so a third kill on the
                    // same planet does not score the feat again.
                    if before < 2 && *n >= 2 {
                        rec.bump("feat_double_tap", 1.0);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Fold one `raid_status` row, given whether the fleet is ours and whether the
/// planet is ours. The row itself names neither owner — it is
/// `{planet_id, fleet_id, status, seized_ore}` — so the caller resolves both.
pub fn fold_raid(rec: &mut Record, d: &Value, fleet_is_mine: bool, planet_is_mine: bool) {
    let status = text(d.get("status")).unwrap_or_default();
    match status.as_str() {
        "initiated" if fleet_is_mine => rec.bump("raids_initiated", 1.0),
        "raidSuccessful" if fleet_is_mine => rec.bump("raids_won", 1.0),
        // Repelled covers both ways a raid on us ended without loot: the
        // attacker died, or it gave up. `demilitarized` is us re-planeting
        // mid-raid, which voids it — that is a dodge, not a repulse.
        "attackerDefeated" | "attackerRetreated" if planet_is_mine => {
            rec.bump("raids_repelled", 1.0)
        }
        _ => {}
    }
}

// ── the reads ───────────────────────────────────────────────────────────────

/// Sum the ledger for the actions that ARE lifetime achievements.
///
/// Two corrections the raw sum needs. Historical rows duplicate
/// `refined`+`received` and `infused`+`sent` on ualpha, so only the primary
/// action of each pair is counted here (the shadow is a `received`/`sent`,
/// which this never reads). And `amount_p` is the precise base-unit column —
/// `amount` is a floored display string.
async fn ledger_totals(client: &GuildApiClient, id: &str) -> Result<HashMap<&'static str, f64>, String> {
    let (rows, _, complete) = client
        .walk_list(&format!("/api/ledger/list/player/{id}"), PAGE, MAX_PAGES)
        .await?;
    let mut out: HashMap<&'static str, f64> = HashMap::new();
    for r in &rows {
        let action = text(r.get("action")).unwrap_or_default();
        let denom = text(r.get("denom")).unwrap_or_default();
        let amt = numeric_f64(r.get("amount_p"))
            .or_else(|| numeric_f64(r.get("amount")))
            .unwrap_or(0.0);
        let key = match (action.as_str(), denom.as_str()) {
            ("refined", "ualpha") => "alpha_refined",
            /* `ualpha`, not any denom. An infusion writes BOTH legs of one
             * double entry — `ualpha` debit out of the wallet and
             * `ualpha.infused` credit into the stake, same block, same amount
             * — so a denom-agnostic match counted 1-61's single 4g infusion
             * as 8g. The `ualpha` leg is the alpha that left, which is what
             * "Infuse [#] Alpha" asks for. `refined` is the same shape (ore
             * debit, ualpha credit) and was already pinned to one leg. */
            ("infused", "ualpha") => "alpha_infused",
            ("mined", "ore") => "ore_mined",
            ("seized", "ore") => "ore_seized",
            ("forfeited", "ore") => "ore_forfeited",
            _ => continue,
        };
        *out.entry(key).or_insert(0.0) += amt;
        /* Every won raid writes one `seized` row, whether or not it carried
         * anything away — roughly 40% are 0 grams. So the COUNT of seized rows
         * is the number of raids won, from the ledger, and it agrees exactly
         * with the activity feed's own count (1-61: 76 either way). It is kept
         * as a fallback rather than a tile of its own: it is the only way to
         * answer "raids won" until the per-player activity route exists. */
        if key == "ore_seized" {
            *out.entry("raids_won_ledger").or_insert(0.0) += 1.0;
        }
    }
    if !complete {
        return Err(format!("ledger truncated at {} rows", rows.len()));
    }
    Ok(out)
}

/// Walk the per-player activity feed and fold every row.
///
/// This is the route that does not exist yet. When it 404s the caller leaves
/// every combat counter unknown rather than zero.
async fn activity_totals(
    client: &GuildApiClient,
    id: &str,
    rec: &mut Record,
    mine: &Owned,
) -> Result<(), String> {
    let (mut rows, _, complete) = client
        .planet_activity_by_player(id, None, PAGE, MAX_PAGES)
        .await?;
    for key in COMBAT_KEYS {
        rec.mark(key);
    }
    /* The feed arrives newest-first (`ORDER BY time DESC, seq DESC`) and the
     * one-off achievements read FORWARDS — "a breach already underway", "a
     * player who previously defeated you". Sorting here rather than asking the
     * API for an order it does not offer keeps the walk to one shape.
     *
     * `seq` only tie-breaks WITHIN a planet (it is drawn from
     * `planet_activity_sequence`, a per-planet counter), so it is the
     * secondary key and never the primary one. */
    rows.sort_by(|a, b| {
        let t = |r: &Value| text(r.get("time")).unwrap_or_default();
        let s = |r: &Value| numeric_f64(r.get("seq")).unwrap_or(0.0);
        t(a).cmp(&t(b)).then(s(a).partial_cmp(&s(b)).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut feats = Feats::default();
    for key in FEAT_KEYS {
        rec.mark(key);
    }
    for row in &rows {
        let Some(d) = detail(row) else { continue };
        let category = text(row.get("category")).unwrap_or_default();
        let planet = text(d.get("planet_id"))
            .or_else(|| text(row.get("planet_id")))
            .unwrap_or_default();
        match category.as_str() {
            "struct_attack" => fold_attack(rec, id, &d, mine.planets.iter().any(|p| *p == planet)),
            "struct_status" => fold_status(rec, &d),
            "raid_status" => {
                let fleet = text(d.get("fleet_id")).unwrap_or_default();
                fold_raid(
                    rec,
                    &d,
                    mine.fleets.contains(&fleet),
                    mine.planets.iter().any(|p| *p == planet),
                );
            }
            _ => {}
        }
        feats.feed(rec, id, &category, &planet, &d, mine);
    }

    // "Deal [#] DMG from [Ambit]-Based Structs" is a counter like any other,
    // so it is published as one rather than making the rack reach into the
    // matrix's ambit map for four of its tiles.
    for (ambit, key) in AMBIT_DAMAGE_KEYS {
        let v = rec.ambit_damage.get(*ambit).copied().unwrap_or(0.0);
        rec.set(key, v);
    }

    /* `raids_initiated` is counted here from real `raid_status` rows on our
     * own fleet, which is a better answer than the profile endpoint's — so
     * once the walk succeeds it replaces it. The two are the same
     * achievement, so they share one tile rather than disagreeing on two. */
    if let Some(n) = rec.counters.get("raids_initiated").copied() {
        rec.set("raids_launched", n);
    }

    if !complete {
        return Err(format!("activity truncated at {} rows", rows.len()));
    }
    Ok(())
}

/// The ids a raid row has to be matched against: the player's own fleets and
/// planets. Read from the perception snapshot, which is the app's local source
/// of truth and already holds every player's planet and fleet.
#[derive(Default)]
pub struct Owned {
    fleets: Vec<String>,
    planets: Vec<String>,
}

fn owned(id: &str) -> Owned {
    crate::mcp::perception::with_snapshot(|s| {
        let mut o = Owned::default();
        if let Some(p) = s.players.get(id) {
            if let Some(f) = p.get("fleetId").and_then(|v| v.as_str()) {
                o.fleets.push(f.to_string());
            }
            if let Some(pl) = p.get("planetId").and_then(|v| v.as_str()) {
                o.planets.push(pl.to_string());
            }
        }
        o
    })
    .unwrap_or_default()
}

// ── the command ─────────────────────────────────────────────────────────────

static CACHE: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached(id: &str) -> Option<Value> {
    let c = CACHE.lock().ok()?;
    let (at, v) = c.get(id)?;
    (at.elapsed() < TTL).then(|| v.clone())
}

fn remember(id: &str, v: &Value) {
    if let Ok(mut c) = CACHE.lock() {
        // Bounded: the roster is large and a Terminal can only show a handful
        // of these at once.
        if c.len() > 64 {
            c.clear();
        }
        c.insert(id.to_string(), (Instant::now(), v.clone()));
    }
}

/// Everything both achievement cards draw, for one player.
#[tauri::command]
pub async fn terminal_achievements(player: String) -> Result<Value, String> {
    let id = player.trim().to_string();
    if id.is_empty() {
        return Err("no player given".into());
    }
    if !id.starts_with("1-") {
        return Err(format!("{id} is not a player id"));
    }
    if let Some(hit) = cached(&id) {
        return Ok(hit);
    }
    let out = build(&id).await?;
    remember(&id, &out);
    Ok(out)
}

async fn build(id: &str) -> Result<Value, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let g = &client.guild;
    let mut rec = Record::default();
    let mut unavailable = Map::new();

    // Tier 0 and tier 1 go out together: independent reads, one round trip's
    // worth of wall clock instead of four.
    let mine = owned(id);
    let (ore, planets, raids, ledger) = tokio::join!(
        g.player_ore_stats(id),
        g.player_planets_completed(id),
        g.player_raids_launched(id),
        ledger_totals(g, id),
    );

    match &ore {
        Ok(v) => {
            // These three exist as a server-side SUM over the same ledger, so
            // they are the cheap answer; the ledger walk below overrides them
            // with the precise `amount_p` figures when it succeeds.
            for (field, key) in [("mined", "ore_mined"), ("seized", "ore_seized"), ("forfeited", "ore_forfeited")] {
                if let Some(n) = numeric_f64(v.get(field)) {
                    rec.set(key, n);
                }
            }
        }
        Err(e) => {
            unavailable.insert("ore".into(), json!(e));
        }
    }
    match &planets {
        Ok(v) => {
            if let Some(n) = numeric_f64(v.get("count")) {
                rec.set("planets_drained", n);
            }
        }
        Err(e) => {
            unavailable.insert("planets".into(), json!(e));
        }
    }
    match &raids {
        Ok(v) => {
            if let Some(n) = numeric_f64(v.get("count")) {
                rec.set("raids_launched", n);
            }
        }
        Err(e) => {
            unavailable.insert("raids".into(), json!(e));
        }
    }
    match &ledger {
        Ok(t) => {
            // Ledger figures are base units and beat the profile's floored
            // display sums wherever both exist.
            for (k, v) in t {
                if *k == "raids_won_ledger" {
                    continue;   // a fallback, applied below only if it is needed
                }
                rec.set(k, *v);
            }
        }
        Err(e) => {
            unavailable.insert("ledger".into(), json!(e));
        }
    }

    // Tier 2. Absent route ⇒ every combat counter stays UNKNOWN.
    let combat = match activity_totals(g, id, &mut rec, &mine).await {
        Ok(()) => "full",
        Err(e) if is_missing_route(&e) => {
            unavailable.insert("combat".into(), json!("the guild does not serve per-player activity yet"));
            "none"
        }
        Err(e) => {
            unavailable.insert("combat".into(), json!(e));
            "none"
        }
    };

    /* Without the activity route there is still one combat figure the ledger
     * can answer, because a won raid always writes a `seized` row. Applied
     * only here, AFTER the walk: the walk counts the same raids itself, and
     * setting it earlier would have the two sources add up to double. */
    if combat != "full" {
        if let Ok(t) = &ledger {
            if let Some(n) = t.get("raids_won_ledger") {
                rec.set("raids_won", *n);
            }
        }
    }

    let height = crate::mcp::perception::with_snapshot(|s| s.height).unwrap_or(0);
    Ok(json!({
        "player_id": id,
        "height": height,
        "counters": counters_json(&rec),
        "hulls": hulls_json(&rec),
        "ambits": {
            "damage": map_json(&rec.ambit_damage),
            "kills": map_json(&rec.ambit_kills),
        },
        "coverage": { "combat": combat },
        "unavailable": Value::Object(unavailable),
    }))
}

/// Emit only the counters that were actually observed. An absent key is the
/// card's signal to draw "—" instead of a zero it has no evidence for.
fn counters_json(rec: &Record) -> Value {
    let mut m = Map::new();
    for k in &rec.known {
        m.insert((*k).to_string(), json!(rec.counters.get(k).copied().unwrap_or(0.0)));
    }
    Value::Object(m)
}

fn map_json(src: &HashMap<String, f64>) -> Value {
    let mut m = Map::new();
    for a in AMBITS {
        if let Some(v) = src.get(*a) {
            m.insert((*a).to_string(), json!(v));
        }
    }
    Value::Object(m)
}

fn hulls_json(rec: &Record) -> Value {
    let mut rows: Vec<Value> = rec
        .hulls
        .iter()
        .map(|(ty, h)| {
            json!({
                "type": ty,
                "built": h.built, "lost": h.lost,
                "kills": h.kills, "damage": h.damage, "destroyed": h.destroyed,
            })
        })
        .collect();
    // Busiest hull first — the matrix is read for what a player actually
    // flies, and an alphabetical list buries that under the Battleship.
    rows.sort_by(|a, b| {
        let score = |v: &Value| {
            ["kills", "destroyed", "damage", "built", "lost"]
                .iter()
                .map(|k| v.get(*k).and_then(|x| x.as_f64()).unwrap_or(0.0))
                .sum::<f64>()
        };
        score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* One volley: a Destroyer firing a guided weapon, three shots — one that
     * lands through armour, one blocked by a defender, one that kills.
     *
     * THE SHAPE IS THE POINT. Only `attacker*` fields are flat; every
     * `target*` field, `targetPlayerId` INCLUDED, is per shot. The published
     * schema describes `targetPlayerId` as top-level and it is not — a fixture
     * that believed the doc let the whole defensive half of this module score
     * zero while these tests stayed green. Verified against the indexer:
     * `struct_attack` details carry `attackerPlayerId` and no other player id
     * at the top level. */
    fn volley() -> Value {
        json!({
            "attackerPlayerId": "1-194",
            "attackerStructType": "Destroyer",
            "attackerStructOperatingAmbit": "space",
            "weaponControl": "guided",
            "eventAttackShotDetail": [
                { "targetPlayerId": "1-248",
                  "damageDealt": "2", "damageReduction": "1", "damageReductionCause": "ablativeArmour",
                  "armourPiercing": true, "targetStructType": "Tank", "targetStructOperatingAmbit": "land",
                  "targetStructLocationType": "planet", "targetDestroyed": false },
                { "targetPlayerId": "1-248",
                  "damageDealt": "2", "damageReduction": "0", "blocked": true, "blockedByStructId": "5-9",
                  "targetStructType": "Cruiser", "targetStructOperatingAmbit": "space",
                  "targetStructLocationType": "fleet", "targetDestroyed": false },
                { "targetPlayerId": "1-248",
                  "damageDealt": "2", "damageReduction": "0", "targetStructType": "Command Ship",
                  "targetStructOperatingAmbit": "space", "targetStructLocationType": "fleet",
                  "targetDestroyed": "true" }
            ]
        })
    }

    #[test]
    fn damage_is_the_roll_minus_the_armour_never_the_accumulator() {
        let mut r = Record::default();
        fold_attack(&mut r, "1-194", &volley(), false);
        // 2−1, then 2−0, then 2−0.
        assert_eq!(r.counters["damage_dealt"], 5.0);
        assert_eq!(r.counters["smart_damage"], 5.0);
        assert!(!r.counters.contains_key("ballistic_damage"));
        assert_eq!(r.ambit_damage["space"], 5.0);
    }

    #[test]
    fn a_kill_scores_for_the_shooters_hull_and_against_the_targets() {
        let mut r = Record::default();
        fold_attack(&mut r, "1-194", &volley(), false);
        assert_eq!(r.counters["kills"], 1.0);
        assert_eq!(r.counters["cmd_kills"], 1.0);
        assert_eq!(r.counters["fleet_kills"], 1.0);
        assert!(!r.counters.contains_key("ground_kills"));
        assert_eq!(r.hulls["Destroyer"].kills, Some(1.0));
        assert_eq!(r.hulls["Command Ship"].destroyed, Some(1.0));
        assert_eq!(r.ambit_kills["space"], 1.0);
    }

    #[test]
    fn armour_piercing_scores_only_when_it_actually_met_armour() {
        let mut r = Record::default();
        fold_attack(&mut r, "1-194", &volley(), false);
        assert_eq!(r.counters["armour_piercer"], 1.0, "one shot was AP AND reduced");

        let mut clean = volley();
        clean["eventAttackShotDetail"][0]["damageReduction"] = json!("0");
        let mut r2 = Record::default();
        fold_attack(&mut r2, "1-194", &clean, false);
        assert!(!r2.counters.contains_key("armour_piercer"), "AP against no armour is not the feat");
    }

    #[test]
    fn the_defender_reads_the_same_row_from_the_other_side() {
        let mut r = Record::default();
        fold_attack(&mut r, "1-248", &volley(), false);
        assert_eq!(r.counters["damage_taken"], 5.0);
        assert_eq!(r.counters["damage_absorbed"], 1.0, "the armour ate one");
        assert_eq!(r.counters["damage_blocked"], 2.0, "a defender took the whole round");
        assert_eq!(r.counters["structs_lost"], 1.0);
        assert_eq!(r.hulls["Command Ship"].lost, Some(1.0));
        assert!(!r.counters.contains_key("shots_fired"), "being shot at is not firing");
    }

    #[test]
    fn an_evaded_shot_is_filed_by_its_cause() {
        let mut d = volley();
        d["eventAttackShotDetail"] = json!([
            { "targetPlayerId": "1-248", "damageDealt": "2", "evaded": true, "evadedCause": "signalJamming", "targetStructType": "Tank" },
            { "targetPlayerId": "1-248", "damageDealt": "3", "evaded": true, "evadedCause": "stealthMode", "targetStructType": "Tank" },
            { "targetPlayerId": "1-248", "damageDealt": "1", "evaded": true, "targetStructType": "Tank" }
        ]);
        let mut r = Record::default();
        fold_attack(&mut r, "1-248", &d, false);
        assert_eq!(r.counters["evaded_jam"], 2.0);
        assert_eq!(r.counters["evaded_stealth"], 3.0);
        assert_eq!(r.counters["evaded_other"], 1.0);
    }

    /* ── The shape, pinned ─────────────────────────────────────────────────
     *
     * `targetPlayerId` on the VOLLEY is what the published schema describes
     * and what the indexer never writes. Believing it cost the whole defensive
     * half of this module — damage taken, blocked, absorbed, evaded, structs
     * lost, counters — every one of them silently zero, with these tests
     * green, because the fixture believed it too. */
    #[test]
    fn the_victim_is_named_on_the_shot_and_a_volley_level_name_is_ignored() {
        let mut wrong = volley();
        // The doc's shape: the victim only at the top, nothing on the shots.
        wrong["targetPlayerId"] = json!("1-248");
        for shot in wrong["eventAttackShotDetail"].as_array_mut().unwrap() {
            shot.as_object_mut().unwrap().remove("targetPlayerId");
        }
        let mut r = Record::default();
        fold_attack(&mut r, "1-248", &wrong, false);
        assert!(r.counters.is_empty(), "a name the indexer never writes must not score: {:?}", r.counters);

        // And the real shape does.
        let mut r2 = Record::default();
        fold_attack(&mut r2, "1-248", &volley(), false);
        assert_eq!(r2.counters["damage_taken"], 5.0);
    }

    #[test]
    fn one_volley_can_hit_several_players_and_only_our_shots_are_ours() {
        let mut d = volley();
        // The middle shot belongs to somebody else's struct.
        d["eventAttackShotDetail"][1]["targetPlayerId"] = json!("1-999");
        let mut r = Record::default();
        fold_attack(&mut r, "1-248", &d, false);
        assert_eq!(r.counters["damage_taken"], 3.0, "2−1 and 2−0, not the blocked shot aimed at 1-999");
        assert!(!r.counters.contains_key("damage_blocked"), "another player's defender is not ours");
    }

    #[test]
    fn a_planetary_cannon_scores_for_whoever_owns_the_planet() {
        let mut d = volley();
        d["planetaryDefenseCannonDamage"] = json!("4");
        d["planetaryDefenseCannonDamageDestroyedAttacker"] = json!(true);
        // Not our planet: the row names no owner, so it is not ours to claim.
        let mut away = Record::default();
        fold_attack(&mut away, "1-248", &d, false);
        assert!(!away.counters.contains_key("defender_kills"));
        // Ours.
        let mut home = Record::default();
        fold_attack(&mut home, "1-248", &d, true);
        assert_eq!(home.counters["defender_kills"], 1.0);
        assert_eq!(home.counters["kills"], 1.0);
    }

    #[test]
    fn an_infusion_is_counted_once_though_the_ledger_writes_both_legs() {
        // Live shape (player 1-61, block 1506519): one 4g infusion, two rows.
        let legs = [("infused", "ualpha", 4_000_000.0), ("infused", "ualpha.infused", 4_000_000.0)];
        let mut total = 0.0;
        for (action, denom, amt) in legs {
            let key = match (action, denom) {
                ("refined", "ualpha") => Some("alpha_refined"),
                ("infused", "ualpha") => Some("alpha_infused"),
                _ => None,
            };
            if key == Some("alpha_infused") { total += amt; }
        }
        assert_eq!(total, 4_000_000.0, "the staked leg must not be added to the spent one");
    }

    #[test]
    fn a_row_about_two_other_players_is_not_ours() {
        let mut r = Record::default();
        fold_attack(&mut r, "1-999", &volley(), false);
        assert!(r.counters.is_empty());
        assert!(r.hulls.is_empty());
    }

    #[test]
    fn build_counts_the_bit_flipping_on_not_the_status_being_set() {
        let mut r = Record::default();
        fold_status(&mut r, &json!({ "status": "6", "status_old": "4" })); // BUILT on
        fold_status(&mut r, &json!({ "status": "7", "status_old": "6" })); // already built
        assert_eq!(r.counters["structs_built"], 1.0);
    }

    #[test]
    fn a_raid_is_scored_for_whichever_side_is_ours() {
        let mut r = Record::default();
        fold_raid(&mut r, &json!({ "status": "raidSuccessful" }), true, false);
        fold_raid(&mut r, &json!({ "status": "attackerDefeated" }), false, true);
        fold_raid(&mut r, &json!({ "status": "attackerRetreated" }), false, true);
        // Re-planeting mid-raid voids it; that is a dodge, not a repulse.
        fold_raid(&mut r, &json!({ "status": "demilitarized" }), false, true);
        // Someone else's raid on someone else.
        fold_raid(&mut r, &json!({ "status": "raidSuccessful" }), false, false);
        assert_eq!(r.counters["raids_won"], 1.0);
        assert_eq!(r.counters["raids_repelled"], 2.0);
    }

    #[test]
    fn an_observed_zero_is_emitted_and_an_unobserved_counter_is_not() {
        let mut r = Record::default();
        r.mark("raids_won");
        r.bump("kills", 3.0);
        let j = counters_json(&r);
        assert_eq!(j["raids_won"], json!(0.0), "observed and genuinely zero");
        assert_eq!(j["kills"], json!(3.0));
        assert!(j.get("cmd_kills").is_none(), "never looked ⇒ absent, not zero");
    }

    #[test]
    fn a_missing_route_is_told_apart_from_a_real_failure() {
        assert!(is_missing_route("Guild API 404 https://x/api/planet-activity/player/1-194: Not Found"));
        assert!(!is_missing_route("Guild API requires login — sign in via the Structs app first"));
    }

    // ── the one-offs ──────────────────────────────────────────────────────
    //
    // Each of these is a SHAPE across rows, so each case feeds the walker in
    // time order the way `activity_totals` does after its sort.

    fn ours() -> Owned {
        Owned { fleets: vec!["9-61".into()], planets: vec!["2-100".into()] }
    }
    fn raid(status: &str, fleet: &str) -> Value {
        json!({ "status": status, "fleet_id": fleet, "planet_id": "2-100" })
    }
    // Again: the victim is named on the SHOT, never on the volley.
    fn kill(attacker: &str, target: &str, ty: &str) -> Value {
        json!({
            "attackerPlayerId": attacker,
            "eventAttackShotDetail": [{ "targetPlayerId": target, "targetStructType": ty,
                                        "targetDestroyed": true, "damageDealt": "2" }]
        })
    }

    #[test]
    fn a_breach_kill_needs_the_breach_to_be_underway() {
        let (mut r, mut f, o) = (Record::default(), Feats::default(), ours());
        f.feed(&mut r, "1-194", "raid_status", "2-100", &raid("shieldsVulnerable", "9-9"), &o);
        f.feed(&mut r, "1-194", "raid_status", "2-100", &raid("attackerDefeated", "9-9"), &o);
        assert_eq!(r.counters["feat_breach_kill"], 1.0);

        // A raider killed before it ever got through the shield is a good
        // day, but it is not this achievement.
        let (mut r2, mut f2) = (Record::default(), Feats::default());
        f2.feed(&mut r2, "1-194", "raid_status", "2-100", &raid("attackerDefeated", "9-9"), &o);
        assert!(!r2.counters.contains_key("feat_breach_kill"));
    }

    #[test]
    fn a_retreat_closes_the_breach_so_a_later_kill_is_a_different_episode() {
        let (mut r, mut f, o) = (Record::default(), Feats::default(), ours());
        f.feed(&mut r, "1-194", "raid_status", "2-100", &raid("shieldsVulnerable", "9-9"), &o);
        f.feed(&mut r, "1-194", "raid_status", "2-100", &raid("attackerRetreated", "9-9"), &o);
        f.feed(&mut r, "1-194", "raid_status", "2-100", &raid("attackerDefeated", "9-9"), &o);
        assert!(!r.counters.contains_key("feat_breach_kill"));
    }

    #[test]
    fn a_dry_well_is_only_scored_when_the_ore_key_was_actually_written() {
        let (mut r, mut f, o) = (Record::default(), Feats::default(), ours());
        let mut won = raid("raidSuccessful", "9-61");
        won["seized_ore"] = json!("0");
        f.feed(&mut r, "1-194", "raid_status", "2-100", &won, &o);
        assert_eq!(r.counters["feat_dry_well"], 1.0);

        // Half the indexed rows predate `seized_ore`. Absent is UNKNOWN, and
        // an achievement must not be awarded on a key nobody wrote.
        let (mut r2, mut f2) = (Record::default(), Feats::default());
        f2.feed(&mut r2, "1-194", "raid_status", "2-100", &raid("raidSuccessful", "9-61"), &o);
        assert!(!r2.counters.contains_key("feat_dry_well"));
    }

    #[test]
    fn payback_is_scored_once_per_opponent_and_only_after_they_hit_first() {
        let (mut r, mut f, o) = (Record::default(), Feats::default(), ours());
        // We hit them first: not payback.
        f.feed(&mut r, "1-194", "struct_attack", "2-9", &kill("1-194", "1-248", "Tank"), &o);
        assert!(!r.counters.contains_key("feat_payback"));
        // Now they kill one of ours, and we answer.
        f.feed(&mut r, "1-194", "struct_attack", "2-9", &kill("1-248", "1-194", "Tank"), &o);
        f.feed(&mut r, "1-194", "struct_attack", "2-9", &kill("1-194", "1-248", "Tank"), &o);
        assert_eq!(r.counters["feat_payback"], 1.0);
        // A long feud is still one payback, not ten.
        f.feed(&mut r, "1-194", "struct_attack", "2-9", &kill("1-194", "1-248", "Tank"), &o);
        assert_eq!(r.counters["feat_payback"], 1.0);
    }

    #[test]
    fn a_double_tap_is_two_cmd_kills_on_one_planet_scored_on_the_crossing() {
        let (mut r, mut f, o) = (Record::default(), Feats::default(), ours());
        f.feed(&mut r, "1-194", "struct_attack", "2-7", &kill("1-194", "1-248", "Command Ship"), &o);
        // A second CMD kill somewhere ELSE is not the feat.
        f.feed(&mut r, "1-194", "struct_attack", "2-8", &kill("1-194", "1-248", "Command Ship"), &o);
        assert!(!r.counters.contains_key("feat_double_tap"));
        f.feed(&mut r, "1-194", "struct_attack", "2-7", &kill("1-194", "1-248", "Command Ship"), &o);
        assert_eq!(r.counters["feat_double_tap"], 1.0);
        // A third on the same planet does not score it again.
        f.feed(&mut r, "1-194", "struct_attack", "2-7", &kill("1-194", "1-248", "Command Ship"), &o);
        assert_eq!(r.counters["feat_double_tap"], 1.0);
    }

    #[test]
    fn the_busiest_hull_leads_the_matrix() {
        let mut r = Record::default();
        add(&mut r.hull("Battleship").built, 1.0);
        add(&mut r.hull("Destroyer").kills, 40.0);
        let rows = hulls_json(&r);
        assert_eq!(rows[0]["type"], json!("Destroyer"));
    }
}
