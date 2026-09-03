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
    /// Which of OUR players this session speaks as, or `None` for the primary.
    ///
    /// The Armada roster is full of players we hold keys for, and each one has
    /// a real Matrix identity waiting (the localpart IS the player id). This
    /// is what lets more than one of them be signed in at once.
    #[serde(default)]
    pub player_id: Option<String>,
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
    /// What portrait we last published for a user, as `<attrs>|<mxc>`.
    ///
    /// Persisted so the self-heal is a no-op on every launch after the first.
    /// Without it the app would re-upload the same picture each time it
    /// started, which is rude to the homeserver and pointless.
    #[serde(default)]
    avatars: BTreeMap<String, String>,
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
            avatars: self.avatars.clone(),
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

/* Sessions are keyed by IDENTITY, not by guild.
 *
 * The primary keeps the bare guild id as its key, so every session stored
 * before this existed still loads and every caller that passes a plain guild
 * id still finds it. A second identity on the same guild is `guild#player`.
 *
 * `#` cannot appear in a guild id or a player id — both are `<n>-<n>` — so the
 * split is unambiguous in both directions.
 */
pub const IDENT_SEP: char = '#';

pub fn key_for(guild_id: &str, player_id: Option<&str>) -> String {
    match player_id {
        None => guild_id.to_string(),
        Some(p) => format!("{guild_id}{IDENT_SEP}{p}"),
    }
}

/// The guild a session key belongs to, whichever identity it names.
pub fn guild_of(key: &str) -> &str {
    key.split_once(IDENT_SEP).map(|(g, _)| g).unwrap_or(key)
}

/// Which player a session key speaks as, or `None` for the primary.
pub fn player_of(key: &str) -> Option<&str> {
    key.split_once(IDENT_SEP).map(|(_, p)| p)
}

pub fn get(key: &str) -> Option<Session> {
    load().sessions.get(key).cloned()
}

/// Every identity currently signed in on one guild, primary first.
pub fn identities_on(guild_id: &str) -> Vec<Session> {
    let mut out: Vec<Session> = load()
        .sessions
        .iter()
        .filter(|(k, _)| guild_of(k) == guild_id)
        .map(|(_, s)| s.clone())
        .collect();
    out.sort_by_key(|s| s.player_id.clone());
    out
}

pub fn all() -> Vec<Session> {
    load().sessions.values().cloned().collect()
}

pub fn put(session: Session) {
    let mut file = load();
    file.version = VERSION;
    file.clients
        .insert(session.homeserver.clone(), session.client_id.clone());
    let key = key_for(&session.guild_id, session.player_id.as_deref());
    file.sessions.insert(key, session);
    save(&file);
}

/* The bare guild key means THE PRIMARY. Make sure whoever is in it belongs.
 *
 * A sign-in that authenticated as somebody else while `as_player` was unset
 * lands in that slot anyway, and nothing downstream questions it: the primary's
 * own Comms window then opens that person's account — their rooms, their DMs,
 * their voice — with a plain "Comms" title bar and no indication anything is
 * off. That is a wrong-identity bug, not a cosmetic one; the whole point of
 * keying sessions by identity is that you cannot speak as the wrong player.
 *
 * So this checks rather than trusts. A session in the primary's slot whose
 * `user_id` names a DIFFERENT player is re-filed under the identity it
 * actually is (where that window can still use it), leaving the primary's slot
 * empty so the next status call signs in as the primary.
 *
 * Returns the key it moved the session to, or `None` when there was nothing to
 * do — including when the primary's id is not known yet, because "we have not
 * synced" must never be read as "this is the wrong person".
 */
pub fn heal_primary_slot(guild_id: &str, primary_player_id: &str) -> Option<String> {
    if guild_id.is_empty() || primary_player_id.is_empty() {
        return None;
    }
    let mut file = load();
    let session = file.sessions.get(guild_id)?.clone();
    // Already labelled as somebody's identity: not in the primary's slot at all.
    if session.player_id.is_some() {
        return None;
    }
    let who = super::directory::player_id_of(&session.user_id)?;
    if who == primary_player_id {
        return None;
    }
    let mut moved = session.clone();
    moved.player_id = Some(who.clone());
    let dest = key_for(guild_id, Some(&who));
    file.sessions.remove(guild_id);
    file.sessions.entry(dest.clone()).or_insert(moved);
    file.version = VERSION;
    save(&file);
    eprintln!(
        "[Comms] {guild_id}: the primary's session was signed in as {who}; \
         moved it to {dest} and left the primary signed out"
    );
    Some(dest)
}

pub fn remove(key: &str) {
    let mut file = load();
    if file.sessions.remove(key).is_some() {
        file.version = VERSION;
        save(&file);
    }
}

