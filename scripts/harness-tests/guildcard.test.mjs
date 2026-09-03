// The shared guild card (frontend/guildcard.js), on its own.
//
// The player card's sibling: every place the app draws a guild — Best Guilds,
// a guild named in Comms, the Comms network line, an Explore profile's guild,
// the War lists — goes through this one component.
//
//   node scripts/harness-tests/guildcard.test.mjs
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
w.eval(read('frontend/guildcard.js'));
const GC = w.StructsGuildCard;
const d = w.document;
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

{
  console.log('\n— card');
  let clicked = 0;
  let acted = null;
  const card = GC.card({
    id: '0-1', name: 'SN Corp', tag: 'SNC', logo: 'img/logo-snc.gif',
    badge: { text: 'HOME', mod: 'warning' },
    readings: [
      { value: '2,489', icon: 'sui-icon-players', title: 'Members' },
      { value: '3.3Kg', icon: 'sui-icon-alpha-matter', title: 'Alpha infused' },
      { value: '27MW', icon: 'sui-icon-energy', title: 'Capacity' },
      { value: '155', icon: 'sui-icon-md icon-planet', title: 'Planets' },
    ],
  }, {
    onClick: () => { clicked++; },
    actions: [{ icon: 'icon-outgoing', title: 'Share in Comms', onClick: () => { acted = 'share'; } }],
  });
  d.body.appendChild(card);

  check('it is the same frame as the player card',
    card.classList.contains('sui-planet-card') && card.classList.contains('pc-card') && card.classList.contains('gc-card'));
  check('it carries the guild id', card.getAttribute('data-guild-id') === '0-1');
  check('tag, then name, in the header',
    /^\[SNC\] SN Corp/.test(text(card.querySelector('.sui-planet-card-header .pc-name'))),
    text(card.querySelector('.sui-planet-card-header .pc-name')));
  check('the id is bare', text(card.querySelector('.pc-id')) === '#0-1');
  check('the badge is a sui-badge', text(card.querySelector('.sui-badge.sui-mod-warning')) === 'HOME');
  check('a logo becomes the emblem', !!card.querySelector('.gc-emblem img[src="img/logo-snc.gif"]'));
  check('no reading is captioned', !/MEMBERS|ALPHA|CAPACITY|PLANETS/i.test(text(card)), text(card));
  check('four readings with the game\'s glyphs', card.querySelectorAll('.pc-res').length === 4
    && !!card.querySelector('.pc-res .sui-icon-players') && !!card.querySelector('.pc-res .icon-planet'));
  check('readings say what they are on hover', card.querySelector('.pc-res').title === 'Members');
  const act = card.querySelector('.pc-act');
  check('a door is an icon with a title', !!act && act.title === 'Share in Comms' && text(act) === '');
  act.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking a door fires it, not the card', acted === 'share' && clicked === 0);
  card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking the card opens it', clicked === 1);

  // No logo: the guild glyph, in the same frame. A broken logo ends up the same.
  const plain = GC.card({ id: '0-9' });
  check('a nameless guild is "Guild <id>"', text(plain.querySelector('.pc-nm')) === 'Guild 0-9');
  check('no logo, the guild glyph', !!plain.querySelector('.gc-emblem .icon-guild') && !plain.querySelector('.gc-emblem img'));
  check('no doors, no footer', !plain.querySelector('.pc-foot'));
  const broken = GC.card({ id: '0-8', logo: 'https://nowhere.invalid/logo.png' });
  const img = broken.querySelector('.gc-emblem img');
  img.dispatchEvent(new w.Event('error'));
  check('a logo that fails to load becomes the glyph',
    !broken.querySelector('.gc-emblem img') && !!broken.querySelector('.gc-emblem .icon-guild'));
  const hostile = GC.card({ id: '0-7', name: '<b>x</b>', logo: 'javascript:alert(1)' });
  check('a hostile name is text', text(hostile).includes('<b>x</b>') && !hostile.querySelector('b'));
  check('a hostile logo is refused', !hostile.querySelector('img'));

  // Comments stripped: the file documents the rule it must not break.
  const src = read('frontend/guildcard.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('the component never touches innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('it is built from the player card\'s parts, not a second copy',
    /StructsPlayerCard/.test(src) && !/function reading\(|function actions\(|function badge\(/.test(src));
}

{
  console.log('\n— row');
  const row = GC.row({ id: '0-2', prefix: '#2', name: 'Oh Energy', tag: 'OH', badge: { text: 'ALLY', mod: 'default' },
    readings: [{ value: '140', icon: 'sui-icon-players', title: 'Members' }, { value: '2.64Kg', icon: 'sui-icon-alpha-matter', title: 'Alpha' }] },
    { actions: [{ icon: 'icon-outgoing', title: 'Share' }] });
  check('a row is one aligned line, like the player row', row.classList.contains('pc-row') && row.classList.contains('gc-row'));
  check('rank, tag, name, badge on the name line', text(row.querySelector('.pc-name')) === '#2 [OH] Oh Energy ALLY', text(row.querySelector('.pc-name')));
  check('the id on its own line', text(row.querySelector('.pc-id')) === '#0-2');
  check('a 44px emblem', !!row.querySelector('.gc-emblem.gc-sm .icon-guild'));
  check('readings and a door', row.querySelectorAll('.pc-res').length === 2 && row.querySelectorAll('.pc-act').length === 1);
}

{
  console.log('\n— chip');
  let opened = 0;
  const chip = GC.chip({ id: '0-2', name: 'Oh Energy', tag: 'OH' }, { onClick: () => { opened++; } });
  check('a clickable chip is a link', chip.tagName === 'A' && chip.classList.contains('gc-chip'));
  check('one line: emblem, tag, name, id',
    !!chip.querySelector('.gc-emblem.gc-xs .icon-guild') && text(chip) === '[OH] Oh Energy #0-2', text(chip));
  chip.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking it opens', opened === 1);
  const inert = GC.chip({ id: '0-3' });
  check('an inert chip is not a link', inert.tagName === 'SPAN' && !inert.classList.contains('pc-mod-clickable'));
  check('…and still names the guild', text(inert) === 'Guild 0-3 #0-3', text(inert));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
