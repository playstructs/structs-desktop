// chat-message.js: one timeline message, driven with a stub invoke and a stub
// StructsChatRow. Pins that a body is never parsed as markup, that an id
// inside a link is part of the link, that only the first reference expands,
// and that a picture is fetched once through Rust at the reserved size.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-message.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /(^|[^0-9A-Za-z_-])(\d{1,2}-\d{1,9})(?![0-9-])/g;
const REF_KINDS = { 0: 1, 1: 1, 2: 1, 4: 1, 5: 1, 9: 1, 10: 1 };

function boot(state = {}, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // The shared row: a head with a meta slot the controls hook fills.
  w.StructsChatRow = { render: (m, prev, hooks) => { const row = el('div', 'row'); const meta = el('div', 'meta'); row.appendChild(meta); if (hooks.controls) hooks.controls(m, meta); row.setAttribute('data-sender', m.sender || ''); return row; } };
  w.eval(src);
  const S = Object.assign({ guildId: '0-1', roomId: '!r:x', view: 'room', openRefs: {} }, state);
  const ctx = {
    el,
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); },
    render: () => calls.push(['render']),
    mentionsMe: () => false,
    startDm: (id) => calls.push(['startDm', id]),
    refCards: {}, refCard: (c) => el('div', 'card', c.id), wantRefs: (ids) => calls.push(['wantRefs', ids.join(',')]),
    ID_RE, REF_KINDS,
    loadHistory: () => calls.push(['loadHistory']),
    retrySend: (m) => calls.push(['retrySend', m.body]),
    workCard: () => null,
    serverIdOf: (m) => m.event_id,
    reactButton: () => el('a', 'ctl react'), reactionRow: () => null,
    editButton: () => el('a', 'ctl edit'), deleteButton: () => el('a', 'ctl del'),
    replyButton: () => el('a', 'ctl reply'), pinToggle: () => el('a', 'ctl pin'), isPinned: () => false,
    jumpTo: (id) => calls.push(['jumpTo', id]), replyWho: () => 'Phoniffer',
    S, Chat: {},
  };
  return { w, msg: w.ChatMessage(ctx), calls, S, ctx };
}

// 1. Spans: links first, ids inside them are part of the link, trailing punctuation is the sentence.
{
  const { msg } = boot();
  assert.equal(msg.trimUrl('https://x.io/a).'), 'https://x.io/a');
  const spans = msg.spansIn('see https://oh.energy/planet/2-223. and 2-223 and 1-194, but 7-1 is plumbing');
  assert.equal(JSON.stringify(spans.map((s) => s.kind + ':' + s.text)), JSON.stringify(['url:https://oh.energy/planet/2-223', 'id:2-223', 'id:1-194']));
  assert.equal(JSON.stringify(msg.refIdsIn('2-223 then 2-223 then 1-194')), JSON.stringify(['2-223', '1-194']), 'deduped, in order');
}

// 2. The body is never parsed: markup from a stranger stays text.
{
  const { msg, w, S, calls } = boot();
  const node = w.document.createElement('div');
  msg.fillBody(node, '<b>raid</b> 2-223 & 5-9 https://x.io', false);
  assert.ok(!node.querySelector('b'), 'no element came from the body');
  assert.ok(node.textContent.startsWith('<b>raid</b> 2-223'));
  const chips = [...node.querySelectorAll('.chat-id')];
  assert.equal(chips.length, 2);
  assert.ok(!chips[0].classList.contains('chat-mod-openable') && chips[1].classList.contains('chat-mod-openable'), 'only the first reference expands on its own');
  chips[1].click();
  assert.equal(S.openRefs['5-9'], 1); assert.ok(calls.some((c) => c[0] === 'render'));
  node.querySelector('.chat-link').click();
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_open_url')[1]), JSON.stringify({ url: 'https://x.io' }), 'a link opens through Rust, in the system browser');
  const local = w.document.createElement('div');
  msg.fillBody(local, 'raid 2-223', true);
  assert.ok(!local.querySelector('.chat-id'), 'a local line is plain text');
}

