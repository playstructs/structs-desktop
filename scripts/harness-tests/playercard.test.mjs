// The shared player card (frontend/playercard.js), on its own.
//
// Every place the app draws a player — the Armada roster, Explore, the
// leaderboards, a player named in Comms — goes through this one component,
// so its contract is checked here once rather than four times by accident.
//
//   node scripts/harness-tests/playercard.test.mjs
//
// jsdom does no layout: these are structural checks plus the one thing that
// matters most — that the battery is the GAME's battery, pinned against the
// webapp's own source rather than a number somebody remembered.
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
const PC = w.StructsPlayerCard;
const d = w.document;
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

const PFP = '{"head":12,"neck":2,"body":7,"arms":3,"background":3}';

// ── The battery is the game's battery ───────────────────────────────────────
{
  console.log('\n— battery mirrors the webapp');
  const calc = read('structs-webapp/src/js/util/ChargeCalculator.js');
  const m = /chargeLevelThresholds\s*=\s*\[([^\]]+)\]/.exec(calc);
  const theirs = m ? m[1].split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n)) : null;
  check('the webapp still publishes chargeLevelThresholds', !!theirs && theirs.length > 1);
  check('our thresholds are the webapp\'s, verbatim',
    JSON.stringify(PC.CHARGE_LEVEL_THRESHOLDS) === JSON.stringify(theirs),
    JSON.stringify(PC.CHARGE_LEVEL_THRESHOLDS) + ' vs ' + JSON.stringify(theirs));

  // The HUD draws one chunk per threshold step; count them in its markup.
  const hud = read('structs-webapp/src/js/view_models/components/hud/ActionBarComponent.js');
  const chunkHtml = /sui-screen-battery">([\s\S]*?)<\/div>\s*<\/div>/.exec(hud);
  const hudChunks = chunkHtml ? (chunkHtml[1].match(/sui-battery-chunk/g) || []).length : -1;
  check('the HUD battery has as many chunks as we draw', hudChunks === PC.BATTERY_CHUNKS,
    hudChunks + ' in the HUD vs ' + PC.BATTERY_CHUNKS + ' here');

  // The mapping itself, against the calculator's own rule: the first
  // threshold the charge does not exceed.
  const level = (c) => { for (let i = 0; i < theirs.length; i++) if (c <= theirs[i]) return i; return theirs.length - 1; };
  const bad = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40].filter((c) => PC.chargeLevel(c) !== level(c));
  check('every charge lands on the calculator\'s level', bad.length === 0, 'differs at ' + bad.join(','));

  const b = PC.battery(5);
  check('a battery is five chunks', b.querySelectorAll('.sui-battery-chunk').length === PC.BATTERY_CHUNKS);
  check('charge 5 lights four', b.querySelectorAll('.sui-mod-filled').length === 4,
    String(b.querySelectorAll('.sui-mod-filled').length));
  check('charge 8 lights all', PC.battery(8).querySelectorAll('.sui-mod-filled').length === PC.BATTERY_CHUNKS);
  check('charge 0 lights none', PC.battery(0).querySelectorAll('.sui-mod-filled').length === 0);
  check('no charge, no battery', PC.battery(null) === null);
  check('and it is the game\'s own component', b.className.includes('sui-battery') && b.className.includes('sui-theme-player'));
}

