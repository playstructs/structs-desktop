// The Onboarding card (board-terminal-onboarding.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/onboarding.test.mjs
//
// The brief this pins: how far new players get through signup and Combat
// Training, how long it takes, where they quit or skip, and what players do
// afterwards — over every guild. Every page reads the same filters
// (interface, guild, active/inactive) and can compare by one of them.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

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
await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add && w.Board.Terminal.onboarding);
const T = w.Board.Terminal;

// ── ⌘K ──
check('ONBOARDING, TELEMETRY, FUNNEL and SIGNUPS open the card', ['ONBOARDING', 'TELEMETRY', 'FUNNEL', 'SIGNUPS'].every((x) => T.parse(x) && T.parse(x).type === 'onboarding'));
const row = T.suggestFor('').find((o) => /\bONBOARDING\b/.test(String(o.words || '')));
check('filed under Explore', row && row.group === 'Explore', JSON.stringify(row || null));

// ── Pure pieces ──
const O = T.onboarding;
check('a step key reads as words, without its phase', O.stepLabel('tutorial.first_attack.choose_rail_gun') === 'First attack · Choose rail gun' && O.stepLabel('signup.recovery_key_create') === 'Recovery key create');
check('percentages: whole above 10%, one decimal below, a dash for nothing', O.pct(0.364) === '36%' && O.pct(0.029) === '2.9%' && O.pct(null) === '—' && O.pct(1) === '100%');
check('the flagged steps are the largest, never a zero or a null', JSON.stringify(O.topKeys([{ key: 'a', d: 3 }, { key: 'b', d: null }, { key: 'c', d: 9 }, { key: 'e', d: 0 }], (r) => r.d, 3)) === '["c","a"]');
check('count buckets read as whole ranges, the last open', O.bucketLabel({ lo: 0, hi: 0 }, 'count') === '0' && O.bucketLabel({ lo: 10, hi: 100 }, 'count') === '10–99' && /^≥ /.test(O.bucketLabel({ lo: 1e5, hi: null }, 'count')));
check('refined alpha arrives in grams and is drawn on the alpha ladder', O.fmtKind('alpha', 2) === w.Board.helpers.fmtAlpha(2e6));
const args = O.argsOf({ iface: 'structs-webapp', activity: 'inactive', compare: 'guild', active: '30', idle: '72' });
check('the card asks with its filters', args.filters.interface === 'structs-webapp' && args.filters.activity === 'inactive' && args.filters.compare === 'guild' && args.activeDays === 30 && args.idleHours === 72, JSON.stringify(args));

