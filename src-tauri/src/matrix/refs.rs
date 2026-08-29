//! Object references in chat.
//!
//! Every noun in Structs has an id of the form `<type>-<index>`, and players
//! already talk in them — "raid 2-15361", "5-2184 is stuck", "ask 1-61". A
//! client that renders those as plain text makes everyone go look them up by
//! hand. Rendering them as a small summary is the single biggest thing chat
//! can do for a game whose whole vocabulary is ids.
//!
//! Summaries are deliberately the SAME shape Team Ops and the dashboard use:
//! a title, a subtitle, and a short row of label/value pairs formatted with
//! the game's own unit ladders. Nothing here invents a presentation.
//!
//! Object type codes are the canonical ones (structs-ai/schemas/formats.md):
//! 0 guild · 1 player · 2 planet · 3 reactor · 4 substation · 5 struct
//! 6 allocation · 7 infusion · 8 address · 9 fleet · 10 provider · 11 agreement

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::RwLock;

use crate::mcp::tools::format::{format_alpha, format_ore, format_power};

/// Resolved summaries, so a room full of the same id is one lookup. Chat
/// references are overwhelmingly repeats — the same raid, the same struct.
const TTL_SECS: u64 = 120;
static CACHE: std::sync::LazyLock<RwLock<HashMap<String, (u64, Value)>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// The types worth rendering a card for. Allocations, infusions and addresses
/// are plumbing — a player saying "6-1" means nothing to a reader, and a card
/// that says nothing is worse than plain text.
pub fn is_referenceable(kind: u8) -> bool {
    matches!(kind, 0 | 1 | 2 | 4 | 5 | 9 | 10)
}

/// One thing a card lets you DO. A summary that only reads is a lookup; the
/// point of putting an object in the conversation is to act on it there —
/// watch the planet someone just named, message its owner, rent the capacity
/// a provider just advertised.
fn action(key: &str, label: &str, icon: &str) -> Value {
    json!({ "key": key, "label": label, "icon": icon })
}

