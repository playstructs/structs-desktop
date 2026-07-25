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

  // The server wraps every event in one `board` SSE envelope carrying its real
  // name, so a single listener covers all of them. There is deliberately no
  // list of event names here: keeping one meant a listener registered for a
  // name nobody had added silently never fired.
  var listeners = {}; // name -> [cb]
  var backoff = 1000;

  function connect() {
    var es = new EventSource('events'); // session cookie rides along
    es.addEventListener('board', function (e) {
      var msg = null;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || !msg.event) return;
      (listeners[msg.event] || []).slice().forEach(function (cb) {
        try { cb({ event: msg.event, payload: msg.payload }); } catch (err) {}
      });
    });
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
