// The Combat Training entry point (frontend/structs-config.js).
//
//   node scripts/harness-tests/tutorialentry.test.mjs
//
// The block is self-contained, so unlike the other structs-config checks these
// are FUNCTIONAL: the IIFE is sliced out of the file and run in jsdom against a
// stub game (gameState / menuPage), then driven through window.StructsTutorial.
//
// This used to test a re-offer of the tutorial that lived here. The webapp owns
// that now (TutorialMode.offerIfUndecided, webapp 3255fc77), so the first thing
// pinned below is the absence: this block must sit still until it is asked, or
// the desktop app and the game would offer Combat Training twice, over the same
// menu. What remains is the one path upstream has no equivalent of — Help ▸
// Combat Training (menu.rs) — and the session flags it mirrors by value.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(resolve(repo, 'frontend', 'structs-config.js'), 'utf8');

const START = '// ── Combat Training entry point';
const start = src.indexOf(START);
if (start < 0) { console.error('FAIL the Combat Training entry point block is gone'); process.exit(1); }
const end = src.indexOf('} else if (!window.__STRUCTS_CONFIG__)', start);
const block = src.slice(start, end);

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(25); }
}

const HTML = `<!doctype html><html><body>
  <div id="menu-page-layout" class="hidden"></div>
  <div id="loading-screen" class="hidden"></div>
</body></html>`;

/**
 * A stub game window with the block loaded.
 *
 * @param {{player?: string|null, energy?: object|null, session?: object,
 *          local?: object, noMenu?: boolean}} opts
 */
function boot(opts = {}) {
  const vc = new VirtualConsole();                 // swallow jsdom's navigation warnings
  const dom = new JSDOM(HTML, { url: 'http://localhost/index.html', runScripts: 'dangerously', virtualConsole: vc });
  const w = dom.window;
  const calls = { goto: [], open: 0, preview: 0, dflt: 0, fetched: [], logs: [], recorded: [], flushed: 0 };

  w.gameState = { keyPlayers: { player: {
    id: opts.player === undefined ? '1-194' : opts.player,
    player: opts.energy === undefined
      ? { load: '7', structs_load: 3, capacity: '12', connection_capacity: 0 }
      : opts.energy,
  } } };
  if (!opts.noMenu) {
    w.menuPage = {
      open: () => { calls.open++; },
      router: {
        goto: (c, p) => { calls.goto.push(c + '.' + p); },
        enablePreviewMode: () => { calls.preview++; },
        enableDefaultMode: () => { calls.dflt++; },
      },
    };
  }
  w.__TAURI__ = { core: { invoke: (cmd, args) => { calls.logs.push(args && args.msg); return Promise.resolve(); } } };
  if (!opts.noRecorder) {
    w.__STRUCTS_ONBOARDING__ = {
      startTutorialRun: (playerId, isReplay) => { calls.recorded.push([playerId, isReplay]); },
      flushNow: () => { calls.flushed++; },
    };
  }
  // Nothing here should ever reach the network; a call is a failure, not a stub.
  w.fetch = (url) => { calls.fetched.push(url); return Promise.reject(new Error('unexpected fetch')); };

  for (const [k, v] of Object.entries(opts.session || {})) w.sessionStorage.setItem(k, v);
  for (const [k, v] of Object.entries(opts.local || {})) w.localStorage.setItem(k, v);

  w.eval(block);
  return { w, calls, dom };
}

// ── it does nothing until it is asked ───────────────────────────────────────
// The regression guard for handing the offer back to the webapp: the old block
// polled every 500ms, asked the guild API for the player's onboarding history
// and opened the offer once the player settled on the map. All of that is the
// game's job now, and a second offer would fight it for the same menu.
{
  console.log('the block offers nothing of its own');
  const { calls } = boot({ local: {} });
  await sleep(3000);   // longer than the old poll + history round-trip + settle
  check('  no menu page is opened unasked', calls.goto.length === 0 && calls.open === 0, calls.goto.join());
  check('  the onboarding history is never fetched', calls.fetched.length === 0, calls.fetched.join());
  check('  nothing is written to localStorage',
    Object.keys({ ...calls }) && calls.goto.length === 0 && JSON.stringify(calls.fetched) === '[]');
}