// 3. A message: controls only for a settled message, your own gets edit and delete.
{
  const { msg } = boot();
  const mine = msg.messageNode({ event_id: '$1', self: true, body: 'hi', sender: '@me' });
  assert.equal(JSON.stringify([...mine.querySelectorAll('.ctl')].map((c) => c.className)), JSON.stringify(['ctl react', 'ctl reply', 'ctl pin', 'ctl edit', 'ctl del']));
  const theirs = msg.messageNode({ event_id: '$2', body: 'yo', sender: '@them' });
  assert.equal(theirs.querySelectorAll('.ctl').length, 3);
  assert.equal(msg.messageNode({ event_id: 'local-1', body: 'sending', pending: true }).querySelectorAll('.ctl').length, 0, 'a local echo has nothing to act on yet');
}

// 4. The quote line answers "what does this answer" and jumps there; a failed send offers a retry.
{
  const { msg, calls } = boot();
  const reply = msg.messageNode({ event_id: '$3', body: 'yes', reply_to: '$1', reply_excerpt: 'raid?' });
  const q = reply.querySelector('.chat-reply-quote');
  assert.ok(/Phoniffer/.test(q.textContent) && /raid\?/.test(q.textContent));
  q.click();
  assert.ok(calls.some((c) => c[0] === 'jumpTo' && c[1] === '$1'));
  const failed = msg.messageNode({ body: 'x', failed: true, retry: true, error: 'no charge' });
  assert.ok(/Not sent — no charge/.test(failed.textContent));
  failed.querySelector('.chat-ref-action').click();
  assert.ok(calls.some((c) => c[0] === 'retrySend' && c[1] === 'x'));
  msg.messageNode({ event_id: '$4', body: 'raid 2-223 with 9-4' });
  assert.equal(calls.find((c) => c[0] === 'wantRefs')[1], '2-223,9-4', 'the ids a message names are asked for, once each');
}

// 5. A picture is fetched once through Rust, at the size it is shown, and laid out before it lands.
{
  const { msg, calls } = boot({}, { matrix_media: { data_url: 'data:image/png;base64,AA==' } });
  const m = { kind: 'image', mxc: 'mxc://m/abc', body: 'fleet.png', width: 640, height: 480 };
  const first = msg.imageNode(m);
  assert.equal(first.style.width, '320px'); assert.equal(first.style.aspectRatio, '640 / 480');
  assert.ok(first.querySelector('.chat-image-loading'));
  msg.imageNode(m);
  assert.equal(calls.filter((c) => c[0] === 'matrix_media').length, 1, 'one fetch per picture');
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_media')[1]), JSON.stringify({ guildId: '0-1', mxc: 'mxc://m/abc', size: 320 }));
  await tick(5);
  assert.ok(msg.imageNode(m).querySelector('img').src.startsWith('data:image/png'));
}

// 6. Rules and the history button.
{
  const { msg, calls } = boot();
  assert.ok(msg.ruleNode('New', true).classList.contains('chat-mod-alert'));
  assert.ok(!msg.ruleNode('Beginning').classList.contains('chat-mod-alert'));
  msg.historyButton().querySelector('button').click();
  assert.ok(calls.some((c) => c[0] === 'loadHistory'));
}

// N. The pin control is offered only to an account the server would let pin.
{
  const m = { event_id: '$e1', sender: '@1-61:h', body: 'hold the line', kind: 'text' };
  const has = (state) => {
    const { msg } = boot(state);
    return !!msg.messageNode(m, null).querySelector('.ctl.pin');
  };
  assert.equal(has({ room: { my_power: 0 } }), false, 'power 0 is always refused, so it is not offered');
  assert.equal(has({ room: { my_power: 50 } }), true, 'a moderator pins');
  assert.equal(has({ room: { my_power: 100 } }), true);
  assert.equal(has({ room: {} }), true, 'a payload that says nothing about power still offers it');
  assert.equal(has({}), true);
}

