// chat-room.js: the room page and composer, with stub collaborators.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-room.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

function boot(state = {}, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="chat-composer-host"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  w.StructsChatRow = { composer: (o) => { const node = el('div', 'wrap'); const panel = el('div', 'panel'); node.appendChild(panel); const input = el('input'); input.id = o.inputId; const send = el('a', 'send'); const portrait = el('div', 'portrait'); panel.appendChild(input); panel.appendChild(send); panel.appendChild(portrait); return { node, input, send, portrait }; } };
  w.eval(src);
  const S = Object.assign({ guildId: '0-1', roomId: '!r:x', view: 'room', room: { name: 'Galaxy Net' }, messages: [], typing: [], lastRead: {}, profile: { pfp_attrs: null, avatar_published: true } }, state);
  const ctx = {
    el, icon: (n, s) => { const i = el('i', s ? n + ' ' + s : n); return i; }, byId: (id) => w.document.getElementById(id),
    clear: (n) => { while (n.firstChild) n.removeChild(n.firstChild); },
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(fixtures[cmd]); },
    go: (v) => calls.push(['go', v]), S, Chat: {},
    render: () => calls.push(['render']),
    pageHeader: (label, back, right) => { const h = el('div', 'hdr', label); if (right) h.appendChild(right); return h; },
    noticeBlock: (t, d) => el('div', 'notice', t + ' ' + d),
    dayKey: (ts) => Math.floor(Number(ts) / DAY), dayLabel: (ts) => 'day ' + Math.floor(Number(ts) / DAY),
    refreshRooms: () => { calls.push(['refreshRooms']); return Promise.resolve(); },
    openRoom: (id) => calls.push(['openRoom', id]),
    markRead: (room, id) => calls.push(['markRead', room, id]),
    typingLine: (names) => names.length ? names.join(', ') + ' typing' : '',
    setMuted: (m) => calls.push(['setMuted', m]), openSearch: (x) => calls.push(['openSearch', x]),
    pinnedStrip: () => (S.pinsFixture ? el('div', 'pins') : null), seenLine: () => null,
    ruleNode: (l, a) => el('div', 'rule' + (a ? ' alert' : ''), l), historyButton: () => el('div', 'history', 'Load earlier'),
    messageNode: (m) => el('div', 'msg', m.body), excerpt: (t) => t,
    editChip: () => null, cancelEdit: () => calls.push(['cancelEdit']),
    maybeLoadHistory: () => {}, noteTyping: (v) => calls.push(['noteTyping', v]),
    submit: () => calls.push(['submit']), complete: (i, back) => calls.push(['complete', back]),
    recall: (i, d) => calls.push(['recall', d]), resetCompletion: () => {}, clearCompletionHint: () => {},
  };
  return { w, rm: w.ChatRoom(ctx), calls, S };
}

// 1. The header: who is here, silence, search this conversation, connection.
{
  const { rm, calls, S } = boot({ room: { name: 'Galaxy Net', topic: 'ore talk', muted: true } });
  const page = rm.renderRoom();
  assert.ok(/ore talk/.test(page.querySelector('.chat-topic').textContent), 'the topic is shown, as IRC always has');
  page.querySelector('#chat-room-people').click(); page.querySelector('#chat-room-mute').click(); page.querySelector('#chat-room-search').click();
  assert.ok(calls.some((c) => c[0] === 'go' && c[1] === 'members'));
  assert.ok(calls.some((c) => c[0] === 'setMuted' && c[1] === false), 'a silenced room is offered its voice back');
  assert.ok(calls.some((c) => c[0] === 'openSearch' && c[1] === true));
}

// 2. Notices: an upgraded room says where the conversation went; encryption is said once at the top.
{
  const { rm, calls } = boot({ room: { name: 'Old', replaced_by: '!new:x', encrypted: true } }, { matrix_join: {} });
  const page = rm.renderRoom();
  assert.ok(page.querySelector('.chat-mod-moved') && page.querySelector('.chat-encrypted'));
  page.querySelector('.chat-mod-moved .chat-ref-action').click();
  await tick(5);
  const order = calls.filter((c) => ['matrix_join', 'refreshRooms', 'openRoom'].includes(c[0])).map((c) => c[0]);
  assert.equal(JSON.stringify(order), JSON.stringify(['matrix_join', 'refreshRooms', 'openRoom']), 'join first, then go');
}

// 3. The timeline: what is above it, the day rules, the unread divider, and read receipts.
{
  const t0 = 10 * DAY + 1000;
  const messages = [
    { ts: t0, body: 'a', event_id: '$a' },
    { ts: t0 + 10, body: 'b', event_id: '$b' },
    { ts: t0 + DAY, body: 'c', event_id: '$c' },
    { kind: 'gap', ts: 0 },
    { ts: t0 + DAY + 50, body: 'd', event_id: '$d' },
  ];
  const { rm, calls, S } = boot({ messages, moreHistory: true, dividerTs: t0 + 5 });
  const page = rm.renderRoom();
  const rows = [...page.querySelectorAll('#chat-timeline > *')].map((n) => n.className + ':' + n.textContent);
  assert.equal(rows[0], 'history:Load earlier', 'more exists, so the top offers it');
  assert.ok(rows.includes('rule alert:New'), 'the unread divider, where reading stopped');
  assert.equal(rows.filter((r) => /^rule:day/.test(r)).length, 1, 'one date rule between the two days, none across the gap');
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'markRead')), JSON.stringify(['markRead', '!r:x', '$d']), 'everything on screen is read now');
  assert.equal(S.lastRead['!r:x'], t0 + DAY + 50);
  const done = boot({ messages: messages.slice(0, 1), moreHistory: false }).rm.renderRoom();
  assert.equal(done.querySelector('#chat-timeline').firstChild.textContent, 'Beginning');
  assert.ok(/Quiet/.test(boot().rm.renderRoom().textContent), 'an empty room says so');
}

// 4. Typing line and the composer at the foot of the panel.
{
  const { rm, w, S, calls } = boot({ typing: ['Phoniffer'] });
  const page = rm.renderRoom();
  assert.equal(page.querySelector('#chat-typing').textContent, 'Phoniffer typing');
  assert.ok(!page.querySelector('#chat-typing').classList.contains('hidden'));
  const host = w.document.getElementById('chat-composer-host');
  const input = host.querySelector('#chat-input');
  assert.ok(input, 'the composer is mounted outside the page');
  input.value = 'hi'; input.dispatchEvent(new w.Event('input'));
  assert.ok(calls.some((c) => c[0] === 'noteTyping' && c[1] === 'hi'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.ok(calls.some((c) => c[0] === 'submit'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
  assert.ok(calls.some((c) => c[0] === 'complete' && c[1] === true));
  input.setSelectionRange(0, 0);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp' }));
  assert.ok(calls.some((c) => c[0] === 'recall' && c[1] === -1), 'Up from the start of the line recalls');
  assert.ok(/published/.test(host.querySelector('.portrait').getAttribute('data-sui-tooltip')));
}

// 5. Escape drops the reply first; the chip above the bar names what is being answered.
{
  const { rm, w, S, calls } = boot({ replyTo: { sender_name: 'JPEG', body: 'raid?' } });
  rm.renderRoom();
  const host = w.document.getElementById('chat-composer-host');
  assert.ok(/JPEG/.test(host.querySelector('#chat-reply-chip').textContent) && /raid\?/.test(host.querySelector('#chat-reply-chip').textContent));
  host.querySelector('#chat-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(S.replyTo, null);
  host.querySelector('#chat-reply-chip') && host.querySelector('.chat-reply-cancel').click();
}

console.log('chat-room: all checks passed');
