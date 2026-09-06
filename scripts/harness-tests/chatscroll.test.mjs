// chat-scroll.js: typing announcements and scroll anchoring, with a stub invoke.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-scroll.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(state = {}, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="chat-timeline"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = Object.assign({ guildId: '0-1', roomId: '!r:x', view: 'room', messages: [], moreHistory: true }, state);
  const ctx = {
    byId: (id) => w.document.getElementById(id),
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(typeof f === 'function' ? f(args) : f); },
    render: () => calls.push(['render']),
    S, Chat: {},
  };
  return { w, sc: w.ChatScroll(ctx), calls, S };
}
const typingCalls = (calls) => calls.filter((c) => c[0] === 'matrix_typing').map((c) => c[1].roomId + ':' + c[1].typing);

// 1. Typing is announced once per 8 s, not per keystroke; a slash command is not a message.
{
  const { sc, calls } = boot();
  sc.noteTyping('h'); sc.noteTyping('he'); sc.noteTyping('hel');
  assert.equal(JSON.stringify(typingCalls(calls)), JSON.stringify(['!r:x:true']));
  sc.noteTyping('/help');
  assert.equal(JSON.stringify(typingCalls(calls)), JSON.stringify(['!r:x:true', '!r:x:false']), 'a command retracts the notice');
  sc.noteTyping('');
  assert.equal(typingCalls(calls).length, 2, 'nothing to retract twice');
}

// 2. Retraction goes to the room that was TOLD, not the one you moved to.
{
  const { sc, calls, S } = boot();
  sc.noteTyping('moving');
  S.roomId = '!other:x';
  sc.stopTyping();
  assert.equal(JSON.stringify(typingCalls(calls)), JSON.stringify(['!r:x:true', '!r:x:false']));
}

// 3. History: one page, prepended, then the beginning; a failed page stops asking.
{
  const { sc, S, calls } = boot({ messages: [{ body: 'now' }] }, { matrix_backfill: { messages: [{ body: 'then' }], more: false } });
  await sc.loadHistory();
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_backfill')[1]), JSON.stringify({ guildId: '0-1', roomId: '!r:x', limit: 40 }));
  assert.equal(JSON.stringify(S.messages.map((m) => m.body)), JSON.stringify(['then', 'now']));
  assert.equal(S.moreHistory, false); assert.equal(S.loadingHistory, false);
  assert.equal(sc.following(), false, 'reading history is not following');
  sc.maybeLoadHistory();
  assert.equal(calls.filter((c) => c[0] === 'matrix_backfill').length, 1, 'the beginning is not asked for again');
}
{
  const { sc, S } = boot({}, { matrix_backfill: new Error('502') });
  await sc.loadHistory();
  assert.equal(S.moreHistory, false, 'a failing page would fail again on the next scroll');
}
{
  let release;
  const { sc, S } = boot({ messages: [{ body: 'a' }] }, { matrix_backfill: () => new Promise((r) => { release = r; }) });
  sc.loadHistory(); S.roomId = '!other:x';
  release({ messages: [{ body: 'stale' }], more: true });
  await tick(5);
  assert.equal(S.messages.length, 1, 'a page for a room you left is dropped');
}

// 4. Following: jsdom measures 0, which reads as "at the bottom"; opening a room says yes.
{
  const { sc } = boot();
  assert.equal(sc.atBottom(), true);
  sc.following(false); assert.equal(sc.following(), false);
  sc.noteScrollPosition(); assert.equal(sc.following(), true);
  sc.following(true); assert.equal(sc.following(), true);
}

console.log('chat-scroll: all checks passed');
