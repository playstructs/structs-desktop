// The Energy card (board-terminal-ops.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/energy.test.mjs
//
// The brief this pins: one number, one bar, one button that follows the
// state — and no battery (that glyph is the charge bar). More power is two
// ways (my alpha / rent the cheapest offer) and a confirm before signing.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const text = (n) => (n && n.textContent || '').replace(/\s+/g, ' ').trim();

const dom = await JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + '?view=terminal', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
const w = dom.window, d = w.document;
await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add && w.Board.Terminal.energy);
const T = w.Board.Terminal;

// ── ⌘K ──
check('ENERGY, POWER and HEADROOM open the card', ['ENERGY', 'POWER', 'HEADROOM'].every((x) => T.parse(x).type === 'energy'));
check('GRID still opens the guild grid', T.parse('GRID').type === 'grid');
const row = T.suggestFor('').find((o) => /\bENERGY\b/.test(String(o.words || '')));
check('filed under Industry', row && row.group === 'Industry', JSON.stringify(row || null));

// ── Pure pieces ──
const q = T.energy.rentQuote([
  { id: '10-1', rate_ualpha_per_mw_block: 0.000002, capacity_max: 50e6 },
  { id: '10-2', rate_ualpha_per_mw_block: 0.000001, capacity_max: 1e6 },   // too small for 1.5 kW
  { id: '10-3', rate_ualpha_per_mw_block: 0.0000015, capacity_max: 50e6, duration_max: 1000 },
], 1.5e6, 7, 5.3);
check('rent picks the cheapest offer that has the amount (duration clamped)', q && q.id === '10-3' && q.duration_blocks === 1000, JSON.stringify(q));
check('grams cover the reactor cut', T.energy.gramsFor(1.8e6, 0.04) === 1.88);

