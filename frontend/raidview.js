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
        { atk: 'Cruiser', from: [WATER], to: [LAND], weapon: PRIMARY },
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
  };

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
  function setBoardScale() {
    var map = document.getElementById('rv-map');
    var sc = document.getElementById('rv-scroll');
    if (!map || !sc) return;
    var avail = (sc.clientWidth || 0) - 36; // padding + the ambit band gutter
    if (avail <= 0) return;                 // not laid out yet (or headless)
    var w = boardCols * 128;
    var scale = avail / w;
    if (scale >= 1) scale = Math.max(1, Math.floor(scale));   // crisp integers up
    else scale = Math.max(0.2, scale);                        // continuous down
    map.style.zoom = scale;
  }

  /* Build the whole board for a snapshot. Returns the anchor map. */
  function buildGrid(snap) {
    var cols = buildColumns(snap.slots);
    var map = document.getElementById('rv-map');
    map.innerHTML = '';
    anchors = {};

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
          band.appendChild(el('span', null, ambit));
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
    setBoardScale();
    return anchors;
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

    if (colType === COL.DEF_CMD || colType === COL.ATK_CMD) {
      // One usable command slot per side per ambit (always slot 0); the
      // second row is blocked, exactly as createCommandSlotTracker deals it.
      if (row === 0) {
        key = 'cmd|' + side + '|' + ambit;
      } else {
        n.appendChild(blockedMarker(ambit));
        return n;
      }
    } else if (colType === COL.DEF_PLAN) {
      var pslot = slotAt(cols, COL.DEF_PLAN, row, colIndex);
      if (pslot >= slotsFor(ambit)) {
        n.appendChild(blockedMarker(ambit));
        return n;
      }
      key = 'plan|' + ambit + '|' + pslot;
      // The beacon renders whether or not the slot is occupied — the game's
      // marker layer never consults occupancy, and the struct simply draws
      // over it. That IS the platform a water struct appears to stand on.
      n.appendChild(beaconMarker(ambit));
    } else {
      var fslot = slotAt(cols, colType, row, colIndex);
      key = 'fleet|' + side + '|' + ambit + '|' + fslot;
    }

    // The mount a struct renders into. Right-side mounts are mirrored so
    // raiders face the planet (.map-struct-layer-tile.mod-side-right).
    var mount = el('div', 'rv-mount' + (side === 'attacker' ? ' rv-flip' : ''));
    n.appendChild(mount);
    anchors[key] = mount;
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
    });
    return unplaced;
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
    // Offline = the no-power badge, from the game's HUD status indicators.
    if (s.online === false && s.built !== false) {
      var badge = el('div', 'rv-status-badges');
      badge.appendChild(el('i', 'sui-icon sui-icon-no-power sui-icon-sm'));
      node.appendChild(badge);
    }
    node.appendChild(el('div', 'rv-tag', s.type_name || s.type_slug || '?'));
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
                 'DEFENSIVE_MANEUVER', 'SIGNAL_JAMMING'];
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
      var animBox = el2('div', 'rv-anim');
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
    playing = true;
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
    var evadeOnly = names.length > 0 && names.every(function (n) {
      return n === 'DEFENSIVE_MANEUVER' || n === 'SIGNAL_JAMMING';
    });
    var destroys = names.some(function (n) { return String(n).indexOf('DESTROY_') === 0; });
    return { during: evadeOnly, after: !destroys };
  }

  function setStillHidden(structId, hidden) {
    var still = document.getElementById(domId('struct', structId));
    if (still) still.classList.toggle('rv-invisible', !!hidden);
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
      }
      // Restore the still unless this was a destroy — and never resurrect a
      // struct the sequence just emptied.
      if (still && flags.after && ev.healthAfter !== 0) syncStill(ev.structId);
      done();
    };

    if (!mount || !window.lottie || !names.length) { finish(); return; }

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
      box.className = 'rv-anim-layer';
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

  /* One attack row becomes: the attacker's weapon animation, then per shot an
   * impact + shake on the target, then a destroy if the shot killed it.
   *
   * Health is threaded through every step from the shot's own
   * targetHealthBefore/After rather than read from live state — by the time
   * this arrives (the activity poll runs seconds behind the stream) live state
   * has already moved to the final value. */
  function choreograph(attack) {
    var atk = state.structsById[attack.attacker_id];
    var atkType = attack.attacker_type || (atk && atk.type_name);
    // The attacker's ambit rides on the PARENT detail
    // (attackerStructOperatingAmbit) — the snapshot is only the fallback.
    var atkAmbit = attack.attacker_ambit || (atk && atk.ambit);
    var weapon = attack.weapon || PRIMARY;

    if (atk) {
      enqueue({
        structId: attack.attacker_id,
        typeSlug: atk.type_slug,
        names: [weapon === SECONDARY ? 'ATTACK_SECONDARY_WEAPON' : 'ATTACK_PRIMARY_WEAPON'],
        healthAfter: null,
      });
    }

    (attack.shots || []).forEach(function (shot) {
      // A blocked shot lands on the BLOCKER, not the nominal target — that is
      // what the player sees, and animating the target would show damage that
      // never happened to it.
      var blocked = truthy(shot.blocked);
      var victimId = blocked && shot.blockedByStructId ? shot.blockedByStructId : shot.targetStructId;
      var victim = state.structsById[victimId];
      var tgtAmbit = blocked
        ? (shot.blockedByStructOperatingAmbit || (victim && victim.ambit))
        : (shot.targetStructOperatingAmbit || (victim && victim.ambit));

      var healthAfter = blocked ? numOf(shot.blockerHealthAfter) : numOf(shot.targetHealthAfter);
      var destroyed = blocked ? truthy(shot.blockerDestroyed) : truthy(shot.targetDestroyed);

      var resolved = resolveShotAnimation(
        atkType, atkAmbit, tgtAmbit, weapon,
        healthAfter == null ? 1 : healthAfter,
        truthy(shot.evaded), shot.evadedCause
      );

      // Even with no matching animation the health still has to land, or the
      // bar would stay wrong until the next snapshot.
      enqueue({
        structId: victimId,
        typeSlug: victim && victim.type_slug,
        names: resolved ? resolved.names : [],
        healthAfter: healthAfter,
      });

      if (destroyed && victim) {
        // Planetary structs sitting on water are destroyed with the LAND
        // animation — they stand on platforms. Straight from the factory.
        var ambit = victim.ambit;
        if (victim.category === 'planet' && ambit === WATER) ambit = LAND;
        enqueue({
          structId: victimId,
          typeSlug: victim.type_slug,
          names: ['DESTROY_' + String(ambit || LAND).toUpperCase()],
          healthAfter: 0,
        });
      }
    });

    // The attacker's own aftermath: counters and recoil land on it
    // (attackerHealthBefore/After on the parent detail). Step its bar down —
    // and when a counter KILLS it (the classic Command-Ship-dies-to-
    // strongCounterAttack ending), play its destroy instead of leaving a
    // ghost until the next snapshot.
    var after = numOf(attack.attacker_health_after);
    var before = numOf(attack.attacker_health_before);
    if (after != null && before != null && after < before) {
      if (after === 0) {
        enqueue({
          structId: attack.attacker_id,
          typeSlug: atk && atk.type_slug,
          names: ['DESTROY_' + String(atkAmbit || LAND).toUpperCase()],
          healthAfter: 0,
        });
      } else {
        enqueue({
          structId: attack.attacker_id,
          typeSlug: atk && atk.type_slug,
          names: [],
          healthAfter: after,
        });
      }
    }
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

    // Freshness is only meaningful once something has actually arrived. A
    // missing stamp is 0, and `Date.now() - 0` renders the whole Unix epoch as
    // an age ("17854432765s ago"), so treat it as unknown instead.
    var stamp = state.lastEventMs || (snap && snap.fetched_at_ms) || 0;
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
    setText('rv-shield', fmtNum(shield));
    // The game's own shield art and vocabulary: secure / vulnerable /
    // breached, drawn from img/non_standard_icons. The `_raid_enemy` suffix is
    // the variant the game uses for a planet that is not yours — which, to a
    // spectator, is always the case.
    var status = state.raidStatus || snap.raid_status;
    var shieldState = shield <= 0 ? 'breached'
      : (status === 'shieldsVulnerable' ? 'vulnerable' : 'secure');
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
        label + '\n' + (name ? name + ' (' + (id || '?') + ')' : (id || 'unknown'))
        + (charge == null ? '' : '\nCharge ' + fmtNum(charge)));
    }
    var img = document.getElementById('rv-' + which + '-pfp');
    if (img && img.dataset.pfp !== (pfp || '')) {
      img.dataset.pfp = pfp || '';
      img.innerHTML = '';
      renderPfpInto(img, pfp);
    }
    // Charge drives the 5-chunk battery by the game's OWN ladder, not a linear
    // scale: ChargeCalculator maps raw charge through the thresholds
    // [0,1,2,3,5,8] to a level 0-5. Copied rather than approximated so a
    // spectator reads the same "can this player act?" the owner does.
    var battery = document.getElementById('rv-' + which + '-battery');
    if (battery) {
      var level = chargeLevel(charge);
      var chunks = battery.children;
      for (var i = 0; i < chunks.length; i++) {
        chunks[i].classList.toggle('sui-mod-filled', i + 1 <= level);
      }
    }
  }

  // A portrait is STACKED IMAGE LAYERS, not one file: the chain stores part
  // indices in `pfpClientRenderAttributes` and the client composites them.
  // Same layer order as the game's PfpViewerComponent and the Team Ops roster,
  // so one player looks like the same person everywhere.
  var PFP_LAYERS = ['background', 'arms', 'body', 'neck', 'head'];

  function renderPfpInto(host, attrsJson) {
    var attrs = null;
    if (attrsJson) { try { attrs = JSON.parse(attrsJson); } catch (e) { attrs = null; } }
    if (attrs && typeof attrs === 'object' && attrs.head != null) {
      PFP_LAYERS.forEach(function (part) {
        if (attrs[part] == null) return;
        var im = el('img', 'pfp-viewer-layer');
        im.src = 'img/pfp/' + part + '/pfp_' + part + '_' + attrs[part] + '.png';
        im.alt = '';
        host.appendChild(im);
      });
      return;
    }
    // No attributes on chain yet — the game shows a placeholder rather than a
    // blank frame, so the HUD keeps its shape.
    var ph = el('img', 'pfp-viewer-layer');
    ph.src = 'img/portrait-placeholder.png';
    ph.alt = '';
    host.appendChild(ph);
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
  function fmtNum(n) {
    var v = Number(n) || 0;
    return v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
      : v >= 1e4 ? Math.round(v / 1e3) + 'k' : String(Math.round(v));
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
        // Newlines in the data attribute become real line breaks; the text is
        // ours (never user content), so this cannot inject markup.
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
      var left = origin.offsetLeft + (origin.offsetWidth / 2) - (bub.offsetWidth / 2);
      bub.style.left = Math.max(0, left) + 'px';
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

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
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

  var LOG_TONE = {
    struct_attack: 'rv-bad', struct_destroyed: 'rv-bad', raid_complete: 'rv-bad',
    raid_status: 'rv-warn', shield_change: 'rv-warn', block_raid_start: 'rv-warn',
  };

  function initLog() {
    var toggle = document.getElementById('rv-log-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      logState.open = !logState.open;
      document.getElementById('rv-log').classList.toggle('rv-collapsed', !logState.open);
      toggle.textContent = logState.open ? 'hide' : 'show';
      if (logState.open) refreshLog();
    });
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
    window.__TAURI__.core.invoke('mcp_raid_log', { planetId: planetId, limit: 200 })
      .then(function (d) {
        logState.rows = (d && d.rows) || [];
        logState.planetId = planetId;
        renderLog();
      })
      .catch(function (e) { renderLogError(String(e)); })
      .then(function () { logState.loading = false; });
  }

  function renderLog() {
    var body = document.getElementById('rv-log-body');
    var count = document.getElementById('rv-log-count');
    if (!body) return;
    if (count) count.textContent = logState.rows.length ? String(logState.rows.length) : '';
    body.innerHTML = '';
    if (!logState.rows.length) {
      body.appendChild(el('div', 'rv-log-empty', 'No recorded activity for this planet yet.'));
      return;
    }
    logState.rows.forEach(function (r) {
      var row = el('div', 'rv-log-row' + (LOG_TONE[r.category] ? ' ' + LOG_TONE[r.category] : ''));
      row.appendChild(el('div', 'rv-log-t', r.time || ''));
      row.appendChild(el('div', 'rv-log-cat', humanStatus(r.category || '')));
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
    state.planetaryShield = snap.planetary_shield;
    state.raidStatus = snap.raid_status;

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
      if (sid && status != null && (status & 32) !== 0 && !playing) {
        stopIdle(sid);
        var node = document.getElementById(domId('struct', sid));
        if (node) node.innerHTML = '';
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
    resolveShotAnimation: resolveShotAnimation,
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
    _applySnapshot: applySnapshot,
    _applyAttacks: applyAttacks,
    _applyDelta: applyDelta,
    _queue: function () { return queue; },
    isAttackSequence: isAttackSequence,
    stillFlags: stillFlags,
    setBoardScale: setBoardScale,
    _pip: pip,
    _pipOnAnimation: pipOnAnimation,
    _pipOffscreen: pipOffscreen,
    _pipUpdateVisibility: pipUpdateVisibility,
  };

  boot();
})();
