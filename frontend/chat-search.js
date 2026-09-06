// Comms — search: the homeserver does the searching; this page asks it on
// Enter, scoped to one conversation or everywhere, and shows each hit as the
// message it is under the room it was in.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatsearch.test.mjs can drive it with a stub `invoke`
// and no window boot:
//
//   window.ChatSearch({ el, icon, invoke, go, pageHeader, noticeBlock, unreadFor,
//                       messageNode, openRoom, render, showError, S, Chat })
//     → { renderSearch, runSearch, openSearch, roomNameOf, searchHit, searchScopeToggle }
(function () {
  'use strict';
  window.ChatSearch = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, go = ctx.go;
    var pageHeader = ctx.pageHeader, noticeBlock = ctx.noticeBlock, unreadFor = ctx.unreadFor;
    var messageNode = ctx.messageNode, openRoom = ctx.openRoom, render = ctx.render;
    var showError = ctx.showError, S = ctx.S, Chat = ctx.Chat || {};

    // The homeserver does the searching. This window keeps a few hundred
    // messages of one room, and the thing worth finding is almost never in that
    // window — see `client::search`.
    function renderSearch() {
      var page = el('div', 'chat-page');
      var scope = S.searchRoom ? roomNameOf(S.searchRoom) : 'Everywhere';
      page.appendChild(pageHeader('Search · ' + scope, function () {
        if (S.roomId) { S.view = 'room'; render(); } else { go('channels'); }
      }, searchScopeToggle()));

      var box = el('div');
      box.id = 'chat-search-box';
      var label = el('label', 'sui-input-text');
      label.setAttribute('for', 'chat-search-query');
      var input = el('input');
      input.type = 'text';
      input.id = 'chat-search-query';
      input.name = 'chat-search-query';
      input.placeholder = 'What was said';
      input.autocomplete = 'off';
      input.value = S.searchQuery || '';
      // On Enter, not on every keystroke. A search is a round trip to the
      // homeserver over the whole history of every room — typing "raid" would
      // fire four of them, and the first three answer a question nobody asked.
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); runSearch(input.value); }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (S.roomId) { S.view = 'room'; render(); } else { go('channels'); }
        }
      });
      label.appendChild(input);
      box.appendChild(label);
      page.appendChild(box);

      var scroll = el('div', 'chat-scroll');
      if (S.searchLoading) {
        scroll.appendChild(noticeBlock('Searching', 'Asking the homeserver.'));
      } else if (!S.searchRan) {
        scroll.appendChild(noticeBlock('Search',
          S.searchRoom
            ? 'Looking in this conversation. Press Enter to search.'
            : 'Looking everywhere you are joined. Press Enter to search.'));
      } else if (!S.searchHits.length) {
        scroll.appendChild(noticeBlock('Nothing found',
          'No message matching ' + JSON.stringify(S.searchQuery) + '.'));
      } else {
        S.searchHits.forEach(function (h) { scroll.appendChild(searchHit(h)); });
      }
      page.appendChild(scroll);
      return page;
    }

    // Two scopes, one control: this conversation, or everywhere. Only offered
    // when there IS a conversation to be narrower than.
    function searchScopeToggle() {
      if (!S.roomId) return null;
      var wrap = el('div', 'chat-header-actions');
      var a = el('a', 'sui-nav-btn');
      a.href = 'javascript:void(0)';
      a.title = S.searchRoom ? 'Search everywhere instead' : 'Search only this conversation';
      a.appendChild(icon((S.searchRoom ? 'icon-guild-directory' : 'icon-guild') +
        ' sui-text-secondary'));
      a.addEventListener('click', function () {
        S.searchRoom = S.searchRoom ? null : S.roomId;
        if (S.searchQuery) runSearch(S.searchQuery); else render();
      });
      wrap.appendChild(a);
      return wrap;
    }

    function roomNameOf(roomId) {
      var r = unreadFor(roomId);
      return (r && (r.name || r.canonical_alias)) || roomId;
    }

    // A hit reads as the message it is, with the room it was in above it — the
    // room is the part you cannot infer, and it is what makes a hit worth
    // clicking.
    function searchHit(h) {
      var wrap = el('div', 'chat-search-hit');
      var head = el('a', 'chat-search-hit-room');
      head.href = 'javascript:void(0)';
      // No icon. The room name is already the whole of what this line says, and
      // the guild glyph at this size is a mark the eye has to decode for nothing.
      head.appendChild(el('span', null, h.room_name || h.room_id));
      head.addEventListener('click', function () { openRoom(h.room_id); });
      wrap.appendChild(head);
      wrap.appendChild(messageNode(h.message));
      return wrap;
    }

    function runSearch(query) {
      S.searchQuery = query;
      if (!String(query || '').trim()) { S.searchRan = false; S.searchHits = []; render(); return; }
      S.searchLoading = true;
      S.searchRan = true;
      render();
      var args = { guildId: S.guildId, query: query };
      if (S.searchRoom) args.roomId = S.searchRoom;
      return invoke('matrix_search', args)
        .then(function (res) {
          // A slow answer to an old question must not paint over a newer one.
          // Compared against the CURRENT query, not against the one this call
          // asked — that always matches, which is no guard at all.
          if (String(query).trim() !== String(S.searchQuery).trim()) return;
          S.searchHits = (res && res.hits) || [];
          S.searchLoading = false;
          render();
        })
        .catch(function (e) {
          S.searchLoading = false;
          S.searchHits = [];
          render();
          showError(String(e));
        });
    }
    Chat.runSearch = runSearch;

    // Open search, scoped to wherever the player is standing.
    function openSearch(scoped) {
      S.searchRoom = scoped && S.roomId ? S.roomId : null;
      S.searchRan = false;
      S.searchHits = [];
      go('search');
    }
    Chat.openSearch = openSearch;

    return {
      renderSearch: renderSearch, runSearch: runSearch, openSearch: openSearch,
      roomNameOf: roomNameOf, searchHit: searchHit, searchScopeToggle: searchScopeToggle,
    };
  };
})();
