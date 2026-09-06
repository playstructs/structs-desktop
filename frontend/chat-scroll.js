// Comms — what the reader is doing: announcing that we are typing, following
// the conversation only while AT the conversation, and loading history as
// the reader scrolls up.
//
// Yanking someone to the bottom because a message arrived while they were
// reading scrollback is the single most annoying thing a chat client does.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatscroll.test.mjs can drive it with a stub `invoke`
// and no window boot:
//
//   window.ChatScroll({ byId, invoke, render, S, Chat })
//     → { noteTyping, stopTyping, atBottom, scrollToEnd, maybeLoadHistory, loadHistory,
//         noteScrollPosition, keepPlace, following }
(function () {
  'use strict';
  window.ChatScroll = function (ctx) {
    var byId = ctx.byId, invoke = ctx.invoke, render = ctx.render, S = ctx.S, Chat = ctx.Chat || {};

    // ── Announcing that we are typing ──────────────────────────────────────
    // Throttled hard. The homeserver keeps believing a notice for 20 seconds, so
    // one every 8 is plenty — sending on every keystroke would put a request on
    // the wire per character.
    var typingSentAt = 0;
    var typingStopTimer = null;
    // WHICH room we told we were typing. Not S.roomId at retraction time: leaving
    // a room mid-sentence would otherwise retract in the room you arrived at and
    // leave you shown as typing, for twenty seconds, in the one you left.
    var typingRoom = null;
    var TYPING_REFRESH_MS = 8000;
    var TYPING_IDLE_MS = 5000;

    function noteTyping(value) {
      if (!S.roomId) return;
      // A slash command is not a message being written to the room, and a
      // cleared box means the thought was abandoned.
      var writing = !!String(value || '').trim() && String(value).charAt(0) !== '/';
      if (typingStopTimer) { clearTimeout(typingStopTimer); typingStopTimer = null; }

      if (!writing) { stopTyping(); return; }
      var now = Date.now();
      if (now - typingSentAt > TYPING_REFRESH_MS) {
        typingSentAt = now;
        typingRoom = S.roomId;
        invoke('matrix_typing', { guildId: S.guildId, roomId: typingRoom, typing: true })
          .catch(function () {});
      }
      // Stop claiming to type once the keyboard goes quiet, rather than waiting
      // for the server's timeout to lapse.
      typingStopTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
    }

    function stopTyping() {
      if (typingStopTimer) { clearTimeout(typingStopTimer); typingStopTimer = null; }
      if (!typingSentAt || !typingRoom) return;
      var room = typingRoom;
      typingSentAt = 0;
      typingRoom = null;
      invoke('matrix_typing', { guildId: S.guildId, roomId: room, typing: false })
        .catch(function () {});
    }
    Chat.noteTyping = noteTyping;
    Chat.stopTyping = stopTyping;

    // ── Scroll anchoring ───────────────────────────────────────────────────
    // Follow the conversation only while the reader is AT the conversation.
    // Yanking someone to the bottom because a message arrived while they were
    // reading scrollback is the single most annoying thing a chat client does.
    var STICK_SLACK_PX = 48;

    function atBottom() {
      var t = byId('chat-timeline');
      if (!t) return true;
      // jsdom has no layout — every measurement is 0, which reads as "at the
      // bottom", which is the right default for a fresh room.
      return t.scrollHeight - t.scrollTop - t.clientHeight <= STICK_SLACK_PX;
    }

    function scrollToEnd() {
      var t = byId('chat-timeline');
      if (t) t.scrollTop = t.scrollHeight;
    }

    // Near the top means "show me what came before". 120px of lead-in so the
    // page is already arriving by the time the reader gets there.
    var HISTORY_TRIGGER_PX = 120;

    function maybeLoadHistory() {
      var t = byId('chat-timeline');
      if (!t || S.view !== 'room' || !S.roomId) return;
      if (S.loadingHistory || !S.moreHistory) return;
      if (t.scrollTop > HISTORY_TRIGGER_PX) return;
      loadHistory();
    }

    function loadHistory() {
      var room = S.roomId;
      S.loadingHistory = true;
      render();
      var t = byId('chat-timeline');
      // Anchor on the distance from the BOTTOM: prepending changes scrollHeight,
      // and holding scrollTop would drop the reader wherever the new content
      // happened to push their line.
      var fromBottom = t ? t.scrollHeight - t.scrollTop : 0;

      return invoke('matrix_backfill', { guildId: S.guildId, roomId: room, limit: 40 })
        .then(function (res) {
          if (S.roomId !== room) return;          // they moved on while we waited
          var older = (res && res.messages) || [];
          S.moreHistory = !!(res && res.more);
          S.loadingHistory = false;
          if (older.length) S.messages = older.concat(S.messages);
          wasAtBottom = false;                     // reading history, not following
          render();
          var back = byId('chat-timeline');
          if (back) back.scrollTop = back.scrollHeight - fromBottom;
        })
        .catch(function () {
          S.loadingHistory = false;
          // Stop asking: a failing page will fail again on the next scroll and
          // the reader would get a stutter instead of a log.
          S.moreHistory = false;
          render();
        });
    }
    Chat.loadHistory = loadHistory;

    // Called before a re-render decides whether to follow.
    var wasAtBottom = true;
    function noteScrollPosition() { wasAtBottom = atBottom(); }

    function keepPlace(prevTop) {
      var t = byId('chat-timeline');
      if (!t) return;
      if (wasAtBottom) { t.scrollTop = t.scrollHeight; return; }
      // Hold the reader where they were. Not perfect across a height change,
      // but vastly better than jumping to either end.
      t.scrollTop = prevTop;
    }

    // Whether the next render follows the conversation to its end. Opening a
    // room and sending a message both say yes; reading history says no.
    function following(v) {
      if (arguments.length) wasAtBottom = !!v;
      return wasAtBottom;
    }

    return {
      noteTyping: noteTyping, stopTyping: stopTyping, atBottom: atBottom, scrollToEnd: scrollToEnd,
      maybeLoadHistory: maybeLoadHistory, loadHistory: loadHistory, noteScrollPosition: noteScrollPosition,
      keepPlace: keepPlace, following: following,
    };
  };
})();
