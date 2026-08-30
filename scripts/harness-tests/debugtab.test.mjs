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

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
