// Comms — shared proof-of-work cards.
//
// A task's grinding input is public — object, kind, anchor. Anyone can
// compute it; only its owner can submit the answer. That asymmetry is what
// makes asking a room for help safe. This file draws the offer and done
// cards and drives the one action left in the room (help); every network
// step is a Rust command.
//
// A RESULT draws no card. Its message line already says everything the card
// said (object, task, anchor, nonce), and the owner no longer checks and
// submits a helper's nonce by hand here: a delegated proof is submitted by
// the helper on-chain, and the `done` frame is what the room sees of it.
//
// Extracted from chat.js (2026-09-05) as the first section to leave it. It
// takes its collaborators as a context rather than reaching into the chat
// closure, so it can be driven by scripts/harness-tests/chatwork.test.mjs
// with nothing but a stub `invoke`.
//
//   window.ChatWork({ el, icon, invoke, serverIdOf, showError, render, S, Chat })
//     → { workCard, acceptWork, checkWorkFresh, workKey }
(function () {
  'use strict';
  window.ChatWork = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, serverIdOf = ctx.serverIdOf;
    var showError = ctx.showError, render = ctx.render, S = ctx.S, Chat = ctx.Chat || {};

    var WORK_LABEL = {
      MINE: 'Mining', REFINE: 'Refining', BUILD: 'Building', RAID: 'Raid',
    };
    var WORK_ICON = {
      MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-cmd-post', RAID: 'icon-raid',
    };

    // Whether an offer's cycle is still the one the chain is running, keyed by
    // object and anchor. Cached because a busy room is a column of cards and
    // each check is a chain read — and because the answer cannot change for a
    // given anchor: either the chain still holds it or it never will again.
    var workFresh = {};

    function workKey(w) { return w.object + '|' + w.task + '|' + w.block_start; }

    function shortTx(tx) { return tx ? String(tx).slice(0, 10) + '\u2026' : ''; }

    function checkWorkFresh(w) {
      var key = workKey(w);
      if (Object.prototype.hasOwnProperty.call(workFresh, key)) return;
      workFresh[key] = null;                 // asked; don't ask again
      invoke('matrix_work_status', {
        objectId: w.object, task: w.task, blockStart: w.block_start,
      })
        .then(function (res) {
          // Unknown stays unknown. A card must never be greyed out on a guess:
          // being offline would otherwise make every live offer look dead.
          if (!res || !res.known) return;
          workFresh[key] = !!res.live;
          if (S.view === 'room') render();
        })
        .catch(function () {});
    }

    function workCard(m) {
      var w = m.work;
      if (!w) return null;
      var offer = w.kind === 'offer';
      /* A spend, announced. No actions and no chain read: the transaction
       * IS the outcome, and the card only has to say whose work it was. */
      if (w.kind === 'done') {
        var dcard = el('div', 'chat-ref chat-work chat-kind-done');
        var dhead = el('div', 'chat-ref-head');
        dhead.appendChild(icon(WORK_ICON[w.task] || 'icon-computer', 'sui-icon-md'));
        dhead.appendChild(el('span', 'chat-ref-title', 'Spent \u00b7 ' + (WORK_LABEL[w.task] || w.task)));
        dcard.appendChild(dhead);
        var dfacts = el('div', 'chat-ref-facts');
        var dfact = function (k, v) {
          dfacts.appendChild(el('span', 'chat-ref-key', k));
          dfacts.appendChild(el('span', 'chat-ref-val', v));
        };
        dfact(w.task === 'RAID' ? 'Fleet' : 'Struct', w.object);
        if (w.helper) dfact('Proof by', w.helper);
        if (w.tx) dfact('Tx', shortTx(w.tx));
        dcard.appendChild(dfacts);
        return dcard;
      }
      if (!offer) return null;
      checkWorkFresh(w);
      var stale = workFresh[workKey(w)] === false;
      var card = el('div', 'chat-ref chat-work chat-kind-offer' + (stale ? ' chat-mod-stale' : ''));

      var head = el('div', 'chat-ref-head');
      head.appendChild(icon(WORK_ICON[w.task] || 'icon-computer', 'sui-icon-md'));
      head.appendChild(el('span', 'chat-ref-title', 'Work wanted \u00b7 ' + (WORK_LABEL[w.task] || w.task)));
      card.appendChild(head);

      var facts = el('div', 'chat-ref-facts');
      var fact = function (k, v) {
        facts.appendChild(el('span', 'chat-ref-key', k));
        facts.appendChild(el('span', 'chat-ref-val', v));
      };
      fact(w.task === 'RAID' ? 'Fleet' : 'Struct', w.object);
      if (w.target) fact('Target', w.target);
      // The anchor is the whole reason an offer goes stale: it is the cycle the
      // nonce is valid against, and the chain checks against its own current
      // one. Showing it is what lets a player see a dead offer as dead.
      fact('Anchor', 'block ' + w.block_start);
      if (w.difficulty) fact('Difficulty', String(w.difficulty));
      card.appendChild(facts);

      // A dead cycle cannot be proved against. Say so where the button was,
      // rather than leaving a control that can only fail.
      if (stale) {
        var gone = el('div', 'chat-work-verdict chat-mod-bad');
        gone.textContent = 'That cycle has turned over \u2014 this can no longer be proved.';
        card.appendChild(gone);
        return card;
      }

      var actions = el('div', 'chat-ref-actions');
      var help = el('a', 'sui-panel-btn sui-mod-default chat-ref-action');
      help.href = 'javascript:void(0)';
      help.appendChild(icon('icon-computer', 'sui-icon-sm'));
      help.appendChild(el('span', null, 'Help'));
      help.addEventListener('click', function () { acceptWork(m, w, card); });
      actions.appendChild(help);
      card.appendChild(actions);
      return card;
    }

    // Take on somebody else's task.
    //
    // Nothing here can submit anything: the completion tx names its signer as
    // `creator` and only the owner's is accepted. This spends GPU and posts a
    // number back — that is the whole of it.
    function acceptWork(m, w, card) {
      var line = card.querySelector('.chat-work-verdict');
      if (!line) { line = el('div', 'chat-work-verdict'); card.appendChild(line); }
      line.className = 'chat-work-verdict';
      line.textContent = 'Working on it\u2026';
      return invoke('matrix_work_accept', {
        guildId: S.guildId, roomId: S.roomId, offerEvent: serverIdOf(m),
        objectId: w.object, task: w.task, blockStart: w.block_start,
        difficulty: w.difficulty, targetId: w.target || null,
      })
        .then(function (res) {
          line.className = 'chat-work-verdict chat-mod-good';
          line.textContent = res && res.already
            ? 'Already working on this one.'
            : 'Working on it. The nonce will be posted here when it lands \u2014 '
              + 'only the owner can submit it.';
        })
        .catch(function (e) {
          line.className = 'chat-work-verdict chat-mod-bad';
          line.textContent = String(e);
        });
    }
    Chat.acceptWork = acceptWork;

    return {
      workCard: workCard, acceptWork: acceptWork,
      checkWorkFresh: checkWorkFresh, workKey: workKey, WORK_LABEL: WORK_LABEL, WORK_ICON: WORK_ICON,
    };
  };
})();
