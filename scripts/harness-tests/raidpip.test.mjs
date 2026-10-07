// raidview-pip.js: the Animation Bubble, driven with a stub map.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/raidview-pip.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const dom = new JSDOM('<!doctype html><html><body><div id="rv-scroll"></div><div id="rv-pip"><div class="rv-pip-mask"></div><div id="rv-pip-struct"></div></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const rect = (el, r) => { el.getBoundingClientRect = () => Object.assign({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }, r); };
  rect(w.document.getElementById('rv-scroll'), { top: 0, left: 0, right: 800, bottom: 600 });
  const state = { structsById: {} };
  const cells = {};
  function addStruct(id, side, r) {
    state.structsById[id] = { id, side, type_slug: 'tank', max_health: 3, hidden: false };
    const cell = w.document.createElement('div'); cell.className = 'rv-cell'; rect(cell, r);
    const slot = w.document.createElement('div'); slot.id = 'slot-' + id; cell.appendChild(slot);
    w.document.body.appendChild(cell); cells[id] = cell;
  }
  const calls = [];
  const pp = w.RaidPip({
    state: () => state, domId: (kind, id) => kind + '-' + id, currentHealth: () => 2,
    renderStill: (node, s, hp) => { calls.push(['still', s.id, hp]); node.textContent = s.id; },
    stillFlags: (names) => ({ during: names.every((n) => /^EVADE/.test(n)), after: true }),
    flipsLayer: () => false, lottiePath: (n) => n,
  });
  return { w, pp, state, addStruct, cells, calls, el: () => w.document.getElementById('rv-pip') };
}

// 1. Only attack sequences qualify; status animations never do.
{
  const { pp } = boot();
  assert.ok(pp.isAttackSequence(['ATTACK_LASER']) && pp.isAttackSequence(['SHAKE_LAND']) && pp.isAttackSequence(['EVADE']) && pp.isAttackSequence(['DESTROY_WATER']));
  assert.ok(!pp.isAttackSequence(['ACTIVE_LOOP']) && !pp.isAttackSequence(['STATUS_ONLINE']) && !pp.isAttackSequence([]) && !pp.isAttackSequence(null));
}

// 2. Off the SCROLL viewport means fully outside it; a sliver in view is in view.
{
  const { pp, addStruct, cells } = boot();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  addStruct('5-2', 'attacker', { top: 550, bottom: 678, left: 0, right: 128 });
  assert.ok(pp.pipOffscreen(cells['5-1']) && !pp.pipOffscreen(cells['5-2']));
  assert.ok(!pp.pipOffscreen(null));
  assert.equal(pp.pipCellOf('5-1'), cells['5-1']); assert.equal(pp.pipCellOf('5-9'), null);
}

// 3. The bubble slides in from the defender's side or the attacker's, only while the tile is off-screen.
{
  const { pp, addStruct, el, calls } = boot();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  addStruct('5-2', 'attacker', { top: 100, bottom: 228, left: 0, right: 128 });
  pp.pipOnAnimation({ structId: '5-1', names: ['ATTACK_LASER'], healthAfter: 1 }, 'ATTACK_LASER');
  assert.ok(el().classList.contains('rv-vis') && el().classList.contains('rv-side-left'), 'defender: from the left');
  assert.equal(pp.pip.structId, '5-1');
  assert.ok(calls.some((c) => c[0] === 'still' && c[1] === '5-1' && c[2] === 1), 'the still at the health the sequence reached');
  assert.ok(el().querySelector('#rv-pip-struct .rv-struct').classList.contains('rv-invisible'), 'the bundle owns the sprite during an attack');
  pp.pipOnAnimation({ structId: '5-2', names: ['IMPACT_LAND'] }, 'IMPACT_LAND');
  assert.ok(!el().classList.contains('rv-vis') || pp.pip.structId === '5-1', 'a visible tile is its own viewer; the bubble does not switch to it');
  pp.pipOnAnimation({ structId: '5-1', names: ['STATUS_ONLINE'] }, 'STATUS_ONLINE');
  await tick(340);
  assert.equal(pp.pip.structId, null, 'a status animation retracts the bubble');
  assert.ok(!el().classList.contains('rv-vis'));
}

