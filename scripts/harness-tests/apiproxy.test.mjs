// The guild-URL resolution the app wraps around fetch and sendBeacon
// (frontend/structs-config.js).
//
//   node scripts/harness-tests/apiproxy.test.mjs
//
// The webapp is written for a page served BY the guild, so it calls '/api/...'
// relative. In the app the page is tauri://localhost, so this block resolves
// those against the guild origin. fetch has always been wrapped; sendBeacon was
// not, and the Beacon API throws a TypeError rather than fail quietly on a
// scheme that is not http(s) — which killed the Launch Tutorial button, because
// the webapp's telemetry beacons from inside TutorialMode.launch() before its
// reload. These are FUNCTIONAL: the block is sliced out and run in jsdom.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(resolve(repo, 'frontend', 'structs-config.js'), 'utf8');

const START = 'if (window.__STRUCTS_CONFIG__ && window.__TAURI__) {';
const END = '  // ── StructsEvents:';
const start = src.indexOf(START);
const end = src.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error('FAIL the guild config block is gone');
  process.exit(1);
}
const block = src.slice(start, end) + '\n}\n';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

/**
 * A stub app window with the block loaded.
 *
 * @param {{guildApi?: string|null, beacon?: function|null}} opts
 */
function boot(opts = {}) {
  const vc = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/index.html', runScripts: 'dangerously', virtualConsole: vc,
  });
  const w = dom.window;
  const calls = { fetched: [], beaconed: [] };

  w.__STRUCTS_CONFIG__ = opts.guildApi === null ? {} : { guildApi: opts.guildApi || 'https://guild.example/api/' };
  w.__TAURI__ = { core: { invoke: () => Promise.resolve() } };
  w.fetch = (input, init) => {
    calls.fetched.push(typeof input === 'string' ? input : input.url);
    return Promise.resolve({ status: 200 });
  };
  if (opts.beacon !== null) {
    w.navigator.sendBeacon = opts.beacon || ((url, data) => { calls.beaconed.push([url, data]); return true; });
  }

  w.eval(block);
  return { w, calls };
}

// ── the URL a beacon is sent to ─────────────────────────────────────────────

{
  console.log('a relative beacon goes to the guild, like a relative fetch');
  const { w, calls } = boot();
  const ok = w.navigator.sendBeacon('/api/onboarding/events', 'payload');
  check('  the guild origin is prepended', calls.beaconed[0]?.[0] === 'https://guild.example/api/onboarding/events',
    JSON.stringify(calls.beaconed[0]?.[0]));
  check('  the body is passed through untouched', calls.beaconed[0]?.[1] === 'payload');
  check('  and the native answer is returned', ok === true, String(ok));

  w.fetch('/api/player/1-194');
  check('  fetch resolves the same way', calls.fetched[0] === 'https://guild.example/api/player/1-194', calls.fetched[0]);
}

// ── only guild paths are sent to the guild ──────────────────────────────────
//
// Everything else absolute is one of the app's own bundled files. The game
// fetches '/img/focus/target-selected-*.gif' for its bytes, to replay the
// burst that confirms a picked target from an object URL; sent to the guild it
// comes back through proxy_fetch, which decodes every body as UTF-8 text, so
// the blob is mangled and the burst never plays.

{
  console.log("the app's own files stay on the app's own origin");
  const { w, calls } = boot();
  w.fetch('/img/focus/target-selected-enemy.gif');
  check('  a bundled asset is not sent to the guild', calls.fetched[0] === '/img/focus/target-selected-enemy.gif',
    calls.fetched[0]);

  w.navigator.sendBeacon('/img/focus/target-selected-enemy.gif', 'payload');
  check('  and neither is a beacon to one', calls.beaconed[0]?.[0] === '/img/focus/target-selected-enemy.gif',
    calls.beaconed[0]?.[0]);

  w.fetch('/api/onboarding/events', { method: 'POST' });
  check('  while a guild path still goes to the guild',
    calls.fetched[1] === 'https://guild.example/api/onboarding/events', calls.fetched[1]);
}

{
  console.log('an absolute beacon is left alone');
  const { w, calls } = boot();
  w.navigator.sendBeacon('https://elsewhere.example/collect', 'payload');
  check('  the URL is untouched', calls.beaconed[0]?.[0] === 'https://elsewhere.example/collect', calls.beaconed[0]?.[0]);
}

// ── a beacon must never throw at its caller ─────────────────────────────────
//
// This is the Launch Tutorial bug: TutorialMode.launch() flushes telemetry, then
// sets the session flag, then reloads. A throw from the flush means no flag and
// no reload, so the button does nothing at all.

{
  console.log('a refused beacon is answered, not thrown');
  // What WebKit and Blink do for a scheme that is not http(s).
  const refuse = () => { throw new TypeError('Beacons are only supported over HTTP(S).'); };
  const { w } = boot({ beacon: refuse });
  let threw = null;
  let answer;
  try { answer = w.navigator.sendBeacon('/api/onboarding/events', 'payload'); } catch (e) { threw = e; }
  check('  the caller sees no exception', threw === null, threw && threw.message);
  check('  the answer is false, so the events stay queued', answer === false, String(answer));
}

{
  console.log('a launch survives a telemetry flush that cannot send');
  // The shape of TutorialMode.launch(): flush, then the flag, then the reload.
  const { w } = boot({ beacon: () => { throw new TypeError('Beacons are only supported over HTTP(S).'); } });
  let reloaded = false;
  const launch = () => {
    if (w.navigator.sendBeacon) w.navigator.sendBeacon('/api/onboarding/events', 'payload');
    w.sessionStorage.setItem('tutorialActive', '1');
    reloaded = true;
  };
  launch();
  check('  the session flag is set', w.sessionStorage.getItem('tutorialActive') === '1');
  check('  and the reload is reached', reloaded);
}

// ── the block only acts when it has a guild ─────────────────────────────────

{
  console.log('without a guild API nothing is wrapped');
  const { w, calls } = boot({ guildApi: null });
  w.navigator.sendBeacon('/api/onboarding/events', 'payload');
  check('  the beacon is the native one', calls.beaconed[0]?.[0] === '/api/onboarding/events', calls.beaconed[0]?.[0]);
}

{
  console.log('a runtime without sendBeacon is left alone');
  const { w } = boot({ beacon: null });
  check('  nothing is defined in its place', w.navigator.sendBeacon === undefined, typeof w.navigator.sendBeacon);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
