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
    filterText: '',
    filterRole: '',
    filterAttn: false,
    selection: {},          // player_id -> true
    lastSweepPlan: null,    // ambient dry-run result (echoed on execute)
    jobRunning: false,
    built: false,
  };

  function fleetAttention(r) {
    return !!r.err || r.charge >= 24; // read failed, or idle 24+ blocks (~2min+)
  }

  function fleetFiltered() {
    var t = fleet.filterText.toLowerCase();
    return fleet.rows.filter(function (r) {
      if (fleet.filterRole && r.role !== fleet.filterRole) return false;
      if (fleet.filterAttn && !fleetAttention(r)) return false;
      if (t) {
        var hay = (r.name + ' ' + r.player_id + ' ' + (r.planet_id || '')).toLowerCase();
        if (hay.indexOf(t) < 0) return false;
      }
      return true;
    });
  }

  var FLEET_SORT_KEYS = [
    { key: 'index', label: 'index' }, { key: 'name', label: 'name' },
    { key: 'charge', label: 'charge' }, { key: 'alpha', label: 'alpha' },
    { key: 'ore', label: 'ore' }, { key: 'power', label: 'load' },
    { key: 'age', label: 'age' },
  ];
  var FLEET_ACC = {
    index: function (r) { return r.index == null ? -1 : r.index; },
    name: function (r) { return r.name.toLowerCase(); },
    charge: function (r) { return r.charge; },
    alpha: function (r) { return r.alpha_ualpha; },
    ore: function (r) { return r.ore; },
    power: function (r) { return r.structs_load; },
    age: function (r) { return r.fetched_at_ms; },
  };
  function fleetSorted(rows) { return H.sortBy(rows, fleet.sort, FLEET_ACC); }

  function selCount() { return Object.keys(fleet.selection).length; }

  function buildFleetDom() {
    if (fleet.built) return;
    fleet.built = true;
    var body = document.getElementById('fleet-body');
    body.innerHTML = '';

    // ── Toolbar: filters ──
    var bar = H.el('div', null); bar.id = 'fleet-toolbar';
    var search = H.el('input', 'sui-input-text');
    search.type = 'text'; search.placeholder = 'filter name / id / planet';
    search.addEventListener('input', function () { fleet.filterText = search.value; renderFleetRows(); });
    var roleSel = H.el('select', 'sui-input-text');
    [['', 'all roles'], ['productive', 'productive'], ['bait', 'bait'], ['primary', 'primary']].forEach(function (o) {
      var op = H.el('option', null, o[1]); op.value = o[0]; roleSel.appendChild(op);
    });
    roleSel.addEventListener('change', function () { fleet.filterRole = roleSel.value; renderFleetRows(); });
    var attnLbl = H.el('label', null);
    var attn = H.el('input'); attn.type = 'checkbox';
    attn.addEventListener('change', function () { fleet.filterAttn = attn.checked; renderFleetRows(); });
    attnLbl.appendChild(attn); attnLbl.appendChild(document.createTextNode(' attention'));
    var refreshBtn = H.el('a', 'ops-refresh-btn', 'Refresh roster');
    refreshBtn.href = 'javascript:void(0)';
    refreshBtn.addEventListener('click', function () {
      Board.T.core.invoke('mcp_roster_refresh').catch(function () {});
    });
    bar.appendChild(search); bar.appendChild(roleSel); bar.appendChild(attnLbl); bar.appendChild(refreshBtn);
    body.appendChild(bar);

    // ── Toolbar: mass actions (one-click; ambient dry-run on the buttons) ──
    var actions = H.el('div', 'sui-screen-btn-flex-wrapper'); actions.id = 'fleet-actions';
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center;';

    var sweepBtn = massBtn('sweep-btn', 'icon-send-alpha', 'Sweep…', 'sui-mod-primary');
    sweepBtn.addEventListener('click', function () { runSweep(); });
    actions.appendChild(sweepBtn);

    var roleApplySel = H.el('select', 'sui-input-text');
    [['productive', '→ productive'], ['bait', '→ bait']].forEach(function (o) {
      var op = H.el('option', null, o[1]); op.value = o[0]; roleApplySel.appendChild(op);
    });
    roleApplySel.id = 'role-apply-sel';
    var roleBtn = massBtn('role-btn', 'icon-edit', 'Set role', 'sui-mod-secondary');
    roleBtn.addEventListener('click', function () { runSetRole(roleApplySel.value); });
    actions.appendChild(roleApplySel); actions.appendChild(roleBtn);

    var scanSel = H.el('select', 'sui-input-text');
    ['harvest', 'build', 'defend', 'infuse'].forEach(function (l) {
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

    // ── Sort + select-all (result rows are header-less, so sorting is a
    //    dropdown rather than clickable column headers) ──
    var sortBar = H.el('div', null);
    sortBar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:12px;';
    sortBar.appendChild(H.sortControl(FLEET_SORT_KEYS, fleet.sort, renderFleetRows));
    var allLbl = H.el('label', null);
    var allCb = H.el('input'); allCb.type = 'checkbox'; allCb.id = 'fleet-select-all';
    allCb.addEventListener('change', function () {
      var shown = fleetFiltered();
      if (allCb.checked) shown.forEach(function (r) { if (r.index != null) fleet.selection[r.player_id] = true; });
      else shown.forEach(function (r) { delete fleet.selection[r.player_id]; });
      renderFleetRows();
    });
    allLbl.appendChild(allCb); allLbl.appendChild(document.createTextNode(' select all shown'));
    sortBar.appendChild(allLbl);
    body.appendChild(sortBar);

    var rowsBox = H.resultTable(); rowsBox.id = 'fleet-rows';
    body.appendChild(rowsBox);
    var foot = H.el('div', 'fleet-foot');
    foot.appendChild(H.el('span', null, '')); foot.appendChild(H.el('span', null, ''));
    foot.id = 'fleet-foot';
    body.appendChild(foot);
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

  function renderFleetRows() {
    var rowsBox = document.getElementById('fleet-rows');
    if (!rowsBox) return;
    var shown = fleetSorted(fleetFiltered());
    rowsBox.innerHTML = '';
    shown.forEach(function (r) {
      // Checkbox (vplayers only; primary is never a mass-action target).
      var lead = null;
      if (r.index != null) {
        lead = H.el('input'); lead.type = 'checkbox';
        lead.checked = !!fleet.selection[r.player_id];
        lead.addEventListener('click', function (ev) { ev.stopPropagation(); });
        lead.addEventListener('change', function () {
          if (lead.checked) fleet.selection[r.player_id] = true;
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
      rowsBox.appendChild(row);
    });
    updateFleetChrome(shown);
  }

  function updateFleetChrome(shownArg) {
    var shown = shownArg || fleetSorted(fleetFiltered());
    var foot = document.getElementById('fleet-foot');
    if (foot) {
      foot.firstChild.textContent = shown.length + ' / ' + fleet.rows.length + ' shown · ' + selCount() + ' selected' +
        (selCount() ? '' : '');
      foot.lastChild.innerHTML = '';
      if (selCount()) {
        var clr = H.el('a', 'ops-refresh-btn', 'clear selection');
        clr.href = 'javascript:void(0)';
        clr.addEventListener('click', function () { fleet.selection = {}; renderFleetRows(); });
        foot.lastChild.appendChild(clr);
      } else {
        foot.lastChild.textContent = 'roster ' + (fleet.refreshedAt ? H.ago(fleet.refreshedAt) + ' old' : 'loading…');
      }
    }
    var roleBtn = document.getElementById('role-btn');
    if (roleBtn) roleBtn.classList.toggle('sui-mod-disabled', selCount() === 0 || fleet.jobRunning);
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
  var workState = { data: null, sort: { key: 'progress', dir: -1 } };
  var WORK_KEYS = [{ key: 'progress', label: 'progress' }, { key: 'difficulty', label: 'difficulty' },
    { key: 'status', label: 'status' }, { key: 'type', label: 'type' }, { key: 'task', label: 'task id' }];
  var WORK_ACC = {
    progress: function (t) { return t.percent_complete || 0; },
    difficulty: function (t) { return t.current_difficulty == null ? -1 : t.current_difficulty; },
    status: function (t) { return (t.status || '').toLowerCase(); },
    type: function (t) { return (t.task_type || '').toLowerCase(); },
    task: function (t) { return t.task_id || ''; },
  };
  function renderWorkBody() {
    var d = workState.data; if (!d) return;
    var body = document.getElementById('work-body');
    body.innerHTML = '';

    var c = d.counts || {};
    var hc = d.hash_config || {};
    var qbody = H.el('div');
    qbody.appendChild(H.row('Running / Waiting / Done', (c.running || 0) + ' / ' + (c.waiting || 0) + ' / ' + (c.completed || 0), 'icon-in-progress'));
    qbody.appendChild(H.row('Engine', (hc.effective_engine || '?') + (hc.gpu_available ? ' (GPU available)' : '')));
    qbody.appendChild(H.row('difficulty_start / max_concurrent', hc.difficulty_start + ' / ' + hc.max_concurrent +
      (hc.auto_tune ? ' · auto-tune ON' : '')));
    body.appendChild(H.card('PoW QUEUE', qbody));

    var all = d.tasks || [];
    if (all.length) {
      // Sort the FULL task set, then cap the render — so the sort reflects
      // every task, not just an arbitrary first 40.
      var tasks = H.sortBy(all, workState.sort, WORK_ACC).slice(0, 40);
      var tbody = H.el('div');
      var bar = H.el('div'); bar.style.cssText = 'margin-bottom:6px;';
      bar.appendChild(H.sortControl(WORK_KEYS, workState.sort, renderWorkBody));
      tbody.appendChild(bar);
      var table = H.resultTable();
      var typeIcon = { MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-in-progress', RAID: 'icon-raid' };
      tasks.forEach(function (t) {
        var diff = (t.current_difficulty != null ? t.current_difficulty : '—') +
          '→' + (t.difficulty_target != null ? t.difficulty_target : '—');
        table.appendChild(H.resultRow({
          icon: typeIcon[t.task_type] || 'icon-in-progress',
          title: t.task_id || '?',
          subtitle: (t.task_type || '?') + ' · ' + (t.status || '?'),
          chips: [
            H.resource(H.progressBar((t.percent_complete || 0) / 100)),
            H.resource(diff),
            H.resource(t.eta || '—', null, 'ops-muted'),
          ],
        }));
      });
      tbody.appendChild(table);
      if (all.length > 40) tbody.appendChild(H.el('div', 'ops-muted', (all.length - 40) + ' more not shown'));
      body.appendChild(H.card('TASKS', tbody));
    }

      var lh = d.loop_health;
      if (lh && lh.length) {
        var lbody = H.el('div');
        lh.forEach(function (l) {
          var line = l.runs + ' runs · ' + (l.actions || 0) + ' actions · ' + (l.errors || 0) + ' errors';
          lbody.appendChild(H.row(l.loop, line, (l.errors || 0) > 0 ? 'icon-alert' : 'icon-success'));
        });
        body.appendChild(H.card('LOOP HEALTH (1h)', lbody));
      }

      var tx = d.tx_summary || {};
      if (tx.top_errors && tx.top_errors.length) {
        var xbody = H.el('div');
        tx.top_errors.slice(0, 5).forEach(function (e2) {
          xbody.appendChild(H.row(String(e2.count) + '×', e2.reason.slice(0, 90), 'icon-alert'));
        });
        body.appendChild(H.card('TOP TX ERRORS (1h)', xbody));
      }
      Board.stamp('updated ' + new Date().toLocaleTimeString());
  }
  function renderWork() {
    return Board.T.core.invoke('mcp_work').then(function (d) {
      workState.data = d; renderWorkBody();
    }).catch(function (e) {
      var body = document.getElementById('work-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('work unavailable: ' + e, 'icon-alert'));
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
      ['productive', 'bait'].forEach(function (role) {
        if (!appear.config[role]) return;
        var c = buildRoleCard(role); c.id = 'appear-' + role;
        host.appendChild(c);
      });
    }).catch(function (e) { host.appendChild(H.alertLine('appearance unavailable: ' + e, 'icon-alert')); });
  }

  function renderConfig() {
    return Board.T.core.invoke('mcp_config_bundle').then(function (d) {
      var body = document.getElementById('config-body');
      body.innerHTML = '';

      // ── Doctrine presets ──
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

      // ── Auto-loops ──
      var loops = d.loops || {};
      var lbody = H.el('div');
      Object.keys(loops).forEach(function (name) {
        var cfg = loops[name];
        var r = H.el('div', 'cfg-row');
        var lbl = H.el('label');
        var cb = H.el('input'); cb.type = 'checkbox'; cb.checked = !!cfg.enabled;
        cb.addEventListener('change', function () {
          var next = JSON.parse(JSON.stringify(cfg));
          next.enabled = cb.checked;
          cfgSet('loop', { loop: name, config: next });
        });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' auto_' + name));
        r.appendChild(lbl);
        var detail = Object.keys(cfg).filter(function (k) { return k !== 'enabled'; })
          .map(function (k) { return k + '=' + cfg[k]; }).join(' · ');
        r.appendChild(H.el('span', 'ops-muted', detail));
        lbody.appendChild(r);
      });
      body.appendChild(H.card('AUTO-LOOPS', lbody));

      // ── Hash engine ──
      var hc = d.hash || {};
      var hbody = H.el('div');
      var hr1 = H.el('div', 'cfg-row');
      var hlbl = H.el('label');
      var hcb = H.el('input'); hcb.type = 'checkbox'; hcb.checked = !!hc.enabled;
      hcb.addEventListener('change', function () { cfgSet('hash', { enabled: hcb.checked }); });
      hlbl.appendChild(hcb); hlbl.appendChild(document.createTextNode(' hashing enabled'));
      hr1.appendChild(hlbl);
      var engSel = H.el('select');
      ['auto', 'cpu', 'gpu'].forEach(function (e2) {
        var o = H.el('option', null, e2); o.value = e2;
        if (hc.engine_pref === e2) o.selected = true;
        engSel.appendChild(o);
      });
      engSel.addEventListener('change', function () { cfgSet('hash', { engine: engSel.value }); });
      hr1.appendChild(engSel);
      hbody.appendChild(hr1);
      var hr2 = H.el('div', 'cfg-row');
      hr2.appendChild(H.el('span', null, 'difficulty_start / max_concurrent'));
      var dsIn = H.el('input'); dsIn.type = 'number'; dsIn.min = '1'; dsIn.max = '64'; dsIn.value = hc.difficulty_start;
      var mcIn = H.el('input'); mcIn.type = 'number'; mcIn.min = '1'; mcIn.max = '64'; mcIn.value = hc.max_concurrent;
      dsIn.addEventListener('change', function () { cfgSet('hash', { difficulty_start: parseInt(dsIn.value, 10) }); });
      mcIn.addEventListener('change', function () { cfgSet('hash', { max_concurrent: parseInt(mcIn.value, 10) }); });
      var wrap = H.el('span'); wrap.appendChild(dsIn); wrap.appendChild(document.createTextNode(' ')); wrap.appendChild(mcIn);
      hr2.appendChild(wrap);
      hbody.appendChild(hr2);
      var hr3 = H.el('div', 'cfg-row');
      var atLbl = H.el('label');
      var atCb = H.el('input'); atCb.type = 'checkbox'; atCb.checked = !!hc.auto_tune;
      atCb.addEventListener('change', function () { cfgSet('hash', { auto_tune: atCb.checked }); });
      atLbl.appendChild(atCb); atLbl.appendChild(document.createTextNode(' auto-tune from solve history'));
      hr3.appendChild(atLbl);
      hbody.appendChild(hr3);
      body.appendChild(H.card('HASH ENGINE', hbody));

      // ── Policies (map: name -> {enabled, config}) ──
      var pol = d.policies || {};
      var names = Object.keys(pol).sort();
      if (names.length) {
        var pbody = H.el('div');
        names.forEach(function (name) {
          var p = pol[name] || {};
          var r = H.el('div', 'cfg-row');
          var lbl = H.el('label');
          var cb = H.el('input'); cb.type = 'checkbox'; cb.checked = !!p.enabled;
          cb.addEventListener('change', function () {
            cfgSet('policy', { name: name, enabled: cb.checked });
          });
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(' ' + name));
          r.appendChild(lbl);
          var cfgStr = p.config && Object.keys(p.config).length ? JSON.stringify(p.config).slice(0, 60) : '';
          r.appendChild(H.el('span', 'ops-muted', cfgStr));
          pbody.appendChild(r);
        });
        body.appendChild(H.card('POLICIES', pbody));
      }
      // ── Web dashboard (opt-in remote access) ──
      var wb = d.web_board || {};
      var wbody = H.el('div');
      var wrow = H.el('div', 'cfg-row');
      var wlbl = H.el('label');
      var wcb = H.el('input'); wcb.type = 'checkbox'; wcb.checked = !!wb.enabled;
      wcb.addEventListener('change', function () {
        cfgSet('web_board', { enabled: wcb.checked });
      });
      wlbl.appendChild(wcb);
      wlbl.appendChild(document.createTextNode(' serve this dashboard as a web page'));
      wrow.appendChild(wlbl);
      wbody.appendChild(wrow);
      if (wb.enabled && wb.url) {
        var urow = H.el('div', 'cfg-row');
        var ulink = H.el('a', 'ops-refresh-btn', wb.url);
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

      // ── Role appearance (per-role avatar config) ──
      renderRoleAppearance(body);
      Board.stamp('updated ' + new Date().toLocaleTimeString());
    }).catch(function (e) {
      var body = document.getElementById('config-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('config unavailable: ' + e, 'icon-alert'));
    });
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
