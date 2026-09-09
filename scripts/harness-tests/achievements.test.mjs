// The achievement catalogue and its two cards (frontend/structs-achievements.js).
//
// The two things worth pinning here are the ones that would fail SILENTLY:
// a counter name drifting apart between Rust and the catalogue, and "—"
// collapsing into "0". Everything else is layout.
//
//   node scripts/harness-tests/achievements.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(read('frontend/units.js'));
w.eval(read('frontend/pfp.js'));
w.eval(read('frontend/playercard.js'));
w.eval(read('frontend/structs-achievements.js'));
const A = w.StructsAchievements;
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (n) => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// A payload shaped like `terminal_achievements`, with all three states a
// counter can be in: a real number, a real zero, and absent.
const FULL = {
  player_id: '1-194',
  counters: {
    raids_launched: 1284, raids_won: 371, raids_repelled: 0,
    ore_seized: 8_420_000, ore_mined: 41_250_000, alpha_refined: 9_130_000_000,
    kills: 837, cmd_kills: 17, damage_dealt: 5047, smart_damage: 3140,
    feat_payback: 0, feat_double_tap: 1,
  },
  hulls: [
    { type: 'Destroyer', built: 41, kills: 188, damage: 1240, destroyed: 6, lost: 22 },
    { type: 'Command Ship', built: 9, kills: 3, damage: 210, destroyed: 17, lost: null },
    { type: 'Tank', built: 22, kills: 0, damage: 0, destroyed: null, lost: 9 },
  ],
  ambits: { damage: { space: 2288 }, kills: { land: 188, water: 14, air: 241, space: 394 } },
  coverage: { combat: 'full' },
  unavailable: {},
};
// What the card gets today, before the guild serves per-player activity.
const NO_COMBAT = {
  player_id: '1-194',
  counters: { raids_launched: 1284, ore_mined: 41_250_000 },
  hulls: [],
  ambits: { damage: {}, kills: {} },
  coverage: { combat: 'none' },
  unavailable: { combat: 'the guild does not serve per-player activity yet' },
};

