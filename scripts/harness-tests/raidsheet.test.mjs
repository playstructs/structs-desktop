// raidview-sheet.js: the cheatsheet content builders and placement.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/raidview-sheet.js', import.meta.url), 'utf8');

function boot(structsById = {}, types = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const sh = w.RaidSheet({
    el, equipped: (v) => !!v && !/^no[A-Z]/.test(v), typeOf: (s) => types[s.type_slug] || null,
    state: () => ({ structsById }), icons: () => ({ laser: 'icon-laser', flak: 'icon-flak', pdc: 'icon-pdc', armour: 'icon-armour', oreBunker: 'icon-bunker', fusion: 'icon-fusion', defensiveCannon: 'icon-cannon' }),
  });
  const trig = (data) => { const t = w.document.createElement('a'); Object.assign(t.dataset, data); return t; };
  return { w, sh, trig };
}
const TANK = { class_name: 'Tank', default_cosmetic_model_number: 'T-1', build_charge: 3, build_draw: 5590000,
  primary_weapon: 'laser', primary_weapon_label: '', primary_weapon_damage: 2, primary_weapon_shots: 1, primary_weapon_ambits: 4, primary_weapon_control: 'guided',
  secondary_weapon: 'noSecondary', passive_weaponry: 'pdc', counter_attack: 1, counter_attack_same_ambit: 2, possible_ambit: 4,
  unit_defenses: 'armour', planetary_defenses: 'defensiveCannon', ore_reserve_defenses: 'oreBunker', planetary_shield_contribution: 1234,
  power_generation: 'fusion', generating_rate: 40, drive_label: 'Tracks', move_charge: 1 };

// 1. Numbers, names, ambits, the battery.
{
  const { sh } = boot();
  assert.equal(sh.fmtNumber(5590000), '5M', 'truncates, as NumberFormatter does');
  assert.equal(sh.fmtNumber(1234), '1k'); assert.equal(sh.fmtNumber(999), '999'); assert.equal(sh.fmtNumber('x'), '0');
  assert.equal(sh.humanise('noOreReserveDefenses'), 'No Ore Reserve Defenses');
  assert.equal(sh.labelOr('Given', 'signalJamming'), 'Given'); assert.equal(sh.labelOr('', 'signalJamming'), 'Signal Jamming');
  assert.equal(JSON.stringify(sh.ambitsOf(2 | 16)), JSON.stringify(['space', 'water']), 'expanded in the order the icons are shown');
  const bat = sh.batteryCost(3);
  assert.equal(bat.querySelectorAll('.sui-battery-chunk').length, 5, 'five chunks: the HUD battery');
  assert.equal(bat.querySelectorAll('.sui-mod-filled').length, 3);
  assert.equal(sh.batteryCost(8).querySelectorAll('.sui-mod-filled').length, 5);
}

// 2. The whole-struct card: title, costs, description, one row per equipped system.
{
  const { sh } = boot();
  const card = sh.structSheet(TANK, 'Unpowered — abilities inactive.');
  const box = card; // fragment
  assert.equal(box.querySelector('.sui-cheatsheet-title-text').textContent, 'T-1 TANK');
  assert.ok(box.querySelector('.sui-battery') && /5M/.test(box.querySelector('.sui-cheatsheet-cost').textContent));
  const rows = [...box.querySelectorAll('.sui-cheatsheet-property')].map((r) => r.querySelector('.sui-cheatsheet-property-info').textContent);
  assert.ok(rows[0].startsWith('Laser2 DMG'), 'primary weapon, label humanised');
  assert.ok(!rows.some((r) => /noSecondary|No Secondary/.test(r)), 'an unequipped system has no row');
  assert.ok(rows.some((r) => /^Pdc2 DMG/.test(r)), 'the counter-attack in the struct\'s own ambit is the harder figure');
  const split = [...sh.structSheet(Object.assign({}, TANK, { primary_weapon_ambits: 4 | 8 })).querySelectorAll('.sui-cheatsheet-property-info')].map((r) => r.textContent);
  assert.ok(split.some((r) => /^Pdc1 DMG.*2 DMG/.test(r)), 'reaching two ambits: regular first, then the same-ambit figure');
  assert.ok(rows.some((r) => /Defensive Cannon1 DMG/.test(r)), 'the cannon is a weapon in all but name');
  assert.ok(rows.some((r) => /\+1k Planetary Defense/.test(r)));
  assert.ok(rows.some((r) => /\+40 KW Per Alpha/.test(r)));
  assert.equal(box.querySelector('.sui-cheatsheet-contextual-message').textContent, 'Unpowered — abilities inactive.');
}

