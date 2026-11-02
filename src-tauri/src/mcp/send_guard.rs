//! Guardrails for outbound token sends (`MsgVaultSend`, and the remaining
//! `MsgPlayerSend` / `bank_send` paths).
//!
//! v0.22 (2026-10-30): liquid Alpha and guild tokens live in a per-owner
//! protocol VAULT (`/structs/vault/{ownerId}`), not at any signing address.
//! Alpha moves vault→vault with `MsgVaultSend{ownerId, recipientOwnerId}` —
//! both ends are OWNER IDS the chain resolves itself, so the address-burn
//! failure below cannot happen on that path. [`validate_vault_send`] guards
//! it; the address checks remain for `MsgPlayerSend` (retained address
//! balances, vault→signing-key funding). The history is kept because it is
//! why every send still passes a validator on the exact signed strings.
//!
//! ROOT CAUSE (2026-08-24, external player report — alpha swept "to nobody"):
//! the sweep destination was `GAME_STATE.wallet_address`, which the sync
//! script fills from the webapp's `gameState.signingAccount.address` — the
//! address of the LOCAL SIGNING KEY, not the player's on-chain primary
//! address. Those coincide only when the account was CREATED on this install
//! (signup sets primary_address = signingAccount.address). A player who
//! activated the desktop app as a SECOND DEVICE signs with a freshly
//! generated device key: a valid, registered address that no player record
//! counts balance at — the chain reads a player's alpha exclusively from
//! `player.primaryAddress` (keeper/player_cache.go). Auto-sweep then drained
//! every worker to an address the game resolves to no player: a null
//! counterparty, alpha invisible in-game.
//!
//! The chain accepts the bad send: `PlayerSend` validates `FromAddress` but
//! DISCARDS the bech32 error on `ToAddress` (`toAcc, _ :=
//! AccAddressFromBech32(...)`) and never checks the destination maps to a
//! player, so even an EMPTY destination passes and the coins land at the
//! empty address — unrecoverable.
//!
//! Policy: NO SEND IS BETTER THAN A BAD SEND.
//!   * The sweep destination comes from the CHAIN — `player.primaryAddress`
//!     for our own player id, read over LCD and cached briefly. The local
//!     signing address is never trusted as a destination; a mismatch is
//!     logged loudly (it is exactly the second-device signature).
//!   * Every send payload passes `validate_send` on the exact strings that
//!     will be signed. Anything unverifiable is refused, counted, and logged
//!     — never "sent and hoped".

use std::sync::{LazyLock, Mutex};

use crate::hasher::types::now_millis;
use crate::mcp::telemetry::{tlog, Sev};

/// How long a chain-verified destination stays fresh.
const VERIFY_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;
/// How long a previously verified destination may serve while the LCD is
/// unreachable. Beyond this we refuse: primary addresses CAN rotate
/// (`MsgPlayerUpdatePrimaryAddress` moves the balance with it), so an
/// arbitrarily stale one is no longer a safe target.
const VERIFY_STALE_MAX_MS: f64 = 60.0 * 60.0 * 1000.0;

#[derive(Clone)]
struct Verified {
    player_id: String,
    address: String,
    at_ms: f64,
}

static VERIFIED: LazyLock<Mutex<Option<Verified>>> = LazyLock::new(|| Mutex::new(None));
/// Dedup for the mismatch warning — once per (local, chain) pair, not per scan.
static WARNED_MISMATCH: LazyLock<Mutex<Option<(String, String)>>> =
    LazyLock::new(|| Mutex::new(None));

fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ── Address / payload validation ─────────────────────────────────────────────

