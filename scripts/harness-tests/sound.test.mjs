// The sound engine (frontend/sound.js), driven with a fake AudioContext and a
// fake bridge. What this pins: resolution order and the catalogue-default
// merge, delay/loop/count/volume semantics on the graph, the decode cache
// keyed by file identity, the trace (always local, over IPC only while the
// designer is tracing), music ownership by the game window, and the three
// ways the engine must stay inert.
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd();
const catalogueSrc = readFileSync(root + '/frontend/sound-catalogue.js', 'utf8');
const soundSrc = readFileSync(root + '/frontend/sound.js', 'utf8');

// ── A fake Web Audio graph that records what the engine does to it ──────────
function fakeAudio() {
  const log = [];
  class Param {
    constructor(v) { this.value = v; }
    setTargetAtTime(v, t, tc) { log.push(['ramp', this.owner, v, t]); this.value = v; }
  }
  class Gain {
    constructor(ctx, tag) { this.gain = new Param(1); this.gain.owner = tag; this.tag = tag; this.out = null; }
    connect(n) { this.out = n; log.push(['connect', this.tag, n && (n.tag || 'dest')]); }
  }
  class Source {
    constructor(ctx) { this.ctx = ctx; this.loop = false; this.buffer = null; this.onended = null; this.tag = 'src'; }
    connect(n) { this.out = n; }
    start(t) { log.push(['start', t, this.loop, this.buffer && this.buffer.name]); this.ctx.sources.push(this); }
    stop(t) { log.push(['stop', t]); }
    end() { if (this.onended) this.onended(); }
  }
  class Ctx {
    constructor() { this.currentTime = 10; this.state = 'suspended'; this.destination = { tag: 'dest' }; this.sources = []; this.gains = 0; this.decoded = 0; Ctx.instances.push(this); }
    createGain() { this.gains++; return new Gain(this, this.gains <= 3 ? ['master', 'music', 'sfx'][this.gains - 1] : 'g' + this.gains); }
    createBufferSource() { return new Source(this); }
    resume() { this.state = 'running'; log.push(['resume']); return Promise.resolve(); }
    decodeAudioData(ab) { this.decoded++; return Promise.resolve({ duration: 2, numberOfChannels: 2, sampleRate: 44100, name: 'buf' + this.decoded, bytes: ab.byteLength }); }
  }
  Ctx.instances = [];
  return { Ctx, log };
}

function fixtureConfig(over) {
  const f = (name) => ({ name, size: 100, mtime_ms: 1, ok: true });
  return Object.assign({
    version: 1, master_volume: 1, music_volume: 0.7, sfx_volume: 1, muted: false, trace: false,
    mounts: {
      'ui.press': { files: [f('click.wav')] },
      'ui.denied': { files: [f('buzz.wav')], enabled: false },
      'fire.tank.primary': { files: [f('rail.mp3')], delay_ms: 250, volume: 0.5 },
      'impact.cannon': { files: [f('a.wav'), f('b.wav'), f('c.wav')], pick: 'sequence' },
      'impact.gatling': { files: [f('x.wav'), f('y.wav')] },
      'focus.ore_extractor.idle': { files: [f('hum.wav')] },
      'focus.ore_extractor.active': { files: [f('drill.wav')], loop: false },
      'destroy.land': { files: [f('boom.wav')], loop: true, loop_count: 3 },
      'music.ambient': { files: [f('theme.mp3')], volume: 0.8 },
      'raid.base_raided.music': { files: [f('war.mp3')] },
      'alert.ore_received': { files: [{ name: 'gone.wav', size: 0, mtime_ms: 0, ok: false, reason: 'missing' }] },
    },
  }, over || {});
}

