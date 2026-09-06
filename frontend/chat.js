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
    ? function (name, cb) { return window.StructsEvents.listen(name, cb); }
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

  // ── Presence, seen, silence ───────────────────────────────────────────────
  // Lives in chat-presence.js. Wired before anything that passes
  // `presenceDot` by name. `moveCaretToEnd` and `render` come later: thunks.
  var presenceModule = window.ChatPresence({
    el: el, icon: icon, invoke: invoke, byId: byId, render: function () { render(); },
    moveCaretToEnd: function (input) { moveCaretToEnd(input); }, showError: showError, S: S, Chat: Chat,
  });
  var seenLine = presenceModule.seenLine, onSeen = presenceModule.onSeen, presenceDot = presenceModule.presenceDot;
  var onSyncHealth = presenceModule.onSyncHealth, stalledBanner = presenceModule.stalledBanner;
  var onPresence = presenceModule.onPresence, loadPresence = presenceModule.loadPresence;
  var replyButton = presenceModule.replyButton, setMuted = presenceModule.setMuted;

  // ── Object references ─────────────────────────────────────────────────────
  // Lives in chat-refs.js; wired here with the collaborators it needs. Every
  // collaborator is a function declaration (hoisted), except `render`, which
  // is passed as a thunk out of caution.
  var refs = window.ChatRefs({
    el: el, icon: icon, invoke: invoke, fmtCount: fmtCount, go: go, pfpPortrait: pfpPortrait,
    presenceDot: presenceDot, render: function () { render(); }, rentForm: rentForm,
    startDm: function (who, body) { return startDm(who, body); },
    S: S, Chat: Chat,
  });
  var ID_RE = refs.ID_RE, REF_KINDS = refs.REF_KINDS, refCards = refs.cards;
  var refCard = refs.refCard, wantRefs = refs.wantRefs, cardNote = refs.cardNote;

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
    // Inside the card's own body when the provider is drawn as a card, so
    // the form reads as part of the offer rather than a box under it.
    (box.querySelector('.sui-planet-card-body') || box).appendChild(form);
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
    // Agreement lengths run to a million blocks; "1000K" is not a number
    // anyone says, "1M" is.
    if (n >= 1e6) {
      var m = n / 1e6;
      return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
    }
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
  // Lives in chat-channels.js: the sections, the room row, the order a list
  // is read in and the Channels page itself. Collaborators that are function
  // declarations are passed as they are (hoisted); `render` as a thunk.
  var channels = window.ChatChannels({
    el: el, icon: icon, invoke: invoke, fmtCount: fmtCount, go: go, pfpPortrait: pfpPortrait,
    presenceDot: presenceDot, render: function () { render(); }, refreshRooms: refreshRooms,
    showError: showError, openRoom: openRoom, headerResources: headerResources, pageHeader: pageHeader,
    byId: byId, moveCaretToEnd: function (input) { moveCaretToEnd(input); }, noticeBlock: noticeBlock,
    S: S, Chat: Chat,
  });
  var SECTIONS = channels.SECTIONS, serverOf = channels.serverOf, foreignServerLabel = channels.foreignServerLabel;
  var roomRow = channels.roomRow, roomOrder = channels.roomOrder, filteredRooms = channels.filteredRooms;
  var matchesFilter = channels.matchesFilter, renderChannels = channels.renderChannels;

  // ── People ────────────────────────────────────────────────────────────────
  // Lives in chat-people.js: who is in the room, the channel directory, the
  // player directory and starting a direct message. Declarations are passed
  // as they are (hoisted); anything defined later in this file as a thunk.
  var people = window.ChatPeople({
    el: el, icon: icon, invoke: invoke, go: go, pageHeader: pageHeader, noticeBlock: noticeBlock,
    render: function () { render(); }, showError: showError, pfpPortrait: pfpPortrait, presenceDot: presenceDot,
    roomRow: roomRow, refreshRooms: refreshRooms, openRoom: openRoom,
    sendMessage: function (body) { return sendMessage(body); }, say: function (text, alert) { say(text, alert); },
    S: S, Chat: Chat,
  });
  var renderMembers = people.renderMembers, loadMembers = people.loadMembers;
  var renderBrowse = people.renderBrowse, loadBrowse = people.loadBrowse;
  var renderPeople = people.renderPeople, loadPeople = people.loadPeople, startDm = people.startDm;

  // ── Search ────────────────────────────────────────────────────────────────
  // Lives in chat-search.js. `messageNode` is a declaration (hoisted).
  var searchModule = window.ChatSearch({
    el: el, icon: icon, invoke: invoke, go: go, pageHeader: pageHeader, noticeBlock: noticeBlock,
    unreadFor: unreadFor, messageNode: messageNode, openRoom: openRoom,
    render: function () { render(); }, showError: showError, S: S, Chat: Chat,
  });
  var renderSearch = searchModule.renderSearch, runSearch = searchModule.runSearch, openSearch = searchModule.openSearch;

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
  // Lives in chat-pins.js: the strip, pin/unpin, and the small message
  // helpers (excerpt, who was answered, jump-to). `serverIdOf` is assigned by
  // the reactions wiring below, so it is a thunk; the rest are declarations.
  var pinsModule = window.ChatPins({
    el: el, icon: icon, invoke: invoke, render: function () { render(); }, showError: showError,
    messageNode: messageNode, unreadFor: unreadFor, say: say,
    serverIdOf: function (m) { return serverIdOf(m); }, S: S, Chat: Chat,
  });
  var pinnedStrip = pinsModule.pinnedStrip, pinsOf = pinsModule.pinsOf, replyWho = pinsModule.replyWho;
  var excerpt = pinsModule.excerpt, jumpTo = pinsModule.jumpTo, cssEscape = pinsModule.cssEscape;
  var pinCount = pinsModule.pinCount, isPinned = pinsModule.isPinned, pinToggle = pinsModule.pinToggle;
  var setPin = pinsModule.setPin, loadPins = pinsModule.loadPins;

  // ── Reactions, edits, removals ────────────────────────────────────────────
  // Live in chat-reactions.js. `moveCaretToEnd` and `render` are declared or
  // assigned further down, so they are handed over as thunks.
  var reactions = window.ChatReactions({
    el: el, icon: icon, byId: byId, invoke: invoke, excerpt: excerpt,
    moveCaretToEnd: function (input) { moveCaretToEnd(input); },
    render: function () { render(); }, showError: showError, S: S, Chat: Chat,
  });
  var reactionRow = reactions.reactionRow, reactButton = reactions.reactButton, react = reactions.react;
  var onReactions = reactions.onReactions, editButton = reactions.editButton, editChip = reactions.editChip;
  var cancelEdit = reactions.cancelEdit, commitEdit = reactions.commitEdit, onEdited = reactions.onEdited;
  var serverIdOf = reactions.serverIdOf, deleteButton = reactions.deleteButton, onRedacted = reactions.onRedacted;

  // ── Shared proof-of-work ──────────────────────────────────────────────────
  // Lives in chat-work.js; wired here with the collaborators it needs. `render`
  // is passed as a thunk because it is declared further down this closure.
  var work = window.ChatWork({
    el: el, icon: icon, invoke: invoke, serverIdOf: serverIdOf, showError: showError,
    render: function () { render(); }, S: S, Chat: Chat,
  });
  var workCard = work.workCard;

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

  // ── Tab completion + input history ────────────────────────────────────────
  // Live in chat-complete.js. `COMMANDS` is declared further down, so it is
  // handed over as a thunk; everything else is a hoisted declaration or a
  // value that already exists here.
  var completion = window.ChatComplete({
    el: el, byId: byId, refIdsIn: refIdsIn, wantRefs: wantRefs, refCards: refCards,
    commands: function () { return COMMANDS; }, S: S, Chat: Chat,
  });
  var complete = completion.complete, resetCompletion = completion.resetCompletion;
  var applyCompletion = completion.applyCompletion, clearCompletionHint = completion.clearCompletionHint;
  var recall = completion.recall, rememberSent = completion.rememberSent, moveCaretToEnd = completion.moveCaretToEnd;

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
  // Live in chat-commands.js. Every collaborator is handed over as a thunk,
  // so declaration order in this closure does not matter; `atBottom` is the
  // one write the section makes into this closure's state.
  var commands = window.ChatCommands({
    byId: byId, invoke: invoke, refCards: refCards, S: S, Chat: Chat,
    excerpt: function (t) { return excerpt(t); },
    go: function (v) { return go(v); },
    openSearch: function (x) { return openSearch(x); },
    refreshRooms: function () { return refreshRooms(); },
    startDm: function (who, body) { return startDm(who, body); },
    commitEdit: function (t) { return commitEdit(t); },
    rememberSent: function (t) { return rememberSent(t); },
    resetCompletion: function () { return resetCompletion(); },
    render: function () { render(); },
    scrollToEnd: function () { return scrollToEnd(); },
    stopTyping: function () { return stopTyping(); },
    mentionsIn: function (t) { return mentionsIn(t); },
    atBottom: function () { wasAtBottom = true; },
  });
  var SHORTCUTS = commands.SHORTCUTS, COMMANDS = commands.COMMANDS;
  var submit = commands.submit, say = commands.say, sendMessage = commands.sendMessage, retrySend = commands.retrySend;

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
  // Lives in chat-connection.js: the sign-in ladder, identity, sharing.
  // The shared one — the raid rail shows the same block, and its styles moved
  // to chat-rows.css with the rest of the timeline's.
  function noticeBlock(title, detail, isError) {
    return window.StructsChatRow.notice(title, detail, isError);
  }

  var connection = window.ChatConnection({
    el: el, icon: icon, invoke: invoke, go: go, pageHeader: pageHeader, headerResources: headerResources,
    noticeBlock: noticeBlock, render: function () { render(); }, showError: showError,
    activeNetwork: function () { return activeNetwork(); }, connect: function () { return connect(); },
    reconnect: function () { return reconnect(); }, S: S, Chat: Chat,
  });
  var renderConnection = connection.renderConnection, setStatusSharing = connection.setStatusSharing;

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
