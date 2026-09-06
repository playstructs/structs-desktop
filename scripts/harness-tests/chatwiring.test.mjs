// chat.js wires its modules with `window.ChatX({ name: name, ... })`. A name
// that is a `var` assigned FURTHER DOWN the file is undefined at that moment
// (hoisted, not yet assigned), and the module keeps that undefined forever —
// `say` and `messageNode` were both handed over that way after extractions.
// Declarations are hoisted whole, so they are safe; module vars must be thunks.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat.js', import.meta.url), 'utf8');
const lines = src.split('\n');

const declared = new Set();          // function declarations: hoisted whole
const assignedAt = new Map();        // var name → line it is assigned on
lines.forEach((l, i) => {
  const d = l.match(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (d) declared.add(d[1]);
  for (const m of l.matchAll(/(?:^|\bvar\s+|,\s*)([A-Za-z_$][\w$]*)\s*=\s*(?!=)/g)) {
    if (!/^\s*\/\//.test(l) && !assignedAt.has(m[1])) assignedAt.set(m[1], i + 1);
  }
});

const bad = [];
let wiring = null;
lines.forEach((l, i) => {
  const open = l.match(/window\.(Chat[A-Za-z]+)\(\{/);
  if (open) wiring = { name: open[1], line: i + 1 };
  if (!wiring) return;
  for (const m of l.matchAll(/([A-Za-z_$][\w$]*):\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) {
    const [, key, ident] = m;
    if (key !== ident || declared.has(ident)) continue;
    const at = assignedAt.get(ident);
    if (at == null) continue;                    // a parameter or a global
    if (at > wiring.line) bad.push(`${wiring.name} (line ${wiring.line}) passes ${ident}, assigned on line ${at}`);
  }
  if (/\}\);/.test(l)) wiring = null;
});

assert.equal(bad.length, 0, 'module wirings hand over values that do not exist yet:\n  ' + bad.join('\n  '));
console.log('chat-wiring: all checks passed (' + declared.size + ' declarations, ' + assignedAt.size + ' vars scanned)');
