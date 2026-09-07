// The embedded-page bridge (frontend/bridge.js): an iframe gets a Tauri-
// shaped bridge that asks its parent to invoke and to listen, by message.
//
//   node scripts/harness-tests/bridge.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(resolve(repo, 'frontend/bridge.js'), 'utf8');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
const tick = () => new Promise((r) => setTimeout(r, 5));
function fresh(parent) {
  const w = new JSDOM('<body></body>', { runScripts: 'outside-only' }).window;
  if (parent !== undefined) Object.defineProperty(w, 'parent', { value: parent, configurable: true });
  return w;
}
// A parent that records what it is asked and answers by posting back.
function fakeParent(w, answer) {
  const asked = [];
  return { asked, document: {}, postMessage(m) { asked.push(m); const reply = answer(m); if (reply) w.dispatchEvent(new w.MessageEvent('message', { data: reply, origin: '' })); } };
}

{
  const w = fresh();
  const parent = fakeParent(w, (m) => (m.kind === 'invoke' ? { structs: 'bridge', kind: 'result', id: m.id, ok: m.cmd !== 'boom', value: { hello: m.cmd }, error: 'boom failed' } : null));
  Object.defineProperty(w, 'parent', { value: parent, configurable: true });
  w.eval(src);
  check('an iframe with no bridge gets one, marked embedded', !!w.__TAURI__ && w.__TAURI__.embedded === true);
  const v = await w.__TAURI__.core.invoke('matrix_status', { asPlayer: null });
  check('invoke asks the parent and resolves with its answer', parent.asked[0].structs === 'bridge' && parent.asked[0].kind === 'invoke' && parent.asked[0].cmd === 'matrix_status' && parent.asked[0].args.asPlayer === null && v.hello === 'matrix_status');
  let err = null;
  await w.__TAURI__.core.invoke('boom').catch((e) => { err = e; });
  check('…and rejects with the parent\'s error', err === 'boom failed');
  const heard = [];
  const un = await w.__TAURI__.event.listen('matrix::timeline', (e) => heard.push(e));
  check('listen asks the parent to subscribe', parent.asked.some((m) => m.kind === 'listen' && m.name === 'matrix::timeline'));
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'bridge', kind: 'event', name: 'matrix::timeline', payload: { x: 1 } }, origin: '' }));
  check('an event from the parent reaches the listener in Tauri\'s shape', heard.length === 1 && heard[0].event === 'matrix::timeline' && heard[0].payload.x === 1);
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'bridge', kind: 'event', name: 'matrix::timeline', payload: {} }, origin: 'https://evil.example' }));
  check('…but not from another origin', heard.length === 1);
  un();
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'bridge', kind: 'event', name: 'matrix::timeline', payload: {} }, origin: '' }));
  check('unlisten stops it', heard.length === 1);
}
{
  const own = { core: {} };
  const w = fresh({ document: {}, postMessage() {} });
  w.__TAURI__ = own;
  w.eval(src);
  check('a window that has its own bridge keeps it', w.__TAURI__ === own);
}
{
  const w = fresh();
  w.eval(src);
  check('a top-level window (parent is itself) is left without a bridge', w.__TAURI__ === undefined);
}
{
  const hostile = {};
  Object.defineProperty(hostile, 'document', { get() { throw new Error('cross-origin'); } });
  const w = fresh(hostile);
  w.eval(src);
  check('a cross-origin parent is left alone', w.__TAURI__ === undefined);
}
{
  const html = readFileSync(resolve(repo, 'frontend/chat.html'), 'utf8');
  const html2 = readFileSync(resolve(repo, 'frontend/transfer.html'), 'utf8');
  const html3 = readFileSync(resolve(repo, 'frontend/raidview.html'), 'utf8');
  const first = (s) => s.indexOf('bridge.js') > 0 && s.indexOf('bridge.js') < s.indexOf('events.js');
  check('every page that can be embedded loads bridge.js before events.js', first(html) && first(html2) && first(html3));
}
await tick();
console.log('');
if (failures) { console.log(failures + ' failing check(s)'); process.exit(1); }
console.log('all checks passed');
