// Comms — the composer's keyboard memory: Tab completion and input history.
//
// IRC's two great ideas. Tab completes the word at the cursor (a command
// when the line starts with "/", otherwise an id stem or the name of someone
// who has spoken here) and cycles on repeat; Up/Down walk what you sent and
// come back to the draft you were on. Pure over the chat state `S` and a
// text input, which is what makes it the easiest section to test.
//
// Extracted from chat.js (2026-09-05). Collaborators arrive as a context:
//
//   window.ChatComplete({ el, byId, refIdsIn, wantRefs, refCards, commands, S, Chat })
//     → { complete, resetCompletion, applyCompletion, clearCompletionHint,
//         completionsFor, idCompletions, recall, rememberSent, moveCaretToEnd }
//
// `commands` is a thunk: the command table is declared later in chat.js.
(function () {
  'use strict';
  window.ChatComplete = function (ctx) {
    var el = ctx.el, byId = ctx.byId, refIdsIn = ctx.refIdsIn, wantRefs = ctx.wantRefs;
    var refCards = ctx.refCards, commands = ctx.commands, S = ctx.S, Chat = ctx.Chat || {};

    // ── Tab completion ────────────────────────────────────────────────────────
    // IRC's other great idea. Completes the word at the cursor: a command when
    // the line starts with "/", otherwise the name of someone who has spoken
    // here. Tab again cycles the matches; Shift+Tab walks back.
    // What the last Tab produced, so the next one can replace it instead of
    // completing the empty space it left behind.
    var cycle = null;

    // An id stem: `2-`, `2-15`, or a bare type number followed by the dash.
    // Deliberately requires the dash — a bare `2` is far more likely to be a
    // quantity than the start of an id, and completing it would fight typing.
    var ID_STEM = /^\d{1,2}-\d*$/;

    function completionsFor(word, isCommand) {
      var lower = word.toLowerCase();
      if (isCommand) {
        return commands().map(function (c) { return '/' + c.name; })
          .filter(function (n) { return n.toLowerCase().indexOf('/' + lower) === 0; });
      }
      if (ID_STEM.test(word)) return idCompletions(word);
      var seen = {};
      S.messages.forEach(function (m) {
        if (m.local || m.self || !m.sender_name) return;
        seen[m.sender_name] = 1;
      });
      // Everyone in the room's history, plus the people list if it is loaded —
      // so a name is completable before its owner has said anything here.
      S.people.forEach(function (p) { if (p.username) seen[p.username] = 1; });
      return Object.keys(seen)
        .filter(function (n) { return n.toLowerCase().indexOf(lower) === 0; })
        .sort();
    }

    // Every id worth offering, nearest first.
    //
    // Two sources, and the order is the point. What this ROOM has already talked
    // about comes first: "what was that planet again" is a question the
    // conversation itself answers, and the id is almost always one somebody just
    // said. Your own objects come after — you know those, they are here so they
    // are never mistyped.
    function idCompletions(stem) {
      var out = [];
      var seen = {};
      var push = function (id) {
        if (!id || seen[id] || id.indexOf(stem) !== 0) return;
        seen[id] = 1;
        out.push(id);
      };
      // Most recent first: the id being asked about is usually the last one said.
      for (var i = S.messages.length - 1; i >= 0; i--) {
        refIdsIn(S.messages[i].body).forEach(push);
      }
      (S.myIds || []).forEach(function (o) { push(o.id); });
      return out;
    }
    Chat.idCompletions = idCompletions;

    function applyCompletion(input, c) {
      var pick = c.matches[c.at];
      // A completed NAME becomes `@Name`: it is the universal convention, and it
      // is what lets the message carry a real mention when it is sent — without
      // the marker there is nothing to match and nobody gets notified. An ID is
      // already in the form the game and this window both read; prefixing it
      // would turn a reference into a mention of nobody.
      if (!c.isCommand && !ID_STEM.test(pick) && !/^\d{1,2}-\d+$/.test(pick)
          && pick.charAt(0) !== '@') {
        pick = '@' + pick;
      }
      var suffix = ' ';
      var text = pick + suffix;
      input.value = c.head + text + c.tail;
      var caret = c.start + text.length;
      try { input.setSelectionRange(caret, caret); } catch (e) {}
      c.value = input.value;
      c.caret = caret;
      showCompletionHint(c);
    }

    // "Which one is 2-15361" is the question Tab-cycling raises, and the card
    // for that id is usually already resolved — it was mentioned in this room,
    // which is how it got into the list.
    function showCompletionHint(c) {
      var box = byId('chat-complete-hint');
      if (!box) return;
      box.textContent = '';
      var pick = c && c.matches && c.matches[c.at];
      if (!pick || !/^\d{1,2}-\d+$/.test(pick)) return;

      var card = refCards[pick];
      var mine = (S.myIds || []).filter(function (o) { return o.id === pick; })[0];
      var what = card ? (card.title || '') : '';
      var sub = card ? (card.subtitle || '') : (mine ? mine.label : '');
      if (!what && !sub) {
        // Not resolved yet. Ask, and say so meanwhile rather than showing an
        // id with nothing beside it — silence reads as "no such object".
        wantRefs([pick]);
        box.appendChild(el('span', 'chat-complete-id', pick));
        box.appendChild(el('span', 'chat-complete-what', 'looking it up…'));
        return;
      }
      box.appendChild(el('span', 'chat-complete-id', pick));
      box.appendChild(el('span', 'chat-complete-what', [what, sub].filter(Boolean).join(' · ')));
      if (c.matches.length > 1) {
        box.appendChild(el('span', 'chat-complete-of',
          (c.at + 1) + '/' + c.matches.length));
      }
    }

    function clearCompletionHint() {
      var box = byId('chat-complete-hint');
      if (box) box.textContent = '';
    }

    function complete(input, backwards) {
      var value = String(input.value || '');
      var caret = input.selectionStart == null ? value.length : input.selectionStart;

      // A repeat Tab on an untouched result cycles rather than re-matching —
      // otherwise the space this just inserted becomes the next (empty) stem.
      if (cycle && cycle.value === value && cycle.caret === caret && cycle.matches.length) {
        cycle.at = backwards
          ? (cycle.at - 1 + cycle.matches.length) % cycle.matches.length
          : (cycle.at + 1) % cycle.matches.length;
        applyCompletion(input, cycle);
        return;
      }

      var head = value.slice(0, caret);
      var tail = value.slice(caret);
      var start = head.lastIndexOf(' ') + 1;
      var word = head.slice(start);
      var isCommand = start === 0 && word.charAt(0) === '/';
      // `@ne<Tab>` and `ne<Tab>` complete the same person.
      var stem = isCommand ? word.slice(1) : word.replace(/^@/, '');
      // A bare "/" and Tab walks the whole command list, the way it does in
      // every IRC client. A bare word does not — completing "everyone" off an
      // empty stem is noise, not help.
      if (!stem && !isCommand) { cycle = null; return; }

      var matches = completionsFor(stem, isCommand);
      if (!matches.length) { cycle = null; return; }
      cycle = {
        matches: matches, at: backwards ? matches.length - 1 : 0,
        head: value.slice(0, start), tail: tail, start: start, isCommand: isCommand,
      };
      applyCompletion(input, cycle);
    }
    Chat.complete = complete;

    function resetCompletion() { cycle = null; }

    // ── Input history ─────────────────────────────────────────────────────────
    // `sentAt` is an index into S.sent, or -1 meaning "on a fresh line". Walking
    // past the newest returns to the draft that was in progress, so recalling by
    // accident costs nothing.
    var draftBeforeRecall = '';

    function recall(input, dir) {
      if (!S.sent.length) return;
      if (S.sentAt === -1) {
        if (dir > 0) return;                       // nothing newer than a fresh line
        draftBeforeRecall = input.value;
        S.sentAt = S.sent.length - 1;
      } else {
        S.sentAt += dir;
        if (S.sentAt < 0) S.sentAt = 0;
        if (S.sentAt >= S.sent.length) {
          S.sentAt = -1;
          input.value = draftBeforeRecall;
          moveCaretToEnd(input);
          return;
        }
      }
      input.value = S.sent[S.sentAt];
      moveCaretToEnd(input);
    }
    Chat.recall = recall;

    function moveCaretToEnd(input) {
      var end = input.value.length;
      try { input.setSelectionRange(end, end); } catch (e) {}
    }

    function rememberSent(text) {
      // No consecutive duplicates: sending the same thing twice should not make
      // Up press twice to get past it.
      if (S.sent[S.sent.length - 1] !== text) S.sent.push(text);
      if (S.sent.length > 100) S.sent = S.sent.slice(-100);
      S.sentAt = -1;
      draftBeforeRecall = '';
    }


    return {
      complete: complete, resetCompletion: resetCompletion, applyCompletion: applyCompletion,
      clearCompletionHint: clearCompletionHint, completionsFor: completionsFor, idCompletions: idCompletions,
      recall: recall, rememberSent: rememberSent, moveCaretToEnd: moveCaretToEnd,
    };
  };
})();
