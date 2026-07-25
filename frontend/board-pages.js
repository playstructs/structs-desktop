// Team Ops Command Center — page renderers: FLEET / ENERGY / WORK / CONFIG /
// MAP. Core runtime (router, scheduler, helpers, feed, agent-UI, OPS) is in
// board.js, which loads first and exposes window.Board.
//
// Root-level file on purpose: scripts/sync.sh deletes frontend/js/ but
// preserves root files.
(function () {
  'use strict';
  var Board = window.Board;
  var H = Board.helpers;
  // Energy displays follow the game's unit ladder (H.fmtWatts, input mW).
  var kw = function (mw) { return H.fmtWatts(mw); };
  var alpha = function (ualpha) { return H.fmtNum(ualpha / 1e6); };

  // A compact stat tile: the value (optionally + a sui-icon) over a small
  // uppercase caption. Used in the right-hand section of a fleet row so each
  // number reads with its label instead of a bare icon.
  function statTile(label, value, iconName, cls) {
    var t = H.el('div', 'fstat' + (cls ? ' ' + cls : ''));
    var v = H.el('div', 'fstat-v');
    if (value && value.nodeType) v.appendChild(value);
    else v.appendChild(document.createTextNode(value == null ? '—' : String(value)));
    if (iconName) v.appendChild(H.el('i', H.iconClass(iconName)));
    t.appendChild(v);
    t.appendChild(H.el('div', 'fstat-l', label));
    return t;
  }

  // ═══════════════════════════ FLEET ═══════════════════════════════════════
  var fleet = {
    rows: [],
    refreshedAt: 0,
    sort: { key: 'index', dir: 1 },
    selection: {},          // player_id -> true
    lastSweepPlan: null,    // ambient dry-run result (echoed on execute)
    jobRunning: false,
    built: false,
  };

  function fleetAttention(r) {
    return !!r.err || r.charge >= 24; // read failed, or idle 24+ blocks (~2min+)
  }

  var FLEET_SORT_KEYS = [
    { key: 'index', label: 'index' }, { key: 'name', label: 'name' },
    { key: 'charge', label: 'charge' }, { key: 'alpha', label: 'alpha' },
    { key: 'ore', label: 'ore' }, { key: 'power', label: 'load' },
    { key: 'age', label: 'age' },
  ];
  var FLEET_SORT_ACC = {
    index: function (r) { return r.index == null ? -1 : r.index; },
    name: function (r) { return r.name.toLowerCase(); },
    charge: function (r) { return r.charge; },
    alpha: function (r) { return r.alpha_ualpha; },
    ore: function (r) { return r.ore; },
    power: function (r) { return r.structs_load; },
    age: function (r) { return r.fetched_at_ms; },
  };

  function selCount() { return Object.keys(fleet.selection).length; }

  function buildFleetDom() {
    if (fleet.built) return;
    fleet.built = true;
    var body = document.getElementById('fleet-body');
    body.innerHTML = '';

    // ── Toolbar: mass actions (one-click; ambient dry-run on the buttons) ──
    var actions = H.el('div', 'sui-screen-btn-flex-wrapper'); actions.id = 'fleet-actions';
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
    countIn.style.cssText = 'width:64px;background:transparent;color:inherit;border:1px solid var(--border,#345);padding:2px 6px;';
    var launchRole = H.el('select', 'sui-input-text');
    [['productive', 'productive'], ['bait', 'bait']].forEach(function (o) {
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
        launchBtn.classList.toggle('sui-mod-disabled', !r.power_ok || fleet.jobRunning);
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
      fleet.lv.visible().forEach(function (r) {
        if (r.index == null) return;               // primary is never a target
        if (on) fleet.selection[r.player_id] = true;
        else delete fleet.selection[r.player_id];
      });
      renderFleetRows();
    });
    allLbl.appendChild(allCb);
    allLbl.appendChild(H.el('span', null, 'select all shown'));
    extras.appendChild(allLbl);

    var selInfo = H.el('span', 'ops-muted'); selInfo.id = 'fleet-selinfo';
    extras.appendChild(selInfo);

    var refreshBtn = H.el('a', 'ops-refresh-btn', 'Refresh roster');
    refreshBtn.href = 'javascript:void(0)';
    refreshBtn.addEventListener('click', function () {
      Board.T.core.invoke('mcp_roster_refresh').catch(function () {});
    });
    extras.appendChild(refreshBtn);

    fleet.lv = H.listView({
      key: function (r) { return r.player_id; },
      // Selection and freshness are part of what a row DRAWS, so they belong
      // in the change signature or a toggled checkbox wouldn't repaint.
      sig: function (r) {
        return [r.name, r.role, r.charge, r.alpha_ualpha, r.ore, r.planet_ore,
          r.mine_eta_s, r.refine_eta_s, r.err, r.pfp_attrs,
          fleet.selection[r.player_id] ? 1 : 0].join('|');
      },
      render: fleetRow,
      pageSize: 60,
      filters: [
        { key: 'q', type: 'text', placeholder: 'filter name / id / planet' },
        { key: 'role', type: 'select', options: [
          { value: '', label: 'all roles' }, 'productive', 'bait', 'raider', 'primary' ] },
        { key: 'attn', type: 'toggle', label: 'attention' },
      ],
      filterFn: function (r, v) {
        if (v.role && r.role !== v.role) return false;
        if (v.attn && !fleetAttention(r)) return false;
        if (v.q) {
          var hay = (r.name + ' ' + r.player_id + ' ' + (r.planet_id || '')).toLowerCase();
          if (hay.indexOf(String(v.q).toLowerCase()) < 0) return false;
        }
        return true;
      },
      sortKeys: FLEET_SORT_KEYS,
      sortAccessors: FLEET_SORT_ACC,
      sort: fleet.sort,
      toolbarExtra: extras,
      empty: 'no players match these filters',
      onCounts: function () { updateFleetChrome(); },
    });
    body.appendChild(fleet.lv.node);
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
  function fmtEta(s) {
    if (s == null) return null;
    if (s <= 0) return 'now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1).replace(/\.0$/, '') + 'h';
    return Math.round(s / 86400) + 'd';
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
      parts.push(piece('icon-undiscovered-ore', H.fmtNum(r.planet_ore), 'ore left on planet'));
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
  function renderFleetRows() {
    if (!fleet.lv) return;
    fleet.lv.setRows(fleet.rows);
  }

  // One roster row. Pure: given a row it returns a node, so listView can cache
  // and reuse it until that row's data (or its selected state) changes.
  function fleetRow(r) {
    return (function () {
      // Checkbox (vplayers only; primary is never a mass-action target).
      var lead = null;
      if (r.index != null) {
        lead = H.checkbox(!!fleet.selection[r.player_id], null, function (on) {
          if (on) fleet.selection[r.player_id] = true;
          else delete fleet.selection[r.player_id];
          updateFleetChrome();
        });
      }
      // Title: name + role badge (the avatar frame already signals role, the
      // badge names it in words).
      var title = H.el('span', r.err ? 'err' : null, r.name + ' ');
      title.appendChild(H.badge(r.role === 'productive' ? 'PROD' : r.role === 'primary' ? 'PRIME' : 'BAIT',
        r.role === 'productive' ? 'solid' : r.role === 'primary' ? 'warning' : 'default'));
      // Subtitle: PID (the native roster's identity line). Freshness is shown
      // only when a row needs attention, so the common case stays clean; the
      // rest (index, planet, last action) lives in the click-through detail.
      var sub = H.el('span');
      sub.appendChild(document.createTextNode('PID #' + r.player_id));
      if (fleetAttention(r)) {
        sub.appendChild(document.createTextNode(' · '));
        sub.appendChild(H.el('span', 'attn', r.err ? 'read failed' : 'idle ' + H.ago(r.fetched_at_ms)));
      }
      // Harvest trio — icons only, no words (tooltips explain): ore left on
      // the planet · time to next mine completion · time to next refine.
      var trio = harvestTrio(r);
      if (trio) { sub.appendChild(H.el('br')); sub.appendChild(trio); }
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
          statTile('Ore', H.fmtNum(r.ore), 'sui-icon-alpha-ore'),
        ],
      });
      row.addEventListener('click', function () { showDetail(r); });
      row.style.cursor = 'pointer';
      return row;
    })();
  }

  function updateFleetChrome() {
    var info = document.getElementById('fleet-selinfo');
    if (info) {
      info.innerHTML = '';
      if (selCount()) {
        info.appendChild(document.createTextNode(selCount() + ' selected · '));
        var clr = H.el('a', 'ops-refresh-btn', 'clear');
        clr.href = 'javascript:void(0)';
        clr.addEventListener('click', function () { fleet.selection = {}; renderFleetRows(); });
        info.appendChild(clr);
      } else {
        info.textContent = 'roster ' + (fleet.refreshedAt ? H.ago(fleet.refreshedAt) + ' old' : 'loading…');
      }
    }
    var roleBtn = document.getElementById('role-btn');
    if (roleBtn) H.busy(roleBtn, selCount() === 0 || fleet.jobRunning);
    ambientSweepPreview();
  }

  // Ambient dry-run: the sweep button always shows exactly what a click does.
  var sweepPreviewTimer = null;
  function ambientSweepPreview() {
    clearTimeout(sweepPreviewTimer);
    sweepPreviewTimer = setTimeout(function () {
      var sel = Object.keys(fleet.selection);
      Board.T.core.invoke('mcp_mass_action', { request: {
        action: 'sweep_alpha', mode: 'dry_run',
        players: sel.length ? sel : null,
        args: {},
      }}).then(function (r) {
        fleet.lastSweepPlan = r;
        var btn = document.getElementById('sweep-btn');
        if (!btn) return;
        // Compact: the ambient dry-run detail (who/how many) lives in the plan
        // echo; the button just needs the action + total so it fits one line.
        var label = sel.length
          ? 'Sweep ' + r.entries.length + ' ~' + H.fmtNum(r.total_alpha) + 'α'
          : 'Sweep all ~' + H.fmtNum(r.total_alpha) + 'α';
        btn.lastChild.textContent = ' ' + label;
        btn.classList.toggle('sui-mod-disabled', r.entries.length === 0 || fleet.jobRunning);
      }).catch(function () {});
    }, 300);
  }

  function setJobRunning(on) {
    fleet.jobRunning = on;
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
    var plan = fleet.lastSweepPlan;
    if (!plan || !plan.entries || !plan.entries.length) return;
    var sel = Object.keys(fleet.selection);
    runMass({
      action: 'sweep_alpha', mode: 'execute',
      players: sel.length ? sel : null,
      args: {},
      plan: plan.entries,
    }, 'Sweeping ' + plan.entries.length + ' player(s)…').catch(function () {});
  }

  function runSetRole(role) {
    var sel = Object.keys(fleet.selection);
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
      if (r.planet_id) {
        var mapLink = H.el('a', 'ops-refresh-btn', 'View map →');
        mapLink.href = '#/map?p=' + encodeURIComponent(r.player_id);
        mapLink.style.cssText = 'display:inline-block;margin-top:10px;';
        mapLink.addEventListener('click', function () { close(); });
        content.appendChild(mapLink);
      }
    }).catch(function (e) {
      content.innerHTML = '';
      content.appendChild(H.el('div', 'err', 'detail failed: ' + e));
    });
  }

  function loadRoster(kickIfOlderMs) {
    return Board.T.core.invoke('mcp_roster', { refreshIfOlderMs: kickIfOlderMs == null ? 120000 : kickIfOlderMs })
      .then(function (snap) {
        fleet.rows = snap.rows || [];
        fleet.refreshedAt = snap.refreshed_at_ms || 0;
        buildFleetDom();
        renderFleetRows();
      }).catch(function () {});
  }

  Board.registerPage('fleet', {
    onBoot: function () {
      var T = Board.T;
      T.event.listen('board-roster-progress', function (e) {
        var p = e && e.payload;
        if (p && Board.current === 'fleet') showProgress('roster sweep ' + p.done + '/' + p.total, p.done / p.total);
      });
      T.event.listen('board-roster-updated', function () {
        if (Board.current === 'fleet') { loadRoster(null); hideProgressSoon(); }
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
  // Compact kW: 2 decimals for small draws (5.67), whole numbers for big ones
  // (1062) so a "load / capacity kW" chip never needs two lines.
  function kwv(mw) { var v = mw / 1e6; return v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2); }
  var energyState = { data: null, sort: { key: 'margin', dir: 1 } };
  var ENERGY_KEYS = [{ key: 'margin', label: 'margin' }, { key: 'name', label: 'name' },
    { key: 'load', label: 'load' }, { key: 'capacity', label: 'capacity' }];
  var ENERGY_ACC = {
    margin: function (p) { return p.margin_pct; }, name: function (p) { return p.name.toLowerCase(); },
    load: function (p) { return p.load_mw; }, capacity: function (p) { return p.capacity_mw; },
  };
  function renderEnergyBody() {
    var d = energyState.data; if (!d) return;
    var body = document.getElementById('energy-body');
    body.innerHTML = '';
    var g = d.guild;
    var gbody = H.el('div');
    gbody.appendChild(H.row('Reactor fuel', kw(g.reactor_fuel_mw) + '  (' + Math.round(g.reactor_commission * 100) + '% commission)', 'sui-icon-energy'));
    gbody.appendChild(H.row('Substation capacity', kw(g.sub_capacity_mw) + ' · ' + g.sub_connection_count + ' connections'));
    gbody.appendChild(H.row('Per-connection', kw(g.sub_connection_capacity_mw) + '  (→ ' + kw(g.share_if_one_more_mw) + ' with 1 more)'));
    gbody.appendChild(H.row('Substation load', kw(g.sub_load_mw)));
    gbody.appendChild(H.row('Growth headroom', '~' + g.supportable_more + ' more players',
      g.supportable_more > 0 ? 'icon-success' : 'icon-alert'));
    body.appendChild(H.card('GUILD POWER', gbody));

    var pbody = H.el('div');
    var bar = H.el('div'); bar.style.cssText = 'margin-bottom:6px;';
    bar.appendChild(H.sortControl(ENERGY_KEYS, energyState.sort, renderEnergyBody));
    pbody.appendChild(bar);
    var table = H.resultTable();
    H.sortBy((d.players || []), energyState.sort, ENERGY_ACC).slice(0, 80).forEach(function (p) {
      table.appendChild(H.resultRow({
        icon: p.ok ? 'sui-icon-energy' : 'sui-icon-no-power',
        title: p.err ? H.el('span', 'err', p.name) : p.name,
        subtitle: p.role,
        chips: [
          H.resource(H.fmtWatts(p.load_mw) + ' / ' + H.fmtWatts(p.capacity_mw), 'sui-icon-energy'),
          H.resource(Math.round(p.margin_pct) + '%', null, p.margin_pct < 15 ? 'attn' : ''),
        ],
      }));
    });
    pbody.appendChild(table);
    pbody.appendChild(H.el('div', 'ops-muted', 'roster ' + H.ago(d.roster_refreshed_at_ms) + ' old'));
    body.appendChild(H.card('PLAYER MARGINS', pbody));
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }
  function renderEnergy() {
    return Board.T.core.invoke('mcp_energy').then(function (d) {
      energyState.data = d; renderEnergyBody();
    }).catch(function (e) {
      var body = document.getElementById('energy-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('energy unavailable: ' + e, 'icon-alert'));
    });
  }
  Board.registerPage('energy', { refresh: renderEnergy, cadenceMs: 30000, onEnter: renderEnergy });

  // ═══════════════════════════ WORK ═════════════════════════════════════════
  var workState = { data: null, sort: { key: 'progress', dir: -1 }, built: false, lv: null };
  var WORK_KEYS = [{ key: 'progress', label: 'progress' }, { key: 'difficulty', label: 'difficulty' },
    { key: 'status', label: 'status' }, { key: 'type', label: 'type' }, { key: 'task', label: 'task id' }];
  var WORK_ACC = {
    progress: function (t) { return t.percent_complete || 0; },
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
        var diff = (t.current_difficulty != null ? t.current_difficulty : '—') +
          '→' + (t.difficulty_target != null ? t.difficulty_target : '—');
        return H.resultRow({
          icon: typeIcon[t.task_type] || 'icon-in-progress',
          title: t.task_id || '?',
          subtitle: (t.task_type || '?') + ' · ' + (t.status || '?'),
          chips: [
            H.resource(H.progressBar((t.percent_complete || 0) / 100)),
            H.resource(diff),
            H.resource(t.eta || '—', null, 'ops-muted'),
          ],
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
    body.appendChild(H.card('TASKS', workState.lv.node));

    var lbody = H.el('div'); lbody.id = 'work-loops';
    workState.loopCard = H.card('LOOP HEALTH (1h)', lbody);
    body.appendChild(workState.loopCard);

    var xbody = H.el('div'); xbody.id = 'work-tx';
    workState.txCard = H.card('TOP TX ERRORS (1h)', xbody);
    body.appendChild(workState.txCard);
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
    qbody.appendChild(H.row('difficulty_start / max_concurrent', hc.difficulty_start + ' / ' + hc.max_concurrent +
      (hc.auto_tune ? ' · auto-tune ON' : '')));

    workState.lv.setRows(d.tasks || []);

    var lh = d.loop_health || [];
    var lbody = document.getElementById('work-loops');
    lbody.innerHTML = '';
    lh.forEach(function (l) {
      var line = l.runs + ' runs · ' + (l.actions || 0) + ' actions · ' + (l.errors || 0) + ' errors';
      lbody.appendChild(H.row(l.loop, line, (l.errors || 0) > 0 ? 'icon-alert' : 'icon-success'));
    });
    workState.loopCard.hidden = !lh.length;

    var tx = d.tx_summary || {};
    var errs = (tx.top_errors || []).slice(0, 5);
    var xbody = document.getElementById('work-tx');
    xbody.innerHTML = '';
    errs.forEach(function (e2) {
      xbody.appendChild(H.row(String(e2.count) + '×', e2.reason.slice(0, 90), 'icon-alert'));
    });
    workState.txCard.hidden = !errs.length;
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
        left.appendChild(H.badge(h.outcome.replace('_', ' ').toUpperCase(),
          ok ? 'solid' : h.outcome === 'skipped' ? 'default' : 'warning'));
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
  var grassState = { rows: [], paused: false, cat: '', text: '', cats: [], built: false, renderQueued: false, lookups: {} };
  var GRASS_MAX = 200;

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
  var ENERGY_ATTRS = { capacity: 1, load: 1, structsLoad: 1, power: 1, connectionCapacity: 1 };
  var HEIGHT_KEY = /^(height|block|block_height|last_action)$|^block_|_block$/;

  function lookupName(kind, id) {
    var m = grassState.lookups && grassState.lookups[kind];
    var n = m && m[id];
    return n ? id + ' (' + n + ')' : id;
  }

  // Format ONE detail value. `variant` picks the precise twin: 'new' prefers
  // det[key+'_p'], 'old' prefers det[key+'_old_p'] (falling back to the
  // legacy-scaled field). Returns a display string, or null to suppress.
  function grassVal(ev, det, key, raw, variant) {
    if (GRASS_SUPPRESS[key]) return null;
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
      if (HEIGHT_KEY.test(attr) || attr === 'lastAction') return H.fmtInt(raw);
    }
    // Direct energy keys on non-grid events (rare but generic).
    if (ENERGY_ATTRS[key]) return H.fmtWatts(precise != null ? Number(precise) : Number(raw) * 1000);
    // Alpha inventory amounts (subject structs.inventory.ualpha.…) are raw ualpha.
    if (key === 'amount' && String(ev.subject || '').indexOf('structs.inventory.ualpha') === 0) {
      return H.fmtAlpha(Number(raw));
    }
    if (key === 'seized_ore' || key === 'ore') return H.fmtOre(Number(raw));
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

  function grassChipNode(label, text) {
    var c = H.el('span', 'grass-chip');
    c.appendChild(H.el('b', null, label + ': '));
    c.appendChild(document.createTextNode(text));
    return c;
  }

  // The one algorithm: time · colored category badge · compact subject ·
  // detail flattened to k:v chips, with `x`+`x_old` pairs folded to old→new
  // and `_p` twins used for precision but never rendered separately.
  function grassRow(ev) {
    var li = H.el('li');
    // timestamp is local receive-time (the stream carries none on the wire)
    li.appendChild(H.el('span', 'feed-ts', new Date(ev.timestamp).toLocaleTimeString()));
    var badge = H.el('span', 'grass-badge', ev.category);
    var hue = grassHue(ev.category);
    badge.style.color = 'hsl(' + hue + ',60%,60%)';
    badge.style.borderColor = 'hsl(' + hue + ',60%,40%)';
    li.appendChild(badge);
    li.appendChild(H.el('span', 'grass-subj', String(ev.subject || '').replace(/^structs\./, '')));
    var det = ev.detail;
    if (det == null || typeof det !== 'object') {
      if (det != null && det !== '') li.appendChild(grassChipNode('value', String(det)));
      return li;
    }
    var keys = Object.keys(det);
    var keySet = {};
    keys.forEach(function (k) { keySet[k] = true; });
    keys.forEach(function (k) {
      var v = det[k];
      if (v == null || v === '') return;
      if (/_p$/.test(k)) return; // precision twin — consumed by its base key
      if (/_old$/.test(k) && keySet[k.replace(/_old$/, '')] && det[k.replace(/_old$/, '')] != null) {
        return; // folded into the new-value chip below
      }
      var text = grassVal(ev, det, k, v, 'new');
      if (text == null) return;
      if (keySet[k + '_old'] && det[k + '_old'] != null) {
        // Old value formats by the BASE key's semantics; variant 'old' makes
        // the precise lookup use k+'_old_p'.
        var oldText = grassVal(ev, det, k, det[k + '_old'], 'old');
        li.appendChild(grassChipNode(k, (oldText == null ? String(det[k + '_old']) : oldText) + ' → ' + text));
        return;
      }
      li.appendChild(grassChipNode(k, text));
    });
    return li;
  }

  function grassMatches(ev) {
    if (grassState.cat && ev.category !== grassState.cat) return false;
    if (grassState.text) {
      var hay = (ev.category + ' ' + ev.subject + ' ' + JSON.stringify(ev.detail || '')).toLowerCase();
      if (hay.indexOf(grassState.text.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function renderGrassList() {
    var list = document.getElementById('grass-list');
    if (!list) return;
    list.innerHTML = '';
    var shown = 0;
    for (var i = 0; i < grassState.rows.length; i++) {
      var ev = grassState.rows[i];
      if (!grassMatches(ev)) continue;
      list.appendChild(grassRow(ev));
      shown++;
    }
    if (!shown) {
      var empty = H.el('li', 'ops-muted', grassState.rows.length
        ? 'no events match the filter'
        : 'no events yet — they appear as the game plays');
      list.appendChild(empty);
    }
    var count = document.getElementById('grass-count');
    if (count) count.textContent = shown + ' / ' + grassState.rows.length;
  }

  // Debounced render: live events always BUFFER (cheap array ops); the DOM is
  // only touched when the grass tab is showing and not paused.
  function queueGrassRender() {
    if (Board.current !== 'grass' || grassState.paused || grassState.renderQueued) return;
    grassState.renderQueued = true;
    setTimeout(function () {
      grassState.renderQueued = false;
      renderGrassList();
    }, 250);
  }

  function buildGrassToolbar() {
    var bar = document.getElementById('grass-toolbar');
    if (!bar || grassState.built) return;
    grassState.built = true;
    var catSel = H.el('select', 'sui-input-text'); catSel.id = 'grass-cat';
    catSel.addEventListener('change', function () { grassState.cat = catSel.value; renderGrassList(); });
    bar.appendChild(catSel);
    var search = H.el('input', 'sui-input-text'); search.placeholder = 'filter…';
    search.addEventListener('input', function () { grassState.text = search.value; renderGrassList(); });
    bar.appendChild(search);
    var pause = H.el('a', 'ops-refresh-btn'); pause.href = 'javascript:void(0)'; pause.id = 'grass-pause';
    pause.textContent = 'Pause';
    pause.addEventListener('click', function () {
      grassState.paused = !grassState.paused;
      pause.textContent = grassState.paused ? 'Resume' : 'Pause';
      if (!grassState.paused) renderGrassList();
    });
    bar.appendChild(pause);
    bar.appendChild(H.el('span', 'ops-muted')).id = 'grass-count';
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
    grassBackfill().then(renderGrassList);
    renderGrassList();
    return Promise.resolve();
  }

  Board.registerPage('grass', {
    onBoot: function () {
      // Back-fill from the Rust ring buffer, then tail the live relay. The
      // listener lives for the window's lifetime and buffers even while other
      // tabs are showing, so switching to Grass is instant.
      grassBackfill().then(renderGrassList);
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
        queueGrassRender();
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
  var warState = { data: null, sort: { key: 'score', dir: -1 } };
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
  function warLoopSet(which, cfg, extra) {
    var payload = { loop: which, config: cfg };
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    return Board.T.core.invoke('mcp_config_set', { domain: 'loop', payload: payload })
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
  // One field of a loop config, using the game's own form controls. Each writes
  // the whole config back through the same setter the agent and the Config page
  // use, so there is a single write path however you got here.
  function warField(label, cfg, key, which, control, extra, hint) {
    function write(v) {
      var next = JSON.parse(JSON.stringify(cfg));
      next[key] = v;
      warLoopSet(which, next, extra);
    }
    return H.field(label, control(cfg[key], write), hint);
  }
  function numField(label, cfg, key, which, opts) {
    return warField(label, cfg, key, which, function (v, write) {
      return H.stepper(v, {
        min: opts && opts.min, max: opts && opts.max,
        step: opts && opts.step, width: '3.5em',
      }, write);
    });
  }
  function boolField(label, cfg, key, which) {
    return warField(label, cfg, key, which, function (v, write) {
      return H.checkbox(v, null, write);
    });
  }
  function selectField(label, cfg, key, which, options, extra, hint) {
    return warField(label, cfg, key, which, function (v, write) {
      return H.selectBox(v, options, write);
    }, extra, hint);
  }

  function renderWarBody() {
    var d = warState.data; if (!d) return;
    var body = document.getElementById('war-body');
    body.innerHTML = '';
    var lists = d.lists || {};
    var resp = d.response || {};
    var raid = d.raid || {};

    // ── Posture strip: what the two loops are allowed to do right now. ──
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
    var tbody = H.el('div');
    var targets = d.targets || [];
    if (!targets.length) {
      tbody.appendChild(H.alertLine(
        raid.enabled
          ? 'No candidates scored yet — the loop sweeps a bounded batch each scan. Use Scan now → raid on the Fleet page to force one.'
          : 'Raid targeting is off. Enable it below to start scoring targets (it starts in advise mode and signs nothing).',
        'icon-info'));
    } else {
      var tbar = H.el('div'); tbar.style.cssText = 'margin-bottom:6px;';
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
          chips: [
            H.resource(Math.round(t.stored_ore), 'sui-icon-alpha-ore', t.stored_ore >= (raid.min_ore || 0) ? '' : 'attn'),
            H.resource(t.planetary_shield + ' → ~' + Math.round(t.raid_minutes) + 'm', 'icon-planetary-shield'),
            H.resource(t.defenders_on_cmd, 'icon-defend'),
            H.resource(Math.round(t.score), null, go ? '' : 'attn'),
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

    // ── Grudges. Auto-written by auto_response; hand-editable here. ──
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
    gbody.appendChild(H.el('div', 'ops-muted',
      'Weight multiplies how far a target climbs the raid board. Heat blends it with the harm actually done.'));
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
      qbody.appendChild(H.el('div', 'ops-muted', 'No prioritised guilds — every member of one listed here gains its weight as a target.'));
    }
    qbody.appendChild(addRow('guild id (e.g. 0-2)', function (id, w) {
      warSet({ action: 'add', kind: 'priority_guild', id: id, weight: w == null ? 1 : w });
    }));
    body.appendChild(H.card('PRIORITY GUILDS', qbody));

    var abody = H.el('div');
    abody.appendChild(H.el('div', 'ops-muted',
      'A hard veto in BOTH loops, checked before anything is scored — the chain does not stop you attacking guild-mates, so this does.'));
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
    body.appendChild(H.card('NEVER ATTACK', abody));

    // ── What the response loop actually did. ──
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

    // ── Editable settings for both loops (the CONFIG page only shows toggles). ──
    var rbody = H.el('div');
    rbody.appendChild(boolField('enabled', resp, 'enabled', 'response'));
    rbody.appendChild(selectField('autonomy', resp, 'autonomy', 'response', ['advise', 'auto']));
    rbody.appendChild(selectField('mode', resp, 'mode', 'response', d.modes || ['harden', 'counter', 'decapitate']));
    rbody.appendChild(numField('scan every (s)', resp, 'interval_secs', 'response', { min: 5 }));
    rbody.appendChild(numField('max shots / incident', resp, 'max_shots_per_incident', 'response', { min: 0 }));
    rbody.appendChild(numField('max shots / hour', resp, 'max_shots_per_hour', 'response', { min: 0 }));
    rbody.appendChild(numField('incident cooldown (s)', resp, 'incident_cooldown_secs', 'response', { min: 0 }));
    rbody.appendChild(boolField('prefer a counter-free ambit (free shots)', resp, 'prefer_counter_free_ambit', 'response'));
    rbody.appendChild(boolField('panic-refine the threatened ore', resp, 'panic_refine', 'response'));
    rbody.appendChild(boolField('let the primary shoot too', resp, 'include_primary_shooters', 'response'));
    // Raider safety lives in TARGETING GATES (recall below CMD HP) — auto_raid
    // supervises the expedition, so it is the loop that can actually pull it out.
    rbody.appendChild(boolField('dry run', resp, 'dry_run', 'response'));
    rbody.appendChild(H.el('div', 'ops-muted',
      'A raid resolves in about four minutes, and every recorded defensive win fired back inside the first two — hence the short scan interval.'));
    body.appendChild(H.card('RESPONSE SETTINGS', rbody));

    var kbody = H.el('div');
    kbody.appendChild(boolField('enabled', raid, 'enabled', 'raid'));
    kbody.appendChild(selectField('autonomy', raid, 'autonomy', 'raid', ['advise', 'auto']));
    // A posture change rewrites every gate below it, so it is sent with the
    // apply_posture flag rather than merged into whatever the form last showed.
    kbody.appendChild(selectField('posture (resets the gates)', raid, 'posture', 'raid',
      d.postures || ['cautious', 'opportunist', 'aggressive'], { apply_posture: true }));
    kbody.appendChild(numField('min ore (the whole prize)', raid, 'min_ore', 'raid', { min: 0, step: 1 }));
    kbody.appendChild(numField('min score (0-100)', raid, 'min_score', 'raid', { min: 0, step: 1 }));
    kbody.appendChild(numField('max raid proof (min)', raid, 'max_raid_minutes', 'raid', { min: 1 }));
    kbody.appendChild(numField('max defenders on their CMD', raid, 'max_defenders', 'raid', { min: 0 }));
    kbody.appendChild(numField('skip if defender acted within (min)', raid, 'skip_if_defender_active_mins', 'raid', { min: 0 }));
    kbody.appendChild(numField('target cooldown (min)', raid, 'target_cooldown_mins', 'raid', { min: 0 }));
    kbody.appendChild(numField('max concurrent raids', raid, 'max_concurrent_raids', 'raid', { min: 1 }));
    kbody.appendChild(numField('recall raider below CMD HP', raid, 'abort_cmd_hp_below', 'raid', { min: 0 }));
    kbody.appendChild(boolField('only raid already-vulnerable targets', raid, 'require_vulnerable_now', 'raid'));
    kbody.appendChild(boolField('allow siege (kill their CMD to open the window)', raid, 'allow_siege', 'raid'));
    kbody.appendChild(boolField('dry run', raid, 'dry_run', 'raid'));
    kbody.appendChild(H.el('div', 'ops-muted',
      'Of every raid on record, none that started against a non-vulnerable planet ever completed — and going anyway drops your own shields for the trip.'));
    body.appendChild(H.card('TARGETING GATES', kbody));

    var wbody = H.el('div');
    wbody.appendChild(H.el('div', 'ops-muted',
      'How the 0-100 score is blended. Raising one weight lifts targets that are strong on it; the scale stays 0-100 either way, so min_score keeps meaning the same thing.'));
    [['w_ore', 'ore held (the prize)'], ['w_vulnerability', 'vulnerable right now'],
     ['w_weakness', 'weak defences'], ['w_grudge', 'grudge heat'],
     ['w_guild', 'priority guild'], ['w_speed', 'fast raid proof'],
     ['w_history', 'our record vs this planet']].forEach(function (p) {
      wbody.appendChild(numField(p[1], raid, p[0], 'raid', { min: 0, step: 0.1 }));
    });
    body.appendChild(H.card('SCORING WEIGHTS', wbody));

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
  Board.registerPage('war', { onEnter: renderWar, refresh: renderWar, cadenceMs: 20000 });

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
    if (part !== 'background') {
      var bgIdx = layerVal(cfg, 'background', APPEAR_SAMPLES[0], appear.counts.background);
      var bg = H.el('img', 'pfp-viewer-layer'); bg.src = 'img/pfp/background/pfp_background_' + bgIdx + '.png'; box.appendChild(bg);
    }
    var im = H.el('img', 'pfp-viewer-layer'); im.src = 'img/pfp/' + part + '/pfp_' + part + '_' + idx + '.png'; box.appendChild(im);
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
      var intro = H.el('div', 'ops-muted');
      intro.textContent = 'Style each squad. Fixed layers pin the look; randomized layers give every player a unique one. Apply restyles everyone in the role.';
      host.appendChild(intro);
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
  // `short` is the row subtitle and must stay one line on a narrow board
  // window; `blurb` is the full sentence, shown once the editor is open.
  var LOOP_META = {
    harvest: {
      label: 'auto_harvest', icon: 'icon-mine', short: 'mine + refine when the proof is cheap',
      blurb: 'Mines and refines every owned struct once its proof has decayed enough to be cheap.',
      chips: [{ key: 'difficulty_threshold', label: 'difficulty' }],
    },
    build: {
      label: 'auto_build', icon: 'icon-deploy', short: 'fill free slots with the defensive loadout',
      blurb: 'Fills each player’s free slots with the defensive loadout, one charge-paced build per scan.',
      chips: [{ key: 'complete_difficulty', label: 'difficulty' }],
    },
    defend: {
      label: 'auto_defend', icon: 'icon-defend', short: 'guard the Command Ship, then production',
      blurb: 'Assigns idle combat structs to guard the Command Ship first, then production.',
      chips: [],
    },
    infuse: {
      label: 'auto_infuse', icon: 'icon-send-alpha', short: 'infuse spare Alpha into the reactor',
      blurb: 'Keeps a reserve of Alpha and infuses the rest into the guild reactor.',
      chips: [{ key: 'keep_grams', label: 'reserve', icon: 'sui-icon-alpha-matter' }],
    },
    response: {
      label: 'auto_response', icon: 'icon-counter', short: 'answer a raid inside its 2-minute window',
      blurb: 'Answers a raid alarm inside the two-minute window — identifies the attacker and fires back.',
      chips: [{ key: 'mode', label: 'response' }], war: true,
    },
    raid: {
      label: 'auto_raid', icon: 'icon-raid', short: 'score targets, fly expendable raiders',
      blurb: 'Scores every reachable player as a raid target and flies expendable raiders at the best one.',
      chips: [{ key: 'posture', label: 'posture' }, { key: 'min_ore', label: 'min ore', icon: 'sui-icon-alpha-ore' }], war: true,
    },
  };

  // Per-field presentation. Anything not listed still renders — the type of the
  // value decides the control — so a new knob on the Rust side needs no UI work.
  var FIELD_META = {
    autonomy: { label: 'autonomy', options: ['advise', 'auto'], hint: 'advise proposes; auto signs' },
    mode: { label: 'response mode', options: ['harden', 'counter', 'decapitate'] },
    posture: { label: 'posture', options: ['cautious', 'opportunist', 'aggressive'], hint: 'resets the gates below' },
    interval_secs: { label: 'scan every (s)', min: 5 },
    difficulty_threshold: { label: 'harvest at difficulty ≤', min: 1, max: 64 },
    complete_difficulty: { label: 'complete at difficulty ≤', min: 1, max: 64 },
    keep_grams: { label: 'Alpha reserve (g)', min: 0 },
    min_ore: { label: 'min ore (the whole prize)', min: 0 },
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

  // A loop's cadence. NOT fmtEta: that one floors everything under a minute to
  // "1m", which would hide the whole point of auto_response's 20-second scan.
  function fmtCadence(s) {
    if (s == null) return '—';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1).replace(/\.0$/, '') + 'h';
  }

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
  function loopEditor(which, cfg) {
    var host = H.el('div');
    var meta = LOOP_META[which] || { label: which };
    var draft = JSON.parse(JSON.stringify(cfg));
    function commit(extra) {
      return Board.T.core.invoke('mcp_config_set', {
        domain: 'loop',
        payload: Object.assign({ loop: which, config: draft }, extra || {}),
      }).then(function () { return renderConfig(); })
        .catch(function (e) { alertInto('config-body', 'write failed: ' + e); });
    }

    if (meta.blurb) host.appendChild(H.el('div', 'ops-muted', meta.blurb));
    if (meta.war) {
      host.appendChild(H.alertLine(
        'Grudges, the never-attack list and the live target board live on the War tab.', 'icon-raid'));
    }

    Object.keys(draft).sort(function (a, b) {
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
  var CONFIG_SECTIONS = [
    { key: 'doctrine', label: 'Doctrine' },
    { key: 'loops', label: 'Loops' },
    { key: 'policies', label: 'Policies' },
    { key: 'engine', label: 'Engine' },
    { key: 'access', label: 'Access' },
    { key: 'appearance', label: 'Squads' },
  ];
  var configState = { section: 'doctrine', data: null };

  function sectionDoctrine(d, body) {
    var doc = d.doctrine || {};
    var dbody = H.el('div');
    dbody.appendChild(H.row('Posture / Autonomy', (doc.posture || '?') + ' / ' + (doc.autonomy || '?')));
    if (doc.pinned_target) dbody.appendChild(H.row('Pinned target', doc.pinned_target));
    dbody.appendChild(H.el('div', 'ops-muted',
      'A preset configures a coherent bundle of loops and policies in one move. Later edits to any single knob stick.'));
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
      var chips = (meta.chips || []).map(function (c) {
        return statTile(c.label, String(cfg[c.key]), c.icon || null);
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
        subtitle: meta.short || meta.blurb,
        chips: chips,
        action: H.el('i', 'icon-chevron-right row-chevron'),
        onClick: function () { H.detailModal(meta.label, loopEditor(name, cfg)); },
      }));
    });
    lbody.appendChild(table);
    lbody.appendChild(H.el('div', 'ops-muted',
      'Every loop is off until you switch it on. Select a row to open its full settings.'));
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
    pbody.appendChild(H.el('div', 'ops-muted',
      'Policies are single rules the engine evaluates each sync. Loops do the repeated work; policies react to one event.'));
    body.appendChild(H.card('POLICIES', pbody));
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
      var urow = H.el('div', 'cfg-row');
      var ulink = H.el('a', 'ops-refresh-btn cfg-url', wb.url);
      ulink.href = 'javascript:void(0)';
      ulink.title = 'Copy URL — anyone holding it has FULL operator control';
      ulink.addEventListener('click', function () {
        try { navigator.clipboard.writeText(wb.url); } catch (e) {}
        ulink.textContent = 'Copied!';
        setTimeout(function () { ulink.textContent = wb.url; }, 1000);
      });
      urow.appendChild(ulink);
      wbody.appendChild(urow);
      wbody.appendChild(H.el('div', 'ops-muted',
        'Token grants full control — treat like a password. Server binds 127.0.0.1; remote players connect through your tunnel (SSH/Tailscale).'));
    } else {
      wbody.appendChild(H.el('div', 'ops-muted',
        'Off by default. When enabled, this exact dashboard is served at /board on the MCP port, authenticated by the bearer token.'));
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

  function renderConfigBody() {
    var d = configState.data; if (!d) return;
    var body = document.getElementById('config-body');
    body.innerHTML = '';
    body.appendChild(H.navStrip(CONFIG_SECTIONS, configState.section, function (k) {
      configState.section = k;
      renderConfigBody();
    }));
    switch (configState.section) {
      case 'loops': sectionLoops(d, body); break;
      case 'policies': sectionPolicies(d, body); break;
      case 'engine': sectionEngine(d, body); break;
      case 'access': sectionAccess(d, body); break;
      case 'appearance': renderRoleAppearance(body); break;
      default: sectionDoctrine(d, body); break;
    }
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }
  Board.registerPage('config', { onEnter: renderConfig, refresh: renderConfig, cadenceMs: 60000 });

  // ═══════════════════════════ MAP ══════════════════════════════════════════
  Board.registerPage('map', {
    onBoot: function () {
      var T = Board.T;
      var sel = document.getElementById('vp-select');
      var box = document.getElementById('vp-map');
      T.core.invoke('mcp_vplayer_list').then(function (list) {
        (list || []).forEach(function (p) {
          if (!p.player_id) return;
          var o = document.createElement('option');
          o.value = p.player_id;
          o.textContent = p.name + ' (' + p.player_id + ')';
          sel.appendChild(o);
        });
      }).catch(function () {});
      function renderMap(v) {
        if (!v) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="ops-muted">rendering map…</div>';
        T.core.invoke('mcp_render_map', { player: v }).then(function (durl) {
          var img = new Image();
          img.alt = 'map';
          img.onload = function () { box.innerHTML = ''; box.appendChild(img); };
          img.onerror = function () { box.innerHTML = '<div class="err">image failed to load</div>'; };
          img.src = durl;
        }).catch(function (err) {
          box.innerHTML = '<div class="err">render failed: ' + H.esc(err) + '</div>';
        });
      }
      sel.addEventListener('change', function () { renderMap(sel.value); });
      Board.mapShow = function (playerId) {
        sel.value = playerId;
        renderMap(playerId);
      };
    },
    onEnter: function (params) {
      if (params && params.p && Board.mapShow) Board.mapShow(params.p);
    },
  });
})();