// ── The card ──
const card = T.add('energy', {}, 1);
const id = (card && card.id) || 'energy-1';
const host = await until(() => {
  const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
  return c && c.querySelector('.en-bar') ? c : null;
});
check('the card renders a supply bar', host !== null);
if (host) {
  check('no battery anywhere on it', !host.querySelector('.sui-screen-battery, .batt'));
  check('the number is headroom, amber when thin', /^0\.7\s*kW$/i.test(text(host.querySelector('.en-v'))) && host.querySelector('.en-v.is-warn'), text(host.querySelector('.en-v')));
  check('with no replicants, room is counted in structs', text(host.querySelector('.en-sub')) === 'room for 1 struct', text(host.querySelector('.en-sub')));
  check('the lit gap and the draw marker are on the bar', host.querySelector('.en-gap') && host.querySelector('.en-mark'));
  const buttons = [...host.querySelectorAll('.en-hero a.sui-screen-btn')];
  check('one button, More power, amber', buttons.length === 1 && /More power/.test(text(buttons[0])) && buttons[0].classList.contains('en-warn'), buttons.map(text).join('|'));
  check('the Keep me powered switch', /Keep me powered/.test(text(host.querySelector('.en-hero'))));

  buttons[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const more = await until(() => host.querySelector('.en-way') ? host : null);
  const ways = more ? [...host.querySelectorAll('.en-way')].map(text) : [];
  check('More power offers my alpha and a rent', ways.length === 2 && /Use my alpha/.test(ways[0]) && /Rent/.test(ways[1]), ways.join(' | '));
  check('…3 builds by default, costed with the cut', /1\.57g/.test(ways[0] || ''), ways[0]);
  const big = host.querySelector('.en-big');
  check('the amount is the mockup\'s: − [+3 structs] + with the kW under it',
    big && text(big.querySelector('.en-big-v')) === '+3 structs' && /1\.5\s*kW/i.test(text(big.querySelector('.en-big-s'))) && big.querySelectorAll('a.sui-screen-btn').length === 2,
    big && text(big));
  check('…no number field to type in', !host.querySelector('.en input[type=number]'));
  check('…and Power up is the full-width button, Back a quiet link under it',
    /Power up/.test(text(host.querySelector('.en-hero a.sui-screen-btn'))) && host.querySelector('.en-hero a.en-back'));
  check('…and the rent is sized for everyone on the substation it lands on', /7\.5\s*kW onto 4-9, 5 share it/i.test(ways[1] || ''), ways[1]);

  // ── Share spare: guild · my substation · crew · market ──
  const calls = w.__HARNESS_CALLS__ || [];
  const card2 = T.add('energy', {}, 1);
  const host2 = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + ((card2 && card2.id) || 'energy-2') + '"] .tm-body');
    return c && c.querySelector('.en-bar') ? c : null;
  });
  const sharingLine = host2 && [...host2.querySelectorAll('.en-line')].map(text).join(' | ');
  check('the main view lists the sharing into 4-9 with a Stop', /Sharing 2\s*kW with 4-9\s*Stop/i.test(sharingLine || ''), sharingLine);

  // A player with spare OWN power: the button becomes Share spare.
  const F = w.__HARNESS_FIXTURES__;
  F.terminal_energy = Object.assign({}, F.terminal_energy, {
    state: 'spare', own_mw: 30000000, headroom_mw: 22700000, draw_mw: 14200000, room: 45, spare_mw: 21200000,
  });
  const card3 = T.add('energy', {}, 1);
  const host3 = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + ((card3 && card3.id) || 'energy-3') + '"] .tm-body');
    return c && c.querySelector('.en-hero') ? c : null;
  });
  const hero = host3 && host3.querySelector('.en-hero a.sui-screen-btn');
  check('spare → Share spare', hero && /Share spare/.test(text(hero)), hero && text(hero));
  hero && hero.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const chips = await until(() => host3.querySelector('.en-chips') ? [...host3.querySelectorAll('.en-chips a')] : null);
  const labels = (chips || []).map(text);
  check('share to guild, my substation or the market', /Guild · 2,807/.test(labels.join('|')) && /My substation · 5/.test(labels.join('|')) && labels.includes('Market'), labels.join(' | '));
  const market = (chips || []).find((c) => text(c) === 'Market');
  market && market.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const sell = await until(() => [...host3.querySelectorAll('.en-hero a.sui-screen-btn')].find((a) => /^Sell [\d.]+\s*kW$/i.test(text(a))));
  check('Market turns the button into Sell, priced per kW·day', sell && /per kW·day/.test(text(host3)), sell && text(sell));
  const before = (w.__HARNESS_CALLS__ || []).length;
  sell && sell.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  // Inline, in the card: confirmModal does not show in a popped-out window.
  const ok = await until(() => host3.querySelector('.en-confirm') && [...host3.querySelectorAll('.en-actions a.sui-mod-primary')].pop());
  check('a confirm before selling, inline in the card', !!ok && d.querySelector('.ops-modal-overlay') === null);
  ok && ok.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const call = await until(() => (w.__HARNESS_CALLS__ || []).slice(before).find((c) => c.cmd === 'mcp_energy_sell'));
  check('…which signs mcp_energy_sell with the kW, an integer rate and the max days',
    call && call.args.powerMw === 2000000 && Number.isInteger(call.args.rate) && call.args.rate >= 1 && call.args.maxDays === 7, JSON.stringify(call && call.args));

  // ── Replicants: the card counts in replicants, sized at the heaviest ──
  F.terminal_energy = Object.assign({}, F.terminal_energy, {
    unit: 'replicant', unit_mw: 9000000, replicants: 182,
    destinations: F.terminal_energy.destinations.concat([{ key: 'crew', id: '4-3', connections: 640, supportable_more: 12 }]),
  });
  const card4 = T.add('energy', {}, 1);
  const host4 = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + ((card4 && card4.id) || 'energy-4') + '"] .tm-body');
    return c && c.querySelector('.en-sub') ? c : null;
  });
  check('with replicants, room is counted in replicants (22.7 kW ÷ 9 kW)', host4 && text(host4.querySelector('.en-sub')) === 'room for 2 replicants', host4 && text(host4.querySelector('.en-sub')));
  check('…and the crew line says how many more fit', host4 && /Crew on 4-3\s*182 replicants · 12 more fit/.test(text(host4)), host4 && text(host4).slice(0, 300));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall ok');
process.exit(failures ? 1 : 0);
