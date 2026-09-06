// StructsEvents: every listen() is recorded and announced to Rust once,
// with the full list, after the last registration; without a runtime it is
// a harmless no-op.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/events.js', import.meta.url), 'utf8');

function boot(tauri) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  if (tauri) w.__TAURI__ = tauri;
  w.eval(src);
  return w;
}

// 1. With Tauri: listens go through, one announcement carries every name.
{
  const invoked = [];
  const listened = [];
  const w = boot({
    core: { invoke: (cmd, args) => { invoked.push([cmd, args]); return Promise.resolve(); } },
    event: { listen: (name, cb) => { listened.push(name); return Promise.resolve(() => {}); } },
  });
  w.StructsEvents.listen('board-update', () => {});
  w.StructsEvents.listen('grass-event', () => {});
  w.StructsEvents.listen('board-update', () => {}); // a second listener, same name
  assert.equal(JSON.stringify(listened), JSON.stringify(['board-update', 'grass-event', 'board-update']));
  assert.equal(invoked.length, 0, 'announcement is debounced');
  w.StructsEvents.announceNow();
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0][0], 'events_listening');
  assert.equal(JSON.stringify([...invoked[0][1].names]), JSON.stringify(['board-update', 'grass-event']), 'names deduplicated');
}

// 2. Without Tauri (harness): listen is a no-op that still resolves an unlisten.
{
  const w = boot(null);
  const p = w.StructsEvents.listen('anything', () => {});
  assert.ok(p && typeof p.then === 'function');
  w.StructsEvents.announceNow(); // must not throw
  assert.equal(JSON.stringify([...w.StructsEvents.names()]), JSON.stringify(['anything']));
}

// 3. A shim whose invoke rejects (the web board has no such command) is swallowed.
{
  const w = boot({
    core: { invoke: () => Promise.reject(new Error('unknown command')) },
    event: { listen: () => Promise.resolve(() => {}) },
  });
  w.StructsEvents.listen('x', () => {});
  w.StructsEvents.announceNow();
}

console.log('structsevents: ok');