/// Bech32 data alphabet (no '1', 'b', 'i', 'o').
const BECH32_CHARSET: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// Cheap structural check on a chain address: catches the failure classes we
/// have actually seen reach a signer — empty strings, JS `String(null)` /
/// `String(undefined)` artifacts, wrong-chain prefixes, and truncated or
/// mangled bech32. Not a checksum; the chain still has the final word on a
/// well-shaped typo.
pub fn validate_addr(label: &str, addr: &str) -> Result<(), String> {
    let a = addr.trim();
    if a.is_empty() {
        return Err(format!("{label} address is empty"));
    }
    if a.eq_ignore_ascii_case("null") || a.eq_ignore_ascii_case("undefined") {
        return Err(format!("{label} address is the literal string '{a}' — a serialization bug upstream"));
    }
    let Some(data) = a.strip_prefix("structs1") else {
        return Err(format!("{label} address '{a}' is not a structs1… address"));
    };
    // 20-byte account = 38 data chars; allow up to 32-byte (58) plus slack.
    if data.len() < 38 || data.len() > 80 {
        return Err(format!("{label} address '{a}' has implausible length {}", a.len()));
    }
    if let Some(bad) = data.chars().find(|c| !BECH32_CHARSET.contains(*c)) {
        return Err(format!("{label} address '{a}' contains invalid character '{bad}'"));
    }
    Ok(())
}

/// Validate the exact strings a `MsgPlayerSend` will be built from. Refusing
/// here is the last line of defence for every sweep/transfer path.
pub fn validate_send(from: &str, to: &str, amount_ualpha: &str) -> Result<(), String> {
    validate_addr("sender", from)?;
    validate_addr("destination", to)?;
    if from.trim() == to.trim() {
        return Err("sender and destination are the same address".into());
    }
    match amount_ualpha.trim().parse::<u128>() {
        Ok(0) => Err("amount is zero".into()),
        Ok(_) => Ok(()),
        Err(_) => Err(format!("amount '{amount_ualpha}' is not a positive integer")),
    }
}

/// Structural check on an owner id: a player (`1-N`) or guild (`0-N`) — the
/// only owners that have vaults. Anything else is a caller bug.
pub fn validate_owner_id(label: &str, id: &str) -> Result<(), String> {
    let t = id.trim();
    let ok = t.split_once('-').is_some_and(|(kind, n)| {
        matches!(kind, "0" | "1") && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
    });
    if ok {
        Ok(())
    } else {
        Err(format!("{label} '{t}' is not a player (1-N) or guild (0-N) id"))
    }
}

/// Validate the exact strings a `MsgVaultSend` will be built from.
pub fn validate_vault_send(from_owner: &str, to_owner: &str, amount: &str) -> Result<(), String> {
    validate_owner_id("source owner", from_owner)?;
    validate_owner_id("recipient owner", to_owner)?;
    if from_owner.trim() == to_owner.trim() {
        return Err("source and recipient are the same owner".into());
    }
    match amount.trim().parse::<u128>() {
        Ok(0) => Err("amount is zero".into()),
        Ok(_) => Ok(()),
        Err(_) => Err(format!("amount '{amount}' is not a positive integer")),
    }
}

/// `MsgVaultSend` payload: `amount` of `denom` from `from_owner`'s vault to
/// `to_owner`'s. Validated first — never returns a payload it would refuse.
pub fn vault_send_payload(from_owner: &str, to_owner: &str, denom: &str, amount: &str) -> Result<serde_json::Value, String> {
    validate_vault_send(from_owner, to_owner, amount)?;
    if denom.trim().is_empty() {
        return Err("denom is empty".into());
    }
    Ok(serde_json::json!({
        "ownerId": from_owner.trim(),
        "recipientOwnerId": to_owner.trim(),
        "amount": [{ "denom": denom.trim(), "amount": amount.trim() }],
    }))
}

/// True when a chain rejection means "the money is not there" — the bank
/// error for both PlayerSend and VaultSend.
pub fn is_insufficient_funds(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("insufficient funds") || (e.contains("spendable balance") && e.contains("smaller than"))
}

// ── Chain-verified sweep destination ─────────────────────────────────────────

