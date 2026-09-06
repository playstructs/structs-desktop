// chat-channels.js: the Channels page, driven with a stub invoke.
// Pins the reading order (what named you, then unread, then by name; silenced
// last), that Enter opens the SAME first row the eye sees, what a row says
// for a DM / an invitation / a directory hit, and that Join sends an id only.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
// Values built inside jsdom's realm never deepEqual ours: compare by JSON.

const src = fs.readFileSync(new URL('../../frontend/chat-channels.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(rooms, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = { rooms, guildId: '0-1', profile: { user_id: '@1-194:matrix.oh.energy' }, roomFilter: '' };
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    icon: (name, size) => { const n = w.document.createElement('i'); n.className = size ? name + ' ' + size : name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); },
    fmtCount: (n) => String(n ?? 0),
    go: (v) => calls.push(['go', v]),
    pfpPortrait: () => el('div', 'pfp'),
    presenceDot: (id) => (id ? el('i', 'dot') : null),
    render: () => calls.push(['render']),
    refreshRooms: () => { calls.push(['refreshRooms']); return Promise.resolve(); },
    showError: (m) => calls.push(['showError', m]),
    openRoom: (id) => calls.push(['openRoom', id]),
    headerResources: () => null,
    pageHeader: (label) => el('div', 'hdr', label),
    byId: (id) => w.document.getElementById(id),
    moveCaretToEnd: () => {},
    noticeBlock: (t, d) => el('div', 'notice', t + ' ' + d),
    S, Chat: {},
  };
  return { w, ch: w.ChatChannels(ctx), calls, S, ctx };
}

const R = (o) => Object.assign({ room_id: '!' + o.name + ':matrix.oh.energy', joined: true, section: 'galaxy', members: 3 }, o);

// 1. Reading order within a section.
{
  const { ch } = boot([]);
  const rows = [
    R({ name: 'b-quiet' }), R({ name: 'a-quiet' }),
    R({ name: 'unread', unread: 2 }), R({ name: 'busier', unread: 9 }),
    R({ name: 'named', unread: 1, mention: true }),
    R({ name: 'muted-named', unread: 40, mention: true, muted: true }),
  ];
  const order = rows.slice().sort(ch.roomOrder).map((r) => r.name);
  assert.equal(JSON.stringify(order), JSON.stringify(['named', 'busier', 'unread', 'a-quiet', 'b-quiet', 'muted-named']),
    'mentions first, then unread busiest-first, then by name; a silenced room never jumps the queue');
}

// 2. Enter opens the first row the eye sees: same list, same order, sections first.
{
  const rooms = [
    R({ name: 'zeta', section: 'galaxy', unread: 5, mention: true }),
    R({ name: 'alpha-dm', section: 'direct', player_id: '1-195' }),
    R({ name: 'ask', section: 'invite', joined: false, invited: true, invited_by: '1-61' }),
  ];
  const { ch, S } = boot(rooms);
  assert.equal(JSON.stringify(ch.filteredRooms().map((r) => r.name)), JSON.stringify(['ask', 'alpha-dm', 'zeta']), 'Invitations, Direct, Local, Galaxy');
  S.roomFilter = 'ZET';
  assert.equal(JSON.stringify(ch.filteredRooms().map((r) => r.name)), JSON.stringify(['zeta']), 'the filter is case-insensitive on name');
  assert.ok(ch.matchesFilter(R({ name: 'x', canonical_alias: '#zeta-net:matrix.oh.energy' })), '…and matches the alias too');
}

// 3. What a row says.
{
  const { ch, w } = boot([]);
  const dm = ch.roomRow(R({ name: 'Phoniffer', section: 'direct', player_id: '1-248', tag: 'SNC' }));
  assert.ok(/PID #1-248/.test(dm.textContent) && !/Players/.test(dm.textContent), 'a DM is a person, not a member count');
  assert.ok(dm.querySelector('.pfp'), 'a DM gets the portrait');
  const chan = ch.roomRow(R({ name: 'Galaxy', members: 1 }));
  assert.ok(/1 Player$/.test(chan.textContent.trim()) || /1 Player/.test(chan.textContent), 'singular for one');
  const inv = ch.roomRow(R({ name: 'ask', joined: false, invited: true, invited_by: '1-61' }));
  assert.ok(/Invited by 1-61/.test(inv.textContent), 'an invitation says who asked');
  const btns = [...inv.querySelectorAll('button')].map((b) => b.textContent);
  assert.equal(JSON.stringify(btns), JSON.stringify(['Decline', 'Accept']), 'an invitation can be turned down or accepted');
  const found = ch.roomRow(R({ name: 'Trade', joined: false, canonical_alias: '#trade:matrix.orbital.hydro', topic: 'ore for alpha' }), true);
  assert.ok(/#trade/.test(found.textContent) && /orbital\.hydro/.test(found.textContent) && /ore for alpha/.test(found.textContent),
    'browsing shows the address, the foreign server and the topic');
  assert.equal(JSON.stringify([...found.querySelectorAll('button')].map((b) => b.textContent)), JSON.stringify(['Join']), 'nothing to decline in a directory');
  const own = ch.roomRow(R({ name: 'Home', joined: false, canonical_alias: '#home:matrix.oh.energy' }), true);
  assert.ok(!/oh\.energy/.test(own.textContent), 'your own server is never stamped on a row');
  const muted = ch.roomRow(R({ name: 'Noise', unread: 3, mention: true, muted: true }));
  assert.ok(muted.querySelector('.chat-room-muted') && !muted.querySelector('.sui-mod-warning'), 'a silenced room shows its count without the warning colour');
}

// 4. Join sends an id and nothing else, then opens the room when browsing.
{
  const { ch, calls } = boot([], { matrix_join: {} });
  const row = ch.roomRow(R({ name: 'Trade', joined: false }), true);
  row.querySelector('button').click();
  await tick(5);
  const join = calls.find((c) => c[0] === 'matrix_join');
  assert.equal(JSON.stringify(join[1]), JSON.stringify({ guildId: '0-1', roomId: '!Trade:matrix.oh.energy' }));
  assert.ok(calls.some((c) => c[0] === 'openRoom' && c[1] === '!Trade:matrix.oh.energy'), 'joining from the directory is a decision to go there');
}

// 5. The page: home channels first in their own group, the filter only when the list is long.
{
  const rooms = [];
  for (let i = 0; i < 9; i++) rooms.push(R({ name: 'room' + i }));
  rooms.push(R({ name: 'SN Corp', home_rank: 0 }));
  const { ch, S, w } = boot(rooms);
  const page = ch.renderChannels();
  const labels = [...page.querySelectorAll('.chat-net-label')].map((n) => n.textContent);
  assert.equal(JSON.stringify(labels), JSON.stringify(['Structs', 'Galaxy Net']), 'the home channel sits above every section');
  assert.ok(page.querySelector('#chat-room-filter-q'), 'ten rooms earn a filter box');
  S.rooms = rooms.slice(0, 3);
  assert.ok(!ch.renderChannels().querySelector('#chat-room-filter-q'), 'three rooms do not');
  S.filterWanted = true;
  assert.ok(ch.renderChannels().querySelector('#chat-room-filter-q'), '…unless Ctrl-K asked for it');
}

console.log('chat-channels: all checks passed');
