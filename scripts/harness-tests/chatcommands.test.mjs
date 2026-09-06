// chat-commands.js: what a typed line becomes, the command table, and the
// optimistic send with its failure/retry path.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-commands.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

function boot(fixtures) {
  const dom = new JSDOM('<!doctype html><html><body><input id="chat-input"></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const seen = { go: [], dm: [], edits: [], remembered: [], atBottom: 0, typingStopped: 0, resets: 0 };
  const S = { guildId: '0-1', roomId: '!r:x', view: 'room', messages: [], openRefs: {}, editing: null, replyTo: null, room: { topic: 'raids at dawn' }, profile: { user_id: '@me:x', display_name: 'Me', tag: 'SN' } };
  const refCards = {};
  const c = w.ChatCommands({
    byId: (id) => w.document.getElementById(id),
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); },
    excerpt: (t) => String(t || '').slice(0, 20),
    go: (v) => seen.go.push(v),
    openSearch: () => {},
    refreshRooms: () => Promise.resolve(),
    startDm: (who, body) => seen.dm.push([who, body]),
    commitEdit: (t) => seen.edits.push(t),
    rememberSent: (t) => seen.remembered.push(t),
    resetCompletion: () => { seen.resets += 1; },
    render: () => {},
    scrollToEnd: () => {},
    stopTyping: () => { seen.typingStopped += 1; },
    mentionsIn: (t) => (t.match(/@\w+/g) || []),
    atBottom: () => { seen.atBottom += 1; },
    refCards, S, Chat: {},
  });
  const input = w.document.getElementById('chat-input');
  return { c, S, calls, seen, input, refCards };
}
const notices = (S) => S.messages.filter((m) => m.local).map((m) => m.body);

// 1. submit: an edit commits, "//" escapes, "/" runs, anything else sends; the line is remembered.
{
  const { c, S, seen, input, calls } = boot({ matrix_send: { event_id: '$s1' } });
  input.value = '  hello  '; c.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(seen.remembered)), ['hello']);
  assert.equal(input.value, '', 'cleared as part of sending');
  assert.equal(calls[0][0], 'matrix_send');
  input.value = '//slash'; c.submit();
  assert.equal(calls[1][1].body, '/slash', 'a leading // sends a literal slash');
  S.editing = { event_id: '$e', body: 'old' };
  input.value = '/help'; c.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(seen.edits)), ['/help'], 'editing takes the line before commands do');
  assert.equal(seen.resets, 3);
}

// 2. The command table: help lists every command and key; unknown never sends.
{
  const { c, S, calls } = boot({});
  c.runCommand('help');
  const help = notices(S)[0];
  c.COMMANDS.forEach((cmd) => assert.ok(help.includes('/' + cmd.name), cmd.name));
  c.SHORTCUTS.forEach((k) => assert.ok(help.includes(k.keys), k.keys));
  c.runCommand('qui');
  assert.ok(notices(S).pop().includes('No command /qui'));
  assert.equal(calls.length, 0, 'an unknown command is never sent as chat');
  c.runCommand('topic');
  assert.ok(notices(S).pop().includes('raids at dawn'));
}

// 3. Commands with arguments reach the right collaborator or command.
{
  const { c, S, seen, calls } = boot({ matrix_join: {}, matrix_leave: {}, matrix_refs: { refs: [{ id: '1-61', kind: 'player', title: 'JPEG' }] } });
  c.runCommand('me waves'); assert.equal(calls[0][1].msgtype, 'm.emote');
  c.runCommand('msg @1-61 hi there'); assert.deepEqual(JSON.parse(JSON.stringify(seen.dm[0])), ['1-61', 'hi there']);
  c.runCommand('msg'); assert.ok(notices(S).pop().includes('/msg needs'));
  c.runCommand('join #ops'); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([x]) => x === 'matrix_join')[1])), { guildId: '0-1', roomId: '#ops' });
  c.runCommand('leave'); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(seen.go)), ['channels']);
  c.runCommand('whois 1-61'); await tick();
  assert.equal(S.openRefs['1-61'], 1, 'the card opens');
  S.messages.push({ sender_name: 'Nero', sender_tag: 'SN', body: 'x' });
  c.runCommand('who');
  assert.ok(notices(S).pop().includes('[SN] Nero'));
}

// 4. sendMessage: optimistic echo with mentions and reply; a failure stays on screen with a retry.
{
  const { c, S, calls, seen } = boot({ matrix_send: { event_id: '$ok' } });
  S.replyTo = { event_id: '$q', sender: '@nero:x', body: 'question' };
  c.sendMessage('yes @Nero');
  const echo = S.messages[0];
  assert.ok(echo.pending && echo.self && echo.reply_to === '$q');
  assert.equal(seen.typingStopped, 1);
  assert.equal(seen.atBottom, 1, 'your own message wins the scroll');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].mentions)), ['@Nero']);
  assert.equal(calls[0][1].replyTo.eventId, '$q');
  await tick();
  assert.equal(echo.pending, false); assert.equal(echo.echo_of, '$ok');

  const bad = boot({ matrix_send: new Error('offline') });
  bad.c.sendMessage('later');
  await tick();
  const m = bad.S.messages[0];
  assert.ok(m.failed && m.error === 'Error: offline' && m.retry.text === 'later');
  assert.equal(m.body, 'later', 'the error sits beside the words, not in them');
  bad.calls.length = 0;
  bad.c.retrySend(m);
  assert.equal(bad.S.messages.length, 1, 'the failed echo is replaced, not duplicated');
  assert.equal(bad.calls[0][1].body, 'later');
}

console.log('chatcommands: ok');