// 4. Hiding forgets the struct at once (a scroll inside the slide-out must not re-show the last fight) and clears after it.
{
  const { pp, addStruct, el } = boot();
  addStruct('5-1', 'attacker', { top: 700, bottom: 828, left: 0, right: 128 });
  pp.pipOnAnimation({ structId: '5-1', names: ['DESTROY_LAND'] }, 'DESTROY_LAND');
  assert.ok(el().classList.contains('rv-side-right'), 'attacker: from the right');
  pp.pipRequestHide();
  assert.equal(pp.pip.structId, null);
  pp.pipUpdateVisibility();
  assert.ok(!el().classList.contains('rv-vis'));
  assert.ok(el().querySelector('#rv-pip-struct').childNodes.length > 0, 'contents stay for the slide-out');
  await tick(340);
  assert.equal(el().querySelector('#rv-pip-struct').childNodes.length, 0, 'then cleared');
}

// 5. Scrolling the real tile into view retracts the bubble.
{
  const { pp, addStruct, el, cells, w } = boot();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  pp.pipOnAnimation({ structId: '5-1', names: ['ATTACK_LASER'] }, 'ATTACK_LASER');
  assert.ok(el().classList.contains('rv-vis'));
  cells['5-1'].getBoundingClientRect = () => ({ top: 300, bottom: 428, left: 0, right: 128 });
  pp.pipUpdateVisibility();
  assert.ok(!el().classList.contains('rv-vis'));
}

// 6. The bubble's copy of a template bundle gets the struct's own art, like the tile's.
{
  const { w, pp, addStruct } = boot();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  const handlers = {};
  w.lottie = { loadAnimation: () => ({ addEventListener(n, f) { handlers[n] = f; }, destroy() {} }) };
  const swaps = [];
  const pp2 = w.RaidPip({
    state: () => ({ structsById: { '5-1': { id: '5-1', side: 'defender', type_slug: 'tank', max_health: 3 } } }),
    domId: (kind, id) => kind + '-' + id, currentHealth: () => 2,
    renderStill: (node) => { node.textContent = 'still'; }, stillFlags: () => ({ during: false, after: true }),
    flipsLayer: () => false, lottiePath: (n) => n,
    injectStructArt: (box, s, hp) => swaps.push([box.className, s.id, hp]),
  });
  pp2.pipOnAnimation({ structId: '5-1', names: ['DESTROY_WATER'], healthAfter: 0 }, 'DESTROY_WATER');
  assert.ok(handlers.DOMLoaded, 'the bubble listens for the SVG being built');
  handlers.DOMLoaded();
  assert.deepEqual(swaps, [['rv-anim', '5-1', 0]], 'and swaps the placeholder hull for this struct at the health the sequence reached');
  // The module still works without the hook (older callers, the tests above).
  assert.ok(pp.pipOnAnimation !== undefined);
}

// 7. A played-out bundle hands the bubble back to the still: the bubble stays
//    up until the queue drains, and a finished bundle often ends blank.
{
  const { w, addStruct, el } = boot();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  const handlers = {};
  w.lottie = { loadAnimation: () => ({ addEventListener(n, f) { handlers[n] = f; }, destroy() {} }) };
  const pp3 = w.RaidPip({
    state: () => ({ structsById: { '5-1': { id: '5-1', side: 'defender', type_slug: 'tank', max_health: 3 } } }),
    domId: (kind, id) => kind + '-' + id, currentHealth: () => 2,
    renderStill: (node) => { node.textContent = 'still'; }, stillFlags: () => ({ during: false, after: true }),
    flipsLayer: () => false, lottiePath: (n) => n,
  });
  pp3.pipOnAnimation({ structId: '5-1', names: ['ATTACK_LASER'], healthAfter: 2 }, 'ATTACK_LASER');
  const still = el().querySelector('.rv-struct'), anim = el().querySelector('.rv-anim');
  assert.ok(still.classList.contains('rv-invisible') && !anim.classList.contains('rv-invisible'), 'while it plays, the bundle owns the sprite');
  assert.ok(handlers.complete, 'the bubble listens for its bundle finishing');
  handlers.complete();
  assert.ok(!still.classList.contains('rv-invisible') && anim.classList.contains('rv-invisible'), 'and then shows the still, not a blank last frame');
  assert.ok(el().classList.contains('rv-vis'), 'without retracting: the queue decides that');
}