/// Split `5-2184` into its type code and index, rejecting anything that is not
/// exactly one id. Never substring-matched: `1-194` and `1-1945` are different
/// objects and a loose match attributes one to the other.
pub fn parse_id(id: &str) -> Option<(u8, u64)> {
    let (t, i) = id.split_once('-')?;
    if t.is_empty() || i.is_empty() || t.len() > 2 || i.len() > 9 {
        return None;
    }
    if !t.bytes().all(|c| c.is_ascii_digit()) || !i.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((t.parse().ok()?, i.parse().ok()?))
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn row(label: &str, value: impl Into<String>) -> Value {
    json!({ "label": label, "value": value.into() })
}

/// A player's name from the galaxy directory, falling back to the id — never
/// a bare address, which tells a reader nothing.
fn player_label(player_id: &str) -> String {
    if player_id.is_empty() {
        return "—".into();
    }
    match super::directory::get(player_id) {
        Some(i) if !i.username.is_empty() => {
            if i.tag.is_empty() {
                i.username
            } else {
                format!("[{}] {}", i.tag, i.username)
            }
        }
        _ => player_id.to_string(),
    }
}

/// Blocks → a human duration. The chain's block time is ~5.28s (measured, see
/// the futile-mining incident); using 6 here would drift ~12% on a long build.
const BLOCK_SECS: f64 = 5.28;

fn since_blocks(start: f64, now: f64) -> String {
    if start <= 0.0 || now <= start {
        return String::new();
    }
    let secs = (now - start) * BLOCK_SECS;
    if secs < 90.0 {
        format!("{}s", secs.round() as i64)
    } else if secs < 5400.0 {
        format!("{}m", (secs / 60.0).round() as i64)
    } else if secs < 172_800.0 {
        format!("{}h", (secs / 3600.0).round() as i64)
    } else {
        format!("{}d", (secs / 86_400.0).round() as i64)
    }
}

fn current_block() -> f64 {
    crate::game_state::GAME_STATE
        .read()
        .map(|gs| gs.current_block_height as f64)
        .unwrap_or(0.0)
}

// ── Per-type summaries ──────────────────────────────────────────────────────

fn player_card(id: &str, v: &Value) -> Value {
    let p = v.get("Player").unwrap_or(&Value::Null);
    let grid = v.get("gridAttributes").unwrap_or(&Value::Null);
    let alpha = v
        .get("playerInventory")
        .and_then(|i| i.get("rocks"))
        .map(|r| num(r.get("amount")))
        .unwrap_or(0.0);

    let name = text(p.get("name"));
    let ident = super::directory::get(id);
    let tag = ident.as_ref().map(|i| i.tag.clone()).unwrap_or_default();
    let load = num(grid.get("load")) + num(grid.get("structsLoad"));
    let capacity = num(grid.get("capacity")) + num(grid.get("connectionCapacity"));

    // Somebody named in chat is somebody you may want to look at or talk to.
    let mut actions = Vec::new();
    if !text(p.get("planetId")).is_empty() {
        actions.push(action("watch_planet", "Planet", "icon-planet"));
    }
    if !text(p.get("fleetId")).is_empty() {
        actions.push(action("watch_fleet", "Fleet", "icon-fleet-tile"));
    }
    actions.push(action("message", "Message", "icon-phone"));

    json!({
        "id": id, "kind": "player", "icon": "icon-member",
        "title": if name.is_empty() { id.to_string() } else { name },
        "subtitle": if tag.is_empty() { format!("PID #{}", id) } else { format!("[{}] PID #{}", tag, id) },
        // The portrait the roster and Team Ops render, so a player looks the
        // same everywhere in the app.
        "pfp_attrs": text(p.get("pfpClientRenderAttributes")),
        "rows": [
            row("Alpha", format_alpha(alpha)),
            row("Energy", format!("{}/{}", format_power(load), format_power(capacity))),
            row("Planet", text(p.get("planetId"))),
            row("Fleet", text(p.get("fleetId"))),
        ],
        "actions": actions,
        "planet_id": text(p.get("planetId")),
        "fleet_id": text(p.get("fleetId")),
    })
}

fn planet_card(id: &str, v: &Value) -> Value {
    let p = v.get("Planet").unwrap_or(&Value::Null);
    let attrs = v.get("planetAttributes").unwrap_or(&Value::Null);
    let grid = v.get("gridAttributes").unwrap_or(&Value::Null);

    // Slot occupancy is the readable version of four parallel arrays.
    let mut filled = 0usize;
    let mut total = 0usize;
    for ambit in ["space", "air", "land", "water"] {
        if let Some(arr) = p.get(ambit).and_then(|a| a.as_array()) {
            total += arr.len();
            filled += arr.iter().filter(|s| !text(Some(s)).is_empty()).count();
        }
    }

    let owner = text(p.get("owner"));
    let shield = num(attrs.get("planetaryShield"));
    let name = text(p.get("name"));
    let title = if name.is_empty() { format!("Planet {}", id) } else { name };
    let status = text(p.get("status"));
    json!({
        "id": id, "kind": "planet", "icon": "icon-planet",
        "title": title,
        "subtitle": format!("Owned by {}", player_label(&owner)),
        "rows": [
            row("Shield", format!("{}", shield as i64)),
            row("Ore", format_ore(num(grid.get("ore")))),
            row("Structs", format!("{}/{}", filled, total)),
            row("Status", if status.is_empty() { "—".to_string() } else { status }),
        ],
        "actions": [action("watch_planet", "Watch", "icon-planet")],
        "planet_id": id,
    })
}

fn struct_card(id: &str, v: &Value) -> Value {
    let st = v.get("Struct").unwrap_or(&Value::Null);
    let a = v.get("structAttributes").unwrap_or(&Value::Null);

    let type_id = text(st.get("type"));
    let type_name = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.struct_types.get(&type_id).map(|t| t.name.clone()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("Type {}", type_id));

    let destroyed = a.get("isDestroyed").and_then(|b| b.as_bool()).unwrap_or(false);
    let built = a.get("isBuilt").and_then(|b| b.as_bool()).unwrap_or(false);
    let online = a.get("isOnline").and_then(|b| b.as_bool()).unwrap_or(false);

    // ── Work in progress ──
    // A struct's job is not a field; it is which of three block-start stamps
    // is non-zero. That is exactly the detail someone pasting a struct id into
    // chat is usually asking about.
    let now = current_block();
    let build_at = num(a.get("blockStartBuild"));
    let mine_at = num(a.get("blockStartOreMine"));
    let refine_at = num(a.get("blockStartOreRefine"));
    let work = if destroyed {
        "Destroyed".to_string()
    } else if !built && build_at > 0.0 {
        format!("Building{}", opt_since(build_at, now))
    } else if mine_at > 0.0 {
        format!("Mining{}", opt_since(mine_at, now))
    } else if refine_at > 0.0 {
        format!("Refining{}", opt_since(refine_at, now))
    } else if !built {
        "Not built".to_string()
    } else if online {
        "Idle".to_string()
    } else {
        "Offline".to_string()
    };

    let health = num(a.get("health"));
    // Destroyed wreckage has its own glyph in the shipped set.
    let icon = if destroyed { "icon-wreckage" } else { "icon-cmd-post" };
    let ambit = text(st.get("operatingAmbit"));
    json!({
        "id": id, "kind": "struct",
        "icon": icon,
        "title": type_name,
        "subtitle": format!("{} · {}", id, player_label(&text(st.get("owner")))),
        "rows": [
            row("Work", work),
            row("Health", format!("{}", health as i64)),
            row("Ambit", if ambit.is_empty() { "—".to_string() } else { ambit }),
            row("Location", text(st.get("locationId"))),
        ],
        // A struct is somewhere; watching that somewhere is the useful verb.
        "actions": [action("watch_planet", "Watch", "icon-planet")],
        "planet_id": text(st.get("locationId")),
    })
}

fn opt_since(start: f64, now: f64) -> String {
    let d = since_blocks(start, now);
    if d.is_empty() {
        String::new()
    } else {
        format!(" · {}", d)
    }
}

fn fleet_card(id: &str, v: &Value) -> Value {
    let f = v.get("Fleet").unwrap_or(&Value::Null);
    let mut filled = 0usize;
    let mut total = 0usize;
    for ambit in ["space", "air", "land", "water"] {
        if let Some(arr) = f.get(ambit).and_then(|a| a.as_array()) {
            total += arr.len();
            filled += arr.iter().filter(|s| !text(Some(s)).is_empty()).count();
        }
    }
    let status = text(f.get("status"));
    json!({
        "id": id, "kind": "fleet", "icon": "icon-fleet-tile",
        "title": format!("Fleet {}", id),
        "subtitle": format!("Of {}", player_label(&text(f.get("owner")))),
        "rows": [
            row("Status", if status.is_empty() { "—".to_string() } else { status }),
            row("Location", text(f.get("locationId"))),
            row("Structs", format!("{}/{}", filled, total)),
        ],
        "actions": [action("watch_fleet", "Watch", "icon-fleet-tile")],
        "fleet_id": id,
    })
}

fn substation_card(id: &str, v: &Value) -> Value {
    let grid = v.get("gridAttributes").unwrap_or(&Value::Null);
    json!({
        "id": id, "kind": "substation", "icon": "icon-beacon",
        "title": format!("Substation {}", id),
        "subtitle": "Power distribution",
        "rows": [
            row("Capacity", format_power(num(grid.get("connectionCapacity")))),
            row("Load", format_power(num(grid.get("load")))),
            row("Connections", format!("{}", num(grid.get("connectionCount")) as i64)),
        ],
    })
}

fn guild_card(id: &str, v: &Value) -> Value {
    let g = v.get("Guild").unwrap_or(&Value::Null);
    // The chain's guild name is routinely empty; the directory's config name
    // is the one players actually use.
    let cfg = crate::guild_config::get_guild_configs()
        .into_iter()
        .find(|c| c.guild_id == id);
    let name = cfg
        .as_ref()
        .map(|c| c.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            let n = text(g.get("name"));
            if n.is_empty() { format!("Guild {}", id) } else { n }
        });
    let tag = cfg.as_ref().map(|c| c.guild_tag.clone()).unwrap_or_default();
    let subtitle = if tag.is_empty() { id.to_string() } else { format!("[{}] {}", tag, id) };
    let comms = if cfg.as_ref().and_then(|c| c.matrix_url.clone()).is_some() { "Yes" } else { "None" };
    json!({
        "id": id, "kind": "guild", "icon": "icon-guild",
        "title": name,
        "subtitle": subtitle,
        "rows": [
            row("Owner", player_label(&text(g.get("owner")))),
            row("Comms", comms),
        ],
    })
}

