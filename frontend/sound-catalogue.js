/* Sound mount points — the one list of every cue the game can make.
 *
 * A MOUNT is a named slot that a designer points at a local audio file
 * (⌘K → SOUNDS). Every mount is SILENT until then; nothing here plays
 * anything. This file is loaded by the game window, the board/Terminal and
 * the Map Viewer before sound.js, and it is pure: no Tauri, no DOM.
 *
 * Ids are CHAIN vocabulary only — type slugs (`tank`, `command_ship`, the
 * same lowercase/underscore rule as spectator.rs::type_slug), ambits
 * (`space|air|land|water`), the four projectile classes the animation
 * factory dispatches on (`cannon|gatling|missile|torpedo`), and the unit
 * defenses/passive weaponry enums. Labels carry the Codex names
 * (Breakaway Tank · Rail Gun); ids never do, because the Codex renames and
 * the chain does not.
 *
 * A cue is an ordered CANDIDATE LIST, most specific first, and the engine
 * plays the first mount that has a file. Anything parameterised builds its
 * list through the helpers below (fireChain, impactChain, …) so a caller can
 * never invent an id that is not in the catalogue — sound-catalogue.test.mjs
 * walks every helper over the whole vocabulary and checks exactly that.
 * Fixed ids (`ui.*`, `raid.*`, `alert.*`, `hrbot.*`, `banner.*`, `music.*`,
 * `move.*`) may be written as literals; the test sweeps those too.
 */
