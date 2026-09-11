// The crew cards (board-terminal-ops.js: `crew`, `crewpay`) and their words.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/crew.test.mjs
//
// What is worth pinning here is what would be WRONG rather than missing: a
// permission state drawn as allowed when it is not, a capped payment shown as
// if it settled the debt, and the two directions of a half-open crew collapsed
// into one chip. Layout is not the point.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
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
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  });
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

// ── The words ────────────────────────────────────────────────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window;
  await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.WORDS);
  const T = w.Board.Terminal;

  for (const [word, type] of [['CREW', 'crew'], ['HELPERS', 'crew'], ['CREWMATES', 'crew'],
    ['BOUNTY', 'crewpay'], ['OWED', 'crewpay'], ['PAYOUTS', 'crewpay']]) {
    const p = T.parse(word);
    check(`${word} opens the ${type} card`, p && p.kind === 'card' && p.type === type,
      JSON.stringify(p));
    check(`…and ${word} is runnable`, T.canRun(word) === true);
  }

  // A word that already meant something must not have been stolen. HELP is the
  // command list and PAY is the payment card; a crew word landing on either
  // would silently repoint a command people already use.
  check('HELP still means the command list', T.parse('HELP').type === 'help');
  check('PAY still means Deliver', T.parse('PAY').type === 'deliver');
  check('WORK still means the task list', T.parse('WORK').type === 'tasks');

  // A card missing from CARD_GROUPS falls into "More" and the terminal suite
  // fails it; assert membership here too so the reason is named.
  const groups = T.groups ? T.groups() : [];
  const filed = groups.filter((g) => g.group !== 'More')
    .flatMap((g) => (g.options || []).map((o) => o.value));
  check('both cards are filed in a real group, not swept into More',
    filed.includes('crew') && filed.includes('crewpay'), filed.join(','));
  dom.window.close();
}

// ── The crew card ────────────────────────────────────────────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add);
  const card = w.Board.Terminal.add('crew', {}, 2);
  const id = (card && card.id) || 'crew-1';
  const host = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
    return c && text(c).length > 4 ? c : null;
  });
  check('the crew card renders', host !== null);
  const body = text(host);
  if (!host) { console.log('  (skipping the rest: nothing rendered)'); }
  else {

  check('the crew names its room', /Night shift/.test(body), body.slice(0, 160));
  check('…and says what this machine is doing for it', /Work/.test(body));

  // The assignment, which is the whole mechanism: which slot we hold in the
  // rotation and what that gives us this epoch. A card that showed only
  // "helping: on" could not tell an idle crew from a working one.
  await until(() => /my slot/.test(text(host)));
  check('…and which slot of the rotation is ours', /my slot/.test(text(host)) && /2 of 2/.test(text(host)),
    text(host).slice(0, 400));
  check('…and the task it takes from that slot', /5-2184/.test(text(host)));

  // Two directions. The fixture is deliberately half-open: 1-61 may finish our
  // work, we may not finish theirs. One chip would have to pick a side.
  await until(() => /JPEG/.test(text(host)));
  const rows = [...host.querySelectorAll('.sui-result, .tm-row, [class*="result"]')]
    .map((r) => text(r)).filter((t) => /JPEG/.test(t));
  check('a crewmate shows BOTH directions of permission', rows.length > 0
    && /they help me/i.test(rows[0]) && /i help them/i.test(rows[0]), rows[0]);
  check('…granted reads as granted, and closed as closed', rows.length > 0
    && /Granted/.test(rows[0]) && /Closed/.test(rows[0]), rows[0]);
  check('…and a rank grant says it came from a rank, not from a grant',
    /By rank/.test(text(host)), text(host).slice(0, 600));

  // The door on an open link must CLOSE it. Offering "Open my work" to
  // somebody who already has it is how a grant gets sent twice.
  const jpegRow = [...host.querySelectorAll('*')].find(
    (n) => n.className && String(n.className).includes('result') && /JPEG/.test(text(n)));
  const door = jpegRow && [...jpegRow.querySelectorAll('a.sui-screen-btn')][0];
  check('an already-open link offers to close, not to open again',
    door && /Close my work/.test(text(door)), door ? text(door) : 'no door');

  /* Somebody reaching our work by RANK has no per-person grant to withdraw.
   * Offering "Close my work" there would send a revoke of a record that never
   * existed and leave them able to help anyway — a button that reports
   * success and changes nothing. */
  const rankRow = [...host.querySelectorAll('*')].find(
    (n) => n.className && String(n.className).includes('result') && /Phoniffer/.test(text(n)));
  const rankDoor = rankRow && [...rankRow.querySelectorAll('a.sui-screen-btn')][0];
  check('a rank-granted crewmate is not offered a revoke that would do nothing',
    rankDoor && /Open my work/.test(text(rankDoor)), rankDoor ? text(rankDoor) : 'no door');
  }
  dom.window.close();
}

// ── The bounty card ──────────────────────────────────────────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add);
  const card = w.Board.Terminal.add('crewpay', {}, 2);
  const id = (card && card.id) || 'crewpay-1';
  const host = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
    return c && /rate|owed/i.test(text(c)) ? c : null;
  });
  check('the bounty card renders', host !== null);
  const body = text(host);
  if (!host) { console.log('  (skipping the rest: nothing rendered)'); }
  else {

  check('the rate is per difficulty, not per proof', /10\u03bcg \/ difficulty/.test(body), body.slice(0, 200));
  // Money is on the game's own ladder here as everywhere else: 90 ualpha is
  // `90\u03bcg`, not a bare integer beside a wire denom.
  check('what is owed is shown against what the epoch has already spent',
    /owed/.test(body) && /this epoch/.test(body) && /40\u03bcg \/ 0\.5mg/.test(body), body.slice(0, 300));
  check('…and what would be paid right now', /due now/.test(body) && /90\u03bcg/.test(body));

  // Every receipt names the work and its difficulty, because that is what the
  // amount was computed from. A row showing only an amount cannot be checked.
  check('a receipt names the worker, the object and the difficulty',
    /1-61/.test(body) && /5-2184/.test(body) && /difficulty 9/.test(body), body.slice(-400));
  check('…and a settlement counts proofs in the singular when there is one',
    /\u00b7 1 proof(?!s)/.test(body), body.slice(0, 500));
  check('…and whether it has been paid', /paid/.test(body));

  // A settled credit and an unsettled one must not look alike.
  check('a settled receipt is marked settled and an open one is not',
    /1-248/.test(body) && /5-99/.test(body), body.slice(-400));
  }
  dom.window.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
