// The staged FOUND card (board-terminal-ops.js over mcp/guild_founding.rs):
// the six answers, the live preview, Review's honest account of what
// founding does to you, the background run, and the setup checklist after.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/founding.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}

async function page() {
  const dom = await JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + '?view=terminal', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  await until(() => d.getElementById('tm-cmd') && w.Board && w.Board.Terminal);
  return { w, d };
}
const card = (d) => [...d.querySelectorAll('#tm-grid [data-type="found"]')].slice(-1)[0];
const button = (root, re) => [...root.querySelectorAll('a')].find((a) => re.test(a.textContent.trim()));
const tab = (d, re) => [...card(d).querySelectorAll('.sui-screen-nav-item')].find((a) => re.test(a.textContent));
const type = (w, input, value) => { input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true })); };

// ── A first founding, answer by answer ────────────────────────────────────
{
  const { w, d } = await page();
  const calls = (n) => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === n);
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && card(d).querySelectorAll('input').length >= 3);
  let f = card(d);
  check('FOUND opens on Identity with the stages across the top',
    ['Identity', 'Members', 'Joining', 'Sign-up', 'Review'].every((s) => f.textContent.includes(s)) && /Name/.test(f.textContent));
  check('…and beside it, the card other players will see', !!f.querySelector('.tm-found-face'));
  await until(() => /name the guild/.test(card(d).textContent));
  check('an empty name is named as the one thing missing', /name the guild/.test(card(d).textContent));

  type(w, card(d).querySelector('input'), 'Iron Tide');
  await until(() => calls('terminal_found_plan_preview').some((c) => c.args.choices.name === 'Iron Tide'));
  await until(() => !/name the guild/.test(card(d).textContent));
  check('the tag fills itself from the name on the preview', /IT/.test(card(d).querySelector('.tm-found-face').textContent), card(d).querySelector('.tm-found-face').textContent);

  tab(d, /^Members/).click();
  await until(() => /Each member, when full/.test(card(d).textContent));
  f = card(d);
  check('Members sizes power in people: what each gets, and the stake', /Each member, when full/.test(f.textContent) && /recoverable/.test(f.textContent), f.textContent.slice(0, 400));
  const sel = f.querySelector('select');
  check('…offering 5 · 10 · 25 · 50, starting at 5', !!sel && sel.value === '5' && [...sel.options].map((o) => o.value).join() === '5,10,25,50');
  sel.value = '10'; sel.dispatchEvent(new w.Event('change'));
  await until(() => calls('terminal_found_plan_preview').some((c) => c.args.choices.members === 10));
  check('changing it asks again', calls('terminal_found_plan_preview').some((c) => c.args.choices.members === 10));

  // Who owns the power: inferred, shown as the founder's until chosen.
  const routeSel = () => [...card(d).querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'treasury'));
  check('Power owned by starts at the inferred route', !!routeSel() && routeSel().value === 'personal' && /Power owned by/.test(card(d).textContent));
  routeSel().value = 'treasury'; routeSel().dispatchEvent(new w.Event('change'));
  await until(() => calls('terminal_found_plan_preview').some((c) => c.args.choices.power === 'treasury') && /Guild stake/.test(card(d).textContent));
  check('choosing The guild asks again and stakes for the guild', /Guild stake/.test(card(d).textContent), card(d).textContent.slice(0, 400));
  tab(d, /^Review/).click();
  await until(() => /Fund the guild vault/.test(card(d).textContent));
  f = card(d);
  check('…Review founds first, funds and stakes the guild, then connects you',
    /1 · Found the guild/.test(f.textContent) && /3 · Fund the guild vault/.test(f.textContent) && /8 · Connect you to it/.test(f.textContent), f.textContent.slice(0, 600));
  check('…says who owns the power and how long you are without a substation',
    /Power owned bythe guild/.test(f.textContent) && /No substation/.test(f.textContent) && /7 steps after founding/.test(f.textContent));
  tab(d, /^Members/).click();
  await until(() => routeSel());
  routeSel().value = 'personal'; routeSel().dispatchEvent(new w.Event('change'));
  await until(() => calls('terminal_found_plan_preview').slice(-1)[0].args.choices.power === 'personal' && !/Guild stake/.test(card(d).textContent));

  tab(d, /^Joining/).click();
  await until(() => /Who may join/.test(card(d).textContent));
  f = card(d);
  check('Joining starts at By request, not Open', f.querySelector('select').value === 'application' && /players ask/.test(f.textContent));
  const js = f.querySelector('select');
  js.value = 'stake'; js.dispatchEvent(new w.Event('change'));
  await until(() => /Alpha infused to join/.test(card(d).textContent));
  check('Stake to join asks how much', /Alpha infused to join/.test(card(d).textContent));
  const js2 = card(d).querySelector('select');
  js2.value = 'application'; js2.dispatchEvent(new w.Event('change'));

  tab(d, /^Sign-up/).click();
  await until(() => /New players sign up/.test(card(d).textContent));
  const hs = card(d).querySelector('select');
  hs.value = 'self'; hs.dispatchEvent(new w.Event('change'));
  await until(() => /guild\.json URL/.test(card(d).textContent));
  check('My own server asks where guild.json will live', /guild\.json URL/.test(card(d).textContent));
  const hs2 = card(d).querySelector('select');
  hs2.value = 'none'; hs2.dispatchEvent(new w.Event('change'));

  tab(d, /^Review/).click();
  await until(() => /From your vault/.test(card(d).textContent));
  f = card(d);
  check('Review shows your move: guild and rank, power before → after, what you draw',
    /0-1 · #50 → new guild · #1/.test(f.textContent) && /Power share/.test(f.textContent) && /You draw/.test(f.textContent), f.textContent.slice(0, 500));
  check('…the replicants that stay behind', /42 stay in 0-1/.test(f.textContent));
  check('…the cost: founding (1 burned), the stake (recoverable), from the vault',
    /1 burned/.test(f.textContent) && /recoverable/.test(f.textContent) && /From your vault/.test(f.textContent));
  const rsel = [...f.querySelectorAll('select')].find((s) => [...s.options].some((o) => /3-15/.test(o.textContent)));
  check('…a reactor already picked, with a jailed one offered but not choosable',
    !!rsel && rsel.value === '3-15' && [...rsel.options].find((o) => /3-10/.test(o.textContent)).disabled);
  check('…every step, in order', /1 · Stake Alpha for power/.test(f.textContent) && /6 · Name the guild/.test(f.textContent));
  check('…and that there is no sign-up site yet', /no sign-up site/.test(f.textContent));
  const go = button(f, /^Found$/);
  check('Found is offered when nothing refuses', !!go && !go.classList.contains('sui-mod-disabled'));
  go.click();
  await until(() => d.querySelector('.ops-modal-overlay'));
  const ok = [...d.querySelectorAll('.ops-modal-overlay a, .ops-modal-overlay button')].find((b) => /^found$/i.test(b.textContent.trim()));
  check('Found confirms first, with the total from the vault', !!ok && /From your vault/.test(d.querySelector('.ops-modal-overlay').textContent) && !calls('terminal_found_plan_start').length);
  ok.click();
  await until(() => calls('terminal_found_plan_start').length);
  const st = calls('terminal_found_plan_start')[0];
  check('…then starts the plan with the previewed answers', !!st && st.args.choices.name === 'Iron Tide' && st.args.choices.tag === 'IT' && st.args.choices.members === 10, JSON.stringify(st && st.args));
  await until(() => /founding/.test(card(d).textContent) && /Found the guild/.test(card(d).textContent));
  check('the card turns into progress as the steps run', /Route power/.test(card(d).textContent) && /✓/.test(card(d).textContent));
}

