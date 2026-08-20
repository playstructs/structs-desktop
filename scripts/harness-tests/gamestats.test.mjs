// Game Stats page checks against the static harness — no Tauri, no rebuild.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && npm install && npm test)
//
// jsdom does NO layout: these assertions are structural (what rendered, what
// was invoked, what the synthetic events changed). Overflow/column behaviour
// is checked once in a real browser before a release build.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) {
  console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

function load(query) {
  return JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href + query,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
}

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Scenario 1: default fixture, solo gamestats ─────────────────────────────
{
  const dom = await load('?view=gamestats');
  const w = dom.window;
  await until(() => w.document.getElementById('gamestats-body')?.querySelector('.fstat'));
  const calls = (w.__HARNESS_CALLS__ || []).map((c) => c.cmd);
  const snapshotCalls = calls.filter((c) => c === 'mcp_game_stats_snapshot').length;
  check('pull-on-load: exactly one snapshot invoke', snapshotCalls === 1, 'got ' + snapshotCalls);
  check('solo attribute set', w.document.documentElement.getAttribute('data-solo') === 'gamestats');
  check('subnav is empty in solo mode', w.document.querySelectorAll('#board-subnav a').length === 0);

  const body = w.document.getElementById('gamestats-body');
  const rows = body.querySelectorAll('.sui-result-rows')[0];
  check('player leaderboard renders 25 rows', rows && rows.children.length === 25,
    'got ' + (rows ? rows.children.length : 'none'));
  const first = rows.children[0];
  check('rank + name + tag on row 1', /#1\s/.test(first.textContent) && /\[G\d\]/.test(first.textContent),
    first.textContent.slice(0, 60));
  check('string numerics format (players tile)', body.textContent.includes('2,412'));
  check('alpha value formatted on the game ladder', /42\.5Kg/.test(first.textContent),
    first.textContent.slice(0, 80));
  const guilds = body.querySelectorAll('.sui-result-rows')[1];
  check('guild leaderboard renders', guilds && guilds.children.length === 8,
    'got ' + (guilds ? guilds.children.length : 'none'));
  check('guild order is the directory order', /SN Corp/.test(guilds.children[0].textContent));
  check('sparklines render', body.querySelectorAll('#gs-trends svg path').length >= 5);
  const energyHeader = [...body.querySelectorAll('.sui-data-card-header')].some((h) => h.textContent === 'ENERGY GRID');
  check('energy grid card renders', energyHeader);
  check('energy tiles formatted on the watts ladder', /Structs Draw/.test(body.textContent) && /Utilization/.test(body.textContent));
  check('per-guild energy bars render', body.textContent.includes('SN Corp') && body.querySelectorAll('.bar').length >= 8);
  const universe = [...body.querySelectorAll('.sui-data-card-header')].some((h) => h.textContent === 'UNIVERSE');
  check('totals live in a titled UNIVERSE card', universe);
  check('ore is split stored vs in-ground', /Stored Ore/.test(body.textContent) && /Ore In Ground/.test(body.textContent));

  // Synthetic block tick: height updates, no new invoke, series grows.
  const before = w.__HARNESS_CALLS__.length;
  const svgBefore = body.querySelector('#gs-trends svg path').getAttribute('d');
  w.__HARNESS_EMIT__('game-stats-update', { tier: 'block', height: 4300001,
    point: { height: 4300001, events: 99, combat: 1, tx: 2, raids: 1, structs: 6041, fuel: 1 } });
  const blockTile = body.querySelector('.fstat .fstat-v');
  check('block tick bumps header height', blockTile.textContent === '4,300,001', blockTile.textContent);
  check('block tick causes no invoke', w.__HARNESS_CALLS__.length === before);
  check('block tick extends the sparkline', body.querySelector('#gs-trends svg path').getAttribute('d') !== svgBefore);

  // Raw grass fallback path.
  w.__HARNESS_EMIT__('grass-event', { category: 'block', subject: 'consensus', detail: { height: 4300002 } });
  check('grass block tick also bumps height', blockTile.textContent === '4,300,002', blockTile.textContent);

  // Sweep push: full re-render from the pushed snapshot, throttled.
  const snap = JSON.parse(JSON.stringify(await w.__TAURI__.core.invoke('mcp_game_stats_snapshot')));
  snap.totals.players = '31337';
  // Keep the pull fixture in step with the push: the page's 30s cadence
  // re-pulls the snapshot, and in the real app pull and push read the same
  // Rust cache — a harness where they disagree flakes this check whenever
  // the cadence timer lands inside the poll window.
  w.__HARNESS_FIXTURES__.mcp_game_stats_snapshot = snap;
  w.__HARNESS_EMIT__('game-stats-update', { tier: 'fast', snapshot: snap });
  w.__HARNESS_EMIT__('game-stats-update', { tier: 'fast', snapshot: snap });
  const rerendered = await until(() => body.textContent.includes('31,337'), 5000);
  check('sweep push re-renders totals', !!rerendered);
  w.close();
}

// ── Scenario 2: unauthenticated ─────────────────────────────────────────────
{
  const dom = await load('?view=gamestats&fixture=unauth');
  const w = dom.window;
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_game_stats_snapshot'));
  await until(() => w.document.getElementById('gamestats-body')?.textContent.includes('Guild API'));
  const body = w.document.getElementById('gamestats-body');
  check('unauth shows the login state block', body.textContent.includes('log in to Structs first'));
  check('unauth renders no leaderboards', body.querySelectorAll('.sui-result-row').length === 0);
  w.close();
}

// ── Scenario 3: Team Ops chrome untouched ───────────────────────────────────
{
  const dom = await load('');
  const w = dom.window;
  await until(() => w.Board && w.Board.current);
  const subnav = [...w.document.querySelectorAll('#board-subnav a')].map((a) => a.textContent);
  check('hidden Universe section absent from Command subnav',
    subnav.length === 2 && !subnav.includes('Universe'), JSON.stringify(subnav));
  check('gamestats page stays hidden on the main board',
    w.document.getElementById('page-gamestats').hidden === true);
  w.close();
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
