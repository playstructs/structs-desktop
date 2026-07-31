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
  function badgesFor(s) {
    if (playing) return [];                       // a reaction supersedes these
    var sel = state.selectedId ? state.structsById[state.selectedId] : null;
    var out = [];

    if (s.destroyed) {
      // Wreckage announces itself only when you look at it.
      if (sel && sel.id === s.id) out.push('sui-icon-destroyed');
      return out;
    }
    // Offline is ours, not the design system's: a spectator cannot see a
    // power bar anywhere else, and the game shows the same glyph on its own
    // tiles when a struct is unpowered.
    if (s.online === false && s.built !== false) out.push('sui-icon-no-power');

    if (s.defended) {
      if (!sel) out.push('sui-icon-defended');
      else if (sel.protects === s.id) out.push('sui-icon-defended');
    }
    if (s.defending) {
      if (!sel) out.push('sui-icon-defending');
      else if (s.protects === sel.id) out.push('sui-icon-defending');
    }
    if (s.hidden) out.push('sui-icon-stealth-mode');
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
