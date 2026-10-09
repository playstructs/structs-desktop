/* Battle Simulator — live: two people, one battle, and whoever wants to watch.
 *
 * The HOST's simulator is the chain. Its SimulatorHost runs exactly as it
 * does against the computer, minus the computer: the other fleet is moved by
 * the GUEST, from another machine. Everything the host's Map Viewer is shown
 * (raid-block, raid-delta, raid-attacks, raid-log, raid-snapshot) is batched
 * per block into one `tick` frame and posted to the battle's match room
 * (matrix_sim_live_send); the guest's simulator replays those ticks into its
 * own Map Viewer through a RemoteHost, and turns its own actions into `move`
 * frames. A watcher is a guest without moves. Every move lands in the next
 * block for both sides, like a transaction.
 *
 *   SimLive.HostLink(host, send)        → wraps a running SimulatorHost
 *   SimLive.RemoteHost(opts)            → what a guest's or watcher's board talks to
 *   SimLive.flip(snapshot)              → the same battle from the other side
 *
 * Player ids are the simulator's own: '1-1' is whoever plays the host's
 * fleet, '1-2' the guest's. A guest's RemoteHost answers with them swapped,
 * so to its simulator the guest is '1-1' and the board, standing and debrief
 * read "you" as everywhere else.
 */
