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
# The trailing-slash trim is real defense: a configured base like
# "https://host/api/" turns every call into "/api//setting", which the server
# 404s (seen live 2026-08-21). Rust normalizes persisted configs too; this
# guards overrides that bypass it. new RegExp avoids sed-vs-JS backslash soup.
sed -i.bak "s|this.apiUrl = '/api';|this.apiUrl = (window.__STRUCTS_CONFIG__?.guildApi \|\| '/api').replace(new RegExp('/+\$'), '');|" \
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

echo "    Patching GrassManager.js (background-stall resume-check bridge)..."
# The webapp now self-heals stalled grass connections natively: as of upstream
# "Recover expired GuildAPI sessions and stalled GRASS connections", GrassManager
# has its own `resumeCheck()` (block-clock staleness, debounced) + `reconnect()`,
# already wired to visibilitychange/pageshow/online/focus and a poll interval.
#
# We only ADD extra trigger sources on top: main.rs dispatches
# `structs:grass-resume-check` on the native WKWebView foreground event, and
# structs-config.js's connection-recovery ladder dispatches it too. Bridge that
# event to the webapp's OWN resumeCheck() — do NOT re-implement reconnection.
# (The previous crude force-close + `_lastMessageAt` heartbeat fought upstream's
# debounced logic and is removed.)
GM="$BUILD_DIR/js/framework/GrassManager.js"

