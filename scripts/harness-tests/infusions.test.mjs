// Industry → Production (infusions) against the static harness — no Tauri, no
// rebuild. This page signs staking messages with real Alpha, and two of its
// three writes are hard to walk back: a defusion locks the Alpha for four days
// and takes the capacity immediately, and a migration cannot be undone at all.
// So the assertions here are mostly about what the page REFUSES to do and what
// it says before it signs — plus the split that put allocations on their own
// section.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && npm install && npm run test:infusions)
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
    await new Promise((r) => setTimeout(r, 20));
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
const calls = () => w.__HARNESS_CALLS__;
const lastCall = (cmd) => [...calls()].reverse().find((c) => c.cmd === cmd);

await until(() => w.Board && w.Board.pages && w.Board.pages.energy);

// ── The section split ───────────────────────────────────────────────────────
// Making capacity and routing capacity are different jobs with different
// controls; the manifest is the single list the tab bar, sub-nav, router and
// page divs all read, so this is where the split is real.
const industry = w.Board.AREAS.find((a) => a.key === 'industry');
const keys = industry.sections.map((s) => s.key);
check('Industry leads with Production then Distribution',
  keys[0] === 'production' && keys[1] === 'distribution', keys.join(','));
check('both map to the one energy page with distinct views',
  industry.sections[0].page === 'energy' && industry.sections[1].page === 'energy'
  && industry.sections[0].view === 'production'
  && industry.sections[1].view === 'distribution');

// ── Production ──────────────────────────────────────────────────────────────
w.Board.pages.energy.onEnter({}, 'production');
await until(() => q('#energy-body .sui-data-card').length >= 4);

const cardTitles = [...q('#energy-body .sui-data-card-header')].map(text);
check('production paints summary, infusions, in-flight, generators and reactors',
  ['INFUSION SUMMARY', 'REACTOR INFUSIONS', 'IN FLIGHT', 'GENERATOR INFUSIONS', 'REACTORS']
    .every((t) => cardTitles.includes(t)), cardTitles.join(' | '));

const cardBody = (title) => {
  const head = [...q('#energy-body .sui-data-card-header')].find((h) => text(h) === title);
  return head && head.parentNode.querySelector('.sui-data-card-body');
};
const rowsIn = (title) => [...cardBody(title).querySelectorAll('.sui-result-row')];

// Ratio 0 is Alpha staked into a validator that produces nothing. Nothing else
// on screen says so, and it is the one row worth acting on today — so it sorts
// to the top and is marked, not just listed.
const infusionRows = rowsIn('REACTOR INFUSIONS');
check('reactor infusions list only the reversible rows', infusionRows.length === 2,
  'got ' + infusionRows.length);
check('the dead infusion sorts first', /3-11/.test(text(infusionRows[0])),
  text(infusionRows[0]).slice(0, 80));
check('the dead row is flagged as producing nothing',
  /earning nothing/.test(text(infusionRows[0]))
  && infusionRows[0].querySelector('.sui-icon-no-power') != null);
check('a live row is not flagged', !/earning nothing/.test(text(infusionRows[1]))
  && infusionRows[1].querySelector('.sui-icon-energy') != null);

const btns = (row) => [...row.querySelectorAll('.mass-btn')].map((b) => text(b));
check('a live reactor infusion offers add / defuse / migrate',
  JSON.stringify(btns(infusionRows[1])) === JSON.stringify(['Add', 'Defuse', 'Migrate']),
  JSON.stringify(btns(infusionRows[1])));
// MsgReactorRestart only helps a validator that came back but never rebonded.
// Offering it on a JAILED reactor would be a button that cannot work.
check('Restart is offered on the unbonded-but-not-jailed row',
  btns(infusionRows[0]).includes('Restart'));
check('Restart is not offered on a healthy row',
  !btns(infusionRows[1]).includes('Restart'));

// Generator infusions are annihilated on success — there is no defuse message
// for them at all, so the card must not grow buttons.
const genRows = rowsIn('GENERATOR INFUSIONS');
check('generator infusions are listed apart', genRows.length === 1);
check('generator infusions carry no actions', genRows[0].querySelectorAll('.mass-btn').length === 0);
check('generator conversion rate is shown', /2 kW\/g/.test(text(genRows[0])), text(genRows[0]));

