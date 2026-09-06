// chat-search.js: search, driven with a stub invoke.
// Pins that a search is a round trip on Enter only, that a slow answer to an
// old question never paints over a newer one, the two scopes, and that a hit
// opens the room it was in.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
// Values built inside jsdom's realm never deepEqual ours: compare by JSON.

const src = fs.readFileSync(new URL('../../frontend/chat-search.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = { guildId: '0-1', roomId: '!r:x', view: 'search', searchHits: [], searchRoom: null, searchQuery: '' };
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    icon: (name, size) => { const n = w.document.createElement('i'); n.className = size ? name + ' ' + size : name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return typeof f === 'function' ? f(args) : Promise.resolve(f); },
    go: (v) => calls.push(['go', v]),
    pageHeader: (label, back, right) => { const n = el('div', 'hdr', label); if (right) n.appendChild(right); return n; },
    noticeBlock: (t, d) => el('div', 'notice', t + ' ' + d),
    unreadFor: (id) => ({ name: 'Galaxy Net' }),
    messageNode: (m) => el('div', 'msg', m.body),
    openRoom: (id) => calls.push(['openRoom', id]),
    render: () => calls.push(['render']),
    showError: (m) => calls.push(['showError', m]),
    S, Chat: {},
  };
  return { w, sr: w.ChatSearch(ctx), calls, S };
}

// 1. Enter searches; typing does not.
{
  const { sr, calls, w } = boot({ matrix_search: { hits: [] } });
  const page = sr.renderSearch();
  const input = page.querySelector('#chat-search-query');
  input.value = 'raid';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a' }));
  assert.ok(!calls.some((c) => c[0] === 'matrix_search'), 'a keystroke is not a question');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  const q = calls.find((c) => c[0] === 'matrix_search');
  assert.equal(JSON.stringify(q[1]), JSON.stringify({ guildId: '0-1', query: 'raid' }), 'everywhere: no roomId');
}

// 2. Scoped to the conversation when asked.
{
  const { sr, calls, S } = boot({ matrix_search: { hits: [] } });
  sr.openSearch(true);
  assert.equal(S.searchRoom, '!r:x');
  assert.ok(calls.some((c) => c[0] === 'go' && c[1] === 'search'));
  sr.runSearch('ore');
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_search')[1]), JSON.stringify({ guildId: '0-1', query: 'ore', roomId: '!r:x' }));
  assert.equal(sr.roomNameOf('!r:x'), 'Galaxy Net');
}

// 3. A slow answer to an old question must not paint over a newer one.
{
  let release;
  const first = new Promise((r) => { release = r; });
  const { sr, S } = boot({ matrix_search: (args) => (args.query === 'old' ? first : Promise.resolve({ hits: [{ room_id: '!r:x', message: { body: 'new hit' } }] })) });
  sr.runSearch('old');
  sr.runSearch('new');
  await tick(5);
  assert.equal(S.searchHits.length, 1, 'the newer answer landed');
  release({ hits: [{ room_id: '!r:x', message: { body: 'stale' } }, { room_id: '!r:x', message: { body: 'stale2' } }] });
  await tick(5);
  assert.equal(S.searchHits.length, 1, 'the older answer was thrown away');
  assert.equal(S.searchHits[0].message.body, 'new hit');
}

// 4. An empty query clears rather than asks; a hit opens its room.
{
  const { sr, calls, S } = boot({ matrix_search: { hits: [] } });
  S.searchRan = true; S.searchHits = [{ room_id: '!a:x', message: { body: 'x' } }];
  sr.runSearch('   ');
  assert.equal(S.searchRan, false); assert.equal(JSON.stringify(S.searchHits), JSON.stringify([]));
  assert.ok(!calls.some((c) => c[0] === 'matrix_search'));
  const hit = sr.searchHit({ room_id: '!a:x', room_name: 'Trade', message: { body: 'ore for alpha' } });
  assert.ok(/Trade/.test(hit.textContent) && /ore for alpha/.test(hit.textContent));
  hit.querySelector('a').click();
  assert.ok(calls.some((c) => c[0] === 'openRoom' && c[1] === '!a:x'));
}

// 5. The scope toggle is only offered when there is a conversation to be narrower than.
{
  const { sr, S } = boot();
  assert.ok(sr.searchScopeToggle());
  S.roomId = null;
  assert.equal(sr.searchScopeToggle(), null);
}

console.log('chat-search: all checks passed');
