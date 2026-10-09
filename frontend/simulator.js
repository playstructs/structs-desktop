/* Battle Simulator: setup → deploy → battle ⇄ paused → debrief.
 *
 * Setup is local editing. The battle is simulator-chain.js (structsd's
 * combat, block by block) behind simulator-host.js, drawn by raidview.html in
 * an iframe — the same board, Action Bar, animations and battle log a live
 * raid uses.
 */
(function () {
  'use strict';
  var A = window.BattleArt, Chain = window.SimulatorChain, Ai = window.SimulatorAi, Host = window.SimulatorHost;
  var $ = function (id) { return document.getElementById(id); };
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
  function icon(name, size) { var i = el('i', null, 'sui-icon sui-icon-' + (size || 'md') + ' icon-' + name); i.setAttribute('aria-hidden', 'true'); return i; }
  function button(text, cls, onClick) { var b = el('button', text, cls); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function format(ms) { var sec = Math.floor(ms / 1000); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }
  /* The toast: the game's system alert (P7), with no action slot. Empty is
   * hidden (simulator.css #message:empty). */
  function message(text) {
    var box = $('message');
    var a = window.SUIParts.systemAlert('secondary', 'icon-info', null, null);
    a.querySelector('.sui-message-system-alert-text-container').appendChild(el('span', String(text)));
    box.className = a.className;
    box.replaceChildren.apply(box, Array.prototype.slice.call(a.childNodes));
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

  /* A type's layers, bottom to top, tagged the way the game's struct still
   * tags them, so main.css's .struct-still z-indexes order them too. */
  function drawHull(into, typeId, cls) {
    var art = A.ART[Host.typeSlug(TYPES[typeId].type)];
    if (!art) return;
    function add(layer, tag) {
      var img = el('img', null, [cls, tag].filter(Boolean).join(' '));
      img.src = A.artPath(art.dir, layer); img.alt = ''; img.draggable = false; into.appendChild(img);
    }
    (art.bottom || []).forEach(function (layer) { add(layer, 'struct-bottom-detail'); });
    add('struct-base', null);
    (art.top || []).forEach(function (layer) { add(layer, 'struct-top-detail'); });
  }
  function tileStyle(node, ambit) { node.style.backgroundImage = "url('img/tiles/" + ambit + '/' + ambit + "-1-2-top-middle.png')"; }
  function ambitIcon(a) { var i = el('i', null, 'sui-icon sui-icon-md sui-icon-' + a); i.title = cap(a); i.setAttribute('aria-label', a); return i; }
  function side2theme(side) { return side === 'player' ? 'player' : 'enemy'; }

  /* The game's struct cheatsheet (raidview-sheet.js, the Map Viewer's port of
   * CheatsheetContentBuilder), fed from the simulator's own type records. */
  var Sheet = window.RaidSheet({
    el: function (t, c, x) { return el(t, x, c); },
    equipped: function (v) { return !!v && !/^no[A-Z]/.test(v); },
    typeOf: function (s) { return s && s.st; },
    state: function () { return { structsById: {} }; },
    icons: function () { return A.EQUIP_ICON; },
  });
  var AMBIT_BIT = { water: 2, land: 4, air: 8, space: 16 };
  /** The sheet of a type standing in `ambit`: its reach resolved against that
   * band (the Command Ship's LOCAL weapon reads as the band it holds), with no
   * build cost — nothing is built here — and each weapon's charge, in the
   * game's battery, under its damage. */
  function typeSheet(typeId, ambit, side) {
    var t = TYPES[typeId], st = Host.spectatorType(t);
    var mask = function (ws) { return reachFrom(t, ws, ambit).reduce(function (m, a) { return m | AMBIT_BIT[a]; }, 0); };
    st.primary_weapon_ambits = mask('primaryWeapon');
    st.secondary_weapon_ambits = mask('secondaryWeapon');
    st.build_charge = 0; st.build_draw = 0;
    var card = el('div', null, 'sui-cheatsheet sim-sheet sui-theme-' + side2theme(side));
    card.appendChild(Sheet.structSheet(st));
    var rows = card.querySelectorAll('.sui-cheatsheet-property');
    weapons(t).filter(function (ws) { return A.EQUIP_ICON[Chain.weaponField(t, ws, '')]; }).forEach(function (ws, i) {
      var info = rows[i] && rows[i].querySelector('.sui-cheatsheet-property-info');
      if (!info) return;
      var charge = weaponInfo(t, ws).charge;
      var line = el('div', null, 'sim-sheet-charge');
      line.title = charge + ' charge'; line.setAttribute('aria-label', charge + ' charge');
      line.appendChild(Sheet.batteryCost(charge));
      info.appendChild(line);
    });
    return card;
  }

  /* ── Round card ────────────────────────────────────────────────────────── */

  /* A pick-one list: the game's radio leading each SUI result row
   * (SUIParts.radioRows). The box names the group (data-labelledby, or
   * data-label) and the radios (its id, so the Round card's and the Paused
   * card's Block time are two groups, not one). A pick fires on every click,
   * the checked row's included — Random rolls again. Rebuilt in place, so a
   * keyboard pick keeps its focus on the radio it moved to. */
  function choice(box, list, current, onPick, trail) {
    var had = box.contains(document.activeElement);
    var rows = window.SUIParts.radioRows(box.id, list.map(function (item) {
      var value = item.id != null ? item.id : item.ms;
      return { value: value, label: item.name, trail: trail(item), checked: value === current, item: item };
    }), function (v, o) { onPick(o.item); });
    // The box may ask for SUIParts' compact rows (data-rows): one line beside
    // the sprite, or two-up tiles.
    (box.getAttribute('data-rows') || '').split(' ').filter(Boolean).forEach(function (c) { rows.classList.add(c); });
    var by = box.getAttribute('data-labelledby');
    if (by) rows.setAttribute('aria-labelledby', by); else rows.setAttribute('aria-label', box.getAttribute('data-label') || '');
    box.replaceChildren(rows);
    if (had) { var on = rows.querySelector('input.sui-radio:checked'); if (on) on.focus(); }
  }
  function renderBlockTime(box) {
    choice(box, BLOCK_TIMES, settings.blockMs, function (bt) {
      settings.blockMs = bt.ms;
      if (host) host.setBlockMs(bt.ms);
      renderRound(); renderBlockTime($('pause-block-time')); renderBattleBar();
    }, function (bt) { return el('span', bt.note, 'sui-text-hint'); });
  }
  // The enemy's count the way the game counts structs: a resource.
  function enemyCount(p) {
    var r = el('span', null, 'sui-resource');
    r.title = 'Enemy structs';
    r.append(el('span', String(p.enemy)), el('i', null, 'sui-icon sui-icon-enemy-deployed-structs'));
    return r;
  }
  /* Opening charge: one SUI stepper per side, captioned by the side. A
   * stepper is rebuilt only when its value changed elsewhere (Mirror, Swap, a
   * loaded link), so the one being stepped keeps its focus. */
  function renderCharges() {
    var box = $('charges');
    SIDES.forEach(function (side) {
      var id = side === 'player' ? 'charge-player' : 'charge-cpu';
      var input = $(id);
      if (input && Number(input.value) === settings.charge[side]) return;
      var step = window.SUIParts.stepper(settings.charge[side], { min: 0, max: MAX_CHARGE, step: 1 }, function (n) {
        settings.charge[side] = n; renderChecks();
      });
      var btns = step.querySelectorAll('button');
      btns[0].setAttribute('aria-label', 'Less opening charge');
      btns[btns.length - 1].setAttribute('aria-label', 'More opening charge');
      step.querySelector('input').id = id;
      var f = window.SUIParts.field(side === 'player' ? 'You' : 'Computer', step, null, { className: 'sui-text-label' });
      // The caption names the number, not the first button inside the label.
      f.htmlFor = id;
      f.firstChild.classList.add(side === 'player' ? 'sim-you' : 'sim-cpu');
      var old = input && input.closest('label');
      if (old) old.replaceWith(f); else box.appendChild(f);
    });
  }
  function renderRound() {
    choice($('encounters'), PRESETS, settings.preset, function (p) {
      settings.preset = p.id;
      // Random rolls a fresh battle on every click, selected or not.
      if (p.id === 'random') $('seed').value = Math.random().toString(36).slice(2, 10);
      if (p.id !== 'random') settings.difficulty = p.id;
      loadLayout();
    }, enemyCount);
    $('ai-level').value = settings.difficulty;
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

  function renderSetup() {
    if (selection && selection.id && !selected()) selection.id = null;
    var arena = $('arena'); arena.replaceChildren();
    var pickerUnit = picking && draft.find(function (u) { return u.id === picking.id; });
    if (picking && !pickerUnit) picking = null;
    var moving = !!pickerUnit && picking.action === 'move';
    var fixed = social.locked();
    AMBITS.forEach(function (ambit) {
      var band = el('div', null, 'band ' + ambit);
      band.appendChild(el('span', ambit, 'ambit-label sui-text-label'));
      SIDES.forEach(function (side) {
        for (var i = -1; i < 4; i++) {
          var command = i === -1, slot = command ? 0 : i;
          var u = draft.find(function (v) { return v.side === side && v.ambit === ambit && (command ? v.type === COMMAND_ID : v.type !== COMMAND_ID && v.slot === slot); });
          // An empty command post is drawn only as a Move's landing tile.
          var post = command && !u && moving && side === pickerUnit.side && fits(TYPES[pickerUnit.type], ambit);
          if (command && !u && !post) continue;
          var b = el('button', null, 'slot ' + (side === 'player' ? 'friendly' : 'enemy') + (command ? ' command' : ''));
          b.type = 'button';
          b.style.gridColumn = command ? (side === 'player' ? '1' : '7') : String((side === 'player' ? 2 : 5) + Math.floor(slot / 2));
          if (!command) b.style.gridRow = String(slot % 2 + 1);
          b.setAttribute('aria-label', post ? 'Move the command ship to ' + ambit
            : (side === 'player' ? 'Your ' : 'Computer ') + (u ? TYPES[u.type].type : 'empty slot ' + (slot + 1)) + ', ' + ambit);
          var isSel = u ? selection && selection.id === u.id
            : selection && !selection.id && selection.side === side && selection.ambit === ambit && !selection.command && selection.slot === slot;
          if (pickerUnit) {
            var target = moving ? post : !!u && u.side === pickerUnit.side && u !== pickerUnit;
            b.classList.add(u === pickerUnit ? 'selected' : target ? (moving ? 'sim-move-target' : 'eligible') : 'dim');
            b.addEventListener('click', function (u, ambit, target) {
              if (!target) disarm();
              else if (moving) moveTo(pickerUnit, ambit);
              else setWard(pickerUnit, u.id);
            }.bind(null, u, ambit, target));
          } else {
            if (isSel) b.classList.add('selected');
            b.addEventListener('click', function (side, ambit, slot, command, u) {
              if (u) selectUnit(u); else select({ side: side, ambit: ambit, slot: slot, command: command, id: null });
            }.bind(null, side, ambit, slot, command, u));
            // A challenge's fleets are its identity: looked at, not changed.
            if (!u && fixed) b.disabled = true;
          }
          if (u) {
            b.dataset.unit = u.id;
            drawHull(b, u.type, 'hull');
            var marks = el('span', null, 'status-indicators');
            if (u.protects) marks.appendChild(el('i', null, 'sui-icon sui-icon-sm sui-icon-defending'));
            if (draft.some(function (v) { return v.protects === u.id; })) marks.appendChild(el('i', null, 'sui-icon sui-icon-sm sui-icon-defended'));
            b.appendChild(marks);
          } else if (!post && !fixed) {
            b.appendChild(icon('add')).classList.add('empty-label');
          }
          band.appendChild(b);
        }
      });
      arena.appendChild(band);
    });
    document.body.classList.toggle('sim-picking', !!pickerUnit);
    // While a pick waits on the board, the round cannot be changed under it.
    var roundCol = document.querySelector('.sim-round-col') || $('round');
    if (roundCol) roundCol.inert = !!pickerUnit;
    var count = function (side) { return String(draft.filter(function (u) { return u.side === side; }).length); };
    $('count-you').textContent = count('player');
    $('count-cpu').textContent = count('computer');
    renderChecks();
    renderInspector();
    drawDefWeb();
    social.renderSetup();
    markSheetMore();
  }
  /* A sheet cut by the column's foot fades there, until it is read to the end. */
  function markSheetMore() {
    var sh = document.querySelector('#inspector > .sim-sheet');
    if (!sh) return;
    var more = function () { sh.classList.toggle('sim-more', sh.scrollTop + sh.clientHeight < sh.scrollHeight - 1); };
    if (!sh.dataset.watch) { sh.dataset.watch = '1'; sh.addEventListener('scroll', more, { passive: true }); }
    more();
  }

  /* The defence web: for the selected struct, dashed lines from each of its
   * defenders to it and from it to its ward, a dot at the defending end — the
   * Map Viewer's .rv-defweb, on the setup board. */
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
    function centre(v) {
      var n = arena.querySelector('.slot[data-unit="' + v.id + '"]');
      if (!n) return null;
      var x = n.offsetWidth / 2, y = n.offsetHeight / 2;
      for (var p = n; p && p !== arena; p = p.offsetParent) { x += p.offsetLeft; y += p.offsetTop; }
      return { x: x, y: y };
    }
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sim-defweb' + (u.side === 'computer' ? ' sim-enemy' : ''));
    svg.setAttribute('aria-hidden', 'true');
    links.forEach(function (l) {
      var a = centre(l[0]), b = centre(l[1]);
      if (!a || !b) return;
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      svg.appendChild(line);
      var dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', a.x); dot.setAttribute('cy', a.y); dot.setAttribute('r', 3);
      svg.appendChild(dot);
    });
    if (svg.childNodes.length) arena.appendChild(svg);
  }

  /* A fleet's reach: the ambits its weapons reach, as the game's ambit sprites. */
  function renderReach(box, side, units) {
    var reach = reachOf(side, units);
    var list = AMBITS.filter(function (a) { return reach[a]; });
    // As the game's cheatsheet draws a weapon's reach: the range glyph, then
    // one sprite per ambit reached (P7).
    box.replaceChildren.apply(box, [icon('range', 'md')].concat(list.map(function (a) { return ambitIcon(a); })));
    box.title = list.length ? 'Reaches ' + list.join(', ') : 'Reaches nothing';
    box.setAttribute('aria-label', box.title);
  }

  function renderChecks() {
    var list = readiness(draft);
    var box = $('checks');
    box.replaceChildren.apply(box, list.map(function (c) { return window.SUIParts.inlineAlert(c.blocking ? 'destructive' : 'warning', c.text); }));
    $('start').disabled = list.some(function (c) { return c.blocking; });
  }

  /* ── Inspector ─────────────────────────────────────────────────────────── */
  /* The game's Action Bar for the selected slot, as the Map Viewer draws it:
   * a side-themed header screen (inverted while a pick waits on the board),
   * the struct on its tile with its health, the ability row, the Defends
   * select (the keyboard path to the same choice), then the struct's
   * cheatsheet. An empty slot, or Change, is the game's Deploy list. */

  function inspectorHead(side, text, prompt) {
    var h = el('div', null, 'sim-insp-h sui-theme-' + side2theme(side));
    var screen = h.appendChild(el('div', null, 'sui-screen sui-screen-full-width'));
    screen.appendChild(el('div', text, 'sui-screen-info' + (prompt ? ' sui-mod-inverted' : '')));
    return h;
  }

  /* One ability: the game's panel button, `mod` its pressed state. */
  function abilityBtn(name, title, mod, onClick) {
    var a = el('a', null, 'sui-panel-btn ' + (mod || 'sui-mod-default'));
    a.href = 'javascript:void(0)';
    a.title = title; a.setAttribute('aria-label', title);
    a.setAttribute('role', 'button'); a.setAttribute('aria-pressed', String(!!mod));
    a.dataset.ability = name;
    a.appendChild(icon(name));
    a.addEventListener('click', function (e) { e.preventDefault(); onClick(); refocus(name); });
    a.addEventListener('keydown', function (e) { if (e.key === ' ') { e.preventDefault(); a.click(); } });
    return a;
  }
  /* The inspector is rebuilt under the pressed ability: focus goes where the
   * next step is — a target on the board while a pick waits, else the same
   * ability, else the selected slot. */
  function refocus(name) {
    var t = (picking && document.querySelector('#arena .slot.sim-move-target, #arena .slot.eligible'))
      || document.querySelector('#inspector [data-ability="' + name + '"]')
      || document.querySelector('#arena .slot.selected');
    if (t && t !== document.activeElement) t.focus();
  }

  function abilities(u, pick) {
    var t = TYPES[u.type], out = [];
    if (u.type === COMMAND_ID && AMBITS.filter(function (a) { return fits(t, a); }).length > 1) {
      out.push(abilityBtn('move', 'Move', pick === 'move' ? 'sui-mod-active-defense' : null, function () {
        if (pick === 'move') disarm(); else arm('move', u);
      }));
    }
    if (t.canDefend) {
      out.push(abilityBtn('defend', u.protects && pick !== 'defend' ? 'Clear Defense' : 'Defend',
        pick === 'defend' || u.protects ? 'sui-mod-active-defense' : null, function () {
          if (pick === 'defend') disarm();
          else if (u.protects) setWard(u, null);
          else arm('defend', u);
        }));
    }
    if (u.type !== COMMAND_ID) {
      out.push(abilityBtn('deploy', 'Change', changing ? 'sui-mod-pressed' : null, function () { changing = !changing; picking = null; renderSetup(); }));
      out.push(abilityBtn('close', 'Remove', null, function () { place(null); }));
    }
    if (!out.length) return null;
    var row = el('div', null, 'sui-action-bar-bottom-row sim-abilities sui-theme-' + side2theme(u.side));
    var group = row.appendChild(el('div', null, 'sui-action-bar-btn-group'));
    out.forEach(function (b) { group.appendChild(b); });
    return row;
  }

  function renderInspector() {
    var box = $('inspector'); box.replaceChildren();
    if (!selection) { box.appendChild(inspectorHead('player', 'Select Tile')); return; }
    var u = selected(), side = selection.side, fixed = social.locked();
    var pick = picking && u && picking.id === u.id ? picking.action : null;
    var where = cap(selection.ambit) + (selection.command ? ' · Command' : ' · Slot ' + (selection.slot + 1));
    var choosing = !fixed && (!u || changing);
    box.appendChild(inspectorHead(side, pick === 'move' ? 'Select Tile' : pick === 'defend' || choosing ? 'Select Struct' : where, !!pick));
    if (!u) { if (choosing) box.appendChild(typePicker(null)); return; }

    var t = TYPES[u.type];
    var row = fixed ? null : abilities(u, pick);
    if (choosing) {
      if (row) box.appendChild(row);
      box.appendChild(typePicker(u));
      return;
    }
    var hero = el('div', null, 'sim-hero' + (u.side === 'computer' ? ' enemy' : ''));
    tileStyle(hero, u.ambit);
    drawHull(hero, u.type);
    box.appendChild(hero);
    var health = el('div', null, 'struct-health-bar sim-health');
    health.title = t.maxHealth + ' health'; health.setAttribute('aria-label', health.title);
    for (var i = 0; i < t.maxHealth; i++) health.appendChild(el('div', null, 'struct-health-bar-segment mod-filled'));
    box.appendChild(health);
    // A challenge's fleets are looked at, not changed: no actions at all, as
    // the Map Viewer shows a spectator; the select stays as the read-out.
    if (row) box.appendChild(row);

    if (t.canDefend) {
      var guard = el('select'); guard.setAttribute('aria-label', 'Defends');
      var off = el('option', 'Nothing'); off.value = ''; guard.appendChild(off);
      draft.filter(function (v) { return v.side === u.side && v !== u; }).forEach(function (v) {
        var o = el('option', TYPES[v.type].type + (v.type === COMMAND_ID ? '' : ' · ' + v.ambit + ' ' + (v.slot + 1))); o.value = v.id; guard.appendChild(o);
      });
      guard.value = u.protects || '';
      guard.addEventListener('change', function () { setWard(u, guard.value || null); });
      guard.disabled = fixed;
      var f = el('div', null, 'sim-insp-field sp-narrow');
      f.appendChild(window.SUIParts.field('Defends', guard, null, { className: 'sui-text-label' }));
      box.appendChild(f);
    }
    box.appendChild(typeSheet(u.type, u.ambit, u.side));
  }

  /* The game's Deploy list ("Select Struct"): a still of every type the band
   * takes; a press places it. The sheet under the list follows the pointer
   * and focus, and rests on the slot's current type (or the first). */
  function typePicker(current) {
    var wrap = el('div', null, 'sim-types' + (selection.side === 'computer' ? ' enemy' : ''));
    var grid = wrap.appendChild(el('div', null, 'offcanvas-struct-list-layout'));
    var sheetBox = el('div', null, 'sim-types-sheet');
    var ids = Object.keys(TYPES).map(Number).filter(function (id) { return id !== COMMAND_ID && fits(TYPES[id], selection.ambit); });
    var rest = current ? current.type : ids[0], shown = null;
    function show(id) {
      if (id == null || id === shown) return;
      shown = id;
      sheetBox.replaceChildren(typeSheet(id, selection.ambit, selection.side));
    }
    ids.forEach(function (id) {
      var t = TYPES[id];
      var a = el('a', null, 'offcanvas-struct-container' + (current && current.type === id ? ' sim-current' : ''));
      a.href = 'javascript:void(0)';
      a.title = t.type; a.setAttribute('aria-label', 'Place ' + t.type);
      if (current && current.type === id) a.setAttribute('aria-current', 'true');
      var still = a.appendChild(el('div', null, 'struct-still'));
      tileStyle(still, selection.ambit);
      drawHull(still, id);
      a.addEventListener('click', function (e) { e.preventDefault(); place(id); });
      a.addEventListener('mouseenter', function () { show(id); });
      a.addEventListener('focus', function () { show(id); });
      grid.appendChild(a);
    });
    grid.addEventListener('mouseleave', function () { if (!grid.contains(document.activeElement)) show(rest); });
    grid.addEventListener('focusout', function (e) { if (!grid.contains(e.relatedTarget)) show(rest); });
    show(rest);
    wrap.appendChild(sheetBox);
    return wrap;
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
    var ids = {}, n = { player: 1000, computer: 2000 };
    // Command Ship first, then ambit by ambit, so ids read like a fleet built in order.
    var ordered = config.units.slice().sort(function (a, b) {
      return (a.type === COMMAND_ID ? -1 : 0) - (b.type === COMMAND_ID ? -1 : 0) || AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot;
    });
    ordered.forEach(function (u) { ids[u.id] = '5-' + (++n[u.side]); });
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
    if (name !== 'debrief') dropBanner();
    renderSteps();
    if (social) social.renderPanels();
    placeBattle();
    if (name === 'battle' && host) fitStatus();
    if (name === 'setup') fitFoot();
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
    if (step === 'setup') return screen === 'debrief' && !$('db-edit').classList.contains('hidden');
    if (step === 'battle') return screen === 'debrief' && !!host;
    if (step === 'debrief') return screen === 'battle' && !!host && !!host.finished;
    return false;
  }
  function renderSteps() {
    var screen = document.body.dataset.screen;
    document.querySelectorAll('#sim-steps [data-step]').forEach(function (a) {
      var here = a.dataset.step === screen, open = !here && stepOpen(a.dataset.step);
      a.classList.toggle('sui-mod-active', here);
      a.classList.toggle('sim-step-off', !here && !open);
      if (here) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
      if (!here && !open) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
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
    $('deploy').classList.add('hidden');
    $('paused').classList.add('hidden');
    pausedShown = false;
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
      var onChange = function () { renderBattleBar(); renderPaused(); };
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
      debriefShown = false;
      setScreen('battle');
      $('board').src = 'raidview.html?planet=' + chain.planetId + '&label=sim&sim=1';
      if (live && live.role === 'watch') { deploying = false; renderBattleBar(); }
      // A guest's matchup reads from its own side, as its board does.
      else if (live && live.role === 'guest') deploy(social.swapped(config));
      else deploy(config);
      social.renderBattle();
      clockTimer = setInterval(function () { renderBattleBar(); renderPaused(); }, 250);
    } catch (e) { message(e.message); }
  }

  /* ── P7 overlays: the game's system modal over the board ───────────────── */
  /* Paused and Deploy stay in the page: SUIParts.modal frames each once
   * around its body from simulator.html, and the hidden class opens and
   * closes it. Neither belongs to SUIParts' Escape stack (the modal is closed
   * and put back on the layer): the page's own Escape handler resumes a
   * pause, and nothing dismisses a deploy. A click on the scrim does nothing.
   * The End confirm is an ordinary SUIParts modal, built when it opens. */
  function keptModal(id, o) {
    var layer = $('sim-layer'), body = $(id + '-body');
    var m = window.SUIParts.modal({
      icon: o.icon, title: o.title, ctas: o.ctas, body: Array.prototype.slice.call(body.children),
      variant: 'scrim', className: 'sim-scrim', parent: layer, onCancel: function () {},
    });
    m.close();
    body.parentNode.removeChild(body);
    m.overlay.id = id;
    m.overlay.classList.add('hidden');
    layer.appendChild(m.overlay);
    return m;
  }
  /* A modal's title with a reading beside it (the Paused clock). */
  function titleWith(text, id) {
    var f = document.createDocumentFragment();
    var r = el('span', null, 'sui-text-label sui-text-hint');
    r.id = id;
    f.append(el('span', text), r);
    return f;
  }
  function labelModal(m, titleId, role) {
    var h = m.overlay.querySelector('.sp-modal-body > h2');
    if (h) { h.id = titleId; h.classList.add('sim-modal-title'); }
    m.overlay.setAttribute('role', role);
    m.overlay.setAttribute('aria-modal', 'true');
    m.overlay.setAttribute('aria-labelledby', titleId);
  }

  var pausedModal = keptModal('paused', {
    icon: 'icon-in-progress', title: titleWith('Paused', 'paused-clock'),
    // Every way out of the pause is a CTA, as the game's modal lays them out:
    // the forfeit first, the round's alternatives, Resume last. In the CTA
    // row the modal stays short enough for the board at 4x.
    ctas: [
      { id: 'pause-end', text: 'End battle', mod: 'destructive', onClick: function () { confirmEnd(); } },
      { id: 'pause-rematch', text: 'Rematch', mod: 'secondary', icon: 'icon-refresh-12', onClick: function () { if (initial) start(initial); } },
      { id: 'pause-edit', text: 'Edit fleets', mod: 'secondary', icon: 'icon-edit', onClick: function () { toSetup(false); } },
      { id: 'resume', text: 'Resume', mod: 'primary', icon: 'icon-chevron-right', onClick: function () { resume(); } },
    ],
  });
  labelModal(pausedModal, 'paused-title', 'dialog');
  // Resume reads like Start battle: the label, then the chevron.
  $('resume').appendChild($('resume').querySelector('i'));

  var deployModal = keptModal('deploy', { icon: 'icon-raid', title: 'Engagement' });
  labelModal(deployModal, 'deploy-title', 'status');
  deployModal.overlay.removeAttribute('aria-modal');

  function resume() {
    autoPaused = false;
    if (host && !host.finished) host.start();
    var p = $('pause');
    if (p && p.offsetParent) p.focus(); else if ($('board')) $('board').focus();
  }

  /* End battle: a forfeit, so it asks first. A solo battle holds still while
   * it asks, and picks up again on Cancel unless it was already paused; a
   * live one runs on the host's clock for two people and does not stop. A
   * watcher only leaves, which costs nothing, so it never asks. */
  var endConfirm = null, endWasRunning = false;
  function closeEndConfirm() { if (endConfirm) { endConfirm.close(); endConfirm = null; } }
  function confirmEnd() {
    if (!host || host.finished || deploying || endConfirm) return;
    var live = social.isLive();
    var s = host.summary() || {};
    var standing = (s.standing || {})[YOU.id], fielded = (s.fielded || {})[YOU.id];
    var fact = ['Counts as a forfeit'];
    if (fielded) fact.push((standing || 0) + '/' + fielded + ' standing');
    endWasRunning = !live && host.running;
    endConfirm = window.SUIParts.modal({
      icon: 'icon-attention', title: 'End battle', body: [el('span', fact.join(' · '))],
      ctas: [
        { id: 'end-cancel', text: 'Cancel', mod: 'secondary' },
        { id: 'end-confirm', text: 'End battle', mod: 'destructive', onClick: function () {
          closeEndConfirm();
          if (host && !host.finished) host.forfeit();
          renderPaused();
        } },
      ],
      variant: 'scrim', className: 'sim-scrim', parent: $('sim-layer'),
      onCancel: function () {
        closeEndConfirm();
        if (endWasRunning && host && !host.finished) host.start();
        renderPaused();
      },
    });
    labelModal(endConfirm, 'end-title', 'alertdialog');
    if (endWasRunning) host.stop();
    renderPaused();
    $('end-cancel').focus({ preventScroll: true });
  }

  /* The battle's charge as the game draws it: five chunks lit by the game's
   * ChargeCalculator thresholds (StructsPlayerCard.chargeLevel when loaded). */
  var CHARGE_STEPS = [0, 1, 2, 3, 5, 8];
  function chargeLevel(charge) {
    var P = window.StructsPlayerCard;
    if (P && P.chargeLevel) return P.chargeLevel(charge);
    var c = Number(charge);
    if (!isFinite(c)) return 0;
    for (var i = 0; i < CHARGE_STEPS.length; i++) if (c <= CHARGE_STEPS[i]) return i;
    return CHARGE_STEPS.length - 1;
  }
  function paintBattery(box, charge) {
    var lvl = chargeLevel(charge), chunks = [];
    for (var i = 1; i < CHARGE_STEPS.length; i++) chunks.push(el('div', null, 'sui-battery-chunk' + (i <= lvl ? ' sui-mod-filled' : '')));
    box.replaceChildren.apply(box, chunks);
    box.title = charge + ' charge';
    box.setAttribute('aria-label', box.title);
  }

  /* Deploy: the matchup, a 3·2·1, then the first block. */
  function deploy(config) {
    deploying = true;
    document.body.classList.add('sim-deploying');
    renderTools();
    var mine = config.units.filter(function (u) { return u.side === 'player'; }).length;
    var theirs = config.units.length - mine;
    $('deploy-you').textContent = String(mine);
    $('deploy-cpu-name').textContent = social.opponentName() || 'Computer';
    $('deploy-cpu').textContent = String(theirs);
    paintBattery($('deploy-charge-you'), config.charge.player);
    paintBattery($('deploy-charge-cpu'), config.charge.computer);
    renderReach($('deploy-reach-you'), 'player', config.units);
    renderReach($('deploy-reach-cpu'), 'computer', config.units);
    var left = COUNTDOWN;
    $('countdown').textContent = String(left);
    $('deploy').classList.remove('hidden');
    renderBattleBar(); renderPaused();
    countdownTimer = setInterval(function () {
      left--;
      if (left > 0) { $('countdown').textContent = String(left); return; }
      clearInterval(countdownTimer);
      $('deploy').classList.add('hidden');
      deploying = false;
      document.body.classList.remove('sim-deploying');
      renderTools();
      if (host) host.start();
    }, 1000);
  }

  /* The battle's status, in the nav: its states as badges (live, the
   * challenge, the line to the other side, the computer's level), then the
   * settings as hint text. The row never wraps; what does not fit is left
   * out from the end, least important first. */
  function badge(text, mod) { var b = window.SUIParts.badge(text, mod); b.title = text; return b; }
  function hint(text) { var h = el('span', text, 'sui-text-label sui-text-hint'); h.title = text; return h; }
  function renderBattleBar() {
    if (!host) return;
    var cfg = initial;
    var live = social.isLive();
    var items = [];
    if (live) items.push(badge('Live', 'destructive'));
    if (social.matches(cfg)) items.push(badge(social.battleName(), 'default'));
    if (live) {
      var conn = social.connection();
      if (conn) items.push(badge(conn.text, conn.state === 'bad' ? 'destructive' : conn.state === 'warn' ? 'warning' : 'default'));
    }
    var f = host.finished;
    var block = host.chain.height - startHeight;
    var phase = badge(deploying ? 'Deploying' : f ? 'Battle over' : host.running ? 'Block ' + block
      : live ? 'Waiting · block ' + block : 'Paused · block ' + block, 'default');
    phase.id = 'sim-phase';
    items.push(phase);
    // The computer's level means nothing with a person on the other side.
    if (!live) items.push(badge(cap(cfg.difficulty), cfg.difficulty === 'hard' ? 'warning' : 'default'));
    items.push(hint(BLOCK_TIMES.filter(function (b) { return b.ms === settings.blockMs; }).map(function (b) { return b.name; })[0] || (settings.blockMs / 1000 + ' s')));
    if (social.matches(cfg)) {
      var lad = (social.view() && social.view().ladder) || [];
      if (lad[0]) items.push(hint('best ' + lad[0].outcome.time));
    }
    var box = $('sim-status');
    box.replaceChildren.apply(box, items);
    fitStatus();
    renderTools();
    renderSteps();
    if (f && !debriefShown && !debriefTimer) {
      clearInterval(clockTimer);
      debriefTimer = setTimeout(function () { debriefTimer = null; showDebrief(); }, f.forfeit ? 0 : DEBRIEF_DELAY_MS);
    }
  }
  /* Whole items or none: one cut in half reads as a different word. */
  function fitStatus() {
    var box = $('sim-status'), full = false;
    Array.prototype.forEach.call(box.children, function (c) { c.style.display = ''; });
    var room = box.clientWidth;
    Array.prototype.forEach.call(box.children, function (c) {
      if (full || c.offsetLeft - box.offsetLeft + c.offsetWidth > room) { full = true; c.style.display = 'none'; }
    });
  }

  /* The foot holds every page action on one line. When it is short of room
   * the iconed buttons fold to their icon (the stepper's square), the Share
   * group first, then the fleets' tools; the label stays for a reader and in
   * the button's title. Start and Send keep their words. */
  var FOLDS = ['sim-fold-1', 'sim-fold-2'];
  function fitFoot() {
    var go = $('sim-go');
    if (!go || !go.offsetWidth) return;
    // Measured with Send at its full width, so it gives way only after the
    // folds have.
    go.classList.add('sim-go-measure');
    FOLDS.forEach(function (c) { go.classList.remove(c); });
    for (var i = 0; i < FOLDS.length && go.scrollWidth > go.clientWidth; i++) go.classList.add(FOLDS[i]);
    go.classList.remove('sim-go-measure');
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
    pause.classList.toggle('hidden', !!f);
    end.classList.toggle('hidden', !!f);
    [pause, end].forEach(function (a) {
      a.classList.toggle('sui-mod-disabled', deploying);
      if (deploying) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
  }

  var pausedShown = false;
  function renderPaused() {
    var held = !!host && !host.running && !host.finished && !deploying && !social.isLive();
    // One modal at a time: the End confirm stands in for Paused while it asks.
    var show = held && !endConfirm;
    $('paused').classList.toggle('hidden', !show);
    document.body.classList.toggle('sim-paused', held);
    // The choices are rebuilt only as the menu opens: the clock ticks every
    // 250 ms and a rebuild under the pointer would swallow the click.
    if (show && !pausedShown) { renderBlockTime($('pause-block-time')); $('resume').focus({ preventScroll: true }); }
    pausedShown = show;
    if (show) $('paused-clock').textContent = format(host.elapsedMs());
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

  /* The verdict as the game marks the end of a battle: its own VICTORY /
   * DEFEAT banner (the webapp's Victory/DefeatBannerViewModel — an intro,
   * then a loop), the one the Map Viewer has just played. A draw has no
   * banner in the game, so it is the word led by the verdict glyph; so is
   * every verdict when lottie is missing. #verdict stays the accessible text. */
  var banner = null;
  var VERDICT_GLYPH = { victory: 'icon-success', draw: 'icon-subtract', defeat: 'icon-alert' };
  function dropBanner() {
    if (banner) { try { banner.destroy(); } catch (e) { /* already gone */ } banner = null; }
    var box = $('verdict-banner');
    box.replaceChildren();
    box.classList.add('hidden');
  }
  function verdictWord(verdict, hidden) {
    var v = $('verdict');
    var C = window.StructsSimCard;
    var glyph = C && C.verdictGlyph ? C.verdictGlyph({ winner: verdict === 'victory' ? 'player' : verdict === 'draw' ? 'draw' : 'computer' }) : VERDICT_GLYPH[verdict];
    var i = el('i', null, 'sui-icon sui-icon-md ' + glyph);
    i.setAttribute('aria-hidden', 'true');
    v.replaceChildren(i, document.createTextNode(cap(verdict)));
    v.className = 'sui-text-display sim-huge sim-verdict-word ' + verdict + (hidden ? ' sim-sr' : '');
  }
  function showVerdict(verdict) {
    dropBanner();
    var L = window.lottie;
    var art = verdict !== 'draw' && L && typeof L.loadAnimation === 'function';
    verdictWord(verdict, art);
    if (!art) return;
    var box = $('verdict-banner');
    box.classList.remove('hidden');
    try {
      var b = banner = L.loadAnimation({ container: box, renderer: 'svg', loop: false, autoplay: false, path: 'lottie/' + verdict + '-banner/data.json' });
      b.addEventListener('DOMLoaded', function () {
        if (banner !== b) return;
        b.playSegments([0, 45], true);
        b.loop = true;
        b.playSegments([45, 96], false);
      });
      b.addEventListener('data_failed', function () { if (banner === b) { dropBanner(); verdictWord(verdict, false); } });
    } catch (e) { dropBanner(); verdictWord(verdict, false); }
  }

  /* One primary on the debrief: Rematch; Share when there is no Rematch (a
   * live guest or a watcher); the post strip's Send when the run is
   * addressed to someone (simulator-social.js says so through sendPrimary). */
  var sendIsPrimary = false;
  function rankDebrief() {
    var noRematch = $('db-rematch').classList.contains('hidden');
    var rematch = !noRematch && !sendIsPrimary, share = noRematch && !sendIsPrimary;
    $('db-rematch').classList.toggle('sui-mod-primary', rematch);
    $('db-rematch').classList.toggle('sui-mod-secondary', !rematch);
    $('db-code').classList.toggle('sui-mod-primary', share);
    $('db-code').classList.toggle('sui-mod-secondary', !share);
  }

  function showDebrief() {
    if (!host || !host.finished) return;
    debriefShown = true;
    var s = host.summary(), f = s.finished;
    var verdict = f.winner === 'you' ? 'victory' : f.winner === 'cpu' ? 'defeat' : 'draw';
    showVerdict(verdict);
    var them = social.opponentName();
    var themTitle = them ? them : 'Computer';
    document.querySelector('.sim-tally-h .sim-cpu').textContent = themTitle;
    $('reason').textContent = f.gone ? (f.winner === 'you' ? (them || 'The other side') + ' left the battle' : 'The connection dropped')
      : f.forfeit ? (f.winner === 'you' ? (them || 'They') + ' ended the battle' : 'You ended the battle')
      : them ? (verdict === 'victory' ? them + '\u2019s command ship destroyed' : verdict === 'defeat' ? 'Your command ship destroyed' : 'Both command ships destroyed')
      : verdict === 'victory' ? 'Computer command ship destroyed'
      : verdict === 'defeat' ? 'Your command ship destroyed'
      : f.stalemate === 'quiet' ? 'Stalemate · ' + Host.QUIET_BLOCKS + ' blocks without a hit'
      : f.stalemate === 'moves' ? 'Stalemate · ' + Host.QUIET_MOVES + ' command ship moves without a hit'
      : 'Both command ships destroyed';
    var blocks = Math.max(0, f.height - startHeight);
    var liveRole = social.liveRole();
    // The round as the rest of the app names it: the computer's level (not
    // with a person on the other side), then the challenge or the seed.
    $('debrief-meta').textContent = [format(s.elapsedMs), blocks + (blocks === 1 ? ' block' : ' blocks'),
      liveRole ? null : cap(initial.difficulty), social.isChallenge() ? social.battleName() : cap(initial.seed)]
      .filter(Boolean).join(' · ');

    // Each tally led by the app's stat glyph (structs-achievements.js).
    var rows = [
      ['Structs lost', 'icon-wreckage', s.lost[YOU.id], s.lost[CPU.id]],
      ['Attacks', 'sui-icon-attacker', s.stats[YOU.id].attacks, s.stats[CPU.id].attacks],
      ['Damage dealt', 'icon-dmg', s.stats[YOU.id].damage, s.stats[CPU.id].damage],
      ['Shots evaded', 'sui-icon-deflector-shield', s.stats[YOU.id].evaded, s.stats[CPU.id].evaded],
      ['Blocked by defenders', 'sui-icon-defender-block', s.stats[YOU.id].blocked, s.stats[CPU.id].blocked],
      ['Counter damage', 'icon-counter', s.stats[YOU.id].countered, s.stats[CPU.id].countered],
    ];
    $('tallies').replaceChildren.apply($('tallies'), rows.map(function (r) {
      var row = el('div', null, 'sui-data-card-row sim-tally');
      var label = el('span', null, 'sim-tally-l');
      var glyph = el('i', null, r[1] ? 'sui-icon sui-icon-sm ' + r[1] : 'sim-tally-i');
      glyph.setAttribute('aria-hidden', 'true');
      label.append(glyph, el('span', r[0]));
      row.append(label, el('span', String(r[2]), 'sui-text-label'), el('span', String(r[3]), 'sui-text-label'));
      return row;
    }));

    // The Map Viewer log's row language: the block in hint, the side's glyph
    // and name in its colour, then what happened.
    var moments = $('moments'); moments.replaceChildren();
    turningPoints(s.kills).forEach(function (m) {
      var side = m.mine ? 'sim-you' : 'sim-cpu';
      var row = el('div', null, 'sim-moment');
      var glyph = icon(m.countered ? 'counter' : 'wreckage', 'sm');
      glyph.classList.add(side);
      row.append(el('span', 'Block ' + m.block, 'sui-text-hint sim-moment-t'), glyph, el('span', m.who, side), el('span', m.what, 'sui-text-hint'));
      moments.appendChild(row);
    });
    if (!moments.children.length) moments.appendChild(el('div', 'No structs destroyed', 'sim-moment sim-moment-none sui-text-hint'));

    var next = LEVELS[LEVELS.indexOf(initial.difficulty) + 1];
    $('db-edit').classList.toggle('hidden', !!liveRole);
    $('db-swap').classList.toggle('hidden', !!liveRole);
    $('db-rematch').classList.toggle('hidden', liveRole === 'guest' || liveRole === 'watch');
    $('db-harder').classList.toggle('hidden', !next || !!liveRole);
    if (next) { $('db-harder').querySelector('span').textContent = 'Harder'; $('db-harder').title = 'Rematch against a ' + cap(next) + ' opponent'; }
    sendIsPrimary = false;
    rankDebrief();
    setScreen('debrief');
    var code = resultCode();
    if (code) social.debrief(initial, code);
  }

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

  /* First blood, every command ship, and the latest kills — five at most. */
  function turningPoints(kills) {
    if (!kills.length) return [];
    var pick = [kills[0]];
    kills.forEach(function (k) { if (k.command && pick.indexOf(k) < 0) pick.push(k); });
    for (var i = kills.length - 1; i > 0 && pick.length < 5; i--) if (pick.indexOf(kills[i]) < 0) pick.push(kills[i]);
    pick.sort(function (a, b) { return a.height - b.height || kills.indexOf(a) - kills.indexOf(b); });
    return pick.map(function (k) {
      var lostYours = k.owner === YOU.id;
      var target = (lostYours ? 'your ' : 'the enemy ') + (k.command ? 'command ship' : k.type);
      var verb = k.countered ? 'countered ' : 'destroyed ';
      return {
        block: k.height - startHeight,
        who: k.by_type || target.charAt(0).toUpperCase() + target.slice(1),
        mine: k.by_type ? k.by_owner === YOU.id : !lostYours,
        countered: !!k.countered,
        what: !k.by_type ? 'lost' : (k === kills[0] && !k.command ? 'first kill · ' + verb + target : verb + target),
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
   * by hand: the game's system modal around one SUI text field. The field is
   * built once; the modal is built when it opens and gone when it closes. */
  var codeInput = el('input');
  codeInput.type = 'text'; codeInput.id = 'layout-code';
  codeInput.autocomplete = 'off'; codeInput.spellcheck = false;
  var codeField = window.SUIParts.field('Battle link', codeInput);
  var codeModal = null, codeSharing = false;
  codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !codeSharing) { e.preventDefault(); loadCode(); } });
  function openCode(text, title) {
    closeCode();
    codeSharing = !!text;
    codeInput.value = text || '';
    codeModal = window.SUIParts.modal({
      icon: text ? 'icon-link-out' : 'icon-incoming',
      title: title || (text ? 'Share' : 'Paste a battle link'),
      body: [codeField],
      ctas: text ? [{ text: 'Close', mod: 'secondary' }]
        : [{ text: 'Cancel', mod: 'secondary' }, { id: 'code-load', text: 'Load battle', mod: 'primary', onClick: loadCode }],
      className: 'sim-dialog', parent: $('menu-page-layout'), onCancel: closeCode,
    });
    var ov = codeModal.overlay, h = ov.querySelector('.sp-modal-body > h2');
    ov.id = 'code-dialog';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    if (h) { h.id = 'code-title'; ov.setAttribute('aria-labelledby', 'code-title'); }
    codeInput.focus();
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
    $: $, el: el, icon: icon, button: button, cap: cap, message: message,
    shareConfig: shareConfig, currentConfig: currentConfig, copyFor: copyFor,
    initial: function () { return initial; },
    renderAll: function () { renderRound(); renderSetup(); },
    startLive: function (cfg, live) { start(cfg, live); },
    swapped: function (cfg) {
      var c = clone(cfg);
      c.units = swapped(c.units);
      c.charge = { player: cfg.charge.computer, computer: cfg.charge.player };
      return c;
    },
    summary: function () { return host ? host.summary() : {}; },
    /* The post strip's Send is the debrief's one primary while it waits (P7). */
    sendPrimary: function (on) { sendIsPrimary = !!on; rankDebrief(); },
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

  function selectDefault() {
    var cmd = draft.filter(function (u) { return u.side === 'player' && u.type === COMMAND_ID; })[0];
    selection = cmd ? { side: 'player', ambit: cmd.ambit, slot: 0, command: true, id: cmd.id } : null;
    changing = false; picking = null;
  }
  function loadLayout() { draft = layout(settings.preset, $('seed').value); selectDefault(); renderRound(); renderSetup(); }

  $('start').addEventListener('click', function () { if (social.onStart()) return; start(); });
  $('ai-level').addEventListener('change', function () { settings.difficulty = $('ai-level').value; renderRound(); });
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

  $('pause').addEventListener('click', function () { if (!host || host.finished || deploying || !host.running) return; autoPaused = false; host.stop(); });
  // Resume and the Paused card's End battle are the modal's own CTAs (P7).
  $('end').addEventListener('click', function () {
    if (deploying) return;
    if (social.liveRole() === 'watch') { social.leave(); toSetup(true); return; }
    confirmEnd();
  });
  document.querySelectorAll('#sim-steps [data-step]').forEach(function (a) {
    a.addEventListener('click', function () { if (stepOpen(a.dataset.step)) STEP_GO[a.dataset.step](); });
  });
  if (window.ResizeObserver) new ResizeObserver(function () { placeBattle(); if (host) fitStatus(); fitFoot(); }).observe($('menu-page-panel'));
  // What the foot holds changes with the round (checks, a challenge, a DM).
  if (window.MutationObserver) new MutationObserver(function (recs) {
    if (recs.some(function (r) { return r.target !== $('sim-go'); })) fitFoot();
  }).observe($('sim-go'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  // The defence web follows the board's tiles as the column resizes.
  if (window.ResizeObserver) new ResizeObserver(function () { drawDefWeb(); }).observe($('arena'));
  window.addEventListener('resize', function () { placeBattle(); if (host) fitStatus(); });

  $('db-rematch').addEventListener('click', function () { if (social.rematch()) return; start(initial); });
  $('db-edit').addEventListener('click', function () { toSetup(false); });
  $('db-swap').addEventListener('click', function () {
    var c = clone(initial);
    c.units = swapped(c.units);
    c.charge = { player: initial.charge.computer, computer: initial.charge.player };
    start(c);
  });
  $('db-harder').addEventListener('click', function () {
    var next = LEVELS[LEVELS.indexOf(initial.difficulty) + 1];
    if (!next) return;
    var c = clone(initial); c.difficulty = next;
    start(c);
  });
  $('db-code').addEventListener('click', shareResult);
  $('db-new').addEventListener('click', function () { social.leave(); toSetup(true); });
  $('post-to').addEventListener('click', function () { social.openPost(currentConfig(), null); });
  $('show-log').addEventListener('click', function () { setScreen('battle'); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // An open dialog takes its own Escape (SUIParts.modal). Paused is kept
    // in the page outside that stack: Escape resumes (P7).
    if (!$('paused').classList.contains('hidden')) resume();
    else if (picking) disarm();
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
