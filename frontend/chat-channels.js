// Comms — the Channels page: which rooms you are in, grouped by net, in the
// order that finds the one waiting on you.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatchannels.test.mjs can drive it with a stub
// `invoke` and no window boot:
//
//   window.ChatChannels({ el, icon, invoke, fmtCount, go, pfpPortrait, presenceDot,
//                         render, refreshRooms, showError, openRoom, headerResources,
//                         pageHeader, byId, moveCaretToEnd, noticeBlock, S, Chat })
//     → { SECTIONS, serverOf, foreignServerLabel, roomRow, roomOrder,
//         filteredRooms, matchesFilter, renderChannels }
(function () {
  'use strict';
  window.ChatChannels = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, fmtCount = ctx.fmtCount, go = ctx.go;
    var pfpPortrait = ctx.pfpPortrait, presenceDot = ctx.presenceDot, render = ctx.render;
    var refreshRooms = ctx.refreshRooms, showError = ctx.showError, openRoom = ctx.openRoom;
    var headerResources = ctx.headerResources, pageHeader = ctx.pageHeader, byId = ctx.byId;
    var moveCaretToEnd = ctx.moveCaretToEnd, noticeBlock = ctx.noticeBlock, S = ctx.S, Chat = ctx.Chat || {};

    var SECTIONS = [
      // First, always. An invitation is the one row in the list waiting on an
      // answer from you rather than reporting something that happened.
      { key: 'invite', label: 'Invitations' },
      { key: 'direct', label: 'Direct' },
      { key: 'local', label: 'Local Net' },
      { key: 'galaxy', label: 'Galaxy Net' },
    ];

    // Which homeserver a room lives on, from its alias or its id.
    function serverOf(r) {
      var src = r.canonical_alias || r.room_id || '';
      var at = src.lastIndexOf(':');
      return at === -1 ? '' : src.slice(at + 1);
    }
    Chat.serverOf = serverOf;

    function ownServer() {
      var uid = (S.profile && S.profile.user_id) || '';
      var at = uid.lastIndexOf(':');
      return at === -1 ? '' : uid.slice(at + 1);
    }

    // Label a room's home only when it is somewhere ELSE. Browse spans every
    // guild in the galaxy, but most rows are from your own server and stamping
    // that on all of them is noise, not information. The `matrix.` prefix is
    // dropped because every one of these hosts has it.
    function foreignServerLabel(r) {
      var host = serverOf(r);
      if (!host || host === ownServer()) return '';
      return host.replace(/^matrix\./, '');
    }
    Chat.foreignServerLabel = foreignServerLabel;

    function roomRow(r, browsing) {
      var row = el('div', 'sui-result-row chat-room-row');

      var left = el('div', 'sui-result-row-left-section');
      // Whether this is a PERSON is the server's classification, not something
      // to infer from having a player id.
      //
      // `player_id` is only set when the other side's Matrix id parses as a
      // player — so a direct message with a bot or a service account has none,
      // and reading DM-ness off it rendered that room as a channel, complete
      // with a member count, while Rust classified it 'direct' and notified it
      // as a DM. `section` is what `dm_with` actually produces.
      var isDm = r.section === 'direct';
      var portrait = el('div', 'sui-result-row-portrait');
      if (r.pfp_attrs || r.player_id || isDm) {
        // A direct message IS a person — the same portrait the roster shows.
        portrait.appendChild(pfpPortrait(r.pfp_attrs));
      } else if (r.home_rank != null) {
        /* The home channel carries SN Corp's own mark instead of the generic
         * guild glyph. `img/logo-snc.gif` is the game's asset — the same one the
         * signup flow shows while connecting to the corp — not something drawn
         * for this list.
         *
         * Straight into the portrait, which is exactly how the webapp's own
         * Guild Directory renders a guild logo: `.sui-result-row-portrait img`
         * is `width: 100%`, so it fills the 44px slot. It was nested in a 32px
         * `.chat-room-icon` first and came out a third of the size, floating in
         * the corner of a box built for something bigger. */
        var mark = document.createElement('img');
        mark.className = 'chat-room-mark';
        mark.src = 'img/logo-snc.gif';
        mark.alt = '';
        portrait.appendChild(mark);
      } else {
        var well = el('div', 'chat-room-icon');
        well.appendChild(icon(r.icon || 'icon-beacon', 'sui-icon-md'));
        portrait.appendChild(well);
      }
      left.appendChild(portrait);

      var info = el('div', 'sui-result-row-player-info');
      var block = el('div', 'sui-text-label-block');
      // A direct message IS a person, so it is the one room row where "are they
      // actually here" is a question about the row itself.
      var here = presenceDot(r.player_id);
      if (here) block.appendChild(here);
      block.appendChild(el('span', null, r.name || r.canonical_alias || r.room_id));
      block.appendChild(el('br'));
      // A DM's subtitle is who it is with; a channel's is how many are in it.
      // Browsing adds where it lives and what it is for: the directory spans
      // every guild's homeserver, so "which server" is part of choosing.
      var sub;
      if (r.player_id) {
        sub = el('span', 'sui-text-hint',
          (r.tag ? '[' + r.tag + '] ' : '') + 'PID #' + r.player_id);
      } else {
        var parts = r.invited
          // An invitation has no member count worth showing — you cannot see
          // the room yet. Who asked is the whole basis for deciding.
          ? [r.invited_by ? 'Invited by ' + r.invited_by : 'You have been invited']
          // "2 Players" under a direct message is a count of a conversation,
          // which is not a fact anybody wants. A DM with no player behind it
          // simply says nothing rather than pretending to be a channel.
          : isDm
            ? []
            : [fmtCount(r.members) + (Number(r.members) === 1 ? ' Player' : ' Players')];
        if (browsing) {
          // The ADDRESS — the one thing about a room that cannot be taken.
          // Anyone may publish a public room under any name, so two rows here
          // can legitimately carry the SAME display name; without an address
          // there is nothing on screen that tells them apart.
          //
          // Only the alias's localpart, not the whole thing: the server half is
          // shown separately and only when the room is somewhere else, because
          // stamping every own-server row with its own server is noise on most
          // of the list.
          var addr = String(r.canonical_alias || '').split(':')[0];
          parts.push(addr || r.room_id);
          var host = foreignServerLabel(r);
          if (host) parts.push(host);
          if (r.topic) parts.push(r.topic);
        }
        sub = el('span', 'sui-text-hint', parts.join(' · '));
      }
      block.appendChild(sub);
      info.appendChild(block);
      left.appendChild(info);
      row.appendChild(left);

      var right = el('div', 'sui-result-row-right-section');
      // A silenced room still shows its count — it is unread, it just does not
      // interrupt. The marker is what explains why it never rang.
      if (r.muted) {
        var q = icon('icon-disabled', 'sui-icon-sm chat-room-muted');
        q.title = 'Silenced';
        right.appendChild(q);
      }
      if (r.unread) {
        // Warning colour when you were named in it — the one badge in the list
        // that should pull the eye. Never for a silenced room: the whole point
        // of muting is that being named there stops pulling the eye.
        var b = el('div',
          'sui-badge chat-room-unread ' +
          (r.mention && !r.muted ? 'sui-mod-warning' : 'sui-mod-default'),
          fmtCount(r.unread));
        if (r.mention) b.title = 'You were mentioned';
        right.appendChild(b);
      }
      if (browsing && r.joined) {
        right.appendChild(el('div', 'sui-badge sui-mod-default', 'Joined'));
      }
      // Declining is only offered for an INVITATION. A room you merely found in
      // the directory has nothing to decline — you were never asked.
      if (r.invited) {
        var no = el('button', 'sui-screen-btn chat-room-decline', 'Decline');
        no.title = 'Turn down this invitation';
        no.addEventListener('click', function (ev) {
          ev.stopPropagation();
          no.disabled = true;
          no.textContent = 'Declining';
          invoke('matrix_leave', { guildId: S.guildId, roomId: r.room_id })
            .then(function () {
              // Gone from the list at once. Waiting for a sync to confirm it
              // leaves a question on screen that has already been answered.
              S.rooms = S.rooms.filter(function (x) { return x.room_id !== r.room_id; });
              render();
              return refreshRooms();
            })
            .catch(function (e) {
              no.textContent = 'Decline';
              no.disabled = false;
              showError(String(e));
            });
        });
        right.appendChild(no);
      }
      if (!r.joined) {
        var join = el('button', 'sui-screen-btn sui-mod-secondary',
          r.invited ? 'Accept' : 'Join');
        join.addEventListener('click', function (ev) {
          ev.stopPropagation();
          join.disabled = true;
          join.classList.add('sui-mod-disabled');
          join.textContent = 'Joining';
          invoke('matrix_join', { guildId: S.guildId, roomId: r.room_id })
            .then(function () {
              return refreshRooms().then(function () {
                // Joining from the directory, or accepting an invitation, is a
                // decision to go there.
                if (browsing || r.invited) openRoom(r.room_id);
              });
            })
            .catch(function (e) {
              join.textContent = r.invited ? 'Accept' : 'Join';
              join.disabled = false;
              join.classList.remove('sui-mod-disabled');
              showError(String(e));
            });
        });
        right.appendChild(join);
      }
      row.appendChild(right);

      if (r.joined) {
        row.addEventListener('click', function () { openRoom(r.room_id); });
      } else {
        row.classList.remove('chat-room-row');
      }
      return row;
    }

    // What a channel list is FOR is finding the thing that wants you. Within a
    // section: what named you, then what is unread, then the rest by name.
    //
    // A silenced room never jumps the queue, however much traffic it has —
    // muting means "stop pulling my eye", and sorting it to the top would undo
    // exactly that.
    function roomOrder(a, b) {
      var rank = function (r) {
        if (r.muted) return 2;
        if (r.mention) return 0;
        if (r.unread) return 1;
        return 2;
      };
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      // Within a rank, busier first — but only for rooms that are actually
      // waiting. Ordering read rooms by a count they all share at zero would
      // just be an unstable alphabetical.
      if (ra < 2 && (b.unread || 0) !== (a.unread || 0)) {
        return (b.unread || 0) - (a.unread || 0);
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    Chat.roomOrder = roomOrder;

    // The rooms a filter is currently showing, in the order they are shown.
    // Enter opens the first of these, so it has to be the SAME list and the
    // same order the eye is reading — deriving it twice is how the top row and
    // the one that opens come to disagree.
    function filteredRooms() {
      var mine = S.rooms.filter(function (r) { return r.joined || r.invited; })
        .filter(matchesFilter);
      var out = [];
      SECTIONS.forEach(function (sec) {
        mine.filter(function (r) { return (r.section || 'galaxy') === sec.key; })
          .slice().sort(roomOrder)
          .forEach(function (r) { out.push(r); });
      });
      return out;
    }
    Chat.filteredRooms = filteredRooms;

    function matchesFilter(r) {
      var q = String(S.roomFilter || '').trim().toLowerCase();
      if (!q) return true;
      return String(r.name || '').toLowerCase().indexOf(q) !== -1 ||
        String(r.canonical_alias || '').toLowerCase().indexOf(q) !== -1;
    }

    function renderChannels() {
      var page = el('div', 'chat-page');

      // Resources sit where the game puts them; the new-message door sits
      // beside them, because starting a conversation is the one action this
      // page has that is not "open a thing already on it".
      var right = el('div', 'chat-header-actions');
      var browse = el('a', 'sui-nav-btn');
      browse.id = 'chat-browse';
      browse.href = 'javascript:void(0)';
      browse.title = 'Browse channels';
      browse.appendChild(icon('icon-guild-directory sui-text-secondary'));
      browse.addEventListener('click', function () { go('browse'); });
      right.appendChild(browse);

      var newMsg = el('a', 'sui-nav-btn');
      newMsg.id = 'chat-new-message';
      newMsg.href = 'javascript:void(0)';
      newMsg.title = 'Message a player';
      newMsg.appendChild(icon('icon-add sui-text-secondary'));
      newMsg.addEventListener('click', function () { go('people'); });
      right.appendChild(newMsg);
      var res = headerResources();
      if (res) right.appendChild(res);

      page.appendChild(pageHeader('Channels', null, right));

      // Only once the list is long enough to need it. A filter box above four
      // rooms is a control that costs more attention than it saves.
      var joined = S.rooms.filter(function (r) { return r.joined || r.invited; });
      // Long lists get it unasked; a short list only shows it once you have
      // gone looking for it — but then it must be there, or Ctrl-K would put
      // the cursor nowhere.
      if (joined.length > 8 || S.roomFilter || S.filterWanted) {
        var box = el('div');
        box.id = 'chat-room-filter';
        var label = el('label', 'sui-input-text');
        label.setAttribute('for', 'chat-room-filter-q');
        var fi = el('input');
        fi.type = 'text';
        fi.id = 'chat-room-filter-q';
        fi.name = 'chat-room-filter-q';
        fi.placeholder = 'Find a channel';
        fi.autocomplete = 'off';
        fi.value = S.roomFilter || '';
        fi.addEventListener('input', function () {
          S.roomFilter = fi.value;
          render();
        });
        fi.addEventListener('keydown', function (e) {
          // Enter opens the best match. Typing three letters and pressing
          // Enter is the whole point of a filter; reaching for the mouse to
          // finish the job wastes it.
          if (e.key === 'Enter') {
            e.preventDefault();
            var best = filteredRooms()[0];
            if (best) { S.roomFilter = ''; openRoom(best.room_id); }
            return;
          }
          if (e.key !== 'Escape') return;
          e.preventDefault(); e.stopPropagation();
          S.roomFilter = '';
          render();
          var again = byId('chat-room-filter-q');
          if (again) again.focus();
        });
        label.appendChild(fi);
        box.appendChild(label);
        page.appendChild(box);
        // Ctrl-K asks for this box; `go('channels')` then refreshes the room
        // list, which re-renders and throws the focus away. Re-asserting it
        // here means the cursor survives however many pushes land underneath.
        //
        // Only when nothing else has taken it: a room-list push must not yank
        // the caret out of wherever the player has since clicked.
        if (S.filterWanted) {
          var active = document.activeElement;
          if (!active || active === document.body ||
              active.id === 'chat-room-filter-q') {
            setTimeout(function () {
              var live = byId('chat-room-filter-q');
              if (live && document.activeElement !== live) {
                live.focus();
                moveCaretToEnd(live);
              }
            }, 0);
          }
        }
      }

      var scroll = el('div', 'chat-scroll');

      // A share arrived with nowhere to go yet. Say so where the choice is.
      if (S.draft) {
        scroll.appendChild(noticeBlock(
          'Ready to share ' + S.draft,
          'Open a conversation and it will be waiting in the message box.'));
      }

      if (S.loading) {
        scroll.appendChild(noticeBlock('Loading', 'Reading your channels.'));
      } else if (!S.rooms.filter(function (r) { return r.joined || r.invited; }).length) {
        scroll.appendChild(noticeBlock(
          'No channels yet',
          'You have not joined anything. Browse the directory to find rooms.'));
      } else {
        // Only rooms you are IN. What else exists lives in Browse — a list that
        // mixes "your channels" with "every channel on the server" answers
        // neither question well.
        var mine = S.rooms.filter(function (r) { return r.joined || r.invited; })
          .filter(matchesFilter);
        if (!mine.length) {
          scroll.appendChild(noticeBlock('Nothing matches',
            'No channel of yours is called ' + JSON.stringify(S.roomFilter) + '.'));
        }
        /* The home channel, above every section.
         *
         * Not "first within its section": it lands in Local Net for SN Corp's
         * own members and Galaxy Net for everyone else, so leaving it in place
         * would put it under Invitations and Direct for half the roster and in
         * a different group depending on who you are. Its own group, first, is
         * the only arrangement that means the same thing to everybody.
         *
         * Ranked by the server (`home_rank`), which requires the room to be on
         * that guild's OWN homeserver — so a directory room that merely calls
         * itself SN Corp cannot take the slot. The order inside the group is
         * the rank, NOT `roomOrder`: these are furniture, and furniture that
         * reshuffles itself by unread count is not pinned in any useful sense.
         */
        var home = mine.filter(function (r) { return r.home_rank != null; })
          .sort(function (a, b) { return a.home_rank - b.home_rank; });
        var rest = mine.filter(function (r) { return r.home_rank == null; });
        if (home.length) {
          var hGroup = el('div', 'chat-net-group');
          hGroup.appendChild(el('div', 'chat-net-label', 'Structs'));
          var hTable = el('div', 'sui-result-table');
          var hList = el('div', 'sui-result-rows');
          home.forEach(function (r) { hList.appendChild(roomRow(r)); });
          hTable.appendChild(hList);
          hGroup.appendChild(hTable);
          scroll.appendChild(hGroup);
        }
        SECTIONS.forEach(function (sec) {
          var rows = rest.filter(function (r) { return (r.section || 'galaxy') === sec.key; });
          if (!rows.length) return;
          rows = rows.slice().sort(roomOrder);
          var group = el('div', 'chat-net-group');
          group.appendChild(el('div', 'chat-net-label', sec.label));
          var table = el('div', 'sui-result-table');
          var list = el('div', 'sui-result-rows');
          rows.forEach(function (r) { list.appendChild(roomRow(r)); });
          table.appendChild(list);
          group.appendChild(table);
          scroll.appendChild(group);
        });
      }

      page.appendChild(scroll);
      return page;
    }

    return {
      SECTIONS: SECTIONS, serverOf: serverOf, foreignServerLabel: foreignServerLabel,
      roomRow: roomRow, roomOrder: roomOrder, filteredRooms: filteredRooms,
      matchesFilter: matchesFilter, renderChannels: renderChannels,
    };
  };
})();