// ── One engine per scenario ─────────────────────────────────────────────────
function engine(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html' + (opts.palette ? ' data-view="palette"' : '') + '><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' + (opts.page || 'index.html') });
  const w = dom.window;
  if (opts.bridge !== false) w.__TAURI__ = { core: { invoke: () => Promise.reject(new Error('unused')) }, event: { listen: () => Promise.resolve(() => {}) }, embedded: !!opts.embedded };
  w.eval(catalogueSrc);
  w.eval(soundSrc);
  const audio = fakeAudio();
  const calls = [];
  const listeners = {};
  let cfg = opts.cfg === undefined ? fixtureConfig() : opts.cfg;
  const invoke = (cmd, args) => {
    calls.push([cmd, args]);
    if (opts.reject) return Promise.reject(new Error('refused'));
    if (cmd === 'sound_config_get') return Promise.resolve(cfg);
    if (cmd === 'sound_bytes') return Promise.resolve(new ArrayBuffer(16));
    if (cmd === 'sound_trace') return Promise.resolve(null);
    return Promise.reject(new Error('unknown ' + cmd));
  };
  const listen = (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); return Promise.resolve(() => {}); };
  let now = 1000;
  const S = opts.raw ? w.StructsSound : w.StructsSound.__test.install({
    AudioContext: audio.Ctx, invoke, listen, now: () => now, windowName: () => opts.win || 'main',
    embedded: !!opts.embedded, palette: !!opts.palette, hasBridge: opts.bridge !== false,
  });
  return {
    w, S, audio, calls, listeners, setNow: (t) => { now = t; },
    boot: () => S.__test.boot(),
    emit: (name, payload) => (listeners[name] || []).forEach((cb) => cb({ event: name, payload })),
    ctx: () => audio.Ctx.instances[audio.Ctx.instances.length - 1],
    starts: () => audio.log.filter((l) => l[0] === 'start'),
    stops: () => audio.log.filter((l) => l[0] === 'stop'),
    bytesCalls: () => calls.filter((c) => c[0] === 'sound_bytes'),
    endLast: () => { const c = audio.Ctx.instances[0]; c.sources[c.sources.length - 1].end(); },
  };
}

