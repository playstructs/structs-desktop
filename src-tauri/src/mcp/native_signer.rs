//! Native virtual-player signer — signs and broadcasts in Rust, replacing the
//! `signAndBroadcastAs` round-trip through the game webview for every account
//! this app derives (HD index >= 1).
//!
//! WHY. Every virtual-player transaction used to be a Rust → JS → Rust
//! round-trip: emit `structs:vplayer-request`, wait for the webview's CosmJS
//! client to derive the key, connect, sign and broadcast, then resolve a
//! oneshot. The webview is a fine game client and a poor signing service: it
//! stopped answering while every health signal stayed green (2026-08-20,
//! 18 minutes of zero writes), saturated WebKit's per-host connection pool
//! until the WebContent process died, capped the whole system at ~0.66
//! signs/s behind a 60 s bound, and on a second-device install signed with an
//! address the chain did not consider the primary. None of that is
//! cryptography. This module keeps the same contract — the same
//! `{index, type_url, payload}` in, the same `{code, transactionHash, height,
//! rawLog}` out, the same error vocabulary (so `tx_retry::classify` and the
//! ledger see no difference) — and does the work in-process.
//!
//! CUSTODY. The mnemonic is handed over ONCE by the signed-in webview
//! (`native_signer_import`, called from structs-config.js), verified against
//! the device address the game is signed in as, and stored in the OS keychain
//! (service "Structs Desktop"). The webapp already keeps it in plaintext inside
//! the `gameState` localStorage entry, so this is strictly better custody, not
//! a new exposure. In memory only the BIP39 seed is held (zeroized on drop); a
//! signing key is derived per sign at `m/44'/118'/0'/0/N` and dropped before
//! the first await.
//!
//! SEQUENCE. One tracker per account, seeded from the LCD auth query, advanced
//! on mempool acceptance and reset from the chain's own "expected N" whenever
//! it disagrees. The per-account mutex is shared with the JS bridge so the two
//! paths can never race one account; a bounded gate caps the fan-out.
//!
//! TRANSPORT. Plain LCD REST on the base every read already uses:
//! `POST /cosmos/tx/v1beta1/txs` in BROADCAST_MODE_SYNC (the CheckTx result,
//! so ante errors such as "zero charge this block" surface immediately) and
//! `GET /cosmos/tx/v1beta1/txs/{hash}` for inclusion. Nothing touches :26657,
//! no websocket, no browser pool.
//!
//! OPT-IN. `sign_mode` "native" waits for inclusion; "native_async" returns
//! on acceptance and settles through `tx_settled` events like the JS async
//! path. Until the key has been imported both fall back to the JS bridge so
//! nothing stalls; the fallback is counted and logged, and `structs_system
//! status` shows the signer's state.

use base64::Engine;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

use cosmrs::crypto::secp256k1::SigningKey;
use cosmrs::tx::{Body, Fee, SignDoc, SignerInfo};
use cosmrs::{Any, Coin};

const KEYCHAIN_SERVICE: &str = "Structs Desktop";
const KEYCHAIN_USER: &str = "signing-mnemonic";
const BECH32_PREFIX: &str = "structs";
/// Same fee the webapp's queue uses (`constants/Fee.js`): zero ualpha, 500k gas.
const FEE_DENOM: &str = "ualpha";
const GAS_LIMIT: u64 = 500_000;
const BROADCAST_TIMEOUT_SECS: u64 = 20;
/// Inclusion wait in sync mode — stays under the 60 s bound every caller uses.
const INCLUSION_TIMEOUT_MS: u64 = 55_000;
const INCLUSION_POLL_MS: u64 = 1_500;
/// Async-mode settlement watch, mirroring `_vpWatchSettlement` in the patch.
const SETTLE_TIMEOUT_MS: u64 = 90_000;
const SETTLE_POLL_MS: u64 = 3_000;
/// Concurrent native signs. The chain's tx gate (`tx_gate`) already orders
/// admission; this only bounds the HTTP fan-out against one LCD.
static NATIVE_GATE: Semaphore = Semaphore::const_new(16);

