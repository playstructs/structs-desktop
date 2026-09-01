/* One chat message, drawn one way.
 *
 * Two windows show a conversation: the Comms window, and the raid viewer's
 * rail beside the map. The rail had its own `.rv-chat-*` markup that
 * approximated the real rows and drifted from them — a different sender
 * treatment, no clock, no run-collapsing, no event lines. Asked for twice as
 * "why is this styled in a unique way", which is the right question.
 *
 * So the row lives here, with `chat-rows.css`, and both windows render the
 * SAME component. Both files sit at the TOP LEVEL of `frontend/`, which is
 * repo-owned: `frontend/css/` is deleted and re-copied from the webapp
 * submodule by `scripts/sync.sh`, so a stylesheet placed there does not
 * survive a release build. It did not, once. What differs between them is not the row: it is what the
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

  /* The composer: the game's OWN dialogue panel, arrangement and all.
   *
   * Copied structurally from `#notification-dialogue` in
   * `structs-webapp/src/templates/game/index.html.twig` — the panel the game
   * itself puts a portrait, a message and a button on.
   *
   * The previous version used the right CLASSES in an arrangement I invented:
   * the button went in `sui-action-bar-btn-group` (which belongs to the action
   * bar, not the dialogue) and the three spacers were left out entirely. The
   * spacers are not decoration — `sui-panel-chunk-spacer-btn-a` and
   * `sui-panel-chunk-spacer-indicator` are what seat the button and the
   * portrait against the panel's own art. Without them the pieces float in a
   * frame they do not fit, which is exactly what "a temu version of the real
   * action bar" looks like.
   *
   * Returns `{ node, input, send, portrait }` so each window wires its own
   * behaviour around the same shape.
   */
  function composer(opts) {
    opts = opts || {};
    var panel = el('div', 'sui-panel sui-theme-player');
    panel.appendChild(el('div', 'sui-panel-edge-left'));

    // ── Left chunk: the portrait, on its own screen, then the spacer that
    //    seats it. The game's own left chunk has exactly this shape.
    var pChunk = el('div', 'sui-panel-chunk chat-composer-portrait');
    var pScreen = el('div', 'sui-screen sui-theme-player');
    var portrait = el('div', 'sui-screen-portrait');
    if (opts.portraitId) portrait.id = opts.portraitId;
    // `.sui-screen-portrait-image` is the frame with its own crop; nesting the
    // roster frame inside it would crop the portrait twice.
    var well = el('div', 'sui-screen-portrait-image');
    if (root.StructsPfp) root.StructsPfp.fillPortrait(well, opts.pfpAttrs);
    portrait.appendChild(well);
    pScreen.appendChild(portrait);
    pChunk.appendChild(pScreen);
    pChunk.appendChild(el('div', 'sui-panel-chunk-spacer-indicator'));
    panel.appendChild(pChunk);

    panel.appendChild(el('div', 'sui-panel-connector chat-composer-portrait-join'));

    // ── Middle chunk: the message, on a full-width screen. `sui-mod-grow`
    //    only — the game does not shrink this one.
    var iChunk = el('div', 'sui-panel-chunk sui-mod-grow');
    var iScreen = el('div', 'sui-screen sui-screen-full-width');
    var field = el('div', 'sui-screen-dialogue sui-theme-neutral');
    var input = document.createElement('input');
    input.type = 'text';
    if (opts.inputId) { input.id = opts.inputId; input.name = opts.inputId; }
    input.placeholder = opts.placeholder || 'Message';
    input.autocomplete = 'off';
    input.maxLength = opts.maxLength || 4000;
    field.appendChild(input);
    iScreen.appendChild(field);
    iChunk.appendChild(iScreen);
    panel.appendChild(iChunk);

    panel.appendChild(el('div', 'sui-panel-connector sui-panel-style-medium-to-default'));

    // ── Right chunk: the button, in the dialogue's own two-level wrapper with
    //    its spacer above. This is the part that was invented before.
    var bChunk = el('div', 'sui-panel-chunk sui-theme-player');
    var btnChunk = el('div', 'sui-dialogue-btn-chunk');
    var btnCol = el('div', 'sui-dialogue-btn-chunk-col');
    btnCol.appendChild(el('div', 'sui-panel-chunk-spacer-btn-a'));
    var send = el('a', 'sui-panel-btn sui-mod-default');
    if (opts.sendId) send.id = opts.sendId;
    send.href = 'javascript:void(0)';
    send.appendChild(el('i', 'sui-icon-md icon-arrow'));
    btnCol.appendChild(send);
    btnChunk.appendChild(btnCol);
    bChunk.appendChild(btnChunk);
    panel.appendChild(bChunk);

    // The right edge carries the theme in the game's markup; the left does not.
    panel.appendChild(el('div', 'sui-panel-edge-right sui-theme-player'));

    var wrap = el('div', 'sui-panel-wrapper-fit-content');
    wrap.appendChild(panel);
    return { node: wrap, input: input, send: send, portrait: portrait };
  }

  /* What a timeline shows instead of messages.
   *
   * A title and a sentence, not a bare line of hint text. This is the state a
   * channel is MOST often seen in — a raid window opens on a planet nobody has
   * discussed yet — so it is the one that has to look like the real thing.
   */
  function notice(title, detail, isError) {
    var box = el('div', 'chat-notice' + (isError ? ' chat-mod-error' : ''));
    box.appendChild(el('div', 'chat-notice-title', title));
    if (detail) box.appendChild(el('div', 'sui-text-paragraph', detail));
    return box;
  }

  root.StructsChatRow = {
    notice: notice,
    composer: composer,
    render: render,
    continues: continues,
    fmtTime: fmtTime,
    RUN_GAP_MS: RUN_GAP_MS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
