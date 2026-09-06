// Comms — reactions, edits and removals on a message.
//
// A Matrix reaction key is an arbitrary string, so this window reacts with
// the game's own icons and struct art (`:raid:`, `:struct/tank:`) and shows
// anything else — an emoji from Element, a word — as itself. Editing goes
// back through the composer; removal takes two clicks. Every change is
// applied locally at once and corrected by the answer.
//
// Extracted from chat.js (2026-09-05). Collaborators arrive as a context:
//
//   window.ChatReactions({ el, icon, byId, invoke, excerpt, moveCaretToEnd,
//                          render, showError, S, Chat })
//     → { reactionGlyph, reactionRow, reactButton, react, optimistic,
//         applyReactions, onReactions, editButton, editChip, cancelEdit,
//         commitEdit, applyEdit, onEdited, serverIdOf, deleteButton,
//         redactMessage, onRedacted, QUICK_REACTIONS, REACTION_STRUCTS }
(function () {
  'use strict';
  window.ChatReactions = function (ctx) {
    var el = ctx.el, icon = ctx.icon, byId = ctx.byId, invoke = ctx.invoke, excerpt = ctx.excerpt;
    var moveCaretToEnd = ctx.moveCaretToEnd, render = ctx.render, showError = ctx.showError;
    var S = ctx.S, Chat = ctx.Chat || {};

    // A Matrix reaction key is an arbitrary string, which means it does not have
    // to be an emoji. Structs has its own icon set and its own struct art, and a
    // guild agreeing to a raid with the raid glyph says more than a thumb does.
    //
    // The keys are `:shortcode:` so they stay READABLE somewhere else: a player
    // on Element sees `:raid:`, not a broken box. Emoji arriving from those
    // clients still render as emoji — that is content this window receives, not
    // chrome it chose.
    var REACTION_ICONS = {
      okay: 'icon-okay', blocked: 'icon-blocked', detected: 'icon-detected',
      alert: 'icon-alert', raid: 'icon-raid', defend: 'icon-defend',
      mine: 'icon-mine', wreckage: 'icon-wreckage',
    };
    // Agree, refuse, watching, careful — then the four things a guild room is
    // usually talking about.
    var QUICK_REACTIONS = [':okay:', ':blocked:', ':detected:', ':alert:',
                           ':raid:', ':defend:', ':mine:', ':wreckage:'];

    // The struct art that ships with the game, one picture per hull. Offered
    // behind a toggle: twenty of them open by default would be a wall.
    var REACTION_STRUCTS = [
      'cmd-ship', 'destroyer', 'battleship', 'cruiser', 'frigate', 'interceptor',
      'starfighter', 'stealth-bomber', 'pursuit-fighter', 'submersible', 'tank',
      'mobile-artillery', 'sam-launcher', 'pdc', 'jamming-sat', 'orb-shield',
      'extractor', 'refinery', 'generator', 'ore-bunker',
    ];

    // Render one key. Falls through to plain text, which is what makes a key
    // from any other client — an emoji, a word, a shortcode we do not know —
    // still show as itself rather than as nothing.
    function reactionGlyph(key) {
      var m = /^:struct\/([a-z0-9-]+):$/.exec(key);
      if (m && REACTION_STRUCTS.indexOf(m[1]) !== -1) {
        var im = el('img', 'chat-reaction-struct');
        im.src = 'img/structs/' + m[1] + '/' + m[1] + '-struct-base.png';
        im.alt = m[1];
        return im;
      }
      m = /^:([a-z0-9-]+):$/.exec(key);
      if (m && REACTION_ICONS[m[1]]) {
        return icon(REACTION_ICONS[m[1]], 'sui-icon-sm');
      }
      return el('span', 'chat-reaction-key', key);
    }
    Chat.reactionGlyph = reactionGlyph;

    function reactionRow(m) {
      var list = m.reactions || [];
      // Both sides must be a REAL event id. `S.reactPicker` is null when no
      // picker is open and `serverIdOf` is null for a local line — so a plain
      // equality made `null === null` true and opened the picker on every
      // system notice, every error and every message still in flight.
      var id = serverIdOf(m);
      var open = !!id && S.reactPicker === id;
      if (!list.length && !open) return null;

      var row = el('div', 'chat-reactions');
      list.forEach(function (r) {
        var chip = el('a', 'sui-badge chat-reaction' +
          (r.mine ? ' sui-mod-warning' : ' sui-mod-default'));
        chip.href = 'javascript:void(0)';
        chip.appendChild(reactionGlyph(r.key));
        chip.appendChild(el('span', 'chat-reaction-count', String(r.count)));
        // Who agreed is the whole point in a guild room, and it is the one
        // thing a count throws away.
        chip.title = (r.who || []).join(', ') || r.key;
        chip.addEventListener('click', function (e) {
          e.stopPropagation();
          react(m, r.key, !r.mine);
        });
        row.appendChild(chip);
      });

      if (open) {
        var offer = function (key) {
          var already = list.some(function (r) { return r.key === key && r.mine; });
          var b = el('a', 'chat-reaction chat-mod-offer' + (already ? ' chat-mod-mine' : ''));
          b.href = 'javascript:void(0)';
          b.title = key;
          b.appendChild(reactionGlyph(key));
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            // Picking closes the picker, and closing forgets the sheet — the
            // same as dismissing it, so the next message does not open with
            // twenty hulls already showing.
            S.reactPicker = null;
            S.reactStructs = false;
            react(m, key, !already);
          });
          row.appendChild(b);
        };
        QUICK_REACTIONS.forEach(offer);

        // Twenty hulls open by default would be a wall across the message.
        var more = el('a', 'chat-reaction chat-mod-offer chat-mod-more');
        more.href = 'javascript:void(0)';
        more.title = S.reactStructs ? 'Hide the hulls' : 'React with a struct';
        more.appendChild(icon(S.reactStructs ? 'icon-chevron-left' : 'icon-cmd-post',
          'sui-icon-sm'));
        more.addEventListener('click', function (e) {
          e.stopPropagation();
          S.reactStructs = !S.reactStructs;
          render();
        });
        row.appendChild(more);

        if (S.reactStructs) {
          REACTION_STRUCTS.forEach(function (name) { offer(':struct/' + name + ':'); });
        }
      }
      return row;
    }

    function reactButton(m, serverId) {
      var a = el('a', 'chat-react-btn');
      a.href = 'javascript:void(0)';
      a.title = 'React to this message';
      a.appendChild(icon('icon-add sui-text-secondary', 'sui-icon-sm'));
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = serverId || serverIdOf(m);
        S.reactPicker = S.reactPicker === id ? null : id;
        if (!S.reactPicker) S.reactStructs = false;
        render();
      });
      return a;
    }

    // Applied locally at once, then corrected by the answer. A reaction that
    // waits for a round trip before appearing feels like a click that missed.
    function react(m, key, on) {
      var before = (m.reactions || []).map(function (r) {
        return { key: r.key, count: r.count, mine: r.mine, who: r.who };
      });
      m.reactions = optimistic(before, key, on);
      render();
      return invoke('matrix_react', {
        guildId: S.guildId, roomId: S.roomId, eventId: serverIdOf(m), key: key, on: on,
      })
        .then(function (res) {
          if (res && res.reactions) applyReactions(m.event_id, res.reactions);
        })
        .catch(function (e) {
          m.reactions = before;                    // put it back; it did not happen
          render();
          showError(String(e));
        });
    }
    Chat.react = react;

    function optimistic(list, key, on) {
      var out = [];
      var found = false;
      list.forEach(function (r) {
        if (r.key !== key) { out.push(r); return; }
        found = true;
        var count = r.count + (on ? 1 : -1);
        // A key nobody holds any more is gone, not a chip reading zero.
        if (count > 0) out.push({ key: key, count: count, mine: on, who: r.who });
      });
      if (!found && on) out.push({ key: key, count: 1, mine: true, who: [] });
      return out.sort(function (a, b) {
        return b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      });
    }
    Chat.optimistic = optimistic;

    // A reaction landed on some message — repaint that one, not the timeline.
    function applyReactions(eventId, reactions) {
      var hit = false;
      S.messages.forEach(function (m) {
        if (m.event_id === eventId || m.echo_of === eventId) {
          m.reactions = reactions || [];
          hit = true;
        }
      });
      S.pins.forEach(function (m) {
        if (m.event_id === eventId) m.reactions = reactions || [];
      });
      if (hit || S.pins.length) render();
    }

    function onReactions(payload) {
      if (!payload) return;
      if (payload.guild_id && payload.guild_id !== S.guildId) return;
      if (payload.room_id !== S.roomId) return;
      applyReactions(payload.event_id, payload.reactions);
    }
    Chat.onReactions = onReactions;

    // Changing what you already said.
    //
    // The message goes back into the composer, which is the only place in this
    // window that knows how to write one — a second editor would need its own
    // completion, its own mention matching and its own history.
    function editButton(m, serverId) {
      var a = el('a', 'chat-edit-btn');
      a.href = 'javascript:void(0)';
      a.title = 'Change this message';
      a.appendChild(icon('icon-edit sui-text-secondary', 'sui-icon-sm'));
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        S.editing = { event_id: serverId, body: m.body, msgtype: m.kind };
        S.replyTo = null;                  // one intent at a time
        render();
        var input = byId('chat-input');
        if (!input) return;
        input.value = m.body || '';
        input.focus();
        moveCaretToEnd(input);
      });
      return a;
    }

    // The chip above the bar, so it is never a mystery why Enter is about to
    // rewrite something instead of sending it.
    function editChip() {
      if (!S.editing) return null;
      var chip = el('div', 'chat-reply-chip chat-mod-editing');
      chip.id = 'chat-edit-chip';
      chip.appendChild(icon('icon-edit sui-text-secondary', 'sui-icon-sm'));
      chip.appendChild(el('span', 'chat-reply-who', 'Editing'));
      chip.appendChild(el('span', 'chat-reply-text', excerpt(S.editing.body)));
      var x = el('a', 'chat-reply-cancel');
      x.href = 'javascript:void(0)';
      x.title = 'Keep it as it was';
      x.appendChild(icon('icon-close sui-text-secondary', 'sui-icon-sm'));
      x.addEventListener('click', function () { cancelEdit(); });
      chip.appendChild(x);
      return chip;
    }

    function cancelEdit() {
      S.editing = null;
      render();
      var input = byId('chat-input');
      if (input) { input.value = ''; input.focus(); }
    }
    Chat.cancelEdit = cancelEdit;

    function commitEdit(text) {
      var target = S.editing;
      S.editing = null;
      return invoke('matrix_edit', {
        guildId: S.guildId, roomId: S.roomId, eventId: target.event_id,
        body: text, msgtype: target.msgtype === 'emote' ? 'm.emote' : null,
      })
        .then(function () { applyEdit(target.event_id, text); })
        .catch(function (e) { showError(String(e)); });
    }

    // Somebody rewrote a message — including us, a moment ago or on another
    // device.
    function applyEdit(eventId, body) {
      var hit = false;
      S.messages.forEach(function (m) {
        if (serverIdOf(m) !== eventId) return;
        m.body = body;
        m.edited = true;
        hit = true;
      });
      S.pins.forEach(function (m) {
        if (m.event_id === eventId) { m.body = body; m.edited = true; }
      });
      if (hit || S.pins.length) render();
    }

    function onEdited(payload) {
      if (!payload) return;
      if (payload.guild_id && payload.guild_id !== S.guildId) return;
      if (payload.room_id !== S.roomId) return;
      applyEdit(payload.event_id, payload.body);
    }
    Chat.onEdited = onEdited;

    // Taking a message back.
    //
    // Two clicks, not one. It cannot be undone and the control sits in a row of
    // others that are all harmless — a misfire on a neighbouring icon would
    // otherwise destroy something. The second click is the confirmation, and
    // moving the mouse away cancels it.
    // What the homeserver calls this message: its own id once sync has
    // delivered it, or the id the send came back with while the local echo is
    // still on screen. Null for a message that has not been accepted yet.
    function serverIdOf(m) {
      if (m.event_id && m.event_id.charAt(0) === '$') return m.event_id;
      if (m.echo_of && String(m.echo_of).charAt(0) === '$') return m.echo_of;
      return null;
    }
    Chat.serverIdOf = serverIdOf;

    function deleteButton(m, serverId) {
      var armed = S.deleteArmed === serverId;
      var a = el('a', 'chat-delete-btn' + (armed ? ' chat-mod-armed' : ''));
      a.href = 'javascript:void(0)';
      a.title = armed ? 'Click again to remove this message' : 'Remove this message';
      a.appendChild(icon('icon-close' + (armed ? ' sui-text-enemy-primary' : ' sui-text-secondary'),
        'sui-icon-sm'));
      a.addEventListener('mouseleave', function () {
        if (S.deleteArmed === serverId) { S.deleteArmed = null; render(); }
      });
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!armed) { S.deleteArmed = serverId; render(); return; }
        S.deleteArmed = null;
        redactMessage(m, serverId);
      });
      return a;
    }

    function redactMessage(m, serverId) {
      return invoke('matrix_redact', {
        guildId: S.guildId, roomId: S.roomId, eventId: serverId || serverIdOf(m),
      })
        .then(function () {
          // Sync delivers the redaction and rewrites it properly; this is so the
          // click has an effect now rather than in a second's time.
          m.kind = 'notice';
          m.body = 'message removed';
          m.mxc = null;
          m.reactions = [];
          m.reply_to = null;
          render();
        })
        .catch(function (e) { showError(String(e)); });
    }
    Chat.redactMessage = redactMessage;

    // Somebody took a message back — including us, on another device.
    function onRedacted(payload) {
      if (!payload) return;
      if (payload.guild_id && payload.guild_id !== S.guildId) return;
      if (payload.room_id !== S.roomId) return;
      var hit = false;
      S.messages.forEach(function (m) {
        if (m.event_id !== payload.event_id) return;
        m.kind = 'notice';
        m.body = 'message removed';
        m.mxc = null;
        m.reactions = [];
        m.reply_to = null;
        hit = true;
      });
      if (hit) render();
    }
    Chat.onRedacted = onRedacted;


    return {
      reactionGlyph: reactionGlyph, reactionRow: reactionRow, reactButton: reactButton, react: react,
      optimistic: optimistic, applyReactions: applyReactions, onReactions: onReactions,
      editButton: editButton, editChip: editChip, cancelEdit: cancelEdit, commitEdit: commitEdit,
      applyEdit: applyEdit, onEdited: onEdited, serverIdOf: serverIdOf, deleteButton: deleteButton,
      redactMessage: redactMessage, onRedacted: onRedacted,
      QUICK_REACTIONS: QUICK_REACTIONS, REACTION_STRUCTS: REACTION_STRUCTS,
    };
  };
})();
