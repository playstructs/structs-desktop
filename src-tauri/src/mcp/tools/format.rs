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
    // PermAll = 2^25 - 1
    if mask == 33_554_431 {
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

/// Format Alpha Matter amount (ualpha → μg/mg/g/Kg/Tg)
pub fn format_alpha(ualpha: f64) -> String {
    let abs = ualpha.abs();
    if abs >= 1e18 {
        format!("{:.2}Tg", ualpha / 1e18)
    } else if abs >= 1e9 {
        format!("{:.2}Kg", ualpha / 1e9)
    } else if abs >= 1e6 {
        format!("{:.2}g", ualpha / 1e6)
    } else if abs >= 1e3 {
        format!("{:.2}mg", ualpha / 1e3)
    } else {
        format!("{:.0}μg", ualpha)
    }
}

/// Format ore amount (g/Kg/Tg)
pub fn format_ore(ore: f64) -> String {
    if ore >= 1e12 {
        format!("{:.2}Tg", ore / 1e12)
    } else if ore >= 1e3 {
        format!("{:.2}Kg", ore / 1e3)
    } else {
        format!("{:.0}g", ore)
    }
}

/// Format power (milliwatts → mW/W/KW/MW/TW)
pub fn format_power(milliwatts: f64) -> String {
    let abs = milliwatts.abs();
    if abs >= 1e18 {
        format!("{:.1}TW", milliwatts / 1e18)
    } else if abs >= 1e9 {
        format!("{:.1}MW", milliwatts / 1e9)
    } else if abs >= 1e6 {
        // Lower-case k, matching the SI prefix and the JS ladder in board.js.
        format!("{:.1}kW", milliwatts / 1e6)
    } else if abs >= 1e3 {
        format!("{:.1}W", milliwatts / 1e3)
    } else {
        format!("{:.0}mW", milliwatts)
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
