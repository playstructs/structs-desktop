use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;

use crate::game_state::GAME_STATE;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::error_translator::translate_error;
use crate::mcp::tools::format;

#[derive(Debug, Deserialize)]
pub struct QueryParams {
    /// Entity type: player, planet, struct, struct_type, fleet, guild, reactor, substation, provider, agreement, allocation
    pub r#type: String,
    /// Entity ID (e.g., "1-18" for player, "2-5" for planet). If omitted, lists all entities of this type.
    pub id: Option<String>,
    /// Pagination key for list queries (from previous response)
    pub pagination_key: Option<String>,
    /// Max results per page (default: 100)
    pub limit: Option<u32>,
}

pub async fn execute(client: &CosmosClient, params: QueryParams) -> Vec<Content> {
    let result = if let Some(id) = &params.id {
        client.query_entity(&params.r#type, id).await
    } else {
        client
            .list_entities(
                &params.r#type,
                params.pagination_key.as_deref(),
                params.limit,
            )
            .await
    };

    match result {
        Ok(mut data) => {
            enrich_response(&mut data);
            vec![Content::text(
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string()),
            )]
        }
        Err(e) => vec![Content::text(format!("Error: {}", translate_error(&e)))],
    }
}

/// Walk JSON recursively and add human-readable annotations.
/// Keeps original data intact, adds enrichment fields alongside.
fn enrich_response(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut additions = vec![];

            // Decode status bitflags
            if let Some(Value::String(s)) = map.get("status") {
                if let Ok(status) = s.parse::<u64>() {
                    additions.push((
                        "status_decoded".to_string(),
                        Value::String(format::decode_status(status)),
                    ));
                }
            }
            if let Some(Value::Number(n)) = map.get("status") {
                if let Some(status) = n.as_u64() {
                    additions.push((
                        "status_decoded".to_string(),
                        Value::String(format::decode_status(status)),
                    ));
                }
            }

            // Resolve struct type ID to name
            if let Some(type_val) = map.get("type").or(map.get("structType")) {
                let type_id_str = match type_val {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                };
                if let Some(type_id) = type_id_str {
                    let gs = GAME_STATE.read().unwrap();
                    if let Some(st) = gs.struct_types.get(&type_id) {
                        additions.push((
                            "type_name".to_string(),
                            Value::String(st.name.clone()),
                        ));
                    }
                }
            }

            // Resolve owner to player name
            if let Some(Value::String(owner)) = map.get("owner") {
                let gs = GAME_STATE.read().unwrap();
                if gs.player_id.as_deref() == Some(owner.as_str()) {
                    if let Some(name) = &gs.player_name {
                        additions.push((
                            "owner_name".to_string(),
                            Value::String(format!("{} (you)", name)),
                        ));
                    }
                }
                // Add entity type hint
                additions.push((
                    "owner_type".to_string(),
                    Value::String(format::entity_type_from_id(owner).to_string()),
                ));
            }

            // Entity ID type hints for common reference fields
            for field in &["playerId", "player_id", "planetId", "planet_id", "fleetId", "fleet_id", "guildId", "guild_id"] {
                if let Some(Value::String(id)) = map.get(*field) {
                    let type_name = format::entity_type_from_id(id);
                    if type_name != "Unknown" {
                        additions.push((
                            format!("{}_type", field),
                            Value::String(type_name.to_string()),
                        ));
                    }
                }
            }

            // Apply additions
            for (key, val) in additions {
                map.insert(key, val);
            }

            // Recurse into nested objects
            for (_, v) in map.iter_mut() {
                enrich_response(v);
            }
        }
        Value::Array(arr) => {
            for v in arr.iter_mut() {
                enrich_response(v);
            }
        }
        _ => {}
    }
}
