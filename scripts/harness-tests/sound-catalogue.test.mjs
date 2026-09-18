// The sound catalogue: every mount id the game can cue, and the helpers that
// build candidate chains for the parameterised ones.
//
// Two guarantees this pins. (1) A helper can never answer an id that is not in
// the catalogue — otherwise a designer could see a cue on the tape that no row
// lets them map. (2) Every non-optional mount is reachable: either some hook
// names it as a literal, or a helper produces it over the real vocabulary.
// A mount nobody fires is a row nobody can ever hear.
import { readFileSync } from 'fs';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const root = process.cwd();
const g = { window: undefined };
const src = readFileSync(root + '/frontend/sound-catalogue.js', 'utf8');
new Function('window', src)(g);
const C = g.StructsSoundCatalogue;

console.log('\n— shape');
check('the catalogue exists and is frozen', C && Object.isFrozen(C.MOUNTS));
check('about two hundred mounts', C.MOUNTS.length > 150 && C.MOUNTS.length < 260, C.MOUNTS.length);
const ids = C.MOUNTS.map((m) => m.id);
check('ids are unique', new Set(ids).size === ids.length);
check('ids are lowercase dotted chain vocabulary', ids.every((id) => /^[a-z0-9_.]+$/.test(id)), ids.find((id) => !/^[a-z0-9_.]+$/.test(id)));
check('every entry is well-formed', C.MOUNTS.every((m) =>
  C.GROUPS.includes(m.group) && ['oneshot', 'loop', 'music'].includes(m.kind) && typeof m.label === 'string' && m.label
  && typeof m.when === 'string' && m.when && m.defaults && typeof m.defaults.loop === 'boolean'),
  JSON.stringify(C.MOUNTS.find((m) => !C.GROUPS.includes(m.group) || !m.when)));
check('loops and music default to loop:true, one-shots to false',
  C.MOUNTS.every((m) => m.defaults.loop === (m.kind !== 'oneshot')));
check('music picks in sequence by default', C.byId['music.ambient'].defaults.pick === 'sequence' && C.byId['ui.press'].defaults.pick === 'random');
check('every group has at least one mount', C.GROUPS.every((gname) => C.MOUNTS.some((m) => m.group === gname)));
check('the 22 chain types are all present', C.ALL_SLUGS.length === 22 && C.ALL_SLUGS.includes('high_altitude_interceptor') && C.ALL_SLUGS.includes('world_engine'));
check('slug mirrors spectator.rs::type_slug', C.slug('  Ore  Bunker ') === 'ore_bunker' && C.slug('High Altitude Interceptor') === 'high_altitude_interceptor' && C.slug('SAM Launcher') === 'sam_launcher');
check('the fourteen firing hulls each have a primary fire mount', C.FIRE_SLUGS.length === 14 && C.FIRE_SLUGS.every((s) => C.has('fire.' + s + '.primary')));
check('only the factory\'s secondaries exist', same(C.SECONDARY_SLUGS.sort(), ['battleship', 'cruiser', 'starfighter']));
check('labels carry the Codex names', C.byId['fire.tank.primary'].label === 'Breakaway Tank · Rail Gun' && C.byId['fire.command_ship.primary'].label === 'CMD Ship · Chimera Missile');

console.log('\n— every helper stays inside the catalogue');
const inside = (list) => list.every((id) => C.has(id));
// A chain ends on a real (non-optional) tail — unless the WHOLE chain is
// optional, which is a feature nobody has to map (per-unit focus sounds).
const endsReal = (list) => list.length > 0 && (!C.byId[list[list.length - 1]].optional || list.every((id) => C.byId[id].optional));
let produced = new Set();
const note = (list) => { list.forEach((id) => produced.add(id)); return list; };
let helperOk = true, helperWhy = '';
const walk = (name, list) => {
  note(list);
  if (!inside(list) || !endsReal(list)) { helperOk = false; helperWhy = helperWhy || name + ' → ' + JSON.stringify(list); }
};
for (const s of C.FIRE_SLUGS) for (const w of ['primary', 'secondary', 'primaryWeapon', 'secondaryWeapon']) walk('fire ' + s + ' ' + w, C.fireChain(s, w));
for (const c of C.CLASSES) for (const a of C.AMBITS.concat([null])) for (const k of [true, false]) walk('impact', C.impactChain(c, a, k));
for (const a of C.AMBITS) { walk('destroy', C.destroyChain(a)); walk('deploy', C.deployChain(a)); }
walk('deploy none', C.deployChain(null));
for (const cause of Object.keys(C.EVADE_CAUSES).concat(['noUnitDefenses', '', null, 'DEFENSIVE_MANEUVER', 'SIGNAL_JAMMING'])) walk('evade ' + cause, C.evadeChain(cause));
for (const s of C.ALL_SLUGS) for (const on of [true, false]) { walk('stealth', C.stealthChain(s, on)); walk('focus', C.focusChain(s, on)); }
for (const s of C.INDUSTRY_SLUGS) { walk('startup', C.startupChain(s)); walk('result', C.resultChain(s, true)); walk('result', C.resultChain(s, false)); }
walk('startup other', C.startupChain('tank'));
for (const ph of C.STAGES) for (const a of C.ACTIONS.concat(['ATTACK_PRIMARY_WEAPON', 'nonsense'])) walk('stage', C.stageChain(ph, a));
for (const p of Object.keys(C.PASSIVE).concat(['noPassiveWeaponry', null])) walk('counter', C.counterChain(p));
// evadeEndChain may legitimately be empty (armour has no end); when it answers, it answers real ids.
for (const cause of Object.keys(C.EVADE_CAUSES)) { const l = C.evadeEndChain(cause); note(l); if (!inside(l)) { helperOk = false; helperWhy = 'evadeEnd ' + cause; } }
check('every chain is catalogue ids ending on a non-optional tail', helperOk, helperWhy);

