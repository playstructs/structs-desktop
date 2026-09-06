// Comms — one message in the timeline: the shared row from chatrow.js plus
// what only a full timeline has (react, reply, pin, edit, delete), the body
// with the ids and links inside it marked, the quote line, the cards for
// whatever it named, pictures, and the labelled rules between messages.
//
// The body is textContent for every character: it is split on span
// boundaries and each piece is set as text, so no markup from a federated
// homeserver is ever parsed. The only nodes added are ones this file creates.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatmessage.test.mjs can drive it with a stub
// `invoke` and a stub StructsChatRow:
//
//   window.ChatMessage({ el, invoke, render, mentionsMe, startDm, refCards, refCard, wantRefs,
//                        ID_RE, REF_KINDS, loadHistory, retrySend, workCard, serverIdOf,
//                        reactButton, reactionRow, editButton, deleteButton, replyButton,
//                        pinToggle, isPinned, jumpTo, replyWho, S, Chat })
//     → { messageNode, trimUrl, refIdsIn, spansIn, fillBody, linkChip, idChip,
//         historyButton, imageNode, ruleNode, URL_RE }
(function () {
  'use strict';
  window.ChatMessage = function (ctx) {
    var el = ctx.el, invoke = ctx.invoke, render = ctx.render, mentionsMe = ctx.mentionsMe, startDm = ctx.startDm;
    var refCards = ctx.refCards, refCard = ctx.refCard, wantRefs = ctx.wantRefs, ID_RE = ctx.ID_RE, REF_KINDS = ctx.REF_KINDS;
    var loadHistory = ctx.loadHistory, retrySend = ctx.retrySend, workCard = ctx.workCard, serverIdOf = ctx.serverIdOf;
    var reactButton = ctx.reactButton, reactionRow = ctx.reactionRow, editButton = ctx.editButton, deleteButton = ctx.deleteButton;
    var replyButton = ctx.replyButton, pinToggle = ctx.pinToggle, isPinned = ctx.isPinned, jumpTo = ctx.jumpTo, replyWho = ctx.replyWho;
    var S = ctx.S, Chat = ctx.Chat || {};

    function messageNode(m, prev) {
      /* The shared row from `chatrow.js`, plus what only a full timeline has.
       *
       * The presentation — event lines, emotes, run-collapsing, the mention
       * rail, the clock — moved there so the raid viewer's rail could draw the
       * SAME rows instead of a lookalike that had already drifted from these.
       * What stays here is what the rail does not have: react, reply, pin, edit
       * and delete, handed over as a `controls` hook.
       */
      var wrap = window.StructsChatRow.render(m, prev, {
        gapNode: function () { return ruleNode('some messages are missing', true); },
        mentionsMe: mentionsMe,
        // Any player is directly addressable, so their name is the affordance.
        onSender: function (msg) { startDm(msg.player_id); },
        controls: function (msg, meta) {
          // Pinning lives on the message, revealed on hover — always visible it
          // would be a column of beacons down a conversation nobody is pinning.
          // The id the SERVER knows this by: a message you just sent still
          // carries its local echo id, but the send already came back with the
          // real one — and without this, the message you most want to take back
          // is the one message with no controls at all.
          var serverId = serverIdOf(msg);
          if (S.view !== 'room' || msg.pending || !serverId) return;
          meta.appendChild(reactButton(msg, serverId));
          meta.appendChild(replyButton(msg));
          meta.appendChild(pinToggle(msg, isPinned(serverId), serverId));
          // Your own only. A moderator could redact anyone's, but offering that
          // to everybody is an invitation to click and be refused.
          if (msg.self && msg.kind !== 'notice') {
            meta.appendChild(editButton(msg, serverId));
            meta.appendChild(deleteButton(msg, serverId));
          }
        },
      });
      // Events and emotes are complete rows on their own — the rest of this
      // function is the body, the quote line and the attachments beneath a head.
      var kind = m.kind || 'text';
      if (kind === 'gap' || kind === 'event' || kind === 'emote') return wrap;

      // Part of a thread, which this window does not group. Saying so is honest;
      // showing the quote Matrix attaches for compatibility would put words in
      // the sender's mouth they never chose — see `render_event`.
      if (m.thread_root && !m.reply_to) {
        var th = el('a', 'chat-reply-quote chat-mod-thread');
        th.href = 'javascript:void(0)';
        th.appendChild(el('span', 'chat-reply-who', 'In a thread'));
        th.title = 'Go to what this thread is about';
        th.addEventListener('click', function () { jumpTo(m.thread_root); });
        wrap.insertBefore(th, wrap.firstChild);
        wrap.classList.add('chat-mod-reply');
      }

      // What this answers. One line, above the message: a pointer back, not a
      // copy — the full text is already up there in the room.
      if (m.reply_to) {
        var q = el('a', 'chat-reply-quote');
        q.href = 'javascript:void(0)';
        q.appendChild(el('span', 'chat-reply-who', replyWho(m)));
        q.appendChild(el('span', 'chat-reply-text', m.reply_excerpt || '…'));
        q.title = 'Go to the message this answers';
        q.addEventListener('click', function () { jumpTo(m.reply_to); });
        wrap.insertBefore(q, wrap.firstChild);
        wrap.classList.add('chat-mod-reply');
      }

      var kind = m.kind || 'text';

      // A picture is shown, not described. The filename stays as the alt text
      // and the tooltip, so it is still knowable.
      if (kind === 'image' && m.mxc) {
        wrap.appendChild(imageNode(m));
        var imgReacts = reactionRow(m);
        if (imgReacts) wrap.appendChild(imgReacts);
        return wrap;
      }

      var body = el('div', 'chat-msg-body');
      if (kind === 'emote') body.classList.add('chat-mod-emote');
      else if (kind === 'notice') body.classList.add('chat-mod-notice');
      else if (kind === 'unknown') body.classList.add('chat-mod-unknown');
      fillBody(body, m.body || '', m.local);
      wrap.appendChild(body);

      // Cards for whatever the message named, under it. Local lines get them too
      // — /whois is exactly "show me this card".
      //
      // Only the FIRST reference expands on its own. A message naming four
      // objects would otherwise bury itself under four cards, and the point of a
      // summary is to be an aside. The rest are chips you can open.
      {
        var ids = refIdsIn(m.body);
        if (ids.length) {
          wantRefs(ids);
          var cards = el('div', 'chat-refs');
          ids.forEach(function (id, i) {
            if (i > 0 && !S.openRefs[id]) return;
            var card = refCards[id];
            if (card) cards.appendChild(refCard(card));
          });
          if (cards.childNodes.length) wrap.appendChild(cards);
        }
      }

      // Why it did not send, and a way to send it again. The text itself is
      // untouched, so retrying needs no un-mangling and copying it copies only
      // what was written.
      if (m.failed && m.retry) {
        var fail = el('div', 'chat-send-failed');
        fail.appendChild(el('span', 'chat-send-failed-why', 'Not sent — ' + (m.error || '')));
        var again = el('a', 'chat-ref-action');
        again.href = 'javascript:void(0)';
        again.appendChild(el('span', null, 'Try again'));
        again.addEventListener('click', function () { retrySend(m); });
        fail.appendChild(again);
        wrap.appendChild(fail);
      }

      var work = workCard(m);
      if (work) wrap.appendChild(work);

      // Last, under everything: reactions are about the message, so they belong
      // below all of it rather than between the text and its cards.
      var reacts = reactionRow(m);
      if (reacts) wrap.appendChild(reacts);
      return wrap;
    }

    // Links. Only http/https are even looked for — Rust refuses anything else,
    // but not offering it in the first place is the better half of that.
    var URL_RE = /https?:\/\/[^\s<>"'`]+/g;
    // Trailing punctuation is almost always the sentence, not the link:
    // "see https://example.com." should not open ".com."
    function trimUrl(u) {
      return u.replace(/[.,;:!?)\]}'"]+$/, '');
    }

    // Everything in a body worth marking, in the order it appears.
    // The ids a message REFERENCES — spans of kind 'id', deduped in order.
    // Not `idsIn`: that one does not know about links, and an id inside a URL is
    // part of the URL. Using different answers for "mark it" and "card it" made
    // a linked planet id produce a card it had no visible chip for.
    function refIdsIn(body) {
      var out = [];
      spansIn(body).forEach(function (sp) {
        if (sp.kind === 'id' && out.indexOf(sp.text) === -1) out.push(sp.text);
      });
      return out;
    }
    Chat.refIdsIn = refIdsIn;

    function spansIn(body) {
      var out = [];
      var m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(body)) !== null) {
        var url = trimUrl(m[0]);
        if (url) out.push({ at: m.index, len: url.length, kind: 'url', text: url });
      }
      ID_RE.lastIndex = 0;
      while ((m = ID_RE.exec(body)) !== null) {
        var id = m[2];
        var at = m.index + m[1].length;
        if (!REF_KINDS[parseInt(id.split('-')[0], 10)]) continue;
        // An id inside a URL is part of the URL, not a reference.
        var inUrl = out.some(function (s) {
          return s.kind === 'url' && at >= s.at && at < s.at + s.len;
        });
        if (!inUrl) out.push({ at: at, len: id.length, kind: 'id', text: id });
      }
      out.sort(function (a, b) { return a.at - b.at; });
      return out;
    }
    Chat.spansIn = spansIn;

    // Write a message body, marking the ids and links inside it.
    //
    // Still textContent for every character: the body is split on span
    // boundaries and each piece is set as text, so no markup from a federated
    // homeserver is ever parsed. The only nodes added are ones this function
    // creates.
    function fillBody(node, body, isLocal) {
      if (isLocal) { node.textContent = body; return; }
      var spans = spansIn(body);
      if (!spans.length) { node.textContent = body; return; }

      var ids = refIdsIn(body);
      var at = 0;
      spans.forEach(function (sp) {
        if (sp.at < at) return;                    // overlapped by an earlier span
        if (sp.at > at) node.appendChild(document.createTextNode(body.slice(at, sp.at)));
        node.appendChild(sp.kind === 'url'
          ? linkChip(sp.text)
          // Built in a helper so each chip's handler closes over ITS id: `var`
          // in a loop is function-scoped, and inline closures would every one of
          // them capture the last id in the message.
          : idChip(sp.text, ids[0] === sp.text));
        at = sp.at + sp.len;
      });
      if (at < body.length) node.appendChild(document.createTextNode(body.slice(at)));
    }

    // A link opens in the SYSTEM browser, never in the app. The full target is
    // the tooltip, because the text of a link in a chat message is written by a
    // stranger and the destination is the only thing worth trusting.
    function linkChip(url) {
      var a = el('a', 'chat-link', url);
      a.href = 'javascript:void(0)';
      a.title = url;
      a.addEventListener('click', function (ev) {
        ev.stopPropagation();
        invoke('matrix_open_url', { url: url }).catch(function (e) {
          a.classList.add('chat-mod-refused');
          a.title = String(e);
        });
      });
      return a;
    }

    function idChip(id, isFirst) {
      var chip = el('span', 'chat-id', id);
      if (isFirst) { chip.title = id; return chip; }
      chip.classList.add('chat-mod-openable');
      chip.title = (S.openRefs[id] ? 'Hide ' : 'Show ') + id;
      chip.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (S.openRefs[id]) delete S.openRefs[id]; else S.openRefs[id] = 1;
        render();
      });
      return chip;
    }

    // Scrolling up loads history on its own; this is for anyone who would rather
    // ask, and it doubles as the marker saying more exists.
    function historyButton() {
      var wrap = el('div', 'chat-history');
      var btn = el('button', 'sui-screen-btn sui-mod-secondary', 'Load earlier');
      btn.id = 'chat-load-earlier';
      btn.addEventListener('click', loadHistory);
      wrap.appendChild(btn);
      return wrap;
    }

    // ── Pictures ──────────────────────────────────────────────────────────────
    // Media is authenticated on a modern homeserver, so the bytes come through
    // Rust (which holds the token) as a data URI. The element is laid out from
    // the event's own dimensions BEFORE they arrive, so the timeline does not
    // jump when each picture lands.
    var mediaCache = {};

    function imageNode(m) {
      var box = el('div', 'chat-image');
      var img = el('img', 'chat-image-img');
      img.alt = m.body || 'image';
      img.title = m.body || '';
      // Reserve the space the picture will take, scaled into the column.
      var w = Number(m.width) || 0;
      var h = Number(m.height) || 0;
      if (w > 0 && h > 0) {
        var shown = Math.min(w, 320);
        box.style.width = shown + 'px';
        box.style.aspectRatio = w + ' / ' + h;
      }

      var have = mediaCache[m.mxc];
      if (have && have.data_url) {
        img.src = have.data_url;
        box.appendChild(img);
      } else if (have && have.error) {
        box.appendChild(el('div', 'chat-image-failed', have.error));
      } else {
        box.appendChild(el('div', 'chat-image-loading', m.body || 'image'));
        if (!have) {
          mediaCache[m.mxc] = { pending: true };
          invoke('matrix_media', { guildId: S.guildId, mxc: m.mxc, size: 320 })
            .then(function (res) { mediaCache[m.mxc] = res; render(); })
            .catch(function (e) {
              // Refused (an SVG, something oversized) or simply unreachable:
              // say so in place rather than leaving an empty frame.
              mediaCache[m.mxc] = { error: String(e) };
              render();
            });
        }
      }
      return box;
    }

    // A labelled hairline across the timeline. `alert` makes it the unread
    // divider rather than a date.
    function ruleNode(label, alert) {
      var rule = el('div', 'chat-rule' + (alert ? ' chat-mod-alert' : ''));
      rule.appendChild(el('span', 'chat-rule-line'));
      rule.appendChild(el('span', 'chat-rule-label', label));
      rule.appendChild(el('span', 'chat-rule-line'));
      return rule;
    }

    return {
      messageNode: messageNode, trimUrl: trimUrl, refIdsIn: refIdsIn, spansIn: spansIn, fillBody: fillBody,
      linkChip: linkChip, idChip: idChip, historyButton: historyButton, imageNode: imageNode, ruleNode: ruleNode,
      URL_RE: URL_RE,
    };
  };
})();
