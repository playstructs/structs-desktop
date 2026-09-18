// STRUCTS TERMINAL — the sound designer card (⌘K → SOUNDS).
//
// Every mount point the game can cue (frontend/sound-catalogue.js), grouped
// as the catalogue groups them; per mount, the file(s) it plays, and the
// settings the engine honours: delay, loop, loop count, volume, enabled, and
// how several files are picked. A TAPE view shows cues as they fire in any
// window — including the SILENT ones, which is the designer's loop: click a
// thing in the game, see the mount that fired, point it at a file, click again.
//
// Nothing is uploaded anywhere. Files are picked with the native dialog from
// Rust (`sound_pick_file`), which stores the path in sound.json and answers
// the file's NAME; this card never sees or sends a path.
//
// Repaint rule (the Replication card's): writes go through `sound_mount_set`
// / `sound_config_set`, and it is the `sound-config` EVENT — never the
// command's answer — that repaints, so two open cards (or the web copy)
// agree. Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };
  var Cat = function () { return window.StructsSoundCatalogue; };
  var Snd = function () { return window.StructsSound; };
  var Cards = function () { return window.StructsCards; };
  var TAPE_MAX = 50;
  var WRITE_MS = 300;

  var SD = { cards: {}, listening: false, cfg: null, tape: [], view: null, selected: null, filter: '' };

  function stamp(msg) { if (Board.stamp) Board.stamp('sounds: ' + msg); }
  function mountOf(id) { return (SD.cfg && SD.cfg.mounts && SD.cfg.mounts[id]) || null; }
  function defaultsOf(id) { var m = Cat().byId[id]; return m ? m.defaults : { delay_ms: 0, loop: false, loop_count: 0, volume: 1, enabled: true, pick: 'random' }; }
  function eff(id) {
    var d = defaultsOf(id), m = mountOf(id) || {}, out = {};
    Object.keys(d).forEach(function (k) { out[k] = (m[k] !== undefined && m[k] !== null) ? m[k] : d[k]; });
    out.files = m.files || [];
    return out;
  }
  function repaintAll() {
    Object.keys(SD.cards).forEach(function (id) {
      var c = SD.cards[id];
      if (!c.host || !c.host.isConnected) { delete SD.cards[id]; return; }
      c.paint();
    });
  }
  function listen() {
    if (SD.listening || !window.StructsEvents) return;
    SD.listening = true;
    window.StructsEvents.listen('sound-config', function (e) {
      if (!e || !e.payload) return;
      SD.cfg = e.payload;
      repaintAll();
    });
    window.StructsEvents.listen('sound-trace', function (e) {
      var p = e && e.payload;
      if (!p || !p.cues) return;
      p.cues.forEach(function (rec) {
        SD.tape.unshift(Object.assign({ window: p.window }, rec));
      });
      if (SD.tape.length > TAPE_MAX) SD.tape.length = TAPE_MAX;
      Object.keys(SD.cards).forEach(function (id) { var c = SD.cards[id]; if (c.paintTape) c.paintTape(); });
    });
  }

  // Writes: one debounced patch per mount.
  var pending = {};
  function write(id, patch) {
    var p = pending[id] = pending[id] || { patch: {}, timer: null };
    Object.assign(p.patch, patch);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(function () {
      var body = p.patch;
      delete pending[id];
      invoke('sound_mount_set', { id: id, patch: body }).catch(function (e) { stamp(id + ': ' + e); });
    }, WRITE_MS);
  }
  function writeGlobal(patch) {
    invoke('sound_config_set', { patch: patch }).catch(function (e) { stamp(String(e)); });
  }
  function pick(id, replace) {
    invoke('sound_pick_file', { id: id, replace: replace == null ? null : replace }).catch(function (e) { stamp(id + ': ' + e); });
  }
  function audition(id) {
    var S = Snd();
    if (!S) { stamp('no engine in this window'); return; }
    S.test(id).then(function (r) { if (r && r.ok === false) stamp(id + ': ' + r.error); });
  }
  function stopAll() { var S = Snd(); if (S) S.stopAll({ music: true }); }

  // ── Pieces ──
  function fmtTime(ms) {
    var d = new Date(ms || Date.now());
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '.' + String(d.getMilliseconds() + 1000).slice(1);
  }
  function chip(f, id, index) {
    var c = H.el('span', 'sd-chip' + (f.ok === false ? ' sd-chip-bad' : ''));
    c.title = f.ok === false ? (f.reason || 'unavailable') : (f.size ? Math.round(f.size / 1024) + ' KB' : '');
    c.appendChild(H.el('span', 'sd-chip-name', f.name || '?'));
    if (f.ok === false && f.reason) c.appendChild(H.el('span', 'sd-chip-why sui-text-warning', f.reason));
    var x = H.el('a', 'sd-chip-x');
    x.href = 'javascript:void(0)';
    x.title = 'Remove this file';
    x.appendChild(H.el('i', 'sui-icon sui-icon-sm icon-close'));
    x.addEventListener('click', function (e) { e.stopPropagation(); write(id, { remove_file: index }); });
    c.appendChild(x);
    return c;
  }
  function marksFor(m, e) {
    var d = defaultsOf(m.id), list = [];
    if (m.kind !== 'oneshot') list.push({ value: m.kind === 'music' ? 'music' : 'loop', title: 'plays as a ' + m.kind });
    if (m.optional) list.push({ value: 'optional', title: 'a refinement nobody has to map' });
    if (e.delay_ms !== d.delay_ms) list.push({ value: e.delay_ms + 'ms', title: 'delay' });
    if (e.loop !== d.loop) list.push({ value: e.loop ? 'loop' : 'once', title: 'loop' });
    if (e.loop && e.loop_count !== d.loop_count) list.push({ value: '×' + (e.loop_count || '∞'), title: 'loop count' });
    if (e.volume !== d.volume) list.push({ value: Math.round(e.volume * 100) + '%', title: 'volume' });
    if (e.enabled === false) list.push({ value: 'off', attn: true, title: 'disabled' });
    if (e.files.length > 1) list.push({ value: e.pick, title: 'how a file is chosen' });
    if (!list.length) return null;
    // The player card's mark line (pc-marks / pc-mark), which structs-cards
    // restyles as sc-marks; the kit does not export its builder.
    var line = H.el('div', 'pc-marks sc-marks');
    list.forEach(function (m) {
      var sp = H.el('span', 'pc-mark' + (m.attn ? ' pc-attn' : ''), m.value);
      if (m.title) sp.title = m.title;
      line.appendChild(sp);
    });
    return line;
  }
  function settings(m, e) {
    var box = H.el('div', 'sd-settings');
    box.appendChild(H.field('Delay ms', H.stepper(e.delay_ms, { min: 0, max: 60000, step: 50, width: '5em' }, function (v) { write(m.id, { delay_ms: Number(v) || 0 }); })));
    if (m.kind !== 'music') {
      box.appendChild(H.checkbox(!!e.loop, 'Loop', function (on) { write(m.id, { loop: !!on }); }));
      box.appendChild(H.field('Loop count', H.stepper(e.loop_count, { min: 0, max: 1000, step: 1, width: '4em' }, function (v) { write(m.id, { loop_count: Number(v) || 0 }); })));
    }
    box.appendChild(H.field('Volume %', H.stepper(Math.round(e.volume * 100), { min: 0, max: 200, step: 5, width: '4em' }, function (v) { write(m.id, { volume: (Number(v) || 0) / 100 }); })));
    box.appendChild(H.checkbox(e.enabled !== false, 'Enabled', function (on) { write(m.id, { enabled: !!on }); }));
    if (e.files.length > 1 || m.kind === 'music') {
      box.appendChild(H.field('Pick', H.selectBox(e.pick, [{ value: 'random', label: 'random' }, { value: 'sequence', label: 'in order' }], function (v) { write(m.id, { pick: v }); })));
    }
    return box;
  }
  function row(m, card) {
    var e = eff(m.id);
    var r = H.el('div', 'sd-row' + (SD.selected === m.id ? ' is-selected' : ''));
    r.setAttribute('data-mount', m.id);
    r.setAttribute('data-kind', m.kind);
    r.setAttribute('data-state', e.files.length ? 'set' : 'silent');
    r.tabIndex = 0;

    var ident = H.el('div', 'sd-ident');
    ident.appendChild(H.el('span', 'sd-label', m.label));
    ident.appendChild(H.el('span', 'sd-when fstat-l', m.when));
    var mk = marksFor(m, e);
    if (mk) ident.appendChild(mk);
    r.appendChild(ident);

    var files = H.el('div', 'sd-files');
    if (e.files.length) e.files.forEach(function (f, i) { files.appendChild(chip(f, m.id, i)); });
    else files.appendChild(H.el('span', 'sd-chip sd-silent', 'SILENT'));
    r.appendChild(files);

    var doors = Cards() ? Cards().doors([
      { icon: 'icon-add', title: 'Add a file (WAV or MP3)', onClick: function () { pick(m.id, null); } },
      { icon: 'icon-caret-right', title: 'Test', onClick: function () { audition(m.id); } },
      { icon: 'icon-close', title: 'Stop', onClick: function () { stopAll(); } },
      e.files.length ? { icon: 'icon-subtract', title: 'Clear files', destructive: true, onClick: function () { write(m.id, { clear_files: true }); } } : null,
    ]) : null;
    if (doors) { doors.classList.add('sd-doors'); r.appendChild(doors); }

    if (SD.selected === m.id) r.appendChild(settings(m, e));

    ident.addEventListener('click', function () {
      SD.selected = SD.selected === m.id ? null : m.id;
      card.paint();
    });
    return r;
  }
  function tapeRow(rec, card) {
    var hit = !rec.silent && rec.resolved;
    var r = H.el('div', 'sd-tape-row ' + (hit ? 'sd-hit' : 'sd-silent'));
    var target = rec.resolved || (rec.candidates && rec.candidates[0]) || '?';
    r.appendChild(H.el('span', 'sd-t fstat-l', fmtTime(rec.ts_ms)));
    r.appendChild(H.el('span', 'sd-w fstat-l', rec.window || ''));
    var cueEl = H.el('span', 'sd-cue', target + (hit ? '' : ' · ' + (rec.reason || 'silent')));
    r.appendChild(cueEl);
    r.appendChild(H.el('span', 'sd-cands fstat-l', (rec.candidates || []).join(' › ') + (rec.file ? ' · ' + rec.file : '')));
    var doors = Cards() ? Cards().doors([
      { icon: 'icon-add', title: 'Pick a file for ' + target, onClick: function () { pick(target, null); } },
    ]) : null;
    if (doors) r.appendChild(doors);
    r.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.sc-actions')) return;
      var m = Cat().byId[target];
      if (!m) return;
      SD.view = m.group;
      SD.selected = m.id;
      card.paint();
      var el = card.host.querySelector('.sd-row[data-mount="' + m.id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    });
    return r;
  }

  // ── The card ──
  T.register('sounds', {
    label: 'Sounds', describe: function () { return 'Sounds'; },
    single: true, cadenceMs: 0, defaultWidth: 2,
    params: [],
    render: function (host, p, ctx) {
      var C = Cat();
      host.innerHTML = '';
      if (!C) { host.appendChild(H.stateBlock('warn', 'Sound catalogue not loaded')); return; }
      if (!SD.view) SD.view = C.GROUPS[0];
      var card = { host: host, paint: paint, paintTape: paintTape };
      SD.cards[ctx.id] = card;
      listen();

      var wrap = H.el('div', 'sd');
      host.appendChild(wrap);
      var head = H.el('div', 'sd-head');
      var nav = H.el('div', 'sd-nav');
      var body = H.el('div', 'sd-body');
      wrap.appendChild(head);
      wrap.appendChild(nav);
      wrap.appendChild(body);

      function paintHead() {
        head.innerHTML = '';
        var cfg = SD.cfg || {};
        var vol = function (k) { return Math.round(Number(cfg[k] == null ? 1 : cfg[k]) * 100); };
        head.appendChild(H.field('Master %', H.stepper(vol('master_volume'), { min: 0, max: 200, step: 5, width: '4em' }, function (v) { writeGlobal({ master_volume: (Number(v) || 0) / 100 }); })));
        head.appendChild(H.field('Music %', H.stepper(vol('music_volume'), { min: 0, max: 200, step: 5, width: '4em' }, function (v) { writeGlobal({ music_volume: (Number(v) || 0) / 100 }); })));
        head.appendChild(H.field('SFX %', H.stepper(vol('sfx_volume'), { min: 0, max: 200, step: 5, width: '4em' }, function (v) { writeGlobal({ sfx_volume: (Number(v) || 0) / 100 }); })));
        head.appendChild(H.checkbox(!!cfg.muted, 'Mute', function (on) { writeGlobal({ muted: !!on }); }));
        var stop = H.el('a', 'sui-screen-btn sui-mod-secondary sd-stop', 'Stop all');
        stop.href = 'javascript:void(0)';
        stop.addEventListener('click', stopAll);
        head.appendChild(stop);
        var reveal = H.el('a', 'sui-screen-btn sui-mod-secondary sd-reveal', 'Show sound.json');
        reveal.href = 'javascript:void(0)';
        reveal.addEventListener('click', function () { invoke('sound_reveal_config').catch(function (e) { stamp(String(e)); }); });
        head.appendChild(reveal);
      }
      function paintNav() {
        nav.innerHTML = '';
        var items = C.GROUPS.map(function (g) {
          var n = C.MOUNTS.filter(function (m) { return m.group === g && eff(m.id).files.length; }).length;
          return { key: g, label: g + (n ? ' · ' + n : '') };
        });
        items.push({ key: 'Tape', label: 'Tape' + (SD.tape.length ? ' · ' + SD.tape.length : '') });
        nav.appendChild(H.navStrip(items, SD.view, function (key) { SD.view = key; paint(); }));
      }
      function paintTape() {
        if (SD.view !== 'Tape') { paintNav(); return; }
        body.innerHTML = '';
        var tape = H.el('div', 'sd-tape');
        tape.appendChild(H.field('', H.textBox(SD.filter, 'filter cues', function (v) { SD.filter = String(v || '').trim().toLowerCase(); paintTape(); })));
        var rows = SD.tape.filter(function (rec) {
          if (!SD.filter) return true;
          var hay = ((rec.candidates || []).join(' ') + ' ' + (rec.window || '') + ' ' + (rec.reason || '')).toLowerCase();
          return hay.indexOf(SD.filter) >= 0;
        });
        if (!rows.length) tape.appendChild(H.stateBlock('info', SD.cfg && SD.cfg.trace ? 'Waiting for cues' : 'Tracing off'));
        rows.forEach(function (rec) { tape.appendChild(tapeRow(rec, card)); });
        body.appendChild(tape);
        paintNav();
      }
      function paintGroup() {
        body.innerHTML = '';
        var list = H.el('div', 'sd-list');
        C.MOUNTS.filter(function (m) { return m.group === SD.view; }).forEach(function (m) { list.appendChild(row(m, card)); });
        body.appendChild(list);
      }
      function paint() {
        paintHead();
        paintNav();
        if (SD.view === 'Tape') paintTape(); else paintGroup();
      }

      return invoke('sound_config_get').then(function (cfg) {
        SD.cfg = cfg || SD.cfg;
        paint();
        return invoke('sound_trace_set', { enabled: true }).catch(function () { /* a window that may not switch it (the web board) still shows the rows */ });
      }, function (e) {
        host.innerHTML = '';
        host.appendChild(H.stateBlock('warn', 'Sound store unavailable: ' + e));
      });
    },
    unmount: function (host, p, ctx) {
      delete SD.cards[ctx && ctx.id];
      if (!Object.keys(SD.cards).length) invoke('sound_trace_set', { enabled: false }).catch(function () {});
    },
  });
})();
