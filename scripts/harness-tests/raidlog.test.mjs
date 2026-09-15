// raidview-log.js: the battle log, driven with a stub __TAURI__.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/raidview-log.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(state = { snapshot: { planet_id: '2-1' }, generation: 1 }, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="rv-log-filters"></div><div id="rv-log-count"></div><div id="rv-log-body"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  w.__TAURI__ = { core: { invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); } } };
  w.eval(src);
  const lg = w.RaidLog({ el, humanStatus: (s) => s.replace(/_/g, ' '), state: () => state });
  return { w, lg, calls, state };
}
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// 1. Kinds, labels and days.
{
  const { lg } = boot();
  assert.equal(lg.logKind({ category: 'struct_attack' }), 'combat', 'an older backend sends no kind');
  assert.equal(lg.logKind({ category: 'struct_health' }), 'state');
  assert.equal(lg.logKind({ kind: 'economy' }), 'economy');
  assert.equal(lg.logLabel('struct_block_ore_refine_start'), 'refine', 'one word, never the chain name');
  assert.equal(lg.logLabel('brand_new_thing'), 'brand new thing', 'a new category is still readable on day one');
  const today = new Date(); const y = new Date(today); y.setDate(y.getDate() - 1); const old = new Date(today); old.setDate(old.getDate() - 9);
  assert.equal(lg.dayLabel(iso(today)), 'TODAY'); assert.equal(lg.dayLabel(iso(y)), 'YESTERDAY');
  assert.match(lg.dayLabel(iso(old)), /^(SUN|MON|TUE|WED|THU|FRI|SAT) \d{1,2} [A-Z]{3}/);
  assert.equal(lg.dayLabel(''), '');
  assert.equal(lg.dayLabel(iso(today) + 'T16:58:19.751Z'), 'TODAY', 'a full timestamp still labels by its day');
}

// 2. Rendering: grouped by day, filtered to the story, the count says what the filter hides.
{
  const { lg, w } = boot();
  const today = iso(new Date());
  lg.logState.rows = [
    { date: today, time: '12:01', kind: 'combat', category: 'struct_attack', detail: 'hit 5-1' },
    { date: today, time: '12:00', kind: 'state', category: 'struct_health', detail: 'hp 2' },
    { date: '2026-01-01', time: '09:00', kind: 'defense', category: 'struct_defense_add', detail: 'web' },
    { date: '2026-01-01', time: '08:00', kind: 'state', category: 'struct_status', detail: 'flag' },
  ];
  lg.renderLog();
  const body = w.document.getElementById('rv-log-body');
  assert.equal(body.querySelectorAll('.rv-log-day').length, 2, 'two days, two headings');
  assert.equal(body.querySelectorAll('.rv-log-row').length, 2, 'state rows are off by default');
  assert.equal(w.document.getElementById('rv-log-count').textContent, '2/4', 'on screen over fetched');
  const chips = [...w.document.querySelectorAll('.rv-log-chip')];
  assert.equal(chips.map((c) => c.textContent).join(' '), 'Combat1 Defense1 State2', 'each chip says how much it hides');
  chips[2].click();
  assert.equal(body.querySelectorAll('.rv-log-row').length, 4);
  assert.equal(w.document.getElementById('rv-log-count').textContent, '4');
  /* In a card of its own the log's title is hidden, so a PLAIN total led the
   * bar as a stray digit the chips already add up to. The class marks the
   * filtered form — the only one that says rows are hidden — and card CSS
   * keeps that one alone. */
  assert.equal(w.document.getElementById('rv-log-count').classList.contains('rv-log-count-filtered'), false,
    'an unfiltered total is not marked');
  [...w.document.querySelectorAll('.rv-log-chip')][2].click();
  assert.equal(w.document.getElementById('rv-log-count').textContent, '2/4');
  assert.equal(w.document.getElementById('rv-log-count').classList.contains('rv-log-count-filtered'), true,
    'a filtered count is marked, and survives in the card');
  [...w.document.querySelectorAll('.rv-log-chip')][2].click();   // back to all-on for what follows
  chips.forEach(() => {}); [...w.document.querySelectorAll('.rv-log-chip')].forEach((c) => c.click());
  assert.ok(/rows hidden/.test(body.textContent), 'everything filtered says so');
  lg.logState.rows = []; lg.renderLog();
  assert.ok(/No recorded activity/.test(body.textContent));
}

