// STRUCTS TERMINAL — the onboarding telemetry card (⌘K → ONBOARDING).
//
// How far new players get through signup and the Combat Training tutorial,
// how long each part takes, and where they stop — summed over EVERY guild's
// server (`terminal_onboarding`, mcp/onboarding.rs). Two tiers arrive in one
// payload: the funnel and outcome counts cover every session; durations, step
// dwell, the daily cohorts and the recent list come from the per-player
// sample, which Rust crawls in the background and grows between reads.
//
// Views: FUNNEL (both phases, step by step: reached, kept, quit here, median
// time on the step), SLOWEST (where time goes), DAILY, GUILDS, RECENT.
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };

  var VIEWS = [['funnel', 'Funnel'], ['slowest', 'Slowest'], ['daily', 'Daily'], ['guilds', 'Guilds'], ['recent', 'Recent']];
  var IDLE = [{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '72', label: '3d' }, { value: '168', label: '7d' }];
  var DURATIONS = [['signup', 'Signup'], ['chain_wait', 'Chain wait'], ['to_offer', 'To offer'], ['decision', 'Decision'], ['tutorial', 'Tutorial'], ['total', 'Whole run']];
  var OUTCOMES = [['completed', 'Finished'], ['declined', 'Skipped'], ['left_during_tutorial', 'Quit'], ['in_progress', 'Playing']];
  var FLAG_TOP = 3;

  var OB = { cards: {} };

  // ── Pure pieces (T.onboarding, for the harness) ──
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /* `tutorial.first_attack.choose_rail_gun` → "First attack · Choose rail gun".
   * The phase is the section the row sits in, so it is dropped. */
  function stepLabel(key) {
    var parts = String(key || '').split('.');
    if (parts[0] === 'signup' || parts[0] === 'tutorial') parts.shift();
    return parts.map(function (p) { return cap(p.replace(/_/g, ' ')); }).join(' · ') || String(key || '');
  }
  function pct(f) { return f == null || !isFinite(f) ? '—' : (f >= 0.995 || f === 0 ? Math.round(f * 100) : (f * 100).toFixed(f < 0.1 ? 1 : 0)) + '%'; }
  function ratio(a, b) { return b > 0 ? a / b : null; }
  function int(n) { return n == null || !isFinite(n) ? '—' : H.fmtInt ? H.fmtInt(Math.round(n)) : String(Math.round(n)); }
  function dur(s) { return H.duration(s); }
  /* The keys of the `n` largest positive values. */
  function topKeys(rows, value, n) {
    return rows.map(function (r) { return [r.key, value(r)]; })
      .filter(function (kv) { return kv[1] != null && kv[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n)
      .map(function (kv) { return kv[0]; });
  }
  function dwellOf(d, key) { return (d && d.sample && d.sample.dwell && d.sample.dwell[key]) || null; }
  function stepReached(d, phase, key) {
    var rows = (d && d.phases && d.phases[phase]) || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return Number(rows[i].reached) || 0;
    return 0;
  }
  function firstReached(d, phase) {
    var best = 0;
    ((d && d.phases && d.phases[phase]) || []).forEach(function (r) {
      if (r.previous == null && r.next != null) best = Math.max(best, Number(r.reached) || 0);
    });
    return best;
  }
  function headline(d) {
    var o = (d && d.outcome) || {};
    var started = firstReached(d, 'signup');
    var signed = stepReached(d, 'signup', 'signup.employee_record');
    var offered = Number(o.offered) || 0;
    var dd = (d && d.sample && d.sample.durations) || {};
    return {
      started: started, signed: signed, signedRate: ratio(signed, started),
      offered: offered, finished: Number(o.completed) || 0, finishedRate: ratio(Number(o.completed) || 0, offered),
      skipped: Number(o.declined) || 0, skippedRate: ratio(Number(o.declined) || 0, offered),
      signupP50: dd.signup ? dd.signup.p50 : null, tutorialP50: dd.tutorial ? dd.tutorial.p50 : null,
    };
  }

  // ── Drawing ──
  function tile(label, value, sub, cls) {
    var t = H.statTile(sub ? [label, sub] : label, value, null, cls);
    t.classList.add('ob-tile');
    return t;
  }
  function bar(frac, cls) {
    var b = H.el('span', 'ob-bar' + (cls ? ' ' + cls : ''));
    var f = H.el('span', 'ob-bar-fill');
    f.style.width = (Math.max(0, Math.min(1, Number(frac) || 0)) * 100) + '%';
    b.appendChild(f);
    return b;
  }
  function cell(text, cls, title) {
    var c = H.el('span', 'ob-c' + (cls ? ' ' + cls : ''), text);
    if (title) c.title = title;
    return c;
  }
  /* Captions align with their column: numbers right, text (`left`, by index) left. */
  function headRow(cols, left) {
    var r = H.el('div', 'ob-row ob-head');
    cols.forEach(function (c, i) {
      var isLeft = i === 0 || (left || []).indexOf(i) >= 0;
      r.appendChild(H.el('span', 'ob-c fstat-l' + (isLeft ? '' : ' ob-n'), c));
    });
    return r;
  }

  function hud(d) {
    var h = headline(d);
    var box = H.el('div', 'ob-hud');
    box.appendChild(tile('Started', int(h.started)));
    box.appendChild(tile('Signed up', int(h.signed), pct(h.signedRate)));
    box.appendChild(tile('Offered', int(h.offered)));
    box.appendChild(tile('Finished', int(h.finished), pct(h.finishedRate), 'ok'));
    box.appendChild(tile('Skipped', int(h.skipped), pct(h.skippedRate)));
    box.appendChild(tile('Signup', dur(h.signupP50), 'median'));
    box.appendChild(tile('Tutorial', dur(h.tutorialP50), 'median'));
    return box;
  }

  function outcomeBar(d) {
    var o = (d && d.outcome) || {};
    var total = Number(o.offered) || 0;
    var wrap = H.el('div', 'ob-outcome');
    var strip = H.el('div', 'ob-stack');
    var legend = H.el('div', 'ob-legend');
    OUTCOMES.forEach(function (k) {
      var n = Number(o[k[0]]) || 0;
      var seg = H.el('span', 'ob-seg ob-seg-' + k[0]);
      seg.style.flexGrow = String(n);
      seg.title = k[1] + ' ' + int(n) + ' · ' + pct(ratio(n, total));
      if (n > 0) strip.appendChild(seg);
      var l = H.el('span', 'ob-key');
      l.appendChild(H.el('span', 'ob-swatch ob-seg-' + k[0]));
      l.appendChild(H.el('span', 'fstat-l', k[1] + ' ' + int(n) + ' · ' + pct(ratio(n, total))));
      legend.appendChild(l);
    });
    wrap.appendChild(strip);
    wrap.appendChild(legend);
    return wrap;
  }

  function phaseBlock(d, phase, title) {
    var rows = (d.phases && d.phases[phase]) || [];
    var block = H.el('div', 'ob-block');
    block.appendChild(H.el('div', 'ob-title sui-text-header', title));
    if (phase === 'tutorial') block.appendChild(outcomeBar(d));
    if (!rows.length) { block.appendChild(H.stateBlock('empty', 'No steps recorded')); return block; }
    var quitTop = topKeys(rows, function (r) { return r.dropped; }, FLAG_TOP);
    var slowTop = topKeys(rows, function (r) { var w = dwellOf(d, r.key); return w && w.n >= 3 ? w.p50 : null; }, FLAG_TOP);
    var table = H.el('div', 'ob-table ob-funnel');
    table.appendChild(headRow(['Step', '', 'Reached', 'Kept', 'Quit here', 'Skipped', 'Median', 'p90']));
    rows.forEach(function (r) {
      var w = dwellOf(d, r.key);
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', r.key);
      row.appendChild(cell(stepLabel(r.key), 'ob-step', r.key));
      row.appendChild(bar(r.retained, r.next == null && r.previous == null ? 'is-aside' : ''));
      row.appendChild(cell(int(r.reached), 'ob-n'));
      row.appendChild(cell(pct(r.retained), 'ob-n'));
      var quit = quitTop.indexOf(r.key) >= 0;
      row.appendChild(cell(r.dropped == null ? '—' : int(r.dropped), 'ob-n' + (quit ? ' is-bad' : ''), quit ? 'One of the steps most players stopped at' : null));
      row.appendChild(cell(r.skipped ? int(r.skipped) : '—', 'ob-n'));
      var slow = slowTop.indexOf(r.key) >= 0;
      row.appendChild(cell(w ? dur(w.p50) : '—', 'ob-n' + (slow ? ' is-slow' : ''), w ? 'Time until the next step, ' + w.n + ' players' : null));
      row.appendChild(cell(w ? dur(w.p90) : '—', 'ob-n'));
      table.appendChild(row);
    });
    block.appendChild(table);
    return block;
  }

  function viewFunnel(d) {
    var box = H.el('div', 'ob-view');
    box.appendChild(phaseBlock(d, 'signup', 'Signup'));
    box.appendChild(phaseBlock(d, 'tutorial', 'Combat Training'));
    return box;
  }

  function viewSlowest(d) {
    var box = H.el('div', 'ob-view');
    var dd = (d.sample && d.sample.durations) || {};
    var tiles = H.el('div', 'ob-hud ob-durations');
    DURATIONS.forEach(function (k) {
      var s = dd[k[0]];
      tiles.appendChild(tile(k[1], s ? dur(s.p50) : '—', s ? 'p90 ' + dur(s.p90) + ' · ' + int(s.n) : null));
    });
    box.appendChild(tiles);
    var dwell = (d.sample && d.sample.dwell) || {};
    var keys = Object.keys(dwell).filter(function (k) { return dwell[k] && dwell[k].n >= 3; })
      .sort(function (a, b) { return dwell[b].p50 - dwell[a].p50; }).slice(0, 15);
    if (!keys.length) { box.appendChild(H.stateBlock('empty', 'No step timings yet')); return box; }
    var max = dwell[keys[0]].p90 || dwell[keys[0]].p50 || 1;
    var table = H.el('div', 'ob-table ob-slow');
    table.appendChild(headRow(['Step', '', 'Median', 'p90', 'Players']));
    keys.forEach(function (k) {
      var w = dwell[k];
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', k);
      row.appendChild(cell((k.indexOf('signup.') === 0 ? 'Signup · ' : '') + stepLabel(k), 'ob-step', k));
      row.appendChild(bar(w.p50 / max, 'is-time'));
      row.appendChild(cell(dur(w.p50), 'ob-n'));
      row.appendChild(cell(dur(w.p90), 'ob-n'));
      row.appendChild(cell(int(w.n), 'ob-n'));
      table.appendChild(row);
    });
    box.appendChild(table);
    return box;
  }

  function viewDaily(d) {
    var box = H.el('div', 'ob-view');
    var days = ((d.sample && d.sample.daily) || []).slice().reverse();
    if (!days.length) { box.appendChild(H.stateBlock('empty', 'No signups sampled yet')); return box; }
    var table = H.el('div', 'ob-table ob-daily');
    table.appendChild(headRow(['Day', 'Signed up', 'Offered', 'Finished', 'Skipped', '', 'Finish rate']));
    days.forEach(function (x) {
      var row = H.el('div', 'ob-row');
      row.appendChild(cell(x.day, 'ob-step'));
      row.appendChild(cell(int(x.signed_up), 'ob-n'));
      row.appendChild(cell(int(x.offered), 'ob-n'));
      row.appendChild(cell(int(x.completed), 'ob-n'));
      row.appendChild(cell(int(x.declined), 'ob-n'));
      var r = ratio(x.completed, x.offered);
      row.appendChild(bar(r));
      row.appendChild(cell(pct(r), 'ob-n'));
      table.appendChild(row);
    });
    box.appendChild(table);
    return box;
  }

  function viewGuilds(d) {
    var box = H.el('div', 'ob-view');
    var crawl = (d.crawl && d.crawl.guilds) || {};
    var table = H.el('div', 'ob-table ob-guilds');
    table.appendChild(headRow(['Guild', 'Started', 'Signed up', 'Offered', 'Finished', 'Timed', 'No telemetry', 'Read']));
    (d.guilds || []).forEach(function (g) {
      var row = H.el('div', 'ob-row' + (g.status === 'ok' ? '' : ' is-quiet'));
      row.setAttribute('data-guild', g.id);
      var name = H.el('span', 'ob-c ob-step');
      name.appendChild(H.el('span', null, (g.name || g.id)));
      name.appendChild(H.el('span', 'ob-sub', (g.tag ? g.tag + ' · ' : '') + g.id + (g.error ? ' · ' + g.error : '')));
      row.appendChild(name);
      var o = g.outcome || {};
      var live = g.status === 'ok';
      row.appendChild(cell(live ? int(g.started) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(g.signed_up) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(o.offered) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(o.completed) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(g.sampled) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(g.untracked) : '—', 'ob-n'));
      var c = crawl[g.id];
      var read = !c ? '—' : (int(c.fetched) + ' / ' + int(Math.max(0, (c.candidates || 0) - (c.team_skipped || 0))));
      row.appendChild(cell(read, 'ob-n' + (c && c.errors ? ' is-bad' : ''), c && c.last_error ? c.last_error : null));
      table.appendChild(row);
    });
    box.appendChild(table);
    return box;
  }

  var OUTCOME_LABEL = { completed: 'Finished', declined: 'Skipped', left: 'Quit', playing: 'Playing', deciding: 'At offer' };
  function viewRecent(d) {
    var box = H.el('div', 'ob-view');
    var rows = (d.sample && d.sample.recent) || [];
    if (!rows.length) { box.appendChild(H.stateBlock('empty', 'No sessions sampled yet')); return box; }
    var tags = {};
    (d.guilds || []).forEach(function (g) { tags[g.id] = g.tag || g.id; });
    var table = H.el('div', 'ob-table ob-recent');
    table.appendChild(headRow(['Player', 'Guild', 'Last seen', 'Outcome', 'Got to', 'Signup', 'Tutorial'], [3, 4]));
    rows.forEach(function (x) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-player', x.player_id);
      var who = H.el('a', 'ob-c ob-step ob-link');
      who.href = 'javascript:void(0)';
      who.appendChild(H.el('span', null, x.name || x.player_id));
      who.appendChild(H.el('span', 'ob-sub', x.player_id));
      who.addEventListener('click', function () { T.execute('PLAYER ' + x.player_id); });
      row.appendChild(who);
      row.appendChild(cell(tags[x.guild_id] || x.guild_id, 'ob-n'));
      row.appendChild(cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-n'));
      row.appendChild(cell(OUTCOME_LABEL[x.outcome] || x.outcome, 'ob-out-' + x.outcome));
      row.appendChild(cell(x.last_step ? stepLabel(x.last_step) : '—', 'ob-step ob-sub', x.last_step));
      row.appendChild(cell(dur(x.signup_s), 'ob-n'));
      row.appendChild(cell(dur(x.tutorial_s), 'ob-n'));
      table.appendChild(row);
    });
    box.appendChild(table);
    return box;
  }

  function footLine(d) {
    var s = d.sample || {};
    var c = d.crawl || {};
    var parts = ['Timings from ' + int(s.sessions || 0) + ' players on ' + (d.version || '—')];
    if (d.untracked) parts.push(int(d.untracked) + ' new players without telemetry');
    if (c.running) parts.push('reading players…');
    else if (c.finished_ms) parts.push('read ' + H.ago(c.finished_ms) + ' ago');
    return H.el('div', 'ob-foot fstat-l', parts.join(' · '));
  }

  // ── The card ──
  T.register('onboarding', {
    label: 'Onboarding', describe: function (p) { return 'Onboarding' + (p && p.version ? ' · ' + p.version : ''); },
    cadenceMs: 30000, defaultWidth: 3,
    params: [],
    render: function (host, p, ctx) {
      p = p || {};
      var st = OB.cards[ctx.id] || (OB.cards[ctx.id] = { view: 'funnel', last: null });
      var args = { idleHours: Number(p.idle) || 24 };
      if (p.version) args.version = p.version;
      if (st.fresh) { args.fresh = true; st.fresh = false; }
      function draw(d) {
        st.last = d;
        host.innerHTML = '';
        var wrap = H.el('div', 'ob');
        var bar1 = H.el('div', 'ob-controls');
        var versions = (d.versions || []).map(function (v) { return { value: v, label: v }; });
        if (versions.length > 1) {
          bar1.appendChild(H.field('Tutorial', H.selectBox(d.version, versions, function (v) { T.setParams(ctx.id, Object.assign({}, p, { version: v })); })));
        }
        bar1.appendChild(H.field('Counts as quit after', H.selectBox(String(d.idle_hours || 24), IDLE, function (v) { T.setParams(ctx.id, Object.assign({}, p, { idle: v })); })));
        wrap.appendChild(bar1);
        wrap.appendChild(hud(d));
        wrap.appendChild(H.navStrip(VIEWS.map(function (v) { return { key: v[0], label: v[1] }; }), st.view, function (k) { st.view = k; draw(st.last); }));
        var view = { funnel: viewFunnel, slowest: viewSlowest, daily: viewDaily, guilds: viewGuilds, recent: viewRecent }[st.view] || viewFunnel;
        wrap.appendChild(view(d));
        wrap.appendChild(footLine(d));
        host.appendChild(wrap);
      }
      if (st.last && !host.firstChild) draw(st.last);
      else if (!st.last) host.appendChild(H.stateBlock('loading', 'Reading every guild'));
      return invoke('terminal_onboarding', args).then(draw).catch(function (e) {
        host.innerHTML = '';
        host.appendChild(H.stateBlock('error', 'Onboarding unavailable: ' + e));
      });
    },
    doors: function (c) {
      return [{ icon: 'icon-refresh', title: 'Read again now', onClick: function () {
        var st = OB.cards[c.id] || (OB.cards[c.id] = { view: 'funnel', last: null });
        st.fresh = true;
        T.setParams(c.id, Object.assign({}, c.params || {}));
      } }];
    },
  });

  T.onboarding = { stepLabel: stepLabel, pct: pct, topKeys: topKeys, headline: headline };
})();
