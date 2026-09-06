// Comms — people: who is in this room, the channel directory, the player
// directory, and starting a direct message.
//
// Every player is addressable without any prior contact: their Matrix id is
// their player id at their own guild's homeserver, and both halves are
// public. So these are directories, not friends lists — nothing to request
// and nothing to accept.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatpeople.test.mjs can drive it with a stub `invoke`
// and no window boot:
//
//   window.ChatPeople({ el, icon, invoke, go, pageHeader, noticeBlock, render, showError,
//                       pfpPortrait, presenceDot, roomRow, refreshRooms, openRoom,
//                       sendMessage, say, S, Chat })
//     → { renderMembers, memberRow, loadMembers, browseOrder, renderBrowse, loadBrowse,
//         personRow, renderPeople, loadPeople, startDm }
(function () {
  'use strict';
  window.ChatPeople = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, go = ctx.go;
    var pageHeader = ctx.pageHeader, noticeBlock = ctx.noticeBlock, render = ctx.render, showError = ctx.showError;
    var pfpPortrait = ctx.pfpPortrait, presenceDot = ctx.presenceDot, roomRow = ctx.roomRow;
    var refreshRooms = ctx.refreshRooms, openRoom = ctx.openRoom, sendMessage = ctx.sendMessage, say = ctx.say;
    var S = ctx.S, Chat = ctx.Chat || {};

    // The most basic question a room raises, and the window could not answer it
    // at all. Doubles as the address book: a name seen here is a name the
    // composer can complete and a person you can message.
    function renderMembers() {
      var page = el('div', 'chat-page');
      var name = (S.room && (S.room.name || S.room.canonical_alias)) || S.roomId || '';
      page.appendChild(pageHeader(name + ' · People', function () {
        // Back to the conversation, not to the channel list.
        if (S.roomId) { S.view = 'room'; render(); } else { go('channels'); }
      }, null));

      var scroll = el('div', 'chat-scroll');
      if (S.membersLoading) {
        scroll.appendChild(noticeBlock('Loading', 'Asking who is in this room.'));
      } else if (!S.members.length) {
        scroll.appendChild(noticeBlock('Empty', 'Nobody else is here.'));
      } else {
        var table = el('div', 'sui-result-table');
        var list = el('div', 'sui-result-rows');
        S.members.forEach(function (p) { list.appendChild(memberRow(p)); });
        table.appendChild(list);
        scroll.appendChild(table);
      }
      page.appendChild(scroll);
      return page;
    }

    function memberRow(p) {
      var row = el('div', 'sui-result-row' + (p.player_id ? ' chat-room-row' : ''));

      var left = el('div', 'sui-result-row-left-section');
      var portrait = el('div', 'sui-result-row-portrait');
      if (p.player_id) {
        portrait.appendChild(pfpPortrait(p.pfp_attrs));
      } else {
        // Not a player: a bot or a service account. Its own glyph, so the list
        // does not imply a person who is not one.
        var well = el('div', 'chat-room-icon');
        well.appendChild(icon('icon-computer', 'sui-icon-md'));
        portrait.appendChild(well);
      }
      left.appendChild(portrait);

      var info = el('div', 'sui-result-row-player-info');
      var block = el('div', 'sui-text-label-block');
      // "Who is here" is the question this whole list exists to answer, so the
      // dot goes first, before the name it belongs to.
      var here = presenceDot(p.player_id);
      if (here) block.appendChild(here);
      if (p.tag) block.appendChild(el('span', 'chat-msg-tag', '[' + p.tag + '] '));
      block.appendChild(el('span', null, p.name + (p.is_self ? ' (you)' : '')));
      block.appendChild(el('br'));
      // What they say they are doing, when they have chosen to say it. Most
      // will not have, so the id stays the fallback rather than the row going
      // blank.
      var said = p.presence && p.presence.status_msg;
      block.appendChild(el('span', 'sui-text-hint',
        said || (p.player_id ? 'PID #' + p.player_id : p.user_id)));
      info.appendChild(block);
      left.appendChild(info);
      row.appendChild(left);

      // A player can be messaged; a bot cannot.
      if (p.player_id && !p.is_self) {
        var right = el('div', 'sui-result-row-right-section');
        var btn = el('button', 'chat-ref-action');
        btn.appendChild(icon('icon-phone', 'sui-icon-sm'));
        btn.appendChild(el('span', null, 'Message'));
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          startDm(p.player_id);
        });
        right.appendChild(btn);
        row.appendChild(right);
        row.addEventListener('click', function () { startDm(p.player_id); });
      }
      return row;
    }

    function loadMembers() {
      if (!S.roomId) return Promise.resolve();
      var room = S.roomId;
      S.membersLoading = true;
      return invoke('matrix_members', { guildId: S.guildId, roomId: room })
        .then(function (res) {
          if (S.roomId !== room) return;
          S.members = (res && res.members) || [];
          S.membersLoading = false;
          if (S.view === 'members') render();
        })
        .catch(function (e) {
          S.membersLoading = false;
          S.members = [];
          if (S.view === 'members') showError(String(e));
        });
    }

    // ── Browse ────────────────────────────────────────────────────────────────
    // IRC's `/list`: everything public on the homeserver, searched server-side
    // because a busy server only ever hands us a page and filtering locally
    // would filter the wrong set.
    // Browse is for finding somewhere to go, so what you have NOT joined comes
    // first — a row you are already in answers a question you did not ask.
    //
    // Then busiest first. A directory in arrival order put a room with nobody
    // in it at the top, which is the least useful row it could possibly lead
    // with, and buried a 3,100-player channel below it.
    function browseOrder(a, b) {
      var ja = a.joined ? 1 : 0, jb = b.joined ? 1 : 0;
      if (ja !== jb) return ja - jb;
      var ma = Number(a.members) || 0, mb = Number(b.members) || 0;
      if (ma !== mb) return mb - ma;
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    Chat.browseOrder = browseOrder;

    function renderBrowse() {
      var page = el('div', 'chat-page');
      page.appendChild(pageHeader('Browse Channels', function () { go('channels'); }, null));

      var search = el('div');
      search.id = 'chat-people-search';
      var label = el('label', 'sui-input-text');
      label.setAttribute('for', 'chat-browse-query');
      var input = el('input');
      input.type = 'text';
      input.id = 'chat-browse-query';
      input.name = 'chat-browse-query';
      input.placeholder = 'Search channels';
      input.autocomplete = 'off';
      input.value = S.browseQuery || '';
      label.appendChild(input);
      search.appendChild(label);
      page.appendChild(search);

      var scroll = el('div', 'chat-scroll');
      if (S.browseLoading) {
        scroll.appendChild(noticeBlock('Loading', 'Reading the channel directory.'));
      } else if (!S.browse.length) {
        scroll.appendChild(noticeBlock(
          'Nothing found',
          S.browseQuery
            ? 'No channel matches “' + S.browseQuery + '”.'
            : 'This homeserver publishes no public channels.'));
      } else {
        var table = el('div', 'sui-result-table');
        var list = el('div', 'sui-result-rows');
        S.browse.slice().sort(browseOrder)
          .forEach(function (r) { list.appendChild(roomRow(r, true)); });
        table.appendChild(list);
        scroll.appendChild(table);
      }
      page.appendChild(scroll);

      input.addEventListener('input', function () {
        S.browseQuery = input.value;
        if (browseTimer) clearTimeout(browseTimer);
        browseTimer = setTimeout(loadBrowse, 250);
      });
      return page;
    }

    var browseTimer = null;

    function loadBrowse() {
      browseTimer = null;
      S.browseLoading = true;
      return invoke('matrix_browse', { guildId: S.guildId, query: S.browseQuery || null })
        .then(function (res) {
          S.browse = (res && res.rooms) || [];
          S.browseLoading = false;
          if (S.view === 'browse') render();
        })
        .catch(function (e) {
          S.browseLoading = false;
          S.browse = [];
          showError(String(e));
        });
    }

    // ── People ────────────────────────────────────────────────────────────────
    // Every player is addressable without any prior contact: their Matrix id is
    // their player id at their own guild's homeserver, and both halves are
    // public. So this is a directory, not a friends list — there is nothing to
    // request and nothing to accept.
    function personRow(p) {
      var row = el('div', 'sui-result-row chat-room-row');

      var left = el('div', 'sui-result-row-left-section');
      var portrait = el('div', 'sui-result-row-portrait');
      portrait.appendChild(pfpPortrait(p.pfp_attrs));
      left.appendChild(portrait);

      var info = el('div', 'sui-result-row-player-info');
      var block = el('div', 'sui-text-label-block');
      if (p.tag) block.appendChild(el('span', 'chat-msg-tag', '[' + p.tag + '] '));
      block.appendChild(el('span', null, p.username || 'Name Redacted'));
      block.appendChild(el('br'));
      block.appendChild(el('span', 'sui-text-hint', 'PID #' + p.player_id));
      info.appendChild(block);
      left.appendChild(info);
      row.appendChild(left);

      var right = el('div', 'sui-result-row-right-section');
      var btn = el('button', 'sui-screen-btn sui-mod-secondary', 'Message');
      right.appendChild(btn);
      row.appendChild(right);

      var open = function () { startDm(p.player_id); };
      row.addEventListener('click', open);
      btn.addEventListener('click', function (ev) { ev.stopPropagation(); open(); });
      return row;
    }

    function renderPeople() {
      var page = el('div', 'chat-page');
      page.appendChild(pageHeader('New Message', function () { go('channels'); }, null));

      var search = el('div');
      search.id = 'chat-people-search';
      var label = el('label', 'sui-input-text');
      label.setAttribute('for', 'chat-people-query');
      var input = el('input');
      input.type = 'text';
      input.id = 'chat-people-query';
      input.name = 'chat-people-query';
      input.placeholder = 'Name or player id';
      input.autocomplete = 'off';
      input.value = S.peopleQuery || '';
      label.appendChild(input);
      search.appendChild(label);
      page.appendChild(search);

      var scroll = el('div', 'chat-scroll');
      if (S.peopleLoading) {
        scroll.appendChild(noticeBlock('Loading', 'Reading the galaxy directory.'));
      } else if (!S.people.length) {
        scroll.appendChild(noticeBlock(
          'Nobody found',
          S.peopleQuery
            ? 'No player matches “' + S.peopleQuery + '”.'
            : 'The directory is empty.'));
      } else {
        var table = el('div', 'sui-result-table');
        var list = el('div', 'sui-result-rows');
        S.people.forEach(function (p) { list.appendChild(personRow(p)); });
        table.appendChild(list);
        scroll.appendChild(table);
      }
      page.appendChild(scroll);

      // Debounced so typing does not fire a lookup per keystroke.
      input.addEventListener('input', function () {
        S.peopleQuery = input.value;
        if (peopleTimer) clearTimeout(peopleTimer);
        peopleTimer = setTimeout(loadPeople, 200);
      });
      return page;
    }

    var peopleTimer = null;

    function loadPeople() {
      peopleTimer = null;
      S.peopleLoading = true;
      return invoke('matrix_people', { guildId: S.guildId, query: S.peopleQuery || null })
        .then(function (res) {
          S.people = (res && res.people) || [];
          S.peopleLoading = false;
          // render() carries the draft and the caret across for us.
          if (S.view === 'people') render();
        })
        .catch(function (e) {
          S.peopleLoading = false;
          S.people = [];
          showError(String(e));
        });
    }

    function startDm(playerId, body) {
      return invoke('matrix_dm', { guildId: S.guildId, playerId: playerId })
        .then(function (res) {
          return refreshRooms().then(function () {
            if (!res || !res.room_id) return;
            var opened = openRoom(res.room_id);
            // `/msg bob hello` opens the conversation AND says hello, which is
            // what /msg has meant since IRC.
            if (!body) return opened;
            return opened.then(function () { sendMessage(body); });
          });
        })
        // A DM that cannot be addressed is a normal outcome (their guild runs no
        // comms server), so it belongs in the timeline, not on an error page.
        .catch(function (e) {
          if (S.view === 'room') say(String(e), true); else showError(String(e));
        });
    }
    Chat.startDm = startDm;

    return {
      renderMembers: renderMembers, memberRow: memberRow, loadMembers: loadMembers,
      browseOrder: browseOrder, renderBrowse: renderBrowse, loadBrowse: loadBrowse,
      personRow: personRow, renderPeople: renderPeople, loadPeople: loadPeople, startDm: startDm,
    };
  };
})();
