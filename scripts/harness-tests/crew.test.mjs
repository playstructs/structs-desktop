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

// ── The crew card: two choices, and nothing else to learn ────────────────
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

  if (!host) { console.log('  (skipping the rest: nothing rendered)'); }
  else {
  const body = text(host);
  const buttons = () => [...host.querySelectorAll('a.sui-screen-btn')].map((b) => text(b));

  /* The whole point of the rewrite. The panel used to open by asking which
   * Matrix ROOM to turn into a crew — chat plumbing in front of a game
   * decision — and it was reported as extremely confusing. It now asks the
   * only question there is, and offers the only two answers. */
  check('it asks who you want to help, not which room to configure',
    /help/i.test(body) && !/room/i.test(body), body.slice(0, 240));
  check('…and the two answers are the guild and a person',
    buttons().some((b) => /My guild/.test(b)) && buttons().some((b) => /A friend/.test(b)),
    buttons().join(' | '));
  check('…with no role, scope, epoch or threshold to choose first',
    !/(scope|epoch|slot|threshold|ripe|role)/i.test(body), body.slice(0, 300));

  // Nothing that spends or signs may fire on a single click.
  const guild = [...host.querySelectorAll('a.sui-screen-btn')].find((b) => /My guild/.test(text(b)));
  const before = (w.__HARNESS_CALLS__ || []).length;
  guild.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('one click on a signing action only ARMS it',
    (w.__HARNESS_CALLS__ || []).slice(before).every((c) => c.cmd !== 'crew_help_guild')
      && /\?/.test(text(guild)),
    text(guild));
  guild.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'crew_help_guild'));
  const helpCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'crew_help_guild');
  check('…and the second click does it', !!helpCall);
  /* Helping must not sign anything. The first version opened your work to
   * ~2,500 accounts inside a button that said "help" — a chain transaction as
   * a side effect. Computing a proof needs no rights, so starting to help is
   * local, and opening your work is its own door. */
  check('helping does NOT open your work as a side effect',
    helpCall && helpCall.args && helpCall.args.openMyWork === false, JSON.stringify(helpCall && helpCall.args));
  check('…the explicit door exists on each link, and says what it signs',
    buttons().some((b) => /Let them finish mine|Close my work/.test(b)), buttons().join(' | '));

  /* The confirm is INLINE. `confirmModal` did not appear at all when this card
   * was driven in its own popped-out window against the running app, so the
   * primary actions must not depend on it. */
  check('the confirm needs no overlay', d.querySelector('.ops-modal-overlay') === null);

  // The list: a guild link and a person read differently, and a person shows
  // both directions because a half-open link is the normal state.
  check('a guild link says it is the whole guild',
    /My guild/.test(body) && /whole guild/.test(body), body.slice(0, 400));
  /* The chips are about SIGNING rights only — anybody may compute a proof for
   * anybody — so they say "finish", never "help": a Closed chip must not read
   * as "cannot help". */
  check('a person shows both directions of signing rights',
    /JPEG/.test(body) && /they may finish mine/i.test(body) && /i may finish theirs/i.test(body), body.slice(0, 600));
  check('…and every link can be stopped', buttons().some((b) => /Stop/.test(b)));
  check('terms for anyone who helps show as a link with their rate',
    /Anyone who helps/.test(body) && /per difficulty/.test(body) && /paying helpers\s*on|on\s*paying helpers/.test(body), body.slice(0, 700));
  // A proof handed over Comms is work done, and the only visible trace of
  // the no-grant path; it shows once there is one (fixture: 3) and not as a
  // fourth zero before then.
  check('the bus reads as numbers: arrivals, the hour against its ceiling, proofs spent',
    /signed this hour/.test(body) && /60\D*of\D*60/.test(body) && /92\s*spent/.test(body), body.slice(0, 500));
  check('…and a ceiling that is losing proofs says so, and where the knob is',
    /51 refused at the ceiling/.test(body) && /crew_submit/.test(body), body.slice(0, 500));
  check('the two thresholds sit side by side: theirs to set, mine to read',
    /Their work at difficulty/.test(body) && /4\s*mine at ≤/.test(body), body.slice(0, 500));
  check('rates published on the bus are listed for a helper, with the cap',
    /Paying on the bus/.test(body) && /JPEG/.test(body) && /per difficulty/.test(body) && /up to/.test(body), body.slice(0, 900));
  check('a node behind the chain is said in so many words, with the lag',
    /448 blocks behind the chain/.test(body) && /holding proofs/.test(body), body.slice(0, 700));
  check('recent activity is listed, newest first', /Recent/.test(body) && body.indexOf('spent 1-195') < body.indexOf('posted a proof'), body.slice(0, 500));
  check('proofs posted to comms are counted on the card', /finished\D*3\D*posted/.test(body), body.slice(0, 400));

  /* "It doesn't seem to be doing anything" has to be answerable FROM THE CARD.
   *
   * A crew nobody has opened their work to looks exactly like a crew that is
   * working: both show 0 finished. Reported live 2026-09-11 by a second
   * machine that had opened ITS work to the guild and sat idle, because
   * opening your own side grants you nothing — each side opens separately.
   */
  const idle = { links: JSON.parse(JSON.stringify(w.__HARNESS_FIXTURES__.crew_links.links)),
    player_id: '1-194', guild_id: '0-1', helping: true, taking: 0, helped: 0,
    last_pass: { epoch: 1, submitting: 0, reporting: 0, started: 0, declined: 7, ripe: 7, free: 4, members: 300, at_ms: 1 } };
  w.__HARNESS_FIXTURES__.crew_links = idle;
  const card2 = w.Board.Terminal.add('crew', {}, 2);
  const host2 = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + ((card2 && card2.id) || '') + '"] .tm-body');
    return c && text(c).length > 4 ? c : null;
  });
  const body2 = host2 ? text(host2) : '';
  check('an idle crew says where the gap is',
    /7 left alone/.test(body2) && !/no room in common/.test(body2), body2.slice(0, 300));

  // …and "nothing ripe" must not be blamed on permission.
  idle.last_pass = { epoch: 2, submitting: 0, reporting: 0, started: 0, declined: 0, ripe: 0, free: 4, members: 300, at_ms: 2 };
  const card3 = w.Board.Terminal.add('crew', {}, 2);
  const host3 = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + ((card3 && card3.id) || '') + '"] .tm-body');
    return c && /Nothing ripe|allowed to finish/.test(text(c)) ? c : null;
  });
  check('…and a quiet crew is not misreported as a permission problem',
    host3 !== null && /Nothing ripe/.test(text(host3)) && !/left alone/.test(text(host3)),
    host3 ? text(host3).slice(0, 200) : 'no render');
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
  check('the payout floor is shown and editable', /pays from/.test(body) && /Pay once owed/.test(body), body.slice(0, 400));
  check('…and offers to pay anyone who helps when no such terms exist',
    /Pay anyone who helps/.test(body), body.slice(0, 300));

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
