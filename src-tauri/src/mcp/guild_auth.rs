//! Guild API session, obtained by Rust itself.
//!
//! Every `/api/*` route on the guild server is session-gated. Until now the
//! only way that session came into being was the webapp's own auto-login
//! (`AuthManager.buildLoginRequest` → `POST /api/auth/login`), whose cookie
//! landed in the HTTP client we share with the JS fetch proxy. So every
//! Rust-side read made before the webview finished signing in — the first
//! perception refresh at launch, above all — came back `401 Login required`
//! and fell to the LCD walk, and a session that idled out while the game
//! window sat minimized stayed dead until someone reloaded the page.
//!
//! The login is a signed statement, and the key that signs it is the device
//! key the native signer already holds (`m/44'/118'/0'/0/0`), so Rust can
//! produce exactly what the webapp produces:
//!
//! ```text
//! message   = "LOGIN_GUILD{guild_id}ADDRESS{address}DATETIME{unix_timestamp}"
//! signature = hex( secp256k1_sign( sha256(message) ) )   (64 bytes, r‖s)
//! pubkey    = hex( compressed secp256k1 public key )     (33 bytes)
//! ```
//!
//! and the server (`AuthManager::login` → `SignatureValidationManager`)
//! checks the timestamp is recent, asks the chain to validate the signature,
//! and looks the address up in `player_address` for that guild. The cookie
//! it sets lands in the same shared jar, so nothing else changes.
//!
//! Triggered on demand: the guild client retries a request once after a
//! successful [`recover`] when it sees the auth-required answer. Single
//! flight, rate limited, and never a substitute for the webapp's own login —
//! the game window keeps doing what it does.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::mcp::guild_api::GuildApiClient;
use crate::mcp::telemetry::{tlog, Sev};

/// One login at a time. Concurrent 401s — the seven parallel page walks of
/// a snapshot refresh — all WAIT here for the one login in flight and then
/// retry, instead of the first caller logging in and the rest failing over
/// to the LCD 70 ms too early (observed on the first build).
static LOGIN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LAST_ATTEMPT_MS: AtomicU64 = AtomicU64::new(0);
static LAST_OK_MS: AtomicU64 = AtomicU64::new(0);
static LOGINS_OK: AtomicU64 = AtomicU64::new(0);
static LOGINS_FAILED: AtomicU64 = AtomicU64::new(0);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Two attempts closer together than this are one attempt: a burst of 401s
/// from a parallel page walk must not become a burst of logins.
const MIN_GAP_MS: u64 = 15_000;

fn now_ms() -> u64 {
    crate::hasher::types::now_millis() as u64
}

/// The exact string the server rebuilds and verifies.
pub fn login_message(guild_id: &str, address: &str, unix_timestamp: &str) -> String {
    format!("LOGIN_GUILD{guild_id}ADDRESS{address}DATETIME{unix_timestamp}")
}

/// Perform one login now. Errors name the step that failed.
pub async fn login(client: &GuildApiClient) -> Result<(), String> {
    let guild_id = crate::guild_config::get_active_guild_config()
        .map(|c| c.guild_id)
        .filter(|g| !g.is_empty())
        .ok_or("no active guild")?;
    let (key, address) = crate::mcp::native_signer::device_key()?;

    // The server's clock, not ours: the message must be within its expiry.
    let ts = client.get_public("/api/timestamp").await.map_err(|e| format!("timestamp: {e}"))?;
    let unix_timestamp = match ts.get("unix_timestamp") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return Err("timestamp: no unix_timestamp in response".into()),
    };

    let message = login_message(&guild_id, &address, &unix_timestamp);
    let signature = key
        .sign(message.as_bytes())
        .map_err(|e| format!("sign: {e}"))?;
    let signature_hex = hex::encode(signature.to_bytes());
    let pubkey_hex = hex::encode(key.public_key().to_bytes());

    let body = json!({
        "address": address,
        "signature": signature_hex,
        "pubkey": pubkey_hex,
        "guild_id": guild_id,
        "unix_timestamp": unix_timestamp,
    });
    let env = client.post_public("/api/auth/login", &body).await.map_err(|e| format!("login: {e}"))?;
    let ok = env.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
    if !ok {
        let errors = env.get("errors").map(|e| e.to_string()).unwrap_or_default();
        return Err(format!("login rejected: {errors}"));
    }
    Ok(())
}

