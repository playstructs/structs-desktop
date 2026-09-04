// The GRASS WebSocket sniffer in structs-config.js: every NATS MSG payload in a
// frame must be forwarded, not only the first.
//
//   node scripts/harness-tests/grassparse.test.mjs
//
// Measured 2026-09-04: the one-object-per-frame parser lost a flat 25% of all
// planet_activity frames (1,674 struct_status rows emitted in an hour, 1,223
// received), because the indexer writes a new struct's health + status +
// build_start rows in one block and NATS ships them in one WebSocket frame.
// The snapshot then believed built structs were still building (double
// completions, "already has a struct on that slot").
//
// The parser is a pure function assigned to window; it is lifted out of the
// file by its markers and evaluated alone, like the other structural checks.
import { readFileSync } from 'fs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const src = readFileSync(process.cwd() + '/frontend/structs-config.js', 'utf8');
const start = src.indexOf('window.__STRUCTS_GRASS_PARSE__ = function(raw) {');
check('parser is defined', start !== -1);
const end = src.indexOf('\n    };\n', start);
const fnSrc = src.slice(start + 'window.__STRUCTS_GRASS_PARSE__ = '.length, end + '\n    }'.length);
const parse = new Function('return (' + fnSrc + ');')();

const msg = (seq, category, detail) => JSON.stringify({
  subject: 'structs.planet.2-28299.1-1053', category, seq, detail,
});
// A real frame: three MSG lines from one block, protocol noise between them.
const frame =
  'MSG structs.planet.2-28299.1-1053 1 190\r\n' + msg(24, 'struct_health', { health: 6, struct_id: '5-240228' }) + '\r\n' +
  'MSG structs.planet.2-28299.1-1053 1 201\r\n' + msg(25, 'struct_status', { status: 1, struct_id: '5-240228' }) + '\r\n' +
  'MSG structs.planet.2-28299.1-1053 1 188\r\n' + msg(26, 'struct_block_build_start', { block: 2471483, struct_id: '5-240228' }) + '\r\n';

console.log('\n— every message in a frame');
const out = parse(frame);
check('three payloads in one frame → three messages', out.length === 3, 'got ' + out.length);
check('in order', out.map(m => m.seq).join(',') === '24,25,26', out.map(m => m.seq).join(','));
check('categories intact', out.map(m => m.category).join('|') === 'struct_health|struct_status|struct_block_build_start');
check('nested detail intact', out[2].detail.block === 2471483);

console.log('\n— robustness');
check('single message still works', parse(msg(1, 'block', { height: 1 })).length === 1);
check('PING / +OK only → nothing', parse('PING\r\n+OK\r\n').length === 0);
check('braces inside strings do not split a payload',
  parse(msg(7, 'player_meta', { name: 'x{y}z' }))[0].detail.name === 'x{y}z');
check('a payload cut off by the frame boundary yields what precedes it',
  parse(msg(1, 'a', {}) + '\r\nMSG x 1 50\r\n{"category":"b","detail":{"unfinished":').length === 1);
check('non-string input → empty', parse(undefined).length === 0 && parse(null).length === 0);

console.log('\n— wiring');
const handler = src.slice(src.indexOf("ws.addEventListener('message', function(event) {"));
check('the frame handler iterates the parser output',
  /var messages = window\.__STRUCTS_GRASS_PARSE__\(raw\);[\s\S]{0,200}for \(var mi = 0; mi < messages\.length; mi\+\+\)/.test(handler));
check('no first-object-only scan remains in the handler',
  !/raw\.indexOf\('\{'\)/.test(handler.slice(0, 4000)));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
