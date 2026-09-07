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
  // ── Tickets ───────────────────────────────────────────────────────────
  // A card that shows something you can change should offer the change. A
  // ticket is the shape that makes that safe: a few fields, a PREVIEW that
  // says what the chain will do, and a confirm before anything is signed.
  // The guild bank card was the first; this is that pattern, shared.
  //
  // spec: { fields:[{key,label,kind:'choice'|'amount'|'text',options,placeholder,value,hint}],
  //         cta, danger, preview(values)->Promise|null, facts(preview)->[[label,value,tone]],
  //         confirm(values,preview)->{title,rows,cta}, submit(values)->Promise, done() }
  var readControl = function (n) { return T.readControl(n); };
  var feed = { rows: [], listening: false, fresh: null, draw: null };
  function ticket(spec) {
    var box = H.el('div', 'tm-ticket');
    var inputs = {}, timer = null, last = null;
    var out = H.el('div', 'tm-ticket-note');
    var go = H.el('a', 'sui-screen-btn ' + (spec.danger ? 'sui-mod-destructive' : 'sui-mod-primary'), spec.cta || 'Sign');
    go.href = 'javascript:void(0)';

    function values() {
      var v = {};
      Object.keys(inputs).forEach(function (k) { v[k] = readControl(inputs[k]); });
      return v;
    }
    function paintFields() {
      var fields = H.el('div', 'tm-ticket-fields');
      (typeof spec.fields === 'function' ? spec.fields(values()) : spec.fields).forEach(function (f) {
        var ctl;
        if (f.kind === 'choice') ctl = H.selectBox(String(f.value == null ? (f.options[0] || {}).value : f.value), f.options, function () { changed(true); });
        else {
          ctl = H.textBox(f.value == null ? '' : String(f.value), f.placeholder || '', function () { changed(false); });
          ctl.setAttribute('inputmode', 'numeric');
          ctl.addEventListener('input', function () { changed(false); });
        }
        inputs[f.key] = ctl;
        var wrap = H.field(f.label, ctl);
        if (f.hint) wrap.title = f.hint;
        fields.appendChild(wrap);
      });
      var old = box.querySelector('.tm-ticket-fields');
      // First paint: the note and the button are not in the box yet.
      if (old) box.replaceChild(fields, old);
      else if (out.parentNode === box) box.insertBefore(fields, out);
      else box.appendChild(fields);
    }
    function changed(rebuild) {
      if (rebuild && typeof spec.fields === 'function') { var keep = values(); inputs = {}; paintFields(); restore(keep); }
      if (timer) clearTimeout(timer);
      timer = setTimeout(runPreview, 250);
    }
    function restore(keep) {
      Object.keys(keep).forEach(function (k) {
        var ctl = inputs[k]; if (!ctl || !keep[k]) return;
        var inner = ctl.value != null && ctl.tagName !== 'DIV' ? ctl : ctl.querySelector && ctl.querySelector('select, input');
        if (inner && inner.tagName === 'INPUT') inner.value = keep[k];
      });
    }
    function runPreview() {
      last = null;
      out.innerHTML = '';
      if (!spec.preview) return;
      var p = spec.preview(values());
      if (!p) return;
      out.appendChild(H.stateBlock('loading', 'checking…'));
      p.then(function (res) {
        out.innerHTML = '';
        (res && res.warnings || []).forEach(function (w) { out.appendChild(H.stateBlock('warning', String(w))); });
        if (res && res.ok === false) { out.appendChild(H.stateBlock('error', String(res.refusal || 'refused'))); return; }
        last = res;
        var facts = spec.facts ? spec.facts(res) : [];
        if (facts.length) out.appendChild(tiles(facts));
      }).catch(function (e) { out.innerHTML = ''; out.appendChild(H.stateBlock('error', String(e))); });
    }
    go.addEventListener('click', function () {
      var v = values();
      var c = spec.confirm ? spec.confirm(v, last) : null;
      var run = function () {
        go.classList.add('is-busy');
        spec.submit(v).then(function () {
          go.classList.remove('is-busy');
          out.innerHTML = ''; out.appendChild(H.stateBlock('info', 'queued for signing'));
          if (spec.done) spec.done();
        }).catch(function (e) {
          go.classList.remove('is-busy');
          out.innerHTML = ''; out.appendChild(H.stateBlock('error', String(e)));
        });
      };
      if (!c) { run(); return; }
      var body = H.el('div');
      (c.rows || []).forEach(function (r) { body.appendChild(H.fact ? H.fact(r[0], r[1]) : H.row(r[0], r[1])); });
      H.confirmModal(c.title, body, c.cta || spec.cta || 'Confirm', run);
    });

    paintFields();
    box.appendChild(out);
    box.appendChild(go);
    runPreview();
    return box;
  }

  var human = function (s) { return String(s || '?').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(); };
  var fail = function (host, what, e) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', what + ' unavailable: ' + e)); };

  // ── Hashing (mcp_work) ───────────────────────────────────────────────────
  var TASK_ICON = { MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-in-progress', RAID: 'icon-raid' };
  T.register('pow', {
    label: 'Proof queue', describe: function () { return 'Proof queue'; }, cadenceMs: 5000,
    render: function (host, p, ctx) {
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
        // Hashing is the one engine a player may want to stop dead — a laptop
        // on battery, a machine needed for something else.
        var on = hc.enabled !== false;
        host.appendChild(doorRow([{ label: on ? 'Pause hashing' : 'Resume hashing', primary: !on, onClick: function () {
          invoke('mcp_config_set', { domain: 'hash', payload: { enabled: !on } })
            .then(function () { T.refresh(ctx.id, true); })
            .catch(function (e) { Board.stamp && Board.stamp('hash: ' + e); });
        } }]));
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
              few ? null : H.statTile('p90', H.duration(e.p90_duration_ms / 1000)),
              // A difficulty alone says little; which way it is MOVING decides
              // whether the engine is keeping up with the chain.
              H.statTile('difficulty', e.median_difficulty == null ? '—' : String(e.median_difficulty)
                + (e.median_difficulty_prev == null ? '' : (e.median_difficulty > e.median_difficulty_prev ? ' ↑' : e.median_difficulty < e.median_difficulty_prev ? ' ↓' : '')),
                null, e.median_difficulty_prev == null ? null : (e.median_difficulty > e.median_difficulty_prev ? 'bad' : e.median_difficulty < e.median_difficulty_prev ? 'ok' : '')),
              H.statTile('hashrate', e.est_hashrate_hps == null ? '—' : H.fmtNum(e.est_hashrate_hps) + 'H/s', null, e.est_hashrate_hps == null ? 'muted' : ''),
            ].filter(Boolean),
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
    render: function (host, p, ctx) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var all = (d.tasks || []).filter(function (t) {
          if (p.type && t.task_type !== p.type) return false;
          if (p.status && String(t.status) !== p.status) return false;
          return true;
        });
        // Finished proofs are history, not a queue: out of the way unless
        // asked for, and the caption says how many were set aside.
        var done = p.status ? 0 : all.filter(function (t) { return String(t.status) === 'completed'; }).length;
        var rows = p.status ? all : all.filter(function (t) { return String(t.status) !== 'completed'; });
        // Running first (most advanced at the top), then waiting, then done.
        var ORDER = { running: 0, waiting: 1, completed: 2 };
        rows.sort(function (a, b) {
          var sa = ORDER[a.status] == null ? 1 : ORDER[a.status], sb = ORDER[b.status] == null ? 1 : ORDER[b.status];
          return sa !== sb ? sa - sb : pct(b.percent_complete) - pct(a.percent_complete);
        });
        cap(host, rows.length + ' task' + (rows.length === 1 ? '' : 's')
          + (rows.length > 25 ? ' · showing 25 of ' + rows.length : '')
          + (done ? ' · ' + done + ' finished hidden' : ''));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'Nothing in the queue.')); return; }
        // One task row from the catalogue (structs-cards.js): the struct's
        // art or the task glyph, the id, progress, difficulty of 64, the eta.
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (t) {
          table.appendChild(window.StructsCards.task.row({
            id: t.task_id || '?', type: t.task_type, status: String(t.status || 'waiting'),
            frac: pct(t.percent_complete) / 100, difficulty: t.current_difficulty, eta: t.eta,
            structType: t.struct_type_name || t.struct_type || null,
          }, {
            onClick: t.task_id ? function () { add('inspector', { id: String(t.task_id).split(':')[0] }); } : null,
            doors: String(t.status) === 'completed' ? [] : [
              { icon: 'icon-close', title: 'Cancel this proof', destructive: true, onClick: function () {
                invoke('stop_hash_task', { pid: t.task_id }).then(function () { T.refresh(ctx.id, true); })
                  .catch(function (e) { Board.stamp && Board.stamp('cancel: ' + e); });
              } },
            ],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });

  // ── Signing (mcp_tx_snapshot / mcp_tx_mutate) ────────────────────────────
  // One transaction row from the catalogue (structs-cards.js): rank, type,
  // signer, charge and attempts; the countdown in blocks; move and cancel as
  // doors. In flight has no doors.
  function txRow(t, pos, total, q, state, mutate) {
    var eta = q && q.etas && q.etas[t.id];
    var pctv = q && q.percents && q.percents[t.id];
    var doors = [];
    if (mutate && state === 'queued' && pos != null) {
      if (pos > 1) doors.push({ icon: 'icon-caret-up', title: 'Move up', onClick: function () { mutate('move_up', t.id); } });
      if (pos < total) doors.push({ icon: 'icon-caret-down', title: 'Move down', onClick: function () { mutate('move_down', t.id); } });
    }
    if (mutate && state !== 'flight') doors.push({ icon: 'icon-close', title: 'Cancel', destructive: true, onClick: function () { mutate('cancel', t.id); } });
    return window.StructsCards.tx.row({
      id: t.id, type: t.type_short || t.type_url || '?', signer: t.player_id || t.signer || null, position: pos,
      charge: t.charge_cost > 0 ? t.charge_cost : null, attempts: t.attempts, retryLimit: t.retry_limit, state: state,
      eta: eta && eta.blocksRemaining != null
        ? { text: eta.blocksRemaining + ' blk', frac: pctv != null ? pctv / 100 : 0, title: '~' + Math.max(0, Math.round((eta.etaMs || 0) / 1000)) + 's' }
        : (pctv != null ? { text: '', frac: pctv / 100 } : null),
    }, { doors: doors });
  }
  T.register('queue', {
    label: 'Signing queue',
    describe: function (p) { return 'Signing queue' + (p.signer ? ' · ' + p.signer : ''); },
    params: [{ key: 'signer', label: 'Signer', kind: 'id', placeholder: 'any player' }],
    cadenceMs: 2500,
    render: function (host, p, ctx) {
      return invoke('mcp_tx_snapshot').then(function (d) {
        host.innerHTML = '';
        var q = d && d.queue;
        if (!q) { host.appendChild(H.alertLine('signing queue unavailable — sign in on the game window' + (d && d.queue_error ? ' (' + d.queue_error + ')' : ''), 'icon-alert')); return; }
        var mine = function (t) { return !p.signer || String(t.player_id || t.signer || '') === p.signer; };
        var aq = (q.action_queue || []).filter(mine), iq = (q.immediate_queue || []).filter(mine);
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
        var table = H.resultTable();
        if (q.in_flight && mine(q.in_flight)) table.appendChild(txRow(q.in_flight, null, 0, null, 'flight', null));
        iq.forEach(function (t) { table.appendChild(txRow(t, null, 0, null, 'immediate', mutate)); });
        aq.forEach(function (t, i) { table.appendChild(txRow(t, i + 1, aq.length, q, 'queued', mutate)); });
        host.appendChild(table);
        if (!q.in_flight && !aq.length && !iq.length) host.appendChild(H.el('div', 'ops-muted', 'nothing waiting to sign'));
      }).catch(function (e) { fail(host, 'tx', e); });
    },
  });
  T.register('results', {
    label: 'Tx results',
    describe: function (p) { return 'Tx results' + (p.outcome ? ' · ' + p.outcome : ''); },
    params: [
      { key: 'outcome', label: 'Outcome', kind: 'choice', options: [{ value: '', label: 'all' }, { value: 'success', label: 'success' }, { value: 'failed', label: 'failed' }, { value: 'skipped', label: 'skipped' }] },
      // On an 800-player roster one player's failures are invisible in a
      // shared list; this is how you ask about that player.
      { key: 'signer', label: 'Signer', kind: 'id', placeholder: 'any player' },
    ],
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
        var rows = hist.filter(function (h) {
          if (p.outcome && !(p.outcome === 'failed' ? (h.outcome !== 'success' && h.outcome !== 'skipped') : h.outcome === p.outcome)) return false;
          if (p.signer && String(h.player_id || h.context || '') !== p.signer) return false;
          return true;
        });
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No recent transactions.')); return; }
        if (rows.length > 25) cap(host, 'showing 25 of ' + rows.length);
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (h) {
          var ok = h.outcome === 'success';
          var err = ok ? null : String(h.translated || h.raw_error || '').replace(/^failed to execute message; message index: \d+: /, '');
          table.appendChild(window.StructsCards.tx.row({
            id: h.id, type: String(h.action || '').replace(/^.*Msg/, '') || '?', signer: h.player_id || h.context || null,
            state: ok ? 'ok' : h.outcome === 'skipped' ? 'skipped' : 'failed', hash: h.tx_hash || null, ago: H.ago(h.ts_ms), error: err, attempts: h.attempts,
          }, { doors: h.tx_hash ? [{ icon: 'icon-copy', title: 'Copy the hash', onClick: function () { if (navigator.clipboard) navigator.clipboard.writeText(String(h.tx_hash)).catch(function () {}); } }] : [] }));
        });
        host.appendChild(table);
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
        host.appendChild(doorRow([
          { label: 'Allocations', onClick: function () { add('allocations', {}); } },
          { label: 'Reactor fuel', onClick: function () { add('fuel', {}); } },
        ]));
      }).catch(function (e) { fail(host, 'energy', e); });
    },
  });
  T.register('fuel', {
    label: 'Reactor fuel', defaultWidth: 1, describe: function () { return 'Reactor fuel'; }, cadenceMs: 60000,
    render: function (host, p, ctx) {
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

        // Staking alpha into a reactor is how a guild makes power, and this
        // card named dead fuel for months without offering to move it.
        var mine = (d.infusions || []).filter(function (r) { return (r.fuel_ualpha || 0) > 0; });
        var reactorOpts = ((d.reactors) || []).map(function (r) {
          return { value: r.id, label: r.id + (r.moniker ? ' · ' + r.moniker : '') + ' · ' + Math.round((r.commission || 0) * 100) + '%' };
        });
        var mineOpts = mine.map(function (r) {
          return { value: r.destination_id, label: (r.destination_label || r.destination_id) + ' · ' + H.fmtAlpha(r.fuel_ualpha) };
        });
        var addressOf = function (dest) {
          var row = mine.filter(function (r) { return r.destination_id === dest; })[0];
          return (row && row.address) || d.address;
        };
        if (!reactorOpts.length && !mineOpts.length) return;
        host.appendChild(ticket({
          cta: 'Sign',
          fields: function (v) {
            var op = v.op || 'infuse';
            var f = [{ key: 'op', label: 'Ticket', kind: 'choice', value: op, options: [
              { value: 'infuse', label: 'Infuse alpha' },
              { value: 'defuse', label: 'Defuse alpha' },
              { value: 'migrate', label: 'Migrate alpha' },
            ] }];
            var opts = op === 'infuse' ? reactorOpts : (mineOpts.length ? mineOpts : reactorOpts);
            f.push({ key: 'dest', label: op === 'migrate' ? 'From reactor' : 'Reactor', kind: 'choice', value: v.dest, options: opts });
            if (op === 'migrate') f.push({ key: 'target', label: 'To reactor', kind: 'choice', value: v.target, options: reactorOpts });
            f.push({ key: 'amount', label: 'Alpha (ualpha)', value: v.amount, placeholder: '1000000' });
            return f;
          },
          preview: function (v) {
            var amt = Math.round(Number(v.amount));
            if (!v.dest || !isFinite(amt) || amt <= 0) return null;
            if (v.op === 'migrate' && !v.target) return null;
            return invoke('mcp_infusion_preview', {
              op: v.op || 'infuse', address: addressOf(v.dest), destinationId: v.dest,
              targetId: v.op === 'migrate' ? v.target : null, amountUalpha: amt,
            });
          },
          facts: function (p) {
            var f = p.facts || {};
            if ((p.op || '') === 'migrate') return [['net capacity', H.fmtWatts(f.net_mw || 0), null, (f.net_mw || 0) < 0 ? 'bad' : 'ok']];
            if ((p.op || '') === 'defuse') return [
              ['capacity lost', H.fmtWatts(f.capacity_lost_mw || 0), 'sui-icon-energy', 'bad'],
              ['back in', H.duration(f.cooldown_secs || 0), null, 'muted'],
            ];
            return [
              ['capacity gained', H.fmtWatts(f.gained_mw || 0), 'sui-icon-energy', 'ok'],
              ['commission', H.fmtWatts(f.commission_mw || 0), null, 'muted'],
              ['alpha after', H.fmtAlpha(f.balance_after_ualpha || 0), 'sui-icon-alpha-matter'],
            ];
          },
          confirm: function (v) {
            var word = v.op === 'defuse' ? 'Remove this alpha from the reactor?' : v.op === 'migrate' ? 'Move this alpha between reactors?' : 'Stake this alpha into the reactor?';
            var rows = [['Alpha', H.fmtAlpha(Number(v.amount) || 0)], ['Reactor', v.dest]];
            if (v.op === 'migrate') rows.push(['To', v.target]);
            return { title: word, rows: rows, cta: v.op === 'defuse' ? 'Defuse' : v.op === 'migrate' ? 'Migrate' : 'Infuse' };
          },
          submit: function (v) {
            var amt = Math.round(Number(v.amount));
            var addr = addressOf(v.dest);
            if (v.op === 'defuse') return invoke('mcp_infusion_defuse', { address: addr, reactorId: v.dest, amountUalpha: amt });
            if (v.op === 'migrate') return invoke('mcp_infusion_migrate', { address: addr, fromReactorId: v.dest, toReactorId: v.target, amountUalpha: amt });
            return invoke('mcp_infusion_infuse', { address: addr, reactorId: v.dest, amountUalpha: amt });
          },
          done: function () { T.refresh(ctx.id, true); },
        }));
      }).catch(function (e) { fail(host, 'infusions', e); });
    },
  });

  T.register('allocations', {
    label: 'Allocations', describe: function () { return 'Allocations'; }, cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_allocations').then(function (d) {
        host.innerHTML = '';
        if (d && d._err) { host.appendChild(H.stateBlock('error', 'allocations unavailable: ' + d._err)); return; }
        var b = (d && d.budget) || {}, rows = (d && d.allocations) || [];
        host.appendChild(tiles([
          ['allocatable', H.fmtWatts(b.allocatable_mw || 0), 'sui-icon-energy'],
          ['available', H.fmtWatts(b.available_mw || 0), null, (b.available_mw || 0) <= 0 ? 'bad' : 'ok'],
          ['allocations', H.fmtInt(rows.length)],
        ]));
        // Routing power is the point of the card; it used to only describe it.
        var openTicket = function (seed) {
          var slot = host.querySelector('.tm-ticket-slot');
          if (!slot) return;
          slot.innerHTML = '';
          slot.appendChild(seed);
        };
        var table = H.resultTable();
        rows.forEach(function (a) {
          table.appendChild(window.StructsCards.row({
            kind: 'allocation', emblem: window.StructsCards.emblem.glyph(a.locked ? 'icon-key' : 'sui-icon-energy', 'sm', a.locked ? 'hint' : 'secondary'),
            title: (a.type || 'allocation') + ' → ' + (a.destination_id || '?'), id: a.id,
            sub: a.source_object_id ? 'from ' + a.source_object_id : null, attn: a.locked ? 'locked' : null,
            readings: [{ value: H.fmtWatts(a.power_mw || 0), icon: 'sui-icon-energy', title: 'Power allocated' }],
          }, {
            doors: a.locked ? [] : [{ icon: 'icon-edit', title: 'Set the power on this allocation', onClick: function () {
              openTicket(ticket({
                cta: 'Set power',
                fields: [{ key: 'mw', label: 'Power (mW)', value: String(Math.round(a.power_mw || 0)), placeholder: '0' }],
                preview: function (v) {
                  var mw = Math.round(Number(v.mw));
                  if (!isFinite(mw) || mw < 0) return null;
                  return invoke('mcp_allocation_preview', { allocationId: a.id, powerMw: mw });
                },
                facts: function (pv) {
                  return [
                    [(pv.delta_mw || 0) >= 0 ? 'adds to load' : 'frees load', H.fmtWatts(Math.abs(pv.delta_mw || 0)), 'sui-icon-energy', (pv.delta_mw || 0) >= 0 ? null : 'ok'],
                    ['headroom after', H.fmtWatts(pv.projected_headroom_mw || 0), null, (pv.projected_headroom_mw || 0) < 0 ? 'bad' : 'ok'],
                  ];
                },
                confirm: function (v) {
                  return { title: 'Set allocation power?', cta: 'Apply', rows: [['From', H.fmtWatts(a.power_mw || 0)], ['To', H.fmtWatts(Number(v.mw) || 0)]] };
                },
                submit: function (v) { return invoke('mcp_allocation_set_power', { allocationId: a.id, powerMw: Math.round(Number(v.mw)) }); },
                done: function () { T.refresh(ctx.id, true); },
              }));
            } }],
          }));
        });
        if (rows.length) host.appendChild(table);
        else host.appendChild(H.stateBlock('info', 'No allocations.'));
        host.appendChild(doorRow([{ label: 'New allocation', primary: true, onClick: function () {
          openTicket(ticket({
            cta: 'Create',
            fields: [
              { key: 'source', label: 'From object', value: d.player_id || '', placeholder: '1-194' },
              { key: 'type', label: 'Type', kind: 'choice', options: [{ value: 'dynamic', label: 'Dynamic' }, { value: 'static', label: 'Static' }] },
              { key: 'mw', label: 'Power (mW)', placeholder: '0' },
            ],
            confirm: function (v) { return { title: 'Create this allocation?', cta: 'Create', rows: [['From', v.source], ['Type', v.type], ['Power', H.fmtWatts(Number(v.mw) || 0)]] }; },
            submit: function (v) { return invoke('mcp_allocation_create', { sourceObjectId: v.source, allocationType: v.type, powerMw: Math.round(Number(v.mw)) }); },
            done: function () { T.refresh(ctx.id, true); },
          }));
        } }]));
        host.appendChild(H.el('div', 'tm-ticket-slot'));
      }).catch(function (e) { fail(host, 'allocations', e); });
    },
  });

  // ── Roster (mcp_roster / mcp_mass_action) ────────────────────────────────
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
        if (rows.length > 25) cap(host, 'showing 25 of ' + rows.length);
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (r) {
          table.appendChild(window.StructsCards.raid.row({
            planetId: r.planet_id, live: !!r.live, status: human(r.status), since: H.ago(r.updated_ms), stale: !!r.stale,
            ore: H.fmtOre(r.seized_ore || 0), oreLabel: 'Ore seized',
            attacker: r.attacker ? { id: r.attacker } : null, defender: r.defender ? { id: r.defender } : null,
          }, {
            onClick: function () { add('planet', { id: r.planet_id }); },
            onEmblem: function () { add('map', { id: r.planet_id }); },
            doors: [
              { icon: 'icon-raid', title: 'Watch this raid in its own window', onClick: function () {
                invoke('mcp_raid_view_open', { planetId: r.planet_id }).catch(function (e) { Board.stamp && Board.stamp('raid view: ' + e); });
              } },
              { icon: 'icon-combat-log', title: 'Battle log', onClick: function () { add('log', { id: r.planet_id }); } },
            ],
          }));
        });
        host.appendChild(table);
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
  var AUTONOMY_OPTS = [{ value: 'off', label: 'off' }, { value: 'advise', label: 'advise' }, { value: 'act', label: 'act' }];
  var POSTURE_OPTS = [{ value: 'opportunist', label: 'opportunist' }, { value: 'aggressive', label: 'aggressive' }, { value: 'defensive', label: 'defensive' }];
  T.register('posture', {
    label: 'War posture', describe: function () { return 'War posture'; }, cadenceMs: 15000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var resp = d.response || {}, raid = d.raid || {}, sb = d.shot_budget || {};
        // The two loops as loop cards (structs-cards.js): the game's own
        // switch is the control, the badge the state, the hold reason a mark.
        var grid = H.el('div', 'pc-grid');
        grid.appendChild(window.StructsCards.loop.card({
          key: 'response', name: 'Auto response', on: !!resp.enabled, cadence: 'event', icon: 'icon-counter', dryRun: !!resp.dry_run,
          figures: [{ value: String(resp.autonomy || '?'), icon: 'sui-icon-md icon-computer', title: 'Autonomy' },
                    { value: H.fmtInt(sb.used || 0) + ' / ' + H.fmtInt(sb.cap || 0), icon: 'sui-icon-md icon-dmg', title: 'Shots this window' }],
          holding: resp.enabled && resp.blocked_reason ? String(resp.blocked_reason) : null,
        }, { onToggle: function () { loopToggle('response', resp, ctx); } }));
        grid.appendChild(window.StructsCards.loop.card({
          key: 'raid', name: 'Auto raid', on: !!raid.enabled, cadence: raid.scan_interval_secs ? raid.scan_interval_secs + 's' : null, icon: 'icon-raid', dryRun: !!raid.dry_run,
          figures: [{ value: String(raid.autonomy || '?'), icon: 'sui-icon-md icon-computer', title: 'Autonomy' },
                    { value: String(raid.posture || '?'), icon: 'sui-icon-md icon-range', title: 'Posture' }],
          holding: raid.enabled && raid.blocked_reason ? String(raid.blocked_reason) : null,
        }, { onToggle: function () { loopToggle('raid', raid, ctx); } }));
        host.appendChild(grid);
        // Autonomy and posture decide what the loops are ALLOWED to do, and
        // changing them used to mean leaving for a settings page.
        var pick = function (label, value, options, apply) {
          var sel = H.selectBox(String(value || options[0].value), options, function () {
            invoke('mcp_config_set', { domain: 'loop', payload: apply(readControl(sel)) })
              .then(function () { T.refresh(ctx.id, true); })
              .catch(function (e) { Board.stamp && Board.stamp('loop: ' + e); });
          });
          return H.field(label, sel);
        };
        var strip = H.el('div', 'tm-config tm-posture-config');
        strip.appendChild(pick('Response autonomy', resp.autonomy, AUTONOMY_OPTS, function (v) {
          return { loop: 'response', config: Object.assign({}, resp, { autonomy: v }) };
        }));
        strip.appendChild(pick('Raid autonomy', raid.autonomy, AUTONOMY_OPTS, function (v) {
          return { loop: 'raid', config: Object.assign({}, raid, { autonomy: v }) };
        }));
        strip.appendChild(pick('Raid posture', raid.posture, POSTURE_OPTS, function (v) {
          return { loop: 'raid', config: Object.assign({}, raid, { posture: v }) };
        }));
        host.appendChild(strip);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('targets', {
    label: 'Target board', defaultWidth: 2,
    describe: function (p) { return 'Target board' + (p.sort ? ' · ' + p.sort : ''); },
    params: [{ key: 'sort', label: 'Order', kind: 'choice', options: [
      { value: 'score', label: 'by score' }, { value: 'ore', label: 'by ore' }, { value: 'shield', label: 'weakest shield' }, { value: 'raid_minutes', label: 'quickest proof' },
    ] }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var raid = d.raid || {}, targets = d.targets || [];
        var key = p.sort || 'score';
        targets = targets.slice().sort(function (a, b) {
          if (key === 'shield' || key === 'raid_minutes') return (Number(a[key]) || 0) - (Number(b[key]) || 0);
          return (Number(b[key === 'ore' ? 'stored_ore' : key]) || 0) - (Number(a[key === 'ore' ? 'stored_ore' : key]) || 0);
        });
        var go = targets.filter(function (t) { return !t.blocked_by; }).length;
        cap(host, targets.length + ' scored · ' + go + ' GO' + (targets.length > 20 ? ' · showing 20' : '') + (raid.enabled ? '' : ' · raiding is off'));
        if (!targets.length) { host.appendChild(H.stateBlock('info', 'No targets scored yet.')); return; }
        // Catalogue rows (structs-cards.js): GO/NO-GO as the badge and the
        // stripe, the reason on the id line, the planet as a chip, four
        // readings, and the three verbs as doors — grudge and veto write
        // combat_lists, the same path the WAR page uses.
        var C = window.StructsCards;
        var table = H.resultTable();
        targets.slice(0, 20).forEach(function (t) {
          var ok = !t.blocked_by;
          var thin = (t.stored_ore || 0) < (raid.min_ore || 0);
          table.appendChild(C.row({
            kind: 'target', emblem: C.emblem.glyph(ok ? 'icon-raid' : 'icon-blocked', 'sm', ok ? 'enemy' : 'hint'),
            title: t.name || t.player_id, id: t.player_id, sub: ok ? (t.vulnerability_reason || null) : null,
            attn: ok ? null : t.blocked_by, state: ok ? 'bad' : null,
            badge: ok ? { text: 'GO', mod: 'destructive' } : { text: 'NO-GO', mod: 'default' },
            chips: t.planet_id ? [C.planet.chip({ id: t.planet_id }, { onClick: function () { add('planet', { id: t.planet_id }); } })] : null,
            readings: [
              { value: H.fmtOre(t.stored_ore || 0), icon: 'sui-icon-alpha-ore', title: thin ? 'Stored ore · under the raid minimum' : 'Stored ore', cls: thin ? 'sc-bad-text' : null },
              { value: String(t.planetary_shield || 0) + ' · ~' + Math.round(t.raid_minutes || 0) + 'm', icon: 'sui-icon-md icon-planetary-shield', title: 'Shield · time to prove a raid' },
              { value: t.defenders_on_cmd == null ? '—' : String(t.defenders_on_cmd), icon: 'sui-icon-md icon-defend', title: 'Defenders on the command ship' },
              { value: String(Math.round(t.score || 0)), icon: 'sui-icon-md icon-range', title: 'Target score', cls: ok ? 'sc-ok' : null },
            ],
          }, {
            onClick: t.planet_id ? function () { add('planet', { id: t.planet_id }); } : null,
            doors: [
              // The board scores a target and then could only ever describe
              // it: the verb lives in `mcp_action`, the same one the agent
              // calls, with the same home guard and approval surface.
              ok ? { icon: 'icon-raid', title: 'Raid ' + t.planet_id, destructive: true, onClick: function () {
                var body = H.el('div');
                body.appendChild(H.fact ? H.fact('Planet', String(t.planet_id)) : H.row('Planet', String(t.planet_id)));
                body.appendChild(H.fact ? H.fact('Holder', String(t.name || t.player_id)) : H.row('Holder', String(t.name || t.player_id)));
                body.appendChild(H.fact ? H.fact('Ore at stake', H.fmtOre(t.stored_ore || 0)) : H.row('Ore at stake', H.fmtOre(t.stored_ore || 0)));
                body.appendChild(H.fact ? H.fact('Shield · proof', (t.planetary_shield || 0) + ' · ~' + Math.round(t.raid_minutes || 0) + 'm') : H.row('Shield', String(t.planetary_shield || 0)));
                H.confirmModal('Raid this planet? It seizes their ore and provokes their defence.', body, 'Raid', function () {
                  invoke('mcp_action', { action: 'raid', args: { target_id: t.planet_id } })
                    .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); T.refresh(ctx.id, true); })
                    .catch(function (e) { Board.stamp && Board.stamp('raid: ' + e); });
                });
              } } : null,
              { icon: 'icon-planet', title: 'Open planet ' + t.planet_id, onClick: function () { add('planet', { id: t.planet_id }); } },
              { icon: 'icon-attention', title: 'Add ' + t.player_id + ' to the grudge list', onClick: function () { warSet({ action: 'add', kind: 'grudge', id: t.player_id, label: t.name, guild_id: t.guild_id, weight: 1.5 }, ctx); } },
              { icon: 'icon-blocked', title: 'Never attack ' + t.player_id, destructive: true, onClick: function () { warSet({ action: 'add', kind: 'protected', id: t.player_id }, ctx); } },
            ].filter(Boolean),
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
        var C = window.StructsCards;
        var table = H.resultTable();
        grudges.forEach(function (g) {
          table.appendChild(C.row({
            kind: 'grudge', emblem: C.emblem.glyph(g.muted ? 'icon-unknown' : 'icon-enemy-tile', 'sm', g.muted ? 'hint' : 'enemy'),
            title: g.label || g.player_id, id: g.player_id, sub: [g.guild_id ? 'guild ' + g.guild_id : null, g.source || null].filter(Boolean).join(' · ') || null,
            attn: g.muted ? 'muted' : (g.expired ? 'lapsed' : null), state: g.muted || g.expired ? null : 'bad',
            badge: { text: '×' + (Math.round((g.weight || 1) * 10) / 10), mod: g.muted ? 'default' : 'destructive' },
            readings: [
              { value: String(g.attacks || 0), icon: 'sui-icon-md icon-counter', title: 'Attacks on us' },
              { value: String(g.structs_lost || 0), icon: 'sui-icon-md icon-wreckage', title: 'Structs we lost to them' },
              { value: String(g.damage_taken || 0), icon: 'sui-icon-md icon-dmg', title: 'Damage taken' },
              { value: String(Math.round((g.heat || 0) * 100) / 100), icon: 'sui-icon-md icon-attention', title: 'Heat', cls: g.muted ? null : 'sc-bad-text' },
            ],
          }, {
            onClick: function () { add('player', { id: g.player_id }); },
            doors: [
              { icon: g.muted ? 'icon-okay' : 'icon-blocked', title: g.muted ? 'Unmute' : 'Mute — keep the record, stop acting on it', on: g.muted, onClick: function () { warSet({ action: g.muted ? 'unmute' : 'mute', kind: 'grudge', id: g.player_id }, ctx); } },
              { icon: 'icon-subtract', title: 'Forget this grudge', destructive: true, onClick: function () { warSet({ action: 'remove', kind: 'grudge', id: g.player_id }, ctx); } },
            ],
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
        var C = window.StructsCards;
        var table = H.resultTable();
        var line = function (icon, tone, title, id, kind, badge, open) {
          return C.row({
            kind: kind, emblem: C.emblem.glyph(icon, 'sm', tone), title: title, id: id, badge: badge || null,
          }, {
            onClick: open,
            doors: [{ icon: 'icon-subtract', title: 'Remove ' + id, destructive: true, onClick: function () { warSet({ action: 'remove', kind: kind, id: id }, ctx); } }],
          });
        };
        prot.forEach(function (pid) { table.appendChild(line('icon-blocked', 'warning', 'Protected player', pid, 'protected', null, function () { add('player', { id: pid }); })); });
        allies.forEach(function (gid) { table.appendChild(line('icon-guild', 'player', 'Ally guild', gid, 'ally', null, function () { add('guild', { id: gid }); })); });
        prio.forEach(function (g) { table.appendChild(line('icon-attention', 'enemy', 'Priority guild', g.guild_id, 'priority_guild', { text: '×' + g.weight, mod: 'destructive' }, function () { add('guild', { id: g.guild_id }); })); });
        if (prot.length || allies.length || prio.length) host.appendChild(table);
        // Adding a veto used to mean finding the player on the target board.
        host.appendChild(ticket({
          cta: 'Add',
          fields: [
            { key: 'kind', label: 'Never attack', kind: 'choice', options: [
              { value: 'protected', label: 'a player' }, { value: 'ally', label: 'an ally guild' }, { value: 'priority_guild', label: 'a priority guild' },
            ] },
            { key: 'id', label: 'Id', placeholder: '1-248 or 0-1' },
          ],
          confirm: function (v) { return { title: 'Add to the never-attack list?', cta: 'Add', rows: [['Kind', v.kind], ['Id', v.id]] }; },
          submit: function (v) { return warSet({ action: 'add', kind: v.kind, id: v.id }, ctx); },
          done: function () { T.refresh(ctx.id, true); },
        }));
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
        var clock = function (ms) { var d = new Date(Number(ms) || 0); return isNaN(d.getTime()) ? '?' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
        inc.slice(0, 20).forEach(function (i) {
          table.appendChild(window.StructsCards.incident.row({
            at: clock(i.at_ms), planetId: i.planet_id, mode: i.mode || 'incident', fired: i.shots_fired || 0, planned: i.shots_planned || 0,
            attacker: i.attacker_player ? { id: i.attacker_player } : null,
            damage: Math.round((i.projected_damage || 0) * 10) / 10, fireTarget: i.fire_target || null, note: i.note || null,
            advised: !(i.shots_fired > 0) && /advis/i.test(String(i.mode || '') + ' ' + String(i.note || '')),
          }, {
            onClick: function () { add('planet', { id: i.planet_id }); },
            doors: [{ icon: 'icon-combat-log', title: 'Battle log', onClick: function () { add('log', { id: i.planet_id }); } }],
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
    render: function (host, p, ctx) {
      return invoke('mcp_inventory', { player: p.id || 'primary' }).then(function (d) {
        host.innerHTML = '';
        var who = (d && d.player) || {};
        cap(host, (who.name || who.player_id || 'primary') + (who.player_id ? ' · ' + who.player_id : ''));
        var assets = (d && d.assets) || [];
        if (!assets.length) { host.appendChild(H.stateBlock('info', 'No balances read yet.')); return; }
        var table = H.resultTable();
        assets.forEach(function (a) {
          var kind = a.denom === 'ualpha' ? 'alpha' : a.denom === 'ore' ? 'ore' : (/^uguild\./.test(String(a.denom)) ? 'guild' : 'other');
          var qty = kind === 'alpha' ? H.fmtAlpha(a.amount_p != null ? a.amount_p : a.amount) : (kind === 'ore' ? H.fmtOre(a.amount) : H.fmtNum(a.amount));
          table.appendChild(window.StructsCards.asset.row({
            denom: a.denom, name: a.display_name || a.denom, tag: a.guild_tag || null, kind: kind, amount: qty, sendable: a.sendable !== false,
          }, { doors: kind === 'ore'
            // Ore cannot be sent; refining is the only thing to do with it.
            ? [{ icon: 'icon-refine', title: 'Refine ore into alpha', onClick: function () {
                H.confirmModal('Refine this ore?', H.el('div', null, 'It becomes alpha once the proof completes.'), 'Refine', function () {
                  invoke('mcp_action', { action: 'refine', args: {} })
                    .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); T.refresh(ctx.id, true); })
                    .catch(function (e) { Board.stamp && Board.stamp('refine: ' + e); });
                });
              } }]
            : (a.sendable === false ? [] : [{ icon: 'icon-send-alpha', title: 'Pay', onClick: function () { add('pay', {}); } }]) }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'inventory', e); });
    },
  });

  // ── System health (mcp_health) ───────────────────────────────────────────
  // ── What to do next ──────────────────────────────────────────────────────
  // The board's default view leads with recommended moves; the Terminal had
  // no equivalent, so a console full of readings never said which one mattered
  // this minute. Every line here is DERIVED from a reading the other cards
  // already show, and opens the card that fixes it — nothing is invented, and
  // a quiet game says so rather than manufacturing advice.
  T.register('next', {
    label: 'What to do next', defaultWidth: 2, single: true,
    describe: function () { return 'What to do next'; }, cadenceMs: 30000,
    render: function (host) {
      var soft = function (cmd, args) { return invoke(cmd, args).catch(function () { return null; }); };
      return Promise.all([
        soft('mcp_energy'), soft('mcp_health'), soft('mcp_tx_snapshot'),
        soft('mcp_infusions'), soft('mcp_raids'), soft('mcp_war_bundle'), soft('mcp_work'),
      ]).then(function (r) {
        var energy = r[0] || {}, health = r[1] || {}, tx = r[2] || {}, fuel = r[3] || {};
        var raids = r[4] || {}, war = r[5] || {}, work = r[6] || {};
        var moves = [];
        var add1 = function (m) { moves.push(m); };

        var brown = ((energy.players) || []).filter(function (x) { return Number(x.margin_pct) <= 0; });
        if (brown.length) add1({ urgency: 'bad', icon: 'sui-icon-energy',
          title: brown.length + ' player' + (brown.length === 1 ? '' : 's') + ' in brownout',
          why: 'their structs switch off until they have power', card: 'halt', label: 'Power margins' });

        var ours = ((raids.raids) || []).filter(function (x) { return x.live && x.our_side === 'defender'; });
        if (ours.length) add1({ urgency: 'bad', icon: 'icon-raid',
          title: ours.length + ' raid' + (ours.length === 1 ? '' : 's') + ' against us, live',
          why: 'ore leaves the planet when the raid resolves', card: 'raids', params: { scope: 'live' }, label: 'Raids' });

        if (health && (health.loops_wedged || 0) > 0) add1({ urgency: 'bad', icon: 'icon-alert',
          title: H.fmtInt(health.loops_wedged) + ' loop' + (health.loops_wedged === 1 ? '' : 's') + ' wedged',
          why: 'the automation has stopped doing that job', card: 'health', label: 'System health' });

        var failed = ((tx.history) || []).filter(function (h) { return h.outcome !== 'success' && h.outcome !== 'skipped'; });
        if (failed.length >= 3) add1({ urgency: 'warn', icon: 'icon-transfers',
          title: H.fmtInt(failed.length) + ' transactions failed recently',
          why: 'the actions they carried never happened', card: 'results', params: { outcome: 'failed' }, label: 'Tx results' });

        var dead = ((fuel.totals) || {}).dead_fuel_ualpha || 0;
        if (dead > 0) add1({ urgency: 'warn', icon: 'sui-icon-alpha-matter',
          title: H.fmtAlpha(dead) + ' of staked alpha earns nothing',
          why: 'it is in a reactor that makes no capacity', card: 'fuel', label: 'Reactor fuel' });

        var go = ((war.targets) || []).filter(function (t) { return !t.blocked_by; });
        if (go.length && ((war.raid) || {}).enabled) add1({ urgency: 'ok', icon: 'icon-raid',
          title: go.length + ' target' + (go.length === 1 ? '' : 's') + ' are GO',
          why: 'scored, unblocked, and holding ore', card: 'targets', label: 'Target board' });

        var hc = work.hash_config || {}, counts = work.counts || {};
        if (hc.enabled === false) add1({ urgency: 'warn', icon: 'icon-computer',
          title: 'Hashing is paused',
          why: 'no mining, refining, building or raiding can complete', card: 'pow', label: 'Proof queue' });
        else if ((counts.waiting || 0) > (hc.max_concurrent || 0) * 4) add1({ urgency: 'warn', icon: 'icon-in-progress',
          title: H.fmtInt(counts.waiting) + ' proofs are waiting',
          why: 'the queue is deeper than the engine can work through', card: 'tasks', label: 'Proof tasks' });

        host.innerHTML = '';
        var RANK = { bad: 0, warn: 1, ok: 2 };
        moves.sort(function (a, b) { return RANK[a.urgency] - RANK[b.urgency]; });
        cap(host, moves.length ? moves.length + ' thing' + (moves.length === 1 ? '' : 's') + ' worth doing' : 'nothing needs you');
        if (!moves.length) { host.appendChild(H.stateBlock('info', 'Every reading this card watches is healthy.')); return; }
        var table = H.resultTable();
        moves.forEach(function (m) {
          table.appendChild(window.StructsCards.row({
            kind: 'move',
            emblem: window.StructsCards.emblem.glyph(m.icon, 'sm', m.urgency === 'bad' ? 'enemy' : m.urgency === 'warn' ? 'warning' : 'player'),
            title: m.title, id: m.label, hideId: true, sub: m.why,
            state: m.urgency === 'bad' ? 'bad' : m.urgency === 'warn' ? 'warn' : 'live',
          }, {
            onClick: function () { add(m.card, m.params || {}); },
            doors: [{ icon: 'icon-link-out', title: 'Open ' + m.label, onClick: function () { add(m.card, m.params || {}); } }],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'next moves', e); });
    },
  });

  // ── The ops feed (mcp_board_feed + `board-feed`) ─────────────────────────
  // Every loop event, policy decision and threat the app records. Team Ops
  // has shown this since it was built; the Terminal never did, so a player
  // whose workspace IS the Terminal never saw what the automation was doing.
  var SEVERITY = { error: 'destructive', warn: 'warning', warning: 'warning', important: 'warning' };
  T.register('feed', {
    label: 'Ops feed', defaultWidth: 2, single: true,
    describe: function (p) { return 'Ops feed' + (p.source ? ' · ' + p.source : ''); },
    params: [{ key: 'source', label: 'Source', kind: 'text', placeholder: 'any (auto_raid, watchdog, policy…)' }],
    cadenceMs: 0,
    render: function (host, p) {
      var draw = function () {
        host.innerHTML = '';
        var rows = feed.rows.filter(function (e) { return !p.source || String(e.source || '').indexOf(p.source) >= 0; });
        cap(host, rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + (rows.length > 40 ? ' · showing 40' : ''));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'Nothing recorded yet.')); return; }
        var ul = H.el('ul', 'ops-feed sui-text-ticker tm-tape');
        var clock = function (ts) { var d = new Date(Number(ts) || 0); return isNaN(d.getTime()) ? '' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); };
        rows.slice(0, 40).forEach(function (e, i) {
          var li = H.el('li');
          li.appendChild(window.StructsCards.tape.row({
            time: clock(e.ts_ms), kind: String(e.source || 'app'), tone: SEVERITY[String(e.severity || '')] || 'default',
            parts: [String(e.message || '')], fresh: i === 0 && e === feed.fresh, title: String(e.message || ''),
          }));
          ul.appendChild(li);
        });
        host.appendChild(ul);
      };
      if (!feed.listening && window.StructsEvents) {
        feed.listening = true;
        window.StructsEvents.listen('board-feed', function (e) {
          var entry = e && e.payload;
          if (!entry) return;
          feed.fresh = entry;
          feed.rows.unshift(entry);
          if (feed.rows.length > 300) feed.rows.length = 300;
          if (feed.draw) feed.draw();
        });
      }
      feed.draw = draw;
      if (feed.rows.length) { draw(); return Promise.resolve(); }
      return invoke('mcp_board_feed').then(function (entries) {
        // Rust hands them oldest first; newest belongs on top.
        feed.rows = (entries || []).slice().reverse();
      }).catch(function () {}).then(draw);
    },
  });

  T.register('health', {
    label: 'System health', describe: function () { return 'System health'; }, cadenceMs: 15000,
    render: function (host) {
      return invoke('mcp_health').then(function (h) {
        host.innerHTML = '';
        if (Board.healthTiles) host.appendChild(Board.healthTiles(h));
        else host.appendChild(H.row('Status', String((h && h.status) || 'unknown')));
        // "Healthy" with no detail hides WHICH part was unwell, and the feed
        // is where the watchdog says what it did about it.
        var up = function (v) { return v === 'ok' || v === 'up' || v === true; };
        [['Signing bridge', h && h.signing_bridge], ['Grass stream', h && h.grass], ['Guild auth', h && h.guild_auth]].forEach(function (r) {
          if (r[1] == null || r[1] === '') return;
          host.appendChild(H.row(r[0], String(r[1]), up(r[1]) ? 'icon-success' : 'icon-alert'));
        });
        if (h && (h.loops_overdue || h.loops_wedged)) {
          host.appendChild(H.alertLine(H.fmtInt(h.loops_overdue || 0) + ' loops overdue · ' + H.fmtInt(h.loops_wedged || 0) + ' wedged', 'icon-alert'));
        }
        host.appendChild(doorRow([{ label: 'What the watchdog did', onClick: function () { add('feed', {}); } }]));
      }).catch(function (e) { fail(host, 'health', e); });
    },
  });
})();
