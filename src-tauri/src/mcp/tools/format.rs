/// Shared formatting utilities for human-readable MCP output.
/// Used by dashboard, intel, action, and query tools.

/// Decode struct status bitflags to human-readable string.
/// Flags: 1=Building, 2=Offline, 4=Online, 8=Stored, 16=Hidden, 32=Destroyed, 64=Locked.
/// Single source of truth — dashboard/intel/query all route through this.
pub fn decode_status(status: u64) -> String {
    if status & 32 != 0 {
        return "Destroyed".to_string();
    }
    let mut flags = vec![];
    if status & 4 != 0 {
        flags.push("Online");
    } else if status & 2 != 0 {
        flags.push("Offline");
    } else if status & 1 != 0 {
        flags.push("Building");
    } else {
        flags.push("Inactive");
    }
    if status & 8 != 0 {
        flags.push("Stored");
    }
    if status & 16 != 0 {
        flags.push("Hidden");
    }
    if status & 64 != 0 {
        flags.push("Locked");
    }
    flags.join(", ")
}

/// Decode a 25-bit Structs permission bitmask into named flags (chain v0.17.0).
/// Bits 20-23 are the hash/PoW permissions; bit 24 is guild UGC moderation.
pub fn decode_permissions(mask: u64) -> String {
    const NAMES: [&str; 25] = [
        "Play",                  // 0
        "Admin",                 // 1
        "Update",                // 2
        "Delete",                // 3
        "TokenTransfer",         // 4
        "TokenInfuse",           // 5
        "TokenMigrate",          // 6
        "TokenDefuse",           // 7
        "SourceAllocation",      // 8
        "GuildMembership",       // 9
        "SubstationConnection",  // 10
        "AllocationConnection",  // 11
        "GuildTokenBurn",        // 12
        "GuildTokenMint",        // 13
        "GuildEndpointUpdate",   // 14
        "GuildJoinConstraints",  // 15
        "GuildSubstationUpdate", // 16
        "ProviderWithdraw",      // 17
        "ProviderOpen",          // 18
        "ReactorGuildCreate",    // 19
        "HashBuild",             // 20
        "HashMine",              // 21
        "HashRefine",            // 22
        "HashRaid",              // 23
        "GuildUGCUpdate",        // 24
    ];
    if mask == 0 {
        return "none".to_string();
    }
    if mask == crate::mcp::delegation::PERM_ALL {
        return "ALL".to_string();
    }
    let set: Vec<&str> = NAMES
        .iter()
        .enumerate()
        .filter(|(i, _)| mask & (1u64 << i) != 0)
        .map(|(_, name)| *name)
        .collect();
    if set.is_empty() {
        format!("unknown ({})", mask)
    } else {
        set.join(", ")
    }
}

/// Ambit name → bitmask value (Water=2, Land=4, Air=8, Space=16).
/// Returns 0 for an unrecognized/empty ambit.
pub fn ambit_bit(name: &str) -> u64 {
    match name.trim().to_ascii_lowercase().as_str() {
        "water" => 2,
        "land" => 4,
        "air" => 8,
        "space" => 16,
        _ => 0,
    }
}

/// Decode an ambit bitmask into a human-readable list (e.g. 24 → "air, space").
pub fn decode_ambits(mask: u64) -> String {
    let mut out = vec![];
    if mask & 2 != 0 {
        out.push("water");
    }
    if mask & 4 != 0 {
        out.push("land");
    }
    if mask & 8 != 0 {
        out.push("air");
    }
    if mask & 16 != 0 {
        out.push("space");
    }
    if out.is_empty() {
        "none".to_string()
    } else {
        out.join(", ")
    }
}

/// ── The game's unit ladders ────────────────────────────────────────────────
///
/// One transcription of the server's `UNIT_DISPLAY_FORMAT`, matching the
/// webapp's own `formatUnit` and the board's JS copy character for character:
/// the unit is chosen by the INTEGER DIGIT-LENGTH of the raw value, the result
/// is trimmed to at most two decimals, and the postfix is written the way the
/// game writes it (`KW`, `Kg`, no space).
///
/// These previously used magnitude thresholds, `{:.1}`/`{:.2}` and a lower-case
/// `kW`, so an MCP answer and the same figure in the HUD disagreed on both the
/// precision and the spelling.
fn ladder(raw: f64, steps: &[(usize, f64, &str)]) -> String {
    let len = format!("{}", raw.abs().trunc() as i128).len();
    let step = steps
        .iter()
        .find(|(min_digits, _, _)| len >= *min_digits)
        .unwrap_or(&steps[steps.len() - 1]);
    let v = raw / step.1;
    let mut txt = format!("{:.2}", v);
    if txt.ends_with(".00") {
        txt.truncate(txt.len() - 3);
    } else if txt.ends_with('0') {
        txt.truncate(txt.len() - 1);
    }
    format!("{}{}", txt, step.2)
}

