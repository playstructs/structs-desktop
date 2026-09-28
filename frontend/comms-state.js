// StructsComms — the one place a window learns whether Comms is up, as whom,
// and since when.
//
// Rust keeps a per-identity state machine (src-tauri/src/matrix/session.rs)
// and pushes the whole picture as `matrix::state` on every transition; this
// reads it once cold (`matrix_state`) and then applies the pushes. Every
// window that touches Comms — the Comms window, a raid rail, Team Ops' door,
// the game's badge — asks THIS, and never derives "connected" from whether
// some other call happened to succeed. That derivation is how a raid rail
// said "not signed in" for a search that timed out, and how the Comms window
// said "signed in" for a token the issuer had refused sixty hours earlier.
//
// Always defined, even without Tauri (the jsdom harness): the state is then
// simply unknown, and `signedIn()` answers false.
//
// Load after events.js.
(function () {
  'use strict';
  if (window.StructsComms) return;

  var state = { identities: {}, unread: { count: 0, mention: false }, seq: 0 };
  var known = false;
  var subs = [];

  function tauri() { return window.__TAURI__ || null; }

  function notify() {
    subs.slice().forEach(function (cb) {
      try { cb(state); } catch (e) { /* one listener's failure is not another's */ }
    });
  }

  // A snapshot older than the one we hold is a push that arrived late; the
  // sequence only ever grows, so it is dropped rather than applied.
  function adopt(snap) {
    if (!snap || typeof snap !== 'object') return false;
    if (typeof snap.seq === 'number' && snap.seq < state.seq) return false;
    state = {
      identities: snap.identities || {},
      unread: snap.unread || state.unread,
      seq: typeof snap.seq === 'number' ? snap.seq : state.seq,
    };
    known = true;
    notify();
    return true;
  }

  // Nothing is asked of the app until somebody in this window wants the
  // picture: a page that never subscribes (the palette over the game boots
  // without a single call) never reads or listens.
  var started = false;
  function start() {
    if (started) return;
    started = true;
    attach();
    read();
  }

  function refresh() {
    start();
    return read();
  }

  function read() {
    var T = tauri();
    if (!T || !T.core || typeof T.core.invoke !== 'function') return Promise.resolve(state);
    var p;
    try { p = T.core.invoke('matrix_state'); } catch (e) { return Promise.resolve(state); }
    return Promise.resolve(p).then(function (s) { adopt(s); return state; })
      .catch(function () { return state; });
  }

  function identity(key) {
    return (key && state.identities[key]) || null;
  }

  // The player's own identity — the one every window outside Comms speaks as.
  function primary() {
    var keys = Object.keys(state.identities);
    for (var i = 0; i < keys.length; i++) {
      if (!state.identities[keys[i]].as_player) return state.identities[keys[i]];
    }
    return null;
  }

  function phaseOf(id) { return (id && id.phase) || 'idle'; }

  // Usable now: messages can be read and sent. A stall is a wait, not a
  // refusal, so it still counts.
  function signedIn(key) {
    var id = key ? identity(key) : primary();
    var p = phaseOf(id);
    return p === 'live' || p === 'stalled';
  }

  // What the service says this identity may do — 'read', 'send', or
  // 'rooms_on' (a server name). Unknown state answers true for the booleans
  // so a page that boots before the picture lands is not locked out by an
  // absence; the first push settles it.
  function can(what, key) {
    var id = key ? identity(key) : primary();
    var caps = id && id.capabilities;
    if (!caps) return known ? false : true;
    return what === 'rooms_on' ? (caps.rooms_on || null) : !!caps[what];
  }

  // What to say about an identity that is not simply up — one wording for
  // every window, so a rail and the Comms window never disagree about the
  // same fact. Null when there is nothing to say.
  function describe(id) {
    var p = phaseOf(id);
    var reason = (id && id.reason) ? String(id.reason) : '';
    if (p === 'live') return null;
    if (p === 'connecting') {
      return { title: 'Signing in', detail: id && id.step ? id.step + '…' : 'Reaching your guild’s comms server.' };
    }
    if (p === 'stalled') {
      return { title: 'Not receiving messages', detail: 'Trying again. ' + (reason || 'The comms server is not answering.') };
    }
    if (p === 'expired') {
      return { title: 'Signing in again', detail: reason ? 'The last session ended: ' + reason : 'The last session ended.' };
    }
    if (p === 'signed_out') {
      return { title: 'Signed out', detail: 'Open Comms to sign in.' };
    }
    return { title: 'Not connected', detail: 'Comms is not signed in, so nothing here can be read.' };
  }

  window.StructsComms = {
    state: function () { return state; },
    known: function () { return known; },
    identity: identity,
    primary: primary,
    phase: function (key) { return phaseOf(key ? identity(key) : primary()); },
    signedIn: signedIn,
    can: can,
    describe: describe,
    unread: function () { return state.unread; },
    refresh: refresh,
    // Called on every change with the whole state; returns an unsubscribe.
    // Subscribing is what starts the cold read and the listeners.
    onChange: function (cb) {
      start();
      subs.push(cb);
      return function () {
        var i = subs.indexOf(cb);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    // For tests and for a page that gets its state some other way.
    adopt: adopt,
  };

  // The game window defines its StructsEvents inside structs-config.js,
  // which loads AFTER this file; everywhere else events.js precedes it. So
  // the listeners attach when the runtime is there, now or shortly.
  var attached = false;
  var tries = 0;
  function attach() {
    if (attached) return;
    var E = window.StructsEvents;
    if (!E || typeof E.listen !== 'function') {
      if (tries++ < 50) setTimeout(attach, 100);
      return;
    }
    attached = true;
    E.listen('matrix::state', function (e) { adopt(e && e.payload); });
    // The totals also move on their own, between transitions.
    E.listen('matrix::unread', function (e) {
      var p = (e && e.payload) || {};
      state.unread = { count: Number(p.count) || 0, mention: !!p.mention };
      notify();
    });
  }
})();
