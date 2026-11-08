// INSTALLED CARDS — third-party Terminal cards, sandboxed.
//
// An installed card is one HTML document the player chose to add (it lives
// in Rust: terminal_card_install / _get / _remove). It is drawn in
// <iframe sandbox="allow-scripts" srcdoc=…> WITHOUT allow-same-origin: an
// opaque origin that cannot read this window, reach the Tauri bridge or sign.
// Its only door is postMessage, and this file answers only read-only mirror
// queries (Rust's mirror_card_query keeps the list):
//
//   card → board   { type: 'structs.query', id, query, args }
//   board → card   { type: 'structs.result', id, ok, text | error }
//   board → card   { type: 'structs.hello', sdk, queries }   (on load)
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };
  var QUERIES = ['forecast', 'chronicle', 'lab', 'backtest', 'preview'];

  function btn(label, onClick) {
    var a = H.el('a', 'sui-screen-btn sui-mod-secondary', label);
    a.href = 'javascript:void(0)';
    a.addEventListener('click', function (ev) { ev.preventDefault(); onClick(); });
    return a;
  }

  function note(host, text) {
    var p = H.el('div', 'sui-text-hint', text);
    p.style.textAlign = 'left';
    host.appendChild(p);
  }

  // No card chosen: the installed list, and a way to add one.
  function manage(host, ctx) {
    host.innerHTML = '';
    var list = H.el('div', '');
    list.style.textAlign = 'left';
    host.appendChild(list);
    function paint(names) {
      list.innerHTML = '';
      if (!names.length) note(list, 'No cards installed.');
      names.forEach(function (n) {
        var row = H.el('div', 'sui-result-row');
        row.appendChild(H.el('span', 'sui-text-body', n));
        row.appendChild(btn('Open', function () { T.setParams(ctx.id, { card: n }); }));
        row.appendChild(btn('Remove', function () { invoke('terminal_card_remove', { name: n }).then(paint); }));
        list.appendChild(row);
      });
    }
    invoke('terminal_card_list').then(paint, function () { paint([]); });
    var name = '';
    host.appendChild(H.field('Name', H.textBox('', 'lowercase-name', function (v) { name = String(v || '').trim(); })));
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = '.html,text/html';
    file.className = 'hidden';
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        invoke('terminal_card_install', { name: name || f.name.replace(/\.html?$/i, '').toLowerCase(), html: String(r.result || '') })
          .then(paint, function (e) { note(host, String(e)); });
      };
      r.readAsText(f);
    });
    host.appendChild(file);
    host.appendChild(btn('Install a card file', function () { file.click(); }));
  }

  T.register('external', {
    sdk: 1,
    label: 'Installed card',
    defaultWidth: 2,
    describe: function (p) { return p.card ? String(p.card) : 'Installed cards'; },
    params: [{ key: 'card', label: 'Installed card', kind: 'text', placeholder: 'name' }],
    render: function (host, p, ctx) {
      if (!p.card) { manage(host, ctx); return; }
      return invoke('terminal_card_get', { name: String(p.card) }).then(function (html) {
        host.innerHTML = '';
        var frame = document.createElement('iframe');
        // The whole point: scripts run, but in an opaque origin with no
        // reach into this window, its storage or the Tauri bridge.
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = String(html || '');
        frame.style.width = '100%';
        frame.style.height = '320px';
        frame.style.border = '0';
        host.appendChild(frame);
        function onMessage(ev) {
          if (ev.source !== frame.contentWindow) return;
          var d = ev.data || {};
          if (d.type !== 'structs.query') return;
          var reply = function (body) {
            body.type = 'structs.result';
            body.id = d.id;
            frame.contentWindow && frame.contentWindow.postMessage(body, '*');
          };
          if (QUERIES.indexOf(d.query) < 0) { reply({ ok: false, error: 'not an allowed query' }); return; }
          invoke('mirror_card_query', { query: String(d.query), args: d.args || {} })
            .then(function (text) { reply({ ok: true, text: String(text) }); }, function (e) { reply({ ok: false, error: String(e) }); });
        }
        window.addEventListener('message', onMessage);
        frame.addEventListener('load', function () {
          frame.contentWindow && frame.contentWindow.postMessage({ type: 'structs.hello', sdk: T.SDK_VERSION, queries: QUERIES }, '*');
        });
        host._externalOff = function () { window.removeEventListener('message', onMessage); };
      }, function (e) {
        host.innerHTML = '';
        note(host, 'This card is not installed (' + String(e) + ').');
      });
    },
    unmount: function (host) { if (host._externalOff) host._externalOff(); },
  });
})();
