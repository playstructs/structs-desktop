//! Founder contexts: the accounts that hold guilds for other communities.
//!
//! A founder is a replicant made by the founding plan (`guild_founding.rs`,
//! `founder: "new"`): its own player, address and HD index, role `Founder`,
//! no planet, never touched by a loop. Each carries a LABEL — a short name a
//! project picks when it founds ("acme-guild") — so that project can come
//! back later and work as that founder, on that founder's guild, without
//! knowing its player id or touching the primary or the bot fleet.
//!
//! `Signer` is who signs an admin action: the primary (HD 0) or a founder.
//! The guild, substation, provider and treasury modules take one, so every
//! preview checks the founder's own key and standing, and every execute
//! signs with the founder's key.

use serde_json::{json, Value};

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::virtual_players::{VPlayerRole, VirtualPlayer, REGISTRY};

/// Who signs: the primary (index 0, no label) or a founder.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Signer {
    pub index: u32,
    pub player_id: String,
    pub address: String,
    pub label: String,
}

impl Signer {
    /// The signed-in primary.
    pub fn primary() -> Result<Signer, String> {
        let gs = crate::game_state::GAME_STATE.read().map_err(|e| e.to_string())?;
        let player_id = gs.player_id.clone().unwrap_or_default();
        let address = gs.wallet_address.clone().unwrap_or_default();
        if player_id.is_empty() || address.is_empty() {
            return Err("primary identity not synced yet".into());
        }
        Ok(Signer { index: 0, player_id, address, label: String::new() })
    }

    pub fn is_primary(&self) -> bool {
        self.index == 0
    }

    /// How a reply names the signer.
    pub fn who(&self) -> String {
        if self.is_primary() {
            format!("primary {}", self.player_id)
        } else {
            format!("founder '{}' ({})", self.label, self.player_id)
        }
    }

    pub fn describe(&self) -> Value {
        json!({
            "as": if self.is_primary() { "primary" } else { self.label.as_str() },
            "player_id": self.player_id,
            "address": self.address,
            "founder": !self.is_primary(),
        })
    }
}

/// Words that already mean something where a label is accepted.
const RESERVED: &[&str] = &["primary", "you", "me", "new", "none", "all"];

/// A label as stored: trimmed and lower-cased.
pub fn normalize_label(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

/// Why `label` (normalized) cannot name a founder, if it cannot. 2-32 of
/// a-z 0-9 `-` `_` `.`, starting with a letter — so it never reads as a
/// player id, an HD index or an address.
pub fn label_refusal(label: &str) -> Option<String> {
    let n = label.chars().count();
    if !(2..=32).contains(&n) {
        return Some("a label is 2-32 characters".into());
    }
    if !label.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
        return Some("a label starts with a letter".into());
    }
    if !label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-_.".contains(c)) {
        return Some("a label is letters, digits, '-', '_' or '.'".into());
    }
    if label.starts_with("structs1") {
        return Some("a label cannot look like an address".into());
    }
    if RESERVED.contains(&label) {
        return Some(format!("'{label}' is reserved"));
    }
    None
}

/// Pure: the founder row `key` names — by label first, then by player id,
/// address or HD index. A bot (any other role) is refused by name, so an
/// admin action can never be signed by a fleet player by mistake.
pub fn find_founder<'a>(rows: &'a [VirtualPlayer], key: &str) -> Result<&'a VirtualPlayer, String> {
    let k = normalize_label(key);
    if let Some(v) = rows.iter().find(|p| p.role == VPlayerRole::Founder && p.label.as_deref() == Some(k.as_str())) {
        return Ok(v);
    }
    let raw = key.trim();
    let by_id = rows.iter().find(|p| p.player_id.as_deref() == Some(raw) || p.address == raw || p.index.to_string() == raw);
    match by_id {
        Some(v) if v.role == VPlayerRole::Founder => Ok(v),
        Some(v) => Err(format!("{raw} is {} — a {} in your fleet, not a founder", v.name, v.role.as_str())),
        None => Err(format!("no founder labelled '{k}' (structs_action founder {{op:\"list\"}} names them)")),
    }
}

/// The signer `key` names: none, "", "primary" or "you" → the primary;
/// anything else → that founder.
pub fn resolve(key: Option<&str>) -> Result<Signer, String> {
    let k = key.map(str::trim).unwrap_or("");
    if k.is_empty() || matches!(normalize_label(k).as_str(), "primary" | "you" | "me") {
        return Signer::primary();
    }
    let reg = REGISTRY.read().map_err(|e| e.to_string())?;
    let v = find_founder(&reg.players, k)?;
    let player_id = v.player_id.clone().filter(|p| !p.is_empty()).ok_or_else(|| format!("founder {} has no player id yet; try again in a minute", v.name))?;
    Ok(Signer { index: v.index, player_id, address: v.address.clone(), label: v.label.clone().unwrap_or_default() })
}