// ── Help ▸ Combat Training ──────────────────────────────────────────────────
{
  console.log('Help ▸ Combat Training (menu.rs) goes through StructsTutorial');
  const { w, calls } = boot();
  check('  the helper the menu calls exists', typeof w.StructsTutorial.replay === 'function');
  check('  replay() opens the webapp\'s own confirmation, not a second launch path',
    w.StructsTutorial.replay() === true && calls.goto.join() === 'Account.startTutorial' && calls.open === 1,
    calls.goto.join());
  // Preview mode is what keeps the confirmation from becoming the restored page,
  // and it has to outlive it: walking on to the tutorial is another goto.
  check('  in preview mode, and still in it on the next page', calls.preview === 1 && calls.dflt === 0);
  const layout = w.document.getElementById('menu-page-layout');
  layout.classList.remove('hidden');
  layout.classList.add('hidden');
  await until(() => calls.dflt > 0, 2000);
  check('  back to default mode once the player is on the map again', calls.dflt === 1);
}

// ── the direct launch, for a window with no menu wired up ───────────────────
{
  console.log('launch() mirrors TutorialMode.launch(true) by value');
  const { w, calls } = boot({ session: { tutorialExited: 'completed' } });
  w.StructsTutorial.launch();
  check('  raises the flag the webapp boots the simulation on',
    w.sessionStorage.getItem('tutorialActive') === '1');
  // A menu launch is always a replay: the player is in the game already, so the
  // run ends by handing them back to it rather than through the FTL jump that
  // bridges a new player in.
  check('  marks the run a replay, so it does not end in the FTL jump',
    w.sessionStorage.getItem('tutorialReplay') === '1');
  check('  clears a stale exit flag', w.sessionStorage.getItem('tutorialExited') === null);
  check('  and hands the player\'s own energy to the simulation',
    w.sessionStorage.getItem('tutorialPlayerEnergy')
      === JSON.stringify({ load: 7, structs_load: 3, capacity: 12, connection_capacity: 0 }),
    w.sessionStorage.getItem('tutorialPlayerEnergy'));
  check('  the launch is logged for the Tauri console',
    calls.logs.some((m) => m && m.indexOf('launched Combat Training') > -1), calls.logs.join('|'));
  // Without this the run records NOTHING: the recorder returns early with no
  // session id, so every step of the tutorial is dropped (webapp d8dcd64e).
  check('  the run\'s telemetry session is started, as a replay, with the real player',
    JSON.stringify(calls.recorded) === JSON.stringify([['1-194', true]]), JSON.stringify(calls.recorded));
  check('  and flushed, so the first step leaves before the reload', calls.flushed === 1);
}
{
  console.log('launch() when the recorder was not exposed');
  const { w, calls } = boot({ noRecorder: true });
  // An older bundle, or a patch that stopped applying: losing telemetry must
  // not cost the player the tutorial.
  w.StructsTutorial.launch();
  check('  still starts the tutorial', w.sessionStorage.getItem('tutorialActive') === '1'
    && w.sessionStorage.getItem('tutorialReplay') === '1');
  check('  and says so rather than failing silently',
    calls.logs.some((m) => m && m.indexOf('launched Combat Training') > -1));
}
{
  console.log('launch() with no energy figures to pass on');
  const { w } = boot({ energy: null, session: { tutorialPlayerEnergy: '{"load":99}' } });
  w.StructsTutorial.launch();
  // Leaving a previous player's figures behind would show them in the
  // simulation; TutorialWorld falls back to its own defaults when the key is gone.
  check('  drops a stale hand-off rather than passing on the wrong numbers',
    w.sessionStorage.getItem('tutorialPlayerEnergy') === null);
  check('  and still starts', w.sessionStorage.getItem('tutorialActive') === '1');
}
{
  console.log('before sign-in the menu plays the simulation, it does not open a page');
  // Since webapp faa99d98 a menu page opened before login has NO close button
  // (there is no game behind it), so opening the Account page here would strand
  // the player with no way back to the sign-in screen.
  const { w, calls } = boot({ player: null });
  check('  replay() refuses, and opens nothing', w.StructsTutorial.replay() === false
    && calls.goto.length === 0 && calls.open === 0, calls.goto.join());
  w.StructsTutorial.launch();
  check('  so the menu\'s `replay() || launch()` reaches Combat Training anyway',
    w.sessionStorage.getItem('tutorialActive') === '1');
}
{
  console.log('replay() falls back when the game menu is not wired up');
  const { w } = boot({ noMenu: true });
  check('  replay() refuses rather than throwing', w.StructsTutorial.replay() === false);
  // menu.rs relies on this: `replay() || launch()`.
  w.StructsTutorial.launch();
  check('  so the menu\'s `replay() || launch()` still reaches the tutorial',
    w.sessionStorage.getItem('tutorialActive') === '1');
}