// ── The card ──
const calls = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_onboarding');
const card = T.add('onboarding', {}, 3);
const id = (card && card.id) || 'onboarding-1';
const host = await until(() => {
  const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
  return c && c.querySelector('.ob-hud') ? c : null;
});
check('the card renders its readouts', host !== null);
if (host) {
  const tiles = [...host.querySelectorAll('.ob-hud .ob-tile')].map((t) => [...t.children].map(text).join(' ').toUpperCase());
  check('OVERVIEW: players, active, churn and signup drop-off', /^9,600 PLAYERS$/.test(tiles[0]) && /ACTIVE 42%/.test(tiles[1]) && /^61% CHURN/.test(tiles[2]) && /^49% SIGNUP DROP-OFF 2,140 STARTED$/.test(tiles[3]), JSON.stringify(tiles));
  check('OVERVIEW: finished against not', tiles.some((t) => /^402 FINISHED 37%$/.test(t)) && tiles.some((t) => /^472 QUIT 43%$/.test(t)), JSON.stringify(tiles));
  check('one read, asked with the default windows and no filter', calls().length >= 1 && calls()[0].args.idleHours === 24 && calls()[0].args.activeDays === 7 && !calls()[0].args.filters.compare, JSON.stringify(calls()[0] || null));
  check('four filter controls, the windows, and the version', host.querySelectorAll('.ob-controls select').length === 7);

  const go = (label) => { [...host.querySelectorAll('.ob .sui-screen-nav-item')].find((a) => text(a) === label).click(); };
  const before = calls().length;
  go('Signup');
  const steps = [...host.querySelectorAll('.ob-funnel .ob-row[data-step]')];
  check('SIGNUP lists every step', steps.some((r) => r.dataset.step === 'signup.connecting') && steps.some((r) => r.dataset.step === 'signup.employee_record'), steps.length);
  const create = host.querySelector('.ob-funnel .ob-row[data-step="signup.recovery_key_create"]');
  check('the step most players quit at is flagged, by count and by rate', create && create.querySelectorAll('.is-bad').length === 2, create && text(create));
  check('drop-off individually and cumulatively', create && /\b16%/.test(text(create.children[6])) && /%$/.test(text(create.children[4])), create && text(create));
  const last = host.querySelector('.ob-funnel .ob-row[data-step="signup.employee_record"]');
  check('a last step has no quit figure, a dash and not a zero', last && text(last.children[5]) === '—', last && text(last.children[5]));
  check('views switch from the last read, without asking again', calls().length === before);

  go('Tutorial');
  check('TUTORIAL has the outcome strip', host.querySelectorAll('.ob-stack .ob-seg').length === 4);
  const offer = host.querySelector('.ob-funnel-skips .ob-row[data-step="orientation.tutorial_offer"]');
  check('TUTORIAL: skips per step and so far', offer && text(offer.children[7]) === '182' && text(offer.children[8]) === '17%' && text(offer.children[9]) === '17%', offer && text(offer));

  go('Players');
  const blocks = [...host.querySelectorAll('.ob-view .ob-block')];
  check('PLAYERS: five distributions', blocks.length === 5 && /Ore mined/.test(text(blocks[0])) && /Raids won/.test(text(blocks[4])), blocks.map((b) => text(b.firstChild)).join(' | '));
  check('a distribution has its histogram', blocks[0] && blocks[0].querySelectorAll('.ob-hist .ob-row').length === 10);

  go('Retention');
  check('RETENTION: churn and the play length of inactive players', /Churn/.test(text(host.querySelector('.ob-view'))) && /Play length of inactive players after signup/.test(text(host.querySelector('.ob-view'))));

  go('Timing');
  check('TIMING ranks steps by median time', host.querySelector('.ob-slow .ob-row[data-step]').dataset.step === 'signup.recovery_key_create');
  go('Guilds');
  const g = [...host.querySelectorAll('.ob-guilds .ob-row[data-guild]')];
  check('GUILDS lists every guild with its players, the one without an API quiet', g.length === 3 && g.find((r) => r.dataset.guild === '0-2').classList.contains('is-quiet') && /^72$/.test(text(g.find((r) => r.dataset.guild === '0-2').children[1])));
  go('Recent');
  const p = host.querySelector('.ob-recent .ob-row[data-player="1-9580"]');
  check('RECENT shows outcome and time in the tutorial', p && /Finished/.test(text(p)) && /13m/.test(text(p)), text(p));

  // ── Compare ──
  const sel = () => [...host.querySelectorAll('.ob-controls select')];
  sel()[3].value = 'activity'; sel()[3].dispatchEvent(new w.Event('change'));
  const asked = await until(() => calls().find((c) => c.args.filters.compare === 'activity'));
  check('Compare is a param and re-reads', !!asked);
  await until(() => host.querySelector('.ob-compare'));
  go('Overview');
  const head = [...host.querySelectorAll('.ob-compare .ob-head .ob-c')].map(text);
  check('OVERVIEW compares one column per segment', head.join('|') === '|Active|Inactive', head.join('|'));
  go('Signup');
  check('signup cannot be split by activity, and says so', /only known once signup finishes/.test(text(host.querySelector('.ob-view'))));
  go('Players');
  const segRows = [...host.querySelectorAll('.ob-dist .ob-row[data-seg]')].map((r) => r.dataset.seg);
  check('PLAYERS compares a row per segment', segRows.slice(0, 2).join(',') === 'active,inactive', segRows.join(','));

  sel()[3].value = 'guild'; sel()[3].dispatchEvent(new w.Event('change'));
  await until(() => calls().find((c) => c.args.filters.compare === 'guild'));
  await until(() => /OH/.test(text(host.querySelector('.ob-dist'))));
  go('Tutorial');
  const th = text(host.querySelectorAll('.ob-compare')[1].querySelector('.ob-head'));
  check('TUTORIAL compares kept, drop and skip per guild', /OH · Kept/.test(th) && /SN\.C · Kept/.test(th) && /Skip/.test(th), th);

  sel()[0].value = 'structs-webapp'; sel()[0].dispatchEvent(new w.Event('change'));
  const filtered = await until(() => calls().find((c) => c.args.filters.interface === 'structs-webapp'));
  check('a filter is a param too', !!filtered);
}

// ── Wiring ──
check('the command is registered with Tauri', /onboarding::terminal_onboarding/.test(read('src-tauri/src/main.rs')));
check('and reachable from the web board, filters and all', /"terminal_onboarding"/.test(read('src-tauri/src/mcp/web_board.rs')) && /body\.get\("filters"\)/.test(read('src-tauri/src/mcp/web_board.rs')));
check('the desktop build reports its own interface, guarded against upstream drift',
  /ONBOARDING_INTERFACE_NAME = 'structs-desktop'/.test(read('scripts/apply-patches.sh')) && /verify_patched [^\n]*OnboardingTelemetry\.js/.test(read('scripts/apply-patches.sh')));
check('board.html loads the script and the sheet', /board-terminal-onboarding\.js/.test(read('frontend/board.html')) && /onboarding\.css/.test(read('frontend/board.html')));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