/// Pure decision: given the chain's `primaryAddress` and the local signing
/// address, pick the destination. The chain always wins; a mismatch is the
/// second-device signature and is surfaced by the caller.
fn pick_destination(chain_primary: &str, local_addr: &str) -> Result<(String, bool), String> {
    validate_addr("chain primary", chain_primary)
        .map_err(|e| format!("chain returned an unusable primaryAddress: {e}"))?;
    Ok((chain_primary.trim().to_string(), chain_primary.trim() != local_addr.trim()))
}

async fn fetch_chain_primary(player_id: &str) -> Result<String, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let v = client.query_entity("player", player_id).await?;
    v.get("Player")
        .and_then(|p| p.get("primaryAddress"))
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("player {player_id} record has no primaryAddress field"))
}

/// The ONLY approved way to pick the funnel-to-primary destination.
///
/// Resolves our player id from GAME_STATE, reads that player's
/// `primaryAddress` from the chain (cached for [`VERIFY_TTL_MS`]), and
/// returns `(address, player_id)`. The locally synced `wallet_address` is
/// used only as a cross-check: when it differs from the chain primary — the
/// second-device case that burned a player's alpha — the chain address is
/// used and a warning is logged. If the chain cannot be consulted and the
/// cache is older than [`VERIFY_STALE_MAX_MS`], this refuses: no sweep is
/// better than a bad sweep.
pub async fn verified_primary_send_target() -> Result<(String, String), String> {
    let (local_addr, player_id) = {
        let gs = crate::game_state::GAME_STATE
            .read()
            .unwrap_or_else(|e| e.into_inner());
        (
            gs.wallet_address.clone().unwrap_or_default(),
            gs.player_id.clone().unwrap_or_default(),
        )
    };
    if player_id.is_empty() {
        return Err("player id not synced yet — cannot verify a sweep destination".into());
    }

    let now = now_millis();
    if let Some(v) = lock_recover(&VERIFIED).clone() {
        if v.player_id == player_id && now - v.at_ms < VERIFY_TTL_MS {
            return Ok((v.address, player_id));
        }
    }

    match fetch_chain_primary(&player_id).await {
        Ok(chain_primary) => {
            let (dest, mismatch) = pick_destination(&chain_primary, &local_addr)?;
            if mismatch {
                let pair = (local_addr.clone(), dest.clone());
                let mut warned = lock_recover(&WARNED_MISMATCH);
                if warned.as_ref() != Some(&pair) {
                    tlog(
                        "send_guard",
                        Sev::Warn,
                        format!(
                            "local signing address {local_addr} is NOT player {player_id}'s on-chain \
                             primary address {dest} (second-device install?) — sweeps go to the \
                             chain-verified primary, where the player's balance actually lives"
                        ),
                    );
                    *warned = Some(pair);
                }
            }
            *lock_recover(&VERIFIED) = Some(Verified {
                player_id: player_id.clone(),
                address: dest.clone(),
                at_ms: now,
            });
            Ok((dest, player_id))
        }
        Err(e) => {
            if let Some(v) = lock_recover(&VERIFIED).clone() {
                if v.player_id == player_id && now - v.at_ms < VERIFY_STALE_MAX_MS {
                    tlog(
                        "send_guard",
                        Sev::Notice,
                        format!("LCD unreachable ({e}); using destination verified {:.0}s ago", (now - v.at_ms) / 1000.0),
                    );
                    return Ok((v.address, player_id));
                }
            }
            Err(format!(
                "cannot verify player {player_id}'s primary address on-chain ({e}) — refusing to \
                 pick a sweep destination"
            ))
        }
    }
}

/// The primary's OWNER id as a vault-send recipient, verified to exist on
/// chain (same cache and refusal rules as [`verified_primary_send_target`]).
pub async fn verified_primary_owner() -> Result<String, String> {
    verified_primary_send_target().await.map(|(_, pid)| pid)
}

