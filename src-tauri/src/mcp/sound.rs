//! Sound mount points: which local audio file plays for which cue.
//!
//! The sound system is three parts. The CATALOGUE (`frontend/sound-catalogue.js`)
//! names every mount point the game can cue — `fire.tank.primary`,
//! `ui.press`, `raid.base_raided.music` — and every one of them is SILENT
//! until a designer points it at a file. The ENGINE (`frontend/sound.js`)
//! plays whatever a mount is pointed at, in whichever window fired the cue.
//! This module is the STORE: `sound.json` under `<config_dir>/structs-app/`,
//! the native file picker, and the byte stream the engine decodes.
//!
//! Three rules shape the commands:
//!
//!   * **A file path never crosses IPC from JavaScript.** `sound_pick_file`
//!     opens the native dialog from Rust and writes the picked path straight
//!     into the mount; `sound_bytes` reads only a path already in the config;
//!     the view a window receives carries each file's NAME, size and mtime,
//!     never its path. Every Tauri command is callable from every webview,
//!     including pages that render text written by strangers, so the set of
//!     files this app will read is decided here and nowhere else.
//!   * **WAV and MP3 only.** They are the two formats every webview engine
//!     decodes; `scripts/sound-convert.sh` turns a DAW's AIFF into both. The
//!     picker's filter, [`vet_file`] and the re-check in `sound_bytes` all
//!     share [`AUDIO_EXTS`].
//!   * **Writes are gated to the designer's windows** (`board`, the Terminal
//!     and its popped cards). The game window and the raid windows read and
//!     report; they never point a mount at a file.
//!
//! Every field is `#[serde(default)]` — a config that fails to parse is a
//! config that silently mutes the game (see `config_store::load_config`) —
//! and unknown keys survive a round trip, so a newer app's file is never
//! flattened by an older one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

use serde_json::{json, Value};

pub const FILENAME: &str = "sound.json";
/// The most this app will read for one file. Decoded PCM is ~8× a 16-bit
/// file's size per second, so memory is the practical ceiling long before this.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// The formats every webview decodes. Shared by the picker filter and the vet.
pub const AUDIO_EXTS: &[&str] = &["wav", "mp3"];
/// What a refused file says on its chip.
pub const FORMAT_REASON: &str = "wav or mp3 only";
/// The most trace records one call may carry; the engine batches at 200 ms.
const TRACE_CAP: usize = 64;

// ── Data ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SoundConfig {
    #[serde(default = "d_version")]
    pub version: u32,
    #[serde(default = "d_unit")]
    pub master_volume: f64,
    #[serde(default = "d_music")]
    pub music_volume: f64,
    #[serde(default = "d_unit")]
    pub sfx_volume: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub mounts: BTreeMap<String, Mount>,
    /// Keys this version does not know, kept so a newer file survives us.
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn d_version() -> u32 {
    1
}
fn d_unit() -> f64 {
    1.0
}
fn d_music() -> f64 {
    0.7
}

/// Hand-written: `load_config` falls back to `T::default()`, and a derived
/// `Default` would answer 0.0 volumes on first run — a mute app with no file
/// on disk saying so.
impl Default for SoundConfig {
    fn default() -> Self {
        Self {
            version: d_version(),
            master_volume: d_unit(),
            music_volume: d_music(),
            sfx_volume: d_unit(),
            muted: false,
            mounts: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

/// One mount point's settings. Every field but `files` is optional: absent
/// means "inherit the catalogue default", which is how a mount the designer
/// never touched keeps looping when the catalogue says it loops.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Mount {
    /// Absolute paths, in the order they were picked.
    #[serde(default)]
    pub files: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<Pick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u32>,
    #[serde(default, rename = "loop", skip_serializing_if = "Option::is_none")]
    pub looping: Option<bool>,
    /// 0 = until stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_count: Option<u32>,
    /// 0.0 ..= 2.0, multiplied by the bus and master gains.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// How a mount with several files chooses one: a random draw (no immediate
/// repeat) for variety, or in order for a playlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pick {
    Random,
    Sequence,
}

/// What a window learns about one file: enough to show a chip and to key a
/// decode cache, and never the path.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FileStat {
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

static CONFIG: LazyLock<RwLock<SoundConfig>> =
    LazyLock::new(|| RwLock::new(crate::mcp::config_store::load_config(FILENAME)));
/// Runtime only: the designer turns it on while its card is open.
static TRACE: AtomicBool = AtomicBool::new(false);

fn read() -> std::sync::RwLockReadGuard<'static, SoundConfig> {
    CONFIG.read().unwrap_or_else(|e| e.into_inner())
}
fn write() -> std::sync::RwLockWriteGuard<'static, SoundConfig> {
    CONFIG.write().unwrap_or_else(|e| e.into_inner())
}
fn save(c: &SoundConfig) {
    if cfg!(test) {
        return;
    }
    crate::mcp::config_store::save_config(FILENAME, c);
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/// A mount id that survives a JSON key and a DOM attribute: lowercase, dots,
/// digits, underscore, colon, dash; 1..=96 chars.
pub fn sane_mount_id(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b':' | b'-'));
    ok.then(|| id.to_string())
}

