// The Replication card (board-terminal-ops.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/replication.test.mjs
//
// The brief this pins: one button that is always allowed, one switch, two
// counts, six figures — and NOTHING to decide (no count field, no snapshot
// select, no confirm). A press shows before the round trip; the loop's own
// `replication` event — never the command's answer — is what repaints.
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
function load(query) {
  return JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + query, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (n) => (n && n.textContent || '').replace(/\s+/g, ' ').trim();

{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add);
  const T = w.Board.Terminal;

  // ── ⌘K ──
  const empty = T.suggestFor('');
  const row = empty.find((o) => /\bREPLICATE\b/.test(String(o.words || '')));
  check('REPLICATE is in the palette, under Armada', row && row.group === 'Armada', JSON.stringify(row || null));
  check('…and REPLICANTS and CLONE open the same card',
    T.parse('REPLICATE').type === 'replication' && T.parse('REPLICANTS').type === 'replication' && T.parse('CLONE').type === 'replication');

  // ── The card ──
  const card = T.add('replication', {}, 1);
  const id = (card && card.id) || 'replication-1';
  const host = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
    return c && text(c).length > 4 ? c : null;
  });
  check('the card renders', host !== null);
  if (!host) { console.log('  (skipping the rest: nothing rendered)'); }
  else {
    const buttons = [...host.querySelectorAll('a.sui-screen-btn')];
    const btn = buttons[0];
    check('one primary button, and it says REPLICATE',
      buttons.length === 1 && btn.classList.contains('sui-mod-primary') && text(btn) === 'Replicate', buttons.map(text).join('|'));
    const sw = host.querySelector('input.sui-checkbox');
    const swLabel = host.querySelector('.sui-checkbox-container label');
    check('the switch under it is Autonomous Replication, read from the loop',
      sw && sw.checked === true && text(swLabel) === 'Autonomous Replication');
    check('nothing to decide: no count field, no snapshot select, no confirm',
      host.querySelectorAll('input[type="text"], input[type="number"], select, .tm-ticket-slot').length === 0);

    const qV = host.querySelector('.rp-queue .fstat-v');
    const nV = host.querySelector('.rp-replicants .fstat-v');
    const why = host.querySelector('.rp-queue-why');
    check('the queue and the replicant count read the loop', text(qV) === '7' && text(nV) === '182', text(qV) + ' / ' + text(nV));
    check('a queue that is not moving says why, in one word', why && !why.classList.contains('hidden') && /held · energy/.test(text(why)) && /1 incubating/.test(text(why)), text(why));

    const tiles = [...host.querySelectorAll('.rp-stats .fstat')];
    const labels = tiles.map((t) => text(t.querySelector('.fstat-l')));
    check('six figures: energy, hashing, ore, alpha, raids, k/d',
      labels.join(',') === 'energy,hashing,ore,alpha,raids,k/d', labels.join(','));
    const val = (i) => text(tiles[i].querySelector('.fstat-v'));
    check('energy is use / available on the game\'s power ladder', / \/ /.test(val(0)) && /W/.test(val(0)), val(0));
    check('hashing is the CPU figure', val(1) === '62%', val(1));
    check('production and raids are rates per hour', /\/h$/.test(val(2)) && /\/h$/.test(val(3)) && /\/h$/.test(val(4)), [val(2), val(3), val(4)].join('|'));
    check('k/d is one number over kills · losses', val(5) === '1.8' && /41 · 23/.test(text(tiles[5])), text(tiles[5]));
    check('energy is marked as what is holding the queue', tiles[0].classList.contains('bad'));

    // ── The press ──
    const calls = w.__HARNESS_CALLS__ || [];
    const before = calls.length;
    btn.click();
    check('a press shows before the round trip', text(qV) === '8', text(qV));
    const call = await until(() => calls.slice(before).find((c) => c.cmd === 'mcp_replicate'));
    check('…and is one command with no arguments to choose', !!call && call.args && call.args.n === 1, JSON.stringify(call && call.args));
    await tick(80);
    check('…and the command\'s answer never repaints — a stale answer after a birth would drag the count back', text(qV) === '8', text(qV));
    btn.click(); btn.click(); btn.click();
    check('smashing it stacks', text(qV) === '11', text(qV));
    await tick(80);
    check('…and stays stacked until the loop speaks', text(qV) === '11', text(qV));

    // ── The event ──
    const listeners = (w.__HARNESS_LISTENERS__ || {})['replication'] || [];
    check('the card listens for the loop\'s own event', listeners.length >= 1);
    listeners.forEach((cb) => cb({ payload: { queue: 3, replicants: 190, incubating: [], held: { n: 0, reason: null } } }));
    await tick(20);
    check('a replication event repaints both counts and clears the reason',
      text(qV) === '3' && text(nV) === '190' && why.classList.contains('hidden'), text(qV) + ' / ' + text(nV) + ' / ' + text(why));

    // ── The switch ──
    const b2 = calls.length;
    sw.checked = false;
    sw.dispatchEvent(new w.Event('change', { bubbles: true }));
    const cfgCall = await until(() => calls.slice(b2).find((c) => c.cmd === 'mcp_config_set'));
    check('the switch writes the loop\'s whole config back with only enabled changed',
      !!cfgCall && cfgCall.args.domain === 'loop' && cfgCall.args.payload.loop === 'replicate'
        && cfgCall.args.payload.config.enabled === false && cfgCall.args.payload.config.max_per_round === 5
        && cfgCall.args.payload.config.interval_secs === 300,
      JSON.stringify(cfgCall && cfgCall.args));
  }

  // ── The rules the card is drawn with ──
  {
    const css = read('frontend/board.html');
    check('the button grows to the card, in the same SUI face', /\.rp-hero a\.sui-screen-btn\.rp-replicate \{ width: 100%; height: auto;/.test(css));
    const ops = read('frontend/board-terminal-ops.js');
    check('no explainer prose in the card', !/H\.el\('p'/.test(ops.slice(ops.indexOf("T.register('replication'"))));
  }
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
