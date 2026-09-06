// Comms — the command line and the send path.
//
// IRC's best idea: the composer is also the command line. `submit` decides
// what a line is (an edit, an escaped slash, a command, a message);
// `runCommand` runs the table; `sendMessage` shows the optimistic echo and
// keeps a failed one on screen with a retry. `say` is the window talking to
// you: local only, never sent.
//
// Extracted from chat.js (2026-09-05). Every collaborator arrives as a
// context function, so this file never reaches into the chat closure:
//
//   window.ChatCommands({ byId, invoke, excerpt, go, openSearch, refreshRooms,
//                         startDm, commitEdit, rememberSent, resetCompletion,
//                         render, scrollToEnd, stopTyping, mentionsIn,
//                         atBottom, refCards, S, Chat })
//     → { SHORTCUTS, COMMANDS, submit, say, runCommand, sendMessage, retrySend }
(function () {
  'use strict';
  window.ChatCommands = function (ctx) {
    var byId = ctx.byId, invoke = ctx.invoke, excerpt = ctx.excerpt, go = ctx.go;
    var openSearch = ctx.openSearch, refreshRooms = ctx.refreshRooms, startDm = ctx.startDm;
    var commitEdit = ctx.commitEdit, rememberSent = ctx.rememberSent, resetCompletion = ctx.resetCompletion;
    var render = ctx.render, scrollToEnd = ctx.scrollToEnd, stopTyping = ctx.stopTyping, mentionsIn = ctx.mentionsIn;
    var atBottom = ctx.atBottom, refCards = ctx.refCards, S = ctx.S, Chat = ctx.Chat || {};

    // IRC's best idea: the composer is also the command line. No new UI, no menu
    // to hunt through, and everything the window can do has a name you can type.
    //
    // A leading "//" escapes, so a message that genuinely starts with a slash is
    // still sendable — the same escape ircII shipped in 1990.
    // Every key this window answers to, in one place — the handler runs from
    // this table and /help prints it, so a shortcut cannot exist without being
    // documented or be documented without existing.
    //
    // Entries with no `run` are handled where their context lives (inside the
    // composer, inside a field) and appear here only so the list is complete.
    var SHORTCUTS = [
      { keys: 'Ctrl/Cmd-K', help: 'Jump to a channel',
        match: function (e) { return (e.metaKey || e.ctrlKey) && /^k$/i.test(e.key); },
        run: function () {
          S.roomFilter = '';
          S.filterWanted = true;
          go('channels');
        } },
      { keys: 'Ctrl/Cmd-F', help: 'Search what was said',
        match: function (e) { return (e.metaKey || e.ctrlKey) && /^f$/i.test(e.key); },
        run: function () { openSearch(S.view === 'room'); } },
      { keys: 'Tab', help: 'Complete a name, an id or a command' },
      { keys: 'Up / Down', help: 'Walk back through what you have sent' },
      { keys: 'Enter', help: 'Send — or open the top match when filtering' },
      { keys: 'Escape', help: 'Back out one step: reply, edit, filter, then room' },
    ];
    Chat.SHORTCUTS = SHORTCUTS;

    var COMMANDS = [
      { name: 'me', args: '<action>', help: 'Send an action: * you wave' },
      { name: 'msg', args: '<player> [message]', help: 'Open a direct message' },
      { name: 'join', args: '<room>', help: 'Join a room by name or alias' },
      { name: 'leave', args: '', help: 'Leave the room you are in' },
      { name: 'topic', args: '', help: 'Show what this room is about' },
      { name: 'who', args: '', help: 'Who has spoken here' },
      { name: 'whois', args: '<player>', help: 'Look a player up' },
      { name: 'help', args: '', help: 'This list' },
    ];

    function submit() {
      var input = byId('chat-input');
      if (!input) return;
      var raw = String(input.value || '');
      var text = raw.trim();
      if (!text) return;
      input.value = '';
      resetCompletion();

      rememberSent(text);

      // "//foo" → send the literal "/foo".
      // Editing takes the line before anything else does. A slash command typed
      // while editing would otherwise run instead of correcting the message,
      // which is a surprising way to lose a correction.
      if (S.editing) { commitEdit(text); return; }
      if (text.indexOf('//') === 0) { sendMessage(text.slice(1)); return; }
      if (text.charAt(0) === '/') { runCommand(text.slice(1)); return; }
      sendMessage(text);
    }

    // A line the window says to you: command output, errors, confirmations.
    // Local only — never sent, never leaves the client, dropped on room change.
    var localSeq = 0;
    function say(body, isError) {
      S.messages.push({
        event_id: 'local-' + (++localSeq),
        sender: 'system', sender_name: 'Comms', kind: 'notice',
        local: true, failed: !!isError, body: body, ts: Date.now(),
      });
      if (S.messages.length > 500) S.messages = S.messages.slice(-500);
      atBottom();                  // an answer to something you typed
      render();
      scrollToEnd();
    }
    Chat.say = say;

    function runCommand(line) {
      var sp = line.indexOf(' ');
      var name = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
      var rest = sp === -1 ? '' : line.slice(sp + 1).trim();

      switch (name) {
        case 'help':
          say('Commands:\n' + COMMANDS.map(function (c) {
            return '  /' + c.name + (c.args ? ' ' + c.args : '') + '  —  ' + c.help;
          }).join('\n') +
            '\nStart a message with // to send a literal slash.' +
            '\n\nKeys:\n' + SHORTCUTS.map(function (k) {
              return '  ' + k.keys + '  —  ' + k.help;
            }).join('\n'));
          return;

        case 'me':
          if (!rest) { say('/me needs something to do.', true); return; }
          sendMessage(rest, 'm.emote');
          return;

        case 'msg': {
          if (!rest) { say('/msg needs a player id or name.', true); return; }
          var m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
          var who = m[1].replace(/^[@#]/, '');
          var body = m[2];
          startDm(who, body || null);
          return;
        }

        case 'join':
          if (!rest) { say('/join needs a room.', true); return; }
          invoke('matrix_join', { guildId: S.guildId, roomId: rest })
            .then(function () { say('Joined ' + rest + '.'); return refreshRooms(); })
            .catch(function (e) { say(String(e), true); });
          return;

        case 'leave': {
          if (!S.roomId) { say('/leave only works inside a room.', true); return; }
          var leaving = S.roomId;
          invoke('matrix_leave', { guildId: S.guildId, roomId: leaving })
            .then(function () { go('channels'); })
            .catch(function (e) { say(String(e), true); });
          return;
        }

        case 'topic':
          say((S.room && S.room.topic) || 'This room has no topic.');
          return;

        case 'whois': {
          if (!rest) { say('/whois needs a player id.', true); return; }
          var pid = rest.split(/\s+/)[0].replace(/^[@#]/, '');
          // Reuses the reference machinery: the card /whois wants is exactly the
          // card an id in a message already produces.
          invoke('matrix_refs', { ids: [pid] })
            .then(function (res) {
              var card = (res && res.refs || [])[0];
              if (!card) { say('No ' + pid + ' on the chain.', true); return; }
              refCards[card.id] = card;
              S.openRefs[card.id] = 1;
              say(pid);
            })
            .catch(function (e) { say(String(e), true); });
          return;
        }

        case 'who': {
          var seen = {};
          S.messages.forEach(function (msg) {
            if (msg.local || !msg.sender_name) return;
            seen[msg.sender_name] = msg.sender_tag || '';
          });
          var names = Object.keys(seen).sort();
          say(names.length
            ? 'Heard from ' + names.length + ': ' + names.map(function (n) {
                return (seen[n] ? '[' + seen[n] + '] ' : '') + n;
              }).join(', ')
            : 'Nobody has spoken here yet.');
          return;
        }

        default:
          // Never send an unrecognised command as chat — the classic IRC
          // embarrassment is "/qui" arriving in the channel as a message.
          say('No command /' + name + '. Try /help.', true);
      }
    }
    Chat.runCommand = runCommand;

    // Optimistic echo: the message shows immediately, dimmed, and is replaced
    // when the homeserver echoes it back through sync. A send that fails stays
    // on screen in the error colour rather than disappearing with the text.
    var pendingSeq = 0;
    function sendMessage(text, msgtype) {
      var localId = 'pending-' + (++pendingSeq);
      // Taken now, not read at the end: the field is cleared as part of sending
      // and a slow round trip must not lose what this was answering.
      var answering = S.replyTo;
      S.replyTo = null;
      var msg = {
        event_id: localId,
        sender: (S.profile && S.profile.user_id) || 'me',
        sender_name: (S.profile && S.profile.display_name) || 'You',
        sender_tag: (S.profile && S.profile.tag) || null,
        body: text,
        kind: msgtype === 'm.emote' ? 'emote' : 'text',
        self: true, pending: true,
        ts: Date.now(),
        // The echo shows the quote too, so a reply looks like a reply the
        // instant it is written rather than when sync catches up.
        reply_to: answering ? answering.event_id : undefined,
        reply_sender: answering ? answering.sender : undefined,
        reply_excerpt: answering ? excerpt(answering.body) : undefined,
      };
      S.messages.push(msg);
      stopTyping();
      // Your own message always wins the scroll — you just wrote it.
      atBottom();
      render();
      scrollToEnd();

      invoke('matrix_send', {
        guildId: S.guildId, roomId: S.roomId, body: text, msgtype: msgtype || null,
        // Who this message is FOR. Without it the recipient's client never
        // notifies them, however clearly the text names them.
        mentions: mentionsIn(text),
        replyTo: answering ? {
          eventId: answering.event_id,
          sender: answering.sender,
          body: answering.body,
        } : null,
      })
        .then(function (res) {
          // Keep the local echo until sync delivers the real event; just stop
          // dimming it. dropEcho() removes it when the echo arrives.
          msg.pending = false;
          if (res && res.event_id) msg.echo_of = res.event_id;
          render();
        })
        .catch(function (e) {
          msg.pending = false;
          msg.failed = true;
          // The error goes BESIDE the message, never into it. Appending it to
          // the body entangled the player's own words with a diagnostic — so
          // copying the text to send again copied "— not sent (…)" with it, and
          // nothing could offer a retry without first un-mangling the string.
          msg.error = String(e);
          msg.retry = { text: text, msgtype: msgtype, replyTo: answering };
          render();
        });
    }

    // Send it again, exactly as it was written.
    //
    // The failed echo is dropped first: leaving it would put the same words on
    // screen twice, and the one that stays should be the attempt that is
    // actually in flight.
    function retrySend(m) {
      var again = m.retry;
      if (!again) return;
      S.messages = S.messages.filter(function (x) { return x !== m; });
      // Restore what was being answered, so a retried reply is still a reply.
      S.replyTo = again.replyTo || null;
      render();
      sendMessage(again.text, again.msgtype);
    }
    Chat.retrySend = retrySend;


    return {
      SHORTCUTS: SHORTCUTS, COMMANDS: COMMANDS, submit: submit, say: say,
      runCommand: runCommand, sendMessage: sendMessage, retrySend: retrySend,
    };
  };
})();
