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

  /* The check that matters is the one that was missing.
   *
   * The old guard here froze the rowHtml callers at a list of five names. It
   * pinned the wrong side: three call sites built markup and handed it to the
   * ESCAPING `row()`, so the Debug tab printed
   * `<span style="color:var(--text-hint);">OFF</span>` as literal text beside
   * every policy, the Task Manager status and the energy status. Nothing
   * failed — enumerating rowHtml's callers cannot see a row that never
   * became one, and the frozen list actively blocked the fix.
   *
   * So: walk every `row(` call with a paren balancer and assert its arguments
   * contain no markup at all. A `<` in a `row()` argument is the bug, whole.
   */
  const callArgs = (name) => {
    const out = [];
    const re = new RegExp('(?<![A-Za-z0-9_$])' + name + '\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length, depth = 1, q = null;
      for (; i < src.length && depth > 0; i++) {
        const c = src[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === "'" || c === '"' || c === '`') q = c;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      out.push(src.slice(m.index + m[0].length, i - 1));
    }
    return out;
  };
  // Only the SECOND argument is the value. `rowHtml` escapes the label and the
  // id itself, so scanning every argument flagged its own safe wrapper.
  const argAt = (call, n) => {
    const parts = [];
    let depth = 0, q = null, last = 0;
    for (let i = 0; i < call.length; i++) {
      const c = call[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') q = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) { parts.push(call.slice(last, i)); last = i + 1; }
    }
    parts.push(call.slice(last));
    return parts[n] || '';
  };

  const rowCalls = callArgs('row');
  check('every row() call site exists to be checked', rowCalls.length > 20,
    String(rowCalls.length));
  const markupRows = rowCalls.filter((a) => argAt(a, 1).includes('<'));
  check('no row() call passes markup to the escaper', markupRows.length === 0,
    markupRows.map((a) => a.slice(0, 60)).join(' | '));

  /* And the opt-out stays honest: rowHtml interpolates only values that were
   * escaped, badged, or built from string literals. Named rather than
   * enumerated, so adding a correct raw row does not fail the suite.
   */
  const MARKUP_LOCALS = ['btnHtml', 'refreshBtn'];
  const rawArgs = callArgs('rowHtml');
  const unsafe = [];
  rawArgs.forEach((call) => {
    // Drop string literals and the two safe wrappers, then see what is left.
    const bare = argAt(call, 1)
      .replace(/'(?:\\.|[^'\\])*'/g, '')
      .replace(/"(?:\\.|[^"\\])*"/g, '')
      .replace(/STRUCTS_ESC\([^)]*\)/g, '');
    // Nested parens (`copyLink('x', a.substring(0, 24))`) outrun a `[^)]*`
    // strip, which stops early and leaves the tail looking unescaped.
    const stripCalls = (t) => {
      for (const name of ['badge', 'copyLink', 'doorNote']) {
        let i;
        while ((i = t.indexOf(name + '(')) >= 0) {
          let j = i + name.length + 1, depth = 1;
          for (; j < t.length && depth > 0; j++) {
            if (t[j] === '(') depth++; else if (t[j] === ')') depth--;
          }
          t = t.slice(0, i) + t.slice(j);
        }
      }
      return t;
    };
    (stripCalls(bare).match(/[A-Za-z_$][\w$]*/g) || []).forEach((id) => {
      if (MARKUP_LOCALS.indexOf(id) < 0) unsafe.push(id);
    });
  });
  check('rowHtml interpolates nothing unescaped', unsafe.length === 0,
    [...new Set(unsafe)].join(', '));

  // …and those two locals are markup built only from literals — including the
  // labels they interpolate, each of which is assigned string constants only.
  MARKUP_LOCALS.forEach((name) => {
    const def = new RegExp('var ' + name + ' =([\\s\\S]*?);\\n').exec(src);
    check(name + ' is defined once as markup', !!def);
    if (!def) return;
    const ids = (def[1]
      .replace(/'(?:\\.|[^'\\])*'/g, '')
      .match(/[A-Za-z_$][\w$]*/g) || []);
    const dynamic = ids.filter((id) => {
      const asg = [...src.matchAll(new RegExp(id + ' = ([^;\\n]+);', 'g'))].map((m) => m[1]);
      return asg.length === 0 || !asg.every((v) => /^'[^']*'$/.test(v.trim()));
    });
    check('…and every value it interpolates is a string constant',
      dynamic.length === 0, dynamic.join(', '));
  });

  /* The status chip is SUI's, not a colour picked at the call site. */
  check('status values use the SUI badge, not an inline colour',
    !/row(?:Html)?\([^;]*style="color:/.test(src),
    (/row(?:Html)?\([^;]*style="color:[^"]*"/.exec(src) || [''])[0]);
  /* Every wrapper stripped above buys its exemption by escaping. Named here
   * with what it must escape, so adding one to the strip list without making
   * it safe widens the hole loudly rather than silently. */
  [['badge', ['text']], ['copyLink', ['id', 'label']], ['doorNote', ['id', 'text']]]
    .forEach(([name, params]) => {
      const at = src.indexOf('var ' + name + ' = function');
      const body = at < 0 ? '' : src.slice(at, src.indexOf('\n      };', at));
      check(name + '() is defined once', at >= 0 && body.length < 900, String(body.length));
      params.forEach((prm) => check(
        '…and ' + name + '() escapes ' + prm,
        new RegExp('STRUCTS_ESC\\(' + prm + '\\)').test(body)));
    });

  // No OTHER row-ish builder quietly reintroduces the raw default.
  const rawInterp = [...src.matchAll(/^\s*(?:html|out) \+= '<[^']*' \+ (?!row|rowHtml|listBlock|STRUCTS_ESC)([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
  check('no panel string interpolates a bare variable into markup',
    rawInterp.length === 0, rawInterp.join(', '));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
