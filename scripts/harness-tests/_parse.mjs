// Top-level keys of an object literal, for the contract checks.
//
// One implementation, because there were three and each had its own bug: one
// counted `json!(` as a level and silently found nothing, one read Rust path
// segments (`crate::mcp::…`) as field names, and one read the words inside a
// comment as a key and so missed the field that followed it. Three copies of
// a fiddly scanner is three chances to be quietly wrong about what the tests
// are actually checking.
//
// `open` must be the `{` itself.
export function topLevelKeys(src, open) {
  const keys = [];
  let depth = 0, str = null, keyStart = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];

    if (str) {
      if (ch === '\\') i++;
      else if (ch === str) str = null;
      continue;
    }
    // Comments are prose. Their words are not fields, and reading them as
    // fields swallows the real key that comes after.
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (depth === 1 && keyStart < 0) keyStart = i;
      str = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 1) keyStart = -1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;

    // `crate::mcp::loop_util` is a path, not `crate: …`.
    if (ch === ':' && (src[i + 1] === ':' || src[i - 1] === ':')) {
      if (src[i + 1] === ':') i++;
      keyStart = -1;
      continue;
    }
    if (ch === ':' && keyStart >= 0) {
      const k = src.slice(keyStart, i).trim().replace(/^["']|["']$/g, '');
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k);
      keyStart = -1;
    } else if (ch === ',') {
      keyStart = -1;
    } else if (keyStart < 0 && /[A-Za-z_]/.test(ch)) {
      keyStart = i;
    }
  }
  return keys;
}

import { readdirSync } from 'fs';
export function rustFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...rustFiles(dir + '/' + e.name));
    else if (e.name.endsWith('.rs')) out.push(dir + '/' + e.name);
  }
  return out;
}
