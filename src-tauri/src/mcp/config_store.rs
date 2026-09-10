//! Shared JSON config persistence for the small per-feature config files under
//! `<config_dir>/structs-app/`. The auto-loops (and other opt-in features) each
//! keep their own `static CONFIG: LazyLock<RwLock<T>>` + thin `get()/set()`
//! wrappers; this holds the identical load/save boilerplate they all repeated.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::PathBuf;

/// Absolute path of a config file `<config_dir>/structs-app/<filename>`.
pub fn config_path(filename: &str) -> Option<PathBuf> {
    #[cfg(not(test))]
    {
        dirs::config_dir().map(|d| d.join("structs-app").join(filename))
    }
    #[cfg(test)]
    {
        // Profile tests exercise real save/rename operations after replacing
        // the in-memory store. Never read or overwrite the user's settings.
        static ROOT: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| {
            std::env::temp_dir().join(format!("structs-app-tests-{}", uuid::Uuid::new_v4()))
        });
        Some(ROOT.join(filename))
    }
}

/// Load a config from disk, falling back to `Default` on any error (missing
/// file, unreadable, malformed JSON).
/// Read a persisted config, falling back to `Default` when it is missing.
///
/// A PARSE FAILURE is not the same as a missing file and must never be quiet.
/// Adding one non-defaulted field to a config struct invalidates every copy
/// already on disk; the old code swallowed that with `.ok()` and returned
/// `Default`, which for the combat loops means `enabled: false`. `auto_raid`
/// spent a day switched off while its file said `true` and nothing anywhere
/// said why — the watchdog reads `enabled` from this same value, so it saw a
/// disabled loop rather than a broken one.
///
/// Prefer `#[serde(default)]` on every new field. This log line is the net that
/// catches it when someone forgets.
pub fn load_config<T: DeserializeOwned + Default>(filename: &str) -> T {
    let Some(raw) = config_path(filename).and_then(|p| std::fs::read_to_string(p).ok()) else {
        return T::default(); // no file yet — first run, genuinely fine
    };
    match serde_json::from_str(&raw) {
        Ok(cfg) => cfg,
        Err(e) => {
            crate::mcp::telemetry::tlog(
                "config",
                crate::mcp::telemetry::Sev::Error,
                format!(
                    "{filename} failed to parse ({e}) — FALLING BACK TO DEFAULTS, \
                     which disables any loop this config controls. Most likely a new \
                     field was added without #[serde(default)]."
                ),
            );
            T::default()
        }
    }
}

/// Persist a config to disk (pretty JSON), creating the parent dir. Errors are
/// swallowed — persistence is best-effort, the in-memory copy is authoritative.
pub fn save_config<T: Serialize>(filename: &str, cfg: &T) {
    if let (Some(p), Ok(json)) = (config_path(filename), serde_json::to_string_pretty(cfg)) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_round_trips_outside_the_user_directory() {
        let path = config_path("profile-isolation-check.json").unwrap();
        let real = dirs::config_dir().unwrap().join("structs-app");
        assert!(!path.starts_with(real));
        assert!(path.starts_with(std::env::temp_dir()));
        let expected = vec!["saved test profile".to_string()];
        save_config("profile-isolation-check.json", &expected);
        assert_eq!(load_config::<Vec<String>>("profile-isolation-check.json"), expected);
        std::fs::remove_file(path).unwrap();
    }
}
