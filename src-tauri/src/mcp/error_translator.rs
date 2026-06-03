/// Translate opaque chain error messages into actionable human-readable messages.
pub fn translate_error(error: &str) -> String {
    let lower = error.to_lowercase();

    // Sequence mismatch
    if lower.contains("account sequence mismatch") {
        return "Transaction sequence mismatch — another transaction is pending. Wait ~6 seconds and retry.".to_string();
    }

    // Insufficient funds (code 2)
    if lower.contains("insufficient funds") || lower.contains("code 2:") {
        return format!("Insufficient funds. Check your Alpha Matter balance. Original: {}", error);
    }

    // Invalid signature (code 3)
    if lower.contains("invalid signature") || lower.contains("code 3:") {
        return "Invalid signature — the transaction signature was rejected. Retry; if it persists the signing key or account sequence may be wrong.".to_string();
    }

    // Insufficient gas (code 4)
    if lower.contains("code 4:") {
        return "Insufficient gas — raise the gas limit (use --gas auto with a higher --gas-adjustment).".to_string();
    }

    // Invalid message (code 5)
    if lower.contains("invalid message") || lower.contains("code 5:") {
        return format!("Invalid message — the transaction was malformed or not permitted in this state. Original: {}", error);
    }

    // Player halted (offline)
    if lower.contains("player halted") || lower.contains("code 6") {
        return "Player is OFFLINE (power load exceeds capacity). Deactivate structs or increase power before any other action.".to_string();
    }

    // Insufficient charge
    if lower.contains("insufficient charge") || lower.contains("code 7") {
        return "Insufficient charge. Wait for charge to accumulate (1 per block, ~6 seconds each).".to_string();
    }

    // Invalid location
    if lower.contains("invalid location") || lower.contains("code 8") {
        return "Invalid location — the target slot or ambit is not valid for this action.".to_string();
    }

    // Invalid target
    if lower.contains("invalid target") || lower.contains("code 9") {
        return "Invalid target — check ambit targeting rules. This weapon may not reach that ambit.".to_string();
    }

    // Object not found
    if lower.contains("not found") && lower.contains("unbonding") {
        return "Unbonding complete — tokens have been returned to your wallet.".to_string();
    }
    if lower.contains("object not found") || lower.contains("code 1900") {
        return format!("Object not found — it may have been destroyed or doesn't exist. Original: {}", error);
    }

    // Gas estimation failed
    if lower.contains("gas") && lower.contains("insufficient") {
        return "Gas estimation failed — the transaction may be invalid or require more gas.".to_string();
    }

    // Out of gas
    if lower.contains("out of gas") {
        return "Transaction ran out of gas. Try with higher gas limit.".to_string();
    }

    // Generic not found
    if lower.contains("not found") {
        return format!("Resource not found. It may not exist yet or was destroyed. Original: {}", error);
    }

    // General chain error (code 1) — checked after the specific codes above.
    if lower.contains("code 1:") {
        return format!("Chain rejected the transaction (general error). Original: {}", error);
    }

    // ── Guild API error shapes (Symfony backend) ──

    // Auth required (recognized in guild_api.rs but may also flow through here).
    if lower.contains("guild api requires login") || lower.contains("authentication_error")
        || lower.contains("login required")
    {
        return "Guild API requires login. Sign in to the Structs app, then retry — the MCP shares the webview's session.".to_string();
    }

    // Connection/network failures to Guild API.
    if lower.contains("guild api http error") || lower.contains("guild api read error") {
        return "Guild API unreachable. Check your network or the configured guild_api URL in settings.".to_string();
    }

    // 404 / 500 envelope from Guild API.
    if lower.contains("guild api 404") {
        return "Guild API: resource not found (the ID may not exist or the index isn't built yet).".to_string();
    }
    if lower.contains("guild api 5") {
        return format!("Guild API server error. The backend may be overloaded. Original: {}", error);
    }

    // No translation needed
    error.to_string()
}
