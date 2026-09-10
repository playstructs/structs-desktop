// STRUCTS TERMINAL — Comms, as data.
//
// The Terminal used to reach Comms by putting the whole `chat.html` WINDOW
// inside a card, in an iframe. That window is a good window; it is a bad card.
// A window owns its own navigation, its own back button, its own idea of which
// room you are looking at and its own scroll — none of which a board of cards
// wants, and all of which fought the board for the same gestures. Finding a
// channel meant paging inside a frame inside a card; two conversations meant
// two copies of the entire window; and the command line — the Terminal's whole
// point — could not name a room, because rooms were not subjects.
//
// So this file is the MODEL and nothing else: one connection, one room list,
// one timeline cache, one live subscription, shared by every Comms card in the
// window. The cards (board-terminal-comms.js) are views over it.
//
// The rules it exists to keep:
//
//   ONE subscription. Matrix pushes `matrix::rooms`, `matrix::timeline`,
//   `matrix::typing`, `matrix::presence`, `matrix::seen`, `matrix::reactions`,
//   `matrix::redacted`, `matrix::edited`, `matrix::status`. Every card wanting
//   its own listeners is how a board with four Comms cards ends up sending
//   four read receipts for one glance.
//
//   ONE identity. `matrix_status` answers with a session KEY — the guild id
//   for the primary, `guild#player` for anyone else on the roster — and every
//   later call echoes that key back as `guildId`. A card that guesses the
//   guild id instead speaks as the wrong player, silently.
//
//   A ROOM IS A SUBJECT. `resolve()` turns everything a person might type —
//   a room id, an alias, `#trade`, a player id, a username, a planet or fleet
//   id — into a room. That is what lets ⌘K reach a conversation the same way
//   it reaches a planet, which is the whole reason to rebuild this natively.
(function () {
  'use strict';
  var Board = window.Board;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };

  /* Everything the window knows about Comms right now. Cards read it; only
   * this file writes it. */
  var S = {
    ready: false,          // a status read has landed at least once
    key: null,             // the session key — what every call passes as guildId
    connected: false,
    connecting: false,
    steps: [],             // the sign-in ladder, hop by hop
    error: null,
    profile: null,
    networks: [],
    rooms: [],             // client::Room, newest state from sync
    roomsAt: 0,
    timelines: {},         // room_id → [Message]
    typing: {},            // room_id → [user_id]
    presence: {},          // user_id → {state, last_active_ago, currently_active}
    people: null,          // the directory, for the DM picker
    listening: false,
    subs: [],              // repaint callbacks, pruned by liveness
  };

  /* Repaint. A card registers `fn` with a `host` on it; a card that has left
   * the document is dropped rather than drawn into — the same rule the feed
   * learned, for the same reason (one leaked closure per mount, all of them
   * running on every frame of a busy room). */
  function announce(what) {
    S.subs = S.subs.filter(function (fn) { return fn.host && fn.host.isConnected; });
    S.subs.forEach(function (fn) { try { fn(what); } catch (e) { /* a card's own problem */ } });
  }
  function watch(host, fn) {
    fn.host = host;
    S.subs = S.subs.filter(function (f) { return f.host && f.host !== host && f.host.isConnected; });
    S.subs.push(fn);
  }

  // ── Live ────────────────────────────────────────────────────────────────
  function wire() {
    if (S.listening || !window.StructsEvents) return;
    S.listening = true;
    var on = function (name, fn) { window.StructsEvents.listen(name, function (e) { fn(e && e.payload); }); };

    on('matrix::status', function (p) {
      if (!p) return;
      /* The emit is a BROADCAST — every Comms surface in every window receives
       * it — so a payload naming another identity is not ours. Without this
       * check a second roster identity signing in elsewhere redraws this card
       * as "connecting". */
      if (p.as_player !== undefined && p.as_player !== (S.asPlayer || null)) return;
      if (p.connecting !== undefined) S.connecting = !!p.connecting;
      if (p.steps) S.steps = p.steps;
      if (p.error !== undefined) S.error = p.error || null;
      if (p.networks) takeStatus(p);
      announce('status');
      if (!S.connecting && !S.error) refreshRooms();
    });

    on('matrix::rooms', function (p) {
      if (!p || (p.guild_id && p.guild_id !== S.key)) return;
      if (Array.isArray(p.rooms)) { S.rooms = p.rooms; S.roomsAt = Date.now(); }
      announce('rooms');
    });

    on('matrix::timeline', function (p) {
      if (!p || !p.room_id) return;
      var t = S.timelines[p.room_id];
      if (!t) return;   // not a room any card has open; the next open re-reads
      var msgs = p.messages || (p.message ? [p.message] : []);
      msgs.forEach(function (m) {
        var at = t.findIndex(function (x) { return x.event_id === m.event_id; });
        if (at >= 0) t[at] = m; else t.push(m);
      });
      t.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      announce('timeline:' + p.room_id);
    });

    on('matrix::edited', function (p) { patch(p, function (m) { m.body = p.body; m.edited = true; }); });
    on('matrix::redacted', function (p) {
      if (!p || !p.room_id) return;
      var t = S.timelines[p.room_id];
      if (!t) return;
      S.timelines[p.room_id] = t.filter(function (m) { return m.event_id !== p.event_id; });
      announce('timeline:' + p.room_id);
    });
    on('matrix::reactions', function (p) { patch(p, function (m) { m.reactions = p.reactions || []; }); });

    on('matrix::typing', function (p) {
      if (!p || !p.room_id) return;
      S.typing[p.room_id] = p.user_ids || p.users || [];
      announce('typing:' + p.room_id);
    });
    on('matrix::presence', function (p) {
      if (!p || !p.user_id) return;
      S.presence[p.user_id] = p;
      announce('presence');
    });
    on('matrix::seen', function () { announce('seen'); });
    on('matrix::show_room', function (p) {
      // Something outside the board asked for a room — a notification, the
      // game window, an MCP tool. Cards decide whether to take it.
      if (p && (p.room_id || p.roomId)) announce('show:' + (p.room_id || p.roomId));
    });
  }
  function patch(p, fn) {
    if (!p || !p.room_id) return;
    var t = S.timelines[p.room_id];
    if (!t) return;
    var m = t.filter(function (x) { return x.event_id === p.event_id; })[0];
    if (!m) return;
    fn(m);
    announce('timeline:' + p.room_id);
  }

  // ── Connection ──────────────────────────────────────────────────────────
  function takeStatus(d) {
    S.networks = (d && d.networks) || [];
    S.key = (d && d.selected) || (S.networks[0] && S.networks[0].guild_id) || null;
    S.profile = (d && d.profile) || null;
    S.error = (d && d.error) || null;
    var net = S.networks.filter(function (n) { return n.guild_id === S.key; })[0] || S.networks[0];
    S.connected = !!(net && net.logged_in);
    S.ready = true;
  }

  var statusInFlight = null;
  function status(force) {
    if (S.ready && !force) return Promise.resolve(S);
    if (statusInFlight) return statusInFlight;
    wire();
    statusInFlight = invoke('matrix_status', {}).then(function (d) {
      takeStatus(d);
      statusInFlight = null;
      announce('status');
      return S;
    }).catch(function (e) {
      statusInFlight = null;
      S.ready = true;
      S.error = String(e);
      announce('status');
      return S;
    });
    return statusInFlight;
  }

  function connect() {
    if (!S.key) return Promise.reject('no Comms network configured for this guild');
    S.connecting = true; S.error = null; S.steps = [];
    announce('status');
    return invoke('matrix_connect', { guildId: S.key })
      .then(function () { return status(true); })
      .then(function () { return refreshRooms(true); })
      .catch(function (e) { S.connecting = false; S.error = String(e); announce('status'); throw e; });
  }
  function disconnect() {
    if (!S.key) return Promise.resolve();
    return invoke('matrix_disconnect', { guildId: S.key }).then(function () { return status(true); });
  }

  // ── Rooms ───────────────────────────────────────────────────────────────
  var ROOMS_TTL = 20000;
  var roomsInFlight = null;
  function refreshRooms(force) {
    if (!S.connected || !S.key) return Promise.resolve(S.rooms);
    if (!force && Date.now() - S.roomsAt < ROOMS_TTL) return Promise.resolve(S.rooms);
    if (roomsInFlight) return roomsInFlight;
    roomsInFlight = invoke('matrix_rooms', { guildId: S.key }).then(function (d) {
      S.rooms = (d && d.rooms) || [];
      S.roomsAt = Date.now();
      roomsInFlight = null;
      announce('rooms');
      return S.rooms;
    }).catch(function (e) {
      roomsInFlight = null;
      /* A room-list read that fails KEEPS the list and says so. Erasing it
       * turns one bad request into an empty Comms, which reads as "you are in
       * nothing" — the same rule the Terminal's cards keep about stale data. */
      S.error = String(e);
      announce('rooms');
      return S.rooms;
    });
    return roomsInFlight;
  }

  function roomById(id) {
    var want = String(id || '');
    return S.rooms.filter(function (r) {
      return r.room_id === want || r.canonical_alias === want;
    })[0] || null;
  }

  /* Sections, in the order a person looks for them.
   *
   * Invites first because they are the only rows that expire — somebody is
   * waiting on an answer. Then whatever the server pinned above the sections
   * (`home_rank`), then people, then your guild, then the wider galaxy. */
  var SECTIONS = [
    { key: 'invited', label: 'Invited', icon: 'icon-incoming' },
    { key: 'pinned', label: 'Pinned', icon: 'icon-beacon' },
    { key: 'direct', label: 'People', icon: 'icon-member' },
    { key: 'local', label: 'Guild', icon: 'icon-guild' },
    { key: 'galaxy', label: 'Galaxy', icon: 'icon-planet' },
  ];
  function sectionOf(r) {
    if (r.invited) return 'invited';
    if (r.home_rank != null) return 'pinned';
    return r.section || 'galaxy';
  }
  /* The room list a card draws: joined rooms only, grouped, each group in the
   * order the server gave (already joined-first, then section, then name). */
  function sections(opts) {
    opts = opts || {};
    var out = [];
    SECTIONS.forEach(function (sec) {
      var rows = S.rooms.filter(function (r) {
        if (sectionOf(r) !== sec.key) return false;
        if (sec.key === 'invited') return true;
        if (!r.joined) return false;
        if (opts.only && opts.only !== 'all' && sec.key !== opts.only) return false;
        if (opts.unreadOnly && !r.unread && !r.mention) return false;
        if (opts.query && !matches(r, opts.query)) return false;
        return true;
      });
      if (rows.length) out.push({ section: sec, rooms: rows });
    });
    return out;
  }
  function matches(r, q) {
    var t = String(q || '').toLowerCase().replace(/^#/, '');
    if (!t) return true;
    return String(r.name || '').toLowerCase().indexOf(t) >= 0
      || String(r.canonical_alias || '').toLowerCase().indexOf(t) >= 0
      || String(r.topic || '').toLowerCase().indexOf(t) >= 0
      || String(r.player_id || '').toLowerCase().indexOf(t) >= 0;
  }

  /* What is waiting, across everything. The number the door into Comms wears. */
  function waiting() {
    var unread = 0, mention = 0, invites = 0;
    S.rooms.forEach(function (r) {
      if (r.invited) { invites++; return; }
      if (!r.joined || r.muted) return;
      unread += Number(r.unread) || 0;
      if (r.mention) mention++;
    });
    return { unread: unread, mention: mention, invites: invites };
  }

  // ── Resolving a subject to a room ───────────────────────────────────────
  //
  // The Terminal's grammar is `WORD subject`, and until now Comms had no
  // subject it understood. These are all the same request:
  //
  //   ROOM !abcdef:oh.energy     the room id
  //   ROOM #trade:oh.energy      an alias, or just #trade
  //   ROOM 1-61                  that player's DM (opened if it does not exist)
  //   ROOM JPEG                  the same, by the name people use
  //   ROOM 2-15361               the planet's own room
  //   ROOM 9-2136                the fleet's own room
  var ID_RE = /^\d{1,2}-\d{1,9}$/;
  function kindOf(id) { return ID_RE.test(String(id || '')) ? Number(String(id).split('-')[0]) : null; }

  /* Which of those a subject looks like, without asking the network. Pure, so
   * the palette can decide whether a word is even askable before it asks. */
  function subjectKind(subject) {
    var s = String(subject || '').trim();
    if (!s) return null;
    if (s.charAt(0) === '!') return 'room';
    if (s.charAt(0) === '#') return 'alias';
    var k = kindOf(s);
    if (k === 1) return 'player';
    if (k === 2 || k === 9) return 'object';
    if (k != null) return null;         // a guild or struct id is not a room
    return 'name';
  }

  /* Subject → `{room_id, name}`, opening or joining as needed. Rejects with a
   * sentence rather than a code: the caller puts it on a card. */
  function resolve(subject) {
    var s = String(subject || '').trim();
    var kind = subjectKind(s);
    if (!kind) return Promise.reject('“' + s + '” is not a room, a player or an object');
    if (!S.key) return Promise.reject('Comms has no network for this guild');
    if (!S.connected) return Promise.reject('Comms is not connected — sign in first');
    /* The list FIRST. "Do I already have this room" cannot be answered before
     * it has loaded, and answering "no" too early joins a room you are in —
     * which is harmless for an alias and wrong for a room id, because the
     * join's reply is about whatever the server did, not about what was asked
     * for. A card that mounts before the first sync landed hit exactly that. */
    return refreshRooms().then(function () { return resolved(s, kind); });
  }
  function resolved(s, kind) {
    if (kind === 'room') {
      var known = roomById(s);
      return known ? Promise.resolve(known)
        : invoke('matrix_join', { guildId: S.key, roomId: s }).then(afterJoin(s));
    }
    if (kind === 'alias') {
      // `#trade` and `#trade:oh.energy` are the same ask; the short form is
      // what people type, so try it against what we already have first.
      var hit = S.rooms.filter(function (r) {
        var a = String(r.canonical_alias || '');
        return a === s || a.indexOf(s + ':') === 0;
      })[0];
      if (hit && hit.joined) return Promise.resolve(hit);
      var target = hit ? hit.room_id : s;
      return invoke('matrix_join', { guildId: S.key, roomId: target }).then(afterJoin(target));
    }
    if (kind === 'object') {
      return invoke('matrix_object_room', { guildId: S.key, objectId: s })
        .then(function (d) {
          var id = d && (d.room_id || d.roomId);
          if (!id) return Promise.reject('no room for ' + s + ' yet — say something to start it');
          return afterJoin(id)(d);
        });
    }
    // A player, by id or by name. `matrix_dm` is idempotent — an existing DM
    // comes back rather than a second room beside it.
    return (kind === 'player' ? Promise.resolve(s) : playerIdFor(s)).then(function (pid) {
      if (!pid) return Promise.reject('no player called “' + s + '”');
      return invoke('matrix_dm', { guildId: S.key, playerId: pid }).then(function (d) {
        var id = d && (d.room_id || d.roomId);
        if (!id) return Promise.reject('could not open a message with ' + pid);
        return afterJoin(id)(d);
      });
    });
  }
  /* What we ASKED for wins over what the reply happens to name. A join answers
   * with the room the server acted on, which for an alias is the id we wanted
   * and for a room id is the same id again — but a stub, a redirect or an
   * upgraded alias can differ, and a card that took the reply's word for it
   * opened a different conversation than the one it was told to. */
  function afterJoin(asked) {
    return function (d) {
      var told = d && (d.room_id || d.roomId);
      return refreshRooms(true).then(function () {
        return (String(asked).charAt(0) === '!' && roomById(asked))
          || roomById(told) || roomById(asked)
          || { room_id: told || asked, name: (d && d.name) || asked, joined: true };
      });
    };
  }

  /* A name → a player id, out of the Comms directory. The directory is the
   * right source here rather than the game's player search: it knows which
   * players are REACHABLE (whose guild runs a homeserver), and offering a name
   * that cannot be messaged is worse than not offering it. */
  function people(query) {
    if (!S.key) return Promise.resolve([]);
    return invoke('matrix_people', { guildId: S.key, query: query || null })
      .then(function (d) {
        var list = (d && (d.people || d.players)) || (Array.isArray(d) ? d : []);
        if (!query) S.people = list;
        return list;
      }).catch(function () { return S.people || []; });
  }
  function playerIdFor(name) {
    var want = String(name || '').toLowerCase();
    var pick = function (list) {
      var exact = list.filter(function (p) { return String(p.name || '').toLowerCase() === want; })[0];
      var near = list.filter(function (p) { return String(p.name || '').toLowerCase().indexOf(want) === 0; })[0];
      var any = list.filter(function (p) { return String(p.name || '').toLowerCase().indexOf(want) >= 0; })[0];
      var hit = exact || near || any;
      return hit ? (hit.player_id || hit.id) : null;
    };
    var cached = S.people && pick(S.people);
    if (cached) return Promise.resolve(cached);
    return people(name).then(pick);
  }

  // ── A conversation ──────────────────────────────────────────────────────
  function timeline(roomId, opts) {
    opts = opts || {};
    if (!S.key || !roomId) return Promise.resolve([]);
    var have = S.timelines[roomId];
    if (have && !opts.force) return Promise.resolve(have);
    return invoke('matrix_timeline', { guildId: S.key, roomId: roomId, limit: opts.limit || 60 })
      .then(function (d) {
        var msgs = (d && (d.messages || d.timeline)) || (Array.isArray(d) ? d : []);
        S.timelines[roomId] = msgs;
        announce('timeline:' + roomId);
        return msgs;
      }).catch(function (e) {
        /* Same rule as the room list: a failed read keeps what we had. An
         * empty timeline and an unreachable one look identical otherwise. */
        if (!S.timelines[roomId]) S.timelines[roomId] = [];
        S.error = String(e);
        announce('timeline:' + roomId);
        return S.timelines[roomId];
      });
  }
  function older(roomId) {
    if (!S.key || !roomId) return Promise.resolve(0);
    return invoke('matrix_backfill', { guildId: S.key, roomId: roomId })
      .then(function (d) {
        var msgs = (d && (d.messages || d.timeline)) || [];
        if (!msgs.length) return 0;
        var t = S.timelines[roomId] || [];
        var known = {};
        t.forEach(function (m) { known[m.event_id] = 1; });
        var add = msgs.filter(function (m) { return !known[m.event_id]; });
        S.timelines[roomId] = add.concat(t);
        announce('timeline:' + roomId);
        return add.length;
      }).catch(function () { return 0; });
  }
  function send(roomId, body, replyTo) {
    if (!S.key || !roomId || !String(body || '').trim()) return Promise.resolve(null);
    return invoke('matrix_send', {
      guildId: S.key, roomId: roomId, body: String(body), replyTo: replyTo || null,
    });
  }
  function markRead(roomId) {
    if (!S.key || !roomId) return Promise.resolve();
    return invoke('matrix_mark_read', { guildId: S.key, roomId: roomId }).catch(function () {});
  }
  function typing(roomId, on) {
    if (!S.key || !roomId) return Promise.resolve();
    return invoke('matrix_typing', { guildId: S.key, roomId: roomId, typing: !!on }).catch(function () {});
  }

  window.BoardComms = {
    S: S, watch: watch, announce: announce,
    status: status, connect: connect, disconnect: disconnect,
    rooms: refreshRooms, roomById: roomById, sections: sections, SECTIONS: SECTIONS,
    sectionOf: sectionOf, matches: matches, waiting: waiting,
    subjectKind: subjectKind, resolve: resolve, people: people, playerIdFor: playerIdFor,
    timeline: timeline, older: older, send: send, markRead: markRead, typing: typing,
  };
})();
