//! Persisted Matrix sessions.
//!
//! One entry per guild. Holds the homeserver access token, so the file is
//! written 0600 and lives beside the other app state rather than anywhere the
//! log bundle sweeps up (see `log_bundle.rs`, which must never include it).
//!
//! A token here is NOT the wallet. It is a homeserver credential minted by
//! MAS off a one-time OIDC exchange; revoking it costs the player nothing but
//! a reconnect, which is why losing this file is a non-event.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub guild_id: String,
    /// Homeserver base URL, no trailing slash (e.g. `https://matrix.crew.oh.energy`).
    pub homeserver: String,
    /// `@1-42:matrix.crew.oh.energy` — localpart is the player id, never the
    /// wallet address (addresses rotate on chain; player ids do not).
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds. `None` for a token the issuer declared no lifetime for.
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// The dynamically-registered OAuth client, reused across reconnects so we
    /// do not litter MAS with a new client per sign-in.
    pub client_id: String,
    pub token_endpoint: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    sessions: BTreeMap<String, Session>,
    /// Registered OAuth client per homeserver, kept even when the session is
    /// signed out — re-registering on every connect is pure noise for MAS.
    #[serde(default)]
    clients: BTreeMap<String, String>,
}

const VERSION: u32 = 1;

static CACHE: RwLock<Option<StoreFile>> = RwLock::new(None);

fn path() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("structs-app");
    let _ = fs::create_dir_all(&dir);
    dir.join("matrix_sessions.json")
}

fn load() -> StoreFile {
    if let Ok(guard) = CACHE.read() {
        if let Some(f) = guard.as_ref() {
            return f.clone_shallow();
        }
    }
    let file = fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice::<StoreFile>(&b).ok())
        .unwrap_or_default();
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(file.clone_shallow());
    }
    file
}

impl StoreFile {
    // Deriving Clone would also make it trivially easy to pass whole token
    // sets around; this stays private and explicit instead.
    fn clone_shallow(&self) -> StoreFile {
        StoreFile {
            version: self.version,
            sessions: self.sessions.clone(),
            clients: self.clients.clone(),
        }
    }
}

fn save(file: &StoreFile) {
    let Ok(body) = serde_json::to_vec_pretty(file) else {
        return;
    };
    let p = path();
    if fs::write(&p, body).is_err() {
        return;
    }
    // Owner-only. Best effort: a filesystem without unix permissions (or a
    // Windows host) simply skips this, and the token is no more exposed there
    // than the rest of the app's state directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(file.clone_shallow());
    }
}

pub fn get(guild_id: &str) -> Option<Session> {
    load().sessions.get(guild_id).cloned()
}

pub fn all() -> Vec<Session> {
    load().sessions.values().cloned().collect()
}

pub fn put(session: Session) {
    let mut file = load();
    file.version = VERSION;
    file.clients
        .insert(session.homeserver.clone(), session.client_id.clone());
    file.sessions.insert(session.guild_id.clone(), session);
    save(&file);
}

pub fn remove(guild_id: &str) {
    let mut file = load();
    if file.sessions.remove(guild_id).is_some() {
        file.version = VERSION;
        save(&file);
    }
}

/// A previously registered OAuth client for this homeserver, if any.
pub fn client_for(homeserver: &str) -> Option<String> {
    load().clients.get(homeserver).cloned()
}

pub fn put_client(homeserver: &str, client_id: &str) {
    let mut file = load();
    file.version = VERSION;
    file.clients
        .insert(homeserver.to_string(), client_id.to_string());
    save(&file);
}
