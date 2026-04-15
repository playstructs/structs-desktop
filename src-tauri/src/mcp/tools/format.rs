/// Shared formatting utilities for human-readable MCP output.
/// Used by dashboard, intel, action, and query tools.

/// Decode struct status bitflags to human-readable string.
/// Flags: 1=Materialized, 2=Built, 4=Online, 8=Stored, 16=Hidden, 32=Destroyed, 64=Locked
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
        format!("{:.1}KW", milliwatts / 1e6)
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
        "9" => "Fleet",
        "10" => "Provider",
        "11" => "Agreement",
        _ => "Unknown",
    }
}