static SEED: RwLock<Option<Zeroizing<[u8; 64]>>> = RwLock::new(None);
static DEVICE_ADDRESS: RwLock<Option<String>> = RwLock::new(None);
static KEY_SOURCE: RwLock<&'static str> = RwLock::new("none");
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);
static SIGNS_OK: AtomicU64 = AtomicU64::new(0);
static SIGNS_FAILED: AtomicU64 = AtomicU64::new(0);
static SEQ_RESETS: AtomicU64 = AtomicU64::new(0);
static FALLBACKS: AtomicU64 = AtomicU64::new(0);
static LAST_FALLBACK_LOG_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug)]
struct AccountState {
    number: u64,
    sequence: u64,
}

/// address → (account_number, next sequence).
static ACCOUNTS: LazyLock<DashMap<String, AccountState>> = LazyLock::new(DashMap::new);
/// LCD base → chain id (a guild switch changes the base, never the id under it).
static CHAIN_IDS: LazyLock<DashMap<String, String>> = LazyLock::new(DashMap::new);

fn now_ms() -> f64 {
    crate::hasher::types::now_millis()
}

fn hd_path(index: u32) -> String {
    format!("m/44'/118'/0'/0/{index}")
}

fn seed_from_mnemonic(mnemonic: &str) -> Result<Zeroizing<[u8; 64]>, String> {
    // BIP39 wants single spaces and lowercase; the game's mnemonic is already
    // normalised but a pasted one may not be.
    let normalised: Zeroizing<String> =
        Zeroizing::new(mnemonic.split_whitespace().map(|w| w.to_lowercase()).collect::<Vec<_>>().join(" "));
    let m = bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &normalised)
        .map_err(|e| format!("invalid mnemonic: {e}"))?;
    Ok(Zeroizing::new(m.to_seed("")))
}

fn derive(seed: &[u8], index: u32) -> Result<(SigningKey, String), String> {
    let path: cosmrs::bip32::DerivationPath =
        hd_path(index).parse().map_err(|e| format!("bad HD path for index {index}: {e}"))?;
    let key = SigningKey::derive_from_path(seed, &path).map_err(|e| format!("key derivation failed: {e}"))?;
    let address = key
        .public_key()
        .account_id(BECH32_PREFIX)
        .map_err(|e| format!("address derivation failed: {e}"))?
        .to_string();
    Ok((key, address))
}

/// Is a key loaded? (Not whether native mode is selected — see `sign_mode`.)
pub fn is_ready() -> bool {
    SEED.read().unwrap().is_some()
}

/// The bech32 address at HD index `index`.
/// The device key (HD index 0) and its bech32 address — the account the
/// game window signed in with, and the one the guild server's
/// `player_address` table knows. Refuses to answer if the derived address
/// is not the address the webview handed over at sign-in.
pub(crate) fn device_key() -> Result<(SigningKey, String), String> {
    let guard = SEED.read().unwrap();
    let seed = guard.as_ref().ok_or("native signer has no key (sign in to the game first)")?;
    let (key, addr) = derive(&seed[..], 0)?;
    if let Some(expected) = DEVICE_ADDRESS.read().unwrap().as_deref() {
        if expected != addr {
            return Err(format!("device key mismatch: derived {addr}, signed-in device is {expected}"));
        }
    }
    Ok((key, addr))
}

pub fn address(index: u32) -> Result<String, String> {
    let guard = SEED.read().unwrap();
    let seed = guard.as_ref().ok_or("native signer has no key")?;
    derive(&seed[..], index).map(|(_, a)| a)
}

fn install_seed(seed: Zeroizing<[u8; 64]>, source: &'static str) -> Result<String, String> {
    let (_, addr0) = derive(&seed[..], 0)?;
    *SEED.write().unwrap() = Some(seed);
    *DEVICE_ADDRESS.write().unwrap() = Some(addr0.clone());
    *KEY_SOURCE.write().unwrap() = source;
    ACCOUNTS.clear();
    Ok(addr0)
}

// ── Keychain ─────────────────────────────────────────────────────────────────

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

