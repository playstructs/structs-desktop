/* Battle Simulator: fleet setup, then a battle on the real Map Viewer.
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
  var START_CHARGE = 9;   // both fleets arrive with a full battery

  var draft, selection = null, host = null, initial = null, toastTimer, clockTimer;

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function format(ms) { var sec = Math.floor(ms / 1000); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }
  function message(text) { $('message').textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(function () { $('message').textContent = ''; }, 4500); }
  function rng(seed) {
    var n = 2166136261;
    String(seed).split('').forEach(function (c) { n = Math.imul(n ^ c.charCodeAt(0), 16777619); });
    return function () { n += 0x6D2B79F5; var t = Math.imul(n ^ n >>> 15, 1 | n); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function fits(t, ambit) { return (t.possibleAmbit & FLAG[ambit]) !== 0; }
  function unitId(side, typeId, ambit, slot) { return side + '-' + (typeId === COMMAND_ID ? 'cmd' : ambit + '-' + slot); }

  /* ── Layouts ───────────────────────────────────────────────────────────── */

  function layout(mode, seed) {
    var random = rng(seed), units = [];
    ['player', 'computer'].forEach(function (side) {
      var cmdAmbit = mode === 'random' ? AMBITS[Math.floor(random() * 4)] : 'space';
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
    ['player', 'computer'].forEach(function (side) {
      if (units.filter(function (u) { return u && u.side === side && u.type === COMMAND_ID; }).length !== 1) throw Error('Each fleet needs exactly one command ship.');
    });
    var ids = {};
    units.forEach(function (u) {
      var t = TYPES[u.type];
      if (!t || ['player', 'computer'].indexOf(u.side) < 0 || AMBITS.indexOf(u.ambit) < 0 || !fits(t, u.ambit)
        || !Number.isInteger(u.slot) || u.slot < 0 || u.slot > 3 || u.id !== unitId(u.side, u.type, u.ambit, u.slot) || ids[u.id]) {
        throw Error('Invalid fleet layout.');
      }
      ids[u.id] = u;
    });
    units.forEach(function (u) {
      if (u.protects == null) return;
      var ward = ids[u.protects];
      if (typeof u.protects !== 'string' || !ward || ward.side !== u.side || ward === u || !TYPES[u.type].canDefend) throw Error('A defender protects one other struct of its own fleet.');
    });
  }

  /* ── Setup board ───────────────────────────────────────────────────────── */

  function selected() { return selection && draft.find(function (u) { return u.id === selection.id; }); }

  function renderSetup() {
    var arena = $('arena'); arena.replaceChildren();
    AMBITS.forEach(function (ambit) {
      var band = el('div', null, 'band ' + ambit);
      band.appendChild(el('span', ambit, 'ambit-label sui-text-label'));
      ['player', 'computer'].forEach(function (side) {
        for (var i = -1; i < 4; i++) {
          var command = i === -1, slot = command ? 0 : i;
          var u = draft.find(function (v) { return v.side === side && v.ambit === ambit && (command ? v.type === COMMAND_ID : v.type !== COMMAND_ID && v.slot === slot); });
          if (command && !u) continue;
          var b = el('button', null, 'slot ' + (side === 'player' ? 'friendly' : 'enemy') + (command ? ' command' : ''));
          b.type = 'button';
          b.style.gridColumn = command ? (side === 'player' ? '1' : '7') : String((side === 'player' ? 2 : 5) + Math.floor(slot / 2));
          if (!command) b.style.gridRow = String(slot % 2 + 1);
          b.setAttribute('aria-label', (side === 'player' ? 'Your ' : 'Computer ') + (u ? TYPES[u.type].type : 'empty slot ' + (slot + 1)) + ', ' + ambit);
          b.addEventListener('click', function (side, ambit, slot, command, u) {
            selection = { side: side, ambit: ambit, slot: slot, command: command, id: u && u.id }; renderSetup();
          }.bind(null, side, ambit, slot, command, u));
          if (u) {
            b.dataset.unit = u.id;
            if (selection && selection.id === u.id) b.classList.add('selected');
            var art = A.ART[Host.typeSlug(TYPES[u.type].type)];
            if (art) (art.bottom || []).concat(['struct-base'], art.top || []).forEach(function (layer) {
              var img = el('img', null, 'hull'); img.src = A.artPath(art.dir, layer); img.alt = ''; img.draggable = false; b.appendChild(img);
            });
            var marks = el('span', null, 'status-indicators');
            if (u.protects) marks.appendChild(el('i', null, 'sui-icon sui-icon-sm sui-icon-defending'));
            if (draft.some(function (v) { return v.protects === u.id; })) marks.appendChild(el('i', null, 'sui-icon sui-icon-sm sui-icon-defended'));
            b.appendChild(marks);
          } else {
            b.appendChild(el('i', null, 'sui-icon-md icon-fleet-tile empty-label'));
            if (selection && !selection.id && selection.side === side && selection.ambit === ambit && !selection.command && selection.slot === slot) b.classList.add('selected');
          }
          band.appendChild(b);
        }
      });
      arena.appendChild(band);
    });
    renderInspector();
  }

  function renderInspector() {
    var box = $('inspector'); box.replaceChildren();
    var u = selected();
    box.appendChild(el('h2', u ? TYPES[u.type].type : selection ? 'Empty slot' : 'Fleet setup', 'sui-text-header'));
    if (!selection) return;
    box.appendChild(el('p', (selection.side === 'player' ? 'Your fleet' : 'Computer fleet') + ' · ' + selection.ambit + (selection.command ? ' · command' : ' · slot ' + (selection.slot + 1)), 'sui-text-hint'));
    if (selection.command) {
      var move = el('select'); move.setAttribute('aria-label', 'Command ship ambit');
      AMBITS.filter(function (a) { return fits(TYPES[COMMAND_ID], a); }).forEach(function (a) { var o = el('option', a); o.value = a; o.selected = u.ambit === a; move.appendChild(o); });
      move.addEventListener('change', function () { u.ambit = move.value; selection.ambit = move.value; renderSetup(); });
      box.appendChild(move);
    } else {
      var picker = el('select'); picker.setAttribute('aria-label', 'Struct type');
      var none = el('option', 'Empty'); none.value = ''; picker.appendChild(none);
      Object.keys(TYPES).map(Number).filter(function (id) { return id !== COMMAND_ID && fits(TYPES[id], selection.ambit); }).forEach(function (id) {
        var o = el('option', TYPES[id].type); o.value = id; picker.appendChild(o);
      });
      picker.value = u ? String(u.type) : '';
      picker.addEventListener('change', function () {
        if (u) {
          draft = draft.filter(function (v) { return v !== u; });
          draft.forEach(function (v) { if (v.protects === u.id) v.protects = null; });
        }
        if (picker.value) {
          var type = Number(picker.value);
          var added = { id: unitId(selection.side, type, selection.ambit, selection.slot), side: selection.side, type: type, ambit: selection.ambit, slot: selection.slot, protects: null };
          draft.push(added); selection.id = added.id;
        } else selection.id = null;
        renderSetup();
      });
      box.appendChild(picker);
    }
    if (!u) return;
    var t = TYPES[u.type];
    if (u.type !== COMMAND_ID && t.canDefend) {
      var guard = el('select'); guard.setAttribute('aria-label', 'Defends');
      var off = el('option', 'Defends nothing'); off.value = ''; guard.appendChild(off);
      draft.filter(function (v) { return v.side === u.side && v !== u; }).forEach(function (v) {
        var o = el('option', 'Defends ' + TYPES[v.type].type + ' · ' + v.ambit + (v.type === COMMAND_ID ? '' : ' ' + (v.slot + 1))); o.value = v.id; guard.appendChild(o);
      });
      guard.value = u.protects || '';
      guard.addEventListener('change', function () { u.protects = guard.value || null; renderSetup(); });
      box.appendChild(guard);
    }
  }

  /* ── Battle ────────────────────────────────────────────────────────────── */

  function chainFromDraft(units, seed, difficulty) {
    var ids = {}, n = { player: 1000, computer: 2000 };
    // Command Ship first, then ambit by ambit, so ids read like a fleet built in order.
    var ordered = units.slice().sort(function (a, b) {
      return (a.type === COMMAND_ID ? -1 : 0) - (b.type === COMMAND_ID ? -1 : 0) || AMBITS.indexOf(a.ambit) - AMBITS.indexOf(b.ambit) || a.slot - b.slot;
    });
    ordered.forEach(function (u) { ids[u.id] = '5-' + (++n[u.side]); });
    var height = 100000 + Math.floor(rng(seed + '#h')() * 900000);
    return new Chain({
      types: window.SimulatorTypes.types, seed: seed + '|' + difficulty, height: height, planetId: '2-1',
      players: [
        { id: YOU.id, name: YOU.name, fleetId: YOU.fleetId, charge: START_CHARGE },
        { id: CPU.id, name: CPU.name, fleetId: CPU.fleetId, charge: START_CHARGE },
      ],
      structs: ordered.map(function (u) {
        return { id: ids[u.id], typeId: u.type, owner: u.side === 'player' ? YOU.id : CPU.id, ambit: u.ambit, slot: u.slot, protects: u.protects ? ids[u.protects] : null };
      }),
    });
  }

  function start(config) {
    try {
      config = config || { units: JSON.parse(JSON.stringify(draft)), seed: $('seed').value, difficulty: $('difficulty').value };
      validate(config.units);
      initial = config;
      if (host) host.destroy();
      var chain = chainFromDraft(config.units, config.seed, config.difficulty);
      var cpu = { id: CPU.id, name: CPU.fleetName + ' · ' + config.difficulty, pfp: CPU.pfp };
      host = new Host({
        chain: chain, you: YOU, cpu: cpu, label: 'sim',
        ai: new Ai(CPU.id, config.difficulty, config.seed),
        frame: function () { var f = $('board'); return f && f.contentWindow; },
        onChange: renderBattleBar,
      });
      $('setup-screen').classList.add('hidden');
      $('battle-screen').classList.remove('hidden');
      $('result').classList.add('hidden');
      $('board').src = 'raidview.html?planet=' + chain.planetId + '&label=sim&sim=1';
      host.start();
      clearInterval(clockTimer);
      clockTimer = setInterval(renderBattleBar, 250);
    } catch (e) { message(e.message); }
  }

  function renderBattleBar() {
    if (!host) return;
    $('timer').textContent = format(host.elapsedMs());
    $('pause').textContent = host.running ? 'Pause' : 'Resume';
    $('pause').classList.toggle('hidden', !!host.finished);
    $('phase').textContent = host.finished ? 'Battle over' : host.running ? 'Block ' + host.chain.height : 'Paused';
    if (host.finished && $('result').classList.contains('hidden')) {
      var w = host.finished.winner;
      $('result').replaceChildren(
        el('strong', w === 'you' ? 'VICTORY' : w === 'cpu' ? 'DEFEAT' : 'DRAW', 'sui-text-display'),
        el('small', (w === 'you' ? 'Computer fleet defeated' : w === 'cpu' ? 'Your fleet defeated' : 'Both fleets defeated') + ' · ' + format(host.elapsedMs()) + ' · block ' + host.finished.height, 'sui-text-hint'));
      $('result').classList.remove('hidden');
      clearInterval(clockTimer);
    }
  }

  function toSetup() {
    if (host) { host.destroy(); host = null; }
    clearInterval(clockTimer);
    $('board').src = 'about:blank';
    if (initial) draft = JSON.parse(JSON.stringify(initial.units));
    selection = null;
    $('battle-screen').classList.add('hidden');
    $('setup-screen').classList.remove('hidden');
    renderSetup();
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  function loadLayout(mode) { draft = layout(mode, $('seed').value); selection = null; renderSetup(); }
  $('start').addEventListener('click', function () { start(); });
  $('generate').addEventListener('click', function () { loadLayout($('preset').value); });
  $('preset').addEventListener('change', function () { if ($('preset').value !== 'random') $('difficulty').value = $('preset').value; loadLayout($('preset').value); });
  $('randomize').addEventListener('click', function () { $('seed').value = Math.random().toString(36).slice(2, 10); $('preset').value = 'random'; loadLayout('random'); });
  $('pause').addEventListener('click', function () { if (!host || host.finished) return; if (host.running) host.stop(); else host.start(); });
  $('restart').addEventListener('click', function () { if (initial) start(initial); });
  $('setup').addEventListener('click', toSetup);
  $('export').addEventListener('click', function () {
    $('layout-code').value = JSON.stringify({ version: 2, seed: $('seed').value, difficulty: $('difficulty').value, units: draft });
    $('layout-code').select(); message('Layout code ready to copy.');
  });
  $('import').addEventListener('click', function () {
    try {
      if ($('layout-code').value.length > 20000) throw Error('Layout code is too large.');
      var config = JSON.parse($('layout-code').value);
      if (config.version !== 2 || typeof config.seed !== 'string' || config.seed.length > 60 || !Ai.LEVELS[config.difficulty]) throw Error('Invalid layout code.');
      validate(config.units);
      draft = config.units.map(function (u) { return { id: u.id, side: u.side, type: u.type, ambit: u.ambit, slot: u.slot, protects: u.protects || null }; });
      $('seed').value = config.seed; $('difficulty').value = config.difficulty; selection = null; renderSetup();
      message('Layout loaded.');
    } catch (e) { message(e instanceof SyntaxError ? 'Layout code is not valid JSON.' : e.message); }
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden && host && host.running) host.stop(); });
  window.addEventListener('beforeunload', function () { if (host) host.destroy(); clearInterval(clockTimer); });

  window.Simulator = { getHost: function () { return host; }, getLayout: function () { return draft; }, layout: layout, validate: validate, start: start, toSetup: toSetup };
  draft = layout('difficult', 'spearpoint');
  renderSetup();
})();
