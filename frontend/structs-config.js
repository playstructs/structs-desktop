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
    function formatUnit(amount, denom) {
      if (amount == null || amount === '?') return '?';
      var num = parseFloat(amount);
      if (isNaN(num)) return String(amount);
      var len = Math.floor(num).toString().length;

      if (denom === 'ualpha' || !denom) {
        // Alpha Matter: ualpha → μg, mg, g, Kg, Tg
        var exp, postfix;
        if (len >= 16)      { exp = 18; postfix = 'Tg'; }
        else if (len >= 10) { exp = 9;  postfix = 'Kg'; }
        else if (len >= 6)  { exp = 6;  postfix = 'g'; }
        else if (len >= 3)  { exp = 3;  postfix = 'mg'; }
        else                { exp = 0;  postfix = 'μg'; }
        return (num / Math.pow(10, exp)).toFixed(2).replace(/\.?0+$/, '') + postfix;

      } else if (denom === 'ore') {
        // Ore: g, Kg, Tg
        if (len >= 12)      { exp = 12; postfix = 'Tg'; }
        else if (len >= 4)  { exp = 3;  postfix = 'Kg'; }
        else                { exp = 0;  postfix = 'g'; }
        return (num / Math.pow(10, exp)).toFixed(2).replace(/\.?0+$/, '') + postfix;

      } else if (denom === 'milliwatt') {
        // Power: mW, W, KW, MW, TW
        if (len >= 16)      { exp = 18; postfix = 'TW'; }
        else if (len >= 10) { exp = 9;  postfix = 'MW'; }
        else if (len >= 6)  { exp = 6;  postfix = 'KW'; }
        else if (len >= 3)  { exp = 3;  postfix = 'W'; }
        else                { exp = 0;  postfix = 'mW'; }
        return (num / Math.pow(10, exp)).toFixed(2).replace(/\.?0+$/, '') + postfix;
      }

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
          return d.subject && d.subject.indexOf(ctx.playerId) !== -1;
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
          return d.subject && d.subject.indexOf(ctx.playerId) !== -1;
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
          if (!(d.subject && d.subject.indexOf(ctx.playerId) !== -1)) return false;
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
          return d.subject && d.subject.indexOf(ctx.playerId) !== -1;
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

    function sendNotification(title, body) {
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('send_notification', { title: title, body: body })
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
        var ws = new target(...args);
        var url = args[0] || '';

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
              if (!window.__STRUCTS_NOTIFICATIONS__.enabled) return;

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

              // Push all events to Rust event buffer for MCP access
              if (window.__TAURI__ && data.category !== 'block') {
                window.__TAURI__.core.invoke('push_game_event', {
                  event: {
                    category: data.category,
                    subject: data.subject || '',
                    detail: data.detail || {},
                    timestamp: Date.now()
                  }
                }).catch(function() {});
              }

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
                sendNotification(title, body);
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
              // Notify Rust for auto-chain policies (e.g., auto_refine after mine)
              window.__TAURI__.core.invoke('notify_hash_complete', {
                struct_id: event.payload.object_id,
                task_type: event.payload.task_type || ''
              }).catch(function() {});
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
              primary_weapon_ambits: pickNum(t, 'primary_weapon_ambits', 'primaryWeaponAmbits'),
              secondary_weapon_ambits: pickNum(t, 'secondary_weapon_ambits', 'secondaryWeaponAmbits'),
              // Combat math fields (ruleset matrix + damage simulator).
              primary_weapon: pickStr(t, 'primary_weapon', 'primaryWeapon'),
              primary_weapon_control: pickStr(t, 'primary_weapon_control', 'primaryWeaponControl'),
              primary_weapon_shots: pickNum(t, 'primary_weapon_shots', 'primaryWeaponShots'),
              primary_weapon_damage: pickNum(t, 'primary_weapon_damage', 'primaryWeaponDamage'),
              primary_weapon_recoil_damage: pickNum(t, 'primary_weapon_recoil_damage', 'primaryWeaponRecoilDamage'),
              primary_weapon_shot_success_numerator: pickNum(t, 'primary_weapon_shot_success_numerator', 'primaryWeaponShotSuccessRateNumerator'),
              primary_weapon_shot_success_denominator: pickNum(t, 'primary_weapon_shot_success_denominator', 'primaryWeaponShotSuccessRateDenominator'),
              primary_weapon_guaranteed_shots: pickNum(t, 'primary_weapon_guaranteed_shots', 'primaryWeaponGuaranteedShots'),
              primary_weapon_blockable: pickBool(t, 'primary_weapon_blockable', 'primaryWeaponBlockable'),
              primary_weapon_counterable: pickBool(t, 'primary_weapon_counterable', 'primaryWeaponCounterable'),
              secondary_weapon: pickStr(t, 'secondary_weapon', 'secondaryWeapon'),
              secondary_weapon_control: pickStr(t, 'secondary_weapon_control', 'secondaryWeaponControl'),
              secondary_weapon_shots: pickNum(t, 'secondary_weapon_shots', 'secondaryWeaponShots'),
              secondary_weapon_damage: pickNum(t, 'secondary_weapon_damage', 'secondaryWeaponDamage'),
              secondary_weapon_recoil_damage: pickNum(t, 'secondary_weapon_recoil_damage', 'secondaryWeaponRecoilDamage'),
              secondary_weapon_shot_success_numerator: pickNum(t, 'secondary_weapon_shot_success_numerator', 'secondaryWeaponShotSuccessRateNumerator'),
              secondary_weapon_shot_success_denominator: pickNum(t, 'secondary_weapon_shot_success_denominator', 'secondaryWeaponShotSuccessRateDenominator'),
              secondary_weapon_guaranteed_shots: pickNum(t, 'secondary_weapon_guaranteed_shots', 'secondaryWeaponGuaranteedShots'),
              secondary_weapon_blockable: pickBool(t, 'secondary_weapon_blockable', 'secondaryWeaponBlockable'),
              secondary_weapon_counterable: pickBool(t, 'secondary_weapon_counterable', 'secondaryWeaponCounterable'),
              counter_attack: pickNum(t, 'counter_attack', 'counterAttack'),
              counter_attack_same_ambit: pickNum(t, 'counter_attack_same_ambit', 'counterAttackSameAmbit'),
              attack_reduction: pickNum(t, 'attack_reduction', 'attackReduction'),
              post_destruction_damage: pickNum(t, 'post_destruction_damage', 'postDestructionDamage'),
              has_stealth_system: pickBool(t, 'has_stealth_system', 'hasStealthSystem')
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

          // ── Transfer ──
          case 'bank_send':
            promise = scm.queueMsgBankSend(args.from_address, args.to_address, args.amount);
            break;

          // ── Generator ──
          case 'struct_generator_infuse':
            promise = scm.queueMsgStructGeneratorInfuse(args.struct_id, args.amount);
            break;

          // ── Allocation ──
          case 'allocation_create':
            promise = scm.queueMsgAllocationCreate(args.controller, args.source_object_id, args.allocation_type, args.power);
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

        // When the tx settles, push the real result into the event buffer as a
        // `tx_settled` event so the agent reads receipts via structs_events.
        function reportSettled(tx) {
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
          var signingMissing = (window.signingClientManager && !sc);

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

      var row = function(label, value, id) {
        var valHtml = id ? '<span id="' + id + '">' + value + '</span>' : value;
        return '<div class="sui-data-card-row" style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:2px 0;"><div style="white-space:nowrap; color:var(--text-hint);">' + label + '</div><div style="text-align:right; word-break:break-all; color:var(--text-body);">' + valHtml + '</div></div>';
      };

      var html = '<div style="padding: 4px; display:flex; flex-direction:column; gap:8px; width:100%;">';

      // Identity
      html += '<div class="sui-data-card">';
      html += '<div class="sui-data-card-header sui-text-header">Identity</div>';
      html += '<div class="sui-data-card-body">';
      html += row('Player', playerName + ' (' + playerId + ')');
      html += row('Address', '<span id="debug-address" style="cursor:pointer; text-decoration:underline; text-decoration-style:dotted;">' + walletAddress.substring(0, 24) + '… (copy)</span>');
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
      html += row('Token', '<span id="debug-mcp-token">loading...</span>');
      html += row('Config', '<span id="debug-mcp-config" style="cursor:pointer; text-decoration:underline; text-decoration-style:dotted; color:var(--accent-primary);">Copy to clipboard</span>');
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

      html += '</div>';

      // Inject into page content
      var contentEl = document.getElementById('menu-page-body-content');
      if (contentEl) {
        contentEl.innerHTML = html;
      }

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

        // Load MCP config
        window.__TAURI__.core.invoke('get_mcp_config').then(function(mcpConfig) {
          var statusEl = document.getElementById('debug-mcp-status');
          if (statusEl) statusEl.textContent = mcpConfig.enabled ? 'Running on port ' + mcpConfig.port : 'Disabled';
          var tokenEl = document.getElementById('debug-mcp-token');
          if (tokenEl && mcpConfig.bearer_token) {
            var t = mcpConfig.bearer_token;
            tokenEl.textContent = t.substring(0, 8) + '...' + t.substring(t.length - 4);
            tokenEl.style.cursor = 'pointer';
            tokenEl.style.textDecoration = 'underline';
            tokenEl.style.textDecorationStyle = 'dotted';
            tokenEl.addEventListener('click', function() {
              copyToClipboard(t);
              tokenEl.textContent = 'Copied!';
              setTimeout(function() { tokenEl.textContent = t.substring(0, 8) + '...' + t.substring(t.length - 4); }, 1000);
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
        }).catch(function() {});

        // Load hash engine status (also refreshes on a 2s tick below)
        function refreshHashEngine() {
          if (!debugActive) return;
          window.__TAURI__.core.invoke('list_hash_tasks').then(function(data) {
            var engineEl = document.getElementById('debug-engine');
            if (!engineEl) return;

            // ── Engine summary ──
            var html = '';
            var engineLabel;
            if (data.engine === 'gpu' && data.gpu_info) {
              engineLabel = 'GPU — ' + data.gpu_info.name +
                ' (' + data.gpu_info.backend + ', ' + data.gpu_info.device_type + ')';
            } else if (data.engine === 'gpu') {
              engineLabel = 'GPU';
            } else {
              engineLabel = 'CPU — ' + (data.cpu_threads || '?') + ' threads of ' +
                (data.cpu_total_cores || '?') + ' cores';
            }
            html += row('Engine', engineLabel);

            // ── Task Manager toggle ──
            // The JS-side TaskManager listens for TASK_CMD_MANAGER_PAUSE /
            // TASK_CMD_MANAGER_RESUME events; we just dispatch them. State
            // is read from window.taskManager (exposed via `global.taskManager`
            // in webapp/index.js) so the button label flips correctly even
            // when pause/resume was triggered elsewhere.
            var mgr = window.taskManager;
            var isOnline = (mgr && typeof mgr.isOnline === 'function') ? mgr.isOnline() : null;
            var mgrStatusText, mgrStatusColor, btnLabel;
            if (isOnline === true) {
              mgrStatusText = 'ONLINE';
              mgrStatusColor = 'var(--accent-primary)';
              btnLabel = 'Pause';
            } else if (isOnline === false) {
              mgrStatusText = 'PAUSED';
              mgrStatusColor = 'var(--text-hint)';
              btnLabel = 'Resume';
            } else {
              mgrStatusText = 'Unknown';
              mgrStatusColor = 'var(--text-hint)';
              btnLabel = 'Toggle';
            }
            var btnHtml = '<a id="debug-engine-toggle" href="javascript:void(0)" ' +
              'style="padding:2px 12px; margin-left:8px; border:1px solid var(--accent-primary); ' +
              'color:var(--accent-primary); text-decoration:none; border-radius:2px; font-size:0.9em;">' +
              btnLabel + '</a>';
            html += row('Task Manager',
              '<span style="color:' + mgrStatusColor + '; font-weight:bold;">' + mgrStatusText + '</span>' + btnHtml);

            html += row('Active Tasks', String(data.active_tasks || 0));

            // ── Per-task detail ──
            if (data.tasks && data.tasks.length > 0) {
              // Format helpers
              var fmtHashrate = function(hashesPerMs) {
                // estimated_hashrate is in hashes/millisecond. Convert to h/s.
                var hps = (hashesPerMs || 0) * 1000;
                if (hps >= 1e9) return (hps / 1e9).toFixed(2) + ' Gh/s';
                if (hps >= 1e6) return (hps / 1e6).toFixed(1) + ' Mh/s';
                if (hps >= 1e3) return (hps / 1e3).toFixed(1) + ' Kh/s';
                return Math.round(hps) + ' h/s';
              };
              var fmtElapsed = function(startMs) {
                if (!startMs) return '?';
                var s = Math.max(0, (Date.now() - startMs) / 1000);
                if (s < 60) return s.toFixed(0) + 's';
                if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
                return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
              };
              var fmtNum = function(n) {
                if (n == null) return '—';
                if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
                if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
                if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
                return String(n);
              };

              for (var i = 0; i < data.tasks.length; i++) {
                var t = data.tasks[i];

                // Per-task sub-card with a header row + detail rows
                var headerLabel = (t.task_type || '?') + ' ' + t.task_id +
                  (t.target_id ? ' → ' + t.target_id : '');
                var statusColor = t.status === 'completed' ? 'var(--accent-primary)'
                  : (t.status === 'waiting' ? 'var(--text-hint)' : 'var(--text-body)');

                // Box padding: left-only so labels visually indent under the
                // task header (groups them) while values stay flush-right with
                // the rest of the card's rows.
                html += '<div style="margin-top:8px; padding:4px 0 4px 10px; border-left:2px solid var(--accent-primary); background:rgba(0,0,0,0.15);">';
                html += '<div style="display:flex; justify-content:space-between; align-items:center; padding-bottom:4px;">';
                html += '<div style="color:var(--text-body); font-weight:bold;">' + headerLabel + '</div>';
                html += '<div style="color:' + statusColor + ';">' + (t.status || '?') + '</div>';
                html += '</div>';

                html += row('Hashrate', fmtHashrate(t.hashrate));
                html += row('Iterations', fmtNum(t.iterations) +
                  (t.iterations_since_last_start ? ' (this session: ' + fmtNum(t.iterations_since_last_start) + ')' : ''));
                html += row('Difficulty', 'target ' + t.difficulty_target +
                  (t.result_difficulty ? ', best found ' + t.result_difficulty : ''));
                html += row('Block range', 'started ' + t.block_start +
                  (t.block_current_estimated && t.block_current_estimated !== t.block_start
                    ? ' → est ' + t.block_current_estimated + ' (' + (t.block_current_estimated - t.block_start) + ' blocks)'
                    : ''));
                html += row('Elapsed', fmtElapsed(t.process_start_time));
                if (t.object_type) html += row('Object', t.object_type);
                if (t.result_exists) {
                  html += row('Result', 'found! nonce=' + (t.result_nonce || '?') +
                    ' difficulty=' + t.result_difficulty);
                }

                html += '</div>';
              }
            } else {
              html += row('Queue', 'No active tasks');
            }
            engineEl.innerHTML = html;

            // Re-attach the toggle handler each render (innerHTML wiped it).
            var toggleBtn = document.getElementById('debug-engine-toggle');
            if (toggleBtn) {
              toggleBtn.addEventListener('click', function() {
                var mgrNow = window.taskManager;
                var onlineNow = (mgrNow && typeof mgrNow.isOnline === 'function') ? mgrNow.isOnline() : true;
                var evtName = onlineNow ? 'TASK_CMD_MANAGER_PAUSE' : 'TASK_CMD_MANAGER_RESUME';
                window.dispatchEvent(new CustomEvent(evtName));
                console.info('[Structs Debug] Dispatched ' + evtName);
                // Optimistic refresh — state-change event also forces one but
                // this gives instant feedback if the listener races.
                setTimeout(refreshHashEngine, 50);
              });
            }
          }).catch(function(e) {
            var engineEl = document.getElementById('debug-engine');
            if (engineEl) engineEl.innerHTML = row('Error', String(e));
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
        var hashTick = setInterval(function() {
          if (!debugActive || !document.getElementById('debug-engine')) {
            clearInterval(hashTick);
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
          var out = '<div style="margin-top:8px; padding:4px 0 4px 10px; border-left:2px solid var(--accent-primary); background:rgba(0,0,0,0.15);">';
          out += '<div style="color:var(--text-body); font-weight:bold; padding-bottom:4px;">' + title +
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
            'style="padding:2px 12px; margin-left:8px; border:1px solid var(--accent-primary); ' +
            'color:var(--accent-primary); text-decoration:none; border-radius:2px; font-size:0.9em;">' +
            'Refresh</a>';
          html += row('Status',
            (online ? '<span style="color:var(--accent-primary);">ONLINE</span>'
                    : '<span style="color:var(--accent-warning, #d66);">OFFLINE</span>') + refreshBtn);
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
        var energyTick = setInterval(function() {
          if (!debugActive || !document.getElementById('debug-energy')) {
            clearInterval(energyTick);
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
              var status = p.enabled ? '<span style="color:var(--accent-primary);">ON</span>' : '<span style="color:var(--text-hint);">OFF</span>';
              html += row(name, status);
            }
          }
          policiesEl.innerHTML = html;
        }).catch(function(e) {
          var policiesEl = document.getElementById('debug-policies');
          if (policiesEl) policiesEl.innerHTML = row('Error', String(e));
        });

      }, 100);
    }

    // Watch for the nav to render and inject our tab
    var observer = new MutationObserver(function() {
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

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function respond(directiveId, value, cancelled) {
      TAURI.core.invoke('mcp_ui_response', {
        response: { directive_id: directiveId, value: value == null ? null : value, cancelled: !!cancelled }
      }).catch(function (e) { console.warn('[Agent UI] response failed:', e); });
    }

    // One-time CSS: the "⚡ Agent" marker + overlay positioning. Visual styling
    // leans on the global SUI classes; this only adds layout + attribution.
    (function injectCss() {
      if (document.getElementById('agent-ui-style')) return;
      var css =
        '.agent-ui-mark{display:inline-block;font-size:11px;font-weight:700;opacity:.85;margin-left:6px;padding:1px 6px;border-radius:8px;background:rgba(120,180,255,.18);color:#9ecbff;vertical-align:middle}' +
        '.agent-ui-overlay{position:fixed;inset:0;z-index:99999;display:flex;justify-content:flex-end;background:rgba(0,0,0,.35)}' +
        '.agent-ui-overlay.agent-ui-center{align-items:center;justify-content:center}' +
        '.agent-ui-surface{max-width:420px;width:90%;max-height:90vh;overflow:auto;margin:0;box-shadow:0 0 40px rgba(0,0,0,.5)}' +
        '.agent-ui-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.07)}' +
        '.agent-ui-row .k{opacity:.7}' +
        '.agent-ui-item{display:block;width:100%;text-align:left;margin:6px 0}' +
        '.agent-ui-item small{display:block;opacity:.65;font-weight:400}' +
        '.agent-ui-toaststack{position:fixed;right:16px;bottom:16px;z-index:100000;display:flex;flex-direction:column;gap:8px;max-width:360px}' +
        '.agent-ui-toast{padding:10px 12px;border-radius:8px;background:#1b2233;color:#dfe7f5;border-left:4px solid #5b8def;box-shadow:0 4px 16px rgba(0,0,0,.4);font-size:13px}' +
        '.agent-ui-toast.level-warning{border-left-color:#e0a93b}' +
        '.agent-ui-toast.level-error{border-left-color:#e05b5b}' +
        '.agent-ui-badge{margin:2px;padding:3px 8px;border-radius:8px;font-size:12px;background:rgba(120,180,255,.15);color:#9ecbff;display:inline-flex;gap:6px;align-items:center}' +
        '.agent-ui-badge.theme-enemy{background:rgba(224,91,91,.18);color:#ffb3b3}' +
        '.agent-ui-badge.theme-player{background:rgba(94,200,140,.18);color:#9ff0bf}';
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
        '<div class="sui-panel sui-offcanvas sui-theme-' + esc(c.theme || 'neutral') + ' agent-ui-surface">' +
          '<div class="sui-offcanvas-header sui-screen-nav-item">' + title + ' <span class="agent-ui-mark">⚡ Agent</span>' +
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
      switch (c.kind) {
        case 'toast': return showToast(c);
        case 'hud_badge': return showHudBadge(c);
        case 'dismiss':
          if (c.target_id) { removeHudBadge(c.target_id); closePanel(c.target_id, null, true); }
          return;
        case 'menu': return showSurface(d, 'menu');
        case 'dialogue': return showSurface(d, 'dialogue');
        case 'info': return showSurface(d, 'info');
        case 'panel': return showSurface(d, 'panel');
        case 'raw_html': return showSurface(d, 'raw_html');
        case 'open_menu': return facadeKind(d, 'openMenu', c);
        case 'map_preview': return facadeKind(d, 'showPreview', c);
        default: console.warn('[Agent UI] unknown directive kind:', c.kind);
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
        'padding:8px 14px', 'box-sizing:border-box',
        'background:#133546', 'color:#fff',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,0.35)'
      ].join(';');

      var msg = document.createElement('span');
      msg.style.flex = '1';
      msg.textContent = 'A new version of Structs (' + info.latest_version +
        ') is available. You’re on ' + info.current_version + '.';

      var dl = document.createElement('button');
      dl.textContent = 'Update now';
      dl.style.cssText = [
        'cursor:pointer', 'border:none', 'border-radius:4px',
        'padding:6px 12px', 'font-weight:600',
        'background:#43CDB6', 'color:#133546'
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
        'color:#fff', 'font-size:15px', 'line-height:1', 'padding:4px 6px'
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
          body: 'Version ' + info.latest_version + ' is ready to download.'
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
