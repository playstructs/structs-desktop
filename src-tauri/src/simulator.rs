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