// ── reading and clearing the webapp's own answer ────────────────────────────
{
  console.log('status() reports the answer the webapp will act on');
  const { w } = boot({ local: {}, session: { tutorialActive: '1', tutorialReplay: '1' } });
  let s = w.StructsTutorial.status();
  check('  an install that has not answered is undecided, so the game will ask',
    s.decided === false && s.startedTutorial === false && s.skippedTutorial === false, JSON.stringify(s));
  check('  and the live session is reported', s.player === '1-194' && s.inTutorial === true && s.isReplay === true);

  const started = boot({ local: { tutorialStarted: '1' } }).w;
  check('  a started tutorial is an answer', started.StructsTutorial.status().decided === true
    && started.StructsTutorial.status().startedTutorial === true);
  const skipped = boot({ local: { tutorialSkipped: '1' } }).w;
  check('  so is a skipped one', skipped.StructsTutorial.status().decided === true
    && skipped.StructsTutorial.status().skippedTutorial === true);
}
{
  console.log('forget() hands the player back to the webapp\'s offer');
  const { w } = boot({ local: { tutorialStarted: '1', tutorialSkipped: '1' } });
  check('  forget() reports success', w.StructsTutorial.forget() === true);
  check('  both of upstream\'s flags are cleared, so offerIfUndecided asks again',
    w.localStorage.getItem('tutorialStarted') === null
      && w.localStorage.getItem('tutorialSkipped') === null);
  check('  and status() agrees', w.StructsTutorial.status().decided === false);
}
{
  console.log('offer() shows the game\'s own Launch/Skip page on demand');
  const { w, calls } = boot({ local: { tutorialSkipped: '1' } });
  check('  even for an install that already answered',
    w.StructsTutorial.offer() === true && calls.goto.join() === 'Auth.orientationEnd', calls.goto.join());
  // Upstream's own offer is NOT in preview mode, which leaves the orientation
  // page as the restored one. Ours must not add a second way into that.
  check('  in preview mode, so it never becomes the restored page', calls.preview === 1);
}

// ── the keys it mirrors are the ones the game declares ──────────────────────
// scripts/apply-patches.sh fails the build on these too, against the webapp
// source; this catches the other direction, a typo on our side.
{
  console.log('the mirrored session keys match TutorialMode');
  const tut = resolve(repo, 'structs-webapp', 'src', 'js', 'tutorial', 'TutorialMode.js');
  let game = '';
  try { game = readFileSync(tut, 'utf8'); } catch (e) {}
  if (!game) {
    check('  TutorialMode.js is readable', false, tut + ' is missing (submodule not checked out?)');
  } else {
    for (const [name, key] of [['active', 'tutorialActive'], ['exited', 'tutorialExited'],
      ['replay', 'tutorialReplay'], ['energy', 'tutorialPlayerEnergy'],
      ['started', 'tutorialStarted'], ['skipped', 'tutorialSkipped']]) {
      check('  ' + name + ' key \'' + key + '\' is declared by the game',
        game.indexOf("'" + key + "'") > -1 && block.indexOf("'" + key + "'") > -1);
    }
    check('  and the game still owns the offer this block stepped back from',
      game.indexOf('static offerIfUndecided()') > -1);
    const tel = resolve(repo, 'structs-webapp', 'src', 'js', 'telemetry', 'OnboardingTelemetry.js');
    let rec = '';
    try { rec = readFileSync(tel, 'utf8'); } catch (e) {}
    check('  the recorder call the launch forwards still exists',
      rec.indexOf('startTutorialRun(playerId, isReplay = false)') > -1);
    check('  and a replay is still recorded under its own content version',
      rec.indexOf("ONBOARDING_REPLAY_CONTENT_VERSION = 'tutorial-4-replay'") > -1);
  }
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
