//! Typed ids and units, parsed once at the boundary.
//!
//! Every value here wraps the exact string or integer the chain uses and
//! gives it back unchanged through `Display`, so nothing on the wire, in
//! the ledger, or on disk changes shape. What changes is that a struct id
//! can no longer be handed to a function that wants a player, an attribute
//! id is split by its grammar rather than by the first dash, and a floored
//! display amount cannot be mistaken for base units.
//!
//! Bugs on record that this module makes uncompilable (2026-09-04/05): a
//! struct id keyed into a player charge reservation; an attribute id split
//! on the wrong dash; a numeric `type` field handled as a string; `amount`
//! (floored Alpha) used where `amount_p` (ualpha) was meant.
//!
//! Rules: inner values are private; construction goes through `parse` /
//! `from_index`; only the families with a bug on record get a type.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

/// The chain's object-type digit, the first segment of every object id.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[repr(u8)]
pub enum ObjectKind {
    Guild = 0,
    Player = 1,
    Planet = 2,
    Reactor = 3,
    Substation = 4,
    Struct = 5,
    Allocation = 6,
    Infusion = 7,
    Address = 8,
    Fleet = 9,
    Provider = 10,
    Agreement = 11,
}

impl ObjectKind {
    pub fn from_digit(d: u8) -> Option<Self> {
        Some(match d {
            0 => Self::Guild,
            1 => Self::Player,
            2 => Self::Planet,
            3 => Self::Reactor,
            4 => Self::Substation,
            5 => Self::Struct,
            6 => Self::Allocation,
            7 => Self::Infusion,
            8 => Self::Address,
            9 => Self::Fleet,
            10 => Self::Provider,
            11 => Self::Agreement,
            _ => return None,
        })
    }
    pub fn digit(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdError(pub String);

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for IdError {}

fn split_object_id(s: &str) -> Result<(ObjectKind, u64), IdError> {
    let s = s.trim();
    let (kind, index) = s.split_once('-').ok_or_else(|| IdError(format!("object id {s:?}: no '-'")))?;
    if kind.is_empty() || index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return Err(IdError(format!("object id {s:?}: expected <type>-<index>")));
    }
    let kind: u8 = kind.parse().map_err(|_| IdError(format!("object id {s:?}: bad type digit")))?;
    let kind = ObjectKind::from_digit(kind).ok_or_else(|| IdError(format!("object id {s:?}: unknown type {kind}")))?;
    let index: u64 = index.parse().map_err(|_| IdError(format!("object id {s:?}: bad index")))?;
    Ok((kind, index))
}

macro_rules! object_id {
    ($name:ident, $kind:expr, $label:literal) => {
        /// A validated chain object id. `Display` yields the exact wire string.
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub fn parse(s: &str) -> Result<Self, IdError> {
                let (kind, index) = split_object_id(s)?;
                if kind != $kind {
                    return Err(IdError(format!("{:?} is not a {}", s, $label)));
                }
                Ok(Self(format!("{}-{index}", $kind.digit())))
            }
            pub fn from_index(index: u64) -> Self {
                Self(format!("{}-{index}", $kind.digit()))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
            pub fn index(&self) -> u64 {
                self.0.split_once('-').and_then(|(_, i)| i.parse().ok()).unwrap_or(0)
            }
            /// The same id as a kind-tagged [`ObjectId`].
            pub fn object_id(&self) -> ObjectId {
                ObjectId { kind: $kind, index: self.index() }
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", $label, self.0)
            }
        }
        impl FromStr for $name {
            type Err = IdError;
            fn from_str(s: &str) -> Result<Self, IdError> {
                Self::parse(s)
            }
        }
        impl TryFrom<&str> for $name {
            type Error = IdError;
            fn try_from(s: &str) -> Result<Self, IdError> {
                Self::parse(s)
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.0)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Self::parse(&s).map_err(serde::de::Error::custom)
            }
        }
    };
}

