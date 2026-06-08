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

echo "    Patching SigningClientManager.js (GA transaction events)..."
# Every queueMsg* helper funnels through queue(msg); each msg carries a typeUrl
# like '/structs.structs.MsgPlayerSend'. Fire one GA event per queued transaction,
# named after the transaction (snake_cased, GA4's 40-char cap applied), and carry
# the exact Msg type + full typeUrl as params. window.gtag is defined in index.html
# before the bundle loads. Wrapped so analytics can never break a transaction.
sed -i.bak 's#  async queue(msg) {#  async queue(msg) { try { if (window.gtag \&\& msg \&\& msg.typeUrl) { var __t = msg.typeUrl.split(".").pop(); var __e = __t.replace(/^Msg/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().slice(0, 40); window.gtag("event", __e, { tx_type: __t, type_url: msg.typeUrl, event_category: "transaction" }); window.__gaSentCount = (window.__gaSentCount || 0) + 1; } } catch (__gaErr) {}#' \
  "$BUILD_DIR/js/managers/SigningClientManager.js"

echo "    Patching MenuPageRouter.js (GA menu navigation events)..."
# Every menu page change funnels through goto(); navigationId++ runs once per
# navigation. Fire a GA event with the destination controller/page. Skip PREVIEW
# mode (planet previews aren't user menu navigations). Wrapped defensively.
sed -i.bak 's#    this.navigationId++;#    this.navigationId++; try { if (window.gtag \&\& this.mode !== MENU_PAGE_ROUTER_MODES.PREVIEW) { window.gtag("event", "menu_page_view", { menu_controller: controllerName, menu_page: pageName, screen_name: controllerName + "/" + pageName, event_category: "navigation" }); window.__gaSentCount = (window.__gaSentCount || 0) + 1; } } catch (__gaErr) {}#' \
  "$BUILD_DIR/js/framework/MenuPageRouter.js"

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
