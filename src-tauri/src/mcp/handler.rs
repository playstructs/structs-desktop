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
                "Execute a game action. Handles preflight checks and transaction signing. Actions: explore, build, mine, refine, attack, defend, activate, deactivate, move_fleet, transfer, deploy, raid, update_primary_reactor. Provide action name and args.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "description": "Action to perform",
                            "enum": ["explore", "build", "mine", "refine", "attack", "defend", "activate", "deactivate", "move_fleet", "transfer", "deploy", "raid", "update_primary_reactor", "resync"]
                        },
                        "args": {
                            "type": "object",
                            "description": "Action-specific args. explore: {name?}. build: {struct_type, ambit, slot}. mine/refine: {struct_id}. attack: {attacker_id, target_id, weapon?}. defend: {defender_id, protected_id}. move_fleet: {destination}. transfer: {to, amount}. deploy: {struct_id, ambit, slot}. raid: {target_id}. update_primary_reactor: {reactor_id}. resync: {hard?} (refresh stale game state / reconnect stream)."
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
                "Manage SHA256 proof-of-work hash tasks (~200M h/s on GPU). Commands: 'list' (all tasks + current config), 'start' (begin hashing for a struct), 'progress' (single task detail), 'stop' (cancel), 'config' (tune the hashing engine). For 'start': provide struct_id, task_type (MINE/REFINE/BUILD), block_start, and difficulty_target. For 'config' (omit args to just read current values): 'enabled' (master on/off — false stops all hashing, cancels running tasks, and pauses the task manager), 'engine' (auto|cpu|gpu — force CPU or prefer GPU), 'difficulty_start' (the difficulty a worker waits for before it starts grinding; lower = waits longer for an easier proof), 'max_concurrent' (the task manager's concurrent-job cap).",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["list", "start", "progress", "stop", "config"] },
                        "enabled": { "type": "boolean", "description": "config: master on/off for the hashing system." },
                        "task_id": { "type": "string", "description": "Task/struct ID (e.g., '5-1386'). Required for start/progress/stop." },
                        "task_type": { "type": "string", "enum": ["MINE", "REFINE", "BUILD", "RAID"], "description": "For start command." },
                        "block_start": { "type": "integer", "description": "Block height when task was initiated. For start command." },
                        "difficulty_target": { "type": "integer", "description": "Difficulty target from struct type. For start command." },
                        "target_id": { "type": "string", "description": "Planet ID for RAID tasks (e.g., '2-156'). Only for RAID start." },
                        "engine": { "type": "string", "enum": ["auto", "cpu", "gpu"], "description": "config: hashing engine preference." },
                        "difficulty_start": { "type": "integer", "description": "config: DIFFICULTY_START (1–64) — when a worker begins grinding." },
                        "max_concurrent": { "type": "integer", "description": "config: MAX_CONCURRENT_PROCESSES (1–64) — concurrent hash-job cap." }
                    },
                    "required": ["command"]
                })),
            ),
            Tool::new(
                "structs_intel",
                "Strategic intelligence — covers what you'd otherwise query the DB for. COMBAT/RECON (use these before fighting): 'scout' {location_id} = enemy roster with HP/ambit/slot/weapon-reach + defender ids; 'valid_targets' {attacker,weapon} = reachable targets ranked, with HP + defenders; 'battle_log' {planet_id} = combat RESULTS (damage/blocked/counters/destroyed) — your own attack outcomes; 'ruleset' = weapon+defense matrix (guided/unguided, jam/evade, armour, counter rules); 'simulate' {attacker,target} = expected damage/kill/counter before committing; 'strike_options' {target} = TEAM strike planner — which of your structs (primary + all virtual players) can reach a target and for how much; 'is_active' {player_id} = enemy last-action recency (online?). IDENTITY/PLANNING: 'whoami', 'what_can_i_build', 'economy_status', 'plan_timeline', 'slot_map', 'intents'. ECONOMY/TREND: 'power_forecast', 'planet_history', 'market', 'metric_trend'.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "enum": [
                                "whoami", "intents", "ruleset", "simulate", "strike_options", "what_can_i_build", "power_forecast", "economy_status", "plan_timeline",
                                "planet_history", "valid_targets", "scout", "battle_log", "slot_map", "is_active", "market", "metric_trend"
                            ]
                        },
                        "args": {
                            "type": "object",
                            "description": "Query-specific args. whoami: none. intents: none. ruleset: {struct_type?}. simulate: {attacker, target, weapon?} or {attacker, target_type, target_hp?, target_ambit?, weapon?}. strike_options: {target} (enemy struct id) or {target_type, target_ambit, target_hp?}. power_forecast: {struct_type, count}. planet_history: {planet_id, window_minutes?=60}. valid_targets: {near?, limit?=10, attacker?, weapon?}. scout: {location_id}. battle_log: {planet_id?, category?=struct_attack, struct_id?, limit?=15}. slot_map: {location_id}. is_active: {player_id}. market: {denom?}. metric_trend: {metric, object, window_blocks?=100}."
                        }
                    },
                    "required": ["query"]
                })),
            ),
            Tool::new(
                "structs_policy",
                "Manage standing orders (automation policies). Commands: 'list' (show all policies + recent events), 'set' (enable/configure a policy), 'remove' (delete a policy), 'log' (view event history). Built-in policies: auto_refine, power_alert, agent_ui (master toggle for agent-driven UI).",
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
            Tool::new(
                "structs_ui",
                "Drive the human player's screen for co-op play (the human and you share one session). mode 'notify' shows a surface and returns immediately; mode 'prompt' shows an interactive surface and BLOCKS until the human chooses, returning their selection. Provide `component` = a spec with a `kind`: open_menu {controller,page,options?} (jump to an existing screen); menu {title,items:[{label,value,hint?}]} (a pick-list — prompt returns the chosen value); dialogue {title,message,buttons:[{label,value}]}; panel {title,placement?,theme?,body:[...]} (custom side panel); info {title,rows:[{key,value}]}; map_preview {planet_id,defender_id?,attacker_id?} (show another player's map); hud_badge {id,label,value,theme?} (add/update a HUD badge; same id updates, dismiss removes); toast {title,body,level?}; raw_html {title,html} (escape hatch); dismiss {target_id}. UI is display/elicitation only — it cannot sign; act on the human's choice via structs_action. Respects the agent_ui master toggle.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "mode": { "type": "string", "enum": ["notify", "prompt"], "description": "notify = show-and-return; prompt = block for the human's choice." },
                        "component": { "type": "object", "description": "Declarative component spec with a `kind` field (see tool description)." },
                        "timeout_secs": { "type": "number", "description": "prompt only: seconds to wait for the human (default 180, clamped 10–600)." }
                    },
                    "required": ["component"]
                })),
            ),
            Tool::new(
                "structs_events",
                "Live event feed from the NATS stream, PLUS `tx_settled` receipts for actions you submitted (real tx hash, chain code, status succeeded/dropped). Real combat surfaces as `struct_health` (health/health_old + struct_id) and `struct_status`, with `shield_change`, `struct_block_build_start`, `fleet_arrive`/`fleet_depart`, `raid_status`, `player_consensus`, `lastAction`, etc. — there is NO `struct_attack` category here (use structs_intel battle_log for your own attack outcomes). React to events instead of polling. Pass 'wait_secs' to long-poll (blocks until a new event after 'since', or the wait elapses). 'mine_only' matches your player/planet/fleet/struct ids in the subject OR detail (so your structs taking damage show even when the event is keyed to an enemy planet). 'category' filters by type (e.g. 'struct_health', 'tx_settled', 'raid_status'). Page forward with the returned 'next_cursor' as 'since'.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "since": { "type": "number", "description": "Only events newer than this timestamp (ms). Use the prior call's next_cursor." },
                        "category": { "type": "string", "description": "Filter to one category, e.g. 'struct_attack', 'raid_status', 'fleet_arrive'." },
                        "mine_only": { "type": "boolean", "description": "Only events referencing your player/planet/fleet." },
                        "limit": { "type": "number", "description": "Max events to return (default 30)." },
                        "wait_secs": { "type": "number", "description": "Long-poll: wait up to N seconds (0–55) for a new event. 0 = return immediately." }
                    }
                })),
            ),
            Tool::new(
                "structs_sequence",
                "Run a guarded autonomous action chain (e.g. strip blockers → kill the Command Ship), paced to the charge cooldown, aborting if a safety predicate trips. Each step is a normal structs_action, so this adds no new signing authority — it's manual play with rails. Provide 'steps' (ordered {action,args}) and optional 'abort_if' ({cmd_hp_below, stop_if_offline}). Pass 'as' (a virtual player index/address/id) to run the whole chain AS that player, signed by its own key. It waits out charge cooldowns up to 'max_wait_secs' then pauses so you can resume.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "description": "Ordered actions: [{action, args}]. Same shape as structs_action.",
                            "items": { "type": "object" }
                        },
                        "abort_if": {
                            "type": "object",
                            "description": "Safety predicates checked before/while each step (primary player only). {cmd_hp_below: number, stop_if_offline: bool}."
                        },
                        "max_wait_secs": { "type": "number", "description": "Total charge-wait budget across the sequence (0–300, default 180)." },
                        "as": { "type": "string", "description": "Optional: run the chain as a virtual player (index, address, or player id). abort_if is not yet evaluated for virtual-player sequences." }
                    },
                    "required": ["steps"]
                })),
            ),
            Tool::new(
                "structs_players",
                "Manage agent-controlled virtual players — extra Structs players derived from the SAME mnemonic at different HD indices, joined to your guild (the guild fronts the join fee; no alpha needed). Keys never leave the app. Commands: 'list' (registry + status); 'roster' (TEAM overview — the primary player + every virtual player in one view: planet/fleet/struct count/resources); 'create' {name, index?} (derive a new address, guild-signup, register; defaults to next free HD index ≥ 1); 'state' {player} (a virtual player's on-chain state — structs/HP/charge/resources — from LCD + grass); 'act' {player, action, args} (perform a game action AS that virtual player, signed by its own key). Direct actions: explore/build/activate/deactivate/deploy/defend/attack. PoW actions (mine/refine/raid) start a hash and auto-sign the completion as the player.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["list", "roster", "create", "state", "act"] },
                        "name": { "type": "string", "description": "create: display name (3–20 chars: letters/digits/-/_)." },
                        "index": { "type": "integer", "description": "create: HD index to use (>= 1); defaults to next free." },
                        "player": { "type": "string", "description": "state/act: which virtual player — index, address, or player id." },
                        "action": { "type": "string", "description": "act: explore|build|activate|deactivate|deploy|defend|attack (direct) | mine|refine|raid (PoW, auto-completes)." },
                        "args": { "type": "object", "description": "act: action args (same shapes as structs_action; e.g. attack {attacker_id,target_id,weapon}, build {struct_type,ambit,slot})." }
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
                "structs_ui" => {
                    let params: tools::ui::UiParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::ui::execute(&self.app_handle, params).await
                }
                "structs_events" => {
                    let params: tools::events::EventParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::events::execute(params).await
                }
                "structs_sequence" => {
                    let params: tools::sequence::SequenceParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::sequence::execute(&self.app_handle, &self.cosmos_client, &self.task_registry, params).await
                }
                "structs_players" => {
                    let params: tools::players::PlayerParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::players::execute(&self.app_handle, &self.cosmos_client, &self.task_registry, params).await
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
