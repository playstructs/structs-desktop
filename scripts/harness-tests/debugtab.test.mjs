// The Debug tab's two ways of going wrong, both reported from live play.
//
// There is no jsdom harness for structs-config.js — it is a large file wired
// into the game's own DOM — so these are STRUCTURAL checks. They are worth
// having anyway: both bugs were single lines with no local symptom, and both
// have a shape that is easy to state and easy to reintroduce.
import { readFileSync } from 'fs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const src = readFileSync(process.cwd() + '/frontend/structs-config.js', 'utf8');

// ── 1. The sticky re-assert must DEFER, never drop ──────────────────────────
// The webapp navigates the menu on its own schedule and each navigation wipes
// the page we drew. Re-asserting is throttled so a burst of grass events does
// not mean a redraw per event — but a throttle that `return`s has nothing left
// to call it again once the burst goes quiet, and the user is stranded on
// whatever panel the webapp chose.
{
  console.log('\n— sticky debug page');
  const fn = src.slice(src.indexOf('function reassertDebugPage()'));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  const throttle = body.slice(body.indexOf('REASSERT_MIN_GAP_MS'));
  check('a throttled re-assert schedules a catch-up instead of dropping it',
    /setTimeout\(/.test(throttle),
    'the throttle returns with nothing left to put the page back');
  check('…and the catch-up calls the re-assert again',
    /reassertDebugPage\(\)/.test(throttle));
  // Leaving deliberately must cancel a pending catch-up, or the redraw fires
  // after the user has navigated away and drags them back.
  check('leaving Debug cancels a pending catch-up',
    (src.match(/clearTimeout\(reassertTimer\)/g) || []).length >= 2,
    'a scheduled redraw survives the user navigating away');
}

// ── 2. A redraw must REPLACE its timers, not race them ──────────────────────
// Every re-assert calls renderDebugPage. A timer declared with `var` inside
// that function is a new timer each time; the old one only stops when its
// element disappears, and the redraw that created the replacement put that
// element straight back. They accumulate.
{
  console.log('\n— live-refresh timers');
  const render = src.slice(src.indexOf('function renderDebugPage()'));
  const end = render.indexOf('\n    }\n');
  const body = render.slice(0, end > 0 ? end : render.length);
  const leaked = [...body.matchAll(/var\s+(\w+)\s*=\s*setInterval\(/g)].map((m) => m[1]);
  check('no timer is declared fresh inside the redraw', leaked.length === 0,
    leaked.join(', '));
  // Each interval started here must first clear whatever it replaces.
  const starts = [...body.matchAll(/(\w+)\s*=\s*setInterval\(/g)].map((m) => m[1]);
  check('every live-refresh timer is owned outside the redraw',
    starts.length > 0 && starts.every((id) => new RegExp(
      'var\\s+' + id + '\\s*=\\s*null').test(src)),
    starts.join(', '));
  check('…and each redraw clears the timer it is replacing',
    starts.every((id) => new RegExp('if \\(' + id + '\\) clearInterval\\(' + id + '\\)').test(body)),
    starts.join(', '));
}

// ── The panel is built as innerHTML, so escaping is the whole safety story ──
//
// `row()` did not escape. 33 of its 38 callers pass plain text — the player's
// own on-chain username, ids read back from the guild API, and `e.message`
// out of a failed fetch — and all of it lands in `innerHTML`. Nothing about a
// call site said which calls were safe, so the default had to change: `row`
// escapes, `rowHtml` is the named opt-out for the five that build markup.
{
  console.log('\n— the debug panel escapes what it prints');

  // Exactly one escaper in the file, at a scope everything can reach. There
  // were two: one inside the agent-UI section, invisible to the panel builder
  // that needed it, which is why `row` had none.
  const escDefs = (src.match(/function\s*\(s\)\s*\{\s*\n?\s*return String\(s == null/g) || []).length;
  check('one escaper, defined once', escDefs === 1, String(escDefs));
  check('…and it covers quotes, not just angle brackets',
    /\[&<>"'\]/.test(src.slice(0, 2000)));

  // The default is safe.
  const rowDef = /var row = function\(label, value, id\) \{\s*\n\s*return rowHtml\(label, STRUCTS_ESC\(value\), id\);/.test(src);
  check('row() escapes its value', rowDef);
  check('…and rowHtml() escapes the label and id it controls',
    /rowHtml = function[\s\S]{0,600}?STRUCTS_ESC\(id\)[\s\S]{0,400}?STRUCTS_ESC\(label\)/.test(src));

  /* Every raw-HTML call is accounted for.
   *
   * `rowHtml` is the unsafe one by design, so the guard is that its callers
   * stay a known, small set that passes literal markup — and that any dynamic
   * value inside one is escaped at the call site. The address row is the only
   * one that interpolates anything.
   */
  const rawCalls = [...src.matchAll(/rowHtml\('([^']+)'/g)].map((m) => m[1]).sort();
  check('the raw-HTML rows are the five known ones',
    rawCalls.join() === 'Address,Config,Detail,Onboarding,Token', rawCalls.join());
  // To end of line, NOT to the first `;` — the inline `style="cursor:pointer;"`
  // is full of semicolons and truncating there hid the value being checked.
  const addr = /rowHtml\('Address'.*/.exec(src)[0];
  check('…and the only one with a dynamic value escapes it',
    /STRUCTS_ESC\(walletAddress/.test(addr) && !/\+ walletAddress/.test(addr), addr.slice(-90));

  // No OTHER row-ish builder quietly reintroduces the raw default.
  const rawInterp = [...src.matchAll(/^\s*(?:html|out) \+= '<[^']*' \+ (?!row|rowHtml|listBlock|STRUCTS_ESC)([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
  check('no panel string interpolates a bare variable into markup',
    rawInterp.length === 0, rawInterp.join(', '));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
