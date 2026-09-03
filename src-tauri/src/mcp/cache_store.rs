//! Data caches that survive a restart.
//!
//! `config_store` holds the small per-feature CONFIG files. This is its
//! sibling for DATA: the roster, the galaxy snapshot, the player directory,
//! the raid and response loops' memories, fetched images — everything the app
//! rebuilds from the network or the chain at launch and used to throw away on
//! exit. Storage is cheap; a cold start that shows last session's figures at
//! once, and a raid loop that still knows which fleets are away, are not.
//!
//! Every file lives under `<config_dir>/structs-app/cache/<name>.json` and is
//! written whole, write-then-rename, so a launch never reads a half-written
//! file. Readers treat what comes back as LAST KNOWN, never as live: each
//! cache keeps its own freshness stamps and its own rule for when a restored
//! value must be re-read before anything acts on it.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::PathBuf;

/// `<config_dir>/structs-app/cache/<name>.json`.
pub fn cache_path(name: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join("cache").join(format!("{name}.json")))
}

/// Write a cache whole. Compact JSON (these can run to tens of megabytes),
/// parent created, write-then-rename. Errors are swallowed: persistence is
/// best-effort and the in-memory copy is authoritative.
pub fn save<T: Serialize>(name: &str, value: &T) {
    let Some(path) = cache_path(name) else { return };
    let Ok(body) = serde_json::to_vec(value) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// `save`, off the calling thread. For the big ones (the galaxy snapshot)
/// and for anything called from inside a loop tick, where a disk write must
/// not hold a lock or delay the next scan. The value is moved, so the caller
/// hands over a clone taken under the lock and releases it.
pub fn save_in_background<T: Serialize + Send + 'static>(name: &'static str, value: T) {
    std::thread::Builder::new()
        .name(format!("cache-save-{name}"))
        .spawn(move || save(name, &value))
        .ok();
}

/// Read a cache back. `None` when there is no file yet — the normal first
/// launch — and also on a parse failure, which is logged: a shape change
/// without `#[serde(default)]` should show up as a line, not as a cache that
/// silently never restores again.
pub fn load<T: DeserializeOwned>(name: &str) -> Option<T> {
    let path = cache_path(name)?;
    let body = std::fs::read(&path).ok()?;
    match serde_json::from_slice(&body) {
        Ok(v) => Some(v),
        Err(e) => {
            crate::mcp::telemetry::tlog(
                "cache",
                crate::mcp::telemetry::Sev::Warn,
                format!("{name}.json failed to parse ({e}) — starting that cache empty"),
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_cache_is_none_not_an_error() {
        assert!(load::<Vec<u8>>("definitely-not-a-cache-name-9f3a").is_none());
    }
}
