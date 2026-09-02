/* One HTML escaper for this whole file.
 *
 * This patch builds a lot of its panels as innerHTML strings, and it had an
 * escaper buried inside the agent-UI section where the debug page's own row
 * builder could not reach it. So `row()` interpolated raw — see its comment.
 * File scope, so there is one and only one.
 */
var STRUCTS_ESC = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};

/* Remote images, through Rust.
 *
 * The app's CSP is `img-src 'self' data: blob:` — no `http:`, no `https:` —
 * so every image the webapp points at a remote host renders as a blank box.
 * The guild directory is where it shows: a guild's logo comes from
 * `guild_meta.logo`, published in that guild's own `guild.json`, and it is not
 * required to live near that guild's API —
 *
 *   SN Corp        https://beta.playstructs.com/img/logo-snc.gif
 *   Orbital Hydro  https://oh.energy/images/logo.svg   (not crew.oh.energy)
 *
 * Guilds WITHOUT a logo were fine, because the webapp draws `icon-unknown` for
 * those — which is why the list read as "some guilds have no picture" rather
 * than as a broken window.
 *
 * The CSP is not the bug. Those URLs are chosen by other players, and loading
 * them directly would tell an arbitrary host who is browsing the guild
 * directory and when. So the bytes come through `remote_image` instead — the
 * same answer the Comms window already uses for posted pictures, and the
 * reason the policy can stay shut.
 *
 * Generic on purpose: it adopts any remote `<img>` the game renders, not just
 * the guild directory, so the next screen that shows one is already handled.
 */
(function () {
  try {
    if (!window.__TAURI__ || window.__structsImgProxy) return;
    window.__structsImgProxy = true;

    var pending = {};    // url -> true while in flight
    var resolved = {};   // url -> data URI, so a re-render is free

    function adopt(img) {
      var url = img.getAttribute('src') || '';
      if (url.slice(0, 8) !== 'https://') return;
      img.dataset.remoteSrc = url;
      // Drop the blocked src NOW: leaving it set is what paints the empty box.
      img.removeAttribute('src');
      if (resolved[url]) { img.src = resolved[url]; return; }
      if (pending[url]) return;
      pending[url] = true;
      window.__TAURI__.core.invoke('remote_image', { url: url }).then(function (r) {
        delete pending[url];
        if (!r || !r.data_url) return;
        resolved[url] = r.data_url;
        // Every element waiting on this URL, not just the one that asked —
        // the directory re-renders and the same logo appears more than once.
        var all = document.querySelectorAll('img[data-remote-src]');
        for (var i = 0; i < all.length; i++) {
          if (all[i].dataset.remoteSrc === url) all[i].src = r.data_url;
        }
      }).catch(function (e) {
        delete pending[url];
        // A refusal is a fact about that guild's URL, not a window error.
        // Left as the webapp's own empty frame rather than invented artwork.
        console.info('[Structs] image not loaded: ' + url + ' — ' + e);
      });
    }

    function sweep(root) {
      if (!root || !root.querySelectorAll) return;
      if (root.tagName === 'IMG') adopt(root);
      var imgs = root.querySelectorAll('img[src^="https://"]');
      for (var i = 0; i < imgs.length; i++) adopt(imgs[i]);
    }

    sweep(document);
    // The game re-renders whole panels, so a one-shot sweep would only ever
    // fix whatever happened to be on screen at load.
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) sweep(added[j]);
        // `src` set after insertion — the directory builds rows this way.
        if (muts[i].type === 'attributes') sweep(muts[i].target);
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
    });
  } catch (e) {
    console.warn('[Structs] image proxy unavailable', e);
  }
})();

// [structs-universe DIAGNOSTIC — remove later] Identify the "dark square"
// render artifact. Hover the square and press Ctrl+Shift+D (or Cmd+Shift+D):
// logs the element stack under the cursor (id/class/rect/bg/visibility/
// content-visibility/canvas buffer) to Rust stderr (make launch-debug) and the
// console. Also flags any visible map-pip and any large dark-background element.
(function () {
  try {
    var lastX = 0, lastY = 0;
    window.addEventListener('mousemove', function (e) { lastX = e.clientX; lastY = e.clientY; }, true);
    function desc(el) {
      var cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : el.className;
      return el.tagName + (el.id ? '#' + el.id : '') + (cls ? '.' + String(cls).trim().replace(/\s+/g, '.').slice(0, 50) : '');
    }
    function line(el) {
      var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      var extra = el.tagName === 'CANVAS' ? (' buf=' + el.width + 'x' + el.height) : '';
      return '  ' + desc(el) + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
             ' bg=' + cs.backgroundColor + ' vis=' + cs.visibility + ' op=' + cs.opacity + ' cv=' + cs.contentVisibility + ' z=' + cs.zIndex + extra;
    }
    function log(msg) { try { console.log(msg); if (window.__TAURI__) window.__TAURI__.core.invoke('conn_log', { msg: msg }).catch(function () {}); } catch (e) {} }
    window.addEventListener('keydown', function (e) {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D'))) return;
      try {
        var out = ['[PROBE] cursor (' + lastX + ',' + lastY + '):'];
        (document.elementsFromPoint(lastX, lastY) || []).slice(0, 7).forEach(function (el) { out.push(line(el)); });
        // Any PiP bubble currently on-screen?
        document.querySelectorAll('.map-pip').forEach(function (p) {
          var r = p.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && getComputedStyle(p).visibility !== 'hidden') out.push('  [pip-visible] ' + line(p));
        });
        log(out.join('\n'));
      } catch (e2) {}
    }, true);
  } catch (e) {}
})();

