// Comms — the nav slot: the conversations you have open, where the game
// puts its menu sections.
//
// A tab is a VIEW, not a membership: closing one puts the conversation away,
// it does not leave the room. Leaving is `/leave`, and it should stay that
// way — a stray click on an × must never remove you from a channel.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chattabs.test.mjs can drive it with no window boot:
//
//   window.ChatTabs({ el, icon, byId, clear, render, openRoom, go, activeNetwork, S, Chat })
//     → { MAX_TABS, openTab, closeTab, tabLabel, unreadFor, renderNav }
(function () {
  'use strict';
  window.ChatTabs = function (ctx) {
    var el = ctx.el, icon = ctx.icon, byId = ctx.byId, clear = ctx.clear, render = ctx.render;
    var openRoom = ctx.openRoom, go = ctx.go, activeNetwork = ctx.activeNetwork, S = ctx.S, Chat = ctx.Chat || {};

    // Left slot = the networks this player can reach. In the game this slot
    // holds the menu's sections; here it answers the same "where am I" question
    // for a federated client that can be on more than one homeserver.
    // ── Tabs ──────────────────────────────────────────────────────────────────
    // The conversations you have open, in the slot the game uses for its menu
    // sections. It replaces the network name, which was a single inert word
    // once only your own guild could be signed into.
    //
    // A tab is a VIEW, not a membership: closing one puts the conversation away,
    // it does not leave the room. Leaving is `/leave`, and it should stay that
    // way — a stray click on an × must never remove you from a channel.
    var MAX_TABS = 8;

    function openTab(roomId) {
      if (!roomId) return;
      if (S.tabs.indexOf(roomId) === -1) S.tabs.push(roomId);
      // Bounded: a long session opening every room would otherwise turn the
      // strip into a scrollbar. Oldest tab goes first — but never the one being
      // opened, and never the room currently on screen, which would leave the
      // strip disagreeing with the view.
      while (S.tabs.length > MAX_TABS) {
        var victim = null;
        for (var i = 0; i < S.tabs.length; i++) {
          if (S.tabs[i] !== roomId && S.tabs[i] !== S.roomId) { victim = S.tabs[i]; break; }
        }
        if (!victim) break;                 // everything left is in use
        S.tabs.splice(S.tabs.indexOf(victim), 1);
      }
    }
    Chat.openTab = openTab;

    function closeTab(roomId) {
      var at = S.tabs.indexOf(roomId);
      if (at === -1) return;
      S.tabs.splice(at, 1);
      if (S.roomId !== roomId) { render(); return; }
      // Closing the one you are looking at hands you the neighbour, the way
      // every tabbed thing does — falling back to the channel list.
      var next = S.tabs[at] || S.tabs[at - 1];
      if (next) openRoom(next); else go('channels');
    }
    Chat.closeTab = closeTab;

    function tabLabel(roomId) {
      for (var i = 0; i < S.rooms.length; i++) {
        if (S.rooms[i].room_id === roomId) return S.rooms[i].name || roomId;
      }
      if (S.roomId === roomId && S.room) return S.room.name || roomId;
      return roomId;
    }

    function unreadFor(roomId) {
      for (var i = 0; i < S.rooms.length; i++) {
        if (S.rooms[i].room_id === roomId) return S.rooms[i];
      }
      return null;
    }

    function renderNav() {
      var box = byId('menu-page-nav-items');
      if (!box) return;
      clear(box);

      if (!S.tabs.length) {
        // Nothing open yet: name the network, as the slot did before.
        var net = activeNetwork();
        box.appendChild(el('a', 'sui-screen-nav-item sui-mod-active',
          (net && (net.tag || net.guild_name)) || 'COMMS'));
      } else {
        S.tabs.forEach(function (roomId) {
          var active = S.view === 'room' && S.roomId === roomId;
          var a = el('a', 'sui-screen-nav-item chat-tab' + (active ? ' sui-mod-active' : ''));
          a.href = 'javascript:void(0)';
          a.title = tabLabel(roomId);

          var room = unreadFor(roomId);
          if (room && room.unread) {
            // A dot, not a count: the strip is for switching, and the number is
            // already on the row in the channel list.
            a.appendChild(el('span',
              'chat-tab-dot' + (room.mention ? ' chat-mod-mention' : '')));
          }
          a.appendChild(el('span', 'chat-tab-label', tabLabel(roomId)));

          var x = el('span', 'chat-tab-close');
          x.title = 'Close';
          x.appendChild(icon('icon-close', 'sui-icon-sm'));
          x.addEventListener('click', function (ev) {
            // Without this the tab underneath would also fire and re-open what
            // was just closed.
            ev.stopPropagation();
            closeTab(roomId);
          });
          a.appendChild(x);

          a.addEventListener('click', function () { openRoom(roomId); });
          box.appendChild(a);
        });
      }

      var comms = byId('chat-nav-comms');
      var settings = byId('chat-nav-settings');
      if (comms) comms.className = (S.view === 'channels' || S.view === 'room') ? 'sui-mod-active' : '';
      if (settings) settings.className = S.view === 'connection' ? 'sui-mod-active' : '';
    }

    return { MAX_TABS: MAX_TABS, openTab: openTab, closeTab: closeTab, tabLabel: tabLabel, unreadFor: unreadFor, renderNav: renderNav };
  };
})();