/// Case-insensitive extension check against [`AUDIO_EXTS`].
pub fn ext_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

fn file_name(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string()
}

/// Everything that has to be true before this app reads a file: absolute,
/// a regular file, an allowed format, and under `cap` bytes.
pub fn vet_file(path: &Path, cap: u64) -> Result<FileStat, String> {
    if !path.is_absolute() {
        return Err("not an absolute path".into());
    }
    if !ext_allowed(path) {
        return Err(FORMAT_REASON.into());
    }
    let meta = std::fs::metadata(path).map_err(|_| "missing".to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > cap {
        return Err(format!("too large ({} MB, cap {} MB)", meta.len() >> 20, cap >> 20));
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat { name: file_name(path), size: meta.len(), mtime_ms, ok: true, reason: None })
}

/// The chip for a stored path: never an error, the reason travels instead.
pub fn stat_or_reason(path: &Path) -> FileStat {
    match vet_file(path, MAX_BYTES) {
        Ok(s) => s,
        Err(reason) => FileStat { name: file_name(path), size: 0, mtime_ms: 0, ok: false, reason: Some(reason) },
    }
}

fn clamp_volume(v: f64) -> f64 {
    v.clamp(0.0, 2.0)
}

fn as_f64(v: &Value, key: &str) -> Result<f64, String> {
    v.as_f64().ok_or_else(|| format!("{key} must be a number"))
}

/// The global knobs: three volumes (clamped 0..=2) and mute. Nothing else.
pub fn config_set_impl(cfg: &mut SoundConfig, patch: &Value) -> Result<(), String> {
    let obj = patch.as_object().ok_or("patch must be an object")?;
    for (k, v) in obj {
        match k.as_str() {
            "master_volume" => cfg.master_volume = clamp_volume(as_f64(v, k)?),
            "music_volume" => cfg.music_volume = clamp_volume(as_f64(v, k)?),
            "sfx_volume" => cfg.sfx_volume = clamp_volume(as_f64(v, k)?),
            "muted" => cfg.muted = v.as_bool().ok_or("muted must be a boolean")?,
            other => return Err(format!("unknown config key '{other}'")),
        }
    }
    Ok(())
}

/// A partial update of one mount. `null` clears a field back to "inherit";
/// `files` is refused (paths come from the picker, never from a window).
pub fn mount_set_impl(cfg: &mut SoundConfig, id: &str, patch: &Value) -> Result<Mount, String> {
    let id = sane_mount_id(id).ok_or_else(|| format!("mount id {id:?} is not a plain id"))?;
    let obj = patch.as_object().ok_or("patch must be an object")?;
    let m = cfg.mounts.entry(id).or_default();
    for (k, v) in obj {
        match k.as_str() {
            "pick" => {
                m.pick = match v {
                    Value::Null => None,
                    Value::String(s) if s == "random" => Some(Pick::Random),
                    Value::String(s) if s == "sequence" => Some(Pick::Sequence),
                    _ => return Err("pick must be random, sequence or null".into()),
                }
            }
            "delay_ms" => {
                m.delay_ms = match v {
                    Value::Null => None,
                    _ => Some(as_f64(v, k)?.clamp(0.0, 60_000.0) as u32),
                }
            }
            "loop" => {
                m.looping = match v {
                    Value::Null => None,
                    _ => Some(v.as_bool().ok_or("loop must be a boolean")?),
                }
            }
            "loop_count" => {
                m.loop_count = match v {
                    Value::Null => None,
                    _ => Some(as_f64(v, k)?.clamp(0.0, 1000.0) as u32),
                }
            }
            "volume" => {
                m.volume = match v {
                    Value::Null => None,
                    _ => Some(clamp_volume(as_f64(v, k)?)),
                }
            }
            "enabled" => {
                m.enabled = match v {
                    Value::Null => None,
                    _ => Some(v.as_bool().ok_or("enabled must be a boolean")?),
                }
            }
            "remove_file" => {
                let i = as_f64(v, k)? as usize;
                if i >= m.files.len() {
                    return Err(format!("no file at index {i}"));
                }
                m.files.remove(i);
            }
            "clear_files" => {
                if v.as_bool() == Some(true) {
                    m.files.clear();
                }
            }
            "files" => return Err("files are set with sound_pick_file".into()),
            other => return Err(format!("unknown mount key '{other}'")),
        }
    }
    Ok(m.clone())
}

/// Store a vetted path on a mount: in place of file `replace`, or appended.
pub fn mount_add_file_impl(cfg: &mut SoundConfig, id: &str, path: PathBuf, replace: Option<usize>) -> Result<(), String> {
    let id = sane_mount_id(id).ok_or_else(|| format!("mount id {id:?} is not a plain id"))?;
    let m = cfg.mounts.entry(id).or_default();
    match replace {
        Some(i) if i < m.files.len() => m.files[i] = path,
        Some(i) => return Err(format!("no file at index {i}")),
        None => m.files.push(path),
    }
    Ok(())
}

/// The one way a path leaves the store: by mount id and index.
pub fn bytes_path_impl(cfg: &SoundConfig, id: &str, index: usize) -> Result<PathBuf, String> {
    let m = cfg.mounts.get(id).ok_or_else(|| format!("no mount {id:?}"))?;
    m.files.get(index).cloned().ok_or_else(|| format!("no file at index {index} on {id}"))
}

/// The JS-facing shape: what `sound_config_get` answers and what
/// `sound-config` carries. Files become chips, not paths.
pub fn view(cfg: &SoundConfig) -> Value {
    let mounts: serde_json::Map<String, Value> = cfg
        .mounts
        .iter()
        .map(|(id, m)| {
            let mut o = serde_json::Map::new();
            o.insert("files".into(), json!(m.files.iter().map(|p| stat_or_reason(p)).collect::<Vec<_>>()));
            if let Some(p) = m.pick {
                o.insert("pick".into(), json!(p));
            }
            if let Some(v) = m.delay_ms {
                o.insert("delay_ms".into(), json!(v));
            }
            if let Some(v) = m.looping {
                o.insert("loop".into(), json!(v));
            }
            if let Some(v) = m.loop_count {
                o.insert("loop_count".into(), json!(v));
            }
            if let Some(v) = m.volume {
                o.insert("volume".into(), json!(v));
            }
            if let Some(v) = m.enabled {
                o.insert("enabled".into(), json!(v));
            }
            (id.clone(), Value::Object(o))
        })
        .collect();
    json!({
        "version": cfg.version,
        "master_volume": cfg.master_volume,
        "music_volume": cfg.music_volume,
        "sfx_volume": cfg.sfx_volume,
        "muted": cfg.muted,
        "trace": TRACE.load(Ordering::Relaxed),
        "mounts": Value::Object(mounts),
    })
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The designer's windows: Team Ops and the Terminal (with its popped cards).
const WRITERS: &[&str] = &["board", "terminal"];

fn announce(app: &tauri::AppHandle) {
    let v = view(&read());
    let _ = crate::mcp::events::emit(app, crate::mcp::events::AppEvent::Sound { name: "sound-config", payload: v });
}

/// The whole config, as chips. Any window may ask.
#[tauri::command]
pub fn sound_config_get() -> Value {
    view(&read())
}

/// Master / music / sfx volume and mute.
#[tauri::command]
pub fn sound_config_set(window: tauri::WebviewWindow, app: tauri::AppHandle, patch: Value) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    {
        let mut c = write();
        config_set_impl(&mut c, &patch)?;
        save(&c);
    }
    announce(&app);
    Ok(sound_config_get())
}

/// One mount's settings (never its files — see `sound_pick_file`).
#[tauri::command]
pub fn sound_mount_set(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, patch: Value) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    {
        let mut c = write();
        mount_set_impl(&mut c, &id, &patch)?;
        save(&c);
    }
    announce(&app);
    Ok(sound_config_get())
}