/// The signer named by `args.as` (or `args.founder`), defaulting to the
/// primary.
pub fn signer_from_args(args: &Value) -> Result<Signer, String> {
    let key = ["as", "founder"].iter().find_map(|k| args.get(*k).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()));
    resolve(key)
}

/// Pure: whether `label` is free for the founder at `index` (no OTHER
/// founder carries it).
pub fn label_taken_by(rows: &[VirtualPlayer], label: &str, index: u32) -> Option<String> {
    rows.iter()
        .find(|p| p.role == VPlayerRole::Founder && p.index != index && p.label.as_deref() == Some(label))
        .map(|p| p.player_id.clone().unwrap_or_else(|| p.name.clone()))
}

/// Give the founder at `index` the label `label` (normalized, checked,
/// unique). Writes the registry.
pub fn set_label(index: u32, label: &str) -> Result<(), String> {
    let label = normalize_label(label);
    if let Some(why) = label_refusal(&label) {
        return Err(why);
    }
    let mut reg = REGISTRY.write().map_err(|e| e.to_string())?;
    if let Some(other) = label_taken_by(&reg.players, &label, index) {
        return Err(format!("'{label}' already names founder {other}"));
    }
    let row = reg.players.iter_mut().find(|p| p.index == index).ok_or_else(|| format!("no registry row at index {index}"))?;
    if row.role != VPlayerRole::Founder {
        return Err(format!("{} is a {}, not a founder; only founders take labels", row.name, row.role.as_str()));
    }
    row.label = Some(label);
    reg.save()
}

/// Every founder row (a snapshot of the registry).
pub fn founders() -> Vec<VirtualPlayer> {
    REGISTRY.read().map(|r| r.players.iter().filter(|p| p.role == VPlayerRole::Founder).cloned().collect()).unwrap_or_default()
}

/// Guild id → (name, owner) for every guild owned by one of `owners`.
async fn owned_guilds(client: &CosmosClient, owners: &[String]) -> Vec<(String, String, String)> {
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    client
        .list_all_entities("guild", "Guild")
        .await
        .unwrap_or_default()
        .iter()
        .filter(|g| owners.contains(&s(g, "owner")))
        .map(|g| (s(g, "id"), s(g, "name"), s(g, "owner")))
        .collect()
}

fn row_json(v: &VirtualPlayer, guild: Option<&(String, String, String)>) -> Value {
    let plan = v.label.as_deref().and_then(crate::mcp::guild_founding::plan_summary);
    json!({
        "label": v.label,
        "player_id": v.player_id,
        "name": v.name,
        "index": v.index,
        "address": v.address,
        "guild_id": guild.map(|g| g.0.clone()),
        "guild_name": guild.map(|g| g.1.clone()),
        "founding": plan,
    })
}

/// Every founder: label, player, the guild it owns, and its founding plan.
pub async fn list() -> Result<Value, String> {
    let rows = founders();
    let owners: Vec<String> = rows.iter().filter_map(|p| p.player_id.clone()).collect();
    let client = CosmosClient::new();
    let guilds = owned_guilds(&client, &owners).await;
    let out: Vec<Value> = rows
        .iter()
        .map(|v| row_json(v, guilds.iter().find(|g| Some(&g.2) == v.player_id.as_ref())))
        .collect();
    let unlabelled = rows.iter().filter(|v| v.label.is_none()).count();
    Ok(json!({
        "ok": true,
        "founders": out,
        "unlabelled": unlabelled,
        "note": "pass as:\"<label>\" to structs_action guild / substation / provider / treasury to work as that founder",
    }))
}

