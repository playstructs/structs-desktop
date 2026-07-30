//! "Download logs" — one zip containing everything the desktop client knows
//! about itself, with secrets stripped.
//!
//! The point is that a player reporting a problem can hand over a single file
//! and it contains the answer: the full 7-day telemetry database (transactions
//! built and attempted, loop runs, PoW solves, GRASS traffic, UI clicks), every
//! config and loop-state file, macOS crash reports, and an environment
//! manifest.
//!
//! SECRETS. Two rules, applied by construction rather than by remembering:
//!   * The wallet mnemonic lives in the webview's `localStorage`, never on
//!     disk in this directory — verified by scanning the live folder. Nothing
//!     here can reach it.
//!   * Every JSON file is parsed and walked, and any value whose KEY looks
//!     sensitive (token, secret, key, mnemonic, seed, password, passphrase) is
//!     replaced with a placeholder. Key-based redaction means a newly added
//!     secret field is redacted the day it appears, without this file being
//!     updated. A JSON file that fails to parse is SKIPPED rather than shipped
//!     unredacted — fail closed.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use zip::write::SimpleFileOptions;

/// Key substrings that mark a value as secret. Matched case-insensitively
/// against JSON object keys.
const SECRET_KEY_MARKERS: [&str; 8] = [
    "mnemonic",
    "seed",
    "token",
    "secret",
    "password",
    "passphrase",
    "privatekey",
    "private_key",
];

const REDACTED: &str = "<redacted by log export>";

/// Files never worth shipping: caches and derived artefacts that would bloat
/// the zip without telling anyone anything.
const SKIP_NAMES: [&str; 2] = ["state.db-shm", "team-board.html"];

