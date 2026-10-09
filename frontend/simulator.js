/* Battle Simulator: setup → deploy → battle ⇄ paused → debrief.
 *
 * Setup is local editing. The battle is simulator-chain.js (structsd's
 * combat, block by block) behind simulator-host.js, drawn by raidview.html in
 * an iframe — the same board, Action Bar, animations and battle log a live
 * raid uses.
 */
(function () {
  'use strict';
  var Chain = window.SimulatorChain, Ai = window.SimulatorAi, Host = window.SimulatorHost;
  var $ = function (id) { return document.getElementById(id); };
  var Deck = window.SimDeck;   // COMMAND DECK parts (simdeck.js)
  var AMBITS = Chain.AMBITS, FLAG = Chain.AMBIT_FLAG;
  var TYPES = {};
  window.SimulatorTypes.types.forEach(function (t) { if (t.category === 'fleet') TYPES[t.id] = t; });
  var COMMAND_ID = Object.keys(TYPES).map(Number).filter(function (id) { return TYPES[id].type === 'Command Ship'; })[0];
  var YOU = { id: '1-1', fleetId: '9-1', name: 'You', pfp: '{"background":3,"arms":12,"body":21,"neck":4,"head":33}' };
  var CPU = { id: '1-2', fleetId: '9-2', fleetName: 'Computer', pfp: '{"background":5,"arms":7,"body":40,"neck":8,"head":61}' };
  var SIDES = ['player', 'computer'];
  var LEVELS = ['easy', 'difficult', 'hard'];
  var PRESETS = [
    { id: 'easy', name: 'Easy', enemy: 4 }, { id: 'difficult', name: 'Difficult', enemy: 8 },
    { id: 'hard', name: 'Hard', enemy: 12 }, { id: 'random', name: 'Random', enemy: '6-16' },
  ];
  var BLOCK_TIMES = [{ ms: 2000, name: '2 s', note: 'training' }, { ms: 6000, name: '6 s', note: 'chain' }];
  var MAX_CHARGE = 30;
  var COUNTDOWN = 3;
  var DEBRIEF_DELAY_MS = 2500;   // let the last volley play before the debrief

  var settings = { preset: 'difficult', difficulty: 'difficult', blockMs: Host.BLOCK_MS, charge: { player: 9, computer: 9 } };
  var draft, selection = null, changing = false, picking = null;
  var host = null, initial = null, startHeight = 0, deploying = false;
  var toastTimer, clockTimer, countdownTimer, debriefTimer, debriefShown = false;
  var social = null;   // simulator-social.js, built once the functions below exist

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function format(ms) { var sec = Math.floor(ms / 1000); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }
  /* The toast: the deck's neutral alert band, words only, no action. Empty
   * is hidden (simulator.css #message:empty). */
  function message(text) {
    var box = $('message');
    box.className = '';
    Deck.alert({ into: box, tone: 'neutral', led: false, head: null, detail: String(text) });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.replaceChildren(); box.className = ''; }, 4500);
  }
  function rng(seed) {
    var n = 2166136261;
    String(seed).split('').forEach(function (c) { n = Math.imul(n ^ c.charCodeAt(0), 16777619); });
    return function () { n += 0x6D2B79F5; var t = Math.imul(n ^ n >>> 15, 1 | n); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function fits(t, ambit) { return (t.possibleAmbit & FLAG[ambit]) !== 0; }
  function unitId(side, typeId, ambit, slot) { return side + '-' + (typeId === COMMAND_ID ? 'cmd' : ambit + '-' + slot); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* ── Layouts ───────────────────────────────────────────────────────────── */

  /* Random: each fleet its own size (6–16 structs, Command Ship included) in
   * random slots of random ambits, and half to all of its other structs set to
   * defend a random struct of their own fleet. */
  var RANDOM_MIN = 6, RANDOM_MAX = 16;
  function randomFleet(side, random) {
    var pick = function (list) { return list[Math.floor(random() * list.length)]; };
    var shuffle = function (list) {
      for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(random() * (i + 1)); var t = list[i]; list[i] = list[j]; list[j] = t; }
      return list;
    };
    var cmd = { id: unitId(side, COMMAND_ID), side: side, type: COMMAND_ID, ambit: pick(AMBITS.filter(function (a) { return fits(TYPES[COMMAND_ID], a); })), slot: 0, protects: null };
    var total = RANDOM_MIN + Math.floor(random() * (RANDOM_MAX - RANDOM_MIN + 1));
    var cells = [];
    AMBITS.forEach(function (ambit) { for (var i = 0; i < 4; i++) cells.push({ ambit: ambit, slot: i }); });
    var units = shuffle(cells).slice(0, total - 1).map(function (c) {
      var type = pick(Object.keys(TYPES).map(Number).filter(function (id) { return id !== COMMAND_ID && fits(TYPES[id], c.ambit); }));
      return { id: unitId(side, type, c.ambit, c.slot), side: side, type: type, ambit: c.ambit, slot: c.slot, protects: null };
    });
    var fleet = [cmd].concat(units);
    var guards = shuffle(units.filter(function (u) { return TYPES[u.type].canDefend; }));
    var share = 0.5 + random() * 0.5;
    guards.slice(0, Math.max(units.length ? 1 : 0, Math.round(units.length * share))).forEach(function (u) {
      u.protects = pick(fleet.filter(function (v) { return v !== u; })).id;
    });
    return fleet;
  }

  function layout(mode, seed) {
    var random = rng(seed), units = [];
    if (mode === 'random') {
      SIDES.forEach(function (side) { units = units.concat(randomFleet(side, random)); });
      return units;
    }
    SIDES.forEach(function (side) {
      // Easy and Difficult open with the Command Ships on land; Hard keeps
      // them in space; Random draws one.
      var cmdAmbit = mode === 'random' ? AMBITS[Math.floor(random() * 4)] : mode === 'hard' ? 'space' : 'land';
      units.push({ id: unitId(side, COMMAND_ID), side: side, type: COMMAND_ID, ambit: cmdAmbit, slot: 0, protects: null });
      AMBITS.forEach(function (ambit) {
        var types = Object.keys(TYPES).map(Number).filter(function (id) { return id !== COMMAND_ID && fits(TYPES[id], ambit); });
        var count = side === 'player' ? 2 : mode === 'easy' ? 1 : mode === 'hard' ? 3 : 2;
        for (var i = 0; i < count; i++) {
          var type = types[mode === 'random' ? Math.floor(random() * types.length) : i % types.length];
          var u = { id: unitId(side, type, ambit, i), side: side, type: type, ambit: ambit, slot: i, protects: null };
          if (mode !== 'easy' && i === 0 && ambit === cmdAmbit && TYPES[type].canDefend) u.protects = unitId(side, COMMAND_ID);
          units.push(u);
        }
      });
    });
    return units;
  }

  function validate(units) {
    if (!Array.isArray(units) || units.length > 34) throw Error('A fleet has one command ship and four slots per ambit.');
    SIDES.forEach(function (side) {
      if (units.filter(function (u) { return u && u.side === side && u.type === COMMAND_ID; }).length !== 1) throw Error('Each fleet needs exactly one command ship.');
    });
    var ids = {};
    units.forEach(function (u) {
      var t = TYPES[u.type];
      if (!t || SIDES.indexOf(u.side) < 0 || AMBITS.indexOf(u.ambit) < 0 || !fits(t, u.ambit)
        || !Number.isInteger(u.slot) || u.slot < 0 || u.slot > 3 || u.id !== unitId(u.side, u.type, u.ambit, u.slot) || ids[u.id]) {
        throw Error('Invalid fleet layout.');
      }
      ids[u.id] = u;
    });
    units.forEach(function (u) {
      if (u.protects == null) return;
      var ward = ids[u.protects];
      if (typeof u.protects !== 'string' || !ward || ward.side !== u.side || ward === u || !TYPES[u.type].canDefend) throw Error('A defender guards a struct of its own fleet.');
    });
  }

  /* The same fleet flown by the other side: ids follow the side, wards with them. */
  function reside(u, side) {
    return { id: unitId(side, u.type, u.ambit, u.slot), side: side, type: u.type, ambit: u.ambit, slot: u.slot, protects: u.protects ? u.protects.replace(/^[a-z]+-/, side + '-') : null };
  }
  function swapped(units) { return units.map(function (u) { return reside(u, u.side === 'player' ? 'computer' : 'player'); }); }

  /* ── Reading a fleet ───────────────────────────────────────────────────── */

  function weapons(t) {
    return ['primaryWeapon', 'secondaryWeapon'].filter(function (ws) {
      var w = Chain.weaponField(t, ws, '');
      return w && w !== 'noActiveWeaponry';
    });
  }
  function reachFrom(t, ws, from) { return AMBITS.filter(function (to) { return Chain.canTargetAmbit(t, ws, from, to); }); }
  function reachOf(side, units) {
    var out = {};
    units.forEach(function (u) {
      if (u.side !== side) return;
      weapons(TYPES[u.type]).forEach(function (ws) { reachFrom(TYPES[u.type], ws, u.ambit).forEach(function (a) { out[a] = true; }); });
    });
    return out;
  }
  function weaponInfo(t, ws) { return { charge: Chain.weaponField(t, ws, 'Charge') || 0 }; }

  /** Readiness: what stops a start, and what is only worth knowing. */
  function readiness(units) {
    var out = [];
    try { validate(units); } catch (e) { out.push({ blocking: true, text: e.message }); }
    var you = units.filter(function (u) { return u.side === 'player'; });
    var cmd = you.filter(function (u) { return u.type === COMMAND_ID; })[0];
    var reach = reachOf('player', units);
    var held = {};
    units.forEach(function (u) { if (u.side === 'computer') held[u.ambit] = true; });
    var blind = AMBITS.filter(function (a) { return held[a] && !reach[a]; });
    if (blind.length) out.push({ text: 'None of your weapons reach the enemy in ' + blind.join(', ') });
    if (cmd && !you.some(function (u) { return u.protects === cmd.id; })) out.push({ text: 'Your command ship has no defender' });
    var costs = [];
    you.forEach(function (u) { weapons(TYPES[u.type]).forEach(function (ws) { costs.push(weaponInfo(TYPES[u.type], ws).charge); }); });
    var cheapest = costs.length ? Math.min.apply(null, costs) : 0;
    if (costs.length && settings.charge.player < cheapest) out.push({ text: 'Opening charge ' + settings.charge.player + ' is below your cheapest weapon (' + cheapest + ')' });
    return out;
  }

  /* ── Art ───────────────────────────────────────────────────────────────── */

  /* An ambit's terrain, as the game's tile art (structs are SimDeck.ship). */
  function tileStyle(node, ambit) { node.style.backgroundImage = "url('img/tiles/" + ambit + '/' + ambit + "-1-2-top-middle.png')"; }

  /* ── Mission panel (COMMAND DECK) ──────────────────────────────────────── */

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function slugOf(typeId) { return Host.typeSlug(TYPES[typeId].type); }
  function blockLabel(ms) { var b = BLOCK_TIMES.filter(function (x) { return x.ms === ms; })[0]; return b ? b.name : (ms / 1000) + ' s'; }

  /* Block time: a segmented switch. Built once per box (the Mission panel's
   * and the Paused card's are two groups) and set in place after, so a
   * keyboard pick keeps its focus. */
  function renderBlockTime(box) {
    if (!box) return;
    if (box._blockTime) { box._blockTime.set(settings.blockMs); return; }
    box._blockTime = Deck.seg({
      into: box, labelledby: box.dataset.labelledby,
      options: BLOCK_TIMES.map(function (bt) { return { value: bt.ms, label: bt.name, sub: bt.note }; }),
      current: settings.blockMs,
      onPick: function (v) {
        settings.blockMs = Number(v);
        if (host) host.setBlockMs(settings.blockMs);
        renderBlockTime($('block-time')); renderBlockTime($('pause-block-time'));
        if (draft) renderChecks();
        renderStatus();
      },
    });
  }
  // The enemy's count on its Encounter card.
  function enemyCount(p) { return String(p.enemy); }

  /* The cheapest shot a side's fleet can fire: the charge its first volley waits on. */
  function cheapestShot(side) {
    var costs = [];
    draft.forEach(function (u) {
      if (u.side !== side) return;
      weapons(TYPES[u.type]).forEach(function (ws) { costs.push(weaponInfo(TYPES[u.type], ws).charge); });
    });
    return costs.length ? Math.min.apply(null, costs) : 0;
  }
  /* Opening charge: one slim battery per side, built once and then only set,
   * so a drag or the keyboard keeps its hold through every re-render. */
  var batteries = null;
  function renderCharges() {
    var fixed = social.locked();
    if (!batteries) {
      batteries = {};
      SIDES.forEach(function (side) {
        var you = side === 'player';
        batteries[side] = Deck.battery({
          id: you ? 'charge-player' : 'charge-cpu', side: you ? 'you' : 'foe', slim: true, max: MAX_CHARGE,
          label: you ? 'You' : 'Computer', ariaLabel: you ? 'Your opening charge' : 'Computer opening charge',
          value: settings.charge[side],
          // The Matchup reads the charge too; the battery itself is only set,
          // so a drag or the keyboard keeps its hold.
          onInput: function (v) { settings.charge[side] = Math.max(0, Math.min(MAX_CHARGE, v)); renderCharges(); renderChecks(); if (!selection) renderInspector(); },
        });
        $('charges').appendChild(batteries[side].root);
      });
    }
    SIDES.forEach(function (side) {
      var charge = settings.charge[side], cheapest = cheapestShot(side), wait = cheapest - charge;
      batteries[side].set({
        value: charge, mark: cheapest, disabled: fixed,
        label: side === 'player' ? 'You' : (social.opponentName() || 'Computer'),
        hint: fixed ? 'fixed by challenge' : !cheapest ? '' : wait <= 0 ? 'shot ready' : 'first shot in ' + plural(wait, 'block'),
      });
    });
  }

  var encounterCards = null, opponentRank = null;
  function renderRound() {
    if (!encounterCards) {
      encounterCards = Deck.cards({
        into: $('encounters'), labelledby: 'enc-l', current: settings.preset,
        items: PRESETS.map(function (p) {
          return { value: p.id, label: p.name, count: enemyCount(p), rank: LEVELS.indexOf(p.id) + 1, dice: p.id === 'random', title: 'Enemy structs' };
        }),
        onPick: function (id) {
          settings.preset = id;
          // Random rolls a fresh battle on every click, selected or not.
          if (id === 'random') $('seed').value = Math.random().toString(36).slice(2, 10);
          else settings.difficulty = id;
          loadLayout();
        },
      });
    } else encounterCards.set(settings.preset);
    if (!opponentRank) {
      opponentRank = Deck.rank({
        into: $('ai-level'), cls: 's-opp', level: settings.difficulty, disabled: social.locked(),
        onPick: function (lv) { settings.difficulty = lv; renderRound(); if (draft) renderChecks(); },
      });
    } else opponentRank.set(settings.difficulty, social.locked());
    renderBlockTime($('block-time'));
    renderCharges();
  }

  /* ── Setup board ───────────────────────────────────────────────────────── */

  function selected() { return selection && draft.find(function (u) { return u.id === selection.id; }); }
  function select(sel) { selection = sel; changing = false; renderSetup(); }
  function selectUnit(u) { select({ side: u.side, ambit: u.ambit, slot: u.slot, command: u.type === COMMAND_ID, id: u.id }); }

  /* An armed board pick — the Map Viewer's Move ('Select Tile') and Defend
   * ('Select Struct') — is `picking = { action: 'move' | 'defend', id }`. A
   * second press, Escape, or a click anywhere the pick cannot land cancels. */
  function arm(action, u) { picking = { action: action, id: u.id }; changing = false; renderSetup(); }
  function disarm() { picking = null; renderSetup(); }
  function moveTo(u, ambit) {
    u.ambit = ambit;
    if (selection && selection.id === u.id) selection.ambit = ambit;
    picking = null;
    renderSetup();
  }

  function wardOf(u) { return u && u.protects ? draft.find(function (v) { return v.id === u.protects; }) : null; }
  function guarded(u) { return draft.some(function (v) { return v.protects === u.id; }); }
  /* Can `s` hit `v` from where it stands: any of its weapons reaching v's ambit. */
  function canHit(s, v) {
    var t = TYPES[s.type];
    return v.side !== s.side && weapons(t).some(function (ws) { return Chain.canTargetAmbit(t, ws, s.ambit, v.ambit); });
  }
  function reachLabel(who, map) {
    var lit = AMBITS.filter(function (a) { return map[a]; });
    var list = lit.length < 2 ? lit.join('') : lit.slice(0, -1).join(', ') + ' and ' + lit[lit.length - 1];
    return who + ' ' + (lit.length === 4 ? 'reaches every ambit' : lit.length ? 'reaches ' + list : 'reaches nothing');
  }

  /* The fleet board: four ambit bands of [command][2x2 yours][spine][2x2
   * theirs][command], every tile a deck tile that also keeps the board's
   * legacy hooks (.slot, .friendly/.enemy, .selected, .eligible,
   * .sim-move-target, .dim, data-unit). */
  function renderSetup() {
    if (selection && selection.id && !selected()) selection.id = null;
    var arena = $('arena');
    var had = arena.contains(document.activeElement) ? document.activeElement.dataset.cell : null;
    arena.replaceChildren();
    var pickerUnit = picking && draft.find(function (u) { return u.id === picking.id; });
    if (picking && !pickerUnit) picking = null;
    var moving = !!pickerUnit && picking.action === 'move';
    var fixed = social.locked();
    var sel = selected();
    AMBITS.forEach(function (ambit) {
      var band = el('div', null, 'd-band band ' + ambit);
      band.setAttribute('role', 'group');
      band.setAttribute('aria-label', cap(ambit));
      tileStyle(band, ambit);
      var spine = band.appendChild(el('span', null, 'd-spine'));
      spine.setAttribute('aria-hidden', 'true');
      spine.append(Deck.sprite(ambit), el('span', cap(ambit), 'd-spine-t'));
      SIDES.forEach(function (side) {
        var you = side === 'player';
        for (var i = -1; i < 4; i++) {
          var command = i === -1, slot = command ? 0 : i;
          var u = draft.find(function (v) { return v.side === side && v.ambit === ambit && (command ? v.type === COMMAND_ID : v.type !== COMMAND_ID && v.slot === slot); });
          // An empty command post is drawn only as a Move's landing tile.
          var post = command && !u && moving && side === pickerUnit.side && fits(TYPES[pickerUnit.type], ambit);
          if (command && !u && !post) continue;
          var isSel = u ? !!selection && selection.id === u.id
            : !!selection && !selection.id && selection.side === side && selection.ambit === ambit && !selection.command && selection.slot === slot;
          var target = false, dim = false, hit = false;
          if (pickerUnit) {
            target = moving ? post : !!u && u.side === pickerUnit.side && u !== pickerUnit;
            dim = !target && u !== pickerUnit && (side !== pickerUnit.side || moving);
            isSel = u === pickerUnit;
          } else if (sel && u) {
            hit = canHit(sel, u);
          }
          var ward = wardOf(u);
          var label = post ? 'Move the command ship to ' + ambit
            : !u ? (you ? 'Empty slot, ' : 'Enemy empty slot, ') + ambit + ' slot ' + (slot + 1)
            : (you ? '' : 'Enemy ') + TYPES[u.type].type + ', ' + ambit + (command ? ' command' : ' slot ' + (slot + 1))
              + (ward ? ', guarding the ' + TYPES[ward.type].type : '') + (isSel ? ', selected' : '') + (hit ? ', in reach' : '')
              + (target && !moving ? ', can be guarded' : '');
          var b = Deck.tile({
            side: you ? 'friend' : 'foe', cmd: command, empty: !u, slug: u ? slugOf(u.type) : null,
            selected: !!u && isSel, slotOn: !u && isSel, target: hit, eligible: target, dim: dim,
            hp: u && isSel ? [TYPES[u.type].maxHealth, TYPES[u.type].maxHealth] : null,
            defending: !!ward, defended: !!u && guarded(u), plus: !post && !fixed, label: label,
            // A challenge's fleets are its identity: looked at, not changed.
            disabled: !pickerUnit && !u && fixed,
          });
          b.classList.add('slot', you ? 'friendly' : 'enemy');
          if (command) b.classList.add('command');
          if (isSel) b.classList.add('selected');
          if (target) b.classList.add(moving ? 'sim-move-target' : 'eligible');
          if (dim) b.classList.add('dim');
          b.style.gridColumn = command ? (you ? '1' : '7') : String(you ? 2 + Math.floor(slot / 2) : 6 - Math.floor(slot / 2));
          b.style.gridRow = command ? '1 / 3' : String(slot % 2 + 1);
          b.dataset.cell = side + ':' + ambit + ':' + (command ? 'cmd' : slot);
          if (u) b.dataset.unit = u.id;
          if (pickerUnit) {
            b.addEventListener('click', function (u, ambit, target) {
              if (!target) disarm();
              else if (moving) moveTo(pickerUnit, ambit);
              else setWard(pickerUnit, u.id);
            }.bind(null, u, ambit, target));
          } else {
            b.addEventListener('click', function (side, ambit, slot, command, u) {
              if (u) selectUnit(u); else select({ side: side, ambit: ambit, slot: slot, command: command, id: null });
            }.bind(null, side, ambit, slot, command, u));
          }
          band.appendChild(b);
        }
      });
      arena.appendChild(band);
    });
    if (had) { var back = arena.querySelector('[data-cell="' + had + '"]'); if (back && !back.disabled) back.focus({ preventScroll: true }); }
    document.body.classList.toggle('sim-picking', !!pickerUnit);
    // While a pick waits on the board, the round cannot be changed under it.
    var roundCol = document.querySelector('.sim-round-col') || $('round');
    if (roundCol) roundCol.inert = !!pickerUnit;
    var count = function (side) { return String(draft.filter(function (u) { return u.side === side; }).length); };
    $('count-you').textContent = count('player');
    $('count-cpu').textContent = count('computer');
    $('reach-you').replaceChildren(Deck.reach(reachOf('player', draft), { label: reachLabel('Your fleet', reachOf('player', draft)) }));
    $('reach-cpu').replaceChildren(Deck.reach(reachOf('computer', draft), { label: reachLabel(social.opponentName() || 'Computer', reachOf('computer', draft)) }));
    renderCharges();
    renderChecks();
    renderInspector();
    drawDefWeb();
    social.renderSetup();
    renderStatus();
  }

  /* The guard line: for the selected struct, dashed lines from each of its
   * defenders to it and from it to its ward, edge to edge, a square end mark
   * at each end — the Map Viewer's .rv-defweb, on the setup board, clear of
   * the structs' art. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function drawDefWeb() {
    var arena = $('arena');
    var old = arena.querySelector('.sim-defweb');
    if (old) old.remove();
    var u = selected();
    if (!u) return;
    var links = draft.filter(function (v) { return v.protects === u.id; }).map(function (v) { return [v, u]; });
    var ward = u.protects && draft.find(function (v) { return v.id === u.protects; });
    if (ward) links.push([u, ward]);
    if (!links.length) return;
    // Offsets, not client rects: the window is drawn at the game's 2x or 4x,
    // and the web lives inside that scale.
    function box(v) {
      var n = arena.querySelector('.slot[data-unit="' + v.id + '"]');
      if (!n) return null;
      var x = 0, y = 0;
      for (var p = n; p && p !== arena; p = p.offsetParent) { x += p.offsetLeft; y += p.offsetTop; }
      return { cx: x + n.offsetWidth / 2, cy: y + n.offsetHeight / 2, hw: n.offsetWidth / 2, hh: n.offsetHeight / 2 };
    }
    // Where the line from r's centre towards (dx, dy) leaves r.
    function edge(r, dx, dy) {
      if (!dx && !dy) return { x: r.cx, y: r.cy, t: 0 };
      var t = Math.min(dx ? r.hw / Math.abs(dx) : Infinity, dy ? r.hh / Math.abs(dy) : Infinity);
      return { x: r.cx + dx * t, y: r.cy + dy * t, t: t };
    }
    var foe = u.side === 'computer' ? ' is-foe' : '';
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sim-defweb' + (foe ? ' sim-enemy' : ''));
    svg.setAttribute('aria-hidden', 'true');
    var ends = [];
    links.forEach(function (l) {
      var ra = box(l[0]), rb = box(l[1]);
      if (!ra || !rb) return;
      var dx = rb.cx - ra.cx, dy = rb.cy - ra.cy;
      var a = edge(ra, dx, dy), b = edge(rb, -dx, -dy);
      if ((dx || dy) && a.t + b.t >= 1) return;   // the tiles touch: nothing between them to draw
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'd-guardline' + foe);
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      svg.appendChild(line);
      ends.push(a, b);
    });
    // The end marks over the lines, the defending end first.
    ends.forEach(function (p) {
      var mark = document.createElementNS(SVG_NS, 'rect');
      mark.setAttribute('class', 'd-guardline-end' + foe);
      mark.setAttribute('x', p.x - 2); mark.setAttribute('y', p.y - 2);
      mark.setAttribute('width', 4); mark.setAttribute('height', 4);
      svg.appendChild(mark);
    });
    if (svg.childNodes.length) arena.appendChild(svg);
  }

  /* Readiness, in the command bar: the first thing that stops a start, else
   * the warnings, else what the battle is. */
  function renderChecks() {
    var list = readiness(draft);
    var block = list.filter(function (c) { return c.blocking; })[0];
    var warns = list.filter(function (c) { return !c.blocking; });
    var n = function (side) { return draft.filter(function (u) { return u.side === side; }).length; };
    var to = social.addressed(), detail;
    if (social.isChallenge() && social.locked()) {
      var v = social.view(), top = v && v.ladder && v.ladder[0];
      detail = social.battleName() + (top && top.outcome && top.outcome.time ? ' · best ' + top.outcome.time : '');
    } else if (social.isLive()) {
      // The match's own battle and block time live in its code, not the board's settings.
      detail = social.battleName() + ' · with ' + (social.opponentName() || 'Guest');
    } else if (to) {
      detail = cap($('seed').value || 'battle') + ' · for ' + to.name;
    } else {
      detail = n('player') + ' v ' + n('computer') + ' · charge ' + settings.charge.player + ' · ' + blockLabel(settings.blockMs) + ' blocks';
    }
    var tone = block ? 'bad' : warns.length ? 'warn' : 'ok';
    var head = block ? 'Can’t start' : warns.length ? plural(warns.length, 'warning') : 'Ready';
    detail = block ? block.text : warns.length ? warns[0].text : detail;
    // A live lobby's readiness is the two players', not the fleet's (it is fixed).
    var lob = !block && social.lobby();
    if (lob) {
      var other = lob.other || 'a guest';
      tone = lob.role === 'watch' || lob.mine ? 'ok' : 'warn';
      head = lob.role === 'watch' ? 'Watching' : lob.mine && lob.theirs ? 'Starting' : lob.mine ? 'Ready' : lob.other ? 'Not ready' : 'Waiting';
      detail = lob.role === 'watch' ? social.battleName() : lob.mine && !lob.theirs ? 'waiting for ' + other
        : !lob.other ? 'for ' + other : social.battleName() + ' · with ' + other;
    }
    Deck.ready({
      into: $('checks'),
      tone: tone,
      head: head,
      detail: detail,
      title: list.map(function (c) { return c.text; }).join('; '),
    });
    // Both launches wait on the same fleets: the computer's and a person's.
    $('start').disabled = !!block;
    $('play-live').disabled = !!block;
    fitCommand();
  }

  /* ── Inspector (COMMAND DECK) ──────────────────────────────────────────── */
  /* The right-hand panel, rebuilt with the board. Nothing selected: the
   * Matchup. An empty slot (or Change): Deploy. A struct: its Inspector —
   * hero, facts, the four action keys, weapons, guard — amber while a pick
   * waits on the board. */

  /* One action key. The inspector is rebuilt under it, so focus goes where
   * the next step is (refocus). */
  function abilityKey(ability, glyph, caption, pressed, disabled, onClick) {
    return Deck.key({
      ability: ability, glyph: glyph, caption: caption, title: caption, pressed: pressed, disabled: disabled,
      onClick: function () { onClick(); refocus(ability); },
    });
  }
  /* Focus goes where the next step is — a target on the board while a pick
   * waits, else the same key, else the selected slot. */
  function refocus(name) {
    var t = (picking && document.querySelector('#arena .slot.sim-move-target, #arena .slot.eligible'))
      || (changing && document.querySelector('#inspector .d-card.is-struct[aria-current="true"]:not(:disabled), #inspector .d-card.is-struct:not(:disabled)'))
      || document.querySelector('#inspector [data-ability="' + name + '"]:not(:disabled)')
      || document.querySelector('#arena .slot.selected');
    if (t && t !== document.activeElement) t.focus();
  }
  function whereOf(sel) { return cap(sel.ambit) + (sel.command ? ' · Command' : ' · Slot ' + (sel.slot + 1)); }
  /* Deselect: focus goes back to the tile that was selected. */
  function deselectBtn() {
    return Deck.iconBtn({ glyph: 'close', label: 'Deselect', onClick: function () {
      var was = document.querySelector('#arena .slot.selected');
      var cell = was && was.dataset.cell;
      select(null);
      var back = cell && document.querySelector('#arena [data-cell="' + cell + '"]');
      if (back && !back.disabled) back.focus();
    } });
  }
  /* A type's facts: health, then its counter and its evade when it has them. */
  function typeFacts(t) {
    var out = [];
    var first = [{ hp: [t.maxHealth, t.maxHealth] }];
    if (t.counterAttack) first.push({ sprite: 'counter-attack', text: 'Counter', n: t.counterAttack });
    out.push(Deck.facts(first));
    if (t.unitDefenses && !/^no[A-Z]/.test(t.unitDefenses)) {
      out.push(Deck.facts([{ sprite: 'deflector-shield', text: t.unit_defenses_label || cap(t.unitDefenses), unit: 'Evade' }]));
    }
    return out;
  }
  /* A type's weapon rows, their reach read from `ambit`. */
  function weaponRows(t, ambit) {
    var box = el('div', null, 's-weapons');
    weapons(t).forEach(function (ws) {
      box.appendChild(Deck.weapon({
        kind: Chain.weaponField(t, ws, 'Control') === 'guided' ? 'smart' : 'ballistic',
        name: t[ws === 'secondaryWeapon' ? 'secondary_weapon_label' : 'primary_weapon_label'] || cap(String(Chain.weaponField(t, ws, ''))),
        dmg: Chain.weaponField(t, ws, 'Damage') || 0,
        cost: weaponInfo(t, ws).charge,
        reach: reachFrom(t, ws, ambit),
      }));
    });
    return box;
  }
  function maxDamage(t) { return weapons(t).reduce(function (m, ws) { return Math.max(m, Chain.weaponField(t, ws, 'Damage') || 0); }, 0); }

  function renderInspector() {
    var box = $('inspector');
    box.className = 'd-panel';
    if (!selection) { renderMatchup(box); return; }
    var u = selected(), fixed = social.locked();
    if (!u || (changing && !fixed)) { renderDeploy(box, u, fixed); return; }
    renderStruct(box, u, picking && picking.id === u.id ? picking.action : null, fixed);
  }

  /* A) Nothing selected: the two fleets, side by side, and the objective. */
  function renderMatchup(box) {
    var side = function (s) { return draft.filter(function (u) { return u.side === s; }); };
    var you = side('player'), them = side('computer');
    var p = Deck.panel({ into: box, tag: 'aside', label: 'Matchup', glyph: 'fleet-tile', title: 'Matchup', right: [you.length + ' v ' + them.length],
      foot: [Deck.sprite('destroyed', 16), el('span', 'Destroy their command ship', 'd-txt d-amber s-objective-t')] });
    p.foot.classList.add('s-objective');
    var cmd = slugOf(COMMAND_ID);
    var hero = Deck.hero({ ambit: 'land', cls: 's-duel' });
    hero.append(Deck.ship(cmd, 64), Deck.vs(), Deck.ship(cmd, 64, { foe: true }));
    hero.setAttribute('aria-hidden', 'true');
    p.root.insertBefore(hero, p.body);
    var inAmbit = function (list, a) { return list.filter(function (u) { return u.ambit === a; }).length; };
    var open = function (list) { return 16 - list.filter(function (u) { return u.type !== COMMAND_ID; }).length; };
    var cover = function (list) { return list.filter(guarded).length; };
    var rows = AMBITS.map(function (a) { return { ic: Deck.sprite(a), label: cap(a), you: inAmbit(you, a), them: inAmbit(them, a) }; }).concat([
      { ic: Deck.sprite('defended', 16), label: 'Guarded', you: cover(you), them: cover(them) },
      { ic: Deck.glyph('add', 16), label: 'Open slots', you: open(you), them: open(them) },
      { ic: Deck.mini(3, { bare: true }), label: 'Charge', you: settings.charge.player, them: settings.charge.computer },
    ]);
    p.body.appendChild(Deck.stats({ cls: 's-tape', head: {}, sprites: true, rows: rows }));
  }

  /* B) An empty slot, or Change: the types that fit the band, and the one
   * under the pointer (or focus; it rests on the current type or the first). */
  function renderDeploy(box, current, fixed) {
    var ambit = selection.ambit, foe = selection.side === 'computer';
    var p = Deck.panel({ into: box, tag: 'aside', tone: foe ? 'enemy' : 'player', label: 'Deploy', sprite: ambit, title: whereOf(selection), right: [deselectBtn()] });
    var hero = Deck.hero({ ambit: ambit, short: true });
    var slotTile = Deck.tile({ side: foe ? 'foe' : 'friend', empty: true, slotOn: true, eligible: true, static: true });
    slotTile.setAttribute('aria-hidden', 'true');
    hero.appendChild(slotTile);
    p.root.insertBefore(hero, p.body);
    var ids = Object.keys(TYPES).map(Number).filter(function (id) { return id !== COMMAND_ID && fits(TYPES[id], ambit); });
    var sec = Deck.sec('Deploy', ids.length + ' fit ' + ambit);
    var grid = el('div', null, 'd-cards is-struct-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Structs that fit ' + ambit);
    var preview = el('div', null, 's-id s-preview');
    var rest = current ? current.type : ids[0], shown = null;
    function show(id) {
      if (id == null || id === shown) return;
      shown = id;
      var t = TYPES[id];
      preview.replaceChildren.apply(preview, [el('h3', t.type, 'd-name')].concat(typeFacts(t), [weaponRows(t, ambit)]));
    }
    ids.forEach(function (id) {
      var t = TYPES[id], dmg = maxDamage(t);
      grid.appendChild(Deck.structCard({
        slug: slugOf(id), ambit: ambit, name: t.type, hp: t.maxHealth, dmg: dmg, current: !!current && current.type === id, disabled: fixed,
        title: t.type, ariaLabel: 'Place a ' + t.type + ', ' + t.maxHealth + ' health, ' + dmg + ' dmg',
        onClick: function () { place(id); refocus('change'); }, onShow: function () { show(id); },
      }));
    });
    grid.addEventListener('mouseleave', function () { if (!grid.contains(document.activeElement)) show(rest); });
    grid.addEventListener('focusout', function (e) { if (!grid.contains(e.relatedTarget)) show(rest); });
    show(rest);
    sec.root.appendChild(grid);
    p.body.append(sec.root, preview);
  }

  /* C) A struct: who it is, what it can do, what it fires, whom it guards.
   * D) While its pick waits on the board, the panel turns amber. */
  function renderStruct(box, u, pick, fixed) {
    var t = TYPES[u.type], foe = u.side === 'computer';
    var p = Deck.panel({
      into: box, tag: 'aside', tone: pick ? 'warn' : foe ? 'enemy' : 'player', label: 'Inspector',
      glyph: pick ? 'range' : null, sprite: pick ? null : u.ambit,
      title: pick === 'defend' ? 'Pick to guard' : pick === 'move' ? 'Pick a band' : whereOf(selection),
      right: [pick ? Deck.iconBtn({ glyph: 'close', label: 'Stop picking', onClick: function () { disarm(); refocus(pick); } }) : deselectBtn()],
    });
    var hero = Deck.hero({ ambit: u.ambit, short: true, slug: slugOf(u.type), foe: foe });
    if (u.protects) hero.appendChild(Deck.sprite('defending', 32, 's-hero-mark'));
    if (fixed) hero.appendChild(Deck.pill({ text: 'Fixed', tone: 'amber', glyph: 'blocked', cls: 'd-hero-tag' }));
    p.root.insertBefore(hero, p.body);

    var id = el('div', null, 's-id');
    id.append.apply(id, [el('h2', t.type, 'd-name')].concat(typeFacts(t)));

    var canMove = u.type === COMMAND_ID && AMBITS.filter(function (a) { return fits(t, a); }).length > 1;
    var keys = el('div', null, 'd-keys s-keys');
    keys.setAttribute('role', 'group');
    keys.setAttribute('aria-label', 'Actions');
    keys.append(
      abilityKey('move', 'move', 'Move', pick === 'move', fixed || !canMove, function () { if (pick === 'move') disarm(); else arm('move', u); }),
      abilityKey('defend', 'defend', 'Guard', pick === 'defend', fixed || !t.canDefend, function () { if (pick === 'defend') disarm(); else arm('defend', u); }),
      abilityKey('change', 'edit', 'Change', changing, fixed || u.type === COMMAND_ID, function () { changing = !changing; picking = null; renderSetup(); }),
      abilityKey('remove', 'subtract', 'Remove', null, fixed || u.type === COMMAND_ID, function () { place(null); }));

    var ws = Deck.sec('Weapons', String(weapons(t).length));
    ws.root.appendChild(weaponRows(t, u.ambit));
    p.body.append(id, keys, ws.root);

    if (t.canDefend) {
      var ward = wardOf(u);
      var gs = Deck.sec('Guarding');
      gs.root.appendChild(Deck.guard({
        ward: ward ? { slug: slugOf(ward.type), name: TYPES[ward.type].type } : null,
        picking: pick === 'defend', disabled: fixed,
        onPick: function () { if (pick === 'defend') disarm(); else arm('defend', u); refocus('defend'); },
        onClear: function () {
          setWard(u, null);
          var p = document.querySelector('#inspector .d-guard > .d-btn:not(:disabled)');
          if (p) p.focus();
        },
      }).root);
      p.body.appendChild(gs.root);
    }
  }

  /* Put a type in the selected slot (null empties it). The slot's id does not
   * depend on the type, so anything guarding it keeps guarding it. */
  function place(typeId) {
    var u = selected();
    if (typeId == null) {
      draft = draft.filter(function (v) { return v !== u; });
      draft.forEach(function (v) { if (v.protects === u.id) v.protects = null; });
      selection.id = null;
    } else if (u) {
      u.type = typeId;
      if (!TYPES[typeId].canDefend) u.protects = null;
    } else {
      var added = { id: unitId(selection.side, typeId, selection.ambit, selection.slot), side: selection.side, type: typeId, ambit: selection.ambit, slot: selection.slot, protects: null };
      draft.push(added); selection.id = added.id;
    }
    changing = false;
    renderSetup();
  }
  function setWard(u, wardId) { u.protects = wardId; picking = null; renderSetup(); }

  /* ── Battle ────────────────────────────────────────────────────────────── */

  function chainFromDraft(config) {
    // Command Ship first, then ambit by ambit, so ids read like a fleet built in order.
    var ordered = config.units.slice().sort(fleetOrder);
    var ids = chainIdMap(config);
    // The debrief's survivors read it back; never part of a shared config.
    try { Object.defineProperty(config, 'chainIds', { value: ids, enumerable: false, configurable: true }); } catch (e) { /* frozen */ }
    var height = 100000 + Math.floor(rng(config.seed + '#h')() * 900000);
    return new Chain({
      types: window.SimulatorTypes.types, seed: config.seed + '|' + config.difficulty, height: height, planetId: '2-1',
      players: [
        { id: YOU.id, name: YOU.name, fleetId: YOU.fleetId, charge: config.charge.player },
        { id: CPU.id, name: CPU.name, fleetId: CPU.fleetId, charge: config.charge.computer },
      ],
      structs: ordered.map(function (u) {
        return { id: ids[u.id], typeId: u.type, owner: u.side === 'player' ? YOU.id : CPU.id, ambit: u.ambit, slot: u.slot, protects: u.protects ? ids[u.protects] : null };
      }),
    });
  }

  function currentConfig() {
    return { units: clone(draft), seed: $('seed').value, difficulty: settings.difficulty, preset: settings.preset, blockMs: settings.blockMs, charge: clone(settings.charge) };
  }

  function setScreen(name) {
    document.body.dataset.screen = name;
    $('setup-screen').classList.toggle('hidden', name !== 'setup');
    $('battle-screen').classList.toggle('hidden', name !== 'battle');
    $('debrief-screen').classList.toggle('hidden', name !== 'debrief');
    if (name !== 'battle') { document.body.classList.remove('sim-paused', 'sim-watch'); closeEndConfirm(); }
    renderSteps();
    if (social) social.renderPanels();
    placeBattle();
    renderStatus();
  }

  /* The nav's steps: where you are, and the moves the round allows from
   * here — back to the battle's log, on to a finished battle's debrief, back
   * to setup to edit the fleets. Battle is never a step from setup: a battle
   * starts through Start and its deploy. */
  var STEP_GO = {
    setup: function () { toSetup(false); },
    battle: function () { setScreen('battle'); },
    debrief: function () { showDebrief(); },
  };
  function stepOpen(step) {
    var screen = document.body.dataset.screen;
    if (step === 'setup') return screen === 'debrief' && !!social && !social.liveRole();
    if (step === 'battle') return screen === 'debrief' && !!host;
    if (step === 'debrief') return screen === 'battle' && !!host && !!host.finished;
    return false;
  }
  var STEPS = ['setup', 'battle', 'debrief'];
  function renderSteps() {
    var screen = document.body.dataset.screen, at = STEPS.indexOf(screen);
    document.querySelectorAll('#sim-steps [data-step]').forEach(function (a) {
      var i = STEPS.indexOf(a.dataset.step), here = i === at, open = !here && stepOpen(a.dataset.step);
      a.classList.toggle('is-done', i < at);
      a.classList.toggle('is-current', here);
      if (here) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
      if (!here && !open) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
    // A live battle starts in its lobby.
    var first = document.querySelector('#sim-steps [data-step="setup"] > span');
    if (first) first.textContent = social && social.isLive() ? 'Lobby' : 'Setup';
  }

  /* The battle sits under the window's panel, which keeps its nav on every
   * screen: the board starts where the panel ends, at whatever scale. */
  function placeBattle() {
    if (document.body.dataset.screen !== 'battle') return;
    var bottom = $('menu-page-panel').getBoundingClientRect().bottom;
    $('battle-screen').style.top = Math.round(bottom) + 'px';
  }

  function stopBattle() {
    autoPaused = false;
    if (host) { host.destroy(); host = null; }
    clearInterval(clockTimer); clearInterval(countdownTimer); clearTimeout(debriefTimer);
    deploying = false;
    closeEndConfirm();
    deployModal.hide();
    pausedModal.hide();
    document.body.classList.remove('sim-deploying', 'sim-paused');
    renderTools();
  }

  /* `live` (simulator-social.js): { role: 'host'|'guest'|'watch', host, guest,
   * send, attach(host), remote(r) } — a battle with a person on the other
   * side. The host runs it with no computer; a guest or a watcher replays
   * the host's ticks through a RemoteHost (simulator-live.js). */
  function start(config, live) {
    try {
      config = config || currentConfig();
      validate(config.units);
      stopBattle();
      initial = clone(config);
      settings.blockMs = config.blockMs; settings.difficulty = config.difficulty; settings.charge = clone(config.charge);
      var chain = chainFromDraft(config);
      startHeight = chain.height;
      var frame = function () { var f = $('board'); return f && f.contentWindow; };
      var onChange = function () { renderStatus(); renderPaused(); };
      if (live && live.role !== 'host') {
        // The opening board, from the code, until the host's first tick.
        var probe = new Host({ chain: chain, you: YOU, cpu: { id: CPU.id, name: live.guest.name, pfp: live.guest.pfp }, label: 'probe', frame: function () { return null; } });
        var opening = probe.snapshot();
        probe.destroy();
        var types = {};
        window.SimulatorTypes.types.forEach(function (t) { types[t.id] = Host.spectatorType(t); });
        host = new window.SimLive.RemoteHost({
          frame: frame, label: 'sim', role: live.role, initial: opening, types: types,
          players: { host: live.host, guest: live.guest }, send: live.send, onChange: onChange, comms: commsInvoke,
        });
        live.remote(host);
      } else {
        var cpu = live ? { id: CPU.id, name: live.guest.name, pfp: live.guest.pfp, label: live.guest.name + '\u2019s fleet' }
          : { id: CPU.id, name: CPU.fleetName + ' · ' + config.difficulty, pfp: CPU.pfp };
        host = new Host({
          chain: chain, you: YOU, cpu: cpu, label: 'sim', blockMs: config.blockMs,
          ai: live ? null : new Ai(CPU.id, config.difficulty, config.seed),
          frame: frame, onChange: onChange, comms: commsInvoke,
        });
        if (live) live.attach(host);
      }
      debriefShown = false; debriefPosted = false;
      setScreen('battle');
      $('board').src = 'raidview.html?planet=' + chain.planetId + '&label=sim&sim=1';
      if (live && live.role === 'watch') { deploying = false; renderStatus(); }
      // A guest's matchup reads from its own side, as its board does.
      else if (live && live.role === 'guest') deploy(social.swapped(config), live.host);
      else deploy(config, live ? live.guest : null);
      social.renderBattle();
      clockTimer = setInterval(function () { renderStatus(); renderPaused(); }, 250);
    } catch (e) { message(e.message); }
  }

  /* ── Battle chrome: the deck's dialogs over the board (W2-battle) ──────── */
  /* Engagement and Paused are kept SimDeck modals on the board's scaled
   * layer, each built once around its body from simulator.html; show() and
   * hide() open and close them. Engagement is a status: no trap, and nothing
   * dismisses it. Paused is a dialog on SimDeck's stack, so its Escape (and
   * a Tab trap) are the stack's: Escape resumes. The End confirm is built as
   * it opens and closed after. A click on the scrim does nothing. */
  var deployModal = Deck.modal({
    id: 'deploy', parent: $('sim-layer'), role: 'status', kept: true, width: 'engage', railGlyph: 'raid',
    title: 'Engagement', titleId: 'deploy-title', meta: 'Block 0', body: $('deploy-body'),
  });

  // Every way out of the pause: the forfeit first, the round's alternatives,
  // then Resume, the one launch key, across the whole dialog.
  var resumeKey = Deck.launch({ id: 'resume', text: 'Resume', block: true, onClick: function () { resume(); } });
  var pauseKeys = Deck.el('div', 'b-pause-keys');
  pauseKeys.appendChild(Deck.btn({ id: 'pause-end', tone: 'coral', size: 'sm20', text: 'End battle', onClick: function () { confirmEnd(); } }));
  pauseKeys.appendChild(Deck.btn({ id: 'pause-rematch', tone: 'violet', size: 'sm20', text: 'Rematch', onClick: function () { if (initial) start(initial); } }));
  pauseKeys.appendChild(Deck.btn({ id: 'pause-edit', tone: 'violet', size: 'sm20', text: 'Edit fleets', onClick: function () { toSetup(false); } }));
  var pausedModal = Deck.modal({
    id: 'paused', parent: $('sim-layer'), kept: true, width: 'md', railGlyph: 'in-progress',
    title: 'Paused', titleId: 'paused-title', meta: '00:00', metaId: 'paused-clock', body: $('paused-body'),
    cta: [pauseKeys, resumeKey], ctaColumn: true, focus: resumeKey, onCancel: function () { resume(); },
  });

  function resume() {
    autoPaused = false;
    if (host && !host.finished) host.start();
    renderPaused();
    var p = $('pause');
    if (p && p.offsetParent) p.focus(); else if ($('board')) $('board').focus();
  }

  /* End battle: a forfeit, so it asks first. A solo battle holds still while
   * it asks, and picks up again on Cancel unless it was already paused; a
   * live one runs on the host's clock for two people and does not stop. A
   * watcher only leaves, which costs nothing, so it never asks. */
  var endConfirm = null, endWasRunning = false;
  function closeEndConfirm() { var m = endConfirm; endConfirm = null; if (m) m.close(); }
  function confirmEnd() {
    if (!host || host.finished || deploying || endConfirm) return;
    var live = social.isLive();
    var s = host.summary() || {};
    var standing = (s.standing || {})[YOU.id], fielded = (s.fielded || {})[YOU.id];
    var fact = ['Counts as a forfeit'];
    if (fielded) fact.push((standing || 0) + '/' + fielded + ' standing');
    endWasRunning = !live && host.running;
    var cancel = function () {
      closeEndConfirm();
      if (endWasRunning && host && !host.finished) host.start();
      renderPaused();
    };
    var no = Deck.btn({ id: 'end-cancel', text: 'Cancel', onClick: cancel });
    var yes = Deck.btn({ id: 'end-confirm', tone: 'coral', text: 'End battle', onClick: function () {
      closeEndConfirm();
      if (host && !host.finished) host.forfeit();
      renderPaused();
    } });
    endConfirm = Deck.modal({
      id: 'end-dialog', parent: $('sim-layer'), role: 'alertdialog', width: 'sm', tone: 'bad', railGlyph: 'attention',
      title: 'End battle', titleId: 'end-title', body: Deck.el('span', 'd-txt', fact.join(' · ')),
      cta: [no, yes], focus: no, onCancel: cancel,
    });
    if (endWasRunning) host.stop();
    // One dialog at a time: Paused gives way before the confirm takes focus.
    renderPaused();
    endConfirm.show();
  }

  /* Engagement: the two fleets face to face (portrait, roster, opening
   * charge, reach), the objective, then a 3·2·1 and the first block. `foe`
   * is the person on the other side of a live battle ({name, pfp}). */
  function rosterOf(side, units) {
    return units.filter(function (u) { return u.side === side; }).sort(function (a, b) {
      return (a.type === COMMAND_ID ? 0 : 1) - (b.type === COMMAND_ID ? 0 : 1)
        || AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot;
    });
  }
  function deployRoster(box, side, units, label) {
    var r = Deck.roster(rosterOf(side, units).map(function (u) {
      return { slug: Host.typeSlug(TYPES[u.type].type), foe: side === 'computer' };
    }), true);
    r.setAttribute('role', 'img');
    r.setAttribute('aria-label', label);
    box.replaceChildren(r);
  }
  function deploy(config, foe) {
    deploying = true;
    document.body.classList.add('sim-deploying');
    renderTools();
    var live = social.isLive();
    var them = social.opponentName() || 'Computer';
    var mine = rosterOf('player', config.units).length, theirs = rosterOf('computer', config.units).length;
    $('deploy-you-name').textContent = 'You';
    $('deploy-you').textContent = String(mine);
    $('deploy-cpu-name').textContent = them;
    $('deploy-cpu-level').textContent = live ? 'Live' : cap(config.difficulty);
    $('deploy-cpu').textContent = String(theirs);
    var P = window.StructsPfp;
    var youPf = $('deploy-you-pf');
    youPf.replaceChildren();
    if (YOU.pfp && P) P.fillPortrait(youPf, YOU.pfp);
    var cpuPf = $('deploy-cpu-pf');
    cpuPf.replaceChildren();
    cpuPf.classList.toggle('is-cpu', !live);
    cpuPf.classList.toggle('is-them', live);
    if (!live) cpuPf.appendChild(Deck.glyph('computer', 32));
    else if (P) P.fillPortrait(cpuPf, (foe && foe.pfp) || null);
    deployRoster($('deploy-roster-you'), 'player', config.units, 'Your ' + mine + ' structs');
    deployRoster($('deploy-roster-cpu'), 'computer', config.units, them + ', ' + theirs + ' structs');
    Deck.battery({ into: $('deploy-charge-you'), side: 'you', readout: true, slim: true, label: 'Opening charge', value: config.charge.player })
      .root.setAttribute('aria-label', 'Your opening charge, ' + config.charge.player + ' of 30');
    Deck.battery({ into: $('deploy-charge-cpu'), side: 'foe', mirror: true, readout: true, slim: true, label: 'Opening charge', value: config.charge.computer })
      .root.setAttribute('aria-label', them + ' opening charge, ' + config.charge.computer + ' of 30');
    $('deploy-reach-you').replaceChildren(Deck.reach(reachOf('player', config.units)));
    $('deploy-reach-cpu').replaceChildren(Deck.reach(reachOf('computer', config.units)));
    // The objective: their command ship, where it is and who guards it.
    var cmd = config.units.filter(function (u) { return u.side === 'computer' && u.type === COMMAND_ID; })[0];
    if (cmd) {
      var guards = config.units.filter(function (u) { return u.side === 'computer' && u.protects === cmd.id; })
        .map(function (u) { return TYPES[u.type].type; })
        .filter(function (n, i, all) { return all.indexOf(n) === i; });
      Deck.tile({ into: $('deploy-target'), static: true, size: 56, side: 'foe', ambit: cmd.ambit,
        slug: Host.typeSlug(TYPES[cmd.type].type), defended: guards.length > 0, label: 'Their command ship' });
      $('deploy-objective').textContent = cap(cmd.ambit) + ' · ' + TYPES[cmd.type].maxHealth + ' health'
        + (guards.length ? ' · guarded by their ' + guards.join(' and ') : '');
    }
    var left = COUNTDOWN;
    var count = function () {
      $('countdown').textContent = String(left);
      $('deploy-timer').setAttribute('aria-label', 'Battle starts in ' + left);
    };
    count();
    deployModal.show();
    renderStatus(); renderPaused();
    countdownTimer = setInterval(function () {
      left--;
      if (left > 0) { count(); return; }
      clearInterval(countdownTimer);
      deployModal.hide();
      deploying = false;
      document.body.classList.remove('sim-deploying');
      renderTools();
      if (host) host.start();
    }, 1000);
  }

  /* The status pills in the top bar, on every screen: what the round is
   * (live, the challenge, a DM, a pick waiting on the board), the battle's
   * phase, then its settings. The row never wraps; what does not fit is left
   * out from the end, whole pills only (fitStatus). It is rebuilt only when
   * a pill changed, so the live region speaks once per change. */
  function blockName() {
    var b = BLOCK_TIMES.filter(function (t) { return t.ms === settings.blockMs; })[0];
    return b || { name: settings.blockMs / 1000 + ' s', note: 'custom' };
  }
  function bestRun() { var v = social.view(); var lad = (v && v.ladder) || []; return lad[0] ? lad[0].outcome.time : null; }
  var statusKey = null;
  function renderStatus() {
    if (!social) return;
    var screen = document.body.dataset.screen;
    var live = social.isLive();
    var pills = [];
    var conn = function () {
      var c = social.connection();
      if (c) pills.push({ text: c.text, tone: c.state === 'bad' ? 'coral' : c.state === 'warn' ? 'amber' : 'teal', led: true });
    };
    var liveLed = function () { pills.push({ text: 'Live', tone: 'coral', led: true }); };
    if (screen === 'setup') {
      if (picking) pills.push({ text: picking.action === 'defend' ? 'Picking guard' : 'Picking band', tone: 'amber', led: true });
      if (social.isChallenge() && social.locked() && bestRun()) pills.push({ text: 'Best ' + bestRun(), tone: 'amber', glyph: 'success' });
      var to = social.addressed();
      if (to) pills.push({ text: 'For ' + to.name, tone: 'violet', pfAttrs: to.pfp_attrs || '' });
      if (live) { liveLed(); conn(); }
    } else if (screen === 'battle' && host && initial) {
      var f = host.finished, block = host.chain.height - startHeight;
      var matched = social.matches(initial);
      var phase = deploying ? { id: 'sim-phase', text: 'Deploying', tone: 'amber', led: true }
        : f ? { id: 'sim-phase', text: 'Battle over' }
        : host.running ? { id: 'sim-phase', text: 'Block ' + block, tone: 'teal', led: true }
        : live ? { id: 'sim-phase', text: 'Waiting · block ' + block, tone: 'amber', led: true }
        : { id: 'sim-phase', text: 'Block ' + block, tone: 'teal', led: true, ledTone: 'off' };
      // The phase leads a solo battle; a live one opens with Live.
      if (live) liveLed();
      pills.push(phase);
      if (matched) pills.push({ text: social.battleName(), tone: 'amber' });
      if (live) { pills.push({ text: blockName().name }); conn(); }
      // The computer's level means nothing with a person on the other side.
      if (!live) {
        pills.push({ text: cap(initial.difficulty), chevs: LEVELS.indexOf(initial.difficulty) + 1 });
        pills.push({ text: blockName().name });
      }
      if (matched && bestRun()) pills.push({ text: 'Best ' + bestRun(), tone: 'amber' });
    } else if (screen === 'debrief' && initial) {
      if (live) { liveLed(); pills.push({ text: blockName().name }); conn(); }
      else if (social.matches(initial)) { pills.push({ text: social.battleName(), tone: 'amber' }); pills.push({ text: blockName().name }); }
      else pills.push({ text: cap(blockName().note) + ' · ' + blockName().name });
    }
    var key = JSON.stringify(pills);
    var box = $('sim-status');
    if (key !== statusKey) {
      statusKey = key;
      box.replaceChildren.apply(box, pills.map(function (p) { p.title = p.text; return Deck.pill(p); }));
    }
    fitStatus();
    fitCommand();
    renderTools();
    renderSteps();
    var done = host && host.finished;
    if (done && !debriefShown && !debriefTimer) {
      clearInterval(clockTimer);
      debriefTimer = setTimeout(function () { debriefTimer = null; showDebrief(); }, done.forfeit ? 0 : DEBRIEF_DELAY_MS);
    }
  }
  /* Whole pills or none: one cut in half reads as a different word. The
   * battle's phase (its block counter) always stays: when it would not fit,
   * the finished steps give up their words for their check, then the mode
   * its word for its mark, and only then does the phase itself ellipsize. */
  function fitStatus() {
    var nav = $('menu-page-nav'), box = $('sim-status');
    if (!nav || !box) return;
    var keep = $('sim-phase');
    // Measured whole: the phase only shrinks once nothing else gives way.
    var fits = function () {
      if (keep) keep.style.flexShrink = '0';
      Deck.fitRow(box, keep);
      var whole = !keep || keep.offsetLeft - box.offsetLeft + keep.offsetWidth <= box.clientWidth;
      if (keep) keep.style.flexShrink = '';
      return whole;
    };
    nav.classList.remove('s-tight', 's-tighter');
    if (fits()) return;
    nav.classList.add('s-tight');
    if (fits()) return;
    nav.classList.add('s-tighter');
    fits();
  }

  /* The command bar keeps one row. While its keys leave the readiness no
   * room for its word, it gives way a step at a time (simulator.css): the
   * fleets' tools fold to their glyphs, then the bar's keys draw closer,
   * then Send to keeps its glyph. Measured rather than set by mode, so any
   * mix of keys — Send to, Play live — finds its fit. */
  var FOLDS = ['s-fold', 's-tight', 's-tighter'];
  function fitCommand() {
    var bar = $('sim-go'), head = bar && bar.querySelector('.d-ready-h');
    if (!head || document.body.dataset.screen !== 'setup') return;
    FOLDS.forEach(function (c) { bar.classList.remove(c); });
    for (var i = 0; i < FOLDS.length && head.scrollWidth > head.clientWidth; i++) bar.classList.add(FOLDS[i]);
  }

  /* Pause and End/Leave, at the nav's right. A watcher only leaves; while
   * the fleets deploy neither is open yet; a finished battle has neither. */
  function renderTools() {
    var f = host && host.finished;
    var watch = social && social.liveRole() === 'watch';
    document.body.classList.toggle('sim-watch', !!watch && document.body.dataset.screen === 'battle');
    var end = $('end'), pause = $('pause');
    var leave = watch ? 'Leave' : 'End battle';
    end.title = leave; end.setAttribute('aria-label', leave);
    end.querySelector('.d-end-cap').textContent = watch ? 'Leave' : 'End';
    pause.classList.toggle('hidden', !!f);
    end.classList.toggle('hidden', !!f);
    [pause, end].forEach(function (b) {
      b.disabled = !!deploying;
      if (deploying) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
    pause.setAttribute('aria-pressed', document.body.classList.contains('sim-paused') ? 'true' : 'false');
  }

  function renderPaused() {
    var held = !!host && !host.running && !host.finished && !deploying && !social.isLive();
    // One modal at a time: the End confirm stands in for Paused while it asks.
    var show = held && !endConfirm;
    document.body.classList.toggle('sim-paused', held);
    $('pause').setAttribute('aria-pressed', held ? 'true' : 'false');
    // The choices are rebuilt only as the dialog opens: the clock ticks every
    // 250 ms and a rebuild under the pointer would swallow the click.
    if (show && !pausedModal.isOpen()) {
      renderBlockTime($('pause-block-time'));
      pausedModal.show();
      $('resume').focus({ preventScroll: true });
    } else if (!show && pausedModal.isOpen()) pausedModal.hide();
    if (show) {
      $('paused-clock').textContent = format(host.elapsedMs());
      $('pause-block').textContent = 'Block ' + (host.chain.height - startHeight);
    }
  }

  function toSetup(fresh) {
    stopBattle();
    $('board').src = 'about:blank';
    if (initial) {
      draft = clone(initial.units);
      settings.charge = clone(initial.charge); settings.blockMs = initial.blockMs; settings.difficulty = initial.difficulty;
    }
    picking = null; changing = false;
    setScreen('setup');
    // A new encounter starts from the preset as the list shows it, opponent
    // included; editing fleets keeps everything the round had.
    if (fresh) { if (settings.preset !== 'random') settings.difficulty = settings.preset; loadLayout(); }
    else { selectDefault(); renderRound(); renderSetup(); }
  }

  /* ── Debrief ───────────────────────────────────────────────────────────── */

  /* The verdict is the deck's framed word over the starfield; the hero
   * takes the verdict's tint. */
  function showVerdict(verdict, reason) {
    Deck.verdict({ into: $('verdict-box'), word: cap(verdict), tone: verdict, reason: reason, wordId: 'verdict', reasonId: 'reason', factsId: 'debrief-meta' });
    $('debrief-meta').classList.add('x-facts');
    $('db-hero').dataset.verdict = verdict;
  }
  /* The round's facts: time, blocks, the opponent (the computer's level, or
   * a live battle's block time) and the battle. Read out with ' · ' between. */
  function debriefFacts(s, blocks, liveRole) {
    var box = $('debrief-meta');
    var fact = function (kids) {
      var f = Deck.el('span', 'd-fact');
      if (box.children.length) f.appendChild(Deck.sr(' · '));
      kids.forEach(function (k) { f.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
      box.appendChild(f);
    };
    box.replaceChildren();
    fact([Deck.glyph('in-progress', 16, 'd-hint'), Deck.el('span', 'd-fact-n', format(s.elapsedMs))]);
    fact([Deck.el('span', 'd-fact-n', blocks), blocks === 1 ? ' block' : ' blocks']);
    if (liveRole) fact([Deck.el('span', 'd-fact-n', Math.round((initial.blockMs || Host.BLOCK_MS) / 1000) + ' s'), ' chain']);
    else fact([Deck.chevs(LEVELS.indexOf(initial.difficulty) + 1, { small: true }), cap(initial.difficulty)]);
    fact([Deck.glyph('planet', 16, 'd-hint'), social.isChallenge() ? social.battleName() : cap(initial.seed)]);
  }

  /* Survivors: each fleet as it fielded (command ship first, then by ambit
   * and slot), the destroyed ones dimmed with a skull. The battle config is
   * in the host's orientation, so a live guest's own side is 'computer'. */
  function chainIdMap(config) {
    var ids = {}, n = { player: 1000, computer: 2000 };
    // Command Ship first, then ambit by ambit, so ids read like a fleet built in order.
    config.units.slice().sort(fleetOrder).forEach(function (u) { ids[u.id] = '5-' + (++n[u.side]); });
    return ids;
  }
  function fleetOrder(a, b) {
    return (a.type === COMMAND_ID ? -1 : 0) - (b.type === COMMAND_ID ? -1 : 0) || AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot;
  }
  function survivors(s, liveRole, themTitle) {
    var ids = initial.chainIds || chainIdMap(initial);
    var dead = {};
    (s.kills || []).forEach(function (k) { dead[k.struct_id] = true; });
    var mine = liveRole === 'guest' ? 'computer' : 'player';
    [['you', mine, YOU.id], ['cpu', mine === 'player' ? 'computer' : 'player', CPU.id]].forEach(function (side) {
      var foe = side[0] === 'cpu';
      var units = initial.units.filter(function (u) { return u.side === side[1]; }).sort(fleetOrder);
      $('db-chips-' + side[0]).replaceChildren.apply($('db-chips-' + side[0]), units.map(function (u) {
        var t = TYPES[u.type], gone = !!dead[ids[u.id]];
        return Deck.tile({ static: true, size: 56, ambit: u.ambit, slug: Host.typeSlug(t.type), side: foe ? 'foe' : 'friend', dead: gone, skull: gone,
          label: t.type + (gone ? ', destroyed' : ', survived') });
      }));
      var fielded = (s.fielded && s.fielded[side[2]]) || units.length;
      $('db-lost-' + side[0]).textContent = 'lost ' + ((s.lost && s.lost[side[2]]) || 0) + ' of ' + fielded;
    });
    $('db-them').textContent = themTitle;
  }

  /* The tally, then the struct of yours that did the most (kills, then damage). */
  function tally(s, themTitle) {
    var st = function (id) { return (s.stats && s.stats[id]) || {}; };
    var you = st(YOU.id), cpu = st(CPU.id);
    var row = function (label, icon, key, lost) {
      var r = { label: label, you: lost ? (s.lost && s.lost[YOU.id]) || 0 : you[key] || 0, them: lost ? (s.lost && s.lost[CPU.id]) || 0 : cpu[key] || 0 };
      if (icon === 'dmg') { r.glyph = icon; r.glyphTone = 'gold'; } else r.sprite = icon;
      return r;
    };
    Deck.stats({ into: $('tallies'), head: { you: 'You', them: themTitle }, sprites: true, rows: [
      row('Structs lost', 'destroyed', null, true),
      row('Attacks', 'attacker', 'attacks'),
      row('Damage dealt', 'dmg', 'damage'),
      row('Shots evaded', 'deflector-shield', 'evaded'),
      row('Blocked by defenders', 'defender-block', 'blocked'),
      row('Counter damage', 'counter-attack', 'countered'),
    ] });
    var tags = document.querySelector('.sim-tally-h');
    tags.querySelector('.sim-cpu').textContent = themTitle;
    tags.querySelector('.sim-cpu').title = themTitle;

    var best = null, by = s.byStruct || {};
    Object.keys(by).forEach(function (id) {
      var b = by[id];
      if (b.owner !== YOU.id || !b.type || !(b.kills > 0 || b.damage > 0)) return;
      if (!best || b.kills > best.kills || (b.kills === best.kills && b.damage > best.damage)) best = b;
    });
    var mvp = $('db-mvp');
    mvp.classList.toggle('hidden', !best);
    mvp.replaceChildren();
    if (!best) return;
    var words = Deck.el('span', 'x-mvp-t');
    words.appendChild(Deck.el('span', 'd-txt', best.type));
    words.appendChild(Deck.el('span', 'd-txt d-hint', best.kills + (best.kills === 1 ? ' kill' : ' kills') + ' · ' + best.damage + ' damage'));
    mvp.appendChild(Deck.el('span', 'd-lbl d-hint', 'Top struct'));
    var art = Deck.el('span', 'x-mvp-s');
    art.appendChild(Deck.ship(Host.typeSlug(best.type), 32));
    mvp.appendChild(art);
    mvp.appendChild(words);
  }

  var timeline = { n: 1, events: [] };
  function renderTimeline() {
    $('moments').replaceChildren(timeline.events.length ? Deck.timeline(timeline) : Deck.el('span', 'd-txt d-hint x-tl-none', 'No structs destroyed'));
  }
  function fitTimeline() { Deck.fitTimeline($('moments')); }

  function showDebrief() {
    if (!host || !host.finished) return;
    debriefShown = true;
    var s = host.summary(), f = s.finished;
    var verdict = f.winner === 'you' ? 'victory' : f.winner === 'cpu' ? 'defeat' : 'draw';
    var them = social.opponentName();
    var themTitle = them ? them : 'Computer';
    showVerdict(verdict, f.gone ? (f.winner === 'you' ? (them || 'The other side') + ' left the battle' : 'The connection dropped')
      : f.forfeit ? (f.winner === 'you' ? (them || 'They') + ' ended the battle' : 'You ended the battle')
      : them ? (verdict === 'victory' ? them + '’s command ship destroyed' : verdict === 'defeat' ? 'Your command ship destroyed' : 'Both command ships destroyed')
      : verdict === 'victory' ? 'Computer command ship destroyed'
      : verdict === 'defeat' ? 'Your command ship destroyed'
      : f.stalemate === 'quiet' ? 'Stalemate · ' + Host.QUIET_BLOCKS + ' blocks without a hit'
      : f.stalemate === 'moves' ? 'Stalemate · ' + Host.QUIET_MOVES + ' command ship moves without a hit'
      : 'Both command ships destroyed');
    var blocks = Math.max(0, f.height - startHeight);
    var liveRole = social.liveRole();
    debriefFacts(s, blocks, liveRole);
    survivors(s, liveRole, themTitle);
    tally(s, themTitle);

    // Turning points: the kills that shaped the battle, on its block line.
    var events = turningPoints(s.kills || []);
    var attacks = ((s.stats && s.stats[YOU.id] && s.stats[YOU.id].attacks) || 0) + ((s.stats && s.stats[CPU.id] && s.stats[CPU.id].attacks) || 0);
    timeline = { n: Math.max(blocks, 1), events: events };
    renderTimeline();
    $('db-blocks').textContent = blocks + (blocks === 1 ? ' block' : ' blocks');
    $('db-attacks').textContent = events.length + ' of ' + attacks + (attacks === 1 ? ' attack' : ' attacks');

    // The next moves. One step easier after a defeat, one harder otherwise.
    var at = LEVELS.indexOf(initial.difficulty);
    var easier = verdict === 'defeat' && at > 0;
    stepTo = LEVELS[at + (easier ? -1 : 1)] || null;
    // A challenge's fleets and level are fixed: its keys are the rematch,
    // Share and New encounter (the Challenge panel owns Edit fleets). A
    // guest or a watcher has no rematch to offer: New encounter is the launch.
    var fixedRun = social.isChallenge() && social.locked();
    var guestSide = liveRole === 'guest' || liveRole === 'watch';
    $('db-rematch').querySelector('span').textContent = guestSide ? 'New encounter' : liveRole === 'host' && them ? 'Rematch ' + them : 'Rematch';
    $('db-edit').classList.toggle('hidden', !!liveRole || fixedRun);
    $('db-swap').classList.toggle('hidden', !!liveRole || fixedRun);
    $('db-harder').classList.toggle('hidden', !stepTo || !!liveRole || fixedRun);
    if (stepTo) {
      $('db-harder').classList.remove('is-coral');   // the markup's tone, before Deck.btn owns it
      Deck.btn({ into: $('db-harder'), size: 'sm20', tone: easier ? null : 'coral', glyph: easier ? 'chevron-down' : 'chevron-up', text: easier ? 'Easier' : 'Harder',
        title: 'Rematch against a ' + cap(stepTo) + ' opponent' });
    }
    $('db-new').classList.toggle('hidden', !(social.isChallenge() || social.isLive()) || guestSide);
    // Two keys to a row; an odd one out spans its row, as New encounter always does.
    var keys = Array.prototype.filter.call(document.querySelectorAll('#debrief-screen .x-sec > :not(#db-new)'), function (k) { return !k.classList.contains('hidden'); });
    keys.forEach(function (k, i) { k.classList.toggle('x-wide', keys.length % 2 === 1 && i === keys.length - 1); });
    setScreen('debrief');
    fitTimeline();
    // The run is reported once: coming back from the log only redraws.
    var code = resultCode();
    if (code && !debriefPosted) { debriefPosted = true; social.debrief(initial, code); }
    renderStatus();
  }
  var debriefPosted = false;   // social.debrief ran for this battle
  var stepTo = null;   // the level #db-harder starts at: one harder, or after a defeat one easier

  /* How this battle went, as the results code (simcode.js, spec
   * proposals/sim-results-link.md): what a challenge's ladder ranks. */
  function runResult() {
    if (!host || !host.finished) return null;
    var s = host.summary(), f = s.finished;
    var tally = function (id) {
      var t = s.stats[id] || {};
      return { lost: s.lost[id], attacks: t.attacks, damage: t.damage, evaded: t.evaded, blocked: t.blocked, countered: t.countered };
    };
    return {
      winner: f.winner === 'you' ? 'player' : f.winner === 'cpu' ? 'computer' : 'draw',
      forfeit: !!f.forfeit, stalemate: f.stalemate || null,
      blocks: Math.max(0, f.height - startHeight), seconds: Math.round(s.elapsedMs / 1000),
      stats: { player: tally(YOU.id), computer: tally(CPU.id) },
    };
  }
  function resultCode() {
    var r = runResult();
    if (!r) return null;
    try { return SimCode.encodeResult(r); } catch (e) { return null; }
  }

  /* First blood, every command ship, and the latest kills — five at most —
   * as timeline events: whose kill it was, the struct that made it (or the
   * one lost, with no attacker), and a caption. */
  var SHORT_TYPE = { 'Pursuit Fighter': 'Fighter', 'Stealth Bomber': 'Bomber', 'High Altitude Interceptor': 'Interceptor', 'Mobile Artillery': 'Artillery', 'SAM Launcher': 'SAM' };
  function turningPoints(kills) {
    if (!kills.length) return [];
    var pick = [kills[0]];
    kills.forEach(function (k) { if (k.command && pick.indexOf(k) < 0) pick.push(k); });
    for (var i = kills.length - 1; i > 0 && pick.length < 5; i--) if (pick.indexOf(kills[i]) < 0) pick.push(kills[i]);
    pick.sort(function (a, b) { return a.height - b.height || kills.indexOf(a) - kills.indexOf(b); });
    return pick.map(function (k) {
      var lostYours = k.owner === YOU.id;
      var yours = k.by_type ? k.by_owner === YOU.id : !lostYours;
      return {
        block: k.height - startHeight,
        side: yours ? 'you' : 'them',
        slug: Host.typeSlug(k.by_type || k.type),
        // First kill is yours to claim; theirs reads as what you lost.
        label: k.command ? 'Command ship' : k === kills[0] && yours ? 'First kill' : (SHORT_TYPE[k.type] || k.type) + (lostYours ? ' lost' : ' down'),
        kill: !!k.command,
      };
    });
  }

  /* ── Sharing ───────────────────────────────────────────────────────────── */

  /* A battle travels as https://structs.app/sim/<code> (simcode.js — the same
   * encoding the site decodes). Pasting takes that link, a structs:// one, a
   * bare code, or the older JSON layout codes. */
  var SimCode = window.StructsSimCode;
  function shareConfig(config) {
    return { version: 3, seed: config.seed, difficulty: config.difficulty, blockMs: config.blockMs, charge: config.charge, units: config.units };
  }
  function battleLink(config) { return SimCode.link(shareConfig(config)); }
  function copyText(text, done, title) {
    var fallback = function () { openCode(text, title); };
    try { navigator.clipboard.writeText(text).then(function () { message(done); }, fallback); } catch (e) { fallback(); }
  }
  function copyLink(config) {
    try { copyText(battleLink(config), 'Battle link copied.', 'Battle link'); } catch (e) { message('This battle cannot be shared: ' + e.message + '.'); }
  }
  /* The debrief's share: how it went, and the battle to try it yourself —
   * to a room or a DM (Post to…), or as a link for anywhere else. */
  function resultLine() {
    var s = host.summary(), f = s.finished;
    var verdict = f.winner === 'you' ? 'Victory' : f.winner === 'cpu' ? 'Defeat' : 'Draw';
    var blocks = Math.max(0, f.height - startHeight);
    return [verdict + ' vs ' + cap(initial.difficulty), format(s.elapsedMs), blocks + (blocks === 1 ? ' block' : ' blocks'),
      'lost ' + s.lost[YOU.id] + ' of ' + s.fielded[YOU.id]].join(' · ');
  }
  function shareResult() {
    if (!host || !host.finished || !initial) return;
    social.openPost(initial, resultCode(), resultLine());
  }
  /* Copy for anywhere outside Comms: the result line and its link, or the
   * battle's link. A result link is also "play this battle". */
  function copyFor(config, result, line) {
    if (!result) { copyLink(config); return; }
    try { copyText((line ? line + ' — ' : '') + battleLink(config) + '/' + result, 'Result copied.', 'Share result'); }
    catch (e) { message('This battle cannot be shared: ' + e.message + '.'); }
  }
  /* Paste a battle link, or — when the clipboard refused — the link to copy
   * by hand: a deck dialog (SimDeck.modal) around one code field. The field
   * is built once; the dialog is built when it opens and gone when it closes. */
  var codeInput = el('input', null, 'd-code-in');
  codeInput.type = 'text'; codeInput.id = 'layout-code';
  codeInput.autocomplete = 'off'; codeInput.spellcheck = false;
  codeInput.placeholder = 'structs.app/sim/…';
  var codeField = el('div', null, 'd-sec');
  var codeLabel = el('label', 'Battle link', 'd-lbl d-hint');
  codeLabel.htmlFor = 'layout-code';
  var codeBox = el('span', null, 'd-code');
  codeBox.appendChild(codeInput);
  codeField.append(codeLabel, codeBox);
  var codeModal = null, codeSharing = false;
  codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !codeSharing) { e.preventDefault(); loadCode(); } });
  function openCode(text, title) {
    closeCode();
    codeSharing = !!text;
    codeInput.value = text || '';
    codeInput.readOnly = !!text;
    codeModal = Deck.modal({
      id: 'code-dialog', parent: $('menu-page-layout'), width: 'md', railGlyph: text ? 'link-out' : 'incoming',
      title: title || (text ? 'Share' : 'Paste a battle'), titleId: 'code-title',
      body: [codeField],
      cta: text ? [Deck.btn({ tone: 'teal', text: 'Close', onClick: closeCode })]
        : [Deck.btn({ text: 'Cancel', onClick: closeCode }), Deck.btn({ id: 'code-load', tone: 'teal', text: 'Load battle', glyph: 'incoming', onClick: loadCode })],
      focus: codeInput, backdropCancels: true, onCancel: closeCode,
    });
    codeModal.show();
    if (text) codeInput.select();
  }
  function closeCode() { var m = codeModal; codeModal = null; if (m) m.close(); }
  /* Whatever was pasted → a version-3 config, or an error saying why not. */
  function parsePasted(text) {
    if (text.length > 20000) throw Error('That is too long to be a battle.');
    var code = SimCode.codeFrom(text);
    if (code) {
      var d = SimCode.decode(code);
      if (!d) throw Error('That link does not hold a battle.');
      return d;
    }
    var c;
    try { c = JSON.parse(text); } catch (e) { throw Error('Paste a structs.app/sim link.'); }
    if ((c.version !== 2 && c.version !== 3) || typeof c.seed !== 'string' || c.seed.length > 60) throw Error('Invalid layout code.');
    return c;
  }
  function loadCode() {
    try {
      applyConfig(parsePasted(codeInput.value.trim()));
      closeCode();
      message('Battle loaded.');
    } catch (e) { message(e.message); }
  }
  /* A config (decoded link or JSON) onto the setup board. Throws if illegal. */
  function applyConfig(c) {
      if (!Ai.LEVELS[c.difficulty]) throw Error('Invalid layout code.');
      var charge = c.version === 3 ? c.charge : { player: 9, computer: 9 };
      if (!charge || SIDES.some(function (s) { return !Number.isInteger(charge[s]) || charge[s] < 0 || charge[s] > MAX_CHARGE; })) throw Error('Invalid layout code.');
      var blockMs = c.version === 3 ? c.blockMs : Host.BLOCK_MS;
      if (!BLOCK_TIMES.some(function (b) { return b.ms === blockMs; })) throw Error('Invalid layout code.');
      validate(c.units);
      draft = c.units.map(function (u) { return { id: u.id, side: u.side, type: u.type, ambit: u.ambit, slot: u.slot, protects: u.protects || null }; });
      $('seed').value = c.seed;
      settings.difficulty = c.difficulty; settings.blockMs = blockMs; settings.charge = { player: charge.player, computer: charge.computer };
      selectDefault(); renderRound(); renderSetup();
  }

  /* A structs://sim/<code> link: the window opens with `?sim=<code>`, or, when
   * it is already open, the app calls Simulator.openLink(code). Either way the
   * battle lands on the setup board — a battle in progress is left for it. */
  function openLink(code) {
    var c = SimCode.decode(code);
    if (!c) { message('That link does not hold a battle.'); return false; }
    var ctx = social.context();
    if (ctx && ctx.battle !== code) social.leave();
    try {
      if (host) { stopBattle(); $('board').src = 'about:blank'; }
      picking = null; changing = false;
      setScreen('setup');
      applyConfig(c);
      message('Battle loaded from a link.');
      return true;
    } catch (e) { message(e.message); return false; }
  }

  /* The Map Viewer's own Comms rail, beside the battle (raidview-comms.js in
   * sim mode): the room the simulator gives it — a live battle's, or the
   * challenge's thread (simulator-social.js `talk`) — and its reads and sends
   * for that room alone. `undefined` is "not a Comms command". */
  function commsInvoke(cmd, args) {
    var T = window.__TAURI__;
    if (cmd === 'matrix_state' || cmd === 'mcp_inventory') {
      if (!T || !T.core) throw new Error('Comms is not reachable from here');
      return T.core.invoke(cmd, cmd === 'mcp_inventory' ? { player: 'primary' } : {});
    }
    if (cmd !== 'sim_comms_room' && cmd !== 'matrix_timeline' && cmd !== 'matrix_send') return undefined;
    var t = social.talk();
    if (cmd === 'sim_comms_room') return t ? t.room : null;
    if (!t || !args || args.roomId !== t.room.room_id) throw new Error('That is not this battle\u2019s room.');
    return cmd === 'matrix_timeline' ? t.timeline() : t.send(String(args.body || ''), args.msgtype || null);
  }
  function toFrame(name, payload) {
    if (host && host.post) host.post({ structs: 'bridge', kind: 'event', name: name, payload: payload });
  }
  (function () {
    var T = window.__TAURI__;
    if (T && T.event && T.event.listen) T.event.listen('matrix::state', function (e) { toFrame('matrix::state', e && e.payload); });
  })();

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  social = window.SimSocial({
    $: $, cap: cap, message: message,
    shareConfig: shareConfig, currentConfig: currentConfig, copyFor: copyFor,
    initial: function () { return initial; },
    renderAll: function () { renderRound(); renderSetup(); },
    /* The challenge's thread arrived or moved: the readiness and the pills
     * read its best. */
    renderReady: function () { if (draft) renderChecks(); renderStatus(); },
    startLive: function (cfg, live) { start(cfg, live); },
    swapped: function (cfg) {
      var c = clone(cfg);
      c.units = swapped(c.units);
      c.charge = { player: cfg.charge.computer, computer: cfg.charge.player };
      return c;
    },
    summary: function () { return host ? host.summary() : {}; },
    /* Something new was said where the rail is listening: it re-reads. */
    talkChanged: function (roomId, messages) { toFrame('matrix::timeline', { room_id: roomId, messages: messages || [{ self: false }] }); },
    /* The guest is gone or gave up: the host's side wins. */
    concede: function (gone) {
      if (!host || host.finished) return;
      host.finished = { winner: 'you', height: host.chain.height, gone: !!gone, forfeit: !gone };
      host.stop();
    },
    loadChallenge: function (cfg) {
      if (host) { stopBattle(); $('board').src = 'about:blank'; }
      picking = null; changing = false;
      setScreen('setup');
      try { applyConfig(cfg); } catch (e) { message(e.message); }
    },
  });

  /* A fresh board selects nothing: the Inspector column shows the Matchup. */
  function selectDefault() {
    selection = null;
    changing = false; picking = null;
  }
  function loadLayout() { draft = layout(settings.preset, $('seed').value); selectDefault(); renderRound(); renderSetup(); }

  $('start').addEventListener('click', function () { if (social.onStart()) return; start(); });
  Deck.bindMenu($('share'), $('share-card'));
  $('reseed').addEventListener('click', function () {
    $('seed').value = Math.random().toString(36).slice(2, 10);
    if (settings.preset === 'random') loadLayout();
  });
  $('seed').addEventListener('change', function () { if (settings.preset === 'random') loadLayout(); });
  $('mirror').addEventListener('click', function () {
    draft = draft.filter(function (u) { return u.side === 'player'; }).concat(draft.filter(function (u) { return u.side === 'player'; }).map(function (u) { return reside(u, 'computer'); }));
    settings.charge.computer = settings.charge.player;
    renderRound(); renderSetup();
  });
  $('swap').addEventListener('click', function () {
    draft = swapped(draft);
    settings.charge = { player: settings.charge.computer, computer: settings.charge.player };
    selectDefault(); renderRound(); renderSetup();
  });
  $('export').addEventListener('click', function () { copyLink(currentConfig()); });
  $('import').addEventListener('click', function () { openCode(''); });

  // Pause is a toggle: pressed while paused, and a press then resumes.
  $('pause').addEventListener('click', function () {
    if (!host || host.finished || deploying || social.isLive()) return;
    if (!host.running) { if (document.body.classList.contains('sim-paused')) resume(); return; }
    autoPaused = false;
    host.stop();
  });
  // Resume and the Paused card's End battle are the modal's own CTAs (P7).
  $('end').addEventListener('click', function () {
    if (deploying) return;
    if (social.liveRole() === 'watch') { social.leave(); toSetup(true); return; }
    confirmEnd();
  });
  document.querySelectorAll('#sim-steps [data-step]').forEach(function (a) {
    a.addEventListener('click', function () { if (stepOpen(a.dataset.step)) STEP_GO[a.dataset.step](); });
  });
  if (window.ResizeObserver) new ResizeObserver(function () { placeBattle(); fitStatus(); fitCommand(); }).observe($('menu-page-panel'));
  // The defence web follows the board's tiles as the column resizes.
  if (window.ResizeObserver) new ResizeObserver(function () { drawDefWeb(); }).observe($('arena'));
  window.addEventListener('resize', function () { placeBattle(); fitStatus(); fitCommand(); });

  $('db-rematch').addEventListener('click', function () {
    var role = social.liveRole();
    if (role === 'guest' || role === 'watch') { social.leave(); toSetup(true); return; }
    if (social.rematch()) return;
    start(initial);
  });
  $('db-edit').addEventListener('click', function () { toSetup(false); });
  $('db-swap').addEventListener('click', function () {
    var c = clone(initial);
    c.units = swapped(c.units);
    c.charge = { player: initial.charge.computer, computer: initial.charge.player };
    start(c);
  });
  $('db-harder').addEventListener('click', function () {
    if (!stepTo) return;
    var c = clone(initial); c.difficulty = stepTo;
    start(c);
  });
  // Share ▾: post the result to Comms, or copy it as a link.
  (function () {
    var menu = Deck.menu({ id: 'db-share-menu', label: 'Share', pop: true, items: [
      { id: 'db-post-to', text: 'Post to\u2026', glyph: 'send-alpha', onClick: shareResult },
      { id: 'db-copy', text: 'Copy link', glyph: 'copy', onClick: function () { if (host && host.finished && initial) copyFor(initial, resultCode(), resultLine()); } },
    ] });
    $('db-code').parentNode.appendChild(menu);
    Deck.bindMenu($('db-code'), menu);
    // It opens upward; where that would leave the page, downward.
    $('db-code').addEventListener('click', function () {
      menu.classList.remove('x-down');
      if (menu.hidden) return;
      var top = $('debrief-screen').getBoundingClientRect().top;
      if (menu.getBoundingClientRect().top < Math.max(0, top)) menu.classList.add('x-down');
    });
  })();
  $('db-new').addEventListener('click', function () { social.leave(); toSetup(true); });
  $('post-to').addEventListener('click', function () { social.openPost(currentConfig(), null); });
  $('show-log').addEventListener('click', function () { setScreen('battle'); });
  window.addEventListener('resize', function () { if (document.body.dataset.screen === 'debrief') { renderTimeline(); fitTimeline(); } });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // An open dialog takes its own Escape, SimDeck's stack, topmost first:
    // Post to…, Play live and Paste close, the End confirm cancels, Paused resumes.
    // The Share menus take theirs before it reaches here.
    if (Deck.modalOpen()) return;
    if (picking) disarm();
    else if (changing && document.body.dataset.screen === 'setup') { changing = false; renderSetup(); }
  });
  /* A hidden window holds the battle; coming back picks it up again. macOS
   * reports a window as hidden when another one covers it, not only when it
   * is minimized, so a pause the player did not ask for must not outlive the
   * cover — a battle the player paused stays paused. */
  var autoPaused = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // A live battle runs on the host's clock for two people: nobody's
      // window being covered may stop it.
      if (social.isLive()) return;
      if (host && host.running) { autoPaused = true; host.stop(); }
    } else if (autoPaused) {
      autoPaused = false;
      if (host && !host.finished && !deploying) host.start();
    }
  });
  window.addEventListener('beforeunload', function () { if (social.isLive()) social.leave(); stopBattle(); });

  window.Simulator = {
    getHost: function () { return host; }, getLayout: function () { return draft; }, getSettings: function () { return settings; },
    layout: layout, validate: validate, readiness: readiness, start: start, toSetup: toSetup, showDebrief: showDebrief, openLink: openLink,
    takeContext: function () { return social.take(); }, social: social, runResult: runResult, comms: commsInvoke,
  };
  setScreen('setup');
  loadLayout();
  var linked = /[?&]sim=([A-Za-z0-9_-]{4,2000})/.exec(location.search || '');
  if (linked) openLink(linked[1]);
  social.take();
})();
