//! Phase 1 update awareness: ask GitHub whether a newer release exists and let
//! the user open the releases page to download it. No in-app download/install —
//! that's Phase 2 (tauri-plugin-updater). See plan for the phased rollout.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// Guards against two concurrent downloads (the Rust startup stager and the
/// frontend "Download" button both call the tauri updater).
static STAGING: AtomicBool = AtomicBool::new(false);

/// GitHub "latest published release" for the desktop app. `/releases/latest`
/// already excludes drafts and prereleases, so this is exactly the build a
/// normal user is expected to be on.
const RELEASES_API: &str =
    "https://api.github.com/repos/playstructs/structs-desktop/releases/latest";
/// Human-facing fallback if the API response lacks an html_url for some reason.
const RELEASES_PAGE: &str = "https://github.com/playstructs/structs-desktop/releases/latest";

/// The manifest tauri's updater reads (`latest.json` on the latest release).
/// Read HERE too, so the banner and the installer agree: a release is only
/// "available" once this manifest carries a build for THIS platform.
const MANIFEST_URL: &str =
    "https://github.com/playstructs/structs-desktop/releases/latest/download/latest.json";

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    /// True only when the release manifest names a version strictly greater
    /// than the running build AND carries a build for this platform. Any
    /// parse/network ambiguity returns false so we never nag about a non-update.
    pub available: bool,
    /// A newer release exists but its installer for this platform is not in
    /// the manifest yet — the three platform builds upload one at a time and
    /// the last can land twenty minutes after the tag (v0.1.351: tag 09:50,
    /// mac build 10:04, manifest 10:08). Say so rather than offering a button
    /// that will answer "no update available".
    pub publishing: bool,
    pub current_version: String,
    pub latest_version: String,
    /// The release page to open in the browser (Phase 1 "download" action).
    pub url: String,
    /// The manifest platform key this build looks itself up by.
    pub target: String,
}

/// The platform key the updater plugin looks up in the manifest, spelled the
/// way it spells it: `darwin-aarch64`, `linux-x86_64`, `windows-x86_64`.
pub fn target_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        "arm" => "armv7",
        other => other,
    };
    format!("{os}-{arch}")
}

/// What the two sources say, decided once. `tag` is the latest release's tag
/// (the release exists), `manifest` its `latest.json` if it could be read.
/// Available needs BOTH a newer manifest version and this platform in it;
/// publishing is a newer tag without that.
pub fn judge(current: &str, tag: &str, manifest: Option<&serde_json::Value>, target: &str) -> (bool, bool, String) {
    let cur = semver::Version::parse(current).ok();
    let newer = |v: &str| matches!((semver::Version::parse(v), cur.as_ref()), (Ok(l), Some(c)) if l > *c);
    let tag_v = tag.trim_start_matches('v');
    let man_v = manifest.and_then(|m| m.get("version")).and_then(|v| v.as_str()).unwrap_or("");
    let has_platform = manifest
        .and_then(|m| m.get("platforms"))
        .and_then(|p| p.get(target))
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .map(|u| !u.is_empty())
        .unwrap_or(false);
    let available = newer(man_v) && has_platform;
    let publishing = !available && newer(tag_v);
    let latest = if available { man_v.to_string() } else { tag_v.to_string() };
    (available, publishing, latest)
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
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    // The manifest, if it is there yet. A 404 here is the normal state for
    // the minutes between a tag and its last uploaded build.
    let manifest = crate::http_proxy::shared_client()
        .get(MANIFEST_URL)
        .header("User-Agent", "structs-desktop")
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success());
    let manifest: Option<serde_json::Value> = match manifest {
        Some(r) => r.json().await.ok(),
        None => None,
    };
    let target = target_key();
    let (available, publishing, latest) = judge(current, tag, manifest.as_ref(), &target);
    Ok(UpdateInfo {
        available,
        publishing,
        current_version: current.to_string(),
        latest_version: latest,
        url,
        target,
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
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => {
            // Nothing newer in the manifest for this platform. Say which of
            // the two that is: the release still publishing (the banner saw
            // its tag), or genuinely nothing newer.
            let info = check_for_update().await.unwrap_or(UpdateInfo {
                available: false, publishing: false, current_version: env!("CARGO_PKG_VERSION").into(),
                latest_version: String::new(), url: RELEASES_PAGE.into(), target: target_key(),
            });
            return Err(if info.publishing {
                format!(
                    "v{} is still publishing — its build for {} has not been uploaded yet. Try again in a few minutes.",
                    info.latest_version, info.target
                )
            } else {
                format!("No update available: v{} is the latest build for {}", info.current_version, info.target)
            });
        }
    };
    stage_update(&app, update, true).await
}

