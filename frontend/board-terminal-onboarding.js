// STRUCTS TERMINAL — the Telemetry card (⌘K → TELEMETRY), onboarding analytics.
//
// How far new players get through signup and Combat Training, how long it
// takes, where they stop or skip, and what players do afterwards — summed over
// EVERY guild's server and the whole chain (`terminal_onboarding`,
// mcp/onboarding.rs + mcp/onboarding_players.rs).
//
// Every page reads the same filters (interface, guild, active/inactive) and
// can be split by one of them (Compare). The payload is a list of SEGMENTS —
// one when nothing is compared — and each page draws one column (or one row)
// per segment. Signup steps come from the guild servers' own funnels (every
// session, even ones that quit before a player existed); everything else is
// folded in Rust from per-player sessions and the chain's player tables, which
// background crawls grow between reads.
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };

  var VIEWS = [['overview', 'Overview'], ['signup', 'Signup'], ['tutorial', 'Tutorial'], ['players', 'Players'],
    ['retention', 'Retention'], ['timing', 'Timing'], ['daily', 'Daily'], ['guilds', 'Guilds'], ['recent', 'Recent']];
  var IDLE = [{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '72', label: '3d' }, { value: '168', label: '7d' }];
  var ACTIVE = [{ value: '1', label: '1d' }, { value: '7', label: '7d' }, { value: '30', label: '30d' }];
  var ACTIVITY = [{ value: '', label: 'All players' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];
  var COMPARE = [{ value: '', label: 'Nothing' }, { value: 'interface', label: 'Interface' }, { value: 'guild', label: 'Guild' }, { value: 'activity', label: 'Active / inactive' }];
  var DURATIONS = [['signup', 'Signup'], ['chain_wait', 'Chain wait'], ['to_offer', 'To offer'], ['decision', 'Decision'], ['tutorial', 'Tutorial'], ['total', 'Whole run']];
  var OUTCOMES = [['completed', 'Finished'], ['declined', 'Skipped'], ['left', 'Quit'], ['playing', 'Playing']];
  var STATS = [['mined', 'Ore mined', 'ore'], ['refined', 'Alpha refined', 'alpha'], ['planets', 'Planets completed', 'count'],
    ['raids_initiated', 'Raids initiated', 'count'], ['raids_won', 'Raids won', 'count']];
  var FLAG_TOP = 3;

  var OB = { cards: {} };

  // ── Pure pieces (T.onboarding, for the harness) ──
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /* `tutorial.first_attack.choose_rail_gun` → "First attack · Choose rail gun".
   * The phase is the page the row sits on, so it is dropped. */
  function stepLabel(key) {
    var parts = String(key || '').split('.');
    if (parts[0] === 'signup' || parts[0] === 'tutorial') parts.shift();
    return parts.map(function (p) { return cap(p.replace(/_/g, ' ')); }).join(' · ') || String(key || '');
  }
  function pct(f) { return f == null || !isFinite(f) ? '—' : (f >= 0.995 || f === 0 ? Math.round(f * 100) : (f * 100).toFixed(f < 0.1 ? 1 : 0)) + '%'; }
  function ratio(a, b) { return b > 0 ? a / b : null; }
  function int(n) { return n == null || !isFinite(n) ? '—' : H.fmtInt(n); }
  function dur(s) { return H.duration(s); }
  /* A stat's value in its own units. Refined alpha arrives in grams; the
   * game's alpha ladder takes ualpha. */
  function fmtKind(kind, v) {
    if (v == null || !isFinite(v)) return '—';
    if (kind === 'ore') return H.fmtOre(v);
    if (kind === 'alpha') return H.fmtAlpha(v * 1e6);
    if (kind === 'secs') return dur(v);
    return Math.abs(v) < 10 && v % 1 ? v.toFixed(1) : int(v);
  }
  /* A histogram bucket's caption: "0", "1–9", "≥ 100K". */
  function bucketLabel(b, kind) {
    if (!b.lo && !b.hi) return kind === 'secs' ? 'None' : '0';
    if (b.hi == null) return '≥ ' + fmtKind(kind, b.lo);
    if (kind === 'secs') return fmtKind(kind, b.lo) + '–' + fmtKind(kind, b.hi);
    return fmtKind(kind, b.lo) + '–' + fmtKind(kind, b.hi - (kind === 'count' ? 1 : 0));
  }
  /* The keys of the `n` largest positive values. */
  function topKeys(rows, value, n) {
    return rows.map(function (r) { return [r.key, value(r)]; })
      .filter(function (kv) { return kv[1] != null && kv[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n)
      .map(function (kv) { return kv[0]; });
  }
  function headline(seg) {
    var t = (seg && seg.tutorial) || {}, su = seg && seg.signup, dd = (seg && seg.durations) || {};
    return {
      players: seg ? seg.players : null, active: seg ? seg.active : null, activeRate: seg ? seg.active_rate : null,
      churn: seg ? seg.churn_rate : null,
      started: su ? su.started : null, signed: su ? su.signed_up : null, dropoff: su ? su.dropoff_rate : null,
      offered: t.offered, finished: t.completed, finishedRate: t.completion_rate,
      skipped: t.declined, skippedRate: t.decline_rate, quit: t.left, quitRate: t.quit_rate,
      signupP50: dd.signup ? dd.signup.p50 : null, tutorialP50: dd.tutorial ? dd.tutorial.p50 : null,
    };
  }

  // ── Drawing primitives ──
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
  /* A table whose columns are given here rather than in the stylesheet:
   * comparison tables have one or more columns per segment. */
  function table(cls, first, rest) {
    var t = H.el('div', 'ob-table ' + cls);
    t.style.setProperty('--ob-cols', first + ' repeat(' + rest + ', minmax(7ch, 1fr))');
    return t;
  }
  function block(title) {
    var b = H.el('div', 'ob-block');
    if (title) b.appendChild(H.el('div', 'ob-title sui-text-header', title));
    return b;
  }
  function segHead(segs, per) {
    var cols = ['Step'];
    segs.forEach(function (s) { per.forEach(function (p, i) { cols.push(i === 0 ? s.label + ' · ' + p : p); }); });
    return cols;
  }

  // ── Overview ──
  var OVERVIEW_ROWS = [
    ['Players', function (h) { return int(h.players); }],
    ['Active', function (h) { return int(h.active) + ' · ' + pct(h.activeRate); }],
    ['Churn', function (h) { return pct(h.churn); }],
    ['Signups started', function (h) { return int(h.started); }],
    ['Signup drop-off', function (h) { return pct(h.dropoff); }],
    ['Offered tutorial', function (h) { return int(h.offered); }],
    ['Finished', function (h) { return int(h.finished) + ' · ' + pct(h.finishedRate); }],
    ['Skipped', function (h) { return int(h.skipped) + ' · ' + pct(h.skippedRate); }],
    ['Quit', function (h) { return int(h.quit) + ' · ' + pct(h.quitRate); }],
    ['Median signup', function (h) { return dur(h.signupP50); }],
    ['Median tutorial', function (h) { return dur(h.tutorialP50); }],
  ];
  function viewOverview(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    if (segs.length === 1) {
      var h = headline(segs[0]);
      var hud = H.el('div', 'ob-hud');
      hud.appendChild(tile('Players', int(h.players)));
      hud.appendChild(tile('Active', int(h.active), pct(h.activeRate) + ' · ' + d.active_days + 'd', 'ok'));
      hud.appendChild(tile('Churn', pct(h.churn), 'idle ' + d.active_days + 'd+', h.churn > 0.5 ? 'bad' : null));
      hud.appendChild(tile('Signup drop-off', pct(h.dropoff), int(h.started) + ' started'));
      box.appendChild(hud);
      var hud2 = H.el('div', 'ob-hud');
      hud2.appendChild(tile('Offered', int(h.offered)));
      hud2.appendChild(tile('Finished', int(h.finished), pct(h.finishedRate), 'ok'));
      hud2.appendChild(tile('Skipped', int(h.skipped), pct(h.skippedRate)));
      hud2.appendChild(tile('Quit', int(h.quit), pct(h.quitRate), h.quitRate > 0.5 ? 'bad' : null));
      hud2.appendChild(tile('Signup', dur(h.signupP50), 'median'));
      hud2.appendChild(tile('Tutorial', dur(h.tutorialP50), 'median'));
      box.appendChild(hud2);
      box.appendChild(outcomeBar(segs[0].tutorial));
      return box;
    }
    var t = table('ob-compare', 'minmax(16ch, 1.4fr)', segs.length);
    t.appendChild(headRow([''].concat(segs.map(function (s) { return s.label; }))));
    var hs = segs.map(headline);
    OVERVIEW_ROWS.forEach(function (r) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-metric', r[0]);
      row.appendChild(cell(r[0], 'ob-step'));
      hs.forEach(function (h) { row.appendChild(cell(r[1](h), 'ob-n')); });
      t.appendChild(row);
    });
    box.appendChild(t);
    return box;
  }

  function outcomeBar(t) {
    t = t || {};
    var total = Number(t.offered) || 0;
    var wrap = H.el('div', 'ob-outcome');
    var strip = H.el('div', 'ob-stack');
    var legend = H.el('div', 'ob-legend');
    OUTCOMES.forEach(function (k) {
      var n = Number(t[k[0]]) || 0;
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

  // ── Funnels (signup from the servers, tutorial from player sessions) ──
  function dwellOf(seg, key) { return (seg && seg.dwell && seg.dwell[key]) || null; }
  function funnelSingle(seg, rows, withSkips) {
    var quitTop = topKeys(rows, function (r) { return r.dropped; }, FLAG_TOP);
    var slowTop = topKeys(rows, function (r) { var w = dwellOf(seg, r.key); return w && w.n >= 3 ? w.p50 : null; }, FLAG_TOP);
    var skipTop = withSkips ? topKeys(rows, function (r) { return r.skipped; }, FLAG_TOP) : [];
    var cols = ['Step', '', 'Reached', 'Kept', 'Lost so far', 'Quit here', 'Step drop'];
    if (withSkips) cols = cols.concat(['Skipped', 'Skip rate', 'Skipped so far']);
    cols = cols.concat(['Median', 'p90']);
    var t = H.el('div', 'ob-table ob-funnel' + (withSkips ? ' ob-funnel-skips' : ''));
    t.appendChild(headRow(cols));
    rows.forEach(function (r) {
      var w = dwellOf(seg, r.key);
      var aside = r.next == null && r.previous == null;
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', r.key);
      row.appendChild(cell(stepLabel(r.key), 'ob-step', r.key));
      row.appendChild(bar(r.retained, aside ? 'is-aside' : ''));
      row.appendChild(cell(int(r.reached), 'ob-n'));
      row.appendChild(cell(pct(r.retained), 'ob-n'));
      row.appendChild(cell(pct(r.lost), 'ob-n'));
      var quit = quitTop.indexOf(r.key) >= 0;
      row.appendChild(cell(r.dropped == null ? '—' : int(r.dropped), 'ob-n' + (quit ? ' is-bad' : '')));
      row.appendChild(cell(pct(r.step_drop), 'ob-n' + (quit ? ' is-bad' : '')));
      if (withSkips) {
        var sk = skipTop.indexOf(r.key) >= 0;
        row.appendChild(cell(r.skipped ? int(r.skipped) : '—', 'ob-n' + (sk ? ' is-slow' : '')));
        row.appendChild(cell(r.skipped ? pct(r.skip_rate) : '—', 'ob-n'));
        row.appendChild(cell(pct(r.cum_skip), 'ob-n'));
      }
      var slow = slowTop.indexOf(r.key) >= 0;
      row.appendChild(cell(w ? dur(w.p50) : '—', 'ob-n' + (slow ? ' is-slow' : ''), w ? 'Time until the next step, ' + w.n + ' players' : null));
      row.appendChild(cell(w ? dur(w.p90) : '—', 'ob-n'));
      t.appendChild(row);
    });
    return t;
  }
  function funnelCompare(segs, pick, withSkips) {
    var per = withSkips ? ['Kept', 'Step drop', 'Skip'] : ['Kept', 'Lost', 'Step drop'];
    var first = null;
    segs.forEach(function (s) { var r = pick(s); if (!first && r && r.length) first = r; });
    var t = table('ob-compare', 'minmax(18ch, 1.4fr)', segs.length * per.length);
    t.appendChild(headRow(segHead(segs, per)));
    (first || []).forEach(function (r0) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', r0.key);
      row.appendChild(cell(stepLabel(r0.key), 'ob-step', r0.key));
      segs.forEach(function (s) {
        var r = (pick(s) || []).filter(function (x) { return x.key === r0.key; })[0] || {};
        row.appendChild(cell(pct(r.retained), 'ob-n'));
        if (withSkips) {
          row.appendChild(cell(pct(r.step_drop), 'ob-n'));
          row.appendChild(cell(r.skipped ? pct(r.skip_rate) : '—', 'ob-n'));
        } else {
          row.appendChild(cell(pct(r.lost), 'ob-n'));
          row.appendChild(cell(pct(r.step_drop), 'ob-n'));
        }
      });
      t.appendChild(row);
    });
    return t;
  }
  function viewSignup(d) {
    var box = H.el('div', 'ob-view');
    var segs = (d.segments || []).filter(function (s) { return s.signup; });
    if (!segs.length) {
      if (d.filters && (d.filters.activity || d.filters.compare === 'activity')) box.appendChild(H.stateBlock('empty', 'Activity is only known once signup finishes'));
      else box.appendChild(emptyOr(d, 'No signups recorded'));
      return box;
    }
    var b = block();
    if (segs.length === 1) b.appendChild(funnelSingle(segs[0], segs[0].signup.steps || [], false));
    else b.appendChild(funnelCompare(segs, function (s) { return s.signup.steps; }, false));
    box.appendChild(b);
    return box;
  }
  function viewTutorial(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    if (segs.length === 1) {
      var s = segs[0];
      if (!s.tutorial || !s.tutorial.offered) { box.appendChild(emptyOr(d, 'No tutorial sessions yet')); return box; }
      box.appendChild(outcomeBar(s.tutorial));
      box.appendChild(funnelSingle(s, s.tutorial.steps || [], true));
      return box;
    }
    var o = table('ob-compare', 'minmax(16ch, 1.4fr)', segs.length);
    o.appendChild(headRow([''].concat(segs.map(function (x) { return x.label; }))));
    [['Offered', 'offered', null], ['Finished', 'completed', 'completion_rate'], ['Skipped', 'declined', 'decline_rate'], ['Quit', 'left', 'quit_rate'], ['Playing', 'playing', null]].forEach(function (m) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-metric', m[0]);
      row.appendChild(cell(m[0], 'ob-step'));
      segs.forEach(function (x) { var t = x.tutorial || {}; row.appendChild(cell(int(t[m[1]]) + (m[2] ? ' · ' + pct(t[m[2]]) : ''), 'ob-n')); });
      o.appendChild(row);
    });
    box.appendChild(o);
    box.appendChild(funnelCompare(segs, function (x) { return x.tutorial && x.tutorial.steps; }, true));
    return box;
  }

  // ── Distributions (Players, Retention) ──
  function distBlock(title, segs, pick, kind) {
    var b = block(title);
    var ds = segs.map(pick);
    var t = table('ob-dist', 'minmax(12ch, 1.2fr)', 7);
    t.appendChild(headRow(['', 'Players', 'None', 'Mean', 'Median', 'p75', 'p90', 'Max']));
    segs.forEach(function (s, i) {
      var x = ds[i] || {};
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-seg', s.key);
      row.appendChild(cell(segs.length > 1 ? s.label : 'All', 'ob-step'));
      row.appendChild(cell(int(x.n), 'ob-n'));
      row.appendChild(cell(x.n ? pct(x.zero / x.n) : '—', 'ob-n'));
      ['mean', 'p50', 'p75', 'p90', 'max'].forEach(function (k) { row.appendChild(cell(x.n ? fmtKind(kind, x[k]) : '—', 'ob-n')); });
      t.appendChild(row);
    });
    b.appendChild(t);
    var hist = (ds[0] && ds[0].hist) || [];
    if (!hist.length) return b;
    if (segs.length === 1) {
      var h = H.el('div', 'ob-table ob-hist');
      var top = Math.max.apply(null, hist.map(function (x) { return x.n; }).concat([1]));
      hist.forEach(function (bk) {
        var row = H.el('div', 'ob-row');
        row.appendChild(cell(bucketLabel(bk, kind), 'ob-step'));
        row.appendChild(bar(bk.n / top));
        row.appendChild(cell(int(bk.n), 'ob-n'));
        row.appendChild(cell(pct(ratio(bk.n, ds[0].n)), 'ob-n'));
        h.appendChild(row);
      });
      b.appendChild(h);
    } else {
      var c = table('ob-compare', 'minmax(12ch, 1.2fr)', segs.length);
      c.appendChild(headRow([''].concat(segs.map(function (s) { return s.label; }))));
      hist.forEach(function (bk, i) {
        var row = H.el('div', 'ob-row');
        row.appendChild(cell(bucketLabel(bk, kind), 'ob-step'));
        ds.forEach(function (x) { var n = x && x.hist && x.hist[i] ? x.hist[i].n : 0; row.appendChild(cell(pct(ratio(n, x && x.n)), 'ob-n')); });
        c.appendChild(row);
      });
      b.appendChild(c);
    }
    return b;
  }
  function viewPlayers(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    STATS.forEach(function (st) {
      box.appendChild(distBlock(st[1], segs, function (s) { return s.stats && s.stats[st[0]]; }, st[2]));
    });
    return box;
  }
  function viewRetention(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    var t = table('ob-compare', 'minmax(16ch, 1.4fr)', segs.length);
    t.appendChild(headRow([''].concat(segs.map(function (s) { return segs.length > 1 ? s.label : 'All'; }))));
    [['Players', function (s) { return int(s.players); }],
     ['Active ' + d.active_days + 'd', function (s) { return int(s.active) + ' · ' + pct(s.active_rate); }],
     ['Inactive', function (s) { return int(s.inactive); }],
     ['Churn', function (s) { return pct(s.churn_rate) + ' of ' + int(s.churn_base); }]].forEach(function (m) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-metric', m[0]);
      row.appendChild(cell(m[0], 'ob-step'));
      segs.forEach(function (s) { row.appendChild(cell(m[1](s), 'ob-n')); });
      t.appendChild(row);
    });
    box.appendChild(t);
    box.appendChild(distBlock('Play length of inactive players after signup', segs, function (s) { return s.play_length; }, 'secs'));
    return box;
  }

  // ── Timing, Daily, Guilds, Recent ──
  function viewTiming(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    var t = table('ob-compare', 'minmax(14ch, 1.2fr)', segs.length);
    t.appendChild(headRow([''].concat(segs.map(function (s) { return segs.length > 1 ? s.label : 'Median · p90 · players'; }))));
    DURATIONS.forEach(function (k) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-metric', k[0]);
      row.appendChild(cell(k[1], 'ob-step'));
      segs.forEach(function (s) {
        var x = s.durations && s.durations[k[0]];
        row.appendChild(cell(x ? dur(x.p50) + ' · ' + dur(x.p90) + ' · ' + int(x.n) : '—', 'ob-n'));
      });
      t.appendChild(row);
    });
    box.appendChild(t);
    var dwell = (segs[0] && segs[0].dwell) || {};
    var keys = Object.keys(dwell).filter(function (k) { return dwell[k] && dwell[k].n >= 3; })
      .sort(function (a, b) { return dwell[b].p50 - dwell[a].p50; }).slice(0, 15);
    if (!keys.length) { box.appendChild(emptyOr(d, 'No step timings yet')); return box; }
    var max = dwell[keys[0]].p90 || dwell[keys[0]].p50 || 1;
    var s = H.el('div', 'ob-table ob-slow');
    s.appendChild(headRow(['Slowest steps', '', 'Median', 'p90', 'Players'].concat(segs.length > 1 ? segs.slice(1).map(function (x) { return x.label; }) : [])));
    keys.forEach(function (k) {
      var w = dwell[k];
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', k);
      row.appendChild(cell((k.indexOf('signup.') === 0 ? 'Signup · ' : '') + stepLabel(k), 'ob-step', k));
      row.appendChild(bar(w.p50 / max, 'is-time'));
      row.appendChild(cell(dur(w.p50), 'ob-n'));
      row.appendChild(cell(dur(w.p90), 'ob-n'));
      row.appendChild(cell(int(w.n), 'ob-n'));
      segs.slice(1).forEach(function (x) { var o = x.dwell && x.dwell[k]; row.appendChild(cell(o ? dur(o.p50) : '—', 'ob-n')); });
      s.appendChild(row);
    });
    if (segs.length > 1) s.style.setProperty('--ob-cols', 'minmax(18ch, 1.4fr) minmax(8ch, 1fr) repeat(' + (3 + segs.length - 1) + ', minmax(6ch, .6fr))');
    box.appendChild(s);
    return box;
  }

  function viewDaily(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    var days = {};
    segs.forEach(function (s, i) { (s.daily || []).forEach(function (x) { (days[x.day] = days[x.day] || {})[i] = x; }); });
    var order = Object.keys(days).sort().reverse();
    if (!order.length) { box.appendChild(emptyOr(d, 'No signups sampled yet')); return box; }
    if (segs.length === 1) {
      var t = H.el('div', 'ob-table ob-daily');
      t.appendChild(headRow(['Day', 'Signed up', 'Offered', 'Finished', 'Skipped', '', 'Finish rate']));
      order.forEach(function (day) {
        var x = days[day][0];
        var row = H.el('div', 'ob-row');
        row.appendChild(cell(day, 'ob-step'));
        row.appendChild(cell(int(x.signed_up), 'ob-n'));
        row.appendChild(cell(int(x.offered), 'ob-n'));
        row.appendChild(cell(int(x.completed), 'ob-n'));
        row.appendChild(cell(int(x.declined), 'ob-n'));
        var r = ratio(x.completed, x.offered);
        row.appendChild(bar(r));
        row.appendChild(cell(pct(r), 'ob-n'));
        t.appendChild(row);
      });
      box.appendChild(t);
      return box;
    }
    var c = table('ob-compare', 'minmax(11ch, 1fr)', segs.length * 2);
    c.appendChild(headRow(segHead(segs, ['Signed up', 'Finish rate']).map(function (h, i) { return i === 0 ? 'Day' : h; })));
    order.forEach(function (day) {
      var row = H.el('div', 'ob-row');
      row.appendChild(cell(day, 'ob-step'));
      segs.forEach(function (s, i) {
        var x = days[day][i];
        row.appendChild(cell(x ? int(x.signed_up) : '—', 'ob-n'));
        row.appendChild(cell(x ? pct(ratio(x.completed, x.offered)) : '—', 'ob-n'));
      });
      c.appendChild(row);
    });
    box.appendChild(c);
    return box;
  }

  function viewGuilds(d) {
    var box = H.el('div', 'ob-view');
    var crawl = (d.crawl && d.crawl.guilds) || {};
    var t = H.el('div', 'ob-table ob-guilds');
    t.appendChild(headRow(['Guild', 'Players', 'Active', 'Started', 'Signed up', 'Offered', 'Finished', 'Timed', 'No telemetry', 'Read']));
    (d.guilds || []).forEach(function (g) {
      var row = H.el('div', 'ob-row' + (g.status === 'ok' ? '' : ' is-quiet'));
      row.setAttribute('data-guild', g.id);
      var name = H.el('span', 'ob-c ob-step');
      name.appendChild(H.el('span', null, (g.name || g.id)));
      name.appendChild(H.el('span', 'ob-sub', (g.tag ? g.tag + ' · ' : '') + g.id + (g.error ? ' · ' + g.error : '')));
      row.appendChild(name);
      var o = g.outcome || {};
      var live = g.status === 'ok';
      row.appendChild(cell(int(g.players), 'ob-n'));
      row.appendChild(cell(int(g.active), 'ob-n'));
      row.appendChild(cell(live ? int(g.started) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(g.signed_up) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(o.offered) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(o.completed) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(g.sampled) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(g.untracked) : '—', 'ob-n'));
      var c = crawl[g.id];
      var read = !c ? '—' : (int(c.fetched) + ' / ' + int(Math.max(0, (c.candidates || 0) - (c.team_skipped || 0))));
      row.appendChild(cell(read, 'ob-n' + (c && c.errors ? ' is-bad' : ''), c && c.last_error ? c.last_error : null));
      t.appendChild(row);
    });
    box.appendChild(t);
    return box;
  }

  var OUTCOME_LABEL = { completed: 'Finished', declined: 'Skipped', left: 'Quit', playing: 'Playing', deciding: 'At offer' };
  function viewRecent(d) {
    var box = H.el('div', 'ob-view');
    var rows = d.recent || [];
    if (!rows.length) { box.appendChild(emptyOr(d, 'No sessions sampled yet')); return box; }
    var tags = {};
    (d.guilds || []).forEach(function (g) { tags[g.id] = g.tag || g.id; });
    var t = H.el('div', 'ob-table ob-recent');
    t.appendChild(headRow(['Player', 'Guild', 'Last seen', 'Outcome', 'Got to', 'Signup', 'Tutorial'], [3, 4]));
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
      t.appendChild(row);
    });
    box.appendChild(t);
    return box;
  }

  // ── Loading ──
  // A read answers at once with whatever the background crawls have so far, so
  // an empty page means "not read yet" while they run and "nothing" after.
  function reading(d) { return !!(d && d.crawl && d.crawl.running); }
  function hasData(d) {
    var p = (d.crawl && d.crawl.players) || {};
    return (d.segments || []).some(function (s) { return s.sessions > 0; }) || p.known > 0;
  }
  function progress(d) {
    var c = d.crawl || {}, g = c.guilds || {}, p = c.players || {};
    var fetched = Object.keys(g).reduce(function (a, k) { return a + (Number(g[k].fetched) || 0); }, 0);
    var parts = ['Reading every guild'];
    if (fetched) parts.push(int(fetched) + ' sessions');
    if (p.known) parts.push(int(p.known) + ' players');
    return parts.join(' · ');
  }
  function emptyOr(d, text) { return reading(d) ? H.stateBlock('loading', progress(d)) : H.stateBlock('empty', text); }
  // Pages folded from the crawls; Signup and Guilds come from the servers' own reads.
  var CRAWLED = { overview: 1, tutorial: 1, players: 1, retention: 1, timing: 1, daily: 1, recent: 1 };

  function footLine(d) {
    var c = d.crawl || {}, p = c.players || {};
    var sessions = (d.segments || []).reduce(function (a, s) { return a + (s.sessions || 0); }, 0);
    var parts = [int(sessions) + ' onboarding sessions on ' + (d.version || '—')];
    if (p.known) parts.push('ledgers read for ' + int(p.ledgers) + ' of ' + int(p.known) + ' players');
    if (c.running) parts.push('reading…');
    else if (c.finished_ms) parts.push('read ' + H.ago(c.finished_ms) + ' ago');
    var foot = H.el('div', 'ob-foot fstat-l');
    if (c.running) foot.appendChild(H.el('i', H.iconClass('icon-in-progress', 'sui-icon-sm')));
    foot.appendChild(H.el('span', null, parts.join(' · ')));
    return foot;
  }

  // ── Controls ──
  function controls(d, p, set) {
    var o = d.options || {};
    var f = d.filters || {};
    var bar1 = H.el('div', 'ob-controls');
    var ifaces = [{ value: '', label: 'Every interface' }].concat((o.interfaces || []).map(function (i) { return { value: i, label: i === 'none' ? 'No telemetry' : i }; }));
    var guilds = [{ value: '', label: 'Every guild' }].concat((o.guilds || []).map(function (g) { return { value: g.id, label: g.label + ' · ' + g.id }; }));
    bar1.appendChild(H.field('Interface', H.selectBox(f.interface || '', ifaces, function (v) { set({ iface: v }); })));
    bar1.appendChild(H.field('Guild', H.selectBox(f.guild || '', guilds, function (v) { set({ guild: v }); })));
    bar1.appendChild(H.field('Players', H.selectBox(f.activity || '', ACTIVITY, function (v) { set({ activity: v }); })));
    bar1.appendChild(H.field('Compare', H.selectBox(f.compare || '', COMPARE, function (v) { set({ compare: v }); })));
    bar1.appendChild(H.field('Active within', H.selectBox(String(d.active_days || 7), ACTIVE, function (v) { set({ active: v }); })));
    bar1.appendChild(H.field('Counts as quit after', H.selectBox(String(d.idle_hours || 24), IDLE, function (v) { set({ idle: v }); })));
    var versions = (d.versions || []).map(function (v) { return { value: v, label: v }; });
    if (versions.length > 1) bar1.appendChild(H.field('Tutorial', H.selectBox(d.version, versions, function (v) { set({ version: v }); })));
    return bar1;
  }
  function argsOf(p) {
    var a = { idleHours: Number(p.idle) || 24, activeDays: Number(p.active) || 7,
      filters: { interface: p.iface || null, guild: p.guild || null, activity: p.activity || null, compare: p.compare || null } };
    if (p.version) a.version = p.version;
    return a;
  }

  // ── The card ──
  var DRAW = { overview: viewOverview, signup: viewSignup, tutorial: viewTutorial, players: viewPlayers, retention: viewRetention,
    timing: viewTiming, daily: viewDaily, guilds: viewGuilds, recent: viewRecent };
  T.register('onboarding', {
    label: 'Telemetry', describe: function (p) { return 'Telemetry' + (p && p.version ? ' · ' + p.version : ''); },
    cadenceMs: 30000, defaultWidth: 3,
    params: [],
    render: function (host, p, ctx) {
      p = p || {};
      var st = OB.cards[ctx.id] || (OB.cards[ctx.id] = { view: 'overview', last: null });
      var args = argsOf(p);
      if (st.fresh) { args.fresh = true; st.fresh = false; }
      function set(patch) { T.setParams(ctx.id, Object.assign({}, p, patch)); }
      function draw(d) {
        st.last = d;
        host.innerHTML = '';
        var wrap = H.el('div', 'ob');
        wrap.appendChild(controls(d, p, set));
        wrap.appendChild(H.navStrip(VIEWS.map(function (v) { return { key: v[0], label: v[1] }; }), st.view, function (k) { st.view = k; draw(st.last); }));
        if (CRAWLED[st.view] && reading(d) && !hasData(d)) wrap.appendChild(H.stateBlock('loading', progress(d)));
        else wrap.appendChild((DRAW[st.view] || viewOverview)(d));
        wrap.appendChild(footLine(d));
        host.appendChild(wrap);
        // The crawl fills in between reads: look again sooner than the cadence while it runs.
        clearTimeout(st.soon);
        if (reading(d)) st.soon = setTimeout(function () { T.refresh(ctx.id); }, 5000);
      }
      if (st.last && !host.firstChild) draw(st.last);
      else if (!st.last) host.appendChild(H.stateBlock('loading', 'Reading every guild'));
      return invoke('terminal_onboarding', args).then(draw).catch(function (e) {
        host.innerHTML = '';
        host.appendChild(H.stateBlock('error', 'Telemetry unavailable: ' + e));
      });
    },
    doors: function (c) {
      return [{ icon: 'icon-refresh', title: 'Read again now', onClick: function () {
        var st = OB.cards[c.id] || (OB.cards[c.id] = { view: 'overview', last: null });
        st.fresh = true;
        T.setParams(c.id, Object.assign({}, c.params || {}));
      } }];
    },
  });

  T.onboarding = { stepLabel: stepLabel, pct: pct, topKeys: topKeys, headline: headline, bucketLabel: bucketLabel, fmtKind: fmtKind, argsOf: argsOf };
})();