// 3. The single-ability card: a damage range when the weapon fires more than once.
{
  const { sh } = boot();
  const multi = Object.assign({}, TANK, { primary_weapon_shots: 3, primary_weapon_charge: 2, primary_weapon_description: 'zap' });
  const sheet = sh.propertySheet(multi, 'primary_weapon');
  const rows = [...sheet.querySelectorAll('.sui-cheatsheet-property-info')].map((r) => r.textContent);
  assert.ok(rows.includes('Smart Weapon') && rows.includes('2-6 DMG'));
  assert.equal(sheet.querySelector('.sui-cheatsheet-description').textContent, 'zap');
  assert.equal(sh.propertySheet(TANK, 'movable').querySelector('.sui-cheatsheet-title-text').textContent, 'TRACKS');
  assert.equal(sh.propertySheet(TANK, 'nope'), null);
}

// 4. Dispatch by trigger: fixed keys, the spectator's economy sheets, the defend button, why a struct is inert.
{
  const s = { type_slug: 'tank', destroyed: false, built: true, online: false };
  const { sh, trig } = boot({ '5-1': s, '5-2': { type_slug: 'mystery', type_name: 'Mystery Hull' } }, { tank: TANK });
  const title = (f) => f.querySelector('.sui-cheatsheet-title-text').textContent;
  assert.equal(title(sh.cheatsheetBody(trig({ suiCheatsheet: 'icon-wreckage' }))), 'WRECKAGE');
  assert.equal(title(sh.cheatsheetBody(trig({ suiCheatsheet: 'icon-mine' }))), 'ORE EXTRACTION', 'a capability, never a number we cannot see');
  assert.equal(title(sh.cheatsheetBody(trig({ suiCheatsheet: 'mystery', struct: '5-2' }))), 'MYSTERY HULL', 'a type we could not resolve is still named');
  const defend = sh.cheatsheetBody(trig({ suiCheatsheet: 'tank', struct: '5-1', actionButton: 'defend' }));
  assert.equal(title(defend), 'DEFEND');
  const card = sh.cheatsheetBody(trig({ suiCheatsheet: 'tank', struct: '5-1' }));
  assert.equal(card.querySelector('.sui-cheatsheet-contextual-message').textContent, 'Unpowered — abilities inactive.');
  s.destroyed = true;
  assert.equal(sh.cheatsheetBody(trig({ suiCheatsheet: 'tank', struct: '5-1' })).querySelector('.sui-cheatsheet-contextual-message').textContent, 'Destroyed.');
}

// 5. Placement clamps into the viewport, trying above first.
{
  const { sh, w } = boot();
  const sheet = w.document.createElement('div');
  Object.defineProperty(sheet, 'offsetWidth', { value: 100 }); Object.defineProperty(sheet, 'offsetHeight', { value: 50 });
  w.innerWidth = 800; w.innerHeight = 600;
  sh.placeCheatsheet(sheet, { top: 300, left: 400, width: 20, height: 20, right: 420, bottom: 320 });
  assert.equal(sheet.style.top, '246px', 'above, with the 4px gap'); assert.equal(sheet.style.left, '360px');
  sh.placeCheatsheet(sheet, { top: 10, left: 0, width: 20, height: 20, right: 20, bottom: 30 });
  assert.equal(sheet.style.left, '24px', 'no room above: to the right');
  sh.placeCheatsheet(sheet, { top: 10, left: 790, width: 10, height: 20, right: 800, bottom: 30 });
  assert.ok(parseInt(sheet.style.left) + 100 <= 800, 'never past the right edge');
}

console.log('raid-sheet: all checks passed');
