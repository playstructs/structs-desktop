//! Shared JSON config persistence for the small per-feature config files under
//! `<config_dir>/structs-app/`. The auto-loops (and other opt-in features) each
//! keep their own `static CONFIG: LazyLock<RwLock<T>>` + thin `get()/set()`
//! wrappers; this holds the identical load/save boilerplate they all repeated.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

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
    let Some(path) = config_path(filename) else { return T::default() };
    load_or_default(&path)
}

/// Persist a config to disk (pretty JSON), creating the parent dir. A failure
/// is logged and otherwise swallowed — persistence is best-effort, the
/// in-memory copy is authoritative. Use [`try_save_config`] when the caller
/// must not proceed unless the write happened.
pub fn save_config<T: Serialize>(filename: &str, cfg: &T) {
    if let Err(e) = try_save_config(filename, cfg) {
        crate::mcp::telemetry::tlog("config", crate::mcp::telemetry::Sev::Warn, format!("{filename} not saved: {e}"));
    }
}

/// [`save_config`], reporting the failure.
pub fn try_save_config<T: Serialize>(filename: &str, cfg: &T) -> Result<(), String> {
    let path = config_path(filename).ok_or("no config directory")?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_state(&path, json.as_bytes())
}

// ── The file itself ─────────────────────────────────────────────────────────
//
// "No file" and "could not read the file" are different answers, and only the
// first may be answered by writing a fresh one. Taking every failed read for a
// missing file is how a momentary I/O error (too many open files, a crash half
// way through a plain `fs::write`) becomes a permanent loss at the next save.

/// What a state file said.
pub enum FileRead<T> {
    /// No file: nothing has been saved yet.
    Missing,
    /// The OS would not let us read it. Says nothing about the contents.
    Unreadable(String),
    /// Read, but it is not what we write.
    Corrupt(String),
    Read(T),
}

pub fn read_state<T: DeserializeOwned>(path: &Path) -> FileRead<T> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileRead::Missing,
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => return FileRead::Corrupt(e.to_string()),
        Err(e) => return FileRead::Unreadable(e.to_string()),
    };
    match serde_json::from_str(&raw) {
        Ok(v) => FileRead::Read(v),
        Err(e) => FileRead::Corrupt(e.to_string()),
    }
}

/// Files whose contents we failed to read: writing one would replace what we
/// never saw. Held for the life of the process, because the in-memory copy
/// that would be written started from nothing.
static PROTECTED: LazyLock<Mutex<HashMap<PathBuf, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Refuse every later write to `path`.
pub fn protect(path: &Path, why: &str) {
    PROTECTED.lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf(), why.to_string());
}

/// Why writes to `path` are refused, if they are.
pub fn write_refused(path: &Path) -> Option<String> {
    PROTECTED.lock().unwrap_or_else(|e| e.into_inner()).get(path).cloned()
}

/// Read a state file, or defaults, protecting a file that did not read.
pub fn load_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config").to_string();
    let error = |msg: String| crate::mcp::telemetry::tlog("config", crate::mcp::telemetry::Sev::Error, msg);
    match read_state(path) {
        FileRead::Read(v) => v,
        FileRead::Missing => T::default(), // first run, genuinely fine
        FileRead::Corrupt(e) => {
            // Set the original aside so falling back does not destroy it.
            let aside = set_aside(path);
            error(format!(
                "{name} failed to parse ({e}) — FALLING BACK TO DEFAULTS, which disables any loop this config \
                 controls. Most likely a new field was added without #[serde(default)]. {}",
                match &aside {
                    Some(p) => format!("The file was kept as {}.", p.display()),
                    None => "It could not be copied aside, so it will not be written over.".into(),
                }
            ));
            if aside.is_none() {
                protect(path, "its contents could not be parsed or copied aside");
            }
            T::default()
        }
        FileRead::Unreadable(e) => {
            error(format!("{name} could not be read ({e}) — using defaults and leaving the file alone until restart"));
            protect(path, "it could not be read at launch");
            T::default()
        }
    }
}

/// Copy a file we cannot parse beside itself. `None` when that failed.
pub fn set_aside(path: &Path) -> Option<PathBuf> {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let mut name = path.file_name()?.to_os_string();
    name.push(format!(".corrupt-{secs}"));
    let to = path.with_file_name(name);
    std::fs::copy(path, &to).ok().map(|_| to)
}

/// Write beside the file, then rename over it: a reader (or the next launch,
/// after a crash) sees the old contents or the new, never half of either.
/// Keeps the existing file's permissions.
pub fn write_state(path: &Path, body: &[u8]) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    if let Some(why) = write_refused(path) {
        return Err(format!("{} is not being written: {why}", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut name = path.file_name().ok_or("not a file path")?.to_os_string();
    name.push(format!(".{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let tmp = path.with_file_name(name);
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        if let Ok(meta) = std::fs::metadata(path) {
            f.set_permissions(meta.permissions())?;
        }
        std::io::Write::write_all(&mut f, body)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
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

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("structs-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// A file that does not parse falls back to defaults, and the original
    /// survives the save that follows.
    #[test]
    fn a_corrupt_file_is_kept_before_it_is_replaced() {
        let p = scratch("fleet.json");
        std::fs::write(&p, r#"["miner one","miner tw"#).unwrap();
        assert_eq!(load_or_default::<Vec<String>>(&p), Vec::<String>::new());
        write_state(&p, b"[]").unwrap();
        let kept: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("fleet.json.corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read_to_string(kept[0].path()).unwrap(), r#"["miner one","miner tw"#);
    }

    /// A file we could not read is never written over. (A directory in its
    /// place is an unreadable file every platform and user agrees on.)
    #[test]
    fn an_unreadable_file_is_left_alone() {
        let p = scratch("fleet.json");
        std::fs::create_dir(&p).unwrap();
        assert!(matches!(read_state::<Vec<String>>(&p), FileRead::Unreadable(_)));
        assert_eq!(load_or_default::<Vec<String>>(&p), Vec::<String>::new());
        assert!(write_state(&p, b"[]").unwrap_err().contains("not being written"));
        // A missing file is the one that may be created.
        let fresh = scratch("new.json");
        assert!(matches!(read_state::<Vec<String>>(&fresh), FileRead::Missing));
        write_state(&fresh, b"[]").unwrap();
        assert_eq!(std::fs::read_dir(fresh.parent().unwrap()).unwrap().count(), 1, "no temporary left behind");
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_stays_private() {
        use std::os::unix::fs::PermissionsExt;
        let p = scratch("secret.json");
        std::fs::write(&p, "{}").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_state(&p, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
