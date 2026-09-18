// The game-window sound hooks: the `setupStructsSound` block of
// frontend/structs-config.js, evaluated on its own against a fake game.
//
// The block is sliced out of the file (between its own header and the ⌘K
// header, the palette.test.mjs technique) and run in a jsdom window with the
// real catalogue, a recording fake engine, and just enough of gameState,
// menuPage and the menu DOM to drive every hook. What this pins is the
// MAPPING from game moment to cue candidates — never a sound.
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const root = process.cwd();

const config = readFileSync(root + '/frontend/structs-config.js', 'utf8');
const START = '/* ── [structs-universe] sound hooks';
const END = '/* ── [structs-universe] ⌘K over the game';
const a = config.indexOf(START), b = config.indexOf(END);
check('the sound hooks block sits right before the ⌘K block', a > 0 && b > a);
const block = config.slice(a, b);
check('the block never references TAURI itself (the engine invokes, the block does not)', !/\bTAURI\b/.test(block));
check('the tap hands every frame to the hooks before the notifications gate',
  config.indexOf('window.__STRUCTS_SOUND_GRASS__(data)') > 0 && config.indexOf('window.__STRUCTS_SOUND_GRASS__(data)') < config.indexOf("if (!window.__STRUCTS_NOTIFICATIONS__.enabled) return;"));

// ── The fake game ───────────────────────────────────────────────────────────
function game() {
  const dom = new JSDOM('<!doctype html><html><body><div id="menu-page-body-content"></div><div id="menu-page-dialogue-indicator-content"></div><div id="menu-page-dialogue-screen-content"></div><div id="hud"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/index.html' });
  const w = dom.window;
  w.eval(readFileSync(root + '/frontend/sound-catalogue.js', 'utf8'));
  const calls = [];
  let handleSeq = 0;
  w.StructsSound = {
    cue: (c, ctx) => { calls.push({ kind: 'cue', c, ctx }); return { id: ++handleSeq, stopped: false }; },
    loop: (c, key) => { calls.push({ kind: 'loop', c, key }); return { id: ++handleSeq, key, stopped: false }; },
    stop: (h) => { calls.push({ kind: 'stop', h: h && h.id }); if (h) h.stopped = true; },
    music: (id, o) => { calls.push({ kind: 'music', id, o }); },
  };
  const types = {
    9: { type: 'Tank', passive_weaponry: 'counterAttack', hasPlanetaryMining: () => false, hasPlanetaryRefinery: () => false, hasOreReserveDefenses: () => false },
    12: { type: 'Destroyer', passive_weaponry: 'advancedCounterAttack', hasPlanetaryMining: () => false, hasPlanetaryRefinery: () => false, hasOreReserveDefenses: () => false },
    14: { type: 'Ore Extractor', passive_weaponry: 'noPassiveWeaponry', hasPlanetaryMining: () => true, hasPlanetaryRefinery: () => false, hasOreReserveDefenses: () => false },
    18: { type: 'Ore Bunker', passive_weaponry: 'noPassiveWeaponry', hasPlanetaryMining: () => false, hasPlanetaryRefinery: () => false, hasOreReserveDefenses: () => true },
    19: { type: 'Planetary Defense Cannon', passive_weaponry: 'noPassiveWeaponry', hasPlanetaryMining: () => false, hasPlanetaryRefinery: () => false, hasOreReserveDefenses: () => false },
  };
  const S = (id, type, ambit, online) => ({ id, type, operating_ambit: ambit, isOnline: () => !!online, isDestroyed: () => false });
  const structs = {
    '5-1': S('5-1', 9, 'land', true),
    '5-2': S('5-2', 12, 'water', true),
    '5-3': S('5-3', 14, 'land', false),
    '5-4': S('5-4', 18, 'land', true),
    '5-9': S('5-9', 19, 'land', true),
  };
  let locked = false, current = '';
  const lock = {
    setCurrentAction(a) { if (locked) return; current = a; },
    getCurrentAction() { return current; },
    lock() { locked = true; },
    unlock() { locked = false; },
    isLocked() { return locked; },
    clear() { locked = false; current = ''; },
  };
  w.gameState = {
    keyPlayers: { player: { id: '1-7', planet: { id: '2-77' }, fleet: { id: '9-7' }, structs } },
    structTypes: { getStructTypeById: (id) => types[id] || null },
    actionBarLock: lock,
  };
  const gotos = [];
  w.menuPage = { router: { mode: 'default', goto(c, p, o) { gotos.push([c, p]); } } };
  w.eval(block);
  const fire = (name, props) => { const e = new w.Event(name); Object.assign(e, props || {}); w.dispatchEvent(e); };
  const grass = (data) => w.__STRUCTS_SOUND_GRASS__(data);
  const cues = () => calls.filter((c) => c.kind === 'cue').map((c) => c.c);
  const lastCue = () => cues().slice(-1)[0];
  const reset = () => { calls.length = 0; };
  return { w, calls, cues, lastCue, reset, fire, grass, lock, gotos, structs };
}

