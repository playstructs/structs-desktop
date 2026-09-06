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
  // file:            colour, px
  //
  // "colour" counts `#rrggbb` AND `rgba()`/`hsl()`. It used to count only the
  // first, so the numbers below jumped when the second was added — nothing got
  // worse, the audit simply started seeing what was already there. Those are
  // the OPEN work: `board.html` and `structs-config.js` carry most of them.
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
  'chat.html':          [0, 65],
  'chat.js':            [0, 0],
  // The sections extracted from chat.js (2026-09-05) and the shared
  // listener helper: built with textContent and tokens, no pixels of their own.
  'chat-commands.js':   [0, 0],
  'chat-complete.js':   [0, 0],
  'chat-reactions.js':  [0, 0],
  'chat-refs.js':       [0, 0],
  'chat-work.js':       [0, 0],
  'chat-channels.js':   [0, 0],
  'chat-search.js':     [0, 0],
  'chat-people.js':     [0, 0],
  'chat-connection.js': [0, 0],
  'chat-pins.js':       [0, 0],
  'chat-presence.js':   [0, 0],
  'events.js':          [0, 0],
  'raidview.html':      [3, 45],
  // Four ambit background colours, copied from main.css and commented as
  // such. Only `space` (#222034) has a token — it is `--surface-default` —
  // and swapping one of four for a token would make the group inconsistent
  // for no gain. This is the "a count is not a bug" case in the header.
  'raidview.js':        [4, 0],
  // 2026-09-06: +8 for the Game Stats chart family (axis figures, ticks,
  // meter, battery columns) — the type sizes are 8/16 on the scale and the
  // rest are sizes SUI has no token for (a 6px track, a 20px column). Raised
  // deliberately, once; the ratchet holds from here.
  'board.html':         [2, 95],
  'board.js':           [0, 0],
  'board-pages.js':     [3, 11],
  // The 1px is `minmax(420px, 1fr)` — a column BREAKPOINT, which is not
  // spacing and has no token.
  'board-gamestats.js': [0, 1],
  'board-shim.js':      [0, 0],
  // The debug-tab patch INJECTED INTO THE GAME'S OWN WINDOW, so it renders
  // inches from the real UI — and it was the least audited file in the repo.
  // These numbers are where it stood when it was first measured, not an
  // endorsement of them.
  'structs-config.js':  [10, 34],
  'transfer.html':      [0, 1],
  'transfer.js':        [0, 0],
  'chatrow.js':         [0, 0],
  'pfp.js':             [0, 0],
  'units.js':           [0, 0],
  'playercard.js':      [0, 0],
  'guildcard.js':       [0, 0],
  'providercard.js':    [0, 0],
  // Hand-authored stylesheets live beside the windows (css/ is regenerated)
  // and are audited the same way. The px here are the portrait's native 72px
  // art, 32px icon doors, a 6px presence dot and 1px hairlines.
  'playercard.css':     [0, 23],
  'chat-rows.css':      [0, 19],
  // The guild emblem (72px / 24px) and its 1px frame.
  'guildcard.css':      [0, 10],
  // The owner line's 24px portrait and the unit/owner type sizes.
  'providercard.css':   [0, 2],
  'ui-telemetry.js':    [0, 0],
  'index.html':         [0, 0],
};

/* Every window file, not a hand-kept list.
 *
 * The budget list used to be typed out by hand, and a file simply absent from
 * it was silently unaudited — which is how `structs-config.js` accumulated 14
 * hardcoded colours and three off-scale type sizes while the suite reported
 * "all checks passed". A new file must not be able to join the app without
 * joining the audit, so an unlisted file is now a FAILURE, not a skip.
 */
console.log('\n— hardcoded values (budget: may fall, never rise)');
const windowFiles = readdirSync(root + '/frontend')
  .filter((f) => /\.(html|js|css)$/.test(f) && !f.startsWith('_'))
  .sort();
const unlisted = windowFiles.filter((f) => !(f in BUDGET));
check('every window file has a budget', unlisted.length === 0,
  unlisted.join(', ') + ' — add it to BUDGET at its current count');
const gone = Object.keys(BUDGET).filter((f) => !windowFiles.includes(f));
check('every budgeted file still exists', gone.length === 0, gone.join(', '));

