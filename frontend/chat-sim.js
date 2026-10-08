// Comms — simulator challenges in the timeline.
//
// A battle posted to a room (or a sim link pasted into one) draws as a
// challenge ROW that opens to its card — the battle in miniature, who played
// it and how, the talk in its thread, and Play. Rust reads every message's
// `sim` frame (matrix/sim.rs); the card's ladder and thread come from
// `matrix_sim_thread`, asked once per challenge and again when its thread moves.
//
// The timeline stays the conversation. A challenge's thread — results and
// talk — folds into its card, and the room sees ONE line only when a run
// takes first place: "T.Xue beat your best on Spearpoint".
//
// Collaborators arrive as a context, like chat-work.js:
//
//   window.ChatSim({ el, icon, invoke, render, serverIdOf, jumpTo, S, Chat })
//     → { simNode, simLine, folded, hidesBody, onIncoming }
(function () {
  'use strict';
  window.ChatSim = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, serverIdOf = ctx.serverIdOf;
    var S = ctx.S, Chat = ctx.Chat || {};
    function render() { ctx.render(); }
    function jumpTo(id) { if (ctx.jumpTo) ctx.jumpTo(id); }

    if (!S.sim) S.sim = { views: {}, asked: {}, open: {}, menu: null, notes: {} };
    var ST = S.sim;
    // How long a challenge's ladder is trusted before it is asked for again
    // while on screen. New results in its thread ask at once.
    var STALE_MS = 60 * 1000;

    function me() { return (S.profile && S.profile.user_id) || null; }
    function idOf(m) { return serverIdOf(m) || m.event_id || null; }

    function byId(id) {
      var list = S.messages || [];
      for (var i = list.length - 1; i >= 0; i--) if (idOf(list[i]) === id) return list[i];
      return null;
    }
    /* A challenge is a battle said in the room itself, not inside a thread. */
    function isChallengeRoot(id) {
      if (ST.views[id]) return true;
      var m = byId(id);
      return !!(m && m.sim && !m.thread_root);
    }

    /* Whether a message stays out of the main timeline: anything in a
     * challenge's thread, except the run that took first place. A thread
     * whose challenge is not loaded keeps its messages (they still say
     * "In a thread") — folding them into a card nobody can see would lose them. */
    function folded(m) {
      if (!m || !m.thread_root || !isChallengeRoot(m.thread_root)) return false;
      return !(m.sim && m.sim.kind === 'result' && m.sim.top);
    }

    /* The body this app wrote for a battle says nothing the card does not,
     * and neither does a bare pasted link. Anything a person added stays. */
    function hidesBody(m) {
      if (!m || !m.sim) return false;
      if (!m.sim.pasted) return true;
      var body = String(m.body || '').trim();
      return /^\S+$/.test(body);
    }

    function want(id, force) {
      if (!id || !S.roomId) return;
      var at = ST.asked[id];
      if (!force && at && Date.now() - at < STALE_MS) return;
      ST.asked[id] = Date.now();
      invoke('matrix_sim_thread', { guildId: S.guildId, roomId: S.roomId, eventId: id })
        .then(function (v) {
          if (!v) return;
          var held = ST.views[id];
          // Knocked off first place since we last looked: say so on the row.
          if (held && v.me) {
            var was = (held.ladder || [])[0], now = (v.ladder || [])[0];
            if (was && now && was.sender === v.me && now.sender !== v.me) v.beaten = true;
          }
          if (held && held.beaten) v.beaten = true;
          ST.views[id] = v;
          if (S.view === 'room') render();
        })
        .catch(function () { /* the row keeps what the message said */ });
    }

    function viewOf(m, id) {
      return ST.views[id] || {
        frame: m.sim, me: me(), ts: m.ts,
        author: { name: m.sender_name, self: !!m.self, player_id: m.player_id, pfp_attrs: m.pfp_attrs },
      };
    }

    function note(box, text, bad) {
      var old = box.querySelector('.chat-ref-note');
      if (old) old.parentNode.removeChild(old);
      box.appendChild(el('div', 'chat-ref-note' + (bad ? ' chat-mod-error' : ''), text));
    }

    function play(m, id, box) {
      invoke('sim_challenge_open', { guildId: S.guildId, roomId: S.roomId, eventId: id, battle: m.sim.battle })
        .catch(function (e) { note(box, String(e), true); });
    }
    function copyLink(m, box) {
      var clip = typeof navigator !== 'undefined' && navigator.clipboard;
      if (!clip || !clip.writeText) { note(box, 'clipboard unavailable', true); return; }
      clip.writeText(String(m.sim.link)).then(function () { note(box, 'link copied'); }, function (e) { note(box, String(e), true); });
    }

    function menuItems(m, id, box) {
      return [
        { icon: 'icon-copy', title: 'Copy link', run: function () { copyLink(m, box); } },
        { icon: 'icon-link-out', title: 'Open on structs.app', run: function () {
          invoke('matrix_open_url', { url: m.sim.link }).catch(function (e) { note(box, String(e), true); });
        } },
      ];
    }
    function openMenu(box, list, id) {
      var old = box.querySelector('.chat-ref-menu');
      if (old) { old.parentNode.removeChild(old); ST.menu = null; return; }
      ST.menu = id;
      var menu = el('div', 'chat-ref-menu');
      list.forEach(function (it) {
        var a = el('a', 'chat-ref-menu-item');
        a.href = 'javascript:void(0)';
        a.appendChild(icon(it.icon, 'sui-icon-sm'));
        a.appendChild(el('span', 'sui-text-label-block', it.title));
        a.addEventListener('click', function (ev) {
          ev.stopPropagation();
          ST.menu = null;
          if (menu.parentNode) menu.parentNode.removeChild(menu);
          it.run();
        });
        menu.appendChild(a);
      });
      box.insertBefore(menu, box.children[1] || null);
    }

    /* The row or card under a message that carries a battle. */
    function simNode(m) {
      if (!m || !m.sim || !window.StructsSimCard) return null;
      var Card = window.StructsSimCard;
      var id = idOf(m);
      var pending = !!(m.pending || !serverIdOf(m));
      if (!pending) want(id);
      var view = viewOf(m, id);
      var box = el('div', 'chat-ref chat-mod-card chat-kind-challenge');
      var opts = {
        onPlay: pending ? null : function () { play(m, id, box); },
        onMore: function () { openMenu(box, menuItems(m, id, box), id); },
        onOpen: pending ? null : function () { ST.open[id] = 1; render(); },
        onCollapse: function () { ST.open[id] = 0; render(); },
        onCopy: function () { copyLink(m, box); },
        onReplies: function () { play(m, id, box); },
      };
      var node;
      if (m.sim.kind === 'invite') {
        // A live battle: take it, watch it, or see how it went.
        var join = function (role) {
          note(box, role === 'guest' ? 'joining…' : 'opening…');
          invoke('sim_live_join_open', {
            guildId: S.guildId, roomId: S.roomId, eventId: id, matchRoom: m.sim.match, battle: m.sim.battle,
            blockMs: m.sim.block_ms, host: m.sender, role: role,
          }).then(function () { var n = box.querySelector('.chat-ref-note'); if (n) n.parentNode.removeChild(n); })
            .catch(function (e) { note(box, String(e), true); });
        };
        node = Card.inviteRow(view, { onAccept: pending ? null : function () { join('guest'); },
          onWatch: pending ? null : function () { join('watch'); }, onMore: opts.onMore });
      }
      // A shared result says how IT went: its own frame, whoever pasted it.
      else if (m.sim.kind === 'result' && m.sim.pasted && !ST.open[id]) node = Card.resultRow({ frame: m.sim, author: { name: m.sender_name } }, opts);
      else node = ST.open[id] && m.sim.kind === 'challenge' ? Card.card(view, opts) : Card.row(view, opts);
      box.appendChild(node);
      if (!(ST.open[id] && m.sim.kind === 'challenge')) box.classList.add('chat-mod-row');
      if (ST.menu === id) openMenu(box, menuItems(m, id, box), id);
      box.setAttribute('data-sim', id);
      return box;
    }

    /* The one line a challenge's thread puts in the room: a run that took
     * first place. Whoever it knocked off reads it addressed to them. */
    function simLine(m) {
      if (!m || !m.sim || !m.thread_root || !(m.sim.kind === 'result' && m.sim.top)) return null;
      var mine = !!(m.sim.beat && m.sim.beat === me());
      // The room's own event line (who · what · when), so it sits with
      // "joined" and "named the room" rather than looking like a message.
      var line = window.StructsChatRow.render({ kind: 'event', sender_name: m.sender_name || 'Someone', body: ' ', ts: m.ts }, null, {});
      line.classList.add('chl-line');
      if (mine) line.classList.add('chl-mine');
      var what = line.querySelector('.chat-event-what') || line;
      what.textContent = '';
      what.appendChild(icon('icon-success', 'sui-icon-sm'));
      what.appendChild(el('span', null, mine ? ' beat your best on ' : ' set the best on '));
      var a = el('a', 'chl-name');
      a.href = 'javascript:void(0)';
      a.textContent = m.sim.name || 'the battle';
      a.addEventListener('click', function () { ST.open[m.thread_root] = 1; jumpTo(m.thread_root); render(); });
      what.appendChild(a);
      if (m.sim.outcome) what.appendChild(el('span', 'sc-ok', ' ' + m.sim.outcome.time + ' · lost ' + m.sim.outcome.lost));
      return line;
    }

    /* A live battle's host said how it stands: its card asks again. */
    function onLive(p) {
      if (p && p.frame && p.frame.kind === 'status' && p.thread) want(p.thread, true);
    }

    /* New messages in a challenge's thread make its card stale at once. */
    function onIncoming(list) {
      (list || []).forEach(function (m) {
        if (m && m.thread_root && ST.views[m.thread_root]) ST.asked[m.thread_root] = 0;
      });
    }

    Chat.simFolded = folded;
    return { simNode: simNode, simLine: simLine, folded: folded, hidesBody: hidesBody, onIncoming: onIncoming, onLive: onLive };
  };
})();