# Constructor: bridge our resume event to the webapp's native resumeCheck().
# Anchor: `this.listeners = new Map();` (still present in current webapp source).
# The `typeof` guard no-ops gracefully if a build predates native resumeCheck.
sed -i.bak "s|this.listeners = new Map();|this.listeners = new Map(); var __self = this; window.addEventListener('structs:grass-resume-check', function() { try { if (typeof __self.resumeCheck === 'function') __self.resumeCheck(); } catch(e) { console.warn('[GrassManager] resume-check bridge error', e); } });|" "$GM"
verify_patched "$GM" 'structs:grass-resume-check' "GrassManager.js resume-check bridge"

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
// (a virtual player). Signs over the node's HTTP RPC endpoint, NOT the WebSocket:
// CosmJS selects a STATELESS HttpClient for http(s):// URLs (a persistent
// WebSocketClient only for ws(s)://). The old WS transport held one open socket per
// vplayer; at 100+ vplayers a batched sweep opened 100+ concurrent WebSockets and
// exhausted the webview socket pool ("Insufficient resources"), which wedged every
// later sign AND the app's own block/NATS feeds until a full app restart. HTTP has
// no persistent socket, so no amount of vplayers or batch size can exhaust the pool
// (broadcast + tx-poll are plain HTTP requests). Clients are still cached per
// address to skip re-deriving chain params, but a cached client holds no socket.
// Primary client/queue untouched. Port 26657 (CometBFT RPC) serves both schemes.
SigningClientManager.prototype._vpClients = SigningClientManager.prototype._vpClients || new Map();
SigningClientManager.prototype.signAndBroadcastAs = async function (wallet, signerAddress, typeUrl, payload, mode) {
  const cache = SigningClientManager.prototype._vpClients;
  // Derive the HTTP RPC URL once from the WS URL (same host:26657, stateless scheme).
  const rpcUrl = this._vpRpcUrl || (this._vpRpcUrl =
    this.wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://'));
  let client = cache.get(signerAddress);
  if (!client) {
    // Bound the CONNECT too, not just the broadcast. This await used to be the
    // one unbounded step in the whole signing path: a connect that never
    // settles leaves the promise pending forever, so the Rust bridge times out
    // at 60s, the caller is told "is the app signed in?", and the JS side keeps
    // a zombie promise that can never resolve or reject. 20s is generous for a
    // handshake against a node that answers /status in ~20ms.
    //
    // TWO LESSONS FROM THE 2026-08-20 CRASH, when losing this race was the
    // app's entire output for 100 minutes:
    //
    //  1. SINGLE-FLIGHT. Promise.race abandons the connect but does not ABORT
    //     it — the attempt stays queued in WebKit's small per-host fetch pool.
    //     Racing a fresh connect per retry meant every timeout queued another
    //     doomed attempt behind the one that caused it, which is how the pool
    //     saturated and STAYED saturated until the WebContent process died.
    //     One in-flight connect per signer, shared by every caller.
    //
    //  2. SALVAGE THE STRAGGLER. A connect that loses the race is not garbage
    //     — when it eventually lands, cache it, so the next sign for this
    //     signer starts from a working client instead of connect #3.
    const inflight = SigningClientManager.prototype._vpConnects
      || (SigningClientManager.prototype._vpConnects = new Map());
    let pending = inflight.get(signerAddress);
    if (!pending) {
      pending = SigningStargateClient.connectWithSigner(rpcUrl, wallet, { registry: this.registry });
      inflight.set(signerAddress, pending);
      pending.then(
        function (c) { inflight.delete(signerAddress); cache.set(signerAddress, c); },
        function () { inflight.delete(signerAddress); }
      );
    }
    let connectTimer;
    try {
      client = await Promise.race([
        pending,
        new Promise(function (_, reject) {
          connectTimer = setTimeout(function () { reject(new Error('signing client connect timed out')); }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(connectTimer);
    }
  }
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
    // ASYNC MODE (opt-in from Rust, `structs_system config set {sign_mode:"async"}`).
    // signAndBroadcastSync returns the hash as soon as the mempool ACCEPTS the
    // tx (CheckTx: ante errors such as "zero charge this block" still surface
    // synchronously as a thrown error) instead of polling for inclusion. At
    // 2,400 players the inclusion wait — p50 6.1 s, one block — times the
    // gate's 4 slots was the whole system's throughput ceiling (~0.66 signs/s,
    // saturated for a full 45-minute window). The DeliverTx result is
    // delivered later by _vpWatchSettlement as a `tx_settled` grass event, which
    // the Rust side already records and surfaces loudly when it failed.
    if (mode === 'async' && typeof client.signAndBroadcastSync === 'function') {
      const hash = await Promise.race([
        client.signAndBroadcastSync(signerAddress, [{ typeUrl, value }], FEE),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('signAndBroadcastSync timed out')); }, 55000);
        }),
      ]);
      SigningClientManager.prototype._vpWatchSettlement(client, hash, typeUrl, signerAddress);
      return { code: 0, transactionHash: hash, height: null, rawLog: null, async: true };
    }
    // Race a hard timeout so a hung WS can't wedge the caller forever (55s stays
    // under the Rust bridge's 60s bound so the caller still gets an answer).
    const res = await Promise.race([
      client.signAndBroadcast(signerAddress, [{ typeUrl, value }], FEE),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('signAndBroadcast timed out (WS)')); }, 55000);
      }),
    ]);
    return { code: res.code, transactionHash: res.transactionHash, height: res.height, rawLog: res.rawLog || null };
  } catch (e) {
    // A failed/hung client is suspect — evict + close it so the next call for
    // this address reconnects fresh (successful signs keep the pooled client
    // open). Chain-level REJECTIONS are not client faults: the round-trip
    // worked, so tearing the client down just forces a pointless reconnect —
    // and during pool saturation those reconnects are exactly the inflow that
    // keeps the pool saturated. Evict only when the transport itself failed.
    const msg = String((e && e.message) || e);
    const chainReject = /code \d|failed to execute message|account sequence/.test(msg);
    if (!chainReject && cache.get(signerAddress) === client) {
      cache.delete(signerAddress);
      try { client.disconnect(); } catch (_) { /* ignore */ }
    }
    throw e;
  }
};
// Async-mode settlement watcher: poll getTx(hash) until the tx is in a block
// (or 90 s pass), then push ONE `tx_settled` grass event carrying the
// DeliverTx code — the same shape the primary's signing queue reports, so
// Rust's note_failed_settlement ledgers a failure and the board shows it.
// One poll every ~3 s per outstanding tx; a settled tx stops its own timer.
SigningClientManager.prototype._vpWatchSettlement = function (client, hash, typeUrl, signerAddress) {
  var started = Date.now();
  var push = function (status, code, height, rawLog, error) {
    if (!window.__TAURI__) return;
    window.__TAURI__.core.invoke('push_game_event', { event: {
      category: 'tx_settled',
      subject: typeUrl + ' ' + signerAddress,
      detail: { action: typeUrl, status: status, code: code, transactionHash: hash, height: height,
        error: error, rawLog: rawLog, signer: signerAddress, async: true },
      timestamp: Date.now()
    }}).catch(function () {});
  };
  var poll = function () {
    client.getTx(hash).then(function (tx) {
      if (tx) {
        var ok = tx.code === 0;
        push(ok ? 'succeeded' : 'dropped', tx.code, tx.height, tx.rawLog || null, ok ? null : (tx.rawLog || ('code ' + tx.code)));
        return;
      }
      if (Date.now() - started > 90000) { push('dropped', null, null, null, 'not in a block after 90s'); return; }
      setTimeout(poll, 3000);
    }, function (e) {
      if (Date.now() - started > 90000) { push('dropped', null, null, null, 'getTx failed: ' + ((e && e.message) || e)); return; }
      setTimeout(poll, 3000);
    });
  };
  setTimeout(poll, 3000);
};
SCM_EOF
grep -q "signAndBroadcastAs" "$SCM" \
  || { echo "ERROR: SigningClientManager signAndBroadcastAs patch did not apply"; exit 1; }