object_id!(GuildId, ObjectKind::Guild, "guild");
object_id!(PlayerId, ObjectKind::Player, "player");
object_id!(PlanetId, ObjectKind::Planet, "planet");
object_id!(StructId, ObjectKind::Struct, "struct");
object_id!(FleetId, ObjectKind::Fleet, "fleet");

/// Any chain object id, kind-tagged.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ObjectId {
    pub kind: ObjectKind,
    pub index: u64,
}

impl ObjectId {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        let (kind, index) = split_object_id(s)?;
        Ok(Self { kind, index })
    }
    pub fn as_player(&self) -> Option<PlayerId> {
        (self.kind == ObjectKind::Player).then(|| PlayerId::from_index(self.index))
    }
    pub fn as_planet(&self) -> Option<PlanetId> {
        (self.kind == ObjectKind::Planet).then(|| PlanetId::from_index(self.index))
    }
    pub fn as_struct(&self) -> Option<StructId> {
        (self.kind == ObjectKind::Struct).then(|| StructId::from_index(self.index))
    }
    pub fn as_fleet(&self) -> Option<FleetId> {
        (self.kind == ObjectKind::Fleet).then(|| FleetId::from_index(self.index))
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.kind.digit(), self.index)
    }
}

/// `"<attr>-<objectType>-<objectIndex>[-<sub>]"`, the id grammar of the
/// chain's struct_attribute / planet_attribute / grid stores (e.g.
/// `12-2-23537` = blockStartOreMine of planet 2-23537; `6-1-100-1` = the
/// typeCount of type 1 for player 1-100, which carries a sub index).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct AttributeId {
    pub attr: u8,
    pub object: ObjectId,
    pub sub: Option<u64>,
}

impl AttributeId {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        let parts: Vec<&str> = s.trim().split('-').collect();
        if parts.len() != 3 && parts.len() != 4 {
            return Err(IdError(format!("attribute id {s:?}: expected 3 or 4 segments")));
        }
        let num = |p: &str, what: &str| -> Result<u64, IdError> {
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(IdError(format!("attribute id {s:?}: bad {what}")));
            }
            p.parse().map_err(|_| IdError(format!("attribute id {s:?}: bad {what}")))
        };
        let attr = num(parts[0], "attribute index")? as u8;
        let kind = ObjectKind::from_digit(num(parts[1], "object type")? as u8)
            .ok_or_else(|| IdError(format!("attribute id {s:?}: unknown object type")))?;
        let index = num(parts[2], "object index")?;
        let sub = if parts.len() == 4 { Some(num(parts[3], "sub index")?) } else { None };
        Ok(Self { attr, object: ObjectId { kind, index }, sub })
    }
    pub fn new(attr: u8, object: ObjectId) -> Self {
        Self { attr, object, sub: None }
    }
}

impl fmt::Display for AttributeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.attr, self.object)?;
        if let Some(sub) = self.sub {
            write!(f, "-{sub}")?;
        }
        Ok(())
    }
}

// ── Units ───────────────────────────────────────────────────────────────

pub const UALPHA_PER_ALPHA: u64 = 1_000_000;

/// Base units of Alpha (`ualpha`). What the bank, the fee, and every
/// `amount_p` field carry. Integer, exact.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Ualpha(u64);

/// Whole Alpha as the game displays it. Lossy: a bank `amount` field is
/// this, FLOORED — never send it, convert from `Ualpha` instead.
#[derive(Clone, Copy, PartialEq, PartialOrd, Debug, Default)]
pub struct Alpha(f64);

/// Power / load in milliwatts. The chain identity is 1 ualpha = 1 mW
/// (substation pricing); it is a named conversion here, not a coincidence.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Milliwatts(u64);

