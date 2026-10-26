// The Onboarding card (board-terminal-onboarding.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/onboarding.test.mjs
//
// The brief this pins: how far new players get through signup and Combat
// Training, how long each part takes, and where they stop — summed over every
// guild. One read (`terminal_onboarding`); the views switch from it.
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
  check('started, signed up with its rate, finished with its rate', tiles[0] === '2,140 STARTED' && /^1,091 SIGNED UP 51%$/.test(tiles[1]) && /^402 FINISHED 36%$/.test(tiles[3]), JSON.stringify(tiles));
  check('median signup and tutorial times', tiles.some((t) => /^4M SIGNUP MEDIAN$/.test(t)) && tiles.some((t) => /^12M TUTORIAL MEDIAN$/.test(t)), JSON.stringify(tiles));
  check('one read, asked with the default quit window', calls().length >= 1 && calls()[0].args.idleHours === 24, JSON.stringify(calls()[0] || null));

  const steps = [...host.querySelectorAll('.ob-funnel .ob-row[data-step]')];
  check('the funnel lists both phases step by step', steps.some((r) => r.dataset.step === 'signup.connecting') && steps.some((r) => r.dataset.step === 'tutorial.end.ftl_jump'), steps.length);
  const worstSignup = host.querySelector('.ob-funnel .ob-row[data-step="signup.recovery_key_create"] .is-bad');
  check('the step most players quit at is flagged', worstSignup && text(worstSignup) === '244', text(worstSignup));
  const slow = host.querySelector('.ob-funnel .ob-row[data-step="signup.recovery_key_create"] .is-slow');
  check('the slowest step is flagged', slow && text(slow) === '1m', text(slow));
  const last = host.querySelector('.ob-funnel .ob-row[data-step="signup.employee_record"]');
  check('a last step has no quit figure, a dash and not a zero', last && text(last.children[4]) === '—', last && text(last.children[4]));
  check('the tutorial outcome strip has every part', host.querySelectorAll('.ob-stack .ob-seg').length === 4);

  const go = (label) => { [...host.querySelectorAll('.ob .sui-screen-nav-item')].find((a) => text(a) === label).click(); };
  const before = calls().length;
  go('Slowest');
  const slowRows = [...host.querySelectorAll('.ob-slow .ob-row[data-step]')];
  check('SLOWEST ranks steps by median time', slowRows.length > 3 && slowRows[0].dataset.step === 'signup.recovery_key_create', slowRows[0] && slowRows[0].dataset.step);
  check('views switch from the last read, without asking again', calls().length === before);
  go('Guilds');
  const g = [...host.querySelectorAll('.ob-guilds .ob-row[data-guild]')];
  check('GUILDS lists every guild, the one without an API quiet', g.length === 3 && g.find((r) => r.dataset.guild === '0-2').classList.contains('is-quiet'));
  check('a guild says why it has nothing', /no guild API published/.test(text(g.find((r) => r.dataset.guild === '0-2'))));
  go('Daily');
  check('DAILY is newest first', host.querySelectorAll('.ob-daily .ob-row').length === 7);
  go('Recent');
  const p = host.querySelector('.ob-recent .ob-row[data-player="1-9580"]');
  check('RECENT shows outcome and time in the tutorial', p && /Finished/.test(text(p)) && /13m/.test(text(p)), text(p));
  check('an unnamed player is shown by id', p && /^1-9580/.test(text(p.querySelector('.ob-link'))));
  check('the foot says how large the sample is', /Timings from 813 players on tutorial-4/.test(text(host.querySelector('.ob-foot'))));

  const sel = [...host.querySelectorAll('.ob-controls select')];
  sel[1].value = '72'; sel[1].dispatchEvent(new w.Event('change'));
  const asked = await until(() => calls().find((c) => c.args.idleHours === 72));
  check('the quit window is a param and re-reads', !!asked);
}

// ── Wiring ──
check('the command is registered with Tauri', /onboarding::terminal_onboarding/.test(read('src-tauri/src/main.rs')));
check('and reachable from the web board', /"terminal_onboarding"/.test(read('src-tauri/src/mcp/web_board.rs')));
check('board.html loads the script and the sheet', /board-terminal-onboarding\.js/.test(read('frontend/board.html')) && /onboarding\.css/.test(read('frontend/board.html')));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
