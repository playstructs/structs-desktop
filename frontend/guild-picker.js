/* ── [structs-universe] which guild: the chip and the directory ──
 *
 * New Player and Returning Player speak to whichever guild the app is pointed
 * at. The chip says which that is and opens the guild directory, in the game's
 * own offcanvas: every guild that publishes a server this app can play on,
 * largest first. Picking one points the app at it (Rust `apply_guild_switch`,
 * which reloads this window) and comes back to the page the player was on.
 *
 * The webapp is untouched: the chip goes on after the router has drawn a page.
 * Drawn with StructsGuildCard, so a guild looks the same here as anywhere else.
 */
(function setupGuildPicker() {
  'use strict';

  var PAGE_KEY = 'structsGuildPage';

  // Page → where the guild goes. The title screen gets the chip; a page with a
  // form gets the row, above what it is about to ask that guild.
  var PAGES = {
    index: function () { return titleSlot(); },
    introduction: function () { return titleSlot(); },
    loginActivateDevice: function () { return formSlot('.login-activate-device-layout'); },
    loginRecoverAccountStart: function () { return formSlot('.common-layout-col.mod-justify-start'); },
  };
  // What a reload may come back to: never anything a stale value could invent.
  var RETURN = { loginActivateDevice: true, loginRecoverAccountStart: true };

  var page = null;      // the auth page on screen
  var here = null;      // the chip or row on it
  var listings = null;  // the last directory read
  var busy = false;

  function cfg() { return window.__STRUCTS_CONFIG__ || null; }
  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (!t || !t.core) return Promise.reject(new Error('not in the app'));
    return Promise.resolve().then(function () { return t.core.invoke(cmd, args); });
  }
  function cards() { return window.StructsGuildCard; }
  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pressable(node, label, fn) {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', label);
    node.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    node.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      fn();
    });
    return node;
  }

  /** The guild the app is pointed at, as much of it as is known. */
  function current() {
    var c = cfg();
    if (!c || !c.guildId) return null;
    var known = (listings || []).filter(function (g) { return g.id === c.guildId; })[0];
    return describe(known || { id: c.guildId, name: c.name, tag: c.guildTag });
  }

  function describe(g) {
    return {
      id: g.id, name: g.name, tag: g.tag, logo: g.logo,
      readings: g.members == null ? [] : [{ value: Number(g.members).toLocaleString('en-US'), icon: 'sui-icon-players', title: 'Members' }],
    };
  }

  // ── on the page ───────────────────────────────────────────────────────
  function titleSlot() {
    var btn = document.getElementById('new-player-btn');
    var box = btn && btn.parentNode;
    if (!box) return null;
    box.classList.add('gp-title');
    return { put: function (n) { box.insertBefore(n, btn); }, shape: 'chip' };
  }

  function formSlot(selector) {
    var box = document.querySelector(selector);
    if (!box) return null;
    box.classList.add('gp-page');
    return { put: function (n) { box.insertBefore(n, box.firstChild); }, shape: 'row' };
  }

  function draw(g, shape) {
    var node = shape === 'chip' ? cards().chip(g, {}) : cards().row(g, {});
    if (shape === 'chip') {
      // The card draws an anchor only when it is given a click of its own.
      var a = make('a', node.className + ' gp-chip');
      a.href = 'javascript:void(0)';
      a.setAttribute('data-guild-id', g.id);
      while (node.firstChild) a.appendChild(node.firstChild);
      node = a;
    } else {
      node.classList.add('gp-here');
    }
    node.appendChild(make('span', 'gp-caret'));
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('aria-expanded', 'false');
    return pressable(node, 'Guild: ' + (g.name || g.id) + '. Change guild', openDirectory);
  }

  function decorate() {
    if (here && here.parentNode) here.parentNode.removeChild(here);
    here = null;
    var g = current();
    if (!g || !cards() || !PAGES[page]) return;
    var slot = PAGES[page]();
    if (!slot) return;
    here = draw(g, slot.shape);
    slot.put(here);
  }

  function load() {
    return invoke('guild_listings').then(function (all) {
      listings = Array.isArray(all) ? all : [];
      if (PAGES[page]) decorate(); // the logo and the count
      return listings;
    });
  }

  // ── the directory ─────────────────────────────────────────────────────
  function offcanvas() {
    var m = window.menuPage;
    return m && m.sui && m.sui.offcanvas;
  }

  function openDirectory() {
    var oc = offcanvas();
    if (!oc || busy) return;
    oc.setHeader('Guilds');
    oc.setContent('<div class="gp-find"></div><div class="gp-list"></div>');
    var el = oc.offcanvasElm;
    // The game opens its offcanvas on the left; this one belongs on the right,
    // clear of the buttons. Put back when it closes.
    el.classList.remove('sui-mod-left');
    el.classList.add('sui-mod-right', 'gp-open');
    oc.open();
    if (here) here.setAttribute('aria-expanded', 'true');
    oc.signal.addEventListener('abort', function () {
      el.classList.remove('sui-mod-right', 'gp-open');
      el.classList.add('sui-mod-left');
      if (here) here.setAttribute('aria-expanded', 'false');
    });

    var find = el.querySelector('.gp-find');
    var label = make('label', 'sui-input-text');
    label.appendChild(make('span', null, 'Guild'));
    var input = make('input');
    input.type = 'text';
    input.placeholder = 'Find a guild';
    label.appendChild(input);
    find.appendChild(label);
    var list = el.querySelector('.gp-list');
    input.addEventListener('input', function () { fill(list, input.value); });

    if (listings) fill(list, '');
    else note(list, 'Loading');
    load().then(function () {
      if (list.isConnected && !busy) fill(list, input.value);
    }, function (e) {
      console.warn('[GuildPicker] directory:', e);
      if (list.isConnected && !listings) note(list, 'The guild directory could not be read.', true);
    });
  }

  function note(list, text, warn) {
    list.textContent = '';
    list.appendChild(make('div', 'gp-note ' + (warn ? 'sui-text-warning' : 'sui-text-hint'), text));
  }

  function matches(g, q) {
    return !q || [g.name, g.tag, g.id].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function fill(list, query) {
    var q = String(query || '').trim().toLowerCase();
    var mine = cfg() && cfg().guildId;
    var shown = (listings || []).filter(function (g) { return matches(g, q); });
    if (!shown.length) { note(list, 'No guilds'); return; }
    list.textContent = '';
    shown.forEach(function (g) {
      var row = cards().row(describe(g), {});
      row.classList.add('gp-row');
      var about = make('div', 'gp-about');
      if (g.recruiting) about.appendChild(make('span', 'sui-badge sui-mod-default', 'Open'));
      about.appendChild(make('span', 'sui-text-tiny', g.description || '#' + g.id));
      about.title = g.description || '';
      var id = row.querySelector('.pc-id');
      if (id) id.parentNode.replaceChild(about, id);
      if (g.id === mine) {
        row.setAttribute('aria-current', 'true');
        row.insertBefore(make('i', 'sui-icon sui-icon-sm icon-success gp-tick'), row.querySelector('.pc-reads'));
      }
      list.appendChild(pressable(row, g.name || g.id, function () { pick(g, list); }));
    });
  }

  function pick(g, list) {
    if (busy) return;
    if (cfg() && cfg().guildId === g.id) { offcanvas().close(); return; }
    busy = true;
    list.classList.add('gp-busy');
    note(list, 'Connecting to ' + (g.name || g.id));
    try { sessionStorage.setItem(PAGE_KEY, page || 'index'); } catch (e) { /* comes back to the title */ }
    invoke('apply_guild_switch', { guildId: g.id }).then(function () {
      // The window is about to reload.
    }, function (e) {
      console.warn('[GuildPicker] switch to ' + g.id + ':', e);
      try { sessionStorage.removeItem(PAGE_KEY); } catch (e2) { /* ignored */ }
      busy = false;
      list.classList.remove('gp-busy');
      note(list, 'Could not connect to ' + (g.name || g.id) + '.', true);
    });
  }

  // ── the router ────────────────────────────────────────────────────────
  function takeReturn() {
    try {
      var p = sessionStorage.getItem(PAGE_KEY);
      sessionStorage.removeItem(PAGE_KEY);
      return RETURN[p] ? p : null;
    } catch (e) { return null; }
  }

  function install(menu) {
    var router = menu && menu.router;
    if (!router || typeof router.goto !== 'function' || router.goto.__structsGuildPicker) return;
    var navigate = router.goto;
    var w = function (controller, name) {
      if (controller === 'Auth' && (name === 'index' || name === 'introduction')) {
        var back = takeReturn();
        if (back) return router.goto('Auth', back);
      }
      var oc = offcanvas();
      if (oc && oc.offcanvasElm && oc.offcanvasElm.classList.contains('gp-open')) oc.close();
      page = controller === 'Auth' && PAGES[name] ? name : null;
      var r = navigate.apply(this, arguments);
      // saved-account.js may have drawn its own page instead; then there is no
      // slot and nothing is added.
      if (page) {
        decorate();
        if (here && !listings) load().catch(function (e) { console.info('[GuildPicker] directory:', e); });
      }
      return r;
    };
    w.__structsGuildPicker = true;
    router.goto = w;
  }

  // Chain onto saved-account.js's accessor: its wrap goes on first, inside ours.
  var prior = Object.getOwnPropertyDescriptor(window, 'menuPage');
  var value = window.menuPage;
  Object.defineProperty(window, 'menuPage', {
    configurable: true,
    enumerable: true,
    get: function () { return prior && prior.get ? prior.get.call(window) : value; },
    set: function (v) {
      if (prior && prior.set) prior.set.call(window, v); else value = v;
      install(v);
    },
  });
  if (value) install(value);

  window.StructsGuildPicker = { open: openDirectory };
})();
