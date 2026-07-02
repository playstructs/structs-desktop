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
pub fn load_config<T: DeserializeOwned + Default>(filename: &str) -> T {
    config_path(filename)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
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