(function () {
  'use strict';
  if (window.StructsSoundCatalogue) return;

  // ── Vocabulary ────────────────────────────────────────────────────────────

  function slug(name) {
    return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('_');
  }

  // Chain type name → Codex label + the weapon names from the design list.
  // `primary`/`secondary` are LABELS for the fire mounts; whether a type has a
  // secondary animation at all follows the factory (raidview.js ATTACK_RULES).
  var TYPE_LIST = [
    ['Command Ship',              'CMD Ship',                       'Chimera Missile',   null],
    ['Battleship',                'Cataclysm Battleship',           'Mass Accelerator',  'Secondary Missile'],
    ['Starfighter',               'Gambit Starfighter',             'Plasma Missile',    'Attack Run'],
    ['Frigate',                   'Skylight Frigate',               'RPTR Missile',      null],
    ['Pursuit Fighter',           'Squall Pursuit Fighter',         'Cloudstrike Missile', null],
    ['Stealth Bomber',            'Rolling Thunder Stealth Bomber', 'Plasma Bomb',       null],
    ['High Altitude Interceptor', 'Skimmer Interceptor',            'RPTR Missile',      null],
    ['Mobile Artillery',          'Archer Artillery',               'Artillery Strike',  null],
    ['Tank',                      'Breakaway Tank',                 'Rail Gun',          null],
    ['SAM Launcher',              'Longshot Launcher',              'RPTR Missile',      null],
    ['Cruiser',                   'Hydra Cruiser',                  'Planetary Missile', 'AA-Cannons'],
    ['Destroyer',                 'Kraken Destroyer',               '05-PRY Missile',    null],
    ['Submersible',               'Leviathan Submersible',          'Voidreach Missile', null],
    ['Ore Extractor',             'Ore Extractor',                  null, null],
    ['Ore Refinery',              'Ore Refinery',                   null, null],
    ['Orbital Shield Generator',  'Orbital Shield Generator',       null, null],
    ['Jamming Satellite',         'Jamming Satellite',              null, null],
    ['Ore Bunker',                'Ore Bunker',                     null, null],
    ['Planetary Defense Cannon',  'Planetary Defense Cannon',       'Defensive Cannon',  null],
    ['Field Generator',           'Field Generator',                null, null],
    ['Continental Power Plant',   'Continental Power Plant',        null, null],
    ['World Engine',              'World Engine',                   null, null],
  ];
  var TYPES = {};          // slug → { name, label, primary, secondary }
  var ALL_SLUGS = [];
  TYPE_LIST.forEach(function (t) {
    var s = slug(t[0]);
    TYPES[s] = { name: t[0], label: t[1], primary: t[2], secondary: t[3] };
    ALL_SLUGS.push(s);
  });
  // The thirteen hulls that fire, plus the planet's cannon.
  var FIRE_SLUGS = ALL_SLUGS.filter(function (s) { return !!TYPES[s].primary; });
  var FLEET_SLUGS = FIRE_SLUGS.filter(function (s) { return s !== 'planetary_defense_cannon'; });
  var SECONDARY_SLUGS = ALL_SLUGS.filter(function (s) { return !!TYPES[s].secondary; });
  var STEALTH_SLUGS = ['stealth_bomber', 'submersible'];
  var INDUSTRY_SLUGS = ['ore_extractor', 'ore_refinery'];
  // Types the Map Viewer runs an idle loop for (raidview.js IDLE_TYPES).
  var IDLE_SLUGS = ['field_generator', 'jamming_satellite', 'orbital_shield_generator', 'ore_bunker', 'ore_extractor', 'ore_refinery'];

  var AMBITS = ['space', 'air', 'land', 'water'];
  var CLASSES = ['cannon', 'gatling', 'missile', 'torpedo'];
  var CLASS_LABELS = { cannon: 'Cannon-style Ballistic', gatling: 'Gatling-style Ballistic', missile: 'Missile-style Smart', torpedo: 'Bomb/Torpedo-style Smart' };
  var ACTIONS = ['activate', 'deactivate', 'attack_primary_weapon', 'attack_secondary_weapon', 'defense_set', 'defense_clear',
    'move', 'stealth_activate', 'stealth_deactivate', 'consume_alpha', 'build_cancel'];
  var STAGES = ['arm', 'confirm', 'cancel'];
  // evadedCause (shot detail) / viewer art name → ability slug.
  var EVADE_CAUSES = {
    defensiveManeuver: 'defensive_maneuver',
    signalJamming: 'signal_jamming',
    armour: 'armour',
    lowOrbitBallisticInterceptorNetwork: 'low_orbit_ballistic_interceptor_network',
  };
  var ART_TO_CAUSE = {
    DEFENSIVE_MANEUVER: 'defensiveManeuver',
    SIGNAL_JAMMING: 'signalJamming',
    LOW_ORBIT_BALLISTIC_INTERCEPTOR_NETWORK: 'lowOrbitBallisticInterceptorNetwork',
  };
  var PASSIVE = { counterAttack: 'counter_attack', strongCounterAttack: 'strong_counter_attack', advancedCounterAttack: 'advanced_counter_attack' };

  var GROUPS = ['Music', 'Raid', 'Alerts', 'Combat', 'Weapons', 'Abilities', 'Movement', 'Industry', 'Focus', 'UI', 'Onboarding', 'Map Viewer'];

  // ── The list ──────────────────────────────────────────────────────────────

  var MOUNTS = [];
  var byId = {};
  function add(id, group, label, when, opts) {
    opts = opts || {};
    if (byId[id]) throw new Error('duplicate sound mount ' + id);
    var kind = opts.kind || 'oneshot';
    var defaults = { delay_ms: 0, loop: kind !== 'oneshot', loop_count: 0, volume: 1, enabled: true, pick: kind === 'music' ? 'sequence' : 'random' };
    var m = { id: id, group: group, label: label, when: when, kind: kind, optional: !!opts.optional, defaults: defaults };
    MOUNTS.push(m);
    byId[id] = m;
    return m;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function typeLabel(s) { return TYPES[s] ? TYPES[s].label : cap(s).replace(/_/g, ' '); }

  // Music
  add('music.ambient', 'Music', 'Soundtrack', 'always, from login; several files play in order', { kind: 'music' });

  // Raid
  add('raid.base_raided.music', 'Raid', 'Alpha Base Raided · Music', 'our planet: a raid begins', { kind: 'music' });
  add('raid.base_raided.alert', 'Raid', 'Alpha Base Raided · Alert', 'our planet: a raid begins');
  add('raid.initiated.music', 'Raid', 'Raid Initiated · Music', 'our fleet: the raid we launched begins', { kind: 'music' });
  add('raid.initiated.alert', 'Raid', 'Raid Initiated · Alert', 'our fleet: the raid we launched begins');
  add('raid.shield_breach.music', 'Raid', 'Shield Breach Underway · Music', 'our planet: the shield is down', { kind: 'music' });
  add('raid.shield_breach.alert', 'Raid', 'Shield Breach Underway · Alert', 'our planet: the shield is down');
  add('raid.shield_restored.alert', 'Raid', 'Shield Restored · Alert', 'our planet: no longer vulnerable');

  // Alerts
  add('alert.ore_received', 'Alerts', 'Ore Received', 'ore is credited to us');
  add('alert.ore_refined', 'Alerts', 'Ore Refined', 'a refinery turns our ore into Alpha');
  add('alert.alpha_received', 'Alerts', 'Alpha Matter Received', 'Alpha arrives by transaction');

  // Combat: destruction + impacts (generic, then per-ambit and kill variants)
  AMBITS.forEach(function (a) {
    add('destroy.' + a, 'Combat', cap(a) + '-based Destruction', 'a struct is destroyed in ' + a);
  });
  CLASSES.forEach(function (c) {
    add('impact.' + c, 'Combat', CLASS_LABELS[c] + ' Impact', 'a ' + c + ' round lands');
    add('impact.' + c + '.kill', 'Combat', CLASS_LABELS[c] + ' Impact · killing blow', 'the ' + c + ' round that destroys the target', { optional: true });
    AMBITS.forEach(function (a) {
      add('impact.' + c + '.' + a, 'Combat', CLASS_LABELS[c] + ' Impact · ' + a, 'a ' + c + ' round lands on a target in ' + a, { optional: true });
    });
  });

  // Weapons: generic tails, then one per hull
  add('fire.primary', 'Weapons', 'Primary Weapon (any)', 'any struct fires its primary weapon');
  add('fire.secondary', 'Weapons', 'Secondary Weapon (any)', 'any struct fires its secondary weapon');
  FIRE_SLUGS.forEach(function (s) {
    add('fire.' + s + '.primary', 'Weapons', TYPES[s].label + ' · ' + TYPES[s].primary, 'a ' + TYPES[s].name + ' fires its primary weapon');
  });
  SECONDARY_SLUGS.forEach(function (s) {
    add('fire.' + s + '.secondary', 'Weapons', TYPES[s].label + ' · ' + TYPES[s].secondary, 'a ' + TYPES[s].name + ' fires its secondary weapon');
  });

  // Abilities
  add('ability.defensive_maneuver.activate', 'Abilities', 'Kinetic Shield · activate', 'a shot is absorbed by a kinetic shield');
  add('ability.defensive_maneuver.impact', 'Abilities', 'Kinetic Shield · impact', 'the shot hits the shield (use delay)', { optional: true });
  add('ability.defensive_maneuver.deactivate', 'Abilities', 'Kinetic Shield · deactivate', 'the shield animation ends');
  add('ability.signal_jamming.activate', 'Abilities', 'Signal Jamming · activate', 'a missile is jammed');
  add('ability.signal_jamming.detonate', 'Abilities', 'Signal Jamming · detonate', 'the jammed missile detonates (animation end)');
  add('ability.armour.break', 'Abilities', 'Ablative Armour · break', 'armour plate breaks away and absorbs a shot');
  add('ability.low_orbit_ballistic_interceptor_network', 'Abilities', 'Interceptor Network', 'the planet\'s Jamming Satellite intercepts a shot', { optional: true });
  add('ability.evade', 'Abilities', 'Evade (any)', 'a shot misses for any other reason');
  add('ability.advanced_counter_attack', 'Abilities', 'Advanced Counter-Attack', 'a struct with advanced counter fires back');
  add('ability.strong_counter_attack', 'Abilities', 'Strong Counter-Attack', 'a struct with strong counter fires back', { optional: true });
  add('ability.counter_attack', 'Abilities', 'Counter-Attack', 'a struct fires back');

  // Movement
  add('move.depart', 'Movement', 'Alpha Drift · depart', 'a CMD ship leaves its battleground (also our fleet departing)');
  add('move.arrive', 'Movement', 'Alpha Drift · arrive', 'a CMD ship lands on its new battleground (also our fleet arriving)');
  add('deploy', 'Movement', 'Deployment', 'a struct is deployed');
  AMBITS.forEach(function (a) { add('deploy.' + a, 'Movement', 'Deployment · ' + a, 'a struct is deployed to ' + a, { optional: true }); });
  add('stealth.activate', 'Movement', 'Stealth · activate', 'a struct vanishes');
  add('stealth.deactivate', 'Movement', 'Stealth · deactivate', 'a struct reappears');
  STEALTH_SLUGS.forEach(function (s) {
    add('stealth.' + s + '.activate', 'Movement', TYPES[s].label + ' · Stealth activate', 'a ' + TYPES[s].name + ' vanishes / submerges', { optional: true });
    add('stealth.' + s + '.deactivate', 'Movement', TYPES[s].label + ' · Stealth deactivate', 'a ' + TYPES[s].name + ' reappears / surfaces', { optional: true });
  });

  // Industry
  INDUSTRY_SLUGS.forEach(function (s) {
    var L = TYPES[s].label, n = TYPES[s].name;
    add('focus.' + s + '.idle', 'Industry', L + ' · Idle Focus', 'an offline ' + n + ' is selected', { kind: 'loop' });
    add('focus.' + s + '.active', 'Industry', L + ' · Active Focus', 'an online ' + n + ' is selected', { kind: 'loop' });
    add('focus.' + s + '.startup', 'Industry', L + ' · Startup', 'the selected ' + n + ' is powered on');
    add('focus.' + s + '.result', 'Industry', L + ' · ' + (s === 'ore_extractor' ? 'Ore Extracted' : 'Ore Refined'), 'the selected ' + n + ' completes a cycle');
  });
  add('focus.ore_bunker.open', 'Industry', 'Ore Bunker · Focus', 'a bunker is selected (doors open)');
  add('focus.ore_bunker.close', 'Industry', 'Ore Bunker · Unfocus', 'a bunker is deselected (doors close)');

  // Focus (unit-specific selection sounds; all optional)
  add('focus.struct', 'Focus', 'Focus (any struct)', 'any struct is selected', { optional: true });
  ALL_SLUGS.forEach(function (s) {
    add('focus.' + s, 'Focus', typeLabel(s) + ' · Focus', 'a ' + TYPES[s].name + ' is selected', { optional: true });
  });
  IDLE_SLUGS.forEach(function (s) {
    add('ambient.' + s, 'Focus', typeLabel(s) + ' · Ambient', 'the Map Viewer shows an online ' + TYPES[s].name, { kind: 'loop', optional: true });
  });

  // UI
  add('ui.press', 'UI', 'Standard Button Press', 'any button');
  add('ui.denied', 'UI', 'Denied', 'a disabled button, or not enough charge');
  add('ui.stage.arm', 'UI', 'Multi-stage · arm', 'an ability is armed and waits for a target');
  add('ui.stage.confirm', 'UI', 'Multi-stage · confirm', 'a target is chosen and the action is sent');
  add('ui.stage.cancel', 'UI', 'Multi-stage · cancel', 'an armed ability is released without a target');
  STAGES.forEach(function (ph) {
    ACTIONS.forEach(function (a) {
      add('ui.stage.' + ph + '.' + a, 'UI', 'Multi-stage · ' + ph + ' · ' + a.replace(/_/g, ' '), a.replace(/_/g, ' ') + ' is ' + (ph === 'arm' ? 'armed' : ph === 'confirm' ? 'confirmed' : 'cancelled'), { optional: true });
    });
  });
  add('ui.rocker.click', 'UI', 'Rocker Switch · click', 'the power switch is pressed');
  add('ui.rocker.power_up', 'UI', 'Rocker Switch · power up', 'a struct comes online');
  add('ui.rocker.power_down', 'UI', 'Rocker Switch · power down', 'a struct goes offline');
  add('ui.screen.nav', 'UI', 'Screen Controls', 'a menu screen changes');
  add('ui.battery.slice', 'UI', 'Battery Charge', 'a charge slice becomes available');
  add('ui.palette.open', 'UI', 'Command Palette · open', '⌘K opens');
  add('ui.palette.close', 'UI', 'Command Palette · close', '⌘K closes');

  // Onboarding
  add('hrbot.start', 'Onboarding', 'HR Bot · start', 'the HR bot appears and starts talking');
  add('hrbot.line', 'Onboarding', 'HR Bot · line', 'the dialogue advances a line');
  add('hrbot.end', 'Onboarding', 'HR Bot · end', 'the HR bot leaves');

  // Map Viewer
  add('banner.victory', 'Map Viewer', 'Victory Banner', 'a raid we were part of ends in our favour');
  add('banner.defeat', 'Map Viewer', 'Defeat Banner', 'a raid we were part of ends against us');

  // ── Chain helpers (most specific → generic tail) ──────────────────────────

  function has(id) { return Object.prototype.hasOwnProperty.call(byId, id); }
  function chain(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && has(list[i]) && out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  function weaponWord(w) {
    return /secondary/i.test(String(w)) ? 'secondary' : 'primary';
  }
  function fireChain(typeSlug, weapon) {
    var w = weaponWord(weapon);
    return chain(['fire.' + slug(typeSlug) + '.' + w, 'fire.' + w]);
  }
  function impactChain(cls, ambit, kill) {
    var c = String(cls || '').toLowerCase(), a = String(ambit || '').toLowerCase();
    return chain([kill ? 'impact.' + c + '.kill' : null, a ? 'impact.' + c + '.' + a : null, 'impact.' + c]);
  }
  function destroyChain(ambit) {
    return chain(['destroy.' + String(ambit || '').toLowerCase()]);
  }
  function causeSlug(cause) {
    return EVADE_CAUSES[cause] || EVADE_CAUSES[ART_TO_CAUSE[cause]] || null;
  }
  function evadeChain(cause) {
    var s = causeSlug(cause);
    var head = s === 'armour' ? 'ability.armour.break'
      : s === 'low_orbit_ballistic_interceptor_network' ? 'ability.low_orbit_ballistic_interceptor_network'
      : s ? 'ability.' + s + '.activate' : null;
    return chain([head, 'ability.evade']);
  }
  function evadeEndChain(cause) {
    var s = causeSlug(cause);
    return chain([s === 'defensive_maneuver' ? 'ability.defensive_maneuver.deactivate'
      : s === 'signal_jamming' ? 'ability.signal_jamming.detonate' : null]);
  }
  function stealthChain(typeSlug, on) {
    var ph = on ? 'activate' : 'deactivate';
    return chain(['stealth.' + slug(typeSlug) + '.' + ph, 'stealth.' + ph]);
  }
  function deployChain(ambit) {
    return chain(['deploy.' + String(ambit || '').toLowerCase(), 'deploy']);
  }
  function focusChain(typeSlug, online) {
    var s = slug(typeSlug);
    if (INDUSTRY_SLUGS.indexOf(s) >= 0) return chain(['focus.' + s + '.' + (online ? 'active' : 'idle')]);
    return chain(['focus.' + s, 'focus.struct']);
  }
  function startupChain(typeSlug) {
    return chain(['focus.' + slug(typeSlug) + '.startup', 'ui.rocker.power_up']);
  }
  function resultChain(typeSlug, focused) {
    var s = slug(typeSlug);
    var alert = s === 'ore_refinery' ? 'alert.ore_refined' : 'alert.ore_received';
    return chain([focused ? 'focus.' + s + '.result' : null, alert]);
  }
  function stageChain(phase, action) {
    var a = String(action || '').toLowerCase();
    return chain(['ui.stage.' + phase + '.' + a, 'ui.stage.' + phase]);
  }
  function counterChain(passiveWeaponry) {
    var s = PASSIVE[passiveWeaponry] || null;
    return chain([s ? 'ability.' + s : null, 'ability.counter_attack']);
  }

  // ── The shared mapper: animation names → cues ─────────────────────────────
  //
  // Both the game window (ANIMATION events) and the Map Viewer (runAnimation)
  // call this with the names of one queue event and whatever context they
  // have: { typeSlug, targetAmbit, healthAfter, evadedCause, counter,
  // passiveWeaponry }. Layers that play together (impact + shake) are one
  // moment, so the SHAKE only decides whether the impact was the kill.

  var IMPACT_RE = /^IMPACT_(?:HORIZONTAL|ANGLED_UP|ANGLED_DOWN)_(CANNON|GATLING|MISSILE|TORPEDO)$/;
  var DESTROY_RE = /^DESTROY_(SPACE|AIR|LAND|WATER)$/;
  var DEPLOY_RE = /^DEPLOYMENT_(SPACE|AIR|LAND|WATER)$/;
  var KILL_RE = /^SHAKE_.*_LAST$/;

  function animationCues(names, ctx) {
    ctx = ctx || {};
    names = [].concat(names || []);
    var out = [];
    var kill = names.some(function (n) { return KILL_RE.test(n); });
    function push(candidates, extra) {
      if (candidates && candidates.length) out.push({ candidates: candidates, ctx: extra || {} });
    }
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i] || '');
      var m;
      if (n === 'ATTACK_PRIMARY_WEAPON' || n === 'ATTACK_SECONDARY_WEAPON') {
        var w = n === 'ATTACK_SECONDARY_WEAPON' ? 'secondary' : 'primary';
        push(fireChain(ctx.typeSlug, w), { struct: ctx.typeSlug, weapon: w });
        if (ctx.counter) push(counterChain(ctx.passiveWeaponry), { struct: ctx.typeSlug, counter: true });
      } else if ((m = IMPACT_RE.exec(n))) {
        push(impactChain(m[1], ctx.targetAmbit, kill), { ambit: ctx.targetAmbit, kill: kill });
      } else if ((m = DESTROY_RE.exec(n))) {
        push(destroyChain(m[1]), { ambit: m[1].toLowerCase() });
      } else if ((m = DEPLOY_RE.exec(n))) {
        push(deployChain(m[1]), { ambit: m[1].toLowerCase() });
      } else if (n === 'MOVE_DEPART') {
        push(['move.depart'], { struct: ctx.typeSlug });
      } else if (n === 'MOVE_ARRIVE') {
        push(['move.arrive'], { struct: ctx.typeSlug });
      } else if (n === 'STEALTH_ACTIVATE' || n === 'STEALTH_DEACTIVATE') {
        push(stealthChain(ctx.typeSlug, n === 'STEALTH_ACTIVATE'), { struct: ctx.typeSlug });
      } else if (n === 'EVADE') {
        push(evadeChain(ctx.evadedCause), { cause: ctx.evadedCause || null });
      } else if (ART_TO_CAUSE[n]) {
        push(evadeChain(ART_TO_CAUSE[n]), { cause: ART_TO_CAUSE[n] });
      } else if (n === 'VICTORY_BANNER') {
        push(['banner.victory']);
      } else if (n === 'DEFEAT_BANNER') {
        push(['banner.defeat']);
      }
      // ACTIVE_LOOP, SHAKE_* and anything unknown: no cue of their own.
    }
    return out;
  }

  function animationEndCues(name, ctx) {
    ctx = ctx || {};
    var n = String(name || '');
    if (n === 'EVADE') return [{ candidates: evadeEndChain(ctx.evadedCause), ctx: { cause: ctx.evadedCause || null } }].filter(function (c) { return c.candidates.length; });
    if (ART_TO_CAUSE[n]) return [{ candidates: evadeEndChain(ART_TO_CAUSE[n]), ctx: { cause: ART_TO_CAUSE[n] } }].filter(function (c) { return c.candidates.length; });
    return [];
  }

  Object.freeze(MOUNTS);

  window.StructsSoundCatalogue = {
    MOUNTS: MOUNTS,
    byId: byId,
    GROUPS: GROUPS,
    TYPES: TYPES,
    ALL_SLUGS: ALL_SLUGS,
    FIRE_SLUGS: FIRE_SLUGS,
    FLEET_SLUGS: FLEET_SLUGS,
    SECONDARY_SLUGS: SECONDARY_SLUGS,
    STEALTH_SLUGS: STEALTH_SLUGS,
    INDUSTRY_SLUGS: INDUSTRY_SLUGS,
    IDLE_SLUGS: IDLE_SLUGS,
    AMBITS: AMBITS,
    CLASSES: CLASSES,
    ACTIONS: ACTIONS,
    STAGES: STAGES,
    EVADE_CAUSES: EVADE_CAUSES,
    ART_TO_CAUSE: ART_TO_CAUSE,
    PASSIVE: PASSIVE,
    slug: slug,
    has: has,
    fireChain: fireChain,
    impactChain: impactChain,
    destroyChain: destroyChain,
    evadeChain: evadeChain,
    evadeEndChain: evadeEndChain,
    stealthChain: stealthChain,
    deployChain: deployChain,
    focusChain: focusChain,
    startupChain: startupChain,
    resultChain: resultChain,
    stageChain: stageChain,
    counterChain: counterChain,
    animationCues: animationCues,
    animationEndCues: animationEndCues,
  };
})();
