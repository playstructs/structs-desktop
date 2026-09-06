// STRUCTS TERMINAL — the operations cards.
//
// The same data Team Ops shows, one concern per card, drawn for a column
// instead of a page: hashing (the proof queue, solve rates, the tasks),
// signing (the queue, the results), power (guild grid, reactor fuel,
// allocations), the fleet roster, raids, war (posture, targets, grudges,
// vetoes, incidents), a wallet and the system's health. Every card reads the
// command the page reads and acts through the command the page acts
// through — nothing here is a second copy of a page.
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };
  var add = function (type, params, w) { return T.add(type, params, w); };
  var PC = function () { return window.StructsPlayerCard; };
  var tiles = function (list) {
    var strip = H.el('div', 'hstrip tm-tiles');
    list.forEach(function (t) { strip.appendChild(H.statTile(t[0], t[1], t[2] || null, t[3] || null)); });
    return strip;
  };
  var cap = function (host, text) { var c = H.el('div', 'tm-cap'); c.appendChild(H.el('span', 'fstat-l', text)); host.appendChild(c); return c; };
  var pct = function (v) { var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v)); return isNaN(n) ? 0 : n; };
  var doorRow = function (items) {
    var row = H.el('div', 'tm-doors-row');
    items.forEach(function (it) {
      var a = H.el('a', 'sui-screen-btn ' + (it.primary ? 'sui-mod-primary' : 'sui-mod-secondary'), it.label);
      a.href = 'javascript:void(0)';
      a.addEventListener('click', function () { it.onClick(a); });
      row.appendChild(a);
    });
    return row;
  };
  /* Row-end action doors for H.resultRow, which takes ONE node. */
  var acts = function (list) {
    var span = H.el('span', 'tx-btns');
    list.forEach(function (it) {
      var a = H.el('a', 'ops-refresh-btn'); a.href = 'javascript:void(0)'; a.title = it.title;
      a.appendChild(H.el('i', it.icon));
      a.addEventListener('click', function (ev) { ev.stopPropagation(); it.onClick(); });
      span.appendChild(a);
    });
    return span;
  };
  var human = function (s) { return String(s || '?').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(); };
  var fail = function (host, what, e) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', what + ' unavailable: ' + e)); };

  // ── Hashing (mcp_work) ───────────────────────────────────────────────────
  var TASK_ICON = { MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-in-progress', RAID: 'icon-raid' };
  T.register('pow', {
    label: 'Proof queue', describe: function () { return 'Proof queue'; }, cadenceMs: 5000,
    render: function (host) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var c = d.counts || {}, hc = d.hash_config || {};
        host.appendChild(tiles([
          ['running', H.fmtInt(c.running || 0), null, c.running ? 'live' : 'muted'],
          ['waiting', H.fmtInt(c.waiting || 0), null, (c.waiting || 0) > (hc.max_concurrent || 0) * 4 ? 'bad' : null],
          ['done', H.fmtInt(c.completed || 0), null, 'muted'],
        ]));
        host.appendChild(H.row('Engine', (hc.effective_engine || '?') + (hc.gpu_available ? ' · GPU' : ''), 'icon-computer'));
        host.appendChild(H.row('Start difficulty', (hc.difficulty_start == null ? '—' : hc.difficulty_start + ' of 64') + (hc.auto_tune ? ' · auto-tuned' : '')));
        host.appendChild(H.row('Concurrent proofs', hc.max_concurrent == null ? '—' : String(hc.max_concurrent)));
        if (d.error) host.appendChild(H.alertLine(String(d.error), 'icon-alert'));
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });
  T.register('solve', {
    label: 'Solve rate', describe: function () { return 'Solve rate · 24h'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var pow = d.pow_stats;
        if (pow && pow.error) { host.appendChild(H.stateBlock('error', 'solve stats unavailable: ' + pow.error)); return; }
        var engines = (Array.isArray(pow) ? pow : []).slice().sort(function (a, b) { return (b.solves || 0) - (a.solves || 0); });
        if (!engines.length) { host.appendChild(H.stateBlock('info', 'No solves in the last 24h.')); return; }
        engines.forEach(function (e) {
          var few = e.p90_duration_ms == null;
          host.appendChild(H.resultRow({
            icon: 'icon-computer', title: String(e.engine || '?').toUpperCase(), subtitle: H.fmtInt(e.solves) + ' solves',
            chips: [
              H.statTile('median', H.duration((e.median_duration_ms || 0) / 1000)),
              H.statTile('p90', few ? 'n<' + (e.p90_min_samples || 10) : H.duration(e.p90_duration_ms / 1000), null, few ? 'muted' : ''),
              H.statTile('difficulty', e.median_difficulty == null ? '—' : String(e.median_difficulty)),
              H.statTile('hashrate', e.est_hashrate_hps == null ? '—' : H.fmtNum(e.est_hashrate_hps) + 'H/s', null, e.est_hashrate_hps == null ? 'muted' : ''),
            ],
          }));
        });
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });
  T.register('tasks', {
    label: 'Proof tasks', defaultWidth: 2,
    describe: function (p) { return 'Proof tasks' + (p.type ? ' · ' + p.type : '') + (p.status ? ' · ' + p.status : ''); },
    params: [
      { key: 'type', label: 'Type', kind: 'choice', options: [{ value: '', label: 'all types' }, { value: 'MINE', label: 'Mine' }, { value: 'REFINE', label: 'Refine' }, { value: 'BUILD', label: 'Build' }, { value: 'RAID', label: 'Raid' }] },
      { key: 'status', label: 'Status', kind: 'choice', options: [{ value: '', label: 'any status' }, { value: 'running', label: 'running' }, { value: 'waiting', label: 'waiting' }, { value: 'completed', label: 'completed' }] },
    ],
    cadenceMs: 5000,
    render: function (host, p) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var rows = (d.tasks || []).filter(function (t) {
          if (p.type && t.task_type !== p.type) return false;
          if (p.status && String(t.status) !== p.status) return false;
          return true;
        });
        // Running first (most advanced at the top), then waiting, then done.
        var ORDER = { running: 0, waiting: 1, completed: 2 };
        rows.sort(function (a, b) {
          var sa = ORDER[a.status] == null ? 1 : ORDER[a.status], sb = ORDER[b.status] == null ? 1 : ORDER[b.status];
          return sa !== sb ? sa - sb : pct(b.percent_complete) - pct(a.percent_complete);
        });
        cap(host, rows.length + ' task' + (rows.length === 1 ? '' : 's') + (rows.length > 25 ? ' · showing 25' : ''));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'Nothing in the queue.')); return; }
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (t) {
          var dd = t.current_difficulty;
          table.appendChild(H.resultRow({
            icon: TASK_ICON[t.task_type] || 'icon-in-progress', title: t.task_id || '?', subtitle: (t.task_type || '?') + ' · ' + (t.status || '?'),
            chips: [
              H.resource(H.progressBar(pct(t.percent_complete) / 100)),
              H.statTile('difficulty', dd == null ? '—' : dd + '/64', null, dd == null ? 'muted' : (dd <= 16 ? 'ok' : (dd <= 32 ? 'live' : 'bad'))),
              H.statTile('eta', t.eta || '—', null, 'muted'),
            ],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });

  // ── Signing (mcp_tx_snapshot / mcp_tx_mutate) ────────────────────────────
  function txLine(t, pos, total, etas, percents, onMutate) {
    var r = H.el('div', 'sui-data-card-row tm-tx');
    var left = H.el('span');
    if (pos != null) left.appendChild(H.el('span', 'tx-pos', pos + '.'));
    left.appendChild(document.createTextNode(' ' + (t.type_short || t.type_url || '?')));
    if (t.charge_cost > 0) { left.appendChild(H.el('span', 'ops-muted', ' charge ' + t.charge_cost)); }
    if (t.attempts > 0) left.appendChild(H.el('span', 'attn', ' try ' + t.attempts + (t.retry_limit > 0 ? '/' + t.retry_limit : '')));
    var right = H.el('span', 'ops-val');
    var eta = etas && etas[t.id];
    if (eta && eta.blocksRemaining != null) right.appendChild(H.el('span', 'ops-muted', eta.blocksRemaining + ' blk · ~' + Math.max(0, Math.round((eta.etaMs || 0) / 1000)) + 's '));
    if (percents && percents[t.id] != null) { var bar = H.progressBar((percents[t.id] || 0) / 100); bar.classList.add('tm-tx-bar'); right.appendChild(bar); }
    if (onMutate) {
      var btns = H.el('span', 'tx-btns');
      var ctl = function (icon, title, op, hidden) {
        if (hidden) return;
        var a = H.el('a', 'ops-refresh-btn'); a.href = 'javascript:void(0)'; a.title = title;
        a.appendChild(H.el('i', icon));
        a.addEventListener('click', function (ev) { ev.stopPropagation(); onMutate(op, t.id); });
        btns.appendChild(a);
      };
      if (pos != null) { ctl('icon-caret-up', 'Move up', 'move_up', pos === 1); ctl('icon-caret-down', 'Move down', 'move_down', pos === total); }
      ctl('icon-close', 'Cancel', 'cancel', false);
      right.appendChild(btns);
    }
    r.appendChild(left); r.appendChild(right);
    return r;
  }
  T.register('queue', {
    label: 'Signing queue', describe: function () { return 'Signing queue'; }, cadenceMs: 2500,
    render: function (host, p, ctx) {
      return invoke('mcp_tx_snapshot').then(function (d) {
        host.innerHTML = '';
        var q = d && d.queue;
        if (!q) { host.appendChild(H.alertLine('signing queue unavailable — sign in on the game window' + (d && d.queue_error ? ' (' + d.queue_error + ')' : ''), 'icon-alert')); return; }
        var aq = q.action_queue || [], iq = q.immediate_queue || [];
        host.appendChild(tiles([
          ['in flight', q.in_flight ? '1' : '0', null, q.in_flight ? 'live' : 'muted'],
          ['queued', H.fmtInt(aq.length), null, aq.length ? null : 'muted'],
          ['immediate', H.fmtInt(iq.length), null, iq.length ? 'live' : 'muted'],
        ]));
        var mutate = function (op, id) {
          invoke('mcp_tx_mutate', { op: op, id: id, newIndex: null }).then(function (r) {
            if (r && r.ok === false) Board.stamp && Board.stamp('refused — item is in flight or already gone');
            T.refresh(ctx.id, true);
          }).catch(function (e) { Board.stamp && Board.stamp('tx: ' + e); });
        };
        if (q.in_flight) host.appendChild(txLine(q.in_flight, null, 0, null, null, null));
        iq.forEach(function (t) { host.appendChild(txLine(t, null, 0, null, null, mutate)); });
        aq.forEach(function (t, i) { host.appendChild(txLine(t, i + 1, aq.length, q.etas, q.percents, mutate)); });
        if (!q.in_flight && !aq.length && !iq.length) host.appendChild(H.el('div', 'ops-muted', 'nothing waiting to sign'));
      }).catch(function (e) { fail(host, 'tx', e); });
    },
  });
  T.register('results', {
    label: 'Tx results',
    describe: function (p) { return 'Tx results' + (p.outcome ? ' · ' + p.outcome : ''); },
    params: [{ key: 'outcome', label: 'Outcome', kind: 'choice', options: [{ value: '', label: 'all' }, { value: 'success', label: 'success' }, { value: 'failed', label: 'failed' }, { value: 'skipped', label: 'skipped' }] }],
    cadenceMs: 10000,
    render: function (host, p) {
      return invoke('mcp_tx_snapshot').then(function (d) {
        host.innerHTML = '';
        if (d && d.history_error) { host.appendChild(H.stateBlock('error', 'history unavailable: ' + d.history_error)); return; }
        var hist = (d && d.history) || [];
        var n = { success: 0, failed: 0, skipped: 0 };
        hist.forEach(function (h) { if (n[h.outcome] != null) n[h.outcome]++; else n.failed++; });
        host.appendChild(tiles([
          ['ok', H.fmtInt(n.success), null, 'ok'],
          ['failed', H.fmtInt(n.failed), null, n.failed ? 'bad' : 'muted'],
          ['skipped', H.fmtInt(n.skipped), null, 'muted'],
        ]));
        var rows = hist.filter(function (h) { return !p.outcome || (p.outcome === 'failed' ? (h.outcome !== 'success' && h.outcome !== 'skipped') : h.outcome === p.outcome); });
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No recent transactions.')); return; }
        rows.slice(0, 25).forEach(function (h) {
          var r = H.el('div', 'sui-data-card-row tm-tx');
          var left = H.el('span');
          var ok = h.outcome === 'success';
          left.appendChild(H.badge(String(h.outcome || '?').replace('_', ' ').toUpperCase(), ok ? 'default' : h.outcome === 'skipped' ? 'warning' : 'destructive'));
          left.appendChild(document.createTextNode(' ' + String(h.action || '').replace(/^.*Msg/, '') + ' · ' + (h.player_id || h.context || '?')));
          var note = ok ? (h.tx_hash ? String(h.tx_hash).slice(0, 10) + '…' : 'ok')
            : String(h.translated || h.raw_error || '').replace(/^failed to execute message; message index: \d+: /, '').slice(0, 120);
          var right = H.el('span', 'ops-val');
          right.appendChild(H.el('span', ok ? 'ops-muted' : 'attn', note + ' · ' + H.ago(h.ts_ms)));
          r.appendChild(left); r.appendChild(right);
          host.appendChild(r);
        });
      }).catch(function (e) { fail(host, 'tx', e); });
    },
  });

  // ── Power (mcp_energy / mcp_infusions / mcp_allocations) ─────────────────
  T.register('grid', {
    label: 'Guild power', describe: function () { return 'Guild power'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_energy').then(function (d) {
        host.innerHTML = '';
        var g = (d && d.guild) || {};
        var sub = H.scaleSet([g.sub_capacity_mw, g.sub_load_mw], 'power');
        host.appendChild(tiles([
          ['capacity', sub.fmt(g.sub_capacity_mw || 0), 'sui-icon-energy'],
          ['load', sub.fmt(g.sub_load_mw || 0), null, (g.sub_load_mw || 0) > (g.sub_capacity_mw || 0) * 0.9 ? 'bad' : null],
          ['connections', H.fmtInt(g.sub_connection_count || 0)],
        ]));
        host.appendChild(H.row('Per connection', H.fmtWatts(g.sub_connection_capacity_mw || 0) + ' → ' + H.fmtWatts(g.share_if_one_more_mw || 0) + ' with one more'));
        host.appendChild(H.row('Reactor fuel', H.fmtWatts(g.reactor_fuel_mw || 0) + ' · ' + Math.round((g.reactor_commission || 0) * 100) + '% commission'));
        host.appendChild(H.row('Headroom', '~' + H.fmtInt(g.supportable_more || 0) + ' more players', (g.supportable_more || 0) > 0 ? 'icon-success' : 'icon-alert'));
      }).catch(function (e) { fail(host, 'energy', e); });
    },
  });
  T.register('fuel', {
    label: 'Reactor fuel', describe: function () { return 'Reactor fuel'; }, cadenceMs: 60000,
    render: function (host) {
      return invoke('mcp_infusions').then(function (d) {
        host.innerHTML = '';
        if (d && d._err) { host.appendChild(H.stateBlock('error', 'infusions unavailable: ' + d._err)); return; }
        var t = (d && d.totals) || {};
        host.appendChild(tiles([
          ['staked', H.fmtAlpha(t.fuel_ualpha || 0), 'sui-icon-alpha-matter', 'ok'],
          ['capacity made', H.fmtWatts(t.capacity_mw || 0), 'sui-icon-energy', 'ok'],
          ['commission', H.fmtWatts(t.commission_mw || 0), null, 'muted'],
        ]));
        host.appendChild(tiles([
          ['defusing', H.fmtAlpha(t.defusing_ualpha || 0), null, (t.defusing_ualpha || 0) > 0 ? 'live' : 'muted'],
          ['earning nothing', H.fmtAlpha(t.dead_fuel_ualpha || 0), null, (t.dead_fuel_ualpha || 0) > 0 ? 'bad' : 'muted'],
          ['reactors', H.fmtInt(((d && d.reactors) || []).length)],
        ]));
        var ai = d && d.auto_infuse;
        host.appendChild(H.row('Auto infuse', ai && ai.enabled ? 'ON · keeps ' + H.fmtInt(ai.keep_grams) + 'g · every ' + H.duration(ai.interval_secs) : 'off', ai && ai.enabled ? 'icon-success' : 'icon-blocked'));
        var pend = ((d && d.pending) || []).length, migs = ((d && d.migrations) || []).length;
        if (pend || migs) host.appendChild(H.alertLine(pend + ' in flight · ' + migs + ' migrating', 'icon-in-progress'));
      }).catch(function (e) { fail(host, 'infusions', e); });
    },
  });
  T.register('allocations', {
    label: 'Allocations', describe: function () { return 'Allocations'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_allocations').then(function (d) {
        host.innerHTML = '';
        if (d && d._err) { host.appendChild(H.stateBlock('error', 'allocations unavailable: ' + d._err)); return; }
        var b = (d && d.budget) || {}, rows = (d && d.allocations) || [];
        host.appendChild(tiles([
          ['allocatable', H.fmtWatts(b.allocatable_mw || 0), 'sui-icon-energy'],
          ['available', H.fmtWatts(b.available_mw || 0), null, (b.available_mw || 0) <= 0 ? 'bad' : 'ok'],
          ['allocations', H.fmtInt(rows.length)],
        ]));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No allocations.')); return; }
        rows.forEach(function (a) {
          host.appendChild(H.row((a.type || 'allocation') + ' ' + a.id + ' → ' + (a.destination_id || '?'), H.fmtWatts(a.power_mw || 0) + (a.locked ? ' · locked' : ''), a.locked ? 'icon-key' : 'sui-icon-energy'));
        });
      }).catch(function (e) { fail(host, 'allocations', e); });
    },
  });

  // ── The fleet (mcp_roster / mcp_mass_action) ─────────────────────────────
  var ROLE_OPTS = [{ value: '', label: 'every role' }, { value: 'primary', label: 'primary' }, { value: 'productive', label: 'productive' }, { value: 'raider', label: 'raider' }, { value: 'bait', label: 'bait' }];
  var SORT_OPTS = [{ value: 'alpha', label: 'by Alpha' }, { value: 'ore', label: 'by ore' }, { value: 'charge', label: 'by charge' }, { value: 'stale', label: 'stalest read' }];
  T.register('fleet', {
    label: 'Fleet roster', defaultWidth: 2,
    describe: function (p) { return 'Fleet' + (p.role ? ' · ' + p.role : '') + (p.sort ? ' · ' + p.sort : ''); },
    params: [{ key: 'role', label: 'Role', kind: 'choice', options: ROLE_OPTS }, { key: 'sort', label: 'Order', kind: 'choice', options: SORT_OPTS }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_roster', { refreshIfOlderMs: 120000 }).then(function (snap) {
        host.innerHTML = '';
        var rows = ((snap && snap.rows) || []).filter(function (r) { return !p.role || r.role === p.role; });
        var key = p.sort || 'alpha';
        rows.sort(function (a, b) {
          if (key === 'stale') return (a.fetched_at_ms || 0) - (b.fetched_at_ms || 0);
          if (key === 'charge') return (b.charge || 0) - (a.charge || 0);
          if (key === 'ore') return (b.ore || 0) - (a.ore || 0);
          return (b.alpha_ualpha || 0) - (a.alpha_ualpha || 0);
        });
        var total = rows.reduce(function (s, r) { return s + (r.alpha_ualpha || 0); }, 0);
        var ore = rows.reduce(function (s, r) { return s + (r.ore || 0); }, 0);
        host.appendChild(tiles([
          ['players', H.fmtInt(rows.length)],
          ['alpha', H.fmtAlpha(total), 'sui-icon-alpha-matter'],
          ['ore', H.fmtOre(ore), 'sui-icon-alpha-ore'],
          ['roster age', snap && snap.refreshed_at_ms ? H.ago(snap.refreshed_at_ms) : '—', null, 'muted'],
        ]));
        // Sweep: the first click is a dry run that prices the click; the
        // second click executes exactly what the first one said.
        var sweep = { armed: false };
        host.appendChild(doorRow([
          { label: 'Sweep Alpha', primary: true, onClick: function (a) {
            if (!sweep.armed) {
              invoke('mcp_mass_action', { request: { action: 'sweep_alpha', mode: 'dry_run' } }).then(function (r) {
                var n = (r && r.entries || []).length;
                if (!n) { a.textContent = 'Nothing to sweep'; return; }
                a.textContent = 'Confirm sweep of ' + n + ' ~' + H.fmtAlpha(Number(r.total_alpha || 0) * 1e6);
                sweep.armed = true;
              }).catch(function (e) { a.textContent = 'Sweep: ' + e; });
            } else {
              invoke('mcp_mass_action', { request: { action: 'sweep_alpha', mode: 'execute' } }).then(function () { a.textContent = 'Sweeping…'; sweep.armed = false; }).catch(function (e) { a.textContent = 'Sweep: ' + e; });
            }
          } },
          { label: 'Refresh roster', onClick: function (a) { invoke('mcp_roster_refresh').then(function () { a.textContent = 'Sweeping roster…'; }); } },
        ]));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No roster yet.')); return; }
        var table = H.resultTable();
        rows.slice(0, 30).forEach(function (r) {
          var stale = r.err || (Date.now() - (r.fetched_at_ms || 0) > 2 * 3600 * 1000);
          table.appendChild(PC().row({
            id: r.player_id, name: r.name || r.player_id, pfp: r.pfp_attrs, sub: r.role || null, err: !!r.err,
            attn: r.err ? 'read failed' : (stale ? 'read ' + H.ago(r.fetched_at_ms) + ' ago' : null),
            readings: [
              { value: H.fmtAlpha(r.alpha_ualpha || 0), icon: 'sui-icon-alpha-matter', title: 'Alpha' },
              { value: H.fmtOre(r.ore || 0), icon: 'sui-icon-alpha-ore', title: 'Ore' },
              { value: r.charge == null ? '—' : String(r.charge) + '/8', icon: 'sui-icon-value', title: 'Charge' },
            ],
          }, { actions: (Board.watchActions ? Board.watchActions(r) : []).concat([{ icon: 'icon-member', title: 'Watch this player', onClick: function () { add('player', { id: r.player_id }); } }]) }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'roster', e); });
    },
  });

  // ── Raids (mcp_raids) ────────────────────────────────────────────────────
  T.register('raids', {
    label: 'Raids',
    describe: function (p) { return 'Raids' + (p.scope ? ' · ' + p.scope : ''); },
    params: [{ key: 'scope', label: 'Show', kind: 'choice', options: [{ value: '', label: 'all tracked' }, { value: 'live', label: 'live now' }, { value: 'ours', label: 'involving us' }] }],
    cadenceMs: 10000,
    render: function (host, p) {
      return invoke('mcp_raids').then(function (d) {
        host.innerHTML = '';
        var all = (d && d.raids) || [];
        host.appendChild(tiles([
          ['live now', H.fmtInt(d.live || 0), 'icon-raid', d.live ? 'live' : 'muted'],
          ['involving us', H.fmtInt(d.ours || 0), null, d.ours ? 'bad' : 'muted'],
          ['tracked', H.fmtInt(all.length)],
        ]));
        var rows = all.filter(function (r) {
          if (p.scope === 'live') return r.live;
          if (p.scope === 'ours') return r.our_side && r.our_side !== 'none';
          return true;
        });
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No raids to show.')); return; }
        rows.slice(0, 25).forEach(function (r) {
          host.appendChild(H.resultRow({
            icon: r.live ? 'icon-raid' : 'icon-combat-log',
            title: 'planet ' + r.planet_id,
            subtitle: (r.attacker || 'unknown fleet owner') + ' → ' + (r.defender || 'unknown planet owner') + (r.fleet_id ? ' · fleet ' + r.fleet_id : ''),
            chips: [
              H.statTile('status', human(r.status), null, r.live ? 'live' : 'muted'),
              H.statTile('seized', H.fmtOre(r.seized_ore || 0), 'sui-icon-alpha-ore'),
              H.statTile('updated', H.ago(r.updated_ms), null, 'muted'),
            ],
            onClick: function () { add('planet', { id: r.planet_id }); },
          }));
        });
      }).catch(function (e) { fail(host, 'raids', e); });
    },
  });

  // ── War (mcp_war_bundle / mcp_config_set) ────────────────────────────────
  function warSet(payload, ctx) {
    return invoke('mcp_config_set', { domain: 'combat_lists', payload: payload }).then(function () { T.refresh(ctx.id, true); }).catch(function (e) { Board.stamp && Board.stamp('war: ' + e); });
  }
  function loopToggle(which, cfg, ctx) {
    var next = Object.assign({}, cfg, { enabled: !cfg.enabled });
    return invoke('mcp_config_set', { domain: 'loop', payload: { loop: which, config: next } }).then(function () { T.refresh(ctx.id, true); }).catch(function (e) { Board.stamp && Board.stamp('loop: ' + e); });
  }
  T.register('posture', {
    label: 'War posture', describe: function () { return 'War posture'; }, cadenceMs: 15000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var resp = d.response || {}, raid = d.raid || {}, sb = d.shot_budget || {};
        host.appendChild(H.row('Response', (resp.enabled ? 'ON' : 'off') + ' · ' + (resp.autonomy || '?') + (resp.dry_run ? ' · DRY RUN' : ''), resp.enabled ? 'icon-counter' : 'icon-blocked'));
        host.appendChild(H.row('Raiding', (raid.enabled ? 'ON' : 'off') + ' · ' + (raid.autonomy || '?') + ' · ' + (raid.posture || '?') + (raid.dry_run ? ' · DRY RUN' : ''), raid.enabled ? 'icon-raid' : 'icon-blocked'));
        host.appendChild(H.row('Shot budget', H.fmtInt(sb.used || 0) + ' of ' + H.fmtInt(sb.cap || 0) + ' this window', 'icon-dmg'));
        host.appendChild(doorRow([
          { label: resp.enabled ? 'Response off' : 'Response on', primary: !resp.enabled, onClick: function () { loopToggle('response', resp, ctx); } },
          { label: raid.enabled ? 'Raiding off' : 'Raiding on', primary: !raid.enabled, onClick: function () { loopToggle('raid', raid, ctx); } },
        ]));
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('targets', {
    label: 'Target board', defaultWidth: 2, describe: function () { return 'Target board'; }, cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var raid = d.raid || {}, targets = d.targets || [];
        var go = targets.filter(function (t) { return !t.blocked_by; }).length;
        cap(host, targets.length + ' scored · ' + go + ' GO' + (raid.enabled ? '' : ' · raiding is off'));
        if (!targets.length) { host.appendChild(H.stateBlock('info', 'No targets scored yet.')); return; }
        var table = H.resultTable();
        targets.slice(0, 20).forEach(function (t) {
          var ok = !t.blocked_by;
          table.appendChild(H.resultRow({
            icon: ok ? 'icon-raid' : 'icon-blocked',
            title: (t.name || t.player_id) + '  ' + (t.planet_id || ''),
            subtitle: ok ? 'GO — ' + (t.vulnerability_reason || '') : 'NO-GO — ' + t.blocked_by,
            chips: [
              H.statTile('ore', H.fmtOre(t.stored_ore || 0), 'sui-icon-alpha-ore', (t.stored_ore || 0) >= (raid.min_ore || 0) ? '' : 'bad'),
              H.statTile('shield · proof', (t.planetary_shield || 0) + ' · ~' + Math.round(t.raid_minutes || 0) + 'm'),
              H.statTile('defenders', String(t.defenders_on_cmd == null ? '—' : t.defenders_on_cmd), 'icon-defend', 'muted'),
              H.statTile('score', String(Math.round(t.score || 0)), null, ok ? 'ok' : 'bad'),
            ],
            action: acts([
              { icon: 'icon-planet', title: 'Open planet ' + t.planet_id, onClick: function () { add('planet', { id: t.planet_id }); } },
              { icon: 'icon-attention', title: 'Add ' + t.player_id + ' to the grudge list', onClick: function () { warSet({ action: 'add', kind: 'grudge', id: t.player_id, label: t.name, guild_id: t.guild_id, weight: 1.5 }, ctx); } },
              { icon: 'icon-blocked', title: 'Never attack ' + t.player_id, onClick: function () { warSet({ action: 'add', kind: 'protected', id: t.player_id }, ctx); } },
            ]),
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('grudges', {
    label: 'Grudges', describe: function () { return 'Grudges'; }, cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var grudges = ((d.lists || {}).grudges) || [];
        if (!grudges.length) { host.appendChild(H.stateBlock('info', 'No grudges held.')); return; }
        var table = H.resultTable();
        grudges.forEach(function (g) {
          table.appendChild(H.resultRow({
            icon: g.muted ? 'icon-unknown' : 'icon-enemy-tile',
            title: (g.label || g.player_id) + (g.guild_id ? '  [' + g.guild_id + ']' : ''),
            subtitle: (g.attacks || 0) + ' attacks · ' + (g.structs_lost || 0) + ' structs lost · ' + (g.source || '') + (g.muted ? ' · MUTED' : '') + (g.expired ? ' · lapsed' : ''),
            chips: [H.resource(g.damage_taken || 0, 'icon-dmg'), H.resource('×' + (Math.round((g.weight || 1) * 10) / 10), null), H.resource(Math.round((g.heat || 0) * 100) / 100, 'icon-attention', g.muted ? 'attn' : '')],
            action: acts([
              { icon: g.muted ? 'icon-okay' : 'icon-blocked', title: g.muted ? 'Unmute' : 'Mute — keep the record, stop acting on it', onClick: function () { warSet({ action: g.muted ? 'unmute' : 'mute', kind: 'grudge', id: g.player_id }, ctx); } },
              { icon: 'icon-subtract', title: 'Forget this grudge', onClick: function () { warSet({ action: 'remove', kind: 'grudge', id: g.player_id }, ctx); } },
            ]),
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('vetoes', {
    label: 'Never attack', describe: function () { return 'Never attack'; }, cadenceMs: 60000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var l = d.lists || {};
        var prot = l.protected_players || [], allies = l.allies || [], prio = l.priority_guilds || [];
        host.appendChild(tiles([['protected', H.fmtInt(prot.length)], ['ally guilds', H.fmtInt(allies.length)], ['priority guilds', H.fmtInt(prio.length)]]));
        var line = function (icon, text, kind, id) {
          var r = H.el('div', 'sui-data-card-row tm-tx');
          var left = H.el('span'); left.appendChild(H.el('i', H.iconClass(icon, 'sui-icon-sm'))); left.appendChild(document.createTextNode(' ' + text));
          var right = H.el('span', 'ops-val');
          var a = H.el('a', 'ops-refresh-btn'); a.href = 'javascript:void(0)'; a.title = 'Remove ' + id; a.appendChild(H.el('i', 'icon-subtract'));
          a.addEventListener('click', function () { warSet({ action: 'remove', kind: kind, id: id }, ctx); });
          right.appendChild(a); r.appendChild(left); r.appendChild(right);
          return r;
        };
        prot.forEach(function (pid) { host.appendChild(line('icon-blocked', 'player ' + pid, 'protected', pid)); });
        allies.forEach(function (gid) { host.appendChild(line('icon-guild', 'ally guild ' + gid, 'ally', gid)); });
        prio.forEach(function (g) { host.appendChild(line('icon-attention', 'priority guild ' + g.guild_id + ' ×' + g.weight, 'priority_guild', g.guild_id)); });
        if (!prot.length && !allies.length && !prio.length) host.appendChild(H.stateBlock('info', 'No vetoes or priorities set.'));
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('incidents', {
    label: 'Incidents', defaultWidth: 2, describe: function () { return 'Incidents'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var inc = d.incidents || [];
        if (!inc.length) { host.appendChild(H.stateBlock('info', 'No incidents recorded.')); return; }
        var table = H.resultTable();
        inc.slice(0, 20).forEach(function (i) {
          table.appendChild(H.resultRow({
            icon: i.shots_fired > 0 ? 'icon-counter' : 'icon-incoming',
            title: (i.defender_player || '?') + ' @ ' + i.planet_id + (i.attacker_player ? '  ← ' + i.attacker_player : ''),
            subtitle: (i.mode || '') + ' · ' + (i.fire_target ? 'fired at ' + i.fire_target + ' (' + i.target_kind + ')' : (i.note || '')),
            chips: [H.resource((i.shots_fired || 0) + '/' + (i.shots_planned || 0), 'icon-dmg'), H.resource(Math.round((i.projected_damage || 0) * 10) / 10, 'icon-ballistic-weapon'), H.resource(H.ago(i.at_ms), null)],
            onClick: function () { add('planet', { id: i.planet_id }); },
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });

  // ── Wallet (mcp_inventory) ───────────────────────────────────────────────
  T.register('wallet', {
    label: 'Wallet', describe: function (p) { return 'Wallet · ' + (p.id || 'primary'); },
    params: [{ key: 'id', label: 'Player', kind: 'id', placeholder: 'primary' }],
    cadenceMs: 30000,
    render: function (host, p) {
      return invoke('mcp_inventory', { player: p.id || 'primary' }).then(function (d) {
        host.innerHTML = '';
        var who = (d && d.player) || {};
        cap(host, (who.name || who.player_id || 'primary') + (who.player_id ? ' · ' + who.player_id : ''));
        var assets = (d && d.assets) || [];
        if (!assets.length) { host.appendChild(H.stateBlock('info', 'No balances read yet.')); return; }
        assets.forEach(function (a) {
          var name = a.display_name || a.denom;
          var qty = a.denom === 'ualpha' ? H.fmtAlpha(a.amount_p != null ? a.amount_p : a.amount) : (a.denom === 'ore' ? H.fmtOre(a.amount) : H.fmtNum(a.amount) + ' ' + (a.base_name || ''));
          host.appendChild(H.row(name + (a.guild_tag ? ' [' + a.guild_tag + ']' : ''), qty + (a.sendable === false ? ' · not sendable' : ''), a.denom === 'ore' ? 'sui-icon-alpha-ore' : 'sui-icon-alpha-matter'));
        });
        host.appendChild(doorRow([{ label: 'Pay', primary: true, onClick: function () { add('pay', {}); } }]));
      }).catch(function (e) { fail(host, 'inventory', e); });
    },
  });

  // ── System health (mcp_health) ───────────────────────────────────────────
  T.register('health', {
    label: 'System health', describe: function () { return 'System health'; }, cadenceMs: 15000,
    render: function (host) {
      return invoke('mcp_health').then(function (h) {
        host.innerHTML = '';
        if (Board.healthTiles) host.appendChild(Board.healthTiles(h));
        else host.appendChild(H.row('Status', String((h && h.status) || 'unknown')));
      }).catch(function (e) { fail(host, 'health', e); });
    },
  });
})();
