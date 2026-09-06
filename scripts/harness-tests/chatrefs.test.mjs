// chat-refs.js: the object-reference cards, driven with a stub invoke.
// Pins the id boundary rule, the one-lookup-per-id batching, and that a
// card's actions send an ID and nothing else.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-refs.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(fixtures) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = { view: 'room', guildId: '0-1', roomId: '!r:x' };
  const ctx = {
    el: (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    icon: (name) => { const n = w.document.createElement('i'); n.className = name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(typeof f === 'function' ? f(args) : f); },
    fmtCount: (n) => String(n),
    go: () => {},
    pfpPortrait: () => w.document.createElement('div'),
    presenceDot: () => null,
    render: () => {},
    rentForm: () => {},
    startDm: (id) => calls.push(['startDm', id]),
    S,
    Chat: {},
  };
  return { w, refs: w.ChatRefs(ctx), calls, ctx };
}

// 1. The id boundary is strict on both sides: 1-194 is not 1-1945.
{
  const { refs } = boot({});
  const found = (text) => { const out = []; let m; refs.ID_RE.lastIndex = 0; while ((m = refs.ID_RE.exec(text)) !== null) out.push(m[2]); return out; };
  assert.deepEqual(found('raid 1-194 and 1-1945 now'), ['1-194', '1-1945']);
  assert.deepEqual(found('x5-2184 and 5-21845'), ['5-21845'], 'a leading letter is not an id; the digits run to their end');
  assert.deepEqual(found('at 2-223.'), ['2-223']);
  assert.deepEqual(found('1-194-3'), [], 'a third segment is something else');
  assert.ok(refs.REF_KINDS[1] && refs.REF_KINDS[5] && refs.REF_KINDS[10], 'players, structs, providers are referenceable');
  assert.ok(!refs.REF_KINDS[6] && !refs.REF_KINDS[7], 'allocations and infusions are plumbing');
}

// 2. Lookups are batched: three ids named across two lines cost ONE call, and a known id is never re-asked.
{
  const { refs, calls } = boot({ matrix_refs: (args) => ({ refs: args.ids.map((id) => ({ id, kind: 'player', title: 'P' + id })) }) });
  refs.wantRefs(['1-194', '1-195']);
  refs.wantRefs(['1-195', '1-196']);
  await tick(50);
  refs.flushRefs();
  await tick();
  const lookups = calls.filter(([c]) => c === 'matrix_refs');
  assert.equal(lookups.length, 1, 'one batched call');
  assert.deepEqual(JSON.parse(JSON.stringify(lookups[0][1].ids)).sort(), ['1-194', '1-195', '1-196']);
  assert.equal(refs.cards['1-195'].title, 'P1-195');
  refs.wantRefs(['1-195']);
  refs.flushRefs();
  await tick();
  assert.equal(calls.filter(([c]) => c === 'matrix_refs').length, 1, 'known ids are not asked again');
}

// 3. A plain card shows its title, and its message action hands over the ID only.
{
  const { refs, calls } = boot({});
  const card = refs.refCard({ id: '2-223', kind: 'planet', title: 'Kepler', planet_id: '2-223' });
  assert.ok(card.className.includes('chat-kind-planet'));
  assert.ok(card.textContent.includes('Kepler'));
  const player = refs.refCard({ id: '1-61', kind: 'player', title: 'JPEG' });
  assert.ok(player.textContent.includes('JPEG'));
  const note = refs.cardNote(player, 'hello', false);
  assert.ok(player.textContent.includes('hello'));
  void note; void calls;
}

// 4. A player is ALWAYS the shared player card — with no portrait too — and gets its charge.
{
  const { refs, w } = boot({});
  const drawn = [];
  w.StructsPlayerCard = { card: (p, opts) => { drawn.push([p, opts]); const n = w.document.createElement('div'); n.className = 'pc-card'; return n; } };
  const box = refs.refCard({ id: '1-195', kind: 'player', title: '1-195', subtitle: '[OH] PID #1-195', pfp_attrs: '', charge: 3, rows: [{ label: 'Alpha', value: '0µg' }], actions: [{ key: 'message', label: 'Message', icon: 'icon-phone' }] });
  assert.ok(box.querySelector('.pc-card'), 'the shared player card, not the generic thing-card');
  assert.equal(drawn[0][0].id, '1-195');
  assert.equal(drawn[0][0].pfp, null, 'no portrait → the component draws its placeholder');
  assert.equal(drawn[0][0].charge, 3, 'raw charge reaches the battery');
  assert.equal(drawn[0][0].sub, '[OH]');
  assert.equal(drawn[0][1].actions[0].title, 'Message');
  const noCharge = refs.refCard({ id: '1-9', kind: 'player', title: 'X', subtitle: 'PID #1-9' });
  assert.ok(noCharge.querySelector('.pc-card'));
  assert.equal(drawn[1][0].charge, null, 'an unknown charge draws no battery rather than an empty one');
}

console.log('chatrefs: ok');