// 8. The fight moving to a tile in view retires a bubble still showing an
//    off-screen struct: the queue may never drain in a busy battle.
{
  const { w, pp, addStruct, el } = boot();
  w.setTimeout = (f) => f();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  addStruct('5-2', 'attacker', { top: 100, bottom: 228, left: 300, right: 428 });
  pp.pipOnAnimation({ structId: '5-1', names: ['ATTACK_LASER'] }, 'ATTACK_LASER');
  assert.ok(el().classList.contains('rv-vis') && pp.pip.structId === '5-1');
  pp.pipOnAnimation({ structId: '5-2', names: ['IMPACT_LASER'] }, 'IMPACT_LASER');
  assert.ok(!el().classList.contains('rv-vis') && pp.pip.structId === null, 'the stale bubble retracts');
}

// 9. Like the game's viewer: every layer of the moment plays (an impact's
//    SHAKE is what draws the struct), each loads paused and hidden and plays
//    only once its art is in, and a hide waits for the animation to finish.
{
  const { w, addStruct, el } = boot();
  addStruct('5-1', 'defender', { top: 700, bottom: 828, left: 0, right: 128 });
  addStruct('5-2', 'attacker', { top: 100, bottom: 228, left: 300, right: 428 });
  const loads = [];
  w.lottie = { loadAnimation: (o) => { const h = {}; const a = { o, played: false, addEventListener(n, f) { h[n] = f; }, play() { a.played = true; }, destroy() {}, h }; loads.push(a); return a; } };
  w.setTimeout = (f, ms) => (ms && ms > 1000 ? 0 : f());
  const pp4 = w.RaidPip({
    state: () => ({ structsById: { '5-1': { id: '5-1', side: 'defender', type_slug: 'tank', max_health: 3 }, '5-2': { id: '5-2', side: 'attacker', type_slug: 'tank', max_health: 3 } } }),
    domId: (kind, id) => kind + '-' + id, currentHealth: () => 2,
    renderStill: (node) => { node.textContent = 'still'; }, stillFlags: () => ({ during: false, after: true }),
    flipsLayer: () => false, lottiePath: (n) => n, injectStructArt: () => {},
    layerZ: (n) => (n.startsWith('IMPACT_') ? 4 : n.startsWith('SHAKE_') ? 3 : 1),
  });
  pp4.pipOnAnimation({ structId: '5-1', names: ['IMPACT_LASER', 'SHAKE_LAND'], healthAfter: 1 }, 'IMPACT_LASER');
  assert.equal(loads.length, 2, 'both layers of the moment load');
  assert.ok(+loads[0].o.container.style.zIndex > +loads[1].o.container.style.zIndex, 'the explosion stacks over the shaking hull, as in the game');
  assert.ok(loads.every((a) => a.o.autoplay === false && a.o.container.style.visibility === 'hidden'), 'paused and hidden until the art is in');
  loads.forEach((a) => a.h.DOMLoaded());
  await tick(0);
  assert.ok(loads.every((a) => a.played && a.o.container.style.visibility === 'visible'), 'then shown and played');
  assert.ok(pp4.pip.active, 'the bubble is mid-animation');
  pp4.pipOnAnimation({ structId: '5-2', names: ['IMPACT_LASER'] }, 'IMPACT_LASER');
  assert.ok(el().classList.contains('rv-vis') && pp4.pip.pendingHide, 'a hide waits for the animation');
  loads.forEach((a) => a.h.complete());
  assert.ok(!el().classList.contains('rv-vis') && !pp4.pip.active, 'and lands once it has played out');
}

console.log('raid-pip: all checks passed');
