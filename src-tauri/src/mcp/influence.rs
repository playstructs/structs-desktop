//! Sector Blitz (influence contests) for the Terminal's contest cards.
//!
//! READ ONLY. Every command here is a GET against the guild's
//! `/api/influence` routes or its raid search, plus the local snapshot for
//! which planets sit in a sector. Nothing here signs, queues or writes.
//!
//! The guild API is login-only; `GuildApiClient::get_whole` signs the session
//! in Rust the way every other guild read does, and keeps the envelope's
//! `meta` (contest build, height, scoring weights) and `total`, which the
//! cards need to say how fresh a number is and how many rows a list has.
//!
//! Routes and their parameters: structs-webapp `tools/api/influence-api.md`.

use serde_json::{json, Map, Value};

/// The literal path words the influence API routes are made of.
const PATH_WORDS: &[&str] = &["contests", "page", "standings", "guilds", "players", "planets", "history"];

/// Every query parameter any influence route accepts. The server rejects
/// unknown parameters, so a typo here is a 400, never a silent default.
const QUERY_KEYS: &[&str] = &[
    "chain_id", "limit", "after_id", "include_total", "sector", "scored_only", "guild_id",
    "planet_ids", "start_height", "end_height", "bucket_blocks", "group_by",
];

/// The planets batch route takes at most 100 ids.
pub const PLANET_BATCH: usize = 100;
/// A sector larger than this is cut (and the answer says so) rather than
/// fanned out into dozens of requests.
pub const TERRITORY_MAX: usize = 3000;

/// Is `path` one of the influence API's own route shapes? Words from
/// `PATH_WORDS`, numbers, and object ids (`0-7`, `1-61`, `2-41`) only, and it
/// must start at `contests`. The server validates the rest; this keeps a card
/// from turning the command into a general guild-API proxy.
pub fn valid_path(path: &str) -> bool {
    let p = path.trim().trim_matches('/');
    if p.is_empty() || p.len() > 160 {
        return false;
    }
    let mut parts = p.split('/');
    if parts.next() != Some("contests") {
        return false;
    }
    parts.all(|seg| {
        PATH_WORDS.contains(&seg)
            || (!seg.is_empty() && seg.len() <= 20 && seg.bytes().all(|b| b.is_ascii_digit()))
            || is_object_id(seg)
    })
}

fn is_object_id(s: &str) -> bool {
    let Some((a, b)) = s.split_once('-') else { return false };
    !a.is_empty() && a.len() <= 2 && a.bytes().all(|c| c.is_ascii_digit())
        && !b.is_empty() && b.len() <= 20 && b.bytes().all(|c| c.is_ascii_digit())
}

/// A scalar query value as text, or `None` when it is not one the API takes.
fn scalar(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => if *b { "1".into() } else { "0".into() },
        _ => return None,
    };
    if s.is_empty() || s.len() > 2000 {
        return None;
    }
    s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b',').then_some(s)
}

/// `{sector: 127, limit: 10}` → `?limit=10&sector=127`, keys sorted so the
/// same ask is the same URL. Null values are dropped (an absent filter);
/// an unknown key or a non-scalar value is an error.
pub fn build_query(q: Option<&Value>) -> Result<String, String> {
    let Some(q) = q else { return Ok(String::new()) };
    let Some(obj) = q.as_object() else {
        if q.is_null() { return Ok(String::new()); }
        return Err("query must be an object".into());
    };
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    let mut out = Vec::new();
    for k in keys {
        let v = &obj[k];
        if v.is_null() {
            continue;
        }
        if !QUERY_KEYS.contains(&k.as_str()) {
            return Err(format!("{k} is not an influence parameter"));
        }
        let s = scalar(v).ok_or_else(|| format!("{k}: not a plain value"))?;
        out.push(format!("{k}={s}"));
    }
    Ok(if out.is_empty() { String::new() } else { format!("?{}", out.join("&")) })
}

