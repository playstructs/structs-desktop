//! Phase 1 update awareness: ask GitHub whether a newer release exists and let
//! the user open the releases page to download it. No in-app download/install —
//! that's Phase 2 (tauri-plugin-updater). See plan for the phased rollout.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// GitHub "latest published release" for the desktop app. `/releases/latest`
/// already excludes drafts and prereleases, so this is exactly the build a
/// normal user is expected to be on.
const RELEASES_API: &str =
    "https://api.github.com/repos/playstructs/structs-desktop/releases/latest";
/// Human-facing fallback if the API response lacks an html_url for some reason.
const RELEASES_PAGE: &str = "https://github.com/playstructs/structs-desktop/releases/latest";

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    /// True only when the latest release parses as a semver strictly greater
    /// than the running build. Any parse/network ambiguity returns false so we
    /// never nag the user about a non-update.
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    /// The release page to open in the browser (Phase 1 "download" action).
    pub url: String,
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    // Set at release time by scripts/sync-version.py from the git tag; in dev
    // it's the placeholder in Cargo.toml (so dev always sees "update available",
    // which is handy for testing the banner).
    let current = env!("CARGO_PKG_VERSION");

    // Reuse the shared client (10s timeout, cookie store). GitHub requires a
    // User-Agent on API requests or it 403s.
    let resp = crate::http_proxy::shared_client()
        .get(RELEASES_API)
        .header("User-Agent", "structs-desktop")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("GitHub releases API returned {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let latest_raw = tag.trim_start_matches('v');
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    let available = match (
        semver::Version::parse(latest_raw),
        semver::Version::parse(current),
    ) {
        (Ok(latest), Ok(cur)) => latest > cur,
        _ => false,
    };

    Ok(UpdateInfo {
        available,
        current_version: current.to_string(),
        latest_version: latest_raw.to_string(),
        url,
    })
}

/// Open an external URL in the user's default browser. Used as the fallback
/// "Download" action when in-app install isn't possible (e.g. Linux .deb).
/// Called from Rust through the opener plugin so the frontend only ever speaks
/// `invoke`, matching the rest of the app.
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ── Phase 2: in-app download + install via tauri-plugin-updater ──

/// Whether tauri's self-updater can actually install on THIS build. The updater
/// replaces the running bundle in place, which works for macOS .app, the
/// Windows NSIS installer, and Linux AppImage — but NOT a Linux .deb (that
/// needs `sudo dpkg`). AppImage sets the `APPIMAGE` env var at runtime, so its
/// absence on Linux means we're a .deb and must fall back to opening the page.
#[tauri::command]
pub fn updater_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Download and stage the latest update, emitting `structs://update-progress`
/// (0–100) as bytes arrive and `structs://update-ready` when staged. The app is
/// NOT restarted here — the frontend shows a "Restart to update" prompt and
/// calls `relaunch_app` when the user is ready, so a live game / PoW session is
/// never interrupted under the user. Returns Err if no updater artifact /
/// `latest.json` is reachable, in which case the frontend falls back to
/// `open_url`.
#[tauri::command]
pub async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    // on_chunk reports this chunk's length + the total content length; accumulate
    // to a percentage. Arc<AtomicU64> because the progress callback is `Fn`.
    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let finish_app = app.clone();
    let downloaded_cb = downloaded.clone();

    update
        .download_and_install(
            move |chunk_len, content_len| {
                let total = downloaded_cb.fetch_add(chunk_len as u64, Ordering::Relaxed)
                    + chunk_len as u64;
                let pct = content_len
                    .map(|c| if c > 0 { (total as f64 / c as f64) * 100.0 } else { 0.0 })
                    .unwrap_or(0.0);
                let _ = progress_app.emit("structs://update-progress", pct);
            },
            move || {
                let _ = finish_app.emit("structs://update-ready", ());
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Relaunch the app to run on the freshly-staged update. Invoked when the user
/// accepts the "Restart to update" prompt.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}
