// Do the events the window listens for match the ones Rust emits?
//
// The same silent class as the command contract, one level down. A listener
// registered for a name nothing emits is simply never called — no error, no
// rejected promise, nothing in a log. There is a precedent in this codebase:
// a window shipped without Tauri capabilities and EVERY listener on it was
// dead, which took a long time to notice because dead listeners look exactly
// like a quiet server.
//
// Scoped to the `matrix::` namespace, where both sides live in this repo.
// Elsewhere a listener may legitimately hear an event emitted by another
// window or by Tauri itself.
import { readFileSync, readdirSync } from 'fs';
import { topLevelKeys, rustFiles } from './_parse.mjs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const root = process.cwd();


// ── What Rust emits ─────────────────────────────────────────────────────────
const emitted = new Map();          // name → files
for (const f of rustFiles(root + '/src-tauri/src')) {
  const src = readFileSync(f, 'utf8');
  // `events::emit_matrix(&app, "matrix::x", …)` is the one emit path now; the
  // older `.emit(` / `.emit_to(` forms are kept so a stray one still counts.
  const re = /\b(?:emit_matrix|emit(?:_to|_filter)?)\s*\(\s*(?:[^,]+,\s*)?"(matrix::[a-z_]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    if (!emitted.has(m[1])) emitted.set(m[1], []);
    emitted.get(m[1]).push(f.slice(root.length + 1));
  }
}

// ── What the window listens for ─────────────────────────────────────────────
const heard = new Map();
for (const f of readdirSync(root + '/frontend').filter((n) => n.endsWith('.js') && !n.startsWith('_'))) {
  const src = readFileSync(root + '/frontend/' + f, 'utf8');
  const re = /listen\(\s*'(matrix::[a-z_]+)'/g;
  let m;
  while ((m = re.exec(src))) {
    if (!heard.has(m[1])) heard.set(m[1], []);
    heard.get(m[1]).push('frontend/' + f);
  }
}

check('there are matrix events to check',
  emitted.size > 3 && heard.size > 3,
  emitted.size + ' emitted, ' + heard.size + ' heard');

// A listener for something nothing emits is dead code that looks like a
// working feature.
const dead = [...heard.keys()].filter((n) => !emitted.has(n));
check('every event the window listens for is emitted somewhere',
  dead.length === 0, dead.join('; '));

// An emitted event nobody hears is not always wrong — but in this namespace
// both ends are ours, so it means a feature that fires into nothing.
const unheard = [...emitted.keys()].filter((n) => !heard.has(n));
check('every matrix event Rust emits has a listener',
  unheard.length === 0, unheard.join('; '));

// ── Do the tests use the payload Rust actually sends? ───────────────────────
//
// The sharpest version of this problem. Every harness test emits a payload I
// WROTE, from what I believed Rust produces. If Rust emits `room_id` and the
// test emits `roomId`, the test passes, the feature looks covered, and the
// app is broken. Nothing else in this directory can see that, because the
// test and the code under test agree with each other and both are wrong.
//

const payloadKeys = new Map();      // event → set of keys Rust can send
for (const f of rustFiles(root + '/src-tauri/src')) {
  const src = readFileSync(f, 'utf8');
  const re = /\b(?:emit_matrix|emit(?:_to|_filter)?)\s*\(\s*(?:[^,]+,\s*)?"(matrix::[a-z_]+)"\s*,\s*json!\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // Start at the `{`, not at the `(` of `json!(`. Starting a brace counter
    // on the paren puts every key one level deeper than it looks for, and the
    // scan returns nothing at all — which reads as "no keys to check" rather
    // than as a broken scan.
    const brace = src.indexOf('{', re.lastIndex - 1);
    if (brace === -1) continue;
    const keys = topLevelKeys(src, brace);
    if (!payloadKeys.has(m[1])) payloadKeys.set(m[1], new Set());
    keys.forEach((k) => payloadKeys.get(m[1]).add(k));
  }
}

const testSrc = readFileSync(root + '/scripts/harness-tests/chat.test.mjs', 'utf8');
const wrongKeys = [];
const exercised = new Set();
{
  const re = /__HARNESS_EMIT__\(\s*'(matrix::[a-z_]+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(testSrc))) {
    exercised.add(m[1]);
    const known = payloadKeys.get(m[1]);
    if (!known || !known.size) continue;
    for (const k of topLevelKeys(testSrc, re.lastIndex - 1)) {
      if (!known.has(k)) wrongKeys.push(m[1] + '.' + k + ' → Rust sends [' + [...known].join(', ') + ']');
    }
  }
}
check('the tests emit the payload Rust actually sends',
  wrongKeys.length === 0, [...new Set(wrongKeys)].slice(0, 6).join('; '));

// What this check can and cannot see, said out loud.
//
// Some events are emitted from a pre-built value rather than a literal
// `json!(…)` at the call site, and their keys cannot be read statically. The
// first version of this check skipped those SILENTLY — which is precisely the
// failure it exists to catch, one level up: a test that looks covered and is
// not. Naming them is the difference between a limitation and a lie.
const unreadable = [...exercised].filter((n) => !(payloadKeys.get(n) || {}).size).sort();
console.log('  · payload-checked: ' +
  ([...exercised].filter((n) => (payloadKeys.get(n) || {}).size).sort().join(', ') || 'none'));
if (unreadable.length) {
  console.log('  · not statically checkable (emitted from a variable): ' +
    unreadable.join(', '));
}
check('most events the tests exercise have a checkable payload',
  unreadable.length * 2 <= exercised.size,
  unreadable.length + ' of ' + exercised.size + ' unreadable');

// ── The window must be allowed to hear them at all ──────────────────────────
// Precedent: a window shipped without capabilities and every listener on it
// was silently dead.
const caps = JSON.parse(readFileSync(root + '/src-tauri/capabilities/default.json', 'utf8'));
check('the comms window is granted capabilities',
  (caps.windows || []).includes('chat'), JSON.stringify(caps.windows));

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
