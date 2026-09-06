// The Structs Terminal (board-terminal.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/terminal.test.mjs
//
// Structural: what rendered from a saved layout, what a card holds, what the
// doors invoke, and that a pop-out window shows one card and nothing else.
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
function load(query) {
  return JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + query, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The page: a saved layout, every card drawn by its type ────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 5);
  check('solo attribute set', d.documentElement.getAttribute('data-solo') === 'terminal');
  const cards = [...d.querySelectorAll('#tm-grid .tm-card')];
  check('the saved layout is drawn, in its order', cards.map((c) => c.getAttribute('data-card')).join(',') === 'people-1,market-1,work-1,player-1,stats-1', cards.map((c) => c.getAttribute('data-card')).join(','));
  check('widths come from the layout', cards[1].classList.contains('tm-w2') && cards[0].classList.contains('tm-w1'));
  check('the toolbar offers every registered type', d.querySelectorAll('.tm-toolbar select option').length >= 8);

  await until(() => d.querySelector('#tm-people-1 .pc-person'));
  check('liveness card: the Game Stats people card, inside the Terminal', d.querySelectorAll('#tm-people-1 .pc-person').length === 12);
  await until(() => d.querySelectorAll('#tm-market-1 .sui-planet-card').length === 2);
  const offers = [...d.querySelectorAll('#tm-market-1 .sui-planet-card')];
  check('market card: one provider card per offer, from terminal_market', offers.length === 2);
  check('…an open offer can be rented, a guild-market one cannot', d.querySelectorAll('#tm-market-1 .tm-offer')[0].querySelector('[title="Rent capacity"]') !== null && d.querySelectorAll('#tm-market-1 .tm-offer')[1].querySelector('[title="Rent capacity"]') === null);
  check('page card: the Work page moved in whole', d.querySelector('#tm-work-1 #page-work') !== null && !d.getElementById('page-work').hidden);
  await until(() => d.querySelector('#tm-player-1 .pc-card'));
  check('player card: the shared card for the named player', /JPEG/.test(d.querySelector('#tm-player-1 .pc-card')?.textContent || ''));
  await until(() => d.querySelector('#tm-stats-1 .fstat'));
  check('stats card: one Game Stats section', /RAID PRESSURE/i.test(d.querySelector('#tm-stats-1')?.textContent || ''));

  // Doors.
  const set = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_layout_set');
  d.querySelector('#tm-people-1 [title="Move down"]').click();
  check('move down reorders', d.querySelectorAll('#tm-grid .tm-card')[1].getAttribute('data-card') === 'people-1');
  d.querySelector('#tm-stats-1 [title="Remove"]').click();
  check('remove takes the card off the page', d.getElementById('tm-stats-1') === null && w.Board.Terminal.state.layout.cards.length === 4);
  d.querySelector('#tm-market-1 [title="Pop out"]').click();
  await tick(20);
  check('pop out asks Rust for a window on that card', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card' && c.args && c.args.cardId === 'market-1'));

  // Configure: change the player, widen the card.
  d.querySelector('#tm-player-1 [title="Configure"]').click();
  const cfg = d.querySelector('#tm-player-1 .tm-config');
  check('configure opens the params strip', cfg && !cfg.hidden && cfg.querySelector('input'));
  cfg.querySelector('input').value = '1-248';
  cfg.querySelectorAll('select')[cfg.querySelectorAll('select').length - 1].value = '2';
  cfg.querySelector('a.sui-mod-primary').click();
  await until(() => /PHONIFFER/.test(d.querySelector('#tm-player-1')?.textContent || ''));
  check('…and the card re-renders on the new player', /PHONIFFER/.test(d.querySelector('#tm-player-1').textContent) && d.getElementById('tm-player-1').classList.contains('tm-w2'));
  check('the title follows the params', d.querySelector('#tm-player-1 .tm-title').textContent === 'Player 1-248');

  // Add from the toolbar.
  const pick = d.querySelector('.tm-toolbar select');
  pick.value = 'guild'; pick.dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick(10);
  const idBox = d.querySelector('.tm-toolbar input');
  check('a type that needs an id asks for it', idBox !== null);
  d.getElementById('tm-add').click();
  check('…and refuses to add without one', d.querySelectorAll('#tm-grid .tm-card').length === 4);
  idBox.value = '0-1';
  d.getElementById('tm-add').click();
  check('adding places the card last with a fresh id', d.querySelectorAll('#tm-grid .tm-card').length === 5 && d.querySelectorAll('#tm-grid .tm-card')[4].getAttribute('data-card') === 'guild-1');
  await tick(400);
  const saved = set();
  check('every change is saved through Rust, debounced', saved.length >= 1 && saved[saved.length - 1].args.layout.cards.some((c) => c.id === 'guild-1'));
  check('the saved layout carries a bumped version', saved[saved.length - 1].args.layout.version > 3);
}

// ── A pop-out: one card, no toolbar, full width ────────────────────────────
{
  const dom = await load('?view=terminal&card=market-1');
  const w = dom.window, d = w.document;
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 1);
  check('a pop-out shows exactly its card', d.querySelectorAll('#tm-grid .tm-card').length === 1 && d.querySelector('#tm-grid .tm-card').getAttribute('data-card') === 'market-1');
  check('…full width, with no toolbar and no layout doors', d.querySelector('.tm-toolbar') === null && d.querySelector('#tm-market-1').classList.contains('tm-w3') && d.querySelector('#tm-market-1 [title="Remove"]') === null);
  check('…but it can still refresh', d.querySelector('#tm-market-1 [title="Refresh"]') !== null);
}

// ── No layout yet: the default page ────────────────────────────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal);
  w.__HARNESS_REJECT__.terminal_layout_get = 'no file';
  try { w.localStorage.removeItem('structs.terminal.layout'); } catch (e) { /* file: origin has none */ }
  await w.Board.Terminal.enter();
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 6);
  check('with nothing saved, the default page has six cards', d.querySelectorAll('#tm-grid .tm-card').length === 6);
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
