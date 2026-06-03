use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, GetPromptRequestParams, GetPromptResult,
    ListPromptsResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
    RawResource, ReadResourceRequestParams, ReadResourceResult, ResourceContents,
    ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::Value;
use std::sync::Arc;

use crate::hasher::types::TaskRegistry;
use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::resources::CompendiumIndex;
use crate::mcp::tools;

#[derive(Clone)]
pub struct StructsMcpHandler {
    pub cosmos_client: CosmosClient,
    pub task_registry: Arc<TaskRegistry>,
    pub app_handle: tauri::AppHandle,
    pub compendium: Arc<CompendiumIndex>,
}

impl StructsMcpHandler {
    pub fn new(task_registry: Arc<TaskRegistry>, app_handle: tauri::AppHandle) -> Self {
        Self {
            cosmos_client: CosmosClient::new(),
            task_registry,
            app_handle,
            compendium: Arc::new(CompendiumIndex::new()),
        }
    }

    fn tool_definitions() -> Vec<Tool> {
        fn schema(json: Value) -> Arc<serde_json::Map<String, Value>> {
            Arc::new(serde_json::from_value(json).unwrap())
        }

        vec![
            Tool::new(
                "structs_action",
                "Execute a game action. Handles preflight checks and transaction signing. Actions: explore, build, mine, refine, attack, defend, activate, deactivate, move_fleet, transfer, deploy. Provide action name and args.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "description": "Action to perform",
                            "enum": ["explore", "build", "mine", "refine", "attack", "defend", "activate", "deactivate", "move_fleet", "transfer", "deploy"]
                        },
                        "args": {
                            "type": "object",
                            "description": "Action-specific args. explore: {name?}. build: {struct_type, ambit, slot}. mine/refine: {struct_id}. attack: {attacker_id, target_id, weapon?}. defend: {defender_id, protected_id}. move_fleet: {destination}. transfer: {to, amount}. deploy: {struct_id, ambit, slot}."
                        }
                    },
                    "required": ["action"]
                })),
            ),
            Tool::new(
                "structs_query",
                "Query or list any game entity. Three modes: (1) provide 'id' to read one entity by ID via Cosmos LCD. (2) Omit 'id' and 'filter' to list all of a type via LCD with pagination_key. (3) Provide 'filter' for filtered queries via the Guild API (e.g., {type:'planet_activity', filter:{by:'planet', value:'2-5'}}). Filtered responses include _next_page when more pages exist.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "description": "Entity type. Core (LCD): player, planet, struct, struct_type, fleet, guild, reactor, substation, provider, agreement, allocation. Extended (Guild API, requires filter): planet_activity, struct_defender, work, grid, infusion, planet_attribute, struct_attribute, permission.",
                            "enum": [
                                "player", "planet", "struct", "struct_type", "fleet", "guild",
                                "reactor", "substation", "provider", "agreement", "allocation",
                                "planet_activity", "struct_defender", "work", "grid",
                                "infusion", "planet_attribute", "struct_attribute", "permission"
                            ]
                        },
                        "id": { "type": "string", "description": "Entity ID (e.g., '1-18'). Omit to list all or use filter." },
                        "pagination_key": { "type": "string", "description": "LCD opaque pagination key (list mode only)." },
                        "limit": { "type": "integer", "description": "LCD page size (default 100)." },
                        "filter": {
                            "type": "object",
                            "description": "Filtered query via Guild API. Valid (type, by) pairs: planet_activity+(planet|category|all); struct_defender+(defending|protected); struct+(location|owner); grid+(object|attribute_type); work+(player|guild); infusion+(player|destination|address); agreement+(provider|allocation|creator|owner|all); provider+(owner|denom|substation|all); planet_attribute+(object|type); struct_attribute+(object|type); permission+(object|player).",
                            "properties": {
                                "by": { "type": "string" },
                                "value": { "type": "string" }
                            },
                            "required": ["by", "value"]
                        },
                        "page": { "type": "integer", "description": "1-indexed page for filtered queries (default 1)." }
                    },
                    "required": ["type"]
                })),
            ),
            Tool::new(
                "structs_dashboard",
                "Full player overview: state, power, structs, fleet, active hash tasks, resources.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "player_id": { "type": "string", "description": "Player ID (e.g., '1-18')" }
                    },
                    "required": ["player_id"]
                })),
            ),
            Tool::new(
                "structs_hash",
                "Manage SHA256 proof-of-work hash tasks (~200M h/s on GPU). Commands: 'list' (all tasks), 'start' (begin hashing for a struct), 'progress' (single task detail), 'stop' (cancel). For 'start': provide struct_id, task_type (MINE/REFINE/BUILD), block_start (block height when task initiated), and difficulty_target.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["list", "start", "progress", "stop"] },
                        "task_id": { "type": "string", "description": "Task/struct ID (e.g., '5-1386'). Required for start/progress/stop." },
                        "task_type": { "type": "string", "enum": ["MINE", "REFINE", "BUILD", "RAID"], "description": "For start command." },
                        "block_start": { "type": "integer", "description": "Block height when task was initiated. For start command." },
                        "difficulty_target": { "type": "integer", "description": "Difficulty target from struct type. For start command." },
                        "target_id": { "type": "string", "description": "Planet ID for RAID tasks (e.g., '2-156'). Only for RAID start." }
                    },
                    "required": ["command"]
                })),
            ),
            Tool::new(
                "structs_intel",
                "Strategic intelligence. Local-only queries (no API): 'what_can_i_build', 'economy_status', 'plan_timeline'. Guild-API-backed (degrade gracefully if offline / not signed in): 'power_forecast' (snapshot + trend), 'planet_history', 'valid_targets', 'scout', 'market', 'metric_trend'.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "enum": [
                                "what_can_i_build", "power_forecast", "economy_status", "plan_timeline",
                                "planet_history", "valid_targets", "scout", "market", "metric_trend"
                            ]
                        },
                        "args": {
                            "type": "object",
                            "description": "Query-specific args. power_forecast: {struct_type, count}. planet_history: {planet_id, window_minutes?=60}. valid_targets: {near?, limit?=10}. scout: {location_id}. market: {denom?}. metric_trend: {metric, object, window_blocks?=100}."
                        }
                    },
                    "required": ["query"]
                })),
            ),
            Tool::new(
                "structs_policy",
                "Manage standing orders (automation policies). Commands: 'list' (show all policies + recent events), 'set' (enable/configure a policy), 'remove' (delete a policy), 'log' (view event history). Built-in policies: auto_refine, power_alert, never_build_unsafe, auto_defend, sequence_retry.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["list", "set", "remove", "log"] },
                        "policy": { "type": "string", "description": "Policy name (for set/remove)." },
                        "enabled": { "type": "boolean", "description": "Enable/disable (for set)." },
                        "config": { "type": "object", "description": "Policy-specific config (for set). e.g., {threshold_pct: 80} for power_alert." }
                    },
                    "required": ["command"]
                })),
            ),
        ]
    }
}

