//! `structs_map` — render a planet's map to a PNG (or animated GIF) using the
//! game's OWN renderer. The Rust side resolves the planet + its owner, asks the
//! façade (over the vplayer bridge) to draw the planet into the off-screen
//! preview map and serialize it with html-to-image, then decodes the result to
//! a file. No screen capture — the game's renderer produces the image headlessly.

use base64::Engine;
use rmcp::model::Content;
use serde::Deserialize;
use serde_json::Value;

use crate::mcp::cosmos_client::CosmosClient;
use crate::mcp::vplayer_bridge;

#[derive(Debug, Deserialize)]
pub struct MapParams {
    /// Planet id (e.g. "2-239"). If omitted, resolved from `player`.
    #[serde(default)]
    pub planet_id: Option<String>,
    /// Player (index / address / player id, incl. virtual players) whose planet
    /// to render. Used to resolve the planet when `planet_id` is absent, and to
    /// load the owner's structs/fleet for the render.
    #[serde(default)]
    pub player: Option<String>,
    /// "png" (default) or "gif" (animated — captures the Lottie struct sprites).
    #[serde(default)]
    pub format: Option<String>,
    /// gif: number of frames (2–60, default 12).
    #[serde(default)]
    pub frames: Option<u32>,
    /// gif: ms between frames (default 120).
    #[serde(default)]
    pub interval_ms: Option<u32>,
}

/// Strip a `data:*;base64,` prefix and decode to bytes.
fn decode_data_url(s: &str) -> Result<Vec<u8>, String> {
    let b64 = s.rsplit("base64,").next().unwrap_or(s);
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("bad image data: {}", e))
}

pub async fn execute(
    app_handle: &tauri::AppHandle,
    client: &CosmosClient,
    params: MapParams,
) -> Vec<Content> {
    // ── Resolve (planet_id, owner_player_id). The renderer needs the owner to
    //    load that player's structs + fleet onto the planet. ──
    let (planet_id, owner_pid): (String, String) = if let Some(p) =
        params.player.as_deref().filter(|s| !s.is_empty())
    {
        // Player given → its player id + on-chain planetId.
        let pid = {
            let reg = crate::mcp::virtual_players::REGISTRY.read().unwrap();
            reg.find(p)
                .and_then(|vp| vp.player_id.clone())
                .unwrap_or_else(|| p.to_string())
        };
        match client.query_entity("player", &pid).await {
            Ok(v) => {
                let planet = v
                    .get("Player")
                    .and_then(|x| x.get("planetId"))
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("")
                    .to_string();
                (planet, pid)
            }
            Err(e) => return vec![Content::text(format!("structs_map: couldn't resolve '{}': {}", p, e))],
        }
    } else if let Some(planet) = params.planet_id.clone().filter(|s| !s.is_empty()) {
        // Planet given → look up its owner.
        let owner = match client.query_entity("planet", &planet).await {
            Ok(v) => v
                .get("Planet")
                .and_then(|x| x.get("owner"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            Err(e) => return vec![Content::text(format!("structs_map: planet {} lookup failed: {}", planet, e))],
        };
        (planet, owner)
    } else {
        return vec![Content::text(
            "structs_map: provide 'planet_id' (e.g. \"2-239\") or 'player'.".to_string(),
        )];
    };

    if planet_id.is_empty() {
        return vec![Content::text(
            "structs_map: no planet found (the player may not have explored yet).".to_string(),
        )];
    }
    if owner_pid.is_empty() {
        return vec![Content::text(format!(
            "structs_map: couldn't determine the owner of planet {}.",
            planet_id
        ))];
    }

    let dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("structs-app")
        .join("maps");
    std::fs::create_dir_all(&dir).ok();

    let is_gif = params.format.as_deref() == Some("gif");

    if is_gif {
        let count = params.frames.unwrap_or(12).clamp(2, 60);
        let interval_ms = params.interval_ms.unwrap_or(120).max(20);
        let res = match vplayer_bridge::call(
            app_handle,
            "render_map_frames",
            serde_json::json!({ "planet_id": planet_id, "player_id": owner_pid, "count": count, "interval_ms": interval_ms }),
            180,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => return vec![Content::text(format!("structs_map(gif): render failed for {}: {}", planet_id, e))],
        };
        let frame_urls: Vec<String> = res
            .get("frames")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if frame_urls.is_empty() {
            return vec![Content::text("structs_map(gif): renderer returned no frames.".to_string())];
        }
        let path = dir.join(format!("planet-{}.gif", planet_id));
        match encode_gif(&path, &frame_urls, interval_ms) {
            Ok(n) => vec![Content::text(format!(
                "Rendered planet {} → {} ({} frames, {}ms each). Animated GIF via the game's own renderer.",
                planet_id, path.display(), n, interval_ms
            ))],
            Err(e) => vec![Content::text(format!("structs_map(gif): {}", e))],
        }
    } else {
        let res = match vplayer_bridge::call(
            app_handle,
            "render_map",
            serde_json::json!({ "planet_id": planet_id, "player_id": owner_pid }),
            90,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => return vec![Content::text(format!("structs_map: render failed for {}: {}", planet_id, e))],
        };
        let data_url = res.get("dataUrl").and_then(|x| x.as_str()).unwrap_or("");
        if data_url.is_empty() {
            return vec![Content::text("structs_map: renderer returned no image.".to_string())];
        }
        let bytes = match decode_data_url(data_url) {
            Ok(b) => b,
            Err(e) => return vec![Content::text(format!("structs_map: {}", e))],
        };
        let path = dir.join(format!("planet-{}.png", planet_id));
        if let Err(e) = std::fs::write(&path, &bytes) {
            return vec![Content::text(format!("structs_map: failed to write PNG: {}", e))];
        }
        vec![Content::text(format!(
            "Rendered planet {} → {} ({} KB). Game-rendered PNG (terrain + struct sprites + HP bars).",
            planet_id, path.display(), bytes.len() / 1024
        ))]
    }
}

/// Decode base64 PNG frames and encode them into an infinitely-looping GIF.
fn encode_gif(path: &std::path::Path, frame_urls: &[String], interval_ms: u32) -> Result<usize, String> {
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame};

    let file = std::fs::File::create(path).map_err(|e| format!("create file: {}", e))?;
    let mut encoder = GifEncoder::new_with_speed(file, 10);
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| format!("gif repeat: {}", e))?;

    let mut n = 0usize;
    for url in frame_urls {
        let bytes = decode_data_url(url)?;
        let rgba = image::load_from_memory(&bytes)
            .map_err(|e| format!("decode frame: {}", e))?
            .to_rgba8();
        let frame = Frame::from_parts(rgba, 0, 0, Delay::from_numer_denom_ms(interval_ms, 1));
        encoder.encode_frame(frame).map_err(|e| format!("encode frame: {}", e))?;
        n += 1;
    }
    Ok(n)
}
