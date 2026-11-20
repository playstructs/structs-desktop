// STRUCTS TERMINAL — the Telemetry card (⌘K → TELEMETRY), game analytics.
//
// How players find the game, get through signup and Combat Training, and
// whether they activate and stay — summed over EVERY guild's server and the
// whole chain (`terminal_onboarding`, mcp/onboarding.rs, onboarding_players.rs,
// pirate.rs). The design and the persona-panel log that shaped it are in
// proposals/telemetry-redesign.md.
//
// Eight sections in journey order (Overview · Acquisition · Onboarding ·
// Engagement · Players · Guilds · Trends · Data), every one drawn with the
// same grammar, top to bottom: the section strip and status; the scope bar
// (filters + Split by), which never changes shape; the section's views; a KPI
// strip; then blocks. Rules every figure obeys:
//   - every number has a stated period: a window strip, a tile's own scope
//     tag, or a block's scope chip;
//   - a share is a share of the number above it;
//   - a funnel is one component with one vocabulary (Reached · Kept · Stopped ·
//     Stop rate · Skipped · Time), flagged by rate above a floor;
//   - one drill (▸) everywhere, opening the same player list or fact grid;
//   - a split draws one column per segment, segment N wearing swatch N.
//
// The payload is a list of SEGMENTS — one when nothing is split. Signup steps
// come from the guild servers' own funnels, the tutorial leads with their
// unique players, runs are every started run; everything else is folded in
// Rust from new players' signup sessions and the chain's player tables, which
// background crawls grow between reads. Trends is the app's own daily record.
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };

  /* Sections in the order a player meets them; views are a section's second strip. */
  var SECTIONS = [['overview', 'Overview'], ['acquisition', 'Acquisition'], ['onboarding', 'Onboarding'], ['engagement', 'Engagement'],
    ['players', 'Players'], ['guilds', 'Guilds'], ['trends', 'Trends'], ['data', 'Data']];
  var VIEWS = {
    onboarding: [['phases', 'Phases'], ['steps', 'Steps'], ['runs', 'Runs'], ['timing', 'Timing'], ['impact', 'By outcome']],
    engagement: [['activation', 'Activation'], ['retention', 'Retention'], ['distributions', 'Distributions']],
    players: [['signups', 'New signups'], ['stopped', 'Stopped'], ['runs', 'Tutorial runs']],
    trends: [['figures', 'Figures'], ['daily', 'Daily']],
  };
  /* Words a ⌘K line may use for a section or a view: `TELEMETRY retention`. */
  var ALIASES = {
    overview: ['overview'], aarrr: ['overview'], pirate: ['overview'], home: ['overview'], signals: ['overview'], journey: ['overview'], stages: ['overview'],
    acquisition: ['acquisition'], signup: ['acquisition'], signups: ['acquisition'], funnel: ['acquisition'],
    onboarding: ['onboarding'], tutorial: ['onboarding'], phases: ['onboarding', 'phases'], steps: ['onboarding', 'steps'],
    runs: ['onboarding', 'runs'], timing: ['onboarding', 'timing'], impact: ['onboarding', 'impact'], outcome: ['onboarding', 'impact'],
    engagement: ['engagement'], activation: ['engagement', 'activation'], retention: ['engagement', 'retention'], cohorts: ['engagement', 'retention'],
    distributions: ['engagement', 'distributions'], stats: ['engagement', 'distributions'],
    players: ['players'], recent: ['players', 'signups'], explorer: ['players'], stopped: ['players', 'stopped'], stuck: ['players', 'stopped'],
    guilds: ['guilds'], trends: ['trends'], figures: ['trends', 'figures'], daily: ['trends', 'daily'],
    data: ['data'], health: ['data'], sources: ['data'], exclusions: ['data'], definitions: ['data'], settings: ['data'],
  };
  /* The tutorial's phases, in play order; a step belongs to the first prefix it starts with. */
  var PHASES = [['signup', 'Signup'], ['orientation', 'Offer'], ['tutorial.intro', 'Intro'], ['tutorial.raid', 'Raid'], ['tutorial.rebuild', 'Rebuild'],
    ['tutorial.defend', 'Defend'], ['tutorial.first_attack', 'First attack'], ['tutorial.bomber', 'Bomber'], ['tutorial.free_play', 'Free play'],
    ['tutorial.new_cmd_ship', 'New Cmd Ship'], ['tutorial.end', 'End']];
  var IDLE = [{ value: '6', label: '6 hours' }, { value: '24', label: '24 hours' }, { value: '72', label: '3 days' }, { value: '168', label: '7 days' }];
  var ACTIVE = [{ value: '1', label: '1 day' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }];
  var SPLITS = [{ value: '', label: 'Split by: nothing' }, { value: 'interface', label: 'Split by: app' }, { value: 'guild', label: 'Split by: guild' },
    { value: 'activity', label: 'Split by: active / inactive' }, { value: 'replicant', label: 'Split by: human / replicant' },
    { value: 'version', label: 'Split by: tutorial version' }, { value: 'tutorial', label: 'Split by: tutorial outcome' }];
  /* One name per interface, everywhere it is drawn. */
  var IFACE = { 'structs-webapp': 'Web app', 'structs-desktop': 'Desktop app', none: 'No telemetry' };
  var DURATIONS = [['signup', 'Signup'], ['chain_wait', 'Chain wait'], ['to_offer', 'To offer'], ['decision', 'Decision'], ['tutorial', 'Tutorial'], ['total', 'Whole run']];
  var OUTCOMES = [['completed', 'Finished'], ['declined', 'Skipped'], ['left', 'Quit'], ['playing', 'Playing']];
  var OUTCOME_LABEL = { completed: 'Finished', declined: 'Skipped', left: 'Quit', playing: 'Playing', deciding: 'At offer' };
  /* A split by tutorial outcome wears the outcome colours, not swatches. */
  var OUTCOME_SEG = { finished: 'ob-seg-completed', quit: 'ob-seg-left', skipped: 'ob-seg-declined', none: 'ob-life-never' };
  var STATS = [['mined', 'Ore mined', 'ore'], ['refined', 'Alpha refined', 'alpha'], ['planets', 'Planets completed', 'count'],
    ['raids_initiated', 'Raids initiated', 'count'], ['raids_won', 'Raids won', 'count']];
  /* [key, label, kind]: `step` converts from the step above; `side` happens
   * apart from the path (a planet is not needed to raid); `now` is where
   * players are, not a step. */
  var MILESTONES = [['signed_up', 'Signed up', 'step'], ['acted', 'Acted', 'step'], ['mined', 'Mined', 'step'], ['refined', 'Refined', 'step'],
    ['raided', 'Initiated a raid', 'side'], ['activated', 'Activated', 'step'], ['planet', 'Completed a planet', 'side'], ['active', 'Active this week', 'now']];
  var WINDOWS = [{ key: '1', label: '24 hours' }, { key: '7', label: '7 days' }, { key: '30', label: '30 days' }];
  var WIN_WORD = { 1: 'day', 7: '7 days', 30: '30 days' };
  var ACTIVE_NAME = { 1: 'Active today', 7: 'Active this week', 30: 'Active this month' };
  /* One word per idea: "active" is always "did anything on chain in the window". */
  function activeName(days) { return ACTIVE_NAME[days] || 'Active ' + days + 'd'; }
  /* [metric, label, source, kind, stage]. `record`: the app's daily record
   * (humans, every guild). `rebuilt`: from each player's own dates, so it
   * reaches back before the record began. A `daily` row adds up over a window;
   * a `level` row shows the change. Grouped by the stage they measure; names
   * match the tiles. */
  var TRENDS = [
    ['signups_started', 'Signup opens', 'record', 'level', 'Acquisition'], ['signed_up', 'Finished signups', 'record', 'level', 'Acquisition'],
    ['new', 'Signups', 'rebuilt', 'daily', 'Acquisition'], ['humans', 'Players', 'record', 'level', 'Acquisition'],
    ['tutorial_players', 'Tutorial players', 'record', 'level', 'Onboarding'], ['tutorial_completed', 'Tutorial finishers', 'record', 'level', 'Onboarding'],
    ['activations', 'Activated', 'rebuilt', 'daily', 'Activation'], ['activated_total', 'Activated, all time', 'rebuilt', 'level', 'Activation'],
    ['activated', 'Acted at least once', 'record', 'level', 'Activation'], ['mined', 'Mined at least once', 'record', 'level', 'Activation'],
    ['refined', 'Refined at least once', 'record', 'level', 'Activation'], ['raided', 'Initiated a raid at least once', 'record', 'level', 'Activation'],
    ['active_1d', 'Active today', 'record', 'level', 'Retention'], ['active_7d', 'Active this week', 'record', 'level', 'Retention'],
    ['active_30d', 'Active this month', 'record', 'level', 'Retention'], ['miners_7d', 'Mined this week', 'rebuilt', 'level', 'Retention'],
    ['refiners_7d', 'Refined this week', 'rebuilt', 'level', 'Retention'], ['raiders_7d', 'Initiated a raid this week', 'rebuilt', 'level', 'Retention'],
    ['replicants', 'Replicants', 'record', 'level', 'Population']];
  function trendDef(k) { return TRENDS.filter(function (m) { return m[0] === k; })[0]; }
  /* What each figure means: on hover wherever it is drawn, and listed on Data. */
  var DEFS = {
    'Unique visitors': 'Distinct people who loaded the game. Not recorded yet: the game client keeps a browser id, but only sends it once someone opens signup.',
    'Signups': 'Players who signed up: human players created on chain.',
    'Active users': 'Activated players who did anything on chain within the window.',
    'Anyone active': 'Every player who did anything on chain within the window, activated or not.',
    'Signups who activated': 'Of the players who signed up in the window, those who have activated.',
    'Signup opens': 'Signup sessions opened on any guild server: the nearest measured thing to visitors.',
    'Finished signups': 'Signup sessions that reached the end of signup (the employee record).',
    'New players': 'Human players created on chain.',
    'Players': 'Human players on chain in scope: replicants and excluded players left out unless asked for.',
    'Activated': 'Refined alpha AND initiated a raid. Dated at the later of the two firsts.',
    'Active': 'Did anything on chain within the window.',
    'Time to activate': 'Typical (median) time from signup to activation.',
    'Take-up': 'New players offered Combat Training who started it.',
    'Tutorial players': 'Unique players who reached the Combat Training offer, replays and logged-in runs included.',
    'Finished': 'Reached the end of Combat Training.',
    'Skipped': 'Declined Combat Training at the offer.',
    'Quit': 'Left Combat Training, or the offer, and stayed idle past the quit window.',
    'Never acted': 'Signed up and never did anything on chain.',
    'Churn': 'Did something, then went idle for longer than the active window.',
    'Reached': 'Players (or sessions) who got to this step.',
    'Kept': 'Share of the first step\'s players who got this far.',
    'Stopped': 'Got to this step and went no further.',
    'Stop rate': 'Share of this step\'s players who stopped here. Red: one of the three highest, at least 1.5 times the typical step\'s rate, with at least 20 players reached.',
    'Step conversion': 'Share of the row above that also got here.',
    'Median': 'The typical value: half are above, half below.',
    'p90': 'Nine in ten are at or below this; the slow or heavy tail.',
    'Run': 'One start of Combat Training. A player can run it more than once; a replay is started from Help.',
    'No player': 'A run that never recorded who played: its launch message was lost.',
    'Replicant': 'A player that hands another player full control of itself. Left out unless asked for.',
    'Cohort': 'Players by the week they joined. A cell is the share still acting that many weeks later; a blank cell has not happened yet.',
    'Sample': 'New players\' own signup sessions, read from every guild: timings, skips and who stopped come from these.',
    'Change': 'Against the same length of time just before it. Shown only when the daily series reproduces the figure above it.',
    'Daily record': 'One row a day kept by this app while it runs: humans on chain across every guild. It follows the guild filter only, and starts when the app first recorded.',
    'Come back daily': 'Players active today as a share of those active in the last 30 days. Higher means players return more often.',
    'Last seen': 'Where each player is now, by when they last did anything on chain. Every player is in exactly one bucket.',
  };
  /* Which scope controls change each section. A control a section ignores is
   * dimmed there, so changing it never looks like a broken page. */
  var USES = {
    overview: ['iface', 'guild', 'activity', 'reps', 'compare', 'version'],
    acquisition: ['iface', 'guild', 'compare', 'version'],
    onboarding: ['iface', 'guild', 'activity', 'compare', 'version'],
    engagement: ['iface', 'guild', 'activity', 'reps', 'compare', 'version'],
    players: ['iface', 'guild', 'activity', 'version'],
    guilds: ['guild', 'reps', 'version'],
    trends: ['guild'],
    data: [],
  };
  function uses(page, key) { return (USES[page] || USES.overview).indexOf(key) >= 0; }
  var FLAG_TOP = 3;
  /* Below this many, a percentage claims more than the count can carry. */
  var SMALL_N = 20;
  /* A group must be at least this big to be called best at anything. */
  var BEST_N = 20;
  var SWATCHES = 6;

  var OB = { cards: {}, open: {} };

  // ── Pure pieces (T.onboarding, for the harness) ──
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /* `tutorial.first_attack.choose_rail_gun` → "First attack · Choose rail gun". */
  function stepLabel(key) {
    var parts = String(key || '').split('.');
    if (parts[0] === 'signup' || parts[0] === 'tutorial') parts.shift();
    return parts.map(function (p) { return cap(p.replace(/_/g, ' ')); }).join(' · ') || String(key || '');
  }
  function pct(f) { return f == null || !isFinite(f) ? '—' : (f >= 0.995 || f === 0 ? Math.round(f * 100) : (f * 100).toFixed(f < 0.1 ? 1 : 0)) + '%'; }
  function ratio(a, b) { return b > 0 && a != null ? a / b : null; }
  /* `n` of `total`, as a share once there are enough to say so. */
  function share(n, total) {
    if (!(total > 0)) return '—';
    return total >= SMALL_N ? pct(n / total) : int(n) + ' of ' + int(total);
  }
  /* Under a count already shown: the share, or "of N" while N is too small for one. */
  function ofShare(n, total) {
    if (!(total > 0)) return null;
    return total >= SMALL_N ? pct(n / total) : 'of ' + int(total);
  }
  /* "30% of signup opens", or "1 of 5 signup opens" while 5 is too few for a percentage. */
  function shareOf(n, total, noun) {
    if (!(total > 0)) return null;
    return total >= SMALL_N ? pct(n / total) + ' of ' + noun : int(n) + ' of ' + int(total) + ' ' + noun;
  }
  /* A rate to one decimal, for columns that are compared row against row. */
  function pct1(f) { return f == null || !isFinite(f) ? '—' : (f * 100).toFixed(1) + '%'; }
  function int(n) { return n == null || !isFinite(n) ? '—' : H.fmtInt(n); }
  function dur(s) { return s == null ? '—' : H.duration(s); }
  /* A duration in words, for the display face (it has no lower case, so
   * "12m" would read as twelve million). */
  function durWords(s) {
    if (s == null || !isFinite(s)) return '—';
    if (s < 90) return Math.round(s) + ' sec';
    if (s < 5400) return Math.round(s / 60) + ' min';
    if (s < 129600) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' days';
  }
  /* "2026-11-11" → "Nov 11". */
  function shortDay(day) {
    var t = Date.parse(String(day) + 'T00:00:00Z');
    if (!isFinite(t)) return String(day || '');
    var x = new Date(t);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()] + ' ' + x.getUTCDate();
  }
  function signed(n) { return n == null ? '—' : (n > 0 ? '+' : '') + int(n); }
  function ifaceName(v) { return IFACE[v] || v; }
  /* A stat's value in its own units. Refined alpha arrives in grams; the game's alpha ladder takes ualpha. */
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
  /* The worst stop rates among rows big enough to have one. */
  function worstRates(rows, reached, stopped, n) {
    var rate = function (r) { var a = reached(r), s = stopped(r); return a >= SMALL_N && s != null ? s / a : null; };
    var all = rows.map(rate).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    var typical = all.length ? all[Math.floor(all.length / 2)] : 0;
    return topKeys(rows, function (r) { var x = rate(r); return x != null && x > 0 && x >= typical * 1.5 ? x : null; }, n);
  }
  /* The change on a tile, only when its daily series reproduces the figure
   * above it (within 10%): a change from another population would read as
   * this one's. */
  /* The change on a tile: both ends from the same daily series, shown only
   * when that series reproduces the figure above it to within a quarter of
   * the change (or one). Otherwise the change is withheld, and says so with
   * what the series reads: two sources that disagree are shown, not hidden. */
  function deltaFor(value, series, days, kind) {
    var dl = deltaOf(series, days, kind);
    if (!dl || value == null || !isFinite(value)) return null;
    if (Math.abs(dl.now - value) > Math.max(1, Math.abs(dl.change) / 4)) return { mismatch: true, now: dl.now, figure: value };
    return dl;
  }
  /* The Monday a cohort week starts on: "2026-W40" → "Sep 28". */
  function weekStart(year, week) {
    var w = Number(String(week).replace(/\D/g, '')), y = Number(year);
    if (!w || !y) return String(week);
    var jan4 = new Date(Date.UTC(y, 0, 4)), dow = jan4.getUTCDay() || 7;
    var mon = new Date(jan4.getTime() + ((w - 1) * 7 - (dow - 1)) * 86400000);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mon.getUTCMonth()] + ' ' + mon.getUTCDate();
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
      unique: t.unique, offered: t.offered, finished: t.completed, skipped: t.declined, quit: t.left, playing: t.playing,
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
  function dwellOf(seg, key) { return (seg && seg.dwell && seg.dwell[key]) || null; }
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
      rows.push({ phase: i, label: ph[1], reached: reached, skipped: skipped, time: time || null, steps: mine.map(function (r) { return r.key; }) });
    });
    var signed = seg && seg.sessions, first = rows[0];
    if (first && signed >= first.reached) rows.unshift({ phase: 0, label: 'Signed up', reached: signed, skipped: 0, time: seg.durations && seg.durations.signup ? seg.durations.signup.p50 : null, steps: [] });
    rows.forEach(function (r, i) {
      var next = rows[i + 1];
      r.left = next ? Math.min(next.reached, r.reached) : r.reached;
      r.skipped = Math.min(r.skipped, r.reached - r.left);
      r.stopped = r.reached - r.left - r.skipped;
    });
    return rows;
  }
  function runKind(x) { return x.replay ? 'Replay' : !x.player_id ? '—' : x.new_player ? 'New' : 'Existing'; }
  /* Funnel rows in the order a player meets them: a side branch (a step with
   * neither a previous nor a next, like the recovery-key FAQ) sits under the
   * step it branches from, and never counts as a step. */
  function orderSteps(rows) {
    var main = rows.filter(function (r) { return !(r.next == null && r.previous == null); });
    var side = rows.filter(function (r) { return r.next == null && r.previous == null; });
    side.forEach(function (s) {
      var best = -1, len = 0;
      main.forEach(function (m, i) {
        var a = String(m.key), b = String(s.key), k = 0;
        while (k < a.length && a[k] === b[k]) k++;
        if (k > len) { len = k; best = i; }
      });
      s.aside = true;
      main.splice(best + 1, 0, s);
    });
    return main;
  }

  /* The whole path in one table, in three parts that are never divided into
   * each other: signup SESSIONS (the servers), new players through Combat
   * Training (the sample), and players in the game (the chain). A part's
   * first row has no conversion; a step converts from the step above it; a
   * side row or a "now" row converts from nothing. */
  function journeyRows(seg) {
    var out = [], su = seg && seg.signup, t = (seg && seg.tutorial) || {};
    var bot = seg && seg.key === 'replicant';
    function part(name, title, rows) {
      rows = rows.filter(function (r) { return r[1] != null; });
      if (!rows.length) return;
      out.push({ part: name, label: title, n: rows[0][1] });
      var first = rows[0][1], prev = null;
      rows.forEach(function (r, i) {
        var kind = r[3] || 'step', step = i && kind === 'step' && prev != null;
        out.push({ key: r[0], label: r[2], kind: kind, n: r[1], prev: step ? ratio(r[1], prev) : null, base: step ? prev : null, first: i ? ratio(r[1], first) : null, firstN: first });
        if (kind === 'step') prev = r[1];
      });
    }
    if (su && !bot) part('signup', 'Signup · sessions', [['opened', su.started, 'Signup opens'], ['signed', su.signed_up, 'Finished signups']]);
    if (t.offered && !bot) {
      var loaded = (t.steps || []).filter(function (r) { return r.key === 'tutorial.loading'; })[0];
      part('tutorial', 'Combat Training · sample of new signups', [['offered', t.offered, 'Reached the offer'], ['started', loaded ? loaded.reached : null, 'Started'], ['finished', t.completed, 'Finished']]);
    }
    var act = (seg && seg.activation) || [];
    if (act.length) {
      var all = allOf(seg);
      part('game', 'In game · players', MILESTONES.map(function (m) {
        var a = act.filter(function (x) { return x.key === m[0]; })[0];
        var n = a ? a.n : m[0] === 'activated' ? all.activated : null;
        return [m[0], n, m[1], m[2]];
      }));
    }
    return out;
  }
  /* A daily series over the last `days` against the `days` before them. */
  /* A daily series (one entry per calendar day, null where unknown) over its
   * last `days` against the `days` before them. A window with a missing day
   * has no comparison: a gap would stretch it. */
  function deltaOf(series, days, kind) {
    var v = series || [];
    days = Number(days) || 0;
    var need = kind === 'level' ? days + 1 : 2 * days;
    if (!days || v.length < need) return null;
    var tail = v.slice(-need);
    if (kind === 'level') {
      if (tail[0] == null || tail[tail.length - 1] == null) return null;
      return { now: tail[tail.length - 1], then: tail[0], change: tail[tail.length - 1] - tail[0] };
    }
    if (tail.some(function (x) { return x == null; })) return null;
    var now = tail.slice(days).reduce(function (a, b) { return a + b; }, 0), then = tail.slice(0, days).reduce(function (a, b) { return a + b; }, 0);
    return { now: now, then: then, change: now - then };
  }
  /* A running total as what it added each day. */
  function increments(vals) {
    return (vals || []).map(function (v, i) { var p = vals[i - 1]; return v == null || p == null ? null : Math.max(0, v - p); }).slice(1);
  }

  // ── Trends (the app's own daily record, and series rebuilt from player dates) ──
  function trendValue(row, key, guild) {
    if (!row) return null;
    if (guild) {
      var g = (row.guilds || {})[guild];
      return g && (key === 'humans' || key === 'active_7d') ? g[key] : null;
    }
    if (key in row) return row[key];
    return row.server ? row.server[key] : null;
  }
  /* One metric as [day, value] pairs, oldest first; missing days are absent. */
  function trendPoints(d, m) {
    var guild = (d.filters || {}).guild, out = [];
    if (m[2] === 'rebuilt') {
      var ts = d.trend_series || {}, days = ts.days || [], vals = (ts.series || {})[m[0]] || [];
      days.forEach(function (day, i) { if (vals[i] != null) out.push([day, vals[i]]); });
      return out;
    }
    (d.history || []).forEach(function (r) { var v = trendValue(r, m[0], guild); if (v != null) out.push([r.day, v]); });
    return out;
  }
  function dayBefore(day, n) {
    var t = Date.parse(day + 'T00:00:00Z') - n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  /* Over the `days` up to the newest point: the change for a level, the sum
   * for a daily count. Null when the series does not reach back that far. */
  function trendChange(points, days, kind) {
    if (!points.length) return null;
    var last = points[points.length - 1], from = dayBefore(last[0], days);
    if (points[0][0] > from) return null;
    if (kind === 'daily') return points.filter(function (p) { return p[0] > from; }).reduce(function (a, p) { return a + p[1]; }, 0);
    /* The point on the window's first day, or a day or two before a long
     * window's: an older one would stretch the window over the days missed. */
    var floor = dayBefore(from, Math.floor(days / 7)), then = null;
    points.forEach(function (p) { if (p[0] <= from && p[0] >= floor) then = p[1]; });
    return then == null ? null : last[1] - then;
  }

  // ── AARRR (pirate metrics) ──
  function winOf(seg, days) { return (((seg && seg.pirate) || {}).windows || []).filter(function (w) { return String(w.days) === String(days); })[0] || {}; }
  function allOf(seg) { return ((seg && seg.pirate) || {}).all || {}; }
  /* The servers' signup figures over a window, or null where the record is too young. */
  function srvOf(seg, days) {
    var s = seg && seg.pirate_server;
    if (!s) return null;
    if (days === 'all') return s.all || null;
    return (s.windows || []).filter(function (w) { return String(w.days) === String(days); })[0] || null;
  }
  /* The servers' signups over a window; where the daily record is younger than
   * the window, what came since its newest reading, marked partial. */
  function srvWin(seg, days) {
    var x = srvOf(seg, days), s = seg && seg.pirate_server;
    if (x && x.started != null) return { started: x.started, signed_up: x.signed_up, partial: null };
    if (days !== 'all' && s && s.prior) return { started: s.prior.started, signed_up: s.prior.signed_up, partial: s.prior.day };
    return null;
  }
  /* [stage, label, value(seg, days) → [main, sub], chart metric, spark key, note]. `days` is '1'|'7'|'30'|'all'. */
  /* The pirate stages, in the owner's words (2026-11-20):
   *   Awareness   — unique visitors (not recorded by any guild yet)
   *   Acquisition — signups (players created on chain)
   *   Activation  — refined alpha AND initiated a raid
   *   Retention   — active users: activated players who acted in the window
   * [stage, label, value(seg, days) → [main, sub], chart metric, spark key, note]. `days` is '1'|'7'|'30'|'all'. */
  var AARRR = [
    ['Awareness', 'Unique visitors', function () { return [null]; }, null, null, 'not recorded yet'],
    ['Acquisition', 'Signups', function (s, w) { return [w === 'all' ? allOf(s).players : winOf(s, w).new]; }, 'new', 'p:new'],
    ['Activation', 'Activated', function (s, w) { var a = allOf(s); return w === 'all' ? [a.activated, ofShare(a.activated, a.players)] : [winOf(s, w).activated]; }, 'activated_total', 'p:activated_total'],
    ['Activation', 'Signups who activated', function (s, w) { if (w === 'all') return [null]; var x = winOf(s, w); return [x.cohort, ofShare(x.cohort, x.new)]; }, 'activations', null],
    ['Retention', 'Active users', function (s, w) { if (w === 'all') return [null]; var x = winOf(s, w); return [x.active_activated, ofShare(x.active_activated, allOf(s).activated)]; }, null, null],
    ['Retention', 'Anyone active', function (s, w) { return [w === 'all' ? allOf(s).acted : winOf(s, w).active, w === 'all' ? 'ever acted' : null]; }, 'active_30d', 'h:mau'],
  ];
  /* A series for a trend line: the segment's rebuilt one, or the daily
   * record's (every guild's humans), which only describes the plain population. */
  function sparkOf(d, seg, key, plain) {
    if (!key) return null;
    var src = key.slice(0, 2) === 'h:' ? (plain ? d.history_series : null) : seg && seg.pirate_series;
    var vals = src && src.series && src.series[key.slice(2)];
    if (!vals) return null;
    vals = vals.slice(-30);
    /* A running server total reads as its daily increase. */
    if (key === 'h:signups_started' || key === 'h:signed_up') vals = increments(vals);
    var finite = vals.filter(function (v) { return v != null; });
    return finite.length > 1 ? finite : null;
  }
  function isPlain(d) {
    var f = d.filters || {};
    return !f.guild && !f.interface && !f.activity && !f.replicants && !f.compare;
  }

  // ── Health: what each figure rests on ──
  function when(ms) { return ms ? H.ago(ms) : '—'; }
  function sum(rows, f) { return rows.reduce(function (a, r) { return a + (Number(f(r)) || 0); }, 0); }
  function plural(n, one, many) { return int(n) + ' ' + (n === 1 ? one : many); }
  /* [name, holds, read, follows, error, read?]. A source not read yet is not healthy. */
  function sourceRows(d) {
    var c = d.crawl || {}, p = c.players || {}, r = c.replicants || {}, round = p.round || {};
    var guilds = d.guilds || [], apis = guilds.filter(function (g) { return g.status !== 'no_api'; });
    var ok = guilds.filter(function (g) { return g.status === 'ok'; }).length;
    var runs = (d.segments || []).reduce(function (a, s) { return a + ((s.runs || {}).runs || 0); }, 0);
    var sessions = (d.segments || []).reduce(function (a, s) { return a + (s.sessions || 0); }, 0);
    var hist = d.history || [];
    var all = 'Every filter', server = 'App, guild';
    var settled = !!c.finished_ms && !c.running;
    return [
      ['Chain tables', int(p.known) + ' players', when(p.refreshed_ms), all, round.tables_error, !!p.refreshed_ms],
      ['Replicants', int(r.known) + ' confirmed · ' + int(r.likely) + ' suspected', when(r.read_ms) + (r.source ? ' · from the ' + r.source : ''), all, round.replicants_error, !!r.read_ms],
      ['Ledgers', int(p.human_ledgers) + ' of ' + int(p.humans) + ' humans', when(p.refreshed_ms), all, round.ledger_errors ? round.ledger_last_error : null, !!p.refreshed_ms],
      ['Signup sample', int(sessions) + ' sessions', when(c.finished_ms), all, c.finished_ms && !c.running && !sessions ? 'No sessions read' : null, sessions > 0],
      ['Server funnels', ok + ' of ' + apis.length + ' guilds', when(d.generated_ms), server, null, ok > 0],
      ['Unique players', int(sum(guilds, function (g) { return (g.tutorial_players || {}).players; })) + ' players', when(d.generated_ms), server, null, ok > 0],
      ['Runs', int(runs) + ' runs', when(d.generated_ms), all, null, ok > 0],
      ['Daily record', plural(hist.length, 'day', 'days'), hist.length ? 'through ' + shortDay(hist[hist.length - 1].day) : '—', 'Guild', null, hist.length > 0],
    ].map(function (r) {
      /* Once a read has finished, a source it never filled is missing, not pending. */
      if (settled && !r[5] && !r[4]) r[4] = 'Not read in the last full read';
      return r;
    });
  }
  /* What is wrong now, worst first, each with where to look and what fixes it. */
  function issuesOf(d) {
    var g = d.guilds || [], out = [], r = (d.crawl || {}).replicants || {};
    var names = function (rows) { return rows.map(function (x) { return x.name ? x.name + (x.tag ? ' (' + x.tag + ')' : '') : x.id; }).join(' · '); };
    sourceRows(d).forEach(function (s) { if (s[4]) out.push({ level: 'issue', title: s[0] + ' failing', where: String(s[4]), count: '', page: 'data', fix: 'The next read retries it; Read again now forces one.' }); });
    if (r.source === 'guild') out.push({ level: 'issue', title: 'Replicants read from the guild', where: 'Humans may be overcounted', count: int(r.known) + ' known', page: 'data', fix: 'The chain\'s permission store could not be read, so the guild\'s list was used; it misses older replicants. Read again now retries the chain.' });
    var failing = g.filter(function (x) { return x.status === 'error'; });
    if (failing.length) out.push({ level: 'issue', title: 'Guilds failing', where: names(failing), count: plural(sum(failing, function (x) { return x.players; }), 'player', 'players'), page: 'guilds', fix: 'Their API answers with an error: open the guild row for the message.' });
    var lost = g.filter(function (x) { return x.no_player > 0; }), noPlayer = sum(g, function (x) { return x.no_player; });
    if (noPlayer) out.push({ level: 'issue', title: 'Runs with no player', where: names(lost), count: int(noPlayer) + ' of ' + int(sum(g, function (x) { return x.runs; })) + ' runs', page: 'players', view: 'runs', fix: 'The run never recorded who played: the launch message was lost. Older app versions do this.' });
    var dark = g.filter(function (x) { return x.status === 'no_api'; });
    if (dark.length) out.push({ level: 'notice', title: 'Guilds with no API', where: names(dark), count: plural(sum(dark, function (x) { return x.players; }), 'player', 'players') + ' unseen', page: 'guilds', fix: 'These guilds publish no API, so their signups and tutorial are not counted.' });
    var days = (d.history || []).length, c0 = d.crawl || {};
    if (reconcileRows(d).some(function (r) { return !r.ok; })) out.push({ level: 'notice', title: 'Sources disagree', where: reconcileRows(d).filter(function (r) { return !r.ok; }).map(function (r) { return r.label; }).join(' · '), count: '', page: 'data', fix: 'The chain\'s tables and the daily record give different figures for the same window: see Do the sources agree? on Data.' });
    if (days < 7 && days > 0) out.push({ level: 'notice', title: 'Daily record is short', where: days ? 'Since ' + d.history[0].day : 'Nothing recorded', count: plural(days, 'day', 'days'), page: 'trends', fix: 'The app records one row a day while it runs; changes over 7 or 30 days need that many.' });
    return out;
  }
  /* Players the guild list leaves out: no guild on chain. Only countable when
   * the page shows the same population as the guild rows. */
  function unguilded(d) {
    var f = d.filters || {}, segs = d.segments || [];
    if (segs.length !== 1 || f.guild || f.interface || f.activity) return 0;
    return Math.max(0, (segs[0].players || 0) - sum(d.guilds || [], function (g) { return g.players; }));
  }

  /* What needs a look, in player words, ranked: game findings first, the
   * data's own trouble as one row at the end. Each is a door to its page. */
  function signalsOf(d) {
    var segs = d.segments || [], out = [];
    if (!segs.length) return out;
    segs.forEach(function (seg, i) {
      segSignals(d, seg, i === 0 && segs.length === 1).forEach(function (x) {
        if (segs.length > 1) { x.seg = i; x.segLabel = segName(seg); x.segKey = seg.key; }
        out.push(x);
      });
    });
    var rank = { bad: 0, warn: 1, good: 2, info: 3 };
    out = out.map(function (x, i) { x.i = i; return x; }).sort(function (a, b) { return rank[a.level] - rank[b.level] || a.i - b.i; });
    out = out.slice(0, segs.length > 1 ? 8 : 6);
    var issues = issuesOf(d).filter(function (x) { return x.level === 'issue'; });
    if (issues.length) out.push({ level: 'bad', title: plural(issues.length, 'data issue', 'data issues'), detail: issues.map(function (x) { return x.title; }).join(' · '), value: 'Data', page: 'data', data: true });
    return out;
  }
  function segSignals(d, seg, first) {
    var out = [], bot = seg.key === 'replicant';
    var su = bot ? [] : orderSteps((seg.signup && seg.signup.steps) || []).filter(function (r) { return !r.aside && r.dropped > 0 && r.reached >= SMALL_N; });
    var worst = su.sort(function (a, b) { return b.dropped / b.reached - a.dropped / a.reached; })[0];
    if (worst) out.push({ level: 'warn', title: 'Most signups stop at ' + stepLabel(worst.key), detail: plural(worst.dropped, 'session stopped', 'sessions stopped') + ' here', value: pct1(worst.dropped / worst.reached) + ' stop rate', page: 'acquisition', key: worst.key });
    var ph = (bot ? [] : phaseRows(seg)).filter(function (r) { return r.phase > 0 && r.stopped > 0 && r.reached >= SMALL_N; }).sort(function (a, b) { return b.stopped / b.reached - a.stopped / a.reached; })[0];
    if (ph) out.push({ level: 'warn', title: 'Combat Training loses most at ' + ph.label, detail: plural(ph.stopped, 'player stopped', 'players stopped') + ' in this phase', value: pct1(ph.stopped / ph.reached) + ' stop rate', page: 'onboarding', view: 'phases', key: 'phase:' + ph.phase });
    var dw = bot ? {} : seg.dwell || {}, slow = Object.keys(dw).filter(function (k) { return dw[k] && dw[k].n >= SMALL_N; }).sort(function (a, b) { return dw[b].p50 - dw[a].p50; })[0];
    if (slow) out.push({ level: 'info', title: 'Slowest step: ' + (slow.indexOf('signup.') === 0 ? 'Signup · ' : '') + stepLabel(slow), detail: 'one in ten take ' + dur(dw[slow].p90) + ' or more', value: dur(dw[slow].p50) + ' typical', page: 'onboarding', view: 'timing' });
    var imp = first ? (d.tutorial_impact || []) : [], all = imp.filter(function (r) { return r.key === 'all'; })[0];
    var best = imp.filter(function (r) { return r.key !== 'all' && r.players >= BEST_N; }).sort(function (a, b) { return b.activated / b.players - a.activated / a.players; })[0];
    if (best && all && all.players && best.activated / best.players > all.activated / all.players) {
      out.push({ level: 'good', title: 'Players who ' + ({ finished: 'finished', quit: 'quit', skipped: 'skipped', none: 'never saw' }[best.key] || best.label.toLowerCase()) + ' the tutorial activate most', detail: int(best.activated) + ' of ' + int(best.players) + ' activated, since telemetry began', value: pct(best.activated / best.players) + ' against ' + pct(all.activated / all.players) + ' of all players since then', page: 'onboarding', view: 'impact' });
    }
    var co = (seg.cohorts || []).filter(function (c) { return c.n >= SMALL_N && c.alive && c.alive.length; });
    if (co.length > 1) {
      var last = co[co.length - 1], rest = co.slice(0, -1);
      var avg = sum(rest, function (c) { return c.alive[0]; }) / (sum(rest, function (c) { return c.n; }) || 1), now = last.alive[0] / last.n;
      out.push({ level: now < avg ? 'warn' : 'good', title: 'Joined week of ' + weekStart(last.year, last.week) + ': ' + pct(now) + ' still acting after a week', detail: plural(last.n, 'player joined', 'players joined'), value: pct(avg) + ' in earlier weeks', page: 'engagement', view: 'retention' });
    }
    var a = allOf(seg);
    if (a.players) out.push({ level: 'info', title: pct(a.activated / a.players) + ' of players have activated', detail: int(a.activated) + ' of ' + int(a.players), value: seg.pirate && seg.pirate.time_to_activate ? dur(seg.pirate.time_to_activate.p50) + ' typical to activate' : '', page: 'engagement', view: 'activation' });
    return out;
  }

  // ── Card params ──
  function argsOf(p) {
    var a = { idleHours: Number(p.idle) || 24, activeDays: Number(p.active) || 7,
      filters: { interface: p.iface || null, guild: p.guild || null, activity: p.activity || null, replicants: p.reps === '1', compare: p.compare || null,
        include_excluded: p.excl === '1' } };
    if (p.version) a.version = p.version;
    return a;
  }
  function pageOf(p) { return SECTIONS.some(function (s) { return s[0] === p.page; }) ? p.page : 'overview'; }
  function viewOf(p) {
    var list = VIEWS[pageOf(p)];
    if (!list) return null;
    return list.some(function (v) { return v[0] === p.view; }) ? p.view : list[0][0];
  }
  var SPLIT_WORDS = { interface: 'interface', app: 'interface', guild: 'guild', activity: 'activity', replicant: 'replicant', version: 'version', tutorial: 'tutorial', outcome: 'tutorial' };
  /* `TELEMETRY retention 7d`, `TELEMETRY onboarding runs`, `TELEMETRY guild 0-5 split app`. */
  function parseArgs(rest) {
    var out = {}, words = String(rest || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      var w = words[i], nx = words[i + 1];
      /* A view of the section already named wins over a section's alias. */
      if (out.page && VIEWS[out.page] && VIEWS[out.page].some(function (v) { return v[0] === w; })) { out.view = w; continue; }
      if (ALIASES[w]) {
        var al = ALIASES[w];
        if (out.page && out.page !== al[0]) return null;
        out.page = al[0];
        if (al[1]) out.view = al[1];
        continue;
      }
      var win = { '24h': '1', '1d': '1', '7d': '7', '30d': '30' }[w];
      if (win) { out.win = win; continue; }
      if (/^0-\d+$/.test(w)) { out.guild = w; continue; }
      if (w === 'guild' && nx && /^0-\d+$/.test(nx)) { out.guild = nx; i++; continue; }
      if ((w === 'split' || w === 'by' || w === 'compare') && nx && SPLIT_WORDS[nx.replace(/s$/, '')]) { out.compare = SPLIT_WORDS[nx.replace(/s$/, '')]; i++; continue; }
      if (w === 'replicants') { out.reps = '1'; continue; }
      if (w === 'active' || w === 'inactive') { out.activity = w; continue; }
      if (w === 'desktop' || w === 'webapp') { out.iface = 'structs-' + w; continue; }
      if (/^tutorial-\d+$/.test(w)) { out.version = w; continue; }
      return null;
    }
    return out;
  }
  /* The ⌘K line that reopens this exact view; parseArgs reads it back. */
  function wordOf(p) {
    var page = pageOf(p), view = viewOf(p), parts = ['TELEMETRY'];
    if (page !== 'overview') parts.push(page);
    if (view && VIEWS[page] && view !== VIEWS[page][0][0]) parts.push(view);
    if (p.win && p.win !== '30') parts.push(p.win === '1' ? '24h' : p.win + 'd');
    if (p.guild) parts.push('guild', p.guild);
    if (p.compare) parts.push('split', p.compare);
    if (p.activity) parts.push(p.activity);
    if (p.reps === '1') parts.push('replicants');
    if (p.iface === 'structs-desktop' || p.iface === 'structs-webapp') parts.push(p.iface.slice(8));
    if (p.version) parts.push(p.version);
    return parts.join(' ');
  }

  // ── Drawing primitives: one of each, used by every section ──
  function cell(text, cls, title) {
    var c = H.el('span', 'ob-c' + (cls ? ' ' + cls : ''), text == null ? '—' : String(text));
    /* A raw step key on hover reads as its full name, then the key. */
    if (title && /^(signup|orientation|tutorial)\./.test(title)) title = stepLabel(title) + ' (' + title + ')';
    if (title) c.title = title;
    return c;
  }
  function sub(text) { return H.el('span', 'ob-sub', text); }
  /* A figure with a second line under it: "11" / "of 12". */
  function stack(main, under, cls, title) {
    var c = cell(main, cls, title);
    if (under != null && main !== '—') c.appendChild(H.el('span', 'ob-sub ob-of', under));
    return c;
  }
  function bar(frac, cls) {
    var b = H.el('span', 'ob-bar' + (cls ? ' ' + cls : ''));
    var f = H.el('span', 'ob-bar-fill');
    f.style.width = (Math.max(0, Math.min(1, Number(frac) || 0)) * 100) + '%';
    b.appendChild(f);
    return b;
  }
  /* A bar in parts, each [class, fraction]. */
  function bars(parts) {
    var b = H.el('span', 'ob-bar');
    parts.forEach(function (p) {
      var f = H.el('span', p[0]);
      f.style.width = (Math.max(0, Math.min(1, Number(p[1]) || 0)) * 100) + '%';
      b.appendChild(f);
    });
    return b;
  }
  function segName(s) {
    if (IFACE[s.key] && s.label === s.key) return IFACE[s.key];
    if (/^tutorial-\d+$/.test(s.label || '')) return s.label.replace(/^tutorial-/, 'Tutorial v');
    return s.label;
  }
  function swatch(i, key) { return H.el('span', 'ob-swatch ' + (OUTCOME_SEG[key] || 'ob-sw-' + (i % SWATCHES))); }
  function segLabel(s, i, text) {
    var n = H.el('span', 'ob-seglabel');
    n.appendChild(swatch(i, s.key));
    n.appendChild(H.el('span', null, text || segName(s)));
    return n;
  }
  function link(label, onClick, cls) {
    var a = H.el('a', 'ob-link' + (cls ? ' ' + cls : ''));
    a.href = 'javascript:void(0)';
    if (label && label.nodeType) a.appendChild(label); else a.textContent = label;
    a.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(ev); });
    return a;
  }
  /* A table: columns are [{label, k: 't'|'n'|'b'|'s', w?, opt?, sort?, def?}].
   * `t` text (left), `n` number (right), `b` bar, `s` sparkline. `opt` columns
   * step aside in a one-wide card. `sort` makes the caption a sort key. Widths
   * are fractions of the card, so every row of a table lines up. */
  function grid(cls, cols, sort, onSort) {
    var t = H.el('div', 'ob-table' + (cls ? ' ' + cls : ''));
    var width = function (c, i) { return c.w || (c.k === 't' ? (i === 0 ? 'minmax(16ch, 1.4fr)' : 'minmax(10ch, 1fr)') : c.k === 'b' ? 'minmax(8ch, 1.6fr)' : c.k === 's' ? 'minmax(8ch, .8fr)' : 'minmax(7ch, .55fr)'); };
    t.style.setProperty('--ob-cols', cols.map(width).join(' '));
    t.style.setProperty('--ob-cols-narrow', cols.map(function (c, i) { return c.opt ? null : i === 0 ? 'minmax(0, 2fr)' : c.k === 't' ? 'minmax(0, 1fr)' : 'minmax(0, 1fr)'; }).filter(Boolean).join(' '));
    t._cols = cols;
    var r = H.el('div', 'ob-row ob-head');
    cols.forEach(function (c) {
      var cls2 = 'ob-c' + (c.k === 'n' ? ' ob-n' : '') + (c.opt ? ' ob-opt' : '');
      var node;
      if (c.sort && sort) {
        var on = sort.key === c.sort;
        node = link(c.label, function () {
          if (sort.key === c.sort) sort.dir = -sort.dir; else { sort.key = c.sort; sort.dir = c.k === 't' ? 1 : -1; }
          onSort();
        }, cls2 + ' ob-sort' + (on ? ' is-on' : ''));
        if (on) node.appendChild(H.el('i', H.iconClass(sort.dir > 0 ? 'icon-caret-up' : 'icon-caret-down', 'sui-icon-sm')));
        node.setAttribute('data-sort', c.sort);
      } else if (c.label && c.label.nodeType) {
        node = H.el('span', cls2);
        node.appendChild(c.label);
      } else node = H.el('span', cls2, c.label || '');
      if (c.def || DEFS[c.label]) node.title = c.def || DEFS[c.label];
      r.appendChild(node);
    });
    t.appendChild(r);
    return t;
  }
  function addRow(t, cells, opts) {
    opts = opts || {};
    var r = H.el('div', 'ob-row' + (opts.cls ? ' ' + opts.cls : ''));
    cells.forEach(function (c, i) {
      var col = (t._cols || [])[i] || {};
      var node = c && c.nodeType ? c : cell(c, i === 0 ? 'ob-step' : null);
      if (col.k === 'n') node.classList.add('ob-n');
      if (col.opt) node.classList.add('ob-opt');
      r.appendChild(node);
    });
    Object.keys(opts.data || {}).forEach(function (k) { r.setAttribute('data-' + k, opts.data[k]); });
    if (opts.title) r.title = opts.title;
    t.appendChild(r);
    return r;
  }
  /* The one drill: a row whose first cell opens a panel under it (players,
   * steps, facts). Remembered across redraws by `key`. */
  function drill(t, r, key, build) {
    var first = r.firstChild;
    var a = H.el('a', first.className + ' ob-link ob-drill');
    a.href = 'javascript:void(0)';
    var mark = H.el('i', H.iconClass(OB.open[key] ? 'icon-caret-down' : 'icon-caret-right', 'sui-icon-sm'));
    a.appendChild(mark);
    var body = H.el('span', 'ob-drill-body');
    while (first.firstChild) body.appendChild(first.firstChild);
    a.appendChild(body);
    if (first.title) a.title = first.title;
    r.replaceChild(a, first);
    function sync() {
      var next = r.nextSibling;
      if (next && next.classList && next.classList.contains('ob-panel')) t.removeChild(next);
      r.classList.toggle('is-open', !!OB.open[key]);
      mark.className = H.iconClass(OB.open[key] ? 'icon-caret-down' : 'icon-caret-right', 'sui-icon-sm');
      if (OB.open[key]) { var p = build(); p.classList.add('ob-panel'); t.insertBefore(p, r.nextSibling); }
    }
    a.addEventListener('click', function () { OB.open[key] = !OB.open[key]; sync(); });
    if (OB.open[key]) sync();
    return a;
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
    var s = (x.name ? [x.player_id] : []).concat(tag ? [tag] : []).join(' · ');
    if (s) who.appendChild(sub(s));
    who.addEventListener('click', function () { T.execute('PLAYER ' + x.player_id); });
    return who;
  }
  /* The players behind a row: the same list wherever it opens, with what the
   * servers did not list said plainly and a door to all of them. */
  function whoList(ctx, who, step) {
    var d = ctx.d, tags = guildTags(d);
    var box = H.el('div', 'ob-who');
    var head = H.el('div', 'ob-who-head');
    head.appendChild(sub(who.total > who.players.length ? int(who.players.length) + ' listed of ' + int(who.total) + ' stopped' : plural(who.players.length, 'player', 'players')));
    var ids = who.players.map(function (x) { return x.player_id; }).join('\n');
    head.appendChild(actionBtn('Copy ids', function () { copyText(ids, who.players.length); }, 'copy_ids'));
    if (step) head.appendChild(actionBtn('All stopped', function () { ctx.st.stepFilter = step; ctx.go('players', 'stopped'); }, 'all_stopped'));
    box.appendChild(head);
    who.players.forEach(function (x) {
      var r = H.el('div', 'ob-who-row');
      r.setAttribute('data-player', x.player_id);
      r.appendChild(playerLink(x));
      r.appendChild(cell(tags[x.guild_id] || x.guild_id, 'ob-n'));
      r.appendChild(cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-n'));
      r.appendChild(cell(OUTCOME_LABEL[x.outcome] || x.outcome, 'ob-out-' + x.outcome));
      box.appendChild(r);
    });
    return box;
  }
  function factGrid(rows) {
    var box = H.el('div', 'ob-more');
    rows.forEach(function (r) {
      var f = H.el('span', 'ob-fact');
      f.appendChild(sub(r[0]));
      f.appendChild(H.el('span', 'ob-v', r[1]));
      box.appendChild(f);
    });
    return box;
  }

  /* Copy: what a block shows, as tab-separated rows a spreadsheet pastes. */
  function cellText(c) {
    if (!c.children.length) return c.textContent.trim();
    var parts = [];
    c.childNodes.forEach(function (n) { var s = (n.textContent || '').trim(); if (s) parts.push(s); });
    return parts.join(' ');
  }
  function tsvOf(node) {
    var lines = [];
    if (node.querySelector('.ob-tile')) lines.push(['Figure', 'Value', 'Previous', 'Change', 'Change %', 'Detail', 'Period', 'Dates'].join('\t'));
    node.querySelectorAll('.ob-table > .ob-row, .ob-cohort, .ob-tile, .ob-signal').forEach(function (r) {
      var a = function (k) { return r.getAttribute(k) || ''; };
      if (r.classList.contains('ob-tile')) {
        var q = function (s) { var n = r.querySelector(s); return n ? n.textContent.trim() : ''; };
        lines.push([q('.ob-tile-label'), q('.fstat-v'), a('data-prev'), a('data-change'), a('data-pct'), q('.ob-tile-sub'), a('data-scope'), a('data-from')].join('\t'));
        return;
      }
      if (r.classList.contains('ob-signal')) {
        var t = function (s) { var n = r.querySelector(s); return n ? n.textContent.trim() : ''; };
        lines.push([t('.ob-signal-title'), t('.ob-signal-detail'), t('.ob-signal-value')].join('\t'));
        return;
      }
      var cells = [];
      for (var i = 0; i < r.children.length; i++) cells.push(cellText(r.children[i]));
      if (cells.some(Boolean)) lines.push(cells.join('\t'));
    });
    return lines.join('\n');
  }
  function copyText(s, n) {
    var done = function () { if (Board.stamp) Board.stamp('Copied ' + (n == null ? '' : plural(n, 'row', 'rows'))); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s).then(done, fallback); return; }
    } catch (e) { /* fall back */ }
    fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
      document.body.removeChild(ta);
      done();
    }
  }
  function chip(text, title) { var c = H.el('span', 'ob-chip', text); if (title) c.title = title; return c; }
  /* A block: title, its scope chip, then the same actions in the same order: Chart, Copy. */
  function block(title, opts) {
    opts = opts || {};
    var b = H.el('div', 'ob-block' + (opts.cls ? ' ' + opts.cls : ''));
    if (opts.key) b.setAttribute('data-block', opts.key);
    var head = H.el('div', 'ob-block-head');
    var t = H.el('span', 'ob-title sui-text-header', title || '');
    if (opts.def) t.title = opts.def;
    head.appendChild(t);
    var acts = H.el('span', 'ob-actions');
    if (OB.tag && !opts.noTag) { var g = chip(OB.tag, 'Filtered to this guild'); g.classList.add('is-set'); acts.appendChild(g); }
    if (opts.scope) acts.appendChild(chip(opts.scope, opts.scopeDef));
    (opts.extra || []).forEach(function (n) { acts.appendChild(n); });
    if (opts.chart) acts.appendChild(actionBtn('Chart', opts.chart, 'chart'));
    if (opts.copy !== false) acts.appendChild(actionBtn('Copy', function () { var s = tsvOf(b); copyText(s, s ? s.split('\n').length : 0); }, 'copy'));
    head.appendChild(acts);
    b.appendChild(head);
    return b;
  }
  function actionBtn(label, onClick, key) {
    var a = H.el('a', 'sui-screen-btn sui-mod-secondary ob-act', label);
    a.href = 'javascript:void(0)';
    a.setAttribute('data-act', key);
    a.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(); });
    return a;
  }
  /* The change line under a figure: ▲/▼, by how much, against what. */
  function deltaNode(dl, days) {
    if (!dl) return null;
    var span = { 1: 'day', 7: '7d', 30: '30d' }[days] || days + 'd';
    if (dl.mismatch) {
      var m = H.el('span', 'ob-delta is-mismatch', '≠ daily record ' + int(dl.now));
      m.title = 'The daily record reads ' + int(dl.now) + ' for this window against ' + int(dl.figure) + ' here. The two sources disagree, so no change is shown.';
      return m;
    }
    var rel = dl.then > 0 ? Math.abs(dl.change) / dl.then : null;
    var up = dl.change > 0, down = dl.change < 0, tiny = rel != null && rel < 0.001;
    var n = H.el('span', 'ob-delta' + (tiny || !(up || down) ? ' is-flat' : up ? ' is-up' : ' is-down'));
    n.title = DEFS.Change + ' Was ' + int(dl.then) + ', now ' + int(dl.now) + '.';
    if ((up || down) && !tiny) n.appendChild(H.el('i', H.iconClass(up ? 'icon-caret-up' : 'icon-caret-down', 'sui-icon-sm')));
    var text = !(up || down) ? 'no change vs prior ' + span + ' · ' + int(dl.then)
      : signed(dl.change) + (rel == null ? '' : ' · ' + (tiny ? '< 0.1%' : pct(rel))) + ' vs prior ' + span;
    n.appendChild(H.el('span', null, text));
    return n;
  }
  /* A KPI tile: stage, caption, the figure, one line under it, its change,
   * its history, and its own scope when that differs from the strip's. */
  function tile(spec) {
    var t = H.el('div', 'fstat ob-tile' + (spec.cls ? ' ' + spec.cls : ''));
    if (spec.key) t.setAttribute('data-kpi', spec.key);
    t.setAttribute('data-scope', spec.scope || spec.period || '');
    if (spec.delta && !spec.delta.mismatch) { t.setAttribute('data-prev', spec.delta.then); t.setAttribute('data-change', spec.delta.change); t.setAttribute('data-pct', spec.delta.then > 0 ? (spec.delta.change / spec.delta.then * 100).toFixed(1) + '%' : ''); }
    if (spec.from) t.setAttribute('data-from', spec.from);
    var top = H.el('div', 'ob-tile-top');
    if (spec.stage) top.appendChild(H.el('span', 'ob-tile-stage', spec.stage));
    if (spec.scope) top.appendChild(H.el('span', 'ob-tile-scope', spec.scope));
    if (top.firstChild) t.appendChild(top);
    t.appendChild(H.el('div', 'fstat-l ob-tile-label', spec.label));
    t.appendChild(H.el('div', 'fstat-v', spec.value == null ? '—' : String(spec.value)));
    if (spec.sub) t.appendChild(H.el('div', 'fstat-l fstat-l2 ob-tile-sub', spec.sub));
    var dn = deltaNode(spec.delta, spec.deltaDays);
    if (dn) t.appendChild(dn);
    var def = spec.def || DEFS[spec.label];
    if (def) t.title = def;
    if (spec.spark && spec.spark.length > 1) {
      var sp = H.el('span', 'ob-tile-spark ob-spark');
      sp.appendChild(window.StructsCards.sparkline(spec.spark, 'player', spec.label));
      t.appendChild(sp);
    }
    if (spec.go) {
      t.classList.add('is-door');
      t.setAttribute('role', 'link');
      t.tabIndex = 0;
      t.addEventListener('click', spec.go);
      t.addEventListener('keydown', function (e) { if (e.key === 'Enter') spec.go(); });
    }
    return t;
  }
  /* The KPI strip: tiles for one segment, a figure × segment table for a split.
   * `defs`: [{key, stage, label, get(seg) → {value, sub, cls, spark, delta, scope}, go?}]. */
  function kpi(ctx, defs, scope, period) {
    var segs = ctx.segs, box = H.el('div', 'ob-kpi');
    box.setAttribute('data-block', 'kpi');
    var head = H.el('div', 'ob-kpi-head');
    head.appendChild(scope);
    head.appendChild(actionBtn('Copy', function () { var s = tsvOf(box); copyText(s, s ? s.split('\n').length - 1 : 0); }, 'copy'));
    box.appendChild(head);
    if (segs.length === 1) {
      var hud = H.el('div', 'ob-hud');
      defs.forEach(function (k) {
        var v = k.get(segs[0]) || {};
        var scope = v.scope || k.scope;
        hud.appendChild(tile({ key: k.key, stage: k.stage, label: v.label || k.label, value: v.value, sub: v.sub, cls: v.cls || k.cls, spark: v.spark, def: k.def,
          go: k.go, delta: v.delta, deltaDays: ctx.win, scope: scope, period: period, from: !scope && /days|day/.test(period || '') ? periodDates(ctx.win) : null }));
      });
      box.appendChild(hud);
      return box;
    }
    var sums = defs.some(function (k) { return k.count; });
    var t = grid('ob-kpi-table', [{ label: '', k: 't' }].concat(segs.map(function (s, i) { return { label: segLabel(s, i), k: 'n' }; }))
      .concat(sums ? [{ label: 'Sum', k: 'n', opt: true, def: 'The segments added up, for counts only: a rate does not add.' }] : []));
    defs.forEach(function (k) {
      var name = cell(k.label + (k.scope && k.label.indexOf(k.scope) < 0 ? ' · ' + k.scope : ''), 'ob-step', k.def || DEFS[k.label]);
      var r = addRow(t, [name].concat(segs.map(function (s) {
        var v = k.get(s) || {}, c = stack(v.value == null ? '—' : String(v.value), v.sub);
        var dn = deltaNode(v.delta, ctx.win);
        if (dn) c.appendChild(dn);
        return c;
      })).concat(sums ? [k.count ? cell(int(segs.reduce(function (a, s) { var v = k.get(s) || {}; return v.raw == null ? NaN : a + v.raw; }, 0)), 'ob-v') : '—'] : []), { data: { kpi: k.key } });
      if (k.go) { r.firstChild.classList.add('is-door'); r.firstChild.addEventListener('click', k.go); }
    });
    box.appendChild(t);
    return box;
  }
  /* "Nov 14–Nov 20": the days a window covers, ending today. */
  function periodDates(win) {
    var n = Number(win) || 0;
    if (!n) return '';
    var end = new Date(), start = new Date(end.getTime() - (n - 1) * 86400000);
    var iso = function (x) { return x.toISOString().slice(0, 10); };
    return n === 1 ? shortDay(iso(end)) : shortDay(iso(start)) + '–' + shortDay(iso(end));
  }
  function windowStrip(ctx) {
    var strip = H.navStrip(WINDOWS, ctx.win, function (k) { ctx.set({ win: k }); });
    strip.classList.add('ob-windows');
    return strip;
  }
  function openChart(metrics) {
    T.add('chart', { series: JSON.stringify([].concat(metrics).map(function (m) { return { source: 'telemetry', metric: m }; })), window: '2592000' }, 2);
  }
  function chartLink(label, metric) {
    if (!metric) return cell(label, 'ob-step', DEFS[label]);
    var a = link(label, function () { openChart(metric); }, 'ob-c ob-step');
    a.setAttribute('data-chart', metric);
    if (DEFS[label]) a.title = DEFS[label];
    return a;
  }
  function spark(vals, title) {
    var sp = H.el('span', 'ob-c ob-spark');
    if (vals && vals.length > 1) sp.appendChild(window.StructsCards.sparkline(vals, 'player', title));
    return sp;
  }

  // ── Funnels: one component, one vocabulary ──
  /* Reached · Kept · Stopped · Stop rate · [Skipped · Skip rate] · Median · p90,
   * flagged by stop rate (red), skip rate and time (amber) above SMALL_N. */
  function funnelSingle(ctx, seg, steps, withSkips) {
    var d = ctx && ctx.d, rows = orderSteps(steps || []);
    var main = rows.filter(function (r) { return !r.aside; });
    var stopTop = worstRates(main, function (r) { return r.reached; }, function (r) { return r.dropped; }, FLAG_TOP);
    var skipTop = withSkips ? worstRates(main, function (r) { return r.reached; }, function (r) { return r.skipped; }, FLAG_TOP) : [];
    var slowTop = topKeys(main, function (r) { var w = dwellOf(seg, r.key); return w && w.n >= SMALL_N ? w.p50 : null; }, FLAG_TOP);
    var cols = [{ label: 'Step', k: 't', w: 'minmax(18ch, 1.6fr)' }, { label: '', k: 'b', opt: true }, { label: 'Reached', k: 'n' }, { label: 'Kept', k: 'n', opt: true },
      { label: 'Stopped', k: 'n', opt: true }, { label: 'Stop rate', k: 'n' }];
    if (withSkips) cols = cols.concat([{ label: 'Skipped', k: 'n', opt: true }, { label: 'Skip rate', k: 'n', opt: true, def: 'Share of this step\'s players who skipped it.' }]);
    cols = cols.concat([{ label: 'Median', k: 'n', def: 'Typical time until the next step.' }, { label: 'p90', k: 'n', opt: true }]);
    var first = main.reduce(function (m, r) { return Math.max(m, r.reached || 0); }, 0);
    var t = grid('ob-funnel' + (first < SMALL_N ? ' is-small' : ''), cols);
    rows.forEach(function (r) {
      var w = dwellOf(seg, r.key);
      var quit = stopTop.indexOf(r.key) >= 0, sk = skipTop.indexOf(r.key) >= 0, slow = slowTop.indexOf(r.key) >= 0;
      var rate = r.dropped == null || !r.reached ? null : r.dropped / r.reached;
      var cells = [cell((r.aside ? '↳ ' : '') + stepLabel(r.key), 'ob-step', r.key), bar(ratio(r.reached, first), r.aside ? 'is-aside' : ''), int(r.reached),
        r.aside ? '—' : pct(ratio(r.reached, first)), cell(r.dropped == null ? '—' : int(r.dropped), quit ? 'is-bad' : ''), cell(pct1(rate), quit ? 'is-bad' : '')];
      if (withSkips) cells = cells.concat([cell(r.skipped ? int(r.skipped) : '—', sk ? 'is-slow' : ''), r.skipped ? pct(r.skip_rate) : '—']);
      cells = cells.concat([cell(w ? dur(w.p50) : '—', slow ? 'is-slow' : '', w ? 'Time until the next step, ' + w.n + ' players' : null), w ? dur(w.p90) : '—']);
      var row = addRow(t, cells, { data: { step: r.key }, cls: r.aside ? 'is-aside' : '' });
      var who = d && d.stopped && d.stopped[r.key];
      if (who) drill(t, row, r.key, function () { return whoList(ctx, who, r.key); });
    });
    return t;
  }
  /* A funnel split by segment: per segment Kept and Stop rate, and with two
   * segments the difference, so a version against a version reads directly. */
  function funnelCompare(segs, pick, label) {
    var lists = segs.map(function (s) { return orderSteps(pick(s) || []).filter(function (r) { return !r.aside; }); });
    var base = lists.reduce(function (m, r) { return r.length > m.length ? r : m; }, []);
    var cols = [{ label: label || 'Step', k: 't', w: 'minmax(18ch, 1.4fr)' }];
    segs.forEach(function (s, si) { cols.push({ label: segLabel(s, si, segName(s) + ' · Kept'), k: 'n', opt: true }, { label: segLabel(s, si, segName(s) + ' · Stop rate'), k: 'n' }); });
    var two = segs.length === 2;
    if (two) cols.push({ label: 'Δ stop rate ' + segName(segs[0]) + ' − ' + segName(segs[1]), k: 'n', def: 'Stop rate of ' + segName(segs[0]) + ' minus ' + segName(segs[1]) + ', in percentage points. Red: more stop in ' + segName(segs[0]) + '. Grey: within two standard errors (noise), under 1 point, or fewer than 20 reached.' });
    var t = grid('ob-compare ob-funnel-compare', cols);
    base.forEach(function (r0) {
      var cells = [cell(r0.label || stepLabel(r0.key), 'ob-step', r0.key)], rates = [], ns = [];
      lists.forEach(function (rows) {
        var first = rows.length ? rows[0].reached : 0;
        var r = rows.filter(function (x) { return x.key === r0.key; })[0] || {};
        var rate = r.dropped == null || !r.reached ? null : r.dropped / r.reached;
        rates.push(rate);
        ns.push(r.reached || 0);
        cells.push(stack(pct(ratio(r.reached, first)), r.reached != null ? int(r.reached) + ' reached' : null), pct1(rate));
      });
      if (two) {
        var dd = rates[0] == null || rates[1] == null ? null : (rates[0] - rates[1]) * 100;
        /* Grey unless the gap beats two standard errors of the difference. */
        var se = ns[0] && ns[1] && rates[0] != null && rates[1] != null ? Math.sqrt(rates[0] * (1 - rates[0]) / ns[0] + rates[1] * (1 - rates[1]) / ns[1]) * 100 : null;
        var weak = dd == null || Math.abs(dd) < 1 || ns[0] < SMALL_N || ns[1] < SMALL_N || se == null || Math.abs(dd) < 2 * se;
        cells.push(cell(dd == null ? '—' : Math.abs(dd) < 1 ? '< 1 pt' : (dd > 0 ? '+' : '−') + Math.round(Math.abs(dd)) + ' pt', weak ? 'ob-sub' : dd > 0 ? 'is-bad' : 'is-good'));
      }
      addRow(t, cells, { data: { step: r0.key } });
    });
    return t;
  }
  /* Phases as funnel rows (the same shape the step tables use). */
  function phaseSteps(seg) {
    var rows = phaseRows(seg);
    return rows.map(function (r, i) { return { key: 'phase:' + r.phase, label: r.label, reached: r.reached, dropped: rows[i + 1] ? r.stopped : null, skipped: r.skipped, previous: i ? 1 : null, next: rows[i + 1] ? 1 : null }; });
  }
  function journeyTable(segs) {
    if (segs.length === 1) {
      var rows = journeyRows(segs[0]);
      var t = grid('ob-journey-table', [{ label: 'Step', k: 't', w: 'minmax(18ch, 1.3fr)' }, { label: '', k: 'b', w: 'minmax(10ch, 2fr)', opt: true }, { label: 'Reached', k: 'n' },
        { label: 'Step conversion', k: 'n' }, { label: 'Kept', k: 'n', opt: true, def: 'Share of the part\'s first row.' }]);
      var top = 0;
      rows.forEach(function (r) {
        if (r.part) { top = 0; addRow(t, [cell(r.label + ' · ' + int(r.n), 'ob-part')], { cls: 'is-part', data: { part: r.part } }); return; }
        top = top || r.n;
        var weak = r.prev != null && r.prev < 0.5 && r.base >= SMALL_N;
        var label = r.kind === 'step' ? r.label : (r.kind === 'side' ? '↳ ' : '· ') + r.label;
        addRow(t, [cell(label, 'ob-step', DEFS[r.label] || (r.kind === 'side' ? 'Happens apart from the path: no step conversion.' : r.kind === 'now' ? 'Where players are now, not a step.' : null)),
          bar(ratio(r.n, top), r.kind === 'step' ? '' : 'is-aside'), int(r.n), cell(r.prev == null ? '—' : share(r.n, r.base), weak ? 'is-bad' : ''), r.first == null ? '—' : share(r.n, r.firstN)],
          { data: { journey: r.key }, cls: r.kind === 'step' ? '' : 'is-aside' });
      });
      return t;
    }
    var cols = [{ label: 'Step', k: 't', w: 'minmax(18ch, 1.3fr)' }];
    segs.forEach(function (s, i) { cols.push({ label: segLabel(s, i), k: 'n', def: 'Reached, then the step conversion and the share kept of the part\'s first row.' }); });
    var c = grid('ob-compare ob-journey-table', cols);
    var per = segs.map(journeyRows), base = per.reduce(function (m, r) { return r.length > m.length ? r : m; }, []);
    base.forEach(function (r0) {
      if (r0.part) {
        addRow(c, [cell(r0.label + ' · ' + per.map(function (rows) { var p = rows.filter(function (x) { return x.part === r0.part; })[0]; return p ? int(p.n) : '—'; }).join(' / '), 'ob-part')], { cls: 'is-part', data: { part: r0.part } });
        return;
      }
      var mark = r0.kind === 'step' ? '' : r0.kind === 'side' ? '↳ ' : '· ';
      addRow(c, [cell(mark + r0.label, 'ob-step')].concat(per.map(function (rows) {
        var r = rows.filter(function (x) { return x.key === r0.key; })[0];
        if (!r) return '—';
        var bits = [];
        if (r.prev != null) bits.push(share(r.n, r.base) + ' conv');
        if (r.first != null) bits.push(share(r.n, r.firstN) + ' kept');
        return stack(int(r.n), bits.join(' · ') || null);
      })), { data: { journey: r0.key }, cls: r0.kind === 'step' ? '' : 'is-aside' });
    });
    return c;
  }

  // ── Shared KPI figures (the same definition wherever they appear) ──
  function seriesOf(s) { return (s.pirate_series && s.pirate_series.series) || {}; }
  function histSeries(d, key) { return isPlain(d) ? ((d.history_series || {}).series || {})[key] : null; }
  var K = {
    opens: function (ctx) {
      return { key: 'opens', stage: 'Awareness', label: 'Signup opens', count: true, go: function () { ctx.go('acquisition'); }, get: function (s) {
        var x = srvWin(s, ctx.win), inc = increments(histSeries(ctx.d, 'signups_started') || []);
        return { value: int(x && x.started), raw: x && x.started, scope: x && x.partial ? 'since ' + shortDay(x.partial) : null, delta: x && !x.partial ? deltaFor(x.started, inc, ctx.win, 'daily') : null, spark: sparkOf(ctx.d, s, 'h:signups_started', isPlain(ctx.d)) };
      } };
    },
    finished: function (ctx) {
      return { key: 'finished_signups', stage: 'Acquisition', label: 'Finished signups', count: true, go: function () { ctx.go('acquisition'); }, get: function (s) {
        var x = srvWin(s, ctx.win), inc = increments(histSeries(ctx.d, 'signed_up') || []);
        return { value: int(x && x.signed_up), raw: x && x.signed_up, sub: x ? shareOf(x.signed_up, x.started, 'signup opens') : null, scope: x && x.partial ? 'since ' + shortDay(x.partial) : null,
          delta: x && !x.partial ? deltaFor(x.signed_up, inc, ctx.win, 'daily') : null, spark: sparkOf(ctx.d, s, 'h:signed_up', isPlain(ctx.d)) };
      } };
    },
    newPlayers: function (ctx) {
      return { key: 'new', stage: 'Acquisition', label: 'Signups', count: true, def: DEFS.Signups, go: function () { ctx.go('acquisition'); }, get: function (s) {
        var v = winOf(s, ctx.win).new;
        return { value: int(v), raw: v, delta: deltaFor(v, seriesOf(s).new, ctx.win, 'daily'), spark: sparkOf(ctx.d, s, 'p:new') };
      } };
    },
    activated: function (ctx) {
      return { key: 'activated', stage: 'Activation', label: 'Activated', cls: 'ok', count: true, def: DEFS.Activated, go: function () { ctx.go('engagement', 'activation'); }, get: function (s) {
        var x = winOf(s, ctx.win);
        return { value: int(x.activated), raw: x.activated, sub: x.cohort != null ? int(x.cohort) + ' of them signed up in the window' : null, delta: deltaFor(x.activated, seriesOf(s).activations, ctx.win, 'daily'), spark: sparkOf(ctx.d, s, 'p:activations') };
      } };
    },
    active: function (ctx) {
      return { key: 'active', stage: 'Retention', label: activeName(ctx.win), cls: 'ok', def: DEFS.Active, go: function () { ctx.go('engagement', 'retention'); }, get: function (s) {
        var x = winOf(s, ctx.win), key = { 1: 'dau', 7: 'wau', 30: 'mau' }[ctx.win];
        return { value: int(x.active), raw: x.active, sub: shareOf(x.active, allOf(s).players, 'players'), delta: deltaFor(x.active, histSeries(ctx.d, key), ctx.win, 'level'), spark: sparkOf(ctx.d, s, 'h:' + key, isPlain(ctx.d)) };
      } };
    },
    activeUsers: function (ctx) {
      return { key: 'active_users', stage: 'Retention', label: 'Active users', count: true, def: DEFS['Active users'], go: function () { ctx.go('engagement', 'retention'); }, get: function (s) {
        var x = winOf(s, ctx.win), a = allOf(s);
        return { value: int(x.active_activated), raw: x.active_activated, sub: shareOf(x.active_activated, a.activated, 'activated players') };
      } };
    },
    players: function (ctx) {
      return { key: 'players', stage: 'Population', label: 'Players', scope: 'now', count: true, def: DEFS.Players, go: function () { ctx.go('engagement', 'retention'); }, get: function (s) {
        var v = allOf(s).players != null ? allOf(s).players : s.players;
        var who = s.key === 'replicant' ? 'replicants' : (ctx.d.filters || {}).replicants ? 'players' : 'humans';
        return { value: int(v), raw: v, sub: who + ' on chain', delta: deltaFor(v, seriesOf(s).players_total, ctx.win, 'level'), spark: (seriesOf(s).players_total || []).slice(-30).filter(function (x) { return x != null; }) };
      } };
    },
    stickiness: function (ctx) {
      return { key: 'stickiness', stage: 'Retention', label: 'Come back daily', scope: 'now', go: function () { ctx.go('engagement', 'retention'); }, get: function (s) {
        var sk = (s.pirate || {}).stickiness || {};
        return { value: pct(ratio(sk.dau, sk.mau)), sub: int(sk.dau) + ' today of ' + int(sk.mau) + ' this month' };
      } };
    },
  };

  // ── THE PIRATE FUNNEL: every stage a part of the one above it ──
  /* Awareness → Acquisition → Activation → Retention over everyone who has
   * signed up, retention judged over the chosen window. Each stage is a
   * subset of the one before, so every percentage is "of the stage above". */
  function funnelStages(seg, win) {
    var a = allOf(seg), x = winOf(seg, win);
    return [
      { key: 'awareness', stage: 'Awareness', label: 'Unique visitors', value: null, missing: true, what: 'people who found the game' },
      { key: 'acquisition', stage: 'Acquisition', label: 'Signups', value: a.players, what: 'players who signed up' },
      { key: 'activation', stage: 'Activation', label: 'Activated', value: a.activated, what: 'refined alpha and initiated a raid' },
      { key: 'retention', stage: 'Retention', label: 'Active users', value: x.active_activated, what: 'activated, and active ' + ({ 1: 'today', 7: 'this week', 30: 'this month' }[win] || 'in ' + win + 'd') },
    ];
  }
  function funnelGraph(ctx, seg) {
    var rows = funnelStages(seg, ctx.win);
    var top = rows.reduce(function (m, r) { return Math.max(m, r.value || 0); }, 0);
    var g = H.el('div', 'ob-fg');
    rows.forEach(function (r, i) {
      /* Between two stages, the step itself: how many of the one above made it. */
      if (i > 0) {
        var up = rows[i - 1], step = H.el('div', 'ob-fg-step');
        step.setAttribute('data-step', up.key + '>' + r.key);
        step.appendChild(H.el('span', null, ''));
        var mid = H.el('span', 'ob-fg-conv');
        mid.appendChild(H.el('i', H.iconClass('icon-caret-down', 'sui-icon-sm')));
        if (up.missing || r.missing) mid.appendChild(H.el('span', 'ob-sub', 'not measurable until visitors are recorded'));
        else {
          var rate = up.value > 0 ? r.value / up.value : null;
          mid.appendChild(H.el('span', 'ob-fg-rate', pct1(rate)));
          mid.appendChild(H.el('span', 'ob-sub', ' of ' + up.label.toLowerCase() + ' ' + { activation: 'activated', retention: 'are active users' }[r.key]));
        }
        step.appendChild(mid);
        step.appendChild(H.el('span', null, ''));
        g.appendChild(step);
      }
      var row = H.el('div', 'ob-fg-row' + (r.missing ? ' is-missing' : ''));
      row.setAttribute('data-funnel', r.key);
      row.title = DEFS[r.label] || '';
      var name = H.el('div', 'ob-fg-name');
      name.appendChild(H.el('span', 'ob-fg-stage', r.stage));
      name.appendChild(H.el('span', 'ob-fg-label', r.label));
      name.appendChild(H.el('span', 'ob-sub ob-fg-what', r.what));
      row.appendChild(name);
      var track = H.el('div', 'ob-fg-track');
      var bar = H.el('div', 'ob-fg-bar ob-fg-' + r.key);
      bar.style.width = r.missing ? '100%' : Math.max(1, (ratio(r.value, top) || 0) * 100) + '%';
      if (r.missing) bar.appendChild(H.el('span', 'ob-fg-note', 'not recorded yet'));
      track.appendChild(bar);
      row.appendChild(track);
      var num = H.el('div', 'ob-fg-num');
      num.appendChild(H.el('span', 'ob-fg-value', r.missing ? '—' : int(r.value)));
      row.appendChild(num);
      g.appendChild(row);
    });
    return g;
  }
  function funnelBlock(ctx) {
    var segs = ctx.segs;
    var b = block('Pirate funnel', { key: 'funnel', scope: 'Everyone who signed up · active ' + ({ 1: 'today', 7: 'this week', 30: 'this month' }[ctx.win]),
      def: 'Each stage is part of the one above it. Awareness waits on visitor counts, which no guild records yet.' });
    if (segs.length === 1) { b.appendChild(funnelGraph(ctx, segs[0])); return b; }
    var grid1 = H.el('div', 'ob-fg-split');
    segs.forEach(function (s, i) {
      var col = H.el('div', 'ob-fg-col');
      col.appendChild(segLabel(s, i));
      col.appendChild(funnelGraph(ctx, s));
      grid1.appendChild(col);
    });
    b.appendChild(grid1);
    return b;
  }

  // ── OVERVIEW: the funnel, the period's movement, what needs a look ──
  function signalsBlock(ctx) {
    var list = signalsOf(ctx.d);
    if (!list.length) return null;
    var b = block('Signals', { key: 'signals', scope: 'Now' });
    var box = H.el('div', 'ob-signals');
    list.forEach(function (x) {
      var r = H.el('a', 'ob-signal is-' + x.level + (x.data ? ' is-data' : ''));
      r.href = 'javascript:void(0)';
      r.setAttribute('data-signal', x.level);
      r.appendChild(H.el('span', 'ob-src-mark'));
      var what = H.el('span', 'ob-step');
      what.appendChild(H.el('span', 'ob-v ob-signal-title', x.title + (x.segLabel ? ' · ' + x.segLabel : '')));
      if (x.detail) what.appendChild(H.el('span', 'ob-sub ob-signal-detail', x.detail));
      if (x.value) what.appendChild(H.el('span', 'ob-sub ob-signal-inline', x.value));
      r.appendChild(what);
      r.appendChild(H.el('span', 'ob-n ob-sub ob-signal-value', x.value || ''));
      r.appendChild(H.el('i', H.iconClass('icon-chevron-right', 'sui-icon-sm')));
      r.addEventListener('click', function () { if (x.key) OB.open[x.key] = true; ctx.go(x.page, x.view); });
      box.appendChild(r);
    });
    b.appendChild(box);
    return b;
  }
  function aarrrTable(d, seg) {
    var plain = isPlain(d);
    var t = grid('ob-aarrr', [{ label: 'Stage', k: 't', w: 'minmax(10ch, .7fr)', opt: true }, { label: '', k: 't', w: 'minmax(15ch, 1.2fr)' },
      { label: '24 hours', k: 'n', opt: true }, { label: '7 days', k: 'n' }, { label: '30 days', k: 'n' }, { label: 'All time', k: 'n' }, { label: '', k: 's', opt: true }]);
    var last = null;
    AARRR.forEach(function (r) {
      var name = chartLink(r[1], r[3]);
      if (r[5]) name.appendChild(sub(r[5]));
      var cells = [cell(r[0] === last ? '' : r[0], 'ob-stage-name'), name];
      ['1', '7', '30', 'all'].forEach(function (w) { var v = r[2](seg, w); cells.push(stack(int(v[0]), v[0] != null ? v[1] : null)); });
      cells.push(spark(sparkOf(d, seg, r[4], plain), r[1]));
      addRow(t, cells, { cls: r[0] === last ? '' : 'is-stage', data: { aarrr: r[1] } });
      last = r[0];
    });
    return t;
  }
  function aarrrCompare(segs, w) {
    var t = grid('ob-compare ob-aarrr-compare', [{ label: 'Stage', k: 't', w: 'minmax(11ch, .8fr)', opt: true }, { label: '', k: 't', w: 'minmax(18ch, 1.4fr)' }]
      .concat(segs.map(function (s, i) { return { label: segLabel(s, i), k: 'n' }; })));
    var last = null;
    AARRR.forEach(function (r) {
      var cells = [cell(r[0] === last ? '' : r[0], 'ob-stage-name'), cell(r[1], 'ob-step', DEFS[r[1]])];
      segs.forEach(function (s) { var v = r[2](s, w); cells.push(stack(int(v[0]), v[0] != null ? v[1] : null)); });
      addRow(t, cells, { cls: r[0] === last ? '' : 'is-stage', data: { aarrr: r[1] } });
      last = r[0];
    });
    return t;
  }
  function viewOverview(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (!segs.length || !segs[0].pirate) {
      box.appendChild(emptyOr(d, 'No players read yet'));
      var iss = issuesOf(d).filter(function (x) { return x.level === 'issue'; });
      if (iss.length && !reading(d)) box.appendChild(actionBtn(plural(iss.length, 'issue', 'issues') + ' · open Data', function () { ctx.go('data'); }, 'to_data'));
      return box;
    }
    var head = H.el('div', 'ob-kpi-head ob-overview-head');
    head.appendChild(windowStrip(ctx));
    box.appendChild(head);
    box.appendChild(funnelBlock(ctx));
    box.appendChild(kpi(ctx, [K.newPlayers(ctx), K.activated(ctx), K.activeUsers(ctx)], chip('Last ' + WIN_WORD[ctx.win]), WIN_WORD[ctx.win]));
    var two = H.el('div', 'ob-two');
    var sig = signalsBlock(ctx);
    if (sig) two.appendChild(sig);
    var j = block('Journey', { key: 'journey', scope: 'All time', def: 'From opening signup to activating, in three parts that are never divided into each other.' });
    j.appendChild(journeyTable(segs));
    two.appendChild(j);
    box.appendChild(two);
    var st = block('Pirate metrics by window', { key: 'stages', scope: segs.length === 1 ? 'Every window' : WIN_WORD[ctx.win], chart: function () { openChart(['new', 'activations', 'refiners_7d', 'raiders_7d']); } });
    st.appendChild(segs.length === 1 ? aarrrTable(d, segs[0]) : aarrrCompare(segs, ctx.win));
    box.appendChild(st);
    return box;
  }

  /* A section's own figures from Trends: the same rows, filtered to its stage. */
  function trendsBlock(ctx, stages, title) {
    var rows = TRENDS.filter(function (m) { return stages.indexOf(m[4]) >= 0; }).map(function (m) { return [m, trendPoints(ctx.d, m)]; }).filter(function (r) { return r[1].length; });
    if (!rows.length) return null;
    var f = ctx.d.filters || {};
    var ignores = f.compare ? 'not split' : (f.interface || f.activity || f.replicants) ? 'not filtered' : '';
    var b = block(title || 'Daily record', { key: 'trends', noTag: true, scope: 'Humans, ' + (OB.tag || 'every guild') + (ignores ? ' · ' + ignores : ''), def: DEFS['Daily record'], chart: function () { openChart(rows.slice(0, 6).map(function (r) { return r[0][0]; })); },
      extra: [actionBtn('All trends', function () { ctx.go('trends'); }, 'trends')] });
    b.appendChild(trendTable(ctx, rows, false));
    return b;
  }
  /* Latest · 7 days · 30 days: a daily count adds up ("added"), a level changes ("change"). */
  function trendTable(ctx, rows, picking) {
    var picked = ctx.st.picked || [];
    var t = grid('ob-trends', [{ label: 'Figure', k: 't', w: 'minmax(18ch, 1.4fr)' }, { label: '', k: 's', w: 'minmax(10ch, 1fr)', opt: true },
      { label: 'Latest', k: 'n' }, { label: '7 days', k: 'n', def: 'Signed (+/−): the change over the last 7 days. Unsigned: how many were added in them.' }, { label: '30 days', k: 'n', def: 'Signed (+/−): the change over the last 30 days. Unsigned: how many were added in them.' }]);
    var stage = null;
    rows.forEach(function (r) {
      var m = r[0], pts = r[1], daily = m[3] === 'daily';
      if (picking && m[4] !== stage) { stage = m[4]; addRow(t, [cell(stage, 'ob-part')], { cls: 'is-part' }); }
      var on = picked.indexOf(m[0]) >= 0;
      var name = H.el('span', 'ob-c ob-step ob-trend-name');
      if (picking) {
        var box1 = H.checkbox(on, null, function (v) {
          var i = picked.indexOf(m[0]);
          if (v && i < 0) { if (picked.length >= 6) { ctx.redraw(); return; } picked.push(m[0]); }
          if (!v && i >= 0) picked.splice(i, 1);
          ctx.redraw();
        });
        box1.classList.add('ob-pick');
        name.appendChild(box1);
      }
      var a = chartLink(m[1], m[0]);
      a.title = (DEFS[m[1]] ? DEFS[m[1]] + ' ' : '') + 'Since ' + shortDay(pts[0][0]);
      name.appendChild(a);
      addRow(t, [name, spark(pts.slice(-60).map(function (p) { return p[1]; }), m[1]), cell(int(pts[pts.length - 1][1]), null, 'On ' + shortDay(pts[pts.length - 1][0]))]
        .concat([7, 30].map(function (n) { var c = trendChange(pts, n, m[3]); return cell(daily ? int(c) : signed(c), c == null ? 'ob-sub' : '', c == null ? 'The record does not reach back ' + n + ' days yet' : daily ? 'Added in the last ' + n + ' days' : 'Change over the last ' + n + ' days'); })),
        { data: { trend: m[0] }, cls: on ? 'is-picked' : '' });
    });
    return t;
  }

  // ── ACQUISITION: from opening signup to a player ──
  function viewAcquisition(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    var segs = ctx.segs.filter(function (s) { return s.signup; });
    if (!segs.length) {
      var f = d.filters || {};
      if (f.activity || f.compare === 'activity') {
        box.appendChild(H.stateBlock('empty', 'Activity is only known once signup finishes'));
        box.appendChild(actionBtn('Clear the activity filter', function () { ctx.set(f.activity ? { activity: '' } : { compare: '' }); }, 'clear_activity'));
      }
      else if (f.compare === 'tutorial') box.appendChild(H.stateBlock('empty', 'The tutorial comes after signup'));
      else box.appendChild(emptyOr(d, 'No signups recorded'));
      return box;
    }
    var sctx = Object.assign({}, ctx, { segs: segs });
    box.appendChild(kpi(sctx, [K.opens(ctx), K.finished(ctx), K.newPlayers(ctx),
      { key: 'dropoff', label: 'Never finished', cls: 'bad', scope: 'all time', def: 'Signup sessions that stopped before the end.', get: function (s) { var h = headline(s); return { value: int(h.started - h.signed), sub: share(h.started - h.signed, h.started) + ' of ' + int(h.started) + ' opens' }; } },
      { key: 'signup_time', label: 'Signup takes', scope: 'all time', def: DEFS.Median, get: function (s) { var x = (s.durations || {}).signup; return { value: durWords(x && x.p50), sub: x ? 'typical · one in ten over ' + durWords(x.p90) : null }; } },
    ], windowStrip(ctx), WIN_WORD[ctx.win]));
    var b = block('Signup funnel', { key: 'funnel', scope: 'All time', scopeDef: 'The guild servers keep no date range for their funnels.', chart: function () { openChart(['signups_started', 'signed_up']); } });
    b.appendChild(segs.length === 1 ? funnelSingle(ctx, segs[0], segs[0].signup.steps || [], false) : funnelCompare(segs, function (s) { return s.signup.steps; }));
    box.appendChild(b);
    var tb = trendsBlock(ctx, ['Acquisition']);
    if (tb) box.appendChild(tb);
    return box;
  }

  // ── ONBOARDING: Combat Training ──
  function onboardingKpi(ctx) {
    var d = ctx.d;
    function wk(key) { return deltaOf(increments(histSeries(d, key) || ((d.history || []).map(function (r) { return r.server ? r.server[key] : null; }))), 7, 'daily'); }
    return [
      { key: 'players', label: 'Tutorial players', get: function (s) { var t = tutorialOf(s); return { value: int(t.offered), sub: t.unique ? 'unique players' : 'new signups sampled', delta: wk('tutorial_players') }; } },
      { key: 'takeup', label: 'Take-up', get: function (s) { var h = headline(s); return { value: h.takeUpBase >= SMALL_N ? pct(h.takeUp) : share(h.takeUpN, h.takeUpBase), sub: h.takeUpBase ? int(h.takeUpN) + ' of ' + int(h.takeUpBase) + ' new players started' : null }; } },
      { key: 'finished', label: 'Finished', cls: 'ok', get: function (s) { var t = tutorialOf(s); return { value: int(t.completed), sub: share(t.completed, t.offered) + ' of tutorial players', delta: wk('tutorial_completed') }; } },
      { key: 'skipped', label: 'Skipped', get: function (s) { var t = tutorialOf(s); return { value: int(t.declined), sub: share(t.declined, t.offered) + ' of tutorial players' }; } },
      { key: 'quit', label: 'Quit', cls: 'bad', get: function (s) { var t = tutorialOf(s); return { value: int(t.left), sub: share(t.left, t.offered) + ' of tutorial players' }; } },
      { key: 'time', label: 'Tutorial takes', def: DEFS.Median, get: function (s) { var x = (s.durations || {}).tutorial; return { value: durWords(x && x.p50), sub: x ? 'typical · one in ten over ' + durWords(x.p90) : null }; } },
    ];
  }
  function runsKpi() {
    function r(s) { return s.runs || {}; }
    return [
      { key: 'run_players', label: 'Players', get: function (s) { return { value: int(r(s).players), sub: int(r(s).existing) + ' had played before' }; } },
      { key: 'runs', label: 'Runs', def: DEFS.Run, get: function (s) { return { value: int(r(s).runs), sub: int(r(s).repeat) + ' repeat · ' + int(r(s).replays) + ' replays' }; } },
      { key: 'run_finished', label: 'Finished', cls: 'ok', get: function (s) { return { value: int(r(s).completed), sub: share(r(s).completed, r(s).runs) + ' of runs' }; } },
      { key: 'run_quit', label: 'Quit', get: function (s) { return { value: int(r(s).left), sub: share(r(s).left, r(s).runs) + ' of runs' }; } },
      { key: 'no_player', label: 'No player', def: DEFS['No player'], get: function (s) { return { value: int(r(s).no_player), cls: r(s).no_player > 0 ? 'bad' : null, sub: 'launch message lost' }; } },
    ];
  }
  function outcomeStrip(t) {
    t = t || {};
    var total = Number(t.offered) || 0;
    var wrap = H.el('div', 'ob-outcome');
    var strip = H.el('div', 'ob-stack'), legend = H.el('div', 'ob-legend');
    OUTCOMES.forEach(function (k) {
      var n = Number(t[k[0]]) || 0;
      var seg = H.el('span', 'ob-seg ob-seg-' + k[0]);
      seg.style.flexGrow = String(n);
      seg.title = k[1] + ' ' + int(n) + ' · ' + share(n, total);
      if (n > 0) strip.appendChild(seg);
      var l = H.el('span', 'ob-key');
      l.setAttribute('data-outcome', k[0]);
      l.appendChild(H.el('span', 'ob-swatch ob-seg-' + k[0]));
      l.appendChild(H.el('span', null, k[1]));
      l.appendChild(H.el('span', 'ob-v', int(n) + (total >= SMALL_N ? ' · ' + pct(ratio(n, total)) : '')));
      legend.appendChild(l);
    });
    wrap.appendChild(strip);
    wrap.appendChild(legend);
    return wrap;
  }
  function phaseWho(d, phase) {
    var out = { total: 0, players: [] };
    Object.keys((d && d.stopped) || {}).forEach(function (k) {
      if (phaseOf(k) !== phase) return;
      out.total += d.stopped[k].total || 0;
      out.players = out.players.concat(d.stopped[k].players || []);
    });
    return out.players.length ? out : null;
  }
  /* A phase opens into its own steps, each of which opens its players. */
  function phaseStepsPanel(ctx, seg, ph) {
    var steps = ((seg.tutorial && seg.tutorial.steps) || []).filter(function (r) { return ph.steps.indexOf(r.key) >= 0; });
    var box = H.el('div', 'ob-subtable');
    if (!steps.length) { box.appendChild(sub('No steps recorded')); return box; }
    box.appendChild(funnelSingle(ctx, seg, steps.map(function (r) { return Object.assign({}, r, { previous: r.previous || 'x', next: r.next || 'x' }); }), true));
    return box;
  }
  /* The funnel by phase: green went on, red stopped, blue skipped. */
  function phaseFunnel(ctx, seg, rows) {
    var top = rows.reduce(function (m, r) { return Math.max(m, r.reached); }, 0);
    var stopTop = worstRates(rows.slice(0, -1).map(function (r) { return { key: String(r.phase), reached: r.reached, stopped: r.stopped }; }), function (r) { return r.reached; }, function (r) { return r.stopped; }, FLAG_TOP);
    var t = grid('ob-phases', [{ label: 'Phase', k: 't', w: 'minmax(14ch, 1fr)' }, { label: '', k: 'b', w: 'minmax(12ch, 2.4fr)', opt: true },
      { label: 'Reached', k: 'n' }, { label: 'Kept', k: 'n', opt: true }, { label: 'Stopped', k: 'n', opt: true }, { label: 'Stop rate', k: 'n' }, { label: 'Skipped', k: 'n' }, { label: 'Time', k: 'n', opt: true, def: 'Typical time in the phase.' }]);
    rows.forEach(function (r, i) {
      var last = i === rows.length - 1, flag = stopTop.indexOf(String(r.phase)) >= 0;
      var rate = last ? null : ratio(r.stopped, r.reached);
      var row = addRow(t, [cell(r.label, 'ob-step'), bars([['ob-keep', ratio(r.left, top)], ['ob-stop', ratio(r.stopped, top)], ['ob-skip', ratio(r.skipped, top)]]),
        cell(int(r.reached), 'ob-v'), pct(ratio(r.reached, top)), cell(last ? '—' : int(r.stopped), flag ? 'is-bad' : ''), cell(pct1(rate), flag ? 'is-bad' : ''),
        cell(r.skipped ? int(r.skipped) : '—', r.skipped ? 'is-skip' : ''), cell(r.time == null ? '—' : dur(r.time), 'ob-sub')], { data: { phase: r.label } });
      if (r.phase > 0) drill(t, row, 'phase:' + r.phase, function () { return phaseStepsPanel(ctx, seg, r); });
    });
    return t;
  }
  function viewPhases(ctx) {
    var segs = ctx.segs, box = H.el('div', 'ob-view');
    if (segs.length > 1) {
      var pc = block('Phases · sample of new signups', { key: 'phases', scope: 'All time', def: DEFS.Sample });
      pc.appendChild(funnelCompare(segs, phaseSteps, 'Phase'));
      box.appendChild(pc);
      return box;
    }
    var s = segs[0], phases = phaseRows(s), tt0 = tutorialOf(s);
    var ob = block('Outcomes · ' + int(tt0.offered) + (tt0.unique ? ' unique players' : ' players'), { key: 'outcomes', scope: 'All time', copy: false });
    ob.appendChild(outcomeStrip(tt0));
    box.appendChild(ob);
    if (phases.length) {
      var pb = block('Phases · sample of ' + int(phases[0].reached) + ' new signups', { key: 'phases', scope: 'All time', def: DEFS.Sample });
      pb.appendChild(phaseFunnel(ctx, s, phases));
      box.appendChild(pb);
    }
    return box;
  }
  /* How far unique players got: the servers' count, replays and logged-in runs in. */
  function playerFunnel(ctx, rows) {
    var d = ctx.d;
    var stopTop = worstRates(rows.slice(0, -1), function (r) { return r.reached; }, function (r) { return r.furthest; }, FLAG_TOP);
    var t = grid('ob-steps', [{ label: 'Step', k: 't', w: 'minmax(18ch, 1.6fr)' }, { label: '', k: 'b', opt: true }, { label: 'Reached', k: 'n' }, { label: 'Kept', k: 'n', opt: true },
      { label: 'Stopped', k: 'n', opt: true }, { label: 'Stop rate', k: 'n' }]);
    rows.forEach(function (r, i) {
      var last = i === rows.length - 1, flag = stopTop.indexOf(r.key) >= 0;
      var row = addRow(t, [cell(stepLabel(r.key), 'ob-step', r.key), bar(r.retained), int(r.reached), rows[0].reached >= SMALL_N ? pct(r.retained) : '—',
        cell(last ? '—' : int(r.furthest), flag ? 'is-bad' : ''), cell(last ? '—' : pct1(ratio(r.furthest, r.reached)), flag ? 'is-bad' : '')], { data: { step: r.key } });
      var who = d.stopped && d.stopped[r.key];
      if (who) drill(t, row, r.key, function () { return whoList(ctx, who, r.key); });
    });
    return t;
  }
  function viewSteps(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (segs.length > 1) {
      var c = block('Steps · sample of new signups', { key: 'steps', scope: 'All time', def: DEFS.Sample });
      c.appendChild(funnelCompare(segs, function (x) { return x.tutorial && x.tutorial.steps; }));
      box.appendChild(c);
      return box;
    }
    var s = segs[0], steps = s.player_steps || [];
    var by = steps.length && ctx.st.count !== 'sample' ? 'unique' : 'sample';
    var pick = H.navStrip([{ key: 'unique', label: 'Unique players' }, { key: 'sample', label: 'New signups' }], by, function (k) { ctx.st.count = k; ctx.redraw(); });
    pick.classList.add('ob-count');
    if (by === 'unique') {
      var up = block('Steps · ' + int(steps[0].reached) + ' unique players', { key: 'steps', scope: 'All time', extra: [pick], def: DEFS['Tutorial players'] });
      up.appendChild(playerFunnel(ctx, steps));
      box.appendChild(up);
    } else if (s.tutorial && s.tutorial.offered) {
      var sample = block('Steps · sample of ' + int(s.tutorial.offered) + ' new signups', { key: 'steps', scope: 'All time', extra: steps.length ? [pick] : [], def: DEFS.Sample });
      sample.appendChild(funnelSingle(ctx, s, s.tutorial.steps || [], true));
      box.appendChild(sample);
    } else box.appendChild(emptyOr(d, 'No tutorial steps yet'));
    return box;
  }
  /* First runs beside later ones: does coming back help? */
  function runCompare(segs) {
    var t = grid('ob-run-compare', [{ label: 'Run', k: 't', w: 'minmax(14ch, 1.2fr)' }, { label: 'Runs', k: 'n' }, { label: 'Finished', k: 'n' }, { label: 'Steps', k: 'n', opt: true, def: 'Typical steps reached.' },
      { label: 'Time to finish', k: 'n' }, { label: 'Since last run', k: 'n', opt: true }, { label: 'Quit', k: 'n', opt: true }]);
    segs.forEach(function (s) {
      (s.run_comparison || []).forEach(function (x) {
        addRow(t, [cell((segs.length > 1 ? segName(s) + ' · ' : '') + (x.run === '1' ? 'First run' : 'Run ' + x.run), 'ob-step'), int(x.runs), share(x.completed, x.runs), x.steps ? int(x.steps.p50) : '—',
          x.time ? dur(x.time.p50) : '—', x.since_previous ? dur(x.since_previous.p50) : '—', int(x.left)], { data: { run: x.run } });
      });
    });
    return t;
  }
  function runTable(d, rows, st, redraw) {
    var tags = guildTags(d);
    st.runSort = st.runSort || { key: 'started', dir: -1 };
    var acc = { player: function (x) { return (x.name || x.player_id || '').toLowerCase(); }, guild: function (x) { return tags[x.guild_id] || x.guild_id || ''; },
      started: function (x) { return x.started_ms || 0; }, run: function (x) { return x.run_number || 0; }, outcome: function (x) { return x.outcome || ''; }, time: function (x) { return x.seconds || 0; } };
    var t = grid('ob-runs', [{ label: 'Player', k: 't', w: 'minmax(15ch, 1.2fr)', sort: 'player' }, { label: 'Guild', k: 't', w: 'minmax(6ch, .4fr)', opt: true, sort: 'guild' },
      { label: 'App', k: 't', w: 'minmax(11ch, .7fr)', opt: true }, { label: 'Started', k: 'n', sort: 'started' }, { label: 'Run', k: 'n', w: 'minmax(4ch, .3fr)', opt: true, sort: 'run' },
      { label: 'Kind', k: 't', w: 'minmax(8ch, .5fr)', opt: true }, { label: 'Outcome', k: 't', w: 'minmax(8ch, .5fr)', sort: 'outcome' }, { label: 'Got to', k: 't', w: 'minmax(15ch, 1.3fr)', opt: true },
      { label: 'Time', k: 'n', opt: true, sort: 'time' }], st.runSort, redraw);
    H.sortBy(rows, st.runSort, acc).forEach(function (x) {
      addRow(t, [x.player_id ? playerLink(x) : cell('No player', 'ob-step is-bad', x.session_id), cell(tags[x.guild_id] || x.guild_id), cell(ifaceName(x.interface) || '—', 'ob-sub'),
        x.started_ms ? H.ago(x.started_ms) : '—', int(x.run_number), cell(runKind(x), 'ob-sub'), badge(x.outcome), cell(x.furthest ? stepLabel(x.furthest) : '—', 'ob-step ob-sub', x.furthest), dur(x.seconds)],
        { data: { session: x.session_id } });
    });
    return t;
  }
  /* This week's runs against last week's, from the run list itself — only
   * when the list reaches back past both weeks, or the older week is short. */
  function runWeeks(rows, now, total) {
    now = now || Date.now();
    var wk = 7 * 86400000, oldest = rows.reduce(function (m, x) { return Math.min(m, x.started_ms || now); }, now);
    /* Complete if the list reaches back past both weeks, or holds every run there is. */
    if (oldest > now - 2 * wk && !(total != null && rows.length >= total)) return null;
    return [['This week', now - wk, now], ['Last week', now - 2 * wk, now - wk]].map(function (w) {
      var mine = rows.filter(function (x) { return x.started_ms > w[1] && x.started_ms <= w[2]; });
      var c = function (o) { return mine.filter(function (x) { return x.outcome === o; }).length; };
      return { label: w[0], runs: mine.length, completed: c('completed'), left: c('left'), playing: c('playing'), no_player: mine.filter(function (x) { return !x.player_id; }).length };
    });
  }
  function viewRuns(ctx) {
    var d = ctx.d, segs = ctx.segs, rows = d.runs || [], box = H.el('div', 'ob-view');
    if (!rows.length) { box.appendChild(H.stateBlock('empty', 'No tutorial runs yet')); return box; }
    box.appendChild(kpi(ctx, runsKpi(), H.el('span', 'ob-chip', 'All time'), 'all time'));
    var split = segs.length > 1 ? ' · not split' : '';
    var weeks = runWeeks(rows, null, sum(segs, function (x) { return (x.runs || {}).runs; }));
    if (weeks) {
      var wb = block('This week against last week', { key: 'run_weeks', scope: 'Last 14 days' + split });
      var wt = grid('ob-run-weeks', [{ label: '', k: 't', w: 'minmax(12ch, 1fr)' }, { label: 'Runs', k: 'n' }, { label: 'Finished', k: 'n' }, { label: 'Quit', k: 'n' }, { label: 'Playing', k: 'n', opt: true }, { label: 'No player', k: 'n', opt: true }]);
      weeks.forEach(function (x) { addRow(wt, [cell(x.label, 'ob-step'), int(x.runs), stack(int(x.completed), ofShare(x.completed, x.runs)), stack(int(x.left), ofShare(x.left, x.runs)), int(x.playing), int(x.no_player)], { data: { week: x.label } }); });
      wb.appendChild(wt);
      box.appendChild(wb);
    }
    var bc = block('First run against later runs', { key: 'by_run', scope: 'All time' });
    bc.appendChild(runCompare(segs));
    box.appendChild(bc);
    var lb = block('Newest runs', { key: 'runs', scope: 'Newest ' + int(rows.length) + split, extra: [actionBtn('All in Players', function () { ctx.go('players', 'runs'); }, 'players')] });
    lb.appendChild(runTable(d, rows.slice(0, 12), ctx.st, ctx.redraw));
    box.appendChild(lb);
    return box;
  }
  function viewTiming(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    var b = block('How long each part takes', { key: 'durations', scope: 'All time' });
    var cols = [{ label: '', k: 't', w: 'minmax(14ch, 1.2fr)' }];
    if (segs.length === 1) cols = cols.concat([{ label: 'Median', k: 'n' }, { label: 'p90', k: 'n' }, { label: 'Players', k: 'n' }]);
    else segs.forEach(function (s, i) { cols.push({ label: segLabel(s, i), k: 'n' }); });
    var t = grid('ob-durations', cols);
    DURATIONS.forEach(function (k) {
      var cells = [cell(k[1], 'ob-step')];
      if (segs.length === 1) { var x = segs[0].durations && segs[0].durations[k[0]]; cells = cells.concat(x ? [dur(x.p50), dur(x.p90), int(x.n)] : ['—', '—', '—']); }
      else segs.forEach(function (s) { var y = s.durations && s.durations[k[0]]; cells.push(stack(y ? dur(y.p50) : '—', y ? 'p90 ' + dur(y.p90) : null)); });
      addRow(t, cells, { data: { metric: k[0] } });
    });
    b.appendChild(t);
    box.appendChild(b);
    var dwell = (segs[0] && segs[0].dwell) || {};
    var keys = Object.keys(dwell).filter(function (k) { return dwell[k] && dwell[k].n >= 3; }).sort(function (a, b2) { return dwell[b2].p50 - dwell[a].p50; }).slice(0, 15);
    if (!keys.length) { box.appendChild(emptyOr(d, 'No step timings yet')); return box; }
    var max = dwell[keys[0]].p90 || dwell[keys[0]].p50 || 1;
    var sb = block('Slowest steps', { key: 'slowest', scope: 'All time' });
    var first = segs.length > 1 ? segName(segs[0]) + ' · ' : '';
    if (segs.length > 1) sb.querySelector('.ob-title').textContent = 'Slowest steps · ranked by ' + segName(segs[0]);
    var scols = [{ label: 'Step', k: 't', w: 'minmax(20ch, 1.6fr)' }, { label: '', k: 'b', opt: true }, { label: first + 'Median', k: 'n', def: DEFS.Median }, { label: first + 'p90', k: 'n', def: DEFS.p90 }, { label: 'Players', k: 'n', opt: true }]
      .concat(segs.slice(1).map(function (x, i) { return { label: segLabel(x, i + 1, segName(x) + ' · Median'), k: 'n' }; }));
    var s = grid('ob-slow', scols);
    keys.forEach(function (k) {
      var w = dwell[k];
      addRow(s, [cell((k.indexOf('signup.') === 0 ? 'Signup · ' : '') + stepLabel(k), 'ob-step', k), bar(w.p50 / max, 'is-time'), dur(w.p50), dur(w.p90), int(w.n)]
        .concat(segs.slice(1).map(function (x) { var o = x.dwell && x.dwell[k]; return o ? dur(o.p50) : '—'; })), { data: { step: k }, cls: w.n < SMALL_N ? 'is-quiet' : '' });
    });
    sb.appendChild(s);
    box.appendChild(sb);
    return box;
  }
  /* Players since telemetry began, by what they did with Combat Training.
   * A group chose its outcome, so this describes, it does not prove cause. */
  var IMPACT = [['acted', 'Acted'], ['refined', 'Refined'], ['raided', 'Initiated a raid'], ['activated', 'Activated'], ['active_7d', 'Active this week'], ['active_30d', 'Active this month']];
  function viewImpact(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    var rows = (d.tutorial_impact || []).filter(function (r) { return r.players > 0 || r.key === 'all'; });
    if (!rows.length) { box.appendChild(emptyOr(d, 'No players since telemetry began')); return box; }
    var split = ctx.segs.length > 1;
    var b = block('Players by tutorial outcome', { key: 'impact', scope: split ? 'Not split · since telemetry began' : 'Since telemetry began', def: 'Players since telemetry began, grouped by what they did with Combat Training. Groups chose their outcome: compare, do not infer cause.' });
    var t = grid('ob-impact', [{ label: '', k: 't', w: 'minmax(12ch, 1fr)' }, { label: 'Players', k: 'n' }].concat(IMPACT.map(function (m) { return { label: m[1], k: 'n', opt: m[0] !== 'activated' }; }))
      .concat([{ label: 'Days to activate', k: 'n', def: 'Typical (median) days from signup to activation.' }]));
    var best = rows.filter(function (r) { return r.key !== 'all' && r.players >= BEST_N; })
      .reduce(function (m, r) { return !m || r.activated / r.players > m.activated / m.players ? r : m; }, null);
    rows.forEach(function (r) {
      addRow(t, [cell(r.label, 'ob-step'), cell(int(r.players), 'ob-v')].concat(IMPACT.map(function (m) {
        return stack(int(r[m[0]]), ofShare(r[m[0]], r.players), m[0] === 'activated' && best && r.key === best.key ? 'is-best' : '');
      })).concat([r.activate_days_p50 == null ? '—' : (Math.round(r.activate_days_p50 * 10) / 10) + ' d']), { cls: (r.key === 'all' ? 'is-total' : '') + (r.players < SMALL_N && r.key !== 'all' ? ' is-small' : ''), data: { group: r.key } });
    });
    b.appendChild(t);
    box.appendChild(b);
    return box;
  }
  var ONBOARDING = { phases: viewPhases, steps: viewSteps, runs: viewRuns, timing: viewTiming, impact: viewImpact };
  function viewOnboarding(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    box.appendChild(viewStrip(ctx));
    var t = tutorialOf(ctx.segs[0]);
    if (ctx.view !== 'runs' && ctx.view !== 'impact' && !t.offered && ctx.segs.length === 1) { box.appendChild(emptyOr(d, 'No tutorial sessions yet')); return box; }
    if (ctx.view !== 'runs') box.appendChild(kpi(ctx, onboardingKpi(ctx), H.el('span', 'ob-chip', ctx.view === 'impact' ? 'Since telemetry began' : 'All time'), 'all time'));
    box.appendChild(ONBOARDING[ctx.view](ctx));
    if (ctx.view === 'phases' || ctx.view === 'steps') { var tb = trendsBlock(ctx, ['Onboarding']); if (tb) box.appendChild(tb); }
    return box;
  }

  // ── ENGAGEMENT: activation and retention ──
  function engagementKpi(ctx) {
    return [K.active(ctx), K.stickiness(ctx), K.activated(ctx),
      { key: 'activated_ever', label: 'Activated ever', scope: 'all time', def: DEFS.Activated, get: function (s) { var a = allOf(s); return { value: int(a.activated), sub: share(a.activated, a.players) + ' of ' + int(a.players) + ' players', spark: sparkOf(ctx.d, s, 'p:activated_total') }; } },
      { key: 'tta', label: 'Time to activate', scope: 'all time', get: function (s) { var p = s.pirate || {}; return { cls: p.time_to_activate && p.time_to_activate.n < SMALL_N ? 'is-off' : null, value: durWords(p.time_to_activate && p.time_to_activate.p50), sub: p.time_to_activate ? 'typical, of ' + int(p.time_to_activate.n) + ' timed' + (p.untimed ? ' · ' + int(p.untimed) + ' not dated yet' : '') : 'none timed yet' }; } },
      { key: 'never', label: 'Never acted', cls: 'bad', scope: 'all time', get: function (s) { return { value: int(s.never_acted), sub: share(s.never_acted, s.players) + ' of ' + int(s.players) + ' players' }; } },
    ];
  }
  function lifecycleBlock(segs) {
    var b = block('Last seen', { key: 'lifecycle', scope: 'Now', def: DEFS['Last seen'] });
    var keys = [['today', 'Today'], ['week', 'Earlier this week'], ['month', 'Earlier this month'], ['gone', '30+ days ago'], ['never', 'Never acted']];
    segs.forEach(function (s, si) {
      var lc = s.lifecycle || {}, wrap = H.el('div', 'ob-outcome');
      wrap.setAttribute('data-seg', s.key);
      if (segs.length > 1) wrap.appendChild(segLabel(s, si));
      var strip = H.el('div', 'ob-stack'), legend = H.el('div', 'ob-legend');
      var total = keys.reduce(function (a, k) { return a + (Number(lc[k[0]]) || 0); }, 0);
      keys.forEach(function (k) {
        var n = Number(lc[k[0]]) || 0;
        var seg = H.el('span', 'ob-seg ob-life-' + k[0]);
        seg.style.flexGrow = String(n);
        seg.title = k[1] + ' ' + int(n) + ' · ' + share(n, total);
        if (n > 0) strip.appendChild(seg);
        var l = H.el('span', 'ob-key');
        l.setAttribute('data-life', k[0]);
        l.appendChild(H.el('span', 'ob-swatch ob-life-' + k[0]));
        l.appendChild(H.el('span', null, k[1]));
        l.appendChild(H.el('span', 'ob-v', int(n) + (total >= SMALL_N ? ' · ' + pct(n / total) : '')));
        legend.appendChild(l);
      });
      wrap.appendChild(strip);
      wrap.appendChild(legend);
      b.appendChild(wrap);
    });
    return b;
  }
  /* The path in the game, counted against everyone who signed up. */
  function activationTable(d, segs) {
    function of(s, key) {
      var a = (s.activation || []).filter(function (x) { return x.key === key; })[0];
      if (!a && key === 'activated') { var all = allOf(s); return { n: all.activated, rate: ratio(all.activated, s.players) }; }
      return a || {};
    }
    var label = function (m) { return m[0] === 'active' ? activeName(d.active_days) : m[1]; };
    if (segs.length === 1) {
      var t = grid('ob-activation', [{ label: 'Milestone', k: 't', w: 'minmax(16ch, 1.2fr)' }, { label: '', k: 'b', w: 'minmax(10ch, 2fr)', opt: true }, { label: 'Reached', k: 'n' }, { label: 'Kept', k: 'n', def: 'Share of everyone who signed up.' }]);
      MILESTONES.forEach(function (m) {
        var a = of(segs[0], m[0]);
        addRow(t, [cell((m[2] === 'side' ? '↳ ' : m[2] === 'now' ? '· ' : '') + label(m), 'ob-step', DEFS[m[1]]), bar(a.rate != null ? a.rate : ratio(a.n, segs[0].players), m[2] === 'step' ? '' : 'is-aside'), int(a.n), share(a.n, segs[0].players)],
          { data: { milestone: m[0] }, cls: m[2] === 'step' ? '' : 'is-aside' });
      });
      return t;
    }
    var c = grid('ob-compare ob-activation', [{ label: 'Milestone', k: 't', w: 'minmax(16ch, 1.4fr)' }].concat(segs.map(function (s, i) { return { label: segLabel(s, i), k: 'n' }; })));
    MILESTONES.forEach(function (m) {
      addRow(c, [cell((m[2] === 'side' ? '↳ ' : m[2] === 'now' ? '· ' : '') + label(m), 'ob-step')].concat(segs.map(function (s) { var a = of(s, m[0]); return stack(int(a.n), ofShare(a.n, s.players)); })),
        { data: { milestone: m[0] }, cls: m[2] === 'step' ? '' : 'is-aside' });
    });
    return c;
  }
  function viewActivation(ctx) {
    var box = H.el('div', 'ob-view');
    var b = block('Milestones', { key: 'milestones', scope: 'All time', chart: function () { openChart(['activated_total', 'refiners_7d', 'raiders_7d', 'miners_7d']); } });
    b.appendChild(activationTable(ctx.d, ctx.segs));
    box.appendChild(b);
    return box;
  }
  /* Below SMALL_N a cell is a count, drawn quieter: a percentage claims more than it can carry. */
  function heatCell(n, total) {
    if (n == null) return H.el('span', 'ob-heat ob-heat-none');
    var rate = ratio(n, total), small = total < SMALL_N;
    var c = H.el('span', 'ob-heat ' + (small ? 'ob-heat-count' : 'ob-heat-' + heatBand(rate)), small ? int(n) : Math.round(rate * 100) + '%');
    c.title = int(n) + ' of ' + int(total);
    return c;
  }
  function cohortGrid(rows) {
    var weeks = 8;
    var t = H.el('div', 'ob-cohorts');
    var head = H.el('div', 'ob-cohort ob-cohort-head');
    ['Week of', 'Joined', 'Acted'].concat(Array.from({ length: weeks }, function (_, i) { return (i + 1) + ' wk'; })).forEach(function (c) { head.appendChild(H.el('span', null, c)); });
    t.appendChild(head);
    rows.forEach(function (c) {
      var row = H.el('div', 'ob-cohort');
      row.setAttribute('data-week', c.year + '-' + c.week);
      row.appendChild(H.el('span', null, weekStart(c.year, c.week)));
      row.appendChild(H.el('span', 'ob-v ob-n', int(c.n)));
      row.appendChild(heatCell(c.acted, c.n));
      for (var i = 0; i < weeks; i++) row.appendChild(heatCell((c.alive || [])[i], c.n));
      t.appendChild(row);
    });
    return t;
  }
  /* The last cohorts big enough to read, by how many outlasted their first week. */
  function weekOne(s) {
    var rows = (s.cohorts || []).filter(function (c) { return c.n >= 10 && c.alive && c.alive.length; }).slice(-7);
    if (!rows.length) return null;
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
      col.appendChild(H.el('span', null, weekStart(c.year, c.week)));
      col.appendChild(sub(int(c.n) + ' joined'));
      g.appendChild(col);
    });
    return g;
  }
  function distBlock(title, segs, pick, kind) {
    var b = block(title, { key: 'dist', scope: 'All time' });
    var ds = segs.map(pick);
    var t = grid('ob-dist', [{ label: '', k: 't', w: 'minmax(12ch, 1.2fr)' }, { label: 'Players', k: 'n' }, { label: 'None', k: 'n', opt: true, def: 'Share with none at all.' }, { label: 'Mean', k: 'n', opt: true },
      { label: 'Median', k: 'n' }, { label: 'p75', k: 'n', opt: true, def: 'Three in four are at or below this.' }, { label: 'p90', k: 'n', opt: true }, { label: 'Max', k: 'n' }]);
    segs.forEach(function (s, i) {
      var x = ds[i] || {};
      addRow(t, [segs.length > 1 ? segLabel(s, i) : cell('Everyone', 'ob-step'), int(x.n), x.n ? pct(x.zero / x.n) : '—'].concat(['mean', 'p50', 'p75', 'p90', 'max'].map(function (k) { return x.n ? fmtKind(kind, x[k]) : '—'; })), { data: { seg: s.key } });
    });
    b.appendChild(t);
    var hist = (ds[0] && ds[0].hist) || [];
    var lastFull = -1;
    var maxV = ds.reduce(function (m, x) { return Math.max(m, (x && x.max) || 0); }, 0);
    hist.forEach(function (bk, i) { if (bk.lo <= maxV && ds.some(function (x) { return x && x.hist && x.hist[i] && x.hist[i].n > 0; })) lastFull = i; });
    hist = hist.slice(0, lastFull + 1);
    if (!hist.length) return b;
    if (segs.length === 1) {
      var h = grid('ob-hist', [{ label: 'Range', k: 't', w: 'minmax(12ch, 1.2fr)' }, { label: '', k: 'b', w: 'minmax(10ch, 2fr)' }, { label: 'Players', k: 'n' }, { label: 'Share', k: 'n' }]);
      var top = Math.max.apply(null, hist.map(function (x) { return x.n; }).concat([1]));
      hist.forEach(function (bk) { addRow(h, [cell(bucketLabel(bk, kind), 'ob-step'), bar(bk.n / top), int(bk.n), pct(ratio(bk.n, ds[0].n))]); });
      b.appendChild(h);
    } else {
      var c = grid('ob-compare', [{ label: 'Range', k: 't', w: 'minmax(12ch, 1.2fr)' }].concat(segs.map(function (s, i) { return { label: segLabel(s, i), k: 'n' }; })));
      hist.forEach(function (bk, i) { addRow(c, [cell(bucketLabel(bk, kind), 'ob-step')].concat(ds.map(function (x) { var n = x && x.hist && x.hist[i] ? x.hist[i].n : 0; return pct(ratio(n, x && x.n)); }))); });
      b.appendChild(c);
    }
    return b;
  }
  function viewRetention(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (segs.length === 1) {
      var w1 = weekOne(segs[0]);
      if (w1) { var wb = block('Still acting after one week', { key: 'week_one', scope: 'By week joined' }); wb.appendChild(w1); box.appendChild(wb); }
    }
    segs.forEach(function (s, i) {
      if (!(s.cohorts || []).length) return;
      var c = block('Still acting, by week joined', { key: 'cohorts', def: DEFS.Cohort, scope: 'By week joined', extra: segs.length > 1 ? [segLabel(s, i)] : [] });
      c.appendChild(cohortGrid(s.cohorts));
      box.appendChild(c);
    });
    var cb = block('Churn', { key: 'churn', scope: 'Now' });
    var t = grid('ob-compare', [{ label: '', k: 't', w: 'minmax(16ch, 1.4fr)' }].concat(segs.map(function (s, i) { return { label: segs.length > 1 ? segLabel(s, i) : 'Everyone', k: 'n' }; })));
    [['Players', function (s) { return int(s.players); }],
     [activeName(d.active_days), function (s) { return stack(int(s.active), ofShare(s.active, s.players)); }],
     ['Inactive', function (s) { return stack(int(s.inactive), ofShare(s.inactive, s.players)); }],
     ['Never acted', function (s) { return stack(int(s.never_acted), ofShare(s.never_acted, s.players)); }],
     ['Churn', function (s) { return stack(int(s.churned), ofShare(s.churned, s.churn_base) + ' of ' + int(s.churn_base) + ' who acted'); }]].forEach(function (m) {
      addRow(t, [cell(m[0], 'ob-step', DEFS[m[0]])].concat(segs.map(m[1])), { data: { metric: m[0] } });
    });
    cb.appendChild(t);
    box.appendChild(cb);
    box.appendChild(distBlock('Play length of inactive players after signup', segs, function (s) { return s.play_length; }, 'secs'));
    return box;
  }
  function viewDistributions(ctx) {
    var box = H.el('div', 'ob-view');
    STATS.forEach(function (st) { box.appendChild(distBlock(st[1], ctx.segs, function (s) { return s.stats && s.stats[st[0]]; }, st[2])); });
    return box;
  }
  var ENGAGEMENT = { activation: viewActivation, retention: viewRetention, distributions: viewDistributions };
  function viewEngagement(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    box.appendChild(viewStrip(ctx));
    if (!ctx.segs.length || !ctx.segs[0].pirate) { box.appendChild(emptyOr(d, 'No players read yet')); return box; }
    box.appendChild(kpi(ctx, engagementKpi(ctx), windowStrip(ctx), WIN_WORD[ctx.win]));
    box.appendChild(lifecycleBlock(ctx.segs));
    box.appendChild(ENGAGEMENT[ctx.view](ctx));
    if (ctx.view !== 'distributions') { var tb = trendsBlock(ctx, ctx.view === 'activation' ? ['Activation'] : ['Retention']); if (tb) box.appendChild(tb); }
    return box;
  }

  // ── PLAYERS: who exactly ──
  function badge(outcome) {
    var c = H.el('span', 'ob-c');
    c.appendChild(H.el('span', 'ob-badge ob-badge-' + outcome, OUTCOME_LABEL[outcome] || outcome || '—'));
    return c;
  }
  function journeyDots(lastStep, outcome) {
    var at = Math.max(0, phaseOf(lastStep));
    var track = H.el('span', 'ob-journey');
    PHASES.forEach(function (ph, i) {
      var dot = H.el('span', 'ob-dot' + (i < at ? ' is-done' : i === at ? ' ob-badge-' + outcome : ''));
      dot.title = ph[1];
      track.appendChild(dot);
    });
    return track;
  }
  function matches(x, q, tags) {
    if (!q) return true;
    q = q.toLowerCase();
    return [x.name, x.player_id, tags[x.guild_id], x.guild_id, ifaceName(x.interface), x.step && stepLabel(x.step)].some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
  }
  function searchBox(ctx) {
    var lab = H.el('label', 'sui-input-text ob-search');
    var inp = H.el('input');
    inp.type = 'text';
    inp.placeholder = 'Name, id or guild';
    inp.value = ctx.st.q || '';
    inp.addEventListener('input', function () {
      ctx.st.q = inp.value;
      clearTimeout(ctx.st.qt);
      ctx.st.qt = setTimeout(function () { ctx.redraw(); var n = ctx.host.querySelector('.ob-search input'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 150);
    });
    lab.appendChild(inp);
    return lab;
  }
  function pills(ctx, rows, key, kinds, labelOf, valueOf) {
    var seen = kinds.filter(function (k) { return rows.some(function (x) { return valueOf(x) === k; }); });
    var show = seen.indexOf(ctx.st[key]) >= 0 ? ctx.st[key] : '';
    var box = H.el('div', 'ob-pills');
    [''].concat(seen).forEach(function (k) {
      var n = k ? rows.filter(function (x) { return valueOf(x) === k; }).length : rows.length;
      var a = H.el('a', 'ob-pill' + (k === show ? ' is-on' : ''), (k ? labelOf(k) : 'All') + ' ' + int(n));
      a.href = 'javascript:void(0)';
      a.setAttribute('data-outcome', k || 'all');
      a.addEventListener('click', function () { ctx.st[key] = k; ctx.redraw(); });
      box.appendChild(a);
    });
    return { node: box, show: show };
  }
  /* Every player the servers named as stopping somewhere, with where. */
  function stoppedRows(d) {
    var out = [], g = (d.filters || {}).guild;
    Object.keys(d.stopped || {}).forEach(function (k) {
      (d.stopped[k].players || []).forEach(function (x) { if (!g || x.guild_id === g) out.push(Object.assign({}, x, { step: k, phase: phaseOf(k) })); });
    });
    return out;
  }
  function viewPlayers(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view'), tags = guildTags(d);
    var recent = d.recent || [], runs = d.runs || [], stopped = stoppedRows(d);
    var stoppedTotal = Object.keys(d.stopped || {}).reduce(function (a, k) { return a + (d.stopped[k].total || 0); }, 0);
    box.appendChild(viewStrip(ctx));
    var all = ctx.view === 'runs' ? runs : ctx.view === 'stopped' ? stopped : recent;
    box.appendChild(kpi(Object.assign({}, ctx, { segs: [{}] }), [
      { key: 'signups', label: 'New signups', get: function () { return { value: int(recent.length), sub: 'newest sampled' }; }, go: function () { ctx.go('players', 'signups'); } },
      { key: 'stopped', label: 'Stopped', cls: 'bad', get: function () { return { value: int(stopped.length), sub: 'named' + (OB.tag ? ' in ' + OB.tag : '') + ', of ' + int(stoppedTotal) + ' stopped in every guild' }; }, go: function () { ctx.go('players', 'stopped'); } },
      { key: 'runs', label: 'Tutorial runs', def: DEFS.Run, get: function () { return { value: int(runs.length), sub: 'newest read' }; }, go: function () { ctx.go('players', 'runs'); } },
      { key: 'finished', label: 'Finished', cls: 'ok', get: function () { var n = all.filter(function (x) { return x.outcome === 'completed'; }).length; return { value: int(n), sub: share(n, all.length) + ' of this list' }; } },
      { key: 'playing', label: 'Playing now', get: function () { var n = all.filter(function (x) { return x.outcome === 'playing' || x.outcome === 'deciding'; }).length; return { value: int(n), sub: 'in this list' }; } },
    ], H.el('span', 'ob-chip', 'Newest only'), 'newest'));
    if (!all.length) { box.appendChild(ctx.view === 'runs' ? H.stateBlock('empty', 'No tutorial runs yet') : ctx.view === 'stopped' ? H.stateBlock('empty', 'No one named as stopped yet') : emptyOr(d, 'No sessions sampled yet')); return box; }
    var pk = 'pill_' + ctx.view, p;
    if (ctx.view === 'stopped') p = pills(ctx, all, pk, PHASES.map(function (x, i) { return i; }), function (k) { return PHASES[k][1]; }, function (x) { return x.phase; });
    else p = pills(ctx, all, pk, ['completed', 'declined', 'left', 'deciding', 'playing'], function (k) { return OUTCOME_LABEL[k]; }, function (x) { return x.outcome; });
    if (ctx.view === 'stopped' && ctx.st.stepFilter && !all.some(function (x) { return x.step === ctx.st.stepFilter; })) ctx.st.stepFilter = null;
    var rows = all.filter(function (x) { return (p.show === '' || (ctx.view === 'stopped' ? x.phase === p.show : x.outcome === p.show)) && (ctx.view !== 'stopped' || !ctx.st.stepFilter || x.step === ctx.st.stepFilter) && matches(x, ctx.st.q, tags); });
    var title = ({ runs: 'Runs', stopped: 'Stopped players', signups: 'New signups' })[ctx.view];
    var b = block(title + ' · ' + int(rows.length) + (rows.length !== all.length ? ' of ' + int(all.length) : ''), { key: 'players', scope: ctx.view === 'stopped' ? 'As named by the servers' : 'Newest',
      extra: [actionBtn('Copy ids', function () { copyText(rows.map(function (x) { return x.player_id; }).filter(Boolean).join('\n'), rows.length); }, 'copy_ids')] });
    var bar1 = H.el('div', 'ob-find');
    bar1.appendChild(searchBox(ctx));
    bar1.appendChild(p.node);
    if (ctx.view === 'stopped' && ctx.st.stepFilter) bar1.appendChild(link(stepLabel(ctx.st.stepFilter) + ' ×', function () { ctx.st.stepFilter = null; ctx.redraw(); }, 'ob-pill is-on'));
    b.appendChild(bar1);
    if (ctx.view === 'runs') b.appendChild(runTable(d, rows, ctx.st, ctx.redraw));
    else if (ctx.view === 'stopped') {
      ctx.st.stopSort = ctx.st.stopSort || { key: 'seen', dir: -1 };
      var sacc = { player: function (x) { return (x.name || x.player_id || '').toLowerCase(); }, step: function (x) { return x.phase * 1000 + (x.step || '').length; }, guild: function (x) { return tags[x.guild_id] || ''; }, seen: function (x) { return x.last_ms || 0; } };
      var st = grid('ob-stopped', [{ label: 'Player', k: 't', w: 'minmax(15ch, 1.1fr)', sort: 'player' }, { label: 'Stopped at', k: 't', w: 'minmax(20ch, 1.6fr)', sort: 'step' },
        { label: 'Guild', k: 't', w: 'minmax(6ch, .4fr)', opt: true, sort: 'guild' }, { label: 'Outcome', k: 't', w: 'minmax(8ch, .5fr)', opt: true }, { label: 'Seen', k: 'n', sort: 'seen' }], ctx.st.stopSort, ctx.redraw);
      H.sortBy(rows, ctx.st.stopSort, sacc).forEach(function (x) {
        addRow(st, [playerLink(x), cell(stepLabel(x.step), 'ob-step', x.step), cell(tags[x.guild_id] || x.guild_id), badge(x.outcome), cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-sub')],
          { data: { player: x.player_id, step: x.step } });
      });
      b.appendChild(st);
    } else {
      ctx.st.recSort = ctx.st.recSort || { key: 'seen', dir: -1 };
      var acc = { player: function (x) { return (x.name || x.player_id || '').toLowerCase(); }, outcome: function (x) { return x.outcome || ''; }, got: function (x) { return phaseOf(x.last_step); },
        signup: function (x) { return x.signup_s || 0; }, tutorial: function (x) { return x.tutorial_s || 0; }, seen: function (x) { return x.last_ms || 0; } };
      var t = grid('ob-recent', [{ label: 'Player', k: 't', w: 'minmax(15ch, 1.1fr)', sort: 'player' }, { label: 'Outcome', k: 't', w: 'minmax(9ch, .5fr)', sort: 'outcome' },
        { label: 'Got to', k: 't', w: 'minmax(24ch, 2fr)', opt: true, sort: 'got' }, { label: 'Signup', k: 'n', opt: true, sort: 'signup' }, { label: 'Tutorial', k: 'n', opt: true, sort: 'tutorial' },
        { label: 'Seen', k: 'n', sort: 'seen' }], ctx.st.recSort, ctx.redraw);
      H.sortBy(rows, ctx.st.recSort, acc).forEach(function (x) {
        var at = H.el('span', 'ob-c ob-step');
        at.appendChild(journeyDots(x.last_step, x.outcome));
        var ph = PHASES[phaseOf(x.last_step)];
        at.appendChild(sub(ph ? ph[1] : '—'));
        at.title = x.last_step || '';
        addRow(t, [playerLink(x, tags[x.guild_id] || x.guild_id), badge(x.outcome), at, dur(x.signup_s), dur(x.tutorial_s), cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-sub')], { data: { player: x.player_id } });
      });
      b.appendChild(t);
    }
    if (!rows.length) b.appendChild(H.stateBlock('empty', 'No one matches'));
    box.appendChild(b);
    return box;
  }

  // ── GUILDS ──
  function guildFacts(g, c) {
    var live = g.status === 'ok', o = g.outcome || {};
    var rows = live ? [['Tutorial offered', int(o.offered)], ['Runs', int(g.runs)], ['Signups timed', int(g.sampled) + ' of ' + int(g.signed_up)], ['No telemetry', int(g.untracked)], ['No player', int(g.no_player)], ['Sessions read', c ? int(c.fetched) + ' / ' + int(c.todo) : '—']]
      : [['State', g.status === 'no_api' ? 'No API published' : 'Failing']];
    if (g.error) rows.push(['Error', g.error]);
    if (g.runs_error) rows.push(['Runs', g.runs_error]);
    if (c && c.last_error) rows.push(['Read', c.last_error]);
    var box = factGrid(rows);
    box.setAttribute('data-more', g.id);
    return box;
  }
  function viewGuilds(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view'), gs = d.guilds || [];
    var crawl = (d.crawl && d.crawl.guilds) || {}, mine = (d.filters || {}).guild;
    var none = unguilded(d);
    box.appendChild(kpi(Object.assign({}, ctx, { segs: [{}] }), [
      { key: 'guilds', label: 'Guilds', get: function () { return { value: int(gs.length), sub: int(gs.filter(function (g) { return g.status === 'ok'; }).length) + ' reporting' }; } },
      { key: 'players', label: 'Players in a guild', get: function () { return { value: int(sum(gs, function (g) { return g.players; })), sub: none ? int(none) + ' in no guild' : null }; } },
      { key: 'active', label: 'Active', cls: 'ok', get: function () { var a = sum(gs, function (g) { return g.active; }), p = sum(gs, function (g) { return g.players; }); return { value: int(a), sub: share(a, p) + ' of players in a guild' }; } },
      { key: 'dark', label: 'Not reporting', get: function () { var dk = gs.filter(function (g) { return g.status !== 'ok'; }); return { value: int(dk.length), sub: int(sum(dk, function (g) { return g.players; })) + ' players unseen' }; } },
    ], H.el('span', 'ob-chip', 'Now'), 'now'));
    ctx.st.guildSort = ctx.st.guildSort || { key: 'players', dir: -1 };
    var acc = { name: function (g) { return (g.name || g.id).toLowerCase(); }, players: function (g) { return g.players || 0; }, active: function (g) { return g.active || 0; },
      rate: function (g) { return ratio(g.active, g.players) || 0; }, signups: function (g) { return ratio(g.signed_up, g.started) || 0; }, finished: function (g) { var o = g.outcome || {}; return ratio(o.completed, o.offered) || 0; } };
    var t = grid('ob-guilds', [{ label: 'Guild', k: 't', w: 'minmax(18ch, 1.2fr)', sort: 'name' }, { label: 'Active of players', k: 'b', w: 'minmax(10ch, 1.6fr)', opt: true },
      { label: 'Players', k: 'n', w: 'minmax(9ch, .55fr)', sort: 'players' }, { label: 'Active', k: 'n', w: 'minmax(8ch, .55fr)', sort: 'active' }, { label: 'Active %', k: 'n', w: 'minmax(9ch, .5fr)', opt: true, sort: 'rate' },
      { label: 'Signups', k: 'n', w: 'minmax(14ch, .8fr)', opt: true, sort: 'signups', def: 'Finished signups as a share of signup opens, from the guild\'s own server.' },
      { label: 'Tutorial', k: 'n', w: 'minmax(14ch, .8fr)', opt: true, sort: 'finished', def: 'Tutorial players who finished, from the guild\'s own server.' }, { label: '', k: 't', w: 'minmax(17ch, .9fr)' }],
      ctx.st.guildSort, ctx.redraw);
    var top = gs.reduce(function (m, g) { return Math.max(m, g.players || 0); }, 0);
    H.sortBy(gs, ctx.st.guildSort, acc).forEach(function (g) {
      var live = g.status === 'ok', o = g.outcome || {};
      var name = H.el('span', 'ob-c ob-step');
      name.appendChild(H.el('span', null, g.name || g.id));
      name.appendChild(sub(live ? (g.tag ? g.tag + ' · ' : '') + g.id : g.status === 'no_api' ? 'No API' : 'Failing'));
      var strip = H.el('span', 'ob-bar');
      var whole = H.el('span', 'ob-whole');
      whole.style.width = (ratio(g.players, top) * 100) + '%';
      var act = H.el('span', 'ob-keep');
      act.style.width = (ratio(g.active, g.players) * 100) + '%';
      whole.appendChild(act);
      strip.appendChild(whole);
      var doors = H.el('span', 'ob-c ob-doors');
      var focus = link(mine === g.id ? 'Focused' : 'Focus', function () { ctx.set({ guild: mine === g.id ? '' : g.id }); }, 'ob-focus' + (mine === g.id ? ' is-on' : ''));
      focus.setAttribute('data-act', 'focus');
      focus.title = mine === g.id ? 'Clear the guild filter' : 'Filter every page to this guild';
      doors.appendChild(focus);
      if (live) {
        var stuck = link('Stopped', function () { ctx.set({ guild: g.id, page: 'players', view: 'stopped' }); }, 'ob-focus');
        stuck.setAttribute('data-act', 'stopped');
        stuck.title = 'This guild\'s players who stopped in signup or Combat Training';
        doors.appendChild(stuck);
      }
      var focusCell = doors;
      var row = addRow(t, [name, strip, cell(int(g.players), 'ob-v'), int(g.active), share(g.active, g.players), live ? stack(pct(ratio(g.signed_up, g.started)), int(g.signed_up) + ' of ' + int(g.started)) : '—',
        live ? stack(pct(ratio(o.completed, o.offered)), int(o.completed) + ' of ' + int(o.offered)) : '—', focusCell],
        { cls: (live ? '' : 'is-quiet') + (mine === g.id ? ' is-mine' : ''), data: { guild: g.id } });
      drill(t, row, 'guild:' + g.id, function () { return guildFacts(g, crawl[g.id]); });
    });
    if (none) addRow(t, [cell('No guild', 'ob-step'), H.el('span', 'ob-bar'), cell(int(none), 'ob-v'), '—', '—', '—', '—', ''], { cls: 'is-quiet', data: { guild: 'none' } });
    var b = block('Guilds · ' + int(gs.length), { key: 'guilds', scope: 'Every guild · now', noTag: true });
    b.appendChild(t);
    box.appendChild(b);
    return box;
  }

  // ── TRENDS ──
  function viewTrends(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    var hist = d.history || [], last = hist[hist.length - 1] || {};
    box.appendChild(viewStrip(ctx));
    function lvl(k, label, cls) {
      return { key: k, label: label, cls: cls, get: function () {
        var p = trendPoints(d, trendDef(k));
        var c = trendChange(p, 7, 'level');
        return { value: int(p.length ? p[p.length - 1][1] : null), delta: c == null ? null : { change: c, then: p[p.length - 1][1] - c, now: p[p.length - 1][1] }, spark: p.slice(-30).map(function (x) { return x[1]; }) };
      } };
    }
    box.appendChild(kpi(Object.assign({}, ctx, { segs: [{}], win: '7' }), [lvl('humans', 'Players'), lvl('active_7d', 'Active this week', 'ok'),
      { key: 'new', label: 'New players', get: function () { var p = trendPoints(d, trendDef('new')); return { value: int(trendChange(p, 30, 'daily')), sub: 'in the last 30 days', spark: p.slice(-30).map(function (x) { return x[1]; }) }; } },
      { key: 'record', label: 'Daily record', get: function () { return { value: hist.length ? int(hist.length) : '—', sub: hist.length ? 'days since ' + shortDay(hist[0].day) : 'nothing recorded yet' }; } },
    ], H.el('span', 'ob-chip', last.day ? 'Through ' + shortDay(last.day) : 'No record yet'), last.day ? 'through ' + shortDay(last.day) : ''));
    if (ctx.view === 'daily') { box.appendChild(viewDaily(ctx)); return box; }
    var rows = TRENDS.map(function (m) { return [m, trendPoints(d, m)]; }).filter(function (r) { return r[1].length; });
    if (!rows.length) { box.appendChild(emptyOr(d, 'No days recorded yet')); return box; }
    var picked = ctx.st.picked = (ctx.st.picked || []).filter(function (k) { return rows.some(function (r) { return r[0][0] === k; }); });
    var go = actionBtn(picked.length ? 'Chart ' + picked.length : 'Chart', function () { openChart(picked.length ? picked : ['humans', 'active_7d']); }, 'chart_picked');
    go.title = 'Tick up to six figures to chart them together';
    var b = block('Figures', { key: 'figures', noTag: true, scope: 'Humans, ' + (OB.tag || 'every guild') + ((ctx.d.filters || {}).compare ? ' · not split' : ''), def: DEFS['Daily record'], extra: [go] });
    b.appendChild(trendTable(ctx, rows, true));
    box.appendChild(b);
    return box;
  }
  function viewDaily(ctx) {
    var d = ctx.d, segs = ctx.segs, days = {};
    segs.forEach(function (s, i) { (s.daily || []).forEach(function (x) { (days[x.day] = days[x.day] || {})[i] = x; }); });
    var order = Object.keys(days).sort().reverse();
    if (!order.length) return emptyOr(d, 'No signups sampled yet');
    var b = block('Each day · new signups sampled', { key: 'daily', def: DEFS.Sample, scope: 'By day' });
    if (segs.length === 1) {
      var t = grid('ob-daily', [{ label: 'Day', k: 't', w: 'minmax(11ch, 1fr)' }, { label: 'Signed up', k: 'n' }, { label: 'Offered', k: 'n', opt: true }, { label: 'Finished', k: 'n' },
        { label: 'Skipped', k: 'n', opt: true }, { label: '', k: 'b', w: 'minmax(8ch, 1fr)', opt: true }, { label: 'Finish rate', k: 'n' }]);
      order.forEach(function (day) {
        var x = days[day][0], r = ratio(x.completed, x.offered);
        addRow(t, [cell(shortDay(day), 'ob-step', day), int(x.signed_up), int(x.offered), int(x.completed), int(x.declined), bar(r), share(x.completed, x.offered)], { data: { day: day } });
      });
      b.appendChild(t);
      return b;
    }
    var cols = [{ label: 'Day', k: 't', w: 'minmax(11ch, 1fr)' }];
    segs.forEach(function (s, i) { cols.push({ label: segLabel(s, i, segName(s) + ' · Signed up'), k: 'n' }, { label: 'Finish rate', k: 'n' }); });
    var c = grid('ob-compare', cols);
    order.forEach(function (day) {
      var cells = [cell(day, 'ob-step')];
      segs.forEach(function (s, i) { var x = days[day][i]; cells.push(x ? int(x.signed_up) : '—', x ? share(x.completed, x.offered) : '—'); });
      addRow(c, cells, { data: { day: day } });
    });
    b.appendChild(c);
    return b;
  }

  // ── DATA: trust and definitions ──
  function footLine(d) {
    var c = d.crawl || {}, p = c.players || {};
    var sessions = (d.segments || []).reduce(function (a, s) { return a + (s.sessions || 0); }, 0);
    var parts = [int(sessions) + ' onboarding sessions on ' + String(d.version || '—').replace(/^tutorial-/, 'Tutorial v')];
    var f = d.filters || {}, r = c.replicants || {};
    if (p.known && (f.replicants || f.compare === 'replicant')) parts.push('ledgers read for ' + int(p.ledgers) + ' of ' + int(p.known) + ' players');
    else if (p.known) parts.push('ledgers read for ' + int(p.human_ledgers) + ' of ' + int(p.humans) + ' humans');
    if (r.known) parts.push(int(r.known + (r.likely || 0)) + ' replicants under ' + int(r.primaries) + ' primaries');
    if (c.running) parts.push('reading…');
    else if (c.finished_ms) parts.push('read ' + H.ago(c.finished_ms) + ' ago');
    var foot = H.el('div', 'ob-foot');
    if (c.running) foot.appendChild(H.el('i', H.iconClass('icon-in-progress', 'sui-icon-sm')));
    foot.appendChild(H.el('span', null, parts.join(' · ')));
    return foot;
  }
  function viewData(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view'), g = d.guilds || [];
    var issues = issuesOf(d), src = sourceRows(d), failing = src.filter(function (s) { return s[4]; }).length, read = src.filter(function (s) { return s[5] && !s[4]; }).length;
    var nIssues = issues.filter(function (x) { return x.level === 'issue'; }).length;
    box.appendChild(kpi(Object.assign({}, ctx, { segs: [{}] }), [
      { key: 'issues', label: 'Issues', get: function () { return { value: int(nIssues), cls: nIssues ? 'bad' : 'ok', sub: plural(issues.length - nIssues, 'notice', 'notices') }; } },
      { key: 'sources', label: 'Sources read', get: function () { return { value: read + ' of ' + src.length, cls: failing ? 'bad' : read === src.length ? 'ok' : null, sub: failing ? int(failing) + ' failing' : read < src.length ? int(src.length - read) + ' not read yet' : 'none failing' }; } },
      { key: 'read', label: 'Last read finished', get: function () { var c = d.crawl || {}; return { value: c.finished_ms ? H.ago(c.finished_ms) : '—', cls: failing ? 'bad' : null, sub: c.finished_ms ? 'ago' + (failing ? ' · ' + int(failing) + ' sources failing' : '') + (c.running ? ' · reading again now' : '') : c.running ? 'first read in progress' : 'not read yet' }; } },
      { key: 'record', label: 'Daily record', get: function () { var n = (d.history || []).length; return { value: n ? int(n) : '—', sub: n ? 'days' : 'nothing recorded yet' }; } },
    ], H.el('span', 'ob-chip', 'Now'), 'now'));
    if (issues.length) {
      var ib = block('Needs a look', { key: 'issues', scope: 'Every guild', noTag: true });
      var list = H.el('div', 'ob-issues');
      issues.forEach(function (x) {
        var row = H.el('a', 'ob-issue ob-row is-' + x.level);
        row.href = 'javascript:void(0)';
        row.setAttribute('data-issue', x.title);
        if (x.fix) row.title = x.fix;
        row.appendChild(H.el('span', 'ob-badge ob-badge-' + x.level, x.level === 'issue' ? 'Issue' : 'Notice'));
        var what = H.el('span', 'ob-step');
        what.appendChild(H.el('span', 'ob-v', x.title));
        what.appendChild(sub(x.where));
        row.appendChild(what);
        row.appendChild(H.el('span', 'ob-n', x.count));
        row.appendChild(H.el('i', H.iconClass('icon-chevron-right', 'sui-icon-sm')));
        row.addEventListener('click', function () { ctx.go(x.page, x.view); });
        list.appendChild(row);
      });
      ib.appendChild(list);
      box.appendChild(ib);
    }
    var sb = block('Sources · ' + read + ' of ' + src.length + ' read' + (failing ? ' · ' + failing + ' failing' : ''), { key: 'sources', scope: 'Every guild', noTag: true });
    var t = grid('ob-sources', [{ label: 'Source', k: 't', w: 'minmax(16ch, 1fr)' }, { label: 'Holds', k: 't', w: 'minmax(18ch, 1.2fr)' }, { label: 'Read', k: 't', w: 'minmax(12ch, .8fr)', opt: true },
      { label: 'Follows', k: 't', w: 'minmax(12ch, .8fr)', opt: true, def: 'The filters this source can honour.' }]);
    src.forEach(function (s) {
      var state = s[4] ? 'is-failing' : s[5] ? '' : 'is-pending';
      var name = H.el('span', 'ob-c ob-step ob-src-name');
      name.appendChild(H.el('span', 'ob-src-mark'));
      name.appendChild(H.el('span', null, s[0]));
      addRow(t, [name, s[5] ? s[1] : cell('Not read yet', 'ob-sub'), s[4] ? cell(String(s[4]), 'is-bad') : s[2], cell(s[3], 'ob-sub')], { cls: state, data: { source: s[0] } });
    });
    sb.appendChild(t);
    box.appendChild(sb);
    var crawl = (d.crawl && d.crawl.guilds) || {};
    var gb = block('Guild reads', { key: 'guild_reads', scope: 'Every guild', noTag: true });
    var gt = grid('ob-guild-reads', [{ label: 'Guild', k: 't', w: 'minmax(16ch, 1fr)' }, { label: 'State', k: 't', w: 'minmax(10ch, .7fr)' }, { label: 'Sessions read', k: 'n' },
      { label: 'Last error', k: 't', w: 'minmax(14ch, 1.2fr)', opt: true }, { label: 'Errors', k: 'n', opt: true }]);
    g.forEach(function (x) {
      var c = crawl[x.id] || {};
      var unread = x.status === 'ok' && crawl[x.id] == null, settledRead = (d.crawl || {}).finished_ms && !(d.crawl || {}).running;
      var stateText = x.status === 'no_api' ? 'No API' : x.status === 'error' ? 'Failing' : unread ? (settledRead ? 'Missed last read' : 'Not read yet') : c.todo && c.fetched < c.todo ? 'Reading' : 'OK';
      addRow(gt, [cell(x.name || x.id, 'ob-step'), cell(stateText, x.status === 'error' || (unread && settledRead) ? 'is-bad' : x.status === 'no_api' ? 'is-slow' : unread ? 'ob-sub' : ''), c.todo != null ? int(c.fetched) + ' / ' + int(c.todo) : '—',
        cell(c.last_error || x.error || '—', 'ob-sub', c.last_error || x.error), int(c.errors)], { data: { guild: x.id } });
    });
    gb.appendChild(gt);
    box.appendChild(gb);
    var cov = block('Coverage · players', { key: 'coverage', scope: 'Every guild', copy: false, noTag: true });
    var chainRead = !!((d.crawl || {}).players || {}).refreshed_ms;
    var bucket = function (st) { return sum(g.filter(function (x) { return x.status === st; }), function (x) { return x.players; }); };
    var strip = H.el('div', 'ob-stack'), legend = H.el('div', 'ob-legend');
    var noGuild = (d.filters || {}).guild ? null : unguilded(d);
    [['In reporting guilds', bucket('ok'), 'ok'], ['In failing guilds', bucket('error'), 'bad'], ['In guilds with no API', bucket('no_api'), 'dark'], ['In no guild', noGuild, 'none']].forEach(function (k) {
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
    var settledC = (d.crawl || {}).finished_ms && !(d.crawl || {}).running;
    if (chainRead) { cov.appendChild(strip); cov.appendChild(legend); }
    else cov.appendChild(settledC ? H.stateBlock('error', 'Chain tables were not read: no coverage') : H.stateBlock('loading', 'Waiting for the chain tables'));
    box.appendChild(cov);
    var set = block('Settings', { key: 'settings', copy: false, noTag: true });
    var form = H.el('div', 'ob-settings');
    form.appendChild(H.field('Active means acted within', control('active', H.selectBox(String(d.active_days || 7), ACTIVE, function (v) { ctx.set({ active: v === '7' ? '' : v }); }))));
    form.appendChild(H.field('Quit means idle for', control('idle', H.selectBox(String(d.idle_hours || 24), IDLE, function (v) { ctx.set({ idle: v === '24' ? '' : v }); }))));
    var ex = H.checkbox(!!(d.filters || {}).include_excluded, 'Include excluded players', function (v) { ctx.set({ excl: v ? '1' : '' }); });
    ex.classList.add('ob-ex-switch');
    ex.setAttribute('data-control', 'excl');
    form.appendChild(ex);
    set.appendChild(form);
    box.appendChild(set);
    var rc = reconcileBlock(ctx);
    if (rc) box.appendChild(rc);
    var gl = block('Definitions', { key: 'definitions', noTag: true });
    var dt = grid('ob-defs', [{ label: 'Term', k: 't', w: 'minmax(16ch, .6fr)' }, { label: 'Means', k: 't', w: 'minmax(20ch, 2fr)' }]);
    Object.keys(DEFS).forEach(function (k) { addRow(dt, [cell(k, 'ob-step ob-v'), cell(DEFS[k], 'ob-wrap')], { data: { term: k } }); });
    gl.appendChild(dt);
    box.appendChild(gl);
    box.appendChild(footLine(d));
    return box;
  }
  /* Do the chain's figures and the daily record agree? The same window from
   * both, side by side, so a disagreement is seen rather than inferred. Only
   * for the plain population: the record follows the guild filter alone. */
  function reconcileRows(d) {
    var seg = (d.segments || [])[0];
    if (!seg || !seg.pirate || !isPlain(d)) return [];
    var hs = (d.history_series || {}).series || {}, ps = seriesOf(seg), last = function (a) { a = (a || []).filter(function (x) { return x != null; }); return a.length ? a[a.length - 1] : null; };
    var tail = function (a, w) { a = a || []; if (a.length < w) return null; var t = a.slice(-w); return t.some(function (x) { return x == null; }) ? null : t.reduce(function (x, y) { return x + y; }, 0); };
    var lastRec = function (k) { var h = d.history || []; return h.length ? h[h.length - 1][k] : null; };
    return [
      ['Players', allOf(seg).players, lastRec('humans')],
      ['Active today', winOf(seg, 1).active, last(hs.dau)],
      ['Active this week', winOf(seg, 7).active, last(hs.wau)],
      ['Active this month', winOf(seg, 30).active, last(hs.mau)],
      ['Signups, 7 days', winOf(seg, 7).new, tail(ps.new, 7)],
      ['Signups, 30 days', winOf(seg, 30).new, tail(ps.new, 30)],
      ['Activated, 30 days', winOf(seg, 30).activated, tail(ps.activations, 30)],
    ].filter(function (r) { return r[1] != null && r[2] != null; }).map(function (r) {
      var diff = r[2] - r[1], ok = Math.abs(diff) <= Math.max(1, Math.abs(r[1]) * 0.02);
      return { label: r[0], chain: r[1], record: r[2], diff: diff, ok: ok };
    });
  }
  function reconcileBlock(ctx) {
    var rows = reconcileRows(ctx.d);
    if (!rows.length) return null;
    var bad = rows.filter(function (r) { return !r.ok; }).length;
    var b = block('Do the sources agree? · ' + (bad ? plural(bad, 'figure differs', 'figures differ') : 'all ' + rows.length + ' agree'), { key: 'reconcile', scope: 'Every guild', noTag: true,
      def: 'The same figure from the chain\'s tables (what the tiles show) and from the daily record (what Trends shows). They should match; one that does not is marked.' });
    var t = grid('ob-reconcile', [{ label: 'Figure', k: 't', w: 'minmax(18ch, 1.4fr)' }, { label: 'Tiles', k: 'n' }, { label: 'Daily record', k: 'n' }, { label: 'Difference', k: 'n' }]);
    rows.forEach(function (r) { addRow(t, [cell(r.label, 'ob-step'), int(r.chain), int(r.record), cell(r.ok ? 'agree' : signed(r.diff), r.ok ? 'ob-sub' : 'is-bad')], { data: { figure: r.label }, cls: r.ok ? '' : 'is-open' }); });
    b.appendChild(t);
    return b;
  }
  function control(key, node) { node.setAttribute('data-control', key); return node; }

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
    var keys = Object.keys(g), done = keys.filter(function (k) { return g[k].todo != null && g[k].fetched >= g[k].todo; }).length;
    var fetched = keys.reduce(function (a, k) { return a + (Number(g[k].fetched) || 0); }, 0);
    var parts = [keys.length ? 'Reading guilds · ' + done + ' of ' + keys.length + ' done' : 'Reading every guild'];
    if (fetched) parts.push(int(fetched) + ' sessions');
    if (p.known) parts.push(int(p.known) + ' players');
    return parts.join(' · ');
  }
  function emptyOr(d, text) { return reading(d) ? H.stateBlock('loading', progress(d)) : H.stateBlock('empty', text); }
  /* Sections folded from the crawls; Acquisition, Guilds, Trends and Data come from the servers' own reads. */
  var CRAWLED = { overview: 1, onboarding: 1, engagement: 1 };

  // ── The frame: sections, scope bar, status ──
  function viewStrip(ctx) {
    var list = VIEWS[ctx.page];
    var s = H.navStrip(list.map(function (v) { return { key: v[0], label: v[1] }; }), ctx.view, function (k) { ctx.go(ctx.page, k); });
    s.classList.add('ob-subnav');
    return s;
  }
  var DEFAULTS = { iface: '', guild: '', activity: '', reps: '', compare: '', version: '' };
  function scopeBar(ctx, p) {
    var d = ctx.d, page = ctx.page, set = ctx.set;
    var o = d.options || {}, f = d.filters || {};
    var wrap = H.el('div', 'ob-scope' + (ctx.st.scopeOpen ? ' is-open' : ''));
    var bar1 = H.el('div', 'ob-scope-body');
    var nSet = 0, names = [];
    function put(key, node, isSet) {
      node.setAttribute('data-control', key);
      if (isSet) { node.classList.add('is-set'); nSet++; var o2 = node.options && node.options[node.selectedIndex]; if (o2) names.push(key === 'guild' ? (OB.tag || o2.value) : o2.textContent.replace(/^Split by: /, 'split ')); }
      if (!uses(page, key)) {
        node.classList.add('is-off');
        node.disabled = true;
        node.title = key === 'reps' ? 'Humans only on this page' : 'Not used on this page';
      }
      bar1.appendChild(node);
    }
    var both = f.compare === 'replicant';
    put('reps', H.selectBox(both || f.replicants ? '1' : '', [{ value: '', label: 'Humans only' }, { value: '1', label: 'Humans + replicants' }], function (v) { set({ reps: v }); }), !!f.replicants && !both);
    if (both) bar1.lastChild.disabled = true;
    var guilds = [{ value: '', label: 'Every guild' }].concat((o.guilds || []).map(function (g) { return { value: g.id, label: g.label + ' · ' + g.id }; }));
    put('guild', H.selectBox(f.guild || '', guilds, function (v) { set({ guild: v }); }), !!f.guild);
    var ifaces = [{ value: '', label: 'Any app' }].concat((o.interfaces || []).map(function (i) { return { value: i, label: ifaceName(i) }; }));
    put('iface', H.selectBox(f.interface || '', ifaces, function (v) { set({ iface: v }); }), !!f.interface);
    var days = d.active_days || 7;
    put('activity', H.selectBox(f.activity || '', [{ value: '', label: 'Active or not' }, { value: 'active', label: 'Active ' + days + 'd' }, { value: 'inactive', label: 'Inactive ' + days + 'd' }], function (v) { set({ activity: v }); }), !!f.activity);
    var versions = (d.versions || []).map(function (v) { return { value: v, label: v.replace(/^tutorial-/, 'Tutorial v') }; });
    if (versions.length > 1) {
      put('version', H.selectBox(d.version, versions, function (v) { set({ version: v === versions[0].value ? '' : v }); }), !!p.version && p.version !== versions[0].value);
      /* Split by version shows every version: one picked would be a lie. */
      if (f.compare === 'version') { bar1.lastChild.disabled = true; bar1.lastChild.classList.add('is-off'); }
    }
    put('compare', H.selectBox(f.compare || '', SPLITS, function (v) { set({ compare: v }); }), !!f.compare);
    var any = Object.keys(DEFAULTS).some(function (k) { return p[k]; });
    if (any) {
      var r = link('Reset', function () { set(Object.assign({}, DEFAULTS)); }, 'ob-reset');
      r.setAttribute('data-control', 'reset');
      bar1.appendChild(r);
    }
    /* In a narrow card the filters fold behind one button that counts them. */
    var tog = link('Filters' + (nSet ? ' · ' + names.join(' · ') : ''), function () { ctx.st.scopeOpen = !ctx.st.scopeOpen; wrap.classList.toggle('is-open', !!ctx.st.scopeOpen); }, 'ob-scope-toggle' + (nSet ? ' is-set' : ''));
    tog.insertBefore(H.el('i', H.iconClass('icon-caret-down', 'sui-icon-sm')), tog.firstChild);
    wrap.appendChild(tog);
    wrap.appendChild(bar1);
    return wrap;
  }
  /* Freshness and trouble in one place, on every page; it opens Data. */
  function statusLink(d, go) {
    var c = d.crawl || {}, issues = issuesOf(d).filter(function (x) { return x.level === 'issue'; }).length;
    var a = H.el('a', 'ob-status' + (issues ? ' is-bad' : ''));
    a.href = 'javascript:void(0)';
    a.addEventListener('click', function () { go('data'); });
    if (issues) {
      a.appendChild(H.el('span', 'ob-src-mark'));
      a.appendChild(H.el('span', null, plural(issues, 'issue', 'issues')));
    }
    var notes = [];
    if ((d.filters || {}).include_excluded) notes.push('excluded in');
    if ((d.active_days || 7) !== 7) notes.push('active ' + d.active_days + 'd');
    if ((d.idle_hours || 24) !== 24) notes.push('quit ' + (d.idle_hours % 24 ? d.idle_hours + 'h' : d.idle_hours / 24 + 'd'));
    if (notes.length) a.appendChild(H.el('span', 'ob-ex-off', notes.join(' · ')));
    if (c.running) a.appendChild(H.el('i', H.iconClass('icon-in-progress', 'sui-icon-sm')));
    a.appendChild(sub(c.finished_ms ? (c.running ? 'Reading · read ' : 'Read ') + H.ago(c.finished_ms) + ' ago' : c.running ? 'First read' : 'Not read yet'));
    a.title = 'Data health and settings';
    return a;
  }

  // ── The card ──
  var DRAW = { overview: viewOverview, acquisition: viewAcquisition, onboarding: viewOnboarding, engagement: viewEngagement, players: viewPlayers, guilds: viewGuilds, trends: viewTrends, data: viewData };
  T.register('onboarding', {
    label: 'Telemetry', argHint: '[section] [view] [7d] [guild 0-5] [split guild]', parseArgs: parseArgs,
    describe: function (p) {
      p = p || {};
      var s = SECTIONS.filter(function (x) { return x[0] === pageOf(p); })[0];
      return 'Telemetry · ' + (s ? s[1] : 'Overview') + (p.guild ? ' · ' + p.guild : '');
    },
    cadenceMs: 30000, defaultWidth: 3,
    params: [],
    render: function (host, p, ctx) {
      p = p || {};
      var st = OB.cards[ctx.id] || (OB.cards[ctx.id] = { last: null, seq: 0 });
      var args = argsOf(p), key = JSON.stringify(args);
      /* A change the card makes itself; a page or window change can redraw from the last read. */
      function set(patch) { st.nav = true; T.setParams(ctx.id, Object.assign({}, p, patch)); }
      function go(page, view) { set({ page: page === 'overview' ? '' : page, view: view || '' }); }
      function draw(d) {
        st.last = d;
        host.innerHTML = '';
        var page = pageOf(p);
        OB.tag = p.guild ? (guildTags(d)[p.guild] || p.guild) : null;
        var c = { d: d, segs: d.segments || [], page: page, view: viewOf(p), win: { 1: '1', 7: '7', 30: '30' }[p.win] || '30', st: st, set: set, go: go, host: host,
          redraw: function () { draw(st.last); } };
        var wrap = H.el('div', 'ob');
        wrap.setAttribute('data-page', page);
        var top = H.el('div', 'ob-top');
        var nav = H.navStrip(SECTIONS.map(function (s) { return { key: s[0], label: s[1] }; }), page, function (k) { go(k); });
        nav.classList.add('ob-sections');
        nav.querySelectorAll('.sui-screen-nav-item').forEach(function (a, i) { a.title = 'Key ' + (i + 1); });
        setTimeout(function () {
          var items = nav.querySelector('.sui-screen-nav-items'), on = nav.querySelector('.sui-mod-active');
          if (items && on && items.scrollWidth > items.clientWidth) items.scrollLeft = Math.max(0, on.offsetLeft - items.offsetLeft - 24);
        }, 0);
        top.appendChild(nav);
        wrap.appendChild(top);
        var scope = scopeBar(c, p), side = H.el('div', 'ob-scope-side');
        side.appendChild(statusLink(d, go));
        var word = actionBtn('Copy word', function () { copyText(wordOf(p), null); }, 'word');
        word.title = wordOf(p);
        side.appendChild(word);
        scope.appendChild(side);
        wrap.appendChild(scope);
        var main = H.el('div', 'ob-main');
        if (CRAWLED[page] && reading(d) && !hasData(d)) main.appendChild(H.stateBlock('loading', progress(d)));
        else main.appendChild(DRAW[page](c));
        wrap.appendChild(main);
        host.appendChild(wrap);
        // The crawl fills in between reads: look again sooner than the cadence while it runs.
        clearTimeout(st.soon);
        if (reading(d)) st.soon = setTimeout(function () { st.stale = true; T.refresh(ctx.id); }, 5000);
      }
      /* 1–8 open the sections, [ and ] step through a section's views. */
      if (!host._obKeys) {
        host._obKeys = true;
        host.addEventListener('keydown', function (e) {
          var tag = (e.target && e.target.tagName) || '';
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
          var cur = (OB.cards[ctx.id] || {}).params || p;
          var n = Number(e.key);
          if (n >= 1 && n <= SECTIONS.length) { e.preventDefault(); OB.cards[ctx.id].nav = true; T.setParams(ctx.id, Object.assign({}, cur, { page: n === 1 ? '' : SECTIONS[n - 1][0], view: '' })); return; }
          var list = VIEWS[pageOf(cur)];
          if (list && (e.key === '[' || e.key === ']')) {
            var i = list.map(function (v) { return v[0]; }).indexOf(viewOf(cur)) + (e.key === ']' ? 1 : -1);
            e.preventDefault();
            OB.cards[ctx.id].nav = true;
            T.setParams(ctx.id, Object.assign({}, cur, { view: list[(i + list.length) % list.length][0] }));
          }
        });
        if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
      }
      st.params = p;
      /* Moving between sections changes only the card's params: the last read
       * still answers, so a click redraws at once without asking again. */
      var nav = st.nav;
      st.nav = false;
      if (nav && st.last && st.key === key && !st.fresh && !st.stale) {
        draw(st.last);
        return Promise.resolve();
      }
      /* Only the newest read may draw: a slow read started before a filter
       * changed would otherwise land last and put the old figures back. */
      var seq = st.seq = (st.seq || 0) + 1;
      if (st.fresh) { args.fresh = true; st.fresh = false; }
      st.stale = false;
      if (st.last && !host.firstChild) draw(st.last);
      else if (!st.last) host.appendChild(H.stateBlock('loading', 'Reading every guild'));
      return invoke('terminal_onboarding', args).then(function (d) { if (seq === st.seq) { st.key = key; st.at = Date.now(); draw(d); } }).catch(function (e) {
        if (seq !== st.seq) return;
        host.innerHTML = '';
        host.appendChild(H.stateBlock('error', 'Telemetry unavailable: ' + e));
      });
    },
    doors: function (c) {
      return [{ icon: 'icon-refresh', title: 'Read again now', onClick: function () {
        var st = OB.cards[c.id] || (OB.cards[c.id] = { last: null, seq: 0 });
        st.fresh = true;
        T.setParams(c.id, Object.assign({}, c.params || {}));
      } }];
    },
  });

  T.onboarding = { phaseOf: phaseOf, phaseRows: phaseRows, heatBand: heatBand, issuesOf: issuesOf, runKind: runKind, stepLabel: stepLabel, pct: pct, share: share, topKeys: topKeys,
    headline: headline, tutorialOf: tutorialOf, trendChange: trendChange, trendPoints: trendPoints, ofShare: ofShare, uses: uses, sparkOf: sparkOf, bucketLabel: bucketLabel,
    fmtKind: fmtKind, argsOf: argsOf, funnelStages: funnelStages, parseArgs: parseArgs, wordOf: wordOf, journeyRows: journeyRows, signalsOf: signalsOf, deltaOf: deltaOf, increments: increments,
    pageOf: pageOf, viewOf: viewOf, runWeeks: runWeeks, deltaFor: deltaFor, shareOf: shareOf, reconcileRows: reconcileRows, tsvOf: tsvOf, orderSteps: orderSteps, weekStart: weekStart, durWords: durWords, sourceRows: sourceRows, worstRates: worstRates };
})();
