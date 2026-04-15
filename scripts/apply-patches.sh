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
sed -i.bak "s|renderer: 'svg'|renderer: 'canvas'|" \
  "$BUILD_DIR/js/view_models/banners/DefeatBannerViewModel.js" 2>/dev/null || true
sed -i.bak "s|renderer: 'svg'|renderer: 'canvas'|" \
  "$BUILD_DIR/js/view_models/banners/VictoryBannerViewModel.js" 2>/dev/null || true

echo "    Patching index.js (expose gameState to window for Tauri sync)..."
sed -i.bak 's|global.gameState = gameState;|global.gameState = gameState; window.gameState = gameState;|' \
  "$BUILD_DIR/js/index.js"

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
