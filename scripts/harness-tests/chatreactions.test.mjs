// chat-reactions.js: reaction glyphs, optimistic reactions, two-click removal.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-reactions.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

function boot(fixtures) {
  const dom = new JSDOM('<!doctype html><html><body><input id="chat-input"></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  let renders = 0;
  const errors = [];
  const S = { guildId: '0-1', roomId: '!r:x', messages: [], pins: [], reactPicker: null, reactStructs: false, editing: null, deleteArmed: null };
  const r = w.ChatReactions({
    el: (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    icon: (name) => { const n = w.document.createElement('i'); n.className = name; return n; },
    byId: (id) => w.document.getElementById(id),
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); },
    excerpt: (t) => String(t || '').slice(0, 20),
    moveCaretToEnd: () => {},
    render: () => { renders += 1; },
    showError: (e) => errors.push(e),
    S, Chat: {},
  });
  return { w, r, S, calls, errors, renders: () => renders };
}

// 1. Glyphs: a known shortcode is the game's icon, struct art is an image, anything else is itself.
{
  const { r } = boot({});
  assert.equal(r.reactionGlyph(':raid:').className, 'icon-raid');
  const art = r.reactionGlyph(':struct/tank:');
  assert.equal(art.tagName, 'IMG');
  assert.ok(art.getAttribute('src').endsWith('img/structs/tank/tank-struct-base.png'));
  assert.equal(r.reactionGlyph(':struct/not-a-hull:').textContent, ':struct/not-a-hull:', 'unknown hull is plain text');
  assert.equal(r.reactionGlyph('👍').textContent, '👍', 'an emoji from another client shows as itself');
}

// 2. Optimistic reactions: add, remove-to-zero, sort by count then key.
{
  const { r } = boot({});
  const before = [{ key: ':okay:', count: 2, mine: false, who: ['a', 'b'] }, { key: ':raid:', count: 1, mine: true, who: ['me'] }];
  const added = r.optimistic(before, ':mine:', true);
  assert.deepEqual(JSON.parse(JSON.stringify(added.map((x) => [x.key, x.count, x.mine]))), [[':okay:', 2, false], [':mine:', 1, true], [':raid:', 1, true]]);
  const removed = r.optimistic(before, ':raid:', false);
  assert.deepEqual(JSON.parse(JSON.stringify(removed.map((x) => x.key))), [':okay:'], 'a key nobody holds is gone, not zero');
}

// 3. Reacting sends the server id, applies at once, and rolls back on refusal.
{
  const ok = boot({ matrix_react: { reactions: [{ key: ':okay:', count: 1, mine: true, who: ['me'] }] } });
  const m = { event_id: '$e1', reactions: [] };
  ok.S.messages.push(m);
  await ok.r.react(m, ':okay:', true);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls[0][1])), { guildId: '0-1', roomId: '!r:x', eventId: '$e1', key: ':okay:', on: true });
  assert.equal(m.reactions[0].count, 1);
  const bad = boot({ matrix_react: new Error('nope') });
  const m2 = { event_id: '$e2', reactions: [] };
  await bad.r.react(m2, ':okay:', true);
  assert.deepEqual(JSON.parse(JSON.stringify(m2.reactions)), [], 'put back; it did not happen');
  assert.equal(bad.errors.length, 1);
}

// 4. serverIdOf: only a real event id, or the id a send came back with.
{
  const { r } = boot({});
  assert.equal(r.serverIdOf({ event_id: '$abc' }), '$abc');
  assert.equal(r.serverIdOf({ event_id: 'local-1', echo_of: '$abc' }), '$abc');
  assert.equal(r.serverIdOf({ event_id: 'local-1' }), null);
  // A picker must never open on a local line: no id, no row.
  const { r: r2, S } = boot({});
  S.reactPicker = null;
  assert.equal(r2.reactionRow({ event_id: 'local-1', reactions: [] }), null);
}

// 5. Removal takes two clicks; a redaction from elsewhere rewrites the message.
{
  const { r, S, w, calls } = boot({ matrix_redact: {} });
  const m = { event_id: '$e3', body: 'oops', reactions: [{ key: ':okay:', count: 1 }] };
  S.messages.push(m);
  const b = r.deleteButton(m, '$e3');
  b.dispatchEvent(new w.Event('click'));
  assert.equal(S.deleteArmed, '$e3', 'first click arms');
  assert.equal(calls.length, 0, 'nothing sent yet');
  r.deleteButton(m, '$e3').dispatchEvent(new w.Event('click'));
  await tick();
  assert.equal(calls[0][0], 'matrix_redact');
  assert.equal(m.body, 'message removed');
  const other = { event_id: '$e4', body: 'gone', reactions: [{ key: ':x:' }] };
  S.messages.push(other);
  r.onRedacted({ guild_id: '0-1', room_id: '!r:x', event_id: '$e4' });
  assert.equal(other.kind, 'notice');
  assert.deepEqual(JSON.parse(JSON.stringify(other.reactions)), []);
  r.onRedacted({ guild_id: '0-9', room_id: '!r:x', event_id: '$e3' });
  assert.equal(m.body, 'message removed', 'another guild\'s room is ignored');
}

console.log('chatreactions: ok');
