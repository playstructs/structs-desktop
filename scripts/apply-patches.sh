#!/usr/bin/env bash
set -euo pipefail

# Apply endpoint configurability patches to the webapp source.
# These make each hardcoded endpoint check window.__STRUCTS_CONFIG__ first,
# falling back to the original value when not set.

BUILD_DIR="$1"

# Helper: every sed below MUST leave a known marker in the file. If a future
# webapp refactor changes the match shape, sed silently no-ops — this guard
# turns that into a build failure instead of a broken runtime config.
verify_patched() {
  local file="$1" needle="$2" desc="$3"
  grep -qF "$needle" "$file" \
    || { echo "ERROR: $desc — sed did not apply (webapp source shape changed?)"; exit 1; }
}

echo "    Patching GuildAPI.js..."
sed -i.bak "s|this.apiUrl = '/api';|this.apiUrl = window.__STRUCTS_CONFIG__?.guildApi \|\| '/api';|" \
  "$BUILD_DIR/js/api/GuildAPI.js"
verify_patched "$BUILD_DIR/js/api/GuildAPI.js" '__STRUCTS_CONFIG__?.guildApi' "GuildAPI.js apiUrl override"

echo "    Patching index.js (GrassManager URLs)..."
sed -i.bak "s|\`ws://\${window.location.hostname}:1443\`|window.__STRUCTS_CONFIG__?.grassNatsWs \|\| \`ws://\${window.location.hostname}:1443\`|g" \
  "$BUILD_DIR/js/index.js"
verify_patched "$BUILD_DIR/js/index.js" '__STRUCTS_CONFIG__?.grassNatsWs' "index.js GrassManager URL override"

echo "    Patching SigningClientManager.js (RPC URL)..."
# Wrap the existing ternary so window.__STRUCTS_CONFIG__?.clientWs takes priority
# when set, falling back to whatever the webapp picked. The flag name on the
# ternary changed (PR #64 renamed `debug` → `this.publicEndpoint`), so this
# pattern tracks the current source; verify_patched below catches future drift.
sed -i.bak '/this.wsUrl = this.publicEndpoint/,/: `ws:\/\/${window.location.hostname}:26657`;/{
  s|this.wsUrl = this.publicEndpoint|this.wsUrl = window.__STRUCTS_CONFIG__?.clientWs \|\| (this.publicEndpoint|
  s|: `ws://${window.location.hostname}:26657`;|: `ws://${window.location.hostname}:26657`);|
}' "$BUILD_DIR/js/managers/SigningClientManager.js"
verify_patched "$BUILD_DIR/js/managers/SigningClientManager.js" '__STRUCTS_CONFIG__?.clientWs' "SigningClientManager.js clientWs override"

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
  verify_patched "$target" "renderer: 'canvas'" "$f canvas renderer swap"
done

echo "    Patching index.js (expose gameState to window for Tauri sync)..."
sed -i.bak 's|global.gameState = gameState;|global.gameState = gameState; window.gameState = gameState;|' \
  "$BUILD_DIR/js/index.js"
verify_patched "$BUILD_DIR/js/index.js" 'window.gameState = gameState' "index.js window.gameState exposure"

echo "    Patching GrassManager.js (background-stall resume-check)..."
# The webapp already does its own self-healing — supervised connect/subscribe
# loop, exponential backoff up to 30s, NATS-level reconnect attempts (see
# `_supervise` in GrassManager.js). What it CAN'T detect is a silent stall:
# WebView backgrounding can leave the WebSocket TCP socket alive while no
# data flows. We layer two minimal pieces on top:
#   1) heartbeat: stamp `_lastMessageAt` whenever a frame arrives
#   2) resume-check listener: on the visibility-change foreground event
#      dispatched by main.rs, if the heartbeat is >60s stale, force-close
#      the NATS connection. The existing `_supervise` loop sees the close,
#      backs off briefly, and reconnects — no manual `init()` call needed.
GM="$BUILD_DIR/js/framework/GrassManager.js"

