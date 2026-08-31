/* One chat message, drawn one way.
 *
 * Two windows show a conversation: the Comms window, and the raid viewer's
 * rail beside the map. The rail had its own `.rv-chat-*` markup that
 * approximated the real rows and drifted from them — a different sender
 * treatment, no clock, no run-collapsing, no event lines. Asked for twice as
 * "why is this styled in a unique way", which is the right question.
 *
 * So the row lives here, with `css/chat-rows.css`, and both windows render the
 * SAME component. What differs between them is not the row: it is what the
 * row can DO. A full timeline carries react, reply, pin, edit and delete; a
 * rail carries none of that. Those arrive through `opts.controls`, so the
 * embedded version is the same thing with less bolted on rather than a
 * lookalike written separately.
 */
(function (root) {
  'use strict';

  // A run from one sender collapses its header, but never across a gap long
  // enough that "when" stopped being obvious.
  var RUN_GAP_MS = 5 * 60 * 1000;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent, never innerHTML:
    return n;                                 // every body here is somebody
  }                                           // else's text.

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function kindOf(m) { return (m && m.kind) || 'text'; }

  /* Should this message hide its sender header?
   *
   * Pure, and exported, because it is the rule most likely to be re-derived
   * slightly differently by a second caller — which is exactly what happened
   * to the rest of this row.
   */
  function continues(m, prev) {
    return !!(prev && m && prev.sender === m.sender && !prev.failed && !m.failed
      && kindOf(m) !== 'emote' && kindOf(prev) !== 'emote'
      && Math.abs(Number(m.ts) - Number(prev.ts)) < RUN_GAP_MS);
  }

  /* Render `m`, given the message before it.
   *
   * opts (all optional):
   *   controls(m, meta) — append interactive controls to the meta cluster
   *   onSender(m)       — makes the name clickable; omit and it is inert
   *   mentionsMe(body)  — fallback for clients that do not send `m.mentions`
   *   gapNode()         — what a break in the record looks like to this window
   */
  function render(m, prev, opts) {
    opts = opts || {};
    var kind = kindOf(m);

    // A break in the record is not something anyone said, so it is not a
    // message. A history that reads as continuous and is not is the one kind
    // of wrong a log must never be.
    if (kind === 'gap') {
      return opts.gapNode ? opts.gapNode() : el('div', 'chat-event', 'some messages are missing');
    }

    // A room event — joined, left, renamed — is not conversation. One dim
    // line naming who did what, and no sender header.
    if (kind === 'event') {
      var ev = el('div', 'chat-event');
      ev.appendChild(el('span', 'chat-event-who', m.sender_name || m.sender));
      ev.appendChild(el('span', 'chat-event-what', m.body || ''));
      ev.appendChild(el('span', 'chat-event-time', fmtTime(m.ts)));
      return ev;
    }

    var wrap = el('div', 'chat-msg');
    if (m.event_id) wrap.setAttribute('data-event', m.event_id);
    if (m.pending) wrap.classList.add('chat-msg-pending');
    if (m.failed) wrap.classList.add('chat-msg-failed');

    // An emote is one line, IRC's way: "* Netlag waves". A header above it
    // would say the name twice.
    if (kind === 'emote') {
      var line = el('div', 'chat-msg-body chat-mod-emote');
      line.appendChild(el('span', null,
        '* ' + (m.sender_name || m.sender) + ' ' + (m.body || '')));
      wrap.appendChild(line);
      wrap.appendChild(el('div', 'chat-msg-time', fmtTime(m.ts)));
      wrap.classList.add('chat-mod-oneline');
      return wrap;
    }

    if (continues(m, prev)) wrap.classList.add('chat-mod-cont');
    // `mentions_me` is the sender saying so via `m.mentions` — exact. The
    // word-boundary guess is only for clients that do not send it.
    if (!m.self && (m.mentions_me || (opts.mentionsMe && opts.mentionsMe(m.body)))) {
      wrap.classList.add('chat-mod-mention');
    }

    var head = el('div', 'chat-msg-head');
    var who = el('div', 'chat-msg-sender' + (m.self ? ' chat-mod-self' : ''));
    // No portrait on the message line, deliberately. The game's portrait is a
    // fixed 72px composition cropped to head-and-shoulders; at name height it
    // is a sliver of scalp. Portraits go where they have room.
    if (m.sender_tag) who.appendChild(el('span', 'chat-msg-tag', '[' + m.sender_tag + ']'));
    who.appendChild(el('span', null, m.sender_name || m.sender));
    if (m.player_id && !m.self && opts.onSender) {
      who.classList.add('chat-mod-addressable');
      who.title = 'Message ' + (m.sender_name || m.player_id);
      who.addEventListener('click', function () { opts.onSender(m); });
    }
    head.appendChild(who);

    var meta = el('div', 'chat-msg-meta');
    if (m.admin) meta.appendChild(el('div', 'sui-badge sui-mod-warning', 'Admin'));
    // Shown, never hidden: a message that quietly becomes different text is
    // how a conversation gets rewritten under the people reading it.
    if (m.edited) meta.appendChild(el('span', 'chat-msg-edited', 'edited'));
    if (opts.controls) opts.controls(m, meta);
    // The clock last, so it sits at the end of the row whatever precedes it.
    meta.appendChild(el('div', 'chat-msg-time', fmtTime(m.ts)));
    head.appendChild(meta);
    wrap.appendChild(head);
    return wrap;
  }

  root.StructsChatRow = {
    render: render,
    continues: continues,
    fmtTime: fmtTime,
    RUN_GAP_MS: RUN_GAP_MS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
