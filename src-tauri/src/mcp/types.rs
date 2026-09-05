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

#[cfg(test)]
mod tests {
    use super::*;

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
