use rmcp::model::{
    GetPromptResult, Prompt, PromptMessage, PromptMessageContent, PromptMessageRole,
};
use std::collections::HashMap;

pub fn list() -> Vec<Prompt> {
    vec![
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
    ]
}

pub fn get(name: &str, _arguments: Option<HashMap<String, String>>) -> Result<GetPromptResult, String> {
    let message = match name {
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
