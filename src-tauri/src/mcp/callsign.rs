//! Generated display names for team players — the naming counterpart to `pfp.rs`.
//!
//! A virtual player used to be called `worker<HD index>`, which is fine for a
//! debug log and terrible for a roster of two thousand. This module turns the
//! HD index into a real name.
//!
//! A **style** is data, not code: one or two word banks, a joiner, a count of
//! designation digits, and a case. The app ships several and the operator picks
//! one in Team Ops · Config (or supplies their own banks). Nothing here is
//! specific to one player's taste — `callsign` is the default; `corporate`
//! (an office staff directory) is simply the style our own fleet selects.
//!
//! The index → name map is a MULTIPLICATIVE BIJECTION over the style's slot
//! space, which buys three things at once: consecutive indices scatter across
//! the bank instead of marching through it, no two players collide, and the
//! function is pure — recomputing a name yields the same answer forever, which
//! is what lets `roster_cache` self-heal names without thrashing.
//!
//! Every generated name must satisfy the chain's `ValidatePlayerName`: 3–20
//! runes, `^[\p{L}0-9\-_]{3,20}$`, no spaces or apostrophes, and never the
//! `^[0-9]+-[0-9]+$` entity-id shape. `validate()` enforces that for custom
//! banks; the tests enforce it for the built-ins.

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, RwLock};

const CONFIG_FILE: &str = "callsign.json";

/// Names the tooling generated before styles existed. These — and only these —
/// are the legacy shapes the rename heal is allowed to overwrite.
const LEGACY_PREFIXES: &[&str] = &["worker", "miner", "scout"];

// ── Word banks ───────────────────────────────────────────────────────────────

/// `callsign` — the default. Hard-edged single words, four-digit designation.
const BANK_CALLSIGN: &[&str] = &[
    "ONYX", "VULCAN", "KESTREL", "HALLOW", "CINDER", "MERIDIAN", "TALON", "RAVEN",
    "VIPER", "COBRA", "FALCON", "OSPREY", "HARRIER", "LANCER", "SABRE", "RAPIER",
    "BASTION", "RAMPART", "CITADEL", "REDOUBT", "BULWARK", "AEGIS", "PHALANX", "LEGION",
    "VANGUARD", "SENTINEL", "WARDEN", "MARSHAL", "TEMPEST", "MAELSTROM", "TYPHOON", "MONSOON",
    "ZEPHYR", "BOREAS", "AURORA", "ECLIPSE", "PENUMBRA", "ZENITH", "NADIR", "APEX",
    "VERTEX", "SUMMIT", "PINNACLE", "OBSIDIAN", "BASALT", "GRANITE", "QUARTZ", "FLINT",
    "EMBER", "ASHFALL", "SCORIA", "MAGMA", "PUMICE", "TUNDRA", "GLACIER", "CREVASSE",
    "MORAINE", "FJORD", "ATOLL", "LAGOON", "ABYSSAL", "TRENCH", "RIPTIDE", "UNDERTOW",
    "BREAKER", "SQUALL", "GALEFORCE", "THUNDER", "VOLTAGE", "ARCLIGHT", "PLASMA", "IONSTORM",
    "QUASAR", "PULSAR", "NEBULA", "CORONA", "HELIOS", "SELENE", "PHOBOS", "DEIMOS",
    "TITAN", "RHEA", "IAPETUS", "UMBRIEL", "OBERON", "TRITON", "CHARON", "VESTA",
    "PALLAS", "JUNO", "HYGIEA", "ICARUS", "DAEDALUS", "PERSEUS", "ORION", "LYRA",
    "VEGA", "ALTAIR", "RIGEL", "ANTARES", "SIRIUS", "CANOPUS", "ARCTURUS", "POLLUX",
    "CASTOR", "SPICA", "DENEB", "MIZAR", "ALCOR", "ATLAS", "MAIA", "ELECTRA",
    "MEROPE", "ASTERION", "DRAKE", "MARLIN", "BARRACUDA", "MANTA", "ORCA", "NARWHAL",
    "PETREL", "SKUA", "FULMAR", "GANNET", "SHRIKE", "MERLIN", "GOSHAWK", "PEREGRINE",
];

