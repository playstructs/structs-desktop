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
    resources: null,          // {energy_used, energy_max, alpha}
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

  // The game's own header resources: energy usage then alpha owned. Only shown
  // when Rust actually supplied them — an invented number is worse than none.
  function headerResources() {
    if (!S.resources) return null;
    var box = el('div', 'sui-page-header-resources');
    var r = S.resources;
    if (r.energy_max != null) {
      var e = el('div', 'sui-resource');
      e.appendChild(el('span', null, fmtCount(r.energy_used) + '/' + fmtCount(r.energy_max)));
      e.appendChild(icon('sui-icon-energy'));
      box.appendChild(e);
    }
    if (r.alpha != null) {
      var al = el('div', 'sui-resource');
      al.appendChild(el('span', null, fmtCount(r.alpha)));
      al.appendChild(icon('sui-icon-alpha-matter'));
      box.appendChild(al);
    }
    return box.childNodes.length ? box : null;
  }

  // ── Channels view ─────────────────────────────────────────────────────────
  var SECTIONS = [
    { key: 'local', label: 'Local Net' },
    { key: 'galaxy', label: 'Galaxy Net' },
  ];

  function roomRow(r) {
    var row = el('div', 'sui-result-row chat-room-row');

    var left = el('div', 'sui-result-row-left-section');
    var portrait = el('div', 'sui-result-row-portrait');
    var well = el('div', 'chat-room-icon');
    well.appendChild(icon(r.icon || 'icon-beacon', 'sui-icon-md'));
    portrait.appendChild(well);
    left.appendChild(portrait);

    var info = el('div', 'sui-result-row-player-info');
    var block = el('div', 'sui-text-label-block');
    block.appendChild(el('span', null, r.name || r.canonical_alias || r.room_id));
    block.appendChild(el('br'));
    var sub = el('span', 'sui-text-hint',
      fmtCount(r.members) + (Number(r.members) === 1 ? ' Player' : ' Players'));
    block.appendChild(sub);
    info.appendChild(block);
    left.appendChild(info);
    row.appendChild(left);

    var right = el('div', 'sui-result-row-right-section');
    if (r.unread) {
      var b = el('div', 'sui-badge sui-mod-default chat-room-unread', fmtCount(r.unread));
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
    page.appendChild(pageHeader('Channels', null, headerResources()));

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

  // ── Room view ─────────────────────────────────────────────────────────────
  function messageNode(m, prev) {
    var wrap = el('div', 'chat-msg');
    if (m.pending) wrap.classList.add('chat-msg-pending');
    if (m.failed) wrap.classList.add('chat-msg-failed');
    // Collapse the header on a run from one sender, as the mockup does.
    if (prev && prev.sender === m.sender && !prev.failed && !m.failed) {
      wrap.classList.add('chat-mod-cont');
    }

    var head = el('div', 'chat-msg-head');
    var who = el('div', 'chat-msg-sender' + (m.self ? ' chat-mod-self' : ''));
    if (m.sender_tag) {
      who.appendChild(el('span', 'chat-msg-tag', '[' + m.sender_tag + '] '));
    }
    who.appendChild(el('span', null, m.sender_name || m.sender));
    head.appendChild(who);
    if (m.admin) head.appendChild(el('div', 'sui-badge sui-mod-warning', 'Admin'));
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

  function renderRoom() {
    var page = el('div', 'chat-page');
    var name = (S.room && (S.room.name || S.room.canonical_alias)) || S.roomId || '';

    var gear = el('a', 'sui-nav-btn');
    gear.href = 'javascript:void(0)';
    gear.title = 'Connection';
    gear.appendChild(icon('icon-menu sui-text-secondary'));
    gear.addEventListener('click', function () { go('connection'); });

    page.appendChild(pageHeader(name, function () { go('channels'); }, gear));

    var scroll = el('div', 'chat-scroll');
    scroll.id = 'chat-timeline';
    if (!S.messages.length) {
      scroll.appendChild(noticeBlock('Quiet', 'Nothing has been said here yet.'));
    } else {
      S.messages.forEach(function (m, i) {
        scroll.appendChild(messageNode(m, i > 0 ? S.messages[i - 1] : null));
      });
    }
    page.appendChild(scroll);

    // ── Composer ──
    var composer = el('div', 'sui-screen');
    composer.id = 'chat-composer';

    var portrait = el('div');
    portrait.id = 'chat-composer-portrait';
    portrait.appendChild(pfpPortrait(S.profile && S.profile.pfp_attrs));
    composer.appendChild(portrait);

    var fieldWrap = el('div');
    fieldWrap.id = 'chat-composer-field';
    var label = el('label', 'sui-input-text');
    label.setAttribute('for', 'chat-input');
    var input = el('input');
    input.type = 'text';
    input.id = 'chat-input';
    input.name = 'chat-input';
    input.placeholder = '...';
    input.autocomplete = 'off';
    input.maxLength = 4000;
    label.appendChild(input);
    fieldWrap.appendChild(label);
    composer.appendChild(fieldWrap);

    var sendWrap = el('div');
    sendWrap.id = 'chat-composer-send';
    var send = el('button', 'sui-screen-btn sui-mod-primary');
    send.id = 'chat-send';
    send.appendChild(icon('icon-chevron-right', 'sui-icon-md'));
    sendWrap.appendChild(send);
    composer.appendChild(sendWrap);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);

    page.appendChild(composer);
    return page;
  }

  function submit() {
    var input = byId('chat-input');
    if (!input) return;
    var text = String(input.value || '').trim();
    if (!text) return;
    input.value = '';
    sendMessage(text);
  }

  // Optimistic echo: the message shows immediately, dimmed, and is replaced
  // when the homeserver echoes it back through sync. A send that fails stays
  // on screen in the error colour rather than disappearing with the text.
  var pendingSeq = 0;
  function sendMessage(text) {
    var localId = 'pending-' + (++pendingSeq);
    var msg = {
      event_id: localId,
      sender: (S.profile && S.profile.user_id) || 'me',
      sender_name: (S.profile && S.profile.display_name) || 'You',
      sender_tag: (S.profile && S.profile.tag) || null,
      body: text, kind: 'text', self: true, pending: true,
      ts: Date.now(),
    };
    S.messages.push(msg);
    render();
    scrollToEnd();

    invoke('matrix_send', { guildId: S.guildId, roomId: S.roomId, body: text })
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

    // Action
    var actions = el('div', 'sui-screen-btn-flex-wrapper');
    var connected = !!(net && net.logged_in);
    var btn = el('button', 'sui-screen-btn ' + (connected ? 'sui-mod-destructive' : 'sui-mod-primary'));
    btn.id = 'chat-connect';
    btn.textContent = S.connecting ? 'Connecting…' : (connected ? 'Sign out' : 'Connect');
    if (S.connecting) { btn.disabled = true; btn.classList.add('sui-mod-disabled'); }
    btn.addEventListener('click', function () { connected ? disconnect() : connect(); });
    actions.appendChild(btn);
    scroll.appendChild(actions);

    scroll.appendChild(noticeBlock(
      'How this signs in',
      'Comms uses the same address and key as play. The app signs the guild ' +
      'login message, the guild issues an OpenID token for it, and the ' +
      'homeserver trusts the guild. No password, and no key ever leaves this ' +
      'machine.'));

    page.appendChild(scroll);
    return page;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    var host = byId('menu-page-body-content');
    if (!host) return;
    clear(host);
    var node;
    if (S.view === 'room') node = renderRoom();
    else if (S.view === 'connection') node = renderConnection();
    else node = renderChannels();
    host.appendChild(node);
    renderNav();
  }
  Chat.render = render;

  function go(view) {
    S.view = view;
    if (view === 'channels') { S.roomId = null; S.room = null; S.messages = []; }
    render();
    if (view === 'channels') refreshRooms();
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
      S.rooms.forEach(function (r) {
        if (r.room_id === payload.room_id) {
          r.unread = (Number(r.unread) || 0) + ((payload.messages || []).length);
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
        if (T.window && T.window.getCurrent) {
          try { T.window.getCurrent().close(); return; } catch (e) { /* fall through */ }
        }
        window.close();
      });
    }
    var comms = byId('chat-nav-comms');
    if (comms) comms.addEventListener('click', function () { go('channels'); });
    var settings = byId('chat-nav-settings');
    if (settings) settings.addEventListener('click', function () { go('connection'); });

    listen('matrix::timeline', function (e) { onTimeline(e && e.payload); });
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
        S.view = 'connection';
        render();
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
