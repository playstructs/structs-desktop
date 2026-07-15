use rmcp::model::{
    GetPromptResult, Prompt, PromptMessage, PromptMessageContent, PromptMessageRole,
};
use std::collections::HashMap;

pub fn list() -> Vec<Prompt> {
    vec![
        Prompt::new(
            "getting_started",
            Some("Guided first session for a BRAND-NEW player: explore, build, mine, refine — the agent is the tutorial."),
            None,
        ),
        Prompt::new(
            "structs_first_session",
            Some("Orientation for a new Structs commander. Checks dashboard, identifies priorities."),
            None,
        ),
        Prompt::new(
            "structs_game_loop",
            Some("One tick of the game loop: dashboard, assess, plan, execute, verify."),
            None,
        ),
        Prompt::new(
            "structs_state_assessment",
            Some("Deep analysis: power, threats, economy, fleet. Risk ratings per category."),
            None,
        ),
        Prompt::new(
            "structs_combat_planning",
            Some("Plan a combat operation: scout, simulate, recommend attack/wait/abort."),
            None,
        ),
        Prompt::new(
            "structs_threat_check",
            Some("Threat assessment using Guild API history: planet_history + valid_targets."),
            None,
        ),
        Prompt::new(
            "structs_market_check",
            Some("Power market summary: providers, agreements, capacity-rental recommendation."),
            None,
        ),
    ]
}