{
  console.log('\n— the catalogue and the Rust that feeds it');
  const rs = read('src-tauri/src/mcp/achievements.rs');

  // Every `&'static str` key the aggregator can publish. The three const
  // tables plus every literal handed to bump()/set().
  const emitted = new Set();
  for (const block of ['COMBAT_KEYS', 'FEAT_KEYS']) {
    const m = new RegExp(`const ${block}[^=]*=\\s*&\\[([^\\]]*)\\]`, 's').exec(rs);
    if (m) for (const k of m[1].matchAll(/"([a-z_]+)"/g)) emitted.add(k[1]);
  }
  for (const m of rs.matchAll(/\brec\.(?:bump|set|mark)\(\s*"([a-z_]+)"/g)) emitted.add(m[1]);
  // The ledger fold names its keys in match arms and `entry()` calls rather
  // than through `rec`, and the profile fold in (field, key) pairs. Requiring
  // an underscore keeps denoms and enum names ("ore", "ualpha", "guided") out.
  const KEYISH = '([a-z]+_[a-z_]+)';
  for (const m of rs.matchAll(new RegExp(`=>\\s*"${KEYISH}"`, 'g'))) emitted.add(m[1]);
  for (const m of rs.matchAll(new RegExp(`\\.entry\\("${KEYISH}"\\)`, 'g'))) emitted.add(m[1]);
  for (const m of rs.matchAll(new RegExp(`\\("[a-z]+",\\s*"${KEYISH}"\\)`, 'g'))) emitted.add(m[1]);
  /* Counted, never published as tiles of their own: the walk's own measure of
   * raids launched (which replaces the profile endpoint's when it lands), and
   * the ledger's count of won raids (which stands in for the activity feed's
   * until that route exists). Both feed a tile that already has a name. */
  emitted.delete('raids_initiated');
  emitted.delete('raids_won_ledger');

  const known = new Set(Object.keys(A.BY_KEY));
  const orphans = [...emitted].filter((k) => !known.has(k));
  check('every counter Rust emits has a catalogue row', orphans.length === 0, orphans.join(', '));
  const unfed = [...known].filter((k) => !emitted.has(k));
  check('every catalogue row is fed by Rust', unfed.length === 0, unfed.join(', '));

  const rows = A.FAMILIES.flatMap((f) => f.rows);
  check('every row has a short name for the tile', rows.every((r) => r.short && r.short.length <= 14),
    rows.filter((r) => !r.short || r.short.length > 14).map((r) => r.key).join(', '));
  check('every row carries a glyph or struct art', rows.every((r) => r.icon || r.art));
  check('a resource row names the ladder it prints on', rows.filter((r) => r.fmt).every((r) => r.ladder === r.fmt));
}

{
  console.log('\n— tiers are data, and the ladder is the only thing that knows');
  const dmg = A.BY_KEY.damage_dealt;
  check('below the first rung is tier 0, not tier I', A.tierOf(3, dmg).tier === 0);
  check('the rung itself is the tier', A.tierOf(10, dmg).tier === 1 && A.tierOf(99, dmg).tier === 1);
  const top = A.tierOf(9e9, dmg);
  check('the top rung has no next and reads full', top.next === null && top.frac === 1 && top.tier === 6);
  const mid = A.tierOf(300, dmg); // between 100 and 500
  check('progress is measured between the rungs, not from zero', Math.abs(mid.frac - 0.5) < 1e-9, String(mid.frac));
  check('a feat has one rung', A.tierOf(1, A.BY_KEY.feat_payback).next === null);
  check('an unknown value is tier 0 AND flagged unknown', A.tierOf(null, dmg).unknown === true && A.tierOf(0, dmg).unknown === false);
  check('the ladder is reachable as data, per family', A.LADDERS.rare[5] === 100 && A.LADDERS.damage[0] === 10);
}

{
  console.log('\n— absence is not zero');
  check('a missing counter reads null', A.readCounter(FULL, 'ground_kills') === null);
  check('a counter that is really zero reads 0', A.readCounter(FULL, 'raids_repelled') === 0);
  check('unknown prints an em dash, zero prints a zero',
    A.fmtValue(null, A.BY_KEY.kills) === '—' && A.fmtValue(0, A.BY_KEY.kills) === '0');
}

{
  console.log('\n— quantities ride the game’s own ladders');
  check('ore is grams', A.fmtValue(8_420_000, A.BY_KEY.ore_seized) === w.StructsUnits.fmtOre(8_420_000));
  check('alpha is ualpha', A.fmtValue(9_130_000_000, A.BY_KEY.alpha_refined) === w.StructsUnits.fmtAlpha(9_130_000_000));
  check('a bare count is thousands-separated, not laddered', A.fmtValue(1284, A.BY_KEY.raids_launched) === '1,284');
  check('the ore ladder is in the unit the payload carries', A.LADDERS.ore[0] === 1e3 && A.LADDERS.alpha[0] === 1e6);
}

{
  console.log('\n— B · the ribbon rack');
  const rack = A.rack(FULL, {});
  const tiles = rack.querySelectorAll('.ac-rib');
  check('one tile per catalogue row', tiles.length === Object.keys(A.BY_KEY).length);
  const won = rack.querySelector('[data-key="raids_won"]');
  check('a tile shows the short name and hides the long one in its title',
    /WON|Won/.test(text(won.querySelector('.ac-rib-n'))) && won.title === 'Raids won');
  check('the pips are the ladder’s rungs', won.querySelectorAll('.ac-pip').length === 6
    && won.querySelectorAll('.ac-pip.on').length === A.tierOf(371, A.BY_KEY.raids_won).tier);
  const unknown = rack.querySelector('[data-key="ground_kills"]');
  check('a counter we cannot read is drawn unknown, with a dash',
    unknown.classList.contains('is-unknown') && text(unknown.querySelector('.ac-rib-v')) === '—');
  const zero = rack.querySelector('[data-key="feat_payback"]');
  check('a real zero is LOCKED, not unknown — the difference is visible',
    zero.classList.contains('is-locked') && !zero.classList.contains('is-unknown')
    && text(zero.querySelector('.ac-rib-v')) === '0');
  const done = rack.querySelector('[data-key="feat_double_tap"]');
  check('a feat that is done wears the earned edge', done.classList.contains('is-max'));

  check('no tile carries an explanation — only a name and a number',
    [...tiles].every((t) => t.querySelectorAll('div').length <= 3));
}

{
  console.log('\n— the cheatsheet is the game’s own, and opens in place');
  const rack = A.rack(FULL, { onlyFamily: 'war' });
  const cmd = rack.querySelector('[data-key="cmd_kills"]');
  click(cmd);
  const sheet = rack.querySelector('.ac-sheet .sui-cheatsheet');
  check('a click opens SUI’s cheatsheet under the tile', sheet !== null
    && sheet.querySelector('.sui-cheatsheet-title-text') !== null
    && sheet.querySelector('.sui-cheatsheet-property-section') !== null);
  check('it carries the FULL name and the value', text(sheet.querySelector('.sui-cheatsheet-title-text')) === 'CMD Ships destroyed'
    && text(sheet.querySelector('.sui-cheatsheet-cost')) === '17');
  check('it reports state — tier, next, source — and no prose',
    /Tier/i.test(text(sheet)) && /Next/i.test(text(sheet)) && /Source/i.test(text(sheet))
    && !/you (can|must|should)/i.test(text(sheet)));
  click(cmd);
  check('a second click closes it', rack.querySelector('.ac-sheet') === null);
  const other = rack.querySelector('[data-key="kills"]');
  click(cmd); click(other);
  check('only one sheet is open at a time', rack.querySelectorAll('.ac-sheet').length === 1);
}

{
  console.log('\n— the rack when the guild cannot answer');
  const rack = A.rack(NO_COMBAT, {});
  check('the gap is stated as state, not hidden', /combat not recorded/i.test(text(rack.querySelector('.ac-gap'))));
  check('what we DO know is still drawn', text(rack.querySelector('[data-key="raids_launched"] .ac-rib-v')) === '1,284');
  const kills = rack.querySelector('[data-key="kills"]');
  check('and nothing we cannot know is invented', kills.classList.contains('is-unknown')
    && text(kills.querySelector('.ac-rib-v')) === '—');
  check('the summary counts what is unrecorded rather than calling it unearned',
    /not recorded/i.test(text(rack.querySelector('.ac-strip'))));
}

{
  console.log('\n— C · the hull tally');
  const mx = A.matrix(FULL, {});
  const heads = [...mx.querySelectorAll('th')].map(text);
  check('five readings per hull, because they are five achievements',
    heads.join(',') === 'Hull,built,kills,damage,destroyed,lost', heads.join(','));
  const first = mx.querySelector('tbody tr');
  check('the hull leads with its own art and name', first.querySelector('.ac-mx-id img') !== null
    && /Destroyer/.test(text(first.querySelector('.ac-nm'))));
  check('the art directory is the game’s, not a slugified guess',
    A.artSlug('Command Ship') === 'cmd-ship' && A.artSlug('Ore Extractor') === 'extractor'
    && A.artSlug('Starfighter') === 'starfighter');
  const cells = [...first.querySelectorAll('td.ac-num')].map(text);
  check('numbers are the numbers', cells.join(',') === '41,188,1,240,6,22', cells.join(','));
  const tank = [...mx.querySelectorAll('tbody tr')].find((r) => /Tank/.test(text(r)));
  const tankCells = [...tank.querySelectorAll('td.ac-num')].map(text);
  check('a real zero and an unknown are told apart in the table too',
    tankCells[1] === '0' && tankCells[3] === '—', tankCells.join(','));
  check('the ambit strip says where the killing happened',
    /land/.test(text(mx.querySelector('.ac-ambits'))) && /394/.test(text(mx.querySelector('.ac-ambits'))));

  const narrow = A.matrix(FULL, { columns: ['kills'] });
  check('a one-wide card asks for one column instead of scrolling four off the edge',
    [...narrow.querySelectorAll('th')].map(text).join(',') === 'Hull,kills');

  const empty = A.matrix(NO_COMBAT, {});
  check('no hull record draws a stated gap, not an empty table',
    empty.querySelector('table') === null && /no hull record/i.test(text(empty)));
}

{
  console.log('\n— wiring');
  const bt = read('frontend/board-terminal.js');
  check('both cards are registered', /Terminal\.register\('record'/.test(bt) && /Terminal\.register\('tally'/.test(bt));
  check('both are filed in a card group',
    /\['Explore', \[[^\]]*'record'/.test(bt) && /\['War', \[[^\]]*'tally'/.test(bt));
  check('both are reachable by a word', /RECORD: \['record', 'id'\]/.test(bt) && /TALLY: \['tally', 'id'\]/.test(bt));
  check('both read the one command', (bt.match(/terminal_achievements/g) || []).length >= 2);

  const html = read('frontend/board.html');
  check('the module and its sheet ship with the board',
    /structs-achievements\.js/.test(html) && /structs-achievements\.css/.test(html));
  check('both files are repo-owned, not in a directory sync.sh wipes',
    existsSync(resolve(repo, 'frontend/structs-achievements.js'))
    && existsSync(resolve(repo, 'frontend/structs-achievements.css')));

  const rs = read('src-tauri/src/mcp/achievements.rs');
  check('the command is registered with Tauri', /achievements::terminal_achievements/.test(read('src-tauri/src/main.rs')));
  check('damage is the roll minus the armour, never the accumulator',
    /damageDealt.*\)\s*-\s*num\(shot\.get\("damageReduction"\)\)/s.test(rs));
}

{
  console.log('\n— SUI hygiene');
  // Comments stripped first: this file's own header names the anti-pattern it
  // is banning, and a scan that reads comments fails on the warning about it.
  const css = read('frontend/structs-achievements.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  const sui = read('frontend/css/sui/sui.css') + read('frontend/css/main.css');
  const undef = [...new Set(tokens)].filter((t) => !sui.includes(t + ':'));
  check('every token exists — a var() fallback would hide an invented colour', undef.length === 0, undef.join(', '));
  check('and no fallback is written', !/var\(--[a-z0-9-]+\s*,/.test(css));
  const js = read('frontend/structs-achievements.js');
  check('icons are the game’s own, never emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(js));
  check('no icon is drawn below the game’s smallest size', !/sui-icon-xs/.test(js) && !/sui-icon-xs/.test(css));
  check('new blocks set their own text-align — main.css centres the body',
    (css.match(/text-align: left/g) || []).length >= 4);
}

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
