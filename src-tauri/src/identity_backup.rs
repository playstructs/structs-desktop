//! Account key files.
//!
//! The webapp's signup shows the player their 12-word mnemonic and makes them
//! type it back. The desktop app skips those screens (frontend/identity-backup.js)
//! and writes the words here instead, BEFORE the account is created — an
//! account must never exist whose key was saved nowhere but the webview's
//! localStorage.
//!
//! Two destinations, one format:
//!   * `backup`   — `<data_dir>/structs-app/identities/`, written at signup
//!   * `download` — the Downloads folder, from the Debug panel's button, then
//!                  revealed like the log bundle
//!
//! Every file is new: the name carries the UTC time, a collision gets `-2`,
//! `-3`…, and nothing is ever overwritten. On unix the file is 0600 and the
//! identities folder 0700.
//!
//! Only the game window (`main`) may call this. That window renders content
//! other players wrote, so the command takes nothing but a strictly validated
//! mnemonic and a few short labels — it cannot be used to write arbitrary text.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const FILE_PREFIX: &str = "structs-identity";

#[tauri::command]
pub fn save_identity_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    mnemonic: String,
    dest: String,
    username: Option<String>,
    guild_id: Option<String>,
    player_id: Option<String>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("only the game window may save the account key".into());
    }
    let words = normalize_mnemonic(&mnemonic)?;
    let download = match dest.as_str() {
        "backup" => false,
        "download" => true,
        other => return Err(format!("unknown destination '{other}'")),
    };

    let dir = if download {
        dirs::download_dir().or_else(dirs::home_dir).ok_or("no Downloads directory")?
    } else {
        identities_dir().ok_or("no data directory")?
    };

    let now = chrono::Utc::now();
    let body = render(
        &words,
        &now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        &[
            ("username", username.as_deref()),
            ("guild", guild_id.as_deref()),
            ("player", player_id.as_deref()),
        ],
    );
    let stamp = now.format("%Y-%m-%dT%H-%M-%SZ").to_string();
    let path = write_new(&dir, &stamp, &body)?;

    crate::mcp::telemetry::tlog(
        "identity",
        crate::mcp::telemetry::Sev::Notice,
        format!("saved account key file {}", path.display()),
    );
    if download {
        if let Some(parent) = path.parent() {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_path(parent.to_string_lossy(), None::<&str>);
        }
    }
    Ok(json!({ "path": path.to_string_lossy() }))
}

fn identities_dir() -> Option<PathBuf> {
    let dir = dirs::data_dir()?.join("structs-app").join("identities");
    fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

/// Collapse whitespace and check the shape of a BIP-39 English mnemonic:
/// 12–24 words (a multiple of three), each 3–8 lowercase ASCII letters.
/// The error never echoes the input.
fn normalize_mnemonic(raw: &str) -> Result<String, String> {
    let words: Vec<&str> = raw.split_whitespace().collect();
    let n = words.len();
    if !(12..=24).contains(&n) || n % 3 != 0 {
        return Err(format!("expected 12–24 words, got {n}"));
    }
    let ok = words
        .iter()
        .all(|w| (3..=8).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_lowercase()));
    if !ok {
        return Err("mnemonic contains a word that is not a recovery-key word".into());
    }
    Ok(words.join(" "))
}

/// A label goes on one line of the file: no control characters, bounded length.
fn clean_label(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(64).collect::<String>().trim().to_string()
}

fn render(words: &str, created: &str, labels: &[(&str, Option<&str>)]) -> String {
    let mut out = format!(
        "{words}\n\nStructs account key. Anyone with these words controls this account.\ncreated: {created}\n"
    );
    for (key, val) in labels {
        if let Some(v) = val.map(clean_label).filter(|v| !v.is_empty()) {
            out.push_str(&format!("{key}: {v}\n"));
        }
    }
    out
}

/// Create `<prefix>-<stamp>.txt` (or `-2`, `-3`… if taken) and write `body`.
/// `create_new` makes the no-overwrite rule atomic rather than a race.
fn write_new(dir: &Path, stamp: &str, body: &str) -> Result<PathBuf, String> {
    for n in 1..=100u32 {
        let name = if n == 1 {
            format!("{FILE_PREFIX}-{stamp}.txt")
        } else {
            format!("{FILE_PREFIX}-{stamp}-{n}.txt")
        };
        let path = dir.join(name);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = match opts.open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not create {}: {e}", path.display())),
        };
        if let Err(e) = file.write_all(body.as_bytes()).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("could not write {}: {e}", path.display()));
        }
        return Ok(path);
    }
    Err("too many account key files with the same timestamp".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWELVE: &str = "apple mask lens scout acid exclude evolve double build theme tone enlist";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("structs-identity-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mnemonic_is_normalized() {
        let messy = format!("  {}  ", TWELVE.replace(' ', "   \n"));
        assert_eq!(normalize_mnemonic(&messy).unwrap(), TWELVE);
    }

    #[test]
    fn mnemonic_rejects_wrong_shapes_without_echoing() {
        assert!(normalize_mnemonic("apple mask lens").is_err());
        let thirteen = format!("{TWELVE} apple");
        assert!(normalize_mnemonic(&thirteen).is_err());
        let upper = TWELVE.replace("apple", "Apple");
        assert!(normalize_mnemonic(&upper).is_err());
        let injected = TWELVE.replace("apple", "<script>");
        let err = normalize_mnemonic(&injected).unwrap_err();
        assert!(!err.contains("script") && !err.contains("mask"));
    }

    #[test]
    fn render_puts_words_first_and_strips_control_chars() {
        let body = render(TWELVE, "2026-09-29T14:05:33Z", &[
            ("username", Some("Ace\nplayer: 1-1")),
            ("guild", None),
            ("player", Some("  ")),
        ]);
        assert_eq!(body.lines().next(), Some(TWELVE));
        assert!(body.contains("created: 2026-09-29T14:05:33Z\n"));
        assert!(body.contains("username: Aceplayer: 1-1\n"));
        assert!(!body.contains("guild:") && !body.contains("player: \n"));
    }

    #[test]
    fn files_are_timestamped_and_never_overwritten() {
        let dir = scratch("nooverwrite");
        let a = write_new(&dir, "2026-09-29T14-05-33Z", "one").unwrap();
        let b = write_new(&dir, "2026-09-29T14-05-33Z", "two").unwrap();
        assert_eq!(a.file_name().unwrap(), "structs-identity-2026-09-29T14-05-33Z.txt");
        assert_eq!(b.file_name().unwrap(), "structs-identity-2026-09-29T14-05-33Z-2.txt");
        assert_eq!(fs::read_to_string(&a).unwrap(), "one");
        assert_eq!(fs::read_to_string(&b).unwrap(), "two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamp_has_no_colons() {
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ").to_string();
        assert!(!stamp.contains(':') && stamp.ends_with('Z') && stamp.len() == 20);
    }
}
