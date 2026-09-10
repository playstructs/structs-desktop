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
    readAt: {},            // room_id → the event id we last told the server about
    members: {},           // room_id → [member], for @-mentions and completion
    drafts: {},            // room_id → what you typed and did not send
    pinned: {},            // room_id → the room's pinned events
    lastRead: {},          // room_id → the event id the unread divider sits under
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
      var msgs = p.messages || [];
      settleEchoes(p.room_id, msgs);
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

    /* Rust sends `names` — the display names already resolved, because the
     * window has no business turning `@1-61:h` into "JPEG" a second time. This
     * read `user_ids`, which nothing ever sent, so the typing line never once
     * appeared. */
    on('matrix::typing', function (p) {
      if (!p || !p.room_id) return;
      S.typing[p.room_id] = p.names || [];
      announce('typing:' + p.room_id);
    });
    /* And presence arrives as the WHOLE map, keyed by player id, not one
     * person at a time. Reading `p.user_id` off it got undefined and returned
     * early every single time, so no presence dot has ever lit. */
    on('matrix::presence', function (p) {
      if (!p || !p.presence) return;
      S.presence = p.presence;
      announce('presence');
    });
    on('matrix::seen', function () { announce('seen'); });
    on('matrix::show_room', function (p) {
      // Something outside the board asked for a room — a notification, the
      // game window, an MCP tool. Cards decide whether to take it.
      if (p && p.room_id) announce('show:' + p.room_id);
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
  /* ── How the list is organised ────────────────────────────────────────
   *
   * PINNED · WAITING · QUIET, not one section per Matrix concept.
   *
   * The five fixed sections mirrored the model and answered the wrong
   * question. Two things were wrong with them:
   *
   *   The Guild/Galaxy split is by YOUR homeserver. Comms is decentralised —
   *   every guild runs one — but a community has a centre of gravity, and when
   *   that centre is another guild's server every channel anybody actually
   *   talks in filed under "Galaxy" beside genuinely random rooms.
   *
   *   Sections that are usually empty cost a 306px column every day for
   *   something that happens monthly.
   *
   * So: what you PINNED, in a stable order, because you look for it by
   * position. Then everything with something waiting, worst first. Then the
   * quiet ones, collapsed to a count.
   */
  /* Pins live in this window, remembered across sessions where they can be.
   *
   * `localStorage` THROWS on a `file:` origin and in a private window, so the
   * in-memory copy is the truth and storage is only where it is written down.
   * A read that throws used to mean pinning silently did nothing at all. */
  var PIN_KEY = 'structs.comms.pins';
  var pinned_ = null;
  function pins() {
    if (pinned_) return pinned_;
    try { pinned_ = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch (e) { pinned_ = []; }
    if (!Array.isArray(pinned_)) pinned_ = [];
    return pinned_;
  }
  function isPinned(roomId) { return pins().indexOf(roomId) >= 0; }
  function togglePin(roomId) {
    var list = pins();
    var at = list.indexOf(roomId);
    if (at >= 0) list.splice(at, 1); else list.push(roomId);
    try { localStorage.setItem(PIN_KEY, JSON.stringify(list)); } catch (e) { /* memory only */ }
    announce('rooms');
    return at < 0;
  }

  /* Which server this community's centre of gravity is on.
   *
   * DERIVED, never configured: the server the largest share of your joined
   * channels live on, when that is not your own. A guild that becomes the
   * place everybody meets becomes the Hub without anyone typing anything, and
   * a community that moves takes the label with it.
   */
  function serverOf(roomId) {
    var at = String(roomId || '').lastIndexOf(':');
    return at > 0 ? String(roomId).slice(at + 1) : '';
  }
  function mine() {
    var net = S.networks.filter(function (n) { return n.guild_id === S.key; })[0] || S.networks[0];
    return net ? serverOf((S.profile && S.profile.user_id) || '') || String(net.homeserver || '')
      .replace(/^https?:\/\//, '').split('/')[0] : '';
  }
  function hubServer() {
    var home = mine(), count = {};
    S.rooms.forEach(function (r) {
      if (!r.joined || r.section === 'direct') return;
      var sv = serverOf(r.room_id);
      if (!sv || sv === home) return;
      count[sv] = (count[sv] || 0) + 1;
    });
    var best = null;
    Object.keys(count).forEach(function (sv) { if (!best || count[sv] > count[best]) best = sv; });
    // One stray federated room is not a community hub.
    return best && count[best] >= 2 ? best : null;
  }
  /* "Hub" · "Guild" · "Galaxy" — what a room's server MEANS, rather than
   * whether it happens to be yours. */
  function placeOf(r) {
    if (r.section === 'direct') return 'direct';
    var sv = serverOf(r.room_id), home = mine(), hub = hubServer();
    if (hub && sv === hub) return 'hub';
    if (sv && home && sv === home) return 'guild';
    return 'galaxy';
  }

  var GROUPS = [
    { key: 'invited', label: 'Invited', icon: 'icon-incoming' },
    { key: 'pinned', label: 'Pinned', icon: 'icon-beacon' },
    { key: 'waiting', label: 'Waiting', icon: 'icon-alert' },
    { key: 'quiet', label: 'Quiet', icon: 'icon-okay', collapsed: true },
  ];
  function sectionOf(r) {
    if (r.invited) return 'invited';
    if (isPinned(r.room_id) || r.home_rank != null) return 'pinned';
    if (!r.muted && (r.unread || r.mention)) return 'waiting';
    return 'quiet';
  }
  /* The room list a card draws. `only` still narrows to one PLACE (people,
   * hub, guild, galaxy) — that is a different axis from the grouping, and
   * both are useful. */
  function sections(opts) {
    opts = opts || {};
    var out = [];
    GROUPS.forEach(function (g) {
      var rows = S.rooms.filter(function (r) {
        if (sectionOf(r) !== g.key) return false;
        /* An invite is the most waiting thing there is, so it survives the
         * unread filter — but not a filter that ASKED for one place. */
        if (g.key === 'invited') return !opts.only || opts.only === 'all';
        if (!r.joined) return false;
        if (opts.only && opts.only !== 'all' && placeOf(r) !== opts.only) return false;
        if (opts.unreadOnly && !r.unread && !r.mention) return false;
        if (opts.query && !matches(r, opts.query)) return false;
        return true;
      });
      if (g.key === 'waiting') {
        // Worst first: named you, then loudest, then most recent.
        rows.sort(function (a, b) {
          return (b.mention ? 1 : 0) - (a.mention ? 1 : 0) || (b.unread || 0) - (a.unread || 0);
        });
      }
      if (rows.length) out.push({ section: g, rooms: rows });
    });
    return out;
  }

  /* Does this room answer to that word? Name, alias, topic, and the player a
   * DM is with — so "the one with Beezhan in it" is reachable by typing
   * Beezhan, which is how people actually remember a conversation. */
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
        var found = (String(asked).charAt(0) === '!' && roomById(asked))
          || roomById(told) || roomById(asked);
        if (found) return found;
        /* Not in the list after a refresh. That is either a room the server
         * has only just made (an object room, one sync behind) or a join that
         * did not produce one we can see — and the two are told apart by
         * whether the server named a room at all.
         *
         * It used to fabricate `{ room_id: told || asked, name: asked }` for
         * both, which meant `ROOM #nope-not-real` opened an empty room called
         * "#nope-not-real" that had never existed. A room we cannot see is not
         * an empty room; naming it after what was TYPED is inventing one. */
        if (!told) return Promise.reject('no room for “' + asked + '” — nothing joined');
        return { room_id: told, name: told, joined: true, unknown: true };
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
  /* Every homeserver a player could browse: their own, and every other guild's
   * that publishes one. Read once per session — a guild standing up a
   * homeserver is not a thing that happens while you are looking at a card. */
  var serversCache = null;
  function servers() {
    if (serversCache) return Promise.resolve(serversCache);
    return invoke('matrix_servers', {}).then(function (d) {
      serversCache = (d && d.servers) || [];
      return serversCache;
    }).catch(function () { return []; });
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

  /* Who is in a room, so a name can become a mention.
   *
   * `m.mentions` is what makes being NAMED exact on the receiving side — and
   * it is what sets the server's highlight count, which is the "YOU" badge in
   * the room list. Without it a message saying someone's name is just traffic
   * to them, and the one row in Comms that should interrupt never does.
   *
   * Cached per room: membership changes far more slowly than a keystroke. */
  function members(roomId) {
    if (!S.key || !roomId) return Promise.resolve([]);
    if (S.members[roomId]) return Promise.resolve(S.members[roomId]);
    return invoke('matrix_members', { guildId: S.key, roomId: roomId }).then(function (d) {
      var list = (d && (d.members || d.people)) || (Array.isArray(d) ? d : []);
      S.members[roomId] = list;
      return list;
    }).catch(function () { return []; });
  }

  /* `@Name` runs in a body that resolve to real people in THIS room. Longest
   * name first, so `@T.Xue` is not matched as `@T`, and a boundary after the
   * name so `@Net` does not match inside `@Netlag` — the same id-prefix trap
   * that has bitten this codebase before, in a different alphabet. */
  function mentionsIn(roomId, body) {
    var list = S.members[roomId] || [];
    var lower = String(body || '').toLowerCase();
    if (lower.indexOf('@') < 0 || !list.length) return [];
    var out = [];
    list.slice().sort(function (a, b) {
      return String(b.name || '').length - String(a.name || '').length;
    }).forEach(function (p) {
      var key = String(p.name || '').toLowerCase();
      if (!key) return;
      var at = lower.indexOf('@' + key);
      if (at < 0) return;
      var after = lower.charAt(at + key.length + 1);
      if (after && /[a-z0-9_.-]/.test(after)) return;
      var uid = p.user_id || p.userId;
      if (uid && !out.some(function (m) { return m.user_id === uid; })) {
        out.push({ user_id: uid, name: p.name, player_id: p.player_id || p.playerId });
      }
    });
    return out;
  }

  /* The names a half-typed `@…` could mean, for the composer's completion.
   * Prefix first, then anywhere — typing three letters of somebody's name
   * should reach them whether or not you started at the beginning. */
  function mentionOptions(roomId, partial) {
    var list = S.members[roomId] || [];
    var t = String(partial || '').toLowerCase();
    var starts = [], has = [];
    list.forEach(function (p) {
      var n = String(p.name || '').toLowerCase();
      if (!n) return;
      if (n.indexOf(t) === 0) starts.push(p);
      else if (t && n.indexOf(t) > 0) has.push(p);
    });
    return starts.concat(has).slice(0, 8);
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
  /* `replyTo` is a MESSAGE, not an event id.
   *
   * Rust takes `Option<ReplyTarget> { event_id, sender, body }` and builds the
   * rich-reply fallback from all three — the quote line every other Matrix
   * client shows above a reply. Handing it a bare string was a shape it cannot
   * deserialise, so the whole send failed: replying did nothing at all.
   *
   * `mentions` is `m.mentions`, which is how being named is EXACT rather than
   * a word-boundary guess on the receiving side — and how the server's
   * highlight count (the "YOU" badge in the room list) gets set at all. */
  /* ── Local echo, drafts, pins ─────────────────────────────────────────
   *
   * A message you sent appears the instant you send it, dimmed, and then
   * confirms or fails. Waiting for the round trip made the composer feel
   * broken on a slow homeserver, and a send that FAILED simply vanished —
   * there was no message, no error, nothing to retry.
   *
   * The echo carries a local id (`~1`), which is not a server id (`$…`) — the
   * read-marker code already refuses anything not starting `$`, so an echo can
   * never be mistaken for something the server knows about. */
  var echoSeq = 0;
  function echo(roomId, body, replyTo) {
    var id = '~' + (++echoSeq);
    var m = {
      event_id: id, sender: S.profile && S.profile.user_id || 'me',
      sender_name: (S.profile && S.profile.display_name) || 'you',
      body: String(body), kind: 'text', ts: Date.now(), pending: true,
    };
    m['self'] = true;
    if (replyTo) {
      m.reply_to = replyTo.event_id;
      m.reply_sender = replyTo.sender_name || replyTo.sender;
      m.reply_excerpt = String(replyTo.body || '').slice(0, 80);
    }
    (S.timelines[roomId] = S.timelines[roomId] || []).push(m);
    announce('timeline:' + roomId);
    return m;
  }
  /* Sync brings the real message back with a server id, so the echo has to go
   * — matched on body and sender, because a local id has no relationship to
   * the server's. Kept simple deliberately: the worst case is one duplicate
   * line for a few seconds, and the alternative (a correlation id round trip)
   * is a protocol we do not control. */
  function settleEchoes(roomId, arrived) {
    var t = S.timelines[roomId];
    if (!t) return;
    arrived.forEach(function (real) {
      if (!real['self'] && !(S.profile && real.sender === S.profile.user_id)) return;
      var at = t.findIndex(function (m) {
        return m.pending && m.body === real.body;
      });
      if (at >= 0) t.splice(at, 1);
    });
  }

  /* What you typed and did not send, per room. Switching cards lost it. */
  function draft(roomId, text) {
    if (text === undefined) return S.drafts[roomId] || '';
    if (String(text || '').trim()) S.drafts[roomId] = text;
    else delete S.drafts[roomId];
    return text;
  }

  /* The room's pinned events — its noticeboard. `Room.pinned` carries the ids
   * and nothing else; the events themselves are fetched on demand. */
  function pinned(roomId) {
    if (!S.key || !roomId) return Promise.resolve([]);
    if (S.pinned[roomId]) return Promise.resolve(S.pinned[roomId]);
    return invoke('matrix_pinned', { guildId: S.key, roomId: roomId }).then(function (d) {
      var list = (d && (d.pinned || d.messages)) || (Array.isArray(d) ? d : []);
      S.pinned[roomId] = list;
      announce('pinned:' + roomId);
      return list;
    }).catch(function () { return []; });
  }
  function pin(roomId, eventId, on) {
    if (!S.key || !roomId) return Promise.resolve();
    return invoke('matrix_pin', { guildId: S.key, roomId: roomId, eventId: eventId, pin: !!on })
      .then(function () { delete S.pinned[roomId]; return pinned(roomId); });
  }
  function edit(roomId, eventId, body) {
    if (!S.key || !roomId) return Promise.resolve();
    return invoke('matrix_edit', { guildId: S.key, roomId: roomId, eventId: eventId, body: String(body) });
  }
  function leave(roomId) {
    if (!S.key || !roomId) return Promise.resolve();
    return invoke('matrix_leave', { guildId: S.key, roomId: roomId })
      .then(function () { return refreshRooms(true); });
  }

  function send(roomId, body, replyTo, mentions) {
    if (!S.key || !roomId || !String(body || '').trim()) return Promise.resolve(null);
    var args = { guildId: S.key, roomId: roomId, body: String(body) };
    if (replyTo && replyTo.event_id) {
      args.replyTo = {
        eventId: replyTo.event_id,
        sender: replyTo.sender || replyTo.sender_name || '',
        body: String(replyTo.body || ''),
      };
    }
    if (mentions && mentions.length) args.mentions = mentions;
    var mine = echo(roomId, body, replyTo);
    return invoke('matrix_send', args).then(function (r) {
      mine.pending = false;
      announce('timeline:' + roomId);
      return r;
    }, function (e) {
      /* A send that failed is a message you can SEE and retry. It used to be
       * nothing at all — the text left the box and never arrived anywhere. */
      mine.pending = false;
      mine.failed = String(e);
      mine.retry = { body: body, replyTo: replyTo, mentions: mentions };
      announce('timeline:' + roomId);
      throw e;
    });
  }
  function retry(roomId, m) {
    var t = S.timelines[roomId] || [];
    var at = t.indexOf(m);
    if (at >= 0) t.splice(at, 1);
    var r = m.retry || {};
    return send(roomId, r.body, r.replyTo, r.mentions);
  }
  /* A read marker names the EVENT you have read up to.
   *
   * `matrix_mark_read(guild_id, room_id, event_id)` — the event id is not
   * optional, and calling it without one failed every single time. That is why
   * unread counts never cleared: the badge is the server's, kept against the
   * receipts this app sends, and this app had never successfully sent one.
   *
   * A local echo has no server event id (Rust refuses anything not starting
   * `$`), so the newest REAL event is what we mark. */
  /* Where the "new messages" rule goes.
   *
   * Captured ONCE, when a room is opened, from the count the server was
   * carrying — because the moment we mark read that count becomes zero and the
   * answer is gone. Nothing else in the model can reconstruct it afterwards. */
  function anchorUnread(roomId) {
    if (S.lastRead[roomId] !== undefined) return;
    var r = roomById(roomId);
    var n = r ? Number(r.unread) || 0 : 0;
    var t = S.timelines[roomId] || [];
    // The message just BEFORE the unread run — the rule sits under it.
    S.lastRead[roomId] = (n > 0 && t.length > n) ? t[t.length - n - 1].event_id : null;
  }
  function unreadFrom(roomId) { return S.lastRead[roomId] || null; }
  function clearUnread(roomId) { S.lastRead[roomId] = null; announce('timeline:' + roomId); }

  function markRead(roomId) {
    if (!S.key || !roomId) return Promise.resolve();
    var t = S.timelines[roomId] || [];
    var last = null;
    for (var i = t.length - 1; i >= 0; i--) {
      if (String(t[i].event_id || '').charAt(0) === '$') { last = t[i].event_id; break; }
    }
    if (!last) return Promise.resolve();
    if (S.readAt[roomId] === last) return Promise.resolve();   // already told them
    S.readAt[roomId] = last;
    return invoke('matrix_mark_read', { guildId: S.key, roomId: roomId, eventId: last })
      .catch(function () { S.readAt[roomId] = null; });
  }
  function typing(roomId, on) {
    if (!S.key || !roomId) return Promise.resolve();
    return invoke('matrix_typing', { guildId: S.key, roomId: roomId, typing: !!on }).catch(function () {});
  }

  window.BoardComms = {
    S: S, watch: watch, announce: announce,
    status: status, connect: connect, disconnect: disconnect,
    rooms: refreshRooms, roomById: roomById, sections: sections,
    sectionOf: sectionOf, matches: matches, waiting: waiting, GROUPS: GROUPS,
    placeOf: placeOf, hubServer: hubServer, serverOf: serverOf,
    pins: pins, isPinned: isPinned, togglePin: togglePin,
    subjectKind: subjectKind, resolve: resolve, people: people, playerIdFor: playerIdFor,
    servers: servers,
    timeline: timeline, older: older, send: send, markRead: markRead, typing: typing,
    members: members, mentionsIn: mentionsIn, mentionOptions: mentionOptions,
    draft: draft, pinned: pinned, pin: pin, edit: edit, leave: leave, retry: retry,
    anchorUnread: anchorUnread, unreadFrom: unreadFrom, clearUnread: clearUnread,
  };
})();
