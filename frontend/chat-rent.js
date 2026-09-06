// Comms — renting capacity from a provider card. The whole cost is debited
// AT OPEN, in the provider's own denom — often a guild token rather than
// Alpha — so the quote is shown before the commit, and the button says the
// number it is about to spend.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatrent.test.mjs can drive it with a stub `invoke`:
//
//   window.ChatRent({ el, invoke, fmtCount, cardNote })
//     → { rentForm, numberField }
(function () {
  'use strict';
  window.ChatRent = function (ctx) {
    var el = ctx.el, invoke = ctx.invoke, fmtCount = ctx.fmtCount, cardNote = ctx.cardNote;

    // The whole cost is debited AT OPEN, in the provider's own denom — which is
    // often a guild token rather than Alpha. So the quote is shown before the
    // commit, and the button says the number it is about to spend.
    function rentForm(card, box) {
      if (box.querySelector('.chat-rent')) return;      // already open
      var p = card.provider || {};
      var form = el('div', 'chat-rent');

      var cap = numberField('Capacity (W)', p.capacity_min || 0);
      var dur = numberField('Duration (blocks)', p.duration_min || 0);
      form.appendChild(cap.wrap);
      form.appendChild(dur.wrap);

      var quote = el('div', 'chat-rent-quote');
      form.appendChild(quote);

      var go = el('button', 'sui-screen-btn sui-mod-primary', 'Confirm');
      var cancel = el('button', 'sui-screen-btn sui-mod-secondary', 'Cancel');
      var bar = el('div', 'chat-ref-actions');
      bar.appendChild(cancel);
      bar.appendChild(go);
      form.appendChild(bar);

      function cost() {
        var c = Number(cap.input.value) || 0;
        var d = Number(dur.input.value) || 0;
        return (Number(p.rate_amount) || 0) * c * d;
      }
      /* Can this deal be escrowed? The whole cost is debited at open in the
       * provider's rate denom, which is usually a GUILD token — a buyer flush
       * with alpha and holding none of that token is rejected at broadcast
       * with a bare code. So the primary's balance in that denom is read once
       * the form opens, and Confirm stays off while it is short, saying by how
       * much. Unknown (no inventory yet) never blocks: a false refusal is a
       * lie the player cannot argue with. */
      var balance = null;                       // base units of p.rate_denom, or null
      function reprice() {
        var total = cost();
        var short = balance != null && total > balance ? total - balance : 0;
        quote.textContent = total > 0
          ? 'Costs ' + fmtCount(total) + ' ' + (p.denom_label || '') + ' now, in full'
            + (balance == null ? '' : ' · you hold ' + fmtCount(balance))
            + (short ? ' · short ' + fmtCount(short) : '')
          : 'Enter a capacity and duration';
        quote.classList.toggle('chat-rent-short', !!short);
        var can = total > 0 && !short;
        go.disabled = !can;
        go.classList.toggle('sui-mod-disabled', !can);
      }
      cap.input.addEventListener('input', reprice);
      dur.input.addEventListener('input', reprice);
      reprice();
      if (p.rate_denom) {
        invoke('mcp_inventory', { player: 'primary' }).then(function (inv) {
          var rows = (inv && inv.assets) || [];
          for (var i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].denom === p.rate_denom) {
              // `amount_p` is the precise base-unit figure; `amount` is floored for display.
              var v = rows[i].amount_p != null ? Number(rows[i].amount_p) : Number(rows[i].amount);
              if (isFinite(v)) balance = v;
            }
          }
          if (balance == null && rows.length) balance = 0;   // a loaded set that lacks the denom holds none of it
          reprice();
        }).catch(function () { /* unknown stays unknown */ });
      }

      cancel.addEventListener('click', function (ev) {
        ev.stopPropagation();
        form.parentNode.removeChild(form);
      });
      go.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (go.disabled) return;
        go.disabled = true;
        go.textContent = 'Signing…';
        invoke('matrix_agreement_open', {
          providerId: card.id,
          capacity: Math.round(Number(cap.input.value) || 0),
          duration: Math.round(Number(dur.input.value) || 0),
        })
          .then(function (res) {
            form.parentNode.removeChild(form);
            cardNote(box, 'Agreement opened · ' + ((res && res.tx) || ''));
          })
          .catch(function (e) {
            go.disabled = false;
            go.textContent = 'Confirm';
            cardNote(box, String(e), true);
          });
      });
      // Inside the card's own body when the provider is drawn as a card, so
      // the form reads as part of the offer rather than a box under it.
      (box.querySelector('.sui-planet-card-body') || box).appendChild(form);
      cap.input.focus();
    }

    function numberField(label, initial) {
      var wrap = el('div', 'chat-rent-field');
      var lab = el('label', 'sui-input-text');
      var id = 'rent-' + label.replace(/[^a-z]/gi, '').toLowerCase();
      lab.setAttribute('for', id);
      lab.appendChild(el('span', null, label));
      var input = el('input');
      // TEXT, not number: SUI styles `label.sui-input-text input[type=text]`, so
      // a number input falls outside the game's art entirely and renders as a
      // raw browser box. `inputmode` still brings up a numeric keypad, and the
      // spinner arrows are no loss.
      input.type = 'text';
      input.setAttribute('inputmode', 'numeric');
      input.id = id;
      input.value = String(initial || '');
      input.addEventListener('input', function () {
        // Keep it a number without fighting the caret: strip anything that is
        // not a digit, in place.
        var clean = input.value.replace(/[^0-9]/g, '');
        if (clean !== input.value) input.value = clean;
      });
      lab.appendChild(input);
      wrap.appendChild(lab);
      return { wrap: wrap, input: input };
    }

    return { rentForm: rentForm, numberField: numberField };
  };
})();