// 3. The live stream prepends without duplicating the backfill, caps memory, and ignores a stale planet.
{
  const { lg, state } = boot();
  lg.logState.open = false;
  lg.logState.rows = [{ date: 'd', time: '1', category: 'c', detail: 'x' }];
  lg.applyLog({ generation: 1, rows: [{ date: 'd', time: '1', category: 'c', detail: 'x' }, { date: 'd', time: '2', category: 'c', detail: 'y' }] });
  assert.equal(lg.logState.rows.map((r) => r.detail).join(','), 'y,x', 'newest on top, the overlap dropped');
  lg.applyLog({ generation: 2, rows: [{ detail: 'stale' }] });
  assert.equal(lg.logState.rows.length, 2, 'another planet\'s rows are not ours');
  const many = []; for (let i = 0; i < 300; i++) many.push({ date: 'e', time: String(i), category: 'c', detail: 'r' + i });
  lg.applyLog({ generation: 1, rows: many });
  assert.equal(lg.logState.rows.length, lg.LOG_LIMIT);
}

// 4. Opened before the first snapshot: the load is owed, then paid.
{
  const { lg, calls, state } = boot({ snapshot: null, generation: 1 }, { mcp_raid_log: { rows: [{ date: 'd', time: '1', category: 'struct_attack', detail: 'x' }] } });
  lg.refreshLog();
  assert.equal(lg.logState.pending, true); assert.equal(calls.length, 0);
  state.snapshot = { planet_id: '2-7' };
  lg.refreshLog();
  await tick(5);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['mcp_raid_log', { planetId: '2-7', limit: lg.LOG_LIMIT }]));
  assert.equal(lg.logState.planetId, '2-7'); assert.equal(lg.logState.pending, false); assert.equal(lg.logState.rows.length, 1);
}
{
  const { lg, w } = boot({ snapshot: { planet_id: '2-7' }, generation: 1 }, { mcp_raid_log: new Error('boom') });
  lg.refreshLog(); await tick(5);
  assert.ok(/log unavailable: Error: boom/.test(w.document.getElementById('rv-log-body').textContent));
  assert.equal(lg.logState.loading, false);
}

console.log('raid-log: all checks passed');

// Rows name who did it: a chip from the log's identity map, or from the
// snapshot's own two players, or the bare id.
{
  const { lg, w } = boot({ snapshot: { planet_id: '2-1', owner: '1-2136', owner_name: 'Sheldon', owner_pfp: '{"head":1}', raider_id: '1-61', raider_name: null, raider_pfp: null }, generation: 1 },
    { mcp_raid_log: { rows: [
      { date: '2026-09-15', time: '20:28', category: 'struct_attack', kind: 'combat', detail: 'MA 5-1 → CMD 5-2', actor: '1-61', target: '1-2136' },
      { date: '2026-09-15', time: '20:27', category: 'struct_defense_add', kind: 'defense', detail: '5-3 now defends 5-2', actor: '1-2136' },
      { date: '2026-09-15', time: '20:26', category: 'shield_change', kind: 'defense', detail: 'shield 1 → 2' },
    ], players: { '1-61': { name: 'JPEG', pfp: '{"head":10}', tag: 'SN.C' } } } });
  lg.logState.open = true;
  lg.refreshLog();
  await new Promise((r) => setTimeout(r, 30));
  const d = w.document;
  const rows = [...d.querySelectorAll('.rv-log-row')];
  assert.equal(rows.length, 3);
  const actor = rows[0].querySelector('.rv-log-who .rv-log-actor');
  assert.ok(actor, 'an attack row shows its attacker');
  assert.equal(actor.getAttribute('data-player-id'), '1-61');
  assert.match(actor.textContent, /SN\.C/, 'with the guild tag from the log\'s identity map');
  assert.match(actor.textContent, /JPEG/);
  const target = rows[0].querySelector('.rv-log-d .rv-log-target');
  assert.ok(target && target.getAttribute('data-player-id') === '1-2136', 'and its victim after the line');
  assert.match(target.textContent, /Sheldon/, 'the victim is the planet owner, named from the snapshot');
  assert.match(rows[1].querySelector('.rv-log-who').textContent, /Sheldon/, 'a defence row names the owner');
  assert.equal(rows[2].querySelector('.rv-log-who').children.length, 0, 'a row about no one has an empty cell, not a wrong chip');
  // Compared as text: the object comes from the window's realm, whose
  // Object prototype is not Node's, and deepEqual tells them apart.
  assert.equal(JSON.stringify(lg.whoIs('1-999')), JSON.stringify({ id: '1-999', name: null, pfp: null, tag: null }));
  lg.rememberPlayers({ '1-999': { name: 'Late', pfp: null, tag: null } });
  assert.equal(lg.whoIs('1-999').name, 'Late', 'a live push can name a player later');
}
