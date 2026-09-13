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
//   params       [{ key, label, kind: 'id' | 'choice' | 'text', options?, placeholder?,
//                    kinds? }]  — an `id` param MUST declare `kinds`: the object
//                    kinds it accepts as chain-id prefixes ([1] = player, [2, 9]
//                    = planet or fleet), or `null` for any object. That is what
//                    lets the command line answer "what can I ask of 2-29604?"
//                    without guessing, and a test fails an id param without it.
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
    types: function () { return Object.keys(TYPES).map(function (k) { return TYPES[k]; }).filter(function (t) { return !t.hidden; }); },
    known: function (type) { return !!TYPES[type]; },
    groups: function () { return cardGroups(); },
    state: state,
  };
  Board.Terminal = Terminal;

  /* The card menu, grouped the way Team Ops names its areas.
   *
   * Forty-two cards in one alphabet-free scroll is not a menu, it is an
   * inventory: you either already knew the card's exact name or you read the
   * whole list. These are the board's own areas, so the vocabulary a player
   * learns on the tabs is the vocabulary that finds a card — and within a
   * group the order is what you reach for first, not what registered first.
   *
   * A type missing from here still appears (under "More"), and the harness
   * fails on it: a new card that nobody filed is a card nobody will find. */
  var CARD_GROUPS = [
    ['Command', ['help', 'next', 'alerts', 'watchlist', 'feed']],
    ['Explore', ['player', 'record', 'guild', 'members', 'planet', 'map', 'inspector', 'sheet', 'chart', 'people', 'stats']],
    ['Armada', ['armada', 'ops', 'build', 'fleet', 'pow', 'tasks', 'solve', 'queue', 'results', 'crew', 'crewpay']],
    ['Industry', ['grid', 'brownout', 'halt', 'allocations', 'fuel', 'market', 'book', 'ore', 'banks', 'gt', 'bank', 'wallet', 'deliver']],
    ['War', ['scout', 'tally', 'posture', 'targets', 'raids', 'log', 'grudges', 'vetoes', 'incidents']],
    ['System', ['health']],
  ];
  function cardGroups() {
    var seen = {}, out = [];
    CARD_GROUPS.forEach(function (g) {
      var opts = [];
      g[1].forEach(function (t) {
        var def = TYPES[t];
        if (!def || def.hidden) return;
        seen[t] = 1;
        opts.push({ value: t, label: def.label || t });
      });
      if (opts.length) out.push({ group: g[0], options: opts });
    });
    var rest = Terminal.types().filter(function (t) { return !seen[t.type]; })
      .map(function (t) { return { value: t.type, label: t.label || t.type }; });
    if (rest.length) out.push({ group: 'More', options: rest });
    return out;
  }

  // ── Workspaces + layout persistence ─────────────────────────────────────
  var LOCAL_KEY = 'structs.terminal.';

  function defaultLayout() {
    return { version: 0, cards: [
      { id: 'people-1', type: 'people', params: {}, w: 1 },
      { id: 'market-1', type: 'market', params: {}, w: 2 },
      { id: 'feed-1', type: 'feed', params: { span: '24' }, w: 2 },
      { id: 'stats-1', type: 'stats', params: { section: 'universe' }, w: 2 },
      { id: 'pow-1', type: 'pow', params: {}, w: 1 },
      { id: 'queue-1', type: 'queue', params: {}, w: 1 },
      { id: 'raids-1', type: 'raids', params: {}, w: 1 },
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
      // Our own copy: the page edits the layout in place.
      return JSON.parse(JSON.stringify(l));
    }).catch(function () {
      try {
        var raw = localStorage.getItem(LOCAL_KEY + state.ws);
        if (raw) { var l = JSON.parse(raw); if (l && Array.isArray(l.cards)) return l; }
      } catch (e) { /* storage may be unavailable */ }
      return null;
    }).then(function (l) {
      state.layout = (l && l.cards.length) ? migrate(l) : defaultLayout();
      return state.layout;
    });
  }
  // Saved layouts from when a Team Ops PAGE was a card. A page card becomes
  // the cards that now carry its data, in place; ids stay unique.
  var PAGE_TO_CARDS = {
    work: [['pow', {}, 1], ['tasks', {}, 2]], tx: [['queue', {}, 1], ['results', {}, 1]],
    energy: [['grid', {}, 1], ['halt', {}, 2]], 'energy:production': [['fuel', {}, 1]], 'energy:distribution': [['grid', {}, 1], ['allocations', {}, 1]],
    armada: [['armada', {}, 2]], raids: [['raids', {}, 1]], inventory: [['wallet', {}, 1]], diagnostics: [['health', {}, 1]],
    war: [['posture', {}, 1], ['targets', {}, 2]], 'war:doctrine': [['posture', {}, 1]], 'war:targets': [['targets', {}, 2]],
    'war:lists': [['grudges', {}, 1], ['vetoes', {}, 1]], 'war:incidents': [['incidents', {}, 2]], grass: [['feed', { span: '24' }, 2]],
    ops: [['health', {}, 1], ['pow', {}, 1]], explore: [['people', {}, 1]],
  };
  var DROPPED = { chat: 1, comms: 1, room: 1, channels: 1, find: 1, who: 1 };
  function migrate(l) {
    var out = [], seen = {};
    l.cards.forEach(function (c) { seen[c.id] = true; });
    var fresh = function (type) { var n = 1; while (seen[type + '-' + n]) n++; seen[type + '-' + n] = true; return type + '-' + n; };
    l.cards.forEach(function (c) {
      // The roster card was called `fleet` until the word was needed for the
      // game's own fleets; a layout saved then still opens.
      if (c.type === 'fleet') c.type = 'armada';
      // `pay` was renamed `deliver`; a layout saved under the old name still opens.
      if (c.type === 'pay') c.type = 'deliver';
      /* Comms is a WINDOW again, not a card — five card types (and the
       * older framed `chat`) came and went. A layout that still names one
       * simply loses it; the words that opened them now raise the window. */
      if (DROPPED[c.type]) return;
      /* The live tape and the ops feed became one card. A layout saved before
       * that rebuild is rewritten rather than kept working by an alias: an
       * alias is a SECOND type, so it walks straight past `single`, and a real
       * board came out of the rebuild carrying a `tape` plus three leftover
       * `feed` cards — four pulse bands, four rollup queries, and one shared
       * scope for them all to fight over. The old `filter` maps onto the lane
       * it was reaching for; `all` had no lane and wants none. */
      /* The one-series history card became the chart: a saved `series`
       * card is a one-series chart of the same object and window. */
      if (c.type === 'series') {
        var sp = c.params || {};
        c.type = 'chart';
        c.params = { series: JSON.stringify(sp.id ? [{ source: 'stat', metric: sp.metric || 'ore', subject: sp.id }] : []), window: sp.window };
      }
      if (c.type === 'tape') {
        var lane = { combat: 'war', economy: 'economy' }[String((c.params || {}).filter || '')];
        c.type = 'feed';
        c.params = lane ? { lane: lane } : {};
      }
      var into = c.type === 'page' ? PAGE_TO_CARDS[String((c.params || {}).page || 'work')] : null;
      if (!into) { out.push(c); return; }
      into.forEach(function (n) { out.push({ id: fresh(n[0]), type: n[0], params: n[1], w: n[2] }); });
    });
    /* A `single` type means one per window, and `add()` enforces it — but a
     * layout can carry more from before the flag existed, from an import, or
     * from a rename like the one above. The FIRST keeps its place and its
     * params; the rest go, because two of a card that owns fixed state (the
     * feed's scope, the help card's ids) is two of them fighting. */
    var kept = {};
    l.cards = out.filter(function (c) {
      var def = TYPES[c.type];
      if (!def || !def.single) return true;
      if (kept[c.type]) return false;
      kept[c.type] = true;
      return true;
    });
    return l;
  }
  Terminal.migrate = migrate;

  function save() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { state.saveTimer = null; persist(); }, 300);
  }
  function persist() {
    state.layout.version = (state.layout.version || 0) + 1;
    try { localStorage.setItem(LOCAL_KEY + state.ws, JSON.stringify(state.layout)); } catch (e) { /* fine */ }
    var ws = state.ws;
    return invoke('terminal_layout_set', { workspace: ws, layout: state.layout }).then(function (saved) {
      if (saved && saved.version != null && ws === state.ws) state.layout.version = saved.version;
    }).catch(function (e) {
      // Another window of this workspace saved first: its arrangement is the
      // one that stands. Take it rather than fight over it.
      if (/stale layout/.test(String(e)) && ws === state.ws) return reloadLayout();
      Board.stamp && Board.stamp('layout not saved: ' + e);
    });
  }
  /* Re-read this workspace from Rust and redraw — after a refused save, or
   * when another window announces one. A drag in progress is left alone. */
  function reloadLayout() {
    if (state.drag) return Promise.resolve();
    return load().then(function () { renderGrid(); });
  }
  Terminal.reloadLayout = reloadLayout;
  function listenForLayouts() {
    if (state.listening || !window.StructsEvents) return;
    state.listening = true;
    window.StructsEvents.listen('terminal-layout', function (e) {
      var p = e && e.payload;
      if (!p || p.workspace !== state.ws) return;
      if (Number(p.version) === Number(state.layout.version || 0)) return;
      reloadLayout();
    });
    // Another window activated, deleted, renamed or re-ordered a workspace.
    // Take the list; if the one shown here is gone, go to the active one —
    // a save from a stale window would otherwise recreate it.
    window.StructsEvents.listen('terminal-workspaces', function (e) {
      var p = e && e.payload;
      if (!p || !Array.isArray(p.names) || !p.names.length) return;
      state.workspaces = p.names;
      state.active = p.active || p.names[0];
      /* Gone means gone: not in the list AND not the one Rust calls active.
       * A name being made is active before it is listed. */
      if (p.names.indexOf(state.ws) < 0 && p.active !== state.ws) {
        if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
        state.ws = null;
        switchWorkspace(state.active);
      } else if (!state.solo) {
        renderAll();
      }
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
    /* Registered in Rust BEFORE it is switched to: an activate for a name the
     * store has never seen announced a list without it, and this page read
     * its own new workspace as deleted (see the listener below). An empty
     * layout under the name first; the switch then finds it. */
    var fresh = state.workspaces.indexOf(clean) < 0;
    if (fresh) state.workspaces.push(clean);
    var register = fresh ? invoke('terminal_layout_set', { workspace: clean, layout: { version: 0, cards: [] } }).catch(function () {}) : Promise.resolve();
    return register.then(function () { return switchWorkspace(clean); }).then(function () { return persist(); });
  }
  Terminal.createWorkspace = createWorkspace;

  function deleteWorkspace(name) {
    return invoke('terminal_workspace_delete', { name: name }).then(function (w) {
      state.workspaces = (w && w.names) || state.workspaces.filter(function (n) { return n !== name; });
      state.active = (w && w.active) || state.workspaces[0];
      // Its own window and its popped cards go with it.
      invoke('terminal_workspace_windows_close', { name: name }).catch(function () {});
      if (state.ws === name) return switchWorkspace(state.active);
      renderAll();
    }).catch(function (e) { Board.stamp && Board.stamp(String(e)); });
  }
  Terminal.deleteWorkspace = deleteWorkspace;

  // A delete is the one door on the strip that cannot be undone: it asks
  // first, naming the workspace and how many cards it holds.
  function confirmDeleteWorkspace(name) {
    var n = state.ws === name ? state.layout.cards.length : null;
    var body = H.el('div', 'sui-text-label-block', name + (n != null ? ' · ' + n + ' card' + (n === 1 ? '' : 's') : ''));
    H.confirmModal('Delete this workspace?', body, 'Delete', function () { deleteWorkspace(name); });
  }

  // Rename: the layout, the active mark and any remembered windows follow the
  // new name. Open windows for the old name are closed first — they carry the
  // old label — and the player reopens what they want under the new one.
  function renameWorkspace(from, to) {
    var clean = String(to || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!clean || clean === from) return Promise.resolve(false);
    if (state.workspaces.indexOf(clean) >= 0) { Board.stamp && Board.stamp('a workspace named ' + clean + ' already exists'); return Promise.resolve(false); }
    return Terminal.flushSave().then(function () {
      return invoke('terminal_workspace_windows_close', { name: from }).catch(function () {});
    }).then(function () {
      return invoke('terminal_workspace_rename', { from: from, to: clean });
    }).then(function (w) {
      state.workspaces = (w && w.names) || state.workspaces.map(function (n) { return n === from ? clean : n; });
      state.active = (w && w.active) || state.active;
      if (state.ws === from) state.ws = clean;
      try { localStorage.setItem(LOCAL_KEY + clean, JSON.stringify(state.layout)); localStorage.removeItem(LOCAL_KEY + from); } catch (e) { /* fine */ }
      renderAll();
      return true;
    }).catch(function (e) { Board.stamp && Board.stamp(String(e)); return false; });
  }
  Terminal.renameWorkspace = renameWorkspace;

  // The strip's order is the player's: nudge the current workspace left or
  // right; Rust keeps the arrangement so every window and the next launch
  // agree on it.
  function moveWorkspace(name, dir) {
    var i = state.workspaces.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= state.workspaces.length) return Promise.resolve(false);
    var t = state.workspaces[i]; state.workspaces[i] = state.workspaces[j]; state.workspaces[j] = t;
    renderAll();
    return invoke('terminal_workspace_order', { names: state.workspaces.slice() }).then(function (w) {
      if (w && Array.isArray(w.names) && w.names.length) state.workspaces = w.names;
      return true;
    }).catch(function (e) { Board.stamp && Board.stamp('order not saved: ' + e); return false; });
  }
  Terminal.moveWorkspace = moveWorkspace;
  // Drop a workspace before or after another one (or last, with no target).
  function dropWorkspace(name, targetName, after) {
    var list = state.workspaces.filter(function (n) { return n !== name; });
    if (state.workspaces.indexOf(name) < 0) return Promise.resolve(false);
    var at = targetName ? list.indexOf(targetName) : -1;
    if (targetName && at < 0) return Promise.resolve(false);
    if (!targetName) list.push(name); else list.splice(after ? at + 1 : at, 0, name);
    if (list.join(',') === state.workspaces.join(',')) return Promise.resolve(false);
    state.workspaces = list;
    renderAll();
    return invoke('terminal_workspace_order', { names: state.workspaces.slice() }).then(function (w) {
      if (w && Array.isArray(w.names) && w.names.length) state.workspaces = w.names;
      return true;
    }).catch(function (e) { Board.stamp && Board.stamp('order not saved: ' + e); return false; });
  }
  Terminal.dropWorkspace = dropWorkspace;
  // Drag a workspace tab along the strip — the same pointer-event drag the
  // cards use, so any synthetic mouse (and the tests) can drive it.
  function wireWorkspaceDrag(nav) {
    var tabs = Array.prototype.slice.call(nav.querySelectorAll('.sui-screen-nav-item'));
    var names = state.workspaces;
    tabs.forEach(function (tab, i) {
      var name = names[i];
      if (name == null) return; // the '+' door
      tab.setAttribute('data-ws', name);
      tab.title = 'Drag to move';
      tab.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        var sx = ev.clientX, live = false, target = null, after = false;
        var onMove = function (e) {
          if (!live) { if (Math.abs(e.clientX - sx) < 4) return; live = true; tab.classList.add('tm-dragging'); }
          e.preventDefault();
          var hit = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
          var over = hit && hit.closest ? hit.closest('[data-ws]') : null;
          tabs.forEach(function (t) { t.classList.remove('tm-drop-before', 'tm-drop-after'); });
          if (over && over !== tab) {
            var r = over.getBoundingClientRect();
            after = r.width > 0 ? (e.clientX - r.left) > r.width / 2 : true;
            target = over.getAttribute('data-ws');
            over.classList.add(after ? 'tm-drop-after' : 'tm-drop-before');
          } else { target = null; }
        };
        var onUp = function () {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          tabs.forEach(function (t) { t.classList.remove('tm-drop-before', 'tm-drop-after', 'tm-dragging'); });
          if (!live) return;
          if (target) dropWorkspace(name, target, after);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });
  }
  function renameRow(strip) {
    var old = strip.querySelector('#tm-ws-rename');
    if (old) { old.parentNode.removeChild(old); return; }
    var row = H.el('span', 'tm-share'); row.id = 'tm-ws-rename';
    var box = H.textBox(state.ws, 'name', function () {});
    box.id = 'tm-ws-rename-name';
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { row.parentNode.removeChild(row); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      renameWorkspace(state.ws, box.value).then(function (ok) { if (!ok) box.classList.add('is-err'); });
    });
    box.addEventListener('input', function () { box.classList.remove('is-err'); });
    row.appendChild(box);
    var go = H.el('a', 'sui-screen-btn sui-mod-primary', 'Rename');
    go.href = 'javascript:void(0)';
    go.addEventListener('click', function () { renameWorkspace(state.ws, box.value).then(function (ok) { if (!ok) box.classList.add('is-err'); }); });
    row.appendChild(go);
    strip.appendChild(row);
    box.focus();
    box.select();
  }

  // ── The card frame: the game's data card, doors in its header ───────────
  // The player's own name for a card, else the type's description of it.
  function titleOf(card) {
    var def = TYPES[card.type];
    if (card.title) return card.title;
    return def ? def.describe(card.params || {}) : card.type;
  }
  Terminal.titleOf = titleOf;
  // Refresh cadence in ms for a card: the player's choice, else the type's;
  // 0 means paused. A paused card says so on its frame and its refresh door.
  var CADENCES = [{ value: '', label: 'Auto' }, { value: '5', label: '5s' }, { value: '15', label: '15s' }, { value: '60', label: '1m' }, { value: '300', label: '5m' }, { value: '0', label: 'Paused' }];
  function cadenceOf(card) {
    var def = TYPES[card.type];
    if (card.cadence != null) return Number(card.cadence) * 1000;
    return def && def.cadenceMs ? def.cadenceMs : 0;
  }
  Terminal.cadenceOf = function (id) { var c = findCard(id); return c ? cadenceOf(c) : 0; };
  function markCadence(node, card) {
    var paused = card.cadence != null && Number(card.cadence) === 0;
    node.classList.toggle('tm-paused', paused);
    var t = node.querySelector('.tm-title');
    if (t) t.title = paused ? 'Paused' : '';
  }

  function door(iconName, title, onClick) {
    var a = H.el('a', 'tm-door');
    a.href = 'javascript:void(0)';
    a.title = title;
    a.appendChild(H.el('i', iconName + ' sui-icon-sm'));
    a.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); onClick(ev); });
    return a;
  }

  // A card is the game's own panel (chat.html builds the Comms window from
  // the same pieces): panel edges and chunk, a screen whose nav is the
  // header — the title as the active nav tab, the doors where the window's
  // icons go — and a screen whose page body holds the card.
  var FRAME_CLS = 'sui-panel sui-theme-player tm-card';
  // A frameless type (a whole page as a card) keeps that mark through every
  // redraw, resize and width change — these all rewrite the class list.
  /* ── How much room a card may take ───────────────────────────────────────
   *
   * A CAP, not a floor: a card with less to say still takes only what it
   * needs, and `grow` lifts the cap so the card is as tall as its content.
   * `tall` is what every card did before this existed, so it is the default
   * and no saved layout changes shape.
   */
  var HEIGHTS = [
    { value: '', label: 'Tall' },
    { value: 'short', label: 'Short' },
    { value: 'medium', label: 'Medium' },
    { value: 'grow', label: 'Grower' },
  ];
  function heightOf(card) {
    var h = card && card.h;
    if (h) return h;
    var def = card && TYPES[card.type];
    return (def && def.defaultHeight) || 'tall';
  }
  Terminal.heightOf = function (id) { var c = findCard(id); return c ? heightOf(c) : 'tall'; };
  function frameClass(w, extra, def, h) {
    return FRAME_CLS + ' tm-w' + w + ' tm-h-' + (h || 'tall') + (extra || '') + (def && def.frameless ? ' tm-frameless' : '');
  }
  /* ── Reaching the part of the board you cannot see ──────────────────────
   *
   * A board taller than the window could not be rearranged past one screen:
   * you picked a card up at the bottom, ran out of pixels, and there was
   * nowhere left to drag to. Every mature sortable solves this the same way
   * and ours did not — SortableJS's scroll plugin, react-beautiful-dnd's
   * "fluid scroller", dnd-kit's auto-scroll activator are all one idea: a band
   * along each edge of the scroller which, while the pointer is inside it,
   * scrolls on every frame.
   *
   * The speed is squared over the band rather than linear, which is the part
   * worth stealing. A linear ramp reads as one speed — you either creep the
   * whole way or you overshoot — while a squared one is gentle where you are
   * still choosing and fast where you have clearly asked to travel.
   */
  var SCROLL_EDGE = 72;  // px of each edge that scrolls
  var SCROLL_MAX = 24;   // px per frame hard against the edge
  function scrollerOf(node) {
    for (var n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentNode) {
      var cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return document.scrollingElement || document.documentElement;
  }
  /* Scrolls toward `y` every frame while it sits in an edge band, and calls
   * `step` whenever it actually moved: the board slid under a pointer that
   * never moved, so what it is over now is a different landing spot. */
  function autoScroller(node) {
    var box = scrollerOf(node), raf = 0, at = null, step = null;
    var page = box === document.scrollingElement || box === document.documentElement;
    function speed(d) { var t = 1 - Math.max(0, d) / SCROLL_EDGE; return Math.max(1, Math.round(SCROLL_MAX * t * t)); }
    function frame() {
      raf = 0;
      if (at == null) return;
      var r = page ? { top: 0, bottom: window.innerHeight } : box.getBoundingClientRect();
      var dy = 0;
      if (at - r.top < SCROLL_EDGE) dy = -speed(at - r.top);
      else if (r.bottom - at < SCROLL_EDGE) dy = speed(r.bottom - at);
      if (dy) {
        var was = box.scrollTop;
        box.scrollTop += dy;
        if (box.scrollTop !== was && step) step();
      }
      raf = requestAnimationFrame(frame);
    }
    return {
      to: function (y, onStep) {
        at = y; step = onStep;
        if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
      },
      stop: function () { if (raf) cancelAnimationFrame(raf); raf = 0; at = null; step = null; },
    };
  }
  /* Before or after the card you are over, in READING order.
   *
   * The old rule was the horizontal midpoint alone, which is right for two
   * cards side by side and wrong for a full-width or a grown one: dragging to
   * the bottom edge of a tall card meaning "below this" landed above it
   * whenever the pointer happened to be on its left half. So the vertical
   * decides once the card is tall enough for "below" to mean anything, and
   * the horizontal decides otherwise. */
  var ROW_SLOP = 48;
  function landsAfter(r, x, y) {
    var cy = r.top + r.height / 2;
    if (y > cy + ROW_SLOP) return true;
    if (y < cy - ROW_SLOP) return false;
    return r.width > 0 ? x > r.left + r.width / 2 : true;
  }

  function frame(card) {
    var def = TYPES[card.type];
    var node = H.el('div', frameClass(card.w || 1, '', def, heightOf(card)));
    node.id = 'tm-' + card.id;
    node.setAttribute('data-card', card.id);
    node.setAttribute('data-type', card.type);
    node.appendChild(H.el('div', 'sui-panel-top-fill-background'));
    node.appendChild(H.el('div', 'sui-panel-bottom-fill-background'));
    node.appendChild(H.el('div', 'sui-panel-edge-left'));
    var chunk = H.el('div', 'sui-panel-chunk sui-mod-grow sui-mod-shrink tm-chunk');
    node.appendChild(chunk);
    node.appendChild(H.el('div', 'sui-panel-edge-right'));
    var headScreen = H.el('div', 'sui-screen sui-screen-full-width tm-head-screen');
    var head = H.el('div', 'sui-screen-nav tm-head');
    var titles = H.el('div', 'sui-screen-nav-items');
    var title = H.el('span', 'sui-screen-nav-item sui-mod-header sui-mod-active tm-title', titleOf(card));
    titles.appendChild(title);
    head.appendChild(titles);
    /* How old is what you are looking at?
     *
     * Every card here refreshes on a cadence, and until now nothing said when
     * it last did. A number with no age is a number you cannot act on: a board
     * that lost its connection five minutes ago looks exactly like one that
     * updated a second ago. This is the whole reason to trust the screen. */
    var age = H.el('span', 'tm-age fstat-l');
    head.appendChild(age);
    headScreen.appendChild(head);
    var doors = H.el('span', 'tm-doors');
    var own = def && def.doors ? def.doors(card, { get body() { var m = state.mounted[card.id]; return m ? m.body : null; } }) : [];
    (own || []).forEach(function (d) { var a = door(d.icon, d.title, d.onClick); a.classList.add('tm-door-own'); doors.appendChild(a); });
    // No refresh door: cards refresh on their cadence. No up/down: the
    // header drags, and dropping on another card or the floor places it.
    markCadence(node, card);
    if (!state.solo) {
      // Every card configures: its name, its refresh cadence and its width,
      // plus whatever params the type declares.
      doors.appendChild(door('icon-menu', 'Configure', function () { toggleConfig(card.id); }));
      doors.appendChild(door('icon-link-out', 'Pop out', function () { popOut(card.id); }));
      doors.appendChild(door('icon-close', 'Remove', function () { remove(card.id); }));
      // Drag the header to move the card; drop on another card to land
      // before or after it, or on the grid floor to go last. Pointer events,
      // not HTML5 drag-and-drop: they behave the same in WebKit and Chromium,
      // need no ghost image, and can be driven by any synthetic mouse — which
      // is also how the tests reach them.
      head.title = 'Drag to move · alt+← → to step, alt+home/end to send';
      head.tabIndex = 0;
      head.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0 || (ev.target.closest && ev.target.closest('.tm-door'))) return;
        var sx = ev.clientX, sy = ev.clientY, live = false, target = null, after = false;
        var ghost = null, chip = null, scroll = null, at = { x: sx, y: sy };
        /* Where would it land from where the pointer is now? Split out of the
         * move handler because the autoscroller has to ask the same question
         * with the pointer standing still — the board moved, not the hand. */
        var place = function () {
          var hit = document.elementFromPoint ? document.elementFromPoint(at.x, at.y) : null;
          var over = hit && hit.closest ? hit.closest('.tm-card') : null;
          if (over && over !== node) {
            after = landsAfter(over.getBoundingClientRect(), at.x, at.y);
            target = over.getAttribute('data-card');
            if (ghost) over.parentNode.insertBefore(ghost, after ? over.nextSibling : over);
          } else {
            target = null;
            var grid0 = document.getElementById('tm-grid');
            // Over the floor: it lands last, and the silhouette says so.
            if (ghost && grid0 && hit && (hit === grid0 || grid0.contains(hit))) grid0.appendChild(ghost);
          }
        };
        var onMove = function (e) {
          if (!live) {
            if (Math.abs(e.clientX - sx) < 4 && Math.abs(e.clientY - sy) < 4) return;
            live = true;
            state.drag = card.id;
            // The card leaves the flow and a silhouette of exactly its size
            // stands in its place, so the other cards move aside as you go and
            // the landing spot is the shape you are about to fill — an edge
            // mark on a neighbour only said "near here".
            ghost = H.el('div', 'tm-ghost tm-w' + (state.solo ? 3 : (card.w || 1)));
            ghost.style.gridRowEnd = node.style.gridRowEnd || '';
            node.parentNode.insertBefore(ghost, node);
            node.classList.add('tm-dragging');
            node.hidden = true;
            /* Once the board scrolls, the card you are carrying is usually off
             * screen and the silhouette is the only thing left saying what is
             * in your hand — and on a long board it is somewhere else again.
             * The name rides the cursor so the answer is always under it. */
            chip = H.el('div', 'tm-drag-chip sui-text-label', titleOf(card));
            document.body.appendChild(chip);
            scroll = autoScroller(node);
            /* An iframe eats pointer events: the Comms and Pay cards are whole
             * documents, and dragging across one stopped the drag dead — no
             * more moves, and `elementFromPoint` answering the frame instead of
             * the card under it. Capture routes every move back here whatever
             * it crosses; the CSS shield keeps the hit test honest. */
            if (head.setPointerCapture) { try { head.setPointerCapture(ev.pointerId); } catch (err) { /* not captureable */ } }
            // A press that becomes a drag has usually already begun selecting
            // the header's text; without this the selection drags along.
            document.body.classList.add('tm-dragging-cards');
            var sel = window.getSelection && window.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
          }
          e.preventDefault();
          at = { x: e.clientX, y: e.clientY };
          if (chip) { chip.style.left = at.x + 'px'; chip.style.top = at.y + 'px'; }
          place();
          if (scroll) scroll.to(at.y, place);
        };
        var finish = function () {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          if (scroll) scroll.stop();
          scroll = null;
          if (head.releasePointerCapture && head.hasPointerCapture && head.hasPointerCapture(ev.pointerId)) {
            try { head.releasePointerCapture(ev.pointerId); } catch (err) { /* already gone */ }
          }
          document.body.classList.remove('tm-dragging-cards');
          node.hidden = false;
          node.classList.remove('tm-dragging');
          if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
          if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
          ghost = null;
          chip = null;
        };
        var onUp = function (e) {
          var wasLive = live;
          var grid = document.getElementById('tm-grid');
          var hit = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
          var onFloor = grid && hit && (hit === grid || grid.contains(hit));
          finish();
          if (!wasLive) return;
          if (target) dropOn(card.id, target, after);
          else if (onFloor) dropOn(card.id, null, true);
          else { state.drag = null; clearDrop(); }
        };
        /* Escape puts it back. A drag you cannot abandon has to be finished
         * somewhere, and "somewhere" on a board you have scrolled away from is
         * a guess — so the way out is the one every drag surface offers. */
        var onKey = function (e) {
          if (e.key !== 'Escape' || !live) return;
          e.preventDefault();
          window.removeEventListener('keydown', onKey);
          target = null;
          finish();
          state.drag = null;
          clearDrop();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.addEventListener('keydown', onKey);
        var stopKey = function () { window.removeEventListener('keydown', onKey); };
        window.addEventListener('pointerup', stopKey, { once: true });
        window.addEventListener('pointercancel', stopKey, { once: true });
      });
      /* Dragging is not the only way to move a card, and on a long board it is
       * the worst one: to send a card from the bottom to the top you have to
       * hold a button down through the whole journey. Alt+arrows step it past
       * a neighbour, alt+home/end send it the whole way, and the card that
       * moved keeps focus and scrolls itself into view so you can see it land
       * and press again. */
      head.addEventListener('keydown', function (e) {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        var cards = state.layout.cards;
        var i = cards.map(function (c) { return c.id; }).indexOf(card.id);
        if (i < 0) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (i === 0) return; move(card.id, -1); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (i >= cards.length - 1) return; move(card.id, 1); }
        else if (e.key === 'Home') { if (i === 0) return; dropOn(card.id, cards[0].id, false); }
        else if (e.key === 'End') { if (i >= cards.length - 1) return; dropOn(card.id, null, true); }
        else return;
        e.preventDefault();
        focusHead(card.id);
      });
      // The header carries a title and doors, both of which the browser will
      // happily drag as content of their own.
      head.addEventListener('dragstart', function (e) { e.preventDefault(); });
      // Drag the right edge to change the width, one column at a time.
      var grip = H.el('span', 'tm-resize');
      grip.title = 'Drag to resize';
      grip.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        var grid = document.getElementById('tm-grid');
        var col = grid ? columnWidth(grid) : 0;
        if (!col) return;
        var start = node.getBoundingClientRect().left;
        var onMove = function (e) { resizeTo(card.id, Math.round((e.clientX - start) / col), true); };
        var onUp = function (e) { resizeTo(card.id, Math.round((e.clientX - start) / col), false); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      node.appendChild(grip);
    }
    head.appendChild(doors);
    chunk.appendChild(headScreen);
    var config = H.el('div', 'tm-config');
    config.hidden = true;
    chunk.appendChild(config);
    var bodyScreen = H.el('div', 'sui-screen sui-screen-full-width sui-screen-shrink tm-body-screen');
    var body = H.el('div', 'sui-page-body-screen tm-body');
    bodyScreen.appendChild(body);
    chunk.appendChild(bodyScreen);
    return { node: node, body: body, config: config, title: title, age: age };
  }

  // ── Moving and sizing by hand ──────────────────────────────────────────
  function clearDrop() {
    document.querySelectorAll('.tm-drop-before, .tm-drop-after').forEach(function (n) { n.classList.remove('tm-drop-before', 'tm-drop-after'); });
  }
  /* Put `id` before or after `targetId` in the layout (no target: last). */
  function dropOn(id, targetId, after) {
    clearDrop();
    state.drag = null;
    var cards = state.layout.cards;
    var from = cards.map(function (c) { return c.id; }).indexOf(id);
    if (from < 0) return;
    var moving = cards.splice(from, 1)[0];
    var to = targetId ? cards.map(function (c) { return c.id; }).indexOf(targetId) : cards.length;
    if (to < 0) to = cards.length; else if (after) to += 1;
    cards.splice(to, 0, moving);
    save();
    renderGrid();
  }
  Terminal.dropOn = dropOn;
  /* Both moves re-render the grid, which throws away the node you pressed the
   * key on. Focus has to be put back on the card that moved, not left on the
   * body — otherwise the second press goes nowhere and a keyboard move is a
   * one-shot. `block: 'nearest'` because the card is usually already visible
   * and yanking the board to centre it loses your place. */
  function focusHead(id) {
    var n = document.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-head');
    if (!n) return;
    if (n.focus) n.focus();
    if (n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
  }
  function columnWidth(grid) {
    var cols = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat).filter(isFinite);
    if (!cols.length) return 0;
    var gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    return cols[0] + gap;
  }
  /* Width by drag: preview while the pointer moves, commit on release. */
  function resizeTo(id, w, preview) {
    var c = findCard(id), m = state.mounted[id];
    if (!c || !m) return;
    w = Math.max(1, Math.min(3, w || 1));
    m.node.className = frameClass(w, preview ? ' tm-resizing' : '', m.def, Terminal.heightOf(id));
    if (!preview && w !== c.w) { c.w = w; save(); }
    fitRows(m);
  }
  Terminal.resizeTo = resizeTo;

  // ── Dense packing ──────────────────────────────────────────────────────
  // The grid's rows are 1px tall with no row gap; each card spans its
  // measured height plus one gap, so cards of different heights pack without
  // the holes a row-aligned grid leaves under the short ones. Measured, never
  // guessed: a ResizeObserver on each card re-fits it when its content changes.
  // Rows are 1px (row-gap 0), so a card spans its own height plus the gap it
  // leaves below (--spacing-md, 8px). ROW_GAP must match that token.
  var ROW_GAP = 8;
  function fitRows(m) {
    if (!m || !m.node || !m.node.isConnected) return;
    /* A window holding ONE card has nothing to pack, and the span is what
       stopped it filling that window: a measured `grid-row-end: span 4429`
       over 1px rows made the card exactly as tall as its content, so a short
       card drew its bottom border a third of the way down and a long one ran
       off the bottom. Solo, the card takes the grid's single row. */
    if (state.solo) {
      if (m.span != null) { m.span = null; m.node.style.gridRowEnd = ''; }
      return;
    }
    var h = m.node.getBoundingClientRect().height;
    if (!h) return;
    var span = Math.max(1, Math.ceil(h) + ROW_GAP);
    if (m.span !== span) { m.span = span; m.node.style.gridRowEnd = 'span ' + span; }
  }
  Terminal.fitRows = fitRows;
  function watchSize(m) {
    if (typeof ResizeObserver === 'undefined') return;
    m.ro = new ResizeObserver(function () { fitRows(m); });
    m.ro.observe(m.body);
    if (m.config) m.ro.observe(m.config);
  }

  // ── Card operations ─────────────────────────────────────────────────────
  function findCard(id) {
    for (var i = 0; i < state.layout.cards.length; i++) if (state.layout.cards[i].id === id) return state.layout.cards[i];
    return null;
  }

  function add(type, params, w) {
    var def = TYPES[type];
    if (!def) return null;
    /* ── A popped-out card IS its window ───────────────────────────────────
     *
     * There is no grid beside it to put a second card in: `renderGrid` filters
     * to the solo card, so an added card mounted NOWHERE and the door looked
     * dead. Worse, `save()` still wrote it into the workspace — so every click
     * of Tearsheet or Guild token in a card window left another stray card in
     * the Terminal for the player to find later.
     *
     * The only place a second card can go from here is another window, which
     * is exactly what the palette over the game already does. Every door in
     * the app goes through this one function, so all of them get it at once
     * rather than being audited one at a time. */
    if (state.solo) return Terminal.openInWindow(type, params);
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
    if (m.def && m.def.unmount) { try { m.def.unmount(m.body, m.params, { id: id }); } catch (e) { /* a card must not take the page down */ } }
    if (m.def && m.def.frameless) dropFrameSubs(m.body);
    if (m.ro) { try { m.ro.disconnect(); } catch (e) { /* fine */ } }
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

  function setHeight(id, h) {
    var c = findCard(id);
    if (!c) return;
    var ok = HEIGHTS.some(function (o) { return o.value === h; });
    if (!ok || !h) delete c.h; else c.h = h;
    var m = state.mounted[id];
    if (m) {
      m.node.className = frameClass(state.solo ? 3 : (c.w || 1), '', m.def, heightOf(c));
      fitRows(m);
    }
    save();
  }
  Terminal.setHeight = setHeight;

  function setWidth(id, w) {
    var c = findCard(id);
    if (!c) return;
    c.w = Math.max(1, Math.min(3, Number(w) || 1));
    var m = state.mounted[id];
    if (m) m.node.className = frameClass(c.w, '', m.def, heightOf(c));
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
      m.title.textContent = titleOf(c);
      refresh(id, true);
    }
  }

  function setTitle(id, title) {
    var c = findCard(id);
    if (!c) return;
    var t = String(title || '').trim();
    if (t) c.title = t; else delete c.title;
    var m = state.mounted[id];
    if (m) m.title.textContent = titleOf(c);
    save();
  }
  Terminal.setParams = setParams;
  Terminal.setTitle = setTitle;
  /* The title a card learns AFTER it has drawn — not the one a player typed.
   *
   * `describe()` runs once, from the params, before anything has been fetched:
   * a ROOM card knows `!snc:h` and not "SN.Corporation" until the room list
   * lands. `setTitle` is the wrong tool for that — it persists, so a name the
   * card discovered would become a name the player had chosen and would then
   * never update again. This only repaints. */
  Terminal.retitle = function (id, text) {
    var m = state.mounted[id];
    var c = findCard(id);
    if (!m || !m.title || !text || (c && c.title)) return;
    m.title.textContent = text;
  };
  /* The doors a card learns AFTER it has drawn. `def.doors(card)` runs once,
   * when the header is built — for a ROOM card that is before the room list
   * has landed, so `roomById` answered null and the header had no Who, no
   * Mute, no Leave; popped out (where the header is built exactly once) it
   * never got them. Rebuilt from the same function, in the same place. */
  function redoors(id) {
    var m = state.mounted[id];
    var c = findCard(id);
    if (!m || !c) return;
    var def = TYPES[c.type];
    var span = m.node.querySelector('.tm-doors');
    if (!span) return;
    Array.prototype.slice.call(span.querySelectorAll('.tm-door-own')).forEach(function (a) { span.removeChild(a); });
    var own = def && def.doors ? def.doors(c, { get body() { return m.body; } }) : [];
    var first = span.firstChild;
    (own || []).forEach(function (d) { var a = door(d.icon, d.title, d.onClick); a.classList.add('tm-door-own'); span.insertBefore(a, first); });
  }
  Terminal.redoors = redoors;
  /* Params a card learns after it has drawn — the room id behind the name
   * that was typed. Unlike `setParams` this does NOT redraw (the card is the
   * one telling us, mid-draw); it persists, so the next launch resolves the
   * id rather than a name that may since have changed, and the doors are
   * rebuilt from what is now known. */
  Terminal.learnParams = function (id, params) {
    var c = findCard(id);
    if (!c) return;
    c.params = params;
    var m = state.mounted[id];
    if (m) m.params = params;
    save();
    redoors(id);
  };
  function setCadence(id, secs) {
    var c = findCard(id);
    if (!c) return;
    if (secs === '' || secs == null) delete c.cadence; else c.cadence = Math.max(0, Number(secs) || 0);
    var m = state.mounted[id];
    if (m) markCadence(m.node, c);
    save();
  }
  Terminal.setCadence = setCadence;

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

  // Shared with board-terminal-ops.js, whose tickets read the same controls.
  Terminal.readControl = readControl;

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
    var name = H.textBox(c.title || '', m.def ? m.def.describe(c.params || {}) : c.type, function () {});
    name.classList.add('tm-config-name');
    m.config.appendChild(H.field('Name', name));
    var cadence = H.selectBox(c.cadence == null ? '' : String(c.cadence), CADENCES, function () {});
    cadence.classList.add('tm-config-cadence');
    m.config.appendChild(H.field('Refresh', cadence));
    var width = H.selectBox(String(c.w || 1), [{ value: '1', label: 'Narrow' }, { value: '2', label: 'Wide' }, { value: '3', label: 'Full' }], function () {});
    width.classList.add('tm-config-width');
    m.config.appendChild(H.field('Width', width));
    var height = H.selectBox(c.h || '', HEIGHTS, function () {});
    height.classList.add('tm-config-height');
    m.config.appendChild(H.field('Height', height));
    var apply = H.el('a', 'sui-screen-btn sui-mod-primary', 'Apply');
    apply.href = 'javascript:void(0)';
    apply.addEventListener('click', function () {
      var params = {};
      Object.keys(inputs).forEach(function (k) { params[k] = readControl(inputs[k]); });
      setWidth(id, readControl(width));
      setHeight(id, readControl(height));
      setTitle(id, readControl(name));
      setCadence(id, readControl(cadence));
      setParams(id, params);
      m.config.hidden = true;
    });
    m.config.appendChild(apply);
    m.config.hidden = false;
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  /* ── The chain's own clock ───────────────────────────────────────────────
   *
   * Every card here dates itself against when WE last read (`paintAge`). That
   * is only half the question: a card can honestly say "now" while the thing
   * it read from has not heard from the chain in ten minutes. Structs is
   * block-paced — raids resolve in minutes, agreements expire at a height,
   * proofs decay with anchor age — so the height, and whether it is still
   * moving, is the one reading that says whether ANY of this is real.
   *
   * The source is the chain's own heartbeat: the GRASS `block` frame, which
   * carries `{height}` and arrives every few seconds. No poll of our own —
   * and if it stops arriving, that silence IS the signal.
   */
  var CLOCK_QUIET_MS = 45000;
  var clockState = { height: null, atMs: 0, listening: false, el: null };
  function mountClock(host) {
    if (!host) return;
    var old = document.getElementById('tm-clock');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var el = H.el('span', 'tm-clock fstat-l');
    el.id = 'tm-clock';
    host.insertBefore(el, host.firstChild);
    clockState.el = el;
    if (!clockState.listening && window.StructsEvents) {
      clockState.listening = true;
      window.StructsEvents.listen('grass-event', function (e) {
        var ev = e && e.payload;
        if (!ev || String(ev.category) !== 'block') return;
        var d = ev.detail;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { d = null; } }
        var h = d && Number(d.height);
        if (!isFinite(h) || !h) return;
        clockState.height = h;
        clockState.atMs = Date.now();
        paintClock();
      });
    }
    paintClock();
  }
  function paintClock() {
    var el = clockState.el;
    if (!el || !el.parentNode) return;
    if (!clockState.height) {
      el.textContent = 'no block';
      el.title = 'No block has arrived since this window opened — every reading below is as old as its own card says, and possibly older';
      el.className = 'tm-clock fstat-l tm-clock-quiet';
      return;
    }
    var since = Date.now() - clockState.atMs;
    var quiet = since > CLOCK_QUIET_MS;
    el.textContent = H.fmtInt(clockState.height);
    el.className = 'tm-clock fstat-l' + (quiet ? ' tm-clock-quiet' : '');
    el.title = quiet
      ? 'Block ' + H.fmtInt(clockState.height) + ' — nothing since ' + window.StructsUnits.fmtDuration(Math.round(since / 1000)) + ' ago. The chain feed is quiet, so nothing on this page is being kept up to date.'
      : 'Block ' + H.fmtInt(clockState.height) + ', ' + window.StructsUnits.fmtDuration(Math.round(since / 1000), { empty: 'just now' }) + ' ago';
  }
  Terminal.paintClock = paintClock;
  Terminal.clockState = clockState;

  /* The age of what is on screen, and whether it is still arriving.
   *
   * `fresh` while the last good read is within its own cadence, `late` past
   * it, `stale` once a refresh has actually failed — and stale keeps showing
   * the AGE OF THE GOOD DATA, not the age of the failure, because that is the
   * question ("how old is this number?"). A card that refreshes by hand only
   * still ages; it just never becomes late.
   */
  function paintAge(id) {
    var m = state.mounted[id];
    if (!m || !m.age) return;
    if (!m.lastOk) { m.age.textContent = ''; m.node.classList.remove('tm-stale', 'tm-late'); return; }
    var secs = Math.max(0, Math.round((Date.now() - m.lastOk) / 1000));
    m.age.textContent = secs < 5 ? 'now' : window.StructsUnits.fmtDuration(secs, { empty: '' });
    var c = findCard(id);
    var every = c ? cadenceOf(c) : ((m.def && m.def.cadenceMs) || 0);
    var late = !!every && Date.now() - m.lastOk > every * 2;
    m.node.classList.toggle('tm-stale', !!m.lastErr);
    m.node.classList.toggle('tm-late', late && !m.lastErr);
    m.age.title = m.lastErr
      ? 'Last good read ' + m.age.textContent + ' ago — the refresh since then failed: ' + m.lastErr
      : 'Read ' + m.age.textContent + ' ago';
  }
  Terminal.paintAge = paintAge;

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
      fitRows(m);
      // One header per card, the frame's: content that arrives as a titled
      // SUI card gives its own header up and the frame's title takes its name.
      var first = m.body.firstElementChild;
      if (first && first.classList && first.classList.contains('sui-data-card')) {
        var inner = first.querySelector(':scope > .sui-data-card-header');
        if (inner) { var own = findCard(id); if (inner.textContent.trim() && !(own && own.title)) m.title.textContent = inner.textContent.trim(); inner.parentNode.removeChild(inner); }
        // Its header is gone, but its BODY still drew a frame inside this
        // card's frame — a box in a box around one surface.
        first.classList.add('tm-unwrapped');
      }
      m.lastOk = Date.now();
      m.lastErr = null;
    }).catch(function (e) {
      /* A failed refresh must not ERASE the last good answer.
       *
       * Wiping the card and printing the error threw away the only data the
       * operator had — a stale reading you can see and date beats a blank you
       * cannot. So the content stays and the card goes visibly stale, with
       * what went wrong on hover. A card that has never rendered has nothing
       * to keep, and there the error IS the content. */
      m.lastErr = String((e && e.message) || e);
      if (!m.rendered) {
        m.body.innerHTML = '';
        m.body.appendChild(H.stateBlock('error', m.lastErr));
      }
    }).then(function () { m.busy = false; paintAge(id); });
  }
  Terminal.refresh = refresh;

  function mount(card, grid) {
    var def = TYPES[card.type];
    var f = frame(card);
    if (!def) f.body.appendChild(H.stateBlock('error', 'Unknown card type: ' + card.type));
    grid.appendChild(f.node);
    state.mounted[card.id] = { node: f.node, body: f.body, config: f.config, title: f.title, age: f.age, def: def, params: card.params || {}, lastRun: 0, lastOk: 0, lastErr: null, rendered: false };
    watchSize(state.mounted[card.id]);
    if (def) refresh(card.id, true);
  }

  /* The one card a pop-out window is for — and its SUCCESSOR when that exact
   * card is gone.
   *
   * A window is pinned to a card ID, and a migration can retire the id under
   * it: the Comms rebuild renamed `chat` → `comms`, and both rebuilds collapse
   * duplicates of a card that is one-per-window. A window open on the second
   * of three feeds then came back as "This card is no longer on the
   * workspace" — a dead window, permanently, with no way to say what it was
   * for. It was a window on THE FEED, and the feed is still there.
   *
   * So: the exact id first, then the survivor of the same TYPE — which the id
   * carries, because `newId` mints `type + '-' + n`. Only for a type that is
   * one-per-window; two `player` cards are two different players and following
   * one to the other would silently change what the window is watching. */
  function soloCards() {
    var exact = state.layout.cards.filter(function (c) { return c.id === state.solo; });
    if (exact.length) return exact;
    var type = String(state.solo || '').replace(/-\d+$/, '');
    var def = TYPES[type];
    if (!def || !def.single) return [];
    return state.layout.cards.filter(function (c) { return c.type === type; }).slice(0, 1);
  }

  function renderGrid() {
    var grid = document.getElementById('tm-grid');
    if (!grid) return;
    var want = state.solo ? soloCards() : state.layout.cards;
    // The reconcile keeps mounted cards in place; an empty-workspace note from
    // an earlier pass is not a card and would otherwise sit beside the first
    // card added after it.
    Array.prototype.slice.call(grid.children).forEach(function (n) { if (!n.classList.contains('tm-card')) grid.removeChild(n); });
    var keep = {};
    want.forEach(function (c) { keep[c.id] = 1; });
    Object.keys(state.mounted).forEach(function (id) { if (!keep[id]) unmountCard(id); });
    want.forEach(function (c, i) {
      var m = state.mounted[c.id];
      // Same id, different card (a reloaded layout, a reset): remount, or a
      // stale card would wear a new title.
      if (m && (m.def !== TYPES[c.type] || JSON.stringify(m.params || {}) !== JSON.stringify(c.params || {}))) { unmountCard(c.id); m = null; }
      if (!m) { mount(c, grid); m = state.mounted[c.id]; }
      m.node.className = frameClass(state.solo ? 3 : (c.w || 1), '', m.def, heightOf(c));
      markCadence(m.node, c);
      if (c.title) m.title.textContent = c.title;
      if (grid.children[i] !== m.node) grid.insertBefore(m.node, grid.children[i] || null);
      fitRows(m);
    });
    if (state.solo && !want.length) grid.appendChild(H.stateBlock('info', 'This card is no longer on the workspace.'));
    if (!state.solo && !want.length) grid.appendChild(H.stateBlock('info', 'An empty workspace. Add a card above, or type a command.'));
  }

  function renderAll() {
    var host = document.getElementById('terminal-body');
    if (!host) return;
    host.innerHTML = '';
    /* The palette lives on the BODY, not in this subtree, so wiping the host
     * does not take it with it. `chrome()` builds a fresh one; this is what
     * stops the old one outliving it and owning the id. */
    var stale = document.getElementById('tm-palette');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    if (!state.solo) host.appendChild(chrome());
    // `chrome()` builds the palette on its way past; a solo window has no
    // chrome, so it builds it directly. It hangs off document.body and needs
    // nothing else on the page — `?view=palette` is the proof.
    else buildPalette();
    var grid = H.el('div', 'tm-grid' + (state.solo ? ' tm-solo' : ''));
    grid.id = 'tm-grid';
    grid.addEventListener('dragover', function (ev) { if (state.drag && ev.target === grid) ev.preventDefault(); });
    grid.addEventListener('drop', function (ev) { if (state.drag && ev.target === grid) { ev.preventDefault(); dropOn(state.drag, null, true); } });
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
    wireWorkspaceDrag(nav); // before the items may move into the board nav
    // In a Terminal window the board's own nav bar is the header: the
    // workspace tabs take the area tabs' slot and the doors sit beside the
    // refresh. The strip below then only ever holds the share / rename / new
    // rows. In the main window the strip is the Terminal area's sub-nav.
    var boardNav = Board.solo === 'terminal' ? document.querySelector('.sui-screen-nav:has(> #board-tabs)') : null;
    if (boardNav) {
      var oldItems = boardNav.querySelector('#tm-ws-items'), oldDoors = boardNav.querySelector('#tm-ws-doors');
      if (oldItems) oldItems.parentNode.removeChild(oldItems);
      if (oldDoors) oldDoors.parentNode.removeChild(oldDoors);
      var list = nav.querySelector('.sui-screen-nav-items');
      list.id = 'tm-ws-items';
      var tabs = boardNav.querySelector('#board-tabs');
      boardNav.insertBefore(list, tabs ? tabs.nextSibling : boardNav.firstChild);
    } else {
      strip.appendChild(nav);
    }
    var wsDoors = H.el('span', 'tm-doors');
    wsDoors.id = 'tm-ws-doors';
    wsDoors.appendChild(door('icon-link-out', 'Open this workspace in its own window', function () {
      invoke('open_terminal_workspace', { name: state.ws }).catch(function (e) { Board.stamp && Board.stamp('needs the app: ' + e); });
    }));
    wsDoors.appendChild(door('icon-send-alpha', 'Share this workspace', function () { shareRow(strip); }));
    wsDoors.appendChild(door('icon-edit', 'Rename this workspace', function () { renameRow(strip); }));
    if (state.workspaces.length > 1) {
      wsDoors.appendChild(door('icon-close', 'Delete this workspace', function () { confirmDeleteWorkspace(state.ws); }));
    }
    if (boardNav) {
      var aside = boardNav.querySelector('.board-navaside');
      if (aside) aside.insertBefore(wsDoors, aside.firstChild); else boardNav.appendChild(wsDoors);
    } else {
      strip.appendChild(wsDoors);
    }
    mountClock(boardNav ? boardNav.querySelector('.board-navaside') : strip);
    // A hidden feature with no affordance is a feature nobody finds. This is
    // the control, not a note about one: clicking it opens the palette.
    wsDoors.insertBefore(door('icon-cmd-post', 'Command palette (⌘K)', function () { Terminal.togglePalette(); }), wsDoors.firstChild);
    /* Doors other files own — Comms puts its own on the header. The header
     * is rebuilt on every workspace switch, so they are asked each time
     * rather than painted once and lost. */
    (Terminal.onChrome || []).forEach(function (fn) { try { fn(wsDoors, strip); } catch (e) { /* one door must not take the header down */ } });
    top.appendChild(strip);
    // The command line and the card picker belong to the header, not to a
    // slab floating over the cards. They ride a `sui-screen-nav` of their own,
    // the same bar the workspace tabs sit in, so the two read as one stack.
    buildPalette();
    return top;
  }

  /* The palette, built on its own so it does not depend on the rest of the
   * Terminal being up. `chrome()` calls it as part of drawing the page, and
   * `Terminal.paletteOnly()` calls it with nothing else at all — which is what
   * lets `board.html?view=palette` be a frame the game window hosts.
   *
   * It appends to `document.body`, NOT into the page subtree: it is a scrim
   * over everything, and `renderAll()` wipes the subtree on every repaint. */
  function buildPalette() {
    if (document.getElementById('tm-palette')) return document.getElementById('tm-palette');
    /* ── The command palette ─────────────────────────────────────────────
     *
     * Hidden until you ask for it (⌘K / Ctrl-K), because a bar that is always
     * there is a bar the cards are always paying for — and everything it did
     * is one keystroke away. Opened empty it lists every card, grouped the way
     * the board names its areas, so it is a strict superset of the picker it
     * replaces: you can type what you want or read what there is.
     *
     * Being temporary is what lets it stop being a bar. It is a Spotlight:
     * a scrim over the whole board with one panel floating on it, which is
     * the right shape for something that owns the screen for two seconds and
     * then goes away. A strip wedged into the chrome had to stay narrow and
     * out of the way; this does not, so the box is wide, the type is the
     * READING size rather than the label size, and the matches sit inside the
     * frame under the line you are typing instead of hanging off it.
     *
     * It sits high rather than dead centre, as Spotlight and Quicksilver and
     * Raycast all do: the matches grow downward, and a box centred on an empty
     * list walks up the screen as the list fills.
     */
    var overlay = H.el('div', 'sui-message-system-model-overlay tm-palette-scrim');
    overlay.id = 'tm-palette';
    overlay.hidden = true;
    var box = H.el('div', 'tm-palette-box sui-panel sui-theme-player');
    box.appendChild(H.el('div', 'sui-panel-top-fill-background'));
    box.appendChild(H.el('div', 'sui-panel-bottom-fill-background'));
    box.appendChild(H.el('div', 'sui-panel-edge-left'));
    var pchunk = H.el('div', 'sui-panel-chunk sui-mod-grow sui-mod-shrink');
    box.appendChild(pchunk);
    box.appendChild(H.el('div', 'sui-panel-edge-right'));
    overlay.appendChild(box);

    var barScreen = H.el('div', 'sui-screen sui-screen-full-width tm-bar-screen');
    var bar = H.el('div', 'sui-screen-nav tm-bar');
    barScreen.appendChild(bar);
    pchunk.appendChild(barScreen);

    var cmd = H.textBox('', 'a card, or an object — 2-29604 · 1-61 WALLET · MKT', function () {});
    cmd.id = 'tm-cmd';
    cmd.classList.add('sui-text-paragraph');
    cmd.setAttribute('autocomplete', 'off');
    cmd.setAttribute('spellcheck', 'false');
    var cmdField = H.field('', cmd);
    cmdField.classList.add('tm-cmd-field');
    cmd.setAttribute('aria-label', 'Command');
    bar.appendChild(cmdField);
    // The matches are a screen of their own inside the same frame, so the
    // panel grows around them instead of a menu hanging below its edge.
    var results = H.el('div', 'sui-screen sui-screen-full-width tm-palette-results');
    results.hidden = true;
    pchunk.appendChild(results);
    wireCommandLine(cmd, cmdField, results);
    /* Clicking off it is the other way out, the one you reach for when the
     * pointer is already in your hand. Only the scrim itself: a click that
     * started inside the panel is not a click on the board behind it. */
    overlay.addEventListener('mousedown', function (ev) {
      if (ev.target === overlay) { ev.preventDefault(); Terminal.closePalette(); }
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  /* A workspace as text anyone can paste: `terminal:` + the layout, base64.
   * Shared into Comms as a message, or copied; pasted into the command line
   * (`IMPORT terminal:…`) it becomes a workspace here. */
  Terminal.exportWorkspace = function (name) {
    var payload = { name: name || state.ws, cards: state.layout.cards.map(function (c) { return { id: c.id, type: c.type, params: c.params || {}, w: c.w || 1 }; }) };
    return 'terminal:' + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  };
  Terminal.parseShared = function (text) {
    var t = String(text || '').trim();
    var m = /terminal:([A-Za-z0-9+/=]+)/.exec(t);
    var raw;
    try { raw = m ? decodeURIComponent(escape(atob(m[1]))) : t; } catch (e) { return null; }
    var payload;
    try { payload = JSON.parse(raw); } catch (e) { return null; }
    /* A chart code: one chart, not a workspace. Saved under its name (or
     * "shared") and opened; the word travels only if nobody here owns it. */
    if (payload && payload.chart && payload.chart.params && typeof payload.chart.params === 'object') {
      var ch = payload.chart;
      var name = String(ch.name || 'shared').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 40) || 'shared';
      var params = {};
      ['series', 'window', 'mode', 'scale', 'index'].forEach(function (k) { if (ch.params[k] != null) params[k] = String(ch.params[k]); });
      return { chart: { name: name, word: String(ch.word || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12), params: params } };
    }
    if (!payload || !Array.isArray(payload.cards)) return null;
    var cards = payload.cards.map(function (c) {
      // A code cut before the history card became the chart still opens.
      if (c && c.type === 'series') {
        var sp = c.params || {};
        return { id: c.id, w: c.w, type: 'chart', params: { series: JSON.stringify(sp.id ? [{ source: 'stat', metric: sp.metric || 'ore', subject: sp.id }] : []), window: sp.window } };
      }
      return c;
    }).filter(function (c) { return c && typeof c.type === 'string' && TYPES[c.type]; }).map(function (c, i) {
      return { id: String(c.id || (c.type + '-' + (i + 1))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || (c.type + '-' + (i + 1)), type: c.type, params: c.params && typeof c.params === 'object' ? c.params : {}, w: Math.max(1, Math.min(3, Number(c.w) || 1)) };
    });
    return { name: String(payload.name || 'shared').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'shared', cards: cards };
  };
  Terminal.importWorkspace = function (text) {
    var parsed = Terminal.parseShared(text);
    if (parsed && parsed.chart) {
      var ch = parsed.chart;
      return invoke('terminal_chart_save', { name: ch.name, params: Object.assign({}, ch.params, { name: ch.name }), word: ch.word || null })
        .catch(function () { return invoke('terminal_chart_save', { name: ch.name, params: Object.assign({}, ch.params, { name: ch.name }), word: null }); })
        .then(function (r) {
          Terminal.charts = (r && r.charts) || Terminal.charts;
          add('chart', Object.assign({}, ch.params, { name: (r && r.name) || ch.name }), 2);
          return true;
        }).catch(function () { return false; });
    }
    if (!parsed || !parsed.cards.length) return Promise.resolve(false);
    var name = parsed.name, n = 2;
    while (state.workspaces.indexOf(name) >= 0) name = parsed.name + '-' + n++;
    state.workspaces.push(name);
    Object.keys(state.mounted).forEach(function (id) { unmountCard(id); });
    state.ws = name;
    state.layout = { version: 0, cards: parsed.cards };
    if (!state.solo) invoke('terminal_workspace_activate', { name: name }).catch(function () {});
    return persist().then(function () { renderAll(); return true; });
  };
  function shareRow(strip) {
    var old = strip.querySelector('#tm-ws-share');
    if (old) { old.parentNode.removeChild(old); return; }
    var row = H.el('span', 'tm-share'); row.id = 'tm-ws-share';
    var code = H.textBox(Terminal.exportWorkspace(), '', function () {});
    code.readOnly = true;
    code.addEventListener('focus', function () { code.select(); });
    row.appendChild(code);
    var copy = H.el('a', 'sui-screen-btn sui-mod-secondary', 'Copy');
    copy.href = 'javascript:void(0)';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code.value).then(done, function () { code.select(); });
      else { code.select(); done(); }
    });
    row.appendChild(copy);
    var send = H.el('a', 'sui-screen-btn sui-mod-primary', 'Send to Comms');
    send.href = 'javascript:void(0)';
    send.addEventListener('click', function () {
      invoke('matrix_open', { subject: null, draft: 'Terminal workspace "' + state.ws + '" — paste into the Terminal command line: IMPORT ' + code.value })
        .then(function () { send.textContent = 'Sent'; }).catch(function (e) { Board.stamp && Board.stamp('needs Comms: ' + e); });
    });
    row.appendChild(send);
    strip.appendChild(row);
    code.focus();
  }

  // ── Role presets ────────────────────────────────────────────────────────
  // Starting layouts for the people this page is for. Each is an ordinary
  // workspace once made, and exports as a `terminal:` code like any other.
  var PRESETS = {
    trader:    { label: 'Energy trader',   cards: [['market', {}, 2], ['book', { id: 'primary' }, 1], ['banks', {}, 2], ['grid', {}, 1], ['halt', {}, 2], ['alerts', {}, 1], ['feed', { span: '24', lane: 'economy' }, 2], ['wallet', {}, 1]] },
    admin:     { label: 'Guild admin',     cards: [['people', {}, 1], ['banks', {}, 2], ['stats', { section: 'guilds' }, 2], ['grid', {}, 1], ['armada', {}, 2]] },
    botter:    { label: 'Botter',          cards: [['health', {}, 1], ['queue', {}, 1], ['results', {}, 1], ['pow', {}, 1], ['armada', {}, 2], ['feed', { span: '24' }, 2], ['page', { page: 'config:profiles' }, 2]] },
    hasher:    { label: 'Hasher',          cards: [['pow', {}, 1], ['solve', {}, 1], ['stats', { section: 'engine' }, 1], ['tasks', {}, 2], ['fuel', {}, 1], ['queue', {}, 1]] },
    raider:    { label: 'Raider',          cards: [['posture', {}, 1], ['targets', {}, 2], ['raids', { scope: 'live' }, 1], ['ore', {}, 2], ['grudges', {}, 1], ['incidents', {}, 2], ['feed', { span: '48', lane: 'war' }, 2]] },
  };
  Terminal.PRESETS = PRESETS;
  function presetLayout(key) {
    var pr = PRESETS[key];
    if (!pr) return null;
    var seen = {};
    return { version: 0, cards: pr.cards.map(function (c) {
      seen[c[0]] = (seen[c[0]] || 0) + 1;
      return { id: c[0] + '-' + seen[c[0]], type: c[0], params: c[1], w: c[2] };
    }) };
  }
  Terminal.presetLayout = presetLayout;
  /* Make (or replace) the workspace named after the preset and go there. */
  function applyPreset(key) {
    var layout = presetLayout(key);
    if (!layout) { Board.stamp && Board.stamp('presets: ' + Object.keys(PRESETS).join(', ')); return Promise.resolve(false); }
    var name = key;
    if (state.workspaces.indexOf(name) < 0) state.workspaces.push(name);
    Object.keys(state.mounted).forEach(function (id) { unmountCard(id); });
    state.ws = name;
    state.layout = layout;
    if (!state.solo) invoke('terminal_workspace_activate', { name: name }).catch(function () {});
    return persist().then(function () { renderAll(); return true; });
  }
  Terminal.applyPreset = applyPreset;

  function newWorkspaceRow(strip) {
    if (strip.querySelector('#tm-ws-new')) return;
    var box = H.textBox('', 'new workspace name', function () {});
    box.id = 'tm-ws-new';
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); createWorkspace(box.value); }
      if (e.key === 'Escape') { box.parentNode.removeChild(box); if (pick.parentNode) pick.parentNode.removeChild(pick); }
    });
    strip.appendChild(box);
    // Or start from a role's layout.
    var pick = H.selectBox('', [{ value: '', label: 'or a preset…' }].concat(Object.keys(PRESETS).map(function (k) { return { value: k, label: PRESETS[k].label }; })), function (v) { if (v) applyPreset(v); });
    pick.id = 'tm-ws-preset';
    strip.appendChild(pick);
    box.focus();
  }

  // ── The command line ────────────────────────────────────────────────────
  // The terminal's grammar, kept short: a bare id opens the card its type
  // implies (a player, a guild, a planet or fleet's map, anything else the
  // inspector); a word opens a page or a board. `MKT`, `GT 0-1`, `1-194`,
  // `2-15361`, `COMMS 2-15361`, `WORK`, `STATS ORE`, `PEOPLE`, `PAY`, `CHAT`.
  /* Comms is a WINDOW. Every one of these raises it through one command,
   * `matrix_open`, at the subject typed after the word — a player id or
   * name, a planet or fleet id, `#alias`, `!room` — or at nothing. They are
   * not cards and never were meant to be; a conversation lives in the
   * window that was built for it. `SAY` is the same door with a draft. */
  var COMMS_WORDS = {
    COMMS: 1, INBOX: 1, DMS: 1, UNREAD: 1, CHANNELS: 1, BROWSE: 1, DIRECTORY: 1,
    ROOM: 1, DM: 1, MSG: 1, MESSAGE: 1, TALK: 1, CHAT: 1, WHO: 1, INROOM: 1, FIND: 1, SEARCH: 1,
    // The work bus is hidden from the channel list; this is its door.
    BUS: 1,
  };
  var WORDS = {
    MKT: ['market'], MARKET: ['market'], PEOPLE: ['people'], TAPE: ['feed'], FLOW: ['feed'],
    DELIVER: ['deliver'], PAY: ['deliver'], SEND: ['deliver'], GT: ['gt', 'id'], GUILD: ['guild', 'id'],
    BANKS: ['banks'], BANK: ['bank'], MINT: ['bank'], REDEEM: ['bank'], SHEET: ['sheet', 'id'], TS: ['sheet', 'id'], TEARSHEET: ['sheet', 'id'],
    PLAYER: ['player', 'id'], MAP: ['map', 'id'], PLANET: ['planet', 'id'], INSPECT: ['inspector', 'id'], WATCH: ['watchlist', 'ids'],
    PRESET: ['preset'], PRESETS: ['preset'],
    ORE: ['ore'], HALT: ['halt'], BOOK: ['book', 'id'], ALERTS: ['alerts', 'rules'], ALERT: ['alerts', 'rules'],
    LOG: ['log', 'id'], BATTLE: ['log', 'id'],
    POW: ['pow'], HASH: ['pow'], SOLVE: ['solve'], TASKS: ['tasks'], QUEUE: ['queue'], TX: ['queue'], RESULTS: ['results'],
    GRID: ['grid'], FUEL: ['fuel'], ALLOC: ['allocations'], ALLOCATIONS: ['allocations'], MARGINS: ['halt'],
    ARMADA: ['armada'], ROSTER: ['armada'], SQUAD: ['armada'], RAIDS: ['raids'], POSTURE: ['posture'], WAR: ['posture'], TARGETS: ['targets'],
    GRUDGES: ['grudges'], VETOES: ['vetoes'], INCIDENTS: ['incidents'], WALLET: ['wallet', 'optid'], HEALTH: ['health'],
    SETTINGS: ['page', 'config'],
    STATS: ['stats', 'section'], WORK: ['tasks'], ENERGY: ['grid'], STREAM: ['feed'],
    INVENTORY: ['wallet', 'optid'], OPS: ['health'], CONFIG: ['page', 'config'],
    // What a player has DONE (the tiles) and what their hulls have done (the
    // table). `AWARDS` and `HULLS` because that is what each is called out loud.
    RECORD: ['record', 'id'], AWARDS: ['record', 'id'], ACHIEVEMENTS: ['record', 'id'],
    TALLY: ['tally', 'id'], HULLS: ['tally', 'id'], KILLS: ['tally', 'id'],
    HELP: ['help'], COMMANDS: ['help'], SAY: ['say', 'text'],
    FEED: ['feed'], EVENTS: ['feed'], NEXT: ['next'], MOVES: ['next'],
    // The guild's stat store, asked of one object: ore on a planet, load on a
    // substation, health on a struct. `HIST` is the word; `GP` is there
    // because that is what the muscle memory of a terminal reaches for.
    HIST: ['chart', 'optid'], HISTORY: ['chart', 'optid'], GP: ['chart', 'optid'], CHART: ['chart', 'optid'],
    // The ambit they neither reach nor occupy — the one computed answer that
    // decides a fight. `RECON` because that is what people call it.
    SCOUT: ['scout', 'id'], RECON: ['scout', 'id'], REACH: ['scout', 'id'],
    // Staging: a raid needs the fleet AT the planet, and the fleet you stage
    // is usually a worker's, not the primary's.
    STAGE: ['fleet', 'id'], MOVE: ['fleet', 'id'],
    // What the chain destroys first if the grid gives: the cascade order.
    BROWNOUT: ['brownout'], CASCADE: ['brownout'], RISK: ['brownout'],
    // The game's own verbs, on the struct in front of you.
    OPS: ['ops', 'id'], ACT: ['ops', 'id'], DO: ['ops', 'id'],
    // A guild's PEOPLE, not its statistics.
    MEMBERS: ['members', 'id'], ROSTER_OF: ['members', 'id'],
    // Placement: what can stand here, and in which free slot.
    BUILD: ['build', 'id'], DEPLOY: ['build', 'id'],
    /* The Cluster: every machine's shared processing. Joining it is
     * ASSIMILATION — the strategy of the game now — and the alternative is
     * independence. `HELPERS` for the people; `BOUNTY` and `OWED` because
     * the money question is asked in different words than the joining one.
     * The card's internal type stays `crew`; the word a player types is the
     * word the game uses. */
    CLUSTER: ['crew'], ASSIMILATE: ['crew'], ASSIMILATION: ['crew'], PHERALS: ['crew'], PROXIES: ['crew'],
    BOUNTY: ['crewpay'], OWED: ['crewpay'], PAYOUTS: ['crewpay'],
  };
  Terminal.WORDS = WORDS;

  /* ── The grammar ─────────────────────────────────────────────────────────
   *
   * Two orders, because people think in two orders.
   *
   *   WORD [subject]     PLAYER 1-61     — you know the function
   *   subject WORD       1-61 PLAYER     — you know the subject
   *
   * The second is the one an expert falls into: you are looking at 2-29604,
   * and you want the map, then the log, then its ore history. Typing the id
   * once and then asking of it is how a terminal is meant to feel; typing
   * PLANET, then LOG, then HIST and re-typing the id three times is not.
   *
   * A function only offers itself for a subject it can actually take, and
   * that comes from the card's own `kinds` rather than a second list here:
   * `2-29604 WALLET` is not a command, and the completion menu never shows
   * it.
   */
  var OBJECT_KINDS = {
    0: 'guild', 1: 'player', 2: 'planet', 3: 'reactor', 4: 'substation',
    5: 'struct', 6: 'allocation', 7: 'infusion', 8: 'address', 9: 'fleet',
    10: 'provider', 11: 'agreement',
  };
  var ID_RE = /^(\d{1,2})-(\d{1,9})$/;
  function kindOf(id) { var m = ID_RE.exec(String(id || '')); return m ? Number(m[1]) : null; }
  Terminal.kindOf = kindOf;
  Terminal.OBJECT_KINDS = OBJECT_KINDS;

  /* The `id` param a word's card takes, if it takes one. `optid` and `ids`
   * count: WALLET and WATCH both name objects. */
  function idParamOf(type) {
    var def = TYPES[type];
    if (!def || !def.params) return null;
    for (var i = 0; i < def.params.length; i++) if (def.params[i].kind === 'id') return def.params[i];
    return null;
  }
  /* A word whose argument is a FIXED SET — `STATS <section>` — and the set,
   * read off the card's own `kind: 'choice'` param. The options were already
   * declared there for the configure strip; nothing but the palette was
   * asking, so `<section>` was a prompt with no way to learn the answers.
   *
   * Matched on the param KEY, so only an argument that really is that param
   * completes: `CHAT direct` names a literal, not a param, and is left alone. */
  function choiceOptionsFor(word) {
    var w = WORDS[word];
    if (!w || !w[1]) return null;
    var def = TYPES[w[0]];
    if (!def || !def.params) return null;
    for (var i = 0; i < def.params.length; i++) {
      var p = def.params[i];
      if (p.kind === 'choice' && p.key === w[1] && p.options && p.options.length) return p.options;
    }
    return null;
  }
  Terminal.choiceOptionsFor = choiceOptionsFor;

  /* Will this card take this id? `kinds: null` is "any object", and a card
   * with no id param takes none. */
  function acceptsId(type, id) {
    var p = idParamOf(type);
    if (!p) return true;
    if (!p.kinds) return true;
    var k = kindOf(id);
    return k !== null && p.kinds.indexOf(k) >= 0;
  }
  Terminal.acceptsId = acceptsId;

  /* Every word that can be asked of this object, in the order the card menu
   * files them, so the same vocabulary answers in both places. */
  Terminal.functionsFor = function (id) {
    var kind = kindOf(id);
    if (kind === null) return [];
    var seen = {}, out = [];
    Object.keys(WORDS).forEach(function (word) {
      var w = WORDS[word], type = w[0], arg = w[1];
      if (arg !== 'id' && arg !== 'optid' && arg !== 'ids') return;
      var p = idParamOf(type);
      // `kinds: null` is "any object"; a missing param is a word whose card
      // takes the id another way (the map's planet-or-fleet).
      if (p && p.kinds && p.kinds.indexOf(kind) < 0) return;
      var def = TYPES[type];
      if (!def || def.hidden) return;
      if (seen[type]) return;
      seen[type] = 1;
      out.push({ word: word, type: type, label: def.label, arg: arg });
    });
    /* The window's words, for the subjects that have a conversation: a
     * player's is a DM, a planet's or a fleet's is its room. They open no
     * card, so the loop above cannot find them; typed subject-first they are
     * the launcher's whole reason to exist — `1-61 DM`, `2-29604 ROOM`. */
    if (kind === 1) out.push({ word: 'DM', type: 'comms', label: 'Comms', arg: 'optid' });
    if (kind === 2 || kind === 9) out.push({ word: 'ROOM', type: 'comms', label: 'Comms', arg: 'optid' });
    return out;
  };

  /* Parse a line into a PLAN — what it would open — without opening it.
   *
   * The command line needs to know whether Enter will do something before it
   * decides between running what was typed and taking the highlighted
   * completion, and there is no way to try `execute` and take it back. One
   * parser answers both questions, so what the menu promises and what Enter
   * does cannot drift.
   *
   * A plan is `{ kind: 'card', type, params }` for the ordinary case, or
   * `{ kind: <verb> }` for the few lines that act on the workspace itself.
   * `null` means "not a command".
   */
  Terminal.parse = function (line) {
    var parts = String(line || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    /* Subject first: `2-29604 LOG`, `1-61 WALLET`. Rewritten into the
     * word-first form rather than handled twice, so one dispatch decides what
     * every word does. A trailing subject that is ALSO an id (`1-61 SHEET`)
     * needs no special case — the word is still parts[1]. */
    if (ID_RE.test(parts[0]) && parts.length > 1
        && (WORDS[parts[1].toUpperCase()] || COMMS_WORDS[parts[1].toUpperCase()] || parts[1].toUpperCase() === 'SAY')) {
      parts = [parts[1]].concat(parts[0], parts.slice(2));
    }
    var head = parts[0].toUpperCase();
    var rest = parts.slice(1).join(' ');
    var card = function (type, params) { return { kind: 'card', type: type, params: params || {} }; };
    var idm = ID_RE.exec(parts[0]);
    if (idm && parts.length === 1) {
      var k = Number(idm[1]);
      return card(k === 1 ? 'player' : k === 0 ? 'guild' : k === 2 ? 'planet' : k === 9 ? 'map' : 'inspector',
        { id: parts[0] });
    }
    if (head === '?') return card('help', {});
    /* FLEET is the game's word and it means three things, decided by what
     * follows it — the same rule the rest of the grammar runs on. Bare, it is
     * the roster, which is what people have always typed. Given a FLEET id it
     * is that fleet on the map. Given a PLAYER id it is that player's fleet:
     * where it stands and where it can go. It used to send a player id to the
     * map, which drew the wrong object for the id it was handed. */
    if (head === 'FLEET') {
      if (!rest) return card('armada', {});
      if (kindOf(rest) === 1) return card('fleet', { id: rest });
      return card(ID_RE.test(rest) ? 'map' : 'armada', { id: rest });
    }
    /* SAY is the one verb here that is not a card. `SAY 2-15361 is breached`
     * goes to the room you last looked at; `SAY #war-room …` names one. Mid-
     * raid, from ⌘K over the map, without opening or leaving anything — the
     * thing that makes this a game's chat rather than a chat in a game. */
    if (head === 'SAY') {
      if (!rest) return null;
      /* `SAY 2-15361 shield is down` drafts "shield is down" in the planet's
       * own room; `SAY 1-61 …` in that player's DM; `SAY #war-room …` in that
       * room. A planet's room is where a line about the planet belongs, and
       * the window that opens shows which room it landed in before anything
       * is sent. With no subject, the draft goes to the room the window has
       * open, or waits for one. */
      var m = /^([#!][^\s]+|\d+-\d+)\s+([\s\S]+)$/.exec(rest);
      return m ? { kind: 'say', subject: m[1], text: m[2] } : { kind: 'say', text: rest };
    }
    if (COMMS_WORDS[head]) return { kind: 'comms', subject: rest || (head === 'BUS' ? 'bus' : null) };
    if (head === 'PRESET' || head === 'PRESETS') return { kind: 'preset', name: String(rest || '').toLowerCase() };
    if (head === 'SHARE') return { kind: 'share' };
    // The companion is a WINDOW, not a card: it has no grid slot and no
    // params, and it works the same from the palette over the game as from
    // the Terminal — so it is parsed here beside the other bare verbs.
    if (head === 'PET' || head === 'COMPANION') return { kind: 'pet' };
    // The bar's RESET button went with the bar; this is the same verb.
    if (head === 'RESET') return { kind: 'reset' };
    if (head === 'IMPORT') return rest ? { kind: 'import', text: rest } : null;
    /* A saved chart's own word opens it — `OHM` — and `CHART <name>` too. */
    var saved = Terminal.savedChart(head);
    if (saved && parts.length === 1) return card('chart', Object.assign({}, saved.params, { name: saved.name }));
    var w = WORDS[head];
    if (!w) {
      /* A built-in chart's word — `RATES`, `PULSE` — only once the card
       * words have said no, so the library can never shadow a card. */
      var tpl = Terminal.chartTemplate && Terminal.chartTemplate(head);
      if (tpl && parts.length === 1) return card('chart', Terminal.chartTemplateParams(tpl));
      return null;
    }
    var type = w[0], arg = w[1];
    if (type === 'chart') return card('chart', Terminal.chartParamsFor(rest));
    if (!arg) return card(type, {});
    if (arg === 'id' || arg === 'ids' || arg === 'rules') {
      if (!rest) return null;
      /* An id of the wrong KIND is not a command. `PLANET 1-61` used to parse
       * and hand a player id to the planet card, which then drew the wrong
       * object — and because it parsed, Enter ran it instead of taking the
       * resolved completion sitting right there. Refusing it makes `canRun`
       * false, which is exactly the case the menu already knows to win. */
      if (arg === 'id' && !acceptsId(type, rest)) return null;
      var pp = {}; pp[arg] = rest; return card(type, pp);
    }
    if (arg === 'optid') return card(type, rest ? { id: rest } : {});
    /* `text` — everything after the word is one free-text argument. `FIND
     * shield is down` is three words and one question; splitting it on spaces
     * the way an id argument is split would search for "shield". */
    if (arg === 'text') return rest ? card(type, { q: rest }) : null;
    /* `key=value` — a word that IS a configured card. `DMS` is the room list
     * with `show: direct`; it used to be two hard-coded literals for the one
     * card that needed them, which is how a rename of that card's params broke
     * a word rather than a test. */
    if (arg.indexOf('=') > 0) {
      var kv = arg.split('='), params = {};
      params[kv[0]] = kv.slice(1).join('=');
      return card(type, params);
    }
    if (arg === 'section') return card(type, { section: (rest || 'universe').toLowerCase() });
    return card(type, { page: arg });
  };
  /* Would Enter do anything? The menu asks before it decides whether to take
   * the completion or run the line as typed. */
  Terminal.canRun = function (line) { return Terminal.parse(line) !== null; };

  /* ── Saved charts ────────────────────────────────────────────────────────
   * Kept in Rust (`terminal_charts`); cached here for the grammar. Loaded
   * when the Terminal enters and when the palette opens — never at the
   * palette page's boot, which asks the app for nothing. */
  Terminal.charts = null;
  Terminal.loadCharts = function () {
    return invoke('terminal_charts').then(function (list) { Terminal.charts = Array.isArray(list) ? list : []; return Terminal.charts; })
      .catch(function () { Terminal.charts = Terminal.charts || []; return Terminal.charts; });
  };
  Terminal.savedChart = function (wordOrName) {
    var key = String(wordOrName || '').trim();
    if (!key) return null;
    var list = Terminal.charts || [];
    return list.filter(function (c) { return c.word && c.word === key.toUpperCase(); })[0]
      || list.filter(function (c) { return String(c.name || '').toLowerCase() === key.toLowerCase(); })[0]
      || null;
  };
  /* What `CHART <thing>` means: nothing → an empty chart; a saved name → that
   * chart; an object id → its first recorded metric; a source word (`market`,
   * `chain`) → that source's headline series. */
  Terminal.chartParamsFor = function (rest) {
    var r = String(rest || '').trim();
    if (!r) return {};
    var saved = Terminal.savedChart(r);
    if (saved) return Object.assign({}, saved.params, { name: saved.name });
    var tpl = Terminal.chartTemplate && Terminal.chartTemplate(r);
    if (tpl) return Terminal.chartTemplateParams(tpl);
    if (ID_RE.test(r)) {
      var s = Terminal.defaultChartSeries ? Terminal.defaultChartSeries(r) : null;
      return s ? { series: JSON.stringify([s]) } : { series: '[]' };
    }
    var head = r.toLowerCase().split(/\s+/)[0];
    var HEADLINE = { market: { source: 'market', metric: 'best' }, chain: { source: 'chain', metric: 'chain_tx' }, galaxy: { source: 'galaxy', metric: 'load', subject: 'substation' } };
    if (HEADLINE[head]) return { series: JSON.stringify([HEADLINE[head]]) };
    return { series: '[]', name: r };
  };

  /* The one door to Comms from any card: raise the window at a subject —
   * a planet, a fleet, a player, an alias — with an optional draft. Every
   * icon-phone on the board goes through here, so a card cannot reach for a
   * Comms card that no longer exists. */
  Terminal.comms = function (subject, draft) {
    return invoke('matrix_open', { subject: subject || null, draft: draft || null })
      .catch(function (e) { Board.stamp && Board.stamp('comms: ' + e); });
  };
  Terminal.execute = function (line) {
    var plan = Terminal.parse(line);
    if (!plan) return false;
    /* Framed over the game there is no layout and no grid, so a card opens as
     * a window instead of being added here. The other verbs all MUTATE a
     * workspace this page never loaded — a preset would overwrite the layout
     * with `state.layout` still null — so they are refused rather than half
     * done. Nothing is lost: they are what the Terminal itself is for. */
    if (plan.kind === 'say' || plan.kind === 'comms') {
      /* The Comms window, raised at the subject — with the line as a DRAFT
       * for SAY. Never a post: the player reads the room and presses send.
       * Works the same over the game (the palette frame) and in the
       * Terminal, because neither has a chat of its own. */
      invoke('matrix_open', { subject: plan.subject || null, draft: plan.kind === 'say' ? plan.text : null })
        .then(function () { tellHost('ran'); })
        .catch(function (e) {
          var cmd = document.getElementById('tm-cmd');
          if (cmd) cmd.classList.add('is-err');
          Board.stamp && Board.stamp('comms: ' + e);
        });
      return true;
    }
    if (plan.kind === 'pet') {
      // Above the palette-only gate: the companion opens no card and mutates
      // no workspace, so the one surface that refuses every other verb can
      // still reach it.
      invoke('companion_toggle')
        .then(function () { tellHost('ran'); })
        .catch(function (e) { Board.stamp && Board.stamp('companion: ' + e); });
      return true;
    }
    if (state.paletteOnly) {
      if (plan.kind !== 'card') return false;
      return Terminal.openInWindow(plan.type, plan.params);
    }
    if (plan.kind === 'card') return !!add(plan.type, plan.params);
    if (plan.kind === 'preset') { applyPreset(plan.name); return true; }
    if (plan.kind === 'share') { var strip = document.querySelector('.tm-workspaces'); if (strip) shareRow(strip); return true; }
    if (plan.kind === 'import') { Terminal.importWorkspace(plan.text); return true; }
    if (plan.kind === 'reset') {
      Object.keys(state.mounted).forEach(function (id) { unmountCard(id); });
      state.layout = defaultLayout();
      save();
      renderGrid();
      return true;
    }
    return false;
  };

  /* ── The command line ────────────────────────────────────────────────────
   *
   * A terminal is only as fast as the distance between a thought and the
   * screen. Three things close that distance, and none of them existed:
   *
   *   completion  type `2-29604` and see every question you can ask OF it —
   *               the map, the log, its ore history — named and one key away.
   *               Typing a word shows the words that start that way.
   *   recall      Up walks back through what you ran. An expert re-runs.
   *   the answer  each row says which CARD it opens, so the vocabulary teaches
   *               itself instead of living in a reference nobody opens.
   *
   * Suggestions never invent: a function appears for a subject only when the
   * card's own `kinds` accepts it (`Terminal.functionsFor`).
   */
  /* The word that opens a card type: the first one WORDS names it by, so the
   * palette teaches the vocabulary the command line already understands
   * rather than inventing a second one. */
  function wordFor(type) {
    var keys = Object.keys(WORDS);
    for (var i = 0; i < keys.length; i++) if (WORDS[keys[i]][0] === type) return keys[i];
    return null;
  }
  Terminal.wordFor = wordFor;

  var HISTORY_MAX = 50;
  var cmdHistory = [];
  /* Every chart the palette can open by name: the ones you saved, then the
   * library — minus any template whose word a saved chart has taken. */
  function chartRows(filter) {
    var out = [];
    (Terminal.charts || []).forEach(function (c) {
      if (filter && !filter(c.word || '', c.name || '')) return;
      out.push({ line: 'CHART ' + c.name, words: c.word || 'CHART', what: c.name, sub: c.word ? 'CHART ' + c.name : '', group: 'Charts', run: true });
    });
    (Terminal.chartTemplates ? Terminal.chartTemplates() : []).forEach(function (t) {
      if (Terminal.savedChart(t.word)) return;
      if (filter && !filter(t.word, t.name)) return;
      out.push({ line: 'CHART ' + t.name, words: t.word, what: t.name, sub: 'CHART ' + t.name, group: 'Charts', run: true });
    });
    return out;
  }
  Terminal.chartRows = chartRows;

  function suggestFor(line) {
    var raw = String(line || '');
    var parts = raw.trim().split(/\s+/).filter(Boolean);
    /* Opened empty, the palette IS the card menu — every card, in the groups
     * the board names its areas by. That is what makes it a replacement for
     * the picker rather than a second way in: you can type what you want, or
     * read what there is. */
    if (!parts.length) {
      var out = [];
      /* The window's words FIRST, as a group of their own: they open no
       * card, so the card menu would never list them — and listed last,
       * under fifty card rows, they sat below the fold and read as missing.
       * A launcher that cannot reach Comms is a launcher people stop
       * opening. */
      out.push({ line: 'COMMS', words: 'COMMS', what: 'Open Comms', arg: '', group: 'Comms', run: true });
      out.push({ line: 'DM ', words: 'DM', what: 'Message a player', arg: '<player>', group: 'Comms', run: false });
      out.push({ line: 'ROOM ', words: 'ROOM', what: 'A conversation, by subject', arg: '<id · #alias>', group: 'Comms', run: false });
      out.push({ line: 'SAY ', words: 'SAY', what: 'Draft a line in Comms', arg: '<text>', group: 'Comms', run: false });
      // The charts a player has saved and the library, each under its word.
      chartRows().forEach(function (r) { out.push(r); });
      Terminal.groups().forEach(function (g) {
        g.options.forEach(function (o) {
          var word = wordFor(o.value);
          if (!word) return;
          var arg = WORDS[word] && WORDS[word][1] ? ARG_LABEL[WORDS[word][1]] || '' : '';
          out.push({ line: word + (arg ? ' ' : ''), words: word, what: o.label, arg: arg, group: g.group, run: !arg });
        });
      });
      return out;
    }
    var trailingSpace = /\s$/.test(raw);
    // Subject first: `2-29604` → everything askable of a planet; `2-29604 L`
    // narrows it. This is the case the whole feature exists for.
    if (ID_RE.test(parts[0]) && (parts.length === 1 || parts.length === 2)) {
      var typed = parts.length === 2 ? parts[1].toUpperCase() : (trailingSpace ? '' : null);
      if (typed === null && parts.length === 1) typed = '';
      var fns = Terminal.functionsFor(parts[0]).filter(function (f) { return f.word.indexOf(typed) === 0; });
      return fns.map(function (f) {
        return { line: parts[0] + ' ' + f.word, words: f.word, what: f.label, sub: parts[0], run: true };
      });
    }
    var head = parts[0].toUpperCase();
    /* `STATS ` — the word is complete and its argument is a fixed set, so the
     * set is what comes next. Before the early return below, which used to
     * leave the box silent at exactly the moment there was something to say. */
    if (WORDS[head] && (parts.length === 2 || trailingSpace)) {
      var opts = choiceOptionsFor(head);
      if (opts) {
        var typedOpt = parts.length === 2 ? parts[1].toLowerCase() : '';
        return opts.filter(function (o) { return String(o.value).toLowerCase().indexOf(typedOpt) === 0; })
          .map(function (o) {
            return { line: head + ' ' + o.value, words: head + ' ' + o.value, what: o.label, run: true };
          });
      }
    }
    /* `CHART ` and `CHART Mar`: the charts you saved, by name, as the word's
     * own choices — the way `STATS ` lists its set. */
    if (WORDS[head] && WORDS[head][0] === 'chart' && (parts.length > 1 || trailingSpace)) {
      var typedName = parts.slice(1).join(' ').toLowerCase();
      return chartRows(function (word, name) { return String(name).toLowerCase().indexOf(typedName) === 0; });
    }
    // A word being typed. Every word that starts this way, one row per CARD so
    // the aliases (MKT / MARKET) do not fill the list with the same answer.
    if (parts.length > 1 || trailingSpace) return [];
    var seen = {}, out = [];
    /* A saved chart completes like any word: by the ⌘K word it was given
     * (`LM` → LMKT) or by the start of its name. It leads — you saved it. */
    chartRows(function (word, name) {
      var w = String(word || '').toUpperCase(), n = String(name || '').toUpperCase();
      return (w && w.indexOf(head) === 0) || n.indexOf(head) === 0;
    }).forEach(function (r) { out.push(r); });
    Object.keys(WORDS).forEach(function (word) {
      if (word.indexOf(head) !== 0) return;
      var w = WORDS[word], def = TYPES[w[0]];
      if (!def || def.hidden) return;
      var key = w.join(':');
      if (seen[key]) { seen[key].words += ' · ' + word; return; }
      var arg = w[1] && ARG_LABEL[w[1]] ? ARG_LABEL[w[1]] : '';
      seen[key] = { line: word + (arg ? ' ' : ''), words: word, what: def.label, arg: arg, run: !arg };
      out.push(seen[key]);
    });
    out.sort(function (a, b) {
      if (!!a.group !== !!b.group) return a.group ? -1 : 1;   // saved charts first
      return a.words < b.words ? -1 : a.words > b.words ? 1 : 0;
    });
    return out;
  }
  Terminal.suggestFor = suggestFor;

  /* ── Forgiving subjects: the palette as a search bar ──────────────────────
   *
   * `PLANET 2-9462` was the only spelling the grammar knew, so looking AT a
   * planet meant looking UP its id first. A player id or a callsign is what
   * anyone actually has to hand, and `mcp_player_search` already answers all
   * three at once — one row carries the player, their planet and their fleet —
   * so the id you have can stand in for the id the card wants.
   *
   * Deliberately OUTSIDE `suggestFor`, which stays pure and instant: these
   * rows arrive from a round trip and are appended when they land, so
   * completion never waits on the network.
   */
  var KIND_FIELD = { 0: 'guild_id', 1: 'player_id', 2: 'planet_id', 9: 'fleet_id' };
  var KIND_NOUN = { 0: 'guild', 1: 'player', 2: 'planet', 9: 'fleet' };

  function hitLabel(h) {
    var name = h && (h.username || h.name);
    var tag = h && h.guild_tag ? '[' + h.guild_tag + '] ' : '';
    return name ? tag + String(name) : String((h && h.player_id) || '');
  }

  /* Half an id is nobody's question — the guild API answers `1-` with a 400,
   * which the Pay window learned by printing one at the player. A WHOLE id is
   * a fine thing to look up: it is how a player id resolves to their planet. */
  function searchable(text) {
    var t = String(text || '').trim();
    if (ID_RE.test(t)) return true;
    if (/^\d+-/.test(t)) return false;
    return t.length >= 2;
  }

  /* What this line wants looked up, or null when nothing should be asked. */
  Terminal.searchSubject = function (line) {
    var raw = String(line || '');
    var parts = raw.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    var head = parts[0].toUpperCase();
    if (WORDS[head] && parts.length > 1) {
      var subject = parts.slice(1).join(' ');
      return searchable(subject) ? subject : null;
    }
    // A bare subject, once it is no longer just a word being typed.
    if (parts.length === 1 && !/\s$/.test(raw) && !WORDS[head]) {
      return searchable(parts[0]) ? parts[0] : null;
    }
    return null;
  };

  /* The rows a search answers with. Pure — the hits go in, the menu comes out
   * — so what it offers is decided by rules rather than by whatever the
   * network happened to return. */
  Terminal.searchRows = function (line, hits) {
    var raw = String(line || '');
    var parts = raw.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || !hits || !hits.length) return [];
    var head = parts[0].toUpperCase();
    var rows = [];
    var push = function (row) { if (rows.length < SEARCH_MAX) rows.push(row); };

    // `WORD subject` — resolve the subject to the kind the CARD wants.
    if (WORDS[head] && parts.length > 1) {
      var typed = parts.slice(1).join(' ');
      var p = idParamOf(WORDS[head][0]);
      // A card that takes any object needs no resolving, and one that takes no
      // id has nothing to resolve into.
      if (!p || !p.kinds) return [];
      hits.forEach(function (h) {
        p.kinds.forEach(function (k) {
          var id = h[KIND_FIELD[k]];
          if (!id || id === typed) return;
          push({ line: head + ' ' + id, words: head, sub: id, run: true,
                 what: hitLabel(h) + ' · ' + KIND_NOUN[k], group: 'Found' });
        });
      });
      return rows;
    }

    /* A bare subject — a name, or an id whose owner has OTHER objects. The row
     * puts the id in the box rather than opening anything: the subject-first
     * completion then lists everything askable of it, which is the same two
     * keystrokes as knowing the id in the first place. */
    if (parts.length === 1) {
      var was = parts[0];
      hits.forEach(function (h) {
        [1, 2, 9].forEach(function (k) {
          var id = h[KIND_FIELD[k]];
          if (!id || id === was) return;
          push({ line: id + ' ', words: id, run: false,
                 what: hitLabel(h) + ' · ' + KIND_NOUN[k], group: 'Found' });
        });
      });
      return rows;
    }
    return [];
  };
  var SEARCH_MAX = 6;



  /* ⌘K / Ctrl-K. One keystroke, from anywhere on the page — the palette is
   * the whole reason the bar can be gone. Escape puts it away; so does
   * running something. */
  function palette() { return document.getElementById('tm-palette'); }
  /* `prefix` opens it part-typed — "message a player" is `ROOM ` with the
   * cursor after it, which is one gesture rather than a picker nobody can
   * reach from the keyboard. */
  Terminal.openPalette = function (prefix) {
    var p = palette();
    if (!p) return false;
    p.hidden = false;
    var cmd = document.getElementById('tm-cmd');
    if (cmd) {
      if (prefix != null) { cmd.value = String(prefix); }
      cmd.focus();
      if (prefix == null) cmd.select();
      else cmd.setSelectionRange(cmd.value.length, cmd.value.length);
      cmd.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  };
  Terminal.closePalette = function () {
    var p = palette();
    if (!p) return;
    p.hidden = true;
    var cmd = document.getElementById('tm-cmd');
    if (cmd) { cmd.value = ''; cmd.classList.remove('is-err'); }
    // Escape and a click on the scrim are both this. Framed over the game, the
    // frame itself has to go too, or an invisible overlay keeps the pointer.
    tellHost('close');
  };
  Terminal.togglePalette = function () {
    var p = palette();
    if (p && !p.hidden) { Terminal.closePalette(); return; }
    Terminal.openPalette();
  };

  /* ── The palette, alone, for the game window to host ─────────────────────
   *
   * `board.html?view=palette` in an iframe over the game (structs-config.js).
   * The palette is a GRAMMAR, not a menu — it knows every registered card,
   * which object kinds each accepts, and how to complete `2-29604` into the
   * questions you can ask of a planet. A second copy of that beside the game
   * would drift from this one the day a card is added, so the real thing is
   * framed instead.
   *
   * Nothing else on the page runs: `board.js` returns from `init` before its
   * four boot invokes, the 15-second Comms poll and the grass listeners, and
   * `enter()` is never called — so the layout is never loaded and there is no
   * grid. That is the whole reason a pick opens a WINDOW rather than adding a
   * card here: there is no page for it to land on.
   */
  Terminal.paletteOnly = function () {
    state.paletteOnly = true;
    buildPalette();
    Terminal.openPalette();
    // Both orders work: the host may have said "open" before this frame
    // existed, and it says it again when we announce ourselves.
    tellHost('ready');
    window.addEventListener('message', function (ev) {
      var mine = String(location.origin || '');
      var same = ev.origin === mine || (mine === 'null' && (ev.origin === 'null' || ev.origin === ''));
      if (!same) return;
      var m = ev.data;
      if (!m || m.structs !== 'palette') return;
      if (m.act === 'open') Terminal.openPalette();
      if (m.act === 'close') { var p = palette(); if (p) p.hidden = true; }
    });
  };

  /* The host is the window this page is framed in. Silent when there isn't
   * one — the palette works exactly the same inside the Terminal. */
  function tellHost(act) {
    if (!state.paletteOnly) return;
    var p = window.parent;
    if (!p || p === window) return;
    var mine = String(location.origin || '');
    try { p.postMessage({ structs: 'palette', act: act }, mine === 'null' || !mine ? '*' : mine); } catch (e) { /* nothing to tell */ }
  }

  /* A pick with no page to land on becomes a card AND a window, made by Rust
   * in one call: the card is appended to a real workspace, so it is in the
   * layout, an open Terminal sees it appear, and it comes back at the next
   * launch — a palette pick is a card you made, not a dialog that evaporates. */
  Terminal.openInWindow = function (type, params) {
    invoke('open_terminal_card_new', { kind: type, params: params || {} })
      .then(function () { tellHost('ran'); })
      .catch(function (e) {
        var cmd = document.getElementById('tm-cmd');
        if (cmd) cmd.classList.add('is-err');
        Board.stamp && Board.stamp('palette: ' + e);
      });
    // Answered optimistically: the line has been accepted and the box should
    // clear, whatever the window build then does.
    return true;
  };
  if (!Terminal._paletteKeys) {
    Terminal._paletteKeys = true;
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        Terminal.togglePalette();
      }
    });
  }

  function wireCommandLine(cmd, field, host) {
    var menu = H.el('div', 'tm-suggest');
    menu.hidden = true;
    (host || field).appendChild(menu);
    /* With a host of its own the matches FLOW inside the palette's frame, so
     * the frame has to disappear when there are none — an empty screen is
     * still a screen, and it read as a stray bar under the line. */
    var show = function (on) { menu.hidden = !on; if (host) host.hidden = !on; };
    var items = [], cursor = -1, histAt = -1, draft = '', picked = false;
    /* The search half. One cache keyed by query, so walking back over a name
     * you already typed is instant and a held key does not fan out. */
    var searchTimer = null, searchCache = {}, searchSeq = 0;

    function paint() {
      menu.innerHTML = '';
      if (!items.length) { show(false); return; }
      var group = null;
      items.forEach(function (it, i) {
        if (it.group && it.group !== group) {
          group = it.group;
          menu.appendChild(H.el('div', 'tm-suggest-group fstat-l', group));
        }
        var r = H.el('a', 'tm-suggest-row' + (i === cursor ? ' is-on' : ''));
        r.href = 'javascript:void(0)';
        var left = H.el('span', 'tm-help-words');
        // `lead`: the subject is the answer, the word is how it is reached.
        if (it.sub) left.appendChild(it.lead ? H.el('b', null, it.sub) : H.el('span', 'ops-muted', it.sub));
        left.appendChild(it.lead ? H.el('span', 'ops-muted', ' ' + it.words) : H.el('b', null, it.words));
        if (it.arg) { left.appendChild(document.createTextNode(' ')); left.appendChild(H.el('span', 'ops-muted', it.arg)); }
        r.appendChild(left);
        var right = H.el('span', 'ops-val');
        right.appendChild(document.createTextNode(it.what || ''));
        (it.acts || []).forEach(function (a) {
          var v = H.el('a', 'tm-suggest-act', a.label);
          v.href = 'javascript:void(0)';
          v.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); a.run(); });
          right.appendChild(v);
        });
        r.appendChild(right);
        // mousedown, not click: the input blurs on click and the menu is gone
        // before the click lands.
        r.addEventListener('mousedown', function (ev) { ev.preventDefault(); accept(i); });
        menu.appendChild(r);
      });
      show(true);
    }
    function refresh() {
      var line = cmd.value;
      /* Saved charts are asked for on the first keystroke, never at boot:
       * the palette over the game boots asking the app for nothing. */
      if (Terminal.charts === null && String(line).trim()) {
        Terminal.charts = [];
        Terminal.loadCharts().then(function (list) { if (list.length && cmd.value === line) refresh(); });
      }
      /* On an EMPTY line what is waiting leads, because that is the question
       * an empty ⌘K is asking. With something typed the words lead, because
       * then you already know what you want. */
      items = suggestFor(line).concat(searchFor(line));
      cursor = items.length ? 0 : -1;
      picked = false;
      paint();
      askSearch(line);
    }

    /* Rows already in hand for this line. Nothing waits on them: they are the
     * empty list until the answer lands, and `askSearch` repaints when it does. */
    function searchFor(line) {
      var q = Terminal.searchSubject(line);
      var hits = q == null ? null : searchCache[q];
      return hits ? Terminal.searchRows(line, hits) : [];
    }

    function askSearch(line) {
      var q = Terminal.searchSubject(line);
      if (q == null || searchCache[q]) return;
      if (searchTimer) clearTimeout(searchTimer);
      var mine = ++searchSeq;
      searchTimer = setTimeout(function () {
        invoke('mcp_player_search', { query: q }).then(function (res) {
          var hits = (res && (res.results || res.players)) || res || [];
          searchCache[q] = Array.isArray(hits) ? hits : [];
          // A later keystroke owns the box; do not repaint under it.
          if (mine !== searchSeq || Terminal.searchSubject(cmd.value) !== q) return;
          items = suggestFor(cmd.value).concat(searchFor(cmd.value));

          if (cursor < 0 && items.length) cursor = 0;
          paint();
        }).catch(function () {
          // A search that cannot be made is simply no extra rows — never an
          // error page where the completions go.
          searchCache[q] = [];
        });
      }, 120);   // the search is a local scan now; the debounce is the only latency left
    }
    function close() { items = []; cursor = -1; show(false); }
    function run(line) {
      var ok = Terminal.execute(line);
      if (ok) {
        cmd.value = '';
        if (cmdHistory[0] !== line) cmdHistory.unshift(line);
        if (cmdHistory.length > HISTORY_MAX) cmdHistory.length = HISTORY_MAX;
        histAt = -1;
        close();
        Terminal.closePalette();
      } else {
        cmd.classList.add('is-err');
      }
      return ok;
    }
    function accept(i) {
      var it = items[i];
      if (!it) return;
      if (it.run) { run(it.line); return; }
      // A word that still needs an argument: put it in the box with the caret
      // after it rather than running something incomplete.
      cmd.value = it.line;
      cmd.focus();
      refresh();
    }
    cmd.addEventListener('input', function () { cmd.classList.remove('is-err'); histAt = -1; refresh(); });
    cmd.addEventListener('focus', refresh);
    cmd.addEventListener('blur', function () { setTimeout(close, 120); });
    /* Escape on KEYUP as well: framed over the game (WKWebView, the frame's
     * input focused) the keydown for Escape alone never reached the page —
     * arrows and letters did — while the keyup still does. Seen live on
     * 2026-09-10; the scrim click closed it, the key did not. Harmless when
     * the keydown already closed it: there is nothing left to close. */
    cmd.addEventListener('keyup', function (e) {
      if (e.key !== 'Escape') return;
      var p = palette();
      if (p && !p.hidden) { close(); Terminal.closePalette(); }
    });
    cmd.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); Terminal.closePalette(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var down = e.key === 'ArrowDown';
        if (items.length) {
          e.preventDefault();
          cursor = (cursor + (down ? 1 : -1) + items.length) % items.length;
          picked = true;
          paint();
          return;
        }
        // No menu: the arrows are history. Up from an unrun line keeps that
        // line as the draft, so walking back and forth never eats it.
        if (!cmdHistory.length) return;
        e.preventDefault();
        if (histAt === -1 && !down) draft = cmd.value;
        histAt = Math.min(cmdHistory.length - 1, Math.max(-1, histAt + (down ? -1 : 1)));
        cmd.value = histAt === -1 ? draft : cmdHistory[histAt];
        return;
      }
      if (e.key === 'Tab' && items.length) { e.preventDefault(); accept(cursor < 0 ? 0 : cursor); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      /* Enter does what you TYPED, unless you deliberately picked a row.
       *
       * `MKT` opens the market even though MARGINS and MARKET sit under it,
       * and `2-29604` opens the planet even though the menu is offering seven
       * other things to ask of it. The completion wins in exactly two cases:
       * you arrowed to it, or what you typed is not a command at all — which
       * is when Enter would otherwise do nothing. */
      if ((picked || !Terminal.canRun(cmd.value)) && items.length && cursor >= 0) { accept(cursor); return; }
      run(cmd.value);
    });
  }

  // ── HELP: every word the command line understands, as a card ───────────
  // The reference is the words themselves: each row is a word, what it
  // opens, and the argument it takes. Click a row: a word with no argument
  // opens its card; one that needs an argument lands in the command box with
  // the caret after it. The bare-id forms and the workspace verbs are rows too.
  var ARG_LABEL = { id: '<id>', ids: '<id id …>', rules: '<rule …>', section: '<section>', optid: '[id]' };
  function helpLine(words, what, arg, onClick) {
    var r = H.el('a', 'sui-data-card-row tm-help-row');
    r.href = 'javascript:void(0)';
    var left = H.el('span', 'tm-help-words');
    left.appendChild(H.el('b', null, words));
    if (arg) { left.appendChild(document.createTextNode(' ')); left.appendChild(H.el('span', 'ops-muted', arg)); }
    r.appendChild(left);
    r.appendChild(H.el('span', 'ops-val', what));
    r.addEventListener('click', function (ev) { ev.preventDefault(); onClick(); });
    return r;
  }
  function fillCommand(text) {
    var box = document.getElementById('tm-cmd');
    if (!box) return;
    box.value = text;
    box.classList.remove('is-err');
    box.focus();
  }
  /* Every word that opens a card, filed under the SAME areas the palette
   * files them under. Sorted-by-label was a flat list of sixty-two rows in
   * which nothing could be found; the areas are the vocabulary the tabs
   * already teach, so the reference and the palette agree. */
  function helpWordsByType() {
    var by = {};
    Object.keys(WORDS).forEach(function (word) {
      var w = WORDS[word];
      (by[w[0]] = by[w[0]] || { arg: w[1] || '', words: [] }).words.push(word);
    });
    return by;
  }

  Terminal.register('help', {
    label: 'Commands', single: true, defaultWidth: 2, defaultHeight: 'grow',
    describe: function () { return 'Commands'; },
    render: function (host) {
      host.innerHTML = '';
      var list = H.el('div', 'tm-help');
      var by = helpWordsByType();

      var section = function (name) {
        var h = H.el('div', 'tm-help-h fstat-l', name);
        list.appendChild(h);
      };
      var line = function (words, what, arg, onClick) {
        list.appendChild(helpLine(words, what, arg, onClick));
      };

      /* ── The cards, by area ──────────────────────────────────────────── */
      Terminal.groups().forEach(function (g) {
        var rows = g.options.filter(function (o) { return by[o.value]; });
        if (!rows.length) return;
        section(g.group);
        rows.forEach(function (o) {
          var e = by[o.value];
          var arg = e.arg && e.arg !== 'config' ? ARG_LABEL[e.arg] || e.arg : '';
          var first = e.words[0];
          /* A fixed set is worth naming: `<section>` is a prompt, `universe ·
           * trends · …` is the answer. */
          var opts = choiceOptionsFor(first);
          if (opts) arg = opts.map(function (x) { return x.value; }).join(' · ');
          line(e.words.join(' · '), o.label, arg, function () {
            if (arg) fillCommand(first + ' '); else Terminal.execute(first);
          });
        });
      });

      /* ── Subjects ──────────────────────────────────────────────────────
       * The half of the grammar a list of WORDS cannot show, and the half an
       * expert actually uses. The forgiving forms are new and nothing else
       * announces them: a name or a player id now stands in for whatever id
       * the card wants. */
      section('Subjects');
      line('1-…  ·  0-…  ·  2-…  ·  9-…', 'Player · Guild · Planet · Fleet, by id', '',
        function () { fillCommand('1-61'); });
      line('<id> <word>', 'Any word above, asked of that object', '',
        function () { fillCommand('2-29604 '); });
      line('<name>', 'A callsign finds the player, their planet and their fleet', '',
        function () { fillCommand('jpeg'); });
      line('<word> <name>', 'And resolves to the id that word wants — PLANET jpeg', '',
        function () { fillCommand('PLANET jpeg'); });
      line('<word> 1-…', 'A player id does the same — PLANET 1-61 opens their planet', '',
        function () { fillCommand('PLANET 1-61'); });
      line('⌘K  ·  Ctrl-K', 'Open this command line from anywhere', '',
        function () { Terminal.openPalette(); });

      /* ── Comms: words that open the WINDOW, at a subject ─────────────── */
      section('Comms');
      line('COMMS · INBOX · DMS · UNREAD', 'Open Comms', '', function () { Terminal.execute('COMMS'); });
      line('DM · MSG · MESSAGE · TALK · CHAT', 'A player\'s conversation, by id or name', '<player>', function () { fillCommand('DM '); });
      line('ROOM', 'A conversation, by subject — 2-15361 · 1-61 · #trade', '<id · #alias>', function () { fillCommand('ROOM '); });
      line('WHO · INROOM', 'Who is in a conversation', '<id · #alias>', function () { fillCommand('WHO '); });
      line('CHANNELS · BROWSE · DIRECTORY', 'Every guild\'s channels', '', function () { Terminal.execute('CHANNELS'); });
      line('FIND · SEARCH', 'Search everything said', '<text>', function () { fillCommand('FIND '); });
      line('SAY', 'Draft a line — SAY 2-15361 <text> in that room, SAY <text> where you are', '<text>', function () { fillCommand('SAY '); });

      /* ── The workspace verbs, which open no card ─────────────────────── */
      section('Workspace');
      /* The words whose target is not a CARD, so the loop above never sees
       * them: the settings page is a page, and PRESET is a verb. Listed by
       * hand here, and the harness checks every word in the vocabulary
       * reaches this reference — which is how their absence was caught. */
      line('SETTINGS · CONFIG', 'Settings', '', function () { Terminal.execute('SETTINGS'); });
      line('PRESET · PRESETS', Object.keys(PRESETS).join(' · '), '<name>', function () { fillCommand('PRESET '); });
      line('SHARE', 'Share this workspace as a code', '', function () { Terminal.execute('SHARE'); });
      line('IMPORT', 'Open a workspace someone shared', '<code>', function () { fillCommand('IMPORT '); });
      // The bar's RESET button went with the bar; this is the same verb.
      line('RESET', 'Back to the default page', '', function () { Terminal.execute('RESET'); });
      // PET is deliberately NOT listed. The companion is gated off in Rust
      // (`companion.json` → `enabled`), and a reference entry for something
      // that answers "switched off" is worse than no entry. The verb itself
      // still parses and still works, so turning the flag on needs no change
      // here — see `mcp/companion.rs`.

      host.appendChild(list);
      return Promise.resolve();
    },
  });

  // ── Cadence: one 1s tick for every mounted card ─────────────────────────
  setInterval(function () {
    if (document.visibilityState === 'hidden' || Board.current !== 'terminal') return;
    var now = Date.now();
    paintClock();
    Object.keys(state.mounted).forEach(function (id) {
      var m = state.mounted[id];
      if (!m.def) return;
      paintAge(id);
      if (m.busy) return;
      var c = findCard(id);
      var every = c ? cadenceOf(c) : (m.def.cadenceMs || 0);
      if (!every) return;
      if (now - m.lastRun >= every) refresh(id, false);
    });
  }, 1000);

  // ── Shared: the Comms reference cards, for the inspector and the watchlist
  var refs = null;
  // Shared with the ops cards, which act on the same reference records.
  Terminal.ensureRefs = function () { return ensureRefs(); };
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
        var card = G.cards.liveness(G.state.snap.totals || {});
        // A list of who is playing right now, where the names went nowhere.
        card.addEventListener('click', function (ev) {
          var line = ev.target && ev.target.closest ? ev.target.closest('.pc-person[data-player-id]') : null;
          if (!line || (ev.target.closest && ev.target.closest('.pc-act'))) return;
          add('player', { id: line.getAttribute('data-player-id') });
        });
        host.appendChild(card);
      });
    },
  });

  var STATS_SECTIONS = [
    { value: 'universe', label: 'Universe' }, { value: 'trends', label: 'Trends' }, { value: 'engine', label: 'Our engine' },
    { value: 'ore', label: 'Ore economy' }, { value: 'raids', label: 'Raid pressure' }, { value: 'players', label: 'Best players' },
    { value: 'guilds', label: 'Best guilds' },
  ];
  Terminal.register('stats', {
    label: 'Galaxy statistics', defaultWidth: 2,
    describe: function (p) { var s = STATS_SECTIONS.filter(function (x) { return x.value === p.section; })[0]; return s ? s.label : (p.section || '?'); },
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
    label: 'Energy market', defaultWidth: 2,
    describe: function (p) { return 'Energy market' + (p.policy ? ' · ' + p.policy : ''); },
    params: [{ key: 'policy', label: 'Offers', kind: 'choice', options: [
      { value: '', label: 'every offer' }, { value: 'open', label: 'open market' }, { value: 'guild', label: 'guild only' },
    ] }],
    cadenceMs: 60000,
    render: function (host, p) {
      return invoke('terminal_market').then(function (m) {
        host.innerHTML = '';
        var all = (m && m.providers) || [];
        var list = all.filter(function (c) {
          if (!p.policy) return true;
          var open = (c.provider || {}).open === true || String(c.policy || '') === 'openMarket';
          return p.policy === 'open' ? open : !open;
        });
        /* The board's own summary, the way a quote screen opens: what the
         * cheapest capacity in the galaxy costs, what the middle of the market
         * costs, and how much of it you can actually buy. None of this was
         * answerable before — offers are quoted in different guilds' tokens,
         * so "cheapest" had no meaning until they were all restated. */
        var fmtQ = function (v) { return v == null ? '—' : H.fmtAlpha(v * 1e6); };
        var strip = H.el('div', 'hstrip tm-tiles');
        strip.appendChild(H.statTile(['best', 'alpha / kW / day'], fmtQ(m && m.best_alpha_per_kw_day), null,
          (m && m.best_alpha_per_kw_day) != null ? 'ok' : 'muted'));
        strip.appendChild(H.statTile(['median', 'alpha / kW / day'], fmtQ(m && m.median_alpha_per_kw_day)));
        strip.appendChild(H.statTile(['open', 'capacity for sale'], m && m.open_capacity_mw ? H.fmtWatts(m.open_capacity_mw) : '—'));
        host.appendChild(strip);
        var head = H.el('div', 'tm-cap');
        head.appendChild(H.el('span', 'fstat-l', list.length + ' offer' + (list.length === 1 ? '' : 's')
          + (list.length !== all.length ? ' of ' + all.length : '')
          + (m && m.unpriced ? ' · ' + m.unpriced + ' unpriced' : '')
          + (m && m.height ? ' · block ' + H.fmtInt(m.height) : '')));
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
      /* The lead reading, because it is the only one that compares. Rust
       * restates every offer in alpha per kilowatt per day off the guild
       * banks' collateral ratios; an offer it could not price says so on
       * hover rather than being quoted at par. */
      comparable: p.alpha_per_kw_day != null
        ? { value: H.fmtAlpha(p.alpha_per_kw_day * 1e6), unit: '/ kW / day',
            title: 'Comparable price, from ' + (p.fx_source || 'the chain') + ' — every offer in one unit' }
        : null,
      capacity: p.capacity_min != null ? { min: p.capacity_min_text || H.fmtInt(p.capacity_min) + 'W', max: p.capacity_max_text || H.fmtInt(p.capacity_max) + 'W' } : null,
      duration: p.duration_min != null ? { min: p.duration_min_text || H.fmtInt(p.duration_min), max: p.duration_max_text || H.fmtInt(p.duration_max), blocks: H.fmtInt(p.duration_min) + ' – ' + H.fmtInt(p.duration_max) + ' blocks' } : null,
      owner: card.owner && card.owner.id ? { id: card.owner.id, name: card.owner.name, tag: card.owner.tag, pfp: card.owner.pfp_attrs } : null,
    }, { actions: acts }));
    return box;
  }

  /* ── Where we stand with someone ─────────────────────────────────────────
   *
   * The team keeps four lists — grudges, allied guilds, priority guilds, and
   * players who are off-limits — and until now they were visible only on the
   * WAR cards that own them. Everywhere else a player was a name and a
   * portrait, so you could open a dossier on someone your own team has marked
   * NEVER ATTACK and read nothing about it.
   *
   * That is the half of the social layer that costs something when it is
   * missing: the automation obeys these lists, and a person clicking Raid
   * should see what the automation sees.
   */
  var standing = { at: 0, p: null };
  function standingLists() {
    var now = Date.now();
    if (!standing.p || now - standing.at > 30000) {
      standing.at = now;
      standing.p = invoke('mcp_war_bundle')
        .then(function (d) { return (d && d.lists) || {}; })
        .catch(function () { return {}; });
    }
    return standing.p;
  }
  /* `{ badge, note }` — or null when we have no view of them, which is the
   * ordinary case and must not draw anything. */
  function standingOf(lists, playerId, guildId, opts) {
    if (!lists || !playerId) return null;
    /* `personOnly` for a view whose SUBJECT is the guild: "their guild is
     * allied" on every row of that guild's own member list is a property of
     * the card, not of the person, and it drowns out the two standings that
     * are about the individual. */
    var personOnly = !!(opts && opts.personOnly);
    var has = function (arr, v) { return Array.isArray(arr) && v && arr.indexOf(v) >= 0; };
    // Off-limits outranks everything: it is the one that stops an action.
    if (has(lists.protected_players, playerId)) {
      return { badge: { text: 'OFF-LIMITS', mod: 'warning' }, note: 'on our never-attack list' };
    }
    var g = (lists.grudges || []).filter(function (x) { return x.player_id === playerId; })[0];
    if (g && !g.expired && !g.muted) {
      var bits = [];
      if (g.attacks) bits.push(g.attacks + ' attack' + (g.attacks === 1 ? '' : 's'));
      if (g.structs_lost) bits.push(g.structs_lost + ' struct' + (g.structs_lost === 1 ? '' : 's') + ' lost');
      if (g.ore_lost) bits.push(H.fmtOre(g.ore_lost) + ' ore lost');
      return { badge: { text: 'GRUDGE', mod: 'destructive' }, note: bits.join(' · ') || 'on our grudge list' };
    }
    if (!personOnly && has(lists.allies, guildId)) return { badge: { text: 'ALLY', mod: 'solid' }, note: 'their guild is allied' };
    if (!personOnly && has(lists.priority_guilds && lists.priority_guilds.map(function (x) { return x.guild_id || x; }), guildId)) {
      return { badge: { text: 'PRIORITY', mod: 'warning' }, note: 'their guild is a priority target' };
    }
    if (g && g.muted) return { badge: { text: 'GRUDGE MUTED', mod: 'default' }, note: 'muted' };
    return null;
  }
  Terminal.standingOf = standingOf;
  Terminal.standingLists = standingLists;

  // The player entity's own shape, the way Explore reads it (board-pages.js).
  var entP = function (ent) { return (ent && ent.Player) || {}; };
  var entS = function (ent, k) { var v = entP(ent)[k]; return v == null || v === '' ? null : String(v); };
  var entN = function (ent, path) {
    var cur = ent;
    for (var i = 0; i < path.length && cur != null; i++) cur = cur[path[i]];
    if (cur == null) return null;
    var n = typeof cur === 'string' ? Number(cur) : cur;
    return typeof n === 'number' && isFinite(n) ? n : null;
  };
  Terminal.register('player', {
    label: 'Watch a player', describe: function (p) { return 'Player ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Player id', kind: 'id', kinds: [1], placeholder: '1-194' }],
    cadenceMs: 60000,
    doors: function (card) {
      var id = (card.params || {}).id;
      return id ? [{ icon: 'icon-combat-log', title: 'Tearsheet', onClick: function () { add('sheet', { id: id }); } }] : [];
    },
    /* `mcp_player_profile`, not `mcp_player_detail`.
     *
     * Detail answers a different question — it is the ROSTER's record, and for
     * anybody who is not one of our virtual players it returns the literal
     * name "primary" with no alpha, no ore, no portrait and no guild. That is
     * exactly what this card drew: a title reading PRIMARY over an empty
     * frame. Profile is the read Explore uses, so this card and that page
     * cannot disagree; detail is still asked for the struct count, and a
     * failure of either half leaves a blank field, never an error page. */
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a player id.')); return; }
      var soft = function (name, args) { return invoke(name, args).catch(function () { return null; }); };
      return Promise.all([
        soft('mcp_player_profile', { player: p.id }),
        soft('mcp_player_detail', { player: p.id }),
        soft('mcp_player_search', { query: p.id }),
        standingLists(),
      ]).then(function (res) {
        var d = res[0] || {}, det = res[1] || {};
        var hit = ((res[2] && res[2].results) || []).filter(function (x) { return x.player_id === p.id; })[0] || null;
        var ent = d.entity || {};
        host.innerHTML = '';
        var id = d.player_id || det.player_id || p.id;
        // Names: the chain's own first, then the roster's (which is the
        // callsign we gave a virtual player), then the id.
        var name = entS(ent, 'name') || (hit && hit.username) || (det.name && det.name !== 'primary' ? det.name : null) || id;
        var attrs = entS(ent, 'pfpClientRenderAttributes') || (hit && hit.pfp) || null;
        if (!res[0] && !res[1] && !hit) { host.appendChild(H.stateBlock('info', 'No player ' + p.id)); return; }
        var alpha = entN(ent, ['playerInventory', 'rocks', 'amount']);
        var ore = entN(ent, ['gridAttributes', 'ore']);
        var load = (entN(ent, ['gridAttributes', 'load']) || 0) + (entN(ent, ['gridAttributes', 'structsLoad']) || 0);
        var cap = (entN(ent, ['gridAttributes', 'capacity']) || 0) + (entN(ent, ['gridAttributes', 'connectionCapacity']) || 0);
        var reads = [];
        if (alpha != null) reads.push({ value: H.fmtAlpha(alpha), icon: 'sui-icon-alpha-matter', title: 'Alpha matter' });
        if (ore != null) reads.push({ value: H.fmtOre(ore), icon: 'sui-icon-alpha-ore', title: 'Ore held' });
        if (cap || load) reads.push({ value: H.fmtWatts(load) + ' / ' + H.fmtWatts(cap), icon: 'sui-icon-energy', title: 'Energy used of available' });
        if (det.struct_count != null) reads.push({ value: H.fmtInt(det.struct_count), icon: 'sui-icon-deployed-structs', title: 'Structs built' });
        var gid = entS(ent, 'guildId') || (hit && hit.guild_id) || null;
        var stand = standingOf(res[3], id, gid);
        var g = d.guild || null;
        var planetId = entS(ent, 'planetId') || (hit && hit.planet_id) || null;
        var fleetId = entS(ent, 'fleetId') || (hit && hit.fleet_id) || null;
        /* The chips open the SAME window the watch doors used to — the full
         * map viewer — so the two icon doors that duplicated them are gone.
         * Over the web, where no window can open, the card is what there is. */
        var watch = function (opts, fallback) {
          if (Board.canSpectate && Board.canSpectate() && Board.openSpectatorWindow) {
            Board.openSpectatorWindow(opts).catch(fallback);
          } else fallback();
        };
        var chips = [];
        if (gid) chips.push(window.StructsGuildCard.chip({ id: gid, name: g && g.name, tag: g && g.tag }, { onClick: function () { add('guild', { id: gid }); } }));
        if (planetId) chips.push(window.StructsCards.planet.chip({ id: planetId }, { onClick: function () { watch({ planet_id: planetId }, function () { add('planet', { id: planetId }); }); } }));
        if (fleetId) chips.push(window.StructsCards.fleet.chip({ id: fleetId }, { onClick: function () { watch({ fleet_id: fleetId }, function () { add('map', { id: fleetId }); }); } }));
        // The guild's record of what this player has DONE. `null` is not zero:
        // a guild that does not publish one of these leaves a dash.
        var stat = function (v, key) { var n = v == null ? null : (key ? v[key] : v); if (n == null) return null; var f = Number(n); return isFinite(f) ? f : null; };
        var mined = stat(d.ore_stats, 'mined'), seized = stat(d.ore_stats, 'seized');
        var planets = stat(d.planets_completed, 'count'), raids = stat(d.raids_launched, 'count');
        var record = (mined != null || seized != null || planets != null || raids != null) ? [
          { label: 'planets', value: planets == null ? null : H.fmtInt(planets) },
          { label: 'raids', value: raids == null ? null : H.fmtInt(raids) },
          { label: 'mined', value: mined == null ? null : H.fmtOre(mined) },
          { label: 'stolen', value: seized == null ? null : H.fmtOre(seized) },
        ] : [];
        /* Three doors, one row: send them Alpha, message them, share them.
         * Everything about this player is INSIDE the frame now; the buttons
         * that used to sit under it are the header's doors. */
        var send = { icon: 'icon-transfers', title: 'Send Alpha to ' + name, onClick: function () { add('deliver', { to: id, name: name }); } };
        var card = window.StructsPlayerCard.card({
          id: id, name: name, pfp: attrs,
          presence: Board.presenceDot && Board.presenceDot(id),
          guild: g ? ((g.tag ? '[' + g.tag + '] ' : '') + (g.name || gid || '')).trim() : gid,
          /* Where we STAND with them outranks what role they play for us: a
           * dossier on someone our own team has marked never-attack should
           * say so on the card, not three cards away on the WAR page. */
          badge: (stand && stand.badge) || (det.role && det.role !== 'primary' ? { text: String(det.role).toUpperCase(), mod: 'default' } : null),
          marks: stand ? [{ icon: 'sui-icon sui-icon-md icon-defend', value: stand.note, title: 'Our standing with them — ' + stand.note }] : null,
          readings: reads,
        }, { actions: [send].concat(Board.reachActions ? Board.reachActions({ player_id: id, player_name: name }) : []),
             objects: chips, record: record });
        host.appendChild(card);
      });
    },
  });

  /* ── The service record ──────────────────────────────────────────────────
   *
   * What a player has DONE, as tiles. Both this and `tally` read one command,
   * `terminal_achievements`, which caches per player for three minutes — so
   * two of these cards on the same page cost one walk, not two.
   *
   * The catalogue, the tier ladder and both renderers live in
   * `structs-achievements.js`; this is only the wiring. That is deliberate:
   * the ladder is the part that will be tuned once the thing is live, and it
   * should be tunable without opening a 3,000-line file.
   *
   * The card takes an id, so it works on ANYONE. That makes it a scouting
   * instrument as much as a trophy case, which is also why `tally` is filed
   * under War rather than beside this one. */
  Terminal.register('record', {
    /* Two wide by default, not one. A 96px tile track fits only TWO columns in
     * a ~290px card body, which makes 37 tiles nineteen rows tall; at two
     * columns' width it is six across and reads as a rack. A player who wants
     * it narrow sets a family instead, which is what that param is for. */
    label: 'Service record', defaultWidth: 2, defaultHeight: 'grow',
    describe: function (p) { return 'Record ' + (p.id || '?'); },
    params: [
      { key: 'id', label: 'Player id', kind: 'id', kinds: [1], placeholder: '1-194' },
      { key: 'family', label: 'Section', kind: 'choice', options: [
        { value: '', label: 'everything' },
        { value: 'raid', label: 'raiding' },
        { value: 'war', label: 'destruction' },
        { value: 'gun', label: 'gunnery' },
        { value: 'def', label: 'defense' },
        { value: 'econ', label: 'industry' },
        { value: 'build', label: 'construction' },
      ] },
    ],
    cadenceMs: 120000,
    doors: function (card) {
      var id = (card.params || {}).id;
      if (!id) return [];
      return [
        { icon: 'icon-combat-log', title: 'Hull tally', onClick: function () { add('tally', { id: id }); } },
        { icon: 'icon-member', title: 'The player', onClick: function () { add('player', { id: id }); } },
      ];
    },
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a player id.')); return; }
      var A = window.StructsAchievements;
      if (!A) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', 'the achievement catalogue did not load')); return; }
      return invoke('terminal_achievements', { player: p.id }).then(function (d) {
        host.innerHTML = '';
        host.appendChild(A.rack(d, { onlyFamily: p.family || null }));
      });
    },
  });

  /* ── The hull tally ──────────────────────────────────────────────────────
   *
   * "Destroy [#] [Struct]" over 22 hull types × three verbs is 66 rows in a
   * list and one table here. It is also a real intel read: what an opponent
   * actually flies, what it has killed, and in which ambit — which given how
   * much of the roster has no viable shot into water is a fight-deciding
   * question, not decoration.
   *
   * Five columns will not fit a one-wide card, so a narrow card is configured
   * down to one rather than scrolling four off its own edge. */
  Terminal.register('tally', {
    label: 'Hull tally', defaultWidth: 2, defaultHeight: 'grow',
    describe: function (p) { return 'Tally ' + (p.id || '?'); },
    params: [
      { key: 'id', label: 'Player id', kind: 'id', kinds: [1], placeholder: '1-194' },
      { key: 'columns', label: 'Columns', kind: 'choice', options: [
        { value: '', label: 'all five' },
        { value: 'kills', label: 'kills only' },
        { value: 'destroyed', label: 'destroyed only' },
        { value: 'damage', label: 'damage only' },
        { value: 'built,lost', label: 'built and lost' },
      ] },
    ],
    cadenceMs: 120000,
    doors: function (card) {
      var id = (card.params || {}).id;
      if (!id) return [];
      return [{ icon: 'icon-success', title: 'Service record', onClick: function () { add('record', { id: id }); } }];
    },
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a player id.')); return; }
      var A = window.StructsAchievements;
      if (!A) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', 'the achievement catalogue did not load')); return; }
      var cols = p.columns ? String(p.columns).split(',') : null;
      return invoke('terminal_achievements', { player: p.id }).then(function (d) {
        host.innerHTML = '';
        host.appendChild(A.matrix(d, { columns: cols }));
      });
    },
  });

  Terminal.register('guild', {
    label: 'Watch a guild', describe: function (p) { return 'Guild ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Guild id', kind: 'id', kinds: [0], placeholder: '0-1' }],
    cadenceMs: 60000, usesRefs: true,
    // The chain's own record first (`matrix_refs`, the same read Comms uses):
    // a guild absent from the leaderboard used to render nothing at all.
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a guild id.')); return; }
      var R = ensureRefs();
      var ref = R && R.cards[p.id];
      if (R && ref === undefined) R.wantRefs([p.id]);
      var G = Board._gamestats;
      return G.ensureBoot().then(function () {
        host.innerHTML = '';
        var g = ((G.state.snap && G.state.snap.guilds) || []).filter(function (x) { return x.guild_id === p.id; })[0];
        var st = (ref && ref.stats) || {};
        if (!g && !ref) { host.appendChild(H.stateBlock('info', 'Looking up ' + p.id + '…')); return; }
        var reads = [];
        var push = function (v, icon, title) { if (v != null && v !== '') reads.push({ value: v, icon: icon, title: title }); };
        push(g ? H.fmtInt(g.players) : st.members_text, 'sui-icon-players', 'Members');
        push(g ? H.fmtAlpha(g.alpha) : st.alpha_text, 'sui-icon-alpha-matter', 'Alpha');
        push(g ? H.fmtWatts(g.structs_load) : st.capacity_text, 'sui-icon-energy', 'Structs load');
        push(g ? H.fmtInt(g.planets) : st.planets_text, 'sui-icon-md icon-planet', 'Planets');
        host.appendChild(window.StructsGuildCard.card({
          id: p.id,
          name: (ref && ref.title) || (g && g.name) || null,
          tag: (ref && ref.tag) || (g && g.tag) || null,
          logo: (ref && ref.logo) || (g && g.logo) || null,
          readings: reads,
          owner: ref && ref.owner && ref.owner.id ? { id: ref.owner.id, name: ref.owner.name, tag: ref.owner.tag, pfp: ref.owner.pfp_attrs } : null,
        }, {}));
        host.appendChild(doorRow([
          { label: 'Guild token', onClick: function () { add('gt', { id: p.id }); } },
          { label: 'Tearsheet', onClick: function () { add('sheet', { id: p.id }); } },
        ]));
      });
    },
  });

  // Any object by id — the Comms reference card, which knows every kind.
  Terminal.register('inspector', {
    label: 'Inspect an object', usesRefs: true,
    describe: function (p) { return 'Inspect ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Object id', kind: 'id', kinds: null, placeholder: '5-4559 · 4-4 · 10-1' }],
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
    render: function (host, p, ctx) {
      host.innerHTML = '';
      var ids = String(p.ids || '').split(/[\s,]+/).filter(function (s) { return /^\d{1,2}-\d{1,9}$/.test(s); });
      if (!ids.length) {
        host.appendChild(H.stateBlock('info', 'Configure this card with the ids to watch.'));
        // The commonest watchlist is your own things, and typing them out is
        // the only reason not to have one.
        host.appendChild(doorRow([{ label: 'Watch my own', primary: true, onClick: function () {
          invoke('mcp_roster').then(function (snap) {
            var me = ((snap && snap.rows) || []).filter(function (r) { return r.role === 'primary'; })[0] || ((snap && snap.rows) || [])[0];
            var mine = [me && me.player_id, me && me.planet_id, me && me.fleet_id, me && me.guild_id].filter(Boolean);
            if (!mine.length) { Board.stamp && Board.stamp('no roster yet'); return; }
            setParams(ctx.id, { ids: mine.join(' ') });
          }).catch(function (e) { Board.stamp && Board.stamp('roster: ' + e); });
        } }]));
        return;
      }
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

  // ══════════════════════════════════════════════════════════════════════════
  // THE FEED — a pulse band over lanes.
  //
  // Rebuilt 2026-09-09 from the app's own durable log: 610,919 GRASS frames
  // across seven days. Three numbers out of that reading decided the shape,
  // and the old tape contradicted all three.
  //
  //   ~1 frame per SECOND at the median (3,566/hour; 8,886 at peak). A 40-row
  //   list is forty seconds of chain. Any question worth asking of the feed is
  //   outside it, so the card carries a PULSE band — one bar an hour over up to
  //   a week — and the list answers only "what is in the hour I clicked".
  //
  //   Combat is 0.017% — 104 `struct_attack` in a week against 92,301 `block`.
  //   At 5,000:1 combat cannot survive in a single ordered list at any height,
  //   so the rows are dealt into fixed LANES. The war lane keeps its space on a
  //   quiet day; economy volume can never take it.
  //
  //   `struct_status` is three events wearing one name: 0→1 build start
  //   (29,815), 1→7 online (31,111), 7→35 DESTROYED (25,913). A quarter of the
  //   second-largest category is structs dying and the old tape drew all three
  //   the same. (Of those 25,913 deaths only 74 had an attack within five
  //   seconds — the rest are brownout cascades, which is why a destruction is
  //   not filed under war.)
  //
  // It also folds in the ops feed, which was a separate card showing a
  // different thing in the same shape with nothing saying which was which.
  // One card, two sources, each row labelled.

  var STATUS_DESTROYED = 35;

  // Lanes, in the order they are drawn. `cats` is matched against the real
  // category names the server hands back — never a regex, because
  // `shield_change` (29,341/week) and `struct_defense_add` (14,652) look
  // martial and are peacetime housekeeping. Anything unmatched lands in
  // `chain`, so a category nobody wrote a rule for is quiet, not lost.
  var LANES = [
    { key: 'war', label: 'War', icon: 'icon-raid', hot: true,
      cats: ['struct_attack', 'raid_status', 'block_raid_start', 'seized', 'forfeited'] },
    { key: 'structs', label: 'Structs', icon: 'icon-deploy',
      cats: ['struct_status', 'struct_health', 'struct_block_build_start',
             'struct_defense_add', 'struct_defense_remove', 'struct_block_ore_mine_start',
             'struct_block_ore_refine_start'] },
    { key: 'grid', label: 'Grid', icon: 'icon-unpowered',
      cats: ['structsLoad', 'shield_change', 'connectionCapacity', 'connectionCount',
             'load', 'capacity', 'power', 'nonce', 'proofs'] },
    { key: 'economy', label: 'Economy', icon: 'icon-refine',
      cats: ['ore', 'mined', 'refined', 'minted', 'sent', 'received', 'infused',
             'burned', 'transfer', 'allocation', 'agreement', 'provider'] },
    { key: 'ops', label: 'Our loops', icon: 'icon-computer', ours: true, cats: [] },
    { key: 'chain', label: 'Chain', icon: 'icon-signal-jam', quiet: true, cats: [] },
  ];
  var LANE_OF = {};
  LANES.forEach(function (L) { L.cats.forEach(function (c) { LANE_OF[c] = L.key; }); });
  var laneOf = function (cat) { return LANE_OF[String(cat || '')] || 'chain'; };

  var SPANS = [
    { value: '6', label: '6 hours' }, { value: '24', label: '24 hours' },
    { value: '48', label: '2 days' }, { value: '168', label: '7 days' },
  ];

  /* A grass category is a chain event name, not a word: `struct_block_ore_
   * mine_status` filled the whole line as a badge and left no room for what
   * the frame said. Drop the tokens every event shares and keep the two that
   * distinguish it. The full category stays on hover. */
  var TAPE_NOISE = { structs: 1, struct: 1, block: 1, status: 1, event: 1, grid: 1, index: 1, id: 1, attributes: 1, msg: 1 };
  var tapeKind = function (cat) {
    var toks = String(cat || 'event').toLowerCase().split(/[._]/).filter(Boolean);
    var keep = toks.filter(function (t) { return !TAPE_NOISE[t]; });
    if (!keep.length) keep = toks;
    return keep.slice(-2).join(' ') || 'event';
  };
  /* A grass subject is a store key — `grid.planet.2-29604.1-2655`. What it is
   * about is the last word before the ids, and the ids themselves (an owner
   * repeated as its own subject is one id, not two). */
  var tapeSubject = function (subj) {
    var toks = String(subj || '').split('.').filter(Boolean);
    var ids = [], words = [];
    toks.forEach(function (t) {
      if (/^\d{1,2}-\d{1,9}$/.test(t)) { if (ids.indexOf(t) < 0) ids.push(t); }
      // Every inventory subject ENDS in a 44-character bech32 address, which
      // is not a word: as the head of the line it filled the header and left
      // nothing for the ids beside it. Shortened here, whole on hover — the
      // same trade the Pay window makes with a recipient's address.
      else if (/^structs1[0-9a-z]{20,}$/.test(t)) { var sh = t.slice(0, 12) + '…' + t.slice(-6); if (ids.indexOf(sh) < 0) ids.push(sh); }
      else words.push(t);
    });
    return { word: words.length ? words[words.length - 1] : '', ids: ids };
  };

  /* `struct_block_build_start` is the SECOND category that covers two opposite
   * events under one name, and this one had the card saying the opposite of
   * what happened. Measured over the durable log:
   *
   *   block > 0  →  the struct entered BUILDING   (2,473 of a 3,000 sample
   *                 reached status 1 within five seconds)
   *   block = 0  →  the struct was DESTROYED      (15,137 of 15,305 had a
   *                 7 → 35 within five seconds — 98.9%)
   *
   * A third of every "BUILD START" row the card drew was a build proof-window
   * being CLEARED because the struct died, which is why the live board showed
   * `BUILD START ×8` sitting beside `DESTROYED ×8` for one player in one
   * second. The death is already a row of its own — it is one of the ~9 frames
   * a single death emits — so the duplicate is dropped rather than relabelled.
   * That is the same act-fold that turns six frames of a refine into one line. */
  var isBuildCleared = function (ev) {
    return ev && ev.category === 'struct_block_build_start'
      && Number((ev.detail || {}).block) === 0;
  };

  /* `struct_status` carries the transition, and the transition is the whole
   * story. Everything downstream — the label, the tone, whether the row is a
   * loss — reads this rather than the raw number. */
  var statusAct = function (ev) {
    var d = (ev && ev.detail) || {};
    var now = Number(d.status), was = Number(d.status_old);
    if (now === STATUS_DESTROYED) return { word: 'destroyed', tone: 'destructive' };
    if (now === 7) return { word: 'online', tone: 'default' };
    if (was === 0 && now === 1) return { word: 'building', tone: 'default' };
    return null;
  };

  var CAT_TONE = {
    struct_attack: 'destructive', raid_status: 'destructive', block_raid_start: 'destructive',
    seized: 'destructive', forfeited: 'destructive',
    struct_defense_add: 'warning', struct_defense_remove: 'warning', shield_change: 'warning',
  };
  var toneOf = function (ev) {
    var st = ev.category === 'struct_status' ? statusAct(ev) : null;
    if (st) return st.tone;
    return CAT_TONE[String(ev.category || '')] || 'default';
  };

  /* One frame → one row, the way the Grass page draws it: old→new pairs,
   * precision twins hidden, ids resolved to names, the block lifted out. */
  function tapeRow(ev, opts) {
    var g = Board._grass && Board._grass.parts ? Board._grass.parts(ev)
      : { time: '', category: ev.category, subject: String(ev.subject || ''), block: null, chips: [] };
    var subj = tapeSubject(g.subject);
    var st = ev.category === 'struct_status' ? statusAct(ev) : null;
    var kind = st ? st.word : tapeKind(g.category);
    /* A chip that restates the header is not news. An ore frame carries
     * object_id, object_type, player_id and attribute_type — four chips
     * that between them say "planet 2-29577, player 1-422, ore", which
     * is exactly what the line above them already says. Dropping them
     * leaves the one thing that changed. */
    var shown = {};
    var mark = function (v) { if (v == null || v === '') return; shown[String(v).trim().toLowerCase()] = 1; };
    mark(subj.word); subj.ids.forEach(mark); mark(kind); mark(g.category);
    /* A chip that only PART-repeats the header still repeats it. The
     * grass algorithm resolves ids to names, so `player_id` came back as
     * "1-462 (Colin-Lewis)" — half of which is the id already standing
     * in the header. Take the id out and the new fact, the name, is what
     * is left; take out everything and the chip was never news. Whole
     * tokens, never a substring: 1-462 must not match 1-4620. */
    var undup = function (text) {
      var out = String(text);
      subj.ids.forEach(function (id) {
        out = out.replace(new RegExp('(^|[^0-9A-Za-z_-])' + id.replace(/-/g, '\\-') + '(?![0-9-])', 'g'), '$1');
      });
      out = out.replace(/\s{2,}/g, ' ').trim();
      var wrapped = /^\((.*)\)$/.exec(out);
      return (wrapped ? wrapped[1] : out).trim();
    };
    /* The header now SAYS the transition, so the chip that carries it repeats
     * half of itself: `status mat·built·online → mat·built·DESTROYED` beside a
     * DESTROYED badge. The half that is still news is where it came FROM —
     * whether the thing that died was finished and online or still going up. */
    var chips = (g.chips || []).filter(function (c) { return !shown[String(c.text).trim().toLowerCase()]; })
      .map(function (c) {
        if (st && c.label === 'status') {
          var was = String(c.text).split('→')[0].trim();
          return was ? { label: 'was', text: was, title: c.title } : null;
        }
        return c;
      })
      .filter(Boolean)
      .map(function (c) { return { label: c.label, text: undup(c.text), title: c.title }; })
      .filter(function (c) { return c.text !== ''; })
      .sort(function (a, b) { return (/→/.test(a.text) ? 0 : 1) - (/→/.test(b.text) ? 0 : 1); });
    var parts = chips.map(function (c) {
      var s = H.el('span', 'fig sc-tape-kv'); s.appendChild(H.el('span', 'pc-id', c.label + ' ')); s.appendChild(document.createTextNode(c.text));
      if (c.title) s.title = c.title;
      return s;
    });
    if (opts && opts.repeats > 1) parts.unshift(H.el('span', 'fig tm-feed-rep', '×' + H.fmtInt(opts.repeats)));
    // The first id the frame names is what the line is ABOUT; a tape
    // you cannot follow is a tape you only watch.
    var idm = /(?:^|[^0-9A-Za-z_-])(\d{1,2}-\d{1,9})(?![0-9-])/.exec(g.subject + ' ' + (g.chips || []).map(function (c) { return c.text; }).join(' '));
    var subject = subj.ids[0] || (idm ? idm[1] : null);
    return window.StructsCards.tape.row({
      time: g.time, kind: kind, kindTitle: String(g.category || ''), tone: toneOf(ev),
      subject: subj.word, ids: subj.ids, parts: parts,
      block: g.block != null ? H.fmtInt(g.block) : null, fresh: !!(opts && opts.fresh),
      title: g.subject + ((g.chips || []).length ? ' · ' + g.chips.map(function (c) { return c.label + ' ' + c.text; }).join(' · ') : ''),
    }, subject ? { onClick: function () {
      var k = Number(String(subject).split('-')[0]);
      add(k === 1 ? 'player' : k === 0 ? 'guild' : k === 2 ? 'planet' : 'inspector', { id: subject });
    } } : {});
  }

  /* Repeats collapse to one row with ×N. Without this a single chatty loop
   * owns the card: the screenshot that started this rebuild was five identical
   * `AUTO_BUILD 0 build completion(s) started, 1 build(s) initiated` rows out
   * of forty slots. Keyed on the shape of the line, not its numbers, which is
   * the same rule Team Ops has always used. */
  function collapse(rows, keyOf) {
    var out = [], last = null;
    rows.forEach(function (r) {
      var k = keyOf(r);
      if (last && last.key === k) { last.repeats++; return; }
      last = { key: k, row: r, repeats: 1 };
      out.push(last);
    });
    return out;
  }
  var grassKey = function (ev) {
    return String(ev.category || '') + '|' + String(ev.subject || '').replace(/\d+/g, 'N');
  };
  var opsKey = function (e) {
    return String(e.source || '') + '|' + String(e.message || '').replace(/\d+/g, 'N');
  };

  // ── The shared stream state ───────────────────────────────────────────────
  // One ring for the chain, one for our loops, both filled once per window and
  // tailed live. `scope` is the hour the player picked on the pulse, or null
  // for live.
  var feed = {
    grass: [], ops: [], lookupsWired: false, listening: false,
    fresh: null, scope: null, history: null, pulse: null, draws: [],
  };
  var GRASS_RING = 600;
  /* Every card that is currently on the page redraws on a live frame. A card
   * that has been removed leaves its draw behind, writing into a host no
   * longer in the document — so the list is pruned on the way through rather
   * than leaking one closure per mount. */
  var redraw = function () {
    feed.draws = feed.draws.filter(function (fn) { return fn.host && fn.host.isConnected; });
    feed.draws.forEach(function (fn) { try { fn(); } catch (e) {} });
  };
  var mergeLookups = function (l) { if (l && Board._grass && Board._grass.mergeLookups) Board._grass.mergeLookups(l); };

  function wireStream() {
    if (feed.listening || !window.StructsEvents) return;
    feed.listening = true;
    window.StructsEvents.listen('grass-event', function (e) {
      var ev = e && e.payload;
      if (!ev || !ev.category) return;
      feed.fresh = ev;
      feed.grass.unshift(ev);
      if (feed.grass.length > GRASS_RING) feed.grass.length = GRASS_RING;
      if (!feed.scope) redraw();
    });
    // Ids resolve lazily; rows already drawn upgrade in place on the next pass.
    window.StructsEvents.listen('grass-lookups', function (e) { mergeLookups(e && e.payload); redraw(); });
    window.StructsEvents.listen('board-feed', function (e) {
      var entry = e && e.payload;
      if (!entry) return;
      feed.ops.unshift(entry);
      if (feed.ops.length > 300) feed.ops.length = 300;
      if (!feed.scope) redraw();
    });
  }

  /* The back-fill that never ran. `mcp_grass_recent` returns an OBJECT —
   * { events, categories, lookups } — and this read `Array.isArray(recent)`,
   * which is false for every reply the command has ever sent. The 2,000-frame
   * ring in Rust was unreachable: the tape started empty on every mount and
   * filled only from live frames, which is why it always looked thinner than
   * the Grass page reading the identical command correctly. */
  function backfill() {
    return Promise.all([
      invoke('mcp_grass_recent', { limit: GRASS_RING }).then(function (d) {
        var evs = (d && d.events) || [];
        mergeLookups(d && d.lookups);
        if (evs.length) feed.grass = evs.slice().reverse();
      }).catch(function () {}),
      invoke('mcp_board_feed').then(function (entries) {
        // Rust hands them oldest first; newest belongs on top.
        feed.ops = (entries || []).slice().reverse();
      }).catch(function () {}),
    ]);
  }

  // ── The pulse band ────────────────────────────────────────────────────────
  function pulseBand(host, hours, onPick) {
    var band = H.el('div', 'tm-pulse');
    var buckets = (feed.pulse && feed.pulse.buckets) || [];
    if (!buckets.length) {
      band.appendChild(H.el('div', 'ops-muted', 'no history yet'));
      host.appendChild(band);
      return;
    }
    var max = buckets.reduce(function (m, b) { return Math.max(m, Number(b.total) || 0); }, 1);
    var bars = H.el('div', 'tm-pulse-band');
    buckets.forEach(function (b, i) {
      var live = i === buckets.length - 1;
      var combat = Number(b.combat) > 0;
      var col = H.el('div', 'tm-pulse-hr' + (combat ? ' is-combat' : '')
        + (feed.scope === b.hour_ms ? ' is-on' : '') + (live && !feed.scope ? ' is-live' : ''));
      var fill = H.el('div', 'tm-pulse-fill');
      fill.style.height = Math.max(3, Math.round(100 * (Number(b.total) || 0) / max)) + '%';
      col.appendChild(fill);
      var when = new Date(Number(b.hour_ms) || 0);
      col.title = when.toLocaleString() + ' · ' + H.fmtInt(b.total) + ' frames'
        + (b.top ? ' · mostly ' + b.top : '')
        + (Number(b.destroyed) ? ' · ' + H.fmtInt(b.destroyed) + ' destroyed' : '')
        + (combat ? ' · ' + H.fmtInt(b.combat) + ' combat' : '');
      col.addEventListener('click', function () { onPick(live && feed.scope !== b.hour_ms ? null : b); });
      bars.appendChild(col);
    });
    band.appendChild(bars);
    var axis = H.el('div', 'tm-pulse-axis');
    var first = new Date(Number(buckets[0].hour_ms) || 0);
    axis.appendChild(H.el('span', 'fstat-l', first.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })));
    var mid = buckets.map(function (b) { return Number(b.total) || 0; }).sort(function (a, b) { return a - b; })[Math.floor(buckets.length / 2)];
    axis.appendChild(H.el('span', 'fstat-l', 'median ' + H.fmtInt(mid) + '/h · ' + hours + 'h'));
    axis.appendChild(H.el('span', 'fstat-l', feed.scope ? 'scoped' : 'live'));
    band.appendChild(axis);
    host.appendChild(band);
  }

  // ── The card ──────────────────────────────────────────────────────────────
  var LANE_OPTS = [{ value: 'all', label: 'every lane' }].concat(LANES.map(function (L) {
    return { value: L.key, label: L.label.toLowerCase() };
  }));
  Terminal.register('feed', {
    label: 'Feed', defaultWidth: 2, single: true, defaultHeight: 'grow',
    describe: function (p) {
      return 'Feed · ' + ((SPANS.filter(function (s) { return s.value === String(p.span || '24'); })[0] || SPANS[1]).label)
        + (p.lane && p.lane !== 'all' ? ' · ' + p.lane : '');
    },
    params: [
      { key: 'span', label: 'Span', kind: 'choice', options: SPANS },
      { key: 'lane', label: 'Lane', kind: 'choice', options: LANE_OPTS },
    ],
    cadenceMs: 60000,
    render: function (host, p) {
      var hours = Math.max(1, Number(p.span) || 24);
      var only = p.lane && p.lane !== 'all' ? p.lane : null;

      var draw = function () {
        if (!host.isConnected) return;
        host.innerHTML = '';
        pulseBand(host, hours, function (b) {
          feed.scope = b ? Number(b.hour_ms) : null;
          feed.history = null;
          if (!feed.scope) { redraw(); return; }
          invoke('mcp_grass_history', {
            since_ms: feed.scope, until_ms: feed.scope + 3600000, limit: 500,
          }).then(function (d) {
            mergeLookups(d && d.lookups);
            feed.history = ((d && d.events) || []).slice().reverse();
          }).catch(function () { feed.history = []; }).then(redraw);
          redraw();
        });

        var scoped = feed.scope != null;
        var grass = scoped ? feed.history : feed.grass;
        var wrap = H.el('div', 'tm-lanes');
        if (scoped && grass == null) {
          wrap.appendChild(H.el('div', 'ops-muted', 'reading that hour…'));
          host.appendChild(wrap);
          return;
        }
        // Our loops have no durable copy — the ring is all there is — so a
        // scoped view says so rather than showing the live entries under an
        // hour they did not happen in.
        LANES.forEach(function (L) {
          if (only && L.key !== only) return;
          var rows, keyOf;
          if (L.ours) {
            rows = scoped ? [] : feed.ops;
            keyOf = opsKey;
          } else {
            rows = (grass || []).filter(function (ev) {
              return laneOf(ev.category) === L.key && !isBuildCleared(ev);
            });
            keyOf = grassKey;
          }
          var groups = collapse(rows, keyOf).slice(0, 60);
          var lane = H.el('div', 'tm-lane'
            + (groups.length && L.hot ? ' is-hot' : '')
            + (groups.length ? '' : ' is-quiet'));
          var hd = H.el('div', 'tm-lane-hd');
          hd.appendChild(H.el('i', 'sui-icon sui-icon-sm ' + L.icon));
          hd.appendChild(H.el('span', 'fstat-l', L.label));
          hd.appendChild(H.el('span', 'tm-lane-n fstat-l',
            groups.length ? H.fmtInt(rows.length) : (L.ours && scoped ? 'live only' : 'quiet')));
          lane.appendChild(hd);
          if (!groups.length) {
            lane.appendChild(H.el('div', 'tm-lane-empty ops-muted',
              L.ours && scoped ? 'our loops keep no history' : 'nothing in this window'));
          } else {
            var ul = H.el('ul', 'ops-feed sui-text-ticker tm-lane-rows');
            groups.forEach(function (g) {
              var li = H.el('li');
              li.appendChild(L.ours ? opsRow(g.row, g.repeats)
                : tapeRow(g.row, { repeats: g.repeats, fresh: g.row === feed.fresh }));
              ul.appendChild(li);
            });
            lane.appendChild(ul);
          }
          wrap.appendChild(lane);
        });
        host.appendChild(wrap);
      };

      wireStream();
      draw.host = host;
      feed.draws = feed.draws.filter(function (fn) { return fn.host && fn.host !== host && fn.host.isConnected; });
      feed.draws.push(draw);
      var loads = [invoke('mcp_grass_pulse', { hours: hours }).then(function (d) { feed.pulse = d; }).catch(function () {})];
      if (!feed.grass.length && !feed.ops.length) loads.push(backfill());
      return Promise.all(loads).then(draw);
    },
  });

  /* Our loops' own rows. The severity map here used to declare
   * `{ error, warn, warning, important }` while Rust only ever emits
   * `info | notice | important` — three of the four keys were unreachable,
   * nothing was ever drawn destructive, and `notice` was indistinguishable
   * from `info`. One bit of severity where the card thought it had three. */
  var OPS_TONE = { important: 'destructive', notice: 'warning', info: 'default' };
  function opsRow(e, repeats) {
    var d = new Date(Number(e.ts_ms) || 0);
    var time = isNaN(d.getTime()) ? '' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    var parts = [String(e.message || '')];
    if (repeats > 1) parts.unshift(H.el('span', 'fig tm-feed-rep', '×' + H.fmtInt(repeats)));
    return window.StructsCards.tape.row({
      time: time, kind: String(e.source || 'app'),
      tone: OPS_TONE[String(e.severity || '')] || 'default',
      parts: parts, title: String(e.message || ''),
    });
  }

  /* No `tape` alias type. A layout saved before the rebuild is REWRITTEN on
   * load (migrate), because an alias is a second type and `single` is checked
   * per type — which is how a real board ended up carrying a tape and three
   * feeds at once. `TAPE`, `FLOW` and `STREAM` reach this card as words. */
  // A page, or a page's VIEW (`energy:production`), the way the board's own
  // sub-nav reaches them. Ordered by who reaches for them: hashers and
  // botters first, then energy, then war.
  // Only the settings pages are still reached as pages (forms are not data);
  // every data page became cards of its own (board-terminal-ops.js), and a
  // saved layout that names one is migrated on load (PAGE_TO_CARDS).
  var PAGES = [
    { value: 'config', label: 'Settings' }, { value: 'config:appearance', label: 'Squad appearance' }, { value: 'config:profiles', label: 'Behaviour profiles' },
  ];
  function pageOf(p) { var parts = String(p.page || 'work').split(':'); return { name: parts[0], view: parts[1] || p.view || undefined }; }
  Terminal.register('page', {
    label: 'Settings page', defaultWidth: 2, hidden: true,
    describe: function (p) { var s = PAGES.filter(function (x) { return x.value === p.page; })[0]; return s ? s.label : (p.page || '?'); },
    params: [{ key: 'page', label: 'Page', kind: 'choice', options: PAGES }],
    cadenceMs: 5000,
    render: function (host, p) {
      var pv = pageOf(p), name = pv.name;
      var page = document.getElementById('page-' + name);
      var def = Board.pages[name];
      if (!page || !def) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', 'No page ' + name)); return; }
      if (page.parentNode !== host) {
        host.innerHTML = '';
        page.hidden = false;
        host.appendChild(page);
        if (def.onEnter) return Promise.resolve(def.onEnter({}, pv.view)).then(function () { def.lastRun = Date.now(); });
        return;
      }
      if (def.refresh && (!def.cadenceMs || Date.now() - def.lastRun >= def.cadenceMs)) {
        def.lastRun = Date.now();
        return def.refresh();
      }
    },
    unmount: function (host, p) {
      var page = document.getElementById('page-' + pageOf(p).name);
      var home = document.querySelector('.ops-scroll');
      if (page && home) { page.hidden = true; home.appendChild(page); }
    },
  });

  // Who is closest to brownout: our roster's power margins, worst first.
  Terminal.register('halt', {
    label: 'Power margins', defaultWidth: 2, describe: function () { return 'Power margins'; }, cadenceMs: 30000,
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
        if (players.length > 20) cap.appendChild(H.el('span', 'fstat-l', ' · showing 20'));
        players.slice(0, 20).forEach(function (r) {
          var margin = Number(r.margin_pct);
          table.appendChild(window.StructsPlayerCard.row({
            id: r.player_id || r.name, name: r.name || r.player_id, pfp: r.pfp_attrs, sub: r.role || null,
            err: margin <= 0, attn: margin <= 0 ? 'brownout' : (margin < 20 ? 'thin margin' : null),
            readings: [
              { value: H.fmtWatts(r.load_mw) + ' / ' + H.fmtWatts(r.capacity_mw), icon: 'sui-icon-energy', title: 'Load / capacity' },
              { value: (isFinite(margin) ? margin.toFixed(0) : '—') + '%', icon: 'icon-alert', title: 'Margin' },
            ],
          }, { actions: (Board.watchActions ? Board.watchActions(r) : []).concat([
              { icon: 'sui-icon-energy', title: 'Route power to fix this', onClick: function () { add('allocations', {}); } },
            ]) }));
        });
        host.appendChild(table);
      });
    },
  });

  // Who holds ore: the galaxy's ore leaderboard (the stats engine's grid
  // read), richest first. Ore is what a raid takes and what a refinery
  // turns into Alpha, so the holder matters and the planet does not.
  Terminal.register('ore', {
    label: 'Ore holders', defaultWidth: 2,
    describe: function (p) { return 'Ore holders' + (p.limit ? ' · top ' + p.limit : ''); },
    params: [{ key: 'limit', label: 'How many', kind: 'choice', options: [{ value: '30', label: 'top 30' }, { value: '60', label: 'top 60' }, { value: '120', label: 'top 120' }] }],
    cadenceMs: 60000,
    // `terminal_ore_radar` is the query built for this question: it reads the
    // perception snapshot by PLANET, so every row carries the planet the ore
    // is actually sitting on — which is what a raider needs and what the
    // leaderboard could not say.
    render: function (host, p) {
      var limit = Math.max(1, Number(p.limit) || 30);
      return invoke('terminal_ore_radar', { limit: limit }).then(function (r) {
        host.innerHTML = '';
        var rows = (r && r.planets) || [];
        var cap = H.el('div', 'tm-cap');
        cap.appendChild(H.el('span', 'fstat-l', rows.length + ' planet' + (rows.length === 1 ? '' : 's') + ' holding ore'
          + (r && r.planets_with_ore ? ' · ' + H.fmtInt(r.planets_with_ore) + ' in the galaxy' : '')));
        host.appendChild(cap);
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No ore readings yet.')); return; }
        var table = H.resultTable();
        rows.forEach(function (o, i) {
          var attrs = o.owner_pfp; if (attrs && typeof attrs !== 'string') attrs = JSON.stringify(attrs);
          table.appendChild(window.StructsCards.planet.row({
            id: o.planet_id, name: 'Planet ' + o.planet_id, shield: H.fmtInt(o.shield || 0), ore: H.fmtOre(o.ore || 0),
            owner: o.owner ? { id: o.owner, name: o.owner_name, tag: o.owner_tag, pfp: attrs } : null,
            sub: '#' + (i + 1),
          }, {
            onClick: function () { add('planet', { id: o.planet_id }); },
            doors: [
              { icon: 'icon-member', title: o.owner ? 'Watch ' + o.owner : 'No owner known', onClick: function () { if (o.owner) add('player', { id: o.owner }); } },
              { icon: 'icon-raid', title: 'Target board', onClick: function () { add('targets', {}); } },
            ],
          }));
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
    params: [{ key: 'id', label: 'Player id', kind: 'id', kinds: [1], placeholder: '1-194' }],
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
          var term = Math.max(1, (a.end_block || 0) - (a.start_block || 0));
          table.appendChild(window.StructsCards.agreement.row({
            id: a.id, side: a.side, sub: a.provider_id ? 'provider ' + a.provider_id : null,
            capacity: H.fmtWatts(a.capacity),
            rate: { value: H.fmtInt(a.rate_amount), denomLabel: a.denom_label || null },
            left: { text: window.StructsUnits.fmtDuration(a.blocks_remaining * 5.3), frac: Math.max(0, Math.min(1, 1 - a.blocks_remaining / term)), title: H.fmtInt(a.blocks_remaining) + ' blocks left of ' + H.fmtInt(term) },
            ending: a.blocks_remaining < 680,
            counterparty: a.counterparty ? { id: a.counterparty } : null,
          }, { onClick: a.provider_id ? function () { add('inspector', { id: a.provider_id }); } : null }));
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
    /* The cheapest capacity in the galaxy, in the one unit every offer shares
     * (alpha per kW per day). This used to ignore every offer priced in a
     * guild token — so an alarm on "the market got cheap" could not see the
     * cheap offer if the seller quoted it in their own currency. */
    'market.best_rate': function () { return invoke('terminal_market').then(function (m) { var v = m && m.best_alpha_per_kw_day; return v == null ? null : Number(v); }); },
    'halt.min_margin': function () { return invoke('mcp_energy').then(function (e) { var m = ((e && e.players) || []).map(function (p) { return Number(p.margin_pct); }).filter(isFinite); return m.length ? Math.min.apply(null, m) : null; }); },
    'raids.live': function () { return Board._gamestats.ensureBoot().then(function () { var t = Board._gamestats.state.snap && Board._gamestats.state.snap.totals; return t ? Number(t.raids_active) : null; }); },
    'people.live_1h': function () { return Board._gamestats.ensureBoot().then(function () { var t = Board._gamestats.state.snap && Board._gamestats.state.snap.totals; return t ? Number(t.live_1h) : null; }); },
    'ore.top': function () { return invoke('mcp_game_stats_snapshot').then(function (r) { var p = r && r.players_top && r.players_top.ore && r.players_top.ore[0]; return p ? Number(p.value) : null; }); },
    'book.first_expiry': function () { return invoke('terminal_agreements', { player: Board.primaryId ? Board.primaryId() : '' }).then(function (b) { return b && b.first_expiry_block != null && b.height ? b.first_expiry_block - b.height : null; }); },
  };
  /* ── Watching one THING, not just the galaxy ─────────────────────────────
   *
   * The six readings above are galaxy-wide, and an expert's alarms are not:
   * "that planet's shield is down", "that worker is out of charge", "the ore
   * I am mining is nearly gone". A subject reading takes a chain id, the same
   * way the command line does — `shield.2-29604 = 0`, `charge.1-271 < 3` —
   * and refuses an id of the wrong kind rather than silently reading nothing.
   *
   * Every source here is one the board already polls and caches, so watching
   * forty things costs the same two reads as watching one.
   */
  function rosterField(id, field) {
    return invoke('mcp_roster').then(function (r) {
      var row = ((r && r.rows) || []).filter(function (x) { return String(x.player_id) === id; })[0];
      var v = row ? Number(row[field]) : NaN;
      return isFinite(v) ? v : null;
    });
  }
  function planetField(id, field) {
    return invoke('terminal_ore_radar', { limit: 200 }).then(function (r) {
      var row = ((r && r.planets) || []).filter(function (x) { return String(x.planet_id) === id; })[0];
      var v = row ? Number(row[field]) : NaN;
      return isFinite(v) ? v : null;
    });
  }
  var SUBJECT_READINGS = {
    // metric: [accepted id kinds, resolver]
    charge: [[1], function (id) { return rosterField(id, 'charge'); }],
    alpha: [[1], function (id) { return rosterField(id, 'alpha_ualpha'); }],
    ore: [[1, 2], function (id) {
      return kindOf(id) === 1 ? rosterField(id, 'ore') : planetField(id, 'ore');
    }],
    shield: [[2], function (id) { return planetField(id, 'shield'); }],
  };
  Terminal.SUBJECT_READINGS = SUBJECT_READINGS;
  /* The resolver for a metric, whether it names the galaxy or one object.
   * `null` for anything else — an alert whose reading cannot be taken says
   * INVALID rather than sitting quiet forever, which is the failure mode that
   * makes people stop trusting alarms. */
  function readingFor(metric) {
    if (READINGS[metric]) return READINGS[metric];
    // `series.<source>.<metric>[.<subject>]`: any series a chart can draw.
    if (Terminal.chartReading) { var cr = Terminal.chartReading(metric); if (cr) return cr; }
    var dot = String(metric || '').lastIndexOf('.');
    if (dot < 0) return null;
    var head = metric.slice(0, dot), id = metric.slice(dot + 1);
    var sub = SUBJECT_READINGS[head];
    if (!sub || sub[0].indexOf(kindOf(id)) < 0) return null;
    return function () { return sub[1](id); };
  }
  Terminal.readingFor = readingFor;

  var OPS = { '<': function (a, b) { return a < b; }, '>': function (a, b) { return a > b; }, '<=': function (a, b) { return a <= b; }, '>=': function (a, b) { return a >= b; }, '=': function (a, b) { return a === b; } };
  function parseRules(text) {
    return String(text || '').split(/[;\n]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
      // `-` too: a subject reading names a chain id (`shield.2-29604`).
      var m = /^([a-z_.0-9-]+)\s*(<=|>=|<|>|=)\s*(-?[\d.]+)$/i.exec(s);
      return m ? { metric: m[1].toLowerCase(), op: m[2], value: Number(m[3]), text: s } : { text: s, bad: true };
    });
  }
  Terminal.parseRules = parseRules;
  /* A reading on the row: a series reading in its unit's own ladder; any
   * other with the noise cut — a rate is 2.07, never 2.0701697876146734. */
  function fmtReading(metric, v) {
    var f = Terminal.chartValueFmt && Terminal.chartValueFmt(metric);
    if (f) return f(v);
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    return Number.isInteger(n) ? n : Number(n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2));
  }
  Terminal.fmtReading = fmtReading;
  var alertsFired = {};
  // Muted rules, by their text, until a wall-clock ms. A mute is a judgement
  // about right now, so it is deliberately not saved with the layout.
  var alertsMuted = {};
  Terminal.register('alerts', {
    label: 'Alerts', describe: function () { return 'Alerts'; },
    params: [{ key: 'rules', label: 'Rules, one per line', kind: 'text', placeholder: 'market.best_rate < 2; raids.live > 0' }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      var rules = parseRules(p.rules);
      host.innerHTML = '';
      if (!rules.length) {
        host.appendChild(H.stateBlock('info', 'Configure this card with rules: '
          + Object.keys(READINGS).join(' · ') + ' · '
          + Object.keys(SUBJECT_READINGS).map(function (k) { return k + '.<id>'; }).join(' · ')));
        return;
      }
      var fired = H.el('div', 'tm-fired');
      host.appendChild(fired);
      var table = H.resultTable();
      host.appendChild(table);
      return Promise.all(rules.map(function (r) {
        var read = r.bad ? null : readingFor(r.metric);
        if (!read) return { rule: r, state: 'bad' };
        return read().then(function (v) {
          var fired = v != null && OPS[r.op](v, r.value);
          return { rule: r, value: v, state: v == null ? 'unknown' : (fired ? 'fired' : 'quiet') };
        }).catch(function () { return { rule: r, state: 'unknown' }; });
      })).then(function (results) {
        var VALUE_ICON = { 'market.best_rate': 'sui-icon-md icon-transfers', 'halt.min_margin': 'sui-icon-energy', 'raids.live': 'sui-icon-md icon-raid', 'people.live_1h': 'sui-icon-players', 'ore.top': 'sui-icon-alpha-ore', 'book.first_expiry': 'sui-icon-md icon-in-progress' };
        results.forEach(function (res) {
          // A rule you cannot quiet is a rule you learn to ignore, and one you
          // cannot delete from its own row is one you edit by retyping them all.
          var until = alertsMuted[res.rule.text] || 0;
          var muted = until > Date.now();
          if (muted) res.state = 'quiet';
          var row = window.StructsCards.alert.row({
            text: res.rule.text, state: res.state, value: res.value != null ? fmtReading(res.rule.metric, res.value) : null,
            valueIcon: VALUE_ICON[res.rule.metric] || (Terminal.chartValueIcon && Terminal.chartValueIcon(res.rule.metric)) || null,
            firedAgo: muted ? 'muted ' + window.StructsUnits.fmtDuration(Math.round((until - Date.now()) / 1000)) : (res.state === 'fired' && alertsFired[res.rule.text] ? H.ago(alertsFired[res.rule.text]) : null),
          }, {
            doors: [
              { icon: muted ? 'icon-okay' : 'icon-blocked', title: muted ? 'Unmute this rule' : 'Mute for an hour', on: muted, onClick: function () {
                if (muted) delete alertsMuted[res.rule.text]; else alertsMuted[res.rule.text] = Date.now() + 3600000;
                refresh(ctx.id, true);
              } },
              { icon: 'icon-subtract', title: 'Remove this rule', destructive: true, onClick: function () {
                var keep = String(p.rules || '').split(/[\n;]+/).map(function (x) { return x.trim(); })
                  .filter(function (x) { return x && x !== res.rule.text; });
                setParams(ctx.id, Object.assign({}, p, { rules: keep.join('\n') }));
              } },
            ],
          });
          row.classList.add('tm-alert', 'tm-alert-' + res.state);
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
    label: 'Guild banks', defaultWidth: 2,
    describe: function (p) { return 'Guild banks' + (p.sort ? ' · ' + p.sort : ''); },
    params: [{ key: 'sort', label: 'Order', kind: 'choice', options: [
      { value: 'ratio', label: 'by ratio' }, { value: 'collateral', label: 'by collateral' }, { value: 'supply', label: 'by supply' },
    ] }],
    cadenceMs: 60000,
    render: function (host, p) {
      return invoke('terminal_guild_banks').then(function (r) {
        host.innerHTML = '';
        var key = p.sort || 'ratio';
        var banks = ((r && r.banks) || []).slice().sort(function (a, b) { return (Number(b[key]) || 0) - (Number(a[key]) || 0); });
        var cap = H.el('div', 'tm-cap');
        cap.appendChild(H.el('span', 'fstat-l', banks.length + ' guild tokens · ratio = collateral / supply'));
        host.appendChild(cap);
        if (!banks.length) { host.appendChild(H.stateBlock('info', 'No guild banks reported yet.')); return; }
        var table = H.resultTable();
        banks.forEach(function (b, i) {
          table.appendChild(window.StructsCards.token.row({
            guildId: b.guild_id, tag: b.tag || null, name: b.name || null, denom: b.denom || null, logo: b.logo || null, prefix: '#' + (i + 1),
            ratio: b.ratio == null ? '—' : Number(b.ratio).toFixed(3), collateral: H.fmtAlpha(b.collateral), supply: H.fmtInt(b.supply),
          }, { onClick: function () { add('gt', { id: b.guild_id }); }, doors: [{ icon: 'icon-link-out', title: 'Token chart', onClick: function () { add('gt', { id: b.guild_id }); } }] }));
        });
        host.appendChild(table);
      });
    },
  });

  // One guild token: the ratio now, the ratio as this app has sampled it,
  // and thirty days of supply walked back from today.
  Terminal.register('gt', {
    label: 'Guild token', defaultWidth: 2, describe: function (p) { return 'Guild token · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Guild id', kind: 'id', kinds: [0], placeholder: '0-1' }],
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
        // The card describes a token you can trade; the ticket is next door.
        host.appendChild(doorRow([
          { label: 'Mint or redeem', primary: true, onClick: function () { add('bank', {}); } },
          { label: 'All banks', onClick: function () { add('banks', {}); } },
        ]));
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
  // One tearsheet section as a STRIP of tiles. It was four tables of
  // key-value pairs — a data dump on a card whose whole job is to be scanned.
  function sheetSection(label, v) {
    if (!v || typeof v !== 'object') return null;
    var box = H.el('div', 'gs-line');
    var cap = H.el('div', 'gs-cap'); cap.appendChild(H.el('span', 'fstat-l', label)); box.appendChild(cap);
    if (v.unavailable) { box.appendChild(H.stateBlock('info', 'unavailable: ' + v.unavailable)); return box; }
    var pairs = [];
    var walk = function (o) {
      Object.keys(o).forEach(function (k) {
        var x = o[k];
        if (x == null || typeof x === 'object' || x === '') return;
        pairs.push([k.replace(/_/g, ' '), String(x)]);
      });
    };
    if (Array.isArray(v)) v.slice(0, 4).forEach(walk); else walk(v);
    if (!pairs.length) return null;
    var strip = H.el('div', 'hstrip gs-strip');
    pairs.slice(0, 8).forEach(function (kv) { strip.appendChild(H.statTile(kv[0], kv[1])); });
    box.appendChild(strip);
    return box;
  }
  Terminal.register('sheet', {
    label: 'Tearsheet', defaultWidth: 2, describe: function (p) { return 'Tearsheet · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Player or guild id', kind: 'id', kinds: [0, 1], placeholder: '1-194 or 0-1' }],
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
            var box = sheetSection(sec[1], t[sec[0]]);
            if (box) host.appendChild(box);
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
            var box = sheetSection(sec[1], t[sec[0]]);
            if (box) host.appendChild(box);
          });
        }
      });
    },
  });

  // The battle log: every recorded row for one planet, as the raid view
  // draws it (raidview-log.js — kinds, day groups, the filter strip). It
  // owns fixed DOM ids, so one per window.
  // The battle log and an object's Comms are the raid view's own rails, shown
  // one at a time (`only=`). Embedding rather than re-hosting is what lets two
  // of them coexist: each rail owns fixed element ids, so two in one document
  // would fight over them — two documents cannot.
  Terminal.register('log', {
    label: 'Battle log', defaultWidth: 2, cadenceMs: 0,
    describe: function (p) { return 'Battle log · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet id', kind: 'id', kinds: [2], placeholder: '2-15361' }],
    doors: function (card) {
      var id = (card.params || {}).id;
      return id ? [{ icon: 'icon-planet', title: 'Open the planet', onClick: function () { add('planet', { id: id }); } }] : [];
    },
    render: function (host, p, ctx) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a planet id.')); return; }
      return mapFrame(host, ctx, p.id, 'log');
    },
    unmount: mapUnmount,
  });

  // Whole windows, framed: the spectator map, the Comms window, the Pay window.
  // `embed=1`: the page drops its own nav bar (the card frame is the header)
  // and takes navigation from the frame's doors, by message.
  // A row of labelled doors under a card's body (the ops module has its own).
  function doorRow(items) {
    var row = H.el('div', 'tm-doors-row');
    items.forEach(function (it) {
      var a = H.el('a', 'sui-screen-btn ' + (it.primary ? 'sui-mod-primary' : 'sui-mod-secondary'), it.label);
      a.href = 'javascript:void(0)';
      a.addEventListener('click', function () { it.onClick(a); });
      row.appendChild(a);
    });
    return row;
  }

  function framed(url, title, cardId) {
    var f = document.createElement('iframe');
    f.className = 'tm-frame';
    f.title = title;
    f.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'embed=1&card=' + encodeURIComponent(cardId || '');
    return f;
  }
  // ── The live map, as a card ──────────────────────────────────────────
  // The spectator view (raidview.html) drawn inside a card: the game's own
  // map with its HUD over it, animating every shot as it lands. The feed is
  // pushed by the same watcher that drives a raid window, addressed to
  // `board:<card>` so two cards on two planets never cross-deliver, and
  // stopped when the card goes.
  function mapLabel(cardId) { return 'board:' + String(cardId).replace(/[^A-Za-z0-9_-]/g, '-'); }
  function mapArgs(id) {
    return String(id).indexOf('9-') === 0 ? { fleetId: id } : { planetId: id };
  }
  function mapFrame(host, ctx, id, only) {
    var m = state.mounted[ctx.id];
    var key = id + (only ? '#' + only : '');
    // Rebuild only when the target changes: a reload would restart the map.
    if (m && m.map === key) return Promise.resolve();
    if (m && m.map) invoke('mcp_raid_view_unwatch', Object.assign({ label: mapLabel(ctx.id) }, mapArgs(String(m.map).split('#')[0]))).catch(function () {});
    host.innerHTML = '';
    var label = mapLabel(ctx.id);
    var kind = String(id).indexOf('9-') === 0 ? 'fleet' : 'planet';
    var f = framed('raidview.html?' + kind + '=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(label) + (only ? '&only=' + only : ''), (only || 'map') + ' of ' + kind + ' ' + id, ctx.id);
    f.classList.add('tm-frame-map');
    if (only) f.classList.add('tm-frame-rail');
    host.appendChild(f);
    if (m) m.map = key;
    return invoke('mcp_raid_view_watch', Object.assign({ label: label }, mapArgs(id))).catch(function (e) {
      Board.stamp && Board.stamp('map feed: ' + e);
    });
  }
  function mapUnmount(host, p, ctx) {
    if (!p || !p.id || !ctx || !ctx.id) return;
    invoke('mcp_raid_view_unwatch', Object.assign({ label: mapLabel(ctx.id) }, mapArgs(p.id))).catch(function () {});
  }

  // The embedded page's own bar carries pop-out and close; it asks the card
  // by message, naming the card it was given. Same origin only.
  //
  // The same channel is the page's Tauri bridge (frontend/bridge.js): an
  // iframe has no bridge of its own, so it asks this window to invoke and to
  // listen for it. Only frames this page embeds are answered.
  function frameOf(source) {
    var frames = document.querySelectorAll('#tm-grid iframe.tm-frame');
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === source) return frames[i];
    return null;
  }
  var frameSubs = typeof WeakMap === 'function' ? new WeakMap() : null;
  function sendTo(source, msg) {
    var mine = String(location.origin || '');
    try { source.postMessage(msg, mine === 'null' || !mine ? '*' : mine); } catch (e) { /* the frame is gone */ }
  }
  /* ── What an embedded page may ask the Terminal to run ────────────────────
   *
   * A card can embed a page (Comms, the raid map), and an iframe shares its
   * HOST window's label — so a command gated to the Terminal is a command an
   * embedded page can ask the Terminal to run for it. That proxy used to
   * forward anything, which was survivable only because the Terminal could
   * invoke nothing gated; the moment it could sign a transfer, the Comms
   * window — which renders text written by federated strangers — could ask it
   * to.
   *
   * So the proxy carries an allowlist, and the allowlist is MEASURED: it is
   * every command the pages the Terminal actually frames really call, and
   * nothing else. `terminal.test.mjs` re-derives it from those files, so a
   * page that grows a new call fails the suite rather than failing in the
   * window — and a command the pages do NOT call can never be borrowed.
   *
   * It used to carry `matrix_` as a PREFIX, because Comms was framed here and
   * reached 46 of the 55 commands on the list. Comms is native now
   * (the Comms window is its own window) and nothing frames `chat.html`, so the prefix
   * went with it: the raid view's rail calls five Matrix commands and those
   * five are named. That closes `matrix_open_transfer`, `matrix_share`,
   * `matrix_agreement_open` and every `matrix_work_*` to an embedded page —
   * all of them reachable, until now, from a rail that renders text written
   * by federated strangers.
   */
  var FRAME_CMD_PREFIXES = [];
  var FRAME_CMDS = {
    events_listening: 1,
    // The raid view's Comms rail: an object's room, its recent chatter, and
    // saying something in it. Nothing that moves value.
    matrix_object_chatter: 1, matrix_object_room: 1, matrix_object_room_create: 1,
    matrix_send: 1, matrix_timeline: 1,
    mcp_inventory: 1, mcp_roster: 1,
    mcp_raid_log: 1, mcp_raid_state: 1, mcp_struct_act: 1,
    // A chip in the rail opening a planet or fleet as a raid view — the
    // spectator window, which is ungated. Read-only, and nothing it shows moves value.
    mcp_raid_view_open: 1,
  };
  Terminal.frameMayInvoke = function (cmd) {
    var name = String(cmd || '');
    if (FRAME_CMDS[name] === 1) return true;
    for (var i = 0; i < FRAME_CMD_PREFIXES.length; i++) {
      if (name.indexOf(FRAME_CMD_PREFIXES[i]) === 0) return true;
    }
    return false;
  };

  Terminal.answerFrame = function (ev) {
    var mine = String(location.origin || '');
    var same = ev.origin === mine || (mine === 'null' && (ev.origin === 'null' || ev.origin === ''));
    if (!same) return false;
    var m = ev.data;
    if (!m || m.structs !== 'bridge') return false;
    var source = ev.source;
    if (!source || (source !== window && !frameOf(source))) return false;
    if (m.kind === 'invoke') {
      if (!Terminal.frameMayInvoke(m.cmd)) {
        sendTo(source, { structs: 'bridge', kind: 'result', id: m.id, ok: false,
          error: String(m.cmd) + ' is not available to an embedded page' });
        return true;
      }
      Promise.resolve().then(function () { return invoke(m.cmd, m.args || {}); }).then(function (value) {
        sendTo(source, { structs: 'bridge', kind: 'result', id: m.id, ok: true, value: value === undefined ? null : value });
      }, function (e) {
        sendTo(source, { structs: 'bridge', kind: 'result', id: m.id, ok: false, error: String(e && e.message || e) });
      });
      return true;
    }
    if (m.kind === 'listen' && window.StructsEvents) {
      var subs = frameSubs && frameSubs.get(source);
      if (!subs) { subs = { names: {}, unlisten: [] }; if (frameSubs) frameSubs.set(source, subs); }
      if (subs.names[m.name]) return true;
      subs.names[m.name] = true;
      var p = window.StructsEvents.listen(m.name, function (e) { sendTo(source, { structs: 'bridge', kind: 'event', name: m.name, payload: e && e.payload }); });
      if (p && typeof p.then === 'function') p.then(function (un) { if (typeof un === 'function') subs.unlisten.push(un); });
      return true;
    }
    return false;
  };
  function dropFrameSubs(body) {
    if (!frameSubs || !body) return;
    var f = body.querySelector && body.querySelector('iframe.tm-frame');
    var subs = f && f.contentWindow && frameSubs.get(f.contentWindow);
    if (!subs) return;
    subs.unlisten.forEach(function (un) { try { un(); } catch (e) { /* fine */ } });
    frameSubs.delete(f.contentWindow);
  }
  window.addEventListener('message', function (ev) {
    if (Terminal.answerFrame(ev)) return;
    var mine = String(location.origin || '');
    var same = ev.origin === mine || (mine === 'null' && (ev.origin === 'null' || ev.origin === ''));
    if (!same) return;
    var m = ev.data;
    if (!m || m.structs !== 'card' || !m.card || !state.mounted[m.card]) return;
    if (m.act === 'popout') popOut(m.card);
    else if (m.act === 'remove') remove(m.card);
    else if (m.act === 'scroll') {
      // A frame that has nothing left to scroll hands the wheel back.
      var sc = document.querySelector('.ops-scroll');
      if (sc) sc.scrollTop += Number(m.dy) || 0;
    }
  });
  // A planet as a card, not a window: who holds it, what it is worth, what is
  // happening to it, and every slot by ambit — the spectator snapshot the raid
  // view draws from, laid out to be read in a column. The doors open the
  // map, the battle log and the object's Comms for the same planet.
  // A planet as a card: the LIVE MAP. Everything the old hand-drawn version
  // approximated — owner, shield, ore, fleets, every slot by ambit — the map
  // and its HUD show already, and show it moving. What the map has no room
  // for are the doors to its neighbours, which stay on the card's header.
  Terminal.register('planet', {
    label: 'Planet view', defaultWidth: 2, cadenceMs: 0,
    describe: function (p) { return 'Planet ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet id', kind: 'id', kinds: [2], placeholder: '2-15361' }],
    doors: function (card) {
      var id = (card.params || {}).id;
      if (!id) return [];
      return [
        { icon: 'icon-combat-log', title: 'Battle log', onClick: function () { add('log', { id: id }); } },
        { icon: 'icon-phone', title: 'Comms about this planet', onClick: function () { Terminal.comms(id); } },
        { icon: 'icon-raid', title: 'Watch in its own window', onClick: function () { invoke('mcp_raid_view_open', { planetId: id }).catch(function (e) { Board.stamp && Board.stamp('raid view: ' + e); }); } },
      ];
    },
    render: function (host, p, ctx) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a planet id.')); return; }
      return mapFrame(host, ctx, p.id);
    },
    unmount: mapUnmount,
  });

  Terminal.register('map', {
    label: 'Map viewer', defaultWidth: 2,
    describe: function (p) { return 'Map · ' + (String(p.id || '').indexOf('9-') === 0 ? 'fleet ' : 'planet ') + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet or fleet id', kind: 'id', kinds: [2, 9], placeholder: '2-15361' }],
    cadenceMs: 0,
    render: function (host, p, ctx) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a planet (2-…) or fleet (9-…) id.')); return; }
      return mapFrame(host, ctx, p.id);
    },
    unmount: mapUnmount,
  });
  /* Comms is no longer a WINDOW inside a card.
   *
   * `chat` embedded the whole of `chat.html` in an iframe: its own navigation,
   * its own back button, its own idea of which room you were looking at, and
   * its own scroll, all fighting the board for the same gestures. Two
   * conversations meant two copies of the entire window, and the command line
   * could not name a room because rooms were not subjects.
   *
   * It is four native cards now — COMMS, ROOM, CHANNELS, WHO — over one model
   * — was five cards; now `chat.html` is the one Comms surface and
   * is still a good window; nothing in the Terminal frames it.
   */

  /* `deliver` is a NATIVE card, registered in board-terminal-ops.js beside the
   * other things that sign. It was an embedded `transfer.html`; that window
   * still exists and Comms still opens it, but a window inside a card was the
   * cause of every frame, header and scaling bug that panel had. */

  // ── Boot ────────────────────────────────────────────────────────────────
  function enter() {
    state.solo = param('card');
    // A one-card window is the card and nothing else: board.html strips its
    // own panel frame and its (empty) nav bar off this attribute.
    if (state.solo) document.documentElement.setAttribute('data-card', '1');
    Terminal.loadCharts();
    return loadWorkspaces().then(function () {
      state.ws = param('ws') || state.active || 'main';
      if (state.workspaces.indexOf(state.ws) < 0) state.workspaces.push(state.ws);
      return load();
    }).then(function () { listenForLayouts(); renderAll(); });
  }
  Terminal.enter = enter;

  Board.registerPage('terminal', { onEnter: enter });
  if (Board.current === 'terminal' && Board.T) enter();
})();
