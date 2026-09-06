// Comms — what other people are doing right now: who is here (one dot,
// three states, and a fourth that draws nothing), who has seen your latest
// message, whether the sync is stalled, replying, and silencing a room.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatpresence.test.mjs can drive it with a stub
// `invoke` and no window boot:
//
//   window.ChatPresence({ el, icon, invoke, byId, render, moveCaretToEnd, showError, S, Chat })
//     → { seenLine, onSeen, presenceDot, onSyncHealth, stalledBanner, onPresence,
//         loadPresence, replyButton, setMuted }
(function () {
  'use strict';
  window.ChatPresence = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, byId = ctx.byId, render = ctx.render;
    var moveCaretToEnd = ctx.moveCaretToEnd, showError = ctx.showError, S = ctx.S, Chat = ctx.Chat || {};

    // "Did they see it".
    //
    // One line under the log, about YOUR latest message — not a marker beside
    // every message in the room, which is decoration rather than an answer.
    // Sits with the typing line: both are about what other people are doing
    // right now, and neither is part of the conversation.
    function seenLine() {
      if (!S.seen || !S.seen.names || !S.seen.names.length) return null;
      var names = S.seen.names;
      var line = el('div', 'chat-seen');
      // Three names is a sentence; ten is a list nobody reads.
      var text = names.length <= 3
        ? 'Seen by ' + names.join(', ')
        : 'Seen by ' + names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more';
      line.appendChild(el('span', null, text));
      line.title = names.join(', ');
      return line;
    }

    function onSeen(payload) {
      if (!payload) return;
      if (payload.guild_id && payload.guild_id !== S.guildId) return;
      if (payload.room_id !== S.roomId) return;
      S.seen = payload.seen || null;
      if (S.view === 'room') render();
    }
    Chat.onSeen = onSeen;

    // ── Who is here ───────────────────────────────────────────────────────────
    // One dot, three states, and a fourth that draws nothing at all.
    function presenceDot(playerId) {
      if (!S.presenceKnown || !playerId) return null;
      var p = S.presence[playerId];
      if (!p) return null;                    // unknown, which is not offline
      var cls = p.state === 'online' ? 'chat-mod-online'
        : p.state === 'unavailable' ? 'chat-mod-idle' : 'chat-mod-away';
      var dot = el('span', 'chat-presence ' + cls);
      dot.title = p.state === 'online' ? 'Online'
        : p.state === 'unavailable' ? 'Idle' : 'Away';
      return dot;
    }
    Chat.presenceDot = presenceDot;

    // Nothing is arriving, and the window would otherwise look like a quiet
    // guild. Shown wherever the player is: a stall is not about one room.
    function onSyncHealth(payload) {
      if (!payload) return;
      if (payload.guild_id && payload.guild_id !== S.guildId) return;
      S.syncStalled = payload.ok ? null : (payload.reason || 'not reachable');
      render();
    }
    Chat.onSyncHealth = onSyncHealth;

    function stalledBanner() {
      if (!S.syncStalled) return null;
      var bar = el('div', 'chat-encrypted chat-mod-stalled');
      bar.appendChild(icon('icon-alert sui-text-warning', 'sui-icon-md'));
      bar.appendChild(el('span', null,
        'Not receiving messages \u2014 trying again. ' + S.syncStalled));
      return bar;
    }

    function onPresence(payload) {
      if (!payload) return;
      if (payload.guild_id && payload.guild_id !== S.guildId) return;
      S.presence = payload.presence || {};
      S.presenceKnown = Object.keys(S.presence).length > 0;
      render();
    }
    Chat.onPresence = onPresence;

    function loadPresence() {
      return invoke('matrix_presence', { guildId: S.guildId })
        .then(function (res) {
          S.presence = (res && res.presence) || {};
          S.presenceKnown = !!(res && res.known);
          S.sharingStatus = !!(res && res.sharing);
          S.myStatus = (res && res.status) || null;
          render();
        })
        .catch(function () {});
    }

    function replyButton(m) {
      var a = el('a', 'chat-reply-btn');
      a.href = 'javascript:void(0)';
      a.title = 'Reply to ' + (m.sender_name || m.sender);
      a.appendChild(icon('icon-incoming sui-text-secondary', 'sui-icon-sm'));
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        S.replyTo = m;
        render();
        var input = byId('chat-input');
        if (input) { input.focus(); moveCaretToEnd(input); }
      });
      return a;
    }

    // Silence a room without leaving it. Unread still counts; it simply stops
    // interrupting — that distinction is the whole point of muting.
    function setMuted(muted) {
      if (!S.roomId) return;
      return invoke('matrix_mute', {
        guildId: S.guildId, roomId: S.roomId, muted: muted,
      })
        .then(function () {
          if (S.room) S.room.muted = muted;
          S.rooms.forEach(function (r) { if (r.room_id === S.roomId) r.muted = muted; });
          render();
        })
        .catch(function (e) { showError(String(e)); });
    }
    Chat.setMuted = setMuted;

    return {
      seenLine: seenLine, onSeen: onSeen, presenceDot: presenceDot, onSyncHealth: onSyncHealth,
      stalledBanner: stalledBanner, onPresence: onPresence, loadPresence: loadPresence,
      replyButton: replyButton, setMuted: setMuted,
    };
  };
})();
