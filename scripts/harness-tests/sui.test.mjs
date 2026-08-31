// SUI compliance, as a ratchet.
//
// Every window in this app sits beside a pixel-art game and has to look like
// part of it. That is not taste: SUI publishes tokens for colour, spacing and
// type, and a window that hardcodes its own is a window that drifts from the
// game the next time the game moves.
//
// This is a BUDGET, not a pass/fail: the counts below are what each file had
// when the audit was written, and the only rule is that they never go up. Fix
// some, lower the number, and the ratchet holds the ground.
//
// A count is not automatically a bug — a 1px border and a 44px portrait crop
// have no token — which is exactly why this is a budget rather than a ban.
import { readFileSync, readdirSync } from 'fs';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const root = process.cwd();
const css = ['/frontend/css/sui/sui.css', '/frontend/css/main.css']
  .map((f) => readFileSync(root + f, 'utf8')).join('\n');

// What SUI actually defines. A token used but never defined renders as
// nothing — or, with a fallback, as a colour the file invented.
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));

const BUDGET = {
  // file:            hex, px
  //
  // hex: raidview and board were mostly DEAD FALLBACKS — `var(--border, #345)`
  // on tokens that exist, so the hex never rendered. Two files even gave the
  // same token different fallbacks, which is how you can tell they were
  // guesses. 83 of those are gone. What is left in board.html is three
  // agent-UI chips with no SUI equivalent (a sky blue that is not
  // --accent-secondary's periwinkle); a wrong token would be worse than an
  // honest hardcode.
  //
  // px and fontSize are the OPEN work. SUI's type scale is essentially three
  // sizes — 8, 12 and 16 — and Team Ops invented a continuous one between
  // them (8, 9, 10, 11, 12, 13). Remapping is a visible change to a console
  // people use, so it wants doing deliberately rather than in a sweep.
  'chat.html':        [2, 83],
  'chat.js':          [0, 0],
  'raidview.html':    [0, 46],
  'board.html':       [9, 99],
  'board-pages.js':   [1, 11],
  'transfer.html':    [1, 1],
  'transfer.js':      [0, 0],
  'index.html':       [0, 0],
};

console.log('\n— hardcoded values (budget: may fall, never rise)');
for (const [file, [maxHex, maxPx]] of Object.entries(BUDGET)) {
  const src = readFileSync(root + '/frontend/' + file, 'utf8');
  const hex = (src.match(/#[0-9A-Fa-f]{3,6}\b/g) || []).length;
  const px = (src.match(/: *[0-9]+px/g) || []).length;
  check(`${file}: ${hex} hex (budget ${maxHex})`, hex <= maxHex, 'went UP');
  check(`${file}: ${px} px (budget ${maxPx})`, px <= maxPx, 'went UP');
}

// These are absolute, not budgets: a token that does not exist is always a
// bug, and `xs` is a size the game itself never uses.
console.log('\n— always wrong, in any window');
const before1 = failures;
for (const file of readdirSync(root + '/frontend').filter((f) => /\.(html|js)$/.test(f) && !f.startsWith('_'))) {
  const raw = readFileSync(root + '/frontend/' + file, 'utf8');
  // Comments are stripped first: a file that DOCUMENTS the bad pattern (this
  // codebase has one) must not be reported as committing it.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const used = [...src.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((t) => !defined.has(t));
  if (unknown.length) check(`${file} uses only tokens SUI defines`, false, unknown.join(', '));
  if (/sui-icon-xs/.test(src)) check(`${file} avoids sui-icon-xs`, false, 'the webapp never uses 8px icons');
}
check('no window uses an undefined token or an 8px icon', failures === before1);

// SUI publishes THREE font families — ExtremeHazard, DirectiveZero, Inter —
// and five roles. Anything else is outside the system: Team Ops had three
// event logs in `monospace`, which is not one of them.
console.log('\n— only SUI families');
const before2 = failures;
for (const file of readdirSync(root + '/frontend').filter((f) => /\.(html|js)$/.test(f) && !f.startsWith('_'))) {
  const raw = readFileSync(root + '/frontend/' + file, 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const fams = [...src.matchAll(/font-family: *([^;'"}\n]+)/g)]
    .map((m) => m[1].trim().split(',')[0].replace(/['"]/g, '').trim())
    .filter((f) => f && f !== 'inherit');
  const alien = [...new Set(fams)].filter((f) => !['ExtremeHazard', 'DirectiveZero', 'Inter'].includes(f));
  // ONE named exception, and it is a decision rather than an oversight.
  //
  // The Team Ops door in the main window's debug panel is a π. π is U+03C0 and
  // neither bundled face has a Greek glyph, so it needs a pinned serif stack or
  // it renders differently on every OS. It has been "fixed" to an icon once
  // already and was put back deliberately: the owner wants it, and one funny
  // door does not cost the design system anything.
  //
  // Named per FILE and per FAMILY so the audit stays strict everywhere else —
  // a second Georgia in another file would still fail.
  const ALLOWED = { 'structs-config.js': ['Georgia'] };
  const unexplained = alien.filter((f) => !(ALLOWED[file] || []).includes(f));
  if (unexplained.length) check(`${file} uses only SUI's three families`, false, unexplained.join(', '));
}
check('no window reaches outside the three families', failures === before2);

// SUI has five type roles at three sizes — 8, 12 and 16. The pixel faces
// (ExtremeHazard, DirectiveZero) are used at 8 and 16 only, exact 1x and 2x of
// the design size; 12 belongs to Inter, a vector face. Team Ops and chat had
// invented a continuous scale between them (9, 10, 11, 13), which renders a
// pixel font at 1.25x and 1.375x.
console.log('\n— type sizes are SUI roles');
for (const file of ['chat.html', 'board.html', 'raidview.html', 'transfer.html']) {
  const src = readFileSync(root + '/frontend/' + file, 'utf8');
  const odd = [...new Set((src.match(/font-size: *(\d+)px/g) || [])
    .map((m) => m.match(/(\d+)/)[1])
    .filter((n) => !['8', '12', '16'].includes(n)))];
  check(`${file} uses only 8/12/16px`, odd.length === 0, odd.join(', ') + 'px');
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