fn client() -> crate::mcp::cosmos_client::CosmosClient {
    crate::mcp::cosmos_client::CosmosClient::new()
}

/// One influence read: `path` after `/api/influence/`, `query` its
/// parameters. Answers the whole envelope (`data`, `meta`, `total`).
#[tauri::command]
pub async fn terminal_influence(path: String, query: Option<Value>) -> Result<Value, String> {
    if !valid_path(&path) {
        return Err(format!("{path:?} is not an influence route"));
    }
    let qs = build_query(query.as_ref())?;
    let url = format!("/api/influence/{}{}", path.trim().trim_matches('/'), qs);
    client().guild.get_whole(&url).await
}

/// The raid search scored against a contest: each target carries
/// `influence_points`, what a win there would be worth to the SEARCHER's
/// guild now. The searcher is whoever the guild session is signed in as —
/// the primary — so the answer is "gains for my guild".
#[tauri::command]
pub async fn terminal_influence_hunt(
    contest: u64,
    sector: Option<u16>,
    rival: Option<bool>,
    undefeated: Option<bool>,
    page: Option<u32>,
) -> Result<Value, String> {
    let mut path = format!(
        "/api/player/raid/search?min_ore=0&fleet_away_only=0&not_under_attack=0&contest_id={}&page={}",
        contest,
        page.unwrap_or(1).clamp(1, 1000)
    );
    if rival.unwrap_or(true) {
        path.push_str("&rival_guilds_only=1");
    }
    if undefeated.unwrap_or(false) {
        path.push_str("&undefeated=1");
    }
    if let Some(s) = sector.filter(|s| valid_sector(*s)) {
        path.push_str(&format!("&sector={s}"));
    }
    let env = client().guild.get_whole(&path).await?;
    let mut rows = match env.get("data") {
        Some(Value::Array(a)) => a.clone(),
        _ => vec![],
    };
    // The search answers no sector; the chain's planet record has it, and
    // the card needs it to say which targets would change a sector's lead.
    crate::mcp::perception::with_snapshot(|s| {
        for r in rows.iter_mut() {
            let sec = r
                .get("planet_id")
                .and_then(|v| v.as_str())
                .and_then(|pid| s.planets.get(pid))
                .map(|p| planet_sector(p));
            if let (Some(sec), Some(obj)) = (sec, r.as_object_mut()) {
                obj.insert("sector".into(), json!(sec));
            }
        }
    });
    Ok(json!({
        "rows": rows,
        "searcher": crate::mcp::delegation::primary_player_id(),
        "page": page.unwrap_or(1),
    }))
}

/// A planet row's chain sector (a string on the LCD); absent = 0, unassigned.
pub fn planet_sector(p: &Value) -> u16 {
    match p.get("sector") {
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as u16,
        _ => 0,
    }
}

pub fn valid_sector(s: u16) -> bool {
    matches!(s, 0 | 44 | 127 | 999)
}