impl ServerHandler for StructsMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Structs Desktop MCP Server. Start with structs_dashboard (no arguments needed — \
                 the player ID is auto-detected). Use structs_hash to manage proof-of-work, \
                 structs_action for game actions, structs_intel for strategic analysis, \
                 and structs_policy for automation."
                    .into(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_prompts()
                .enable_resources()
                .build(),
            ..Default::default()
        }
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + Send + '_ {
        async {
            let mut result = ListToolsResult::default();
            result.tools = Self::tool_definitions();
            Ok(result)
        }
    }

    fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListPromptsResult, McpError>> + Send + '_ {
        async {
            let mut result = ListPromptsResult::default();
            result.prompts = crate::mcp::prompts::list();
            Ok(result)
        }
    }

    fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<GetPromptResult, McpError>> + Send + '_ {
        async move {
            let args: Option<std::collections::HashMap<String, String>> = request.arguments.map(|a| {
                a.into_iter()
                    .map(|(k, v)| (k.to_string(), v.as_str().unwrap_or("").to_string()))
                    .collect()
            });
            crate::mcp::prompts::get(&request.name, args)
                .map_err(|e| McpError::invalid_params(e, None))
        }
    }

    fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListResourcesResult, McpError>> + Send + '_ {
        async {
            let mut result = ListResourcesResult::default();
            result.resources = self
                .compendium
                .list_all()
                .into_iter()
                .map(|(uri, name, description)| {
                    rmcp::model::Annotated {
                        raw: RawResource {
                            uri,
                            name,
                            title: None,
                            description: Some(description),
                            mime_type: Some("text/markdown".to_string()),
                            size: None,
                            icons: None,
                            meta: None,
                        },
                        annotations: None,
                    }
                })
                .collect();
            Ok(result)
        }
    }

    fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ReadResourceResult, McpError>> + Send + '_ {
        async move {
            let uri = &request.uri;
            match self.compendium.read_by_uri(uri) {
                Some(content) => Ok(ReadResourceResult {
                    contents: vec![ResourceContents::TextResourceContents {
                        uri: uri.to_string(),
                        mime_type: Some("text/markdown".to_string()),
                        text: content,
                        meta: None,
                    }],
                }),
                None => Err(McpError::invalid_params(
                    format!("Resource not found: {}", uri),
                    None,
                )),
            }
        }
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + Send + '_ {
        async move {
            let name = &request.name;
            let args: Value = request
                .arguments
                .map(|a| serde_json::to_value(a).unwrap_or_default())
                .unwrap_or_default();

            let content = match name.as_ref() {
                "structs_action" => {
                    let params: tools::action::ActionParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::action::execute(&self.app_handle, &self.task_registry, params).await
                }
                "structs_query" => {
                    let params: tools::query::QueryParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::query::execute(&self.cosmos_client, params).await
                }
                "structs_dashboard" => {
                    let params: tools::dashboard::DashboardParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::dashboard::execute(&self.cosmos_client, &self.task_registry, params)
                        .await
                }
                "structs_hash" => {
                    let params: tools::hasher::HashParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::hasher::execute(&self.task_registry, &self.app_handle, params).await
                }
                "structs_intel" => {
                    let params: tools::intel::IntelParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::intel::execute(&self.cosmos_client, &self.task_registry, params).await
                }
                "structs_policy" => {
                    let params: tools::policy::PolicyParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::policy::execute(params).await
                }
                _ => vec![Content::text(format!("Unknown tool: {}", name))],
            };

            Ok(CallToolResult {
                content,
                structured_content: None,
                is_error: None,
                meta: None,
            })
        }
    }
}
