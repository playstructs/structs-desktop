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

  var SD = { cards: {}, listening: false, cfg: null, tape: [], view: null, selected: null, filter: '', open: null };
  var KNOBS = [['master_volume', 'Master'], ['music_volume', 'Music'], ['sfx_volume', 'SFX']];

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
  // A typed number: the game's text field under a caption. Commits on Enter or
  // blur, clamped to the setting's range; a non-number goes back to the
  // catalogue default. No −/+ — the designer knows the number they want.
  function numField(value, opts, onCommit) {
    var input = H.el('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = value == null ? '' : String(value);
    input.style.width = opts.width || '6em';
    var last = Number(value);
    function commit() {
      var n = parseFloat(String(input.value).replace(/[^0-9.\-]/g, ''));
      if (!isFinite(n)) n = opts.def;
      if (opts.min != null) n = Math.max(opts.min, n);
      if (opts.max != null) n = Math.min(opts.max, n);
      if (opts.step === 1) n = Math.round(n);
      input.value = String(n);
      if (n !== last) { last = n; onCommit(n); }
    }
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); } });
    return input;
  }
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
  // The selected row's settings: one line of stacked fields, caption over its
  // value, in the order a designer sets them. Typed numbers, two switches, one
  // pick. Files stay on the row line; the row's doors are the audition.
  function settings(m, e) {
    var d = defaultsOf(m.id);
    var box = H.el('div', 'sd-settings');
    box.appendChild(H.field('Delay ms', numField(e.delay_ms, { min: 0, max: 60000, step: 1, def: d.delay_ms, width: '5em' }, function (n) { write(m.id, { delay_ms: n }); })));
    box.appendChild(H.field('Volume %', numField(Math.round(e.volume * 100), { min: 0, max: 200, step: 1, def: Math.round(d.volume * 100), width: '4em' }, function (n) { write(m.id, { volume: n / 100 }); })));
    if (m.kind !== 'music') {
      box.appendChild(H.field('Loop', H.checkbox(!!e.loop, null, function (on) { write(m.id, { loop: !!on }); })));
      box.appendChild(H.field('Loop count', numField(e.loop_count, { min: 0, max: 1000, step: 1, def: d.loop_count, width: '4em' }, function (n) { write(m.id, { loop_count: n }); })));
    }
    box.appendChild(H.field('Pick', H.selectBox(e.pick, [{ value: 'random', label: 'random' }, { value: 'sequence', label: 'in order' }], function (v) { write(m.id, { pick: v }); })));
    box.appendChild(H.field('Enabled', H.checkbox(e.enabled !== false, null, function (on) { write(m.id, { enabled: !!on }); })));
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
    doors: function () {
      return [
        { icon: 'icon-close', title: 'Stop all', onClick: stopAll },
        { icon: 'icon-edit', title: 'Show sound.json', onClick: function () { invoke('sound_reveal_config').catch(function (e) { stamp(String(e)); }); } },
        // The mapping travels as one zip: sound.json plus every file it names.
        { icon: 'icon-link-out', title: 'Export sounds (zip)', onClick: function () {
          invoke('sound_export').then(function (r) { if (r && r.ok) stamp('exported ' + r.files + ' file(s) to ' + r.name); }).catch(function (e) { stamp('export: ' + e); });
        } },
        { icon: 'icon-copy', title: 'Import sounds (zip)', onClick: function () {
          invoke('sound_import').then(function (r) { if (r && r.ok) stamp('imported ' + r.mounts + ' mount(s), ' + r.files + ' file(s)'); }).catch(function (e) { stamp('import: ' + e); });
        } },
      ];
    },
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

      // The header is the game's own status-bar idea: four readouts in the
      // display face. A volume tile opens its stepper in a thin drawer; the
      // SOUND tile is the mute switch itself. Stop all and Show sound.json
      // are doors in the card's title bar (see `doors` below).
      function paintHead() {
        head.innerHTML = '';
        var cfg = SD.cfg || {};
        var vol = function (k) { return Math.round(Number(cfg[k] == null ? 1 : cfg[k]) * 100); };
        var hud = H.el('div', 'sd-hud');
        KNOBS.forEach(function (k) {
          var t = H.el('div', 'fstat sd-tile' + (SD.open === k[0] ? ' is-open' : ''));
          t.setAttribute('data-knob', k[0]);
          t.tabIndex = 0;
          t.appendChild(H.el('div', 'fstat-v', vol(k[0]) + '%'));
          t.appendChild(H.el('div', 'fstat-l', k[1]));
          t.addEventListener('click', function () { SD.open = SD.open === k[0] ? null : k[0]; paintHead(); });
          hud.appendChild(t);
        });
        var snd = H.el('div', 'fstat sd-tile' + (cfg.muted ? ' is-muted' : ''));
        snd.setAttribute('data-knob', 'muted');
        snd.tabIndex = 0;
        snd.appendChild(H.el('div', 'fstat-v', cfg.muted ? 'MUTED' : 'ON'));
        snd.appendChild(H.el('div', 'fstat-l', 'Sound'));
        snd.addEventListener('click', function () { writeGlobal({ muted: !cfg.muted }); });
        hud.appendChild(snd);
        head.appendChild(hud);
        var open = KNOBS.filter(function (k) { return k[0] === SD.open; })[0];
        if (open) {
          var drawer = H.el('div', 'sd-hud-open stk');
          drawer.appendChild(H.field(open[1] + ' %', numField(vol(open[0]), { min: 0, max: 200, step: 1, def: 100, width: '4em' }, function (n) {
            var patch = {}; patch[open[0]] = n / 100; writeGlobal(patch);
          })));
          var done = H.el('a', 'sui-screen-btn sui-mod-secondary sd-done', 'Done');
          done.href = 'javascript:void(0)';
          done.addEventListener('click', function () { SD.open = null; paintHead(); });
          drawer.appendChild(done);
          head.appendChild(drawer);
        }
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
      // Buttons the catalogue does not name still reach the tape under their
      // own name (`ui.press.<name>`); once a designer maps one it is in the
      // config, and the UI group shows it as a row of its own.
      function extraPressMounts() {
        var ids = Object.keys((SD.cfg && SD.cfg.mounts) || {});
        return ids.filter(function (id) { return /^ui\.press\./.test(id) && !C.byId[id]; }).map(function (id) {
          var name = id.slice('ui.press.'.length).replace(/_/g, ' ');
          return { id: id, group: 'UI', label: 'Button · ' + name, when: 'the ' + name + ' button', kind: 'oneshot', optional: false, defaults: defaultsOf(id) };
        });
      }
      function paintGroup() {
        body.innerHTML = '';
        var list = H.el('div', 'sd-list');
        var mounts = C.MOUNTS.filter(function (m) { return m.group === SD.view; });
        if (SD.view === 'UI') mounts = mounts.concat(extraPressMounts());
        mounts.forEach(function (m) { list.appendChild(row(m, card)); });
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