/// Format Alpha Matter amount (ualpha → μg/mg/g/Kg/Tg)
pub fn format_alpha(ualpha: f64) -> String {
    ladder(
        ualpha,
        &[(16, 1e18, "Tg"), (10, 1e9, "Kg"), (6, 1e6, "g"), (3, 1e3, "mg"), (0, 1.0, "μg")],
    )
}

/// Format an Alpha amount that arrived in WHOLE Alpha rather than ualpha.
///
/// The webapp's `player.alpha` (and therefore `GameState.alpha`) counts whole
/// Alpha — the same unit `AlphaManager.convertAlphaToUAlpha` multiplies by 10^6
/// before signing. Feeding it to [`format_alpha`], which expects ualpha, under-
/// reported every holding by a factor of a million: 7,546 Alpha printed as
/// "7.55mg" when the player was actually holding 7.55Kg of the stuff.
pub fn format_alpha_whole(alpha: f64) -> String {
    format_alpha(alpha * 1e6)
}

/// Format ore amount (g/Kg/Tg)
pub fn format_ore(ore: f64) -> String {
    ladder(ore, &[(12, 1e12, "Tg"), (4, 1e3, "Kg"), (0, 1.0, "g")])
}

/// Format power (milliwatts → mW/W/KW/MW/TW)
pub fn format_power(milliwatts: f64) -> String {
    ladder(
        milliwatts,
        &[(16, 1e18, "TW"), (10, 1e9, "MW"), (6, 1e6, "KW"), (3, 1e3, "W"), (0, 1.0, "mW")],
    )
}

/// Format a SET of power figures on one shared unit — the unit the largest of
/// them would pick on its own.
///
/// The per-value ladder is right for a single reading (it is what the server
/// and the HUD do), and wrong for a COLUMN meant to be compared: the struct-type
/// table rendered as `50mW / 0.11W / 0.14W / 0.5W / 0.1KW`, five units and three
/// leading zeros down one column of the same quantity. Returns a closure that
/// formats every member against the shared step.
pub fn power_column(values: &[f64]) -> impl Fn(f64) -> String {
    const STEPS: [(usize, f64, &str); 5] = [
        (16, 1e18, "TW"), (10, 1e9, "MW"), (6, 1e6, "KW"), (3, 1e3, "W"), (0, 1.0, "mW"),
    ];
    let max = values.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let len = format!("{}", max.trunc() as i128).len();
    let step = STEPS
        .iter()
        .find(|(min_digits, _, _)| len >= *min_digits)
        .copied()
        .unwrap_or(STEPS[STEPS.len() - 1]);
    move |raw: f64| {
        let v = raw / step.1;
        let mut txt = format!("{:.2}", v);
        if txt.ends_with(".00") {
            txt.truncate(txt.len() - 3);
        } else if txt.ends_with('0') {
            txt.truncate(txt.len() - 1);
        }
        format!("{}{}", txt, step.2)
    }
}

/// Format duration in milliseconds to human-readable string
pub fn format_duration(ms: f64) -> String {
    let seconds = ms / 1000.0;
    if seconds < 60.0 {
        format!("{:.0}s", seconds)
    } else if seconds < 3600.0 {
        format!("{:.0}m", seconds / 60.0)
    } else if seconds < 86400.0 {
        let hours = (seconds / 3600.0).floor();
        let mins = ((seconds % 3600.0) / 60.0).floor();
        if mins > 0.0 {
            format!("{:.0}h {:.0}m", hours, mins)
        } else {
            format!("{:.0}h", hours)
        }
    } else {
        format!("{:.1}d", seconds / 86400.0)
    }
}

