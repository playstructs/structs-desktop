// comms-state.js: the one reading of "is Comms up, as whom" that every
// window shares. Cold read, pushes in order, late pushes dropped, one
// wording per state, and a runtime that arrives late still gets listened to.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/comms-state.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const listeners = {};
  if (opts.tauri !== false) {
    w.__TAURI__ = { core: { invoke: (cmd, args) => { calls.push([cmd, args]); return opts.state ? Promise.resolve(opts.state) : Promise.reject('no fixture'); } }, event: {} };
  }
  if (opts.events !== false) {
    w.StructsEvents = { listen: (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); return Promise.resolve(() => {}); } };
  }
  w.eval(src);
  const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb({ payload }));
  return { w, C: w.StructsComms, calls, listeners, emit };
}
const live = { identities: { '0-1': { key: '0-1', phase: 'live', since_ms: 1, as_player: null, user_id: '@1-194:h',
  capabilities: { read: true, send: true, rooms_on: 'h', speaking_as: '1-194' } } }, unread: { count: 2, mention: false }, seq: 5 };

// 1. Cold read on first interest, then the state is known and answers.
{
  const { C, calls } = boot({ state: live });
  assert.equal(calls.length, 0, 'a page nobody in asks stays silent (the palette boots with no calls)');
  C.onChange(() => {});
  assert.equal(calls[0][0], 'matrix_state', 'reads the picture once, cold, on the first subscriber');
  assert.equal(C.known(), false, 'unknown until the read lands');
  await tick();
  assert.ok(C.known());
  assert.ok(C.signedIn());
  assert.equal(C.primary().key, '0-1');
  assert.equal(C.phase(), 'live');
  assert.equal(C.unread().count, 2);
  assert.equal(C.describe(C.primary()), null, 'live has nothing to say');
  assert.equal(C.can('send'), true, 'permission is the service\'s word');
  assert.equal(C.can('rooms_on'), 'h');
  assert.equal(C.can('send', '0-9'), false, 'an identity we do not hold may do nothing');
}

// 1b. Before the picture is known, a boolean permission is not a refusal.
{
  const { C } = boot({ state: live });
  assert.equal(C.can('send'), true, 'unknown is not "no"');
}

// 2. Pushes apply in order; a late one is dropped; unread moves on its own.
{
  const { C, emit } = boot({ state: live });
  const seen = [];
  C.onChange((s) => seen.push(s.seq));
  await tick();
  seen.length = 0;
  emit('matrix::state', { identities: { '0-1': { key: '0-1', phase: 'stalled', reason: 'connection refused', as_player: null, capabilities: { read: true, send: true } } }, unread: { count: 2, mention: false }, seq: 6 });
  assert.equal(C.phase(), 'stalled');
  assert.ok(C.signedIn(), 'a stall is a wait, not a refusal');
  assert.ok(C.can('send'));
  emit('matrix::state', { identities: { '0-1': { key: '0-1', phase: 'expired', as_player: null } }, seq: 4 });
  assert.equal(C.phase(), 'stalled', 'a push older than what we hold is dropped');
  emit('matrix::unread', { count: 9, mention: true });
  assert.equal(C.unread().count, 9);
  assert.equal(C.unread().mention, true);
  assert.equal(JSON.stringify(seen), JSON.stringify([6, 6]), 'both changes notified; the stale one did not');
}

// 3. One wording per state, for every window.
{
  const { C } = boot({ state: live });
  C.onChange(() => {});
  const d = (id) => C.describe(id);
  assert.equal(d(null).title, 'Not connected');
  assert.equal(d({ phase: 'connecting', step: 'Guild login' }).detail, 'Guild login…');
  assert.equal(d({ phase: 'stalled', reason: 'timed out' }).title, 'Not receiving messages');
  assert.ok(/timed out/.test(d({ phase: 'stalled', reason: 'timed out' }).detail));
  assert.equal(d({ phase: 'expired', reason: 'token refresh refused (400)' }).title, 'Signing in again');
  assert.ok(/refused/.test(d({ phase: 'expired', reason: 'token refresh refused (400)' }).detail));
  assert.equal(d({ phase: 'signed_out' }).title, 'Signed out');
  assert.equal(C.signedIn('0-9'), false, 'an identity we do not hold is not signed in');
}

// 4. Without a runtime (the harness) it is inert and honest.
{
  const { C, listeners } = boot({ tauri: false, events: false });
  C.onChange(() => {});
  assert.equal(C.known(), false);
  assert.equal(C.signedIn(), false);
  assert.equal(C.primary(), null);
  assert.equal(Object.keys(listeners).length, 0);
}

// 5. A runtime that appears AFTER this script (the game window, whose
//    StructsEvents lives in structs-config.js) still gets listened to.
{
  const { w, C } = boot({ state: live, events: false });
  C.onChange(() => {});
  const late = {};
  w.StructsEvents = { listen: (name, cb) => { (late[name] = late[name] || []).push(cb); return Promise.resolve(() => {}); } };
  await tick(250);
  assert.ok(late['matrix::state'] && late['matrix::unread'], 'listeners attached once the runtime existed: ' + Object.keys(late));
  late['matrix::state'][0]({ payload: { identities: {}, unread: { count: 0, mention: false }, seq: 7 } });
  assert.equal(C.signedIn(), false);
}

console.log('comms-state: all checks passed');
