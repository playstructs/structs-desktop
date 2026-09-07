// The Structs Terminal (board-terminal.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/terminal.test.mjs
//
// Structural: what rendered from a saved layout, what a card holds, what the
// doors invoke, and that a pop-out window shows one card and nothing else.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
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
  check('the saved layout is drawn, in its order — a saved whole-page card migrated into the cards that carry its data', cards.map((c) => c.getAttribute('data-card')).join(',') === 'people-1,market-1,pow-1,tasks-1,player-1,stats-1', cards.map((c) => c.getAttribute('data-card')).join(','));
  check('no card is titled after a window', [...d.querySelectorAll('#tm-grid .tm-title')].every((t) => !/Team Ops|Game Stats/.test(t.textContent)));
  check('widths come from the layout', cards[1].classList.contains('tm-w2') && cards[0].classList.contains('tm-w1'));
  check('the toolbar offers every registered type', d.querySelectorAll('.tm-toolbar select option').length >= 12);
  check('every card is the game\'s own panel: edges, chunk, a nav screen for the header with the title as the active tab and the doors beside it, a page-body screen for the body', cards.every((c) => c.classList.contains('sui-panel') && c.classList.contains('sui-theme-player') && c.querySelector(':scope > .sui-panel-edge-left') && c.querySelector(':scope > .sui-panel-edge-right') && c.querySelector(':scope > .sui-panel-chunk > .sui-screen > .sui-screen-nav .sui-screen-nav-item.sui-mod-active.tm-title') && c.querySelector('.sui-screen-nav .tm-doors') && c.querySelector(':scope > .sui-panel-chunk > .sui-screen > .sui-page-body-screen.tm-body')));
  const wsItems = [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].map((a) => a.textContent);
  check('the workspace strip lists every workspace and a door to a new one', wsItems.join(',') === 'main,war-room,+' && d.querySelector('#tm-ws-items .sui-mod-active').textContent === 'main', wsItems.join(','));

  await until(() => d.querySelector('#tm-people-1 .pc-person'));
  check('liveness card: the Game Stats people card, inside the Terminal', d.querySelectorAll('#tm-people-1 .pc-person').length === 12);
  await until(() => d.querySelectorAll('#tm-market-1 .sui-planet-card').length === 2);
  const offers = [...d.querySelectorAll('#tm-market-1 .sui-planet-card')];
  check('market card: one provider card per offer, from terminal_market', offers.length === 2);
  check('…an open offer can be rented, a guild-market one cannot', d.querySelectorAll('#tm-market-1 .tm-offer')[0].querySelector('[title="Rent capacity"]') !== null && d.querySelectorAll('#tm-market-1 .tm-offer')[1].querySelector('[title="Rent capacity"]') === null);
  await until(() => d.querySelector('#tm-pow-1 .fstat'));
  check('proof queue card: counts as tiles, the engine as rows', d.querySelectorAll('#tm-pow-1 .fstat').length === 3 && /GPU/.test(d.querySelector('#tm-pow-1').textContent) && /auto-tuned/.test(d.querySelector('#tm-pow-1').textContent));
  await until(() => d.querySelector('#tm-tasks-1 .pc-row'));
  check('tasks card: a row per UNFINISHED proof, the running one first with its progress bar and difficulty of 64', d.querySelectorAll('#tm-tasks-1 .pc-row').length === 2 && /5-12:mine/.test(d.querySelector('#tm-tasks-1 .pc-row').textContent) && d.querySelector('#tm-tasks-1 .pc-row .sui-action-bar-progress-bar') !== null && /12 \/ 64/.test(d.querySelector('#tm-tasks-1 .pc-row').textContent), d.querySelector('#tm-tasks-1 .pc-row') && d.querySelector('#tm-tasks-1 .pc-row').textContent);
  check('…finished proofs are set aside, and the caption says how many', /1 finished hidden/.test(d.querySelector('#tm-tasks-1 .tm-cap').textContent), d.querySelector('#tm-tasks-1 .tm-cap').textContent);
  check('…and an unfinished proof can be cancelled', d.querySelector('#tm-tasks-1 .pc-row .pc-act[title="Cancel this proof"]') !== null);
  check('…the running proof wears the struct it is for as its emblem', d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img') !== null && /img\/structs\/extractor\//.test(d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img').getAttribute('src') || ''), d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img') && d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img').getAttribute('src'));
  check('the Team Ops pages themselves are not offered as cards (only the settings forms)', ![...d.querySelectorAll('.tm-toolbar select option')].some((o) => /Team Ops/.test(o.textContent)) && !w.Board.Terminal.types().some((t) => t.type === 'page'));
  await until(() => d.querySelector('#tm-player-1 .pc-card'));
  check('player card: the shared card for the named player', /JPEG/.test(d.querySelector('#tm-player-1 .pc-card')?.textContent || ''));
  await until(() => d.querySelector('#tm-stats-1 .fstat'));
  check('stats card: one Game Stats section', /RAID PRESSURE/i.test(d.querySelector('#tm-stats-1')?.textContent || ''));

  // Doors.
  const set = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_layout_set');
  // No move doors: the header drags (tested below); the keyboard API remains.
  check('a card has no refresh or move doors', d.querySelectorAll('#tm-grid [title="Refresh"], #tm-grid [title="Move up"], #tm-grid [title="Move down"]').length === 0);
  w.Board.Terminal.move('people-1', 1);
  check('move down reorders', d.querySelectorAll('#tm-grid .tm-card')[1].getAttribute('data-card') === 'people-1');
  d.querySelector('#tm-stats-1 [title="Remove"]').click();
  check('remove takes the card off the page', d.getElementById('tm-stats-1') === null && w.Board.Terminal.state.layout.cards.length === 5);
  d.querySelector('#tm-market-1 [title="Pop out"]').click();
  await tick(20);
  check('pop out asks Rust for a window on that card, in this workspace, named as the card is', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card' && c.args && c.args.cardId === 'market-1' && c.args.workspace === 'main' && c.args.title === 'Energy market'));

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

  // Every card configures — its name, its refresh cadence and its width —
  // not only the ones with params. A player's name for a card outlives the
  // type's own title; a paused card refreshes by hand only.
  check('a card with no params still has a Configure door', d.querySelector('#tm-pow-1 [title="Configure"]') !== null);
  d.querySelector('#tm-pow-1 [title="Configure"]').click();
  const cfg2 = d.querySelector('#tm-pow-1 .tm-config');
  check('…opening name, refresh and width', cfg2.querySelector('.tm-config-name') !== null && cfg2.querySelector('.tm-config-cadence') !== null && cfg2.querySelectorAll('select').length === 2);
  cfg2.querySelector('.tm-config-name').value = 'GPU corner';
  cfg2.querySelector('.tm-config-cadence').value = '0';
  cfg2.querySelector('a.sui-mod-primary').click();
  await tick();
  check('the player\'s name is the title', d.querySelector('#tm-pow-1 .tm-title').textContent === 'GPU corner');
  check('Apply closes the strip, and the stylesheet honours that (display:flex used to beat [hidden])', cfg2.hidden === true && /\.tm-config\[hidden\]\s*\{\s*display:\s*none/.test(read('frontend/board.html')));
  // The harness answers terminal_layout_get with its fixture, so persistence
  // is checked on what the page SENDS: the card carries both fields.
  await w.Board.Terminal.flushSave();
  const savedPow = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_layout_set').pop().args.layout.cards.find((c) => c.id === 'pow-1');
  check('…and both are saved on the card', savedPow && savedPow.title === 'GPU corner' && savedPow.cadence === 0, JSON.stringify(savedPow));
  check('paused: the frame says so and the tick will not refresh it', d.getElementById('tm-pow-1').classList.contains('tm-paused') && w.Board.Terminal.cadenceOf('pow-1') === 0 && d.querySelector('#tm-pow-1 .tm-title').title === 'Paused');
  check('…both persisted on the card in the layout', (() => { const c = w.Board.Terminal.state.layout.cards.find((x) => x.id === 'pow-1'); return c.title === 'GPU corner' && c.cadence === 0; })());
  check('auto restores the type\'s own cadence and title', (w.Board.Terminal.setCadence('pow-1', ''), w.Board.Terminal.setTitle('pow-1', ''), w.Board.Terminal.cadenceOf('pow-1') > 0 && d.querySelector('#tm-pow-1 .tm-title').textContent === 'Proof queue' && !d.getElementById('tm-pow-1').classList.contains('tm-paused')));

  // Add from the toolbar.
  const pick = d.querySelector('.tm-toolbar select');
  pick.value = 'guild'; pick.dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick(10);
  const idBox = d.querySelector('.tm-toolbar-param input');
  check('a type that needs an id asks for it', idBox !== null);
  d.getElementById('tm-add').click();
  check('…and refuses to add without one', d.querySelectorAll('#tm-grid .tm-card').length === 5);
  idBox.value = '0-1';
  d.getElementById('tm-add').click();
  check('adding places the card last with a fresh id', d.querySelectorAll('#tm-grid .tm-card').length === 6 && d.querySelectorAll('#tm-grid .tm-card')[5].getAttribute('data-card') === 'guild-1');
  await tick(400);
  const saved = set();
  check('every change is saved through Rust, debounced', saved.length >= 1 && saved[saved.length - 1].args.layout.cards.some((c) => c.id === 'guild-1'));
  check('the saved layout carries a bumped version', saved[saved.length - 1].args.layout.version > 3 && saved[saved.length - 1].args.workspace === 'main');

  // The command line.
  const cmd = d.getElementById('tm-cmd');
  const run = (line) => { cmd.value = line; cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
  run('MKT');
  check('MKT opens a market card', d.querySelectorAll('#tm-grid [data-type="market"]').length === 2 && cmd.value === '');
  // HELP: every word, as a card. A row with no argument opens its card; one
  // that needs an argument lands in the command box.
  run('HELP');
  await until(() => d.querySelector('#tm-grid [data-type="help"] .tm-help-row'));
  const help = d.querySelector('#tm-grid [data-type="help"]');
  const helpWords = [...help.querySelectorAll('.tm-help-row b')].map((b) => b.textContent);
  check('HELP opens the command reference, one row per target, every word present', help !== null && Object.keys(w.Board.Terminal.WORDS).every((word) => helpWords.some((t) => t.split(' · ').includes(word))), helpWords.join(' | '));
  check('…naming what each opens and the argument it takes', [...help.querySelectorAll('.tm-help-row')].some((r) => /GT/.test(r.textContent) && /<id>/.test(r.textContent) && /Guild token/i.test(r.textContent)), [...help.querySelectorAll('.tm-help-row')].map((r) => r.textContent).join(' | ').slice(0, 300));
  const cardsBeforeHelp = d.querySelectorAll('#tm-grid .tm-card').length;
  [...help.querySelectorAll('.tm-help-row')].find((r) => /^PEOPLE/.test(r.textContent)).click();
  check('a word with no argument opens its card on click', d.querySelectorAll('#tm-grid [data-type="people"]').length === 2 && d.querySelectorAll('#tm-grid .tm-card').length === cardsBeforeHelp + 1);
  [...help.querySelectorAll('.tm-help-row')].find((r) => /^GT/.test(r.textContent)).click();
  check('a word that needs an id lands in the command box, ready for it', cmd.value === 'GT ' && d.activeElement === cmd, cmd.value);
  cmd.value = '';
  run('?');
  check('? is HELP, and there is only ever one', d.querySelectorAll('#tm-grid [data-type="help"]').length === 1);
  run('NONSENSE');
  check('an unknown word is refused visibly and left to correct', cmd.classList.contains('is-err') && cmd.value === 'NONSENSE');
  cmd.value = '';
  w.Board.Terminal.remove(help.getAttribute('data-card'));
  w.Board.Terminal.remove(d.querySelectorAll('#tm-grid [data-type="people"]')[1].getAttribute('data-card'));
  run('1-248');
  check('a bare player id opens that player', d.querySelector('#tm-grid [data-card="player-2"]')?.getAttribute('data-type') === 'player' && w.Board.Terminal.state.layout.cards.find((c) => c.id === 'player-2').params.id === '1-248');
  run('GUILD 0-2');
  check('GUILD opens a guild', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'guild' && c.params.id === '0-2'));
  run('2-15361');
  check('a planet id opens the planet view', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'planet')?.params.id === '2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="planet"] iframe.tm-frame-map'));
  {
    // The planet card is the live map: no hand-drawn slot grid any more.
    const pc = d.querySelector('#tm-grid [data-type="planet"]');
    check('…as the live map, not a hand-drawn slot grid', pc.querySelector('iframe.tm-frame-map') !== null && pc.querySelectorAll('.tm-planet-row, .tm-planet-slot').length === 0);
    check('…and the map is asked for THIS planet', /planet=2-15361/.test(pc.querySelector('iframe.tm-frame-map').getAttribute('src')));
  }
  run('9-61');
  check('a fleet id opens the map', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'map' && c.params.id === '9-61'));
  run('5-4559');
  check('any other id opens the inspector, which asks Comms\' reference cards', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'inspector')?.params.id === '5-4559');
  await tick(80);
  check('…through matrix_refs', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_refs' && (c.args.ids || []).includes('5-4559')));
  run('STATS ORE');
  check('STATS opens a section', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'stats' && c.params.section === 'ore') !== undefined);
  run('HALT');
  await until(() => d.querySelector('#tm-grid [data-type="halt"] .pc-row'));
  const haltRows = [...d.querySelectorAll('#tm-grid [data-type="halt"] .pc-row')];
  check('HALT lists the roster by margin, worst first', haltRows.length === 2 && /Marklifer/.test(haltRows[0].textContent) && /thin margin/.test(haltRows[0].textContent) && /1 under 20% margin/.test(d.querySelector('#tm-grid [data-type="halt"]').textContent));
  run('ORE');
  await until(() => d.querySelector('#tm-grid [data-type="ore"] .pc-row'));
  // The ore radar, not the leaderboard: rows are PLANETS, so each one names
  // where the ore actually sits — which is what a raider needs.
  {
    const ore = d.querySelector('#tm-grid [data-type="ore"]');
    const first = ore.querySelector('.pc-row');
    check('ORE lists the planets holding ore, richest first, from the radar', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_ore_radar') && first.getAttribute('data-kind') === 'planet' && /#1/.test(first.textContent), first.textContent.slice(0, 80));
    check('…saying how many planets hold ore across the galaxy', /holding ore/.test(ore.textContent) && /in the galaxy/.test(ore.textContent), ore.querySelector('.tm-cap').textContent);
    check('…and each row opens the planet, its owner, or the target board', first.querySelector('.pc-act[title^="Watch"]') !== null && first.querySelector('.pc-act[title="Target board"]') !== null);
  }
  run('BOOK 1-194');
  await until(() => d.querySelector('#tm-grid [data-type="book"] .pc-row'));
  const book = d.querySelector('#tm-grid [data-type="book"]');
  check('BOOK shows what was bought and sold and when the first runs out', /1-170/.test(book.textContent) && /1-482/.test(book.textContent) && /BOUGHT/.test(book.textContent) && /SOLD/.test(book.textContent) && /First expiry/i.test(book.textContent) && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_agreements' && c.args.player === '1-194'), book.textContent.slice(0, 200));
  check('…each agreement is a catalogue row with a countdown over its term', book.querySelectorAll('.pc-row[data-kind="agreement"] .sc-count').length === book.querySelectorAll('.pc-row').length && book.querySelectorAll('.pc-row').length > 0);
  run('ALERTS market.best_rate < 2; halt.min_margin > 50; nonsense');
  await until(() => d.querySelectorAll('#tm-grid [data-type="alerts"] .tm-alert').length === 3);
  const alerts = [...d.querySelectorAll('#tm-grid [data-type="alerts"] .tm-alert')].map((r) => r.className.replace(/.*tm-alert-/, ''));
  check('ALERTS judges each rule against a live reading: fired, quiet, and a bad rule named as such', alerts.join(',') === 'fired,quiet,bad', alerts.join(','));
  check('a rule parses to metric, op and value', JSON.stringify(w.Board.Terminal.parseRules('raids.live >= 1')[0]) === JSON.stringify({ metric: 'raids.live', op: '>=', value: 1, text: 'raids.live >= 1' }));
  run('BANKS');
  await until(() => d.querySelector('#tm-grid [data-type="banks"] .pc-row, #tm-grid [data-type="banks"] .gc-row'));
  const banks = d.querySelector('#tm-grid [data-type="banks"]');
  check('BANKS screens every guild token by ratio, richest first', /2 guild tokens/.test(banks.textContent) && /4700\.000/.test(banks.textContent) && banks.textContent.indexOf('SN Corp') < banks.textContent.indexOf('Orbital Hydro'));
  run('GT 0-1');
  const gtId = w.Board.Terminal.state.layout.cards.find((c) => c.type === 'gt' && c.params.id === '0-1').id;
  await until(() => d.querySelectorAll('#tm-' + gtId + ' svg').length === 2);
  const gt = d.getElementById('tm-' + gtId);
  check('GT draws the ratio as this app sampled it, and the ledger\'s supply', gt.querySelectorAll('svg').length === 2 && /30 samples/.test(gt.textContent) && /supply — 30 days/.test(gt.textContent));
  run('MINT');
  await until(() => d.querySelector('#tm-grid [data-type="bank"] input'));
  const bank = d.querySelector('#tm-grid [data-type="bank"]');
  const inputs = bank.querySelectorAll('input');
  inputs[0].value = '1000000'; inputs[1].value = '1000';
  bank.querySelector('a.sui-mod-primary').click();
  await tick(50);
  const confirmBtn = [...d.querySelectorAll('.ops-modal-overlay a, .ops-modal-overlay button')].find((b) => /^sign$/i.test(b.textContent.trim()));
  check('the ticket confirms before it signs, repeating the figures', !!confirmBtn && /Mint 1,000 tokens for 1,000,000 ualpha/.test(d.querySelector('.ops-modal-overlay').textContent));
  if (confirmBtn) confirmBtn.click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_guild_bank_mint'));
  const mintCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_guild_bank_mint');
  check('MINT signs through the app\'s own ledger with the figures typed', !!mintCall && mintCall.args.amountAlpha === 1000000 && mintCall.args.amountToken === 1000);
  run('TS 1-61');
  await until(() => d.querySelector('#tm-grid [data-type="sheet"] .pc-card'));
  const sheet = d.querySelector('#tm-grid [data-type="sheet"]');
  check('TS is the tearsheet: the card with ranks, standing, and the guild API\'s sections as they arrive', /JPEG/.test(sheet.textContent) && /#1/.test(sheet.textContent) && /Raids launched/.test(sheet.textContent) && /launched/.test(sheet.textContent) && /unavailable: Login required/.test(sheet.textContent));
  // Moving by hand: a drop lands before or after the target; a grid drop goes last.
  const order = () => [...d.querySelectorAll('#tm-grid .tm-card')].map((c) => c.getAttribute('data-card')).join(',');
  const first = d.querySelector('#tm-grid .tm-card').getAttribute('data-card');
  const last = [...d.querySelectorAll('#tm-grid .tm-card')].pop().getAttribute('data-card');
  w.Board.Terminal.dropOn(first, last, true);
  check('dragging a card onto another lands it after that card', order().split(',').pop() === first, order());
  w.Board.Terminal.dropOn(first, null, true);
  check('…and a drop on the grid keeps it last', order().split(',').pop() === first);
  // The drag itself, driven by pointer events: press on a header, move past
  // the 4px arm, release over the right half of another card.
  {
    const ids = order().split(',');
    const src = d.querySelector('#tm-' + ids[1]), dst = d.querySelector('#tm-' + ids[3]);
    d.elementFromPoint = (x) => (x >= 500 ? dst.querySelector('.tm-body') : null);
    dst.getBoundingClientRect = () => ({ left: 400, width: 300, top: 0, height: 100, right: 700, bottom: 100 });
    const ev = (type, x, y, el) => (el || w).dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    ev('pointerdown', 10, 10, src.querySelector('.tm-head'));
    ev('pointermove', 12, 10);
    check('a press that barely moves is not a drag', !w.Board.Terminal.state.drag);
    ev('pointermove', 650, 50);
    check('past the arm the card is dragging and the card under the pointer shows the drop side', w.Board.Terminal.state.drag === ids[1] && dst.classList.contains('tm-drop-after'));
    ev('pointerup', 650, 50);
    check('release lands it after that card, and saves', order().split(',').indexOf(ids[1]) === order().split(',').indexOf(ids[3]) + 1 && !w.Board.Terminal.state.drag && !d.querySelector('.tm-drop-after, .tm-dragging'));
    delete d.elementFromPoint;
  }
  check('every card carries a resize grip', d.querySelectorAll('#tm-grid .tm-card .tm-resize').length === d.querySelectorAll('#tm-grid .tm-card').length);
  w.Board.Terminal.resizeTo(first, 3, false);
  check('a resize commits the width to the layout', d.querySelector('#tm-' + first).classList.contains('tm-w3') && w.Board.Terminal.state.layout.cards.find((c) => c.id === first).w === 3);
  w.Board.Terminal.resizeTo(first, 9, false);
  check('…clamped to the grid', w.Board.Terminal.state.layout.cards.find((c) => c.id === first).w === 3);

  // Page views and the battle log.
  // The ops cards: every one renders from the page's own command, no whole page.
  for (const [word, type, expect] of [
    ['QUEUE', 'queue', /StructBuildInitiate/], ['RESULTS', 'results', /insufficient charge/], ['SOLVE', 'solve', /GPU/],
    ['GRID', 'grid', /connections/i], ['FUEL', 'fuel', /Auto infuse/], ['ALLOC', 'allocations', /6-53/], ['FLEET', 'fleet', /MARKLIFER/],
    ['RAIDS', 'raids', /shields vulnerable/], ['POSTURE', 'posture', /Auto response/], ['TARGETS', 'targets', /NO-GO/],
    ['GRUDGES', 'grudges', /beezhan/], ['VETOES', 'vetoes', /Protected player/], ['INCIDENTS', 'incidents', /2-287/],
    ['WALLET', 'wallet', /\[OH\]\s*Hydro/], ['HEALTH', 'health', /./],
  ]) {
    run(word);
    const sel = '#tm-grid [data-type="' + type + '"]';
    await until(() => d.querySelector(sel) && !/…$/.test(d.querySelector(sel + ' .tm-body').textContent.trim()) && d.querySelector(sel + ' .tm-body').textContent.trim() !== '');
    const body = d.querySelector(sel + ' .tm-body');
    check(word + ' renders the ' + type + ' card from its own data', !!body && expect.test(body.textContent) && !/unavailable/.test(body.textContent), body && body.textContent.slice(0, 120));
  }
  // Actionable: a queued signing can be cancelled from its row…
  check('queue rows are catalogue rows: rank first, cancel as a destructive door, in flight without doors', d.querySelectorAll('#tm-grid [data-type="queue"] .pc-row').length > 0 && d.querySelector('#tm-grid [data-type="queue"] .pc-act[title="Cancel"]').classList.contains('sc-destructive'));
  [...d.querySelectorAll('#tm-grid [data-type="queue"] .pc-act')].find((a) => a.title === 'Cancel').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_tx_mutate' && c.args.op === 'cancel'));
  check('…the queue card cancels through the same command as the page', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_tx_mutate' && c.args.op === 'cancel' && c.args.id === 't2'));
  // …a combat loop toggles from the posture card…
  const raidSwitch = d.querySelector('#tm-grid [data-type="posture"] [data-loop="raid"] input');
  check('the posture card draws each loop as a loop card with the game\'s own switch', raidSwitch !== null && d.querySelectorAll('#tm-grid [data-type="posture"] .pc-card').length === 2 && raidSwitch.checked === false);
  raidSwitch.checked = true; raidSwitch.dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'loop'));
  const loopCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'loop');
  check('…the posture card switches a loop by sending its whole config back', loopCall.args.payload.loop === 'raid' && loopCall.args.payload.config.enabled === true && loopCall.args.payload.config.posture === 'opportunist');
  // …and a target can be grudged from the board.
  // The board scores a target and can now launch it — the same verb the
  // agent uses, behind a confirm because it seizes ore and starts a fight.
  {
    const go = d.querySelector('#tm-grid [data-type="targets"] .pc-row.sc-bad');
    const raidDoor = go.querySelector('.pc-act[title^="Raid "]');
    check('a GO target offers the raid itself, as a destructive door', raidDoor !== null && raidDoor.classList.contains('sc-destructive'));
    check('…and a NO-GO target does not', [...d.querySelectorAll('#tm-grid [data-type="targets"] .pc-row')].filter((r) => !r.classList.contains('sc-bad')).every((r) => !r.querySelector('.pc-act[title^="Raid "]')));
    raidDoor.click();
    await until(() => d.querySelector('.ops-modal-overlay'));
    check('…asking first, naming the ore at stake', /seizes their ore/i.test(d.querySelector('.ops-modal-overlay').textContent));
    [...d.querySelectorAll('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a')][1].click();
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_action'));
    const act = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_action');
    check('…then raids through the game\'s own action path', act.args.action === 'raid' && act.args.args.target_id === '2-15361', JSON.stringify(act.args));
  }
  {
    const ore = [...d.querySelectorAll('#tm-grid [data-type="wallet"] .pc-row')].find((r) => /not sendable/.test(r.textContent));
    check('ore offers the one thing you can do with it', ore.querySelector('.pc-act[title="Refine ore into alpha"]') !== null);
  }
  const goRow = d.querySelector('#tm-grid [data-type="targets"] .pc-row.sc-bad');
  check('the target board draws catalogue rows: GO as the stripe and badge, the planet as a chip, the veto as a destructive door', goRow !== null && /GO/.test(goRow.querySelector('.sui-badge').textContent) && goRow.querySelector('.sc-chip[data-kind="planet"]') !== null && goRow.querySelector('.pc-act[title^="Never attack"]').classList.contains('sc-destructive'));
  check('a blocked target says why on its row', [...d.querySelectorAll('#tm-grid [data-type="targets"] .pc-row')].some((r) => /protected/.test(r.querySelector('.pc-attn')?.textContent || '') && r.querySelector('.sui-badge').textContent === 'NO-GO'));
  check('grudges are rows with the weight as the badge and mute and forget as doors', d.querySelector('#tm-grid [data-type="grudges"] .pc-row .sui-badge')?.textContent.startsWith('×') && d.querySelector('#tm-grid [data-type="grudges"] .pc-act[title="Forget this grudge"]') !== null);
  check('vetoes are rows with Remove as a destructive door', d.querySelector('#tm-grid [data-type="vetoes"] .pc-row .pc-act[title^="Remove"]')?.classList.contains('sc-destructive'));
  d.querySelector('#tm-grid [data-type="targets"] .pc-act[title^="Add 1-61"]').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'combat_lists'));
  check('…the target board adds a grudge through combat_lists', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'combat_lists' && c.args.payload.kind === 'grudge' && c.args.payload.id === '1-61'));
  // Energy acts now: the two cards that named a problem and offered no remedy.
  {
    const fuel = d.querySelector('#tm-grid [data-type="fuel"]');
    check('the fuel card carries a ticket: op, reactor, amount', fuel.querySelector('.tm-ticket') !== null && fuel.querySelectorAll('.tm-ticket-fields select').length === 2 && fuel.querySelector('.tm-ticket-fields input') !== null);
    const amount = fuel.querySelector('.tm-ticket-fields input');
    amount.value = '1000000';
    amount.dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_infusion_preview'));
    const prev = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_infusion_preview');
    check('…which previews before it signs, naming reactor and amount', prev.args.op === 'infuse' && prev.args.amountUalpha === 1000000 && !!prev.args.destinationId && !!prev.args.address);
    await until(() => fuel.querySelector('.tm-ticket-note .fstat'));
    check('…and shows what the chain would do', /capacity gained/i.test(fuel.querySelector('.tm-ticket-note').textContent));
    fuel.querySelector('.tm-ticket a.sui-screen-btn').click();
    await until(() => d.querySelector('.ops-modal-overlay'));
    check('…asking before it signs', /Stake this alpha/i.test(d.querySelector('.ops-modal-overlay').textContent));
    [...d.querySelectorAll('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a')][1].click();
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_infusion_infuse'));
    check('…then infuses', (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_infusion_infuse').args.amountUalpha === 1000000);
  }
  {
    const alloc = d.querySelector('#tm-grid [data-type="allocations"]');
    check('an allocation row offers to set its power', alloc.querySelector('.pc-row .pc-act[title^="Set the power"]') !== null);
    alloc.querySelector('.pc-row .pc-act[title^="Set the power"]').click();
    await until(() => alloc.querySelector('.tm-ticket-slot .tm-ticket'));
    const mw = alloc.querySelector('.tm-ticket-slot input');
    // It previews the CURRENT value on open, then again on every edit.
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_allocation_preview'));
    mw.value = '5000';
    mw.dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_allocation_preview' && c.args.powerMw === 5000));
    check('…previewing the change against the budget', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_allocation_preview' && c.args.powerMw === 5000 && c.args.allocationId === '6-53'));
    check('…and a locked allocation offers nothing', [...alloc.querySelectorAll('.pc-row')].every((r) => !/locked/.test(r.textContent) || !r.querySelector('.pc-act')));
  }
  check('an incident row names the attacker as a person and the shots as its badge', /1-1957/.test(d.querySelector('#tm-grid [data-type="incidents"] .pc-row').textContent) && /2-287/.test(d.querySelector('#tm-grid [data-type="incidents"] .pc-row').textContent) && d.querySelector('#tm-grid [data-type="incidents"] .pc-row .sui-badge') !== null);
  check('a raid row stacks attacker vs defender and keeps the live one\'s status word', /Marklifer/.test(d.querySelector('#tm-grid [data-type="raids"] .pc-row').textContent) && /JPEG/.test(d.querySelector('#tm-grid [data-type="raids"] .pc-row').textContent) && d.querySelector('#tm-grid [data-type="raids"] .pc-row.sc-bad') !== null);
  check('a wallet row is an asset row: ore marked not sendable and without a Pay door', [...d.querySelectorAll('#tm-grid [data-type="wallet"] .pc-row')].some((r) => /not sendable/.test(r.textContent) && !r.querySelector('.pc-act[title="Pay"]')) && [...d.querySelectorAll('#tm-grid [data-type="wallet"] .pc-row')].some((r) => r.querySelector('.pc-act[title="Pay"]')));
  // The sweep prices itself before it moves anything.
  const sweepBtn = [...d.querySelectorAll('#tm-grid [data-type="fleet"] a')].find((a) => a.textContent === 'Sweep Alpha');
  sweepBtn.click();
  await until(() => /Confirm sweep/.test(sweepBtn.textContent));
  check('the fleet card\'s sweep is a dry run first, and says what a second click will do', /Confirm sweep of 1/.test(sweepBtn.textContent) && !(w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_mass_action' && c.args.request.mode === 'execute'));
  // Embedded pages: one header. The Comms card's frame carries the Comms nav
  // as doors and the page is asked to drop its own bar (`?embed=1`).
  run('CHAT');
  await until(() => d.querySelector('#tm-grid [data-type="chat"] iframe.tm-frame'));
  const chatCard = d.querySelector('#tm-grid [data-type="chat"]');
  const chatId = chatCard.getAttribute('data-card');
  check('the Comms card is frameless — the page\'s own bar is its header — and the page learns its card id', chatCard.classList.contains('tm-frameless') && chatCard.querySelector('iframe.tm-frame').getAttribute('src') === 'chat.html?embed=1&card=' + chatId && /#tm-grid \.tm-card\.tm-frameless \.tm-head[^{]*\{\s*display:\s*none/.test(read('frontend/board.html')));
  // The page has no bridge of its own: it asks this window to invoke and to
  // listen for it (bridge.js), and only frames this page embeds are answered.
  {
    const replies = [];
    const fakeSource = { postMessage: (m) => replies.push(m) };
    const stranger = { postMessage: (m) => replies.push(m) };
    const frame = chatCard.querySelector('iframe.tm-frame');
    Object.defineProperty(frame, 'contentWindow', { value: fakeSource, configurable: true });
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'invoke', id: 7, cmd: 'terminal_workspaces', args: {} } });
    await until(() => replies.length === 1);
    check('an embedded page\'s invoke is run by this window and answered by message', replies[0].kind === 'result' && replies[0].id === 7 && replies[0].ok === true && Array.isArray(replies[0].value.names));
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'invoke', id: 8, cmd: 'no_such_command', args: {} } });
    await until(() => replies.length === 2);
    check('…a failing invoke answers with the error', replies[1].ok === false && /no fixture/.test(replies[1].error));
    const took = w.Board.Terminal.answerFrame({ origin: '', source: stranger, data: { structs: 'bridge', kind: 'invoke', id: 9, cmd: 'terminal_workspaces', args: {} } });
    check('…a frame this page does not embed is not answered', took === false && replies.length === 2);
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'listen', name: 'matrix::typing' } });
    w.__HARNESS_EMIT__('matrix::typing', { room: '!x' });
    await until(() => replies.some((m) => m.kind === 'event'));
    check('…a listen subscribes here and forwards the event to the page', replies.some((m) => m.kind === 'event' && m.name === 'matrix::typing' && m.payload.room === '!x'));
  }
  // The page's bar asks for pop-out and close by message; only our origin.
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'card', card: chatId, act: 'popout' }, origin: '' }));
  check('…its pop-out asks Rust for a window on this card', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card' && c.args.cardId === chatId));
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'card', card: chatId, act: 'remove' }, origin: 'https://evil.example' }));
  check('…a message from another origin is ignored', d.querySelector('#tm-grid [data-card="' + chatId + '"]') !== null);
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'card', card: chatId, act: 'remove' }, origin: '' }));
  check('…and its close removes the card', d.querySelector('#tm-grid [data-card="' + chatId + '"]') === null);
  // A Terminal window has one header: the board's nav bar, with the
  // workspace tabs and their doors mounted into it.
  const boardNav = d.querySelector('.sui-screen-nav:has(> #board-tabs)');
  // The console's own controls stay put while the cards scroll under them.
  {
    const css = read('frontend/board.html').replace(/\s+/g, ' ');
    const chrome = d.querySelector('.tm-chrome');
    const scroller = d.querySelector('.ops-scroll');
    scroller.scrollTop = 400;
    check('the command line is pinned inside the scroller, so it is reachable from anywhere on the page', /\.tm-chrome \{[^}]*position: sticky/.test(css) && chrome.closest('.ops-scroll') === scroller);
    check('a configure strip lays its fields side by side rather than one per row', /\.tm-config > \* \{ flex: 1 1 200px/.test(css));
  }
  check('in a Terminal window the workspace tabs sit in the board\'s nav bar, doors beside the refresh, and no strip of their own', boardNav.querySelector('#tm-ws-items .sui-mod-active') !== null && boardNav.querySelector('.board-navaside #tm-ws-doors [title="Rename this workspace"]') !== null && d.querySelector('.tm-workspaces #tm-ws-nav') === null && d.getElementById('board-refresh') === null);
  // A planet is the LIVE MAP: the spectator view embedded, fed by a watch
  // addressed to this card, with the neighbouring surfaces as doors.
  run('PLANET 2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="planet"] iframe.tm-frame-map'));
  const planetCard = d.querySelector('#tm-grid [data-type="planet"]');
  const planetId = planetCard.getAttribute('data-card');
  const src = planetCard.querySelector('iframe.tm-frame-map').getAttribute('src');
  check('the planet card embeds the map for that planet, labelled for this card', /^raidview\.html\?planet=2-15361&label=board%3A/.test(src) && src.includes('embed=1') && src.includes('card=' + planetId), src);
  const watch = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_raid_view_watch');
  check('…and asks Rust to push that planet\'s feed to this card', watch && watch.args.planetId === '2-15361' && watch.args.label === 'board:' + planetId);
  check('…with the log, Comms and the full window as doors', [...planetCard.querySelectorAll('.tm-door-own')].map((a) => a.title).join(',') === 'Battle log,Comms about this planet,Watch in its own window');
  w.Board.Terminal.remove(planetId);
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_raid_view_unwatch'));
  const unwatch = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_raid_view_unwatch');
  check('removing the card stops the feed', unwatch.args.label === 'board:' + planetId && unwatch.args.planetId === '2-15361');
  // The two cards the audit said were missing entirely.
  run('FEED');
  await until(() => d.querySelector('#tm-grid [data-type="feed"] .sc-tape'));
  {
    const feed = d.querySelector('#tm-grid [data-type="feed"]');
    check('FEED shows what the loops and the watchdog did, newest first', d.querySelectorAll('#tm-grid [data-type="feed"] .sc-tape').length === 2 && /watchdog/.test(feed.querySelector('.sc-tape').textContent) && /wedged/.test(feed.querySelector('.sc-tape').textContent), feed.querySelector('.sc-tape').textContent);
    w.__HARNESS_EMIT__('board-feed', { ts_ms: Date.now(), severity: 'error', source: 'tx', message: 'signing bridge down' });
    await until(() => /signing bridge down/.test(feed.textContent));
    check('…and a live entry lands on top', /signing bridge down/.test(feed.querySelector('.sc-tape').textContent) && feed.querySelector('.sc-tape').classList.contains('is-new'));
  }
  run('NEXT');
  await until(() => d.querySelector('#tm-grid [data-type="next"] .pc-row, #tm-grid [data-type="next"] .sui-message-inline-alert'));
  {
    const next = d.querySelector('#tm-grid [data-type="next"]');
    const rows = [...next.querySelectorAll('.pc-row')];
    // The fixture galaxy has no brownout and no raid against us, so the most
    // urgent thing it CAN find is a warning — and that is what leads.
    const RANK = { 'sc-bad': 0, 'sc-warn': 1, 'sc-live': 2 };
    const order = rows.map((r) => ['sc-bad', 'sc-warn', 'sc-live'].find((c) => r.classList.contains(c)));
    check('NEXT derives what needs doing from live readings, worst first', rows.length > 0 && order.every((c) => c !== undefined) && order.map((c) => RANK[c]).every((v, i, a) => i === 0 || a[i - 1] <= v), order.join(','));
    check('…each naming what is wrong and why it matters', /earns nothing|waiting|failed|paused|GO/i.test(rows[0].textContent) && /\w/.test(rows[0].querySelector('.pc-id').textContent), rows.map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40)).join(' | '));
    check('…and opens the card that fixes it', rows[0].querySelector('.pc-act[title^="Open "]') !== null);
    const before = d.querySelectorAll('#tm-grid .tm-card').length;
    rows[0].querySelector('.pc-act[title^="Open "]').click();
    check('…as a real card, not a description of one', d.querySelectorAll('#tm-grid .tm-card').length === before + 1);
  }
  run('TAPE');
  check('TAPE is a live stream with a filter, economy by default', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'tape') && w.Board.Terminal.types().find((t) => t.type === 'tape').params[0].options.map((o) => o.value).join(',') === 'economy,combat,all');
  run('SETTINGS');
  check('SETTINGS is the one page still reached as a page, plainly titled', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'page' && c.params.page === 'config') && !/Team Ops/.test(d.querySelector('#tm-grid [data-type="page"] .tm-title').textContent));
  // The battle log and Comms are the raid view's own rails, embedded: two of
  // them can coexist because each is its own document.
  run('LOG 2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="log"] iframe.tm-frame-rail'));
  {
    const src = d.querySelector('#tm-grid [data-type="log"] iframe.tm-frame-rail').getAttribute('src');
    check('LOG embeds the raid view showing only its battle log rail', /^raidview\.html\?planet=2-15361/.test(src) && src.includes('only=log') && src.includes('embed=1'), src);
    check('…and asks Rust to feed that planet to this card', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_raid_view_watch' && c.args.planetId === '2-15361'));
  }
  run('LOG 2-1');
  check('…and a second battle log is allowed, because each rail is its own document', w.Board.Terminal.state.layout.cards.filter((c) => c.type === 'log').length === 2);
  w.Board.Terminal.remove(w.Board.Terminal.state.layout.cards.filter((c) => c.type === 'log')[1].id);

  // Sharing: export → import round-trips into a new workspace.
  const code = w.Board.Terminal.exportWorkspace();
  check('a workspace exports as a terminal: code', /^terminal:[A-Za-z0-9+/=]+$/.test(code));
  const parsed = w.Board.Terminal.parseShared('please IMPORT ' + code + ' thanks');
  check('…that parses back with every card, even from inside a chat message', parsed && parsed.name === w.Board.Terminal.state.ws && parsed.cards.length === w.Board.Terminal.state.layout.cards.length);
  check('a bad code is refused, not thrown', w.Board.Terminal.parseShared('terminal:!!!') === null && w.Board.Terminal.parseShared('{"cards":"x"}') === null);
  const before = w.Board.Terminal.state.ws;
  await w.Board.Terminal.importWorkspace(code);
  check('IMPORT makes a new workspace beside the old one', w.Board.Terminal.state.ws !== before && w.Board.Terminal.state.ws.startsWith(before) && w.Board.Terminal.state.workspaces.includes(w.Board.Terminal.state.ws));
  // Role presets: a starting workspace per kind of player.
  run('PRESET trader');
  await tick(20);
  check('PRESET makes the role\'s workspace and goes there', w.Board.Terminal.state.ws === 'trader' && w.Board.Terminal.state.layout.cards.some((c) => c.type === 'market') && w.Board.Terminal.state.layout.cards.some((c) => c.type === 'book'));
  check('every preset names only registered card types and unique ids', Object.keys(w.Board.Terminal.PRESETS).every((k) => { const l = w.Board.Terminal.presetLayout(k); const ids = l.cards.map((c) => c.id); return l.cards.every((c) => w.Board.Terminal.known(c.type)) && new Set(ids).size === ids.length; }));
  [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].find((a) => a.textContent === '+').click();
  check('the new-workspace row offers the presets', !!d.querySelector('#tm-ws-preset') && d.querySelectorAll('#tm-ws-preset option').length === Object.keys(w.Board.Terminal.PRESETS).length + 1);
  run('SHARE');
  check('SHARE opens the share row with the code and a door to Comms', d.querySelector('#tm-ws-share input')?.value === w.Board.Terminal.exportWorkspace() && [...d.querySelectorAll('#tm-ws-share a')].some((a) => a.textContent === 'Send to Comms'));
  [...d.querySelectorAll('#tm-ws-share a')].find((a) => a.textContent === 'Send to Comms').click();
  await tick(10);
  check('…which shares it as a message', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_share' && /IMPORT terminal:/.test(c.args.text)));

  // Two windows, one workspace: a save adopts the version Rust answers, an
  // announced newer version from elsewhere reloads the page's copy.
  await w.Board.Terminal.flushSave();
  check('a save adopts the version Rust stored', w.Board.Terminal.state.layout.version === 4);
  check('the page listens for other windows\' saves', w.StructsEvents.names().includes('terminal-layout'));
  {
    const before = w.Board.Terminal.state.layout.cards.length;
    w.__HARNESS_EMIT__('terminal-layout', { workspace: w.Board.Terminal.state.ws, version: 4 });
    await tick(30);
    check('…an announcement at its own version changes nothing', w.Board.Terminal.state.layout.cards.length === before);
    w.__HARNESS_EMIT__('terminal-layout', { workspace: 'somewhere-else', version: 99 });
    await tick(30);
    check('…nor one for another workspace', w.Board.Terminal.state.layout.cards.length === before);
    w.__HARNESS_EMIT__('terminal-layout', { workspace: w.Board.Terminal.state.ws, version: 99 });
    await until(() => w.Board.Terminal.state.layout.cards.length !== before);
    // A workspace change elsewhere: the list follows, and a window showing a
    // deleted workspace moves to the active one rather than saving it back.
    w.__HARNESS_EMIT__('terminal-workspaces', { active: 'main', names: ['main', 'war-room', 'ops-2'] });
    await tick();
    check('a workspace list announced by another window is taken up by the strip', w.Board.Terminal.state.workspaces.join(',') === 'main,war-room,ops-2' && [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].some((n) => n.textContent === 'ops-2'));
    const wsBefore = w.Board.Terminal.state.ws;
    w.__HARNESS_EMIT__('terminal-workspaces', { active: 'war-room', names: ['war-room'] });
    await until(() => w.Board.Terminal.state.ws === 'war-room');
    check('…and a window whose workspace was deleted switches to the active one', wsBefore !== 'war-room' && w.Board.Terminal.state.ws === 'war-room' && w.Board.Terminal.state.workspaces.join(',') === 'war-room');
    w.__HARNESS_EMIT__('terminal-workspaces', { active: 'main', names: ['main', 'war-room'] });
    await w.Board.Terminal.switchWorkspace('main');
    check('…but a newer version for this workspace reloads the layout from Rust', w.Board.Terminal.state.layout.cards.length === 6 && d.querySelectorAll('#tm-grid .tm-card').length === 6);
  }

  run('NOPE');
  check('an unknown word is refused in place, not swallowed', cmd.classList.contains('is-err') && cmd.value === 'NOPE');

  // Workspaces.
  [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].find((a) => a.textContent === 'war-room').click();
  await until(() => w.Board.Terminal.state.ws === 'war-room');
  check('picking a workspace switches the page and activates it', w.Board.Terminal.state.ws === 'war-room' && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_workspace_activate' && c.args.name === 'war-room'));
  // Delete asks first; the strip's delete door never acts on one click.
  const delCallsBefore = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_workspace_delete').length;
  d.querySelector('#tm-ws-doors [title="Delete this workspace"]').click();
  await until(() => d.querySelector('.ops-modal-overlay'));
  check('delete asks first, naming the workspace', d.querySelector('.ops-modal-overlay') !== null && /war-room/.test(d.querySelector('.ops-modal-overlay').textContent) && (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_workspace_delete').length === delCallsBefore);
  d.querySelector('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a').click();
  check('…and Cancel keeps it', d.querySelector('.ops-modal-overlay') === null && w.Board.Terminal.state.workspaces.includes('war-room'));
  // Rename: the door opens a name box; Enter renames through Rust, closes the
  // old windows first, and the strip follows the new name.
  await w.Board.Terminal.switchWorkspace('main');
  d.querySelector('#tm-ws-doors [title="Rename this workspace"]').click();
  const renameBox = d.getElementById('tm-ws-rename-name');
  check('rename opens a box holding the current name', renameBox !== null && renameBox.value === 'main');
  renameBox.value = 'ops';
  renameBox.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => w.Board.Terminal.state.ws === 'ops');
  const renameCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_workspace_rename');
  const calls = (w.__HARNESS_CALLS__ || []);
  check('Enter renames through Rust, old windows closed first', renameCall && renameCall.args.from === 'main' && renameCall.args.to === 'ops' && calls.findIndex((c) => c.cmd === 'terminal_workspace_windows_close' && c.args.name === 'main') < calls.indexOf(renameCall));
  check('…and the strip and the page follow the new name', w.Board.Terminal.state.ws === 'ops' && d.querySelector('#tm-ws-items .sui-mod-active').textContent === 'ops' && [...d.querySelectorAll('#tm-ws-items a, #tm-ws-items button')].every((n) => n.textContent !== 'main'));
  check('a taken name is refused without touching Rust', (w.Board.Terminal.renameWorkspace('ops', 'war-room'), (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_workspace_rename').length === 1));
  await w.Board.Terminal.renameWorkspace('ops', 'main');
  await w.Board.Terminal.switchWorkspace('war-room');
  // Order: the strip is arranged by the player, through Rust, and the doors
  // know the ends — war-room is last, so right is off and left is live.
  // Order: drag a tab along the strip — the same pointer drag the cards use.
  check('there are no nudge doors; the tabs drag', d.querySelectorAll('#tm-ws-doors [title^="Move this workspace"]').length === 0 && d.querySelector('#tm-ws-items [data-ws="war-room"]').title === 'Drag to move');
  {
    const src = d.querySelector('#tm-ws-items [data-ws="war-room"]'), dst = d.querySelector('#tm-ws-items [data-ws]');
    d.elementFromPoint = (x) => (x < 100 ? dst : null);
    dst.getBoundingClientRect = () => ({ left: 0, width: 80, top: 0, height: 30, right: 80, bottom: 30 });
    const ev = (type, x, y, el) => (el || w).dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    ev('pointerdown', 300, 10, src);
    ev('pointermove', 20, 10);
    check('while dragging, the tab under the pointer shows the drop side', dst.classList.contains('tm-drop-before'));
    ev('pointerup', 20, 10);
    delete d.elementFromPoint;
  }
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_workspace_order'));
  const orderCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_workspace_order');
  // (The rename fixture answers a fixed list, so only war-room's move is pinned, not its neighbour's name.)
  check('a nudge sends the whole order to Rust and redraws the strip in it', orderCall.args.names[0] === 'war-room' && orderCall.args.names.length === w.Board.Terminal.state.workspaces.length && d.querySelector('#tm-ws-items .sui-screen-nav-item').textContent === 'war-room', orderCall.args.names.join(','));
  await w.Board.Terminal.dropWorkspace('war-room', null, true);
  check('…loading that workspace\'s own layout', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_layout_get' && c.args && c.args.workspace === 'war-room'));
  d.querySelector('#tm-ws-doors [title="Open this workspace in its own window"]').click();
  await tick(10);
  check('a workspace can be a window of its own', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_workspace' && c.args.name === 'war-room'));
  [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].find((a) => a.textContent === '+').click();
  const nameBox = d.getElementById('tm-ws-new');
  check('+ asks for a name', nameBox !== null);
  nameBox.value = 'ore desk'; nameBox.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => w.Board.Terminal.state.ws === 'oredesk');
  check('a new workspace takes a plain name and becomes the page', w.Board.Terminal.state.ws === 'oredesk' && w.Board.Terminal.state.workspaces.includes('oredesk'));
}

// ── A pop-out: one card, no toolbar, full width ────────────────────────────
{
  const dom = await load('?view=terminal&card=market-1');
  const w = dom.window, d = w.document;
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 1);
  check('a pop-out shows exactly its card', d.querySelectorAll('#tm-grid .tm-card').length === 1 && d.querySelector('#tm-grid .tm-card').getAttribute('data-card') === 'market-1');
  check('…full width, with no toolbar and no layout doors', d.querySelector('.tm-toolbar') === null && d.querySelector('#tm-market-1').classList.contains('tm-w3') && d.querySelector('#tm-market-1 [title="Remove"]') === null);
  check('…and no refresh door either: it refreshes on its cadence', d.querySelector('#tm-market-1 [title="Refresh"]') === null && w.Board.Terminal.cadenceOf('market-1') > 0);
}

// ── No layout yet: the default page ────────────────────────────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal);
  w.__HARNESS_REJECT__.terminal_layout_get = 'no file';
  try { w.localStorage.removeItem('structs.terminal.layout'); } catch (e) { /* file: origin has none */ }
  await w.Board.Terminal.enter();
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 7);
  check('with nothing saved, the default page has seven cards', d.querySelectorAll('#tm-grid .tm-card').length === 7);
  await until(() => d.querySelector('#tm-grid [data-type="tape"] ul.tm-tape'));
  check('a card kept by id from the last layout is re-rendered for its new params', /UNIVERSE/.test(d.querySelector('#tm-stats-1')?.textContent || ''));
  check('…including the flow tape, drawn as the stream draws its rows', d.querySelector('#tm-grid [data-type="tape"] ul.tm-tape') !== null);
  // A live frame arrives: ONE tape line (structs-cards.js), folded by the
  // board's own grass algorithm (old→new, block lifted out), newest striped.
  w.__HARNESS_EMIT__('grass-event', { category: 'ore', subject: 'structs.grid.planet.2-29577.1-422', timestamp: Date.now(), detail: { object_id: '2-29577', object_type: 'planet', player_id: '1-422', attribute_type: 'ore', value: 12, value_old: 11, block_height: 2507904 } });
  await until(() => d.querySelector('#tm-grid [data-type="tape"] .sc-tape'));
  const tapeLine = d.querySelector('#tm-grid [data-type="tape"] .sc-tape');
  check('…and a tape line opens what it is about', (() => { const before = w.Board.Terminal.state.layout.cards.length; d.querySelector('#tm-grid [data-type="tape"] .sc-tape').click(); return w.Board.Terminal.state.layout.cards.length === before + 1; })());
  check('a tape event is one grid line: time, kind badge, subject, folded values, block', tapeLine.classList.contains('is-new') && /grid\.planet\.2-29577\.1-422/.test(tapeLine.textContent) && /11g → 12g/.test(tapeLine.textContent) && /#2,507,904/.test(tapeLine.querySelector('.sc-tape-blk').textContent) && tapeLine.querySelectorAll('.sc-tape-kv').length === 5 && !/block_height/.test(tapeLine.textContent), tapeLine.textContent);
  check('…with the whole event on hover', /object_id 2-29577/.test(tapeLine.querySelector('.sc-tape-body').title));
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