echo "    Patching MapStructLottieAnimationSVG.js (scope the struct-art swap to this animation's own SVG)..."
# The shared animation bundles (shake_*, destroy_*, deployment_*, move_*) are
# TEMPLATES with a placeholder hull baked in (a Cruiser-style hull in the
# shake bundles); after the SVG loads the game swaps each tagged layer for the
# struct's own art. It found those layers with
#   document.querySelector(`#${lottieContainerId} g g.struct_init image`)
# — a DOCUMENT-wide search by element id. Every map (alpha-base, raid,
# preview) builds its struct viewers with the same ids for the same struct
# (MapStructLayerComponent passes no idPrefix), so once a struct has animated
# on one map, a later hit on it on ANOTHER map patches the first SVG in
# document order — the hidden one — and the visible map keeps the template's
# hull: a fighter "turning into a cruiser" mid-attack (seen live 2026-09-02).
# Scope the query to this animation's own renderer, falling back to the old
# lookup only when lottie has not built the SVG yet.
LSVG="$BUILD_DIR/js/view_models/components/MapStructLottieAnimationSVG.js"
perl -0pi -e 's|const originalSVGImage = document\.querySelector\(\s*`#\$\{this\.lottieContainerId\} g g\$\{targetClass\} image`\s*\);|const ownSvg = this.animation \&\& this.animation.renderer \&\& this.animation.renderer.svgElement;\n    const originalSVGImage = ownSvg\n      ? ownSvg.querySelector(`g g\${targetClass} image`)\n      : document.querySelector(`#\${this.lottieContainerId} g g\${targetClass} image`);|' "$LSVG"
verify_patched "$LSVG" 'ownSvg.querySelector' "MapStructLottieAnimationSVG.js scoped swap"

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
  // `var`, not `const`: these façades are separate appended `try {}` blocks in
  // one module, and a `const` here is block-scoped — invisible to the Comms
  // façade below, which needs the same derivation to sign in as a roster
  // player. `var` is function/module-scoped, so there is ONE deriver rather
  // than a second copy of the key-handling code.
  var __vpDerive = async (index) => {
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
    // Optional requestedGuildId: signup always goes through the ACTIVE guild's
    // API (a guild API only serves its own guild), so a mismatch is an error,
    // not a redirect — switch the active guild first for cross-guild signup.
    async signup(index, name, requestedGuildId) {
      const a = await __vpDerive(index);
      const address = a.address;
      const pubkeyHex = walletManager.bytesToHex(a.pubkey);
      const guildId = gameState.thisGuild && gameState.thisGuild.id;
      if (!guildId) throw new Error('guild not loaded yet');
      if (requestedGuildId && requestedGuildId !== guildId) {
        throw new Error('signup targets guild ' + requestedGuildId + ' but active infrastructure serves guild ' + guildId + '; switch the active guild first');
      }
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
    async signAndBroadcast(index, typeUrl, payload, mode) {
      const wallet = await walletManager.createWalletForIndex(gameState.mnemonic, index);
      const accs = await wallet.getAccountsWithPrivkeys();
      const address = accs[0].address;
      return await signingClientManager.signAndBroadcastAs(wallet, address, typeUrl, payload, mode || 'sync');
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
    // Pre-inline every CSS background-image (the terrain tiles) as data: URLs.
    // WHY: html-to-image rasterizes the DOM through a sandboxed data-URL SVG
    // <foreignObject>; external url(/img/tiles/…) refs inside it are NEVER
    // fetched by the browser, and html-to-image's own fetch-embed fails on the
    // tauri:// asset protocol — so terrain tiles drop to blank (flat color +
    // white edge/horizon gaps). We load each tile via Image→canvas→toDataURL
    // (direct Image loads DO work in this webview — that's how the live map
    // displays) and rewrite the element's inline backgroundImage, leaving
    // html-to-image nothing to fetch. Same-origin (tauri://localhost serves
    // page + assets) so the canvas isn't tainted; if any toDataURL throws it's
    // caught and that one tile degrades to its color fallback (no regression).
    async __inlineBackgrounds(el, cache) {
      cache = cache || new Map();
      const toData = (url) => new Promise((resolve) => {
        if (cache.has(url)) return resolve(cache.get(url));
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            const d = c.toDataURL('image/png');
            cache.set(url, d); resolve(d);
          } catch (e) { cache.set(url, null); resolve(null); }
        };
        img.onerror = () => { cache.set(url, null); resolve(null); };
        img.src = url;
      });
      const nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
      const jobs = [];
      for (const node of nodes) {
        const bg = getComputedStyle(node).backgroundImage;
        if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
        const matches = Array.from(bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g));
        if (!matches.length) continue;
        jobs.push((async () => {
          let rewritten = bg;
          for (const m of matches) {
            const raw = m[2];
            if (raw.indexOf('data:') === 0) continue;
            const d = await toData(raw);
            if (d) rewritten = rewritten.split(m[0]).join('url("' + d + '")');
          }
          node.style.backgroundImage = rewritten;
        })());
      }
      await Promise.all(jobs);
    },
    // Make every CANVAS Lottie sprite inside the preview actually hold pixels
    // before capture. On macOS the Tauri init script forces ALL Lottie to the
    // canvas renderer; ONLINE planetary structs hide their still image and show
    // a looping "active_loop" canvas animation instead — and a canvas animation
    // created/loaded while its container was hidden (the preview is hidden
    // until showMap) has a 0x0 buffer, and one that loaded but never rendered
    // has a sized-but-BLANK buffer. Either way html-to-image captures nothing:
    // HP bars + slot platforms (DOM/CSS) showed, planetary sprites didn't.
    // Fix: resize any 0x0 canvas whose wrapper has layout, then force-draw the
    // current pose (goToAndStop) so the buffer holds the sprite; poll briefly
    // for animations still async-loading their JSON. SVG sprites are untouched.
    async __fixCanvasSprites(el, timeoutMs) {
      const L = window.lottie || window.bodymovin;
      if (!L || !L.getRegisteredAnimations) return;
      const deadline = Date.now() + (timeoutMs || 2500);
      for (;;) {
        let pending = 0;
        L.getRegisteredAnimations().forEach(function (a) {
          try {
            const w = a && a.wrapper;
            if (!w || !el.contains(w)) return;
            const cv = w.querySelector && w.querySelector('canvas');
            if (!cv) return; // SVG sprite — captures fine as-is
            if (!a.isLoaded) { pending++; return; } // JSON still loading
            if ((cv.width === 0 || cv.height === 0) && w.offsetWidth > 0) a.resize();
            if (cv.width === 0 || cv.height === 0) { pending++; return; }
            const ctx = cv.getContext('2d');
            if (ctx) ctx.imageSmoothingEnabled = false; // crisp pixel art
            a.goToAndStop(a.currentFrame || 0, true);   // force-draw the pose
          } catch (e) { /* skip this sprite */ }
        });
        if (!pending || Date.now() > deadline) break;
        await new Promise(function (r) { setTimeout(r, 120); });
      }
    },
    // Single-frame PNG of a planet's map (terrain + struct sprites + HP bars).
    async renderMapPng(planetId, playerId) {
      const el = await this.__preparePreview(planetId, playerId);
      try {
        await new Promise((r) => setTimeout(r, 1400)); // SVG/Lottie/terrain settle
        await this.__fixCanvasSprites(el); // planetary canvas sprites: size + draw
        await this.__inlineBackgrounds(el); // embed terrain tiles as data: URLs
        // NB: no cacheBust — it appends ?t=… to image URLs, which the tauri://
        // asset protocol 404s. Tiles are already inlined above, so toPng has
        // nothing external left to fetch.
        return { planetId, dataUrl: await window.htmlToImage.toPng(el, { pixelRatio: 2 }) };
      } finally { this.__restorePreview(el); }
    },
    // N frames → an animated GIF of the planet's Lottie struct sprites.
    // We DRIVE the animation by seeking each sprite's lottie playhead per frame
    // (goToAndStop) rather than calling previewMap.render() between frames —
    // render() rebuilds the DOM and recreates the lottie instances at their
    // initial pose, so every post-render frame was byte-identical (only frame 0,
    // captured after the settle, differed → a "frozen" GIF). Seeking the global
    // lottie AnimationItems in this preview container gives genuine motion, and
    // because the DOM isn't rebuilt the inlined terrain tiles persist across frames.
    async renderMapFrames(planetId, playerId, count, intervalMs) {
      const n = Math.max(2, Math.min(count || 12, 60));
      const el = await this.__preparePreview(planetId, playerId);
      const frames = [];
      const bgCache = new Map();
      // Lottie AnimationItems living inside this preview map (global registry).
      let anims = [];
      try {
        anims = (window.lottie && window.lottie.getRegisteredAnimations)
          ? window.lottie.getRegisteredAnimations().filter(function (a) {
              try { return a && a.wrapper && el.contains(a.wrapper); } catch (e) { return false; }
            })
          : [];
      } catch (e) { anims = []; }
      try {
        await new Promise((r) => setTimeout(r, 1400)); // terrain + lottie load/settle
        await this.__fixCanvasSprites(el);             // size 0x0 canvas sprites first
        await this.__inlineBackgrounds(el, bgCache);   // embed tiles once (DOM is stable now)
        for (let i = 0; i < n; i++) {
          // Seek every sprite to a distinct phase of its own loop for this frame.
          const t = n > 1 ? i / n : 0; // 0 .. <1 across the GIF
          anims.forEach(function (a) {
            try {
              const tf = a.totalFrames || (a.firstFrame != null && a.getDuration ? a.getDuration(true) : 0);
              if (tf > 0) a.goToAndStop(t * tf, true); // isFrame=true; SVG updates synchronously
            } catch (e) { /* skip this sprite */ }
          });
          await new Promise((r) => setTimeout(r, 30)); // let the SVG repaint
          frames.push(await window.htmlToImage.toPng(el, { pixelRatio: 1 }));
        }
        return { planetId, frames };
      } finally {
        // Resume live playback so the preview isn't left paused, then restore.
        try { anims.forEach(function (a) { try { a.play(); } catch (e) {} }); } catch (e) {}
        this.__restorePreview(el);
      }
    },
  };
  console.info('[structs-universe] __STRUCTS_VPLAYERS__ ready');
} catch (e) { console.warn('[structs-universe] vplayers façade failed', e); }
VP_EOF
grep -q "__STRUCTS_VPLAYERS__" "$BUILD_DIR/js/index.js" \
  || { echo "ERROR: vplayers façade patch did not apply"; exit 1; }

