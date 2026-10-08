/* A direct line between the two players of a live battle.
 *
 * Matrix carries the battle (simulator-social.js), and it always can: every
 * frame has a room to go through. But a homeserver rate limits a send to a
 * few a second and adds its round trip to every block. So once the guest is
 * in the lobby the two simulators shake hands over Matrix — one `rtc` frame
 * each way, the WebRTC offer and answer with every ICE candidate already in
 * them (matrix/sim.rs checks the shape) — and from then on frames go player
 * to player over a data channel. If that never opens, or drops, nothing is
 * lost: send() answers false and the frame takes the room instead.
 *
 * Watchers are not on this line; in a room battle the host keeps telling the
 * room too (simulator-social.js `mustRelay`).
 *
 *   window.SimRTC({ iceServers() → Promise<[RTCIceServer]>, signal(frame),
 *                   onFrame(frame), onState(state) })
 *     → { supported(), start() [host], signal(frame) [an incoming rtc frame],
 *         send(frame) → bool, close(), state() }
 *
 * States: idle → connecting → open, then lost (it dropped) or failed (it
 * never opened); closed when the battle is done.
 */
(function () {
  'use strict';
  // Only when the homeserver runs no TURN service of its own. A STUN server
  // learns the address it is asked from, which is the whole of its job.
  var FALLBACK_ICE = [{ urls: ['stun:stun.l.google.com:19302'] }];
  // How long to wait for candidates before sending what there is.
  var GATHER_MS = 3000;
  // Whatever the peer sends is checked like a Matrix frame: a version, a
  // battle frame's kind, a size. What it MEANS is the receiver's to judge,
  // exactly as for the same frame through the room.
  var MAX_BYTES = 60000;
  var KINDS = ['hello', 'ready', 'start', 'tick', 'move', 'end', 'leave', 'ping'];

  window.SimRTC = function (o) {
    var pc = null, dc = null, closed = false, state = 'idle';
    function supported() { return typeof window.RTCPeerConnection === 'function'; }
    function setState(s) {
      if (state === s || state === 'closed') return;
      state = s;
      if (o.onState) o.onState(s);
    }
    function wire(ch) {
      dc = ch;
      dc.onopen = function () { setState('open'); };
      dc.onclose = function () { if (!closed) setState(state === 'open' ? 'lost' : 'failed'); };
      dc.onmessage = function (ev) {
        if (typeof ev.data !== 'string' || ev.data.length > MAX_BYTES) return;
        var f;
        try { f = JSON.parse(ev.data); } catch (e) { return; }
        if (!f || f.v !== 1 || KINDS.indexOf(f.kind) === -1) return;
        o.onFrame(f);
      };
    }
    function build() {
      return Promise.resolve(o.iceServers ? o.iceServers() : [])
        .catch(function () { return []; })
        .then(function (servers) {
          if (closed) throw new Error('closed');
          pc = new window.RTCPeerConnection({ iceServers: servers && servers.length ? servers : FALLBACK_ICE });
          pc.onconnectionstatechange = function () {
            var s = pc.connectionState;
            if (s === 'failed' || s === 'disconnected' || s === 'closed') setState(state === 'open' ? 'lost' : 'failed');
          };
          pc.ondatachannel = function (ev) { wire(ev.channel); };
          return pc;
        });
    }
    // Every candidate inside the description: one frame each way, not a
    // trickle of them against the homeserver's rate limit.
    function gathered() {
      return new Promise(function (resolve) {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        var t = setTimeout(resolve, GATHER_MS);
        pc.addEventListener('icegatheringstatechange', function () {
          if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
      });
    }
    function describe() {
      if (closed) return;
      var d = pc.localDescription;
      o.signal({ v: 1, kind: 'rtc', desc: { type: d.type, sdp: d.sdp } });
    }
    function fail() { setState('failed'); }

    /* The host offers, once its guest is known. */
    function start() {
      if (!supported() || pc || closed) return;
      setState('connecting');
      build()
        .then(function () {
          wire(pc.createDataChannel('structs.sim', { ordered: true }));
          return pc.createOffer();
        })
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(gathered)
        .then(describe)
        .catch(fail);
    }
    /* The other side's half of the handshake. One connection per battle: a
     * second offer is not a renegotiation, it is ignored. */
    function signal(f) {
      if (!supported() || closed || !f) return;
      if (f.desc && f.desc.type === 'offer') {
        if (pc) return;
        setState('connecting');
        build()
          .then(function () { return pc.setRemoteDescription({ type: 'offer', sdp: f.desc.sdp }); })
          .then(function () { return pc.createAnswer(); })
          .then(function (a) { return pc.setLocalDescription(a); })
          .then(gathered)
          .then(describe)
          .catch(fail);
      } else if (f.desc && f.desc.type === 'answer') {
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        pc.setRemoteDescription({ type: 'answer', sdp: f.desc.sdp }).catch(fail);
      } else if (f.cand && pc) {
        pc.addIceCandidate(f.cand).catch(function () {});
      }
    }
    function send(frame) {
      if (!dc || dc.readyState !== 'open') return false;
      try { dc.send(JSON.stringify(frame)); return true; } catch (e) { return false; }
    }
    function close() {
      if (closed) return;
      closed = true;
      try { if (dc) dc.close(); } catch (e) { /* already gone */ }
      try { if (pc) pc.close(); } catch (e) { /* already gone */ }
      state = 'closed';
      if (o.onState) o.onState('closed');
    }
    return { supported: supported, start: start, signal: signal, send: send, close: close, state: function () { return state; } };
  };
})();
