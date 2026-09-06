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
    presenceDot: presenceDot, render: function () { render(); }, rentForm: function (card, box) { return rentForm(card, box); },
    startDm: function (who, body) { return startDm(who, body); },
    S: S, Chat: Chat,
  });
  var ID_RE = refs.ID_RE, REF_KINDS = refs.REF_KINDS, refCards = refs.cards;
  var refCard = refs.refCard, wantRefs = refs.wantRefs, cardNote = refs.cardNote;

  // ── Renting capacity ──────────────────────────────────────────────────────
  // Lives in chat-rent.js. `cardNote` is the refs module's, assigned just
  // above; `fmtCount` is a declaration.
  var rent = window.ChatRent({
    el: el, invoke: invoke, fmtCount: fmtCount, cardNote: function (box, text, bad) { return cardNote(box, text, bad); },
  });
  var rentForm = rent.rentForm, numberField = rent.numberField;

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

  // ── Nav + tabs ─────────────────────────────────────────────────────────────
  // Lives in chat-tabs.js: the conversations you have open, in the slot the
  // game uses for its menu sections. `openRoom`, `go` and `activeNetwork`
  // are declarations (hoisted); `render` a thunk.
  var tabs = window.ChatTabs({
    el: el, icon: icon, byId: byId, clear: clear, render: function () { render(); },
    openRoom: openRoom, go: go, activeNetwork: activeNetwork, S: S, Chat: Chat,
  });
  var openTab = tabs.openTab, closeTab = tabs.closeTab, tabLabel = tabs.tabLabel;
  var unreadFor = tabs.unreadFor, renderNav = tabs.renderNav;

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
    unreadFor: unreadFor, messageNode: function (m, prev) { return messageNode(m, prev); }, openRoom: openRoom,
    render: function () { render(); }, showError: showError, S: S, Chat: Chat,
  });
  var renderSearch = searchModule.renderSearch, runSearch = searchModule.runSearch, openSearch = searchModule.openSearch;

  // ── Room view: the message ─────────────────────────────────────────────────
  // Lives in chat-message.js: the timeline row with its controls, the body
  // with ids and links marked, pictures, rules. Every collaborator that is a
  // module value assigned further down (reactions, pins, work, commands) is a
  // thunk; declarations and the refs wiring above are passed as they are.
  var message = window.ChatMessage({
    el: el, invoke: invoke, render: function () { render(); }, mentionsMe: mentionsMe,
    startDm: function (who, body) { return startDm(who, body); },
    refCards: refCards, refCard: refCard, wantRefs: wantRefs, ID_RE: ID_RE, REF_KINDS: REF_KINDS,
    loadHistory: function () { return loadHistory(); }, retrySend: function (m) { return retrySend(m); },
    workCard: function (m) { return workCard(m); }, serverIdOf: function (m) { return serverIdOf(m); },
    reactButton: function (m, id) { return reactButton(m, id); }, reactionRow: function (m) { return reactionRow(m); },
    editButton: function (m, id) { return editButton(m, id); }, deleteButton: function (m, id) { return deleteButton(m, id); },
    replyButton: function (m) { return replyButton(m); }, pinToggle: function (m, p, id) { return pinToggle(m, p, id); },
    isPinned: function (id) { return isPinned(id); }, jumpTo: function (id) { return jumpTo(id); },
    replyWho: function (m) { return replyWho(m); }, S: S, Chat: Chat,
  });
  var messageNode = message.messageNode, trimUrl = message.trimUrl, refIdsIn = message.refIdsIn, spansIn = message.spansIn;
  var fillBody = message.fillBody, linkChip = message.linkChip, idChip = message.idChip, historyButton = message.historyButton;
  var imageNode = message.imageNode, ruleNode = message.ruleNode;

  // ── Pinned ────────────────────────────────────────────────────────────────
  // Lives in chat-pins.js: the strip, pin/unpin, and the small message
  // helpers (excerpt, who was answered, jump-to). `serverIdOf` is assigned by
  // the reactions wiring below, so it is a thunk; the rest are declarations.
  var pinsModule = window.ChatPins({
    el: el, icon: icon, invoke: invoke, render: function () { render(); }, showError: showError,
    messageNode: function (m, prev) { return messageNode(m, prev); }, unreadFor: unreadFor,
    say: function (text, alert) { say(text, alert); },
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

  // ── Room page + composer ───────────────────────────────────────────────────
  // Lives in chat-room.js. Every module value assigned further down
  // (completion, commands, scroll) is a thunk; the rest are declarations or
  // module values already assigned above.
  var roomPage = window.ChatRoom({
    el: el, icon: icon, byId: byId, clear: clear, invoke: invoke, go: go, S: S, Chat: Chat,
    render: function () { render(); }, pageHeader: pageHeader, noticeBlock: noticeBlock, dayKey: dayKey, dayLabel: dayLabel,
    refreshRooms: refreshRooms, openRoom: openRoom, markRead: markRead, typingLine: typingLine,
    setMuted: function (m) { return setMuted(m); }, openSearch: function (x) { return openSearch(x); },
    pinnedStrip: function () { return pinnedStrip(); }, seenLine: function () { return seenLine(); },
    ruleNode: function (l, a) { return ruleNode(l, a); }, historyButton: function () { return historyButton(); },
    messageNode: function (m, prev) { return messageNode(m, prev); }, excerpt: function (t) { return excerpt(t); },
    editChip: function () { return editChip(); }, cancelEdit: function () { return cancelEdit(); },
    maybeLoadHistory: function () { return maybeLoadHistory(); }, noteTyping: function (v) { return noteTyping(v); },
    submit: function () { return submit(); }, complete: function (i, back) { return complete(i, back); },
    recall: function (i, d) { return recall(i, d); }, resetCompletion: function () { return resetCompletion(); },
    clearCompletionHint: function () { return clearCompletionHint(); },
  });
  var renderRoom = roomPage.renderRoom, composer = roomPage.composer, replyChip = roomPage.replyChip;

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

  // ── Typing + scroll anchoring ──────────────────────────────────────────────
  // Lives in chat-scroll.js: what the READER is doing — announcing that we
  // are typing, following the conversation only while at it, loading history
  // on the way up. `following(true)` is the one write into its state.
  var scrolling = window.ChatScroll({
    byId: byId, invoke: invoke, render: function () { render(); }, S: S, Chat: Chat,
  });
  var noteTyping = scrolling.noteTyping, stopTyping = scrolling.stopTyping, atBottom = scrolling.atBottom;
  var scrollToEnd = scrolling.scrollToEnd, maybeLoadHistory = scrolling.maybeLoadHistory, loadHistory = scrolling.loadHistory;
  var noteScrollPosition = scrolling.noteScrollPosition, keepPlace = scrolling.keepPlace, following = scrolling.following;

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
    atBottom: function () { following(true); },
  });
  var SHORTCUTS = commands.SHORTCUTS, COMMANDS = commands.COMMANDS;
  var submit = commands.submit, say = commands.say, sendMessage = commands.sendMessage, retrySend = commands.retrySend;

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
        following(true);                 // a room you just opened starts at the end
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
