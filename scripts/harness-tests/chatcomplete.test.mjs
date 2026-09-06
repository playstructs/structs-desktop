// chat-complete.js: Tab completion and input history over a real <input>.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-complete.js', import.meta.url), 'utf8');

function boot() {
  const dom = new JSDOM('<!doctype html><html><body><input id="in"><div id="chat-complete-hint"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const S = {
    messages: [
      { sender_name: 'Marklifer', body: 'raid 2-15361 now' },
      { sender_name: 'Phoniffer', body: 'watch 2-855 and 5-2184' },
      { self: true, sender_name: 'me', body: 'ok' },
    ],
    people: [{ username: 'Marklifer' }, { username: 'Nero' }],
    myIds: [{ id: '2-223', label: 'home' }],
    sent: [], sentAt: -1,
  };
  const wanted = [];
  const c = w.ChatComplete({
    el: (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    byId: (id) => w.document.getElementById(id),
    refIdsIn: (body) => (String(body || '').match(/\d{1,2}-\d+/g) || []),
    wantRefs: (ids) => wanted.push(...ids),
    refCards: { '2-855': { title: 'Kepler', subtitle: 'planet' } },
    commands: () => [{ name: 'help' }, { name: 'here' }, { name: 'join' }],
    S, Chat: {},
  });
  const input = w.document.getElementById('in');
  const hint = w.document.getElementById('chat-complete-hint');
  return { w, c, S, input, hint, wanted };
}

// 1. A command stem completes and cycles; a bare "/" walks the whole list.
{
  const { c, input } = boot();
  input.value = '/he'; input.setSelectionRange(3, 3);
  c.complete(input, false);
  assert.equal(input.value, '/help ');
  c.complete(input, false);
  assert.equal(input.value, '/here ', 'Tab again cycles');
  c.complete(input, true);
  assert.equal(input.value, '/help ', 'Shift+Tab walks back');
  input.value = '/'; input.setSelectionRange(1, 1); c.resetCompletion();
  c.complete(input, false);
  assert.equal(input.value, '/help ');
}

// 2. A name becomes a mention; people not yet heard are completable; an empty stem does nothing.
{
  const { c, input } = boot();
  input.value = 'hey ma'; input.setSelectionRange(6, 6);
  c.complete(input, false);
  assert.equal(input.value, 'hey @Marklifer ');
  input.value = 'ne'; input.setSelectionRange(2, 2); c.resetCompletion();
  c.complete(input, false);
  assert.equal(input.value, '@Nero ', 'from the people list, before they have spoken');
  input.value = 'x '; input.setSelectionRange(2, 2); c.resetCompletion();
  c.complete(input, false);
  assert.equal(input.value, 'x ', 'nothing to complete off an empty stem');
}

// 3. An id stem offers what the room said, newest first, then your own; the hint names it.
{
  const { c, input, hint, wanted } = boot();
  assert.deepEqual(JSON.parse(JSON.stringify(c.idCompletions('2-'))), ['2-855', '2-15361', '2-223']);
  input.value = 'go 2-'; input.setSelectionRange(5, 5);
  c.complete(input, false);
  assert.equal(input.value, 'go 2-855 ', 'an id is never prefixed with @');
  assert.ok(hint.textContent.includes('Kepler'), 'the resolved card is shown');
  assert.ok(hint.textContent.includes('1/3'));
  c.complete(input, false);
  assert.equal(input.value, 'go 2-15361 ');
  assert.ok(hint.textContent.includes('looking it up'), 'an unresolved id is asked for');
  assert.ok(wanted.includes('2-15361'));
}

// 4. History: Up recalls newest first, walking past the newest restores the draft; no consecutive duplicates.
{
  const { c, S, input } = boot();
  c.rememberSent('first'); c.rememberSent('second'); c.rememberSent('second');
  assert.deepEqual(JSON.parse(JSON.stringify(S.sent)), ['first', 'second']);
  input.value = 'draft';
  c.recall(input, -1); assert.equal(input.value, 'second');
  c.recall(input, -1); assert.equal(input.value, 'first');
  c.recall(input, -1); assert.equal(input.value, 'first', 'stops at the oldest');
  c.recall(input, 1); assert.equal(input.value, 'second');
  c.recall(input, 1); assert.equal(input.value, 'draft', 'past the newest is the draft again');
  assert.equal(S.sentAt, -1);
}

console.log('chatcomplete: ok');
