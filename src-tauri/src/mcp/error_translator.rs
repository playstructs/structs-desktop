/// Translate opaque chain error messages into actionable human-readable messages.
pub fn translate_error(error: &str) -> String {
    let lower = error.to_lowercase();

    // Sequence mismatch
    if lower.contains("account sequence mismatch") {
        return "Transaction sequence mismatch — another transaction is pending. Wait ~6 seconds and retry.".to_string();
    }

    // Insufficient funds
    if lower.contains("insufficient funds") {
        return format!("Insufficient funds. Check your Alpha Matter balance. Original: {}", error);
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

    // No translation needed
    error.to_string()
}