/// `corporate` — an office staff directory. First names.
const BANK_FIRST: &[&str] = &[
    "Dave", "Steve", "Greg", "Brian", "Doug", "Gary", "Larry", "Randy",
    "Wayne", "Dennis", "Keith", "Craig", "Todd", "Scott", "Jeff", "Mark",
    "Paul", "Gerald", "Ronald", "Kevin", "Glenn", "Bruce", "Dale", "Neil",
    "Roger", "Terry", "Barry", "Stuart", "Colin", "Trevor", "Graham", "Alan",
    "Derek", "Bernard", "Norman", "Stanley", "Alvin", "Clarence", "Delbert", "Elmer",
    "Floyd", "Harold", "Leonard", "Melvin", "Vernon", "Walter", "Wilbur", "Reginald",
    "Sheldon", "Percy", "Ernie", "Hugh", "Ralph", "Clifford", "Duane", "Lyle",
    "Marvin", "Roland", "Warren", "Wendell", "Karen", "Linda", "Susan", "Janet",
    "Debbie", "Nancy", "Cheryl", "Marilyn", "Carol", "Sandra", "Patricia", "Diane",
    "Denise", "Sharon", "Lorraine", "Yvonne", "Maureen", "Pauline", "Brenda", "Gillian",
    "Beverly", "Wendy", "Tracy", "Joanne", "Michelle", "Colleen", "Marcia", "Rhonda",
    "Lois", "Ruth", "Ellen", "Gloria", "Bonnie", "Connie", "Doreen", "Eileen",
    "Irene", "Phyllis", "Shirley", "Wanda", "Darlene", "Roberta", "Marlene", "Arlene",
    "Charlene", "Kathy", "Peggy", "Betty", "Judy", "Sally", "Dawn", "Gail",
    "Jill", "June", "Lynn", "Nadine", "Rita", "Tina", "Vera", "Yolanda",
    "Angela", "Bernice", "Constance", "Dolores", "Eunice", "Harriet", "Mildred", "Rosalind",
];

/// `corporate` — surnames.
const BANK_LAST: &[&str] = &[
    "Thompson", "Johnson", "Miller", "Peterson", "Clark", "Walsh", "Nguyen", "Patel",
    "Anderson", "Robinson", "Wilson", "Harris", "Martin", "Lewis", "Walker", "Hall",
    "Allen", "Young", "King", "Wright", "Green", "Baker", "Adams", "Nelson",
    "Carter", "Mitchell", "Roberts", "Turner", "Phillips", "Campbell", "Parker", "Evans",
    "Edwards", "Collins", "Stewart", "Morris", "Murphy", "Cook", "Rogers", "Morgan",
    "Bell", "Bailey", "Reed", "Kelly", "Howard", "Ward", "Cox", "Richardson",
    "Wood", "Watson", "Brooks", "Bennett", "Gray", "Hughes", "Price", "Sanders",
    "Patterson", "Kowalski", "Fitzgerald", "Novak", "Vasquez", "Okafor", "Lindqvist", "Yamamoto",
    "Dubois", "Schneider", "Kaur", "Rossi", "Petrov", "Haugen", "Virtanen", "Kovacs",
    "Silva", "Costa", "Mendoza", "Herrera", "Ibrahim", "Osei", "Mwangi", "Adeyemi",
    "Chen", "Zhang", "Nakamura", "Kimura", "Park", "Choi", "Reyes", "Santos",
    "Murray", "Grant", "Hamilton", "Ferguson", "Sutherland", "Doyle", "Brennan", "Gallagher",
    "Whitfield", "Ashworth", "Bramley", "Crowther", "Dunmore", "Eastwood", "Fairbairn", "Garrity",
    "Halloran", "Ingham", "Jessop", "Kendrick", "Lambourne", "Meacham", "Northcott", "Ormerod",
    "Pemberton", "Quigley", "Redfern", "Stanhope", "Thackeray", "Underhill", "Vickery", "Winstanley",
    "Yardley", "Ackerley", "Bosworth", "Chadwick", "Denholm", "Ellery", "Fenwick", "Goodliffe",
];

/// `jargon` — corporate-finance and utility vocabulary.
const BANK_JARGON: &[&str] = &[
    "SYNERGY", "LEVERAGE", "PIVOT", "ROADMAP", "BANDWIDTH", "ALIGNMENT", "CADENCE", "HEADCOUNT",
    "SCALABLE", "PARADIGM", "MANDATE", "COMPLIANCE", "VENDOR", "INVOICE", "PAYROLL", "ESCROW",
    "LIQUIDITY", "ARBITRAGE", "QUOTA", "MARGIN", "ACCRUAL", "DIVIDEND", "EQUITY", "REMITTANCE",
    "FORECAST", "VARIANCE", "BASELINE", "MILESTONE", "ONBOARDING", "OFFSITE", "ACTIONABLE", "GRANULAR",
    "HOLISTIC", "UPSTREAM", "DOWNSTREAM", "THROUGHPUT", "RUNWAY", "CAPEX", "OPEX", "HOLDINGS",
    "SUBSIDIARY", "FRANCHISE", "PORTFOLIO", "LEDGER", "PAYABLE", "FIDUCIARY", "INDEMNITY", "WARRANTY",
    "ADDENDUM", "DIRECTIVE", "GOVERNANCE", "OVERSIGHT", "ASSURANCE", "DILIGENCE", "MERGER", "SEVERANCE",
    "ATTRITION", "ENGAGEMENT", "WORKSTREAM", "ROLLOUT", "SUNSET", "MIGRATION", "INITIATIVE", "SEGMENT",
    "CONVERSION", "RETENTION", "UPSELL", "FUNNEL", "BENCHMARK", "RECONCILE", "AUDIT", "CHARTER",
    "BYLAW", "PROXY", "QUORUM", "TRANCHE", "COVENANT", "COLLATERAL", "HEDGE", "AMENDMENT",
    "PROSPECTUS", "VALUATION", "GOODWILL", "IMPAIRMENT", "WRITEDOWN", "CARRYOVER", "DEFERRAL", "PRORATA",
    "STIPEND", "RETAINER", "SURPLUS", "REBATE", "SUNDRY", "EXPENSE", "APPROVAL", "STAKEHOLDER",
    "UTILIZATION", "TARIFF", "METERING", "RATEPAYER", "SUBSTATION", "KILOWATT", "MEGAWATT", "DEMURRAGE",
    "FEEDSTOCK", "LOADSHED", "TURBINE", "COOLANT", "PENSTOCK", "RESERVOIR", "SPILLWAY", "HEADRACE",
    "TAILRACE", "DRAWDOWN", "BASELOAD", "PEAKLOAD", "CAPACITOR", "BUSBAR", "FEEDER", "INTERTIE",
    "WHEELING", "CURTAIL", "DISPATCH", "OUTAGE", "UPTIME", "DERATING", "SURCHARGE", "GRIDLOCK",
];

