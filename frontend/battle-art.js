/* Shared Map Viewer / Simulator layered struct art. */
(function () {
  var ART = {
    battleship:                 { dir: 'battleship' },
    command_ship:               { dir: 'cmd-ship', top: ['top-weapon'] },
    cruiser:                    { dir: 'cruiser', top: ['top-weapon-ballistic', 'top-weapon-smart'], bottom: ['bottom-ripples'] },
    destroyer:                  { dir: 'destroyer', top: ['top-weapon'], bottom: ['bottom-ripples'] },
    ore_extractor:              { dir: 'extractor', top: ['top-drill'] },
    frigate:                    { dir: 'frigate', bottom: ['bottom-weapon'] },
    field_generator:            { dir: 'generator', top: ['top-tube'] },
    high_altitude_interceptor:  { dir: 'interceptor', bottom: ['bottom-weapon'] },
    jamming_satellite:          { dir: 'jamming-sat', top: ['top-weapon'] },
    mobile_artillery:           { dir: 'mobile-artillery', top: ['top-weapon'] },
    orbital_shield_generator:   { dir: 'orb-shield', top: ['top-weapon'] },
    ore_bunker:                 { dir: 'ore-bunker', top: ['top-weapon'] },
    planetary_defense_cannon:   { dir: 'pdc', top: ['top-weapon'] },
    pursuit_fighter:            { dir: 'pursuit-fighter', bottom: ['bottom-weapon'] },
    ore_refinery:               { dir: 'refinery', top: ['top-bays'] },
    starfighter:                { dir: 'starfighter', top: ['top-weapon-ballistic'], bottom: ['bottom-weapon-smart'] },
    sam_launcher:               { dir: 'sam-launcher', top: ['top-weapon'] },
    stealth_bomber:             { dir: 'stealth-bomber', bottom: ['bottom-weapon'] },
    submersible:                { dir: 'submersible', top: ['top-weapon'], bottom: ['bottom-ripples'], hidden: true },
    tank:                       { dir: 'tank', top: ['top-weapon'] },
  };

  function artPath(dir, suffix) { return 'img/structs/' + dir + '/' + dir + '-' + suffix + '.png'; }

  var EQUIP_ICON = {
    attackRun: 'icon-ballistic-weapon',
    guidedWeaponry: 'icon-smart-weapon',
    unguidedWeaponry: 'icon-ballistic-weapon',
    advancedCounterAttack: 'icon-adv-counter',
    counterAttack: 'icon-counter',
    strongCounterAttack: 'icon-adv-counter',
    armour: 'icon-armour',
    defensiveManeuver: 'icon-kinetic-barrier',
    indirectCombatModule: 'icon-indirect',
    signalJamming: 'icon-signal-jam',
    stealthMode: 'icon-stealth',
    coordinatedReserveResponseTracker: 'icon-planetary-shield',
    defensiveCannon: 'icon-counter',
    lowOrbitBallisticInterceptorNetwork: 'icon-signal-jam',
    monitoringStation: 'icon-planetary-shield',
    oreBunker: 'icon-planetary-shield',
    smallGenerator: 'icon-refine'
  };
  window.BattleArt = { ART: ART, artPath: artPath, EQUIP_ICON: EQUIP_ICON };
})();
