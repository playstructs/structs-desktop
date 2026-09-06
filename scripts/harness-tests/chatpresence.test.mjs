// chat-presence.js: who is here, seen, stalls, reply, silence — with a stub invoke.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-presence.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(state = {}, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body><input id="chat-input"></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = Object.assign({ guildId: '0-1', roomId: '!r:x', view: 'room', room: { room_id: '!r:x' }, rooms: [{ room_id: '!r:x' }, { room_id: '!o:x' }], presence: {}, presenceKnown: false }, state);
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    icon: (name, size) => { const n = w.document.createElement('i'); n.className = size ? name + ' ' + size : name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(fixtures[cmd]); },
    byId: (id) => w.document.getElementById(id),
    render: () => calls.push(['render']),
    moveCaretToEnd: () => calls.push(['caret']),
    showError: (m) => calls.push(['showError', m]),
    S, Chat: {},
  };
  return { w, pr: w.ChatPresence(ctx), calls, S };
}

// 1. One dot, three states, and unknown draws nothing (unknown is not offline).
{
  const { pr, S } = boot();
  assert.equal(pr.presenceDot('1-1'), null, 'nothing until presence is known');
  pr.onPresence({ guild_id: '0-1', presence: { '1-1': { state: 'online' }, '1-2': { state: 'unavailable' }, '1-3': { state: 'offline' } } });
  assert.ok(S.presenceKnown);
  assert.ok(pr.presenceDot('1-1').classList.contains('chat-mod-online'));
  assert.ok(pr.presenceDot('1-2').classList.contains('chat-mod-idle'));
  assert.ok(pr.presenceDot('1-3').classList.contains('chat-mod-away'));
  assert.equal(pr.presenceDot('1-9'), null, 'unknown, which is not offline');
  assert.equal(pr.presenceDot(null), null);
  pr.onPresence({ guild_id: '0-2', presence: {} });
  assert.ok(S.presenceKnown, 'another guild\'s push is not ours');
}

// 2. Seen: only for the room on screen; three names is a sentence, ten is not.
{
  const { pr, S } = boot();
  pr.onSeen({ room_id: '!o:x', seen: { names: ['x'] } });
  assert.equal(S.seen, undefined);
  pr.onSeen({ room_id: '!r:x', seen: { names: ['A', 'B', 'C'] } });
  assert.equal(pr.seenLine().textContent, 'Seen by A, B, C');
  S.seen = { names: ['A', 'B', 'C', 'D', 'E'] };
  assert.equal(pr.seenLine().textContent, 'Seen by A, B and 3 more');
  S.seen = null; assert.equal(pr.seenLine(), null);
}

// 3. A stall is shown wherever the player is, with its reason.
{
  const { pr, S } = boot();
  assert.equal(pr.stalledBanner(), null);
  pr.onSyncHealth({ ok: false, reason: 'timeout' });
  assert.ok(/Not receiving messages/.test(pr.stalledBanner().textContent) && /timeout/.test(pr.stalledBanner().textContent));
  pr.onSyncHealth({ ok: true });
  assert.equal(pr.stalledBanner(), null);
}

// 4. Silence keeps the count and updates both copies of the room.
{
  const { pr, S, calls } = boot({}, { matrix_mute: {} });
  await pr.setMuted(true);
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_mute')[1]), JSON.stringify({ guildId: '0-1', roomId: '!r:x', muted: true }));
  assert.equal(S.room.muted, true); assert.equal(S.rooms[0].muted, true); assert.equal(S.rooms[1].muted, undefined);
}

// 5. Reply arms the composer and puts the caret back.
{
  const { pr, S, calls } = boot();
  const m = { sender: '@1-248:m', sender_name: 'Phoniffer', body: 'hi' };
  const a = pr.replyButton(m);
  assert.equal(a.title, 'Reply to Phoniffer');
  a.click();
  assert.equal(S.replyTo, m);
  assert.ok(calls.some((c) => c[0] === 'caret'));
}

// 6. Loading presence also learns whether you are sharing.
{
  const { pr, S } = boot({}, { matrix_presence: { presence: { '1-1': { state: 'online' } }, known: true, sharing: true, status: 'Mining' } });
  await pr.loadPresence();
  assert.ok(S.presenceKnown && S.sharingStatus && S.myStatus === 'Mining');
}

console.log('chat-presence: all checks passed');
