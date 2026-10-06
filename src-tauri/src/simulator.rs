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
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(window) = app.get_webview_window(LABEL) {
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("simulator.html".into()))
        .title("Structs · Simulator")
        .inner_size(1440.0, 1000.0)
        .min_inner_size(720.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
