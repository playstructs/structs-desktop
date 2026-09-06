// Comms — pinned messages, and the small helpers a message quotes with.
//
// The handful of things everyone in the room needs: the current target, the
// standing rules. Whether this account MAY pin is the homeserver's call —
// offering the control to everyone and reporting a refusal beats keeping a
// copy of its power-level rules in here that can only drift.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatpins.test.mjs can drive it with a stub `invoke`
// and no window boot:
//
//   window.ChatPins({ el, icon, invoke, render, showError, messageNode, unreadFor, say,
//                     serverIdOf, S, Chat })
//     → { pinnedStrip, pinsOf, replyWho, excerpt, jumpTo, cssEscape, pinCount,
//         isPinned, pinToggle, setPin, loadPins }
(function () {
  'use strict';
  window.ChatPins = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, render = ctx.render, showError = ctx.showError;
    var messageNode = ctx.messageNode, unreadFor = ctx.unreadFor, say = ctx.say, serverIdOf = ctx.serverIdOf;
    var S = ctx.S, Chat = ctx.Chat || {};

    // The handful of things everyone in the room needs: the current target, the
    // standing rules. Collapsed to one line by default — a room with six pins
    // must not push the conversation off the screen — and the count is enough to
    // say there is something worth opening.
    function pinnedStrip() {
      var count = pinCount();
      if (!count) return null;
      var open = !!S.pinsOpen[S.roomId];

      var wrap = el('div', 'chat-pins');
      var head = el('a', 'chat-pins-head');
      head.href = 'javascript:void(0)';
      head.appendChild(icon('icon-beacon sui-text-secondary', 'sui-icon-md'));
      head.appendChild(el('span', 'chat-pins-label',
        count === 1 ? 'Pinned message' : count + ' pinned messages'));
      head.appendChild(icon((open ? 'icon-chevron-up' : 'icon-chevron-down') +
        ' sui-text-secondary', 'sui-icon-sm'));
      head.addEventListener('click', function () {
        S.pinsOpen[S.roomId] = !open;
        render();
        if (!open) loadPins();
      });
      wrap.appendChild(head);

      if (open) {
        var body = el('div', 'chat-pins-body');
        if (S.pinsLoading) {
          body.appendChild(el('div', 'chat-pins-note', 'Reading them.'));
        } else if (!S.pins.length) {
          // The state names ids; the events behind them can be gone.
          body.appendChild(el('div', 'chat-pins-note',
            'Nothing readable — the pinned messages are no longer available.'));
        } else {
          S.pins.forEach(function (m) {
            var row = el('div', 'chat-pin');
            // No unpin control of its own. `messageNode` already carries one,
            // and inside the strip it is showing the pinned state — a second
            // button beside it did the same job twice.
            row.appendChild(messageNode(m));
            body.appendChild(row);
          });
        }
        wrap.appendChild(body);
      }
      return wrap;
    }

    // The same room reaches this window twice — as `S.room` from opening it, and
    // as an entry in `S.rooms` from the live room-list push. Either can be the
    // one carrying the pins, so ask both rather than picking a favourite and
    // being silently wrong when the other one is fresher.
    function pinsOf(roomId) {
      var a = (S.roomId === roomId && S.room && S.room.pinned) || null;
      var b = (unreadFor(roomId) || {}).pinned || null;
      if (a && b) return a.length >= b.length ? a : b;
      return a || b || [];
    }

    // Who was answered, by the name a player knows them by. The quote carries a
    // Matrix id; the timeline and the directory carry the real one.
    function replyWho(m) {
      if (!m.reply_sender) return 'a message';
      for (var i = 0; i < S.messages.length; i++) {
        if (S.messages[i].sender === m.reply_sender) return S.messages[i].sender_name;
      }
      var local = String(m.reply_sender).replace(/^@/, '').split(':')[0];
      var ident = S.addressBook && S.addressBook[local];
      return (ident && ident.name) || local;
    }

    function excerpt(text) {
      var one = String(text || '').replace(/\s+/g, ' ').trim();
      return one.length > 120 ? one.slice(0, 119) + '…' : one;
    }

    // Scroll to a message that is already loaded, and mark it so the eye can
    // find it. A message NOT loaded stays where it is — jumping to scrollback
    // the window does not hold would mean a fetch and a guess at position, and
    // saying nothing is better than moving to the wrong place.
    function jumpTo(eventId) {
      var node = document.querySelector('[data-event="' + cssEscape(eventId) + '"]');
      if (!node) { say('That message is further back than this window holds.'); return; }
      // Mark first, scroll second. The mark is the part that answers "which
      // one"; a scroll that cannot happen must not cost the highlight too.
      node.classList.add('chat-mod-found');
      if (node.scrollIntoView) node.scrollIntoView({ block: 'center' });
      setTimeout(function () { node.classList.remove('chat-mod-found'); }, 1600);
    }

    function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

    function pinCount() { return pinsOf(S.roomId).length; }

    function isPinned(eventId) {
      return pinsOf(S.roomId).indexOf(eventId) !== -1;
    }

    // Whether this account MAY pin is the homeserver's call. Offering the
    // control to everyone and reporting a refusal beats keeping a copy of its
    // power-level rules in here that can only drift.
    function pinToggle(m, pinned, serverId) {
      var a = el('a', 'chat-pin-btn');
      a.href = 'javascript:void(0)';
      a.title = pinned ? 'Unpin this message' : 'Pin this message';
      a.appendChild(icon('icon-beacon' + (pinned ? ' sui-text-warning' : ' sui-text-secondary'),
        'sui-icon-sm'));
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        setPin(serverId || serverIdOf(m), !pinned);
      });
      return a;
    }

    function setPin(eventId, pin) {
      if (!eventId || eventId.charAt(0) !== '$') return;   // a local echo has no id yet
      return invoke('matrix_pin', {
        guildId: S.guildId, roomId: S.roomId, eventId: eventId, pin: pin,
      })
        .then(function (res) {
          var list = (res && res.pinned) || [];
          if (S.room) S.room.pinned = list;
          S.rooms.forEach(function (r) { if (r.room_id === S.roomId) r.pinned = list; });
          S.pinsOpen[S.roomId] = list.length > 0;
          render();
          if (list.length) loadPins();
          else S.pins = [];
        })
        .catch(function (e) { showError(String(e)); });
    }
    Chat.setPin = setPin;

    function loadPins() {
      if (!S.roomId) return Promise.resolve();
      S.pinsLoading = true;
      var forRoom = S.roomId;
      return invoke('matrix_pinned', { guildId: S.guildId, roomId: forRoom })
        .then(function (res) {
          if (S.roomId !== forRoom) return;      // moved on while it was loading
          S.pins = (res && res.messages) || [];
          S.pinsLoading = false;
          render();
        })
        .catch(function () { S.pinsLoading = false; S.pins = []; render(); });
    }
    Chat.loadPins = loadPins;

    return {
      pinnedStrip: pinnedStrip, pinsOf: pinsOf, replyWho: replyWho, excerpt: excerpt, jumpTo: jumpTo,
      cssEscape: cssEscape, pinCount: pinCount, isPinned: isPinned, pinToggle: pinToggle,
      setPin: setPin, loadPins: loadPins,
    };
  };
})();
