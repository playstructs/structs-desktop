// Behaviour-profile editor checks against the static harness — no Tauri, no
// rebuild. The build-order section is where a mistake is most expensive: fleet
// slots free only when a hull is DESTROYED, so a loadout written wrong here
// persists for weeks. These assertions pin the arithmetic that makes it legible
// (slot pips, per-ambit fill) and the rules the picker enforces.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && npm install && npm run test:profiles)
//
// jsdom does NO layout: everything here is structural.
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
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 30));
  }
}

const dom = await JSDOM.fromFile(harness, {
  url: pathToFileURL(harness).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});
const w = dom.window;
const D = w.document;
const q = (s) => D.querySelectorAll(s);
const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();

await until(() => w.Board && w.Board.pages && w.Board.pages.config);
w.Board.pages.config.onEnter({}, 'profiles');
await until(() => q('#profiles-card .sui-result-row').length);

const cards = [...q('#profiles-card .sui-result-row')];
check('every profile gets a summary row', cards.length === 4, 'got ' + cards.length);

// ── The editable fork ───────────────────────────────────────────────────────
cards.find((r) => /vulture/.test(text(r))).click();
await until(() => q('.prof-builds .sui-result-row').length);

const rows = () => [...q('.prof-builds .sui-result-row')];
const pipsOf = (r) => ({
  total: r.querySelectorAll('.prof-pip').length,
  taken: r.querySelectorAll('.prof-pip.is-taken').length,
  mine: r.querySelectorAll('.prof-pip.is-mine').length,
  live: r.querySelectorAll('.prof-pip.is-clickable').length,
});

check('one build row per loadout entry', rows().length === 5, 'got ' + rows().length);
check('rows are numbered in priority order',
  rows().map((r) => text(r.querySelector('.prof-pri'))).join('') === '12345');

// Struct art comes from the webapp's own image set, addressed RELATIVELY so
// the same markup works under the Tauri asset root and under /board over HTTP.
const art = [...q('.prof-art img')].map((i) => i.getAttribute('src'));
check('art is relative, never rooted', art.length && art.every((s) => !s.startsWith('/')), art[0]);
check('the abbreviated slugs are used, not the kebab-cased name',
  art.some((s) => s.includes('/cmd-ship/')), JSON.stringify(art));

// The pips are the whole point of the redesign: `want` is a claim on four
// shared chain slots, so each row shows what earlier rows already took.
const [cmd, ma, tank, pf] = rows();
check('a one-per-player type shows a single locked pip',
  pipsOf(cmd).total === 1 && pipsOf(cmd).live === 0, JSON.stringify(pipsOf(cmd)));
check('a later row sees the slots earlier rows claimed',
  pipsOf(ma).taken === 1 && pipsOf(ma).mine === 2, JSON.stringify(pipsOf(ma)));
check('a full ambit offers no room to grow',
  pipsOf(tank).taken === 3 && pipsOf(tank).live === 1, JSON.stringify(pipsOf(tank)));

// Clicking pip N sets want to N and repaints from the write, not optimistically.
pf.querySelectorAll('.prof-pip.is-clickable')[3].click();
await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set'));
const lastSet = () => [...w.__HARNESS_CALLS__].filter((c) => c.cmd === 'mcp_config_set').pop();
const wrote = lastSet().args.payload.profile.loadout.find((e) => e.type_name === 'Pursuit Fighter');
check('clicking the 4th pip writes want: 4', wrote && wrote.want === 4, JSON.stringify(wrote));
await until(() => pipsOf(rows()[3]).mine === 4);
check('the open drawer repaints from the write', pipsOf(rows()[3]).mine === 4);

// ── The picker ──────────────────────────────────────────────────────────────
D.getElementById('prof-add-vulture').click();
await until(() => q('.prof-picker .sui-result-row').length);
const picks = [...q('.prof-picker .sui-result-row')];
const enabled = picks.filter((r) => !r.classList.contains('is-disabled'));

check('every legal (type, ambit) pair is offered', picks.length === 28, 'got ' + picks.length);
check('ambits are grouped, water first within fleet',
  /water/.test(text(picks[0])) && /fleet/.test(text(picks[0])), text(picks[0]));
// A second Command Ship anywhere is a row auto_build would skip forever.
const cmdRows = picks.filter((r) => /^Command Ship/.test(text(r)));
check('a one-per-player type is spent in EVERY ambit once owned',
  cmdRows.length === 4 && cmdRows.every((r) => r.classList.contains('is-disabled')),
  cmdRows.map(text).join(' | '));
check('a full ambit is shown-but-disabled, never hidden',
  picks.some((r) => r.classList.contains('is-disabled') && /land slots/.test(text(r))));
check('draws share one unit so they compare',
  picks.filter((r) => /KW/.test(text(r))).length > 0 && !/\d+W\b/.test(text(picks[1])), text(picks[1]));

const before = rows().length;
enabled[0].click();
await until(() => rows().length === before + 1);
const added = lastSet().args.payload.profile.loadout.slice(-1)[0];
check('picking appends one row with want: 1', added && added.want === 1, JSON.stringify(added));
check('target and ambit come from the catalog, never typed',
  added && added.target === 'fleet' && ['water', 'land', 'air', 'space'].includes(added.ambit));
check('the picker closes on pick', !D.querySelector('.prof-picker'));

// ── A built-in is read-only all the way down ────────────────────────────────
[...q('#profiles-card .sui-result-row')].find((r) => /bait/.test(text(r))).click();
await until(() => q('.prof-builds .sui-result-row').length === 2);
check('no Add button on a built-in', !D.querySelector('[id^=prof-add-]'));
check('no live pips on a built-in', q('.prof-pip.is-clickable').length === 0);
check('no reorder controls on a built-in', q('.prof-builds .prof-actions a').length === 0);
check('no rename fields on a built-in', q('#sui-offcanvas input[type=text]').length === 0);

w.close();
console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