// R. What unfurls: every new object up to three, nothing already named just
// above, and a message that is only an id gives its place to the row.
{
  const t0 = 1787900000000;
  const line = (n, body, extra) => Object.assign({ event_id: '$' + n, sender: '@a', body, ts: t0 + n * 1000 }, extra || {});
  const messages = [line(1, 'raid 2-223'), line(2, 'joined', { kind: 'event' }), line(3, '2-223 again, with 9-4'), line(4, '2-223'),
    line(5, 'a 1-1 b 1-2 c 1-3 d 1-4'), line(6, 'late 2-223', { ts: t0 + 3600 * 1000 })];
  const { msg, S, ctx } = boot({ messages });
  const plan = (m) => { const p = msg.unfurlPlan(m); return { auto: Object.keys(p.auto).join(','), held: p.held.join(','), bare: p.bare }; };
  assert.deepEqual(plan(messages[0]), { auto: '2-223', held: '', bare: false });
  assert.deepEqual(plan(messages[2]), { auto: '9-4', held: '', bare: false }, 'named two lines up: no second row, and an event line is not a line');
  assert.deepEqual(plan(messages[3]), { auto: '2-223', held: '', bare: true }, 'a bare id always shows its row');
  assert.deepEqual(plan(messages[4]), { auto: '1-1,1-2,1-3', held: '1-4', bare: false }, 'three rows, the fourth counted');
  assert.deepEqual(plan(messages[5]), { auto: '2-223', held: '', bare: false }, 'an hour on, it is new again');

  // Drawn: rows through refUnfurl, keyed by message and id.
  const keys = [];
  ctx.refUnfurl = null;
  const boot2 = boot({ messages });
  const el2 = boot2.ctx.el;
  Object.assign(boot2.ctx.refCards, { '2-223': { id: '2-223' }, '9-4': { id: '9-4' }, '1-1': { id: '1-1' }, '1-2': { id: '1-2' }, '1-3': { id: '1-3' }, '1-4': { id: '1-4' } });
  boot2.ctx.refUnfurl = (c, key, open) => { keys.push([key, open]); return el2('div', 'card', c.id); };
  const m2 = boot2.w.ChatMessage(boot2.ctx);
  const repeat = m2.messageNode(messages[2], messages[1]);
  assert.equal(JSON.stringify([...repeat.querySelectorAll('.card')].map((c) => c.textContent)), JSON.stringify(['9-4']));
  assert.ok(repeat.querySelector('.chat-id.chat-mod-openable').textContent === '2-223', 'the repeat is a link that opens its row here');
  assert.ok(!repeat.querySelector('.chat-msg-body').classList.contains('hidden'));
  const bare = m2.messageNode(messages[3], messages[2]);
  assert.ok(bare.querySelector('.chat-msg-body').classList.contains('hidden'), 'the row stands in for a bare id');
  assert.equal(bare.querySelectorAll('.card').length, 1);
  assert.deepEqual(keys.pop(), ['$4|2-223', false]);
  const whois = m2.messageNode({ body: '1-1', local: true, ts: t0 }, null);
  assert.equal(keys.pop()[1], true, 'a local line that is only an id asked for the card');
  assert.ok(whois.querySelector('.card'));
  const many = m2.messageNode(messages[4], messages[3]);
  assert.equal(many.querySelectorAll('.card').length, 3);
  const more = many.querySelector('.chat-ref-more');
  assert.equal(more.textContent, '+1 more');
  more.click();
  assert.equal(boot2.S.openRefs['1-4'], 1);
  assert.equal(m2.messageNode(messages[4], messages[3]).querySelectorAll('.card').length, 4);
  // Unresolved: the id stays on screen as text until there is a row to replace it.
  const b3 = boot({ messages });
  assert.ok(!b3.msg.messageNode(messages[3], null).querySelector('.chat-msg-body').classList.contains('hidden'));
  void S;
}

console.log('chat-message: all checks passed');