// [structs-universe] Fix invisible planetary-struct idle (active-loop) animations.
// The webapp renders these struct animations with Lottie's CANVAS renderer. A
// canvas Lottie initialized while its map container is display:none gets a 0x0
// drawing buffer and never recovers, because the canvas renderer sizes its
// buffer once from the container and does NOT auto-resize when the container
// later gains size. All maps (alpha-base, raid, preview) are built at load but
// only one is shown, so every animation on an initially-hidden map is stuck at
// 0x0 — most visibly, the DEFENDING planet's structs when you open a raid.
// Fix: when a map container becomes visible, ask Lottie to resize its 0-size
// canvas animations so the buffer grows to the container. SVG animations are
// unaffected (they scale via the DOM), so this is a no-op for them.
(function () {
  try {
    // Disable image smoothing so Lottie's canvas renderer draws the struct
    // sprites crisp (pixel art) instead of bilinear-blurred. Lottie leaves the
    // context default (smoothing ON) for these, so — like the victory/defeat
    // banner patch does — we force it off. Set the prefixed variants too for
    // older WebKit. Cheap and idempotent; safe to re-apply on every resize.
    function crispCanvas(cv) {
      try {
        var ctx = cv.getContext && cv.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
      } catch (e) {}
    }
    function resizeZeroCanvasAnimations(rootEl) {
      var L = window.lottie;
      if (!L || !L.getRegisteredAnimations) return 0;
      var fixed = 0;
      L.getRegisteredAnimations().forEach(function (a) {
        try {
          var w = a && a.wrapper;
          if (!w || (rootEl && !rootEl.contains(w))) return;
          var cv = w.querySelector && w.querySelector('canvas');
          if (!cv) return;
          if ((cv.width === 0 || cv.height === 0) && w.offsetWidth > 0) {
            a.resize();
            if (cv.width > 0 && cv.height > 0) fixed++;
          }
          // Crisp-ify every canvas animation on the shown map, not just the
          // ones we resized — the already-sized ones render blurry too.
          if (cv.width > 0 && cv.height > 0) crispCanvas(cv);
        } catch (e) {}
      });
      return fixed;
    }
    // Resize a few times to catch animations that finish loading right around
    // the moment their map is shown (Lottie load is async).
    function scheduleResize(rootEl) {
      requestAnimationFrame(function () { resizeZeroCanvasAnimations(rootEl); });
      setTimeout(function () { resizeZeroCanvasAnimations(rootEl); }, 300);
      setTimeout(function () { resizeZeroCanvasAnimations(rootEl); }, 1200);
    }
    function isVisible(el) {
      return !el.classList.contains('hidden') && el.offsetWidth > 0;
    }
    function watch() {
      var maps = document.querySelectorAll('.map-container');
      if (!maps.length) { setTimeout(watch, 500); return; }
      maps.forEach(function (m) {
        var wasVisible = isVisible(m);
        var obs = new MutationObserver(function () {
          var vis = isVisible(m);
          if (vis && !wasVisible) scheduleResize(m);
          wasVisible = vis;
        });
        obs.observe(m, { attributes: true, attributeFilter: ['class', 'style'] });
        if (wasVisible) scheduleResize(m);
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
  } catch (e) {}
})();

// Config and fetch proxy are injected by Tauri initialization script before this runs.
// This file handles relative URL resolution for the proxied fetch.
if (window.__STRUCTS_CONFIG__ && window.__TAURI__) {
  const guildApi = window.__STRUCTS_CONFIG__.guildApi;
  if (guildApi) {
    // Strip trailing /api so we get the base origin for relative URL resolution
    const apiBase = guildApi.replace(/\/api\/?$/, '');
    const proxiedFetch = window.fetch;
    window.fetch = function(input, init) {
      let url = (typeof input === 'string') ? input : input.url;
      // Convert relative URLs to absolute using the guild API origin
      if (url.startsWith('/')) {
        url = apiBase + url;
      }
      var p = (typeof input === 'string')
        ? proxiedFetch.call(this, url, init)
        : proxiedFetch.call(this, new Request(url, input), init);
      // Tap Guild API auth state. A 401/403 means the server session expired;
      // the connection monitor watches this to drive session keepalive/recovery.
      // Cheap (status only — no body read), guild-API requests only.
      if (url.indexOf('/api') !== -1) {
        p.then(function(res) {
          try {
            var s = window.__STRUCTS_CONN__ && window.__STRUCTS_CONN__.guildAuth;
            if (!s) return;
            if (res.status === 401 || res.status === 403) {
              s.failedAt = Date.now();
              s.failCount++;
            } else if (res.status >= 200 && res.status < 300) {
              s.lastOkAt = Date.now();
            }
          } catch (e) {}
        }, function() {});
      }
      return p;
    };
  }
  console.info('Guild config loaded:', window.__STRUCTS_CONFIG__);

  // ── Connection-health shared state ──
  // Populated by the WebSocket proxy (grass) and the sync path (signing),
  // consumed by setupConnectionMonitor. Declared early so the proxy below
  // can stamp it on the first grass connection.
  window.__STRUCTS_CONN__ = window.__STRUCTS_CONN__ || {
    grass: { lastMessageAt: 0, lastOpenAt: 0, lastCloseAt: 0, closeCount: 0, readyState: -1, ws: null },
    signing: { present: false, lastSeenAt: 0 },
    // Guild REST session liveness. The webapp's /api/* surface is session-gated;
    // after a long idle (no REST traffic — steady-state data comes over grass)
    // the server session times out and every /api call returns 401, which breaks
    // raid rendering (enemy data can't be fetched). Stamped by the fetch tap below.
    guildAuth: { lastOkAt: 0, failedAt: 0, failCount: 0 },
    lastReloadAt: 0,
    reloadCount: 0
  };

  // ── Desktop Notifications for NATS events ──
  // Intercepts NATS WebSocket messages and fires native desktop notifications
  // for game events relevant to the current player. Uses gameState context to
  // filter out events about other players.
  (function setupStructsNotifications() {

    // ── Player Context ──
    // Returns the current player's IDs from the webapp's global gameState.
    // These are set after login, so early messages (before auth) are ignored.
    function getPlayerContext() {
      try {
        var kp = window.gameState && window.gameState.keyPlayers;
        if (!kp) return null;
        // KeyPlayer keys: 'player', 'raid_enemy', 'planet_raider'
        var me = kp.player || kp['player'];
        if (!me || !me.id) return null;
        return {
          playerId: me.id,                              // e.g. "1-18"
          planetId: me.planet && me.planet.id,          // e.g. "2-156"
          fleetId: me.fleet && me.fleet.id,             // e.g. "9-18"
          structs: me.structs || {}                     // { "5-42": Struct, ... }
        };
      } catch (e) {
        return null;
      }
    }

    // ── Display Name Helpers ──
    // Format: "player_name (id)", "planet_name (id)", "player_name (fleet_id)"
    function playerDisplay(playerId) {
      try {
        var kp = window.gameState && window.gameState.keyPlayers;
        if (kp && kp.player && kp.player.player && kp.player.id === playerId) {
          var name = kp.player.player.name || kp.player.player.username;
          if (name) return name + ' (' + playerId + ')';
        }
      } catch (e) {}
      return playerId || 'unknown';
    }

    function planetDisplay(planetId) {
      try {
        var kp = window.gameState && window.gameState.keyPlayers;
        if (kp && kp.player && kp.player.planet && kp.player.planet.id === planetId) {
          var name = kp.player.planet.name;
          if (name) return name + ' (' + planetId + ')';
        }
      } catch (e) {}
      return planetId || 'unknown';
    }

    function fleetDisplay(fleetId) {
      // Fleet shares index with player: fleet 9-X → player 1-X
      try {
        var playerIndex = fleetId && fleetId.split('-')[1];
        var playerId = '1-' + playerIndex;
        var kp = window.gameState && window.gameState.keyPlayers;
        if (kp && kp.player && kp.player.id === playerId) {
          var name = kp.player.player && (kp.player.player.name || kp.player.player.username);
          if (name) return name + ' (' + fleetId + ')';
        }
      } catch (e) {}
      return fleetId || 'unknown';
    }

    // ── Struct Type Name Lookup ──
    // Looks up the class name (e.g. "Reactor", "Mining Rig") from gameState
    // NATS struct subjects are like "structs.planet.2-156" or struct IDs like "5-1234"
    function structTypeName(structId) {
      try {
        var kp = window.gameState && window.gameState.keyPlayers;
        if (!kp || !kp.player || !kp.player.structs) return null;
        var struct = kp.player.structs[structId];
        if (!struct || !struct.type) return null;
        var structTypes = window.gameState.structTypes;
        if (!structTypes) return null;
        var structType = structTypes.getStructTypeById(struct.type);
        if (!structType) return null;
        return structType.type || structType['class'] || structType.category || null;
      } catch (e) { return null; }
    }

    // Format a struct reference: "Frigate" or just "Struct"
    function structDisplay(structId) {
      var name = structTypeName(structId);
      return name || 'Struct';
    }

    // Helper: extract planet ID from NATS subject like "structs.planet.2-156"
    function subjectPlanetId(subject) {
      if (!subject) return null;
      var parts = subject.split('.');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf('2-') === 0) return parts[i];
      }
      return null;
    }

    /* Does this GRASS subject name `id` as a WHOLE token?
     *
     * Subjects are dot-delimited, e.g.
     *   structs.inventory.ualpha.0-1.1-1957.structs1wvqnnuhcd6g4up37km04vrqm6m9a7vtg5df9tl
     * so testing with indexOf() matches any id that merely CONTAINS ours.
     * Player 1-195 was notified "You sent 1 Alpha Matter" for an event that
     * belonged to 1-1957, because "1-1957".indexOf("1-195") === 0. The entire
     * 1-1950…1-1958 cohort collides with 1-195, and the same trap exists at
     * every ten-fold boundary — 1-19 collides with 1-190…1-199, and so on. It
     * stays invisible until someone registers an id in the colliding range.
     *
     * Splitting on the delimiter and comparing whole tokens is exact: ids never
     * contain a dot, so a token is always a complete id.
     */
    function subjectRefersTo(subject, id) {
      if (!subject || !id) return false;
      var parts = String(subject).split('.');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === String(id)) return true;
      }
      return false;
    }

    // Helper: check if a struct ID belongs to us
    function isMyStruct(structId, ctx) {
      return ctx && ctx.structs && ctx.structs.hasOwnProperty(structId);
    }

    // ── Notification Definitions ──
    // Each entry has: title, format(data, ctx), filter(data, ctx) → boolean
    // filter() returns true if this event is relevant to the current player.
    // If filter is omitted, the event always notifies.
    // ── Raid Status Mapping ──
    var RAID_STATUS_MESSAGES = {
      'requested':          { defending: 'A raid has been requested against your Planet', attacking: 'Your raid request has been submitted' },
      'initiated':          { defending: 'Your Planet is under attack!', attacking: 'Your raid has begun!' },
      'ongoing':            { defending: 'Your Planet is under attack!', attacking: 'Your raid is in progress' },
      'attackerDefeated':   { defending: 'Raid repelled! The attacker has been defeated', attacking: 'Your Fleet was defeated in the raid' },
      'attackerRetreated':  { defending: 'The attacker has retreated from your Planet', attacking: 'Your Fleet has retreated' },
      'raidSuccessful':     { defending: 'Raid successful — Ore was stolen from your Planet!', attacking: 'Raid successful — Ore has been seized!' },
      'demilitarized':      { defending: 'Your Planet has been demilitarized', attacking: 'The target Planet has been demilitarized' }
    };

    // ── Struct Status Bitflag Decoder ──
    var STRUCT_STATUS_FLAGS = {
      1: 'Materialized', 2: 'Built', 4: 'Online', 8: 'Stored',
      16: 'Hidden', 32: 'Destroyed', 64: 'Locked'
    };

    function decodeStructStatus(statusValue) {
      if (typeof statusValue !== 'number') return statusValue;
      var flags = [];
      for (var bit in STRUCT_STATUS_FLAGS) {
        if (statusValue & parseInt(bit)) flags.push(STRUCT_STATUS_FLAGS[bit]);
      }
      return flags.length > 0 ? flags.join(', ') : 'Unknown';
    }

    // ── Unit Display Formatter ──
    // Mirrors structs.UNIT_DISPLAY_FORMAT from structs-pg
    /* Alpha, ore and power, on the game's own ladders.
     *
     * The tables live in units.js rather than here. This file used to carry a
     * third private copy of them — after board.js's and Rust's — and copies of
     * these tables have already drifted once: the Rust suite still records that
     * ore's Tg divisor was 1e12 in one place and 1e18 in another, a factor of a
     * million on a number a player reads as a holding.
     */
    function formatUnit(amount, denom) {
      if (amount == null || amount === '?') return '?';
      var num = parseFloat(amount);
      if (isNaN(num)) return String(amount);
      var U = window.StructsUnits;
      if (denom === 'ore') return U.fmtOre(num);
      if (denom === 'milliwatt') return U.fmtWatts(num);
      // No denom means Alpha: the debug panel's commonest column.
      if (denom === 'ualpha' || !denom) return U.fmtAlpha(num);
      return String(amount);
    }

    var NOTIFICATION_EVENTS = {

      // ── 🔴 URGENT ──

      'raid_status': {
        priority: 'urgent',
        title: function(d, ctx) {
          var planetId = d.detail && d.detail.planet_id;
          var status = d.detail && d.detail.status;
          if (ctx && planetId === ctx.planetId) {
            if (status === 'initiated' || status === 'ongoing') return 'Your Planet is Under Raid!';
            if (status === 'attackerDefeated' || status === 'attackerRetreated') return 'Raid Repelled!';
            if (status === 'raidSuccessful') return 'Raid Successful!';
            if (status === 'demilitarized') return 'Planet Demilitarized';
            return 'Raid Alert';
          }
          return 'Raid Update';
        },
        format: function(d, ctx) {
          var detail = d.detail || {};
          var status = detail.status || 'unknown';
          var planetId = detail.planet_id || subjectPlanetId(d.subject) || 'unknown';
          var msgs = RAID_STATUS_MESSAGES[status];

          if (ctx && planetId === ctx.planetId) {
            var msg = msgs ? msgs.defending : 'Raid status changed on your Planet';
            if (status === 'raidSuccessful' && detail.seized_ore) {
              msg = formatUnit(detail.seized_ore, 'ore') + ' Ore was stolen from your Planet!';
            }
            return msg;
          }
          // Our Fleet raiding someone else
          var attackMsg = msgs ? msgs.attacking : 'Raid status: ' + status;
          if (status === 'raidSuccessful' && detail.seized_ore) {
            attackMsg = 'Raid successful — ' + formatUnit(detail.seized_ore, 'ore') + ' Ore seized!';
          }
          return attackMsg;
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var planetId = (d.detail && d.detail.planet_id) || subjectPlanetId(d.subject);
          var fleetId = d.detail && d.detail.fleet_id;
          return planetId === ctx.planetId || fleetId === ctx.fleetId;
        },
        debounce: 2000
      },

      'struct_attack': {
        priority: 'urgent',
        title: function() { return 'Structs Under Attack!'; },
        format: function(d) {
          var shots = (d.detail && d.detail.eventAttackShotDetail) || [];
          // Try to name the target Structs
          var targets = [];
          for (var i = 0; i < shots.length; i++) {
            var tid = shots[i].targetStructId;
            if (tid) {
              var name = structDisplay(tid);
              if (targets.indexOf(name) === -1) targets.push(name);
            }
          }
          if (targets.length > 0) return shots.length + ' shot(s) fired at ' + targets.join(', ');
          return shots.length + ' shot(s) fired at your Structs';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var shots = (d.detail && d.detail.eventAttackShotDetail) || [];
          for (var i = 0; i < shots.length; i++) {
            if (isMyStruct(shots[i].targetStructId, ctx)) return true;
            if (isMyStruct(shots[i].blockedByStructId, ctx)) return true;
          }
          var planetId = subjectPlanetId(d.subject);
          return planetId === ctx.planetId;
        },
        debounce: 2000
      },

      'fleet_arrive': {
        priority: 'urgent',
        title: function(d, ctx) {
          var fleetId = d.detail && d.detail.fleet_id;
          if (ctx && fleetId === ctx.fleetId) return 'Your Fleet Has Arrived';
          return 'Enemy Fleet Incoming!';
        },
        format: function(d, ctx) {
          var fleetId = d.detail && d.detail.fleet_id;
          var planetId = subjectPlanetId(d.subject);
          if (ctx && fleetId === ctx.fleetId) {
            return 'Your Fleet arrived at Planet ' + planetDisplay(planetId);
          }
          return 'Enemy Fleet ' + fleetDisplay(fleetId) + ' has arrived at your Planet';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var fleetId = d.detail && d.detail.fleet_id;
          var planetId = subjectPlanetId(d.subject);
          return fleetId === ctx.fleetId || planetId === ctx.planetId;
        },
        debounce: 3000
      },

      'fleet_depart': {
        priority: 'important',
        title: function(d, ctx) {
          var fleetId = d.detail && d.detail.fleet_id;
          if (ctx && fleetId === ctx.fleetId) return 'Your Fleet Departed';
          return 'Enemy Fleet Left';
        },
        format: function(d, ctx) {
          var fleetId = d.detail && d.detail.fleet_id;
          var planetId = subjectPlanetId(d.subject);
          if (ctx && fleetId === ctx.fleetId) {
            return 'Your Fleet departed from Planet ' + planetDisplay(planetId);
          }
          return 'Enemy Fleet ' + fleetDisplay(fleetId) + ' has left your Planet';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var fleetId = d.detail && d.detail.fleet_id;
          var planetId = subjectPlanetId(d.subject);
          return fleetId === ctx.fleetId || planetId === ctx.planetId;
        },
        debounce: 3000
      },

      // ── 🟡 IMPORTANT ──

      'struct_block_ore_mine_start': {
        priority: 'important',
        title: function() { return 'Mining Started'; },
        format: function(d) {
          var sid = d.detail && d.detail.struct_id;
          var name = sid ? structDisplay(sid) : 'A Mining Rig';
          return name + ' has started mining';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var planetId = subjectPlanetId(d.subject);
          return planetId === ctx.planetId;
        },
        debounce: 5000
      },

      'struct_block_ore_refine_start': {
        priority: 'important',
        title: function() { return 'Refining Started'; },
        format: function(d) {
          var sid = d.detail && d.detail.struct_id;
          var name = sid ? structDisplay(sid) : 'A Refinery';
          return name + ' has started refining';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var planetId = subjectPlanetId(d.subject);
          return planetId === ctx.planetId;
        },
        debounce: 5000
      },

      'struct_block_build_start': {
        priority: 'important',
        title: function(d) {
          var sid = d.detail && d.detail.struct_id;
          var className = sid ? structTypeName(sid) : null;
          return (className || 'Struct') + ' Build Started';
        },
        format: function(d) {
          var sid = d.detail && d.detail.struct_id;
          var name = sid ? structDisplay(sid) : 'A Struct';
          return name + ' has started building on your Planet';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var planetId = subjectPlanetId(d.subject);
          return planetId === ctx.planetId;
        },
        debounce: 5000
      },

      'struct_status': {
        priority: 'important',
        title: function(d) {
          var status = d.detail && d.detail.status;
          var sid = d.detail && d.detail.struct_id;
          var className = (sid ? structTypeName(sid) : null) || 'Struct';
          if (typeof status === 'number') {
            if (status & 32) return className + ' Destroyed';
          }
          return className + ' Status Changed';
        },
        format: function(d) {
          var status = d.detail && d.detail.status;
          var sid = d.detail && d.detail.struct_id;
          var name = sid ? structDisplay(sid) : 'A Struct';
          if (typeof status === 'number') {
            if (status & 32) return name + ' on your Planet has been destroyed';
            return name + ' is now ' + decodeStructStatus(status);
          }
          return name + ' status changed';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          var planetId = subjectPlanetId(d.subject);
          return planetId === ctx.planetId;
        },
        debounce: 5000
      },

      // Alpha Matter transfers
      'sent': {
        priority: 'important',
        title: function() { return 'Alpha Matter Sent'; },
        format: function(d) {
          var amount = d.amount || (d.detail && d.detail.amount) || '?';
          return 'You sent ' + formatUnit(amount, 'ualpha') + ' Alpha Matter';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          return subjectRefersTo(d.subject, ctx.playerId);
        },
        debounce: 3000
      },

      'received': {
        priority: 'important',
        title: function() { return 'Alpha Matter Received'; },
        format: function(d) {
          var amount = d.amount || (d.detail && d.detail.amount) || '?';
          var from = d.counterparty || (d.detail && d.detail.counterparty) || 'unknown';
          return 'You received ' + formatUnit(amount, 'ualpha') + ' Alpha Matter from ' + from;
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          return subjectRefersTo(d.subject, ctx.playerId);
        },
        debounce: 3000
      },

      // Power overload
      'load': {
        priority: 'urgent',
        title: function() { return 'Power Overload!'; },
        format: function() {
          return 'Your power load exceeds capacity — all Structs halted!';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          // Only care about our own player's load changes
          if (!(subjectRefersTo(d.subject, ctx.playerId))) return false;
          // Only notify if this is actually an overload
          // (we'd need capacity info — for now, always notify on load changes to our player)
          return true;
        },
        debounce: 10000
      },

      'capacity': {
        priority: 'important',
        title: function() { return 'Power Capacity Changed'; },
        format: function(d) {
          return 'Your power capacity has changed — check your power balance';
        },
        filter: function(d, ctx) {
          if (!ctx) return false;
          return subjectRefersTo(d.subject, ctx.playerId);
        },
        debounce: 10000
      }
    };

    // ── Debounce ──
    var lastNotification = {};
    var DEFAULT_DEBOUNCE_MS = 5000;

    function shouldNotify(category, debounceMs) {
      var now = Date.now();
      var ms = debounceMs || DEFAULT_DEBOUNCE_MS;
      if (lastNotification[category] && (now - lastNotification[category]) < ms) {
        return false;
      }
      lastNotification[category] = now;
      return true;
    }

    // `channel` is the grass event category, which is also the key the
    // Notifications section switches on (Rust: notifications::CHANNELS). Rust
    // is the gate — passing the category through is the whole wiring, and a
    // category with no switch yet still notifies (is_on fails open).
    function sendNotification(title, body, channel) {
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('send_notification',
          { title: title, body: body, channel: channel || null })
          .catch(function(e) { console.warn('[Structs Notify] Failed:', e); });
      }
    }

    // ── Notification Preferences ──
    window.__STRUCTS_NOTIFICATIONS__ = {
      enabled: true,
      categories: Object.keys(NOTIFICATION_EVENTS).reduce(function(acc, k) {
        acc[k] = true;
        return acc;
      }, {}),
      toggle: function(category, on) {
        if (category === 'all') {
          this.enabled = on !== undefined ? on : !this.enabled;
        } else if (this.categories.hasOwnProperty(category)) {
          this.categories[category] = on !== undefined ? on : !this.categories[category];
        }
      }
    };

    // ── WebSocket Proxy ──
    // Intercept WebSocket to tap NATS messages transparently.
    var OriginalWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct: function(target, args) {
        var url = args[0] || '';

        // TLS self-heal for grass. A guild that moves its NATS port behind
        // TLS keeps publishing ws:// until its guild.json catches up (live
        // case: oh.energy, 2026-08-28 — grass died and every charge-gated
        // loop idled). If plain-ws grass keeps closing without EVER
        // delivering a message, upgrade the connection attempts to wss://;
        // once an upgrade works the flag keeps later reconnects on wss too.
        if (url.indexOf('ws://') === 0 && url.indexOf('1443') !== -1
            && window.__STRUCTS_CONN__ && window.__STRUCTS_CONN__.grass) {
          var gconn = window.__STRUCTS_CONN__.grass;
          if (gconn.tlsUpgraded || (gconn.closeCount >= 3 && !gconn.lastMessageAt)) {
            url = 'wss://' + url.slice('ws://'.length);
            args = [url].concat([].slice.call(args, 1));
            if (!gconn.tlsUpgraded) {
              gconn.tlsUpgraded = true;
              console.warn('[Structs Notify] grass ws:// fails without ever delivering — retrying as', url);
            }
          }
        }

        var ws = new target(...args);

        // Only hook NATS WebSocket connections (port 1443 / grassNatsWs)
        var grassUrl = (window.__STRUCTS_CONFIG__ && window.__STRUCTS_CONFIG__.grassNatsWs) || ':1443';
        if (url.indexOf('1443') !== -1 || url.indexOf(grassUrl) !== -1) {
          console.info('[Structs Notify] Hooked NATS WebSocket:', url);

          // Connection-health stamps (consumed by setupConnectionMonitor).
          // lastMessageAt is the most reliable liveness signal — grass streams
          // block events continuously, so a long silence = degraded/dead even
          // when readyState lies.
          var conn = window.__STRUCTS_CONN__.grass;
          conn.ws = ws;
          conn.lastOpenAt = Date.now();
          conn.readyState = ws.readyState;
          ws.addEventListener('open', function() {
            conn.lastOpenAt = Date.now();
            conn.readyState = ws.readyState;
          });
          ws.addEventListener('close', function() {
            conn.lastCloseAt = Date.now();
            conn.closeCount++;
            conn.readyState = ws.readyState;
          });
          ws.addEventListener('error', function() {
            conn.readyState = ws.readyState;
          });
          ws.addEventListener('message', function() {
            conn.lastMessageAt = Date.now();
            conn.readyState = ws.readyState;
          });

          ws.addEventListener('message', function(event) {
            try {
              // NB: do NOT gate on __STRUCTS_NOTIFICATIONS__.enabled here. The
              // MCP event buffer + reactivity driver are independent consumers
              // of the grass stream; gating them on the desktop-notification
              // toggle silently kills structs_events (and live UI refresh) when
              // a user turns notifications off. Only the notification DISPATCH
              // below is gated on `enabled`.

              // Handle both string and binary NATS frames
              var raw;
              if (typeof event.data === 'string') {
                raw = event.data;
              } else if (event.data instanceof ArrayBuffer) {
                raw = new TextDecoder().decode(event.data);
              } else {
                return; // Blob — skip
              }

              var jsonStart = raw.indexOf('{');
              if (jsonStart === -1) return;

              var jsonStr = raw.substring(jsonStart);
              var braceCount = 0;
              var jsonEnd = -1;
              for (var i = 0; i < jsonStr.length; i++) {
                if (jsonStr[i] === '{') braceCount++;
                if (jsonStr[i] === '}') braceCount--;
                if (braceCount === 0) { jsonEnd = i + 1; break; }
              }
              if (jsonEnd === -1) return;

              var data = JSON.parse(jsonStr.substring(0, jsonEnd));
              if (!data.category) return;

              // Push all events to Rust event buffer for MCP access.
              // Fold any TOP-LEVEL grass fields into `detail` first: inventory
              // events (refined/mined/sent/received/burned/infused) carry their
              // `amount` at the top level of the message, NOT inside `detail`, so
              // forwarding only `data.detail` dropped it and the MCP feed could
              // never see inventory amounts. Merge top-level extras first, then
              // let the structured `detail` keys win on any conflict.
              // `block` ticks are forwarded too — Rust relays them to the GRASS
              // page as a liveness heartbeat but keeps them out of the MCP buffer.
              if (window.__TAURI__) {
                var mergedDetail = {};
                for (var __k in data) {
                  if (__k !== 'category' && __k !== 'subject' && __k !== 'detail') {
                    mergedDetail[__k] = data[__k];
                  }
                }
                if (data.detail && typeof data.detail === 'object') {
                  for (var __d in data.detail) mergedDetail[__d] = data.detail[__d];
                }
                window.__TAURI__.core.invoke('push_game_event', {
                  event: {
                    category: data.category,
                    subject: data.subject || '',
                    detail: mergedDetail,
                    timestamp: Date.now()
                  }
                }).catch(function() {});
              }

              // Nudge the reactivity driver so the open menu page reflects the change.
              if (window.__STRUCTS_REACTIVITY__) {
                window.__STRUCTS_REACTIVITY__.onGrassFrame(data.category);
              }

              // Desktop notifications are independently gated (the feed + reactivity above always run).
              if (!window.__STRUCTS_NOTIFICATIONS__.enabled) return;

              var eventDef = NOTIFICATION_EVENTS[data.category];
              if (!eventDef) {
                console.debug('[Structs Notify] Unhandled category:', data.category);
                return;
              }
              if (!window.__STRUCTS_NOTIFICATIONS__.categories[data.category]) return;

              // Get player context for smart filtering
              var ctx = getPlayerContext();

              // Apply relevance filter — skip events about other players
              if (eventDef.filter) {
                if (!eventDef.filter(data, ctx)) {
                  console.debug('[Structs Notify] Filtered out (not relevant):', data.category, data.subject);
                  return;
                }
              }

              if (!shouldNotify(data.category, eventDef.debounce)) return;

              // For struct events where the type isn't loaded yet, delay briefly
              // to let the webapp's refreshStruct populate gameState first
              var structId = data.detail && data.detail.struct_id;
              var needsDelay = structId && !structTypeName(structId) &&
                (data.category === 'struct_block_build_start' ||
                 data.category === 'struct_block_ore_mine_start' ||
                 data.category === 'struct_block_ore_refine_start' ||
                 data.category === 'struct_status');

              function dispatchNotification() {
                var title = typeof eventDef.title === 'function' ? eventDef.title(data, ctx) : eventDef.title;
                var body = eventDef.format(data, ctx);
                console.info('[Structs Notify] Sending notification:', title, '—', body);
                sendNotification(title, body, data.category);
              }

              if (needsDelay) {
                setTimeout(dispatchNotification, 2000);
              } else {
                dispatchNotification();
              }
            } catch (e) {
              // Silent fail — don't break the app for notification parsing errors
            }
          });
        }

        return ws;
      }
    });

    console.info('Structs desktop notifications enabled for:', Object.keys(NOTIFICATION_EVENTS).join(', '));
  })();

  // ── Rust Hasher: Worker Shim ──
  // Intercepts WebWorker creation for TaskWorker.js and routes hashing
  // to the Rust backend via Tauri commands. Uses a Proxy on the Worker
  // constructor to create real Worker instances (satisfying instanceof
  // and setter checks) while intercepting postMessage/terminate.
  (function setupRustHasher() {
    var OriginalWorker = window.Worker;

    // Convert ms epoch timestamps back to Date objects for JS TaskState compatibility
    function convertSnapshotDates(snapshot) {
      var obj = {};
      for (var key in snapshot) {
        if (snapshot.hasOwnProperty(key)) {
          obj[key] = snapshot[key];
        }
      }
      if (typeof obj.process_start_time === 'number') {
        obj.process_start_time = new Date(obj.process_start_time);
      }
      if (typeof obj.last_status_change_time === 'number') {
        obj.last_status_change_time = new Date(obj.last_status_change_time);
      }
      if (typeof obj.process_end_time === 'number') {
        obj.process_end_time = new Date(obj.process_end_time);
      }
      if (typeof obj.block_checkpoint_time === 'number') {
        obj.block_checkpoint_time = new Date(obj.block_checkpoint_time);
      }
      return obj;
    }

    window.Worker = new Proxy(OriginalWorker, {
      construct: function(target, args) {
        var url = args[0] || '';

        // Not a TaskWorker — create a real Worker
        if (typeof url !== 'string' || url.indexOf('TaskWorker') === -1) {
          return new target(url);
        }

        console.info('[Structs Hasher] Intercepting TaskWorker → Rust backend');

        // Create a real Worker pointing at a no-op blob so instanceof checks pass
        var blob = new Blob([''], { type: 'application/javascript' });
        var blobUrl = URL.createObjectURL(blob);
        var ws = new target(blobUrl);
        URL.revokeObjectURL(blobUrl);

        var _pid = null;
        var _unlisteners = [];
        var _terminated = false;

        // Override postMessage to route to Rust
        var origPostMessage = ws.postMessage.bind(ws);
        ws.postMessage = function(data) {
          if (_terminated) return;
          var state = data[0];
          _pid = state.object_id;
          var pid = _pid;

          // Convert Date objects to ms epoch for Rust
          var params = {};
          for (var key in state) {
            if (state.hasOwnProperty(key)) {
              var val = state[key];
              if (val instanceof Date) {
                params[key] = val.getTime();
              } else {
                params[key] = val;
              }
            }
          }

          // Register listeners FIRST, then start the task to avoid race conditions
          Promise.all([
            window.__TAURI__.event.listen('hash_progress', function(event) {
              if (_terminated) return;
              if (event.payload.object_id !== pid) return;
              if (!ws.onmessage) return;
              var snapshot = convertSnapshotDates(event.payload);
              ws.onmessage({ data: [snapshot] });
            }),
            window.__TAURI__.event.listen('hash_complete', function(event) {
              if (_terminated) return;
              if (event.payload.object_id !== pid) return;
              if (!ws.onmessage) return;
              var snapshot = convertSnapshotDates(event.payload);
              ws.onmessage({ data: [snapshot] });
              // Notify Rust for auto-chain policies (e.g., auto_refine after mine).
              // Arg names MUST be camelCase — Tauri v2 camelCases command args
              // across the bridge, so snake_case keys fail to deserialize and the
              // command never runs. Never swallow the rejection: a silent catch
              // here is what hid this call being dead.
              window.__TAURI__.core.invoke('notify_hash_complete', {
                structId: event.payload.object_id,
                taskType: event.payload.task_type || ''
              }).catch(function(e) {
                console.error('[Structs Hasher] notify_hash_complete failed:', e);
              });
            })
          ]).then(function(unlistenFns) {
            _unlisteners = _unlisteners.concat(unlistenFns);
            // Now start the Rust hasher
            return window.__TAURI__.core.invoke('start_hash_task', { params: params });
          }).then(function() {
            console.info('[Structs Hasher] Task started:', pid);
          }).catch(function(e) {
            console.error('[Structs Hasher] Failed to start task:', pid, e);
          });
        };

        // Override terminate to stop the Rust task
        var origTerminate = ws.terminate.bind(ws);
        ws.terminate = function() {
          _terminated = true;
          if (_pid) {
            window.__TAURI__.core.invoke('stop_hash_task', { pid: _pid })
              .catch(function() {});
          }
          _unlisteners.forEach(function(fn) { fn(); });
          _unlisteners = [];
          origTerminate();
        };

        return ws;
      }
    });

    console.info('[Structs Hasher] Worker shim installed — hashing will use Rust backend');
  })();

  // ── GameState Sync to Rust ──
  // Periodically push gameState data to Rust so the MCP server can
  // auto-fill parameters like block_start and difficulty_target.
  (function setupGameStateSync() {
    function syncGameState() {
      // gameState is set via `global.gameState` in webpack bundle.
      // In browser context global === window, but webpack may wrap it.
      // Also try self.gameState and check if gameState is a property of any scope.
      var gs = window.gameState || self.gameState || (typeof gameState !== 'undefined' ? gameState : null);
      if (!gs || !window.__TAURI__) return;

      try {
        var kp = gs.keyPlayers && gs.keyPlayers.player;

        // Build structs map
        var structs = {};
        if (kp && kp.structs) {
          for (var sid in kp.structs) {
            if (kp.structs.hasOwnProperty(sid)) {
              var s = kp.structs[sid];
              var typeName = null;
              if (gs.structTypes && s.type) {
                var st = gs.structTypes.getStructTypeById(s.type);
                if (st) typeName = st.type;
              }
              structs[sid] = {
                id: s.id,
                struct_type_id: numOrZero(s.type),
                struct_type_name: typeName,
                owner: s.owner || '',
                status: numOrZero(s.status),
                location_type: s.location_type || null,
                location_id: s.location_id || null,
                operating_ambit: s.operating_ambit || null,
                health: num(s.health)
              };
            }
          }
        }

        // Build struct_types map
        var structTypes = {};
        if (gs.structTypes && gs.structTypes.structTypes) {
          var types = gs.structTypes.structTypes;
          for (var i = 0; i < types.length; i++) {
            var t = types[i];
            structTypes[String(t.id)] = {
              id: numOrZero(t.id),
              name: t.type || '',
              category: t.category || null,
              build_difficulty: numOrZero(t.build_difficulty),
              ore_mining_difficulty: numOrZero(t.ore_mining_difficulty),
              ore_refining_difficulty: numOrZero(t.ore_refining_difficulty),
              passive_draw: num(t.passive_draw),
              max_health: num(t.max_health),
              // Per-action charge costs + combat targeting bitmasks. gameState
              // casing varies by source, so read snake_case or camelCase.
              build_charge: pickNum(t, 'build_charge', 'buildCharge'),
              activate_charge: pickNum(t, 'activate_charge', 'activateCharge'),
              move_charge: pickNum(t, 'move_charge', 'moveCharge'),
              defend_change_charge: pickNum(t, 'defend_change_charge', 'defendChangeCharge'),
              stealth_activate_charge: pickNum(t, 'stealth_activate_charge', 'stealthActivateCharge'),
              ore_mining_charge: pickNum(t, 'ore_mining_charge', 'oreMiningCharge'),
              ore_refining_charge: pickNum(t, 'ore_refining_charge', 'oreRefiningCharge'),
              primary_weapon_charge: pickNum(t, 'primary_weapon_charge', 'primaryWeaponCharge'),
              secondary_weapon_charge: pickNum(t, 'secondary_weapon_charge', 'secondaryWeaponCharge'),
              possible_ambit: pickNum(t, 'possible_ambit', 'possibleAmbit'),
              // v0.21.0: only canDefend types may be registered as defenders
              // (fleet true, planetary false). Absent on older chains.
              can_defend: pickBool(t, 'can_defend', 'canDefend'),
              primary_weapon_ambits: pickNum(t, 'primary_weapon_ambits', 'primaryWeaponAmbits'),
              secondary_weapon_ambits: pickNum(t, 'secondary_weapon_ambits', 'secondaryWeaponAmbits'),
              // Combat math fields (ruleset matrix + damage simulator).
              primary_weapon: pickStr(t, 'primary_weapon', 'primaryWeapon'),
              primary_weapon_control: pickStr(t, 'primary_weapon_control', 'primaryWeaponControl'),
              primary_weapon_shots: pickNum(t, 'primary_weapon_shots', 'primaryWeaponShots'),
              primary_weapon_damage: pickNum(t, 'primary_weapon_damage', 'primaryWeaponDamage'),
              primary_weapon_recoil_damage: pickNum(t, 'primary_weapon_recoil_damage', 'primaryWeaponRecoilDamage'),
              // NOTE: the chain field is shot_success_RATE_numerator (snake from
              // proto primaryWeaponShotSuccessRateNumerator). The earlier snake key
              // omitted "rate" so these synced as null → simulate computed 0 damage.
              primary_weapon_shot_success_numerator: pickNum(t, 'primary_weapon_shot_success_rate_numerator', 'primaryWeaponShotSuccessRateNumerator'),
              primary_weapon_shot_success_denominator: pickNum(t, 'primary_weapon_shot_success_rate_denominator', 'primaryWeaponShotSuccessRateDenominator'),
              // No guaranteed-shots field exists in this proto version; success rate governs all shots.
              primary_weapon_guaranteed_shots: pickNum(t, 'primary_weapon_guaranteed_shots', 'primaryWeaponGuaranteedShots'),
              primary_weapon_blockable: pickBool(t, 'primary_weapon_blockable', 'primaryWeaponBlockable'),
              primary_weapon_counterable: pickBool(t, 'primary_weapon_counterable', 'primaryWeaponCounterable'),
              // Struct-level counter immunity (Mobile Artillery's
              // indirectCombatModule). Overrides the per-weapon flags.
              attack_counterable: pickBool(t, 'attack_counterable', 'attackCounterable'),
              secondary_weapon: pickStr(t, 'secondary_weapon', 'secondaryWeapon'),
              secondary_weapon_control: pickStr(t, 'secondary_weapon_control', 'secondaryWeaponControl'),
              secondary_weapon_shots: pickNum(t, 'secondary_weapon_shots', 'secondaryWeaponShots'),
              secondary_weapon_damage: pickNum(t, 'secondary_weapon_damage', 'secondaryWeaponDamage'),
              secondary_weapon_recoil_damage: pickNum(t, 'secondary_weapon_recoil_damage', 'secondaryWeaponRecoilDamage'),
              secondary_weapon_shot_success_numerator: pickNum(t, 'secondary_weapon_shot_success_rate_numerator', 'secondaryWeaponShotSuccessRateNumerator'),
              secondary_weapon_shot_success_denominator: pickNum(t, 'secondary_weapon_shot_success_rate_denominator', 'secondaryWeaponShotSuccessRateDenominator'),
              secondary_weapon_guaranteed_shots: pickNum(t, 'secondary_weapon_guaranteed_shots', 'secondaryWeaponGuaranteedShots'),
              secondary_weapon_blockable: pickBool(t, 'secondary_weapon_blockable', 'secondaryWeaponBlockable'),
              secondary_weapon_counterable: pickBool(t, 'secondary_weapon_counterable', 'secondaryWeaponCounterable'),
              counter_attack: pickNum(t, 'counter_attack', 'counterAttack'),
              counter_attack_same_ambit: pickNum(t, 'counter_attack_same_ambit', 'counterAttackSameAmbit'),
              attack_reduction: pickNum(t, 'attack_reduction', 'attackReduction'),
              post_destruction_damage: pickNum(t, 'post_destruction_damage', 'postDestructionDamage'),
              has_stealth_system: pickBool(t, 'has_stealth_system', 'hasStealthSystem'),
              // Defensive/evasion model. The chain keys evasion on the INCOMING
              // weapon's control: signalJamming is guided 2/3, unguided 0/0.
              unit_defenses: pickStr(t, 'unit_defenses', 'unitDefenses'),
              guided_defensive_success_rate_numerator: pickNum(t, 'guided_defensive_success_rate_numerator', 'guidedDefensiveSuccessRateNumerator'),
              guided_defensive_success_rate_denominator: pickNum(t, 'guided_defensive_success_rate_denominator', 'guidedDefensiveSuccessRateDenominator'),
              unguided_defensive_success_rate_numerator: pickNum(t, 'unguided_defensive_success_rate_numerator', 'unguidedDefensiveSuccessRateNumerator'),
              unguided_defensive_success_rate_denominator: pickNum(t, 'unguided_defensive_success_rate_denominator', 'unguidedDefensiveSuccessRateDenominator'),
              primary_weapon_armour_piercing: pickBool(t, 'primary_weapon_armour_piercing', 'primaryWeaponArmourPiercing'),
              secondary_weapon_armour_piercing: pickBool(t, 'secondary_weapon_armour_piercing', 'secondaryWeaponArmourPiercing'),
              planetary_defenses: pickStr(t, 'planetary_defenses', 'planetaryDefenses'),
              planetary_shield_contribution: pickNum(t, 'planetary_shield_contribution', 'planetaryShieldContribution'),
              trigger_raid_defeat_by_destruction: pickBool(t, 'trigger_raid_defeat_by_destruction', 'triggerRaidDefeatByDestruction'),
              movable: pickBool(t, 'movable', 'movable'),

              // ── Cheatsheet copy ──────────────────────────────────────────
              // Human-written labels and descriptions for every ability. These
              // exist ONLY on the Guild API's /struct/type record, which needs
              // a logged-in session — the raw LCD entity has none of them. This
              // window is the only place in the app that holds that session, so
              // if they do not cross here they cannot be shown anywhere else.
              // The raid viewer's Cheatsheets are built from exactly these.
              class_name: pickStr(t, 'class', 'class'),
              class_abbreviation: pickStr(t, 'class_abbreviation', 'classAbbreviation'),
              default_cosmetic_model_number: pickStr(t, 'default_cosmetic_model_number', 'defaultCosmeticModelNumber'),
              default_cosmetic_name: pickStr(t, 'default_cosmetic_name', 'defaultCosmeticName'),
              build_draw: pickNum(t, 'build_draw', 'buildDraw'),
              generating_rate: pickNum(t, 'generating_rate', 'generatingRate'),
              primary_weapon_label: pickStr(t, 'primary_weapon_label', 'primaryWeaponLabel'),
              primary_weapon_description: pickStr(t, 'primary_weapon_description', 'primaryWeaponDescription'),
              secondary_weapon_label: pickStr(t, 'secondary_weapon_label', 'secondaryWeaponLabel'),
              secondary_weapon_description: pickStr(t, 'secondary_weapon_description', 'secondaryWeaponDescription'),
              passive_weaponry: pickStr(t, 'passive_weaponry', 'passiveWeaponry'),
              passive_weaponry_label: pickStr(t, 'passive_weaponry_label', 'passiveWeaponryLabel'),
              passive_weaponry_description: pickStr(t, 'passive_weaponry_description', 'passiveWeaponryDescription'),
              unit_defenses_label: pickStr(t, 'unit_defenses_label', 'unitDefensesLabel'),
              unit_defenses_description: pickStr(t, 'unit_defenses_description', 'unitDefensesDescription'),
              ore_reserve_defenses: pickStr(t, 'ore_reserve_defenses', 'oreReserveDefenses'),
              ore_reserve_defenses_label: pickStr(t, 'ore_reserve_defenses_label', 'oreReserveDefensesLabel'),
              ore_reserve_defenses_description: pickStr(t, 'ore_reserve_defenses_description', 'oreReserveDefensesDescription'),
              planetary_defenses_label: pickStr(t, 'planetary_defenses_label', 'planetaryDefensesLabel'),
              planetary_defenses_description: pickStr(t, 'planetary_defenses_description', 'planetaryDefensesDescription'),
              planetary_mining: pickStr(t, 'planetary_mining', 'planetaryMining'),
              planetary_refinery: pickStr(t, 'planetary_refinery', 'planetaryRefinery'),
              power_generation: pickStr(t, 'power_generation', 'powerGeneration'),
              drive_label: pickStr(t, 'drive_label', 'driveLabel'),
              drive_description: pickStr(t, 'drive_description', 'driveDescription')
            };
          }
        }

        // Ensure numeric values are actually numbers (some gameState fields may be strings)
        function num(v) { return v != null ? Number(v) : null; }
        function numOrZero(v) { return v != null ? Number(v) : 0; }
        // Read a field that may be snake_case or camelCase, coerced to number or null.
        function pickNum(obj, snake, camel) {
          var v = obj[snake] != null ? obj[snake] : obj[camel];
          return v != null ? Number(v) : null;
        }
        // String variant.
        function pickStr(obj, snake, camel) {
          var v = obj[snake] != null ? obj[snake] : obj[camel];
          return v != null ? String(v) : null;
        }
        // Boolean variant (accepts true/false, "true"/"false", 1/0).
        function pickBool(obj, snake, camel) {
          var v = obj[snake] != null ? obj[snake] : obj[camel];
          if (v == null) return null;
          if (typeof v === 'boolean') return v;
          if (typeof v === 'number') return v !== 0;
          return String(v).toLowerCase() === 'true';
        }

        var syncData = {
          current_block_height: numOrZero(gs.currentBlockHeight),
          player_id: kp ? kp.id : null,
          planet_id: kp && kp.planet ? kp.planet.id : null,
          fleet_id: kp && kp.player ? kp.player.fleet_id : null,
          wallet_address: gs.signingAccount ? gs.signingAccount.address : null,
          player_name: kp && kp.player ? (kp.player.username || kp.player.name) : null,
          guild_id: kp && kp.player ? kp.player.guild_id : null,
          alpha: kp && kp.player ? num(kp.player.alpha) : null,
          ore: kp && kp.player ? num(kp.player.ore) : null,
          stored_ore: kp && kp.player ? num(kp.player.stored_ore || kp.player.storedOre) : null,
          load: kp && kp.player ? num(kp.player.load) : null,
          structs_load: kp && kp.player ? num(kp.player.structs_load || kp.player.structsLoad) : null,
          capacity: kp && kp.player ? num(kp.player.capacity) : null,
          capacity_secondary: kp && kp.player ? num(kp.player.connection_capacity || kp.player.connectionCapacity || kp.player.capacitySecondary) : null,
          last_action_block_height: kp ? numOrZero(kp.lastActionBlockHeight) : null,
          fleet_status: null, // TODO: expose from KeyPlayer when available
          planet_ore: kp && kp.planet ? num(kp.planet.undiscovered_ore || kp.planet.remainingOre) : null,
          structs: structs,
          struct_types: structTypes
        };

        window.__TAURI__.core.invoke('sync_game_state', { state: syncData })
          .catch(function(e) {
            console.warn('[Structs Sync] Failed:', e);
          });
      } catch (e) {
        // Silent fail — don't break the app for sync errors
      }
    }

    // Dynamic sync interval — Rust controls the interval (combat mode = 3s, normal = 10s).
    //
    // Two sync triggers run in parallel:
    //   1. Rust emits a `structs://sync-tick` event at SYNC_INTERVAL_MS cadence
    //      (see src-tauri/src/main.rs setup hook). This is immune to WKWebView
    //      throttling because the scheduler lives in tokio.
    //   2. JS setTimeout fallback at the same cadence, in case the Tauri
    //      event channel hiccups.
    //
    // Both paths funnel through `triggerSync()` which debounces back-to-back
    // calls to < 1s apart, so the double-fire is harmless.
    var _currentSyncInterval = 10000;
    var _lastSyncAt = 0;
    function triggerSync() {
      var now = Date.now();
      if (now - _lastSyncAt < 1000) return;  // debounce
      _lastSyncAt = now;
      syncGameState();
    }
    // Listen for Rust-driven ticks (the reliable path under backgrounding).
    window.addEventListener('structs:sync-tick', triggerSync);

    function scheduleSyncLoop() {
      setTimeout(function() {
        triggerSync();
        // Check if interval changed (combat mode)
        if (window.__TAURI__) {
          window.__TAURI__.core.invoke('get_sync_interval').then(function(ms) {
            if (ms !== _currentSyncInterval) {
              console.info('[Structs Sync] Interval changed:', _currentSyncInterval, '→', ms, 'ms');
              _currentSyncInterval = ms;
            }
          }).catch(function() {});
        }
        scheduleSyncLoop();
      }, _currentSyncInterval);
    }
    // Initial sync quickly, then dynamic loop
    setTimeout(function() {
      syncGameState();
      _lastSyncAt = Date.now();
      // Rapid syncs for the first 10 seconds to get data to Rust ASAP
      setTimeout(syncGameState, 2000);
      setTimeout(syncGameState, 4000);
      scheduleSyncLoop();
    }, 1000);

    console.info('[Structs Sync] GameState sync to Rust enabled (Rust tick + JS fallback)');
  })();

  // ── MCP Transaction Bridge ──
  // Listens for transaction requests from the Rust MCP server and
  // routes them through the webapp's SigningClientManager queue.
  (function setupTransactionBridge() {
    window.__TAURI__.event.listen('mcp_transaction_request', function(event) {
      var req = event.payload;
      var requestId = req.request_id;
      var action = req.action;
      var args = req.args || {};

      console.info('[Structs TX Bridge] Received:', action, requestId);

      // Get the signing client manager from the webapp
      var scm = window.signingClientManager;
      if (!scm) {
        respondTx(requestId, false, null, 'SigningClientManager not available');
        return;
      }

      try {
        var promise;
        switch (action) {
          // ── Planet ──
          case 'planet_explore':
            promise = scm.queueMsgPlanetExplore(args.player_id || (window.gameState && window.gameState.keyPlayers && window.gameState.keyPlayers.player ? window.gameState.keyPlayers.player.id : ''));
            break;

          // ── Struct Build ──
          case 'struct_build_initiate':
            promise = scm.queueMsgStructBuildInitiate(
              args.player_id, args.struct_type_id, args.operating_ambit, args.slot || 0, args.charge_cost
            );
            break;
          case 'struct_build_cancel':
            promise = scm.queueMsgStructBuildCancel(args.struct_id);
            break;

          // ── Mining & Refining (Complete = submit proof, no separate initiation tx) ──
          case 'struct_ore_miner_complete':
            promise = scm.queueMsgStructOreMinerComplete(args.struct_id, args.proof, args.nonce);
            break;
          case 'struct_ore_refinery_complete':
            promise = scm.queueMsgStructOreRefineryComplete(args.struct_id, args.proof, args.nonce);
            break;

          // ── Struct Actions ──
          case 'struct_activate':
            promise = scm.queueMsgStructActivate(args.struct_id, args.charge_cost);
            break;
          case 'struct_deactivate':
            promise = scm.queueMsgStructDeactivate(args.struct_id, args.charge_cost);
            break;
          case 'struct_attack':
            // targetStructId must be an array; weaponSystem must be 'primaryWeapon' or 'secondaryWeapon'
            var targets = Array.isArray(args.target_struct_id) ? args.target_struct_id : [args.target_struct_id];
            var weapon = args.weapon_system || 'primaryWeapon';
            if (weapon === 'primary') weapon = 'primaryWeapon';
            if (weapon === 'secondary') weapon = 'secondaryWeapon';
            promise = scm.queueMsgStructAttack(args.operating_struct_id, targets, weapon, args.charge_cost);
            break;
          case 'struct_defense_set':
            promise = scm.queueMsgStructDefenseSet(args.defender_struct_id, args.protected_struct_id, args.charge_cost);
            break;
          case 'struct_defense_clear':
            promise = scm.queueMsgStructDefenseClear(args.defender_struct_id, args.charge_cost);
            break;
          case 'struct_move':
            promise = scm.queueMsgStructMove(args.struct_id, args.location_type || 'planet', args.ambit || 'space', args.slot || 0, args.charge_cost);
            break;

          // ── Fleet ──
          case 'fleet_move':
            promise = scm.queueMsgFleetMove(args.fleet_id, args.destination_id);
            break;

          // ── Transfer ── (alpha send via MsgPlayerSend; queueMsgBankSend never
          //    existed — amount is a Coin[] in ualpha, matching AlphaManager.)
          case 'bank_send': {
            // Last stop before the signing queue. The chain does NOT validate
            // MsgPlayerSend's toAddress (a malformed one silently burns the
            // funds at the empty address), so a bad send must die HERE. This
            // also catches undefined args from any caller using the wrong key
            // spelling — String(undefined) is 'undefined', not an address.
            var bsFrom = String(args.from_address || '');
            var bsTo = String(args.to_address || '');
            // "1000000" or "1000000ualpha" or "500uguild.1" — the old
            // digits-only strip turned "500uguild.1" into 5001 ualpha.
            var bsParsed = /^([0-9]+)\s*([a-z][a-z0-9./_-]*)?$/.exec(String(args.amount || '').trim());
            var bsAmt = bsParsed ? bsParsed[1] : '';
            var bsDenom = (bsParsed && bsParsed[2]) || 'ualpha';
            var bsBad = null;
            if (!/^structs1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,80}$/.test(bsFrom)) bsBad = 'from_address "' + bsFrom + '" is not a structs1 address';
            else if (!/^structs1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,80}$/.test(bsTo)) bsBad = 'to_address "' + bsTo + '" is not a structs1 address';
            else if (bsFrom === bsTo) bsBad = 'from and to are the same address';
            else if (!bsAmt || !/[1-9]/.test(bsAmt)) bsBad = 'amount "' + String(args.amount) + '" is not a positive integer amount (with optional denom suffix)';
            if (bsBad) {
              respondTx(requestId, false, null, 'bank_send refused: ' + bsBad);
              return;
            }
            promise = scm.queueMsgPlayerSend(
              bsFrom,
              bsTo,
              [{ denom: bsDenom, amount: bsAmt }]
            );
            break;
          }

          // ── Generator ──
          case 'struct_generator_infuse':
            promise = scm.queueMsgStructGeneratorInfuse(args.struct_id, args.amount);
            break;

          // ── Allocation ──
          case 'allocation_create': {
            // `allocationType` is a protobuf INT32 ENUM, not a string. Passing
            // "dynamic" through made the encoder do Number("dynamic") → NaN and
            // the tx died with "invalid int32: NaN" — after the bridge had
            // already acked "queued", so the UI showed nothing and the ledger
            // recorded a success that never reached the chain.
            var ALLOC_TYPE = { static: 0, dynamic: 1, automated: 2, providerAgreement: 3 };
            var allocType = typeof args.allocation_type === 'number'
              ? args.allocation_type
              : ALLOC_TYPE[String(args.allocation_type)];
            if (allocType === undefined) {
              respondTx(requestId, false, null,
                'Unknown allocation type: ' + args.allocation_type);
              return;
            }
            promise = scm.queueMsgAllocationCreate(
              args.controller, args.source_object_id, allocType, args.power);
            break;
          }
          case 'allocation_update':
            promise = scm.queueMsgAllocationUpdate(args.allocation_id, args.power);
            break;
          case 'allocation_delete':
            promise = scm.queueMsgAllocationDelete(args.allocation_id);
            break;
          case 'substation_allocation_connect':
            promise = scm.queueMsgSubstationAllocationConnect(args.allocation_id, args.destination_id);
            break;
          case 'substation_allocation_disconnect':
            promise = scm.queueMsgSubstationAllocationDisconnect(args.allocation_id);
            break;

          // ── Substation ──
          case 'substation_player_connect':
            promise = scm.queueMsgSubstationPlayerConnect(args.substation_id, args.player_id);
            break;

          default:
            respondTx(requestId, false, null, 'Unknown action: ' + action);
            return;
        }

        // Respond to the MCP IMMEDIATELY. The new signing queue resolves the
        // queueMsg* promise only on SETTLEMENT (terminal state) — which for a
        // charge-gated message can be minutes away while it waits for charge.
        // Blocking the bridge on that would trip the MCP's 30s timeout, so we
        // ack "queued" now and deliver the real receipt asynchronously below.
        respondTx(requestId, true, 'queued', null);

        // An MCP action just went out: arm the staleness watchdog so that if no
        // grass frame follows shortly, we force a grass resume-check/reconnect.
        if (window.__STRUCTS_REACTIVITY__) {
          window.__STRUCTS_REACTIVITY__.onTxSubmitted();
        }

        // When the tx settles, push the real result into the event buffer as a
        // `tx_settled` event so the agent reads receipts via structs_events.
        function reportSettled(tx) {
          if (window.__STRUCTS_REACTIVITY__) {
            window.__STRUCTS_REACTIVITY__.onTxSettled();
          }
          var resp = (tx && tx.response) || {};
          window.__TAURI__.core.invoke('push_game_event', { event: {
            category: 'tx_settled',
            subject: action + (args.struct_id ? (' ' + args.struct_id) : (args.operating_struct_id ? (' ' + args.operating_struct_id) : '')),
            detail: {
              action: action,
              status: (tx && tx.status) || 'unknown',
              code: (resp.code !== undefined ? resp.code : null),
              transactionHash: resp.transactionHash || null,
              height: resp.height || null,
              error: (tx && tx.error) || null,
              rawLog: resp.rawLog || null
            },
            timestamp: Date.now()
          }}).catch(function() {});
        }
        promise.then(function(tx) {
          console.info('[Structs TX Bridge] Settled:', action, tx && tx.status);
          reportSettled(tx);
        }).catch(function(err) {
          console.error('[Structs TX Bridge] Settle error:', action, err);
          reportSettled({ status: 'dropped', error: String(err), response: {} });
        });

      } catch (e) {
        console.error('[Structs TX Bridge] Error:', e);
        respondTx(requestId, false, null, String(e));
      }
    });

    function respondTx(requestId, success, txHash, error) {
      window.__TAURI__.core.invoke('mcp_transaction_response', {
        response: {
          request_id: requestId,
          success: success,
          tx_hash: txHash || null,
          error: error || null
        }
      }).catch(function(e) {
        console.error('[Structs TX Bridge] Failed to send response:', e);
      });
    }

    console.info('[Structs TX Bridge] Transaction bridge installed');
  })();

  // ── Force-resync bridge ──
  // The MCP's structs_action {action:"resync"} emits 'structs:force-resync'.
  // Soft: re-run the sync + grass-resume path (re-fetches state, re-subscribes).
  // Hard: full page reload — the nuclear option for a badly stale map.
  // ── Comms unread ──
  // How many messages are waiting behind the Comms door. The count is the
  // homeserver's own, so it is still true when that window has been closed for
  // a day — which is exactly when this badge is the only thing that would say
  // so. Kept here, outside the Debug panel, because the panel is rebuilt from
  // scratch every time it opens and would otherwise show nothing until the
  // next message arrived.
  var COMMS_UNREAD = { count: 0, mention: false };

  function paintCommsUnread() {
    var el = document.getElementById('debug-comms-unread');
    if (!el) return;                       // panel not open; state is still kept
    if (!COMMS_UNREAD.count) { el.style.display = 'none'; return; }
    el.style.display = '';
    // Warning, not default, when someone actually named you: a count of 40
    // hides the one message that was for you.
    el.className = 'sui-badge ' +
      (COMMS_UNREAD.mention ? 'sui-mod-warning' : 'sui-mod-default');
    el.textContent = COMMS_UNREAD.count > 99 ? '99+' : String(COMMS_UNREAD.count);
  }

  (function setupCommsUnread() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen('matrix::unread', function (event) {
      var p = (event && event.payload) || {};
      COMMS_UNREAD = { count: Number(p.count) || 0, mention: !!p.mention };
      paintCommsUnread();
    });
  })();

  (function setupForceResync() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen('structs:force-resync', function(event) {
      var hard = event && event.payload && event.payload.hard;
      console.info('[Structs] force-resync (' + (hard ? 'hard' : 'soft') + ')');
      if (hard) {
        try { window.location.reload(); } catch (e) {}
        return;
      }
      window.dispatchEvent(new CustomEvent('structs:grass-resume-check'));
      window.dispatchEvent(new CustomEvent('structs:sync-tick'));
    });
  })();

  // ── Task-manager overrides bridge ──
  // The MCP's structs_hash {command:"config", max_concurrent} emits
  // 'structs:task-overrides'; stash it where the patched TaskManager reads it.
  (function setupTaskOverrides() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__STRUCTS_TASK_OVERRIDES__ = window.__STRUCTS_TASK_OVERRIDES__ || {};
    window.__TAURI__.event.listen('structs:task-overrides', function (event) {
      var p = (event && event.payload) || {};
      Object.keys(p).forEach(function (k) { window.__STRUCTS_TASK_OVERRIDES__[k] = p[k]; });
      console.info('[Structs] task overrides updated:', JSON.stringify(window.__STRUCTS_TASK_OVERRIDES__));
    });

    // Master hashing on/off: pause/resume the webapp TaskManager so it stops (or
    // resumes) spawning workers. These are plain window events the manager already
    // listens for — no webapp patch needed. (The Rust gate stops MCP-started tasks.)
    window.__TAURI__.event.listen('structs:hash-enabled', function (event) {
      var on = !!(event && event.payload && event.payload.enabled === true);
      window.dispatchEvent(new CustomEvent(on ? 'TASK_CMD_MANAGER_RESUME' : 'TASK_CMD_MANAGER_PAUSE'));
      console.info('[Structs] hashing ' + (on ? 'enabled — TaskManager resume' : 'disabled — TaskManager pause'));
    });
  })();

  // ── Virtual-players bridge ──
  // Rust (structs_players / acting "as" a virtual player) emits
  // 'structs:vplayer-request'; dispatch to the webapp's __STRUCTS_VPLAYERS__
  // façade (which holds the keys) and reply via the vplayer_response command.
  (function setupVPlayerBridge() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen('structs:vplayer-request', async function (event) {
      var req = event.payload || {};
      var reqId = req.req_id;
      var op = req.op;
      var args = req.args || {};
      function respond(success, data, error) {
        window.__TAURI__.core.invoke('vplayer_response', {
          response: { req_id: reqId, success: success, data: data || {}, error: error || null }
        }).catch(function (e) { console.warn('[VPlayer] response failed', e); });
      }
      try {
        var vp = window.__STRUCTS_VPLAYERS__;
        if (!vp) { respond(false, {}, 'virtual-players façade unavailable (patch not built / not signed in)'); return; }
        var data;
        switch (op) {
          case 'derive': data = await vp.deriveAccount(args.index); break;
          case 'signup': data = await vp.signup(args.index, args.name, args.guild_id); break;
          case 'sign':   data = await vp.signAndBroadcast(args.index, args.type_url, args.payload); break;
          case 'list':   data = vp.list(); break;
          case 'render_map': data = await vp.renderMapPng(args.planet_id, args.player_id); break;
          case 'render_map_frames': data = await vp.renderMapFrames(args.planet_id, args.player_id, args.count, args.interval_ms); break;
          // Comms (Matrix chat) rides this same transport — it is the bridge
          // for "Rust needs something only the key-holder can do" — but
          // dispatches to its OWN façade, which can only sign the guild login
          // message and never an arbitrary payload.
          case 'login_signature': {
            var comms = window.__STRUCTS_COMMS__;
            if (!comms) { respond(false, {}, 'comms façade unavailable (patch not built / not signed in)'); return; }
            data = await comms.loginSignature(args.guild_id, args.timestamp, args.index);
            break;
          }
          default: respond(false, {}, 'unknown vplayer op: ' + op); return;
        }
        respond(true, data, null);
      } catch (e) {
        respond(false, {}, String((e && e.message) || e));
      }
    });
    console.info('[Structs] virtual-players bridge enabled');
  })();

  // ── Signing-queue bridge (Team Ops TX page) ──
  // Same round-trip shape as the vplayer bridge: Rust emits structs:txq-request,
  // we dispatch to the injected __STRUCTS_TXQ__ façade (snapshot/mutate over the
  // primary's SigningQueueManager) and reply via txq_response.
  (function setupTxqBridge() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen('structs:txq-request', function (event) {
      var req = event.payload || {};
      var reqId = req.req_id;
      var op = req.op;
      var args = req.args || {};
      function respond(success, data, error) {
        window.__TAURI__.core.invoke('txq_response', {
          response: { req_id: reqId, success: success, data: data || {}, error: error || null }
        }).catch(function (e) { console.warn('[TXQ] response failed', e); });
      }
      try {
        var txq = window.__STRUCTS_TXQ__;
        if (!txq) { respond(false, {}, 'tx-queue façade unavailable (not signed in / patch not built)'); return; }
        var data;
        switch (op) {
          case 'snapshot': data = txq.snapshot(); break;
          case 'mutate': data = txq.mutate(args.op, args.id, args.new_index); break;
          default: respond(false, {}, 'unknown txq op: ' + op); return;
        }
        respond(true, data, null);
      } catch (e) {
        respond(false, {}, String((e && e.message) || e));
      }
    });
    console.info('[Structs] signing-queue bridge enabled');
  })();

  // ── UI Reactivity Driver ──
  // The webapp's HUD + own-planet map already live-update via grass listeners,
  // but OPEN MENU CONTENT pages are static snapshots (rendered once on navigation).
  // This driver re-renders the open menu when relevant state changes — debounced,
  // and suppressed while the human is mid-interaction so it never yanks the view.
  // It also force-reconnects grass if an MCP action lands but no grass frame
  // follows (a sign the NATS stream went stale). Drives window.__STRUCTS_REACTOR__
  // (exposed by an apply-patches.sh patch on the webapp); no-ops if absent.
  (function setupReactivityDriver() {
    // Grass categories that change visible state worth re-rendering the menu for.
    var RELEVANT = {
      struct_health: 1, struct_status: 1, struct_attack: 1, struct_move: 1,
      struct_defense_add: 1, struct_defense_remove: 1,
      struct_block_build_start: 1, struct_block_ore_mine_start: 1, struct_block_ore_refine_start: 1,
      raid_status: 1, fleet_arrive: 1, fleet_depart: 1,
      shield_change: 1, ore: 1, alpha: 1, structsLoad: 1, capacity: 1,
      player_consensus: 1
    };
    var DEBOUNCE_MS = 750;
    var timer = null;
    var dirty = false;

    // Don't refresh out from under an active interaction.
    function interacting() {
      try {
        var ae = document.activeElement;
        if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
        if (ae && ae.isContentEditable) return true;
        // `#sui-offcanvas` — an ID, which is how SUI styles and how the game
        // creates it. This was `.sui-offcanvas`, a class nothing in the game
        // carries, so the guard never saw the real drawer: the hotkey fired
        // while the player was reading it. It matched only our own agent-UI
        // surface, which had borrowed the class decoratively.
        var oc = document.getElementById('sui-offcanvas');
        if (oc && oc.offsetParent !== null) return true;
        var dlg = document.getElementById('menu-page-dialogue');
        if (dlg && !dlg.classList.contains('hidden')) return true;
      } catch (e) {}
      return false;
    }

    function doRefresh() {
      timer = null;
      var reactor = window.__STRUCTS_REACTOR__;
      if (!reactor) { dirty = false; return; }
      if (interacting()) {
        // Defer until the user is done, then try again.
        dirty = true;
        setTimeout(function () { if (dirty) doRefresh(); }, 1500);
        return;
      }
      dirty = false;
      try { reactor.refreshMenu(); } catch (e) {}
    }

    // Throttle: at most one refresh per DEBOUNCE_MS window, even under event bursts.
    function schedule() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(doRefresh, DEBOUNCE_MS);
    }

    // Staleness watchdog: after an MCP action, if grass stays silent, reconnect.
    function armWatchdog() {
      function grassAt() {
        return (window.__STRUCTS_CONN__ && window.__STRUCTS_CONN__.grass
          && window.__STRUCTS_CONN__.grass.lastMessageAt) || 0;
      }
      var before = grassAt();
      setTimeout(function () {
        if (grassAt() <= before) {
          console.info('[Structs Reactivity] MCP action with no grass frame — firing resume-check');
          window.dispatchEvent(new CustomEvent('structs:grass-resume-check'));
        }
      }, 5000);
    }

    window.__STRUCTS_REACTIVITY__ = {
      onGrassFrame: function (category) { if (RELEVANT[category]) schedule(); },
      onTxSettled: function () { schedule(); },
      onTxSubmitted: function () { armWatchdog(); }
    };
    console.info('[Structs Reactivity] driver enabled');
  })();

  // ── Connection Health Monitor ──
  // Detects and remedies genuinely-dropped long-running connections that the
  // Phase-1 throttle fix does NOT cover:
  //   • grass/NATS WebSocket — NATS gives up after its reconnect budget and
  //     GrassManager throws from an unhandled async generator (its `nc` handle
  //     is never exposed, so nothing can re-subscribe).
  //   • CosmJS SigningStargateClient WS (SigningClientManager, ws://…:26657) —
  //     can die silently; queued messages are spliced out and lost on broadcast.
  // Remedy ladder ends in a full webview reload, but ONLY when the window is
  // hidden/minimized or the user is idle, behind a cooldown + reload-loop cap.
  (function setupConnectionMonitor() {
    try {
      var GRASS_DEGRADED_MS = 30000;
      var GRASS_DEAD_MS = 90000;
      var WATCHDOG_MS = 10000;          // JS fallback; Rust tick is primary
      var IDLE_MS = 60000;
      var RELOAD_COOLDOWN_MS = 300000;  // 5 min between auto-reloads
      var MAX_RELOADS_PER_SESSION = 3;
      var SIGNING_STALE_TICKS = 3;      // ticks of stale height before signing is suspect
      var KEEPALIVE_MS = 120000;        // ping /api every 2 min to keep the server session warm

      var conn = window.__STRUCTS_CONN__;

      // Rehydrate reload guard across reloads so a loop can't reset its own cap.
      try {
        conn.reloadCount = parseInt(sessionStorage.getItem('structsReloadCount') || '0', 10) || 0;
        conn.lastReloadAt = parseInt(sessionStorage.getItem('structsLastReloadAt') || '0', 10) || 0;
      } catch (e) {}

      // Track last user input for the idle gate.
      var lastUserInputAt = Date.now();
      function markInput() { lastUserInputAt = Date.now(); }
      window.addEventListener('pointermove', markInput, { passive: true });
      window.addEventListener('pointerdown', markInput, { passive: true });
      window.addEventListener('keydown', markInput, { passive: true });

      // Height-staleness tracking for the signing path.
      var lastHeight = 0;
      var lastHeightAt = Date.now();
      var staleHeightTicks = 0;

      function classifyGrass(now) {
        var g = conn.grass;
        if (!g.lastMessageAt && !g.lastOpenAt) return 'unknown';  // never connected yet
        var silentMs = now - Math.max(g.lastMessageAt, g.lastOpenAt);
        if (g.readyState === 3 /* CLOSED */ && (now - g.lastOpenAt) > 5000) return 'dead';
        if (silentMs > GRASS_DEAD_MS) return 'dead';
        if (silentMs > GRASS_DEGRADED_MS) return 'degraded';
        return 'healthy';
      }

      function readHeight() {
        var gs = window.gameState;
        var h = gs && gs.currentBlockHeight != null ? Number(gs.currentBlockHeight) : 0;
        return isFinite(h) ? h : 0;
      }

      // ── Guild REST session keepalive (prevention) ──
      // The /api/* surface is session-gated. In steady state, game data streams
      // over grass (WS), so when the user is away NO REST traffic touches the
      // session and it times out server-side. The next /api call — e.g. the raid
      // handler fetching the enemy planet/structs — then 401s, the unhandled
      // rejection aborts the raid render, and the enemy never appears.
      // A periodic authenticated ping simulates the activity that normally keeps
      // the session warm, so /api stays authorized through a long idle.
      var lastKeepaliveAt = 0;
      function sessionKeepalive(now) {
        if (now - lastKeepaliveAt < KEEPALIVE_MS) return;
        var kp = window.gameState && window.gameState.keyPlayers && window.gameState.keyPlayers.player;
        var pid = kp && kp.id;
        if (!pid) return;  // not authenticated yet — nothing to keep alive
        lastKeepaliveAt = now;
        // Routes through the Tauri fetch proxy → shared reqwest cookie jar →
        // refreshes the PHP session. Throttle-immune: this runs off the same
        // sync-tick/interval clock the monitor uses, which survives minimize.
        try {
          window.fetch('/api/player/' + pid, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
            .then(function(r) { if (!r.ok) logRust('session keepalive non-OK: ' + r.status); })
            .catch(function() {});
        } catch (e) {}
      }

      function canAutoReload(now) {
        var hidden = document.visibilityState === 'hidden';
        var idle = (now - lastUserInputAt) > IDLE_MS;
        if (!hidden && !idle) return false;  // never reload an active foreground user
        if (now - conn.lastReloadAt < RELOAD_COOLDOWN_MS) return false;
        if (conn.reloadCount >= MAX_RELOADS_PER_SESSION) return false;
        return true;
      }

      function logRust(msg) {
        if (window.__TAURI__) {
          window.__TAURI__.core.invoke('conn_log', { msg: msg }).catch(function() {});
        }
      }

      function doGuardedReload(now, why) {
        conn.lastReloadAt = now;
        conn.reloadCount++;
        try {
          sessionStorage.setItem('structsReloadCount', String(conn.reloadCount));
          sessionStorage.setItem('structsLastReloadAt', String(now));
        } catch (e) {}
        console.warn('[Structs Conn] Auto-reloading webview, reason=' + why);
        logRust('auto-reload: ' + why);
        window.location.reload();
      }

      function tick() {
        try {
          var now = Date.now();

          // Keep the Guild REST session warm so /api stays authorized while idle.
          sessionKeepalive(now);

          // Signing-client presence.
          var sc = window.gameState && window.gameState.signingClient;
          conn.signing.present = !!sc;
          if (sc) conn.signing.lastSeenAt = now;

          // Height-staleness: only meaningful alongside grass silence.
          var h = readHeight();
          if (h > lastHeight) {
            lastHeight = h;
            lastHeightAt = now;
            staleHeightTicks = 0;
          } else {
            staleHeightTicks++;
          }

          var grassState = classifyGrass(now);
          // The webapp's SigningClientManager.connect() calls disconnect() first,
          // which nulls gameState.signingClient for the duration of a legitimate
          // rebuild. Sampling mid-rebuild would look identical to a dead client,
          // so don't call it missing while its own connection check is in flight.
          var scmForCheck = window.signingClientManager;
          var scmRebuilding = !!(scmForCheck && scmForCheck.connectionCheck);
          var signingMissing = (scmForCheck && !sc && !scmRebuilding);

          window.dispatchEvent(new CustomEvent('structs:connection-status', {
            detail: {
              grass: grassState,
              signingPresent: conn.signing.present,
              signingMissing: !!signingMissing,
              silentMs: now - Math.max(conn.grass.lastMessageAt, conn.grass.lastOpenAt),
              staleHeightTicks: staleHeightTicks
            }
          }));

          // ── Remedy ladder ──
          if (grassState === 'degraded') {
            // Soft nudge: reuse the existing resume signal main.rs fires on
            // visibilitychange. Re-stamp open so we wait one more cycle.
            window.dispatchEvent(new CustomEvent('structs:grass-resume-check'));
            conn.grass.lastOpenAt = now;
            return;
          }

          var grassDead = (grassState === 'dead');
          // Signing is only "dead" when its height is also stale (chain quiet
          // alone shouldn't trigger a reload).
          var signingDead = signingMissing && staleHeightTicks >= SIGNING_STALE_TICKS;

          // Guild session is "dead" when the most recent /api result was a 401/403
          // and the keepalive couldn't revive it. Only a re-auth fixes it — the
          // app re-authenticates automatically on load, so a guarded reload (which
          // only fires when hidden/idle) restores the session. Active foreground
          // use keeps the session warm, so this should essentially never fire there.
          var ga = conn.guildAuth;
          var guildAuthDead = ga.failedAt > 0 &&
            ga.failedAt > ga.lastOkAt &&
            (now - ga.failedAt) < 60000;

          if (grassDead || signingDead || guildAuthDead) {
            // (a) future-safe: use an exposed reconnect() if one ever exists.
            var reconnected = false;
            try {
              var gm = window.grassManager;
              if (grassDead && gm && typeof gm.reconnect === 'function') {
                gm.reconnect();
                conn.grass.lastOpenAt = now;
                reconnected = true;
                logRust('grass reconnect() invoked');
              }
            } catch (e) {}

            // (a2) signing: the webapp recovers silently-dead signing sockets
            // natively (SigningClientManager.resumeCheck → liveness probe →
            // rebuild) explicitly WITHOUT a page reload. Give that a turn before
            // we escalate; reloading here would abort the rebuild it starts.
            try {
              var scm = window.signingClientManager;
              if (signingDead && scm && typeof scm.resumeCheck === 'function') {
                scm.resumeCheck(true);
                reconnected = true;
                logRust('signing resumeCheck() invoked');
              }
            } catch (e) {}

            // (b) last resort: guarded reload (re-auths the Guild session on load).
            if (!reconnected && canAutoReload(now)) {
              doGuardedReload(now, grassDead ? 'grass-dead' : (signingDead ? 'signing-dead' : 'guild-auth-dead'));
            }
          }
        } catch (e) {
          // Never let the monitor break the app.
        }
      }

      // Primary clock: the Rust sync-tick (throttle-immune). JS interval is a
      // fallback in case the Tauri event channel hiccups.
      window.addEventListener('structs:sync-tick', tick);
      setInterval(tick, WATCHDOG_MS);

      console.info('[Structs Conn] Connection health monitor enabled');
    } catch (e) {
      console.warn('[Structs Conn] Failed to install:', e);
    }
  })();

  // ── Debug Tab ──
  // Injects a "DEBUG" tab into the menu navigation showing internal app state.
  // Since MenuPage is inside the webpack bundle and not on window, we inject
  // via DOM manipulation after the menu renders.
  (function setupDebugTab() {
    var DEBUG_NAV_ID = 'nav-item-Debug';
    var debugActive = false;

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(function() {
        console.info('[Debug] Copied to clipboard');
      }).catch(function() {});
    }

    /* The live-refresh timers, owned OUTSIDE the render.
     *
     * Both used to be created inside `renderDebugPage`, which the sticky
     * re-assert calls every time the webapp wipes the page. Each was written to
     * clear itself once `#debug-engine` disappeared — but the redraw that
     * created the replacement also put that element straight back, so the old
     * timer never met its exit condition and simply kept running beside the new
     * one. Every re-assert therefore ADDED a poller: a burst of grass events
     * left the tab refreshing several times a second and climbing. Holding the
     * ids here means a redraw replaces its timer instead of racing it. */
    var hashTickId = null;
    var energyTickId = null;

    function renderDebugPage() {
      debugActive = true;
      var gs = window.gameState || {};
      var kp = gs.keyPlayers && gs.keyPlayers.player;
      var config = window.__STRUCTS_CONFIG__ || {};

      // Gather data
      var playerId = kp ? kp.id : 'unknown';
      var playerName = kp && kp.player ? (kp.player.username || kp.player.name || 'unnamed') : 'unknown';
      var walletAddress = gs.signingAccount ? gs.signingAccount.address : 'unknown';
      var guildId = kp && kp.player ? kp.player.guild_id : 'unknown';
      var substationId = kp && kp.player ? kp.player.substation_id : 'unknown';
      var fleetId = kp && kp.player ? kp.player.fleet_id : 'unknown';
      var planetId = kp && kp.planet ? kp.planet.id : 'unknown';
      var blockHeight = gs.currentBlockHeight || 0;

      var guildApi = config.guildApi || 'not configured';
      var reactorApi = config.reactorApi || 'not configured';
      var clientWs = config.clientWs || 'not configured';
      var grassNatsWs = config.grassNatsWs || 'not configured';

      var mcpUrl = 'http://127.0.0.1:8420/mcp';

      /* One row of the panel.
       *
       * `row` ESCAPES; `rowHtml` does not. They were one function that did
       * not escape, which is a bad default when 33 of its 38 callers pass
       * plain text — including the player's own on-chain username and ids
       * read back from the guild API — and the whole thing lands in
       * `innerHTML`. Whether a given call was safe was invisible at the call
       * site, so the five that genuinely build markup now say so by name.
       */
      var rowHtml = function(label, valueHtml, id) {
        var valHtml = id ? '<span id="' + STRUCTS_ESC(id) + '">' + valueHtml + '</span>' : valueHtml;
        return '<div class="sui-data-card-row" style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:2px 0;"><div style="white-space:nowrap; color:var(--text-hint);">' + STRUCTS_ESC(label) + '</div><div style="text-align:right; word-break:break-all; color:var(--text-body);">' + valHtml + '</div></div>';
      };
      var row = function(label, value, id) {
        return rowHtml(label, STRUCTS_ESC(value), id);
      };

      /* The game's own status chip.
       *
       * ON/OFF, ONLINE/PAUSED and the energy status were three hand-rolled
       * `<span style="color:var(--accent-primary)">`s — a colour decision
       * re-made at each site, in the body face at body size, where SUI
       * already has the component: ExtremeHazard, 8px, uppercase, bordered.
       *
       * `.sui-badge` with no mod is flat and unbordered, which is the honest
       * OFF state, so `hint` composes it with `.sui-text-hint` instead of
       * inventing an off-mod SUI does not have.
       */
      /* The panel's copy-to-clipboard affordances.
       *
       * There were four, each a `<span>` with its own hand-drawn dotted
       * underline (one of them applied imperatively, in JS, after the fact) —
       * four opinions about what a link looks like, none of them clickable by
       * keyboard and none with a hover state. `a.sui-text-secondary` is the
       * game's own inline link and already carries all of it.
       */
      /* The one-line note under a door button.
       *
       * Three copies of the same inline blob, each picking 11px — a size on
       * no SUI scale (8 / 12 / 16). `.sui-text-tiny` is the 8px role and
       * `.sui-text-hint` the colour; only the centring is local.
       *
       * The TEXT of these is a separate question: they describe what a
       * control does, which is the shape the player has asked us to stop
       * putting in panels. Flagged, not removed unilaterally.
       */
      var doorNote = function(id, text) {
        return '<div id="' + STRUCTS_ESC(id) + '" class="sui-text-hint sui-text-tiny" ' +
          'style="text-align:center; margin-top:var(--spacing-xs);">' +
          STRUCTS_ESC(text) + '</div>';
      };
      var copyLink = function(id, label) {
        return '<a id="' + STRUCTS_ESC(id) + '" href="javascript:void(0)" ' +
          'class="sui-text-secondary">' + STRUCTS_ESC(label) + '</a>';
      };
      var badge = function(text, mod) {
        var cls = 'sui-badge' +
          (mod === 'hint' ? ' sui-text-hint' : mod ? ' sui-mod-' + mod : '');
        return '<span class="' + cls + '">' + STRUCTS_ESC(text) + '</span>';
      };

      var html = '<div style="padding: 4px; display:flex; flex-direction:column; gap:8px; width:100%;">';

      // Comms — first thing in the panel. Federated chat over the guild's
      // Matrix homeserver (structs-tel). Deliberately parked here rather than
      // in the game's own menu: the feature is real but unannounced, and this
      // panel is where unannounced things live until they are ready to be
      // found on purpose.
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-body" style="padding:var(--spacing-md);">';
      // `a.sui-screen-btn`, the button SUI actually defines. These were
      // `<div class="sui-button">` — a class that does not exist — which is
      // why each carried hand-rolled cursor, padding and centring: it was
      // rendering as a bare div. Same component the engine toggle below uses.
      html += '<a href="javascript:void(0)" id="debug-comms" class="sui-screen-btn sui-mod-secondary">Comms<span id="debug-comms-unread" class="sui-badge sui-mod-default" style="display:none; margin-left:var(--spacing-md);"></span></a>';
      html += doorNote('debug-comms-note', 'federated guild chat \u00b7 opens in its own window');
      html += '</div></div>';

      // Support bundle — because when someone needs it they are already having
      // a bad time and shouldn't have to hunt.
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-body" style="padding:var(--spacing-md);">';
      html += '<a href="javascript:void(0)" id="debug-download-logs" class="sui-screen-btn sui-mod-secondary">Download logs</a>';
      html += doorNote('debug-download-logs-note', '7 days of activity as a zip \u00b7 no wallet keys included');
      html += '</div></div>';

      // Game Stats door — second card, still above the fold, because it is a
      // destination people come here to open, not a diagnostic they scroll to.
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-body" style="padding:var(--spacing-md);">';
      html += '<a href="javascript:void(0)" id="debug-gamestats" class="sui-screen-btn sui-mod-secondary">Game Stats</a>';
      html += doorNote('debug-gamestats-note', 'whole-universe dashboard \u00b7 opens in its own window');
      html += '</div></div>';

      // Identity
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">Identity</div>';
      html += '<div class="sui-data-card-body">';
      html += row('Player', playerName + ' (' + playerId + ')');
      html += rowHtml('Address', copyLink('debug-address', walletAddress.substring(0, 24) + '\u2026 (copy)'));
      html += row('Guild', guildId);
      html += row('Substation', substationId);
      html += row('Fleet', fleetId);
      html += row('Planet', planetId);
      html += row('Block Height', blockHeight);
      html += '</div></div>';

      // Infrastructure
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">Infrastructure</div>';
      html += '<div class="sui-data-card-body">';
      html += row('Guild API', guildApi);
      html += row('Reactor API', reactorApi);
      html += row('Client WS', clientWs);
      html += row('NATS WS', grassNatsWs);
      html += '</div></div>';

      // MCP Server
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">MCP Server</div>';
      html += '<div class="sui-data-card-body">';
      html += row('URL', mcpUrl);
      html += row('Status', 'checking...', 'debug-mcp-status');
      html += rowHtml('Token', copyLink('debug-mcp-token', 'loading\u2026'));
      html += rowHtml('Config', copyLink('debug-mcp-config', 'Copy to clipboard'));
      html += rowHtml('Onboarding', copyLink('debug-onboard-prompt', 'Copy Onboarding Prompt'));
      html += '</div></div>';

      // Engine
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">Hash Engine</div>';
      html += '<div class="sui-data-card-body">';
      html += '<div id="debug-engine">' + row('Status', 'Loading...') + '</div>';
      html += '</div></div>';

      // Energy
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">Energy</div>';
      html += '<div class="sui-data-card-body">';
      html += '<div id="debug-energy">' + row('Status', 'Loading...') + '</div>';
      html += '</div></div>';

      // Policies
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">Policies</div>';
      html += '<div class="sui-data-card-body">';
      html += '<div id="debug-policies">' + row('Status', 'Loading...') + '</div>';
      html += '</div></div>';

      // ── Team Ops door ──
      // Team Ops is otherwise only reachable through the MCP tool surface,
      // which hides it from anyone who has never connected an agent — even
      // though the dashboard is local Tauri state that needs no agent at all.
      // This opens it directly. Deliberately unlabelled: it is a door for
      // people who already know it is here, not a feature to advertise.
      //
      // ── A DELIBERATE EXCEPTION TO SUI. Do not "fix" this. ──
      //
      // The glyph is π, and it is a joke the owner of this app wants kept. It
      // has been swapped for `icon-cmd-post` once already, on the grounds that
      // a serif font from outside the design system had no business in the
      // game's UI. That reasoning is correct and it is overruled: this one door
      // is allowed to be funny.
      //
      // The font stack is pinned because π is U+03C0 and neither bundled face
      // has any Greek glyph — verified against the .ttf cmaps, 95 and 96
      // codepoints, none Greek. Without a named stack the character falls
      // through to whatever generic the platform picks, which differs per OS.
      //
      // `scripts/harness-tests/sui.test.mjs` knows about this exception by
      // name, so the font audit stays strict everywhere else.
      html += '<div style="display:flex; justify-content:flex-end; padding:2px 4px 0 0;">'
        + '<span id="debug-teamops" title="Team Ops" '
        + 'style="font-family: Georgia, \'Times New Roman\', \'DejaVu Serif\', serif;'
        + ' font-size:15px; line-height:1; cursor:pointer; user-select:none;'
        + ' color:var(--text-hint); opacity:.45;'
        + ' padding:var(--spacing-xs) var(--spacing-sm);'
        + ' transition:opacity .15s ease, color .15s ease;">π</span>'
        + '</div>';

      html += '</div>';

      /* Build ONCE, then re-attach the same node.
       *
       * The webapp's grass listeners navigate the menu on their own schedule,
       * and every navigation wipes `#menu-page-body-content`. At this player's
       * event volume that is about once a second, and the answer used to be to
       * render the whole page again — which is what the flicker was: not a
       * repaint, a full teardown and rebuild, throwing away the loaded values
       * and every wired handler and building them from scratch.
       *
       * Re-appending the SAME detached element puts the page back in one move.
       * Nothing is rebuilt, so nothing flashes half-built; the hash figures,
       * the energy readout and the scroll position survive, and the handlers
       * stay bound because their elements never went away. */
      var root = document.createElement('div');
      root.id = DEBUG_ROOT_ID;
      root.innerHTML = html;
      debugRoot = root;
      var contentEl = document.getElementById('menu-page-body-content');
      if (contentEl) {
        contentEl.innerHTML = '';
        contentEl.appendChild(root);
      }

      // Support bundle. Writes a zip to Downloads and reveals it in Finder.
      // Zipping the telemetry DB takes a moment at fleet scale, so the button
      // reports progress and disables itself rather than looking dead.
      setTimeout(function() {
        var dlEl = document.getElementById('debug-download-logs');
        var dlNote = document.getElementById('debug-download-logs-note');
        if (dlEl) {
          dlEl.addEventListener('click', function() {
            if (dlEl.dataset.busy === '1') return;
            dlEl.dataset.busy = '1';
            var restore = dlEl.textContent;
            dlEl.textContent = 'Packaging…';
            if (dlNote) dlNote.textContent = 'collecting database, configs and crash reports';
            var done = function(text, note) {
              dlEl.textContent = text;
              if (dlNote) dlNote.textContent = note;
              setTimeout(function() {
                dlEl.textContent = restore;
                if (dlNote) dlNote.textContent = '7 days of activity as a zip · no wallet keys included';
                dlEl.dataset.busy = '0';
              }, 6000);
            };
            if (!window.__TAURI__) { done('Unavailable', 'desktop app only'); return; }
            window.__TAURI__.core.invoke('export_log_bundle').then(function(res) {
              var name = String((res && res.path) || '').split('/').pop();
              done('Saved to Downloads', name + ' · ' + ((res && res.mb) || 0) + ' MB');
            }).catch(function(e) {
              done('Export failed', String(e));
            });
          });
        }
      }, 0);

      // Copy address on click
      setTimeout(function() {
        var addrEl = document.getElementById('debug-address');
        if (addrEl) {
          addrEl.addEventListener('click', function() {
            copyToClipboard(walletAddress);
            addrEl.textContent = 'Copied!';
            setTimeout(function() { addrEl.textContent = walletAddress.substring(0, 20) + '...'; }, 1000);
          });
        }

        // Comms door. Same direct-invoke shape as the others: no MCP server,
        // no bearer token. Opening the window does NOT sign in — the window
        // asks first — so this button is safe to press out of curiosity.
        // Anything waiting behind that door. Unread is the homeserver's own
        // figure, so it is still true when the Comms window has been closed
        // for a day — which is exactly when this badge is the only thing that
        // would tell you.
        paintCommsUnread();
        // …and ask, in case no sync has pushed since this session started.
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('matrix_unread').then(function (u) {
            COMMS_UNREAD = { count: Number(u && u.count) || 0, mention: !!(u && u.mention) };
            paintCommsUnread();
          }).catch(function () {});
        }
        var commsEl = document.getElementById('debug-comms');
        if (commsEl) {
          commsEl.addEventListener('click', function() {
            window.__TAURI__.core.invoke('open_chat_window').catch(function(e) {
              var note = document.getElementById('debug-comms-note');
              if (note) {
                note.textContent = 'Could not open Comms: ' + e;
                note.style.color = 'var(--text-enemy-primary)';
              }
            });
          });
        }

        // Game Stats door. Same direct-invoke shape as Team Ops below: no MCP
        // server, no bearer token — works for a player who has never run an
        // agent. Failures report in place; there is no other retry affordance.
        var gameStatsEl = document.getElementById('debug-gamestats');
        if (gameStatsEl) {
          gameStatsEl.addEventListener('click', function() {
            window.__TAURI__.core.invoke('open_game_stats_window').catch(function(e) {
              var note = document.getElementById('debug-gamestats-note');
              if (note) {
                note.textContent = 'Could not open Game Stats: ' + e;
                note.style.color = 'var(--text-enemy-primary)';
              }
            });
          });
        }

        // Team Ops door. Opens the dashboard window directly — no MCP server,
        // no bearer token, no connection state consulted — so it works for a
        // player who has never run an agent.
        var teamOpsEl = document.getElementById('debug-teamops');
        if (teamOpsEl) {
          teamOpsEl.addEventListener('mouseenter', function() {
            teamOpsEl.style.opacity = '1';
            teamOpsEl.style.color = 'var(--text-player-primary)';
          });
          teamOpsEl.addEventListener('mouseleave', function() {
            teamOpsEl.style.opacity = '.45';
            teamOpsEl.style.color = 'var(--text-hint)';
          });
          teamOpsEl.addEventListener('click', function() {
            window.__TAURI__.core.invoke('open_board_window').catch(function(e) {
              // Say so in place rather than failing silently — there is no
              // other affordance here to retry from.
              teamOpsEl.title = 'Could not open Team Ops: ' + e;
              teamOpsEl.style.color = 'var(--text-enemy-primary)';
            });
          });
        }

        // Load MCP config
        window.__TAURI__.core.invoke('get_mcp_config').then(function(mcpConfig) {
          var statusEl = document.getElementById('debug-mcp-status');
          if (statusEl) statusEl.textContent = mcpConfig.enabled ? 'Running on port ' + mcpConfig.port : 'Disabled';
          var tokenEl = document.getElementById('debug-mcp-token');
          if (tokenEl && mcpConfig.bearer_token) {
            var t = mcpConfig.bearer_token;
            tokenEl.textContent = t.substring(0, 8) + '\u2026' + t.substring(t.length - 4);
            tokenEl.addEventListener('click', function() {
              copyToClipboard(t);
              tokenEl.textContent = 'Copied!';
              setTimeout(function() { tokenEl.textContent = t.substring(0, 8) + '\u2026' + t.substring(t.length - 4); }, 1000);
            });
          }

          var configEl = document.getElementById('debug-mcp-config');
          if (configEl) {
            var configJson = JSON.stringify({
              mcpServers: {
                'structs-game': {
                  type: 'http',
                  url: 'http://127.0.0.1:' + mcpConfig.port + '/mcp',
                  headers: {
                    Authorization: 'Bearer ' + (mcpConfig.bearer_token || 'TOKEN_NOT_SET')
                  }
                }
              }
            }, null, 2);
            configEl.addEventListener('click', function() {
              copyToClipboard(configJson);
              configEl.textContent = 'Copied!';
              setTimeout(function() { configEl.textContent = 'Copy to clipboard'; }, 1000);
            });
          }

          // Onboarding prompt: connection details + first instructions, in one
          // paste for ANY MCP-capable agent (tool-agnostic by design).
          var onboardEl = document.getElementById('debug-onboard-prompt');
          if (onboardEl) {
            var onboardPrompt =
              'Connect to my Structs game via MCP (streamable HTTP):\n' +
              '  URL: http://127.0.0.1:' + mcpConfig.port + '/mcp\n' +
              '  Header: Authorization: Bearer ' + (mcpConfig.bearer_token || 'TOKEN_NOT_SET') + '\n' +
              '\n' +
              'MCP client config (JSON):\n' +
              JSON.stringify({
                mcpServers: {
                  'structs-game': {
                    type: 'http',
                    url: 'http://127.0.0.1:' + mcpConfig.port + '/mcp',
                    headers: {
                      Authorization: 'Bearer ' + (mcpConfig.bearer_token || 'TOKEN_NOT_SET')
                    }
                  }
                }
              }, null, 2) + '\n' +
              '\n' +
              'Once connected, open the Team Ops dashboard right away by calling ' +
              '`structs_board {open:true}` so I can watch my fleet, power, and work live. ' +
              'Then run the `getting_started` prompt from the structs-game ' +
              'server and guide me through my first session. If I already have an ' +
              'empire, start with `structs_dashboard` and `structs_system {command:"status"}` instead.';
            onboardEl.addEventListener('click', function() {
              copyToClipboard(onboardPrompt);
              onboardEl.textContent = 'Copied!';
              setTimeout(function() { onboardEl.textContent = 'Copy Onboarding Prompt'; }, 1000);
            });
          }
        }).catch(function() {});

        // Load hash engine status (also refreshes on a 2s tick below)
        /* The engine block's fixed shape, built once.
         *
         * This whole card used to be re-rendered with `innerHTML` every two
         * seconds — five rows and a button thrown away and rebuilt to move two
         * numbers. That is the other half of the flicker, it re-bound the
         * toggle handler on every tick, and it made every row's height jump as
         * the value changed. The skeleton is written once; the ticks only set
         * text. */
        function ensureEngineRows(engineEl) {
          if (engineEl.dataset.built === '1') return;
          engineEl.dataset.built = '1';
          var btnHtml = '<a id="debug-engine-toggle" href="javascript:void(0)" ' +
            'class="sui-screen-btn sui-mod-primary" ' +
            'style="margin-left:var(--spacing-md);">Toggle</a>';
          var html = '';
          html += rowHtml('Engine', '', 'debug-engine-name');
          // The JS-side TaskManager listens for TASK_CMD_MANAGER_PAUSE /
          // TASK_CMD_MANAGER_RESUME; we just dispatch them. State is read from
          // window.taskManager (exposed as `global.taskManager` in the
          // webapp's index.js) so the label flips even when pause/resume came
          // from somewhere else.
          html += rowHtml('Task Manager',
            '<span id="debug-engine-mgr"></span>' + btnHtml);
          html += rowHtml('Active Tasks', '', 'debug-engine-active');
          // Both conditional rows exist from the start and take turns being
          // hidden. Swapping which ROWS exist is what made the card change
          // height as work started and stopped.
          html += '<div id="debug-engine-busy">'
            + rowHtml('Hashrate', '', 'debug-engine-hps')
            + rowHtml('Detail', '<span class="sui-text-hint">per-task view: Team Ops \u2192 Work</span>')
            + '</div>';
          html += '<div id="debug-engine-idle">' + row('Queue', 'No active tasks') + '</div>';
          engineEl.innerHTML = html;

          // Bound ONCE, because the button now outlives the tick.
          var toggleBtn = document.getElementById('debug-engine-toggle');
          if (toggleBtn) {
            toggleBtn.addEventListener('click', function() {
              var mgrNow = window.taskManager;
              var onlineNow = (mgrNow && typeof mgrNow.isOnline === 'function') ? mgrNow.isOnline() : true;
              var evtName = onlineNow ? 'TASK_CMD_MANAGER_PAUSE' : 'TASK_CMD_MANAGER_RESUME';
              window.dispatchEvent(new CustomEvent(evtName));
              console.info('[Structs Debug] Dispatched ' + evtName);
              // Optimistic refresh — the state-change event forces one too,
              // but this gives instant feedback if the listener races.
              setTimeout(refreshHashEngine, 50);
            });
          }
        }

        function setText(id, text) {
          var el = document.getElementById(id);
          // Only touch the DOM when the value actually moved: an unchanged
          // write still invalidates layout for that node.
          if (el && el.textContent !== text) el.textContent = text;
        }

        function refreshHashEngine() {
          if (!debugActive) return;
          window.__TAURI__.core.invoke('list_hash_tasks').then(function(data) {
            var engineEl = document.getElementById('debug-engine');
            if (!engineEl) return;
            ensureEngineRows(engineEl);

            var engineLabel;
            if (data.engine === 'gpu' && data.gpu_info) {
              engineLabel = 'GPU \u2014 ' + data.gpu_info.name +
                ' (' + data.gpu_info.backend + ', ' + data.gpu_info.device_type + ')';
            } else if (data.engine === 'gpu') {
              engineLabel = 'GPU';
            } else {
              engineLabel = 'CPU \u2014 ' + (data.cpu_threads || '?') + ' threads of ' +
                (data.cpu_total_cores || '?') + ' cores';
            }
            setText('debug-engine-name', engineLabel);

            var mgr = window.taskManager;
            var isOnline = (mgr && typeof mgr.isOnline === 'function') ? mgr.isOnline() : null;
            var mgrStatusText, mgrStatusMod, btnLabel;
            if (isOnline === true) {
              mgrStatusText = 'ONLINE'; mgrStatusMod = 'solid'; btnLabel = 'Pause';
            } else if (isOnline === false) {
              mgrStatusText = 'PAUSED'; mgrStatusMod = 'hint'; btnLabel = 'Resume';
            } else {
              mgrStatusText = 'Unknown'; mgrStatusMod = 'hint'; btnLabel = 'Toggle';
            }
            var mgrEl = document.getElementById('debug-engine-mgr');
            var mgrHtml = badge(mgrStatusText, mgrStatusMod);
            if (mgrEl && mgrEl.innerHTML !== mgrHtml) mgrEl.innerHTML = mgrHtml;
            var toggle = document.getElementById('debug-engine-toggle');
            if (toggle && toggle.textContent !== btnLabel) toggle.textContent = btnLabel;

            setText('debug-engine-active', String(data.active_tasks || 0));

            // Count only — the per-task list used to render here, and at fleet
            // scale it made this page a scroll marathon just to reach the
            // sections below. The detail lives in Team Ops → Industry → Work.
            var busy = data.tasks && data.tasks.length > 0;
            if (busy) {
              var totalHps = 0;
              for (var i = 0; i < data.tasks.length; i++) {
                totalHps += (data.tasks[i].hashrate || 0) * 1000;
              }
              setText('debug-engine-hps',
                totalHps >= 1e9 ? (totalHps / 1e9).toFixed(2) + ' Gh/s'
                : totalHps >= 1e6 ? (totalHps / 1e6).toFixed(1) + ' Mh/s'
                : totalHps >= 1e3 ? (totalHps / 1e3).toFixed(1) + ' Kh/s'
                : Math.round(totalHps) + ' h/s');
            }
            var busyEl = document.getElementById('debug-engine-busy');
            var idleEl = document.getElementById('debug-engine-idle');
            if (busyEl) busyEl.hidden = !busy;
            if (idleEl) idleEl.hidden = busy;
          }).catch(function(e) {
            var engineEl = document.getElementById('debug-engine');
            if (!engineEl) return;
            // A failed read is not a reason to tear the card down; say so in
            // the row that is already there.
            ensureEngineRows(engineEl);
            setText('debug-engine-name', String(e));
          });
        }
        refreshHashEngine();

        // Force an immediate refresh whenever the TaskManager flips state,
        // so the button label updates without waiting up to 2s for the tick.
        // Stored on window so re-opens of the debug tab can detach the old one.
        if (window.__debugMgrStatusHandler) {
          window.removeEventListener('TASK_MANAGER_STATUS_CHANGED', window.__debugMgrStatusHandler);
        }
        window.__debugMgrStatusHandler = refreshHashEngine;
        window.addEventListener('TASK_MANAGER_STATUS_CHANGED', refreshHashEngine);

        // Live-refresh while the debug tab is active. The `debugActive` flag
        // gates execution so we stop polling when the user navigates away.
        if (hashTickId) clearInterval(hashTickId);
        hashTickId = setInterval(function() {
          if (!debugActive || !document.getElementById('debug-engine')) {
            clearInterval(hashTickId);
            hashTickId = null;
            return;
          }
          refreshHashEngine();
        }, 2000);

        // ── Energy diagnostic ──
        // Shows the player's load/capacity from gameState + recent infusions
        // and allocations fetched from the Guild API. Infusions/allocations
        // are paginated server-side; we pull page 1 (up to 100 entries each)
        // which is plenty for a debug surface.
        function fmtPower(milliwatts) {
          if (milliwatts == null || isNaN(milliwatts)) return '—';
          var abs = Math.abs(milliwatts);
          if (abs >= 1e6) return (milliwatts / 1e6).toFixed(1) + ' KW';
          if (abs >= 1e3) return (milliwatts / 1e3).toFixed(1) + ' W';
          return Math.round(milliwatts) + ' mW';
        }
        function fmtTimestamp(ts) {
          if (!ts) return '—';
          // Postgres "2026-05-07 14:35:21.226052+00" → epoch seconds
          var d = new Date(typeof ts === 'string' ? ts.replace(' ', 'T') : ts);
          if (isNaN(d.getTime())) return String(ts);
          var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
          if (s < 60) return Math.floor(s) + 's ago';
          if (s < 3600) return Math.floor(s / 60) + 'm ago';
          if (s < 86400) return Math.floor(s / 3600) + 'h ago';
          return Math.floor(s / 86400) + 'd ago';
        }
        function listBlock(title, items, formatter, emptyMsg) {
          var out = '<div style="margin-top:var(--spacing-md); padding:var(--spacing-sm) 0 var(--spacing-sm) var(--spacing-lg); border-left:2px solid var(--accent-primary); background:rgba(0,0,0,0.15);">';
          // Escaped like everything else here. Every caller passes a literal
          // today, which is exactly the state `row` was in before somebody
          // passed it a username.
          out += '<div style="color:var(--text-body); font-weight:bold; padding-bottom:4px;">' + STRUCTS_ESC(title) +
                 (items && items.length ? ' (' + items.length + ')' : '') + '</div>';
          if (!items || !items.length) {
            out += row('—', emptyMsg || 'none');
          } else {
            for (var i = 0; i < items.length; i++) {
              out += formatter(items[i]);
            }
          }
          out += '</div>';
          return out;
        }

        function refreshEnergy() {
          var el = document.getElementById('debug-energy');
          if (!el) return;
          var gs = window.gameState || {};
          var kp = gs.keyPlayers && gs.keyPlayers.player;
          var p = kp && kp.player;
          var num = function(x) {
            if (x == null) return null;
            var n = (typeof x === 'string') ? Number(x) : x;
            return isFinite(n) ? n : null;
          };

          // ── Energy stats (sync, from gameState) ──
          var loadP = p ? num(p.load) : null;
          var structLoadP = p ? num(p.structs_load) : null;
          var capacityP = p ? num(p.capacity) : null;
          var connCapP = p ? num(p.connection_capacity) : null;
          var totalLoad = (loadP || 0) + (structLoadP || 0);
          var totalCap = (capacityP || 0) + (connCapP || 0);
          var margin = totalCap > 0 ? Math.round((totalCap - totalLoad) / totalCap * 100) : 0;
          var online = totalLoad <= totalCap || totalCap === 0;

          var html = '';
          // Status + refresh button on one row
          var refreshBtn = '<a id="debug-energy-refresh" href="javascript:void(0)" ' +
            'class="sui-screen-btn sui-mod-primary" ' +
            'style="margin-left:var(--spacing-md);">' +
            'Refresh</a>';
          html += rowHtml('Status',
            badge(online ? 'ONLINE' : 'OFFLINE', online ? 'solid' : 'warning') + refreshBtn);
          html += row('Total Load', fmtPower(totalLoad) + ' / ' + fmtPower(totalCap) +
            (totalCap > 0 ? ' (' + margin + '% margin)' : ''));
          html += row('Structs Load', fmtPower(structLoadP));
          html += row('Allocated Load', fmtPower(loadP));
          html += row('Personal Capacity', fmtPower(capacityP));
          html += row('Substation Capacity', fmtPower(connCapP));
          if (p && p.substation_id) {
            html += row('Substation', String(p.substation_id));
          }

          // Placeholders that get filled in by the async fetches below.
          html += '<div id="debug-energy-infusions">' + listBlock('Infusions', null, null, 'loading…') + '</div>';
          html += '<div id="debug-energy-allocations">' + listBlock('Allocations', null, null, 'loading…') + '</div>';

          el.innerHTML = html;

          // ── Async fetches: infusions + allocations ──
          var pid = p && p.id;
          var addr = gs.signingAccount && gs.signingAccount.address;
          var guildApi = (window.__STRUCTS_CONFIG__ || {}).guildApi;
          if (!guildApi || !pid) return;

          // Infusions (by player)
          fetch(guildApi + '/infusion/list/player/' + pid + '/page/1')
            .then(function(r) { return r.json(); })
            .then(function(j) {
              var iEl = document.getElementById('debug-energy-infusions');
              if (!iEl) return;
              var rows = (j && j.success && Array.isArray(j.data)) ? j.data : [];
              iEl.innerHTML = listBlock('Infusions', rows, function(inf) {
                var amount = inf.amount != null ? fmtPower(num(inf.amount)) : '?';
                var dest = inf.destination_id || '?';
                var when = fmtTimestamp(inf.created_at || inf.timestamp);
                return row(dest, amount + ' · ' + when);
              }, 'no infusions found');
            })
            .catch(function(e) {
              var iEl = document.getElementById('debug-energy-infusions');
              if (iEl) iEl.innerHTML = listBlock('Infusions', null, null, 'error: ' + e.message);
            });

          // Allocations (by creator + controller — both reference the wallet
          // address; merge + dedupe by id since some entries match both).
          if (addr) {
            Promise.all([
              fetch(guildApi + '/allocation/creator/' + addr + '/page/1').then(function(r){ return r.json(); }).catch(function(){ return null; }),
              fetch(guildApi + '/allocation/controller/' + addr + '/page/1').then(function(r){ return r.json(); }).catch(function(){ return null; })
            ]).then(function(parts) {
              var aEl = document.getElementById('debug-energy-allocations');
              if (!aEl) return;
              var byId = {};
              for (var k = 0; k < parts.length; k++) {
                var part = parts[k];
                if (part && part.success && Array.isArray(part.data)) {
                  for (var j = 0; j < part.data.length; j++) {
                    var a = part.data[j];
                    var key = a.id != null ? String(a.id) : JSON.stringify(a);
                    if (!byId[key]) byId[key] = a;
                  }
                }
              }
              var rows = Object.keys(byId).map(function(k){ return byId[k]; });
              aEl.innerHTML = listBlock('Allocations', rows, function(al) {
                var pow = al.power != null ? fmtPower(num(al.power)) : '?';
                var src = al.source_id || '?';
                var dst = al.destination_id || '?';
                var role = (addr && al.creator === addr && al.controller === addr) ? 'own'
                  : (addr && al.creator === addr) ? 'creator'
                  : (addr && al.controller === addr) ? 'controller'
                  : '';
                return row(src + ' → ' + dst, pow + (role ? ' · ' + role : ''));
              }, 'no allocations found');
            });
          } else {
            var aEl = document.getElementById('debug-energy-allocations');
            if (aEl) aEl.innerHTML = listBlock('Allocations', null, null, 'no wallet address');
          }

          // Re-attach the refresh button handler after innerHTML wipe.
          var rBtn = document.getElementById('debug-energy-refresh');
          if (rBtn) {
            rBtn.addEventListener('click', function() {
              rBtn.textContent = 'Refreshing…';
              refreshEnergy();
              setTimeout(function() {
                var b = document.getElementById('debug-energy-refresh');
                if (b) b.textContent = 'Refresh';
              }, 600);
            });
          }
        }
        refreshEnergy();
        // Energy data (especially infusions + allocations via Guild API) doesn't
        // change quickly — refresh every 5 minutes. Use the in-card Refresh
        // button for on-demand updates.
        if (energyTickId) clearInterval(energyTickId);
        energyTickId = setInterval(function() {
          if (!debugActive || !document.getElementById('debug-energy')) {
            clearInterval(energyTickId);
            energyTickId = null;
            return;
          }
          refreshEnergy();
        }, 5 * 60 * 1000);

        // Load policies
        window.__TAURI__.core.invoke('list_policies').then(function(data) {
          var policiesEl = document.getElementById('debug-policies');
          if (!policiesEl) return;
          var html = '';
          for (var name in data) {
            if (data.hasOwnProperty(name)) {
              var p = data[name];
              html += rowHtml(name, badge(p.enabled ? 'ON' : 'OFF', p.enabled ? 'solid' : 'hint'));
            }
          }
          policiesEl.innerHTML = html;
        }).catch(function(e) {
          var policiesEl = document.getElementById('debug-policies');
          if (policiesEl) policiesEl.innerHTML = row('Error', String(e));
        });

      }, 100);
    }

    /* Leaving Debug is only deliberate if the HUMAN leaves.
     *
     * Any click on another nav item (or the close button) means they chose to
     * go elsewhere, so stop re-asserting. Delegated on the document because the
     * webapp recreates the nav items whenever it re-renders, so listeners bound
     * to the elements themselves would not survive.
     */
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      var item = e.target.closest('.sui-screen-nav-item, #menu-page-nav-close');
      if (item && item.id !== DEBUG_NAV_ID) {
        debugActive = false;
        // A catch-up scheduled before this click would otherwise fire after
        // the user has deliberately left, dragging them back to Debug.
        if (reassertTimer) { clearTimeout(reassertTimer); reassertTimer = null; }
      }
    }, true);

    var reasserting = false;
    var lastReassert = 0;
    var reassertTimer = null;
    // Grass events arrive in bursts, and each redraw costs several Tauri
    // invokes. One redraw per second is far faster than a human notices and
    // keeps a storm of events from turning into a storm of renders.
    var REASSERT_MIN_GAP_MS = 1000;
    var DEBUG_ROOT_ID = 'structs-debug-root';
    // The built page, kept so a wipe costs a re-attach, not a rebuild.
    var debugRoot = null;

    /* Put the Debug page back when something else wipes it.
     *
     * The webapp navigates the menu on its OWN schedule: a dozen grass
     * listeners call `MenuPage.router.goto(...)` when an event arrives — a raid
     * status change, a transfer, an alpha infusion — and every navigation
     * rewrites `#menu-page-body-content`, which is the container this page draws
     * into. The Debug tab therefore vanished seconds after being opened and the
     * user landed back on the default page, over and over, with no visible
     * cause. The more of the galaxy you can see, the more often it happens.
     *
     * We cannot change that behaviour (the webapp is a read-only submodule), so
     * treat an explicit visit to Debug as sticky: if the user opened it and has
     * not navigated away themselves, redraw it. `reasserting` guards the
     * re-entry that our own `innerHTML` write would otherwise cause.
     */
    function reassertDebugPage() {
      if (!debugActive || reasserting) return;
      /* Closing the menu counts as leaving. The webapp only toggles `hidden` on
       * the layout, so the Debug markup survives a close; without this the next
       * open — from the HUD, not from a nav click we could see — would snap the
       * user to Debug instead of the page they asked for. */
      var layout = document.getElementById('menu-page-layout');
      if (!layout || layout.classList.contains('hidden')) {
        debugActive = false;
        // Drop the kept node: a later visit should read the chain again, not
        // re-attach figures from the last session.
        debugRoot = null;
        if (reassertTimer) { clearTimeout(reassertTimer); reassertTimer = null; }
        return;
      }
      var content = document.getElementById('menu-page-body-content');
      if (!content) return;
      if (debugRoot && debugRoot.parentNode === content) return; // still ours
      /* Put the SAME node back, without the throttle.
       *
       * Re-attaching is one DOM move and costs nothing, so there is no reason
       * to coalesce it — and coalescing is what made the page visibly absent:
       * the webapp's own panel sat there for up to a second before ours
       * returned. The throttle below still guards the expensive path, a full
       * rebuild, which now only happens when there is no node to put back. */
      if (debugRoot) {
        reasserting = true;
        try {
          content.innerHTML = '';
          content.appendChild(debugRoot);
          markDebugTabActive();
        } finally {
          reasserting = false;
        }
        return;
      }
      /* THROTTLE WITH A TRAILING EDGE — and the trailing edge is the whole
       * point, not a refinement.
       *
       * This used to `return` when a redraw came too soon after the last one.
       * That drops the redraw instead of deferring it, and the only thing that
       * would ever call this function again is another DOM mutation. So a
       * second wipe arriving inside the gap — which is the NORMAL case, because
       * grass events arrive in bursts — left the user on the page the webapp
       * navigated to, and once the burst went quiet nothing was left to put
       * Debug back. Stranded, not flickering: the symptom was "it switched
       * panels and stayed there".
       *
       * Coalescing is still worth doing (a burst must not mean a redraw per
       * event), so a throttled call now schedules ONE catch-up at the end of
       * the gap instead of being discarded. */
      var now = Date.now();
      var since = now - lastReassert;
      if (since < REASSERT_MIN_GAP_MS) {
        if (!reassertTimer) {
          reassertTimer = setTimeout(function () {
            reassertTimer = null;
            reassertDebugPage();
          }, REASSERT_MIN_GAP_MS - since);
        }
        return;
      }
      if (reassertTimer) { clearTimeout(reassertTimer); reassertTimer = null; }
      lastReassert = now;
      reasserting = true;
      try {
        renderDebugPage();
        markDebugTabActive();
      } finally {
        reasserting = false;
      }
    }

    function markDebugTabActive() {
      var tab = document.getElementById(DEBUG_NAV_ID);
      if (!tab) return;
      var nav = document.getElementById('menu-page-nav-items');
      if (nav) {
        nav.querySelectorAll('.sui-screen-nav-item').forEach(function (i) {
          i.classList.remove('sui-mod-active');
        });
      }
      tab.classList.add('sui-mod-active');
    }

    // Watch for the nav to render and inject our tab
    function ensureDebugTab() {
      var navItems = document.getElementById('menu-page-nav-items');
      if (!navItems) return;

      // Check if our tab already exists
      if (document.getElementById(DEBUG_NAV_ID)) return;

      // Check if the nav has the standard tabs (Fleet, Guild, Account)
      var existingItems = navItems.querySelectorAll('.sui-screen-nav-item');
      if (existingItems.length < 3) return;

      // Add Debug tab
      var debugTab = document.createElement('a');
      debugTab.id = DEBUG_NAV_ID;
      debugTab.className = 'sui-screen-nav-item';
      debugTab.href = 'javascript:void(0)';
      debugTab.textContent = 'DEBUG';
      debugTab.addEventListener('click', function() {
        // Remove active from all tabs
        navItems.querySelectorAll('.sui-screen-nav-item').forEach(function(item) {
          item.classList.remove('sui-mod-active');
        });
        // Activate debug tab
        debugTab.classList.add('sui-mod-active');
        renderDebugPage();
      });

      // Insert before the close button's parent
      navItems.appendChild(debugTab);
    }

    /* One check per frame, not one per mutation.
     *
     * This watches `document.body` with `subtree: true`, so it fires for the
     * animating map, the HUD, the grass feed — everything, many times a frame.
     * The work it triggers is cheap now, but running it dozens of times per
     * frame to reach the same answer is not free either. Coalescing to an
     * animation frame keeps the response immediate (a wipe is repaired before
     * the next paint) while doing the work once.
     *
     * Our own writes are skipped outright: re-attaching the page is itself a
     * mutation, and reacting to it is how an observer feeds itself. */
    var observerQueued = false;
    var observer = new MutationObserver(function(muts) {
      if (reasserting || observerQueued) return;
      var ours = true;
      for (var i = 0; i < muts.length && ours; i++) {
        var t = muts[i].target;
        ours = !!(debugRoot && t && debugRoot.contains(t));
      }
      if (ours && muts.length) return;
      observerQueued = true;
      requestAnimationFrame(function() {
        observerQueued = false;
        // Tab first: a webapp navigation rebuilds `menu-page-nav-items`
        // wholesale, so the tab has to be back before the reassert can mark
        // it active.
        ensureDebugTab();
        reassertDebugPage();
      });
    });

    // Start observing
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }

    console.info('[Structs Debug] Debug tab injection enabled');
  })();

  // ── Agent-driven UI directives (co-op play) ─────────────────────────────
  // Receives 'mcp_ui_directive' events from the MCP/policy engine and renders
  // them on the human's screen, reusing the SUI house style. Interactive
  // ('prompt') surfaces send the human's choice back via 'mcp_ui_response',
  // mirroring the transaction bridge. UI is display/elicitation only — it never
  // signs; any chosen action flows back through the agent + tx bridge.
  (function setupAgentUiDirectives() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;

    var TAURI = window.__TAURI__;
    var panels = new Map();      // directive_id -> { root, mode }
    var queue = [];              // pending interactive directives (no focus-hijack)
    var activeId = null;         // currently-open interactive surface

    var esc = STRUCTS_ESC;

    function respond(directiveId, value, cancelled) {
      TAURI.core.invoke('mcp_ui_response', {
        response: { directive_id: directiveId, value: value == null ? null : value, cancelled: !!cancelled }
      }).catch(function (e) { console.warn('[Agent UI] response failed:', e); });
    }

    // One-time CSS: the "⚡ Agent" marker + overlay positioning. Visual styling
    // leans on the global SUI classes; this only adds layout + attribution.
    (function injectCss() {
      if (document.getElementById('agent-ui-style')) return;
      /* The agent's own surfaces, and they render INSIDE the game window —
       * inches from the real UI, which is the worst possible place to invent a
       * palette. This block used to: a sky blue (#9ecbff / rgba(120,180,255))
       * and a periwinkle (#5b8def) that appear nowhere in SUI, plus
       * hand-picked amber, red and green. Every colour is now a token, and the
       * sizes are the 8/12/16 type roles and the 2/4/8/12/16 spacing scale.
       *
       * The only rgba left is the scrim and the shadows — a dim over content
       * and a drop shadow have no token, and the game's own CSS does the same.
       */
      var css =
        '.agent-ui-mark{display:inline-block;font-family:ExtremeHazard,sans-serif;font-size:8px;line-height:16px;text-transform:uppercase;margin-left:var(--spacing-md);padding:1px var(--spacing-sm);background:var(--surface-player-highlight);color:var(--text-player-primary);vertical-align:middle}' +
        '.agent-ui-overlay{position:fixed;inset:0;z-index:99999;display:flex;justify-content:flex-end;background:rgba(0,0,0,.35)}' +
        '.agent-ui-overlay.agent-ui-center{align-items:center;justify-content:center}' +
        '.agent-ui-surface{max-width:420px;width:90%;max-height:90vh;overflow:auto;margin:0;box-shadow:0 0 40px rgba(0,0,0,.5)}' +
        '.agent-ui-row{display:flex;justify-content:space-between;gap:var(--spacing-lg);padding:var(--spacing-sm) 0;border-bottom:1px solid var(--border-subtle)}' +
        '.agent-ui-row .k{color:var(--text-hint)}' +
        '.agent-ui-item{display:block;width:100%;text-align:left;margin:var(--spacing-md) 0}' +
        '.agent-ui-item small{display:block;color:var(--text-hint)}' +
        '.agent-ui-toaststack{position:fixed;right:var(--spacing-xl);bottom:var(--spacing-xl);z-index:100000;display:flex;flex-direction:column;gap:var(--spacing-md);max-width:360px}' +
        '.agent-ui-toast{padding:var(--spacing-lg);background:var(--surface-player-body);color:var(--text-body);border-left:4px solid var(--accent-primary);box-shadow:0 4px 16px rgba(0,0,0,.4);font-size:12px}' +
        '.agent-ui-toast.level-warning{border-left-color:var(--text-warning)}' +
        '.agent-ui-toast.level-error{border-left-color:var(--text-enemy-primary)}' +
        '.agent-ui-badge{margin:var(--spacing-xs);padding:var(--spacing-xs) var(--spacing-md);font-size:12px;background:var(--surface-player-highlight);color:var(--text-player-primary);display:inline-flex;gap:var(--spacing-md);align-items:center}' +
        '.agent-ui-badge.theme-enemy{background:var(--surface-enemy-body);color:var(--text-enemy-primary)}' +
        '.agent-ui-badge.theme-player{background:var(--surface-player-highlight);color:var(--text-player-primary)}';
      var st = document.createElement('style');
      st.id = 'agent-ui-style';
      st.textContent = css;
      document.head.appendChild(st);
    })();

    // ── Toasts (notify) ──
    function toastStack() {
      var s = document.getElementById('agent-ui-toaststack');
      if (!s) { s = document.createElement('div'); s.id = 'agent-ui-toaststack'; document.body.appendChild(s); }
      return s;
    }
    function showToast(c) {
      var el = document.createElement('div');
      el.className = 'agent-ui-toast level-' + (c.level || 'info');
      el.innerHTML = '<strong>' + esc(c.title || 'Agent') + '</strong> <span class="agent-ui-mark">⚡ Agent</span><br>' + esc(c.body || '');
      toastStack().appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
    }

    // ── HUD badges (notify; keyed by id, updatable, removable) ──
    function hudContainer() { return document.getElementById('hud-container') || document.body; }
    function showHudBadge(c) {
      if (!c.id) return;
      var domId = 'agent-badge-' + c.id;
      var el = document.getElementById(domId);
      if (!el) {
        el = document.createElement('span');
        el.id = domId;
        hudContainer().appendChild(el);
      }
      el.className = 'agent-ui-badge' + (c.theme ? ' theme-' + c.theme : '');
      el.innerHTML = '<span class="agent-ui-mark">⚡</span>' + esc(c.label || '') + ': ' + esc(c.value || '');
    }
    function removeHudBadge(id) {
      var el = document.getElementById('agent-badge-' + id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    // ── Interactive / panel surfaces (notify or prompt) ──
    function bodyHtml(c, variant) {
      if (variant === 'raw_html') return c.html || '';
      if (variant === 'info') {
        return (c.rows || []).map(function (r) {
          return '<div class="agent-ui-row"><span class="k">' + esc(r.key) + '</span><span>' + esc(r.value) + '</span></div>';
        }).join('');
      }
      if (variant === 'menu') {
        return (c.items || []).map(function (it, i) {
          return '<button class="sui-panel-btn agent-ui-item" data-idx="' + i + '">' + esc(it.label) +
            (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') + '</button>';
        }).join('');
      }
      // generic panel: render the small element vocabulary
      return (c.body || []).map(function (el) {
        switch (el.type) {
          case 'text': return '<p>' + esc(el.text) + '</p>';
          case 'divider': return '<hr>';
          case 'rows': return (el.rows || []).map(function (r) {
            return '<div class="agent-ui-row"><span class="k">' + esc(r.key) + '</span><span>' + esc(r.value) + '</span></div>';
          }).join('');
          case 'list': return '<ul>' + (el.items || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
          case 'button': return '<button class="sui-panel-btn agent-ui-item" data-value="' + esc(el.value) + '">' + esc(el.label) + '</button>';
          default: return '';
        }
      }).join('');
    }

    function closePanel(directiveId, value, cancelled) {
      var p = panels.get(directiveId);
      if (!p) return;
      if (p.root && p.root.parentNode) p.root.parentNode.removeChild(p.root);
      panels.delete(directiveId);
      if (p.mode === 'prompt') respond(directiveId, value, cancelled);
      if (activeId === directiveId) {
        activeId = null;
        if (queue.length) renderDirective(queue.shift()); // serialize prompts — no focus-hijack
      }
    }

    function showSurface(d, variant) {
      var c = d.component || {};
      var isPrompt = d.mode === 'prompt';
      var centered = (variant === 'dialogue');

      // No focus-hijack: queue interactive surfaces while one is open.
      if (isPrompt && activeId && activeId !== d.directive_id) { queue.push(d); return; }

      var overlay = document.createElement('div');
      overlay.className = 'agent-ui-overlay' + (centered ? ' agent-ui-center' : '');
      var title = esc(c.title || (variant === 'dialogue' ? 'Agent' : 'Agent'));
      var inner = variant === 'dialogue'
        ? '<p>' + esc(c.message || '') + '</p>' +
          '<div class="agent-ui-btns">' + (c.buttons || []).map(function (b, i) {
            return '<button class="sui-panel-btn agent-ui-item" data-idx="' + i + '">' + esc(b.label) + '</button>';
          }).join('') + '</div>'
        : bodyHtml(c, variant);

      overlay.innerHTML =
        // No `sui-offcanvas` / `sui-offcanvas-header`: SUI styles the drawer by
        // ID and defines neither as a class, so both were inert — decoration
        // that read as structure. `.sui-panel` + the theme is what actually
        // draws this surface, and `.sui-screen-nav-item` the header.
        '<div class="sui-panel sui-theme-' + esc(c.theme || 'neutral') + ' agent-ui-surface">' +
          '<div class="sui-screen-nav-item">' + title + ' <span class="agent-ui-mark">⚡ Agent</span>' +
            '<a class="sui-screen-nav-close agent-ui-close" href="javascript:void(0)">✕</a></div>' +
          '<div class="sui-offcanvas-body">' + inner + '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      panels.set(d.directive_id, { root: overlay, mode: d.mode });
      if (isPrompt) activeId = d.directive_id;

      // Close affordances
      overlay.querySelector('.agent-ui-close').addEventListener('click', function () {
        closePanel(d.directive_id, null, true);
      });
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) closePanel(d.directive_id, null, true);
      });

      // Wire interactive elements → resolve with their value
      if (variant === 'menu') {
        overlay.querySelectorAll('.agent-ui-item').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var it = (c.items || [])[parseInt(btn.getAttribute('data-idx'), 10)];
            closePanel(d.directive_id, it ? it.value : null, false);
          });
        });
      } else if (variant === 'dialogue') {
        overlay.querySelectorAll('.agent-ui-item').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var b = (c.buttons || [])[parseInt(btn.getAttribute('data-idx'), 10)];
            closePanel(d.directive_id, b ? b.value : null, false);
          });
        });
      } else {
        overlay.querySelectorAll('.agent-ui-item[data-value]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            closePanel(d.directive_id, btn.getAttribute('data-value'), false);
          });
        });
      }
    }

    // ── Façade-backed kinds (need webapp module-scoped singletons) ──
    function facade() { return window.__STRUCTS_AGENT_UI__ || null; }
    function facadeKind(d, fnName, arg) {
      var f = facade();
      if (f && typeof f[fnName] === 'function') {
        try { f[fnName](arg); }
        catch (e) { console.warn('[Agent UI] facade.' + fnName + ' failed:', e); }
        if (d.mode === 'prompt') respond(d.directive_id, { ok: true }, false);
      } else {
        console.warn('[Agent UI] ' + d.component.kind + ' requires the webapp façade (window.__STRUCTS_AGENT_UI__).');
        if (d.mode === 'prompt') respond(d.directive_id, null, true);
      }
    }

    function renderDirective(d) {
      var c = (d && d.component) || {};
      // MAIN window only drives façade ACTIONS (open a menu, show a map preview)
      // that deliberately touch the game UI. All informational/agent UI —
      // toasts, dialogues, hud badges, panels — renders in the Team Ops board
      // window (frontend/board.html #agent-ui), never as an overlay on the game
      // view. This guard is defense-in-depth: the Rust bridge already targets
      // the board via emit_to, but should a broadcast ever leak here, the main
      // window silently ignores it instead of drawing over the game.
      if (c.kind !== 'open_menu' && c.kind !== 'map_preview') return;
      switch (c.kind) {
        case 'open_menu': return facadeKind(d, 'openMenu', c);
        case 'map_preview': return facadeKind(d, 'showPreview', c);
      }
    }

    TAURI.event.listen('mcp_ui_directive', function (event) {
      var d = event.payload;
      try { renderDirective(d); }
      catch (e) {
        console.error('[Agent UI] render error:', e);
        if (d && d.mode === 'prompt') respond(d.directive_id, null, true);
      }
    });

    console.info('[Agent UI] directive renderer enabled');
  })();

  // ── Update awareness ──
  // On startup, ask Rust whether a newer GitHub release exists (works on every
  // platform, no signed artifact required). If so, show a dismissible banner +
  // a one-time desktop notification. The "Update now" button does an in-app
  // download with progress, then prompts "Restart to update" so a live session
  // is never interrupted under the user. Where the self-updater can't install
  // (Linux .deb), or if no signed artifact is reachable yet, it falls back to
  // opening the releases page in the browser.
  (function () {
    var DISMISS_KEY = 'structs:update-dismissed-version';
    var TAURI = window.__TAURI__;
    if (!TAURI) return;

    function alreadyDismissed(version) {
      try { return window.localStorage.getItem(DISMISS_KEY) === version; }
      catch (e) { return false; }
    }
    function rememberDismissed(version) {
      try { window.localStorage.setItem(DISMISS_KEY, version); } catch (e) {}
    }

    function showBanner(info) {
      if (document.getElementById('structs-update-banner')) return;

      var bar = document.createElement('div');
      bar.id = 'structs-update-banner';
      bar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'gap:12px',
        'padding:var(--spacing-md) var(--spacing-xl)', 'box-sizing:border-box',
        // Tokens, not the same colours spelled as hex: #133546 IS
        // --surface-player-body and #43CDB6 IS --accent-primary, so these were
        // the palette already — just pinned, so they would not follow it.
        'background:var(--surface-player-body)', 'color:var(--text-body)',
        // DirectiveZero at a type role. This was a system font stack in a
        // `font:` shorthand — the OS's UI font, over a pixel-art game, on the
        // one bar that appears before anything else on startup.
        'font-family:DirectiveZero,sans-serif', 'font-size:12px', 'line-height:16px',
        'box-shadow:0 2px 8px rgba(0,0,0,0.35)'
      ].join(';');

      var msg = document.createElement('span');
      msg.style.flex = '1';
      msg.textContent = 'A new version of Structs (' + info.latest_version +
        ') is available. You’re on ' + info.current_version + '.';

      var dl = document.createElement('button');
      dl.textContent = 'Update now';
      dl.style.cssText = [
        'cursor:pointer', 'border:none',
        'padding:var(--spacing-md) var(--spacing-lg)',
        'background:var(--accent-primary)', 'color:var(--surface-player-body)'
      ].join(';');

      function openReleasePage() {
        TAURI.core.invoke('open_url', { url: info.url })
          .catch(function (e) { console.warn('[Structs Update] open_url failed:', e); });
      }

      function startInAppUpdate() {
        dl.disabled = true;
        dl.style.cursor = 'default';
        dl.textContent = 'Downloading… 0%';

        var unlistenProgress = TAURI.event.listen('structs://update-progress', function (e) {
          var pct = Math.max(0, Math.min(100, Math.round(e.payload || 0)));
          dl.textContent = 'Downloading… ' + pct + '%';
        });

        function cleanup() {
          unlistenProgress.then(function (un) { un(); }).catch(function () {});
        }

        TAURI.core.invoke('download_and_install_update').then(function () {
          cleanup();
          // Staged successfully — let the user choose when to relaunch.
          dl.disabled = false;
          dl.style.cursor = 'pointer';
          dl.textContent = 'Restart to update';
          dl.onclick = function () {
            TAURI.core.invoke('relaunch_app').catch(function (err) {
              console.warn('[Structs Update] relaunch failed:', err);
            });
          };
        }).catch(function (err) {
          cleanup();
          // No signed artifact yet, signature mismatch, unbundled/dev run, or a
          // download failure. Surface the reason instead of silently bouncing to
          // the browser, and offer a manual download as the next step.
          console.error('[Structs Update] in-app update failed:', err);
          msg.textContent = 'Auto-update failed: ' + (err && err.message ? err.message : err);
          dl.disabled = false;
          dl.style.cursor = 'pointer';
          dl.textContent = 'Download from page';
          dl.onclick = openReleasePage;
        });
      }

      dl.addEventListener('click', function handler() {
        // Only the first click drives a flow; subsequent behavior is rebound
        // via dl.onclick above (Restart / open page).
        dl.removeEventListener('click', handler);
        TAURI.core.invoke('updater_supported').then(function (supported) {
          if (supported) startInAppUpdate();
          else openReleasePage(); // Linux .deb etc.
        }).catch(function () { openReleasePage(); });
      });

      var close = document.createElement('button');
      close.textContent = '✕';
      close.setAttribute('aria-label', 'Dismiss');
      close.style.cssText = [
        'cursor:pointer', 'border:none', 'background:transparent',
        'color:var(--text-body)', 'font-size:16px', 'line-height:16px',
        'padding:var(--spacing-sm) var(--spacing-md)'
      ].join(';');
      close.addEventListener('click', function () {
        rememberDismissed(info.latest_version);
        bar.remove();
      });

      bar.appendChild(msg);
      bar.appendChild(dl);
      bar.appendChild(close);
      (document.body || document.documentElement).appendChild(bar);
    }

    function runCheck() {
      TAURI.core.invoke('check_for_update').then(function (info) {
        if (!info || !info.available) return;
        if (alreadyDismissed(info.latest_version)) return;
        showBanner(info);
        // One desktop notification per launch, reusing the existing command.
        TAURI.core.invoke('send_notification', {
          title: 'Structs update available',
          body: 'Version ' + info.latest_version + ' is ready to download.',
          channel: 'update'
        }).catch(function () {});
      }).catch(function (e) {
        console.warn('[Structs Update] check failed:', e);
      });
    }

    // Defer slightly so the UI and Tauri IPC are settled before we nag.
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(runCheck, 3000);
    } else {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(runCheck, 3000); });
    }
  })();

} else if (!window.__STRUCTS_CONFIG__) {
  console.info('No guild config injected (running outside Tauri)');
}
