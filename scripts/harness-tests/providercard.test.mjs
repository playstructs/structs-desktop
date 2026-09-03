// The shared provider card (frontend/providercard.js), on its own.
//
// Third of the card family. An offer of energy capacity: price, ranges,
// policy, owner — drawn once, the same way everywhere.
//
//   node scripts/harness-tests/providercard.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(read('frontend/pfp.js'));
w.eval(read('frontend/playercard.js'));
w.eval(read('frontend/providercard.js'));
const XP = w.StructsProviderCard;
const d = w.document;
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

const OFFER = {
  id: '10-1', substation: '4-4', policy: 'openMarket',
  rate: { value: '1', denomLabel: 'ack', denomIcon: null },
  capacity: { min: '1KW', max: '1GW' },
  duration: { min: '9m', max: '61d', blocks: '100 – 1M blocks' },
  owner: { id: '1-170', name: 'TRACINGVIOLET', tag: 'SNC', pfp: '{"head":40,"neck":3,"body":30,"arms":20,"background":2}' },
};

{
  console.log('\n— card');
  let clicked = 0, acted = null, owner = 0;
  const card = XP.card(OFFER, {
    onClick: () => { clicked++; },
    onOwner: () => { owner++; },
    actions: [{ icon: 'icon-transfers', title: 'Rent capacity', onClick: () => { acted = 'rent'; } }],
  });
  d.body.appendChild(card);

  check('it is the same frame as the player card',
    card.classList.contains('sui-planet-card') && card.classList.contains('pc-card') && card.classList.contains('xp-card'));
  check('it carries the provider id', card.getAttribute('data-provider-id') === '10-1');
  check('the header names the offer', text(card.querySelector('.sui-planet-card-header .pc-nm')) === 'Provider 10-1');
  check('the id line carries the substation', text(card.querySelector('.pc-id')) === '#10-1 · 4-4'
    && card.querySelector('.pc-id').title === 'Substation 4-4');
  check('the policy is the badge', text(card.querySelector('.sui-badge.sui-mod-default')) === 'OPEN');
  check('the emblem is the transfers glyph', !!card.querySelector('.gc-emblem .icon-transfers'));

  // Readings: price with its unit, two ranges with the game's glyphs.
  check('the price reads "1 ack / W / blk"', /^1 ack \/ W \/ blk$/i.test(text(card.querySelector('.xp-rate'))),
    text(card.querySelector('.xp-rate')));
  const ranges = card.querySelectorAll('.xp-range');
  check('capacity is a range with the energy glyph',
    text(ranges[0]) === '1KW – 1GW' && !!ranges[0].querySelector('.sui-icon-energy'), text(ranges[0]));
  check('duration is a range in time, blocks on hover',
    text(ranges[1]) === '9m – 61d' && /100 – 1M blocks/.test(ranges[1].title), ranges[1].title);
  check('no reading is captioned', !/RATE|CAPACITY|DURATION|MARKET/i.test(text(card)), text(card));

  // The owner is a small player line.
  const own = card.querySelector('.xp-owner');
  check('the owner is a player line with their portrait',
    text(own) === '[SNC] TRACINGVIOLET #1-170' && own.querySelectorAll('.pfp-viewer-layer').length === 5, text(own));
  own.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking the owner fires onOwner, not the card', owner === 1 && clicked === 0);

  const act = card.querySelector('.pc-act');
  check('a door is an icon with a title', !!act && act.title === 'Rent capacity' && text(act) === '');
  act.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking a door fires it, not the card', acted === 'rent' && clicked === 0);
  card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking the card opens it', clicked === 1);

  // Alpha-priced: the glyph, not the word.
  const alpha = XP.card({ id: '10-7', policy: 'guildMarket', rate: { value: '2', denomIcon: 'sui-icon-alpha-matter' } });
  check('an alpha price shows the alpha glyph', !!alpha.querySelector('.xp-rate .sui-icon-alpha-matter')
    && !/alpha/i.test(text(alpha.querySelector('.xp-rate'))));
  check('a guild market is a warning badge', text(alpha.querySelector('.sui-badge.sui-mod-warning')) === 'GUILD');
  const closed = XP.card({ id: '10-12', policy: 'closedMarket' });
  check('a closed market is a destructive badge', text(closed.querySelector('.sui-badge.sui-mod-destructive')) === 'CLOSED');
  const bare = XP.card({ id: '10-3' });
  check('an unknown policy gets no badge, and nothing else is invented',
    !bare.querySelector('.sui-badge') && !bare.querySelector('.pc-res') && !bare.querySelector('.pc-foot'));

  const hostile = XP.card({ id: '10-4', owner: { id: '1-1', name: '<img src=x onerror=alert(1)>', pfp: '{"head":"../x"}' },
                            rate: { value: '1', denomLabel: '<b>' } });
  check('hostile names and denoms are text', !hostile.querySelector('img[src="x"]') && !hostile.querySelector('b')
    && text(hostile).includes('<img'));
  const src = read('frontend/providercard.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('the component never touches innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('it is built from the player card\'s parts', /StructsPlayerCard/.test(src)
    && !/function actions\(|function badge\(|function el\(/.test(src));
}

{
  console.log('\n— chip');
  let opened = 0;
  const chip = XP.chip(OFFER, { onClick: () => { opened++; } });
  check('a clickable chip is a link', chip.tagName === 'A' && chip.classList.contains('gc-chip'));
  check('one line: glyph, price, id, policy',
    !!chip.querySelector('.gc-emblem.gc-xs .icon-transfers') && text(chip) === '1 ack / W / blk #10-1 OPEN', text(chip));
  chip.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking it opens', opened === 1);
  const inert = XP.chip({ id: '10-9', rate: { value: '3', denomLabel: 'snack' } });
  check('an inert chip is not a link', inert.tagName === 'SPAN' && text(inert) === '3 snack / W / blk #10-9', text(inert));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