/// A provider is an OFFER: someone renting energy capacity at a price. It is
/// the one object in the game whose card should let you close the deal where
/// you read about it — which is why chat is a good place for it.
fn provider_card(id: &str, v: &Value) -> Value {
    let p = v.get("Provider").unwrap_or(&Value::Null);
    let rate = p.get("rate").cloned().unwrap_or(Value::Null);
    let rate_amount = num(rate.get("amount"));
    let rate_denom = text(rate.get("denom"));
    let policy = text(p.get("accessPolicy"));

    // `openMarket` is the only policy any player can act on: `guildMarket`
    // needs a permission from that guild and `closedMarket` refuses everyone.
    // Offering a button that will certainly be rejected is worse than none.
    let open = policy == "openMarket";
    let actions = if open {
        vec![action("agreement", "Rent capacity", "icon-transfers")]
    } else {
        Vec::new()
    };

    json!({
        "id": id, "kind": "provider", "icon": "icon-transfers",
        "title": format!("Provider {}", id),
        "subtitle": format!("From {}", player_label(&text(p.get("owner")))),
        "rows": [
            row("Rate", format!("{} {} / W / block", rate_amount as i64, denom_label(&rate_denom))),
            row("Capacity", format!("{} – {}",
                format_power(num(p.get("capacityMinimum"))),
                format_power(num(p.get("capacityMaximum"))))),
            row("Duration", format!("{} – {} blocks",
                compact(num(p.get("durationMinimum"))),
                compact(num(p.get("durationMaximum"))))),
            row("Market", if policy.is_empty() { "—".to_string() } else { policy.clone() }),
        ],
        "actions": actions,
        // Everything the rent form needs, so it can price a deal without a
        // second round trip.
        "provider": {
            "rate_amount": rate_amount,
            "rate_denom": rate_denom,
            "denom_label": denom_label(&text(rate.get("denom"))),
            "capacity_min": num(p.get("capacityMinimum")),
            "capacity_max": num(p.get("capacityMaximum")),
            "duration_min": num(p.get("durationMinimum")),
            "duration_max": num(p.get("durationMaximum")),
            "open": open,
        },
    })
}