/// `mythic` — cold mythological machine names.
const BANK_MYTHIC: &[&str] = &[
    "TALOS", "ARGUS", "MOIRA", "NEMESIS", "CERBERUS", "HYPERION", "ATROPOS", "CLOTHO",
    "LACHESIS", "EREBUS", "HECATE", "CHARYBDIS", "SCYLLA", "TYPHON", "ECHIDNA", "CHIMERA",
    "HYDRA", "GORGON", "MEDUSA", "STHENO", "EURYALE", "HARPY", "SPHINX", "MINOTAUR",
    "CENTAUR", "NAIAD", "DRYAD", "OREAD", "NEREID", "THANATOS", "HYPNOS", "MORPHEUS",
    "CHRONOS", "KAIROS", "ANANKE", "TARTARUS", "STYX", "LETHE", "ACHERON", "PHLEGETHON",
    "COCYTUS", "ELYSIUM", "OLYMPUS", "PARNASSUS", "DELPHI", "ORACLE", "PYTHIA", "SIBYL",
    "ODIN", "THOR", "LOKI", "FREYA", "HEIMDALL", "BALDUR", "VIDAR", "BRAGI",
    "IDUNN", "SKADI", "NJORD", "FRIGG", "FENRIR", "SLEIPNIR", "HUGINN", "MUNINN",
    "RATATOSK", "YGGDRASIL", "MJOLNIR", "GUNGNIR", "DRAUPNIR", "NAGLFAR", "BIFROST", "ASGARD",
    "MIDGARD", "VANAHEIM", "ALFHEIM", "JOTUNHEIM", "NIFLHEIM", "HELHEIM", "RAGNAROK", "VALHALLA",
    "VALKYRIE", "EINHERJAR", "VERDANDI", "SKULD", "OSIRIS", "HORUS", "ANUBIS", "THOTH",
    "SEKHMET", "BASTET", "SOBEK", "KHNUM", "PTAH", "TEFNUT", "MAAT", "AMMIT",
    "KHEPRI", "HATHOR", "NEPHTHYS", "SESHAT", "NEITH", "MONTU", "TAWERET", "SERQET",
    "WADJET", "NEKHBET", "MARDUK", "TIAMAT", "ANSHAR", "ENLIL", "NINURTA", "NERGAL",
    "ERESHKIGAL", "GILGAMESH", "HUMBABA", "LAMASSU", "APSU", "NAMMU", "UTNAPISHTIM", "SHAMASH",
    "PERUN", "VELES", "SVAROG", "MOKOSH", "RADEGAST", "TRIGLAV", "CHERNOBOG", "BELOBOG",
];

/// `compound` — adjective half.
const BANK_ADJ: &[&str] = &[
    "Rust", "Null", "Iron", "Ash", "Cold", "Glass", "Black", "Pale",
    "Grim", "Hollow", "Silent", "Bitter", "Salt", "Storm", "Dust", "Bone",
    "Blood", "Frost", "Ember", "Cinder", "Copper", "Silver", "Leaden", "Brass",
    "Tin", "Zinc", "Chrome", "Steel", "Cobalt", "Nickel", "Wolfram", "Osmium",
    "Quiet", "Sullen", "Broken", "Crooked", "Ragged", "Jagged", "Gilded", "Tarnished",
    "Hushed", "Muted", "Faded", "Wan", "Dim", "Dusk", "Dawn", "Night",
    "Winter", "Autumn", "Hoar", "Rime", "Sleet", "Mire", "Marsh", "Fen",
    "Moss", "Lichen", "Thorn", "Bramble", "Nettle", "Yew", "Alder", "Rowan",
    "Blight", "Wither", "Waning", "Feral", "Wild", "Lost", "Errant", "Wayward",
    "Fallow", "Barren", "Stark", "Bleak", "Gaunt", "Lean", "Thin", "Spare",
    "Deep", "Far", "Low", "Under", "Over", "Outer", "Inner", "Hidden",
    "Veiled", "Shrouded", "Cloaked", "Masked", "Sealed", "Locked", "Bound", "Sworn",
];

