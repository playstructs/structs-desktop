// STRUCTS TERMINAL — a customizable framework of cards, workspaces and windows.
//
// Runs as a solo view of the Team Ops window (`board.html?view=terminal`), so
// every Team Ops page, the Game Stats charts, the card components and the
// Comms modules are in scope. A WORKSPACE is a page of cards; each card is a
// TYPE plus PARAMS with a width. Workspaces are saved to disk through Rust
// (`terminal_layout_*`, `terminal_workspaces`) and come back on relaunch; a
// workspace can be a window of its own (`?ws=<name>`), and so can any card
// (`?ws=<name>&card=<id>`) — both remembered and reopened at boot.
//
// Cards are registered, not hard-wired: `Board.Terminal.register(type, spec)`:
//   label        what the palette calls it
//   describe(p)  the title on the card, from its params
//   params       [{ key, label, kind: 'id' | 'choice' | 'text', options?, placeholder? }]
//   render(host, p, ctx) → Promise|void     draw into `host`
//   cadenceMs    re-render this often while on screen (0 = never)
//   single       at most one per window (a card that owns fixed DOM ids)
//   unmount(host, p)  give borrowed DOM back
//
// Everything drawn is SUI: the frame is the game's data card, the doors are
// the nav-button glyphs, forms are H.field / H.selectBox / H.textBox, the
// workspace strip is the same nav strip the board's own tabs use.
(function () {
  'use strict';
  var Board = window.Board;
  var H = Board.helpers;

  var TYPES = {};
  var state = {
    ws: 'main',              // this window's workspace
    workspaces: ['main'],    // every workspace by name
    active: 'main',          // the one the main window shows
    layout: null,            // { cards: [{id, type, params, w}], version }
    solo: null,              // card id when this window shows one card
    mounted: {},             // id -> { node, body, def, lastRun, params, ... }
    saveTimer: null,
  };

  function invoke(cmd, args) {
    return Board.T && Board.T.core ? Board.T.core.invoke(cmd, args) : Promise.reject('no bridge');
  }
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([A-Za-z0-9_-]{1,40})').exec(location.search || '');
    return m ? m[1] : null;
  }

  // ── Registry ────────────────────────────────────────────────────────────
  var Terminal = {
    register: function (type, spec) { spec.type = type; TYPES[type] = spec; return spec; },
    types: function () { return Object.keys(TYPES).map(function (k) { return TYPES[k]; }); },
    state: state,
  };
  Board.Terminal = Terminal;

  // ── Workspaces + layout persistence ─────────────────────────────────────
  var LOCAL_KEY = 'structs.terminal.';

  function defaultLayout() {
    return { version: 0, cards: [
      { id: 'people-1', type: 'people', params: {}, w: 1 },
      { id: 'market-1', type: 'market', params: {}, w: 2 },
      { id: 'tape-1', type: 'tape', params: {}, w: 1 },
      { id: 'stats-1', type: 'stats', params: { section: 'universe' }, w: 2 },
      { id: 'work-1', type: 'page', params: { page: 'work' }, w: 1 },
      { id: 'tx-1', type: 'page', params: { page: 'tx' }, w: 1 },
      { id: 'raids-1', type: 'stats', params: { section: 'raids' }, w: 1 },
    ] };
  }

  function loadWorkspaces() {
    return invoke('terminal_workspaces').then(function (w) {
      if (w && Array.isArray(w.names) && w.names.length) { state.workspaces = w.names; state.active = w.active || w.names[0]; }
    }).catch(function () {});
  }

  function load() {
    return invoke('terminal_layout_get', { workspace: state.ws }).then(function (l) {
      if (!l || !Array.isArray(l.cards)) throw new Error('no layout');
      return l;
    }).catch(function () {
      try {
        var raw = localStorage.getItem(LOCAL_KEY + state.ws);
        if (raw) { var l = JSON.parse(raw); if (l && Array.isArray(l.cards)) return l; }
      } catch (e) { /* storage may be unavailable */ }
      return null;
    }).then(function (l) {
      state.layout = (l && l.cards.length) ? l : defaultLayout();
      return state.layout;
    });
  }

  function save() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { state.saveTimer = null; persist(); }, 300);
  }
  function persist() {
    state.layout.version = (state.layout.version || 0) + 1;
    try { localStorage.setItem(LOCAL_KEY + state.ws, JSON.stringify(state.layout)); } catch (e) { /* fine */ }
    return invoke('terminal_layout_set', { workspace: state.ws, layout: state.layout }).catch(function (e) {
      Board.stamp && Board.stamp('layout not saved: ' + e);
    });
  }
  Terminal.flushSave = function () { if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; return persist(); } return Promise.resolve(); };

  function newId(type) {
    var n = 1, used = {};
    state.layout.cards.forEach(function (c) { used[c.id] = 1; });
    while (used[type + '-' + n]) n++;
    return type + '-' + n;
  }

  function switchWorkspace(name) {
    if (!name || name === state.ws) return Promise.resolve();
    Object.keys(state.mounted).forEach(function (id) { unmountCard(id); });
    state.ws = name;
    if (!state.solo) invoke('terminal_workspace_activate', { name: name }).catch(function () {});
    return load().then(function () { renderAll(); });
  }
  Terminal.switchWorkspace = switchWorkspace;

  function createWorkspace(name) {
    var clean = String(name || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!clean) { Board.stamp && Board.stamp('a workspace needs a plain name'); return Promise.resolve(); }
    if (state.workspaces.indexOf(clean) < 0) state.workspaces.push(clean);
    return switchWorkspace(clean).then(function () { return persist(); });
  }
  Terminal.createWorkspace = createWorkspace;

  function deleteWorkspace(name) {
    return invoke('terminal_workspace_delete', { name: name }).then(function (w) {
      state.workspaces = (w && w.names) || state.workspaces.filter(function (n) { return n !== name; });
      state.active = (w && w.active) || state.workspaces[0];
      if (state.ws === name) return switchWorkspace(state.active);
      renderAll();
    }).catch(function (e) { Board.stamp && Board.stamp(String(e)); });
  }

  // ── The card frame: the game's data card, doors in its header ───────────
  function door(iconName, title, onClick) {
    var a = H.el('a', 'sui-nav-btn tm-door');
    a.href = 'javascript:void(0)';
    a.title = title;
    a.appendChild(H.el('i', iconName + ' sui-icon-sm'));
    a.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); onClick(ev); });
    return a;
  }

  function frame(card) {
    var def = TYPES[card.type];
    var node = H.el('div', 'sui-data-card sui-theme-player tm-card tm-w' + (card.w || 1));
    node.id = 'tm-' + card.id;
    node.setAttribute('data-card', card.id);
    node.setAttribute('data-type', card.type);
    var head = H.el('div', 'sui-data-card-header sui-text-header tm-head');
    var title = H.el('span', 'tm-title', def ? def.describe(card.params || {}) : card.type);
    head.appendChild(title);
    var doors = H.el('span', 'tm-doors');
    doors.appendChild(door('icon-in-progress', 'Refresh', function () { refresh(card.id, true); }));
    if (!state.solo) {
      if (def && def.params && def.params.length) {
        doors.appendChild(door('icon-menu', 'Configure', function () { toggleConfig(card.id); }));
      }
      doors.appendChild(door('icon-chevron-up', 'Move up', function () { move(card.id, -1); }));
      doors.appendChild(door('icon-chevron-down', 'Move down', function () { move(card.id, 1); }));
      doors.appendChild(door('icon-link-out', 'Pop out', function () { popOut(card.id); }));
      doors.appendChild(door('icon-close', 'Remove', function () { remove(card.id); }));
    }
    head.appendChild(doors);
    node.appendChild(head);
    var config = H.el('div', 'tm-config');
    config.hidden = true;
    node.appendChild(config);
    var body = H.el('div', 'sui-data-card-body tm-body');
    node.appendChild(body);
    return { node: node, body: body, config: config, title: title };
  }

  // ── Card operations ─────────────────────────────────────────────────────
  function findCard(id) {
    for (var i = 0; i < state.layout.cards.length; i++) if (state.layout.cards[i].id === id) return state.layout.cards[i];
    return null;
  }

  function add(type, params, w) {
    var def = TYPES[type];
    if (!def) return null;
    if (def.single && state.layout.cards.some(function (c) { return c.type === type; })) {
      Board.stamp && Board.stamp('one ' + def.label + ' card per window');
      return null;
    }
    var card = { id: newId(type), type: type, params: params || {}, w: w || def.defaultWidth || 1 };
    state.layout.cards.push(card);
    save();
    renderGrid();
    return card;
  }
  Terminal.add = add;

  function unmountCard(id) {
    var m = state.mounted[id];
    if (!m) return;
    if (m.def && m.def.unmount) { try { m.def.unmount(m.body, m.params); } catch (e) { /* a card must not take the page down */ } }
    if (m.node.parentNode) m.node.parentNode.removeChild(m.node);
    delete state.mounted[id];
  }

  function remove(id) {
    unmountCard(id);
    state.layout.cards = state.layout.cards.filter(function (c) { return c.id !== id; });
    save();
    renderGrid();
  }
  Terminal.remove = remove;

  function move(id, dir) {
    var cards = state.layout.cards;
    var i = cards.map(function (c) { return c.id; }).indexOf(id);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= cards.length) return;
    var t = cards[i]; cards[i] = cards[j]; cards[j] = t;
    save();
    renderGrid();
  }
  Terminal.move = move;

  function setWidth(id, w) {
    var c = findCard(id);
    if (!c) return;
    c.w = Math.max(1, Math.min(3, Number(w) || 1));
    var m = state.mounted[id];
    if (m) m.node.className = 'sui-data-card sui-theme-player tm-card tm-w' + c.w;
    save();
  }

  function setParams(id, params) {
    var c = findCard(id);
    if (!c) return;
    c.params = params;
    save();
    var m = state.mounted[id];
    if (m) {
      m.params = params;
      m.title.textContent = m.def.describe(params);
      refresh(id, true);
    }
  }

  function popOut(id) {
    var m = state.mounted[id];
    invoke('open_terminal_card', { workspace: state.ws, cardId: id, title: m && m.title ? m.title.textContent : null }).catch(function (e) {
      Board.stamp && Board.stamp('pop-out needs the app: ' + e);
    });
  }
  Terminal.popOut = popOut;

  // The configure strip: one field per declared param, width, and Apply.
  function control(p, current) {
    if (p.kind === 'choice') return H.selectBox(String(current || p.options[0].value), p.options, function () {});
    return H.textBox(String(current || ''), p.placeholder || '', function () {});
  }
  // The SUI form helpers return wrappers; the value lives on the inner control.
  function readControl(node) {
    if (!node) return '';
    if (node.value != null && node.tagName !== 'DIV' && node.tagName !== 'LABEL') return String(node.value).trim();
    var inner = node.querySelector && node.querySelector('select, input');
    return inner ? String(inner.value).trim() : '';
  }

  function toggleConfig(id) {
    var m = state.mounted[id];
    if (!m) return;
    if (!m.config.hidden) { m.config.hidden = true; return; }
    m.config.innerHTML = '';
    var c = findCard(id);
    var inputs = {};
    (m.def.params || []).forEach(function (p) {
      inputs[p.key] = control(p, c.params[p.key]);
      m.config.appendChild(H.field(p.label, inputs[p.key]));
    });
    var width = H.selectBox(String(c.w || 1), [{ value: '1', label: 'Narrow' }, { value: '2', label: 'Wide' }, { value: '3', label: 'Full' }], function () {});
    m.config.appendChild(H.field('Width', width));
    var apply = H.el('a', 'sui-screen-btn sui-mod-primary', 'Apply');
    apply.href = 'javascript:void(0)';
    apply.addEventListener('click', function () {
      var params = {};
      Object.keys(inputs).forEach(function (k) { params[k] = readControl(inputs[k]); });
      setWidth(id, readControl(width));
      setParams(id, params);
      m.config.hidden = true;
    });
    m.config.appendChild(apply);
    m.config.hidden = false;
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  function refresh(id, force) {
    var m = state.mounted[id];
    if (!m || !m.def) return Promise.resolve();
    if (m.busy && !force) return Promise.resolve();
    m.busy = true;
    m.lastRun = Date.now();
    return Promise.resolve().then(function () {
      return m.def.render(m.body, m.params, { card: m.node, id: id, first: !m.rendered, invoke: invoke });
    }).then(function () {
      m.rendered = true;
      // One header per card, the frame's: content that arrives as a titled
      // SUI card gives its own header up and the frame's title takes its name.
      var first = m.body.firstElementChild;
      if (first && first.classList && first.classList.contains('sui-data-card')) {
        var inner = first.querySelector(':scope > .sui-data-card-header');
        if (inner) { if (inner.textContent.trim()) m.title.textContent = inner.textContent.trim(); inner.parentNode.removeChild(inner); }
      }
    }).catch(function (e) {
      m.body.innerHTML = '';
      m.body.appendChild(H.stateBlock('error', String(e && e.message || e)));
    }).then(function () { m.busy = false; });
  }
  Terminal.refresh = refresh;

  function mount(card, grid) {
    var def = TYPES[card.type];
    var f = frame(card);
    if (!def) f.body.appendChild(H.stateBlock('error', 'Unknown card type: ' + card.type));
    grid.appendChild(f.node);
    state.mounted[card.id] = { node: f.node, body: f.body, config: f.config, title: f.title, def: def, params: card.params || {}, lastRun: 0, rendered: false };
    if (def) refresh(card.id, true);
  }

  function renderGrid() {
    var grid = document.getElementById('tm-grid');
    if (!grid) return;
    var want = state.solo ? state.layout.cards.filter(function (c) { return c.id === state.solo; }) : state.layout.cards;
    var keep = {};
    want.forEach(function (c) { keep[c.id] = 1; });
    Object.keys(state.mounted).forEach(function (id) { if (!keep[id]) unmountCard(id); });
    want.forEach(function (c, i) {
      var m = state.mounted[c.id];
      // Same id, different card (a reloaded layout, a reset): remount, or a
      // stale card would wear a new title.
      if (m && (m.def !== TYPES[c.type] || JSON.stringify(m.params || {}) !== JSON.stringify(c.params || {}))) { unmountCard(c.id); m = null; }
      if (!m) { mount(c, grid); m = state.mounted[c.id]; }
      m.node.className = 'sui-data-card sui-theme-player tm-card tm-w' + (state.solo ? 3 : (c.w || 1));
      if (grid.children[i] !== m.node) grid.insertBefore(m.node, grid.children[i] || null);
    });
    if (state.solo && !want.length) grid.appendChild(H.stateBlock('info', 'This card is no longer on the workspace.'));
    if (!state.solo && !want.length) grid.appendChild(H.stateBlock('info', 'An empty workspace. Add a card above, or type a command.'));
  }

  function renderAll() {
    var host = document.getElementById('terminal-body');
    if (!host) return;
    host.innerHTML = '';
    if (!state.solo) host.appendChild(chrome());
    var grid = H.el('div', 'tm-grid' + (state.solo ? ' tm-solo' : ''));
    grid.id = 'tm-grid';
    host.appendChild(grid);
    renderGrid();
  }

  // ── The chrome: workspaces, the command line, add a card ────────────────
  function chrome() {
    var top = H.el('div', 'tm-chrome');

    // Workspaces: the board's own nav strip, plus a door to make a new one.
    var strip = H.el('div', 'tm-workspaces');
    var items = state.workspaces.map(function (n) { return { key: n, label: n }; });
    items.push({ key: '+', label: '+' });
    var nav = H.navStrip(items, state.ws, function (k) {
      if (k === '+') { newWorkspaceRow(strip); return; }
      switchWorkspace(k);
    });
    nav.id = 'tm-ws-nav';
    strip.appendChild(nav);
    var wsDoors = H.el('span', 'tm-doors');
    wsDoors.appendChild(door('icon-link-out', 'Open this workspace in its own window', function () {
      invoke('open_terminal_workspace', { name: state.ws }).catch(function (e) { Board.stamp && Board.stamp('needs the app: ' + e); });
    }));
    if (state.workspaces.length > 1) {
      wsDoors.appendChild(door('icon-close', 'Delete this workspace', function () { deleteWorkspace(state.ws); }));
    }
    strip.appendChild(wsDoors);
    top.appendChild(strip);

    // The command line and the add-a-card control, one row, symmetric.
    var row = H.el('div', 'tm-toolbar');
    var cmd = H.textBox('', 'MKT · GT 0-1 · 1-194 · 2-15361 · WORK · PEOPLE', function () {});
    cmd.id = 'tm-cmd';
    cmd.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var r = Terminal.execute(cmd.value);
      if (r) cmd.value = ''; else cmd.classList.add('is-err');
    });
    cmd.addEventListener('input', function () { cmd.classList.remove('is-err'); });
    var cmdField = H.field('Command', cmd);
    cmdField.classList.add('tm-cmd-field');
    row.appendChild(cmdField);

    var types = Terminal.types();
    var pick = H.selectBox(types[0] ? types[0].type : '', types.map(function (t) { return { value: t.type, label: t.label }; }), function () { syncParamField(); });
    row.appendChild(H.field('Add a card', pick));
    var paramHost = H.el('span', 'tm-toolbar-param');
    row.appendChild(paramHost);
    var paramCtl = null, paramKey = null;
    function syncParamField() {
      paramHost.innerHTML = '';
      paramCtl = null; paramKey = null;
      var def = TYPES[readControl(pick)];
      if (!def || !def.params || !def.params.length) return;
      var p = def.params[0];
      paramKey = p.key;
      paramCtl = control(p, null);
      paramHost.appendChild(H.field(p.label, paramCtl));
    }
    syncParamField();
    var addBtn = H.el('a', 'sui-screen-btn sui-mod-primary', 'Add');
    addBtn.href = 'javascript:void(0)';
    addBtn.id = 'tm-add';
    addBtn.addEventListener('click', function () {
      var params = {};
      if (paramKey) params[paramKey] = readControl(paramCtl);
      var def = TYPES[readControl(pick)];
      if (def && def.params && def.params.length && def.params[0].kind === 'id' && !params[paramKey]) {
        Board.stamp && Board.stamp('name the ' + def.params[0].label.toLowerCase() + ' first');
        return;
      }
      add(readControl(pick), params);
    });
    row.appendChild(addBtn);
    var reset = H.el('a', 'sui-screen-btn sui-mod-secondary', 'Reset');
    reset.href = 'javascript:void(0)';
    reset.id = 'tm-reset';
    reset.title = 'Back to the default page';
    reset.addEventListener('click', function () {
      Object.keys(state.mounted).forEach(function (id) { unmountCard(id); });
      state.layout = defaultLayout();
      save();
      renderGrid();
    });
    row.appendChild(reset);
    top.appendChild(row);
    return top;
  }

  function newWorkspaceRow(strip) {
    if (strip.querySelector('#tm-ws-new')) return;
    var box = H.textBox('', 'new workspace name', function () {});
    box.id = 'tm-ws-new';
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); createWorkspace(box.value); }
      if (e.key === 'Escape') { box.parentNode.removeChild(box); }
    });
    strip.appendChild(box);
    box.focus();
  }

  // ── The command line ────────────────────────────────────────────────────
  // The terminal's grammar, kept short: a bare id opens the card its type
  // implies (a player, a guild, a planet or fleet's map, anything else the
  // inspector); a word opens a page or a board. `MKT`, `GT 0-1`, `1-194`,
  // `2-15361`, `COMMS 2-15361`, `WORK`, `STATS ORE`, `PEOPLE`, `PAY`, `CHAT`.
  var WORDS = {
    MKT: ['market'], MARKET: ['market'], PEOPLE: ['people'], TAPE: ['tape'], FLOW: ['tape'],
    PAY: ['pay'], CHAT: ['chat'], COMMS: ['comms', 'id'], GT: ['gt', 'id'], GUILD: ['guild', 'id'],
    BANKS: ['banks'], BANK: ['bank'], MINT: ['bank'], REDEEM: ['bank'], SHEET: ['sheet', 'id'], TS: ['sheet', 'id'], TEARSHEET: ['sheet', 'id'],
    PLAYER: ['player', 'id'], MAP: ['map', 'id'], INSPECT: ['inspector', 'id'], WATCH: ['watchlist', 'ids'],
    ORE: ['ore'], HALT: ['halt'], BOOK: ['book', 'id'], ALERTS: ['alerts', 'rules'], ALERT: ['alerts', 'rules'],
    STATS: ['stats', 'section'], WORK: ['page', 'work'], TX: ['page', 'tx'], ENERGY: ['page', 'energy'],
    ROSTER: ['page', 'armada'], ARMADA: ['page', 'armada'], RAIDS: ['page', 'raids'], STREAM: ['page', 'grass'],
    INVENTORY: ['page', 'inventory'], WAR: ['page', 'war'], OPS: ['page', 'ops'], CONFIG: ['page', 'config'],
  };
  Terminal.execute = function (line) {
    var parts = String(line || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    var head = parts[0].toUpperCase();
    var rest = parts.slice(1).join(' ');
    var idm = /^(\d{1,2})-(\d{1,9})$/.exec(parts[0]);
    if (idm && parts.length === 1) {
      var kind = Number(idm[1]);
      if (kind === 1) return !!add('player', { id: parts[0] });
      if (kind === 0) return !!add('guild', { id: parts[0] });
      if (kind === 2 || kind === 9) return !!add('map', { id: parts[0] });
      return !!add('inspector', { id: parts[0] });
    }
    var w = WORDS[head];
    if (!w) return false;
    var type = w[0], arg = w[1];
    if (!arg) return !!add(type, {});
    if (arg === 'id' || arg === 'ids' || arg === 'rules') { if (!rest) return false; var p = {}; p[arg] = rest; return !!add(type, p); }
    if (arg === 'section') return !!add(type, { section: (rest || 'universe').toLowerCase() });
    return !!add(type, { page: arg });
  };

  // ── Cadence: one 1s tick for every mounted card ─────────────────────────
  setInterval(function () {
    if (document.visibilityState === 'hidden' || Board.current !== 'terminal') return;
    var now = Date.now();
    Object.keys(state.mounted).forEach(function (id) {
      var m = state.mounted[id];
      if (!m.def || !m.def.cadenceMs || m.busy) return;
      if (now - m.lastRun >= m.def.cadenceMs) refresh(id, false);
    });
  }, 1000);

  // ── Shared: the Comms reference cards, for the inspector and the watchlist
  var refs = null;
  function ensureRefs() {
    if (refs || !window.ChatRefs) return refs;
    refs = window.ChatRefs({
      el: H.el, icon: function (name, size) { return H.el('i', name + (size ? ' ' + size : '')); }, invoke: invoke,
      fmtCount: H.fmtInt, go: function () {}, pfpPortrait: H.pfpPortrait,
      presenceDot: function (id) { return Board.presenceDot ? Board.presenceDot(id) : null; },
      // When a looked-up card lands, every card that shows references repaints.
      render: function () { Object.keys(state.mounted).forEach(function (id) { var m = state.mounted[id]; if (m.def && m.def.usesRefs) refresh(id, true); }); },
      rentForm: function (card, box) { rentInto(card, box); }, startDm: function (id) { if (Board.reachActions) { var a = Board.reachActions({ player_id: id }); if (a[0]) a[0].onClick(); } },
      S: { view: 'terminal', guildId: null, roomId: null, openRefs: {} }, Chat: {},
    });
    return refs;
  }
  var rent = null;
  function rentInto(card, box) {
    if (!rent && window.ChatRent) {
      rent = window.ChatRent({ el: H.el, invoke: invoke, fmtCount: H.fmtInt, cardNote: function (b, text, bad) { b.appendChild(H.stateBlock(bad ? 'error' : 'ok', text)); } });
    }
    if (rent) rent.rentForm(card, box);
  }

  // ── Card types ──────────────────────────────────────────────────────────

  Terminal.register('people', {
    label: 'Galaxy liveness', describe: function () { return 'Galaxy liveness'; }, cadenceMs: 30000,
    render: function (host) {
      var G = Board._gamestats;
      return G.ensureBoot().then(function () {
        host.innerHTML = '';
        if (!G.state.snap) { host.appendChild(H.stateBlock('info', 'Contacting the stats engine…')); return; }
        host.appendChild(G.cards.liveness(G.state.snap.totals || {}));
      });
    },
  });

  var STATS_SECTIONS = [
    { value: 'universe', label: 'Universe' }, { value: 'trends', label: 'Trends' }, { value: 'engine', label: 'Our engine' },
    { value: 'ore', label: 'Ore economy' }, { value: 'raids', label: 'Raid pressure' }, { value: 'players', label: 'Best players' },
    { value: 'guilds', label: 'Best guilds' },
  ];
  Terminal.register('stats', {
    label: 'Game Stats section', defaultWidth: 2,
    describe: function (p) { var s = STATS_SECTIONS.filter(function (x) { return x.value === p.section; })[0]; return 'Game Stats · ' + (s ? s.label : p.section || '?'); },
    params: [{ key: 'section', label: 'Section', kind: 'choice', options: STATS_SECTIONS }],
    cadenceMs: 30000,
    render: function (host, p) {
      var G = Board._gamestats;
      return G.ensureBoot().then(function () {
        host.innerHTML = '';
        var fn = G.cards[p.section || 'universe'];
        if (!fn) { host.appendChild(H.stateBlock('error', 'No such section: ' + p.section)); return; }
        if (!G.state.snap) { host.appendChild(H.stateBlock('info', 'Contacting the stats engine…')); return; }
        host.appendChild(fn(G.state.snap.totals || {}));
      });
    },
  });

  Terminal.register('market', {
    label: 'Energy market', defaultWidth: 2, describe: function () { return 'Energy market'; }, cadenceMs: 60000,
    render: function (host) {
      return invoke('terminal_market').then(function (m) {
        host.innerHTML = '';
        var list = (m && m.providers) || [];
        var head = H.el('div', 'tm-cap');
        head.appendChild(H.el('span', 'fstat-l', list.length + ' offers' + (m && m.height ? ' · block ' + H.fmtInt(m.height) : '')));
        host.appendChild(head);
        if (!list.length) { host.appendChild(H.stateBlock('info', 'No providers on the chain.')); return; }
        var grid = H.el('div', 'tm-market');
        list.forEach(function (card) { grid.appendChild(providerCard(card)); });
        host.appendChild(grid);
      });
    },
  });

  function providerCard(card) {
    var p = card.provider || {};
    var isAlpha = p.rate_denom === 'ualpha';
    var box = H.el('div', 'tm-offer');
    var acts = [];
    if (p.open) acts.push({ icon: 'icon-transfers', title: 'Rent capacity', onClick: function () { rentInto(card, box); } });
    box.appendChild(window.StructsProviderCard.card({
      id: card.id,
      substation: card.substation_id || null,
      policy: card.policy || (p.open ? 'openMarket' : null),
      rate: p.rate_amount != null ? { value: H.fmtInt(p.rate_amount), denomLabel: isAlpha ? null : (p.denom_label || p.rate_denom || null), denomIcon: isAlpha ? 'sui-icon-alpha-matter' : null } : null,
      capacity: p.capacity_min != null ? { min: p.capacity_min_text || H.fmtInt(p.capacity_min) + 'W', max: p.capacity_max_text || H.fmtInt(p.capacity_max) + 'W' } : null,
      duration: p.duration_min != null ? { min: p.duration_min_text || H.fmtInt(p.duration_min), max: p.duration_max_text || H.fmtInt(p.duration_max), blocks: H.fmtInt(p.duration_min) + ' – ' + H.fmtInt(p.duration_max) + ' blocks' } : null,
      owner: card.owner && card.owner.id ? { id: card.owner.id, name: card.owner.name, tag: card.owner.tag, pfp: card.owner.pfp_attrs } : null,
    }, { actions: acts }));
    return box;
  }

  Terminal.register('player', {
    label: 'Watch a player', describe: function (p) { return 'Player ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Player id', kind: 'id', placeholder: '1-194' }],
    cadenceMs: 60000,
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a player id.')); return; }
      return invoke('mcp_player_search', { query: p.id }).then(function (res) {
        host.innerHTML = '';
        var rows = (res && res.results) || [];
        var r = rows.filter(function (x) { return x.player_id === p.id; })[0] || rows[0];
        if (!r) { host.appendChild(H.stateBlock('info', 'No player ' + p.id)); return; }
        var attrs = r.pfp_attrs || r.pfp;
        if (attrs && typeof attrs !== 'string') attrs = JSON.stringify(attrs);
        host.appendChild(window.StructsPlayerCard.card({
          id: r.player_id, name: r.username || r.player_id, pfp: attrs,
          presence: Board.presenceDot && Board.presenceDot(r.player_id),
          guild: ((r.tag ? '[' + r.tag + '] ' : '') + (r.guild_name || r.guild_id || '')).trim() || null,
          charge: r.charge,
          readings: r.alpha != null ? [{ value: H.fmtAlpha(r.alpha), icon: 'sui-icon-alpha-matter', title: 'Alpha' }] : [],
        }, { actions: (Board.watchActions ? Board.watchActions(r) : []).concat(Board.reachActions ? Board.reachActions(r) : []) }));
      });
    },
  });

  Terminal.register('guild', {
    label: 'Watch a guild', describe: function (p) { return 'Guild ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Guild id', kind: 'id', placeholder: '0-1' }],
    cadenceMs: 60000,
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a guild id.')); return; }
      var G = Board._gamestats;
      return G.ensureBoot().then(function () {
        host.innerHTML = '';
        var g = ((G.state.snap && G.state.snap.guilds) || []).filter(function (x) { return x.guild_id === p.id; })[0];
        if (!g) { host.appendChild(H.stateBlock('info', 'No guild ' + p.id + ' in the stats table yet.')); return; }
        host.appendChild(window.StructsGuildCard.card({
          id: g.guild_id, name: g.name || null, tag: g.tag || null, logo: g.logo || null,
          readings: [
            { value: H.fmtInt(g.players), icon: 'sui-icon-players', title: 'Members' },
            { value: H.fmtAlpha(g.alpha), icon: 'sui-icon-alpha-matter', title: 'Alpha' },
            { value: H.fmtWatts(g.structs_load), icon: 'sui-icon-energy', title: 'Structs load' },
          ],
        }, {}));
      });
    },
  });

  // Any object by id — the Comms reference card, which knows every kind.
  Terminal.register('inspector', {
    label: 'Inspect an object', usesRefs: true,
    describe: function (p) { return 'Inspect ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Object id', kind: 'id', placeholder: '5-4559 · 4-4 · 10-1' }],
    cadenceMs: 120000,
    render: function (host, p) {
      host.innerHTML = '';
      if (!p.id) { host.appendChild(H.stateBlock('info', 'Configure this card with any object id.')); return; }
      var R = ensureRefs();
      if (!R) { host.appendChild(H.stateBlock('error', 'Reference cards not loaded.')); return; }
      var card = R.cards[p.id];
      if (!card) { R.wantRefs([p.id]); host.appendChild(H.stateBlock('info', 'Looking up ' + p.id + '…')); return; }
      host.appendChild(R.refCard(card));
    },
  });

  // Several objects, one glance: a watchlist of reference cards.
  Terminal.register('watchlist', {
    label: 'Watchlist', defaultWidth: 2, usesRefs: true,
    describe: function () { return 'Watchlist'; },
    params: [{ key: 'ids', label: 'Ids, space-separated', kind: 'text', placeholder: '1-194 0-1 2-15361 10-1' }],
    cadenceMs: 120000,
    render: function (host, p) {
      host.innerHTML = '';
      var ids = String(p.ids || '').split(/[\s,]+/).filter(function (s) { return /^\d{1,2}-\d{1,9}$/.test(s); });
      if (!ids.length) { host.appendChild(H.stateBlock('info', 'Configure this card with the ids to watch.')); return; }
      var R = ensureRefs();
      if (!R) { host.appendChild(H.stateBlock('error', 'Reference cards not loaded.')); return; }
      var missing = ids.filter(function (id) { return !R.cards[id]; });
      if (missing.length) R.wantRefs(missing);
      var grid = H.el('div', 'tm-market');
      ids.forEach(function (id) {
        var card = R.cards[id];
        grid.appendChild(card ? R.refCard(card) : H.stateBlock('info', 'Looking up ' + id + '…'));
      });
      host.appendChild(grid);
    },
  });

  // The flow tape: the live stream's economic frames, as the stream draws them.
  var ECONOMY = /transfer|sent|received|settled|mint|burn|refine|seized|infus|agreement|provider|allocation|ore/i;
  var tape = { rows: [], listening: false };
  Terminal.register('tape', {
    label: 'Flow tape', describe: function () { return 'Flow tape'; }, cadenceMs: 15000,
    render: function (host) {
      var draw = function () {
        host.innerHTML = '';
        var ul = H.el('ul', 'ops-feed sui-text-ticker tm-tape');
        var rows = tape.rows.filter(function (ev) { return ECONOMY.test(String(ev.category || '')); }).slice(0, 40);
        if (!rows.length) ul.appendChild(H.el('li', 'ops-muted', 'no economic frames yet'));
        rows.forEach(function (ev) { ul.appendChild(Board._grass && Board._grass.row ? Board._grass.row(ev) : H.el('li', null, ev.category)); });
        host.appendChild(ul);
      };
      if (!tape.listening && window.StructsEvents) {
        tape.listening = true;
        window.StructsEvents.listen('grass-event', function (e) {
          var ev = e && e.payload;
          if (!ev || !ECONOMY.test(String(ev.category || ''))) return;
          tape.rows.unshift(ev);
          if (tape.rows.length > 200) tape.rows.length = 200;
          if (state.mounted['tape-1'] || Object.keys(state.mounted).some(function (id) { return state.mounted[id].def && state.mounted[id].def.type === 'tape'; })) draw();
        });
      }
      return invoke('mcp_grass_recent').then(function (recent) {
        if (Array.isArray(recent) && recent.length && !tape.rows.length) tape.rows = recent.slice().reverse();
      }).catch(function () {}).then(draw);
    },
  });

  var PAGES = [
    { value: 'work', label: 'Work queue' }, { value: 'tx', label: 'Transactions' }, { value: 'energy', label: 'Energy' },
    { value: 'armada', label: 'Armada roster' }, { value: 'raids', label: 'Raids' }, { value: 'grass', label: 'Live stream' },
    { value: 'inventory', label: 'Inventory' }, { value: 'war', label: 'War' }, { value: 'ops', label: 'Overview' },
    { value: 'config', label: 'Settings' }, { value: 'explore', label: 'Explore' }, { value: 'diagnostics', label: 'Diagnostics' },
  ];
  Terminal.register('page', {
    label: 'Team Ops page', defaultWidth: 2,
    describe: function (p) { var s = PAGES.filter(function (x) { return x.value === p.page; })[0]; return 'Team Ops · ' + (s ? s.label : p.page || '?'); },
    params: [{ key: 'page', label: 'Page', kind: 'choice', options: PAGES }],
    cadenceMs: 5000,
    render: function (host, p) {
      var name = p.page || 'work';
      var page = document.getElementById('page-' + name);
      var def = Board.pages[name];
      if (!page || !def) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', 'No page ' + name)); return; }
      if (page.parentNode !== host) {
        host.innerHTML = '';
        page.hidden = false;
        host.appendChild(page);
        if (def.onEnter) return Promise.resolve(def.onEnter({}, p.view)).then(function () { def.lastRun = Date.now(); });
        return;
      }
      if (def.refresh && (!def.cadenceMs || Date.now() - def.lastRun >= def.cadenceMs)) {
        def.lastRun = Date.now();
        return def.refresh();
      }
    },
    unmount: function (host, p) {
      var page = document.getElementById('page-' + (p.page || 'work'));
      var home = document.querySelector('.ops-scroll');
      if (page && home) { page.hidden = true; home.appendChild(page); }
    },
  });

  // Who is closest to brownout: our roster's power margins, worst first.
  Terminal.register('halt', {
    label: 'Halt watch', defaultWidth: 2, describe: function () { return 'Halt watch'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_energy').then(function (e) {
        host.innerHTML = '';
        var players = ((e && e.players) || []).slice().sort(function (a, b) { return (Number(a.margin_pct) || 0) - (Number(b.margin_pct) || 0); });
        var atRisk = players.filter(function (r) { return Number(r.margin_pct) < 20; });
        var cap = H.el('div', 'tm-cap');
        cap.appendChild(H.el('span', 'fstat-l', players.length + ' players · ' + atRisk.length + ' under 20% margin'));
        host.appendChild(cap);
        if (!players.length) { host.appendChild(H.stateBlock('info', 'No roster power readings yet.')); return; }
        var table = H.resultTable();
        players.slice(0, 20).forEach(function (r) {
          var margin = Number(r.margin_pct);
          table.appendChild(window.StructsPlayerCard.row({
            id: r.player_id || r.name, name: r.name || r.player_id, pfp: r.pfp_attrs, sub: r.role || null,
            err: margin <= 0, attn: margin <= 0 ? 'brownout' : (margin < 20 ? 'thin margin' : null),
            readings: [
              { value: H.fmtWatts(r.load_mw) + ' / ' + H.fmtWatts(r.capacity_mw), icon: 'sui-icon-energy', title: 'Load / capacity' },
              { value: (isFinite(margin) ? margin.toFixed(0) : '—') + '%', icon: 'icon-alert', title: 'Margin' },
            ],
          }, { actions: (Board.watchActions ? Board.watchActions(r) : []) }));
        });
        host.appendChild(table);
      });
    },
  });

  // Where the ore is: every planet with ore left, richest first, owner named.
  Terminal.register('ore', {
    label: 'Ore radar', defaultWidth: 2, describe: function () { return 'Ore radar'; }, cadenceMs: 60000,
    render: function (host) {
      return invoke('terminal_ore_radar', { limit: 30 }).then(function (r) {
        host.innerHTML = '';
        var rows = (r && r.planets) || [];
        var cap = H.el('div', 'tm-cap');
        cap.appendChild(H.el('span', 'fstat-l', H.fmtInt((r && r.planets_with_ore) || 0) + ' planets with ore' + (r && r.height ? ' · block ' + H.fmtInt(r.height) : '')));
        host.appendChild(cap);
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'The snapshot has no ore readings yet.')); return; }
        var table = H.resultTable();
        rows.forEach(function (p) {
          var attrs = p.owner_pfp; if (attrs && typeof attrs !== 'string') attrs = JSON.stringify(attrs);
          table.appendChild(window.StructsPlayerCard.row({
            id: p.owner || '?', name: p.owner_name || p.owner || 'unowned', pfp: attrs, sub: p.planet_id,
            guild: ((p.owner_tag ? '[' + p.owner_tag + '] ' : '') + (p.owner_guild || '')).trim() || null,
            readings: [
              { value: H.fmtOre(p.ore), icon: 'sui-icon-alpha-ore', title: 'Ore on the planet' },
              { value: H.fmtInt(p.shield), icon: 'icon-planetary-shield', title: 'Planetary shield' },
            ],
          }, { actions: [{ icon: 'icon-planet', title: 'Map this planet', onClick: function () { add('map', { id: p.planet_id }); } }] }));
        });
        host.appendChild(table);
      });
    },
  });

  // The book: what a player has bought and sold on the energy market, and
  // when the first of it runs out.
  Terminal.register('book', {
    label: 'Energy book', defaultWidth: 2,
    describe: function (p) { return 'Book · ' + (p.id || 'primary'); },
    params: [{ key: 'id', label: 'Player id', kind: 'id', placeholder: '1-194' }],
    cadenceMs: 60000,
    render: function (host, p) {
      var who = p.id || (Board.primaryId ? Board.primaryId() : '');
      if (!who) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a player id.')); return; }
      return invoke('terminal_agreements', { player: who }).then(function (b) {
        host.innerHTML = '';
        var strip = H.el('div', 'hstrip gs-strip');
        strip.appendChild(H.statTile(['Supply', 'bought'], H.fmtWatts(b.supply_w), 'sui-icon-energy'));
        strip.appendChild(H.statTile(['Obligation', 'sold'], H.fmtWatts(b.obligation_w), 'sui-icon-energy'));
        strip.appendChild(H.statTile(['Spend', 'per block'], H.fmtInt(b.spend_per_block)));
        strip.appendChild(H.statTile(['Income', 'per block'], H.fmtInt(b.income_per_block)));
        var left = b.first_expiry_block != null && b.height ? Math.max(0, b.first_expiry_block - b.height) : null;
        strip.appendChild(H.statTile(['First expiry', 'in'], left == null ? '—' : window.StructsUnits.fmtDuration(left * 5.3), null, left != null && left < 680 ? 'live' : null));
        host.appendChild(strip);
        var rows = (b.bought || []).map(function (a) { a.side = 'bought'; return a; }).concat((b.sold || []).map(function (a) { a.side = 'sold'; return a; }))
          .filter(function (a) { return a.active; }).sort(function (x, y) { return x.end_block - y.end_block; });
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No active agreements for ' + who + '.')); return; }
        var table = H.resultTable();
        rows.forEach(function (a) {
          table.appendChild(window.StructsPlayerCard.row({
            id: a.counterparty || '?', name: (a.side === 'bought' ? 'buying from ' : 'selling to ') + (a.counterparty || '?'), sub: 'agreement ' + a.id + ' · ' + a.provider_id,
            attn: a.blocks_remaining < 680 ? 'ends ' + window.StructsUnits.fmtDuration(a.blocks_remaining * 5.3) : null,
            readings: [
              { value: H.fmtWatts(a.capacity), icon: 'sui-icon-energy', title: 'Capacity' },
              { value: H.fmtInt(a.rate_amount) + (a.denom_label ? ' ' + a.denom_label : ''), icon: 'sui-icon-alpha-matter', title: 'Rate per W per block' },
              { value: window.StructsUnits.fmtDuration(a.blocks_remaining * 5.3), icon: 'icon-in-progress', title: 'Remaining' },
            ],
          }, {}));
        });
        host.appendChild(table);
      });
    },
  });

  // Alerts: rules over the readings the other cards already fetch, judged
  // every refresh, fired into the card and the board's own alert line.
  //   market.best_rate < 2 · halt.min_margin < 10 · raids.live > 0 ·
  //   people.live_1h < 20 · ore.top < 1000 · book.first_expiry < 680
  var READINGS = {
    'market.best_rate': function () { return invoke('terminal_market').then(function (m) { var r = ((m && m.providers) || []).map(function (p) { return p.provider && p.provider.rate_denom === 'ualpha' ? Number(p.provider.rate_amount) : NaN; }).filter(isFinite); return r.length ? Math.min.apply(null, r) : null; }); },
    'halt.min_margin': function () { return invoke('mcp_energy').then(function (e) { var m = ((e && e.players) || []).map(function (p) { return Number(p.margin_pct); }).filter(isFinite); return m.length ? Math.min.apply(null, m) : null; }); },
    'raids.live': function () { return Board._gamestats.ensureBoot().then(function () { var t = Board._gamestats.state.snap && Board._gamestats.state.snap.totals; return t ? Number(t.raids_active) : null; }); },
    'people.live_1h': function () { return Board._gamestats.ensureBoot().then(function () { var t = Board._gamestats.state.snap && Board._gamestats.state.snap.totals; return t ? Number(t.live_1h) : null; }); },
    'ore.top': function () { return invoke('terminal_ore_radar', { limit: 1 }).then(function (r) { var p = r && r.planets && r.planets[0]; return p ? Number(p.ore) : null; }); },
    'book.first_expiry': function () { return invoke('terminal_agreements', { player: Board.primaryId ? Board.primaryId() : '' }).then(function (b) { return b && b.first_expiry_block != null && b.height ? b.first_expiry_block - b.height : null; }); },
  };
  var OPS = { '<': function (a, b) { return a < b; }, '>': function (a, b) { return a > b; }, '<=': function (a, b) { return a <= b; }, '>=': function (a, b) { return a >= b; }, '=': function (a, b) { return a === b; } };
  function parseRules(text) {
    return String(text || '').split(/[;\n]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
      var m = /^([a-z_.0-9]+)\s*(<=|>=|<|>|=)\s*(-?[\d.]+)$/i.exec(s);
      return m ? { metric: m[1].toLowerCase(), op: m[2], value: Number(m[3]), text: s } : { text: s, bad: true };
    });
  }
  Terminal.parseRules = parseRules;
  var alertsFired = {};
  Terminal.register('alerts', {
    label: 'Alerts', describe: function () { return 'Alerts'; },
    params: [{ key: 'rules', label: 'Rules, one per line', kind: 'text', placeholder: 'market.best_rate < 2; raids.live > 0' }],
    cadenceMs: 30000,
    render: function (host, p) {
      var rules = parseRules(p.rules);
      host.innerHTML = '';
      if (!rules.length) { host.appendChild(H.stateBlock('info', 'Configure this card with rules: ' + Object.keys(READINGS).join(' · '))); return; }
      var fired = H.el('div', 'tm-fired');
      host.appendChild(fired);
      var table = H.resultTable();
      host.appendChild(table);
      return Promise.all(rules.map(function (r) {
        if (r.bad || !READINGS[r.metric]) return { rule: r, state: 'bad' };
        return READINGS[r.metric]().then(function (v) {
          var fired = v != null && OPS[r.op](v, r.value);
          return { rule: r, value: v, state: v == null ? 'unknown' : (fired ? 'fired' : 'quiet') };
        }).catch(function () { return { rule: r, state: 'unknown' }; });
      })).then(function (results) {
        results.forEach(function (res) {
          var row = H.el('div', 'sui-result-row tm-alert tm-alert-' + res.state);
          var left = H.el('div', 'sui-result-row-left-section');
          var block = H.el('div', 'sui-text-label-block');
          block.appendChild(H.el('span', null, res.rule.text));
          block.appendChild(H.el('br'));
          block.appendChild(H.el('span', 'sui-text-hint', res.state === 'bad' ? 'not a rule' : res.state === 'unknown' ? 'no reading yet' : ('now ' + res.value)));
          left.appendChild(block);
          row.appendChild(left);
          var right = H.el('div', 'sui-result-row-right-section');
          right.appendChild(H.badge ? H.badge(res.state === 'fired' ? 'FIRED' : res.state.toUpperCase(), res.state === 'fired' ? 'warning' : 'default') : H.el('span', null, res.state));
          row.appendChild(right);
          table.appendChild(row);
          if (res.state === 'fired') {
            if (!alertsFired[res.rule.text]) alertsFired[res.rule.text] = Date.now();
            // The board's own inline alert, above the rules: what fired, and since when.
            fired.appendChild(H.alertLine(res.rule.text + ' — now ' + res.value + ', since ' + H.ago(alertsFired[res.rule.text]), 'icon-alert'));
          } else {
            delete alertsFired[res.rule.text];
          }
        });
      });
    },
  });

  // Guild banks: every token's ratio, collateral and supply — the screener.
  Terminal.register('banks', {
    label: 'Guild banks', defaultWidth: 2, describe: function () { return 'Guild banks'; }, cadenceMs: 60000,
    render: function (host) {
      return invoke('terminal_guild_banks').then(function (r) {
        host.innerHTML = '';
        var banks = ((r && r.banks) || []).slice().sort(function (a, b) { return (b.ratio || 0) - (a.ratio || 0); });
        var cap = H.el('div', 'tm-cap');
        cap.appendChild(H.el('span', 'fstat-l', banks.length + ' guild tokens · ratio = collateral / supply'));
        host.appendChild(cap);
        if (!banks.length) { host.appendChild(H.stateBlock('info', 'No guild banks reported yet.')); return; }
        var table = H.resultTable();
        banks.forEach(function (b) {
          table.appendChild(window.StructsGuildCard.row({
            id: b.guild_id, name: b.name || null, tag: b.tag || null, logo: b.logo || null, sub: b.denom || null,
            readings: [
              { value: b.ratio == null ? '—' : Number(b.ratio).toFixed(3), icon: 'sui-icon-alpha-matter', title: 'Alpha per token' },
              { value: H.fmtAlpha(b.collateral), icon: 'icon-planetary-shield', title: 'Collateral' },
              { value: H.fmtInt(b.supply), icon: 'sui-icon-players', title: 'Tokens minted' },
            ],
          }, { actions: [{ icon: 'icon-link-out', title: 'Token chart', onClick: function () { add('gt', { id: b.guild_id }); } }] }));
        });
        host.appendChild(table);
      });
    },
  });

  // One guild token: the ratio now, the ratio as this app has sampled it,
  // and thirty days of supply walked back from today.
  Terminal.register('gt', {
    label: 'Guild token', defaultWidth: 2, describe: function (p) { return 'Guild token · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Guild id', kind: 'id', placeholder: '0-1' }],
    cadenceMs: 60000,
    render: function (host, p) {
      host.innerHTML = '';
      if (!p.id) { host.appendChild(H.stateBlock('info', 'Configure this card with a guild id.')); return; }
      return Promise.all([invoke('terminal_guild_banks'), invoke('terminal_guild_bank_history', { guildId: p.id }).catch(function () { return null; })]).then(function (res) {
        var banks = res[0] || {}, hist = res[1];
        var b = ((banks.banks) || []).filter(function (x) { return x.guild_id === p.id; })[0];
        if (!b) { host.appendChild(H.stateBlock('info', 'No bank for guild ' + p.id + '.')); return; }
        var strip = H.el('div', 'hstrip gs-strip');
        strip.appendChild(H.statTile(['Ratio', 'alpha per token'], b.ratio == null ? '—' : Number(b.ratio).toFixed(3), 'sui-icon-alpha-matter', 'ok'));
        strip.appendChild(H.statTile(['Collateral', 'in the pool'], H.fmtAlpha(b.collateral)));
        strip.appendChild(H.statTile(['Supply', 'tokens minted'], H.fmtInt(b.supply)));
        strip.appendChild(H.statTile(['Token', 'denom'], String(b.denom || '—')));
        host.appendChild(strip);
        var G = Board._gamestats;
        var samples = (banks.history && banks.history[p.id]) || [];
        var line = H.el('div', 'gs-line');
        var cap = H.el('div', 'gs-cap');
        cap.appendChild(H.el('span', 'fstat-l', 'ratio, sampled hourly by this app — ' + samples.length + ' sample' + (samples.length === 1 ? '' : 's')));
        line.appendChild(cap);
        line.appendChild(G.chart({
          series: [{ values: samples.map(function (s) { return Number(s.ratio); }), stroke: 'var(--text-player-primary)' }],
          // A ratio is not a count: the band is min..max, so a move of a few
          // alpha per token is visible rather than flattened against zero.
          zero: false, fmt: function (v) { return Number(v).toFixed(3); },
          ticks: [{ at: 0, text: samples.length ? new Date(samples[0].ts_ms).toLocaleDateString() : '' }, { at: 1, text: 'now' }],
          xLabel: function (i) { var s = samples[i]; return s ? new Date(s.ts_ms).toLocaleString() : ''; },
        }));
        host.appendChild(line);
        if (hist && hist.series && hist.series.length) {
          var sl = H.el('div', 'gs-line');
          var scap = H.el('div', 'gs-cap');
          scap.appendChild(H.el('span', 'fstat-l', 'supply — 30 days, hourly, from the ledger'));
          sl.appendChild(scap);
          sl.appendChild(G.chart({
            series: [{ values: hist.series.map(function (r) { return r.supply == null ? NaN : Number(r.supply); }), stroke: 'var(--accent-secondary)' }],
            fmt: function (v) { return H.fmtInt(v); },
            ticks: [{ at: 0, text: '−30d' }, { at: 0.5, text: '−15d' }, { at: 1, text: 'now' }],
            xLabel: function (i) { var r = hist.series[i]; return r ? String(r.bucket) : ''; },
          }));
          host.appendChild(sl);
        }
      });
    },
  });

  // The bank ticket: mint tokens against alpha, or redeem them. Base units
  // in, a confirm that repeats the figures, the app's own ledger signs.
  Terminal.register('bank', {
    label: 'Guild bank ticket', describe: function () { return 'Guild bank'; }, cadenceMs: 0,
    render: function (host) {
      host.innerHTML = '';
      var form = H.el('div', 'tm-ticket');
      var side = H.selectBox('mint', [{ value: 'mint', label: 'Mint tokens' }, { value: 'redeem', label: 'Redeem tokens' }], function () { paint(); });
      form.appendChild(H.field('Ticket', side));
      var fields = H.el('div', 'tm-ticket-fields');
      form.appendChild(fields);
      var note = H.el('div', 'tm-ticket-note');
      form.appendChild(note);
      var go = H.el('a', 'sui-screen-btn sui-mod-primary', 'Sign');
      go.href = 'javascript:void(0)';
      form.appendChild(go);
      host.appendChild(form);
      var alpha, token, denom, amount;
      function paint() {
        fields.innerHTML = '';
        if (readControl(side) === 'mint') {
          alpha = H.textBox('', 'ualpha in', function () {}); alpha.setAttribute('inputmode', 'numeric');
          token = H.textBox('', 'tokens out', function () {}); token.setAttribute('inputmode', 'numeric');
          fields.appendChild(H.field('Alpha in (ualpha)', alpha));
          fields.appendChild(H.field('Tokens out', token));
        } else {
          denom = H.textBox('uguild.', 'uguild.0-1', function () {});
          amount = H.textBox('', 'tokens', function () {}); amount.setAttribute('inputmode', 'numeric');
          fields.appendChild(H.field('Token denom', denom));
          fields.appendChild(H.field('Tokens to redeem', amount));
        }
      }
      paint();
      go.addEventListener('click', function () {
        note.innerHTML = '';
        var mint = readControl(side) === 'mint';
        var args, summary;
        if (mint) {
          args = { amountAlpha: Number(readControl(alpha)) || 0, amountToken: Number(readControl(token)) || 0 };
          if (!args.amountAlpha || !args.amountToken) { note.appendChild(H.stateBlock('error', 'Both figures are required.')); return; }
          summary = 'Mint ' + H.fmtInt(args.amountToken) + ' tokens for ' + H.fmtInt(args.amountAlpha) + ' ualpha (' + H.fmtAlpha(args.amountAlpha) + ')';
        } else {
          args = { denom: readControl(denom), amount: Number(readControl(amount)) || 0 };
          if (!/^uguild\.\d+-\d+$/.test(args.denom) || !args.amount) { note.appendChild(H.stateBlock('error', 'A guild token denom and an amount are required.')); return; }
          summary = 'Redeem ' + H.fmtInt(args.amount) + ' ' + args.denom;
        }
        var send = function () {
          H.busy(go, true);
          invoke(mint ? 'terminal_guild_bank_mint' : 'terminal_guild_bank_redeem', args).then(function (r) {
            note.appendChild(H.stateBlock('ok', summary + ' — signed' + (r && r.tx ? ' · ' + r.tx : '')));
          }).catch(function (e) { note.appendChild(H.stateBlock('error', String(e))); }).then(function () { H.busy(go, false); });
        };
        if (H.confirmModal) H.confirmModal('Guild bank', H.el('div', null, summary + '. This spends from your primary.'), 'Sign', send); else send();
      });
    },
  });

  // Tearsheet: everything the app knows about one player or guild.
  function kvRows(obj, table) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.slice(0, 12).forEach(function (row, i) { kvRows(row, table); if (i < obj.length - 1) table.appendChild(H.el('div', 'tm-kv-gap')); }); return; }
    if (obj.unavailable) { table.appendChild(H.stateBlock('info', 'unavailable: ' + obj.unavailable)); return; }
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v == null || typeof v === 'object') return;
      table.appendChild(H.row ? H.row(k.replace(/_/g, ' '), String(v)) : H.el('div', null, k + ': ' + v));
    });
  }
  Terminal.register('sheet', {
    label: 'Tearsheet', defaultWidth: 2, describe: function (p) { return 'Tearsheet · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Player or guild id', kind: 'id', placeholder: '1-194 or 0-1' }],
    cadenceMs: 120000,
    render: function (host, p) {
      host.innerHTML = '';
      if (!p.id) { host.appendChild(H.stateBlock('info', 'Configure this card with a player or guild id.')); return; }
      return invoke('terminal_tearsheet', { id: p.id }).then(function (t) {
        if (t.kind === 'player') {
          var id = t.identity || {}, st = t.standing || {};
          var attrs = id.pfp_attrs; if (attrs && typeof attrs !== 'string') attrs = JSON.stringify(attrs);
          var r = { player_id: t.id, planet_id: st.planet_id, fleet_id: st.fleet_id };
          host.appendChild(window.StructsPlayerCard.card({
            id: t.id, name: id.username || t.id, pfp: attrs,
            guild: ((id.tag ? '[' + id.tag + '] ' : '') + (id.guild_name || st.guild_id || '')).trim() || null,
            charge: st.charge, attn: st.known ? null : 'not in the snapshot',
            readings: ['alpha', 'ore', 'structs_load'].filter(function (k) { return t.ranks && t.ranks[k]; }).map(function (k) {
              var rk = t.ranks[k];
              return { value: '#' + rk.rank, icon: k === 'alpha' ? 'sui-icon-alpha-matter' : k === 'ore' ? 'sui-icon-alpha-ore' : 'sui-icon-energy', title: k.replace('_', ' ') + ' rank' };
            }),
          }, { actions: (Board.watchActions ? Board.watchActions(r) : []).concat(Board.reachActions ? Board.reachActions(r) : []) }));
          var strip = H.el('div', 'hstrip gs-strip');
          strip.appendChild(H.statTile(['Last action', 'ago'], st.ago_blocks == null ? '—' : window.StructsUnits.fmtDuration(st.ago_blocks * 5.3, { zero: 'now' })));
          strip.appendChild(H.statTile(['Planet', 'home'], String(st.planet_id || '—')));
          strip.appendChild(H.statTile(['Fleet', 'id'], String(st.fleet_id || '—')));
          host.appendChild(strip);
          [['ore', 'Ore'], ['planets', 'Planets completed'], ['raids', 'Raids launched'], ['ledger', 'Ledger']].forEach(function (sec) {
            var box = H.el('div', 'gs-line');
            var cap = H.el('div', 'gs-cap'); cap.appendChild(H.el('span', 'fstat-l', sec[1])); box.appendChild(cap);
            var table = H.el('div', 'tm-kv'); kvRows(t[sec[0]], table); box.appendChild(table);
            host.appendChild(box);
          });
        } else {
          var g = t.board || {};
          host.appendChild(window.StructsGuildCard.card({
            id: t.id, name: g.name || null, tag: g.tag || null, logo: g.logo || null,
            readings: [
              { value: H.fmtInt(t.members_in_snapshot), icon: 'sui-icon-players', title: 'Members in the snapshot' },
              { value: H.fmtAlpha(g.alpha), icon: 'sui-icon-alpha-matter', title: 'Alpha' },
              { value: H.fmtWatts(g.structs_load), icon: 'sui-icon-energy', title: 'Structs load' },
            ],
          }, {}));
          [['guild', 'Guild'], ['power', 'Power'], ['planets', 'Planets']].forEach(function (sec) {
            var box = H.el('div', 'gs-line');
            var cap = H.el('div', 'gs-cap'); cap.appendChild(H.el('span', 'fstat-l', sec[1])); box.appendChild(cap);
            var table = H.el('div', 'tm-kv'); kvRows(t[sec[0]], table); box.appendChild(table);
            host.appendChild(box);
          });
        }
      });
    },
  });

  // Whole windows, framed: the spectator map, the Comms window, the Pay window.
  function framed(url, title) {
    var f = document.createElement('iframe');
    f.className = 'tm-frame';
    f.title = title;
    f.src = url;
    return f;
  }
  Terminal.register('map', {
    label: 'Map viewer', defaultWidth: 2,
    describe: function (p) { return 'Map · ' + (String(p.id || '').indexOf('9-') === 0 ? 'fleet ' : 'planet ') + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet or fleet id', kind: 'id', placeholder: '2-15361' }],
    cadenceMs: 0,
    render: function (host, p) {
      host.innerHTML = '';
      if (!p.id) { host.appendChild(H.stateBlock('info', 'Configure this card with a planet (2-…) or fleet (9-…) id.')); return; }
      var kind = String(p.id).indexOf('9-') === 0 ? 'fleet' : 'planet';
      host.appendChild(framed('raidview.html?' + kind + '=' + encodeURIComponent(p.id), 'Map of ' + kind + ' ' + p.id));
    },
  });
  Terminal.register('chat', {
    label: 'Comms window', defaultWidth: 2, describe: function () { return 'Comms'; }, cadenceMs: 0,
    render: function (host) { host.innerHTML = ''; host.appendChild(framed('chat.html', 'Comms')); },
  });
  Terminal.register('pay', {
    label: 'Pay', describe: function () { return 'Pay'; }, cadenceMs: 0,
    render: function (host) { host.innerHTML = ''; host.appendChild(framed('transfer.html', 'Pay')); },
  });

  // Comms about one object: the raid view's own rail, which IS the object's
  // room. It owns fixed DOM ids, so one per window.
  Terminal.register('comms', {
    label: 'Comms about an object', single: true,
    describe: function (p) { return 'Comms · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet or fleet id', kind: 'id', placeholder: '2-15361' }],
    cadenceMs: 0,
    render: function (host, p) {
      host.innerHTML = '';
      if (!p.id) { host.appendChild(H.stateBlock('info', 'Configure this card with a planet or fleet id.')); return; }
      if (!window.RaidComms) { host.appendChild(H.stateBlock('error', 'Comms rail not loaded.')); return; }
      var kind = String(p.id).indexOf('9-') === 0 ? 'fleet' : 'planet';
      var target = { kind: kind, id: p.id };
      var head = H.el('div', 'tm-cap'); head.id = 'rv-chat-head';
      head.appendChild(H.el('span', 'rv-chat-title fstat-l'));
      var count = H.el('span', 'rv-chat-count fstat-l'); count.id = 'rv-chat-count';
      head.appendChild(count);
      host.appendChild(head);
      var body = H.el('div', 'tm-comms-body'); body.id = 'rv-chat-body';
      host.appendChild(body);
      var compose = H.el('div', 'rv-chat-compose'); compose.id = 'rv-chat-compose';
      var entry = H.el('div', 'rv-chat-entry'); entry.id = 'rv-chat-entry';
      compose.appendChild(entry);
      var err = H.el('div', 'rv-chat-error sui-text-hint'); err.id = 'rv-chat-error';
      compose.appendChild(err);
      host.appendChild(compose);
      var comms = window.RaidComms({
        el: H.el, target: function () { return target; },
        paintPfp: function (h, attrs) { if (h && window.StructsPfp) window.StructsPfp.fillPortrait(h, attrs); },
        paintBattery: function (bat, charge) {
          if (!bat) return;
          var level = window.StructsPlayerCard.chargeLevel(charge);
          for (var i = 0; i < bat.children.length; i++) bat.children[i].classList.toggle('sui-mod-filled', i + 1 <= level);
        },
        whoLine: function (n, i, u) { return n ? n + ' (' + (i || '?') + ')' : (i || u || 'unknown'); },
        fmtNum: function (n) { return String(Math.round(Number(n) || 0)); },
      });
      comms.wireChat();
      comms.wireComposer();
      comms.renderChat();
    },
  });

  // ── Boot ────────────────────────────────────────────────────────────────
  function enter() {
    state.solo = param('card');
    return loadWorkspaces().then(function () {
      state.ws = param('ws') || state.active || 'main';
      if (state.workspaces.indexOf(state.ws) < 0) state.workspaces.push(state.ws);
      return load();
    }).then(function () { renderAll(); });
  }
  Terminal.enter = enter;

  Board.registerPage('terminal', { onEnter: enter });
  if (Board.current === 'terminal' && Board.T) enter();
})();