echo "    Patching index.js (expose __STRUCTS_COMMS__ chat-login façade)..."
# Comms (Matrix chat) signs in to the guild webapp with the SAME message the
# game's own login uses, because that webapp is the OIDC provider the guild's
# homeserver trusts. The key never leaves JS, so Rust asks for the signature
# through the bridge instead.
#
# Deliberately NOT a generic signing oracle: this takes (guild_id, timestamp)
# and builds the login message itself. It cannot be asked to sign an arbitrary
# string, so nothing reachable from the bridge can be turned into a signer for
# a chain payload.
cat >> "$BUILD_DIR/js/index.js" <<'COMMS_EOF'

// [structs-universe patch] Comms chat-login façade.
try {
  window.__STRUCTS_COMMS__ = {
    // Returns only what the guild's POST /auth/login needs. Same call path as
    // AuthManager.buildLoginRequest — if the game can log in, so can this.
    // `index` selects WHICH of our wallets signs: null/undefined is the
    // primary's signing account, a number is that HD index — one of the
    // roster players, which is how a second identity signs in to chat
    // alongside the primary.
    //
    // The derived private key never leaves this function, and the message is
    // still BUILT here from (guild, address, timestamp) rather than accepted
    // from the caller, so adding the selector does not turn this into a
    // generic signing oracle.
    async loginSignature(guildId, timestamp, index) {
      if (!guildId || !timestamp) {
        throw new Error('loginSignature needs a guild id and a timestamp');
      }
      let address, privkey, pubkey;
      if (index == null) {
        if (!gameState.signingAccount || !gameState.signingAccount.privkey) {
          throw new Error('not signed in to the game yet');
        }
        address = gameState.signingAccount.address;
        privkey = gameState.signingAccount.privkey;
        pubkey = gameState.pubkey;
      } else {
        // Shared with the vplayers façade above — see the `var` note there.
        if (typeof __vpDerive !== 'function') {
          throw new Error('vplayers façade missing; cannot sign as a roster player');
        }
        const a = await __vpDerive(index);
        address = a.address;
        privkey = a.privkey;
        pubkey = walletManager.bytesToHex(a.pubkey);
      }
      const message = guildAPI.buildLoginMessage(guildId, address, String(timestamp));
      const signature = await walletManager.createSignatureForProxyMessage(message, privkey);
      return { address: address, pubkey: pubkey, signature: signature };
    },
  };
  console.info('[structs-universe] __STRUCTS_COMMS__ ready');
} catch (e) { console.warn('[structs-universe] comms façade failed', e); }
COMMS_EOF
grep -q "__STRUCTS_COMMS__" "$BUILD_DIR/js/index.js" \
  || { echo "ERROR: comms façade patch did not apply"; exit 1; }