/// A plain count, short enough for a card: `1000000` → `1M`. Block counts run
/// to seven digits and a card is 320px wide.
fn compact(n: f64) -> String {
    let n = n.max(0.0);
    if n >= 1e9 {
        format!("{}B", (n / 1e9).round() as i64)
    } else if n >= 1e6 {
        format!("{}M", (n / 1e6).round() as i64)
    } else if n >= 10_000.0 {
        format!("{}K", (n / 1e3).round() as i64)
    } else {
        format!("{}", n.round() as i64)
    }
}

/// A guild token's cosmetic name — `uguild.0-1` is displayed as whatever that
/// guild calls it. Never invent one: an unknown denom keeps its chain name.
fn denom_label(chain_denom: &str) -> String {
    if chain_denom.is_empty() {
        return "—".into();
    }
    crate::guild_config::denom_registry()
        .get(chain_denom)
        .map(|d| d.base_name.clone())
        .unwrap_or_else(|| chain_denom.to_string())
}

// ── Resolution ──────────────────────────────────────────────────────────────

/// Look one id up and render its card. `None` when the id is not a type worth
/// a card, or the chain does not have it — a reference to something that does
/// not exist stays plain text rather than becoming an error card.
pub async fn resolve(id: &str) -> Option<Value> {
    let (kind, _) = parse_id(id)?;
    if !is_referenceable(kind) {
        return None;
    }
    {
        let cache = CACHE.read().ok()?;
        if let Some((at, v)) = cache.get(id) {
            if super::auth::now_secs().saturating_sub(*at) < TTL_SECS {
                return Some(v.clone());
            }
        }
    }

    let entity = match kind {
        0 => "guild",
        1 => "player",
        2 => "planet",
        4 => "substation",
        5 => "struct",
        9 => "fleet",
        10 => "provider",
        _ => return None,
    };
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    // A destroyed struct or a bad id answers 500 "object not found"; that is a
    // normal outcome here, not something to report.
    let v = client.query_entity(entity, id).await.ok()?;

    let card = match kind {
        0 => guild_card(id, &v),
        1 => player_card(id, &v),
        2 => planet_card(id, &v),
        4 => substation_card(id, &v),
        5 => struct_card(id, &v),
        9 => fleet_card(id, &v),
        10 => provider_card(id, &v),
        _ => return None,
    };
    if let Ok(mut cache) = CACHE.write() {
        cache.insert(id.to_string(), (super::auth::now_secs(), card.clone()));
        // Bounded: a busy room could otherwise name thousands of objects.
        if cache.len() > 500 {
            let cutoff = super::auth::now_secs().saturating_sub(TTL_SECS);
            cache.retain(|_, (at, _)| *at >= cutoff);
        }
    }
    Some(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse_into_type_and_index() {
        assert_eq!(parse_id("5-2184"), Some((5, 2184)));
        assert_eq!(parse_id("0-1"), Some((0, 1)));
        assert_eq!(parse_id("11-1"), Some((11, 1)));
    }

    #[test]
    fn nonsense_is_not_an_id() {
        for bad in ["", "-", "5-", "-5", "a-1", "5-x", "5", "5-1-2", "123-1", "5-1234567890"] {
            assert!(parse_id(bad).is_none(), "{} parsed as an id", bad);
        }
    }

    #[test]
    fn only_types_a_reader_cares_about_get_a_card() {
        // Guild, player, planet, substation, struct, fleet.
        // …and a provider, which is an offer you can act on.
        for k in [0u8, 1, 2, 4, 5, 9, 10] {
            assert!(is_referenceable(k), "type {} should be referenceable", k);
        }
        // Plumbing: an allocation or infusion id tells a reader nothing, and a
        // card that says nothing is worse than plain text.
        for k in [3u8, 6, 7, 8, 11] {
            assert!(!is_referenceable(k), "type {} should not be", k);
        }
    }

    #[test]
    fn a_struct_reports_the_work_it_is_doing() {
        // Shapes transcribed from the live LCD (5-2184, 2026-08-28).
        let mining = json!({
            "Struct": { "type": "16", "owner": "1-194", "locationId": "2-223",
                        "operatingAmbit": "space" },
            "structAttributes": { "health": "6", "isBuilt": true, "isOnline": true,
                "isDestroyed": false, "blockStartBuild": "1209774",
                "blockStartOreMine": "1209800", "blockStartOreRefine": "0" }
        });
        let card = struct_card("5-2184", &mining);
        let work = card["rows"][0]["value"].as_str().unwrap();
        assert!(work.starts_with("Mining"), "{}", work);

        // A built, idle struct says so rather than claiming to build forever:
        // blockStartBuild stays set after the build completes.
        let idle = json!({
            "Struct": { "type": "16" },
            "structAttributes": { "isBuilt": true, "isOnline": true, "isDestroyed": false,
                "blockStartBuild": "1209774", "blockStartOreMine": "0",
                "blockStartOreRefine": "0" }
        });
        assert_eq!(struct_card("5-1", &idle)["rows"][0]["value"], "Idle");

        let building = json!({
            "Struct": { "type": "16" },
            "structAttributes": { "isBuilt": false, "isOnline": false, "isDestroyed": false,
                "blockStartBuild": "1209774", "blockStartOreMine": "0",
                "blockStartOreRefine": "0" }
        });
        assert!(struct_card("5-2", &building)["rows"][0]["value"]
            .as_str().unwrap().starts_with("Building"));

        let dead = json!({
            "Struct": {}, "structAttributes": { "isDestroyed": true }
        });
        let d = struct_card("5-3", &dead);
        assert_eq!(d["rows"][0]["value"], "Destroyed");
        assert_eq!(d["icon"], "icon-wreckage");
    }

    #[test]
    fn only_an_open_market_offers_to_rent() {
        // Shape transcribed from the live provider 10-1 (2026-08-29).
        let base = |policy: &str| json!({
            "Provider": {
                "owner": "1-170", "substationId": "4-4",
                "rate": { "denom": "uguild.0-1", "amount": "1" },
                "accessPolicy": policy,
                "capacityMinimum": "1000", "capacityMaximum": "1000000000",
                "durationMinimum": "100", "durationMaximum": "1000000"
            }
        });
        let open = provider_card("10-1", &base("openMarket"));
        assert_eq!(open["actions"].as_array().unwrap().len(), 1);
        assert_eq!(open["actions"][0]["key"], "agreement");
        assert_eq!(open["provider"]["open"], true);

        // A guild or closed market would reject the transaction, so the card
        // must not offer a button that is certain to fail.
        for policy in ["guildMarket", "closedMarket", ""] {
            let c = provider_card("10-1", &base(policy));
            assert!(c["actions"].as_array().unwrap().is_empty(), "{}", policy);
            assert_eq!(c["provider"]["open"], false, "{}", policy);
        }
    }

    #[test]
    fn big_counts_stay_short_enough_for_a_card() {
        assert_eq!(compact(100.0), "100");
        assert_eq!(compact(9999.0), "9999");
        assert_eq!(compact(1_000_000.0), "1M");
        assert_eq!(compact(1_000_000_000.0), "1B");
        // A raw 1000000 pushed "blocks" onto its own line in a 320px card.
        assert!(compact(1_000_000.0).len() <= 3);
    }

    #[test]
    fn a_player_card_offers_what_the_player_has() {
        let with_both = json!({
            "Player": { "name": "JPEG", "planetId": "2-21740", "fleetId": "9-61" },
            "gridAttributes": {}, "playerInventory": {}
        });
        let keys: Vec<String> = player_card("1-61", &with_both)["actions"]
            .as_array().unwrap().iter()
            .map(|a| a["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, vec!["watch_planet", "watch_fleet", "message"]);

        // A player with no planet must not offer to watch one.
        let homeless = json!({ "Player": { "name": "X", "fleetId": "9-1" },
                               "gridAttributes": {}, "playerInventory": {} });
        let keys: Vec<String> = player_card("1-2", &homeless)["actions"]
            .as_array().unwrap().iter()
            .map(|a| a["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, vec!["watch_fleet", "message"]);
    }

    #[test]
    fn a_planet_counts_its_occupied_slots() {
        let v = json!({
            "Planet": { "owner": "1-1031", "status": "complete",
                "space": ["5-1", "", "", ""], "air": ["", "", "", ""],
                "land": ["5-2", "5-3", "", ""], "water": ["", "", "", ""] },
            "planetAttributes": { "planetaryShield": "25" },
            "gridAttributes": { "ore": "0" }
        });
        let card = planet_card("2-15361", &v);
        assert_eq!(card["rows"][2]["value"], "3/16");
        assert_eq!(card["rows"][0]["value"], "25");
    }

    #[test]
    fn durations_round_into_readable_units() {
        // ~5.28s per block (measured; 6 would drift 12% over a long build).
        assert_eq!(since_blocks(0.0, 100.0), "", "no start = no duration");
        assert_eq!(since_blocks(100.0, 90.0), "", "a future start is not elapsed");
        assert_eq!(since_blocks(0.0, 0.0), "");
        assert!(since_blocks(1000.0, 1010.0).ends_with('s'));
        assert!(since_blocks(1000.0, 1100.0).ends_with('m'));
        assert!(since_blocks(1000.0, 3000.0).ends_with('h'));
    }
}
