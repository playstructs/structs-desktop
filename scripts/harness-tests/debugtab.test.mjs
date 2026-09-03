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
      for (const name of ['badge', 'copyLink']) {
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
  [['badge', ['text']], ['copyLink', ['id', 'label']]]
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

/* ── Remote images go through Rust ─────────────────────────────────────────
 *
 * The CSP is `img-src 'self' data: blob:`, so a remote `<img>` renders a blank
 * box. Guild logos are the visible case and they are GUILD-AUTHORED URLs on
 * hosts of that guild's choosing, so loading them directly would tell an
 * arbitrary host who is browsing the directory. The proxy is the fix; these
 * check it cannot quietly become "just widen the policy".
 */
{
  console.log('\n— remote images');
  /* The policy is the OWNER's call, and it has been made.
   *
   * `img-src` was `'self' data: blob:` — no remote images at all — which is
   * why guild logos go through `remote_image` and come back as data URIs. The
   * owner widened it to `https: http:` in 758ebf2 ("Fixing Comms issue"). That
   * is their decision to make and this does not override it; what it must not
   * do is drift further without anyone noticing, so the directive is pinned to
   * exactly what was chosen.
   *
   * What it costs, recorded so the choice stays informed: a remote `<img>` now
   * loads straight from whatever host wrote the URL. Guild logo URLs are
   * guild-authored and can point anywhere, so opening a screen that shows one
   * tells that host who is looking and when. `http:` additionally permits
   * cleartext. The proxy below still runs and still adopts remote images, so
   * the tight path is intact — this only decides what happens to an image the
   * proxy has not reached yet.
   */
  const csp = readFileSync(process.cwd() + '/src-tauri/tauri.conf.json', 'utf8');
  const imgSrc = /"csp":[^"]*"([^"]*)"/.exec(csp);
  const directive = imgSrc && /img-src ([^;"]*)/.exec(imgSrc[1]);
  check('the image policy is the one the owner chose, unchanged',
    !!directive && directive[1].trim() === "'self' data: blob: https: http:",
    directive && directive[1]);

  check('a blocked src is dropped, not left to paint an empty box',
    /removeAttribute\('src'\)/.test(src));
  check('…and the URL is remembered so it can be filled in',
    /dataset\.remoteSrc = url/.test(src));
  check('the bytes come from Rust, not the window',
    /invoke\('remote_image'/.test(src) && !/img\.src = url/.test(src));
  check('every element waiting on one URL is filled, not just the first',
    /querySelectorAll\('img\[data-remote-src\]'\)/.test(src));
  // A one-shot sweep only ever fixes what happened to be on screen at load;
  // this window rebuilds whole panels as you navigate.
  check('it keeps up with re-rendered panels',
    /new MutationObserver/.test(src) && /attributeFilter: \['src'\]/.test(src));

  const rust = readFileSync(process.cwd() + '/src-tauri/src/remote_image.rs', 'utf8');
  check('the fetcher refuses anything but https',
    /scheme\(\) != "https"/.test(rust));
  check('…and refuses private hosts, resolved not just spelled',
    /to_socket_addrs/.test(rust) && /is_loopback/.test(rust));
  check('…and re-checks every redirect',
    /redirect::Policy::custom/.test(rust) && /refuse_reason\(attempt\.url\(\)/.test(rust));
  check('…and caps what it will hold',
    /MAX_BYTES/.test(rust) && /content_length\(\)/.test(rust));
  check('…and will not pass off a non-image as one',
    /starts_with\("image\/"\)/.test(rust));
}

/* ── The page must not rebuild itself to stay on screen ────────────────────
 *
 * The webapp's grass listeners navigate the menu on their own schedule, and
 * every navigation wipes the content area. At fleet event volume that is about
 * once a second, and the fix used to be "render the whole page again" — a full
 * teardown and rebuild, throwing away loaded values and every wired handler.
 * That was the flicker. These pin the cheap path shut.
 */
{
  console.log('\n— the page is put back, not rebuilt');

  check('the built page is kept', /var debugRoot = null/.test(src));
  /* `#menu-page-body-content` is a flex container, so the kept node is a flex
   * ITEM and defaults to sizing itself to its content. Wrapping the page in it
   * narrowed the whole panel to its widest row; before the wrapper, the page's
   * own `width:100%` div was the direct child and filled the row. */
  check('…and stretches to the window rather than to its widest row',
    /root\.style\.cssText =[\s\S]{0,120}?flex:1 1 auto/.test(src)
    && /width:100%/.test(src),
    'a flex item with no width shrink-wraps its content');
  // …without overflowing it: a `width: 100%` CONTENT box plus the page's own
  // padding is wider than its container by exactly that padding.
  check('…without paying for its own padding twice',
    /box-sizing:border-box/.test(src),
    'the overflow is the horizontal scrollbar, and the vertical one it forces');
  check('…and a wipe re-attaches THAT node',
    /content\.appendChild\(debugRoot\)/.test(src),
    'rebuilding on every wipe is what flickered');
  check('…without waiting out the throttle',
    /if \(debugRoot\) \{[\s\S]{0,400}?content\.appendChild\(debugRoot\)/.test(src),
    'coalescing a re-attach leaves the webapp\u2019s own panel on screen meanwhile');
  check('…and the full rebuild is still throttled',
    /REASSERT_MIN_GAP_MS/.test(src));
  check('leaving Debug drops the kept node',
    /debugRoot = null;/.test(src.slice(src.indexOf('debugActive = false;'))),
    'a later visit would re-attach figures from the last session');

  // The engine card ticked every 2s by replacing its own innerHTML: five rows
  // and a button rebuilt to move two numbers, re-binding the handler each time.
  const engine = src.slice(src.indexOf('function ensureEngineRows'));
  check('the engine card is built once', /dataset\.built === .1./.test(engine));
  check('…and the ticks only set text',
    !/engineEl\.innerHTML = html;[\s\S]{0,80}?debug-engine-toggle/.test(src)
    && /function setText\(id, text\)/.test(src));
  check('…skipping writes that would not change anything',
    /el\.textContent !== text/.test(src));
  check('…and the toggle is bound once, not per tick',
    (src.match(/debug-engine-toggle.\)[\s\S]{0,60}?addEventListener/g) || []).length === 1);
  // Swapping which ROWS exist is what made the card change height as work
  // started and stopped; both exist and take turns being hidden.
  check('both states of the card exist from the start',
    /debug-engine-busy/.test(src) && /debug-engine-idle/.test(src)
    && /busyEl\.hidden = !busy/.test(src));

  check('the observer coalesces to a frame',
    /requestAnimationFrame/.test(src) && /observerQueued/.test(src),
    'it watches the whole body, which the animating map mutates constantly');
  check('…and ignores its own writes',
    /debugRoot\.contains\(t\)/.test(src),
    'reacting to our own re-attach is how an observer feeds itself');
}

/* ── The doors are one row, and say nothing they do not have to ────────────
 *
 * Three cards, each holding one button and a line describing what it opened.
 * The descriptions are gone — this panel's reader knows what Comms is — and
 * with them the reason the three were ever separate.
 */
{
  console.log('\n— the door row');
  const doors = ['debug-download-logs', 'debug-gamestats', 'debug-comms'];
  const at = doors.map((id) => src.indexOf("id=\"" + id + "\""));
  check('all three doors exist', at.every((i) => i > 0), JSON.stringify(at));
  check('…in the order asked for', at[0] < at[1] && at[1] < at[2],
    'Download logs, Game Stats, Comms');
  // One card, one body: the three ids must fall inside a single card's markup.
  const first = at[0];
  const cardOpen = src.lastIndexOf('sui-data-card"', first);
  const cardClose = src.indexOf("'</div></div>'", at[2]);
  check('…in ONE framed section',
    cardOpen > 0 && cardClose > at[2]
    && src.slice(cardOpen, cardClose).split('sui-data-card"').length === 2,
    'a card boundary between the buttons means they are still separate frames');
  check('…with no descriptions left anywhere in the panel',
    !/doorNote/.test(src) && !/-note'/.test(src),
    (/doorNote|-note'/.exec(src) || [''])[0]);

  /* The unread count belongs INSIDE the Comms button: anywhere else it would
   * need a label to say which door it counted for. */
  const comms = src.slice(at[2], src.indexOf('</a>', at[2]));
  check('the unread badge rides inside the Comms button',
    /debug-comms-unread/.test(comms) && /sui-badge/.test(comms), comms.slice(0, 120));

  /* With the descriptive lines gone, a failure has nowhere to go but the
   * control that caused it — which is where it belonged anyway. */
  check('a door reports its own failure', /flashBtn\(/.test(src));
  check('…and restores markup, not text, so the badge survives',
    /dataset\.restore = el\.innerHTML/.test(src)
    && /el\.innerHTML = el\.dataset\.restore/.test(src),
    'textContent would eat the unread badge inside the Comms button');
  check('…and repaints the count it may have hidden',
    /paintCommsUnread\(\);/.test(src.slice(src.indexOf('var flashBtn'))));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
