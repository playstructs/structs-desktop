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

  function fleetSorted(rows) {
    var k = fleet.sort.key, d = fleet.sort.dir;
    var val = function (r) {
      switch (k) {
        case 'index': return r.index == null ? -1 : r.index;
        case 'name': return r.name.toLowerCase();
        case 'charge': return r.charge;
        case 'alpha': return r.alpha_ualpha;
        case 'ore': return r.ore;
        case 'power': return r.structs_load;
        case 'planet': return r.planet_id || '';
        case 'age': return r.fetched_at_ms;
        default: return 0;
      }
    };
    return rows.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -d;
      if (va > vb) return d;
      return 0;
    });
  }

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

    // ── Header + rows + footer ──
    var head = H.el('div', 'frow fhead');
    head.appendChild(headCell('', null)); // checkbox col
    [['name', 'Player'], ['charge', 'Charge'], ['alpha', 'Alpha'], ['ore', 'Ore'],
     ['power', 'Load'], ['index', 'Idx'], ['planet', 'Planet'], ['age', 'Age']].forEach(function (c) {
      head.appendChild(headCell(c[1], c[0]));
    });
    // select-all-filtered checkbox in the first header cell
    var allCb = H.el('input'); allCb.type = 'checkbox'; allCb.id = 'fleet-select-all';
    allCb.addEventListener('change', function () {
      var shown = fleetFiltered();
      if (allCb.checked) shown.forEach(function (r) { if (r.index != null) fleet.selection[r.player_id] = true; });
      else shown.forEach(function (r) { delete fleet.selection[r.player_id]; });
      renderFleetRows();
    });
    head.firstChild.appendChild(allCb);
    body.appendChild(head);

    var rowsBox = H.el('div', null); rowsBox.id = 'fleet-rows';
    body.appendChild(rowsBox);
    var foot = H.el('div', 'fleet-foot');
    foot.appendChild(H.el('span', null, '')); foot.appendChild(H.el('span', null, ''));
    foot.id = 'fleet-foot';
    body.appendChild(foot);
  }

  function headCell(label, sortKey) {
    var s = H.el('span', null, label);
    if (sortKey) {
      s.setAttribute('data-sort', sortKey);
      s.addEventListener('click', function () {
        if (fleet.sort.key === sortKey) fleet.sort.dir = -fleet.sort.dir;
        else { fleet.sort.key = sortKey; fleet.sort.dir = 1; }
        renderFleetRows();
      });
    }
    return s;
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
      var d = H.el('div', 'frow');
      var cbCell = H.el('span');
      if (r.index != null) { // primary is not selectable (never a mass target)
        var cb = H.el('input'); cb.type = 'checkbox';
        cb.checked = !!fleet.selection[r.player_id];
        cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
        cb.addEventListener('change', function () {
          if (cb.checked) fleet.selection[r.player_id] = true;
          else delete fleet.selection[r.player_id];
          updateFleetChrome();
        });
        cbCell.appendChild(cb);
      }
      d.appendChild(cbCell);
      var nameCell = H.el('span', r.err ? 'err' : null, r.name + ' ');
      nameCell.appendChild(H.badge(r.role === 'productive' ? 'PROD' : r.role === 'primary' ? 'PRIME' : 'BAIT',
        r.role === 'productive' ? 'solid' : r.role === 'primary' ? 'warning' : 'default'));
      d.appendChild(nameCell);
      var chargeCell = H.el('span');
      chargeCell.appendChild(H.battery(Math.min(8, r.charge), 8));
      chargeCell.appendChild(document.createTextNode(' ' + (r.charge >= 8 ? 'RDY' : r.charge)));
      d.appendChild(chargeCell);
      d.appendChild(H.el('span', 'fnum', alpha(r.alpha_ualpha)));
      d.appendChild(H.el('span', 'fnum', H.fmtNum(r.ore)));
      d.appendChild(H.el('span', 'fnum', (r.structs_load / 1e6).toFixed(1) + 'kW'));
      d.appendChild(H.el('span', 'fnum', r.index == null ? '—' : String(r.index)));
      var planetCell = H.el('span');
      if (r.planet_id) {
        var pl = H.el('a', 'ops-refresh-btn', r.planet_id);
        pl.href = '#/map?p=' + encodeURIComponent(r.player_id);
        pl.addEventListener('click', function (ev) { ev.stopPropagation(); });
        planetCell.appendChild(pl);
      } else planetCell.textContent = '—';
      d.appendChild(planetCell);
      d.appendChild(H.el('span', fleetAttention(r) ? 'attn' : 'ops-muted', H.ago(r.fetched_at_ms)));
      d.addEventListener('click', function () { toggleDetail(d, r); });
      rowsBox.appendChild(d);
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

  function toggleDetail(rowEl, r) {
    var next = rowEl.nextSibling;
    if (next && next.className === 'frow-detail') { next.parentNode.removeChild(next); return; }
    var det = H.el('div', 'frow-detail', 'loading detail…');
    rowEl.parentNode.insertBefore(det, rowEl.nextSibling);
    Board.T.core.invoke('mcp_player_detail', { player: r.player_id }).then(function (d) {
      det.innerHTML = '';
      det.appendChild(H.el('div', null,
        r.player_id + ' · ' + d.struct_count + ' structs · planet ' + (r.planet_id || '—') + ' · fleet ' + (r.fleet_id || '—')));
      if (d.struct_ids && d.struct_ids.length) {
        det.appendChild(H.el('div', 'ops-muted', d.struct_ids.join('  ')));
      }
    }).catch(function (e) {
      det.textContent = 'detail failed: ' + e;
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
  function renderEnergy() {
    return Board.T.core.invoke('mcp_energy').then(function (d) {
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
      var head = H.el('div', 'frow fhead');
      ['Player', 'Demand', 'Supply', 'Margin', ''].forEach(function (h2) { head.appendChild(H.el('span', null, h2)); });
      pbody.appendChild(head);
      var rowsBox = H.el('div'); rowsBox.id = 'energy-rows';
      (d.players || []).slice(0, 60).forEach(function (p) {
        var r = H.el('div', 'frow');
        r.appendChild(H.el('span', p.err ? 'err' : null, p.name));
        r.appendChild(H.el('span', 'fnum', kw(p.load_mw)));
        r.appendChild(H.el('span', 'fnum', kw(p.capacity_mw)));
        r.appendChild(H.el('span', 'fnum ' + (p.margin_pct < 15 ? 'attn' : ''), Math.round(p.margin_pct) + '%'));
        var ic = H.el('span');
        if (!p.ok) ic.appendChild(H.el('i', 'sui-icon sui-icon-no-power sui-icon-sm'));
        r.appendChild(ic);
        rowsBox.appendChild(r);
      });
      pbody.appendChild(rowsBox);
      pbody.appendChild(H.el('div', 'ops-muted', 'worst margins first · roster ' + H.ago(d.roster_refreshed_at_ms) + ' old'));
      body.appendChild(H.card('PLAYER MARGINS', pbody));
      Board.stamp('updated ' + new Date().toLocaleTimeString());
    }).catch(function (e) {
      var body = document.getElementById('energy-body');
      body.innerHTML = '';
      body.appendChild(H.alertLine('energy unavailable: ' + e, 'icon-alert'));
    });
  }
  Board.registerPage('energy', { refresh: renderEnergy, cadenceMs: 30000, onEnter: renderEnergy });

  // ═══════════════════════════ WORK ═════════════════════════════════════════
  function renderWork() {
    return Board.T.core.invoke('mcp_work').then(function (d) {
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

      var tasks = (d.tasks || []).slice(0, 40);
      if (tasks.length) {
        var tbody = H.el('div');
        var head = H.el('div', 'frow fhead');
        ['Task', 'Type', 'Status', 'Progress', 'Diff', 'ETA'].forEach(function (h2) { head.appendChild(H.el('span', null, h2)); });
        tbody.appendChild(head);
        var box = H.el('div'); box.id = 'work-rows';
        tasks.forEach(function (t) {
          var r = H.el('div', 'frow');
          r.appendChild(H.el('span', null, t.task_id || '?'));
          r.appendChild(H.el('span', null, t.task_type || '?'));
          r.appendChild(H.el('span', t.status === 'running' ? null : 'ops-muted', t.status || '?'));
          var pc = H.el('span');
          pc.appendChild(H.progressBar((t.percent_complete || 0) / 100));
          r.appendChild(pc);
          r.appendChild(H.el('span', 'fnum', (t.current_difficulty != null ? t.current_difficulty : '—') + '→' + (t.difficulty_target != null ? t.difficulty_target : '—')));
          r.appendChild(H.el('span', 'fnum ops-muted', t.eta || '—'));
          box.appendChild(r);
        });
        tbody.appendChild(box);
        if ((d.tasks || []).length > 40) tbody.appendChild(H.el('div', 'ops-muted', (d.tasks.length - 40) + ' more not shown'));
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