/// The planets the snapshot places in `sector`, ordered by id number, with
/// the owner and the owner's guild as the chain has them. `sector` is the
/// chain's own `Planet.sector` (a string on the LCD).
pub fn sector_planets(planets: &std::collections::HashMap<String, Value>, players: &std::collections::HashMap<String, Value>, sector: u16) -> Vec<Value> {
    let mut rows: Vec<(u64, Value)> = planets
        .iter()
        .filter(|(_, p)| planet_sector(p) == sector)
        .map(|(id, p)| {
            let n = id.split_once('-').and_then(|(_, b)| b.parse::<u64>().ok()).unwrap_or(u64::MAX);
            let owner = p.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let guild = players
                .get(&owner)
                .and_then(|pl| pl.get("guildId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (n, json!({
                "planet_id": id,
                "name": p.get("name").cloned().unwrap_or(Value::Null),
                "owner": if owner.is_empty() { Value::Null } else { Value::String(owner) },
                "owner_guild_id": if guild.is_empty() { Value::Null } else { Value::String(guild) },
                "status": p.get("status").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect();
    rows.sort_by_key(|(n, _)| *n);
    rows.into_iter().map(|(_, v)| v).collect()
}

/// Every planet of a sector with its contest state: the snapshot names the
/// planets (the API has no "all planets of a sector" read), and the batch
/// route answers 100 at a time. One build/height is reported — the newest
/// seen — with `mixed_builds` set if the batches disagreed (a rebuild
/// landed mid-read).
#[tauri::command]
pub async fn terminal_influence_territory(contest: u64, sector: u16) -> Result<Value, String> {
    if !valid_sector(sector) || sector == 0 {
        return Err(format!("{sector} is not a scoring sector"));
    }
    let listed = crate::mcp::perception::with_snapshot(|s| (sector_planets(&s.planets, &s.players, sector), s.height));
    let Some((mut planets, height)) = listed else {
        return Err("The planet snapshot is still loading".into());
    };
    let total = planets.len();
    let cut = total > TERRITORY_MAX;
    planets.truncate(TERRITORY_MAX);

    let ids: Vec<String> = planets
        .iter()
        .filter_map(|p| p.get("planet_id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let mut by_id: Map<String, Value> = Map::new();
    let mut meta = Value::Null;
    let mut builds = std::collections::BTreeSet::new();
    let c = client();
    // Four at a time: a sector is ~10 batches, and the guild serves other
    // windows too.
    for group in ids.chunks(PLANET_BATCH * 4) {
        let futs = group.chunks(PLANET_BATCH).map(|chunk| {
            let path = format!("/api/influence/contests/{}/planets?planet_ids={}", contest, chunk.join(","));
            let g = &c.guild;
            async move { g.get_whole(&path).await }
        });
        for env in futures_util::future::join_all(futs).await {
            let env = env?;
            if let Some(b) = env.get("meta").and_then(|m| m.get("build_id")).and_then(|v| v.as_str()) {
                builds.insert(b.to_string());
            }
            if let Some(Value::Array(rows)) = env.get("data") {
                for r in rows {
                    if let Some(id) = r.get("planet_id").and_then(|v| v.as_str()) {
                        by_id.insert(id.to_string(), r.clone());
                    }
                }
            }
            meta = env.get("meta").cloned().unwrap_or(meta);
        }
    }
    for p in planets.iter_mut() {
        let id = p.get("planet_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(obj) = p.as_object_mut() {
            obj.insert("influence".into(), by_id.remove(&id).unwrap_or(Value::Null));
        }
    }
    Ok(json!({
        "sector": sector,
        "planets": planets,
        "total": total,
        "cut": cut,
        "snapshot_height": height,
        "meta": meta,
        "mixed_builds": builds.len() > 1,
    }))
}

/// Our own standing in a contest: the primary's personal row, which also
/// names the guild we score for. `standing` is null before our first scoring
/// raid (the API answers 404 for a player it has never credited).
#[tauri::command]
pub async fn terminal_influence_me(contest: u64) -> Result<Value, String> {
    let Some(me) = crate::mcp::delegation::primary_player_id() else {
        return Ok(json!({ "player_id": null, "standing": null }));
    };
    let standing = match client().guild.get_whole(&format!("/api/influence/contests/{contest}/players/{me}")).await {
        Ok(env) => env.get("data").cloned().unwrap_or(Value::Null),
        Err(e) if e.contains(" 404 ") => Value::Null,
        Err(e) => return Err(e),
    };
    Ok(json!({ "player_id": me, "standing": standing }))
}

/// One planet's contest state beside what the chain says about it: owner,
/// the owner's guild (a raid on your own guild's planet scores nothing) and
/// the sector. The influence half is the API's planet snapshot as is.
#[tauri::command]
pub async fn terminal_influence_planet(contest: u64, planet: String) -> Result<Value, String> {
    if !is_object_id(&planet) || !planet.starts_with("2-") {
        return Err(format!("{planet:?} is not a planet id"));
    }
    let env = client()
        .guild
        .get_whole(&format!("/api/influence/contests/{contest}/planets/{planet}"))
        .await?;
    let chain = crate::mcp::perception::with_snapshot(|s| {
        s.planets.get(&planet).map(|p| {
            let owner = p.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let guild = s.players.get(&owner).and_then(|pl| pl.get("guildId")).and_then(|v| v.as_str()).unwrap_or("").to_string();
            json!({
                "name": p.get("name").cloned().unwrap_or(Value::Null),
                "owner": if owner.is_empty() { Value::Null } else { Value::String(owner) },
                "owner_guild_id": if guild.is_empty() { Value::Null } else { Value::String(guild) },
                "sector": planet_sector(p),
            })
        })
    })
    .flatten()
    .unwrap_or(Value::Null);
    Ok(json!({ "data": env.get("data").cloned().unwrap_or(Value::Null), "meta": env.get("meta").cloned().unwrap_or(Value::Null), "chain": chain }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn only_influence_route_shapes_pass() {
        for ok in ["contests", "contests/page/2", "contests/1", "contests/1/standings", "contests/1/guilds/page/3",
            "contests/1/guilds/0-7/history", "contests/1/players/1-61", "contests/1/planets/2-41", "/contests/1/history/"] {
            assert!(valid_path(ok), "{ok}");
        }
        for bad in ["", "player/raid/search", "contests/../auth", "contests/1/guilds?x=1", "contests/1/bank",
            "contests/1/players/1-", "contests/a b", "guilds/0-1"] {
            assert!(!valid_path(bad), "{bad}");
        }
    }

    #[test]
    fn query_is_sorted_scalar_and_allowlisted() {
        let q = json!({"sector": 127, "limit": 10, "scored_only": true, "guild_id": null});
        assert_eq!(build_query(Some(&q)).unwrap(), "?limit=10&scored_only=1&sector=127");
        assert_eq!(build_query(Some(&json!({"planet_ids": "2-1,2-2"}))).unwrap(), "?planet_ids=2-1,2-2");
        assert_eq!(build_query(None).unwrap(), "");
        assert!(build_query(Some(&json!({"evil": 1}))).is_err());
        assert!(build_query(Some(&json!({"sector": "1&x=2"}))).is_err());
        assert!(build_query(Some(&json!({"sector": [1]}))).is_err());
    }

    #[test]
    fn sector_planets_reads_the_chain_sector_and_owner_guild() {
        let mut planets = HashMap::new();
        planets.insert("2-10".to_string(), json!({"id": "2-10", "owner": "1-29", "sector": "127", "name": "Aqixe"}));
        planets.insert("2-9".to_string(), json!({"id": "2-9", "owner": "1-3", "sector": "127"}));
        planets.insert("2-1".to_string(), json!({"id": "2-1", "owner": "1-3", "sector": "999"}));
        planets.insert("2-2".to_string(), json!({"id": "2-2", "owner": "1-4"}));
        let mut players = HashMap::new();
        players.insert("1-29".to_string(), json!({"guildId": "0-7"}));
        let rows = sector_planets(&planets, &players, 127);
        let ids: Vec<&str> = rows.iter().map(|r| r["planet_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["2-9", "2-10"], "ordered by id number, not text");
        assert_eq!(rows[1]["owner_guild_id"], "0-7");
        assert!(rows[0]["owner_guild_id"].is_null());
        assert_eq!(sector_planets(&planets, &players, 0).len(), 1, "no sector field = unassigned");
    }

    #[test]
    fn sectors_are_the_contest_set() {
        assert!(valid_sector(44) && valid_sector(127) && valid_sector(999) && valid_sector(0));
        assert!(!valid_sector(1) && !valid_sector(128));
    }
}