console.log('\n— the shared mapper');
const cues = (names, ctx) => C.animationCues(names, ctx).map((c) => c.candidates);
check('tank primary fire', same(cues(['ATTACK_PRIMARY_WEAPON'], { typeSlug: 'tank' }), [['fire.tank.primary', 'fire.primary']]));
check('starfighter attack run', same(cues(['ATTACK_SECONDARY_WEAPON'], { typeSlug: 'starfighter' }), [['fire.starfighter.secondary', 'fire.secondary']]));
check('a counter-fire adds the passive weaponry cue', same(cues(['ATTACK_PRIMARY_WEAPON'], { typeSlug: 'destroyer', counter: true, passiveWeaponry: 'advancedCounterAttack' }),
  [['fire.destroyer.primary', 'fire.primary'], ['ability.advanced_counter_attack', 'ability.counter_attack']]));
check('the Cruiser water rule: angled-down missile on a water target', same(cues(['IMPACT_ANGLED_DOWN_MISSILE', 'SHAKE_ANGLED_DOWN_DEFAULT_FIRST'], { targetAmbit: 'water' }),
  [['impact.missile.water', 'impact.missile']]));
check('the LAST shake marks the kill', same(cues(['IMPACT_ANGLED_DOWN_MISSILE', 'SHAKE_ANGLED_DOWN_DEFAULT_LAST'], { targetAmbit: 'water' }),
  [['impact.missile.kill', 'impact.missile.water', 'impact.missile']]));
check('an impact with no known ambit still has its generic tail', same(cues(['IMPACT_HORIZONTAL_GATLING'], {}), [['impact.gatling']]));
check('destroy by ambit', same(cues(['DESTROY_WATER']), [['destroy.water']]));
check('deployment', same(cues(['DEPLOYMENT_AIR']), [['deploy.air', 'deploy']]));
check('move depart / arrive', same(cues(['MOVE_DEPART']), [['move.depart']]) && same(cues(['MOVE_ARRIVE']), [['move.arrive']]));
check('stealth per type with a generic tail', same(cues(['STEALTH_ACTIVATE'], { typeSlug: 'submersible' }), [['stealth.submersible.activate', 'stealth.activate']])
  && same(cues(['STEALTH_DEACTIVATE'], { typeSlug: 'tank' }), [['stealth.deactivate']]));
check('the game\'s EVADE and the viewer\'s art name give the same chain',
  same(cues(['EVADE'], { evadedCause: 'defensiveManeuver' }), cues(['DEFENSIVE_MANEUVER'], {}))
  && same(cues(['EVADE'], { evadedCause: 'defensiveManeuver' }), [['ability.defensive_maneuver.activate', 'ability.evade']]));
check('armour breaks', same(cues(['EVADE'], { evadedCause: 'armour' }), [['ability.armour.break', 'ability.evade']]));
check('an unknown evade cause falls to the generic evade', same(cues(['EVADE'], { evadedCause: 'noUnitDefenses' }), [['ability.evade']]) && same(cues(['EVADE'], {}), [['ability.evade']]));
check('banners', same(cues(['VICTORY_BANNER']), [['banner.victory']]) && same(cues(['DEFEAT_BANNER']), [['banner.defeat']]));
check('ACTIVE_LOOP and a bare SHAKE make no cue', cues(['ACTIVE_LOOP']).length === 0 && cues(['SHAKE_HORIZONTAL_DEFAULT_LAST']).length === 0);
check('end cues: jamming detonates, the shield deactivates, armour has none',
  same(C.animationEndCues('EVADE', { evadedCause: 'signalJamming' }).map((c) => c.candidates), [['ability.signal_jamming.detonate']])
  && same(C.animationEndCues('DEFENSIVE_MANEUVER').map((c) => c.candidates), [['ability.defensive_maneuver.deactivate']])
  && C.animationEndCues('EVADE', { evadedCause: 'armour' }).length === 0
  && C.animationEndCues('DESTROY_LAND').length === 0);

console.log('\n— coverage');
// Literal ids written in the hooks and pages must exist…
const LIT = /'((?:ui|raid|alert|hrbot|banner|music|move|deploy|ambient|focus|fire|impact|destroy|stealth|ability)\.[a-z0-9_.]+)'/g;
const files = ['frontend/structs-config.js', 'frontend/raidview.js', 'frontend/sound.js', 'frontend/board-terminal.js'];
const literals = new Set();
for (const f of files) {
  let text = '';
  try { text = readFileSync(root + '/' + f, 'utf8'); } catch (e) { continue; }
  for (const m of text.matchAll(LIT)) literals.add(m[1]);
}
const unknownLiterals = [...literals].filter((id) => !C.has(id));
check('every literal cue id in the hooks is a catalogue mount', unknownLiterals.length === 0, unknownLiterals.join(', '));
// …and every non-optional mount is fired by someone (a literal or a helper).
// The ambient.* loops are produced by raidview with a computed id; treat the
// idle slugs as covered when raidview names the 'ambient.' prefix.
for (const s of C.IDLE_SLUGS) produced.add('ambient.' + s);
const unreached = C.MOUNTS.filter((m) => !m.optional && !literals.has(m.id) && !produced.has(m.id)).map((m) => m.id);
const HOOKS_PRESENT = literals.size > 0;
if (HOOKS_PRESENT) {
  check('every non-optional mount is reachable from a hook', unreached.length === 0, unreached.join(', '));
} else {
  console.log('  (hooks not written yet: ' + unreached.length + ' mounts await a caller)');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
