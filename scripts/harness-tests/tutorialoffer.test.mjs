// The Combat Training offer (frontend/structs-config.js).
//
//   node scripts/harness-tests/tutorialoffer.test.mjs
//
// The block is self-contained, so unlike the other structs-config checks these
// are FUNCTIONAL: the IIFE is sliced out of the file and run in jsdom against a
// stub game (gameState / menuPage / fetch), then driven through the decision
// matrix. What it pins: a player is asked once and never again, an unreachable
// onboarding history asks nobody, and the offer never lands on top of a menu.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(resolve(repo, 'frontend', 'structs-config.js'), 'utf8');

const START = '// ── Combat Training offer';
const start = src.indexOf(START);
if (start < 0) { console.error('FAIL the Combat Training offer block is gone'); process.exit(1); }
const end = src.indexOf('} else if (!window.__STRUCTS_CONFIG__)', start);
const block = src.slice(start, end);

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(25); }
}

const HTML = `<!doctype html><html><body>
  <div id="menu-page-layout" class="hidden"></div>
  <div id="loading-screen" class="hidden"></div>
  <a id="launchTutorial" href="#">Launch Tutorial</a>
  <a id="skipTutorial" href="#">Skip Tutorial</a>
</body></html>`;

/**
 * A stub game window with the block loaded.
 *
 * @param {{player?: string|null, rows?: object[]|null, httpStatus?: number,
 *          session?: object, local?: object, menuOpen?: boolean, loading?: boolean,
 *          search?: string}} opts
 */
function boot(opts = {}) {
  const vc = new VirtualConsole();                 // swallow jsdom's navigation warnings
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/index.html' + (opts.search || ''),
    runScripts: 'dangerously',
    virtualConsole: vc,
  });
  const w = dom.window;
  const calls = { goto: [], open: 0, preview: 0, dflt: 0, fetched: [], logs: [] };

  w.gameState = { keyPlayers: { player: { id: opts.player === undefined ? '1-194' : opts.player } } };
  w.menuPage = {
    open: () => { calls.open++; },
    router: {
      goto: (c, p) => { calls.goto.push(c + '.' + p); },
      enablePreviewMode: () => { calls.preview++; },
      enableDefaultMode: () => { calls.dflt++; },
    },
  };
  w.__TAURI__ = { core: { invoke: (cmd, args) => { calls.logs.push(args && args.msg); return Promise.resolve(); } } };
  w.fetch = (url) => {
    calls.fetched.push(url);
    const status = opts.httpStatus || 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ success: true, errors: [], data: opts.rows || [] }),
    });
  };

  for (const [k, v] of Object.entries(opts.session || {})) w.sessionStorage.setItem(k, v);
  if (opts.local) w.localStorage.setItem('structsTutorialChoice', JSON.stringify(opts.local));
  if (opts.menuOpen) w.document.getElementById('menu-page-layout').classList.remove('hidden');
  if (opts.loading) w.document.getElementById('loading-screen').classList.remove('hidden');

  w.eval(block);
  return { w, calls, dom };
}

/** The offer needs a poll tick, the history round-trip and the settle delay. */
const offerWait = () => sleep(2600);

