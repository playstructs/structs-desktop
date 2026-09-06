// chat-rent.js: renting capacity from a provider card, with a stub invoke.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-rent.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    invoke: (cmd, args) => { calls.push([cmd, args]); const f = fixtures[cmd]; return f instanceof Error ? Promise.reject(f) : Promise.resolve(f); },
    fmtCount: (n) => String(n),
    cardNote: (box, text, bad) => calls.push(['note', text, !!bad]),
  };
  return { w, rent: w.ChatRent(ctx), calls, el };
}
const card = { id: '10-7', provider: { capacity_min: 100, duration_min: 10, rate_amount: 2, denom_label: 'OHM', rate_denom: 'ualpha' } };

// 1. The quote is the whole cost, in the provider's denom, before anything is signed.
{
  const { rent, el, w, calls } = boot({ matrix_agreement_open: { tx: 'ABC' } });
  const box = el('div');
  rent.rentForm(card, box);
  const quote = box.querySelector('.chat-rent-quote');
  assert.equal(quote.textContent, 'Costs 2000 OHM now, in full', 'rate × capacity × duration');
  const inputs = box.querySelectorAll('input');
  inputs[0].value = '0'; inputs[0].dispatchEvent(new w.Event('input'));
  assert.equal(quote.textContent, 'Enter a capacity and duration');
  const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Confirm');
  assert.ok(confirm.disabled, 'nothing to spend, nothing to confirm');
  inputs[0].value = '12abc'; inputs[0].dispatchEvent(new w.Event('input'));
  assert.equal(inputs[0].value, '12', 'digits only, in place');
  assert.equal(inputs[0].type, 'text', 'text, not number: SUI styles text inputs only');
  confirm.click();
  await tick(5);
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_agreement_open')[1]), JSON.stringify({ providerId: '10-7', capacity: 12, duration: 10 }));
  assert.ok(!box.querySelector('.chat-rent'), 'the form goes away once the agreement is open');
  assert.ok(calls.some((c) => c[0] === 'note' && /Agreement opened · ABC/.test(c[1])));
}

// 2. A refusal re-arms the button and says why; opening twice does not stack forms.
{
  const { rent, el, w, calls } = boot({ matrix_agreement_open: new Error('insufficient funds') });
  const box = el('div');
  const body = el('div', 'sui-planet-card-body'); box.appendChild(body);
  rent.rentForm(card, box); rent.rentForm(card, box);
  assert.equal(box.querySelectorAll('.chat-rent').length, 1);
  assert.ok(body.querySelector('.chat-rent'), 'inside the card body when the provider is drawn as a card');
  const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Confirm');
  confirm.click();
  await tick(5);
  assert.equal(confirm.textContent, 'Confirm'); assert.ok(!confirm.disabled);
  assert.ok(calls.some((c) => c[0] === 'note' && /insufficient funds/.test(c[1]) && c[2] === true));
  [...box.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  assert.ok(!box.querySelector('.chat-rent'));
}

// 3. Affordability: the escrow is checked against the primary's balance in the RATE denom.
{
  const { rent, el, w } = boot({ mcp_inventory: { assets: [{ denom: 'ualpha', amount: 1, amount_p: 500 }, { denom: 'uguild.0-1', amount_p: 9 }] } });
  const box = el('div');
  rent.rentForm(card, box);
  await tick(5);
  const quote = box.querySelector('.chat-rent-quote');
  const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Confirm');
  assert.equal(quote.textContent, 'Costs 2000 OHM now, in full · you hold 500 · short 1500');
  assert.ok(confirm.disabled && quote.classList.contains('chat-rent-short'), 'a deal that cannot be escrowed cannot be confirmed');
  const inputs = box.querySelectorAll('input');
  inputs[0].value = '20'; inputs[0].dispatchEvent(new w.Event('input'));
  assert.equal(quote.textContent, 'Costs 400 OHM now, in full · you hold 500');
  assert.ok(!confirm.disabled, '…and affordable again once it fits');
}
{
  const { rent, el } = boot({ mcp_inventory: { assets: [{ denom: 'uguild.0-1', amount_p: 9 }] } });
  const box = el('div'); rent.rentForm(card, box); await tick(5);
  assert.ok(/short 2000/.test(box.querySelector('.chat-rent-quote').textContent), 'a loaded set without the denom holds none of it');
}
{
  const { rent, el } = boot({ mcp_inventory: new Error('not signed in') });
  const box = el('div'); rent.rentForm(card, box); await tick(5);
  const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Confirm');
  assert.ok(!confirm.disabled && !/short/.test(box.querySelector('.chat-rent-quote').textContent), 'unknown never blocks');
}

console.log('chat-rent: all checks passed');