/* The card explains nothing.
 *
 * It used to carry a three-sentence warning about Alpha being annihilated and
 * where generators belong. That is documentation, and it does not go in the
 * interface: the player knows the game. The row already says `one-way`, and
 * says `DESTROYED — the Alpha is gone` when that is what happened — state,
 * not a lecture.
 *
 * This assertion replaces one that required the paragraph to be present.
 */
check('the card carries no explanatory prose',
  !/cannot be defused|annihilated|belong only/.test(text(cardBody('GENERATOR INFUSIONS'))));
check('...while the row still states the fact as status',
  /one-way/.test(text(genRows[0])), text(genRows[0]));

// The reactor directory doubles as the picker's context.
const reactorRows = rowsIn('REACTORS');
check('every reactor is a destination', reactorRows.length === 4);
const jailed = reactorRows.find((r) => /JAILED/.test(text(r)));
check('a jailed reactor cannot be infused',
  jailed.querySelector('.mass-btn').classList.contains('sui-mod-disabled'));
check('a jailed reactor is not offered a restart either',
  !btns(jailed).includes('Restart'));
const unbonded = reactorRows.find((r) => /3-11/.test(text(r)));
check('an unbonded reactor is offered a restart', btns(unbonded).includes('Restart'));

// ── Defuse: the expensive one ───────────────────────────────────────────────
infusionRows[1].querySelectorAll('.mass-btn')[1].click();  // Defuse
await until(() => D.querySelector('#detail-overlay'));
const drawer = () => D.querySelector('#detail-overlay .detail-panel');
check('the defuse drawer names the player, not just the address',
  /Marklifer/.test(text(drawer())), text(drawer()).slice(0, 120));

// MAX is "still removable" — staked minus what is ALREADY defusing. A ceiling
// that ignores the pending defusion is how you sign an amount the chain rejects.
const maxLink = drawer().querySelector('.amount-max');
maxLink.click();
await until(() => lastCall('mcp_infusion_preview'), 3000);
const pv = lastCall('mcp_infusion_preview');
check('preview is asked for the defuse op on the right reactor',
  pv.args.op === 'defuse' && pv.args.destinationId === '3-1', JSON.stringify(pv.args));
check('MAX offers staked minus already-defusing, in base units',
  pv.args.amountUalpha === 13318001349 - 2000000, String(pv.args.amountUalpha));
check('the signing address is the infusion holder',
  pv.args.address === 'structs12wll0unjn6rzmjchnqy8e07txfeaf4w8y3x6ne');

await until(() => drawer().querySelector('.drawer-cta .mass-btn'));
check('the preview names what the removal costs NOW',
  /capacity removed/.test(text(drawer())) && /immediately/.test(text(drawer())));
check('and when the Alpha comes back', /alpha returns in/.test(text(drawer()))
  && /4d/.test(text(drawer())), text(drawer()));

// Nothing is signed from the drawer directly — the confirm restates the two
// figures that matter before the message goes out.
drawer().querySelector('.drawer-cta .mass-btn').click();
await until(() => D.querySelector('.ops-modal-overlay'));
const modal = () => D.querySelector('.ops-modal-overlay');
check('the confirm restates the immediate capacity loss',
  /Capacity removed now/.test(text(modal())), text(modal()).slice(0, 200));
/* The confirm is SUI's system modal and the form's own fact rows.
 *
 * Both had drifted. The overlay was a hand-written `.modal-overlay` — a second
 * opinion about the fixed inset, the dim and the centring that SUI already
 * has — and the body used the label/value ROW, which wraps at the FLEX level:
 * a 44-character address is pushed onto its own line whole, stranding the
 * label on a 36px row above it. Stacked facts are what the drawer that opened
 * the dialogue already uses, so the two halves of one flow read alike.
 */
check('the overlay is SUI\u2019s own, not a local re-draw',
  modal().classList.contains('sui-message-system-model-overlay'),
  modal().className);
check('the confirm states its facts in the form\u2019s idiom',
  modal().querySelectorAll('.form-fact').length >= 3
  && modal().querySelectorAll('.sui-data-card-row').length === 0,
  modal().querySelectorAll('.form-fact').length + ' facts, '
  + modal().querySelectorAll('.sui-data-card-row').length + ' rows');
