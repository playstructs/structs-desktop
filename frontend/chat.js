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
    loading: true,
    resources: null,          // pre-formatted {energy, overloaded, alpha}
    people: [],
    peopleQuery: '',
    peopleLoading: false,
    // roomId → ts of the newest message the reader has actually seen. Feeds
    // the unread divider, the way every IRC client since ircII has marked it.
    lastRead: {},
    // Captured when a room is opened, so the divider stays put while you read
    // instead of sliding down as you look at it.
    dividerTs: 0,
    // Who is typing in the room being watched. Ephemeral: replaced wholesale
    // by each m.typing, never accumulated.
    typing: [],
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
  var PFP_LAYERS = ['background', 'arms', 'body', 'neck', 'head'];
  function pfpPortrait(attrsJson) {
    var img = el('div', 'sui-result-row-portrait-image pfp-frame');
    var pfp = null;
    if (attrsJson) { try { pfp = JSON.parse(attrsJson); } catch (e) { pfp = null; } }
    if (pfp && typeof pfp === 'object' && pfp.head != null) {
      PFP_LAYERS.forEach(function (part) {
        var idx = pfp[part];
        if (idx == null) return;
        var im = el('img', 'pfp-viewer-layer');
        im.src = 'img/pfp/' + part + '/pfp_' + part + '_' + idx + '.png';
        im.alt = '';
        img.appendChild(im);
      });
    } else {
      var ph = el('img', 'pfp-viewer-layer');
      ph.src = 'img/portrait-placeholder.png';
      ph.alt = '';
      img.appendChild(ph);
    }
    return img;
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
  function renderNav() {
    var box = byId('menu-page-nav-items');
    if (!box) return;
    clear(box);

    if (!S.networks.length) {
      box.appendChild(el('a', 'sui-screen-nav-item sui-mod-active', 'COMMS'));
    } else {
      S.networks.forEach(function (n) {
        var a = el('a', 'sui-screen-nav-item' + (n.guild_id === S.guildId ? ' sui-mod-active' : ''));
        a.href = 'javascript:void(0)';
        // Guild tag is short and already uppercase in-game; fall back to name.
        a.textContent = n.tag || n.guild_name || n.guild_id;
        a.addEventListener('click', function () { selectNetwork(n.guild_id); });
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
    { key: 'direct', label: 'Direct' },
    { key: 'local', label: 'Local Net' },
    { key: 'galaxy', label: 'Galaxy Net' },
  ];

  function roomRow(r) {
    var row = el('div', 'sui-result-row chat-room-row');

    var left = el('div', 'sui-result-row-left-section');
    var portrait = el('div', 'sui-result-row-portrait');
    if (r.pfp_attrs || r.player_id) {
      // A direct message IS a person — the same portrait the roster shows.
      portrait.appendChild(pfpPortrait(r.pfp_attrs));
    } else {
      var well = el('div', 'chat-room-icon');
      well.appendChild(icon(r.icon || 'icon-beacon', 'sui-icon-md'));
      portrait.appendChild(well);
    }
    left.appendChild(portrait);

    var info = el('div', 'sui-result-row-player-info');
    var block = el('div', 'sui-text-label-block');
    block.appendChild(el('span', null, r.name || r.canonical_alias || r.room_id));
    block.appendChild(el('br'));
    // A DM's subtitle is who it is with; a channel's is how many are in it.
    var sub = r.player_id
      ? el('span', 'sui-text-hint',
          (r.tag ? '[' + r.tag + '] ' : '') + 'PID #' + r.player_id)
      : el('span', 'sui-text-hint',
          fmtCount(r.members) + (Number(r.members) === 1 ? ' Player' : ' Players'));
    block.appendChild(sub);
    info.appendChild(block);
    left.appendChild(info);
    row.appendChild(left);

    var right = el('div', 'sui-result-row-right-section');
    if (r.unread) {
      // Warning colour when you were named in it — the one badge in the list
      // that should pull the eye.
      var b = el('div',
        'sui-badge chat-room-unread ' + (r.mention ? 'sui-mod-warning' : 'sui-mod-default'),
        fmtCount(r.unread));
      if (r.mention) b.title = 'You were mentioned';
      right.appendChild(b);
    }
    if (!r.joined) {
      var join = el('button', 'sui-screen-btn sui-mod-secondary', 'Join');
      join.addEventListener('click', function (ev) {
        ev.stopPropagation();
        join.disabled = true;
        join.classList.add('sui-mod-disabled');
        join.textContent = 'Joining';
        invoke('matrix_join', { guildId: S.guildId, roomId: r.room_id })
          .then(function () { return refreshRooms(); })
          .catch(function (e) {
            join.textContent = 'Join';
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

  function renderChannels() {
    var page = el('div', 'chat-page');

    // Resources sit where the game puts them; the new-message door sits
    // beside them, because starting a conversation is the one action this
    // page has that is not "open a thing already on it".
    var right = el('div', 'chat-header-actions');
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

    var scroll = el('div', 'chat-scroll');

    if (S.loading) {
      scroll.appendChild(noticeBlock('Loading', 'Reading the channel directory.'));
    } else if (!S.rooms.length) {
      scroll.appendChild(noticeBlock(
        'No channels',
        'This network has no rooms you can see yet.'));
    } else {
      SECTIONS.forEach(function (sec) {
        var rows = S.rooms.filter(function (r) { return (r.section || 'galaxy') === sec.key; });
        if (!rows.length) return;
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
    var wrap = el('div', 'chat-msg');
    if (m.pending) wrap.classList.add('chat-msg-pending');
    if (m.failed) wrap.classList.add('chat-msg-failed');

    // An emote is one line, IRC's way: "* Netlag waves". A header above it
    // would say the name twice.
    if ((m.kind || 'text') === 'emote') {
      var line = el('div', 'chat-msg-body chat-mod-emote');
      line.appendChild(el('span', null,
        '* ' + (m.sender_name || m.sender) + ' ' + (m.body || '')));
      wrap.appendChild(line);
      wrap.appendChild(el('div', 'chat-msg-time', fmtTime(m.ts)));
      wrap.classList.add('chat-mod-oneline');
      return wrap;
    }

    // Collapse the header on a run from one sender, as the mockup does — but
    // never across a gap long enough that "when" stopped being obvious.
    var RUN_GAP_MS = 5 * 60 * 1000;
    if (prev && prev.sender === m.sender && !prev.failed && !m.failed
        && (m.kind || 'text') !== 'emote' && (prev.kind || 'text') !== 'emote'
        && Math.abs(Number(m.ts) - Number(prev.ts)) < RUN_GAP_MS) {
      wrap.classList.add('chat-mod-cont');
    }
    if (!m.self && mentionsMe(m.body)) wrap.classList.add('chat-mod-mention');

    var head = el('div', 'chat-msg-head');
    var who = el('div', 'chat-msg-sender' + (m.self ? ' chat-mod-self' : ''));
    // No portrait on the message line, deliberately. The game's portrait is a
    // fixed 72px composition that its frame CROPS to head-and-shoulders, so it
    // needs ~40px to read as a face — at name height it is a sliver of scalp.
    // Portraits appear where they have that room: DM rows, the people picker
    // and the composer. Cropping a variant to fit here would be inventing art.
    if (m.sender_tag) {
      who.appendChild(el('span', 'chat-msg-tag', '[' + m.sender_tag + ']'));
    }
    who.appendChild(el('span', null, m.sender_name || m.sender));
    // Any player is directly addressable, so their name is the affordance.
    if (m.player_id && !m.self) {
      who.classList.add('chat-mod-addressable');
      who.title = 'Message ' + (m.sender_name || m.player_id);
      who.addEventListener('click', function () { startDm(m.player_id); });
    }
    head.appendChild(who);
    // Right of the sender line: the badge, then the clock. Every serious chat
    // client answers "when was this said" without being asked.
    var meta = el('div', 'chat-msg-meta');
    if (m.admin) meta.appendChild(el('div', 'sui-badge sui-mod-warning', 'Admin'));
    meta.appendChild(el('div', 'chat-msg-time', fmtTime(m.ts)));
    head.appendChild(meta);
    wrap.appendChild(head);

    var kind = m.kind || 'text';
    var body = el('div', 'chat-msg-body');
    if (kind === 'emote') body.classList.add('chat-mod-emote');
    else if (kind === 'notice') body.classList.add('chat-mod-notice');
    else if (kind === 'unknown') body.classList.add('chat-mod-unknown');
    body.textContent = m.body || '';
    wrap.appendChild(body);
    return wrap;
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

  function renderRoom() {
    var page = el('div', 'chat-page');
    var name = (S.room && (S.room.name || S.room.canonical_alias)) || S.roomId || '';

    var gear = el('a', 'sui-nav-btn');
    gear.href = 'javascript:void(0)';
    gear.title = 'Connection';
    gear.appendChild(icon('icon-menu sui-text-secondary'));
    gear.addEventListener('click', function () { go('connection'); });

    page.appendChild(pageHeader(name, function () { go('channels'); }, gear));

    // IRC has shown the topic since the beginning: it is the room's own
    // statement of what it is for, and hiding it behind a command wastes it.
    if (S.room && S.room.topic) {
      page.appendChild(el('div', 'chat-topic', S.room.topic));
    }

    var scroll = el('div', 'chat-scroll');
    scroll.id = 'chat-timeline';
    if (!S.messages.length) {
      scroll.appendChild(noticeBlock('Quiet', 'Nothing has been said here yet.'));
    } else {
      var dividerDone = false;
      S.messages.forEach(function (m, i) {
        var prev = i > 0 ? S.messages[i - 1] : null;

        // Day separator: a timeline with no dates is a timeline you cannot
        // date. Only between days, never above the first message.
        if (prev && dayKey(m.ts) !== dayKey(prev.ts)) {
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

    // Everything on screen counts as read from here on.
    if (S.messages.length) {
      S.lastRead[S.roomId] = Number(S.messages[S.messages.length - 1].ts) || 0;
    }

    // Between the log and the composer, where MSN put it: the one line that
    // tells you an answer is already being written.
    var typing = el('div', 'chat-typing');
    typing.id = 'chat-typing';
    typing.textContent = typingLine(S.typing);
    if (!S.typing.length) typing.classList.add('hidden');
    page.appendChild(typing);

    page.appendChild(composer());
    return page;
  }

  // ── Composer ────────────────────────────────────────────────────────────
  // The game's ACTION BAR, not a form: a .sui-panel of chunks between two
  // panel edges — portrait chunk, connector, screen chunk, connector, button
  // chunk — exactly as ActionBarComponent assembles the HUD's bottom bars.
  // The metal frame, the inset screen and the button face are all the panel's
  // own art; nothing here draws a control of its own.
  function composer() {
    var wrap = el('div', 'sui-panel-wrapper-fit-content');
    wrap.id = 'chat-composer';
    var panel = el('div', 'sui-panel sui-theme-player');
    panel.appendChild(el('div', 'sui-panel-edge-left'));

    // Portrait chunk — the player, in the game's own portrait well.
    var pChunk = el('div', 'sui-panel-chunk');
    var pScreen = el('div', 'sui-screen');
    var portrait = el('div', 'sui-screen-portrait');
    portrait.id = 'chat-composer-portrait';
    var pImg = el('div', 'sui-screen-portrait-image');
    pImg.appendChild(pfpPortrait(S.profile && S.profile.pfp_attrs));
    portrait.appendChild(pImg);
    pScreen.appendChild(portrait);
    pChunk.appendChild(pScreen);
    panel.appendChild(pChunk);

    panel.appendChild(el('div', 'sui-panel-connector'));

    // Screen chunk — the message being written, on the panel's inset screen.
    var iChunk = el('div', 'sui-panel-chunk sui-mod-grow sui-mod-shrink');
    var iScreen = el('div', 'sui-screen sui-screen-full-width');
    var field = el('div', 'sui-screen-dialogue sui-theme-neutral');
    var input = el('input');
    input.type = 'text';
    input.id = 'chat-input';
    input.name = 'chat-input';
    input.placeholder = 'Message, or /help';
    input.autocomplete = 'off';
    input.maxLength = 4000;
    input.addEventListener('input', function () {
      resetCompletion();
      noteTyping(input.value);
    });
    field.appendChild(input);
    iScreen.appendChild(field);
    iChunk.appendChild(iScreen);
    panel.appendChild(iChunk);

    panel.appendChild(el('div', 'sui-panel-connector sui-panel-style-medium-to-default'));

    // Button chunk — a .sui-panel-btn in a .sui-action-bar-btn-group, the same
    // pair every action button in the HUD is built from.
    var bChunk = el('div', 'sui-panel-chunk sui-theme-player');
    var group = el('div', 'sui-action-bar-btn-group');
    var send = el('a', 'sui-panel-btn sui-mod-default');
    send.id = 'chat-send';
    send.href = 'javascript:void(0)';
    send.appendChild(icon('icon-arrow', 'sui-icon-md'));
    group.appendChild(send);
    bChunk.appendChild(group);
    panel.appendChild(bChunk);

    panel.appendChild(el('div', 'sui-panel-edge-right'));
    wrap.appendChild(panel);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
      if (e.key === 'Tab') { e.preventDefault(); complete(input, e.shiftKey); }
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

  function completionsFor(word, isCommand) {
    var lower = word.toLowerCase();
    if (isCommand) {
      return COMMANDS.map(function (c) { return '/' + c.name; })
        .filter(function (n) { return n.toLowerCase().indexOf('/' + lower) === 0; });
    }
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

  function applyCompletion(input, c) {
    var pick = c.matches[c.at];
    // IRC convention: a name completed at the start of a line gets a comma, so
    // "net<Tab>" becomes "Netlag, " ready to be addressed.
    var suffix = (!c.isCommand && c.start === 0) ? ', ' : ' ';
    var text = pick + suffix;
    input.value = c.head + text + c.tail;
    var caret = c.start + text.length;
    try { input.setSelectionRange(caret, caret); } catch (e) {}
    c.value = input.value;
    c.caret = caret;
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
    var stem = isCommand ? word.slice(1) : word;
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

  // ── Announcing that we are typing ────────────────────────────────────────
  // Throttled hard. The homeserver keeps believing a notice for 20 seconds, so
  // one every 8 is plenty — sending on every keystroke would put a request on
  // the wire per character.
  var typingSentAt = 0;
  var typingStopTimer = null;
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
      invoke('matrix_typing', { guildId: S.guildId, roomId: S.roomId, typing: true })
        .catch(function () {});
    }
    // Stop claiming to type once the keyboard goes quiet, rather than waiting
    // for the server's timeout to lapse.
    typingStopTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function stopTyping() {
    if (typingStopTimer) { clearTimeout(typingStopTimer); typingStopTimer = null; }
    if (!typingSentAt || !S.roomId) return;
    typingSentAt = 0;
    invoke('matrix_typing', { guildId: S.guildId, roomId: S.roomId, typing: false })
      .catch(function () {});
  }
  Chat.noteTyping = noteTyping;

  // ── Commands ──────────────────────────────────────────────────────────────
  // IRC's best idea: the composer is also the command line. No new UI, no menu
  // to hunt through, and everything the window can do has a name you can type.
  //
  // A leading "//" escapes, so a message that genuinely starts with a slash is
  // still sendable — the same escape ircII shipped in 1990.
  var COMMANDS = [
    { name: 'me', args: '<action>', help: 'Send an action: * you wave' },
    { name: 'msg', args: '<player> [message]', help: 'Open a direct message' },
    { name: 'join', args: '<room>', help: 'Join a room by name or alias' },
    { name: 'leave', args: '', help: 'Leave the room you are in' },
    { name: 'topic', args: '', help: 'Show what this room is about' },
    { name: 'who', args: '', help: 'Who has spoken here' },
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

    // "//foo" → send the literal "/foo".
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
        }).join('\n') + '\nStart a message with // to send a literal slash.');
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
    var msg = {
      event_id: localId,
      sender: (S.profile && S.profile.user_id) || 'me',
      sender_name: (S.profile && S.profile.display_name) || 'You',
      sender_tag: (S.profile && S.profile.tag) || null,
      body: text,
      kind: msgtype === 'm.emote' ? 'emote' : 'text',
      self: true, pending: true,
      ts: Date.now(),
    };
    S.messages.push(msg);
    stopTyping();
    render();
    scrollToEnd();

    invoke('matrix_send', {
      guildId: S.guildId, roomId: S.roomId, body: text, msgtype: msgtype || null,
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
        msg.body = text + '  — not sent (' + String(e) + ')';
        render();
      });
  }

  function scrollToEnd() {
    var t = byId('chat-timeline');
    // jsdom has no layout; scrollHeight is 0 there and this is a no-op.
    if (t) t.scrollTop = t.scrollHeight;
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

  function noticeBlock(title, detail, isError) {
    var box = el('div', 'chat-notice' + (isError ? ' chat-mod-error' : ''));
    box.appendChild(el('div', 'chat-notice-title', title));
    if (detail) box.appendChild(el('div', 'sui-text-paragraph', detail));
    return box;
  }

  function renderConnection() {
    var page = el('div', 'chat-page');
    page.appendChild(pageHeader('Connection', function () { go('channels'); }, headerResources()));

    var scroll = el('div', 'chat-scroll');
    var net = activeNetwork();

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
    // only strand them somewhere they cannot chat from. This page reports
    // what happened; the one control is a retry, and only when there is
    // something to retry.
    var connected = !!(net && net.logged_in);
    if (!connected && !S.connecting) {
      var actions = el('div', 'sui-screen-btn-flex-wrapper');
      var btn = el('button', 'sui-screen-btn sui-mod-primary');
      btn.id = 'chat-retry';
      btn.textContent = 'Try again';
      btn.addEventListener('click', function () { connect(); });
      actions.appendChild(btn);
      scroll.appendChild(actions);
    }

    scroll.appendChild(noticeBlock(
      'How this signs in',
      'Comms uses the same address and key as play, automatically. The app ' +
      'signs the guild login message, the guild issues an OpenID token for ' +
      'it, and the homeserver trusts the guild. No password, and no key ever ' +
      'leaves this machine.'));

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

  function render() {
    var host = byId('menu-page-body-content');
    if (!host) return;
    // Both text inputs the window has; only one exists at a time.
    var draft = draftOf('chat-input') || draftOf('chat-people-query');
    clear(host);
    var node;
    if (S.view === 'room') node = renderRoom();
    else if (S.view === 'connection') node = renderConnection();
    else if (S.view === 'people') node = renderPeople();
    else node = renderChannels();
    host.appendChild(node);
    restoreDraft(draft);
    renderNav();
  }
  Chat.render = render;

  function go(view) {
    S.view = view;
    if (view === 'channels') { S.roomId = null; S.room = null; S.messages = []; }
    render();
    if (view === 'channels') refreshRooms();
    if (view === 'people') loadPeople();
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
    return invoke('matrix_status').then(function (st) {
      applyStatus(st);
      return st;
    });
  }

  function refreshRooms() {
    var net = activeNetwork();
    if (!net || !net.logged_in) { S.loading = false; return Promise.resolve(); }
    return invoke('matrix_rooms', { guildId: S.guildId })
      .then(function (res) {
        S.rooms = (res && res.rooms) || [];
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
    S.typing = [];
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
        render();
        scrollToEnd();
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
          return refreshRooms();
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
    // A room we are not looking at only bumps its unread count.
    if (payload.room_id !== S.roomId) {
      var msgs = payload.messages || [];
      var mine = msgs.some(function (m) { return !m.self && mentionsMe(m.body); });
      S.rooms.forEach(function (r) {
        if (r.room_id === payload.room_id) {
          r.unread = (Number(r.unread) || 0) + msgs.length;
          // Sticky until read: being named is not the same as traffic, and a
          // count of 40 hides the one message that was actually for you.
          if (mine) r.mention = true;
        }
      });
      if (S.view === 'channels') render();
      return;
    }
    var incoming = payload.messages || [];
    if (!incoming.length) return;
    S.messages = dropEcho(S.messages, incoming).concat(incoming);
    // Keep the retained timeline bounded; scrollback is re-fetched on demand.
    if (S.messages.length > 500) S.messages = S.messages.slice(-500);
    render();
    scrollToEnd();
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
    S.rooms = payload.rooms || [];
    S.loading = false;
    if (S.view === 'channels') render();
  }
  Chat.onRooms = onRooms;

  function onStatus(payload) {
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
        // Rust closes it, for the same reason Rust opened it. The JS window
        // API is a trap here: `getCurrent()` is the Tauri v1 spelling and is
        // simply absent on v2, so the button would silently do nothing.
        invoke('close_chat_window').catch(function () {
          try { window.close(); } catch (e) { /* nothing else to try */ }
        });
      });
    }
    var comms = byId('chat-nav-comms');
    if (comms) comms.addEventListener('click', function () { go('channels'); });
    var settings = byId('chat-nav-settings');
    if (settings) settings.addEventListener('click', function () { go('connection'); });

    listen('matrix::timeline', function (e) { onTimeline(e && e.payload); });
    listen('matrix::typing', function (e) { onTyping(e && e.payload); });
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
          return refreshRooms();
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