/// Shared download+install path. `emit_progress` drives the frontend banner's
/// progress UI; the startup stager passes false (no webview listening). Serialized
/// by `STAGING` so the auto-stager and the manual button can't double-download.
async fn stage_update(
    app: &tauri::AppHandle,
    update: tauri_plugin_updater::Update,
    emit_progress: bool,
) -> Result<(), String> {
    if STAGING.swap(true, Ordering::SeqCst) {
        return Err("An update download is already in progress".to_string());
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            STAGING.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard;

    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let finish_app = app.clone();
    let downloaded_cb = downloaded.clone();

    update
        .download_and_install(
            move |chunk_len, content_len| {
                if !emit_progress {
                    return;
                }
                let total = downloaded_cb.fetch_add(chunk_len as u64, Ordering::Relaxed)
                    + chunk_len as u64;
                let pct = content_len
                    .map(|c| if c > 0 { (total as f64 / c as f64) * 100.0 } else { 0.0 })
                    .unwrap_or(0.0);
                let _ = crate::mcp::events::emit(&progress_app, crate::mcp::events::AppEvent::UpdateProgress(pct));
            },
            move || {
                let _ = crate::mcp::events::emit(&finish_app, crate::mcp::events::AppEvent::UpdateReady);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Rust-side startup updater (webview-independent) ──
//
// The frontend banner is the nice in-app path, but it only runs if the webview
// is healthy. A build broken badly enough to crash/loop its own frontend could
// never replace itself. This startup task checks the signed updater manifest
// directly from Rust and, if a newer build exists, downloads + stages it and
// fires a NATIVE notification — no webview required. It never auto-restarts, so
// a live game / PoW session is untouched; the update applies on the next launch.

fn staged_marker_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("structs-app")
        .join("staged_update.txt")
}

fn already_staged(version: &str) -> bool {
    std::fs::read_to_string(staged_marker_path())
        .map(|s| s.trim() == version)
        .unwrap_or(false)
}

fn mark_staged(version: &str) {
    let path = staged_marker_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, version);
}

/// Spawn the startup update check. Runs once, shortly after launch, off the main
/// thread. Safe to call unconditionally — it no-ops when already up to date.
pub fn check_and_stage_on_startup(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let the app settle (window, IPC, notification permission, initial PoW)
        // before competing for network/CPU.
        tokio::time::sleep(Duration::from_secs(25)).await;
        match run_startup_update(&app).await {
            Ok(Some(v)) => eprintln!("[Structs Update] v{v} staged — restart to apply"),
            Ok(None) => {}
            Err(e) => eprintln!("[Structs Update] startup check: {e}"),
        }
    });
}

async fn run_startup_update(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => return Ok(None), // already on the latest signed build
    };
    let version = update.version.clone();

    // Already downloaded on a previous run and the user hasn't restarted yet —
    // don't re-download, just re-remind.
    if already_staged(&version) {
        crate::notifications::notify_on(
            "update",
            "Structs update ready",
            &format!("Version {version} is downloaded — restart Structs to finish updating."),
        );
        return Ok(Some(version));
    }

    crate::notifications::notify_on(
        "update",
        "Structs update available",
        &format!("Downloading version {version} in the background…"),
    );

    stage_update(app, update, false).await?;
    mark_staged(&version);

    crate::notifications::notify_on(
        "update",
        "Structs update ready",
        &format!("Version {version} is downloaded — restart Structs to finish updating."),
    );
    Ok(Some(version))
}

/// Relaunch the app to run on the freshly-staged update. Invoked when the user
/// accepts the "Restart to update" prompt.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(version: &str, platforms: &[&str]) -> serde_json::Value {
        let mut p = serde_json::Map::new();
        for k in platforms {
            p.insert((*k).into(), json!({ "url": format!("https://x/{k}"), "signature": "sig" }));
        }
        json!({ "version": version, "platforms": p })
    }

    #[test]
    fn the_target_key_is_spelled_the_way_the_plugin_spells_it() {
        let t = target_key();
        assert!(t.contains('-'));
        if cfg!(target_os = "macos") {
            assert!(t.starts_with("darwin-"));
        }
        assert!(!t.contains("macos") && !t.contains("x86-"));
    }

    #[test]
    fn a_tag_without_a_build_for_this_platform_is_publishing_not_available() {
        // The v0.1.351 race: tag at 09:50, mac build at 10:04, manifest at 10:08.
        let (a, p, latest) = judge("0.1.350", "v0.1.351", None, "darwin-aarch64");
        assert!(!a && p, "no manifest yet");
        assert_eq!(latest, "0.1.351");
        let linux_only = manifest("0.1.351", &["linux-x86_64", "linux-x86_64-appimage"]);
        let (a, p, _) = judge("0.1.350", "v0.1.351", Some(&linux_only), "darwin-aarch64");
        assert!(!a && p, "the manifest is there but not our platform");
        let stale = manifest("0.1.350", &["darwin-aarch64"]);
        let (a, p, _) = judge("0.1.350", "v0.1.351", Some(&stale), "darwin-aarch64");
        assert!(!a && p, "the previous release's manifest still answers");
    }

    #[test]
    fn a_manifest_with_our_platform_is_available() {
        let m = manifest("0.1.351", &["darwin-aarch64", "linux-x86_64"]);
        let (a, p, latest) = judge("0.1.350", "v0.1.351", Some(&m), "darwin-aarch64");
        assert!(a && !p);
        assert_eq!(latest, "0.1.351");
    }

    #[test]
    fn nothing_newer_is_neither() {
        let m = manifest("0.1.351", &["darwin-aarch64"]);
        let (a, p, _) = judge("0.1.351", "v0.1.351", Some(&m), "darwin-aarch64");
        assert!(!a && !p);
        let (a, p, _) = judge("0.1.352", "v0.1.351", Some(&m), "darwin-aarch64");
        assert!(!a && !p, "a local build ahead of the release");
    }
}
