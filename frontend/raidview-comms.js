// Raid view — what people have said about this planet, beside what HAPPENED
// to it. The battle log is the chain's account; this is the guild's.
// Together they are the whole story of a raid.
//
// The rail IS the object's own room: read directly once joined, reached by
// speaking (a room the player never said anything in is not a room they
// wanted), and searched-for by id until then.
//
// Extracted from raidview.js (2026-09-06). Collaborators arrive as a context
// so scripts/harness-tests/raidcomms.test.mjs can drive it with a stub
// `__TAURI__` and a stub StructsChatRow:
//
//   window.RaidComms({ el, target, paintPfp, paintBattery, whoLine, fmtNum })
//     → { chatState, objectTitle, defaultTopic, objectWord, mentionsObject, wireChat,
//         loadMyPfp, resolveRoom, paintComposerIdentity, inRoom, loadChat, loadRoomChat,
//         renderChat, syncComposer, sendChat, reachableRoom, wireComposer }
(function () {
  'use strict';
  window.RaidComms = function (ctx) {
    var el = ctx.el, target = ctx.target, paintPfp = ctx.paintPfp, paintBattery = ctx.paintBattery;
    var whoLine = ctx.whoLine, fmtNum = ctx.fmtNum;

    // Beside what HAPPENED to it. The battle log is the chain's account; this
    // is the guild's. Together they are the whole story of a raid.
    var chatState = { rows: [], open: false, loading: false, connected: false,
                      fresh: false,
                      sending: false, guildId: null,
                      // The built composer (node/input/send), kept so a repaint
                      // does not throw away the caret mid-sentence.
                      composer: null,
                      // The player's own portrait and name, for the composer's
                      // well and the tooltip that says who you are speaking as.
                      myPfp: null,
                      myName: null,
                      myId: null,
                      // The viewer's own charge, off the snapshot. Not derived
                      // here: `GAME_STATE.get_charge()` already computes it the
                      // way the game does, and a second opinion would disagree.
                      myCharge: null,
                      // The object's OWN room, once looked up: `{alias, room_id,
                      // can_create, joined}`. Null means not looked up yet or no
                      // such room, and both leave the panel on the search path.
                      room: null };

    /* "planet" or "fleet" — whichever this window is actually about.
     *
     * Written out three separate times before this, in the empty line and in
     * both composer placeholders, so a fleet window said "planet" wherever one
     * of them was missed. One definition, and the kind can only be wrong
     * everywhere at once.
     */
    // "Planet 2-16116" — the channel's name, and the one the room is created
    // with, so the header does not change under the player when it appears.
    function objectTitle() {
      if (!target() || !target().id) return 'Comms';
      return objectWord().charAt(0).toUpperCase() + objectWord().slice(1)
        + ' ' + target().id;
    }

    // Matches the topic `matrix_object_room_create` sets on the real room.
    function defaultTopic() {
      if (!target() || !target().id) return '';
      return 'Everything said about ' + objectWord() + ' ' + target().id + '.';
    }

    function objectWord(kind) {
      var k = kind || (target() && target().kind);
      return k === 'fleet' ? 'fleet' : 'planet';
    }

    // Does this text name THIS object, and not one whose id merely starts the
    // same way?
    //
    // `2-1` is a prefix of `2-15361`. Substring-matching chain ids has caused
    // real misattribution in this codebase before — a whole class of bug — so
    // the id must be bounded by something that cannot continue it: not a digit,
    // not a hyphen, not a letter.
    function mentionsObject(body, id) {
      var text = String(body || '');
      var at = -1;
      for (;;) {
        at = text.indexOf(id, at + 1);
        if (at === -1) return false;
        var before = at === 0 ? '' : text.charAt(at - 1);
        var after = text.charAt(at + id.length);
        var boundedLeft = !before || !/[0-9A-Za-z-]/.test(before);
        var boundedRight = !after || !/[0-9A-Za-z-]/.test(after);
        if (boundedLeft && boundedRight) return true;
      }
    }

    function wireChat() {
      // No "open in comms" door any more: this rail IS the planet's room, and a
      // link out of it was a leftover from when it was only a digest of what
      // other rooms had said.
      // The rail is always open, so there is nothing to toggle and nothing to
      // defer: read the conversation as soon as the window has a target. The
      // room lookup comes first because it decides WHICH read happens.
      chatState.open = true;
      loadMyPfp();
      resolveRoom().then(loadChat);

      // Live, because a raid is live. The panel used to load once on open and
      // then go stale during exactly the event it exists for.
      //
      // Only messages that name THIS object: a raid window is one planet, and
      // repainting it for every message in the guild would be a busy panel
      // saying nothing.
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.StructsEvents.listen('matrix::timeline', function (e) {
          var p = (e && e.payload) || {};
          if (!target() || !p.messages) return;
          // In the object's own room, BELONGING is the test — every message
          // there is about this object whether or not it names it, which is the
          // whole point of having the room. Outside it, naming is all we have.
          var hit = inRoom() && p.room_id === chatState.room.room_id
            ? p.messages.some(function (m) { return m && !m.self; })
            : p.messages.some(function (m) {
                return m && !m.self && mentionsObject(m.body, target().id);
              });
          if (!hit) return;
          loadChat();
        });
      }
    }

    /* Does this object have a room of its own, and may we speak in it?
     *
     * Asked once per window. Three answers matter and each changes the panel:
     * a room we have JOINED is read directly and needs no id in the message; a
     * room that exists but we have not joined, or does not exist and is ours to
     * make, is reachable — sending gets us in; anything else leaves the panel on
     * the search it has always used.
     */
    /* The player's own face, for the composer's portrait well.
     *
     * Comms reads it from its Matrix profile; this window has no Matrix session
     * of its own, so it asks the game for the same on-chain attributes. Absent
     * is fine — the composer draws the placeholder, which is what the action bar
     * does too.
     */
    function loadMyPfp() {
      if (!window.__TAURI__) return Promise.resolve();
      return window.__TAURI__.core.invoke('mcp_inventory', { player: 'primary' })
        .then(function (d) {
          var p = d && d.player;
          chatState.myPfp = p && p.pfp_attrs;
          chatState.myName = p && p.name;
          chatState.myId = p && p.player_id;
          // The composer may already be on screen with a placeholder in it.
          paintComposerIdentity();
        })
        .catch(function () {});
    }

    function resolveRoom() {
      if (!target() || !window.__TAURI__) return Promise.resolve();
      return window.__TAURI__.core.invoke('matrix_object_room', { objectId: target().id })
        .then(function (res) { chatState.room = res || null; })
        // A lookup failure is not a panel failure: the search path still works.
        .catch(function () { chatState.room = null; });
    }

    /* Paint the composer's portrait with the player it will speak as.
     *
     * Separate from building the composer because the two RACE: `loadMyPfp` and
     * the room lookup that leads to the first paint are fired together in
     * `wireChat`, so the composer is routinely built before the profile lands.
     * `pfpAttrs` was read once at construction, which meant the well drew the
     * placeholder and kept it — the portrait was very often nobody. Whichever
     * of the two finishes second calls this, so the face arrives either way.
     *
     * Absent stays absent: the well's own placeholder is what the action bar
     * does too, and a tooltip claiming a name we do not have is worse than one
     * that admits it.
     */
    function paintComposerIdentity() {
      var portrait = chatState.composer && chatState.composer.portrait;
      if (!portrait) return;
      paintPfp(portrait.querySelector('.sui-screen-portrait-image'), chatState.myPfp);
      paintBattery(chatState.composer.battery, chatState.myCharge);
      portrait.setAttribute('data-sui-mod-placement', 'top');
      portrait.setAttribute('data-sui-tooltip',
        'Speaking as\n' + whoLine(chatState.myName, chatState.myId, 'your primary')
        + (chatState.myCharge == null ? '' : '\nCharge ' + fmtNum(chatState.myCharge)));
    }

    // True when the rail is reading the object's OWN room rather than searching
    // every room for its id.
    function inRoom() {
      return !!(chatState.room && chatState.room.room_id && chatState.room.joined);
    }

    function loadChat() {
      if (!target() || chatState.loading) return;
      if (inRoom()) return loadRoomChat();
      chatState.loading = true;
      window.__TAURI__.core.invoke('matrix_object_chatter', { objectId: target().id })
        .then(function (res) {
          chatState.loading = false;
          chatState.connected = !!(res && res.connected);
          chatState.guildId = (res && res.guild_id) || null;
          chatState.rows = (res && res.hits) || [];
          syncComposer();
          renderChat();
        })
        .catch(function () {
          chatState.loading = false;
          chatState.rows = [];
          renderChat();
        });
    }

    /* Read the object's own room.
     *
     * Mapped into the same row shape the search path produces, so there is one
     * renderer and the two ways of getting messages cannot drift apart in how
     * they look.
     */
    function loadRoomChat() {
      chatState.loading = true;
      window.__TAURI__.core.invoke('matrix_timeline', {
        guildId: chatState.room.guild_id || chatState.guildId,
        roomId: chatState.room.room_id, limit: 40,
      }).then(function (res) {
        chatState.loading = false;
        chatState.connected = true;
        chatState.guildId = chatState.room.guild_id || chatState.guildId;
        var name = (res && res.room && res.room.name) || '';
        chatState.roomName = name;
        chatState.roomTopic = (res && res.room && res.room.topic) || '';
        chatState.rows = ((res && res.messages) || []).map(function (m) {
          return { message: m, room_id: chatState.room.room_id, room_name: name };
        });
        syncComposer();
        renderChat();
      }).catch(function () {
        chatState.loading = false;
        // The room went unreadable — we were removed, or it was upgraded. Fall
        // back rather than showing an empty panel that looks like silence.
        chatState.room = null;
        loadChat();
      });
    }

    function renderChat() {
      var R = window.StructsChatRow;
      var body = document.getElementById('rv-chat-body');
      var count = document.getElementById('rv-chat-count');
      var head = document.getElementById('rv-chat-head');
      if (!body) return;

      /* Say which of the two panels this is.
       *
       * Reading the object's own room and searching every room for its id look
       * identical but are not: one shows everything said in a place, the other
       * shows only what happened to name the object, and only one appends an id
       * to what you type. A player who cannot tell them apart cannot tell why
       * their message did or did not appear.
       */
      /* The channel is named after the OBJECT, always.
       *
       * It used to fall back to the word "Comms" until a room had been resolved
       * and joined — so a raid window opened on a planet nobody had spoken about
       * showed a channel called "Comms", with no topic and no composer. That is
       * every raid window, the first time. This panel has never been in doubt
       * about which planet it is, so it says so from the first paint.
       */
      /* The header carries the TOPIC, not the room's name.
       *
       * The name was "Planet 2-16116" and the map beside this panel already says
       * that, in a banner across the top of it — so the rail was repeating it and
       * spending a second line on the topic underneath. One line, and it is the
       * line that says something the map does not.
       *
       * Defaulted rather than blank before the room exists: the topic a room GETS
       * on creation is this exact sentence, so showing it early is the same text
       * one hop sooner, and nothing reshapes when somebody finally speaks.
       */
      var title = head && head.querySelector('.rv-chat-title');
      if (title) title.textContent = chatState.roomTopic || defaultTopic();
      body.textContent = '';
      if (count) {
        count.textContent = chatState.rows.length ? String(chatState.rows.length) : '';
      }

      // Comms' own notice block, not a bare line of hint text. This is the state
      // a channel is most often seen in, so it is the one that most has to look
      // like the real thing.
      if (!chatState.connected) {
        // A raid window opens whether or not Comms is signed in, and must say
        // which of "nobody spoke" and "we did not look" is true.
        body.appendChild(R.notice('Not connected',
          'Comms is not signed in, so nothing here can be read.'));
        return;
      }
      if (!chatState.rows.length) {
        // A fleet is not a planet. The rail opens on both.
        body.appendChild(R.notice('Quiet',
          'Nothing has been said about this ' + objectWord() + ' yet.'));
        return;
      }
      /* The Comms window's own row, not a lookalike.
       *
       * This panel used to build its own `.rv-chat-*` markup that approximated
       * one — a different sender treatment, no clock, no run-collapsing, and
       * room events rendered as if somebody had said "joined". `chatrow.js` is
       * the component both windows draw, so a stripped-down channel is exactly
       * that: the same rows with nothing bolted on.
       *
       * No `controls` and no `onSender`: react, reply, pin and edit belong to a
       * full timeline. A rail beside a live raid is for reading and saying one
       * thing.
       */
      var prev = null;
      chatState.rows.forEach(function (h) {
        var m = h.message || {};
        var node = R.render(m, prev, {});
        // Which room a line came from only tells you something when the lines
        // come from DIFFERENT rooms. In the object's own room every row would
        // repeat the same name; the panel title says it once instead. On the
        // search path it rides the sender line, where the clock would be.
        if (!inRoom() && h.room_name) {
          var meta = node.querySelector('.chat-msg-meta');
          if (meta) meta.insertBefore(el('span', 'rv-chat-room', h.room_name), meta.firstChild);
        }
        body.appendChild(node);
        if ((m.kind || 'text') !== 'event') prev = m;
        // The BODY is a separate node under the head, as the timeline draws it.
        if ((m.kind || 'text') !== 'event' && (m.kind || 'text') !== 'emote') {
          node.appendChild(el('div', 'chat-msg-body', m.body || ''));
        }
      });
    }

    // Which room a message from here goes to.
    //
    /* The composer: the game's own, and pointed at ONE room.
     *
     * There is no room picker any more. This rail is the planet's channel —
     * offering a list of other channels to send into was never what "discuss
     * this planet" meant, and it invited putting the conversation somewhere it
     * did not belong. If the object's room cannot be reached, the panel says so
     * rather than proposing a substitute.
     *
     * Built once and kept: rebuilding it on every repaint would throw away the
     * caret mid-sentence.
     */
    function syncComposer() {
      var box = document.getElementById('rv-chat-compose');
      var host = document.getElementById('rv-chat-entry');
      if (!box || !host) return;

      // A composer that cannot send is worse than no composer: it invites a
      // message the player will lose.
      var usable = chatState.connected && reachableRoom();
      box.classList.toggle('hidden', !usable);
      if (!usable) return;

      if (!chatState.composer) {
        chatState.composer = window.StructsChatRow.composer({
          inputId: 'rv-chat-input',
          sendId: 'rv-chat-send',
          pfpAttrs: chatState.myPfp,
          battery: true,
          maxLength: 900,
        });
        host.appendChild(chatState.composer.node);
        /* Who you are speaking as, in this window's own idiom.
         *
         * The two portraits above this one are the defender and the raider, and
         * each says who it is on hover (`renderSide`). The third portrait is
         * you, and it said nothing — so the rail was the one place in the app
         * you speak from with no name on screen at all. Same attribute, same
         * placement, same shape of text. */
        paintComposerIdentity();
        chatState.composer.send.addEventListener('click', sendChat);
        chatState.composer.input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
        });
      }
      // Just "Message", as Comms says. The longer form ("— this opens the planet
      // room") did not fit the rail and truncated to "Message —", which reads as
      // a bug; and the topic above already says what this channel is.
      chatState.composer.input.placeholder = 'Message';
    }

    function sendChat() {
      var input = chatState.composer && chatState.composer.input;
      var err = document.getElementById('rv-chat-error');
      if (!input || chatState.sending) return;
      var text = input.value.trim();
      if (!text || !reachableRoom()) return;

      /* A leading slash means the same things it means in Comms.
       *
       * Not because this rail has commands — it has none — but because the rail
       * must not turn a typed command into a message posted to the guild. Comms
       * answers `/foo` with "unknown command"; a rail that simply sent it would
       * publish the mistake.
       *
       * The two rules that DO carry over are Comms' own, in its order: `//`
       * escapes to a literal slash, and `/me` is an emote. The escape has to be
       * checked first — it exists so that someone who wants to say "/me waves"
       * literally can, and a rail that read `//me` as an emote would defeat the
       * very thing they reached for.
       *
       * Deliberately NOT pushed down into `matrix_send`, which is where the
       * mention fallback went: Comms strips `/me` itself and sends the remainder,
       * so a server-side re-parse would turn an escaped `//me waves` — which
       * arrives as the plain body `/me waves` — back into the emote the player
       * escaped to avoid.
       */
      var msgtype = null;
      if (text.indexOf('//') === 0) {
        text = text.slice(1);
      } else if (text.charAt(0) === '/') {
        var m = /^\/me\s+([\s\S]+)$/.exec(text);
        if (m) {
          text = m[1];
          msgtype = 'm.emote';
        } else {
          if (err) err.textContent = 'Commands live in Comms — this sends messages.';
          return;
        }
      }

      /* No id is appended, because there is nowhere else for the message to go.
       *
       * The rail used to tag outgoing text with the object id: it read by
       * SEARCHING every room, so a message that did not name the planet was sent
       * successfully and then never appeared in the panel that sent it. With one
       * destination that whole problem is gone — the message belongs by virtue
       * of where it was sent, and an appended id would be noise nobody typed.
       *
       * The tagging branch is not merely unused, it is unreachable: `sendChat`
       * returns above when there is no room to reach.
       */
      chatState.sending = true;
      if (err) err.textContent = '';

      // Speaking is what joins you. A room the player never said anything in is
      // not a room they wanted, so the membership is bought at the moment they
      // show they want it — not when the window happened to open.
      var ready = inRoom() || !reachableRoom()
        ? Promise.resolve()
        : window.__TAURI__.core.invoke('matrix_object_room_create', { objectId: target().id })
            .then(function (res) {
              chatState.room = Object.assign({}, chatState.room, res, { joined: true });
            });

      ready.then(function () {
        // One destination: the object's own room. `ready` above has just
        // joined or created it, so `inRoom()` is true by here.
        var target = chatState.room && chatState.room.room_id;
        if (!target) throw new Error('no room to send to');
        return window.__TAURI__.core.invoke('matrix_send', {
          guildId: chatState.guildId, roomId: target, body: text, msgtype: msgtype,
        });
      }).then(function () {
        chatState.sending = false;
        input.value = '';
        chatState.loading = false;
        if (inRoom()) {
          // A real room echoes the message straight back through sync, so there
          // is nothing to wait for.
          syncComposer();
          loadChat();
        } else {
          // The search path is different: a just-sent message is not indexed the
          // instant it lands, so re-reading now would show nothing new and read
          // as a failed send. Deferred one beat.
          setTimeout(function () { chatState.loading = false; loadChat(); }, 1200);
        }
      }).catch(function (e) {
        chatState.sending = false;
        if (err) err.textContent = String(e).slice(0, 120);
      });
    }

    // A room we could be speaking in after one join — either it exists and we
    // have not joined, or it does not exist and it is ours to create.
    function reachableRoom() {
      var r = chatState.room;
      return !!(r && (r.joined || r.room_id || r.can_create));
    }

    // The composer builds and wires itself in `syncComposer`, once it has a room
    // to send to. All that is left here is the one thing that is about THIS
    // window rather than about a composer: the map reads arrow keys and letters
    // as controls, so a composer that steers the board while you type is
    // unusable. Keys stop at the rail.
    function wireComposer() {
      var host = document.getElementById('rv-chat-entry');
      if (host) host.addEventListener('keydown', function (e) { e.stopPropagation(); });
    }

    return {
      chatState: chatState, objectTitle: objectTitle, defaultTopic: defaultTopic, objectWord: objectWord,
      mentionsObject: mentionsObject, wireChat: wireChat, loadMyPfp: loadMyPfp, resolveRoom: resolveRoom,
      paintComposerIdentity: paintComposerIdentity, inRoom: inRoom, loadChat: loadChat, loadRoomChat: loadRoomChat,
      renderChat: renderChat, syncComposer: syncComposer, sendChat: sendChat, reachableRoom: reachableRoom,
      wireComposer: wireComposer,
    };
  };
})();