impl Ualpha {
    pub const fn new(v: u64) -> Self {
        Self(v)
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn from_alpha(a: Alpha) -> Self {
        Self((a.0 * UALPHA_PER_ALPHA as f64).round().max(0.0) as u64)
    }
    pub fn to_alpha(self) -> Alpha {
        Alpha(self.0 as f64 / UALPHA_PER_ALPHA as f64)
    }
    pub fn as_milliwatts(self) -> Milliwatts {
        Milliwatts(self.0)
    }
    /// The wire form of a bank amount: plain digits.
    pub fn to_amount_string(self) -> String {
        self.0.to_string()
    }
}

impl Alpha {
    pub fn new(v: f64) -> Self {
        Self(v)
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

impl Milliwatts {
    pub const fn new(v: u64) -> Self {
        Self(v)
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn as_ualpha(self) -> Ualpha {
        Ualpha(self.0)
    }
}

/// A block height, or a clock anchored at one. Subtraction saturates: a
/// clock ahead of our view of the chain is "no age", never a wrap.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Block(u64);

impl Block {
    pub const fn new(v: u64) -> Self {
        Self(v)
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn is_zero(self) -> bool {
        self.0 == 0
    }
    /// Blocks elapsed since `earlier` (0 if `earlier` is ahead).
    pub fn since(self, earlier: Block) -> u64 {
        self.0.saturating_sub(earlier.0)
    }
}

/// A player's charge in blocks (current block − last action).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Charge(u64);

impl Charge {
    pub const fn new(v: u64) -> Self {
        Self(v)
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn covers(self, cost: u64) -> bool {
        self.0 >= cost
    }
}

impl fmt::Display for Block {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl fmt::Display for Charge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl fmt::Display for Ualpha {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ── Wire coercion ───────────────────────────────────────────────────────

/// Deserialize a field the guild API or LCD may send as a JSON number, a
/// numeric string, or null: `#[serde(default, deserialize_with =
/// "numeric")] pub field: Option<u64>`. Replaces the per-site
/// `parse_f64` / `read_u64_field` / `to_u64` hand coercions.
pub fn numeric<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: FromStr + serde::de::DeserializeOwned,
{
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Ok(None);
            }
            t.parse::<T>().map(Some).map_err(|_| serde::de::Error::custom(format!("not numeric: {s:?}")))
        }
        other => serde_json::from_value::<T>(other.clone())
            .map(Some)
            .map_err(|_| serde::de::Error::custom(format!("not numeric: {other}"))),
    }
}

// ── GRASS subjects ──────────────────────────────────────────────────────

/// Which stream a GRASS subject belongs to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SubjectFamily {
    /// `structs.planet.<planet>.<player>` — planet_activity rows.
    Planet,
    /// `structs.grid.<objtype>.<object>[.<player>]` — grid attribute changes.
    Grid,
    /// `structs.inventory.<denom>.<guild>.<player>.<address>` — bank moves.
    Inventory,
    /// `consensus` — the block heartbeat.
    Consensus,
    Other,
}

/// A NATS subject, parsed once. `object` is the id the subject is keyed on
/// (the planet, the grid object, the inventory's player), `player` the
/// owner segment when the family carries one. `has_token` is the
/// whole-segment match that replaced substring matching after the
/// `1-195` ⊂ `1-1950` incident.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Subject {
    raw: String,
    pub family: SubjectFamily,
    pub object: Option<ObjectId>,
    pub player: Option<PlayerId>,
}

impl Subject {
    pub fn parse(raw: &str) -> Self {
        let segs: Vec<&str> = raw.split('.').collect();
        let obj = |i: usize| segs.get(i).and_then(|s| ObjectId::parse(s).ok());
        let player_at = |i: usize| segs.get(i).and_then(|s| PlayerId::parse(s).ok());
        let (family, object, player) = match segs.as_slice() {
            ["consensus", ..] => (SubjectFamily::Consensus, None, None),
            ["structs", "planet", ..] => (SubjectFamily::Planet, obj(2), player_at(3)),
            ["structs", "grid", ..] => (SubjectFamily::Grid, obj(3), player_at(4)),
            ["structs", "inventory", ..] => (SubjectFamily::Inventory, player_at(4).map(|p| ObjectId { kind: ObjectKind::Player, index: p.index() }), player_at(4)),
            _ => (SubjectFamily::Other, None, None),
        };
        Self { raw: raw.to_string(), family, object, player }
    }
    pub fn as_str(&self) -> &str {
        &self.raw
    }
    /// Does a WHOLE dot-delimited segment equal `token`?
    pub fn has_token(&self, token: &str) -> bool {
        self.raw.split('.').any(|seg| seg == token)
    }
}

impl fmt::Display for Subject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.raw)
    }
}