/// One founder's whole context: who it is, its guild, the guild's treasury
/// and substations, and its founding plan.
pub async fn show(key: &str) -> Result<Value, String> {
    let signer = resolve(Some(key))?;
    if signer.is_primary() {
        return Err("name a founder by its label".into());
    }
    let client = CosmosClient::new();
    let guild = owned_guilds(&client, std::slice::from_ref(&signer.player_id)).await.into_iter().next();
    let vault = crate::mcp::guild_founding::vault_of(&client, &signer.player_id).await;
    let mut out = json!({
        "ok": true,
        "founder": signer.describe(),
        "vault_ualpha": vault.to_string(),
        "founding": crate::mcp::guild_founding::plan_summary(&signer.label),
    });
    match guild {
        Some((gid, name, _)) => {
            out["guild_id"] = json!(gid);
            out["guild_name"] = json!(name);
            out["guild"] = crate::mcp::guild_admin::overview_as(&signer, Some(gid.clone())).await.unwrap_or_else(|e| json!({ "error": e }));
            out["treasury"] = crate::mcp::guild_treasury::status(&signer, Some(gid)).await.unwrap_or_else(|e| json!({ "error": e }));
        }
        None => {
            out["guild_id"] = Value::Null;
            out["note"] = json!("this founder owns no guild (founding unfinished, or the guild was handed over)");
        }
    }
    Ok(out)
}

/// MCP entry: `founder {op: list | show | label, ...}`.
pub async fn op(args: &Value) -> Result<Value, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    match s("op").as_str() {
        "" | "list" => list().await,
        "show" => {
            let key = [s("label"), s("as"), s("founder")].into_iter().find(|k| !k.is_empty()).ok_or("label is required")?;
            show(&key).await
        }
        "label" => {
            // Relabel (or label an unlabelled founder): `founder` names it
            // by id/old label, `label` is the new one.
            let who = [s("founder"), s("player")].into_iter().find(|k| !k.is_empty()).ok_or("founder is required (its player id or current label)")?;
            let index = {
                let reg = REGISTRY.read().map_err(|e| e.to_string())?;
                find_founder(&reg.players, &who)?.index
            };
            set_label(index, &s("label"))?;
            let signer = resolve(Some(&normalize_label(&s("label"))))?;
            Ok(json!({ "ok": true, "founder": signer.describe() }))
        }
        other => Err(format!("unknown founder op '{other}' (list, show, label)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(index: u32, pid: &str, role: VPlayerRole, label: Option<&str>) -> VirtualPlayer {
        VirtualPlayer {
            index,
            address: format!("structs1addr{index}"),
            player_id: Some(pid.into()),
            name: format!("Name-{index}"),
            created_at: 0.0,
            role,
            profile: None,
            auto_name: true,
            label: label.map(String::from),
        }
    }

    #[test]
    fn labels_are_checked() {
        assert!(label_refusal("acme-guild").is_none());
        assert!(label_refusal("orbital.hydro_2").is_none());
        assert!(label_refusal("a").is_some(), "too short");
        assert!(label_refusal("1-42").is_some(), "would read as a player id");
        assert!(label_refusal("42").is_some(), "would read as an HD index");
        assert!(label_refusal("structs1abc").is_some());
        assert!(label_refusal("primary").is_some());
        assert!(label_refusal("Acme").is_some(), "stored lower-case; normalize first");
        assert_eq!(normalize_label("  Acme-Guild "), "acme-guild");
        assert!(label_refusal(&"x".repeat(33)).is_some());
    }

    #[test]
    fn founders_resolve_by_label_then_id_and_bots_never_do() {
        let rows = vec![
            row(5, "1-50", VPlayerRole::Bait, None),
            row(7, "1-70", VPlayerRole::Founder, Some("acme")),
            row(9, "1-90", VPlayerRole::Founder, None),
        ];
        assert_eq!(find_founder(&rows, "acme").unwrap().index, 7);
        assert_eq!(find_founder(&rows, " ACME ").unwrap().index, 7);
        assert_eq!(find_founder(&rows, "1-90").unwrap().index, 9);
        assert_eq!(find_founder(&rows, "9").unwrap().index, 9);
        assert_eq!(find_founder(&rows, "structs1addr7").unwrap().index, 7);
        let bot = find_founder(&rows, "1-50").unwrap_err();
        assert!(bot.contains("not a founder"), "{bot}");
        assert!(find_founder(&rows, "nobody").unwrap_err().contains("no founder labelled"));
        // A prefix never matches (1-9 is not 1-90).
        assert!(find_founder(&rows, "1-9").is_err());
    }

    #[test]
    fn a_label_belongs_to_one_founder() {
        let rows = vec![row(7, "1-70", VPlayerRole::Founder, Some("acme")), row(9, "1-90", VPlayerRole::Founder, None)];
        assert_eq!(label_taken_by(&rows, "acme", 9), Some("1-70".into()));
        assert_eq!(label_taken_by(&rows, "acme", 7), None, "relabelling yourself is fine");
        assert_eq!(label_taken_by(&rows, "other", 9), None);
    }
}
