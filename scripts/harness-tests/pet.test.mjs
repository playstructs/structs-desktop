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

  // A window-wide drag region swallows every click on the controls above it.
  check('only the portrait is a drag surface',
    (html.match(/data-tauri-drag-region/g) || []).length === 1
      && /id="pet-portrait"[^>]*data-tauri-drag-region/.test(html));

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
  // Nothing confirmed yet.
  Pet.apply({ line1: '— α / h', line2: '', player_id: '1-194', pfp: null, face: 'goal' });
  check('an unconfirmed rate is an em dash, not a zero',
    text(d.getElementById('pet-line1')) === '— α / h'
      && !/0/.test(text(d.getElementById('pet-line1'))));
  check('it knows whose colony it is', text(d.getElementById('pet-name')) === '1-194');
  check('…and draws a portrait even with no attributes on chain',
    d.querySelector('#pet-portrait .pc-pfp') !== null);

  // Trouble has to be visible without reading the words.
  Pet.apply({ line1: 'Work needs attention', line2: 'signing is wedged', trouble: 'signing is wedged' });
  check('trouble marks the whole bubble, not just the text',
    d.getElementById('pet').classList.contains('pet-mod-trouble'));
  check('…and the detail is on hover rather than wrapped across the window',
    d.getElementById('pet-bubble').title === 'signing is wedged');

  // Working.
  Pet.apply({ line1: 'Helping', line2: '3 running · 12 finished', trouble: '', crew_helped: 12 });
  check('a working crew says what it is doing',
    text(d.getElementById('pet-line1')) === 'Helping'
      && /3 running/.test(text(d.getElementById('pet-line2'))));
  check('…and trouble clears when it is over',
    !d.getElementById('pet').classList.contains('pet-mod-trouble'));

  // The face toggle is the game's own nav item, and switching it tells Rust.
  const faces = [...d.querySelectorAll('#pet-faces .sui-screen-nav-item')];
  check('the two faces are the game’s nav items', faces.length === 2
    && faces.map((f) => text(f)).join(',') === 'Goal,Work');
  faces[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('…and choosing one is remembered in Rust, not just on screen',
    calls.some((c) => c.cmd === 'companion_face' && c.args.face === 'work'));

  // Every door opens a window that is allowed to act. The pet acts on nothing.
  d.getElementById('pet-bubble').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('the bubble opens the colony', calls.some((c) => c.cmd === 'companion_open' && c.args.what === 'board'));
  d.getElementById('pet-name').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('…and the name opens the crew', calls.some((c) => c.cmd === 'companion_open' && c.args.what === 'crew'));
  check('the companion signs nothing and spends nothing',
    !calls.some((c) => /transfer|settle|grant|revoke|sign/i.test(c.cmd)),
    calls.map((c) => c.cmd).join(','));

  // A portrait is five <img> layers; rebuilding it every push is a request
  // storm and a flicker, and it almost never changes.
  const before = d.querySelector('#pet-portrait .pc-pfp');
  Pet.apply({ line1: 'Helping', line2: 'still going' });
  check('an unchanged portrait is not redrawn',
    d.querySelector('#pet-portrait .pc-pfp') === before);
}

dom.window.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
