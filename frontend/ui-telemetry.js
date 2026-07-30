// UI interaction logging: which control a player used, in which window, on
// which page. Feeds the `ui_events` table so a support bundle can answer "what
// did they actually click before it broke", which no other stream records.
//
// PRIVACY BY CONSTRUCTION. This captures element IDENTITY only — label text,
// id, classes, tag. It never reads `value`, never touches inputs' contents, and
// never serialises form state, so it cannot capture an address, an amount, a
// name, or anything else a player typed. Clicks inside password-like or
// text-entry fields record the field's identity, not its contents.
//
// Batched: one invoke every FLUSH_MS with everything that accumulated, so a
// click storm can't become an IPC storm. Capture phase, so a handler that stops
// propagation (several do) can't hide the interaction.
(function () {
  'use strict';
  if (window.__STRUCTS_UI_TELEMETRY__) return;
  window.__STRUCTS_UI_TELEMETRY__ = true;

  var FLUSH_MS = 2000;
  /// Hard cap per flush; beyond this the batch is truncated and the drop is
  /// recorded, so a runaway never balloons the queue silently.
  var MAX_BATCH = 200;
  var queue = [];
  var dropped = 0;

  // Which window this is, for the `window` column. The board and its pop-out
  // share a document, so `?view=` distinguishes them.
  function windowName() {
    var f = (location.pathname || '').split('/').pop() || 'index.html';
    var view = (location.search.match(/[?&]view=([^&]+)/) || [])[1];
    if (f.indexOf('board') === 0) return view ? 'board:' + view : 'board';
    if (f.indexOf('raidview') === 0) return 'raidview';
    return 'main';
  }

  // Current page/route, best-effort per window family.
  function pageName() {
    if (location.hash && location.hash.length > 2) return location.hash.replace(/^#\/?/, '');
    var active = document.querySelector('.sui-screen-nav-item.sui-mod-active');
    if (active && active.textContent) return active.textContent.trim().slice(0, 40);
    return null;
  }

  // A short human-readable label: prefer accessible text, fall back to id.
  // Truncated because a label is for recognition, not reproduction.
  function labelOf(el) {
    var t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    if (!t && el.tagName === 'OPTION') t = el.textContent || '';
    if (!t) t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t && el.id) t = '#' + el.id;
    return t ? t.slice(0, 80) : null;
  }

  // Stable-ish identity for grouping: tag + id + the first couple of classes.
  function targetOf(el) {
    var parts = [el.tagName ? el.tagName.toLowerCase() : '?'];
    if (el.id) parts.push('#' + el.id);
    var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/) : [];
    if (cls.length) parts.push('.' + cls.slice(0, 2).join('.'));
    return parts.join('').slice(0, 120);
  }

  // Walk up to the nearest thing that is plausibly "the control", so clicking
  // the icon inside a button records the button.
  function controlFor(el) {
    for (var n = 0; el && n < 5; el = el.parentElement, n++) {
      if (!el.tagName) continue;
      var tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'INPUT' || tag === 'OPTION') return el;
      var c = (typeof el.className === 'string') ? el.className : '';
      // NB: no `sui-icon-` here. Icons are CHILDREN of buttons and carry that
      // class themselves, so matching it stopped the walk on the icon and
      // logged a label-less `i.sui-icon-…` row instead of the button.
      if (/sui-button|ops-refresh-btn|sui-screen-nav-item|-btn\b/.test(c)) return el;
      if (el.getAttribute && el.getAttribute('role') === 'button') return el;
    }
    return null;
  }

  function push(kind, el) {
    if (!el) return;
    if (queue.length >= MAX_BATCH) { dropped++; return; }
    queue.push({
      ts_ms: Date.now(),
      window: windowName(),
      page: pageName(),
      kind: kind,
      label: labelOf(el),
      target: targetOf(el),
    });
  }

  document.addEventListener('click', function (e) {
    var el = controlFor(e.target);
    // Unmatched clicks (background, text) are noise — skip rather than log
    // every stray click on the page body.
    if (el) push('click', el);
  }, true);

  // A select's VALUE is data; that it changed, and which control, is not.
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type === 'checkbox'))) {
      push('change', t);
    }
  }, true);

  function flush() {
    if (!queue.length || !window.__TAURI__ || !window.__TAURI__.core) return;
    var batch = queue;
    queue = [];
    if (dropped) {
      batch.push({
        ts_ms: Date.now(), window: windowName(), page: pageName(),
        kind: 'dropped', label: String(dropped) + ' events dropped (batch cap)', target: 'ui-telemetry',
      });
      dropped = 0;
    }
    window.__TAURI__.core.invoke('log_ui_events', { events: batch }).catch(function () {
      // Losing UI telemetry must never surface to the player or retry-loop.
    });
  }

  setInterval(flush, FLUSH_MS);
  // Don't lose the last clicks before a window closes or hides.
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
})();
