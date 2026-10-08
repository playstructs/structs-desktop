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
    { id: 'hard', name: 'Hard', enemy: 12 }, { id: 'random', name: 'Random', enemy: '6–16' },
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
  function icon(name, size) { var i = el('i', null, 'sui-icon-' + (size || 'md') + ' icon-' + name); i.setAttribute('aria-hidden', 'true'); return i; }
  function button(text, cls, onClick) { var b = el('button', text, cls); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function format(ms) { var sec = Math.floor(ms / 1000); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }
  function message(text) { $('message').textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(function () { $('message').textContent = ''; }, 4500); }
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
  function weaponInfo(t, ws) {
    var primary = ws === 'primaryWeapon';
    var control = Chain.weaponField(t, ws, 'Control');
    var label = primary ? t.primary_weapon_label : t.secondary_weapon_label;
    var shots = Chain.weaponField(t, ws, 'Shots') || 1;
    return {
      icon: control === 'guided' ? 'smart-weapon' : 'ballistic-weapon',
      name: label || (primary ? 'Primary weapon' : (control === 'guided' ? 'Guided' : 'Ballistic') + ' secondary'),
      stats: (Chain.weaponField(t, ws, 'Damage') || 0) + ' dmg' + (shots > 1 ? ' × ' + shots : '') + ' · ' + (Chain.weaponField(t, ws, 'Charge') || 0) + ' charge',
      charge: Chain.weaponField(t, ws, 'Charge') || 0,
    };
  }
  function traitOf(t) { return t.unitDefenses && t.unitDefenses !== 'noUnitDefenses' ? (t.unit_defenses_label || t.unitDefenses) : ''; }

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

  function hullLayers(typeId) {
    var art = A.ART[Host.typeSlug(TYPES[typeId].type)];
    if (!art) return [];
    return (art.bottom || []).concat(['struct-base'], art.top || []).map(function (layer) { return A.artPath(art.dir, layer); });
  }
  function drawHull(into, typeId, cls) {
    hullLayers(typeId).forEach(function (src) {
      var img = el('img', null, cls || ''); img.src = src; img.alt = ''; img.draggable = false; into.appendChild(img);
    });
  }
  function tileStyle(node, ambit) { node.style.backgroundImage = "url('img/tiles/" + ambit + '/' + ambit + "-1-2-top-middle.png')"; }

  /* ── Round card ────────────────────────────────────────────────────────── */

  function choice(list, current, onPick, render) {
    return list.map(function (item) {
      var b = el('button', null, 'sim-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(item.id === current || item.ms === current));
      render(b, item);
      b.addEventListener('click', function () { onPick(item); });
      return b;
    });
  }
  function renderBlockTime(box) {
    box.replaceChildren.apply(box, choice(BLOCK_TIMES, settings.blockMs, function (bt) {
      settings.blockMs = bt.ms;
      if (host) host.setBlockMs(bt.ms);
      renderRound(); renderBlockTime($('pause-block-time')); renderBattleBar();
    }, function (b, bt) { b.appendChild(el('span', bt.name, 'sui-text-label')); b.appendChild(el('span', bt.note, 'sui-text-hint')); }));
  }
  function renderRound() {
    var enc = $('encounters');
    enc.replaceChildren.apply(enc, choice(PRESETS, settings.preset, function (p) {
      settings.preset = p.id;
      // Random rolls a fresh battle on every click, selected or not.
      if (p.id === 'random') $('seed').value = Math.random().toString(36).slice(2, 10);
      if (p.id !== 'random') settings.difficulty = p.id;
      loadLayout();
    }, function (b, p) { b.appendChild(el('span', p.name, 'sui-text-label')); b.appendChild(el('span', String(p.enemy), 'sui-text-label sui-text-hint')); }));
    var lvl = LEVELS.indexOf(settings.difficulty);
    $('ai-level').textContent = cap(settings.difficulty);
    $('ai-down').disabled = lvl <= 0;
    $('ai-up').disabled = lvl >= LEVELS.length - 1;
    renderBlockTime($('block-time'));
    var charges = $('charges'); charges.replaceChildren();
    SIDES.forEach(function (side) {
      var row = el('div', null, 'sim-charge ' + (side === 'player' ? 'sim-you-box' : 'sim-cpu-box'));
      row.appendChild(el('span', side === 'player' ? 'You' : 'Computer', 'sui-text-label ' + (side === 'player' ? 'sim-you' : 'sim-cpu')));
      var step = el('span', null, 'sim-stepper');
      var less = button(null, 'sui-screen-btn sim-tiny', function () { settings.charge[side] = Math.max(0, settings.charge[side] - 1); renderRound(); renderChecks(); });
      less.textContent = '−'; less.setAttribute('aria-label', 'Less opening charge'); less.disabled = settings.charge[side] <= 0;
      var more = button('+', 'sui-screen-btn sim-tiny', function () { settings.charge[side] = Math.min(MAX_CHARGE, settings.charge[side] + 1); renderRound(); renderChecks(); });
      more.setAttribute('aria-label', 'More opening charge'); more.disabled = settings.charge[side] >= MAX_CHARGE;
      step.append(less, el('span', String(settings.charge[side]), 'sui-text-label'), more);
      row.appendChild(step);
      charges.appendChild(row);
    });
  }

  /* ── Setup board ───────────────────────────────────────────────────────── */

  function selected() { return selection && draft.find(function (u) { return u.id === selection.id; }); }
  function select(sel) { selection = sel; changing = false; renderSetup(); }
  function selectUnit(u) { select({ side: u.side, ambit: u.ambit, slot: u.slot, command: u.type === COMMAND_ID, id: u.id }); }

  function renderSetup() {
    if (selection && selection.id && !selected()) selection.id = null;
    var arena = $('arena'); arena.replaceChildren();
    var pickerUnit = picking && draft.find(function (u) { return u.id === picking; });
    AMBITS.forEach(function (ambit) {
      var band = el('div', null, 'band ' + ambit);
      band.appendChild(el('span', ambit, 'ambit-label sui-text-label'));
      SIDES.forEach(function (side) {
        for (var i = -1; i < 4; i++) {
          var command = i === -1, slot = command ? 0 : i;
          var u = draft.find(function (v) { return v.side === side && v.ambit === ambit && (command ? v.type === COMMAND_ID : v.type !== COMMAND_ID && v.slot === slot); });
          if (command && !u) continue;
          var b = el('button', null, 'slot ' + (side === 'player' ? 'friendly' : 'enemy') + (command ? ' command' : ''));
          b.type = 'button';
          b.style.gridColumn = command ? (side === 'player' ? '1' : '7') : String((side === 'player' ? 2 : 5) + Math.floor(slot / 2));
          if (!command) b.style.gridRow = String(slot % 2 + 1);
          b.setAttribute('aria-label', (side === 'player' ? 'Your ' : 'Computer ') + (u ? TYPES[u.type].type : 'empty slot ' + (slot + 1)) + ', ' + ambit);
          var isSel = u ? selection && selection.id === u.id
            : selection && !selection.id && selection.side === side && selection.ambit === ambit && !selection.command && selection.slot === slot;
          if (pickerUnit) {
            var eligible = u && u.side === pickerUnit.side && u !== pickerUnit;
            b.classList.add(u === pickerUnit ? 'selected' : eligible ? 'eligible' : 'dim');
            b.addEventListener('click', function (u, eligible) { if (eligible) setWard(pickerUnit, u.id); }.bind(null, u, eligible));
          } else {
            if (isSel) b.classList.add('selected');
            b.addEventListener('click', function (side, ambit, slot, command, u) {
              if (u) selectUnit(u); else select({ side: side, ambit: ambit, slot: slot, command: command, id: null });
            }.bind(null, side, ambit, slot, command, u));
            // A challenge's fleets are its identity: looked at, not changed.
            if (!u && social.locked()) b.disabled = true;
          }
          if (u) {
            b.dataset.unit = u.id;
            drawHull(b, u.type, 'hull');
            var marks = el('span', null, 'status-indicators');
            if (u.protects) marks.appendChild(el('i', null, 'sui-icon sui-icon-sm sui-icon-defending'));
            if (draft.some(function (v) { return v.protects === u.id; })) marks.appendChild(el('i', null, 'sui-icon sui-icon-sm sui-icon-defended'));
            b.appendChild(marks);
          } else {
            b.appendChild(el('i', null, 'sui-icon-md icon-add empty-label'));
          }
          band.appendChild(b);
        }
      });
      arena.appendChild(band);
    });
    document.body.classList.toggle('sim-picking', !!pickerUnit);
    $('defend-banner').classList.toggle('hidden', !pickerUnit);
    if (pickerUnit) $('defend-text').textContent = TYPES[pickerUnit.type].type + ' defends…';
    var count = function (side) { var n = draft.filter(function (u) { return u.side === side; }).length; return n + (n === 1 ? ' struct' : ' structs'); };
    $('count-you').textContent = count('player');
    $('count-cpu').textContent = count('computer');
    renderChecks();
    renderInspector();
    social.renderSetup();
  }

  function renderReach(box, side, units) {
    var reach = reachOf(side, units);
    var chips = AMBITS.map(function (a) {
      var c = el('span', a.charAt(0).toUpperCase(), 'sim-chip sui-text-label' + (reach[a] ? (side === 'player' ? ' lit-you' : ' lit-cpu') : ''));
      c.title = (reach[a] ? 'Reaches ' : 'Does not reach ') + a;
      c.setAttribute('aria-label', c.title);
      return c;
    });
    box.replaceChildren();
    chips.forEach(function (c) { box.appendChild(c); });
  }

  function renderChecks() {
    var list = readiness(draft);
    var box = $('checks'); box.replaceChildren();
    list.forEach(function (c) {
      var row = el('div', null, 'sim-check' + (c.blocking ? ' sim-blocking' : ''));
      row.appendChild(icon(c.blocking ? 'alert' : 'attention'));
      row.appendChild(el('span', c.text));
      box.appendChild(row);
    });
    $('start').disabled = list.some(function (c) { return c.blocking; });
  }

  /* ── Inspector ─────────────────────────────────────────────────────────── */

  function renderInspector() {
    var box = $('inspector'); box.replaceChildren();
    if (!selection) { box.appendChild(el('div', null, 'sim-card-h')).appendChild(el('span', 'Slot', 'sui-text-label')); return; }
    var u = selected();
    var head = el('div', null, 'sim-card-h');
    head.appendChild(el('span', cap(selection.ambit) + (selection.command ? ' · command' : ' · slot ' + (selection.slot + 1)), 'sui-text-label ' + (selection.side === 'player' ? 'sim-you' : 'sim-cpu')));
    box.appendChild(head);
    var fixed = social.locked();
    if (!u && fixed) return;
    if (!u || changing) { box.appendChild(picker(u)); if (u) box.appendChild(actions([button('Cancel', 'sui-screen-btn', function () { changing = false; renderInspector(); })])); return; }

    var t = TYPES[u.type];
    var hero = el('div', null, 'sim-hero' + (u.side === 'computer' ? ' enemy' : ''));
    tileStyle(hero, u.ambit);
    drawHull(hero, u.type);
    box.appendChild(hero);
    var name = el('div', null, 'sim-name');
    name.appendChild(el('span', t.type, 'sui-text-display'));
    name.appendChild(el('span', t.maxHealth + ' health · counter ' + (t.counterAttack || 0), 'sui-text-hint'));
    if (traitOf(t)) name.appendChild(el('span', traitOf(t), 'sui-text-hint'));
    box.appendChild(name);

    var ws = weapons(t);
    if (ws.length) {
      var list = el('div', null, 'sim-weapons');
      ws.forEach(function (w) {
        var info = weaponInfo(t, w);
        var row = el('div', null, 'sim-weapon');
        row.appendChild(icon(info.icon));
        var text = el('div');
        text.appendChild(el('span', info.name));
        text.appendChild(el('span', info.stats, 'sui-text-hint'));
        var chips = el('span', null, 'sim-chips');
        reachFrom(t, w, u.ambit).forEach(function (a) { chips.appendChild(el('span', a, 'sim-chip sui-text-label')); });
        text.appendChild(chips);
        row.appendChild(text);
        list.appendChild(row);
      });
      box.appendChild(list);
    }

    if (u.type === COMMAND_ID) {
      var amb = el('div', null, 'sim-section');
      amb.appendChild(el('span', 'Ambit', 'sui-text-label sui-text-hint'));
      var seg = el('div', null, 'sim-seg');
      seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Command ship ambit');
      AMBITS.filter(function (a) { return fits(t, a); }).forEach(function (a) {
        var b = button(null, 'sim-opt', function () { u.ambit = a; selection.ambit = a; renderSetup(); });
        b.disabled = fixed;
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(u.ambit === a));
        b.appendChild(el('span', a.charAt(0).toUpperCase(), 'sui-text-label'));
        b.setAttribute('aria-label', a);
        seg.appendChild(b);
      });
      amb.appendChild(seg);
      box.appendChild(amb);
      return;
    }

    if (t.canDefend) {
      var def = el('div', null, 'sim-section');
      def.appendChild(el('span', 'Defends', 'sui-text-label sui-text-hint'));
      var row = el('div', null, 'sim-row');
      var guard = el('select', null, 'sim-input'); guard.setAttribute('aria-label', 'Defends');
      var off = el('option', 'Nothing'); off.value = ''; guard.appendChild(off);
      draft.filter(function (v) { return v.side === u.side && v !== u; }).forEach(function (v) {
        var o = el('option', TYPES[v.type].type + (v.type === COMMAND_ID ? '' : ' · ' + v.ambit + ' ' + (v.slot + 1))); o.value = v.id; guard.appendChild(o);
      });
      guard.value = u.protects || '';
      guard.addEventListener('change', function () { setWard(u, guard.value || null); });
      guard.disabled = fixed;
      var pick = button(null, 'sui-screen-btn sim-square', function () { picking = u.id; renderSetup(); });
      pick.appendChild(icon('defend')); pick.setAttribute('aria-label', 'Pick on the board'); pick.title = 'Pick on the board';
      row.append(guard);
      if (!fixed) row.append(pick);
      def.appendChild(row);
      box.appendChild(def);
    }
    if (fixed) return;
    box.appendChild(actions([
      button('Change', 'sui-screen-btn sui-mod-secondary', function () { changing = true; renderInspector(); }),
      button('Remove', 'sui-screen-btn sui-mod-destructive', function () { place(null); }),
    ]));
  }
  function actions(buttons) { var a = el('div', null, 'sim-actions'); buttons.forEach(function (b) { a.appendChild(b); }); return a; }

  function picker(current) {
    var list = el('div', null, 'sim-picks');
    Object.keys(TYPES).map(Number).filter(function (id) { return id !== COMMAND_ID && fits(TYPES[id], selection.ambit); }).forEach(function (id) {
      var t = TYPES[id];
      var b = button(null, 'sim-pick', function () { place(id); });
      if (current && current.type === id) b.setAttribute('aria-current', 'true');
      var thumb = el('span', null, 'sim-thumb'); tileStyle(thumb, selection.ambit); drawHull(thumb, id);
      var text = el('span');
      text.appendChild(el('span', t.type, 'sui-text-label'));
      var main = weapons(t)[0];
      if (main) text.appendChild(el('span', weaponInfo(t, main).name, 'sui-text-hint'));
      var chips = el('span', null, 'sim-chips');
      var reach = {};
      weapons(t).forEach(function (w) { reachFrom(t, w, selection.ambit).forEach(function (a) { reach[a] = true; }); });
      AMBITS.filter(function (a) { return reach[a]; }).forEach(function (a) { chips.appendChild(el('span', a, 'sim-chip sui-text-label')); });
      text.appendChild(chips);
      if (traitOf(t)) text.appendChild(el('span', traitOf(t), 'sui-text-hint'));
      b.append(thumb, text);
      b.setAttribute('aria-label', 'Place ' + t.type);
      list.appendChild(b);
    });
    return list;
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
    if (social) social.renderPanels();
  }

  function stopBattle() {
    autoPaused = false;
    if (host) { host.destroy(); host = null; }
    clearInterval(clockTimer); clearInterval(countdownTimer); clearTimeout(debriefTimer);
    deploying = false;
    document.body.classList.remove('sim-deploying');
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
          players: { host: live.host, guest: live.guest }, send: live.send, onChange: onChange,
        });
        live.remote(host);
      } else {
        var cpu = live ? { id: CPU.id, name: live.guest.name, pfp: live.guest.pfp, label: live.guest.name + '\u2019s fleet' }
          : { id: CPU.id, name: CPU.fleetName + ' · ' + config.difficulty, pfp: CPU.pfp };
        host = new Host({
          chain: chain, you: YOU, cpu: cpu, label: 'sim', blockMs: config.blockMs,
          ai: live ? null : new Ai(CPU.id, config.difficulty, config.seed),
          frame: frame, onChange: onChange,
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

  /* Deploy: the matchup, a 3·2·1, then the first block. */
  function deploy(config) {
    deploying = true;
    document.body.classList.add('sim-deploying');
    var mine = config.units.filter(function (u) { return u.side === 'player'; }).length;
    var theirs = config.units.length - mine;
    $('deploy-you').textContent = mine + ' structs · ' + config.charge.player + ' charge';
    document.querySelector('#deploy .sim-side-cpu .sim-cpu').textContent = social.opponentName() || 'Computer';
    $('deploy-cpu').textContent = theirs + ' structs · ' + config.charge.computer + ' charge';
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
      if (host) host.start();
    }, 1000);
  }

  function renderBattleBar() {
    if (!host) return;
    var cfg = initial;
    var chips = $('chips'); chips.replaceChildren();
    [cap(cfg.difficulty), BLOCK_TIMES.filter(function (b) { return b.ms === settings.blockMs; }).map(function (b) { return b.name; })[0] || (settings.blockMs / 1000 + ' s')]
      .forEach(function (text) { chips.appendChild(el('span', text, 'sim-chip sui-text-label')); });
    if (social.matches(cfg)) {
      chips.insertBefore(el('span', social.battleName(), 'sim-chip sim-tag sui-text-label'), chips.firstChild);
      var lad = (social.view() && social.view().ladder) || [];
      if (lad[0]) chips.appendChild(el('span', 'best ' + lad[0].outcome.time, 'sui-text-label sui-text-hint'));
    }
    if (social.isLive()) {
      chips.insertBefore(el('span', 'Live', 'sim-chip sim-live-chip sui-text-label'), chips.firstChild);
      var conn = social.connection();
      if (conn) chips.appendChild(el('span', conn.text, 'sui-text-label sim-conn sim-conn-' + conn.state));
    }
    var standing = host.standing(), fielded = host.fielded;
    var st = $('standing'); st.replaceChildren(
      el('span', standing[YOU.id] + '/' + fielded[YOU.id], 'sim-you'), el('span', ' · ', 'sui-text-hint'),
      el('span', standing[CPU.id] + '/' + fielded[CPU.id], 'sim-cpu'));
    st.title = 'Structs standing';
    var f = host.finished;
    var block = host.chain.height - startHeight;
    $('phase').textContent = deploying ? 'Deploying' : f ? 'Battle over' : host.running ? 'Block ' + block
      : social.isLive() ? 'Waiting · block ' + block : 'Paused · block ' + block;
    $('pause').querySelector('span').textContent = host.running || deploying ? 'Pause' : 'Resume';
    $('pause').classList.toggle('hidden', !!f);
    $('end').classList.toggle('hidden', !!f);
    $('to-debrief').classList.toggle('hidden', !f);
    if (f && !debriefShown && !debriefTimer) {
      clearInterval(clockTimer);
      debriefTimer = setTimeout(function () { debriefTimer = null; showDebrief(); }, f.forfeit ? 0 : DEBRIEF_DELAY_MS);
    }
  }

  var pausedShown = false;
  function renderPaused() {
    var show = !!host && !host.running && !host.finished && !deploying && !social.isLive();
    $('paused').classList.toggle('hidden', !show);
    // The choices are rebuilt only as the menu opens: the clock ticks every
    // 250 ms and a rebuild under the pointer would swallow the click.
    if (show && !pausedShown) renderBlockTime($('pause-block-time'));
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

  function showDebrief() {
    if (!host || !host.finished) return;
    debriefShown = true;
    var s = host.summary(), f = s.finished;
    var verdict = f.winner === 'you' ? 'victory' : f.winner === 'cpu' ? 'defeat' : 'draw';
    $('verdict').textContent = cap(verdict);
    $('verdict').className = 'sui-text-display sim-huge ' + verdict;
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
    $('debrief-meta').textContent = [format(s.elapsedMs), blocks + (blocks === 1 ? ' block' : ' blocks'), initial.difficulty, initial.seed].join(' · ');

    var rows = [
      ['Structs lost', s.lost[YOU.id], s.lost[CPU.id]],
      ['Attacks', s.stats[YOU.id].attacks, s.stats[CPU.id].attacks],
      ['Damage dealt', s.stats[YOU.id].damage, s.stats[CPU.id].damage],
      ['Shots evaded', s.stats[YOU.id].evaded, s.stats[CPU.id].evaded],
      ['Blocked by defenders', s.stats[YOU.id].blocked, s.stats[CPU.id].blocked],
      ['Counter damage', s.stats[YOU.id].countered, s.stats[CPU.id].countered],
    ];
    $('tallies').replaceChildren.apply($('tallies'), rows.map(function (r) {
      var row = el('div', null, 'sim-tally');
      row.append(el('span', r[0]), el('span', String(r[1]), 'sui-text-label'), el('span', String(r[2]), 'sui-text-label'));
      return row;
    }));

    var moments = $('moments'); moments.replaceChildren();
    turningPoints(s.kills).forEach(function (m) {
      var row = el('div', null, 'sim-moment');
      row.appendChild(el('span', 'B' + m.block, 'sui-text-label'));
      var text = el('span');
      text.append(el('span', m.who, m.mine ? 'sim-you' : 'sim-cpu'), el('span', m.what, 'sui-text-hint'));
      row.appendChild(text);
      moments.appendChild(row);
    });
    if (!moments.children.length) moments.appendChild(el('div', 'No structs destroyed', 'sim-moment sui-text-hint'));

    var next = LEVELS[LEVELS.indexOf(initial.difficulty) + 1];
    var liveRole = social.liveRole();
    $('db-edit').classList.toggle('hidden', !!liveRole);
    $('db-swap').classList.toggle('hidden', !!liveRole);
    $('db-rematch').classList.toggle('hidden', liveRole === 'guest' || liveRole === 'watch');
    $('db-harder').classList.toggle('hidden', !next || !!liveRole);
    if (next) { $('db-harder').textContent = 'Harder'; $('db-harder').title = 'Rematch against a ' + cap(next) + ' opponent'; }
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
  function openCode(text, title) {
    $('layout-code').value = text || '';
    $('code-load').classList.toggle('hidden', !!text);
    $('code-title').textContent = title || (text ? 'Share' : 'Paste a battle link');
    $('code-dialog').classList.remove('hidden');
    $('layout-code').focus();
    if (text) $('layout-code').select();
  }
  function closeCode() { $('code-dialog').classList.add('hidden'); }
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
      applyConfig(parsePasted($('layout-code').value.trim()));
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
  $('ai-down').addEventListener('click', function () { settings.difficulty = LEVELS[Math.max(0, LEVELS.indexOf(settings.difficulty) - 1)]; renderRound(); });
  $('ai-up').addEventListener('click', function () { settings.difficulty = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(settings.difficulty) + 1)]; renderRound(); });
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
  $('defend-cancel').addEventListener('click', function () { picking = null; renderSetup(); });
  $('export').addEventListener('click', function () { copyLink(currentConfig()); });
  $('import').addEventListener('click', function () { openCode(''); });
  $('code-close').addEventListener('click', closeCode);
  $('code-load').addEventListener('click', loadCode);

  $('pause').addEventListener('click', function () { if (!host || host.finished || deploying) return; autoPaused = false; if (host.running) host.stop(); else host.start(); });
  $('resume').addEventListener('click', function () { autoPaused = false; if (host && !host.finished) host.start(); });
  $('restart').addEventListener('click', function () { if (initial) start(initial); });
  $('pause-rematch').addEventListener('click', function () { if (initial) start(initial); });
  $('pause-edit').addEventListener('click', function () { toSetup(false); });
  $('end').addEventListener('click', function () { if (host) host.forfeit(); });
  $('pause-end').addEventListener('click', function () { if (host) host.forfeit(); });
  $('to-debrief').addEventListener('click', showDebrief);

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
    if (!$('code-dialog').classList.contains('hidden')) closeCode();
    else if (!$('post-dialog').classList.contains('hidden')) social.closePost();
    else if (picking) { picking = null; renderSetup(); }
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
    takeContext: function () { return social.take(); }, social: social, runResult: runResult,
  };
  setScreen('setup');
  loadLayout();
  var linked = /[?&]sim=([A-Za-z0-9_-]{4,2000})/.exec(location.search || '');
  if (linked) openLink(linked[1]);
  social.take();
})();
