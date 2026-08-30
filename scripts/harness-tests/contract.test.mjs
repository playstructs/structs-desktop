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
import { topLevelKeys, nestedObject, rustFiles } from './_parse.mjs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const root = process.cwd();
const rustDir = root + '/src-tauri/src';


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

// ── Structs an argument can carry ───────────────────────────────────────────
//
// Tauri renames top-level command arguments from camelCase to snake_case. It
// does NOT touch the fields inside a struct one of them carries — those are
// plain serde, so they need `rename_all` or the window must send them exactly
// as Rust spells them.
//
// This check exists because the version without it passed while a real reply
// was failing in the app with "missing field event_id". Checking only the
// outer names is checking the easy half.
const structs = new Map();
for (const f of rustFiles(rustDir)) {
  const src = readFileSync(f, 'utf8');
  const re = /#\[derive\([^)]*Deserialize[^)]*\)\]\s*((?:#\[[^\]]*\]\s*)*)pub struct\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src))) {
    const camel = /rename_all\s*=\s*"camelCase"/.test(m[1]);
    const fields = new Set(
      (m[3].match(/^\s*pub\s+([a-z0-9_]+)\s*:/gm) || [])
        .map((x) => x.replace(/^\s*pub\s+/, '').replace(/\s*:$/, '').trim())
        .map((x) => (camel ? x.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) : x))
    );
    if (fields.size) structs.set(m[2], { fields, camel });
  }
}

const structArgs = new Map();
for (const f of rustFiles(rustDir)) {
  const src = readFileSync(f, 'utf8');
  const re = /#\[tauri::command\][\s\S]{0,200}?fn\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
  let m;
  while ((m = re.exec(src))) {
    for (const p of m[2].split(',')) {
      const bits = p.split(':');
      if (bits.length < 2) continue;
      const arg = bits[0].trim().replace(/^mut\s+/, '');
      const ty = bits.slice(1).join(':').trim().replace(/^Option</, '').replace(/>$/, '');
      if (!structs.has(ty)) continue;
      if (!structArgs.has(m[1])) structArgs.set(m[1], new Map());
      structArgs.get(m[1]).set(arg, ty);
    }
  }
}
check('command arguments carrying structs are found',
  structArgs.size > 0, [...structArgs.keys()].join(', '));

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


// Rust spells the argument snake_case; the window spells it camelCase.
function camelOf(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
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

// The nested half: for a struct-carrying argument, the object the window
// sends must use the field names serde will actually look for.
const badNested = [];
const nestedChecked = [];
for (const f of front) {
  const src = readFileSync(root + '/' + f, 'utf8');
  const re = /invoke\(\s*'([a-z0-9_]+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const wants = structArgs.get(m[1]);
    if (!wants) continue;
    for (const [arg, ty] of wants) {
      const at = nestedObject(src, re.lastIndex - 1, camelOf(arg));
      if (at === -1) continue;                 // sent as null, or not sent here
      nestedChecked.push(m[1] + '.' + camelOf(arg));
      const expect = structs.get(ty).fields;
      for (const k of topLevelKeys(src, at)) {
        if (!expect.has(k)) {
          badNested.push(m[1] + '.' + camelOf(arg) + '.' + k +
            ' → ' + ty + ' wants [' + [...expect].join(', ') + ']');
        }
      }
    }
  }
}

check('every command the window calls exists in Rust',
  unknown.length === 0, unknown.join('; '));
check('…and objects inside an argument use the field names serde expects',
  badNested.length === 0, [...new Set(badNested)].slice(0, 6).join('; '));
console.log('  · nested-checked: ' +
  ([...new Set(nestedChecked)].sort().join(', ') || 'none'));
check('…and every one is registered in the handler list',
  unregistered.length === 0, unregistered.join('; '));
check('…and every argument matches its parameter name',
  badArgs.length === 0, badArgs.slice(0, 8).join('; '));

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
