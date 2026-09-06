// raidview-comms.js: the rail beside the board, driven with a stub __TAURI__
// and a stub StructsChatRow. Pins the id boundary, the two panels (own room
// vs search), that speaking is what joins you, and Comms' slash rules.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/raidview-comms.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(target, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="rv-chat-head"><span class="rv-chat-title"></span></div><div id="rv-chat-count"></div><div id="rv-chat-body"></div><div id="rv-chat-compose"><div id="rv-chat-entry"></div></div><div id="rv-chat-error"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  w.__TAURI__ = { core: { invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(typeof f === 'function' ? f(args) : f); } }, event: {} };
  w.StructsEvents = { listen: (name, fn) => calls.push(['listen', name]) };
  w.StructsChatRow = {
    notice: (t, d) => el('div', 'notice', t + ' ' + d),
    render: (m) => { const n = el('div', 'row'); n.appendChild(el('div', 'chat-msg-meta', m.sender_name || '')); return n; },
    composer: (o) => { const node = el('div', 'composer'); const input = el('input'); input.id = o.inputId; const send = el('a', 'send'); const portrait = el('div', 'portrait'); portrait.appendChild(el('div', 'sui-screen-portrait-image')); node.appendChild(input); node.appendChild(send); node.appendChild(portrait); return { node, input, send, portrait, battery: el('div', 'battery') }; },
  };
  w.eval(src);
  const ctx = { el, target: () => target, paintPfp: () => calls.push(['paintPfp']), paintBattery: () => {}, whoLine: (n, i) => (n || '?') + ' (' + i + ')', fmtNum: String };
  return { w, rc: w.RaidComms(ctx), calls };
}
const planet = { id: '2-15361', kind: 'planet' };

// 1. Naming this object, not one whose id merely starts the same way.
{
  const { rc } = boot(planet);
  assert.ok(rc.mentionsObject('raid 2-15361 now', '2-15361'));
  assert.ok(!rc.mentionsObject('raid 2-153610 now', '2-15361'), 'a longer id is a different object');
  assert.ok(!rc.mentionsObject('x2-15361', '2-15361'), 'a letter before it is not a boundary');
  assert.ok(rc.mentionsObject('(2-15361)', '2-15361'));
  assert.equal(rc.objectTitle(), 'Planet 2-15361');
  assert.equal(rc.defaultTopic(), 'Everything said about planet 2-15361.');
  assert.equal(boot({ id: '9-4', kind: 'fleet' }).rc.objectWord(), 'fleet');
}

// 2. Not connected says so; quiet says so; the search path names the room on each row.
{
  const { rc, w } = boot(planet);
  rc.chatState.connected = false; rc.renderChat();
  assert.ok(/Not connected/.test(w.document.getElementById('rv-chat-body').textContent));
  rc.chatState.connected = true; rc.chatState.rows = []; rc.renderChat();
  assert.ok(/Nothing has been said about this planet yet/.test(w.document.getElementById('rv-chat-body').textContent));
  assert.equal(w.document.querySelector('.rv-chat-title').textContent, 'Everything said about planet 2-15361.', 'the topic from the first paint');
  rc.chatState.rows = [{ message: { body: 'hi', sender_name: 'JPEG' }, room_name: 'Galaxy Net' }]; rc.renderChat();
  assert.ok(w.document.querySelector('.rv-chat-room'), 'searching: which room a line came from matters');
  rc.chatState.room = { room_id: '!p:x', joined: true }; rc.renderChat();
  assert.ok(!w.document.querySelector('.rv-chat-room'), 'in the object\'s own room every row would repeat the name');
  assert.equal(w.document.getElementById('rv-chat-count').textContent, '1');
}

// 3. The composer appears only when a message could go somewhere.
{
  const { rc, w } = boot(planet);
  rc.chatState.connected = true; rc.chatState.room = null; rc.syncComposer();
  assert.ok(w.document.getElementById('rv-chat-compose').classList.contains('hidden'), 'no room to reach: no composer');
  rc.chatState.room = { can_create: true }; rc.syncComposer();
  assert.ok(!w.document.getElementById('rv-chat-compose').classList.contains('hidden'));
  assert.ok(w.document.getElementById('rv-chat-input'), 'built once');
  const first = w.document.getElementById('rv-chat-input');
  rc.syncComposer();
  assert.equal(w.document.getElementById('rv-chat-input'), first, '…and kept, so a repaint never throws away the caret');
}

// 4. Speaking is what joins you: the room is created, then the message goes to it, with no id appended.
{
  const { rc, w, calls } = boot(planet, { matrix_object_room_create: { room_id: '!p:x', guild_id: '0-1' }, matrix_send: {}, matrix_timeline: { messages: [], room: {} } });
  rc.chatState.connected = true; rc.chatState.guildId = '0-1'; rc.chatState.room = { can_create: true }; rc.syncComposer();
  const input = w.document.getElementById('rv-chat-input');
  input.value = 'target the extractor'; rc.sendChat();
  await tick(5);
  const order = calls.filter((c) => ['matrix_object_room_create', 'matrix_send'].includes(c[0]));
  assert.equal(JSON.stringify(order.map((c) => c[0])), JSON.stringify(['matrix_object_room_create', 'matrix_send']));
  assert.equal(JSON.stringify(order[1][1]), JSON.stringify({ guildId: '0-1', roomId: '!p:x', body: 'target the extractor', msgtype: null }));
  assert.ok(rc.inRoom()); assert.equal(input.value, '');
}

// 5. Comms' slash rules: `//` escapes, `/me` emotes, anything else is refused rather than published.
{
  const { rc, w, calls } = boot(planet, { matrix_send: {}, matrix_timeline: { messages: [], room: {} } });
  rc.chatState.connected = true; rc.chatState.guildId = '0-1'; rc.chatState.room = { room_id: '!p:x', joined: true }; rc.syncComposer();
  const input = w.document.getElementById('rv-chat-input');
  const sent = () => calls.filter((c) => c[0] === 'matrix_send').map((c) => c[1].body + '|' + c[1].msgtype);
  input.value = '//me waves'; rc.sendChat(); await tick(5);
  assert.equal(JSON.stringify(sent()), JSON.stringify(['/me waves|null']), 'the escape wins over the emote');
  input.value = '/me salutes'; rc.sendChat(); await tick(5);
  assert.equal(sent()[1], 'salutes|m.emote');
  input.value = '/leave'; rc.sendChat(); await tick(5);
  assert.equal(sent().length, 2, 'a command is not a message');
  assert.ok(/Commands live in Comms/.test(w.document.getElementById('rv-chat-error').textContent));
}

// 6. Wiring: the rail reads as soon as it has a target and listens live.
{
  const { rc, calls } = boot(planet, { mcp_inventory: { player: { pfp_attrs: '{}', name: 'Marklifer', player_id: '1-194' } }, matrix_object_room: { room_id: '!p:x', joined: true, guild_id: '0-1' }, matrix_timeline: { messages: [{ body: 'x' }], room: { name: 'Planet 2-15361', topic: 'ore' } } });
  rc.wireChat();
  await tick(10);
  assert.ok(calls.some((c) => c[0] === 'listen' && c[1] === 'matrix::timeline'));
  assert.equal(rc.chatState.myName, 'Marklifer');
  assert.equal(rc.chatState.rows.length, 1); assert.equal(rc.chatState.roomTopic, 'ore');
}

console.log('raid-comms: all checks passed');