# 1. Constructor: install a window-level resume-check listener. Anchor:
#    `this.listeners = new Map();` (still present in current webapp source).
sed -i.bak "s|this.listeners = new Map();|this.listeners = new Map(); this._lastMessageAt = Date.now(); var __self = this; window.addEventListener('structs:grass-resume-check', function() { try { var stale = (Date.now() - __self._lastMessageAt) > 60000; if (stale \&\& __self.nc) { console.info('[GrassManager] resume-check: stale, forcing reconnect on', __self.subject); try { __self.nc.close(); } catch(e) {} } } catch(e) { console.warn('[GrassManager] resume-check error', e); } });|" "$GM"
verify_patched "$GM" 'structs:grass-resume-check' "GrassManager.js resume-check listener"

# 2. Heartbeat: update `_lastMessageAt` in the consume loop right after the
#    frame is parsed. Anchor: `messageData = this.getMessageData(message);`
#    (note: webapp now declares `messageData` on a prior line — no `const`).
sed -i.bak "s|messageData = this.getMessageData(message);|messageData = this.getMessageData(message); this._lastMessageAt = Date.now();|" "$GM"
verify_patched "$GM" 'this._lastMessageAt = Date.now()' "GrassManager.js heartbeat update"

echo "    Patching index.js (expose UI reactor for external re-render)..."
# index.js uses top-level await (it's an ES module), so gameState / grassManager /
# MenuPage / HUDViewModel remain in module scope at the end of the file. Append a
# re-render hook the Tauri glue calls after external (MCP-driven) state changes,
# plus expose grassManager for direct reconnects. Uses concrete render methods
# (no dependence on the module-scoped EVENTS map) so it's robust to refactors.
cat >> "$BUILD_DIR/js/index.js" <<'REACTOR_EOF'

// [structs-universe patch] UI reactivity bridge for external (MCP) influence.
try {
  window.grassManager = grassManager;
  window.__STRUCTS_REACTOR__ = {
    // Re-render the OPEN menu page from current gameState (the static-snapshot fix).
    refreshMenu: function () {
      try {
        var layout = document.getElementById(MenuPage.pageLayoutId);
        if (!layout || layout.classList.contains('hidden')) return false; // menu not open
        var r = MenuPage.router;
        if (!r || !r.currentController) return false;
        r.goto(r.currentController, r.currentPage, r.currentOptions);
        return true;
      } catch (e) { console.warn('[reactor] refreshMenu', e); return false; }
    },
    // Belt-and-suspenders (HUD/own-map already update via grass listeners).
    refreshHud: function () { try { HUDViewModel.refreshActionBar(); } catch (e) {} },
    refreshMaps: function () {
      try { [gameState.alphaBaseMap, gameState.raidMap].forEach(function (m) { if (m && m.render) m.render(); }); }
      catch (e) {}
    },
    refreshAll: function () { this.refreshHud(); this.refreshMaps(); this.refreshMenu(); }
  };
  console.info('[structs-universe] __STRUCTS_REACTOR__ ready');
} catch (e) { console.warn('[structs-universe] reactor exposure failed', e); }
REACTOR_EOF
grep -q "__STRUCTS_REACTOR__" "$BUILD_DIR/js/index.js" \
  || { echo "ERROR: reactor patch did not apply (index.js shape may have changed)"; exit 1; }

echo "    Patching TaskManager.js (runtime MAX_CONCURRENT_PROCESSES override)..."
# Let the agent tune the task manager's concurrency cap at runtime. The MCP's
# structs_hash {command:"config", max_concurrent} sets window.__STRUCTS_TASK_OVERRIDES__
# (via structs-config.js); fall back to the compile-time TASK.MAX_CONCURRENT_PROCESSES.
TM="$BUILD_DIR/js/managers/TaskManager.js"
sed -i.bak "s|TASK.MAX_CONCURRENT_PROCESSES|((window.__STRUCTS_TASK_OVERRIDES__ \&\& window.__STRUCTS_TASK_OVERRIDES__.maxConcurrent) || TASK.MAX_CONCURRENT_PROCESSES)|g" "$TM"
grep -q "__STRUCTS_TASK_OVERRIDES__" "$TM" \
  || { echo "ERROR: TaskManager MAX_CONCURRENT patch did not apply (source may have changed)"; exit 1; }

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
