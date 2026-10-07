// Raid view — the Animation Bubble: combat happening off-screen.
//
// Transcribed from MapPictureInPictureComponent: while an attack-sequence
// animation plays for a struct whose tile is FULLY outside the scroll
// viewport, a fixed 128px bubble slides in — from the left for a defender's
// struct, from the right for an attacker's — showing that tile's terrain,
// the struct, and the SAME animation. It hides when the queue drains, and
// re-evaluates on scroll/resize so scrolling the real tile into view
// retracts it. Its lottie is MUTED: only the on-map animation drives the
// queue.
//
// Extracted from raidview.js (2026-09-06). Collaborators arrive as a context
// so scripts/harness-tests/raidpip.test.mjs can drive it with no window boot:
//
//   window.RaidPip({ state, domId, currentHealth, renderStill, stillFlags, flipsLayer, lottiePath })
//     → { PIP_SEQ, isAttackSequence, pip, pipEl, pipCellOf, pipOffscreen, pipClear, pipRender,
//         pipShow, pipRequestHide, pipOnAnimation, pipUpdateVisibility }
(function () {
  'use strict';
  window.RaidPip = function (ctx) {
    var state = ctx.state, domId = ctx.domId, currentHealth = ctx.currentHealth, renderStill = ctx.renderStill;
    var stillFlags = ctx.stillFlags, flipsLayer = ctx.flipsLayer, lottiePath = ctx.lottiePath;
    // Stacking order of simultaneous layers (impact over shake); optional so
    // older callers keep document order.
    var layerZ = typeof ctx.layerZ === 'function' ? ctx.layerZ : function () { return 1; };
    // Optional: the tile's struct-art swap, so the bubble's copy of a
    // template bundle shows the same hull the tile does.
    var injectStructArt = typeof ctx.injectStructArt === 'function' ? ctx.injectStructArt : null;

    /* ── PiP bubble — combat happening off-screen ──────────────────────────
     *
     * Transcribed from MapPictureInPictureComponent: while an attack-sequence
     * animation (ATTACK_/IMPACT_/SHAKE_/EVADE/DESTROY_ — status animations
     * never qualify) plays for a struct whose tile is FULLY outside the scroll
     * viewport, a fixed 128px bubble slides in — from the left for a
     * defender-side struct, from the right for an attacker — showing that
     * tile's terrain, the struct, and the SAME animation. It hides when the
     * queue drains, and visibility re-evaluates on scroll/resize so scrolling
     * the real tile into view retracts the bubble.
     *
     * The bubble's lottie is MUTED: its completion never advances the queue —
     * only the on-map animation drives playNext, exactly as the game keeps its
     * PIP viewer from driving the global AnimationEventQueue. */

    var PIP_SEQ = ['ATTACK_', 'IMPACT_', 'SHAKE_', 'EVADE', 'DESTROY_',
                   'DEFENSIVE_MANEUVER', 'SIGNAL_JAMMING', 'LOW_ORBIT_BALLISTIC_INTERCEPTOR_NETWORK'];
    function isAttackSequence(names) {
      return (names || []).some(function (n) {
        return PIP_SEQ.some(function (p) { return n === p || String(n).indexOf(p) === 0; });
      });
    }

    /* active: the bubble's own animation is still playing. pendingHide /
     * pendingShow: what to do once it finishes — the game never cuts the
     * bubble's animation short (MapPictureInPictureComponent: requestHide and
     * a swap both wait for handleViewerAnimationsComplete). */
    var pip = { structId: null, side: null, anims: [], swapTimer: null, active: false, pendingHide: false, pendingShow: null, gen: 0 };

    function pipEl() { return document.getElementById('rv-pip'); }

    function pipCellOf(structId) {
      var wrap = document.getElementById(domId('slot', structId));
      if (!wrap) return null;
      var n = wrap;
      while (n && String(n.className || '').indexOf('rv-cell') < 0) n = n.parentNode;
      return n || null;
    }

    /* Fully off the SCROLL VIEWPORT — not the window. The map lives inside
     * #rv-scroll under a fixed header, so the scroll box is the visible area.
     * Any partially visible tile means no bubble, same as the game. */
    function pipOffscreen(cell) {
      if (!cell || !cell.getBoundingClientRect) return false;
      var sc = document.getElementById('rv-scroll');
      if (!sc) return false;
      var v = sc.getBoundingClientRect();
      var r = cell.getBoundingClientRect();
      return r.bottom <= v.top || r.top >= v.bottom || r.right <= v.left || r.left >= v.right;
    }

    function pipDestroyAnim() {
      pip.gen++;
      pip.anims.forEach(function (a) { try { a.destroy(); } catch (e) {} });
      pip.anims = [];
      pip.active = false;
    }

    function pipClear() {
      pipDestroyAnim();
      if (pip.swapTimer) { clearTimeout(pip.swapTimer); pip.swapTimer = null; }
      var el = pipEl();
      if (el) {
        el.classList.remove('rv-vis', 'rv-side-left', 'rv-side-right');
        var mount = document.getElementById('rv-pip-struct');
        if (mount) mount.innerHTML = '';
      }
      pip.structId = null;
      pip.side = null;
      pip.pendingHide = false;
      pip.pendingShow = null;
    }

    /* MapStructLottieAnimationSVG._preloadImage: decode the sprites a layer
     * will draw BEFORE it plays, or its first frames paint with holes. Cached
     * for the page's life, like the game's; a failure is evicted, not fatal. */
    var imageCache = {};
    function preloadImages(box) {
      var imgs = box.querySelectorAll ? box.querySelectorAll('image') : [];
      var waits = [];
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].getAttribute('href') || imgs[i].getAttribute('xlink:href');
        if (!src || typeof Image === 'undefined') continue;
        if (!imageCache[src]) {
          var img = new Image();
          img.src = src;
          imageCache[src] = (typeof img.decode === 'function' ? img.decode()
            : new Promise(function (res, rej) { img.onload = res; img.onerror = rej; }))
            .catch(function (k) { return function () { delete imageCache[k]; }; }(src));
        }
        waits.push(imageCache[src]);
      }
      return Promise.all(waits);
    }

    /* The bubble's animation (every layer) played out: hand back to the still,
     * then do whatever was waiting on it. */
    function pipAnimationsDone(still) {
      if (still) still.classList.remove('rv-invisible');
      pip.active = false;
      if (pip.pendingHide) { pip.pendingHide = false; doHide(); return; }
      if (pip.pendingShow) { var next = pip.pendingShow; pip.pendingShow = null; next(); }
    }

    /* Fill the bubble for one struct: the tile's own terrain as the mask
     * background, the marker if the cell shows one, the still at the health the
     * sequence has reached, and EVERY layer of the moment the map is playing.
     *
     * Follows the game's viewer (MapStructViewerComponent +
     * MapStructLottieAnimationSVG): all of the event's names play together —
     * an impact's SHAKE layer is what draws the struct, so playing only the
     * first name showed an explosion over an empty tile — and each layer loads
     * paused and hidden, gets this struct's art swapped in, waits for those
     * sprites to decode, and only then shows and plays. Autoplaying while the
     * art swapped underneath was why the bubble sometimes showed nothing. */
    function pipRender(s, cell, names, healthNow) {
      var el = pipEl();
      var mount = document.getElementById('rv-pip-struct');
      if (!el || !mount) return false;
      if (typeof names === 'string') names = [names];
      names = (names || []).filter(Boolean);

      var mask = el.querySelector('.rv-pip-mask');
      if (mask && cell) {
        mask.style.backgroundColor = cell.style.backgroundColor || '';
        mask.style.backgroundImage = cell.style.backgroundImage || '';
      }

      pipDestroyAnim();
      mount.innerHTML = '';

      var marker = cell && cell.querySelector('.rv-marker');
      if (marker && marker.style.display !== 'none') {
        var m2 = document.createElement('img');
        m2.src = marker.src; m2.alt = ''; m2.className = 'rv-marker';
        mount.appendChild(m2);
      }

      var still = el2('div', 'rv-struct' + (s.hidden ? ' rv-stealth' : ''));
      renderStill(still, s, healthNow);
      // The bubble obeys the same still-visibility rules as the tile: during an
      // attack/impact/destroy the bundle owns the sprite, and a visible still
      // would double it inside the bubble too.
      if (names.length && !stillFlags(names).during) still.classList.add('rv-invisible');
      mount.appendChild(still);

      if (!names.length || !window.lottie) return true;
      var gen = pip.gen, remaining = names.length;
      pip.active = true;
      var layerDone = function () {
        if (gen !== pip.gen) return;
        if (--remaining <= 0) pipAnimationsDone(still);
      };
      names.forEach(function (name) {
        var box = el2('div', 'rv-anim' + (flipsLayer(name) ? ' rv-flip-layer' : ''));
        box.style.visibility = 'hidden';
        box.style.zIndex = String(400 + layerZ(name));   // .rv-anim's 400 keeps every layer over the still
        mount.appendChild(box);
        var anim, done = false;
        var finishLayer = function () {
          if (done) return;
          done = true;
          box.classList.add('rv-invisible');
          layerDone();
        };
        try {
          anim = window.lottie.loadAnimation({
            container: box, renderer: 'svg', loop: false, autoplay: false,
            path: lottiePath(name, s.type_slug),
          });
        } catch (e) { finishLayer(); return; }
        pip.anims.push(anim);
        if (!anim || !anim.addEventListener) { finishLayer(); return; }
        anim.addEventListener('DOMLoaded', function () {
          // The game's PIP is a full MapStructViewerComponent, which swaps the
          // template's placeholder hull for the struct's own art. A raw bundle
          // showed a Destroyer for any water struct.
          if (injectStructArt) injectStructArt(box, s, healthNow);
          preloadImages(box).then(function () {
            if (gen !== pip.gen) return;          // replaced or cleared meanwhile
            box.style.visibility = 'visible';
            if (anim.play) anim.play();
          });
        });
        anim.addEventListener('complete', finishLayer);
        anim.addEventListener('data_failed', finishLayer);
        // Never let a bundle that stalls hold the bubble hostage.
        setTimeout(finishLayer, 15000);
      });
      return true;
    }
    function el2(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

    /* Show/refresh the bubble for the struct the queue is animating.
     * Same struct: refresh in place (counter-chains keep the bubble up).
     * Different struct: let the current animation finish, slide out, swap
     * contents and side off-screen, slide back in. */
    function pipShow(ev, names) {
      var s = state().structsById[ev.structId];
      if (!s) return;
      var cell = pipCellOf(ev.structId);
      if (!cell) return;
      var el = pipEl();
      if (!el) return;
      var side = s.side === 'attacker' ? 'right' : 'left';
      var healthNow = ev.healthAfter != null ? ev.healthAfter : currentHealth(s);

      var apply = function () {
        pip.structId = ev.structId;
        pip.side = side;
        el.classList.remove('rv-side-left', 'rv-side-right');
        el.classList.add(side === 'right' ? 'rv-side-right' : 'rv-side-left');
        if (pipRender(s, cell, names, healthNow)) {
          // Force a layout flush so the browser commits the off-screen anchor
          // before rv-vis lands — otherwise the slide-in transition is skipped.
          void el.offsetWidth;
          pipUpdateVisibility();
        } else {
          pipClear();
        }
      };

      pip.pendingHide = false;
      if (pip.structId && pip.structId !== ev.structId) {
        var swap = function () {
          if (!el.classList.contains('rv-vis')) { apply(); return; }
          el.classList.remove('rv-vis');
          if (pip.swapTimer) clearTimeout(pip.swapTimer);
          pip.swapTimer = setTimeout(function () { pip.swapTimer = null; apply(); }, 320);
        };
        if (pip.active) { pip.pendingShow = swap; return; }
        swap();
      } else {
        apply();
      }
    }

    function doHide() {
      var el = pipEl();
      if (el) el.classList.remove('rv-vis');
      // Forget the struct NOW, not after the 320ms slide-out: a scroll/resize
      // inside that window calls pipUpdateVisibility, which re-showed the
      // bubble — with the PREVIOUS fight's struct in it — because structId was
      // still set. The node keeps its contents until pipClear so the slide-out
      // has something to slide.
      pip.structId = null;
      if (pip.swapTimer) { clearTimeout(pip.swapTimer); pip.swapTimer = null; }
      pip.swapTimer = setTimeout(function () { pip.swapTimer = null; pipClear(); }, 320);
    }

    /* Hide — but, like the game's requestHide, not while the bubble's own
     * animation is still playing: it finishes first, then slides out. */
    function pipRequestHide() {
      pip.pendingShow = null;
      if (pip.active) { pip.pendingHide = true; return; }
      doHide();
    }

    /* Called from the queue as each animation starts, and from scroll/resize. */
    function pipOnAnimation(ev, name) {
      var names = ev.names && ev.names.length ? ev.names : (name ? [name] : []);
      if (!names.length || !isAttackSequence(names)) {
        if (pip.structId) pipRequestHide();
        return;
      }
      var cell = pipCellOf(ev.structId);
      if (pipOffscreen(cell)) {
        pipShow(ev, names);
      } else if (pip.structId && pip.structId !== ev.structId) {
        // The fight moved to a tile in view: the map itself is the viewer
        // now. The bubble finishes what it is showing, then retires — left
        // up, it waited for the whole queue to drain, which in a busy battle
        // is never.
        pipRequestHide();
      } else {
        // Tile visible: the map itself is the viewer.
        pipUpdateVisibility();
      }
    }

    function pipUpdateVisibility() {
      var el = pipEl();
      if (!el) return;
      if (!pip.structId) { el.classList.remove('rv-vis'); return; }
      var cell = pipCellOf(pip.structId);
      el.classList.toggle('rv-vis', pipOffscreen(cell));
    }

    return {
      PIP_SEQ: PIP_SEQ, isAttackSequence: isAttackSequence, pip: pip, pipEl: pipEl, pipCellOf: pipCellOf,
      pipOffscreen: pipOffscreen, pipClear: pipClear, pipRender: pipRender, pipShow: pipShow,
      pipRequestHide: pipRequestHide, pipOnAnimation: pipOnAnimation, pipUpdateVisibility: pipUpdateVisibility,
    };
  };
})();
