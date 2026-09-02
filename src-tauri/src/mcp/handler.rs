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
                        "max_concurrent": { "type": "integer", "description": "config: MAX_CONCURRENT_PROCESSES (1–64) — concurrent hash-job cap." },
                        "auto_tune": { "type": "boolean", "description": "config: adaptive tuner — steers difficulty_start/max_concurrent from measured solve history (runtime-only; your configured values stay the restart baseline)." }
                    },
                    "required": ["command"]
                })),
            ),
            Tool::new(
                "structs_intel",
                "Strategic intelligence — covers what you'd otherwise query the DB for. COMBAT/RECON (use these before fighting): 'scout' {location_id} = enemy roster with HP/ambit/slot/weapon-reach + defender ids; 'valid_targets' {attacker,weapon} = reachable targets ranked, with HP + defenders; 'battle_log' {planet_id} = combat RESULTS (damage/blocked/counters/destroyed) — your own attack outcomes; 'ruleset' = weapon+defense matrix (guided/unguided, jam/evade, armour, counter rules); 'simulate' {attacker,target} = expected damage/kill/counter before committing; 'strike_options' {target} = TEAM strike planner — which of your structs (primary + all virtual players) can reach a target and for how much; 'is_active' {player_id} = enemy last-action recency (online?); 'raid_readiness' {player?, only_gaps?, limit?} = DEFENSIVE audit — for each ambit a raider's Command Ship could occupy, can each roster player's OWN fleet reach it (READY/PARTIAL/BLIND)? A BLIND player can never answer a raid, and fleet slots only free when a hull is destroyed, so check this BEFORE you are raided. IDENTITY/PLANNING: 'whoami', 'what_can_i_build', 'economy_status', 'plan_timeline', 'slot_map', 'intents'. ECONOMY/TREND: 'power_forecast', 'planet_history', 'market', 'metric_trend'. RAW DATA: 'query' {type, id?, filter?} = raw entity read/list/filtered query (LCD + Guild API) when no curated view fits — args: {type: player|planet|struct|struct_type|fleet|guild|reactor|substation|provider|agreement|allocation|planet_activity|struct_defender|work|grid|infusion|planet_attribute|struct_attribute|permission, id? (read one), pagination_key?/limit? (list), filter?:{by,value} + page? (Guild API; pairs like planet_activity+planet, struct_defender+protected, work+player, permission+object)}.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "enum": [
                                "whoami", "intents", "ruleset", "simulate", "strike_options", "what_can_i_build", "power_forecast", "economy_status", "plan_timeline",
                                "planet_history", "valid_targets", "scout", "raid_readiness", "battle_log", "slot_map", "is_active", "market", "metric_trend", "query"
                            ]
                        },
                        "args": {
                            "type": "object",
                            "description": "Query-specific args. whoami: none. intents: none. ruleset: {struct_type?}. simulate: {attacker, target, weapon?} or {attacker, target_type, target_hp?, target_ambit?, weapon?}. strike_options: {target} (enemy struct id) or {target_type, target_ambit, target_hp?}. power_forecast: {struct_type, count}. planet_history: {planet_id, window_minutes?=60}. valid_targets: {near?, limit?=10, attacker?, weapon?}. scout: {location_id}. raid_readiness: {player?, only_gaps?=false, limit?=25}. battle_log: {planet_id?, category?=struct_attack, struct_id?, limit?=15}. slot_map: {location_id}. is_active: {player_id}. market: {denom?}. metric_trend: {metric, object, window_blocks?=100}. query (raw): {type, id?, pagination_key?, limit?, filter?:{by,value}, page?}."
                        }
                    },
                    "required": ["query"]
                })),
            ),
            Tool::new(
                "structs_policy",
                "Manage standing orders (automation policies). Commands: 'list' (show all policies + recent events), 'set' (enable/configure a policy), 'remove' (delete a policy), 'log' (view event history). Built-in policies: auto_refine, power_alert, combat_alert, agent_ui (master toggle for agent-driven UI), auto_counterattack, auto_retreat_if_cmd_below, auto_rebuild_losses, rules_of_engagement, primary_home_guard, board_auto_open, watchdog_remediate (self-healing for stuck loops/hashers/sync).",
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
                "structs_events",
                "Live event feed from the NATS stream, PLUS `tx_settled` receipts for actions you submitted (real tx hash, chain code, status succeeded/dropped). Real combat surfaces as `struct_health` (health/health_old + struct_id) and `struct_status`, with `shield_change`, `struct_block_build_start`, `fleet_arrive`/`fleet_depart`, `raid_status`, `player_consensus`, `lastAction`, etc. — there is NO `struct_attack` category here (use structs_intel battle_log for your own attack outcomes). React to events instead of polling. Pass 'wait_secs' to long-poll (blocks until a new event after 'since', or the wait elapses). 'mine_only' matches your player/planet/fleet/struct ids in the subject OR detail (so your structs taking damage show even when the event is keyed to an enemy planet). 'category' filters by type (e.g. 'struct_health', 'tx_settled', 'raid_status'). 'threats_only' is a SENTINEL: it server-side classifies your events into threats (raid armed / struct lost / taking damage / hostile inbound / shield drop) and returns only those, highest-priority first — with 'wait_secs' it blocks until you're actually attacked, so a thin loop on it is a real-time under-attack detector. Page forward with the returned 'next_cursor' as 'since'.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "since": { "type": "number", "description": "Only events newer than this timestamp (ms). Use the prior call's next_cursor." },
                        "category": { "type": "string", "description": "Filter to one category, e.g. 'struct_attack', 'raid_status', 'fleet_arrive'." },
                        "mine_only": { "type": "boolean", "description": "Only events referencing your player/planet/fleet." },
                        "threats_only": { "type": "boolean", "description": "SENTINEL mode: classify your events as threats (raid_armed/struct_lost/taking_damage/hostile_inbound/shield_drop) and return only those, highest-priority first. With wait_secs, blocks until a real threat lands — a ready-made under-attack detector." },
                        "team": { "type": "boolean", "description": "Widen mine_only/threats_only from just the primary player to the WHOLE team (primary + every virtual player's planet/fleet), so one sentinel watches the bait fleet. Threats are tagged with which player was hit." },
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
                "Manage agent-controlled virtual players — extra Structs players derived from the SAME mnemonic at different HD indices, joined to your guild (the guild fronts the join fee; no alpha needed). Keys never leave the app. Commands: 'list' (registry + status); 'roster' (TEAM overview — the primary player + every virtual player in one view: planet/fleet/struct count/resources); 'create' {name, index?} (derive a new address, guild-signup, register; defaults to next free HD index ≥ 1); 'state' {player} (a virtual player's on-chain state — structs/HP/charge/resources — from LCD + grass); 'act' {player, action, args} (perform a game action AS that virtual player, signed by its own key). Direct actions: explore/build/activate/deactivate/deploy/defend/attack. PoW actions (mine/refine/raid, complete_build) start a hash and auto-sign the completion as the player. Building a struct is two steps: 'build' {struct_type, ambit, slot} initiates, then 'complete_build' {struct_id} runs the build proof to finish it. For any message without a named action, use action 'tx' {type_url, msg} to sign it directly (creator is injected; enum names/string-numbers are normalized). 'capacity' (read-only guild power-budget: how many more players the entry substation can power); 'role' {player, role: bait|productive} (a vplayer's purpose — bait mines so ore piles up as raid bait; productive runs the flywheel); 'economy' (planner: names each productive vplayer's next step mine→refine→send alpha to primary, which infuses the reactor); 'profile' {args:{action:list|show|fork|rename|set|delete|assign, id?, from?, player?, profile?}} (BEHAVIOUR PROFILES — a player-authored bundle of loadout + capabilities + temperament that replaces the hardcoded bait/productive/raider roles. 'list' shows built-ins and custom; 'show' renders one WITH a preview of what it would actually build and which ambits it answers; 'fork' copies a built-in under a new id; 'assign' points a vplayer at one. Built-ins cannot be edited or deleted — fork them). 'variance' {args:{preset?:off|measured|human|wild, enabled?, raider?:{temperature,mistake_rate,hesitate_min_ms,hesitate_max_ms}, bait?, productive?}} (BEHAVIOURAL PROFILE — how much the bots vary when they have a choice; temperature 0 = always the best move, higher = sampled from the good ones, mistake_rate = chance of a deliberately worse but legal move. Hard safety gates are never sampled). 'infra' {args:{mode:hub|direct, infuse_ualpha?, keep_w?}, player?} (guided 'owned hub' infrastructure plan — emits the exact infuse→allocate→substation→feed-guild-pool tx sequence with computed amounts + dilution math; advisory, spends real alpha so you execute it; pass player:<vplayer> as host to get ready-to-run raw `act {tx}` calls); 'harvest' {args:{enabled, difficulty, interval_secs, refine, include_primary, now}} (configure the NATIVE auto-harvest loop — it auto-mines/refines each owned struct once its PoW difficulty decays to ≤ the threshold, so you never have to ask; higher difficulty = more aggressive; `auto_explore` re-explores a mined-out planet (destroys old planetary structs, auto-build rebuilds); off until enabled); 'autobuild' {args:{enabled, complete_difficulty, interval_secs, include_primary, now}} (NATIVE auto-FILL loop — builds out each vplayer's free slots one charge-paced build/scan with a defensive loadout (OSG shields → fleet defenders → Ore Bunkers, power-gated) and auto-completes them; idles when full; off until enabled); 'infuse' {args:{keep_grams, enabled, now}} (configurable rule to grow the PRIMARY's own capacity: keep N grams of Alpha in reserve and infuse the rest into the guild reactor — signed as the primary via HD index 0; `now` runs it once, `enabled` auto-runs it); 'autoresponse' {args:{enabled, autonomy:advise|auto, mode:harden|counter|decapitate, max_shots_per_incident, max_shots_per_hour, incident_cooldown_secs, panic_refine, prefer_counter_free_ambit, include_primary_shooters, dry_run, now}} (NATIVE raid-RESPONSE loop — on a raid alarm it identifies the attacker, records a persistent grudge, refines the threatened ore, and fires every co-located shooter at the raider's Command Ship; killing it ends the raid outright. The whole window is ~4 minutes, so it reacts on the alarm, not on damage. Off until enabled, and `advise` until you say otherwise); 'autoraid' {args:{enabled, autonomy, posture:cautious|opportunist|aggressive, min_ore, min_score, max_raid_minutes, max_defenders, require_vulnerable_now, allow_siege, skip_if_defender_active_mins, raid_hours_utc, w_ore/w_vulnerability/w_weakness/w_grudge/w_guild/w_speed/w_history, max_concurrent_raids, target_cooldown_mins, abort_cmd_hp_below, raider_players, dry_run, now}} (NATIVE raid TARGETING loop — scores every reachable player on stored ore × vulnerability × weakness × grudge and dispatches a `raider` vplayer, never the primary. A raid seizes ALL of the target's stored ore, and only vulnerable targets can be raided at all, so those two dominate the score. Off until enabled).",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["list", "roster", "create", "state", "act", "capacity", "role", "economy", "infra", "harvest", "autobuild", "autodefend", "autoresponse", "autoraid", "infuse", "variance", "profile"] },
                        "name": { "type": "string", "description": "create: display name (3–20 chars: letters/digits/-/_)." },
                        "index": { "type": "integer", "description": "create: HD index to use (>= 1); defaults to next free." },
                        "guild_id": { "type": "string", "description": "create: guild the new player must join (e.g. \"0-5\"). Errors if it differs from the active infrastructure guild — switch guilds first for cross-guild signup. Defaults to the active guild." },
                        "player": { "type": "string", "description": "state/act/role: which virtual player — index, address, or player id." },
                        "role": { "type": "string", "enum": ["bait", "productive", "raider"], "description": "role: a vplayer's purpose — bait (mine-only, ore piles up as raid bait), productive (runs the flywheel via economy), or raider (expendable offensive arm auto_raid flies; keeps a refinery to launder seized ore). Also accepted by create." },
                        "action": { "type": "string", "description": "act: explore|build|activate|deactivate|deploy|defend|attack|player_send (direct) | mine|refine|raid (PoW, auto-completes)." },
                        "args": { "type": "object", "description": "act: action args (same shapes as structs_action; e.g. attack {attacker_id,target_id,weapon}, build {struct_type,ambit,slot}, player_send {to,amount})." }
                    },
                    "required": ["command"]
                })),
            ),
            Tool::new(
                "structs_map",
                "Render a planet's map to a PNG (or animated GIF) using the game's OWN renderer (off-screen preview map → html-to-image): real terrain, struct sprites, and HP bars — no screen capture. Provide 'planet_id' (e.g. \"2-239\") or 'player' (index/address/player id, incl. virtual players). format 'gif' captures the animated Lottie struct sprites over several frames. Writes to the app data dir and returns the file path.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "planet_id": { "type": "string", "description": "Planet id, e.g. \"2-239\"." },
                        "player": { "type": "string", "description": "Player whose planet to render (index/address/player id) — used when planet_id is omitted." },
                        "format": { "type": "string", "enum": ["png", "gif"], "description": "png (default) or gif (animated)." },
                        "frames": { "type": "integer", "description": "gif: frame count (2–60, default 12)." },
                        "interval_ms": { "type": "integer", "description": "gif: ms per frame (default 120)." }
                    }
                })),
            ),
            Tool::new(
                "structs_board",
                "Team operations board + human-facing UI surfaces (one tool for everything the human sees). DEFAULT (no component): renders the at-a-glance command view shared by the human and the agent — primary status (charge readiness, power margin, structs online, ore/alpha), virtual-player count, the team-wide PoW queue, active threats across the whole team (last ~2 min), and recommended next moves. The window also hosts the EVENT FEED (auto-loops, policy events, threats pipe in automatically); Important entries auto-open the window ONLY if the player opted in via `structs_policy set board_auto_open true`. Pass 'open':true ONCE to pop the native window. COMPONENT MODE (absorbed from the retired structs_ui): pass `component` = a spec with a `kind` to show the human a surface — open_menu {controller,page,options?}; menu {title,items:[{label,value,hint?}]}; dialogue {title,message,buttons}; panel {title,placement?,theme?,body}; info {title,rows}; map_preview {planet_id,...}; hud_badge {id,label,value,theme?}; toast {title,body,level?}; raw_html {title,html}; dismiss {target_id}. mode 'notify' shows-and-returns; 'prompt' BLOCKS until the human chooses and returns their selection. Toasts/dialogues render in the Team Ops window; only open_menu/map_preview touch the main game view. Display/elicitation only — it cannot sign; act on choices via structs_action. Respects the agent_ui master toggle.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "open": { "type": "boolean", "description": "Pop the board out as a separate OS window (default browser). Do this once; later calls just refresh the open window." },
                        "push": { "type": "boolean", "description": "Pipe a one-line board summary into the Team Ops event feed (default false; never renders in the main game window)." },
                        "component": { "type": "object", "description": "Declarative component spec with a `kind` field (see tool description). When present, shows this surface instead of rendering the ops board." },
                        "mode": { "type": "string", "enum": ["notify", "prompt"], "description": "component only: notify = show-and-return (default); prompt = block for the human's choice." },
                        "timeout_secs": { "type": "number", "description": "component prompt only: seconds to wait for the human (default 180, clamped 10–600)." },
                        "web": { "type": "string", "enum": ["status", "on", "off"], "description": "Web dashboard control (OPT-IN, default off): 'status' reports state + the shareable browser URL for the SAME Team Ops board (token-authenticated; the token grants full operator control — treat like a password); 'on'/'off' toggles serving. Remote humans reach it via their own tunnel to 127.0.0.1:<port> (e.g. ssh -L). Share the URL with your human to play together." }
                    }
                })),
            ),
            Tool::new(
                "structs_doctrine",
                "Standing rules of engagement + a per-tick executor — the co-op autonomy loop. 'set' stores the doctrine once (posture: defensive|aggressive|raid; pinned_target; auto_counter; retreat_cmd_below; autonomy: advise|auto) and flips the matching combat policies. NEW-PLAYER SHORTCUT: 'set' with preset 'turtle' (max defense: auto_build + auto_defend + home guard + counter), 'economy' (mine→refine→infuse flywheel, combat notify-only), or 'balanced', or 'warfighter' (turtle + both autonomous combat loops, armed but advising) configures a coherent bundle of loops + policies in ONE call — explicit fields override the preset. 'show' displays it. 'lists' reads and edits the persistent combat lists both combat loops consult — {list_action: show|add|remove|mute|unmute, kind: grudge|priority_guild|ally|protected, id, weight?, note?}. Grudges are appended automatically by auto_response on every confirmed attack and can also be added by hand for a player who has never touched you; priority_guild biases every member of a guild; ally/protected are HARD vetoes on TARGET SELECTION — auto_raid will not start a raid against them (your own guild is seeded on first run), but they never restrain auto_response: anyone who raids us gets fought with everything available, guild-mate or not. 'tick' reads the doctrine against live state (threats, charge, Command-Ship HP) and returns the prioritized next move WITHIN the mandate (retreat > defend > attack > hold). Run 'tick' on a loop and the agent holds the watch — executing via the action/strike tools and escalating to a human prompt for anything beyond the standing orders. Persists in the rules_of_engagement policy (visible via structs_intel intents).",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["set", "show", "tick", "lists"], "description": "set | show | tick | lists" },
                        "preset": { "type": "string", "enum": ["turtle", "economy", "balanced", "warfighter"], "description": "set: one-call config bundle (loops + policies + doctrine). Explicit fields override it." },
                        "list_action": { "type": "string", "enum": ["show", "add", "remove", "mute", "unmute"], "description": "lists: what to do (default show)." },
                        "kind": { "type": "string", "enum": ["grudge", "priority_guild", "ally", "protected"], "description": "lists: which list (default grudge)." },
                        "id": { "type": "string", "description": "lists: player id for grudge/protected, guild id for priority_guild/ally." },
                        "weight": { "type": "number", "description": "lists: priority multiplier (0-10, default 1) for a grudge or guild." },
                        "note": { "type": "string", "description": "lists: free-text reason shown on the WAR page." },
                        "posture": { "type": "string", "enum": ["defensive", "aggressive", "raid"], "description": "set: overall stance." },
                        "pinned_target": { "type": "string", "description": "set: enemy struct id to focus offense on (kill-chain target)." },
                        "auto_counter": { "type": "boolean", "description": "set: counter when attacked (drives auto_counterattack)." },
                        "retreat_cmd_below": { "type": "integer", "description": "set: retreat the fleet when Command Ship HP drops below this." },
                        "autonomy": { "type": "string", "enum": ["advise", "auto"], "description": "set: advise (tick recommends; agent executes) or auto (defensive responses fire without confirmation; offense still prompts)." }
                    },
                    "required": ["command"]
                })),
            ),
            Tool::new(
                "structs_strike",
                "Coordinated TEAM attack + kill-chain. COUNTERS HURT: a defended target counters every shot — a Command Ship was observed returning 2 dmg per hit, which killed two of three 3 HP attacking Tanks over four shots. Budget attackers for losses, not just for the target's HP. A real attack does 1–3, and the primary + every virtual player each has its OWN charge bar — so this concentrates the whole team's firepower on ONE target in a single command. It picks each player's single BEST reaching weapon (one shot per charge bar) and fires — primary via the signing queue, virtual players via their own keys. KILL-CHAIN (strip_blockers, default on): you can't damage a struct through its same-ambit blockers, so it redirects fire to the current blocker; re-invoking each charge cycle walks strip→kill→(raid window). Use 'dry_run' to preview the barrage + projected damage and whether it's a KILL.",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "target": { "type": "string", "description": "Enemy struct id to kill (e.g. their Command Ship \"5-2217\"). Fire auto-redirects to same-ambit blockers first." },
                        "max": { "type": "integer", "description": "Cap the number of attackers (default: all reachable, one per player)." },
                        "dry_run": { "type": "boolean", "description": "Plan only — show who would fire, the phase (STRIP/KILL), and projected damage, without attacking." },
                        "strip_blockers": { "type": "boolean", "description": "Kill-chain mode (default true): redirect fire to the target's same-ambit blockers until it's exposed. Set false to fire directly at the target regardless." }
                    },
                    "required": ["target"]
                })),
            ),
            Tool::new(
                "structs_system",
                "System health, logs, and self-tuning — is the automation healthy, and if not, why. Commands: 'status' (one-page health: watchdog snapshot, per-loop last run/duration/error rate, tx success rate, live adaptive values, telemetry stats — START HERE when anything seems off); 'logs' {component?, severity?, since_ms?, limit?} (the app's persistent structured log — components: auto_build/auto_harvest/auto_defend/auto_infuse/tx/vplayer/policy/conn/watchdog/hasher); 'loops' (per-loop liveness/throughput over window_minutes); 'tx' (transaction-attempt ledger summary: successes/failures/skips per context + top error reasons — auto-loop failures are visible here, nothing is silently dropped); 'pow' (proof-of-work solve stats per engine: median/p90 durations, est. hashrate); 'watchdog' (recent findings + remediations, e.g. wedged loops reset, stalled hash tasks cancelled); 'feed' (the Team Ops board event feed); 'config' (read adaptive values + signing knobs; set {remediate:bool} to toggle self-healing, {sign_mode:'sync'|'async'} — async returns after mempool acceptance (~0.2 s vs ~6 s inclusion wait) and settles via tx_settled events, {tx_gate_cap:1..32} concurrent signs — change one at a time and watch 'tx' duration/failures); 'perception' (the shared whole-galaxy snapshot the loops will scan from: height, age, object counts, GRASS deltas applied/skipped, structs awaiting a read; set {refresh:true} to pull a fresh snapshot now — ~11 bulk LCD requests, ~8 s). The system self-adapts: loop concurrency AIMD-halves under endpoint pressure and recovers on clean scans; the watchdog auto-heals stuck processes (logged, never silent).",
                schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "enum": ["status", "logs", "loops", "tx", "pow", "watchdog", "feed", "config", "perception"] },
                        "component": { "type": "string", "description": "logs: filter to one component (e.g. 'auto_build', 'tx', 'watchdog')." },
                        "severity": { "type": "string", "enum": ["debug", "info", "notice", "warn", "error"], "description": "logs: minimum severity." },
                        "since_ms": { "type": "number", "description": "logs: only events at/after this ms epoch." },
                        "limit": { "type": "integer", "description": "logs/feed: max rows (default 50)." },
                        "window_minutes": { "type": "integer", "description": "loops/tx/pow/watchdog: lookback window (default 60)." },
                        "set": { "type": "object", "description": "config: values to change, e.g. {\"remediate\": false}." }
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
                 structs_action for game actions, structs_intel for strategic analysis \
                 (including raw entity queries via query:\"query\"), structs_policy for \
                 automation, and structs_system for health/logs/self-tuning when anything \
                 seems stuck or stale. New to the game? Ask for the getting_started prompt."
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
                "structs_map" => {
                    let params: tools::map::MapParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::map::execute(&self.app_handle, &self.cosmos_client, params).await
                }
                "structs_board" => {
                    let params: tools::board::BoardParams =
                        serde_json::from_value(args).unwrap_or_default();
                    tools::board::execute(&self.app_handle, &self.task_registry, params).await
                }
                "structs_doctrine" => {
                    let params: tools::doctrine::DoctrineParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::doctrine::execute(params).await
                }
                "structs_strike" => {
                    let params: tools::strike::StrikeParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::strike::execute(&self.app_handle, &self.cosmos_client, params).await
                }
                "structs_system" => {
                    let params: tools::system::SystemParams =
                        serde_json::from_value(args).map_err(|e| {
                            McpError::invalid_params(format!("Invalid params: {}", e), None)
                        })?;
                    tools::system::execute(params).await
                }
                // Retired tools, absorbed elsewhere — point old prompts/workflows home.
                "structs_query" => vec![Content::text(
                    "structs_query was merged into structs_intel: use structs_intel {query:\"query\", args:{type, id?, filter?, pagination_key?, limit?, page?}} (same shapes).",
                )],
                "structs_ui" => vec![Content::text(
                    "structs_ui was merged into structs_board: use structs_board {component:{kind:...}, mode:\"notify\"|\"prompt\", timeout_secs?} (same component specs).",
                )],
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
