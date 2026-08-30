// Do the harness fixtures return what the Rust commands actually return?
//
// Third and last layer of the same silent class. The window reads `res.hits`,
// `res.pinned`, `res.ok`; the fixtures supply those keys from what I BELIEVED
// each command returns. If a command answers `{valid: true}` and the fixture
// says `{ok: true}`, every test passes and the feature is broken in the app.
//
// This file declares what it covered, every run. The previous version of this
// idea reported "all passed" while checking exactly zero events, and the only
// reason that surfaced was making it print its own coverage — a green check
// that verifies nothing is worse than no check, because it also removes the
// suspicion that would have found the problem.
import { readFileSync } from 'fs';
import { topLevelKeys, rustFiles } from './_parse.mjs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const root = process.cwd();



// ── What each command can answer with ───────────────────────────────────────
// Every `json!({…})` inside the command's body, so a command with several
// return points contributes all of their keys.
const returns = new Map();
for (const f of rustFiles(root + '/src-tauri/src')) {
  const src = readFileSync(f, 'utf8');
  const re = /#\[tauri::command\][\s\S]{0,200}?fn\s+([a-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // The body: from this command to the next one, or end of file.
    const next = src.indexOf('#[tauri::command]', re.lastIndex);
    const body = src.slice(re.lastIndex, next === -1 ? src.length : next);
    const keys = new Set();
    // Only `Ok(json!({…}))` — the literal that IS the answer.
    //
    // Taking every `json!` in the body instead reads NESTED objects as the
    // response shape: `mcp_health` returns a value built up elsewhere and its
    // inner literals describe blocked loops, so the check "knew" the answer
    // had a `loop` field and called a correct fixture wrong. A command whose
    // response is assembled in a variable is not readable here, and saying so
    // is the honest answer.
    const ore = /Ok\(\s*json!\s*\(\s*\{/g;
    let j;
    while ((j = ore.exec(body))) {
      topLevelKeys(body, ore.lastIndex - 1).forEach((k) => keys.add(k));
    }
    if (keys.size) returns.set(m[1], keys);
  }
}
check('Rust commands answer with readable shapes', returns.size > 20, String(returns.size));

// ── What the fixtures answer with ───────────────────────────────────────────
const harness = readFileSync(root + '/scripts/make_harness.sh', 'utf8');
const fixtures = new Map();
{
  // `cmd: { … }` and `get cmd() { return { … } }` both appear in the table.
  const re = /^\s{4}(?:get\s+)?([a-z0-9_]+)\s*(?:\(\))?\s*:?\s*\{/gm;
  let m;
  while ((m = re.exec(harness))) {
    if (!returns.has(m[1])) continue;
    const brace = harness.indexOf('{', m.index + m[0].length - 1);
    let keys = topLevelKeys(harness, brace);
    // A getter's braces are the function body; the object is the `return`.
    if (!keys.length || keys.every((k) => k === 'return')) {
      const ret = harness.indexOf('return', brace);
      const rb = ret === -1 ? -1 : harness.indexOf('{', ret);
      if (rb !== -1) keys = topLevelKeys(harness, rb);
    }
    if (keys.length) fixtures.set(m[1], keys);
  }
}

// ── Compare ─────────────────────────────────────────────────────────────────
const wrong = [];
for (const [cmd, keys] of fixtures) {
  const real = returns.get(cmd);
  for (const k of keys) {
    if (!real.has(k)) wrong.push(cmd + '.' + k + ' → Rust answers [' + [...real].join(', ') + ']');
  }
}
check('every fixture key is one the command really answers with',
  wrong.length === 0, [...new Set(wrong)].slice(0, 8).join('; '));

console.log('  · response-checked: ' + ([...fixtures.keys()].sort().join(', ') || 'none'));
const unchecked = [...returns.keys()].filter((c) => !fixtures.has(c)).sort();
if (unchecked.length) {
  console.log('  · no comparable fixture: ' + unchecked.join(', '));
}
check('the check covers something', fixtures.size >= 8, String(fixtures.size));

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
