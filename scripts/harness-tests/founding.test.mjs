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
  const last = () => calls('terminal_found_plan_preview').slice(-1)[0].args.choices;
  const rows = (root) => [...root.querySelectorAll('.tm-pick .sui-result-row')];
  const rowOf = (re) => rows(card(d)).find((r) => re.test(r.textContent));
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && card(d).querySelectorAll('input').length >= 3);
  let f = card(d);
  check('FOUND opens on Identity with the stages across the top',
    ['Identity', 'Reactor', 'Substation', 'Joining', 'Sign-up', 'Review'].every((s) => f.textContent.includes(s)) && /Name/.test(f.textContent));
  check('…and beside it, the card other players will see', !!f.querySelector('.tm-found-face'));
  await until(() => /name the guild/.test(card(d).textContent));
  check('an empty name is named as the one thing missing', /name the guild/.test(card(d).textContent));

  type(w, card(d).querySelector('input'), 'Iron Tide');
  await until(() => calls('terminal_found_plan_preview').some((c) => c.args.choices.name === 'Iron Tide'));
  await until(() => !/name the guild/.test(card(d).textContent));
  check('the tag fills itself from the name on the preview', /IT/.test(card(d).querySelector('.tm-found-face').textContent), card(d).querySelector('.tm-found-face').textContent);
  check('the face carries the id the guild will get', /0-6/.test(card(d).querySelector('.tm-found-face').textContent));

  // Reactor: a list, not an id to type.
  tab(d, /^Reactor/).click();
  await until(() => rowOf(/Orbital Hydro/));
  f = card(d);
  check('Reactor lists validators by name with rank, share, infusers and the cut',
    /Orbital Hydro/.test(f.textContent) && /#1 · 19.5%/.test(f.textContent) && /16 infusers/.test(f.textContent) && /4%/.test(f.textContent), f.textContent.slice(0, 500));
  check('…the picked one framed, a jailed one left out of the list', rowOf(/sn-corp/).classList.contains('is-selected') && !rowOf(/kilgore/) && /1 jailed · 3-10/.test(f.textContent));
  rowOf(/Orbital Hydro/).click();
  await until(() => last().reactor === '3-1' && rowOf(/Orbital Hydro/) && rowOf(/Orbital Hydro/).classList.contains('is-selected'));
  f = card(d);
  check('picking one asks again and shows its terms', last().reactor === '3-1' && /you keep 96%/.test(f.textContent) && /Validator fee/.test(f.textContent) && /oh\.energy/.test(f.textContent));

  // Substation: build one, one of yours, or none — never one you cannot connect.
  tab(d, /^Substation/).click();
  await until(() => rowOf(/New · yours/));
  f = card(d);
  check('Substation offers building one, yours or granted, and none',
    !!rowOf(/New · yours/) && !!rowOf(/New · the guild/) && !!rowOf(/^4-17/) && !!rowOf(/None · set later/), f.textContent.slice(0, 500));
  check('…a substation without a connect grant is shown but inert', rowOf(/^4-1 /).classList.contains('is-disabled') && /ask 1-1/.test(rowOf(/^4-1 /).textContent) && /No connect grant · 1/.test(f.textContent));
  check('…an unpowered one says so', /no power/.test(rowOf(/^4-16/).textContent));
  const sel = f.querySelector('select');
  check('…ready for 5 · 10 · 25 · 50, starting at 5', !!sel && sel.value === '5' && [...sel.options].map((o) => o.value).join() === '5,10,25,50');
  sel.value = '10'; sel.dispatchEvent(new w.Event('change'));
  await until(() => last().members === 10);
  check('changing it asks again', last().members === 10);
  rowOf(/^4-17/).click();
  await until(() => last().substation === '4-17' && /4-17: low each/.test(card(d).textContent));
  check('picking 4-17 asks again and warns it is too small', /4-17: low each/.test(card(d).textContent));
  rowOf(/New · the guild/).click();
  await until(() => last().substation === 'new' && last().power === 'treasury' && rowOf(/New · the guild/).classList.contains('is-selected'));
  check('the guild\'s own new substation is the treasury route', last().power === 'treasury');
  tab(d, /^Review/).click();
  await until(() => /Fund the guild vault/.test(card(d).textContent));
  f = card(d);
  check('…Review founds first, funds and stakes the guild, then connects you',
    /1 · Found the guild/.test(f.textContent) && /3 · Fund the guild vault/.test(f.textContent) && /8 · Connect you to it/.test(f.textContent), f.textContent.slice(0, 600));
  check('…and how long you are without a substation', /No substation/.test(f.textContent) && /7 steps after founding/.test(f.textContent));
  tab(d, /^Substation/).click();
  await until(() => rowOf(/New · yours/));
  rowOf(/New · yours/).click();
  await until(() => last().power === 'personal' && rowOf(/New · yours/).classList.contains('is-selected'));

  tab(d, /^Joining/).click();
  await until(() => /Who may join/.test(card(d).textContent));
  f = card(d);
  check('Joining starts at By request, not Open', f.querySelector('select').value === 'application' && /players ask/.test(f.textContent));
  const js = f.querySelector('select');
  js.value = 'stake'; js.dispatchEvent(new w.Event('change'));
  await until(() => /Alpha infused to join/.test(card(d).textContent));
  check('Stake to join asks how much, and says where stakes land', /Alpha infused to join/.test(card(d).textContent) && /Lands on3-1/.test(card(d).textContent));
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
  await until(() => /Your vault/.test(card(d).textContent) && last().hosting === 'none');
  f = card(d);
  check('Review shows the reactor and substation picked, each opening its stage',
    !!rowOf(/Orbital Hydro · 3-1/) && !!rowOf(/New · yours/));
  check('…your move: guild and rank, substation, connection, what you draw',
    /0-1 · #50 → 0-6 · #1/.test(f.textContent) && /4-1 → the new one/.test(f.textContent) && /Connection/.test(f.textContent) && /You draw/.test(f.textContent), f.textContent.slice(0, 600));
  check('…the replicants that stay behind', /42 stay in 0-1/.test(f.textContent));
  check('…the cost: 1 burned, 1 backing the token, the stake, the fee, the vault after',
    /1g burned/.test(f.textContent) && /1g backs the guild token/.test(f.textContent) && /recoverable/.test(f.textContent) && /Network fee/.test(f.textContent) && /Your vault/.test(f.textContent));
  check('…the treasury at founding: 1 token, 1 Alpha behind it, no power yet',
    /Treasury of 0-6/.test(f.textContent) && /1 guild\.0-6/.test(f.textContent) && /1g behind 1 token/.test(f.textContent) && /Guild power0 W/.test(f.textContent), f.textContent.slice(0, 900));
  check('…every step, in order', /1 · Stake Alpha for power/.test(f.textContent) && /6 · Name the guild/.test(f.textContent));
  check('…and every warning with the stage that fixes it',
    /no sign-up site/.test(f.textContent) && !!button(f.querySelector('.tm-found-status'), /^Sign-up$/));
  button(f.querySelector('.tm-found-status'), /^Sign-up$/).click();
  await until(() => /New players sign up/.test(card(d).textContent));
  check('…a fix door goes to its stage', /New players sign up/.test(card(d).textContent));
  tab(d, /^Review/).click();
  await until(() => button(card(d), /^Found/));
  f = card(d);
  const go = button(f, /^Found/);
  check('Found is offered when nothing refuses, with what it takes', !!go && !go.classList.contains('sui-mod-disabled') && /Found · /.test(go.textContent));
  go.click();
  await until(() => d.querySelector('.ops-modal-overlay'));
  const ok = [...d.querySelectorAll('.ops-modal-overlay a, .ops-modal-overlay button')].find((b) => /^found$/i.test(b.textContent.trim()));
  const modal = d.querySelector('.ops-modal-overlay').textContent;
  check('Found confirms first: reactor, substation, and the total from the vault',
    !!ok && /From your vault/.test(modal) && /3-1/.test(modal) && /a new one/.test(modal) && !calls('terminal_found_plan_start').length, modal);
  ok.click();
  await until(() => calls('terminal_found_plan_start').length);
  const st = calls('terminal_found_plan_start')[0];
  check('…then starts the plan with the previewed answers',
    !!st && st.args.choices.name === 'Iron Tide' && st.args.choices.tag === 'IT' && st.args.choices.members === 10 && st.args.choices.reactor === '3-1', JSON.stringify(st && st.args));
  await until(() => /✓ Route power/.test(card(d).textContent), 15000);
  check('the card turns into progress as the steps run', /Route power/.test(card(d).textContent) && /✓/.test(card(d).textContent));
}

// ── Founding onto a substation you already own ────────────────────────────
{
  const { w, d } = await page();
  const calls = (n) => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === n);
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && card(d).querySelectorAll('input').length >= 3);
  type(w, card(d).querySelector('input'), 'Iron Tide');
  tab(d, /^Substation/).click();
  await until(() => [...card(d).querySelectorAll('.tm-pick .sui-result-row')].find((r) => /^None/.test(r.textContent)));
  [...card(d).querySelectorAll('.tm-pick .sui-result-row')].find((r) => /^None/.test(r.textContent)).click();
  await until(() => calls('terminal_found_plan_preview').slice(-1)[0].args.choices.substation === 'none' && /joiners get no connection until/.test(card(d).textContent));
  check('None founds with a warning, not a refusal', /joiners get no connection until/.test(card(d).textContent));
  tab(d, /^Review/).click();
  await until(() => /1 · Found the guild/.test(card(d).textContent));
  const f = card(d);
  check('…and builds nothing: found, policy, name', /1 · Found the guild/.test(f.textContent) && /3 · Name the guild/.test(f.textContent) && !/Route power/.test(f.textContent) && /No entry substation/.test(f.textContent));
}