/* Comments are stripped before counting, for the reason the token check below
 * already gives: a file that DOCUMENTS a value must not be reported as using
 * one. A comment explaining why `.sui-screen-battery` is `width: 36px` counted
 * as a hardcoded px and pushed two files over budget.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

for (const file of windowFiles) {
  const [maxHex, maxPx] = BUDGET[file] || [0, 0];
  const src = code(readFileSync(root + '/frontend/' + file, 'utf8'));
  /* `rgba()` counts as a hardcoded colour too.
   *
   * The budget only ever matched `#rrggbb`, so a colour written as
   * `rgba(120,180,255,.12)` was invisible to it — which is how the Team Ops
   * progress bar painted a fill no token defines, past an audit that reported
   * zero hardcoded colours for that file.
   */
  /* `#feed` is not a colour.
   *
   * `#[0-9A-Fa-f]{3,6}\b` matched the ID selectors `#feed-list` and
   * `#feed-alerts` — "feed" is four hex digits and `\b` is happy to stop at
   * the hyphen. Six phantom colours in board.html, which made the file look
   * dirtier than it is and would have sent a later pass hunting for them.
   * `#face`, `#dad`, `#beef`, `#cafe` are all the same trap.
   *
   * A colour literal ends the token: nothing word-ish, and no hyphen, may
   * follow it.
   */
  const hex = (src.match(/#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z_-])/g) || []).length
    + (src.match(/\b(?:rgba?|hsla?)\(/g) || []).length;
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

/* A `var(--x, fallback)` on a token that EXISTS is dead code.
 *
 * Nine of them were removed in one pass, and two disagreed with their own
 * token — `--form-input-height-total` is 40px where the fallback said 32px,
 * and `--border` is #5D7E90 where the fallback said #345. Unreachable today,
 * and silently WRONG the day a token is renamed: the app would quietly switch
 * to the fallback instead of failing visibly, which is the opposite of what a
 * fallback is for.
 *
 * A fallback on a token nothing defines is legitimate — that is a value set at
 * runtime — so this only fires when the token is really there.
 */
const beforeFallback = failures;
for (const file of windowFiles) {
  const raw = readFileSync(root + '/frontend/' + file, 'utf8');
  const src = code(raw);
  const dead = [...new Set([...src.matchAll(/var\((--[a-z0-9-]+), *[^)]+\)/g)]
    .map((m) => m[1])
    .filter((t) => defined.has(t)))];
  if (dead.length) {
    check(`${file} has no dead var() fallbacks`, false,
      dead.join(', ') + ' — the token is defined, so the fallback can never render');
  }
}
check('no window carries a dead var() fallback', failures === beforeFallback);

// SUI publishes THREE font families — ExtremeHazard, DirectiveZero, Inter —
// and five roles. Anything else is outside the system: Team Ops had three
// event logs in `monospace`, which is not one of them.
/* Every `sui-*` class a window uses must be one SUI actually defines.
 *
 * An invented one is INVISIBLE: it renders as an unstyled div, which looks like
 * a styling mistake rather than a typo. The Pay window's player cards used
 * `sui-result-row-body`, `-title` and `-subtitle` — none of which exist — and
 * rendered as giant unstyled text beside a portrait, while every test passed.
 *
 * The rule is the same one that already governs CSS tokens here: if SUI does
 * not define it, we are inventing, and the game will not look like the game.
 */
/* Pixel art has square corners.
 *
 * SUI sets `border-radius: 0` FOURTEEN separate times — it squares every
 * corner on purpose, because a rounded one is a shape the tileset cannot draw
 * and reads as a web widget dropped into the game. Our agent-UI surfaces had
 * 8px and 6px radii on cards, chips, toasts and buttons.
 */
/* Spacing comes off SUI's scale.
 *
 * `--spacing-xs/sm/md/lg/xl/xxl/xxxl` = 2/4/8/12/16/24/32. A `padding:6px` or
 * `margin-top:10px` is a value nobody chose twice — it lands between two rungs
 * and drifts a panel out of step with every other panel.
 *
 * 1px is allowed, and is not an exception so much as a different thing: this
 * is pixel art at 1x, where one device pixel is the atom a hairline inset is
 * measured in. Everything else must be a rung.
 */
/* A box-sizing exemption must NAME its components.
 *
 * Our windows reset `*` to `border-box`, and all of our own layout is built on
 * that. A few SUI components are sized to a fixed CONTENT width and need the
 * browser default back — `.sui-screen-battery` is `width: 36px` holding five
 * 4px chunks and four 4px gaps exactly.
 *
 * Exempting every `sui-*` class was the first attempt, and it broke the whole
 * window: anything at `width: 100%` then added its padding and border OUTSIDE
 * that 100% and overflowed its parent by exactly that much —
 * `.sui-data-card-body` by 34px, `.sui-page-body-screen` by 20px — so
 * `#board-layout` silently clipped 26px off the right of every page. jsdom
 * does no layout, so the whole suite stayed green through it.
 *
 * The shape of the mistake is checkable even though the layout is not: a
 * content-box rule whose selector is a wildcard rather than a list of names.
 */
console.log('\n— box-sizing exemptions are named');
const beforeBox = failures;
for (const file of windowFiles) {
  const src = code(readFileSync(root + '/frontend/' + file, 'utf8'));
  for (const m of src.matchAll(/([^{}]*)\{[^{}]*box-sizing: *content-box[^{}]*\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    // `[class^="sui-"]`, `[class*=" sui-"]`, `*` — anything matching by shape.
    if (/\[class|^\*|[\s,]\*/.test(sel)) {
      check(`${file} names its content-box exemptions`, false,
        sel.slice(0, 90) + ' — list the components; a wildcard catches every '
        + '`width: 100%` SUI component and overflows its parent');
    }
  }
}
check('no window exempts box-sizing by wildcard', failures === beforeBox);

console.log('\n— spacing is on the scale');
const SPACING = new Set(['0', '1', '2', '4', '8', '12', '16', '24', '32']);
const beforeSpacing = failures;
for (const file of windowFiles) {
  const src = code(readFileSync(root + '/frontend/' + file, 'utf8'));
  const off = [];
  for (const m of src.matchAll(
    /\b(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?: *([^;'"}\n]+)/g)) {
    for (const v of m[2].matchAll(/(\d+)px/g)) {
      if (!SPACING.has(v[1])) off.push(`${m[1]}:${v[1]}px`);
    }
  }
  if (off.length) {
    check(`${file} spaces on the scale`, false, [...new Set(off)].join(', '));
  }
}
check('no window invents a spacing value', failures === beforeSpacing);

console.log('\n— nothing is rounded');
const beforeRadius = failures;
for (const file of windowFiles) {
  const src = code(readFileSync(root + '/frontend/' + file, 'utf8'));
  const rounded = [...new Set((src.match(/border-radius: *[^;'"}\n]+/g) || [])
    .filter((r) => !/:\s*0\b/.test(r)))];
  if (rounded.length) check(`${file} keeps its corners square`, false, rounded.join(', '));
}
check('no window rounds a corner', failures === beforeRadius);

console.log('\n— only classes SUI defines');
const suiCss = readFileSync(root + '/frontend/css/sui/sui.css', 'utf8')
  + readFileSync(root + '/frontend/css/structicons.css', 'utf8')
  + readFileSync(root + '/frontend/css/main.css', 'utf8');
const definedClasses = new Set(
  [...suiCss.matchAll(/\.(sui-[a-z0-9-]+)/g)].map((m) => m[1]));
// Ours too: a few `sui-`-prefixed classes are declared by our own windows.
for (const f of windowFiles) {
  const src = readFileSync(root + '/frontend/' + f, 'utf8');
  for (const m of src.matchAll(/\.(sui-[a-z0-9-]+)\s*[,{:]/g)) definedClasses.add(m[1]);
}
const beforeCls = failures;
for (const file of windowFiles) {
  const raw = readFileSync(root + '/frontend/' + file, 'utf8');
  const src = code(raw);
  const used = new Set();
  // class="a b c" in markup, and el('div', 'a b c') / className = 'a b' in JS.
  for (const m of src.matchAll(/(?:class(?:Name)?\s*=\s*|classList\.(?:add|toggle|contains)\()['"]([^'"]*)['"]/g)) {
    m[1].split(/\s+/).forEach((c) => { if (c.startsWith('sui-')) used.add(c); });
  }
  for (const m of src.matchAll(/el\(\s*'[a-z]+'\s*,\s*'([^']*)'/g)) {
    m[1].split(/\s+/).forEach((c) => { if (c.startsWith('sui-')) used.add(c); });
  }
  /* Known debt, ratcheted rather than waived — each is a real invented class
   * with a real replacement, listed so the check can pass today and refuse to
   * grow. Removing one from here must make the file pass, not fail.
   */
  // Empty, and kept so the next invented class has somewhere to be recorded
  // deliberately rather than waved through.
  const CLASS_DEBT = {};
  const invented = [...used]
    // A trailing `-` is a concatenation fragment (`'sui-icon-' + name`), not a
    // class anyone applies. Matching it would report the extractor, not the code.
    .filter((c) => !c.endsWith('-'))
    .filter((c) => !(CLASS_DEBT[file] || []).includes(c))
    .filter((c) => !definedClasses.has(c));
  // A waiver that stops being true is worse than none.
  const stale = (CLASS_DEBT[file] || []).filter((c) => definedClasses.has(c) || !used.has(c));
  if (stale.length) {
    check(`${file}: CLASS_DEBT is still true`, false,
      'no longer invented/used: ' + stale.join(', ') + ' — remove from CLASS_DEBT');
  }
  if (invented.length) {
    check(`${file} uses only classes SUI defines`, false, invented.join(', '));
  }
}
check('no window invents a sui-* class', failures === beforeCls);

console.log('\n— only SUI families');
const before2 = failures;
for (const file of readdirSync(root + '/frontend').filter((f) => /\.(html|js)$/.test(f) && !f.startsWith('_'))) {
  const raw = readFileSync(root + '/frontend/' + file, 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  /* The `font:` SHORTHAND counts too.
   *
   * This check only ever read `font-family`, so
   * `font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif` walked
   * straight past it — the OS's UI font, over a pixel-art game, on the update
   * bar that appears before anything else on startup.
   *
   * The shorthand's family is everything after the size/line-height, so the
   * first token that is not a number, a keyword or a `/` starts it.
   */
  const shorthand = [...src.matchAll(/\bfont: *[^;'"}\n]*?(?:\d[^ ;'"}\n]*) +([^;'"}\n]+)/g)]
    .map((m) => m[1].trim().split(',')[0].replace(/['"]/g, '').trim());
  const fams = [...shorthand, ...[...src.matchAll(/font-family: *([^;'"}\n]+)/g)]
    .map((m) => m[1].trim().split(',')[0].replace(/['"]/g, '').trim())]
    .filter((f) => f && f !== 'inherit' && !/^\d/.test(f));
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
/* Same two lessons as the budget above.
 *
 * The list was four HTML files, so JS never got asked — and `board-gamestats`
 * set a 10px label through `setAttribute('font-size', ...)`, which is not the
 * CSS form the pattern looked for either. Both are covered now, over every
 * window file.
 *
 * `structs-config.js` is a ratchet rather than a pass: it is a patch injected
 * into the game's own window and remapping its type is a visible change to a
 * panel people use, so it wants doing deliberately. Listed sizes may only be
 * REMOVED — a new odd size in that file still fails.
 */
// 15px is the π door and only the π door — a serif glyph neither bundled
// face has, kept on purpose. 11px was three hand-styled notes under the
// panel's door buttons; they are `.sui-text-tiny` now.
// 32px is the Game Stats hero figure and only that: the one number the page
// leads with, in a window that renders 1:1 with no 2× transform, at exactly
// twice the DirectiveZero face so the pixels stay whole (.gs-hero-v).
const TYPE_DEBT = { 'structs-config.js': ['15'], 'board.html': ['32'] };
for (const file of windowFiles) {
  const src = readFileSync(root + '/frontend/' + file, 'utf8');
  const sizes = [
    ...(src.match(/font-size: *(\d+)px/g) || []),
    // The SVG attribute form: `setAttribute('font-size', '10')`.
    ...(src.match(/font-size['"], *['"](\d+)['"]/g) || []),
  ].map((m) => m.match(/(\d+)/)[1]);
  const allowed = ['8', '12', '16'].concat(TYPE_DEBT[file] || []);
  const odd = [...new Set(sizes.filter((n) => !allowed.includes(n)))];
  check(`${file} uses only 8/12/16px`, odd.length === 0, odd.join(', ') + 'px');
  /* Relative type sizes are outside the system too, and were invisible here.
   *
   * The px check could not see `font-size:0.9em`, which is fractional scaling
   * on a pixel face — the very thing the 8/12/16 roles exist to prevent, just
   * spelled in another unit. Two of them sat in the debug panel inside a
   * hand-rolled button that SUI already provides.
   *
   * `1em`/`100%` are allowed: they assert "inherit", which changes nothing.
   */
  const rel = [...new Set((src.match(/font-size: *([0-9.]+)(em|rem|%)/g) || [])
    .filter((m) => !/[: ](1em|1rem|100%)$/.test(m)))];
  check(`${file} sizes type in px, not em`, rel.length === 0, rel.join(', '));

  // Debt that has been paid must be struck off, or the exception outlives the
  // problem and quietly re-permits it.
  const stale = (TYPE_DEBT[file] || []).filter((n) => !sizes.includes(n));
  if (stale.length) {
    check(`${file}: TYPE_DEBT is still true`, false,
      'no longer uses ' + stale.join(', ') + 'px — remove from TYPE_DEBT');
  }
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
