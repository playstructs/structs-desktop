// StructsEvents — the one way a window listens for a Rust event.
//
// Wraps `__TAURI__.event.listen` (or the web board's SSE shim, whichever is
// installed) and, half a second after the last registration, tells Rust which
// names this window listens for (`events_listening`). Rust shows that next to
// its own emit counts in `structs_system status` → `events`, so a listener
// that never registers — the board's were silently dead for lack of a
// capability entry, 2026-07 — is a visible finding instead of a mystery.
//
// Always defined, even without Tauri (the jsdom harness), so a window's boot
// never depends on the runtime being there: without it, listen() is a no-op.
(function () {
  if (window.StructsEvents) return;
  var names = [];
  var timer = null;
  function tauri() { return window.__TAURI__ || null; }
  function announce() {
    timer = null;
    var T = tauri();
    if (!T || !T.core || typeof T.core.invoke !== 'function') return;
    try {
      var p = T.core.invoke('events_listening', { names: names.slice() });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* a window without the command (web board) just isn't counted */ }
  }
  window.StructsEvents = {
    listen: function (name, cb) {
      if (names.indexOf(name) < 0) names.push(name);
      if (timer) clearTimeout(timer);
      timer = setTimeout(announce, 500);
      var T = tauri();
      if (!T || !T.event || typeof T.event.listen !== 'function') {
        return Promise.resolve(function unlisten() {});
      }
      return T.event.listen(name, cb);
    },
    names: function () { return names.slice(); },
    // For tests: flush the pending announcement now.
    announceNow: function () { if (timer) clearTimeout(timer); announce(); }
  };
})();
