/* The focused Pay window.
 *
 * One recipient, one asset, one amount, one button. It exists because the
 * hand-off used to land the player in Team Ops — a six-area console — for a
 * one-line payment, which is a poor place to be asked "are you sure".
 *
 * What this window is NOT is a shortcut. `mcp_transfer_execute` re-runs its own
 * preview server-side whatever calls it, and this window is named in that
 * command's allowlist explicitly rather than by widening `require_board`, so it
 * has gained the ability to run ONE command and nothing else.
 *
 * The recipient is never typed and never editable here: it arrives already
 * resolved from the CHAIN by `matrix_open_transfer`, because the request came
 * from a chat message and a message must not be able to name a destination.
 */
(function () {
  'use strict';

  var T = window.__TAURI__;
  var invoke = function (cmd, args) { return T.core.invoke(cmd, args || {}); };

  var S = {
    intent: null,      // { to, playerId, name } — from Rust, chain-resolved
    me: null,          // the paying player
    alpha: null,       // the ualpha asset row: exponent, names, balance
    preview: null,     // the server's own answer, or null when not ready
    timer: null,
    seq: 0,
    busy: false,
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;      // textContent, never innerHTML
    return n;
  }

  function out(kind, text) {
    var box = document.getElementById('tx-out');
    var n = el('div', 'tx-msg' + (kind ? ' tx-' + kind : ''), text);
    box.appendChild(n);
    return n;
  }

  function clearOut() { document.getElementById('tx-out').textContent = ''; }

  function fact(label, value, title) {
    var row = el('div', 'tx-fact');
    row.appendChild(el('span', 'tx-fact-label', label));
    var v = el('span', 'tx-fact-value', value);
    if (title) v.title = title;
    row.appendChild(v);
    return row;
  }

  function scale() { return Math.pow(10, (S.alpha && S.alpha.exponent) || 0); }

  function displayName() {
    if (!S.alpha) return 'Alpha';
    return S.alpha.display_name || 'Alpha';
  }

  /* Base units from what the player typed.
   *
   * Rounded, not truncated: `0.1` in binary floating point is slightly under
   * a tenth, and truncating turned a round number into one base unit less.
   */
  function baseUnits(text) {
    var n = Number(String(text).trim());
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * scale());
  }

  /* `.sui-screen-btn` is an anchor, so `disabled` would be ignored — the class
     is what both greys it out and makes it inert. */
  function setReady(on) {
    document.getElementById('tx-send').classList.toggle('tx-disabled', !on);
  }

  function renderFacts() {
    var box = document.getElementById('tx-facts');
    box.textContent = '';
    if (S.me) {
      box.appendChild(fact('From', (S.me.name || S.me.player_id || '?'), S.me.address));
    }
    if (S.intent) {
      box.appendChild(fact('To', S.intent.name || S.intent.playerId, S.intent.to));
    }
    if (S.alpha) {
      box.appendChild(fact('Available',
        (S.alpha.amount / scale()) + ' ' + displayName()));
    }
  }

  function schedule() {
    S.preview = null;
    setReady(false);
    clearTimeout(S.timer);
    var amount = baseUnits(document.getElementById('tx-amount').value);
    if (!amount || !S.intent) { clearOut(); return; }
    S.timer = setTimeout(function () { runPreview(amount); }, 300);
  }

  function runPreview(amount) {
    var seq = ++S.seq;
    clearOut();
    out('', 'checking…');
    invoke('mcp_transfer_preview', {
      from: 'primary', to: S.intent.to, denom: 'ualpha', amount: amount,
    }).then(function (p) {
      if (seq !== S.seq) return;               // a later keystroke won
      clearOut();
      (p.problems || []).forEach(function (x) { out('error', x); });
      if (!p.ok) return;
      S.preview = p;
      // The SERVER's account of who is being paid, not the one this window was
      // handed. If those ever disagree, the one that decides is the one shown.
      if (p.recipient) out('', 'Recipient: ' + p.recipient);
      else out('warn', 'Recipient: EXTERNAL address — not one of your players');
      out('', 'Sending ' + (p.amount / scale()) + ' ' + displayName()
             + ' (' + p.amount + ' ualpha)');
      // The button says the number it is about to spend.
      document.getElementById('tx-send-label').textContent =
        ' Send ' + (p.amount / scale()) + ' ' + displayName();
      setReady(true);
    }).catch(function (e) {
      if (seq !== S.seq) return;
      clearOut();
      out('error', String(e));
    });
  }

  function send() {
    if (!S.preview || S.busy) return;
    S.busy = true;
    setReady(false);
    clearOut();
    out('', 'signing…');
    invoke('mcp_transfer_execute', {
      from: 'primary', to: S.preview.to, denom: 'ualpha', amount: S.preview.amount,
    }).then(function () {
      S.busy = false;
      clearOut();
      out('', 'Sent.');
      document.getElementById('tx-amount').value = '';
      document.getElementById('tx-send-label').textContent = ' Send';
      loadInventory();                          // the balance just changed
    }).catch(function (e) {
      S.busy = false;
      clearOut();
      out('error', String(e));
      setReady(true);
    });
  }

  function loadInventory() {
    return invoke('mcp_inventory', { player: 'primary' }).then(function (d) {
      S.me = d && d.player;
      S.alpha = ((d && d.assets) || []).filter(function (a) {
        return a.denom === 'ualpha';
      })[0] || null;
      renderFacts();
    }).catch(function (e) { out('error', 'inventory unavailable: ' + e); });
  }

  function applyIntent(intent) {
    if (!intent || !intent.to) return;
    S.intent = intent;
    document.getElementById('tx-who').textContent =
      'to ' + (intent.name || intent.playerId) + ' · ' + intent.to;
    renderFacts();
    schedule();
  }

  function claim() {
    return invoke('matrix_take_pending_transfer').then(applyIntent).catch(function () {});
  }

  document.getElementById('tx-amount').addEventListener('input', schedule);
  document.getElementById('tx-send').addEventListener('click', send);
  document.getElementById('tx-cancel').addEventListener('click', function () {
    T.window.getCurrentWindow().close();
  });

  // A second Pay while this window is already open re-addresses it rather than
  // opening another one. The window is focused by Rust; this repaints it.
  if (T.event) T.event.listen('transfer-intent', function (e) { applyIntent(e.payload); });

  loadInventory().then(claim);
})();
