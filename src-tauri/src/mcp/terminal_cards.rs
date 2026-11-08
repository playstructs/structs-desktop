//! Installed third-party Terminal cards, and the one door they get.
//!
//! An installed card is a single HTML document the player chose to add. The
//! Terminal draws it in `<iframe sandbox="allow-scripts" srcdoc=…>` — no
//! `allow-same-origin`, so the card runs in an opaque origin: it cannot read
//! the board's DOM or storage, cannot reach the Tauri bridge, and cannot
//! sign. Its only way to the app is `postMessage`, and the board answers only
//! the read-only mirror queries listed in [`QUERIES`] through
//! [`mirror_card_query`]. Nothing a card sends can act, approve or change a
//! setting.

use std::collections::BTreeMap;

use serde_json::Value;

const FILE: &str = "terminal_cards.json";
/// The most a card document may weigh.
pub const MAX_BYTES: usize = 256 * 1024;
/// What an installed card may ask the mirror. All read-only.
pub const QUERIES: &[&str] = &["forecast", "chronicle", "lab", "backtest", "preview"];

fn store() -> BTreeMap<String, String> {
    crate::mcp::config_store::load_config::<BTreeMap<String, String>>(FILE)
}

/// A card name: lowercase letters, digits, `-` or `_`, 1–32 characters. Pure.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Whether a card's query is one it may make. A plan preview can ask the
/// human to approve something, so only single-action previews pass. Pure.
pub fn allowed(query: &str, args: &Value) -> bool {
    QUERIES.contains(&query) && !(query == "preview" && (args.get("action").and_then(|a| a.as_str()) == Some("plan") || args.get("ask_approval").is_some()))
}

#[tauri::command]
pub fn terminal_card_install(window: tauri::WebviewWindow, name: String, html: String) -> Result<Vec<String>, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    if !valid_name(&name) {
        return Err("a card name is 1–32 lowercase letters, digits, - or _".into());
    }
    if html.len() > MAX_BYTES {
        return Err(format!("a card is at most {} KB", MAX_BYTES / 1024));
    }
    let mut s = store();
    s.insert(name, html);
    crate::mcp::config_store::save_config(FILE, &s);
    Ok(s.into_keys().collect())
}

#[tauri::command]
pub fn terminal_card_remove(window: tauri::WebviewWindow, name: String) -> Result<Vec<String>, String> {
    crate::mcp::tools::board_pages::require_trusted(&window)?;
    let mut s = store();
    s.remove(&name);
    crate::mcp::config_store::save_config(FILE, &s);
    Ok(s.into_keys().collect())
}

#[tauri::command]
pub fn terminal_card_list() -> Vec<String> {
    store().into_keys().collect()
}

#[tauri::command]
pub fn terminal_card_get(name: String) -> Result<String, String> {
    store().remove(&name).ok_or_else(|| format!("no installed card '{name}'"))
}

/// The only thing an installed card can ask for: a read-only mirror query,
/// answered as text.
#[tauri::command]
pub async fn mirror_card_query(query: String, args: Value) -> Result<String, String> {
    if !allowed(&query, &args) {
        return Err(format!("an installed card may ask only: {}", QUERIES.join(", ")));
    }
    Ok(match query.as_str() {
        "forecast" => crate::mirror::report::intel(&crate::mcp::cosmos_client::CosmosClient::new(), &args).await,
        "chronicle" => crate::mirror::report::chronicle_intel(&args).await,
        "lab" => crate::mirror::report::lab_intel(&args),
        "backtest" => crate::mirror::report::backtest_intel(&args).await,
        "preview" => crate::mirror::report::preview_intel(&args),
        _ => unreachable!("allowed() checked"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_are_plain() {
        assert!(valid_name("my-card_2"));
        assert!(!valid_name(""));
        assert!(!valid_name("../evil"));
        assert!(!valid_name("Caps"));
        assert!(!valid_name(&"x".repeat(33)));
    }

    #[test]
    fn a_card_may_read_but_never_ask_for_approval() {
        assert!(allowed("forecast", &json!({})));
        assert!(allowed("preview", &json!({"action": "fleet_move", "args": {}})));
        assert!(!allowed("preview", &json!({"action": "plan", "steps": []})));
        assert!(!allowed("preview", &json!({"action": "fleet_move", "ask_approval": true})));
        assert!(!allowed("query", &json!({})), "raw entity reads are not on the list");
        assert!(!allowed("verify_bundle", &json!({})));
    }
}