// ── the decision matrix ─────────────────────────────────────────────────────
const cases = [
  {
    name: 'a player with no onboarding history at all is offered it',
    opts: { rows: [] },
    assert: (c) => check('  offered, as the webapp\'s own page, in preview mode',
      c.goto.join() === 'Auth.orientationEnd' && c.open === 1 && c.preview === 1, JSON.stringify(c.goto)),
  },
  {
    name: 'a player who completed the tutorial at signup is not asked again',
    opts: { rows: [{ step_key: 'tutorial.end.ftl_jump', kind: 'reached' }] },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.open === 0),
  },
  {
    name: 'a player who pressed Skip Tutorial at signup is not asked again',
    opts: { rows: [{ step_key: 'orientation.tutorial_offer', kind: 'skipped' }] },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.open === 0),
  },
  {
    name: 'an unreadable onboarding history offers nobody',
    opts: { rows: [], httpStatus: 401 },
    assert: (c) => check('  not offered, and the reason is logged',
      c.goto.length === 0 && c.logs.some((m) => /unavailable \(HTTP 401\)/.test(m || '')), c.logs.join(' | ')),
  },
  {
    name: 'a local answer is believed without asking the server',
    opts: { rows: [], local: { '1-194': { choice: 'declined' } } },
    assert: (c) => check('  not offered, and no request made',
      c.goto.length === 0 && c.fetched.length === 0, c.fetched.join()),
  },
  {
    name: 'three unfinished attempts stop the offer',
    opts: { rows: [], local: { '1-194': { choice: 'launched', launches: 3 } } },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.fetched.length === 0),
  },
  {
    name: 'one unfinished attempt still offers it (the tutorial has no other exit)',
    opts: { rows: [], local: { '1-194': { choice: 'launched', launches: 1 } } },
    assert: (c) => check('  offered', c.goto.join() === 'Auth.orientationEnd'),
  },
  {
    name: 'the running tutorial is never interrupted by its own offer',
    opts: { rows: [], session: { tutorialActive: '1' } },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.fetched.length === 0),
  },
  {
    name: 'coming back from a finished tutorial neither offers nor asks',
    opts: { rows: [], session: { tutorialExited: '1' } },
    assert: (c, w) => {
      check('  not offered', c.goto.length === 0 && c.fetched.length === 0);
      const store = JSON.parse(w.localStorage.getItem('structsTutorialChoice') || '{}');
      check('  recorded as completed, since exit() only runs at the FTL jump',
        store['1-194'] && store['1-194'].choice === 'completed', JSON.stringify(store));
    },
  },
  {
    name: 'signup in this tab has already made the offer',
    opts: { rows: [], session: { onboardingSessionId: 'e3b0c442-0000-4000-8000-000000000000' } },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.fetched.length === 0),
  },
  {
    name: 'the ?tutorial url param counts as the tutorial running',
    opts: { rows: [], search: '?tutorial' },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.fetched.length === 0),
  },
  {
    name: 'nobody is offered before they are logged in',
    opts: { rows: [], player: null },
    assert: (c) => check('  not offered', c.goto.length === 0 && c.fetched.length === 0),
  },
  {
    name: 'the offer never lands on top of an open menu',
    opts: { rows: [], menuOpen: true },
    assert: (c) => check('  not offered while the menu is up', c.goto.length === 0),
  },
  {
    name: 'the offer waits out the loading screen',
    opts: { rows: [], loading: true },
    assert: (c) => check('  not offered while still loading', c.goto.length === 0),
  },
];

const results = await Promise.all(cases.map(async (c) => {
  const { w, calls } = boot(c.opts);
  await offerWait();
  return { c, w, calls };
}));
for (const { c, w, calls } of results) {
  console.log(c.name);
  c.assert(calls, w);
}

// ── it waits for a quiet moment rather than giving up ──────────────────────
{
  console.log('a player who boots into a menu is offered it when they come out');
  const { w, calls } = boot({ rows: [], menuOpen: true });
  await offerWait();
  check('  nothing while the menu is up', calls.goto.length === 0);
  w.document.getElementById('menu-page-layout').classList.add('hidden');
  await until(() => calls.goto.length > 0);
  check('  offered once the player is back on the map', calls.goto.join() === 'Auth.orientationEnd');
}

// ── the player's answer is recorded ─────────────────────────────────────────
{
  console.log('the answer on the offer page is recorded for this player');
  const { w, calls } = boot({ rows: [] });
  await offerWait();
  w.document.getElementById('skipTutorial').click();
  const store = () => JSON.parse(w.localStorage.getItem('structsTutorialChoice') || '{}');
  check('  Skip Tutorial writes declined', store()['1-194'] && store()['1-194'].choice === 'declined', JSON.stringify(store()));
  check('  and the router is put back in default mode', calls.dflt === 1);

  w.localStorage.removeItem('structsTutorialChoice');
  w.document.getElementById('launchTutorial').click();
  check('  Launch Tutorial writes launched, with a count',
    store()['1-194'] && store()['1-194'].choice === 'launched' && store()['1-194'].launches === 1, JSON.stringify(store()));
}

// ── the Help menu entry point ──────────────────────────────────────────────
{
  console.log('Help ▸ Combat Training (menu.rs) goes through StructsTutorial');
  const { w } = boot({ rows: [], local: { '1-194': { choice: 'declined' } } });
  check('  the helper the menu calls exists', typeof w.StructsTutorial.launch === 'function');
  w.StructsTutorial.launch();
  check('  it raises the flag the webapp boots on', w.sessionStorage.getItem('tutorialActive') === '1');
  check('  and clears the finished flag', w.sessionStorage.getItem('tutorialExited') === null);
  const store = JSON.parse(w.localStorage.getItem('structsTutorialChoice') || '{}');
  check('  a menu launch is counted too, so the offer stops asking',
    store['1-194'].choice === 'launched' && store['1-194'].launches === 1, JSON.stringify(store));
  check('  forget() puts this player back in the offer', w.StructsTutorial.forget()
    && !JSON.parse(w.localStorage.getItem('structsTutorialChoice'))['1-194']);
}

// ── it asks the right endpoint ─────────────────────────────────────────────
{
  console.log('the history comes from the guild API');
  const { calls } = boot({ rows: [] });
  await offerWait();
  check('  GET /api/onboarding/player/<id>, relative so the Tauri proxy resolves it',
    calls.fetched.join() === '/api/onboarding/player/1-194', calls.fetched.join());
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
