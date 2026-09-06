// Comms — the room page: header actions, the topic, the upgrade and
// encryption notices, the pinned strip, the timeline with its rules and
// dividers, the typing and seen lines, and the composer mounted at the foot
// of the panel.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatroom.test.mjs can drive it with a stub `invoke`
// and a stub StructsChatRow:
//
//   window.ChatRoom({ el, icon, byId, clear, invoke, go, S, Chat, render, pageHeader, noticeBlock,
//                     dayKey, dayLabel, refreshRooms, openRoom, markRead, typingLine, setMuted,
//                     openSearch, pinnedStrip, seenLine, ruleNode, historyButton, messageNode,
//                     excerpt, editChip, cancelEdit, maybeLoadHistory, noteTyping, submit,
//                     complete, recall, resetCompletion, clearCompletionHint })
//     → { renderRoom, composer, replyChip }
(function () {
  'use strict';
  window.ChatRoom = function (ctx) {
    var el = ctx.el, icon = ctx.icon, byId = ctx.byId, clear = ctx.clear, invoke = ctx.invoke, go = ctx.go;
    var S = ctx.S, Chat = ctx.Chat || {}, render = ctx.render, pageHeader = ctx.pageHeader, noticeBlock = ctx.noticeBlock;
    var dayKey = ctx.dayKey, dayLabel = ctx.dayLabel, refreshRooms = ctx.refreshRooms, openRoom = ctx.openRoom;
    var markRead = ctx.markRead, typingLine = ctx.typingLine, setMuted = ctx.setMuted, openSearch = ctx.openSearch;
    var pinnedStrip = ctx.pinnedStrip, seenLine = ctx.seenLine, ruleNode = ctx.ruleNode, historyButton = ctx.historyButton;
    var messageNode = ctx.messageNode, excerpt = ctx.excerpt, editChip = ctx.editChip, cancelEdit = ctx.cancelEdit;
    var maybeLoadHistory = ctx.maybeLoadHistory, noteTyping = ctx.noteTyping, submit = ctx.submit, complete = ctx.complete;
    var recall = ctx.recall, resetCompletion = ctx.resetCompletion, clearCompletionHint = ctx.clearCompletionHint;

    function renderRoom() {
      var page = el('div', 'chat-page');
      var name = (S.room && (S.room.name || S.room.canonical_alias)) || S.roomId || '';

      var right = el('div', 'chat-header-actions');

      var who = el('a', 'sui-nav-btn');
      who.id = 'chat-room-people';
      who.href = 'javascript:void(0)';
      who.title = 'Who is here';
      who.appendChild(icon('icon-member sui-text-secondary'));
      who.addEventListener('click', function () { go('members'); });
      right.appendChild(who);

      var muted = !!(S.room && S.room.muted);
      var quiet = el('a', 'sui-nav-btn');
      quiet.id = 'chat-room-mute';
      quiet.href = 'javascript:void(0)';
      quiet.title = muted ? 'This room is silenced — let it speak again'
                          : 'Silence this room';
      quiet.appendChild(icon((muted ? 'icon-disabled sui-text-warning'
                                    : 'icon-alert sui-text-secondary')));
      quiet.addEventListener('click', function () { setMuted(!muted); });
      right.appendChild(quiet);

      var find = el('a', 'sui-nav-btn');
      find.id = 'chat-room-search';
      find.href = 'javascript:void(0)';
      find.title = 'Search this conversation';
      find.appendChild(icon('icon-guild-directory sui-text-secondary'));
      find.addEventListener('click', function () { openSearch(true); });
      right.appendChild(find);

      var gear = el('a', 'sui-nav-btn');
      gear.href = 'javascript:void(0)';
      gear.title = 'Connection';
      gear.appendChild(icon('icon-menu sui-text-secondary'));
      gear.addEventListener('click', function () { go('connection'); });
      right.appendChild(gear);

      page.appendChild(pageHeader(name, function () { go('channels'); }, right));

      // IRC has shown the topic since the beginning: it is the room's own
      // statement of what it is for, and hiding it behind a command wastes it.
      if (S.room && S.room.topic) {
        page.appendChild(el('div', 'chat-topic', S.room.topic));
      }

      // The room has been upgraded and the conversation is somewhere else. The
      // old room stays joinable and stays in the list, so nothing else would
      // tell a player they are talking to an empty room.
      if (S.room && S.room.replaced_by) {
        var moved = el('div', 'chat-encrypted chat-mod-moved');
        moved.appendChild(icon('icon-link-out sui-text-warning', 'sui-icon-md'));
        moved.appendChild(el('span', null,
          'This room has been replaced. The conversation continues in a new one.'));
        // NOT `go` — `var` hoists to the whole function, and a local of that
        // name shadows the module's `go()` navigator for every other handler in
        // this render, including the member-list button that has nothing to do
        // with upgrades.
        var goThere = el('a', 'chat-ref-action');
        goThere.href = 'javascript:void(0)';
        goThere.appendChild(el('span', null, 'Go there'));
        goThere.addEventListener('click', function () {
          var target = S.room.replaced_by;
          // Joining first: an upgraded room is usually one this account has
          // never been in, and opening it without joining shows an empty
          // screen that looks like the upgrade lost the history.
          invoke('matrix_join', { guildId: S.guildId, roomId: target })
            .catch(function () {})            // already in it is not a failure
            .then(function () { return refreshRooms(); })
            .then(function () { openRoom(target); });
        });
        moved.appendChild(goThere);
        page.appendChild(moved);
      }

      // Said once, at the top, because the alternative is a player scrolling a
      // wall of "encrypted message" wondering what is broken. Element makes
      // direct messages encrypted by default, so this is not a rare corner.
      if (S.room && S.room.encrypted) {
        var enc = el('div', 'chat-encrypted');
        enc.appendChild(icon('icon-key sui-text-warning', 'sui-icon-md'));
        enc.appendChild(el('span', null,
          'This conversation is end-to-end encrypted. Structs cannot read it \u2014 '
          + 'use a Matrix client with encryption to follow it.'));
        page.appendChild(enc);
      }

      var pins = pinnedStrip();
      if (pins) page.appendChild(pins);

      var scroll = el('div', 'chat-scroll');
      scroll.id = 'chat-timeline';
      scroll.addEventListener('scroll', maybeLoadHistory);
      // The top of the log says what is above it: more to come, or the beginning
      // of the room. Shown even when the visible log is EMPTY — a room whose
      // recent window happens to be quiet may still have history, and offering
      // no way to reach it is indistinguishable from having none.
      if (S.messages.length || S.moreHistory || S.loadingHistory) {
        scroll.appendChild(S.loadingHistory
          ? ruleNode('Loading')
          : (S.moreHistory ? historyButton() : ruleNode('Beginning')));
      }
      if (!S.messages.length) {
        scroll.appendChild(noticeBlock('Quiet', 'Nothing has been said here yet.'));
      } else {
        var dividerDone = false;
        S.messages.forEach(function (m, i) {
          var prev = i > 0 ? S.messages[i - 1] : null;

          // Day separator: a timeline with no dates is a timeline you cannot
          // date. Only between days, never above the first message.
          // An event line carries its own time, so a date rule between two of
          // them is noise on noise.
          // A gap has no time — it is a hole, not a moment — so it must not
          // drag a date rule in with it. Its `ts` of 0 dated it to the epoch
          // and printed "31 Dec 1969" above every break in the record.
          var timeless = m.kind === 'gap' || (prev && prev.kind === 'gap');
          if (prev && !timeless && dayKey(m.ts) !== dayKey(prev.ts)
              && !((m.kind === 'event') && (prev.kind === 'event'))) {
            scroll.appendChild(ruleNode(dayLabel(m.ts)));
          }

          // Unread divider: where you stopped reading, held still while you
          // read on. IRC has drawn this line since ircII and it is still the
          // fastest way to answer "what did I miss".
          if (!dividerDone && S.dividerTs && prev && Number(m.ts) > S.dividerTs
              && Number(prev.ts) <= S.dividerTs) {
            scroll.appendChild(ruleNode('New', true));
            dividerDone = true;
          }

          scroll.appendChild(messageNode(m, prev));
        });
      }
      page.appendChild(scroll);

      // Everything on screen counts as read from here on — locally, and on the
      // homeserver so the player's other Matrix clients agree.
      if (S.messages.length) {
        var newest = S.messages[S.messages.length - 1];
        S.lastRead[S.roomId] = Number(newest.ts) || 0;
        markRead(S.roomId, newest.event_id);
      }

      // Between the log and the composer, where MSN put it: the one line that
      // tells you an answer is already being written.
      var typing = el('div', 'chat-typing');
      typing.id = 'chat-typing';
      typing.textContent = typingLine(S.typing);
      if (!S.typing.length) typing.classList.add('hidden');
      page.appendChild(typing);

      // Below it: who has seen what you last said. Both lines are about what
      // other people are doing right now, and neither is part of the
      // conversation — so neither belongs in the log itself.
      var seen = seenLine();
      if (seen) page.appendChild(seen);

      // The composer is mounted OUTSIDE the page, in its own host at the foot of
      // the panel — see chat.html. Rendering it into the page would put it back
      // inside the screen's border.
      var host = byId('chat-composer-host');
      if (host) { clear(host); host.appendChild(composer()); }
      return page;
    }

    // ── Composer ────────────────────────────────────────────────────────────
    // The game's ACTION BAR, not a form: a .sui-panel of chunks between two
    // panel edges — portrait chunk, connector, screen chunk, connector, button
    // chunk — exactly as ActionBarComponent assembles the HUD's bottom bars.
    // The metal frame, the inset screen and the button face are all the panel's
    // own art; nothing here draws a control of its own.
    // A chip above the bar naming what is being answered, with a way out. A
    // reply target you cannot see is one you forget you set, and the next
    // message goes somewhere surprising.
    function replyChip() {
      if (!S.replyTo) return null;
      var m = S.replyTo;
      var chip = el('div', 'chat-reply-chip');
      chip.id = 'chat-reply-chip';
      chip.appendChild(icon('icon-incoming sui-text-secondary', 'sui-icon-sm'));
      chip.appendChild(el('span', 'chat-reply-who', m.sender_name || m.sender));
      chip.appendChild(el('span', 'chat-reply-text', excerpt(m.body)));
      var x = el('a', 'chat-reply-cancel');
      x.href = 'javascript:void(0)';
      x.title = 'Stop replying';
      x.appendChild(icon('icon-close sui-text-secondary', 'sui-icon-sm'));
      x.addEventListener('click', function () { S.replyTo = null; render(); });
      chip.appendChild(x);
      return chip;
    }

    function composer() {
      var wrap = el('div', 'sui-panel-wrapper-fit-content');
      wrap.id = 'chat-composer';
      var chip = editChip() || replyChip();
      if (chip) wrap.appendChild(chip);
      // Filled in by `applyCompletion` while Tab is cycling. Written to
      // directly rather than through render(), which would rebuild the field
      // and throw away the caret mid-completion.
      var hint = el('div', 'chat-complete-hint');
      hint.id = 'chat-complete-hint';
      wrap.appendChild(hint);
      /* The shared composer in `chatrow.js`, which is this window's own panel.
       *
       * It was built inline here while `StructsChatRow.composer()` built a
       * near-copy for the raid rail — so the two drifted, and the rail grew a
       * `.sui-panel-chunk-spacer-indicator` bar under the face and a different
       * send-button wrapper. Same code now; the differences cannot come back. */
      var made = window.StructsChatRow.composer({
        inputId: 'chat-input',
        sendId: 'chat-send',
        portraitId: 'chat-composer-portrait',
        placeholder: 'Message, or /help',
        pfpAttrs: S.profile && S.profile.pfp_attrs,
      });
      var panel = made.node.firstChild;
      var input = made.input;
      var send = made.send;
      var portrait = made.portrait;

      // Your face always renders in HERE. Whether anyone else can see it is a
      // different question — other clients read the homeserver's avatar, which
      // the app publishes for you. Say which state you are in, on the one
      // element that is already the subject.
      portrait.setAttribute('data-sui-mod-placement', 'top');
      portrait.setAttribute('data-sui-tooltip',
        S.profile && S.profile.avatar_published
          ? 'Your portrait is published — other clients see this face'
          : 'Your portrait is not published yet; it will be shortly');

      input.addEventListener('input', function () {
        resetCompletion();
        clearCompletionHint();
        noteTyping(input.value);
      });
      // The shared builder returns its own fit-content wrapper; this window
      // already has one (it carries the reply chip and the completion hint), so
      // only the panel moves across.
      wrap.appendChild(panel);


      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
        // Escape drops the reply first. Only once there is none does Escape
        // mean "leave the room" — the usual innermost-thing-first rule.
        if (e.key === 'Escape' && S.editing) {
          e.preventDefault(); e.stopPropagation();
          cancelEdit();
          return;
        }
        if (e.key === 'Escape' && S.replyTo) {
          e.preventDefault(); e.stopPropagation();
          S.replyTo = null; render();
          var again = byId('chat-input');
          if (again) again.focus();
          return;
        }
        if (e.key === 'Tab') { e.preventDefault(); complete(input, e.shiftKey); return; }
        // Up/Down walk what you have already sent — every IRC client and every
        // shell does this, and it is the fastest way to fix a typo or repeat a
        // command. Only from the ends of the line, so it never fights editing.
        if (e.key === 'ArrowUp' && input.selectionStart === 0) {
          e.preventDefault(); recall(input, -1); return;
        }
        if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
          e.preventDefault(); recall(input, 1);
        }
      });
      send.addEventListener('click', submit);
      return wrap;
    }

    return { renderRoom: renderRoom, composer: composer, replyChip: replyChip };
  };
})();