/// Forget a mount entirely (its files and every setting).
#[tauri::command]
pub fn sound_mount_delete(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    {
        let mut c = write();
        c.mounts.remove(&id);
        save(&c);
    }
    announce(&app);
    Ok(sound_config_get())
}

/// Open the native picker (WAV/MP3 only) and store what the player chooses on
/// mount `id`: appended, or in place of file `replace`.
///
/// `async` is load-bearing: a synchronous command runs on the main thread,
/// and a picker awaited there deadlocks the app. The dialog plugin does the
/// macOS main-thread hop itself; we wait on a oneshot.
#[tauri::command]
pub async fn sound_pick_file(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    replace: Option<usize>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    sane_mount_id(&id).ok_or_else(|| format!("mount id {id:?} is not a plain id"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a sound (WAV or MP3)")
        .add_filter("Audio", AUDIO_EXTS)
        .set_parent(&window)
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(picked) = rx.await.map_err(|_| "dialog closed".to_string())? else {
        return Ok(json!({ "cancelled": true }));
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let stat = vet_file(&path, MAX_BYTES)?;
    {
        let mut c = write();
        mount_add_file_impl(&mut c, &id, path, replace)?;
        save(&c);
    }
    announce(&app);
    Ok(json!({ "ok": true, "id": id, "file": stat }))
}

/// The bytes of file `index` on mount `id`, for `decodeAudioData`. Only a
/// path already in the config is ever read, and it is vetted again here (the
/// file may have changed since it was picked). Any window may ask.
#[tauri::command]
pub async fn sound_bytes(id: String, index: usize) -> Result<tauri::ipc::Response, String> {
    let path = bytes_path_impl(&read(), &id, index)?;
    vet_file(&path, MAX_BYTES)?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read failed: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Cues fired in `window`, relayed to every window while the designer is
/// tracing. A no-op otherwise, so the game pays nothing when nobody is looking.
#[tauri::command]
pub fn sound_trace(window: tauri::WebviewWindow, app: tauri::AppHandle, cues: Vec<Value>) {
    if !TRACE.load(Ordering::Relaxed) || cues.is_empty() {
        return;
    }
    let cues: Vec<Value> = cues.into_iter().take(TRACE_CAP).collect();
    let _ = crate::mcp::events::emit(
        &app,
        crate::mcp::events::AppEvent::Sound {
            name: "sound-trace",
            payload: json!({ "window": window.label(), "cues": cues }),
        },
    );
}

/// The designer's tape switch. Announced as part of the config so every
/// engine learns whether to send traces.
#[tauri::command]
pub fn sound_trace_set(window: tauri::WebviewWindow, app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    TRACE.store(enabled, Ordering::Relaxed);
    announce(&app);
    Ok(sound_config_get())
}

/// Show `sound.json` in the file manager, for a designer who wants to copy or
/// share a mapping by hand (the file holds the absolute paths).
#[tauri::command]
pub fn sound_reveal_config(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    let path = crate::mcp::config_store::config_path(FILENAME).ok_or("no config dir")?;
    if !path.exists() {
        save(&read());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

// ── Export / import: the mapping travels as one zip ─────────────────────────
//
// `sound.json` inside the zip is the config with every file rewritten to
// `files/<nnn>-<name>`, and those entries carry the bytes. Import extracts the
// files into `<config_dir>/structs-app/sounds/<stamp>/` (file NAMES only —
// never a path from the archive), then each mount in the zip replaces the
// mount of the same id here: its files and its settings. Mounts the zip does
// not mention, and the local volumes, are left alone.

/// How many entries an archive may carry before it is refused.
const IMPORT_MAX_ENTRIES: usize = 600;

/// The manifest and the (zip name, source path) pairs an export writes.
/// Files that fail the vet are skipped rather than failing the whole export.
pub fn export_plan(cfg: &SoundConfig) -> (Value, Vec<(String, PathBuf)>) {
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    let mut mounts = serde_json::Map::new();
    let mut n = 0usize;
    for (id, m) in &cfg.mounts {
        let mut names = Vec::new();
        for p in &m.files {
            if vet_file(p, MAX_BYTES).is_err() {
                continue;
            }
            n += 1;
            let name = format!("files/{n:03}-{}", file_name(p));
            names.push(name.clone());
            entries.push((name, p.clone()));
        }
        let mut o = serde_json::to_value(m).unwrap_or_else(|_| json!({}));
        o["files"] = json!(names);
        mounts.insert(id.clone(), o);
    }
    let manifest = json!({
        "format": "structs-sounds",
        "version": 1,
        "master_volume": cfg.master_volume,
        "music_volume": cfg.music_volume,
        "sfx_volume": cfg.sfx_volume,
        "muted": cfg.muted,
        "mounts": Value::Object(mounts),
    });
    (manifest, entries)
}

/// Apply an imported manifest: every mount it names replaces ours, its zip
/// file names resolved through `extracted` (zip name → local path). Answers
/// (mounts replaced, files attached).
pub fn import_apply(cfg: &mut SoundConfig, manifest: &Value, extracted: &BTreeMap<String, PathBuf>) -> Result<(usize, usize), String> {
    if manifest.get("format").and_then(|v| v.as_str()) != Some("structs-sounds") {
        return Err("not a Structs sounds zip (no format tag in sound.json)".into());
    }
    let mounts = manifest.get("mounts").and_then(|v| v.as_object()).ok_or("sound.json has no mounts")?;
    let mut nm = 0usize;
    let mut nf = 0usize;
    for (id, v) in mounts {
        let id = sane_mount_id(id).ok_or_else(|| format!("mount id {id:?} is not a plain id"))?;
        let mut m: Mount = serde_json::from_value(v.clone()).map_err(|e| format!("mount {id}: {e}"))?;
        let names: Vec<String> = v
            .get("files")
            .and_then(|f| f.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        m.files = names.iter().filter_map(|n| extracted.get(n).cloned()).collect();
        nf += m.files.len();
        cfg.mounts.insert(id, m);
        nm += 1;
    }
    Ok((nm, nf))
}

fn write_zip(path: &Path, manifest: &Value, entries: &[(String, PathBuf)]) -> Result<(), String> {
    use std::io::Write;
    let file = std::fs::File::create(path).map_err(|e| format!("create {}: {e}", file_name(path)))?;
    let mut z = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    z.start_file("sound.json", opts).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    z.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    // Audio is already compressed (mp3) or big (wav); store it as is.
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, src) in entries {
        let bytes = std::fs::read(src).map_err(|e| format!("read {}: {e}", file_name(src)))?;
        z.start_file(name, stored).map_err(|e| e.to_string())?;
        z.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    z.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a sounds zip: its manifest, and its audio extracted into `into` by
/// file NAME (an archive path is never trusted), vetted by extension and size.
fn read_zip(path: &Path, into: &Path) -> Result<(Value, BTreeMap<String, PathBuf>), String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", file_name(path)))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a zip: {e}"))?;
    if archive.len() > IMPORT_MAX_ENTRIES {
        return Err(format!("zip has {} entries (cap {IMPORT_MAX_ENTRIES})", archive.len()));
    }
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut manifest: Option<Value> = None;
    let mut extracted = BTreeMap::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name == "sound.json" {
            let mut text = String::new();
            f.read_to_string(&mut text).map_err(|e| e.to_string())?;
            manifest = Some(serde_json::from_str(&text).map_err(|e| format!("sound.json: {e}"))?);
            continue;
        }
        if f.is_dir() || !name.starts_with("files/") || f.size() > MAX_BYTES {
            continue;
        }
        let Some(rel) = f.enclosed_name() else { continue };
        let Some(base) = rel.file_name().and_then(|b| b.to_str()).map(String::from) else { continue };
        let dest = into.join(&base);
        if !ext_allowed(&dest) {
            continue;
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        extracted.insert(name, dest);
    }
    let manifest = manifest.ok_or("no sound.json in the zip")?;
    Ok((manifest, extracted))
}

/// Save the whole mapping as one zip, where the player chooses.
#[tauri::command]
pub async fn sound_export(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    let (manifest, entries) = export_plan(&read());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export sounds")
        .add_filter("Zip", &["zip"])
        .set_file_name("structs-sounds.zip")
        .set_parent(&window)
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(picked) = rx.await.map_err(|_| "dialog closed".to_string())? else {
        return Ok(json!({ "cancelled": true }));
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let n = entries.len();
    let nm = manifest["mounts"].as_object().map(|m| m.len()).unwrap_or(0);
    let name = file_name(&path);
    tokio::task::spawn_blocking(move || write_zip(&path, &manifest, &entries))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({ "ok": true, "files": n, "mounts": nm, "name": name }))
}

/// Load a sounds zip: its files land under the app's config dir and every
/// mount it names replaces ours.
#[tauri::command]
pub async fn sound_import(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::mcp::tools::board_pages::require_window(&window, WRITERS)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import sounds")
        .add_filter("Zip", &["zip"])
        .set_parent(&window)
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(picked) = rx.await.map_err(|_| "dialog closed".to_string())? else {
        return Ok(json!({ "cancelled": true }));
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let stamp = crate::hasher::types::now_millis() as u64;
    let into = crate::mcp::config_store::config_path("sounds").ok_or("no config dir")?.join(stamp.to_string());
    let (manifest, extracted) = tokio::task::spawn_blocking(move || read_zip(&path, &into))
        .await
        .map_err(|e| e.to_string())??;
    let (nm, nf) = {
        let mut c = write();
        let r = import_apply(&mut c, &manifest, &extracted)?;
        save(&c);
        r
    };
    announce(&app);
    Ok(json!({ "ok": true, "mounts": nm, "files": nf }))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_and_an_unknown_field_both_parse_to_a_usable_config() {
        let c: SoundConfig = serde_json::from_str("{}").unwrap();
        assert_eq!((c.master_volume, c.music_volume, c.sfx_volume, c.muted), (1.0, 0.7, 1.0, false));
        assert_eq!(c, SoundConfig::default(), "the hand-written Default matches the serde defaults");

        let raw = r#"{"future_knob":1,"mounts":{"x.y":{"files":[],"colour":"red"}}}"#;
        let c: SoundConfig = serde_json::from_str(raw).unwrap();
        let back: SoundConfig = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.extra["future_knob"], json!(1));
        assert_eq!(back.mounts["x.y"].extra["colour"], json!("red"));
    }

    #[test]
    fn a_missing_mount_field_stays_absent_so_the_catalogue_default_wins() {
        let m = Mount::default();
        let s = serde_json::to_string(&m).unwrap();
        assert!(!s.contains("loop"), "{s}");
        let m: Mount = serde_json::from_str(r#"{"loop":false}"#).unwrap();
        assert_eq!(m.looping, Some(false));
        let m: Mount = serde_json::from_str(r#"{"pick":"sequence"}"#).unwrap();
        assert_eq!(m.pick, Some(Pick::Sequence));
    }

    #[test]
    fn only_wav_and_mp3_pass() {
        for ok in ["/a/b.WAV", "/a/b.wav", "/a/b.mp3", "/a/b.Mp3"] {
            assert!(ext_allowed(Path::new(ok)), "{ok}");
        }
        for bad in ["/a/b.aif", "/a/b.aiff", "/a/b.m4a", "/a/b.wav.sh", "/a/b", "/a/b.json"] {
            assert!(!ext_allowed(Path::new(bad)), "{bad}");
        }
        assert_eq!(vet_file(Path::new("/a/b.aif"), MAX_BYTES).unwrap_err(), FORMAT_REASON);
        assert_eq!(vet_file(Path::new("relative.wav"), MAX_BYTES).unwrap_err(), "not an absolute path");
    }

    fn temp_wav(name: &str, bytes: usize) -> PathBuf {
        let p = crate::mcp::config_store::config_path(name).unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![0u8; bytes]).unwrap();
        p
    }

    #[test]
    fn a_file_over_the_cap_is_refused_before_it_is_read() {
        let p = temp_wav("cap-test.wav", 32);
        assert!(vet_file(&p, 16).unwrap_err().starts_with("too large"));
        let s = vet_file(&p, 64).unwrap();
        assert_eq!((s.size, s.ok, s.name.as_str()), (32, true, "cap-test.wav"));
        assert!(s.mtime_ms > 0);
        let missing = stat_or_reason(Path::new("/nowhere/x.wav"));
        assert_eq!((missing.ok, missing.reason.as_deref()), (false, Some("missing")));
    }

    #[test]
    fn a_partial_mount_update_touches_only_what_it_names() {
        let mut c = SoundConfig::default();
        mount_set_impl(&mut c, "ui.press", &json!({ "delay_ms": 120 })).unwrap();
        mount_set_impl(&mut c, "ui.press", &json!({ "loop": true })).unwrap();
        let m = &c.mounts["ui.press"];
        assert_eq!((m.delay_ms, m.looping, m.volume), (Some(120), Some(true), None));

        let m = mount_set_impl(&mut c, "ui.press", &json!({ "volume": 9 })).unwrap();
        assert_eq!(m.volume, Some(2.0), "clamped");
        let m = mount_set_impl(&mut c, "ui.press", &json!({ "delay_ms": null })).unwrap();
        assert_eq!(m.delay_ms, None, "null clears back to inherit");

        assert!(mount_set_impl(&mut c, "ui.press", &json!({ "files": ["/x.wav"] })).unwrap_err().contains("sound_pick_file"));
        assert!(mount_set_impl(&mut c, "ui.press", &json!({ "remove_file": 3 })).is_err());
        assert!(mount_set_impl(&mut c, "ui.press", &json!({ "colour": "red" })).is_err());
        assert!(mount_set_impl(&mut c, "Bad Id", &json!({})).is_err());
        assert!(mount_set_impl(&mut c, "ui.press", &json!({ "pick": "shuffle" })).is_err());
    }

    #[test]
    fn pick_replaces_in_place_or_appends_and_bytes_come_only_from_the_store() {
        let mut c = SoundConfig::default();
        mount_add_file_impl(&mut c, "music.ambient", PathBuf::from("/a/one.mp3"), None).unwrap();
        mount_add_file_impl(&mut c, "music.ambient", PathBuf::from("/a/two.mp3"), None).unwrap();
        mount_add_file_impl(&mut c, "music.ambient", PathBuf::from("/a/three.mp3"), Some(0)).unwrap();
        assert_eq!(c.mounts["music.ambient"].files, vec![PathBuf::from("/a/three.mp3"), PathBuf::from("/a/two.mp3")]);
        assert!(mount_add_file_impl(&mut c, "music.ambient", PathBuf::from("/a/x.mp3"), Some(5)).is_err());

        assert_eq!(bytes_path_impl(&c, "music.ambient", 1).unwrap(), PathBuf::from("/a/two.mp3"));
        assert!(bytes_path_impl(&c, "music.ambient", 2).is_err());
        assert!(bytes_path_impl(&c, "nope", 0).is_err());

        mount_set_impl(&mut c, "music.ambient", &json!({ "remove_file": 0 })).unwrap();
        assert_eq!(c.mounts["music.ambient"].files.len(), 1);
        mount_set_impl(&mut c, "music.ambient", &json!({ "clear_files": true })).unwrap();
        assert!(c.mounts["music.ambient"].files.is_empty());
    }

    #[test]
    fn mount_ids_are_plain() {
        assert!(sane_mount_id("weapon.impact.cannon").is_some());
        assert!(sane_mount_id("fleet.battleship:primary").is_some());
        assert!(sane_mount_id("../x").is_none());
        assert!(sane_mount_id("Weapon").is_none());
        assert!(sane_mount_id("").is_none());
        assert!(sane_mount_id(&"a".repeat(97)).is_none());
    }

    #[test]
    fn the_view_never_carries_a_path() {
        let mut c = SoundConfig::default();
        let p = temp_wav("view-test.wav", 8);
        mount_add_file_impl(&mut c, "ui.press", p, None).unwrap();
        mount_add_file_impl(&mut c, "ui.press", PathBuf::from("/nowhere/lost.mp3"), None).unwrap();
        mount_set_impl(&mut c, "ui.press", &json!({ "volume": 0.5 })).unwrap();
        let v = view(&c);
        let files = v["mounts"]["ui.press"]["files"].as_array().unwrap();
        assert_eq!(files[0]["name"], "view-test.wav");
        assert_eq!(files[0]["ok"], true);
        assert_eq!(files[1]["ok"], false);
        assert_eq!(files[1]["reason"], "missing");
        for f in files {
            for (_, val) in f.as_object().unwrap() {
                if let Some(s) = val.as_str() {
                    assert!(!s.contains('/'), "a path leaked: {s}");
                }
            }
        }
        assert_eq!(v["mounts"]["ui.press"]["volume"], 0.5);
        assert!(v["mounts"]["ui.press"].get("loop").is_none(), "absent stays absent");
        assert_eq!(v["music_volume"], 0.7);
        assert_eq!(v["trace"], false);
    }

    #[test]
    fn an_export_names_every_vetted_file_and_an_import_puts_it_back() {
        let mut c = SoundConfig::default();
        let a = temp_wav("export-a.wav", 8);
        let b = temp_wav("export-b.mp3", 8);
        mount_add_file_impl(&mut c, "ui.press", a.clone(), None).unwrap();
        mount_add_file_impl(&mut c, "ui.press", PathBuf::from("/nowhere/lost.wav"), None).unwrap();
        mount_add_file_impl(&mut c, "music.ambient", b.clone(), None).unwrap();
        mount_set_impl(&mut c, "music.ambient", &json!({ "loop": true, "volume": 0.5 })).unwrap();
        let (manifest, entries) = export_plan(&c);
        assert_eq!(manifest["format"], "structs-sounds");
        assert_eq!(entries.len(), 2, "the missing file is skipped");
        // Mounts are a BTreeMap: music.ambient is numbered before ui.press.
        assert_eq!(manifest["mounts"]["music.ambient"]["files"], json!(["files/001-export-b.mp3"]));
        assert_eq!(manifest["mounts"]["ui.press"]["files"], json!(["files/002-export-a.wav"]));
        assert_eq!(manifest["mounts"]["music.ambient"]["loop"], true);
        assert!(manifest["mounts"]["ui.press"].get("loop").is_none(), "absent settings stay absent");

        // Round trip through a real zip into a temp dir.
        let zip_path = crate::mcp::config_store::config_path("export-test.zip").unwrap();
        write_zip(&zip_path, &manifest, &entries).unwrap();
        let into = crate::mcp::config_store::config_path("import-test-dir").unwrap();
        let (back, extracted) = read_zip(&zip_path, &into).unwrap();
        assert_eq!(extracted.len(), 2);
        assert!(extracted["files/002-export-a.wav"].starts_with(&into));

        let mut d = SoundConfig::default();
        mount_add_file_impl(&mut d, "ui.denied", PathBuf::from("/keep/me.wav"), None).unwrap();
        let (nm, nf) = import_apply(&mut d, &back, &extracted).unwrap();
        assert_eq!((nm, nf), (2, 2));
        assert_eq!(d.mounts["music.ambient"].looping, Some(true));
        assert_eq!(d.mounts["music.ambient"].volume, Some(0.5));
        assert_eq!(d.mounts["music.ambient"].files, vec![extracted["files/001-export-b.mp3"].clone()]);
        assert_eq!(d.mounts["ui.denied"].files, vec![PathBuf::from("/keep/me.wav")], "a mount the zip does not name is untouched");
        let _ = std::fs::remove_dir_all(&into);
        let _ = std::fs::remove_file(&zip_path);
    }

    #[test]
    fn an_import_refuses_what_is_not_a_sounds_zip() {
        let mut c = SoundConfig::default();
        assert!(import_apply(&mut c, &json!({ "mounts": {} }), &BTreeMap::new()).is_err(), "no format tag");
        assert!(import_apply(&mut c, &json!({ "format": "structs-sounds" }), &BTreeMap::new()).is_err(), "no mounts");
        assert!(import_apply(&mut c, &json!({ "format": "structs-sounds", "mounts": { "Bad Id": {} } }), &BTreeMap::new()).is_err());
        let ok = import_apply(&mut c, &json!({ "format": "structs-sounds", "mounts": { "ui.press": { "files": ["files/001-x.wav"], "delay_ms": 20 } } }), &BTreeMap::new()).unwrap();
        assert_eq!(ok, (1, 0), "a file the zip did not carry is simply not attached");
        assert_eq!(c.mounts["ui.press"].delay_ms, Some(20));
    }

    #[test]
    fn the_global_knobs_clamp_and_refuse_strangers() {
        let mut c = SoundConfig::default();
        config_set_impl(&mut c, &json!({ "master_volume": 5, "muted": true })).unwrap();
        assert_eq!((c.master_volume, c.muted), (2.0, true));
        assert!(config_set_impl(&mut c, &json!({ "mounts": {} })).is_err());
        assert!(config_set_impl(&mut c, &json!({ "muted": "yes" })).is_err());
    }
}