(async () => {
  console.log('\n— inert without a bridge (the jsdom harness, any static page)');
  {
    const e = engine({ bridge: false, raw: true });
    check('the API exists', !!e.S && typeof e.S.cue === 'function');
    check('a cue answers null and nothing throws', e.S.cue(['ui.press']) === null);
    check('music answers null', e.S.music('music.ambient') === null);
    await e.S.test('ui.press').then((r) => check('test reports no runtime', r.ok === false));
    check('the trace still records the miss', e.S.trace.recent().length >= 1 && e.S.trace.recent()[0].reason === 'no-runtime');
  }

  console.log('\n— resolution');
  {
    const e = engine();
    e.boot();
    await tick();
    check('boot asked for the config once and listened for changes', e.calls.filter((c) => c[0] === 'sound_config_get').length === 1 && !!e.listeners['sound-config']);
    const r = e.S.resolve(['fire.tank.primary', 'fire.primary']);
    check('the first mapped id wins', r.id === 'fire.tank.primary');
    check('a mount with no file is skipped for the next', e.S.resolve(['fire.primary', 'ui.press']).id === 'ui.press');
    check('a disabled mount is skipped and named', e.S.resolve(['ui.denied']).reason === 'disabled' && e.S.resolve(['ui.denied', 'ui.press']).id === 'ui.press');
    check('nothing mapped is no-file', e.S.resolve(['fire.primary']).reason === 'no-file');
    check('a file Rust could not vet does not count', e.S.resolve(['alert.ore_received']).reason === 'no-file');
    const idle = e.S.effective('focus.ore_extractor.idle'), active = e.S.effective('focus.ore_extractor.active');
    check('catalogue defaults sit under the config: the idle loop loops, the config can turn the active one off',
      idle.loop === true && active.loop === false);
    check('mount volume/delay come from the config, the rest from defaults', e.S.effective('fire.tank.primary').delay_ms === 250 && e.S.effective('fire.tank.primary').volume === 0.5 && e.S.effective('fire.tank.primary').pick === 'random');
  }

  console.log('\n— the graph: delay, gain, loops, counts');
  {
    const e = engine();
    e.boot();
    await tick();
    const h = e.S.cue(['fire.tank.primary', 'fire.primary'], { struct: 'tank' });
    await tick();
    check('a cue plays: bytes were fetched for the mount and decoded once', e.bytesCalls().length === 1 && e.bytesCalls()[0][1].id === 'fire.tank.primary' && e.ctx().decoded === 1);
    const st = e.starts();
    check('delay_ms 250 starts at now + 0.25', st.length === 1 && Math.abs(st[0][1] - 10.25) < 1e-9, JSON.stringify(st));
    check('the per-play gain is the mount volume', h.gain && h.gain.gain.value === 0.5);
    check('sfx → sfx bus → master → destination', e.audio.log.some((l) => l[0] === 'connect' && l[1] === 'sfx' && l[2] === 'master') && e.audio.log.some((l) => l[0] === 'connect' && l[1] === 'master' && l[2] === 'dest'));
    check('bus gains follow the config', e.S.__test.state().buses.music.gain.value === 0.7 && e.S.__test.state().buses.master.gain.value === 1);
    e.emit('sound-config', fixtureConfig({ muted: true, sfx_volume: 0.4 }));
    check('mute is master 0 with the values kept; sfx follows', e.S.__test.state().buses.master.gain.value === 0 && e.S.__test.state().buses.sfx.gain.value === 0.4);
    e.emit('sound-config', fixtureConfig());

    e.S.cue(['destroy.land']);
    await tick();
    const s2 = e.starts()[1];
    check('loop:true with one file uses src.loop', s2 && s2[2] === true);
    check('loop_count 3 schedules a stop at start + 3 × duration', e.stops().length === 1 && Math.abs(e.stops()[0][1] - (10 + 6)) < 1e-9, JSON.stringify(e.stops()));

    const loopH = e.S.loop(['focus.ore_extractor.idle'], 'focus');
    await tick();
    check('a keyed loop loops forever (no scheduled stop) and dedupes by key', e.starts()[2][2] === true && e.stops().length === 1 && e.S.loop(['focus.ore_extractor.idle'], 'focus') === loopH);
    e.S.stop('focus');
    check('stop by key fades and ends it', loopH.stopped && e.stops().length === 2 && e.audio.log.some((l) => l[0] === 'ramp' && l[2] === 0));

    // The pick is in the trace record (the cache means a repeat fetches nothing).
    const picked = (id) => e.S.trace.recent().filter((r) => r.resolved === id).map((r) => r.index);
    for (let i = 0; i < 4; i++) { e.S.cue(['impact.cannon']); await tick(); }
    check('sequence advances and wraps', picked('impact.cannon').join(',') === '0,1,2,0', picked('impact.cannon').join(','));
    check('…fetching each file once', e.bytesCalls().filter((c) => c[1].id === 'impact.cannon').length === 3);
    for (let i = 0; i < 12; i++) { e.S.cue(['impact.gatling']); await tick(); }
    const rnd = picked('impact.gatling');
    check('random never repeats the previous file', rnd.length === 12 && rnd.every((v, i) => i === 0 || v !== rnd[i - 1]), rnd.join(','));
  }

  console.log('\n— cache');
  {
    const e = engine();
    e.boot();
    await tick();
    e.S.cue(['ui.press']); e.S.cue(['ui.press']);
    await tick();
    check('two cues on one file fetch once', e.bytesCalls().length === 1);
    const c2 = fixtureConfig(); c2.mounts['ui.press'].files[0].mtime_ms = 2;
    e.emit('sound-config', c2);
    e.S.cue(['ui.press']);
    await tick();
    check('a new mtime fetches again', e.bytesCalls().length === 2);
    check('the stale buffer was dropped', e.S.__test.state().buffers.every((k) => k.indexOf('@1@') < 0));
  }

  console.log('\n— trace');
  {
    const e = engine();
    e.boot();
    await tick();
    e.S.cue(['fire.primary']);
    const miss = e.S.trace.recent().slice(-1)[0];
    check('an unmapped cue is a silent record with its candidates', miss.silent === true && miss.reason === 'no-file' && miss.candidates[0] === 'fire.primary' && miss.window === 'main');
    check('nothing went over IPC while tracing is off', e.calls.every((c) => c[0] !== 'sound_trace'));
    e.emit('sound-config', fixtureConfig({ trace: true }));
    e.S.cue(['ui.press']); e.S.cue(['fire.primary']);
    await tick(250);
    const tr = e.calls.filter((c) => c[0] === 'sound_trace');
    check('with tracing on, two cues become one batched sound_trace call', tr.length === 1 && tr[0][1].cues.length === 2, JSON.stringify(tr.map((t) => t[1].cues.length)));
    let seen = 0; const un = e.S.trace.subscribe(() => { seen++; }); e.S.cue(['ui.press']); un(); e.S.cue(['ui.press']);
    check('subscribe/unsubscribe', seen === 1);
  }

  console.log('\n— music');
  {
    const b = engine({ win: 'board' });
    b.boot(); await tick();
    check('a board window refuses music and says so', b.S.music('music.ambient') === null && b.S.trace.recent().slice(-1)[0].reason === 'not-main-window');
    const e = engine();
    e.boot(); await tick();
    const base = e.S.music('music.ambient');
    await tick();
    check('the base layer plays on the music bus at the mount volume', base && base.isMusic && base.gain && e.audio.log.some((l) => l[0] === 'connect' && l[1] === base.gain.tag && l[2] === 'music'));
    check('a second call for the same id is the same handle', e.S.music('music.ambient') === base);
    const over = e.S.music('raid.base_raided.music', { layer: 'override' });
    await tick();
    check('an override ducks the base to 0 and keeps it running', e.audio.log.some((l) => l[0] === 'ramp' && l[1] === base.gain.tag && l[2] === 0) && !base.stopped);
    e.S.music(null, { layer: 'override' });
    check('clearing the override ramps the base back and stops the override', over.stopped && e.audio.log.some((l) => l[0] === 'ramp' && l[1] === base.gain.tag && l[2] === 0.8) && !base.stopped);
    e.S.stopAll({ music: true });
    check('stopAll with music takes the base down too', base.stopped);
  }

  console.log('\n— stop before decode, and the config wait');
  {
    const e = engine();
    e.boot(); await tick();
    const h = e.S.cue(['ui.press']);
    e.S.stop(h);
    await tick();
    check('a cue stopped before its bytes arrive never starts', e.starts().length === 0 && h.stopped);
    const late = engine();
    const early = late.S.cue(['ui.press']);
    check('a cue before the config is held, not dropped', early && !early.stopped);
    late.boot(); await tick();
    check('…and plays when the config lands', late.starts().length === 1);
  }

  console.log('\n— palette and a refusing bridge');
  {
    const p = engine({ palette: true, page: 'board.html' });
    p.boot();
    await tick();
    check('under ?view=palette the engine never invokes or listens', p.calls.length === 0 && Object.keys(p.listeners).length === 0 && p.S.cue(['ui.press']) === null);
    const r = engine({ reject: true, embedded: true, page: 'raidview.html', win: 'raidview' });
    r.boot();
    await tick();
    check('a refused sound_config_get disables the engine for good', r.S.__test.state().disabled === true);
    r.S.cue(['ui.press']);
    await tick();
    check('…later cues are silent with no-runtime and no further invokes', r.S.trace.recent().slice(-1)[0].reason === 'no-runtime' && r.calls.length === 1);
  }

  console.log('\n— the audition');
  {
    const e = engine();
    e.boot(); await tick();
    const r = await e.S.test('destroy.land');
    check('test plays one pass regardless of the mount\'s loop and reports the buffer', r.ok === true && r.duration === 2 && r.channels === 2 && e.starts().slice(-1)[0][2] === false);
    const miss = await e.S.test('alert.ore_received');
    check('test on an unvetted file reports the reason', miss.ok === false && miss.error === 'missing');
    const none = await e.S.test('fire.primary');
    check('test on an unmapped mount reports no file', none.ok === false && none.error === 'no file');
  }

  console.log('\n— presses');
  {
    const e = engine();
    e.boot(); await tick();
    const d = e.w.document;
    d.body.innerHTML = '<a class="sui-screen-btn sui-mod-secondary" id="ok"><i class="sui-icon-add"></i></a><a class="sui-panel-btn sui-mod-disabled" id="no"></a><div class="sui-screen-nav-item" id="nav"></div><p id="text">x</p>';
    d.getElementById('ok').querySelector('i').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    d.getElementById('no').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    d.getElementById('text').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    const recs = e.S.trace.recent();
    check('an icon inside a screen button is the button: its own name, its kind, then the generic press',
      recs.length === 2 && JSON.stringify(recs[0].candidates) === JSON.stringify(['ui.press.ok', 'ui.press.button', 'ui.press']) && recs[0].ctx.kind === 'button', JSON.stringify(recs[0] && recs[0].candidates));
    check('a disabled button is ui.denied, text is nothing', recs[1].candidates[0] === 'ui.denied');
    e.setNow(1010);
    d.getElementById('ok').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('presses are debounced 40 ms', e.S.trace.recent().length === 2);
    e.setNow(2000);
    d.getElementById('nav').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('in the game window a nav item is a TAB press (the router wrap plays the screen)', JSON.stringify(e.S.trace.recent().slice(-1)[0].candidates) === JSON.stringify(['ui.press.nav', 'ui.press.tab', 'ui.press']));
    // Retreat is a planet card's secondary button: named by its label.
    d.body.innerHTML += '<a class="sui-screen-btn sui-mod-secondary" id="rt">Retreat</a><a class="sui-panel-btn sui-mod-default" id="player-action-bar-defend-btn" data-action-button="defend"></a><a id="menu-page-dialogue-btn-a" class="sui-panel-btn sui-mod-default">OK</a><a class="map-tile-selection-tile" role="button" data-struct-id="5-1" id="t1"></a><a class="map-tile-selection-tile" role="button" data-struct-id="" id="t2"></a>';
    e.setNow(3000); d.getElementById('rt').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('Retreat → ui.press.retreat, then the screen-button kind', JSON.stringify(e.S.trace.recent().slice(-1)[0].candidates) === JSON.stringify(['ui.press.retreat', 'ui.press.button', 'ui.press']));
    e.setNow(4000); d.getElementById('player-action-bar-defend-btn').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('an action-bar button is named by its action attribute', JSON.stringify(e.S.trace.recent().slice(-1)[0].candidates) === JSON.stringify(['ui.press.defend', 'ui.press.action', 'ui.press']));
    e.setNow(5000); d.getElementById('menu-page-dialogue-btn-a').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('a dialogue button is the dialogue kind', e.S.trace.recent().slice(-1)[0].candidates.indexOf('ui.press.dialogue') === 1);
    const n0 = e.S.trace.recent().length;
    e.setNow(6000); d.getElementById('t1').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('a map tile with a unit on it is NOT a press (the selection event cues it)', e.S.trace.recent().length === n0);
    e.setNow(7000); d.getElementById('t2').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
    check('an empty map tile is Select Empty Tile', JSON.stringify(e.S.trace.recent().slice(-1)[0].candidates) === JSON.stringify(['ui.select.tile']));
    const b = engine({ win: 'board', page: 'board.html' });
    b.boot(); await tick();
    b.w.document.body.innerHTML = '<div class="sui-screen-nav-item" id="nav"></div>';
    b.w.document.getElementById('nav').dispatchEvent(new b.w.MouseEvent('click', { bubbles: true }));
    check('on the board a nav item is ui.screen.nav', b.S.trace.recent().slice(-1)[0].candidates[0] === 'ui.screen.nav');
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
