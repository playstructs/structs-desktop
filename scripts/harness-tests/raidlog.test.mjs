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
