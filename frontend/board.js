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

  var PAGE_NAMES = ['ops', 'fleet', 'energy', 'work', 'config', 'map'];

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
  Board.helpers = {
    esc: esc, el: el, row: row, card: card, badge: badge, battery: battery,
    progressBar: progressBar, fmtNum: fmtNum, ago: ago, alertLine: alertLine,
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
