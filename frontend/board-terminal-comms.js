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
    /* A room that has a card on the board is marked as such, so the list is a
     * map of your board and not only a list — the two never pointed at each
     * other, and "which of these do I already have open" had no answer. */
    var active = opts.active != null ? opts.active : C.isOpen(r.room_id);
    var row = H.el('div', 'cm-room' + (r.mention ? ' is-mention' : '') + (r.unread ? ' is-unread' : '')
      + (r.muted ? ' is-muted' : '') + (active ? ' is-active' : ''));

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
    /* WHERE it is. Invisible before, and in a federated community it is the
     * difference between your guild's #general and the one everybody uses. */
    var place = C.placeOf(r);
    if (place === 'hub' || place === 'galaxy') {
      title.appendChild(H.el('span', 'cm-room-where fstat-l',
        place === 'hub' ? 'HUB' : C.serverOf(r.room_id)));
    }
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
    /* Pinning is what makes the top of the list STABLE — you look for #trade
     * by position, and a list that re-sorts under you every time somebody
     * speaks is a list you cannot learn. */
    if (!r.invited && opts.pin !== false) {
      var pin = H.el('a', 'cm-room-pin' + (C.isPinned(r.room_id) ? ' is-on' : ''));
      pin.href = 'javascript:void(0)';
      pin.title = C.isPinned(r.room_id) ? 'Unpin' : 'Pin to the top';
      pin.appendChild(icon('icon-beacon'));
      pin.addEventListener('click', function (e) { e.stopPropagation(); C.togglePin(r.room_id); });
      right.appendChild(pin);
    }
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
  // The Terminal as a whole: being named, and being sent somewhere
  // ══════════════════════════════════════════════════════════════════════
  //
  // Two signals that arrive whether or not any Comms card is open, watched
  // from a host that never leaves the document.
  //
  //   `matrix::unread`  reached the GAME window's door badge and nothing else.
  //                     The Terminal — the surface this was built for — had no
  //                     idea you had been named. The count now sits on the
  //                     workspace strip, and a mention stamps the status line.
  //
  //   `matrix::show_room`  an MCP tool, a notification, the game window
  //                     asking for a room. It was announced and nobody
  //                     handled it: the agent saying "look at #war-room" did
  //                     nothing. A card for that room is flashed; otherwise
  //                     one is added.
  function badge() {
    var strip = document.getElementById('tm-ws-items') || document.querySelector('#tm-ws-nav .sui-screen-nav-items');
    if (!strip) return;
    var old = strip.querySelector('.cm-badge');
    if (old) old.parentNode.removeChild(old);
    var b = C.S.badge || {};
    if (!b.count && !b.mention) return;
    var n = H.el('span', 'cm-badge' + (b.mention ? ' is-mention' : ''), b.mention ? 'YOU' : H.fmtInt(b.count));
    n.title = (b.mention ? 'somebody named you' : H.fmtInt(b.count) + ' unread') + ' — ⌘K to see';
    n.addEventListener('click', function () { T.openPalette(); });
    strip.appendChild(n);
  }
  C.watch(document.body, function (what) {
    if (what === 'unread') {
      badge();
      if (C.S.badge && C.S.badge.mention) Board.stamp && Board.stamp('Comms: somebody named you');
      return;
    }
    if (what === 'rooms' || what === 'status') { badge(); return; }
    if (what.indexOf('show:') === 0) {
      var rid = what.slice(5);
      var hit = null;
      Object.keys(T.state.mounted).forEach(function (id) {
        var m = T.state.mounted[id];
        if (m.def && m.def.type === 'room' && m.body && C.S.open[rid] === m.body) hit = m;
      });
      if (hit) {
        // The mark FIRST: a scroll that throws (no scrollIntoView in a test
        // DOM) must not take the flash with it.
        hit.node.classList.add('is-flash');
        setTimeout(function () { hit.node.classList.remove('is-flash'); }, 1600);
        if (hit.node.scrollIntoView) hit.node.scrollIntoView({ block: 'center' });
      } else {
        add('room', { id: rid });
      }
    }
  });
  /* NOT `C.status()` here. This file runs at script-eval time, before
   * `Board.T` exists; an invoke then throws, and a throw at the top of this
   * IIFE aborts it — every card below went unregistered and `COMMS` opened
   * nothing. The watcher above paints the badge on the first `status` that
   * lands, which is the earliest anything true can be known anyway. */

  // ══════════════════════════════════════════════════════════════════════
  // COMMS — where am I, and what is waiting
  // ══════════════════════════════════════════════════════════════════════
  /* WHERE a room is, which is a different axis from what is waiting in it.
   * "hub" is derived — the server this community's centre of gravity is on. */
  var SHOW = [
    { value: 'all', label: 'everything' },
    { value: 'direct', label: 'people' },
    { value: 'hub', label: 'the hub' },
    { value: 'guild', label: 'your guild' },
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
      var state = { open: {} };

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
          /* The quiet ones collapse to a count. They are most of the list and
           * none of the answer — but they are never hidden, because a room you
           * cannot find is a room you have left without deciding to. */
          var shut = g.section.collapsed && !state.open[g.section.key];
          var head = H.el('div', 'cm-sec' + (g.section.collapsed ? ' is-foldable' : ''));
          head.appendChild(icon(g.section.icon));
          head.appendChild(H.el('span', 'fstat-l', g.section.label));
          head.appendChild(H.el('span', 'cm-sec-n fstat-l',
            shut ? '▸ ' + H.fmtInt(g.rooms.length) : H.fmtInt(g.rooms.length)));
          if (g.section.collapsed) {
            head.classList.add('is-clickable');
            head.addEventListener('click', function () {
              state.open[g.section.key] = !state.open[g.section.key];
              draw();
            });
          }
          host.appendChild(head);
          if (shut) return;
          g.rooms.forEach(function (r) {
            host.appendChild(roomRow(r, { onOpen: function () { add('room', { id: r.room_id }); } }));
          });
        });
      };

      C.watch(host, function (what) { if (what === 'rooms' || what === 'status' || what === 'seen' || what === 'open') draw(); });
      return gate(host, function () { return C.rooms().then(draw); });
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // ROOM — one conversation
  // ══════════════════════════════════════════════════════════════════════
  //
  // The card that makes the rebuild worth doing. Two of them side by side is
  // two conversations; the embedded window could only ever be one.
  /* The game inside the conversation — INLINE. The chip itself is the shared
   * row's (`StructsChatRow.idChips`); what opening one does is this host's:
   * a card WINDOW, not a card pushed onto the board behind the conversation
   * you are in the middle of. */
  var KIND_CARD = { 0: 'guild', 1: 'player', 2: 'planet', 9: 'map' };
  function cardFor(id) { return KIND_CARD[Number(String(id).split('-')[0])] || 'inspector'; }
  function idChips(text, onOpen) {
    return window.StructsChatRow.idChips(text, onOpen || function (id) { T.openInWindow(cardFor(id), { id: id }); });
  }
  T.idChips = idChips;

  T.register('room', {
    label: 'Conversation', defaultWidth: 1, defaultHeight: 'grow', cadenceMs: 0,
    describe: function (p) {
      var r = p.id && C.roomById(p.id);
      return r ? r.name : ('Room · ' + (p.id || '?'));
    },
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
        /* You could join and mute; you could not LEAVE. A room you joined by
         * accident was permanent from the Terminal. */
        doors.push({ icon: 'icon-close', title: 'Leave ' + (r.name || 'this room'), onClick: function () {
          if (!window.confirm('Leave ' + (r.name || r.room_id) + '?')) return;
          C.leave(r.room_id);
        } });
      }
      return doors;
    },
    render: function (host, p, ctx) {
      if (!p.id) {
        host.innerHTML = '';
        host.appendChild(H.stateBlock('info', 'Name a room, a player or an object — #trade, 1-61, JPEG, 2-15361.'));
        return;
      }
      var state = { room: null, replyTo: null, sel: null, editing: null, showPins: false, atBottom: true };

      var draw = function () {
        if (!host.isConnected || !state.room) return;
        var rid = state.room.room_id;
        var r = C.roomById(rid) || state.room;
        host.innerHTML = '';

        if (r.player_id) personHeader(host, r, state.standings);
        else header(host, r, state, draw);

        if (r.encrypted) {
          host.appendChild(H.stateBlock('error',
            'This room is end-to-end encrypted and this client has no crypto — nothing sent here can be read.'));
        }
        if (r.unknown) {
          host.appendChild(H.stateBlock('info',
            'Joined ' + r.room_id + ', but it has not come back in a sync yet.'));
        }
        if (r.replaced_by) {
          var moved = H.stateBlock('info', 'This room has been upgraded; the conversation continues elsewhere.');
          var go = H.el('a', 'sui-screen-btn sui-mod-primary', 'Open the new room');
          go.href = 'javascript:void(0)';
          go.addEventListener('click', function () { add('room', { id: r.replaced_by }); });
          moved.appendChild(go);
          host.appendChild(moved);
        }
        if (state.showPins) pinStrip(host, rid);

        var scroller = H.el('div', 'cm-timeline');
        scroller.tabIndex = 0;
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

          var divideAfter = C.unreadFrom(rid);
          var prev = null, ruled = false;
          msgs.forEach(function (m) {
            scroller.appendChild(messageRow(rid, m, prev, state, scroller, draw));
            prev = m;
            /* The "new messages" rule. THE most important reading affordance
             * in any chat client, and it was missing entirely: there was no
             * way to tell what had arrived since you last looked. */
            if (!ruled && divideAfter && m.event_id === divideAfter) {
              ruled = true;
              var rule = H.el('div', 'cm-new');
              rule.appendChild(H.el('span', 'fstat-l', 'new messages'));
              scroller.appendChild(rule);
            }
          });
        }
        host.appendChild(scroller);
        /* A repaint must never move you. It rebuilt the list and so landed at
         * the top unless you happened to be at the bottom — a reaction landing
         * on somebody else's message yanked the card you were reading. Where
         * you were is restored; only a live tail follows the newest line. */
        if (state.atBottom !== false) scroller.scrollTop = scroller.scrollHeight;
        else if (state.scrollTop != null) scroller.scrollTop = state.scrollTop;
        scroller.addEventListener('scroll', function () {
          state.scrollTop = scroller.scrollTop;
          state.atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
          /* The "new messages" rule stays until you have SCROLLED PAST it.
           * Clearing it on the read receipt cleared it the moment the card
           * painted, which is before you had read anything. */
          var rule = scroller.querySelector('.cm-new');
          if (rule && rule.offsetTop < scroller.scrollTop) C.clearUnread(rid);
        });
        // ↑/↓ walk the messages; the action bar follows the selection.
        scroller.addEventListener('keydown', function (e) { walkKeys(e, rid, state, scroller, draw); });

        var who = (C.S.typing[rid] || []);
        if (who.length) {
          host.appendChild(H.el('div', 'cm-typing fstat-l',
            who.length === 1 ? who[0] + ' is typing…' : who.slice(0, 3).join(', ') + ' are typing…'));
        }

        // One action bar for the selected message, naming its own keys.
        if (state.sel) actionBar(host, rid, state, scroller, draw);

        composer(host, rid, r, state, draw);
      };

      C.watch(host, function (what) {
        if (!state.room) return;
        var rid = state.room.room_id;
        /* A message arriving in the room you are LOOKING AT is a message you
         * have read. This marked read once, on mount, so the badge on a room
         * you were staring at climbed all evening. */
        if (what === 'timeline:' + rid) C.markRead(rid);
        if (what === 'timeline:' + rid || what === 'typing:' + rid
          || what === 'pinned:' + rid || what === 'rooms' || what === 'status') draw();
      });

      return gate(host, function () {
        return C.resolve(p.id).then(function (room) {
          state.room = room;
          T.retitle(ctx.id, room.name || room.canonical_alias || room.room_id);
          /* A read marker names the EVENT you have read up to, so the timeline
           * has to be in hand first — and the unread ANCHOR has to be taken
           * before we mark, because marking is what destroys the answer. */
          return C.timeline(room.room_id).then(function () {
            C.openRoom(room.room_id, host);
            state.rid = room.room_id;
            C.anchorUnread(room.room_id);
            C.markRead(room.room_id);
            C.members(room.room_id);
            if ((room.pinned || []).length) C.pinned(room.room_id);
            /* Who they are TO YOU — ally, grudge, protected. Folded in after
             * the first paint so a conversation never waits on a standing. */
            if (room.player_id) {
              T.standingLists().then(function (lists) { state.standings = lists; draw(); }).catch(function () {});
            }
            draw();
          });
        }).catch(function (e) {
          host.innerHTML = '';
          host.appendChild(H.stateBlock('error', String(e)));
        });
      });
    },
  });

  /* A DM opens with WHO you are talking to.
   *
   * Talking to somebody in a war game without being able to see whether they
   * are an ally is a gap the generic client has and we should not: their
   * standing, their guild, their planet and their fleet are the context of
   * every word in the conversation. `StructsPlayerCard` and `standingOf` are
   * the same ones the player and scout cards draw, so a person looks like a
   * person everywhere. */
  function personHeader(host, r, standings) {
    if (!r.player_id || !window.StructsPlayerCard) return;
    var stand = standings ? T.standingOf(standings, r.player_id, null) : null;
    var card = window.StructsPlayerCard.row({
      id: r.player_id, name: r.name || r.player_id, pfp: r.pfp_attrs,
      presence: Board.presenceDot ? Board.presenceDot(r.player_id) : null,
      badge: stand ? stand.badge : null,
    }, {
      actions: [{ icon: 'icon-planet', title: 'Open ' + r.player_id,
                  onClick: function () { T.openInWindow('player', { id: r.player_id }); } }],
    });
    var box = H.el('div', 'cm-person');
    box.appendChild(card);
    host.appendChild(box);
  }

  /* What this place IS — topic, size, alias, and WHICH SERVER it lives on.
   * None of it was shown. In a federated community where the channel you are
   * reading may be published by another guild entirely, the server is not a
   * detail: it is the difference between your guild's #general and the hub's. */
  function header(host, r, state, draw) {
    var strip = H.el('div', 'cm-head');
    var bits = [];
    if (r.members) bits.push(H.fmtInt(r.members) + ' members');
    if (r.canonical_alias) bits.push(r.canonical_alias);
    else if (r.room_id) bits.push(serverOf(r.room_id));
    var line = H.el('div', 'cm-head-line fstat-l', bits.join(' · '));
    strip.appendChild(line);
    if ((r.pinned || []).length) {
      var pins = H.el('a', 'cm-head-pins fstat-l', H.fmtInt(r.pinned.length) + ' pinned');
      pins.href = 'javascript:void(0)';
      pins.addEventListener('click', function () {
        state.showPins = !state.showPins;
        if (state.showPins) C.pinned(r.room_id);
        draw();
      });
      strip.appendChild(pins);
    }
    host.appendChild(strip);
    if (r.topic) host.appendChild(H.el('div', 'cm-topic fstat-l', r.topic));
  }
  function serverOf(roomId) { var at = String(roomId).lastIndexOf(':'); return at > 0 ? String(roomId).slice(at + 1) : ''; }

  /* The room's noticeboard. In a community channel this is where the rules,
   * the schedule and the current operation live — and it was unreachable. */
  function pinStrip(host, rid) {
    var box = H.el('div', 'cm-pins');
    var list = C.S.pinned[rid];
    if (!list) { box.appendChild(H.el('div', 'ops-muted', 'reading the pins…')); host.appendChild(box); return; }
    if (!list.length) { box.appendChild(H.el('div', 'ops-muted', 'nothing pinned')); host.appendChild(box); return; }
    list.forEach(function (m) {
      var row = H.el('div', 'cm-pin');
      row.appendChild(H.el('span', 'cm-pin-who fstat-l', m.sender_name || m.sender || ''));
      var body = H.el('span', 'cm-pin-body');
      body.appendChild(idChips(m.body));
      row.appendChild(body);
      box.appendChild(row);
    });
    host.appendChild(box);
  }

  // ══════════════════════════════════════════════════════════════════════
  // A message, and what you can do to it
  // ══════════════════════════════════════════════════════════════════════
  //
  // SELECT-THEN-ACT. The row carries no controls at all; you select a message
  // and one action bar appears at the foot of the card.
  //
  // Per-row hover icons were three glyphs on every line of a 306px card, and
  // hover does not exist on touch. One bar at any width, naming its own keys,
  // also teaches the keyboard layer without a tutorial — which is what the
  // Terminal is for.
  function messageRow(rid, m, prev, state, scroller, draw) {
    var node = window.StructsChatRow.render(m, prev, {
      onSender: m.player_id ? function () { T.openInWindow('player', { id: m.player_id }); } : null,
    });
    // "edited" with no way to see the old text is half an answer.
    if (m.edited && m.was) {
      var mark = node.querySelector('.chat-msg-edited');
      if (mark) mark.title = 'was: ' + String(m.was).slice(0, 200);
    }
    var b = window.StructsChatRow.body(m, {
      // Ids become chips IN the sentence, and a chip opens a window.
      fill: function (n, text) { n.appendChild(idChips(text)); },
      onJump: function (eid) {
        var at = scroller.querySelector('[data-event="' + eid + '"]');
        if (at) at.scrollIntoView({ block: 'center' });
      },
      /* Taking back a reaction is `on: false`, NOT a redaction — redacting the
       * MESSAGE id would have deleted the message. */
      onReact: function (key, mine) {
        invoke('matrix_react', { guildId: C.S.key, roomId: rid, eventId: m.event_id, key: key, on: !mine })
          .catch(function (e) { Board.stamp && Board.stamp('react: ' + e); });
      },
    });
    if (b) node.appendChild(b);

    /* A send that failed is a message you can SEE and retry. It used to be
     * nothing at all: the text left the box and never arrived anywhere. */
    if (m.failed) {
      var bad = H.el('div', 'cm-failed fstat-l');
      bad.appendChild(H.el('span', null, 'not sent — ' + String(m.failed).slice(0, 60)));
      var again = H.el('a', 'cm-retry', 'retry');
      again.href = 'javascript:void(0)';
      again.addEventListener('click', function (e) { e.stopPropagation(); C.retry(rid, m); });
      bad.appendChild(again);
      node.appendChild(bad);
    }

    if (state.sel === m.event_id) node.classList.add('is-sel');
    node.addEventListener('click', function () {
      state.sel = state.sel === m.event_id ? null : m.event_id;
      state.editing = null;
      draw();
      var box = scroller.querySelector('.is-sel');
      if (box) box.scrollIntoView({ block: 'nearest' });
    });
    return node;
  }

  var selectable = function (rid) {
    return (C.S.timelines[rid] || []).filter(function (m) { return (m.kind || 'text') !== 'event'; });
  };
  function walkKeys(e, rid, state, scroller, draw) {
    var list = selectable(rid);
    if (!list.length) return;
    var at = list.findIndex(function (m) { return m.event_id === state.sel; });
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (at < 0) at = e.key === 'ArrowUp' ? list.length - 1 : 0;
      else at = Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowUp' ? -1 : 1)));
      state.sel = list[at].event_id;
      draw();
      var box = scroller.querySelector('.is-sel');
      if (box) box.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (at < 0) return;
    var m = list[at];
    var did = act(e.key, rid, m, state, draw);
    if (did) { e.preventDefault(); e.stopPropagation(); }
  }

  /* One verb, from a key or from the bar — so the two can never disagree
   * about what `d` means. Answers false for a key it does not own. */
  function act(key, rid, m, state, draw) {
    var mine = !!m['self'];
    if (key === 'Escape') { state.sel = null; state.editing = null; draw(); return true; }
    if (key === 'r') { state.replyTo = m; state.sel = null; draw(); return true; }
    if (key === 'e' && mine) { state.editing = m; draw(); return true; }
    if (key === 'd' && mine) {
      invoke('matrix_redact', { guildId: C.S.key, roomId: rid, eventId: m.event_id })
        .catch(function (err) { Board.stamp && Board.stamp('delete: ' + err); });
      state.sel = null; draw(); return true;
    }
    if (key === '+') {
      invoke('matrix_react', { guildId: C.S.key, roomId: rid, eventId: m.event_id, key: '👍', on: true })
        .catch(function (err) { Board.stamp && Board.stamp('react: ' + err); });
      return true;
    }
    if (key === 'p') {
      var on = !(C.roomById(rid) || {}).pinned || (C.roomById(rid).pinned || []).indexOf(m.event_id) < 0;
      C.pin(rid, m.event_id, on).catch(function (err) { Board.stamp && Board.stamp('pin: ' + err); });
      return true;
    }
    return false;
  }

  /* The bar. It shows only what is LEGAL for this message — offering `edit` on
   * somebody else's line and then refusing it is worse than not offering it —
   * and every button wears its key, which is how the keyboard layer is taught
   * without a page of documentation nobody reads. */
  var VERBS = [
    { key: 'r', label: 'reply' },
    { key: 'e', label: 'edit', mine: true },
    { key: 'd', label: 'delete', mine: true },
    { key: '+', label: 'react' },
    { key: 'p', label: 'pin' },
  ];
  function actionBar(host, rid, state, scroller, draw) {
    var m = (C.S.timelines[rid] || []).filter(function (x) { return x.event_id === state.sel; })[0];
    if (!m) { state.sel = null; return; }
    var bar = H.el('div', 'cm-bar');
    VERBS.forEach(function (v) {
      if (v.mine && !m['self']) return;
      var a = H.el('a', 'cm-verb');
      a.href = 'javascript:void(0)';
      a.appendChild(H.el('span', 'cm-verb-key', v.key));
      a.appendChild(H.el('span', null, v.label));
      a.addEventListener('click', function () { act(v.key, rid, m, state, draw); });
      bar.appendChild(a);
    });
    var esc = H.el('a', 'cm-verb cm-verb-done');
    esc.href = 'javascript:void(0)';
    esc.appendChild(H.el('span', 'cm-verb-key', 'esc'));
    esc.appendChild(H.el('span', null, 'done'));
    esc.addEventListener('click', function () { act('Escape', rid, m, state, draw); });
    bar.appendChild(esc);
    host.appendChild(bar);
  }

  // ══════════════════════════════════════════════════════════════════════
  // The composer
  // ══════════════════════════════════════════════════════════════════════
  function composer(host, rid, r, state, draw) {
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
    if (state.editing) {
      var ed = H.el('div', 'cm-replying cm-mod-edit fstat-l');
      ed.appendChild(H.el('span', null, 'editing your message'));
      var ex = H.el('a', 'cm-x', '×');
      ex.href = 'javascript:void(0)';
      ex.addEventListener('click', function () { state.editing = null; draw(); });
      ed.appendChild(ex);
      host.appendChild(ed);
    }

    /* The SHARED composer (chatrow.js) — the same panel the Comms window and
     * the raid rail draw, third consumer. It hands back its parts and the host
     * wires them; that is why the rail can have a charge battery and this
     * cannot, without either growing a copy of the other. */
    var made = window.StructsChatRow.composer({
      pfpAttrs: C.S.profile && C.S.profile.pfp_attrs,
      placeholder: state.editing ? 'Edit your message' : 'Message ' + (r.name || ''),
    });
    // What you typed and did not send. Switching cards used to lose it.
    made.input.value = state.editing ? String(state.editing.body || '') : C.draft(rid);

    var stopTyping, closeAt;

    var submit = function () {
      var text = made.input.value;
      if (!String(text || '').trim()) return;
      made.input.value = '';
      C.draft(rid, '');
      closeAt();
      if (stopTyping) stopTyping();
      if (state.editing) {
        var was = state.editing;
        state.editing = null;
        C.edit(rid, was.event_id, text).catch(function (e) { Board.stamp && Board.stamp('edit: ' + e); });
        draw();
        return;
      }
      var reply = state.replyTo;
      state.replyTo = null;
      state.atBottom = true;
      /* The unread rule stops meaning anything the moment YOU say something —
       * everything above it is now read by definition. */
      C.clearUnread(rid);
      C.send(rid, text, reply, C.mentionsIn(rid, text)).catch(function () {});
    };

    /* `@` completion.
     *
     * A mention is not a nicety here: `m.mentions` is what sets the server's
     * highlight count, which is the "YOU" badge in the room list. Without a way
     * to name somebody, every message to you is indistinguishable from traffic.
     *
     * A menu rather than Tab-cycling: in a room of four hundred you have to SEE
     * which of three Nets you meant. */
    var menu = H.el('div', 'cm-at');
    menu.hidden = true;
    var atFrom = -1;
    closeAt = function () { menu.hidden = true; menu.innerHTML = ''; atFrom = -1; };
    var partial = function () {
      var m = /@([A-Za-z0-9_.-]*)$/.exec(made.input.value.slice(0, made.input.selectionStart));
      return m ? m[1] : null;
    };
    var takeAt = function (who) {
      if (!who || atFrom < 0) return;
      var v = made.input.value;
      made.input.value = v.slice(0, atFrom) + '@' + who.name + ' ' + v.slice(made.input.selectionStart);
      closeAt();
      made.input.focus();
    };
    var offerAt = function () {
      var t = partial();
      if (t === null) { closeAt(); return; }
      atFrom = made.input.selectionStart - t.length - 1;
      var who = C.mentionOptions(rid, t);
      menu.innerHTML = '';
      if (!who.length) { menu.hidden = true; return; }
      who.forEach(function (person, i) {
        var row = H.el('a', 'cm-at-row' + (i === 0 ? ' is-on' : ''));
        row.href = 'javascript:void(0)';
        row.appendChild(H.el('span', 'cm-at-name', person.name || person.user_id));
        if (person.player_id) row.appendChild(H.el('span', 'cm-at-id fstat-l', person.player_id));
        row.addEventListener('mousedown', function (e) { e.preventDefault(); takeAt(person); });
        menu.appendChild(row);
      });
      menu.hidden = false;
    };
    var atKeys = function (e) {
      if (menu.hidden) return false;
      var rows = [].slice.call(menu.children);
      var at = rows.findIndex(function (n) { return n.classList.contains('is-on'); });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (rows[at]) rows[at].classList.remove('is-on');
        at = ((at < 0 ? 0 : at) + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
        rows[at].classList.add('is-on');
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        takeAt(C.mentionOptions(rid, partial() || '')[at < 0 ? 0 : at]);
        return true;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAt(); return true; }
      return false;
    };

    /* Typing is a claim with an END. This told the server `true` every four
     * seconds and `false` never, so every keystroke left you "typing" in
     * everyone else's client until their timeout — including after you gave up
     * and closed the box. Say it once, and stop saying it. */
    var typingAt = 0, typingOff = null;
    stopTyping = function () {
      if (typingOff) { clearTimeout(typingOff); typingOff = null; }
      if (typingAt) { typingAt = 0; C.typing(rid, false); }
    };

    made.input.addEventListener('input', function () {
      offerAt();
      C.draft(rid, made.input.value);
      if (!String(made.input.value || '').trim()) { stopTyping(); return; }
      var now = Date.now();
      if (now - typingAt > 4000) { typingAt = now; C.typing(rid, true); }
      if (typingOff) clearTimeout(typingOff);
      typingOff = setTimeout(stopTyping, 5000);
    });
    made.input.addEventListener('keydown', function (e) {
      if (atKeys(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
      /* Escape drops the innermost thing first — the mention menu, then the
       * edit, then the reply — and only then belongs to anything outside. */
      if (e.key === 'Escape' && state.editing) { e.preventDefault(); e.stopPropagation(); state.editing = null; draw(); return; }
      if (e.key === 'Escape' && state.replyTo) { e.preventDefault(); e.stopPropagation(); state.replyTo = null; draw(); }
    });
    made.input.addEventListener('blur', function () { stopTyping(); setTimeout(closeAt, 120); });
    made.send.addEventListener('click', submit);

    var box = H.el('div', 'cm-compose');
    box.appendChild(menu);
    box.appendChild(made.node);
    host.appendChild(box);
    if (state.editing) made.input.focus();
  }

  // ══════════════════════════════════════════════════════════════════════
  // CHANNELS — what else is there
  // ══════════════════════════════════════════════════════════════════════
  T.register('channels', {
    label: 'Channel directory', defaultWidth: 1, single: true, defaultHeight: 'grow',
    describe: function (p) {
      /* The NAME of the guild whose directory this is. It said
       * `Channels · matrix.beta.playstructs.com` — a hostname is a routing
       * detail, not a thing anybody calls that place. */
      var known = (C.S.servers || []).filter(function (sv) { return sv.server === p.server; })[0];
      var where = p.server ? (known ? (known.name || known.tag) : p.server) : '';
      return 'Channels' + (where ? ' · ' + where : '') + (p.q ? ' · ' + p.q : '');
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
        /* WHICH homeserver's directory this is.
         *
         * This was a row of badges reading `OH · yours  SN.C  KC`, which is a
         * SENTENCE, not a menu — no affordance, no separation, and a "· yours"
         * glued onto a name so the whole line scanned as prose. It is the
         * board's own sub-nav now (`H.navStrip`, the same component the areas
         * and the config pages use), so it reads as a menu because it IS the
         * menu, and it is labelled by guild NAME rather than by a hostname
         * nobody has ever typed.
         *
         * Yours first. It needs no marker: your own guild's name is a name you
         * already know, and the strip says which one you are looking at by
         * being a strip. */
        if ((servers || []).length > 1) {
          var items = servers.slice().sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); })
            .map(function (sv) {
              return { key: sv.mine ? '' : sv.server, label: sv.name || sv.tag || sv.server };
            });
          host.appendChild(H.navStrip(items, p.server || '', function (key) {
            T.setParams(ctxId, { q: p.q || '', server: key });
          }));
        }

        var joined = {};
        C.S.rooms.forEach(function (r) { if (r.joined) joined[r.room_id] = 1; });
        var rows = (list || []).filter(function (r) { return !joined[r.room_id]; });
        cap(host, rows.length ? H.fmtInt(rows.length) + ' to join · ' + H.fmtInt(Object.keys(joined).length) + ' already in'
          : 'nothing here you are not already in');
        rows.forEach(function (r) {
          host.appendChild(roomRow(r, {
            pin: false,   // you cannot pin a room you are not in
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
