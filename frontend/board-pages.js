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
  var kw = function (mw) { return (mw / 1e6).toFixed(2) + ' kW'; };
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
        var label = sel.length
          ? 'Sweep ' + r.entries.length + ' of ' + sel.length + ' sel · ~' + H.fmtNum(r.total_alpha) + 'α'
          : 'Sweep all productive (' + r.entries.length + ') · ~' + H.fmtNum(r.total_alpha) + 'α';
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
          H.resource(kwv(p.load_mw) + ' / ' + kwv(p.capacity_mw) + ' kW', 'sui-icon-energy'),
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