// ── Work kinds ──────────────────────────────────────────────────────────

/// The kinds of proof-of-work the chain issues and accepts a completion for.
/// The wire strings are the chain's own (`MINE` / `REFINE` / `BUILD` /
/// `RAID`); they appear in hash-task params, ledger rows, chat offers and
/// the work prefix (`5-2184MINE812004NONCE…`), and [`TaskType::as_str`]
/// gives them back unchanged. Parsing is case-insensitive because the
/// Comms window and the MCP take a human's spelling.
///
/// A NONCE is not typed here on purpose: the chain accepts any string, and
/// only our grinders happen to iterate integers.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TaskType {
    Mine,
    Refine,
    Build,
    Raid,
}

impl TaskType {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "MINE" => Some(Self::Mine),
            "REFINE" => Some(Self::Refine),
            "BUILD" => Some(Self::Build),
            "RAID" => Some(Self::Raid),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mine => "MINE",
            Self::Refine => "REFINE",
            Self::Build => "BUILD",
            Self::Raid => "RAID",
        }
    }
    /// Mine and refine share the planet's ore clock (chain v0.21.0).
    pub fn is_ore(self) -> bool {
        matches!(self, Self::Mine | Self::Refine)
    }
    /// The PLANET attribute carrying this kind's clock. Build anchors on the
    /// struct (`blockStartBuild`); a raid on the fleet's own work record.
    pub fn planet_clock_attr(self) -> Option<&'static str> {
        match self {
            Self::Mine => Some("blockStartOreMine"),
            Self::Refine => Some("blockStartOreRefine"),
            Self::Build | Self::Raid => None,
        }
    }
    /// The completion message for a solved proof of this kind.
    pub fn completion_type_url(self) -> &'static str {
        match self {
            Self::Mine => "/structs.structs.MsgStructOreMinerComplete",
            Self::Refine => "/structs.structs.MsgStructOreRefineryComplete",
            Self::Build => "/structs.structs.MsgStructBuildComplete",
            Self::Raid => "/structs.structs.MsgPlanetRaidComplete",
        }
    }
    /// Completion payload. `creator` is injected by the signer. A raid's
    /// object is the FLEET, so its field is `fleetId`.
    pub fn completion_payload(self, object_id: &str, proof: &str, nonce: &str) -> serde_json::Value {
        match self {
            Self::Raid => serde_json::json!({ "fleetId": object_id, "proof": proof, "nonce": nonce }),
            _ => serde_json::json!({ "structId": object_id, "proof": proof, "nonce": nonce }),
        }
    }
}

impl fmt::Display for TaskType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a struct stands: on a planet or in a fleet. The wire strings
/// (`planet` / `fleet`) are the chain's `locationType` values.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum LocationKind {
    Planet,
    Fleet,
}

impl LocationKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "planet" => Some(Self::Planet),
            "fleet" => Some(Self::Fleet),
            _ => None,
        }
    }
    pub fn of(id: &ObjectId) -> Option<Self> {
        match id.kind {
            ObjectKind::Planet => Some(Self::Planet),
            ObjectKind::Fleet => Some(Self::Fleet),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planet => "planet",
            Self::Fleet => "fleet",
        }
    }
    /// The wrapper key of the LCD entity (`{"Planet": …}` / `{"Fleet": …}`).
    pub fn lcd_wrapper(self) -> &'static str {
        match self {
            Self::Planet => "Planet",
            Self::Fleet => "Fleet",
        }
    }
}

impl fmt::Display for LocationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ── Ledger context ──────────────────────────────────────────────────────

