// STRUCTS TERMINAL — Comms, as cards.
//
// Four cards over one model (board-comms.js), each answering ONE question,
// because the window this replaces answered all of them in the same box and
// you had to navigate to find out which:
//
//   COMMS      where am I, and what is waiting          — the room list
//   ROOM       one conversation                          — timeline + composer
//   CHANNELS   what else is there                        — the directory
//   WHO        who is in this room                       — members + presence
//
// The split is the point. A board can hold two ROOM cards side by side, a
// COMMS list beside them and the directory open underneath — which is what a
// person managing several conversations actually wants, and what a single
// embedded window structurally cannot do.
//
// Everything here reaches its subject through the command line as well as
// through a door, because `resolve()` makes a room a subject like any other:
//
//   ROOM 1-61        ROOM JPEG        ROOM #trade      ROOM 2-15361
//
// Loaded after board-terminal.js and board-comms.js; registers into
// Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var C = window.BoardComms;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };
  var add = function (type, params, w) { return T.add(type, params, w); };
  var icon = function (name, size) { return H.el('i', 'sui-icon ' + (size || 'sui-icon-sm') + ' ' + name); };
  var cap = function (host, text) { var c = H.el('div', 'tm-cap'); c.appendChild(H.el('span', 'fstat-l', text)); host.appendChild(c); return c; };

  /* Nothing renders before we know whether Comms is even connected — and
   * "not connected" is a STATE with an action, not an error. Every card in
   * this file opens with this, so the answer is the same everywhere. */
  function gate(host, onReady) {
    return C.status().then(function (S) {
      if (!S.networks.length) {
        host.innerHTML = '';
        host.appendChild(H.stateBlock('info', 'This guild publishes no Comms homeserver.'));
        return;
      }
      if (!S.connected) { host.innerHTML = ''; host.appendChild(signIn()); return; }
      return onReady(S);
    });
  }

  /* The sign-in ladder. Six hops across three services, so when it breaks the
   * useful question is WHICH hop — the same reasoning the Comms window's
   * Connection page was built on, kept because it is right. */
  var STEP_ICON = { done: 'icon-success', active: 'icon-in-progress', failed: 'icon-alert', todo: 'icon-unknown' };
  function signIn() {
    var S = C.S;
    var box = H.el('div', 'cm-signin');
    var net = S.networks[0] || {};
    box.appendChild(H.stateBlock(S.error ? 'error' : 'info',
      S.error ? String(S.error)
        : S.connecting ? 'Signing in to ' + (net.guild_name || net.homeserver || 'Comms') + '…'
        : 'Not signed in to ' + (net.guild_name || net.homeserver || 'Comms') + '.'));
    if (S.steps && S.steps.length) {
      var ladder = H.el('div', 'cm-ladder');
      S.steps.forEach(function (st) {
        var row = H.el('div', 'cm-step cm-mod-' + (st.state || 'todo'));
        row.appendChild(icon(STEP_ICON[st.state] || STEP_ICON.todo));
        var text = H.el('div', 'cm-step-text');
        text.appendChild(H.el('div', null, st.label));
        if (st.detail) text.appendChild(H.el('div', 'fstat-l', st.detail));
        row.appendChild(text);
        ladder.appendChild(row);
      });
      box.appendChild(ladder);
    }
    var a = H.el('a', 'sui-screen-btn sui-mod-primary', S.connecting ? 'Signing in…' : 'Sign in');
    a.href = 'javascript:void(0)';
    if (!S.connecting) a.addEventListener('click', function () { C.connect().catch(function () {}); });
    box.appendChild(a);
    return box;
  }

  /* One room, as a row. The same shape in every list — the room list, the
   * directory, the ⌘K results — so a channel is recognisable wherever it is
   * standing. What differs is what the row can DO, which arrives in `opts`. */
  function roomRow(r, opts) {
    opts = opts || {};
    var row = H.el('div', 'cm-room' + (r.mention ? ' is-mention' : '') + (r.unread ? ' is-unread' : '')
      + (r.muted ? ' is-muted' : '') + (opts.active ? ' is-active' : ''));

    var face = H.el('div', 'cm-room-face');
    if (r.player_id && H.pfpPortrait) face.appendChild(H.pfpPortrait(r.pfp_attrs));
    else face.appendChild(icon(r.icon || 'icon-guild'));
    row.appendChild(face);

    var mid = H.el('div', 'cm-room-mid');
    var title = H.el('div', 'cm-room-title');
    title.appendChild(H.el('span', 'cm-room-name', r.name || r.canonical_alias || r.room_id));
    /* Encryption is stated once, at the top, rather than line by line: this
     * client has no crypto, so an encrypted room is one whose messages we
     * cannot read at all. Silently showing an empty room would be worse. */
    if (r.encrypted) title.appendChild(H.el('span', 'sui-badge sui-mod-warning', 'ENCRYPTED'));
    if (r.muted) title.appendChild(icon('icon-disabled', 'sui-icon-sm'));
    mid.appendChild(title);
    var sub = String(r.topic || r.canonical_alias || '');
    if (r.invited) sub = 'invited' + (r.invited_by ? ' by ' + r.invited_by : '');
    if (sub) mid.appendChild(H.el('div', 'cm-room-sub fstat-l', sub));
    /* A room that has been UPGRADED is still joinable and still in the list,
     * so without following the pointer a player goes on talking into a room
     * everybody else has left. */
    if (r.replaced_by) {
      var moved = H.el('a', 'cm-room-moved fstat-l', 'moved — open the new room');
      moved.href = 'javascript:void(0)';
      moved.addEventListener('click', function (e) { e.stopPropagation(); add('room', { id: r.replaced_by }); });
      mid.appendChild(moved);
    }
    row.appendChild(mid);

    var right = H.el('div', 'cm-room-right');
    if (r.invited) {
      var yes = H.el('a', 'sui-screen-btn sui-mod-primary', 'Join');
      yes.href = 'javascript:void(0)';
      yes.addEventListener('click', function (e) {
        e.stopPropagation();
        invoke('matrix_join', { guildId: C.S.key, roomId: r.room_id })
          .then(function () { return C.rooms(true); })
          .catch(function (err) { Board.stamp && Board.stamp('join: ' + err); });
      });
      right.appendChild(yes);
      var no = H.el('a', 'sui-screen-btn sui-mod-secondary', 'Decline');
      no.href = 'javascript:void(0)';
      no.addEventListener('click', function (e) {
        e.stopPropagation();
        invoke('matrix_leave', { guildId: C.S.key, roomId: r.room_id }).then(function () { return C.rooms(true); });
      });
      right.appendChild(no);
    } else if (r.mention) {
      /* Being NAMED is not the same as traffic. A count of 40 hides the one
       * message that was actually for you, so the mention takes the badge and
       * the count stands beside it. */
      right.appendChild(H.el('span', 'sui-badge sui-mod-destructive', 'YOU'));
      if (r.unread) right.appendChild(H.el('span', 'cm-room-n', H.fmtInt(r.unread)));
    } else if (r.unread) {
      right.appendChild(H.el('span', 'cm-room-n' + (r.muted ? ' is-muted' : ''), H.fmtInt(r.unread)));
    }
    row.appendChild(right);

    if (opts.onOpen) {
      row.classList.add('is-clickable');
      row.addEventListener('click', function () { opts.onOpen(r); });
    }
    return row;
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMMS — where am I, and what is waiting
  // ══════════════════════════════════════════════════════════════════════
  var SHOW = [
    { value: 'all', label: 'everything' },
    { value: 'direct', label: 'people' },
    { value: 'local', label: 'guild' },
    { value: 'galaxy', label: 'galaxy' },
    { value: 'unread', label: 'unread only' },
  ];
  T.register('comms', {
    label: 'Comms', defaultWidth: 1, single: true, defaultHeight: 'grow',
    describe: function (p) {
      var s = SHOW.filter(function (x) { return x.value === (p.show || 'all'); })[0];
      return 'Comms' + (s && s.value !== 'all' ? ' · ' + s.label : '');
    },
    params: [{ key: 'show', label: 'Show', kind: 'choice', options: SHOW }],
    cadenceMs: 30000,
    doors: function () {
      var S = C.S;
      var doors = [
        { icon: 'icon-guild-directory', title: 'Browse channels', onClick: function () { add('channels', {}); } },
        { icon: 'icon-member', title: 'Message a player', onClick: function () { T.openPalette('ROOM '); } },
        { icon: 'icon-detected', title: 'Find something that was said', onClick: function () { T.openPalette('FIND '); } },
      ];
      return doors;
    },
    render: function (host, p) {
      var only = p.show === 'unread' ? 'all' : (p.show || 'all');
      var unreadOnly = p.show === 'unread';

      var draw = function () {
        if (!host.isConnected) return;
        var S = C.S;
        if (!S.connected) { host.innerHTML = ''; host.appendChild(signIn()); return; }
        host.innerHTML = '';

        /* State, said once, at the top: WHO you are speaking as, on which
         * homeserver, and what is waiting — all three of which used to mean
         * navigating a window to find out. Sign-out stands here rather than
         * as a fifth door, because a door is a tooltip and this is the one
         * control a person looks for by reading. */
        var w = C.waiting();
        var net = S.networks.filter(function (n) { return n.guild_id === S.key; })[0] || {};
        var strip = H.el('div', 'tm-cap cm-me');
        strip.appendChild(H.el('span', 'fstat-l',
          ((S.profile && S.profile.display_name) || 'signed in')
          + ' · ' + (net.guild_name || net.homeserver || '?')
          + ' · ' + (w.invites ? H.fmtInt(w.invites) + ' invite' + (w.invites === 1 ? '' : 's') + ' waiting'
            : w.mention ? H.fmtInt(w.mention) + ' room' + (w.mention === 1 ? '' : 's') + ' named you'
            : w.unread ? H.fmtInt(w.unread) + ' unread'
            : 'nothing waiting')));
        var out = H.el('a', 'cm-signout fstat-l', 'sign out');
        out.href = 'javascript:void(0)';
        out.addEventListener('click', function () { C.disconnect(); });
        strip.appendChild(out);
        host.appendChild(strip);

        var groups = C.sections({ only: only, unreadOnly: unreadOnly });
        if (!groups.length) {
          host.appendChild(H.stateBlock('info', unreadOnly ? 'Nothing unread.'
            : only === 'all' ? 'No rooms yet — browse the channels or message a player.'
            : 'No rooms in ' + only + '.'));
          return;
        }
        groups.forEach(function (g) {
          var head = H.el('div', 'cm-sec');
          head.appendChild(icon(g.section.icon));
          head.appendChild(H.el('span', 'fstat-l', g.section.label));
          head.appendChild(H.el('span', 'cm-sec-n fstat-l', H.fmtInt(g.rooms.length)));
          host.appendChild(head);
          g.rooms.forEach(function (r) {
            host.appendChild(roomRow(r, { onOpen: function () { add('room', { id: r.room_id }); } }));
          });
        });
      };

      C.watch(host, function (what) { if (what === 'rooms' || what === 'status' || what === 'seen') draw(); });
      return gate(host, function () { return C.rooms().then(draw); });
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // ROOM — one conversation
  // ══════════════════════════════════════════════════════════════════════
  //
  // The card that makes the rebuild worth doing. Two of them side by side is
  // two conversations; the embedded window could only ever be one.
  /* The game inside the conversation.
   *
   * "shield on 2-15361 is down" names an object, and the object is the point
   * of the sentence. `ChatRefs` already turns an id into the game's own
   * planet / player / guild / provider card — the same card the Explore board
   * draws — and the Terminal already wires it (`Terminal.ensureRefs`). So a
   * message that names something shows it, and every id in the line is a chip
   * that opens it.
   *
   * Only the FIRST reference expands on its own: a message naming four objects
   * would otherwise bury itself under four cards, and the point of a summary
   * is to be an aside. */
  var ID_IN_TEXT = /(?:^|[^0-9A-Za-z_-])(\d{1,2}-\d{1,9})(?![0-9-])/g;
  function idsIn(text) {
    var out = [], seen = {}, m;
    ID_IN_TEXT.lastIndex = 0;
    while ((m = ID_IN_TEXT.exec(String(text || '')))) {
      if (!seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); }
    }
    return out;
  }
  function refsUnder(node, m) {
    var ids = idsIn(m.body);
    if (!ids.length) return;
    var R = T.ensureRefs();
    if (!R) return;
    R.wantRefs(ids);
    var first = R.cards[ids[0]];
    if (first) node.appendChild(R.refCard(first));
    var rest = ids.slice(first ? 1 : 0);
    if (!rest.length) return;
    var strip = H.el('div', 'cm-refs');
    rest.forEach(function (id) {
      var chip = H.el('a', 'sui-badge cm-ref', id);
      chip.href = 'javascript:void(0)';
      chip.title = 'Open ' + id;
      chip.addEventListener('click', function () {
        var k = Number(String(id).split('-')[0]);
        add(k === 1 ? 'player' : k === 0 ? 'guild' : k === 2 ? 'planet' : k === 9 ? 'map' : 'inspector', { id: id });
      });
      strip.appendChild(chip);
    });
    node.appendChild(strip);
  }

  T.register('room', {
    label: 'Conversation', defaultWidth: 1, defaultHeight: 'grow', cadenceMs: 0, usesRefs: true,
    describe: function (p) {
      var r = p.id && C.roomById(p.id);
      return r ? r.name : ('Room · ' + (p.id || '?'));
    },
    /* `kinds: [1, 2, 9]` so the palette resolves a player, planet or fleet id
     * into this card the same way it does for the planet viewer — and `text`
     * because a room id, an alias and a username are none of those. */
    /* `kind: 'id'` with `kinds: [1, 2, 9]` is what makes a player, a planet or
     * a fleet OFFER this card in the subject-first menu and in ⌘K's search
     * results. The word itself parses as `optid`, so the box also takes the
     * things that are not object ids at all — `#trade`, `JPEG`, a raw room id. */
    params: [{ key: 'id', label: 'Room, player or object', kind: 'id', kinds: [1, 2, 9],
               placeholder: '#trade · 1-61 · JPEG · 2-15361' }],
    doors: function (card) {
      var id = (card.params || {}).id;
      var r = id && C.roomById(id);
      var doors = [];
      if (r) {
        doors.push({ icon: 'icon-member', title: 'Who is in here', onClick: function () { add('who', { id: r.room_id }); } });
        doors.push({ icon: r.muted ? 'icon-okay' : 'icon-disabled', title: r.muted ? 'Unmute' : 'Mute',
          onClick: function () { invoke('matrix_mute', { guildId: C.S.key, roomId: r.room_id, muted: !r.muted }).then(function () { return C.rooms(true); }); } });
        if (r.player_id) doors.push({ icon: 'icon-planet', title: 'Open ' + r.player_id, onClick: function () { add('player', { id: r.player_id }); } });
      }
      return doors;
    },
    render: function (host, p, ctx) {
      if (!p.id) {
        host.innerHTML = '';
        host.appendChild(H.stateBlock('info', 'Name a room, a player or an object — #trade, 1-61, JPEG, 2-15361.'));
        return;
      }
      var state = { room: null, replyTo: null };

      var draw = function () {
        if (!host.isConnected || !state.room) return;
        var rid = state.room.room_id;
        host.innerHTML = '';

        var r = C.roomById(rid) || state.room;
        /* A room the joined list does not have. It is real — the server named
         * it — but we know its id and nothing else, so the card says which
         * state it is in rather than drawing an empty conversation that looks
         * settled. */
        if (r.unknown) {
          host.appendChild(H.stateBlock('info',
            'Joined ' + r.room_id + ', but it has not come back in a sync yet.'));
        }
        if (r.encrypted) {
          host.appendChild(H.stateBlock('error',
            'This room is end-to-end encrypted and this client has no crypto — nothing sent here can be read.'));
        }
        if (r.replaced_by) {
          var moved = H.stateBlock('info', 'This room has been upgraded; the conversation continues elsewhere.');
          var go = H.el('a', 'sui-screen-btn sui-mod-primary', 'Open the new room');
          go.href = 'javascript:void(0)';
          go.addEventListener('click', function () { add('room', { id: r.replaced_by }); });
          moved.appendChild(go);
          host.appendChild(moved);
        }

        var scroller = H.el('div', 'cm-timeline');
        var msgs = C.S.timelines[rid] || [];
        if (!msgs.length) {
          scroller.appendChild(H.el('div', 'ops-muted', 'Nothing said here yet.'));
        } else {
          /* Older messages are FETCHED, not faked: a room shows what it has
           * and offers to go back, rather than pretending the top of the
           * cache is the beginning of the conversation. */
          var back = H.el('a', 'cm-older fstat-l', 'earlier messages');
          back.href = 'javascript:void(0)';
          back.addEventListener('click', function () {
            back.textContent = 'reading…';
            C.older(rid).then(function (n) { if (!n) back.textContent = 'that is the beginning'; });
          });
          scroller.appendChild(back);
          var prev = null;
          msgs.forEach(function (m) {
            /* Head and body from the SHARED row (chatrow.js). The body used to
             * be each window's own `chat-msg-body` — three of them, drifting —
             * so it lives there now and this card only says what it wants
             * DONE with a message. */
            var node = window.StructsChatRow.render(m, prev, {
              onSender: m.player_id ? function () { add('player', { id: m.player_id }); } : null,
              controls: function (m2, meta) { controls(rid, m2, meta, state); },
            });
            var b = window.StructsChatRow.body(m, {
              onJump: function (eid) {
                var at = scroller.querySelector('[data-event="' + eid + '"]');
                if (at) at.scrollIntoView({ block: 'center' });
              },
              onReact: function (key, mine) {
                invoke(mine ? 'matrix_redact' : 'matrix_react',
                  mine ? { guildId: C.S.key, roomId: rid, eventId: m.event_id }
                       : { guildId: C.S.key, roomId: rid, eventId: m.event_id, key: key })
                  .catch(function (e) { Board.stamp && Board.stamp('react: ' + e); });
              },
            });
            if (b) node.appendChild(b);
            refsUnder(node, m);
            scroller.appendChild(node);
            prev = m;
          });
        }
        host.appendChild(scroller);
        // A live room scrolls itself; a room you are reading back does not
        // get yanked to the bottom under your eyes.
        if (state.atBottom !== false) scroller.scrollTop = scroller.scrollHeight;
        scroller.addEventListener('scroll', function () {
          state.atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        });

        var who = (C.S.typing[rid] || []).length;
        if (who) host.appendChild(H.el('div', 'cm-typing fstat-l', who === 1 ? 'someone is typing…' : who + ' people are typing…'));

        if (state.replyTo) {
          var q = H.el('div', 'cm-replying fstat-l');
          q.appendChild(H.el('span', null, 'replying to ' + (state.replyTo.sender_name || '') + ': '
            + String(state.replyTo.body || '').slice(0, 60)));
          var x = H.el('a', 'cm-x', '×');
          x.href = 'javascript:void(0)';
          x.addEventListener('click', function () { state.replyTo = null; draw(); });
          q.appendChild(x);
          host.appendChild(q);
        }

        /* The SHARED composer (chatrow.js) — the same panel the Comms window
         * and the raid rail draw, third consumer. It hands back its parts and
         * the host wires them; that is why the rail can have a charge battery
         * and this cannot, without either growing a copy of the other. */
        var made = window.StructsChatRow.composer({
          pfpAttrs: C.S.profile && C.S.profile.pfp_attrs,
          placeholder: 'Message ' + (r.name || ''),
        });
        var submit = function () {
          var text = made.input.value;
          if (!String(text || '').trim()) return;
          var reply = state.replyTo ? state.replyTo.event_id : null;
          made.input.value = '';
          state.replyTo = null;
          state.atBottom = true;
          if (state.stopTyping) state.stopTyping();
          C.send(rid, text, reply).catch(function (e) { Board.stamp && Board.stamp('send: ' + e); });
        };
        made.input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
          /* Escape drops the reply FIRST, and only then belongs to anything
           * outside — the usual innermost-thing-first rule. Without the stop,
           * one Escape both cleared the reply and closed the palette. */
          if (e.key === 'Escape' && state.replyTo) {
            e.preventDefault(); e.stopPropagation();
            state.replyTo = null; draw();
          }
        });
        /* Typing is a claim with an END. This told the server `true` every four
         * seconds and `false` never — so every keystroke left you "typing" in
         * everyone else's client until their timeout expired, including after
         * you gave up and closed the box. Say it once, and stop saying it. */
        var typingAt = 0, typingOff = null;
        var stopTyping = function () {
          if (typingOff) { clearTimeout(typingOff); typingOff = null; }
          if (typingAt) { typingAt = 0; C.typing(rid, false); }
        };
        made.input.addEventListener('input', function () {
          if (!String(made.input.value || '').trim()) { stopTyping(); return; }
          var now = Date.now();
          if (now - typingAt > 4000) { typingAt = now; C.typing(rid, true); }
          if (typingOff) clearTimeout(typingOff);
          typingOff = setTimeout(stopTyping, 5000);
        });
        made.input.addEventListener('blur', stopTyping);
        state.stopTyping = stopTyping;
        made.send.addEventListener('click', submit);
        host.appendChild(made.node);
        if (state.focus) { made.input.focus(); state.focus = false; }
      };

      C.watch(host, function (what) {
        if (!state.room) return;
        /* A message arriving in the room you are LOOKING AT is a message you
         * have read. This marked read once, on mount, so the badge on a room
         * you were staring at climbed all evening and only cleared if you
         * reopened the card. The receipt is what the server counts against. */
        if (what === 'timeline:' + state.room.room_id) C.markRead(state.room.room_id);
        if (what === 'timeline:' + state.room.room_id || what === 'typing:' + state.room.room_id
          || what === 'rooms' || what === 'status') draw();
      });

      return gate(host, function () {
        return C.resolve(p.id).then(function (room) {
          state.room = room;
          /* The header said `!snc:h` because that is all the card knew when
           * `describe()` ran. It knows the room's name now. */
          T.retitle(ctx.id, room.name || room.canonical_alias || room.room_id);
          // Looking at a room IS reading it — the unread badge is the
          // server's, kept against the receipts this app sends.
          C.markRead(room.room_id);
          return C.timeline(room.room_id).then(draw);
        }).catch(function (e) {
          host.innerHTML = '';
          host.appendChild(H.stateBlock('error', String(e)));
        });
      });
    },
  });

  /* What a message row can do here: react, reply, and — for your own — edit
   * and delete. The raid rail renders the same row with none of this, which
   * is why the controls arrive as a callback rather than living in the row. */
  function controls(rid, m, meta, state) {
    var act = function (glyph, title, fn) {
      var a = H.el('a', 'cm-msg-act');
      a.href = 'javascript:void(0)';
      a.title = title;
      a.appendChild(icon(glyph));
      a.addEventListener('click', fn);
      meta.appendChild(a);
      return a;
    };
    act('icon-tip', 'React', function () {
      invoke('matrix_react', { guildId: C.S.key, roomId: rid, eventId: m.event_id, key: '👍' })
        .catch(function (e) { Board.stamp && Board.stamp('react: ' + e); });
    });
    act('icon-incoming', 'Reply', function () { state.replyTo = m; C.announce('timeline:' + rid); });
    if (m['self']) {
      act('icon-close', 'Delete', function () {
        invoke('matrix_redact', { guildId: C.S.key, roomId: rid, eventId: m.event_id })
          .catch(function (e) { Board.stamp && Board.stamp('delete: ' + e); });
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // CHANNELS — what else is there
  // ══════════════════════════════════════════════════════════════════════
  //
  // Separate from the room list on purpose. "Where am I" and "what else is
  // there" are two questions, and the window that answered both in one list
  // is why joining a channel meant scrolling past the ones you were in.
  T.register('channels', {
    label: 'Channel directory', defaultWidth: 1, single: true, defaultHeight: 'grow',
    describe: function (p) {
      return 'Channels' + (p.server ? ' · ' + p.server : '') + (p.q ? ' · ' + p.q : '');
    },
    params: [
      { key: 'q', label: 'Search', kind: 'text', placeholder: 'trade, war, help…' },
      { key: 'server', label: 'Homeserver', kind: 'text', placeholder: 'yours' },
    ],
    cadenceMs: 120000,
    render: function (host, p, ctx) {
      var ctxId = ctx.id;
      var draw = function (list, servers) {
        if (!host.isConnected) return;
        host.innerHTML = '';

        /* WHICH homeserver's directory this is.
         *
         * Comms is decentralised — every guild runs its own — but the
         * community meets in channels published by ONE of them. A directory
         * that only ever answers for your own guild's server showed a new
         * player their own guild's rooms and left the place everybody actually
         * talks undiscoverable: you had to be told an alias. Federation
         * already carried the join; only discovery stopped at the boundary.
         *
         * The list comes from the guild configs the app discovers on chain, so
         * a guild that stands up a homeserver appears here without anything
         * being typed anywhere. */
        if ((servers || []).length > 1) {
          var strip = H.el('div', 'cm-servers');
          servers.forEach(function (sv) {
            var here = p.server ? sv.server === p.server : sv.mine;
            var a = H.el('a', 'sui-badge cm-server' + (here ? ' is-here' : ''),
              (sv.tag || sv.name || sv.server) + (sv.mine ? ' · yours' : ''));
            a.href = 'javascript:void(0)';
            a.title = sv.server;
            a.addEventListener('click', function () {
              T.setParams(ctxId, { q: p.q || '', server: sv.mine ? '' : sv.server });
            });
            strip.appendChild(a);
          });
          host.appendChild(strip);
        }

        var joined = {};
        C.S.rooms.forEach(function (r) { if (r.joined) joined[r.room_id] = 1; });
        var rows = (list || []).filter(function (r) { return !joined[r.room_id]; });
        cap(host, rows.length ? H.fmtInt(rows.length) + ' to join · ' + H.fmtInt(Object.keys(joined).length) + ' already in'
          : 'nothing here you are not already in');
        rows.forEach(function (r) {
          host.appendChild(roomRow(r, {
            onOpen: function () { add('room', { id: r.canonical_alias || r.room_id }); },
          }));
        });
      };
      return gate(host, function () {
        /* The joined list FIRST. "What else is there" is defined against what
         * you already have, and a directory drawn before sync landed offers
         * you every room you are standing in. */
        return C.rooms().then(function () {
          return Promise.all([
            invoke('matrix_browse', { guildId: C.S.key, query: p.q || null, server: p.server || null }),
            C.servers(),
          ]);
        })
          .then(function (r) { draw((r[0] && (r[0].rooms || r[0].chunk)) || [], r[1]); })
          .catch(function (e) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', String(e))); });
      });
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // FIND — something that was said
  // ══════════════════════════════════════════════════════════════════════
  //
  // The HOMESERVER does the searching. A client that filters its own cache can
  // only find what it has already fetched, which for a busy channel is the
  // last few minutes — and "where did somebody post that trade" is never
  // about the last few minutes.
  T.register('find', {
    label: 'Search Comms', defaultWidth: 1, defaultHeight: 'grow',
    describe: function (p) { return p.q ? 'Find · ' + p.q : 'Find in Comms'; },
    params: [
      { key: 'q', label: 'Words', kind: 'text', placeholder: 'shield, 2-15361, ore…' },
      { key: 'room', label: 'In room', kind: 'text', placeholder: 'everywhere' },
    ],
    cadenceMs: 0,
    render: function (host, p) {
      if (!p.q) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Type what was said.')); return; }
      return gate(host, function () {
        var run = function (roomId) {
          return invoke('matrix_search', { guildId: C.S.key, query: p.q, roomId: roomId || null });
        };
        var go = p.room ? C.resolve(p.room).then(function (r) { return run(r.room_id); }) : run(null);
        return go.then(function (d) {
          var hits = (d && d.hits) || [];
          host.innerHTML = '';
          cap(host, hits.length ? H.fmtInt(hits.length) + ' found' + (p.room ? ' in ' + p.room : ' across every room you are in')
            : 'nothing said that, anywhere you can read');
          var prev = null;
          hits.forEach(function (h) {
            var m = h.message || h;
            var wrap = H.el('div', 'cm-hit');
            /* Which ROOM it was said in is the whole answer when the search
             * spans every room — a hit with no room is a quote from nowhere. */
            var where = H.el('a', 'cm-hit-room fstat-l', h.room_name || h.room_id || '');
            where.href = 'javascript:void(0)';
            where.addEventListener('click', function () { add('room', { id: h.room_id }); });
            wrap.appendChild(where);
            var node = window.StructsChatRow.render(m, prev, {});
            var b = window.StructsChatRow.body(m, {});
            if (b) node.appendChild(b);
            wrap.appendChild(node);
            host.appendChild(wrap);
          });
        }).catch(function (e) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', String(e))); });
      });
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // WHO — who is in this room
  // ══════════════════════════════════════════════════════════════════════
  T.register('who', {
    label: 'Room members', defaultWidth: 1, defaultHeight: 'grow',
    describe: function (p) { var r = p.id && C.roomById(p.id); return 'Who · ' + (r ? r.name : (p.id || '?')); },
    params: [{ key: 'id', label: 'Room', kind: 'id', kinds: [1, 2, 9], placeholder: '#trade · 1-61' }],
    cadenceMs: 60000,
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Name a room.')); return; }
      return gate(host, function () {
        return C.resolve(p.id).then(function (room) {
          return invoke('matrix_members', { guildId: C.S.key, roomId: room.room_id }).then(function (d) {
            var list = (d && (d.members || d.people)) || (Array.isArray(d) ? d : []);
            host.innerHTML = '';
            cap(host, H.fmtInt(list.length) + ' member' + (list.length === 1 ? '' : 's'));
            var table = H.resultTable();
            list.forEach(function (m) {
              var pid = m.player_id || m.playerId;
              table.appendChild(window.StructsPlayerCard.row({
                id: pid || m.user_id, name: m.name || m.display_name || m.user_id, pfp: m.pfp_attrs,
                presence: pid && Board.presenceDot ? Board.presenceDot(pid) : null,
              }, {
                // `actions` is the row's SECOND argument — the person is the
                // first, what you can do to them is the second.
                actions: pid ? [{ icon: 'icon-phone', title: 'Message ' + (m.name || pid),
                                  onClick: function () { add('room', { id: pid }); } }] : [],
              }));
            });
            host.appendChild(table);
          });
        }).catch(function (e) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', String(e))); });
      });
    },
  });
})();
