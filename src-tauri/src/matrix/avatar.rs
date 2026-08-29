//! The player's portrait, composed locally.
//!
//! On-chain a portrait is five small integers — an index per layer. The game
//! renders them by stacking five PNGs from the bundle, and every window in
//! this app does the same. No other Matrix client can: they read a single
//! `avatar_url`, so a Structs player shows up in Element as a grey initial.
//!
//! This module closes that gap by doing the stacking in Rust and handing the
//! result to the homeserver. It is the ONLY thing this app uploads. Nothing
//! here ever touches a file the player chose.

use image::{imageops, RgbaImage};
use tauri::AppHandle;

/// Back to front, exactly the order the frontend paints them in. A different
/// order here would put the background over the face.
const LAYERS: [&str; 5] = ["background", "arms", "body", "neck", "head"];

/// Layer art ships at 72×72. The composite is built at that size and then
/// enlarged by a whole number, never to an arbitrary target: this is pixel
/// art, and a 7.1× scale gives some source pixels seven output pixels and
/// others eight. The wobble is exactly what makes upscaled sprites look
/// wrong, and it is invisible in a thumbnail right up until someone opens the
/// profile.
const BASE: u32 = 72;
const SCALE: u32 = 4;

/// Parse the on-chain attribute blob into the indices it holds.
///
/// Tolerant on purpose: the field is free-form JSON written by whatever
/// client set it, and a missing or malformed layer is a layer we skip rather
/// than a portrait we refuse to draw.
fn indices(attrs_json: &str) -> Vec<(&'static str, u64)> {
    let v: serde_json::Value = match serde_json::from_str(attrs_json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    LAYERS
        .iter()
        .filter_map(|part| {
            let raw = v.get(part)?;
            // Written as a number by the game and as a string by some tools.
            let n = raw
                .as_u64()
                .or_else(|| raw.as_str().and_then(|s| s.parse::<u64>().ok()))?;
            Some((*part, n))
        })
        .collect()
}

/// Read one layer out of the bundle.
///
/// The asset resolver serves the same bytes the webview gets, so the portrait
/// composed here is the portrait the player is looking at — a separate copy
/// on disk could drift from what shipped.
fn layer_bytes(app: &AppHandle, part: &str, idx: u64) -> Option<Vec<u8>> {
    let path = format!("img/pfp/{}/pfp_{}_{}.png", part, part, idx);
    use tauri::Manager;
    app.asset_resolver().get(path).map(|a| a.bytes)
}

/// Compose the portrait for a set of on-chain attributes.
///
/// Returns `None` when the attributes name no layer this bundle has — a
/// portrait that would come out blank is not worth uploading, and publishing
/// an empty square would be worse than leaving the avatar unset.
pub fn compose_png(app: &AppHandle, attrs_json: &str) -> Option<Vec<u8>> {
    let mut canvas = RgbaImage::new(BASE, BASE);
    let mut painted = 0usize;

    for (part, idx) in indices(attrs_json) {
        let Some(bytes) = layer_bytes(app, part, idx) else { continue };
        let Ok(img) = image::load_from_memory(&bytes) else { continue };
        let mut rgba = img.to_rgba8();
        if rgba.width() != BASE || rgba.height() != BASE {
            rgba = imageops::resize(&rgba, BASE, BASE, imageops::FilterType::Nearest);
        }
        imageops::overlay(&mut canvas, &rgba, 0, 0);
        painted += 1;
    }

    if painted == 0 {
        return None;
    }
    // Enlarge ONCE, after compositing, so every layer gets identical treatment
    // and the seams between them cannot land on different pixel boundaries.
    // Nearest neighbour: interpolating a sprite is how you turn it into a
    // smear.
    let out_size = BASE * SCALE;
    let big = imageops::resize(&canvas, out_size, out_size, imageops::FilterType::Nearest);
    let mut out = Vec::new();
    big.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_layer_in_paint_order() {
        let got = indices(r#"{"head":1,"neck":2,"body":3,"arms":4,"background":5}"#);
        let parts: Vec<&str> = got.iter().map(|(p, _)| *p).collect();
        assert_eq!(parts, vec!["background", "arms", "body", "neck", "head"]);
        assert_eq!(got.last().unwrap().1, 1, "head must be painted last");
    }

    #[test]
    fn a_missing_layer_is_skipped_not_fatal() {
        // The role portraits in pfp.rs leave head/neck/arms null on purpose.
        let got = indices(r#"{"head":null,"neck":null,"body":10,"arms":null,"background":2}"#);
        assert_eq!(got, vec![("background", 2), ("body", 10)]);
    }

    #[test]
    fn indices_written_as_strings_still_parse() {
        let got = indices(r#"{"background":"3","body":"7"}"#);
        assert_eq!(got, vec![("background", 3), ("body", 7)]);
    }

    #[test]
    fn the_portrait_is_a_whole_multiple_of_the_source_art() {
        // A fractional scale is what makes upscaled pixel art wobble: some
        // source pixels get N output pixels and their neighbours get N+1.
        assert_eq!((BASE * SCALE) % BASE, 0);
        assert!(SCALE >= 1);
    }

    #[test]
    fn junk_is_no_portrait_rather_than_a_panic() {
        assert!(indices("not json").is_empty());
        assert!(indices("").is_empty());
        assert!(indices("{}").is_empty());
    }
}
