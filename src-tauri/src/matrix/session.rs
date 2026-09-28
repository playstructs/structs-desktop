//! One answer to "is Comms up, as whom, and since when".
//!
//! Every window used to decide that for itself — the Comms window from
//! whether a session file entry existed, the raid rail from whether one
//! search call happened to succeed, Team Ops from a poll — and none of them
//! could learn that a token had expired, because nothing here knew either.
//! This is the per-identity state machine they all read now:
//!
//! ```text
//!   Idle ─► Connecting ─► Live ◄─► Stalled
//!                │          │
//!                ▼          ▼
//!             Expired ◄─────┘         (sign in again, by ourselves)
//!                │
//!             SignedOut               (the player asked; stays out)
//! ```
//!
//! The whole picture is a `snapshot()`; every transition pushes the same
//! shape as `matrix::state` with a sequence number, so a window that missed
//! one re-reads instead of guessing. Nothing important exists only as an
//! event that already fired.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Nothing started for this identity (or it is parked: a roster player
    /// whose window is closed).
    Idle,
    /// A sign-in is climbing the ladder.
    Connecting,
    /// Syncing; messages arrive.
    Live,
    /// Sync has failed more than once in a row and is backing off. Still
    /// signed in; still worth waiting for.
    Stalled,
    /// The homeserver will no longer take this token and it could not be
    /// refreshed. A new sign-in is scheduled.
    Expired,
    /// The player signed out. Nothing automatic happens until they open
    /// Comms again.
    SignedOut,
}