echo "    Patching index.js (expose __STRUCTS_TXQ__ signing-queue façade)..."
# Read/mutate surface over the primary's SigningQueueManager for the Team Ops
# TX page. Pure in-memory ops — never signs or broadcasts itself. The queue's
# own mutation API (cancel/reorder/move, "no player UI yet") does the work.
cat >> "$BUILD_DIR/js/index.js" <<'TXQ_EOF'

// [structs-universe patch] Signing-queue façade (Team Ops TX page).
try {
  // Serialize one SigningTransaction to safe plain JSON: payloads are
  // truncated to a preview and rawLog is dropped entirely (telemetry already
  // holds the translated error) so big messages never cross the bridge.
  const __txJson = (tx) => {
    if (!tx) return null;
    let preview = '';
    let truncated = false;
    try {
      preview = JSON.stringify(tx.message && tx.message.payload) || '';
      if (preview.length > 240) { preview = preview.slice(0, 240); truncated = true; }
    } catch (e) { preview = '(unserializable)'; }
    const typeUrl = (tx.message && tx.message.typeUrl) || '';
    return {
      id: tx.id,
      type_url: typeUrl,
      type_short: typeUrl.replace(/^.*Msg/, ''),
      payload_preview: preview,
      payload_truncated: truncated,
      is_action: !!tx.isAction,
      charge_cost: tx.chargeCost || 0,
      status: tx.status,
      created_at: tx.createdAt,
      enqueued_at_block: tx.enqueuedAtBlock,
      broadcast_at_block: tx.broadcastAtBlock,
      attempts: tx.attempts || 0,
      retry_limit: tx.retryLimit,
      response: tx.response ? {
        code: tx.response.code,
        transactionHash: tx.response.transactionHash,
        height: tx.response.height,
      } : null,
      error: tx.error ? String(tx.error).slice(0, 300) : null,
    };
  };
  window.__STRUCTS_TXQ__ = {
    snapshot() {
      const q = signingClientManager.queue;
      if (!q) throw new Error('signing queue not initialized (not signed in yet)');
      const etas = {};
      const percents = {};
      try { q.estimateScheduleTime().forEach((e) => { etas[e.id] = e; }); } catch (e) {}
      try { q.estimateSchedulePercent().forEach((p) => { percents[p.id] = p.percent; }); } catch (e) {}
      return {
        block_height: gameState.currentBlockHeight,
        avg_block_ms: q.getAvgBlockMs(),
        in_flight: __txJson(q.inFlight),
        action_queue: (q.actionQueue || []).map(__txJson),
        immediate_queue: (q.immediateQueue || []).map(__txJson),
        etas: etas,
        percents: percents,
      };
    },
    // Thin dispatch to the queue's existing mutation API. All ops return a
    // boolean (in-flight cancel returns false — surfaced, not thrown). A fresh
    // snapshot rides back so the board repaints in one round-trip.
    mutate(op, id, newIndex) {
      let ok = false;
      if (op === 'cancel') ok = signingClientManager.cancelQueueItem(id);
      else if (op === 'move_up') ok = signingClientManager.moveActionItemUp(id);
      else if (op === 'move_down') ok = signingClientManager.moveActionItemDown(id);
      else if (op === 'reorder') ok = signingClientManager.reorderActionQueue(id, newIndex);
      else throw new Error('unknown txq op ' + op);
      return { ok: !!ok, snapshot: this.snapshot() };
    },
  };
  console.info('[structs-universe] __STRUCTS_TXQ__ ready');
} catch (e) { console.warn('[structs-universe] txq façade failed', e); }
TXQ_EOF
grep -q "__STRUCTS_TXQ__" "$BUILD_DIR/js/index.js" \
  || { echo "ERROR: txq façade patch did not apply"; exit 1; }

# Clean up .bak files
find "$BUILD_DIR" -name "*.bak" -delete

echo "    Patches applied."