/// The `<source>[:<subject>]` label every transaction carries into the
/// ledger (`tx_attempts.context`), the priority gate, and the board feed.
///
/// The subject is the one thing the label is READ for: the charge
/// reservation keys on the PLAYER it names, and a struct id there
/// (`pow_complete:5-234309`) once keyed a reservation on a struct and let
/// two actions for the same player race into one block. Built through
/// [`Context::player_action`] / [`Context::completion`] the distinction is
/// in the type; built through [`Context::parse`] from a free string it is
/// decided once, here, and never re-parsed downstream. `as_str` yields the
/// exact label, so the ledger and the gate see what they always saw.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Context {
    text: String,
    player: Option<PlayerId>,
    subject: Option<String>,
}

impl Context {
    /// A free-form label, `<source>[:<subject>[:…]]`. The subject is the
    /// second colon-separated token; it names a player only if it parses
    /// as one.
    pub fn parse(text: &str) -> Self {
        let subject = text.split(':').nth(1).filter(|s| !s.is_empty()).map(String::from);
        let player = subject.as_deref().and_then(|s| PlayerId::parse(s).ok());
        Self { text: text.to_string(), player, subject }
    }
    /// A loop or tool acting AS `player`: `auto_build:1-271`.
    pub fn player_action(source: &str, player: &PlayerId) -> Self {
        Self {
            text: format!("{source}:{player}"),
            player: Some(player.clone()),
            subject: Some(player.to_string()),
        }
    }
    /// A proof-of-work completion for `object`: `pow_complete:5-234309`.
    /// Names no player — the reservation comes from the struct's owner.
    pub fn completion(object: &StructId) -> Self {
        Self {
            text: format!("pow_complete:{object}"),
            player: None,
            subject: Some(object.to_string()),
        }
    }
    pub fn as_str(&self) -> &str {
        &self.text
    }
    /// The head before the first colon (`auto_build`, `pow_complete`, …).
    pub fn source(&self) -> &str {
        self.text.split(':').next().unwrap_or(&self.text)
    }
    /// The player this context acts as, if it names one.
    pub fn player(&self) -> Option<&PlayerId> {
        self.player.as_ref()
    }
    /// The raw second token, whatever it is (the ledger's `player_id` column
    /// has always carried it verbatim, struct ids included).
    pub fn subject(&self) -> Option<&str> {
        self.subject.as_deref()
    }
}

impl fmt::Display for Context {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl From<&str> for Context {
    fn from(s: &str) -> Self {
        Self::parse(s)
    }
}
impl From<&String> for Context {
    fn from(s: &String) -> Self {
        Self::parse(s)
    }
}
impl From<String> for Context {
    fn from(s: String) -> Self {
        Self::parse(&s)
    }
}
impl From<&Context> for Context {
    fn from(c: &Context) -> Self {
        c.clone()
    }
}

// ── LCD entity view ─────────────────────────────────────────────────────

/// Typed reads over an LCD entity (`{"Struct": {...}, "structAttributes":
/// {...}, "gridAttributes": {...}}` / `{"Planet": ..., "planetAttributes":
/// ...}` / `{"Player": ...}`). The chain serialises every number as a
/// string; this is the one place that fact is handled.
pub struct EntityView<'a>(pub &'a serde_json::Value);