/// Resolve an entity ID prefix to its type name
pub fn entity_type_from_id(id: &str) -> &str {
    match id.split('-').next().unwrap_or("") {
        "0" => "Guild",
        "1" => "Player",
        "2" => "Planet",
        "3" => "Reactor",
        "4" => "Substation",
        "5" => "Struct",
        "6" => "Allocation",
        "7" => "Infusion",
        "8" => "Address",
        "9" => "Fleet",
        "10" => "Provider",
        "11" => "Agreement",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned against the webapp's own `formatUnit` (structs-config.js), which
    /// is the transcription of the server's UNIT_DISPLAY_FORMAT. If these drift
    /// the MCP and the HUD start disagreeing about the same number.
    #[test]
    fn ladders_match_the_games_display_format() {
        // digit-length boundaries, not magnitude thresholds
        assert_eq!(format_power(99.0), "99mW");
        assert_eq!(format_power(100.0), "0.1W");
        // 99,999 mW is 99.999 W, which rounds to 100 W — still a 5-digit raw
        // value, so it stays on the W rung rather than jumping to KW.
        assert_eq!(format_power(99_999.0), "100W");
        assert_eq!(format_power(100_000.0), "0.1KW");
        assert_eq!(format_power(15_467_472.0), "15.47KW");
        assert_eq!(format_power(15_515_700_000.0), "15.52MW");
        // Alpha: 7,546 whole Alpha is 7.55 Kg, not 7.55 mg.
        assert_eq!(format_alpha(7546.0), "7.55mg");
        assert_eq!(format_alpha_whole(7546.0), "7.55Kg");
        assert_eq!(format_alpha(1_000_000.0), "1g");
        // Ore's Tg divisor is 1e12 — the JS copy had 1e18.
        assert_eq!(format_ore(999.0), "999g");
        assert_eq!(format_ore(1000.0), "1Kg");
        assert_eq!(format_ore(1e12), "1Tg");
    }

    /// A comparison column shares the LARGEST member's unit, so the figures can
    /// be read against each other instead of each picking its own rung.
    #[test]
    fn power_column_shares_one_unit() {
        // The struct-type draw column: 50 mW … 100 W. Per-value laddering gave
        // "50mW / 0.11W / 0.14W / 0.1KW"; one shared unit gives one column.
        let f = power_column(&[50_000.0, 110_000.0, 135_000.0, 100_000_000.0]);
        assert_eq!(f(50_000.0), "0.05KW");
        assert_eq!(f(135_000.0), "0.14KW");
        assert_eq!(f(100_000_000.0), "100KW");
        // Capacity vs load: a zero load must not drop to mW beside an MW cap.
        let g = power_column(&[15_515_700_000.0, 0.0]);
        assert_eq!(g(15_515_700_000.0), "15.52MW");
        assert_eq!(g(0.0), "0MW");
        // An empty set must not panic.
        assert_eq!(power_column(&[])(0.0), "0mW");
    }

    #[test]
    fn ambit_bits_match_chain_values() {
        assert_eq!(ambit_bit("water"), 2);
        assert_eq!(ambit_bit("Land"), 4);
        assert_eq!(ambit_bit(" AIR "), 8);
        assert_eq!(ambit_bit("space"), 16);
        assert_eq!(ambit_bit("orbit"), 0);
    }

    #[test]
    fn ambit_reachability_semantics() {
        // Tank: land-only weapon (mask 4) hits land, misses space.
        assert_ne!(4u64 & ambit_bit("land"), 0);
        assert_eq!(4u64 & ambit_bit("space"), 0);
        // Starfighter: space-only weapon (mask 16) hits space, misses air.
        assert_ne!(16u64 & ambit_bit("space"), 0);
        assert_eq!(16u64 & ambit_bit("air"), 0);
    }

    #[test]
    fn decode_ambits_lists_set_bits() {
        assert_eq!(decode_ambits(0), "none");
        assert_eq!(decode_ambits(24), "air, space"); // 8 | 16
        assert_eq!(decode_ambits(30), "water, land, air, space"); // command ship
    }

    #[test]
    fn decode_permissions_25bit() {
        assert_eq!(decode_permissions(0), "none");
        assert_eq!(decode_permissions(33_554_431), "ALL"); // 2^25 - 1
        assert_eq!(decode_permissions(1), "Play");
        // Hash bits 20-23 = 1<<20 .. 1<<23 = 15728640
        assert_eq!(
            decode_permissions(15_728_640),
            "HashBuild, HashMine, HashRefine, HashRaid"
        );
        // Bit 24 is the v0.16.0 UGC moderation bit.
        assert_eq!(decode_permissions(1 << 24), "GuildUGCUpdate");
    }

    #[test]
    fn decode_status_known_values() {
        assert_eq!(decode_status(32), "Destroyed");
        assert_eq!(decode_status(4), "Online");
        assert_eq!(decode_status(2), "Offline");
        assert_eq!(decode_status(1), "Building");
        assert_eq!(decode_status(4 | 8), "Online, Stored");
    }

    #[test]
    fn entity_prefixes_include_infusion_and_address() {
        assert_eq!(entity_type_from_id("7-1"), "Infusion");
        assert_eq!(entity_type_from_id("8-3"), "Address");
        assert_eq!(entity_type_from_id("99-1"), "Unknown");
    }
}
