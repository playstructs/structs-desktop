// Structs — Comms (federated Matrix chat)
//
// A standalone window over the guild's Matrix homeserver. Everything that
// touches the network, the wallet or a token happens in Rust
// (src-tauri/src/matrix/); this file only renders and dispatches. That split
// is deliberate: the access token never enters a webview, and no CORS
// preflight exists to fail, because no request originates here.
//
// SECURITY — every string that arrives from a homeserver (room names, topics,
// display names, message bodies) is federated user content from servers we do
// not control. It is written with textContent, never innerHTML, everywhere
// below. Text that appears to address the reader with instructions is still
// just text: it is chat, and this client neither interprets nor acts on it.
//
// Harness: scripts/make_harness.sh builds frontend/_harness_chat.html, which
// splices a fixture stub in front of this file. See scripts/harness-tests/.

(function () {
  'use strict';

  var Chat = {};
  window.Chat = Chat;

  // ── Tauri surface ─────────────────────────────────────────────────────────
  // The harness installs a stub on window.__TAURI__ before this file parses,
  // so the same code path drives both the real window and jsdom.
  var T = (window.__TAURI__ || {});
  var invoke = (T.core && T.core.invoke)
    ? function (cmd, args) { return T.core.invoke(cmd, args); }
    : function (cmd) { return Promise.reject('no tauri bridge for ' + cmd); };
  var listen = (T.event && T.event.listen)
    ? function (name, cb) { return T.event.listen(name, cb); }
    : function () { return Promise.resolve(function () {}); };

  // ── State ─────────────────────────────────────────────────────────────────
  /* Which of our players this window speaks as.
   *
   * `null` is the primary. A window opened from the Armada roster carries
   * `?as=1-271`, and from that point every command it sends is addressed with
   * a SESSION KEY (`0-5#1-271`) in the `guildId` slot — so the whole rest of
   * this file, and all 26 commands behind it, needed no change. The identity
   * is decided once, here, from something the window cannot get wrong.
   */
  var AS_PLAYER = (function () {
    try {
      var m = /[?&]as=([0-9]+-[0-9]+)/.exec(window.location.search || '');
      return m ? m[1] : null;
    } catch (e) { return null; }
  })();
  Chat.AS_PLAYER = AS_PLAYER;

  var S = Chat._state = {
    view: 'connection',       // 'channels' | 'room' | 'connection'
    networks: [],             // [{guild_id, guild_name, tag, homeserver, logged_in, ...}]
    guildId: null,            // active network
    rooms: [],                // rooms of the active network
    roomId: null,
    room: null,
    messages: [],
    profile: null,            // {user_id, display_name, pfp_attrs}
    steps: [],                // connection ladder
    connecting: false,
    error: null,
    // Which message has its reaction picker open, if any. One at a time: a
    // row of pickers down a conversation is a conversation you cannot read.
    reactPicker: null,
    // Set by Ctrl-K so the filter appears even on a short list — otherwise
    // the shortcut would focus something that is not there.
    filterWanted: false,
    // Narrowing a long channel list. Kept across renders so typing into it
    // does not fight the room-list pushes arriving underneath.
    roomFilter: '',
    // Who is here right now, by player id. `presenceKnown` false means the
    // homeserver has never mentioned anyone's — most likely it runs with
    // presence off — and then NOTHING is shown, because a wall of grey dots
    // implying an empty guild is worse than no dots at all.
    presence: {},
    presenceKnown: false,
    // Whether messages are still arriving. Rust says so only once a dropped
    // long-poll has stopped looking like a blip — see `start_sync`.
    syncStalled: null,
    // Whether WE are publishing a line about ourselves, and what it says.
    sharingStatus: false,
    myStatus: null,
    // Who has seen your latest message here: {event_id, names}. Null until
    // somebody has.
    seen: null,
    // The message currently being rewritten, if any.
    editing: null,
    // A delete waiting for its second click. One at a time, and cleared by
    // moving away — an armed control left behind is a trap.
    deleteArmed: null,
    // Whether the picker is showing the struct art as well as the intents.
    reactStructs: false,
    // The message being answered, while one is. Cleared on send, on Escape,
    // and on leaving the room — a reply target that outlives the room it was
    // in would attach to the wrong conversation.
    replyTo: null,
    // The room's own shortlist. `pinsOpen` is per-room: a strip that reopens
    // itself every time you switch rooms is a strip you close constantly.
    pins: [],
    pinsLoading: false,
    pinsOpen: {},
    // The player's own objects, for completing an id. Asked once per session:
    // your planet does not change while you are typing.
    myIds: [],
    // Finding something that was said. `searchRoom` is null for everywhere,
    // or a room id to stay inside one conversation.
    searchQuery: '',
    searchRoom: null,
    searchHits: [],
    searchLoading: false,
    searchRan: false,
    // Text handed over from the game, waiting for a room to put it in.
    draft: null,
    loading: true,
    // False until the FIRST matrix_status answers. Distinguishes "we have not
    // asked yet" from "we asked and there is nothing" — without it the window
    // opens by announcing a failure it has no evidence for.
    started: false,
    resources: null,          // pre-formatted {energy, overloaded, alpha}
    members: [],
    membersLoading: false,
    people: [],
    peopleQuery: '',
    peopleLoading: false,
    // Conversations you have open, in the order you opened them. A tab is a
    // view, not a membership — see openTab/closeTab.
    tabs: [],
    browse: [],
    browseQuery: '',
    browseLoading: false,
    // roomId → ts of the newest message the reader has actually seen. Feeds
    // the unread divider, the way every IRC client since ircII has marked it.
    lastRead: {},
    // Captured when a room is opened, so the divider stays put while you read
    // instead of sliding down as you look at it.
    dividerTs: 0,
    // Who is typing in the room being watched. Ephemeral: replaced wholesale
    // by each m.typing, never accumulated.
    typing: [],
    // Object ids whose card the reader has opened by hand. The first
    // reference in a message opens itself; these are the rest.
    openRefs: {},
    // Scrollback: whether the room has more history, and whether a page is
    // already in flight.
    moreHistory: true,
    loadingHistory: false,
    // What you have sent, newest last — recalled with Up, as every IRC client
    // and every shell has done forever.
    sent: [],
    sentAt: -1,
  };

  // ── Tiny DOM helpers ──────────────────────────────────────────────────────
  // Same idiom as board.js, kept local so this window loads no board code.
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name, size) {
    // PNG sui-icon-* glyphs need the `sui-icon` base plus a size; structicon
    // `icon-*` glyphs are self-contained font glyphs.
    var cls = name && name.indexOf('sui-icon-') === 0
      ? 'sui-icon ' + name + ' ' + (size || 'sui-icon-sm')
      : (size || 'sui-icon-sm') + ' ' + name;
    return el('i', cls);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function byId(id) { return document.getElementById(id); }

  // The game's five-layer portrait, composed exactly as the webapp's
  // PfpViewerComponent does. Asset paths are the contract; do not invent art.
  //
  // The LAYERS are separate from the FRAME on purpose. Each layer is a fixed
  // 72px image positioned by main.css and cropped to a head-and-shoulders by
  // whatever frame contains it — and the game has two frames with different
  // crops: `.sui-result-row-portrait-image` (44px, rosters) and
  // `.sui-screen-portrait-image` (the action bar, cropped 4px higher). Putting
  // one inside the other, or inside a box of my own with `overflow: hidden`,
  // clips the clip: that is what mangled both portraits.

  /* How many variants each portrait layer actually has.
   *
   * From the webapp's own `js/constants/PfpConstants.js` — the same numbers its
   * `PfpViewerComponent` generates against — and verified against the art that
   * ships in `img/pfp/`, which is the thing that would actually 404. Indices
   * are 1-BASED: the webapp generates `floor(random * count) + 1`.
   */
  var PFP_PART_COUNTS = window.StructsPfp.PFP_PART_COUNTS;
  Chat.PFP_PART_COUNTS = PFP_PART_COUNTS;
  var isLayer = window.StructsPfp.isLayer;

  function fillPfp(frame, attrsJson) {
    return window.StructsPfp.fillPortrait(frame, attrsJson);
  }

  Chat._fillPfp = fillPfp;

  // The roster frame: a 44px head-and-shoulders, as every list in the game
  // draws a player.
  function pfpPortrait(attrsJson) {
    return fillPfp(el('div', 'sui-result-row-portrait-image pfp-frame'), attrsJson);
  }

  // ── Who am I ──────────────────────────────────────────────────────────────
  // A mention is the single most important event in a chat client — it is the
  // difference between a room you skim and a message meant for you. Matched on
  // the on-chain username and the player id, both at word boundaries so
  // "Mark" does not light up on "Marklifer".
  function myNames() {
    var out = [];
    var p = S.profile;
    if (!p) return out;
    if (p.display_name) out.push(p.display_name);
    var pid = p.user_id && /^@([^:]+):/.exec(p.user_id);
    if (pid) out.push(pid[1]);
    return out.filter(function (n) { return n && n.length >= 2; });
  }

  function mentionsMe(body) {
    if (!body) return false;
    var names = myNames();
    for (var i = 0; i < names.length; i++) {
      // Word-boundary match that also treats punctuation as a boundary, which
      // \b alone does not for ids like "1-194".
      var re = new RegExp('(^|[^A-Za-z0-9_-])' +
        names[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '($|[^A-Za-z0-9_-])', 'i');
      if (re.test(body)) return true;
    }
    return false;
  }
  Chat.mentionsMe = mentionsMe;

  // ── Mentions ──────────────────────────────────────────────────────────────
  // Everyone this window can address by name: whoever has spoken in the room,
  // plus its member list once loaded. Exact — each name maps to the Matrix id
  // the message will actually notify.
  function addressBook() {
    var by = {};
    S.messages.forEach(function (m) {
      if (m.local || !m.sender_name || !m.sender) return;
      by[m.sender_name.toLowerCase()] = { name: m.sender_name, user_id: m.sender };
    });
    (S.members || []).forEach(function (p) {
      if (p.name && p.user_id) by[p.name.toLowerCase()] = { name: p.name, user_id: p.user_id };
    });
    return by;
  }

  // The `@Name` runs in a body that resolve to real people. Longest name
  // first, so "@T.Xue" is not matched as "@T".
  function mentionsIn(body) {
    var book = addressBook();
    var names = Object.keys(book).sort(function (a, b) { return b.length - a.length; });
    var out = [];
    var lower = String(body || '').toLowerCase();
    names.forEach(function (key) {
      var at = lower.indexOf('@' + key);
      if (at === -1) return;
      // A boundary after the name, so "@Net" does not match inside "@Netlag".
      var after = lower.charAt(at + key.length + 1);
      if (after && /[a-z0-9_.-]/.test(after)) return;
      var who = book[key];
      if (!out.some(function (m) { return m.user_id === who.user_id; })) out.push(who);
    });
    return out;
  }
  Chat.mentionsIn = mentionsIn;

  // ── Object references ─────────────────────────────────────────────────────
  // Every noun in Structs is a `<type>-<index>` id and players already talk in
  // them. Finding those in a message and showing a small summary is the single
  // biggest thing chat can do for a game whose whole vocabulary is ids.
  //
  // The boundary is strict on BOTH sides: `1-194` and `1-1945` are different
  // objects, and a loose match attributes one to the other.
  var ID_RE = /(^|[^0-9A-Za-z_-])(\d{1,2}-\d{1,9})(?![0-9-])/g;
  // Only types a reader cares about. MIRRORS refs.rs::is_referenceable and
  // must be changed with it — allocations and infusions are plumbing, and a
  // card that says nothing is worse than plain text. A provider (10) earns one
  // because it is an offer you can act on.
  //
  // Exposed so the tests can hold both copies to the same list.
  var REF_KINDS = { 0: 1, 1: 1, 2: 1, 4: 1, 5: 1, 9: 1, 10: 1 };
  Chat.REF_KINDS = REF_KINDS;
  Chat.ID_RE = ID_RE;

  // id → card, or `false` while a lookup is in flight, or null when the chain
  // had nothing. Shared across the whole timeline: a room arguing about one
  // raid names it in every other line.
  var refCards = {};
  var refQueue = [];
  var refTimer = null;
  // Bounded like the Rust cache it mirrors. A long session in busy rooms names
  // a great many objects, and none of this is worth keeping forever.
  var REF_CACHE_MAX = 400;

  function trimRefCache() {
    var keys = Object.keys(refCards);
    if (keys.length <= REF_CACHE_MAX) return;
    // Oldest-first by insertion, which is the order Object.keys gives for
    // string keys that are not array indices. Anything currently open by hand
    // is kept: it is on screen.
    keys.slice(0, keys.length - REF_CACHE_MAX).forEach(function (k) {
      if (!S.openRefs[k]) delete refCards[k];
    });
  }

  function wantRefs(ids) {
    var fresh = ids.filter(function (id) {
      return !Object.prototype.hasOwnProperty.call(refCards, id);
    });
    if (!fresh.length) return;
    fresh.forEach(function (id) { refCards[id] = false; refQueue.push(id); });
    // Batched: one message with six ids should be one round trip, not six.
    if (refTimer) return;
    refTimer = setTimeout(flushRefs, 30);
  }

  function flushRefs() {
    refTimer = null;
    var batch = refQueue.splice(0, 8);
    if (!batch.length) return;
    invoke('matrix_refs', { ids: batch })
      .then(function (res) {
        (res && res.refs || []).forEach(function (card) { refCards[card.id] = card; });
        // Anything the chain did not know stays null so it is never retried
        // in a loop; it simply renders as plain text.
        batch.forEach(function (id) { if (!refCards[id]) refCards[id] = null; });
        trimRefCache();
        if (refQueue.length) refTimer = setTimeout(flushRefs, 30);
        render();
      })
      .catch(function () {
        batch.forEach(function (id) { refCards[id] = null; });
      });
  }

  /* The card itself. NOT `.sui-data-card`, and deliberately so.
   *
   * This comment used to claim it was built from that component; it never has
   * been, and the claim invited exactly the wrong fix. Rendered side by side at
   * the window's real scale, a `.sui-data-card` in a chat transcript is nearly
   * three times taller and carries a filled header bar that shouts: two of
   * these cards occupy the height of one, and a single message can name several
   * objects at once. It reads as a dashboard panel dropped into a conversation.
   *
   * What this is instead: one surface, a coloured LEFT EDGE that encodes the
   * object type (planet teal, struct amber, player periwinkle — see
   * `.chat-kind-*`), and the same label/value rows. Same information, same type
   * channel, a third of the height, and it reads as an aside — which is what an
   * embed in a conversation should be.
   *
   * `.sui-data-card` IS used in this window, in the connection view, where the
   * context is a full panel and it fits. Right component, right place. */
  // Actions a card carries from Rust, plus the ones only the window can
  // decide. Asking for help is one of those: it depends on being in a room.
  function cardActions(card) {
    var actions = (card.actions || []).slice();
    if (card.kind === 'struct' && card.work_task && S.roomId) {
      actions.push({ key: 'ask_help', label: 'Ask for help', icon: 'icon-computer' });
    }
    return actions;
  }

  function refCard(card) {
    // ONE frame, not three. The card used to nest a bordered header, a
    // bordered body and bordered buttons inside a bordered card — four
    // competing rectangles for one summary. Now: a single surface with a
    // coloured left edge, which is both the "this is an embed" signal and the
    // type at a glance, the way a quote or attachment reads everywhere else.
    var box = el('div', 'chat-ref chat-kind-' + (card.kind || 'thing'));

    var head = el('div', 'chat-ref-head');
    // The portrait uses the ROSTER's frame at its natural 44px — it is a
    // fixed-size crop of fixed-size art and cannot be squeezed.
    if (card.pfp_attrs) {
      var portrait = el('div', 'sui-result-row-portrait chat-ref-portrait');
      portrait.appendChild(pfpPortrait(card.pfp_attrs));
      head.appendChild(portrait);
    } else {
      var well = el('div', 'chat-ref-glyph');
      well.appendChild(icon(card.icon || 'icon-info', 'sui-icon-md'));
      head.appendChild(well);
    }
    var names = el('div', 'chat-ref-names');
    names.appendChild(el('div', 'chat-ref-title', card.title || card.id));
    if (card.subtitle) names.appendChild(el('div', 'chat-ref-sub', card.subtitle));
    head.appendChild(names);
    box.appendChild(head);

    // Facts as a two-column grid rather than a bordered table: the label and
    // the value line up down the card without a box around them.
    var body = el('div', 'chat-ref-facts');
    (card.rows || []).forEach(function (r) {
      body.appendChild(el('div', 'chat-ref-label', r.label));
      body.appendChild(el('div', 'chat-ref-value', r.value));
    });
    box.appendChild(body);

    // ── Actions ──
    // What makes a card more than a lookup. Watch the planet someone named,
    // message its owner, rent the capacity a provider advertised — without
    // leaving the conversation that mentioned it.
    var acts = cardActions(card);
    if (acts.length) {
      var bar = el('div', 'chat-ref-actions');
      acts.forEach(function (a) {
        // Affordances, not content: small, quiet, and on one line. Full-size
        // buttons wrapped onto two rows and dominated the summary they belong
        // to.
        var b = el('button', 'chat-ref-action');
        b.appendChild(icon(a.icon || 'icon-info', 'sui-icon-md'));
        b.appendChild(el('span', null, a.label));
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          runCardAction(card, a.key, box);
        });
        bar.appendChild(b);
      });
      box.appendChild(bar);
    }
    // The portrait is the shortest path to "look at this player's world".
    var portraitEl = box.querySelector('.chat-ref-portrait');
    if (portraitEl && card.planet_id) {
      portraitEl.classList.add('chat-mod-clickable');
      portraitEl.title = 'Watch ' + card.planet_id;
      portraitEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        runCardAction(card, 'watch_planet', box);
      });
    }
    return box;
  }

  // A card reports its own outcome, in place. A toast would land in another
  // window and a dialogue would cover the conversation the card belongs to.
  function cardNote(box, text, isError) {
    var old = box.querySelector('.chat-ref-note');
    if (old) old.parentNode.removeChild(old);
    var note = el('div', 'chat-ref-note' + (isError ? ' chat-mod-error' : ''), text);
    box.appendChild(note);
    return note;
  }

  function runCardAction(card, key, box) {
    if (key === 'message') { startDm(card.id); return; }
    if (key === 'watch_planet' || key === 'watch_fleet') {
      var isPlanet = key === 'watch_planet';
      var target = isPlanet ? card.planet_id : card.fleet_id;
      if (!target) { cardNote(box, 'nothing to watch', true); return; }
      // The same spectator window Team Ops opens — one map viewer, reached
      // from wherever the thing was named.
      invoke('mcp_raid_view_open', {
        planetId: isPlanet ? target : null,
        fleetId: isPlanet ? null : target,
      }).catch(function (e) { cardNote(box, String(e), true); });
      return;
    }
    if (key === 'send_alpha') { sendAlpha(card, box); return; }
    if (key === 'agreement') { rentForm(card, box); return; }
    if (key === 'ask_help') { askForHelp(card, box); return; }
  }

  // Ask the room to grind the cycle this struct is running.
  //
  // The anchor comes from the CHAIN, never from the card: it is what the
  // proof is verified against, and an offer carrying a guessed one would have
  // every solver grinding a string that can never be accepted.
  function askForHelp(card, box) {
    cardNote(box, 'reading the cycle\u2026');
    return invoke('matrix_work_params', { objectId: card.id, task: card.work_task })
      .then(function (p) {
        return invoke('matrix_work_offer', {
          guildId: S.guildId, roomId: S.roomId,
          objectId: p.object, task: p.task,
          blockStart: p.block_start, difficulty: p.difficulty, targetId: null,
        });
      })
      .then(function () { cardNote(box, 'asked'); })
      .catch(function (e) { cardNote(box, String(e), true); });
  }

  // Hand Team Ops a pre-filled transfer for this player.
  //
  // Comms deliberately cannot spend. `mcp_transfer_execute` is board-only and
  // re-runs its own preview server-side, and this window renders text written
  // by federated strangers — it is the last place that should hold a wallet.
  // So the button asks, and the money is still committed in Team Ops, in front
  // of a preview naming the recipient.
  //
  // Only the player ID crosses over. The address is resolved from the chain on
  // the other side, so a crafted card cannot name where the funds go.
  function sendAlpha(card, box) {
    cardNote(box, 'opening Team Ops\u2026');
    return invoke('matrix_open_transfer', { playerId: card.id })
      .then(function () { cardNote(box, 'ready in Team Ops — confirm it there'); })
      .catch(function (e) { cardNote(box, String(e), true); });
  }

  // ── Renting capacity ──────────────────────────────────────────────────────
  // The whole cost is debited AT OPEN, in the provider's own denom — which is
  // often a guild token rather than Alpha. So the quote is shown before the
  // commit, and the button says the number it is about to spend.
  function rentForm(card, box) {
    if (box.querySelector('.chat-rent')) return;      // already open
    var p = card.provider || {};
    var form = el('div', 'chat-rent');

    var cap = numberField('Capacity (W)', p.capacity_min || 0);
    var dur = numberField('Duration (blocks)', p.duration_min || 0);
    form.appendChild(cap.wrap);
    form.appendChild(dur.wrap);

    var quote = el('div', 'chat-rent-quote');
    form.appendChild(quote);

    var go = el('button', 'sui-screen-btn sui-mod-primary', 'Confirm');
    var cancel = el('button', 'sui-screen-btn sui-mod-secondary', 'Cancel');
    var bar = el('div', 'chat-ref-actions');
    bar.appendChild(cancel);
    bar.appendChild(go);
    form.appendChild(bar);

    function cost() {
      var c = Number(cap.input.value) || 0;
      var d = Number(dur.input.value) || 0;
      return (Number(p.rate_amount) || 0) * c * d;
    }
    function reprice() {
      var total = cost();
      quote.textContent = total > 0
        ? 'Costs ' + fmtCount(total) + ' ' + (p.denom_label || '') + ' now, in full'
        : 'Enter a capacity and duration';
      go.disabled = !(total > 0);
      go.classList.toggle('sui-mod-disabled', !(total > 0));
    }
    cap.input.addEventListener('input', reprice);
    dur.input.addEventListener('input', reprice);
    reprice();

    cancel.addEventListener('click', function (ev) {
      ev.stopPropagation();
      form.parentNode.removeChild(form);
    });
    go.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (go.disabled) return;
      go.disabled = true;
      go.textContent = 'Signing…';
      invoke('matrix_agreement_open', {
        providerId: card.id,
        capacity: Math.round(Number(cap.input.value) || 0),
        duration: Math.round(Number(dur.input.value) || 0),
      })
        .then(function (res) {
          form.parentNode.removeChild(form);
          cardNote(box, 'Agreement opened · ' + ((res && res.tx) || ''));
        })
        .catch(function (e) {
          go.disabled = false;
          go.textContent = 'Confirm';
          cardNote(box, String(e), true);
        });
    });
    box.appendChild(form);
    cap.input.focus();
  }

  function numberField(label, initial) {
    var wrap = el('div', 'chat-rent-field');
    var lab = el('label', 'sui-input-text');
    var id = 'rent-' + label.replace(/[^a-z]/gi, '').toLowerCase();
    lab.setAttribute('for', id);
    lab.appendChild(el('span', null, label));
    var input = el('input');
    // TEXT, not number: SUI styles `label.sui-input-text input[type=text]`, so
    // a number input falls outside the game's art entirely and renders as a
    // raw browser box. `inputmode` still brings up a numeric keypad, and the
    // spinner arrows are no loss.
    input.type = 'text';
    input.setAttribute('inputmode', 'numeric');
    input.id = id;
    input.value = String(initial || '');
    input.addEventListener('input', function () {
      // Keep it a number without fighting the caret: strip anything that is
      // not a digit, in place.
      var clean = input.value.replace(/[^0-9]/g, '');
      if (clean !== input.value) input.value = clean;
    });
    lab.appendChild(input);
    wrap.appendChild(lab);
    return { wrap: wrap, input: input };
  }

  // ── Time ──────────────────────────────────────────────────────────────────
  // 24-hour, zero-padded: this is a HUD, not prose, and a stable width keeps
  // the right edge of the timeline straight.
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function dayKey(ts) {
    var d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(ts) {
    var d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '';
    var today = new Date();
    var yday = new Date(today.getTime() - 86400000);
    if (dayKey(d.getTime()) === dayKey(today.getTime())) return 'Today';
    if (dayKey(d.getTime()) === dayKey(yday.getTime())) return 'Yesterday';
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1000) {
      var k = n / 1000;
      return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + 'K';
    }
    return String(n);
  }

  // ── Nav ───────────────────────────────────────────────────────────────────
  // Left slot = the networks this player can reach. In the game this slot
  // holds the menu's sections; here it answers the same "where am I" question
  // for a federated client that can be on more than one homeserver.
  // ── Tabs ──────────────────────────────────────────────────────────────────
  // The conversations you have open, in the slot the game uses for its menu
  // sections. It replaces the network name, which was a single inert word
  // once only your own guild could be signed into.
  //
  // A tab is a VIEW, not a membership: closing one puts the conversation away,
  // it does not leave the room. Leaving is `/leave`, and it should stay that
  // way — a stray click on an × must never remove you from a channel.
  var MAX_TABS = 8;

  function openTab(roomId) {
    if (!roomId) return;
    if (S.tabs.indexOf(roomId) === -1) S.tabs.push(roomId);
    // Bounded: a long session opening every room would otherwise turn the
    // strip into a scrollbar. Oldest tab goes first — but never the one being
    // opened, and never the room currently on screen, which would leave the
    // strip disagreeing with the view.
    while (S.tabs.length > MAX_TABS) {
      var victim = null;
      for (var i = 0; i < S.tabs.length; i++) {
        if (S.tabs[i] !== roomId && S.tabs[i] !== S.roomId) { victim = S.tabs[i]; break; }
      }
      if (!victim) break;                 // everything left is in use
      S.tabs.splice(S.tabs.indexOf(victim), 1);
    }
  }
  Chat.openTab = openTab;

  function closeTab(roomId) {
    var at = S.tabs.indexOf(roomId);
    if (at === -1) return;
    S.tabs.splice(at, 1);
    if (S.roomId !== roomId) { render(); return; }
    // Closing the one you are looking at hands you the neighbour, the way
    // every tabbed thing does — falling back to the channel list.
    var next = S.tabs[at] || S.tabs[at - 1];
    if (next) openRoom(next); else go('channels');
  }
  Chat.closeTab = closeTab;

  function tabLabel(roomId) {
    for (var i = 0; i < S.rooms.length; i++) {
      if (S.rooms[i].room_id === roomId) return S.rooms[i].name || roomId;
    }
    if (S.roomId === roomId && S.room) return S.room.name || roomId;
    return roomId;
  }

  function unreadFor(roomId) {
    for (var i = 0; i < S.rooms.length; i++) {
      if (S.rooms[i].room_id === roomId) return S.rooms[i];
    }
    return null;
  }

  function renderNav() {
    var box = byId('menu-page-nav-items');
    if (!box) return;
    clear(box);

    if (!S.tabs.length) {
      // Nothing open yet: name the network, as the slot did before.
      var net = activeNetwork();
      box.appendChild(el('a', 'sui-screen-nav-item sui-mod-active',
        (net && (net.tag || net.guild_name)) || 'COMMS'));
    } else {
      S.tabs.forEach(function (roomId) {
        var active = S.view === 'room' && S.roomId === roomId;
        var a = el('a', 'sui-screen-nav-item chat-tab' + (active ? ' sui-mod-active' : ''));
        a.href = 'javascript:void(0)';
        a.title = tabLabel(roomId);

        var room = unreadFor(roomId);
        if (room && room.unread) {
          // A dot, not a count: the strip is for switching, and the number is
          // already on the row in the channel list.
          a.appendChild(el('span',
            'chat-tab-dot' + (room.mention ? ' chat-mod-mention' : '')));
        }
        a.appendChild(el('span', 'chat-tab-label', tabLabel(roomId)));

        var x = el('span', 'chat-tab-close');
        x.title = 'Close';
        x.appendChild(icon('icon-close', 'sui-icon-sm'));
        x.addEventListener('click', function (ev) {
          // Without this the tab underneath would also fire and re-open what
          // was just closed.
          ev.stopPropagation();
          closeTab(roomId);
        });
        a.appendChild(x);

        a.addEventListener('click', function () { openRoom(roomId); });
        box.appendChild(a);
      });
    }

    var comms = byId('chat-nav-comms');
    var settings = byId('chat-nav-settings');
    if (comms) comms.className = (S.view === 'channels' || S.view === 'room') ? 'sui-mod-active' : '';
    if (settings) settings.className = S.view === 'connection' ? 'sui-mod-active' : '';
  }

  // ── Page header ───────────────────────────────────────────────────────────
  // `label` sits in the game's .sui-nav-btn slot; `back` adds the chevron the
  // mockup shows on the room view.
  function pageHeader(label, back, rightNode) {
    var head = el('div', 'sui-page-header');
    var a = el('a', 'sui-nav-btn');
    a.href = 'javascript:void(0)';
    if (back) {
      a.appendChild(icon('icon-chevron-left sui-text-secondary'));
      a.addEventListener('click', back);
    }
    a.appendChild(el('span', null, label));
    head.appendChild(a);
    if (rightNode) head.appendChild(rightNode);
    return head;
  }

  // The game's own header resources: energy usage then alpha owned.
  //
  // The STRINGS come from Rust, already run through the game's unit ladders
  // (format_power / format_alpha_whole). Nothing here divides or abbreviates:
  // load is in milliwatts and alpha is in whole grams, each with its own
  // ladder, and re-deriving that here is what produced "128007K/133641K"
  // where the game says "128.01KW".
  function headerResources() {
    if (!S.resources) return null;
    var box = el('div', 'sui-page-header-resources');
    var r = S.resources;
    if (r.energy) {
      var e = el('div', 'sui-resource');
      var num = el('span', r.overloaded ? 'sui-text-warning' : null, r.energy);
      e.appendChild(num);
      // Same glyph swap the HUD's EnergyUsageComponent does when overloaded.
      e.appendChild(icon(r.overloaded ? 'sui-icon-energy-insufficient' : 'sui-icon-energy'));
      box.appendChild(e);
    }
    if (r.alpha) {
      var al = el('div', 'sui-resource');
      al.appendChild(el('span', null, r.alpha));
      al.appendChild(icon('sui-icon-alpha-matter'));
      box.appendChild(al);
    }
    return box.childNodes.length ? box : null;
  }

  // ── Channels view ─────────────────────────────────────────────────────────
  var SECTIONS = [
    // First, always. An invitation is the one row in the list waiting on an
    // answer from you rather than reporting something that happened.
    { key: 'invite', label: 'Invitations' },
    { key: 'direct', label: 'Direct' },
    { key: 'local', label: 'Local Net' },
    { key: 'galaxy', label: 'Galaxy Net' },
  ];

  // Which homeserver a room lives on, from its alias or its id.
  function serverOf(r) {
    var src = r.canonical_alias || r.room_id || '';
    var at = src.lastIndexOf(':');
    return at === -1 ? '' : src.slice(at + 1);
  }
  Chat.serverOf = serverOf;

  function ownServer() {
    var uid = (S.profile && S.profile.user_id) || '';
    var at = uid.lastIndexOf(':');
    return at === -1 ? '' : uid.slice(at + 1);
  }

  // Label a room's home only when it is somewhere ELSE. Browse spans every
  // guild in the galaxy, but most rows are from your own server and stamping
  // that on all of them is noise, not information. The `matrix.` prefix is
  // dropped because every one of these hosts has it.
  function foreignServerLabel(r) {
    var host = serverOf(r);
    if (!host || host === ownServer()) return '';
    return host.replace(/^matrix\./, '');
  }
  Chat.foreignServerLabel = foreignServerLabel;

  function roomRow(r, browsing) {
    var row = el('div', 'sui-result-row chat-room-row');

    var left = el('div', 'sui-result-row-left-section');
    // Whether this is a PERSON is the server's classification, not something
    // to infer from having a player id.
    //
    // `player_id` is only set when the other side's Matrix id parses as a
    // player — so a direct message with a bot or a service account has none,
    // and reading DM-ness off it rendered that room as a channel, complete
    // with a member count, while Rust classified it 'direct' and notified it
    // as a DM. `section` is what `dm_with` actually produces.
    var isDm = r.section === 'direct';
    var portrait = el('div', 'sui-result-row-portrait');
    if (r.pfp_attrs || r.player_id || isDm) {
      // A direct message IS a person — the same portrait the roster shows.
      portrait.appendChild(pfpPortrait(r.pfp_attrs));
    } else {
      var well = el('div', 'chat-room-icon');
      /* The home channel carries SN Corp's own mark instead of the generic
       * guild glyph. `img/logo-snc.gif` is the game's asset — the same one the
       * signup flow shows while connecting to the corp — not something drawn
       * for this list. Every other row keeps the structicon `icon_for` picked. */
      if (r.home_rank != null) {
        var mark = document.createElement('img');
        mark.className = 'chat-room-mark';
        mark.src = 'img/logo-snc.gif';
        mark.alt = '';
        well.appendChild(mark);
      } else {
        well.appendChild(icon(r.icon || 'icon-beacon', 'sui-icon-md'));
      }
      portrait.appendChild(well);
    }
    left.appendChild(portrait);

    var info = el('div', 'sui-result-row-player-info');
    var block = el('div', 'sui-text-label-block');
    // A direct message IS a person, so it is the one room row where "are they
    // actually here" is a question about the row itself.
    var here = presenceDot(r.player_id);
    if (here) block.appendChild(here);
    block.appendChild(el('span', null, r.name || r.canonical_alias || r.room_id));
    block.appendChild(el('br'));
    // A DM's subtitle is who it is with; a channel's is how many are in it.
    // Browsing adds where it lives and what it is for: the directory spans
    // every guild's homeserver, so "which server" is part of choosing.
    var sub;
    if (r.player_id) {
      sub = el('span', 'sui-text-hint',
        (r.tag ? '[' + r.tag + '] ' : '') + 'PID #' + r.player_id);
    } else {
      var parts = r.invited
        // An invitation has no member count worth showing — you cannot see
        // the room yet. Who asked is the whole basis for deciding.
        ? [r.invited_by ? 'Invited by ' + r.invited_by : 'You have been invited']
        // "2 Players" under a direct message is a count of a conversation,
        // which is not a fact anybody wants. A DM with no player behind it
        // simply says nothing rather than pretending to be a channel.
        : isDm
          ? []
          : [fmtCount(r.members) + (Number(r.members) === 1 ? ' Player' : ' Players')];
      if (browsing) {
        // The ADDRESS — the one thing about a room that cannot be taken.
        // Anyone may publish a public room under any name, so two rows here
        // can legitimately carry the SAME display name; without an address
        // there is nothing on screen that tells them apart.
        //
        // Only the alias's localpart, not the whole thing: the server half is
        // shown separately and only when the room is somewhere else, because
        // stamping every own-server row with its own server is noise on most
        // of the list.
        var addr = String(r.canonical_alias || '').split(':')[0];
        parts.push(addr || r.room_id);
        var host = foreignServerLabel(r);
        if (host) parts.push(host);
        if (r.topic) parts.push(r.topic);
      }
      sub = el('span', 'sui-text-hint', parts.join(' · '));
    }
    block.appendChild(sub);
    info.appendChild(block);
    left.appendChild(info);
    row.appendChild(left);

    var right = el('div', 'sui-result-row-right-section');
    // A silenced room still shows its count — it is unread, it just does not
    // interrupt. The marker is what explains why it never rang.
    if (r.muted) {
      var q = icon('icon-disabled', 'sui-icon-sm chat-room-muted');
      q.title = 'Silenced';
      right.appendChild(q);
    }
    if (r.unread) {
      // Warning colour when you were named in it — the one badge in the list
      // that should pull the eye. Never for a silenced room: the whole point
      // of muting is that being named there stops pulling the eye.
      var b = el('div',
        'sui-badge chat-room-unread ' +
        (r.mention && !r.muted ? 'sui-mod-warning' : 'sui-mod-default'),
        fmtCount(r.unread));
      if (r.mention) b.title = 'You were mentioned';
      right.appendChild(b);
    }
    if (browsing && r.joined) {
      right.appendChild(el('div', 'sui-badge sui-mod-default', 'Joined'));
    }
    // Declining is only offered for an INVITATION. A room you merely found in
    // the directory has nothing to decline — you were never asked.
    if (r.invited) {
      var no = el('button', 'sui-screen-btn chat-room-decline', 'Decline');
      no.title = 'Turn down this invitation';
      no.addEventListener('click', function (ev) {
        ev.stopPropagation();
        no.disabled = true;
        no.textContent = 'Declining';
        invoke('matrix_leave', { guildId: S.guildId, roomId: r.room_id })
          .then(function () {
            // Gone from the list at once. Waiting for a sync to confirm it
            // leaves a question on screen that has already been answered.
            S.rooms = S.rooms.filter(function (x) { return x.room_id !== r.room_id; });
            render();
            return refreshRooms();
          })
          .catch(function (e) {
            no.textContent = 'Decline';
            no.disabled = false;
            showError(String(e));
          });
      });
      right.appendChild(no);
    }
    if (!r.joined) {
      var join = el('button', 'sui-screen-btn sui-mod-secondary',
        r.invited ? 'Accept' : 'Join');
      join.addEventListener('click', function (ev) {
        ev.stopPropagation();
        join.disabled = true;
        join.classList.add('sui-mod-disabled');
        join.textContent = 'Joining';
        invoke('matrix_join', { guildId: S.guildId, roomId: r.room_id })
          .then(function () {
            return refreshRooms().then(function () {
              // Joining from the directory, or accepting an invitation, is a
              // decision to go there.
              if (browsing || r.invited) openRoom(r.room_id);
            });
          })
          .catch(function (e) {
            join.textContent = r.invited ? 'Accept' : 'Join';
            join.disabled = false;
            join.classList.remove('sui-mod-disabled');
            showError(String(e));
          });
      });
      right.appendChild(join);
    }
    row.appendChild(right);

    if (r.joined) {
      row.addEventListener('click', function () { openRoom(r.room_id); });
    } else {
      row.classList.remove('chat-room-row');
    }
    return row;
  }

  // What a channel list is FOR is finding the thing that wants you. Within a
  // section: what named you, then what is unread, then the rest by name.
  //
  // A silenced room never jumps the queue, however much traffic it has —
  // muting means "stop pulling my eye", and sorting it to the top would undo
  // exactly that.
  function roomOrder(a, b) {
    var rank = function (r) {
      if (r.muted) return 2;
      if (r.mention) return 0;
      if (r.unread) return 1;
      return 2;
    };
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Within a rank, busier first — but only for rooms that are actually
    // waiting. Ordering read rooms by a count they all share at zero would
    // just be an unstable alphabetical.
    if (ra < 2 && (b.unread || 0) !== (a.unread || 0)) {
      return (b.unread || 0) - (a.unread || 0);
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  }
  Chat.roomOrder = roomOrder;

  // The rooms a filter is currently showing, in the order they are shown.
  // Enter opens the first of these, so it has to be the SAME list and the
  // same order the eye is reading — deriving it twice is how the top row and
  // the one that opens come to disagree.
  function filteredRooms() {
    var mine = S.rooms.filter(function (r) { return r.joined || r.invited; })
      .filter(matchesFilter);
    var out = [];
    SECTIONS.forEach(function (sec) {
      mine.filter(function (r) { return (r.section || 'galaxy') === sec.key; })
        .slice().sort(roomOrder)
        .forEach(function (r) { out.push(r); });
    });
    return out;
  }
  Chat.filteredRooms = filteredRooms;

  function matchesFilter(r) {
    var q = String(S.roomFilter || '').trim().toLowerCase();
    if (!q) return true;
    return String(r.name || '').toLowerCase().indexOf(q) !== -1 ||
      String(r.canonical_alias || '').toLowerCase().indexOf(q) !== -1;
  }

  function renderChannels() {
    var page = el('div', 'chat-page');

    // Resources sit where the game puts them; the new-message door sits
    // beside them, because starting a conversation is the one action this
    // page has that is not "open a thing already on it".
    var right = el('div', 'chat-header-actions');
    var browse = el('a', 'sui-nav-btn');
    browse.id = 'chat-browse';
    browse.href = 'javascript:void(0)';
    browse.title = 'Browse channels';
    browse.appendChild(icon('icon-guild-directory sui-text-secondary'));
    browse.addEventListener('click', function () { go('browse'); });
    right.appendChild(browse);

    var newMsg = el('a', 'sui-nav-btn');
    newMsg.id = 'chat-new-message';
    newMsg.href = 'javascript:void(0)';
    newMsg.title = 'Message a player';
    newMsg.appendChild(icon('icon-add sui-text-secondary'));
    newMsg.addEventListener('click', function () { go('people'); });
    right.appendChild(newMsg);
    var res = headerResources();
    if (res) right.appendChild(res);

    page.appendChild(pageHeader('Channels', null, right));

    // Only once the list is long enough to need it. A filter box above four
    // rooms is a control that costs more attention than it saves.
    var joined = S.rooms.filter(function (r) { return r.joined || r.invited; });
    // Long lists get it unasked; a short list only shows it once you have
    // gone looking for it — but then it must be there, or Ctrl-K would put
    // the cursor nowhere.
    if (joined.length > 8 || S.roomFilter || S.filterWanted) {
      var box = el('div');
      box.id = 'chat-room-filter';
      var label = el('label', 'sui-input-text');
      label.setAttribute('for', 'chat-room-filter-q');
      var fi = el('input');
      fi.type = 'text';
      fi.id = 'chat-room-filter-q';
      fi.name = 'chat-room-filter-q';
      fi.placeholder = 'Find a channel';
      fi.autocomplete = 'off';
      fi.value = S.roomFilter || '';
      fi.addEventListener('input', function () {
        S.roomFilter = fi.value;
        render();
      });
      fi.addEventListener('keydown', function (e) {
        // Enter opens the best match. Typing three letters and pressing
        // Enter is the whole point of a filter; reaching for the mouse to
        // finish the job wastes it.
        if (e.key === 'Enter') {
          e.preventDefault();
          var best = filteredRooms()[0];
          if (best) { S.roomFilter = ''; openRoom(best.room_id); }
          return;
        }
        if (e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        S.roomFilter = '';
        render();
        var again = byId('chat-room-filter-q');
        if (again) again.focus();
      });
      label.appendChild(fi);
      box.appendChild(label);
      page.appendChild(box);
      // Ctrl-K asks for this box; `go('channels')` then refreshes the room
      // list, which re-renders and throws the focus away. Re-asserting it
      // here means the cursor survives however many pushes land underneath.
      //
      // Only when nothing else has taken it: a room-list push must not yank
      // the caret out of wherever the player has since clicked.
      if (S.filterWanted) {
        var active = document.activeElement;
        if (!active || active === document.body ||
            active.id === 'chat-room-filter-q') {
          setTimeout(function () {
            var live = byId('chat-room-filter-q');
            if (live && document.activeElement !== live) {
              live.focus();
              moveCaretToEnd(live);
            }
          }, 0);
        }
      }
    }

    var scroll = el('div', 'chat-scroll');

    // A share arrived with nowhere to go yet. Say so where the choice is.
    if (S.draft) {
      scroll.appendChild(noticeBlock(
        'Ready to share ' + S.draft,
        'Open a conversation and it will be waiting in the message box.'));
    }

    if (S.loading) {
      scroll.appendChild(noticeBlock('Loading', 'Reading your channels.'));
    } else if (!S.rooms.filter(function (r) { return r.joined || r.invited; }).length) {
      scroll.appendChild(noticeBlock(
        'No channels yet',
        'You have not joined anything. Browse the directory to find rooms.'));
    } else {
      // Only rooms you are IN. What else exists lives in Browse — a list that
      // mixes "your channels" with "every channel on the server" answers
      // neither question well.
      var mine = S.rooms.filter(function (r) { return r.joined || r.invited; })
        .filter(matchesFilter);
      if (!mine.length) {
        scroll.appendChild(noticeBlock('Nothing matches',
          'No channel of yours is called ' + JSON.stringify(S.roomFilter) + '.'));
      }
      /* The home channel, above every section.
       *
       * Not "first within its section": it lands in Local Net for SN Corp's
       * own members and Galaxy Net for everyone else, so leaving it in place
       * would put it under Invitations and Direct for half the roster and in
       * a different group depending on who you are. Its own group, first, is
       * the only arrangement that means the same thing to everybody.
       *
       * Ranked by the server (`home_rank`), which requires the room to be on
       * that guild's OWN homeserver — so a directory room that merely calls
       * itself SN Corp cannot take the slot. The order inside the group is
       * the rank, NOT `roomOrder`: these are furniture, and furniture that
       * reshuffles itself by unread count is not pinned in any useful sense.
       */
      var home = mine.filter(function (r) { return r.home_rank != null; })
        .sort(function (a, b) { return a.home_rank - b.home_rank; });
      var rest = mine.filter(function (r) { return r.home_rank == null; });
      if (home.length) {
        var hGroup = el('div', 'chat-net-group');
        hGroup.appendChild(el('div', 'chat-net-label', 'Structs'));
        var hTable = el('div', 'sui-result-table');
        var hList = el('div', 'sui-result-rows');
        home.forEach(function (r) { hList.appendChild(roomRow(r)); });
        hTable.appendChild(hList);
        hGroup.appendChild(hTable);
        scroll.appendChild(hGroup);
      }
      SECTIONS.forEach(function (sec) {
        var rows = rest.filter(function (r) { return (r.section || 'galaxy') === sec.key; });
        if (!rows.length) return;
        rows = rows.slice().sort(roomOrder);
        var group = el('div', 'chat-net-group');
        group.appendChild(el('div', 'chat-net-label', sec.label));
        var table = el('div', 'sui-result-table');
        var list = el('div', 'sui-result-rows');
        rows.forEach(function (r) { list.appendChild(roomRow(r)); });
        table.appendChild(list);
        group.appendChild(table);
        scroll.appendChild(group);
      });
    }

    page.appendChild(scroll);
    return page;
  }

  // ── Who is here ───────────────────────────────────────────────────────────
  // The most basic question a room raises, and the window could not answer it
  // at all. Doubles as the address book: a name seen here is a name the
  // composer can complete and a person you can message.
  function renderMembers() {
    var page = el('div', 'chat-page');
    var name = (S.room && (S.room.name || S.room.canonical_alias)) || S.roomId || '';
    page.appendChild(pageHeader(name + ' · People', function () {
      // Back to the conversation, not to the channel list.
      if (S.roomId) { S.view = 'room'; render(); } else { go('channels'); }
    }, null));

    var scroll = el('div', 'chat-scroll');
    if (S.membersLoading) {
      scroll.appendChild(noticeBlock('Loading', 'Asking who is in this room.'));
    } else if (!S.members.length) {
      scroll.appendChild(noticeBlock('Empty', 'Nobody else is here.'));
    } else {
      var table = el('div', 'sui-result-table');
      var list = el('div', 'sui-result-rows');
      S.members.forEach(function (p) { list.appendChild(memberRow(p)); });
      table.appendChild(list);
      scroll.appendChild(table);
    }
    page.appendChild(scroll);
    return page;
  }

  function memberRow(p) {
    var row = el('div', 'sui-result-row' + (p.player_id ? ' chat-room-row' : ''));

    var left = el('div', 'sui-result-row-left-section');
    var portrait = el('div', 'sui-result-row-portrait');
    if (p.player_id) {
      portrait.appendChild(pfpPortrait(p.pfp_attrs));
    } else {
      // Not a player: a bot or a service account. Its own glyph, so the list
      // does not imply a person who is not one.
      var well = el('div', 'chat-room-icon');
      well.appendChild(icon('icon-computer', 'sui-icon-md'));
      portrait.appendChild(well);
    }
    left.appendChild(portrait);

    var info = el('div', 'sui-result-row-player-info');
    var block = el('div', 'sui-text-label-block');
    // "Who is here" is the question this whole list exists to answer, so the
    // dot goes first, before the name it belongs to.
    var here = presenceDot(p.player_id);
    if (here) block.appendChild(here);
    if (p.tag) block.appendChild(el('span', 'chat-msg-tag', '[' + p.tag + '] '));
    block.appendChild(el('span', null, p.name + (p.is_self ? ' (you)' : '')));
    block.appendChild(el('br'));
    // What they say they are doing, when they have chosen to say it. Most
    // will not have, so the id stays the fallback rather than the row going
    // blank.
    var said = p.presence && p.presence.status_msg;
    block.appendChild(el('span', 'sui-text-hint',
      said || (p.player_id ? 'PID #' + p.player_id : p.user_id)));
    info.appendChild(block);
    left.appendChild(info);
    row.appendChild(left);

    // A player can be messaged; a bot cannot.
    if (p.player_id && !p.is_self) {
      var right = el('div', 'sui-result-row-right-section');
      var btn = el('button', 'chat-ref-action');
      btn.appendChild(icon('icon-phone', 'sui-icon-sm'));
      btn.appendChild(el('span', null, 'Message'));
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        startDm(p.player_id);
      });
      right.appendChild(btn);
      row.appendChild(right);
      row.addEventListener('click', function () { startDm(p.player_id); });
    }
    return row;
  }

  function loadMembers() {
    if (!S.roomId) return Promise.resolve();
    var room = S.roomId;
    S.membersLoading = true;
    return invoke('matrix_members', { guildId: S.guildId, roomId: room })
      .then(function (res) {
        if (S.roomId !== room) return;
        S.members = (res && res.members) || [];
        S.membersLoading = false;
        if (S.view === 'members') render();
      })
      .catch(function (e) {
        S.membersLoading = false;
        S.members = [];
        if (S.view === 'members') showError(String(e));
      });
  }

  // ── Browse ────────────────────────────────────────────────────────────────
  // IRC's `/list`: everything public on the homeserver, searched server-side
  // because a busy server only ever hands us a page and filtering locally
  // would filter the wrong set.
  // Browse is for finding somewhere to go, so what you have NOT joined comes
  // first — a row you are already in answers a question you did not ask.
  //
  // Then busiest first. A directory in arrival order put a room with nobody
  // in it at the top, which is the least useful row it could possibly lead
  // with, and buried a 3,100-player channel below it.
  function browseOrder(a, b) {
    var ja = a.joined ? 1 : 0, jb = b.joined ? 1 : 0;
    if (ja !== jb) return ja - jb;
    var ma = Number(a.members) || 0, mb = Number(b.members) || 0;
    if (ma !== mb) return mb - ma;
    return String(a.name || '').localeCompare(String(b.name || ''));
  }
  Chat.browseOrder = browseOrder;

  function renderBrowse() {
    var page = el('div', 'chat-page');
    page.appendChild(pageHeader('Browse Channels', function () { go('channels'); }, null));

    var search = el('div');
    search.id = 'chat-people-search';
    var label = el('label', 'sui-input-text');
    label.setAttribute('for', 'chat-browse-query');
    var input = el('input');
    input.type = 'text';
    input.id = 'chat-browse-query';
    input.name = 'chat-browse-query';
    input.placeholder = 'Search channels';
    input.autocomplete = 'off';
    input.value = S.browseQuery || '';
    label.appendChild(input);
    search.appendChild(label);
    page.appendChild(search);

    var scroll = el('div', 'chat-scroll');
    if (S.browseLoading) {
      scroll.appendChild(noticeBlock('Loading', 'Reading the channel directory.'));
    } else if (!S.browse.length) {
      scroll.appendChild(noticeBlock(
        'Nothing found',
        S.browseQuery
          ? 'No channel matches “' + S.browseQuery + '”.'
          : 'This homeserver publishes no public channels.'));
    } else {
      var table = el('div', 'sui-result-table');
      var list = el('div', 'sui-result-rows');
      S.browse.slice().sort(browseOrder)
        .forEach(function (r) { list.appendChild(roomRow(r, true)); });
      table.appendChild(list);
      scroll.appendChild(table);
    }
    page.appendChild(scroll);

    input.addEventListener('input', function () {
      S.browseQuery = input.value;
      if (browseTimer) clearTimeout(browseTimer);
      browseTimer = setTimeout(loadBrowse, 250);
    });
    return page;
  }

  var browseTimer = null;

  function loadBrowse() {
    browseTimer = null;
    S.browseLoading = true;
    return invoke('matrix_browse', { guildId: S.guildId, query: S.browseQuery || null })
      .then(function (res) {
        S.browse = (res && res.rooms) || [];
        S.browseLoading = false;
        if (S.view === 'browse') render();
      })
      .catch(function (e) {
        S.browseLoading = false;
        S.browse = [];
        showError(String(e));
      });
  }

  // ── People ────────────────────────────────────────────────────────────────
  // Every player is addressable without any prior contact: their Matrix id is
  // their player id at their own guild's homeserver, and both halves are
  // public. So this is a directory, not a friends list — there is nothing to
  // request and nothing to accept.
  function personRow(p) {
    var row = el('div', 'sui-result-row chat-room-row');

    var left = el('div', 'sui-result-row-left-section');
    var portrait = el('div', 'sui-result-row-portrait');
    portrait.appendChild(pfpPortrait(p.pfp_attrs));
    left.appendChild(portrait);

    var info = el('div', 'sui-result-row-player-info');
    var block = el('div', 'sui-text-label-block');
    if (p.tag) block.appendChild(el('span', 'chat-msg-tag', '[' + p.tag + '] '));
    block.appendChild(el('span', null, p.username || 'Name Redacted'));
    block.appendChild(el('br'));
    block.appendChild(el('span', 'sui-text-hint', 'PID #' + p.player_id));
    info.appendChild(block);
    left.appendChild(info);
    row.appendChild(left);

    var right = el('div', 'sui-result-row-right-section');
    var btn = el('button', 'sui-screen-btn sui-mod-secondary', 'Message');
    right.appendChild(btn);
    row.appendChild(right);

    var open = function () { startDm(p.player_id); };
    row.addEventListener('click', open);
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); open(); });
    return row;
  }

  // ── Search ────────────────────────────────────────────────────────────────
  // The homeserver does the searching. This window keeps a few hundred
  // messages of one room, and the thing worth finding is almost never in that
  // window — see `client::search`.
  function renderSearch() {
    var page = el('div', 'chat-page');
    var scope = S.searchRoom ? roomNameOf(S.searchRoom) : 'Everywhere';
    page.appendChild(pageHeader('Search · ' + scope, function () {
      if (S.roomId) { S.view = 'room'; render(); } else { go('channels'); }
    }, searchScopeToggle()));

    var box = el('div');
    box.id = 'chat-search-box';
    var label = el('label', 'sui-input-text');
    label.setAttribute('for', 'chat-search-query');
    var input = el('input');
    input.type = 'text';
    input.id = 'chat-search-query';
    input.name = 'chat-search-query';
    input.placeholder = 'What was said';
    input.autocomplete = 'off';
    input.value = S.searchQuery || '';
    // On Enter, not on every keystroke. A search is a round trip to the
    // homeserver over the whole history of every room — typing "raid" would
    // fire four of them, and the first three answer a question nobody asked.
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(input.value); }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (S.roomId) { S.view = 'room'; render(); } else { go('channels'); }
      }
    });
    label.appendChild(input);
    box.appendChild(label);
    page.appendChild(box);

    var scroll = el('div', 'chat-scroll');
    if (S.searchLoading) {
      scroll.appendChild(noticeBlock('Searching', 'Asking the homeserver.'));
    } else if (!S.searchRan) {
      scroll.appendChild(noticeBlock('Search',
        S.searchRoom
          ? 'Looking in this conversation. Press Enter to search.'
          : 'Looking everywhere you are joined. Press Enter to search.'));
    } else if (!S.searchHits.length) {
      scroll.appendChild(noticeBlock('Nothing found',
        'No message matching ' + JSON.stringify(S.searchQuery) + '.'));
    } else {
      S.searchHits.forEach(function (h) { scroll.appendChild(searchHit(h)); });
    }
    page.appendChild(scroll);
    return page;
  }

  // Two scopes, one control: this conversation, or everywhere. Only offered
  // when there IS a conversation to be narrower than.
  function searchScopeToggle() {
    if (!S.roomId) return null;
    var wrap = el('div', 'chat-header-actions');
    var a = el('a', 'sui-nav-btn');
    a.href = 'javascript:void(0)';
    a.title = S.searchRoom ? 'Search everywhere instead' : 'Search only this conversation';
    a.appendChild(icon((S.searchRoom ? 'icon-guild-directory' : 'icon-guild') +
      ' sui-text-secondary'));
    a.addEventListener('click', function () {
      S.searchRoom = S.searchRoom ? null : S.roomId;
      if (S.searchQuery) runSearch(S.searchQuery); else render();
    });
    wrap.appendChild(a);
    return wrap;
  }

  function roomNameOf(roomId) {
    var r = unreadFor(roomId);
    return (r && (r.name || r.canonical_alias)) || roomId;
  }

  // A hit reads as the message it is, with the room it was in above it — the
  // room is the part you cannot infer, and it is what makes a hit worth
  // clicking.
  function searchHit(h) {
    var wrap = el('div', 'chat-search-hit');
    var head = el('a', 'chat-search-hit-room');
    head.href = 'javascript:void(0)';
    // No icon. The room name is already the whole of what this line says, and
    // the guild glyph at this size is a mark the eye has to decode for nothing.
    head.appendChild(el('span', null, h.room_name || h.room_id));
    head.addEventListener('click', function () { openRoom(h.room_id); });
    wrap.appendChild(head);
    wrap.appendChild(messageNode(h.message));
    return wrap;
  }

  function runSearch(query) {
    S.searchQuery = query;
    if (!String(query || '').trim()) { S.searchRan = false; S.searchHits = []; render(); return; }
    S.searchLoading = true;
    S.searchRan = true;
    render();
    var args = { guildId: S.guildId, query: query };
    if (S.searchRoom) args.roomId = S.searchRoom;
    return invoke('matrix_search', args)
      .then(function (res) {
        // A slow answer to an old question must not paint over a newer one.
        // Compared against the CURRENT query, not against the one this call
        // asked — that always matches, which is no guard at all.
        if (String(query).trim() !== String(S.searchQuery).trim()) return;
        S.searchHits = (res && res.hits) || [];
        S.searchLoading = false;
        render();
      })
      .catch(function (e) {
        S.searchLoading = false;
        S.searchHits = [];
        render();
        showError(String(e));
      });
  }
  Chat.runSearch = runSearch;

  // Open search, scoped to wherever the player is standing.
  function openSearch(scoped) {
    S.searchRoom = scoped && S.roomId ? S.roomId : null;
    S.searchRan = false;
    S.searchHits = [];
    go('search');
  }
  Chat.openSearch = openSearch;

  function renderPeople() {
    var page = el('div', 'chat-page');
    page.appendChild(pageHeader('New Message', function () { go('channels'); }, null));

    var search = el('div');
    search.id = 'chat-people-search';
    var label = el('label', 'sui-input-text');
    label.setAttribute('for', 'chat-people-query');
    var input = el('input');
    input.type = 'text';
    input.id = 'chat-people-query';
    input.name = 'chat-people-query';
    input.placeholder = 'Name or player id';
    input.autocomplete = 'off';
    input.value = S.peopleQuery || '';
    label.appendChild(input);
    search.appendChild(label);
    page.appendChild(search);

    var scroll = el('div', 'chat-scroll');
    if (S.peopleLoading) {
      scroll.appendChild(noticeBlock('Loading', 'Reading the galaxy directory.'));
    } else if (!S.people.length) {
      scroll.appendChild(noticeBlock(
        'Nobody found',
        S.peopleQuery
          ? 'No player matches “' + S.peopleQuery + '”.'
          : 'The directory is empty.'));
    } else {
      var table = el('div', 'sui-result-table');
      var list = el('div', 'sui-result-rows');
      S.people.forEach(function (p) { list.appendChild(personRow(p)); });
      table.appendChild(list);
      scroll.appendChild(table);
    }
    page.appendChild(scroll);

    // Debounced so typing does not fire a lookup per keystroke.
    input.addEventListener('input', function () {
      S.peopleQuery = input.value;
      if (peopleTimer) clearTimeout(peopleTimer);
      peopleTimer = setTimeout(loadPeople, 200);
    });
    return page;
  }

  var peopleTimer = null;

  function loadPeople() {
    peopleTimer = null;
    S.peopleLoading = true;
    return invoke('matrix_people', { guildId: S.guildId, query: S.peopleQuery || null })
      .then(function (res) {
        S.people = (res && res.people) || [];
        S.peopleLoading = false;
        // render() carries the draft and the caret across for us.
        if (S.view === 'people') render();
      })
      .catch(function (e) {
        S.peopleLoading = false;
        S.people = [];
        showError(String(e));
      });
  }

  function startDm(playerId, body) {
    return invoke('matrix_dm', { guildId: S.guildId, playerId: playerId })
      .then(function (res) {
        return refreshRooms().then(function () {
          if (!res || !res.room_id) return;
          var opened = openRoom(res.room_id);
          // `/msg bob hello` opens the conversation AND says hello, which is
          // what /msg has meant since IRC.
          if (!body) return opened;
          return opened.then(function () { sendMessage(body); });
        });
      })
      // A DM that cannot be addressed is a normal outcome (their guild runs no
      // comms server), so it belongs in the timeline, not on an error page.
      .catch(function (e) {
        if (S.view === 'room') say(String(e), true); else showError(String(e));
      });
  }
  Chat.startDm = startDm;

  // ── Room view ─────────────────────────────────────────────────────────────
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

  // ── Pinned ────────────────────────────────────────────────────────────────
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

  // ── Reaction vocabulary ───────────────────────────────────────────────────
  // A Matrix reaction key is an arbitrary string, which means it does not have
  // to be an emoji. Structs has its own icon set and its own struct art, and a
  // guild agreeing to a raid with the raid glyph says more than a thumb does.
  //
  // The keys are `:shortcode:` so they stay READABLE somewhere else: a player
  // on Element sees `:raid:`, not a broken box. Emoji arriving from those
  // clients still render as emoji — that is content this window receives, not
  // chrome it chose.
  var REACTION_ICONS = {
    okay: 'icon-okay', blocked: 'icon-blocked', detected: 'icon-detected',
    alert: 'icon-alert', raid: 'icon-raid', defend: 'icon-defend',
    mine: 'icon-mine', wreckage: 'icon-wreckage',
  };
  // Agree, refuse, watching, careful — then the four things a guild room is
  // usually talking about.
  var QUICK_REACTIONS = [':okay:', ':blocked:', ':detected:', ':alert:',
                         ':raid:', ':defend:', ':mine:', ':wreckage:'];

  // The struct art that ships with the game, one picture per hull. Offered
  // behind a toggle: twenty of them open by default would be a wall.
  var REACTION_STRUCTS = [
    'cmd-ship', 'destroyer', 'battleship', 'cruiser', 'frigate', 'interceptor',
    'starfighter', 'stealth-bomber', 'pursuit-fighter', 'submersible', 'tank',
    'mobile-artillery', 'sam-launcher', 'pdc', 'jamming-sat', 'orb-shield',
    'extractor', 'refinery', 'generator', 'ore-bunker',
  ];

  // Render one key. Falls through to plain text, which is what makes a key
  // from any other client — an emoji, a word, a shortcode we do not know —
  // still show as itself rather than as nothing.
  function reactionGlyph(key) {
    var m = /^:struct\/([a-z0-9-]+):$/.exec(key);
    if (m && REACTION_STRUCTS.indexOf(m[1]) !== -1) {
      var im = el('img', 'chat-reaction-struct');
      im.src = 'img/structs/' + m[1] + '/' + m[1] + '-struct-base.png';
      im.alt = m[1];
      return im;
    }
    m = /^:([a-z0-9-]+):$/.exec(key);
    if (m && REACTION_ICONS[m[1]]) {
      return icon(REACTION_ICONS[m[1]], 'sui-icon-sm');
    }
    return el('span', 'chat-reaction-key', key);
  }
  Chat.reactionGlyph = reactionGlyph;

  function reactionRow(m) {
    var list = m.reactions || [];
    // Both sides must be a REAL event id. `S.reactPicker` is null when no
    // picker is open and `serverIdOf` is null for a local line — so a plain
    // equality made `null === null` true and opened the picker on every
    // system notice, every error and every message still in flight.
    var id = serverIdOf(m);
    var open = !!id && S.reactPicker === id;
    if (!list.length && !open) return null;

    var row = el('div', 'chat-reactions');
    list.forEach(function (r) {
      var chip = el('a', 'sui-badge chat-reaction' +
        (r.mine ? ' sui-mod-warning' : ' sui-mod-default'));
      chip.href = 'javascript:void(0)';
      chip.appendChild(reactionGlyph(r.key));
      chip.appendChild(el('span', 'chat-reaction-count', String(r.count)));
      // Who agreed is the whole point in a guild room, and it is the one
      // thing a count throws away.
      chip.title = (r.who || []).join(', ') || r.key;
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        react(m, r.key, !r.mine);
      });
      row.appendChild(chip);
    });

    if (open) {
      var offer = function (key) {
        var already = list.some(function (r) { return r.key === key && r.mine; });
        var b = el('a', 'chat-reaction chat-mod-offer' + (already ? ' chat-mod-mine' : ''));
        b.href = 'javascript:void(0)';
        b.title = key;
        b.appendChild(reactionGlyph(key));
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          // Picking closes the picker, and closing forgets the sheet — the
          // same as dismissing it, so the next message does not open with
          // twenty hulls already showing.
          S.reactPicker = null;
          S.reactStructs = false;
          react(m, key, !already);
        });
        row.appendChild(b);
      };
      QUICK_REACTIONS.forEach(offer);

      // Twenty hulls open by default would be a wall across the message.
      var more = el('a', 'chat-reaction chat-mod-offer chat-mod-more');
      more.href = 'javascript:void(0)';
      more.title = S.reactStructs ? 'Hide the hulls' : 'React with a struct';
      more.appendChild(icon(S.reactStructs ? 'icon-chevron-left' : 'icon-cmd-post',
        'sui-icon-sm'));
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        S.reactStructs = !S.reactStructs;
        render();
      });
      row.appendChild(more);

      if (S.reactStructs) {
        REACTION_STRUCTS.forEach(function (name) { offer(':struct/' + name + ':'); });
      }
    }
    return row;
  }

  function reactButton(m, serverId) {
    var a = el('a', 'chat-react-btn');
    a.href = 'javascript:void(0)';
    a.title = 'React to this message';
    a.appendChild(icon('icon-add sui-text-secondary', 'sui-icon-sm'));
    a.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = serverId || serverIdOf(m);
      S.reactPicker = S.reactPicker === id ? null : id;
      if (!S.reactPicker) S.reactStructs = false;
      render();
    });
    return a;
  }

  // Applied locally at once, then corrected by the answer. A reaction that
  // waits for a round trip before appearing feels like a click that missed.
  function react(m, key, on) {
    var before = (m.reactions || []).map(function (r) {
      return { key: r.key, count: r.count, mine: r.mine, who: r.who };
    });
    m.reactions = optimistic(before, key, on);
    render();
    return invoke('matrix_react', {
      guildId: S.guildId, roomId: S.roomId, eventId: serverIdOf(m), key: key, on: on,
    })
      .then(function (res) {
        if (res && res.reactions) applyReactions(m.event_id, res.reactions);
      })
      .catch(function (e) {
        m.reactions = before;                    // put it back; it did not happen
        render();
        showError(String(e));
      });
  }
  Chat.react = react;

  function optimistic(list, key, on) {
    var out = [];
    var found = false;
    list.forEach(function (r) {
      if (r.key !== key) { out.push(r); return; }
      found = true;
      var count = r.count + (on ? 1 : -1);
      // A key nobody holds any more is gone, not a chip reading zero.
      if (count > 0) out.push({ key: key, count: count, mine: on, who: r.who });
    });
    if (!found && on) out.push({ key: key, count: 1, mine: true, who: [] });
    return out.sort(function (a, b) {
      return b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
  }
  Chat.optimistic = optimistic;

  // A reaction landed on some message — repaint that one, not the timeline.
  function applyReactions(eventId, reactions) {
    var hit = false;
    S.messages.forEach(function (m) {
      if (m.event_id === eventId || m.echo_of === eventId) {
        m.reactions = reactions || [];
        hit = true;
      }
    });
    S.pins.forEach(function (m) {
      if (m.event_id === eventId) m.reactions = reactions || [];
    });
    if (hit || S.pins.length) render();
  }

  function onReactions(payload) {
    if (!payload) return;
    if (payload.guild_id && payload.guild_id !== S.guildId) return;
    if (payload.room_id !== S.roomId) return;
    applyReactions(payload.event_id, payload.reactions);
  }
  Chat.onReactions = onReactions;

  // Changing what you already said.
  //
  // The message goes back into the composer, which is the only place in this
  // window that knows how to write one — a second editor would need its own
  // completion, its own mention matching and its own history.
  function editButton(m, serverId) {
    var a = el('a', 'chat-edit-btn');
    a.href = 'javascript:void(0)';
    a.title = 'Change this message';
    a.appendChild(icon('icon-edit sui-text-secondary', 'sui-icon-sm'));
    a.addEventListener('click', function (e) {
      e.stopPropagation();
      S.editing = { event_id: serverId, body: m.body, msgtype: m.kind };
      S.replyTo = null;                  // one intent at a time
      render();
      var input = byId('chat-input');
      if (!input) return;
      input.value = m.body || '';
      input.focus();
      moveCaretToEnd(input);
    });
    return a;
  }

  // The chip above the bar, so it is never a mystery why Enter is about to
  // rewrite something instead of sending it.
  function editChip() {
    if (!S.editing) return null;
    var chip = el('div', 'chat-reply-chip chat-mod-editing');
    chip.id = 'chat-edit-chip';
    chip.appendChild(icon('icon-edit sui-text-secondary', 'sui-icon-sm'));
    chip.appendChild(el('span', 'chat-reply-who', 'Editing'));
    chip.appendChild(el('span', 'chat-reply-text', excerpt(S.editing.body)));
    var x = el('a', 'chat-reply-cancel');
    x.href = 'javascript:void(0)';
    x.title = 'Keep it as it was';
    x.appendChild(icon('icon-close sui-text-secondary', 'sui-icon-sm'));
    x.addEventListener('click', function () { cancelEdit(); });
    chip.appendChild(x);
    return chip;
  }

  function cancelEdit() {
    S.editing = null;
    render();
    var input = byId('chat-input');
    if (input) { input.value = ''; input.focus(); }
  }
  Chat.cancelEdit = cancelEdit;

  function commitEdit(text) {
    var target = S.editing;
    S.editing = null;
    return invoke('matrix_edit', {
      guildId: S.guildId, roomId: S.roomId, eventId: target.event_id,
      body: text, msgtype: target.msgtype === 'emote' ? 'm.emote' : null,
    })
      .then(function () { applyEdit(target.event_id, text); })
      .catch(function (e) { showError(String(e)); });
  }

  // Somebody rewrote a message — including us, a moment ago or on another
  // device.
  function applyEdit(eventId, body) {
    var hit = false;
    S.messages.forEach(function (m) {
      if (serverIdOf(m) !== eventId) return;
      m.body = body;
      m.edited = true;
      hit = true;
    });
    S.pins.forEach(function (m) {
      if (m.event_id === eventId) { m.body = body; m.edited = true; }
    });
    if (hit || S.pins.length) render();
  }

  function onEdited(payload) {
    if (!payload) return;
    if (payload.guild_id && payload.guild_id !== S.guildId) return;
    if (payload.room_id !== S.roomId) return;
    applyEdit(payload.event_id, payload.body);
  }
  Chat.onEdited = onEdited;

  // Taking a message back.
  //
  // Two clicks, not one. It cannot be undone and the control sits in a row of
  // others that are all harmless — a misfire on a neighbouring icon would
  // otherwise destroy something. The second click is the confirmation, and
  // moving the mouse away cancels it.
  // What the homeserver calls this message: its own id once sync has
  // delivered it, or the id the send came back with while the local echo is
  // still on screen. Null for a message that has not been accepted yet.
  function serverIdOf(m) {
    if (m.event_id && m.event_id.charAt(0) === '$') return m.event_id;
    if (m.echo_of && String(m.echo_of).charAt(0) === '$') return m.echo_of;
    return null;
  }
  Chat.serverIdOf = serverIdOf;

  function deleteButton(m, serverId) {
    var armed = S.deleteArmed === serverId;
    var a = el('a', 'chat-delete-btn' + (armed ? ' chat-mod-armed' : ''));
    a.href = 'javascript:void(0)';
    a.title = armed ? 'Click again to remove this message' : 'Remove this message';
    a.appendChild(icon('icon-close' + (armed ? ' sui-text-enemy-primary' : ' sui-text-secondary'),
      'sui-icon-sm'));
    a.addEventListener('mouseleave', function () {
      if (S.deleteArmed === serverId) { S.deleteArmed = null; render(); }
    });
    a.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!armed) { S.deleteArmed = serverId; render(); return; }
      S.deleteArmed = null;
      redactMessage(m, serverId);
    });
    return a;
  }

  function redactMessage(m, serverId) {
    return invoke('matrix_redact', {
      guildId: S.guildId, roomId: S.roomId, eventId: serverId || serverIdOf(m),
    })
      .then(function () {
        // Sync delivers the redaction and rewrites it properly; this is so the
        // click has an effect now rather than in a second's time.
        m.kind = 'notice';
        m.body = 'message removed';
        m.mxc = null;
        m.reactions = [];
        m.reply_to = null;
        render();
      })
      .catch(function (e) { showError(String(e)); });
  }
  Chat.redactMessage = redactMessage;

  // Somebody took a message back — including us, on another device.
  function onRedacted(payload) {
    if (!payload) return;
    if (payload.guild_id && payload.guild_id !== S.guildId) return;
    if (payload.room_id !== S.roomId) return;
    var hit = false;
    S.messages.forEach(function (m) {
      if (m.event_id !== payload.event_id) return;
      m.kind = 'notice';
      m.body = 'message removed';
      m.mxc = null;
      m.reactions = [];
      m.reply_to = null;
      hit = true;
    });
    if (hit) render();
  }
  Chat.onRedacted = onRedacted;

  // ── Shared proof-of-work ──────────────────────────────────────────────────
  // A task's grinding input is public — object, kind, anchor. Anyone can
  // compute it; only its owner can submit the answer. That asymmetry is what
  // makes asking a room for help safe.
  var WORK_LABEL = {
    MINE: 'Mining', REFINE: 'Refining', BUILD: 'Building', RAID: 'Raid',
  };
  var WORK_ICON = {
    MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-cmd-post', RAID: 'icon-raid',
  };

  // Whether an offer's cycle is still the one the chain is running, keyed by
  // object and anchor. Cached because a busy room is a column of cards and
  // each check is a chain read — and because the answer cannot change for a
  // given anchor: either the chain still holds it or it never will again.
  var workFresh = {};

  function workKey(w) { return w.object + '|' + w.task + '|' + w.block_start; }

  function checkWorkFresh(w) {
    var key = workKey(w);
    if (Object.prototype.hasOwnProperty.call(workFresh, key)) return;
    workFresh[key] = null;                 // asked; don't ask again
    invoke('matrix_work_status', {
      objectId: w.object, task: w.task, blockStart: w.block_start,
    })
      .then(function (res) {
        // Unknown stays unknown. A card must never be greyed out on a guess:
        // being offline would otherwise make every live offer look dead.
        if (!res || !res.known) return;
        workFresh[key] = !!res.live;
        if (S.view === 'room') render();
      })
      .catch(function () {});
  }

  function workCard(m) {
    var w = m.work;
    if (!w) return null;
    var offer = w.kind === 'offer';
    checkWorkFresh(w);
    var stale = workFresh[workKey(w)] === false;
    var card = el('div', 'chat-ref chat-work chat-kind-' + (offer ? 'offer' : 'result')
      + (stale ? ' chat-mod-stale' : ''));

    var head = el('div', 'chat-ref-head');
    head.appendChild(icon(WORK_ICON[w.task] || 'icon-computer', 'sui-icon-md'));
    head.appendChild(el('span', 'chat-ref-title',
      (offer ? 'Work wanted \u00b7 ' : 'Solved \u00b7 ') + (WORK_LABEL[w.task] || w.task)));
    card.appendChild(head);

    var facts = el('div', 'chat-ref-facts');
    var fact = function (k, v) {
      facts.appendChild(el('span', 'chat-ref-key', k));
      facts.appendChild(el('span', 'chat-ref-val', v));
    };
    fact(w.task === 'RAID' ? 'Fleet' : 'Struct', w.object);
    if (w.target) fact('Target', w.target);
    // The anchor is the whole reason a proof goes stale: it is the cycle the
    // nonce is valid against, and the chain checks against its own current
    // one. Showing it is what lets a player see a dead offer as dead.
    fact('Anchor', 'block ' + w.block_start);
    if (w.difficulty) fact('Difficulty', String(w.difficulty));
    if (w.nonce) fact('Nonce', w.nonce);
    card.appendChild(facts);

    // A dead cycle cannot be proved against. Say so where the buttons were,
    // rather than leaving controls that can only fail.
    if (stale) {
      var gone = el('div', 'chat-work-verdict chat-mod-bad');
      gone.textContent = 'That cycle has turned over — this can no longer be proved.';
      card.appendChild(gone);
      return card;
    }

    var actions = el('div', 'chat-ref-actions');
    if (offer) {
      var help = el('a', 'sui-panel-btn sui-mod-default chat-ref-action');
      help.href = 'javascript:void(0)';
      help.appendChild(icon('icon-computer', 'sui-icon-sm'));
      help.appendChild(el('span', null, 'Help'));
      help.addEventListener('click', function () { acceptWork(m, w, card); });
      actions.appendChild(help);
    } else {
      var check = el('a', 'sui-panel-btn sui-mod-default chat-ref-action');
      check.href = 'javascript:void(0)';
      check.appendChild(icon('icon-okay', 'sui-icon-sm'));
      check.appendChild(el('span', null, 'Check'));
      check.addEventListener('click', function () { verifyWork(w, card); });
      actions.appendChild(check);
    }
    card.appendChild(actions);
    return card;
  }

  // Take on somebody else's task.
  //
  // Nothing here can submit anything: the completion tx names its signer as
  // `creator` and only the owner's is accepted. This spends GPU and posts a
  // number back — that is the whole of it.
  function acceptWork(m, w, card) {
    var line = card.querySelector('.chat-work-verdict');
    if (!line) { line = el('div', 'chat-work-verdict'); card.appendChild(line); }
    line.className = 'chat-work-verdict';
    line.textContent = 'Working on it\u2026';
    return invoke('matrix_work_accept', {
      guildId: S.guildId, roomId: S.roomId, offerEvent: serverIdOf(m),
      objectId: w.object, task: w.task, blockStart: w.block_start,
      difficulty: w.difficulty, targetId: w.target || null,
    })
      .then(function (res) {
        line.className = 'chat-work-verdict chat-mod-good';
        line.textContent = res && res.already
          ? 'Already working on this one.'
          : 'Working on it. The nonce will be posted here when it lands \u2014 '
            + 'only the owner can submit it.';
      })
      .catch(function (e) {
        line.className = 'chat-work-verdict chat-mod-bad';
        line.textContent = String(e);
      });
  }
  Chat.acceptWork = acceptWork;

  // Verify before anything else. A result arriving over federation is a
  // CLAIM: everything but the number is rebuilt from what this side knows,
  // and the hash is recomputed. A forged one otherwise costs the owner a
  // failed transaction and its charge.
  function verifyWork(w, card) {
    return invoke('matrix_work_verify', {
      objectId: w.object, task: w.task, blockStart: w.block_start,
      difficulty: w.difficulty, nonce: w.nonce, targetId: w.target || null,
    })
      .then(function (res) {
        var line = card.querySelector('.chat-work-verdict');
        if (!line) { line = el('div', 'chat-work-verdict'); card.appendChild(line); }
        if (res && res.ok) {
          line.className = 'chat-work-verdict chat-mod-good';
          line.textContent = 'Checks out. Valid only while block ' + w.block_start
            + ' is still the live cycle.';
          offerSubmit(w, card);
        } else {
          line.className = 'chat-work-verdict chat-mod-bad';
          line.textContent = 'That nonce does not solve this task.';
        }
      })
      .catch(function (e) { showError(String(e)); });
  }
  Chat.verifyWork = verifyWork;

  // Submitting is the owner's act and costs them charge, so it is a separate
  // click from checking — and it only appears once the proof has been
  // checked. A button that both verifies and spends would make the check
  // invisible at exactly the moment it matters.
  function offerSubmit(w, card) {
    if (card.querySelector('.chat-work-submit')) return;
    var b = el('a', 'sui-panel-btn sui-mod-default chat-ref-action chat-work-submit');
    b.href = 'javascript:void(0)';
    b.appendChild(icon('icon-send-alpha', 'sui-icon-sm'));
    b.appendChild(el('span', null, 'Submit'));
    b.title = 'Submit this proof yourself — it costs your charge, not theirs';
    b.addEventListener('click', function () {
      var line = card.querySelector('.chat-work-verdict');
      line.className = 'chat-work-verdict';
      line.textContent = 'Submitting\u2026';
      invoke('matrix_work_submit', {
        objectId: w.object, task: w.task, blockStart: w.block_start,
        difficulty: w.difficulty, nonce: w.nonce, targetId: w.target || null,
      })
        .then(function () {
          line.className = 'chat-work-verdict chat-mod-good';
          line.textContent = 'Submitted.';
          b.remove();
        })
        .catch(function (e) {
          line.className = 'chat-work-verdict chat-mod-bad';
          line.textContent = String(e);
        });
    });
    var bar = card.querySelector('.chat-ref-actions');
    if (bar) bar.appendChild(b);
  }

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
      return COMMANDS.map(function (c) { return '/' + c.name; })
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

  // ── Announcing that we are typing ────────────────────────────────────────
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

  // ── Commands ──────────────────────────────────────────────────────────────
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
    wasAtBottom = true;                  // an answer to something you typed
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
    wasAtBottom = true;
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

  // ── Scroll anchoring ──────────────────────────────────────────────────────
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

  // ── Connection view ───────────────────────────────────────────────────────
  // The sign-in chain has six hops across three services. When it breaks, the
  // useful question is WHICH hop — so the ladder is the primary UI here, not a
  // spinner.
  var STEP_ICON = {
    done: 'icon-success', active: 'icon-in-progress',
    failed: 'icon-alert', todo: 'icon-unknown',
  };
  function stepRow(st) {
    var row = el('div', 'chat-step chat-mod-' + (st.state || 'todo'));
    var mark = el('div', 'chat-step-state');
    mark.appendChild(icon(STEP_ICON[st.state] || STEP_ICON.todo, 'sui-icon-sm'));
    row.appendChild(mark);
    var text = el('div');
    text.appendChild(el('div', 'chat-step-label', st.label));
    if (st.detail) text.appendChild(el('div', 'chat-step-detail sui-text-tiny', st.detail));
    row.appendChild(text);
    return row;
  }

  function kv(k, v) {
    var row = el('div', 'chat-kv');
    row.appendChild(el('div', null, k));
    row.appendChild(el('div', null, v == null ? '—' : String(v)));
    return row;
  }

  // The shared one — the raid rail shows the same block, and its styles moved
  // to chat-rows.css with the rest of the timeline's.
  function noticeBlock(title, detail, isError) {
    return window.StructsChatRow.notice(title, detail, isError);
  }

  function statusSharingRow() {
    var row = el('div', 'sui-data-card-row');
    row.appendChild(el('span', 'sui-text-hint', 'Activity'));
    var val = el('span', 'chat-status-share');
    val.appendChild(el('span', null, S.sharingStatus
      ? (S.myStatus || 'Shared')
      : 'Not shared'));
    var a = el('a', 'chat-ref-action');
    a.href = 'javascript:void(0)';
    a.appendChild(el('span', null, S.sharingStatus ? 'Stop sharing' : 'Share'));
    a.title = S.sharingStatus
      ? 'Stop telling other players what you are doing'
      : 'Tell other players roughly what you are doing — including when your '
        + 'fleet is away, which says your planet may be undefended';
    a.addEventListener('click', function () { setStatusSharing(!S.sharingStatus); });
    val.appendChild(a);
    row.appendChild(val);
    return row;
  }

  function setStatusSharing(on) {
    return invoke('matrix_status_sharing', { guildId: S.guildId, enabled: on })
      .then(function (res) {
        S.sharingStatus = !!(res && res.enabled);
        S.myStatus = (res && res.status) || null;
        render();
      })
      .catch(function (e) { showError(String(e)); });
  }
  Chat.setStatusSharing = setStatusSharing;

  function renderConnection() {
    var page = el('div', 'chat-page');
    page.appendChild(pageHeader('Connection', function () { go('channels'); }, headerResources()));

    var scroll = el('div', 'chat-scroll');
    var net = activeNetwork();

    // Nothing is known until the first status reply lands, and "nothing known"
    // is not the same as "nothing there". Reporting no comms server before
    // asking made every launch flash a failure it had no evidence for.
    if (!S.started) {
      scroll.appendChild(noticeBlock('Connecting', 'Reaching your guild’s comms server.'));
      page.appendChild(scroll);
      return page;
    }

    if (!S.networks.length) {
      scroll.appendChild(noticeBlock(
        'No comms server',
        'No guild you can reach publishes a matrix service in its guild.json. ' +
        'Nothing to connect to yet.'));
      page.appendChild(scroll);
      return page;
    }

    // Identity
    var idCard = el('div', 'sui-data-card');
    idCard.appendChild(el('div', 'sui-data-card-header sui-text-header', 'Identity'));
    var idBody = el('div', 'sui-data-card-body');
    idBody.appendChild(kv('Network', net ? (net.guild_name || net.guild_id) : '—'));
    idBody.appendChild(kv('Homeserver', net ? net.homeserver : '—'));
    idBody.appendChild(kv('Matrix ID', S.profile ? S.profile.user_id : (net && net.user_id) || '—'));
    idBody.appendChild(kv('Player', S.profile ? S.profile.display_name : '—'));
    // Whether other clients can see this player's face. It renders correctly
    // in here whatever the answer, so this is the only place the difference
    // is visible at all — it was a tooltip on the composer portrait and
    // nowhere else.
    if (S.profile) {
      idBody.appendChild(kv('Portrait',
        S.profile.avatar_published ? 'Published' : 'Not published yet'));
    }
    // What this player tells everyone else about themselves. Off unless
    // asked for, and the row says exactly what turning it on would reveal —
    // this is a game about raiding each other, and "fleet away" tells a
    // rival your planet may be undefended.
    idBody.appendChild(statusSharingRow());
    idCard.appendChild(idBody);
    scroll.appendChild(idCard);

    // Ladder
    if (S.steps.length) {
      var stepCard = el('div', 'sui-data-card');
      stepCard.appendChild(el('div', 'sui-data-card-header sui-text-header', 'Sign-in'));
      var stepBody = el('div', 'sui-data-card-body');
      S.steps.forEach(function (st) { stepBody.appendChild(stepRow(st)); });
      stepCard.appendChild(stepBody);
      scroll.appendChild(stepCard);
    }

    if (S.error) {
      scroll.appendChild(noticeBlock('Not connected', S.error, true));
    }

    // No Connect button and no Sign out. Signing in needs nothing from the
    // player — the credential is the key they are already playing with — so
    // asking would be a question with one sensible answer. Signing out would
    // only strand them somewhere they cannot chat from.
    //
    // Reconnect is a different thing and does belong here. A session can go
    // bad while still reporting itself signed in — a homeserver that has
    // forgotten the token, a sync loop that has stopped answering — and the
    // window then has no failure to retry, so "Try again" never appears and
    // the player is stuck being told everything is fine. This drops the
    // session and immediately takes another, which is the actual fix for
    // that state and never leaves them signed out.
    var connected = !!(net && net.logged_in);
    var actions = el('div', 'sui-screen-btn-flex-wrapper');
    if (!connected && !S.connecting) {
      var btn = el('button', 'sui-screen-btn sui-mod-primary');
      btn.id = 'chat-retry';
      btn.textContent = 'Try again';
      btn.addEventListener('click', function () { connect(); });
      actions.appendChild(btn);
    } else if (connected) {
      var again = el('button', 'sui-screen-btn');
      again.id = 'chat-reconnect';
      again.textContent = S.connecting ? 'Reconnecting…' : 'Reconnect';
      again.disabled = !!S.connecting;
      again.title = 'Drop this session and take a fresh one';
      again.addEventListener('click', function () { reconnect(); });
      actions.appendChild(again);
    }
    if (actions.childNodes.length) scroll.appendChild(actions);

    page.appendChild(scroll);
    return page;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Rendering replaces the whole page, composer included — so a message
  // arriving while you are mid-sentence would otherwise delete what you had
  // typed and take the cursor with it. A chat window that eats your draft
  // whenever someone else speaks is unusable, so the draft is carried across.
  function draftOf(id) {
    var node = byId(id);
    if (!node) return null;
    return {
      id: id,
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
      focused: document.activeElement === node,
    };
  }

  function restoreDraft(d) {
    if (!d) return;
    var node = byId(d.id);
    if (!node) return;
    node.value = d.value;
    if (d.focused) {
      node.focus();
      try { node.setSelectionRange(d.start, d.end); } catch (e) {}
    }
  }

  // ── The dock signal ───────────────────────────────────────────────────────
  // The window knows what is actually being read; Rust owns the title bar. A
  // count in the title is the oldest unread signal there is and still the one
  // you can see without switching to the app.
  var badgeShown = '';
  function updateBadge() {
    var count = 0;
    var mention = false;
    S.rooms.forEach(function (r) {
      count += Number(r.unread) || 0;
      if (r.mention) mention = true;
    });
    var key = count + ':' + mention;
    if (key === badgeShown) return;      // the title bar is not a hot path
    badgeShown = key;
    invoke('matrix_badge', { count: count, mention: mention }).catch(function () {});
  }

  function render() {
    updateBadge();
    var host = byId('menu-page-body-content');
    if (!host) return;
    // Both text inputs the window has; only one exists at a time.
    var draft = draftOf('chat-input') || draftOf('chat-people-query')
      || draftOf('chat-browse-query');
    var timeline = byId('chat-timeline');
    var prevTop = timeline ? timeline.scrollTop : 0;
    noteScrollPosition();
    clear(host);
    var node;
    if (S.view === 'room') node = renderRoom();
    else if (S.view === 'connection') node = renderConnection();
    else if (S.view === 'people') node = renderPeople();
    else if (S.view === 'browse') node = renderBrowse();
    else if (S.view === 'members') node = renderMembers();
    else if (S.view === 'search') node = renderSearch();
    else node = renderChannels();
    // Above whatever the player is looking at. A stall is not about one
    // conversation, and the view they happen to be on is not where it stops
    // mattering.
    // At the top of the PAGE, not beside it: the host is a flex ROW, so a
    // sibling banner sat next to the page and squeezed the conversation into
    // half the window. Every view returns a `.chat-page`, and that is a
    // column.
    var stalled = stalledBanner();
    if (stalled) node.insertBefore(stalled, node.firstChild);
    host.appendChild(node);
    // Every view except a room is composer-less; the host is emptied here so
    // no stale action bar survives a view change.
    if (S.view !== 'room') {
      var bar = byId('chat-composer-host');
      if (bar) clear(bar);
    }
    restoreDraft(draft);
    keepPlace(prevTop);
    renderNav();
  }
  Chat.render = render;

  // One marker per room per event: render() runs constantly and the homeserver
  // does not need to hear the same thing twice.
  var marked = {};
  function markRead(roomId, eventId) {
    if (!roomId || !eventId) return;
    // Local echoes and the window's own notices are not server events.
    if (String(eventId).charAt(0) !== '$') return;
    if (marked[roomId] === eventId) return;
    marked[roomId] = eventId;
    invoke('matrix_mark_read', { guildId: S.guildId, roomId: roomId, eventId: eventId })
      .catch(function () {});
  }

  function go(view) {
    if (view !== 'channels') S.filterWanted = false;
    S.view = view;
    if (view === 'channels') {
      stopTyping();
      S.roomId = null; S.room = null; S.messages = [];
    }
    render();
    if (view === 'channels') refreshRooms();
    if (view === 'people') loadPeople();
    if (view === 'browse') loadBrowse();
    if (view === 'members') loadMembers();
    if (view === 'search') {
      var q = byId('chat-search-query');
      if (q) { q.focus(); moveCaretToEnd(q); }
    }
  }
  Chat.go = go;

  function showError(msg) {
    S.error = msg;
    S.view = 'connection';
    render();
  }

  function activeNetwork() {
    for (var i = 0; i < S.networks.length; i++) {
      if (S.networks[i].guild_id === S.guildId) return S.networks[i];
    }
    return null;
  }
  Chat.activeNetwork = activeNetwork;

  // ── Data ──────────────────────────────────────────────────────────────────
  // Status arrives two ways: as a full snapshot from matrix_status, and as
  // PARTIAL pushes while connecting ({connecting, steps}) or when a session is
  // rejected ({error}). Every field is therefore merged, never replaced —
  // assigning `st.networks || []` here once blanked the nav mid-connect and
  // took activeNetwork() with it.
  function applyStatus(st) {
    if (!st) return;
    if (st.networks) S.networks = st.networks;
    S.resources = st.resources || S.resources;
    if (st.steps) S.steps = st.steps;
    if (typeof st.connecting === 'boolean') S.connecting = st.connecting;
    if (st.error !== undefined) S.error = st.error;
    if (!S.guildId || !activeNetwork()) {
      var active = null;
      S.networks.forEach(function (n) {
        if (n.active && !active) active = n;
      });
      S.guildId = (active || S.networks[0] || {}).guild_id || null;
    }
    if (st.profile) S.profile = st.profile;
  }

  function refreshStatus() {
    return invoke('matrix_status', { asPlayer: AS_PLAYER })
      .then(function (st) {
        S.started = true;
        applyStatus(st);
        return st;
      })
      .catch(function (e) {
        // Even a failed ask is an answer: we asked, and now we can say so.
        S.started = true;
        throw e;
      });
  }

  // Unread comes from the HOMESERVER, which maintains it against the read
  // receipts this app sends. That is what makes it survive this window
  // closing, survive a restart, and agree with the same account open in
  // Element on a phone — none of which a count kept in here could do.
  //
  // One exception, and it is about latency rather than truth: the room on
  // screen is being read right now, and its receipt is in flight. Letting the
  // server's stale count paint over that would flash a badge on the room you
  // are looking at. Everything else takes the server's word.
  function adoptRooms(rooms) {
    S.rooms = (rooms || []).map(function (r) {
      if (r.room_id === S.roomId) { r.unread = 0; r.mention = false; }
      return r;
    });
  }

  function refreshRooms() {
    var net = activeNetwork();
    if (!net || !net.logged_in) { S.loading = false; return Promise.resolve(); }
    return invoke('matrix_rooms', { guildId: S.guildId })
      .then(function (res) {
        adoptRooms(res && res.rooms);
        S.loading = false;
        if (S.view === 'channels') render();
      })
      .catch(function (e) {
        S.loading = false;
        showError(String(e));
      });
  }
  Chat.refreshRooms = refreshRooms;

  function openRoom(roomId) {
    S.roomId = roomId;
    S.room = null;
    S.messages = [];
    S.view = 'room';
    // Frozen at open: the divider marks where this visit STARTED reading, so
    // it must not slide down as messages below it are read.
    S.dividerTs = Number(S.lastRead[roomId]) || 0;
    openTab(roomId);
    // Whatever we were mid-sentence in, we are not any more.
    stopTyping();
    S.typing = [];
    S.members = [];
    S.moreHistory = true;
    S.loadingHistory = false;
    S.rooms.forEach(function (r) {
      if (r.room_id === roomId) { r.unread = 0; r.mention = false; }
    });
    for (var i = 0; i < S.rooms.length; i++) {
      if (S.rooms[i].room_id === roomId) { S.room = S.rooms[i]; break; }
    }
    render();
    return invoke('matrix_timeline', { guildId: S.guildId, roomId: roomId, limit: 60 })
      .then(function (res) {
        if (S.roomId !== roomId) return;   // the user moved on while we waited
        if (res && res.room) S.room = res.room;
        S.messages = (res && res.messages) || [];
        S.seen = (res && res.seen) || null;
        wasAtBottom = true;              // a room you just opened starts at the end
        render();
        scrollToEnd();
        // Something was shared while no room was open; this is the room it
        // was waiting for.
        if (S.draft) putDraft(S.draft);
        S.pins = [];
        S.replyTo = null;
        S.filterWanted = false;
        S.deleteArmed = null;
        S.editing = null;
        S.seen = null;
        if (S.pinsOpen[roomId] && pinCount()) loadPins();
      })
      .catch(function (e) { showError(String(e)); });
  }
  Chat.openRoom = openRoom;

  function selectNetwork(guildId) {
    if (guildId === S.guildId) return;
    S.guildId = guildId;
    S.rooms = [];
    S.roomId = null;
    S.room = null;
    S.messages = [];
    S.loading = true;
    S.error = null;
    var net = activeNetwork();
    S.view = (net && net.logged_in) ? 'channels' : 'connection';
    render();
    invoke('matrix_select', { guildId: guildId }).catch(function () {});
    if (net && net.logged_in) refreshRooms();
  }
  Chat.selectNetwork = selectNetwork;

  // Open what the rest of the app asked for. Also polled once at boot, because
  // the request usually arrives while this window is still starting up and
  // there is nothing listening yet.
  function showRequestedRoom(target) {
    if (!target || !target.room_id) return;
    /* A guild we do not know YET is not a different guild.
     *
     * `S.guildId` is filled by `refreshStatus()`, and the listeners above are
     * registered before that call returns — so a request arriving during boot
     * met `S.guildId === null`, failed this comparison, and was dropped in
     * silence. That is exactly when these requests arrive: the usual case is
     * a Message click that OPENS this window, and Team Ops emits as soon as
     * the DM resolves, which can beat our first status round-trip.
     *
     * Only a guild we actually know and that actually differs is a reason to
     * ignore one.
     */
    if (target.guild_id && S.guildId && target.guild_id !== S.guildId) return;
    refreshRooms().then(function () { openRoom(target.room_id); });
  }

  // The player's own objects, for completing an id. Asked once: your planet
  // does not change while you are typing.
  function loadMyIds() {
    return invoke('matrix_id_suggestions')
      .then(function (res) { S.myIds = (res && res.ids) || []; })
      .catch(function () {});
  }

  function claimPendingRoom() {
    return invoke('matrix_take_pending_room')
      .then(showRequestedRoom)
      .catch(function () {});
  }

  // ── Shared from the game ──────────────────────────────────────────────────
  // An object handed over from a raid window or Team Ops. It lands as a draft:
  // the player chooses the room and presses send. A share is one click from a
  // game window, and one click must never put a message in front of other
  // people.
  function acceptDraft(payload) {
    var text = payload && payload.text;
    if (!text) return;
    S.draft = text;
    if (S.view === 'room') {
      putDraft(text);
    } else {
      // No room open yet — say what is waiting, and hold it until one is.
      S.view = 'channels';
      render();
    }
  }
  Chat.acceptDraft = acceptDraft;

  function putDraft(text) {
    render();
    var input = byId('chat-input');
    if (!input) return;
    // Append rather than replace: a draft already being written is the
    // player's, and sharing into the middle of it must not destroy it.
    var head = input.value ? input.value.replace(/\s*$/, '') + ' ' : '';
    input.value = head + text + ' ';
    input.focus();
    moveCaretToEnd(input);
    S.draft = null;
    render();
  }

  function claimPendingDraft() {
    return invoke('matrix_take_pending_draft')
      .then(acceptDraft)
      .catch(function () {});
  }

  function connect() {
    S.connecting = true;
    S.error = null;
    S.steps = [];
    render();
    return invoke('matrix_connect', { guildId: S.guildId })
      .then(function (res) {
        S.connecting = false;
        if (res && res.steps) S.steps = res.steps;
        return refreshStatus();
      })
      .then(function () {
        var net = activeNetwork();
        if (net && net.logged_in) {
          S.error = null;
          S.loading = true;
          S.view = 'channels';
          render();
          loadMyIds();
          loadPresence();
          return refreshRooms().then(claimPendingRoom).then(claimPendingDraft);
        }
        render();
      })
      .catch(function (e) {
        S.connecting = false;
        S.error = String(e);
        render();
      });
  }
  Chat.connect = connect;

  function disconnect() {
    return invoke('matrix_disconnect', { guildId: S.guildId })
      .then(refreshStatus)
      .then(function () {
        S.rooms = [];
        S.messages = [];
        S.roomId = null;
        S.steps = [];
        render();
      })
      .catch(function (e) { showError(String(e)); });
  }
  Chat.disconnect = disconnect;

  // Drop this session and take another, without ever passing through a
  // signed-out state the player has to get themselves out of.
  function reconnect() {
    S.connecting = true;
    render();
    return disconnect()
      .then(connect)
      .catch(function (e) {
        S.connecting = false;
        S.error = String(e);
        render();
      });
  }
  Chat.reconnect = reconnect;

  // ── Live updates ──────────────────────────────────────────────────────────
  // Rust runs the /sync loop and pushes. The window never polls.
  //
  // Event names are namespaced per window label the way the raid windows are:
  // a plain listen() registers for target Any and would otherwise also receive
  // emissions aimed at other windows.
  function dropEcho(list, incoming) {
    // Remove a local echo once the homeserver's own copy of it arrives.
    var ids = {};
    incoming.forEach(function (m) { if (m.event_id) ids[m.event_id] = 1; });
    return list.filter(function (m) {
      if (m.local) return true;           // the window's own lines are not events
      if (m.echo_of && ids[m.echo_of]) return false;
      if (m.event_id && ids[m.event_id]) return false;
      return true;
    });
  }

  function onTimeline(payload) {
    if (!payload) return;
    if (payload.guild_id && payload.guild_id !== S.guildId) return;
    // A room we are not looking at only needs a repaint.
    if (payload.room_id !== S.roomId) {
      // No counting here. The same sync that delivered these messages also
      // carried the homeserver's own unread figures, and they arrive as a
      // room-list push a moment later. Adding to them as well double-counted
      // every message.
      //
      // The channel list is not the only place unread shows any more — the tab
      // strip is visible from inside a room, so traffic in a background tab
      // has to light it up while you are reading another one.
      if (S.view === 'channels' || S.view === 'room') render();
      return;
    }
    var incoming = payload.messages || [];
    if (!incoming.length) return;
    var following = atBottom();
    S.messages = dropEcho(S.messages, incoming).concat(incoming);
    // Keep the retained timeline bounded; scrollback is re-fetched on demand.
    if (S.messages.length > 500) S.messages = S.messages.slice(-500);
    render();
    // Only follow if they were already following. Otherwise the new messages
    // wait below, which is what the unread divider is for.
    if (following) scrollToEnd();
  }
  Chat.onTimeline = onTimeline;

  // MSN's contribution to chat: knowing someone is answering. Matrix carries
  // it as an ephemeral EDU in every sync, so it costs nothing extra.
  function onTyping(payload) {
    if (!payload) return;
    if (payload.guild_id && payload.guild_id !== S.guildId) return;
    if (payload.room_id !== S.roomId) return;
    var names = payload.names || [];
    // Only repaint when the set actually changed — sync reports it constantly.
    if (names.join('\u0000') === S.typing.join('\u0000')) return;
    S.typing = names;
    if (S.view === 'room') render();
  }
  Chat.onTyping = onTyping;

  // "Ada is typing…", "Ada and Bo are typing…", "3 people are typing…".
  // Naming everyone stops being useful past two, and a long list pushes the
  // composer around.
  function typingLine(names) {
    if (!names || !names.length) return '';
    if (names.length === 1) return names[0] + ' is typing…';
    if (names.length === 2) return names[0] + ' and ' + names[1] + ' are typing…';
    return names.length + ' people are typing…';
  }
  Chat.typingLine = typingLine;

  function onRooms(payload) {
    if (!payload) return;
    if (payload.guild_id && payload.guild_id !== S.guildId) return;
    adoptRooms(payload.rooms);
    S.loading = false;
    // Both views, not just the channel list: unread now ARRIVES on this push
    // rather than being counted when a message lands, and the tab strip is
    // visible from inside a room. Repainting only the channel list left every
    // background tab dark for as long as you stayed in the room you were
    // reading — which is exactly when you want to see one light up.
    if (S.view === 'channels' || S.view === 'room') render();
  }
  Chat.onRooms = onRooms;

  function onStatus(payload) {
    /* Somebody else's status is not ours.
     *
     * These are BROADCASTS — a plain `listen()` targets Any, so every chat
     * window receives every one. With two identities signed in, an unfiltered
     * handler would let the primary's window adopt the roster player's
     * connection state, and show a sign-in ladder for a sign-in it is not
     * doing. Payloads name whose they are; a payload for a different identity
     * is dropped.
     *
     * A payload naming NO identity is accepted: that is the sync loop's
     * error-only push, which predates identities and belongs to whoever reads
     * it.
     */
    if (payload && payload.as_player !== undefined
        && (payload.as_player || null) !== AS_PLAYER) {
      return;
    }
    applyStatus(payload);
    render();
    // A push that only carries an error is the sync loop telling us the
    // homeserver dropped the session. It cannot include the network list, so
    // ask for the real state rather than leaving stale "logged in" rows.
    if (payload && payload.error && !payload.networks) {
      refreshStatus().then(render).catch(function () {});
    }
  }
  Chat.onStatus = onStatus;

  // ── Boot ──────────────────────────────────────────────────────────────────
  function boot() {
    var close = byId('menu-page-nav-close');
    if (close) {
      close.addEventListener('click', function () {
        stopTyping();
        // Rust closes it, for the same reason Rust opened it. The JS window
        // API is a trap here: `getCurrent()` is the Tauri v1 spelling and is
        // simply absent on v2, so the button would silently do nothing.
        invoke('close_chat_window').catch(function () {
          try { window.close(); } catch (e) { /* nothing else to try */ }
        });
      });
    }
    document.addEventListener('keydown', function (e) {
      // The window-wide keys come from SHORTCUTS, which is the same table
      // /help prints. A shortcut nobody can find is a shortcut nobody uses,
      // and two lists — one that works and one that describes — drift.
      for (var si = 0; si < SHORTCUTS.length; si++) {
        var sc = SHORTCUTS[si];
        if (!sc.run || !sc.match(e)) continue;
        e.preventDefault();
        sc.run();
        return;
      }
      // Escape backs out one level, from anywhere. The one key every window in
      // every OS agrees on.
      if (e.key !== 'Escape') return;
      if (S.view === 'channels') return;         // already at the top level
      // The search field handles its own Escape — back to the conversation it
      // was searching, not all the way out to the channel list.
      if (S.view === 'search' && document.activeElement
          && document.activeElement.id === 'chat-search-query') return;
      e.preventDefault();
      go('channels');
    });

    var comms = byId('chat-nav-comms');
    if (comms) comms.addEventListener('click', function () { go('channels'); });
    var settings = byId('chat-nav-settings');
    if (settings) settings.addEventListener('click', function () { go('connection'); });

    listen('matrix::timeline', function (e) { onTimeline(e && e.payload); });
    listen('matrix::typing', function (e) { onTyping(e && e.payload); });
    // Somewhere else in the app asked for a conversation — a message icon in
    // Team Ops, a raid window, anywhere a player is listed.
    listen('matrix::show_room', function (e) { showRequestedRoom(e && e.payload); });
    // Something in the game was shared into chat.
    listen('matrix::compose', function (e) { acceptDraft(e && e.payload); });
    listen('matrix::reactions', function (e) { onReactions(e && e.payload); });
    listen('matrix::redacted', function (e) { onRedacted(e && e.payload); });
    listen('matrix::edited', function (e) { onEdited(e && e.payload); });
    listen('matrix::seen', function (e) { onSeen(e && e.payload); });
    listen('matrix::presence', function (e) { onPresence(e && e.payload); });
    listen('matrix::sync_health', function (e) { onSyncHealth(e && e.payload); });
    listen('matrix::rooms', function (e) { onRooms(e && e.payload); });
    listen('matrix::status', function (e) { onStatus(e && e.payload); });

    render();

    refreshStatus()
      .then(function () {
        var net = activeNetwork();
        if (net && net.logged_in) {
          S.view = 'channels';
          S.loading = true;
          render();
          loadMyIds();
          loadPresence();
          return refreshRooms().then(claimPendingRoom).then(claimPendingDraft);
        }
        S.loading = false;
        if (!net) {
          // Nothing to connect to; the connection page says so.
          S.view = 'connection';
          render();
          return;
        }
        // Sign in without being asked. The credential is the key the player is
        // already using, so a Connect button would be a prompt with exactly one
        // answer. The ladder is shown while it runs, so a slow or broken hop is
        // still visible rather than hidden behind a spinner.
        S.view = 'connection';
        render();
        return connect();
      })
      .catch(function (e) {
        S.loading = false;
        S.error = String(e);
        S.view = 'connection';
        render();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
