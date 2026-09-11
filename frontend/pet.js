/* The desktop companion.
 *
 * A small transparent window that floats over everything and, nearly always,
 * says NOTHING. It is a character on the desktop; words appear only when
 * something needs a person. Its whole state arrives on ONE pushed event
 * (`companion`); this file never polls Rust and never decides anything — the
 * one door it has opens a window that is already allowed to act.
 *
 * THE PERFORMANCE RULE, which is not a style preference:
 *
 *   droidsh measured its pet at 13.22% of one core on a display-link
 *   animation schedule and 2.37% on a one-second one, for a 1px bob nobody
 *   can tell apart. An always-on window that eats battery is an always-on
 *   window that gets closed. So: ONE 1 Hz interval, no requestAnimationFrame
 *   for the idle state, and the celebration is a short burst that stops
 *   itself. `prefers-reduced-motion` turns both off entirely.
 *
 * The celebration is triggered by a TIMESTAMP rather than by a call —
 * `sparkle(since)` — so it replays correctly after a redraw, cannot desync
 * from the model, and needs no animation state of its own.
 */
(function () {
  'use strict';

  var IDLE_MS = 1000;      // the whole idle budget: one tick a second
  var SPARK_MS = 3000;     // a celebration ends itself
  var SPARK_FPS = 20;
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function invoke(cmd, args) {
    var T = window.__TAURI__;
    if (!T || !T.core || typeof T.core.invoke !== 'function') return Promise.reject('no bridge');
    return T.core.invoke(cmd, args || {});
  }

  var nodes = {
    root: document.getElementById('pet'),
    note: document.getElementById('pet-note'),
    portrait: document.getElementById('pet-portrait'),
    spark: document.getElementById('pet-spark'),
    close: document.getElementById('pet-close'),
  };

  var state = { note: null, tone: '', door: 'board', pfp: null };
  var drawnPfp = ' ';   // a value no attribute string can equal
  var bob = 0;
  var sparkFrom = 0;
  var sparkTimer = null;
  var lastHelped = null;

  // ── The portrait ───────────────────────────────────────────────────────
  // Drawn only when the attributes CHANGE. Rebuilding five <img> layers every
  // second is a request storm and a flicker, and the portrait almost never
  // moves.
  function drawPortrait() {
    if (state.pfp === drawnPfp) return;
    drawnPfp = state.pfp;
    // Replace only the art. The celebration canvas is a child of this node
    // too, and emptying the node would delete it — after which a payout would
    // silently stop being celebrated.
    var old = nodes.portrait.querySelector('.pc-pfp');
    if (old) old.remove();
    // `pfp` is written by the player on chain: it is not our data, so it goes
    // through the component that validates every layer index rather than into
    // an <img src> built here.
    var PC = window.StructsPlayerCard;
    var art = PC && PC.portrait ? PC.portrait(state.pfp) : el('div', 'pc-pfp');
    nodes.portrait.insertBefore(art, nodes.portrait.firstChild);
  }

  /* ── What it says ───────────────────────────────────────────────────────
   *
   * Nothing, nearly always. Rust decides whether there is a note at all (see
   * `companion::caption`); this only draws one when there is.
   *
   * The bar for putting words on a window that floats over somebody's work is
   * not "is this true" — it is *would they want to stop and act on it*. A
   * rate, a crew they switched on themselves, and their own player id all
   * failed that, and the first version showed all three.
   */
  function draw() {
    var note = state.note;
    nodes.note.hidden = !note;
    nodes.note.textContent = note || '';
    nodes.root.classList.toggle('pet-mod-bad', state.tone === 'bad');
    drawPortrait();
  }

  // ── Celebration ────────────────────────────────────────────────────────
  // Eight diamonds converging inward over three seconds, driven by elapsed
  // time rather than a frame counter, then the timer is cleared. Nothing runs
  // between celebrations.
  function sparkle(since) {
    if (reduced || !nodes.spark || !nodes.spark.getContext) return;
    sparkFrom = since || Date.now();
    if (sparkTimer) return;
    sparkTimer = setInterval(function () {
      var phase = (Date.now() - sparkFrom) / SPARK_MS;
      if (phase >= 1) {
        clearInterval(sparkTimer);
        sparkTimer = null;
        clearSpark();
        return;
      }
      paintSpark(phase);
    }, Math.round(1000 / SPARK_FPS));
  }

  function ctx2d() {
    // jsdom has no canvas. A pet that throws here would show nothing at all,
    // so every drawing path asks first.
    try { return nodes.spark && nodes.spark.getContext ? nodes.spark.getContext('2d') : null; }
    catch (e) { return null; }
  }

  function clearSpark() {
    var g = ctx2d();
    if (g) g.clearRect(0, 0, nodes.spark.width, nodes.spark.height);
  }

  function paintSpark(phase) {
    var g = ctx2d();
    if (!g) return;
    var c = nodes.spark;
    g.clearRect(0, 0, c.width, c.height);
    var cx = c.width / 2, cy = c.height / 2;
    g.globalAlpha = Math.max(0, 1 - phase);
    g.fillStyle = readToken('--accent-primary');
    for (var i = 0; i < 8; i++) {
      var p = Math.max(0, Math.min(1, phase - i * 0.04));
      var ang = (i / 8) * Math.PI * 2;
      var r = 62 * (1 - p);
      var x = cx + Math.cos(ang) * r;
      var y = cy + Math.sin(ang) * r - p * 14;
      g.beginPath();
      g.moveTo(x, y - 4); g.lineTo(x + 4, y); g.lineTo(x, y + 4); g.lineTo(x - 4, y);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // The accent the window is actually painted in. Read from the stylesheet so
  // the canvas can never drift from a colour invented here.
  function readToken(name) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
    catch (e) { return ''; }
  }

  // ── The one timer ──────────────────────────────────────────────────────
  // A single pixel of vertical movement, once a second, so the window looks
  // alive without costing anything. This is the entire idle animation.
  function idle() {
    if (reduced) return;
    bob = bob ? 0 : 1;
    nodes.portrait.style.transform = 'translateY(' + (bob ? -1 : 1) + 'px)';
  }

  // ── State in ───────────────────────────────────────────────────────────
  function apply(next) {
    if (!next) return;
    var before = lastHelped;
    Object.keys(next).forEach(function (k) { state[k] = next[k]; });
    draw();
    // Something finished for somebody: worth a flourish, once, on the change.
    var helped = Number(state.crew_helped || 0);
    if (before != null && helped > before) sparkle(Date.now());
    lastHelped = helped;
  }

  // The note is the only door, and only while there is one: it opens the
  // window that can act on whatever it is about. A quiet pet offers nothing,
  // which is correct — the menu bar and ⌘K are both a keystroke away.
  nodes.note.addEventListener('click', function () {
    invoke('companion_open', { what: state.door || 'board' }).catch(function () {});
  });

  // ── Getting out of the way, and getting rid of it ──────────────────────
  //
  // This window floats over everything the player is doing. Both of these are
  // the price of that, not features:
  //
  //   MOVING IT. `data-tauri-drag-region` cannot do the job — Tauri's handler
  //   tests `e.target.getAttribute(...)` on the EXACT target with no walk up
  //   the tree, and this drag surface is a div full of <img> layers, so the
  //   target is always an image and the attribute is never found. The window
  //   was pinned to wherever it first opened. Asking the window to drag
  //   itself works whatever the portrait is made of.
  //
  //   CLOSING IT. A close control on the thing itself, plus Escape. Neither
  //   requires finding another window first, which is the whole point: if the
  //   only way to dismiss something is somewhere else, it is not dismissable
  //   at the moment you want it gone.
  nodes.portrait.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();      // no text cursor, no image drag
    drag();
  });

  function drag() {
    /* One path, and it is OUR command.
     *
     * The first version tried `getCurrentWindow().startDragging()` first and
     * fell back to the command — except `startDragging()` returns a PROMISE,
     * so a rejection (a missing `core:window:allow-start-dragging` capability,
     * say) landed nowhere: the try/catch only wrapped the synchronous call and
     * the early `return` meant the fallback never ran. A silent no-op that
     * looks like working code.
     */
    invoke('companion_drag').catch(function () {});
  }

  function dismiss() {
    invoke('companion_dismiss').catch(function () {});
  }
  nodes.close.addEventListener('click', dismiss);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') dismiss();
  });

  if (window.StructsEvents) {
    window.StructsEvents.listen('companion', function (e) { apply(e && e.payload); });
  }
  invoke('companion_state').then(apply).catch(function () { draw(); });
  draw();
  setInterval(idle, IDLE_MS);

  // For the harness, which drives this without a Tauri runtime.
  window.StructsPet = {
    apply: apply, sparkle: sparkle, state: function () { return state; },
    drag: drag, dismiss: dismiss,
  };
})();
