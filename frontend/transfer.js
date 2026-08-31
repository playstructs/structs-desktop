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
    exact: null,       // a base-unit amount the player picked rather than typed
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

  /* Alpha is shown the GAME's way — "9.4Kg", on the metric ladder every other
   * screen uses — not as a count of some unit this window invented.
   *
   * The first version of this divided by the denom exponent and printed
   * "9400 Alpha". Same quantity, different story: the inventory page beside it
   * says 9.4Kg. `units.js` holds the one ladder both use.
   */
  var U = window.StructsUnits;

  function fmtAlpha(ualpha) { return U.fmtAlpha(Number(ualpha) || 0); }

  /* What the player typed, in ualpha.
   *
   * Accepts the units the ladder prints, so a figure copied off any other
   * screen pastes back in. A bare number means grams, which is what "Alpha"
   * names. Returns null for junk rather than 0, so the form can tell "not
   * typed yet" from "zero" instead of looking ready.
   */
  function baseUnits(text) {
    var n = U.parseAlpha(text);
    return n != null && n > 0 ? n : 0;
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
      // "all" carries the EXACT balance, not the printed one.
      //
      // The ladder rounds to two decimals, so 999μg prints as "1mg" — a player
      // who reads their balance off the screen and types it back can ask for
      // very slightly more than they hold, and the send is refused. Sending
      // everything is the commonest reason to want the number at all, so it is
      // a control rather than an invitation to copy a lossy figure.
      var avail = fact('Available', fmtAlpha(S.alpha.amount));
      if (S.alpha.amount > 0) {
        var all = el('a', 'tx-all', 'all');
        all.href = 'javascript:void(0)';
        all.title = 'Send the whole balance';
        all.addEventListener('click', function () {
          S.exact = S.alpha.amount;
          document.getElementById('tx-amount').value = fmtAlpha(S.alpha.amount);
          schedule();
        });
        avail.querySelector('.tx-fact-value').appendChild(all);
      }
      box.appendChild(avail);
    }
  }

  function schedule() {
    S.preview = null;
    setReady(false);
    clearTimeout(S.timer);
    // An amount the player PICKED beats one read back off the screen: "all"
    // means the balance exactly, and the text beside it is only how that
    // number is spelled. Typing clears it — see the input handler.
    var amount = S.exact != null
      ? S.exact
      : baseUnits(document.getElementById('tx-amount').value);
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
      // Both: the ladder figure is what the player recognises, and the base
      // units are what actually leaves the wallet.
      out('', 'Sending ' + fmtAlpha(p.amount) + ' (' + p.amount + ' ualpha)');
      // The button says the number it is about to spend.
      document.getElementById('tx-send-label').textContent =
        ' Send ' + fmtAlpha(p.amount);
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
      S.exact = null;                          // that balance is now spent
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
    S.exact = null;                            // a different recipient, a fresh decision
    document.getElementById('tx-who').textContent =
      'to ' + (intent.name || intent.playerId) + ' · ' + intent.to;
    renderFacts();
    schedule();
  }

  function claim() {
    return invoke('matrix_take_pending_transfer').then(applyIntent).catch(function () {});
  }

  document.getElementById('tx-amount').addEventListener('input', function () {
    // The moment they type, the number is theirs again rather than the
    // balance's — otherwise editing the box would silently still send "all".
    S.exact = null;
    schedule();
  });
  document.getElementById('tx-send').addEventListener('click', send);
  // Cancel and the screen's own close control do the same thing: this window
  // has one job, so leaving it is leaving it.
  ['tx-cancel', 'tx-close'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.addEventListener('click', function () { T.window.getCurrentWindow().close(); });
  });

  // A second Pay while this window is already open re-addresses it rather than
  // opening another one. The window is focused by Rust; this repaints it.
  if (T.event) T.event.listen('transfer-intent', function (e) { applyIntent(e.payload); });

  loadInventory().then(claim);
})();
