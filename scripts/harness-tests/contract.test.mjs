// Does every command the window calls actually exist in Rust, with the
// argument names Rust expects?
//
// The harness stubs `invoke`, so a mistyped command name or a wrong argument
// name passes every other test in this directory and fails only in the real
// app — silently, as a rejected promise inside a .catch(). That is the one
// class of bug the fixtures structurally cannot catch, and it is exactly the
// class that a long run of new commands produces.
//
// Tauri converts JS camelCase arguments to Rust snake_case, so `roomId` in
// the window must be `room_id` in the signature.
import { readFileSync, readdirSync } from 'fs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const root = process.cwd();
const rustDir = root + '/src-tauri/src';

function rustFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...rustFiles(dir + '/' + e.name));
    else if (e.name.endsWith('.rs')) out.push(dir + '/' + e.name);
  }
  return out;
}

// ── What Rust offers ────────────────────────────────────────────────────────
// A command is `#[tauri::command]` followed by a fn, whose parameters are the
// argument names it will accept.
const commands = new Map();
for (const f of rustFiles(rustDir)) {
  const src = readFileSync(f, 'utf8');
  const re = /#\[tauri::command\][\s\S]{0,200}?fn\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
  let m;
  while ((m = re.exec(src))) {
    const params = m[2]
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.split(':')[0].trim().replace(/^mut\s+/, ''))
      .filter((p) => p && p !== 'self');
    commands.set(m[1], { params, file: f.slice(root.length + 1) });
  }
}
check('Rust exposes commands to find', commands.size > 40, String(commands.size));

// ── What main.rs actually registers ─────────────────────────────────────────
// A command that exists but is never handed to the handler list is not
// callable: the window gets "command not found" at runtime.
const main = readFileSync(rustDir + '/main.rs', 'utf8');
const handler = main.slice(main.indexOf('generate_handler!'));
// Match the WHOLE path and take its last segment. Matching `a::b` greedily
// from the start turns `mcp::raid_view::mcp_raid_view_open` into `raid_view`
// and reports every multi-segment registration as missing.
const registered = new Set(
  (handler.match(/([a-z0-9_]+(?:::[a-z0-9_]+)*)\s*,/g) || [])
    .map((s) => s.replace(/,\s*$/, '').trim().split('::').pop())
);

// ── What the window calls ───────────────────────────────────────────────────
const camelToSnake = (s) => s.replace(/([A-Z])/g, (c) => '_' + c.toLowerCase());
const front = readdirSync(root + '/frontend')
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .map((f) => 'frontend/' + f);

// The keys of the object literal starting at `open`, ignoring anything nested
// inside it. Brace-and-bracket depth, with strings skipped so a `{` in a
// message body cannot throw the count off.
function topLevelKeys(src, open) {
  const keys = [];
  let depth = 0, i = open, str = null, keyStart = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (ch === '\\') i++;
      else if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 1) keyStart = i + 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ':' && keyStart >= 0) {
      const k = src.slice(keyStart, i).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k);
      keyStart = -1;
    } else if (ch === ',') {
      keyStart = i + 1;
    }
  }
  return keys;
}

const calls = [];
for (const f of front) {
  const src = readFileSync(root + '/' + f, 'utf8');
  // invoke('name', { … }) — only the TOP-LEVEL keys of the literal, which is
  // all Tauri looks at. A flat split on commas walks into nested objects and
  // reports their keys as arguments: `{request: {mode, args}}` came out as
  // three arguments named request, mode and args.
  const re = /invoke\(\s*'([a-z0-9_]+)'\s*(?:,\s*(\{))?/g;
  let m;
  while ((m = re.exec(src))) {
    calls.push({ cmd: m[1], args: m[2] ? topLevelKeys(src, re.lastIndex - 1) : [], file: f });
  }
}
check('the window makes calls to check', calls.length > 40, String(calls.length));

// ── Every called command exists, is registered, and takes those arguments ───
const unknown = [];
const unregistered = [];
const badArgs = [];
for (const c of calls) {
  const def = commands.get(c.cmd);
  if (!def) { unknown.push(c.cmd + ' (' + c.file + ')'); continue; }
  if (!registered.has(c.cmd)) unregistered.push(c.cmd);
  for (const a of c.args) {
    const snake = camelToSnake(a);
    // `app`, `window` and state are injected by Tauri, never sent by the
    // window, so they are absent from the call by design.
    if (!def.params.includes(snake) && !def.params.includes(a)) {
      badArgs.push(c.cmd + '.' + a + ' → expected one of [' + def.params.join(', ') + ']');
    }
  }
}

check('every command the window calls exists in Rust',
  unknown.length === 0, unknown.join('; '));
check('…and every one is registered in the handler list',
  unregistered.length === 0, unregistered.join('; '));
check('…and every argument matches its parameter name',
  badArgs.length === 0, badArgs.slice(0, 8).join('; '));

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