/// Pure part of [`resolve_recipient_owner`]: is `to` an owner id (returned
/// as-is), an address (`Ok(None)` — needs a chain lookup), or neither?
fn classify_recipient(to: &str) -> Result<Option<String>, String> {
    let t = to.trim();
    if validate_owner_id("recipient", t).is_ok() {
        return Ok(Some(t.to_string()));
    }
    validate_addr("recipient", t).map_err(|_| {
        format!("recipient '{t}' is neither a player/guild id nor a structs1… address")
    })?;
    Ok(None)
}

/// Turn a payment destination — a player id, a guild id, or a player's
/// REGISTERED signing address — into the owner id a `MsgVaultSend` needs,
/// confirmed on chain. Any other address (a vault, a module, an outside
/// wallet) is refused: there is no owner to send to, and guessing one is how
/// Alpha gets lost.
pub async fn resolve_recipient_owner(to: &str) -> Result<String, String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    match classify_recipient(to)? {
        Some(owner) => {
            let kind = if owner.starts_with("0-") { "guild" } else { "player" };
            client
                .query_entity(kind, &owner)
                .await
                .map_err(|e| format!("recipient {owner} could not be confirmed on chain: {e}"))?;
            Ok(owner)
        }
        None => client
            .address_player(to.trim())
            .await
            .map_err(|e| format!("could not look up recipient address {}: {e}", to.trim()))?
            .ok_or_else(|| {
                format!(
                    "{} is not a registered player address — send to a player or guild id instead",
                    to.trim()
                )
            }),
    }
}

/// Structs permission bits the signing key needs for asset operations
/// (`x/structs/types` permission enum; also `tools/format::decode_permissions`).
pub mod perm {
    pub const TOKEN_TRANSFER: u64 = 1 << 4;
    pub const TOKEN_INFUSE: u64 = 1 << 5;
    pub const TOKEN_MIGRATE: u64 = 1 << 6;
    pub const TOKEN_DEFUSE: u64 = 1 << 7;
    pub const GUILD_MEMBERSHIP: u64 = 1 << 9;
}

/// Pure: does a key with `held` bits lack `need`? Names the missing bit.
pub fn missing_key_bit(held: u64, need: u64, label: &str) -> Option<String> {
    (held & need != need).then(|| {
        format!("this signing key does not hold {label} permission, which v0.22 requires of the key itself")
    })
}

/// The signing key's own permission check for an asset operation. `None`
/// when it holds the bit OR the chain could not be asked (the chain still has
/// the last word; a failed read must not block a send).
pub async fn signer_lacks(address: &str, need: u64, label: &str) -> Option<String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    match client.address_record(address).await {
        Ok((_, held)) => missing_key_bit(held, need, label),
        Err(_) => None,
    }
}

