use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;

use crate::game_state::GAME_STATE;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::error_translator::translate_error;
use crate::mcp::guild_api::GuildPage;
use crate::mcp::tools::format;

#[derive(Debug, Deserialize)]
pub struct QueryFilter {
    /// Filter dimension, e.g. "planet", "owner", "location", "provider".
    pub by: String,
    /// Filter value (the ID, owner address, etc.).
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct QueryParams {
    /// Entity type. Core (LCD-backed): player, planet, struct, struct_type, fleet, guild,
    /// reactor, substation, provider, agreement, allocation.
    /// Extended (Guild API-backed): planet_activity, struct_defender, work, grid,
    /// infusion, planet_attribute, struct_attribute, permission.
    pub r#type: String,
    /// Entity ID (e.g., "1-18" for player). If omitted with no `filter`, lists all.
    pub id: Option<String>,
    /// Pagination key for LCD list queries (from previous response).
    pub pagination_key: Option<String>,
    /// Max results per page for LCD list queries (default: 100).
    pub limit: Option<u32>,
    /// Filtered list query via Guild API. Mutually exclusive with `id`.
    pub filter: Option<QueryFilter>,
    /// Page number (1-indexed) for Guild API filtered queries. Defaults to 1.
    pub page: Option<u32>,
}

pub async fn execute(client: &CosmosClient, params: QueryParams) -> Vec<Content> {
    let result: Result<Value, String> = if let Some(filter) = &params.filter {
        let page = params.page.unwrap_or(1).max(1);
        route_guild_query(client, &params.r#type, filter, page).await
    } else if let Some(id) = &params.id {
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

/// Route a `(type, filter.by)` pair to the matching Guild API call.
/// Returns the unwrapped envelope `data` plus pagination hints when it's a page.
async fn route_guild_query(
    client: &CosmosClient,
    entity: &str,
    f: &QueryFilter,
    page: u32,
) -> Result<Value, String> {
    let g = &client.guild;
    let by = f.by.as_str();
    let v = f.value.as_str();

    // Pages → Value via GuildPage::into_response (adds page/has_more/_next_page).
    // Single-record GET → returned as-is.
    match (entity, by) {
        // planet-activity
        ("planet_activity", "planet") => g.planet_activity_by_planet(v, page).await.map(GuildPage::into_response),
        ("planet_activity", "category") => g.planet_activity_by_category(v, page).await.map(GuildPage::into_response),
        ("planet_activity", "all") | ("planet_activity", "") => g.planet_activity_all(page).await.map(GuildPage::into_response),

        // struct-defender
        ("struct_defender", "defending") => g.struct_defender_by_defending(v).await,
        ("struct_defender", "protected") => g.struct_defender_by_protected(v, page).await.map(GuildPage::into_response),

        // structs by location/owner via Guild API
        ("struct", "location") => g.struct_list_by_location(v, page).await.map(GuildPage::into_response),
        ("struct", "owner") => g.struct_list_by_owner(v, page).await.map(GuildPage::into_response),

        // grid
        ("grid", "object") => g.grid_by_object(v, page).await.map(GuildPage::into_response),
        ("grid", "attribute_type") | ("grid", "attribute-type") => g.grid_by_attribute_type(v, page).await.map(GuildPage::into_response),

        // work
        ("work", "player") => g.work_by_player(v).await,
        ("work", "guild") => g.work_by_guild(v, page).await.map(GuildPage::into_response),

        // infusions
        ("infusion", "player") => g.infusion_by_player(v, page).await.map(GuildPage::into_response),
        ("infusion", "destination") => g.infusion_by_destination(v, page).await.map(GuildPage::into_response),
        ("infusion", "address") => g.infusion_by_address(v, page).await.map(GuildPage::into_response),

        // agreements
        ("agreement", "provider") => g.agreement_by_provider(v, page).await.map(GuildPage::into_response),
        ("agreement", "allocation") => g.agreement_by_allocation(v).await,
        ("agreement", "creator") => g.agreement_by_creator(v).await,
        ("agreement", "owner") => g.agreement_by_owner(v).await,
        ("agreement", "all") | ("agreement", "") => g.agreement_all(page).await.map(GuildPage::into_response),

        // providers
        ("provider", "owner") => g.provider_by_owner(v, page).await.map(GuildPage::into_response),
        ("provider", "denom") => g.provider_by_denom(v, page).await.map(GuildPage::into_response),
        ("provider", "substation") => g.provider_by_substation(v, page).await.map(GuildPage::into_response),
        ("provider", "all") | ("provider", "") => g.provider_all(page).await.map(GuildPage::into_response),

        // attributes
        ("planet_attribute", "object") => g.planet_attribute_by_object(v, page).await.map(GuildPage::into_response),
        ("planet_attribute", "type") => g.planet_attribute_by_type(v, page).await.map(GuildPage::into_response),
        ("struct_attribute", "object") => g.struct_attribute_by_object(v, page).await.map(GuildPage::into_response),
        ("struct_attribute", "type") => g.struct_attribute_by_type(v, page).await.map(GuildPage::into_response),

        // permissions
        ("permission", "object") => g.permission_by_object(v, page).await.map(GuildPage::into_response),
        ("permission", "player") => g.permission_by_player(v, page).await.map(GuildPage::into_response),

        _ => Err(format!(
            "Unsupported filter for type={}: filter.by={} (see structs_query schema for valid pairs)",
            entity, by
        )),
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

            // Decode permission bitmask (25-bit) on permission-specific fields
            for field in &["permissions", "perms", "permission_flags", "val"] {
                let mask = match map.get(*field) {
                    Some(Value::String(s)) => s.parse::<u64>().ok(),
                    Some(Value::Number(n)) => n.as_u64(),
                    _ => None,
                };
                if let Some(mask) = mask {
                    additions.push((
                        format!("{}_decoded", field),
                        Value::String(format::decode_permissions(mask)),
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