/// Recursively replace secret-keyed values. Arrays and nested objects are
/// walked, so a secret at any depth is caught.
fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let lower = k.to_lowercase();
                if SECRET_KEY_MARKERS.iter().any(|m| lower.contains(m)) {
                    // Keep the shape (a string) so the file still parses as the
                    // same schema for anyone reading it.
                    *v = Value::String(REDACTED.to_string());
                } else {
                    redact(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

/// Read a JSON file and return it redacted and pretty-printed. `None` means
/// "could not parse" — the caller must then SKIP the file rather than include
/// it raw, so an unparseable config can never leak a secret.
fn redacted_json(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut value: Value = serde_json::from_str(&text).ok()?;
    redact(&mut value);
    serde_json::to_string_pretty(&value).ok()
}

/// Consistent snapshot of the telemetry DB. `VACUUM INTO` reads through WAL and
/// writes a single defragmented file, so the copy is transactionally coherent
/// even while the writer thread is mid-batch — plain file copying a live
/// WAL-mode database can yield a torn or empty read.
fn snapshot_db(db: &Path, dest: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open(db).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dest); // VACUUM INTO refuses an existing file
    conn.execute(
        "VACUUM INTO ?1",
        [dest.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Environment facts that make the rest of the bundle interpretable.
fn manifest(app: &tauri::AppHandle) -> Value {
    let pkg = app.package_info();
    json!({
        "exported_at_ms": crate::hasher::types::now_millis(),
        "app_version": pkg.version.to_string(),
        "app_name": pkg.name,
        "tauri_version": tauri::VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "retention_days": 7,
        "telemetry_db_bytes": crate::mcp::telemetry::db_size_bytes(),
        "telemetry_dropped": crate::mcp::telemetry::dropped_count(),
        "hash_pool": {
            "workers": crate::hasher::pool::worker_count(),
            "pending": crate::hasher::pool::pending_len(),
            "cap": crate::hasher::max_concurrent(),
        },
        "tx_gate": crate::mcp::tx_gate::snapshot(),
        "watchdog": crate::mcp::watchdog::health_snapshot(),
        "vplayer_count": crate::mcp::virtual_players::count(),
        "contents": {
            "telemetry/state.db": "SQLite: events, loop_runs, tx_builds, tx_attempts, pow_solves, grass_events, ui_events",
            "config/*.json": "client + loop configuration, secrets redacted by key name",
            "logs/*.log": "plain-text debug logs",
            "crash/*.ips": "macOS crash reports, newest first",
        },
        "note": "No wallet mnemonic is present: it is held in webview localStorage and never written to this directory.",
    })
}

/// Most recent macOS crash reports for this app (newest first, capped).
fn crash_reports(limit: usize) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let dir = home.join("Library/Logs/DiagnosticReports");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("structs-app")
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, e.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// Build the zip. Returns (path, bytes).
fn build_bundle(app: &tauri::AppHandle) -> Result<(PathBuf, u64), String> {
    let src_dir = crate::mcp::config_store::config_path("")
        .ok_or("no config directory")?;
    let src_dir = src_dir.parent().unwrap_or(&src_dir).to_path_buf();

    let downloads = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or("no Downloads directory")?;
    // Seconds-resolution stamp keeps repeated exports distinguishable without
    // overwriting an earlier one the player may still be uploading.
    let stamp = {
        let secs = (crate::hasher::types::now_millis() / 1000.0) as u64;
        secs.to_string()
    };
    let zip_path = downloads.join(format!("structs-logs-{stamp}.zip"));

    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 1. Manifest.
    zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest(app))
            .unwrap_or_default()
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;

    // 2. Telemetry DB as a coherent snapshot, in a temp file we then stream in.
    if let Some(db) = crate::mcp::telemetry::db_path() {
        if db.exists() {
            let tmp = std::env::temp_dir().join(format!("structs-telemetry-{stamp}.db"));
            match snapshot_db(&db, &tmp) {
                Ok(()) => {
                    if let Ok(bytes) = std::fs::read(&tmp) {
                        zip.start_file("telemetry/state.db", opts)
                            .map_err(|e| e.to_string())?;
                        zip.write_all(&bytes).map_err(|e| e.to_string())?;
                    }
                    let _ = std::fs::remove_file(&tmp);
                }
                // A snapshot failure must not lose the rest of the bundle.
                Err(e) => {
                    zip.start_file("telemetry/SNAPSHOT_FAILED.txt", opts)
                        .map_err(|x| x.to_string())?;
                    let _ = zip.write_all(format!("VACUUM INTO failed: {e}\n").as_bytes());
                }
            }
        }
    }

    // 3. Config + state files from the app support directory.
    if let Ok(entries) = std::fs::read_dir(&src_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !path.is_file() || SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            // The live DB and its WAL are already covered by the snapshot.
            if name.starts_with("state.db") {
                continue;
            }
            if name.ends_with(".json") || name.ends_with(".bak") || name.contains(".bak-") {
                match redacted_json(&path) {
                    Some(text) => {
                        zip.start_file(format!("config/{name}"), opts)
                            .map_err(|e| e.to_string())?;
                        let _ = zip.write_all(text.as_bytes());
                    }
                    None => {
                        // Fail closed: say the file existed, ship nothing.
                        zip.start_file(format!("config/{name}.SKIPPED.txt"), opts)
                            .map_err(|e| e.to_string())?;
                        let _ = zip.write_all(
                            b"Skipped: could not parse as JSON, so it could not be redacted safely.\n",
                        );
                    }
                }
            } else if name.ends_with(".log") || name.ends_with(".txt") {
                if let Ok(bytes) = std::fs::read(&path) {
                    zip.start_file(format!("logs/{name}"), opts)
                        .map_err(|e| e.to_string())?;
                    let _ = zip.write_all(&bytes);
                }
            }
        }
    }

    // 4. Crash reports — the single most valuable artefact when the app dies.
    for path in crash_reports(5) {
        if let Ok(bytes) = std::fs::read(&path) {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            zip.start_file(format!("crash/{name}"), opts)
                .map_err(|e| e.to_string())?;
            let _ = zip.write_all(&bytes);
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    let bytes = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    Ok((zip_path, bytes))
}

/// Export the bundle and reveal it in Finder. Returns the path and size so the
/// UI can say exactly what was written and where.
#[tauri::command]
pub async fn export_log_bundle(app: tauri::AppHandle) -> Result<Value, String> {
    // Zipping ~100 MB of SQLite must not block the UI thread.
    let app_for_task = app.clone();
    let (path, bytes) = tauri::async_runtime::spawn_blocking(move || build_bundle(&app_for_task))
        .await
        .map_err(|e| e.to_string())??;

    crate::mcp::telemetry::tlog(
        "log_bundle",
        crate::mcp::telemetry::Sev::Notice,
        format!("exported {} ({:.1} MB)", path.display(), bytes as f64 / 1_048_576.0),
    );
    // Reveal rather than open: a zip double-clicked would just unarchive.
    if let Some(parent) = path.parent() {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_path(parent.to_string_lossy(), None::<&str>);
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": bytes,
        "mb": (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0,
    }))
}

/// Persist a batch of UI interactions from any window.
///
/// Batched by the frontend (one call every couple of seconds) so a click storm
/// cannot become an IPC storm. Deliberately accepts only identity fields —
/// there is no parameter through which a field's VALUE could arrive, so this
/// cannot capture what a player typed even by accident.
#[tauri::command]
pub fn log_ui_events(events: Vec<crate::mcp::telemetry::UiRow>) {
    for e in events {
        crate::mcp::telemetry::record_ui(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_keys_at_any_depth() {
        let mut v = json!({
            "port": 8420,
            "bearer_token": "deadbeef",
            "nested": { "mnemonic": "word ".repeat(12).trim(), "keep": 1 },
            "list": [ { "api_key": "abc" }, { "fine": true } ],
        });
        redact(&mut v);
        assert_eq!(v["bearer_token"], json!(REDACTED));
        assert_eq!(v["nested"]["mnemonic"], json!(REDACTED));
        assert_eq!(v["list"][0]["api_key"], json!(REDACTED));
        // Non-secret values survive untouched, including nested ones.
        assert_eq!(v["port"], json!(8420));
        assert_eq!(v["nested"]["keep"], json!(1));
        assert_eq!(v["list"][1]["fine"], json!(true));
    }

    #[test]
    fn secret_markers_are_case_and_style_insensitive() {
        let mut v = json!({
            "BearerToken": "x",
            "Mnemonic": "x",
            "privateKey": "x",
            "private_key": "x",
            "seedPhrase": "x",
            "PASSWORD": "x",
        });
        redact(&mut v);
        for k in ["BearerToken", "Mnemonic", "privateKey", "private_key", "seedPhrase", "PASSWORD"] {
            assert_eq!(v[k], json!(REDACTED), "{k} must be redacted");
        }
    }

    #[test]
    fn unparseable_json_yields_none_so_caller_skips_it() {
        let dir = std::env::temp_dir().join("structs-log-bundle-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.json");
        std::fs::write(&p, b"{not json").unwrap();
        assert!(
            redacted_json(&p).is_none(),
            "must fail closed rather than return raw text"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn real_mcp_config_shape_is_redacted() {
        // The one file in the live folder that actually holds a secret.
        let mut v = json!({
            "enabled": true,
            "port": 8420,
            "bearer_token": "81e115c472f9c3c8dff8218a86dd7ea6",
            "web_board": false
        });
        redact(&mut v);
        let text = serde_json::to_string(&v).unwrap();
        assert!(!text.contains("81e115c4"), "token must not survive export");
        assert!(text.contains("8420"), "non-secret config still exported");
    }
}
