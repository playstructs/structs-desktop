// Team Ops Command Center — core runtime: hash router, per-page refresh
// scheduler, shared helpers, EVENT FEED, agent-UI directives, and the OPS page.
// Page renderers (fleet/energy/work/config/map) live in board-pages.js.
//
// This file MUST stay at the frontend ROOT: scripts/sync.sh deletes and
// rebuilds frontend/js/ from the webapp submodule, but preserves root-level
// files (index.html, structs-config.js, board.html — and these).
(function () {
  'use strict';

  var Board = window.Board = {
    T: null,                 // window.__TAURI__ once available
    pages: {},               // name -> { onEnter?, refresh?, cadenceMs?, lastRun }
    current: 'ops',
    helpers: {},
  };

  var PAGE_NAMES = ['ops', 'fleet', 'energy', 'work', 'tx', 'grass', 'war', 'config', 'map'];

  Board.registerPage = function (name, def) {
    def = def || {};
    def.lastRun = 0;
    Board.pages[name] = def;
  };

  // ── Shared helpers (mirror the Rust irow/card look) ──────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Label/value row inside a sui-data-card-body. `value` may be a node or string.
  function row(label, value, iconCls) {
    var r = el('div', 'sui-data-card-row');
    var l = el('span');
    if (iconCls) {
      var ic = el('i', iconCls.indexOf('sui-icon-') === 0 ? 'sui-icon ' + iconCls + ' sui-icon-sm' : iconCls);
      l.appendChild(ic);
      l.appendChild(document.createTextNode(' '));
    }
    l.appendChild(document.createTextNode(label));
    var v = el('span', 'ops-val');
    if (value && value.nodeType) v.appendChild(value); else v.textContent = value == null ? '' : String(value);
    r.appendChild(l); r.appendChild(v);
    return r;
  }
  function card(title, bodyNode) {
    var c = el('div', 'sui-data-card sui-theme-player');
    c.appendChild(el('div', 'sui-data-card-header sui-text-header', title));
    var b = el('div', 'sui-data-card-body sui-mod-spacing-xl');
    b.appendChild(bodyNode);
    c.appendChild(b);
    return c;
  }
  function badge(text, mod) {
    return el('span', 'sui-badge' + (mod ? ' sui-mod-' + mod : ''), text);
  }
  // Tiny charge/energy meter: n-of-total filled cells (scoped .fbat CSS —
  // lighter than sui-battery's PNG chunks at 12px row height).
  function battery(filled, total) {
    var b = el('span', 'fbat');
    for (var i = 0; i < total; i++) {
      b.appendChild(el('i', i < filled ? 'on' : ''));
    }
    return b;
  }
  // Progress bar 0..1 (scoped .bar CSS).
  function progressBar(frac) {
    var wrap = el('div', 'bar');
    var fill = el('i');
    fill.style.width = Math.max(0, Math.min(1, frac || 0)) * 100 + '%';
    wrap.appendChild(fill);
    return wrap;
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    if (a >= 100) return String(Math.round(n));
    return (Math.round(n * 10) / 10).toString();
  }
  // Full integer, thousands-separated — for block heights and anything where
  // abbreviation destroys the meaning.
  function fmtInt(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(Number(n)).toLocaleString();
  }
  // The game's display ladders (server UNIT_DISPLAY_FORMAT): pick a unit by
  // the integer digit-length of the RAW value, round to 2 decimals.
  function ladder(raw, steps) {
    if (raw == null || isNaN(raw)) return '—';
    var n = Math.abs(Math.floor(Number(raw)));
    var len = String(n).length;
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
      if (len <= steps[i][0]) { step = steps[i]; break; }
    }
    var v = Number(raw) / step[1];
    var txt = v.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    return txt + ' ' + step[2];
  }
  // Energy: raw value in MILLIWATTS.
  function fmtWatts(mw) {
    return ladder(mw, [[2, 1, 'mW'], [5, 1e3, 'W'], [9, 1e6, 'kW'], [15, 1e9, 'MW'], [99, 1e18, 'TW']]);
  }
  // Alpha: raw value in ualpha (micrograms).
  function fmtAlpha(ualpha) {
    return ladder(ualpha, [[2, 1, 'μg'], [5, 1e3, 'mg'], [9, 1e6, 'g'], [15, 1e9, 'Kg'], [99, 1e18, 'Tg']]);
  }
  // Ore: raw value in grams.
  function fmtOre(g) {
    return ladder(g, [[3, 1, 'g'], [11, 1e3, 'Kg'], [99, 1e18, 'Tg']]);
  }
  function ago(ms) {
    if (!ms) return '—';
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return Math.round(s) + 's';
    if (s < 5400) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }
  function alertLine(text, iconCls) {
    var a = el('div', 'sui-message-inline-alert');
    a.appendChild(el('i', iconCls || 'icon-info'));
    var t = el('span', 'sui-message-inline-alert-text');
    t.textContent = ' ' + text;
    a.appendChild(t);
    return a;
  }
  // Resolve an icon name to the right class string: PNG sui-icon-* glyphs need
  // the `sui-icon` base + a size; structicon `icon-*` glyphs stand alone.
  function iconClass(name, size) {
    if (!name) return '';
    return name.indexOf('sui-icon-') === 0
      ? 'sui-icon ' + name + ' ' + (size || 'sui-icon-sm')
      : name;
  }
  // Compose the game's 5-layer profile portrait from on-chain attributes
  // (`{head,neck,body,arms,background}`), painted back-to-front exactly like the
  // webapp's PfpViewerComponent. Falls back to the placeholder when a player has
  // no portrait yet. `fallbackIcon` (a sui-icon name) is used only if even the
  // placeholder is unwanted — normally omit it. Returns a portrait node.
  var PFP_LAYERS = ['background', 'arms', 'body', 'neck', 'head'];
  function pfpPortrait(attrsJson) {
    var box = el('div', 'sui-result-row-portrait');
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
    box.appendChild(img);
    return box;
  }
  // ── Native SUI result-row builders (the game's raid-scan / roster idiom) ──
  // Header-less: each row self-describes via a left identity section and a
  // right row of `sui-resource` chips (value + icon). No column headers to
  // misalign; reflows on the narrow board window.
  function resultTable() { return el('div', 'sui-result-rows sui-result-table'); }
  // A single value+icon chip. `value` may be a node or string; icon optional.
  function resource(value, iconName, extraCls) {
    var d = el('div', 'sui-resource' + (extraCls ? ' ' + extraCls : ''));
    var v = el('span');
    if (value && value.nodeType) v.appendChild(value); else v.textContent = value == null ? '' : String(value);
    d.appendChild(v);
    if (iconName) d.appendChild(el('i', iconClass(iconName)));
    return d;
  }
  // Build one sui-result-row. opts: { lead?(node, e.g. checkbox), icon?(portrait
  // glyph), title(str|node), subtitle?(str|node), chips?([node]), action?(node),
  // onClick? }.
  function resultRow(opts) {
    var r = el('div', 'sui-result-row');
    var left = el('div', 'sui-result-row-left-section');
    if (opts.lead) left.appendChild(opts.lead);
    // `portrait` (a prebuilt node, e.g. from pfpPortrait) wins over `icon`
    // (a sui-icon glyph framed as a portrait).
    if (opts.portrait) {
      left.appendChild(opts.portrait);
    } else if (opts.icon) {
      var port = el('div', 'sui-result-row-portrait');
      var pin = el('div', 'sui-result-row-portrait-icon');
      pin.appendChild(el('i', iconClass(opts.icon, 'sui-icon-md')));
      port.appendChild(pin);
      left.appendChild(port);
    }
    var info = el('div', 'sui-result-row-player-info');
    var lbl = el('div', 'sui-text-label-block');
    if (opts.title && opts.title.nodeType) lbl.appendChild(opts.title);
    else lbl.appendChild(document.createTextNode(opts.title == null ? '' : String(opts.title)));
    if (opts.subtitle != null) {
      lbl.appendChild(el('br'));
      var hint = el('span', 'sui-text-hint');
      if (opts.subtitle.nodeType) hint.appendChild(opts.subtitle); else hint.textContent = String(opts.subtitle);
      lbl.appendChild(hint);
    }
    info.appendChild(lbl);
    left.appendChild(info);
    r.appendChild(left);
    var right = el('div', 'sui-result-row-right-section');
    var res = el('div', 'sui-result-row-resources');
    (opts.chips || []).forEach(function (c) { if (c) res.appendChild(c); });
    right.appendChild(res);
    if (opts.action) right.appendChild(opts.action);
    r.appendChild(right);
    if (opts.onClick) { r.style.cursor = 'pointer'; r.addEventListener('click', opts.onClick); }
    return r;
  }
  // ── Shared sorting ──────────────────────────────────────────────────────
  // sortControl builds a `<select>` of {key,label} + a caret asc/desc toggle,
  // mutating `state` ({key,dir}) and calling onChange. sortBy returns a sorted
  // copy using per-key accessors. Used identically by Fleet / Energy / Work.
  function sortControl(keys, state, onChange) {
    var wrap = el('div', null);
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;';
    var sel = el('select', 'sui-input-text');
    keys.forEach(function (k, i) {
      var op = el('option', null, (i === 0 ? 'sort: ' : '') + k.label);
      op.value = k.key;
      if (k.key === state.key) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { state.key = sel.value; onChange(); });
    var dir = el('a', 'ops-refresh-btn'); dir.href = 'javascript:void(0)';
    var di = el('i', state.dir > 0 ? 'icon-caret-down' : 'icon-caret-up');
    dir.appendChild(di);
    dir.addEventListener('click', function () {
      state.dir = -state.dir;
      di.className = state.dir > 0 ? 'icon-caret-down' : 'icon-caret-up';
      onChange();
    });
    wrap.appendChild(sel); wrap.appendChild(dir);
    return wrap;
  }
  function sortBy(rows, state, accessors) {
    var acc = accessors[state.key] || function () { return 0; };
    var d = state.dir;
    return rows.slice().sort(function (a, b) {
      var va = acc(a), vb = acc(b);
      if (va < vb) return -d;
      if (va > vb) return d;
      return 0;
    });
  }
  // ── Native SUI form controls ─────────────────────────────────────────────
  // The game's own checkbox/stepper/select markup, so config surfaces look like
  // the rest of the client instead of raw browser widgets. Each returns a node
  // and calls `onChange(value)`; none of them hold state.
  function checkbox(checked, labelText, onChange) {
    var c = el('span', 'sui-checkbox-container');
    var box = el('input', 'sui-checkbox');
    box.type = 'checkbox';
    box.checked = !!checked;
    var disp = el('span', 'sui-checkbox-display');
    var lab = el('label');
    if (labelText != null) lab.appendChild(document.createTextNode(String(labelText)));
    box.addEventListener('change', function () { onChange(box.checked); });
    // The display is a sibling styled by `:checked ~ .sui-checkbox-display`, so
    // the input must come first and the label last.
    c.appendChild(box); c.appendChild(disp); c.appendChild(lab);
    return c;
  }
  // Numeric stepper with the game's caret buttons. `opts`: {min,max,step,width}.
  function stepper(value, opts, onChange) {
    opts = opts || {};
    var w = el('span', 'sui-input-stepper');
    var input = el('input');
    input.type = 'number';
    input.value = value == null ? '' : value;
    if (opts.min != null) input.min = opts.min;
    if (opts.max != null) input.max = opts.max;
    input.step = opts.step == null ? 1 : opts.step;
    if (opts.width) input.style.width = opts.width;
    function commit(v) {
      var n = Number(v);
      if (isNaN(n)) return;
      if (opts.min != null) n = Math.max(opts.min, n);
      if (opts.max != null) n = Math.min(opts.max, n);
      // Float steps accumulate noise (0.1+0.2); round to the step's precision.
      var dp = String(input.step).indexOf('.') >= 0 ? String(input.step).split('.')[1].length : 0;
      n = Number(n.toFixed(dp));
      input.value = n;
      onChange(n);
    }
    function bump(dir) {
      var cur = Number(input.value) || 0;
      commit(cur + dir * Number(input.step || 1));
    }
    var down = el('a', 'sui-nav-btn'); down.href = 'javascript:void(0)';
    down.appendChild(el('i', 'icon-caret-down'));
    down.addEventListener('click', function () { bump(-1); });
    var up = el('a', 'sui-nav-btn'); up.href = 'javascript:void(0)';
    up.appendChild(el('i', 'icon-caret-up'));
    up.addEventListener('click', function () { bump(1); });
    input.addEventListener('change', function () { commit(input.value); });
    w.appendChild(down); w.appendChild(input); w.appendChild(up);
    return w;
  }
  function selectBox(value, options, onChange) {
    var s = el('select', 'sui-input-text');
    (options || []).forEach(function (o) {
      var val = (o && o.value != null) ? o.value : o;
      var lbl = (o && o.label != null) ? o.label : o;
      var op = el('option', null, String(lbl));
      op.value = val;
      if (val === value) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function textBox(value, placeholder, onChange) {
    var i = el('input', 'sui-input-text');
    i.type = 'text';
    i.value = value == null ? '' : value;
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('change', function () { onChange(i.value); });
    return i;
  }
  // A secondary nav strip — the same component as the board's own tab bar, so
  // a page that needs sub-sections reads as native rather than bespoke.
  // `items`: [{key,label}]. Returns a node; `onPick(key)` fires on click.
  function navStrip(items, activeKey, onPick) {
    var wrap = el('div', 'sui-screen sui-screen-full-width subnav');
    var bar = el('div', 'sui-screen-nav');
    var list = el('div', 'sui-screen-nav-items');
    items.forEach(function (it) {
      var a = el('a', 'sui-screen-nav-item' + (it.key === activeKey ? ' sui-mod-active' : ''));
      a.href = 'javascript:void(0)';
      a.textContent = it.label;
      a.addEventListener('click', function () { onPick(it.key); });
      list.appendChild(a);
    });
    bar.appendChild(list);
    wrap.appendChild(bar);
    return wrap;
  }
  // Label on the left, control on the right — the config idiom.
  function field(label, controlNode, hint) {
    var r = el('div', 'cfg-row');
    var l = el('div', 'sui-form-element-label-group');
    l.appendChild(el('span', null, label));
    if (hint) l.appendChild(el('span', 'sui-text-hint', hint));
    r.appendChild(l);
    r.appendChild(controlNode);
    return r;
  }

  // A centered modal overlay (row detail). Returns a close() fn.
  function detailModal(title, contentNode) {
    var existing = document.getElementById('detail-overlay');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var ov = el('div', null); ov.id = 'detail-overlay';
    var panel = el('div', 'detail-panel');
    var head = el('div', 'detail-head');
    head.appendChild(el('div', 'sui-text-header', title));
    var x = el('a', 'detail-x'); x.href = 'javascript:void(0)';
    x.appendChild(el('i', 'icon-close'));
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    x.addEventListener('click', close);
    head.appendChild(x);
    panel.appendChild(head);
    if (contentNode) panel.appendChild(contentNode);
    ov.appendChild(panel);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    return close;
  }
  Board.helpers = {
    esc: esc, el: el, row: row, card: card, badge: badge, battery: battery,
    progressBar: progressBar, fmtNum: fmtNum, ago: ago, alertLine: alertLine,
    iconClass: iconClass, resultTable: resultTable, resource: resource, resultRow: resultRow,
    sortControl: sortControl, sortBy: sortBy, detailModal: detailModal,
    pfpPortrait: pfpPortrait,
    checkbox: checkbox, stepper: stepper, selectBox: selectBox, textBox: textBox,
    navStrip: navStrip, field: field,
    fmtInt: fmtInt, fmtWatts: fmtWatts, fmtAlpha: fmtAlpha, fmtOre: fmtOre,
  };

  // ── Router ────────────────────────────────────────────────────────────────
  // #/fleet, #/map?p=2-459 … Persistent [hidden]-toggled page divs.
  Board.pageParams = {};
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var qi = h.indexOf('?');
    var params = {};
    if (qi >= 0) {
      h.slice(qi + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
      h = h.slice(0, qi);
    }
    var page = PAGE_NAMES.indexOf(h) >= 0 ? h : 'ops';
    Board.current = page;
    Board.pageParams = params;
    PAGE_NAMES.forEach(function (p) {
      var div = document.getElementById('page-' + p);
      if (div) div.hidden = (p !== page);
    });
    var tabs = document.querySelectorAll('#board-tabs .sui-screen-nav-item');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('sui-mod-active', tabs[i].getAttribute('data-page') === page);
    }
    var def = Board.pages[page];
    if (def && def.onEnter) def.onEnter(params);
  }

  // ── Scheduler: one 1s tick dispatching per-page cadence ─────────────────
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    var def = Board.pages[Board.current];
    if (!def || !def.refresh || !def.cadenceMs) return;
    var now = Date.now();
    if (now - def.lastRun >= def.cadenceMs) {
      def.lastRun = now;
      def.refresh();
    }
  }, 1000);

  // Manual Refresh button = refresh the CURRENT page.
  function wireRefreshButton() {
    var btn = document.getElementById('board-refresh');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var def = Board.pages[Board.current];
      if (def && def.refresh) {
        def.lastRun = Date.now();
        def.refresh();
      }
    });
  }
  Board.stamp = function (text) {
    var s = document.getElementById('board-updated');
    if (s) s.textContent = text;
  };

  // ── OPS page (existing Rust-rendered HTML path, unchanged) ──────────────
  function setupOps() {
    var T = Board.T;
    var root = document.getElementById('root');
    function render(html) { if (typeof html === 'string') root.innerHTML = html; }

    // First paint from the cached snapshot so the window is never blank while
    // the first live recompute is in flight.
    T.core.invoke('mcp_board_html').then(render).catch(function () {});
    // A structs_board tool call still pushes updates; keep listening for them.
    T.event.listen('board-update', function (e) {
      render(e && e.payload && e.payload.html);
    });

    var refreshing = false;
    function refreshBoard() {
      if (refreshing) return Promise.resolve();
      refreshing = true;
      var btn = document.getElementById('board-refresh');
      if (btn) btn.classList.add('is-busy');
      return T.core.invoke('mcp_board_refresh').then(function (html) {
        render(html);
        Board.stamp('updated ' + new Date().toLocaleTimeString());
      }).catch(function () {}).then(function () {
        refreshing = false;
        if (btn) btn.classList.remove('is-busy');
      });
    }
    Board.registerPage('ops', { refresh: refreshBoard, cadenceMs: 10000 });
    refreshBoard(); // immediate live paint on open
  }

  // ── EVENT FEED (global infra; lives on the Ops page) ────────────────────
  function setupFeed() {
    var T = Board.T;
    var feed = document.getElementById('feed-list');
    var FEED_MAX_ROWS = 150;
    function feedRow(e) {
      var li = document.createElement('li');
      if (e.severity === 'important') li.className = 'feed-important';
      else if (e.severity === 'notice') li.className = 'feed-notice';
      var ts = el('span', 'feed-ts', new Date(e.ts_ms).toLocaleTimeString());
      var src = el('span', 'feed-src', '[' + e.source + ']');
      var msg = el('span', null, e.message);
      li.appendChild(ts); li.appendChild(src); li.appendChild(msg);
      return li;
    }
    function feedAdd(e) {
      if (!e || !e.message) return;
      if (feed.firstChild && feed.firstChild.className === 'ops-muted') feed.innerHTML = '';
      feed.insertBefore(feedRow(e), feed.firstChild); // newest first
      while (feed.children.length > FEED_MAX_ROWS) feed.removeChild(feed.lastChild);
    }
    T.core.invoke('mcp_board_feed').then(function (entries) {
      (entries || []).forEach(feedAdd); // oldest→newest, so newest ends on top
    }).catch(function () {});
    T.event.listen('board-feed', function (e) { feedAdd(e && e.payload); });
  }

  // ── AGENT UI directives (global; visible on every tab) ──────────────────
  // Toasts + prompts from the policy engine / board component directives
  // render here (never over the main game view). Prompts answer back via the
  // mcp_ui_response command. Rust retries emits while a freshly-opened window
  // loads, so dedupe by directive_id.
  function setupAgentUi() {
    var T = Board.T;
    var agentBox = document.getElementById('agent-ui');
    var agentSeen = {};
    function agentRespond(id, value, cancelled) {
      T.core.invoke('mcp_ui_response', {
        response: { directive_id: id, value: value == null ? null : value, cancelled: !!cancelled }
      }).catch(function () {});
    }
    function agentRemove(id) {
      var n = document.getElementById('agent-d-' + id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
    function agentCard(d) {
      var c = d.component || {};
      var isPrompt = d.mode === 'prompt';
      var cardEl = el('div', 'agent-card' + (c.kind === 'toast' || c.kind === 'hud_badge' ? ' agent-toast' : ''));
      cardEl.id = 'agent-d-' + d.directive_id;
      var head = el('div', 'agent-card-head');
      var mark = el('span', 'agent-mark', '⚡ AGENT');
      var title = el('span', 'agent-title', c.title || c.headline || c.kind || 'agent');
      var x = el('span', 'agent-x', '✕');
      x.addEventListener('click', function () {
        if (isPrompt) agentRespond(d.directive_id, null, true);
        agentRemove(d.directive_id);
      });
      head.appendChild(mark); head.appendChild(title); head.appendChild(x);
      cardEl.appendChild(head);
      var bodyText = c.body || c.message || '';
      if (bodyText) {
        var body = el('div', 'agent-body', bodyText);
        cardEl.appendChild(body);
      }
      var buttons = c.buttons || c.options || [];
      if (isPrompt) {
        if (!buttons.length) buttons = [{ label: 'OK', value: 'ok' }];
        var brow = el('div', 'agent-buttons');
        buttons.forEach(function (b) {
          var btn = el('button', 'agent-btn', (b && b.label) || String(b));
          btn.addEventListener('click', function () {
            agentRespond(d.directive_id, (b && b.value !== undefined) ? b.value : b, false);
            agentRemove(d.directive_id);
          });
          brow.appendChild(btn);
        });
        cardEl.appendChild(brow);
      }
      return cardEl;
    }
    T.event.listen('mcp_ui_directive', function (e) {
      var d = e && e.payload;
      if (!d || !d.directive_id || agentSeen[d.directive_id]) return;
      var c = d.component || {};
      if (c.kind === 'dismiss') { if (c.target_id) agentRemove(c.target_id); return; }
      agentSeen[d.directive_id] = true;
      agentBox.insertBefore(agentCard(d), agentBox.firstChild);
      if (d.mode !== 'prompt') {
        setTimeout(function () { agentRemove(d.directive_id); }, 12000);
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    var T = window.__TAURI__;
    if (!T || !T.event || !T.core) { setTimeout(boot, 150); return; }
    // Defer one tick: if __TAURI__ existed at parse time this would otherwise
    // run BEFORE board-pages.js parses and registers its pages (classic
    // scripts execute in order; a 0ms timeout lands after both).
    setTimeout(function () { init(T); }, 0);
  }
  function init(T) {
    Board.T = T;
    setupOps();
    setupFeed();
    setupAgentUi();
    wireRefreshButton();
    // Page modules (board-pages.js) have registered by now — script order +
    // the async boot poll guarantee it. Let them do Tauri-dependent setup.
    Object.keys(Board.pages).forEach(function (name) {
      var def = Board.pages[name];
      if (def.onBoot) def.onBoot();
    });
    window.addEventListener('hashchange', route);
    route();
  }
  boot();
})();