/// `compound` — noun half.
const BANK_NOUN: &[&str] = &[
    "Halo", "Spire", "Vesper", "Monarch", "Harrow", "Tithe", "Lantern", "Beacon",
    "Pillar", "Vault", "Anchor", "Cradle", "Crucible", "Furnace", "Bellows", "Ledger",
    "Compass", "Sextant", "Meridian", "Cipher", "Sigil", "Rune", "Glyph", "Totem",
    "Relic", "Chalice", "Censer", "Aspect", "Echo", "Cadence", "Refrain", "Requiem",
    "Dirge", "Elegy", "Psalm", "Canticle", "Vigil", "Matins", "Compline", "Litany",
    "Verse", "Stanza", "Cantor", "Chorus", "Descant", "Motet", "Fugue", "Rondo",
    "Cairn", "Barrow", "Dolmen", "Menhir", "Obelisk", "Stele", "Plinth", "Lintel",
    "Arch", "Vaulting", "Buttress", "Gable", "Cornice", "Frieze", "Tympanum", "Keystone",
    "Gate", "Threshold", "Portal", "Wicket", "Postern", "Bastion", "Curtain", "Merlon",
    "Crown", "Diadem", "Circlet", "Torque", "Fetter", "Manacle", "Shackle", "Chain",
    "Ledge", "Scarp", "Ridge", "Crag", "Tor", "Bluff", "Sound", "Strait",
    "Current", "Eddy", "Wake", "Drift", "Tide", "Shoal", "Reef", "Shelf",
];

/// `bothandle` — droid handles.
const BANK_BOT: &[&str] = &[
    "Bishop", "Mux", "Clank", "Sprocket", "Doppler", "Kilroy", "Tinhead", "Cog",
    "Gizmo", "Widget", "Bolt", "Rivet", "Flange", "Gasket", "Piston", "Camshaft",
    "Tappet", "Gudgeon", "Trunnion", "Clevis", "Shackle", "Grommet", "Ferrule", "Bushing",
    "Bearing", "Spindle", "Armature", "Solenoid", "Relay", "Diode", "Triode", "Pentode",
    "Resistor", "Inductor", "Rheostat", "Varistor", "Thyristor", "Klystron", "Magnetron", "Cathode",
    "Anode", "Filament", "Ballast", "Choke", "Shunt", "Toggle", "Tumbler", "Ratchet",
    "Pawl", "Detent", "Governor", "Flywheel", "Crankpin", "Journal", "Collet", "Chuck",
    "Mandrel", "Arbor", "Reamer", "Broach", "Hone", "Tappy", "Gimbal", "Gyro",
    "Servo", "Stepper", "Encoder", "Resolver", "Actuator", "Damper", "Strut", "Linkage",
    "Coupler", "Splice", "Terminal", "Lug", "Busbar", "Conduit", "Raceway", "Trunking",
    "Nipper", "Spanner", "Ratchety", "Grommy", "Bodger", "Tinker", "Cobble", "Patcher",
    "Fixit", "Mender", "Splicer", "Riveter", "Welder", "Brazer", "Solderer", "Lapper",
    "Nudge", "Prod", "Poke", "Jog", "Nudger", "Tweak", "Fiddle", "Wiggle",
    "Blip", "Bleep", "Chirp", "Warble", "Trill", "Hum", "Buzz", "Click",
    "Ping", "Pong", "Tick", "Tock", "Whirr", "Clunk", "Rattle", "Judder",
    "Ozymandias", "Kilobyte", "Nibble", "Parity", "Checksum", "Bitwise", "Hexley", "Octet",
];

// ── Style ────────────────────────────────────────────────────────────────────

/// A naming scheme. Pure data so styles can be added — or supplied by the
/// operator as `custom` — without touching the generator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Style {
    pub id: String,
    pub label: String,
    /// One bank for `WORD-1234`, two for `First-Last` / `RustHalo`.
    pub banks: Vec<Vec<String>>,
    /// Between the parts: `"-"`, `"_"`, or `""` for CamelCase compounds.
    pub joiner: String,
    /// Zero-padded designation digits appended after `joiner`. 0 = none.
    pub digits: u8,
    /// ALLCAPS when true; otherwise Capitalized.
    pub upper: bool,
}

fn style(
    id: &str,
    label: &str,
    banks: &[&[&str]],
    joiner: &str,
    digits: u8,
    upper: bool,
) -> Style {
    Style {
        id: id.into(),
        label: label.into(),
        banks: banks
            .iter()
            .map(|b| b.iter().map(|w| (*w).to_string()).collect())
            .collect(),
        joiner: joiner.into(),
        digits,
        upper,
    }
}