// ── A founder founds, so the primary stays where it is ───────────────────
{
  const { w, d } = await page();
  const calls = (n) => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === n);
  const last = () => ((calls('terminal_found_plan_preview').slice(-1)[0] || { args: { choices: {} } }).args.choices);
  const rowOf = (re) => [...card(d).querySelectorAll('.tm-pick .sui-result-row')].find((r) => re.test(r.textContent));
  w.Board.Terminal.execute('FOUND');
  await until(() => card(d) && card(d).querySelectorAll('input').length >= 3);
  const by = [...card(d).querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'new'));
  check('Identity asks who founds, starting at you', !!by && by.value === 'you' && /Founded by/.test(card(d).textContent));
  by.value = 'new'; by.dispatchEvent(new w.Event('change'));
  await until(() => last().founder === 'new' && /KESTREL-3001/.test(card(d).textContent));
  let f = card(d);
  check('…a new founder is named, with what it is funded and where you stay',
    /KESTREL-3001 · a new replicant/.test(f.textContent) && /Funded from your vault/.test(f.textContent) && /You stay0-1 · #50 · on 4-1/.test(f.textContent), f.textContent.slice(0, 600));
  type(w, [...card(d).querySelectorAll('input')][0], 'Iron Tide');
  tab(d, /^Substation/).click();
  await until(() => rowOf(/^4-17/));
  check('…only a substation you own can be handed to the founder', /Yours · handed to the founder/.test(card(d).textContent) && rowOf(/^4-1 /).classList.contains('is-disabled'));
  rowOf(/^4-17/).click();
  await until(() => last().substation === '4-17' && /You stay on4-1/.test(card(d).textContent));
  tab(d, /^Review/).click();
  await until(() => /Create the founder/.test(card(d).textContent));
  f = card(d);
  check('…Review makes, funds and grants the founder, founds, then hands you the controls',
    /1 · Create the founder/.test(f.textContent) && /2 · Fund the founder/.test(f.textContent) && /3 · Let the founder use your substation/.test(f.textContent)
    && /4 · Found the guild/.test(f.textContent) && /7 · Give you the guild's controls/.test(f.textContent), f.textContent.slice(0, 900));
  check('…and shows the founder apart from you, who stays put',
    /FounderWhoKESTREL-3001 · owns 0-6 · #1/.test(f.textContent) && /Grantedconnect on 4-17/.test(f.textContent) && /Guild0-1 · #50 · stays/.test(f.textContent) && /Controlsevery guild permission on 0-6/.test(f.textContent), f.textContent.slice(0, 900));
  button(card(d), /^Found/).click();
  await until(() => d.querySelector('.ops-modal-overlay'));
  check('…the confirm says a founder founds and you stay', /a new founder; you stay in 0-1/.test(d.querySelector('.ops-modal-overlay').textContent));
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
  await until(() => button(card(d), /^Found/));
  check('…and Found stays disabled', button(card(d), /^Found/).classList.contains('sui-mod-disabled'));
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
