// STRUCTS TERMINAL — the Telemetry card (⌘K → TELEMETRY), onboarding analytics.
//
// How far new players get through signup and Combat Training, how long it
// takes, where they stop or skip, and what players do afterwards — summed over
// EVERY guild's server and the whole chain (`terminal_onboarding`,
// mcp/onboarding.rs + mcp/onboarding_players.rs).
//
// Every page reads the same filters (interface, guild, active/inactive,
// replicants) and can be split by one of them (Compare). Replicants — players
// that hand another player full control of themselves — are left out unless
// the box is ticked. The payload is a list of SEGMENTS —
// one when nothing is compared — and each page draws one column (or one row)
// per segment. Signup steps come from the guild servers' own funnels (every
// session, even ones that quit before a player existed), Tutorial leads with
// their unique players, and Runs is every started run; everything else is
// folded in Rust from new players' signup sessions and the chain's player
// tables, which background crawls grow between reads. Trends is the app's own
// daily record, because nothing upstream keeps one.
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };

  /* Pages by the question they answer, not the source that feeds them. */
  var NAV = [['Growth', [['overview', 'Overview'], ['trends', 'Trends'], ['daily', 'Daily']]],
    ['Onboarding', [['signup', 'Signup'], ['tutorial', 'Tutorial'], ['runs', 'Runs'], ['timing', 'Timing']]],
    ['Players', [['players', 'Players'], ['retention', 'Retention'], ['recent', 'Recent']]],
    ['Network', [['guilds', 'Guilds'], ['health', 'Health']]]];
  /* The tutorial's phases, in play order; a step belongs to the first prefix it starts with. */
  var PHASES = [['signup', 'Signup'], ['orientation', 'Offer'], ['tutorial.intro', 'Intro'], ['tutorial.raid', 'Raid'], ['tutorial.rebuild', 'Rebuild'],
    ['tutorial.defend', 'Defend'], ['tutorial.first_attack', 'First attack'], ['tutorial.bomber', 'Bomber'], ['tutorial.free_play', 'Free play'],
    ['tutorial.new_cmd_ship', 'New Cmd Ship'], ['tutorial.end', 'End']];
  var IDLE = [{ value: '6', label: 'Quit 6h' }, { value: '24', label: 'Quit 24h' }, { value: '72', label: 'Quit 3d' }, { value: '168', label: 'Quit 7d' }];
  var ACTIVE = [{ value: '1', label: 'Active 1d' }, { value: '7', label: 'Active 7d' }, { value: '30', label: 'Active 30d' }];
  var ACTIVITY = [{ value: '', label: 'All players' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];
  var COMPARE = [{ value: '', label: 'Compare: nothing' }, { value: 'interface', label: 'Compare: interface' }, { value: 'guild', label: 'Compare: guild' }, { value: 'activity', label: 'Compare: active / inactive' }, { value: 'replicant', label: 'Compare: human / replicant' }, { value: 'version', label: 'Compare: tutorial version' }];
  var DURATIONS = [['signup', 'Signup'], ['chain_wait', 'Chain wait'], ['to_offer', 'To offer'], ['decision', 'Decision'], ['tutorial', 'Tutorial'], ['total', 'Whole run']];
  var OUTCOMES = [['completed', 'Finished'], ['declined', 'Skipped'], ['left', 'Quit'], ['playing', 'Playing']];
  var STATS = [['mined', 'Ore mined', 'ore'], ['refined', 'Alpha refined', 'alpha'], ['planets', 'Planets completed', 'count'],
    ['raids_initiated', 'Raids initiated', 'count'], ['raids_won', 'Raids won', 'count']];
  var MILESTONES = [['signed_up', 'Signed up'], ['acted', 'Acted'], ['mined', 'Mined'], ['refined', 'Refined'], ['planet', 'Completed a planet'], ['raided', 'Raided'], ['active', 'Still active']];
  var TRENDS = [['humans', 'Humans'], ['activated', 'Ever acted'], ['active_1d', 'Active in a day'], ['active_7d', 'Active in 7 days'], ['active_30d', 'Active in 30 days'],
    ['mined', 'Mined'], ['refined', 'Refined'], ['raided', 'Raided'], ['signups_started', 'Signups started'], ['signed_up', 'Signups finished'],
    ['tutorial_players', 'Tutorial players'], ['tutorial_completed', 'Tutorial finishers'], ['replicants', 'Replicants']];
  var FLAG_TOP = 3;
  /* Below this many, a percentage claims more than the count can carry. */
  var SMALL_N = 20;

  var OB = { cards: {}, open: {} };

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
  /* `n` of `total`, as a share once there are enough to say so. */
  function share(n, total) {
    if (!(total > 0)) return '—';
    return total >= SMALL_N ? pct(n / total) : int(n) + ' of ' + int(total);
  }
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
  /* A segment's tutorial outcomes: the servers' unique players where they can
   * count this population, else the signup sample. */
  function tutorialOf(seg) {
    var u = seg && seg.tutorial_players, t = (seg && seg.tutorial) || {};
    if (u) return { unique: true, offered: u.players, completed: u.completed, declined: u.declined,
      left: (u.left_at_offer || 0) + (u.left_during_tutorial || 0), playing: u.in_progress, started: u.started,
      newPlayers: u.new_players, existing: u.existing_players, revisited: u.revisited };
    return { unique: false, offered: t.offered, completed: t.completed, declined: t.declined, left: t.left, playing: t.playing };
  }
  function headline(seg) {
    var t = tutorialOf(seg), su = seg && seg.signup, dd = (seg && seg.durations) || {}, up = seg && seg.take_up;
    return {
      players: seg ? seg.players : null, active: seg ? seg.active : null, activeRate: seg ? seg.active_rate : null,
      neverActed: seg ? seg.never_acted : null, churned: seg ? seg.churned : null, churnBase: seg ? seg.churn_base : null, churn: seg ? seg.churn_rate : null,
      started: su ? su.started : null, signed: su ? su.signed_up : null, dropoff: su ? su.dropoff_rate : null,
      unique: t.unique, offered: t.offered, finished: t.completed, skipped: t.declined, quit: t.left,
      takeUp: up ? ratio(up.started, up.players) : null, takeUpBase: up ? up.players : null, takeUpN: up ? up.started : null,
      signupP50: dd.signup ? dd.signup.p50 : null, tutorialP50: dd.tutorial ? dd.tutorial.p50 : null,
    };
  }

  function phaseOf(key) {
    key = String(key || '');
    if (key === 'tutorial.loading') return 1;
    for (var i = 0; i < PHASES.length; i++) if (key === PHASES[i][0] || key.indexOf(PHASES[i][0] + '.') === 0) return i;
    return -1;
  }
  /* A cohort cell's shade, 0 (nobody left) to 4 (nearly everyone). */
  function heatBand(rate) { return rate >= 0.95 ? 4 : rate >= 0.8 ? 3 : rate >= 0.4 ? 2 : rate >= 0.1 ? 1 : 0; }
  /* The tutorial's steps folded to phases: who reached each, who went on, and
   * how the rest left. A phase the design does not have is not drawn. */
  function phaseRows(seg) {
    var rows = [], steps = (seg && seg.tutorial && seg.tutorial.steps) || [];
    PHASES.forEach(function (ph, i) {
      if (i === 0) return;
      var mine = steps.filter(function (r) { return phaseOf(r.key) === i; });
      if (!mine.length) return;
      var reached = mine.reduce(function (m, r) { return Math.max(m, r.reached || 0); }, 0);
      var skipped = mine.reduce(function (m, r) { return m + (r.skipped || 0); }, 0);
      var time = mine.reduce(function (m, r) { var w = dwellOf(seg, r.key); return m + (w ? w.p50 || 0 : 0); }, 0);
      rows.push({ phase: i, label: ph[1], reached: reached, skipped: skipped, time: time || null });
    });
    var signed = seg && seg.sessions, first = rows[0];
    if (first && signed >= first.reached) rows.unshift({ phase: 0, label: 'Signed up', reached: signed, skipped: 0, time: seg.durations && seg.durations.signup ? seg.durations.signup.p50 : null });
    rows.forEach(function (r, i) {
      var next = rows[i + 1];
      r.left = next ? Math.min(next.reached, r.reached) : r.reached;
      r.skipped = Math.min(r.skipped, r.reached - r.left);
      r.stopped = r.reached - r.left - r.skipped;
    });
    return rows;
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
  function hudBlock(title, hud) {
    var b = block(title);
    b.appendChild(hud);
    return b;
  }
  /* A row whose step opens the players who stopped there. */
  function stepCell(d, key, table, row) {
    var who = d && d.stopped && d.stopped[key];
    if (!who) return cell(stepLabel(key), 'ob-step', key);
    var a = H.el('a', 'ob-c ob-step ob-link', stepLabel(key));
    a.href = 'javascript:void(0)';
    a.title = key;
    a.addEventListener('click', function () {
      OB.open[key] = !OB.open[key];
      syncWho(d, key, table, row);
    });
    return a;
  }
  function syncWho(d, key, table, row) {
    var next = row.nextSibling;
    if (next && next.classList && next.classList.contains('ob-who')) table.removeChild(next);
    row.classList.toggle('is-open', !!OB.open[key]);
    if (OB.open[key]) table.insertBefore(whoList(d, key), row.nextSibling);
  }
  function whoList(d, key, list) {
    var who = list || d.stopped[key], tags = guildTags(d);
    var box = H.el('div', 'ob-who');
    box.setAttribute('data-who', key);
    who.players.forEach(function (x) {
      var r = H.el('div', 'ob-who-row');
      r.setAttribute('data-player', x.player_id);
      r.appendChild(playerLink(x));
      r.appendChild(cell(tags[x.guild_id] || x.guild_id, 'ob-n'));
      r.appendChild(cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-n'));
      r.appendChild(cell(OUTCOME_LABEL[x.outcome] || x.outcome, 'ob-out-' + x.outcome));
      box.appendChild(r);
    });
    if (who.total > who.players.length) box.appendChild(H.el('div', 'ob-sub fstat-l', int(who.total - who.players.length) + ' more'));
    return box;
  }
  function guildTags(d) {
    var tags = {};
    (d.guilds || []).forEach(function (g) { tags[g.id] = g.tag || g.id; });
    return tags;
  }
  function playerLink(x, tag) {
    var who = H.el('a', 'ob-c ob-step ob-link');
    who.href = 'javascript:void(0)';
    who.appendChild(H.el('span', null, x.name || x.player_id));
    var sub = (x.name ? [x.player_id] : []).concat(tag ? [tag] : []).join(' · ');
    if (sub) who.appendChild(H.el('span', 'ob-sub', sub));
    who.addEventListener('click', function () { T.execute('PLAYER ' + x.player_id); });
    return who;
  }
  function segHead(segs, per) {
    var cols = ['Step'];
    segs.forEach(function (s) { per.forEach(function (p, i) { cols.push(i === 0 ? s.label + ' · ' + p : p); }); });
    return cols;
  }

  // ── Overview ──
  var OVERVIEW_ROWS = [
    ['Players', function (h) { return int(h.players); }],
    ['Active', function (h) { return int(h.active) + ' · ' + share(h.active, h.players); }],
    ['Never acted', function (h) { return int(h.neverActed) + ' · ' + share(h.neverActed, h.players); }],
    ['Churn', function (h) { return share(h.churned, h.churnBase); }],
    ['Signups started', function (h) { return int(h.started); }],
    ['Signup drop-off', function (h) { return h.started >= SMALL_N ? pct(h.dropoff) : share(h.started - h.signed, h.started); }],
    ['Tutorial players', function (h) { return int(h.offered); }],
    ['Take-up', function (h) { return share(h.takeUpN, h.takeUpBase); }],
    ['Finished', function (h) { return int(h.finished) + ' · ' + share(h.finished, h.offered); }],
    ['Skipped', function (h) { return int(h.skipped) + ' · ' + share(h.skipped, h.offered); }],
    ['Quit', function (h) { return int(h.quit) + ' · ' + share(h.quit, h.offered); }],
    ['Median signup', function (h) { return dur(h.signupP50); }],
    ['Median tutorial', function (h) { return dur(h.tutorialP50); }],
  ];
  function viewOverview(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    if (segs.length === 1) {
      var s = segs[0], h = headline(s), lc = s.lifecycle || {};
      var month = (lc.today || 0) + (lc.week || 0) + (lc.month || 0);
      var hud = H.el('div', 'ob-hud');
      hud.appendChild(tile('New this week', int(lc.new_7d), 'joined'));
      hud.appendChild(tile('Active today', int(lc.today), share(lc.today, h.players) + ' of ' + int(h.players), 'ok'));
      hud.appendChild(tile('Active ' + d.active_days + 'd', int(h.active), share(h.active, h.players) + ' of ' + int(h.players), 'ok'));
      hud.appendChild(tile('Today / month', pct(ratio(lc.today, month)), int(lc.today) + ' of ' + int(month)));
      box.appendChild(hud);
      box.appendChild(lifecycleBlock(lc));
      var two = H.el('div', 'ob-two');
      two.appendChild(activationBlock(d, segs));
      two.appendChild(pathBlock(s));
      box.appendChild(two);
      var w1 = weekOneBlock(s);
      if (w1) box.appendChild(w1);
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

  function lifecycleBlock(lc) {
    var b = block('Where players are now');
    var strip = H.el('div', 'ob-stack'), legend = H.el('div', 'ob-legend');
    [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['gone', 'Gone'], ['never', 'Never acted']].forEach(function (k) {
      var n = Number(lc[k[0]]) || 0;
      var seg = H.el('span', 'ob-seg ob-life-' + k[0]);
      seg.style.flexGrow = String(n);
      seg.title = k[1] + ' ' + int(n);
      if (n > 0) strip.appendChild(seg);
      var l = H.el('span', 'ob-key');
      l.setAttribute('data-life', k[0]);
      l.appendChild(H.el('span', 'ob-swatch ob-life-' + k[0]));
      l.appendChild(H.el('span', null, k[1]));
      l.appendChild(H.el('span', 'ob-v', int(n)));
      legend.appendChild(l);
    });
    b.appendChild(strip);
    b.appendChild(legend);
    return b;
  }
  function pathBlock(s) {
    var t = s.tutorial || {}, su = s.signup, steps = t.steps || [];
    var loaded = steps.filter(function (r) { return r.key === 'tutorial.loading'; })[0];
    var rows = su ? [['Started signup', su.started], ['Signed up', su.signed_up]] : [];
    rows = rows.concat([['Reached offer', t.offered], ['Started tutorial', loaded ? loaded.reached : null], ['Finished', t.completed]]);
    var top = rows.reduce(function (m, r) { return Math.max(m, Number(r[1]) || 0); }, 0);
    var b = block(su ? 'New player path' : 'New player path · sample of ' + int(s.sessions));
    var tb = H.el('div', 'ob-table ob-path');
    rows.forEach(function (r) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-path', r[0]);
      row.appendChild(cell(r[0], 'ob-step'));
      row.appendChild(bar(ratio(r[1], top), 'is-aside'));
      row.appendChild(cell(int(r[1]), 'ob-n ob-v'));
      tb.appendChild(row);
    });
    b.appendChild(tb);
    return b;
  }
  /* The last cohorts big enough to read, by how many outlasted their first week. */
  function weekOneBlock(s) {
    var rows = (s.cohorts || []).filter(function (c) { return c.n >= 10 && c.alive && c.alive.length; }).slice(-7);
    if (!rows.length) return null;
    var b = block('Still acting after 1 week');
    var g = H.el('div', 'ob-week1');
    g.style.setProperty('--ob-weeks', rows.length);
    rows.forEach(function (c) {
      var rate = ratio(c.alive[0], c.n);
      var col = H.el('div', 'ob-week');
      col.setAttribute('data-week', c.week);
      col.appendChild(H.el('span', 'ob-v', share(c.alive[0], c.n)));
      var track = H.el('span', 'ob-week-track');
      var fill = H.el('span', 'ob-week-fill ob-heat-' + heatBand(rate));
      fill.style.height = (rate * 100) + '%';
      track.appendChild(fill);
      col.appendChild(track);
      col.appendChild(H.el('span', null, c.week));
      col.appendChild(H.el('span', 'ob-sub', int(c.n) + ' joined'));
      g.appendChild(col);
    });
    b.appendChild(g);
    return b;
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
      seg.title = k[1] + ' ' + int(n) + ' · ' + share(n, total);
      if (n > 0) strip.appendChild(seg);
      var l = H.el('span', 'ob-key');
      l.appendChild(H.el('span', 'ob-swatch ob-seg-' + k[0]));
      l.appendChild(H.el('span', 'fstat-l', k[1] + ' ' + int(n) + (total >= SMALL_N ? ' · ' + pct(ratio(n, total)) : '')));
      legend.appendChild(l);
    });
    wrap.appendChild(strip);
    wrap.appendChild(legend);
    return wrap;
  }

  // ── Funnels (signup from the servers, tutorial from player sessions) ──
  function dwellOf(seg, key) { return (seg && seg.dwell && seg.dwell[key]) || null; }
  function funnelSingle(seg, rows, withSkips, d) {
    var quitTop = topKeys(rows, function (r) { return r.dropped; }, FLAG_TOP);
    var slowTop = topKeys(rows, function (r) { var w = dwellOf(seg, r.key); return w && w.n >= 3 ? w.p50 : null; }, FLAG_TOP);
    var skipTop = withSkips ? topKeys(rows, function (r) { return r.skipped; }, FLAG_TOP) : [];
    var cols = ['Step', '', 'Reached', 'Kept', 'Lost so far', 'Quit here', 'Step drop'];
    if (withSkips) cols = cols.concat(['Skipped', 'Skip rate', 'Skipped so far']);
    cols = cols.concat(['Median', 'p90']);
    var first = rows.reduce(function (m, r) { return Math.max(m, r.reached || 0); }, 0);
    var t = H.el('div', 'ob-table ob-funnel' + (withSkips ? ' ob-funnel-skips' : '') + (first < SMALL_N ? ' is-small' : ''));
    t.appendChild(headRow(cols));
    rows.forEach(function (r) {
      var w = dwellOf(seg, r.key);
      var aside = r.next == null && r.previous == null;
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', r.key);
      row.appendChild(stepCell(d, r.key, t, row));
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
      if (OB.open[r.key] && d && d.stopped && d.stopped[r.key]) syncWho(d, r.key, t, row);
    });
    return t;
  }
  /* The funnel by phase: green went on, red stopped, blue skipped. A row that
   * lost named players opens them. */
  function phaseWho(d, phase) {
    var out = { total: 0, players: [] };
    Object.keys((d && d.stopped) || {}).forEach(function (k) {
      if (phaseOf(k) !== phase) return;
      out.total += d.stopped[k].total || 0;
      out.players = out.players.concat(d.stopped[k].players || []);
    });
    return out.players.length ? out : null;
  }
  function phaseFunnel(d, rows) {
    var top = rows.reduce(function (m, r) { return Math.max(m, r.reached); }, 0);
    var t = H.el('div', 'ob-table ob-phases');
    t.appendChild(headRow(['Phase', '', 'Left', 'Lost', 'Time']));
    rows.forEach(function (r) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-phase', r.label);
      var who = phaseWho(d, r.phase), key = 'phase:' + r.phase;
      var name = who ? H.el('a', 'ob-c ob-step ob-link', r.label) : cell(r.label, 'ob-step');
      function sync() {
        var next = row.nextSibling;
        if (next && next.classList && next.classList.contains('ob-who')) t.removeChild(next);
        row.classList.toggle('is-open', !!OB.open[key]);
        if (OB.open[key]) t.insertBefore(whoList(d, key, who), row.nextSibling);
      }
      if (who) {
        name.href = 'javascript:void(0)';
        name.addEventListener('click', function () { OB.open[key] = !OB.open[key]; sync(); });
      }
      row.appendChild(name);
      var strip = H.el('span', 'ob-bar');
      [['ob-keep', r.left], ['ob-stop', r.stopped], ['ob-skip', r.skipped]].forEach(function (p) {
        var f = H.el('span', p[0]);
        f.style.width = (ratio(p[1], top) * 100) + '%';
        strip.appendChild(f);
      });
      row.appendChild(strip);
      row.appendChild(cell(int(r.left), 'ob-n ob-v'));
      var lost = r.stopped + r.skipped;
      row.appendChild(cell(lost ? '-' + int(lost) : '—', 'ob-n' + (r.stopped ? ' is-bad' : r.skipped ? ' is-skip' : '')));
      row.appendChild(cell(r.time == null ? '—' : dur(r.time), 'ob-n ob-sub'));
      t.appendChild(row);
      if (who && OB.open[key]) sync();
    });
    return t;
  }
  /* How far unique players got: the servers' count, replays and logged-in runs in. */
  function playerFunnel(d, rows) {
    var stopTop = topKeys(rows, function (r) { return r.furthest; }, FLAG_TOP);
    var t = H.el('div', 'ob-table ob-steps');
    t.appendChild(headRow(['Step', '', 'Reached', 'Kept', 'Stopped here']));
    rows.forEach(function (r) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-step', r.key);
      row.appendChild(stepCell(d, r.key, t, row));
      row.appendChild(bar(r.retained));
      row.appendChild(cell(int(r.reached), 'ob-n'));
      row.appendChild(cell(rows[0].reached >= SMALL_N ? pct(r.retained) : '—', 'ob-n'));
      row.appendChild(cell(int(r.furthest), 'ob-n' + (stopTop.indexOf(r.key) >= 0 ? ' is-bad' : '')));
      t.appendChild(row);
      if (OB.open[r.key] && d.stopped && d.stopped[r.key]) syncWho(d, r.key, t, row);
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
    if (segs.length === 1) b.appendChild(funnelSingle(segs[0], segs[0].signup.steps || [], false, null));
    else b.appendChild(funnelCompare(segs, function (s) { return s.signup.steps; }, false));
    box.appendChild(b);
    return box;
  }
  function viewTutorial(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    if (segs.length === 1) {
      var s = segs[0], t = tutorialOf(s), steps = s.player_steps || [];
      if (!t.offered) { box.appendChild(emptyOr(d, 'No tutorial sessions yet')); return box; }
      var hud = H.el('div', 'ob-hud');
      var h = headline(s);
      if (s.signup) {
        hud.appendChild(tile('Started signup', int(h.started), 'sessions'));
        hud.appendChild(tile('Signed up', int(h.signed), share(h.signed, h.started)));
      }
      hud.appendChild(tile('New finished', int((s.tutorial || {}).completed), share((s.tutorial || {}).completed, s.sessions), 'ok'));
      hud.appendChild(tile('All finished', int(t.completed), share(t.completed, t.offered), 'ok'));
      box.appendChild(hud);
      var phases = phaseRows(s);
      if (phases.length) {
        var pb = block('Phases · ' + int(phases[0].reached) + ' new players');
        pb.appendChild(phaseFunnel(d, phases));
        box.appendChild(pb);
      }
      box.appendChild(outcomeBar(t));
      if (steps.length) {
        var up = block('Unique players · ' + int(steps[0].reached));
        up.appendChild(playerFunnel(d, steps));
        box.appendChild(up);
      }
      if (s.tutorial && s.tutorial.offered) {
        var sample = block('New signups · sample of ' + int(s.tutorial.offered));
        sample.appendChild(funnelSingle(s, s.tutorial.steps || [], true, d));
        box.appendChild(sample);
      }
      return box;
    }
    var o = table('ob-compare', 'minmax(16ch, 1.4fr)', segs.length);
    o.appendChild(headRow([''].concat(segs.map(function (x) { return x.label; }))));
    [['Players', 'offered', false], ['Finished', 'completed', true], ['Skipped', 'declined', true], ['Quit', 'left', true], ['Playing', 'playing', false]].forEach(function (m) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-metric', m[0]);
      row.appendChild(cell(m[0], 'ob-step'));
      segs.forEach(function (x) { var t = tutorialOf(x); row.appendChild(cell(int(t[m[1]]) + (m[2] ? ' · ' + share(t[m[1]], t.offered) : ''), 'ob-n')); });
      o.appendChild(row);
    });
    box.appendChild(o);
    box.appendChild(funnelCompare(segs, function (x) { return x.tutorial && x.tutorial.steps; }, true));
    return box;
  }

  // ── Runs (every started run, from the servers) ──
  var RUN_ROWS = [['Runs', 'runs'], ['Players', 'players'], ['Finished', 'completed'], ['Quit', 'left'], ['Playing', 'playing'],
    ['Repeat', 'repeat'], ['Replays', 'replays'], ['Existing players', 'existing'], ['No player', 'no_player']];
  function runKind(x) { return x.replay ? 'Replay' : !x.player_id ? '—' : x.new_player ? 'New' : 'Existing'; }
  function viewRuns(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [], rows = d.runs || [];
    if (!rows.length) { box.appendChild(H.stateBlock('empty', 'No tutorial runs yet')); return box; }
    if (segs.length === 1) {
      var r = segs[0].runs || {}, hud = H.el('div', 'ob-hud');
      hud.appendChild(tile('Players', int(r.players)));
      hud.appendChild(tile('Runs', int(r.runs), int(r.repeat) + ' repeat'));
      hud.appendChild(tile('Finished', int(r.completed), share(r.completed, r.runs), 'ok'));
      hud.appendChild(tile('Quit', int(r.left), share(r.left, r.runs)));
      hud.appendChild(tile('Replays', int(r.replays)));
      hud.appendChild(tile('Existing players', int(r.existing)));
      hud.appendChild(tile('No player', int(r.no_player), null, r.no_player > 0 ? 'bad' : null));
      box.appendChild(hud);
    } else {
      var c = table('ob-compare', 'minmax(16ch, 1.4fr)', segs.length);
      c.appendChild(headRow([''].concat(segs.map(function (x) { return x.label; }))));
      RUN_ROWS.forEach(function (m) {
        var row = H.el('div', 'ob-row');
        row.setAttribute('data-metric', m[1]);
        row.appendChild(cell(m[0], 'ob-step'));
        segs.forEach(function (x) { row.appendChild(cell(int((x.runs || {})[m[1]]), 'ob-n')); });
        c.appendChild(row);
      });
      box.appendChild(c);
    }
    box.appendChild(runCompare(segs));
    var tags = guildTags(d);
    var t = H.el('div', 'ob-table ob-runs');
    t.appendChild(headRow(['Player', 'Guild', 'Interface', 'Started', 'Run', 'Kind', 'Outcome', 'Got to', 'Time'], [2, 5, 6, 7]));
    rows.forEach(function (x) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-session', x.session_id);
      if (x.player_id) row.appendChild(playerLink(x));
      else row.appendChild(cell('No player', 'ob-step is-bad', x.session_id));
      row.appendChild(cell(tags[x.guild_id] || x.guild_id, 'ob-n'));
      row.appendChild(cell(x.interface || '—', 'ob-sub'));
      row.appendChild(cell(x.started_ms ? H.ago(x.started_ms) : '—', 'ob-n'));
      row.appendChild(cell(int(x.run_number), 'ob-n'));
      row.appendChild(cell(runKind(x), 'ob-sub'));
      row.appendChild(cell(OUTCOME_LABEL[x.outcome] || x.outcome, 'ob-out-' + x.outcome));
      row.appendChild(cell(x.furthest ? stepLabel(x.furthest) : '—', 'ob-step ob-sub', x.furthest));
      row.appendChild(cell(dur(x.seconds), 'ob-n'));
      t.appendChild(row);
    });
    box.appendChild(t);
    return box;
  }

  /* First runs beside later ones: does coming back help? */
  function runCompare(segs) {
    var b = block('By run');
    var t = table('ob-compare ob-run-compare', 'minmax(14ch, 1.2fr)', 6);
    t.appendChild(headRow(['Run', 'Runs', 'Finished', 'Steps', 'Time to finish', 'Since last run', 'Quit']));
    segs.forEach(function (s) {
      (s.run_comparison || []).forEach(function (x) {
        var row = H.el('div', 'ob-row');
        row.setAttribute('data-run', x.run);
        row.appendChild(cell((segs.length > 1 ? s.label + ' · ' : '') + x.run, 'ob-step'));
        row.appendChild(cell(int(x.runs), 'ob-n'));
        row.appendChild(cell(share(x.completed, x.runs), 'ob-n'));
        row.appendChild(cell(x.steps ? int(x.steps.p50) : '—', 'ob-n'));
        row.appendChild(cell(x.time ? dur(x.time.p50) : '—', 'ob-n'));
        row.appendChild(cell(x.since_previous ? dur(x.since_previous.p50) : '—', 'ob-n'));
        row.appendChild(cell(int(x.left), 'ob-n'));
        t.appendChild(row);
      });
    });
    b.appendChild(t);
    return b;
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
  /* From signing up to still playing, counted against everyone who signed up. */
  function activationBlock(d, segs) {
    var b = block('Activation');
    function of(s, key) { return ((s.activation || []).filter(function (a) { return a.key === key; })[0]) || {}; }
    var label = function (m) { return m[0] === 'active' ? 'Active ' + d.active_days + 'd' : m[1]; };
    if (segs.length === 1) {
      var h = H.el('div', 'ob-table ob-hist ob-activation');
      MILESTONES.forEach(function (m) {
        var a = of(segs[0], m[0]);
        var row = H.el('div', 'ob-row');
        row.setAttribute('data-milestone', m[0]);
        row.appendChild(cell(label(m), 'ob-step'));
        row.appendChild(bar(a.rate));
        row.appendChild(cell(int(a.n), 'ob-n'));
        row.appendChild(cell(share(a.n, segs[0].players), 'ob-n'));
        h.appendChild(row);
      });
      b.appendChild(h);
      return b;
    }
    var c = table('ob-compare ob-activation', 'minmax(16ch, 1.4fr)', segs.length);
    c.appendChild(headRow([''].concat(segs.map(function (s) { return s.label; }))));
    MILESTONES.forEach(function (m) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-milestone', m[0]);
      row.appendChild(cell(label(m), 'ob-step'));
      segs.forEach(function (s) { var a = of(s, m[0]); row.appendChild(cell(int(a.n) + ' · ' + share(a.n, s.players), 'ob-n')); });
      c.appendChild(row);
    });
    b.appendChild(c);
    return b;
  }
  /* Below SMALL_N a cell shows the count: a percentage claims more than it can carry. */
  function heatCell(n, total) {
    if (n == null) return H.el('span', 'ob-heat ob-heat-none');
    var rate = ratio(n, total);
    var c = H.el('span', 'ob-heat ob-heat-' + heatBand(rate), total >= SMALL_N ? Math.round(rate * 100) + '%' : int(n));
    c.title = int(n) + ' of ' + int(total);
    return c;
  }
  function cohortGrid(rows) {
    var weeks = 8;
    var t = H.el('div', 'ob-cohorts');
    var head = H.el('div', 'ob-cohort ob-cohort-head');
    ['Joined', 'n', 'Acted'].concat(Array.from({ length: weeks }, function (_, i) { return '+' + (i + 1) + 'w'; })).forEach(function (c) { head.appendChild(H.el('span', null, c)); });
    t.appendChild(head);
    rows.forEach(function (c) {
      var row = H.el('div', 'ob-cohort');
      row.setAttribute('data-week', c.year + '-' + c.week);
      row.appendChild(H.el('span', null, c.week));
      row.appendChild(H.el('span', 'ob-v ob-n', int(c.n)));
      row.appendChild(heatCell(c.acted, c.n));
      for (var i = 0; i < weeks; i++) row.appendChild(heatCell((c.alive || [])[i], c.n));
      t.appendChild(row);
    });
    return t;
  }
  function viewRetention(d) {
    var box = H.el('div', 'ob-view');
    var segs = d.segments || [];
    if (segs.length === 1) {
      var lc = segs[0].lifecycle || {}, all = segs[0].players;
      var hud = H.el('div', 'ob-hud');
      hud.appendChild(tile('Never acted', int(lc.never), share(lc.never, all)));
      hud.appendChild(tile('Gone 30d+', int(lc.gone), share(lc.gone, all), lc.gone ? 'bad' : null));
      hud.appendChild(tile('Idle 7d+', int((lc.month || 0) + (lc.gone || 0)), 'then stopped'));
      hud.appendChild(tile('Active 7d', int((lc.today || 0) + (lc.week || 0)), share((lc.today || 0) + (lc.week || 0), all), 'ok'));
      box.appendChild(hud);
    }
    segs.forEach(function (s) {
      if (!(s.cohorts || []).length) return;
      var c = block(segs.length > 1 ? 'Still acting, by week joined · ' + s.label : 'Still acting, by week joined');
      c.appendChild(cohortGrid(s.cohorts));
      box.appendChild(c);
    });
    box.appendChild(activationBlock(d, segs));
    var t = table('ob-compare', 'minmax(16ch, 1.4fr)', segs.length);
    t.appendChild(headRow([''].concat(segs.map(function (s) { return segs.length > 1 ? s.label : 'All'; }))));
    [['Players', function (s) { return int(s.players); }],
     ['Active ' + d.active_days + 'd', function (s) { return int(s.active) + ' · ' + share(s.active, s.players); }],
     ['Inactive', function (s) { return int(s.inactive); }],
     ['Never acted', function (s) { return int(s.never_acted) + ' · ' + share(s.never_acted, s.players); }],
     ['Churn', function (s) { return int(s.churned) + ' of ' + int(s.churn_base); }]].forEach(function (m) {
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

  // ── Trends (the app's own daily record) ──
  function trendValue(row, key, guild) {
    if (!row) return null;
    if (guild) {
      var g = (row.guilds || {})[guild];
      return g && (key === 'humans' || key === 'active_7d') ? g[key] : null;
    }
    if (key in row) return row[key];
    return row.server ? row.server[key] : null;
  }
  /* Change since the row `days` back, or nothing if the record is younger. */
  function trendChange(rows, key, guild, days) {
    if (rows.length <= days) return null;
    var now = trendValue(rows[rows.length - 1], key, guild), then = trendValue(rows[rows.length - 1 - days], key, guild);
    return now == null || then == null ? null : now - then;
  }
  function signed(n) { return n == null ? '—' : (n > 0 ? '+' : '') + int(n); }
  function viewTrends(d) {
    var box = H.el('div', 'ob-view');
    var rows = d.history || [], guild = (d.filters || {}).guild;
    if (!rows.length) { box.appendChild(emptyOr(d, 'No days recorded yet')); return box; }
    var t = H.el('div', 'ob-table ob-trends');
    t.appendChild(headRow(['Since ' + rows[0].day, '', 'Now', '7 days', '30 days']));
    TRENDS.forEach(function (m) {
      var vals = rows.map(function (r) { return trendValue(r, m[0], guild); }).filter(function (v) { return v != null; });
      if (!vals.length) return;
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-trend', m[0]);
      var open = H.el('a', 'ob-c ob-step ob-link', m[1]);
      open.href = 'javascript:void(0)';
      open.addEventListener('click', function () { T.add('chart', { series: JSON.stringify([{ source: 'telemetry', metric: m[0] }]), window: '2592000' }, 2); });
      row.appendChild(open);
      var line = H.el('span', 'ob-c ob-spark');
      line.appendChild(window.StructsCards.sparkline(vals, 'player', m[1]));
      row.appendChild(line);
      row.appendChild(cell(int(vals[vals.length - 1]), 'ob-n'));
      row.appendChild(cell(signed(trendChange(rows, m[0], guild, 7)), 'ob-n'));
      row.appendChild(cell(signed(trendChange(rows, m[0], guild, 30)), 'ob-n'));
      t.appendChild(row);
    });
    box.appendChild(t);
    return box;
  }

  function guildMore(g, c) {
    var live = g.status === 'ok', o = g.outcome || {};
    var rows = live ? [['Offered', int(o.offered)], ['Runs', int(g.runs)], ['Timed', int(g.sampled) + ' of ' + int(g.signed_up)], ['No telemetry', int(g.untracked)], ['No player', int(g.no_player)], ['Read', c ? int(c.fetched) + ' / ' + int(c.todo) : '—']]
      : [['State', g.status === 'no_api' ? 'No API' : 'Failing']];
    if (g.error) rows.push(['Error', g.error]);
    if (g.runs_error) rows.push(['Runs', g.runs_error]);
    if (c && c.last_error) rows.push(['Read', c.last_error]);
    var box = H.el('div', 'ob-more');
    box.setAttribute('data-more', g.id);
    rows.forEach(function (r) {
      var f = H.el('span', 'ob-fact');
      f.appendChild(H.el('span', 'ob-sub', r[0]));
      f.appendChild(H.el('span', 'ob-v', r[1]));
      box.appendChild(f);
    });
    return box;
  }
  /* Players the guild list leaves out: no guild on chain. Only countable when
   * the page shows the same population as the guild rows. */
  function unguilded(d) {
    var f = d.filters || {}, segs = d.segments || [];
    if (segs.length !== 1 || f.guild || f.interface || f.activity) return 0;
    return Math.max(0, (segs[0].players || 0) - sum(d.guilds || [], function (g) { return g.players; }));
  }
  function viewGuilds(d) {
    var box = H.el('div', 'ob-view');
    var crawl = (d.crawl && d.crawl.guilds) || {};
    var t = H.el('div', 'ob-table ob-guilds');
    t.appendChild(headRow(['Guild', 'Active of players', 'Players', 'Active', 'Signups', 'Finished'], [1]));
    var rows = (d.guilds || []).slice().sort(function (a, b) { return (b.players || 0) - (a.players || 0); });
    var top = rows.reduce(function (m, g) { return Math.max(m, g.players || 0); }, 0);
    rows.forEach(function (g) {
      var live = g.status === 'ok', key = 'guild:' + g.id, o = g.outcome || {};
      var row = H.el('div', 'ob-row' + (live ? '' : ' is-quiet'));
      row.setAttribute('data-guild', g.id);
      var name = H.el('a', 'ob-c ob-step ob-link');
      name.href = 'javascript:void(0)';
      name.appendChild(H.el('span', null, g.name || g.id));
      name.appendChild(H.el('span', 'ob-sub', live ? (g.tag ? g.tag + ' · ' : '') + g.id : g.status === 'no_api' ? 'No API' : 'Failing'));
      function sync() {
        var next = row.nextSibling;
        if (next && next.classList && next.classList.contains('ob-more')) t.removeChild(next);
        row.classList.toggle('is-open', !!OB.open[key]);
        if (OB.open[key]) t.insertBefore(guildMore(g, crawl[g.id]), row.nextSibling);
      }
      name.addEventListener('click', function () { OB.open[key] = !OB.open[key]; sync(); });
      row.appendChild(name);
      var strip = H.el('span', 'ob-bar');
      var whole = H.el('span', 'ob-whole');
      whole.style.width = (ratio(g.players, top) * 100) + '%';
      var act = H.el('span', 'ob-keep');
      act.style.width = (ratio(g.active, g.players) * 100) + '%';
      whole.appendChild(act);
      strip.appendChild(whole);
      row.appendChild(strip);
      row.appendChild(cell(int(g.players), 'ob-n ob-v'));
      row.appendChild(cell(int(g.active), 'ob-n'));
      row.appendChild(cell(live ? int(g.signed_up) + ' of ' + int(g.started) : '—', 'ob-n'));
      row.appendChild(cell(live ? int(o.completed) : '—', 'ob-n'));
      t.appendChild(row);
      if (OB.open[key]) sync();
    });
    var none = unguilded(d);
    if (none) {
      var nr = H.el('div', 'ob-row is-quiet');
      nr.setAttribute('data-guild', 'none');
      var nn = H.el('span', 'ob-c ob-step', 'No guild');
      nr.appendChild(nn);
      nr.appendChild(H.el('span', 'ob-bar'));
      nr.appendChild(cell(int(none), 'ob-n ob-v'));
      ['—', '—', '—'].forEach(function (x) { nr.appendChild(cell(x, 'ob-n')); });
      t.appendChild(nr);
    }
    box.appendChild(t);
    return box;
  }

  // ── Health: what each figure rests on ──
  function when(ms) { return ms ? H.ago(ms) : '—'; }
  function sum(rows, f) { return rows.reduce(function (a, r) { return a + (Number(f(r)) || 0); }, 0); }
  function sourceRows(d) {
    var c = d.crawl || {}, p = c.players || {}, r = c.replicants || {}, round = p.round || {};
    var guilds = d.guilds || [], apis = guilds.filter(function (g) { return g.status !== 'no_api'; });
    var ok = guilds.filter(function (g) { return g.status === 'ok'; }).length;
    var runs = (d.segments || []).reduce(function (a, s) { return a + ((s.runs || {}).runs || 0); }, 0);
    var sessions = (d.segments || []).reduce(function (a, s) { return a + (s.sessions || 0); }, 0);
    var all = 'Every filter', server = 'Interface, guild';
    return [
      ['Chain tables', int(p.known) + ' players', when(p.refreshed_ms), all, round.tables_error],
      ['Replicants', int(r.known) + ' granted · ' + int(r.likely) + ' likely', when(r.read_ms) + (r.source ? ' · ' + r.source : ''), all, round.replicants_error],
      ['Ledgers', int(p.human_ledgers) + ' of ' + int(p.humans) + ' humans', when(p.refreshed_ms), all, round.ledger_errors ? round.ledger_last_error : null],
      ['Signup sample', int(sessions) + ' sessions', when(c.finished_ms), all, null],
      ['Server funnels', ok + ' of ' + apis.length + ' guilds', when(d.generated_ms), server, null],
      ['Unique players', int(sum(guilds, function (g) { return (g.tutorial_players || {}).players; })) + ' players', when(d.generated_ms), server, null],
      ['Runs', int(runs) + ' runs', when(d.generated_ms), all, null],
      ['Daily record', int((d.history || []).length) + ' days', (d.history || []).length ? d.history[d.history.length - 1].day : '—', 'Guild', null],
    ];
  }
  /* What is wrong now, worst first. Everything healthy stays out of this list. */
  function issuesOf(d) {
    var g = d.guilds || [], out = [], r = (d.crawl || {}).replicants || {};
    var names = function (rows) { return rows.map(function (x) { return x.tag || x.name || x.id; }).join(' · '); };
    sourceRows(d).forEach(function (s) { if (s[4]) out.push({ level: 'issue', title: s[0] + ' failing', where: String(s[4]), count: '' }); });
    if (r.source === 'guild') out.push({ level: 'issue', title: 'Replicants read from the guild', where: 'Humans may be overcounted', count: int(r.known) + ' known' });
    var failing = g.filter(function (x) { return x.status === 'error'; });
    if (failing.length) out.push({ level: 'issue', title: 'Guilds failing', where: names(failing), count: int(sum(failing, function (x) { return x.players; })) + ' players' });
    var lost = g.filter(function (x) { return x.no_player > 0; }), noPlayer = sum(g, function (x) { return x.no_player; });
    if (noPlayer) out.push({ level: 'issue', title: 'Runs with no player', where: names(lost), count: int(noPlayer) + ' of ' + int(sum(g, function (x) { return x.runs; })) + ' runs' });
    var dark = g.filter(function (x) { return x.status === 'no_api'; });
    if (dark.length) out.push({ level: 'notice', title: 'Guilds with no API', where: names(dark), count: int(sum(dark, function (x) { return x.players; })) + ' players' });
    var days = (d.history || []).length;
    if (days < 7) out.push({ level: 'notice', title: 'Daily record is short', where: days ? 'Since ' + d.history[0].day : 'Nothing recorded', count: int(days) + (days === 1 ? ' day' : ' days') });
    return out;
  }
  function viewHealth(d) {
    var box = H.el('div', 'ob-view');
    var g = d.guilds || [];
    var issues = issuesOf(d);
    if (issues.length) {
      var ib = H.el('div', 'ob-issues');
      issues.forEach(function (x) {
        var row = H.el('div', 'ob-issue is-' + x.level);
        row.setAttribute('data-issue', x.title);
        row.appendChild(H.el('span', 'ob-badge ob-badge-' + x.level, x.level === 'issue' ? 'Issue' : 'Notice'));
        var what = H.el('span', 'ob-step');
        what.appendChild(H.el('span', 'ob-v', x.title));
        what.appendChild(H.el('span', 'ob-sub', x.where));
        row.appendChild(what);
        row.appendChild(H.el('span', 'ob-n', x.count));
        ib.appendChild(row);
      });
      box.appendChild(ib);
    }
    var src = sourceRows(d), failing = src.filter(function (s) { return s[4]; }).length;
    var sb = block('Sources · ' + (src.length - failing) + ' of ' + src.length + ' OK');
    var grid = H.el('div', 'ob-sources');
    src.forEach(function (s) {
      var c = H.el('div', 'ob-src' + (s[4] ? ' is-failing' : ''));
      c.setAttribute('data-source', s[0]);
      c.title = s[4] || 'Follows: ' + s[3];
      c.appendChild(H.el('span', 'ob-src-mark'));
      var body = H.el('span', 'ob-step');
      body.appendChild(H.el('span', 'ob-v', s[0]));
      body.appendChild(H.el('span', 'ob-sub', s[1]));
      body.appendChild(H.el('span', 'ob-sub', s[2]));
      c.appendChild(body);
      grid.appendChild(c);
    });
    sb.appendChild(grid);
    box.appendChild(sb);
    var cov = block('Coverage');
    var reporting = sum(g.filter(function (x) { return x.status === 'ok'; }), function (x) { return x.players; });
    var dark2 = sum(g.filter(function (x) { return x.status !== 'ok'; }), function (x) { return x.players; });
    var strip = H.el('div', 'ob-stack'), legend = H.el('div', 'ob-legend');
    [['Reporting guilds', reporting, 'ok'], ['No API', dark2, 'dark'], ['No guild', unguilded(d), 'none']].forEach(function (k) {
      var seg = H.el('span', 'ob-seg ob-cov-' + k[2]);
      seg.style.flexGrow = String(k[1]);
      if (k[1] > 0) strip.appendChild(seg);
      var l = H.el('span', 'ob-key');
      l.setAttribute('data-coverage', k[2]);
      l.appendChild(H.el('span', 'ob-swatch ob-cov-' + k[2]));
      l.appendChild(H.el('span', null, k[0]));
      l.appendChild(H.el('span', 'ob-v', int(k[1])));
      legend.appendChild(l);
    });
    cov.appendChild(strip);
    cov.appendChild(legend);
    box.appendChild(cov);
    box.appendChild(footLine(d));
    return box;
  }

  var OUTCOME_LABEL = { completed: 'Finished', declined: 'Skipped', left: 'Quit', playing: 'Playing', deciding: 'At offer' };
  function journey(lastStep, outcome) {
    var at = Math.max(0, phaseOf(lastStep));
    var track = H.el('span', 'ob-journey');
    PHASES.forEach(function (ph, i) {
      var dot = H.el('span', 'ob-dot' + (i < at ? ' is-done' : i === at ? ' ob-badge-' + outcome : ''));
      dot.title = ph[1];
      track.appendChild(dot);
    });
    return track;
  }
  function viewRecent(d) {
    var box = H.el('div', 'ob-view');
    var rows = d.recent || [];
    if (!rows.length) { box.appendChild(emptyOr(d, 'No sessions sampled yet')); return box; }
    var tags = guildTags(d);
    var seen = ['completed', 'declined', 'left', 'deciding', 'playing'].filter(function (k) { return rows.some(function (x) { return x.outcome === k; }); });
    var show = seen.indexOf(OB.recent) >= 0 ? OB.recent : '';
    var pills = H.el('div', 'ob-pills');
    [''].concat(seen).forEach(function (k) {
      var n = k ? rows.filter(function (x) { return x.outcome === k; }).length : rows.length;
      var a = H.el('a', 'ob-pill' + (k === show ? ' is-on' : ''), (k ? OUTCOME_LABEL[k] : 'All') + ' ' + int(n));
      a.href = 'javascript:void(0)';
      a.setAttribute('data-outcome', k || 'all');
      a.addEventListener('click', function () { OB.recent = k; box.parentNode.replaceChild(viewRecent(d), box); });
      pills.appendChild(a);
    });
    box.appendChild(pills);
    var t = H.el('div', 'ob-table ob-recent');
    t.appendChild(headRow(['Player', 'Outcome', 'Got to', 'Signup', 'Tutorial', 'Seen'], [1, 2]));
    rows.filter(function (x) { return !show || x.outcome === show; }).forEach(function (x) {
      var row = H.el('div', 'ob-row');
      row.setAttribute('data-player', x.player_id);
      row.appendChild(playerLink(x, tags[x.guild_id] || x.guild_id));
      var badge = H.el('span', 'ob-c');
      badge.appendChild(H.el('span', 'ob-badge ob-badge-' + x.outcome, OUTCOME_LABEL[x.outcome] || x.outcome));
      row.appendChild(badge);
      var at = H.el('span', 'ob-c ob-step', null);
      at.appendChild(journey(x.last_step, x.outcome));
      var ph = PHASES[phaseOf(x.last_step)];
      at.appendChild(H.el('span', 'ob-sub', ph ? ph[1] : '—'));
      at.title = x.last_step || '';
      row.appendChild(at);
      row.appendChild(cell(dur(x.signup_s), 'ob-n'));
      row.appendChild(cell(dur(x.tutorial_s), 'ob-n'));
      row.appendChild(cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-n ob-sub'));
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
  // Pages folded from the crawls; Signup, Runs and Guilds come from the servers' own reads.
  var CRAWLED = { overview: 1, tutorial: 1, players: 1, retention: 1, timing: 1, daily: 1, recent: 1 };

  function footLine(d) {
    var c = d.crawl || {}, p = c.players || {};
    var sessions = (d.segments || []).reduce(function (a, s) { return a + (s.sessions || 0); }, 0);
    var parts = [int(sessions) + ' onboarding sessions on ' + (d.version || '—')];
    var f = d.filters || {}, r = c.replicants || {};
    if (p.known && (f.replicants || f.compare === 'replicant')) parts.push('ledgers read for ' + int(p.ledgers) + ' of ' + int(p.known) + ' players');
    else if (p.known) parts.push('ledgers read for ' + int(p.human_ledgers) + ' of ' + int(p.humans) + ' humans');
    if (r.known) parts.push(int(r.known + (r.likely || 0)) + ' replicants under ' + int(r.primaries) + ' primaries');
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
    bar1.appendChild(H.selectBox(f.interface || '', ifaces, function (v) { set({ iface: v }); }));
    bar1.appendChild(H.selectBox(f.guild || '', guilds, function (v) { set({ guild: v }); }));
    bar1.appendChild(H.selectBox(f.activity || '', ACTIVITY, function (v) { set({ activity: v }); }));
    var both = f.compare === 'replicant';
    var reps = H.checkbox(both || !!f.replicants, 'Replicants', function (on) { set({ reps: on ? '1' : '' }); });
    reps.querySelector('input').disabled = both;
    bar1.appendChild(reps);
    bar1.appendChild(H.selectBox(f.compare || '', COMPARE, function (v) { set({ compare: v }); }));
    bar1.appendChild(H.selectBox(String(d.active_days || 7), ACTIVE, function (v) { set({ active: v }); }));
    bar1.appendChild(H.selectBox(String(d.idle_hours || 24), IDLE, function (v) { set({ idle: v }); }));
    var versions = (d.versions || []).map(function (v) { return { value: v, label: v }; });
    if (versions.length > 1) bar1.appendChild(H.selectBox(d.version, versions, function (v) { set({ version: v }); }));
    return bar1;
  }
  function rail(view, onPick) {
    var nav = H.el('div', 'ob-rail sui-screen');
    NAV.forEach(function (g) {
      nav.appendChild(H.el('div', 'ob-rail-head', g[0]));
      g[1].forEach(function (v) {
        var a = H.el('a', 'sui-screen-nav-item' + (v[0] === view ? ' sui-mod-active' : ''), v[1]);
        a.href = 'javascript:void(0)';
        a.addEventListener('click', function () { onPick(v[0]); });
        nav.appendChild(a);
      });
    });
    return nav;
  }
  /* Freshness and trouble in one place, on every page; it opens Health. */
  function statusLink(d, onPick) {
    var c = d.crawl || {}, issues = issuesOf(d).filter(function (x) { return x.level === 'issue'; }).length;
    var a = H.el('a', 'ob-status' + (issues ? ' is-bad' : ''));
    a.href = 'javascript:void(0)';
    a.addEventListener('click', function () { onPick('health'); });
    if (issues) {
      a.appendChild(H.el('span', 'ob-src-mark'));
      a.appendChild(H.el('span', null, int(issues) + (issues === 1 ? ' issue' : ' issues')));
    }
    if (c.running) a.appendChild(H.el('i', H.iconClass('icon-in-progress', 'sui-icon-sm')));
    a.appendChild(H.el('span', 'ob-sub', c.running ? 'Reading…' : c.finished_ms ? 'Read ' + H.ago(c.finished_ms) + ' ago' : ''));
    return a;
  }
  function argsOf(p) {
    var a = { idleHours: Number(p.idle) || 24, activeDays: Number(p.active) || 7,
      filters: { interface: p.iface || null, guild: p.guild || null, activity: p.activity || null, replicants: p.reps === '1', compare: p.compare || null } };
    if (p.version) a.version = p.version;
    return a;
  }

  // ── The card ──
  var DRAW = { overview: viewOverview, signup: viewSignup, tutorial: viewTutorial, runs: viewRuns, players: viewPlayers, retention: viewRetention,
    timing: viewTiming, daily: viewDaily, trends: viewTrends, guilds: viewGuilds, recent: viewRecent, health: viewHealth };
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
        function pick(k) { st.view = k; draw(st.last); }
        var top = controls(d, p, set);
        top.appendChild(statusLink(d, pick));
        wrap.appendChild(top);
        var shell = H.el('div', 'ob-shell'), main = H.el('div', 'ob-main');
        shell.appendChild(rail(st.view, pick));
        if (CRAWLED[st.view] && reading(d) && !hasData(d)) main.appendChild(H.stateBlock('loading', progress(d)));
        else main.appendChild((DRAW[st.view] || viewOverview)(d));
        shell.appendChild(main);
        wrap.appendChild(shell);
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

  T.onboarding = { phaseOf: phaseOf, phaseRows: phaseRows, heatBand: heatBand, issuesOf: issuesOf, runKind: runKind, stepLabel: stepLabel, pct: pct, share: share, topKeys: topKeys, headline: headline, tutorialOf: tutorialOf, trendChange: trendChange, bucketLabel: bucketLabel, fmtKind: fmtKind, argsOf: argsOf };
})();