fn keychain_read() -> Result<Option<Zeroizing<String>>, String> {
    match keychain_entry()?.get_password() {
        Ok(p) => Ok(Some(Zeroizing::new(p))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Load the key from the keychain at startup, off the main thread (the first
/// access can block on a keychain prompt for unsigned builds).
pub fn init() {
    std::thread::spawn(|| match keychain_read() {
        Ok(Some(m)) => match seed_from_mnemonic(&m).and_then(|s| install_seed(s, "keychain")) {
            Ok(a) => eprintln!("[Structs NativeSigner] key loaded from keychain (device address {a})"),
            Err(e) => eprintln!("[Structs NativeSigner] keychain entry unusable: {e}"),
        },
        Ok(None) => eprintln!(
            "[Structs NativeSigner] no key in keychain yet — native sign mode falls back to the webview until the game signs in"
        ),
        Err(e) => eprintln!("[Structs NativeSigner] keychain unavailable: {e}"),
    });
}

/// One-time handoff from the signed-in webview. `address` is the device
/// account the game is signed in as; the mnemonic must derive it at index 0
/// or it is refused — the wrong key stored here would sign as strangers.
#[tauri::command]
pub async fn native_signer_import(mnemonic: String, address: Option<String>) -> Result<Value, String> {
    let mnemonic = Zeroizing::new(mnemonic);
    let seed = seed_from_mnemonic(&mnemonic)?;
    let (_, addr0) = derive(&seed[..], 0)?;
    if let Some(expected) = address.as_deref() {
        if expected != addr0 {
            return Err(format!(
                "mnemonic does not derive the signed-in device address ({expected}); refusing to store it"
            ));
        }
    }
    // Keychain writes may prompt on unsigned builds, so write only on change.
    let stored = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let existing = keychain_read()?;
        if existing.as_ref().map(|e| e.as_str()) == Some(mnemonic.as_str()) {
            return Ok(false);
        }
        keychain_entry()?.set_password(&mnemonic).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (changed, keychain_error, source) = match stored {
        Ok(changed) => (changed, None, "keychain"),
        // No usable keychain (a Linux box without a secret service, say):
        // sign natively for this session anyway and say so.
        Err(e) => {
            eprintln!("[Structs NativeSigner] keychain write failed, holding the key in memory only: {e}");
            (false, Some(e), "memory")
        }
    };
    install_seed(seed, source)?;
    eprintln!("[Structs NativeSigner] key {} for device address {addr0}", if changed { "stored" } else { "confirmed" });
    Ok(json!({ "ok": true, "address": addr0, "changed": changed, "keychain_error": keychain_error }))
}

/// Remove the key from the keychain and memory. Native mode falls back to the
/// webview until the next import.
#[tauri::command]
pub async fn native_signer_forget() -> Result<Value, String> {
    *SEED.write().unwrap() = None;
    *DEVICE_ADDRESS.write().unwrap() = None;
    *KEY_SOURCE.write().unwrap() = "none";
    ACCOUNTS.clear();
    let deleted = tauri::async_runtime::spawn_blocking(|| match keychain_entry()?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(json!({ "ok": true, "deleted": deleted }))
}

#[tauri::command]
pub fn native_signer_status() -> Value {
    health()
}

/// For `structs_system status` / the bridge health block.
pub fn health() -> Value {
    let mode = super::vplayer_bridge::sign_mode();
    let native_mode = mode.starts_with("native");
    json!({
        "key_loaded": is_ready(),
        "key_source": *KEY_SOURCE.read().unwrap(),
        "device_address": DEVICE_ADDRESS.read().unwrap().clone(),
        "mode": mode,
        "active": native_mode && is_ready(),
        "accounts_tracked": ACCOUNTS.len(),
        "signs_ok": SIGNS_OK.load(Ordering::Relaxed),
        "signs_failed": SIGNS_FAILED.load(Ordering::Relaxed),
        "sequence_resets": SEQ_RESETS.load(Ordering::Relaxed),
        "fallbacks_to_webview": FALLBACKS.load(Ordering::Relaxed),
        "last_error": LAST_ERROR.lock().unwrap().clone(),
        "message_types": super::chain_codec::known_message_types(),
    })
}

/// Native mode is selected but no key is loaded: count it, log it (rate
/// limited), and let the caller take the JS path.
pub fn note_fallback() {
    FALLBACKS.fetch_add(1, Ordering::Relaxed);
    let now = now_ms() as u64;
    let last = LAST_FALLBACK_LOG_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) > 60_000 {
        LAST_FALLBACK_LOG_MS.store(now, Ordering::Relaxed);
        eprintln!(
            "[Structs NativeSigner] sign_mode is native but no key is loaded — signing through the webview instead (sign in to the game to hand the key over)"
        );
    }
}

// ── Chain reads ──────────────────────────────────────────────────────────────

async fn chain_id(base: &str) -> Result<String, String> {
    if let Some(id) = CHAIN_IDS.get(base) {
        return Ok(id.clone());
    }
    let v = super::cosmos_client::get_json(&format!("{base}/cosmos/base/tendermint/v1beta1/node_info")).await?;
    let id = v
        .pointer("/default_node_info/network")
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "node_info did not report a chain id".to_string())?
        .to_string();
    CHAIN_IDS.insert(base.to_string(), id.clone());
    Ok(id)
}

fn parse_account(v: &Value) -> Option<AccountState> {
    let acct = v.get("account")?;
    // BaseAccount carries the fields directly; vesting/module accounts nest
    // them under base_account.
    let base = if acct.get("account_number").is_some() { acct } else { acct.get("base_account")? };
    let num = |k: &str| base.get(k).and_then(|x| x.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| x.as_u64()));
    Some(AccountState { number: num("account_number")?, sequence: num("sequence")? })
}

async fn account_state(base: &str, address: &str) -> Result<AccountState, String> {
    if let Some(a) = ACCOUNTS.get(address) {
        return Ok(*a);
    }
    let v = super::cosmos_client::get_json(&format!("{base}/cosmos/auth/v1beta1/accounts/{address}"))
        .await
        .map_err(|e| format!("account lookup for {address} failed: {e}"))?;
    let state = parse_account(&v).ok_or_else(|| format!("account {address} has no account_number/sequence: {v}"))?;
    ACCOUNTS.insert(address.to_string(), state);
    Ok(state)
}

fn bump_sequence(address: &str) {
    if let Some(mut a) = ACCOUNTS.get_mut(address) {
        a.sequence += 1;
    }
}

/// "account sequence mismatch, expected 2239, got 2238: incorrect account sequence" → 2239
fn parse_expected_sequence(raw_log: &str) -> Option<u64> {
    if !raw_log.contains("account sequence") {
        return None;
    }
    let after = raw_log.split("expected ").nth(1)?;
    after.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// A rejection tells us what the chain believes; fold it back into the tracker.
fn on_reject(address: &str, raw_log: &str) {
    if let Some(expected) = parse_expected_sequence(raw_log) {
        ACCOUNTS.entry(address.to_string()).and_modify(|a| a.sequence = expected);
        SEQ_RESETS.fetch_add(1, Ordering::Relaxed);
    } else if raw_log.contains("account") && raw_log.contains("not found") {
        ACCOUNTS.remove(address);
    }
}

// ── Build, sign, broadcast ───────────────────────────────────────────────────

fn sign_tx_with(
    seed: &[u8],
    index: u32,
    chain_id: &str,
    acct: AccountState,
    type_url: &str,
    msg_bytes: Vec<u8>,
) -> Result<(Vec<u8>, String), String> {
    let (key, address) = derive(seed, index)?;
    let body = Body::new([Any { type_url: type_url.to_string(), value: msg_bytes }], "", 0u32);
    let fee = Fee::from_amount_and_gas(
        Coin { denom: FEE_DENOM.parse().map_err(|e| format!("bad fee denom: {e}"))?, amount: 0 },
        GAS_LIMIT,
    );
    let auth_info = SignerInfo::single_direct(Some(key.public_key()), acct.sequence).auth_info(fee);
    let chain: cosmrs::tendermint::chain::Id = chain_id.parse().map_err(|e| format!("bad chain id {chain_id:?}: {e}"))?;
    let doc = SignDoc::new(&body, &auth_info, &chain, acct.number).map_err(|e| format!("sign doc: {e}"))?;
    let raw = doc.sign(&key).map_err(|e| format!("signing failed: {e}"))?;
    let bytes = raw.to_bytes().map_err(|e| format!("tx encoding failed: {e}"))?;
    Ok((bytes, address))
}

/// Derive, sign and encode with the loaded seed. Synchronous on purpose: the
/// key never lives across an await.
fn build_signed_tx(index: u32, chain_id: &str, acct: AccountState, type_url: &str, msg_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let guard = SEED.read().unwrap();
    let seed = guard.as_ref().ok_or("native signer has no key")?;
    sign_tx_with(&seed[..], index, chain_id, acct, type_url, msg_bytes).map(|(b, _)| b)
}

struct Broadcast {
    code: i64,
    hash: String,
    raw_log: String,
    codespace: String,
}

async fn broadcast(base: &str, tx_bytes: &[u8]) -> Result<Broadcast, String> {
    let body = json!({
        "tx_bytes": base64::engine::general_purpose::STANDARD.encode(tx_bytes),
        "mode": "BROADCAST_MODE_SYNC",
    });
    let resp = super::cosmos_client::client()
        .post(format!("{base}/cosmos/tx/v1beta1/txs"))
        .timeout(Duration::from_secs(BROADCAST_TIMEOUT_SECS))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("broadcast HTTP error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("broadcast read error: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("broadcast returned {status}: {text}"))?;
    let r = v
        .get("tx_response")
        .ok_or_else(|| format!("broadcast returned {status}: {}", v.get("message").and_then(|m| m.as_str()).unwrap_or(&text)))?;
    Ok(Broadcast {
        code: r.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
        hash: r.get("txhash").and_then(|h| h.as_str()).unwrap_or("").to_string(),
        raw_log: r.get("raw_log").and_then(|l| l.as_str()).unwrap_or("").to_string(),
        codespace: r.get("codespace").and_then(|c| c.as_str()).unwrap_or("").to_string(),
    })
}

/// The CosmJS `BroadcastTxError` wording — `tx_retry::classify` keys on it.
fn rejection_error(code: i64, codespace: &str, raw_log: &str) -> String {
    format!("Broadcasting transaction failed with code {code} (codespace: {codespace}). Log: {raw_log}")
}

/// Included tx: (code, height, raw_log). `Ok(None)` = not in a block yet.
async fn lookup_tx(base: &str, hash: &str) -> Result<Option<(i64, u64, String)>, String> {
    let resp = super::cosmos_client::client()
        .get(format!("{base}/cosmos/tx/v1beta1/txs/{hash}"))
        .send()
        .await
        .map_err(|e| format!("tx lookup HTTP error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("tx lookup read error: {e}"))?;
    if status.as_u16() == 404 {
        return Ok(None);
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("tx lookup returned {status}: {text}"))?;
    match v.get("tx_response") {
        Some(r) => Ok(Some((
            r.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
            r.get("height").and_then(|h| h.as_str().and_then(|s| s.parse().ok()).or_else(|| h.as_u64())).unwrap_or(0),
            r.get("raw_log").and_then(|l| l.as_str()).unwrap_or("").to_string(),
        ))),
        // The gateway answers "tx not found" as a gRPC NotFound (code 5) too.
        None if v.get("code").and_then(|c| c.as_i64()) == Some(5) => Ok(None),
        None => Err(format!("tx lookup returned {status}: {text}")),
    }
}

async fn wait_for_inclusion(base: &str, hash: &str) -> Result<(i64, u64, String), String> {
    let started = now_ms();
    loop {
        tokio::time::sleep(Duration::from_millis(INCLUSION_POLL_MS)).await;
        match lookup_tx(base, hash).await {
            Ok(Some(found)) => return Ok(found),
            Ok(None) => {}
            Err(e) => eprintln!("[Structs NativeSigner] inclusion poll for {hash}: {e}"),
        }
        if now_ms() - started > INCLUSION_TIMEOUT_MS as f64 {
            // CosmJS's TimeoutError wording, so the classifier treats it alike.
            return Err(format!(
                "Transaction with ID {hash} was submitted but was not yet found on the chain. You might want to check later."
            ));
        }
    }
}

/// Async mode: poll until the tx lands (or 90 s pass) and push ONE
/// `tx_settled` event in the exact shape the JS watcher pushed, so
/// `note_failed_settlement` ledgers a failure and the board shows it.
fn spawn_settlement_watch(app: tauri::AppHandle, base: String, hash: String, type_url: String, signer: String) {
    tokio::spawn(async move {
        let started = now_ms();
        let push = |status: &str, code: Option<i64>, height: Option<u64>, raw_log: Option<String>, error: Option<String>| {
            let app = app.clone();
            let ev = super::event_buffer::GameEvent {
                category: "tx_settled".to_string(),
                subject: format!("{type_url} {signer}"),
                detail: json!({
                    "action": type_url, "status": status, "code": code, "transactionHash": hash,
                    "height": height, "error": error, "rawLog": raw_log, "signer": signer,
                    "async": true, "native": true,
                }),
                timestamp: now_ms(),
            };
            async move {
                let _ = super::event_buffer::push_game_event(app, ev).await;
            }
        };
        loop {
            tokio::time::sleep(Duration::from_millis(SETTLE_POLL_MS)).await;
            match lookup_tx(&base, &hash).await {
                Ok(Some((code, height, raw_log))) => {
                    let ok = code == 0;
                    let err = if ok { None } else { Some(if raw_log.is_empty() { format!("code {code}") } else { raw_log.clone() }) };
                    push(if ok { "succeeded" } else { "dropped" }, Some(code), Some(height), Some(raw_log), err).await;
                    return;
                }
                Ok(None) => {}
                Err(e) => {
                    if now_ms() - started > SETTLE_TIMEOUT_MS as f64 {
                        push("dropped", None, None, None, Some(format!("tx lookup failed: {e}"))).await;
                        return;
                    }
                }
            }
            if now_ms() - started > SETTLE_TIMEOUT_MS as f64 {
                push("dropped", None, None, None, Some("not in a block after 90s".to_string())).await;
                return;
            }
        }
    });
}

/// Sign `payload` as HD index `index` and broadcast it. Same result shape and
/// error wording as the JS façade's `signAndBroadcastAs`.
pub async fn sign(
    app: &tauri::AppHandle,
    index: u32,
    type_url: &str,
    payload: Value,
    async_mode: bool,
) -> Result<Value, String> {
    // Same per-account lock the JS bridge takes, so the two paths serialise.
    let _acct_guard = super::vplayer_bridge::account_lock(index as i64).lock_owned().await;
    let _permit = NATIVE_GATE.acquire().await.map_err(|_| "native signing gate closed".to_string())?;

    let base = super::cosmos_client::reactor_api_base();
    let chain = chain_id(&base).await?;
    let address = address(index)?;
    let acct = account_state(&base, &address).await?;
    let msg_bytes = super::chain_codec::encode(type_url, &payload, &address)?;
    let tx_bytes = build_signed_tx(index, &chain, acct, type_url, msg_bytes)?;

    let b = match broadcast(&base, &tx_bytes).await {
        Ok(b) => b,
        Err(e) => {
            SIGNS_FAILED.fetch_add(1, Ordering::Relaxed);
            *LAST_ERROR.lock().unwrap() = Some(e.clone());
            return Err(e);
        }
    };
    if b.code != 0 {
        on_reject(&address, &b.raw_log);
        SIGNS_FAILED.fetch_add(1, Ordering::Relaxed);
        let err = rejection_error(b.code, &b.codespace, &b.raw_log);
        *LAST_ERROR.lock().unwrap() = Some(err.clone());
        return Err(err);
    }
    // Accepted by the mempool: the account's next sequence is spent whether
    // or not this tx lands; a drop shows up as the chain's "expected N" later.
    bump_sequence(&address);
    SIGNS_OK.fetch_add(1, Ordering::Relaxed);

    if async_mode {
        spawn_settlement_watch(app.clone(), base, b.hash.clone(), type_url.to_string(), address);
        return Ok(json!({
            "code": 0, "transactionHash": b.hash, "height": Value::Null, "rawLog": Value::Null,
            "async": true, "native": true,
        }));
    }
    let (code, height, raw_log) = wait_for_inclusion(&base, &b.hash).await?;
    Ok(json!({
        "code": code, "transactionHash": b.hash, "height": height,
        "rawLog": if raw_log.is_empty() { Value::Null } else { Value::String(raw_log) },
        "native": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway mnemonic; the expected values come from
    /// `structsd keys add --recover --hd-path "m/44'/118'/0'/0/N"`.
    const MNEMONIC: &str = "test test test test test test test test test test test junk";

    #[test]
    fn derives_the_same_addresses_as_structsd() {
        let seed = seed_from_mnemonic(MNEMONIC).unwrap();
        for (index, expected) in [
            (0u32, "structs15yk64u7zc9g9k2yr2wmzeva5qgwxps6yznqgfk"),
            (5, "structs18el2mdgsjwvzezu5cjsyuyx0uru4zrm2ax6xzv"),
            (1234, "structs1fpn38xn3smap4xqhcrrx2sl4vlkd7af3t5va9c"),
        ] {
            assert_eq!(derive(&seed[..], index).unwrap().1, expected, "index {index}");
        }
    }

    #[test]
    fn derives_the_same_public_key_as_structsd() {
        let seed = seed_from_mnemonic(MNEMONIC).unwrap();
        let (key, _) = derive(&seed[..], 5).unwrap();
        let pk = base64::engine::general_purpose::STANDARD.encode(key.public_key().to_bytes());
        assert_eq!(pk, "A3uqIMevMDIwliSqPGF4pMvsTnveRg6dFR86RZBISXIu");
    }

    #[test]
    fn mnemonic_whitespace_and_case_are_normalised() {
        let a = seed_from_mnemonic(MNEMONIC).unwrap();
        let b = seed_from_mnemonic("  Test test\ttest test test test test test test test test JUNK\n").unwrap();
        assert_eq!(&a[..], &b[..]);
        assert!(seed_from_mnemonic("not a mnemonic at all").is_err());
    }

    #[test]
    fn signed_tx_round_trips_through_cosmrs() {
        let seed = seed_from_mnemonic(MNEMONIC).unwrap();
        let acct = AccountState { number: 368, sequence: 2238 };
        let msg = super::super::chain_codec::encode(
            "/structs.structs.MsgStructActivate",
            &json!({ "structId": "1-5" }),
            "structs18el2mdgsjwvzezu5cjsyuyx0uru4zrm2ax6xzv",
        )
        .unwrap();
        let (bytes, address) =
            sign_tx_with(&seed[..], 5, "structstestnet-111", acct, "/structs.structs.MsgStructActivate", msg.clone()).unwrap();
        assert_eq!(address, "structs18el2mdgsjwvzezu5cjsyuyx0uru4zrm2ax6xzv");
        let tx = cosmrs::tx::Tx::from_bytes(&bytes).unwrap();
        assert_eq!(tx.signatures.len(), 1);
        assert_eq!(tx.signatures[0].len(), 64, "secp256k1 signatures are 64 raw bytes");
        assert_eq!(tx.body.messages.len(), 1);
        assert_eq!(tx.body.messages[0].type_url, "/structs.structs.MsgStructActivate");
        assert_eq!(tx.body.messages[0].value, msg);
        assert_eq!(tx.auth_info.signer_infos[0].sequence, 2238);
        assert_eq!(tx.auth_info.fee.gas_limit, GAS_LIMIT);
        assert_eq!(tx.auth_info.fee.amount[0].amount, 0);
    }

    #[test]
    fn expected_sequence_is_read_from_the_chain_message() {
        assert_eq!(
            parse_expected_sequence("account sequence mismatch, expected 2239, got 2238: incorrect account sequence"),
            Some(2239)
        );
        assert_eq!(parse_expected_sequence("failed to execute message; insufficient charge"), None);
        assert_eq!(parse_expected_sequence("expected 7 things"), None, "only account-sequence messages count");
    }

    #[test]
    fn rejection_keeps_the_cosmjs_vocabulary_the_classifier_expects() {
        let e = rejection_error(32, "sdk", "account sequence mismatch, expected 5, got 4");
        assert!(e.starts_with("Broadcasting transaction failed with code 32 (codespace: sdk). Log: "), "{e}");
        assert!(e.contains("account sequence"));
    }

    /// Network: `cargo test native_signer -- --ignored`. Exercises the two
    /// LCD reads the signer depends on against the public testnet.
    #[test]
    #[ignore]
    fn live_chain_id_and_account_lookup() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let base = "https://public.testnet.structs.network";
            let id = chain_id(base).await.unwrap();
            assert!(id.starts_with("structs"), "chain id {id}");
            let a = account_state(base, "structs12qzl4ndjyuhgzggugmg46c3dtqycy7gcjjgqc6").await.unwrap();
            assert!(a.number > 0 && a.sequence > 0, "{a:?}");
            // An address that has never been seen is a clean error, not a panic.
            let e = account_state(base, "structs15yk64u7zc9g9k2yr2wmzeva5qgwxps6yznqgfk").await.unwrap_err();
            assert!(e.contains("account lookup"), "{e}");
        });
    }

    #[test]
    fn account_parsing_handles_base_and_nested_accounts() {
        let base = json!({"account": {"@type": "/cosmos.auth.v1beta1.BaseAccount", "account_number": "368", "sequence": "2238"}});
        let a = parse_account(&base).unwrap();
        assert_eq!((a.number, a.sequence), (368, 2238));
        let nested = json!({"account": {"base_account": {"account_number": "9", "sequence": 3}}});
        let b = parse_account(&nested).unwrap();
        assert_eq!((b.number, b.sequence), (9, 3));
        assert!(parse_account(&json!({"code": 5})).is_none());
    }
}
