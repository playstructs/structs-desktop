// Federated text must never become markup.
//
// Chat renders words written by people on other homeservers — names, message
// bodies, topics, reaction keys, status lines. Every one of them reaches the
// DOM through `textContent` and `createElement`, and the day one reaches it
// through `innerHTML` is the day a stranger can put script in this window.
//
// chat.js says so in a comment at the top. A comment is a promise; this is
// the check. The same rule now applies to the raid window, which renders
// message rows of its own.
import { readFileSync } from 'fs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const root = process.cwd();

// Windows that render text arriving from other homeservers.
// Windows that render text somebody else chose. Not only Matrix: a player's
// ON-CHAIN name is theirs to set, and Team Ops and the leaderboards render
// hundreds of other players' names.
const FEDERATED = [
  'frontend/chat.js',
  'frontend/raidview.js',
  'frontend/board-pages.js',
  'frontend/board-gamestats.js',
];

// Ways a string becomes markup rather than text.
// `innerHTML = ''` empties a node. It puts nothing in, so it cannot put a
// stranger's words in — and treating it as an injection buries the lines that
// really do build markup under twenty that do not.
//
// Judged by capturing what is assigned, NOT by a negative lookahead: `\s*`
// backtracks to zero width, which moves the lookahead past the space so it
// never sees the `''` it was meant to exclude. The first version of this
// passed nothing and looked correct.
const EMPTY_ASSIGN = /^\s*(''|"" |""|``)\s*$/;
// The raid window builds two strings into markup, both examined:
//
//  - a shield icon from a locally computed state word, no remote input;
//  - the tooltip bubble, which DOES carry a player's on-chain name and is
//    defended by escaping each segment. That escaping is load-bearing, so it
//    has its own check below.
const ALLOWED_MARKUP = [
  /non_standard_icons\/shield_/,
  /dataset\.suiTooltip/,
];

// The board window paints HTML built in Rust (`mcp_board_html`). That is a
// deliberate sink, not an oversight — but it means the RUST side is what
// stands between a player's name and markup, so its escaper is checked there
// (`the_board_escaper_covers_every_breakout`) rather than here.
const SERVER_RENDERED = 'frontend/board.js';

const INJECTORS = [
  { name: 'innerHTML assignment', re: /\.innerHTML\s*=([^;\n]*)/g,
    ok: (m) => EMPTY_ASSIGN.test(m[1]) },
  { name: 'outerHTML assignment', re: /\.outerHTML\s*=/g },
  { name: 'insertAdjacentHTML', re: /insertAdjacentHTML\s*\(/g },
  { name: 'document.write', re: /document\s*\.\s*write\s*\(/g },
  { name: 'eval', re: /(^|[^.\w])eval\s*\(/g },
  { name: 'new Function', re: /new\s+Function\s*\(/g },
];

for (const file of FEDERATED) {
  const src = readFileSync(root + '/' + file, 'utf8');
  // Comments describe the rule; they are not breaches of it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  for (const injector of INJECTORS) {
    const re = new RegExp(injector.re.source, 'g');
    const hits = [];
    let m;
    while ((m = re.exec(code))) {
      if (injector.ok && injector.ok(m)) continue;   // benign by inspection
      if (ALLOWED_MARKUP.some((a) => a.test(m[0]))) continue;
      hits.push(m[0].trim().slice(0, 60));
    }
    check(file + ' uses no ' + injector.name, hits.length === 0,
      hits.join(' | '));
  }
}

// And the check has to be able to fail, or it is decoration. A line that
// really does assign innerHTML must be caught by the same matcher.
{
  const sample = 'node.innerHTML = untrusted;';
  const clearing = "node.innerHTML = '';";
  const fires = (text) => INJECTORS.some((i) => {
    const re = new RegExp(i.re.source, 'g');
    let m;
    while ((m = re.exec(text))) {
      if (i.ok && i.ok(m)) continue;
      return true;
    }
    return false;
  });
  check('the matcher catches a real injection', fires(sample), sample);
  check('…and treats clearing a node as what it is', !fires(clearing), clearing);
  // …and does not fire on a comment describing one.
  const commented = '// never innerHTML = anything\n';
  const stripped = commented.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const quiet = !INJECTORS.some((i) => new RegExp(i.re.source, 'g').test(stripped));
  check('…and not on a comment about it', quiet, commented);
}

// The tooltip's escaping, which the allowance above depends on.
//
// A player's on-chain name reaches this path, and players choose their own
// names. If the escaping is ever dropped as redundant — a comment there used
// to claim the text was never user content — a name is script.
{
  const src = readFileSync(root + '/frontend/raidview.js', 'utf8');
  const bubble = src.slice(src.indexOf('bubble.innerHTML'), src.indexOf('bubble.innerHTML') + 200);
  check('the tooltip escapes every segment before joining',
    /\.map\(esc\)/.test(bubble), bubble.slice(0, 90));

  const escFn = src.slice(src.indexOf('function esc('), src.indexOf('function esc(') + 220);
  for (const ch of ['&', '<', '>', '"']) {
    check("…and esc handles " + ch, escFn.includes("'" + ch + "'"), escFn.slice(0, 120));
  }
}

// The one window that deliberately paints server-built HTML should still not
// be building any of its OWN from string literals.
{
  const src = readFileSync(root + '/' + SERVER_RENDERED, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const re = /\.innerHTML\s*=([^;\n]*)/g;
  const built = [];
  let m;
  while ((m = re.exec(code))) {
    if (EMPTY_ASSIGN.test(m[1])) continue;
    // A bare identifier is what Rust rendered; painting that is the point of
    // this window. A string literal would be markup this file invented.
    if (/['"`]/.test(m[1])) built.push(m[0].trim().slice(0, 60));
  }
  check(SERVER_RENDERED + ' builds no markup of its own from strings',
    built.length === 0, built.join(' | '));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
