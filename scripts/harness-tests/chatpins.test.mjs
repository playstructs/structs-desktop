// chat-pins.js: pinned messages and the quote helpers, driven with a stub invoke.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-pins.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(state = {}, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = Object.assign({ guildId: '0-1', roomId: '!r:x', room: { room_id: '!r:x', pinned: [] }, rooms: [{ room_id: '!r:x', pinned: [] }], pinsOpen: {}, pins: [], messages: [], addressBook: {} }, state);
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    icon: (name, size) => { const n = w.document.createElement('i'); n.className = size ? name + ' ' + size : name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(typeof f === 'function' ? f(args) : f); },
    render: () => calls.push(['render']),
    showError: (m) => calls.push(['showError', m]),
    messageNode: (m) => el('div', 'msg', m.body),
    unreadFor: (id) => S.rooms.find((r) => r.room_id === id),
    say: (t) => calls.push(['say', t]),
    serverIdOf: (m) => m.event_id,
    S, Chat: {},
  };
  return { w, pn: w.ChatPins(ctx), calls, S };
}

// 1. The same room reaches the window twice; whichever copy is fresher wins.
{
  const { pn, S } = boot();
  S.room.pinned = ['$a']; S.rooms[0].pinned = ['$a', '$b'];
  assert.equal(pn.pinsOf('!r:x').length, 2);
  S.room.pinned = ['$a', '$b', '$c'];
  assert.equal(pn.pinsOf('!r:x').length, 3);
  assert.equal(pn.pinCount(), 3); assert.ok(pn.isPinned('$b') && !pn.isPinned('$z'));
}

// 2. The strip: nothing without pins, one line collapsed, opening reads them.
{
  const { pn, S, calls } = boot({}, { matrix_pinned: { messages: [{ body: 'target 2-15361' }] } });
  assert.equal(pn.pinnedStrip(), null);
  S.room.pinned = ['$a'];
  const strip = pn.pinnedStrip();
  assert.ok(/Pinned message$/.test(strip.querySelector('.chat-pins-label').textContent) && !strip.querySelector('.chat-pins-body'));
  strip.querySelector('.chat-pins-head').click();
  await tick(5);
  assert.equal(S.pinsOpen['!r:x'], true);
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_pinned')[1]), JSON.stringify({ guildId: '0-1', roomId: '!r:x' }));
  S.room.pinned = ['$a', '$b'];
  assert.ok(/2 pinned messages/.test(pn.pinnedStrip().textContent) && pn.pinnedStrip().querySelector('.msg'));
}

// 3. A local echo has no id yet and cannot be pinned; a real pin updates both copies.
{
  const { pn, S, calls } = boot({}, { matrix_pin: { pinned: ['$a'] }, matrix_pinned: { messages: [] } });
  pn.setPin('local-1', true);
  assert.ok(!calls.some((c) => c[0] === 'matrix_pin'));
  await pn.setPin('$a', true);
  assert.equal(JSON.stringify(S.room.pinned), JSON.stringify(['$a']));
  assert.equal(JSON.stringify(S.rooms[0].pinned), JSON.stringify(['$a']));
  assert.equal(S.pinsOpen['!r:x'], true, 'a fresh pin opens the strip');
}

// 4. Pins that arrive for a room you have left are dropped.
{
  let release;
  const { pn, S } = boot({}, { matrix_pinned: () => new Promise((r) => { release = r; }) });
  pn.loadPins(); S.roomId = '!other:x';
  release({ messages: [{ body: 'stale' }] });
  await tick(5);
  assert.equal(S.pins.length, 0);
}

// 5. Quote helpers.
{
  const { pn, S, calls, w } = boot({ messages: [{ sender: '@1-248:m', sender_name: 'Phoniffer' }], addressBook: { '1-61': { name: 'JPEG' } } });
  assert.equal(pn.replyWho({ reply_sender: '@1-248:m' }), 'Phoniffer', 'from the timeline first');
  assert.equal(pn.replyWho({ reply_sender: '@1-61:m' }), 'JPEG', 'then the address book');
  assert.equal(pn.replyWho({ reply_sender: '@1-9:m' }), '1-9', 'then the id');
  assert.equal(pn.replyWho({}), 'a message');
  assert.equal(pn.excerpt('a  b\n c'), 'a b c');
  assert.equal(pn.excerpt('x'.repeat(200)).length, 120);
  pn.jumpTo('$missing');
  assert.ok(calls.some((c) => c[0] === 'say' && /further back/.test(c[1])), 'a message not loaded is said, not guessed at');
  const node = w.document.createElement('div'); node.setAttribute('data-event', '$here'); w.document.body.appendChild(node);
  pn.jumpTo('$here');
  assert.ok(node.classList.contains('chat-mod-found'));
  assert.equal(pn.cssEscape('a"b\\c'), 'a\\"b\\\\c');
}

console.log('chat-pins: all checks passed');
