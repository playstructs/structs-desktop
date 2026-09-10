// ⌘K over the game: the palette as a frame, and the game window that hosts it.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/palette.test.mjs
//
// Two halves, tested separately because they run in different windows:
//   the FRAME  — board.html?view=palette, the real palette and nothing else
//   the HOST   — the block structs-config.js injects into the game window
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
const load = (q) => JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + q, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
// The frame: board.html?view=palette
// ══════════════════════════════════════════════════════════════════════════
{
  console.log('\n— the frame carries the palette and nothing else');
  const dom = await load('?view=palette');
  const w = dom.window, d = w.document;
  await until(() => d.getElementById('tm-palette'));

  check('the palette is built and already open — the frame IS the palette',
    d.getElementById('tm-palette') !== null && d.getElementById('tm-palette').hidden === false);
  check('…marked as a palette so the page can paint itself out of the way',
    d.documentElement.getAttribute('data-view') === 'palette');
  check('…and it is not a solo VIEW, which would route to a section it has none of',
    d.documentElement.getAttribute('data-solo') === null && w.Board.solo === null);
  check('the board itself is not drawn', w.getComputedStyle(d.getElementById('board-layout')).display === 'none');

  /* The whole reason this is a mode and not a `SOLO_VIEWS` entry: solo skips
   * almost nothing. A palette that dragged in the Ops snapshot, the feed, the
   * 15-second Comms poll and the grass tail would cost more than the card it
   * opens. */
  await tick(600);
  const boot = (w.__HARNESS_CALLS__ || []).map((c) => c.cmd);
  check('…and it boots without asking the app for anything at all', boot.length === 0, boot.join(', '));
  check('…so nothing is listening either', (w.__HARNESS_LISTENERS__ ? Object.keys(w.__HARNESS_LISTENERS__) : []).length === 0,
    Object.keys(w.__HARNESS_LISTENERS__ || {}).join(', '));

  /* Registration is free — the registry is filled at script-eval with no I/O —
   * so the grammar is whole even though the page fetched nothing. */
  const T = w.Board.Terminal;
  check('the grammar is whole: every card, its groups and its completions',
    T.types().length > 20 && T.groups().length >= 6
    && T.suggestFor('').filter((o) => o.group !== 'Comms').length === T.types().length
    && T.suggestFor('').filter((o) => o.group === 'Comms').length === 4,
    T.types().length + ' types, ' + T.suggestFor('').length + ' rows');
  check('…including subject-first completion, which is what the palette is FOR',
    T.functionsFor('2-29604').some((f) => f.word === 'PLANET'));

  // ── A pick becomes a window, because there is no page to land on ─────────
  const ran = [];
  w.addEventListener('message', () => {});
  const posted = [];
  w.parent = { postMessage: (m) => posted.push(m) };   // stand in for the game window
  check('picking a card asks for a card AND a window, in one call',
    T.execute('RECORD 1-194') === true
    && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card_new'
      && c.args.kind === 'record' && c.args.params.id === '1-194'),
    JSON.stringify((w.__HARNESS_CALLS__ || []).slice(-1)));
  check('…and never adds a card here — there is no layout, and touching one would throw',
    !(w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_layout_set'));

  /* The other verbs all MUTATE a workspace this page never loaded. A preset
   * would overwrite the layout with `state.layout` still null. */
  check('a verb that would rewrite a workspace is refused, not half done',
    T.execute('RESET') === false && T.execute('PRESET war') === false,
    String(T.execute('RESET')));

  await tick(50);
  check('…and running one tells the host to put the overlay away',
    posted.some((m) => m && m.structs === 'palette' && m.act === 'ran'), JSON.stringify(posted));
  T.closePalette();
  check('Escape and a click on the scrim say the same thing',
    posted.some((m) => m && m.structs === 'palette' && m.act === 'close'), JSON.stringify(posted));
}

// ══════════════════════════════════════════════════════════════════════════
// The host: the block structs-config.js puts in the game window
// ══════════════════════════════════════════════════════════════════════════
{
  console.log('\n— the game window hosts it');
  const src = read('frontend/structs-config.js');
  const start = src.indexOf('/* ── [structs-universe] ⌘K over the game');
  check('the host block is in structs-config.js, which is what the game window loads',
    start > 0 && /<script src="structs-config\.js">/.test(read('frontend/index.html')));
  const end = src.indexOf('} else if (!window.__STRUCTS_CONFIG__) {');
  const block = src.slice(start, end);

  const dom = new JSDOM('<!doctype html><body><div id=game>the game</div></body>', { runScripts: 'outside-only', url: 'https://tauri.localhost/' });
  const w = dom.window, d = w.document;
  // jsdom has no window.focus; the host calls it to hand the keyboard back to
  // the game, inside a try/catch. Stub it so the log is about the test.
  w.focus = () => {};
  const calls = [];
  /* Eval'd with NOTHING in scope but the window, exactly as structs-config.js
   * runs it. Handing the block a `TAURI` parameter is what let a
   * `ReferenceError: Can't find variable: TAURI` ship: there is no file-wide
   * binding in that file — every block declares its own from `window.__TAURI__`
   * — and a harness that supplies one tests a file that does not exist. */
  w.__TAURI__ = { core: { invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve({ ok: 1 }); } } };
  w.eval('(function(){\n' + block + '\n})()');

  const host = () => d.getElementById('structs-palette-host');
  check('nothing is built until it is asked for', host() === null);
  // Comments stripped: the block's own prose explains why it declares one.
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the block declares its own bridge — this file has no file-wide TAURI',
    /var TAURI = window\.__TAURI__;/.test(code)
    && code.indexOf('TAURI') === code.indexOf('var TAURI = window.__TAURI__;') + 'var '.length,
    JSON.stringify(code.slice(Math.max(0, code.indexOf('TAURI') - 40), code.indexOf('TAURI') + 40)));

  const key = (init) => w.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)));
  key({ key: 'k', metaKey: true });
  check('⌘K builds the overlay and shows it', host() !== null && host().style.display === 'block');
  const frame = host().querySelector('iframe');
  check('…which frames the real palette, not a copy of it',
    frame !== null && /board\.html\?view=palette/.test(frame.getAttribute('src')), frame && frame.getAttribute('src'));
  /* It hangs off <body>. The webapp's own grass listeners `goto()` the menu on
   * the slightest provocation and wipe anything injected into the menu page. */
  check('…on the body, out of reach of the webapp\'s own navigation',
    host().parentNode === d.body);

  key({ key: 'k', metaKey: true });
  check('⌘K again puts it away', host().style.display === 'none');
  key({ key: 'k', ctrlKey: true });
  check('Ctrl-K is the same key on the other platform', host().style.display === 'block');
  key({ key: 'k', metaKey: true, altKey: true });
  check('…and a modifier we do not claim is left to the game', host().style.display === 'block');
  key({ key: 'j', metaKey: true });
  check('…as is every other key', host().style.display === 'block');

  // ── The frame may ask for exactly one thing ─────────────────────────────
  /* An iframe shares its host window's LABEL, so anything the game window may
   * invoke, this frame could ask it to. It is answered for the command that
   * turns a pick into a window, and nothing else. */
  const replies = [];
  const fakeFrame = { postMessage: (m) => replies.push(m), focus: () => {}, blur: () => {} };
  Object.defineProperty(frame, 'contentWindow', { value: fakeFrame, configurable: true });
  const ask = (id, cmd) => w.dispatchEvent(new w.MessageEvent('message', {
    data: { structs: 'bridge', kind: 'invoke', id, cmd, args: {} }, origin: w.location.origin, source: fakeFrame,
  }));
  ask(1, 'open_terminal_card_new');
  ask(2, 'mcp_transfer_execute');
  ask(3, 'mcp_action');
  ask(4, 'terminal_layout_set');
  await tick(30);
  const byId = (n) => replies.filter((m) => m.structs === 'bridge' && m.id === n)[0];
  check('the pick reaches the app', byId(1) && byId(1).ok === true && calls.some((c) => c.cmd === 'open_terminal_card_new'));
  check('…and nothing else does, with a reason rather than silence',
    [2, 3, 4].every((n) => byId(n) && byId(n).ok === false && /not available to the palette/.test(byId(n).error))
    && !calls.some((c) => /transfer|mcp_action|layout_set/.test(c.cmd)),
    JSON.stringify([2, 3, 4].map((n) => byId(n) && byId(n).error)));

  /* Everything the palette PAGE actually invokes, over the game. `PLANET jpeg`
   * was fixed in the Terminal window and still did nothing over the map,
   * because the search it needs was not on this list — and the palette
   * swallows a refusal, so nothing said why. The list below is what the
   * palette's own code calls (search, prose search, SAY, the rows' acts, the
   * server names); it must match the allowlist exactly, so a command added to
   * one side without the other fails here rather than in the window. */
  const PALETTE_CALLS = ['open_terminal_card_new', 'log_ui_events', 'mcp_player_search', 'matrix_open', 'terminal_charts'];
  const cfgSrc = readFileSync(resolve(repo, 'frontend/structs-config.js'), 'utf8');
  const listed = (cfgSrc.match(/var FRAME_CMDS = \{([\s\S]*?)\};/) || ['', ''])[1].match(/\b[a-z_]+(?=: 1)/g) || [];
  check('the palette frame may invoke exactly what the palette page calls',
    listed.slice().sort().join(',') === PALETTE_CALLS.slice().sort().join(','), listed.sort().join(','));
  PALETTE_CALLS.forEach((cmd, i) => ask(100 + i, cmd));
  await tick(30);
  check('…and each of them is answered, not refused — `PLANET jpeg` included',
    PALETTE_CALLS.every((cmd, i) => byId(100 + i) && byId(100 + i).ok === true)
    && calls.some((c) => c.cmd === 'mcp_player_search'),
    JSON.stringify(PALETTE_CALLS.map((cmd, i) => cmd + ':' + (byId(100 + i) ? byId(100 + i).ok : '?'))));

  /* A message whose source is not our frame is not our frame's. */
  const stranger = { postMessage: () => {} };
  const before = calls.length;
  w.dispatchEvent(new w.MessageEvent('message', {
    data: { structs: 'bridge', kind: 'invoke', id: 9, cmd: 'open_terminal_card_new', args: {} },
    origin: w.location.origin, source: stranger,
  }));
  await tick(20);
  check('a window that is not the palette is not answered', calls.length === before);

  // ── The frame closing itself closes the overlay ──────────────────────────
  const say = (act) => w.dispatchEvent(new w.MessageEvent('message', {
    data: { structs: 'palette', act }, origin: w.location.origin, source: fakeFrame,
  }));
  say('ran');
  check('a card opened means the overlay is done', host().style.display === 'none');
  key({ key: 'k', metaKey: true });
  say('close');
  check('…and so does Escape or a click on the scrim, which the frame reports',
    host().style.display === 'none');
}

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
