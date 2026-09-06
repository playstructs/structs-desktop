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

    var pip = { structId: null, side: null, anim: null, swapTimer: null };

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
      if (pip.anim) { try { pip.anim.destroy(); } catch (e) {} pip.anim = null; }
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
    }

    /* Fill the bubble for one struct: the tile's own terrain as the mask
     * background, the marker if the cell shows one, the still at the health the
     * sequence has reached, and the animation the map is playing right now. */
    function pipRender(s, cell, name, healthNow) {
      var el = pipEl();
      var mount = document.getElementById('rv-pip-struct');
      if (!el || !mount) return false;

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
      if (name && !stillFlags([name]).during) still.classList.add('rv-invisible');
      mount.appendChild(still);

      if (name && window.lottie) {
        var animBox = el2('div', 'rv-anim' + (flipsLayer(name) ? ' rv-flip-layer' : ''));
        mount.appendChild(animBox);
        try {
          pip.anim = window.lottie.loadAnimation({
            container: animBox, renderer: 'svg', loop: false, autoplay: true,
            path: lottiePath(name, s.type_slug),
          });
        } catch (e) { /* the still alone is still informative */ }
      }
      return true;
    }
    function el2(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

    /* Show/refresh the bubble for the struct the queue is animating.
     * Same struct: refresh in place (counter-chains keep the bubble up).
     * Different struct: slide out, swap contents and side off-screen, slide
     * back in — the side-class jump is invisible while parked off-screen. */
    function pipShow(ev, name) {
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
        if (pipRender(s, cell, name, healthNow)) {
          // Force a layout flush so the browser commits the off-screen anchor
          // before rv-vis lands — otherwise the slide-in transition is skipped.
          void el.offsetWidth;
          pipUpdateVisibility();
        } else {
          pipClear();
        }
      };

      if (pip.structId && pip.structId !== ev.structId && el.classList.contains('rv-vis')) {
        el.classList.remove('rv-vis');
        if (pip.swapTimer) clearTimeout(pip.swapTimer);
        pip.swapTimer = setTimeout(function () { pip.swapTimer = null; apply(); }, 320);
      } else {
        apply();
      }
    }

    function pipRequestHide() {
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

    /* Called from the queue as each animation starts, and from scroll/resize. */
    function pipOnAnimation(ev, name) {
      if (!ev.names || !ev.names.length || !isAttackSequence(ev.names)) {
        if (pip.structId) pipRequestHide();
        return;
      }
      var cell = pipCellOf(ev.structId);
      if (pipOffscreen(cell)) {
        pipShow(ev, name);
      } else if (pip.structId === ev.structId || !pip.structId) {
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
