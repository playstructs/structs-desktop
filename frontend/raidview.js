/* Raid View — read-only spectator renderer.
 *
 * Draws a planet the way the game draws it, from assets that already ship with
 * the app: 128px background tiles under layered struct PNGs under Lottie
 * animation layers. No canvas, no WebGL, no sprite sheets — the same plain-DOM
 * technique MapComponent uses.
 *
 * ── Why this is a reimplementation and not a reuse ───────────────────────────
 * MapComponent cannot serve here. Its struct lookup is hardcoded to five
 * `keyPlayers` buckets, which caps a GameState at ONE spectated planet; it
 * reads three bare-global `gameState` references; and MapStructViewerComponent
 * uses raw struct ids as DOM ids, so two windows on one planet would collide.
 * The geometry and the animation dispatch are transcribed from the game's own
 * constants (MapConstants.js, AnimationConstants.js, AnimationEventFactory.js,
 * StructTypeArtSetBuilder.js) so the two stay in agreement, but the plumbing is
 * ours and is per-window scoped throughout.
 *
 * ── Why nothing here can act ────────────────────────────────────────────────
 * This document is loaded WITHOUT the game's initialization script (raid-*
 * windows are built without one, exactly as the board/stream windows are). It
 * never touches localStorage, never opens a NATS socket, never starts a hasher
 * and cannot sign. It receives events and calls one read-only command.
 */