(function (root) {
  'use strict';

  var HOST_ID = '1-1', GUEST_ID = '1-2';

  /* ── the host's side ──────────────────────────────────────────────────── */

  /* Struct type records are rebuilt on the other side from its own catalogue,
   * so a tick carries the battle, not the encyclopedia. */
  function lean(name, payload) {
    if (name !== 'raid-snapshot' || !payload || !payload.snapshot) return payload;
    var s = Object.assign({}, payload.snapshot);
    delete s.struct_types;
    return Object.assign({}, payload, { snapshot: s });
  }

  function HostLink(host, send) {
    var buf = [];
    var origEmit = host.emit.bind(host);
    host.emit = function (name, payload) {
      origEmit(name, payload);
      buf.push([name, lean(name, payload)]);
    };
    // A guest's refused move: theirs to see, so it travels and is not drawn here.
    host.onRemoteTx = function (p) { buf.push(['raid-tx', p]); };
    var origBlock = host.block.bind(host);
    host.block = function () { origBlock(); flush(); };
    var origStart = host.start.bind(host), origStop = host.stop.bind(host);
    host.start = function () { origStart(); flush(); };
    host.stop = function () { origStop(); flush(); };
    /* One send in flight. Blocks that pass while it waits — the homeserver
     * rate limits a fast battle — go out together as one tick, so the guest
     * runs a block behind at worst, never further and further behind. Frames
     * queued with after() leave once every tick before them has. */
    var inflight = false, tail = [];
    function tickFrame() {
      var events = buf; buf = [];
      var frame = { v: 1, kind: 'tick', block: host.chain.height, events: events };
      // A tick has to fit one event. The board resynchronises from the next
      // block's snapshot, so snapshots are what give way: the latest first
      // stays, then it goes too.
      if (JSON.stringify(frame).length > 55000) {
        var snaps = events.filter(function (e) { return e[0] === 'raid-snapshot'; });
        var last = snaps[snaps.length - 1];
        frame.events = events.filter(function (e) { return e[0] !== 'raid-snapshot' || e === last; });
        if (JSON.stringify(frame).length > 55000) frame.events = frame.events.filter(function (e) { return e !== last; });
      }
      return frame;
    }
    function flush() {
      if (inflight) return;
      var frame = buf.length ? tickFrame() : tail.shift();
      if (!frame) return;
      var p = send(frame);
      if (p && typeof p.then === 'function') {
        inflight = true;
        p.then(sent, sent);
      } else flush();
    }
    function sent() { inflight = false; flush(); }
    return {
      flush: flush,
      after: function (frame) { tail.push(frame); flush(); },
      /* A guest's move, applied as the guest's own transaction. */
      move: function (frame) {
        try { host.actFor(GUEST_ID, frame.action, frame.args || {}); } catch (e) { buf.push(['raid-tx', { status: 'failed', code: 1, error: String(e.message || e), signer: GUEST_ID }]); }
      },
    };
  }

  /* ── the other side ───────────────────────────────────────────────────── */

  function swapKeys(obj) {
    if (!obj) return obj;
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k === HOST_ID ? GUEST_ID : k === GUEST_ID ? HOST_ID : k] = obj[k]; });
    return out;
  }

  /* The battle drawn from the guest's side: their fleet on the left as the
   * map's `defender`, the host's on the right. */
  function flip(s) {
    if (!s) return s;
    var o = Object.assign({}, s);
    o.structs = (s.structs || []).map(function (x) { return Object.assign({}, x, { side: x.side === 'defender' ? 'attacker' : 'defender' }); });
    o.owner = s.raider_id; o.raider_id = s.owner;
    o.owner_name = s.raider_name; o.raider_name = s.owner_name;
    o.owner_pfp = s.raider_pfp; o.raider_pfp = s.owner_pfp;
    o.owner_charge = s.raider_charge; o.raider_charge = s.owner_charge; o.viewer_charge = s.raider_charge;
    o.owner_last_action = s.raider_last_action; o.raider_last_action = s.owner_last_action; o.viewer_last_action = s.raider_last_action;
    o.owner_overloaded = s.raider_overloaded; o.raider_overloaded = s.owner_overloaded;
    o.owner_label = s.raider_label; o.raider_label = s.owner_label;
    o.owner_fleet = s.raiding_fleet; o.raiding_fleet = s.owner_fleet;
    return o;
  }

  /* opts: { frame, label, role: 'guest'|'watch', initial (a snapshot from the
   *         battle code, before the first tick), types (catalogue by id),
   *         players: {host:{name,pfp}, guest:{name,pfp}}, send(frame),
   *         onChange(), you, them } */
  function RemoteHost(opts) {
    this.opts = opts;
    this.frame = opts.frame;
    this.label = opts.label || 'sim';
    this.role = opts.role;
    this.guest = opts.role === 'guest';
    this.generation = 1;
    this.logRows = [];
    this.running = false;
    this.finished = null;
    this.clockMs = 0;
    this.clockAt = Date.now();
    this.lastTickAt = Date.now();
    this.raw = opts.initial || null;     // the host's-eye snapshot, as last sent
    this.chain = { height: opts.initial ? opts.initial.height : 0 };
    this.startHeight = this.chain.height;
    this.fielded = this.count(true);
    this.endSummary = null;
    this.onMessage = this.onMessage.bind(this);
    root.addEventListener('message', this.onMessage);
  }

  RemoteHost.prototype.destroy = function () { root.removeEventListener('message', this.onMessage); };
  RemoteHost.prototype.post = function (msg) {
    var w = this.frame && this.frame();
    if (!w) return;
    var origin = String(root.location && root.location.origin || '');
    try { w.postMessage(msg, origin && origin !== 'null' ? origin : '*'); } catch (e) { /* frame gone */ }
  };
  RemoteHost.prototype.emit = function (name, payload) {
    this.post({ structs: 'bridge', kind: 'event', name: name + '::' + this.label, payload: payload });
  };
  RemoteHost.prototype.onMessage = function (ev) {
    var m = ev.data;
    if (!m || m.structs !== 'bridge' || m.kind !== 'invoke') return;
    var w = this.frame && this.frame();
    if (!w || ev.source !== w) return;
    var self = this;
    Promise.resolve().then(function () { return self.invoke(m.cmd, m.args || {}); }).then(function (value) {
      self.post({ structs: 'bridge', kind: 'result', id: m.id, ok: true, value: value === undefined ? null : value });
    }, function (e) {
      self.post({ structs: 'bridge', kind: 'result', id: m.id, ok: false, error: String(e && e.message || e) });
    });
  };

  /* The snapshot as this side sees it, struct types filled from our catalogue. */
  RemoteHost.prototype.view = function (s) {
    if (!s) return null;
    var out = this.guest ? flip(s) : Object.assign({}, s);
    var types = {}, cat = this.opts.types || {};
    (out.structs || []).forEach(function (x) { if (cat[x.type_id]) types[x.type_id] = cat[x.type_id]; });
    out.struct_types = types;
    var P = this.opts.players || {};
    if (this.guest) {
      out.owner_label = 'Your fleet';
      out.raider_label = (P.host && P.host.name ? P.host.name + '’s' : 'Their') + ' fleet';
    } else {
      out.owner_label = (P.host && P.host.name ? P.host.name + '’s' : 'Host') + ' fleet';
      out.raider_label = (P.guest && P.guest.name ? P.guest.name + '’s' : 'Guest') + ' fleet';
      out.viewer_charge = null;
    }
    return out;
  };

  RemoteHost.prototype.invoke = function (cmd, args) {
    switch (cmd) {
      case 'events_listening': return null;
      case 'mcp_raid_state': return { generation: this.generation, snapshot: this.view(this.raw), catalog: [] };
      case 'mcp_roster': {
        if (!this.guest || !this.raw) return { rows: [] };
        return { rows: [{ player_id: GUEST_ID, charge: this.raw.raider_charge, load: 0, structs_load: 0, capacity: 1, connection_capacity: 0 }] };
      }
      case 'mcp_raid_log': return { rows: this.logRows.slice().reverse().slice(0, args.limit || 200), players: this.players() };
      case 'mcp_struct_act': {
        if (!this.guest) throw new Error('Error: watching');
        if (args.player !== GUEST_ID) throw new Error('Error: no key for ' + args.player);
        if (!this.running) throw new Error('Error: the battle is ' + (this.finished ? 'over' : 'not running'));
        this.opts.send({ v: 1, kind: 'move', action: args.action, args: args.args || {} });
        return '[You] ' + args.action + ' submitted — tx sent to the next block';
      }
      case 'sound_config_get': case 'sound_bytes': case 'sound_trace': {
        var T = root.__TAURI__;
        if (!T || !T.core) throw new Error('no sound runtime');
        return T.core.invoke(cmd, args);
      }
      default: {
        // The Comms rail, as for the host's board (simulator-host.js).
        var said = this.opts.comms ? this.opts.comms(cmd, args) : undefined;
        if (said !== undefined) return said;
        throw new Error(cmd + ' is not part of the simulator');
      }
    }
  };

  RemoteHost.prototype.players = function () {
    var P = this.opts.players || {}, out = {};
    out[HOST_ID] = { name: P.host && P.host.name || 'Host', pfp: P.host && P.host.pfp || null, tag: null };
    out[GUEST_ID] = { name: P.guest && P.guest.name || 'Guest', pfp: P.guest && P.guest.pfp || null, tag: null };
    return out;
  };

  /* A tick: what the host's board was shown in one block, replayed here. */
  RemoteHost.prototype.tick = function (frame) {
    var self = this;
    this.lastTickAt = Date.now();
    if (typeof frame.block === 'number') this.chain.height = frame.block;
    (frame.events || []).forEach(function (pair) {
      var name = pair[0], payload = pair[1];
      if (name === 'raid-tx') {
        // Only the guest's own refusals, and only to the guest.
        if (!self.guest || !payload || payload.signer !== GUEST_ID) return;
      }
      if (name === 'raid-block' && payload) {
        self.clockMs = payload.clock_ms || 0; self.clockAt = Date.now();
        self.running = !!payload.running;
      }
      if (name === 'raid-snapshot' && payload) {
        self.raw = payload.snapshot;
        payload = Object.assign({}, payload, { snapshot: self.view(payload.snapshot) });
      }
      if (name === 'raid-log' && payload) self.logRows = self.logRows.concat(payload.rows || []).slice(-400);
      self.emit(name, payload);
    });
    if (this.opts.onChange) this.opts.onChange();
  };

  /* The battle's end, as the host called it: who won, and the tallies. */
  RemoteHost.prototype.end = function (frame) {
    var s = frame.summary || {};
    // 'you' is the side this board is drawn from: the guest's own, or for a
    // watcher the host's.
    var mine = this.guest ? 'guest' : 'host';
    var winner = frame.winner === 'draw' ? 'draw' : frame.winner === mine ? 'you' : 'cpu';
    this.finished = { winner: winner, height: this.chain.height, forfeit: !!frame.forfeit, stalemate: frame.stalemate || null, gone: !!frame.gone };
    this.running = false;
    var flipIt = this.guest;
    // Every side has tallies, even if the host sent none for one.
    var blank = function () { return { attacks: 0, damage: 0, evaded: 0, blocked: 0, countered: 0 }; };
    s = Object.assign({}, s);
    s.stats = Object.assign({}, s.stats);
    [HOST_ID, GUEST_ID].forEach(function (k) { if (!s.stats[k]) s.stats[k] = blank(); });
    s.lost = Object.assign({}, s.lost); s.fielded = Object.assign({}, s.fielded);
    [HOST_ID, GUEST_ID].forEach(function (k) { if (s.lost[k] == null) s.lost[k] = 0; if (s.fielded[k] == null) s.fielded[k] = 0; });
    this.endSummary = {
      finished: this.finished, elapsedMs: s.elapsedMs || this.elapsedMs(),
      stats: flipIt ? swapKeys(s.stats) : s.stats, lost: flipIt ? swapKeys(s.lost) : s.lost,
      fielded: flipIt ? swapKeys(s.fielded) : s.fielded, standing: flipIt ? swapKeys(s.standing) : s.standing,
      kills: (s.kills || []).map(function (k) {
        if (!flipIt) return k;
        var sw = function (id) { return id === HOST_ID ? GUEST_ID : id === GUEST_ID ? HOST_ID : id; };
        return Object.assign({}, k, { owner: sw(k.owner), by_owner: sw(k.by_owner) });
      }),
      // Each struct's kills and damage, whose they are in this side's terms:
      // the debrief's Top struct.
      byStruct: (function () {
        var out = {}, by = s.byStruct || {};
        Object.keys(by).forEach(function (id) {
          var b = by[id] || {};
          var owner = !flipIt ? b.owner : b.owner === HOST_ID ? GUEST_ID : b.owner === GUEST_ID ? HOST_ID : b.owner;
          out[id] = Object.assign({}, b, { owner: owner });
        });
        return out;
      })(),
    };
    if (this.opts.onChange) this.opts.onChange();
  };

  /* Structs on each side, from the latest snapshot, in this side's terms. */
  RemoteHost.prototype.count = function (all) {
    var out = {}; out[HOST_ID] = out[GUEST_ID] = 0;
    var self = this;
    ((this.raw && this.raw.structs) || []).forEach(function (s) {
      if (!all && s.destroyed) return;
      var k = self.guest ? (s.owner === HOST_ID ? GUEST_ID : HOST_ID) : s.owner;
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  };
  RemoteHost.prototype.standing = function () { return this.count(false); };
  RemoteHost.prototype.summary = function () { return this.endSummary || { finished: this.finished, elapsedMs: this.elapsedMs(), stats: {}, kills: [], lost: {}, fielded: this.fielded, standing: this.standing() }; };
  RemoteHost.prototype.elapsedMs = function () { return this.clockMs + (this.running ? Date.now() - this.clockAt : 0); };
  /* Time is the host's: these exist so the simulator's controls have
   * something to call, and do nothing a guest could use to stall a battle. */
  RemoteHost.prototype.start = function () {};
  RemoteHost.prototype.stop = function () {};
  RemoteHost.prototype.setBlockMs = function () {};
  RemoteHost.prototype.forfeit = function () {
    if (this.finished) return;
    if (this.guest) this.opts.send({ v: 1, kind: 'leave', forfeit: true });
  };
  /* Blocks since the last tick, against the block time: how far behind. */
  RemoteHost.prototype.lag = function (blockMs) {
    return Math.floor((Date.now() - this.lastTickAt) / (blockMs || 6000));
  };

  root.SimLive = { HostLink: HostLink, RemoteHost: RemoteHost, flip: flip, swapKeys: swapKeys, HOST_ID: HOST_ID, GUEST_ID: GUEST_ID };
})(typeof window !== 'undefined' ? window : globalThis);