pub static BUILTIN: LazyLock<Vec<Style>> = LazyLock::new(|| {
    vec![
        style("callsign", "Callsign", &[BANK_CALLSIGN], "-", 4, true),
        style("corporate", "Office Directory", &[BANK_FIRST, BANK_LAST], "-", 0, false),
        style("jargon", "Corporate Jargon", &[BANK_JARGON], "-", 4, true),
        style("mythic", "Mythic Machine", &[BANK_MYTHIC], "-", 3, true),
        style("compound", "Compound", &[BANK_ADJ, BANK_NOUN], "", 0, false),
        style("bothandle", "Bot Handle", &[BANK_BOT], "-", 2, false),
    ]
});

// ── Config ───────────────────────────────────────────────────────────────────

fn default_style() -> String {
    "callsign".into()
}
fn default_true() -> bool {
    true
}

/// Persisted settings. Two switches, split by blast radius: naming a player at
/// birth is free and on by default, while rewriting the names of players that
/// already have them is N on-chain transactions and stays opt-in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallsignConfig {
    #[serde(default = "default_style")]
    pub style: String,
    /// Give newly created virtual players a generated name.
    #[serde(default = "default_true")]
    pub name_new: bool,
    /// Let the roster sweep rewrite existing auto-named players on-chain.
    #[serde(default)]
    pub rename_existing: bool,
    /// Optional tag prepended as `<prefix>-<name>` (e.g. a guild initialism).
    #[serde(default)]
    pub prefix: String,
    /// Operator-supplied style, selected with `style: "custom"`.
    #[serde(default)]
    pub custom: Option<Style>,
}

impl Default for CallsignConfig {
    fn default() -> Self {
        CallsignConfig {
            style: default_style(),
            name_new: true,
            rename_existing: false,
            prefix: String::new(),
            custom: None,
        }
    }
}

static CONFIG: LazyLock<RwLock<CallsignConfig>> = LazyLock::new(|| {
    RwLock::new(crate::mcp::config_store::load_config::<CallsignConfig>(CONFIG_FILE))
});

pub fn config() -> CallsignConfig {
    CONFIG.read().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn config_json() -> serde_json::Value {
    serde_json::to_value(config()).unwrap_or_else(|_| serde_json::json!({}))
}

/// Resolve a style id against the built-ins plus the configured custom style.
pub fn find_style(cfg: &CallsignConfig, id: &str) -> Style {
    if id == "custom" {
        if let Some(c) = &cfg.custom {
            return c.clone();
        }
    }
    BUILTIN
        .iter()
        .find(|s| s.id == id)
        .or_else(|| BUILTIN.first())
        .cloned()
        .unwrap_or_else(|| style("callsign", "Callsign", &[BANK_CALLSIGN], "-", 4, true))
}

/// Persist new settings. A custom style is validated before it can be stored —
/// an invalid bank would otherwise mint names the chain rejects, one failed
/// signature at a time, on every sweep.
pub fn set_config(mut next: CallsignConfig) -> Result<CallsignConfig, String> {
    next.prefix = next.prefix.trim().to_string();
    if !next.prefix.is_empty() && !next.prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("prefix must be letters and digits only".into());
    }
    if let Some(c) = &next.custom {
        validate(c)?;
    }
    let known = next.style == "custom" || BUILTIN.iter().any(|s| s.id == next.style);
    if !known {
        return Err(format!("unknown style '{}'", next.style));
    }
    if next.style == "custom" && next.custom.is_none() {
        return Err("style 'custom' selected but no custom style supplied".into());
    }
    // Longest possible render must still fit the chain's 20-rune ceiling.
    let s = find_style(&next, &next.style);
    if let Some(over) = longest_render(&s, &next.prefix) {
        if over > 20 {
            return Err(format!(
                "style '{}' with prefix '{}' can render {} chars; the chain allows 20",
                next.style, next.prefix, over
            ));
        }
    }
    {
        let mut cfg = CONFIG.write().unwrap_or_else(|e| e.into_inner());
        *cfg = next.clone();
        crate::mcp::config_store::save_config(CONFIG_FILE, &*cfg);
    }
    Ok(next)
}

// ── Generator ────────────────────────────────────────────────────────────────

/// Fixed offset so index 0 is not the first slot; any constant works.
const OFFSET: u64 = 733_009;

/// Candidate multipliers, tried in order. The first one coprime to the style's
/// slot space is used, which keeps the map bijective for ANY bank sizes —
/// including operator-supplied ones we cannot pick a constant for in advance.
const MULTIPLIERS: &[u64] = &[
    1_046_527, 999_983, 1_299_709, 15_485_863, 32_452_843, 49_979_687, 67_867_979, 86_028_121,
    104_729, 7,
];

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

