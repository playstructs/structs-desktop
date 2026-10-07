// Simulator share codes: frontend/simcode.js against the site's own encoder.
//
//   node scripts/harness-tests/simcode.test.mjs
//
// The simulator writes https://structs.app/sim/<code> and structs.app decodes
// it, so the two copies must agree byte for byte. When the structs-app repo is
// checked out beside this one (../structs-app), every battle here is encoded
// by both and the codes compared; without it, the round trip still runs.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const ctx = vm.createContext({ window: {}, btoa, atob, Uint8Array, Number, String, Error });
vm.runInContext(readFileSync(resolve(repo, 'frontend/simcode.js'), 'utf8'), ctx);
const C = ctx.window.StructsSimCode;

// Battles of every shape the simulator makes: full, sparse, guarded, looped.
const AMB = ['space', 'air', 'land', 'water'];
let n = 7;
const rnd = () => { n = (n * 1103515245 + 12345) & 0x7fffffff; return n / 0x7fffffff; };
function battle() {
  const units = [];
  for (const side of ['player', 'computer']) {
    units.push({ id: side + '-cmd', side, type: 1, ambit: AMB[Math.floor(rnd() * 4)], slot: 0, protects: null });
    for (const ambit of AMB) for (let slot = 0; slot < 4; slot++) {
      if (rnd() < 0.5) continue;
      const type = 2 + Math.floor(rnd() * 12);
      units.push({ id: `${side}-${ambit}-${slot}`, side, type, ambit, slot, protects: null });
    }
  }
  for (const u of units) {
    if (u.type === 1 || rnd() < 0.3) continue;
    const mates = units.filter((v) => v.side === u.side && v !== u);
    u.protects = mates[Math.floor(rnd() * mates.length)].id;
  }
  return {
    version: 3, seed: Math.floor(rnd() * 1e9).toString(36), difficulty: ['easy', 'difficult', 'hard'][Math.floor(rnd() * 3)],
    blockMs: rnd() < 0.5 ? 2000 : 6000, charge: { player: Math.floor(rnd() * 31), computer: Math.floor(rnd() * 31) }, units,
  };
}
const battles = Array.from({ length: 200 }, battle);

let trip = 0, maxLen = 0;
for (const b of battles) {
  const code = C.encode(b);
  maxLen = Math.max(maxLen, C.link(b).length);
  if (JSON.stringify(C.decode(code)) === JSON.stringify(b)) trip++;
}
check('200 battles survive encode → decode unchanged', trip === 200, trip + '/200');
check('…and even a full battle is a short link', maxLen < 200, maxLen + ' chars');
check('a link and a bare code both paste', C.codeFrom('https://structs.app/sim/AQQJCQ') === 'AQQJCQ' && C.codeFrom('structs://sim/AQQJCQ/') === 'AQQJCQ'
  && C.codeFrom('  AQQJCQ ') === 'AQQJCQ' && C.codeFrom('https://structs.app/player/1-61') === null && C.codeFrom('{"version":3}') === null);
check('…and garbage decodes to nothing, not a broken battle', C.decode('AAAA') === null && C.decode('!!!') === null);
let threw = false;
try { C.encode({ ...battles[0], blockMs: 3000 }); } catch (e) { threw = true; }
check('what the format cannot hold is refused, not mangled', threw);

// Results: the second path segment.
const res = { winner: 'player', forfeit: false, stalemate: null, revision: 1, blocks: 97, seconds: 194,
  stats: { player: { lost: 3, attacks: 31, damage: 34, evaded: 4, blocked: 3, countered: 6 }, computer: { lost: 9, attacks: 28, damage: 22, evaded: 6, blocked: 5, countered: 9 } } };
const rc = C.encodeResult(res);
check('a result is 26 characters and decodes to itself', rc.length === 26 && JSON.stringify(C.decodeResult(rc)) === JSON.stringify({ version: 1, ...res }), rc + ' ' + JSON.stringify(C.decodeResult(rc)));
check('…numbers saturate instead of wrapping', C.decodeResult(C.encodeResult({ ...res, blocks: 70000, stats: { player: { damage: 999 }, computer: {} } })).blocks === 65535
  && C.decodeResult(C.encodeResult({ ...res, stats: { player: { damage: 999 }, computer: {} } })).stats.player.damage === 255);
check('…impossible outcomes are refused (forfeit win, stalemate win)', C.decodeResult(C.encodeResult({ ...res, winner: 'player', forfeit: true })) === null
  && C.decodeResult(C.encodeResult({ ...res, winner: 'player', stalemate: 'quiet' })) === null && C.decodeResult(rc.slice(0, 20)) === null);
check('…and a result link is the battle link plus one segment', C.resultLink(battles[0], res) === C.link(battles[0]) + '/' + rc);
check('…which pastes as the battle it was played on', C.codeFrom(C.resultLink(battles[0], res)) === C.encode(battles[0]));

const site = resolve(repo, '..', 'structs-app', 'src', 'simcode.js');
if (existsSync(site)) {
  const S = await import(pathToFileURL(site).href);
  const differ = battles.filter((b) => S.encode(b) !== C.encode(b)).length;
  check('the site encodes every battle to the same code (../structs-app/src/simcode.js)', differ === 0, differ + ' differ');
  const back = battles.filter((b) => JSON.stringify(S.decode(C.encode(b))) === JSON.stringify(b)).length;
  check('…and decodes what the simulator writes', back === 200, back + '/200');
} else {
  console.log('  -- ../structs-app not checked out; site comparison skipped');
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