// ── A refusal keeps Found shut ────────────────────────────────────────────
{
  const { w, d } = await page();
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && card(d).querySelectorAll('input').length >= 3);
  type(w, card(d).querySelector('input'), 'SN Corp');
  await until(() => /taken by 0-5/.test(card(d).textContent));
  check('a taken name is refused with who has it', /taken by 0-5/.test(card(d).textContent));
  tab(d, /^Review/).click();
  await until(() => button(card(d), /^Found$/));
  check('…and Found stays disabled', button(card(d), /^Found$/).classList.contains('sui-mod-disabled'));
}

// ── A plan that stopped part-way resumes ──────────────────────────────────
{
  const { w, d } = await page();
  w.__HARNESS_FOUND__ = 'failed';
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && /Resume/.test(card(d).textContent));
  const f = card(d);
  check('a stopped plan shows each step and why it stopped', /✕ Found the guild/.test(f.textContent) && /resume in a minute/.test(f.textContent) && /✓ Route power/.test(f.textContent));
  button(f, /^Resume$/).click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_found_plan_start'));
  const r = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_found_plan_start');
  check('Resume restarts the saved plan without new answers', !!r && !r.args.choices);
  // Progress arrives as an event and re-reads the card.
  const before = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_found_plan_get').length;
  w.__HARNESS_EMIT__('guild-founding', { running: true });
  await until(() => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_found_plan_get').length > before);
  check('a guild-founding event re-reads the card', (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_found_plan_get').length > before);
}

// ── Founded: the setup checklist ──────────────────────────────────────────
{
  const { w, d } = await page();
  w.__HARNESS_FOUND__ = 'done';
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && /Sign-up/.test(card(d).textContent) && /Members/.test(card(d).textContent));
  const f = card(d);
  check('once founded the card is the guild and its setup', /Iron Tide/.test(f.textContent) && /Joining · By request/.test(f.textContent) && /Power · ready for 5/.test(f.textContent) && /Officers and grants/.test(f.textContent));
  const [api, grass] = [...f.querySelectorAll('.tm-found-signup input')];
  type(w, api, 'https://tide.example/api/'); type(w, grass, 'wss://tide.example/grass');
  button(f, /^Write guild\.json$/).click();
  await until(() => /schema_version/.test((f.querySelector('.tm-found-json') || {}).textContent || ''));
  check('Write guild.json renders v1 for 0-6 with the services given', /"id": "0-6"/.test(f.querySelector('.tm-found-json').textContent) && /valid/.test(f.textContent));
  button(f, /^Check the URL$/).click();
  await until(() => /not live/.test(f.textContent));
  check('Check the URL says plainly when it is not live yet', /not live: .*404/.test(f.textContent));
}

console.log(failures ? `\n${failures} FAILED` : '\nall founding checks passed');
process.exit(failures ? 1 : 0);
