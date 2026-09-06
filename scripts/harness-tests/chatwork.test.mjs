// chat-work.js: the shared proof-of-work cards, driven with a stub invoke.
// jsdom does no layout; this pins the wiring — which command each click
// sends with which arguments, and what the card says back.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-work.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

function boot(fixtures) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = { view: 'room', guildId: '0-1', roomId: '!r:x' };
  let renders = 0;
  const errors = [];
  const ctx = {
    el: (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    icon: (name) => { const n = w.document.createElement('i'); n.className = name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); },
    serverIdOf: (m) => m.id,
    showError: (e) => errors.push(e),
    render: () => { renders += 1; },
    S,
    Chat: {},
  };
  const work = w.ChatWork(ctx);
  return { w, work, calls, ctx, errors, renders: () => renders };
}

const offer = { id: '$e1', work: { kind: 'offer', task: 'MINE', object: '5-2184', block_start: 812004, difficulty: 5 } };
const result = { id: '$e2', work: { kind: 'result', task: 'MINE', object: '5-2184', block_start: 812004, difficulty: 5, nonce: '12345' } };

// 1. An offer draws its facts and a Help action; the freshness check is asked ONCE per anchor.
{
  const { work, calls } = boot({ matrix_work_status: { known: true, live: true } });
  const card = work.workCard(offer);
  assert.ok(card.className.includes('chat-kind-offer'));
  assert.ok(card.textContent.includes('Work wanted'));
  assert.ok(card.textContent.includes('block 812004'), 'the anchor is shown: it is why a proof goes stale');
  assert.ok(card.querySelector('.chat-ref-action').textContent.includes('Help'));
  work.workCard(offer);
  assert.equal(calls.filter(([c]) => c === 'matrix_work_status').length, 1, 'one status read per anchor');
  assert.equal(work.workKey(offer.work), '5-2184|MINE|812004');
}

// 2. A dead cycle replaces the buttons with a verdict; unknown never greys out.
{
  const dead = boot({ matrix_work_status: { known: true, live: false } });
  dead.work.workCard(offer);
  await tick();
  assert.equal(dead.renders(), 1, 'a learned verdict re-renders the room');
  const card = dead.work.workCard(offer);
  assert.ok(card.className.includes('chat-mod-stale'));
  assert.ok(card.textContent.includes('can no longer be proved'));
  assert.equal(card.querySelector('.chat-ref-action'), null);
  const unknown = boot({ matrix_work_status: { known: false } });
  unknown.work.workCard(offer);
  await tick();
  assert.ok(!unknown.work.workCard(offer).className.includes('chat-mod-stale'), 'offline is not dead');
}

// 3. Help sends exactly the offer's parameters and reports the outcome in the card.
{
  const { work, calls, w } = boot({ matrix_work_status: { known: false }, matrix_work_accept: { already: false } });
  const card = work.workCard(offer);
  card.querySelector('.chat-ref-action').dispatchEvent(new w.Event('click'));
  await tick();
  const accept = calls.find(([c]) => c === 'matrix_work_accept');
  assert.deepEqual(JSON.parse(JSON.stringify(accept[1])), {
    guildId: '0-1', roomId: '!r:x', offerEvent: '$e1',
    objectId: '5-2184', task: 'MINE', blockStart: 812004, difficulty: 5, targetId: null,
  });
  assert.ok(card.querySelector('.chat-work-verdict').textContent.includes('Working on it'));
}

// 4. A result is CHECKED before Submit exists; a bad nonce never offers Submit.
{
  const ok = boot({ matrix_work_status: { known: false }, matrix_work_verify: { ok: true }, matrix_work_submit: {} });
  const card = ok.work.workCard(result);
  assert.ok(card.querySelector('.chat-ref-action').textContent.includes('Check'));
  assert.equal(card.querySelector('.chat-work-submit'), null, 'no Submit before a check');
  card.querySelector('.chat-ref-action').dispatchEvent(new ok.w.Event('click'));
  await tick();
  assert.ok(card.querySelector('.chat-work-verdict').textContent.includes('Checks out'));
  const submit = card.querySelector('.chat-work-submit');
  assert.ok(submit, 'Submit appears only after the check');
  submit.dispatchEvent(new ok.w.Event('click'));
  await tick();
  assert.ok(ok.calls.some(([c, a]) => c === 'matrix_work_submit' && a.nonce === '12345'));
  assert.ok(card.querySelector('.chat-work-verdict').textContent.includes('Submitted'));

  const bad = boot({ matrix_work_status: { known: false }, matrix_work_verify: { ok: false } });
  const c2 = bad.work.workCard(result);
  c2.querySelector('.chat-ref-action').dispatchEvent(new bad.w.Event('click'));
  await tick();
  assert.ok(c2.querySelector('.chat-work-verdict').textContent.includes('does not solve'));
  assert.equal(c2.querySelector('.chat-work-submit'), null);
}

console.log('chatwork: ok');