check('\u2026and its labels are SUI\u2019s label type, not a hand copy',
  [...modal().querySelectorAll('.form-fact-label')]
    .every((l) => l.classList.contains('sui-text-label')));
const confirmBtn = () => modal().querySelectorAll('.sui-message-system-modal-cta-btn-wrapper a')[1];
confirmBtn().click();
await until(() => lastCall('mcp_infusion_defuse'), 3000);
check('defuse is signed with address, reactor and base-unit amount',
  JSON.stringify(lastCall('mcp_infusion_defuse').args) === JSON.stringify({
    address: 'structs12wll0unjn6rzmjchnqy8e07txfeaf4w8y3x6ne',
    reactorId: '3-1',
    amountUalpha: 13318001349 - 2000000,
  }), JSON.stringify(lastCall('mcp_infusion_defuse').args));

// ── A refused preview must not offer a way through ──────────────────────────
await until(() => q('#energy-body .sui-data-card').length >= 4);
w.__HARNESS_FIXTURES__.mcp_infusion_preview = {
  ok: false,
  refusal: 'that removes 12.79 kW of capacity, leaving 131.42 kW against 123000.00 kW of '
    + 'allocated load. The chain brownouts an object whose load exceeds its capacity and '
    + 'DESTROYS its allocations in creation order',
  warnings: ['this infusion is at ratio 0'],
  facts: {},
};
rowsIn('REACTOR INFUSIONS')[1].querySelectorAll('.mass-btn')[1].click();
await until(() => D.querySelector('#detail-overlay'));
drawer().querySelector('.amount-max').click();
await until(() => /DESTROYS its allocations/.test(text(drawer())), 3000);
check('a refusal is shown in full', /DESTROYS its allocations/.test(text(drawer())));
check('a refusal leaves no way to sign',
  drawer().querySelectorAll('.drawer-cta .mass-btn').length === 0);
check('warnings ride along with the refusal', /ratio 0/.test(text(drawer())));

// ── Cancelling a defusion ───────────────────────────────────────────────────
// The creation height identifies WHICH unbonding entry to re-stake. It is an
// int64 the chain matches exactly, so it must travel as the string the pending
// row carries and never as a rounded number.
D.querySelector('#detail-overlay .detail-x').click();
const pending = rowsIn('IN FLIGHT');
check('in-flight lists the defusion and the migration', pending.length === 2);
check('the pending defusion shows when the Alpha returns',
  /alpha back in/.test(text(pending[0])), text(pending[0]));
check('a migration in flight is read-only',
  pending[1].querySelectorAll('.mass-btn').length === 0);
pending[0].querySelector('.mass-btn').click();
await until(() => D.querySelector('.ops-modal-overlay'));
confirmBtn().click();
await until(() => lastCall('mcp_infusion_cancel_defusion'), 3000);
const cancelArgs = lastCall('mcp_infusion_cancel_defusion').args;
check('cancel carries the creation height as a string',
  cancelArgs.creationHeight === '2236401', JSON.stringify(cancelArgs));
check('cancel targets the validator, not the reactor id',
  cancelArgs.validator === 'structsvaloper1ul8sd7n');

// ── Distribution still works ────────────────────────────────────────────────
w.Board.pages.energy.onEnter({}, 'distribution');
await until(() => [...q('#energy-body .sui-data-card-header')].some((h) => text(h) === 'ALLOCATIONS'));
const distTitles = [...q('#energy-body .sui-data-card-header')].map(text);
check('distribution keeps guild power, allocations and margins',
  distTitles.includes('GUILD POWER') && distTitles.includes('ALLOCATIONS')
  && distTitles.some((t) => t.startsWith('PLAYER MARGINS')), distTitles.join(' | '));
check('distribution does not paint any infusion card',
  !distTitles.includes('REACTOR INFUSIONS'), distTitles.join(' | '));
// The cadence tick must not pay for the other section's reads.
const before = calls().length;
w.Board.pages.energy.refresh();
await until(() => calls().length > before);
await new Promise((r) => setTimeout(r, 100));
check('a distribution refresh reads no infusion data',
  calls().slice(before).every((c) => c.cmd !== 'mcp_infusions'),
  JSON.stringify(calls().slice(before).map((c) => c.cmd)));

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
