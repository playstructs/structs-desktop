//! Shared JSON config persistence for the small per-feature config files under
//! `<config_dir>/structs-app/`. The auto-loops (and other opt-in features) each
//! keep their own `static CONFIG: LazyLock<RwLock<T>>` + thin `get()/set()`
//! wrappers; this holds the identical load/save boilerplate they all repeated.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::PathBuf;

/// Absolute path of a config file `<config_dir>/structs-app/<filename>`.
pub fn config_path(filename: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join(filename))
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