(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // Geometry — transcribed from constants/MapConstants.js
  // ══════════════════════════════════════════════════════════════════════════

  /* Mirrors `TERMINAL_STATUSES` in raid_view.rs and the game's
   * RaidStatusUtil.hasRaidEnded — the four statuses that mean the raid is
   * over and the attacker is no longer present. */
  var TERMINAL_RAID_STATUSES = [
    'attackerDefeated', 'attackerRetreated', 'raidSuccessful', 'demilitarized',
  ];

  var COL = {
    DEF_CMD: 'DEFENDER_COMMAND',
    DEF_PLAN: 'DEFENDER_PLANETARY',
    DEF_FLEET: 'DEFENDER_FLEET',
    DIVIDER: 'DIVIDER',
    ATK_FLEET: 'ATTACKER_FLEET',
    ATK_CMD: 'ATTACKER_COMMAND',
  };
  var COL_ORDER = [COL.DEF_CMD, COL.DEF_PLAN, COL.DEF_FLEET, COL.DIVIDER, COL.ATK_FLEET, COL.ATK_CMD];
  var DEFAULT_COL_COUNTS = {};
  DEFAULT_COL_COUNTS[COL.DEF_CMD] = 1;
  DEFAULT_COL_COUNTS[COL.DEF_PLAN] = 2;
  DEFAULT_COL_COUNTS[COL.DEF_FLEET] = 2;
  DEFAULT_COL_COUNTS[COL.DIVIDER] = 1;
  DEFAULT_COL_COUNTS[COL.ATK_FLEET] = 2;
  DEFAULT_COL_COUNTS[COL.ATK_CMD] = 1;

  var ROWS_PER_AMBIT = 2;              // MAP_TILE_ROWS_PER_AMBIT
  var AMBITS = ['space', 'air', 'land', 'water'];
  // The band drawn between two ambits. MAP_TRANSITION_TILE_LABELS.
  var TRANSITIONS = { 'space>air': 'atmosphere', 'air>land': 'horizon', 'land>water': 'shore' };
  // Only `horizon` has its own tile art; the others are drawn as a thin rule.
  var TRANSITION_ART = { horizon: 'horizon' };

  // Background colour behind each ambit's tile art, from main.css.
  var AMBIT_BG = { space: '#222034', air: '#80B2FF', land: '#B3A38C', water: '#408BFF' };

  // Tile art is a 9-slice: rows edge-top/top/middle/bottom/edge-bottom (0..4),
  // columns left/middle/right (1..3). With two rows per ambit we use the
  // `top` and `bottom` variants; `middle` covers any future taller ambit.
  var V_POS = ['edge-top', 'top', 'middle', 'bottom', 'edge-bottom'];

  function tileUrl(ambit, vIndex, hPos) {
    var v = V_POS[vIndex];
    var hIndex = hPos === 'left' ? 1 : (hPos === 'right' ? 3 : 2);
    return 'img/tiles/' + ambit + '/' + ambit + '-' + vIndex + '-' + hIndex + '-' + v + '-' + hPos + '.png';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Struct art — transcribed from builders/StructTypeArtSetBuilder.js
  //
  // `dir` is the (short, bespoke) art directory; `top`/`bottom` are extra
  // layers whose z-index puts them over/under the hull. The names do NOT
  // follow from the type name — hence an explicit table rather than a rule.
  // ══════════════════════════════════════════════════════════════════════════

  var ART = {
    battleship:                 { dir: 'battleship' },
    command_ship:               { dir: 'cmd-ship', top: ['top-weapon'] },
    cruiser:                    { dir: 'cruiser', top: ['top-weapon-ballistic', 'top-weapon-smart'], bottom: ['bottom-ripples'] },
    destroyer:                  { dir: 'destroyer', top: ['top-weapon'], bottom: ['bottom-ripples'] },
    ore_extractor:              { dir: 'extractor', top: ['top-drill'] },
    frigate:                    { dir: 'frigate', top: ['bottom-weapon'] },
    field_generator:            { dir: 'generator', top: ['top-tube'] },
    high_altitude_interceptor:  { dir: 'interceptor', top: ['bottom-weapon'] },
    jamming_satellite:          { dir: 'jamming-sat', top: ['top-weapon'] },
    mobile_artillery:           { dir: 'mobile-artillery', top: ['top-weapon'] },
    orbital_shield_generator:   { dir: 'orb-shield', top: ['top-weapon'] },
    ore_bunker:                 { dir: 'ore-bunker', top: ['top-weapon'] },
    planetary_defense_cannon:   { dir: 'pdc', top: ['top-weapon'] },
    pursuit_fighter:            { dir: 'pursuit-fighter', top: ['bottom-weapon'] },
    ore_refinery:               { dir: 'refinery', top: ['top-bays'] },
    starfighter:                { dir: 'starfighter', top: ['bottom-weapon-smart', 'top-weapon-ballistic'] },
    sam_launcher:               { dir: 'sam-launcher', top: ['top-weapon'] },
    stealth_bomber:             { dir: 'stealth-bomber', top: ['bottom-weapon'] },
    submersible:                { dir: 'submersible', top: ['top-weapon'], bottom: ['bottom-ripples'], hidden: true },
    tank:                       { dir: 'tank', top: ['top-weapon'] },
  };

  function artPath(dir, suffix) { return 'img/structs/' + dir + '/' + dir + '-' + suffix + '.png'; }

  // ══════════════════════════════════════════════════════════════════════════
  // Animation dispatch — transcribed from factories/AnimationEventFactory.js
  //
  // A pure lookup: (attackerType, attackerAmbit, targetAmbit, weapon) →
  // {impact, shake, projectile}. First match wins, and the order below is the
  // factory's own if/else order — reordering changes behaviour, because
  // Command Ship's "same ambit" clause would otherwise swallow the Battleship
  // and Tank cases above it.
  // ══════════════════════════════════════════════════════════════════════════

  var PRIMARY = 'primaryWeapon', SECONDARY = 'secondaryWeapon';
  var SPACE = 'space', AIR = 'air', LAND = 'land', WATER = 'water';

  // `atkAmbit`/`tgtAmbit` null means "any"; `same: true` means the two match.
  var ATTACK_RULES = [
    { name: 'horizontal cannon', impact: 'IMPACT_HORIZONTAL_CANNON', shake: 'SHAKE_HORIZONTAL_DEFAULT', projectile: 'CANNON',
      any: [
        { atk: 'Battleship', from: [SPACE], to: [SPACE], weapon: PRIMARY },
        { atk: 'Tank', from: [LAND], to: [LAND], weapon: PRIMARY },
      ] },
    { name: 'horizontal missile', impact: 'IMPACT_HORIZONTAL_MISSILE', shake: 'SHAKE_HORIZONTAL_DEFAULT', projectile: 'MISSILE',
      any: [
        { atk: 'Starfighter', from: [SPACE], to: [SPACE], weapon: PRIMARY },
        { atk: 'Frigate', from: [SPACE], to: [SPACE], weapon: PRIMARY },
        { atk: 'Pursuit Fighter', from: [AIR], to: [AIR], weapon: PRIMARY },
        { atk: 'Battleship', from: [SPACE], to: [SPACE], weapon: SECONDARY },
        { atk: 'Command Ship', same: true, weapon: PRIMARY },
      ] },
    { name: 'horizontal torpedo', impact: 'IMPACT_HORIZONTAL_TORPEDO', shake: 'SHAKE_HORIZONTAL_DEFAULT', projectile: 'TORPEDO',
      any: [{ atk: 'High Altitude Interceptor', from: [AIR], to: [AIR], weapon: PRIMARY }] },
    { name: 'horizontal gatling', impact: 'IMPACT_HORIZONTAL_GATLING', shake: 'SHAKE_HORIZONTAL_GATLING', projectile: 'GATLING',
      any: [{ atk: 'Starfighter', from: [SPACE], to: [SPACE], weapon: SECONDARY }] },

    { name: 'angled down missile', impact: 'IMPACT_ANGLED_DOWN_MISSILE', shake: 'SHAKE_ANGLED_DOWN_DEFAULT', projectile: 'MISSILE',
      any: [
        // The game's clause is LAND OR WATER; this table said LAND only, so a
        // Cruiser shooting another water hull counted as an unmatched shot.
        { atk: 'Cruiser', from: [WATER], to: [LAND, WATER], weapon: PRIMARY },
        { atk: 'Submersible', from: [WATER], to: [WATER], weapon: PRIMARY },
        { atk: 'Frigate', from: [SPACE], to: [AIR], weapon: PRIMARY },
      ] },
    { name: 'angled down torpedo', impact: 'IMPACT_ANGLED_DOWN_TORPEDO', shake: 'SHAKE_ANGLED_DOWN_DEFAULT', projectile: 'TORPEDO',
      any: [
        { atk: 'Destroyer', from: [WATER], to: [WATER], weapon: PRIMARY },
        { atk: 'Stealth Bomber', from: [AIR], to: [WATER, LAND], weapon: PRIMARY },
      ] },
    { name: 'angled down cannon', impact: 'IMPACT_ANGLED_DOWN_CANNON', shake: 'SHAKE_ANGLED_DOWN_DEFAULT', projectile: 'CANNON',
      any: [
        { atk: 'Mobile Artillery', from: [LAND], to: [WATER, LAND], weapon: PRIMARY },
        { atk: 'Battleship', from: [SPACE], to: [WATER, LAND], weapon: PRIMARY },
        { atk: 'Planetary Defense Cannon', from: [LAND, WATER], to: [WATER, LAND], weapon: PRIMARY },
      ] },

    { name: 'angled up cannon', impact: 'IMPACT_ANGLED_UP_CANNON', shake: 'SHAKE_ANGLED_UP_DEFAULT', projectile: 'CANNON',
      any: [{ atk: 'Planetary Defense Cannon', from: [LAND, WATER], to: [SPACE, AIR], weapon: PRIMARY }] },
    { name: 'angled up missile', impact: 'IMPACT_ANGLED_UP_MISSILE', shake: 'SHAKE_ANGLED_UP_DEFAULT', projectile: 'MISSILE',
      any: [
        { atk: 'SAM Launcher', from: [LAND], to: [AIR, SPACE], weapon: PRIMARY },
        { atk: 'Submersible', from: [WATER], to: [AIR, SPACE], weapon: PRIMARY },
      ] },
    { name: 'angled up torpedo', impact: 'IMPACT_ANGLED_UP_TORPEDO', shake: 'SHAKE_ANGLED_UP_DEFAULT', projectile: 'TORPEDO',
      any: [
        { atk: 'Destroyer', from: [WATER], to: [AIR], weapon: PRIMARY },
        { atk: 'High Altitude Interceptor', from: [AIR], to: [SPACE], weapon: PRIMARY },
      ] },
    { name: 'angled up gatling', impact: 'IMPACT_ANGLED_UP_GATLING', shake: 'SHAKE_ANGLED_UP_GATLING', projectile: 'GATLING',
      any: [{ atk: 'Cruiser', from: [WATER], to: [AIR], weapon: SECONDARY }] },
  ];

  // `evadedCause` (from the shot detail) → the bundle that depicts it.
  var EVADE_ART = {
    defensiveManeuver: 'DEFENSIVE_MANEUVER',
    signalJamming: 'SIGNAL_JAMMING',
    // A PLANETARY defence: the shot detail flags it as
    // evadedByPlanetaryDefenses (not `evaded`), and the game plays this art on
    // the planet's Jamming Satellite, not on the shot's target.
    lowOrbitBallisticInterceptorNetwork: 'LOW_ORBIT_BALLISTIC_INTERCEPTOR_NETWORK',
  };
  var EVADE_NAMES = Object.keys(EVADE_ART).map(function (k) { return EVADE_ART[k]; });
  function isEvadeName(n) { return EVADE_NAMES.indexOf(n) >= 0; }

  /* The game mirrors every impact_* and destroy_* layer (`sui-flip-horizontal`
   * on those containers in MapStructViewerComponent, since 2026-04) and
   * nothing else — the bundles are authored facing the other way. Missing
   * this put the defender's hits and wreckage on the wrong side. */
  function flipsLayer(name) {
    var n = String(name || '');
    return n.indexOf('IMPACT_') === 0 || n.indexOf('DESTROY_') === 0;
  }

  /* The planet's one struct of a type — the game resolves the Jamming
   * Satellite and the Planetary Defense Cannon this way because the attack
   * detail never names them (getJammingSatelliteByKeyPlayer /
   * getPlanetaryDefenseCannonByKeyPlayer). */
  function planetaryStructOfType(structsById, slug) {
    var ids = Object.keys(structsById || {});
    for (var i = 0; i < ids.length; i++) {
      var s = structsById[ids[i]];
      if (s && s.type_slug === slug && s.category === 'planet' && !s.destroyed) return s;
    }
    return null;
  }

  function ruleMatches(clause, atkType, atkAmbit, tgtAmbit, weapon) {
    if (clause.atk !== atkType) return false;
    if (clause.weapon !== weapon) return false;
    if (clause.same) return !!atkAmbit && atkAmbit === tgtAmbit;
    if (clause.from && clause.from.indexOf(atkAmbit) < 0) return false;
    if (clause.to && clause.to.indexOf(tgtAmbit) < 0) return false;
    return true;
  }

  /* Resolve one shot to its animation names.
   *
   * Returns null when nothing matches. The game THROWS here; we must not — a
   * spectator hitting an unmapped combination should miss one flourish, not
   * lose the rest of the fight. Unmatched combinations are counted and
   * reported in the header rather than swallowed. */
  var unmatchedShots = 0;
  function resolveShotAnimation(atkType, atkAmbit, tgtAmbit, weapon, healthAfter, evaded, evadedCause) {
    if (evaded) {
      // `EVADE` is a logical name with no bundle of its own: the game picks
      // the art from the DEFENDER's capability (MapStructViewerComponent
      // .registerEvadeAnimation → defensive_maneuver or signal_jamming). The
      // shot detail names the defence that actually fired, which is both more
      // specific and per-shot, so resolve from that instead. `noUnitDefenses`
      // and anything unrecognised get no animation — the game registers none
      // in that case either.
      var evadeArt = EVADE_ART[evadedCause];
      return {
        names: evadeArt ? [evadeArt] : [],
        // The factory tags signal-jamming evasions with a torpedo projectile.
        projectile: evadedCause === 'signalJamming' ? 'TORPEDO' : '',
      };
    }
    var suffix = healthAfter > 0 ? 'FIRST' : 'LAST';
    for (var i = 0; i < ATTACK_RULES.length; i++) {
      var rule = ATTACK_RULES[i];
      for (var j = 0; j < rule.any.length; j++) {
        if (ruleMatches(rule.any[j], atkType, atkAmbit, tgtAmbit, weapon)) {
          return { names: [rule.impact, rule.shake + '_' + suffix], projectile: rule.projectile };
        }
      }
    }
    unmatchedShots++;
    return null;
  }

  /* Animation name → Lottie bundle path.
   *
   * Every ANIMATION.NAMES.* constant lowercases directly to its directory
   * under frontend/lottie/. Per-type bundles (attack, active_loop) take the
   * struct's asset slug as a second segment; shared effects (impact, shake,
   * destroy, evade) are a single data.json. */
  var PER_TYPE = { attack_primary_weapon: 1, attack_secondary_weapon: 1, active_loop: 1 };
  // The banner bundles predate the ANIMATION.NAMES convention and are named in
  // kebab case on disk, so they cannot be derived — map them explicitly rather
  // than let a lowercase() silently miss.
  var LITERAL_DIRS = { VICTORY_BANNER: 'victory-banner', DEFEAT_BANNER: 'defeat-banner' };
  function lottiePath(name, typeSlug) {
    var dir = LITERAL_DIRS[name] || String(name).toLowerCase();
    return PER_TYPE[dir] && typeSlug
      ? 'lottie/' + dir + '/' + typeSlug + '/data.json'
      : 'lottie/' + dir + '/data.json';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Window scope
  // ══════════════════════════════════════════════════════════════════════════

  var params = (function () {
    var out = {};
    (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      out[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return out;
  })();

  var TARGET = params.planet
    ? { kind: 'planet', id: params.planet }
    : (params.fleet ? { kind: 'fleet', id: params.fleet } : null);

  // Every DOM id is prefixed with this. Two windows on the SAME planet is a
  // supported case, and unprefixed struct ids are precisely why the game's own
  // component could not be reused.
  var SCOPE = 'rv-' + (TARGET ? TARGET.kind + '-' + TARGET.id : 'none') + '-';
  function domId(kind, id) { return SCOPE + kind + '-' + String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }

  var state = {
    snapshot: null,
    generation: 0,
    structsById: {},
    // Live health overrides arriving from the stream ahead of the next
    // snapshot. Cleared when a snapshot for the same generation lands.
    liveHealth: {},
    lastEventMs: 0,
    /// Struct whose readout is open, if any. Survives rebuilds.
    selectedId: null,
    /// Empty tile whose readout is open — `{key, icon, label, side}`. Mutually
    /// exclusive with `selectedId`, as on the game's own map.
    selectedTile: null,
    /// Capability record per struct type id, from the snapshot. Drives the
    /// Action Chunk's properties screen and ability buttons.
    structTypes: {},
    planetaryShield: 0,
    raidStatus: null,
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Grid
  // ══════════════════════════════════════════════════════════════════════════

  /* How many planetary columns this planet needs — the game's
   * calcColsNeededBySlots: ceil(max slots per ambit / rows), floored at the
   * default 2 (MAP_DEFAULT_PLANETARY_COL_COUNT). */
  function planetaryColCount(slots) {
    var most = 0;
    AMBITS.forEach(function (a) { most = Math.max(most, Number((slots || {})[a] || 0)); });
    return Math.max(DEFAULT_COL_COUNTS[COL.DEF_PLAN], Math.ceil(most / ROWS_PER_AMBIT));
  }

  /* The flat list of column types, left to right.
   *
   * We always render the PLANET OWNER's view (`planetOwnerView = true` in
   * MapTerrainComponent). A spectator belongs to neither side, and the planet
   * is the subject of the window, so showing it as its owner sees it is the
   * least confusing choice — defenders left, raiders right. */
  function buildColumns(slots) {
    var counts = Object.assign({}, DEFAULT_COL_COUNTS);
    counts[COL.DEF_PLAN] = planetaryColCount(slots);
    var cols = [];
    COL_ORDER.forEach(function (type) {
      for (var i = 0; i < counts[type]; i++) cols.push(type);
    });
    return cols;
  }

  /* Which slot number a cell represents — the game's calcSlotNumber.
   *
   * Slots run RIGHT TO LEFT within their column block in the owner's view
   * (the left-to-right branch applies only when the board is mirrored for the
   * attacker, which we never do). `row` is the row WITHIN the ambit, not the
   * row within the whole map. */
  function slotAt(cols, colType, row, colIndex) {
    var first = cols.indexOf(colType);
    if (first < 0) return null;
    var last = cols.lastIndexOf(colType);
    var perRow = (last - first) + 1;
    return (last - colIndex) + row * perRow;
  }

  /* The cell-anchor key a struct mounts at. Three separate slot-spaces:
   * command (one per side PER AMBIT, always slot 0 — GenericMapLayerComponent
   * "Command structs are always slot 0 in a fleet"), planetary, and fleet. */
  function anchorKeyFor(s) {
    if (s.is_command) return 'cmd|' + s.side + '|' + s.ambit;
    if (s.category === 'planet') return 'plan|' + s.ambit + '|' + s.slot;
    return 'fleet|' + s.side + '|' + s.ambit + '|' + s.slot;
  }

  /* Which column block a struct belongs in — kept for the harness. */
  function colTypeFor(s) {
    if (s.category === 'planet') return COL.DEF_PLAN;
    if (s.is_command) return s.side === 'defender' ? COL.DEF_CMD : COL.ATK_CMD;
    return s.side === 'defender' ? COL.DEF_FLEET : COL.ATK_FLEET;
  }

  /* ── The board, built the way MapComponent builds it ─────────────────────
   *
   * The game stacks seven full-size layers (terrain, ornaments, markers,
   * structs, HUD, fog, selection). We collapse that into one flow of rows
   * where each CELL stacks its own layers — same visual result, and the
   * per-window DOM scoping the game's layers cannot give us. The row model
   * is transcribed exactly:
   *
   *   edge-top(space)                        ← transition row
   *   space ×2                               ← band rows
   *   edge-bottom(space) ⊕ edge-top(air)     ← transition row (layers STACK)
   *   air ×2
   *   edge-bottom(air) ⊕ HORIZON ⊕ edge-top(land)
   *   land ×2
   *   edge-bottom(land) ⊕ edge-top(water)
   *   water ×2
   *   edge-bottom(water)
   *
   * Terrain is CONTINUOUS across all nine columns — the divider is an empty
   * column of clean terrain, not a hole (the game draws the divider only in
   * its marker/selection layers). */

  // Anchor cells for struct mounting, rebuilt with the grid.
  var anchors = {};
  // The cell element behind each anchor, so an EMPTY tile can be selected and
  // outlined. Same keys as `anchors`.
  var tileAnchors = {};

  function edgeStrip(cols, ambit, edge) {
    // edge: 'top' (V_POS 0) or 'bottom' (V_POS 4).
    var strip = el('div', 'rv-strip');
    var v = edge === 'top' ? 0 : 4;
    for (var c = 0; c < cols.length; c++) {
      var t = el('div', 'rv-tile');
      t.style.backgroundImage = 'url("' + tileUrl(ambit, v, hPosOf(c, cols.length)) + '")';
      strip.appendChild(t);
    }
    return strip;
  }

  function horizonStrip(cols) {
    var strip = el('div', 'rv-strip');
    for (var c = 0; c < cols.length; c++) {
      var h = hPosOf(c, cols.length);
      var hIndex = h === 'left' ? 1 : (h === 'right' ? 3 : 2);
      var t = el('div', 'rv-tile');
      t.style.backgroundImage = 'url("img/tiles/horizon/horizon-1-' + hIndex + '-' + h + '.png")';
      strip.appendChild(t);
    }
    return strip;
  }

  function hPosOf(colIndex, colCount) {
    return colIndex === 0 ? 'left' : (colIndex === colCount - 1 ? 'right' : 'middle');
  }

  /* One transition row: previous ambit's edge-bottom layered OVER the next
   * ambit's edge-top (plus the horizon strip above land) — the overlap is
   * what blends the two bands; MapTransitionComponent stacks its layers
   * absolutely inside one tile-height block. */
  function transitionRow(cols, prevAmbit, nextAmbit) {
    var row = el('div', 'rv-row rv-transition');
    // Painter's order matters: the LAST child paints on top, and the builder
    // pushes topAmbit's edge first, horizon, then bottomAmbit's edge — so the
    // next ambit's edge-top ends up on top, exactly as in the game.
    if (prevAmbit) row.appendChild(edgeStrip(cols, prevAmbit, 'bottom'));
    if (nextAmbit === 'land') row.appendChild(horizonStrip(cols));
    if (nextAmbit) row.appendChild(edgeStrip(cols, nextAmbit, 'top'));
    return row;
  }

  function markerImg(cls, urls) {
    // Beacon art ships as gifs for some ambits and og-*.png stills for the
    // rest; try in order and hide when nothing exists rather than showing a
    // broken-image glyph.
    var img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    var i = 0;
    img.addEventListener('error', function () {
      i++;
      if (i < urls.length) img.src = urls[i];
      else img.style.display = 'none';
    });
    img.src = urls[0];
    return img;
  }

  function blockedMarker(ambit) {
    return markerImg('rv-marker', ['img/tiles/blocked/' + ambit + '.png']);
  }

  function beaconMarker(ambit) {
    return markerImg('rv-marker', [
      'img/tiles/beacon/' + ambit + '.gif',
      'img/tiles/beacon/og-' + ambit + '.png',
    ]);
  }

  /* Scale the board to the window. The game only integer-UPSCALES pixel art
   * (scale(2)/scale(4) at huge resolutions) and pans otherwise; a spectator
   * window instead fits the whole board: shrink continuously to fit narrow
   * windows, and on very large windows snap to INTEGER upscales so the pixel
   * art stays crisp. `zoom` rather than `transform` so the scroll box's
   * layout agrees with what is painted. */
  var boardCols = 9;

  /* ── Board zoom mode ──────────────────────────────────────────────────────
   * 'full' fits the WHOLE board — every ambit at once, which is what a
   * spectator wants when reading a position. 'zoom' is the game's own feel:
   * fit the width, upscale to whole pixels, and let the taller-than-window
   * board pan vertically. Neither is right for every moment, so it is a
   * toggle rather than a decision made for the operator.
   *
   * Persisted because it is a preference about how you like to look at a
   * board, not a property of any one raid.
   */
  var FIT_KEY = 'rv-fit-mode';
  function fitMode() {
    try { return localStorage.getItem(FIT_KEY) === 'zoom' ? 'zoom' : 'full'; }
    catch (e) { return 'full'; }
  }
  function setFitMode(m) {
    try { localStorage.setItem(FIT_KEY, m); } catch (e) {}
    syncFitToggle();
    setBoardScale({ keepCentre: true });
  }
  /* Hand what you are watching to Comms.
   *
   * Shares the id alone. Chat turns an id into a card with the live figures
   * on it, so a sentence typed here would only go stale — and the player is
   * about to add their own words anyway. */
  // ── What people have said about this planet ───────────────────────────────
  // Beside what HAPPENED to it. The battle log is the chain's account; this
  // is the guild's. Together they are the whole story of a raid.
  var chatState = { rows: [], open: false, loading: false, connected: false,
                    fresh: false,
                    sending: false, guildId: null,
                    // The built composer (node/input/send), kept so a repaint
                    // does not throw away the caret mid-sentence.
                    composer: null,
                    // The player's own portrait and name, for the composer's
                    // well and the tooltip that says who you are speaking as.
                    myPfp: null,
                    myName: null,
                    myId: null,
                    // The viewer's own charge, off the snapshot. Not derived
                    // here: `GAME_STATE.get_charge()` already computes it the
                    // way the game does, and a second opinion would disagree.
                    myCharge: null,
                    // The object's OWN room, once looked up: `{alias, room_id,
                    // can_create, joined}`. Null means not looked up yet or no
                    // such room, and both leave the panel on the search path.
                    room: null };

  /* "planet" or "fleet" — whichever this window is actually about.
   *
   * Written out three separate times before this, in the empty line and in
   * both composer placeholders, so a fleet window said "planet" wherever one
   * of them was missed. One definition, and the kind can only be wrong
   * everywhere at once.
   */
  // "Planet 2-16116" — the channel's name, and the one the room is created
  // with, so the header does not change under the player when it appears.
  function objectTitle() {
    if (!TARGET || !TARGET.id) return 'Comms';
    return objectWord().charAt(0).toUpperCase() + objectWord().slice(1)
      + ' ' + TARGET.id;
  }

  // Matches the topic `matrix_object_room_create` sets on the real room.
  function defaultTopic() {
    if (!TARGET || !TARGET.id) return '';
    return 'Everything said about ' + objectWord() + ' ' + TARGET.id + '.';
  }

  function objectWord(kind) {
    var k = kind || (TARGET && TARGET.kind);
    return k === 'fleet' ? 'fleet' : 'planet';
  }

  // Does this text name THIS object, and not one whose id merely starts the
  // same way?
  //
  // `2-1` is a prefix of `2-15361`. Substring-matching chain ids has caused
  // real misattribution in this codebase before — a whole class of bug — so
  // the id must be bounded by something that cannot continue it: not a digit,
  // not a hyphen, not a letter.
  function mentionsObject(body, id) {
    var text = String(body || '');
    var at = -1;
    for (;;) {
      at = text.indexOf(id, at + 1);
      if (at === -1) return false;
      var before = at === 0 ? '' : text.charAt(at - 1);
      var after = text.charAt(at + id.length);
      var boundedLeft = !before || !/[0-9A-Za-z-]/.test(before);
      var boundedRight = !after || !/[0-9A-Za-z-]/.test(after);
      if (boundedLeft && boundedRight) return true;
    }
  }

  function wireChat() {
    // No "open in comms" door any more: this rail IS the planet's room, and a
    // link out of it was a leftover from when it was only a digest of what
    // other rooms had said.
    // The rail is always open, so there is nothing to toggle and nothing to
    // defer: read the conversation as soon as the window has a target. The
    // room lookup comes first because it decides WHICH read happens.
    chatState.open = true;
    loadMyPfp();
    resolveRoom().then(loadChat);

    // Live, because a raid is live. The panel used to load once on open and
    // then go stale during exactly the event it exists for.
    //
    // Only messages that name THIS object: a raid window is one planet, and
    // repainting it for every message in the guild would be a busy panel
    // saying nothing.
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('matrix::timeline', function (e) {
        var p = (e && e.payload) || {};
        if (!TARGET || !p.messages) return;
        // In the object's own room, BELONGING is the test — every message
        // there is about this object whether or not it names it, which is the
        // whole point of having the room. Outside it, naming is all we have.
        var hit = inRoom() && p.room_id === chatState.room.room_id
          ? p.messages.some(function (m) { return m && !m.self; })
          : p.messages.some(function (m) {
              return m && !m.self && mentionsObject(m.body, TARGET.id);
            });
        if (!hit) return;
        loadChat();
      });
    }
  }

  /* Does this object have a room of its own, and may we speak in it?
   *
   * Asked once per window. Three answers matter and each changes the panel:
   * a room we have JOINED is read directly and needs no id in the message; a
   * room that exists but we have not joined, or does not exist and is ours to
   * make, is reachable — sending gets us in; anything else leaves the panel on
   * the search it has always used.
   */
  /* The player's own face, for the composer's portrait well.
   *
   * Comms reads it from its Matrix profile; this window has no Matrix session
   * of its own, so it asks the game for the same on-chain attributes. Absent
   * is fine — the composer draws the placeholder, which is what the action bar
   * does too.
   */
  function loadMyPfp() {
    if (!window.__TAURI__) return Promise.resolve();
    return window.__TAURI__.core.invoke('mcp_inventory', { player: 'primary' })
      .then(function (d) {
        var p = d && d.player;
        chatState.myPfp = p && p.pfp_attrs;
        chatState.myName = p && p.name;
        chatState.myId = p && p.player_id;
        // The composer may already be on screen with a placeholder in it.
        paintComposerIdentity();
      })
      .catch(function () {});
  }

  function resolveRoom() {
    if (!TARGET || !window.__TAURI__) return Promise.resolve();
    return window.__TAURI__.core.invoke('matrix_object_room', { objectId: TARGET.id })
      .then(function (res) { chatState.room = res || null; })
      // A lookup failure is not a panel failure: the search path still works.
      .catch(function () { chatState.room = null; });
  }

  /* Paint the composer's portrait with the player it will speak as.
   *
   * Separate from building the composer because the two RACE: `loadMyPfp` and
   * the room lookup that leads to the first paint are fired together in
   * `wireChat`, so the composer is routinely built before the profile lands.
   * `pfpAttrs` was read once at construction, which meant the well drew the
   * placeholder and kept it — the portrait was very often nobody. Whichever
   * of the two finishes second calls this, so the face arrives either way.
   *
   * Absent stays absent: the well's own placeholder is what the action bar
   * does too, and a tooltip claiming a name we do not have is worse than one
   * that admits it.
   */
  function paintComposerIdentity() {
    var portrait = chatState.composer && chatState.composer.portrait;
    if (!portrait) return;
    paintPfp(portrait.querySelector('.sui-screen-portrait-image'), chatState.myPfp);
    paintBattery(chatState.composer.battery, chatState.myCharge);
    portrait.setAttribute('data-sui-mod-placement', 'top');
    portrait.setAttribute('data-sui-tooltip',
      'Speaking as\n' + whoLine(chatState.myName, chatState.myId, 'your primary')
      + (chatState.myCharge == null ? '' : '\nCharge ' + fmtNum(chatState.myCharge)));
  }

  // True when the rail is reading the object's OWN room rather than searching
  // every room for its id.
  function inRoom() {
    return !!(chatState.room && chatState.room.room_id && chatState.room.joined);
  }

  function loadChat() {
    if (!TARGET || chatState.loading) return;
    if (inRoom()) return loadRoomChat();
    chatState.loading = true;
    window.__TAURI__.core.invoke('matrix_object_chatter', { objectId: TARGET.id })
      .then(function (res) {
        chatState.loading = false;
        chatState.connected = !!(res && res.connected);
        chatState.guildId = (res && res.guild_id) || null;
        chatState.rows = (res && res.hits) || [];
        syncComposer();
        renderChat();
      })
      .catch(function () {
        chatState.loading = false;
        chatState.rows = [];
        renderChat();
      });
  }

  /* Read the object's own room.
   *
   * Mapped into the same row shape the search path produces, so there is one
   * renderer and the two ways of getting messages cannot drift apart in how
   * they look.
   */
  function loadRoomChat() {
    chatState.loading = true;
    window.__TAURI__.core.invoke('matrix_timeline', {
      guildId: chatState.room.guild_id || chatState.guildId,
      roomId: chatState.room.room_id, limit: 40,
    }).then(function (res) {
      chatState.loading = false;
      chatState.connected = true;
      chatState.guildId = chatState.room.guild_id || chatState.guildId;
      var name = (res && res.room && res.room.name) || '';
      chatState.roomName = name;
      chatState.roomTopic = (res && res.room && res.room.topic) || '';
      chatState.rows = ((res && res.messages) || []).map(function (m) {
        return { message: m, room_id: chatState.room.room_id, room_name: name };
      });
      syncComposer();
      renderChat();
    }).catch(function () {
      chatState.loading = false;
      // The room went unreadable — we were removed, or it was upgraded. Fall
      // back rather than showing an empty panel that looks like silence.
      chatState.room = null;
      loadChat();
    });
  }

  function renderChat() {
    var R = window.StructsChatRow;
    var body = document.getElementById('rv-chat-body');
    var count = document.getElementById('rv-chat-count');
    var head = document.getElementById('rv-chat-head');
    if (!body) return;

    /* Say which of the two panels this is.
     *
     * Reading the object's own room and searching every room for its id look
     * identical but are not: one shows everything said in a place, the other
     * shows only what happened to name the object, and only one appends an id
     * to what you type. A player who cannot tell them apart cannot tell why
     * their message did or did not appear.
     */
    /* The channel is named after the OBJECT, always.
     *
     * It used to fall back to the word "Comms" until a room had been resolved
     * and joined — so a raid window opened on a planet nobody had spoken about
     * showed a channel called "Comms", with no topic and no composer. That is
     * every raid window, the first time. This panel has never been in doubt
     * about which planet it is, so it says so from the first paint.
     */
    /* The header carries the TOPIC, not the room's name.
     *
     * The name was "Planet 2-16116" and the map beside this panel already says
     * that, in a banner across the top of it — so the rail was repeating it and
     * spending a second line on the topic underneath. One line, and it is the
     * line that says something the map does not.
     *
     * Defaulted rather than blank before the room exists: the topic a room GETS
     * on creation is this exact sentence, so showing it early is the same text
     * one hop sooner, and nothing reshapes when somebody finally speaks.
     */
    var title = head && head.querySelector('.rv-chat-title');
    if (title) title.textContent = chatState.roomTopic || defaultTopic();
    body.textContent = '';
    if (count) {
      count.textContent = chatState.rows.length ? String(chatState.rows.length) : '';
    }

    // Comms' own notice block, not a bare line of hint text. This is the state
    // a channel is most often seen in, so it is the one that most has to look
    // like the real thing.
    if (!chatState.connected) {
      // A raid window opens whether or not Comms is signed in, and must say
      // which of "nobody spoke" and "we did not look" is true.
      body.appendChild(R.notice('Not connected',
        'Comms is not signed in, so nothing here can be read.'));
      return;
    }
    if (!chatState.rows.length) {
      // A fleet is not a planet. The rail opens on both.
      body.appendChild(R.notice('Quiet',
        'Nothing has been said about this ' + objectWord() + ' yet.'));
      return;
    }
    /* The Comms window's own row, not a lookalike.
     *
     * This panel used to build its own `.rv-chat-*` markup that approximated
     * one — a different sender treatment, no clock, no run-collapsing, and
     * room events rendered as if somebody had said "joined". `chatrow.js` is
     * the component both windows draw, so a stripped-down channel is exactly
     * that: the same rows with nothing bolted on.
     *
     * No `controls` and no `onSender`: react, reply, pin and edit belong to a
     * full timeline. A rail beside a live raid is for reading and saying one
     * thing.
     */
    var prev = null;
    chatState.rows.forEach(function (h) {
      var m = h.message || {};
      var node = R.render(m, prev, {});
      // Which room a line came from only tells you something when the lines
      // come from DIFFERENT rooms. In the object's own room every row would
      // repeat the same name; the panel title says it once instead. On the
      // search path it rides the sender line, where the clock would be.
      if (!inRoom() && h.room_name) {
        var meta = node.querySelector('.chat-msg-meta');
        if (meta) meta.insertBefore(el('span', 'rv-chat-room', h.room_name), meta.firstChild);
      }
      body.appendChild(node);
      if ((m.kind || 'text') !== 'event') prev = m;
      // The BODY is a separate node under the head, as the timeline draws it.
      if ((m.kind || 'text') !== 'event' && (m.kind || 'text') !== 'emote') {
        node.appendChild(el('div', 'chat-msg-body', m.body || ''));
      }
    });
  }

  // Which room a message from here goes to.
  //
  /* The composer: the game's own, and pointed at ONE room.
   *
   * There is no room picker any more. This rail is the planet's channel —
   * offering a list of other channels to send into was never what "discuss
   * this planet" meant, and it invited putting the conversation somewhere it
   * did not belong. If the object's room cannot be reached, the panel says so
   * rather than proposing a substitute.
   *
   * Built once and kept: rebuilding it on every repaint would throw away the
   * caret mid-sentence.
   */
  function syncComposer() {
    var box = document.getElementById('rv-chat-compose');
    var host = document.getElementById('rv-chat-entry');
    if (!box || !host) return;

    // A composer that cannot send is worse than no composer: it invites a
    // message the player will lose.
    var usable = chatState.connected && reachableRoom();
    box.classList.toggle('hidden', !usable);
    if (!usable) return;

    if (!chatState.composer) {
      chatState.composer = window.StructsChatRow.composer({
        inputId: 'rv-chat-input',
        sendId: 'rv-chat-send',
        pfpAttrs: chatState.myPfp,
        battery: true,
        maxLength: 900,
      });
      host.appendChild(chatState.composer.node);
      /* Who you are speaking as, in this window's own idiom.
       *
       * The two portraits above this one are the defender and the raider, and
       * each says who it is on hover (`renderSide`). The third portrait is
       * you, and it said nothing — so the rail was the one place in the app
       * you speak from with no name on screen at all. Same attribute, same
       * placement, same shape of text. */
      paintComposerIdentity();
      chatState.composer.send.addEventListener('click', sendChat);
      chatState.composer.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
      });
    }
    // Just "Message", as Comms says. The longer form ("— this opens the planet
    // room") did not fit the rail and truncated to "Message —", which reads as
    // a bug; and the topic above already says what this channel is.
    chatState.composer.input.placeholder = 'Message';
  }

  function sendChat() {
    var input = chatState.composer && chatState.composer.input;
    var err = document.getElementById('rv-chat-error');
    if (!input || chatState.sending) return;
    var text = input.value.trim();
    if (!text || !reachableRoom()) return;

    /* A leading slash means the same things it means in Comms.
     *
     * Not because this rail has commands — it has none — but because the rail
     * must not turn a typed command into a message posted to the guild. Comms
     * answers `/foo` with "unknown command"; a rail that simply sent it would
     * publish the mistake.
     *
     * The two rules that DO carry over are Comms' own, in its order: `//`
     * escapes to a literal slash, and `/me` is an emote. The escape has to be
     * checked first — it exists so that someone who wants to say "/me waves"
     * literally can, and a rail that read `//me` as an emote would defeat the
     * very thing they reached for.
     *
     * Deliberately NOT pushed down into `matrix_send`, which is where the
     * mention fallback went: Comms strips `/me` itself and sends the remainder,
     * so a server-side re-parse would turn an escaped `//me waves` — which
     * arrives as the plain body `/me waves` — back into the emote the player
     * escaped to avoid.
     */
    var msgtype = null;
    if (text.indexOf('//') === 0) {
      text = text.slice(1);
    } else if (text.charAt(0) === '/') {
      var m = /^\/me\s+([\s\S]+)$/.exec(text);
      if (m) {
        text = m[1];
        msgtype = 'm.emote';
      } else {
        if (err) err.textContent = 'Commands live in Comms — this sends messages.';
        return;
      }
    }

    /* No id is appended, because there is nowhere else for the message to go.
     *
     * The rail used to tag outgoing text with the object id: it read by
     * SEARCHING every room, so a message that did not name the planet was sent
     * successfully and then never appeared in the panel that sent it. With one
     * destination that whole problem is gone — the message belongs by virtue
     * of where it was sent, and an appended id would be noise nobody typed.
     *
     * The tagging branch is not merely unused, it is unreachable: `sendChat`
     * returns above when there is no room to reach.
     */
    chatState.sending = true;
    if (err) err.textContent = '';

    // Speaking is what joins you. A room the player never said anything in is
    // not a room they wanted, so the membership is bought at the moment they
    // show they want it — not when the window happened to open.
    var ready = inRoom() || !reachableRoom()
      ? Promise.resolve()
      : window.__TAURI__.core.invoke('matrix_object_room_create', { objectId: TARGET.id })
          .then(function (res) {
            chatState.room = Object.assign({}, chatState.room, res, { joined: true });
          });

    ready.then(function () {
      // One destination: the object's own room. `ready` above has just
      // joined or created it, so `inRoom()` is true by here.
      var target = chatState.room && chatState.room.room_id;
      if (!target) throw new Error('no room to send to');
      return window.__TAURI__.core.invoke('matrix_send', {
        guildId: chatState.guildId, roomId: target, body: text, msgtype: msgtype,
      });
    }).then(function () {
      chatState.sending = false;
      input.value = '';
      chatState.loading = false;
      if (inRoom()) {
        // A real room echoes the message straight back through sync, so there
        // is nothing to wait for.
        syncComposer();
        loadChat();
      } else {
        // The search path is different: a just-sent message is not indexed the
        // instant it lands, so re-reading now would show nothing new and read
        // as a failed send. Deferred one beat.
        setTimeout(function () { chatState.loading = false; loadChat(); }, 1200);
      }
    }).catch(function (e) {
      chatState.sending = false;
      if (err) err.textContent = String(e).slice(0, 120);
    });
  }

  // A room we could be speaking in after one join — either it exists and we
  // have not joined, or it does not exist and it is ours to create.
  function reachableRoom() {
    var r = chatState.room;
    return !!(r && (r.joined || r.room_id || r.can_create));
  }

  // The composer builds and wires itself in `syncComposer`, once it has a room
  // to send to. All that is left here is the one thing that is about THIS
  // window rather than about a composer: the map reads arrow keys and letters
  // as controls, so a composer that steers the board while you type is
  // unusable. Keys stop at the rail.
  function wireComposer() {
    var host = document.getElementById('rv-chat-entry');
    if (host) host.addEventListener('keydown', function (e) { e.stopPropagation(); });
  }

  function syncFitToggle() {
    var a = document.getElementById('rv-fit-toggle');
    if (a) a.textContent = fitMode() === 'full' ? 'zoom in' : 'fit all';
  }

  /* Refit whenever the board's viewport changes size, whatever caused it —
   * the window resizing, the battle log opening, a future panel. A
   * ResizeObserver reports the size AFTER layout, which is the one thing the
   * click handlers could not know: they fire before the panel they toggled has
   * taken its new height.
   *
   * Safe against feedback: this watches the SCROLL BOX, whose size comes from
   * the flex layout, while a refit only changes the map's zoom inside it.
   */
  var boardObserver = null;
  var boardPositioned = false;
  function observeBoardViewport() {
    var sc = document.getElementById('rv-scroll');
    if (!sc || boardObserver || typeof ResizeObserver === 'undefined') return;
    var queued = false;
    boardObserver = new ResizeObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        setBoardScale({ keepCentre: true });
      });
    });
    boardObserver.observe(sc);
  }

  function setBoardScale(opts) {
    var map = document.getElementById('rv-map');
    var sc = document.getElementById('rv-scroll');
    if (!map || !sc) return;
    var avail = (sc.clientWidth || 0) - 36; // padding + the ambit band gutter
    if (avail <= 0) return;                 // not laid out yet (or headless)
    var w = boardCols * 128;
    var scale = avail / w;

    // Where the reader is looking, as a fraction of the board on each axis — so
    // a change of zoom keeps the same rows under the eye instead of snapping to
    // the top (which on this board means the empty space ambit). Now that
    // 'zoom' snaps UP and overflows horizontally too, the x axis matters as
    // much as the y: without it, switching modes slams the view to the left
    // edge and hides the columns you were reading.
    // The FIRST fit centres the board. Left to itself the scroll box opens at
    // 0,0 — which on this board is the corner of the empty space ambit, the
    // one region with nothing in it. In 'zoom' the board is larger than the
    // viewport on both axes, so that corner is all you would see.
    var centre = null;
    // Gate on the grid EXISTING: `setBoardScale` also runs before the first
    // snapshot builds any rows, and consuming the flag on that empty pass left
    // the real board opening at 0,0 anyway.
    if (!boardPositioned && map.querySelectorAll('.rv-row').length > 0) {
      boardPositioned = true;
      centre = { x: 0.5, y: 0.5 };
    } else if (opts && opts.keepCentre) {
      centre = {
        y: sc.scrollHeight > sc.clientHeight
          ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0.5,
        x: sc.scrollWidth > sc.clientWidth
          ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0.5,
      };
    }

    // ── Fit the HEIGHT too, in 'full' mode ────────────────────────────────
    // The original fitted width only, and a board is 13 rows — 1,664px — tall.
    // In any normally-proportioned window (1280x720: 1,244px of width, 689px of
    // height) the width fit returned 1, and everything below the space ambit
    // fell off the bottom. The container does scroll, but nothing said so, and
    // the ambit a raid is ABOUT — land, where the ore bunkers and the extractor
    // sit — was the part you could not see.
    //
    // 'zoom' does NOT fit at all — see quantiseScale: it snaps up to a whole
    // multiple and pans, which is what the game itself does.
    if (fitMode() === 'full') {
      // The usable band, MEASURED rather than derived from clientHeight minus
      // guesses. The collapsed log bar floats over the board (so the map gets
      // the full window height), and the scroll box carries its own vertical
      // padding — subtracting a flat 8px for one and the bar's height for the
      // other still left the last row 5px behind the bar, in the one mode
      // whose whole job is showing every row.
      //
      // The gap between the scroll box's top edge and whatever bounds the
      // bottom accounts for both at once, whatever their values.
      // The scroll box's CONTENT height — its client box less its own padding.
      // Every earlier attempt measured around this (clientHeight minus a
      // guessed 8px; the gap to the bar; the distance from the board's top) and
      // each missed one of the two 16px paddings, leaving the last row clipped
      // by a few pixels. The padding is the thing actually in the way, so read
      // it rather than infer it.
      var cs = getComputedStyle(sc);
      var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var availH = Math.max(0, (sc.clientHeight || 0) - padY);
      if (availH > 0) {
        // Natural height DERIVED, not measured. The obvious approach — set
        // zoom to 1, read scrollHeight, put it back — does not work here:
        // WebKit relayouts `zoom` asynchronously, so the read returns the
        // still-zoomed height and the fit comes out far too large (measured:
        // 0.43 where 0.27 was needed, leaving 303px hanging behind the log).
        //
        // Rows are a whole number of 128px tiles, exactly like the columns the
        // width fit already counts, so the height is arithmetic.
        var rows = map.querySelectorAll('.rv-row').length;
        var naturalH = rows * 128;
        if (naturalH > 0) scale = Math.min(scale, availH / naturalH);
      }
    }

    scale = quantiseScale(scale, fitMode() === 'zoom');
    map.style.zoom = scale;

    // ── Correct, don't guess ───────────────────────────────────────────────
    // The height fit has to allow for chrome the map does not own — the log
    // bar, row padding, the ambit gutter — and a hard-coded allowance is a
    // guess that was wrong by 23px, leaving the bottom of the water ambit
    // clipped in the very mode whose job is to show everything. Measure what
    // actually overflowed and shrink by exactly that ratio, once.
    if (fitMode() === 'full' && sc.scrollHeight > sc.clientHeight && sc.scrollHeight > 0) {
      var corrected = quantiseScale(scale * (sc.clientHeight / sc.scrollHeight), false);
      if (corrected > 0 && corrected < scale) {
        scale = corrected;
        map.style.zoom = scale;
      }
    }

    if (centre != null) {
      // After the reflow the scrollable extent has changed; put the same
      // fraction of the board back under the middle of the viewport.
      var restore = function () {
        var top = centre.y * sc.scrollHeight - sc.clientHeight / 2;
        var left = centre.x * sc.scrollWidth - sc.clientWidth / 2;
        sc.scrollTop = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, top));
        sc.scrollLeft = Math.max(0, Math.min(sc.scrollWidth - sc.clientWidth, left));
      };
      restore();
      // `zoom` relayouts asynchronously in WebKit, so the first read can be of
      // the OLD extent; settle on the next frame.
      if (window.requestAnimationFrame) window.requestAnimationFrame(restore);
    }
  }

  /* Snap a raw scale to something that paints cleanly.
   *
   * `fill` = 'zoom' mode: snap UP to a whole multiple and let the board pan.
   * This is the game's own behaviour (its CSS jumps to scale(2), then scale(4),
   * and pans) and it is the only way to both fill the window and keep pixel art
   * sharp. Two wrong turns got here:
   *
   *   · floor to an integer — 1.53 became 1, stranding a 1,152px board in an
   *     1,800px window with 36% of the width as black bars;
   *   · take the fraction — filled the window, but 1.53x resamples every sprite
   *     onto a non-integer pixel grid, which is exactly the blur pixel art is
   *     drawn to avoid.
   *
   * Snapping UP (ceil) does neither: 1.53 becomes 2, the board is larger than
   * the viewport, and the overflow pans. No bars, no resampling.
   *
   * SHRINKING is different — below 1x there is no whole multiple to snap to, so
   * the fraction is quantised to make one tile a whole number of DEVICE pixels,
   * which is what stops seams appearing between tiles. */
  function quantiseScale(scale, fill) {
    if (fill) {
      return Math.max(1, Math.ceil(scale));                   // whole multiples, pan the rest
    }
    if (scale >= 1) {
      return Math.max(1, Math.floor(scale));                  // crisp integers up
    } else {
      // Shrinking needs a fraction, but an ARBITRARY fraction paints hairlines
      // between tiles: at zoom 0.75434 a 128px cell becomes 96.555px, so cell
      // boundaries land mid-device-pixel and each box antialiases its own edge
      // against the next. The cells meet exactly in layout (measured gap: 0) —
      // the seam is pure rasterisation, which is why only SOME boundaries show
      // one, depending where each lands in the pixel grid.
      //
      // Quantise so one tile is a whole number of DEVICE pixels; every boundary
      // then falls on the grid and no edge needs blending. Floor rather than
      // round so the board can never grow past the space measured for it.
      var dpr = window.devicePixelRatio || 1;
      var tileDevicePx = Math.max(1, Math.floor(128 * scale * dpr));
      return Math.max(0.2, tileDevicePx / (128 * dpr));
    }
    // (unreachable — both branches return)
    // The board's left edge can still land on a half device pixel, because
    // `margin: 0 auto` centres on whatever space is left over. That is fine:
    // it offsets every boundary by the SAME fraction, so the tiles stay in
    // phase with each other and the seam is uniform rather than appearing at
    // scattered boundaries. Correcting it via margin was tried and is worse —
    // an explicit margin-left cancels the auto centring and slams the board
    // against the padding edge.
  }

  /* Build the whole board for a snapshot. Returns the anchor map. */
  function buildGrid(snap) {
    var cols = buildColumns(snap.slots);
    var map = document.getElementById('rv-map');
    map.innerHTML = '';
    anchors = {};
    tileAnchors = {};

    var slots = snap.slots || {};
    // A missing count means the backend could not read it — treat as the full
    // drawn capacity rather than zero, or every planetary cell would render
    // blocked. An explicit 0 stays 0 (that ambit has no slots).
    function slotsFor(a) {
      var v = slots[a];
      return v == null ? ROWS_PER_AMBIT * DEFAULT_COL_COUNTS[COL.DEF_PLAN] : Number(v);
    }
    var prevAmbit = '';
    var ambits = AMBITS.filter(function (a) {
      // The game maps only ambits with slots; every current planet has all
      // four, but a zero-slot ambit must not draw an empty band.
      return slotsFor(a) > 0;
    });

    ambits.forEach(function (ambit) {
      map.appendChild(transitionRow(cols, prevAmbit, ambit));
      prevAmbit = ambit;

      for (var r = 0; r < ROWS_PER_AMBIT; r++) {
        var rowNode = el('div', 'rv-row');
        if (r === 0) {
          var band = el('div', 'rv-band');
          band.appendChild(el('span', 'sui-text-label', ambit));
          rowNode.appendChild(band);
        }
        for (var c = 0; c < cols.length; c++) {
          rowNode.appendChild(cell(cols, slotsFor, ambit, r, c));
        }
        map.appendChild(rowNode);
      }
    });
    map.appendChild(transitionRow(cols, prevAmbit, ''));
    boardCols = cols.length;
    renderFogOfWar(cols);
    setBoardScale();
    return anchors;
  }

  /* FOG OF WAR — the game's `MapFogOfWarComponent`, same condition and same
   * art. It covers everything from the DIVIDER to the right edge whenever
   * there is no attacker present (`shouldDisplayFogOfWar()`: no attacker and a
   * defender perspective). Without it an idle planet reads as though the
   * attacker half were simply empty, when in fact the game hides it.
   *
   * Drawn as a sibling overlay inside #rv-map so it scales with the board's
   * own zoom and needs no per-row participation. */
  function renderFogOfWar(cols) {
    var map = document.getElementById('rv-map');
    if (!map) return;
    var existing = map.querySelector('.rv-fog');
    if (existing) existing.remove();

    var raiding = (state.snapshot && state.snapshot.raiding_fleet) || state.raidingFleet;
    if (raiding) return;                        // an attacker is here: no fog

    var dividerIndex = cols.indexOf(COL.DIVIDER);
    if (dividerIndex < 0) return;
    var fog = el('div', 'rv-fog');
    fog.style.left = (dividerIndex * 128) + 'px';
    fog.style.width = ((cols.length - dividerIndex) * 128) + 'px';
    var edge = el('div', 'rv-fog-edge');
    var body = el('div', 'rv-fog-body');
    fog.appendChild(edge);
    fog.appendChild(body);
    map.appendChild(fog);
  }

  /** A slot the planet does not have. Selectable like any other tile — the
   * game gives it its own tile type and the `icon-blocked` property icon —
   * but it never anchors a struct. */
  function blockedCell(n, key, ambit, side) {
    tileAnchors[key] = n;
    n.addEventListener('click', function () {
      selectTile({ key: key, icon: TILE_ICON.BLOCKED, label: ambit, side: side });
    });
    return n;
  }

  function cell(cols, slotsFor, ambit, row, colIndex) {
    var colType = cols[colIndex];
    var n = el('div', 'rv-cell');

    // Terrain everywhere, divider included — continuity is the point.
    n.style.backgroundColor = AMBIT_BG[ambit] || 'transparent';
    n.style.backgroundImage = 'url("' + tileUrl(ambit, row === 0 ? 1 : 3, hPosOf(colIndex, cols.length)) + '")';

    if (colType === COL.DIVIDER) return n;

    var side = colIndex < cols.indexOf(COL.DIVIDER) ? 'defender' : 'attacker';
    var key = null;
    var tileIcon = null;

    if (colType === COL.DEF_CMD || colType === COL.ATK_CMD) {
      // One usable command slot per side per ambit (always slot 0); the
      // second row is blocked, exactly as createCommandSlotTracker deals it.
      if (row === 0) {
        key = 'cmd|' + side + '|' + ambit;
        tileIcon = TILE_ICON.COMMAND;
      } else {
        n.appendChild(blockedMarker(ambit));
        return blockedCell(n, 'cmdblk|' + side + '|' + ambit, ambit, side);
      }
    } else if (colType === COL.DEF_PLAN) {
      var pslot = slotAt(cols, COL.DEF_PLAN, row, colIndex);
      if (pslot >= slotsFor(ambit)) {
        n.appendChild(blockedMarker(ambit));
        return blockedCell(n, 'planblk|' + ambit + '|' + pslot, ambit, side);
      }
      key = 'plan|' + ambit + '|' + pslot;
      tileIcon = TILE_ICON.PLANETARY_SLOT;
      // The beacon renders whether or not the slot is occupied — the game's
      // marker layer never consults occupancy, and the struct simply draws
      // over it. That IS the platform a water struct appears to stand on.
      n.appendChild(beaconMarker(ambit));
    } else {
      var fslot = slotAt(cols, colType, row, colIndex);
      key = 'fleet|' + side + '|' + ambit + '|' + fslot;
      tileIcon = TILE_ICON.FLEET;
    }

    // The attacker's half is the enemy's ground; the game swaps in the
    // enemy-territory icon for it (`getPropertyIconForTileType`, align right).
    if (side === 'attacker') tileIcon = TILE_ICON.ENEMY_TERRITORY;

    // The mount a struct renders into. Right-side mounts are mirrored so
    // raiders face the planet (.map-struct-layer-tile.mod-side-right).
    var mount = el('div', 'rv-mount' + (side === 'attacker' ? ' rv-flip' : ''));
    n.appendChild(mount);
    anchors[key] = mount;
    tileAnchors[key] = n;

    // Selecting the EMPTY tile. A struct's own mount stops the event before it
    // reaches here, so an occupied tile still selects the struct.
    n.addEventListener('click', function () {
      selectTile({ key: key, icon: tileIcon, label: ambit, side: side });
    });
    return n;
  }

  /* Mount every struct into its anchor. Returns how many had nowhere to go
   * (e.g. a third attacker command ship in one ambit — the game's own board
   * cannot seat that either). */
  function placeStructs(structs) {
    var unplaced = 0;
    (structs || []).forEach(function (s) {
      var mount = anchors[anchorKeyFor(s)];
      if (!mount) { unplaced++; return; }
      if (mount.childNodes.length) { unplaced++; return; } // seat taken
      mount.appendChild(structNode(s));
      // Selecting a struct opens its readout. The game's tile-selection layer
      // exists to choose a target for an ACTION; here the same gesture is
      // worth keeping for the INFORMATION it surfaces — what this thing is,
      // how hurt it is, whether it is online — which a spectator otherwise
      // has no way to ask for.
      mount.addEventListener('click', function (e) {
        // Beat the cell's empty-tile handler underneath.
        e.stopPropagation();
        selectStruct(s.id);
      });
    });
    // A rebuild replaces every mount, so re-apply the ring to whatever is
    // still selected rather than silently dropping the selection.
    if (state.selectedId) applySelection(state.selectedId);
    return unplaced;
  }

  /* ── Status indicators ─────────────────────────────────────────────────
   * Which icons a unit shows is FOCUS-DEPENDENT. From the Structs Design
   * System, "Unit Tile → Status Indicators":
   *
   *   Defended  — with nothing in focus, show on every defended unit;
   *               with a unit in focus, only on the unit the SELECTION guards.
   *   Defender  — with nothing in focus, show on every defending unit;
   *               with a unit in focus, only on the unit guarding the SELECTION.
   *   Destroyed — only when that tile is in focus.
   *   Stealth   — friendly: always. (Enemy visibility depends on what the
   *               selected unit can see, which a spectator cannot compute, so
   *               hidden enemies keep the half-opacity treatment instead.)
   *
   * The same document adds: "Reaction indicators supersede status indicators.
   * Status indicators should be hidden when a reaction indicator is active" —
   * so nothing is drawn while a combat animation is playing.
   */
  /** Ids of the structs currently guarding `s` — the game's
   * `Struct.defending_struct_ids`, which it gets from the API and we derive
   * from the inverse relation we already carry (`protects`). */
  function defendersOf(s) {
    var out = [];
    if (!s) return out;
    Object.keys(state.structsById).forEach(function (id) {
      if (state.structsById[id].protects === s.id) out.push(id);
    });
    return out;
  }

  /** Which indicators may show on `s` given the current selection.
   *
   * Ported from `MapStructHUDLayerComponent.getVisibleStatusIndicators`
   * (structs-webapp `8c4e0149`, "Contextual status indicators based on struct
   * selection"). With nothing selected — or on the selected struct itself —
   * everything shows. On every OTHER struct, a selection suppresses the
   * self-describing indicators (destroyed, offline) and leaves only the two
   * that describe a RELATIONSHIP TO THE SELECTION:
   *
   *   defended  → the struct the selection is guarding
   *   defending → the structs that are guarding the selection
   *
   * so picking a unit turns the board into a diagram of its defence web
   * instead of a wall of unrelated badges. */
  function visibleIndicators(s, sel) {
    if (!sel || s.id === sel.id) {
      return { destroyed: true, offline: true, defended: true, defending: true };
    }
    return {
      destroyed: false,
      offline: false,
      defended: s.id === sel.protects,
      defending: defendersOf(sel).indexOf(s.id) >= 0
    };
  }

  function badgesFor(s) {
    if (playing) return [];                       // a reaction supersedes these
    var sel = state.selectedId ? state.structsById[state.selectedId] : null;
    var vis = visibleIndicators(s, sel);
    var out = [];
    // Each indicator is contextual visibility AND the struct's own state, in
    // the game's own order and with its own predicates: destroyed wins over
    // everything, offline additionally requires the struct to be BUILT, and
    // both defence icons are suppressed on wreckage.
    if (vis.destroyed && s.destroyed) out.push('sui-icon-destroyed');
    // The game splits two conditions we used to conflate: energy-deactivated
    // = this struct is switched off; no-power = the OWNER's whole grid is
    // overloaded. A spectator can't read a foreign player's power budget, so
    // only the first is shown (the game's own icon for exactly this state).
    if (vis.offline && !s.destroyed && s.built !== false && s.online === false) {
      out.push('sui-icon-energy-deactivated');
    }
    if (vis.defended && !s.destroyed && s.defended) out.push('sui-icon-defended');
    if (vis.defending && !s.destroyed && !!s.protects) out.push('sui-icon-defending');
    // No stealth badge: the game's indicator layer has only these four, and a
    // hidden struct is already shown at half opacity (`.rv-stealth`), which is
    // how the real client says it.
    return out;
  }

  function paintBadges(s) {
    var host = document.getElementById(domId('badges', s.id));
    if (!host) return;
    host.innerHTML = '';
    badgesFor(s).forEach(function (cls) {
      host.appendChild(el('i', 'sui-icon ' + cls + ' sui-icon-sm'));
    });
  }

  /** Repaint every tile's indicators — focus changed, or a sequence ended. */
  function repaintAllBadges() {
    Object.keys(state.structsById).forEach(function (id) {
      paintBadges(state.structsById[id]);
    });
  }

  /* ── Defence web overlay ──────────────────────────────────────────────────
   * The game expresses defend relations as paired badges gated on selection;
   * we keep that, and additionally DRAW the web: select a struct and lines
   * connect it to its defenders and to the struct it protects. Spectators
   * read a defence layout at a glance instead of hunting badge pairs.
   *
   * The SVG lives INSIDE #rv-map, so it inherits the board zoom and its
   * coordinates are plain layout pixels — no rescale on zoom or scroll. It is
   * rebuilt on selection change and after every grid rebuild (applySelection
   * runs in both paths). */
  function tileCenter(structId, map) {
    var node = document.getElementById(domId('slot', structId));
    // Membership by contains(), not by requiring the offsetParent walk to end
    // at the map: the map IS an offsetParent ancestor in a real browser
    // (position:relative), but jsdom has no layout and its chain is null —
    // this way the overlay stays assertable in the harness.
    if (!node || !map.contains(node)) return null;
    var x = node.offsetWidth / 2, y = node.offsetHeight / 2;
    var n = node;
    while (n && n !== map) {
      x += n.offsetLeft; y += n.offsetTop;
      n = n.offsetParent;
    }
    return { x: x, y: y };
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function renderDefendWeb(s) {
    var old = document.getElementById('rv-defweb');
    if (old) old.remove();
    if (!s || s.destroyed) return;
    var map = document.getElementById('rv-map');
    if (!map) return;
    var links = [];
    defendersOf(s).forEach(function (id) {
      links.push({ from: id, to: s.id });        // defenders → selected
    });
    if (s.protects && state.structsById[s.protects]) {
      links.push({ from: s.id, to: s.protects }); // selected → its ward
    }
    if (!links.length) return;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'rv-defweb');
    svg.setAttribute('class', 'rv-defweb' + (s.side === 'attacker' ? ' rv-defweb-enemy' : ''));
    svg.setAttribute('width', map.scrollWidth);
    svg.setAttribute('height', map.scrollHeight);
    links.forEach(function (l) {
      var a = tileCenter(l.from, map), b = tileCenter(l.to, map);
      if (!a || !b) return;
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      svg.appendChild(line);
      // A dot marks the DEFENDING end, so direction reads without arrowheads.
      var dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', a.x); dot.setAttribute('cy', a.y);
      dot.setAttribute('r', 5);
      svg.appendChild(dot);
    });
    if (svg.childNodes.length) map.appendChild(svg);
  }

  /* ── Selection ─────────────────────────────────────────────────────────── */

  function selectStruct(id) {
    state.selectedTile = null;
    state.selectedId = (state.selectedId === id) ? null : id;  // click again to clear
    applySelection(state.selectedId);
  }

  /** An EMPTY tile is selectable too — the Design System's Action Chunk has a
   * documented empty-tile form ("LAND", the tile-type icon, no button group),
   * and without it half the board is inert to the pointer in a way the game's
   * map is not. `info` is `{key, icon, label, side}`. */
  function selectTile(info) {
    state.selectedId = null;
    var same = state.selectedTile && state.selectedTile.key === info.key;
    state.selectedTile = same ? null : info;
    applySelection(null);
  }

  function applySelection(id) {
    // Clear any previous ring.
    var old = document.querySelectorAll('.rv-focus-ring');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var oldTile = document.querySelectorAll('.rv-cell.rv-tile-selected');
    for (var t = 0; t < oldTile.length; t++) {
      oldTile[t].classList.remove('rv-tile-selected', 'rv-enemy-side');
    }

    var s = id ? state.structsById[id] : null;
    renderDefendWeb(s);
    if (!s) {
      state.selectedId = null;
      repaintAllBadges();
      var tile = state.selectedTile;
      if (!tile) {
        showInfo('def', null);
        showInfo('atk', null);
        return;
      }
      var cellNode = tileAnchors[tile.key];
      if (cellNode) {
        cellNode.classList.add('rv-tile-selected');
        if (tile.side === 'attacker') cellNode.classList.add('rv-enemy-side');
      }
      var tside = tile.side === 'attacker' ? 'atk' : 'def';
      showInfo(tside, { tile: tile });
      showInfo(tside === 'def' ? 'atk' : 'def', null);
      return;
    }
    var wrap = document.getElementById(domId('slot', id));
    if (wrap) {
      var ring = el('div', 'rv-focus-ring '
        + (s.side === 'attacker' ? 'rv-enemy' : 'rv-friendly'));
      wrap.appendChild(ring);
    }
    // Indicator visibility is focus-dependent, so a selection change rewrites
    // every tile's icons, not just this one's.
    repaintAllBadges();
    // The readout appears on the side that owns the struct, which is where a
    // player's own HUD would show it.
    var side = s.side === 'attacker' ? 'atk' : 'def';
    showInfo(side, { struct: s });
    showInfo(side === 'def' ? 'atk' : 'def', null);
  }

  /* ── Action Bar ──────────────────────────────────────────────────────────
     Structs Design System, "Action Bar" (Figma 3815-187846):

       Action Bar  = Player Chunk + connector + Action Chunk, and the
                     connector and Action Chunk are HIDDEN when no tile is
                     selected. The Enemy style mirrors the order — Action
                     Chunk first, Player Chunk last — which is why the two
                     bars in raidview.html are built the way they are.
       Action Chunk = a header screen naming the selection, then a bottom row
                     of: Power Switch group · properties screen · button group.
       Power Switch = shown only when the tile holds a Struct, and NEVER in
                     the Enemy style.
       Button Group = present only when the Struct has actionable abilities.

     Every class below is the shipped `ActionBarComponent`'s, so sui.css
     styles this the same way it styles the game's own bar — including the
     decorative slivers, which the Design System requires on both groups and
     which sui.css already paints as their backgrounds.

     The buttons are deliberately inert: a spectator takes no actions, so they
     render in the `disabled` state rather than being omitted (the bar's shape
     is itself information — it says what this Struct can do). */

  /** STRUCT_EQUIPMENT_ICON_MAP, verbatim from the game's StructConstants. */
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

  /** MAP_TILE_TYPE_ICONS, for the empty-tile case the spec calls out. */
  var TILE_ICON = {
    COMMAND: 'icon-cmd-post',
    PLANETARY_SLOT: 'icon-beacon',
    FLEET: 'icon-fleet-tile',
    BLOCKED: 'icon-blocked',
    ENEMY_TERRITORY: 'icon-enemy-tile'
  };

  /** The chain spells "this slot is empty" as `noUnitDefenses`,
   * `noPlanetaryDefense`, … — a `no` prefix on the capability's own name. */
  function equipped(v) { return !!v && !/^no[A-Z]/.test(v); }

  /** The struct type record for a struct, or null if the catalogue read that
   * fills it hasn't landed. Everything downstream degrades to a bare header. */
  function typeOf(s) {
    return (state.structTypes && state.structTypes[String(s.type_id)]) || null;
  }

  /** `<a>` wrapper the game uses inside the properties screen.
   *
   * The dataset IS the Cheatsheet's dispatch: `data-sui-cheatsheet` picks the
   * sheet, `data-selected-property` narrows it to one ability, `data-struct`
   * names the Struct whose type record to read. Same three attributes the
   * game's own ActionBarComponent writes. */
  function propIcon(iconClass, opts) {
    opts = opts || {};
    var a = el('a', null);
    a.href = 'javascript: void(0)';
    if (opts.key) a.setAttribute('data-sui-cheatsheet', opts.key);
    if (opts.property) a.setAttribute('data-selected-property', opts.property);
    if (opts.struct) a.setAttribute('data-struct', opts.struct.id);
    a.appendChild(el('i', 'sui-icon-md ' + iconClass));
    return a;
  }

  /** The properties screen's icons: the four standard equipment slots in the
   * game's own order, then the economic ones — or a single state icon when the
   * struct is wreckage or unpowered, which is what the game shows instead.
   *
   * Each icon carries the `selectedProperty` its Cheatsheet needs, so pressing
   * one opens that ability's card rather than the whole struct's.
   *
   * The game pairs the economic icons with live COUNTS (undiscovered ore, ore
   * ready, fuel). Those are dropped here rather than guessed: they read the
   * owner's inventory and the struct's fuel, neither of which a spectator can
   * see per-struct. The icon alone still says truthfully what the Struct does;
   * a number we invented would not. */
  function propertyIcons(s, st) {
    var out = [];
    if (s.destroyed) {
      out.push(propIcon('icon-wreckage', { key: 'icon-wreckage' }));
      return out;
    }
    if (s.online === false) {
      out.push(propIcon('icon-unpowered', { key: 'icon-unpowered' }));
      return out;
    }
    if (!st) return out;
    [
      ['passive_weaponry', st.passive_weaponry],
      ['unit_defenses', st.unit_defenses],
      ['ore_reserve_defenses', st.ore_reserve_defenses],
      ['planetary_defenses', st.planetary_defenses]
    ].forEach(function (pair) {
      if (!equipped(pair[1])) return;
      var icon = EQUIP_ICON[pair[1]];
      if (icon) out.push(propIcon(icon, { key: s.type_slug, property: pair[0], struct: s }));
    });
    // Economic capability — an extractor or refinery has no combat equipment
    // at all, so without these its properties screen would be empty. These are
    // keyed sheets, not properties: the chain has no per-ability copy for them.
    if (equipped(st.planetary_mining)) out.push(propIcon('icon-mine', { key: 'icon-mine' }));
    if (equipped(st.planetary_refinery)) out.push(propIcon('icon-ore-ready', { key: 'icon-ore-ready' }));
    if (equipped(st.power_generation)) {
      out.push(propIcon(EQUIP_ICON[st.power_generation] || 'icon-refine',
        { key: s.type_slug, property: 'power_generation', struct: s }));
    }
    return out;
  }

  /** One inert ability button, in the game's `sui-panel-btn` shape. `data`
   * carries the same Cheatsheet dispatch attributes the game's buttons do. */
  function abilityBtn(iconClass, title, data) {
    var a = el('a', 'sui-panel-btn sui-mod-disabled');
    a.href = 'javascript: void(0)';
    a.title = title;
    Object.keys(data || {}).forEach(function (k) { a.setAttribute(k, data[k]); });
    a.appendChild(el('i', 'sui-icon-md ' + iconClass));
    return a;
  }

  /** The ability buttons this struct type would offer, in `buildStructAction
   * Buttons` order. All disabled — see the note at the top of this section.
   *
   * Titles come from the type's own copy where it exists (`primary_weapon_
   * label` is "Ballistic Weapon", not "Primary Weapon"), matching the hover
   * title the game puts on the same button. */
  function abilityButtons(s, st) {
    if (!st) return [];
    var out = [];
    var key = s.type_slug;
    if (equipped(st.primary_weapon)) {
      out.push(abilityBtn(
        st.primary_weapon_control === 'guided' ? 'icon-smart-weapon' : 'icon-ballistic-weapon',
        labelOr(st.primary_weapon_label, 'Primary Weapon'),
        { 'data-sui-cheatsheet': key, 'data-selected-property': 'primary_weapon', 'data-struct': s.id }));
    }
    if (equipped(st.secondary_weapon)) {
      out.push(abilityBtn(
        st.secondary_weapon_control === 'guided' ? 'icon-smart-weapon' : 'icon-ballistic-weapon',
        labelOr(st.secondary_weapon_label, 'Secondary Weapon'),
        { 'data-sui-cheatsheet': key, 'data-selected-property': 'secondary_weapon', 'data-struct': s.id }));
    }
    if (st.stealth_systems) {
      out.push(abilityBtn('icon-stealth', 'Stealth Mode',
        { 'data-sui-cheatsheet': key, 'data-selected-property': 'stealth_systems', 'data-struct': s.id }));
    }
    if (st.movable) {
      out.push(abilityBtn('icon-move', labelOr(st.drive_label, 'Move'),
        { 'data-sui-cheatsheet': key, 'data-selected-property': 'movable', 'data-struct': s.id }));
    }
    // Defend is the game's one button keyed by action rather than property.
    if (st.category === 'fleet') {
      out.push(abilityBtn('icon-defend', 'Defend',
        { 'data-sui-cheatsheet': key, 'data-action-button': 'defend', 'data-struct': s.id }));
    }
    if (equipped(st.power_generation)) {
      out.push(abilityBtn('icon-send-alpha', 'Consume Alpha',
        { 'data-sui-cheatsheet': key, 'data-selected-property': 'power_generation', 'data-struct': s.id }));
    }
    return out;
  }

  /** The Power Switch group. Player style only, per the spec: "The Enemy style
   * of Action Chunk does not display the power switch."
   *
   * The art tracks the struct's real state rather than always showing the
   * `disabled` variant: nothing here is clickable, and on/off is the whole
   * point of the control as a readout. */
  function panelSwitch(s) {
    var group = el('div', 'sui-action-bar-panel-switch-group');
    var img = document.createElement('img');
    img.src = '/img/sui/panel/panel-switch-'
      + (s.online === false ? 'off' : 'on') + '.png';
    img.alt = s.online === false ? 'powered off' : 'powered on';
    img.style.height = '48px';
    group.appendChild(img);
    return group;
  }

  /** Fill (or clear) one action bar's Action Chunk.
   *
   * `sel` is either `{struct: <SpectatorStruct>}` or `{tile: {icon, label}}`
   * for the empty-tile case; a falsy `sel` hides the connector and the chunk,
   * which is the spec's "Tile Selected = False" state. */
  function showInfo(which, sel) {
    var chunk = document.getElementById('rv-' + which + '-chunk');
    var connector = document.getElementById('rv-' + which + '-connector');
    if (!chunk || !connector) return;
    if (!sel) {
      chunk.classList.add('hidden');
      connector.classList.add('hidden');
      chunk.innerHTML = '';
      return;
    }
    chunk.classList.remove('hidden');
    connector.classList.remove('hidden');
    chunk.innerHTML = '';

    var s = sel.struct || null;
    var st = s ? typeOf(s) : null;

    // Header screen — the chain's own class abbreviation for a struct, the
    // tile's label for an empty tile. Uppercased by sui.css, not by us.
    var headText = s
      ? ((st && st.class_abbreviation) || s.type_name || s.type_slug || 'struct')
      : (sel.tile.label || 'tile');
    var headWrap = el('div', 'sui-screen sui-screen-full-width');
    var headScreen = el('div', 'sui-screen-info', headText);
    // The header opens the WHOLE-STRUCT Cheatsheet — the card with the model
    // number, build cost and every equipped system. In the game that card is
    // reached from the deploy menu, which a spectator has no equivalent of;
    // without a trigger here the richest sheet would be unreachable.
    if (s) {
      headScreen.setAttribute('data-sui-cheatsheet', s.type_slug);
      headScreen.setAttribute('data-struct', s.id);
    }
    headWrap.appendChild(headScreen);
    chunk.appendChild(headWrap);

    var row = el('div', 'sui-action-bar-bottom-row');

    // Power switch: struct tiles, player style only.
    if (s && which === 'def') row.appendChild(panelSwitch(s));

    var screen = el('div', 'sui-screen');
    var props = el('div', 'sui-screen-properties');
    var icons = s
      ? propertyIcons(s, st)
      : [propIcon(sel.tile.icon, null, null)];
    // An empty properties screen collapses to a bare box; the game never
    // shows one, so fall back to the struct's own silhouette icon.
    if (!icons.length) icons = [propIcon('icon-unknown', s ? s.type_slug : null, s)];
    icons.forEach(function (n) { props.appendChild(n); });
    screen.appendChild(props);
    row.appendChild(screen);

    var btns = s ? abilityButtons(s, st) : [];
    if (btns.length) {
      var group = el('div', 'sui-action-bar-btn-group');
      btns.forEach(function (n) { group.appendChild(n); });
      row.appendChild(group);
    }

    chunk.appendChild(row);

    // Every trigger in this chunk paints in its own bar's theme.
    var theme = which === 'def' ? 'player' : 'enemy';
    var trigs = chunk.querySelectorAll('[data-sui-cheatsheet]');
    for (var i = 0; i < trigs.length; i++) trigs[i].setAttribute('data-sui-theme', theme);
  }

  /* ── Cheatsheet ──────────────────────────────────────────────────────────
     The Design System's component for "information about an ability or
     Struct", and a POPOVER rather than a panel body — `SUICheatsheet` opens it
     on a 500ms press-and-hold, appends it to <body> so no ancestor's overflow
     can clip it, and positions it best-fit against the trigger. Ported here so
     the detail a spectator wants (health, what this thing is, why it is
     inert) stays one press away from the icons that stand for it.

     The content is ours: the game's CheatsheetContentBuilder reads a live
     GameState this window deliberately does not have. The MARKUP is the
     game's, so sui.css styles it. */

  var CHEAT_DELAY = 500;

  function initCheatsheets() {
    var sheet = document.createElement('div');
    sheet.id = 'rv-cheatsheet';
    sheet.className = 'sui-cheatsheet';
    sheet.style.position = 'fixed';
    var timer = null;

    function hide() {
      clearTimeout(timer);
      if (sheet.parentElement) sheet.parentElement.removeChild(sheet);
    }

    document.addEventListener('mousedown', function (e) {
      var trig = e.target.closest ? e.target.closest('[data-sui-cheatsheet]') : null;
      hide();
      if (!trig) return;
      timer = setTimeout(function () {
        ['sui-theme-player', 'sui-theme-enemy', 'sui-theme-neutral']
          .forEach(function (c) { sheet.classList.remove(c); });
        sheet.classList.add('sui-theme-' + (trig.dataset.suiTheme || 'player'));
        sheet.innerHTML = '';
        sheet.appendChild(cheatsheetBody(trig));
        document.body.appendChild(sheet);
        placeCheatsheet(sheet, trig.getBoundingClientRect());
      }, CHEAT_DELAY);
    });
    document.addEventListener('mouseup', hide);
    document.addEventListener('mouseleave', hide);
    // A scroll under an open sheet would leave it pointing at nothing.
    var sc = document.getElementById('rv-scroll');
    if (sc) sc.addEventListener('scroll', hide);
  }

  /** Try above, then right, then below, then left — `SUIUtil.positionBestFit
   * Fixed`'s order — and clamp into the viewport. */
  function placeCheatsheet(sheet, r) {
    var w = sheet.offsetWidth, h = sheet.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight, gap = 4;
    var top, left;
    if (r.top - h - gap >= 0)            { top = r.top - h - gap;  left = r.left + r.width / 2 - w / 2; }
    else if (r.right + w + gap <= vw)    { top = r.top + r.height / 2 - h / 2; left = r.right + gap; }
    else if (r.bottom + h + gap <= vh)   { top = r.bottom + gap;   left = r.left + r.width / 2 - w / 2; }
    else                                 { top = r.top + r.height / 2 - h / 2; left = r.left - w - gap; }
    sheet.style.top = Math.max(0, Math.min(top, vh - h)) + 'px';
    sheet.style.left = Math.max(0, Math.min(left, vw - w)) + 'px';
  }

  /* The content builder, ported from the game's `CheatsheetContentBuilder`.
   *
   * A Cheatsheet is KEYED by `data-sui-cheatsheet`, and the key selects one of
   * three shapes:
   *
   *   1. a FIXED key   (`icon-beacon`, `icon-blocked`, `icon-unpowered`, the
   *                     shield states, …) → a canned title + description;
   *   2. a STRUCT TYPE (key is the type's own name) with no
   *                     `data-selected-property` → the whole struct card:
   *                     "<model number> <class>", build costs, the type's
   *                     description, and one property row per equipped system;
   *   3. a STRUCT TYPE with `data-selected-property` → just that one ability:
   *                     its label, its battery cost, its description, and its
   *                     damage/range rows.
   *
   * Plus `data-action-button="defend"`, which the game special-cases.
   *
   * The labels and descriptions are HUMAN-WRITTEN COPY that exists only on the
   * Guild API's struct-type record (an authenticated endpoint), so they reach
   * this window through the snapshot rather than being invented here. Where a
   * label is missing — the game window has not synced yet — the enum name is
   * humanised as a fallback so a sheet is never empty or "undefined". */

  /** STRUCT_DESCRIPTIONS, verbatim. Keyed by the type's chain name. */
  var STRUCT_DESCRIPTIONS = {
    'Continental Power Plant': 'Consumes Alpha Matter to generate Energy.',
    'Field Generator': 'Consumes Alpha Matter to generate Energy.',
    'Jamming Satellite': 'Applies Signal Jamming to all enemy Smart Attacks.',
    'Orbital Shield Generator': 'Improves Planetary Defense.',
    'Ore Bunker': 'Massively improves Planetary Defense by storing Ore underground.',
    'Ore Extractor': 'Extracts Alpha Ore from the planet.',
    'Ore Refinery': 'Refines Ore into usable Alpha Matter.',
    'Planetary Defense Cannon': 'Launches Counter-Attacks against attacking Structs.',
    'World Engine': 'Consumes Alpha Matter to generate Energy.'
  };

  /** STRUCT_WEAPON_CONTROL_LABELS. */
  var WEAPON_CONTROL_LABEL = { guided: 'Smart Weapon', unguided: 'Ballistic Weapon' };

  /** The fixed-key sheets, exactly as `build()`'s switch spells them. */
  var FIXED_SHEETS = {
    'icon-beacon': ['Planetary Beacon', 'Planetary Structs can be deployed to this location.'],
    'icon-blocked': ['Blocked', 'Structs cannot be deployed to this location.'],
    'icon-cmd-post': ['Command Post', 'Only the Command Ship can be deployed to this location.'],
    'icon-enemy-tile': ['Enemy Territory', 'Structs cannot be deployed in Enemy Territory.'],
    'icon-fleet-tile': ['Fleet Territory', 'Fleet Structs can be deployed to this location.'],
    'icon-unknown-territory': ['Unknown Territory', 'There is nothing of interest here yet.'],
    'enemy-struct-deploying': ['Enemy Struct Deploying', 'A new enemy struct is being deployed.'],
    'icon-unpowered': ['Unpowered', "This Struct is not receiving power. It's abilities are not active."],
    'icon-attention': ['No Alpha Infused', 'Consume Alpha Matter to generate Energy.'],
    'icon-wreckage': ['Wreckage', 'This Struct has been destroyed.']
  };

  /** AMBIT_ORDER, and the chain's ambit bitmask (Water=2, Land=4, Air=8,
   * Space=16). The webapp gets ready-made arrays from the Guild API; from a
   * mask we expand them ourselves, in the same order the icons are shown. */
  var AMBIT_ORDER = ['space', 'air', 'land', 'water'];
  var AMBIT_BIT = { water: 2, land: 4, air: 8, space: 16 };

  function ambitsOf(mask) {
    return AMBIT_ORDER.filter(function (a) { return (mask & AMBIT_BIT[a]) !== 0; });
  }

  /** `NumberFormatter.format` — 1-3 leading digits plus a scale letter, and it
   * TRUNCATES (5,590,000 → "5M"). Ported so costs read as the game shows them,
   * including the lowercase kilo the game's own scale map uses ('1': 'k'). */
  var NUM_SCALE = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
  function fmtNumber(n) {
    var str = String(parseInt(n, 10) || 0);
    if (str.length <= 3) return str;
    var rem = str.length % 3 || 3;
    return str.substring(0, rem) + (NUM_SCALE[(str.length - rem) / 3] || '');
  }

  /** Turn `noOreReserveDefenses` / `signalJamming` into "Signal Jamming" —
   * only used when the Guild API copy has not reached us. */
  function humanise(enumName) {
    if (!enumName) return '';
    return enumName
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, function (c) { return c.toUpperCase(); })
      .trim();
  }

  function labelOr(label, enumName) { return label || humanise(enumName); }

  /* ── Sheet primitives, mirroring SUICheatsheetRenderer ─────────────────── */

  function ambitIcons(list) {
    var wrap = document.createDocumentFragment();
    list.forEach(function (a) { wrap.appendChild(el('i', 'sui-icon sui-icon-' + a)); });
    return wrap;
  }

  /** One property row: an icon, then one or two lines of info. `lines` entries
   * may be strings or nodes. */
  function sheetRow(iconClass, lines) {
    var row = el('div', 'sui-cheatsheet-property');
    var ico = el('div', 'sui-cheatsheet-property-icon');
    ico.appendChild(el('i', 'sui-icon sui-icon-md ' + iconClass));
    row.appendChild(ico);
    var info = el('div', 'sui-cheatsheet-property-info');
    lines.forEach(function (line) {
      if (line == null) return;
      var d = el('div');
      if (typeof line === 'string') d.textContent = line;
      else d.appendChild(line);
      info.appendChild(d);
    });
    row.appendChild(info);
    return row;
  }

  /** A line of text followed by ambit icons — the "N DMG <icons>" shape. */
  function textThenAmbits(text, ambits) {
    var f = document.createDocumentFragment();
    f.appendChild(document.createTextNode(text + ' '));
    f.appendChild(ambitIcons(ambits));
    return f;
  }

  /** `renderBatteryCostHTML` — the charge ladder rendered as battery chunks.
   * Same thresholds as ChargeCalculator, and the same "one chunk per threshold
   * above the first" loop. */
  var CHARGE_THRESHOLDS = [0, 1, 2, 3, 5, 8];
  function batteryCost(charge) {
    var level = 0;
    for (var i = 0; i < CHARGE_THRESHOLDS.length; i++) {
      if (charge >= CHARGE_THRESHOLDS[i]) level = i;
    }
    var bat = el('div', 'sui-battery');
    for (var j = 1; j < CHARGE_THRESHOLDS.length; j++) {
      bat.appendChild(el('div', 'sui-battery-chunk' + (j <= level ? ' sui-mod-filled' : '')));
    }
    return bat;
  }

  /** `renderContentHTML`: top frame, title (with costs), then content of
   * description / property section / contextual message — in that order. */
  function sheetContent(titleText, charge, energy, description, contextualMessage, rows) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('div', 'sui-cheatsheet-top-frame'));

    var title = el('div', 'sui-cheatsheet-title');
    title.appendChild(el('div', 'sui-cheatsheet-title-text', String(titleText || '').toUpperCase()));
    var costs = el('div', 'sui-cheatsheet-costs');
    if (charge != null) costs.appendChild(batteryCost(charge));
    if (energy != null) {
      var c = el('div', 'sui-cheatsheet-cost', fmtNumber(energy) + ' ');
      c.appendChild(el('i', 'sui-icon sui-icon-energy'));
      costs.appendChild(c);
    }
    title.appendChild(costs);
    frag.appendChild(title);

    var content = el('div', 'sui-cheatsheet-content');
    if (description) content.appendChild(el('div', 'sui-cheatsheet-description', description));
    if (rows && rows.length) {
      var sec = el('div', 'sui-cheatsheet-property-section');
      rows.forEach(function (r) { sec.appendChild(r); });
      content.appendChild(sec);
    }
    if (contextualMessage) {
      content.appendChild(el('div', 'sui-cheatsheet-contextual-message', contextualMessage));
    }
    frag.appendChild(content);
    return frag;
  }

  /* ── The struct card (no selected property) ────────────────────────────── */

  /** `renderWeaponProperty`: label, then "N DMG (+ARMOUR PIERCING) <ambits>". */
  function weaponRow(weaponType, label, damage, ambits, armourPiercing) {
    if (!equipped(weaponType)) return null;
    var icon = EQUIP_ICON[weaponType];
    if (!icon) return null;
    return sheetRow(icon, [
      label,
      textThenAmbits(damage + ' DMG' + (armourPiercing ? ' (+ARMOUR PIERCING)' : ''), ambits)
    ]);
  }

  /** `renderPassiveWeaponProperty`. Counter-attacks in the struct's OWN ambit
   * can hit harder; when they do, the game splits the row into two damage
   * figures rather than showing one misleading number. */
  function passiveRow(st) {
    if (!equipped(st.passive_weaponry)) return null;
    var icon = EQUIP_ICON[st.passive_weaponry];
    if (!icon) return null;
    var reach = ambitsOf(st.primary_weapon_ambits | st.secondary_weapon_ambits);
    var own = ambitsOf(st.possible_ambit);
    var line;
    if (st.counter_attack_same_ambit > st.counter_attack) {
      var regular = reach.filter(function (a) { return own.indexOf(a) < 0; });
      var same = reach.filter(function (a) { return own.indexOf(a) >= 0; });
      line = document.createDocumentFragment();
      if (regular.length) {
        line.appendChild(document.createTextNode(st.counter_attack + ' DMG '));
        line.appendChild(ambitIcons(regular));
        line.appendChild(document.createTextNode(' '));
      }
      if (same.length) {
        line.appendChild(document.createTextNode(st.counter_attack_same_ambit + ' DMG '));
        line.appendChild(ambitIcons(same));
      }
    } else {
      line = textThenAmbits(st.counter_attack + ' DMG', reach);
    }
    return sheetRow(icon, [labelOr(st.passive_weaponry_label, st.passive_weaponry), line]);
  }

  /** The whole-struct card: `buildStructCheatsheet`. */
  function structSheet(st, contextualMessage) {
    var rows = [];
    rows.push(weaponRow(
      st.primary_weapon,
      labelOr(st.primary_weapon_label, st.primary_weapon),
      st.primary_weapon_damage,
      ambitsOf(st.primary_weapon_ambits),
      st.primary_weapon_armour_piercing));
    rows.push(weaponRow(
      st.secondary_weapon,
      labelOr(st.secondary_weapon_label, st.secondary_weapon),
      st.secondary_weapon_damage,
      ambitsOf(st.secondary_weapon_ambits),
      st.secondary_weapon_armour_piercing));
    rows.push(passiveRow(st));

    if (equipped(st.unit_defenses) && EQUIP_ICON[st.unit_defenses]) {
      rows.push(sheetRow(EQUIP_ICON[st.unit_defenses],
        [labelOr(st.unit_defenses_label, st.unit_defenses)]));
    }
    // The defensive cannon is a weapon in all but name: the game renders it
    // through renderWeaponProperty at 1 DMG across every ambit.
    if (st.planetary_defenses === 'defensiveCannon') {
      rows.push(weaponRow('defensiveCannon',
        labelOr(st.planetary_defenses_label, st.planetary_defenses),
        1, AMBIT_ORDER.slice(), false));
    } else if (equipped(st.planetary_defenses) && EQUIP_ICON[st.planetary_defenses]) {
      rows.push(sheetRow(EQUIP_ICON[st.planetary_defenses],
        [labelOr(st.planetary_defenses_label, st.planetary_defenses)]));
    }
    if (equipped(st.ore_reserve_defenses) && EQUIP_ICON[st.ore_reserve_defenses]) {
      rows.push(sheetRow(EQUIP_ICON[st.ore_reserve_defenses], [
        labelOr(st.ore_reserve_defenses_label, st.ore_reserve_defenses),
        '+' + fmtNumber(st.planetary_shield_contribution) + ' Planetary Defense'
      ]));
    }
    if (equipped(st.power_generation)) {
      rows.push(sheetRow('icon-send-alpha', ['Consume Alpha']));
      rows.push(sheetRow(EQUIP_ICON[st.power_generation] || 'icon-refine',
        ['+' + st.generating_rate + ' KW Per Alpha']));
    }

    var title = (st.default_cosmetic_model_number
      ? st.default_cosmetic_model_number + ' ' : '') + (st.class_name || st.class_abbreviation);

    return sheetContent(
      title,
      st.build_charge || null,
      st.build_draw || null,
      STRUCT_DESCRIPTIONS[st.class_name] || '',
      contextualMessage,
      rows.filter(Boolean));
  }

  /* ── The single-ability card (selected property) ───────────────────────── */

  /** `renderPropertiesForWeapon`: control label, damage (a range when the
   * weapon fires more than once), reach, and armour piercing. */
  function weaponPropertyRows(weaponType, control, damage, shots, ambits, armourPiercing) {
    var rows = [];
    var icon = EQUIP_ICON[weaponType];
    if (icon) rows.push(sheetRow(icon, [WEAPON_CONTROL_LABEL[control] || humanise(control)]));
    rows.push(sheetRow('icon-dmg',
      [shots > 1 ? (damage + '-' + (damage * shots) + ' DMG') : (damage + ' DMG')]));
    rows.push(sheetRow('icon-range', [ambitIcons(ambits)]));
    if (armourPiercing) rows.push(sheetRow('icon-mine', ['Armour Piercing']));
    return rows;
  }

  /** `buildStructPropertyCheatsheet`. */
  function propertySheet(st, property) {
    switch (property) {
      case 'primary_weapon':
        return sheetContent(
          labelOr(st.primary_weapon_label, st.primary_weapon),
          st.primary_weapon_charge, null, st.primary_weapon_description, null,
          weaponPropertyRows(st.primary_weapon, st.primary_weapon_control,
            st.primary_weapon_damage, st.primary_weapon_shots,
            ambitsOf(st.primary_weapon_ambits), st.primary_weapon_armour_piercing));
      case 'secondary_weapon':
        return sheetContent(
          labelOr(st.secondary_weapon_label, st.secondary_weapon),
          st.secondary_weapon_charge, null, st.secondary_weapon_description, null,
          weaponPropertyRows(st.secondary_weapon, st.secondary_weapon_control,
            st.secondary_weapon_damage, st.secondary_weapon_shots,
            ambitsOf(st.secondary_weapon_ambits), st.secondary_weapon_armour_piercing));
      case 'movable':
        return sheetContent(labelOr(st.drive_label, 'drive'),
          st.move_charge, null, st.drive_description, null, []);
      case 'passive_weaponry': {
        var reach = ambitsOf(st.primary_weapon_ambits | st.secondary_weapon_ambits);
        var dmg = st.counter_attack_same_ambit > st.counter_attack
          ? (st.counter_attack + '-' + st.counter_attack_same_ambit + ' DMG')
          : (st.counter_attack + ' DMG');
        return sheetContent(
          labelOr(st.passive_weaponry_label, st.passive_weaponry),
          null, null, st.passive_weaponry_description, null,
          [sheetRow('icon-dmg', [dmg]), sheetRow('icon-range', [ambitIcons(reach)])]);
      }
      case 'unit_defenses':
        return sheetContent(labelOr(st.unit_defenses_label, st.unit_defenses),
          null, null, st.unit_defenses_description, null, []);
      case 'ore_reserve_defenses':
        return sheetContent(
          labelOr(st.ore_reserve_defenses_label, st.ore_reserve_defenses),
          null, null, st.ore_reserve_defenses_description, null,
          EQUIP_ICON[st.ore_reserve_defenses] ? [sheetRow(EQUIP_ICON[st.ore_reserve_defenses], [
            labelOr(st.ore_reserve_defenses_label, st.ore_reserve_defenses),
            '+' + fmtNumber(st.planetary_shield_contribution) + ' Planetary Defense'
          ])] : []);
      case 'planetary_defenses':
        return sheetContent(
          labelOr(st.planetary_defenses_label, st.planetary_defenses),
          null, null, st.planetary_defenses_description, null,
          st.planetary_defenses === 'defensiveCannon'
            ? [sheetRow('icon-dmg', ['1 DMG']),
               sheetRow('icon-range', [ambitIcons(AMBIT_ORDER.slice())])]
            : []);
      case 'stealth_systems':
        // The game reaches stealth through unit_defenses; the button carries
        // its own charge, which is the one fact that row adds.
        return sheetContent(labelOr(st.unit_defenses_label, 'stealthMode'),
          st.stealth_activate_charge, null, st.unit_defenses_description, null, []);
      case 'power_generation':
        // The game's own switch has no `power_generation` case, so its Consume
        // Alpha button opens an empty sheet. Filled in here from the type's
        // generating rate rather than reproducing that gap.
        return sheetContent('Consume Alpha', null, null,
          'Consumes Alpha Matter to generate Energy.', null,
          [sheetRow(EQUIP_ICON[st.power_generation] || 'icon-refine',
            ['+' + st.generating_rate + ' KW Per Alpha'])]);
      default:
        return null;
    }
  }

  /** Cheatsheet content for a trigger — the `build(dataset)` dispatch. */
  function cheatsheetBody(trig) {
    var key = trig.dataset.suiCheatsheet || '';
    var s = state.structsById[trig.dataset.struct || ''] || null;
    var st = s ? typeOf(s) : null;

    var fixed = FIXED_SHEETS[key];
    if (fixed) return sheetContent(fixed[0], null, null, fixed[1], null, []);

    // Economy icons whose value the SPECTATOR does not have. The game shows a
    // count here read from the owner's own inventory; saying "N Ore" with a
    // number we cannot see would be a lie, so the sheet states the capability.
    if (key === 'icon-mine') {
      return sheetContent('Ore Extraction', null, null,
        'This Struct extracts Alpha Ore from the planet.', null, []);
    }
    if (key === 'icon-ore-ready') {
      return sheetContent('Ore Refining', null, null,
        'This Struct refines Ore into usable Alpha Matter.', null, []);
    }
    if (key === 'icon-refine' && !st) {
      return sheetContent('Power Generation', null, null,
        'Consumes Alpha Matter to generate Energy.', null, []);
    }

    if (!st) {
      // A type we could not resolve — name it rather than showing a blank box.
      return sheetContent(s ? (s.type_name || s.type_slug) : humanise(key.replace(/^icon-/, '')),
        null, null, '', null, []);
    }

    if (trig.dataset.actionButton === 'defend') {
      return sheetContent('Defend', st.defend_change_charge, null,
        'Blocks incoming damage and counter-attacks on behalf of another Struct.',
        null, []);
    }

    if (trig.dataset.selectedProperty) {
      var sheet = propertySheet(st, trig.dataset.selectedProperty);
      if (sheet) return sheet;
    }

    // The whole-struct card. The contextual message is the spectator's one
    // addition: WHY this Struct is currently inert.
    var msg = s && s.destroyed ? 'Destroyed.'
      : (s && !s.built ? 'Under construction.'
      : (s && s.online === false ? 'Unpowered — abilities inactive.'
      : (s && s.hidden ? 'In stealth.' : null)));
    return structSheet(st, msg);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Structs
  // ══════════════════════════════════════════════════════════════════════════

  function structNode(s) {
    var wrap = el('div', 'rv-struct-wrap');
    wrap.id = domId('slot', s.id);

    var still = el('div', 'rv-struct'
      + (s.side === 'attacker' ? ' rv-attacker' : '')
      // Stealth is chain-visible (structAttributes.isHidden); the game shows a
      // hidden struct at half opacity rather than removing it.
      + (s.hidden ? ' rv-stealth' : ''));
    still.id = domId('struct', s.id);
    still.setAttribute('data-struct-id', s.id);
    renderStill(still, s);
    wrap.appendChild(still);

    // Lottie mounts here so an animation never replaces the still underneath —
    // the still has to stay visible for shake and impact to read correctly.
    var anim = el('div', 'rv-anim');
    anim.id = domId('anim', s.id);
    wrap.appendChild(anim);

    var hud = el('div', 'rv-hud');
    hud.id = domId('hud', s.id);
    renderHud(hud, s);
    wrap.appendChild(hud);
    return wrap;
  }

  /* Stacked PNG layers, following StructStillRenderer: extra "top" layers over
   * the hull, "bottom" layers under it, and the damaged hull variant swapped in
   * below full health. z-index decides the order, not DOM position. */
  function renderStill(node, s, healthOverride) {
    var art = ART[s.type_slug];
    node.innerHTML = '';
    // A struct still being built shows the deployment indicator, not a hull —
    // MapStructLayerComponent.renderStruct's !isBuilt() branch.
    if (s.built === false) {
      node.appendChild(layer('img/structs/deployment-indicator/deployment-indicator.gif', ''));
      return;
    }
    if (!art) return;                                   // unknown type: no art, no crash
    var hp = healthOverride != null ? healthOverride : currentHealth(s);
    // Zero means destroyed ONLY when the health is actually known. An unknown
    // type has max_health 0, and treating that as destroyed would silently
    // erase every struct we couldn't look up.
    if (hp === 0 && healthKnown(s, healthOverride)) return;

    var damaged = s.max_health > 0 && hp > 0 && hp < s.max_health;
    (art.bottom || []).forEach(function (suffix) {
      node.appendChild(layer(artPath(art.dir, suffix), 'rv-bottom'));
    });
    node.appendChild(layer(artPath(art.dir, damaged ? 'struct-dmg' : 'struct-base'), ''));
    (art.top || []).forEach(function (suffix) {
      node.appendChild(layer(artPath(art.dir, suffix), 'rv-top'));
    });
  }

  function layer(src, cls) {
    var img = document.createElement('img');
    img.src = src;
    img.alt = '';
    if (cls) img.className = cls;
    // A missing art file must not leave a broken-image glyph on the map.
    img.addEventListener('error', function () { img.style.display = 'none'; });
    return img;
  }

  function currentHealth(s) {
    var live = state.liveHealth[s.id];
    return live != null ? live : (s.health != null ? s.health : s.max_health);
  }

  /* Whether the number `currentHealth` returned is real or a fallback. The
   * struct list carries no health at all (it lives only on the LCD entity), so
   * a failed lookup leaves it null and max_health stands in — which is 0 for a
   * type we could not resolve. */
  function healthKnown(s, override) {
    return override != null || state.liveHealth[s.id] != null || s.health != null;
  }

  /* Health bar + label. SEGMENTED, one cell per hit point, in a 48px dark box
   * pinned near the top of the tile — transcribed from
   * MapStructHUDLayerComponent.renderHealthBar + .map-struct-hud-status-bars.
   * We show it for foreign structs too, which the game deliberately hides;
   * health is public chain state, nothing privileged. */
  function renderHud(node, s, healthOverride) {
    node.innerHTML = '';
    var hp = healthOverride != null ? healthOverride : currentHealth(s);
    var max = s.max_health || 0;
    if (max > 0) {
      var box = el('div', 'rv-hudbox');
      var bar = el('div', 'rv-hp');
      for (var i = 0; i < max; i++) {
        bar.appendChild(el('i', i < hp ? 'rv-seg on' : 'rv-seg'));
      }
      box.appendChild(bar);
      node.appendChild(box);
    }
    // Status indicators live in their own layer so focus changes can rewrite
    // them without rebuilding the struct. Contents decided by `badgesFor`.
    var badge = el('div', 'rv-status-badges');
    badge.id = domId('badges', s.id);
    node.appendChild(badge);
    paintBadges(s);
    // NO type label. The game draws a health bar and status icons on a struct
    // tile and nothing else — verified by comparing the same art side by side
    // with the live client, where these tiles are unlabelled. A permanent
    // truncated caption ("ORBITAL SHIE…") under every struct was the single
    // most visible departure from the real map. Identity now comes from
    // SELECTING the struct, which is how the game answers the same question.
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Animation queue — transcribed from data_structures/AnimationEventQueue.js
  //
  // Strictly serial: one animation plays, and its completion pulls the next.
  // Not a rAF loop. When it drains, deferred state reconciliation runs — that
  // is what stops a snapshot landing mid-sequence from clobbering the partial
  // health values the sequence is animating toward.
  // ══════════════════════════════════════════════════════════════════════════

  /* ── PiP bubble — combat happening off-screen ──────────────────────────
   *
   * Transcribed from MapPictureInPictureComponent: while an attack-sequence
   * animation (ATTACK_/IMPACT_/SHAKE_/EVADE/DESTROY_ — status animations
   * never qualify) plays for a struct whose tile is FULLY outside the scroll
   * viewport, a fixed 128px bubble slides in — from the left for a
   * defender-side struct, from the right for an attacker — showing that
   * tile's terrain, the struct, and the SAME animation. It hides when the
   * queue drains, and visibility re-evaluates on scroll/resize so scrolling
   * the real tile into view retracts the bubble.
   *
   * The bubble's lottie is MUTED: its completion never advances the queue —
   * only the on-map animation drives playNext, exactly as the game keeps its
   * PIP viewer from driving the global AnimationEventQueue. */

  var PIP_SEQ = ['ATTACK_', 'IMPACT_', 'SHAKE_', 'EVADE', 'DESTROY_',
                 'DEFENSIVE_MANEUVER', 'SIGNAL_JAMMING', 'LOW_ORBIT_BALLISTIC_INTERCEPTOR_NETWORK'];
  function isAttackSequence(names) {
    return (names || []).some(function (n) {
      return PIP_SEQ.some(function (p) { return n === p || String(n).indexOf(p) === 0; });
    });
  }

  var pip = { structId: null, side: null, anim: null, swapTimer: null };

  function pipEl() { return document.getElementById('rv-pip'); }

  function pipCellOf(structId) {
    var wrap = document.getElementById(domId('slot', structId));
    if (!wrap) return null;
    var n = wrap;
    while (n && String(n.className || '').indexOf('rv-cell') < 0) n = n.parentNode;
    return n || null;
  }

  /* Fully off the SCROLL VIEWPORT — not the window. The map lives inside
   * #rv-scroll under a fixed header, so the scroll box is the visible area.
   * Any partially visible tile means no bubble, same as the game. */
  function pipOffscreen(cell) {
    if (!cell || !cell.getBoundingClientRect) return false;
    var sc = document.getElementById('rv-scroll');
    if (!sc) return false;
    var v = sc.getBoundingClientRect();
    var r = cell.getBoundingClientRect();
    return r.bottom <= v.top || r.top >= v.bottom || r.right <= v.left || r.left >= v.right;
  }

  function pipDestroyAnim() {
    if (pip.anim) { try { pip.anim.destroy(); } catch (e) {} pip.anim = null; }
  }

  function pipClear() {
    pipDestroyAnim();
    if (pip.swapTimer) { clearTimeout(pip.swapTimer); pip.swapTimer = null; }
    var el = pipEl();
    if (el) {
      el.classList.remove('rv-vis', 'rv-side-left', 'rv-side-right');
      var mount = document.getElementById('rv-pip-struct');
      if (mount) mount.innerHTML = '';
    }
    pip.structId = null;
    pip.side = null;
  }

  /* Fill the bubble for one struct: the tile's own terrain as the mask
   * background, the marker if the cell shows one, the still at the health the
   * sequence has reached, and the animation the map is playing right now. */
  function pipRender(s, cell, name, healthNow) {
    var el = pipEl();
    var mount = document.getElementById('rv-pip-struct');
    if (!el || !mount) return false;

    var mask = el.querySelector('.rv-pip-mask');
    if (mask && cell) {
      mask.style.backgroundColor = cell.style.backgroundColor || '';
      mask.style.backgroundImage = cell.style.backgroundImage || '';
    }

    pipDestroyAnim();
    mount.innerHTML = '';

    var marker = cell && cell.querySelector('.rv-marker');
    if (marker && marker.style.display !== 'none') {
      var m2 = document.createElement('img');
      m2.src = marker.src; m2.alt = ''; m2.className = 'rv-marker';
      mount.appendChild(m2);
    }

    var still = el2('div', 'rv-struct' + (s.hidden ? ' rv-stealth' : ''));
    renderStill(still, s, healthNow);
    // The bubble obeys the same still-visibility rules as the tile: during an
    // attack/impact/destroy the bundle owns the sprite, and a visible still
    // would double it inside the bubble too.
    if (name && !stillFlags([name]).during) still.classList.add('rv-invisible');
    mount.appendChild(still);

    if (name && window.lottie) {
      var animBox = el2('div', 'rv-anim' + (flipsLayer(name) ? ' rv-flip-layer' : ''));
      mount.appendChild(animBox);
      try {
        pip.anim = window.lottie.loadAnimation({
          container: animBox, renderer: 'svg', loop: false, autoplay: true,
          path: lottiePath(name, s.type_slug),
        });
      } catch (e) { /* the still alone is still informative */ }
    }
    return true;
  }
  function el2(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  /* Show/refresh the bubble for the struct the queue is animating.
   * Same struct: refresh in place (counter-chains keep the bubble up).
   * Different struct: slide out, swap contents and side off-screen, slide
   * back in — the side-class jump is invisible while parked off-screen. */
  function pipShow(ev, name) {
    var s = state.structsById[ev.structId];
    if (!s) return;
    var cell = pipCellOf(ev.structId);
    if (!cell) return;
    var el = pipEl();
    if (!el) return;
    var side = s.side === 'attacker' ? 'right' : 'left';
    var healthNow = ev.healthAfter != null ? ev.healthAfter : currentHealth(s);

    var apply = function () {
      pip.structId = ev.structId;
      pip.side = side;
      el.classList.remove('rv-side-left', 'rv-side-right');
      el.classList.add(side === 'right' ? 'rv-side-right' : 'rv-side-left');
      if (pipRender(s, cell, name, healthNow)) {
        // Force a layout flush so the browser commits the off-screen anchor
        // before rv-vis lands — otherwise the slide-in transition is skipped.
        void el.offsetWidth;
        pipUpdateVisibility();
      } else {
        pipClear();
      }
    };

    if (pip.structId && pip.structId !== ev.structId && el.classList.contains('rv-vis')) {
      el.classList.remove('rv-vis');
      if (pip.swapTimer) clearTimeout(pip.swapTimer);
      pip.swapTimer = setTimeout(function () { pip.swapTimer = null; apply(); }, 320);
    } else {
      apply();
    }
  }

  function pipRequestHide() {
    var el = pipEl();
    if (el) el.classList.remove('rv-vis');
    // Forget the struct NOW, not after the 320ms slide-out: a scroll/resize
    // inside that window calls pipUpdateVisibility, which re-showed the
    // bubble — with the PREVIOUS fight's struct in it — because structId was
    // still set. The node keeps its contents until pipClear so the slide-out
    // has something to slide.
    pip.structId = null;
    if (pip.swapTimer) { clearTimeout(pip.swapTimer); pip.swapTimer = null; }
    pip.swapTimer = setTimeout(function () { pip.swapTimer = null; pipClear(); }, 320);
  }

  /* Called from the queue as each animation starts, and from scroll/resize. */
  function pipOnAnimation(ev, name) {
    if (!ev.names || !ev.names.length || !isAttackSequence(ev.names)) {
      if (pip.structId) pipRequestHide();
      return;
    }
    var cell = pipCellOf(ev.structId);
    if (pipOffscreen(cell)) {
      pipShow(ev, name);
    } else if (pip.structId === ev.structId || !pip.structId) {
      // Tile visible: the map itself is the viewer.
      pipUpdateVisibility();
    }
  }

  function pipUpdateVisibility() {
    var el = pipEl();
    if (!el) return;
    if (!pip.structId) { el.classList.remove('rv-vis'); return; }
    var cell = pipCellOf(pip.structId);
    el.classList.toggle('rv-vis', pipOffscreen(cell));
  }

  var queue = [];
  var playing = false;
  var pendingReconcile = null;

  function enqueue(ev) {
    queue.push(ev);
    if (!playing) playNext();
  }

  function playNext() {
    if (!queue.length) {
      playing = false;
      // Reaction indicators superseded the status ones while the sequence
      // ran (Design System, Unit Tile); the fight is over, so bring them back.
      repaintAllBadges();
      // The fight is over (for now) — retract the bubble the way the game
      // does on ANIMATION_QUEUE_EMPTY.
      if (pip.structId) pipRequestHide();
      if (pendingReconcile) {
        var fn = pendingReconcile;
        pendingReconcile = null;
        fn();
      }
      return;
    }
    var wasIdle = !playing;
    playing = true;
    // First event of a sequence: clear the persistent icons so a reaction
    // indicator is never competing with them on the same tile.
    if (wasIdle) repaintAllBadges();
    var ev = queue.shift();
    runAnimation(ev, playNext);
  }

  /* Still-visibility rules, straight from the factory's AnimationEvent flags:
   * `showStructStillDuringAnimation` is TRUE only for evades (the struct
   * visibly dodges); every attack/impact/shake/destroy HIDES the still while
   * it plays — the attack bundles contain the firing struct themselves, so a
   * visible still would double the sprite. `showStructStillAfterAnimation` is
   * false only for destroys. Derived from the names rather than carried as
   * flags, because the mapping is total. */
  function stillFlags(names) {
    var evadeOnly = names.length > 0 && names.every(isEvadeName);
    var destroys = names.some(function (n) { return String(n).indexOf('DESTROY_') === 0; });
    return { during: evadeOnly, after: !destroys };
  }

  function setStillHidden(structId, hidden) {
    var still = document.getElementById(domId('struct', structId));
    if (still) still.classList.toggle('rv-invisible', !!hidden);
  }

  /* Swap the struct's own art into a loaded lottie SVG — the game's
   * MapStructLottieAnimationSVG.configStructImages(), which we never
   * replicated. The type-agnostic bundles (deployment_*, destroy_*, move_*,
   * shake_*) are TEMPLATES: they ship with placeholder struct art baked into
   * tagged layers (`g.struct_init` in destroy_water is literally the
   * Destroyer hull), and the game replaces those images after the SVG builds.
   * Playing the bundle raw is why a Destroyer appeared whenever any water
   * struct was destroyed.
   *
   * Layer semantics, from StructStillBuilder/configStructImages: `init` shows
   * the struct's CURRENT state (dmg art unless at full health), `dmg` always
   * the damaged art, top/bottom layers the detail PNGs. A slot the struct has
   * no art for is emptied — the webapp's falsy-src branch clears the group
   * rather than leaving the placeholder. */
  var ANIM_ART_LAYERS = ['struct_init', 'struct_dmg',
    'struct_top_layer_1', 'struct_top_layer_2', 'struct_bottom_layer_1'];
  function injectStructArt(box, s, hp) {
    if (!box || !s) return;
    var art = ART[s.type_slug];
    var atFull = s.max_health > 0 && hp != null && hp >= s.max_health;
    var srcs = {
      struct_init: art ? artPath(art.dir, atFull ? 'struct-base' : 'struct-dmg') : null,
      struct_dmg: art ? artPath(art.dir, 'struct-dmg') : null,
      struct_top_layer_1: art && art.top && art.top[0] ? artPath(art.dir, art.top[0]) : null,
      struct_top_layer_2: art && art.top && art.top[1] ? artPath(art.dir, art.top[1]) : null,
      struct_bottom_layer_1: art && art.bottom && art.bottom[0] ? artPath(art.dir, art.bottom[0]) : null,
    };
    ANIM_ART_LAYERS.forEach(function (cls) {
      var g = box.querySelector('.' + cls);
      if (!g) return;                       // template has no such layer
      var img = g.querySelector('image');
      if (!img) return;
      if (srcs[cls]) {
        // Lottie writes xlink:href; new browsers read href. Set both.
        img.setAttribute('href', srcs[cls]);
        img.setAttribute('xlink:href', srcs[cls]);
      } else {
        img.parentNode.removeChild(img);
      }
    });
  }

  /* Play one queue event over a struct, then hand back control.
   *
   * ALL of the event's names play SIMULTANEOUSLY — impact and shake are two
   * layers of one moment, and the event completes when the LAST of them does
   * (AnimationEvent: "the names of the animations to play simultaneously";
   * prepareAnimationLifecycle counts them down). `healthAfter` is applied at
   * completion, so a three-shot burst steps the bar down three times — and a
   * snapshot that has already moved past this shot cannot erase the
   * intermediate frames. */
  function runAnimation(ev, done) {
    var mount = document.getElementById(domId('anim', ev.structId));
    var still = document.getElementById(domId('struct', ev.structId));
    var hud = document.getElementById(domId('hud', ev.structId));
    var s = state.structsById[ev.structId];
    var names = ev.names || [];
    var flags = stillFlags(names);

    var finish = function () {
      if (ev.healthAfter != null && s) {
        state.liveHealth[ev.structId] = ev.healthAfter;
        if (still) renderStill(still, s, ev.healthAfter);
        if (hud) renderHud(hud, s, ev.healthAfter);
        if (ev.healthAfter === 0 && still) still.innerHTML = '';
        // Mark wreckage in STATE, not just the DOM: the tile then shows the
        // destroyed badge (previously unreachable — snapshots drop destroyed
        // structs, so `destroyed` was never true) until the next snapshot
        // removes it, and nothing can resurrect the sprite meanwhile.
        if (ev.healthAfter === 0) s.destroyed = true;
      }
      // Restore the still unless this was a destroy — and never resurrect a
      // struct the sequence just emptied.
      if (still && flags.after && ev.healthAfter !== 0) syncStill(ev.structId);
      done();
    };

    if (!mount || !window.lottie || !names.length) { finish(); return; }

    // Offer the sequence to the Animation Bubble. It decides whether to show
    // one: only for attack sequences, and only while the acting tile is fully
    // off the scroll viewport ("should not appear when a unit is in view" —
    // Design System, Animation Bubble). Without this call the whole bubble
    // path is unreachable, which is precisely what it was.
    pipOnAnimation(ev, names[0]);

    // The still hides while the animation owns the tile (evades excepted),
    // and the idle loop pauses with it.
    if (!flags.during) {
      pauseIdle(ev.structId);
      setStillHidden(ev.structId, true);
    }

    var pending = names.length;
    var finished = false;
    var oneDone = function () {
      pending--;
      if (pending <= 0 && !finished) {
        finished = true;
        mount.innerHTML = '';
        finish();
      }
    };

    names.forEach(function (name) {
      var box = document.createElement('div');
      box.className = 'rv-anim-layer' + (flipsLayer(name) ? ' rv-flip-layer' : '');
      mount.appendChild(box);
      var anim;
      try {
        anim = window.lottie.loadAnimation({
          container: box,
          renderer: 'svg',
          loop: false,
          autoplay: true,
          path: lottiePath(name, ev.typeSlug),
        });
      } catch (e) { oneDone(); return; }
      // Once the SVG exists, replace the template's baked placeholder struct
      // with this struct's own art (the game does this for every animation;
      // for the per-type bundles it is a no-op swap of identical art).
      anim.addEventListener('DOMLoaded', function () {
        injectStructArt(box, s, ev.healthAfter != null ? ev.healthAfter : currentHealth(s));
      });
      var cleanup = function () {
        try { anim.destroy(); } catch (e2) {}
        oneDone();
      };
      anim.addEventListener('complete', cleanup);
      // A bundle that fails to load must not wedge the queue for good.
      anim.addEventListener('data_failed', cleanup);
      setTimeout(function () { if (anim && !anim.isLoaded) cleanup(); }, 4000);
    });
  }

  /* Idle animation for the economic structs that have one. Looped, and always
   * behind combat: an active_loop is (re)started only while the queue is idle,
   * so it can never interleave with a fight. */
  var IDLE_TYPES = {
    field_generator: 1, jamming_satellite: 1, orbital_shield_generator: 1,
    ore_bunker: 1, ore_extractor: 1, ore_refinery: 1,
  };
  var idleAnims = {};
  function startIdle(s) {
    if (!IDLE_TYPES[s.type_slug] || !window.lottie) return;
    // The game plays the loop only while the struct is ONLINE
    // (showStructStill: offline → loop stops, still shows).
    if (s.online === false || s.built === false) return;
    if (idleAnims[s.id]) return;
    var mount = document.getElementById(domId('anim', s.id));
    if (!mount) return;
    try {
      idleAnims[s.id] = window.lottie.loadAnimation({
        container: mount, renderer: 'svg', loop: true, autoplay: true,
        path: lottiePath('ACTIVE_LOOP', s.type_slug),
      });
      // Loop templates carry struct art layers too — swap in current-state
      // art so a damaged extractor doesn't idle at full health.
      idleAnims[s.id].addEventListener('DOMLoaded', function () {
        injectStructArt(mount, s, currentHealth(s));
      });
      // The loop bundle CONTAINS the struct art — the still must hide or the
      // sprite doubles (hideStructStill/showStructStill do exactly this).
      setStillHidden(s.id, true);
    } catch (e) { /* no idle animation is not an error */ }
  }
  function pauseIdle(structId) {
    var a = idleAnims[structId];
    if (a) { try { a.stop(); } catch (e) {} }
  }
  function stopIdle(structId) {
    var a = idleAnims[structId];
    if (!a) return;
    try { a.destroy(); } catch (e) {}
    delete idleAnims[structId];
    setStillHidden(structId, false);
  }
  /* Whichever of loop/still should show right now, show exactly one. */
  function syncStill(structId) {
    var a = idleAnims[structId];
    if (a) {
      try { a.goToAndPlay(0); } catch (e) {}
      setStillHidden(structId, true);
    } else {
      setStillHidden(structId, false);
    }
  }
  function stopAllIdle() {
    Object.keys(idleAnims).forEach(stopIdle);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Choreography — turning a polled attack into a played sequence
  // ══════════════════════════════════════════════════════════════════════════

  /* One attack row → the ordered animation events, sequenced exactly as the
   * game's StructListener does per shot:
   *   (a) each defender counter: its weapon animation, then the attacker's
   *       impact (and destroy if it killed the attacker);
   *   (b) the attacker's own weapon animation — unless (a) just killed it;
   *   (c) an evasion by the TARGET's own defence → its evade art; an
   *       interception by the planet's network → the Jamming Satellite's art;
   *   (d) a blocked shot lands on the BLOCKER, always;
   *   (e) the target's impact + shake ONLY when its health actually moved —
   *       an intercepted or absorbed shot shows nothing on the target;
   *   (f) the target's counter: its weapon, then the attacker's impact;
   *   (g) the planet's cannon: its weapon, then the attacker's impact.
   * Health is threaded from the shot's own before/after fields, never read
   * from live state (the poll runs seconds behind the stream). Pure, so the
   * harness can assert on it; choreograph feeds the result to the queue. */
  function planAttack(attack, structsById) {
    structsById = structsById || {};
    var events = [];
    var atk = structsById[attack.attacker_id];
    var atkType = attack.attacker_type || (atk && atk.type_name);
    var atkAmbit = attack.attacker_ambit || (atk && atk.ambit);
    var atkSlug = atk && atk.type_slug;
    var weapon = attack.weapon || PRIMARY;
    var running = numOf(attack.attacker_health_before);   // attacker HP as counters land
    var attackerDead = false;

    function attackAnim(structId, slug, weaponSystem) {
      events.push({
        structId: structId, typeSlug: slug,
        names: [weaponSystem === SECONDARY ? 'ATTACK_SECONDARY_WEAPON' : 'ATTACK_PRIMARY_WEAPON'],
        healthAfter: null,
      });
    }
    function destroyName(victim, ambitHint) {
      // Planetary structs sitting on water are destroyed with the LAND
      // animation — they stand on platforms. Straight from the factory.
      var ambit = ambitHint || (victim && victim.ambit);
      if (victim && victim.category === 'planet' && ambit === WATER) ambit = LAND;
      return 'DESTROY_' + String(ambit || LAND).toUpperCase();
    }
    function attackerHit(byType, byAmbit, byWeapon, dmg, killed) {
      var after = running == null ? null : Math.max(0, running - (dmg || 0));
      running = after;
      var r = resolveShotAnimation(byType, byAmbit, atkAmbit, byWeapon, after == null ? 1 : after, false, '');
      events.push({ structId: attack.attacker_id, typeSlug: atkSlug, names: r ? r.names : [], healthAfter: after });
      if (killed && !attackerDead) {
        attackerDead = true;
        events.push({ structId: attack.attacker_id, typeSlug: atkSlug, names: [destroyName(atk, atkAmbit)], healthAfter: 0 });
      }
    }

    (attack.shots || []).forEach(function (shot) {
      (shot.eventAttackDefenderCounterDetail || []).forEach(function (c) {
        var cs = structsById[c.counterByStructId];
        attackAnim(c.counterByStructId, cs && cs.type_slug, c.counterByStructWeaponSystem);
        attackerHit(c.counterByStructType || (cs && cs.type_name),
          c.counterByStructOperatingAmbit || (cs && cs.ambit),
          c.counterByStructWeaponSystem, numOf(c.counterDamage), truthy(c.counterDestroyedAttacker));
      });
      if (!attackerDead && atk) attackAnim(attack.attacker_id, atkSlug, weapon);

      var tgt = structsById[shot.targetStructId];
      var tgtAmbit = shot.targetStructOperatingAmbit || (tgt && tgt.ambit);
      var hb = numOf(shot.targetHealthBefore), ha = numOf(shot.targetHealthAfter);

      if (truthy(shot.evaded)) {
        var art = EVADE_ART[shot.evadedCause];
        events.push({ structId: shot.targetStructId, typeSlug: tgt && tgt.type_slug,
          names: art ? [art] : [], healthAfter: ha });
      } else if (truthy(shot.evadedByPlanetaryDefenses)
        && shot.evadedByPlanetaryDefensesCause === 'lowOrbitBallisticInterceptorNetwork') {
        var sat = planetaryStructOfType(structsById, 'jamming_satellite');
        if (sat) {
          events.push({ structId: sat.id, typeSlug: sat.type_slug,
            names: [EVADE_ART.lowOrbitBallisticInterceptorNetwork], healthAfter: null });
        }
      }

      if (truthy(shot.blocked) && shot.blockedByStructId) {
        var blocker = structsById[shot.blockedByStructId];
        var bAmbit = shot.blockedByStructOperatingAmbit || (blocker && blocker.ambit);
        var bAfter = numOf(shot.blockerHealthAfter);
        var rb = resolveShotAnimation(atkType, atkAmbit, bAmbit, weapon, bAfter == null ? 1 : bAfter, false, '');
        events.push({ structId: shot.blockedByStructId, typeSlug: blocker && blocker.type_slug,
          names: rb ? rb.names : [], healthAfter: bAfter });
        if (truthy(shot.blockerDestroyed)) {
          events.push({ structId: shot.blockedByStructId, typeSlug: blocker && blocker.type_slug,
            names: [destroyName(blocker, bAmbit)], healthAfter: 0 });
        }
      }

      if (hb != null && ha != null && hb !== ha) {
        var rt = resolveShotAnimation(atkType, atkAmbit, tgtAmbit, weapon, ha, false, '');
        events.push({ structId: shot.targetStructId, typeSlug: tgt && tgt.type_slug,
          names: rt ? rt.names : [], healthAfter: ha });
        if (truthy(shot.targetDestroyed)) {
          events.push({ structId: shot.targetStructId, typeSlug: tgt && tgt.type_slug,
            names: [destroyName(tgt, tgtAmbit)], healthAfter: 0 });
        }
      }

      if (!truthy(shot.targetDestroyed) && truthy(shot.targetCountered)) {
        attackAnim(shot.targetStructId, tgt && tgt.type_slug, shot.targetCounterWeaponSystem);
        attackerHit(shot.targetStructType || (tgt && tgt.type_name), tgtAmbit,
          shot.targetCounterWeaponSystem, numOf(shot.targetCounteredDamage),
          truthy(shot.targetCounterDestroyedAttacker));
      }
    });

    if (truthy(attack.pdc_damage_to_attacker)) {
      var pdc = planetaryStructOfType(structsById, 'planetary_defense_cannon');
      if (pdc) {
        attackAnim(pdc.id, pdc.type_slug, PRIMARY);
        attackerHit('Planetary Defense Cannon', pdc.ambit, PRIMARY, numOf(attack.pdc_damage),
          truthy(attack.pdc_destroyed_attacker));
      }
    }

    // Safety net: whatever the parent detail says the attacker ended on
    // (recoil is not itemised per shot). Step the bar, and play the destroy
    // if it died and nothing above showed it.
    var after = numOf(attack.attacker_health_after);
    if (after != null && after !== running) {
      if (after === 0 && !attackerDead) {
        attackerDead = true;
        events.push({ structId: attack.attacker_id, typeSlug: atkSlug, names: [destroyName(atk, atkAmbit)], healthAfter: 0 });
      } else if (after !== 0) {
        events.push({ structId: attack.attacker_id, typeSlug: atkSlug, names: [], healthAfter: after });
      }
    }
    return events;
  }

  function choreograph(attack) {
    planAttack(attack, state.structsById).forEach(enqueue);
  }

  /* Arrivals and departures between two snapshots.
   *
   * A struct that appears was deployed (planetary) or flew in (fleet); one
   * that vanishes left. Destroyed structs are excluded — their destroy
   * animation has already played from the shot that killed them, and playing
   * a departure over the wreckage would read as an escape. */
  function choreographMovement(before, after) {
    Object.keys(after).forEach(function (id) {
      if (before[id]) return;
      var s = after[id];
      var ambit = String(s.ambit || LAND).toUpperCase();
      enqueue({
        structId: id,
        typeSlug: s.type_slug,
        names: [s.category === 'planet' ? 'DEPLOYMENT_' + ambit : 'MOVE_ARRIVE'],
        healthAfter: null,
      });
    });
    Object.keys(before).forEach(function (id) {
      if (after[id]) return;
      if (state.liveHealth[id] === 0) return;      // destroyed, not departed
      enqueue({ structId: id, typeSlug: before[id].type_slug, names: ['MOVE_DEPART'], healthAfter: null });
    });
  }

  /* The banner the game shows when a raid ends. We render the PLANET OWNER's
   * view throughout, so a beaten-off raider is a victory and a successful raid
   * is a defeat — stated explicitly because the sign is easy to invert. */
  var TERMINAL_BANNER = {
    attackerDefeated: 'VICTORY_BANNER',
    attackerRetreated: 'VICTORY_BANNER',
    raidSuccessful: 'DEFEAT_BANNER',
    // `demilitarized` ends the raid without either side winning — no banner.
  };
  var bannerShownFor = null;

  function showBanner(status) {
    var name = TERMINAL_BANNER[status];
    if (!name) {
      // A non-terminal status means a fresh raid is under way, so re-arm the
      // banner — the same planet gets raided repeatedly (32% recur within an
      // hour) and each ending deserves its own.
      bannerShownFor = null;
      return;
    }
    if (bannerShownFor === status) return;
    bannerShownFor = status;
    if (!window.lottie) return;
    var host = document.getElementById('rv-banner');
    if (!host) return;
    host.innerHTML = '';
    host.style.display = 'flex';
    try {
      var a = window.lottie.loadAnimation({
        container: host, renderer: 'svg', loop: false, autoplay: true,
        path: lottiePath(name, null),
      });
      a.addEventListener('complete', function () {
        setTimeout(function () {
          try { a.destroy(); } catch (e) {}
          host.innerHTML = '';
          host.style.display = 'none';
        }, 2500);
      });
    } catch (e) { host.style.display = 'none'; }
  }

  function truthy(v) { return v === true || v === 'true' || v === 't' || v === 1 || v === '1'; }
  function numOf(v) {
    if (v == null) return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v));
    return isNaN(n) ? null : n;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Header
  // ══════════════════════════════════════════════════════════════════════════


  /* Drive the game's HUD panels from the snapshot. The mapping is the game's
   * own: top-left = energy, top-right = the spectated planet's shield + ore
   * (the game's ENEMY-themed panel, which is what this planet is to a
   * spectator), bottom-left = defender, bottom-right = raider. */
  function renderHeader() {
    var snap = state.snapshot;
    var where = TARGET
      ? (TARGET.kind === 'fleet'
          ? 'FLEET ' + TARGET.id + (snap ? ' · AT PLANET ' + snap.planet_id : ' · IN TRANSIT')
          : 'PLANET ' + TARGET.id)
      : '—';
    setText('rv-where', where);

    // Freshness is the NEWEST of the two signals, not whichever exists.
    // Taking lastEventMs first meant a planet that had one stream event and
    // then went quiet reported "4m ago" forever while 20-second snapshots kept
    // arriving — the feed was healthy and the HUD said it was dead.
    // A missing stamp is 0, and `Date.now() - 0` renders the whole Unix epoch
    // as an age ("17854432765s ago"), so treat that as unknown instead.
    var stamp = Math.max(state.lastEventMs || 0, (snap && snap.fetched_at_ms) || 0);
    var age = stamp > 0 ? Date.now() - stamp : null;
    var live = document.getElementById('rv-live');
    if (live) {
      live.textContent = !snap ? 'connecting'
        : age == null ? 'live'
        : age < 30000 ? 'live' : fmtAge(age);
      live.className = 'rv-live-dot'
        + (age == null || age < 30000 ? '' : (age < 120000 ? ' stale' : ' dead'));
    }
    if (!snap) return;

    // Shield: the game shows the value beside a shield glyph whose state is
    // up/down. `planetaryShield` arrives on the live stream ahead of the next
    // snapshot, so prefer it.
    var shield = state.planetaryShield || snap.planetary_shield || 0;
    // The game's own shield art and vocabulary: secure / vulnerable /
    // breached, drawn from img/non_standard_icons. The `_raid_enemy` suffix is
    // the variant the game uses for a planet that is not yours — which, to a
    // spectator, is always the case.
    var status = state.raidStatus || snap.raid_status;
    var shieldState = shield <= 0 ? 'breached'
      : (status === 'shieldsVulnerable' ? 'vulnerable' : 'secure');
    // The NUMBER only appears while the shield is vulnerable. Secure, its
    // exact value tells a spectator nothing actionable and reads as a health
    // bar it is not (shield does not predict a raid's outcome — it is the
    // proof's difficulty range, a timer). Breached, it is zero by definition.
    // In both of those the glyph alone carries the whole state.
    setText('rv-shield', shieldState === 'vulnerable' ? fmtNum(shield) : '');
    var icon = document.getElementById('rv-shield-icon');
    if (icon && icon.dataset.shieldState !== shieldState) {
      icon.dataset.shieldState = shieldState;
      icon.innerHTML = '<img src="img/non_standard_icons/shield_' + shieldState
        + '_raid_enemy.png" alt="' + shieldState + '" />';
    }
    var shieldRes = document.getElementById('rv-shield-res');
    if (shieldRes) {
      shieldRes.setAttribute('data-sui-tooltip',
        'Planetary shield ' + fmtNum(shield)
        + (shield > 0 ? ' — raids cannot seize until it falls' : ' — DOWN, the planet is vulnerable')
        + (status ? '\nRaid: ' + humanStatus(status) : ''));
    }

    setText('rv-ore', snap.stored_ore == null ? '—' : fmtNum(snap.stored_ore));
    setText('rv-energy', snap.owner_energy || '—');

    // Defender (bottom-left) and raider (bottom-right).
    // The viewer's charge is a fact about THIS player, not the raid, but it
    // arrives on the same snapshot and changes on the same clock.
    if (snap.viewer_charge != null) {
      chatState.myCharge = snap.viewer_charge;
      paintComposerIdentity();
    }
    renderSide('def', snap.owner, snap.owner_name, snap.owner_charge, snap.owner_pfp,
      'Defender — this planet\'s owner');
    var raiding = snap.raiding_fleet || state.raidingFleet;
    var br = document.getElementById('rv-hud-br');
    if (br) br.classList.toggle('hidden', !raiding);
    if (raiding) {
      renderSide('atk', snap.raider_id || raiding, snap.raider_name, snap.raider_charge,
        snap.raider_pfp, 'Raider — fleet ' + raiding);
    }
  }

  /** One HUD action bar: portrait, charge battery, and an identifying tooltip. */
  function renderSide(which, id, name, charge, pfp, label) {
    var portrait = document.getElementById('rv-' + which + '-portrait');
    if (portrait) {
      portrait.setAttribute('data-sui-tooltip',
        label + '\n' + whoLine(name, id)
        + (charge == null ? '' : '\nCharge ' + fmtNum(charge)));
    }
    paintPfp(document.getElementById('rv-' + which + '-pfp'), pfp);
    // Charge drives the 5-chunk battery by the game's OWN ladder, not a linear
    // scale: ChargeCalculator maps raw charge through the thresholds
    // [0,1,2,3,5,8] to a level 0-5. Copied rather than approximated so a
    // spectator reads the same "can this player act?" the owner does.
    paintBattery(document.getElementById('rv-' + which + '-battery'), charge);
  }

  // A portrait is STACKED IMAGE LAYERS, not one file: the chain stores part
  // indices in `pfpClientRenderAttributes` and the client composites them.
  // Same layer order as the game's PfpViewerComponent and the Team Ops roster,
  // so one player looks like the same person everywhere.
  /* The shared composer in pfp.js — the placeholder-on-nothing behaviour this
   * function documented is now its behaviour everywhere.
   *
   * This window is the reason validating matters: the portrait it draws
   * belongs to the player currently attacking you, from a string that player
   * wrote themselves, and this copy checked nothing before putting it in a
   * path.
   */
  function renderPfpInto(host, attrsJson) {
    window.StructsPfp.fillPortrait(host, attrsJson);
  }

  /* Repaint a portrait host, but only when the attributes actually changed.
   *
   * The guard is not an optimisation: `renderSide` runs on every snapshot,
   * several times a second during a raid, and a rebuild that swaps five <img>
   * elements each time makes the two HUD faces flicker.
   */
  function paintPfp(host, attrsJson) {
    if (!host || host.dataset.pfp === (attrsJson || '')) return;
    host.dataset.pfp = attrsJson || '';
    host.innerHTML = '';
    renderPfpInto(host, attrsJson);
  }

  /* Fill a 5-chunk battery from a raw charge, through the game's own ladder.
   *
   * `chargeLevel` is the port of ChargeCalculator's thresholds; this is the
   * paint. Both HUD action bars and the composer use it, because a player
   * comparing their own charge against the defender's must be reading the
   * same scale — that comparison is the whole reason the composer has one.
   */
  function paintBattery(battery, charge) {
    if (!battery) return;
    var level = chargeLevel(charge);
    var chunks = battery.children;
    for (var i = 0; i < chunks.length; i++) {
      chunks[i].classList.toggle('sui-mod-filled', i + 1 <= level);
    }
  }

  /* How this window names a player in a tooltip: "Marklifer (1-194)", falling
   * back to whichever half we have. Three portraits use it — defender, raider
   * and the composer — and they must read alike, because the whole point of
   * the third one is that it sits beside the other two.
   */
  function whoLine(name, id, unknown) {
    return name ? name + ' (' + (id || '?') + ')' : (id || unknown || 'unknown');
  }

  // Port of ChargeCalculator (util/ChargeCalculator.js): raw charge → level 0-5.
  var CHARGE_THRESHOLDS = [0, 1, 2, 3, 5, 8];
  function chargeLevel(charge) {
    if (charge == null) return 0;
    for (var i = 0; i < CHARGE_THRESHOLDS.length; i++) {
      if (charge <= CHARGE_THRESHOLDS[i]) return i;
    }
    return CHARGE_THRESHOLDS.length - 1;
  }

  /** Compact age: 45s / 12m / 3.2h. */
  function fmtAge(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return (s / 3600).toFixed(1).replace(/\.0$/, '') + 'h ago';
  }

  /** `raid_status` / `shieldsVulnerable` → "raid status" / "shields vulnerable". */
  function humanStatus(s) {
    return String(s)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase();
  }
  /* The HUD shows shield and ore RAW, exactly as the game does — its
   * ShieldStatusComponent and StatusBarTopRightComponent both assign the
   * value straight to innerText with no formatter. (The design system's
   * "shorten over 999 as 1.11k" rule belongs to Result Rows and tables, a
   * different component; applying it here would make the spectator disagree
   * with the same planet's own HUD.) */
  function fmtNum(n) {
    return String(Math.round(Number(n) || 0));
  }
  function setText(id, text) {
    var e = document.getElementById(id);
    if (e) e.textContent = text;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Tooltips — a port of the game's SUITooltip (sui/SUITooltip.js)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Same contract as the game's: press and hold (100 ms) on any element
  // carrying `data-sui-tooltip` shows a `.sui-tooltip` bubble positioned above
  // the trigger — or below it when `data-sui-mod-placement="bottom"` — and
  // releasing hides it. Ported rather than imported because the real one is an
  // ES module inside the game bundle, and this window must never load that
  // bundle (same origin as the game: it would share localStorage, which holds
  // the mnemonic). The styling comes from the shipped sui.css either way, so
  // the bubble is the game's, not a lookalike.
  //
  // This is the one piece of HUD interactivity kept live: a tooltip only
  // reveals information, which is precisely a spectator's job.
  function initTooltips() {
    var bubble = document.createElement('div');
    bubble.id = 'rv-tooltip';
    bubble.className = 'sui-tooltip';
    bubble.style.position = 'absolute';
    var timer = null;

    function hide() {
      bubble.classList.remove('sui-mod-show');
      if (bubble.parentElement) bubble.parentElement.removeChild(bubble);
      clearTimeout(timer);
    }

    function show(trigger) {
      clearTimeout(timer);
      if (bubble.parentElement) bubble.parentElement.removeChild(bubble);
      timer = setTimeout(function () {
        var host = trigger.parentElement;
        if (!host) return;
        // The bubble is positioned against its offset parent, so that parent
        // must not be `static` — the same guard the game applies.
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(bubble);
        // Newlines in the data attribute become real line breaks.
        //
        // `esc` is what makes this safe, and it is NOT belt-and-braces: this
        // comment used to say the text was "ours (never user content)", which
        // is false — the defender portrait's tooltip carries a player's
        // on-chain NAME, and players choose those. Escaping each segment
        // before joining is the only thing standing between a name of
        // `<img src=x onerror=…>` and script running in somebody else's raid
        // window. Do not remove it as redundant.
        bubble.innerHTML = String(trigger.dataset.suiTooltip || '')
          .split('\n').map(esc).join('<br>');
        bubble.classList.add('sui-mod-show');
        place(bubble, trigger, trigger.dataset.suiModPlacement === 'bottom');
      }, 100);
    }

    // Horizontally centre, then sit above/below — flipping to the other side
    // when there is not enough room, exactly as SUIUtil does.
    function place(bub, origin, below) {
      var r = origin.getBoundingClientRect();
      // `SUIUtil.horizontallyCenter`, ported in full. Centring plus a
      // `Math.max(0, …)` floor only guards the LEFT edge, so a trigger in the
      // right-hand action bar pushed most of its tooltip past the window —
      // there has to be a matching right-edge case that aligns the bubble's
      // right edge to the trigger's instead.
      if (r.left - (origin.offsetWidth / 2) < bub.offsetWidth / 2) {
        bub.style.left = origin.offsetLeft + 'px';
      } else if ((origin.offsetWidth / 2) + (window.innerWidth - r.right) < bub.offsetWidth / 2) {
        bub.style.left = ((origin.offsetLeft + origin.offsetWidth) - bub.offsetWidth) + 'px';
      } else {
        bub.style.left = (origin.offsetLeft - (bub.offsetWidth - origin.offsetWidth) / 2) + 'px';
      }
      var fitsBelow = (window.innerHeight - r.bottom) >= bub.offsetHeight;
      var fitsAbove = r.top >= bub.offsetHeight;
      var putBelow = below ? (fitsBelow || !fitsAbove) : (!fitsAbove && fitsBelow);
      bub.style.top = putBelow
        ? (origin.offsetTop + origin.offsetHeight) + 'px'
        : (origin.offsetTop - bub.offsetHeight) + 'px';
    }

    function triggerFor(node) {
      for (var n = node; n && n !== document.body; n = n.parentElement) {
        if (n.dataset && n.dataset.suiTooltip) return n;
      }
      return null;
    }

    document.body.addEventListener('mousedown', function (e) {
      var t = triggerFor(e.target);
      if (t) show(t);
    }, { passive: true });
    window.addEventListener('mouseup', hide, { passive: true });
    // A tooltip left showing while the pointer leaves would never clear.
    window.addEventListener('blur', hide, { passive: true });
  }

  /* Escapes BOTH quote characters, not just the double.
   *
   * Its one caller puts the result in element content, where a bare `'` is
   * harmless — so this is not a live hole. It is completed anyway because the
   * next caller is the dangerous one: a helper that is safe in element context
   * and unsafe in a single-quoted attribute is a trap for whoever reuses it,
   * and the Rust `html_escape()` this mirrors already covers both. */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c];
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Battle log — every planet_activity row for this planet
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The deliberate exception to map parity: the game never shows a planet's
  // whole recorded history in one place, and for a spectator that history IS
  // the story. Collapsed by default so the map stays the focus.
  var logState = { rows: [], open: false, loading: false, pending: false, planetId: null };

  function initLog() {
    // The zoom toggle shares this bar; wire it here so both controls in the
    // strip are set up in one place.
    observeBoardViewport();
    wireChat();
    wireComposer();
    var fit = document.getElementById('rv-fit-toggle');
    if (fit) {
      syncFitToggle();
      fit.addEventListener('click', function () {
        setFitMode(fitMode() === 'full' ? 'zoom' : 'full');
      });
    }
    var toggle = document.getElementById('rv-log-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      logState.open = !logState.open;
      document.getElementById('rv-log').classList.toggle('rv-collapsed', !logState.open);
      toggle.textContent = logState.open ? 'hide' : 'show';
      // No refit call here: `observeBoardViewport` watches the scroll box and
      // refits whenever this panel actually changes its height. Doing it from
      // the click handler meant guessing how many frames the panel takes to
      // lay out — one frame was not enough, and the board stayed fitted to a
      // viewport that no longer existed.
      if (logState.open) refreshLog();
    });
  }

  /** How many log rows are kept in memory, for both the initial fetch and the
   * live stream's ceiling. */
  var LOG_LIMIT = 200;

  /** Newest rows off the GRASS stream, prepended in place.
   *
   * The log used to load exactly once — on open, or when a followed fleet
   * re-targeted — so a window left open showed a frozen log while the map
   * animated live next to it. Only a reload caught it up.
   *
   * Rows arrive oldest-first (see `collect_log_rows`), so unshifting each in
   * turn leaves the newest on top, which is the order `mcp_raid_log` serves.
   * Kept even while the panel is collapsed: opening it should show what
   * happened, not restart from the moment it was opened.
   */
  /** Identity of a log row, for the overlap check below. */
  function logKey(r) {
    return (r.date || '') + ' ' + (r.time || '') + '|' + (r.category || '') + '|' + (r.detail || '');
  }

  function applyLog(payload) {
    if (!state.snapshot) return;
    if (payload.generation !== state.generation) return;   // stale planet
    var rows = payload.rows || [];
    if (!rows.length) return;
    // The initial fetch reads history up to NOW while the stream cursor starts
    // 30s back, so the first poll after opening the log re-delivers rows the
    // fetch already has. Check the newest slice rather than keeping a set: the
    // overlap is bounded by that backfill window, so it is always near the top.
    var recent = {};
    logState.rows.slice(0, 60).forEach(function (r) { recent[logKey(r)] = true; });
    rows.forEach(function (r) {
      if (recent[logKey(r)]) return;
      logState.rows.unshift(r);
    });
    // Same ceiling the initial fetch uses, so memory can't creep on a long watch.
    if (logState.rows.length > LOG_LIMIT) logState.rows.length = LOG_LIMIT;
    if (logState.open) renderLog();
  }

  function refreshLog() {
    var planetId = state.snapshot && state.snapshot.planet_id;
    // Opened before the first snapshot arrived: remember that we still owe a
    // load, so the snapshot can trigger it rather than leaving the panel
    // permanently claiming there is no activity.
    if (!planetId) { logState.pending = true; return; }
    if (logState.loading || !window.__TAURI__) return;
    logState.pending = false;
    logState.loading = true;
    window.__TAURI__.core.invoke('mcp_raid_log', { planetId: planetId, limit: LOG_LIMIT })
      .then(function (d) {
        logState.rows = (d && d.rows) || [];
        logState.planetId = planetId;
        renderLog();
      })
      .catch(function (e) { renderLogError(String(e)); })
      .then(function () { logState.loading = false; });
  }

  /* ── Battle log ──────────────────────────────────────────────────────────
     A busy planet writes thousands of rows and most of them are bookkeeping —
     72k `struct_status` and 32k `struct_health` across production against
     1.8k attacks. So the log is built to be SKIMMED, not read:

       · rows are grouped under the day they happened. They arrive strictly
         newest-first, but a bare clock made that look shuffled the moment the
         list crossed midnight (12:51, then 14:46, then 19:28 — three days);
       · each row carries a KIND from the backend, and the kinds have distinct
         weight, so an attack does not look like a status flag flipping;
       · a filter strip drops the routine kinds entirely, which is the only
         way the combat story is legible on a planet that has been built on. */

  /** Per-kind presentation. Order here is the order of the filter strip. */
  var LOG_KINDS = [
    { key: 'combat',   label: 'Combat',   tone: 'rv-bad' },
    { key: 'defense',  label: 'Defense',  tone: 'rv-warn' },
    { key: 'movement', label: 'Movement', tone: '' },
    { key: 'economy',  label: 'Economy',  tone: '' },
    { key: 'state',    label: 'State',    tone: 'rv-dim' }
  ];
  var LOG_TONE = {};
  LOG_KINDS.forEach(function (k) { LOG_TONE[k.key] = k.tone; });

  /** Which kinds are showing. Combat and defense are the story; the rest are
   * available but off, so opening the log lands on something worth reading. */
  var logFilter = { combat: true, defense: true, movement: true, economy: false, state: false };

  /** One word per category. The chain's names are long and mostly prefix
   * ("struct_block_ore_refine_start"), which wrapped the label column and made
   * every row a different height — the single worst thing for skimming. The
   * detail line already names the struct, so the label only has to say what
   * KIND of thing happened. */
  var LOG_LABEL = {
    struct_attack: 'attack',
    raid_status: 'raid',
    shield_change: 'shield',
    block_raid_start: 'raidable',
    struct_defense_add: 'defend',
    struct_defense_remove: 'undefend',
    fleet_arrive: 'arrive',
    fleet_depart: 'depart',
    struct_move: 'move',
    struct_block_build_start: 'build',
    struct_block_ore_mine_start: 'mine',
    struct_block_ore_refine_start: 'refine',
    struct_status: 'status',
    struct_health: 'health'
  };

  /** Label for a category — the short form when we know it, otherwise the
   * humanised chain name so a new category is still readable on day one. */
  function logLabel(category) {
    return LOG_LABEL[category] || humanStatus(category || '');
  }

  /** A row's kind, tolerating an older backend that did not send one. */
  function logKind(r) {
    if (r.kind) return r.kind;
    if (r.category === 'struct_attack' || r.category === 'raid_status') return 'combat';
    return 'state';
  }

  /** "2026-07-31" → "TODAY" / "YESTERDAY" / "WED 30 JUL". Relative labels are
   * worth the arithmetic: on a live raid every row is today, and a date stamp
   * on all of them is noise. */
  function dayLabel(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var days = Math.round((today - d) / 86400000);
    if (days === 0) return 'TODAY';
    if (days === 1) return 'YESTERDAY';
    var DAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return DAY[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]
      + (d.getFullYear() !== today.getFullYear() ? ' ' + d.getFullYear() : '');
  }

  /** The filter strip, rebuilt whenever counts change so each chip can show
   * how much it is hiding — a disabled filter with 4,000 rows behind it should
   * say so rather than leaving the operator wondering where the log went. */
  function renderLogFilters() {
    var host = document.getElementById('rv-log-filters');
    if (!host) return;
    var counts = {};
    logState.rows.forEach(function (r) {
      var k = logKind(r);
      counts[k] = (counts[k] || 0) + 1;
    });
    host.innerHTML = '';
    LOG_KINDS.forEach(function (k) {
      if (!counts[k.key]) return;                 // nothing of this kind here
      var chip = el('a', 'rv-log-chip sui-text-label' + (logFilter[k.key] ? ' rv-on' : ''));
      chip.href = 'javascript: void(0)';
      chip.appendChild(el('span', k.tone || null, k.label));
      chip.appendChild(el('span', 'rv-log-chip-n', String(counts[k.key])));
      chip.addEventListener('click', function () {
        logFilter[k.key] = !logFilter[k.key];
        renderLog();
      });
      host.appendChild(chip);
    });
  }

  function renderLog() {
    var body = document.getElementById('rv-log-body');
    var count = document.getElementById('rv-log-count');
    if (!body) return;
    renderLogFilters();
    body.innerHTML = '';
    if (!logState.rows.length) {
      if (count) count.textContent = '';
      body.appendChild(el('div', 'rv-log-empty sui-text-tiny', 'No recorded activity for this planet yet.'));
      return;
    }
    var shown = logState.rows.filter(function (r) { return logFilter[logKind(r)]; });
    // The count reports what is ON SCREEN over what was fetched — "12/200"
    // makes the filter's effect obvious without reading the chips.
    if (count) {
      count.textContent = shown.length === logState.rows.length
        ? String(logState.rows.length)
        : shown.length + '/' + logState.rows.length;
    }
    if (!shown.length) {
      body.appendChild(el('div', 'rv-log-empty sui-text-tiny',
        'Nothing in the selected categories. ' + logState.rows.length + ' rows hidden.'));
      return;
    }
    var day = null;
    shown.forEach(function (r) {
      if (r.date !== day) {
        day = r.date;
        body.appendChild(el('div', 'rv-log-day sui-text-label', dayLabel(day)));
      }
      var kind = logKind(r);
      var row = el('div', 'rv-log-row rv-k-' + kind + (LOG_TONE[kind] ? ' ' + LOG_TONE[kind] : ''));
      row.appendChild(el('div', 'rv-log-t', r.time || ''));
      row.appendChild(el('div', 'rv-log-cat sui-text-label', logLabel(r.category)));
      row.appendChild(el('div', 'rv-log-d', r.detail || ''));
      body.appendChild(row);
    });
  }

  function renderLogError(msg) {
    var body = document.getElementById('rv-log-body');
    if (body) { body.innerHTML = ''; body.appendChild(el('div', 'rv-log-empty', 'log unavailable: ' + msg)); }
  }

  function note(text, kind) {
    var n = document.getElementById('rv-note');
    n.innerHTML = '';
    if (!text) { n.className = ''; return; }
    n.className = 'on';
    var a = el('div', 'sui-message-inline-alert ' + (kind || 'sui-mod-secondary'));
    a.appendChild(el('i', 'icon-alert sui-icon sui-icon-md'));
    var t = el('div', 'sui-message-inline-alert-text', text);
    a.appendChild(t);
    n.appendChild(a);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Event wiring
  // ══════════════════════════════════════════════════════════════════════════

  function applySnapshot(payload) {
    var snap = payload.snapshot;
    if (!snap) return;
    var generationChanged = payload.generation !== state.generation;
    state.generation = payload.generation;
    state.snapshot = snap;
    // The log is per-planet: load it once the planet is known, and reload it
    // when a followed fleet re-targets us at a DIFFERENT planet (the old
    // planet's history is not this window's subject any more).
    if (logState.open && (logState.pending || logState.planetId !== snap.planet_id)) {
      logState.planetId = snap.planet_id;
      refreshLog();
    }
    if (generationChanged) {
      // The window re-targeted (a followed fleet moved). Nothing from the old
      // planet may survive — including in-flight animations.
      queue.length = 0;
      playing = false;
      stopAllIdle();
      pipClear();
      state.liveHealth = {};
      // A new planet gets its own end-of-raid banner; without this reset the
      // window would refuse to show one after having shown it elsewhere.
      bannerShownFor = null;
    }
    var previous = state.structsById;
    state.structsById = {};
    (snap.structs || []).forEach(function (s) { state.structsById[s.id] = s; });
    // Struct types are cached backend-side and never change; keep the last
    // good catalogue if a snapshot arrives without one rather than emptying
    // the Action Bar mid-raid.
    if (snap.struct_types && Object.keys(snap.struct_types).length) {
      state.structTypes = snap.struct_types;
    }
    state.planetaryShield = snap.planetary_shield;
    state.raidStatus = snap.raid_status;
    // The snapshot is authoritative about who (if anyone) is raiding; drop any
    // stream-tracked raider it contradicts, so a stale value can't keep the
    // enemy action bar open or hold the fog off a quiet planet.
    state.raidingFleet = snap.raiding_fleet || null;

    // Snapshot health is authoritative once the queue has drained; while it is
    // playing, the sequence's own values win.
    if (!playing) state.liveHealth = {};

    // The rebuild replaces every mount, so every idle player must go first or
    // lottie keeps animating into detached nodes forever.
    stopAllIdle();
    buildGrid(snap);
    var unplaced = placeStructs(snap.structs || []);
    (snap.structs || []).forEach(startIdle);
    // Only diff against a real previous state on the same planet — the first
    // snapshot would otherwise deploy the entire garrison at once.
    if (!generationChanged && Object.keys(previous).length) {
      choreographMovement(previous, state.structsById);
    }
    if (snap.raid_status) showBanner(snap.raid_status);
    renderHeader();
    var notices = [];
    if (snap.warning) notices.push(snap.warning);
    if (unplaced) notices.push(unplaced + ' struct(s) had no free tile (a second fleet contests the same slots).');
    if (unmatchedShots) notices.push(unmatchedShots + ' shot(s) had no matching animation and were shown as a health change only.');
    note(notices.join(' ') || null, snap.warning ? 'sui-mod-warning' : 'sui-mod-secondary');
  }

  /* A live delta from the GRASS stream. These arrive INSTANTLY, ahead of the
   * choreography describing them, so they update state and the HUD but never
   * jump the animation queue. */
  function applyDelta(d) {
    state.lastEventMs = Date.now();
    var detail = d.detail || {};

    if (d.category === 'shield_change') {
      var sh = numOf(detail.planetary_shield != null ? detail.planetary_shield : detail.shield);
      if (sh != null) state.planetaryShield = sh;
    } else if (d.category === 'raid_status') {
      state.raidStatus = detail.status || state.raidStatus;
      // Track WHO is raiding, not just the status: the HUD's enemy action bar
      // and the fog of war both key off an attacker being present, and the
      // stream knows seconds before the next snapshot does. A terminal status
      // means the attacker is gone, so the fog should close again.
      var over = TERMINAL_RAID_STATUSES.indexOf(detail.status) >= 0;
      state.raidingFleet = over ? null : (detail.fleet_id || state.raidingFleet);
      renderHeader();
      // The fog spans the attacker half, so its presence changes with theirs.
      if (state.snapshot) buildGrid(state.snapshot);
      // The stream is the first to know a raid ended — several seconds ahead
      // of the next snapshot, which is when the banner should land.
      if (detail.status) showBanner(detail.status);
    } else if (d.category === 'struct_health') {
      var id = detail.struct_id || detail.structId;
      var hp = numOf(detail.health);
      // While a sequence is playing, its own healthAfter values own the bar —
      // otherwise the stream would fast-forward past the frames being drawn.
      if (id && hp != null && !playing) {
        state.liveHealth[id] = hp;
        var s = state.structsById[id];
        var still = document.getElementById(domId('struct', id));
        var hud = document.getElementById(domId('hud', id));
        if (s && still) renderStill(still, s, hp);
        if (s && hud) renderHud(hud, s, hp);
      }
    } else if (d.category === 'struct_status') {
      // Bit 32 is the destroyed flag.
      var sid = detail.struct_id || detail.structId;
      var status = numOf(detail.status);
      if (sid && status != null && (status & 32) !== 0) {
        // ALWAYS update state, even mid-sequence: emptying only the DOM node
        // let syncStill/renderStill resurrect the sprite until the next
        // snapshot. The visual clear still waits for the queue (its own
        // destroy event owns the frames while playing).
        var ds = state.structsById[sid];
        if (ds) ds.destroyed = true;
        state.liveHealth[sid] = 0;
        if (!playing) {
          stopIdle(sid);
          var node = document.getElementById(domId('struct', sid));
          if (node) node.innerHTML = '';
          if (ds) paintBadges(ds);
        }
      }
    }
    renderHeader();
  }

  function applyAttacks(payload) {
    // Before the first snapshot there is nothing to animate ON — processing
    // shots against an empty struct table is exactly what produced "11
    // shot(s) had no matching animation" over a bare terrain grid.
    if (!state.snapshot) return;
    if (payload.generation !== state.generation) return;   // stale planet
    state.lastEventMs = Date.now();
    (payload.attacks || []).forEach(choreograph);
    renderHeader();
  }

  function boot() {
    var T = window.__TAURI__;
    if (!T || !T.event) { setTimeout(boot, 150); return; }
    if (!TARGET) {
      note('This window was opened without a target.', 'sui-mod-destructive');
      return;
    }
    // PULL the first snapshot rather than waiting for a push: the watcher's
    // first emit can fire before these listeners exist, and Tauri drops
    // events nobody is listening for — the map then sat empty until the next
    // 20-second cycle. Same pattern as board.html pulling mcp_board_html.
    // Listeners are attached first so nothing lands in the gap.
    //
    // Names are namespaced with THIS window's label (spectator::emit appends
    // `::<label>`): a plain listen() registers target Any, which Tauri matches
    // against emits aimed at other windows too — without the namespace, two
    // raid windows would receive each other's snapshots and re-render to
    // whichever planet emitted last. The label arrives in the window URL.
    var LABEL = params.label || ('raid-' + (TARGET ? TARGET.id : 'none'));
    function scoped(name) { return name + '::' + LABEL; }
    T.event.listen(scoped('raid-snapshot'), function (e) { applySnapshot(e.payload || {}); });
    T.event.listen(scoped('raid-delta'), function (e) { applyDelta(e.payload || {}); });
    T.event.listen(scoped('raid-attacks'), function (e) { applyAttacks(e.payload || {}); });
    T.event.listen(scoped('raid-log'), function (e) { applyLog(e.payload || {}); });
    T.event.listen(scoped('raid-target-moved'), function (e) {
      var p = e.payload || {};
      note('Fleet ' + p.fleet_id + (p.planet_id ? ' arrived at planet ' + p.planet_id : ' left orbit'),
        'sui-mod-primary');
    });
    T.event.listen(scoped('raid-detached'), function (e) {
      note((e.payload && e.payload.reason) || 'No live location.', 'sui-mod-warning');
    });
    // Keep the "feed" freshness readout honest between events.
    setInterval(renderHeader, 5000);
    renderHeader();
    initTooltips();
    initCheatsheets();
    initLog();

    // Scrolling the animating tile back into view retracts the bubble, and
    // scrolling it out mid-fight brings the bubble back — the same
    // scroll/resize re-evaluation the game's PIP does.
    var sc = document.getElementById('rv-scroll');
    if (sc) sc.addEventListener('scroll', pipUpdateVisibility);
    window.addEventListener('resize', function () {
      setBoardScale();
      pipUpdateVisibility();
    });
    setBoardScale();

    T.core.invoke('mcp_raid_state', {
      planetId: TARGET.kind === 'planet' ? TARGET.id : null,
      fleetId: TARGET.kind === 'fleet' ? TARGET.id : null,
    }).then(function (d) {
      d = d || {};
      if (!d.snapshot) {
        note(d.reason || 'no state available yet', 'sui-mod-warning');
        return;
      }
      // A pushed snapshot may have landed while the pull was in flight; the
      // newer fetched_at wins so a slow pull cannot roll the map backwards.
      var have = state.snapshot ? (state.snapshot.fetched_at_ms || 0) : -1;
      if ((d.snapshot.fetched_at_ms || 0) > have) applySnapshot(d);
    }).catch(function (e) {
      note('could not load the planet: ' + e, 'sui-mod-destructive');
    });
  }

  // Exported for the jsdom harness: the pure pieces are worth asserting on
  // without a signed rebuild.
  window.RaidView = {
    // Bounded id matching — the prefix-collision guard the comms panel needs.
    mentionsObject: mentionsObject,
    resolveShotAnimation: resolveShotAnimation,
    planAttack: planAttack,
    flipsLayer: flipsLayer,
    EVADE_ART: EVADE_ART,
    lottiePath: lottiePath,
    tileUrl: tileUrl,
    artPath: artPath,
    ART: ART,
    ATTACK_RULES: ATTACK_RULES,
    buildColumns: buildColumns,
    slotAt: slotAt,
    colTypeFor: colTypeFor,
    anchorKeyFor: anchorKeyFor,
    planetaryColCount: planetaryColCount,
    buildGrid: buildGrid,
    placeStructs: placeStructs,
    _anchors: function () { return anchors; },
    COL: COL,
    domId: domId,
    _state: state,
    // The comms rail's room state — which of "a room of its own" and "a
    // search across every room" this panel is doing, and the two predicates
    // that everything else keys off.
    _chat: chatState,
    _inRoom: inRoom,
    _reachableRoom: reachableRoom,
    _syncComposer: syncComposer,
    _renderChat: renderChat,
    _objectWord: objectWord,
    _applySnapshot: applySnapshot,
    _applyAttacks: applyAttacks,
    _applyDelta: applyDelta,
    _queue: function () { return queue; },
    isAttackSequence: isAttackSequence,
    // Status-indicator logic is a pure function of (struct, selection) and is
    // the part most likely to drift from the game — assert it directly.
    _badgesFor: badgesFor,
    _visibleIndicators: visibleIndicators,
    _defendersOf: defendersOf,
    stillFlags: stillFlags,
    setBoardScale: setBoardScale,
    _pip: pip,
    _pipOnAnimation: pipOnAnimation,
    _pipOffscreen: pipOffscreen,
    _pipUpdateVisibility: pipUpdateVisibility,
    _pipRequestHide: pipRequestHide,
    injectStructArt: injectStructArt,
    renderDefendWeb: renderDefendWeb,
    selectStruct: selectStruct,
  };

  boot();
})();
