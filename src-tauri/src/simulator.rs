/// The Battle Simulator window. Its battle is a local chain (frontend/
/// simulator-chain.js) drawn by the Map Viewer in an iframe; like Map Viewer it
/// has no game initialization script, signer, chain subscription or worker.
/// It holds IPC only so the board's sound engine can read the player's sound
/// design, and it is an UNTRUSTED window (`board_pages::is_untrusted_label`):
/// it loads layout codes other people paste, so nothing that signs or writes
/// configuration answers it.
pub const LABEL: &str = "simulator";

#[tauri::command]
pub fn simulator_open(app: tauri::AppHandle) -> Result<(), String> {
    open(&app, None)
}

/// Open the simulator on a battle from a `structs://sim/<code>` link. The code
/// is checked against the base64url alphabet before it goes anywhere near a
/// URL or a script: an open window gets `Simulator.openLink(code)`, a closed
/// one opens at `simulator.html?sim=<code>`.
pub fn open_battle(app: &tauri::AppHandle, code: &str) -> Result<(), String> {
    use tauri::Manager;
    if code.len() < 4 || code.len() > 2000 || !code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("not a battle code".into());
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        window.eval(&format!("window.Simulator && window.Simulator.openLink('{code}');")).map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    open(app, Some(code))
}

/// Where the next battle came from, waiting for the simulator to ask.
///
/// A challenge card's Play, or a player's "Challenge to a battle", hands the
/// simulator a CONTEXT as well as a battle: which room and thread the result
/// belongs to, or who the battle is for. The window takes it once
/// (`sim_take_context`) — on boot, or when it is already open and told to.
static PENDING: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

fn set_pending(v: serde_json::Value) {
    *PENDING.lock().unwrap() = Some(v);
}

#[tauri::command]
pub fn sim_take_context() -> Option<serde_json::Value> {
    PENDING.lock().unwrap().take()
}

fn code_ok(code: &str) -> bool {
    crate::matrix::sim::decode_battle(code).is_some()
}

/// Open the simulator on a challenge from Comms: the battle, locked, with
/// its thread and ladder beside it.
#[tauri::command]
pub fn sim_challenge_open(
    app: tauri::AppHandle,
    guild_id: String,
    room_id: String,
    event_id: String,
    battle: String,
) -> Result<(), String> {
    if !code_ok(&battle) {
        return Err("that is not a battle".into());
    }
    if !room_id.starts_with('!') || !event_id.starts_with('$') {
        return Err("that challenge has no room".into());
    }
    set_pending(serde_json::json!({
        "kind": "challenge", "guild_id": guild_id, "room_id": room_id, "event_id": event_id, "battle": battle,
    }));
    take_in(&app, Some(&battle))
}

/// Open the simulator addressed to a player: "Challenge to a battle" from
/// their row in Comms. Their name and face come from the directory, never
/// from the window that asked.
#[tauri::command]
pub async fn sim_address_open(app: tauri::AppHandle, player_id: String) -> Result<(), String> {
    let pid = player_id.trim().to_string();
    let ok = pid.split_once('-').is_some_and(|(k, n)| k == "1" && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    if !ok {
        return Err("that is not a player".into());
    }
    crate::matrix::directory::resolve_many(&[pid.clone()]).await;
    let ident = crate::matrix::directory::get(&pid);
    set_pending(serde_json::json!({
        "kind": "addressed", "player_id": pid,
        "name": ident.as_ref().map(|i| i.username.clone()).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| pid.clone()),
        "tag": ident.as_ref().map(|i| i.tag.clone()),
        "pfp_attrs": ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
    }));
    take_in(&app, None)
}

/// Take a live battle from its invite in Comms: join its match room — to
/// play it (the guest) or to watch it — and open the simulator on it. The
/// host is the invite's sender; who that is comes from the directory.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sim_live_join_open(
    app: tauri::AppHandle,
    guild_id: String,
    room_id: String,
    event_id: String,
    match_room: String,
    battle: String,
    block_ms: u64,
    host: String,
    role: String,
) -> Result<(), String> {
    if !code_ok(&battle) {
        return Err("that is not a battle".into());
    }
    if !match_room.starts_with('!') || !host.starts_with('@') || !event_id.starts_with('$') {
        return Err("that is not a live battle".into());
    }
    if role != "guest" && role != "watch" {
        return Err("play or watch?".into());
    }
    if block_ms != 2000 && block_ms != 6000 {
        return Err("a live battle runs at 2 s or 6 s blocks".into());
    }
    crate::matrix::live_join(&guild_id, &match_room, &host).await?;
    let (host_name, host_pfp, _) = crate::matrix::person_of(&host);
    let me = crate::matrix::store::get(&guild_id).map(|s| s.user_id).unwrap_or_default();
    set_pending(serde_json::json!({
        "kind": "live", "role": role, "guild_id": guild_id, "room_id": room_id, "invite_event": event_id,
        "match_room": match_room, "battle": battle, "block_ms": block_ms,
        "host": host, "host_name": host_name, "host_pfp": host_pfp, "me": me,
    }));
    take_in(&app, Some(&battle))
}

/// Hand the pending context to an open window, or open one that asks for it
/// as it boots.
fn take_in(app: &tauri::AppHandle, code: Option<&str>) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(LABEL) {
        window.eval("window.Simulator && window.Simulator.takeContext();").map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    open(app, code)
}

fn open(app: &tauri::AppHandle, code: Option<&str>) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(window) = app.get_webview_window(LABEL) {
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = match code { Some(c) => format!("simulator.html?sim={c}"), None => "simulator.html".to_string() };
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("Structs · Simulator")
        .inner_size(1440.0, 1000.0)
        .min_inner_size(720.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