/// Recover the session after an auth-required answer. Returns true when a
/// login just succeeded (the caller should retry its request once), false
/// when it was skipped (too soon, in flight, no key) or failed.
pub async fn recover(client: &GuildApiClient) -> bool {
    if !crate::mcp::native_signer::is_ready() {
        return false;
    }
    let _guard = LOGIN_LOCK.lock().await;
    let now = now_ms();
    // A login that just succeeded (possibly while we waited for the lock)
    // is our answer: the session is fresh, retry.
    if now.saturating_sub(LAST_OK_MS.load(Ordering::Relaxed)) < MIN_GAP_MS {
        return true;
    }
    // A login that just FAILED is not retried in a burst.
    if now.saturating_sub(LAST_ATTEMPT_MS.load(Ordering::Relaxed)) < MIN_GAP_MS {
        return false;
    }
    LAST_ATTEMPT_MS.store(now, Ordering::Relaxed);
    let result = login(client).await;
    match result {
        Ok(()) => {
            LOGINS_OK.fetch_add(1, Ordering::Relaxed);
            LAST_OK_MS.store(now_ms(), Ordering::Relaxed);
            *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = None;
            tlog("guild_auth", Sev::Info, "guild session renewed natively (device key)");
            true
        }
        Err(e) => {
            LOGINS_FAILED.fetch_add(1, Ordering::Relaxed);
            *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.clone());
            tlog("guild_auth", Sev::Warn, format!("native guild login failed: {e}"));
            false
        }
    }
}

pub fn health() -> Value {
    let ok = LAST_OK_MS.load(Ordering::Relaxed);
    json!({
        "logins_ok": LOGINS_OK.load(Ordering::Relaxed),
        "logins_failed": LOGINS_FAILED.load(Ordering::Relaxed),
        "last_login_age_s": if ok == 0 { Value::Null } else { json!(now_ms().saturating_sub(ok) / 1000) },
        "last_error": LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        "key_ready": crate::mcp::native_signer::is_ready(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_message_matches_the_webapp_and_the_server_byte_for_byte() {
        // GuildAPI.buildLoginMessage / SignatureValidationManager::buildLoginMessage
        assert_eq!(
            login_message("0-1", "structs12wll0unjn6rzmjchnqy8e07txfeaf4w8y3x6ne", "1788561773"),
            "LOGIN_GUILD0-1ADDRESSstructs12wll0unjn6rzmjchnqy8e07txfeaf4w8y3x6neDATETIME1788561773"
        );
    }

    /// Live: the chain's own validator accepts a login signature made the
    /// Rust way (random key, so no keychain needed).
    /// `cargo test --bin structs-app -- --ignored live_chain_validates`
    #[tokio::test]
    #[ignore]
    async fn live_chain_validates_a_rust_made_login_signature() {
        use cosmrs::crypto::secp256k1::SigningKey;
        let key = SigningKey::random();
        let address = key.public_key().account_id("structs").unwrap().to_string();
        let message = login_message("0-1", &address, "1788561773");
        let sig_hex = hex::encode(key.sign(message.as_bytes()).unwrap().to_bytes());
        let pub_hex = hex::encode(key.public_key().to_bytes());
        let lcd = crate::guild_config::get_active_guild_config().map(|c| c.reactor_api).unwrap_or_else(|| "http://localhost:1317".into());
        let url = format!("{lcd}/structs/validate_signature/{address}/{pub_hex}/{sig_hex}/{message}");
        let v: Value = reqwest::get(&url).await.expect("lcd").json().await.expect("json");
        assert_eq!(v.get("valid"), Some(&Value::Bool(true)), "chain rejected the signature: {v}");
        // and a tampered message is rejected, so the check is real
        let bad = format!("{lcd}/structs/validate_signature/{address}/{pub_hex}/{sig_hex}/{message}X");
        let v: Value = reqwest::get(&bad).await.expect("lcd").json().await.expect("json");
        assert_ne!(v.get("valid"), Some(&Value::Bool(true)));
    }

    #[test]
    fn signature_is_the_webapps_fixed_length_hex_over_sha256() {
        // The webapp: sha256(utf8(message)) → Secp256k1.createSignature(digest) →
        // hex(toFixedLength()). cosmrs' SigningKey::sign hashes the message with
        // sha256 before signing, so passing the raw message bytes yields the
        // same 64-byte r‖s. Verify that identity against a known key.
        use cosmrs::crypto::secp256k1::SigningKey;
        use sha2::{Digest, Sha256};
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let message = login_message("0-1", "structs1test", "1");
        let sig = key.sign(message.as_bytes()).unwrap();
        let bytes = sig.to_bytes();
        assert_eq!(bytes.len(), 64);
        assert_eq!(hex::encode(bytes).len(), 128);
        // Independently: ECDSA over the prehashed digest verifies with the same key.
        use k256::ecdsa::signature::hazmat::PrehashVerifier;
        let digest = Sha256::digest(message.as_bytes());
        let vk = k256::ecdsa::VerifyingKey::from_sec1_bytes(&key.public_key().to_bytes()).unwrap();
        let s = k256::ecdsa::Signature::from_slice(&bytes).unwrap();
        assert!(vk.verify_prehash(&digest, &s).is_ok());
        assert_eq!(key.public_key().to_bytes().len(), 33, "compressed pubkey, as the webapp sends");
    }
}