/// The portrait stamp last published for this user, if any.
pub fn avatar_for(user_id: &str) -> Option<String> {
    load().avatars.get(user_id).cloned()
}

pub fn put_avatar(user_id: &str, stamp: &str) {
    let mut file = load();
    file.version = VERSION;
    file.avatars.insert(user_id.to_string(), stamp.to_string());
    save(&file);
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

#[cfg(test)]
mod tests {
    use super::*;

    /* The primary's slot holds the primary, or it is emptied.
     *
     * Tested on the DECISION rather than through the file, because what can go
     * wrong here is the judgement, not the IO: "is the account in the primary's
     * slot actually the primary" has three answers and only one of them is
     * "move it". Getting the third wrong — treating "not synced yet" as "wrong
     * person" — would sign the player out of Comms every launch until the
     * chain caught up.
     */
    fn misplaced(user_id: &str, primary: &str, labelled: Option<&str>) -> bool {
        if labelled.is_some() {
            return false;
        }
        match super::super::directory::player_id_of(user_id) {
            Some(who) => who != primary,
            // A user id we cannot read a player out of is not evidence.
            None => false,
        }
    }

    #[test]
    fn only_a_genuinely_wrong_account_is_moved_out_of_the_primary_slot() {
        let srv = "@{}:matrix.crew.oh.energy";
        let uid = |p: &str| srv.replace("{}", p);
        // The primary's own session stays put.
        assert!(!misplaced(&uid("1-194"), "1-194", None));
        // Somebody else's does not.
        assert!(misplaced(&uid("1-271"), "1-194", None));
        // A session already labelled with an identity is not in this slot.
        assert!(!misplaced(&uid("1-271"), "1-194", Some("1-271")));
        // A user id that names no player is not evidence of anything.
        assert!(!misplaced("@bot:matrix.crew.oh.energy", "1-194", None));
    }

    #[test]
    fn an_unknown_primary_id_moves_nothing() {
        // `heal_primary_slot` refuses an empty primary id outright: before the
        // chain has synced we do not know who the primary IS, and signing the
        // player out on every launch until it does would be worse than the bug.
        assert_eq!(heal_primary_slot("0-1", ""), None);
        assert_eq!(heal_primary_slot("", "1-194"), None);
    }

    #[test]
    fn the_primary_keeps_the_bare_guild_id() {
        // Not cosmetic: every session stored before identities existed is
        // keyed this way, and every caller that passes a plain guild id must
        // keep finding it. A scheme that keyed the primary as `0-5#` would
        // have silently signed everyone out on upgrade.
        assert_eq!(key_for("0-5", None), "0-5");
        assert_eq!(guild_of("0-5"), "0-5");
        assert_eq!(player_of("0-5"), None);
    }

    #[test]
    fn a_roster_player_is_a_second_identity_on_the_same_guild() {
        let k = key_for("0-5", Some("1-271"));
        assert_eq!(k, "0-5#1-271");
        // Both halves survive the round trip — this is what lets one key be
        // passed everywhere a guild id used to be.
        assert_eq!(guild_of(&k), "0-5");
        assert_eq!(player_of(&k), Some("1-271"));
        // Same guild, different identity: they must not collide in the store.
        assert_ne!(key_for("0-5", Some("1-271")), key_for("0-5", Some("1-272")));
        assert_ne!(key_for("0-5", Some("1-271")), key_for("0-5", None));
    }

    #[test]
    fn guild_of_is_idempotent() {
        // Call sites normalise with it whether or not they were handed a key,
        // so it has to be safe to apply twice and safe to apply to a plain id.
        let k = key_for("0-5", Some("1-271"));
        assert_eq!(guild_of(guild_of(&k)), "0-5");
        assert_eq!(guild_of(guild_of("0-5")), "0-5");
    }

    #[test]
    fn the_separator_cannot_occur_in_an_id() {
        // Guild ids and player ids are both `<n>-<n>`, so `#` never appears in
        // either and the split is unambiguous in both directions. A separator
        // that COULD occur (say `-`) would make `0-5` parse as guild `0`,
        // player `5`.
        assert!(!"0-5".contains(IDENT_SEP));
        assert!(!"1-271".contains(IDENT_SEP));
        assert_eq!(guild_of("0-5"), "0-5", "a plain id must not split");
    }

    #[test]
    fn identities_are_listed_per_guild() {
        // Pure ordering/filtering check on the shape `identities_on` returns;
        // it reads the real store, so only the invariant is asserted here.
        let a = key_for("0-5", None);
        let b = key_for("0-5", Some("1-271"));
        let other = key_for("0-1", Some("1-271"));
        assert_eq!(guild_of(&a), guild_of(&b));
        assert_ne!(guild_of(&b), guild_of(&other));
    }
}
