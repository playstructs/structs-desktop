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
sed -i.bak "s|TASK.MAX_CONCURRENT_PROCESSES|((window.__STRUCTS_TASK_OVERRIDES__ \&\& window.__STRUCTS_TASK_OVERRIDES__.maxConcurrent) \|\| TASK.MAX_CONCURRENT_PROCESSES)|g" "$TM"
grep -q "__STRUCTS_TASK_OVERRIDES__" "$TM" \
  || { echo "ERROR: TaskManager MAX_CONCURRENT patch did not apply (source may have changed)"; exit 1; }

echo "    Patching SigningClientManager.js (sign+broadcast as an arbitrary account)..."
SCM="$BUILD_DIR/js/managers/SigningClientManager.js"
# Add the FEE import (reuse the constant the queue uses).
sed -i.bak 's|import {SigningQueueManager} from "./SigningQueueManager";|import {SigningQueueManager} from "./SigningQueueManager";\nimport {FEE} from "../constants/Fee";|' "$SCM"
# Append a one-shot signer: connect a client with the GIVEN wallet (which holds
# the virtual player's HD account), build the msg the same way the queue does
# (registry.lookupType + fromPartial + creator), broadcast, disconnect. Isolated
# from the primary single-account client/queue.
cat >> "$SCM" <<'SCM_EOF'

// [structs-universe patch] Sign+broadcast a single msg from an arbitrary account
// (a virtual player). `wallet` must contain `signerAddress`. Used by the
// virtual-players façade; the primary client/queue are untouched.
SigningClientManager.prototype.signAndBroadcastAs = async function (wallet, signerAddress, typeUrl, payload) {
  const client = await SigningStargateClient.connectWithSigner(this.wsUrl, wallet, { registry: this.registry });
  try {
    const type = this.registry.lookupType(typeUrl);
    if (!type) throw new Error('unknown typeUrl: ' + typeUrl);
    // Prefer fromJSON: it applies each message's own schema (enum NAMES → ints,
    // string-numbers, field defaults), so friendly payloads encode correctly for
    // ANY message type. Fall back to fromPartial if a type lacks fromJSON.
    const merged = { ...(payload || {}), creator: signerAddress };
    const value = (typeof type.fromJSON === 'function')
      ? type.fromJSON(merged)
      : type.fromPartial(merged);
    const res = await client.signAndBroadcast(signerAddress, [{ typeUrl, value }], FEE);
    return { code: res.code, transactionHash: res.transactionHash, height: res.height, rawLog: res.rawLog || null };
  } finally {
    try { client.disconnect(); } catch (e) { /* ignore */ }
  }
};
SCM_EOF
grep -q "signAndBroadcastAs" "$SCM" \
  || { echo "ERROR: SigningClientManager signAndBroadcastAs patch did not apply"; exit 1; }

echo "    Patching WalletManager.js (multi-index HD derivation for virtual players)..."
WM="$BUILD_DIR/js/managers/WalletManager.js"
# 1. Add Slip10RawIndex to the existing @cosmjs/crypto import.
sed -i.bak 's|import {Bip39, Random, Secp256k1, sha256} from "@cosmjs/crypto";|import {Bip39, Random, Secp256k1, sha256, Slip10RawIndex} from "@cosmjs/crypto";|' "$WM"
# 2. Add a derive-by-index helper (prototype assignment appended after the class —
#    DirectSecp256k1HdWallet + Slip10RawIndex are top-level imports, in scope).
cat >> "$WM" <<'WM_EOF'

// [structs-universe patch] Derive a wallet whose account[0] is HD index N off the
// SAME mnemonic (m/44'/118'/0'/0/N). Used by the virtual-players façade.
WalletManager.prototype.createWalletForIndex = async function (mnemonic, index) {
  return await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "structs",
    hdPaths: [[
      Slip10RawIndex.hardened(44),
      Slip10RawIndex.hardened(118),
      Slip10RawIndex.hardened(0),
      Slip10RawIndex.normal(0),
      Slip10RawIndex.normal(index),
    ]],
  });
};
WM_EOF
grep -q "createWalletForIndex" "$WM" \
  || { echo "ERROR: WalletManager multi-index patch did not apply"; exit 1; }