fn multiplier(space: u64) -> u64 {
    MULTIPLIERS
        .iter()
        .copied()
        .find(|m| gcd(*m, space) == 1)
        .unwrap_or(1)
}

/// Total distinct names a style can mint: product of bank sizes × 10^digits.
pub fn capacity(s: &Style) -> u64 {
    if s.banks.is_empty() || s.banks.iter().any(|b| b.is_empty()) {
        return 0;
    }
    let words: u64 = s.banks.iter().map(|b| b.len() as u64).product();
    words.saturating_mul(10u64.pow(s.digits.min(4) as u32))
}

fn cased(word: &str, upper: bool) -> String {
    if upper {
        return word.to_uppercase();
    }
    let mut cs = word.chars();
    match cs.next() {
        Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// The pure core: style + HD index → name, before any prefix.
fn render(s: &Style, index: u32) -> String {
    let space = capacity(s);
    if space == 0 {
        // Degenerate style (shouldn't reach here — `validate` rejects it).
        return format!("worker{index}");
    }
    let slot = (index as u64)
        .wrapping_mul(multiplier(space))
        .wrapping_add(OFFSET)
        % space;
    let pow = 10u64.pow(s.digits.min(4) as u32);
    let num = slot % pow;
    let mut rest = slot / pow;

    let mut parts: Vec<String> = Vec::with_capacity(s.banks.len() + 1);
    for bank in &s.banks {
        let n = bank.len() as u64;
        parts.push(cased(&bank[(rest % n) as usize], s.upper));
        rest /= n;
    }
    let mut out = parts.join(&s.joiner);
    if s.digits > 0 {
        let sep = if s.joiner.is_empty() { "-" } else { &s.joiner };
        out.push_str(sep);
        out.push_str(&format!("{:0width$}", num, width = s.digits as usize));
    }
    out
}

/// The name a team player at `index` should carry under the current config.
pub fn name_for(index: u32) -> String {
    let cfg = config();
    let s = find_style(&cfg, &cfg.style);
    with_prefix(&render(&s, index), &cfg.prefix)
}

fn with_prefix(name: &str, prefix: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}-{name}")
    }
}

/// `idx → name` rows for the config preview, under the ACTIVE style.
pub fn preview(indices: &[u32]) -> Vec<(u32, String)> {
    let cfg = config();
    preview_with(&find_style(&cfg, &cfg.style), &cfg.prefix, indices)
}

/// Same, for an arbitrary style — so the picker can show every style's flavour
/// without first switching to it.
pub fn preview_with(s: &Style, prefix: &str, indices: &[u32]) -> Vec<(u32, String)> {
    indices
        .iter()
        .map(|i| (*i, with_prefix(&render(s, *i), prefix)))
        .collect()
}

// ── Ownership: which names this tooling may overwrite ────────────────────────