impl<'a> EntityView<'a> {
    pub fn new(v: &'a serde_json::Value) -> Self {
        Self(v)
    }
    fn field_u64(&self, section: &str, name: &str) -> u64 {
        self.0
            .get(section)
            .and_then(|s| s.get(name))
            .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|t| t.trim().parse().ok())))
            .unwrap_or(0)
    }
    fn field_f64(&self, section: &str, name: &str) -> f64 {
        self.0
            .get(section)
            .and_then(|s| s.get(name))
            .and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|t| t.trim().parse().ok())))
            .unwrap_or(0.0)
    }
    fn field_str(&self, section: &str, name: &str) -> Option<&'a str> {
        self.0.get(section).and_then(|s| s.get(name)).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
    }
    /// A struct attribute that is a block (build / mine / refine clocks).
    pub fn struct_block(&self, name: &str) -> Block {
        Block::new(self.field_u64("structAttributes", name))
    }
    pub fn struct_attr_u64(&self, name: &str) -> u64 {
        self.field_u64("structAttributes", name)
    }
    /// A planet attribute that is a block (ore clocks, raid start).
    pub fn planet_block(&self, name: &str) -> Block {
        Block::new(self.field_u64("planetAttributes", name))
    }
    pub fn planet_attr_u64(&self, name: &str) -> u64 {
        self.field_u64("planetAttributes", name)
    }
    /// The player's last charged action, as a block.
    pub fn last_action(&self) -> Block {
        Block::new(self.field_u64("gridAttributes", "lastAction"))
    }
    pub fn grid_u64(&self, name: &str) -> u64 {
        self.field_u64("gridAttributes", name)
    }
    pub fn grid_f64(&self, name: &str) -> f64 {
        self.field_f64("gridAttributes", name)
    }
    pub fn struct_owner(&self) -> Option<PlayerId> {
        self.field_str("Struct", "owner").and_then(|s| PlayerId::parse(s).ok())
    }
    pub fn struct_location(&self) -> Option<ObjectId> {
        self.field_str("Struct", "locationId").and_then(|s| ObjectId::parse(s).ok())
    }
    pub fn player_planet(&self) -> Option<PlanetId> {
        self.field_str("Player", "planetId").and_then(|s| PlanetId::parse(s).ok())
    }
    pub fn player_fleet(&self) -> Option<FleetId> {
        self.field_str("Player", "fleetId").and_then(|s| FleetId::parse(s).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_types_round_trip_the_chain_strings_and_know_their_clocks() {
        for (s, t) in [("MINE", TaskType::Mine), ("refine", TaskType::Refine), (" Build ", TaskType::Build), ("RAID", TaskType::Raid)] {
            assert_eq!(TaskType::parse(s), Some(t));
        }
        assert_eq!(TaskType::parse("HARVEST"), None);
        assert_eq!(TaskType::Refine.as_str(), "REFINE");
        assert_eq!(TaskType::Mine.planet_clock_attr(), Some("blockStartOreMine"));
        assert_eq!(TaskType::Refine.planet_clock_attr(), Some("blockStartOreRefine"));
        assert_eq!(TaskType::Build.planet_clock_attr(), None);
        assert!(TaskType::Mine.is_ore() && !TaskType::Build.is_ore());
        // A raid's completion names the FLEET; the nonce is an opaque string.
        let p = TaskType::Raid.completion_payload("9-194", "abc", "not-a-number");
        assert_eq!(p["fleetId"], "9-194");
        assert_eq!(p["nonce"], "not-a-number");
        assert_eq!(TaskType::Build.completion_payload("5-1", "h", "7")["structId"], "5-1");
    }

    #[test]
    fn contexts_keep_their_exact_label_and_name_only_players() {
        // Pinned wire strings — the ledger has years of these.
        let c = Context::player_action("auto_defend", &PlayerId::parse("1-635").unwrap());
        assert_eq!(c.as_str(), "auto_defend:1-635");
        assert_eq!(c.player().map(|p| p.as_str()), Some("1-635"));
        assert_eq!(c.subject(), Some("1-635"));
        assert_eq!(c.source(), "auto_defend");
        let c = Context::completion(&StructId::parse("5-234309").unwrap());
        assert_eq!(c.as_str(), "pow_complete:5-234309");
        assert_eq!(c.player(), None, "a struct id is not a player");
        assert_eq!(c.subject(), Some("5-234309"), "the ledger column keeps the raw token");
        // Free strings: the same answers the two hand parsers used to give.
        assert_eq!(Context::parse("auto_raid_abort:1-2308").player().map(|p| p.as_str()), Some("1-2308"));
        assert_eq!(Context::parse("pow_complete:5-234309").player(), None);
        assert_eq!(Context::parse("pow_complete:").subject(), None);
        assert_eq!(Context::parse("nocolon").subject(), None);
        assert_eq!(Context::parse("launch:").player(), None);
        assert_eq!(Context::parse("board:transfer").subject(), Some("transfer"));
        assert_eq!(Context::parse("comms agreement 11-3").subject(), None);
        assert_eq!(Context::parse("mcp").as_str(), "mcp");
    }

    #[test]
    fn location_kinds_follow_the_object_kind() {
        assert_eq!(LocationKind::of(&ObjectId::parse("2-5").unwrap()), Some(LocationKind::Planet));
        assert_eq!(LocationKind::of(&ObjectId::parse("9-5").unwrap()), Some(LocationKind::Fleet));
        assert_eq!(LocationKind::of(&ObjectId::parse("5-5").unwrap()), None);
        assert_eq!(LocationKind::parse("Fleet").map(|k| k.lcd_wrapper()), Some("Fleet"));
        assert_eq!(FleetId::from_index(194).object_id(), ObjectId::parse("9-194").unwrap());
    }

    #[test]
    fn object_ids_round_trip_and_reject_the_wrong_kind() {
        let p = PlayerId::parse("1-195").unwrap();
        assert_eq!(p.to_string(), "1-195");
        assert_eq!(p.index(), 195);
        assert_eq!(PlayerId::from_index(195), p);
        assert!(PlayerId::parse("5-234309").is_err(), "a struct is not a player");
        assert!(StructId::parse("5-234309").is_ok());
        assert!(PlanetId::parse("2-27693").is_ok());
        assert!(FleetId::parse("9-194").is_ok());
        assert!(GuildId::parse("0-1").is_ok());
        for bad in ["1-", "-195", "1-195x", "x-195", "195", "", "1-195-3", "13-1"] {
            assert!(PlayerId::parse(bad).is_err(), "{bad:?} must not parse");
        }
        // Whole-value equality: the prefix-collision class cannot recur.
        assert_ne!(PlayerId::parse("1-195").unwrap(), PlayerId::parse("1-1950").unwrap());
        assert_eq!(PlayerId::parse(" 1-195 ").unwrap().as_str(), "1-195", "surrounding whitespace is not part of the id");
        let o = ObjectId::parse("9-285").unwrap();
        assert_eq!(o.kind, ObjectKind::Fleet);
        assert!(o.as_fleet().is_some() && o.as_player().is_none());
        assert_eq!(o.to_string(), "9-285");
    }

    #[test]
    fn attribute_ids_follow_the_store_grammar() {
        let a = AttributeId::parse("12-2-23537").unwrap();
        assert_eq!((a.attr, a.object.kind, a.object.index, a.sub), (12, ObjectKind::Planet, 23537, None));
        assert_eq!(a.to_string(), "12-2-23537");
        let t = AttributeId::parse("6-1-100-1").unwrap();
        assert_eq!(t.sub, Some(1));
        assert_eq!(t.to_string(), "6-1-100-1");
        assert!(AttributeId::parse("12-2").is_err());
        assert!(AttributeId::parse("12-2-x").is_err());
        assert!(AttributeId::parse("12-2-23537-1-1").is_err());
        assert_eq!(AttributeId::new(13, ObjectId::parse("2-27693").unwrap()).to_string(), "13-2-27693");
    }

    #[test]
    fn units_convert_exactly_and_the_floor_is_visible() {
        // The bug: `amount` (floored Alpha) rendered a 2-Alpha credit as 0.
        let credit = Ualpha::new(2_000_000);
        assert_eq!(credit.to_alpha().get(), 2.0);
        assert_eq!(Ualpha::from_alpha(Alpha::new(2.0)), credit);
        assert_eq!(Ualpha::from_alpha(Alpha::new(0.5)).get(), 500_000);
        assert_eq!(credit.to_amount_string(), "2000000");
        assert_eq!(credit.as_milliwatts().get(), 2_000_000, "1 ualpha = 1 mW, by name");
        assert_eq!(Milliwatts::new(750_000).as_ualpha(), Ualpha::new(750_000));
        let now = Block::new(2_470_534);
        assert_eq!(now.since(Block::new(2_463_969)), 6_565);
        assert_eq!(Block::new(10).since(now), 0, "a clock ahead of us is age 0, never a wrap");
        assert!(Charge::new(8).covers(8) && !Charge::new(7).covers(8));
    }

    #[test]
    fn subjects_parse_by_family_and_match_whole_tokens() {
        let s = Subject::parse("structs.planet.2-28299.1-1053");
        assert_eq!(s.family, SubjectFamily::Planet);
        assert_eq!(s.object.as_ref().and_then(|o| o.as_planet()).unwrap().as_str(), "2-28299");
        assert_eq!(s.player.as_ref().unwrap().as_str(), "1-1053");
        assert!(s.has_token("1-1053") && !s.has_token("1-105") && !s.has_token("1-10530"));
        let g = Subject::parse("structs.grid.player.1-1404.1-1404");
        assert_eq!(g.family, SubjectFamily::Grid);
        assert_eq!(g.object.unwrap().kind, ObjectKind::Player);
        let i = Subject::parse("structs.inventory.ualpha.0-1.1-194.structs12wll0unjn6rzmjchnqy8e07txfeaf4w8y3x6ne");
        assert_eq!(i.family, SubjectFamily::Inventory);
        assert_eq!(i.player.unwrap().as_str(), "1-194");
        assert_eq!(Subject::parse("consensus").family, SubjectFamily::Consensus);
        assert_eq!(Subject::parse("structs.planet.noPlanet.noPlayer").object, None);
        assert_eq!(Subject::parse("structs.planet.2-1.noPlayer").player, None, "'noPlayer' is the trigger's placeholder, not an id");
        assert_eq!(Subject::parse("x.y").family, SubjectFamily::Other);
    }

    #[test]
    fn entity_view_reads_the_chains_stringly_numbers_once() {
        let e = serde_json::json!({
            "Struct": {"id": "5-234309", "owner": "1-2477", "locationId": "2-27693", "locationType": "planet"},
            "structAttributes": {"blockStartBuild": "2458278", "protectedStructIndex": "0", "status": "7"},
            "gridAttributes": {"lastAction": "2470534", "ore": "3"}
        });
        let v = EntityView::new(&e);
        assert_eq!(v.struct_block("blockStartBuild"), Block::new(2_458_278));
        assert_eq!(v.struct_attr_u64("status"), 7);
        assert_eq!(v.last_action(), Block::new(2_470_534));
        assert_eq!(v.grid_f64("ore"), 3.0);
        assert_eq!(v.struct_owner().unwrap().as_str(), "1-2477");
        assert_eq!(v.struct_location().unwrap().as_planet().unwrap().as_str(), "2-27693");
        assert_eq!(v.struct_block("missing"), Block::new(0), "absent is zero, as every caller already assumed");
        let p = serde_json::json!({"Planet": {"id": "2-1"}, "planetAttributes": {"blockStartOreMine": 2471194}});
        assert_eq!(EntityView::new(&p).planet_block("blockStartOreMine").get(), 2_471_194, "numbers are accepted too");
    }

    #[test]
    fn numeric_accepts_number_string_and_null() {
        #[derive(Deserialize)]
        struct Row {
            #[serde(default, deserialize_with = "numeric")]
            ty: Option<u64>,
            #[serde(default, deserialize_with = "numeric")]
            val: Option<f64>,
        }
        let r: Row = serde_json::from_str(r#"{"ty": 16, "val": "2471194"}"#).unwrap();
        assert_eq!((r.ty, r.val), (Some(16), Some(2471194.0)));
        let r: Row = serde_json::from_str(r#"{"ty": "18", "val": null}"#).unwrap();
        assert_eq!((r.ty, r.val), (Some(18), None));
        let r: Row = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!((r.ty, r.val), (None, None));
        let r: Row = serde_json::from_str(r#"{"ty": " "}"#).unwrap();
        assert_eq!(r.ty, None, "blank string is absence, not an error");
        assert!(serde_json::from_str::<Row>(r#"{"ty": "abc"}"#).is_err(), "garbage is an error, not a silent zero");
    }
}
