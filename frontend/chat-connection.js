// Comms — the Connection page. The sign-in chain has six hops across three
// services; when it breaks, the useful question is WHICH hop, so the ladder
// is the primary UI here, not a spinner. Also identity, and whether this
// player shares what they are doing.
//
// Extracted from chat.js (2026-09-06). Collaborators arrive as a context so
// scripts/harness-tests/chatconnection.test.mjs can drive it with a stub
// `invoke` and no window boot:
//
//   window.ChatConnection({ el, icon, invoke, go, pageHeader, headerResources, noticeBlock,
//                           render, showError, activeNetwork, connect, reconnect, S, Chat })
//     → { STEP_ICON, stepRow, kv, statusSharingRow, setStatusSharing, renderConnection }
(function () {
  'use strict';
  window.ChatConnection = function (ctx) {
    var el = ctx.el, icon = ctx.icon, invoke = ctx.invoke, go = ctx.go;
    var pageHeader = ctx.pageHeader, headerResources = ctx.headerResources, noticeBlock = ctx.noticeBlock;
    var render = ctx.render, showError = ctx.showError, activeNetwork = ctx.activeNetwork;
    var connect = ctx.connect, reconnect = ctx.reconnect, S = ctx.S, Chat = ctx.Chat || {};

    // The sign-in chain has six hops across three services. When it breaks, the
    // useful question is WHICH hop — so the ladder is the primary UI here, not a
    // spinner.
    var STEP_ICON = {
      done: 'icon-success', active: 'icon-in-progress',
      failed: 'icon-alert', todo: 'icon-unknown',
    };
    function stepRow(st) {
      var row = el('div', 'chat-step chat-mod-' + (st.state || 'todo'));
      var mark = el('div', 'chat-step-state');
      mark.appendChild(icon(STEP_ICON[st.state] || STEP_ICON.todo, 'sui-icon-sm'));
      row.appendChild(mark);
      var text = el('div');
      text.appendChild(el('div', 'chat-step-label', st.label));
      if (st.detail) text.appendChild(el('div', 'chat-step-detail sui-text-tiny', st.detail));
      row.appendChild(text);
      return row;
    }

    function kv(k, v) {
      var row = el('div', 'chat-kv');
      row.appendChild(el('div', null, k));
      row.appendChild(el('div', null, v == null ? '—' : String(v)));
      return row;
    }

    function statusSharingRow() {
      var row = el('div', 'sui-data-card-row');
      row.appendChild(el('span', 'sui-text-hint', 'Activity'));
      var val = el('span', 'chat-status-share');
      val.appendChild(el('span', null, S.sharingStatus
        ? (S.myStatus || 'Shared')
        : 'Not shared'));
      var a = el('a', 'chat-ref-action');
      a.href = 'javascript:void(0)';
      a.appendChild(el('span', null, S.sharingStatus ? 'Stop sharing' : 'Share'));
      a.title = S.sharingStatus
        ? 'Stop telling other players what you are doing'
        : 'Tell other players roughly what you are doing — including when your '
          + 'fleet is away, which says your planet may be undefended';
      a.addEventListener('click', function () { setStatusSharing(!S.sharingStatus); });
      val.appendChild(a);
      row.appendChild(val);
      return row;
    }

    function setStatusSharing(on) {
      return invoke('matrix_status_sharing', { guildId: S.guildId, enabled: on })
        .then(function (res) {
          S.sharingStatus = !!(res && res.enabled);
          S.myStatus = (res && res.status) || null;
          render();
        })
        .catch(function (e) { showError(String(e)); });
    }
    Chat.setStatusSharing = setStatusSharing;

    function renderConnection() {
      var page = el('div', 'chat-page');
      page.appendChild(pageHeader('Connection', function () { go('channels'); }, headerResources()));

      var scroll = el('div', 'chat-scroll');
      var net = activeNetwork();

      // Nothing is known until the first status reply lands, and "nothing known"
      // is not the same as "nothing there". Reporting no comms server before
      // asking made every launch flash a failure it had no evidence for.
      if (!S.started) {
        scroll.appendChild(noticeBlock('Connecting', 'Reaching your guild’s comms server.'));
        page.appendChild(scroll);
        return page;
      }

      if (!S.networks.length) {
        scroll.appendChild(noticeBlock(
          'No comms server',
          'No guild you can reach publishes a matrix service in its guild.json. ' +
          'Nothing to connect to yet.'));
        page.appendChild(scroll);
        return page;
      }

      // Identity
      var idCard = el('div', 'sui-data-card');
      idCard.appendChild(el('div', 'sui-data-card-header sui-text-header', 'Identity'));
      var idBody = el('div', 'sui-data-card-body');
      // The network is a guild: the shared chip, not a bare name.
      var netRow = el('div', 'chat-kv');
      netRow.appendChild(el('div', null, 'Network'));
      var netVal = el('div');
      if (net && window.StructsGuildCard) {
        netVal.appendChild(window.StructsGuildCard.chip({
          id: net.guild_id, name: net.guild_name || null, tag: net.tag || null, logo: net.logo || null,
        }));
      } else {
        netVal.textContent = '—';
      }
      netRow.appendChild(netVal);
      idBody.appendChild(netRow);
      idBody.appendChild(kv('Homeserver', net ? net.homeserver : '—'));
      idBody.appendChild(kv('Matrix ID', S.profile ? S.profile.user_id : (net && net.user_id) || '—'));
      idBody.appendChild(kv('Player', S.profile ? S.profile.display_name : '—'));
      // Whether other clients can see this player's face. It renders correctly
      // in here whatever the answer, so this is the only place the difference
      // is visible at all — it was a tooltip on the composer portrait and
      // nowhere else.
      if (S.profile) {
        idBody.appendChild(kv('Portrait',
          S.profile.avatar_published ? 'Published' : 'Not published yet'));
      }
      // What this player tells everyone else about themselves. Off unless
      // asked for, and the row says exactly what turning it on would reveal —
      // this is a game about raiding each other, and "fleet away" tells a
      // rival your planet may be undefended.
      idBody.appendChild(statusSharingRow());
      idCard.appendChild(idBody);
      scroll.appendChild(idCard);

      // Ladder
      if (S.steps.length) {
        var stepCard = el('div', 'sui-data-card');
        stepCard.appendChild(el('div', 'sui-data-card-header sui-text-header', 'Sign-in'));
        var stepBody = el('div', 'sui-data-card-body');
        S.steps.forEach(function (st) { stepBody.appendChild(stepRow(st)); });
        stepCard.appendChild(stepBody);
        scroll.appendChild(stepCard);
      }

      if (S.error) {
        scroll.appendChild(noticeBlock('Not connected', S.error, true));
      }

      // No Connect button and no Sign out. Signing in needs nothing from the
      // player — the credential is the key they are already playing with — so
      // asking would be a question with one sensible answer. Signing out would
      // only strand them somewhere they cannot chat from.
      //
      // Reconnect is a different thing and does belong here. A session can go
      // bad while still reporting itself signed in — a homeserver that has
      // forgotten the token, a sync loop that has stopped answering — and the
      // window then has no failure to retry, so "Try again" never appears and
      // the player is stuck being told everything is fine. This drops the
      // session and immediately takes another, which is the actual fix for
      // that state and never leaves them signed out.
      var connected = !!(net && net.logged_in);
      var actions = el('div', 'sui-screen-btn-flex-wrapper');
      if (!connected && !S.connecting) {
        var btn = el('button', 'sui-screen-btn sui-mod-primary');
        btn.id = 'chat-retry';
        btn.textContent = 'Try again';
        btn.addEventListener('click', function () { connect(); });
        actions.appendChild(btn);
      } else if (connected) {
        var again = el('button', 'sui-screen-btn');
        again.id = 'chat-reconnect';
        again.textContent = S.connecting ? 'Reconnecting…' : 'Reconnect';
        again.disabled = !!S.connecting;
        again.title = 'Drop this session and take a fresh one';
        again.addEventListener('click', function () { reconnect(); });
        actions.appendChild(again);
      }
      if (actions.childNodes.length) scroll.appendChild(actions);

      page.appendChild(scroll);
      return page;
    }

    return {
      STEP_ICON: STEP_ICON, stepRow: stepRow, kv: kv, statusSharingRow: statusSharingRow,
      setStatusSharing: setStatusSharing, renderConnection: renderConnection,
    };
  };
})();
