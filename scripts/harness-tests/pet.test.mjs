// The desktop companion (frontend/pet.html + pet.js).
//
//   node scripts/harness-tests/pet.test.mjs
//
// Two things are worth pinning and neither is layout:
//
//   1. WHAT IT COSTS TO DO NOTHING. This window is always on screen. droidsh
//      measured 13.22% of a core on a display-link schedule against 2.37% on a
//      one-second one, so "no requestAnimationFrame in the idle path" is a
//      correctness property here, not a preference.
//   2. WHAT IT CLAIMS. An unconfirmed figure must render as an em dash and
//      never as a zero — a zero is a claim, and one wrong claim costs the
//      reader their trust in every other reading on the window.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
const page = resolve(repo, 'frontend', 'pet.html');
if (!existsSync(page)) { console.error('missing frontend/pet.html'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

// ── Source rules ─────────────────────────────────────────────────────────
{
  const js = read('frontend/pet.js');
  // Comments stripped: the rule is about what RUNS, and the file explains the
  // rule in prose right at the top.
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the idle path never uses requestAnimationFrame',
    !/requestAnimationFrame/.test(code));
  check('…it is one interval, at one second',
    /IDLE_MS\s*=\s*1000/.test(code) && (code.match(/setInterval\(/g) || []).length <= 2,
    String((code.match(/setInterval\(/g) || []).length) + ' setInterval calls');
  check('…and the celebration ends itself rather than running forever',
    /clearInterval\(sparkTimer\)/.test(code) && /SPARK_MS\s*=\s*3000/.test(code));
  check('reduced motion turns the movement off',
    /prefers-reduced-motion/.test(code) && /if \(reduced\) return;/.test(code));

  const html = read('frontend/pet.html');
  // All four, in order. Linking only main.css gets the colours but neither the
  // font nor any SUI component, and the window renders as a plain web form
  // beside pixel art.
  const order = ['css/normalize.css', 'css/structicons.css', 'css/sui/sui.css', 'css/main.css']
    .map((f) => html.indexOf(f));
  check('the page links all four stylesheets, in order',
    order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), order.join(','));

  /* `data-tauri-drag-region` must NOT be how this window moves.
   *
   * Tauri's injected handler (tauri/src/window/scripts/drag.js) tests
   * `e.target.getAttribute('data-tauri-drag-region')` — the EXACT target, with
   * no walk up the tree. The drag surface here is a div full of <img> layers,
   * so the target is always an image, the attribute is never found, and the
   * window is pinned to wherever it first opened. It shipped that way once.
   * The attribute looks like it works, which is what makes it worth pinning.
   */
  check('the window does not rely on a drag region its own children defeat',
    !/data-tauri-drag-region/.test(html));
  check('…it asks the window to drag itself, from a mousedown on the portrait',
    /nodes\.portrait\.addEventListener\('mousedown'/.test(code)
      && /startDragging|companion_drag/.test(code));

  /* An always-on-top window with no close control is a window somebody has to
   * quit the app to be rid of. */
  check('there is a close control on the pet itself',
    /id="pet-close"/.test(html) && /icon-close/.test(html));
  check('…and Escape does the same thing',
    /'Escape'/.test(code) && /companion_dismiss/.test(code));

  const css = read('frontend/pet.css');
  check('nothing paints a ground behind the window — the desktop IS the ground',
    /html, body\.pet-body \{[^}]*background: transparent/.test(css));
  // main.css centres the body; it bites the moment a block goes full width.
  check('…and the body sets its own alignment', /text-align: left/.test(css));
  // A var(--x, #fallback) lets a token name that does not exist render as a
  // colour somebody invented, and the window then looks almost right.
  check('no colour is a made-up fallback', !/var\(--[a-z0-9-]+,/.test(css));
  const tokens = [...new Set((css.match(/var\(--[a-z0-9-]+/g) || []).map((t) => t.slice(4)))];
  const sui = read('frontend/css/sui/sui.css') + read('frontend/css/main.css');
  const undefinedTokens = tokens.filter((t) => !sui.includes(t + ':'));
  check('every token it uses actually exists', undefinedTokens.length === 0,
    undefinedTokens.join(', '));
}

// ── The window ───────────────────────────────────────────────────────────
const calls = [];
const dom = await JSDOM.fromFile(page, {
  url: pathToFileURL(page).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(win) {
    win.__TAURI__ = {
      core: { invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve({}); } },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  },
});
const w = dom.window, d = w.document;
await new Promise((r) => setTimeout(r, 400));

const Pet = w.StructsPet;
check('the companion boots', !!Pet);

if (Pet) {
  /* ── Silence is the default ──────────────────────────────────────────────
   *
   * This window sits on top of whatever the player is doing. The first
   * version filled it with a rate, a Goal/Work toggle and their own player
   * id — all true, none of it worth interrupting anyone for, and it read as
   * a grey slab parked on their screen. A quiet colony must be a character
   * and NO text.
   */
  Pet.apply({ note: null, tone: '', pfp: null });
  check('a quiet colony says nothing at all',
    d.getElementById('pet-note').hidden === true
      && text(d.getElementById('pet-note')) === '');
  check('…but the character is still there', d.querySelector('#pet-portrait .pc-pfp') !== null);
  check('…and nothing on it names the player to themselves',
    !/1-194|MARKLIFER/i.test(text(d.getElementById('pet'))), text(d.getElementById('pet')));

  // Something broken, which is what this window is FOR.
  Pet.apply({ note: 'Signing is wedged', tone: 'bad', door: 'board' });
  check('a problem gets words', d.getElementById('pet-note').hidden === false
    && text(d.getElementById('pet-note')) === 'Signing is wedged');
  check('…and is marked as a problem, not just phrased as one',
    d.getElementById('pet').classList.contains('pet-mod-bad'));
  d.getElementById('pet-note').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('…and opens what it is about',
    calls.some((c) => c.cmd === 'companion_open' && c.args.what === 'board'));

  // Money owed — the other thing nothing else in the app will nag about.
  Pet.apply({ note: '90μg owed', tone: '', door: 'crewpay' });
  check('an unpaid helper gets words too', text(d.getElementById('pet-note')) === '90μg owed');
  check('…without being dressed as a failure',
    !d.getElementById('pet').classList.contains('pet-mod-bad'));

  // And it has to go quiet again.
  Pet.apply({ note: null, tone: '' });
  check('…and the words go away when the reason does',
    d.getElementById('pet-note').hidden === true);

  check('the companion signs nothing and spends nothing',
    !calls.some((c) => /transfer|settle|grant|revoke|sign/i.test(c.cmd)),
    calls.map((c) => c.cmd).join(','));

  /* Moving it and closing it, driven the way a person drives them.
   *
   * The drag assertion is deliberately about the EVENT, not the attribute: a
   * mousedown on the portrait must reach the window however that is plumbed,
   * because the previous plumbing looked correct and did nothing.
   */
  {
    const before = calls.length;
    const port = d.getElementById('pet-portrait');
    // Mousedown on a CHILD of the drag surface — an image layer — which is
    // what the pointer actually lands on and what defeated the old approach.
    const inner = port.querySelector('.pc-pfp') || port;
    inner.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    check('dragging works when the pointer lands on the portrait’s art, not just its box',
      calls.slice(before).some((c) => c.cmd === 'companion_drag'),
      calls.slice(before).map((c) => c.cmd).join(',') || 'nothing invoked');
  }
  {
    const before = calls.length;
    d.getElementById('pet-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check('the close control puts it away',
      calls.slice(before).some((c) => c.cmd === 'companion_dismiss'));
  }
  {
    const before = calls.length;
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('…and so does Escape', calls.slice(before).some((c) => c.cmd === 'companion_dismiss'));
    const after = calls.length;
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    check('…while any other key leaves it alone', calls.length === after);
  }

  // A portrait is five <img> layers; rebuilding it every push is a request
  // storm and a flicker, and it almost never changes.
  const before = d.querySelector('#pet-portrait .pc-pfp');
  Pet.apply({ note: 'still going' });
  check('an unchanged portrait is not redrawn',
    d.querySelector('#pet-portrait .pc-pfp') === before);
}

dom.window.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
