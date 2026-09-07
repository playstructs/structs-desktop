// The Tauri bridge for an embedded page.
//
// Tauri injects `window.__TAURI__` into a window's TOP frame only. A page
// shown inside a Terminal card is an <iframe> of the board window, so
// chat.js found no bridge, every invoke rejected ("no tauri bridge"), and the
// Comms card drew "No comms server" — its failure page — while the
// standalone Comms window worked. Seen live 2026-09-07.
//
// Rather than borrow the parent's bridge object (whether Tauri's IPC accepts
// a call whose frame is not the main frame is its business, not ours), this
// file gives the page a bridge of the same shape that asks the PARENT to
// invoke and to listen on its behalf, by message. The parent (board-
// terminal.js) answers only same-origin frames and only its own cards.
// Loaded FIRST on chat.html and transfer.html, before events.js.
(function () {
  if (window.__TAURI__) return;
  var p = window.parent;
  if (!p || p === window) return;
  try { void p.document; } catch (e) { return; } // cross-origin parent: nothing to ask
  var mine = String(location.origin || '');
  var target = mine === 'null' || !mine ? '*' : mine;
  var pending = {}, seq = 0, subs = {};
  window.addEventListener('message', function (ev) {
    var same = ev.origin === mine || (mine === 'null' && (ev.origin === 'null' || ev.origin === ''));
    if (!same) return;
    var m = ev.data;
    if (!m || m.structs !== 'bridge') return;
    if (m.kind === 'result') {
      var d = pending[m.id];
      if (!d) return;
      delete pending[m.id];
      if (m.ok) d.resolve(m.value); else d.reject(m.error);
    } else if (m.kind === 'event') {
      (subs[m.name] || []).slice().forEach(function (cb) { try { cb({ event: m.name, payload: m.payload }); } catch (e) { /* one listener must not stop the rest */ } });
    }
  });
  window.__TAURI__ = {
    core: {
      invoke: function (cmd, args) {
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          pending[id] = { resolve: resolve, reject: reject };
          p.postMessage({ structs: 'bridge', kind: 'invoke', id: id, cmd: String(cmd), args: args || {} }, target);
        });
      },
    },
    event: {
      listen: function (name, cb) {
        (subs[name] = subs[name] || []).push(cb);
        p.postMessage({ structs: 'bridge', kind: 'listen', name: String(name) }, target);
        return Promise.resolve(function unlisten() {
          var i = (subs[name] || []).indexOf(cb);
          if (i >= 0) subs[name].splice(i, 1);
        });
      },
    },
    embedded: true,
  };
})();
