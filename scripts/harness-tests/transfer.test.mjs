// The Pay window, against the static harness — no Tauri, no rebuild.
//
//   bash scripts/make_harness.sh
//   node scripts/harness-tests/transfer.test.mjs
//
// This window decides what leaves a wallet, so the assertions are about the
// numbers and denoms that would really have been sent — not about layout.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness_transfer.html');
if (!existsSync(harness)) {
  console.error('missing frontend/_harness_transfer.html — run: bash scripts/make_harness.sh');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(ms = 420) { await new Promise((r) => setTimeout(r, ms)); }

const dom = await JSDOM.fromFile(harness, {
  url: pathToFileURL(harness).href,
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
});
const w = dom.window;
const d = w.document;
await settle(120);

const calls = () => w.__HARNESS_CALLS__;
const previews = () => calls().filter((c) => c.cmd === 'mcp_transfer_preview');
const type = async (text) => {
  const box = d.getElementById('tx-amount');
  box.value = text;
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle();
};
const pick = async (id, value) => {
  const sel = d.getElementById(id);
  sel.value = value;
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
};

// ── Both parties are people ────────────────────────────────────────────────
// A payment is between two PEOPLE. This screen used to print the word
// "primary" on both lines, naming neither of them and giving no way to notice
// you were about to pay the wrong one.
{
  console.log('\n— who is paying whom');
  const cards = [...d.querySelectorAll('#tx-parties .sui-result-row')];
  check('both parties are drawn as player cards', cards.length === 2,
    String(cards.length));
  check('the payer is named, not called "primary"',
    /Marklifer/.test(cards[0].textContent) && !/^\s*primary/.test(cards[0].textContent),
    cards[0].textContent.trim().slice(0, 60));
  check('...with their player id and address',
    /1-194/.test(cards[0].textContent) && /structs12wll/.test(cards[0].textContent));
  check('the recipient is named too', /JPEG/.test(cards[1].textContent),
    cards[1].textContent.trim().slice(0, 60));

  // Portraits come from another player's on-chain string, so they must go
  // through the shared composer rather than being interpolated here.
  const layers = cards[0].querySelectorAll('img.pfp-viewer-layer');
  check('the payer has a composed portrait', layers.length === 5,
    String(layers.length));
  check('...built from validated indices, not raw values',
    [...layers].every((i) => /^img\/pfp\/[a-z]+\/pfp_[a-z]+_\d+\.png$/.test(i.getAttribute('src'))),
    [...layers].map((i) => i.getAttribute('src')).join(' '));
}

// ── Every sendable asset, and only those ───────────────────────────────────
{
  console.log('\n— which assets can be sent');
  const opts = [...d.querySelectorAll('#tx-asset option')].map((o) => o.value);
  check('Alpha and the guild token are both offered',
    opts.includes('ualpha') && opts.includes('uguild.0-5'), opts.join(', '));
  check('a staking state is not offered as a balance',
    !opts.includes('ualpha.infused'), opts.join(', '));
  check('ore is not offered at all', !opts.includes('ore'), opts.join(', '));
  check('Alpha is first, being the game’s money', opts[0] === 'ualpha', opts[0]);
  check('the picker is shown, because there IS a choice',
    d.getElementById('tx-asset-row').hidden === false);
  check('each row is priced', /31\.42Kg/.test(d.getElementById('tx-asset').textContent),
    d.getElementById('tx-asset').textContent.trim());
}

// ── The unit is a control, not a spelling ──────────────────────────────────
{
  console.log('\n— choosing the unit');
  const units = () => [...d.querySelectorAll('#tx-unit option')].map((o) => o.value);
  check('Alpha offers the game’s ladder',
    ['Tg', 'Kg', 'g', 'mg', 'μg'].every((u) => units().includes(u)), units().join(', '));

  // The same digits mean different amounts in different units — that is what
  // picking one IS.
  await pick('tx-unit', 'g');
  await type('2');
  check('2 g is 2,000,000 ualpha',
    previews().at(-1).args.amount === 2e6, String(previews().at(-1).args.amount));
  await pick('tx-unit', 'Kg');
  await type('2');
  check('...and 2 Kg is 2,000,000,000',
    previews().at(-1).args.amount === 2e9, String(previews().at(-1).args.amount));

  // A typed suffix still wins: a figure copied off any other screen must paste
  // back in and mean what it says, whatever the control shows.
  await type('9.4Kg');
  check('a typed suffix beats the control',
    previews().at(-1).args.amount === 9.4e9, String(previews().at(-1).args.amount));
}

// ── Switching asset switches everything with it ────────────────────────────
{
  console.log('\n— switching asset');
  await pick('tx-asset', 'uguild.0-5');
  // (An earlier check here was three disjuncts long and could not fail. What
  // it was reaching for — that the preview asks for the chosen denom — is
  // asserted properly at the end of this block, on a real send amount.)
  check('the amount box is cleared, not carried over',
    d.getElementById('tx-amount').value === '',
    d.getElementById('tx-amount').value);

  const units = [...d.querySelectorAll('#tx-unit option')].map((o) => o.value);
  // A guild token has two published names, not a metric ladder. Inventing Kg
  // and mg for somebody else's token would be making units up.
  check('the guild token offers its own two names',
    units.join() === 'SN,μSN', units.join());
  check('...and not Alpha’s ladder', !units.includes('Kg'), units.join());

  await type('3');
  const last = previews().at(-1);
  check('3 SN is sent as the guild denom', last.args.denom === 'uguild.0-5', last.args.denom);
  check('...in that token’s base units', last.args.amount === 3e6, String(last.args.amount));

  check('the window title names what is being sent',
    /SN/.test(d.getElementById('tx-title').textContent),
    d.getElementById('tx-title').textContent);
}

// ── "all" means the exact balance ──────────────────────────────────────────
//
// The ladder rounds to two decimals, so a balance of 31,420,000,001 prints as
// "31.42Kg". A player who reads that off the screen and types it back strands
// the remainder — so the control carries the base-unit figure rather than the
// spelling beside it. Now that the window sends more than one asset, this has
// to hold for the guild token too.
{
  console.log('\n— sending everything');
  // A balance that cannot be printed exactly at two decimals.
  w.__HARNESS_FIXTURES__.mcp_inventory.assets[0].amount = 31420000001;
  await pick('tx-asset', 'ualpha');
  d.querySelector('.tx-all').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle();
  check('"all" spends the un-printable remainder too',
    previews().at(-1).args.amount === 31420000001,
    String(previews().at(-1).args.amount));

  // ...and typing takes the number back, or editing the box would silently
  // still send everything.
  await type('1');
  check('typing takes the number back from "all"',
    previews().at(-1).args.amount !== 31420000001,
    String(previews().at(-1).args.amount));

  await pick('tx-asset', 'uguild.0-5');
  d.querySelector('.tx-all').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle();
  const last = previews().at(-1);
  check('...and it works for a guild token as well',
    last.args.denom === 'uguild.0-5' && last.args.amount === 4200000,
    last.args.denom + ' ' + last.args.amount);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
w.close();
process.exit(failures ? 1 : 0);