pub fn get(name: &str, _arguments: Option<HashMap<String, String>>) -> Result<GetPromptResult, String> {
    let message = match name {
        "getting_started" => {
            "I'm brand new to Structs. Be my guide — teach me the game by playing my first \
            session WITH me. Explain each concept in one or two plain sentences right before \
            we use it, then act. Check in with me before anything irreversible.\n\
            \n\
            1. WHO AM I: Call structs_intel {query:\"whoami\"}. If no player exists yet, tell \
               me to log into the Structs window and pick a guild first — you can't play until \
               the app is signed in. (The guild fronts my join fee; I don't need any funds.)\n\
            2. FIRST EXPLORE: A fresh player owns NOTHING — no planet, no fleet, no Command \
               Ship — until their first explore. Run structs_action {action:\"explore\"} and \
               explain: this spawns my planet, fleet, and Command Ship.\n\
            3. LOOK AROUND: Call structs_dashboard and walk me through what I now own. \
               Explain the two resources (Ore: mined, raidable; Alpha: refined from ore, safe, \
               powers everything) and charge (1 per block ≈ 6s; every action spends it).\n\
            4. BUILD THE ECONOMY: Build an Ore Extractor, then an Ore Refinery \
               (structs_action {action:\"build\"} — use structs_intel what_can_i_build for \
               slots). Explain: builds finish with a proof-of-work; the app grinds it \
               automatically (structs_hash list shows progress and ETAs).\n\
            5. MINE → REFINE: Start a mine (structs_action {action:\"mine\"}). When it \
               completes, refining starts automatically if the auto_refine policy is on \
               (it is by default) — explain that policies are standing orders I can toggle \
               with structs_policy.\n\
            6. STAY SAFE: Explain in one paragraph why stored ore attracts raids and how \
               defense assignments work; check structs_policy list and confirm power_alert \
               and combat_alert are on.\n\
            7. WHAT'S NEXT: Show me structs_system {command:\"status\"} — the health view I \
               (or you) can check anytime — and suggest ONE preset doctrine \
               (structs_doctrine {command:\"set\", preset:\"economy\"}) as my training wheels.\n\
            \n\
            Keep each step short. Never fire more than one transaction without telling me \
            what it does first."
        }
        "structs_first_session" => {
            "I'm starting a new Structs session. Help me get oriented:\n\
            \n\
            1. Check my dashboard with structs_dashboard to see my current state\n\
            2. Based on what you find, assess:\n\
               - Am I online? (power load vs capacity)\n\
               - Do I have the essentials? (Command Ship, Ore Extractor, Ore Refinery)\n\
               - Are any hash tasks running? What's their ETA?\n\
               - Any immediate threats? (stored ore vulnerable to raids?)\n\
            3. Identify my top 3 priorities and walk me through the most important one\n\
            4. Set up standing orders (structs_policy) for auto_refine and power_alert if not already enabled\n\
            \n\
            Be concise and action-oriented."
        }
        "structs_game_loop" => {
            "Run the standard Structs game loop:\n\
            \n\
            1. CHECK: Call structs_dashboard for full situational awareness\n\
            2. ASSESS: Evaluate state across all dimensions:\n\
               - Power: load vs capacity, margin, risk of going offline\n\
               - Economy: ore pipeline (mining, refining, Alpha), idle extractors/refineries\n\
               - Military: fleet position, struct health, nearby threats\n\
               - Operations: active hash tasks, ETAs, queued builds\n\
            3. PLAN: Based on assessment, determine the single highest-priority action\n\
               - Use structs_intel what_can_i_build if considering expansion\n\
               - Use structs_intel economy_status for resource optimization\n\
            4. EXECUTE: Perform the action via structs_action\n\
            5. VERIFY: Check the result\n\
            \n\
            Report what you did and recommend the next action."
        }
        "structs_state_assessment" => {
            "Perform a comprehensive state assessment:\n\
            \n\
            1. Call structs_dashboard for current state\n\
            2. Call structs_intel economy_status for resource pipeline\n\
            3. Call structs_hash list for active operations\n\
            \n\
            Then analyze each category with a risk rating (Green/Yellow/Red):\n\
            \n\
            POWER: Current utilization, margin before offline, can we safely build more?\n\
            THREATS: Active raids, stored ore exposure, ambit coverage gaps\n\
            ECONOMY: Mining/refining active or idle, planet ore remaining, Alpha balance\n\
            OPERATIONS: Hash task progress and ETAs, pending builds, charge level\n\
            \n\
            Conclude with overall assessment and top 3 recommended actions."
        }
        "structs_combat_planning" => {
            "Plan a combat operation:\n\
            \n\
            1. SCOUT: Check our fleet composition and charge level via structs_dashboard\n\
            2. ASSESS STRENGTH: What weapons, current charge, fleet status (onStation vs away)\n\
            3. EVALUATE RISKS:\n\
               - Stored ore that could be counter-raided?\n\
               - Power margin (combat costs charge)\n\
               - Defenses if we're attacked while fleet is away?\n\
            4. RECOMMEND: Attack / Wait / Abort with clear reasoning\n\
               - If attacking: specific sequence of actions\n\
               - If waiting: what conditions to watch for\n\
            \n\
            Combat decisions have asymmetric consequences. Counter-attacks can be baited. \
            Raiding while leaving your planet undefended is risky. Be conservative unless \
            the opportunity is clear."
        }
        "structs_threat_check" => {
            "Assess hostile activity around my position:\n\
            \n\
            1. Call structs_dashboard to identify owned planets.\n\
            2. For each owned planet, call structs_intel with query='planet_history' and {planet_id, window_minutes:60}.\n\
            3. Call structs_intel with query='valid_targets' to see if there are exploitable enemy positions nearby.\n\
            4. Conclude:\n\
               - Threat level per planet (quiet / active / contested)\n\
               - Top hostile actor seen\n\
               - One recommended defensive or offensive action\n\
            \n\
            If the Guild API isn't reachable or you're not signed in, say so clearly and \
            fall back to local-only intel (structs_intel economy_status, what_can_i_build)."
        }
        "structs_market_check" => {
            "Survey the power-rental market:\n\
            \n\
            1. Call structs_intel with query='market' (optionally pass denom).\n\
            2. Cross-reference with structs_dashboard power margin.\n\
            3. If margin < 20% or trending negative (use structs_intel metric_trend on capacity), recommend renting.\n\
            4. Identify the best provider by rate, owner reputation, and substation locality.\n\
            \n\
            Output: rent / don't rent, target provider, expected cost."
        }
        _ => return Err(format!("Unknown prompt: {}", name)),
    };

    Ok(GetPromptResult {
        description: None,
        messages: vec![PromptMessage {
            role: PromptMessageRole::User,
            content: PromptMessageContent::Text {
                text: message.to_string(),
            },
        }],
    })
}
