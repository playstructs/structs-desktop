// chat-people.js: who is here, the channel directory, the player directory
// and starting a direct message — driven with a stub invoke.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
// Values built inside jsdom's realm never deepEqual ours: compare by JSON.

const src = fs.readFileSync(new URL('../../frontend/chat-people.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = { guildId: '0-1', roomId: '!r:x', view: 'members', members: [], browse: [], people: [], room: { name: 'Galaxy Net' } };
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    icon: (name, size) => { const n = w.document.createElement('i'); n.className = size ? name + ' ' + size : name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(typeof f === 'function' ? f(args) : f); },
    go: (v) => calls.push(['go', v]),
    pageHeader: (label) => el('div', 'hdr', label),
    noticeBlock: (t, d) => el('div', 'notice', t + ' ' + d),
    render: () => calls.push(['render']),
    showError: (m) => calls.push(['showError', m]),
    pfpPortrait: () => el('div', 'pfp'),
    presenceDot: (id) => (id ? el('i', 'dot') : null),
    roomRow: (r, browsing) => el('div', 'roomrow' + (browsing ? ' browsing' : ''), r.name),
    refreshRooms: () => { calls.push(['refreshRooms']); return Promise.resolve(); },
    openRoom: (id) => { calls.push(['openRoom', id]); return Promise.resolve(); },
    sendMessage: (b) => calls.push(['sendMessage', b]),
    say: (t, alert) => calls.push(['say', t, alert]),
    S, Chat: {},
  };
  return { w, pp: w.ChatPeople(ctx), calls, S };
}

// 1. A member row: a player can be messaged, a bot cannot, you are marked.
{
  const { pp, calls } = boot({ matrix_dm: { room_id: '!dm:x' } });
  const me = pp.memberRow({ player_id: '1-194', name: 'Marklifer', is_self: true, tag: 'SNC' });
  assert.ok(/Marklifer \(you\)/.test(me.textContent) && !me.querySelector('button'), 'you cannot message yourself');
  const bot = pp.memberRow({ user_id: '@bot:x', name: 'Herald' });
  assert.ok(bot.querySelector('.icon-computer') && !bot.querySelector('.pfp') && !bot.querySelector('button'), 'a bot gets its own glyph and no Message button');
  const them = pp.memberRow({ player_id: '1-248', name: 'Phoniffer', presence: { status_msg: 'raiding' } });
  assert.ok(them.querySelector('.dot') && /raiding/.test(them.textContent), 'presence first, then what they say they are doing');
  them.querySelector('button').click();
  await tick(5);
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_dm')[1]), JSON.stringify({ guildId: '0-1', playerId: '1-248' }));
  assert.ok(calls.some((c) => c[0] === 'refreshRooms') && calls.some((c) => c[0] === 'openRoom' && c[1] === '!dm:x'), 'a DM is refreshed into the list and opened');
}

// 2. Members load for the room that asked, not the one you moved to.
{
  let release;
  const { pp, S, calls } = boot({ matrix_members: () => new Promise((r) => { release = r; }) });
  pp.loadMembers();
  S.roomId = '!other:x';
  release({ members: [{ player_id: '1-1', name: 'x' }] });
  await tick(5);
  assert.equal(S.members.length, 0, 'a stale answer for a room you left is dropped');
}

// 3. Browse: the unjoined and the busiest first; typing asks the server after a pause.
{
  const { pp, S, w, calls } = boot({ matrix_browse: { rooms: [] } });
  const rooms = [{ name: 'in', joined: true, members: 900 }, { name: 'empty', members: 0 }, { name: 'busy', members: 3100 }];
  assert.equal(JSON.stringify(rooms.slice().sort(pp.browseOrder).map((r) => r.name)), JSON.stringify(['busy', 'empty', 'in']));
  S.browse = rooms; S.view = 'browse';
  const page = pp.renderBrowse();
  assert.equal(page.querySelectorAll('.roomrow.browsing').length, 3, 'rows are drawn as directory rows');
  const input = page.querySelector('#chat-browse-query');
  input.value = 'tr'; input.dispatchEvent(new w.Event('input'));
  assert.ok(!calls.some((c) => c[0] === 'matrix_browse'), 'not per keystroke');
  await tick(300);
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_browse')[1]), JSON.stringify({ guildId: '0-1', query: 'tr' }));
}

// 4. People: a person row says who, and a DM with a body says it.
{
  const { pp, S, calls } = boot({ matrix_dm: { room_id: '!dm:x' }, matrix_people: { people: [] } });
  const row = pp.personRow({ player_id: '1-61', username: 'JPEG', tag: 'OH' });
  assert.ok(/\[OH\]/.test(row.textContent) && /JPEG/.test(row.textContent) && /PID #1-61/.test(row.textContent));
  assert.ok(/Name Redacted/.test(pp.personRow({ player_id: '1-9' }).textContent), 'no name is said plainly');
  await pp.startDm('1-61', 'hello');
  assert.ok(calls.some((c) => c[0] === 'sendMessage' && c[1] === 'hello'), '/msg bob hello opens the conversation AND says hello');
}

// 5. A DM that cannot be addressed lands in the timeline when you are in one.
{
  const { pp, S, calls } = boot({ matrix_dm: new Error('their guild runs no comms server') });
  S.view = 'room';
  await pp.startDm('1-7');
  assert.ok(calls.some((c) => c[0] === 'say' && /no comms server/.test(c[1]) && c[2] === true), 'said in the room, as an alert');
  assert.ok(!calls.some((c) => c[0] === 'showError'));
}

console.log('chat-people: all checks passed');