echo "    Patching index.js (expose __STRUCTS_VPLAYERS__ virtual-players façade)..."
# index.js is an ES module (top-level await); walletManager/guildAPI/gameState are
# in scope at EOF. Reuse them to derive/sign/sign-up virtual players. Keys never
# leave JS — Rust only ever receives addresses + player ids via the bridge.
cat >> "$BUILD_DIR/js/index.js" <<'VP_EOF'

// [structs-universe patch] Virtual-players façade (multi-account off one mnemonic).
try {
  const __vpAccounts = {}; // index -> {index, address, pubkey, player_id?}
  const __vpDerive = async (index) => {
    const w = await walletManager.createWalletForIndex(gameState.mnemonic, index);
    const accs = await w.getAccountsWithPrivkeys();
    return accs[0]; // {address, pubkey: Uint8Array, privkey: Uint8Array}
  };
  window.__STRUCTS_VPLAYERS__ = {
    async deriveAccount(index) {
      const a = await __vpDerive(index);
      const info = { index, address: a.address, pubkey: walletManager.bytesToHex(a.pubkey) };
      __vpAccounts[index] = info;
      return info;
    },
    // Derive index N → sign the guild-join proxy message → POST /auth/signup →
    // poll the address until the chain assigns a player id.
    async signup(index, name) {
      const a = await __vpDerive(index);
      const address = a.address;
      const pubkeyHex = walletManager.bytesToHex(a.pubkey);
      const guildId = gameState.thisGuild && gameState.thisGuild.id;
      if (!guildId) throw new Error('guild not loaded yet');
      const message = guildAPI.buildGuildMembershipJoinProxyMessage(guildId, address, 0);
      const signature = await walletManager.createSignatureForProxyMessage(message, a.privkey);
      const resp = await guildAPI.signup({
        primary_address: address, signature, pubkey: pubkeyHex, guild_id: guildId, username: name,
      });
      if (resp && resp.success === false) {
        const errs = JSON.stringify(resp.errors || resp);
        // Idempotent: if this address already joined (e.g. a prior create timed out
        // on the player-id poll), adopt the existing player rather than failing.
        if (!/resource_already_exists|already[ _]?exists|already[ _]?member/i.test(errs)) {
          throw new Error('signup rejected: ' + errs);
        }
      }
      const reactorApi = (window.__STRUCTS_CONFIG__ && window.__STRUCTS_CONFIG__.reactorApi) || '';
      let playerId = null;
      for (let i = 0; i < 18; i++) { // ~18 × 8s ≈ 2.4 min
        try {
          const rr = await fetch(reactorApi + '/structs/address/' + address);
          const j = await rr.json();
          // LCD shape is {address, playerId, permissions} (top-level camelCase);
          // keep the other spellings as fallbacks for safety.
          const pid = (j && (j.playerId || (j.Address && j.Address.playerId) || (j.address && j.address.player_id) || j.player_id)) || null;
          if (pid && pid !== '1-0' && pid !== '0-0') { playerId = pid; break; }
        } catch (e) { /* keep polling */ }
        await new Promise((r) => setTimeout(r, 8000));
      }
      __vpAccounts[index] = { index, address, pubkey: pubkeyHex, player_id: playerId };
      return { index, address, pubkey: pubkeyHex, player_id: playerId };
    },
    // Sign+broadcast a msg AS virtual player `index` (its own address = creator).
    async signAndBroadcast(index, typeUrl, payload) {
      const wallet = await walletManager.createWalletForIndex(gameState.mnemonic, index);
      const accs = await wallet.getAccountsWithPrivkeys();
      const address = accs[0].address;
      return await signingClientManager.signAndBroadcastAs(wallet, address, typeUrl, payload);
    },
    list() { return Object.values(__vpAccounts); },
    // Prepare the OFF-SCREEN preview map for a planet, mirroring the webapp's
    // own PreviewViewModel.render(): fetch planet + owner player + structs +
    // fleet, configure the map, and set the preview struct list (structs are
    // applied SEPARATELY from configurePreviewMap — without this the map renders
    // terrain with no structs). Lays the container out off-screen (never showMap,
    // so nothing appears on the human's screen) and renders. Returns the element;
    // caller restores el.style afterward.
    async __preparePreview(planetId, playerId) {
      if (!window.htmlToImage) throw new Error('html-to-image not loaded');
      if (typeof mapManager === 'undefined' || !gameState.previewMap) throw new Error('map renderer not ready');
      const [planet, defender, defenderStructs, defenderFleet] = await Promise.all([
        guildAPI.getPlanet(planetId),
        guildAPI.getPlayer(playerId),
        guildAPI.getStructsByPlayerId(playerId),
        guildAPI.getFleetByPlayerId(playerId),
      ]);
      const prevActive = gameState.activeMapContainerId; // restored after capture
      mapManager.configurePreviewMap(planet, defender, null, defenderFleet, null);
      gameState.setPreviewDefenderStructs(defenderStructs);
      gameState.setPreviewAttackerStructs([]);
      // showMap gives the container its real CSS dimensions. (Rendering it purely
      // off-screen collapses to 0×0 — the map's layers are absolutely positioned —
      // which yields a blank "data:," canvas.) We restore the prior map afterward,
      // so this is at most a brief flash during a deliberate render call.
      mapManager.showMap(MAP_CONTAINER_IDS.PREVIEW);
      gameState.previewMap.render();
      const el = document.getElementById(MAP_CONTAINER_IDS.PREVIEW);
      if (!el) throw new Error('preview-map-container not found');
      el.dataset.__prevActive = prevActive || '';
      return el;
    },
    __restorePreview(el) {
      try { if (el && el.dataset.__prevActive) mapManager.showMap(el.dataset.__prevActive); } catch (e) {}
    },
    // Single-frame PNG of a planet's map (terrain + struct sprites + HP bars).
    async renderMapPng(planetId, playerId) {
      const el = await this.__preparePreview(planetId, playerId);
      try {
        await new Promise((r) => setTimeout(r, 800)); // SVG/Lottie/terrain settle
        return { planetId, dataUrl: await window.htmlToImage.toPng(el, { pixelRatio: 2, cacheBust: true }) };
      } finally { this.__restorePreview(el); }
    },
    // N frames `intervalMs` apart → an animated GIF (Lottie struct sprites move;
    // re-render each frame so live state/animation advances).
    async renderMapFrames(planetId, playerId, count, intervalMs) {
      const n = Math.max(2, Math.min(count || 12, 60));
      const el = await this.__preparePreview(planetId, playerId);
      const frames = [];
      try {
        await new Promise((r) => setTimeout(r, 700));
        for (let i = 0; i < n; i++) {
          frames.push(await window.htmlToImage.toPng(el, { pixelRatio: 1, cacheBust: true }));
          if (i < n - 1) {
            await new Promise((r) => setTimeout(r, intervalMs || 120));
            try { gameState.previewMap.render(); } catch (e) { /* keep frames */ }
          }
        }
        return { planetId, frames };
      } finally { this.__restorePreview(el); }
    },
  };
  console.info('[structs-universe] __STRUCTS_VPLAYERS__ ready');
} catch (e) { console.warn('[structs-universe] vplayers façade failed', e); }
VP_EOF
grep -q "__STRUCTS_VPLAYERS__" "$BUILD_DIR/js/index.js" \
  || { echo "ERROR: vplayers façade patch did not apply"; exit 1; }

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
