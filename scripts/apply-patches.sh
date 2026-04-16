#!/usr/bin/env bash
set -euo pipefail

# Apply endpoint configurability patches to the webapp source.
# These make each hardcoded endpoint check window.__STRUCTS_CONFIG__ first,
# falling back to the original value when not set.

BUILD_DIR="$1"

echo "    Patching GuildAPI.js..."
sed -i.bak "s|this.apiUrl = '/api';|this.apiUrl = window.__STRUCTS_CONFIG__?.guildApi \|\| '/api';|" \
  "$BUILD_DIR/js/api/GuildAPI.js"

echo "    Patching index.js (GrassManager URLs)..."
sed -i.bak "s|\`ws://\${window.location.hostname}:1443\`|window.__STRUCTS_CONFIG__?.grassNatsWs \|\| \`ws://\${window.location.hostname}:1443\`|g" \
  "$BUILD_DIR/js/index.js"

echo "    Patching SigningClientManager.js (RPC URL)..."
# Replace the multi-line ternary with a single line that checks config first
sed -i.bak '/this.wsUrl = debug/,/: `ws:\/\/${window.location.hostname}:26657`;/{
  s|this.wsUrl = debug|this.wsUrl = window.__STRUCTS_CONFIG__?.clientWs \|\| (debug|
  s|: `ws://${window.location.hostname}:26657`;|: `ws://${window.location.hostname}:26657`);|
}' "$BUILD_DIR/js/managers/SigningClientManager.js"

echo "    Patching banner ViewModels (canvas renderer for crisp pixel art)..."
# 1) swap SVG renderer for canvas + add rendererSettings
# 2) force imageSmoothingEnabled = false on the created canvas once Lottie's DOM is ready
#    (belt-and-suspenders with the imageSmoothingEnabled wrapper in src-tauri/src/main.rs)
for f in DefeatBannerViewModel.js VictoryBannerViewModel.js; do
  target="$BUILD_DIR/js/view_models/banners/$f"
  [ -f "$target" ] || continue
  sed -i.bak \
    -e "s|renderer: 'svg',|renderer: 'canvas', rendererSettings: { clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' },|" \
    -e "s|this.isLoaded = true;|this.isLoaded = true; var __c = document.getElementById(this.id).querySelector('canvas'); if (__c) { var __x = __c.getContext('2d'); if (__x) __x.imageSmoothingEnabled = false; }|" \
    "$target"
done

echo "    Patching index.js (expose gameState to window for Tauri sync)..."
sed -i.bak 's|global.gameState = gameState;|global.gameState = gameState; window.gameState = gameState;|' \
  "$BUILD_DIR/js/index.js"

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
