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
  check('the saved layout is drawn, in its order — a saved whole-page card migrated into the cards that carry its data', cards.map((c) => c.getAttribute('data-card')).join(',') === 'people-1,market-1,pow-1,tasks-1,player-1,stats-1', cards.map((c) => c.getAttribute('data-card')).join(','));
  check('no card is titled after a window', [...d.querySelectorAll('#tm-grid .tm-title')].every((t) => !/Team Ops|Game Stats/.test(t.textContent)));
  check('widths come from the layout', cards[1].classList.contains('tm-w2') && cards[0].classList.contains('tm-w1'));
  check('the toolbar offers every registered type', d.querySelectorAll('.tm-toolbar select option').length >= 12);
  check('every card is the game\'s data card with its doors in the header', cards.every((c) => c.classList.contains('sui-data-card') && c.querySelector('.sui-data-card-header .tm-doors')));
  const wsItems = [...d.querySelectorAll('#tm-ws-nav .sui-screen-nav-item')].map((a) => a.textContent);
  check('the workspace strip lists every workspace and a door to a new one', wsItems.join(',') === 'main,war-room,+' && d.querySelector('#tm-ws-nav .sui-mod-active').textContent === 'main', wsItems.join(','));

  await until(() => d.querySelector('#tm-people-1 .pc-person'));
  check('liveness card: the Game Stats people card, inside the Terminal', d.querySelectorAll('#tm-people-1 .pc-person').length === 12);
  await until(() => d.querySelectorAll('#tm-market-1 .sui-planet-card').length === 2);
  const offers = [...d.querySelectorAll('#tm-market-1 .sui-planet-card')];
  check('market card: one provider card per offer, from terminal_market', offers.length === 2);
  check('…an open offer can be rented, a guild-market one cannot', d.querySelectorAll('#tm-market-1 .tm-offer')[0].querySelector('[title="Rent capacity"]') !== null && d.querySelectorAll('#tm-market-1 .tm-offer')[1].querySelector('[title="Rent capacity"]') === null);
  await until(() => d.querySelector('#tm-pow-1 .fstat'));
  check('proof queue card: counts as tiles, the engine as rows', d.querySelectorAll('#tm-pow-1 .fstat').length === 3 && /GPU/.test(d.querySelector('#tm-pow-1').textContent) && /auto-tuned/.test(d.querySelector('#tm-pow-1').textContent));
  await until(() => d.querySelector('#tm-tasks-1 .sui-result-row'));
  check('tasks card: one row per proof, progress first', d.querySelectorAll('#tm-tasks-1 .sui-result-row').length === 3 && /5-12:mine/.test(d.querySelector('#tm-tasks-1 .sui-result-row').textContent));
  check('the Team Ops pages themselves are not offered as cards (only the settings forms)', ![...d.querySelectorAll('.tm-toolbar select option')].some((o) => /Team Ops/.test(o.textContent)) && !w.Board.Terminal.types().some((t) => t.type === 'page'));
  await until(() => d.querySelector('#tm-player-1 .pc-card'));
  check('player card: the shared card for the named player', /JPEG/.test(d.querySelector('#tm-player-1 .pc-card')?.textContent || ''));
  await until(() => d.querySelector('#tm-stats-1 .fstat'));
  check('stats card: one Game Stats section', /RAID PRESSURE/i.test(d.querySelector('#tm-stats-1')?.textContent || ''));

  // Doors.
  const set = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_layout_set');
  d.querySelector('#tm-people-1 [title="Move down"]').click();
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
  run('1-248');
  check('a bare player id opens that player', d.querySelector('#tm-grid [data-card="player-2"]')?.getAttribute('data-type') === 'player' && w.Board.Terminal.state.layout.cards.find((c) => c.id === 'player-2').params.id === '1-248');
  run('GUILD 0-2');
  check('GUILD opens a guild', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'guild' && c.params.id === '0-2'));
  run('2-15361');
  check('a planet id opens the planet view', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'planet')?.params.id === '2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="planet"] .tm-planet-row'));
  {
    const pc = d.querySelector('#tm-grid [data-type="planet"]');
    check('…drawing the owner as a person line and the readings strip', pc.querySelector('.pc-person')?.getAttribute('data-player-id') === '1-61' && pc.querySelectorAll('.tm-planet-strip .fstat').length === 3);
    check('…a row per ambit with a slot tile for every slot, open ones marked', pc.querySelectorAll('.tm-planet-row').length === 5 && pc.querySelectorAll('.tm-planet-slot').length === 13 && pc.querySelectorAll('.tm-planet-slot.tm-empty').length === 9);
    check('…struct portraits from the shared art map, offline dimmed, the enemy fleet marked', [...pc.querySelectorAll('.tm-planet-slot img')].some((i) => i.getAttribute('src') === 'img/structs/tank/tank-struct-base.png') && pc.querySelectorAll('.tm-planet-slot.tm-off').length === 1 && pc.querySelectorAll('.tm-planet-slot.tm-enemy').length === 1);
    check('…and the live raid as an alert line', /shields vulnerable · Marklifer/.test(pc.querySelector('.tm-body').textContent));
    [...pc.querySelectorAll('.tm-planet-doors a')].find((a) => a.textContent === 'Map').click();
    check('its doors open the sibling cards for the same planet', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'map')?.params.id === '2-15361');
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
  check('ORE lists who HOLDS ore, richest first, from the stats leaderboard', /#1/.test(d.querySelector('#tm-grid [data-type="ore"] .pc-row').textContent) && d.querySelector('#tm-grid [data-type="ore"] .pc-row').getAttribute('data-player-id') === '1-101' && /25 holders shown/.test(d.querySelector('#tm-grid [data-type="ore"]').textContent) && !/planets with ore/.test(d.querySelector('#tm-grid [data-type="ore"]').textContent));
  run('BOOK 1-194');
  await until(() => d.querySelector('#tm-grid [data-type="book"] .pc-row'));
  const book = d.querySelector('#tm-grid [data-type="book"]');
  check('BOOK shows what was bought and sold and when the first runs out', /buying from 1-170/.test(book.textContent) && /selling to 1-482/.test(book.textContent) && /First expiry/i.test(book.textContent) && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_agreements' && c.args.player === '1-194'));
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
  check('every card carries a resize grip and its move doors are quiet', d.querySelectorAll('#tm-grid .tm-card .tm-resize').length === d.querySelectorAll('#tm-grid .tm-card').length && d.querySelectorAll('.tm-door-quiet').length >= 2);
  w.Board.Terminal.resizeTo(first, 3, false);
  check('a resize commits the width to the layout', d.querySelector('#tm-' + first).classList.contains('tm-w3') && w.Board.Terminal.state.layout.cards.find((c) => c.id === first).w === 3);
  w.Board.Terminal.resizeTo(first, 9, false);
  check('…clamped to the grid', w.Board.Terminal.state.layout.cards.find((c) => c.id === first).w === 3);

  // Page views and the battle log.
  // The ops cards: every one renders from the page's own command, no whole page.
  for (const [word, type, expect] of [
    ['QUEUE', 'queue', /StructBuildInitiate/], ['RESULTS', 'results', /insufficient charge/], ['SOLVE', 'solve', /GPU/],
    ['GRID', 'grid', /connections/i], ['FUEL', 'fuel', /Auto infuse/], ['ALLOC', 'allocations', /6-53/], ['FLEET', 'fleet', /MARKLIFER/],
    ['RAIDS', 'raids', /shields vulnerable/], ['POSTURE', 'posture', /Response/], ['TARGETS', 'targets', /NO-GO — protected/],
    ['GRUDGES', 'grudges', /beezhan/], ['VETOES', 'vetoes', /player 1-248/], ['INCIDENTS', 'incidents', /1-287 @ 2-287/],
    ['WALLET', 'wallet', /Hydro \[OH\]/], ['HEALTH', 'health', /./],
  ]) {
    run(word);
    const sel = '#tm-grid [data-type="' + type + '"]';
    await until(() => d.querySelector(sel) && !/…$/.test(d.querySelector(sel + ' .tm-body').textContent.trim()) && d.querySelector(sel + ' .tm-body').textContent.trim() !== '');
    const body = d.querySelector(sel + ' .tm-body');
    check(word + ' renders the ' + type + ' card from its own data', !!body && expect.test(body.textContent) && !/unavailable/.test(body.textContent), body && body.textContent.slice(0, 120));
  }
  // Actionable: a queued signing can be cancelled from its row…
  [...d.querySelectorAll('#tm-grid [data-type="queue"] .tx-btns a')].find((a) => a.title === 'Cancel').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_tx_mutate' && c.args.op === 'cancel'));
  check('…the queue card cancels through the same command as the page', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_tx_mutate' && c.args.op === 'cancel' && c.args.id === 't2'));
  // …a combat loop toggles from the posture card…
  [...d.querySelectorAll('#tm-grid [data-type="posture"] a')].find((a) => a.textContent === 'Raiding on').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'loop'));
  const loopCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'loop');
  check('…the posture card switches a loop by sending its whole config back', loopCall.args.payload.loop === 'raid' && loopCall.args.payload.config.enabled === true && loopCall.args.payload.config.posture === 'opportunist');
  // …and a target can be grudged from the board.
  d.querySelector('#tm-grid [data-type="targets"] .tx-btns a[title^="Add 1-61"]').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'combat_lists'));
  check('…the target board adds a grudge through combat_lists', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'combat_lists' && c.args.payload.kind === 'grudge' && c.args.payload.id === '1-61'));
  // The sweep prices itself before it moves anything.
  const sweepBtn = [...d.querySelectorAll('#tm-grid [data-type="fleet"] a')].find((a) => a.textContent === 'Sweep Alpha');
  sweepBtn.click();
  await until(() => /Confirm sweep/.test(sweepBtn.textContent));
  check('the fleet card\'s sweep is a dry run first, and says what a second click will do', /Confirm sweep of 1/.test(sweepBtn.textContent) && !(w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_mass_action' && c.args.request.mode === 'execute'));
  run('TAPE');
  check('TAPE is a live stream with a filter, economy by default', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'tape') && w.Board.Terminal.types().find((t) => t.type === 'tape').params[0].options.map((o) => o.value).join(',') === 'economy,combat,all');
  run('SETTINGS');
  check('SETTINGS is the one page still reached as a page, plainly titled', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'page' && c.params.page === 'config') && !/Team Ops/.test(d.querySelector('#tm-grid [data-type="page"] .tm-title').textContent));
  run('LOG 2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="log"] #rv-log-body'));
  check('LOG draws the raid view\'s battle log for a planet, asking the same command', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_raid_log' && c.args.planetId === '2-15361'));
  await until(() => d.querySelectorAll('#rv-log-body .rv-log-row').length);
  check('…and draws its rows under day headings with the category chips', d.querySelectorAll('#rv-log-body .rv-log-row').length === 3 && d.querySelectorAll('#rv-log-body .rv-log-day').length === 2 && d.querySelectorAll('#rv-log-filters .rv-log-chip').length >= 3);
  run('LOG 2-1');
  check('…one battle log per window', w.Board.Terminal.state.layout.cards.filter((c) => c.type === 'log').length === 1);

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
  [...d.querySelectorAll('#tm-ws-nav .sui-screen-nav-item')].find((a) => a.textContent === '+').click();
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
    check('…but a newer version for this workspace reloads the layout from Rust', w.Board.Terminal.state.layout.cards.length === 6 && d.querySelectorAll('#tm-grid .tm-card').length === 6);
  }

  run('NOPE');
  check('an unknown word is refused in place, not swallowed', cmd.classList.contains('is-err') && cmd.value === 'NOPE');

  // Workspaces.
  [...d.querySelectorAll('#tm-ws-nav .sui-screen-nav-item')].find((a) => a.textContent === 'war-room').click();
  await until(() => w.Board.Terminal.state.ws === 'war-room');
  check('picking a workspace switches the page and activates it', w.Board.Terminal.state.ws === 'war-room' && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_workspace_activate' && c.args.name === 'war-room'));
  check('…loading that workspace\'s own layout', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_layout_get' && c.args && c.args.workspace === 'war-room'));
  d.querySelector('.tm-workspaces [title="Open this workspace in its own window"]').click();
  await tick(10);
  check('a workspace can be a window of its own', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_workspace' && c.args.name === 'war-room'));
  [...d.querySelectorAll('#tm-ws-nav .sui-screen-nav-item')].find((a) => a.textContent === '+').click();
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
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 7);
  check('with nothing saved, the default page has seven cards', d.querySelectorAll('#tm-grid .tm-card').length === 7);
  await until(() => d.querySelector('#tm-grid [data-type="tape"] ul.tm-tape'));
  check('a card kept by id from the last layout is re-rendered for its new params', /UNIVERSE/.test(d.querySelector('#tm-stats-1')?.textContent || ''));
  check('…including the flow tape, drawn as the stream draws its rows', d.querySelector('#tm-grid [data-type="tape"] ul.tm-tape') !== null);
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
