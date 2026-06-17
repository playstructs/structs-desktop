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
# Wrap the existing ternary so window.__STRUCTS_CONFIG__?.clientWs takes priority
# when set, falling back to whatever the webapp picked. The flag name on the
# ternary changed (PR #64 renamed `debug` → `this.publicEndpoint`), so this
# pattern tracks the current source; verify_patched below catches future drift.
sed -i.bak '/this.wsUrl = this.publicEndpoint/,/: `ws:\/\/${window.location.hostname}:26657`;/{
  s|this.wsUrl = this.publicEndpoint|this.wsUrl = window.__STRUCTS_CONFIG__?.clientWs \|\| (this.publicEndpoint|
  s|: `ws://${window.location.hostname}:26657`;|: `ws://${window.location.hostname}:26657`);|
}' "$BUILD_DIR/js/managers/SigningClientManager.js"
grep -q "window.__STRUCTS_CONFIG__?.clientWs" "$BUILD_DIR/js/managers/SigningClientManager.js" \
  || { echo "ERROR: SigningClientManager.js patch did not apply (webapp source may have changed shape)"; exit 1; }

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

echo "    Patching GrassManager.js (resume-check reconnect + heartbeat)..."
GM="$BUILD_DIR/js/framework/GrassManager.js"
# 1. Constructor: install a window-level resume-check listener. When the app
#    foregrounds (visibilitychange → visible, dispatched from main.rs init
#    script), if we haven't seen a message in >60s, force-reconnect.
sed -i.bak "s|this.listeners = new Map();|this.listeners = new Map(); this._lastMessageAt = 0; this._reconnecting = false; var __self = this; window.addEventListener('structs:grass-resume-check', function() { try { var stale = (Date.now() - __self._lastMessageAt) > 60000; if (stale \&\& !__self._reconnecting) { __self._reconnecting = true; console.info('[GrassManager] resume-check: stale, reconnecting', __self.subject); if (__self._nc) { try { __self._nc.close(); } catch(e) {} } setTimeout(function() { __self._reconnecting = false; __self.init(); }, 500); } } catch(e) { console.warn('[GrassManager] resume-check error', e); } });|" "$GM"

# 2. After subscription created: stash nc + subscription on `this` so the
#    resume listener can close the dead connection. Seed lastMessageAt.
sed -i.bak "s|const subscription = nc.subscribe(this.subject);|const subscription = nc.subscribe(this.subject); this._nc = nc; this._subscription = subscription; this._lastMessageAt = Date.now();|" "$GM"

# 3. In the message loop: update heartbeat.
sed -i.bak "s|const messageData = this.getMessageData(message);|const messageData = this.getMessageData(message); this._lastMessageAt = Date.now();|" "$GM"

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
