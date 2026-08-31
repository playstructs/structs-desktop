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
    assets: [],        // every SENDABLE asset held: ualpha and any uguild.<id>
    denom: null,       // the one being sent
    unit: null,        // the rung the amount box is counting in
    preview: null,     // the server's own answer, or null when not ready
    exact: null,       // a base-unit amount the player picked rather than typed
    timer: null,
    seq: 0,
    busy: false,
  };

  function asset() {
    for (var i = 0; i < S.assets.length; i++) {
      if (S.assets[i].denom === S.denom) return S.assets[i];
    }
    return null;
  }

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

  /* The rungs an asset can be counted in.
   *
   * Alpha has the game's full metric ladder, and it is the one in `units.js`
   * rather than a copy — every other screen prints "9.4Kg" off that ladder and
   * this window must agree with them.
   *
   * A guild token has no ladder: the denom registry publishes exactly two
   * names, the base unit and the display unit (`uguild.0-5` → "μSN" and "SN",
   * whatever that guild called them). Two rungs is the honest answer for it —
   * inventing Kg and mg for somebody else's token would be making up units.
   */
  function rungs(a) {
    if (!a) return [];
    if (a.denom === 'ualpha') {
      return U.SCALES.alpha.map(function (r) { return { label: r[2], mul: r[1] }; });
    }
    var out = [];
    var exp = Number(a.exponent) || 0;
    if (exp > 0 && a.display_name) {
      out.push({ label: a.display_name, mul: Math.pow(10, exp) });
    }
    out.push({ label: a.base_name || a.denom, mul: 1 });
    return out;
  }

  function rungFor(label) {
    var list = rungs(asset());
    for (var i = 0; i < list.length; i++) if (list[i].label === label) return list[i];
    // The display rung is the one a player thinks in — "1 Alpha", not
    // "1000000 μg" — so it is what an unknown selection falls back to.
    return list[0] || { label: '', mul: 1 };
  }

  /* An amount in this asset's own base units.
   *
   * Alpha stays on the shared ladder so a figure copied off any other screen
   * pastes back in, suffix and all. Everything else counts in whichever rung
   * the unit control is showing — that control is why a player no longer has
   * to know how their guild spelled its token.
   */
  function fmtAmount(base) {
    var a = asset();
    var n = Number(base) || 0;
    if (!a || a.denom === 'ualpha') return U.fmtAlpha(n);
    var list = rungs(a);
    var top = list[0];
    // Whole display units when it divides cleanly, base units when it does not
    // — a two-rung token has nowhere else to go.
    if (top.mul > 1 && n >= top.mul) return U.trim2(n / top.mul) + ' ' + top.label;
    return n + ' ' + (list[list.length - 1].label || '');
  }

  function baseUnits(text) {
    var a = asset();
    if (a && a.denom === 'ualpha') {
      // A typed suffix wins over the control: someone who pastes "9.4Kg" means
      // Kg, whatever the box beside it currently says.
      if (/[A-Za-zμ]/.test(String(text))) {
        var n = U.parseAlpha(text);
        return n != null && n > 0 ? n : 0;
      }
    }
    var v = Number(String(text == null ? '' : text).trim().replace(/,/g, ''));
    if (!isFinite(v) || v <= 0) return 0;
    return Math.round(v * rungFor(S.unit).mul);
  }

  /* `.sui-screen-btn` is an anchor, so `disabled` would be ignored — the class
     is what both greys it out and makes it inert. */
  function setReady(on) {
    document.getElementById('tx-send').classList.toggle('tx-disabled', !on);
  }

  /* One party, drawn the way the game draws a player.
   *
   * The roster's `sui-result-row`: portrait, name, id underneath. A payment is
   * between two PEOPLE, and this screen used to say the word "primary" on both
   * lines — naming neither of them, and giving no way to notice you were about
   * to pay the wrong one.
   *
   * `pfpAttrs` is another player's on-chain string, so it goes through the
   * shared composer, which validates every layer index before it reaches a
   * path. No portrait is fine: it draws the game's placeholder.
   */
  function partyCard(role, name, playerId, address, pfpAttrs) {
    var row = el('div', 'sui-result-row');
    var box = el('div', 'sui-result-row-portrait');
    box.appendChild(window.StructsPfp.fillPortrait(
      el('div', 'sui-result-row-portrait-image pfp-frame'), pfpAttrs));
    row.appendChild(box);

    var body = el('div', 'sui-result-row-body');
    var head = el('div', 'sui-result-row-title');
    head.appendChild(el('span', 'sui-text-label', role));
    head.appendChild(document.createTextNode(' ' + (name || playerId || '?')));
    body.appendChild(head);

    var sub = el('div', 'sui-result-row-subtitle sui-text-tiny');
    // Both, because they answer different questions: the id is who, and the
    // address is where the money actually goes.
    sub.textContent = (playerId ? playerId + ' · ' : '') + (address || '');
    sub.classList.add('tx-party-addr');
    body.appendChild(sub);
    row.appendChild(body);
    return row;
  }

  function renderParties() {
    var box = document.getElementById('tx-parties');
    box.textContent = '';
    if (S.me) {
      box.appendChild(partyCard('FROM', S.me.name, S.me.player_id,
        S.me.address, S.me.pfp_attrs));
    }
    if (S.intent) {
      // The recipient's face arrives with the PREVIEW, because only the server
      // resolves an address to one of our players. Until then the card shows
      // what the intent carried, which is already chain-resolved.
      box.appendChild(partyCard('TO', S.intent.name, S.intent.playerId || S.intent.recipientId,
        S.intent.to, S.intent.pfp_attrs));
    }
  }

  function renderAssets() {
    var row = document.getElementById('tx-asset-row');
    var sel = document.getElementById('tx-asset');
    // One asset is not a choice. A player holding only Alpha should not be
    // asked which of one thing to send.
    row.hidden = S.assets.length < 2;
    sel.textContent = '';
    S.assets.forEach(function (a) {
      var o = el('option');
      o.value = a.denom;
      // Both names, because a guild token's cosmetic name is what people call
      // it and the denom is what the chain calls it.
      o.textContent = (a.display_name || a.denom)
        + (a.guild_tag ? ' [' + a.guild_tag + ']' : '')
        + ' — ' + fmtAmountFor(a, a.amount);
      if (a.denom === S.denom) o.selected = true;
      sel.appendChild(o);
    });
  }

  // The same formatter, for an asset that is not the selected one — the picker
  // has to price every row, not just the current one.
  function fmtAmountFor(a, base) {
    var was = S.denom;
    S.denom = a.denom;
    var out = fmtAmount(base);
    S.denom = was;
    return out;
  }

  // The window says what it is sending. It used to say SEND ALPHA whatever was
  // selected, which is a title that stops being true the moment there is a
  // choice.
  function renderTitle() {
    var t = document.getElementById('tx-title');
    var a = asset();
    if (t) t.textContent = 'SEND ' + ((a && (a.display_name || a.denom)) || 'ALPHA').toUpperCase();
  }

  function renderUnits() {
    var sel = document.getElementById('tx-unit');
    var list = rungs(asset());
    sel.textContent = '';
    list.forEach(function (r) {
      var o = el('option');
      o.value = r.label;
      o.textContent = r.label;
      if (r.label === S.unit) o.selected = true;
      sel.appendChild(o);
    });
    var label = document.getElementById('tx-amount-label');
    if (label) label.textContent = 'Amount in ' + (S.unit || '');
  }

  function renderFacts() {
    var box = document.getElementById('tx-facts');
    box.textContent = '';
    if (asset()) {
      // "all" carries the EXACT balance, not the printed one.
      //
      // The ladder rounds to two decimals, so 999μg prints as "1mg" — a player
      // who reads their balance off the screen and types it back can ask for
      // very slightly more than they hold, and the send is refused. Sending
      // everything is the commonest reason to want the number at all, so it is
      // a control rather than an invitation to copy a lossy figure.
      var avail = fact('Available', fmtAmount(asset().amount));
      if (asset().amount > 0) {
        var all = el('a', 'tx-all', 'all');
        all.href = 'javascript:void(0)';
        all.title = 'Send the whole balance';
        all.addEventListener('click', function () {
          S.exact = asset().amount;
          // The box counts in the SELECTED rung, so "all" has to be spelled in
          // that rung too — writing a ladder-formatted string into a box that
          // means "Kg" would read as a wildly different number.
          document.getElementById('tx-amount').value =
            U.trim2(asset().amount / rungFor(S.unit).mul);
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
      from: 'primary', to: S.intent.to, denom: S.denom, amount: amount,
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
      // The server is the one that resolves an address to a player, so its
      // answer is what the card should show — including the face, which the
      // intent could not carry.
      if (p.recipient_pfp || p.recipient_id) {
        S.intent.pfp_attrs = p.recipient_pfp || S.intent.pfp_attrs;
        S.intent.recipientId = p.recipient_id || S.intent.playerId;
        renderParties();
      }
      // Both: the ladder figure is what the player recognises, and the base
      // units are what actually leaves the wallet.
      out('', 'Sending ' + fmtAmount(p.amount) + ' (' + p.amount + ' ' + p.denom + ')');
      // The button says the number it is about to spend.
      document.getElementById('tx-send-label').textContent =
        ' Send ' + fmtAmount(p.amount);
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
      from: 'primary', to: S.preview.to, denom: S.preview.denom, amount: S.preview.amount,
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
      /* Everything the server says is sendable, not just Alpha.
       *
       * `sendable` is decided in Rust against an allow-list — ore is absent
       * because it is not a bank asset at all, and staking states like
       * `ualpha.infused` are absent because they are not balances. This window
       * asks rather than deciding, so the two can never disagree about what
       * may leave a wallet.
       */
      S.assets = ((d && d.assets) || []).filter(function (a) {
        return a.sendable && Number(a.amount) > 0;
      });
      // Alpha first: it is the game's money, and the commonest thing to send.
      S.assets.sort(function (x, y) {
        if (x.denom === 'ualpha') return -1;
        if (y.denom === 'ualpha') return 1;
        return String(x.display_name || x.denom).localeCompare(y.display_name || y.denom);
      });
      if (!asset()) S.denom = S.assets.length ? S.assets[0].denom : null;
      var list = rungs(asset());
      if (!list.some(function (r) { return r.label === S.unit; })) {
        // The DISPLAY rung, not the base one: a player thinks in Alpha and in
        // whatever their guild calls its token, not in millionths of either.
        S.unit = list.length ? list[0].label : null;
      }
      renderParties();
      renderAssets();
      renderUnits();
      renderTitle();
      renderFacts();
    }).catch(function (e) { out('error', 'inventory unavailable: ' + e); });
  }

  function applyIntent(intent) {
    if (!intent || !intent.to) return;
    S.intent = intent;
    S.exact = null;                            // a different recipient, a fresh decision
    document.getElementById('tx-who').textContent =
      'to ' + (intent.name || intent.playerId) + ' · ' + intent.to;
    renderParties();
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
  document.getElementById('tx-asset').addEventListener('change', function (e) {
    S.denom = e.target.value;
    // A different asset is a different amount: its balance, its units and its
    // preview all change, so an amount typed for the old one must not survive.
    S.exact = null;
    document.getElementById('tx-amount').value = '';
    var list = rungs(asset());
    S.unit = list.length ? list[0].label : null;
    renderUnits();
    renderTitle();
    renderFacts();
    schedule();
  });
  document.getElementById('tx-unit').addEventListener('change', function (e) {
    S.unit = e.target.value;
    // The typed figure keeps its digits and changes meaning — that is what
    // picking a unit IS. `exact` is dropped because "all" was a quantity, and
    // the box no longer spells it.
    S.exact = null;
    renderUnits();
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