// ── The card ─────────────────────────────────────────────────────────────────
{
  console.log('\n— card');
  let selected = null;
  let clicked = 0;
  let acted = null;
  const card = PC.card({
    id: '1-271', name: 'SCOUT1', badge: { text: 'BAIT', mod: 'default' },
    presence: 'online', pfp: PFP, charge: 5, attn: 'last read 3h ago',
    readings: [
      { value: '0μg', icon: 'sui-icon-alpha-matter', title: 'Alpha' },
      { value: '98g', icon: 'sui-icon-alpha-ore', title: 'Ore' },
    ],
    marks: [{ icon: 'icon-undiscovered-ore', value: '4g', title: 'ore left on planet' }],
  }, {
    selectable: true,
    onSelect: (on) => { selected = on; },
    onClick: () => { clicked++; },
    actions: [
      { icon: 'icon-planet', title: 'Watch planet', onClick: () => { acted = 'planet'; } },
      { icon: 'icon-phone', title: 'Message', onClick: () => { acted = 'message'; } },
    ],
  });
  d.body.appendChild(card);

  check('it is the game\'s planet-card frame', card.classList.contains('sui-planet-card'));
  check('…with the game\'s header and body',
    !!card.querySelector('.sui-planet-card-header') && !!card.querySelector('.sui-planet-card-body'));
  check('it carries the player id', card.getAttribute('data-player-id') === '1-271');
  check('the portrait is the whole 72px art', !!card.querySelector('.pc-pfp') &&
    card.querySelectorAll('.pc-pfp .pfp-viewer-layer').length === 5,
    String(card.querySelectorAll('.pc-pfp .pfp-viewer-layer').length));
  check('the name is in the header', text(card.querySelector('.sui-planet-card-header')).includes('SCOUT1'));
  check('the role badge is a sui-badge', !!card.querySelector('.sui-planet-card-header .sui-badge.sui-mod-default')
    && text(card.querySelector('.sui-badge')) === 'BAIT');
  check('the id is bare — no "PID"', /#1-271/.test(text(card)) && !/PID/.test(text(card)), text(card));
  check('attention text is warning-coloured', text(card.querySelector('.pc-attn')) === 'last read 3h ago');
  check('presence is a dot', !!card.querySelector('.pc-presence.pc-mod-online'));

  // No words under the numbers: the glyph is the label, the title the tooltip.
  const t = text(card);
  check('no reading is captioned', !/CHARGE|ALPHA|ORE|Ready/i.test(t), t);
  check('readings carry the game\'s glyphs',
    !!card.querySelector('.pc-res .sui-icon-alpha-matter') && !!card.querySelector('.pc-res .sui-icon-alpha-ore'));
  check('…and say what they are on hover',
    card.querySelector('.pc-res').title === 'Alpha');
  check('the battery sits with the readings', !!card.querySelector('.pc-reads .sui-battery'));
  check('marks are icon + value', text(card.querySelector('.pc-mark')) === '4g'
    && !!card.querySelector('.pc-mark .icon-undiscovered-ore'));

  // Actions are icon doors with titles, never words.
  const acts = card.querySelectorAll('.pc-act');
  check('two actions', acts.length === 2, String(acts.length));
  check('an action is an icon with a title', acts[0].title === 'Watch planet' && !!acts[0].querySelector('.icon-planet')
    && text(acts[0]) === '');
  acts[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking one fires it', acted === 'message');
  check('…and not the card', clicked === 0);

  // The portrait is the selector.
  check('there is no checkbox', !card.querySelector('input[type=checkbox]'));
  const pfp = card.querySelector('.pc-pfp');
  check('the portrait is clickable', pfp.classList.contains('pc-mod-clickable'));
  pfp.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking it selects', selected === true && card.classList.contains('is-selected'));
  check('…without opening the card', clicked === 0);
  pfp.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking again deselects', selected === false && !card.classList.contains('is-selected'));
  card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking the card opens it', clicked === 1);

  const pre = PC.card({ id: '1-1', pfp: PFP }, { selectable: true, selected: true });
  check('initial selection is honoured', pre.classList.contains('is-selected'));
  PC.setSelected(pre, false);
  check('…and can be cleared from outside', !pre.classList.contains('is-selected'));

  // A portrait callback wins over selection (Comms: portrait = watch planet).
  let watched = 0;
  const pc2 = PC.card({ id: '1-2', pfp: PFP }, { selectable: true, onPortrait: () => { watched++; } });
  pc2.querySelector('.pc-pfp').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('onPortrait overrides selection', watched === 1 && !pc2.classList.contains('is-selected'));

  // Inert when nothing is wired.
  const inert = PC.card({ id: '1-3', pfp: PFP });
  check('an unwired portrait is not clickable', !inert.querySelector('.pc-pfp').classList.contains('pc-mod-clickable'));
  check('no actions, no footer', !inert.querySelector('.pc-foot'));

  // A reading with no glyph still says what it is.
  const hinted = PC.card({ id: '1-4', pfp: PFP, readings: [{ value: '1.2KW/3KW', title: 'Energy' }] });
  check('a glyphless reading carries a hint', text(hinted.querySelector('.pc-res-hint')) === 'Energy');

  // Untrusted data never becomes markup.
  const evil = PC.card({ id: '1-5', name: '<img src=x onerror=alert(1)>', pfp: '{"head":"../x"}', sub: '<b>x</b>' });
  check('a hostile name is text', !evil.querySelector('img[src="x"]') && text(evil).includes('<img'));
  check('hostile attrs get the placeholder', evil.querySelectorAll('.pfp-viewer-layer').length === 1
    && /portrait-placeholder/.test(evil.querySelector('.pfp-viewer-layer').getAttribute('src')));
  // Comments stripped first: the file DOCUMENTS the rule it must not break.
  const src = read('frontend/playercard.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('the component never touches innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
}

// ── The row ──────────────────────────────────────────────────────────────────
{
  console.log('\n— row');
  const row = PC.row({
    id: '1-61', prefix: '#1', name: 'JPEG', guild: '[SNC] SN Corp', pfp: PFP, charge: 8,
    readings: [{ value: '49.34Kg', icon: 'sui-icon-alpha-matter', title: 'alpha' }],
  }, { actions: [{ icon: 'icon-phone', title: 'Message' }, { icon: 'icon-outgoing', title: 'Share' }] });
  check('a row is one grid line', row.classList.contains('pc-row'));
  check('rank, then name', /^#1 JPEG/.test(text(row.querySelector('.pc-name'))), text(row.querySelector('.pc-name')));
  check('the id line is just the id', text(row.querySelector('.pc-id')) === '#1-61', text(row.querySelector('.pc-id')));
  check('the guild has a line of its own', text(row.querySelector('.pc-guild')) === '[SNC] SN Corp', text(row.querySelector('.pc-guild')));
  const gcard = PC.card({ id: '1-61', name: 'JPEG', guild: '[SNC] SN Corp', pfp: PFP });
  check('…in the card header too', text(gcard.querySelector('.sui-planet-card-header .pc-guild')) === '[SNC] SN Corp');
  check('the badge, if any, is on the name line', !row.querySelector('.sui-badge'));
  check('the reading is there', text(row.querySelector('.pc-res')) === '49.34Kg');
  check('two doors', row.querySelectorAll('.pc-act').length === 2);
  const bare = PC.row({ id: '1-62', pfp: PFP });
  check('no doors renders an empty action cell', bare.querySelector('.pc-actions').childNodes.length === 0);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
