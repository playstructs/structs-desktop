// Comms — shared proof-of-work cards.
//
// A task's grinding input is public — object, kind, anchor. Anyone can
// compute it; only its owner can submit the answer. That asymmetry is what
// makes asking a room for help safe. This file draws the offer / result
// cards and drives the three actions (help, check, submit); every network
// step is a Rust command.
//
// Extracted from chat.js (2026-09-05) as the first section to leave it. It
// takes its collaborators as a context rather than reaching into the chat
// closure, so it can be driven by scripts/harness-tests/chatwork.test.mjs
// with nothing but a stub `invoke`.
//
//   window.ChatWork({ el, icon, invoke, serverIdOf, showError, render, S, Chat })
//     → { workCard, acceptWork, verifyWork, checkWorkFresh, workKey }
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

    /* Has the room already seen this cycle SPENT? A `done` frame names the
     * object, the anchor and the transaction, and it arrives after the
     * result it answers, so this is read off the timeline at render time
     * rather than remembered in order. A spent cycle is dead by definition,
     * so a result that has one is neither checked against the chain nor
     * offered for submission — on the bus that is hundreds of cards and
     * hundreds of chain reads that would otherwise happen on opening it. */
    function spentIn(w) {
      var msgs = (S && S.messages) || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        var d = m && m.work;
        if (d && d.kind === 'done' && d.object === w.object && d.task === w.task
            && Number(d.block_start) === Number(w.block_start)) {
          return { by: m.sender_name || m.sender || '', tx: d.tx || '', helper: d.helper || null };
        }
      }
      return null;
    }
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
      var spent = !offer ? spentIn(w) : null;
      if (!spent) checkWorkFresh(w);
      var stale = !spent && workFresh[workKey(w)] === false;
      var card = el('div', 'chat-ref chat-work chat-kind-' + (offer ? 'offer' : 'result')
        + (stale ? ' chat-mod-stale' : ''));

      var head = el('div', 'chat-ref-head');
      head.appendChild(icon(WORK_ICON[w.task] || 'icon-computer', 'sui-icon-md'));
      head.appendChild(el('span', 'chat-ref-title',
        (offer ? 'Work wanted \u00b7 ' : 'Solved \u00b7 ') + (WORK_LABEL[w.task] || w.task)));
      card.appendChild(head);

      var facts = el('div', 'chat-ref-facts');
      var fact = function (k, v) {
        facts.appendChild(el('span', 'chat-ref-key', k));
        facts.appendChild(el('span', 'chat-ref-val', v));
      };
      fact(w.task === 'RAID' ? 'Fleet' : 'Struct', w.object);
      if (w.target) fact('Target', w.target);
      // The anchor is the whole reason a proof goes stale: it is the cycle the
      // nonce is valid against, and the chain checks against its own current
      // one. Showing it is what lets a player see a dead offer as dead.
      fact('Anchor', 'block ' + w.block_start);
      if (w.difficulty) fact('Difficulty', String(w.difficulty));
      if (w.nonce) fact('Nonce', w.nonce);
      card.appendChild(facts);

      // A dead cycle cannot be proved against. Say so where the buttons were,
      // rather than leaving controls that can only fail.
      if (stale) {
        var gone = el('div', 'chat-work-verdict chat-mod-bad');
        gone.textContent = 'That cycle has turned over — this can no longer be proved.';
        card.appendChild(gone);
        return card;
      }

      // Already spent: say by whom, and offer nothing — a second submission
      // of a spent cycle can only be refused.
      if (spent) {
        var was = el('div', 'chat-work-verdict chat-mod-good');
        was.textContent = 'Spent' + (spent.by ? ' by ' + spent.by : '') + (spent.tx ? ' \u2014 tx ' + shortTx(spent.tx) : '');
        card.appendChild(was);
        return card;
      }

      var actions = el('div', 'chat-ref-actions');
      if (offer) {
        var help = el('a', 'sui-panel-btn sui-mod-default chat-ref-action');
        help.href = 'javascript:void(0)';
        help.appendChild(icon('icon-computer', 'sui-icon-sm'));
        help.appendChild(el('span', null, 'Help'));
        help.addEventListener('click', function () { acceptWork(m, w, card); });
        actions.appendChild(help);
      } else {
        var check = el('a', 'sui-panel-btn sui-mod-default chat-ref-action');
        check.href = 'javascript:void(0)';
        check.appendChild(icon('icon-okay', 'sui-icon-sm'));
        check.appendChild(el('span', null, 'Check'));
        check.addEventListener('click', function () { verifyWork(w, card); });
        actions.appendChild(check);
      }
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

    // Verify before anything else. A result arriving over federation is a
    // CLAIM: everything but the number is rebuilt from what this side knows,
    // and the hash is recomputed. A forged one otherwise costs the owner a
    // failed transaction and its charge.
    function verifyWork(w, card) {
      return invoke('matrix_work_verify', {
        objectId: w.object, task: w.task, blockStart: w.block_start,
        difficulty: w.difficulty, nonce: w.nonce, targetId: w.target || null,
      })
        .then(function (res) {
          var line = card.querySelector('.chat-work-verdict');
          if (!line) { line = el('div', 'chat-work-verdict'); card.appendChild(line); }
          if (res && res.ok) {
            line.className = 'chat-work-verdict chat-mod-good';
            line.textContent = 'Checks out. Valid only while block ' + w.block_start
              + ' is still the live cycle.';
            offerSubmit(w, card);
          } else {
            line.className = 'chat-work-verdict chat-mod-bad';
            line.textContent = 'That nonce does not solve this task.';
          }
        })
        .catch(function (e) { showError(String(e)); });
    }
    Chat.verifyWork = verifyWork;

    // Submitting is the owner's act, so it is a separate click from checking
    // — and it only appears once the proof has been checked. A button that
    // both verifies and submits would make the check invisible at exactly the
    // moment it matters.
    //
    // It does NOT cost charge, whatever this used to say. A completion is a
    // PROOF message, not a charge message: `app/ante/maps.go`'s
    // `ChargeMessages` lists the eight that are (activate, attack, build
    // initiate, defense set/clear, move, stealth on/off) and no completion is
    // among them, the miner-complete keeper never calls `Discharge`, and our
    // own `loop_util::CHARGED_TYPES` agrees. What it does spend is a
    // TRANSACTION — one in flight per address at a time — which is the
    // resource actually worth telling somebody they are about to use.
    function offerSubmit(w, card) {
      if (card.querySelector('.chat-work-submit')) return;
      var b = el('a', 'sui-panel-btn sui-mod-default chat-ref-action chat-work-submit');
      b.href = 'javascript:void(0)';
      b.appendChild(icon('icon-send-alpha', 'sui-icon-sm'));
      b.appendChild(el('span', null, 'Submit'));
      b.title = 'Submit this proof yourself — it costs you a transaction, not them';
      b.addEventListener('click', function () {
        var line = card.querySelector('.chat-work-verdict');
        line.className = 'chat-work-verdict';
        line.textContent = 'Submitting\u2026';
        invoke('matrix_work_submit', {
          objectId: w.object, task: w.task, blockStart: w.block_start,
          difficulty: w.difficulty, nonce: w.nonce, targetId: w.target || null,
        })
          .then(function () {
            line.className = 'chat-work-verdict chat-mod-good';
            line.textContent = 'Submitted.';
            b.remove();
          })
          .catch(function (e) {
            line.className = 'chat-work-verdict chat-mod-bad';
            line.textContent = String(e);
          });
      });
      var bar = card.querySelector('.chat-ref-actions');
      if (bar) bar.appendChild(b);
    }


    return {
      workCard: workCard, acceptWork: acceptWork, verifyWork: verifyWork,
      checkWorkFresh: checkWorkFresh, workKey: workKey, WORK_LABEL: WORK_LABEL, WORK_ICON: WORK_ICON,
    };
  };
})();
