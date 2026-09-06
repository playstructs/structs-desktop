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

console.log('raid-pip: all checks passed');