impl Phase {
    /// Whether a caller may act as this identity right now. Connecting is
    /// excluded on purpose: a request sent mid-sign-in would carry the old,
    /// dead token.
    pub fn usable(self) -> bool {
        matches!(self, Phase::Idle | Phase::Live | Phase::Stalled)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub key: String,
    pub phase: Phase,
    /// When this phase began, unix millis.
    pub since_ms: u64,
    /// Why, when the phase is one that needs a why (Stalled, Expired, and a
    /// Connecting that follows a failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The ladder rung in flight while Connecting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// When the next automatic sign-in is due, while Expired.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_try_ms: Option<u64>,
    pub as_player: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

/// What an identity may do right now, as the service says it rather than
/// as each window works it out from three fields. `rooms_on` is the one
/// homeserver whose alias namespace this identity may create rooms in.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Capabilities {
    pub read: bool,
    pub send: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rooms_on: Option<String>,
    /// The player id this identity speaks as — the roster player, or the
    /// primary's own id once the chain has said what it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaking_as: Option<String>,
}

fn capabilities_of(id: &Identity, session: Option<&super::store::Session>) -> Capabilities {
    let up = id.phase.usable() && session.is_some();
    Capabilities {
        read: up,
        send: up,
        rooms_on: if up { session.map(super::client::own_server) } else { None },
        speaking_as: id.as_player.clone().or_else(|| {
            crate::game_state::GAME_STATE.read().ok().and_then(|g| g.player_id.clone())
        }),
    }
}

static STATES: std::sync::LazyLock<RwLock<BTreeMap<String, Identity>>> =
    std::sync::LazyLock::new(|| RwLock::new(BTreeMap::new()));
static SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn phase(key: &str) -> Phase {
    STATES
        .read()
        .ok()
        .and_then(|m| m.get(key).map(|i| i.phase))
        .unwrap_or(Phase::Idle)
}

pub fn identity(key: &str) -> Option<Identity> {
    STATES.read().ok().and_then(|m| m.get(key).cloned())
}

/// The session for `key`, or the phase that says why not. THE gate: every
/// authenticated command goes through this, so "signed in" means the same
/// thing to all of them — a stored token whose sign-in is in flight, or that
/// the issuer has refused, is not one anybody may use.
pub fn usable(key: &str) -> Result<super::store::Session, Phase> {
    let p = phase(key);
    if !p.usable() {
        return Err(p);
    }
    super::store::get(key).ok_or(Phase::Idle)
}

/// Move an identity to `phase`. Returns whether anything changed — the same
/// phase with the same reason is not a transition and emits nothing, which
/// is what lets the sync loop assert `Live` on every pass.
fn apply(key: &str, phase: Phase, reason: Option<String>) -> bool {
    let Ok(mut m) = STATES.write() else { return false };
    let as_player = super::store::player_of(key).map(String::from);
    let entry = m.entry(key.to_string()).or_insert_with(|| Identity {
        key: key.to_string(),
        phase: Phase::Idle,
        since_ms: now_ms(),
        reason: None,
        step: None,
        next_try_ms: None,
        as_player: as_player.clone(),
        user_id: None,
    });
    let changed = entry.phase != phase || entry.reason != reason;
    if entry.phase != phase {
        entry.since_ms = now_ms();
    }
    entry.phase = phase;
    entry.reason = reason;
    if phase != Phase::Connecting {
        entry.step = None;
    }
    if phase != Phase::Expired {
        entry.next_try_ms = None;
    }
    entry.user_id = super::store::get(key).map(|s| s.user_id);
    if changed {
        SEQ.fetch_add(1, Ordering::Relaxed);
    }
    changed
}

/// Announce the whole picture. Every transition pushes the same shape any
/// window can also read cold with `matrix_state`.
fn push(app: &tauri::AppHandle) {
    let _ = crate::mcp::events::emit_matrix(app, "matrix::state", snapshot());
}

pub fn transition(app: &tauri::AppHandle, key: &str, phase: Phase, reason: Option<String>) -> bool {
    let changed = apply(key, phase, reason);
    if changed {
        push(app);
    }
    changed
}

/// The rung a sign-in is on. Pushed even though the phase has not changed:
/// a window watching a sign-in wants to see it move.
pub fn set_step(app: &tauri::AppHandle, key: &str, step: Option<String>) {
    if let Ok(mut m) = STATES.write() {
        if let Some(i) = m.get_mut(key) {
            if i.step == step {
                return;
            }
            i.step = step;
            SEQ.fetch_add(1, Ordering::Relaxed);
        }
    }
    push(app);
}

pub fn set_next_try(app: &tauri::AppHandle, key: &str, at_ms: Option<u64>) {
    if let Ok(mut m) = STATES.write() {
        if let Some(i) = m.get_mut(key) {
            i.next_try_ms = at_ms;
            SEQ.fetch_add(1, Ordering::Relaxed);
        }
    }
    push(app);
}

/// Everything, for anyone: each identity's state, the unread totals, and a
/// sequence number that only ever grows.
pub fn snapshot() -> Value {
    let identities: BTreeMap<String, Identity> = STATES
        .read()
        .map(|m| m.clone())
        .unwrap_or_default();
    // Each identity with what it may do, so a window renders permission
    // rather than inferring it.
    let identities: BTreeMap<String, Value> = identities
        .into_iter()
        .map(|(k, id)| {
            let session = super::store::get(&k);
            let caps = capabilities_of(&id, session.as_ref());
            let mut v = serde_json::to_value(&id).unwrap_or(Value::Null);
            v["capabilities"] = serde_json::to_value(caps).unwrap_or(Value::Null);
            (k, v)
        })
        .collect();
    let (count, mention) = super::client::unread_totals();
    json!({
        "identities": identities,
        "unread": { "count": count, "mention": mention },
        "seq": SEQ.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_settled_session_is_usable() {
        assert!(Phase::Live.usable());
        assert!(Phase::Stalled.usable(), "a stall is a wait, not a refusal");
        assert!(Phase::Idle.usable(), "a stored session nobody has started yet still works");
        assert!(!Phase::Connecting.usable(), "the old token is the one a request would carry");
        assert!(!Phase::Expired.usable());
        assert!(!Phase::SignedOut.usable());
    }

    #[test]
    fn a_transition_is_a_change_of_phase_or_reason() {
        let k = "7-1#1-9001";
        assert!(apply(k, Phase::Connecting, None));
        assert!(!apply(k, Phase::Connecting, None), "same phase, same reason: nothing to announce");
        assert!(apply(k, Phase::Stalled, Some("refused".into())));
        assert!(apply(k, Phase::Stalled, Some("timed out".into())), "a new reason is news");
        // `SEQ` is process-wide and the other tests in this module bump it in
        // parallel, so "no change, no sequence step" is judged on the
        // identity's own record staying put.
        let since = identity(k).unwrap().since_ms;
        assert!(!apply(k, Phase::Stalled, Some("timed out".into())));
        assert_eq!(identity(k).unwrap().since_ms, since, "no change, no new phase start");
        assert!(apply(k, Phase::Live, None));
        assert_eq!(phase(k), Phase::Live);
        let id = identity(k).unwrap();
        assert_eq!(id.as_player.as_deref(), Some("1-9001"), "the identity knows who it speaks as");
        assert!(id.reason.is_none());
    }

    #[test]
    fn a_step_belongs_to_connecting_only() {
        let k = "7-2";
        apply(k, Phase::Connecting, None);
        STATES.write().unwrap().get_mut(k).unwrap().step = Some("Guild login".into());
        apply(k, Phase::Live, None);
        assert!(identity(k).unwrap().step.is_none(), "a rung outlives no sign-in");
        assert_eq!(identity(k).unwrap().as_player, None, "the bare guild key is the primary");
    }

    #[test]
    fn the_snapshot_carries_every_identity_and_a_sequence() {
        apply("7-3", Phase::Expired, Some("token refresh refused (400)".into()));
        let s = snapshot();
        assert_eq!(s["identities"]["7-3"]["phase"], "expired");
        assert_eq!(s["identities"]["7-3"]["reason"], "token refresh refused (400)");
        assert!(s["seq"].as_u64().unwrap() > 0);
        assert!(s["unread"]["count"].is_number());
        // An expired identity may do nothing, and says so itself.
        assert_eq!(s["identities"]["7-3"]["capabilities"]["send"], false);
        assert_eq!(s["identities"]["7-3"]["capabilities"]["read"], false);
    }

    #[test]
    fn capabilities_follow_the_phase_and_the_session() {
        let mk = |phase: Phase, as_player: Option<&str>| Identity {
            key: "7-4".into(), phase, since_ms: 0, reason: None, step: None,
            next_try_ms: None, as_player: as_player.map(String::from), user_id: None,
        };
        let session = super::super::store::Session {
            guild_id: "7-4".into(), player_id: Some("1-7040".into()), homeserver: "https://matrix.example".into(),
            user_id: "@1-7040:example".into(), device_id: "d".into(), access_token: "t".into(),
            refresh_token: None, expires_at: None, client_id: "c".into(), token_endpoint: "e".into(),
        };
        let live = capabilities_of(&mk(Phase::Live, Some("1-7040")), Some(&session));
        assert!(live.read && live.send);
        assert_eq!(live.rooms_on.as_deref(), Some("example"), "the server NAME, off our own user id");
        assert_eq!(live.speaking_as.as_deref(), Some("1-7040"));
        let mid = capabilities_of(&mk(Phase::Connecting, Some("1-7040")), Some(&session));
        assert!(!mid.send, "the token in hand is the dead one");
        assert!(mid.rooms_on.is_none());
        let orphan = capabilities_of(&mk(Phase::Live, None), None);
        assert!(!orphan.read, "a phase without a session is nothing to act with");
    }
}
