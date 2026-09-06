// Comms — object references: the cards drawn for every `<type>-<index>` id
// a message names.
//
// Every noun in Structs is an id and players already talk in them. Finding
// those in a message and showing a small summary is the single biggest
// thing chat can do for a game whose whole vocabulary is ids. The boundary
// is strict on BOTH sides: `1-194` and `1-1945` are different objects, and
// a loose match attributes one to the other.
//
// Extracted from chat.js (2026-09-05). Collaborators arrive as a context so
// scripts/harness-tests/chatrefs.test.mjs can drive it with a stub `invoke`
// and no window boot:
//
//   window.ChatRefs({ el, icon, invoke, fmtCount, go, pfpPortrait, presenceDot,
//                     render, rentForm, startDm, S, Chat })
//     → { ID_RE, REF_KINDS, refCard, wantRefs, flushRefs, cardNote, cards }
(function () {
  'use strict';
  window.ChatRefs = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, fmtCount = ctx.fmtCount, go = ctx.go;
    var pfpPortrait = ctx.pfpPortrait, presenceDot = ctx.presenceDot, render = ctx.render;
    var rentForm = ctx.rentForm, startDm = ctx.startDm, S = ctx.S, Chat = ctx.Chat || {};

    // Every noun in Structs is a `<type>-<index>` id and players already talk in
    // them. Finding those in a message and showing a small summary is the single
    // biggest thing chat can do for a game whose whole vocabulary is ids.
    //
    // The boundary is strict on BOTH sides: `1-194` and `1-1945` are different
    // objects, and a loose match attributes one to the other.
    var ID_RE = /(^|[^0-9A-Za-z_-])(\d{1,2}-\d{1,9})(?![0-9-])/g;
    // Only types a reader cares about. MIRRORS refs.rs::is_referenceable and
    // must be changed with it — allocations and infusions are plumbing, and a
    // card that says nothing is worse than plain text. A provider (10) earns one
    // because it is an offer you can act on.
    //
    // Exposed so the tests can hold both copies to the same list.
    var REF_KINDS = { 0: 1, 1: 1, 2: 1, 4: 1, 5: 1, 9: 1, 10: 1 };
    Chat.REF_KINDS = REF_KINDS;
    Chat.ID_RE = ID_RE;

    // id → card, or `false` while a lookup is in flight, or null when the chain
    // had nothing. Shared across the whole timeline: a room arguing about one
    // raid names it in every other line.
    var refCards = {};
    var refQueue = [];
    var refTimer = null;
    // Bounded like the Rust cache it mirrors. A long session in busy rooms names
    // a great many objects, and none of this is worth keeping forever.
    var REF_CACHE_MAX = 400;

    function trimRefCache() {
      var keys = Object.keys(refCards);
      if (keys.length <= REF_CACHE_MAX) return;
      // Oldest-first by insertion, which is the order Object.keys gives for
      // string keys that are not array indices. Anything currently open by hand
      // is kept: it is on screen.
      keys.slice(0, keys.length - REF_CACHE_MAX).forEach(function (k) {
        if (!S.openRefs[k]) delete refCards[k];
      });
    }

    function wantRefs(ids) {
      var fresh = ids.filter(function (id) {
        return !Object.prototype.hasOwnProperty.call(refCards, id);
      });
      if (!fresh.length) return;
      fresh.forEach(function (id) { refCards[id] = false; refQueue.push(id); });
      // Batched: one message with six ids should be one round trip, not six.
      if (refTimer) return;
      refTimer = setTimeout(flushRefs, 30);
    }

    function flushRefs() {
      refTimer = null;
      var batch = refQueue.splice(0, 8);
      if (!batch.length) return;
      invoke('matrix_refs', { ids: batch })
        .then(function (res) {
          (res && res.refs || []).forEach(function (card) { refCards[card.id] = card; });
          // Anything the chain did not know stays null so it is never retried
          // in a loop; it simply renders as plain text.
          batch.forEach(function (id) { if (!refCards[id]) refCards[id] = null; });
          trimRefCache();
          if (refQueue.length) refTimer = setTimeout(flushRefs, 30);
          render();
        })
        .catch(function (e) {
          // A lookup that failed leaves plain text. A RENDER that failed is a
          // bug, and one that used to vanish here: the page had been cleared
          // for the repaint, the throw was swallowed, and the room sat blank.
          // Say so, then repaint without the cards that caused it.
          if (e && e.stack) console.error('card render failed', e.stack);
          batch.forEach(function (id) { refCards[id] = null; });
          if (e && e.stack) render();
        });
    }

    /* The card itself. NOT `.sui-data-card`, and deliberately so.
     *
     * This comment used to claim it was built from that component; it never has
     * been, and the claim invited exactly the wrong fix. Rendered side by side at
     * the window's real scale, a `.sui-data-card` in a chat transcript is nearly
     * three times taller and carries a filled header bar that shouts: two of
     * these cards occupy the height of one, and a single message can name several
     * objects at once. It reads as a dashboard panel dropped into a conversation.
     *
     * What this is instead: one surface, a coloured LEFT EDGE that encodes the
     * object type (planet teal, struct amber, player periwinkle — see
     * `.chat-kind-*`), and the same label/value rows. Same information, same type
     * channel, a third of the height, and it reads as an aside — which is what an
     * embed in a conversation should be.
     *
     * `.sui-data-card` IS used in this window, in the connection view, where the
     * context is a full panel and it fits. Right component, right place. */
    // Actions a card carries from Rust, plus the ones only the window can
    // decide. Asking for help is one of those: it depends on being in a room.
    function cardActions(card) {
      var actions = (card.actions || []).slice();
      if (card.kind === 'struct' && card.work_task && S.roomId) {
        actions.push({ key: 'ask_help', label: 'Ask for help', icon: 'icon-computer' });
      }
      return actions;
    }

    /* A PLAYER named in chat is the same card the roster shows.
     *
     * One component (playercard.js) draws every player in the app; the chat
     * embed only supplies what the chain said and what a click should do. The
     * readings Rust sends are label/value pairs; the labels map to the game's
     * own glyphs, and a label with no glyph is shown as a small hint so nothing
     * is dropped on the floor when a new row arrives.
     */
    var READING_ICONS = { Alpha: 'sui-icon-alpha-matter', Energy: 'sui-icon-energy', Ore: 'sui-icon-alpha-ore' };

    function playerRefCard(card) {
      var box = el('div', 'chat-ref chat-kind-player chat-mod-card');
      var tag = /^\[([^\]]+)\]/.exec(card.subtitle || '');
      var acts = cardActions(card).map(function (a) {
        return { icon: a.icon || 'icon-info', title: a.label, key: a.key,
                 onClick: function () { runCardAction(card, a.key, box); } };
      });
      var pc = window.StructsPlayerCard.card({
        id: card.id,
        name: card.title || card.id,
        pfp: card.pfp_attrs,
        sub: tag ? '[' + tag[1] + ']' : null,
        presence: presenceDot(card.id),
        readings: (card.rows || []).map(function (r) {
          return { value: r.value, icon: READING_ICONS[r.label] || null, title: r.label };
        }),
      }, {
        actions: acts,
        // The portrait is the shortest path to "look at this player's world".
        onPortrait: card.planet_id ? function () { runCardAction(card, 'watch_planet', box); } : null,
      });
      box.appendChild(pc);
      return box;
    }

    /* A GUILD named in chat is the shared guild card (guildcard.js), the
     * player card's sibling. Rust sends label/value rows (Owner, Comms); they
     * become readings that say what they are as a hint, since neither has a
     * glyph of its own. */
    function guildRefCard(card) {
      var box = el('div', 'chat-ref chat-kind-guild chat-mod-card');
      var tag = card.tag || (/^\[([^\]]+)\]/.exec(card.subtitle || '') || [])[1] || null;
      var st = card.stats || null;
      // The leaderboard's figures, the same four Best Guilds shows. Nothing
      // else: an owner line and a "Comms: yes" were tried and said less than
      // the numbers do. Until the fast tier has run there are no figures, and
      // the card is the name, the mark and the door.
      var readings = st ? [
        { value: st.members_text, icon: 'sui-icon-players', title: 'Members' },
        { value: st.alpha_text, icon: 'sui-icon-alpha-matter', title: 'Alpha infused' },
        st.capacity_text ? { value: st.capacity_text, icon: 'sui-icon-energy', title: 'Capacity' } : null,
        { value: st.planets_text, icon: 'sui-icon-md icon-planet', title: 'Planets' },
      ] : [];
      var acts = cardActions(card).map(function (a) {
        return { icon: a.icon || 'icon-info', title: a.label,
                 onClick: function () { runCardAction(card, a.key, box); } };
      });
      // This guild's channels, when it is the network you are on.
      if (card.id === S.guildId) {
        acts.push({ icon: 'icon-guild-directory', title: 'Browse channels', onClick: function () { go('browse'); } });
      }
      box.appendChild(window.StructsGuildCard.card({
        id: card.id,
        name: card.title || null,
        tag: tag,
        logo: card.logo || null,
        readings: readings,
      }, { actions: acts }));
      return box;
    }

    /* A PROVIDER named in chat is the shared provider card (providercard.js):
     * price, capacity and duration as readings, the access policy as the
     * badge, the owner as a small player line. Rust sends both the numbers
     * (for the rent form) and the printed readings; an older Rust without the
     * printed ones still gets a card from the numbers it does send. */
    function providerRefCard(card) {
      var box = el('div', 'chat-ref chat-kind-provider chat-mod-card');
      var p = card.provider || {};
      var isAlpha = p.rate_denom === 'ualpha';
      var acts = cardActions(card).map(function (a) {
        return { icon: a.icon || 'icon-info', title: a.label,
                 onClick: function () { runCardAction(card, a.key, box); } };
      });
      if (card.owner && card.owner.id) {
        acts.push({ icon: 'icon-phone', title: 'Message ' + (card.owner.name || card.owner.id),
                    onClick: function () { startDm(card.owner.id); } });
      }
      box.appendChild(window.StructsProviderCard.card({
        id: card.id,
        substation: card.substation_id || null,
        policy: card.policy || (p.open ? 'openMarket' : null),
        rate: p.rate_amount != null ? {
          value: fmtCount(p.rate_amount),
          denomLabel: isAlpha ? null : (p.denom_label || p.rate_denom || null),
          denomIcon: isAlpha ? 'sui-icon-alpha-matter' : null,
        } : null,
        capacity: p.capacity_min != null ? {
          min: p.capacity_min_text || fmtCount(p.capacity_min) + 'W',
          max: p.capacity_max_text || fmtCount(p.capacity_max) + 'W',
        } : null,
        duration: p.duration_min != null ? {
          min: p.duration_min_text || fmtCount(p.duration_min),
          max: p.duration_max_text || fmtCount(p.duration_max),
          blocks: fmtCount(p.duration_min) + ' \u2013 ' + fmtCount(p.duration_max) + ' blocks',
        } : null,
        owner: card.owner && card.owner.id ? {
          id: card.owner.id, name: card.owner.name, tag: card.owner.tag, pfp: card.owner.pfp_attrs,
        } : null,
      }, { actions: acts }));
      return box;
    }

    function refCard(card) {
      if (card.kind === 'provider' && window.StructsProviderCard) return providerRefCard(card);
      if (card.kind === 'guild' && window.StructsGuildCard) return guildRefCard(card);
      if (card.kind === 'player' && card.pfp_attrs && window.StructsPlayerCard) return playerRefCard(card);
      // ONE frame, not three. The card used to nest a bordered header, a
      // bordered body and bordered buttons inside a bordered card — four
      // competing rectangles for one summary. Now: a single surface with a
      // coloured left edge, which is both the "this is an embed" signal and the
      // type at a glance, the way a quote or attachment reads everywhere else.
      var box = el('div', 'chat-ref chat-kind-' + (card.kind || 'thing'));

      var head = el('div', 'chat-ref-head');
      // The portrait uses the ROSTER's frame at its natural 44px — it is a
      // fixed-size crop of fixed-size art and cannot be squeezed.
      if (card.pfp_attrs) {
        var portrait = el('div', 'sui-result-row-portrait chat-ref-portrait');
        portrait.appendChild(pfpPortrait(card.pfp_attrs));
        head.appendChild(portrait);
      } else {
        var well = el('div', 'chat-ref-glyph');
        well.appendChild(icon(card.icon || 'icon-info', 'sui-icon-md'));
        head.appendChild(well);
      }
      var names = el('div', 'chat-ref-names');
      names.appendChild(el('div', 'chat-ref-title', card.title || card.id));
      if (card.subtitle) names.appendChild(el('div', 'chat-ref-sub', card.subtitle));
      head.appendChild(names);
      box.appendChild(head);

      // Facts as a two-column grid rather than a bordered table: the label and
      // the value line up down the card without a box around them.
      var body = el('div', 'chat-ref-facts');
      (card.rows || []).forEach(function (r) {
        body.appendChild(el('div', 'chat-ref-label', r.label));
        body.appendChild(el('div', 'chat-ref-value', r.value));
      });
      box.appendChild(body);

      // ── Actions ──
      // What makes a card more than a lookup. Watch the planet someone named,
      // message its owner, rent the capacity a provider advertised — without
      // leaving the conversation that mentioned it.
      var acts = cardActions(card);
      if (acts.length) {
        var bar = el('div', 'chat-ref-actions');
        acts.forEach(function (a) {
          // Affordances, not content: small, quiet, and on one line. Full-size
          // buttons wrapped onto two rows and dominated the summary they belong
          // to.
          var b = el('button', 'chat-ref-action');
          b.appendChild(icon(a.icon || 'icon-info', 'sui-icon-md'));
          b.appendChild(el('span', null, a.label));
          b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            runCardAction(card, a.key, box);
          });
          bar.appendChild(b);
        });
        box.appendChild(bar);
      }
      // The portrait is the shortest path to "look at this player's world".
      var portraitEl = box.querySelector('.chat-ref-portrait');
      if (portraitEl && card.planet_id) {
        portraitEl.classList.add('chat-mod-clickable');
        portraitEl.title = 'Watch ' + card.planet_id;
        portraitEl.addEventListener('click', function (ev) {
          ev.stopPropagation();
          runCardAction(card, 'watch_planet', box);
        });
      }
      return box;
    }

    // A card reports its own outcome, in place. A toast would land in another
    // window and a dialogue would cover the conversation the card belongs to.
    function cardNote(box, text, isError) {
      var old = box.querySelector('.chat-ref-note');
      if (old) old.parentNode.removeChild(old);
      var note = el('div', 'chat-ref-note' + (isError ? ' chat-mod-error' : ''), text);
      box.appendChild(note);
      return note;
    }

    function runCardAction(card, key, box) {
      if (key === 'message') { startDm(card.id); return; }
      if (key === 'watch_planet' || key === 'watch_fleet') {
        var isPlanet = key === 'watch_planet';
        var target = isPlanet ? card.planet_id : card.fleet_id;
        if (!target) { cardNote(box, 'nothing to watch', true); return; }
        // The same spectator window Team Ops opens — one map viewer, reached
        // from wherever the thing was named.
        invoke('mcp_raid_view_open', {
          planetId: isPlanet ? target : null,
          fleetId: isPlanet ? null : target,
        }).catch(function (e) { cardNote(box, String(e), true); });
        return;
      }
      if (key === 'send_alpha') { sendAlpha(card, box); return; }
      if (key === 'site') {
        // The guild's own website, opened by the OS — the same guarded opener
        // every link in the timeline goes through.
        if (!card.site) { cardNote(box, 'no site published', true); return; }
        invoke('matrix_open_url', { url: card.site }).catch(function (e) { cardNote(box, String(e), true); });
        return;
      }
      if (key === 'agreement') { rentForm(card, box); return; }
      if (key === 'ask_help') { askForHelp(card, box); return; }
    }

    // Ask the room to grind the cycle this struct is running.
    //
    // The anchor comes from the CHAIN, never from the card: it is what the
    // proof is verified against, and an offer carrying a guessed one would have
    // every solver grinding a string that can never be accepted.
    function askForHelp(card, box) {
      cardNote(box, 'reading the cycle\u2026');
      return invoke('matrix_work_params', { objectId: card.id, task: card.work_task })
        .then(function (p) {
          return invoke('matrix_work_offer', {
            guildId: S.guildId, roomId: S.roomId,
            objectId: p.object, task: p.task,
            blockStart: p.block_start, difficulty: p.difficulty, targetId: null,
          });
        })
        .then(function () { cardNote(box, 'asked'); })
        .catch(function (e) { cardNote(box, String(e), true); });
    }

    // Hand Team Ops a pre-filled transfer for this player.
    //
    // Comms deliberately cannot spend. `mcp_transfer_execute` is board-only and
    // re-runs its own preview server-side, and this window renders text written
    // by federated strangers — it is the last place that should hold a wallet.
    // So the button asks, and the money is still committed in Team Ops, in front
    // of a preview naming the recipient.
    //
    // Only the player ID crosses over. The address is resolved from the chain on
    // the other side, so a crafted card cannot name where the funds go.
    function sendAlpha(card, box) {
      cardNote(box, 'opening Team Ops\u2026');
      return invoke('matrix_open_transfer', { playerId: card.id })
        .then(function () { cardNote(box, 'ready in Team Ops — confirm it there'); })
        .catch(function (e) { cardNote(box, String(e), true); });
    }


    return {
      ID_RE: ID_RE, REF_KINDS: REF_KINDS, refCard: refCard, wantRefs: wantRefs, flushRefs: flushRefs,
      cardNote: cardNote, cards: refCards,
    };
  };
})();