/// Test/ops hook: forget the verified destination (e.g. after a guild or
/// account switch the next resolution must re-read the chain).
pub fn invalidate() {
    *lock_recover(&VERIFIED) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "structs1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf";

    #[test]
    fn accepts_a_plausible_address() {
        assert!(validate_addr("t", GOOD).is_ok());
    }

    /// The exact artifacts that have reached signers in the wild: an Option
    /// serialized to null, a missing JS field stringified, an empty default.
    #[test]
    fn rejects_the_known_bad_shapes() {
        for bad in ["", "  ", "null", "NULL", "undefined", "Undefined"] {
            assert!(validate_addr("t", bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn rejects_wrong_chain_and_mangled_bech32() {
        // Wrong prefix (a cosmos address is NOT a structs address).
        assert!(validate_addr("t", "cosmos1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9").is_err());
        // Truncated.
        assert!(validate_addr("t", "structs1qpzry").is_err());
        // 'b' is outside the bech32 data alphabet.
        assert!(validate_addr("t", "structs1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").is_err());
    }

    #[test]
    fn validate_send_refuses_self_zero_and_junk_amounts() {
        let other = "structs1qpzry9x8gf2tvdw0s3jn54khce6mua7l0s3jn54kh";
        assert!(validate_send(GOOD, other, "1000000").is_ok());
        assert!(validate_send(GOOD, GOOD, "1000000").is_err(), "self-send");
        assert!(validate_send(GOOD, other, "0").is_err(), "zero");
        assert!(validate_send(GOOD, other, "-5").is_err(), "negative");
        assert!(validate_send(GOOD, other, "1.5").is_err(), "fractional");
        assert!(validate_send(GOOD, other, "1000000ualpha").is_err(), "denom-suffixed");
    }

    #[test]
    fn owner_ids_are_players_or_guilds_only() {
        for good in ["1-194", "0-5", " 1-12 "] {
            assert!(validate_owner_id("t", good).is_ok(), "{good:?}");
        }
        for bad in ["", "null", "2-223", "1-", "-5", "1-1x", "structs1abc", "1-1-1"] {
            assert!(validate_owner_id("t", bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn vault_send_refuses_self_zero_and_junk() {
        assert!(validate_vault_send("1-271", "1-194", "1000000").is_ok());
        assert!(validate_vault_send("1-194", "1-194", "1000000").is_err(), "self-send");
        assert!(validate_vault_send("1-271", "1-194", "0").is_err(), "zero");
        assert!(validate_vault_send("1-271", "1-194", "1.5").is_err(), "fractional");
        assert!(validate_vault_send("structs1x", "1-194", "1").is_err(), "address as owner");
        let p = vault_send_payload("1-271", "0-5", "ualpha", "7").unwrap();
        assert_eq!(p["recipientOwnerId"], "0-5");
        assert_eq!(p["amount"][0]["amount"], "7");
        assert!(vault_send_payload("1-271", "0-5", " ", "7").is_err());
    }

    #[test]
    fn recipients_are_owner_ids_or_addresses() {
        assert_eq!(classify_recipient(" 1-194 ").unwrap(), Some("1-194".into()));
        assert_eq!(classify_recipient("0-5").unwrap(), Some("0-5".into()));
        assert_eq!(classify_recipient(GOOD).unwrap(), None);
        assert!(classify_recipient("2-223").is_err());
        assert!(classify_recipient("").is_err());
        assert!(classify_recipient("null").is_err());
    }

    #[test]
    fn key_bits_are_checked_whole() {
        // 1-194's device key on chain: 33554431 = all 25 bits.
        assert!(missing_key_bit(33_554_431, perm::TOKEN_TRANSFER, "token-transfer").is_none());
        assert!(missing_key_bit(1, perm::TOKEN_TRANSFER, "token-transfer").is_some(), "play-only key");
        assert!(missing_key_bit(perm::TOKEN_INFUSE, perm::TOKEN_INFUSE | perm::TOKEN_DEFUSE, "x").is_some());
    }

    #[test]
    fn insufficient_funds_matches_both_bank_phrasings() {
        assert!(is_insufficient_funds("spendable balance 0ualpha is smaller than 1000000ualpha: insufficient funds"));
        assert!(is_insufficient_funds("spendable balance 0ualpha is smaller than 1000000ualpha"));
        assert!(!is_insufficient_funds("account sequence mismatch"));
    }

    /// The chain's answer always wins over the local signing address — that
    /// asymmetry IS the fix for the second-device burn.
    #[test]
    fn chain_primary_wins_and_mismatch_is_flagged() {
        let chain = GOOD;
        let local = "structs1qpzry9x8gf2tvdw0s3jn54khce6mua7l0s3jn54kh";
        let (dest, mismatch) = pick_destination(chain, local).unwrap();
        assert_eq!(dest, chain);
        assert!(mismatch);
        let (dest2, mismatch2) = pick_destination(chain, chain).unwrap();
        assert_eq!(dest2, chain);
        assert!(!mismatch2);
    }

    /// An unusable chain answer refuses rather than falling back to the local
    /// signing address — the local address is what burned the alpha.
    #[test]
    fn unusable_chain_primary_refuses() {
        assert!(pick_destination("", GOOD).is_err());
        assert!(pick_destination("null", GOOD).is_err());
    }
}
