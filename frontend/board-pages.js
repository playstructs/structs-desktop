// Team Ops Command Center — page renderers: ARMADA / ENERGY / WORK /
// INVENTORY / TX / GRASS / WAR / CONFIG / DIAGNOSTICS / MAP. Core runtime
// (router, scheduler, helpers, feed, agent-UI, OPS) is in board.js, which
// loads first, owns the AREAS manifest and exposes window.Board.
//
// Root-level file on purpose: scripts/sync.sh deletes frontend/js/ but
// preserves root files.
(function () {
  'use strict';
  var Board = window.Board;
  var H = Board.helpers;
  // Quantities follow the game's own unit ladders — the strings here are the
  // strings the HUD prints. `alpha` takes RAW ualpha, `ore` raw grams, `kw`
  // raw milliwatts; none of them take a pre-divided number.
  var kw = function (mw) { return H.fmtWatts(mw); };
  var alpha = function (ualpha) { return H.fmtAlpha(ualpha); };
  var ore = function (g) { return H.fmtOre(g); };

  // A compact stat tile: the value (optionally + a sui-icon) over a small
  // uppercase caption. Used in the right-hand section of an Armada row so each
  // number reads with its label instead of a bare icon.
  var statTile = H.statTile;

  // ═══════════════════════════ ARMADA ══════════════════════════════════════
  var armada = {
    rows: [],
    refreshedAt: 0,
    sort: { key: 'index', dir: 1 },
    selection: {},          // player_id -> true
    lastSweepPlan: null,    // ambient dry-run result (echoed on execute)
    jobRunning: false,
    built: false,
  };

  // A row wants a human when we could not READ it, or when the roster sweep
  // has not reached it in a long time — both mean the numbers beside it are not
  // to be trusted.
  //
  // It used to also fire on `charge >= 24` — twenty-four blocks is about two
  // minutes, which every bait player exceeds by design (banking charge is their
  // whole job). That flagged ~1,800 of 1,822 rows, so the "attention" filter
  // selected the entire roster and meant nothing.
  var ROSTER_STALE_MS = 15 * 60 * 1000;
  function armadaAttention(r) {
    return !!r.err || (Date.now() - (r.fetched_at_ms || 0)) > ROSTER_STALE_MS;
  }

  var ARMADA_SORT_KEYS = [
    { key: 'index', label: 'index' }, { key: 'name', label: 'name' },
    { key: 'charge', label: 'charge' }, { key: 'alpha', label: 'alpha' },
    { key: 'ore', label: 'ore' }, { key: 'power', label: 'load' },
    { key: 'age', label: 'age' },
  ];
  var ARMADA_SORT_ACC = {
    index: function (r) { return r.index == null ? -1 : r.index; },
    name: function (r) { return r.name.toLowerCase(); },
    charge: function (r) { return r.charge; },
    alpha: function (r) { return r.alpha_ualpha; },
    ore: function (r) { return r.ore; },
    power: function (r) { return r.structs_load; },
    age: function (r) { return r.fetched_at_ms; },
  };

  function selCount() { return Object.keys(armada.selection).length; }

  function buildArmadaDom() {
    if (armada.built) return;
    armada.built = true;
    var body = document.getElementById('armada-body');
    body.innerHTML = '';

    // ── Toolbar: mass actions (one-click; ambient dry-run on the buttons) ──
    var actions = H.el('div', 'sui-screen-btn-flex-wrapper'); actions.id = 'armada-actions';
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center;';

    var sweepBtn = massBtn('sweep-btn', 'icon-send-alpha', 'Sweep…', 'sui-mod-primary');
    sweepBtn.addEventListener('click', function () { runSweep(); });
    actions.appendChild(sweepBtn);

    var roleApplySel = H.el('select', 'sui-input-text');
    [['productive', '→ productive'], ['bait', '→ bait'], ['raider', '→ raider']].forEach(function (o) {
      var op = H.el('option', null, o[1]); op.value = o[0]; roleApplySel.appendChild(op);
    });
    roleApplySel.id = 'role-apply-sel';
    var roleBtn = massBtn('role-btn', 'icon-edit', 'Set role', 'sui-mod-secondary');
    roleBtn.addEventListener('click', function () { runSetRole(roleApplySel.value); });
    actions.appendChild(roleApplySel); actions.appendChild(roleBtn);

    var scanSel = H.el('select', 'sui-input-text');
    ['harvest', 'build', 'defend', 'infuse', 'response', 'raid'].forEach(function (l) {
      var op = H.el('option', null, l); op.value = l; scanSel.appendChild(op);
    });
    scanSel.id = 'scan-sel';
    var scanBtn = massBtn('scan-btn', 'icon-refresh-12', 'Scan now', 'sui-mod-secondary');
    scanBtn.addEventListener('click', function () { runForceScan(scanSel.value); });
    actions.appendChild(scanSel); actions.appendChild(scanBtn);
    body.appendChild(actions);

    // ── Launch row ──
    var launch = H.el('div', null);
    launch.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center;font-size:12px;';
    var countIn = H.el('input'); countIn.type = 'number'; countIn.min = '1'; countIn.max = '50'; countIn.value = '1';
    countIn.style.cssText = 'width:64px;background:transparent;color:inherit;border:1px solid var(--border);'
      + 'padding:var(--spacing-xs) var(--spacing-md);';
    var launchRole = H.el('select', 'sui-input-text');
    // Every launchable role; auto_raid can only dispatch VPlayerRole::Raider,
    // so leaving raider out of this list silently caps the war machine.
    [['productive', 'productive'], ['bait', 'bait'], ['raider', 'raider']].forEach(function (o) {
      var op = H.el('option', null, o[1]); op.value = o[0]; launchRole.appendChild(op);
    });
    var launchBtn = massBtn('launch-btn', 'sui-icon-players', 'Launch', 'sui-mod-secondary');
    var launchHint = H.el('span', 'ops-muted'); launchHint.id = 'launch-hint';
    function launchPreview() {
      var n = parseInt(countIn.value, 10) || 1;
      Board.T.core.invoke('mcp_mass_action', { request: {
        action: 'launch_players', mode: 'dry_run',
        args: { count: n, role: launchRole.value },
      }}).then(function (r) {
        launchHint.textContent = 'per-conn ' + kw(r.per_connection_now_mw) + ' → ' +
          kw(r.per_connection_after_mw) + ' after +' + r.count +
          (r.power_ok ? '' : '  ⛔ below minimum draw');
        launchBtn.classList.toggle('sui-mod-disabled', !r.power_ok || armada.jobRunning);
      }).catch(function (e) { launchHint.textContent = String(e); });
    }
    countIn.addEventListener('input', launchPreview);
    launchRole.addEventListener('change', launchPreview);
    launchBtn.addEventListener('click', function () {
      var n = parseInt(countIn.value, 10) || 1;
      runMass({ action: 'launch_players', mode: 'execute', args: { count: n, role: launchRole.value } },
        'Launching ' + n + ' ' + launchRole.value + '…');
    });
    launch.appendChild(document.createTextNode('Launch '));
    launch.appendChild(countIn);
    launch.appendChild(launchRole);
    launch.appendChild(launchBtn);
    launch.appendChild(launchHint);
    body.appendChild(launch);
    setTimeout(launchPreview, 500);

    // ── Progress bar (mass jobs + roster sweeps) ──
    var prog = H.el('div', null); prog.id = 'mass-progress'; prog.hidden = true;
    prog.appendChild(H.el('div', 'ops-muted', '')); prog.appendChild(H.progressBar(0));
    body.appendChild(prog);

    // ── The roster itself: filtered, sorted, paginated, incrementally
    //    updated. At 459 players a full rebuild was ~22k DOM nodes per tick
    //    and ate whatever you were typing; listView keeps one page live. ──
    var extras = H.el('div', 'listview-toolbar');

    var allLbl = H.el('label', 'listview-toggle');
    var allCb = H.checkbox(false, null, function (on) {
      // "Shown" means everything matching the filters, not just this page —
      // paging is a viewport, not a change of what you selected.
      armada.lv.visible().forEach(function (r) {
        if (r.index == null) return;               // primary is never a target
        if (on) armada.selection[r.player_id] = true;
        else delete armada.selection[r.player_id];
      });
      renderArmadaRows();
    });
    allLbl.appendChild(allCb);
    allLbl.appendChild(H.el('span', null, 'select all shown'));
    extras.appendChild(allLbl);

    var selInfo = H.el('span', 'ops-muted'); selInfo.id = 'armada-selinfo';
    extras.appendChild(selInfo);

    var refreshBtn = H.el('a', 'ops-refresh-btn', 'Refresh roster');
    refreshBtn.href = 'javascript:void(0)';
    refreshBtn.addEventListener('click', function () {
      Board.T.core.invoke('mcp_roster_refresh').catch(function () {});
    });
    extras.appendChild(refreshBtn);

    armada.lv = H.listView({
      key: function (r) { return r.player_id; },
      // Selection and freshness are part of what a row DRAWS, so they belong
      // in the change signature or a toggled checkbox wouldn't repaint.
      sig: function (r) {
        return [r.name, r.role, r.charge, r.alpha_ualpha, r.ore, r.planet_ore,
          r.mine_eta_s, r.refine_eta_s, r.err, r.pfp_attrs,
          armada.selection[r.player_id] ? 1 : 0].join('|');
      },
      render: armadaRow,
      pageSize: 60,
      filters: [
        { key: 'q', type: 'text', placeholder: 'filter name / id / planet' },
        { key: 'role', type: 'select', options: [
          { value: '', label: 'all roles' }, 'productive', 'bait', 'raider', 'primary' ] },
        { key: 'attn', type: 'toggle', label: 'attention' },
      ],
      filterFn: function (r, v) {
        if (v.role && r.role !== v.role) return false;
        if (v.attn && !armadaAttention(r)) return false;
        if (v.q) {
          var hay = (r.name + ' ' + r.player_id + ' ' + (r.planet_id || '')).toLowerCase();
          if (hay.indexOf(String(v.q).toLowerCase()) < 0) return false;
        }
        return true;
      },
      sortKeys: ARMADA_SORT_KEYS,
      sortAccessors: ARMADA_SORT_ACC,
      sort: armada.sort,
      toolbarExtra: extras,
      empty: 'no players match these filters',
      onCounts: function () { updateArmadaChrome(); },
    });
    body.appendChild(armada.lv.node);
  }

  function massBtn(id, iconCls, label, mod) {
    var b = H.el('a', 'sui-screen-btn mass-btn ' + (mod || 'sui-mod-secondary'));
    b.id = id; b.href = 'javascript:void(0)';
    var i = H.el('i', iconCls.indexOf('sui-icon-') === 0 ? 'sui-icon ' + iconCls + ' sui-icon-sm' : iconCls);
    var sp = H.el('span', null, ' ' + label);
    b.appendChild(i); b.appendChild(sp);
    return b;
  }

  // "~7m" / "1.2h" / "now" — the tightest honest ETA text.
  /* An ETA on the shared ladder.
   *
   * `null` in, `null` out — the harvest line OMITS a piece it has no number
   * for rather than printing a placeholder, so a dash here would put "—" into
   * a row designed around absence being silent.
   *
   * It had no seconds rung of its own, which rounded every cycle under a
   * minute up to "1m": a five-second extraction reported as sixty.
   */
  function fmtEta(s) {
    return H.duration(s, { empty: null, zero: 'now' });
  }

  // Icons-only harvest line: [buried ore] N · [mine] eta · [refine] eta.
  // Null fields (no planet read yet / no such struct / idle cycle) are simply
  // omitted — absence IS the signal, no placeholder words.
  function harvestTrio(r) {
    var parts = [];
    function piece(iconCls, text, title) {
      var s = H.el('span', 'htrio');
      s.title = title;
      s.appendChild(H.el('i', iconCls));
      s.appendChild(document.createTextNode(' ' + text));
      return s;
    }
    if (r.planet_ore != null) {
      parts.push(piece('icon-undiscovered-ore', ore(r.planet_ore), 'ore left on planet'));
    }
    var m = fmtEta(r.mine_eta_s);
    if (m) parts.push(piece('icon-mine', m, 'next extraction ~'));
    var f = fmtEta(r.refine_eta_s);
    if (f) parts.push(piece('icon-refine', f, 'next refine ~'));
    if (!parts.length) return null;
    var line = H.el('span', 'htrio-line');
    parts.forEach(function (p, i) {
      if (i) line.appendChild(document.createTextNode('  '));
      line.appendChild(p);
    });
    return line;
  }

  // Push the current roster at the list; it decides what actually changed.
  function renderArmadaRows() {
    if (!armada.lv) return;
    armada.lv.setRows(armada.rows);
  }

  // One roster row. Pure: given a row it returns a node, so listView can cache
  // and reuse it until that row's data (or its selected state) changes.
  /// The two spectator entry points on a roster row: this player's planet and
  /// the fleet they command. Each opens a live window on that location — the
  /// same renderer War · Live Raids uses — so "show me what this player is
  /// looking at" is one click from the list they are already reading.
  ///
  /// A player with no planet or no fleet simply gets fewer buttons rather than
  /// a dead one; both ids come straight off the roster row.
  // The spectator opens a native OS window, so it exists only in the desktop
  // console. On the web copy it would open on the HOST's screen — `web_board`
  // refuses the call for exactly that reason, and offering a control whose only
  // outcome is that refusal is worse than not offering it.
  function canSpectate() { return !window.__BOARD_WEB__; }

  // Talk to this player. Every player id in the app is a working address —
  // their Matrix id is that id at their guild's homeserver — so anywhere a
  // player is listed can also be a way to reach them.
  //
  // Deliberately quiet: it fails in place on the icon rather than throwing a
  // dialogue, because Comms may simply not be signed in yet.
  // ── Who is actually here ──────────────────────────────────────────────────
  // The same signal Comms shows, on the roster that lists the same people.
  // A guild's roster answers "who exists"; this answers "who is around", and
  // those are different questions with the same rows.
  var PRESENCE = { known: false, by: {} };

  function loadPresence() {
    if (!Board.T || !Board.T.core) return Promise.resolve();
    return Board.T.core.invoke('matrix_presence', {})
      .then(function (res) {
        PRESENCE = { known: !!(res && res.known), by: (res && res.presence) || {} };
      })
      // Comms not signed in, or no homeserver: the roster is still a roster.
      .catch(function () { PRESENCE = { known: false, by: {} }; });
  }
  Board.loadPresence = loadPresence;

  function presenceDot(playerId) {
    // Nothing at all when the homeserver does not run presence. A column of
    // grey dots implying an empty guild is worse than no column.
    if (!PRESENCE.known || !playerId) return null;
    var p = PRESENCE.by[playerId];
    if (!p) return null;
    var cls = p.state === 'online' ? 'ops-mod-online'
      : p.state === 'unavailable' ? 'ops-mod-idle' : 'ops-mod-away';
    var dot = H.el('span', 'ops-presence ' + cls);
    dot.title = p.state === 'online' ? 'Online in Comms'
      : p.state === 'unavailable' ? 'Idle' : 'Away';
    return dot;
  }
  Board.presenceDot = presenceDot;

  // Any page listing players wants this, not only the roster — Game Stats is
  // a different window's worth of the same people.
  Board.ensurePresence = function (then) {
    if (PRESENCE.known) { if (then) then(); return Promise.resolve(); }
    return loadPresence().then(function () { if (then) then(); });
  };

  // Message a player, or talk about them — the pair of social affordances,
  // shared so every list of people in this app offers the same two.
  //
  // Returns nothing when there is nobody to reach: a row for a guild, or for
  // yourself, has no use for either.
  function reachLinks(r) {
    if (!r || !r.player_id) return null;
    var wrap = H.el('span', 'ops-reach');
    var msg = messageLink(r);
    var share = shareLink(r);
    if (msg) wrap.appendChild(msg);
    if (share) wrap.appendChild(share);
    return wrap.childNodes.length ? wrap : null;
  }
  Board.reachLinks = reachLinks;

  // A click that fails has to LOOK like it failed.
  //
  // These used to put the reason in a `title` and nothing else, so pressing
  // message with Comms signed out did nothing a player could see — the most
  // common case for anyone who has not connected yet. The glyph changes, so
  // the click visibly landed, and the reason is there for whoever hovers.
  function reachFailed(anchor, verb, r, err) {
    anchor.classList.add('err');
    anchor.title = 'could not ' + verb + ' ' + (r.name || r.player_id) + ': ' + err;
    var icon = anchor.querySelector('i');
    if (icon) icon.className = 'sui-icon-md icon-alert';
  }

  /* Open a Comms window that speaks AS this player.
   *
   * Only on the Armada roster, and only for players that are not the primary:
   * every row there is one of OUR players, each a real account on chain with
   * its own authority to talk, and the Matrix localpart IS the player id — so
   * `1-271` already has an identity on the guild's homeserver. The primary
   * gets no icon because its window is the ordinary Comms window, already one
   * click away.
   *
   * Deliberately NOT added to `reachLinks`, which the leaderboards also use:
   * those list the whole galaxy, and this must never appear beside a player
   * whose keys we do not hold.
   */
  function speakAsLink(r) {
    if (!r || !r.player_id || r.role === 'primary') return null;
    var a = H.el('a', 'ops-refresh-btn');
    a.href = 'javascript:void(0)';
    a.title = 'Open Comms as ' + (r.player_name || r.player_id);
    a.appendChild(H.el('i', 'sui-icon-md icon-member'));
    a.addEventListener('click', function (e) {
      e.stopPropagation();
      Board.T.core.invoke('matrix_open_as', { playerId: r.player_id })
        .catch(function (err) { reachFailed(a, 'open Comms as', r, err); });
    });
    return a;
  }

  function messageLink(r) {
    if (!r || !r.player_id) return null;
    var a = H.el('a', 'ops-refresh-btn');
    a.href = 'javascript:void(0)';
    a.title = 'Message ' + (r.player_name || r.player_id);
    a.appendChild(H.el('i', 'sui-icon-md icon-phone'));
    a.addEventListener('click', function (e) {
      // The row itself opens the detail drawer; this must not also do that
      // behind the Comms window.
      e.stopPropagation();
      Board.T.core.invoke('matrix_message_player', { playerId: r.player_id })
        .catch(function (err) { reachFailed(a, 'message', r, err); });
    });
    return a;
  }

  // Talk ABOUT a player rather than TO them. `messageLink` opens a DM;
  // this hands the id to whatever conversation the player picks, where it
  // renders as a card. Two different verbs, so two different controls.
  function shareLink(r) {
    if (!r || !r.player_id) return null;
    var a = H.el('a', 'ops-refresh-btn');
    a.href = 'javascript:void(0)';
    a.title = 'Share ' + (r.player_name || r.player_id) + ' in Comms';
    a.appendChild(H.el('i', 'sui-icon-md icon-outgoing'));
    a.addEventListener('click', function (e) {
      e.stopPropagation();
      Board.T.core.invoke('matrix_share', { text: r.player_id })
        .catch(function (err) { reachFailed(a, 'share', r, err); });
    });
    return a;
  }

  function spectatorLinks(r) {
    if (!canSpectate()) return null;
    var wrap = H.el('span', 'ops-spectate');
    [
      { id: r.planet_id, icon: 'icon-planet', what: 'planet', arg: 'planet_id' },
      { id: r.fleet_id, icon: 'icon-fleet-tile', what: 'fleet', arg: 'fleet_id' }
    ].forEach(function (t) {
      if (!t.id) return;
      var a = H.el('a', 'ops-refresh-btn');
      a.href = 'javascript:void(0)';
      a.title = 'Watch ' + t.what + ' ' + t.id;
      a.appendChild(H.el('i', 'sui-icon-md ' + t.icon));
      a.addEventListener('click', function (e) {
        // The row itself opens the detail modal; a spectator link must not
        // also do that behind the new window.
        e.stopPropagation();
        var opts = {};
        opts[t.arg] = t.id;
        openSpectatorWindow(opts).catch(function (err) {
          a.classList.add('err');
          a.title = 'could not open the ' + t.what + ' window: ' + err;
        });
      });
      wrap.appendChild(a);
    });
    return wrap.childNodes.length ? wrap : null;
  }

  function armadaRow(r) {
    return (function () {
      // Checkbox (vplayers only; primary is never a mass-action target).
      var lead = null;
      if (r.index != null) {
        lead = H.checkbox(!!armada.selection[r.player_id], null, function (on) {
          if (on) armada.selection[r.player_id] = true;
          else delete armada.selection[r.player_id];
          updateArmadaChrome();
        });
      }
      // Title: name + role badge (the avatar frame already signals role, the
      // badge names it in words).
      var title = H.el('span', r.err ? 'err' : null);
      // Before the name, the way Comms does it: whether this player is
      // actually around right now, not merely on the roster.
      var here = presenceDot(r.player_id);
      if (here) title.appendChild(here);
      title.appendChild(document.createTextNode(r.name + ' '));
      // Every role gets its own badge. `raider` used to fall through to BAIT
      // here as well as in the backend's role_str, so a player you had just
      // assigned to the war machine still read as bait in the roster.
      var ROLE_BADGE = {
        primary: ['PRIME', 'warning'], productive: ['PROD', 'solid'],
        raider: ['RAID', 'destructive'], bait: ['BAIT', 'default'],
      };
      var rb = ROLE_BADGE[r.role] || [String(r.role || '?').toUpperCase(), 'default'];
      title.appendChild(H.badge(rb[0], rb[1]));
      // Subtitle: PID (the native roster's identity line). Freshness is shown
      // only when a row needs attention, so the common case stays clean; the
      // rest (index, planet, last action) lives in the click-through detail.
      var sub = H.el('span');
      sub.appendChild(document.createTextNode('PID #' + r.player_id));
      if (armadaAttention(r)) {
        // `fetched_at_ms` is when WE last read this player, not when the player
        // last acted — labelling it "idle" said the opposite of what it meant.
        sub.appendChild(document.createTextNode(' · '));
        sub.appendChild(H.el('span', 'attn',
          r.err ? 'read failed' : 'last read ' + H.ago(r.fetched_at_ms) + ' ago'));
      }
      // Harvest trio — icons only, no words (tooltips explain): ore left on
      // the planet · time to next mine completion · time to next refine.
      var trio = harvestTrio(r);
      if (trio) { sub.appendChild(H.el('br')); sub.appendChild(trio); }
      // Watch this player's planet / fleet, and talk to them. On the subtitle
      // line rather than in the stat tiles: tiles are readings, these are
      // actions.
      var spectate = spectatorLinks(r);
      var message = messageLink(r);
      var speakAs = speakAsLink(r);
      var share = shareLink(r);
      if (spectate || message || speakAs || share) {
        if (!trio) sub.appendChild(H.el('br'));
        else sub.appendChild(document.createTextNode(' '));
        if (spectate) sub.appendChild(spectate);
        if (message) sub.appendChild(message);
        if (speakAs) sub.appendChild(speakAs);
        if (share) sub.appendChild(share);
      }
      // Charge: battery + a clear Ready/n so "what is this number" is answered.
      var chargeVal = H.el('span');
      chargeVal.appendChild(H.battery(Math.min(8, r.charge), 8));
      chargeVal.appendChild(document.createTextNode(' ' + (r.charge >= 8 ? 'Ready' : r.charge)));
      var row = H.resultRow({
        lead: lead,
        portrait: H.pfpPortrait(r.pfp_attrs),
        title: title,
        subtitle: sub,
        // Labeled stat tiles — value over a small uppercase caption, so every
        // number says what it is at a glance.
        chips: [
          statTile('Charge', chargeVal, null, r.charge >= 8 ? 'ok' : null),
          statTile('Alpha', alpha(r.alpha_ualpha), 'sui-icon-alpha-matter'),
          statTile('Ore', ore(r.ore), 'sui-icon-alpha-ore'),
        ],
      });
      row.addEventListener('click', function () { showDetail(r); });
      row.style.cursor = 'pointer';
      return row;
    })();
  }

  function updateArmadaChrome() {
    var info = document.getElementById('armada-selinfo');
    if (info) {
      info.innerHTML = '';
      if (selCount()) {
        info.appendChild(document.createTextNode(selCount() + ' selected · '));
        var clr = H.el('a', 'ops-refresh-btn', 'clear');
        clr.href = 'javascript:void(0)';
        clr.addEventListener('click', function () { armada.selection = {}; renderArmadaRows(); });
        info.appendChild(clr);
      } else {
        info.textContent = 'roster ' + (armada.refreshedAt ? H.ago(armada.refreshedAt) + ' old' : 'loading…');
      }
    }
    var roleBtn = document.getElementById('role-btn');
    if (roleBtn) H.busy(roleBtn, selCount() === 0 || armada.jobRunning);
    ambientSweepPreview();
  }

  // Ambient dry-run: the sweep button always shows exactly what a click does.
  var sweepPreviewTimer = null;
  function ambientSweepPreview() {
    clearTimeout(sweepPreviewTimer);
    sweepPreviewTimer = setTimeout(function () {
      var sel = Object.keys(armada.selection);
      Board.T.core.invoke('mcp_mass_action', { request: {
        action: 'sweep_alpha', mode: 'dry_run',
        players: sel.length ? sel : null,
        args: {},
      }}).then(function (r) {
        armada.lastSweepPlan = r;
        var btn = document.getElementById('sweep-btn');
        if (!btn) return;
        // Compact: the ambient dry-run detail (who/how many) lives in the plan
        // echo; the button just needs the action + total so it fits one line.
        // `total_alpha` is whole Alpha (grams); the ladder wants raw ualpha.
        // The figure goes in its own span: SUI uppercases button labels, which
        // turned "113g" into "113G" — a unit this game does not have.
        var amt = alpha(Number(r.total_alpha || 0) * 1e6);
        var span = btn.lastChild;
        span.textContent = sel.length
          ? ' Sweep ' + r.entries.length + ' ~' : ' Sweep all ~';
        span.appendChild(H.el('span', 'fig', amt));
        btn.classList.toggle('sui-mod-disabled', r.entries.length === 0 || armada.jobRunning);
      }).catch(function () {});
    }, 300);
  }

  function setJobRunning(on) {
    armada.jobRunning = on;
    ['sweep-btn', 'role-btn', 'scan-btn', 'launch-btn'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.classList.toggle('is-busy', on);
    });
  }

  function showProgress(text, frac) {
    var prog = document.getElementById('mass-progress');
    if (!prog) return;
    prog.hidden = false;
    prog.firstChild.textContent = text;
    prog.lastChild.firstChild.style.width = Math.round(frac * 100) + '%';
  }
  function hideProgressSoon() {
    setTimeout(function () {
      var prog = document.getElementById('mass-progress');
      if (prog) prog.hidden = true;
    }, 4000);
  }

  function runMass(request, startText) {
    setJobRunning(true);
    showProgress(startText, 0);
    return Board.T.core.invoke('mcp_mass_action', { request: request }).then(function (r) {
      if (request.mode === 'execute' && r && r.job_id) {
        // progress + done arrive via events; keep buttons locked until done.
        return r;
      }
      setJobRunning(false);
      return r;
    }).catch(function (e) {
      setJobRunning(false);
      showProgress('✗ ' + e, 0);
      hideProgressSoon();
      throw e;
    });
  }

  function runSweep() {
    var plan = armada.lastSweepPlan;
    if (!plan || !plan.entries || !plan.entries.length) return;
    var sel = Object.keys(armada.selection);
    runMass({
      action: 'sweep_alpha', mode: 'execute',
      players: sel.length ? sel : null,
      args: {},
      plan: plan.entries,
    }, 'Sweeping ' + plan.entries.length + ' player(s)…').catch(function () {});
  }

  function runSetRole(role) {
    var sel = Object.keys(armada.selection);
    if (!sel.length) return;
    runMass({ action: 'set_role', mode: 'execute', players: sel, args: { role: role } },
      'Setting role for ' + sel.length + '…').then(function () {
      setJobRunning(false);
      hideProgressSoon();
    }).catch(function () {});
  }

  function runForceScan(which) {
    runMass({ action: 'force_scan', mode: 'execute', args: { loop: which } }, 'Forcing ' + which + ' scan…')
      .then(function () { setJobRunning(false); showProgress(which + ' scan started (results land in the event feed)', 1); hideProgressSoon(); })
      .catch(function () {});
  }

  // Row detail as a modal (clean inside the responsive grid, unlike a sibling
  // band that would split the columns).
  function showDetail(r) {
    var content = H.el('div', null);
    content.appendChild(H.el('div', 'ops-muted', 'loading detail…'));
    var close = H.detailModal(r.name + ' · ' + r.player_id, content);
    Board.T.core.invoke('mcp_player_detail', { player: r.player_id }).then(function (d) {
      content.innerHTML = '';
      content.appendChild(H.el('div', null,
        d.struct_count + ' structs · planet ' + (r.planet_id || '—') + ' · fleet ' + (r.fleet_id || '—')));
      if (d.struct_ids && d.struct_ids.length) {
        content.appendChild(H.el('div', 'ops-muted', d.struct_ids.join('  ')));
      }
      // Watch buttons, in words here — the drawer has room the row does not.
      // These replace the old "View map →" link, which routed to a page that
      // rendered a ~11-second still through the game's own canvas.
      var watch = H.el('div');
      watch.style.cssText = 'display:flex;gap:var(--spacing-md);margin-top:var(--spacing-lg);';
      (canSpectate() ? [
        { id: r.planet_id, label: 'Watch planet', arg: 'planet_id' },
        { id: r.fleet_id, label: 'Watch fleet', arg: 'fleet_id' }
      ] : []).forEach(function (t) {
        if (!t.id) return;
        var b = H.el('a', 'ops-refresh-btn', t.label + ' →');
        b.href = 'javascript:void(0)';
        b.addEventListener('click', function () {
          var opts = {};
          opts[t.arg] = t.id;
          openSpectatorWindow(opts).then(function () { close(); }).catch(function (err) {
            content.appendChild(H.stateBlock('error', 'could not open the window: ' + err));
          });
        });
        watch.appendChild(b);
      });
      if (watch.childNodes.length) content.appendChild(watch);
    }).catch(function (e) {
      content.innerHTML = '';
      content.appendChild(H.el('div', 'err', 'detail failed: ' + e));
    });
  }

  function loadRoster(kickIfOlderMs) {
    // Presence alongside the roster, not before it: the roster must render
    // whether or not Comms is signed in, so this can only ever add a dot.
    loadPresence().then(function () { if (armada.built) renderArmadaRows(); });
    return Board.T.core.invoke('mcp_roster', { refreshIfOlderMs: kickIfOlderMs == null ? 120000 : kickIfOlderMs })
      .then(function (snap) {
        armada.rows = snap.rows || [];
        armada.refreshedAt = snap.refreshed_at_ms || 0;
        buildArmadaDom();
        renderArmadaRows();
      }).catch(function (e) {
        // This used to swallow everything, so a failed read (or a throw inside
        // the row builder) left the page sitting on "Roster loading…" forever
        // — indistinguishable from a slow sweep.
        var body = document.getElementById('armada-body');
        if (body && !armada.built) {
          body.innerHTML = '';
          body.appendChild(H.stateBlock('error', 'roster unavailable: ' + e));
        }
      });
  }

  Board.registerPage('armada', {
    onBoot: function () {
      var T = Board.T;
      T.event.listen('board-roster-progress', function (e) {
        var p = e && e.payload;
        if (p && Board.current === 'armada') showProgress('roster sweep ' + p.done + '/' + p.total, p.done / p.total);
      });
      T.event.listen('board-roster-updated', function () {
        if (Board.current === 'armada') { loadRoster(null); hideProgressSoon(); }
      });
      T.event.listen('board-mass-progress', function (e) {
        var p = e && e.payload;
        if (p) showProgress(p.action + ' ' + p.done + '/' + p.total + ' (' + p.ok + ' ok, ' + p.failed + ' failed)', p.done / p.total);
      });
      T.event.listen('board-mass-done', function (e) {
        var p = e && e.payload;
        setJobRunning(false);
        if (p) showProgress(p.action + ' done: ' + p.ok + '/' + p.total + ' ok', 1);
        hideProgressSoon();
      });
    },
    onEnter: function () { loadRoster(); },
  });

  // ═══════════════════════════ ENERGY ═══════════════════════════════════════
  var energyState = { data: null, view: 'distribution' };
  // ── Allocations ───────────────────────────────────────────────────────────
  // An allocation routes YOUR capacity into a substation. Two facts shape this
  // panel: raising one raises your own load (it is not free), and if load ever
  // exceeds capacity the chain brownouts and DESTROYS your allocations in
  // creation order. So every control is presented against remaining headroom,
  // and the backend refuses a change it computes as unsafe even if this UI
  // somehow asked for it.
  var allocState = { data: null, editing: null, draftKw: null, preview: null, busy: false };

  function kwOf(mw) { return mw / 1e6; }

  function renderAllocations(host) {
    var d = allocState.data;
    if (!d) { host.appendChild(H.stateBlock('loading', 'reading allocations…')); return; }
    var b = d.budget || {};

    // A bar, not four numbers. Three figures in mismatched units ("8.45 MW /
    // 8.45 MW / 1.22 W") hid the only thing that matters: the grid is full.
    var used = b.capacity_mw > 0 ? Math.min(1, b.load_mw / b.capacity_mw) : 0;
    var pct = Math.round(used * 1000) / 10;
    var meter = H.el('div', 'alloc-meter');
    // The game's chunked bar, the same one the action bar draws. This was a
    // second hand-rolled smooth fill — a different visual language from
    // everything beside it.
    var bar = H.progressBar(used);
    // Amber under 15% spare, red when there is effectively nothing left. The
    // chunk is a plain background, so the state rides the component rather
    // than replacing it.
    var spare = b.capacity_mw > 0 ? b.allocatable_mw / b.capacity_mw : 1;
    var state = spare < 0.01 ? 'full' : (spare < 0.15 ? 'tight' : '');
    if (state) bar.classList.add('alloc-mod-' + state);
    meter.appendChild(bar);
    var cap = H.el('div', 'alloc-meter-caption');
    cap.appendChild(H.el('span', null,
      H.fmtWatts(b.load_mw) + ' allocated of ' + H.fmtWatts(b.capacity_mw) + ' capacity'));
    // SUI's own text roles say "this number is a problem" — the same words the
    // game uses, rather than a colour invented for this one meter.
    cap.appendChild(H.el('span', 'alloc-meter-pct'
      + (state === 'full' ? ' sui-text-destructive'
        : state === 'tight' ? ' sui-text-warning' : ''), pct + '%'));
    meter.appendChild(cap);
    host.appendChild(meter);

    // The two numbers people actually confuse, named for what they DECIDE
    // rather than for what they are — "spendable here" and "keeps structs on"
    // is the whole distinction, and it fits in the caption.
    //
    // All four share ONE unit: they exist to be compared, and a strip that
    // reads "59KW / 6.53KW / 0mW / 52.47KW" makes the comparison harder, not
    // easier. Only the four DISPLAYED figures set the scale — feeding the
    // 15.4 GW capacity in as well pushed every tile onto the MW rung and
    // rendered a 6.53 KW draw as "0.01MW".
    var sc = H.scaleSet([b.allocatable_mw, b.structs_load_mw,
      b.capacity_secondary_mw, b.available_mw], 'power');
    var head = H.el('div', 'hstrip alloc-budget');
    // The two confusable words get a second caption line saying what each one
    // DECIDES. That is the whole content of the paragraph this replaced, and it
    // sits on the number it describes instead of under the card.
    head.appendChild(statTile(['allocatable', 'spendable here'], sc.fmt(b.allocatable_mw), null,
      spare < 0.01 ? 'bad' : (spare < 0.15 ? 'live' : 'ok')));
    head.appendChild(statTile('structs draw', sc.fmt(b.structs_load_mw), null, 'muted'));
    head.appendChild(statTile('from substation', sc.fmt(b.capacity_secondary_mw), null, 'muted'));
    head.appendChild(statTile(['available', 'keeps structs on'], sc.fmt(b.available_mw), null,
      b.online === false ? 'bad' : 'ok'));
    host.appendChild(head);
    if (b.online === false) {
      host.appendChild(H.stateBlock('error',
        'Draw exceeds supply — structs go offline until you free capacity.'));
    }

    var rows = d.allocations || [];
    if (!rows.length) {
      host.appendChild(H.stateBlock('empty', 'No allocations.'));
    }

    rows.forEach(function (a) {
      var editable = a.type === 'dynamic' && !a.locked;
      var act = H.el('div', 'cfg-actions');
      var edit = massBtn('', 'icon-edit', editable ? 'Power' : 'Fixed',
        editable ? 'sui-mod-secondary' : 'sui-mod-disabled');
      if (editable) {
        edit.addEventListener('click', function () {
          allocState.editing = allocState.editing === a.id ? null : a.id;
          allocState.draftKw = kwOf(a.power_mw);
          allocState.preview = null;
          renderEnergyBody();
        });
      }
      act.appendChild(edit);
      var move = massBtn('', 'icon-transfers', 'Move', 'sui-mod-secondary');
      move.addEventListener('click', function () { openAllocMove(a, d); });
      act.appendChild(move);

      var dest = (d.substations || []).find(function (s) { return s.id === a.destination_id; });
      var chips = [];
      if (dest) {
        // What feeding it is worth: contributions are diluted by 1/connections.
        chips.push(statTile('per connection', H.fmtWatts(dest.connection_capacity_mw), null, 'muted'));
        chips.push(statTile('connections', H.fmtInt(dest.connection_count), null, 'muted'));
      }
      host.appendChild(H.resultRow({
        icon: 'sui-icon-energy',
        title: H.fmtWatts(a.power_mw) + ' → ' + a.destination_id,
        subtitle: a.id + ' · ' + a.type + (a.locked ? ' · LOCKED' : ''),
        chips: chips,
        action: act,
      }));

      if (allocState.editing === a.id) host.appendChild(allocEditor(a, d));
    });

    host.appendChild(allocCreate(d));
    // No definitions block. The two words that needed a paragraph are now
    // defined by their own tile captions ("spendable here" / "keeps structs
    // on"); the long-form version lives in docs/team-ops.md.
  }

  function allocEditor(a, d) {
    var wrap = H.el('div', 'alloc-editor');
    var b = d.budget || {};
    // Everything we could commit: what this allocation already holds, plus
    // whatever is still unspent.
    var ceilingMw = a.power_mw + (b.allocatable_mw || 0);

    var out = H.el('div');
    var applyRow = H.el('div', 'cfg-actions');
    function refreshPreview() {
      out.innerHTML = '';
      applyRow.innerHTML = '';
      var mw = Math.round(Number(allocState.draftMw));
      if (!isFinite(mw)) return;
      out.appendChild(H.stateBlock('loading', 'checking…'));
      Board.T.core.invoke('mcp_allocation_preview', {
        allocationId: a.id, powerMw: mw,
      }).then(function (p) {
        allocState.preview = p;
        out.innerHTML = '';
        if (!p.ok) { out.appendChild(H.stateBlock('error', p.refusal)); return; }
        // What the change DOES, on one shared scale, so the two figures can be
        // read against each other and against the ceiling above them.
        var sc = H.scaleSet([p.delta_mw, p.projected_headroom_mw, ceilingMw], 'power');
        var strip = H.el('div', 'hstrip');
        strip.appendChild(statTile(p.delta_mw >= 0 ? 'adds to your load' : 'frees from your load',
          sc.fmt(Math.abs(p.delta_mw)), null, p.delta_mw >= 0 ? 'live' : 'ok'));
        strip.appendChild(statTile('headroom after',
          sc.fmt(p.projected_headroom_mw), null,
          p.projected_headroom_pct < 1 ? 'bad' : (p.projected_headroom_pct < 15 ? 'live' : 'ok')));
        strip.appendChild(statTile('headroom after %',
          Math.round(p.projected_headroom_pct) + '%', null, 'muted'));
        out.appendChild(strip);
        var go = massBtn('', 'icon-success', 'Apply', 'sui-mod-primary');
        go.addEventListener('click', function () { applyAllocPower(a, mw); });
        applyRow.appendChild(go);
      }).catch(function (e) {
        out.innerHTML = '';
        out.appendChild(H.stateBlock('error', String(e)));
      });
    }

    // The operator picks the unit. A dynamic allocation on this grid can be
    // anything from a few hundred mW to tens of MW, and a field hard-wired to
    // kW makes one end of that range unreadable and the other error-prone.
    // MAX fills in the ceiling, so "use all headroom" is part of the field
    // rather than a separate button that has to explain itself.
    allocState.draftMw = a.power_mw;
    wrap.appendChild(H.amountField('New power', {
      kind: 'power', base: a.power_mw, max: ceilingMw,
      onChange: function (mw) { allocState.draftMw = mw; refreshPreview(); },
    }));
    // The two facts the old paragraph carried, as readings rather than prose.
    var facts = H.el('div', 'hstrip');
    facts.appendChild(statTile('now', H.fmtWatts(a.power_mw), null, 'muted'));
    facts.appendChild(statTile('ceiling', H.fmtWatts(ceilingMw), null, 'muted'));
    wrap.appendChild(facts);
    wrap.appendChild(out);
    wrap.appendChild(applyRow);
    return wrap;
  }

  function applyAllocPower(a, mw) {
    if (allocState.busy) return;
    var body = H.el('div');
    body.appendChild(H.fact('Allocation', a.id + ' → ' + a.destination_id));
    body.appendChild(H.fact('From', H.fmtWatts(a.power_mw)));
    body.appendChild(H.fact('To', H.fmtWatts(mw)));
    body.appendChild(H.fact('Your load moves by',
      (mw >= a.power_mw ? '+' : '−') + H.fmtWatts(Math.abs(mw - a.power_mw))));
    H.confirmModal('Set allocation power?', body, 'Apply', function () {
      allocState.busy = true;
      Board.T.core.invoke('mcp_allocation_set_power', {
        allocationId: a.id, powerMw: Math.round(mw),
      }).then(function () {
        allocState.busy = false; allocState.editing = null; allocState.preview = null;
        loadAllocations().then(renderEnergyBody);
      }).catch(function (e) {
        allocState.busy = false;
        alertInto('energy-body', 'allocation update failed: ' + e);
      });
    });
  }

  function openAllocMove(a, d) {
    var form = H.el('div');
    form.appendChild(formFact('Allocation', a.id + ' · ' + H.fmtWatts(a.power_mw)));
    form.appendChild(formFact('Currently feeding', a.destination_id));
    var dest = a.destination_id;
    var opts = (d.substations || []).map(function (s) {
      // Name first when the substation has one — every destination is now
      // listed, and bare ids ("4-10") don't say whose grid you'd be feeding.
      return { value: s.id, label: (s.name ? s.name + ' · ' : '') + s.id
        + ' — ' + H.fmtWatts(s.connection_capacity_mw)
        + '/conn across ' + s.connection_count };
    });
    // Each option already carries the dilution as a figure ("7.63KW/conn
    // across 2033"), which is the fact the removed paragraph was describing.
    form.appendChild(H.field('Move to', H.selectBox(dest, opts, function (v) { dest = v; })));
    var cta = H.el('div', 'drawer-cta');
    var go = massBtn('', 'icon-transfers', 'Move', 'sui-mod-destructive');
    go.addEventListener('click', function () {
      if (dest === a.destination_id) {
        form.appendChild(H.stateBlock('info', 'already feeding that substation'));
        return;
      }
      Board.T.core.invoke('mcp_allocation_connect', {
        allocationId: a.id, destinationId: dest,
      }).then(function () {
        loadAllocations().then(renderEnergyBody);
      }).catch(function (e) {
        form.appendChild(H.stateBlock('error', String(e)));
      });
    });
    cta.appendChild(go);
    form.appendChild(cta);
    H.drawer('Move allocation ' + a.id, form);
  }

  function allocCreate(d) {
    var wrap = H.el('div', 'alloc-create');
    var b = d.budget || {};
    var open = massBtn('', 'icon-add', 'New allocation', 'sui-mod-secondary');
    open.addEventListener('click', function () {
      var form = H.el('div');
      var powerMw = 0, type = 'dynamic', src = d.player_id;
      form.appendChild(formFact('Source', d.player_id + ' (you)'));
      form.appendChild(formFact('Allocatable now', H.fmtWatts(b.allocatable_mw)));
      form.appendChild(H.field('Type', H.selectBox('dynamic',
        [{value:'dynamic',label:'dynamic — power you can change later'},
         {value:'static',label:'static — fixed at creation'},
         {value:'automated',label:'automated — tracks your full capacity (one per source)'}],
        function (v) { type = v; })));
      // MAX is bounded by the headroom shown above it, so "takes its power
      // from your headroom immediately" is a property of the control now.
      form.appendChild(H.amountField('Power', {
        kind: 'power', max: b.allocatable_mw,
        onChange: function (mw) { powerMw = mw; },
      }));
      form.appendChild(H.stateBlock('info', 'Created unconnected — use Move to point it at a substation.'));
      var cta = H.el('div', 'drawer-cta');
      var go = massBtn('', 'icon-add', 'Create', 'sui-mod-destructive');
      go.addEventListener('click', function () {
        if (go.dataset.busy === '1') return; // double-click sent it twice
        go.dataset.busy = '1';
        go.querySelector('span').textContent = ' Submitting…';
        Board.T.core.invoke('mcp_allocation_create', {
          sourceObjectId: src, allocationType: type, powerMw: Math.round(powerMw),
        }).then(function () {
          // Only ACCEPTED, not settled — charge-gated messages broadcast later,
          // so promising "created" here would be a lie. The Transactions page
          // (and a feed warning) carry the real receipt.
          close();
          loadAllocations().then(renderEnergyBody);
        }).catch(function (e) {
          go.dataset.busy = '0';
          go.querySelector('span').textContent = ' Create';
          form.appendChild(H.stateBlock('error', String(e)));
        });
      });
      cta.appendChild(go);
      form.appendChild(cta);
      var close = H.drawer('New allocation', form);
    });
    wrap.appendChild(open);
    return wrap;
  }

  function loadAllocations() {
    return Board.T.core.invoke('mcp_allocations').then(function (d) {
      allocState.data = d;
    }).catch(function (e) {
      allocState.data = { _err: String(e) };
    });
  }

  // ── Production: infusions ─────────────────────────────────────────────────
  // The other half of the grid. An allocation ROUTES capacity; an infusion
  // MAKES it, by staking Alpha into a reactor — which is a validator, so these
  // three controls are a delegation, an undelegation and a redelegation wearing
  // game words. Three facts shape every control here:
  //
  //   · `ratio` can be 0. A jailed or unbonded validator earns NOTHING from the
  //     fuel staked in it, and nothing else on screen would say so.
  //   · Defusing takes the capacity NOW and returns the Alpha in four days. If
  //     that capacity was carrying allocations the chain brownouts and destroys
  //     them, so every removal is priced against the holder's live load.
  //   · Generator infusions cannot be undone at all, so they are listed apart
  //     and have no buttons.
  var infuState = { data: null, busy: false };

  function loadInfusions() {
    return Board.T.core.invoke('mcp_infusions').then(function (d) {
      infuState.data = d;
    }).catch(function (e) {
      infuState.data = { _err: String(e) };
    });
  }

  // What each op's preview is worth reading, per op. The backend returns one
  // `facts` object; this decides which of it a human needs and in what unit.
  var PREVIEW_FIELDS = {
    infuse: [
      { label: ['capacity gained', 'yours to keep'], key: 'gained_mw', kind: 'power', tone: 'ok' },
      { label: 'reactor commission', key: 'commission_mw', kind: 'power', tone: 'muted' },
      { label: 'capacity after', key: 'capacity_after_mw', kind: 'power' },
      { label: 'alpha left liquid', key: 'balance_after_ualpha', kind: 'alpha', tone: 'muted' },
    ],
    defuse: [
      { label: ['capacity removed', 'immediately'], key: 'capacity_lost_mw', kind: 'power', tone: 'live' },
      { label: 'capacity after', key: 'capacity_after_mw', kind: 'power' },
      { label: ['headroom after', 'over allocated load'], key: 'headroom_after_mw', kind: 'power', sign: true },
      { label: ['alpha returns in', 'cooldown'], key: 'cooldown_secs', kind: 'duration', tone: 'muted' },
    ],
    migrate: [
      { label: 'leaves the source', key: 'capacity_lost_mw', kind: 'power', tone: 'muted' },
      { label: 'arrives at the target', key: 'capacity_gained_mw', kind: 'power', tone: 'muted' },
      { label: ['net capacity', 'what the move costs'], key: 'net_mw', kind: 'power', sign: true },
      { label: 'capacity after', key: 'capacity_after_mw', kind: 'power' },
    ],
  };

  function previewStrip(op, facts) {
    var strip = H.el('div', 'hstrip');
    (PREVIEW_FIELDS[op] || []).forEach(function (f) {
      var raw = facts[f.key];
      if (raw == null) return;
      var txt;
      if (f.kind === 'duration') txt = H.duration(raw, { zero: 'now' });
      else if (f.kind === 'alpha') txt = alpha(raw);
      else txt = kw(Math.abs(raw));
      // A signed field is the one that can go NEGATIVE and mean "you are now
      // over-committed" — print the sign and colour it, never a bare figure.
      var tone = f.tone || null;
      if (f.sign) {
        txt = (raw < 0 ? '−' : '+') + txt;
        tone = raw < 0 ? 'bad' : 'ok';
      }
      strip.appendChild(statTile(f.label, txt, null, tone));
    });
    return strip;
  }

  function reactorOptions(d, opts) {
    opts = opts || {};
    return (d.reactors || []).filter(function (r) {
      return !opts.exclude || r.id !== opts.exclude;
    }).map(function (r) {
      // Everything that decides which reactor to pick, in the option itself:
      // whose guild it is, what it takes, and whether it is producing at all.
      var bits = [r.id];
      if (r.moniker) bits.push(r.moniker);
      var tail = (r.commission * 100).toFixed(1).replace(/\.0$/, '') + '% commission';
      if (r.is_our_guild) tail += ' · your guild';
      var bond = bondText(r);
      if (bond) tail += ' · ' + bond;
      if (r.our_fuel_ualpha > 0) tail += ' · you hold ' + alpha(r.our_fuel_ualpha);
      return { value: r.id, label: bits.join(' · ') + ' — ' + tail };
    });
  }

  function holderOptions(d) {
    return (d.candidates || []).map(function (c) {
      return { value: c.address, label: c.name + ' · ' + c.player_id + ' — ' + alpha(c.alpha_ualpha) + ' liquid' };
    });
  }

  // The chain's own words for a validator that isn't earning. `BOND_STATUS_
  // UNBONDED` in a subtitle tells an operator nothing about what it costs them.
  function bondText(r) {
    if (r.jailed) return 'JAILED — earns nothing';
    if (r.status && r.status !== 'BOND_STATUS_BONDED') return 'not bonded — earns nothing';
    return null;
  }

  function holderByAddress(d, addr) {
    return (d.candidates || []).find(function (c) { return c.address === addr; }) || null;
  }

  // One drawer for all three ops. They differ only in which pickers appear, the
  // ceiling on the amount and the confirmation wording — writing three of these
  // guaranteed the guard rails would drift between them.
  //
  // `o`: { op, address, destinationId, targetId?, max, title, cta, ctaIcon,
  //        pickHolder?, pickReactor?, pickTarget?, danger? }
  function infusionDrawer(d, o) {
    var st = {
      address: o.address, dest: o.destinationId, target: o.targetId || null,
      amount: 0, max: o.max || 0, preview: null,
    };
    var form = H.el('div');
    var out = H.el('div');
    var cta = H.el('div', 'drawer-cta');
    var timer = null;

    function ceiling() {
      if (o.op !== 'infuse') return st.max;
      var h = holderByAddress(d, st.address);
      return h ? h.alpha_ualpha : st.max;
    }

    function refresh() {
      out.innerHTML = '';
      cta.innerHTML = '';
      if (!st.amount || !st.dest || (o.op === 'migrate' && !st.target)) return;
      out.appendChild(H.stateBlock('loading', 'checking…'));
      Board.T.core.invoke('mcp_infusion_preview', {
        op: o.op, address: st.address, destinationId: st.dest,
        targetId: st.target, amountUalpha: Math.round(st.amount),
      }).then(function (p) {
        st.preview = p;
        out.innerHTML = '';
        (p.warnings || []).forEach(function (w) {
          out.appendChild(H.stateBlock('warning', w));
        });
        if (!p.ok) { out.appendChild(H.stateBlock('error', p.refusal)); return; }
        out.appendChild(previewStrip(o.op, p.facts || {}));
        if (p.facts && p.facts.online_after === false) {
          out.appendChild(H.stateBlock('error',
            'This leaves the player drawing more than it can supply — its structs go offline.'));
        }
        var go = massBtn('', o.ctaIcon, o.cta, o.danger ? 'sui-mod-destructive' : 'sui-mod-primary');
        go.addEventListener('click', function () { commit(p); });
        cta.appendChild(go);
      }).catch(function (e) {
        out.innerHTML = '';
        out.appendChild(H.stateBlock('error', String(e)));
      });
    }
    // The preview is a chain read per keystroke otherwise.
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 250);
    }

    function commit(p) {
      if (infuState.busy) return;
      var body = H.el('div');
      body.appendChild(H.fact('Player', p.player_name + ' · ' + p.player_id));
      body.appendChild(H.fact('Amount', alpha(st.amount)));
      body.appendChild(H.fact(o.op === 'migrate' ? 'From' : 'Reactor', st.dest));
      if (o.op === 'migrate') body.appendChild(H.fact('To', st.target));
      var f = p.facts || {};
      if (o.op === 'infuse') body.appendChild(H.fact('Capacity gained', kw(f.gained_mw)));
      if (o.op === 'defuse') {
        body.appendChild(H.fact('Capacity removed now', kw(f.capacity_lost_mw)));
        body.appendChild(H.fact('Alpha returns in', H.duration(f.cooldown_secs, { zero: 'now' })));
      }
      if (o.op === 'migrate') {
        body.appendChild(H.fact('Net capacity',
          (f.net_mw < 0 ? '−' : '+') + kw(Math.abs(f.net_mw))));
      }
      H.confirmModal(o.confirm, body, o.cta, function () {
        infuState.busy = true;
        var cmd = { infuse: 'mcp_infusion_infuse', defuse: 'mcp_infusion_defuse',
                    migrate: 'mcp_infusion_migrate' }[o.op];
        var args = o.op === 'migrate'
          ? { address: st.address, fromReactorId: st.dest, toReactorId: st.target,
              amountUalpha: Math.round(st.amount) }
          : { address: st.address, reactorId: st.dest, amountUalpha: Math.round(st.amount) };
        Board.T.core.invoke(cmd, args).then(function () {
          infuState.busy = false;
          close();
          loadInfusions().then(renderEnergyBody);
        }).catch(function (e) {
          infuState.busy = false;
          out.appendChild(H.stateBlock('error', String(e)));
        });
      });
    }

    if (o.pickHolder) {
      form.appendChild(H.field('Infuse as', H.selectBox(st.address, holderOptions(d), function (v) {
        st.address = v;
        renderAmount();
        schedule();
      })));
    } else {
      var h = holderByAddress(d, st.address);
      form.appendChild(formFact('Player', (o.playerName || (h && h.name) || st.address)
        + (o.playerId ? ' · ' + o.playerId : '')));
    }

    if (o.pickReactor) {
      form.appendChild(H.field('Reactor', H.selectBox(st.dest, reactorOptions(d), function (v) {
        st.dest = v; schedule();
      })));
    } else {
      form.appendChild(formFact(o.op === 'migrate' ? 'Moving out of' : 'Reactor', o.destLabel || st.dest));
    }
    if (o.pickTarget) {
      form.appendChild(H.field('Move to', H.selectBox(st.target,
        reactorOptions(d, { exclude: st.dest }), function (v) { st.target = v; schedule(); })));
    }

    // The amount field is rebuilt when the holder changes, because MAX is that
    // holder's balance — a stale ceiling is how you sign an amount the chain
    // will reject.
    var amountHost = H.el('div');
    function renderAmount() {
      amountHost.innerHTML = '';
      amountHost.appendChild(H.amountField(o.amountLabel || 'Amount', {
        kind: 'alpha', max: ceiling(),
        hint: o.hint,
        onChange: function (u) { st.amount = u; schedule(); },
      }));
      var ceil = H.el('div', 'hstrip');
      ceil.appendChild(statTile(o.maxLabel || 'available', alpha(ceiling()), null, 'muted'));
      amountHost.appendChild(ceil);
    }
    renderAmount();
    form.appendChild(amountHost);
    form.appendChild(out);
    form.appendChild(cta);
    var close = H.drawer(o.title, form);
  }

  function openInfuse(d, seed) {
    seed = seed || {};
    var addr = seed.address || (d.candidates && d.candidates[0] && d.candidates[0].address) || d.address;
    var reactor = seed.reactorId
      || (d.reactors && d.reactors[0] && d.reactors[0].id) || '';
    infusionDrawer(d, {
      op: 'infuse', address: addr, destinationId: reactor,
      pickHolder: !seed.address, pickReactor: true,
      title: 'Infuse Alpha', cta: 'Infuse', ctaIcon: 'icon-send-alpha',
      confirm: 'Stake this Alpha into the reactor?',
      amountLabel: 'Alpha to stake', maxLabel: 'liquid alpha',
      hint: 'You keep power × (1 − commission) as your own capacity, forever, and can defuse it back after a cooldown.',
    });
  }

  function openDefuse(d, r) {
    infusionDrawer(d, {
      op: 'defuse', address: r.address, destinationId: r.destination_id,
      destLabel: r.destination_label,
      playerName: r.player_name, playerId: r.player_id,
      max: Math.max(0, r.fuel_ualpha - r.defusing_ualpha),
      title: 'Defuse Alpha', cta: 'Start defusing', ctaIcon: 'icon-subtract',
      danger: true, confirm: 'Remove this Alpha from the reactor?',
      amountLabel: 'Alpha to remove', maxLabel: 'still removable',
      hint: 'The capacity goes immediately; the Alpha comes back after the chain cooldown.',
    });
  }

  function openMigrate(d, r) {
    var first = (d.reactors || []).find(function (x) { return x.id !== r.destination_id; });
    infusionDrawer(d, {
      op: 'migrate', address: r.address, destinationId: r.destination_id,
      targetId: first ? first.id : null, destLabel: r.destination_label,
      playerName: r.player_name, playerId: r.player_id,
      max: Math.max(0, r.fuel_ualpha - r.defusing_ualpha),
      pickTarget: true,
      title: 'Migrate infusion', cta: 'Migrate', ctaIcon: 'icon-transfers',
      danger: true, confirm: 'Move this stake to another reactor?',
      amountLabel: 'Alpha to move', maxLabel: 'movable',
      hint: 'No cooldown — but the moved fuel is repriced at the destination’s commission.',
    });
  }

  function cancelDefusion(row) {
    var body = H.el('div');
    body.appendChild(H.fact('Player', row.player_name));
    body.appendChild(H.fact('Amount', alpha(row.amount_ualpha)));
    body.appendChild(H.fact('Reactor', row.reactor_id || row.validator));
    body.appendChild(H.fact('Re-stakes at', 'block ' + row.creation_height));
    H.confirmModal('Cancel this defusion and re-stake?', body, 'Re-stake', function () {
      Board.T.core.invoke('mcp_infusion_cancel_defusion', {
        address: row.address, validator: row.validator,
        amountUalpha: Math.round(row.amount_ualpha),
        creationHeight: String(row.creation_height),
      }).then(function () {
        loadInfusions().then(renderEnergyBody);
      }).catch(function (e) {
        alertInto('energy-body', 'cancel failed: ' + e);
      });
    });
  }

  function restartReactor(id) {
    var body = H.el('div');
    body.appendChild(H.fact('Reactor', id));
    body.appendChild(H.el('div', null,
      'Resyncs the reactor from live staking. Permissionless, and the fix for a validator that '
      + 'was unjailed but never rebonded — which leaves every infusion in it earning nothing.'));
    H.confirmModal('Restart this reactor?', body, 'Restart', function () {
      Board.T.core.invoke('mcp_infusion_restart', { reactorId: id }).then(function () {
        loadInfusions().then(renderEnergyBody);
      }).catch(function (e) {
        alertInto('energy-body', 'restart failed: ' + e);
      });
    });
  }

  function infusionRow(d, r) {
    var act = H.el('div', 'cfg-actions');
    if (r.reversible) {
      var add = massBtn('', 'icon-add', 'Add', 'sui-mod-secondary');
      add.addEventListener('click', function () {
        openInfuse(d, { address: r.address, reactorId: r.destination_id });
      });
      act.appendChild(add);
      var out = massBtn('', 'icon-subtract', 'Defuse', 'sui-mod-secondary');
      out.addEventListener('click', function () { openDefuse(d, r); });
      act.appendChild(out);
      var mv = massBtn('', 'icon-transfers', 'Migrate', 'sui-mod-secondary');
      mv.addEventListener('click', function () { openMigrate(d, r); });
      act.appendChild(mv);
      // Only offered where it can actually help: the reactor produces nothing
      // and its validator is NOT jailed, which is exactly the unjailed-but-
      // never-rebonded case MsgReactorRestart exists for.
      if (r.dead && !r.validator_jailed) {
        var rs = massBtn('', 'icon-refresh-12', 'Restart', 'sui-mod-primary');
        rs.addEventListener('click', function () { restartReactor(r.destination_id); });
        act.appendChild(rs);
      }
    }
    var chips = [
      statTile(r.dead ? ['capacity', 'earning nothing'] : 'capacity',
        kw(r.capacity_mw), null, r.dead ? 'bad' : 'ok'),
      statTile('commission', (r.commission * 100).toFixed(1).replace(/\.0$/, '') + '%', null, 'muted'),
    ];
    if (r.ratio !== 1) chips.push(statTile('ratio', r.ratio + '×', null, r.dead ? 'bad' : 'live'));
    if (r.defusing_ualpha > 0) chips.push(statTile('defusing', alpha(r.defusing_ualpha), null, 'live'));
    var sub = r.player_name + (r.player_id ? ' · ' + r.player_id : '');
    if (r.dead) {
      sub += r.validator_jailed ? ' · validator JAILED' : ' · validator not producing';
    }
    return H.resultRow({
      icon: r.dead ? 'sui-icon-no-power' : 'sui-icon-energy',
      title: alpha(r.fuel_ualpha) + ' → ' + r.destination_label,
      subtitle: sub,
      chips: chips,
      action: r.reversible ? act : null,
    });
  }

  function renderProductionBody() {
    var body = document.getElementById('energy-body');
    body.innerHTML = '';
    var d = infuState.data;
    if (!d) { body.appendChild(H.stateBlock('loading', 'reading infusions…')); return; }
    if (d._err) { body.appendChild(H.alertLine('infusions unavailable: ' + d._err, 'icon-alert')); return; }

    var t = d.totals || {};
    var rows = d.infusions || [];
    var reactorRows = rows.filter(function (r) { return r.reversible; });
    var genRows = rows.filter(function (r) { return !r.reversible; });

    // ── Headline ──
    // One shared power scale so "capacity" and "commission" are comparable;
    // staked and dead share the alpha scale for the same reason.
    var cbody = H.el('div');
    var pw = H.scaleSet([t.capacity_mw, t.commission_mw], 'power');
    var head = H.el('div', 'hstrip alloc-budget');
    head.appendChild(statTile(['staked', 'alpha in reactors + generators'], alpha(t.fuel_ualpha), null, 'ok'));
    head.appendChild(statTile(['capacity made', 'yours'], pw.fmt(t.capacity_mw), null, 'ok'));
    head.appendChild(statTile(['commission', 'kept by reactors'], pw.fmt(t.commission_mw), null, 'muted'));
    head.appendChild(statTile('defusing', alpha(t.defusing_ualpha), null,
      t.defusing_ualpha > 0 ? 'live' : 'muted'));
    head.appendChild(statTile(['earning nothing', 'ratio 0'], alpha(t.dead_fuel_ualpha), null,
      t.dead_fuel_ualpha > 0 ? 'bad' : 'muted'));
    cbody.appendChild(head);
    if (t.dead_fuel_ualpha > 0) {
      cbody.appendChild(H.stateBlock('warning',
        alpha(t.dead_fuel_ualpha) + ' of staked Alpha is producing no energy at all — its '
        + 'reactor’s validator is jailed or unbonded. Migrate it to a live reactor, or '
        + 'restart the reactor if the validator is already back.'));
    }
    if (d.auto_infuse && d.auto_infuse.enabled) {
      cbody.appendChild(H.stateBlock('info',
        'auto_infuse is on: the primary keeps ' + d.auto_infuse.keep_grams
        + ' g liquid and stakes the rest every '
        + H.duration(d.auto_infuse.interval_secs) + '.'));
    }
    body.appendChild(H.card('INFUSION SUMMARY', cbody));

    // ── Reactor infusions (the actionable list) ──
    var ibody = H.el('div');
    if (!reactorRows.length) {
      ibody.appendChild(H.stateBlock('empty',
        'No reactor infusions. Staking Alpha into a reactor is the simplest way to raise '
        + 'capacity: you keep ~96% of it as your own, and can defuse it back.'));
    }
    reactorRows.forEach(function (r) { ibody.appendChild(infusionRow(d, r)); });
    var create = H.el('div', 'alloc-create');
    var open = massBtn('', 'icon-send-alpha', 'New infusion', 'sui-mod-secondary');
    open.addEventListener('click', function () { openInfuse(d); });
    create.appendChild(open);
    ibody.appendChild(create);
    body.appendChild(H.card('REACTOR INFUSIONS', ibody));

    // ── In flight ──
    var pend = d.pending || [];
    var migs = d.migrations || [];
    if (pend.length || migs.length) {
      var fbody = H.el('div');
      pend.forEach(function (p) {
        var act = H.el('div', 'cfg-actions');
        var undo = massBtn('', 'icon-close', 'Cancel', 'sui-mod-secondary');
        undo.addEventListener('click', function () { cancelDefusion(p); });
        act.appendChild(undo);
        fbody.appendChild(H.resultRow({
          icon: 'icon-in-progress',
          title: alpha(p.amount_ualpha) + ' leaving ' + (p.reactor_id || p.moniker || p.validator),
          subtitle: p.player_name + ' · re-stakes at block ' + p.creation_height,
          chips: [statTile('alpha back in', H.duration(p.eta_secs, { zero: 'now' }), null, 'live')],
          action: act,
        }));
      });
      migs.forEach(function (m) {
        fbody.appendChild(H.resultRow({
          icon: 'icon-transfers',
          title: alpha(m.amount_ualpha) + ' · ' + (m.src_reactor_id || m.src_moniker)
            + ' → ' + (m.dst_reactor_id || m.dst_moniker),
          subtitle: m.player_name + ' · migration in progress',
          chips: [statTile('settles in', H.duration(m.eta_secs, { zero: 'now' }), null, 'live')],
        }));
      });
      body.appendChild(H.card('IN FLIGHT', fbody));
    }

    // ── Generators (one-way, so read-only) ──
    if (genRows.length) {
      var gbody2 = H.el('div');
      genRows.forEach(function (r) {
        gbody2.appendChild(H.resultRow({
          icon: r.destroyed ? 'icon-wreckage' : 'sui-icon-inert-alpha',
          title: alpha(r.fuel_ualpha) + ' → ' + r.destination_label,
          subtitle: r.player_name + (r.destroyed ? ' · DESTROYED — the Alpha is gone' : ' · one-way'),
          chips: [
            statTile('capacity', kw(r.capacity_mw), null, r.destroyed ? 'bad' : 'ok'),
            statTile('rate', r.ratio + ' kW/g', null, 'muted'),
          ],
        }));
      });
      body.appendChild(H.card('GENERATOR INFUSIONS', gbody2));
    }

    // ── The directory ──
    // Every legal destination, ours first then cheapest — which is the standing
    // advice ("infuse your guild's reactor; pick the lowest commission") as an
    // ordering rather than a paragraph.
    var rbody = H.el('div');
    (d.reactors || []).forEach(function (r) {
      var down = r.jailed || (r.status && r.status !== 'BOND_STATUS_BONDED');
      var act = H.el('div', 'cfg-actions');
      var go = massBtn('', 'icon-send-alpha', 'Infuse', down ? 'sui-mod-disabled' : 'sui-mod-secondary');
      if (!down) {
        go.addEventListener('click', function () { openInfuse(d, { reactorId: r.id }); });
      }
      act.appendChild(go);
      if (down && !r.jailed) {
        var rs2 = massBtn('', 'icon-refresh-12', 'Restart', 'sui-mod-secondary');
        rs2.addEventListener('click', function () { restartReactor(r.id); });
        act.appendChild(rs2);
      }
      rbody.appendChild(H.resultRow({
        icon: down ? 'sui-icon-no-power' : 'sui-icon-energy',
        title: r.id + (r.moniker ? ' · ' + r.moniker : ''),
        subtitle: (r.is_our_guild ? 'your guild' : (r.guild_id ? 'guild ' + r.guild_id : 'unaffiliated'))
          + (bondText(r) ? ' · ' + bondText(r) : ''),
        chips: [
          statTile('commission', (r.commission * 100).toFixed(1).replace(/\.0$/, '') + '%', null,
            r.commission <= 0.04 ? 'ok' : 'muted'),
          // A zero here means "you hold nothing there", which reads as an em
          // dash; "0µg" looks like a rounding artefact of a real holding.
          statTile('your stake', r.our_fuel_ualpha > 0 ? alpha(r.our_fuel_ualpha) : '—', null,
            r.our_fuel_ualpha > 0 ? 'ok' : 'muted'),
          statTile('infusers', H.fmtInt(r.infusers), null, 'muted'),
        ],
        action: act,
      }));
    });
    body.appendChild(H.card('REACTORS', rbody));
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }

  function renderDistributionBody() {
    var d = energyState.data; if (!d) return;
    var body = document.getElementById('energy-body');
    body.innerHTML = '';
    var g = d.guild;
    var gbody = H.el('div');
    gbody.appendChild(H.row('Reactor fuel', kw(g.reactor_fuel_mw) + '  (' + Math.round(g.reactor_commission * 100) + '% commission)', 'sui-icon-energy'));
    // Capacity and load are read against each other, so they share a unit —
    // "15.52MW capacity" beside "0mW load" defeats the only comparison this
    // card exists for. Per-connection is a different magnitude by nature and
    // keeps its own scale.
    var sub = H.scaleSet([g.sub_capacity_mw, g.sub_load_mw], 'power');
    gbody.appendChild(H.row('Substation capacity', sub.fmt(g.sub_capacity_mw) + ' · ' + g.sub_connection_count + ' connections'));
    gbody.appendChild(H.row('Per-connection', kw(g.sub_connection_capacity_mw) + '  (→ ' + kw(g.share_if_one_more_mw) + ' with 1 more)'));
    gbody.appendChild(H.row('Substation load', sub.fmt(g.sub_load_mw)));
    gbody.appendChild(H.row('Growth headroom', '~' + g.supportable_more + ' more players',
      g.supportable_more > 0 ? 'icon-success' : 'icon-alert'));
    body.appendChild(H.card('GUILD POWER', gbody));

    // Rolled up by ROLE. Listing 733 near-identical workers was 80 rows of
    // noise; what you actually need is "is any group in trouble", and the
    // WORST margin in a group is the one that decides that — an average hides
    // a single starved player behind 600 healthy ones. The primary stays on
    // its own row because it is the only genuinely individual case.
    // Allocations before margins: this is the panel you come here to ACT on.
    var abody = H.el('div');
    if (allocState.data && allocState.data._err) {
      abody.appendChild(H.stateBlock('error', 'allocations unavailable: ' + allocState.data._err));
    } else {
      renderAllocations(abody);
    }
    body.appendChild(H.card('ALLOCATIONS', abody));

    var pbody = H.el('div');
    var table = H.resultTable();
    var players = d.players || [];
    var primary = players.filter(function (p) { return p.role === 'primary'; });
    var groups = {};
    players.forEach(function (p) {
      if (p.role === 'primary') return;
      var g = groups[p.role] || (groups[p.role] = { role: p.role, n: 0, sumMargin: 0,
        worst: Infinity, worstName: null, under: 0, load: 0, cap: 0, errs: 0 });
      g.n++; g.sumMargin += p.margin_pct; g.load += p.load_mw; g.cap += p.capacity_mw;
      if (p.err) g.errs++;
      if (p.margin_pct < g.worst) { g.worst = p.margin_pct; g.worstName = p.name; }
      if (p.margin_pct < 15) g.under++;
    });

    primary.forEach(function (p) {
      table.appendChild(H.resultRow({
        icon: p.ok ? 'sui-icon-energy' : 'sui-icon-no-power',
        title: p.err ? H.el('span', 'err', p.name) : p.name,
        subtitle: 'primary',
        chips: [
          statTile('load / capacity', H.fmtWatts(p.load_mw) + ' / ' + H.fmtWatts(p.capacity_mw)),
          statTile('margin', Math.round(p.margin_pct) + '%', null,
            p.margin_pct < 15 ? 'bad' : 'ok'),
        ],
      }));
    });

    Object.keys(groups).sort().forEach(function (role) {
      var g = groups[role];
      var avg = g.n ? g.sumMargin / g.n : 0;
      table.appendChild(H.resultRow({
        icon: g.under ? 'sui-icon-no-power' : 'sui-icon-energy',
        title: role + ' × ' + H.fmtInt(g.n),
        // Name the player the worst figure belongs to right here — that is
        // the whole reason the worst is shown ahead of the average.
        subtitle: g.under
          ? g.under + ' below 15% — worst ' + g.worstName + ' at ' + Math.round(g.worst) + '%'
          : 'all above 15% — worst ' + g.worstName + ' at ' + Math.round(g.worst) + '%',
        chips: [
          // Worst leads; the average is the reassuring number and is demoted
          // to muted so it cannot be mistaken for the one that decides.
          statTile('worst margin', Math.round(g.worst) + '%', null, g.worst < 15 ? 'bad' : 'ok'),
          statTile('avg', Math.round(avg) + '%', null, 'muted'),
          statTile('total load', H.fmtWatts(g.load), null, 'muted'),
          statTile('stale reads', g.errs, null, g.errs ? 'live' : 'muted'),
        ],
      }));
    });
    pbody.appendChild(table);

    // Roster age belongs in the card header, not in a sentence under it: it
    // qualifies every row above and it is the one thing here that goes stale.
    body.appendChild(H.card('PLAYER MARGINS · roster ' + H.ago(d.roster_refreshed_at_ms) + ' old', pbody));
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }
  // Both Industry sections are this one page div; the section decides which
  // half renders. Every existing `loadAllocations().then(renderEnergyBody)`
  // call therefore still lands on the right body.
  function renderEnergyBody() {
    if (energyState.view === 'production') return renderProductionBody();
    return renderDistributionBody();
  }

  function renderEnergy() {
    // Fetch only what the visible section reads: Production makes no substation
    // reads, Distribution makes no staking reads, and the cadence tick would
    // otherwise pay for both every 30s.
    if (energyState.view === 'production') {
      return loadInfusions().then(renderEnergyBody);
    }
    return Promise.all([
      Board.T.core.invoke('mcp_energy'),
      loadAllocations(),
    ]).then(function (r) {
      energyState.data = r[0]; renderEnergyBody();
    }).catch(function (e) {
      var body = document.getElementById('energy-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('energy unavailable: ' + e, 'icon-alert'));
    });
  }
  Board.registerPage('energy', {
    refresh: renderEnergy,
    cadenceMs: 30000,
    onEnter: function (params, view) {
      if (view) energyState.view = view;
      return renderEnergy();
    },
  });

  // ═══════════════════════════ WORK ═════════════════════════════════════════
  var workState = { data: null, sort: { key: 'progress', dir: -1 }, built: false, lv: null };
  // `percent_complete` arrives as a PERCENTAGE STRING ("80.1%"), not a number.
  // `("80.1%" || 0) / 100` is NaN, and `progressBar` treats NaN as zero — so
  // every bar on this page rendered empty however far along the proof was. The
  // default sort compared the same strings lexically, which put "9%" above
  // "80.1%". Parse once, here, and let every call site take a real number.
  function pctOf(v) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v));
    return isNaN(n) ? 0 : n;
  }
  var WORK_KEYS = [{ key: 'progress', label: 'progress' }, { key: 'difficulty', label: 'difficulty' },
    { key: 'status', label: 'status' }, { key: 'type', label: 'type' }, { key: 'task', label: 'task id' }];
  var WORK_ACC = {
    progress: function (t) { return pctOf(t.percent_complete); },
    difficulty: function (t) { return t.current_difficulty == null ? -1 : t.current_difficulty; },
    status: function (t) { return (t.status || '').toLowerCase(); },
    type: function (t) { return (t.task_type || '').toLowerCase(); },
    task: function (t) { return t.task_id || ''; },
  };
  // The Work page is rebuilt every 5s. The TASKS list must NOT be rebuilt with
  // it — at 851 queued proofs that is the same full-teardown problem the roster
  // had, and it would also reset the sort/page you just chose. So the page is
  // built once as a skeleton of card bodies, and each tick only refills them;
  // the task list is a persistent listView that is handed new rows.
  function buildWorkSkeleton() {
    if (workState.built) return;
    workState.built = true;
    var body = document.getElementById('work-body');
    body.innerHTML = '';

    var qbody = H.el('div'); qbody.id = 'work-queue';
    body.appendChild(H.card('PoW QUEUE', qbody));

    var typeIcon = { MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-in-progress', RAID: 'icon-raid' };
    workState.lv = H.listView({
      key: function (t) { return t.task_id || (t.task_type + ':' + t.object_id); },
      sig: function (t) {
        return [t.status, t.percent_complete, t.current_difficulty, t.difficulty_target, t.eta].join('|');
      },
      render: function (t) {
        // `current_difficulty` is the live 0-64 bit difficulty; `difficulty_target`
        // is a CURVE PARAMETER off the struct type (28,000 for a refinery, 720
        // for a build) that the decay formula raises to a power. Printing them
        // as "8→28000" implied one becomes the other — two incommensurable
        // numbers joined by an arrow. The difficulty is what an operator reads;
        // the target is a constant of the struct type and belongs on the hover.
        var d = t.current_difficulty;
        return H.resultRow({
          icon: typeIcon[t.task_type] || 'icon-in-progress',
          title: t.task_id || '?',
          subtitle: (t.task_type || '?') + ' · ' + (t.status || '?'),
          chips: [
            H.resource(H.progressBar(pctOf(t.percent_complete) / 100)),
            statTile('difficulty', d == null ? '—' : d + '/64', null,
              d == null ? 'muted' : (d <= 16 ? 'ok' : (d <= 32 ? 'live' : 'bad'))),
            statTile('eta', t.eta || '—', null, 'muted'),
          ],
          onClick: function () {
            var b = H.el('div');
            b.appendChild(H.row('Task', t.task_id || '—'));
            b.appendChild(H.row('Type / status', (t.task_type || '?') + ' · ' + (t.status || '?')));
            b.appendChild(H.row('Difficulty now', d == null ? '—' : d + ' of 64'));
            b.appendChild(H.row('Curve target', t.difficulty_target == null
              ? '—' : H.fmtInt(t.difficulty_target)));
            b.appendChild(H.row('Progress', Math.round(pctOf(t.percent_complete)) + '%'));
            b.appendChild(H.row('ETA', t.eta || '—'));
            H.drawer('Proof — ' + (t.task_id || '?'), b);
          },
        });
      },
      pageSize: 50,
      filters: [
        { key: 'q', type: 'text', placeholder: 'filter task / struct id' },
        { key: 'type', type: 'select', options: [
          { value: '', label: 'all types' }, 'MINE', 'REFINE', 'BUILD', 'RAID' ] },
        { key: 'status', type: 'select', options: [
          { value: '', label: 'any status' }, 'running', 'waiting', 'completed' ] },
      ],
      filterFn: function (t, v) {
        if (v.type && t.task_type !== v.type) return false;
        if (v.status && String(t.status) !== v.status) return false;
        if (v.q && String(t.task_id || '').toLowerCase().indexOf(String(v.q).toLowerCase()) < 0) return false;
        return true;
      },
      sortKeys: WORK_KEYS,
      sortAccessors: WORK_ACC,
      sort: workState.sort,
      empty: 'no tasks match',
    });
    // Solve rate sits ABOVE the task list: it is the summary that tells you
    // whether the queue is moving at all, and below a 750-row list nobody
    // scrolls far enough to find it.
    var pbody = H.el('div'); pbody.id = 'work-pow';
    workState.powCard = H.card('SOLVE RATE (24h)', pbody);
    body.appendChild(workState.powCard);

    body.appendChild(H.card('TASKS', workState.lv.node));

  }

  function renderWorkBody() {
    var d = workState.data; if (!d) return;
    buildWorkSkeleton();

    var c = d.counts || {};
    var hc = d.hash_config || {};
    var qbody = document.getElementById('work-queue');
    qbody.innerHTML = '';
    qbody.appendChild(H.row('Running / Waiting / Done', (c.running || 0) + ' / ' + (c.waiting || 0) + ' / ' + (c.completed || 0), 'icon-in-progress'));
    qbody.appendChild(H.row('Engine', (hc.effective_engine || '?') + (hc.gpu_available ? ' (GPU available)' : '')));
    // Raw config keys as a row label — the only place on the board that spoke
  // snake_case at the operator.
  qbody.appendChild(H.row('Start grinding at difficulty',
    hc.difficulty_start + ' of 64' + (hc.auto_tune ? '  · auto-tuned' : '')));
  qbody.appendChild(H.row('Concurrent proofs', hc.max_concurrent));

    workState.lv.setRows(d.tasks || []);

    // How fast the machine actually solves — telemetry has recorded this since
    // the reliability work landed and nothing ever showed it, so "is the GPU
    // engine doing anything for us" was unanswerable from the dashboard.
    var pow = d.pow_stats;
    var pbody = document.getElementById('work-pow');
    pbody.innerHTML = '';
    if (pow && pow.error) {
      pbody.appendChild(H.stateBlock('error', 'solve stats unavailable: ' + pow.error));
      workState.powCard.hidden = false;
    } else {
      var engines = Array.isArray(pow) ? pow : [];
      engines.sort(function (a, b) { return (b.solves || 0) - (a.solves || 0); });
      engines.forEach(function (e2) {
        pbody.appendChild(H.resultRow({
          icon: 'icon-computer',
          title: String(e2.engine || '?').toUpperCase(),
          // The solve count is already the first tile; repeating it unformatted
          // in the subtitle just gave the same number two different spellings.
          subtitle: 'proof engine',
          chips: [
            statTile('solves', H.fmtInt(e2.solves)),
            statTile('median', H.duration((e2.median_duration_ms || 0) / 1000)),
            // null = the sample is too small for a percentile to mean
            // anything (see telemetry::pow_stats). Say that, don't print a
            // number that is really just the slowest solve.
            statTile('p90', e2.p90_duration_ms == null
              ? 'n<' + (e2.p90_min_samples || 10)
              : H.duration(e2.p90_duration_ms / 1000),
              null, e2.p90_duration_ms == null ? 'muted' : ''),
            statTile('median diff', e2.median_difficulty == null ? '—' : e2.median_difficulty),
            statTile('hashrate', e2.est_hashrate_hps == null
              ? 'n<' + (e2.p90_min_samples || 10) : H.fmtNum(e2.est_hashrate_hps) + 'H/s',
              null, e2.est_hashrate_hps == null ? 'muted' : ''),
          ],
        }));
      });
      workState.powCard.hidden = !engines.length;
    }

  }
  function renderWork() {
    return Board.T.core.invoke('mcp_work').then(function (d) {
      workState.data = d; renderWorkBody();
    }).catch(function (e) {
      // Don't tear the page down on a transient read failure — the skeleton
      // (and whatever sort/page/filter you set) should survive it.
      var body = document.getElementById('work-body');
      if (!workState.built) body.innerHTML = '';
      var note = document.getElementById('work-error') || H.el('div');
      note.id = 'work-error';
      note.innerHTML = '';
      note.appendChild(H.stateBlock('error', 'work unavailable: ' + e));
      body.insertBefore(note, body.firstChild);
    });
  }
  Board.registerPage('work', { refresh: renderWork, cadenceMs: 5000, onEnter: renderWork });

  // ═══════════════════════════ INVENTORY ════════════════════════════════════
  // Balances, the durable ledger, and — for Alpha only — transfers.
  //
  // ORE GETS NO TRANSFER CONTROL. Not a disabled one: absent, with the reason
  // stated. Ore is not a bank asset (it lives in the planet grid), MsgPlayerSend
  // is a bank send, and the only ways ore moves are refining it into Alpha or
  // losing it in battle. A greyed-out button here would read as "not right now"
  // when the truth is "never".
  var invState = {
    player: 'primary', data: null, history: null, page: 1, loadingHistory: false,
  };

  function invDenoms() { return (invState.data && invState.data.denoms) || {}; }
  function balanceOf(denom) {
    var a = ((invState.data && invState.data.assets) || []).find(function (x) { return x.denom === denom; });
    return a ? a.amount : 0;
  }

  // A balance row. `sendable` decides whether an action control exists at all.
  function assetRow(a) {
    var reg = invDenoms();
    var act = null;
    if (a.sendable) {
      act = H.el('div', 'cfg-actions');
      var b = massBtn('', 'icon-send-alpha', 'Send', 'sui-mod-secondary');
      b.addEventListener('click', function () { openTransfer(a.denom); });
      act.appendChild(b);
    }
    return H.resultRow({
      icon: a.denom === 'ore' ? 'sui-icon-alpha-ore' : 'sui-icon-alpha-matter',
      title: H.denomName(a.denom, reg),
      // The chain name is always one line away, and the reason a read-only
      // asset is read-only is stated rather than implied by a missing button.
      // Short here; the card footnote and the drawer carry the full reason.
      subtitle: a.denom + (a.sendable ? '' : ' · not transferable'),
      chips: [statTile('balance', H.denomQty(a.amount, a.denom, reg))],
      action: act,
      onClick: function () {
        var d = H.el('div');
        d.appendChild(H.row('Asset', H.denomName(a.denom, reg, { style: 'both' })));
        d.appendChild(H.row('Balance', H.denomQty(a.amount, a.denom, reg)));
        d.appendChild(H.row('Balance (base units)', H.fmtInt(a.amount)));
        d.appendChild(H.row('Transferable', a.sendable ? 'yes' : 'no'));
        if (a.note) d.appendChild(H.stateBlock('info', a.note));
        H.drawer('Asset — ' + H.denomName(a.denom, reg), d);
      },
    });
  }

  // ── Transfer ──────────────────────────────────────────────────────────────
  // Dry-run first and always: the preview names the sender, resolves the
  // destination against the roster, and flags an address we don't know BEFORE
  // anything is signed. The backend re-runs these gates on execute.
  // Was a second copy of what is now H.fact — the confirm dialogue these forms
  // open could not reach it, so it used the label/value ROW instead and the two
  // halves of one flow stopped looking alike.
  var formFact = H.fact;

  function shortAddress(a) {
    a = String(a || '');
    return a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-6) : a;
  }

  function openTransfer(denom) {
    var reg = invDenoms();
    var unit = H.denomName(denom, reg, { tag: false });
    // Alpha and Ore are the two denoms the game has a display ladder for, so
    // their amount field offers the game's own units (μg…Tg). A guild token has
    // no ladder — it has one exponent and two published names — so it gets a
    // plain field in its display unit.
    var kind = denom === 'ualpha' ? 'alpha' : (denom === 'ore' ? 'ore' : null);
    var info = reg[denom] || {};
    var scale = Math.pow(10, info.exponent || 0);
    var available = balanceOf(denom);
    var form = H.el('div');
    var to = '', amountBase = 0, preview = null;

    // FROM and ASSET are facts, not fields — they were rendered as labelled
    // inputs, so a 44-character address sat in a 332px two-column row and
    // collided with its own label.
    var me = invState.data.player;
    form.appendChild(formFact('From',
      (me.name || '?') + ' · ' + shortAddress(me.address), me.address));
    form.appendChild(formFact('Asset', H.denomName(denom, reg, { style: 'both' })));
    form.appendChild(formFact('Available', H.denomQty(available, denom, reg)));

    form.appendChild(H.field('To', H.textBox(to, 'structs1…', function (v) {
      to = v.trim();
      schedule();
    })));

    if (kind) {
      form.appendChild(H.amountField('Amount', {
        kind: kind, max: available,
        onChange: function (base) { amountBase = base; schedule(); },
      }));
    } else {
      form.appendChild(H.field('Amount (' + unit + ')',
        H.textBox('', '0', function (v) {
          amountBase = Math.round((Number(v) || 0) * scale);
          schedule();
        })));
    }

    // ── One review, always on screen ─────────────────────────────────────────
    // This used to be Preview → Send → confirm: three deliberate steps, and
    // because the review rendered at the BOTTOM of a drawer that was clipped by
    // the panel frame, the middle one was frequently off screen entirely.
    //
    // Now the dry run is AMBIENT — it re-runs as you type, the same idiom the
    // Sweep button uses — and the only button is the irreversible one, pinned
    // to the bottom of the drawer where it is always reachable. The backend
    // re-runs every gate on execute regardless of what this showed.
    var out = H.el('div');
    form.appendChild(out);

    var cta = H.el('div', 'drawer-cta');
    var go = massBtn('', 'icon-send-alpha', 'Send', 'sui-mod-destructive');
    cta.appendChild(go);
    form.appendChild(cta);

    function setReady(on) {
      go.classList.toggle('sui-mod-disabled', !on);
    }
    setReady(false);

    var timer = null;
    function schedule() {
      preview = null;
      setReady(false);
      clearTimeout(timer);
      if (!to || !amountBase) { out.innerHTML = ''; return; }
      timer = setTimeout(runPreview, 350);
    }

    function runPreview() {
      var seq = ++runPreview.seq;
      out.innerHTML = '';
      out.appendChild(H.stateBlock('loading', 'checking…'));
      Board.T.core.invoke('mcp_transfer_preview', {
        from: invState.player, to: to, denom: denom, amount: amountBase,
      }).then(function (p) {
        if (seq !== runPreview.seq) return;   // a later keystroke won
        out.innerHTML = '';
        (p.problems || []).forEach(function (x) {
          out.appendChild(H.stateBlock('error', x));
        });
        if (!p.ok) return;
        preview = p;
        // Who is actually on the other end. An address we can't name is
        // called out as external rather than shown as a bare string.
        out.appendChild(p.recipient
          ? H.stateBlock('info', 'Recipient: ' + p.recipient)
          : H.stateBlock('warning', 'Recipient: EXTERNAL address — not one of your players'));
        out.appendChild(formFact('Sending', H.denomQty(p.amount, denom, reg)
          + ' (' + H.fmtInt(p.amount) + ' ' + denom + ')'));
        out.appendChild(formFact('To', shortAddress(p.to), p.to));
        out.appendChild(formFact('Signed via', p.route));
        // The button deliberately does NOT repeat the amount: SUI uppercases
        // button labels, which turned "Send 2g" into "SEND 2G" — a unit the
        // game does not have. The review line directly above it carries the
        // figure in both units.
        setReady(true);
      }).catch(function (e) {
        if (seq !== runPreview.seq) return;
        out.innerHTML = '';
        out.appendChild(H.stateBlock('error', String(e)));
      });
    }
    runPreview.seq = 0;

    go.addEventListener('click', function () {
      var p = preview;
      if (!p) return;
      var body = H.el('div');
      // No caveat line. "Irreversible — the funds leave X immediately" restated
      // what Send means; the attention rail, the destructive CTA and the four
      // facts below are the warning.
      // The confirm never shows the cosmetic name alone.
      body.appendChild(H.fact('Asset', H.denomName(denom, reg, { style: 'both' })));
      body.appendChild(H.fact('Amount', H.denomQty(p.amount, denom, reg)
        + ' (' + H.fmtInt(p.amount) + ' base units)'));
      body.appendChild(H.fact('From', p.from.name + ' · ' + p.from.address));
      body.appendChild(H.fact('To', (p.recipient || 'EXTERNAL') + ' · ' + p.to));
      H.confirmModal('Send ' + H.denomName(denom, reg, { style: 'both' }) + '?',
        body, 'Send', function () {
          out.innerHTML = '';
          out.appendChild(H.stateBlock('loading', 'signing…'));
          setReady(false);
          Board.T.core.invoke('mcp_transfer_execute', {
            from: invState.player, to: p.to, denom: denom, amount: p.amount,
          }).then(function () {
            out.innerHTML = '';
            out.appendChild(H.stateBlock('info', 'sent'));
            renderInventory();
          }).catch(function (e) {
            out.innerHTML = '';
            out.appendChild(H.stateBlock('error', String(e)));
            setReady(true);
          });
        });
    });

    H.drawer('Send ' + H.denomName(denom, reg, { tag: false }), form);
  }

  // ── Ledger ────────────────────────────────────────────────────────────────
  var LEDGER_ICON = {
    mined: 'icon-mine', refined: 'icon-refine', sent: 'icon-outgoing',
    received: 'icon-incoming', seized: 'icon-raid', forfeited: 'icon-wreckage',
    minted: 'icon-add', burned: 'icon-subtract', infused: 'icon-send-alpha',
  };
  // Postgres emits `2026-07-26 02:01:38.870569+00` — a space separator and a
  // TWO-digit UTC offset. ISO 8601 requires `T` and `+00:00`, so a bare
  // Date.parse returns NaN and every row's timestamp rendered as "—".
  function parseLedgerTime(t) {
    if (!t) return NaN;
    return Date.parse(String(t).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  }

  function ledgerRow(r, addresses) {
    var reg = invDenoms();
    var credit = String(r.direction || '') === 'credit';
    var who = r.counterparty_player_id || addresses[r.counterparty] || r.counterparty;
    var when = parseLedgerTime(r.time);
    // `amount_base` is the backend's single convention (base units); `precise`
    // is false when it had to be reconstructed from the Guild ledger's floored
    // display value.
    //
    // The imprecision marker used to be a leading `~`, which landed directly
    // after the direction sign — "+ ~1 Alpha" — and in the game's pixel font a
    // tilde beside a plus reads as a MINUS. A credit looked like a debit. The
    // marker is now a dotted underline on the figure itself, which cannot be
    // mistaken for arithmetic.
    var qty = H.denomQty(r.amount_base, r.denom, reg);
    // The ladder names a unit ("1g"), not an asset, and a ledger row has no
    // other place that says which asset moved.
    var assetName = H.denomName(r.denom, reg, { tag: false });
    var title = H.el('span');
    title.appendChild(document.createTextNode(credit ? '+' : '−'));
    var amt = H.el('span', r.precise === false ? 'approx' : null, qty);
    if (r.precise === false) {
      amt.title = 'the Guild ledger reports this row in whole display units only — the true value may be a fraction higher';
    }
    title.appendChild(amt);
    title.appendChild(document.createTextNode(' ' + assetName));
    return H.resultRow({
      icon: LEDGER_ICON[r.action] || (credit ? 'icon-incoming' : 'icon-outgoing'),
      title: title,
      subtitle: (r.action || '?') + (who ? ' · ' + who : '')
        + (r.block_height ? ' · block ' + H.fmtInt(r.block_height) : ''),
      // Relative time scans far better than a full timestamp in a list; the
      // exact one is a click away in the drawer.
      chips: [statTile('when', isNaN(when) ? '—' : H.ago(when), null, 'muted')],
      onClick: function () {
        var d = H.el('div');
        d.appendChild(H.row('Action', r.action));
        d.appendChild(H.row('Direction', r.direction));
        // Row detail is one of the places the chain name must be visible.
        d.appendChild(H.row('Asset', H.denomName(r.denom, reg, { style: 'both' })));
        d.appendChild(H.row('Amount', qty + ' (' + H.fmtInt(r.amount_base) + ' base units)'));
        if (r.precise === false) {
          d.appendChild(H.stateBlock('info',
            'The Guild ledger reports this row only in whole display units, so the '
            + 'value is reconstructed and may be short by a fraction. Live GRASS '
            + 'events carry the exact figure.'));
        }
        d.appendChild(H.row('Address', r.address || '—'));
        if (r.counterparty) d.appendChild(H.row('Counterparty', who + ' · ' + r.counterparty));
        if (r.block_height) d.appendChild(H.row('Block', H.fmtInt(r.block_height)));
        if (r.time) d.appendChild(H.row('Time', r.time));
        H.drawer('Ledger entry', d);
      },
    });
  }

  function loadHistory(page) {
    invState.loadingHistory = true;
    return Board.T.core.invoke('mcp_inventory_history', {
      player: invState.player, page: page,
    }).then(function (h) {
      invState.history = h; invState.page = page;
    }).catch(function (e) {
      invState.history = { _err: String(e) };
    }).then(function () { invState.loadingHistory = false; });
  }

  function renderInventoryBody() {
    var d = invState.data;
    return H.renderInto('inventory-body', function (body) {
      if (!d) { body.appendChild(H.stateBlock('loading', 'loading…')); return; }

      // ── Scope ────────────────────────────────────────────────────────────
      // A <select> of every virtual player was 1,822 <option> nodes — 150 KB of
      // DOM and a menu nobody can find a name in. A datalist-backed text field
      // is the same control the operator would reach for anyway: type part of a
      // name or id, pick, done. The list is capped because the browser renders
      // the whole popup; the field still accepts any id you type.
      var opts = [{ value: 'primary', label: 'primary' }];
      (armada.rows || []).forEach(function (r) {
        if (r.index == null) return;
        opts.push({ value: r.player_id, label: r.name + ' (' + r.player_id + ')' });
      });
      var head = H.el('div');
      var pickId = 'inv-players';
      var list = H.el('datalist'); list.id = pickId;
      opts.slice(0, 400).forEach(function (o) {
        var op = H.el('option'); op.value = o.value; op.label = o.label;
        list.appendChild(op);
      });
      head.appendChild(list);
      var picked = invState.player;
      var pick = H.textBox(invState.player, 'primary, a name, or 1-xxx', function (v) {
        v = String(v || '').trim();
        if (!v) v = 'primary';
        // Accept either the id or the "name (1-xxx)" label the datalist offers.
        var m = /\((1-\d+)\)\s*$/.exec(v);
        if (m) v = m[1];
        else if (v !== 'primary') {
          var hit = opts.find(function (o) {
            return o.value === v || o.label.toLowerCase() === v.toLowerCase();
          });
          v = hit ? hit.value : v;
        }
        if (v === picked) return;
        picked = v;
        invState.player = v; invState.page = 1; invState.history = null;
        renderInventory();
      });
      pick.setAttribute('list', pickId);
      head.appendChild(H.field('Player', pick,
        opts.length - 1 + ' virtual players in the roster cache'));
      var t = d.team || {};
      head.appendChild(H.resultRow({
        icon: 'icon-group',
        title: 'Team total',
        subtitle: H.fmtInt(t.players) + ' player(s) in the roster cache',
        chips: [
          statTile('alpha', alpha(t.alpha_ualpha || 0), 'sui-icon-alpha-matter'),
          statTile('ore', ore(t.ore || 0), 'sui-icon-alpha-ore'),
        ],
      }));
      body.appendChild(H.card('SCOPE', head));

      var abody = H.el('div');
      if (d.bank_error) abody.appendChild(H.stateBlock('error', 'bank read failed: ' + d.bank_error));
      var assets = d.assets || [];
      if (!assets.length) abody.appendChild(H.stateBlock('empty', 'no assets held'));
      assets.forEach(function (a) { abody.appendChild(assetRow(a)); });
      // Why ore has no Send control is carried by the row itself ("not
      // transferable") and by its detail drawer; docs/team-ops.md has the rest.
      body.appendChild(H.card('BALANCES', abody));

      var hbody = H.el('div');
      var h = invState.history;
      if (!h) {
        hbody.appendChild(H.stateBlock('loading', 'loading ledger…'));
      } else if (h._err) {
        hbody.appendChild(H.stateBlock('error', h._err));
      } else {
        var rows = h.rows || [];
        if (!rows.length) {
          hbody.appendChild(H.stateBlock('empty', 'no ledger entries on this page'));
        } else {
          var addrs = h.addresses || {};
          rows.forEach(function (r) { hbody.appendChild(ledgerRow(r, addrs)); });
        }
        var nav = H.el('div', 'cfg-actions');
        if (invState.page > 1) {
          var prev = massBtn('', 'icon-chevron-left', 'Newer', 'sui-mod-secondary');
          prev.addEventListener('click', function () {
            loadHistory(invState.page - 1).then(renderInventoryBody);
          });
          nav.appendChild(prev);
        }
        if (h.has_more) {
          var next = massBtn('', 'icon-chevron-right', 'Older', 'sui-mod-secondary');
          next.addEventListener('click', function () {
            loadHistory(invState.page + 1).then(renderInventoryBody);
          });
          nav.appendChild(next);
        }
        if (nav.childNodes.length) hbody.appendChild(nav);
      }
      // The page number is a property of the card, not a sentence under it.
      body.appendChild(H.card('HISTORY · GUILD LEDGER · page ' + invState.page, hbody));
    });
  }

  function renderInventory() {
    // The player selector needs the roster, and Inventory may well be the
    // first page opened this session — take the cache without waiting on a
    // sweep rather than showing a one-entry dropdown.
    var roster = armada.rows.length
      ? Promise.resolve()
      : Board.T.core.invoke('mcp_roster', {}).then(function (snap) {
        armada.rows = (snap && snap.rows) || [];
      }).catch(function () {});
    return roster
      .then(function () { return Board.T.core.invoke('mcp_inventory', { player: invState.player }); })
      .then(function (d) {
        invState.data = d;
        return renderInventoryBody();
      })
      .then(function () {
        if (!invState.history && !invState.loadingHistory) {
          return loadHistory(invState.page).then(renderInventoryBody);
        }
      })
      .catch(function (e) {
        return H.renderInto('inventory-body', function (body) {
          body.appendChild(H.stateBlock('error', 'inventory unavailable: ' + e));
        });
      });
  }
  Board.registerPage('inventory', {
    onEnter: renderInventory, refresh: renderInventory, cadenceMs: 30000,
  });

  /* ═══════════════════════════ EXPLORE → PLAYER ════════════════════════════
   *
   * A profile for somebody ELSE. Every other area in Team Ops is about our own
   * roster; this one takes an id, a name or an address and reports on whoever
   * comes back.
   *
   * The shape follows the game's own Account → Profile — Player Details,
   * Power, Statistics — reading the same endpoints so the two cannot disagree
   * about the same player, and drops the parts that only make sense about
   * yourself (renaming, device management). What it adds is what a lookup
   * wants and your own profile has no reason to show: the capacity this player
   * is routing OUT, and what they have staked.
   */
  var exploreState = { q: '', results: null, searching: false, player: null,
                       data: null, error: null, loading: false };

  // Chain entity field names, in one place. `gridAttributes` is where the game
  // keeps the live numbers; the rest sit on the player record.
  function entNum(ent, path) {
    var cur = ent;
    for (var i = 0; i < path.length && cur != null; i++) cur = cur[path[i]];
    if (cur == null) return null;
    var n = typeof cur === 'string' ? Number(cur) : cur;
    return typeof n === 'number' && isFinite(n) ? n : null;
  }
  function entStr(ent, key) {
    var v = ent && ent[key];
    return v == null || v === '' ? null : String(v);
  }

  function exploreSearch(q) {
    exploreState.q = q;
    if (!q.trim()) { exploreState.results = null; return renderExplore(); }
    exploreState.searching = true;
    renderExplore();
    var seq = ++exploreSearch.seq;
    Board.T.core.invoke('mcp_player_search', { query: q }).then(function (r) {
      if (seq !== exploreSearch.seq) return;   // a later keystroke won
      exploreState.searching = false;
      exploreState.results = (r && r.results) || [];
      renderExplore();
    }).catch(function (e) {
      if (seq !== exploreSearch.seq) return;
      exploreState.searching = false;
      exploreState.results = [];
      exploreState.error = String(e);
      renderExplore();
    });
  }
  exploreSearch.seq = 0;

  function exploreOpen(playerId) {
    exploreState.player = playerId;
    exploreState.data = null;
    exploreState.error = null;
    exploreState.loading = true;
    renderExplore();
    var seq = ++exploreOpen.seq;
    Board.T.core.invoke('mcp_player_profile', { player: playerId }).then(function (d) {
      if (seq !== exploreOpen.seq) return;
      exploreState.loading = false;
      exploreState.data = d;
      renderExplore();
    }).catch(function (e) {
      if (seq !== exploreOpen.seq) return;
      exploreState.loading = false;
      exploreState.error = String(e);
      renderExplore();
    });
  }
  exploreOpen.seq = 0;

  /* The row shape `messageLink` and `spectatorLinks` already take.
   *
   * Both are built for a roster row, and a looked-up player is the same three
   * facts under different key names — so this adapts rather than growing a
   * second pair of icons that would drift from the roster's. */
  function exploreAsRow(ent, pid) {
    return {
      player_id: pid,
      player_name: entStr(ent, 'username') || pid,
      planet_id: entStr(ent, 'planetId'),
      fleet_id: entStr(ent, 'fleetId'),
    };
  }

  function exploreHeader(ent, pid) {
    var row = exploreAsRow(ent, pid);
    var acts = H.el('div', 'ops-row-acts');
    var msg = messageLink(row);
    if (msg) acts.appendChild(msg);
    var spec = spectatorLinks(row);
    if (spec) acts.appendChild(spec);
    return H.resultRow({
      portrait: H.pfpPortrait(entStr(ent, 'pfpClientRenderAttributes')),
      title: row.player_name,
      subtitle: '#' + pid,
      action: acts.childNodes.length ? acts : null,
    });
  }

  function exploreProfile(d) {
    var wrap = H.el('div');
    var ent = (d && d.entity) || {};
    var pid = d.player_id;
    wrap.appendChild(exploreHeader(ent, pid));

    var det = H.el('div');
    det.appendChild(H.row('Guild', entStr(ent, 'guildId') || '—'));
    det.appendChild(H.row('Player ID', pid));
    det.appendChild(H.row('Address', entStr(ent, 'primaryAddress') || '—'));
    wrap.appendChild(H.card('Player Details', det));

    /* Energy the way the game states it: usage over total, counting the
     * structs' draw and the share coming back from the substation. Getting
     * either half wrong makes the number disagree with this player's own HUD. */
    var load = (entNum(ent, ['gridAttributes', 'load']) || 0)
      + (entNum(ent, ['gridAttributes', 'structsLoad']) || 0);
    var total = (entNum(ent, ['gridAttributes', 'capacity']) || 0)
      + (entNum(ent, ['gridAttributes', 'connectionCapacity']) || 0);
    var pow = H.el('div');
    pow.appendChild(H.row('Alpha Matter',
      H.fmtAlpha(entNum(ent, ['playerInventory', 'rocks', 'amount']) || 0)));
    pow.appendChild(H.row('Energy Usage', H.fmtWatts(load) + ' / ' + H.fmtWatts(total)));
    pow.appendChild(H.row('Ore', H.fmtOre(entNum(ent, ['gridAttributes', 'ore']) || 0)));
    wrap.appendChild(H.card('Power', pow));

    // `null` is not zero: a guild that does not publish one of these leaves a
    // dash rather than claiming the player has never mined.
    var num = function (v, key) {
      if (v == null) return null;
      var n = key ? v[key] : v;
      if (n == null) return null;
      var f = typeof n === 'string' ? Number(n) : n;
      return isFinite(f) ? f : null;
    };
    var dash = function (n, fmt) { return n == null ? '—' : (fmt ? fmt(n) : String(n)); };
    var ore = d.ore_stats || null;
    var st = H.el('div');
    st.appendChild(H.row('Planets Completed', dash(num(d.planets_completed, 'count'))));
    st.appendChild(H.row('Raids Launched', dash(num(d.raids_launched, 'count'))));
    st.appendChild(H.row('Ore Mined', dash(num(ore, 'ore_mined'), H.fmtOre)));
    st.appendChild(H.row('Ore Stolen', dash(num(ore, 'ore_stolen'), H.fmtOre)));
    st.appendChild(H.row('Ore Lost', dash(num(ore, 'ore_lost'), H.fmtOre)));
    wrap.appendChild(H.card('Statistics', st));

    /* What this player is routing OUT, and what they have staked. The two
     * things a lookup wants that your own profile has no reason to show. */
    var allocs = d.allocations || [];
    var aBody = H.el('div');
    if (!d.allocations) aBody.appendChild(H.stateBlock('info', 'not published by this guild'));
    else if (!allocs.length) aBody.appendChild(H.stateBlock('info', 'none'));
    else allocs.forEach(function (a) {
      aBody.appendChild(H.row(
        String(a.id || a.allocation_id || '?') + ' → ' + String(a.destination_id || '?'),
        H.fmtWatts(Number(a.power || a.power_mw || 0))));
    });
    wrap.appendChild(H.card('Outgoing Allocations', aBody));

    var infs = d.infusions || [];
    var iBody = H.el('div');
    if (!d.infusions) iBody.appendChild(H.stateBlock('info', 'not published by this guild'));
    else if (!infs.length) iBody.appendChild(H.stateBlock('info', 'none'));
    else infs.forEach(function (i) {
      iBody.appendChild(H.row(String(i.destination_id || i.reactor_id || i.validator || '?'),
        H.fmtAlpha(Number(i.fuel || i.amount || 0))));
    });
    wrap.appendChild(H.card('Infusions', iBody));

    return wrap;
  }

  function renderExplore() {
    return H.renderInto('explore-body', function (body) {
      // The search is the page's own control, not a card: it is how you get
      // anywhere here at all.
      body.appendChild(H.field('Find a player',
        H.textBox(exploreState.q, 'id, name or address', exploreSearch)));

      if (exploreState.searching) {
        body.appendChild(H.stateBlock('loading', 'searching…'));
      } else if (exploreState.results && !exploreState.results.length) {
        body.appendChild(H.stateBlock('info', 'nobody matches ' + JSON.stringify(exploreState.q)));
      } else if (exploreState.results && exploreState.results.length) {
        var table = H.resultTable();
        var rows = H.el('div', 'sui-result-rows');
        exploreState.results.slice(0, 25).forEach(function (r) {
          var pid = r.player_id || r.id;
          if (!pid) return;
          rows.appendChild(H.resultRow({
            portrait: H.pfpPortrait(r.pfp || r.pfp_attrs
              || r.pfp_client_render_attributes || null),
            title: r.username || r.name || pid,
            subtitle: '#' + pid + (r.guild_id ? ' · ' + r.guild_id : ''),
            onClick: function () { exploreOpen(pid); },
          }));
        });
        table.appendChild(rows);
        body.appendChild(table);
      }

      if (exploreState.loading) {
        body.appendChild(H.stateBlock('loading', 'reading ' + exploreState.player + '…'));
      } else if (exploreState.error) {
        body.appendChild(H.stateBlock('error', exploreState.error));
      } else if (exploreState.data) {
        body.appendChild(exploreProfile(exploreState.data));
      }
    });
  }

  // No cadence: a profile is a thing you asked for, not a feed. Re-reading it
  // every few seconds would move the numbers under the eye that is reading
  // them, and every read is a round trip to somebody else's guild API.
  Board.registerPage('explore', { onEnter: renderExplore });

  // ═══════════════════════════ DIAGNOSTICS ══════════════════════════════════
  // Is the machine itself healthy? Command carries the one-line strip; this is
  // where you come when it says something is wrong. Loop health and the
  // transaction ledger live here rather than on Work, because Work is about
  // the proof-of-work queue and these are about the loops that feed it.
  function renderDiagnostics() {
    return H.renderInto('diag-body', function (body) {
      return Promise.all([
        Board.T.core.invoke('mcp_health').catch(function (e) { return { _err: String(e) }; }),
        Board.T.core.invoke('mcp_work').catch(function (e) { return { _err: String(e) }; }),
      ]).then(function (r) {
        var h = r[0], w = r[1];

        if (h._err) {
          body.appendChild(H.stateBlock('error', 'health unavailable: ' + h._err));
        } else {
          body.appendChild(H.card('SYSTEM HEALTH', Board.healthTiles(h)));
        }
        if (w._err) {
          body.appendChild(H.stateBlock('error', 'telemetry unavailable: ' + w._err));
          return;
        }

        // Loop health carries duration, players scanned and — since the
        // blocked-state work — WHY a loop that is running fine still can't
        // act. All of it was computed and thrown away; a loop firing on time
        // and doing nothing looked identical to a healthy one.
        var lh = w.loop_health || [];
        // `blocked_reason` is STICKY — it keeps the last reason a loop couldn't
        // act, long after a later run acted fine. Reading it as current state
        // painted a red BLOCKED banner on healthy loops (seen live: auto_response
        // blocked at :396, then finished clean at :773). A block counts as
        // current only if it happened during the run that is newest now.
        var isBlocked = function (l) {
          if (!l.blocked_reason) return false;
          var started = l.last_started_ms || 0;
          return !started || (l.blocked_at_ms || 0) >= started;
        };
        var lbody = H.el('div');
        lh.slice().sort(function (a, b) {
          // Anything that needs attention first: blocked, then errors, then noise.
          var rank = function (l) { return isBlocked(l) ? 0 : ((l.errors || 0) > 0 ? 1 : 2); };
          return rank(a) - rank(b) || (b.runs || 0) - (a.runs || 0);
        }).forEach(function (l) {
          var blocked = isBlocked(l);
          var last = l.last_finished_ms || l.last_started_ms;
          // A cleared block is still worth showing — it is the only trace of a
          // loop that spent part of the hour unable to act — just not as an alarm.
          var cleared = !blocked && l.blocked_reason
            ? 'cleared ' + H.ago(l.blocked_at_ms) + ' — was: ' + l.blocked_reason
            : null;
          lbody.appendChild(H.resultRow({
            icon: blocked ? 'icon-blocked' : ((l.errors || 0) > 0 ? 'icon-alert' : 'icon-success'),
            title: l.loop,
            subtitle: blocked ? 'BLOCKED — ' + l.blocked_reason
              : (cleared || ((l.unfinished_runs || 0) > 0
                ? (l.unfinished_runs + ' run(s) still in flight')
                : 'running normally')),
            chips: [
              statTile('runs', l.runs || 0),
              statTile('actions', l.actions || 0, null, (l.actions || 0) ? 'ok' : 'muted'),
              statTile('errors', l.errors || 0, null, (l.errors || 0) ? 'bad' : 'muted'),
              statTile('scanned', H.fmtNum(l.players || 0), null, 'muted'),
              statTile('avg', l.avg_duration_ms == null
                ? '—' : H.duration(l.avg_duration_ms / 1000), null, 'muted'),
              statTile('last run', last ? H.ago(last) : '—', null, 'muted'),
            ],
          }));
        });
        if (!lh.length) lbody.appendChild(H.stateBlock('empty', 'no loop runs recorded in the last hour'));
        body.appendChild(H.card('LOOP HEALTH (1h)', lbody));

        var tx = w.tx_summary || {};
        // Per-context success rate — WHICH kind of transaction is failing,
        // not just which error text is most common.
        var ctxs = (tx.by_context || []).slice(0, 12);
        if (ctxs.length) {
          var cbody = H.el('div');
          ctxs.forEach(function (c2) {
            var att = c2.attempts || 0, ok = c2.successes || 0, fail = c2.failures || 0;
            var rate = att > 0 ? ok / att : 0;
            cbody.appendChild(H.resultRow({
              icon: fail ? 'icon-alert' : 'icon-success',
              title: c2.context || '?',
              subtitle: H.progressBar(rate),
              chips: [
                statTile('attempts', att),
                statTile('ok', ok, null, ok ? 'ok' : 'muted'),
                statTile('failed', fail, null, fail ? 'bad' : 'muted'),
                statTile('skipped', c2.skipped || 0, null, 'muted'),
                statTile('success', Math.round(rate * 100) + '%', null,
                  rate >= 0.9 ? 'ok' : (rate >= 0.5 ? 'live' : 'bad')),
              ],
            }));
          });
          body.appendChild(H.card('TRANSACTIONS BY CONTEXT (1h)', cbody));
        }

        // ── Top errors, collapsed by SHAPE ───────────────────────────────
        // The backend rolls these up by exact reason string, and a chain error
        // carries the failing nonce — so one recurring failure arrived as five
        // separate "1×" rows that differed only in digits. Same fix the event
        // feed already uses: normalise the varying parts, then group.
        //
        // The message also rendered through H.row (a label/value pair), so a
        // long reason wrapped under its own count and was cut at 120 characters
        // — mid-word, and exactly where the useful tail lives.
        var errs = tx.top_errors || [];
        if (errs.length) {
          var shapes = {}, order = [];
          errs.forEach(function (e2) {
            var reason = String(e2.reason || '')
              .replace(/^failed to execute message; message index: \d+: /, '');
            var key = reason.replace(/\d+/g, 'N');
            if (!shapes[key]) { shapes[key] = { reason: reason, count: 0 }; order.push(key); }
            shapes[key].count += (e2.count || 1);
            // Keep the newest-looking example rather than the first.
            shapes[key].reason = reason;
          });
          order.sort(function (a, b) { return shapes[b].count - shapes[a].count; });
          var xbody = H.el('div');
          order.slice(0, 8).forEach(function (k) {
            var g = shapes[k];
            xbody.appendChild(H.resultRow({
              icon: 'icon-alert',
              title: g.reason,
              subtitle: g.count > 1 ? 'one example of ' + g.count + ' with the same shape' : null,
              chips: [statTile('count', H.fmtInt(g.count), null, g.count > 1 ? 'bad' : 'live')],
            }));
          });
          body.appendChild(H.card('TOP TX ERRORS (1h)', xbody));
        }
        Board.stamp('updated ' + new Date().toLocaleTimeString());
      });
    });
  }
  Board.registerPage('diagnostics', {
    onEnter: renderDiagnostics, refresh: renderDiagnostics, cadenceMs: 15000,
  });

  // ═══════════════════════ LIVE RAIDS (opt-in) ══════════════════════════════
  // Every raid running in the galaxy, not only ours — the point is to be able
  // to watch anyone's. Ours are ranked first and badged so the list still
  // answers "is anything happening to me" at a glance.
  //
  // Only reachable while System · Access · Raid View is on; `mcp_raids` guards
  // itself server-side too, so a stale nav can't reach data the flag denies.
  var raidState = { view: null, meta: null };

  // Badge colour per status. SUI badges only ship default/warning/destructive/
  // solid, so anything not listed falls back to the plain badge rather than
  // inventing a modifier. `shieldsVulnerable` is destructive because that is
  // the status that decides the raid: empirically a raid reaching it succeeds,
  // and one that never does has never once succeeded.
  var RAID_STATUS_MOD = {
    initiated: 'warning',
    ongoing: 'warning',
    shieldsVulnerable: 'destructive',
    raidSuccessful: 'destructive',
  };

  function raidStatusLabel(s) {
    // camelCase → spaced words, so `shieldsVulnerable` reads as a phrase.
    return String(s || '?').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }

  function raidRow(r) {
    var who = r.our_side;
    var chips = [];
    if (who && who !== 'none') {
      chips.push(H.badge(
        who === 'defender' ? 'RAID ON US' : (who === 'attacker' ? 'OURS' : 'BOTH OURS'),
        who === 'defender' ? 'destructive' : 'warning'));
    }
    if (r.stale) chips.push(H.badge('STALE'));
    chips.push(H.badge(raidStatusLabel(r.status), RAID_STATUS_MOD[r.status]));
    if (r.seized_ore > 0) chips.push(statTile('ore taken', ore(r.seized_ore), 'icon-alpha-ore'));
    chips.push(statTile('updated', H.duration((Date.now() - r.updated_ms) / 1000) + ' ago'));

    // Attacker → defender, naming whoever we could resolve.
    var sub = (r.attacker || 'unknown fleet owner') + ' → ' + (r.defender || 'unknown planet owner');
    if (r.fleet_id) sub += '  ·  fleet ' + r.fleet_id;

    var watch = canSpectate() ? iconBtn('icon-raid', 'Watch this raid', function (ev) {
      ev.stopPropagation();
      openRaidWindow({ planet_id: r.planet_id });
    }) : null;

    return H.resultRow({
      icon: r.live ? 'icon-raid' : 'icon-combat-log',
      title: 'planet ' + r.planet_id,
      subtitle: sub,
      chips: chips,
      action: watch,
      onClick: function () { showRaidDetail(r); },
    });
  }

  function showRaidDetail(r) {
    var box = H.el('div');
    box.appendChild(H.row('planet', r.planet_id, 'icon-planet'));
    box.appendChild(H.row('defender', r.defender || 'unresolved', 'icon-planetary-shield'));
    box.appendChild(H.row('attacker', r.attacker || 'unresolved', 'icon-raid'));
    box.appendChild(H.row('raiding fleet', r.fleet_id || '—', 'icon-fleet-tile'));
    box.appendChild(H.row('status', raidStatusLabel(r.status), 'icon-combat-log'));
    box.appendChild(H.row('ore seized', ore(r.seized_ore || 0), 'icon-alpha-ore'));
    if (r.stale) {
      box.appendChild(H.stateBlock('warning', 'Abandoned — no status change in over an hour.'));
    }
    var cta = H.el('div', 'cfg-row');
    var close;
    if (!canSpectate()) {
      box.appendChild(H.stateBlock('info',
        'Spectator windows open on the machine running Structs, not in this browser.'));
      close = H.drawer('Raid on ' + r.planet_id, box);
      return;
    }
    var watchPlanet = massBtn('raid-watch-planet', 'icon-planet', 'Watch the planet', 'sui-mod-primary');
    watchPlanet.addEventListener('click', function () {
      // Dismiss the drawer: the window it opens is the thing you wanted, and
      // leaving the panel over it just hides what you asked to see.
      if (close) close();
      openRaidWindow({ planet_id: r.planet_id });
    });
    cta.appendChild(watchPlanet);
    if (r.fleet_id) {
      var follow = massBtn('raid-follow-fleet', 'icon-fleet-tile', 'Follow the fleet');
      follow.addEventListener('click', function () {
        if (close) close();
        openRaidWindow({ fleet_id: r.fleet_id });
      });
      cta.appendChild(follow);
    }
    box.appendChild(cta);
    close = H.drawer('Raid on ' + r.planet_id, box);
  }

  /// Open a spectator window on a planet or a fleet.
  ///
  /// Tauri camelCases command arguments across the bridge, so the Rust
  /// `planet_id` / `fleet_id` parameters are `planetId` / `fleetId` here —
  /// sending the snake_case names delivers nothing at all and the command
  /// refuses with "planet_id or fleet_id required". Same convention as
  /// `refreshIfOlderMs` and `newIndex` elsewhere on this page.
  function openSpectatorWindow(opts) {
    return Board.T.core.invoke('mcp_raid_view_open', {
      planetId: opts.planet_id || null,
      fleetId: opts.fleet_id || null,
    });
  }

  /// Live Raids' wrapper: same call, with the failure reported above that list.
  /// The Armada roster calls `openSpectatorWindow` directly and reports its own
  /// failures where the click happened — a shared notice would have written
  /// into `raids-body`, which does not exist on the roster page, and the error
  /// would have vanished.
  function openRaidWindow(opts) {
    raidNotice(null);
    return openSpectatorWindow(opts).catch(function (e) {
      raidNotice('could not open the spectator window: ' + e);
    });
  }

  /// One notice line above the list, replaced rather than appended — clicking
  /// a broken button three times should say one thing, not stack three copies.
  function raidNotice(text) {
    var body = document.getElementById('raids-body');
    if (!body) return;
    var old = document.getElementById('raid-notice');
    if (old) old.parentNode.removeChild(old);
    if (!text) return;
    var n = H.stateBlock('error', text);
    n.id = 'raid-notice';
    body.insertBefore(n, body.firstChild);
  }

  function buildRaidList() {
    return H.listView({
      pageSize: 40,
      key: function (r) { return r.planet_id; },
      sig: function (r) { return r.status + '|' + r.updated_ms + '|' + r.our_side + '|' + r.seized_ore; },
      render: raidRow,
      empty: 'no raids recorded recently — the galaxy is quiet',
      filters: [
        { key: 'q', type: 'text', placeholder: 'planet, player or fleet' },
        { key: 'ours', type: 'toggle', label: 'ours only' },
        { key: 'live', type: 'toggle', label: 'live only' },
      ],
      filterFn: function (r, v) {
        if (v.ours && (!r.our_side || r.our_side === 'none')) return false;
        if (v.live && !r.live) return false;
        if (v.q) {
          var hay = [r.planet_id, r.fleet_id, r.attacker, r.defender, r.status]
            .join(' ').toLowerCase();
          if (hay.indexOf(v.q.toLowerCase()) < 0) return false;
        }
        return true;
      },
      sortKeys: [
        { key: 'relevance', label: 'ours first' },
        { key: 'updated', label: 'most recent' },
        { key: 'ore', label: 'ore seized' },
      ],
      sortAccessors: {
        // Mirrors the Rust-side sort_raids ranking so toggling back to the
        // default ordering reproduces exactly what the backend sent.
        relevance: function (r) {
          var ours = r.our_side && r.our_side !== 'none';
          if (ours && r.live) return 0;
          if (r.live) return 1;
          if (ours && r.stale) return 2;
          if (r.stale) return 3;
          return ours ? 4 : 5;
        },
        updated: function (r) { return -r.updated_ms; },
        ore: function (r) { return -(r.seized_ore || 0); },
      },
    });
  }

  function renderRaids() {
    return Board.T.core.invoke('mcp_raids').then(function (d) {
      raidState.meta = d;
      var body = document.getElementById('raids-body');
      if (!raidState.view) {
        body.innerHTML = '';
        var head = H.el('div', 'hstrip');
        head.appendChild(statTile('live now', d.live, null, d.live ? 'live' : 'muted'));
        head.appendChild(statTile('involving us', d.ours, null, d.ours ? 'bad' : 'muted'));
        head.appendChild(statTile('tracked', (d.raids || []).length));
        body.appendChild(H.card('RAIDS', head));
        raidState.view = buildRaidList();
        body.appendChild(H.card('ALL RAIDS', raidState.view.node));
        if (d.unidentified > 0) {
          // Say it rather than let a capped list read as a complete one.
          body.appendChild(H.stateBlock('info', d.unidentified +
            ' older raid(s) unnamed — identity lookups are capped per refresh.'));
        }
      } else {
        var tiles = body.querySelectorAll('.hstrip .fstat .fstat-v');
        if (tiles.length >= 3) {
          tiles[0].firstChild.nodeValue = String(d.live);
          tiles[1].firstChild.nodeValue = String(d.ours);
          tiles[2].firstChild.nodeValue = String((d.raids || []).length);
        }
      }
      raidState.view.setRows(d.raids || []);
    }).catch(function (e) {
      var body = document.getElementById('raids-body');
      body.innerHTML = '';
      raidState.view = null;
      body.appendChild(H.alertLine('raids unavailable: ' + e, 'icon-alert'));
    });
  }

  Board.registerPage('raids', {
    onEnter: renderRaids, refresh: renderRaids, cadenceMs: 10000,
  });

  // ═══════════════════════════ TX ═══════════════════════════════════════════
  // The primary's live signing queue (via the txq bridge) + the whole team's
  // recent tx results (telemetry). The queue emits no non-terminal events, so
  // this page polls; `refreshing` stops calls from stacking on a slow bridge.
  var txState = { data: null, notice: null, refreshing: false };

  function txMutate(op, id) {
    Board.T.core.invoke('mcp_tx_mutate', { op: op, id: id, newIndex: null }).then(function (r) {
      if (r && r.ok === false) {
        txState.notice = 'refused — item is in flight or already gone';
      } else {
        txState.notice = null;
      }
      if (r && r.snapshot && txState.data) {
        txState.data.queue = r.snapshot;
        txState.data.queue_error = null;
      }
      renderTxBody();
    }).catch(function (e) {
      txState.notice = 'action failed: ' + e;
      renderTxBody();
    });
  }

  // One queue row: identity on the left, ETA/progress/controls on the right.
  function txRow(t, pos, total, etas, percents, withOrder) {
    var r = H.el('div', 'sui-data-card-row');
    var left = H.el('span');
    if (pos != null) left.appendChild(H.el('span', 'tx-pos', pos + '.'));
    left.appendChild(document.createTextNode(' ' + (t.type_short || t.type_url || '?')));
    if (t.charge_cost > 0) left.appendChild(H.el('span', 'ops-muted', ' ⚡' + t.charge_cost));
    if (t.attempts > 0) {
      left.appendChild(H.el('span', 'attn', ' try ' + t.attempts + (t.retry_limit > 0 ? '/' + t.retry_limit : '')));
    }
    var right = H.el('span', 'ops-val');
    var eta = etas && etas[t.id];
    if (eta && eta.blocksRemaining != null) {
      right.appendChild(H.el('span', 'ops-muted', eta.blocksRemaining + ' blk · ~' +
        Math.max(0, Math.round((eta.etaMs || 0) / 1000)) + 's '));
    }
    if (percents && percents[t.id] != null) {
      var bar = H.progressBar((percents[t.id] || 0) / 100);
      bar.style.width = '52px'; bar.style.display = 'inline-block';
      right.appendChild(bar);
    }
    var btns = H.el('span', 'tx-btns');
    function ctl(iconCls, title, op, hidden) {
      if (hidden) return;
      var a = H.el('a', 'ops-refresh-btn'); a.href = 'javascript:void(0)'; a.title = title;
      a.appendChild(H.el('i', iconCls));
      a.addEventListener('click', function (ev) { ev.stopPropagation(); txMutate(op, t.id); });
      btns.appendChild(a);
    }
    if (withOrder) {
      ctl('icon-caret-up', 'Move up', 'move_up', pos === 1);
      ctl('icon-caret-down', 'Move down', 'move_down', pos === total);
    }
    ctl('icon-close', 'Cancel', 'cancel', false);
    right.appendChild(btns);
    r.appendChild(left);
    r.appendChild(right);
    return r;
  }

  function renderTxBody() {
    var d = txState.data; if (!d) return;
    var body = document.getElementById('tx-body');
    body.innerHTML = '';
    if (txState.notice) body.appendChild(H.alertLine(txState.notice, 'icon-alert'));
    var q = d.queue;
    if (!q) {
      body.appendChild(H.alertLine('signing queue unavailable — sign in on the game window' +
        (d.queue_error ? ' (' + d.queue_error + ')' : ''), 'icon-alert'));
    } else {
      // IN FLIGHT
      var fbody = H.el('div');
      if (q.in_flight) {
        fbody.appendChild(txRow(q.in_flight, null, 0, null, null, false));
        // No controls make sense here: the queue refuses in-flight mutation.
        var ifBtns = fbody.lastChild.querySelector('.tx-btns');
        if (ifBtns) ifBtns.remove();
      } else {
        fbody.appendChild(H.el('div', 'ops-muted', 'nothing broadcasting'));
      }
      body.appendChild(H.card('IN FLIGHT', fbody));

      // ACTION QUEUE (ordered, charge-gated)
      var abody = H.el('div');
      var aq = q.action_queue || [];
      if (aq.length) {
        aq.forEach(function (t, i) {
          abody.appendChild(txRow(t, i + 1, aq.length, q.etas, q.percents, true));
        });
      } else {
        abody.appendChild(H.el('div', 'ops-muted', 'no queued actions'));
      }
      body.appendChild(H.card('ACTION QUEUE — PRIMARY (' + aq.length + ')', abody));

      // IMMEDIATE QUEUE (FIFO)
      var iq = q.immediate_queue || [];
      if (iq.length) {
        var ibody = H.el('div');
        iq.forEach(function (t) { ibody.appendChild(txRow(t, null, 0, null, null, false)); });
        body.appendChild(H.card('IMMEDIATE QUEUE — PRIMARY (' + iq.length + ')', ibody));
      }
    }

    // RECENT RESULTS (whole team, telemetry)
    var hist = d.history || [];
    var hbody = H.el('div');
    if (d.history_error) {
      hbody.appendChild(H.el('div', 'ops-muted', 'history unavailable: ' + d.history_error));
    } else if (!hist.length) {
      hbody.appendChild(H.el('div', 'ops-muted', 'no recent transactions'));
    } else {
      hist.forEach(function (h) {
        var r = H.el('div', 'sui-data-card-row');
        var left = H.el('span');
        var ok = h.outcome === 'success';
        // Success is the boring case and it is 50 rows out of 50 — a solid
        // filled badge on every one of them shouted the least informative
        // thing on the page. Quiet the routine outcome so a failure is what
        // the eye lands on.
        // Success is the boring case and it was 50 rows out of 50 — `solid`
        // put a filled block on every one, shouting the least informative
        // thing on the page. SUI ships exactly four badge variants
        // (default / warning / destructive / solid), so this is the honest
        // severity ladder within the system: outlined for routine, amber for
        // "didn't happen", red for failed.
        left.appendChild(H.badge(h.outcome.replace('_', ' ').toUpperCase(),
          ok ? 'default' : h.outcome === 'skipped' ? 'warning' : 'destructive'));
        left.appendChild(document.createTextNode(' ' + (h.action || '').replace(/^.*Msg/, '') +
          ' · ' + (h.player_id || h.context || '?')));
        var right = H.el('span', 'ops-val');
        var note = ok
          ? (h.tx_hash ? String(h.tx_hash).slice(0, 10) + '…' : 'ok')
          // Drop the chain boilerplate prefix ("failed to execute message;
          // message index: 0: ") and widen — otherwise the diagnostic tail
          // (e.g. "(required: 1, available: 1)", which distinguishes a
          // build-count cap from a power shortage) gets truncated away.
          : String(h.translated || h.raw_error || '')
              .replace(/^failed to execute message; message index: \d+: /, '')
              .slice(0, 160);
        right.appendChild(H.el('span', ok ? 'ops-muted' : 'attn', note + ' · ' + H.ago(h.ts_ms)));
        r.appendChild(left); r.appendChild(right);
        hbody.appendChild(r);
      });
    }
    body.appendChild(H.card('RECENT RESULTS — WHOLE TEAM (14d)', hbody));
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }

  function renderTx() {
    if (txState.refreshing) return Promise.resolve();
    txState.refreshing = true;
    return Board.T.core.invoke('mcp_tx_snapshot').then(function (d) {
      txState.data = d;
      // A fresh good poll clears a stale refusal notice.
      if (d && d.queue && txState.notice && txState.notice.indexOf('refused') === 0) txState.notice = null;
      renderTxBody();
    }).catch(function (e) {
      var body = document.getElementById('tx-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('tx data unavailable: ' + e, 'icon-alert'));
    }).then(function () { txState.refreshing = false; });
  }
  Board.registerPage('tx', { refresh: renderTx, cadenceMs: 2500, onEnter: renderTx });

  // ═══════════════════════════ GRASS ════════════════════════════════════════
  // Live tail of the full game-event stream. ONE generic renderer for every
  // category — no per-message-type UI. Events arrive via the Rust relay
  // ('grass-event'); a back-fill seeds from the event ring buffer.
  // How much history the client keeps. The Rust ring holds the same, so a
  // back-fill can refill the whole window after a reconnect.
  var GRASS_MAX = 2000;
  // How much of it is in the DOM at once. Kept separate on purpose: 2000 rows
  // is ~24,000 nodes, and this list is rebuilt whenever names resolve, so an
  // uncapped render would be the same 22k-node stall the roster used to have.
  // "Show more" raises it by a page when you actually need to read further.
  var GRASS_RENDER_STEP = 500;
  // Declared AFTER the constants it reads: `var` hoists the declaration but
  // not the value, so initialising renderCap above them left it undefined and
  // the render loop's `matched.length < renderCap` was false from the start —
  // the list stayed empty while the count said 2000 buffered.
  var grassState = { rows: [], paused: false, cat: '', text: '', cats: [], built: false,
    renderQueued: false, lookups: {}, renderCap: GRASS_RENDER_STEP, keys: null };

  // Merge partial {players:{id:name}, guilds:{…}, struct_types:{…}, structs:{…}}
  // maps into the client lookup state (backfill + live grass-lookups events).
  function grassMergeLookups(part) {
    if (!part || typeof part !== 'object') return;
    Object.keys(part).forEach(function (kind) {
      var src = part[kind];
      if (!src || typeof src !== 'object') return;
      var dst = grassState.lookups[kind] = grassState.lookups[kind] || {};
      Object.keys(src).forEach(function (id) { if (src[id]) dst[id] = src[id]; });
    });
  }

  function grassHue(cat) {
    var h = 0;
    for (var i = 0; i < cat.length; i++) h = ((h * 31) + cat.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  // ── Enrichment-aware value formatting: ONE key-driven rule table for every
  // category (no per-message templates). Uses the game's own semantics:
  // status bitmask, server display ladders, and id→name lookups.
  var STRUCT_FLAGS = [[1, 'mat'], [2, 'built'], [4, 'online'], [8, 'stored'],
    [16, 'HIDDEN'], [32, 'DESTROYED'], [64, 'LOCKED']];
  function decodeStatus(v) {
    var n = Number(v);
    if (isNaN(n)) return String(v);
    if (n === 0) return 'none';
    var parts = [];
    STRUCT_FLAGS.forEach(function (f) { if (n & f[0]) parts.push(f[1]); });
    return parts.length ? parts.join('·') : String(n);
  }
  var GRASS_SUPPRESS = { seq: 1, updated_at: 1, time: 1 };
  // Chain sentinels for "this field does not apply". They are rendered as data
  // — `guild_id: noGuild`, `player_id: noPlayer` — and on an inventory event
  // three of the nine chips said nothing but took a third of the band.
  var GRASS_SENTINEL = { noGuild: 1, noPlayer: 1, noStruct: 1, noPlanet: 1, noFleet: 1, none: 1 };
  var ENERGY_ATTRS = { capacity: 1, load: 1, structsLoad: 1, power: 1, connectionCapacity: 1 };
  // Values that must NEVER be abbreviated: a block height rendered as "1.8M"
  // makes an old→new transition read as "1.8M → 1.8M", and an abbreviated
  // record id ("33.3k") is not an id at all. Covers snake_case keys and the
  // camelCase grid attribute names (checkpointBlock, lastAction).
  var HEIGHT_KEY = /^(height|block|block_height|last_action|lastAction|id|nonce)$|^block_|_block$|Block$|Nonce$|Pointer(Start|End)$/;

  function lookupName(kind, id) {
    var m = grassState.lookups && grassState.lookups[kind];
    var n = m && m[id];
    return n ? id + ' (' + n + ')' : id;
  }

  /* Is `id` already visible in the rendered text `shown`?
   *
   * `shown` is a resolved label like "worker783 (1-1075)" or a bare id. A
   * substring test matches any LONGER id that happens to start with ours, so
   * a chip for 1-1075 would be suppressed by a row showing 1-10750.
   */
  function grassIdAlreadyShown(shown, id) {
    return shown === id || shown.slice(-(id.length + 2)) === '(' + id + ')';
  }

  /* Does a dot-delimited GRASS subject contain `value` as a whole token?
   *
   * Module scope on purpose: `grassRow` calls this as well as `grassVal`. It
   * first shipped nested inside `grassVal`, so every row carrying an `address`
   * detail — which is every inventory event — threw ReferenceError out of
   * `grassRow` and the live feed stopped appending.
   */
  function subjectHasToken(subject, value) {
    if (!subject || value == null) return false;
    return String(subject).split('.').indexOf(String(value)) >= 0;
  }

  // Format ONE detail value. `variant` picks the precise twin: 'new' prefers
  // det[key+'_p'], 'old' prefers det[key+'_old_p'] (falling back to the
  // legacy-scaled field). Returns a display string, or null to suppress.
  function grassVal(ev, det, key, raw, variant) {
    if (GRASS_SUPPRESS[key]) return null;
    if (typeof raw === 'string' && GRASS_SENTINEL[raw]) return null;
    // `action: refined` beside a REFINED badge is the same word twice. The
    // badge is the one that carries colour and scans down the left edge.
    if (key === 'action' && String(raw).toLowerCase() === String(ev.category || '').toLowerCase()) {
      return null;
    }
    // An id whose RESOLVED twin is already on the row. `counterparty` renders
    // as "worker783 (1-1075)", so a `counterparty_player_id: 1-1075` chip beside
    // it is the same id a second time; likewise a counterparty guild that is
    // simply the event's own guild.
    if (key === 'counterparty_player_id' && det.counterparty != null) {
      // Compare against the RENDERED counterparty (an address resolves to
      // "worker783 (1-1075)"), not the raw bech32 it started as.
      var cp = grassVal(ev, det, 'counterparty', det.counterparty, 'new');
      // Whole-id match, not substring: `indexOf` would treat "worker9 (1-10750)"
      // as already showing 1-1075 and silently drop a chip for a DIFFERENT
      // player. Same trap that made 1-195 receive 1-1957's notifications.
      if (cp != null && grassIdAlreadyShown(String(cp), String(raw))) return null;
    }
    if (key === 'counterparty_guild_id' && det.guild_id != null
        && String(det.guild_id) === String(raw)) {
      return null;
    }
    var precise = variant === 'old' ? det[key + '_old_p'] : det[key + '_p'];
    // Full block heights — never abbreviated (the whole point of a height).
    if (HEIGHT_KEY.test(key)) return H.fmtInt(raw);
    // Struct status bitmask → readable flags.
    if ((key === 'status' || key === 'status_old') && ev.category === 'struct_status') {
      return decodeStatus(raw);
    }
    // Grid attribute values: unit by attribute_type (energy in mW via _p;
    // legacy `value` is watts → ×1000; fuel is ualpha; ore is grams).
    var attr = det.attribute_type;
    if (key === 'value' && attr) {
      if (ENERGY_ATTRS[attr]) return H.fmtWatts(precise != null ? Number(precise) : Number(raw) * 1000);
      if (attr === 'fuel') return H.fmtAlpha(precise != null ? Number(precise) : Number(raw) * 1e6);
      if (attr === 'ore') return H.fmtOre(precise != null ? Number(precise) : Number(raw));
      if (HEIGHT_KEY.test(attr)) return H.fmtInt(raw);
    }
    // Direct energy keys on non-grid events (rare but generic).
    if (ENERGY_ATTRS[key]) return H.fmtWatts(precise != null ? Number(precise) : Number(raw) * 1000);
    // Inventory amounts. `amount` is the FLOORED DISPLAY value, not base units
    // — a 98 800 000 uguild.0-5 transfer publishes as `amount: 98` — so the
    // precise twin `amount_p` is what we scale, and `amount` is only ever a
    // last resort (scaled back up, and therefore short by a fraction).
    // Reading `amount` as base units, as this did, was wrong by 10^exponent
    // AND labelled the result "μg".
    if (key === 'amount' && det.denom) {
      var reg = (grassState.lookups && grassState.lookups.denoms) || {};
      var exp = (reg[det.denom] && reg[det.denom].exponent) || 0;
      var base = precise != null ? Number(precise) : Number(raw) * Math.pow(10, exp);
      return H.denomQty(base, det.denom, reg);
    }
    if (key === 'seized_ore' || key === 'ore') return H.fmtOre(Number(raw));
    // Any bech32 value, whatever key carries it (address, counterparty,
    // creator, owner…) — resolved to a name when we know one, shortened when
    // we don't.
    if (typeof raw === 'string' && ADDR_RE.test(raw)) {
      var known = grassState.lookups && grassState.lookups.addresses
        && grassState.lookups.addresses[raw];
      return known ? known : shortAddr(raw);
    }
    // Ids → names from the enrichment lookups.
    if (key === 'player_id') return lookupName('players', String(raw));
    if (key === 'guild_id') return lookupName('guilds', String(raw));
    if (key === 'struct_id' || /_struct_id$/.test(key)) return lookupName('structs', String(raw));
    if (key === 'counterparty' && /^1-\d+$/.test(String(raw))) return lookupName('players', String(raw));
    if (key === 'object_id' && det.object_type === 'player') return lookupName('players', String(raw));
    if (key === 'object_id' && det.object_type === 'struct') return lookupName('structs', String(raw));
    // Defaults.
    if (typeof raw === 'number') return H.fmtNum(raw);
    if (raw && typeof raw === 'object') { try { return JSON.stringify(raw).slice(0, 60); } catch (e) { return '…'; } }
    return String(raw);
  }

  function grassChipNode(label, text, title) {
    var c = H.el('span', 'grass-chip');
    c.appendChild(H.el('b', null, label + ': '));
    c.appendChild(document.createTextNode(text));
    if (title) c.title = title;
    return c;
  }

  // A bech32 address is 44 characters and was the widest thing on the page by
  // a factor of three — one `counterparty` chip is 437px at every window size
  // and wrapped to two lines. Head and tail are what anyone actually compares;
  // the full value stays on the chip's title.
  var ADDR_RE = /^structs1[0-9a-z]{20,}$/;
  function shortAddr(a) { return a.slice(0, 12) + '…' + a.slice(-6); }

  // The one algorithm: time · colored category badge · compact subject ·
  // detail flattened to k:v chips, with `x`+`x_old` pairs folded to old→new
  // and `_p` twins used for precision but never rendered separately.
  // The event's own block height, whichever key carries it. Hoisted out of the
  // chip band into the header: it is on nearly every event, it is the same
  // shape every time, and as a chip it cost a third of the band.
  var BLOCK_KEYS = ['block_height', 'block', 'height'];
  function grassBlock(det) {
    if (!det || typeof det !== 'object') return null;
    for (var i = 0; i < BLOCK_KEYS.length; i++) {
      var v = det[BLOCK_KEYS[i]];
      if (v != null && v !== '') return v;
    }
    return null;
  }

  // 24-hour, zero-padded, built by hand rather than via toLocaleTimeString:
  // a 12-hour stamp is 11 characters ("10:33:55 AM") and wrapped onto a second
  // line in the fixed time column, and locale formats vary in width anyway.
  // A log wants one unambiguous 8-character column.
  function grassTime(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function grassRow(ev) {
    // Two bands, not one flow: a header line you scan (time · category ·
    // subject) and a wrapped chip band you read only when the header caught
    // your eye. Previously everything — including a 60-character subject with
    // a bech32 address in it — ran together as centred prose.
    var li = H.el('li');
    var head = H.el('div', 'grass-head');
    // timestamp is local receive-time (the stream carries none on the wire)
    head.appendChild(H.el('span', 'feed-ts', grassTime(ev.timestamp)));
    var badge = H.el('span', 'grass-badge', ev.category);
    var hue = grassHue(ev.category);
    badge.style.color = 'hsl(' + hue + ',60%,60%)';
    badge.style.borderColor = 'hsl(' + hue + ',60%,40%)';
    head.appendChild(badge);
    var subj = String(ev.subject || '').replace(/^structs\./, '');
    var subjEl = H.el('span', 'grass-subj', subj);
    // Truncated with the full value on hover: the head of a subject carries
    // the meaning (inventory.ualpha.<guild>.<player>), the tail is an address.
    subjEl.title = subj;
    head.appendChild(subjEl);
    // Right-aligned so heights form a column you can read down.
    var blk = grassBlock(ev.detail);
    if (blk != null) {
      head.appendChild(H.el('span', 'grass-block', '#' + H.fmtInt(blk)));
    }
    li.appendChild(head);

    var chips = H.el('div', 'grass-chips');
    li.appendChild(chips);

    var det = ev.detail;
    if (det == null || typeof det !== 'object') {
      if (det != null && det !== '') chips.appendChild(grassChipNode('value', String(det)));
      return li;
    }
    var keys = Object.keys(det);
    var keySet = {};
    keys.forEach(function (k) { keySet[k] = true; });
    var headBlock = grassBlock(det);
    keys.forEach(function (k) {
      var v = det[k];
      if (v == null || v === '') return;
      if (/_p$/.test(k)) return; // precision twin — consumed by its base key
      // In the header now. Both `block` and `block_height` appear on the same
      // event carrying the same number, so match on the VALUE and the pair
      // collapses too.
      if (headBlock != null && BLOCK_KEYS.indexOf(k) >= 0 && String(v) === String(headBlock)) return;
      // The subject already ends with the address on every inventory event, so
      // the chip repeated a 44-character bech32 string verbatim. Only dropped
      // when the subject genuinely contains it — nothing is hidden.
      // Whole-token match on the dot-delimited subject rather than a substring
      // scan, for the same reason as `grassIdAlreadyShown`.
      if (k === 'address' && subjectHasToken(ev.subject, v)) return;
      if (/_old$/.test(k) && keySet[k.replace(/_old$/, '')] && det[k.replace(/_old$/, '')] != null) {
        return; // folded into the new-value chip below
      }
      var text = grassVal(ev, det, k, v, 'new');
      if (text == null) return;
      if (keySet[k + '_old'] && det[k + '_old'] != null) {
        // Old value formats by the BASE key's semantics; variant 'old' makes
        // the precise lookup use k+'_old_p'.
        var oldText = grassVal(ev, det, k, det[k + '_old'], 'old');
        chips.appendChild(grassChipNode(k, (oldText == null ? String(det[k + '_old']) : oldText) + ' → ' + text));
        return;
      }
      chips.appendChild(grassChipNode(k, text,
        (typeof v === 'string' && ADDR_RE.test(v)) ? v : null));
    });
    return li;
  }

  function grassKey(ev) { return ev.timestamp + '|' + ev.category + '|' + ev.subject; }

  function grassMatches(ev) {
    if (grassState.cat && ev.category !== grassState.cat) return false;
    if (grassState.text) {
      var hay = (ev.category + ' ' + ev.subject + ' ' + JSON.stringify(ev.detail || '')).toLowerCase();
      if (hay.indexOf(grassState.text.toLowerCase()) < 0) return false;
    }
    return true;
  }

  // `opts.full` forces a rebuild. A live event only ever PREPENDS, so the
  // common path just inserts the new rows and trims the tail — at 2000 buffered
  // events a rebuild-per-tick would be ~24,000 nodes every 250ms. A rebuild is
  // still required when the filter changes (different set) or when names
  // resolve (existing rows must re-render with the resolved label).
  function renderGrassList(opts) {
    var list = document.getElementById('grass-list');
    if (!list) return;
    var full = !!(opts && opts.full) || !grassState.keys;

    // Placeholder rows (empty state, "show more") are not events and are not
    // in `keys`, so they must go BEFORE the reconcile: the tail trim removes
    // `list.lastChild`, and if that were the note it would pop a key while
    // leaving a real row behind, desyncing keys from the DOM.
    [].slice.call(list.querySelectorAll('li.grass-note')).forEach(function (n) {
      n.parentNode.removeChild(n);
    });

    var matched = [];
    for (var i = 0; i < grassState.rows.length && matched.length < grassState.renderCap; i++) {
      if (grassMatches(grassState.rows[i])) matched.push(grassState.rows[i]);
    }
    // Total matches (not just rendered) — the count must describe the buffer,
    // not the window into it.
    var total = 0;
    for (var j = 0; j < grassState.rows.length; j++) {
      if (grassMatches(grassState.rows[j])) total++;
    }

    // Rows are newest-first, so sitting at the top means "tail the live
    // stream" and anywhere else means "I am reading". Both paths move content
    // under the reader, so hold their position unless they were tailing.
    var wasTailing = list.scrollTop <= 4;
    var keepTop = list.scrollTop;
    var keepHeight = list.scrollHeight;

    if (full) {
      list.innerHTML = '';
      grassState.keys = [];
      matched.forEach(function (ev) {
        list.appendChild(grassRow(ev));
        grassState.keys.push(grassKey(ev));
      });
    } else {
      // Prepend only what is genuinely new, newest last so insertBefore keeps
      // the order right.
      var known = {};
      grassState.keys.forEach(function (k) { known[k] = 1; });
      var fresh = [];
      for (var n = 0; n < matched.length; n++) {
        var k = grassKey(matched[n]);
        if (known[k]) break;      // first known row: everything after is older
        fresh.push(matched[n]);
      }
      for (var f = fresh.length - 1; f >= 0; f--) {
        list.insertBefore(grassRow(fresh[f]), list.firstChild);
        grassState.keys.unshift(grassKey(fresh[f]));
      }
      // Trim the tail back to the render cap.
      while (grassState.keys.length > grassState.renderCap && list.lastChild) {
        list.removeChild(list.lastChild);
        grassState.keys.pop();
      }
    }

    if (!grassState.keys.length) {
      list.appendChild(H.el('li', 'ops-muted grass-note', grassState.rows.length
        ? 'no events match the filter'
        : 'no events yet — they appear as the game plays'));
    } else if (total > grassState.keys.length) {
      // Never silently truncate: say what is being held back and offer it.
      var more = H.el('li', 'ops-muted grass-note');
      var link = H.el('a', 'ops-refresh-btn', 'Show ' + GRASS_RENDER_STEP + ' more');
      link.href = 'javascript:void(0)';
      link.addEventListener('click', function () {
        grassState.renderCap += GRASS_RENDER_STEP;
        renderGrassList({ full: true });
      });
      more.appendChild(document.createTextNode(
        (total - grassState.keys.length) + ' older matching event(s) not shown · '));
      more.appendChild(link);
      list.appendChild(more);
    }

    if (!wasTailing) {
      // Prepending pushes content down; keep the reader looking at the same
      // rows rather than the same offset.
      list.scrollTop = keepTop + (list.scrollHeight - keepHeight);
    }
    var count = document.getElementById('grass-count');
    if (count) {
      count.textContent = grassState.keys.length + ' / ' + total
        + (total < grassState.rows.length ? ' (of ' + grassState.rows.length + ')' : '');
    }
  }

  // Debounced render: live events always BUFFER (cheap array ops); the DOM is
  // only touched when the grass tab is showing and not paused.
  function queueGrassRender(full) {
    if (full) grassState.renderFull = true;
    if (Board.current !== 'grass' || grassState.paused || grassState.renderQueued) return;
    grassState.renderQueued = true;
    setTimeout(function () {
      grassState.renderQueued = false;
      var f = grassState.renderFull;
      grassState.renderFull = false;
      renderGrassList({ full: f });
    }, 250);
  }

  function buildGrassToolbar() {
    var bar = document.getElementById('grass-toolbar');
    if (!bar || grassState.built) return;
    grassState.built = true;
    var catSel = H.el('select', 'sui-input-text'); catSel.id = 'grass-cat';
    catSel.addEventListener('change', function () {
      grassState.cat = catSel.value;
      grassState.renderCap = GRASS_RENDER_STEP;   // a new filter starts a new window
      renderGrassList({ full: true });
    });
    bar.appendChild(catSel);
    var search = H.el('input', 'sui-input-text'); search.placeholder = 'filter…';
    search.addEventListener('input', function () {
      grassState.text = search.value;
      grassState.renderCap = GRASS_RENDER_STEP;
      renderGrassList({ full: true });
    });
    bar.appendChild(search);
    var pause = H.el('a', 'ops-refresh-btn'); pause.href = 'javascript:void(0)'; pause.id = 'grass-pause';
    pause.textContent = 'Pause';
    pause.addEventListener('click', function () {
      grassState.paused = !grassState.paused;
      pause.textContent = grassState.paused ? 'Resume' : 'Pause';
      // Resuming may need to catch up on a backlog the DOM never saw.
      if (!grassState.paused) renderGrassList({ full: true });
    });
    bar.appendChild(pause);
    bar.appendChild(H.el('span', 'ops-muted')).id = 'grass-count';

    // Pop out — the stream is a thing you park beside the game and watch, not
    // something to go find under System every time. Hidden in the pop-out
    // itself (it IS the pop-out) and on the web copy, where a second browser
    // window is the operating system's job, not ours.
    if (!Board.solo) {
      var pop = H.el('a', 'ops-refresh-btn');
      pop.href = 'javascript:void(0)';
      pop.title = 'Open the live stream in its own window';
      pop.appendChild(H.el('i', 'icon-link-out'));
      pop.appendChild(document.createTextNode(' Pop out'));
      pop.addEventListener('click', function () {
        Board.T.core.invoke('open_stream_window').catch(function () {
          // Web dashboard: no Tauri window to build, so open a browser one at
          // the same chrome-less URL.
          window.open('./?view=stream', 'structs-stream', 'width=560,height=900');
        });
      });
      bar.appendChild(pop);
    }
  }

  function refreshGrassCats() {
    var catSel = document.getElementById('grass-cat');
    if (!catSel) return;
    var cur = grassState.cat;
    catSel.innerHTML = '';
    var all = H.el('option', null, 'all categories'); all.value = '';
    catSel.appendChild(all);
    grassState.cats.forEach(function (c) {
      var o = H.el('option', null, c); o.value = c;
      if (c === cur) o.selected = true;
      catSel.appendChild(o);
    });
  }

  function noteGrassCategory(cat) {
    if (grassState.cats.indexOf(cat) >= 0) return;
    grassState.cats.push(cat);
    grassState.cats.sort();
    refreshGrassCats();
  }

  // Merge a back-fill batch into the live ring (dedupe on ts+category+subject
  // — receive-time ms is effectively unique per event). Keeps live-only rows
  // (e.g. block ticks, which are relay-only and never in the Rust buffer).
  function grassMerge(events) {
    var seen = {};
    grassState.rows.forEach(function (ev) { seen[ev.timestamp + '|' + ev.category + '|' + ev.subject] = true; });
    events.forEach(function (ev) {
      if (seen[ev.timestamp + '|' + ev.category + '|' + ev.subject]) return;
      grassState.rows.push(ev);
      noteGrassCategory(ev.category);
    });
    grassState.rows.sort(function (a, b) { return b.timestamp - a.timestamp; });
    if (grassState.rows.length > GRASS_MAX) grassState.rows.length = GRASS_MAX;
  }

  function grassBackfill() {
    return Board.T.core.invoke('mcp_grass_recent', { limit: GRASS_MAX }).then(function (d) {
      grassMerge((d && d.events) || []);
      grassMergeLookups(d && d.lookups);
      ((d && d.categories) || []).forEach(noteGrassCategory);
      refreshGrassCats();
    }).catch(function () {});
  }

  function renderGrass() {
    buildGrassToolbar();
    // Defensive: the board may have booted before any events existed (its
    // buffer back-fill was empty) — refresh from the Rust ring on each visit.
    // A back-fill can insert rows anywhere in the ordering, so it rebuilds.
    grassBackfill().then(function () { renderGrassList({ full: true }); });
    renderGrassList({ full: true });
    return Promise.resolve();
  }

  Board.registerPage('grass', {
    onBoot: function () {
      // Back-fill from the Rust ring buffer, then tail the live relay. The
      // listener lives for the window's lifetime and buffers even while other
      // tabs are showing, so switching to Grass is instant.
      grassBackfill().then(function () { renderGrassList({ full: true }); });
      Board.T.event.listen('grass-event', function (e) {
        var ev = e && e.payload;
        if (!ev || !ev.category) return;
        grassState.rows.unshift(ev);
        if (grassState.rows.length > GRASS_MAX) grassState.rows.length = GRASS_MAX;
        noteGrassCategory(ev.category);
        queueGrassRender();
      });
      // Lazily-resolved names arrive here; visible rows upgrade in place.
      Board.T.event.listen('grass-lookups', function (e) {
        grassMergeLookups(e && e.payload);
        // Names resolving must upgrade rows ALREADY in the DOM, which an
        // incremental prepend would never touch.
        queueGrassRender(true);
      });
    },
    onEnter: renderGrass,
    refresh: renderGrass,
    cadenceMs: 60000,
  });

  // ═══════════════════════════ WAR ══════════════════════════════════════════
  // Grudges, priority guilds, the scored raid target board, response incidents
  // and both combat loops' settings. The lists are what make retaliation happen
  // on OUR schedule instead of inside the attacker's two-minute window.
  var warState = { data: null, section: 'doctrine', sort: { key: 'score', dir: -1 } };
  var WAR_KEYS = [{ key: 'score', label: 'score' }, { key: 'ore', label: 'ore' },
    { key: 'shield', label: 'shield' }, { key: 'defenders', label: 'defenders' },
    { key: 'name', label: 'name' }];
  var WAR_ACC = {
    score: function (t) { return t.score; }, ore: function (t) { return t.stored_ore; },
    shield: function (t) { return t.planetary_shield; },
    defenders: function (t) { return t.defenders_on_cmd; },
    name: function (t) { return (t.name || '').toLowerCase(); },
  };

  function warSet(payload) {
    return Board.T.core.invoke('mcp_config_set', { domain: 'combat_lists', payload: payload })
      .then(function () { return renderWar(); })
      .catch(function (e) { alertInto('war-body', 'write failed: ' + e); });
  }
  // A small "label [input] [button]" add-row, used by every list card.
  function addRow(placeholder, onAdd, withWeight) {
    var r = H.el('div', 'cfg-row');
    var idIn = H.el('input', 'sui-input-text'); idIn.type = 'text'; idIn.placeholder = placeholder;
    // Weight only makes sense for the lists that rank; the veto lists don't.
    var weight = withWeight === false ? null : 1;
    var wCtl = weight == null ? null
      : H.stepper(weight, { min: 0, max: 10, step: 0.1, width: '3.5em' }, function (v) { weight = v; });
    var btn = massBtn('', 'icon-add', 'Add', 'sui-mod-secondary');
    function submit() {
      var id = (idIn.value || '').trim();
      if (!id) return;
      onAdd(id, weight);
      idIn.value = '';
    }
    btn.addEventListener('click', submit);
    idIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    var wrap = H.el('span', 'war-addrow');
    wrap.appendChild(idIn);
    if (wCtl) wrap.appendChild(wCtl);
    wrap.appendChild(btn);
    r.appendChild(wrap);
    return r;
  }
  function iconBtn(iconCls, title, onClick) {
    var a = H.el('a', 'ops-refresh-btn'); a.href = 'javascript:void(0)'; a.title = title;
    a.appendChild(H.el('i', iconCls));
    a.addEventListener('click', onClick);
    return a;
  }
  // War is four sections in one page body: Doctrine (what the loops may do),
  // Targets (who they're looking at), Lists (grudges and vetoes) and Incidents
  // (what actually happened). Which one renders comes from the route.
  function renderWarBody() {
    var d = warState.data; if (!d) return;
    var body = document.getElementById('war-body');
    body.innerHTML = '';
    var lists = d.lists || {};
    var resp = d.response || {};
    var raid = d.raid || {};
    var sec = warState.section || 'doctrine';
    var show = function (k) { return sec === k; };

    // ── Posture strip: what the two loops are allowed to do right now. It
    //    heads every section — "is anything even armed" is the question you
    //    ask before reading any of the rest. ──
    var sbody = H.el('div');
    sbody.appendChild(H.row('Raid response',
      (resp.enabled ? 'ON' : 'off') + ' · ' + (resp.autonomy || '?') + ' · ' + (resp.mode || '?'),
      resp.enabled ? 'icon-defend' : 'icon-blocked'));
    sbody.appendChild(H.row('Raid targeting',
      (raid.enabled ? 'ON' : 'off') + ' · ' + (raid.autonomy || '?') + ' · ' + (raid.posture || '?'),
      raid.enabled ? 'icon-raid' : 'icon-blocked'));
    var sb = d.shot_budget || {};
    sbody.appendChild(H.row('Retaliation budget', (sb.used || 0) + ' / ' + (sb.cap || 0) + ' shots this hour', 'icon-dmg'));
    if (resp.dry_run || raid.dry_run) {
      sbody.appendChild(H.alertLine('dry-run is on — plans are computed and logged, nothing signs.', 'icon-tip'));
    }
    body.appendChild(H.card('POSTURE', sbody));

    // ── Target board (auto_raid phase B output). ──
    if (show('targets')) {
    var tbody = H.el('div');
    var targets = d.targets || [];
    if (!targets.length) {
      tbody.appendChild(H.alertLine(
        raid.enabled
          ? 'No candidates scored yet — the loop sweeps a bounded batch each scan. Use Scan now → raid on the Armada page to force one.'
          : 'Raid targeting is off. Enable it on the Doctrine tab to start scoring targets (it starts in advise mode and signs nothing).',
        'icon-info'));
    } else {
      var tbar = H.el('div'); tbar.style.cssText = 'margin-bottom:var(--spacing-md);';
      tbar.appendChild(H.sortControl(WAR_KEYS, warState.sort, renderWarBody));
      tbody.appendChild(tbar);
      var ttable = H.resultTable();
      H.sortBy(targets, warState.sort, WAR_ACC).slice(0, 40).forEach(function (t) {
        var go = !t.blocked_by;
        var act = H.el('div', 'cfg-actions');
        act.appendChild(iconBtn('icon-attention', 'Add ' + t.player_id + ' to the grudge list', function () {
          warSet({ action: 'add', kind: 'grudge', id: t.player_id, label: t.name, guild_id: t.guild_id, weight: 1.5 });
        }));
        act.appendChild(iconBtn('icon-blocked', 'Never attack ' + t.player_id, function () {
          warSet({ action: 'add', kind: 'protected', id: t.player_id });
        }));
        ttable.appendChild(H.resultRow({
          icon: go ? 'icon-raid' : 'icon-planetary-shield',
          title: t.name + '  ' + t.planet_id,
          subtitle: (go ? 'GO — ' + t.vulnerability_reason : 'NO-GO — ' + t.blocked_by),
          // Captioned tiles, not bare icon+number: "297" beside an ore glyph
          // and "5" beside a shield glyph do not say which is the prize and
          // which is the obstacle.
          chips: [
            statTile('ore', ore(t.stored_ore), 'sui-icon-alpha-ore',
              t.stored_ore >= (raid.min_ore || 0) ? '' : 'bad'),
            statTile('shield · proof', t.planetary_shield + ' · ~' + Math.round(t.raid_minutes) + 'm',
              'icon-planetary-shield', 'muted'),
            statTile('defenders', t.defenders_on_cmd, 'icon-defend', 'muted'),
            statTile('score / 100', Math.round(t.score), null, go ? 'ok' : 'bad'),
          ],
          action: act,
        }));
      });
      tbody.appendChild(ttable);
    }
    var exps = d.expeditions || [];
    if (exps.length) {
      tbody.appendChild(H.el('div', 'ops-muted', exps.length + ' expedition(s) in flight:'));
      exps.forEach(function (e) {
        tbody.appendChild(H.row(e.raider_player + ' → ' + e.target_planet,
          e.note + (e.hashing ? ' · proof running' : ''), 'icon-outgoing'));
      });
    }
    body.appendChild(H.card('TARGET BOARD', tbody));
    }

    // ── Grudges. Auto-written by auto_response; hand-editable here. ──
    if (show('lists')) {
    var gbody = H.el('div');
    var grudges = lists.grudges || [];
    if (!grudges.length) {
      gbody.appendChild(H.alertLine(
        'No grudges yet. One is recorded automatically on every confirmed attack — or add a player below who has never touched you.',
        'icon-info'));
    } else {
      var gtable = H.resultTable();
      grudges.forEach(function (g) {
        var act = H.el('div', 'cfg-actions');
        act.appendChild(iconBtn(g.muted ? 'icon-okay' : 'icon-blocked',
          g.muted ? 'Unmute — act on this grudge again' : 'Mute — keep the record, stop acting on it',
          function () {
            warSet({ action: g.muted ? 'unmute' : 'mute', kind: 'grudge', id: g.player_id });
          }));
        act.appendChild(iconBtn('icon-subtract', 'Forget this grudge', function () {
          warSet({ action: 'remove', kind: 'grudge', id: g.player_id });
        }));
        var sub = g.attacks + ' attack(s) · ' + g.structs_lost + ' struct(s) lost · '
          + g.source + (g.muted ? ' · MUTED' : '') + (g.expired ? ' · lapsed' : '');
        gtable.appendChild(H.resultRow({
          icon: g.muted ? 'icon-unknown' : 'icon-enemy-tile',
          title: (g.label || g.player_id) + (g.guild_id ? '  [' + g.guild_id + ']' : ''),
          subtitle: g.note ? sub + ' · ' + g.note : sub,
          chips: [
            H.resource(g.damage_taken, 'icon-dmg'),
            H.resource('×' + (Math.round(g.weight * 10) / 10), null),
            H.resource(Math.round(g.heat * 100) / 100, 'icon-attention', g.muted ? 'attn' : ''),
          ],
          action: act,
        }));
      });
      gbody.appendChild(gtable);
    }
    gbody.appendChild(addRow('player id (e.g. 1-61)', function (id, w) {
      warSet({ action: 'add', kind: 'grudge', id: id, weight: w == null ? 1 : w });
    }));
    body.appendChild(H.card('GRUDGES', gbody));

    // ── Guild-level priorities + the hard never-attack vetoes. ──
    var qbody = H.el('div');
    (lists.priority_guilds || []).forEach(function (g) {
      var r = H.el('div', 'cfg-row');
      var l = H.el('span');
      l.appendChild(H.el('i', 'icon-guild'));
      l.appendChild(document.createTextNode(' ' + (g.label || g.guild_id) + '  ×' + g.weight));
      r.appendChild(l);
      r.appendChild(iconBtn('icon-subtract', 'Remove ' + g.guild_id, function () {
        warSet({ action: 'remove', kind: 'priority_guild', id: g.guild_id });
      }));
      qbody.appendChild(r);
    });
    if (!(lists.priority_guilds || []).length) {
      qbody.appendChild(H.stateBlock('empty', 'No prioritised guilds.'));
    }
    qbody.appendChild(addRow('guild id (e.g. 0-2)', function (id, w) {
      warSet({ action: 'add', kind: 'priority_guild', id: id, weight: w == null ? 1 : w });
    }));
    body.appendChild(H.card('PRIORITY GUILDS', qbody));

    var abody = H.el('div');
    (lists.allies || []).forEach(function (gid) {
      var r = H.el('div', 'cfg-row');
      var l = H.el('span');
      l.appendChild(H.el('i', 'icon-guild'));
      l.appendChild(document.createTextNode(' ' + gid));
      r.appendChild(l);
      r.appendChild(iconBtn('icon-subtract', 'Stop protecting ' + gid, function () {
        warSet({ action: 'remove', kind: 'ally', id: gid });
      }));
      abody.appendChild(r);
    });
    (lists.protected_players || []).forEach(function (pid) {
      var r = H.el('div', 'cfg-row');
      var l = H.el('span');
      l.appendChild(H.el('i', 'icon-member'));
      l.appendChild(document.createTextNode(' ' + pid));
      r.appendChild(l);
      r.appendChild(iconBtn('icon-subtract', 'Stop protecting ' + pid, function () {
        warSet({ action: 'remove', kind: 'protected', id: pid });
      }));
      abody.appendChild(r);
    });
    abody.appendChild(addRow('guild id to protect', function (id) {
      warSet({ action: 'add', kind: 'ally', id: id });
    }, false));
    abody.appendChild(addRow('player id to protect', function (id) {
      warSet({ action: 'add', kind: 'protected', id: id });
    }, false));
    body.appendChild(H.card('NEVER ATTACK · hard veto in both loops', abody));
    }

    // ── What the response loop actually did. ──
    if (show('incidents')) {
    var ibody = H.el('div');
    var incidents = d.incidents || [];
    if (!incidents.length) {
      ibody.appendChild(H.alertLine('No incidents recorded yet.', 'icon-info'));
    } else {
      var itable = H.resultTable();
      incidents.slice(0, 25).forEach(function (i) {
        itable.appendChild(H.resultRow({
          icon: i.shots_fired > 0 ? 'icon-counter' : 'icon-incoming',
          title: i.defender_player + ' @ ' + i.planet_id
            + (i.attacker_player ? '  ← ' + i.attacker_player : ''),
          subtitle: i.mode + ' · ' + (i.fire_target ? 'fired at ' + i.fire_target + ' (' + i.target_kind + ')' : i.note),
          chips: [
            H.resource(i.shots_fired + '/' + i.shots_planned, 'icon-dmg'),
            H.resource(Math.round(i.projected_damage * 10) / 10, 'icon-ballistic-weapon'),
            H.resource(H.ago(i.at_ms), null),
          ],
          onClick: function () {
            var pre = H.el('div', 'ops-muted');
            pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
            pre.textContent = i.note;
            H.detailModal('Incident — ' + i.planet_id, pre);
          },
        }));
      });
      ibody.appendChild(itable);
    }
    body.appendChild(H.card('INCIDENTS', ibody));
    }

    if (show('doctrine')) {
    // ── Editable settings for both loops (the CONFIG page only shows toggles). ──
    // Same editor, same FIELD_META, same write path as Config — War only
    // decides which keys land in which card. A hand-written field list here
    // is how the labels drifted from FIELD_META the first time.
    var isWeight = function (k) { return k.indexOf('w_') === 0; };
    var warEditor = function (which, cfg, o) {
      return loopEditor(which, cfg, Object.assign(
        { chrome: false, after: renderWar, errorHost: 'war-body' }, o));
    };

    // No explanatory notes under these cards: the reasoning behind each gate
    // is in docs/team-ops.md, and the individual knobs that need a caveat carry
    // it as a press-and-hold tip on the field itself (FIELD_META.hint).
    body.appendChild(H.card('RESPONSE SETTINGS', warEditor('response', resp)));
    body.appendChild(H.card('TARGETING GATES', warEditor('raid', raid, {
      filter: function (k) { return !isWeight(k); },
    })));
    body.appendChild(H.card('SCORING WEIGHTS · blended to 0-100', warEditor('raid', raid, {
      filter: isWeight,
    })));
    }

    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }

  function renderWar() {
    return Board.T.core.invoke('mcp_war_bundle').then(function (d) {
      warState.data = d; renderWarBody();
    }).catch(function (e) {
      var body = document.getElementById('war-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('combat data unavailable: ' + e, 'icon-alert'));
    });
  }
  Board.registerPage('war', {
    onEnter: function (params, view) {
      if (view) warState.section = view;
      return renderWar();
    },
    refresh: renderWar,
    cadenceMs: 20000,
  });

  // ═══════════════════════════ CONFIG ═══════════════════════════════════════
  function cfgSet(domain, payload) {
    return Board.T.core.invoke('mcp_config_set', { domain: domain, payload: payload })
      .then(function () { return renderConfig(); })
      .catch(function (e) { alertInto('config-body', 'write failed: ' + e); });
  }
  function alertInto(id, text) {
    var body = document.getElementById(id);
    if (body) body.insertBefore(H.alertLine(text, 'icon-alert'), body.firstChild);
  }

  // ── Callsigns (generated player names) ────────────────────────────────────
  // Identity's other half, next to the portraits. Everything here is a READ of
  // what the backend would generate — the names are rendered in Rust and shown
  // verbatim, so there is no second implementation to drift out of step with
  // the one that actually signs.
  var callsign = { data: null };

  function renderCallsignCard() {
    var d = callsign.data || {};
    var cfg = d.config || {};
    var body = H.el('div', 'cfg-section');

    // What this actually does, in a sentence — the two switches below differ in
    // consequence by three orders of magnitude and the labels alone won't say so.
    body.appendChild(H.el('p', 'ops-muted',
      'Virtual players are named from their HD index. New players are named as they are created; ' +
      'renaming the ones you already have writes each name to the chain, one transaction per player.'));

    // Style picker. Each option shows its own flavour so the choice can be made
    // without switching to it first.
    var styleOpts = (d.styles || []).map(function (s) {
      return { value: s.id, label: s.label + ' — ' + s.example };
    });
    if (cfg.custom) styleOpts.push({ value: 'custom', label: 'Custom' });
    body.appendChild(H.field('Naming style', H.selectBox(cfg.style, styleOpts, function (v) {
      cfg.style = v; saveCallsign(cfg);
    }), 'The word banks and shape used to build every generated name.'));

    body.appendChild(H.field('Prefix (optional)', H.textBox(cfg.prefix || '', 'e.g. OH', function (v) {
      cfg.prefix = v.trim(); saveCallsign(cfg);
    }), 'Prepended as <prefix>-<name>. Letters and digits only.'));

    // Capacity vs fleet: fewer slots than players means two colleagues share a
    // name. The chain permits it; a roster you have to disambiguate by eye does
    // not, so this is stated rather than silently tolerated.
    var stats = H.el('div', 'hstrip');
    stats.appendChild(statTile('distinct names', d.capacity == null ? '—' : String(d.capacity)));
    stats.appendChild(statTile('players', d.fleet == null ? '—' : String(d.fleet),
      null, d.capacity_ok === false ? 'bad' : null));
    body.appendChild(stats);
    if (d.capacity_ok === false) {
      body.appendChild(H.alertLine(
        'This style has fewer distinct names than you have players, so some will share one. Pick a style with more capacity.',
        'icon-alert'));
    }

    body.appendChild(H.checkbox(cfg.name_new !== false, 'Name new players as they are created', function (v) {
      cfg.name_new = v; saveCallsign(cfg);
    }));
    body.appendChild(H.checkbox(!!cfg.rename_existing, 'Rename existing players on-chain', function (v) {
      cfg.rename_existing = v; saveCallsign(cfg);
    }));
    // Rollout progress. Without this the only evidence the switch did anything
    // is the telemetry log, which is not where anyone looks after flipping it.
    if (cfg.rename_existing) {
      var prog = H.el('div', 'hstrip');
      prog.appendChild(statTile('renamed', d.renamed == null ? '—' : String(d.renamed), null, 'ok'));
      prog.appendChild(statTile('still to go', d.pending == null ? '—' : String(d.pending)));
      if (d.operator_named) prog.appendChild(statTile('named by you', String(d.operator_named), null, 'muted'));
      body.appendChild(prog);
      var per = d.per_sweep || 100;
      var sweeps = d.pending ? Math.ceil(d.pending / per) : 0;
      body.appendChild(H.el('p', 'ops-muted',
        'The roster sweep renames up to ' + per + ' players at a time and picks up where it left off' +
        (sweeps ? ' — about ' + sweeps + ' more sweep' + (sweeps === 1 ? '' : 's') + ' to go' : '') +
        '. Each rename is a real transaction; watch them land on the Transactions page. ' +
        'Names you set yourself are never touched.'));
      body.appendChild(H.el('p', 'ops-muted',
        'Renaming only runs while this window is open — the roster sweep is what drives it.'));
    }

    // Preview against the operator's REAL indices, so what is shown is what
    // will be signed.
    var prevWrap = H.el('div', 'cs-preview');
    (d.preview || []).forEach(function (p) {
      prevWrap.appendChild(statTile('idx ' + p.index, p.name));
    });
    if ((d.preview || []).length) body.appendChild(prevWrap);

    return H.card('CALLSIGNS', body);
  }

  function saveCallsign(cfg) {
    Board.T.core.invoke('mcp_callsign_set', { config: cfg }).then(function (d) {
      callsign.data = d;
      rerenderCallsign();
    }).catch(function (e) { alertInto('config-body', 'naming config rejected: ' + e); });
  }

  function rerenderCallsign() {
    var host = document.getElementById('callsign-card');
    if (!host) return;
    var fresh = renderCallsignCard();
    fresh.id = 'callsign-card';
    host.parentNode.replaceChild(fresh, host);
  }

  function renderCallsigns(body) {
    var host = H.el('div'); host.id = 'callsign-card';
    body.appendChild(host);
    Board.T.core.invoke('mcp_callsign_get').then(function (d) {
      callsign.data = d;
      rerenderCallsign();
    }).catch(function (e) { host.appendChild(H.alertLine('naming unavailable: ' + e, 'icon-alert')); });
  }

  // ── Role Appearance (per-role, per-layer pfp config) ──────────────────────
  // Mirror of Rust pfp.rs so the live preview equals what will be written.
  function jsFnv(s) { var x = 2166136261; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x; }
  var APPEAR_LAYERS = [
    { key: 'background', label: 'Background' }, { key: 'body', label: 'Body' },
    { key: 'head', label: 'Head' }, { key: 'neck', label: 'Neck' }, { key: 'arms', label: 'Arms' },
  ];
  // Three stable sample HD indices so "randomize" visibly varies in the preview.
  var APPEAR_SAMPLES = [7, 34, 58];
  var appear = { config: null, counts: null, players: null };

  function layerVal(cfg, part, idx, count) {
    var v = cfg[part];
    if (v == null) return (jsFnv(idx + ':' + part) % count) + 1;
    return Math.min(count, Math.max(1, v));
  }
  function composeAttrs(cfg, idx) {
    var c = appear.counts;
    return JSON.stringify({
      head: layerVal(cfg, 'head', idx, c.head), neck: layerVal(cfg, 'neck', idx, c.neck),
      body: layerVal(cfg, 'body', idx, c.body), arms: layerVal(cfg, 'arms', idx, c.arms),
      background: layerVal(cfg, 'background', idx, c.background),
    });
  }
  // A single-layer thumbnail (over the role's current background for context).
  function layerThumb(cfg, part, idx) {
    var box = H.el('div', 'appear-thumb');
    var src = window.StructsPfp.layerSrc;
    if (part !== 'background') {
      var bgIdx = layerVal(cfg, 'background', APPEAR_SAMPLES[0], appear.counts.background);
      var bg = H.el('img', 'pfp-viewer-layer');
      bg.src = src('background', bgIdx);
      box.appendChild(bg);
    }
    var im = H.el('img', 'pfp-viewer-layer');
    im.src = src(part, idx);
    box.appendChild(im);
    return box;
  }
  // Grid modal to pick a fixed layer index.
  function pickLayerModal(role, part, count, cfg, onPick) {
    var grid = H.el('div', 'appear-grid');
    for (var i = 1; i <= count; i++) {
      (function (idx) {
        var cell = H.el('a', 'appear-grid-cell'); cell.href = 'javascript:void(0)';
        if (cfg[part] === idx) cell.classList.add('sel');
        cell.appendChild(layerThumb(cfg, part, idx));
        cell.appendChild(H.el('span', 'appear-grid-n', String(idx)));
        cell.addEventListener('click', function () { onPick(idx); close(); });
        grid.appendChild(cell);
      })(i);
    }
    var close = H.detailModal('Pick ' + part + ' — ' + role, grid);
  }

  function buildRoleCard(role) {
    var cfg = appear.config[role];
    var count = appear.players[role] || 0;
    var body = H.el('div', 'appear-role');

    // Live preview: three sample avatars (identical when all layers fixed).
    var prev = H.el('div', 'appear-preview');
    APPEAR_SAMPLES.forEach(function (s) { prev.appendChild(H.pfpPortrait(composeAttrs(cfg, s))); });
    body.appendChild(prev);

    // Per-layer controls.
    APPEAR_LAYERS.forEach(function (L) {
      var cnt = appear.counts[L.key];
      var isRandom = cfg[L.key] == null;
      var r = H.el('div', 'appear-layer');
      r.appendChild(H.el('span', 'appear-layer-name', L.label));
      var ctl = H.el('div', 'appear-layer-ctl');
      if (isRandom) {
        ctl.appendChild(H.el('span', 'ops-muted', 'varies per player'));
      } else {
        var idx = Math.min(cnt, Math.max(1, cfg[L.key]));
        var thumb = layerThumb(cfg, L.key, idx);
        thumb.classList.add('appear-thumb-btn');
        thumb.addEventListener('click', function () {
          pickLayerModal(role, L.key, cnt, cfg, function (v) { cfg[L.key] = v; rerenderRole(role); });
        });
        ctl.appendChild(thumb);
        var step = function (d) { var v = ((idx - 1 + d + cnt) % cnt) + 1; cfg[L.key] = v; rerenderRole(role); };
        var prevB = H.el('a', 'appear-step'); prevB.href = 'javascript:void(0)'; prevB.appendChild(H.el('i', 'icon-caret-left')); prevB.addEventListener('click', function () { step(-1); });
        var nextB = H.el('a', 'appear-step'); nextB.href = 'javascript:void(0)'; nextB.appendChild(H.el('i', 'icon-caret-right')); nextB.addEventListener('click', function () { step(1); });
        ctl.appendChild(prevB);
        ctl.appendChild(H.el('span', 'appear-idx', '#' + idx + ' / ' + cnt));
        ctl.appendChild(nextB);
      }
      // Fixed/Random toggle.
      var tog = H.el('a', 'appear-toggle' + (isRandom ? ' is-random' : '')); tog.href = 'javascript:void(0)';
      tog.textContent = isRandom ? 'Randomized' : 'Fixed';
      tog.addEventListener('click', function () {
        cfg[L.key] = isRandom ? layerVal(cfg, L.key, APPEAR_SAMPLES[0], cnt) : null;
        rerenderRole(role);
      });
      ctl.appendChild(tog);
      r.appendChild(ctl);
      body.appendChild(r);
    });

    // Apply — persist + restyle every player in this role.
    var applyRow = H.el('div', 'cfg-actions');
    var applyBtn = massBtn('appear-apply-' + role, 'icon-success', 'Apply to all ' + role + ' (' + count + ')', 'sui-mod-primary');
    applyBtn.addEventListener('click', function () {
      applyBtn.classList.add('is-busy');
      Board.T.core.invoke('mcp_role_pfp_set', { role: role, config: cfg }).then(function (r) {
        applyBtn.classList.remove('is-busy');
        applyBtn.lastChild.textContent = ' Restyling ' + (r && r.restyling != null ? r.restyling : count) + '…';
      }).catch(function (e) { applyBtn.classList.remove('is-busy'); alertInto('config-body', 'restyle failed: ' + e); });
    });
    applyRow.appendChild(applyBtn);
    body.appendChild(applyRow);

    return H.card(role.toUpperCase() + ' APPEARANCE', body);
  }

  function rerenderRole(role) {
    var host = document.getElementById('appear-' + role);
    if (!host) return;
    var fresh = buildRoleCard(role);
    fresh.id = 'appear-' + role;
    host.parentNode.replaceChild(fresh, host);
  }

  function renderRoleAppearance(body) {
    var host = H.el('div'); host.id = 'appear-host';
    body.appendChild(host);
    Board.T.core.invoke('mcp_role_pfp_get').then(function (d) {
      appear.config = d.config || {}; appear.counts = d.part_counts || {}; appear.players = d.counts || {};
      host.innerHTML = '';
      // Driven by whatever roles the backend manages, so a new one (raider)
      // appears here without another hardcoded list to forget.
      Object.keys(appear.config).forEach(function (role) {
        var c = buildRoleCard(role); c.id = 'appear-' + role;
        host.appendChild(c);
      });
    }).catch(function (e) { host.appendChild(H.alertLine('appearance unavailable: ' + e, 'icon-alert')); });
  }

  // ── Loop metadata ────────────────────────────────────────────────────────
  // What each loop IS, so the list can say it in a sentence instead of dumping
  // twenty key=value pairs. `chips` names the two or three numbers worth seeing
  // without opening the editor.
  // `short` is both the row subtitle and the editor's one-line header. There
  // used to be a second, longer `blurb` for the editor; it restated the same
  // fact in more words, which is the pattern this console is trying to lose.
  var LOOP_META = {
    harvest: {
      label: 'auto_harvest', icon: 'icon-mine', short: 'mine + refine when the proof is cheap',
      chips: [{ key: 'difficulty_threshold', label: 'difficulty' }],
    },
    build: {
      label: 'auto_build', icon: 'icon-deploy', short: 'fill free slots with the defensive loadout',
      chips: [{ key: 'complete_difficulty', label: 'difficulty' }],
    },
    defend: {
      label: 'auto_defend', icon: 'icon-defend', short: 'guard the Command Ship, then production',
      chips: [],
    },
    infuse: {
      label: 'auto_infuse', icon: 'icon-send-alpha', short: 'infuse spare Alpha into the reactor',
      chips: [{ key: 'keep_grams', label: 'reserve', icon: 'sui-icon-alpha-matter', unit: 'alpha' }],
    },
    sweep: {
      label: 'auto_sweep', icon: 'icon-transfers', short: 'move Alpha to the primary as it accumulates',
      chips: [
        { key: 'min_send_alpha', label: 'at', icon: 'sui-icon-alpha-matter', unit: 'alpha' },
        { key: 'max_sends_per_scan', label: 'per scan' },
      ],
    },
    response: {
      label: 'auto_response', icon: 'icon-counter', short: 'answer a raid inside its 2-minute window',
      chips: [{ key: 'mode', label: 'response' }], war: true,
    },
    raid: {
      label: 'auto_raid', icon: 'icon-raid', short: 'score targets, fly expendable raiders',
      chips: [{ key: 'posture', label: 'posture' },
        { key: 'min_ore', label: 'min ore', icon: 'sui-icon-alpha-ore', unit: 'ore' }], war: true,
    },
    delegation: {
      label: 'delegation', icon: 'icon-key', short: 'every player grants the primary full control',
      chips: [{ key: 'max_grants_per_scan', label: 'per scan' }],
    },
  };

  // Per-field presentation. Anything not listed still renders — the type of the
  // value decides the control — so a new knob on the Rust side needs no UI work.
  var FIELD_META = {
    autonomy: { label: 'autonomy', options: ['advise', 'auto'], hint: 'advise proposes; auto signs' },
    mode: { label: 'response mode', options: ['harden', 'counter', 'decapitate'] },
    posture: { label: 'posture', options: ['cautious', 'opportunist', 'aggressive'], hint: 'rewrites every gate in this card' },
  preset: { label: 'preset', options: ['off','measured','human','wild'], hint: 'rewrites every temperament in this card' },
  temperature: { label: 'temperature', min: 0, max: 5, step: 0.05, hint: '0 = always the best move; higher samples among the good ones' },
  mistake_rate: { label: 'mistake rate', min: 0, max: 1, step: 0.01, hint: 'chance of a deliberately worse but still legal move' },
  hesitate_min_ms: { label: 'hesitate min', min: 0, max: 30000, step: 100, unit: 'ms' },
  hesitate_max_ms: { label: 'hesitate max', min: 0, max: 30000, step: 100, unit: 'ms' },
    interval_secs: { label: 'scan every', min: 5, unit: 's' },
    difficulty_threshold: { label: 'harvest at difficulty ≤', min: 1, max: 64 },
    complete_difficulty: { label: 'complete at difficulty ≤', min: 1, max: 64 },
    keep_grams: { label: 'Alpha reserve', min: 0, unit: 'g' },
    min_send_alpha: { label: 'sweep once a player holds', min: 0, step: 1, unit: 'g',
      hint: 'measured AFTER the reserve below is set aside' },
    keep_reserve_alpha: { label: 'leave behind', min: 0, step: 1, unit: 'g' },
    min_charge: { label: 'only if charge is at least', min: 0,
      hint: 'sending resets charge to 0, so a low bar steals charge from mining' },
    max_sends_per_scan: { label: 'max players per scan', min: 1,
      hint: 'the cap that stops this becoming the burst it replaces' },
    max_grants_per_scan: { label: 'max grants per scan', min: 1,
      hint: 'paces the backfill so a big roster never queues thousands of txs at once' },
    min_ore: { label: 'min ore (the whole prize)', min: 0, unit: 'g' },
    min_score: { label: 'min score (0-100)', min: 0, max: 100 },
    max_raid_minutes: { label: 'max raid proof (min)', min: 1 },
    max_defenders: { label: 'max defenders on their CMD', min: 0 },
    skip_if_defender_active_mins: { label: 'skip if defender acted within (min)', min: 0 },
    target_cooldown_mins: { label: 'target cooldown (min)', min: 0 },
    max_concurrent_raids: { label: 'max concurrent raids', min: 1 },
    abort_cmd_hp_below: { label: 'recall raider below CMD HP', min: 0 },
    abort_on_ongoing_blocks: { label: 'give up after (blocks)', min: 0 },
    max_raid_wall_minutes: { label: 'max expedition (min)', min: 1 },
    siege_max_shots: { label: 'siege shot budget', min: 0 },
    require_vulnerable_now: { label: 'only raid already-vulnerable targets' },
    allow_siege: { label: 'allow siege (kill their CMD to open the window)' },
    return_home_after: { label: 'return home when done' },
    max_shots_per_incident: { label: 'max shots / incident', min: 0 },
    max_shots_per_hour: { label: 'max shots / hour', min: 0 },
    incident_cooldown_secs: { label: 'incident cooldown (s)', min: 0 },
    min_charge_margin: { label: 'charge headroom before firing', min: 0 },
    prefer_counter_free_ambit: { label: 'prefer a counter-free ambit (free shots)' },
    panic_refine: { label: 'panic-refine the threatened ore' },
    include_primary_shooters: { label: 'let the primary shoot too' },
    include_primary: { label: 'include the primary player' },
    include_bait: { label: 'include bait players' },
    auto_explore: { label: 'explore when the planet runs dry' },
    refine: { label: 'refine, not just mine' },
    dry_run: { label: 'dry run (compute, never sign)' },
    roster_ttl_secs: { label: 'candidate roster freshness (s)', min: 60 },
    sweep_max_pages: { label: 'sweep depth (pages)', min: 1 },
    evaluate_per_scan: { label: 'candidates scored per scan', min: 1 },
    raid_difficulty: { label: 'raid proof difficulty', min: 1, max: 64 },
    raid_hours_utc: { label: 'raid only during (UTC hours)', hint: 'comma-separated, empty = any hour' },
    raider_players: { label: 'raider players', hint: 'comma-separated ids, empty = every raider' },
    w_ore: { label: 'weight: ore held', step: 0.1, min: 0 },
    w_vulnerability: { label: 'weight: vulnerable now', step: 0.1, min: 0 },
    w_weakness: { label: 'weight: weak defences', step: 0.1, min: 0 },
    w_grudge: { label: 'weight: grudge heat', step: 0.1, min: 0 },
    w_guild: { label: 'weight: priority guild', step: 0.1, min: 0 },
    w_speed: { label: 'weight: fast raid proof', step: 0.1, min: 0 },
    w_history: { label: 'weight: our record here', step: 0.1, min: 0 },
  };

  function prettyKey(k) { return k.replace(/_/g, ' '); }

  // A structicon set inline with a row's name — lighter than a 40px portrait
  // frame in a list whose real control is the checkbox beside it.
  function titleWithIcon(iconName, text) {
    var w = H.el('span', 'row-title');
    if (iconName) w.appendChild(H.el('i', H.iconClass(iconName)));
    w.appendChild(document.createTextNode(text));
    return w;
  }

  /* A loop's cadence.
   *
   * This function used to be a fourth private time ladder, and its own comment
   * explained why: *"NOT fmtEta: that one floors everything under a minute to
   * 1m, which would hide the whole point of auto_response's 20-second scan."*
   * The missing seconds rung was real — the answer was to give the shared
   * ladder one, not to fork it. Forking also lost the days rung, so a loop on
   * a daily cadence read as "24h".
   */
  function fmtCadence(s) { return H.duration(s); }

  // Policies with no config of their own would otherwise render as a bare name.
  var POLICY_BLURB = {
    agent_ui: 'lets the agent draw toasts and prompts in this window',
    auto_counterattack: 'recommends a counter when you are attacked',
    auto_rebuild_losses: 'recommends rebuilding what combat destroyed',
    auto_refine: 'starts a refine as soon as a mine completes',
    board_auto_open: 'opens this window on an important event',
    combat_alert: 'notifies on hostile activity against the team',
    watchdog_remediate: 'restarts loops, hashers and sync when they wedge',
  };

  // Build an editor for one loop config, generically: booleans become SUI
  // checkboxes, numbers steppers, known enums selects, arrays comma text.
  // Every edit writes the WHOLE config back through the same setter the agent
  // uses, so there is one write path regardless of who is driving.
  // opts (all optional):
  //   filter(key)  — render only the keys it accepts, so one config can be
  //                  split across several cards without forking the editor
  //   chrome:false — drop the loop summary / cross-page pointer (already
  //                  implied by the page you're on)
  //   after()      — what to re-render once a write lands (defaults to Config)
  function loopEditor(which, cfg, opts) {
    opts = opts || {};
    var host = H.el('div');
    var meta = LOOP_META[which] || { label: which };
    var draft = JSON.parse(JSON.stringify(cfg));
    var after = opts.after || renderConfig;
    var errHost = opts.errorHost || 'config-body';
    function commit(extra) {
      return Board.T.core.invoke('mcp_config_set', {
        domain: 'loop',
        payload: Object.assign({ loop: which, config: draft }, extra || {}),
      }).then(function () { return after(); })
        .catch(function (e) { alertInto(errHost, 'write failed: ' + e); });
    }

    if (opts.chrome !== false) {
      if (meta.short) host.appendChild(H.el('div', 'ops-muted', meta.short));
      if (meta.war) {
        host.appendChild(H.alertLine(
          'Grudges, the never-attack list and the live target board live on the War tab.', 'icon-raid'));
      }
    }

    Object.keys(draft).filter(opts.filter || function () { return true; }).sort(function (a, b) {
      // `enabled` first, then booleans, then the rest alphabetically — the
      // switch you came for should never be buried under twenty numbers.
      if (a === 'enabled') return -1;
      if (b === 'enabled') return 1;
      var ba = typeof draft[a] === 'boolean', bb = typeof draft[b] === 'boolean';
      if (ba !== bb) return ba ? -1 : 1;
      return a < b ? -1 : 1;
    }).forEach(function (k) {
      var v = draft[k];
      var fm = FIELD_META[k] || {};
      var label = fm.label || prettyKey(k);
      var ctl;
      if (typeof v === 'boolean') {
        ctl = H.checkbox(v, null, function (nv) { draft[k] = nv; commit(); });
      } else if (typeof v === 'number') {
        ctl = H.stepper(v, { min: fm.min, max: fm.max, step: fm.step, width: '3.5em' },
          function (nv) { draft[k] = nv; commit(); });
        // The unit rides beside the control instead of inside the label text,
        // so a column of steppers reads "300 s / 20 s / 30" rather than making
        // every label carry a parenthetical.
        if (fm.unit) {
          var pair = H.el('span', 'stepper-unit-pair');
          pair.appendChild(ctl);
          pair.appendChild(H.el('span', 'stepper-unit', fm.unit));
          ctl = pair;
        }
      } else if (Array.isArray(v)) {
        ctl = H.textBox(v.join(', '), fm.hint, function (nv) {
          var parts = nv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          // Numeric arrays (raid_hours_utc) must stay numbers on the wire.
          draft[k] = parts.map(function (s) { return /^\d+$/.test(s) ? Number(s) : s; });
          commit();
        });
      } else if (fm.options) {
        ctl = H.selectBox(v, fm.options, function (nv) {
          draft[k] = nv;
          // A posture rewrites every gate under it, so tell the backend to
          // re-apply the preset rather than merging whatever the form showed.
          commit(k === 'posture' ? { apply_posture: true } : null);
        });
      } else {
        ctl = H.textBox(v, fm.hint, function (nv) { draft[k] = nv; commit(); });
      }
      host.appendChild(H.field(label, ctl, typeof v === 'boolean' ? fm.hint : null));
    });
    return host;
  }

  // ── CONFIG sections ──────────────────────────────────────────────────────
  // Which section is showing comes from the route (Board.AREAS), not a local
  // list — Squads lives under Armada and the rest under System, and this page
  // just renders whichever one it was handed.
  var configState = { section: 'doctrine', data: null };

  function sectionDoctrine(d, body) {
    var doc = d.doctrine || {};
    var dbody = H.el('div');
    dbody.appendChild(H.row('Posture / Autonomy', (doc.posture || '?') + ' / ' + (doc.autonomy || '?')));
    if (doc.pinned_target) dbody.appendChild(H.row('Pinned target', doc.pinned_target));

    var pr = H.el('div', 'cfg-actions');
    (d.presets || []).forEach(function (p) {
      var b = massBtn('preset-' + p, 'icon-key', p, 'sui-mod-secondary');
      b.addEventListener('click', function () { cfgSet('doctrine', { preset: p }); });
      pr.appendChild(b);
    });
    dbody.appendChild(pr);
    body.appendChild(H.card('DOCTRINE', dbody));
  }

  function sectionLoops(d, body) {
    var loops = d.loops || {};
    var lbody = H.el('div');
    var table = H.resultTable();
    table.classList.add('list-short');
    Object.keys(LOOP_META).forEach(function (name) {
      var cfg = loops[name];
      if (!cfg) return;
      var meta = LOOP_META[name];
      // The checkbox already says on/off, so the tiles carry only what it
      // can't: how the loop is configured. Each is captioned rather than
      // relying on an icon to imply what a bare number means.
      // A settings value that names a QUANTITY is shown in that quantity's
      // own units — "reserve 5" and "reserve 5g" are not the same claim, and
      // the icon beside it was doing all the work.
      var chips = (meta.chips || []).map(function (c) {
        var v = cfg[c.key];
        var text = c.unit === 'alpha' ? alpha(Number(v) * 1e6)
          : c.unit === 'ore' ? ore(Number(v))
          : String(v);
        return statTile(c.label, text, c.icon || null);
      });
      chips.push(statTile('every', fmtCadence(cfg.interval_secs)));
      if (cfg.autonomy) {
        chips.push(statTile('autonomy', cfg.autonomy, null, cfg.autonomy === 'auto' ? 'live' : ''));
      }
      if (cfg.dry_run) chips.push(statTile('mode', 'dry run'));
      table.appendChild(H.resultRow({
        lead: H.checkbox(cfg.enabled, null, function (on) {
          var next = JSON.parse(JSON.stringify(cfg));
          next.enabled = on;
          cfgSet('loop', { loop: name, config: next });
        }),
        title: titleWithIcon(meta.icon, meta.label),
        subtitle: meta.short,
        chips: chips,
        action: H.el('i', 'icon-chevron-right row-chevron'),
        onClick: function () { H.detailModal(meta.label, loopEditor(name, cfg)); },
      }));
    });
    lbody.appendChild(table);
    // The switch leads each row and every row carries a chevron, so "toggle
    // here, click through for the rest" needs no sentence.
    body.appendChild(H.card('AUTO-LOOPS', lbody));
  }

  function sectionPolicies(d, body) {
    var pol = d.policies || {};
    var names = Object.keys(pol).sort();
    if (!names.length) return;
    var pbody = H.el('div');
    // Same idiom as the loop list: the switch leads the row, so a column of
    // toggles reads as a column of toggles instead of labels with a control
    // stranded at the far edge of a wide window.
    var ptable = H.resultTable();
    ptable.classList.add('list-short');
    names.forEach(function (name) {
      var p = pol[name] || {};
      var cfgStr = p.config && Object.keys(p.config).length
        ? Object.keys(p.config).map(function (k) { return prettyKey(k) + ' ' + p.config[k]; }).join(' · ')
        : POLICY_BLURB[name] || null;
      ptable.appendChild(H.resultRow({
        lead: H.checkbox(p.enabled, null, function (on) { cfgSet('policy', { name: name, enabled: on }); }),
        title: name,
        subtitle: cfgStr,
        chips: [statTile('state', p.enabled ? 'on' : 'off', null, p.enabled ? 'live' : 'muted')],
      }));
    });
    pbody.appendChild(ptable);
    body.appendChild(H.card('POLICIES · one rule each, evaluated per sync', pbody));
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  // Which events may raise a NATIVE desktop notification. The switches are the
  // whole truth: every source — the grass tap in the game window, the combat
  // assessment, Comms, the watchdog, the updater — routes through one Rust gate
  // keyed by these same channel names, so nothing can interrupt off-list.
  //
  // Channels, labels and grouping come from Rust (notifications::CHANNELS), not
  // from a list restated here: a channel added on one side and missed on the
  // other is exactly the failure this section exists to make visible.
  function sectionNotifications(d, body) {
    var n = (d && d.notifications) || {};
    var chans = n.channels || [];

    var head = H.el('div');
    head.appendChild(H.field('desktop notifications',
      H.checkbox(n.enabled, null, function (on) { cfgSet('notify', { enabled: on }); })));
    var tiles = H.el('div', 'hstrip');
    var live = chans.filter(function (c) { return c.enabled; }).length;
    tiles.appendChild(statTile('channels on', live + '/' + chans.length, null,
      (n.enabled && live) ? 'live' : 'muted'));
    // macOS can withhold authorisation entirely, and then every switch here is
    // a promise the app cannot keep. Shown as a reading, not a warning banner.
    tiles.appendChild(statTile('system permission', n.permission ? 'granted' : 'denied', null,
      n.permission ? 'ok' : 'bad'));
    head.appendChild(tiles);
    body.appendChild(H.card('NOTIFICATIONS', head));

    // Group order follows the server's channel order — the first time a group
    // is seen fixes its position, so Rust owns the layout too.
    var order = [], byGroup = {};
    chans.forEach(function (c) {
      if (!byGroup[c.group]) { byGroup[c.group] = []; order.push(c.group); }
      byGroup[c.group].push(c);
    });

    order.forEach(function (group) {
      var rows = byGroup[group];
      var allOn = rows.every(function (c) { return c.enabled; });
      var wrap = H.el('div');
      wrap.appendChild(H.field('all ' + group.toLowerCase(),
        H.checkbox(allOn, null, function (on) {
          cfgSet('notify', { group: group, on: on });
        })));
      var t = H.resultTable();
      t.classList.add('list-short');
      rows.forEach(function (c) {
        // The master switch silences everything without rewriting any channel,
        // so a channel keeps showing its own setting and the CHIP carries the
        // fact that nothing is getting through.
        var state = !n.enabled ? 'muted' : c.enabled ? 'on' : 'off';
        t.appendChild(H.resultRow({
          lead: H.checkbox(c.enabled, null, function (on) {
            cfgSet('notify', { channel: c.key, on: on });
          }),
          title: c.label,
          subtitle: c.key,
          chips: [statTile('state', state, null, state === 'on' ? 'live' : 'muted')],
        }));
      });
      wrap.appendChild(t);
      body.appendChild(H.card(group.toUpperCase(), wrap));
    });
  }

  function sectionEngine(d, body) {
    var hc = d.hash || {};
    var hbody = H.el('div');
    hbody.appendChild(H.field('hashing enabled',
      H.checkbox(hc.enabled, null, function (on) { cfgSet('hash', { enabled: on }); })));
    hbody.appendChild(H.field('engine',
      H.selectBox(hc.engine_pref, ['auto', 'cpu', 'gpu'], function (v) { cfgSet('hash', { engine: v }); }),
      hc.gpu_available ? 'GPU available' : 'CPU only'));
    hbody.appendChild(H.field('difficulty start',
      H.stepper(hc.difficulty_start, { min: 1, max: 64, width: '3.5em' },
        function (v) { cfgSet('hash', { difficulty_start: v }); })));
    hbody.appendChild(H.field('max concurrent proofs',
      H.stepper(hc.max_concurrent, { min: 1, max: 64, width: '3.5em' },
        function (v) { cfgSet('hash', { max_concurrent: v }); })));
    hbody.appendChild(H.field('auto-tune from solve history',
      H.checkbox(hc.auto_tune, null, function (on) { cfgSet('hash', { auto_tune: on }); })));
    body.appendChild(H.card('HASH ENGINE', hbody));
  }

  function sectionAccess(d, body) {
    var wb = d.web_board || {};
    var wbody = H.el('div');
    wbody.appendChild(H.field('serve this dashboard as a web page',
      H.checkbox(wb.enabled, null, function (on) { cfgSet('web_board', { enabled: on }); })));
    if (wb.enabled && wb.url) {
      // The URL carries a bearer token that is FULL operator control. That used
      // to be said in a sentence under it while the secret itself sat on screen
      // in plain text — the wrong way round. Mask it like the credential it is:
      // masked-by-default says "password" faster and more durably than prose,
      // and Copy never requires revealing it at all.
      var masked = String(wb.url).replace(/(token=)[^&]+/, '$1' + '•'.repeat(24));
      var shown = false;
      var urow = H.el('div', 'cfg-row secret-row');
      var val = H.el('code', 'cfg-url secret-val', masked);
      urow.appendChild(val);
      var acts = H.el('span', 'secret-acts');
      var eye = H.el('a', 'ops-refresh-btn'); eye.href = 'javascript:void(0)';
      eye.title = 'Reveal the token';
      eye.appendChild(H.el('i', 'icon-detected'));
      eye.addEventListener('click', function () {
        shown = !shown;
        val.textContent = shown ? wb.url : masked;
        eye.title = shown ? 'Hide the token' : 'Reveal the token';
      });
      var copy = H.el('a', 'ops-refresh-btn'); copy.href = 'javascript:void(0)';
      copy.title = 'Copy the full URL';
      copy.appendChild(H.el('i', 'icon-transfers'));
      copy.addEventListener('click', function () {
        try { navigator.clipboard.writeText(wb.url); } catch (e) {}
        var was = copy.title; copy.title = 'Copied';
        copy.classList.add('is-busy');
        setTimeout(function () { copy.classList.remove('is-busy'); copy.title = was; }, 900);
      });
      acts.appendChild(eye); acts.appendChild(copy);
      urow.appendChild(acts);
      wbody.appendChild(urow);
      // Where it is reachable from is a READING, not advice.
      var bind = H.el('div', 'hstrip');
      bind.appendChild(statTile('bound to', wb.bind || '127.0.0.1', null, 'muted'));
      if (wb.port) bind.appendChild(statTile('port', String(wb.port), null, 'muted'));
      bind.appendChild(statTile('token', 'full operator control', null, 'bad'));
      wbody.appendChild(bind);
    }
    body.appendChild(H.card('WEB DASHBOARD', wbody));

  }

  function renderConfig() {
    return Board.T.core.invoke('mcp_config_bundle').then(function (d) {
      configState.data = d;
      renderConfigBody();
    }).catch(function (e) {
      var body = document.getElementById('config-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('config unavailable: ' + e, 'icon-alert'));
    });
  }


  // ── Behaviour Profiles ────────────────────────────────────────────────────
  // A profile bundles a build loadout + capability switches + temperament, and
  // replaces the hardcoded bait/productive/raider roles. loopEditor cannot be
  // reused: it is flat-only, and a loadout is an ordered array of objects — it
  // would render [object Object] and destroy the data on write. So this is a
  // hand-written card, exactly as the naming card is for its nested Style.
  var profiles = { data: null, open: null };

  function profSet(payload) {
    return Board.T.core.invoke('mcp_config_set', { domain: 'profile', payload: payload })
      .then(function () {
        return Board.T.core.invoke('mcp_profiles_get').then(function (d) {
          profiles.data = d; rerenderProfiles();
        });
      })
      .catch(function (e) { alertInto('profiles-card', 'rejected: ' + e); });
  }

  // The webapp ships art for every struct type at
  // img/structs/<slug>/<slug>-struct-base.png. The slug is the kebab-cased
  // class name for most types, but nine are abbreviated — that map lives in
  // StructTypeArtSetBuilder, which is submodule code we do not edit, so it is
  // mirrored here (it is presentation, and it belongs on this side anyway).
  // Two types (Continental Power Plant, World Engine) genuinely have no art;
  // they fall back to a glyph rather than a broken image.
  var STRUCT_ART = {
    'command ship': 'cmd-ship',
    'ore extractor': 'extractor',
    'ore refinery': 'refinery',
    'field generator': 'generator',
    'high altitude interceptor': 'interceptor',
    'jamming satellite': 'jamming-sat',
    'orbital shield generator': 'orb-shield',
    'planetary defense cannon': 'pdc',
    'sam launcher': 'sam-launcher',
  };

  function artSlug(name) {
    var k = String(name || '').toLowerCase();
    return STRUCT_ART[k] || k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // A struct type as the framed 44px portrait SUI already uses for result rows.
  // `src` is RELATIVE on purpose: the same board is served from the Tauri asset
  // root and from /board over HTTP, and an absolute /img path 404s on the
  // latter (see pfpPortrait, which is relative for the same reason).
  function structPortrait(name) {
    var box = H.el('div', 'sui-result-row-portrait');
    var frame = H.el('div', 'sui-result-row-portrait-image prof-art');
    var im = H.el('img');
    im.src = 'img/structs/' + artSlug(name) + '/' + artSlug(name) + '-struct-base.png';
    im.alt = '';
    // No art for this type — show the generic deploy glyph instead of the
    // browser's broken-image box.
    im.addEventListener('error', function () {
      frame.removeChild(im);
      frame.appendChild(H.el('i', H.iconClass('icon-deploy', 'sui-icon-md')));
    });
    frame.appendChild(im);
    box.appendChild(frame);
    return box;
  }

  // SUI ships an icon per ambit (sui-icon-water/land/air/space); using them
  // rather than the word makes an ambit readable at a glance in a 332px drawer.
  function ambitChip(ambit) {
    var w = H.el('span', 'prof-ambit');
    w.appendChild(H.el('i', 'sui-icon sui-icon-sm sui-icon-' + ambit));
    w.appendChild(H.el('span', null, ambit));
    w.title = ambit;
    return w;
  }

  // The four slots of one (target, ambit), drawn as pips. THIS is what makes
  // the section legible: `want` is not a free number, it is a claim on four
  // chain slots shared with every other row in the same ambit. So each row
  // shows all four — the ones earlier rows already claimed, its own, and what
  // is left — and clicking a pip sets `want` directly.
  //
  // One-per-player types get a single locked pip: the chain rejects a second.
  function slotPips(taken, want, free, onSet) {
    var w = H.el('span', 'prof-pips');
    var total = taken + want + free;
    for (var i = 0; i < total; i++) {
      var mine = i >= taken && i < taken + want;
      var cls = 'prof-pip' + (i < taken ? ' is-taken' : mine ? ' is-mine' : '');
      var pip = H.el('span', cls);
      if (onSet && i >= taken) {
        (function (n) {
          pip.classList.add('is-clickable');
          pip.title = 'keep ' + n;
          pip.addEventListener('click', function () { onSet(n); });
        })(i - taken + 1);
      }
      w.appendChild(pip);
    }
    return w;
  }

  // ORDER IS PRIORITY, and slots free only when a hull dies — so a row moved is
  // a decision that persists for weeks. Reorder writes the whole document
  // because the order IS the data.
  function previewText(pv) {
    if (!pv) return 'no preview';
    var txt = pv.verdict;
    if ((pv.blind || []).length) txt += ' — no viable shot into [' + pv.blind.join(', ') + ']';
    else if (pv.covered_after != null) txt += ' — all four ambits answered after ' + pv.covered_after + ' build(s)';
    return txt;
  }

  // One SUI result row per profile, with the consequence as chips. Clicking
  // opens the editor in the standard drawer — the same shape the roster and the
  // WAR lists use, rather than five stacked full-width blocks.
  function profileRow(p, assignedCount) {
    // `chips` are NODES, not descriptors — resultRow appendChild()s each one.
    // statTile(label, value, iconName, cls) is the house chip.
    var pv = p.preview || {};
    var blind = pv.blind || [];
    var chips = [statTile('coverage', pv.verdict || '?', null, blind.length ? 'bad' : 'ok')];
    if (blind.length) {
      chips.push(statTile('blind in', blind.join(', '), null, 'bad'));
    } else if (pv.covered_after != null) {
      chips.push(statTile('covered after', pv.covered_after + ' builds', null, 'ok'));
    }
    chips.push(statTile('loadout', p.loadout.length + ' rows'));
    chips.push(statTile('varies', p.temperament_label || '?'));
    if (assignedCount) chips.push(statTile('in use', assignedCount + ' player(s)'));

    return H.resultRow({
      title: p.id + (p.builtin ? '  (built-in)' : ''),
      subtitle: p.label,
      chips: chips,
      onClick: function () { profiles.open = p.id; H.drawer(p.id, profileEditor(p)); },
    });
  }

  // The editor body, shown inside the drawer.
  //
  // Everything is `H.row(label, value)` — a two-column `sui-data-card-row` that
  // uses the drawer's width instead of stacking a caption above each control.
  // The first cut used H.field + resultRow throughout, which turned one loadout
  // entry into four wrapped lines and made a 17-row profile unreadable.
  function actionBar(p, list, i, onChange) {
    var wrap = H.el('span', 'prof-actions');
    if (p.builtin) return wrap;
    wrap.appendChild(iconBtn('icon-caret-up', 'higher priority', function () {
      if (i === 0) return;
      list.splice(i - 1, 0, list.splice(i, 1)[0]); onChange();
    }));
    wrap.appendChild(iconBtn('icon-caret-down', 'lower priority', function () {
      if (i >= list.length - 1) return;
      list.splice(i + 1, 0, list.splice(i, 1)[0]); onChange();
    }));
    wrap.appendChild(iconBtn('icon-close', 'remove', function () {
      list.splice(i, 1); onChange();
    }));
    return wrap;
  }

  // `raider-copy`, then `raider-copy-2`, ... — first id not already taken.
  function nextForkId(base) {
    var taken = {};
    ((profiles.data && profiles.data.profiles) || []).forEach(function (x) { taken[x.id] = true; });
    var id = base + '-copy';
    for (var n = 2; taken[id]; n++) id = base + '-copy-' + n;
    return id;
  }

  // ── The build order ─────────────────────────────────────────────────────
  //
  // auto_build walks this list top to bottom and builds the first row it can
  // afford and has a slot for, so the ORDER is the strategy and `want` is a
  // claim on the four chain slots that (target, ambit) has. The first version
  // of this section rendered `1. Tank   planet/land ×2` as plain text, which
  // showed neither of those facts and gave no way to add a row at all.
  //
  // Everything below is derived from the synced type catalog: `category` fixes
  // the target and `possible_ambit` fixes the legal ambits, so an author picks
  // a struct and the impossible combinations are never offered.

  function slotsPerAmbit() {
    return (profiles.data && profiles.data.slots_per_ambit) || 4;
  }

  function catalogList() {
    return (profiles.data && profiles.data.catalog) || [];
  }

  function catalogType(name) {
    var k = String(name || '').toLowerCase();
    var all = catalogList();
    for (var i = 0; i < all.length; i++) {
      if (all[i].name.toLowerCase() === k) return all[i];
    }
    return null;
  }

  // want totals per "target/ambit", plus what each row is preceded by — the
  // two numbers every pip strip needs.
  function slotUse(loadout) {
    var total = {}, before = [];
    loadout.forEach(function (e) {
      var k = e.target + '/' + e.ambit;
      before.push(total[k] || 0);
      total[k] = (total[k] || 0) + e.want;
    });
    return { total: total, before: before };
  }

  // "how full is every ambit" — the reason to add a row, so it sits above the
  // list. An ambit at 0/4 is the gap that leaves a fleet with no answer.
  function slotSummary(p) {
    var use = slotUse(p.loadout).total;
    var cap = slotsPerAmbit();
    var byTarget = {};
    catalogList().forEach(function (t) {
      (byTarget[t.target] = byTarget[t.target] || {});
      t.ambits.forEach(function (a) { byTarget[t.target][a] = true; });
    });
    var out = H.el('div');
    ['fleet', 'planet'].forEach(function (target) {
      var ambits = byTarget[target];
      if (!ambits) return;
      var val = H.el('span', 'prof-slotbar');
      ['water', 'land', 'air', 'space'].forEach(function (a) {
        if (!ambits[a]) return;
        var n = use[target + '/' + a] || 0;
        var chip = H.el('span', 'prof-slot' + (n === 0 ? ' is-empty' : n >= cap ? ' is-full' : ''));
        chip.appendChild(H.el('i', 'sui-icon sui-icon-sm sui-icon-' + a));
        chip.appendChild(H.el('span', null, n + '/' + cap));
        chip.title = target + ' ' + a + ': ' + n + ' of ' + cap + ' slots claimed';
        val.appendChild(chip);
      });
      out.appendChild(H.row(target === 'fleet' ? 'Fleet slots' : 'Planet slots', val));
    });
    return out;
  }

  // One build row: priority, art, what and where, its slot claim, and the
  // controls that move or drop it.
  function buildRow(p, i, use, save) {
    var e = p.loadout[i];
    var t = catalogType(e.type_name);
    var cap = slotsPerAmbit();
    var one = !!(t && t.one_per_player);
    var taken = use.before[i];
    var free = one ? 0 : Math.max(0, cap - taken - e.want);

    var pips = slotPips(taken, one ? 1 : e.want, free, (p.builtin || one) ? null : function (n) {
      e.want = n; save();
    });
    pips.title = one ? 'the chain allows one per player' : e.want + ' of ' + cap + ' slots';

    // Where and how many both live on the subtitle line. The drawer is 332px:
    // putting the pips in the row's right-hand `chips` section alongside the
    // reorder controls starved the label block, and with `overflow-wrap:
    // anywhere` already set for the drawer that rendered the type name one
    // CHARACTER per line.
    var sub = H.el('span', 'prof-sub');
    sub.appendChild(ambitChip(e.ambit));
    sub.appendChild(H.el('span', 'ops-muted', e.target));
    if (!t) sub.appendChild(H.el('i', H.iconClass('icon-alert', 'sui-icon-sm')));
    sub.appendChild(pips);

    return H.resultRow({
      lead: H.el('span', 'prof-pri', String(i + 1)),
      portrait: structPortrait(e.type_name),
      title: e.type_name,
      subtitle: sub,
      action: actionBar(p, p.loadout, i, save),
    });
  }

  // The picker. One row per legal (type, ambit) pair, so a choice is a single
  // click and an impossible pairing is never on screen. Rows that would be
  // rejected — the ambit is full, or the loadout already claims that type
  // there — stay visible but disabled, because a silently missing entry reads
  // as a bug rather than as a rule.
  function buildPicker(p, save, close) {
    var panel = H.el('div', 'prof-picker');
    var cap = slotsPerAmbit();
    var use = slotUse(p.loadout).total;
    var have = {}, owned = {};
    p.loadout.forEach(function (e) {
      have[e.target + '/' + e.ambit + '/' + e.type_name.toLowerCase()] = true;
      // A one-per-player type is capped across the WHOLE player, not per
      // ambit — a second Command Ship in space is a row auto_build would skip
      // forever, so the type is spent everywhere once it appears anywhere.
      owned[e.type_name.toLowerCase()] = true;
    });

    var all = catalogList();
    if (!all.length) {
      panel.appendChild(H.alertLine('struct catalog has not synced yet — open the game window once', 'icon-alert'));
      return panel;
    }

    // One row per legal (type, ambit), ordered by ambit within each target.
    // The slot strip above names the ambit that is empty, so the picker is
    // read as "what can go in air?" — scattering the air options between a
    // Cruiser and a Battleship makes that the reader's job instead.
    var AMBIT_ORDER = { water: 0, land: 1, air: 2, space: 3 };
    var pairs = [];
    all.forEach(function (t) { t.ambits.forEach(function (a) { pairs.push({ t: t, a: a }); }); });
    pairs.sort(function (x, y) {
      return (x.t.target === y.t.target ? 0 : x.t.target === 'fleet' ? -1 : 1)
        || (AMBIT_ORDER[x.a] - AMBIT_ORDER[y.a])
        || ((x.t.draw || 0) - (y.t.draw || 0))
        || (x.t.name < y.t.name ? -1 : 1);
    });

    // Draws exist to be compared against each other here, so they share one
    // unit — scaleSet is the house helper for exactly that. Per-value
    // formatting produced "50W / 0.1KW / 0.11KW" down the same column.
    var pw = H.scaleSet(all.map(function (t) { return t.draw; }), 'power');

    var list = H.resultTable();
    pairs.forEach(function (pair) {
      var t = pair.t, a = pair.a;
      (function () {
        var key = t.target + '/' + a;
        var used = use[key] || 0;
        var here = have[key + '/' + t.name.toLowerCase()];
        var elsewhere = !here && t.one_per_player && owned[t.name.toLowerCase()];
        var dup = here || elsewhere;
        var full = used >= cap;
        var sub = H.el('span', 'prof-sub');
        sub.appendChild(ambitChip(a));
        sub.appendChild(H.el('span', 'ops-muted', t.target));
        // Draw is what actually decides whether a hull can stay online, so it
        // belongs on the choosing screen — as text, because a second stat tile
        // costs the title the width it needs.
        if (t.draw != null) sub.appendChild(H.el('span', 'ops-muted', pw.fmt(t.draw)));

        var chips = [];
        if (here) chips.push(H.statTile('already', 'in loadout', null, 'muted'));
        else if (elsewhere) chips.push(H.statTile('limit', 'one per player', null, 'muted'));
        else if (full) chips.push(H.statTile(a + ' slots', used + '/' + cap, null, 'bad'));
        else chips.push(H.statTile('free', (cap - used) + ' of ' + cap, null, 'ok'));

        var row = H.resultRow({
          portrait: structPortrait(t.name),
          title: t.name,
          subtitle: sub,
          chips: chips,
          onClick: (dup || full) ? null : function () {
            p.loadout.push({ target: t.target, ambit: a, type_name: t.name, want: 1 });
            close();
            save();
          },
        });
        if (dup || full) row.classList.add('is-disabled');
        list.appendChild(row);
      })();
    });
    panel.appendChild(list);
    return panel;
  }

  function buildsSection(p, save, readOnly) {
    var wrap = H.el('div');
    wrap.appendChild(H.el('h4', null, 'Builds — priority order'));
    wrap.appendChild(slotSummary(p));

    var use = slotUse(p.loadout);
    var list = H.resultTable();
    list.classList.add('prof-builds');
    p.loadout.forEach(function (_, i) { list.appendChild(buildRow(p, i, use, save)); });
    wrap.appendChild(list);

    if (p.builtin) return wrap;

    // The picker opens in place, below the list it adds to. A modal would have
    // to stack over the drawer, and the drawer is already the detail surface.
    var slot = H.el('div');
    var actions = H.el('div', 'cfg-actions');
    var addB = massBtn('prof-add-' + p.id, 'icon-add', 'Add a build', 'sui-mod-primary');
    addB.addEventListener('click', function () {
      if (slot.firstChild) { slot.innerHTML = ''; return; }
      slot.appendChild(buildPicker(p, save, function () { slot.innerHTML = ''; }));
      if (slot.scrollIntoView) slot.scrollIntoView({ block: 'nearest' });
    });
    actions.appendChild(addB);
    wrap.appendChild(actions);
    wrap.appendChild(slot);
    return wrap;
  }

  function profileEditor(p) {
    var body = H.el('div', 'cfg-section prof-editor');
    var save = function () { profSet({ action: 'save', id: p.id, profile: p }); };
    var readOnly = function () { rerenderProfiles(); };

    // ── What it achieves, first and compactly ──
    var pv = p.preview || {};
    body.appendChild(H.row('Coverage', pv.verdict || '?'));
    if ((pv.blind || []).length) {
      body.appendChild(H.row('No viable shot into', pv.blind.join(', ')));
    } else if (pv.covered_after != null) {
      body.appendChild(H.row('All four ambits after', pv.covered_after + ' build(s)'));
    }
    if ((pv.unknown_types || []).length) {
      body.appendChild(H.alertLine('unknown struct type(s): ' + pv.unknown_types.join(', '), 'icon-alert'));
    }
    if (p.builtin) {
      body.appendChild(H.el('p', 'ops-muted', 'Built-in — read-only. Fork to make an editable copy.'));
    }

    // ── Identity: a fork lands as `<parent>-copy`, so renaming has to be
    // reachable or every fork is stuck with a generated name. Renaming the ID
    // re-points every player assigned to it (see profile::rename).
    if (!p.builtin) {
      body.appendChild(H.row('Name', H.textBox(p.label, 'display name', function (v) {
        profSet({ action: 'rename', id: p.id, label: v });
      })));
      body.appendChild(H.row('Id', H.textBox(p.id, 'letters, digits, - or _', function (v) {
        var next = (v || '').trim();
        if (!next || next === p.id) return;
        // The open drawer is tracked BY id, so it has to follow the rename or
        // the repaint would find no subject and silently stop updating.
        profiles.open = next;
        profSet({ action: 'rename', id: p.id, new_id: next });
      })));
    }

    // ── Capabilities: one line each, switch on the right ──
    body.appendChild(H.el('h4', null, 'Behaviour'));
    [['raids', 'Flies raids'],
     ['refines', 'Runs refineries'],
     ['sweeps_alpha', 'Sweeps Alpha to the primary'],
     ['auto_defends', 'Maintains a defence web'],
     ['explore_when_drained_only', 'Explores only when drained']]
      .forEach(function (c) {
        var cb = H.checkbox(!!p.capabilities[c[0]], null, function (v) {
          if (p.builtin) return readOnly();
          p.capabilities[c[0]] = v; save();
        });
        body.appendChild(H.row(c[1], cb));
      });
    body.appendChild(H.row('Temperature', H.stepper(
      p.temperament.temperature,
      { min: 0, max: (p.limits && p.limits.temperature_max) || 5, step: 0.05, width: '4.5em' },
      function (v) { if (p.builtin) return readOnly(); p.temperament.temperature = v; save(); }
    )));

    // ── Defends: priority order, first survivor takes the blocker ──
    var d = p.defence || { protect: [], guards_on_primary: 0, guards_on_blocker: 0 };
    body.appendChild(H.el('h4', null, 'Defends — priority order'));
    (d.protect || []).forEach(function (e, i) {
      var name = (typeof e === 'string') ? e : e.type_name;
      var by = (typeof e === 'string') ? [] : (e.by || []);
      var w = (typeof e === 'string') ? 1 : (e.weight == null ? 1 : e.weight);
      var val = H.el('span');
      val.appendChild(H.el('span', 'ops-muted',
        'weight ' + w + (by.length ? '  ·  only ' + by.join(', ') : '') + '  '));
      val.appendChild(actionBar(p, d.protect, i, save));
      body.appendChild(H.row((i + 1) + '. ' + name + (i === 0 ? '  (primary)' : ''), val));
    });
    body.appendChild(H.row('Guards on primary', H.stepper(d.guards_on_primary,
      { min: 0, max: 16, step: 1, width: '4em' },
      function (v) { if (p.builtin) return readOnly(); p.defence.guards_on_primary = v; save(); })));
    body.appendChild(H.row('Guards on its blocker', H.stepper(d.guards_on_blocker,
      { min: 0, max: 16, step: 1, width: '4em' },
      function (v) { if (p.builtin) return readOnly(); p.defence.guards_on_blocker = v; save(); })));

    // ── Builds ──
    body.appendChild(buildsSection(p, save, readOnly));

    var actions = H.el('div', 'cfg-actions');
    var forkB = massBtn('prof-fork-' + p.id, 'icon-add', 'Fork', 'sui-mod-secondary');
    forkB.addEventListener('click', function () {
      // Just do it. A fork costs nothing and is trivially deleted, so asking
      // for a name up front is friction — rename by editing the copy.
      //
      // (It also cannot use window.prompt: the Tauri webview blocks native
      // dialogs, which is why this button silently did nothing at first.)
      profSet({ action: 'fork', from: p.id, id: nextForkId(p.id), label: p.label + ' (copy)' });
    });
    actions.appendChild(forkB);
    var expB = massBtn('prof-exp-' + p.id, 'icon-copy', 'Export', 'sui-mod-secondary');
    expB.addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(p, null, 2));
      alertInto('profiles-card', 'profile "' + p.id + '" copied to clipboard');
    });
    actions.appendChild(expB);
    if (!p.builtin) {
      var delB = massBtn('prof-del-' + p.id, 'icon-close', 'Delete', 'sui-mod-secondary');
      delB.addEventListener('click', function () {
        // Same reason as Fork: window.confirm is inert in the webview.
        H.confirmModal(
          'Delete ' + p.id + '?',
          H.el('p', 'ops-muted', 'Players using it fall back to their role\u2019s built-in.'),
          'Delete',
          function () { profSet({ action: 'delete', id: p.id }); }
        );
      });
      actions.appendChild(delB);
    }
    body.appendChild(actions);
    return body;
  }

  function renderProfilesCard() {
    var d = profiles.data || {};
    var body = H.el('div', 'cfg-section');
    var assigned = d.assigned || {};
    var list = H.resultTable();
    (d.profiles || []).forEach(function (p) {
      list.appendChild(profileRow(p, assigned[p.id] || 0));
    });
    body.appendChild(list);

    var imp = H.el('div', 'cfg-actions');
    var impB = massBtn('prof-import', 'icon-copy', 'Import from clipboard', 'sui-mod-secondary');
    impB.addEventListener('click', function () {
      if (!navigator.clipboard) { alertInto('profiles-card', 'clipboard unavailable'); return; }
      navigator.clipboard.readText().then(function (txt) {
        var doc; try { doc = JSON.parse(txt); } catch (e) { alertInto('profiles-card', 'not valid JSON'); return; }
        profSet({ action: 'save', id: doc.id, profile: doc });
      });
    });
    imp.appendChild(impB);
    body.appendChild(imp);
    return body;
  }

  function rerenderProfiles() {
    var host = document.getElementById('profiles-card');
    if (!host) return;
    var fresh = renderProfilesCard();
    fresh.id = 'profiles-card';
    host.parentNode.replaceChild(fresh, host);
    repaintOpenProfile();
  }

  // Every edit happens INSIDE the drawer, and most of what the drawer shows is
  // derived — slot totals, pips, the coverage verdict. Repainting only the card
  // behind it left all of that stale until the drawer was closed and reopened,
  // so adding a build appeared to do nothing. Write the fresh body straight
  // into the open drawer instead of calling H.drawer again, which would
  // re-run the open animation on every keystroke.
  function repaintOpenProfile() {
    if (!profiles.open) return;
    // H.drawer targets SUI's offcanvas when the runtime is present and falls
    // back to #detail-overlay when it is not (the jsdom harness takes that
    // path). Repaint whichever one is actually on screen — handling only the
    // offcanvas made this untestable and left the fallback stale.
    var oc = document.getElementById('sui-offcanvas');
    var host = (oc && !oc.classList.contains('hidden')) ? oc.querySelector('.sui-offcanvas-body') : null;
    if (!host) {
      var ov = document.getElementById('detail-overlay');
      host = ov && ov.querySelector('.detail-panel');
    }
    if (!host) { profiles.open = null; return; }
    var fresh = null;
    ((profiles.data && profiles.data.profiles) || []).forEach(function (x) {
      if (x.id === profiles.open) fresh = x;
    });
    // Renamed or deleted out from under us — the drawer no longer has a subject.
    if (!fresh) { profiles.open = null; return; }
    var editor = profileEditor(fresh);
    var prev = host.querySelector('.prof-editor');
    if (prev) prev.parentNode.replaceChild(editor, prev);
    else { host.innerHTML = ''; host.appendChild(editor); }
  }

  function renderProfiles(body) {
    var host = H.el('div'); host.id = 'profiles-card';
    body.appendChild(host);
    Board.T.core.invoke('mcp_profiles_get').then(function (d) {
      profiles.data = d; rerenderProfiles();
    }).catch(function (e) { host.appendChild(H.alertLine('profiles unavailable: ' + e, 'icon-alert')); });
  }

  function renderConfigBody() {
    var d = configState.data; if (!d) return;
    var body = document.getElementById('config-body');
    body.innerHTML = '';
    // No local nav strip: these sections are routed (System/… and Armada/
    // Squads), so the area sub-nav above is the one place they're listed.
    switch (configState.section) {
      case 'loops': sectionLoops(d, body); break;
      case 'policies': sectionPolicies(d, body); break;
      case 'notifications': sectionNotifications(d, body); break;
      case 'engine': sectionEngine(d, body); break;
      case 'access': sectionAccess(d, body); break;
      // Squad identity is a name AND a portrait; both live here.
      case 'appearance': renderCallsigns(body); renderRoleAppearance(body); break;
      case 'profiles': renderProfiles(body); break;
      default: sectionDoctrine(d, body); break;
    }
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }
  Board.registerPage('config', {
    onEnter: function (params, view) {
      if (view) configState.section = view;
      return renderConfig();
    },
    refresh: renderConfig,
    cadenceMs: 60000,
  });

})();
