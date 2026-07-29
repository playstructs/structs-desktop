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
  // Energy displays follow the game's unit ladder (H.fmtWatts, input mW).
  var kw = function (mw) { return H.fmtWatts(mw); };
  var alpha = function (ualpha) { return H.fmtNum(ualpha / 1e6); };

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

  function armadaAttention(r) {
    return !!r.err || r.charge >= 24; // read failed, or idle 24+ blocks (~2min+)
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
    countIn.style.cssText = 'width:64px;background:transparent;color:inherit;border:1px solid var(--border,#345);padding:2px 6px;';
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
  function renderArmadaRows() {
    if (!armada.lv) return;
    armada.lv.setRows(armada.rows);
  }

  // One roster row. Pure: given a row it returns a node, so listView can cache
  // and reuse it until that row's data (or its selected state) changes.
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
      var title = H.el('span', r.err ? 'err' : null, r.name + ' ');
      title.appendChild(H.badge(r.role === 'productive' ? 'PROD' : r.role === 'primary' ? 'PRIME' : 'BAIT',
        r.role === 'productive' ? 'solid' : r.role === 'primary' ? 'warning' : 'default'));
      // Subtitle: PID (the native roster's identity line). Freshness is shown
      // only when a row needs attention, so the common case stays clean; the
      // rest (index, planet, last action) lives in the click-through detail.
      var sub = H.el('span');
      sub.appendChild(document.createTextNode('PID #' + r.player_id));
      if (armadaAttention(r)) {
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
        var label = sel.length
          ? 'Sweep ' + r.entries.length + ' ~' + H.fmtNum(r.total_alpha) + 'α'
          : 'Sweep all ~' + H.fmtNum(r.total_alpha) + 'α';
        btn.lastChild.textContent = ' ' + label;
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
        armada.rows = snap.rows || [];
        armada.refreshedAt = snap.refreshed_at_ms || 0;
        buildArmadaDom();
        renderArmadaRows();
      }).catch(function () {});
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
  var energyState = { data: null };
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
    var bar = H.el('div', 'alloc-meter-bar');
    var fill = H.el('i');
    fill.style.width = (used * 100) + '%';
    // Amber under 15% spare, red when there is effectively nothing left.
    var spare = b.capacity_mw > 0 ? b.allocatable_mw / b.capacity_mw : 1;
    bar.className += spare < 0.01 ? ' full' : (spare < 0.15 ? ' tight' : '');
    bar.appendChild(fill);
    meter.appendChild(bar);
    var cap = H.el('div', 'alloc-meter-caption');
    cap.appendChild(H.el('span', null,
      H.fmtWatts(b.load_mw) + ' allocated of ' + H.fmtWatts(b.capacity_mw) + ' capacity'));
    cap.appendChild(H.el('span', 'alloc-meter-pct', pct + '%'));
    meter.appendChild(cap);
    host.appendChild(meter);

    // The two numbers people actually confuse. Allocatable is what this panel
    // can spend; available is whether the structs stay on.
    var head = H.el('div', 'hstrip alloc-budget');
    head.appendChild(statTile('allocatable', H.fmtWatts(b.allocatable_mw), null,
      spare < 0.01 ? 'bad' : (spare < 0.15 ? 'live' : 'ok')));
    head.appendChild(statTile('structs draw', H.fmtWatts(b.structs_load_mw), null, 'muted'));
    head.appendChild(statTile('from substation', H.fmtWatts(b.capacity_secondary_mw), null, 'muted'));
    head.appendChild(statTile('available', H.fmtWatts(b.available_mw), null,
      b.online === false ? 'bad' : 'ok'));
    host.appendChild(head);
    if (b.online === false) {
      host.appendChild(H.stateBlock('error',
        'Draw exceeds supply — structs go offline until you free capacity.'));
    }

    var rows = d.allocations || [];
    if (!rows.length) {
      host.appendChild(H.stateBlock('empty',
        'No allocations. One routes your capacity into a substation — the substation gains it, you carry it as load.'));
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
    // Definitions last: the data answers the question, this only explains the
    // two words above it. `cfg-note` is the 11px aside style — `.ops-muted`
    // alone only dims, so it rendered at full body size and dominated the card.
    host.appendChild(H.el('div', 'cfg-note',
      'Allocatable is capacity minus what you already route out — what these controls can spend. '
      + 'Available also counts your structs\u2019 draw and the share coming back from the '
      + 'substation, and is what decides whether your structs stay online.'));
  }

  function allocEditor(a, d) {
    var wrap = H.el('div', 'alloc-editor');
    var b = d.budget || {};
    var maxKw = kwOf(a.power_mw + b.allocatable_mw);   // everything we could commit

    var out = H.el('div');
    function refreshPreview() {
      out.innerHTML = '';
      var kwVal = Number(allocState.draftKw);
      if (!isFinite(kwVal)) { return; }
      out.appendChild(H.stateBlock('loading', 'checking…'));
      Board.T.core.invoke('mcp_allocation_preview', {
        allocationId: a.id, powerMw: Math.round(kwVal * 1e6),
      }).then(function (p) {
        allocState.preview = p;
        out.innerHTML = '';
        if (!p.ok) { out.appendChild(H.stateBlock('error', p.refusal)); return; }
        var delta = p.delta_mw;
        out.appendChild(H.row(delta >= 0 ? 'Adds to your load' : 'Frees from your load',
          H.fmtWatts(Math.abs(delta))));
        out.appendChild(H.row('Headroom after',
          H.fmtWatts(p.projected_headroom_mw) + ' (' + Math.round(p.projected_headroom_pct) + '%)'));
        var go = massBtn('', 'icon-success', 'Apply', 'sui-mod-primary');
        go.addEventListener('click', function () { applyAllocPower(a, kwVal); });
        out.appendChild(go);
      }).catch(function (e) {
        out.innerHTML = '';
        out.appendChild(H.stateBlock('error', String(e)));
      });
    }

    // Entered in kW — the unit the rest of this page speaks. The exact mW that
    // will be signed is echoed by the preview above the Apply button.
    var input = H.textBox(String(Math.round(kwOf(a.power_mw) * 100) / 100), 'kW', function (v) {
      allocState.draftKw = Number(v) || 0;
      refreshPreview();
    });
    wrap.appendChild(H.field('New power (kW)', input));

    var quick = H.el('div', 'cfg-actions');
    var max = massBtn('', 'icon-add', 'Use all headroom', 'sui-mod-secondary');
    max.addEventListener('click', function () {
      allocState.draftKw = Math.floor(maxKw * 100) / 100;
      input.value = String(allocState.draftKw);
      refreshPreview();
    });
    quick.appendChild(max);
    wrap.appendChild(quick);
    wrap.appendChild(H.el('div', 'ops-muted',
      'Currently ' + H.fmtWatts(a.power_mw) + '; the most you could commit is '
      + H.fmtWatts(a.power_mw + (d.budget || {}).allocatable_mw)
      + '. Going over capacity brownouts the grid and destroys allocations in creation order.'));
    wrap.appendChild(out);
    return wrap;
  }

  function applyAllocPower(a, kwVal) {
    if (allocState.busy) return;
    var body = H.el('div');
    body.appendChild(H.el('div', 'ops-muted',
      'This changes real grid capacity. The substation gains (or loses) the difference, '
      + 'and your own load moves by the same amount.'));
    body.appendChild(H.row('Allocation', a.id + ' → ' + a.destination_id));
    body.appendChild(H.row('From', H.fmtWatts(a.power_mw)));
    body.appendChild(H.row('To', H.fmtWatts(kwVal * 1e6)));
    H.confirmModal('Set allocation power?', body, 'Apply', function () {
      allocState.busy = true;
      Board.T.core.invoke('mcp_allocation_set_power', {
        allocationId: a.id, powerMw: Math.round(kwVal * 1e6),
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
      return { value: s.id, label: s.id + ' — ' + H.fmtWatts(s.connection_capacity_mw)
        + '/conn across ' + s.connection_count };
    });
    form.appendChild(H.field('Move to', H.selectBox(dest, opts, function (v) { dest = v; })));
    form.appendChild(H.el('div', 'form-note',
      'Connecting needs no permission from the destination. Your contribution is diluted '
      + 'by the connection count — feeding a busy substation helps the group, not your own share.'));
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
    form.appendChild(go);
    H.drawer('Move allocation ' + a.id, form);
  }

  function allocCreate(d) {
    var wrap = H.el('div', 'alloc-create');
    var b = d.budget || {};
    var open = massBtn('', 'icon-add', 'New allocation', 'sui-mod-secondary');
    open.addEventListener('click', function () {
      var form = H.el('div');
      var kwVal = 0, type = 'dynamic', src = d.player_id;
      form.appendChild(formFact('Source', d.player_id + ' (you)'));
      form.appendChild(formFact('Allocatable now', H.fmtWatts(b.allocatable_mw)));
      form.appendChild(H.field('Type', H.selectBox('dynamic',
        [{value:'dynamic',label:'dynamic — power you can change later'},
         {value:'static',label:'static — fixed at creation'},
         {value:'automated',label:'automated — tracks your full capacity (one per source)'}],
        function (v) { type = v; })));
      form.appendChild(H.field('Power (kW)', H.textBox('', '0', function (v) { kwVal = Number(v) || 0; })));
      form.appendChild(H.el('div', 'form-note',
        'A new allocation takes its power from your headroom immediately. It is created '
        + 'unconnected — use Move to point it at a substation.'));
      var go = massBtn('', 'icon-add', 'Create', 'sui-mod-destructive');
      go.addEventListener('click', function () {
        Board.T.core.invoke('mcp_allocation_create', {
          sourceObjectId: src, allocationType: type, powerMw: Math.round(kwVal * 1e6),
        }).then(function () {
          loadAllocations().then(renderEnergyBody);
        }).catch(function (e) {
          form.appendChild(H.stateBlock('error', String(e)));
        });
      });
      form.appendChild(go);
      H.drawer('New allocation', form);
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
        subtitle: g.under
          ? g.under + ' below 15% — worst is ' + g.worstName + ' at ' + Math.round(g.worst) + '%'
          : 'all above 15%',
        chips: [
          statTile('avg margin', Math.round(avg) + '%', null, avg < 15 ? 'live' : 'ok'),
          statTile('worst', Math.round(g.worst) + '%', null, g.worst < 15 ? 'bad' : 'muted'),
          statTile('total load', H.fmtWatts(g.load), null, 'muted'),
          statTile('stale reads', g.errs, null, g.errs ? 'live' : 'muted'),
        ],
      }));
    });
    pbody.appendChild(table);
    pbody.appendChild(H.el('div', 'cfg-note',
      'Grouped by role — the primary is listed individually. "Worst" is the figure that matters: '
      + 'an average stays healthy while one starved player goes offline. Roster '
      + H.ago(d.roster_refreshed_at_ms) + ' old.'));

    body.appendChild(H.card('PLAYER MARGINS', pbody));
    Board.stamp('updated ' + new Date().toLocaleTimeString());
  }
  function renderEnergy() {
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
    qbody.appendChild(H.row('difficulty_start / max_concurrent', hc.difficulty_start + ' / ' + hc.max_concurrent +
      (hc.auto_tune ? ' · auto-tune ON' : '')));

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
          subtitle: (e2.solves || 0) + ' solves in the last 24h',
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
  // A read-only fact row: label above value, value free to wrap.
  function formFact(label, value, title) {
    var d = H.el('div', 'form-fact');
    d.appendChild(H.el('div', 'form-fact-label', label));
    var v = H.el('div', 'form-fact-value', value);
    if (title) v.title = title;
    d.appendChild(v);
    return d;
  }

  function shortAddress(a) {
    a = String(a || '');
    return a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-6) : a;
  }

  function openTransfer(denom) {
    var reg = invDenoms();
    var info = reg[denom] || {};
    var exp = info.exponent || 0;
    var scale = Math.pow(10, exp);
    var unit = H.denomName(denom, reg, { tag: false });
    var form = H.el('div');
    var to = '', amountDisplay = 0;

    // FROM and ASSET are facts, not fields — they were rendered as labelled
    // inputs, so a 44-character address sat in a 332px two-column row and
    // collided with its own label.
    var me = invState.data.player;
    form.appendChild(formFact('From',
      (me.name || '?') + ' · ' + shortAddress(me.address), me.address));
    form.appendChild(formFact('Asset', H.denomName(denom, reg, { style: 'both' })));
    form.appendChild(formFact('Available',
      H.denomQty(balanceOf(denom), denom, reg)));

    form.appendChild(H.field('To', H.textBox('', 'structs1…', function (v) {
      to = v.trim();
      renderEcho();
    })));

    // Amount is entered in DISPLAY units. It used to demand base units with a
    // hint reading "e.g. 1000000 = 1 Alpha" — asking someone to do a 10^6
    // conversion in their head on a form that moves money is how you get a
    // transfer that is a million times too big.
    form.appendChild(H.field('Amount (' + unit + ')',
      H.textBox('', '0', function (v) {
        amountDisplay = Number(v) || 0;
        renderEcho();
      })));

    // Live echo of exactly what will be sent, in both units.
    var echo = H.el('div', 'form-note');
    form.appendChild(echo);
    function baseUnits() { return Math.round(amountDisplay * scale); }
    function renderEcho() {
      if (!amountDisplay) { echo.textContent = ''; return; }
      echo.textContent = 'Sends ' + H.fmtNum(amountDisplay) + ' ' + unit
        + ' (' + H.fmtInt(baseUnits()) + ' ' + denom + ')';
    }

    var out = H.el('div');
    form.appendChild(out);

    var check = massBtn('', 'icon-detected', 'Preview', 'sui-mod-secondary');
    check.addEventListener('click', function () {
      out.innerHTML = '';
      out.appendChild(H.stateBlock('loading', 'checking…'));
      Board.T.core.invoke('mcp_transfer_preview', {
        from: invState.player, to: to, denom: denom, amount: baseUnits(),
      }).then(function (p) {
        out.innerHTML = '';
        (p.problems || []).forEach(function (x) {
          out.appendChild(H.stateBlock('error', x));
        });
        if (!p.ok) return;
        // Who is actually on the other end. An address we can't name is
        // called out as external rather than shown as a bare string.
        out.appendChild(p.recipient
          ? H.stateBlock('info', 'Recipient: ' + p.recipient)
          : H.stateBlock('warning', 'Recipient: EXTERNAL address — not one of your players'));
        out.appendChild(formFact('Sending', H.denomQty(p.amount, denom, reg)
          + ' (' + H.fmtInt(p.amount) + ' ' + denom + ')'));
        out.appendChild(formFact('To', shortAddress(p.to), p.to));
        out.appendChild(formFact('Signed via', p.route));

        var go = massBtn('', 'icon-send-alpha', 'Send', 'sui-mod-destructive');
        go.addEventListener('click', function () {
          var body = H.el('div');
          body.appendChild(H.el('div', 'ops-muted',
            'This is irreversible. The funds leave ' + p.from.name + ' immediately.'));
          // The confirm never shows the cosmetic name alone.
          body.appendChild(H.row('Asset', H.denomName(denom, reg, { style: 'both' })));
          body.appendChild(H.row('Amount', H.denomQty(p.amount, denom, reg)
            + ' (' + H.fmtInt(p.amount) + ' base units)'));
          body.appendChild(H.row('From', p.from.name + ' · ' + p.from.address));
          body.appendChild(H.row('To', (p.recipient || 'EXTERNAL') + ' · ' + p.to));
          H.confirmModal('Send ' + H.denomName(denom, reg, { style: 'both' }) + '?',
            body, 'Send', function () {
              out.innerHTML = '';
              out.appendChild(H.stateBlock('loading', 'signing…'));
              Board.T.core.invoke('mcp_transfer_execute', {
                from: invState.player, to: p.to, denom: denom, amount: p.amount,
              }).then(function () {
                out.innerHTML = '';
                out.appendChild(H.stateBlock('info', 'sent'));
                renderInventory();
              }).catch(function (e) {
                out.innerHTML = '';
                out.appendChild(H.stateBlock('error', String(e)));
              });
            });
        });
        out.appendChild(go);
      }).catch(function (e) {
        out.innerHTML = '';
        out.appendChild(H.stateBlock('error', String(e)));
      });
    });
    form.appendChild(check);

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
    // display value, in which case we say so with a ~ instead of implying an
    // exactness the row never carried.
    var qty = H.denomQty(r.amount_base, r.denom, reg);
    if (r.precise === false) qty = '~' + qty;
    return H.resultRow({
      icon: LEDGER_ICON[r.action] || (credit ? 'icon-incoming' : 'icon-outgoing'),
      title: (credit ? '+' : '−') + ' ' + qty,
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

      // Scope: primary by default, any player, or the team totals.
      var opts = [{ value: 'primary', label: 'primary' }];
      (armada.rows || []).forEach(function (r) {
        if (r.index == null) return;
        opts.push({ value: r.player_id, label: r.name + ' (' + r.player_id + ')' });
      });
      var head = H.el('div');
      head.appendChild(H.field('Player', H.selectBox(invState.player, opts, function (v) {
        invState.player = v; invState.page = 1; invState.history = null;
        renderInventory();
      })));
      var t = d.team || {};
      head.appendChild(H.resultRow({
        icon: 'icon-group',
        title: 'Team total',
        subtitle: t.players + ' player(s) in the roster cache',
        chips: [
          statTile('alpha', H.denomAmount(t.alpha_ualpha || 0, 'ualpha', d.denoms),
            'sui-icon-alpha-matter'),
          statTile('ore', H.fmtNum(t.ore || 0), 'sui-icon-alpha-ore'),
        ],
      }));
      body.appendChild(H.card('SCOPE', head));

      var abody = H.el('div');
      if (d.bank_error) abody.appendChild(H.stateBlock('error', 'bank read failed: ' + d.bank_error));
      var assets = d.assets || [];
      if (!assets.length) abody.appendChild(H.stateBlock('empty', 'no assets held'));
      assets.forEach(function (a) { abody.appendChild(assetRow(a)); });
      abody.appendChild(H.el('div', 'ops-muted',
        'Ore is shown for completeness only — it is not a bank asset and cannot be sent. '
        + 'It leaves a player by being refined into Alpha, or by being seized in battle.'));
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
        hbody.appendChild(H.el('div', 'ops-muted',
          'Page ' + invState.page + ' of the Guild ledger — durable and chain-authoritative, '
          + 'so it reaches back further than this app has been running. A ~ marks a row the '
          + 'ledger reports only in whole display units.'));
      }
      body.appendChild(H.card('HISTORY', hbody));
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
        var lbody = H.el('div');
        lh.slice().sort(function (a, b) {
          // Anything that needs attention first: blocked, then errors, then noise.
          var rank = function (l) { return l.blocked_reason ? 0 : ((l.errors || 0) > 0 ? 1 : 2); };
          return rank(a) - rank(b) || (b.runs || 0) - (a.runs || 0);
        }).forEach(function (l) {
          var blocked = !!l.blocked_reason;
          var last = l.last_finished_ms || l.last_started_ms;
          lbody.appendChild(H.resultRow({
            icon: blocked ? 'icon-blocked' : ((l.errors || 0) > 0 ? 'icon-alert' : 'icon-success'),
            title: l.loop,
            subtitle: blocked ? 'BLOCKED — ' + l.blocked_reason
              : ((l.unfinished_runs || 0) > 0
                ? (l.unfinished_runs + ' run(s) still in flight')
                : 'running normally'),
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

        var errs = (tx.top_errors || []).slice(0, 8);
        if (errs.length) {
          var xbody = H.el('div');
          errs.forEach(function (e2) {
            xbody.appendChild(H.row(String(e2.count) + '×', e2.reason.slice(0, 120), 'icon-alert'));
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
    if (r.seized_ore > 0) chips.push(statTile('ore taken', H.fmtNum(r.seized_ore), 'icon-alpha-ore'));
    chips.push(statTile('updated', H.duration((Date.now() - r.updated_ms) / 1000) + ' ago'));

    // Attacker → defender, naming whoever we could resolve.
    var sub = (r.attacker || 'unknown fleet owner') + ' → ' + (r.defender || 'unknown planet owner');
    if (r.fleet_id) sub += '  ·  fleet ' + r.fleet_id;

    var watch = iconBtn('icon-raid', 'Watch this raid', function (ev) {
      ev.stopPropagation();
      openRaidWindow({ planet_id: r.planet_id });
    });

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
    box.appendChild(H.row('ore seized', H.fmtNum(r.seized_ore || 0), 'icon-alpha-ore'));
    if (r.stale) {
      box.appendChild(H.stateBlock('warning',
        'No status change in over an hour. This is almost certainly an abandoned raid record rather than a running raid — the chain keeps non-terminal rows indefinitely.'));
    }
    var cta = H.el('div', 'cfg-row');
    var close;
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
  function openRaidWindow(opts) {
    raidNotice(null);
    return Board.T.core.invoke('mcp_raid_view_open', {
      planetId: opts.planet_id || null,
      fleetId: opts.fleet_id || null,
    }).catch(function (e) {
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
            ' older raid(s) are listed without attacker/defender names — identity lookups are capped per refresh.'));
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
      if (k === 'address' && String(ev.subject || '').indexOf(String(v)) >= 0) return;
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

    body.appendChild(H.card('RESPONSE SETTINGS', warEditor('response', resp, {
      note: 'A raid resolves in about four minutes, and every recorded defensive win fired back ' +
        'inside the first two — hence the short scan interval.',
    })));

    body.appendChild(H.card('TARGETING GATES', warEditor('raid', raid, {
      filter: function (k) { return !isWeight(k); },
      note: 'Of every raid on record, none that started against a non-vulnerable planet ever ' +
        'completed — and going anyway drops your own shields for the trip.',
    })));

    body.appendChild(H.card('SCORING WEIGHTS', warEditor('raid', raid, {
      filter: isWeight,
      note: 'How the 0-100 score is blended. Raising one weight lifts targets that are strong on ' +
        'it; the scale stays 0-100 either way, so min_score keeps meaning the same thing.',
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
    sweep: {
      label: 'auto_sweep', icon: 'icon-transfers', short: 'move Alpha to the primary as it accumulates',
      blurb: 'Sends a player\u2019s Alpha to the primary once it crosses a threshold, a few players '
        + 'per scan \u2014 the same eligibility as the Sweep All button, spread out so the whole '
        + 'roster is never queued at once.',
      chips: [
        { key: 'min_send_alpha', label: 'at', icon: 'sui-icon-alpha-matter' },
        { key: 'max_sends_per_scan', label: 'per scan' },
      ],
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
    posture: { label: 'posture', options: ['cautious', 'opportunist', 'aggressive'], hint: 'rewrites every gate in this card' },
    interval_secs: { label: 'scan every (s)', min: 5 },
    difficulty_threshold: { label: 'harvest at difficulty ≤', min: 1, max: 64 },
    complete_difficulty: { label: 'complete at difficulty ≤', min: 1, max: 64 },
    keep_grams: { label: 'Alpha reserve (g)', min: 0 },
    min_send_alpha: { label: 'sweep once a player holds (Alpha)', min: 0, step: 1,
      hint: 'measured AFTER the reserve below is set aside' },
    keep_reserve_alpha: { label: 'leave behind (Alpha)', min: 0, step: 1 },
    min_charge: { label: 'only if charge is at least', min: 0,
      hint: 'sending resets charge to 0, so a low bar steals charge from mining' },
    max_sends_per_scan: { label: 'max players per scan', min: 1,
      hint: 'the cap that stops this becoming the burst it replaces' },
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
  // opts (all optional):
  //   filter(key)  — render only the keys it accepts, so one config can be
  //                  split across several cards without forking the editor
  //   chrome:false — drop the loop blurb / cross-page pointer (already implied
  //                  by the page you're on)
  //   note         — a line of explanation appended under the fields
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
      if (meta.blurb) host.appendChild(H.el('div', 'ops-muted', meta.blurb));
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
    if (opts.note) host.appendChild(H.el('div', 'ops-muted', opts.note));
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
    // No local nav strip: these sections are routed (System/… and Armada/
    // Squads), so the area sub-nav above is the one place they're listed.
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
  Board.registerPage('config', {
    onEnter: function (params, view) {
      if (view) configState.section = view;
      return renderConfig();
    },
    refresh: renderConfig,
    cadenceMs: 60000,
  });

  // ═══════════════════════════ MAP ══════════════════════════════════════════
  // ═══════════════════════════ MAP ══════════════════════════════════════════
  // The roster list is filled on ENTER, not on boot. It used to be a one-shot
  // `onBoot` fetch whose failure was swallowed by `.catch(function(){})`, so a
  // transient error at page load (the web copy races the session cookie) left
  // the selector permanently holding its single placeholder and the page blank
  // forever — nothing retried it. Now every visit reconciles, and a failure is
  // visible instead of silent.
  // `mcp_render_map` round-trips to the GAME's own canvas renderer to draw a
  // 2304x3328 planet image — measured at ~11s, and the backend allows up to 90.
  // That is inherent, so the page is built around the wait rather than
  // pretending it isn't there: say how long it takes, keep the last image for
  // each player, and show it immediately while a fresh one renders behind it.
  var mapState = { wired: false, loaded: false, current: '', cache: {} };

  function mapBox() { return document.getElementById('vp-map'); }

  function renderMapFor(playerId) {
    var box = mapBox();
    if (!box) return;
    if (!playerId) { box.innerHTML = ''; return; }
    mapState.current = playerId;
    box.innerHTML = '';

    // Stale-while-revalidate: a previously rendered map for this player appears
    // instantly. Without it, switching players blanked the panel for ~11s.
    var cached = mapState.cache[playerId];
    if (cached) {
      var old = new Image();
      old.alt = 'planet map for ' + playerId + ' (refreshing)';
      old.src = cached;
      box.appendChild(old);
    }
    var note = H.stateBlock('loading',
      cached ? 'refreshing map… (about 10 seconds)' : 'rendering map… (about 10 seconds)');
    box.appendChild(note);

    Board.T.core.invoke('mcp_render_map', { player: playerId }).then(function (durl) {
      // Cache on ARRIVAL, not on decode: we have the bytes either way, and
      // hanging the cache off `img.onload` meant a slow or failed decode threw
      // away a perfectly good render.
      mapState.cache[playerId] = durl;
      if (mapState.current !== playerId) return;   // a newer selection won
      var img = new Image();
      img.alt = 'planet map for ' + playerId;
      img.onload = function () {
        if (mapState.current !== playerId) return;
        box.innerHTML = '';
        box.appendChild(img);
      };
      img.onerror = function () {
        if (mapState.current !== playerId) return;
        box.innerHTML = '';
        box.appendChild(H.stateBlock('error', 'map image failed to load'));
      };
      img.src = durl;
    }).catch(function (err) {
      if (mapState.current !== playerId) return;
      box.innerHTML = '';
      // Keep whatever we had rather than throwing it away on a failed refresh.
      if (mapState.cache[playerId]) {
        var keep = new Image();
        keep.alt = 'planet map for ' + playerId + ' (stale)';
        keep.src = mapState.cache[playerId];
        box.appendChild(keep);
      }
      box.appendChild(H.stateBlock('error', 'render failed: ' + err));
    });
  }

  function loadMapRoster() {
    var sel = document.getElementById('vp-select');
    if (!sel) return Promise.resolve();
    return Board.T.core.invoke('mcp_vplayer_list').then(function (list) {
      var players = (list || []).filter(function (p) { return p.player_id; });
      // Rebuild wholesale so a retry after a partial failure can't duplicate.
      sel.innerHTML = '';
      var head = H.el('option', null,
        players.length ? '— select a player —' : '— no players —');
      head.value = '';
      sel.appendChild(head);
      players.forEach(function (p) {
        var o = H.el('option', null, p.name + ' (' + p.player_id + ')');
        o.value = p.player_id;
        sel.appendChild(o);
      });
      mapState.loaded = players.length > 0;
      if (mapState.current) sel.value = mapState.current;
    }).catch(function (err) {
      mapState.loaded = false;
      var box = mapBox();
      if (box && !box.firstChild) {
        box.appendChild(H.stateBlock('error', 'player list unavailable: ' + err));
      }
    });
  }

  Board.registerPage('map', {
    onEnter: function (params) {
      var sel = document.getElementById('vp-select');
      if (sel && !mapState.wired) {
        mapState.wired = true;
        sel.addEventListener('change', function () { renderMapFor(sel.value); });
        // Deep link from elsewhere on the board (#/armada/map?p=2-459).
        Board.mapShow = function (playerId) {
          mapState.current = playerId;
          var s = document.getElementById('vp-select');
          if (s) s.value = playerId;
          renderMapFor(playerId);
        };
      }
      var want = (params && params.p) || null;
      // Retry the roster on every visit until it actually lands.
      var ready = mapState.loaded ? Promise.resolve() : loadMapRoster();
      return ready.then(function () {
        if (want) Board.mapShow(want);
      });
    },
  });

})();
