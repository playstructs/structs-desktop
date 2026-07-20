// Web shim for the Team Ops board — makes board.html runnable in a plain
// browser (served at /board/ by the app's MCP server) by faking the two
// window.__TAURI__ surfaces the board uses:
//   core.invoke(cmd, args)  →  POST invoke/<cmd>   (relative → /board/invoke/…)
//   event.listen(name, cb)  →  one shared EventSource on events (SSE)
// In the NATIVE Team Ops window Tauri injects the real __TAURI__ at
// document-start, so this file is a no-op there.
(function () {
  'use strict';
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return;

  function invoke(cmd, args) {
    return fetch('invoke/' + encodeURIComponent(cmd), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(args || {}),
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        // Mirror Tauri's rejection shape: reject with the error VALUE the
        // board's .catch handlers already stringify.
        if (!res.ok) throw (data && data.error) ? data.error : ('HTTP ' + res.status);
        return data;
      });
    });
  }

  // All events the board listens for; late listeners for other names get
  // wired on the next (re)connect.
  var KNOWN = ['board-update', 'board-feed', 'mcp_ui_directive',
               'board-roster-progress', 'board-roster-updated',
               'board-mass-progress', 'board-mass-done', 'grass-event',
               'grass-lookups'];
  var listeners = {}; // name -> [cb]
  var backoff = 1000;

  function wire(es, name) {
    es.addEventListener(name, function (e) {
      var payload = null;
      try { payload = JSON.parse(e.data); } catch (err) {}
      (listeners[name] || []).slice().forEach(function (cb) {
        try { cb({ event: name, payload: payload }); } catch (err) {}
      });
    });
  }

  function connect() {
    var es = new EventSource('events'); // session cookie rides along
    var names = KNOWN.slice();
    Object.keys(listeners).forEach(function (n) {
      if (names.indexOf(n) < 0) names.push(n);
    });
    names.forEach(function (n) { wire(es, n); });
    es.onopen = function () { backoff = 1000; };
    es.onerror = function () {
      es.close();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  }
  connect();

  function listen(name, cb) {
    (listeners[name] = listeners[name] || []).push(cb);
    return Promise.resolve(function unlisten() {
      var a = listeners[name] || [];
      var i = a.indexOf(cb);
      if (i >= 0) a.splice(i, 1);
    });
  }

  window.__TAURI__ = { core: { invoke: invoke }, event: { listen: listen } };
})();