(async () => {
  console.log('\n— animation queue');
  {
    const g = game();
    await tick(300); // the polls attach
    g.fire('ANIMATION', { structId: '5-1', animationNames: ['ATTACK_PRIMARY_WEAPON'], options: {} });
    check('a tank firing → its fire chain', same(g.lastCue(), ['fire.tank.primary', 'fire.primary']));
    g.fire('ANIMATION', { structId: '5-2', animationNames: ['IMPACT_ANGLED_DOWN_MISSILE', 'SHAKE_ANGLED_DOWN_DEFAULT_LAST'], options: { healthAfter: 0 } });
    check('a killing missile on a water hull → kill, water, generic', same(g.lastCue(), ['impact.missile.kill', 'impact.missile.water', 'impact.missile']));
    g.fire('ANIMATION', { structId: '5-2', animationNames: ['DESTROY_WATER'], options: { healthAfter: 0 } });
    check('destroy by ambit', same(g.lastCue(), ['destroy.water']));

    g.reset();
    g.grass({ category: 'struct_attack', subject: 'structs.planet.2-77', detail: { attackerStructId: '5-9', eventAttackShotDetail: [
      { targetStructId: '5-1', evaded: true, evadedCause: 'defensiveManeuver' },
      { targetStructId: '5-1', evaded: true, evadedCause: 'armour', eventAttackDefenderCounterDetail: [{ counterByStructId: '5-2' }] },
    ] } });
    g.fire('ANIMATION', { structId: '5-1', animationNames: ['EVADE'], options: {} });
    check('the first EVADE takes the first cause from the frame', same(g.lastCue(), ['ability.defensive_maneuver.activate', 'ability.evade']));
    g.fire('ANIMATION_END', { animationName: 'EVADE', structId: '5-1' });
    check('…and its end deactivates the shield', same(g.lastCue(), ['ability.defensive_maneuver.deactivate']));
    g.fire('ANIMATION', { structId: '5-1', animationNames: ['EVADE'], options: {} });
    check('the second EVADE takes the second cause', same(g.lastCue(), ['ability.armour.break', 'ability.evade']));
    g.fire('ANIMATION', { structId: '5-2', animationNames: ['ATTACK_PRIMARY_WEAPON'], options: {} });
    const c2 = g.cues().slice(-2);
    check('a counter-fire named on the frame adds the passive-weaponry cue', same(c2, [['fire.destroyer.primary', 'fire.primary'], ['ability.advanced_counter_attack', 'ability.counter_attack']]), JSON.stringify(c2));
    g.fire('ANIMATION_QUEUE_EMPTY');
    g.fire('ANIMATION', { structId: '5-1', animationNames: ['EVADE'], options: {} });
    check('after the queue empties an EVADE has no cause left', same(g.lastCue(), ['ability.evade']));
    g.fire('ANIMATION', { structId: '5-2', animationNames: ['ATTACK_PRIMARY_WEAPON'], options: {} });
    check('…and no counter either', same(g.lastCue(), ['fire.destroyer.primary', 'fire.primary']));
    g.fire('ANIMATION', { structId: '5-3', animationNames: ['ACTIVE_LOOP'], options: {} });
    check('ACTIVE_LOOP makes no cue', same(g.lastCue(), ['fire.destroyer.primary', 'fire.primary']));
  }

  console.log('\n— raids, shields, ledger');
  {
    const g = game();
    await tick(300);
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-77', detail: { planet_id: '2-77', fleet_id: '9-99', status: 'initiated' } });
    check('our planet raided → alert + override music', same(g.lastCue(), ['raid.base_raided.alert']) && g.calls.some((c) => c.kind === 'music' && c.id === 'raid.base_raided.music' && c.o.layer === 'override'));
    g.reset();
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-77', detail: { planet_id: '2-77', fleet_id: '9-99', status: 'initiated' } });
    check('the same status twice is one cue', g.cues().length === 0);
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-77', detail: { planet_id: '2-77', fleet_id: '9-99', status: 'shieldsVulnerable' } });
    check('a breach → breach alert', same(g.lastCue(), ['raid.shield_breach.alert']));
    g.grass({ category: 'shield_change', subject: 'structs.planet.2-77.1-7', detail: { planetary_shield: 12 } });
    check('the shield coming back mid-raid → restored', same(g.lastCue(), ['raid.shield_restored.alert']));
    g.reset();
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-77', detail: { planet_id: '2-77', fleet_id: '9-99', status: 'attackerDefeated' } });
    check('defeating the raider → victory and the override clears', same(g.lastCue(), ['banner.victory']) && g.calls.some((c) => c.kind === 'music' && c.id === null && c.o.layer === 'override'));
    check('…without a second restored cue (already restored)', !g.cues().some((c) => c[0] === 'raid.shield_restored.alert'));
    g.reset();
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-5', detail: { planet_id: '2-5', fleet_id: '9-7', status: 'ongoing' } });
    check('our fleet raiding → initiated alert', same(g.lastCue(), ['raid.initiated.alert']));
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-5', detail: { planet_id: '2-5', fleet_id: '9-7', status: 'raidSuccessful' } });
    check('…winning it → victory', same(g.lastCue(), ['banner.victory']));
    g.reset();
    g.grass({ category: 'raid_status', subject: 'structs.planet.2-6', detail: { planet_id: '2-6', fleet_id: '9-42', status: 'initiated' } });
    check('someone else\'s raid is nothing to us', g.cues().length === 0);

    g.grass({ category: 'mined', subject: 'structs.planet.2-77', detail: { action: 'mined', direction: 'credit', denom: 'ore', player_id: '1-7', amount: '5' } });
    check('ore mined for us → ore received (not focused on the extractor)', same(g.lastCue(), ['alert.ore_received']));
    g.reset();
    g.grass({ category: 'refined', subject: 'x', detail: { action: 'refined', direction: 'debit', denom: 'ore', player_id: '1-7' } });
    check('the refine\'s ore-debit leg is nothing', g.cues().length === 0);
    g.grass({ category: 'refined', subject: 'x', detail: { action: 'refined', direction: 'credit', denom: 'ualpha', player_id: '1-7' } });
    check('…its ualpha credit is ore refined', same(g.lastCue(), ['alert.ore_refined']));
    g.grass({ category: 'received', subject: 'structs.inventory.ualpha.1-7', detail: { amount: 100 } });
    check('alpha received on our inventory subject', same(g.lastCue(), ['alert.alpha_received']));
    g.reset();
    g.grass({ category: 'mined', subject: 'x', detail: { action: 'mined', direction: 'credit', denom: 'ore', player_id: '1-8' } });
    check('someone else\'s ore is nothing', g.cues().length === 0);
    g.grass({ category: 'fleet_arrive', subject: 'x', detail: { fleet_id: '9-7' } });
    check('our fleet arriving reuses the Alpha Drift arrive', same(g.lastCue(), ['move.arrive']));
  }

  console.log('\n— multi-stage actions');
  {
    const g = game();
    await tick(300);
    g.lock.setCurrentAction('ATTACK_PRIMARY_WEAPON');
    await tick(5);
    check('arming an attack (a tick later) → arm chain', same(g.lastCue(), ['ui.stage.arm.attack_primary_weapon', 'ui.stage.arm']));
    g.lock.lock();
    check('picking a target locks → confirm chain', same(g.lastCue(), ['ui.stage.confirm.attack_primary_weapon', 'ui.stage.confirm']));
    g.lock.clear();
    await tick(5);
    check('clearing a LOCKED action (the tx settled) is not a cancel', !g.cues().some((c) => c[0] === 'ui.stage.cancel.attack_primary_weapon'));
    g.reset();
    g.lock.setCurrentAction('MOVE');
    await tick(5);
    g.lock.clear();
    await tick(5);
    check('releasing an armed move → cancel chain', same(g.lastCue(), ['ui.stage.cancel.move', 'ui.stage.cancel']));
    g.reset();
    g.lock.setCurrentAction('DEFENSE_SET');
    g.lock.clear();
    g.lock.setCurrentAction('ATTACK_SECONDARY_WEAPON'); // releaseConflictingAction in one tick
    await tick(5);
    check('clear + set in one tick is one arm, not a cancel', g.cues().length === 1 && same(g.lastCue(), ['ui.stage.arm.attack_secondary_weapon', 'ui.stage.arm']), JSON.stringify(g.cues()));
    g.lock.clear();
    await tick(5);
    g.reset();
    g.lock.setCurrentAction('ACTIVATE');
    g.lock.lock(); // a one-press commit
    await tick(5);
    check('activate arms and locks in one tick → confirm only', g.cues().length === 1 && same(g.lastCue(), ['ui.stage.confirm.activate', 'ui.stage.confirm']), JSON.stringify(g.cues()));
  }

  console.log('\n— rocker, screens, focus, battery');
  {
    const g = game();
    await tick(300);
    const d = g.w.document;
    d.getElementById('hud').innerHTML = '<div class="sui-action-bar-panel-switch-group"><img id="sw" data-state="off"></div><div class="sui-action-bar-panel-switch-group"><img id="sw2" data-state="disabled"></div>';
    d.getElementById('sw').dispatchEvent(new g.w.MouseEvent('click', { bubbles: true }));
    check('the rocker clicks', same(g.lastCue(), ['ui.rocker.click']));
    d.getElementById('sw2').dispatchEvent(new g.w.MouseEvent('click', { bubbles: true }));
    check('a disabled rocker is denied', same(g.lastCue(), ['ui.denied']));
    g.fire('STRUCT_SELECTION_CHANGED', { structId: '5-3' });
    const lp = g.calls.filter((c) => c.kind === 'loop');
    check('selecting an offline extractor starts the idle focus loop', lp.length === 1 && same(lp[0].c, ['focus.ore_extractor.idle']) && lp[0].key === 'focus');
    g.fire('STRUCT_SELECTION_CHANGED', { structId: '5-3' });
    check('the same id again does nothing', g.calls.filter((c) => c.kind === 'loop').length === 1);
    g.lock.setCurrentAction('ACTIVATE'); g.lock.lock();
    g.structs['5-3'].isOnline = () => true;
    g.fire('SHOW_STRUCT_STILL', { structId: '5-3', mapId: null });
    check('powering the focused extractor on → its startup chain, and the loop restarts as active',
      g.cues().some((c) => same(c, ['focus.ore_extractor.startup', 'ui.rocker.power_up'])) && same(g.calls.filter((c) => c.kind === 'loop').slice(-1)[0].c, ['focus.ore_extractor.active']));
    g.lock.clear();
    g.reset();
    g.fire('STRUCT_SELECTION_CHANGED', { structId: '5-4' });
    check('leaving stops the loop; a bunker opens', g.calls.some((c) => c.kind === 'stop') && same(g.lastCue(), ['focus.ore_bunker.open']));
    g.fire('STRUCT_SELECTION_CHANGED', { structId: null });
    check('deselecting the bunker closes it', same(g.lastCue(), ['focus.ore_bunker.close']));
    g.fire('STRUCT_SELECTION_CHANGED', { structId: '5-1' });
    check('any other struct is the per-type focus with the generic tail', same(g.lastCue(), ['focus.tank', 'focus.struct']));
    g.reset();
    g.lock.setCurrentAction('DEACTIVATE'); g.lock.lock();
    g.fire('SHOW_STRUCT_STILL', { structId: '5-1' });
    check('powering down → power_down', same(g.lastCue(), ['ui.rocker.power_down']));
    g.lock.clear();

    g.reset();
    g.w.menuPage.router.goto('Fleet', 'index', {});
    g.w.menuPage.router.goto('Fleet', 'index', {});
    check('a screen change cues once; the same triple again (a refresh) does not', g.cues().length === 1 && same(g.lastCue(), ['ui.screen.nav']) && g.gotos.length === 2);
    check('…and the wrap carries its sentinel and calls through', g.w.menuPage.router.goto.__structsPatched === true);

    g.reset();
    g.fire('CHARGE_LEVEL_CHANGED', { playerId: '1-7', chargeLevel: 2 });
    check('the first battery reading only records', g.cues().length === 0);
    g.fire('CHARGE_LEVEL_CHANGED', { playerId: '1-7', chargeLevel: 3 });
    check('a slice gained → battery cue', same(g.lastCue(), ['ui.battery.slice']));
    g.fire('CHARGE_LEVEL_CHANGED', { playerId: '1-7', chargeLevel: 1 });
    g.fire('CHARGE_LEVEL_CHANGED', { playerId: '1-99', chargeLevel: 5 });
    check('spending, and someone else\'s battery, do not', g.cues().length === 1);
  }

  console.log('\n— HR bot and music');
  {
    const g = game();
    await tick(300);
    const d = g.w.document;
    const body = d.getElementById('menu-page-body-content');
    const dlg = d.getElementById('menu-page-dialogue-screen-content');
    body.innerHTML = '<div class="page"><div id="hrbot-talking-large"></div></div>';
    await tick(5);
    check('the bot appearing → hrbot.start', same(g.lastCue(), ['hrbot.start']));
    dlg.innerHTML = '<p>first line</p>';
    await tick(5);
    check('the first line is the start, not a line', !g.cues().some((c) => c[0] === 'hrbot.line'));
    dlg.innerHTML = '<p>second line</p>';
    await tick(5);
    check('the next line → hrbot.line', same(g.lastCue(), ['hrbot.line']));
    body.innerHTML = '';
    await tick(5);
    check('the bot leaving → hrbot.end', same(g.lastCue(), ['hrbot.end']));
    g.reset();
    g.fire('LOGIN_COMPLETE');
    check('login starts the soundtrack on the base layer', g.calls.some((c) => c.kind === 'music' && c.id === 'music.ambient' && c.o.layer === 'base'));
  }

  console.log('\n— without the engine');
  {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/index.html' });
    const w = dom.window;
    w.eval(readFileSync(root + '/frontend/sound-catalogue.js', 'utf8'));
    let threw = false;
    try { w.eval(block); w.__STRUCTS_SOUND_GRASS__({ category: 'raid_status', detail: { status: 'initiated' } }); w.dispatchEvent(new w.Event('ANIMATION')); w.dispatchEvent(new w.Event('LOGIN_COMPLETE')); } catch (e) { threw = String(e); }
    check('nothing throws when StructsSound and gameState are absent', threw === false, threw);
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
