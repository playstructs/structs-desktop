// StructsSound — the playback engine. One copy in every window.
//
// A CUE is an ordered list of mount ids (most specific first, built by
// sound-catalogue.js). The first mount a designer has pointed at a file plays,
// with that mount's delay / loop / loop count / volume; when none has a file
// the cue is SILENT — and still recorded, because "what would have played
// here" is the designer's whole question (⌘K → SOUNDS shows the tape).
//
// Web Audio, not <audio>: the app's CSP has no media-src, so a data:, blob:
// or asset: URL is refused, while decodeAudioData takes bytes and asks nobody.
// The bytes come from Rust (`sound_bytes`), which reads only a path already
// in the config — a window never names a file.
//
// Where a sound plays is where its cue fired: the game window plays the
// game's animations, a Map Viewer window plays its own choreography, the
// Terminal plays its clicks. MUSIC is the exception and plays only in the
// game window, so two windows never carry two soundtracks.
//
// Inert by construction where it must be: under `?view=palette` (that frame
// boots with zero invokes, pinned by palette.test.mjs), without a Tauri
// bridge (the jsdom harness), and after the first `sound_config_get`
// rejection (the web board). The API is always there; it just does nothing.
(function () {
  'use strict';
  if (window.StructsSound) return;

  var RING = 200;        // local trace records kept
  var FLUSH_MS = 200;    // trace batching towards Rust
  var CFG_WAIT_MS = 2000; // a cue before the config arrives waits this long
  var DEFAULTS = { delay_ms: 0, loop: false, loop_count: 0, volume: 1, enabled: true, pick: 'random' };
  var PRESS_SELECTOR = 'a.sui-screen-btn, .sui-panel-btn, .sui-screen-nav-item, .pc-act, button, [role=button], ' +
    '#menu-page-dialogue-btn-a, #menu-page-dialogue-btn-b, #notification-dialogue-btn-a, #menu-page-nav-close';

  // ── Runtime (replaceable by the harness) ─────────────────────────────────

  function windowNameOf(loc) {
    var f = (loc.pathname || '').split('/').pop() || 'index.html';
    if (f.indexOf('board') === 0) return 'board';
    if (f.indexOf('raidview') === 0) return 'raidview';
    return 'main';
  }
  function defaultInvoke(cmd, args) {
    var T = window.__TAURI__;
    if (!T || !T.core || typeof T.core.invoke !== 'function') return Promise.reject(new Error('no bridge'));
    return T.core.invoke(cmd, args || {});
  }
  function defaultListen(name, cb) {
    var SE = window.StructsEvents;
    if (SE && typeof SE.listen === 'function') return SE.listen(name, cb);
    var T = window.__TAURI__;
    if (T && T.event && typeof T.event.listen === 'function') return T.event.listen(name, cb);
    return Promise.resolve(function () {});
  }
  var rt = {
    AudioContext: window.AudioContext || window.webkitAudioContext || null,
    invoke: defaultInvoke,
    listen: defaultListen,
    now: function () { return Date.now(); },
    windowName: function () { return windowNameOf(location); },
    embedded: !!(window.__TAURI__ && window.__TAURI__.embedded),
    palette: !!(document.documentElement && document.documentElement.getAttribute('data-view') === 'palette'),
    hasBridge: !!(window.__TAURI__ && window.__TAURI__.core),
  };

  // ── State ────────────────────────────────────────────────────────────────

  var inert, disabled, cfg, cfgWaiters, ctx, buses, buffers, playing, keyed, seq, lastPick, music, ring, subs, traceQ, traceTimer, unlocked;
  function reset() {
    inert = rt.palette || !rt.hasBridge;
    disabled = false;
    cfg = null;
    cfgWaiters = [];
    ctx = null;
    buses = null;
    buffers = {};
    playing = [];
    keyed = {};
    seq = {};
    lastPick = {};
    music = { base: null, override: null };
    ring = [];
    subs = [];
    traceQ = [];
    traceTimer = null;
    unlocked = false;
  }
  reset();

  function musicOk() { return rt.windowName() === 'main' && !rt.embedded; }
  function catalogueDefaults(id) {
    var C = window.StructsSoundCatalogue;
    var m = C && C.byId && C.byId[id];
    return m && m.defaults ? m.defaults : null;
  }

  // ── Resolution (pure over cfg) ───────────────────────────────────────────

  function effective(id) {
    var m = cfg && cfg.mounts && cfg.mounts[id];
    if (!m) return null;
    var d = catalogueDefaults(id) || DEFAULTS;
    var eff = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      eff[k] = (m[k] !== undefined && m[k] !== null) ? m[k] : (d[k] !== undefined ? d[k] : DEFAULTS[k]);
    });
    eff.files = (m.files || []).filter(function (f) { return f && f.ok !== false; });
    eff.allFiles = m.files || [];
    return eff;
  }
  function resolve(candidates) {
    var list = [].concat(candidates || []);
    if (inert || disabled) return { id: null, reason: 'no-runtime', candidates: list };
    if (!cfg) return { id: null, reason: 'config-pending', candidates: list };
    var sawDisabled = false;
    for (var i = 0; i < list.length; i++) {
      var eff = effective(list[i]);
      if (!eff || !eff.files.length) continue;
      if (eff.enabled === false) { sawDisabled = true; continue; }
      return { id: list[i], mount: eff, candidates: list };
    }
    return { id: null, reason: sawDisabled ? 'disabled' : 'no-file', candidates: list };
  }

  function pickIndex(id, eff) {
    var n = eff.files.length;
    if (n <= 1) return 0;
    var i;
    if (eff.pick === 'sequence') {
      i = (seq[id] || 0) % n;
      seq[id] = i + 1;
    } else {
      do { i = Math.floor(Math.random() * n); } while (n > 1 && i === lastPick[id]);
    }
    lastPick[id] = i;
    return i;
  }
  // The index into the mount's FULL file list (Rust reads by that index).
  function realIndex(eff, i) {
    var f = eff.files[i];
    var all = eff.allFiles;
    for (var k = 0; k < all.length; k++) if (all[k] === f) return k;
    return i;
  }

  // ── Trace ────────────────────────────────────────────────────────────────

  function record(rec) {
    rec.ts_ms = rt.now();
    rec.window = rt.windowName();
    ring.push(rec);
    if (ring.length > RING) ring.splice(0, ring.length - RING);
    for (var i = 0; i < subs.length; i++) { try { subs[i](rec); } catch (e) { /* one subscriber must not stop the rest */ } }
    if (cfg && cfg.trace && !inert && !disabled) {
      traceQ.push(rec);
      if (!traceTimer) traceTimer = setTimeout(flushTrace, FLUSH_MS);
    }
  }
  function flushTrace() {
    traceTimer = null;
    if (!traceQ.length) return;
    var batch = traceQ.splice(0, 64);
    var p = rt.invoke('sound_trace', { cues: batch });
    if (p && typeof p.catch === 'function') p.catch(function () {});
    if (traceQ.length) traceTimer = setTimeout(flushTrace, FLUSH_MS);
  }

  // ── Audio graph ──────────────────────────────────────────────────────────

  function applyGains() {
    if (!buses || !cfg) return;
    setGain(buses.master, cfg.muted ? 0 : num(cfg.master_volume, 1));
    setGain(buses.music, num(cfg.music_volume, 0.7));
    setGain(buses.sfx, num(cfg.sfx_volume, 1));
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function setGain(node, v) {
    try { node.gain.value = v; } catch (e) { /* a fake without .gain */ }
  }
  function ensureContext() {
    if (ctx) return ctx;
    if (!rt.AudioContext) return null;
    try { ctx = new rt.AudioContext(); } catch (e) { ctx = null; return null; }
    buses = { master: ctx.createGain(), music: ctx.createGain(), sfx: ctx.createGain() };
    buses.music.connect(buses.master);
    buses.sfx.connect(buses.master);
    buses.master.connect(ctx.destination);
    applyGains();
    unlock();
    return ctx;
  }
  // wry turns the gesture requirement off, but a context can still come up
  // suspended (or WebKit-`interrupted`); the first gesture or focus resumes it.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    function resume() { if (ctx && ctx.state !== 'running' && typeof ctx.resume === 'function') { try { ctx.resume(); } catch (e) { /* not yet */ } } }
    resume();
    ['pointerdown', 'keydown'].forEach(function (ev) { document.addEventListener(ev, resume, true); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') resume(); });
    window.addEventListener('focus', resume);
  }

  // Tag checks rather than instanceof: the bytes may come from another realm
  // (an iframe bridge, the harness), where ArrayBuffer is a different class.
  function tagOf(v) { return Object.prototype.toString.call(v); }
  function toArrayBuffer(bytes) {
    if (tagOf(bytes) === '[object ArrayBuffer]') return bytes;
    if (bytes && tagOf(bytes.buffer) === '[object ArrayBuffer]' && typeof bytes.byteLength === 'number') {
      return bytes.buffer.slice(bytes.byteOffset || 0, (bytes.byteOffset || 0) + bytes.byteLength);
    }
    if (Array.isArray(bytes)) return new Uint8Array(bytes).buffer;
    throw new Error('sound_bytes answered ' + (bytes === null ? 'null' : typeof bytes));
  }
  function decode(ab) {
    return new Promise(function (res, rej) {
      var r;
      try { r = ctx.decodeAudioData(ab, res, rej); } catch (e) { rej(e); return; }
      if (r && typeof r.then === 'function') r.then(res, rej);
    });
  }
  function bufferKey(id, index, file) {
    return id + '#' + index + '@' + (file.name || '') + '@' + (file.mtime_ms || 0) + '@' + (file.size || 0);
  }
  function buffer(id, index, file) {
    var key = bufferKey(id, index, file);
    if (buffers[key]) return buffers[key];
    var p = rt.invoke('sound_bytes', { id: id, index: index }).then(function (bytes) {
      if (!ensureContext()) throw new Error('no AudioContext');
      return decode(toArrayBuffer(bytes));
    });
    p.catch(function () { if (buffers[key] === p) delete buffers[key]; });
    buffers[key] = p;
    return p;
  }
  function pruneBuffers() {
    var keep = {};
    if (cfg && cfg.mounts) {
      Object.keys(cfg.mounts).forEach(function (id) {
        (cfg.mounts[id].files || []).forEach(function (f, i) { keep[bufferKey(id, i, f)] = 1; });
      });
    }
    Object.keys(buffers).forEach(function (k) { if (!keep[k]) delete buffers[k]; });
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  function Handle(list, opts) {
    this.candidates = list;
    this.opts = opts || {};
    this.id = null;
    this.key = this.opts.key || null;
    this.stopped = false;
    this.src = null;
    this.gain = null;
    this.passes = 0;
    this.isMusic = !!this.opts.music;
    this.targetGain = null;
  }
  Handle.prototype.stop = function (o) { stop(this, o); };

  function finish(h) {
    if (h.stopped) return;
    h.stopped = true;
    var i = playing.indexOf(h);
    if (i >= 0) playing.splice(i, 1);
    if (h.key && keyed[h.key] === h) delete keyed[h.key];
    if (typeof h.onend === 'function') { try { h.onend(); } catch (e) { /* caller's problem */ } }
  }

  function startAt(h, t0Wall) {
    var late = Math.max(0, rt.now() - t0Wall);
    var delay = Math.max(0, num(h.mount.delay_ms, 0) - late) / 1000;
    return ctx.currentTime + delay;
  }

  function playOnce(h, index, busName, when) {
    var eff = h.mount;
    var file = eff.files[index];
    var real = realIndex(eff, index);
    buffer(h.id, real, file).then(function (buf) {
      if (h.stopped || !ensureContext()) return;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      var vol = h.targetGain !== null ? h.targetGain : num(eff.volume, 1);
      setGain(g, vol);
      src.connect(g);
      g.connect(buses[busName] || buses.sfx);
      h.src = src;
      h.gain = g;
      var start = Math.max(ctx.currentTime, when);
      if (h.opts.fade && h.gain.gain && typeof h.gain.gain.setTargetAtTime === 'function') {
        try { g.gain.value = 0; g.gain.setTargetAtTime(vol, start, h.opts.fade / 3000); } catch (e) { setGain(g, vol); }
      }
      h.passes += 1;
      var single = eff.files.length === 1 && !h.opts.once;
      if (eff.loop && single) {
        src.loop = true;
        src.start(start);
        if (num(eff.loop_count, 0) > 0) src.stop(start + num(eff.loop_count, 0) * buf.duration);
        src.onended = function () { finish(h); };
      } else {
        src.start(start);
        src.onended = function () {
          if (h.stopped) return;
          var more = eff.loop && !h.opts.once && (num(eff.loop_count, 0) === 0 || h.passes < num(eff.loop_count, 0));
          if (more) playOnce(h, pickIndex(h.id, eff), busName, ctx.currentTime);
          else finish(h);
        };
      }
    }, function (err) {
      record({ candidates: h.candidates, resolved: h.id, index: real, file: file && file.name, silent: true, reason: 'decode-failed', error: String(err && err.message || err), ctx: h.opts });
      finish(h);
    });
  }

  function startCue(h, t0Wall) {
    var r = resolve(h.candidates);
    if (!r.id) {
      record({ candidates: h.candidates, resolved: null, index: null, file: null, silent: true, reason: r.reason, ctx: h.opts });
      finish(h);
      return null;
    }
    h.id = r.id;
    h.mount = r.mount;
    if (h.key) keyed[h.key] = h;
    playing.push(h);
    var index = pickIndex(h.id, h.mount);
    record({ candidates: h.candidates, resolved: h.id, index: realIndex(h.mount, index), file: h.mount.files[index].name, silent: false, reason: cfg.muted ? 'muted' : null, ctx: h.opts });
    if (!ensureContext()) { finish(h); return null; }
    playOnce(h, index, h.opts.bus || (h.isMusic ? 'music' : 'sfx'), startAt(h, t0Wall));
    return h;
  }

  function cue(candidates, opts) {
    opts = opts || {};
    var list = [].concat(candidates || []);
    var t0 = rt.now();
    if (opts.key && keyed[opts.key] && !keyed[opts.key].stopped) return keyed[opts.key];
    var h = new Handle(list, opts);
    if (inert || disabled) {
      record({ candidates: list, resolved: null, index: null, file: null, silent: true, reason: 'no-runtime', ctx: opts });
      h.stopped = true;
      return null;
    }
    if (!cfg) {
      // The config is on its way (or never coming): hold the cue briefly.
      var timer = setTimeout(function () {
        var i = cfgWaiters.indexOf(run);
        if (i >= 0) cfgWaiters.splice(i, 1);
        if (!h.stopped) {
          record({ candidates: list, resolved: null, index: null, file: null, silent: true, reason: disabled ? 'no-runtime' : 'config-pending', ctx: opts });
          finish(h);
        }
      }, CFG_WAIT_MS);
      var run = function () { clearTimeout(timer); if (!h.stopped) startCue(h, t0); };
      cfgWaiters.push(run);
      return h;
    }
    return startCue(h, t0);
  }

  function ramp(h, target, fadeMs) {
    h.targetGain = target;
    if (!h.gain || !ctx) return;
    var g = h.gain.gain;
    if (g && typeof g.setTargetAtTime === 'function') {
      try { g.setTargetAtTime(target, ctx.currentTime, Math.max(0.01, (fadeMs || 0) / 3000)); return; } catch (e) { /* fall through */ }
    }
    setGain(h.gain, target);
  }

  function stop(handleOrKey, o) {
    o = o || {};
    var h = typeof handleOrKey === 'string' ? keyed[handleOrKey] : handleOrKey;
    if (!h || h.stopped) return;
    var fade = num(o.fade, h.isMusic ? 600 : 60) / 1000;
    if (h.src && ctx) {
      try {
        if (h.gain && h.gain.gain && typeof h.gain.gain.setTargetAtTime === 'function') h.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
        h.src.onended = null;
        h.src.stop(ctx.currentTime + fade);
      } catch (e) { /* already stopped */ }
    }
    finish(h);
  }
  function stopAll(o) {
    o = o || {};
    playing.slice().forEach(function (h) { if (o.music || !h.isMusic) stop(h, o); });
    if (o.music) music = { base: null, override: null };
  }

  // ── Music: a base layer and an override that ducks it ────────────────────

  function musicSet(id, o) {
    o = o || {};
    var layer = o.layer === 'override' ? 'override' : 'base';
    var fade = num(o.fade, 600);
    if (!musicOk()) {
      record({ candidates: [].concat(id || []), resolved: null, index: null, file: null, silent: true, reason: 'not-main-window', ctx: { music: layer } });
      return null;
    }
    var cur = music[layer];
    if (id === null || id === undefined) {
      if (cur) { stop(cur, { fade: fade }); music[layer] = null; }
      if (layer === 'override' && music.base && !music.base.stopped) ramp(music.base, num(music.base.mount && music.base.mount.volume, 1), fade);
      return null;
    }
    if (cur && !cur.stopped && cur.id === id) return cur;
    if (cur) { stop(cur, { fade: fade }); music[layer] = null; }
    var h = cue(id, { music: true, bus: 'music', layer: layer, fade: fade });
    if (!h) return null;
    music[layer] = h;
    if (layer === 'override' && music.base && !music.base.stopped) ramp(music.base, 0, fade);
    if (layer === 'base' && music.override && !music.override.stopped) h.targetGain = 0;
    h.onend = function () { if (music[layer] === h) music[layer] = null; };
    return h;
  }

  // ── The designer's audition ──────────────────────────────────────────────

  function test(id, o) {
    o = o || {};
    if (inert || disabled) return Promise.resolve({ ok: false, error: 'no runtime' });
    var go = function () {
      var eff = effective(id);
      if (!eff || !eff.allFiles.length) return Promise.resolve({ ok: false, error: 'no file' });
      var index = Math.min(num(o.index, 0), eff.allFiles.length - 1);
      var file = eff.allFiles[index];
      if (!file || file.ok === false) return Promise.resolve({ ok: false, error: (file && file.reason) || 'missing' });
      if (!ensureContext()) return Promise.resolve({ ok: false, error: 'no AudioContext' });
      var h = new Handle([id], { once: true, test: true, bus: eff.loop && catalogueKind(id) === 'music' ? 'music' : 'sfx' });
      h.id = id;
      h.mount = { delay_ms: 0, loop: false, loop_count: 0, volume: eff.volume, enabled: true, pick: 'sequence', files: [file], allFiles: eff.allFiles };
      playing.push(h);
      return buffer(id, index, file).then(function (buf) {
        if (!h.stopped) playOnce(h, 0, h.opts.bus, ctx.currentTime);
        record({ candidates: [id], resolved: id, index: index, file: file.name, silent: false, reason: null, ctx: { test: true } });
        return { ok: true, duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, handle: h };
      }, function (err) {
        finish(h);
        return { ok: false, error: String(err && err.message || err) };
      });
    };
    return cfg ? go() : reload().then(go);
  }
  function catalogueKind(id) {
    var C = window.StructsSoundCatalogue;
    var m = C && C.byId && C.byId[id];
    return m ? m.kind : 'oneshot';
  }

  // ── Config ───────────────────────────────────────────────────────────────

  function applyConfig(v) {
    cfg = v || null;
    if (!cfg) return;
    applyGains();
    pruneBuffers();
    var waiters = cfgWaiters;
    cfgWaiters = [];
    waiters.forEach(function (run) { try { run(); } catch (e) { /* one cue must not stop the rest */ } });
    if (rt.windowName() !== 'board' && !rt.embedded) preload();
  }
  function preload() {
    var later = window.requestIdleCallback || function (f) { return setTimeout(f, 500); };
    later(function () {
      if (!cfg || !cfg.mounts) return;
      Object.keys(cfg.mounts).forEach(function (id) {
        var eff = effective(id);
        if (!eff || eff.enabled === false) return;
        eff.files.forEach(function (f) { buffer(id, realIndex(eff, eff.files.indexOf(f)), f).catch(function () {}); });
      });
    });
  }
  var cfgPromise = null;
  function reload() {
    if (inert || disabled) return Promise.resolve(null);
    if (cfgPromise) return cfgPromise;
    cfgPromise = rt.invoke('sound_config_get').then(function (v) {
      cfgPromise = null;
      applyConfig(v);
      return cfg;
    }, function () {
      cfgPromise = null;
      disabled = true; // no store here (web board, a refusing parent): stay quiet for good
      var waiters = cfgWaiters;
      cfgWaiters = [];
      waiters.forEach(function (run) { try { run(); } catch (e) { /* silent */ } });
      return null;
    });
    return cfgPromise;
  }

  // ── Presses: one delegate per page (never under the palette) ─────────────

  var lastPress = 0;
  function pressControl(el) {
    var ut = window.__STRUCTS_UI_TELEMETRY__;
    var c = ut && typeof ut.controlFor === 'function' ? ut.controlFor(el) : null;
    if (!c && el && typeof el.closest === 'function') c = el.closest(PRESS_SELECTOR);
    return c;
  }
  function onPress(e) {
    var c = pressControl(e.target);
    if (!c) return;
    var cls = (typeof c.className === 'string') ? c.className : '';
    if (/\bsui-mod-disabled\b|\bsui-mod-disabled-active\b/.test(cls) || c.disabled) { cue(['ui.denied'], { source: 'press' }); return; }
    if (/\bsui-screen-nav-item\b/.test(cls) && rt.windowName() !== 'main') { cue(['ui.screen.nav'], { source: 'nav' }); return; }
    var t = rt.now();
    if (t - lastPress < 40) return;
    lastPress = t;
    cue(['ui.press'], { source: 'press' });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  function boot() {
    if (inert) return;
    rt.listen('sound-config', function (e) { applyConfig(e && e.payload); });
    reload();
    document.addEventListener('click', onPress, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);

  // ── API ──────────────────────────────────────────────────────────────────

  window.StructsSound = {
    cue: cue,
    loop: function (candidates, key) { return cue(candidates, { key: key || (Array.isArray(candidates) ? candidates[0] : String(candidates)) }); },
    stop: stop,
    stopAll: stopAll,
    music: musicSet,
    test: test,
    config: function () { return cfg; },
    reload: reload,
    resolve: resolve,
    effective: effective,
    trace: {
      recent: function () { return ring.slice(); },
      subscribe: function (cb) { subs.push(cb); return function () { var i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
    },
    __test: {
      install: function (o) {
        o = o || {};
        Object.keys(o).forEach(function (k) { rt[k] = o[k]; });
        if (o.hasBridge === undefined) rt.hasBridge = true;
        if (o.palette === undefined) rt.palette = false;
        reset();
        return window.StructsSound;
      },
      boot: boot,
      state: function () { return { inert: inert, disabled: disabled, cfg: cfg, ctx: ctx, buses: buses, buffers: Object.keys(buffers), playing: playing.slice(), keyed: keyed, music: music, traceQ: traceQ.slice() }; },
      flushTrace: flushTrace,
    },
  };
})();