fn is_legacy(s: &str) -> bool {
    LEGACY_PREFIXES.iter().any(|p| {
        s.strip_prefix(p)
            .map(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
    })
}

/// Can `head` be split into one word from each remaining bank, in order?
/// Recursion handles the empty-joiner case, where `RustHalo` cannot simply be
/// split on a separator.
fn match_banks(banks: &[Vec<String>], head: &str, joiner: &str) -> bool {
    let Some(bank) = banks.first() else {
        return head.is_empty();
    };
    let last = banks.len() == 1;
    bank.iter().any(|w| {
        if last {
            return head.eq_ignore_ascii_case(w);
        }
        let Some(rest) = strip_prefix_ci(head, w) else {
            return false;
        };
        let Some(rest) = rest.strip_prefix(joiner) else {
            return false;
        };
        match_banks(&banks[1..], rest, joiner)
    })
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

fn matches_style(s: &Style, name: &str) -> bool {
    if capacity(s) == 0 {
        return false;
    }
    let head = if s.digits > 0 {
        let sep = if s.joiner.is_empty() { "-" } else { &s.joiner };
        let Some((h, tail)) = name.rsplit_once(sep) else {
            return false;
        };
        if tail.len() != s.digits as usize || !tail.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        h
    } else {
        name
    };
    match_banks(&s.banks, head, &s.joiner)
}

/// True when `name` is one this tooling generated (or the legacy `worker42`
/// form), and therefore may be replaced.
///
/// Deliberately checks EVERY built-in style, not just the active one: an
/// operator who switches styles should see their whole fleet re-heal, not
/// half of it stranded under the previous scheme. A name we did not mint —
/// anything the player typed themselves — is never touched.
pub fn is_managed_name(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return true;
    }
    if is_legacy(name) {
        return true;
    }
    let cfg = config();
    // A configured prefix is ours, so look past it before matching.
    let bare = if cfg.prefix.is_empty() {
        name
    } else {
        strip_prefix_ci(name, &format!("{}-", cfg.prefix)).unwrap_or(name)
    };
    let custom = cfg.custom.iter().cloned().collect::<Vec<_>>();
    BUILTIN
        .iter()
        .chain(custom.iter())
        .any(|s| matches_style(s, bare) || matches_style(s, name))
}

// ── Validation ───────────────────────────────────────────────────────────────

/// Longest name this style can produce, including a prefix. `None` if the style
/// is degenerate.
fn longest_render(s: &Style, prefix: &str) -> Option<usize> {
    if capacity(s) == 0 {
        return None;
    }
    let words: usize = s
        .banks
        .iter()
        .map(|b| b.iter().map(|w| w.chars().count()).max().unwrap_or(0))
        .sum();
    let joiners = s.joiner.chars().count() * s.banks.len().saturating_sub(1);
    let digits = if s.digits > 0 {
        s.digits as usize + if s.joiner.is_empty() { 1 } else { s.joiner.chars().count() }
    } else {
        0
    };
    let pfx = if prefix.is_empty() { 0 } else { prefix.chars().count() + 1 };
    Some(pfx + words + joiners + digits)
}

/// Reject a style that could mint a name the chain would refuse.
pub fn validate(s: &Style) -> Result<(), String> {
    if s.banks.is_empty() {
        return Err("a style needs at least one word bank".into());
    }
    if s.banks.len() > 3 {
        return Err("at most three word banks".into());
    }
    if s.digits > 4 {
        return Err("at most four designation digits".into());
    }
    if !matches!(s.joiner.as_str(), "" | "-" | "_") {
        return Err("joiner must be \"-\", \"_\", or empty".into());
    }
    for bank in &s.banks {
        if bank.is_empty() {
            return Err("word banks cannot be empty".into());
        }
        for w in bank {
            if w.is_empty() || !w.chars().all(|c| c.is_ascii_alphabetic()) {
                return Err(format!("word '{w}' must be ASCII letters only"));
            }
            if w.chars().count() > 14 {
                return Err(format!("word '{w}' is too long (max 14)"));
            }
        }
    }
    // An empty joiner with digits still separates the number with "-", so the
    // only unreachable combination is a single bank glued to nothing.
    if s.banks.len() == 1 && s.joiner.is_empty() && s.digits == 0 {
        return Err("a single bank with no joiner and no digits repeats bare words".into());
    }
    match longest_render(s, "") {
        Some(n) if n > 20 => Err(format!("longest name would be {n} chars; the chain allows 20")),
        Some(n) if n < 3 => Err(format!("shortest name would be {n} chars; the chain requires 3")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn chain_valid(name: &str) -> bool {
        let n = name.chars().count();
        if !(3..=20).contains(&n) {
            return false;
        }
        if !name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        {
            return false;
        }
        // Never the `1-271` entity-id shape.
        if let Some((a, b)) = name.split_once('-') {
            if !a.is_empty()
                && !b.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
            {
                return false;
            }
        }
        true
    }

    #[test]
    fn every_builtin_style_is_valid() {
        for s in BUILTIN.iter() {
            validate(s).unwrap_or_else(|e| panic!("style {} invalid: {e}", s.id));
        }
    }

    #[test]
    fn banks_have_no_duplicates() {
        for s in BUILTIN.iter() {
            for (i, bank) in s.banks.iter().enumerate() {
                let uniq: HashSet<String> = bank.iter().map(|w| w.to_lowercase()).collect();
                assert_eq!(
                    uniq.len(),
                    bank.len(),
                    "style {} bank {i} has duplicate words",
                    s.id
                );
            }
        }
    }

    #[test]
    fn names_are_unique_and_chain_valid() {
        for s in BUILTIN.iter() {
            let n = capacity(s).min(5000) as u32;
            let mut seen: HashSet<String> = HashSet::new();
            for i in 0..n {
                let name = render(s, i);
                assert!(chain_valid(&name), "style {}: '{name}' is not chain-valid", s.id);
                assert!(seen.insert(name.clone()), "style {}: '{name}' collided", s.id);
            }
        }
    }

    #[test]
    fn covers_our_fleet_without_collisions() {
        // 2042 virtual players today; every style must name them distinctly.
        for s in BUILTIN.iter() {
            assert!(
                capacity(s) >= 2042,
                "style {} only has capacity {}",
                s.id,
                capacity(s)
            );
        }
    }

    #[test]
    fn corporate_reads_like_a_staff_directory() {
        let s = find_style(&CallsignConfig::default(), "corporate");
        let name = render(&s, 271);
        let (first, last) = name.split_once('-').expect("First-Last");
        assert!(BANK_FIRST.contains(&first), "{first} not a first name");
        assert!(BANK_LAST.contains(&last), "{last} not a surname");
        assert!(!name.chars().any(|c| c.is_ascii_digit()), "no digits: {name}");
        assert_eq!(capacity(&s), 128 * 128);
    }

    #[test]
    fn output_is_stable() {
        // Golden values: a shift here silently renames the entire fleet and
        // costs one on-chain transaction per player to settle.
        let cfg = CallsignConfig::default();
        assert_eq!(render(&find_style(&cfg, "callsign"), 1), "ASHFALL-9536");
        assert_eq!(render(&find_style(&cfg, "corporate"), 1), "Beverly-Mwangi");
    }

    #[test]
    fn prefix_is_applied_and_stripped() {
        let s = find_style(&CallsignConfig::default(), "callsign");
        let bare = render(&s, 42);
        let tagged = with_prefix(&bare, "OH");
        assert_eq!(tagged, format!("OH-{bare}"));
        assert!(chain_valid(&tagged));
    }

    #[test]
    fn generated_names_are_recognised_as_ours() {
        for s in BUILTIN.iter() {
            for i in [0u32, 1, 7, 271, 999, 2045] {
                let name = render(s, i);
                assert!(
                    matches_style(s, &name),
                    "style {} did not recognise its own '{name}'",
                    s.id
                );
                assert!(is_managed_name(&name), "'{name}' should be managed");
            }
        }
    }

    #[test]
    fn legacy_auto_names_are_ours() {
        for n in ["worker1", "worker2046", "miner12", "scout1", ""] {
            assert!(is_managed_name(n), "'{n}' should be managed");
        }
    }

    #[test]
    fn hand_picked_names_are_never_ours() {
        // The whole safety story: a name the operator typed must survive.
        for n in [
            "Marklifer",
            "TheRealDeal",
            "xX_destroyer_Xx",
            "workerbee",   // legacy prefix but not the legacy shape
            "worker",      // no digits
            "Dave",        // a bank word alone is not a generated name
            "ONYX",        // ditto, missing its designation
            "ONYX-77",     // wrong digit count
            "Dave-Smith",  // Smith is not in the surname bank
        ] {
            assert!(!is_managed_name(n), "'{n}' must NOT be treated as ours");
        }
    }

    #[test]
    fn switching_styles_still_recognises_the_old_names() {
        // An operator on `corporate` must still see `callsign` names as ours,
        // otherwise half the fleet strands under the previous scheme.
        let cfg = CallsignConfig::default();
        let old = render(&find_style(&cfg, "callsign"), 300);
        let new = render(&find_style(&cfg, "corporate"), 300);
        assert_ne!(old, new);
        assert!(is_managed_name(&old) && is_managed_name(&new));
    }

    #[test]
    fn validate_rejects_bad_custom_styles() {
        let mut s = find_style(&CallsignConfig::default(), "callsign");
        s.banks = vec![vec![]];
        assert!(validate(&s).is_err(), "empty bank must be rejected");

        let mut s = find_style(&CallsignConfig::default(), "callsign");
        s.banks = vec![vec!["Supercalifragilistic".into()]];
        assert!(validate(&s).is_err(), "over-long word must be rejected");

        let mut s = find_style(&CallsignConfig::default(), "callsign");
        s.banks = vec![vec!["Bad Word".into()]];
        assert!(validate(&s).is_err(), "non-alphabetic word must be rejected");

        let mut s = find_style(&CallsignConfig::default(), "callsign");
        s.digits = 9;
        assert!(validate(&s).is_err(), "too many digits must be rejected");
    }

    /// The chain's seeded `structs.banned_word` list, read from the production
    /// indexer on 2026-08-11. Frozen here so the banks are checked at build
    /// time; the live list is authoritative and this needs re-pulling if it
    /// grows (`select value from structs.banned_word`).
    const BANNED: &[&str] = &[
        "nigger", "nigga", "faggot", "fag", "cunt", "nazi", "hitler", "isis", "kkk", "pedo",
    ];

    #[test]
    fn no_generated_name_can_contain_a_banned_word() {
        // Checked on the RENDERED name, not just the bank words: a style with an
        // empty joiner glues two banks together, so a token could straddle the
        // seam that neither word contains on its own.
        for s in BUILTIN.iter() {
            let words: u64 = s.banks.iter().map(|b| b.len() as u64).product();
            for slot in 0..words {
                let mut rest = slot;
                let mut parts: Vec<String> = Vec::new();
                for bank in &s.banks {
                    let n = bank.len() as u64;
                    parts.push(cased(&bank[(rest % n) as usize], s.upper));
                    rest /= n;
                }
                let joined = parts.join(&s.joiner).to_lowercase();
                // Also test with separators stripped, in case the chain's
                // matcher normalises them away before comparing.
                let stripped = joined.replace(['-', '_'], "");
                for bad in BANNED {
                    assert!(
                        !joined.contains(bad) && !stripped.contains(bad),
                        "style {} can render '{}', which contains '{}'",
                        s.id,
                        joined,
                        bad
                    );
                }
            }
        }
    }

    #[test]
    fn multiplier_is_always_coprime() {
        for s in BUILTIN.iter() {
            let space = capacity(s);
            assert_eq!(gcd(multiplier(space), space), 1, "style {}", s.id);
        }
    }
}
